// Explicit allowlist, independent of mutable installation step IDs and handlers.
export async function runReadOnlyProbe(inspector) {
  const results = {};
  for (const [name, method] of [['git','checkGit'],['node','checkNode'],['npm','checkNpm'],['codemie','checkCodemie']]) {
    if (typeof inspector[method] !== 'function') throw new Error(`Missing read-only inspector: ${name}`);
    results[name] = await inspector[method]();
  }
  return results;
}
