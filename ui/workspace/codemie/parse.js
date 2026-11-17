// Parsers for CLI output Settings → CodeMie reads that no legacy parser covers.

const STOPPED = Object.freeze({ state: 'stopped', port: null, profile: null });

/**
 * `codemie proxy status --json` → the gateway state. The payload also carries the gateway's
 * `apiKey`; it is never read, so it can never reach the page.
 */
export function parseProxyStatus(stdout) {
  const text = String(stdout ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return { ...STOPPED };
  let json;
  try { json = JSON.parse(text.slice(start, end + 1)); } catch { return { ...STOPPED }; }
  const state = json?.status === 'healthy' ? 'running' : json?.status === 'unhealthy' ? 'unhealthy' : 'stopped';
  if (state === 'stopped') return { ...STOPPED };
  return {
    state,
    port: Number.isInteger(json.port) ? json.port : null,
    profile: typeof json.profile === 'string' && json.profile ? json.profile : null,
  };
}
