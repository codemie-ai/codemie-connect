// A CodeMie address as people type or paste it → the origin `codemie setup` and
// `codemie profile login --url` get. Pure; the copy for each reason lives in the views.

export const DEFAULT_CODEMIE_URL = 'https://codemie.lab.epam.com';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Adds https:// when there is no scheme, keeps the origin only (drops paths such as
 * /#/assistants and a trailing slash), lower-cases the host, and refuses plain http except
 * on this machine. A host without a dot is not an address (except localhost).
 * @returns {{ok: true, url: string} | {ok: false, reason: 'empty'|'invalid'|'insecure'}}
 */
export function normalizeCodemieUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol === 'http:' && !local) return { ok: false, reason: 'insecure' };
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: 'invalid' };
  if (!local && !url.hostname.includes('.')) return { ok: false, reason: 'invalid' };
  if (url.username || url.password) return { ok: false, reason: 'invalid' };
  return { ok: true, url: url.origin };
}

const hostOf = (url) => {
  try { return new URL(url).hostname; } catch { return ''; }
};

/** True for EPAM's own CodeMie (any host under epam.com). */
export const isEpamUrl = (url) => /(^|\.)epam\.com$/i.test(hostOf(url));
