// In-app interactive terminal (xterm.js) hosting the pty steps (codemie setup /
// install) and the home-page command actions (proxy connect / analytics).
import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';

const { invoke } = window.__TAURI__.core;

let term = null;
let fit = null;
let overlay = null;
let hostEl = null;
let titleEl = null;
let hintEl = null;
let doneBtn = null;

// When true, the overlay stays open on pty-exit and shows a "back" button instead
// of auto-closing. Used by home-page actions; wizard pty steps keep auto-close.
let keepOpen = false;
let onCloseCb = null;

const DEFAULT_HINT = 'Follow the prompts above. This will close automatically when the step finishes.';

export function initTerminal({ overlay: ov, host, title, hint, done }) {
  overlay = ov;
  hostEl = host;
  titleEl = title;
  hintEl = hint || null;
  doneBtn = done || null;
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

  if (doneBtn) {
    doneBtn.addEventListener('click', () => {
      closeTerminal();
      if (onCloseCb) onCloseCb();
    });
  }

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

// opts.keepOpen: keep the overlay open after the command exits (home actions).
// opts.onClose: invoked when the user dismisses a keepOpen terminal.
export function openTerminal(title, opts = {}) {
  keepOpen = Boolean(opts.keepOpen);
  onCloseCb = opts.onClose || null;
  if (titleEl && title) titleEl.textContent = title;
  if (hintEl) hintEl.textContent = opts.hint || DEFAULT_HINT;
  if (doneBtn) doneBtn.classList.add('hidden');
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

// Write a plain string (e.g. a final status line) straight to the terminal.
export function writeLine(text) {
  if (term) term.write(text);
}

// Called when the active pty exits. Auto-closes for wizard steps on clean exit;
// on non-zero exit keeps the overlay open so the user can read the error output.
// For home actions (keepOpen) always reveals the “back to home” affordance.
export function handlePtyExit(code) {
  const failed = code !== undefined && code !== 0;
  if (keepOpen || failed) {
    if (hintEl) {
      hintEl.textContent = failed
        ? `Finished with errors (exit ${code}). Click “‹ Back” to return.`
        : 'Finished. Click “‹ Back” to return.';
    }
    if (doneBtn) doneBtn.classList.remove('hidden');
  } else {
    closeTerminal();
  }
}

export function closeTerminal() {
  if (overlay) overlay.classList.add('hidden');
  if (doneBtn) doneBtn.classList.add('hidden');
  keepOpen = false;
}
