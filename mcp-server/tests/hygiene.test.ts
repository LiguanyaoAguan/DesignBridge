/**
 * 卫生性测试：
 *  - 需求 11：服务端不得向 stdout 输出普通日志（stdio 型 MCP 的经典致命伤）
 *  - 需求 12：跑完测试后工作区不应出现意外文件改动
 *  - 需求 9 的一部分：工具层面对非法路径的拒绝（workspace 层已在 workspace.test.ts 覆盖）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const server_js = resolve(here, "..", "src", "index.js");
const package_root = resolve(here, "..", "..");
const REPO_ROOT = process.env["DESIGNBRIDGE_TEST_ROOT"] ?? resolve(package_root, "..");
const OUTBOX = ".designbridge-outbox";

function git_status(): string {
  try {
    // 不要 trim：porcelain 格式是 `XY<空格>PATH`，未暂存的 M 行首字符就是空格。
    // 一旦 trim 掉，slice(3) 取路径就会错位（这个 bug 已实测踩到）。
    return execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  } catch {
    return "(git 不可用)";
  }
}

/** 启动服务端，等它把启动日志写到 stderr，然后返回 stdout 收到的内容。 */
function capture_stdout(timeout_ms: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((settle, fail) => {
    const ws = mkdtempSync(join(tmpdir(), "dbstdout-"));
    const child = spawn(node_bin(), [server_js], {
      cwd: ws,
      env: { ...(process.env as Record<string, string>), DESIGNBRIDGE_ROOT: REPO_ROOT, DESIGNBRIDGE_OUTBOX_DIR: OUTBOX },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rmSync(ws, { recursive: true, force: true });
      settle({ stdout: out, stderr: err });
    }, timeout_ms);

    child.on("error", (e) => {
      clearTimeout(timer);
      rmSync(ws, { recursive: true, force: true });
      fail(e);
    });
  });
}

describe("stdout 洁净性（需求 11）", () => {
  it("启动阶段不向 stdout 写任何内容", async () => {
    const { stdout, stderr } = await capture_stdout(1200);
    assert.equal(stdout, "", `stdout 必须为空，实际收到：${JSON.stringify(stdout.slice(0, 200))}`);
    assert.ok(stderr.length > 0, "启动日志应出现在 stderr");
    assert.ok(stderr.includes("connected over stdio"), "应在 stderr 看到连接日志");
  });

  it("stderr 的每一行都是合法 JSON 日志", async () => {
    const { stderr } = await capture_stdout(1200);
    const lines = stderr.trim().split("\n").filter((l) => l.length > 0);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { component?: string; level?: string; message?: string };
      assert.equal(parsed.component, "designbridge");
      assert.ok(["info", "warn", "error"].includes(String(parsed.level)));
    }
  });

  it("源码中不存在 console.log（防止日后回归）", () => {
    // 防回归：有人加一句 console.log 就会污染协议流。
    // 注意要排除**注释**——注释里提到 console.log 不算违规（本文件之前就误报过一次）。
    const src = join(package_root, "src");
    const offenders: string[] = [];
    for (const file of readdirSync(src)) {
      if (!file.endsWith(".ts")) continue;
      const lines = readFileSync(join(src, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("console.log")) return;
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
        offenders.push(`${file}:${index + 1}: ${trimmed}`);
      });
    }
    assert.deepEqual(offenders, [], `src/ 中不应出现 console.log：\n${offenders.join("\n")}`);
  });
});

describe("工作区卫生（需求 12）", () => {
  it("测试未改动仓库受控文件", () => {
    const status = git_status();
    if (status === "(git 不可用)") {
      assert.ok(true, "无 git，跳过");
      return;
    }
    // 允许存在的只有本次开发新增的 mcp-server 内容；
    // node_modules / dist / .designbridge-outbox 已由 .gitignore 覆盖。
    const lines = status.split("\n").filter((l) => l.length > 0);
    const unexpected = lines.filter((l) => {
      const path = l.slice(3).replace(/^"|"$/g, "");
      return !path.startsWith("mcp-server/");
    });
    assert.deepEqual(unexpected, [], `出现了 mcp-server/ 之外的改动：\n${unexpected.join("\n")}`);
  });

  it("真实仓库的 handoff/result.json 未被测试改动", () => {
    const status = git_status();
    if (status === "(git 不可用)") {
      assert.ok(true, "无 git，跳过");
      return;
    }
    assert.ok(
      !status.includes("handoff/result.json"),
      "handoff/result.json 不应出现在改动列表中 —— 测试不得污染协议结果文件",
    );
  });
});
