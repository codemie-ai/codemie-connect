// Pure parser — no browser globals, safe to import in Node tests.
export function findProxyConnectError(lines) {
  const found = lines.find(l => /^\s*(✗|error:|failed:)/i.test(l));
  return found ? found.trim() : null;
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
