/**
 * DesignBridge Studio —— Client（浏览器）半边。
 * v0.3a：最小客户端插件可行性验证。
 *
 * 形态说明（对齐官方 `templates/decoration/` 与 `references/ui-plugin.md`）：
 * - 用 `window.__ModuleLoader__.load({ id, factory })` 注册**惰性工厂**，
 *   `id` 必须等于包名；宿主把它经 `/plugins` 提供给浏览器，按需物化。
 * - React 来自**浏览器模块表**（`require('react')`），用的是宿主自己的 React 18。
 *   因此本插件**不需要安装 React、不需要打包器、不需要 npm 依赖**——
 *   这也是官方模板的做法（手写该包装，零构建）。
 * - **不导入任何 `@deepseek-ai/*` 客户端包**：官方明确要求（它们可能随时变更，
 *   且组件抛错会让整个 slot 条目变空白）。样式只用宿主主题 token。
 *
 * 本阶段刻意**不实现**：设计写回、版本管理、MCP 挂载、完整设计渲染。
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

    /** 本阶段只展示这一个版本；后续由真实数据源替换。 */
    const DESIGN_VERSION = 'demo-0.1';
    /** 设计契约里的 accent 值。注意：它是**数据**，用色块展示；不用于 UI 装饰。 */
    const DESIGN_ACCENT = '#ED8B43';

    const COPY = {
      zh: {
        'type.label': 'DesignBridge',
        'guide.title': 'DesignBridge',
        'guide.description': '查看设计版本与预览',
        'panel.heading': 'DesignBridge Studio',
        'panel.subheading': '设计版本预览 · 最小可行性验证',
        'panel.versionLabel': '设计版本',
        'panel.accentLabel': '主色（来自设计契约）',
        'panel.tabLabel': 'Tab 类型',
        'panel.testButton': '点我测试交互',
        'panel.clickCount': '已点击 {n} 次',
        'panel.neverClicked': '尚未点击',
        'panel.note':
          '本面板只验证插件可行性：显示版本与一个可点击按钮。设计写回、版本管理与完整渲染不在本阶段。',
      },
      en: {
        'type.label': 'DesignBridge',
        'guide.title': 'DesignBridge',
        'guide.description': 'View design version and preview',
        'panel.heading': 'DesignBridge Studio',
        'panel.subheading': 'Design version preview - minimal feasibility check',
        'panel.versionLabel': 'Design version',
        'panel.accentLabel': 'Accent (from design contract)',
        'panel.tabLabel': 'Tab kind',
        'panel.testButton': 'Click to test interaction',
        'panel.clickCount': 'Clicked {n} time(s)',
        'panel.neverClicked': 'Not clicked yet',
        'panel.note':
          'This panel only validates plugin feasibility: it shows the version and one clickable button. Design write-back, versioning and full rendering are out of scope for this stage.',
      },
    };

    /**
     * 样式：**只引用宿主主题 token**（`--dsw-alias-*` / `--dsw-font-*`）。
     * 不硬编码任何 UI 颜色——硬编码会在深色主题下失配，也会随宿主改版而过时。
     * 唯一出现的字面色值 `#ED8B43` 是用色块展示的**设计数据**（accent swatch），
     * 属于 artwork 而非界面装饰。
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
.db-studio-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.db-studio-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.db-studio-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-l1);
}
.db-studio-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.db-studio-key { color: var(--dsw-alias-label-secondary); }
.db-studio-value { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.db-studio-mono { font-family: var(--dsw-font-family); letter-spacing: 0.01em; }
.db-studio-swatch {
  display: inline-block;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l2);
  vertical-align: -4px;
  margin-right: 8px;
}
.db-studio-button {
  appearance: none;
  align-self: flex-start;
  padding: 8px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
}
.db-studio-button:hover { background: var(--dsw-alias-button-primary-hover); }
.db-studio-button:active { transform: translateY(1px); }
.db-studio-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.db-studio-state { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.db-studio-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
`;

    /**
     * 组件局部样式以 React 元素渲染 —— 组件卸载时随之移除，无需手工清理，
     * 也不会污染宿主全局样式（官方推荐做法之一）。
     */
    function StyleTag() {
      return h('style', { 'data-designbridge-studio': 'styles' }, CSS);
    }

    function row(label, value, key) {
      return h(
        'div',
        { className: 'db-studio-row', key },
        h('span', { className: 'db-studio-key' }, label),
        h('span', { className: 'db-studio-value db-studio-mono' }, value),
      );
    }

    /** 面板正文。注册进 `sidebar.right.pane.tab`，key = TAB_ID。 */
    function Panel() {
      const [clicks, setClicks] = React.useState(0);
      const t = useTranslate();

      const accentNode = h(
        'span',
        { className: 'db-studio-value db-studio-mono' },
        h('span', {
          className: 'db-studio-swatch',
          style: { background: DESIGN_ACCENT },
          'aria-hidden': true,
        }),
        DESIGN_ACCENT,
      );

      return h(
        'div',
        { className: 'db-studio-root', 'data-designbridge-studio': 'panel' },
        h(StyleTag, { key: 'style' }),
        h(
          'div',
          { className: 'db-studio-head', key: 'head' },
          h('div', { className: 'db-studio-title' }, t('panel.heading')),
          h('div', { className: 'db-studio-sub' }, t('panel.subheading')),
        ),
        h(
          'div',
          { className: 'db-studio-card', key: 'card' },
          row(t('panel.versionLabel'), DESIGN_VERSION, 'version'),
          h(
            'div',
            { className: 'db-studio-row', key: 'accent' },
            h('span', { className: 'db-studio-key' }, t('panel.accentLabel')),
            accentNode,
          ),
          row(t('panel.tabLabel'), TAB_KIND, 'kind'),
        ),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'db-studio-button',
            onClick: () => setClicks((n) => n + 1),
          },
          t('panel.testButton'),
        ),
        h(
          'div',
          { className: 'db-studio-state', key: 'state', role: 'status', 'aria-live': 'polite' },
          clicks === 0 ? t('panel.neverClicked') : t('panel.clickCount').replace('{n}', String(clicks)),
        ),
        h('div', { className: 'db-studio-note', key: 'note' }, t('panel.note')),
      );
    }

    // ── 文案 ────────────────────────────────────────────────────────────────
    // 官方要求"可见文案走 Client locale 服务"。这里用一个最小的绑定：
    // 优先用宿主 locale 提供的翻译，未注册/缺失时回退到内置 COPY。
    let translate = (key) => COPY.zh[key] ?? key;

    function useTranslate() {
      return translate;
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'locale'],
      apply(ctx) {
        if (ctx.locale !== undefined) {
          ctx.effect(() => ctx.locale.register(NAMESPACE, COPY), 'designbridge-studio.copy');
          const bound = ctx.locale.bind(NAMESPACE);
          translate = (key) => {
            const value = bound(key);
            return value === undefined || value === null || value === '' ? (COPY.zh[key] ?? key) : value;
          };
        }

        // 1) 声明一个右栏 tab 类型；同时提供一个引导页入口，用户据此打开它。
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

        // 2) 面板正文。slot 按 `key` 与上面注册的类型 id 对应。
        ctx.effect(
          () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
              },
              Panel,
            ),
          'designbridge-studio.pane',
        );
      },
    };
  },
});
