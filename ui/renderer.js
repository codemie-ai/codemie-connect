// Entry point (Option B): builds the install Engine in the renderer and drives it
// against granular Rust commands. Engine UI events are dispatched locally; only
// Rust-origin events (pty-data/exit) arrive via Tauri listen().
import { Engine } from './engine.js';
import { makeHandlers } from './handlers.js';
import { initSprite } from './sprite.js';
import * as stepsUI from './steps-ui.js';
import { initLog, appendLine } from './log.js';
import { initTerminal, openTerminal, writeData, closeTerminal } from './terminal.js';
import * as bridge from './runner-bridge.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

// Capture boot/runtime errors so the smoke self-test can read them.
window.addEventListener('error', (e) => {
  window.__bootError = String((e.error && e.error.stack) || e.message || e);
});
window.addEventListener('unhandledrejection', (e) => {
  window.__bootError = String((e.reason && e.reason.stack) || e.reason || e);
});

const PILL = {
  idle: { label: 'Idle', color: '#484f58' },
  working: { label: 'Working…', color: '#58a6ff' },
  warning: { label: 'Attention', color: '#d29922' },
  success: { label: 'Success!', color: '#3fb950' },
  error: { label: 'Error', color: '#ff6b6b' },
  victory: { label: 'Complete!', color: '#3fb950' },
};

let sprite = null;
let unattended = false;
let engine = null;

const dotEl = document.getElementById('status-dot');
const statusTextEl = document.getElementById('status-text');
const installBtn = document.getElementById('install-btn');
const closeBtn = document.getElementById('close-btn');
const unattendedCb = document.getElementById('unattended-cb');

function setSprite(state) {
  if (sprite) sprite.setState(state);
  const meta = PILL[state] || PILL.idle;
  dotEl.style.background = meta.color;
  statusTextEl.textContent = meta.label;
}

// The engine's emit sink: route events to the UI locally; mirror terminal-lines to
// the on-disk log via Rust. (The 'engine:' prefix is no longer needed — no IPC hop.)
function emit(event, payload) {
  const p = payload || {};
  if (event === 'terminal-line') {
    invoke('log_line', { text: p.text, tag: p.tag || 'stdout' }).catch(() => {});
    appendLine(p.text, p.tag);
    return;
  }
  switch (event) {
    case 'status-change':
      stepsUI.setStatus(p.id, p.status);
      break;
    case 'subtitle-change':
      stepsUI.setSubtitle(p.id, p.text);
      break;
    case 'spinner-start':
      stepsUI.startSpinner(p.id);
      break;
    case 'substep-activate':
      stepsUI.insertSubStep(p.parent_id, p.step);
      break;
    case 'download-progress':
      stepsUI.setProgress(p.id, p.fraction);
      break;
    case 'approval-needed':
      stepsUI.showApproval(
        p.id,
        p.message,
        () => engine.approve(),
        () => engine.ignore()
      );
      break;
    case 'pty-open':
      openTerminal(p.title);
      break;
    case 'fatal':
      setSprite('error');
      document.getElementById('fatal-message').textContent = p.message || 'Installation failed.';
      document.getElementById('fatal-reco').textContent = p.recommendation || '';
      document.getElementById('fatal-overlay').classList.remove('hidden');
      break;
    case 'complete':
      setSprite(p.ok === false ? 'warning' : 'victory');
      installBtn.classList.add('hidden');
      closeBtn.classList.remove('hidden');
      break;
    default:
      break;
  }
}

async function boot() {
  const flags = await invoke('smoke_mode');

  const list = await invoke('get_steps');
  stepsUI.renderSteps(document.getElementById('step-list'), list);

  const logoPath = await invoke('get_logo_path');
  sprite = initSprite(document.getElementById('sprite-canvas'), logoPath);
  setSprite('idle');

  initLog({
    content: document.getElementById('log-content'),
    panel: document.getElementById('log-panel'),
    toggle: document.getElementById('log-toggle'),
    openBtn: document.getElementById('open-log'),
  });
  initTerminal({
    overlay: document.getElementById('terminal-overlay'),
    host: document.getElementById('terminal-host'),
    title: document.getElementById('terminal-title'),
  });

  const handlers = makeHandlers({
    inspector: bridge.inspector,
    runner: bridge.runner,
    installer: bridge.installer,
    pathman: bridge.pathman,
    downloader: bridge.downloader,
    pty: bridge.pty,
    arch: 'universal',
    tmpDir: await invoke('temp_dir'),
  });

  engine = new Engine({
    steps: list,
    handlers,
    emit,
    isUnattended: () => unattended,
  });

  // Rust-origin events: PTY output/exit stream from the portable-pty reader threads.
  await listen('engine:pty-data', (e) => writeData(e.payload.data));
  await listen('engine:pty-exit', () => closeTerminal());

  // ---- controls ----
  unattendedCb.addEventListener('change', () => {
    unattended = unattendedCb.checked;
  });
  installBtn.addEventListener('click', () => {
    installBtn.disabled = true;
    unattended = unattendedCb.checked;
    setSprite('working');
    engine.run().catch((err) => emit('terminal-line', { text: `Engine error: ${(err && err.message) || err}`, tag: 'stderr' }));
  });
  closeBtn.addEventListener('click', () => getCurrentWindow().close());
  document.getElementById('fatal-close').addEventListener('click', () => getCurrentWindow().close());

  if (flags.probe) {
    await runProbe(handlers);
    return;
  }
  if (flags.smoke) {
    await runSmoke(flags);
  }
}

// Non-destructive detection-only run (CODEMIE_PROBE_SMOKE). Forces 1.3 to detect
// without installing so the smoke never runs `npm install -g`.
async function runProbe(handlers) {
  unattended = true;
  const safe = new Set(['1.1', '1.1.1', '1.2', '1.2.1', '1.3']);
  engine.steps = engine.steps.filter((s) => safe.has(s.id));
  handlers['1.3'] = async (ctx) => {
    ctx.setSubtitle('1.3', 'Checking for CodeMie…');
    const ex = await bridge.inspector.checkCodemie();
    ctx.setSubtitle('1.3', ex.found ? 'CodeMie already installed' : 'CodeMie not detected (probe: install skipped)');
    return ex.found;
  };
  try {
    await engine.run();
    const result = engine.steps.map((s) => `${s.id}:${s.status}`).join(' ');
    await invoke('smoke_emit', { line: `PROBE_RESULT ${result}` });
  } catch (e) {
    await invoke('smoke_emit', { line: `PROBE_ERR ${(e && e.message) || e}` });
  }
  await invoke('smoke_emit', { line: 'PROBE_DONE' });
  await invoke('close_app');
}

// Renderer-boot + benign-PTY self-test (CODEMIE_SMOKE).
async function runSmoke(flags) {
  const probe = {
    rows: document.querySelectorAll('.step-row').length,
    title: document.title,
    hasCanvas: !!document.getElementById('sprite-canvas'),
    bootError: window.__bootError || null,
  };
  await invoke('smoke_emit', { line: `SMOKE_PROBE ${JSON.stringify(probe)}` });

  try {
    let buf = '';
    const un = await listen('engine:pty-data', (e) => {
      try {
        buf += atob(e.payload.data);
      } catch {
        /* ignore */
      }
    });
    const code = await bridge.pty.spawnPty('echo PTY_SELFTEST_OK; exit 0', 80, 24);
    un();
    await invoke('smoke_emit', {
      line: `SMOKE_PTY ${JSON.stringify({ exit: code, sawMarker: buf.includes('PTY_SELFTEST_OK') })}`,
    });
  } catch (e) {
    await invoke('smoke_emit', { line: `SMOKE_PTY_ERR ${(e && e.message) || e}` });
  }

  setTimeout(async () => {
    await invoke('smoke_emit', { line: 'SMOKE_OK' });
    await invoke('close_app');
  }, flags.smoke_ms || 2500);
}

boot().catch((e) => {
  window.__bootError = String((e && e.stack) || e);
});
