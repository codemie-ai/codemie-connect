// Claude Desktop disconnect: parses `codemie proxy disconnect --claude-desktop`
// output and keeps the local "disconnected" flag Home reads.

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// Exit 0 without either known phrase is an older CLI that ignored the flag
// (it prints a target list), so it is `unknown`, never success.
export function parseDisconnect({ code, stdout = '', stderr = '' }) {
  const out = stdout.replace(ANSI, '');
  const err = stderr.replace(ANSI, '');
  if (code !== 0) {
    const line = out.match(/✗\s*Claude Desktop\s*[—-]\s*(.+)/);
    return { kind: 'failed', message: (line ? line[1] : err.trim() || out.trim()).trim() };
  }
  if (/Claude Desktop disconnected/i.test(out)) return { kind: 'disconnected', message: '' };
  if (/nothing to disconnect/i.test(out)) return { kind: 'nothing', message: '' };
  return { kind: 'unknown', message: '' };
}

const KEY = 'codemie.claudeDesktop.disconnected';

export function readDisconnected(storage) {
  try {
    return storage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function markDisconnected(storage) {
  try {
    storage?.setItem(KEY, '1');
  } catch {
    // Storage unavailable: the flag just does not persist.
  }
}

export function clearDisconnected(storage) {
  try {
    storage?.removeItem(KEY);
  } catch {
    // See markDisconnected.
  }
}
