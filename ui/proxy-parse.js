// Pure parser — no browser globals, safe to import in Node tests.
export function findProxyConnectError(lines) {
  const found = lines.find(l => /^\s*(✗|error:|failed:)/i.test(l));
  return found ? found.trim() : null;
}

export function parseProxyStatusDeep(stdout) {
  try {
    const json = JSON.parse(stdout);
    return { healthy: json && json.status === 'healthy' };
  } catch {
    return { healthy: false };
  }
}
