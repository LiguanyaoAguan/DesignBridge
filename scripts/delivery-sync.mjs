#!/usr/bin/env node
/**
 * DesignBridge 交付同步（P0 · 手动一次触发）
 *
 * 目的：把「ChatGPT 产出 → GitHub 承载 → Harness 发现并拉取 → 自动校验」这条链路
 * 中**前四段**自动化，取代"人工复制 JSON + 人工跑校验 + 人工转述错误"。
 *
 * 设计约束（与需求一一对应）：
 *   1. 交付内容先落到**仓库外的隔离暂存区**，绝不覆盖工作区；
 *   2. **复用** `dsh-plugin/scripts/validate-design.mjs`，本脚本不实现任何 Schema 规则；
 *   3. 校验失败**不得替换**上一个有效交付；
 *   4. 交付索引是**运行时状态**，放在仓库之外，同步过程不污染 Git 工作区；
 *   5. 记录来源 commit / 设计版本 / 每文件内容哈希 / 校验结果 / 路径化错误；
 *   6. 只支持**手动一次**触发，不含后台轮询；
 *   7. 不 checkout、不 reset、不 merge；`git fetch` 仅更新远程跟踪引用。
 *
 * 磁盘布局（全部在 <runtimeDir> 下，且 <runtimeDir> 必须在仓库之外）：
 *
 *   .designbridge-runtime/
 *   ├── staging/<designId>/            最近一次拉取的交付（工作副本，可重建）
 *   ├── valid/<designId>/<deliveryHash>/   **不可变**的有效交付快照（内容寻址）
 *   └── state/delivery-index.json      交付索引（lastAttempt / lastValid 分离）
 *
 * 退出码：0 校验通过 ／ 1 校验失败 ／ 2 用法或环境错误
 *
 * 用法：
 *   node scripts/delivery-sync.mjs [--ref <ref>] [--commit <sha>] [--repo <dir>]
 *                                 [--runtime <dir>] [--no-fetch] [--json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────── 常量

/** 本脚本所在仓库（= 工具仓库；校验器固定从这里取）。 */
const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR_REL = 'dsh-plugin/scripts/validate-design.mjs';
const MANIFEST_REL = 'protocol/manifest.json';
const INDEX_VERSION = '1.0.0';
const DEFAULT_REF = 'origin/main';
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

class SyncError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, message, detail) => {
  throw new SyncError(code, message, detail);
};

// ─────────────────────────────────────────────────────────────── 路径工具

const isInside = (parent, child) => child === parent || child.startsWith(parent + sep);

/**
 * 解析"尽可能深"的真实路径：对不存在的尾部做词法拼接。
 * 用于在目录尚未创建时也能做真实的包含性判断（符号链接会被 realpath 展开）。
 */
function realpathDeep(target) {
  let cur = resolve(target);
  const tail = [];
  for (;;) {
    if (existsSync(cur)) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  const base = existsSync(cur) ? realpathSync(cur) : cur;
  return tail.length ? join(base, ...tail) : base;
}

/**
 * 校验来自 manifest / 契约的**仓库内相对路径**。
 * 拒绝：空值、NUL、反斜杠、绝对路径、Windows 盘符、URL scheme、
 *       空段、`.` 段、`..` 段。
 */
function assertSafeRelPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('PATH_INVALID', `${label} 必须是非空字符串`, { label, value });
  }
  if (value.includes('\0')) fail('PATH_INVALID', `${label} 含 NUL`, { label });
  if (value.includes('\\')) fail('PATH_INVALID', `${label} 含反斜杠`, { label, value });
  if (isAbsolute(value) || value.startsWith('/')) {
    fail('PATH_INVALID', `${label} 不得是绝对路径`, { label, value });
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    fail('PATH_INVALID', `${label} 不得含盘符或 URL scheme`, { label, value });
  }
  const segments = value.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    fail('PATH_INVALID', `${label} 含空段 / "." / ".."`, { label, value });
  }
  return value;
}

/** 把已校验的相对路径安全地拼到 base 之下，并再次确认包含性。 */
function safeJoinInside(base, rel, label) {
  assertSafeRelPath(rel, label);
  const root = resolve(base);
  const abs = resolve(root, rel);
  if (!isInside(root, abs)) {
    fail('PATH_ESCAPE', `${label} 解析后逃出根目录`, { label, rel, abs, root });
  }
  return abs;
}

/** 拒绝符号链接逃逸：目标路径上任何已存在的祖先（及目标自身）都不得是符号链接。 */
function assertNoSymlinkAncestors(base, rel, label) {
  const root = resolve(base);
  const segments = rel.split('/');
  let cur = root;
  for (const seg of segments) {
    cur = join(cur, seg);
    if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) {
      fail('SYMLINK_ESCAPE', `${label} 的路径段 "${seg}" 是符号链接`, { label, rel, path: cur });
    }
  }
}

/** designId 会直接成为目录名，必须自证安全。 */
function assertSafeDesignId(designId) {
  if (typeof designId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(designId)) {
    fail('DESIGN_ID_INVALID', 'designId 不能安全用作目录名', { designId });
  }
  return designId;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ─────────────────────────────────────────────────────────────── git 工具

function gitRaw(args, { repoDir, allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-C', repoDir, ...args], {
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    if (allowFail) return null;
    const stderr = cause && cause.stderr ? String(cause.stderr).trim() : String(cause && cause.message);
    fail('GIT_FAILED', `git ${args.join(' ')} 失败`, stderr.slice(0, 500));
  }
}

const gitText = (args, opts) => {
  const out = gitRaw(args, opts);
  return out === null ? null : out.toString('utf8');
};

const gitTrim = (args, opts) => {
  const text = gitText(args, opts);
  return text === null ? null : text.trim();
};

/** 该提交里是否存在某路径。 */
const existsAtCommit = (repoDir, commit, rel) =>
  gitRaw(['cat-file', '-e', `${commit}:${rel}`], { repoDir, allowFail: true }) !== null;

/** 读取该提交某路径的**精确字节**（不检出、不碰工作区）。 */
function readAtCommit(repoDir, commit, rel, label) {
  const buf = gitRaw(['show', `${commit}:${rel}`], { repoDir, allowFail: true });
  if (buf === null) fail('DELIVERY_FILE_MISSING', `${label} 在提交 ${commit.slice(0, 12)} 中不存在`, { rel });
  return buf;
}

// ─────────────────────────────────────────────────────────────── 参数

function parseArgs(argv) {
  const options = {
    ref: DEFAULT_REF,
    refExplicit: false,
    commit: undefined,
    repo: undefined,
    runtime: undefined,
    fetch: true,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ref') {
      options.ref = argv[++i];
      options.refExplicit = true;
    } else if (arg === '--commit') options.commit = argv[++i];
    else if (arg === '--repo') options.repo = argv[++i];
    else if (arg === '--runtime') options.runtime = argv[++i];
    else if (arg === '--no-fetch') options.fetch = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail('USAGE', `未知参数：${arg}`);
  }
  if (!options.help) {
    for (const key of ['ref', 'commit', 'repo', 'runtime']) {
      if (options[key] !== undefined && (typeof options[key] !== 'string' || options[key].length === 0)) {
        fail('USAGE', `--${key} 需要非空取值`);
      }
    }
  }
  return options;
}

const USAGE = `用法：node scripts/delivery-sync.mjs [选项]

  --ref <ref>        要同步的引用（默认 ${DEFAULT_REF}）
  --commit <sha>     指定具体提交（优先于 --ref；指定时不再 fetch）
  --repo <dir>       读取交付的 git 仓库（默认本脚本所在仓库；用于隔离测试）
  --runtime <dir>    运行时目录（默认 <repo>/../.designbridge-runtime，必须在仓库之外）
  --no-fetch         跳过 git fetch（离线或使用本地已有对象）
  --json             输出机器可读结果
  -h, --help         显示本帮助

退出码：0 校验通过 ／ 1 校验失败 ／ 2 用法或环境错误`;

// ─────────────────────────────────────────────────────────────── 目录发布

/**
 * 清理上一次异常中断留下的临时目录。
 *
 * `alsoOld` 决定是否连 `.old-*` 一起清：
 *   · 仅对**可替换**目录（staging）为 true；
 *   · **不可变目录（valid）必须为 false** —— 若上一次崩溃恰好停在"旧目标已挪走、
 *     新目标未就位"，`.old-*` 就是该版本的**唯一副本**，清掉即永久丢数据。
 */
function cleanStaleDirs(root, { alsoOld }) {
  if (!existsSync(root)) return [];
  const removed = [];
  for (const name of readdirSync(root)) {
    const isTmp = name.startsWith('.tmp-');
    const isOld = name.startsWith('.old-');
    if (isTmp || (alsoOld && isOld)) {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

/** 在 parentDir 下建一个唯一 tmp 目录并交给 buildTmp 填充。 */
function buildIntoTmp(parentDir, targetName, buildTmp) {
  const rand = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = join(parentDir, `.tmp-${targetName}-${rand}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  buildTmp(tmp);
  return tmp;
}

/** **可替换**目录的原子发布（staging 用）：已有目标先挪走 → rename 覆盖 → 删旧。 */
function publishDirReplace(parentDir, targetName, buildTmp) {
  mkdirSync(parentDir, { recursive: true });
  cleanStaleDirs(parentDir, { alsoOld: true });

  const rand = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const target = join(parentDir, targetName);
  const tmp = buildIntoTmp(parentDir, targetName, buildTmp);

  let trashed = null;
  if (existsSync(target)) {
    trashed = join(parentDir, `.old-${targetName}-${rand}`);
    renameSync(target, trashed);
  }
  try {
    renameSync(tmp, target);
  } catch (cause) {
    // 发布失败：尽力回滚到旧目标，避免"两边都没有"
    if (trashed !== null && !existsSync(target)) renameSync(trashed, target);
    rmSync(tmp, { recursive: true, force: true });
    fail('PUBLISH_FAILED', `发布 ${targetName} 失败`, String(cause && cause.message));
  }
  if (trashed !== null) rmSync(trashed, { recursive: true, force: true });
  return { path: target, created: true };
}

/**
 * **不可变**目录的原子发布（valid 用）。不变量：内容寻址的版本目录一旦就位，
 * **再也不被移动、重写或删除**。因此：
 *   · 只清 `.tmp-*`，**不清 `.old-*`**（可能是唯一副本）；
 *   · 目标已存在 → 丢弃刚建的 tmp，直接返回既有目录（连元数据都不碰）；
 *   · rename 因并发输给另一个写者 → 视为成功，返回对方已就位的目录。
 */
function publishDirImmutable(parentDir, targetName, buildTmp) {
  mkdirSync(parentDir, { recursive: true });
  cleanStaleDirs(parentDir, { alsoOld: false });

  const target = join(parentDir, targetName);
  if (existsSync(target)) return { path: target, created: false };

  const tmp = buildIntoTmp(parentDir, targetName, buildTmp);
  try {
    renameSync(tmp, target);
  } catch (cause) {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(target)) return { path: target, created: false }; // 并发写者先就位
    fail('PUBLISH_FAILED', `发布不可变版本 ${targetName} 失败`, String(cause && cause.message));
  }
  return { path: target, created: true };
}

/** 只读校验既有不可变版本是否仍与预期逐字节一致（**不修复**，只报告）。 */
function verifyImmutableDir(dir, files) {
  const problems = [];
  for (const file of files) {
    const abs = join(dir, file.path);
    if (!existsSync(abs)) {
      problems.push(`${file.path}: 缺失`);
      continue;
    }
    const buf = readFileSync(abs);
    if (buf.byteLength !== file.bytes || sha256(buf) !== file.sha256) problems.push(`${file.path}: 内容不符`);
  }
  return problems;
}

/** 原子写文本文件（同目录 tmp + rename）。 */
function writeFileAtomic(absPath, text) {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, absPath);
}

// ─────────────────────────────────────────────────────────────── 索引

function readIndex(indexPath, runtimeDir) {
  if (!existsSync(indexPath)) {
    return { index: { indexVersion: INDEX_VERSION, updatedAt: null, designs: {} }, recovered: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    if (parsed.designs === null || typeof parsed.designs !== 'object' || Array.isArray(parsed.designs)) {
      parsed.designs = {};
    }
    return { index: parsed, recovered: null };
  } catch (cause) {
    // 索引损坏：备份后重建，绝不静默丢弃
    const backup = join(runtimeDir, 'state', `delivery-index.corrupt-${Date.now()}.json`);
    mkdirSync(dirname(backup), { recursive: true });
    try {
      renameSync(indexPath, backup);
    } catch {
      /* 备份失败不阻断重建 */
    }
    return {
      index: { indexVersion: INDEX_VERSION, updatedAt: null, designs: {} },
      recovered: { backup, reason: String(cause && cause.message) },
    };
  }
}

// ─────────────────────────────────────────────────────────────── 校验

function runValidator(stagingDir, designId) {
  const validator = join(TOOL_ROOT, VALIDATOR_REL);
  if (!existsSync(validator)) fail('VALIDATOR_MISSING', `校验器不存在：${validator}`);

  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync('node', [validator, '--root', stagingDir, '--design', designId, '--json'], {
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    status = typeof cause.status === 'number' ? cause.status : 2;
    stdout = cause.stdout ? String(cause.stdout) : '';
  }

  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail('VALIDATOR_OUTPUT_INVALID', '校验器未返回可解析的 JSON', { status, head: stdout.slice(0, 300) });
  }
  if (status === 2 || parsed.exitCode === 2) {
    fail('VALIDATOR_USAGE', '校验器以用法/内部错误退出', { status, errors: parsed.errors });
  }
  return { ok: parsed.ok === true, exitCode: parsed.exitCode, errors: parsed.errors ?? [], summary: parsed.summary ?? null };
}

// ─────────────────────────────────────────────────────────────── 主流程

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  // ── 仓库与运行时目录
  const repoDir = resolve(options.repo ?? TOOL_ROOT);
  if (!existsSync(join(repoDir, '.git'))) {
    fail('REPO_INVALID', `--repo 不是 git 仓库：${repoDir}`);
  }
  const runtimeDirRaw = options.runtime ?? join(repoDir, '..', '.designbridge-runtime');
  const runtimeDir = resolve(runtimeDirRaw);

  const realRepo = realpathDeep(repoDir);
  const realRuntime = realpathDeep(runtimeDir);
  if (isInside(realRepo, realRuntime) || isInside(realRuntime, realRepo)) {
    fail('RUNTIME_INSIDE_REPO', '运行时目录的真实路径必须位于仓库之外', {
      repoDir: realRepo,
      runtimeDir: realRuntime,
    });
  }

  // ── 定位提交（fetch 只更新远程跟踪引用，绝不 checkout/reset/merge）
  let fetched = false;
  const commitArg = options.commit;
  if (options.fetch && commitArg === undefined) {
    const remote = options.ref.split('/')[0];
    const remotes = (gitTrim(['remote'], { repoDir }) || '').split('\n').filter(Boolean);
    if (remotes.includes(remote)) {
      gitRaw(['fetch', '--quiet', remote], { repoDir });
      fetched = true;
    }
  }
  const commit = commitArg ?? gitTrim(['rev-parse', '--verify', `${options.ref}^{commit}`], { repoDir });
  if (!commit) fail('COMMIT_UNRESOLVED', `无法解析提交：${commitArg ?? options.ref}`);
  const commitSubject = gitTrim(['log', '-1', '--format=%s', commit], { repoDir }) ?? '';

  // ── 发现交付（路径一律来自交付自身的 manifest，且逐条做安全检查）
  const manifestBuf = readAtCommit(repoDir, commit, MANIFEST_REL, 'protocol/manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'));
  } catch {
    fail('MANIFEST_INVALID', `提交 ${commit.slice(0, 12)} 的 ${MANIFEST_REL} 不是合法 JSON`);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('MANIFEST_INVALID', 'manifest 必须是 JSON 对象');
  }
  const contractRel = manifest?.paths?.designContract;
  if (typeof contractRel !== 'string') {
    fail('MANIFEST_INVALID', 'manifest 未声明 paths.designContract');
  }
  assertSafeRelPath(contractRel, 'manifest.paths.designContract');

  const contractBuf = readAtCommit(repoDir, commit, contractRel, contractRel);
  let contract;
  try {
    contract = JSON.parse(contractBuf.toString('utf8'));
  } catch {
    fail('CONTRACT_INVALID', `${contractRel} 不是合法 JSON`);
  }
  const designId = assertSafeDesignId(contract?.designId);
  const designVersion = typeof contract?.designVersion === 'string' ? contract.designVersion : null;

  const previewRel = `designs/${designId}/preview.json`;
  const previewBuf = readAtCommit(repoDir, commit, previewRel, previewRel);

  const deliveryFiles = [
    { path: MANIFEST_REL, buf: manifestBuf },
    { path: contractRel, buf: contractBuf },
    { path: previewRel, buf: previewBuf },
  ].map((f) => ({ path: f.path, bytes: f.buf.byteLength, sha256: sha256(f.buf), buf: f.buf }));

  const deliveryHash = sha256(
    deliveryFiles
      .map((f) => `${f.path}:${f.sha256}`)
      .sort()
      .join('\n'),
  );

  // ── 隔离暂存（仓库外；原子发布；异常中断残留会被清理）
  const stagingRoot = join(runtimeDir, 'staging');
  const stagingPath = publishDirReplace(stagingRoot, designId, (tmp) => {
    for (const file of deliveryFiles) {
      assertNoSymlinkAncestors(tmp, file.path, file.path);
      const dest = safeJoinInside(tmp, file.path, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.buf);
    }
  }).path;

  // ── 复用校验器（本脚本不含任何 Schema 规则）
  const validation = runValidator(stagingPath, designId);

  const nowIso = new Date().toISOString();
  const entryBase = {
    designId,
    designVersion,
    source: {
      repo: repoDir,
      ref: commitArg === undefined ? options.ref : null,
      commit,
      commitSubject,
      fetched,
    },
    files: deliveryFiles.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash })),
    deliveryHash,
    stagingPath,
    validatedAt: nowIso,
    ok: validation.ok,
    errorCount: validation.errors.length,
    errors: validation.errors,
    summary: validation.summary,
  };

  // ── 有效交付：内容寻址的**不可变**版本目录（仅在校验通过时创建）
  let validPath = null;
  let validCreated = false;
  let validIntegrity = null;
  const integrityProblems = [];
  if (validation.ok) {
    const validRoot = join(runtimeDir, 'valid', designId);
    // 内容寻址 + **不可变**发布：同哈希版本已存在时绝不改动（见 publishDirImmutable）
    const published = publishDirImmutable(validRoot, deliveryHash, (tmp) => {
      for (const file of deliveryFiles) {
        assertNoSymlinkAncestors(tmp, file.path, file.path);
        const dest = safeJoinInside(tmp, file.path, file.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, file.buf);
      }
      writeFileSync(
        join(tmp, 'delivery.json'),
        `${JSON.stringify(
          {
            designId,
            designVersion,
            deliveryHash,
            source: entryBase.source,
            files: entryBase.files,
            validatedAt: nowIso,
            summary: validation.summary,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    });
    validPath = published.path;
    validCreated = published.created;
    // 复用既有版本时做**只读**完整性校验；发现损坏只报告、不修复（保持不可变）
    integrityProblems.push(...verifyImmutableDir(validPath, deliveryFiles));
    validIntegrity = integrityProblems.length === 0 ? 'ok' : 'mismatch';
  }
  const entry = { ...entryBase, validPath, validCreated, validIntegrity, integrityProblems };

  // ── 索引：lastValid 与 lastAttempt 分离；失败**不触碰** lastValid
  const stateDir = join(runtimeDir, 'state');
  const indexPath = join(stateDir, 'delivery-index.json');
  mkdirSync(stateDir, { recursive: true });
  const { index, recovered } = readIndex(indexPath, runtimeDir);

  const previous = index.designs[designId] ?? { lastValid: null, lastAttempt: null };
  const nextEntry = {
    lastAttempt: entry,
    lastValid: validation.ok ? entry : (previous.lastValid ?? null),
  };
  index.designs[designId] = nextEntry;
  index.indexVersion = INDEX_VERSION;
  index.updatedAt = nowIso;
  writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  // ── 输出
  const result = {
    ok: validation.ok,
    exitCode: validation.ok ? 0 : 1,
    designId,
    designVersion,
    commit,
    commitSubject,
    fetched,
    runtimeDir,
    stagingPath,
    validPath,
    validCreated,
    validIntegrity,
    integrityProblems,
    deliveryHash,
    files: entry.files,
    errors: validation.errors,
    summary: validation.summary,
    lastValidPreserved: !validation.ok && previous.lastValid !== null,
    indexPath,
    indexRecovered: recovered,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const line = (s = '') => process.stdout.write(`${s}\n`);
    line('DesignBridge 交付同步');
    line(`  仓库        ${repoDir}`);
    line(`  运行时目录  ${runtimeDir}（仓库外 ✅）`);
    line(`  来源        ${commitArg === undefined ? options.ref : '(pin)'} @ ${commit.slice(0, 12)}${fetched ? '（已 fetch）' : '（未 fetch）'}`);
    line(`  提交标题    ${commitSubject}`);
    line(`  设计        ${designId} · ${designVersion ?? '—'}`);
    line(`  交付哈希    ${deliveryHash.slice(0, 16)}…`);
    line(`  暂存        ${stagingPath}`);
    line(`  有效快照    ${validPath ?? '（无：本次未通过校验）'}`);
    if (validPath !== null) {
      line(`              ${validCreated ? '本次创建' : '复用既有（不可变，未改动）'}｜完整性 ${validIntegrity}`);
      if (validIntegrity === 'mismatch') {
        line('  ⚠️ 既有不可变版本内容与预期不符（只报告，不自动修复）：');
        for (const p of integrityProblems) line(`       ${p}`);
      }
    }
    line('');
    line('  文件：');
    for (const f of entry.files) line(`    ${f.sha256.slice(0, 12)}  ${String(f.bytes).padStart(7)} B  ${f.path}`);
    line('');
    if (validation.ok) {
      line('✅ 校验通过 —— 可提交本次设计。');
      if (validation.summary) {
        line(`   ${validation.summary.pages} 页 / ${validation.summary.nodes} 节点 / ${validation.summary.componentTypes} 类组件`);
      }
    } else {
      line(`❌ 校验失败（${validation.errors.length} 个问题）—— 禁止提交本次设计。`);
      for (const e of validation.errors) line(`  [${e.code}] ${e.path} — ${e.message}`);
      if (result.lastValidPreserved) line('   （上一个有效交付未被替换）');
    }
    if (recovered) line(`\n  ⚠️ 索引损坏已备份重建：${recovered.backup}`);
    line('');
    line(`  索引        ${indexPath}`);
  }

  return result.exitCode;
}

try {
  process.exitCode = main();
} catch (cause) {
  const isSync = cause instanceof SyncError;
  const payload = {
    ok: false,
    exitCode: 2,
    code: isSync ? cause.code : 'INTERNAL',
    message: String(cause && cause.message ? cause.message : cause),
    detail: isSync ? cause.detail : undefined,
  };
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stderr.write(`❌ ${payload.code}: ${payload.message}\n`);
    if (payload.detail !== undefined) process.stderr.write(`   详情：${JSON.stringify(payload.detail)}\n`);
  }
  process.exitCode = 2;
}
