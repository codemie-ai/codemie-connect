// Pure decision table — no browser/DOM globals, safe to import in Node tests.
export function computeRowStatus({ appInstalled, configPresent, daemonHealthy }) {
  if (!appInstalled) return 'not-installed';
  if (!configPresent) return 'not-set';
  return daemonHealthy ? 'connected' : 'disconnected';
}
