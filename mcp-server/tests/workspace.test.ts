/**
 * 工作区边界与原子写入的单元测试。
 *
 * 这些用例放在 /data 下的临时目录里跑，原因是**符号链接测试必须在支持 symlink 的文件系统上**
 * （/storage 是 FUSE 挂载，创建符号链接会失败），否则"符号链接逃逸"这条根本测不到。
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WorkspaceError,
  atomic_write_text,
  isInside,
  openWorkspace,
  read_json,
  read_text,
  resolve_readable,
  to_relative,
} from "../src/workspace.js";

let base = "";

function make_workspace(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dbtest-${name}-`));
  mkdirSync(join(dir, "protocol"), { recursive: true });
  mkdirSync(join(dir, "handoff"), { recursive: true });
  writeFileSync(join(dir, "protocol", "manifest.json"), JSON.stringify({ hello: "world" }), "utf8");
  return dir;
}

before(() => {
  base = mkdtempSync(join(tmpdir(), "dbws-"));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("isInside", () => {
  it("接受根目录自身与内部路径", () => {
    assert.equal(isInside("/a/b", "/a/b"), true);
    assert.equal(isInside("/a/b", "/a/b/c/d.json"), true);
  });

  it("拒绝外部路径与前缀混淆", () => {
    assert.equal(isInside("/a/b", "/a/c"), false);
    assert.equal(isInside("/a/b", "/a/bc/d"), false, "b 与 bc 是不同的目录，字符串前缀相同不代表在内");
    assert.equal(isInside("/a/b", "/a"), false);
  });
});

describe("openWorkspace", () => {
  it("不存在时抛 WORKSPACE_NOT_FOUND", () => {
    assert.throws(
      () => openWorkspace(join(base, "nope")),
      (error: unknown) => error instanceof WorkspaceError && error.code === "WORKSPACE_NOT_FOUND",
    );
  });

  it("不是目录时抛 WORKSPACE_NOT_DIRECTORY", () => {
    const file = join(base, "a-file");
    writeFileSync(file, "x", "utf8");
    assert.throws(
      () => openWorkspace(file),
      (error: unknown) => error instanceof WorkspaceError && error.code === "WORKSPACE_NOT_DIRECTORY",
    );
  });

  it("root 会被解析成真实路径", () => {
    const dir = make_workspace("open");
    const ws = openWorkspace(dir);
    assert.ok(ws.root.length > 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("路径穿越防护", () => {
  it("拒绝绝对路径", () => {
    const dir = make_workspace("abs");
    const ws = openWorkspace(dir);
    assert.throws(
      () => resolve_readable(ws, "/etc/passwd"),
      (error: unknown) => error instanceof WorkspaceError && error.code === "ABSOLUTE_PATH_REJECTED",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("拒绝 Windows 盘符形式", () => {
    const dir = make_workspace("drive");
    const ws = openWorkspace(dir);
    assert.throws(
      () => resolve_readable(ws, "C:/Windows/win.ini"),
      (error: unknown) => error instanceof WorkspaceError && error.code === "ABSOLUTE_PATH_REJECTED",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("拒绝 ../ 穿越", () => {
    const dir = make_workspace("dotdot");
    const ws = openWorkspace(dir);
    for (const evil of ["../outside.json", "protocol/../../outside.json", "../../etc/passwd"]) {
      assert.throws(
        () => resolve_readable(ws, evil),
        (error: unknown) => error instanceof WorkspaceError && error.code === "PATH_ESCAPE",
        `${evil} 应被拒绝`,
      );
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("拒绝含 NUL 的路径", () => {
    const dir = make_workspace("nul");
    const ws = openWorkspace(dir);
    assert.throws(
      () => resolve_readable(ws, "protocol/manifest.json\0.txt"),
      (error: unknown) => error instanceof WorkspaceError && error.code === "INVALID_PATH",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("接受工作区内的正常相对路径", () => {
    const dir = make_workspace("ok");
    const ws = openWorkspace(dir);
    assert.doesNotThrow(() => resolve_readable(ws, "protocol/manifest.json"));
    assert.deepEqual(read_json(ws, "protocol/manifest.json"), { hello: "world" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("符号链接逃逸防护", () => {
  it("指向工作区外的符号链接被拒绝", () => {
    const outside = mkdtempSync(join(tmpdir(), "dbout-"));
    writeFileSync(join(outside, "secret.txt"), "SECRET", "utf8");

    const dir = make_workspace("symlink");
    // 关键：链接本身在工作区内，词法检查完全通过；只有 realpath 才能发现问题。
    symlinkSync(outside, join(dir, "escape"), "dir");

    const ws = openWorkspace(dir);
    assert.throws(
      () => resolve_readable(ws, "escape/secret.txt"),
      (error: unknown) => error instanceof WorkspaceError && error.code === "SYMLINK_ESCAPE",
      "经符号链接读到工作区外应被拒绝",
    );
    assert.throws(
      () => read_text(ws, "escape/secret.txt"),
      (error: unknown) => error instanceof WorkspaceError && error.code === "SYMLINK_ESCAPE",
    );

    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("指向工作区内的符号链接可正常读取", () => {
    const dir = make_workspace("symlink-ok");
    mkdirSync(join(dir, "real"), { recursive: true });
    writeFileSync(join(dir, "real", "ok.json"), JSON.stringify({ ok: true }), "utf8");
    symlinkSync(join(dir, "real"), join(dir, "alias"), "dir");

    const ws = openWorkspace(dir);
    assert.deepEqual(read_json(ws, "alias/ok.json"), { ok: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("符号链接写入同样被拒绝", () => {
    const outside = mkdtempSync(join(tmpdir(), "dbout2-"));
    const dir = make_workspace("symlink-write");
    symlinkSync(outside, join(dir, "escape"), "dir");

    const ws = openWorkspace(dir);
    assert.throws(
      () => atomic_write_text(ws, "escape/pwned.json", "{}"),
      (error: unknown) => error instanceof WorkspaceError && error.code === "SYMLINK_ESCAPE",
    );
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("原子写入", () => {
  it("写入成功且内容一致", () => {
    const dir = make_workspace("write");
    const ws = openWorkspace(dir);
    atomic_write_text(ws, "outbox/a.json", '{"v":1}');
    assert.equal(readFileSync(join(dir, "outbox", "a.json"), "utf8"), '{"v":1}');
    rmSync(dir, { recursive: true, force: true });
  });

  it("默认不覆盖已存在文件", () => {
    const dir = make_workspace("nooverwrite");
    const ws = openWorkspace(dir);
    atomic_write_text(ws, "outbox/a.json", '{"v":1}');
    assert.throws(
      () => atomic_write_text(ws, "outbox/a.json", '{"v":2}'),
      (error: unknown) => error instanceof WorkspaceError && error.code === "WRITE_TARGET_FORBIDDEN",
    );
    assert.equal(readFileSync(join(dir, "outbox", "a.json"), "utf8"), '{"v":1}', "原内容必须保持不变");
    rmSync(dir, { recursive: true, force: true });
  });

  it("显式 overwrite 才允许覆盖", () => {
    const dir = make_workspace("overwrite");
    const ws = openWorkspace(dir);
    atomic_write_text(ws, "outbox/a.json", '{"v":1}');
    atomic_write_text(ws, "outbox/a.json", '{"v":2}', { overwrite: true });
    assert.equal(readFileSync(join(dir, "outbox", "a.json"), "utf8"), '{"v":2}');
    rmSync(dir, { recursive: true, force: true });
  });

  it("写入后目录里不残留临时文件", () => {
    const dir = make_workspace("tmpclean");
    const ws = openWorkspace(dir);
    atomic_write_text(ws, "outbox/a.json", "{}");
    const files = readdirSync(join(dir, "outbox"));
    assert.deepEqual(files, ["a.json"], "只应有目标文件，不应有 .tmp 残留");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("to_relative", () => {
  it("输出 POSIX 风格相对路径", () => {
    const dir = make_workspace("rel");
    const ws = openWorkspace(dir);
    assert.equal(to_relative(ws, join(ws.root, "a", "b.json")), "a/b.json");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("read_json 错误", () => {
  it("文件不存在抛 NOT_FOUND", () => {
    const dir = make_workspace("missing");
    const ws = openWorkspace(dir);
    assert.throws(
      () => read_json(ws, "protocol/nope.json"),
      (error: unknown) => error instanceof WorkspaceError && error.code === "NOT_FOUND",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("JSON 损坏抛 PARSE_FAILED", () => {
    const dir = make_workspace("broken");
    writeFileSync(join(dir, "protocol", "broken.json"), "{not json", "utf8");
    const ws = openWorkspace(dir);
    assert.throws(
      () => read_json(ws, "protocol/broken.json"),
      (error: unknown) => error instanceof WorkspaceError && error.code === "PARSE_FAILED",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("真实协议文件可读", () => {
  it("可以读取仓库自带的 protocol/manifest.json", () => {
    const repo_root = process.env["DESIGNBRIDGE_TEST_ROOT"];
    if (repo_root === undefined || repo_root.length === 0) {
      assert.ok(true, "未设置 DESIGNBRIDGE_TEST_ROOT，跳过");
      return;
    }
    const ws = openWorkspace(repo_root);
    const manifest = read_json(ws, "protocol/manifest.json") as { project?: unknown };
    assert.equal(manifest.project, "DesignBridge");
  });
});

