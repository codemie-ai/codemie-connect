const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function shouldCheckForAppUpdate(lastCheckIso) {
  if (!lastCheckIso) return true;
  return Date.now() - new Date(lastCheckIso).getTime() >= CHECK_INTERVAL_MS;
}
