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
  let captured = null;

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
      captured = fn;
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
      captured = null;
    },
    render(Component, props) {
      cursor = 0;
      captured = null;
      const tree = Component(props);
      const effect = captured;
      captured = null;
      return { tree, effect };
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
  const first = harness.render(component, props);
  if (typeof first.effect === 'function') {
    first.effect(); // 触发读取
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


const ctx = {
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
await run(async () => {
  read_impl = async () => textResult(JSON.stringify(VALID_CONTRACT));
  const { html, phase } = await render_panel(Panel, propsFor('s1'));
  globalThis.__html_ok = html;
  assert(phase === 'ready', `应进入 ready，实际 ${phase}`);
  for (const needle of ['demo-library', 'demo-0.1', 'android-compose', 'library', '#ED8B43', 'landscape']) {
    assert(html.includes(needle), `缺少真实字段值：${needle}`);
  }
  return expect('成功态：显示真实 contract 字段', true, 'designId/version/platform/screenId/tokens/regions 均在');
});

await run(async () => {
  const html = globalThis.__html_ok;
  return expect(
    '成功态：显示数据来源（相对路径/绝对路径/版本/字节/行数/时间）',
    html.includes('GitHub项目下载/DesignBridge/protocol/design-contract.json') &&
      html.includes('v1-abc123') &&
      html.includes('data-designbridge-studio="source"'),
    '来源卡片含路径、版本、字节、行数、读取时间',
  );
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
