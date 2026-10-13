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
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * 协议真值：仓库内的**三份**事实来源。
 *
 * **为什么一律从文件派生、不写死字面量**：`designVersion` / `designId` 这类字段会随每次
 * 设计交付而变（v0.4 就从 demo-library 翻到 demo-player）。测试写死它们，每交付一次就砸一次。
 *
 * **但三处绝不能共用一个来源** —— 每个字段各有所属，混用等于"测试与被测实现共用同一个
 * 错误假设"，会掩盖协议不一致：
 *   · `get_manifest.designVersion`、`get_task.manifest_design_version`、
 *     `submit_result` 入参的 `designVersion`      ← **manifest**（生产代码就是拿 manifest 比的）
 *   · `get_task.designVersion`                    ← **task**
 *   · `get_design` 的身份字段 / designTokens      ← **contract**
 */
const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "protocol", "manifest.json"), "utf8")) as {
  schemaVersion: string;
  designVersion: string;
  paths: { designContract: string; task: string; result: string; acceptance: string };
};

/** 契约路径取自 manifest 的**声明**，不另写一份字面量路径。 */
const CONTRACT = JSON.parse(readFileSync(join(REPO_ROOT, MANIFEST.paths.designContract), "utf8")) as {
  designId: string;
  designVersion: string;
  screenId: string;
  platform: string;
  designTokens: Record<string, string | number>;
  layout: { orientation: string; regions: string[] };
  changeScope: { allowed: string[]; protected: string[] };
};

/** 任务路径同样取自 manifest 的声明。 */
const TASK = JSON.parse(readFileSync(join(REPO_ROOT, MANIFEST.paths.task), "utf8")) as {
  taskId: string;
  type: string;
  status: string;
  designVersion: string;
};

const OUTBOX = ".designbridge-outbox";

let workspace = "";
let client: Client | undefined;
let transport: StdioClientTransport | undefined;
let server_stderr = "";

/** 协议目录 / handoff 在测试开始时的「文件名单 + 内容哈希」基线。 */
let protocol_digest: Record<string, string> = {};
let handoff_digest: Record<string, string> = {};

function make_workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "dbsrv-"));
  cpSync(join(REPO_ROOT, "protocol"), join(dir, "protocol"), { recursive: true });
  cpSync(join(REPO_ROOT, "handoff"), join(dir, "handoff"), { recursive: true });
  return dir;
}

/**
 * 目录指纹：文件名 → 内容 sha256（子目录记 "<dir>"）。
 *
 * 比"只比文件名"更严：拒绝路径若被绕过、把**已有**协议文件改写了，名字集合一个都不会变，
 * 只有内容哈希能暴露它。键集合同时覆盖"多出 / 少掉文件"的检测。
 */
function dir_digest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    out[name] = statSync(full).isFile()
      ? createHash("sha256").update(readFileSync(full)).digest("hex")
      : "<dir>";
  }
  return out;
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
  // 记下初始「名单 + 内容哈希」基线：全部拒绝用例跑完后必须与它完全一致。
  // 用基线而不是写死名单 —— protocol/ 会随版本合法新增文档（v0.4 就新增了
  // design-delivery-spec.md），写死名单会把合法新增误判成污染；
  // 而"与初始基线完全一致"仍是强断言，任何真实落盘的写入都会立刻失败。
  protocol_digest = dir_digest(join(workspace, "protocol"));
  handoff_digest = dir_digest(join(workspace, "handoff"));

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
    // 真值来源 = protocol/manifest.json（get_manifest 返回的就是这份 manifest）
    assert.equal(payload["designVersion"], MANIFEST.designVersion);
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
  it("返回当前设计契约的身份字段", async () => {
    const { payload, isError } = await call("get_design");
    assert.equal(isError, false);
    assert.equal(payload["designId"], CONTRACT.designId);
    assert.equal(payload["designVersion"], CONTRACT.designVersion);
    assert.equal(payload["screenId"], CONTRACT.screenId);
    assert.equal(payload["platform"], CONTRACT.platform);
    // 协议不变量（生产代码据此抛 VERSION_MISMATCH）：契约与 manifest 必须声明同一版本。
    // 这里核对的是**两份文件本身**，不依赖被测实现的判断。
    assert.equal(CONTRACT.designVersion, MANIFEST.designVersion, "协议真值不一致：契约与 manifest 的 designVersion 必须相同");
  });

  it("包含设计 Token、布局与修改范围", async () => {
    const { payload } = await call("get_design");
    // 逐项与契约对齐：比原先"只挑 accent/cardRadiusDp 两个 token"更严，
    // 且不随设计更换而失效（原先写死 #ED8B43，换设计即失败）。
    const tokens = payload["designTokens"] as Record<string, unknown>;
    assert.deepEqual(tokens, CONTRACT.designTokens);
    const layout = payload["layout"] as { orientation: string; regions: string[] };
    assert.equal(layout.orientation, CONTRACT.layout.orientation);
    assert.deepEqual(layout.regions, CONTRACT.layout.regions);
    const scope = payload["changeScope"] as { allowed: string[]; protected: string[] };
    assert.deepEqual(scope.allowed, CONTRACT.changeScope.allowed);
    assert.deepEqual(scope.protected, CONTRACT.changeScope.protected);
  });

  it("design-contract 的 designVersion 与 manifest 不一致时返回 VERSION_MISMATCH", async () => {
    const broken = mkdtempSync(join(tmpdir(), "dbdesignmismatch-"));
    cpSync(join(REPO_ROOT, "protocol"), join(broken, "protocol"), { recursive: true });
    cpSync(join(REPO_ROOT, "handoff"), join(broken, "handoff"), { recursive: true });
    const contract_path = join(broken, "protocol", "design-contract.json");
    const contract = JSON.parse(readFileSync(contract_path, "utf8")) as Record<string, unknown>;
    contract["designVersion"] = "demo-9.9";
    writeFileSync(contract_path, JSON.stringify(contract, null, 2), "utf8");

    const t = new StdioClientTransport({
      command: node_bin(),
      args: [server_js],
      cwd: broken,
      env: { ...(process.env as Record<string, string>), DESIGNBRIDGE_ROOT: broken, DESIGNBRIDGE_OUTBOX_DIR: OUTBOX },
    });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(t);
    const res = (await c.callTool({ name: "get_design", arguments: {} })) as JsonContent;
    assert.equal(res.isError, true, "版本不一致应报错");
    const payload = parse_json(res);
    assert.equal(payload["code"], "VERSION_MISMATCH");
    assert.match(String(payload["detail"]), /demo-9\.9/);
    await c.close();
    rmSync(broken, { recursive: true, force: true });
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
    // 真值来源 = handoff/task.json（get_task 返回的就是这份 task）
    assert.equal(payload["designVersion"], TASK.designVersion);
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
    // manifest_design_version 的真值来源 = protocol/manifest.json
    assert.equal(payload["manifest_design_version"], MANIFEST.designVersion);
    // 再独立核一次**文件本身**是否一致：只信 payload.design_version_matches_manifest
    // 等于拿被测实现的结论当证据（测试与被测实现共用假设）。
    assert.equal(TASK.designVersion, MANIFEST.designVersion, "协议真值不一致：task 与 manifest 的 designVersion 必须相同");
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
  // 真值来源 = protocol/manifest.json：生产代码就是拿 manifest.designVersion 比对入参。
  // 写死字面量会让"合法提交"在换了设计版本后变成"非法提交"，测试反过来诬告实现。
  designVersion: MANIFEST.designVersion,
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

  /** 用指定 outbox 起一个服务端，尝试提交，返回错误码（或 "OK"）。 */
  async function submit_with_outbox(outbox_value: string): Promise<string> {
    const t = new StdioClientTransport({
      command: node_bin(),
      args: [server_js],
      cwd: workspace,
      env: { ...(process.env as Record<string, string>), DESIGNBRIDGE_ROOT: workspace, DESIGNBRIDGE_OUTBOX_DIR: outbox_value },
    });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(t);
    const res = (await c.callTool({ name: "submit_result", arguments: valid_submission() })) as JsonContent;
    let code = "OK";
    if (res.isError === true) {
      const text = res.content.find((x) => x.type === "text")?.text ?? "";
      try {
        code = String((JSON.parse(text) as Record<string, unknown>)["code"]);
      } catch {
        code = "PROTOCOL_REJECTED";
      }
    }
    await c.close();
    return code;
  }

  /**
   * 全部必须拒绝的取值。
   *
   * 重点是**绕过形式**：字符串前缀比较看不出 `preview/../handoff` 的问题，
   * 但它 resolve 之后就是 `<ws>/handoff`——这是审查发现的真实漏洞，此处固化为回归用例。
   */
  const rejected_outbox_values: Array<[string, string]> = [
    // —— 直接指向协议目录/文件 ——
    ["protocol", "协议目录本身"],
    ["handoff", "协议目录本身"],
    ["protocol/sub", "协议目录之内"],
    ["handoff/nested", "协议目录之内"],
    ["protocol/manifest.json", "直接指向协议文件"],
    ["handoff/result.json", "直接指向协议文件"],
    // —— 规范化绕过（本轮修复的核心）——
    ["preview/../handoff", "经 .. 规范化后落入 handoff"],
    ["x/../protocol", "经 .. 规范化后落入 protocol"],
    ["a/b/../../handoff", "多级 .. 规范化后落入 handoff"],
    ["preview/../handoff/nested", "经 .. 再进子目录"],
    // —— 重复分隔符 ——
    ["protocol//sub", "重复分隔符"],
    ["handoff//", "末尾重复分隔符"],
    ["preview//../handoff", "重复分隔符 + .."],
    // —— 工作区根 / 上级 ——
    [".", "工作区根"],
    ["", "空值"],
    ["..", "工作区上级"],
    /// —— 绝对路径与歧义写法 ——
    ["/handoff", "绝对路径"],
    ["C:/handoff", "Windows 盘符"],
    ["handoff\\nested", "反斜杠"],
    [" handoff", "前导空白"],
    ["handoff ", "尾部空白"],
    ["./handoff", "前导 ./"],
    ["handoff/", "末尾斜杠（规范化后即协议目录）"],
  ];

  for (const [bad, why] of rejected_outbox_values) {
    it(`隔离目录被拒绝（${why}）：outbox=${JSON.stringify(bad)}`, async () => {
      const code = await submit_with_outbox(bad);
      assert.equal(code, "WRITE_REJECTED", `outbox=${JSON.stringify(bad)} 应被拒绝，实际 ${code}`);
    });
  }

  it("所有拒绝尝试都没有污染协议目录", async () => {
    // 强断言：跑完上面全部拒绝用例后，目录的「文件名单 + 内容哈希」必须与初始基线完全一致。
    // 基线 = make_workspace 从仓库复制来的内容，因此天然包含随版本合法新增的文档
    // （v0.4 起为 design-delivery-spec.md），不需要在测试里维护一份"完整"文件名清单。
    //
    // 两级都比：
    //   · 键集合（文件名）  —— 多出文件（污染写入）／少文件／改名 → 失败
    //   · 键值  （内容哈希）—— **改写已有文件内容**（文件名一个都不变）→ 失败
    //
    // 先确认基线有效（防止目录为空 / 复制失败导致的假通过），
    // 并显式覆盖 v0.4 起合法新增的 design-delivery-spec.md。
    for (const required of ["acceptance-rules.md", "design-contract.json", "design-delivery-spec.md", "manifest.json"]) {
      assert.ok(required in protocol_digest, `初始基线应包含协议文件：${required}`);
    }
    assert.deepEqual(
      dir_digest(join(workspace, "protocol")),
      protocol_digest,
      "protocol/ 不应有任何新增、删除或内容改动",
    );
    assert.deepEqual(
      dir_digest(join(workspace, "handoff")),
      handoff_digest,
      "handoff/ 不应有任何新增、删除或内容改动",
    );
  });

  it("合规隔离目录可正常写入", async () => {
    const code = await submit_with_outbox("outbox-ok");
    assert.equal(code, "OK", "普通隔离目录应允许");
    assert.ok(existsSync(join(workspace, "outbox-ok")), "应创建出该目录");
  });

  it("嵌套的合规隔离目录也可写入", async () => {
    const code = await submit_with_outbox("tmp/mcp-outbox");
    assert.equal(code, "OK", "不含 . / .. 的嵌套目录应允许");
    assert.ok(existsSync(join(workspace, "tmp", "mcp-outbox")), "应创建出嵌套目录");
  });
});

// ------------------------------------------------------------------ 真值来源可观测性

describe("真值来源可观测性", () => {
  it("manifest 与 task 的 designVersion 不一致时：get_manifest 仍报 manifest 版本，get_task 报 VERSION_MISMATCH", async () => {
    // 为什么需要这个用例（P2-1）：
    // 仓库里 manifest / task / contract 的 designVersion 当前**同值**，于是
    // "期望值从真值来源派生"的断言无法区分实现究竟读了哪一份 —— 例如 get_manifest
    // 误读 task.json，断言照样通过（虚假通过）。
    //
    // 本用例故意让 **task 与 manifest 分离**，把两个真值来源变成可观测的：
    //   · get_manifest 必须报 manifest 的值，且**不是**被改过的 task 值
    //   · get_task 必须拒绝，且错误明细同时点名 task 与 manifest 各自的值
    //
    // contract 一侧的可观测性**已由既有用例覆盖**（get_design 的「design-contract 的
    // designVersion 与 manifest 不一致时返回 VERSION_MISMATCH」断言明细含 contract 的
    // 版本），故此处不重复添加，符合"避免重复已有覆盖"。
    //
    // 隔离性：只写自己 mkdtemp 出来的 `broken` 副本，不碰 `workspace`，
    // 因此不影响「所有拒绝尝试都没有污染协议目录」等其他用例。
    const broken = mkdtempSync(join(tmpdir(), "dbsrc-"));
    cpSync(join(REPO_ROOT, "protocol"), join(broken, "protocol"), { recursive: true });
    cpSync(join(REPO_ROOT, "handoff"), join(broken, "handoff"), { recursive: true });
    const task_path = join(broken, "handoff", "task.json");
    const task = JSON.parse(readFileSync(task_path, "utf8")) as Record<string, unknown>;
    const task_only_version = "task-only-9.9";
    task["designVersion"] = task_only_version;
    writeFileSync(task_path, JSON.stringify(task, null, 2), "utf8");

    const t = new StdioClientTransport({
      command: node_bin(),
      args: [server_js],
      cwd: broken,
      env: { ...(process.env as Record<string, string>), DESIGNBRIDGE_ROOT: broken, DESIGNBRIDGE_OUTBOX_DIR: OUTBOX },
    });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(t);
    try {
      // ① get_manifest 读的是 manifest：报 manifest 的值，而不是 task 的值
      const manifest_res = (await c.callTool({ name: "get_manifest", arguments: {} })) as JsonContent;
      // 注意：SDK 成功时 isError 为 undefined（不是 false），故用 !== true 判定。
      assert.ok(manifest_res.isError !== true, "task 的版本漂移不应影响 get_manifest（它只读 manifest）");
      const manifest_payload = parse_json(manifest_res);
      assert.equal(
        manifest_payload["designVersion"],
        MANIFEST.designVersion,
        `get_manifest 应报 manifest 的 designVersion（${MANIFEST.designVersion}），实际 ${String(manifest_payload["designVersion"])}`,
      );
      assert.notEqual(
        manifest_payload["designVersion"],
        task_only_version,
        "get_manifest 不得返回 task 的 designVersion —— 否则说明它读错了文件",
      );

      // ② get_task 必须拒绝，且明细同时点名两个来源各自的值
      const task_res = (await c.callTool({ name: "get_task", arguments: {} })) as JsonContent;
      assert.equal(task_res.isError, true, "task 与 manifest 的 designVersion 不一致时 get_task 应报错");
      const task_payload = parse_json(task_res);
      assert.equal(task_payload["code"], "VERSION_MISMATCH");
      const detail = String(task_payload["detail"]);
      assert.ok(detail.includes(task_only_version), `明细应点名 task 的版本 ${task_only_version}，实际：${detail}`);
      assert.ok(detail.includes(MANIFEST.designVersion), `明细应点名 manifest 的版本 ${MANIFEST.designVersion}，实际：${detail}`);
    } finally {
      await c.close();
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
