import { semverLt } from './cli-update.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function shouldCheckForAppUpdate(lastCheckIso, intervalMs = CHECK_INTERVAL_MS) {
  if (!lastCheckIso) return true;
  return Date.now() - new Date(lastCheckIso).getTime() >= intervalMs;
}

export const PENDING_UPDATE_KEY = 'codemie.app.pendingUpdate';

// An update was started (marker holds its target version) but the app is still
// older, so the installer failed after the app had already exited.
export function updateDidNotFinish(pendingVersion, currentVersion) {
  return Boolean(pendingVersion) && semverLt(currentVersion, pendingVersion);
}
