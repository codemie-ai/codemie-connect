// "What CodeMie ran": the commands Settings → CodeMie ran in this session, with their output, for
// Health and for "Copy all" when someone asks for help. Secrets never get in: every command and
// every output chunk is redacted on the way in (`proxy status --json` carries the gateway key).

const SECRET_KEY = 'api[_-]?key|token|secret|password|cookies?|gatewayKey';
const JSON_PAIR = new RegExp(`("(?:[\\w.-]*?(?:${SECRET_KEY})[\\w.-]*)"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi');
const TEXT_PAIR = new RegExp(`\\b([\\w.-]*?(?:${SECRET_KEY})[\\w.-]*\\s*[=:]\\s*)(?!\\*\\*\\*)([^\\s"',;]+)`, 'gi');
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/** Masks secret values in JSON (`"apiKey": "…"`), `key=value` / `key: value` text and Bearer tokens. */
export function redact(text) {
  return String(text ?? '')
    .replace(JSON_PAIR, '$1"***"')
    .replace(BEARER, '$1***')
    .replace(TEXT_PAIR, '$1***');
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const label = (code) => (code === null ? 'running' : code === 0 ? 'ok' : 'FAILED');

export function createRunLog({ now = () => new Date(), limit = 50, maxChars = 20000 } = {}) {
  let entries = [];
  let nextId = 1;
  const listeners = new Set();
  const notify = () => { for (const fn of [...listeners]) fn(); };

  return {
    start(cmd) {
      const entry = { id: nextId++, at: now(), cmd: redact(cmd), code: null, output: '' };
      entries = [...entries, entry].slice(-limit);
      notify();
      return {
        id: entry.id,
        append(text) {
          const next = entry.output + redact(text);
          entry.output = next.length > maxChars ? next.slice(next.length - maxChars) : next;
          notify();
        },
        finish(code) {
          entry.code = Number.isInteger(code) ? code : 1;
          notify();
        },
      };
    },
    list: () => entries.slice(),
    text: () => entries
      .map((e) => `[${clock(e.at)}] ${label(e.code)}  $ ${e.cmd}\n${e.output}`.trimEnd())
      .join('\n\n'),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
