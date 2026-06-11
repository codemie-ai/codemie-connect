// In-app interactive terminal (xterm.js) hosting the pty steps (codemie setup / install).
import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';

let term = null;
let fit = null;
let overlay = null;
let hostEl = null;
let titleEl = null;

export function initTerminal({ overlay: ov, host, title }) {
  overlay = ov;
  hostEl = host;
  titleEl = title;
  term = new Terminal({
    fontSize: 13,
    fontFamily: 'SF Mono, Menlo, Consolas, monospace',
    cursorBlink: true,
    theme: { background: '#0a0c12', foreground: '#c9d1d9' },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(hostEl);

  // Keystrokes -> pty (main process routes to the active pty).
  term.onData((d) => window.codemie.ptyInput(d));

  window.addEventListener('resize', () => {
    if (!overlay.classList.contains('hidden')) doFit();
  });
}

function doFit() {
  try {
    fit.fit();
    window.codemie.ptyResize(term.cols, term.rows);
  } catch {
    /* ignore */
  }
}

export function openTerminal(title) {
  if (titleEl && title) titleEl.textContent = title;
  term.reset();
  overlay.classList.remove('hidden');
  // Fit after the overlay is laid out.
  setTimeout(doFit, 30);
  term.focus();
}

export function writeData(data) {
  if (term) term.write(data);
}

export function closeTerminal() {
  if (overlay) overlay.classList.add('hidden');
}
