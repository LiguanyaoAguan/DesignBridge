#!/usr/bin/env node
/**
 * DesignBridge 设计交付 · 提交前校验（v0.4）
 *
 * 目的：在**提交设计文件之前**，用人机同源的校验器把不合格的交付挡在门外。
 * 复用：`src/model/contract-schema.mjs`（契约 v1）+ `src/model/preview-model.mjs`
 *      （内部再走 `preview-schema.mjs`，即 b-2/b-3 已在 main 的那一套）。
 *      **不新写校验规则、不放宽任何既有规则。**
 *
 * 用法：
 *   node scripts/validate-design.mjs                     # 校验 manifest 指向的契约
 *   node scripts/validate-design.mjs --design demo-x     # 额外断言 designId
 *   node scripts/validate-design.mjs --root <dir>        # 指定仓库根（默认本脚本的上两级）
 *   node scripts/validate-design.mjs --json              # 机器可读输出
 *
 * 退出码：
 *   0  通过（可以提交）
 *   1  校验失败（**禁止提交本次设计**）
 *   2  用法错误 / 文件读取失败
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseContractText, CONTRACT_SCHEMA_VERSION, CONTRACT_LIMITS } from '../src/model/contract-schema.mjs';
import { parsePreviewText } from '../src/model/preview-model.mjs';
import { PREVIEW_SCHEMA_VERSION, LIMITS, COMPONENT_TYPES } from '../src/model/preview-schema.mjs';
import { validateAssets, checkAssetReferences, ASSET_SCHEMA_VERSION, ASSET_LIMITS } from '../src/model/asset-schema.mjs';

/** manifest 里**实际存在**且与本次交付相关的字段 —— 只读这些，不发明字段。 */
export const MANIFEST_PATH = 'protocol/manifest.json';
export const DEFAULT_CONTRACT_PATH = 'protocol/design-contract.json';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..', '..');

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 只接受"仓库内相对路径"，拒绝绝对路径 / URL / 上跳 / 反斜杠 / NUL。 */
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\0') || value.includes('\\')) return false;
  if (isAbsolute(value) || value.startsWith('/')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  if (value.split('/').some((segment) => segment === '..')) return false;
  return true;
}

function error(code, path, message) {
  return { code, path, message };
}

function readTextFile(absPath, label) {
  if (!existsSync(absPath)) return { ok: false, error: error('missing-file', label, '文件不存在') };
  let stats;
  try {
    stats = statSync(absPath);
  } catch (cause) {
    return { ok: false, error: error('stat-failed', label, String(cause && cause.message ? cause.message : cause)) };
  }
  if (!stats.isFile()) return { ok: false, error: error('not-a-file', label, '不是普通文件') };
  try {
    return { ok: true, text: readFileSync(absPath, 'utf8') };
  } catch (cause) {
    return { ok: false, error: error('read-failed', label, String(cause && cause.message ? cause.message : cause)) };
  }
}

/** preview 里数一遍节点，仅用于汇报规模（不参与通过/失败判定）。 */
function countNodes(preview) {
  let count = 0;
  const walk = (node) => {
    if (!isObject(node)) return;
    count += 1;
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  if (isObject(preview) && Array.isArray(preview.pages)) preview.pages.forEach((page) => walk(page && page.root));
  return count;
}

/**
 * 跑一次完整的交付校验。
 *
 * @param {{ root?: string, designId?: string }} options
 * @returns {{ ok: boolean, exitCode: number, errors: Array, info: Array, summary: object }}
 */
export function validateDesign(options = {}) {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const errors = [];
  const info = [];
  const summary = {
    root,
    manifestPath: MANIFEST_PATH,
    contractPath: null,
    previewPath: null,
    contractSchemaVersion: CONTRACT_SCHEMA_VERSION,
    previewSchemaVersion: PREVIEW_SCHEMA_VERSION,
    designId: null,
    designVersion: null,
    platform: null,
    screenId: null,
    pages: null,
    nodes: null,
    componentTypes: COMPONENT_TYPES.length,
    limits: { ...LIMITS, contractMaxBytes: CONTRACT_LIMITS.maxBytes },
    manifestFieldsUsed: [],
  };

  // ── 1. manifest（只读实际存在且相关的字段）──────────────────────────────
  const manifestAbs = join(root, MANIFEST_PATH);
  const manifestRead = readTextFile(manifestAbs, MANIFEST_PATH);
  let manifest;
  if (!manifestRead.ok) {
    errors.push(manifestRead.error);
  } else {
    try {
      manifest = JSON.parse(manifestRead.text);
    } catch {
      errors.push(error('invalid-json', MANIFEST_PATH, 'JSON 语法无效'));
    }
    if (manifest !== undefined && !isObject(manifest)) {
      errors.push(error('type-mismatch', MANIFEST_PATH, 'manifest 必须是 JSON 对象'));
      manifest = undefined;
    }
  }

  // ── 2. 契约路径：优先 manifest.paths.designContract（若它真的存在）──────
  let contractRelative = DEFAULT_CONTRACT_PATH;
  if (isObject(manifest) && isObject(manifest.paths) && own(manifest.paths, 'designContract')) {
    const declared = manifest.paths.designContract;
    if (!isSafeRelativePath(declared)) {
      errors.push(error('invalid-value', `${MANIFEST_PATH}.paths.designContract`, '必须是仓库内相对路径'));
    } else {
      contractRelative = declared;
      summary.manifestFieldsUsed.push('paths.designContract');
    }
  } else {
    info.push(`manifest 未声明 paths.designContract，回落到默认 ${DEFAULT_CONTRACT_PATH}`);
  }
  summary.contractPath = contractRelative;

  // ── 3. 契约内容 ──────────────────────────────────────────────────────────
  let contract;
  const contractRead = readTextFile(join(root, contractRelative), contractRelative);
  if (!contractRead.ok) {
    errors.push(contractRead.error);
  } else {
    const parsed = parseContractText(contractRead.text);
    if (!parsed.ok) {
      for (const item of parsed.errors) errors.push({ ...item, path: `${contractRelative}#${item.path}` });
    } else {
      contract = parsed.value;
      summary.designId = contract.designId;
      summary.designVersion = contract.designVersion;
      summary.platform = contract.platform;
      summary.screenId = contract.screenId;
    }
  }

  // ── 4. manifest 中与本次交付相关的**既有**字段一致性 ─────────────────────
  if (isObject(manifest) && contract !== undefined) {
    // 4a. manifest.designVersion —— 该字段确实存在，必须与契约一致（版本漂移检测）
    if (own(manifest, 'designVersion')) {
      summary.manifestFieldsUsed.push('designVersion');
      if (manifest.designVersion !== contract.designVersion) {
        errors.push(error(
          'design-version-mismatch',
          `${MANIFEST_PATH}.designVersion`,
          `manifest.designVersion(${JSON.stringify(manifest.designVersion)}) 与契约 designVersion(${JSON.stringify(contract.designVersion)}) 不一致`,
        ));
      }
    } else {
      info.push('manifest 未声明 designVersion，跳过版本漂移检查');
    }
    // 4b. 只做"存在性"汇报，不发明字段、不因缺失而失败
    for (const key of ['schemaVersion', 'protocolVersion', 'transport', 'status', 'project']) {
      if (own(manifest, key)) info.push(`manifest.${key} = ${JSON.stringify(manifest[key])}`);
    }
    if (isObject(manifest.paths)) {
      for (const key of Object.keys(manifest.paths)) {
        if (key !== 'designContract') info.push(`manifest.paths.${key} = ${JSON.stringify(manifest.paths[key])}（本次不校验）`);
      }
    }
  }

  let previewValue = undefined;

  // ── 5. designId 断言（可选）──────────────────────────────────────────────
  if (options.designId !== undefined && contract !== undefined && options.designId !== contract.designId) {
    errors.push(error('design-id-mismatch', `--design`, `期望 designId=${options.designId}，契约里是 ${contract.designId}`));
  }
  const effectiveDesignId = options.designId ?? summary.designId;

  // ── 6. preview 路径（沿用约定，**不从 manifest 推断**）───────────────────
  if (effectiveDesignId === null || effectiveDesignId === undefined) {
    info.push('拿不到 designId，跳过 preview 校验');
  } else {
    const previewRelative = `designs/${effectiveDesignId}/preview.json`;
    summary.previewPath = previewRelative;
    const previewRead = readTextFile(join(root, previewRelative), previewRelative);
    if (!previewRead.ok) {
      errors.push(previewRead.error);
    } else {
      const previewParsed = parsePreviewText(previewRead.text, contract);
      if (!previewParsed.ok) {
        for (const item of previewParsed.errors) {
          errors.push({ ...item, path: `${previewRelative}#${item.path}` });
        }
        if (previewParsed.truncatedErrors) info.push('preview 错误已达上限，后面还有未列出的问题');
      } else {
        summary.pages = previewParsed.value.pages.length;
        summary.nodes = countNodes(previewParsed.value);
        previewValue = previewParsed.value;
      }
    }
  }

  // ── 7. 设计资源（assets.json）：路径安全 / 格式 / 体积 / 引用交叉检查 ──────
  // 资源是交付的一部分，必须在提交前就能被拒绝；渲染层的净化只是纵深防御。
  if (effectiveDesignId !== null && effectiveDesignId !== undefined) {
    const assetsRelative = `designs/${effectiveDesignId}/assets.json`;
    const assetsAbs = join(root, assetsRelative);
    const declared = summary.pages !== undefined && summary.nodes !== undefined;
    if (!existsSync(assetsAbs)) {
      // 没清单但 preview 引用了资源 → 必须报错（不允许静默空白）
      if (declared) {
        const refs = checkAssetReferences(previewValue, new Map());
        for (const item of refs) errors.push({ ...item, path: `${assetsRelative}#${item.path}` });
      }
    } else {
      const assetsRead = readTextFile(assetsAbs, assetsRelative);
      if (!assetsRead.ok) {
        errors.push(assetsRead.error);
      } else {
        let parsed;
        try { parsed = JSON.parse(assetsRead.text); } catch { parsed = undefined; }
        if (parsed === undefined) {
          errors.push(error('invalid-json', assetsRelative, 'JSON 语法无效'));
        } else {
          const result = validateAssets(parsed, { designId: effectiveDesignId });
          for (const item of result.errors) errors.push({ ...item, path: `${assetsRelative}#${item.path}` });
          // 引用交叉检查（preview → 清单）
          if (declared) {
            for (const item of checkAssetReferences(previewValue, result.assets)) {
              errors.push({ ...item, path: `designs/${effectiveDesignId}/preview.json#${item.path}` });
            }
          }
          // 逐个实测：文件必须在仓库里、可读、且不超过（收紧后的）上限
          let verifiedBytes = 0;
          for (const asset of result.assets.values()) {
            const abs = join(root, asset.path);
            if (!existsSync(abs)) {
              errors.push(error('missing-asset-file', `${assetsRelative}#${asset.path}`, '资源文件不存在（同步不完整）'));
              continue;
            }
            const size = statSync(abs).size;
            if (size > asset.maxBytes) {
              errors.push(error('asset-too-large', `${assetsRelative}#${asset.path}`, `实际 ${size} 字节超过上限 ${asset.maxBytes}（kind=${asset.kind}）`));
              continue;
            }
            verifiedBytes += size;
          }
          summary.assets = result.assets.size;
          summary.assetBytes = verifiedBytes;
          summary.assetSchemaVersion = ASSET_SCHEMA_VERSION;
          info.push(`资源：${result.assets.size} 个，实测 ${verifiedBytes} 字节（上限 ${ASSET_LIMITS.maxDeclaredBytes}）`);
        }
      }
    }
  }

  const ok = errors.length === 0;
  return { ok, exitCode: ok ? 0 : 1, errors, info, summary };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const options = { root: undefined, designId: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') { options.root = argv[i + 1]; i += 1; }
    else if (arg === '--design') { options.designId = argv[i + 1]; i += 1; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `未知参数：${arg}` };
  }
  if (options.root !== undefined && !existsSync(resolve(options.root))) {
    return { error: `--root 不存在：${options.root}` };
  }
  return { options };
}

function printHuman(result) {
  const { ok, errors, info, summary } = result;
  const line = (text = '') => process.stdout.write(`${text}\n`);

  line('DesignBridge 设计交付校验');
  line(`  仓库根      ${summary.root}`);
  line(`  契约        ${summary.contractPath}${summary.manifestFieldsUsed.includes('paths.designContract') ? '（取自 manifest.paths.designContract）' : '（默认路径）'}`);
  line(`  designId    ${summary.designId ?? '—'}`);
  line(`  designVersion ${summary.designVersion ?? '—'}`);
  line(`  预览        ${summary.previewPath ?? '—'}`);
  if (summary.pages !== null) line(`  页面/节点   ${summary.pages} 页 / ${summary.nodes} 节点`);
  line(`  协议版本     contract ${summary.contractSchemaVersion} · preview ${summary.previewSchemaVersion} · ${summary.componentTypes} 类组件`);
  line('');

  if (info.length) {
    line('说明：');
    for (const item of info) line(`  · ${item}`);
    line('');
  }

  if (ok) {
    line('✅ 校验通过 —— 可以提交本次设计。');
    return;
  }
  line(`❌ 校验失败（${errors.length} 个问题）—— **禁止提交本次设计**。`);
  line('');
  for (const item of errors) line(`  [${item.code}] ${item.path} — ${item.message}`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`用法错误：${parsed.error}\n`);
    process.stderr.write('用法：node scripts/validate-design.mjs [--root <dir>] [--design <designId>] [--json]\n');
    process.exit(2);
  }
  const { options } = parsed;
  if (options.help) {
    process.stdout.write('用法：node scripts/validate-design.mjs [--root <dir>] [--design <designId>] [--json]\n');
    process.exit(0);
  }

  let result;
  try {
    result = validateDesign(options);
  } catch (cause) {
    process.stderr.write(`内部错误：${cause && cause.message ? cause.message : cause}\n`);
    process.exit(2);
  }

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printHuman(result);

  // 文件级读取失败也算校验失败（退出 1），只有用法/内部错误才是 2。
  process.exit(result.exitCode);
}

// 仅在被直接执行时跑 CLI（路径含空格与中文，必须用 pathToFileURL 比较）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
