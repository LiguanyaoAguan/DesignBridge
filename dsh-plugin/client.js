/**
 * DesignBridge Studio —— Client（浏览器）半边。
 * v0.3b / b-1：**真实** design-contract.json 只读加载与错误状态展示。
 *
 * 形态说明（对齐官方 `templates/decoration/` 与 `references/ui-plugin.md`）：
 * - 用 `window.__ModuleLoader__.load({ id, factory })` 注册**惰性工厂**，
 *   `id` 必须等于包名；宿主把它经 `/plugins` 提供给浏览器，按需物化。
 * - React 来自**浏览器模块表**（`require('react')`），用的是宿主自己的 React 18。
 *   因此本插件**不需要安装 React、不需要打包器、不需要 npm 依赖**——零构建。
 * - **不导入任何 `@deepseek-ai/*` 客户端包**：官方明确要求。宿主服务一律经 `ctx` 取用。
 * - 样式只用宿主主题 token（`--dsw-alias-*` / `--dsw-font-*`）。
 *
 * b-1 的数据来源：
 * - `ctx.remote.workspaceFiles.read(sessionId, path, { offset, limit }, signal)`
 *   —— 宿主自带的工作区文件服务，**只提供读操作，没有任何写方法**。
 * - `sessionId` 由 slot 的 `inject` 回调直接给出（`(sessionId, actions) => props`），
 *   与官方 `dsh-client-ui-sidebar-documentpreview` 的用法一致。
 *
 * b-1 **刻意不做**：组件树渲染、编辑、写回、版本管理、审批、自动刷新（`changes()`）。
 *
 * ⚠️ 数据可信度原则：面板上出现的每一个数值，都必须来自**一次成功的真实读取**。
 * 任何失败/缺失一律进入**显式错误态**，**绝不用演示值冒充真实数据**。
 */

window.__ModuleLoader__.load({
  id: 'designbridge-studio-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // —— 身份：id 必须与包名一致；kind 是 tab 类型名；key 用 id ——
    const TAB_ID = 'designbridge-studio-plugin';
    const TAB_KIND = 'designbridge';
    const NAMESPACE = 'designbridgeStudio';

    /**
     * 设计根目录：**相对于会话工作区根**的路径。
     *
     * ⚠️ 必须用工作区相对路径，**不能**硬编码 Android 绝对路径——绝对路径换设备即失效，
     * 而且 `workspaceFiles` 的路径解析基准就是工作区根（不是仓库根，也不是进程 cwd）。
     *
     * ⚠️ 部署时**必须按自己的目录结构**调整本常量：它相对的是**会话工作区根**，
     * 而设计仓库通常位于工作区下的某个子目录（例如 `GitHub项目下载/DesignBridge`）。
     *
     * b-1 先用常量（显式、可审阅、可改）；后续阶段再做成设置项。
     */
    const DESIGN_ROOT = 'GitHub项目下载/DesignBridge';

    /** 设计契约相对 designRoot 的路径（与 manifest.json 声明的 paths.designContract 一致）。 */
    const CONTRACT_RELATIVE = 'protocol/design-contract.json';

    /**
     * 交付校验索引：**相对于会话工作区根**的路径。
     *
     * ⚠️ 与 `DESIGN_ROOT` **同一基准**（工作区根），因此**不带** DESIGN_ROOT 前缀 ——
     * 与 preview 的路径规则不同，别照抄。
     *
     * 该文件由 `scripts/delivery-sync.mjs` 写入"运行时目录"。运行时目录刻意放在
     * **仓库之外**（避免污染 Git 工作区），但仍在**工作区之内** —— 面板因此能用
     * 现有的 `remote.workspaceFiles.read` 通道直接读到它，**零新增管道、零新增依赖**。
     *
     * ⚠️ 部署时须与 `DESIGN_ROOT` 一起按自己的目录结构调整。若把运行时目录移出工作区，
     * 本面板将读不到索引（表现为"尚未同步"错误态，而不会显示假数据）。
     */
    const INDEX_RELATIVE = 'GitHub项目下载/.designbridge-runtime/state/delivery-index.json';

    /** 校验失败时最多在面板上列出多少条路径化错误。 */
    const INDEX_MAX_ERRORS = 5;

    /**
     * 是否允许**保守地**自动打开 DesignBridge 面板。
     *
     * 为什么需要它：本插件注册的是**右栏 tab 类型**，而 Harness 的默认界面是会话页；
     * 右栏默认收起、也没有任何东西会自动打开这个 tab —— 于是"装好了却看不见"。
     * 官方 README 明确认可这种自动打开：
     *   「计划审阅的自动打开通过绑定的 hook 读取 `mounted`」
     * 参考实现：dsh-client-ui-plan 的 PlanReviewOpen。
     *
     * ⚠️ **保守条件（三重）**，全部满足才打开：
     *   ① 该会话此前未处理过（手动关闭后不再弹出）；
     *   ② 该会话的右栏**当前没有任何已打开 tab**（不抢占用户正在用的面板）；
     *   ③ `openTabs` 这一公开 API **可用** —— 拿不到就**默认不打开**（不猜）。
     *
     * 置 false 即可彻底关闭（面板仍可在右栏引导页里手动打开）。
     */
    const AUTO_OPEN_TAB = true;
    /** store 尚未 mint 时的重试间隔；`openTab` 此时会抛 "no session surface is mounted"。 */
    const AUTO_OPEN_RETRY_MS = 600;
    /** 单个会话最多尝试次数，避免无界重试。 */
    const AUTO_OPEN_MAX_ATTEMPTS = 6;

    /** 自动打开的最近一次诊断（成功/失败），显示在面板里便于排查。 */
    let autoOpenDiag = '';

    /**
     * Preview 组件类型白名单 —— **本文件内唯一的一份**。
     * ⚠️ 必须与 `src/model/preview-schema.mjs` 的 COMPONENT_TYPES 同步；
     * 二者由 `checks/render-check.mjs` 的「内联副本同步性」用例强制校验
     * （历史上这里曾出现多份互相不同步的副本，导致协议加了组件却渲染不出来）。
     */
    const PREVIEW_COMPONENT_TYPES = Object.freeze(['frame','text','button','card','list','list-item','badge','divider','image-placeholder','icon','image','input','chip']);

    /** `read` 每页最多行数上限（宿主 workspaceFiles 的 maxLines 默认为 5000）。 */
    const PAGE_MAX_LINES = 5000;
    /** 分页安全上限：防止异常数据导致无限循环。5000 × 20 = 10 万行，远超任何设计契约。 */
    const PAGE_MAX_PAGES = 20;
    const PREVIEW_MAX_BYTES = 512 * 1024;

    const COPY = {
      zh: {
        'type.label': 'DesignBridge',
        'guide.title': 'DesignBridge',
        'guide.description': '只读查看设计契约',
        'panel.heading': 'DesignBridge Studio',
        'panel.subheading': '真实 Preview 只读可视化 · b-3',
        'panel.refresh': '重新读取',
        'panel.autoOpenLabel': '自动打开',
        'panel.loading': '正在读取设计契约与真实 Preview…',
        'panel.sourceHeading': '数据来源',
        'panel.previewHeading': 'Preview 数据来源',
        'panel.previewPath': 'Preview 路径',
        'panel.previewSourceHeading': 'Preview 数据来源',
        'panel.pagePrev': '上一页',
        'panel.pageNext': '下一页',
        'panel.selectionHeading': '组件属性',
        'panel.selectHint': '点击画布中的组件查看属性。',
        'panel.noPage': 'Preview 页面数据不可用。',
        'panel.sourcePath': '相对路径',
        'panel.sourceAbsolute': '解析后绝对路径',
        'panel.sourceVersion': '文件版本',
        'panel.sourceBytes': '字节数',
        'panel.sourceLines': '行数',
        'panel.sourceReadAt': '读取时间',
        'panel.contractHeading': '设计契约字段（真实值）',
        'panel.designId': 'designId',
        'panel.designVersion': 'designVersion',
        'panel.schemaVersion': 'schemaVersion',
        'panel.platform': 'platform',
        'panel.screenId': 'screenId',
        'panel.description': 'description',
        'panel.tokens': 'designTokens',
        'panel.orientation': 'layout.orientation',
        'panel.regions': 'layout.regions',
        'panel.allowed': 'changeScope.allowed',
        'panel.protected': 'changeScope.protected',
        'panel.referenceAssets': 'referenceAssets',
        'panel.none': '（空）',
        'panel.items': '{n} 项',
        'panel.errHeading': '无法读取真实设计契约或 Preview',
        'panel.errHint': '面板不会用演示数据替代。请按下列信息排查。',
        'panel.errCode': '宿主错误码',
        'panel.errDetail': '详情',
        'panel.retry': '重试',
        'panel.validationHeading': '交付校验',
        'panel.validationOk': '校验通过',
        'panel.validationFail': '校验失败',
        'panel.validationVersion': '设计版本',
        'panel.validationCommit': '来源 commit',
        'panel.validationErrors': '错误数',
        'panel.validationNone': '该设计在交付索引中还没有记录。',
        'panel.validationMissing': '尚未同步：读不到交付索引。请先运行 scripts/delivery-sync.mjs。',
        'panel.validationParse': '交付索引 JSON 解析失败。',
        'panel.validationMismatch': '交付索引中没有当前 designId 的记录。',
        'panel.validationErrorsHeading': '校验错误（前 {n} 条）',
        'panel.validationPreserved': '上一个有效交付仍保留（commit {commit}）',
        'err.no-session': '当前没有会话上下文，无法定位工作区。请在某个会话内打开本面板。',
        'err.bad-path':
          '路径非法。designRoot 必须是**工作区相对路径**（不能是绝对路径、URL，也不能含 NUL）。',
        'err.not-found': '文件不存在。请核对 designRoot 与协议路径是否正确。',
        'err.forbidden': '没有读取权限，或者该路径不在允许范围内。',
        'err.not-text': '该文件不是可读的 UTF-8 文本。',
        'err.too-large': '文件超出宿主单次读取上限，b-1 不支持分块拼装。',
        'err.read-failed': '读取失败。',
        'err.preview-parse': 'Preview JSON 解析失败。',
        'err.preview-schema': 'Preview 与 Schema 或 contract 不匹配。',
        'err.parse': 'JSON 解析失败。',
        'err.parseWhere': '位置',
        'err.schema': '不符合 design-contract v1 协议（校验未通过）。',
        'err.schemaList': '校验问题',
      },
      en: {
        'type.label': 'DesignBridge',
        'guide.title': 'DesignBridge',
        'guide.description': 'Read-only view of the design contract',
        'panel.heading': 'DesignBridge Studio',
        'panel.subheading': 'Read-only visual preview from real preview.json - b-3',
        'panel.refresh': 'Reload',
        'panel.autoOpenLabel': 'Auto-open',
        'panel.loading': 'Reading design contract and real preview...',
        'panel.sourceHeading': 'Data source',
        'panel.previewHeading': 'Preview source',
        'panel.previewPath': 'Preview path',
        'panel.previewSourceHeading': 'Preview data source',
        'panel.pagePrev': 'Previous page',
        'panel.pageNext': 'Next page',
        'panel.selectionHeading': 'Component properties',
        'panel.selectHint': 'Select a canvas component to inspect its properties.',
        'panel.noPage': 'Preview page data is unavailable.',
        'panel.sourcePath': 'Relative path',
        'panel.sourceAbsolute': 'Resolved absolute path',
        'panel.sourceVersion': 'File version',
        'panel.sourceBytes': 'Bytes',
        'panel.sourceLines': 'Lines',
        'panel.sourceReadAt': 'Read at',
        'panel.contractHeading': 'Contract fields (real values)',
        'panel.designId': 'designId',
        'panel.designVersion': 'designVersion',
        'panel.schemaVersion': 'schemaVersion',
        'panel.platform': 'platform',
        'panel.screenId': 'screenId',
        'panel.description': 'description',
        'panel.tokens': 'designTokens',
        'panel.orientation': 'layout.orientation',
        'panel.regions': 'layout.regions',
        'panel.allowed': 'changeScope.allowed',
        'panel.protected': 'changeScope.protected',
        'panel.referenceAssets': 'referenceAssets',
        'panel.none': '(empty)',
        'panel.items': '{n} item(s)',
        'panel.errHeading': 'Cannot read the real design contract or preview',
        'panel.errHint': 'This panel never substitutes demo data. Use the details below.',
        'panel.errCode': 'Host error code',
        'panel.errDetail': 'Detail',
        'panel.retry': 'Retry',
        'panel.validationHeading': 'Delivery validation',
        'panel.validationOk': 'Validation passed',
        'panel.validationFail': 'Validation failed',
        'panel.validationVersion': 'Design version',
        'panel.validationCommit': 'Source commit',
        'panel.validationErrors': 'Errors',
        'panel.validationNone': 'No record for this design in the delivery index yet.',
        'panel.validationMissing': 'Not synced: the delivery index is unreadable. Run scripts/delivery-sync.mjs first.',
        'panel.validationParse': 'Delivery index JSON failed to parse.',
        'panel.validationMismatch': 'The delivery index has no record for the current designId.',
        'panel.validationErrorsHeading': 'Validation errors (first {n})',
        'panel.validationPreserved': 'Previous valid delivery is preserved (commit {commit})',
        'err.no-session': 'No session context; cannot resolve the workspace. Open this panel inside a session.',
        'err.bad-path':
          'Invalid path. designRoot must be a workspace-relative path (not absolute, not a URL, no NUL).',
        'err.not-found': 'File not found. Check designRoot and the protocol path.',
        'err.forbidden': 'No read permission, or the path is outside the allowed scope.',
        'err.not-text': 'The file is not readable UTF-8 text.',
        'err.too-large': 'File exceeds the host read limit; b-1 does not stitch chunks.',
        'err.read-failed': 'Read failed.',
        'err.preview-parse': 'Preview JSON parsing failed.',
        'err.preview-schema': 'Preview does not match its schema or contract.',
        'err.parse': 'JSON parse failed.',
        'err.parseWhere': 'At',
        'err.schema': 'Does not satisfy the design-contract v1 protocol.',
        'err.schemaList': 'Validation issues',
      },
    };

    /**
     * 样式：**只引用宿主主题 token**。不硬编码 UI 颜色。
     * 设计数据里的颜色值（如 accent）以**色块**呈现，属 artwork 而非界面装饰。
     */
    const CSS = `
.db-studio-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  box-sizing: border-box;
  padding: 16px;
  overflow: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 1.5;
}
.db-studio-head { display: flex; flex-direction: column; gap: 2px; }
.db-studio-titlerow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.db-studio-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.db-studio-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.db-studio-card {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-l1);
}
.db-studio-card[data-tone="error"] { border-color: var(--dsw-alias-state-error-primary); }
.db-studio-cardhead {
  font-size: 12px; font-weight: 600; letter-spacing: .02em;
  color: var(--dsw-alias-label-secondary); text-transform: none;
}
.db-studio-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.db-studio-key { color: var(--dsw-alias-label-secondary); flex: none; }
.db-studio-value {
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
  min-width: 0;
}
.db-studio-mono { font-family: var(--dsw-font-family); letter-spacing: .01em; }
.db-studio-swatch {
  display: inline-block; width: 18px; height: 18px; border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l2);
  vertical-align: -4px; margin-right: 8px;
}
.db-studio-chip {
  display: inline-block; padding: 1px 8px; margin: 0 4px 4px 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px; font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.db-studio-button {
  appearance: none; align-self: flex-start;
  padding: 8px 14px; border: 1px solid transparent; border-radius: 8px;
  cursor: pointer; font: inherit;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
}
.db-studio-button:hover { background: var(--dsw-alias-button-primary-hover); }
.db-studio-button:active { transform: translateY(1px); }
.db-studio-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.db-studio-button[disabled] { opacity: .5; cursor: default; }
.db-studio-state { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.db-studio-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.db-studio-err { color: var(--dsw-alias-state-error-primary); }
.db-preview-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.db-preview-pages { max-width:100%; }
.db-preview-layout { display:grid; grid-template-columns:minmax(0,1fr); gap:10px; min-width:0; }
.db-preview-viewport { max-width:100%; overflow:auto; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-base); padding:8px; }
.db-preview-page { position:relative; box-sizing:border-box; overflow:auto; background:var(--db-canvas-bg,var(--dsw-alias-bg-l1)); color:var(--db-text-primary,var(--dsw-alias-label-primary)); border:1px solid var(--db-border,var(--dsw-alias-border-l2)); border-radius:var(--db-radius-window,8px); transform-origin:top left; }
.db-preview-page-title { position:sticky; top:0; z-index:2; padding:5px 8px; background:var(--db-canvas-bg,var(--dsw-alias-bg-l1)); color:var(--db-text-secondary,var(--dsw-alias-label-secondary)); font-size:11px; }
.db-preview-node { box-sizing:border-box; min-width:0; cursor:pointer; outline:1px solid transparent; border-radius:6px; color:inherit; }
.db-preview-node:hover { outline:1px dashed var(--dsw-alias-brand-primary); }
.db-preview-node.is-selected { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.db-preview-frame { width:100%; }
.db-preview-card { padding:10px; border:1px solid var(--db-border,var(--dsw-alias-border-l2)); background:var(--db-surface,var(--dsw-alias-bg-base)); border-radius:var(--db-radius-card,10px); display:flex; flex-direction:column; gap:6px; }
.db-preview-card > strong { font-size:14px; }
.db-preview-card > small,.db-preview-listitem small { color:var(--db-text-secondary,var(--dsw-alias-label-secondary)); }
.db-preview-list { display:flex; flex-direction:column; gap:4px; min-width:120px; }
.db-preview-listitem { display:flex; flex-wrap:wrap; justify-content:space-between; gap:4px; padding:7px; border:1px solid var(--db-border,var(--dsw-alias-border-l2)); background:var(--db-surface,var(--dsw-alias-bg-base)); border-radius:var(--db-radius-card,0); }
.db-preview-text { overflow-wrap:anywhere; color:var(--db-text-primary,inherit); }
.db-preview-text[data-db-tone="secondary"] { color:var(--db-text-secondary,var(--dsw-alias-label-secondary)); }
.db-preview-text[data-db-tone="tertiary"] { color:var(--db-text-secondary,var(--dsw-alias-label-tertiary)); }
.db-preview-button { align-self:flex-start; border:1px solid var(--db-border,var(--dsw-alias-border-l2)); border-radius:var(--db-radius-button,7px); padding:6px 10px; background:var(--db-surface,var(--dsw-alias-bg-base)); color:var(--db-text-primary,var(--dsw-alias-label-primary)); }
.db-preview-button[data-db-variant="primary"] { background:var(--db-accent,var(--dsw-alias-button-primary-fill)); border-color:var(--db-accent,var(--dsw-alias-border-l2)); color:var(--db-accent-ink,var(--dsw-alias-label-primary-inverted)); font-weight:600; }
.db-preview-button[data-db-variant="ghost"] { background:transparent; border-color:transparent; color:var(--db-text-secondary,var(--dsw-alias-label-secondary)); }
.db-preview-button.is-disabled { opacity:.55; }
.db-preview-badge { align-self:flex-start; border-radius:var(--db-radius-button,999px); padding:2px 8px; background:var(--dsw-alias-bg-l2); color:var(--db-text-secondary,var(--dsw-alias-label-secondary)); }
.db-preview-badge[data-db-tone="primary"] { background:var(--db-accent-soft,var(--dsw-alias-bg-l2)); color:var(--db-accent,var(--dsw-alias-label-secondary)); }
.db-preview-badge[data-db-tone="success"] { background:var(--db-success-soft,var(--dsw-alias-bg-l2)); color:var(--db-success,var(--dsw-alias-state-success-primary)); }
.db-preview-divider { height:1px; width:100%; background:var(--db-border,var(--dsw-alias-border-l2)); }
.db-preview-image-placeholder { min-height:80px; display:grid; place-items:center; border:1px dashed var(--db-border,var(--dsw-alias-border-l2)); border-radius:var(--db-radius-card,0); background:var(--db-surface,transparent); color:var(--db-text-secondary,var(--dsw-alias-label-tertiary)); }
.db-preview-button[data-db-variant="secondary"] { background:var(--db-surface,var(--dsw-alias-bg-base)); border-color:var(--db-border,var(--dsw-alias-border-l2)); color:var(--db-text-primary,var(--dsw-alias-label-primary)); }
.db-preview-icon { display:inline-block; object-fit:contain; flex:none; vertical-align:middle; }
.db-preview-icon[data-db-align="center"] { align-self:center; }
.db-preview-icon[data-db-align="end"] { align-self:flex-end; }
.db-preview-icon[data-db-tone="secondary"] { opacity:.78; }
.db-preview-icon[data-db-tone="tertiary"] { opacity:.5; }
.db-preview-asset-missing { display:inline-grid; place-items:center; border:1px dashed var(--dsw-alias-state-error-primary); border-radius:6px; color:var(--dsw-alias-state-error-primary); font-size:11px; line-height:1; }
.db-preview-image { display:block; width:100%; min-height:60px; border-radius:var(--db-radius-card,0); background:var(--db-surface,transparent); }
.db-preview-image[data-db-fit="cover"] { object-fit:cover; }
.db-preview-image[data-db-fit="contain"] { object-fit:contain; }
.db-preview-image.db-preview-asset-missing { display:grid; place-items:center; min-height:80px; padding:8px; border:1px dashed var(--dsw-alias-state-error-primary); border-radius:var(--db-radius-card,0); color:var(--dsw-alias-state-error-primary); }
.db-preview-input { display:flex; align-items:center; gap:8px; padding:9px 12px; border:1px solid var(--db-border,var(--dsw-alias-border-l2)); border-radius:var(--db-radius-pill,10px); background:var(--db-surface,var(--dsw-alias-bg-base)); color:var(--db-text-secondary,var(--dsw-alias-label-secondary)); }
.db-preview-input[data-db-state="focused"] { border-color:var(--db-accent,var(--dsw-alias-brand-primary)); }
.db-preview-input[data-db-state="disabled"] { opacity:.55; }
.db-preview-input[data-db-filled="true"] .db-preview-input-text { color:var(--db-text-primary,var(--dsw-alias-label-primary)); }
.db-preview-input-text { flex:1 1 auto; min-width:0; }
.db-preview-chip { align-self:flex-start; padding:4px 11px; border:1px solid var(--db-border,var(--dsw-alias-border-l2)); border-radius:var(--db-radius-pill,999px); background:var(--db-surface,var(--dsw-alias-bg-base)); color:var(--db-text-secondary,var(--dsw-alias-label-secondary)); }
.db-preview-chip[data-db-state="selected"] { background:var(--db-accent-soft,var(--dsw-alias-bg-l2)); border-color:var(--db-accent-soft,var(--dsw-alias-border-l2)); color:var(--db-accent,var(--dsw-alias-label-primary)); }
.db-preview-chip[data-db-state="disabled"] { opacity:.5; }
.db-preview-listitem[data-db-selected="true"] { background:var(--db-accent-soft,var(--dsw-alias-bg-l2)); border-color:var(--db-accent-soft,var(--dsw-alias-border-l2)); }
.db-preview-listitem-icon { flex:none; border-radius:6px; }
.db-preview-listitem-text { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1 1 55%; }
.db-preview-listitem-meta { flex:0 1 auto; }
.db-preview-card[data-db-elevation="sm"] { box-shadow:0 1px 2px var(--dsw-alias-border-l2); }
.db-preview-card[data-db-elevation="md"] { box-shadow:0 4px 14px var(--dsw-alias-border-l2); }
.db-preview-selection { min-width:0; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; padding:10px; overflow-wrap:anywhere; }
.db-preview-selection h3 { margin:0 0 6px; font-size:13px; }
.db-preview-selection dl { display:grid; grid-template-columns:65px minmax(0,1fr); gap:4px; margin:0; font-size:11px; }
.db-preview-selection dt { color:var(--dsw-alias-label-secondary); }
.db-preview-selection dd { margin:0; min-width:0; }
.db-preview-selection pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; font:inherit; }
@media (min-width:900px) { .db-preview-layout { grid-template-columns:minmax(0,2fr) minmax(180px,1fr); } }
.db-studio-pre {
  margin: 0; padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary);
}
.db-validation {
  display: flex; flex-direction: column; gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-left-width: 3px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-l1);
}
.db-validation[data-tone="ok"] { border-left-color: var(--dsw-alias-state-success-primary); }
.db-validation[data-tone="error"] { border-left-color: var(--dsw-alias-state-error-primary); }
.db-validation[data-tone="none"] { border-left-color: var(--dsw-alias-border-l2); }
.db-validation-head { font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); }
.db-validation-status { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.db-validation[data-tone="ok"] .db-validation-status { color: var(--dsw-alias-state-success-primary); }
.db-validation[data-tone="error"] .db-validation-status { color: var(--dsw-alias-state-error-primary); }
.db-validation-errors { margin: 0; padding-left: 18px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.db-validation-errors li { overflow-wrap: anywhere; }
`;

    // ── 文案 ────────────────────────────────────────────────────────────────
    let translate = (key) => COPY.zh[key] ?? key;

    function useTranslate() {
      return translate;
    }

    // ── ① Source 层：只负责"把文本拿到手"，不理解 JSON 结构、不碰 React ──────

    /** 判断一个路径是否合法的**工作区相对路径**（与 workspaceFiles 的路径纪律一致）。 */
    function isWorkspaceRelativePath(path) {
      if (typeof path !== 'string' || path.length === 0 || path.startsWith('/')) return false;
      if (path.includes('\0') || path.includes('\\')) return false;
      if (path.startsWith('/')) return false; // 绝对路径
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false; // URL scheme
      if (path.split('/').some((seg) => seg === '..')) return false; // 越出工作区
      return true;
    }

    /** 把宿主错误码归类到面板的显式错误态。永远同时保留原始码。 */
    function classifyReadError(code, message) {
      const c = String(code ?? '').toLowerCase();
      const m = String(message ?? '').toLowerCase();
      if (c.includes('lookup-not-found')) return 'no-session';
      if (c.includes('not-text')) return 'not-text';
      if (c.includes('too-large') || c.includes('too_large')) return 'too-large';
      if (c.includes('bad-request')) return 'bad-path';
      if (c.includes('not-found') || m.includes('enoent') || m.includes('no such file')) return 'not-found';
      if (c.includes('permission') || c.includes('denied') || c.includes('forbidden')) return 'forbidden';
      if (m.includes('eacces') || m.includes('eperm')) return 'forbidden';
      if (c.includes('abort')) return 'read-failed';
      return 'read-failed';
    }

    /**
     * 读取工作区内的一个文本文件（按行分页拼装到 EOF）。
     *
     * @returns {{ ok: true, text: string, source: object } | { ok: false, kind: string, code?: string, detail?: string }}
     */
    async function readWorkspaceText(remote, sessionId, relativePath, signal) {
      if (sessionId === undefined || sessionId === null || sessionId === '') {
        return { ok: false, kind: 'no-session' };
      }
      if (!isWorkspaceRelativePath(relativePath)) {
        return { ok: false, kind: 'bad-path', detail: relativePath };
      }
      if (remote === undefined || remote === null || remote.workspaceFiles === undefined) {
        return { ok: false, kind: 'read-failed', detail: 'remote.workspaceFiles 不可用' };
      }

      const parts = [];
      let offset = 1;
      let last = null;

      for (let page = 0; page < PAGE_MAX_PAGES; page += 1) {
        let result;
        try {
          result = await remote.workspaceFiles.read(sessionId, relativePath, {
            offset,
            limit: PAGE_MAX_LINES,
          }, signal);
        } catch (error) {
          return { ok: false, kind: 'read-failed', detail: String(error && error.message ? error.message : error) };
        }

        if (result === undefined || result === null || result.ok !== true) {
          const err = (result && result.error) || {};
          return {
            ok: false,
            kind: classifyReadError(err.code, err.message),
            code: err.code,
            detail: err.message,
          };
        }

        const value = result.value || {};
        parts.push(typeof value.text === 'string' ? value.text : '');
        last = value;

        if (value.eof === true) {
          return {
            ok: true,
            text: parts.join('\n'),
            source: {
              relativePath,
              absolutePath: value.absolutePath,
              version: value.version,
              bytes: value.bytes,
              lines: value.lines,
              pages: page + 1,
            },
          };
        }
        // 下一页：offset 是 1 起算的行号
        offset = (typeof value.offset === 'number' ? value.offset : offset) + PAGE_MAX_LINES;
      }

      return { ok: false, kind: 'too-large', detail: `超过 ${PAGE_MAX_PAGES} 页仍未读完` };
    }

    // ── ② Model 层：把文本变成可信数据（纯函数、无 React、无 IO）──────────────

    function isNonEmptyString(v) {
      return typeof v === 'string' && v.length > 0;
    }
    function isStringArray(v) {
      return Array.isArray(v) && v.every((x) => typeof x === 'string');
    }

    /** Canonical b-2 schema and contract checks, kept inline for the one-file Harness loader. */
    function validatePreviewText(text, contract) {
      if (typeof text !== 'string') return { ok: false, errors: [{ code: 'type-mismatch', path: '$', message: 'preview 输入必须是字符串' }] };
      let byteLength;
      try { byteLength = new TextEncoder().encode(text).byteLength; }
      catch { return { ok: false, errors: [{ code: 'type-mismatch', path: '$', message: '无法计算 UTF-8 字节长度' }] }; }
      if (byteLength > PREVIEW_MAX_BYTES) return { ok: false, errors: [{ code: 'input-too-large', path: '$', message: `UTF-8 字节数超过 ${PREVIEW_MAX_BYTES}` }] };
      let value;
      try { value = JSON.parse(text); }
      catch { return { ok: false, errors: [{ code: 'invalid-json', path: '$', message: 'JSON 语法无效' }] }; }
      const result = validatePreviewWithContract(value, contract);
      return result.ok ? result : { ...result, errors: result.errors.map(issue => ({ code: issue.code ?? 'invalid-value', path: issue.path, message: issue.message })) };
    }

    function validatePreviewWithContract(value, contract) {
      const errors = [];
      const add = (path, message, code = 'invalid-value') => { if (errors.length < 50) errors.push({ code, path, message }); else errors.truncatedErrors = true; };
      const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
      if (!obj(value)) return { ok: false, errors: [{ code: 'type-mismatch', path: '$', message: 'preview 必须是对象' }] };
      if (Object.keys(value).some(k => !['previewSchemaVersion','designId','designVersion','pages'].includes(k))) add('$', '包含未知字段', 'unknown-field');
      if (!Object.prototype.hasOwnProperty.call(value, 'previewSchemaVersion')) add('$.previewSchemaVersion', '缺少必填字段', 'required-field');
      else if (value.previewSchemaVersion !== '1.0.0') add('$.previewSchemaVersion', '不支持的 Preview Schema 版本', 'unsupported-version');
      for (const key of ['designId','designVersion']) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) add(`$.${key}`, '缺少必填字段', 'required-field');
        else if (typeof value[key] !== 'string') add(`$.${key}`, '必须是字符串', 'type-mismatch');
        else if (!value[key].length || Array.from(value[key]).length > 128) add(`$.${key}`, '字符串长度必须为1–128个 Unicode 码点');
      }
      if (errors.truncatedErrors) return { ok: false, errors, truncatedErrors: true };
      if (!Array.isArray(value.pages)) add('$.pages', 'pages 必须是数组', 'type-mismatch');
      else if (value.pages.length < 1 || value.pages.length > 32) add('$.pages', 'pages 数量必须为 1–32', 'limit-exceeded');
      if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 32) return { ok: false, errors };
      if (value.designId !== contract.designId) add('$.designId', '与 contract.designId 不一致');
      if (value.designVersion !== contract.designVersion) add('$.designVersion', '与 contract.designVersion 不一致');
      const walk = (n, path, depth, parent, context) => {
        if (errors.truncatedErrors) return;
        if (!obj(n)) { add(path, '组件节点必须是对象', 'type-mismatch'); return; }
        if (Object.keys(n).some(k => !['id','type','props','layout','children'].includes(k))) add(path, '包含未知字段', 'unknown-field');
        if (typeof n.id !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(n.id) || context.ids.has(n.id)) add(`${path}.id`, 'ID 格式非法或重复', context.ids.has(n.id) ? 'duplicate-node-id' : 'invalid-value'); else context.ids.add(n.id);
        context.count += 1;
        if (context.count > 2000) { add(path, '每页节点数超过 2000', 'limit-exceeded'); return; }
        if (depth > 12) { add(path, '树深度超过 12', 'limit-exceeded'); return; }
        // ⚠️ 这份内联表必须与 src/model/preview-schema.mjs **保持同步**：
        //    client.js 是经典单文件插件，无法 import 模块，故此处是刻意的副本。
        const types = PREVIEW_COMPONENT_TYPES;
        if (!types.includes(n.type)) { add(`${path}.type`, '未知组件类型', 'unknown-component-type'); return; }
        const specs = { frame:['direction','layoutMode','gap','padding'], text:['text','size','weight','tone'], button:['label','variant','disabled'], card:['title','subtitle','elevation'], list:['dense'], 'list-item':['label','subtitle','meta','trailing','asset','selected'], badge:['label','tone'], divider:[], 'image-placeholder':['label'], icon:['asset','size','tone','align','label'], image:['asset','fit','alt'], input:['placeholder','value','kind','state'], chip:['label','state','tone'] };
        if (!obj(n.props)) { add(`${path}.props`, 'props 必须是对象', 'type-mismatch'); return; }
        if (Object.keys(n.props).some(k => !specs[n.type].includes(k))) add(`${path}.props`, '包含未知 props 字段', 'unknown-field');
        const requiredProps = { frame:['direction','layoutMode'], text:['text'], button:['label'], card:['title'], list:[], 'list-item':['label'], badge:['label'], divider:[], 'image-placeholder':['label'], icon:['asset'], image:['asset'], input:['placeholder'], chip:['label'] }[n.type];
        for (const key of requiredProps) if (!(key in (n.props || {}))) add(`${path}.props.${key}`, '缺少必填属性');
        for (const [key, val] of Object.entries(n.props || {})) if (typeof val === 'string' && Array.from(val).length > 4096) add(`${path}.props.${key}`, '字符串超过 4096 个码点');
        const p = n.props || {};
        const enums = { 'frame.direction':['row','column'], 'frame.layoutMode':['flow','absolute'], 'text.weight':['normal','medium','semibold','bold'], 'text.tone':['primary','secondary','tertiary'], 'button.variant':['primary','secondary','ghost'], 'badge.tone':['primary','secondary','tertiary','success','warning','danger'], 'card.elevation':['none','sm','md'], 'icon.tone':['primary','secondary','tertiary','accent'], 'icon.align':['start','center','end'], 'image.fit':['cover','contain'], 'input.kind':['search','text'], 'input.state':['normal','focused','disabled'], 'chip.state':['normal','selected','disabled'], 'chip.tone':['primary','secondary'] };
        for (const [key, choices] of Object.entries(enums)) { const [type, prop] = key.split('.'); if (n.type === type && p[prop] !== undefined && !choices.includes(p[prop])) add(`${path}.props.${prop}`, '枚举值无效'); }
        if (n.type === 'frame' && (!['row','column'].includes(p.direction) || !['flow','absolute'].includes(p.layoutMode) || ['gap','padding'].some(k => p[k] !== undefined && (!Number.isFinite(p[k]) || p[k] < 0 || p[k] > 512)))) add(`${path}.props`, 'frame layout 属性无效');
        if (n.type === 'text' && (typeof p.text !== 'string' || (p.size !== undefined && (!Number.isFinite(p.size) || p.size < 1 || p.size > 256)))) add(`${path}.props`, 'text 属性无效');
        if (['button','card','list-item','badge','image-placeholder','icon','image','input','chip'].includes(n.type) && Object.entries(p).some(([k,v]) => ['label','title','subtitle','meta','trailing','asset','alt','placeholder','value'].includes(k) && typeof v !== 'string')) add(`${path}.props`, '文本属性必须是字符串');
        if (n.type === 'button' && p.disabled !== undefined && typeof p.disabled !== 'boolean') add(`${path}.props.disabled`, '必须为布尔值');
        if (n.type === 'icon' && p.size !== undefined && (!Number.isFinite(p.size) || p.size < 8 || p.size > 128)) add(`${path}.props.size`, 'icon.size 必须是 8–128');
        if (n.type === 'list-item' && p.selected !== undefined && typeof p.selected !== 'boolean') add(`${path}.props.selected`, '必须为布尔值');
        if (n.type === 'list' && p.dense !== undefined && typeof p.dense !== 'boolean') add(`${path}.props.dense`, '必须为布尔值');
        if (n.layout !== undefined) {
          if (!obj(n.layout)) add(`${path}.layout`, 'layout 必须是对象', 'type-mismatch');
          else if (n.layout.mode === 'flow') {
            if (Object.keys(n.layout).some(k => k !== 'mode')) add(`${path}.layout`, 'flow layout 仅允许 mode 字段', 'unknown-field');
            if (parent?.type === 'frame' && parent.props?.layoutMode === 'absolute') add(`${path}.layout.mode`, 'absolute frame 的直接子节点不能使用 flow', 'layout-mode-conflict');
          } else if (n.layout.mode === 'absolute') {
            if (Object.keys(n.layout).some(k => !['mode','x','y','width','height'].includes(k))) add(`${path}.layout`, 'absolute layout 含未知字段', 'unknown-field');
            if (parent?.type !== 'frame' || parent.props?.layoutMode !== 'absolute') add(`${path}.layout`, 'absolute layout 仅允许作为 absolute frame 的直接子节点', 'layout-mode-conflict');
            for (const key of ['x','y','width','height']) if (!(key in n.layout)) add(`${path}.layout.${key}`, 'absolute layout 缺少坐标/尺寸', 'required-field'); else if (!Number.isFinite(n.layout[key]) || (key === 'width' || key === 'height' ? n.layout[key] <= 0 || n.layout[key] > 4096 : Math.abs(n.layout[key]) > 4096)) add(`${path}.layout.${key}`, 'absolute 几何值越界');
          } else add(`${path}.layout.mode`, 'mode 必须为 flow 或 absolute');
        } else if (parent?.type === 'frame' && parent.props?.layoutMode === 'absolute') add(`${path}.layout`, 'absolute frame 的直接子节点必须声明 absolute layout', 'layout-mode-conflict');
        if (n.children !== undefined && !['frame','card','list'].includes(n.type)) add(`${path}.children`, '叶节点禁止 children', 'invalid-nesting');
        if (n.type === 'list' && n.children === undefined) add(`${path}.children`, 'list 必须至少包含一个 list-item', 'required-field');
        if (n.children !== undefined && !Array.isArray(n.children)) add(`${path}.children`, 'children 必须为数组', 'type-mismatch');
        else {
          if (n.type === 'list' && Array.isArray(n.children) && n.children.length === 0) add(`${path}.children`, 'list 必须至少包含一个 list-item', 'invalid-nesting');
          if (n.type === 'list') n.children?.forEach((child, i) => { if (!obj(child) || child.type !== 'list-item') add(`${path}.children[${i}].type`, 'list 只允许直接包含 list-item', 'invalid-nesting'); });
          (n.children || []).forEach((child, i) => walk(child, `${path}.children[${i}]`, depth + 1, n, context));
        }
      };
      const pageIds = new Set();
      value.pages.forEach((page, index) => {
        if (errors.truncatedErrors) return;
        const path = `$.pages[${index}]`;
        const nodeContext = { ids: new Set(), count: 0 };
        if (!obj(page)) { add(path, 'page 必须是对象', 'type-mismatch'); return; }
        if (Object.keys(page).some(k => !['id','title','viewport','root'].includes(k))) add(path, '包含未知字段', 'unknown-field');
        if (typeof page.id !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(page.id)) add(`${path}.id`, '页面 ID 格式非法');
        else if (pageIds.has(page.id)) add(`${path}.id`, `页面 ID 重复：${page.id}`, 'duplicate-page-id'); else pageIds.add(page.id);
        if (typeof page.title !== 'string') add(`${path}.title`, '必须是字符串', 'type-mismatch'); else if (!Array.from(page.title).length || Array.from(page.title).length > 120) add(`${path}.title`, '字符串长度必须为1–120个 Unicode 码点');
        if (!obj(page.viewport)) add(`${path}.viewport`, 'viewport 必须是对象', 'type-mismatch');
        else {
          if (Object.keys(page.viewport).some(k => !['widthDp','heightDp','orientation'].includes(k))) add(`${path}.viewport`, 'viewport 含未知字段', 'unknown-field');
          for (const key of ['widthDp','heightDp']) if (!(key in page.viewport)) add(`${path}.viewport.${key}`, '缺少必填字段', 'required-field'); else if (!Number.isFinite(page.viewport[key]) || page.viewport[key] <= 0 || page.viewport[key] > 4096) add(`${path}.viewport.${key}`, '必须为 >0 且 ≤4096 的有限 dp 数值');
          if (!('orientation' in page.viewport)) add(`${path}.viewport.orientation`, '缺少必填字段', 'required-field'); else if (!['portrait','landscape'].includes(page.viewport.orientation)) add(`${path}.viewport.orientation`, '允许值：portrait, landscape');
        }
        if (!('root' in page)) add(`${path}.root`, '缺少必填字段', 'required-field'); else walk(page.root, `${path}.root`, 1, null, nodeContext);
      });
      const orientation = contract.layout && typeof contract.layout === 'object' && !Array.isArray(contract.layout) ? contract.layout.orientation : undefined;
      if (value.designId !== contract.designId) add('$.designId', 'designId 与 contract 不一致', 'design-id-mismatch');
      if (value.designVersion !== contract.designVersion) add('$.designVersion', 'designVersion 与 contract 不一致', 'design-version-mismatch');
      if (Object.prototype.hasOwnProperty.call(contract, 'screenId') && !value.pages.some(page => page && page.id === contract.screenId)) add('$.pages', 'pages 未包含 contract.screenId 对应页面', 'screen-id-mismatch');
      if (!errors.truncatedErrors && orientation !== undefined) value.pages.forEach((page, index) => { if (!errors.truncatedErrors && page?.viewport?.orientation !== orientation) add(`$.pages[${index}].viewport.orientation`, 'viewport.orientation 与 contract.layout.orientation 不一致', 'orientation-mismatch'); });
      return errors.length ? { ok: false, errors, ...(errors.truncatedErrors ? { truncatedErrors: true } : {}) } : { ok: true, value };
    }
    /**
     * 手写校验 design-contract v1（与 `mcp-server/src/validation.ts` 的 DesignContractSchema 同构）。
     * b-1 维持零依赖，因此不引入 Zod。返回**带路径**的问题列表。
     */
    function validateContract(value) {
      const issues = [];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, issues: ['(root): 不是 JSON 对象'] };
      }
      const reqStr = (key) => {
        if (!isNonEmptyString(value[key])) issues.push(`${key}: 必须是非空字符串`);
      };
      ['schemaVersion', 'designId', 'designVersion', 'platform', 'screenId'].forEach(reqStr);

      if (value.description !== undefined && typeof value.description !== 'string') {
        issues.push('description: 若存在必须是字符串');
      }

      const tokens = value.designTokens;
      if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
        issues.push('designTokens: 必须是对象');
      } else {
        for (const [k, v] of Object.entries(tokens)) {
          if (typeof v !== 'string' && typeof v !== 'number') {
            issues.push(`designTokens.${k}: 值必须是字符串或数字`);
          }
        }
      }

      const layout = value.layout;
      if (layout === null || typeof layout !== 'object' || Array.isArray(layout)) {
        issues.push('layout: 必须是对象');
      } else {
        if (!isNonEmptyString(layout.orientation)) issues.push('layout.orientation: 必须是非空字符串');
        if (!isStringArray(layout.regions)) issues.push('layout.regions: 必须是字符串数组');
      }

      const scope = value.changeScope;
      if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
        issues.push('changeScope: 必须是对象');
      } else {
        if (!isStringArray(scope.allowed)) issues.push('changeScope.allowed: 必须是字符串数组');
        if (!isStringArray(scope.protected)) issues.push('changeScope.protected: 必须是字符串数组');
      }

      if (!Array.isArray(value.referenceAssets)) issues.push('referenceAssets: 必须是数组');

      return issues.length === 0 ? { ok: true } : { ok: false, issues };
    }

    /** 从 JSON 文本解析并校验；区分"解析失败"与"协议校验失败"两种态。 */
    function parseContract(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return { ok: false, kind: 'parse', detail: String(error && error.message ? error.message : error) };
      }
      const check = validateContract(parsed);
      if (!check.ok) return { ok: false, kind: 'schema', issues: check.issues };
      return { ok: true, contract: parsed };
    }

    // ── ③ View 层：只吃数据，不认识 remote ──────────────────────────────────

    function StyleTag() {
      return h('style', { 'data-designbridge-studio': 'styles' }, CSS);
    }

    function Row(label, value, key) {
      return h(
        'div',
        { className: 'db-studio-row', key },
        h('span', { className: 'db-studio-key' }, label),
        h('span', { className: 'db-studio-value db-studio-mono' }, value),
      );
    }

    /** 值是颜色的（#RGB/#RRGGBB）时给出色块——属数据展示，不是界面装饰。 */
    function TokenRow(name, value, key) {
      const isColor = typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
      return h(
        'div',
        { className: 'db-studio-row', key },
        h('span', { className: 'db-studio-key db-studio-mono' }, name),
        h(
          'span',
          { className: 'db-studio-value db-studio-mono' },
          isColor
            ? h('span', {
                className: 'db-studio-swatch',
                style: { background: value },
                'aria-hidden': true,
              })
            : null,
          String(value),
        ),
      );
    }

    function chipList(items, t, key) {
      if (!Array.isArray(items) || items.length === 0) {
        return h('span', { className: 'db-studio-value' }, t('panel.none'));
      }
      return h(
        'span',
        { className: 'db-studio-value', key },
        items.map((item, i) => h('span', { className: 'db-studio-chip', key: `${item}-${i}` }, item)),
      );
    }

    function contractCard(contract, t) {
      const rows = [
        Row(t('panel.designId'), contract.designId, 'designId'),
        Row(t('panel.designVersion'), contract.designVersion, 'designVersion'),
        Row(t('panel.schemaVersion'), contract.schemaVersion, 'schemaVersion'),
        Row(t('panel.platform'), contract.platform, 'platform'),
        Row(t('panel.screenId'), contract.screenId, 'screenId'),
      ];
      if (typeof contract.description === 'string') {
        rows.push(Row(t('panel.description'), contract.description, 'description'));
      }
      rows.push(Row(t('panel.orientation'), contract.layout.orientation, 'orientation'));

      const tokens = Object.entries(contract.designTokens).map(([k, v]) => TokenRow(k, v, `token-${k}`));

      return h(
        'div',
        { className: 'db-studio-card', key: 'contract', 'data-designbridge-studio': 'contract' },
        h('div', { className: 'db-studio-cardhead' }, t('panel.contractHeading')),
        rows,
        h(
          'div',
          { className: 'db-studio-row', key: 'regions' },
          h('span', { className: 'db-studio-key' }, t('panel.regions')),
          chipList(contract.layout.regions, t, 'regions'),
        ),
        h(
          'div',
          { className: 'db-studio-row', key: 'allowed' },
          h('span', { className: 'db-studio-key' }, t('panel.allowed')),
          chipList(contract.changeScope.allowed, t, 'allowed'),
        ),
        h(
          'div',
          { className: 'db-studio-row', key: 'protected' },
          h('span', { className: 'db-studio-key' }, t('panel.protected')),
          chipList(contract.changeScope.protected, t, 'protected'),
        ),
        Row(
          t('panel.referenceAssets'),
          t('panel.items').replace('{n}', String(contract.referenceAssets.length)),
          'assets',
        ),
        h('div', { className: 'db-studio-cardhead', key: 'tokens-head' }, t('panel.tokens')),
        tokens,
      );
    }

    function sourceCard(source, readAt, t, cardKey = 'source', heading = 'panel.sourceHeading') {
      const rows = [
        Row(t('panel.sourcePath'), source.relativePath, 'rel'),
        Row(t('panel.sourceAbsolute'), source.absolutePath ?? '—', 'abs'),
        Row(t('panel.sourceVersion'), source.version ?? '—', 'ver'),
        Row(t('panel.sourceBytes'), source.bytes === undefined ? '—' : String(source.bytes), 'bytes'),
        Row(t('panel.sourceLines'), source.lines === undefined ? '—' : String(source.lines), 'lines'),
        Row(t('panel.sourceReadAt'), readAt, 'readAt'),
      ];
      return h(
        'div',
        { className: 'db-studio-card', key: cardKey, 'data-designbridge-studio': cardKey },
        h('div', { className: 'db-studio-cardhead' }, t(heading)),
        rows,
      );
    }

    function errorCard(error, t) {
      const kind = error.kind || 'read-failed';
      const body = [h('div', { className: 'db-studio-value', key: 'msg' }, t(`err.${kind}`))];

      if (kind === 'parse' && error.detail) {
        body.push(
          h(
            'div',
            { className: 'db-studio-pre', key: 'parse' },
            `${t('panel.errDetail')}: ${error.detail}`,
          ),
        );
      }
      if ((kind === 'schema' || kind === 'preview-schema') && Array.isArray(error.issues)) {
        body.push(h('div', { className: 'db-studio-key', key: 'issues-head' }, t('err.schemaList')));
        body.push(h('div', { className: 'db-studio-pre', key: 'issues' }, error.issues.join('\n')));
        if (error.truncatedErrors) body.push(h('div', { className: 'db-studio-note', key: 'issues-truncated' }, '已截断其余问题（最多显示 50 条）。'));
      }
      if (kind === 'preview-parse' && error.detail) body.push(h('div', { className: 'db-studio-pre', key: 'preview-parse' }, error.detail));
      if (error.code) {
        body.push(Row(t('panel.errCode'), error.code, 'code'));
      }
      if (error.detail && kind !== 'parse') {
        body.push(Row(t('panel.errDetail'), error.detail, 'detail'));
      }
      body.push(
        Row(t('panel.sourcePath'), error.path ?? DESIGN_ROOT + '/' + CONTRACT_RELATIVE, 'path'),
      );

      return h(
        'div',
        {
          className: 'db-studio-card',
          key: 'error',
          'data-tone': 'error',
          'data-designbridge-studio': `error-${kind}`,
          role: 'alert',
        },
        h('div', { className: 'db-studio-cardhead db-studio-err' }, t('panel.errHeading')),
        body,
        h('div', { className: 'db-studio-note' }, t('panel.errHint')),
      );
    }

    /**
     * 面板正文。注册进 `sidebar.right.pane.tab`，key = TAB_ID。
     * `sessionId` 由 slot 的 `inject` 直接注入（见 apply 里的注册）。
     */
    function findPreviewNode(node, id) {
      if (!node || !id) return null;
      if (node.id === id) return node;
      for (const child of node.children || []) { const found = findPreviewNode(child, id); if (found) return found; }
      return null;
    }

    // ── P2：designTokens → 画布样式（**通用**映射，不含任何具体设计的硬编码）──────
    //
    // 机制：契约里的 designTokens 是自由 key→value 映射。这里按**角色名约定**把 key
    // 解析成一组 CSS 变量，挂到画布 page 元素上（CSS 变量会向下继承），
    // 于是"不同设计 → 不同视觉风格"，而插件代码里**不出现任何设计专属的颜色**。
    //
    // 任何设计只要按下列任一别名命名 token，就会被自动识别；**一个都没有就整组回退**
    // 到 Studio 原有主题 token（因此老设计不会因为本特性而变样或报错）。
    const STYLE_TOKEN_ROLES = Object.freeze({
      canvasBg: ['color.background', 'color.bg', 'canvas', 'background'],
      surface: ['color.panel', 'color.surface', 'surface', 'panel'],
      textPrimary: ['color.textPrimary', 'color.ink', 'textPrimary', 'ink'],
      textSecondary: ['color.textSecondary', 'color.muted', 'textSecondary', 'muted'],
      border: ['color.border', 'color.line', 'border', 'line'],
      accent: ['color.accent', 'accent', 'brand'],
      accentSoft: ['color.accentSoft', 'accentSoft'],
      accentInk: ['color.onAccent', 'color.accentInk', 'onAccent'],
      success: ['color.success'],
      successSoft: ['color.successSoft'],
      floating: ['color.floatingDark', 'color.dark', 'floatingDark', 'dark'],
      radiusCard: ['radius.cardPx', 'cardRadiusDp', 'radius.card'],
      radiusButton: ['radius.buttonPx', 'radius.button'],
      radiusPill: ['radius.pillPx', 'radius.pill'],
      radiusWindow: ['radius.windowPx', 'radius.window'],
    });

    /**
     * **画布组**：必须"背景 + 主文字"同时可用才整组生效。
     *
     * 为什么需要成组门控：若只应用了背景（或卡片底色）而设计没声明文字色，
     * 文字会回退到 Studio 主题色 —— 浅底配浅字直接不可读（实测踩到：
     * 某既有设计声明了 canvas/surface 但没有文字色，画布变浅后文字几乎看不见）。
     * 门控是**通用规则**，不认识任何具体设计。
     */
    const CANVAS_GROUP_ROLES = Object.freeze(['canvasBg', 'surface', 'textPrimary', 'textSecondary', 'border']);

    /** CSS 变量名（角色 → 变量）。 */
    const STYLE_TOKEN_CSS_VARS = Object.freeze({
      canvasBg: '--db-canvas-bg',
      surface: '--db-surface',
      textPrimary: '--db-text-primary',
      textSecondary: '--db-text-secondary',
      border: '--db-border',
      accent: '--db-accent',
      accentSoft: '--db-accent-soft',
      accentInk: '--db-accent-ink',
      success: '--db-success',
      successSoft: '--db-success-soft',
      floating: '--db-floating',
      radiusCard: '--db-radius-card',
      radiusButton: '--db-radius-button',
      radiusPill: '--db-radius-pill',
      radiusWindow: '--db-radius-window',
    });

    /**
     * 总开关：是否让 contract.designTokens 驱动画布样式。
     * false 时画布**完全**沿用 Studio 主题（用于排查"某设计看起来变了"是否由本特性引起）。
     */
    const APPLY_DESIGN_TOKENS = true;

    /** token 值里允许出现的颜色写法（**白名单**，防止设计文件注入任意 CSS）。 */
    const SAFE_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
    const SAFE_FUNC_COLOR_RE = /^(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/;

    /** 只接受白名单内的颜色字面量；其余（含任何 `;{}`、表达式）一律丢弃。 */
    function safeColorValue(value) {
      if (typeof value !== 'string') return null;
      const v = value.trim();
      if (v.length === 0 || v.length > 64) return null;
      return SAFE_COLOR_RE.test(v) || SAFE_FUNC_COLOR_RE.test(v) ? v : null;
    }

    /** 只接受有限数字半径（0–999），转成 px；负值/NaN/字符串一律丢弃。 */
    function safeRadiusValue(value) {
      const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 999) return null;
      return `${n}px`;
    }

    /**
     * 把 designTokens 解析成 CSS 变量对象（可直接展开进 React 的 style）。
     * 纯函数、无 IO：因此可脱离宿主单独验证。**不修改** tokens，也不读任何设计专属常量。
     * @returns {{ vars: Record<string,string>, resolved: string[], ignored: string[] }}
     */
    function resolveStyleTokens(designTokens) {
      const vars = {};
      const resolved = [];
      const ignored = [];
      const gated = [];
      if (!APPLY_DESIGN_TOKENS) return { vars, resolved, ignored, gated };
      if (designTokens === null || typeof designTokens !== 'object' || Array.isArray(designTokens)) {
        return { vars, resolved, ignored, gated };
      }

      // ① 先按角色收集（记下命中的 key，便于诊断）
      const picked = {};
      for (const [role, aliases] of Object.entries(STYLE_TOKEN_ROLES)) {
        const key = aliases.find(candidate => Object.prototype.hasOwnProperty.call(designTokens, candidate));
        if (key === undefined) continue;
        const raw = designTokens[key];
        const value = role.startsWith('radius') ? safeRadiusValue(raw) : safeColorValue(raw);
        if (value === null) {
          ignored.push(`${key}=${JSON.stringify(raw)}`);
          continue;
        }
        picked[role] = { value, key };
      }

      // ② 画布组门控：背景与主文字必须同时可用
      if (picked.canvasBg === undefined || picked.textPrimary === undefined) {
        for (const role of CANVAS_GROUP_ROLES) {
          if (picked[role] !== undefined) {
            gated.push(`${picked[role].key}（缺 canvasBg/textPrimary，成组回退）`);
            delete picked[role];
          }
        }
      }

      // ③ 产出 CSS 变量
      for (const [role, hit] of Object.entries(picked)) {
        const cssVar = STYLE_TOKEN_CSS_VARS[role];
        if (cssVar === undefined) continue;
        vars[cssVar] = hit.value;
        resolved.push(`${role}←${hit.key}`);
      }
      return { vars, resolved, ignored, gated };
    }

    // ── v0.7 设计资源：安全加载（readBytes → data: URI）─────────────────────────
    //
    // 为什么用 <img src="data:..."> 而不是内联 SVG 原文：
    //   浏览器把 <img> 里的 SVG 当**静态图片**处理 —— 不执行脚本、不发起外部请求。
    //   再叠一层文本净化（去掉 script / on* / javascript: / 外部引用）做纵深防御。
    //   绝不用 dangerouslySetInnerHTML 插入设计方提供的 SVG。
    const ASSET_MIME = Object.freeze({
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    });

    /** 资源目录（相对会话工作区根，与契约路径同基准）。 */
    function assetsManifestRelative(designId) {
      return `${DESIGN_ROOT}/designs/${designId}/assets.json`;
    }
    function assetFileRelative(designId, assetPath) {
      return `${DESIGN_ROOT}/${assetPath}`;
    }
    function mimeForAssetPath(assetPath) {
      const lower = String(assetPath).toLowerCase();
      const dot = lower.lastIndexOf('.');
      return dot < 0 ? null : ASSET_MIME[lower.slice(dot)] ?? null;
    }

    /** 字节 → base64。容忍 Uint8Array / ArrayBuffer / 数字数组 / { data } 包装。 */
    function bytesToBase64(input) {
      let bytes = null;
      if (input instanceof Uint8Array) bytes = input;
      else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
      else if (Array.isArray(input)) bytes = Uint8Array.from(input);
      else if (input && typeof input === 'object' && Array.isArray(input.data)) bytes = Uint8Array.from(input.data);
      else if (input && typeof input === 'object' && input.data instanceof Uint8Array) bytes = input.data;
      if (bytes === null) return null;
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
      }
      try { return btoa(binary); } catch { return null; }
    }

    /** 把 SVG 文本编成 data URI（先净化，净化失败一律拒绝）。 */
    function svgToDataUri(text) {
      const safe = sanitizeSvgText(text);
      if (safe === null) return null;
      let bytes;
      try { bytes = new TextEncoder().encode(safe); } catch { return null; }
      const b64 = bytesToBase64(bytes);
      return b64 === null ? null : `data:image/svg+xml;base64,${b64}`;
    }

    /**
     * SVG 净化：**纵深防御**（第一道防线是 <img> 的静态模式）。
     * 保守策略：出现高危结构直接判定不安全并拒绝，而不是试图"修好"它。
     * @returns {string|null} 净化后的 SVG，或 null（拒绝）
     */
    function sanitizeSvgText(text) {
      if (typeof text !== 'string' || text.length === 0) return null;
      if (text.length > 128 * 1024) return null;
      // 高危结构：脚本、外来命名空间、引用外部资源 —— 直接拒绝
      if (/<\s*(script|foreignObject|iframe|object|embed|audio|video|animate)\b/i.test(text)) return null;
      if (/(?:href|xlink:href|src)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(text)) return null;
      if (/<\s*image\b/i.test(text)) return null;
      // 事件属性与非片段 href 一律**直接拒绝**（而不是尝试修复）：不可信内容 fail-closed，行为更好审计。
      if (/\son[a-z]+\s*=/i.test(text)) return null;
      if (/(?:href|xlink:href)\s*=\s*(?!["']?\s*#)/i.test(text)) return null;
      let out = text;
      out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
      out = out.replace(/(?:href|xlink:href)\s*=\s*("[^"]*"|'[^']*')/gi, (match, value) => (/^\s*["']?\s*#/.test(value) ? match : ''));
      out = out.replace(/url\(\s*["']?\s*(?:https?|data):[^)]*\)/gi, '');
      // 净化后仍残留 → 拒绝
      // 兜底复查前先摘掉 xmlns 声明：它是 SVG 规范**要求**的命名空间声明
      // （xmlns="http://www.w3.org/2000/svg"），不发起任何网络请求。
      // 早期版本没排除它，导致**所有合法 SVG 都被误判为不安全**而整体降级（v0.7.1 修复）。
      const withoutNamespaces = out.replace(/\sxmlns(?::[a-zA-Z]+)?\s*=\s*("[^"]*"|'[^']*')/gi, '');
      if (/<\s*script|on[a-z]+\s*=|javascript:|https?:\/\//i.test(withoutNamespaces)) return null;
      return out;
    }

    /**
     * 读一个资源并转成可直接放进 <img src> 的 data URI。**永不抛**。
     *
     * 通道选择（重要）：
     *  - SVG 是文本 → 走已验证可用的 `readWorkspaceFiles.read`（文本通道），再净化后编码；
     *  - PNG/JPEG/WebP 是二进制 → 走 `readBytes`；该通道不可用时**显式降级**并说明原因，
     *    绝不静默显示空白。
     */
    async function loadDesignAsset(remote, sessionId, designId, asset, signal) {
      const mime = mimeForAssetPath(asset.path);
      if (mime === null) return { ok: false, kind: 'unsupported-format', detail: asset.path };
      const relative = assetFileRelative(designId, asset.path);

      if (asset.kind === 'svg') {
        const read = await readWorkspaceText(remote, sessionId, relative, signal).catch(() => ({ ok: false, kind: 'read-failed' }));
        if (!read.ok) return { ok: false, kind: read.kind ?? 'read-failed', detail: read.detail };
        if (typeof read.source?.bytes === 'number' && read.source.bytes > (asset.maxBytes ?? 64 * 1024)) {
          return { ok: false, kind: 'too-large', detail: `${read.source.bytes} 字节` };
        }
        const uri = svgToDataUri(read.text);
        if (uri === null) return { ok: false, kind: 'unsafe-svg', detail: asset.path };
        return { ok: true, uri, kind: 'svg' };
      }

      const readBytes = remote?.workspaceFiles?.readBytes;
      if (typeof readBytes !== 'function') {
        return { ok: false, kind: 'binary-channel-unavailable', detail: '宿主未提供 readBytes' };
      }
      let result;
      try {
        result = await readBytes.call(remote.workspaceFiles, sessionId, relative, {}, signal);
      } catch (error) {
        return { ok: false, kind: 'read-failed', detail: String(error && error.message ? error.message : error) };
      }
      if (result === undefined || result === null || result.ok !== true) {
        const err = (result && result.error) || {};
        return { ok: false, kind: 'read-failed', code: err.code, detail: err.message };
      }
      const value = result.value || {};
      const data = value.data !== undefined ? value.data : value;
      if (typeof value.bytes === 'number' && value.bytes > (asset.maxBytes ?? 512 * 1024)) {
        return { ok: false, kind: 'too-large', detail: `${value.bytes} 字节` };
      }
      const b64 = bytesToBase64(data);
      if (b64 === null) return { ok: false, kind: 'decode-failed' };
      return { ok: true, uri: `data:${mime};base64,${b64}`, kind: 'image' };
    }

    function renderPreviewNode(node, selectedId, onSelect, parentMode, assets) {
      if (!node || !Array.isArray(node.children) && node.children !== undefined || !node.props || typeof node.props !== 'object' || Array.isArray(node.props)) return null;
      if (!PREVIEW_COMPONENT_TYPES.includes(node.type)) return null;
      const selected = node.id === selectedId;
      const absolute = node.layout?.mode === 'absolute';
      const style = absolute ? { position: 'absolute', left: `${node.layout.x}px`, top: `${node.layout.y}px`, width: `${node.layout.width}px`, height: `${node.layout.height}px`, boxSizing: 'border-box' } : undefined;
      const frameAbsolute = node.type === 'frame' && node.props.layoutMode === 'absolute';
      const common = { key: node.id, className: `db-preview-node${selected ? ' is-selected' : ''}`, style, 'data-node-id': node.id, 'data-node-type': node.type, onClick: event => { event.stopPropagation(); onSelect(node.id); }, role: 'button', tabIndex: 0, 'aria-pressed': selected, onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id); } } };
      const childStyle = { display: frameAbsolute ? 'block' : 'flex', flexDirection: node.props?.direction === 'row' ? 'row' : 'column', gap: `${node.props?.gap ?? 8}px`, padding: `${node.props?.padding ?? 8}px`, position: frameAbsolute ? 'relative' : undefined, boxSizing: 'border-box', minWidth: 0 };
      const children = (node.children || []).map(child => renderPreviewNode(child, selectedId, onSelect, node.type === 'frame' ? node.props.layoutMode : 'flow', assets)).filter(Boolean);
      const txt = v => String(v ?? '');
      switch (node.type) {
        case 'frame': return h('div', { ...common, className: `${common.className} db-preview-frame`, style: { ...childStyle, ...style } }, ...children);
        case 'card': return h('section', { ...common, className: `${common.className} db-preview-card`, 'data-db-elevation': node.props.elevation ?? 'none' }, h('strong', null, txt(node.props.title)), node.props.subtitle ? h('small', null, txt(node.props.subtitle)) : null, ...children);
        case 'list': return h('div', { ...common, className: `${common.className} db-preview-list` }, ...children);
        case 'list-item': {
          const hit = node.props.asset ? assets[node.props.asset] : undefined;
          const lead = node.props.asset
            ? (hit && hit.ok
              ? h('img', { className: 'db-preview-listitem-icon', src: hit.uri, alt: '', width: 22, height: 22 })
              : h('span', { className: 'db-preview-asset-missing db-preview-listitem-icon', title: `缺失资源：${node.props.asset}`, 'data-db-asset': node.props.asset }, '?'))
            : null;
          return h('div', { ...common, className: `${common.className} db-preview-listitem`, 'data-db-selected': node.props.selected === true ? 'true' : 'false' },
            lead,
            h('span', { className: 'db-preview-listitem-text' },
              h('strong', null, txt(node.props.label)),
              node.props.subtitle ? h('small', null, txt(node.props.subtitle)) : null),
            node.props.meta ? h('small', { className: 'db-preview-listitem-meta' }, txt(node.props.meta)) : null,
            node.props.trailing ? h('span', null, txt(node.props.trailing)) : null);
        }
        case 'text': return h('div', { ...common, className: `${common.className} db-preview-text`, 'data-db-tone': node.props.tone ?? 'primary', style: { fontSize: `${node.props.size ?? 14}px`, fontWeight: ['bold','semibold'].includes(node.props.weight) ? 650 : node.props.weight === 'medium' ? 500 : 400, ...style } }, txt(node.props.text));
        case 'button': return h('div', { ...common, className: `db-preview-button db-preview-node${selected ? ' is-selected' : ''}${node.props.disabled ? ' is-disabled' : ''}`, 'data-db-variant': node.props.variant ?? 'ghost', 'aria-disabled': Boolean(node.props.disabled) }, txt(node.props.label));
        case 'badge': return h('div', { ...common, className: `${common.className} db-preview-badge`, 'data-db-tone': node.props.tone ?? 'secondary' }, txt(node.props.label));
        case 'divider': return h('div', { ...common, className: `${common.className} db-preview-divider`, 'aria-label': 'divider' });
        case 'icon': {
          const hit = assets[node.props.asset];
          const size = node.props.size ?? 18;
          const box = { width: `${size}px`, height: `${size}px` };
          if (hit === undefined || hit.ok !== true) {
            return h('span', { ...common, className: `${common.className} db-preview-icon db-preview-asset-missing`, 'data-db-asset': node.props.asset, 'data-db-tone': node.props.tone ?? 'primary', 'data-db-align': node.props.align ?? 'start', title: `缺失资源：${node.props.asset}`, style: { ...box, ...style } }, '?');
          }
          return h('img', { ...common, className: `${common.className} db-preview-icon`, src: hit.uri, alt: node.props.label ?? '', 'data-db-tone': node.props.tone ?? 'primary', 'data-db-align': node.props.align ?? 'start', 'data-db-asset': node.props.asset, width: size, height: size, style: { ...box, ...style } });
        }
        case 'image': {
          const hit = assets[node.props.asset];
          if (hit === undefined || hit.ok !== true) {
            return h('div', { ...common, className: `${common.className} db-preview-image db-preview-asset-missing`, 'data-db-asset': node.props.asset, style }, `缺失资源：${node.props.asset}`);
          }
          return h('img', { ...common, className: `${common.className} db-preview-image`, src: hit.uri, alt: node.props.alt ?? '', 'data-db-fit': node.props.fit ?? 'cover', 'data-db-asset': node.props.asset, style });
        }
        case 'input': {
          const filled = node.props.value !== undefined && node.props.value !== '';
          return h('div', { ...common, className: `${common.className} db-preview-input`, 'data-db-kind': node.props.kind ?? 'text', 'data-db-state': node.props.state ?? 'normal', 'data-db-filled': filled ? 'true' : 'false', style },
            h('span', { className: 'db-preview-input-icon' }, (node.props.kind ?? 'text') === 'search' ? '⌕' : ''),
            h('span', { className: 'db-preview-input-text' }, filled ? txt(node.props.value) : txt(node.props.placeholder)),
            filled ? h('span', { className: 'db-preview-input-clear' }, '✕') : null);
        }
        case 'chip': return h('div', { ...common, className: `${common.className} db-preview-chip`, 'data-db-state': node.props.state ?? 'normal', 'data-db-tone': node.props.tone ?? 'secondary' }, txt(node.props.label));
        case 'image-placeholder': return h('div', { ...common, className: `${common.className} db-preview-image-placeholder` }, `▧ ${txt(node.props.label)}`);
        default: return null;
      }
    }

    // ── 交付校验索引（P1 · 只读状态条）──────────────────────────────────────

    /**
     * 把交付索引文本与当前 designId 对上，返回**可直接渲染**的状态对象。
     *
     * 这是**纯函数**（无 IO、无 React），因此可脱离宿主单独验证。
     * 纪律：任何一步拿不到真值就返回**显式错误态**，绝不回落到演示值。
     *
     * kind 取值：
     *   · `missing`  索引读不到（不存在 / 无权限 / 宿主流错误）
     *   · `parse`    索引不是合法 JSON，或根节点形状不对
     *   · `empty`    索引里没有任何设计记录
     *   · `mismatch` 索引里没有当前 designId 的记录
     *   · `entry`    命中记录（`ok` 表示该次校验是否通过）
     */
    function matchDeliveryIndex(indexText, designId) {
      if (typeof indexText !== 'string' || indexText.length === 0) return { kind: 'missing' };
      let index;
      try {
        index = JSON.parse(indexText);
      } catch (error) {
        return { kind: 'parse', detail: String(error && error.message ? error.message : error) };
      }
      if (index === null || typeof index !== 'object' || Array.isArray(index)) {
        return { kind: 'parse', detail: '索引根节点不是对象' };
      }
      const updatedAt = typeof index.updatedAt === 'string' ? index.updatedAt : null;
      const designs = index.designs;
      if (designs === null || typeof designs !== 'object' || Array.isArray(designs)) return { kind: 'empty', updatedAt };
      if (Object.keys(designs).length === 0) return { kind: 'empty', updatedAt };

      const record = designs[designId];
      if (record === null || typeof record !== 'object' || Array.isArray(record)) return { kind: 'mismatch', updatedAt };

      const lastValid = record.lastValid !== null && typeof record.lastValid === 'object' ? record.lastValid : null;
      const lastAttempt = record.lastAttempt !== null && typeof record.lastAttempt === 'object' ? record.lastAttempt : null;

      // ⚠️ 展示的是**最近一次**同步的结果（lastAttempt），而不是优先显示 lastValid ——
      // 否则"最近一次失败、历史上有效"会被渲染成陈旧的 ✅，把失败藏起来。
      const entry = lastAttempt ?? lastValid;
      if (entry === null) return { kind: 'empty', updatedAt };

      const source = entry.source !== null && typeof entry.source === 'object' ? entry.source : {};
      const errors = Array.isArray(entry.errors) ? entry.errors.filter((e) => e !== null && typeof e === 'object') : [];
      const ok = entry.ok === true;
      // 最近一次失败、且确实存在一条**通过**的旧记录 → 才声称"上一个有效交付未被替换"
      const preservedValid = !ok && lastAttempt !== null && lastValid !== null && lastValid.ok === true;
      const validSource = preservedValid && lastValid.source !== null && typeof lastValid.source === 'object' ? lastValid.source : {};
      return {
        kind: 'entry',
        ok,
        entryIsLastValid: lastAttempt === null,
        preservedValid,
        preservedCommit: preservedValid && typeof validSource.commit === 'string' ? validSource.commit : null,
        designVersion: typeof entry.designVersion === 'string' ? entry.designVersion : null,
        commit: typeof source.commit === 'string' ? source.commit : null,
        commitSubject: typeof source.commitSubject === 'string' ? source.commitSubject : null,
        ref: typeof source.ref === 'string' ? source.ref : null,
        validatedAt: typeof entry.validatedAt === 'string' ? entry.validatedAt : null,
        errorCount: typeof entry.errorCount === 'number' ? entry.errorCount : errors.length,
        errors,
        summary: entry.summary !== null && typeof entry.summary === 'object' ? entry.summary : null,
      };
    }

    /** 把一条校验错误格式化为一行（与 validate-design.mjs 的输出风格一致）。 */
    function formatIndexError(issue) {
      const code = typeof issue.code === 'string' ? issue.code : '—';
      const path = typeof issue.path === 'string' ? issue.path : '—';
      const message = typeof issue.message === 'string' ? issue.message : '';
      return `[${code}] ${path}${message ? ` — ${message}` : ''}`;
    }

    /** 渲染交付校验状态条；无可渲染信息时返回 null（不占位、不编造）。 */
    function renderValidationBar(validation, t) {
      if (validation === null || validation === undefined) return null;
      const base = {
        className: 'db-validation',
        'data-designbridge-studio': 'validation',
        'data-db-validation-kind': validation.kind,
      };
      const heading = h('div', { className: 'db-validation-head' }, t('panel.validationHeading'));

      if (validation.kind === 'missing' || validation.kind === 'empty') {
        return h('div', { ...base, 'data-tone': 'none' }, heading,
          h('div', { className: 'db-studio-note' }, t('panel.validationMissing')));
      }
      if (validation.kind === 'parse') {
        return h('div', { ...base, 'data-tone': 'error' }, heading,
          h('div', { className: 'db-studio-note' }, t('panel.validationParse')),
          h('pre', { className: 'db-studio-pre' }, String(validation.detail ?? '')));
      }
      if (validation.kind === 'mismatch') {
        return h('div', { ...base, 'data-tone': 'none' }, heading,
          h('div', { className: 'db-studio-note' }, t('panel.validationMismatch')));
      }

      const ok = validation.ok === true;
      const tone = ok ? 'ok' : 'error';
      const shortCommit = typeof validation.commit === 'string' ? validation.commit.slice(0, 12) : '—';
      const rows = [
        h('div', { className: 'db-validation-status', 'data-db-validation-ok': ok ? 'true' : 'false' },
          ok ? `✅ ${t('panel.validationOk')}` : `❌ ${t('panel.validationFail')}`),
        h('div', { className: 'db-studio-note' },
          `${t('panel.validationVersion')} ${validation.designVersion ?? '—'} · ${t('panel.validationCommit')} ${shortCommit} · ${t('panel.validationErrors')} ${validation.errorCount}`),
      ];
      if (validation.preservedValid) {
        const keptCommit = typeof validation.preservedCommit === 'string' ? validation.preservedCommit.slice(0, 12) : '—';
        rows.push(h('div', { className: 'db-studio-note', 'data-designbridge-studio': 'validation-preserved' },
          t('panel.validationPreserved').replace('{commit}', keptCommit)));
      }
      if (!ok && validation.errors.length > 0) {
        const shown = validation.errors.slice(0, INDEX_MAX_ERRORS);
        rows.push(h('div', { className: 'db-studio-note' }, t('panel.validationErrorsHeading').replace('{n}', String(shown.length))));
        rows.push(h('ul', { className: 'db-validation-errors', 'data-designbridge-studio': 'validation-errors' },
          shown.map((issue, index) => h('li', { key: `idx-err-${index}` }, formatIndexError(issue)))));
      }
      return h('div', {
        ...base,
        'data-tone': tone,
        'data-db-validation-errors': String(validation.errorCount),
        'data-db-validation-commit': shortCommit,
      }, heading, ...rows);
    }

    function Panel(props) {
      const t = useTranslate();
      const sessionId = props && props.sessionId;
      const remote = props && props.remote;

      const [state, setState] = React.useState({ phase: 'idle' });
      const [nonce, setNonce] = React.useState(0);
      const [pageIndex, setPageIndex] = React.useState(0);
      const [selectedId, setSelectedId] = React.useState(null);
      /** 交付校验索引的匹配结果；null = 尚未读到。 */
      const [validation, setValidation] = React.useState(null);

      /** 设计资源：asset id → { ok:true, uri } | { ok:false, kind }。缺失/非法一律显式降级。 */
      const [assetUris, setAssetUris] = React.useState({});
      /** 资源诊断：只暴露**阶段与原因码**，不含绝对路径等文件系统信息。 */
      const [assetDiag, setAssetDiag] = React.useState(null);

      // 资源加载：清单（assets.json）→ 逐个 readBytes → data: URI。
      // 读不到清单/资源不阻断主流程：图标与图片降级为可见的"缺失资源"占位。
      React.useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        const designId = state.contract ? state.contract.designId : undefined;
        if (state.phase !== 'ready' || typeof designId !== 'string' || designId === '' || sessionId === undefined || remote === undefined) {
          return () => { cancelled = true; controller.abort(); };
        }
        readWorkspaceText(remote, sessionId, assetsManifestRelative(designId), controller.signal)
          .then(async (read) => {
            if (cancelled) return;
            if (!read.ok) {
              setAssetUris({});
              setAssetDiag({ manifest: read.kind === 'not-found' ? 'missing' : 'read-failed', total: 0, ok: 0, failed: {} });
              return;
            }
            let manifest = null;
            try { manifest = JSON.parse(read.text); } catch { manifest = null; }
            if (manifest === null || !Array.isArray(manifest.assets)) {
              setAssetUris({});
              setAssetDiag({ manifest: 'parse-failed', total: 0, ok: 0, failed: {} });
              return;
            }
            const list = manifest.assets;
            const next = {};
            const failed = {};
            let okCount = 0;
            for (const asset of list) {
              if (cancelled) return;
              if (asset === null || typeof asset !== 'object') continue;
              if (typeof asset.id !== 'string' || typeof asset.path !== 'string') continue;
              const outcome = await loadDesignAsset(remote, sessionId, designId, asset, controller.signal);
              next[asset.id] = outcome;
              if (outcome.ok === true) okCount += 1;
              else failed[outcome.kind] = (failed[outcome.kind] ?? 0) + 1;
            }
            if (cancelled) return;
            setAssetUris(next);
            setAssetDiag({ manifest: 'ok', total: Object.keys(next).length, ok: okCount, failed });
          })
          .catch(() => {
            if (!cancelled) { setAssetUris({}); setAssetDiag({ manifest: 'read-failed', total: 0, ok: 0, failed: {} }); }
          });
        return () => { cancelled = true; controller.abort(); };
      }, [state.phase, state.contract, sessionId, remote]);

      React.useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        if (sessionId === undefined || sessionId === null || sessionId === '') {
          setState({ phase: 'error', error: { kind: 'no-session' } });
          return () => { cancelled = true; controller.abort(); };
        }

        setState({ phase: 'loading' });
        setValidation(null);
        const relativePath = `${DESIGN_ROOT}/${CONTRACT_RELATIVE}`;

        readWorkspaceText(remote, sessionId, relativePath, controller.signal).then((read) => {
          if (cancelled) return;
          if (!read.ok) {
            setState({ phase: 'error', error: { ...read, path: relativePath } });
            return;
          }
          const parsed = parseContract(read.text);
          if (!parsed.ok) {
            setState({
              phase: 'error',
              error: { ...parsed, path: relativePath, source: read.source },
            });
            return;
          }
          // 交付校验索引：**独立**读取 —— 读不到不影响主流程（面板照旧显示设计本身）。
          // 路径基准同为会话工作区根，但**不带** DESIGN_ROOT 前缀（见 INDEX_RELATIVE 注释）。
          readWorkspaceText(remote, sessionId, INDEX_RELATIVE, controller.signal)
            .then((indexRead) => {
              if (cancelled) return;
              if (!indexRead.ok) {
                setValidation({ kind: 'missing', detail: indexRead.kind });
                return;
              }
              setValidation(matchDeliveryIndex(indexRead.text, parsed.contract.designId));
            })
            .catch((error) => {
              if (!cancelled) {
                setValidation({ kind: 'missing', detail: String(error && error.message ? error.message : error) });
              }
            });

          // ⚠️ 路径基准是**会话工作区根**，不是 designRoot。
          // 契约读的是 `${DESIGN_ROOT}/${CONTRACT_RELATIVE}`，preview 必须同样带 DESIGN_ROOT 前缀，
          // 否则会去工作区根下找 `designs/...`，结果是 not-found（真机实测踩过）。
          const previewPath = `${DESIGN_ROOT}/designs/${parsed.contract.designId}/preview.json`;
          readWorkspaceText(remote, sessionId, previewPath, controller.signal).then((previewRead) => {
            if (cancelled) return;
            if (!previewRead.ok) {
              setState({ phase: 'error', error: { ...previewRead, path: previewPath }, contract: parsed.contract, source: read.source });
              return;
            }
            const previewResult = validatePreviewText(previewRead.text, parsed.contract);
            if (!previewResult.ok) {
              const result = previewResult;
              setState({ phase: 'error', error: { kind: result.errors[0]?.code === 'invalid-json' ? 'preview-parse' : 'preview-schema', path: previewPath, detail: result.errors[0]?.message, issues: result.errors.map(issue => `${issue.path}: ${issue.message}`), truncatedErrors: result.truncatedErrors }, contract: parsed.contract, source: read.source });
              return;
            }
            setPageIndex(0);
            setSelectedId(null);
            setState({ phase: 'ready', contract: parsed.contract, preview: previewResult.value, source: read.source, previewSource: previewRead.source, readAt: new Date().toLocaleTimeString() });
          }).catch((error) => {
            if (!cancelled) setState({ phase: 'error', error: { kind: 'read-failed', path: previewPath, detail: String(error?.message ?? error) }, contract: parsed.contract, source: read.source });
          });
        }).catch((error) => {
          if (cancelled) return;
          setState({
            phase: 'error',
            error: { kind: 'read-failed', detail: String(error && error.message ? error.message : error), path: relativePath },
          });
        });

        return () => { cancelled = true; controller.abort(); };
      }, [sessionId, remote, nonce]);

      const busy = state.phase === 'loading';
      const selectedNode = state.phase === 'ready' ? findPreviewNode(state.preview.pages[pageIndex]?.root, selectedId) : null;
      const children = [
        h(StyleTag, { key: 'style' }),
        h(
          'div',
          { className: 'db-studio-head', key: 'head' },
          h(
            'div',
            { className: 'db-studio-titlerow' },
            h('div', { className: 'db-studio-title' }, t('panel.heading')),
            h(
              'button',
              {
                type: 'button',
                className: 'db-studio-button',
                disabled: busy,
                onClick: () => setNonce((n) => n + 1),
                'data-designbridge-studio': 'refresh',
              },
              t('panel.refresh'),
            ),
          ),
          h('div', { className: 'db-studio-sub' }, t('panel.subheading')),
        ),
      ];

      // 交付校验状态条：读不到索引时**不渲染**（而不是显示"通过"）
      const validationBar = renderValidationBar(validation, t);
      if (validationBar !== null) children.push(validationBar);
      // 资源诊断条：有清单或明确失败时出现；只暴露阶段/原因码，不含任何文件系统路径。
      if (assetDiag !== null && (assetDiag.manifest !== "missing" || assetDiag.total > 0)) {
        const failedKinds = Object.entries(assetDiag.failed).map(([kind, n]) => `${kind}×${n}`).join("、");
        children.push(h("div", { className: "db-validation db-validation--assets", key: "asset-diag", "data-designbridge-studio": "assets", "data-db-assets-manifest": assetDiag.manifest },
          h("strong", null, failedKinds === "" ? "设计资源 ✅" : "设计资源 ⚠️"),
          h("div", { className: "db-validation-line" }, `清单 ${assetDiag.manifest} · 资源 ${assetDiag.ok}/${assetDiag.total} 加载成功` + (failedKinds === "" ? "" : ` · 失败：${failedKinds}`))));
      }

      if (state.phase === 'loading' || state.phase === 'idle') {
        children.push(
          h('div', { className: 'db-studio-state', key: 'loading', role: 'status', 'aria-live': 'polite' }, t('panel.loading')),
        );
      }
      if (state.phase === 'error') {
        children.push(errorCard(state.error, t));
      }
      if (state.phase === 'ready') {
        const page = state.preview.pages[pageIndex] || state.preview.pages[0];
        // designTokens → 画布 CSS 变量（通用映射；无 tokens 时为空对象 = 完全回退到 Studio 主题）
        const styleTokens = resolveStyleTokens(state.contract ? state.contract.designTokens : null);
        children.push(h('div', { className: 'db-preview-toolbar', key: 'preview-toolbar' },
          h('strong', null, '可视化 Preview'),
          state.preview.pages.length > 1 ? h(React.Fragment, null,
            h('button', { type: 'button', className: 'db-studio-button', disabled: pageIndex <= 0, onClick: () => { setPageIndex(Math.max(0, pageIndex - 1)); setSelectedId(null); } }, '上一页'),
            h('span', null, `${pageIndex + 1} / ${state.preview.pages.length} · ${page.title}`),
            h('button', { type: 'button', className: 'db-studio-button', disabled: pageIndex >= state.preview.pages.length - 1, onClick: () => { setPageIndex(Math.min(state.preview.pages.length - 1, pageIndex + 1)); setSelectedId(null); } }, '下一页')) : h('span', null, `${page.title} · ${page.viewport.widthDp} × ${page.viewport.heightDp} dp`),
        ));
        children.push(h('div', { className: 'db-preview-layout', key: 'preview-layout' },
          h('div', { className: 'db-preview-viewport', 'data-designbridge-studio': 'canvas' },
            h('div', { className: 'db-preview-page', style: { width: `${page.viewport.widthDp}px`, minHeight: `${page.viewport.heightDp}px`, ...styleTokens.vars }, 'data-page-id': page.id, 'data-db-tokens-resolved': String(styleTokens.resolved.length), 'data-db-tokens-ignored': String(styleTokens.ignored.length), 'data-db-tokens-gated': String(styleTokens.gated.length), 'data-db-assets-ok': String(assetDiag ? assetDiag.ok : 0), 'data-db-assets-total': String(assetDiag ? assetDiag.total : 0), 'data-db-assets-manifest': assetDiag ? assetDiag.manifest : 'pending' },
              h('div', { className: 'db-preview-page-title' }, `${page.title} · ${page.id}`),
              renderPreviewNode(page.root, selectedId, id => setSelectedId(id), null, assetUris))),
          h('section', { className: 'db-preview-selection', 'data-designbridge-studio': 'selection' },
            h('h3', null, '组件属性'),
            selectedNode ? h('dl', null,
              h('dt', null, 'ID'), h('dd', null, selectedNode.id),
              h('dt', null, '类型'), h('dd', null, selectedNode.type),
              h('dt', null, '属性'), h('dd', null, h('pre', null, JSON.stringify(selectedNode.props, null, 2))),
              h('dt', null, '布局'), h('dd', null, h('pre', null, JSON.stringify(selectedNode.layout ?? { mode: 'flow (default)' }, null, 2))))
              : h('p', null, '点击画布中的组件查看属性。'))));
        children.push(contractCard(state.contract, t));
        children.push(sourceCard(state.source, state.readAt, t));
        if (state.previewSource) children.push(sourceCard(state.previewSource, state.readAt, t, 'preview-source', 'panel.previewSourceHeading'));
      }

      return h(
        'div',
        { className: 'db-studio-root', 'data-designbridge-studio': 'panel', 'data-db-phase': state.phase },
        // 自动打开的诊断（成功/重试原因）。没有它就只能靠猜"面板为什么没出现"。
        autoOpenDiag
          ? h('div', {
              className: 'db-studio-note',
              key: 'autoopen-diag',
              'data-designbridge-studio': 'autoopen-diag',
            }, `${translate('panel.autoOpenLabel')}: ${autoOpenDiag}`)
          : null,
        children,
      );
    }

    return {
      // ⚠️ 依赖声明必须写**两级**，缺一不可：
      //
      //   'remote'                —— 传输/网关服务（`$mount` 在它上面）
      //   'remote.workspaceFiles' —— **独立的一个 cordis 服务**，由
      //                              dsh-api-workspace-files 的客户端半边
      //                              经 `ctx.remote.$mount(contribution)` 挂载上来
      //
      // cordis 的上下文代理按**点号全名**解析服务。只声明 `remote` 而访问
      // `ctx.remote.workspaceFiles` 时，解析到未声明的 `remote.workspaceFiles`，
      // 宿主会抛：cannot get property "remote.workspaceFiles" without inject
      //
      // 官方参考实现（dsh-client-ui-sidebar-documentpreview）原文即为：
      //   inject = ["slots", "locale", "sidebarRightTabs", "remote",
      //             "remote.workspaceFiles", "configForms", "resources"]
      // `sidebarRight` 是导航控制器（`openTab` / `mounted` 都在它上面），
      // 官方声明示例：inject = ["slots","locale","sidebarRight","sidebarRightTabs"]
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'locale', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        if (ctx.locale !== undefined) {
          ctx.effect(() => ctx.locale.register(NAMESPACE, COPY), 'designbridge-studio.copy');
          const bound = ctx.locale.bind(NAMESPACE);
          translate = (key) => {
            const value = bound(key);
            return value === undefined || value === null || value === '' ? (COPY.zh[key] ?? key) : value;
          };
        }

        // 1) 声明右栏 tab 类型 + 引导页入口
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'extension',
              title: () => translate('type.label'),
              guide: [
                {
                  id: 'open',
                  order: 20,
                  title: () => translate('guide.title'),
                  description: () => translate('guide.description'),
                },
              ],
            }),
          'designbridge-studio.type',
        );

        // 2) 面板正文。
        //
        // `sidebar.right.pane.tab` 由 sidebar-right 声明，属**别人的 slot**，
        // 因此必须用 `ctx.slots.inject(key, cb)` 包装（绑定 declaration epoch：
        // 折叠即 dispose、再声明即重装；未声明时静默等待而非抛错）。
        //
        // `inject: (sessionId, actions) => props` 是**宿主给的下发通道**——
        // 面板正是这样拿到 `sessionId` 的（与官方 documentpreview 一致）。
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: TAB_ID,
                  inject: (sessionId) => ({ sessionId, remote: ctx.remote }),
                },
                Panel,
              ),
            ),
          'designbridge-studio.pane',
        );

        // 3) 自动打开面板（见 AUTO_OPEN_TAB 的说明）。
        //
        // 逐个官方事实：
        //  - `ctx.sidebarRight.mounted` 是 createSnapshotStore(void 0)，有 getSnapshot / subscribe；
        //    sidebar-right 自己也是用 `source.subscribe(sync); sync(); return () => un()` 这个惯用法。
        //  - `ctx.sidebarRight.openTab(kind)` 内部的 require() 在两个条件之一不满足时抛
        //      "sidebarRight: no session surface is mounted"
        //    ① mounted 还没有会话在屏；② 该会话的 store 还没被 mint。
        //    而 mounted 的变化发生在**渲染出该会话席位之前**，所以首次尝试常常正落在 ②。
        //    ⇒ 失败时**不记录已打开**，稍后按有限次数重试。
        //  - openTab 成功后「面板展开，因为用户看不到的内容不算打开」（官方原文），
        //    因此这一步同时解决了"右栏收起时什么都看不见"。
        ctx.effect(() => {
          const service = ctx.sidebarRight;
          if (service === undefined || service.mounted === undefined) return () => {};

          const opened = new Set();
          const attempts = new Map();
          let timer;
          let disposed = false;

          /**
           * 该会话的右栏当前是否**已有**任何已打开 tab。
           *
           * 依据：`ctx.sidebarRight.openTabs` 是**官方文档化**的可观察值，
           * 元素形如 `{ sessionId, tabId, kind, contentId }`
           * （README「ctx.sidebarRight」一节：openTabs 发布所有已保存和已采用
           *  Session 的打开标签元数据，并保持快照引用稳定）。
           *
           * @returns `true` / `false`；API 不可用时返回 `undefined` —— 调用方**不得猜测**。
           */
          const hasAnyTab = (sessionId) => {
            const source = service.openTabs;
            if (source === undefined || source === null || typeof source.getSnapshot !== 'function') {
              return undefined;
            }
            const tabs = source.getSnapshot();
            if (!Array.isArray(tabs)) return undefined;
            return tabs.some((tab) => tab !== null && typeof tab === 'object' && tab.sessionId === sessionId);
          };

          const attempt = () => {
            if (disposed) return;
            const sessionId = service.mounted.getSnapshot();
            if (sessionId === undefined || opened.has(sessionId)) return;
            if (!AUTO_OPEN_TAB) return;

            // 保守策略：拿不到 openTabs 就不猜，直接不打开（宁可手动，不可打扰）。
            const occupied = hasAnyTab(sessionId);
            if (occupied === undefined) {
              autoOpenDiag = `skip session=${sessionId}: openTabs API unavailable（保守策略：不自动打开）`;
              opened.add(sessionId);
              return;
            }
            // 该会话右栏已有 tab（用户可能正在用文件/浏览器/终端）→ 不抢占。
            if (occupied) {
              autoOpenDiag = `skip session=${sessionId}: right sidebar already has open tab(s)（不抢占）`;
              opened.add(sessionId);
              return;
            }

            const tried = attempts.get(sessionId) ?? 0;
            if (tried >= AUTO_OPEN_MAX_ATTEMPTS) return;
            attempts.set(sessionId, tried + 1);

            try {
              service.openTab(TAB_KIND);
              opened.add(sessionId);
              autoOpenDiag = `opened session=${sessionId}（右栏当时为空，保守打开）`;
            } catch (error) {
              // 绝不让它冒泡——自动打开失败不能影响面板注册。
              const message = String(error && error.message ? error.message : error);
              autoOpenDiag = `retry(${tried + 1}/${AUTO_OPEN_MAX_ATTEMPTS}) session=${sessionId}: ${message}`;
              if (timer === undefined) {
                timer = setTimeout(() => {
                  timer = undefined;
                  attempt();
                }, AUTO_OPEN_RETRY_MS);
              }
            }
          };

          const unsubscribe = service.mounted.subscribe(attempt);
          attempt();

          return () => {
            disposed = true;
            if (timer !== undefined) clearTimeout(timer);
            unsubscribe();
          };
        }, 'designbridge-studio.autoopen');
      },
    };
  },
});
