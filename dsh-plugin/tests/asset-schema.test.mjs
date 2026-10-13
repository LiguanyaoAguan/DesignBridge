import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAssets, checkAssetReferences, checkAssetPath, ASSET_SCHEMA_VERSION } from '../src/model/asset-schema.mjs';

const DID = 'demo-x';
const P = `designs/${DID}/assets/`;

function manifest(assets) {
  return { assetSchemaVersion: ASSET_SCHEMA_VERSION, assets };
}
function svg(id, path = `${P}icons/${id}.svg`, extra = {}) {
  return { id, kind: 'svg', path, ...extra };
}
function errorsOf(value, designId = DID) {
  return validateAssets(value, { designId }).errors;
}
function codes(value, designId = DID) {
  return errorsOf(value, designId).map(e => e.code);
}

test('合法清单通过，并规范化 kind 上限', () => {
  const result = validateAssets(manifest([
    svg('nav-all'),
    { id: 'cover', kind: 'image', path: `${P}img/cover.png`, bytes: 1024 },
  ]), { designId: DID });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.assets.size, 2);
  assert.equal(result.declaredBytes, 1024);
  assert.equal(result.assets.get('nav-all').maxBytes, 64 * 1024);
  assert.equal(result.assets.get('cover').maxBytes, 512 * 1024);
});

test('路径穿越一律拒绝', () => {
  const bad = [
    `${P}../../etc/passwd.svg`,
    `${P}icons/../../../secret.svg`,
    'designs/demo-x/../../../etc/passwd.svg',
    `${P}%2e%2e/secret.svg`,
  ];
  for (const path of bad) {
    const result = validateAssets(manifest([svg('a', path)]), { designId: DID });
    assert.equal(result.ok, false, `应拒绝：${path}`);
    assert.ok(result.errors.some(e => e.code === 'unsafe-path'), `应报 unsafe-path：${path}`);
  }
});

test('绝对路径 / scheme / 网络路径 / 反斜杠 一律拒绝', () => {
  const bad = [
    '/etc/passwd.svg',
    'file:///etc/passwd.svg',
    'https://evil.example.com/a.svg',
    '//evil.example.com/a.svg',
    'designs\\demo-x\\assets\\a.svg',
    'C:/windows/a.svg',
  ];
  for (const path of bad) {
    const result = validateAssets(manifest([svg('a', path)]), { designId: DID });
    assert.equal(result.ok, false, `应拒绝：${path}`);
  }
});

test('资源必须落在本设计的 assets/ 目录内', () => {
  const result = validateAssets(manifest([svg('a', 'designs/demo-y/assets/icons/a.svg')]), { designId: DID });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.code === 'unsafe-path'));
});

test('扩展名必须与 kind 自洽', () => {
  const mismatch = [
    svg('a', `${P}icons/a.png`),
    { id: 'b', kind: 'image', path: `${P}img/b.svg` },
    { id: 'c', kind: 'image', path: `${P}img/c.gif` },
    svg('d', `${P}icons/d.svg.exe`),
  ];
  for (const asset of mismatch) {
    const result = validateAssets(manifest([asset]), { designId: DID });
    assert.equal(result.ok, false, `应拒绝：${asset.path}`);
    assert.ok(result.errors.some(e => e.code === 'format-mismatch'), asset.path);
  }
});

test('id 非法与重复被拒绝', () => {
  assert.ok(codes(manifest([svg('1bad')])).includes('invalid-value'));
  assert.ok(codes(manifest([svg('a'), svg('a', `${P}icons/a2.svg`)])).includes('duplicate-id'));
  assert.ok(codes(manifest([svg('a'.repeat(65))])).includes('invalid-value'));
});

test('体积上限：数量上限与 maxBytes 只能收紧不能放宽', () => {
  const many = Array.from({ length: 65 }, (_, i) => svg(`a${i}`, `${P}icons/a${i}.svg`));
  assert.ok(codes(manifest(many)).includes('limit-exceeded'));

  const loosened = validateAssets(manifest([svg('a', undefined, { maxBytes: 1024 * 1024 })]), { designId: DID });
  assert.equal(loosened.ok, true);
  assert.equal(loosened.assets.get('a').maxBytes, 64 * 1024, 'svg 上限不得被放宽');

  const tightened = validateAssets(manifest([svg('a', undefined, { maxBytes: 100 })]), { designId: DID });
  assert.equal(tightened.assets.get('a').maxBytes, 100, '允许收紧');
  assert.ok(codes(manifest([svg('a', undefined, { maxBytes: -1 })])).includes('invalid-value'));
});

test('声明总量超限被拒绝', () => {
  const assets = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, kind: 'image', path: `${P}img/a${i}.png`, bytes: 400 * 1024 }));
  assert.ok(codes(manifest(assets)).includes('limit-exceeded'));
});

test('形状错误与版本不符被拒绝', () => {
  assert.ok(codes(null).includes('invalid-shape'));
  assert.ok(codes({ assetSchemaVersion: '9.9.9', assets: [] }).includes('unsupported-version'));
  assert.ok(codes({ assetSchemaVersion: ASSET_SCHEMA_VERSION, assets: {} }).includes('invalid-shape'));
});

test('checkAssetPath 的边界（控制字符 / 空段 / 编码）', () => {
  assert.equal(checkAssetPath(`${P}a.svg`, P).ok, true);
  assert.equal(checkAssetPath('', P).ok, false);
  assert.equal(checkAssetPath(`${P}a\u0000.svg`, P).ok, false);
  assert.equal(checkAssetPath(`${P}a//b.svg`, P).ok, false);
  assert.equal(checkAssetPath(`${P}./a.svg`, P).ok, false);
});

test('引用交叉检查：未声明的资源必须报错', () => {
  const preview = {
    pages: [{
      id: 'p1',
      root: {
        id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' },
        children: [
          { id: 'i1', type: 'icon', props: { asset: 'known' } },
          { id: 'i2', type: 'icon', props: { asset: 'ghost' } },
          { id: 'im', type: 'image', props: { asset: 'also-ghost' } },
        ],
      },
    }],
  };
  const declared = validateAssets(manifest([svg('known')]), { designId: DID }).assets;
  const errs = checkAssetReferences(preview, declared);
  assert.equal(errs.length, 2);
  assert.deepEqual(errs.map(e => e.code), ['missing-asset', 'missing-asset']);
  // 路径用**索引**定位（$.pages[0].root.children[1]），便于设计方直接定位到节点
  assert.ok(errs[0].path.includes('children[1]'), errs[0].path);
  assert.ok(errs[1].path.includes('children[2]'), errs[1].path);
});

test('引用交叉检查对旧版 preview（无资源引用）返回空', () => {
  const preview = { pages: [{ id: 'p1', root: { id: 'root', type: 'frame', props: {}, children: [{ id: 't', type: 'text', props: { text: 'hi' } }] } }] };
  assert.deepEqual(checkAssetReferences(preview, new Map()), []);
  assert.deepEqual(checkAssetReferences(null, new Map()), []);
});
