# DesignBridge Studio · Harness 客户端插件（v0.3a）

DeepSeek Harness 右侧栏的 DesignBridge 面板。**本阶段只做最小可行性验证**：
确认「第三方客户端插件能在 Harness 里注册一个可点击的面板」这条路走得通。

面板内容：标题、设计版本 `demo-0.1`、设计 accent 色块、一个可点击的测试按钮。

> **不在本阶段范围**：设计写回、版本管理、MCP 正式挂载、完整设计渲染。

---

## 文件结构

```
dsh-plugin/
├── package.json                   包声明：exports + dsh.bundle.patch + dsh.client
├── cordis.patch.yml               挂载声明（由安装器读取，不手写进 profile）
├── index.js                       宿主半边：空 apply()（纯客户端插件的标准形态）
├── client.js                      客户端半边：__ModuleLoader__ 工厂 + 面板组件
├── checks/
│   └── render-check.mjs           渲染冒烟检查（零依赖，用宿主 React）
└── README.md                      本文件
```

四个安装文件与官方模板 `templates/decoration/` 一一对应，只多了 `checks/` 与本文档。

---

## 构建：**本插件不需要构建**

要求里提到 tsdown。经查证，**tsdown 不是必需的**，这里说明依据与取舍：

- 官方最小模板 `templates/decoration/client.js` 就是**手写**的
  `window.__ModuleLoader__.load({ id, factory })` 包装，**没有任何打包步骤**
- 官方 `references/ui-plugin.md` 的原话是：
  > React comes from the browser module table; no duplicate React installation,
  > CDN script, or UMD search is needed.
  > **For compiled sources**, use the deployment's Client build tooling to emit this format.
  —— tsdown 是给「有 TypeScript 源码需要编译」的官方包用的

因此本插件采用**纯 ESM JavaScript**：

| 项 | 取值 | 说明 |
|---|---|---|
| React | **宿主自带的 18.3.1** | 通过 `require('react')` 从浏览器模块表取；**不安装、不打包、不重复** |
| npm 依赖 | **零** | `node_modules` 为空，没有任何 `dependencies` |
| 构建命令 | **无** | 源码即产物 |
| Cordis | 不需要显式声明 | 宿主注入 `ctx`；`package.json` 无需 `peerDependencies` |

> **若要改用 TypeScript**：需要引入 `tsdown` 与 `@deepseek-ai/cordis ~4.0.4`，
> 并产出同样格式的 `lib/client.js`。这属于后续演进，不在最小验证范围。

---

## 静态检查结果（全部真实执行）

```bash
cd dsh-plugin

# 1) 语法
node --check index.js && node --check client.js && node --check checks/render-check.mjs

# 2) 渲染冒烟检查（零依赖；React 从宿主安装目录解析）
DSH_NODE_MODULES="$DSH_HOME/node_modules" node checks/render-check.mjs
```

实测输出（17 项全过）：

```
React（宿主 createElement）: 18.3.1
渲染方式: 最小 hooks 桩 + 自写序列化（非 react-dom/server）

✅ client.js 注册了模块工厂 — id=designbridge-studio-plugin
✅ 模块 id 与包名一致
✅ 工厂可执行且返回插件对象 — inject=slots,sidebarRightTabs,locale
✅ inject 不含任何 @deepseek-ai 客户端包
✅ apply(ctx) 不抛错 — 5 项注册
✅ 注册了一个 sidebarRightTabs 类型 — id=designbridge-studio-plugin kind=designbridge
✅ 引导页提供了可打开的入口 — open
✅ 注册了 sidebar.right.pane.tab 正文，key 与类型 id 对应
✅ 未注册任何不在白名单内的 slot
✅ 每个 ctx.effect 都带标签且返回清理函数
✅ 面板可被调用并产出元素树 — 3072 字符
✅ 渲染结果包含标题与设计版本（含 demo-0.1）
✅ 渲染结果包含可点击的测试按钮
✅ UI 颜色只来自主题 token — 字面色值仅 #ED8B43（数据色块），token 引用 17 处
✅ 文案通过 locale 服务注册 — namespace=designbridgeStudio
✅ client.js 不导入任何 Harness 客户端包
✅ client.js 不含 eval / new Function / document.body 注入
```

### ⚠️ 检查的边界（不夸大）

设备上**没有安装 `react-dom`**（宿主把它直接打进 Web 前端产物了），
所以无法用 `react-dom/server` 做真实 DOM 渲染。检查改用：

- 宿主 React 的 `createElement`（纯函数）
- 一个**最小 hooks 桩**（`useState` 返回初值）
- 自写的元素树序列化

因此它证明的是：**组件能被调用、不抛错、产出的树内容与样式约束正确**。
它**不**证明：真实 DOM 属性语义、提交与副作用行为、视觉外观、主题切换表现。
那些只能在挂载后验证（见下）。

---

## 安装验证计划（**待授权，尚未执行**）

### 采用官方安装路径，不手写 profile 配置

DSH 官方技能 `cordis-plugin-development` 明确：

> Do not write the profile's `package.json` or `cordis.patch.yml` … `install_bundle` performs those steps.

所以正确做法是调用 **`plugin_manager` 工具的 `install_bundle`**，`target` 指向本目录的绝对路径，
由安装器自行完成挂载。

### 优先使用**隔离测试 profile**

为满足"不修改正式 web profile"：

1. 新建一个测试 profile（例：`studiotest`），**与正式 `web` profile 完全隔离**
2. 在测试 profile 中安装本 bundle
3. 在测试 profile 中启动 Harness 并做视觉验证
4. 验证完毕后直接删除整个测试 profile

### 若确需装进正式 profile（备选，需单独授权）

| 项 | 内容 |
|---|---|
| **将被改动的配置** | `<DSH_PROFILE_DIR>/package.json`（新增 `dsh.profile.bundles` 条目）<br>`<DSH_PROFILE_DIR>/cordis.patch.yml`（新增一行 insert）<br>`<DSH_PROFILE_DIR>/package-lock.json` / `node_modules`（由安装器管理） |
| **由谁改** | **安装器**（`install_bundle`），不是手工编辑 |
| **安装前备份** | 复制整个 `<DSH_PROFILE_DIR>` 到 `<DSH_PROFILE_DIR>.bak-<时间戳>`；<br>并记录 `cordis.patch.yml` 与 `package.json` 的 sha256 |
| **回滚步骤** | ① 首选：`plugin_manager` 卸载该 bundle<br>② 兜底：停掉 Harness，把备份目录还原回去，重启<br>③ 验证回滚：`dsh --profile web --dump-config` 不应再出现 `designbridge-studio` 行 |
| **正式 profile 的约束** | 当前要求「不修改正式 `cordis.patch.yml`」；安装器会写它，**故必须先获得授权** |

### 安装后的验证清单（挂载时执行）

| # | 验证 | 判据 |
|---|---|---|
| 1 | 安装结果 | `install_bundle` 返回 `application: applied`，无 `warnings` |
| 2 | 行已生效 | `cordis_inspect_query` 能查到 `designbridge-studio` 行 |
| 3 | 面板出现 | 右栏引导页出现 **DesignBridge** 入口；点击后打开面板 |
| 4 | 内容正确 | 面板显示标题、`demo-0.1`、accent 色块 |
| 5 | 交互可用 | 点测试按钮，计数从「尚未点击」变为「已点击 N 次」 |
| 6 | 主题一致 | 浅色/深色主题下均正常（token 驱动，不硬编码） |
| 7 | 无崩溃 | 浏览器控制台无 `slot entry crashed in 'sidebar.right.pane.tab'` |
| 8 | 卸载干净 | 卸载后入口与面板消失，配置回到安装前 |

---

## 已知兼容性风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **依赖 `dsh.client` / slots / sidebarRightTabs 的内部约定** | 官方文档明确 `dockkit` 等属"内部引擎"，任何版本都可能变；升级 DSH 可能使插件失效 | 只用了稳定面（`slots.register` / `sidebarRightTabs.register`）；失效表现为面板不出现，不会破坏 Harness |
| 2 | **无法安装 `@deepseek-ai/*` 包** | 官方硬性要求（它们可能随时变更，且抛错会**让整个 slot 条目变空白**） | 全部自绘；样式只用 `--dsw-alias-*` token |
| 3 | **`sidebar.right.pane.tab` 的注册选项字段未完全确证** | 本文用的是 `key`（依据：官方 `sidebar-right` README 与 `sidebar-browser` 的实际用法）。`templates/decoration` 用的是 `id`——但那是 `conversation.composer.dock`，**不同 slot 约定不同** | 首次挂载时若面板不出现，第一件事就是试 `id`；已记录为待验证项 |
| 4 | **`ctx.locale` 的 `register/bind` 签名未独立验证** | 取自 `sidebar-browser` 的实际调用；若签名不同，`apply` 会抛错 | 已做降级：`ctx.locale === undefined` 时跳过，直接用内置 COPY；`apply` 内不做任何丢弃性操作 |
| 5 | **React 版本绑定宿主** | 插件不锁定 React；宿主升到 React 19 时，`createElement`/`useState` 仍兼容，但若未来用 hooks 新特性需复核 | 只用了 React 18 就稳定的 API |
| 6 | **未做真实 DOM 渲染验证** | 见"检查的边界" | 挂载后按验证清单第 3–7 项执行 |
| 7 | **面板非 `keepMounted`** | 切 tab 后组件卸载、点击计数归零 | 最小验证可接受；真实面板需按官方指引决定是否 `keepMounted` |
| 8 | **`immediately: true`** | 承自官方模板；意味着 client bundle 立即加载而非惰性 | 若担心启动开销，可在挂载后改为惰性并实测 |
| 9 | **未做 i18n 完整性校验** | 已注册 `zh`/`en`，但宿主语言切换的实际表现未测 | 挂载后切换语言复核 |

---

## 边界声明

- 未修改任何 Harness 配置；未安装任何依赖（本插件零依赖）
- 未修改 `mcp-server/`；未修改 `studio/`（v0.3 的未跟踪文件原样保留）
- 未触碰 InnerRec Studio 私有仓库
- 未自动合并 PR

---

## 参考依据（均为本机 DSH 安装中的实际内容）

| 依据 | 位置 |
|---|---|
| 官方插件开发技能 | `<dsh>/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/` |
| 最小 UI 插件模板 | 同上 `templates/decoration/`（package.json / cordis.patch.yml / index.js / client.js） |
| UI 插件规范 | 同上 `references/ui-plugin.md`、`references/practices.md` |
| 右栏 tab 注册接口 | `<dsh>/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/README.zh.md` |
| 主题 token 清单 | `--dsw-alias-*`（实测 120 个）、`--dsw-font-*` |
| 活例 | `@deepseek-ai/dsh-client-ui-sidebar-browser`、`...-documentpreview` |
