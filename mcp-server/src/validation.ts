/**
 * 协议数据的 Schema 定义与校验。
 *
 * 用 Zod 做**运行时**校验：协议文件是外部输入，TypeScript 类型擦除后不提供任何保护，
 * 只有真正 parse 过才能保证下游拿到的是形状正确的对象。
 *
 * 约定：
 * - 读方向（manifest / design-contract / task）宽容度低：字段缺失即报错，并给出路径化错误。
 * - 写方向（submit_result 输入）额外限制长度与枚举，避免把任意内容写进仓库。
 */
import { z } from "zod";

/** 协议 schema 版本。submit_result 要求字面量匹配，防止跨版本误写。 */
export const SCHEMA_VERSION = "1.0.0";

/** ISO-8601 UTC，形如 2026-10-13T05:02:29Z。手写正则以免受 Zod 版本 API 变动影响。 */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const ManifestSchema = z.object({
  schemaVersion: z.string().min(1),
  project: z.string().min(1),
  protocolVersion: z.string().min(1),
  designVersion: z.string().min(1),
  transport: z.string().min(1),
  status: z.string().min(1),
  paths: z.object({
    designContract: z.string().min(1),
    task: z.string().min(1),
    result: z.string().min(1),
    acceptance: z.string().min(1),
  }),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const DesignContractSchema = z.object({
  schemaVersion: z.string().min(1),
  designId: z.string().min(1),
  designVersion: z.string().min(1),
  platform: z.string().min(1),
  screenId: z.string().min(1),
  description: z.string().optional(),
  designTokens: z.record(z.string(), z.union([z.string(), z.number()])),
  layout: z.object({
    orientation: z.string().min(1),
    regions: z.array(z.string()),
  }),
  changeScope: z.object({
    allowed: z.array(z.string()),
    protected: z.array(z.string()),
  }),
  referenceAssets: z.array(z.unknown()),
});
export type DesignContract = z.infer<typeof DesignContractSchema>;

export const TaskSchema = z.object({
  schemaVersion: z.string().min(1),
  taskId: z.string().min(1),
  type: z.string().min(1),
  status: z.string().min(1),
  designVersion: z.string().min(1),
  target: z.string().min(1),
  instructions: z.array(z.string()),
  constraints: z.array(z.string()),
});
export type Task = z.infer<typeof TaskSchema>;

/** submit_result 允许落地的状态。success 之外一律视为未完成。 */
export const RESULT_STATUSES = ["success", "partial", "blocked", "failed"] as const;

export const CheckResultSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(400),
  status: z.enum(["pass", "fail", "skip"]),
  detail: z.string().max(2000).optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/**
 * submit_result 的输入。
 *
 * `overwrite` 默认 false —— 默认策略是"绝不覆盖"，与任务要求一致。
 * 即便显式传 true，也只能覆盖**隔离目录内**已存在的文件（见 tools.ts）。
 */
export const SubmitResultInputSchema = z.object({
  taskId: z.string().min(1).max(200),
  designVersion: z.string().min(1).max(120),
  schemaVersion: z.literal(SCHEMA_VERSION),
  status: z.enum(RESULT_STATUSES),
  executor: z.string().min(1).max(200),
  executedAt: z.string().regex(UTC_INSTANT, "必须是 UTC ISO-8601，例如 2026-10-13T05:02:29Z"),
  checks: z.array(CheckResultSchema).max(500).default([]),
  artifacts: z.array(z.string().max(500)).max(200).default([]),
  notes: z.string().max(4000).optional(),
  overwrite: z.boolean().default(false),
});
export type SubmitResultInput = z.infer<typeof SubmitResultInputSchema>;

/** 把 Zod 错误压缩成一行可读文本（避免把整棵树塞进错误消息）。 */
export function format_zod_error(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
