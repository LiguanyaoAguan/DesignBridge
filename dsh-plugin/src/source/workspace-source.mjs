const PAGE_MAX_LINES = 5000;
const PAGE_MAX_PAGES = 20;

export function isWorkspaceRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || path.startsWith('/') || path.includes('\\')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  return !path.split('/').some(segment => segment === '..');
}

function classifyReadError(code, message) {
  const c = String(code ?? '').toLowerCase();
  const m = String(message ?? '').toLowerCase();
  if (c.includes('lookup-not-found')) return 'no-session';
  if (c.includes('not-text')) return 'not-text';
  if (c.includes('too-large') || c.includes('too_large')) return 'too-large';
  if (c.includes('bad-request')) return 'bad-path';
  if (c.includes('not-found') || m.includes('enoent') || m.includes('no such file')) return 'not-found';
  if (c.includes('permission') || c.includes('denied') || c.includes('forbidden') || m.includes('eacces') || m.includes('eperm')) return 'forbidden';
  return 'read-failed';
}

export async function readWorkspaceText(remote, sessionId, relativePath, signal) {
  if (sessionId === undefined || sessionId === null || sessionId === '') return { ok: false, kind: 'no-session' };
  if (!isWorkspaceRelativePath(relativePath)) return { ok: false, kind: 'bad-path', detail: relativePath };
  if (!remote?.workspaceFiles || typeof remote.workspaceFiles.read !== 'function') return { ok: false, kind: 'read-failed', detail: 'remote.workspaceFiles 不可用' };
  const parts = [];
  let offset = 1;
  for (let page = 0; page < PAGE_MAX_PAGES; page += 1) {
    let result;
    try { result = await remote.workspaceFiles.read(sessionId, relativePath, { offset, limit: PAGE_MAX_LINES }, signal); }
    catch (error) { return { ok: false, kind: 'read-failed', detail: String(error?.message ?? error) }; }
    if (!result || result.ok !== true) {
      const err = result?.error || {};
      return { ok: false, kind: classifyReadError(err.code, err.message), code: err.code, detail: err.message };
    }
    const value = result.value || {};
    parts.push(typeof value.text === 'string' ? value.text : '');
    if (value.eof === true) return { ok: true, text: parts.join('\n'), source: { relativePath, absolutePath: value.absolutePath, version: value.version, bytes: value.bytes, lines: value.lines, pages: page + 1 } };
    offset = (typeof value.offset === 'number' ? value.offset : offset) + PAGE_MAX_LINES;
  }
  return { ok: false, kind: 'too-large', detail: `超过 ${PAGE_MAX_PAGES} 页仍未读完` };
}
