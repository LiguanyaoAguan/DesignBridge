/**
 * DesignBridge Studio 插件 —— 渲染冒烟检查（不安装任何依赖）。
 *
 * 目的：在没有挂载到 Harness 的情况下，尽早证明 client.js **能真的渲染**，
 * 而不是只通过语法检查。做法是提供最小宿主桩：
 *   - 桩掉 `window.__ModuleLoader__.load`
 *   - 桩掉 `require`，把 `react` / `react-dom/server` 指到宿主已装的那份
 *   - 用假 `ctx` 捕获插件注册，取出面板组件并用 renderToStaticMarkup 渲染
 *
 * 用法（React 从宿主安装目录解析，避免把本机绝对路径写进仓库）：
 *
 *   DSH_NODE_MODULES="<dsh 安装目录>/node_modules" \
 *     node checks/render-check.mjs
 *
 * 退出码 0 = 全部通过。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plugin_root = join(here, '..');
const client_path = join(plugin_root, 'client.js');

const dsh_node_modules = process.env.DSH_NODE_MODULES;
if (!dsh_node_modules) {
  console.error('缺少 DSH_NODE_MODULES：请指向 dsh 安装目录下的 node_modules。');
  console.error('例如：DSH_NODE_MODULES=/path/to/dsh/node_modules node checks/render-check.mjs');
  process.exit(2);
}

const host_require = createRequire(join(dsh_node_modules, 'noop.js'));
const React = host_require('react');

/**
 * 最小 hooks 桩。
 *
 * 为什么不用 react-dom/server：**设备上根本没有安装 react-dom**——
 * 宿主把它直接打进 Web 前端产物了，独立包不存在。为了不安装任何依赖，
 * 这里只借用宿主 React 的 `createElement`（纯函数），并把 `useState` 换成一个
 * 静态桩，然后由本脚本遍历组件返回的元素树自行序列化。
 *
 * ⚠️ 明确边界：这**不是**完整渲染器，不覆盖提交、副作用、DOM 属性语义。
 *    它证明的是：组件能被调用、不抛错、产出的树内容正确、且样式约束成立。
 */
function make_hooks_stub() {
  return {
    createElement: React.createElement,
    Fragment: React.Fragment,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  };
}

/** 把元素树序列化成 HTML 风格字符串，便于断言内容与样式。 */
function serialize(node, out) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) {
    for (const child of node) serialize(child, out);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return;
  }
  if (typeof node !== 'object') return;

  const { type, props } = node;
  if (typeof type === 'function') {
    // 函数组件：直接调用（hooks 已桩化）
    serialize(type(props ?? {}), out);
    return;
  }
  if (typeof type !== 'string') return;

  const attributes = [];
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'children') continue;
    if (value === undefined || value === null || value === false) continue;
    if (key === 'style' && typeof value === 'object') {
      const css = Object.entries(value)
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`)
        .join(';');
      attributes.push(` style="${css}"`);
      continue;
    }
    if (key === 'key') continue;
    attributes.push(` ${key}="${String(value).replace(/"/g, '&quot;')}"`);
  }
  out.push(`<${type}${attributes.join('')}>`);
  serialize(props?.children, out);
  out.push(`</${type}>`);
}

function render_static(component) {
  const out = [];
  serialize(React.createElement(component), out);
  return out.join('');
}

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`  ❌ ${name} — ${error && error.message ? error.message : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('DesignBridge Studio 插件渲染冒烟检查');
console.log(`  React（宿主 createElement）: ${React.version}`);
console.log('  渲染方式: 最小 hooks 桩 + 自写序列化（非 react-dom/server）');
console.log('');

// ── 1. 装载 client.js：桩掉 window.__ModuleLoader__ ─────────────────────────
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry;
    },
  },
};

const source = readFileSync(client_path, 'utf8');
// 用 indirect eval 在全局作用域执行，等价于宿主加载该 bundle 的方式。
(0, eval)(source);

check('client.js 注册了模块工厂', () => {
  assert(loaded !== null, 'window.__ModuleLoader__.load 未被调用');
  return `id=${loaded.id}`;
});

check('模块 id 与包名一致', () => {
  const pkg = JSON.parse(readFileSync(join(plugin_root, 'package.json'), 'utf8'));
  assert(loaded.id === pkg.name, `id=${loaded.id} 与包名 ${pkg.name} 不一致`);
  return loaded.id;
});

// ── 2. 用宿主模块表满足 factory 的 require ──────────────────────────────────
const hooks_stub = make_hooks_stub();
const factory_require = (name) => {
  if (name === 'react') return hooks_stub;
  throw new Error(`插件不应请求模块：${name}`);
};

let plugin = null;
check('工厂可执行且返回插件对象', () => {
  plugin = loaded.factory(factory_require);
  assert(plugin && typeof plugin.apply === 'function', '未返回带 apply 的插件对象');
  assert(Array.isArray(plugin.inject), 'inject 应为数组');
  return `inject=${plugin.inject.join(',')}`;
});

check('inject 不含任何 @deepseek-ai 客户端包', () => {
  const bad = plugin.inject.filter((s) => String(s).startsWith('@deepseek-ai/'));
  assert(bad.length === 0, `不应注入 Harness 包：${bad.join(',')}`);
  return plugin.inject.join(', ');
});

// ── 3. 假 ctx：捕获注册，并验证 cleanup 形态 ────────────────────────────────
const registrations = [];
const inject_calls = [];
const locale_copy = {};
let locale_bound = null;

const ctx = {
  locale: {
    register(namespace, copy) {
      locale_copy[namespace] = copy;
      return () => {};
    },
    bind(namespace) {
      locale_bound = namespace;
      return (key) => locale_copy[namespace]?.[key];
    },
  },
  sidebarRightTabs: {
    register(definition) {
      registrations.push({ kind: 'sidebarRightTabs', definition });
      return () => {};
    },
  },
  slots: {
    register(options, component) {
      registrations.push({ kind: 'slots', options, component });
      return () => {};
    },
    // 对照宿主 dsh-client-ui-renderer 的 inject(key, callback)：
    // 订阅 key 的 declaration epoch；此处模拟"slot 已声明"，故同步执行回调。
    inject(key, callback) {
      inject_calls.push(key);
      const dispose = callback();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  },
  effect(fn, label) {
    const dispose = fn();
    assert(typeof dispose === 'function', `effect(${label}) 必须返回清理函数`);
    registrations.push({ kind: 'effect', label });
    return dispose;
  },
};

check('apply(ctx) 不抛错', () => {
  plugin.apply(ctx);
  return `${registrations.length} 项注册`;
});

check('注册了一个 sidebarRightTabs 类型', () => {
  const tabs = registrations.filter((r) => r.kind === 'sidebarRightTabs');
  assert(tabs.length === 1, `应恰好 1 个，实际 ${tabs.length}`);
  const d = tabs[0].definition;
  assert(typeof d.id === 'string' && d.id.length > 0, '缺少 id');
  assert(typeof d.kind === 'string' && d.kind.length > 0, '缺少 kind');
  assert(typeof d.title === 'function', 'title 应为函数');
  return `id=${d.id} kind=${d.kind}`;
});

check('引导页提供了可打开的入口', () => {
  const d = registrations.find((r) => r.kind === 'sidebarRightTabs').definition;
  assert(Array.isArray(d.guide) && d.guide.length > 0, 'guide 至少一个入口');
  const entry = d.guide[0];
  assert(typeof entry.id === 'string' && entry.id.length > 0, 'guide 条目缺 id');
  assert(typeof entry.title === 'function', 'guide 条目 title 应为函数');
  return entry.id;
});

check('注册了 sidebar.right.pane.tab 正文，key 与类型 id 对应', () => {
  const pane = registrations.filter((r) => r.kind === 'slots' && r.options.name === 'sidebar.right.pane.tab');
  assert(pane.length === 1, `应恰好 1 个，实际 ${pane.length}`);
  const tab_id = registrations.find((r) => r.kind === 'sidebarRightTabs').definition.id;
  assert(pane[0].options.key === tab_id, `key=${pane[0].options.key} 与类型 id=${tab_id} 不一致`);
  assert(typeof pane[0].component === 'function', '正文应为组件');
  return `key=${pane[0].options.key}`;
});

check('面板正文经 ctx.slots.inject 贡献（官方写法）', () => {
  assert(inject_calls.length === 1, `应恰好 1 次 slots.inject，实际 ${inject_calls.length}`);
  assert(
    inject_calls[0] === 'sidebar.right.pane.tab',
    `inject 的 key 应为 sidebar.right.pane.tab，实际 ${inject_calls[0]}`,
  );
  return `inject(${inject_calls[0]})`;
});

check('未注册任何不在白名单内的 slot', () => {
  const names = registrations.filter((r) => r.kind === 'slots').map((r) => r.options.name);
  const allowed = new Set(['sidebar.right.pane.tab']);
  const bad = names.filter((n) => !allowed.has(n));
  assert(bad.length === 0, `出现未预期 slot：${bad.join(',')}`);
  return names.join(', ');
});

check('每个 ctx.effect 都带标签且返回清理函数', () => {
  const labels = registrations.filter((r) => r.kind === 'effect').map((r) => r.label);
  assert(labels.length >= 2, `effect 数量偏少：${labels.length}`);
  assert(labels.every((l) => typeof l === 'string' && l.length > 0), '存在空标签');
  return labels.join(', ');
});

// ── 4. 真的渲染面板 ─────────────────────────────────────────────────────────
check('面板可被调用并产出元素树（最小 hooks 桩，非完整渲染器）', () => {
  const pane = registrations.find((r) => r.kind === 'slots' && r.options.name === 'sidebar.right.pane.tab');
  const html = render_static(pane.component);
  assert(html.length > 0, '渲染结果为空');
  globalThis.__html = html;
  return `${html.length} 字符`;
});

check('渲染结果包含标题与设计版本', () => {
  const html = globalThis.__html;
  assert(html.includes('DesignBridge Studio'), '缺少面板标题');
  assert(html.includes('demo-0.1'), '缺少设计版本');
  return '标题与 demo-0.1 均在';
});

check('渲染结果包含可点击的测试按钮', () => {
  const html = globalThis.__html;
  assert(/<button[^>]*type="button"/.test(html), '未渲染出 button');
  assert(html.includes('点我测试交互'), '按钮文案缺失');
  return 'button 已渲染';
});

check('渲染结果中的 UI 颜色只来自主题 token', () => {
  const html = globalThis.__html;
  // 允许出现的字面色值仅有 accent 色块（设计数据）；其余 UI 颜色必须走 var(--dsw-…)
  const literals = [...html.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toUpperCase());
  const unexpected = literals.filter((c) => c !== '#ED8B43');
  assert(unexpected.length === 0, `出现硬编码 UI 颜色：${[...new Set(unexpected)].join(', ')}`);
  const token_uses = [...html.matchAll(/var\(--dsw-[a-z0-9-]+\)/g)].length;
  assert(token_uses >= 6, `主题 token 使用过少：${token_uses}`);
  return `字面色值仅 #ED8B43（数据色块），token 引用 ${token_uses} 处`;
});

check('文案通过 locale 服务注册', () => {
  assert(locale_bound !== null, '未调用 ctx.locale.bind');
  const copy = locale_copy[locale_bound];
  assert(copy && copy.zh && copy.en, '应同时提供 zh 与 en');
  return `namespace=${locale_bound}`;
});

// ── 5. 源码级约束 ───────────────────────────────────────────────────────────
check('client.js 不导入任何 Harness 客户端包', () => {
  const bad = [...source.matchAll(/require\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert(bad.length === 0, `出现 Harness 包引用：${bad.join(', ')}`);
  return '仅 require("react")';
});

check('client.js 用 slots.inject 包装，且 slot 仍用 key 而非 id', () => {
  assert(
    /ctx\.slots\.inject\(\s*'sidebar\.right\.pane\.tab'/.test(source),
    "应使用 ctx.slots.inject('sidebar.right.pane.tab', ...) 包装",
  );
  const pane_reg = source.match(/name: 'sidebar\.right\.pane\.tab',[\s\S]{0,120}?\}/);
  assert(pane_reg !== null, '未找到 pane 注册块');
  assert(/key:\s*TAB_ID/.test(pane_reg[0]), `pane 注册应使用 key: TAB_ID，实际片段：${pane_reg[0]}`);
  assert(!/\bid:\s*TAB_ID/.test(pane_reg[0]), 'pane 注册不应使用 id');
  return 'slots.inject + key: TAB_ID';
});

check('client.js 不含 eval / new Function / document.body 注入', () => {
  for (const forbidden of ['eval(', 'new Function', 'document.body', 'innerHTML']) {
    assert(!source.includes(forbidden), `不应出现 ${forbidden}`);
  }
  return '无动态执行、无全局 DOM 注入';
});

console.log('');
if (failures === 0) {
  console.log('全部通过。');
  process.exit(0);
}
console.log(`失败 ${failures} 项。`);
process.exit(1);
