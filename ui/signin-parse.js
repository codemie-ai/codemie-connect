// Pure parser — no browser globals, safe to import in Node tests.
// Matches error lines from the CLI regardless of capitalisation or prefix style.
// Known prefixes: ✗  Error:  error:  FAILED:  failed:
export function findLoginError(lines) {
  const found = lines.find(l => /^\s*(✗|[Ee]rror:|FAILED:|failed:)/.test(l));
  return found ? found.trim() : null;
}
