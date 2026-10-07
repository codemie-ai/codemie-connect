// Pure parser — no browser globals, safe to import in Node tests.
import stripAnsi from './ansi-strip.mjs';

export function findProxyConnectError(lines) {
  const found = lines.map(stripAnsi).find(l => /^\s*(✗|error:|failed:)/i.test(l));
  return found ? found.trim() : null;
}

// First "Download page: <url>" line; only https URLs are returned (as href).
export function extractDownloadUrl(lines) {
  for (const line of lines) {
    const m = /^\s*Download page:\s*(\S+)/.exec(line);
    if (!m) continue;
    try {
      const url = new URL(m[1]);
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Strips ANSI over the whole buffer first (so split or cursor escapes cannot
// hide a line), then looks for the ✗ line and the download page.
export function analyzeProxyOutput(rawBuffer) {
  const lines = stripAnsi(String(rawBuffer ?? '')).split(/\r\n|\r|\n/);
  return { errorLine: findProxyConnectError(lines), downloadUrl: extractDownloadUrl(lines) };
}

// The CLI can print migration notes before the JSON on a first run, so only
// the outermost {...} is parsed (the same read Home's Connections card does).
export function parseProxyStatusDeep(stdout) {
  try {
    const text = String(stdout ?? '');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { healthy: json && json.status === 'healthy' };
  } catch {
    return { healthy: false };
  }
}
