// Parsers for CLI output Settings → CodeMie reads that no legacy parser covers.

const NO_NETWORK = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|getaddrinfo/i;
// How the CLI marks a line that states a failure, and the glyph to strip off it.
const ERROR_LINE = /^\s*[✗✖×❌]\s|^\s*(Error|Failed)\b/i;
const ERROR_GLYPH = /^\s*[✗✖×❌]\s*/;

/**
 * The sentence a failed CLI call is reported with (legacy `agents-controller.js` messageFor).
 * The CLI rarely ends on its error — a failed install prints the reason, then the agent list,
 * then a tip — so its error glyphs mark the real line, and the last of them is the most specific.
 */
export function failureMessage(lines, verb = 'This') {
  const text = lines.join('\n');
  if (NO_NETWORK.test(text)) return `${verb} needs a connection. Check your internet connection or VPN, then try again.`;
  const timedOut = text.match(/timed out after (\d+)\s*ms/i);
  if (timedOut) return `Took longer than ${Math.max(1, Math.round(Number(timedOut[1]) / 60000))} minutes. Check your connection and try again.`;
  const failures = lines.filter((l) => ERROR_LINE.test(l));
  if (failures.length) return failures[failures.length - 1].replace(ERROR_GLYPH, '').trim();
  const last = [...lines].reverse().find((l) => l && l.trim());
  return last ? last.trim() : 'The command stopped without saying why.';
}

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
