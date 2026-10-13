/**
 * 设计交付校验器测试（v0.4）
 *
 * 覆盖：正例 / 反例 / 版本漂移 / 文件缺失 / 资源限制 / 路径纪律 / 不发明字段。
 * 做法：在**临时目录**里搭夹具，调用导出的 `validateDesign()`；
 *      不在仓库里写任何东西，也不依赖网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { validateDesign } from '../scripts/validate-design.mjs';
import { CONTRACT_LIMITS, validateContract } from '../src/model/contract-schema.mjs';
import { LIMITS } from '../src/model/preview-schema.mjs';

// ── 夹具 ───────────────────────────────────────────────────────────────────
const GOOD_CONTRACT = {
  schemaVersion: '1.0.0',
  designId: 'fixture-design',
  designVersion: 'fx-0.1',
  platform: 'android-compose',
  screenId: 'main',
  description: '测试夹具',
  designTokens: { accent: '#ED8B43', surface: '#FFFFFF', cardRadiusDp: 16 },
  layout: { orientation: 'landscape', regions: ['navigation', 'content'] },
  changeScope: { allowed: ['fixture-design'], protected: [] },
  referenceAssets: [],
};

function goodPreview(overrides = {}) {
  return {
    previewSchemaVersion: '1.0.0',
    designId: 'fixture-design',
    designVersion: 'fx-0.1',
    pages: [
      {
        id: 'main',
        title: '主页面',
        viewport: { widthDp: 1280, heightDp: 800, orientation: 'landscape' },
        root: {
          id: 'root',
          type: 'frame',
          props: { direction: 'row', layoutMode: 'flow', gap: 12, padding: 16 },
          children: [
            { id: 'title', type: 'text', props: { text: '标题' }, layout: { mode: 'flow' } },
            { id: 'action', type: 'button', props: { label: '按钮' }, layout: { mode: 'flow' } },
          ],
        },
      },
    ],
    ...overrides,
  };
}

const GOOD_MANIFEST = {
  schemaVersion: '1.0.0',
  project: 'DesignBridge',
  protocolVersion: '0.1.0',
  designVersion: 'fx-0.1',
  transport: 'github-files',
  status: 'bootstrap',
  paths: { designContract: 'protocol/design-contract.json' },
};

let fixtureCount = 0;
/**
 * 建一个夹具仓库。
 * @param {{ contract?: any, preview?: any, manifest?: any,
 *           dropContract?: boolean, dropPreview?: boolean, dropManifest?: boolean,
 *           contractAsText?: string, previewAsText?: string }} files
 */
function makeFixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), `db-validate-${fixtureCount++}-`));
  const designId = (files.contract ?? GOOD_CONTRACT).designId;
  const put = (rel, value) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  };
  if (files.dropManifest !== true) put('protocol/manifest.json', files.manifest ?? GOOD_MANIFEST);
  if (files.dropContract !== true) put('protocol/design-contract.json', files.contractAsText ?? (files.contract ?? GOOD_CONTRACT));
  if (files.dropPreview !== true) put(`designs/${designId}/preview.json`, files.previewAsText ?? (files.preview ?? goodPreview()));
  return root;
}

const cleanups = [];
function fixture(files) {
  const root = makeFixture(files);
  cleanups.push(root);
  return root;
}
test.after(() => {
  for (const root of cleanups) rmSync(root, { recursive: true, force: true });
});

// ── 正例 ───────────────────────────────────────────────────────────────────
test('正例：契约 + 预览 + manifest 一致 → 通过', () => {
  const result = validateDesign({ root: fixture() });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.designId, 'fixture-design');
  assert.equal(result.summary.pages, 1);
  assert.equal(result.summary.nodes, 3);
});

test('正例：manifest 声明 paths.designContract 时按其解析', () => {
  const root = fixture({
    manifest: { ...GOOD_MANIFEST, paths: { designContract: 'protocol/design-contract.json' } },
  });
  const result = validateDesign({ root });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(result.summary.manifestFieldsUsed.includes('paths.designContract'));
});

test('正例：--design 与契约一致 → 通过', () => {
  const result = validateDesign({ root: fixture(), designId: 'fixture-design' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

// ── 不发明字段：manifest 缺 designVersion / 缺 preview 路径 都不该失败 ──
test('不发明字段：manifest 无 designVersion → 不失败，只记说明', () => {
  const manifest = { ...GOOD_MANIFEST };
  delete manifest.designVersion;
  const result = validateDesign({ root: fixture({ manifest }) });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(result.info.some((line) => line.includes('未声明 designVersion')));
});

test('不发明字段：manifest 无 preview 路径声明 → 不失败（沿用约定）', () => {
  const result = validateDesign({ root: fixture() });
  assert.equal(result.ok, true);
  assert.equal(result.summary.previewPath, 'designs/fixture-design/preview.json');
});

// ── 反例 ───────────────────────────────────────────────────────────────────
test('反例：preview 出现未知组件类型 → 失败并给出路径', () => {
  const preview = goodPreview();
  preview.pages[0].root.children[0].type = 'chart';
  const result = validateDesign({ root: fixture({ preview }) });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  const hit = result.errors.find((e) => e.code === 'unknown-component-type');
  assert.ok(hit, JSON.stringify(result.errors));
  assert.equal(hit.path, 'designs/fixture-design/preview.json#$.pages[0].root.children[0].type');
});

test('反例：preview 组件 props 多出未知字段 → 失败', () => {
  const preview = goodPreview();
  preview.pages[0].root.children[0].props.color = '#fff';
  const result = validateDesign({ root: fixture({ preview }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'unknown-field'), JSON.stringify(result.errors));
});

test('反例：契约缺必填字段 → 失败并给出路径', () => {
  const contract = { ...GOOD_CONTRACT };
  delete contract.designVersion;
  const result = validateDesign({ root: fixture({ contract }) });
  assert.equal(result.ok, false);
  const hit = result.errors.find((e) => e.code === 'required-field' && e.path.includes('designVersion'));
  assert.ok(hit, JSON.stringify(result.errors));
});

test('反例：--design 与契约不一致 → 失败', () => {
  const result = validateDesign({ root: fixture(), designId: 'someone-else' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'design-id-mismatch'));
});

test('反例：契约 JSON 语法无效 → invalid-json', () => {
  const result = validateDesign({ root: fixture({ contractAsText: '{ "a": , }' }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'invalid-json'));
});

// ── 版本漂移 ───────────────────────────────────────────────────────────────
test('版本漂移：manifest.designVersion 与契约不一致 → 失败', () => {
  const manifest = { ...GOOD_MANIFEST, designVersion: 'fx-9.9' };
  const result = validateDesign({ root: fixture({ manifest }) });
  assert.equal(result.ok, false);
  const hit = result.errors.find((e) => e.code === 'design-version-mismatch');
  assert.ok(hit, JSON.stringify(result.errors));
  assert.ok(hit.path.includes('manifest.json'));
});

test('版本漂移：preview.designVersion 与契约不一致 → 失败', () => {
  const result = validateDesign({ root: fixture({ preview: goodPreview({ designVersion: 'fx-9.9' }) }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'design-version-mismatch'));
});

test('版本漂移：preview.designId 与契约不一致 → 失败', () => {
  const result = validateDesign({ root: fixture({ preview: goodPreview({ designId: 'other' }) }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'design-id-mismatch'));
});

test('版本漂移：preview 未包含 contract.screenId 对应页面 → 失败', () => {
  const contract = { ...GOOD_CONTRACT, screenId: 'not-a-page' };
  const result = validateDesign({ root: fixture({ contract }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'screen-id-mismatch'), JSON.stringify(result.errors));
});

test('版本漂移：viewport.orientation 与 contract.layout.orientation 不一致 → 失败', () => {
  const contract = { ...GOOD_CONTRACT, layout: { orientation: 'portrait', regions: ['navigation'] } };
  const result = validateDesign({ root: fixture({ contract }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'orientation-mismatch'), JSON.stringify(result.errors));
});

// ── 文件缺失 ───────────────────────────────────────────────────────────────
test('文件缺失：preview 不存在 → 失败且路径明确', () => {
  const result = validateDesign({ root: fixture({ dropPreview: true }) });
  assert.equal(result.ok, false);
  const hit = result.errors.find((e) => e.code === 'missing-file');
  assert.ok(hit, JSON.stringify(result.errors));
  assert.equal(hit.path, 'designs/fixture-design/preview.json');
});

test('文件缺失：contract 不存在 → 失败且路径明确', () => {
  const result = validateDesign({ root: fixture({ dropContract: true }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'missing-file' && e.path === 'protocol/design-contract.json'));
});

test('文件缺失：manifest 不存在 → 失败且路径明确', () => {
  const result = validateDesign({ root: fixture({ dropManifest: true }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'missing-file' && e.path === 'protocol/manifest.json'));
});

// ── 路径纪律 ───────────────────────────────────────────────────────────────
test('路径纪律：manifest.paths.designContract 上跳（..）被拒', () => {
  const manifest = { ...GOOD_MANIFEST, paths: { designContract: '../outside/design-contract.json' } };
  const result = validateDesign({ root: fixture({ manifest }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'invalid-value' && e.path.includes('paths.designContract')));
});

test('路径纪律：manifest.paths.designContract 为绝对路径被拒', () => {
  const manifest = { ...GOOD_MANIFEST, paths: { designContract: '/etc/passwd' } };
  const result = validateDesign({ root: fixture({ manifest }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'invalid-value'));
});

// ── 资源限制 ───────────────────────────────────────────────────────────────
test('资源限制：preview 超过 maxBytes → input-too-large', () => {
  const huge = `${JSON.stringify(goodPreview(), null, 2)}${' '.repeat(LIMITS.maxBytes + 1024)}`;
  const result = validateDesign({ root: fixture({ previewAsText: huge }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'input-too-large'), JSON.stringify(result.errors));
});

test('资源限制：页面数超过 maxPages → limit-exceeded', () => {
  const preview = goodPreview();
  const page = preview.pages[0];
  preview.pages = Array.from({ length: LIMITS.maxPages + 1 }, (_, index) => ({
    ...page,
    id: `page${index}`,
    root: { ...page.root, id: `root${index}`, children: [] },
  }));
  const contract = { ...GOOD_CONTRACT, screenId: 'page0' };
  const result = validateDesign({ root: fixture({ contract, preview }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'limit-exceeded'), JSON.stringify(result.errors));
});

test('资源限制：树深度超过 maxDepth → limit-exceeded', () => {
  let node = { id: 'leaf', type: 'text', props: { text: 'x' }, layout: { mode: 'flow' } };
  for (let i = LIMITS.maxDepth + 2; i > 0; i -= 1) {
    node = {
      id: `frame${i}`,
      type: 'frame',
      props: { direction: 'row', layoutMode: 'flow' },
      layout: { mode: 'flow' },
      children: [node],
    };
  }
  const preview = goodPreview();
  preview.pages[0].root = node;
  const result = validateDesign({ root: fixture({ preview }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'limit-exceeded'), JSON.stringify(result.errors));
});

test('资源限制：契约 designTokens 条目数超限 → limit-exceeded', () => {
  const tokens = {};
  for (let i = 0; i <= CONTRACT_LIMITS.maxTokenEntries; i += 1) tokens[`t${i}`] = i;
  const contract = { ...GOOD_CONTRACT, designTokens: tokens };
  const result = validateDesign({ root: fixture({ contract }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'limit-exceeded'), JSON.stringify(result.errors));
});

// ── contract-schema 与 client.js 规则对齐（抽样锁行为）──────────────────────
test('contract-schema：与 client.js 同一组必填字段', () => {
  for (const key of ['schemaVersion', 'designId', 'designVersion', 'platform', 'screenId']) {
    const broken = { ...GOOD_CONTRACT };
    delete broken[key];
    const result = validateContract(broken);
    assert.equal(result.ok, false, `缺 ${key} 应失败`);
    assert.ok(result.errors.some((e) => e.path === `$.${key}`), `${key} 应有路径化错误`);
  }
});

test('contract-schema：designTokens 值只允许 string|number', () => {
  const broken = { ...GOOD_CONTRACT, designTokens: { accent: '#ED8B43', bad: { nested: 1 } } };
  const result = validateContract(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === '$.designTokens.bad'));
});

test('contract-schema：changeScope 必须是两个字符串数组', () => {
  const broken = { ...GOOD_CONTRACT, changeScope: { allowed: 'nope', protected: [] } };
  const result = validateContract(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === '$.changeScope.allowed'));
});
