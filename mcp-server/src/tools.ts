/**
 * 四个 MCP 工具的实现。
 *
 * 分层：index.ts 只做协议注册与传输，真正的业务在这里，且**所有文件访问都经 workspace.ts**，
 * 因此这一层拿不到任何"直接读写任意路径"的能力。
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WorkspaceError, atomic_write_text, read_json, resolve_readable, to_relative, type Workspace } from "./workspace.js";
import {
  DesignContractSchema,
  ManifestSchema,
  SubmitResultInputSchema,
  TaskSchema,
  format_zod_error,
  type CheckResult,
  type DesignContract,
  type Manifest,
  type SubmitResultInput,
  type Task,
} from "./validation.js";

export type ToolErrorCode =
  | "MANIFEST_MISSING"
  | "MANIFEST_INVALID"
  | "DESIGN_MISSING"
  | "DESIGN_INVALID"
  | "TASK_MISSING"
  | "TASK_INVALID"
  | "VERSION_MISMATCH"
  | "INPUT_INVALID"
  | "PATH_REJECTED"
  | "WRITE_REJECTED";

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly detail: string | undefined;

  constructor(code: ToolErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.detail = detail;
  }
}

export interface ToolContext {
  readonly workspace: Workspace;
  /** 隔离输出目录，相对工作区根。默认 .designbridge-outbox。 */
  readonly outbox_dir: string;
}

const MANIFEST_PATH = "protocol/manifest.json";

/** 把底层错误统一翻译成 ToolError，便于工具层给出稳定错误码。 */
function as_tool_error(error: unknown, fallback: ToolErrorCode): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof WorkspaceError) {
    const code: ToolErrorCode =
      error.code === "NOT_FOUND" ? fallback : error.code === "PARSE_FAILED" ? fallback : "PATH_REJECTED";
    return new ToolError(code, error.message, error.detail);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ToolError(fallback, message);
}

// ---------------------------------------------------------------- get_manifest

export interface ManifestPayload {
  schemaVersion: string;
  project: string;
  protocolVersion: string;
  designVersion: string;
  transport: string;
  status: string;
  paths: Manifest["paths"];
  resolved_paths: { designContract: boolean; task: boolean; result: boolean; acceptance: boolean };
  manifest_file: string;
}

export function get_manifest(ctx: ToolContext): ManifestPayload {
  let raw: unknown;
  try {
    raw = read_json(ctx.workspace, MANIFEST_PATH);
  } catch (error) {
    const translated = as_tool_error(error, "MANIFEST_MISSING");
    if (translated.code === "MANIFEST_MISSING") {
      translated.message = `无法读取 ${MANIFEST_PATH}：${translated.message}`;
    }
    throw translated;
  }

  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError("MANIFEST_INVALID", `${MANIFEST_PATH} 结构不符合协议`, format_zod_error(parsed.error));
  }
  const manifest = parsed.data;

  // 报告声明路径是否真实存在——让调用方一眼看出协议是否自洽。
  const resolved_paths = {
    designContract: existsSync(safe_resolve(ctx, manifest.paths.designContract)),
    task: existsSync(safe_resolve(ctx, manifest.paths.task)),
    result: existsSync(safe_resolve(ctx, manifest.paths.result)),
    acceptance: existsSync(safe_resolve(ctx, manifest.paths.acceptance)),
  };

  return {
    schemaVersion: manifest.schemaVersion,
    project: manifest.project,
    protocolVersion: manifest.protocolVersion,
    designVersion: manifest.designVersion,
    transport: manifest.transport,
    status: manifest.status,
    paths: manifest.paths,
    resolved_paths,
    manifest_file: MANIFEST_PATH,
  };
}

function safe_resolve(ctx: ToolContext, rel: string): string {
  try {
    return resolve_readable(ctx.workspace, rel);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- get_design

export interface DesignPayload extends DesignContract {
  contract_file: string;
  manifest_design_version: string;
}

export function get_design(ctx: ToolContext): DesignPayload {
  const manifest = load_manifest(ctx);

  // 关键：路径只能来自 manifest，不接受调用方传入任意路径。
  const contract_path = manifest.paths.designContract;

  let raw: unknown;
  try {
    raw = read_json(ctx.workspace, contract_path);
  } catch (error) {
    const translated = as_tool_error(error, "DESIGN_MISSING");
    throw new ToolError("DESIGN_MISSING", `无法读取设计契约 ${contract_path}：${translated.message}`, translated.detail);
  }

  const parsed = DesignContractSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError("DESIGN_INVALID", `设计契约 ${contract_path} 结构不符合协议`, format_zod_error(parsed.error));
  }

  // 设计契约与 manifest 必须声明同一个设计版本。
  // 不一致意味着"取到的设计"与"协议声称的设计"不是同一份，下游无法据此验收。
  if (parsed.data.designVersion !== manifest.designVersion) {
    throw new ToolError(
      "VERSION_MISMATCH",
      "设计契约的 designVersion 与 manifest 不一致",
      `contract.designVersion=${parsed.data.designVersion} manifest.designVersion=${manifest.designVersion}`,
    );
  }

  return { ...parsed.data, contract_file: contract_path, manifest_design_version: manifest.designVersion };
}

// ---------------------------------------------------------------- get_task

export interface TaskPayload extends Task {
  task_file: string;
  manifest_design_version: string;
  design_version_matches_manifest: boolean;
}

export function get_task(ctx: ToolContext): TaskPayload {
  const manifest = load_manifest(ctx);
  const task_path = manifest.paths.task;

  let raw: unknown;
  try {
    raw = read_json(ctx.workspace, task_path);
  } catch (error) {
    const translated = as_tool_error(error, "TASK_MISSING");
    throw new ToolError("TASK_MISSING", `无法读取任务文件 ${task_path}：${translated.message}`, translated.detail);
  }

  const parsed = TaskSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError("TASK_INVALID", `任务文件 ${task_path} 结构不符合协议`, format_zod_error(parsed.error));
  }
  const task = parsed.data;

  // 任务与 manifest 的设计版本必须一致，否则下游无法判断结果属于哪个设计版本。
  const matches = task.designVersion === manifest.designVersion;
  if (!matches) {
    throw new ToolError(
      "VERSION_MISMATCH",
      "任务的设计版本与 manifest 不一致",
      `task.designVersion=${task.designVersion} manifest.designVersion=${manifest.designVersion}`,
    );
  }

  return { ...task, task_file: task_path, manifest_design_version: manifest.designVersion, design_version_matches_manifest: matches };
}

// ---------------------------------------------------------------- submit_result

export interface SubmitResultPayload {
  accepted: boolean;
  taskId: string;
  designVersion: string;
  status: string;
  written_file: string;
  bytes: number;
  overwritten: boolean;
  checks_recorded: number;
  note: string;
}

export function submit_result(ctx: ToolContext, input: SubmitResultInput): SubmitResultPayload {
  const manifest = load_manifest(ctx);

  // 任务文件必须存在且自洽：不能对不存在的任务提交结果。
  const task = get_task(ctx);

  if (input.taskId !== task.taskId) {
    throw new ToolError("VERSION_MISMATCH", "taskId 与工作区中的任务不匹配", `提交 ${input.taskId}，工作区 ${task.taskId}`);
  }
  if (input.designVersion !== manifest.designVersion) {
    throw new ToolError(
      "VERSION_MISMATCH",
      "designVersion 与 manifest 不匹配",
      `提交 ${input.designVersion}，manifest ${manifest.designVersion}`,
    );
  }

  const outbox = normalize(ctx.outbox_dir);
  assert_outbox_allowed(manifest, outbox);

  const stamp = input.executedAt.replace(/[:.]/g, "-");
  const suffix = randomBytes(4).toString("hex");
  const rel_path = `${outbox}/${sanitize(task.taskId)}__${stamp}__${suffix}.json`;

  const payload = {
    schemaVersion: input.schemaVersion,
    taskId: input.taskId,
    status: input.status,
    designVersion: input.designVersion,
    executor: input.executor,
    executedAt: input.executedAt,
    checks: input.checks,
    summary: summarize(input.checks),
    artifacts: input.artifacts,
    notes: input.notes ?? "",
    writtenBy: "designbridge-mcp-server",
    isolated: true,
    note: "本文件写入隔离目录，未覆盖协议目录下的 handoff/result.json",
  };

  const text = `${JSON.stringify(payload, null, 2)}\n`;
  let written: string;
  try {
    written = atomic_write_text(ctx.workspace, rel_path, text, { overwrite: input.overwrite });
  } catch (error) {
    const translated = as_tool_error(error, "WRITE_REJECTED");
    throw new ToolError("WRITE_REJECTED", `写入失败：${translated.message}`, translated.detail);
  }

  // 读回校验：确认落盘内容可解析且与提交一致，避免"写成功但内容坏了"。
  const readback = read_json(ctx.workspace, rel_path) as { taskId?: unknown; status?: unknown };
  if (readback.taskId !== input.taskId || readback.status !== input.status) {
    throw new ToolError("WRITE_REJECTED", "写入后读回校验失败", rel_path);
  }

  return {
    accepted: true,
    taskId: input.taskId,
    designVersion: input.designVersion,
    status: input.status,
    written_file: to_relative(ctx.workspace, written),
    bytes: Buffer.byteLength(text, "utf8"),
    overwritten: input.overwrite,
    checks_recorded: input.checks.length,
    note: "已写入隔离目录并通过读回校验；未修改 handoff/result.json，未执行任何 Git 操作",
  };
}

/**
 * 隔离输出目录的准入检查。
 *
 * 仅仅"不等于 result 文件"是不够的——把 outbox 指到 `protocol/` 或 `handoff/`
 * 同样会污染协议目录（比如往 `handoff/` 里塞一堆结果文件，或与协议文件同名）。
 *
 * 规则（全部拒绝）：
 *   1. outbox 为空 / 等于工作区根 —— 范围过大，等同放任写入；
 *   2. outbox 等于或位于任一**受保护路径**之内（受保护路径 = 协议文件自身与其所在目录）；
 *   3. outbox 是任一受保护路径的**上级** —— 否则它把协议目录整个罩住了。
 *
 * 受保护目录由 manifest 声明的路径推导（如 `protocol/manifest.json` -> `protocol/`），
 * 并额外把 `protocol` 固定加入，避免 manifest 被改成指向别处时失去保护。
 */
function assert_outbox_allowed(manifest: Manifest, outbox: string): void {
  if (outbox.length === 0 || outbox === ".") {
    throw new ToolError("WRITE_REJECTED", "隔离输出目录不能是工作区根目录", `outbox=${JSON.stringify(outbox)}`);
  }

  const protected_paths = new Set<string>(["protocol/manifest.json", "protocol"]);
  for (const declared of [
    manifest.paths.designContract,
    manifest.paths.task,
    manifest.paths.result,
    manifest.paths.acceptance,
  ]) {
    const file = normalize(declared);
    protected_paths.add(file);
    const parent = normalize(dirname(file));
    if (parent.length > 0 && parent !== ".") protected_paths.add(parent);
  }

  for (const guarded of protected_paths) {
    if (outbox === guarded || outbox.startsWith(`${guarded}/`)) {
      throw new ToolError(
        "WRITE_REJECTED",
        "隔离输出目录不得位于协议目录内",
        `outbox=${outbox} 落在受保护路径 ${guarded} 之下`,
      );
    }
    if (guarded.startsWith(`${outbox}/`)) {
      throw new ToolError(
        "WRITE_REJECTED",
        "隔离输出目录不得覆盖协议路径",
        `outbox=${outbox} 是受保护路径 ${guarded} 的上级`,
      );
    }
  }
}

// ---------------------------------------------------------------- helpers

function load_manifest(ctx: ToolContext): Manifest {
  let raw: unknown;
  try {
    raw = read_json(ctx.workspace, MANIFEST_PATH);
  } catch (error) {
    const translated = as_tool_error(error, "MANIFEST_MISSING");
    throw new ToolError("MANIFEST_MISSING", `无法读取 ${MANIFEST_PATH}：${translated.message}`, translated.detail);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError("MANIFEST_INVALID", `${MANIFEST_PATH} 结构不符合协议`, format_zod_error(parsed.error));
  }
  return parsed.data;
}

function summarize(checks: CheckResult[]): { total: number; passed: number; failed: number; skipped: number } {
  return {
    total: checks.length,
    passed: checks.filter((c) => c.status === "pass").length,
    failed: checks.filter((c) => c.status === "fail").length,
    skipped: checks.filter((c) => c.status === "skip").length,
  };
}

/** 文件名安全化：只保留字母数字与 _-，其余折叠为 -。 */
function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "task";
}

function normalize(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export { SubmitResultInputSchema };
