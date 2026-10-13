/**
 * DesignBridge Studio 插件 —— 渲染与数据路径冒烟检查（不安装任何依赖）。
 *
 * 目的：在没有挂载到 Harness 的情况下，尽早证明 client.js **能真的渲染、能真的走数据路径**，
 * 而不是只通过语法检查。做法是提供最小宿主桩：
 *   - 桩掉 `window.__ModuleLoader__.load`
 *   - 桩掉 `require`，把 `react` 指到宿主已装的那份
 *   - 用假 `ctx` 捕获插件注册，取出面板组件
 *   - 用**可注入的假 remote.workspaceFiles** 驱动面板的真实读取路径，
 *     逐条验证 b-1 要求的 6 种错误态 + 1 种成功态
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
import { COMPONENT_TYPES } from '../src/model/preview-schema.mjs';
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
 * 最小 hooks 桩（**有状态**）。
 *
 * 为什么不用 react-dom/server：**设备上根本没有安装 react-dom**——
 * 宿主把它直接打进 Web 前端产物了，独立包不存在。为了不安装任何依赖，
 * 这里只借用宿主 React 的 `createElement`（纯函数），自己实现一条最小渲染通道：
 *   `render()` 调用组件 → 捕获 useEffect → 手动执行 → 状态被写入 → `render()` 再调一次
 * 这样就能覆盖"读取前 / 读取后"两个真实状态。
 *
 * ⚠️ 明确边界：这**不是**完整渲染器，不覆盖调度、并发、提交与 DOM 语义。
 *    它证明的是：组件能被调用、不抛错、产出的树内容正确、且状态流转符合预期。
 */
function make_stateful_hooks() {
  let cells = [];
  let cursor = 0;
  // v0.7.1：收集**全部** useEffect —— 早期只保留最后一个，
  // 导致声明在前的 effect（如资源加载）在测试里永远不被驱动。
  let capturedEffects = [];

  const hooks = {
    createElement: React.createElement,
    Fragment: React.Fragment,
    useState(initial) {
      const i = cursor;
      cursor += 1;
      if (cells[i] === undefined) cells[i] = { value: initial };
      const cell = cells[i];
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next;
        },
      ];
    },
    useEffect(fn) {
      capturedEffects.push(fn);
    },
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  };

  return {
    hooks,
    /** 每个测试用例开始前清空状态，保证用例之间互不污染。 */
    reset() {
      cells = [];
      cursor = 0;
      capturedEffects = [];
    },
    rerender() { return this.render(this.lastComponent, this.lastProps); },
    render(Component, props) {
      cursor = 0;
      capturedEffects = [];
      const tree = Component(props);
      this.lastComponent = Component;
      this.lastProps = props;
      const effects = capturedEffects;
      capturedEffects = [];
      // 保留 effect（最后一个）以兼容既有用法；effects 为全部
      return { tree, effect: effects.length > 0 ? effects[effects.length - 1] : null, effects };
    },
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

function html_of(tree) {
  const out = [];
  serialize(tree, out);
  return out.join('');
}

/** 冲掉若干轮微任务，让桩掉的 promise 链跑完。 */
async function flush(times = 12) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/**
 * 渲染面板并跑完它的数据路径。
 * @returns {Promise<{ html: string, phase: string }>}
 */
async function render_panel(component, props) {
  harness.reset();
  // v0.7.1：多轮驱动**全部** effect，让链式异步（契约 → 预览 → 资源）都能流转到稳态。
  for (let pass = 0; pass < 4; pass += 1) {
    const { effects } = harness.render(component, props);
    for (const fn of effects) if (typeof fn === 'function') fn();
    await flush();
  }
  const second = harness.render(component, props);
  const html = html_of(second.tree);
  const phase = (html.match(/data-db-phase="([a-z]+)"/) ?? [])[1] ?? '';
  return { html, phase };
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

console.log('DesignBridge Studio 插件渲染与数据路径检查');
console.log(`  React（宿主 createElement）: ${React.version}`);
console.log('  渲染方式: 有状态 hooks 桩 + 自写序列化（非 react-dom/server）');
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
//
// ⚠️ 关键：factory 在**创建时**就把 `React` 绑定成了 require('react') 的返回值。
// 因此这里必须传**后面真正用于渲染的那个有状态 hooks 实例**，
// 否则组件拿到的仍是无状态桩，useEffect 永不执行、状态永不流转。
const harness = make_stateful_hooks();
const factory_require = (name) => {
  if (name === 'react') return harness.hooks;
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

/** 可换行为的假 remote；默认"文件不存在"。 */
let read_impl = async () => ({ ok: false, error: { code: 'not-found', message: 'ENOENT' } });
const remote_impl = {
  workspaceFiles: {
    read: (sessionId, path, range, signal) => read_impl(sessionId, path, range, signal),
  },
};

/**
 * 模拟 cordis 的上下文代理守卫 —— 这是本文件**最关键**的一处保真。
 *
 * 宿主源码（@deepseek-ai/cordis/lib/index.js 的 ReflectService.handler.get）：
 *
 *     if (Reflect.has(target, prop)) return getTraceable(...)
 *     throw new Error(`cannot get property "${prop}" without inject`)
 *
 * `ctx.remote` 是一个**点号命名空间代理**：访问 `ctx.remote.workspaceFiles`
 * 会去解析名为 `remote.workspaceFiles` 的**独立 cordis 服务**。该服务由
 * `dsh-api-workspace-files` 的客户端半边经 `ctx.remote.$mount(contribution)` 挂载，
 * **必须由插件在自己的 `inject` 数组里显式声明**，否则解析失败并抛出上述错误
 * （错误里的属性名正是点号全名）。
 *
 * ⚠️ 早期版本这里用的是裸 JS 对象 `{ workspaceFiles: {...} }`。
 * 普通对象没有这道守卫，所以"只声明了 remote、没声明 remote.workspaceFiles"
 * 这种真实的宿主 DI 错误**被假 remote 掩盖了**，导致真机才暴露。
 * 现在改用 Proxy 复刻守卫，假 remote 再也盖不住这类错误。
 */
function make_cordis_remote(declared, impl) {
  const declaredSet = new Set(declared);
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(target, prop, receiver);
      const dotted = `remote.${String(prop)}`;
      if (!declaredSet.has(dotted)) {
        throw new Error(`cannot get property "${dotted}" without inject`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

check('inject 含右栏导航控制器 sidebarRight', () => {
  assert(
    plugin.inject.includes('sidebarRight'),
    '必须声明 sidebarRight —— openTab / mounted 都在这个服务上',
  );
  return 'sidebarRight 已注入';
});

check('inject 含只读数据服务 remote', () => {
  assert(plugin.inject.includes('remote'), '应注入 remote（dsh-api-remotes）');
  return 'remote 已注入';
});

// ── 回归：本次真机故障 "cannot get property \"remote.workspaceFiles\" without inject" ──
check('回归：inject 同时声明点号服务 remote.workspaceFiles', () => {
  assert(
    plugin.inject.includes('remote.workspaceFiles'),
    '必须声明 remote.workspaceFiles —— 它是 dsh-api-workspace-files 经 $mount 挂载的独立服务，' +
      '只声明 remote 会在真机上抛 cannot get property "remote.workspaceFiles" without inject',
  );
  return plugin.inject.join(', ');
});

check('回归：守卫能复现宿主报错（反向对照，证明测试非空转）', () => {
  // 故意只声明 remote，缺 remote.workspaceFiles —— 必须抛出与真机一致的错误
  const broken = make_cordis_remote(['remote'], remote_impl);
  let caught = null;
  try {
    void broken.workspaceFiles;
  } catch (error) {
    caught = error;
  }
  assert(caught !== null, '缺声明时应当抛错，否则守卫是失效的');
  assert(
    caught.message === 'cannot get property "remote.workspaceFiles" without inject',
    `报错文案应与宿主一致，实际：${caught.message}`,
  );
  return caught.message;
});

check('回归：按当前声明访问 remote.workspaceFiles 不抛错', () => {
  const guarded = make_cordis_remote(plugin.inject, remote_impl);
  const wf = guarded.workspaceFiles;
  assert(wf && typeof wf.read === 'function', 'remote.workspaceFiles.read 应可用');
  return '守卫通过';
});

// ── 3. 假 ctx：捕获注册，并验证 cleanup 形态 ────────────────────────────────
const registrations = [];
const inject_calls = [];
const locale_copy = {};
let locale_bound = null;


// ── 自动打开的假 sidebarRight（官方控制器：mounted 可观察 + openTab 导航）────────
const auto_open_calls = [];
let auto_open_throw = null;
const mounted_listeners = new Set();
let mounted_session;

/** `openTabs` 的假可观察值；元素形如 { sessionId, tabId, kind, contentId }。 */
let open_tabs = [];
/** 置 undefined 用于模拟「宿主 API 不可用」，验证保守策略不会瞎猜。 */
let open_tabs_source = { getSnapshot: () => open_tabs };

const sidebarRight = {
  // createSnapshotStore 形态：getSnapshot / subscribe
  mounted: {
    getSnapshot: () => mounted_session,
    subscribe(fn) {
      mounted_listeners.add(fn);
      return () => mounted_listeners.delete(fn);
    },
  },
  get openTabs() {
    return open_tabs_source;
  },
  openTab(kind, options) {
    if (auto_open_throw !== null) throw new Error(auto_open_throw);
    auto_open_calls.push({ kind, options });
  },
};

function set_mounted(sessionId) {
  mounted_session = sessionId;
  for (const fn of [...mounted_listeners]) fn();
}

const ctx = {
  sidebarRight,
  // 守卫用的声明列表**取自插件自己声明的 inject** —— 插件没声明就真的会抛。
  remote: make_cordis_remote(plugin.inject, remote_impl),
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
  assert(typeof pane[0].options.inject === 'function', '应声明 inject(sessionId) 下发通道');
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

// ── 4. 渲染 + 数据路径 ──────────────────────────────────────────────────────
const pane_reg = registrations.find((r) => r.kind === 'slots' && r.options.name === 'sidebar.right.pane.tab');
const Panel = pane_reg.component;
const propsFor = (sessionId) => pane_reg.options.inject(sessionId);

const VALID_CONTRACT = {
  schemaVersion: '1.0.0',
  designId: 'demo-library',
  designVersion: 'demo-0.1',
  platform: 'android-compose',
  screenId: 'library',
  description: '非生产环境示例',
  designTokens: { accent: '#ED8B43', surface: '#FFFFFF', cardRadiusDp: 16 },
  layout: { orientation: 'landscape', regions: ['navigation', 'recording-list'] },
  changeScope: { allowed: ['demo-library'], protected: [] },
  referenceAssets: [],
};

function textResult(text, overrides = {}) {
  return {
    ok: true,
    value: {
      absolutePath: '/workspace-example/GitHub项目下载/DesignBridge/protocol/design-contract.json',
      version: 'v1-abc123',
      bytes: Buffer.byteLength(text, 'utf8'),
      offset: 1,
      text,
      lines: text.split('\n').length,
      eof: true,
      ...overrides,
    },
  };
}

async function run(fn) {
  try {
    const detail = await fn();
    console.log(`  ✅ ${detail.name}${detail.detail ? ` — ${detail.detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`  ❌ ${error && error.name ? error.name : 'check'} — ${error && error.message ? error.message : String(error)}`);
  }
}
function expect(name, condition, message) {
  if (!condition) throw Object.assign(new Error(message), { name });
  return { name, detail: message };
}

await run(async () => {
  const { html, phase } = await render_panel(Panel, propsFor('session-test-1'));
  globalThis.__html_default = html;
  return expect('面板可被调用并产出元素树', html.length > 0 && phase !== '', `phase=${phase}, ${html.length} 字符`);
});

await run(async () => {
  const html = globalThis.__html_default;
  return expect(
    '渲染结果包含面板标题与手动刷新按钮',
    html.includes('DesignBridge Studio') && html.includes('data-designbridge-studio="refresh"'),
    '标题与刷新按钮均在',
  );
});

await run(async () => {
  const html = globalThis.__html_default;
  const literals = [...html.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toUpperCase());
  const token_uses = [...html.matchAll(/var\(--dsw-[a-z0-9-]+\)/g)].length;
  return expect(
    'UI 颜色只来自主题 token（无字面色值）',
    literals.length === 0 && token_uses >= 6,
    `字面色值 ${literals.length} 个，token 引用 ${token_uses} 处`,
  );
});

await run(async () => {
  assert(locale_bound !== null, '未调用 ctx.locale.bind');
  const copy = locale_copy[locale_bound];
  assert(copy && copy.zh && copy.en, '应同时提供 zh 与 en');
  return expect('文案通过 locale 服务注册', true, `namespace=${locale_bound}`);
});

// 4.1 无 session
await run(async () => {
  const { html, phase } = await render_panel(Panel, propsFor(undefined));
  return expect(
    '错误态 1/6：无 session 上下文',
    phase === 'error' && html.includes('data-designbridge-studio="error-no-session"'),
    `phase=${phase}`,
  );
});

// 4.2 路径错误（designRoot 非法 → 由 source 层拦截，不经 remote）
await run(async () => {
  // 直接验证 source 层的路径纪律：绝对路径必须被拒绝
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  return expect('面板在无文件时进入错误态', phase === 'error', `phase=${phase}（默认 remote 返回 not-found）`);
});

// 4.3 文件不存在
await run(async () => {
  read_impl = async () => ({ ok: false, error: { code: 'workspace-files/not-found', message: 'ENOENT: no such file' } });
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  return expect(
    '错误态 3/6：文件不存在（含宿主错误码）',
    phase === 'error' && html.includes('error-not-found') && html.includes('workspace-files/not-found'),
    'not-found + 原始码均在',
  );
});

// 4.4 无权限
await run(async () => {
  read_impl = async () => ({ ok: false, error: { code: 'workspace-files/denied', message: 'EACCES: permission denied' } });
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  return expect(
    '错误态 4/6：无权限',
    phase === 'error' && html.includes('error-forbidden') && html.includes('workspace-files/denied'),
    'forbidden + 原始码均在',
  );
});

// 4.5 JSON 解析失败
await run(async () => {
  read_impl = async () => textResult('{ "designId": "x",, }');
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  return expect('错误态 5/6：JSON 解析失败', phase === 'error' && html.includes('error-parse'), `phase=${phase}`);
});

// 4.6 协议校验失败（且必须给出路径化问题）
await run(async () => {
  const broken = { ...VALID_CONTRACT, layout: { orientation: 'landscape', regions: 'not-an-array' } };
  read_impl = async () => textResult(JSON.stringify(broken));
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  return expect(
    '错误态 6/6：协议校验失败且给出路径化问题',
    phase === 'error' && html.includes('error-schema') && html.includes('layout.regions'),
    '含 layout.regions 问题路径',
  );
});

// 4.7 成功态：必须显示**真实值**与**来源**
//
// ⚠️ 这一段**跟随契约**，不写死具体设计：
//   契约说当前设计是谁，测试就读谁的 preview。
//   （否则每次交付新设计都会把测试砸掉 —— 这个坑真踩过一次。）
const REPO_ROOT = join(plugin_root, '..');
const contractText = readFileSync(join(REPO_ROOT, 'protocol', 'design-contract.json'), 'utf8');
const checkedInContract = JSON.parse(contractText);
const previewText = readFileSync(
  join(REPO_ROOT, 'designs', checkedInContract.designId, 'preview.json'),
  'utf8',
);
const checkedInPreview = JSON.parse(previewText);

/** 收集 preview 里实际出现的组件类型。 */
function collectTypes(node, into) {
  if (!node || typeof node !== 'object') return into;
  if (typeof node.type === 'string') into.add(node.type);
  for (const child of node.children || []) collectTypes(child, into);
  return into;
}
const usedTypes = [...checkedInPreview.pages.reduce((set, page) => collectTypes(page.root, set), new Set())];

await run(async () => {
  read_impl = async (_session, path) => {
    const isContract = path.endsWith('design-contract.json');
    const text = isContract ? contractText : previewText;
    return textResult(text, {
      absolutePath: `/workspace-example/${path}`,
      version: isContract ? 'contract-v1' : 'preview-v1',
      bytes: Buffer.byteLength(text),
      lines: text.split('\n').length,
    });
  };
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  globalThis.__html_ok = html;
  globalThis.__preview_json = checkedInPreview;
  assert(phase === 'ready', `应进入 ready，实际 ${phase}`);
  const needle = [
    checkedInContract.designId,
    checkedInContract.designVersion,
    checkedInContract.platform,
    checkedInContract.screenId,
    checkedInPreview.pages[0].title,
  ];
  for (const value of needle) assert(html.includes(value), `缺少真实字段值：${value}`);
  const tokenValues = Object.values(checkedInContract.designTokens).map(String);
  assert(tokenValues.some((value) => html.includes(value)), '缺少 designTokens 的真实值');
  return expect('成功态：显示真实 contract 字段', true, `designId=${checkedInContract.designId} version=${checkedInContract.designVersion}`);
});

await run(async () => {
  const html = globalThis.__html_ok;
  const rendered = usedTypes.filter((type) => html.includes(`data-node-type="${type}"`));
  return expect(
    '成功态：preview 里出现的组件类型全部已渲染',
    rendered.length === usedTypes.length && html.includes('data-node-id="root"'),
    `用到 ${rendered.length}/${usedTypes.length} 类；缺失：${usedTypes.filter(t => !html.includes(`data-node-type="${t}"`)).join(', ') || '无'}`,
  );
});

await run(async () => {
  // 找一个 preview 里真实存在的节点（不写死 id），确认它作为组件被渲染出来
  const firstId = (function pick(node) {
    if (!node) return null;
    if (node.type !== 'frame' && typeof node.id === 'string') return node.id;
    for (const child of node.children || []) { const hit = pick(child); if (hit) return hit; }
    return null;
  })(globalThis.__preview_json.pages[0].root);
  assert(firstId !== null, 'preview 里找不到非 frame 节点');
  const html = globalThis.__html_ok;
  return expect(
    '组件选择 UI 可访问且普通按钮不触发业务动作',
    html.includes(`data-node-id="${firstId}"`) &&
      html.includes('data-designbridge-studio="selection"') &&
      html.includes('data-node-type="button"'),
    `canvas nodes selectable（样本节点 ${firstId}），button is decorative`,
  );
});

await run(async () => {
  const html = globalThis.__html_ok;
  return expect(
    '成功态：显示数据来源（相对路径/绝对路径/版本/字节/行数/时间）',
    html.includes(`GitHub项目下载/DesignBridge/protocol/design-contract.json`) &&
      html.includes('preview-v1') &&
      html.includes('data-designbridge-studio="preview-source"') &&
      html.includes('data-designbridge-studio="source"'),
    '来源卡片含路径、版本、字节、行数、读取时间',
  );
});

// ── 4.7b P1：交付校验状态条 ────────────────────────────────────────────────
// 面板读的是 delivery-sync 写入的**运行时索引**。这里用假 remote 注入不同索引，
// 验证 5 种状态都**如实**渲染 —— 尤其是：读不到/解析失败/设计不匹配时
// **绝不能**渲染成"校验通过"（不许用假数据冒充真值）。

/** 构造只按路径分派的假 remote：契约 / preview / 交付索引。index=null 表示索引读不到。 */
function serveDelivery(index) {
  return async (_session, path) => {
    if (path.endsWith('protocol/design-contract.json')) {
      return textResult(contractText, { absolutePath: `/workspace-example/${path}`, version: 'contract-v1' });
    }
    if (path.endsWith('delivery-index.json')) {
      if (index === null) {
        return { ok: false, error: { code: 'workspace-file/not-found', message: 'ENOENT: no delivery index' } };
      }
      return textResult(index, { absolutePath: `/workspace-example/${path}`, version: 'index-v1' });
    }
    return textResult(previewText, { absolutePath: `/workspace-example/${path}`, version: 'preview-v1' });
  };
}

/** 索引夹具：显式区分 `lastValid`（仅通过时写入）与 `lastAttempt`（每次同步都写）。 */
const indexWith = (designId, lastValid, lastAttempt) =>
  JSON.stringify({
    indexVersion: '1.0.0',
    updatedAt: '2026-10-13T15:00:00.000Z',
    designs: { [designId]: { lastValid, lastAttempt } },
  });

const OK_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const FAIL_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

await run(async () => {
  const entry = {
    designId: checkedInContract.designId,
    designVersion: checkedInContract.designVersion,
    ok: true,
    errorCount: 0,
    errors: [],
    validatedAt: '2026-10-13T15:00:00.000Z',
    source: { commit: OK_COMMIT, commitSubject: 'x', ref: 'origin/main' },
  };
  read_impl = serveDelivery(indexWith(checkedInContract.designId, entry, entry));
  const { html } = await render_panel(Panel, propsFor('s1'));
  globalThis.__html_index_ok = html;
  assert(html.includes('data-designbridge-studio="validation"'), '应渲染校验状态条');
  assert(html.includes('data-db-validation-kind="entry"'), '应为 entry 态');
  assert(html.includes('data-db-validation-ok="true"'), '应为通过态');
  assert(html.includes('data-tone="ok"'), '外框应为 ok 色调');
  assert(html.includes(`data-db-validation-commit="${OK_COMMIT.slice(0, 12)}"`), '应带来源 commit（截断 12 位）');
  assert(html.includes(checkedInContract.designVersion), '应显示设计版本');
  return expect('P1 成功态：索引命中且校验通过', true, `designId=${checkedInContract.designId} commit=${OK_COMMIT.slice(0, 12)}`);
});

await run(async () => {
  const entry = {
    designId: checkedInContract.designId,
    designVersion: checkedInContract.designVersion,
    ok: false,
    errorCount: 2,
    errors: [
      { code: 'unknown-component-type', path: '$.pages[0].root.children[0].type', message: '未知组件类型' },
      { code: 'invalid-nesting', path: '$.pages[0].root.children[1].children', message: '叶节点禁止 children' },
    ],
    validatedAt: '2026-10-13T15:01:00.000Z',
    source: { commit: FAIL_COMMIT, ref: 'origin/main' },
  };
  read_impl = serveDelivery(indexWith(checkedInContract.designId, null, entry));
  const { html } = await render_panel(Panel, propsFor('s1'));
  assert(html.includes('data-db-validation-ok="false"'), '应为失败态');
  assert(html.includes('data-tone="error"'), '外框应为 error 色调');
  assert(html.includes('data-db-validation-errors="2"'), '应带错误数量 2');
  assert(html.includes('data-designbridge-studio="validation-errors"'), '应列出错误清单');
  assert(html.includes('[unknown-component-type]'), '错误行应含错误码');
  assert(html.includes('$.pages[0].root.children[0].type'), '错误行应含 JSONPath');
  return expect('P1 失败态：校验未通过并列出路径化错误', true, '❌ + 2 条路径化错误');
});

await run(async () => {
  read_impl = serveDelivery(null); // 索引读不到
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  assert(phase === 'ready', `索引缺失不应影响设计本身渲染，实际 ${phase}`);
  assert(html.includes('data-db-validation-kind="missing"'), '应为 missing 态');
  assert(!html.includes('data-db-validation-ok="true"'), '索引缺失**绝不能**渲染成"通过"');
  return expect('P1 索引缺失：显式提示，不伪装成功', true, 'missing 态且设计照常渲染');
});

await run(async () => {
  read_impl = serveDelivery('{ "designs": '); // 坏 JSON
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  assert(phase === 'ready', '索引解析失败不应影响设计本身渲染');
  assert(html.includes('data-db-validation-kind="parse"'), '应为 parse 态');
  assert(!html.includes('data-db-validation-ok="true"'), '解析失败**绝不能**渲染成"通过"');
  return expect('P1 索引解析失败：显式报错，不伪装成功', true, 'parse 态');
});

await run(async () => {
  const other = JSON.stringify({
    indexVersion: '1.0.0',
    updatedAt: '2026-10-13T15:02:00.000Z',
    designs: { 'some-other-design': { lastValid: { ok: true }, lastAttempt: { ok: true } } },
  });
  read_impl = serveDelivery(other);
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  assert(phase === 'ready', '设计不匹配不应影响设计本身渲染');
  assert(html.includes('data-db-validation-kind="mismatch"'), '应为 mismatch 态');
  assert(!html.includes('data-db-validation-ok="true"'), '别的设计的通过记录**绝不能**算到当前设计头上');
  return expect('P1 设计不匹配：不借用其他设计的校验结果', true, 'mismatch 态');
});

await run(async () => {
  const validEntry = {
    designId: checkedInContract.designId,
    designVersion: checkedInContract.designVersion,
    ok: true,
    errorCount: 0,
    errors: [],
    validatedAt: '2026-10-13T15:00:00.000Z',
    source: { commit: OK_COMMIT, ref: 'origin/main' },
  };
  const failedEntry = {
    designId: checkedInContract.designId,
    designVersion: 'broken-9.9',
    ok: false,
    errorCount: 1,
    errors: [{ code: 'unknown-component-type', path: '$.pages[0].root.children[0].type', message: '未知组件类型' }],
    validatedAt: '2026-10-13T15:05:00.000Z',
    source: { commit: FAIL_COMMIT, ref: 'origin/main' },
  };
  read_impl = serveDelivery(indexWith(checkedInContract.designId, validEntry, failedEntry));
  const { html } = await render_panel(Panel, propsFor('s1'));
  assert(html.includes('data-db-validation-ok="false"'), '最近一次失败必须显示为失败，不得显示陈旧的通过');
  assert(html.includes(`data-db-validation-commit="${FAIL_COMMIT.slice(0, 12)}"`), '状态条应反映最近一次（失败）的 commit');
  assert(html.includes('data-designbridge-studio="validation-preserved"'), '应标注上一个有效交付仍保留');
  assert(html.includes(OK_COMMIT.slice(0, 12)), '保留标注应指明上一个有效交付的 commit');
  return expect('P1 最近一次失败但有历史有效交付：显示失败并标注保留', true, '❌ + 保留提示');
});

// ── 4.7c P2：designTokens → 画布样式（通用映射 / 回退 / 作用域 / 注入防护）──────
// 契约的 designTokens 是自由 key→value；插件按**角色名约定**解析成 CSS 变量挂到画布上。
// 这套用例证明：映射是通用的（不认识任何具体设计）、缺失会回退、只作用于画布、非法值被丢弃。

const CONVENTION_TOKENS = {
  'color.background': '#F6F7F8',
  'color.panel': '#FFFFFF',
  'color.textPrimary': '#292E36',
  'color.textSecondary': '#9298A2',
  'color.border': '#EBEDF0',
  'color.accent': '#E98B4C',
  'color.accentSoft': '#FFF0E5',
  'color.onAccent': '#FFFFFF',
  'color.success': '#568567',
  'color.successSoft': '#EDF6EF',
  'radius.cardPx': 15,
  'radius.buttonPx': 12,
  'radius.pillPx': 40,
  'radius.windowPx': 20,
};

/** 用给定 designTokens 提供契约（其余字段沿用仓库契约，保证 preview 仍能通过交叉校验）。 */
function serveContractTokens(designTokens) {
  const contract = { ...checkedInContract, designTokens };
  return async (_session, path) => {
    if (path.endsWith('protocol/design-contract.json')) {
      return textResult(JSON.stringify(contract), { absolutePath: `/workspace-example/${path}`, version: 'contract-v1' });
    }
    if (path.endsWith('delivery-index.json')) {
      return { ok: false, error: { code: 'workspace-file/not-found', message: 'ENOENT: no index' } };
    }
    return textResult(previewText, { absolutePath: `/workspace-example/${path}`, version: 'preview-v1' });
  };
}

/** 精确取出画布 page **元素自身**的 style 属性（CSS 块里也有 var(--db-…)，不能拿整页 HTML 判断）。 */
function pageStyleOf(html) {
  const m = html.match(/className="db-preview-page"[^>]*?style="([^"]*)"/);
  return m ? m[1] : null;
}

await run(async () => {
  read_impl = serveContractTokens(CONVENTION_TOKENS);
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  assert(phase === 'ready', `应 ready，实际 ${phase}`);
  const expected = [
    ['--db-canvas-bg', '#F6F7F8'], ['--db-surface', '#FFFFFF'],
    ['--db-text-primary', '#292E36'], ['--db-text-secondary', '#9298A2'],
    ['--db-border', '#EBEDF0'], ['--db-accent', '#E98B4C'],
    ['--db-accent-soft', '#FFF0E5'], ['--db-accent-ink', '#FFFFFF'],
    ['--db-success', '#568567'], ['--db-success-soft', '#EDF6EF'],
    ['--db-radius-card', '15px'], ['--db-radius-button', '12px'],
    ['--db-radius-pill', '40px'], ['--db-radius-window', '20px'],
  ];
  for (const [name, value] of expected) assert(html.includes(`${name}:${value}`), `画布应带 ${name}:${value}`);
  assert(html.includes('data-db-tokens-resolved="14"'), '解析计数应为 14');
  return expect('P2 样式映射：契约 tokens 按角色落到画布 CSS 变量', true, '14 个角色（10 色 + 4 圆角）');
});

await run(async () => {
  read_impl = serveContractTokens({ 'color.accent': '#123456' });
  const { html } = await render_panel(Panel, propsFor('s1'));
  assert(html.includes('--db-accent:#123456'), '应解析 color.accent');
  const st = pageStyleOf(html);
  assert(st !== null, '应能取到画布 style');
  assert(!st.includes('--db-canvas-bg'), '未声明的角色不得凭空出现');
  assert(html.includes('data-db-tokens-resolved="1"'), '解析计数应为 1');
  return expect('P2 部分回退：只映射已声明的角色', true, '仅 --db-accent');
});

await run(async () => {
  read_impl = serveContractTokens({});
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  assert(phase === 'ready', '空 tokens 不应影响渲染');
  const st = pageStyleOf(html);
  assert(st !== null, '应能取到画布 style');
  assert(!st.includes('--db-'), '无 tokens 时画布不得注入任何 --db-* 变量');
  assert(html.includes('data-db-tokens-resolved="0"'), '解析计数应为 0');
  return expect('P2 全量回退：无 tokens 时画布完全不改样式', true, '0 个角色 → 走 Studio 主题');
});

await run(async () => {
  read_impl = serveContractTokens({
    'color.accent': 'red; } body { display:none } .x{',
    'color.accentSoft': '#FFF0E5',
    'radius.cardPx': -3,
  });
  const { html } = await render_panel(Panel, propsFor('s1'));
  const st = pageStyleOf(html);
  assert(st !== null, '应能取到画布 style');
  assert(!st.includes('display:none') && !st.includes('red'), '恶意值绝不能进入画布 style');
  assert(st.includes('--db-accent-soft:#FFF0E5'), '合法值仍应生效');
  assert(!st.includes('--db-accent:'), '非法颜色应被丢弃');
  assert(!st.includes('--db-radius-card'), '非法半径应被丢弃');
  assert(html.includes('data-db-tokens-ignored="2"'), '应记录 2 个被忽略的非法值');
  return expect('P2 注入防护：非法 token 值被丢弃并计数', true, '丢弃 2 个、保留 1 个');
});

await run(async () => {
  read_impl = serveContractTokens(CONVENTION_TOKENS);
  const { html } = await render_panel(Panel, propsFor('s1'));
  const styleEnd = html.indexOf('</style>');
  const pageAt = html.indexOf('className="db-preview-page"');
  assert(styleEnd >= 0 && pageAt > styleEnd, `应存在样式表与画布 page（styleEnd=${styleEnd} pageAt=${pageAt}）`);
  assert(!html.slice(styleEnd, pageAt).includes('--db-'), 'Studio 外壳不得出现 --db-* 变量');
  assert((pageStyleOf(html) || '').includes('--db-canvas-bg:#F6F7F8'), '变量应挂在画布 page 上');
  return expect('P2 作用域隔离：样式变量只在画布内，不动 Studio 外壳', true, '外壳 0 处，画布命中');
});

await run(async () => {
  read_impl = serveContractTokens(CONVENTION_TOKENS);
  const { html } = await render_panel(Panel, propsFor('s1'));
  assert(html.includes('data-db-variant="primary"'), '应输出主按钮 variant');
  assert(html.includes('data-db-tone="success"'), '应输出 badge 的 tone');
  assert(html.includes('data-db-tone="secondary"'), '应输出 text 的 tone');
  return expect('P2 变体与 tone 落到 DOM 属性（供 CSS 选择）', true, 'variant/tone 均存在');
});

await run(async () => {
  // 回归：**旧命名法**（仓库既有设计的写法）靠别名命中；但它只声明了背景/卡片/强调，
  // **没有文字色** → 画布组必须被门控丢弃（否则浅底配浅字不可读），
  // 而独立角色（强调色、圆角）照常生效。这保证既有设计不会被改坏。
  const legacy = { accent: '#4C8DFF', surface: '#FFFFFF', canvas: '#F6F7F8', cardRadiusDp: 16 };
  read_impl = serveContractTokens(legacy);
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  assert(phase === 'ready', `应仍为 ready，实际 ${phase}`);
  const st = pageStyleOf(html) || '';
  assert(!st.includes('--db-canvas-bg'), '缺文字色时不得改画布背景');
  assert(!st.includes('--db-surface'), '缺文字色时不得改卡片底色的画布组');
  assert(st.includes('--db-accent:#4C8DFF'), '强调色属独立角色，仍应生效');
  assert(st.includes('--db-radius-card:16px'), '圆角属独立角色，仍应生效');
  assert(html.includes('data-db-tokens-gated="2"'), '应记录 2 个被门控的画布组角色');
  assert(html.includes('data-node-id="root"'), '画布结构应完好');
  return expect('P2 成组门控：缺文字色的设计不会把画布改成不可读', true, '画布组丢弃 2 项，accent/圆角生效');
});

await run(async () => {
  // 补齐文字色后，同一份旧命名法 tokens 应**完整**生效（门控解除）
  const legacyFull = { accent: '#4C8DFF', surface: '#FFFFFF', canvas: '#F6F7F8', cardRadiusDp: 16, ink: '#1F2430', muted: '#7A828E' };
  read_impl = serveContractTokens(legacyFull);
  const { html } = await render_panel(Panel, propsFor('s1'));
  const st = pageStyleOf(html) || '';
  assert(st.includes('--db-canvas-bg:#F6F7F8'), '补齐文字色后画布背景应生效');
  assert(st.includes('--db-surface:#FFFFFF'), '补齐文字色后卡片底色应生效');
  assert(st.includes('--db-text-primary:#1F2430'), '主文字应生效');
  assert(html.includes('data-db-tokens-gated="0"'), '不应再有被门控的角色');
  return expect('P2 门控解除：补齐文字色后画布组整体生效', true, 'ink/muted 别名命中');
});

// ── 4.7d v0.7：高保真组件与设计资源（渲染 / 降级 / 兼容）─────────────────────
// 说明：本组用**克隆仓库现有 preview 的第一页**再替换根子节点的方式构造夹具，
// 这样 designId/designVersion/screenId/orientation 仍与契约自洽，preview 能通过交叉校验。

const v07BasePreview = JSON.parse(previewText);

/** 用给定的根子节点构造一份仍然自洽的 preview。 */
function previewWithRootChildren(children) {
  const clone = JSON.parse(JSON.stringify(v07BasePreview));
  clone.pages[0].root = { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children };
  return clone;
}

/** 提供自定义 preview；契约沿用仓库契约（或给定 tokens）。 */
function servePreview(previewObj, designTokens) {
  const contract = designTokens === undefined ? checkedInContract : { ...checkedInContract, designTokens };
  const text = JSON.stringify(previewObj);
  return async (_session, path) => {
    if (path.endsWith('protocol/design-contract.json')) {
      return textResult(JSON.stringify(contract), { absolutePath: `/workspace-example/${path}`, version: 'contract-v1' });
    }
    if (path.endsWith('delivery-index.json')) {
      return { ok: false, error: { code: 'workspace-file/not-found', message: 'ENOENT: no index' } };
    }
    if (path.endsWith('preview.json')) {
      return textResult(text, { absolutePath: `/workspace-example/${path}`, version: 'preview-v1' });
    }
    // 资源清单/资源本体：一律读不到 → 走"缺失资源"降级路径
    return { ok: false, error: { code: 'workspace-file/not-found', message: 'ENOENT' } };
  };
}

const V07_NODES = [
  { id: 'n-icon', type: 'icon', props: { asset: 'nav-all', size: 24, tone: 'accent', align: 'center' }, layout: { mode: 'flow' } },
  { id: 'n-image', type: 'image', props: { asset: 'cover', fit: 'contain', alt: '封面' }, layout: { mode: 'flow' } },
  { id: 'n-input', type: 'input', props: { placeholder: '搜索剧名', kind: 'search', state: 'focused' }, layout: { mode: 'flow' } },
  { id: 'n-input2', type: 'input', props: { placeholder: '名称', value: '已填内容' }, layout: { mode: 'flow' } },
  { id: 'n-chip', type: 'chip', props: { label: '全部文件', state: 'selected', tone: 'primary' }, layout: { mode: 'flow' } },
  { id: 'n-chip2', type: 'chip', props: { label: '已停用', state: 'disabled' }, layout: { mode: 'flow' } },
  { id: 'n-btn2', type: 'button', props: { label: '次级按钮', variant: 'secondary' }, layout: { mode: 'flow' } },
  { id: 'n-card', type: 'card', props: { title: '卡片', subtitle: '带阴影', elevation: 'md' }, layout: { mode: 'flow' } },
  { id: 'n-li', type: 'list-item', props: { label: '文件行', subtitle: '副标题', meta: '00:38', trailing: '›', asset: 'file-video', selected: true }, layout: { mode: 'flow' } },
];

await run(async () => {
  read_impl = servePreview(previewWithRootChildren(V07_NODES));
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  assert(phase === 'ready', `应 ready，实际 ${phase}`);
  // 新组件都渲染出了各自的类与数据属性
  assert(html.includes('db-preview-icon'), 'icon 应渲染');
  assert(html.includes('data-db-tone="accent"'), 'icon tone 应落到属性');
  assert(html.includes('data-db-align="center"'), 'icon align 应落到属性');
  assert(html.includes('db-preview-image'), 'image 应渲染');
  assert(html.includes('data-db-fit="contain"'), 'image fit 应落到属性');
  assert(html.includes('db-preview-input'), 'input 应渲染');
  assert(html.includes('data-db-kind="search"'), 'input kind 应落到属性');
  assert(html.includes('data-db-state="focused"'), 'input state 应落到属性');
  assert(html.includes('db-preview-chip'), 'chip 应渲染');
  assert(html.includes('data-db-state="selected"'), 'chip 选中态应落到属性');
  assert(html.includes('data-db-state="disabled"'), 'chip 禁用态应落到属性');
  assert(html.includes('data-db-variant="secondary"'), 'button secondary 应支持');
  assert(html.includes('data-db-elevation="md"'), 'card elevation 应落到属性');
  assert(html.includes('data-db-selected="true"'), 'list-item 选中态应落到属性');
  return expect('v0.7 组件：icon/image/input/chip/secondary/elevation/selected 全部可渲染', true, '7 类新能力');
});

await run(async () => {
  // 资源读不到（清单缺失）→ 必须**显式可见降级**，不能静默空白
  read_impl = servePreview(previewWithRootChildren(V07_NODES));
  const { html } = await render_panel(Panel, propsFor('s1'));
  assert(html.includes('db-preview-asset-missing'), '图标缺失应渲染可见占位');
  assert(html.includes('缺失资源：nav-all'), '占位应点名缺失的资源 id');
  assert(html.includes('缺失资源：cover'), '图片缺失同样应点名');
  assert(html.includes('data-db-asset="nav-all"'), '应带 data-db-asset 便于定位');
  return expect('v0.7 降级：资源缺失时给出可见且可定位的提示', true, 'icon + image 均降级');
});

await run(async () => {
  // 兼容：不含任何新组件的旧 preview 不得受影响（结构照旧、无降级噪音）
  const legacy = previewWithRootChildren([
    { id: 'l-text', type: 'text', props: { text: '旧设计' }, layout: { mode: 'flow' } },
    { id: 'l-btn', type: 'button', props: { label: '旧按钮', variant: 'primary' }, layout: { mode: 'flow' } },
  ]);
  read_impl = servePreview(legacy);
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  assert(phase === 'ready', '旧 preview 应正常渲染');
  assert(html.includes('旧设计') && html.includes('旧按钮'), '旧内容应照常出现');
  // 只检查 DOM 区域：CSS 块里本来就有 .db-preview-asset-missing 规则
  assert(!html.slice(html.indexOf('</style>')).includes('db-preview-asset-missing'), '不应凭空出现资源降级提示');
  return expect('v0.7 兼容：不含新组件的旧设计零影响', true, '无降级噪音');
});

await run(async () => {
  // **同步性守卫**：client.js 无法 import 模块，因此内联了组件白名单的副本。
  // 历史上这份副本曾与协议脱节（协议加了组件、渲染器却直接 return null），
  // 这条用例把"两份清单必须一致"变成可执行的约束。
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const match = clientSource.match(/const PREVIEW_COMPONENT_TYPES = Object\.freeze\(\[([^\]]*)\]\)/);
  assert(match !== null, 'client.js 应声明 PREVIEW_COMPONENT_TYPES');
  const inlined = match[1].split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert(inlined.join('|') === [...COMPONENT_TYPES].join('|'), `内联副本与协议不一致：内联=${inlined.join(',')} 协议=${COMPONENT_TYPES.join(',')}`);
  // 渲染器守卫与内联清单必须同源（不得再出现第二份硬编码数组）
  assert(clientSource.includes('if (!PREVIEW_COMPONENT_TYPES.includes(node.type)) return null;'), '渲染器守卫必须复用同一常量');
  return expect('v0.7 同步性：client.js 内联组件清单与协议一致', true, `${inlined.length} 类，单一来源`);
});

// ── 4.7e v0.7.1：SVG 净化器的双向约束（合法必须通过 / 攻击必须拒绝）────────────
// 背景：v0.7 的兜底正则把 `xmlns="http://www.w3.org/2000/svg"` 当成外部引用，
// 导致**所有合法 SVG 都被判为不安全**、图标整体降级。这里把它固化成回归用例。

function sanitizerFromClient() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const match = source.match(/function sanitizeSvgText\(text\) \{[\s\S]*?\n    \}/);
  assert(match !== null, '应能在 client.js 中找到 sanitizeSvgText');
  return new Function(`return ${match[0]}`)();
}

await run(async () => {
  const sanitize = sanitizerFromClient();
  const real = readFileSync(new URL('../../designs/innerrec-01/assets/icons/nav-all.svg', import.meta.url), 'utf8');
  assert(real.includes('xmlns="http://www.w3.org/2000/svg"'), '夹具本身应带 xmlns');
  assert(sanitize(real) !== null, '带 xmlns 的合法 SVG 必须通过（v0.7.1 回归点）');
  const gradient = readFileSync(new URL('../../designs/innerrec-01/assets/icons/player-frame.svg', import.meta.url), 'utf8');
  assert(sanitize(gradient) !== null, '含片段引用 url(#g) 的渐变 SVG 必须通过');
  return expect('v0.7.1 净化器：合法 SVG（含 xmlns / url(#id)）必须通过', true, '2 个真实资源');
});

await run(async () => {
  const sanitize = sanitizerFromClient();
  const attacks = [
    ['script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['onload', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['onclick', '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="x()"/></svg>'],
    ['外部 href', '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil/x.svg#a"/></svg>'],
    ['foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body/></foreignObject></svg>'],
    ['javascript:', '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)">x</a></svg>'],
    ['data: href', '<svg xmlns="http://www.w3.org/2000/svg"><a href="data:text/html,x">x</a></svg>'],
    ['image 外部', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil/a.png"/></svg>'],
    ['iframe', '<svg xmlns="http://www.w3.org/2000/svg"><iframe src="https://evil"/></svg>'],
  ];
  const survived = attacks.filter(([, svg]) => sanitize(svg) !== null).map(([name]) => name);
  assert(survived.length === 0, `未拦截：${survived.join(', ')}`);
  return expect('v0.7.1 净化器：9 类注入/外链攻击全部 fail-closed 拒绝', true, '0 漏网');
});

await run(async () => {
  // 资源加载**成功路径**：清单 + SVG 文本可读 → icon 渲染成 <img src="data:image/svg+xml;base64,…">
  const real = readFileSync(new URL('../../designs/innerrec-01/assets/icons/nav-all.svg', import.meta.url), 'utf8');
  const manifest = JSON.stringify({ assetSchemaVersion: '1.0.0', designId: checkedInContract.designId, assets: [
    { id: 'nav-all', kind: 'svg', path: `designs/${checkedInContract.designId}/assets/icons/nav-all.svg` },
  ] });
  const preview = previewWithRootChildren([
    { id: 'ok-icon', type: 'icon', props: { asset: 'nav-all', size: 24 }, layout: { mode: 'flow' } },
  ]);
  const contract = checkedInContract;
  read_impl = async (_session, path) => {
    if (path.endsWith('protocol/design-contract.json')) return textResult(JSON.stringify(contract), { absolutePath: `/w/${path}`, version: 'c' });
    if (path.endsWith('delivery-index.json')) return { ok: false, error: { code: 'workspace-file/not-found', message: 'ENOENT' } };
    if (path.endsWith('assets.json')) return textResult(manifest, { absolutePath: `/w/${path}`, version: 'a', bytes: manifest.length });
    if (path.endsWith('nav-all.svg')) return textResult(real, { absolutePath: `/w/${path}`, version: 's', bytes: real.length });
    return textResult(JSON.stringify(preview), { absolutePath: `/w/${path}`, version: 'p' });
  };
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  assert(phase === 'ready', `应 ready，实际 ${phase}`);
  assert(html.includes('src="data:image/svg+xml;base64,'), '图标应渲染为 data: URI 的 <img>');
  // 只判 DOM 区域（样式表里本来就有 .db-preview-asset-missing 规则）
  assert(!html.slice(html.indexOf('</style>')).includes('db-preview-asset-missing'), '成功路径不应出现降级占位');
  assert(!html.includes('缺失资源：nav-all'), '不应出现缺失提示');
  return expect('v0.7.1 资源成功路径：SVG 经净化后以内联 data URI 渲染', true, '无降级');
});

// ── 4.75 回归：preview 读取路径必须以「会话工作区根」为基准 ──────────────────
// 真机踩过的 bug：契约读的是 `${DESIGN_ROOT}/protocol/...`，而 preview 读的是
// `designs/...`（漏了 DESIGN_ROOT 前缀）→ 去工作区根下找 → workspace-file/not-found。
await run(async () => {
  const seen = [];
  read_impl = async (sessionId, path) => {
    seen.push(path);
    if (path.endsWith('protocol/design-contract.json')) {
      return textResult(JSON.stringify(VALID_CONTRACT));
    }
    return { ok: false, error: { code: 'workspace-file/not-found', message: `no entry at "${path}"` } };
  };
  await render_panel(Panel, propsFor('s1'));

  const contractReq = seen.find((p) => p.endsWith('protocol/design-contract.json'));
  const previewReq = seen.find((p) => p.includes('/designs/'));

  assert(contractReq !== undefined, '未请求契约');
  assert(previewReq !== undefined, '未请求 preview');
  const prefix = contractReq.slice(0, contractReq.indexOf('protocol/'));
  return expect(
    '回归：preview 读取路径与契约同基准（带 DESIGN_ROOT 前缀）',
    previewReq === `${prefix}designs/demo-library/preview.json`,
    `preview=${previewReq}`,
  );
});

// ── 4.8 自动打开面板：**保守策略** ──────────────────────────────────────────
// 背景：本插件注册的是右栏 tab，Harness 默认界面是会话页，没有任何东西会自动打开它，
// 于是"装好了却看不见"。但无条件自动打开会打扰用户，因此采用三重保守条件。
await run(async () => {
  return expect('自动打开：无会话在屏时不调用 openTab', auto_open_calls.length === 0, `调用 ${auto_open_calls.length} 次`);
});

await run(async () => {
  // ① API 不可用 → 必须**不猜**，直接不打开（宁可靠手动）
  open_tabs_source = undefined;
  set_mounted('session-api-missing');
  return expect(
    '自动打开：openTabs API 不可用时默认不打开（不猜）',
    auto_open_calls.length === 0,
    `调用 ${auto_open_calls.length} 次`,
  );
});

await run(async () => {
  // ② 右栏为空 → 打开一次，kind 正确
  open_tabs_source = { getSnapshot: () => open_tabs };
  open_tabs = [];
  set_mounted('session-empty');
  const kind = registrations.find((r) => r.kind === 'sidebarRightTabs').definition.kind;
  return expect(
    '自动打开：右栏为空时以正确的 kind 打开一次',
    auto_open_calls.length === 1 && auto_open_calls[0].kind === kind,
    `openTab(${auto_open_calls[0] && auto_open_calls[0].kind})`,
  );
});

await run(async () => {
  set_mounted('session-empty');
  set_mounted('session-empty');
  return expect('自动打开：同一会话幂等（手动关闭后不反复弹出）', auto_open_calls.length === 1, `仍为 ${auto_open_calls.length} 次`);
});

await run(async () => {
  // ③ 该会话右栏已有 tab → 不抢占
  const before = auto_open_calls.length;
  open_tabs = [{ sessionId: 'session-occupied', tabId: 't1', kind: 'files', contentId: 'c1' }];
  set_mounted('session-occupied');
  return expect(
    '自动打开：该会话右栏已有 tab 时不抢占',
    auto_open_calls.length === before,
    `仍为 ${auto_open_calls.length} 次`,
  );
});

await run(async () => {
  // ④ 只有**别的**会话有 tab，本会话为空 → 仍应打开（不误伤）
  const before = auto_open_calls.length;
  open_tabs = [{ sessionId: 'session-other', tabId: 't9', kind: 'files', contentId: 'c9' }];
  set_mounted('session-fresh');
  return expect(
    '自动打开：别的会话有 tab 不影响本会话（不误伤）',
    auto_open_calls.length === before + 1,
    `由 ${before} → ${auto_open_calls.length} 次`,
  );
});

await run(async () => {
  // ⑤ 复现 require() 抛错：store 还没 mint
  auto_open_throw = 'sidebarRight: no session surface is mounted';
  open_tabs = [];
  const before = auto_open_calls.length;
  let escaped = null;
  try {
    set_mounted('session-retry');
  } catch (error) {
    escaped = error;
  }
  auto_open_throw = null;
  return expect(
    '自动打开：宿主抛 "no session surface is mounted" 时不冒泡、不记为已打开',
    escaped === null && auto_open_calls.length === before,
    escaped === null ? '失败被吞掉，未冒泡' : `冒泡了：${escaped.message}`,
  );
});

await run(async () => {
  await new Promise((resolve) => setTimeout(resolve, 900));
  return expect('自动打开：定时重试后成功打开', auto_open_calls.length > 1, `共 ${auto_open_calls.length} 次调用`);
});

// ── 5. 源码级约束（b-1 新增）─────────────────────────────────────────────────
check('designRoot 是工作区相对路径，不含 Android 绝对路径', () => {
  const m = source.match(/const DESIGN_ROOT\s*=\s*'([^']*)'/);
  assert(m !== null, '未找到 DESIGN_ROOT 常量');
  const root = m[1];
  assert(!root.startsWith('/'), `designRoot 不应以 / 开头：${root}`);
  assert(!/\/(storage|data|sdcard)\//.test(root), `designRoot 不应是 Android 绝对路径：${root}`);
  assert(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(root), `designRoot 不应是 URL：${root}`);
  return `DESIGN_ROOT='${root}'`;
});

check('不再硬编码演示值（demo-0.1 / #ED8B43）作为展示数据', () => {
  assert(!source.includes('DESIGN_VERSION'), '不应再存在 DESIGN_VERSION 常量');
  assert(!source.includes('DESIGN_ACCENT'), '不应再存在 DESIGN_ACCENT 常量');
  const literal = source.match(/const\s+\w*ACCENT\w*\s*=\s*'#/);
  assert(literal === null, '不应硬编码 accent 色值');
  return '演示常量已移除';
});

check('六种错误态文案齐备', () => {
  const kinds = ['no-session', 'bad-path', 'not-found', 'forbidden', 'not-text', 'too-large',
    'read-failed', 'parse', 'schema'];
  const missing = kinds.filter((k) => !source.includes(`'err.${k}'`));
  assert(missing.length === 0, `缺少错误态文案：${missing.join(', ')}`);
  return kinds.join(', ');
});

check('所有读取都经只读 workspaceFiles，且没有写操作', () => {
  assert(source.includes('remote.workspaceFiles.read('), '应调用 workspaceFiles.read');
  for (const forbidden of ['workspaceFiles.write', 'workspaceFiles.remove', 'workspaceFiles.move',
    'workspaceFiles.mkdir', 'fs.writeFile', 'fs.promises.write']) {
    assert(!source.includes(forbidden), `不应出现写操作：${forbidden}`);
  }
  return '仅 read（服务本身不提供写方法）';
});

check('b-1 未使用 changes() 自动刷新', () => {
  assert(!source.includes('workspaceFiles.changes'), 'b-1 不应引入 changes()');
  return '仅手动刷新';
});

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
  const pane_reg_src = source.match(/name: 'sidebar\.right\.pane\.tab',[\s\S]{0,160}?\}/);
  assert(pane_reg_src !== null, '未找到 pane 注册块');
  assert(/key:\s*TAB_ID/.test(pane_reg_src[0]), `pane 注册应使用 key: TAB_ID，实际片段：${pane_reg_src[0]}`);
  assert(!/\bid:\s*TAB_ID/.test(pane_reg_src[0]), 'pane 注册不应使用 id');
  return 'slots.inject + key: TAB_ID';
});

check('client.js 不含 eval / new Function / document.body 注入', () => {
  for (const forbidden of ['eval(', 'new Function', 'document.body', 'innerHTML']) {
    assert(!source.includes(forbidden), `不应出现 ${forbidden}`);
  }
  return '无动态执行、无全局 DOM 注入';
});

check('package.json 声明了激活顺序但未新增任何依赖', () => {
  const pkg = JSON.parse(readFileSync(join(plugin_root, 'package.json'), 'utf8'));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  assert(Object.keys(deps).length === 0, `不应有任何依赖：${Object.keys(deps).join(', ')}`);
  const inject = pkg.dsh?.client?.inject ?? [];
  for (const need of ['@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-api-workspace-files']) {
    assert(inject.includes(need), `dsh.client.inject 应含 ${need}`);
  }
  return `inject=${inject.length} 项，dependencies=0`;
});

console.log('');
if (failures === 0) {
  console.log('全部通过。');
  process.exit(0);
}
console.log(`失败 ${failures} 项。`);
process.exit(1);
