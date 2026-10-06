// DOM-free logic for "Install and connect" on a Connections row.

export const INSTALL_NOTES = {
  'needs-newer-cli': 'Needs a newer CodeMie CLI',
  'probe-failed': 'Could not check the CodeMie CLI version',
};

// Fails closed: if the help text cannot be read, nothing is installed.
export async function checkInstallSupported(runCapture) {
  let res;
  try {
    res = await runCapture('codemie proxy connect --help');
  } catch {
    return { ok: false, reason: 'probe-failed' };
  }
  const stdout = String(res?.stdout ?? '');
  const stderr = String(res?.stderr ?? '');
  if (!stdout.trim() && !stderr.trim()) return { ok: false, reason: 'probe-failed' };
  return /--install-client\b/.test(`${stdout}\n${stderr}`)
    ? { ok: true }
    : { ok: false, reason: 'needs-newer-cli' };
}

export function interpretInstallResult({ code, errorLine, downloadUrl }) {
  let error = errorLine || null;
  if (!error && code !== 0) error = `Install failed (exit ${code}).`;
  return { error, downloadUrl: error ? (downloadUrl ?? null) : null };
}

export function quoteForShell(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export async function openDownloadPage(url, runCapture) {
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  await runCapture(`open ${quoteForShell(parsed.href)}`);
  return true;
}

export function createRowStateStore() {
  const map = new Map();
  return {
    get: (app) => map.get(app),
    set: (app, state) => { map.set(app, state); },
    clear: (app) => { map.delete(app); },
  };
}
