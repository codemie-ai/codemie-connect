// The spinner a screen shows under its header while its first read runs.
// Agents and Health both open on a command that takes a few seconds, and a
// header over an empty screen reads as a screen that failed to draw.
export function screenSpinner(doc = document) {
  const wrap = doc.createElement('div');
  wrap.className = 'screen-loading';
  const spin = doc.createElement('span');
  spin.className = 'screen-spinner';
  spin.setAttribute?.('role', 'status');
  spin.setAttribute?.('aria-label', 'Loading');
  wrap.appendChild(spin);
  return wrap;
}
