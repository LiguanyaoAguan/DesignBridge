/**
 * MCP 协议层测试：真实启动服务端进程，用官方 SDK 客户端完成 initialize / listTools / callTool。
 *
 * 刻意**不用 mock**：MCP 的价值就在于进程间协议，mock 掉传输等于什么都没测。
 *
 * 测试工作区是仓库的临时副本（protocol/ + handoff/），因此写入类用例不会弄脏真实仓库；
 * 真实仓库在测试前后各取一次 git 状态做对比（见"工作区无意外改动"用例）。
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * 解析 Node 可执行文件路径。
 *
 * **Android/Termux 特有坑**：`process.execPath` 在本环境返回的是动态链接器
 * （`/apex/com.android.runtime/bin/linker64`），而不是 node 本身。
 * 用它去 spawn，内核会拿 .js 当 ELF 去加载，报 "has bad ELF magic"。
 * `process.argv0` 才是真正的 node 路径。
 */
function node_bin(): string {
  const argv0 = process.argv0;
  if (typeof argv0 === "string" && argv0.length > 0 && existsSync(argv0)) return argv0;
  return "node";
}

const here = dirname(fileURLToPath(import.meta.url));
/** dist/tests -> dist -> mcp-server */
const server_js = resolve(here, "..", "src", "index.js");
const package_root = resolve(here, "..", "..");
const REPO_ROOT = process.env["DESIGNBRIDGE_TEST_ROOT"] ?? resolve(package_root, "..");

const OUTBOX = ".designbridge-outbox";

let workspace = "";
let client: Client | undefined;
let transport: StdioClientTransport | undefined;
let server_stderr = "";

function make_workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dbsrv-"));
  cpSync(join(REPO_ROOT, "protocol"), join(dir, "protocol"), { recursive: true });
  cpSync(join(REPO_ROOT, "handoff"), join(dir, "handoff"), { recursive: true });
  return dir;
}

interface JsonContent {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parse_json(result: unknown): Record<string, unknown> {
  const typed = result as JsonContent;
  const text = typed.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * 断言一次调用被**拒绝**，并返回拒绝原因文本。
 *
 * 入参校验是两层：MCP SDK 先按 inputSchema 在协议层拦（-32602），
 * 我的 handler 再拦跨字段一致性（taskId/designVersion 与工作区比对）。
 * 因此拒绝可能表现为「协议错误」或「isError + 错误码」，两者都算拒绝。
 */
async function expect_rejected(name: string, args: Record<string, unknown>): Promise<string> {
  assert.ok(client !== undefined, "client 未初始化");
  try {
    const result = (await client.callTool({ name, arguments: args })) as JsonContent;
    assert.equal(result.isError, true, `应被拒绝，实际成功返回：${JSON.stringify(result).slice(0, 200)}`);
    return result.content.find((c) => c.type === "text")?.text ?? "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  assert.ok(client !== undefined, "client 未初始化");
  const result = (await client.callTool({ name, arguments: args })) as JsonContent;
  return { payload: parse_json(result), isError: result.isError === true };
}

before(async () => {
  workspace = make_workspace();

  transport = new StdioClientTransport({
    command: node_bin(),
    args: [server_js],
    cwd: workspace,
    env: {
      ...(process.env as Record<string, string>),
      DESIGNBRIDGE_ROOT: workspace,
      DESIGNBRIDGE_OUTBOX_DIR: OUTBOX,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    server_stderr += chunk.toString("utf8");
  });

  client = new Client({ name: "designbridge-test-client", version: "0.2.0" });
  await client.connect(transport);
});

after(async () => {
  try {
    await client?.close();
  } catch {
    /* 忽略关闭异常 */
  }
  rmSync(workspace, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 1 & 2

describe("服务端启动与 initialize", () => {
  it("服务端进程可启动，客户端完成 initialize", () => {
    assert.ok(transport !== undefined, "transport 应已建立");
    assert.ok(client !== undefined, "client 应已连接");
    const info = client.getServerVersion();
    assert.equal(info?.name, "designbridge");
    assert.equal(info?.version, "0.2.0");
  });

  it("启动日志写到 stderr，且为结构化 JSON", () => {
    const lines = server_stderr.trim().split("\n").filter((l) => l.length > 0);
    assert.ok(lines.length > 0, "stderr 应有启动日志");
    const parsed = JSON.parse(lines[0] ?? "{}") as { component?: string; level?: string };
    assert.equal(parsed.component, "designbridge");
    assert.ok(typeof parsed.level === "string");
  });
});

// ------------------------------------------------------------------ 3

describe("工具清单", () => {
  it("恰好暴露四个工具且名称正确", async () => {
    assert.ok(client !== undefined);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_design", "get_manifest", "get_task", "submit_result"]);
  });

  it("不暴露任何 shell / 任意读写类工具", async () => {
    assert.ok(client !== undefined);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).join(",").toLowerCase();
    for (const forbidden of ["shell", "exec", "bash", "run_command", "read_file", "write_file", "read_any", "write_any"]) {
      assert.ok(!names.includes(forbidden), `不应暴露 ${forbidden}`);
    }
  });
});

// ------------------------------------------------------------------ 4

describe("get_manifest", () => {
  it("返回正确的协议数据", async () => {
    const { payload, isError } = await call("get_manifest");
    assert.equal(isError, false);
    assert.equal(payload["project"], "DesignBridge");
    assert.equal(payload["schemaVersion"], "1.0.0");
    assert.equal(payload["protocolVersion"], "0.1.0");
    assert.equal(payload["designVersion"], "demo-0.1");
    const paths = payload["paths"] as Record<string, string>;
    assert.equal(paths["designContract"], "protocol/design-contract.json");
    assert.equal(paths["task"], "handoff/task.json");
    assert.equal(paths["result"], "handoff/result.json");
  });

  it("报告声明路径是否真实存在", async () => {
    const { payload } = await call("get_manifest");
    const resolved = payload["resolved_paths"] as Record<string, boolean>;
    assert.equal(resolved["designContract"], true);
    assert.equal(resolved["task"], true);
    assert.equal(resolved["result"], true);
    assert.equal(resolved["acceptance"], true);
  });

  it("manifest 缺失时返回明确错误", async () => {
    const broken = mkdtempSync(join(tmpdir(), "dbnoman-"));
    const t = new StdioClientTransport({
      command: node_bin(),
      args: [server_js],
      cwd: broken,
      env: { ...(process.env as Record<string, string>), DESIGNBRIDGE_ROOT: broken, DESIGNBRIDGE_OUTBOX_DIR: OUTBOX },
    });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(t);
    const res = (await c.callTool({ name: "get_manifest", arguments: {} })) as JsonContent;
    assert.equal(res.isError, true, "缺少 manifest 应报错");
    assert.equal(parse_json(res)["code"], "MANIFEST_MISSING");
    await c.close();
    rmSync(broken, { recursive: true, force: true });
  });

  it("manifest JSON 损坏时返回 PARSE_FAILED 类错误", async () => {
    const broken = mkdtempSync(join(tmpdir(), "dbbadman-"));
    cpSync(join(REPO_ROOT, "handoff"), join(broken, "handoff"), { recursive: true });
    cpSync(join(REPO_ROOT, "protocol"), join(broken, "protocol"), { recursive: true });
    writeFileSync(join(broken, "protocol", "manifest.json"), "{ broken", "utf8");
    const t = new StdioClientTransport({
      command: node_bin(),
      args: [server_js],
      cwd: broken,
      env: { ...(process.env as Record<string, string>), DESIGNBRIDGE_ROOT: broken, DESIGNBRIDGE_OUTBOX_DIR: OUTBOX },
    });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(t);
    const res = (await c.callTool({ name: "get_manifest", arguments: {} })) as JsonContent;
    assert.equal(res.isError, true);
    const payload = parse_json(res);
    assert.ok(["MANIFEST_MISSING", "MANIFEST_INVALID"].includes(String(payload["code"])), `实际 ${String(payload["code"])}`);
    await c.close();
    rmSync(broken, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ 5

describe("get_design", () => {
  it("返回 demo-library 设计契约", async () => {
    const { payload, isError } = await call("get_design");
    assert.equal(isError, false);
    assert.equal(payload["designId"], "demo-library");
    assert.equal(payload["designVersion"], "demo-0.1");
    assert.equal(payload["screenId"], "library");
    assert.equal(payload["platform"], "android-compose");
  });

  it("包含设计 Token、布局与修改范围", async () => {
    const { payload } = await call("get_design");
    const tokens = payload["designTokens"] as Record<string, unknown>;
    assert.equal(tokens["accent"], "#ED8B43");
    assert.equal(tokens["cardRadiusDp"], 16);
    const layout = payload["layout"] as { orientation: string; regions: string[] };
    assert.equal(layout.orientation, "landscape");
    assert.deepEqual(layout.regions, ["navigation", "recording-list", "detail-panel"]);
    const scope = payload["changeScope"] as { allowed: string[]; protected: string[] };
    assert.deepEqual(scope.allowed, ["demo-library"]);
  });

  it("路径只能来自 manifest —— 工具不接受任意路径参数", async () => {
    assert.ok(client !== undefined);
    const listed = await client.listTools();
    const design = listed.tools.find((t) => t.name === "get_design");
    const schema = (design?.inputSchema ?? {}) as { properties?: Record<string, unknown> };
    assert.deepEqual(Object.keys(schema.properties ?? {}), [], "get_design 不应有任何入参");
  });
});

// ------------------------------------------------------------------ 6

describe("get_task", () => {
  it("返回 bootstrap-connectivity-001", async () => {
    const { payload, isError } = await call("get_task");
    assert.equal(isError, false);
    assert.equal(payload["taskId"], "bootstrap-connectivity-001");
    assert.equal(payload["type"], "connectivity-check");
    assert.equal(payload["status"], "ready");
    assert.equal(payload["designVersion"], "demo-0.1");
  });

  it("返回执行约束", async () => {
    const { payload } = await call("get_task");
    const constraints = payload["constraints"] as string[];
    assert.ok(Array.isArray(constraints) && constraints.length > 0);
    assert.ok(constraints.some((c) => c.includes("InnerRec")));
  });

  it("校验并报告 task 与 manifest 的 designVersion 一致性", async () => {
    const { payload } = await call("get_task");
    assert.equal(payload["design_version_matches_manifest"], true);
    assert.equal(payload["manifest_design_version"], "demo-0.1");
  });

  it("版本不一致时拒绝返回", async () => {
    const broken = mkdtempSync(join(tmpdir(), "dbmismatch-"));
    cpSync(join(REPO_ROOT, "protocol"), join(broken, "protocol"), { recursive: true });
    cpSync(join(REPO_ROOT, "handoff"), join(broken, "handoff"), { recursive: true });
    const task_path = join(broken, "handoff", "task.json");
    const task = JSON.parse(readFileSync(task_path, "utf8")) as Record<string, unknown>;
    task["designVersion"] = "wrong-9.9";
    writeFileSync(task_path, JSON.stringify(task, null, 2), "utf8");

    const t = new StdioClientTransport({
      command: node_bin(),
      args: [server_js],
      cwd: broken,
      env: { ...(process.env as Record<string, string>), DESIGNBRIDGE_ROOT: broken, DESIGNBRIDGE_OUTBOX_DIR: OUTBOX },
    });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(t);
    const res = (await c.callTool({ name: "get_task", arguments: {} })) as JsonContent;
    assert.equal(res.isError, true, "版本不一致应报错");
    assert.equal(parse_json(res)["code"], "VERSION_MISMATCH");
    await c.close();
    rmSync(broken, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ 7 & 8 & 10

const valid_submission = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  taskId: "bootstrap-connectivity-001",
  designVersion: "demo-0.1",
  schemaVersion: "1.0.0",
  status: "success",
  executor: "designbridge-test-client",
  executedAt: "2026-10-13T05:30:00Z",
  checks: [
    { id: "t1", name: "示例检查", status: "pass", detail: "ok" },
    { id: "t2", name: "示例失败", status: "fail" },
  ],
  artifacts: [],
  notes: "来自自动化测试",
  ...over,
});

describe("submit_result", () => {
  it("写入隔离目录并能读回", async () => {
    const { payload, isError } = await call("submit_result", valid_submission());
    assert.equal(isError, false, JSON.stringify(payload));
    assert.equal(payload["accepted"], true);
    assert.equal(payload["status"], "success");
    assert.equal(payload["checks_recorded"], 2);

    const rel = String(payload["written_file"]);
    assert.ok(rel.startsWith(`${OUTBOX}/`), `应写入隔离目录，实际 ${rel}`);
    assert.ok(!rel.includes("handoff/result.json"), "绝不能写到协议结果文件");

    // 真实读回：文件存在、可解析、字段一致
    const abs = join(workspace, rel);
    assert.ok(existsSync(abs), `文件应存在：${rel}`);
    const back = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    assert.equal(back["taskId"], "bootstrap-connectivity-001");
    assert.equal(back["status"], "success");
    assert.equal(back["schemaVersion"], "1.0.0");
    assert.equal(back["isolated"], true);
    const summary = back["summary"] as Record<string, number>;
    assert.deepEqual(summary, { total: 2, passed: 1, failed: 1, skipped: 0 });
  });

  it("错误 taskId 被拒绝", async () => {
    const { payload, isError } = await call("submit_result", valid_submission({ taskId: "not-a-real-task" }));
    assert.equal(isError, true);
    assert.equal(payload["code"], "VERSION_MISMATCH");
  });

it("工具层自带校验：SDK 之后的跨字段一致性由 handler 把关", async () => {
    // taskId 形状合法（能过 inputSchema），但与工作区不一致 —— 只能由 handler 拒绝。
    const reason = await expect_rejected("submit_result", valid_submission({ taskId: "well-formed-but-wrong" }));
    assert.match(reason, /VERSION_MISMATCH|不匹配/, `应由工具层拒绝，实际：${reason.slice(0, 200)}`);
  });

  it("错误 designVersion 被拒绝", async () => {
    const { payload, isError } = await call("submit_result", valid_submission({ designVersion: "demo-9.9" }));
    assert.equal(isError, true);
    assert.equal(payload["code"], "VERSION_MISMATCH");
  });

  it("错误 schemaVersion 被拒绝", async () => {
    const reason = await expect_rejected("submit_result", valid_submission({ schemaVersion: "2.0.0" }));
    assert.match(reason, /schemaVersion|1\.0\.0|INPUT_INVALID/, `拒绝原因应指向 schemaVersion，实际：${reason.slice(0, 200)}`);
  });

  it("非法 status 被拒绝", async () => {
    const reason = await expect_rejected("submit_result", valid_submission({ status: "totally-fine" }));
    assert.match(reason, /status|success|partial|INPUT_INVALID/, `拒绝原因应指向 status，实际：${reason.slice(0, 200)}`);
  });

  it("非 UTC 的 executedAt 被拒绝", async () => {
    const reason = await expect_rejected("submit_result", valid_submission({ executedAt: "2026-10-13 05:30:00" }));
    assert.match(reason, /executedAt|UTC|ISO|INPUT_INVALID/, `拒绝原因应指向 executedAt，实际：${reason.slice(0, 200)}`);
  });

  it("原有 handoff/result.json 未被覆盖", async () => {
    const before = readFileSync(join(workspace, "handoff", "result.json"), "utf8");
    await call("submit_result", valid_submission({ status: "partial" }));
    const after = readFileSync(join(workspace, "handoff", "result.json"), "utf8");
    assert.equal(after, before, "handoff/result.json 必须逐字节不变");
  });

  it("多次提交产生不同文件，不互相覆盖", async () => {
    const a = await call("submit_result", valid_submission({ executedAt: "2026-10-13T06:00:00Z" }));
    const b = await call("submit_result", valid_submission({ executedAt: "2026-10-13T07:00:00Z" }));
    assert.notEqual(a.payload["written_file"], b.payload["written_file"]);
    assert.ok(existsSync(join(workspace, String(a.payload["written_file"]))));
    assert.ok(existsSync(join(workspace, String(b.payload["written_file"]))));
  });

  it("隔离目录与协议结果目录重叠时拒绝写入", async () => {
    const t = new StdioClientTransport({
      command: node_bin(),
      args: [server_js],
      cwd: workspace,
      env: {
        ...(process.env as Record<string, string>),
        DESIGNBRIDGE_ROOT: workspace,
        DESIGNBRIDGE_OUTBOX_DIR: "handoff",
      },
    });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(t);
    const res = (await c.callTool({ name: "submit_result", arguments: valid_submission() })) as JsonContent;
    assert.equal(res.isError, true, "把 outbox 指到 handoff/ 应被拒绝");
    assert.equal(parse_json(res)["code"], "WRITE_REJECTED");
    await c.close();
  });
});
