#!/usr/bin/env node
/**
 * DesignBridge 本地 MCP Server 入口。
 *
 * 传输：stdio。**stdout 只允许承载 MCP 协议帧**，任何普通日志一律走 stderr——
 * 这是 stdio 型 MCP Server 最容易踩的坑：一句 console.log 就会污染协议流，
 * 客户端会直接解析失败。
 *
 * 安全姿态：
 * - 只暴露四个只读/受限写工具，不提供任何 shell 执行能力；
 * - 所有文件访问经 workspace.ts 的边界检查；
 * - 结果只写隔离目录，不碰 protocol 目录下的 handoff/result.json；
 * - 不读取任何密钥、录音或私有项目文件（本服务只认工作区内的协议文件）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";

import { WorkspaceError, locate_workspace_root, openWorkspace } from "./workspace.js";
import { RESULT_STATUSES, SubmitResultInputSchema } from "./validation.js";
import { ToolError, get_design, get_manifest, get_task, submit_result, type ToolContext } from "./tools.js";

const SERVER_NAME = "designbridge";
const SERVER_VERSION = "0.2.0";
const DEFAULT_OUTBOX = ".designbridge-outbox";

/** 仅写 stderr 的结构化日志。 */
function log(level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, component: SERVER_NAME, message, ...extra });
  process.stderr.write(`${line}\n`);
}

function json_content(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** 统一的错误出口：把内部错误码翻成对模型可读的文本，并标记 isError。 */
function error_result(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  let code = "INTERNAL_ERROR";
  let message = "未知错误";
  let detail: string | undefined;

  if (error instanceof ToolError) {
    code = error.code;
    message = error.message;
    detail = error.detail;
  } else if (error instanceof WorkspaceError) {
    code = error.code;
    message = error.message;
    detail = error.detail;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }

  log("error", "tool call failed", { code, message, detail });
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, code, message, ...(detail ? { detail } : {}) }, null, 2) }],
    isError: true,
  };
}

export function create_server(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "get_manifest",
    {
      title: "读取协议清单",
      description:
        "读取 DesignBridge 工作区的 protocol/manifest.json，返回协议版本、设计版本与协议文件路径，" +
        "并逐项报告各路径是否真实存在。文件缺失或结构不符时返回明确错误。",
      inputSchema: {},
    },
    async () => {
      try {
        return json_content(get_manifest(ctx));
      } catch (error) {
        return error_result(error);
      }
    },
  );

  server.registerTool(
    "get_design",
    {
      title: "读取设计契约",
      description:
        "读取 manifest 指向的 design-contract.json，返回设计 ID、版本、设计 Token、布局与修改范围。" +
        "契约路径只能来自 manifest，不接受调用方指定任意路径。",
      inputSchema: {},
    },
    async () => {
      try {
        return json_content(get_design(ctx));
      } catch (error) {
        return error_result(error);
      }
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "读取任务",
      description:
        "读取 manifest 指向的 handoff/task.json，返回任务 ID、状态、设计版本与执行约束；" +
        "并校验 task.designVersion 与 manifest.designVersion 一致，不一致直接报错。",
      inputSchema: {},
    },
    async () => {
      try {
        return json_content(get_task(ctx));
      } catch (error) {
        return error_result(error);
      }
    },
  );

  server.registerTool(
    "submit_result",
    {
      title: "提交执行结果",
      description:
        "提交结构化执行结果。校验 taskId、designVersion、schemaVersion 与 status 后，" +
        "原子写入**隔离输出目录**（默认 .designbridge-outbox）。" +
        "绝不覆盖 protocol 目录下的 handoff/result.json，不执行任何 Git 操作。",
      inputSchema: {
        taskId: z.string().min(1).max(200).describe("任务 ID，必须与工作区中的任务一致"),
        designVersion: z.string().min(1).max(120).describe("设计版本，必须与 manifest 一致"),
        schemaVersion: z.literal("1.0.0").describe("协议 schema 版本，固定 1.0.0"),
        status: z.enum(RESULT_STATUSES).describe("执行状态：success / partial / blocked / failed"),
        executor: z.string().min(1).max(200).describe("真实执行者标识"),
        executedAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, "必须是 UTC ISO-8601，例如 2026-10-13T05:02:29Z")
          .describe("UTC 执行时间"),
        checks: z
          .array(
            z.object({
              id: z.string().min(1).max(120),
              name: z.string().min(1).max(400),
              status: z.enum(["pass", "fail", "skip"]),
              detail: z.string().max(2000).optional(),
            }),
          )
          .max(500)
          .optional()
          .describe("逐项检查结果"),
        artifacts: z.array(z.string().max(500)).max(200).optional().describe("产物相对路径列表"),
        notes: z.string().max(4000).optional().describe("补充说明"),
        overwrite: z.boolean().optional().describe("是否允许覆盖隔离目录内同名文件；默认 false"),
      },
    },
    async (args) => {
      try {
        const parsed = SubmitResultInputSchema.safeParse(args);
        if (!parsed.success) {
          return error_result(
            new ToolError(
              "INPUT_INVALID",
              "提交内容不符合协议",
              parsed.error.issues.slice(0, 12).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            ),
          );
        }
        return json_content(submit_result(ctx, parsed.data));
      } catch (error) {
        return error_result(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const root = locate_workspace_root(process.cwd(), process.env["DESIGNBRIDGE_ROOT"]);
  const outbox = process.env["DESIGNBRIDGE_OUTBOX_DIR"] ?? DEFAULT_OUTBOX;

  let workspace;
  try {
    workspace = openWorkspace(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "workspace open failed", { root, message });
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  const ctx: ToolContext = { workspace, outbox_dir: outbox };
  const server = create_server(ctx);

  log("info", "starting", { root: workspace.root, outbox, node: process.version });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "connected over stdio");
}

/**
 * 是否被"直接执行"（而不是被 import）。
 *
 * 必须用 pathToFileURL 转换后再比较：import.meta.url 是**百分号编码**的，
 * 而字符串拼接出的 `file://${argv[1]}` 不会编码。路径里只要有空格或非 ASCII
 * （本项目路径正是如此），两者永远不相等，main() 就会静默不执行。
 */
const is_direct = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (is_direct) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    log("error", "fatal", { message });
    process.exitCode = 1;
  });
}

export { main, log };
