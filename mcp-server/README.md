# DesignBridge MCP Server（v0.2）

DesignBridge 的**本地 MCP Server**。让支持 MCP 的 AI 编程助手直接读取设计契约与任务、
并提交结构化执行结果，而不必手工搬运文件。

- 传输：**stdio**（本地进程，最简部署）
- 不使用网络、不需要认证、不访问工作区之外的任何文件
- 只暴露四个工具，**不提供任何 shell 执行能力**

> v0.1 时本文件写的是「规划阶段、不提供可运行服务端」。本版起已可运行，
> 原文的规划内容已被下面的实际实现取代。规划中提到的 `list_verification_reports` **尚未实现**。

---

## 状态

| 项 | 值 |
|---|---|
| 版本 | 0.2.0 |
| 协议 schema | `1.0.0` |
| 传输 | stdio |
| 工具数 | 4 |
| 测试 | 63 项，全部真实执行通过 |

> 仅完成**独立服务端**。**未**修改任何 Harness 正式配置，**未**接入任何 MCP 客户端。

---

## 环境要求

- Node.js **>= 20**（开发与验证在 Node 24.18.0 上完成）
- npm（用于安装依赖）

---

## 安装与构建

```bash
cd mcp-server
npm install          # 安装依赖；lockfile 已入库，版本可复现
npm run build        # tsc 严格编译到 dist/
```

### ⚠️ 在 Android / Termux 上安装

`/storage` 是 FUSE 挂载，**不支持创建符号链接**，`npm install` 默认会因创建
`node_modules/.bin/*` 软链而失败（`EACCES`）。请改用：

```bash
npm install --no-bin-links
```

此时 `.bin` 不存在，请用完整路径调用编译器：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json
```

---

## 启动

```bash
node dist/src/index.js
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DESIGNBRIDGE_ROOT` | 自动探测 | 工作区根目录。未设置时，自当前目录向上寻找含 `protocol/manifest.json` 的目录 |
| `DESIGNBRIDGE_OUTBOX_DIR` | `.designbridge-outbox` | `submit_result` 的隔离输出目录（相对工作区根） |

服务端启动后会向 **stderr** 打印结构化日志，**stdout 只承载 MCP 协议帧**。

### 接入 MCP 客户端（示例配置）

```json
{
  "mcpServers": {
    "designbridge": {
      "command": "node",
      "args": ["/absolute/path/to/DesignBridge/mcp-server/dist/src/index.js"],
      "env": { "DESIGNBRIDGE_ROOT": "/absolute/path/to/DesignBridge" }
    }
  }
}
```

> 本文档**只是给出配置写法**。本仓库**不包含**、也**未修改**任何 Harness 配置。

---

## 工具

四个工具中，三个读取类**无入参**；路径一律来自 `manifest.json`，调用方无法指定任意路径。

### 1. `get_manifest`

读取 `protocol/manifest.json`，返回协议版本、设计版本、协议文件路径，
并逐项报告各路径**是否真实存在**（`resolved_paths`）。

错误码：`MANIFEST_MISSING`（缺失/不可读）、`MANIFEST_INVALID`（结构不符协议）。

```jsonc
// 返回（节选）
{
  "schemaVersion": "1.0.0",
  "project": "DesignBridge",
  "protocolVersion": "0.1.0",
  "designVersion": "demo-0.1",
  "paths": { "designContract": "protocol/design-contract.json", "...": "..." },
  "resolved_paths": { "designContract": true, "task": true, "result": true, "acceptance": true }
}
```

### 2. `get_design`

读取 manifest 指向的 `design-contract.json`，返回设计 ID、版本、设计 Token、布局、修改范围。

并校验 `contract.designVersion === manifest.designVersion`，**不一致直接报错**——
否则"取到的设计"与"协议声称的设计"可能不是同一份，下游无法据此验收。

错误码：`DESIGN_MISSING`、`DESIGN_INVALID`、`VERSION_MISMATCH`。

### 3. `get_task`

读取 manifest 指向的 `handoff/task.json`，返回任务 ID、状态、设计版本与执行约束，
并校验 `task.designVersion === manifest.designVersion`。

错误码：`TASK_MISSING`、`TASK_INVALID`、`VERSION_MISMATCH`。

### 4. `submit_result`

提交结构化执行结果。**这是唯一会写文件的工具。**

入参：

| 字段 | 必填 | 说明 |
|---|---|---|
| `taskId` | ✅ | 必须与工作区中的任务一致 |
| `designVersion` | ✅ | 必须与 manifest 一致 |
| `schemaVersion` | ✅ | 必须为 `1.0.0` |
| `status` | ✅ | `success` / `partial` / `blocked` / `failed` |
| `executor` | ✅ | 真实执行者标识 |
| `executedAt` | ✅ | UTC ISO-8601，如 `2026-10-13T05:02:29Z` |
| `checks[]` | — | `{id, name, status: pass/fail/skip, detail?}` |
| `artifacts[]` | — | 产物相对路径 |
| `notes` | — | 补充说明 |
| `overwrite` | — | 默认 `false`（不覆盖） |

行为：

- 校验通过后**原子写入**隔离目录（同目录临时文件 + `rename`，读方永远看不到半写入）
- 文件名：`<taskId>__<executedAt>__<4字节随机>.json`
- 写入后**立即读回校验**，不一致即报错
- **绝不**写入 `protocol` 目录下的 `handoff/result.json`
- **不执行**任何 Git 操作（commit / push / merge 一律不做）

#### 隔离目录的准入规则

`DESIGNBRIDGE_OUTBOX_DIR` **不是随便填的**。以下情况一律拒绝（`WRITE_REJECTED`）：

| 取值 | 拒绝原因 |
|---|---|
| `.` 或空 | 等同工作区根，范围过大 —— 会把协议目录整个罩住 |
| `protocol` / `handoff` | 落在协议目录上 |
| `protocol/sub` / `handoff/nested` | 落在协议目录之内 |
| `protocol/manifest.json` / `handoff/result.json` | 直接指向协议文件 |
| 任何"是协议路径上级"的目录 | 会把协议路径罩在里面 |

受保护路径由 manifest 声明的四条路径**推导**（协议文件自身 + 其所在目录），
并额外固定保护 `protocol`，避免 manifest 被改成指向别处时失去保护。

错误码：`INPUT_INVALID`、`VERSION_MISMATCH`、`WRITE_REJECTED`。

#### 校验发生在两层

1. MCP SDK 先按 `inputSchema` 在**协议层**拦掉形状错误的入参（客户端收到 `-32602`）
2. handler 再拦**跨字段一致性**（taskId / designVersion 与工作区比对）

这是刻意的双保险：协议层拦"格式"，工具层拦"事实"。

---

## 测试

```bash
npm run build
npm test
```

`npm test` 依次执行三个测试文件（**不是**用 `node --test`，原因见下）。

| 文件 | 覆盖 |
|---|---|
| `dist/tests/workspace.test.js` | 路径穿越、符号链接逃逸、原子写入、**并发竞争**（23 项） |
| `dist/tests/server.test.js` | 真实启动服务端 + SDK 客户端：initialize、listTools、四个工具、版本一致性、**隔离目录准入**、错误路径（35 项） |
| `dist/tests/hygiene.test.js` | stdout 洁净性、日志格式、工作区无意外改动（5 项） |

设置 `DESIGNBRIDGE_TEST_ROOT` 可指定被测仓库根（默认取 `mcp-server` 的上一级）。

测试**不使用 mock**：写入类用例在 `/data` 下的临时工作区副本里跑，
因此不会弄脏真实仓库；真实仓库的 `handoff/result.json` 在测试前后逐字节一致。

### 开发环境（Android/Termux）特有的三个坑

这三个都是**实测踩到**的，不是推测：

1. **`node --test <file>` 不可用**
   本环境的 Node 构建下，带 `--test` 标志会报
   `expected absolute path: "--test-concurrency=0"` 并判定失败。
   直接执行测试文件（`node dist/tests/x.test.js`）完全正常——`node:test` 在被直接执行时同样会运行。
   因此 `npm test` 采用逐个文件直接执行的方式。

2. **`process.execPath` 指向动态链接器**
   在 Android 上 `process.execPath` 返回 `/apex/com.android.runtime/bin/linker64`，
   而不是 node。用它去 `spawn` 子进程，内核会把 `.js` 当 ELF 加载，报
   `has bad ELF magic`。测试里改用 `process.argv0`（真实 node 路径）。

3. **`/storage` 不支持符号链接**
   因此「符号链接逃逸」这条安全用例必须在 `/data` 下的临时目录里跑，
   否则用例本身无法构造。

4. **`link(2)` 被平台禁止**
   `/storage` 与 `/data` 下调用 `link()` 均返回 `EACCES`（实测）。
   这堵死了"硬链接防覆盖"这一经典原子写法，因此 `overwrite: false` 改为
   `open(O_CREAT|O_EXCL)` 原子占位 + `rename` 落内容，详见 `atomic_write_text` 注释。

### 另一个真实踩到的实现坑

`src/index.ts` 判断"是否被直接执行"时，最初写成
`` import.meta.url === `file://${process.argv[1]}` ``。
`import.meta.url` 是**百分号编码**的，而字符串拼接不会编码——
本项目路径含空格与中文，两者永不相等，导致 `main()` **静默不执行**、服务端零输出。
现改用 `pathToFileURL(process.argv[1]).href` 正确比较。

---

## 安全模型

| 面 | 措施 |
|---|---|
| 路径穿越 | 拒绝绝对路径（含 Windows 盘符）、拒绝含 NUL 的路径、词法包含性检查 |
| 符号链接逃逸 | 对"最深已存在祖先"与目标自身分别 `realpath` 后再次检查包含性 |
| 任意路径读写 | 读取类工具**不接受路径参数**；读路径只能来自 `manifest.json` |
| 任意写入 | 仅 `submit_result` 可写，且只能写进隔离目录；outbox 落在协议目录内/之上、或指向协议文件，一律拒绝 |
| 半写入文件 | 同目录临时文件 + `rename` 原子替换 |
| 误覆盖 / 并发覆盖 | 默认 `overwrite: false`；用 `open(O_CREAT\|O_EXCL)` **原子占位**，并发下只有一个写者能赢，其余收到 `WRITE_TARGET_FORBIDDEN` |
| 协议流污染 | 全程只写 stderr；有回归测试禁止 `console.log` 出现在 `src/` |
| 命令执行 | **不提供任何 shell / exec 工具** |
| 敏感数据 | 不读取密钥、录音或私有项目文件；服务只认工作区内的协议文件 |
| Git 副作用 | 不 commit、不 push、不 merge |

---

## 依赖与版本

| 包 | 版本 | 用途 |
|---|---|---|
| `@modelcontextprotocol/sdk` | `1.32.1` | MCP 服务端与测试客户端 |
| `zod` | `4.6.7` | 输入/协议结构校验 |
| `typescript` | `5.9.3` | 严格类型检查（dev） |
| `@types/node` | `24.19.2` | Node 类型（dev） |

版本全部**精确锁定**，并已提交 `package-lock.json`。

**为什么不用 TypeScript 7.x**：npm 上 `latest` 是 7.x（Go 重写版）。
本项目选 5.9.3 是成熟稳定分支，降低工具链风险；后续可单独评估升级。

---

## 尚未实现 / 风险

### 未实现

- `list_verification_reports`（v0.1 规划里提到，本版未做）
- HTTP / streamable-http 传输（当前只有 stdio）
- 认证与多用户隔离（本地单用户场景下未设计）
- 结果文件的 schema 版本迁移策略（当前只认 `1.0.0`，不兼容未来版本）
- `submit_result` 未与 `verification/reports/` 目录打通

### 风险与已知取舍

1. **`outbox` 依赖环境变量**
   若把 `DESIGNBRIDGE_OUTBOX_DIR` 误设为 `handoff`，服务端会**直接拒绝**写入（已有测试覆盖），
   但这也意味着该配置错误表现为"功能不可用"而非静默污染——这是刻意的取舍。

2. **`overwrite: false` 存在极短的空文件窗口**
   平台禁用 `link()`（见上），故采用"`O_CREAT|O_EXCL` 占位 → `rename` 换内容"。
   占位与 rename 之间目标文件是空的（微秒级）；若进程**恰好在此刻被强杀**，
   会留下一个空文件。任何**可捕获**的失败路径都会清理占位，因此风险仅限硬崩溃。
   这是"保证成功时内容完整 + 绝不覆盖已有内容"与"绝不出现空壳"之间的取舍，
   本项目选了前者。

3. **同一任务没有唯一结果约束**
   文件名含随机段，并发提交会生成多个文件、互不覆盖（已有并发测试）。
   但**没有**"同一任务只应有一份结果"的协议级约束。是否需要，取决于后续协议定义。

4. **不做内容信任判断**
   工具只校验**结构**与**一致性**，不判断提交内容是否真实。
   `acceptance-rules.md` 里"禁止把模拟结果标记为成功"属于流程约束，服务端无法代为保证。

5. **仅本地可信**
   stdio + 无认证意味着**任何能启动该进程的人都能读取工作区内的协议文件并写隔离目录**。
   对公开仓库/本地单机场景可接受，若将来暴露为网络服务必须重新设计认证。

---

## 目录结构

```
mcp-server/
├── package.json          依赖与脚本（版本精确锁定）
├── package-lock.json     锁定文件
├── tsconfig.json         严格编译配置
├── .gitignore            忽略 node_modules / dist / 隔离输出目录
├── README.md             本文件
├── src/
│   ├── index.ts          MCP 服务端入口：注册工具、stdio 传输、stderr 日志
│   ├── tools.ts          四个工具的业务实现
│   ├── workspace.ts      工作区边界与安全文件访问（唯一碰文件系统的地方）
│   └── validation.ts     Zod Schema 与协议常量
└── tests/
    ├── workspace.test.ts 边界与原子写入
    ├── server.test.ts    MCP 协议层（真实进程 + SDK 客户端）
    └── hygiene.test.ts   stdout 洁净性与仓库卫生
```

> 相对任务建议的结构，**多了一个 `workspace.ts`**：
> 把"唯一允许碰文件系统"的逻辑单独隔离，路径安全检查才能保持在单点、便于审计与测试。
> 其余文件名与建议一致，未作调整。
