import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePreviewText } from '../src/model/preview-model.mjs';
import { LIMITS } from '../src/model/preview-schema.mjs';

const contract = JSON.parse(readFileSync(new URL('../../protocol/design-contract.json', import.meta.url), 'utf8'));
const sample = { previewSchemaVersion: '1.0.0', designId: 'demo-library', designVersion: 'demo-0.1', pages: [{ id: 'library', title: 'Library', viewport: { widthDp: 1280, heightDp: 800, orientation: 'landscape' }, root: { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' } } }] };
const parse = (value, c = contract) => parsePreviewText(typeof value === 'string' ? value : JSON.stringify(value), c);
const expectError = (value, code, path, c) => { const r = parse(value, c); assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.code === code && e.path === path), JSON.stringify(r.errors)); };

test('valid model and checked-in demo parse', () => {
  assert.equal(parse(sample).ok, true);
  const demo = readFileSync(new URL('../../designs/demo-library/preview.json', import.meta.url), 'utf8');
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
  assert.equal(parse({ ...sample, designVersion: 'demo-0.1' }).ok, true);
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
  const text = '{"previewSchemaVersion":"0.0.0","previewSchemaVersion":"1.0.0","designId":"demo-library","designVersion":"demo-0.1","pages":[]}';
  const result = parsePreviewText(text, contract);
  assert.equal(result.errors.some(e => e.code === 'unsupported-version'), false);
  assert.equal(result.ok, false); assert.ok(result.errors.some(e => e.code === 'limit-exceeded'));
});
test('malicious strings remain data and never execute', () => {
  globalThis.__previewExecuted = false;
  const hostile = { ...sample, pages: [{ ...sample.pages[0], root: { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: [{ id: 'txt', type: 'text', props: { text: '<img src=x onerror="globalThis.__previewExecuted=true"> javascript:alert(1)' } }] } }] };
  assert.equal(parse(hostile).ok, true); assert.equal(globalThis.__previewExecuted, false); delete globalThis.__previewExecuted;
});
test('errors capped at 50 and JSON parser not invoked for huge input', () => {
  const manyPages = { ...sample, pages: Array.from({ length: LIMITS.maxPages + 1 }, (_, i) => ({ ...sample.pages[0], id: `p${i}` })) };
  const result = parse(manyPages);
  assert.equal(result.ok, false); assert.ok(result.errors.length <= 50);
  const tooLarge = ' '.repeat(LIMITS.maxBytes + 1);
  assert.equal(parsePreviewText(tooLarge, contract).errors[0].code, 'input-too-large');
});
