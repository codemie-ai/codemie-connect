// The CLI update banner's version logic, kept out of renderer.js so it can be
// tested without Tauri.

// Compare semver strings. Returns true when a < b. Works for X.Y.Z format.
export function semverLt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return true;
    if (na > nb) return false;
  }
  return false;
}

// What the banner says once `codemie self-update` has returned, from the version
// the CLI reports afterwards. An update that left the old version in place must
// not read as a success (EPMCDME-15304: "Updated! → 0.15.2" under a 0.15.3 banner).
export function cliUpdateResult(newVersion, latest) {
  if (!newVersion) return { ok: false, label: 'Could not check the version — retry?', hideBanner: false };
  if (latest && semverLt(newVersion, latest)) {
    return { ok: false, label: `Still on ${newVersion} — retry?`, hideBanner: false };
  }
  return { ok: true, label: `Updated to ${newVersion}`, hideBanner: true };
}
