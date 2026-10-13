import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkspaceText, isWorkspaceRelativePath } from '../src/source/workspace-source.mjs';

test('workspace-relative paths reject traversal, absolute paths and URL schemes', () => {
  for (const path of ['', '/etc/passwd', '../preview.json', 'a/../b', 'file:///a', 'https://example.test']) assert.equal(isWorkspaceRelativePath(path), false, path);
  assert.equal(isWorkspaceRelativePath('GitHub项目下载/DesignBridge/designs/demo-library/preview.json'), true);
});

test('readWorkspaceText paginates and returns source metadata', async () => {
  const calls = [];
  const remote = { workspaceFiles: { read: async (_session, path, range) => {
    calls.push({ path, ...range });
    return { ok: true, value: { text: range.offset === 1 ? 'first' : 'second', offset: range.offset, eof: range.offset !== 1, absolutePath: '/workspace/file', version: 'v1', bytes: 11, lines: 2 } };
  } } };
  const result = await readWorkspaceText(remote, 'session', 'designs/x/preview.json');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'first\nsecond');
  assert.deepEqual(calls.map(c => c.offset), [1, 5001]);
  assert.equal(result.source.version, 'v1');
  assert.equal(result.source.pages, 2);
});

test('read failures are explicit; no session and unsafe paths never call remote', async () => {
  let called = false;
  const remote = { workspaceFiles: { read: async () => { called = true; return { ok: false, error: { code: 'workspace-files/not-found', message: 'ENOENT' } }; } } };
  assert.equal((await readWorkspaceText(remote, null, 'x')).kind, 'no-session');
  assert.equal((await readWorkspaceText(remote, 's', '../x')).kind, 'bad-path');
  assert.equal(called, false);
  const miss = await readWorkspaceText(remote, 's', 'x');
  assert.equal(miss.ok, false); assert.equal(miss.kind, 'not-found');
  assert.equal(called, true);
});

test('exceptions and page exhaustion fail closed', async () => {
  const throwing = { workspaceFiles: { read: async () => { throw new Error('offline'); } } };
  assert.equal((await readWorkspaceText(throwing, 's', 'x')).kind, 'read-failed');
  let count = 0;
  const endless = { workspaceFiles: { read: async (_s, _p, range) => { count++; return { ok: true, value: { text: '', offset: range.offset, eof: false } }; } } };
  const exhausted = await readWorkspaceText(endless, 's', 'x');
  assert.equal(exhausted.ok, false); assert.equal(exhausted.kind, 'too-large'); assert.equal(count, 20);
});
