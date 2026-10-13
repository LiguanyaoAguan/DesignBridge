import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePreviewText } from '../src/model/preview-model.mjs';
import { LIMITS } from '../src/model/preview-schema.mjs';

const contract = JSON.parse(readFileSync(new URL('../../protocol/design-contract.json', import.meta.url), 'utf8'));
// ⚠️ 样本**从契约派生**，不写死具体设计：
//    契约说当前设计是谁，样本就跟着谁。否则每次交付新设计都会把测试砸掉（真踩过）。
const sample = { previewSchemaVersion: '1.0.0', designId: contract.designId, designVersion: contract.designVersion, pages: [{ id: contract.screenId, title: 'Library', viewport: { widthDp: 1280, heightDp: 800, orientation: contract.layout.orientation }, root: { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' } } }] };
const parse = (value, c = contract) => parsePreviewText(typeof value === 'string' ? value : JSON.stringify(value), c);
const expectError = (value, code, path, c) => { const r = parse(value, c); assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.code === code && e.path === path), JSON.stringify(r.errors)); };

test('valid model and checked-in demo parse', () => {
  assert.equal(parse(sample).ok, true);
  const demo = readFileSync(new URL(`../../designs/${contract.designId}/preview.json`, import.meta.url), 'utf8');
  assert.equal(parsePreviewText(demo, contract).ok, true);
});
test('invalid JSON and non-string input return stable errors', () => {
  assert.equal(parsePreviewText('{', contract).errors[0].code, 'invalid-json');
  assert.equal(parsePreviewText({}, contract).errors[0].code, 'type-mismatch');
});
test('UTF-8 byte cap is checked before JSON.parse', () => {
  const oversized = `"${'界'.repeat(Math.ceil(LIMITS.maxBytes / 3) + 1)}"`;
  const result = parsePreviewText(oversized, contract);
  assert.equal(result.ok, false); assert.equal(result.errors[0].code, 'input-too-large');
  assert.equal(result.errors[0].path, '$');
});
test('contract identity and version exact match', () => {
  expectError({ ...sample, designId: 'other' }, 'design-id-mismatch', '$.designId');
  expectError({ ...sample, designVersion: 'v1' }, 'design-version-mismatch', '$.designVersion');
  assert.equal(parse({ ...sample, designVersion: contract.designVersion }).ok, true);
});
test('page id and orientation correspond to declared contract fields', () => {
  const withOtherScreen = { ...contract, screenId: 'other' };
  expectError(sample, 'screen-id-mismatch', '$.pages', withOtherScreen);
  const withOtherOrientation = { ...contract, layout: { ...contract.layout, orientation: 'portrait' } };
  expectError(sample, 'orientation-mismatch', '$.pages[0].viewport.orientation', withOtherOrientation);
  const noOptionalFields = { designId: sample.designId, designVersion: sample.designVersion };
  assert.equal(parse(sample, noOptionalFields).ok, true);
});
test('duplicate JSON key follows JSON.parse last-value behavior', () => {
  const text = `{"previewSchemaVersion":"0.0.0","previewSchemaVersion":"1.0.0","designId":"${contract.designId}","designVersion":"${contract.designVersion}","pages":[]}`;
  const result = parsePreviewText(text, contract);
  assert.equal(result.errors.some(e => e.code === 'unsupported-version'), false);
  assert.equal(result.ok, false); assert.ok(result.errors.some(e => e.code === 'limit-exceeded'));
});
test('malicious strings remain data and never execute', () => {
  globalThis.__previewExecuted = false;
  const hostile = { ...sample, pages: [{ ...sample.pages[0], root: { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: [{ id: 'txt', type: 'text', props: { text: '<img src=x onerror="globalThis.__previewExecuted=true"> javascript:alert(1)' } }] } }] };
  assert.equal(parse(hostile).ok, true); assert.equal(globalThis.__previewExecuted, false); delete globalThis.__previewExecuted;
});
test('error cap flag means validation stopped at 50; exactly 50 and >50 are covered', () => {
  const basePage = sample.pages[0];
  const manyIssuesRoot = { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, type: 'text', props: { text: 'x', extra: i }, extraNodeField: true })) };
  const exact50 = { ...sample, pages: [{ ...basePage, root: manyIssuesRoot }] };
  const atCap = parse(exact50);
  assert.equal(atCap.ok, false); assert.equal(atCap.errors.length, 50); assert.equal('truncatedErrors' in atCap, false);
  const over50 = { ...exact50, pages: [{ ...basePage, root: { ...manyIssuesRoot, children: [...manyIssuesRoot.children, { id: 'extra', type: 'text', props: { text: 'x', extra: true }, extraNodeField: true }] } }] };
  const aboveCap = parse(over50);
  assert.equal(aboveCap.ok, false); assert.equal(aboveCap.errors.length, 50); assert.equal(aboveCap.truncatedErrors, true);
  const noIssues = parse(sample); assert.equal(noIssues.ok, true); assert.equal('truncatedErrors' in noIssues, false);
  const tooLarge = ' '.repeat(LIMITS.maxBytes + 1);
  assert.equal(parsePreviewText(tooLarge, contract).errors[0].code, 'input-too-large');
});
test('malformed but valid JSON structures never throw', () => {
  const malformed = [
    `{"previewSchemaVersion":"1.0.0","designId":"${contract.designId}","designVersion":"${contract.designVersion}","pages":[null]}`,
    `{"previewSchemaVersion":"1.0.0","designId":"${contract.designId}","designVersion":"${contract.designVersion}","pages":[{"id":"${contract.screenId}","title":"x","viewport":[],"root":{"id":"r","type":"frame","props":null,"children":[null,{"id":"x","type":"text","props":{"text":"x"},"layout":[]}]}}]}`
  ];
  for (const json of malformed) {
    assert.doesNotThrow(() => parsePreviewText(json, contract));
    assert.equal(parsePreviewText(json, contract).ok, false);
  }
});
test('valid-JSON fuzz shapes produce structured results without uncaught exceptions', () => {
  const candidates = [null, [], { ...sample, pages: [null] }, { ...sample, pages: [{}] }, { ...sample, pages: [{ ...sample.pages[0], root: { id: 'r', type: 'frame', props: [], children: [null, 1, 'x', []] } }] }, { ...sample, pages: [{ ...sample.pages[0], root: { id: 'r', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: [{ id: 'list', type: 'list', props: {}, children: [null, { id: 'li', type: 'list-item', props: { label: 'x' }, layout: false }] }] } }] }];
  for (const candidate of candidates) {
    const json = JSON.stringify(candidate);
    assert.doesNotThrow(() => parsePreviewText(json, contract));
    const result = parsePreviewText(json, contract);
    assert.ok(result && typeof result.ok === 'boolean');
    if (!result.ok) assert.ok(Array.isArray(result.errors));
  }
});
