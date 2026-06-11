// In-app interactive terminal (xterm.js) hosting the pty steps (codemie setup / install).
import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';

const { invoke } = window.__TAURI__.core;

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

  // Keystrokes -> pty (Rust routes to the active pty in managed state).
  term.onData((d) => invoke('pty_input', { data: d }));

  window.addEventListener('resize', () => {
    if (!overlay.classList.contains('hidden')) doFit();
  });
}

function doFit() {
  try {
    fit.fit();
    invoke('pty_resize', { cols: term.cols, rows: term.rows });
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

// PTY data arrives base64-encoded (Rust emits it that way to avoid corrupting
// multi-byte UTF-8 / ANSI escapes split across read boundaries). Decode to bytes
// and let xterm handle the byte stream.
export function writeData(b64) {
  if (!term) return;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    term.write(bytes);
  } catch {
    term.write(b64);
  }
}

export function closeTerminal() {
  if (overlay) overlay.classList.add('hidden');
}
