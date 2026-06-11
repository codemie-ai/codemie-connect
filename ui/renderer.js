// Entry point (Option B): builds the install Engine in the renderer and drives it
// against granular Rust commands. A home/launcher view routes to the wizard or to
// one-shot command actions. Engine UI events are dispatched locally; only
// Rust-origin events (pty-data/exit) arrive via Tauri listen().
import { Engine } from './engine.js';
import { StepStatus } from './models.js';
import { makeHandlers } from './handlers.js';
import { initSprite } from './sprite.js';
import * as stepsUI from './steps-ui.js';
import { initLog, appendLine } from './log.js';
import { initTerminal, openTerminal, writeData, writeLine, handlePtyExit, closeTerminal } from './terminal.js';
import * as bridge from './runner-bridge.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Steps run by "Install only" (no setup): Git, Node, CodeMie CLI — but not the
// codemie setup wizard / Claude engine / doctor (2.x). Sub-steps are retained so
// their parent handlers can activate them.
const INSTALL_ONLY_IDS = ['1.1', '1.1.1', '1.2', '1.2.1', '1.3'];

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
let handlers = null;
let allSteps = [];

const dotEl = document.getElementById('status-dot');
const statusTextEl = document.getElementById('status-text');
const installBtn = document.getElementById('install-btn');
const closeBtn = document.getElementById('close-btn');
const unattendedCb = document.getElementById('unattended-cb');

const homeView = document.getElementById('home-view');
const wizardView = document.getElementById('wizard-view');
const connectView = document.getElementById('connect-view');
const homeGrid = document.getElementById('home-grid');
const wizardBack = document.getElementById('wizard-back');
const connectBack = document.getElementById('connect-back');
const connectBtn = document.getElementById('connect-btn');
const restartBtn = document.getElementById('restart-btn');
const modeLabel = document.getElementById('wizard-mode-label');
const stepListEl = document.getElementById('step-list');

const noticeOverlay = document.getElementById('notice-overlay');
const noticeTitle = document.getElementById('notice-title');
const noticeMessage = document.getElementById('notice-message');
const noticePrimary = document.getElementById('notice-primary');
const noticeClose = document.getElementById('notice-close');

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
      wizardBack.classList.remove('hidden');
      break;
    case 'complete':
      setSprite(p.ok === false ? 'warning' : 'victory');
      installBtn.classList.add('hidden');
      closeBtn.classList.remove('hidden');
      wizardBack.classList.remove('hidden');
      break;
    default:
      break;
  }
}

// ---- view routing ----
function showView(name) {
  homeView.classList.toggle('hidden', name !== 'home');
  wizardView.classList.toggle('hidden', name !== 'wizard');
  connectView.classList.toggle('hidden', name !== 'connect');
}

// (Re)build the engine for a wizard run, optionally filtered to a subset of steps.
function enterWizard(stepIds) {
  const steps = stepIds ? allSteps.filter((s) => stepIds.includes(s.id)) : allSteps;
  steps.forEach((s) => {
    s.status = StepStatus.PENDING;
  });
  stepsUI.renderSteps(stepListEl, steps);
  engine = new Engine({ steps, handlers, emit, isUnattended: () => unattended });

  installBtn.classList.remove('hidden');
  installBtn.disabled = false;
  closeBtn.classList.add('hidden');
  wizardBack.classList.remove('hidden');
  setSprite('idle');
  modeLabel.textContent = stepIds ? 'Install only' : 'Full installation + setup';
  showView('wizard');
}

// ---- notice modal ----
function showNotice({ title, message, primaryLabel, primaryAction }) {
  noticeTitle.textContent = title;
  noticeMessage.textContent = message;
  if (primaryLabel) {
    noticePrimary.textContent = primaryLabel;
    noticePrimary.classList.remove('hidden');
    noticePrimary.onclick = () => {
      hideNotice();
      if (primaryAction) primaryAction();
    };
  } else {
    noticePrimary.classList.add('hidden');
  }
  noticeOverlay.classList.remove('hidden');
}
function hideNotice() {
  noticeOverlay.classList.add('hidden');
}

// ---- one-shot command action (proxy connect / analytics) ----
async function runAction(title, cmd, returnView = 'home') {
  openTerminal(title, { keepOpen: true, onClose: () => showView(returnView) });
  try {
    const code = await bridge.pty.spawnPty(cmd);
    writeLine(`\r\n${code === 0 ? '\x1b[32m✓' : '\x1b[31m✗'} Finished (exit ${code}).\x1b[0m Click “‹ Back” to return.\r\n`);
  } catch (e) {
    writeLine(`\r\n\x1b[31m✗ Error: ${(e && e.message) || e}\x1b[0m\r\n`);
    handlePtyExit();
  }
}

// Verify the active CodeMie profile is signed in via `codemie profile status`
// (parsed live in Rust — not a hardcoded check). Returns true if authenticated;
// otherwise shows a blocking notice that points at the full installation.
async function ensureAuthenticated() {
  let st;
  try {
    st = await invoke('check_profile_status');
  } catch {
    st = { authenticated: false, detail: '' };
  }
  if (!st.authenticated) {
    showNotice({
      title: 'CodeMie isn’t signed in',
      message:
        `Connecting Claude Desktop needs a signed-in CodeMie profile — "codemie profile status" must report Authenticated.${st.detail ? ` It reported: ${st.detail}.` : ''} Run the full installation / sign in first, then try again.`,
      primaryLabel: 'Run full installation',
      primaryAction: () => enterWizard(null),
    });
    return false;
  }
  return true;
}

async function runAnalytics() {
  // --report-output is set explicitly: a Finder-launched bundle's CWD is "/",
  // which is not writable. $HOME is expanded by the pty's login shell.
  await runAction(
    'Analytics report',
    'codemie analytics --report --open --report-output "$HOME/codemie-analytics.html"'
  );
}

async function boot() {
  const flags = await invoke('smoke_mode');

  allSteps = await invoke('get_steps');
  stepsUI.renderSteps(stepListEl, allSteps);

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
    hint: document.getElementById('terminal-hint'),
    done: document.getElementById('terminal-done'),
  });

  handlers = makeHandlers({
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
    steps: allSteps,
    handlers,
    emit,
    isUnattended: () => unattended,
  });

  // Rust-origin events: PTY output/exit stream from the portable-pty reader threads.
  await listen('engine:pty-data', (e) => writeData(e.payload.data));
  await listen('engine:pty-exit', () => handlePtyExit());

  // ---- controls ----
  unattendedCb.addEventListener('change', () => {
    unattended = unattendedCb.checked;
  });
  installBtn.addEventListener('click', () => {
    installBtn.disabled = true;
    unattended = unattendedCb.checked;
    wizardBack.classList.add('hidden');
    setSprite('working');
    engine.run().catch((err) => emit('terminal-line', { text: `Engine error: ${(err && err.message) || err}`, tag: 'stderr' }));
  });
  // After a run finishes, "Back to Home" returns to the launcher rather than quitting the
  // app (macOS Cmd+Q / the window's close control handle quitting). Re-entering a wizard
  // via enterWizard() resets the view state.
  closeBtn.addEventListener('click', () => showView('home'));
  document.getElementById('fatal-close').addEventListener('click', () => {
    document.getElementById('fatal-overlay').classList.add('hidden');
    showView('home');
  });

  // ---- home / launcher ----
  homeGrid.addEventListener('click', (e) => {
    const tile = e.target.closest('.home-tile');
    if (!tile) return;
    switch (tile.dataset.action) {
      case 'full':
        enterWizard(null);
        break;
      case 'install-only':
        enterWizard(INSTALL_ONLY_IDS);
        break;
      case 'connect-desktop':
        showView('connect');
        break;
      case 'analytics':
        runAnalytics();
        break;
      default:
        break;
    }
  });
  wizardBack.addEventListener('click', () => showView('home'));
  connectBack.addEventListener('click', () => showView('home'));
  connectBtn.addEventListener('click', async () => {
    if (await ensureAuthenticated()) {
      runAction('Connect Claude Desktop', 'codemie proxy connect desktop', 'connect');
    }
  });
  restartBtn.addEventListener('click', async () => {
    if (await ensureAuthenticated()) {
      // Stop the running proxy first, then connect again. `;` (not `&&`) so a
      // no-op stop (nothing running) still proceeds to connect.
      runAction('Restart Claude Desktop proxy', 'codemie proxy stop; codemie proxy connect desktop', 'connect');
    }
  });
  noticeClose.addEventListener('click', hideNotice);

  // ---- view routing (smoke/probe go straight to the wizard so their
  //      .step-row / canvas / bg assertions still hold) ----
  if (flags.probe) {
    showView('wizard');
    await runProbe(handlers);
    return;
  }
  if (flags.smoke) {
    showView('wizard');
    await runSmoke(flags);
    return;
  }
  showView('home');
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
  const cs = getComputedStyle(document.body);
  const probe = {
    rows: document.querySelectorAll('.step-row').length,
    title: document.title,
    hasCanvas: !!document.getElementById('sprite-canvas'),
    bg: cs.backgroundColor, // proves styles.css + tokens loaded (dark page = rgb(26, 26, 26))
    theme: document.documentElement.className, // proves theme bootstrap ran ('dark' by default)
    bootError: window.__bootError || null,
  };
  await invoke('smoke_emit', { line: `SMOKE_PROBE ${JSON.stringify(probe)}` });

  // Exercise run_stream end-to-end: validates the streamId->stream_id arg mapping
  // (shared by every multi-word command arg), engine:cmd-line correlation, exit code.
  try {
    const lines = [];
    const r = await bridge.runner.runStream('printf "L1\\nL2\\n"; exit 0', (t) => lines.push(t));
    await invoke('smoke_emit', {
      line: `SMOKE_STREAM ${JSON.stringify({ code: r.code, lineCount: lines.length })}`,
    });
  } catch (e) {
    await invoke('smoke_emit', { line: `SMOKE_STREAM_ERR ${(e && e.message) || e}` });
  }

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
