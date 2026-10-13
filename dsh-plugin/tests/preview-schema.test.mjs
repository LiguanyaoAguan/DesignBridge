import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePreviewSchema } from '../src/model/preview-schema.mjs';

const node = (type, id = 'n', props = {}) => ({ id, type, props });
const base = (root = { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' } }) => ({ previewSchemaVersion: '1.0.0', designId: 'demo-library', designVersion: 'demo-0.1', pages: [{ id: 'library', title: 'Library', viewport: { widthDp: 1280, heightDp: 800, orientation: 'landscape' }, root }] });
const valid = value => assert.equal(validatePreviewSchema(value).ok, true, JSON.stringify(validatePreviewSchema(value).errors));
const invalid = (value, code, path) => { const r = validatePreviewSchema(value); assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.code === code && e.path === path), JSON.stringify(r.errors)); };

test('minimal preview and all nine component types', () => {
  const root = { id: 'root', type: 'frame', props: { direction: 'column', layoutMode: 'flow' }, children: [
    node('text', 't', { text: 'hello' }), node('button', 'b', { label: 'go' }),
    { id: 'c', type: 'card', props: { title: 'card' }, children: [] },
    { id: 'l', type: 'list', props: {}, children: [node('list-item', 'li', { label: 'item' })] },
    node('badge', 'ba', { label: 'new' }), node('divider', 'd', {}), node('image-placeholder', 'im', { label: 'cover' })
  ] };
  valid(base(root));
});
test('frame and card may omit children or use empty arrays', () => { valid(base()); valid(base({ id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: [] })); });
test('list requires non-empty list-item children', () => {
  invalid(base({ id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: [{ id: 'list', type: 'list', props: {} }] }), 'required-field', '$.pages[0].root.children[0].children');
  invalid(base({ id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: [{ id: 'list', type: 'list', props: {}, children: [] }] }), 'invalid-nesting', '$.pages[0].root.children[0].children');
  invalid(base({ id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: [{ id: 'list', type: 'list', props: {}, children: [node('text', 'x', { text: 'no' })] }] }), 'invalid-nesting', '$.pages[0].root.children[0].children[0].type');
});
test('strict unknown fields, types, props and leaves', () => {
  invalid({ ...base(), extra: 1 }, 'unknown-field', '$.extra');
  invalid(base(node('mystery', 'x', {})), 'unknown-component-type', '$.pages[0].root.type');
  const leafWithChildren = base(); leafWithChildren.pages[0].root.children = [node('text', 't', { text: 'x' })]; leafWithChildren.pages[0].root.children[0].children = [];
  invalid(leafWithChildren, 'invalid-nesting', '$.pages[0].root.children[0].children');
  invalid(base({ id: 'root', type: 'frame', props: { direction: 'row' } }), 'required-field', '$.pages[0].root.props.layoutMode');
});
test('layout flow and absolute constraints', () => {
  const abs = { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'absolute' }, children: [node('text', 't', { text: 'x' })] };
  abs.children[0].layout = { mode: 'absolute', x: 0, y: 0, width: 80, height: 24 }; valid(base(abs));
  const conflict = { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: [node('text', 't', { text: 'x' })] };
  conflict.children[0].layout = { mode: 'absolute', x: 0, y: 0, width: 80, height: 24 };
  invalid(base(conflict), 'layout-mode-conflict', '$.pages[0].root.children[0].layout');
  const partial = { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'absolute' }, children: [node('text', 't', { text: 'x' })] };
  partial.children[0].layout = { mode: 'absolute', x: 0, y: 0, width: 80 };
  invalid(base(partial), 'required-field', '$.pages[0].root.children[0].layout.height');
});
test('duplicate ids, enum/range, and schema version errors', () => {
  const dup = base({ id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: [node('text', 'same', { text: 'a' }), node('text', 'same', { text: 'b' })] });
  invalid(dup, 'duplicate-node-id', '$.pages[0].root.children[1].id');
  invalid(base({ id: 'root', type: 'frame', props: { direction: 'diagonal', layoutMode: 'flow' } }), 'invalid-value', '$.pages[0].root.props.direction');
  invalid({ ...base(), previewSchemaVersion: '2.0.0' }, 'unsupported-version', '$.previewSchemaVersion');
});
test('root must be frame; duplicate page IDs are rejected', () => {
  invalid(base(node('text', 'root', { text: 'x' })), 'invalid-nesting', '$.pages[0].root.type');
  const value = base(); value.pages.push({ ...value.pages[0] });
  invalid(value, 'duplicate-page-id', '$.pages[1].id');
});
test('page, depth, node-count and string limits reject overages', () => {
  const tooManyPages = base(); tooManyPages.pages = Array.from({ length: 33 }, (_, i) => ({ ...tooManyPages.pages[0], id: `p${i}` }));
  invalid(tooManyPages, 'limit-exceeded', '$.pages');
  let deep = { id: 'root', type: 'frame', props: { direction: 'column', layoutMode: 'flow' } };
  let cursor = deep;
  for (let i = 2; i <= 13; i += 1) { const child = { id: `f${i}`, type: 'frame', props: { direction: 'column', layoutMode: 'flow' } }; cursor.children = [child]; cursor = child; }
  const deepResult = validatePreviewSchema(base(deep)); assert.ok(deepResult.errors.some(e => e.code === 'limit-exceeded' && e.path.endsWith('.children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0]')));
  const many = { id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: Array.from({ length: 2000 }, (_, i) => node('text', `t${i}`, { text: 'x' })) };
  invalid(base(many), 'limit-exceeded', '$.pages[0].root.children[1999]');
  invalid(base({ id: 'root', type: 'frame', props: { direction: 'row', layoutMode: 'flow' }, children: [node('text', 'long', { text: 'x'.repeat(4097) })] }), 'invalid-value', '$.pages[0].root.children[0].props.text');
});
