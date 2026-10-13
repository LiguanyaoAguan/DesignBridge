/**
 * 工作区边界与安全文件访问。
 *
 * 本模块是**整个服务端唯一允许碰文件系统的地方**。所有工具都必须经此解析路径，
 * 目的是把「路径穿越」和「符号链接逃逸」这两类问题堵死在单点。
 *
 * 设计要点：
 * 1. 拒绝绝对路径、拒绝含 NUL 的路径；
 * 2. 先用 path.resolve 做一次**词法**包含性检查（挡掉 `../`）；
 * 3. 再对「最深的已存在祖先」做 realpath 检查（挡掉符号链接指向工作区之外）；
 * 4. 目标若已存在，对目标自身再做一次 realpath 检查。
 *
 * 只做 1+2 是不够的：`workspace/link/file.json` 里 link 是指向 /etc 的符号链接时，
 * 词法上完全在工作区内，实际却读到了外面。所以必须走 3/4。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type WorkspaceErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_DIRECTORY"
  | "ABSOLUTE_PATH_REJECTED"
  | "INVALID_PATH"
  | "PATH_ESCAPE"
  | "SYMLINK_ESCAPE"
  | "NOT_FOUND"
  | "PARSE_FAILED"
  | "SCHEMA_INVALID"
  | "WRITE_TARGET_FORBIDDEN";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly detail: string | undefined;

  constructor(code: WorkspaceErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.detail = detail;
  }
}

/** 已打开的工作区。root 一定是 realpath 结果。 */
export interface Workspace {
  readonly root: string;
}

export function openWorkspace(root_input: string): Workspace {
  const abs = resolve(root_input);
  if (!existsSync(abs)) {
    throw new WorkspaceError("WORKSPACE_NOT_FOUND", `工作区不存在：${root_input}`);
  }
  if (!statSync(abs).isDirectory()) {
    throw new WorkspaceError("WORKSPACE_NOT_DIRECTORY", `工作区不是目录：${root_input}`);
  }
  return { root: realpathSync(abs) };
}

/** candidate 是否位于 root 之内（词法比较，两者都应是绝对路径）。 */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** 自 candidate 向上找到第一个已存在的路径。 */
function deepest_existing(candidate: string): string {
  let current = candidate;
  // 循环必然终止：根目录一定存在。
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** 校验一个相对路径并返回其绝对路径。读、写共用。 */
function resolve_inside(workspace: Workspace, rel_path: string): string {
  if (typeof rel_path !== "string" || rel_path.length === 0) {
    throw new WorkspaceError("INVALID_PATH", "路径必须是非空字符串");
  }
  if (rel_path.includes("\0")) {
    throw new WorkspaceError("INVALID_PATH", "路径含 NUL 字符");
  }
  if (isAbsolute(rel_path) || /^[A-Za-z]:/.test(rel_path)) {
    throw new WorkspaceError("ABSOLUTE_PATH_REJECTED", `拒绝绝对路径：${rel_path}`);
  }

  const candidate = resolve(workspace.root, rel_path);
  if (!isInside(workspace.root, candidate)) {
    throw new WorkspaceError("PATH_ESCAPE", `路径越出工作区：${rel_path}`);
  }

  // 符号链接检查：最深已存在祖先。
  const anchor = deepest_existing(candidate);
  const real_anchor = realpathSync(anchor);
  if (!isInside(workspace.root, real_anchor)) {
    throw new WorkspaceError("SYMLINK_ESCAPE", `路径经符号链接逃出工作区：${rel_path}`, `锚点 ${anchor} -> ${real_anchor}`);
  }

  // 目标自身存在时再查一次。
  if (existsSync(candidate)) {
    const real_target = realpathSync(candidate);
    if (!isInside(workspace.root, real_target)) {
      throw new WorkspaceError("SYMLINK_ESCAPE", `目标经符号链接逃出工作区：${rel_path}`, `${candidate} -> ${real_target}`);
    }
    return real_target;
  }
  return candidate;
}

export function resolve_readable(workspace: Workspace, rel_path: string): string {
  return resolve_inside(workspace, rel_path);
}

export function read_text(workspace: Workspace, rel_path: string): string {
  const abs = resolve_inside(workspace, rel_path);
  if (!existsSync(abs)) {
    throw new WorkspaceError("NOT_FOUND", `文件不存在：${rel_path}`);
  }
  return readFileSync(abs, "utf8");
}

export function read_json(workspace: Workspace, rel_path: string): unknown {
  const text = read_text(workspace, rel_path);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkspaceError("PARSE_FAILED", `JSON 解析失败：${rel_path}`, message);
  }
}

export interface AtomicWriteOptions {
  /** false（默认）时目标已存在会抛错，避免误覆盖。 */
  overwrite?: boolean;
}

/**
 * 原子写入：同目录临时文件 + rename。
 *
 * 两种情况分别处理，因为**它们要保证的性质不同**：
 *
 * - `overwrite: true` —— 直接用 `rename` 原子替换。rename 在同一文件系统内是原子的，
 *   读方要么看到旧内容、要么看到新内容，**永远看不到半写入**。
 *
 * - `overwrite: false` —— 必须保证"绝不覆盖已存在文件"，这是一个 **TOCTOU** 问题：
 *   先 `existsSync` 再 `rename` 之间存在窗口，并发下两个写者会互相覆盖。
 *
 *   经典解法是 `link(2)`：链接在目标已存在时返回 EEXIST，且是原子的。
 *   但**实测 Android 禁止 `link()`**（`/storage` 与 `/data` 下均返回 EACCES），
 *   所以改用 `open(O_CREAT|O_EXCL)` 做原子占位——它同样是"已存在即失败"的原子原语。
 *   占位成功后再用 `rename` 换成完整内容，因此**成功返回时内容一定是完整的**。
 *
 *   残留窗口（已在 README 中记明）：占位到 rename 之间，目标文件短暂为空文件；
 *   若进程在此刻被强杀，会留下一个空文件。这是平台禁用 link() 后的取舍，
 *   选择它是因为"成功则内容完整"比"避免空壳"更重要，且任何失败路径都会清理占位。
 */
export function atomic_write_text(
  workspace: Workspace,
  rel_path: string,
  content: string,
  options: AtomicWriteOptions = {},
): string {
  const overwrite = options.overwrite ?? false;
  const abs = resolve_inside(workspace, rel_path);

  const directory = dirname(abs);
  // 父目录也需要在边界内（resolve_inside 已保证，此处用于创建）。
  if (!isInside(workspace.root, directory)) {
    throw new WorkspaceError("PATH_ESCAPE", `写入目录越出工作区：${rel_path}`);
  }
  mkdirSync(directory, { recursive: true });

  const temporary = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o644 });
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }

  if (overwrite) {
    try {
      renameSync(temporary, abs);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return abs;
  }

  // ---- 不覆盖：O_CREAT|O_EXCL 原子占位 ----
  let claimed_fd: number;
  try {
    claimed_fd = openSync(abs, "wx", 0o644);
  } catch (error) {
    rmSync(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceError("WRITE_TARGET_FORBIDDEN", `目标已存在且不允许覆盖：${rel_path}`);
    }
    throw error;
  }
  closeSync(claimed_fd);

  try {
    // 占位已成功，说明这个名字是我们抢到的；换成完整内容。
    renameSync(temporary, abs);
  } catch (error) {
    // 任何失败都清掉占位空壳与临时文件，绝不留下"看起来像结果"的空文件。
    rmSync(abs, { force: true });
    rmSync(temporary, { force: true });
    throw error;
  }
  return abs;
}

/** 把工作区绝对路径转成相对路径，用于对外只暴露相对路径。 */
export function to_relative(workspace: Workspace, absolute: string): string {
  return relative(workspace.root, absolute).split(sep).join("/");
}

/**
 * 定位 DesignBridge 工作区根目录。
 * 优先取环境变量；否则自 cwd 向上寻找含 protocol/manifest.json 的目录。
 */
export function locate_workspace_root(start: string, explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;

  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "protocol", "manifest.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // 找不到就退回 cwd，交由 openWorkspace 报明确错误。
  return resolve(start);
}
