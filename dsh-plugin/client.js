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

    /** `read` 每页最多行数上限（宿主 workspaceFiles 的 maxLines 默认为 5000）。 */
    const PAGE_MAX_LINES = 5000;
    /** 分页安全上限：防止异常数据导致无限循环。5000 × 20 = 10 万行，远超任何设计契约。 */
    const PAGE_MAX_PAGES = 20;

    const COPY = {
      zh: {
        'type.label': 'DesignBridge',
        'guide.title': 'DesignBridge',
        'guide.description': '只读查看设计契约',
        'panel.heading': 'DesignBridge Studio',
        'panel.subheading': '设计契约只读预览 · b-1',
        'panel.refresh': '重新读取',
        'panel.loading': '正在读取设计契约…',
        'panel.sourceHeading': '数据来源',
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
        'panel.errHeading': '无法读取真实设计契约',
        'panel.errHint': '面板不会用演示数据替代。请按下列信息排查。',
        'panel.errCode': '宿主错误码',
        'panel.errDetail': '详情',
        'panel.retry': '重试',
        'err.no-session': '当前没有会话上下文，无法定位工作区。请在某个会话内打开本面板。',
        'err.bad-path':
          '路径非法。designRoot 必须是**工作区相对路径**（不能是绝对路径、URL，也不能含 NUL）。',
        'err.not-found': '文件不存在。请核对 designRoot 与协议路径是否正确。',
        'err.forbidden': '没有读取权限，或者该路径不在允许范围内。',
        'err.not-text': '该文件不是可读的 UTF-8 文本。',
        'err.too-large': '文件超出宿主单次读取上限，b-1 不支持分块拼装。',
        'err.read-failed': '读取失败。',
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
        'panel.subheading': 'Design contract read-only preview - b-1',
        'panel.refresh': 'Reload',
        'panel.loading': 'Reading design contract...',
        'panel.sourceHeading': 'Data source',
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
        'panel.errHeading': 'Cannot read the real design contract',
        'panel.errHint': 'This panel never substitutes demo data. Use the details below.',
        'panel.errCode': 'Host error code',
        'panel.errDetail': 'Detail',
        'panel.retry': 'Retry',
        'err.no-session': 'No session context; cannot resolve the workspace. Open this panel inside a session.',
        'err.bad-path':
          'Invalid path. designRoot must be a workspace-relative path (not absolute, not a URL, no NUL).',
        'err.not-found': 'File not found. Check designRoot and the protocol path.',
        'err.forbidden': 'No read permission, or the path is outside the allowed scope.',
        'err.not-text': 'The file is not readable UTF-8 text.',
        'err.too-large': 'File exceeds the host read limit; b-1 does not stitch chunks.',
        'err.read-failed': 'Read failed.',
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
.db-studio-pre {
  margin: 0; padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary);
}
`;

    // ── 文案 ────────────────────────────────────────────────────────────────
    let translate = (key) => COPY.zh[key] ?? key;

    function useTranslate() {
      return translate;
    }

    // ── ① Source 层：只负责"把文本拿到手"，不理解 JSON 结构、不碰 React ──────

    /** 判断一个路径是否合法的**工作区相对路径**（与 workspaceFiles 的路径纪律一致）。 */
    function isWorkspaceRelativePath(path) {
      if (typeof path !== 'string' || path.length === 0) return false;
      if (path.includes('\0')) return false;
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

    function sourceCard(source, readAt, t) {
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
        { className: 'db-studio-card', key: 'source', 'data-designbridge-studio': 'source' },
        h('div', { className: 'db-studio-cardhead' }, t('panel.sourceHeading')),
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
      if (kind === 'schema' && Array.isArray(error.issues)) {
        body.push(h('div', { className: 'db-studio-key', key: 'issues-head' }, t('err.schemaList')));
        body.push(h('div', { className: 'db-studio-pre', key: 'issues' }, error.issues.join('\n')));
      }
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
    function Panel(props) {
      const t = useTranslate();
      const sessionId = props && props.sessionId;
      const remote = props && props.remote;

      const [state, setState] = React.useState({ phase: 'idle' });
      const [nonce, setNonce] = React.useState(0);

      React.useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        if (sessionId === undefined || sessionId === null || sessionId === '') {
          setState({ phase: 'error', error: { kind: 'no-session' } });
          return () => { cancelled = true; controller.abort(); };
        }

        setState({ phase: 'loading' });
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
          setState({
            phase: 'ready',
            contract: parsed.contract,
            source: read.source,
            readAt: new Date().toLocaleTimeString(),
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

      if (state.phase === 'loading' || state.phase === 'idle') {
        children.push(
          h('div', { className: 'db-studio-state', key: 'loading', role: 'status', 'aria-live': 'polite' }, t('panel.loading')),
        );
      }
      if (state.phase === 'error') {
        children.push(errorCard(state.error, t));
      }
      if (state.phase === 'ready') {
        children.push(contractCard(state.contract, t));
        children.push(sourceCard(state.source, state.readAt, t));
      }

      return h(
        'div',
        { className: 'db-studio-root', 'data-designbridge-studio': 'panel', 'data-db-phase': state.phase },
        children,
      );
    }

    return {
      // `remote` 来自宿主已挂载的 dsh-api-remotes / dsh-api-workspace-files（只读服务）
      inject: ['slots', 'sidebarRightTabs', 'locale', 'remote'],
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
      },
    };
  },
});
