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
import { findLoginError } from './signin-parse.js';
import { isBlockedState } from './auth-gate.js';
import { shouldCheckForAppUpdate } from './app-updater-utils.mjs';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Compare semver strings. Returns true when a < b. Works for X.Y.Z format.
function semverLt(a, b) {
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

// Populated during boot(); consumed by runAnalytics() and runUpdateCli().
const cliVersionState = { installed: '', latest: '', updateAvailable: false };
const appVersionState = { latest: null, updateAvailable: false };

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

// The six routed views, plus wizard-view for the legacy install engine — which
// showView must still toggle even though the sidebar never routes to it.
const views = {
  home: document.getElementById('home-view'),
  setup: document.getElementById('setup-view'),
  agents: document.getElementById('agents-view'),
  connect: document.getElementById('connect-view'),
  health: document.getElementById('health-view'),
  about: document.getElementById('about-view'),
  wizard: document.getElementById('wizard-view'),
};
const homeView = views.home;
const wizardView = views.wizard;
const connectView = views.connect;
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
      setInstallRunning(false);
      setSprite('error');
      document.getElementById('fatal-message').textContent = p.message || 'Installation failed.';
      document.getElementById('fatal-reco').textContent = p.recommendation || '';
      document.getElementById('fatal-overlay').classList.remove('hidden');
      wizardBack.classList.remove('hidden');
      break;
    case 'complete':
      setInstallRunning(false);
      setSprite(p.ok === false ? 'warning' : 'victory');
      installBtn.classList.add('hidden');
      closeBtn.classList.remove('hidden');
      wizardBack.classList.remove('hidden');
      refreshIdentityOnComplete();
      break;
    default:
      break;
  }
}

// True while engine.run() is in flight. The sidebar is a new way out of the
// wizard that origin/main did not have — wizard-back is hidden during a run and
// close-btn only appears once it ends — and leaving mid-install would let a
// second Engine be constructed over the step list the first is still mutating.
let installRunning = false;

function setInstallRunning(on) {
  installRunning = on;
  document.getElementById('app-sidebar').dataset.busy = on ? '1' : '';
  // The banner is shell chrome and stays on screen during a run. Its controls
  // are guarded, but a guard the user cannot see reads as a broken button.
  document.getElementById('update-banner').dataset.busy = on ? '1' : '';
  ['update-banner-run', 'update-banner-dismiss'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = on;
  });
}

// ---- view routing ----
function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
  // The wireframe draws the routed entry as a filled pill. aria-current carries
  // it, so the highlight and the accessible state cannot drift apart. Views with
  // no sidebar entry (setup, wizard) simply leave every entry unmarked.
  document.querySelectorAll('#app-sidebar .sidebar-item').forEach((btn) => {
    if (btn.dataset.view === name) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

// (Re)build the engine for a wizard run.
function enterWizard() {
  const steps = allSteps;
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
  modeLabel.textContent = 'Setup';
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

// ---- identity bar ----
// Every value comes from ~/.codemie/codemie-cli.config.json via the Rust reader;
// nothing here is hard-coded. An empty segment is hidden by CSS along with its
// separator, which is how an absent account and the unconfigured states render.
function renderIdentity(cfg) {
  const set = (id, text) => { document.getElementById(id).textContent = text || ''; };
  // No config yet: 01-home.png puts the product name where the identity goes.
  // Anything that is not a resolved config shows the product name rather than an
  // empty bar — that covers no-configuration and the read-failed fallback.
  set('identity-product', cfg.state === 'valid' || cfg.state === 'broken' ? '' : 'CodeMie Desktop');
  // null when the config records no userEmail — omit rather than fill in.
  set('identity-account', cfg.account);
  set('identity-profile', cfg.profile);
  // Empty in the broken state, where only the account and profile are readable.
  set('identity-model', cfg.model);
  set('identity-project', cfg.project);
}

// Re-reads the identity bar once setup finishes writing what it displays —
// `emit`'s 'complete' case calls this fire-and-forget so `emit` itself stays
// synchronous. Both of the bar's sources are re-read, the way boot reads them:
// a setup run can sign the user in as well as write the profile, so refreshing
// only the config would leave the auth segment contradicting the four beside it.
async function refreshIdentityOnComplete() {
  let cfg;
  try {
    cfg = await bridge.codemieConfig.read();
  } catch {
    cfg = {};
  }
  renderIdentity(cfg || {});
  let st;
  try {
    st = await bridge.inspector.checkProfileStatus();
  } catch {
    st = { state: 'unknown', detail: '' };
  }
  updateIdentityAuthStatus(st);
}

// Updates the identity bar's auth-status element from a ProfileStatus shape.
// Reused by the sign-in handler (Task 3) after login completes.
function updateIdentityAuthStatus(st) {
  const el = document.getElementById('identity-auth-status');
  if (!el) return;
  if (st.state === 'signed_in') {
    el.textContent = st.detail || 'Signed in';
  } else if (st.state === 'unknown') {
    el.textContent = 'Auth status unknown';
  } else if (st.state === 'no_profile') {
    el.textContent = 'No profile';
  } else {
    el.textContent = 'Not signed in';
  }
}

// ---- CLI version banner ----
// The badge reports whether an update exists; the banner reports whether the
// user still wants to be told. They are separate, which is why dismissing the
// banner leaves the badge standing, as 01-home.png draws it in steady state.
// The home grid was kept, so its update-available cue is carried-forward
// behaviour and has to keep working: an accent border on the installation group
// and a highlighted Update CLI tile. Guarded because EPMCDME-14589 removes the
// grid, after which these lookups return null.
function setGridUpdateCue(on) {
  const group = document.getElementById('installation-group');
  const tile = document.getElementById('update-cli-tile');
  if (group) group.classList.toggle('update-available', on);
  if (!tile) return;
  if (on) tile.dataset.state = 'highlight';
  else if (tile.dataset.state === 'highlight') delete tile.dataset.state;
}

function setVersionBadge() {
  document.getElementById('identity-version-badge').textContent =
    cliVersionState.updateAvailable ? `${cliVersionState.latest} available` : '';
}

function showUpdateBanner() {
  setVersionBadge();
  setGridUpdateCue(cliVersionState.updateAvailable);
  if (!cliVersionState.updateAvailable) return;
  if (sessionStorage.getItem('update-banner-dismissed') === '1') return;
  document.getElementById('update-from').textContent = cliVersionState.installed;
  document.getElementById('update-to').textContent = cliVersionState.latest;
  document.getElementById('update-banner').classList.remove('hidden');
}

// Nothing left to announce — used after a successful update, which is not a
// dismissal and so must not set the key that suppresses the banner all session.
function hideUpdateBanner() {
  document.getElementById('update-banner').classList.add('hidden');
  setVersionBadge();
  setGridUpdateCue(cliVersionState.updateAvailable);
}

function dismissUpdateBanner() {
  sessionStorage.setItem('update-banner-dismissed', '1');
  document.getElementById('update-banner').classList.add('hidden');
  setVersionBadge();
  // origin/main cleared the grid cue on dismiss. The badge is what survives —
  // it reports that an update exists; the cue and banner report that we are
  // still asking about it, and dismissing answers that.
  setGridUpdateCue(false);
}

function showAppUpdateBanner(latestVersion) {
  // Always show the banner on fresh check — sessionStorage is cleared per session,
  // so dismissed state should not persist across app restarts.
  // The backend throttles checks to 24h via codemie.app.lastUpdateCheck in localStorage.
  document.getElementById('app-update-to').textContent = latestVersion;
  document.getElementById('app-update-banner').classList.remove('hidden');
}

function hideAppUpdateBanner() {
  document.getElementById('app-update-banner').classList.add('hidden');
}

function dismissAppUpdateBanner() {
  sessionStorage.setItem('app-update-banner-dismissed', '1');
  hideAppUpdateBanner();
}

// ---- one-shot command action (proxy connect / analytics) ----
async function runAction(title, cmd, returnView = 'home', hint) {
  openTerminal(title, { keepOpen: true, hint, onClose: () => showView(returnView) });
  try {
    const { code } = await bridge.pty.spawnPty(cmd);
    writeLine(`\r\n${code === 0 ? '\x1b[32m✓' : '\x1b[31m✗'} Finished (exit ${code}).\x1b[0m Click “‹ Back” to return.\r\n`);
  } catch (e) {
    writeLine(`\r\n\x1b[31m✗ Error: ${(e && e.message) || e}\x1b[0m\r\n`);
    handlePtyExit();
  }
}

// Verify the active CodeMie profile is signed in via `codemie profile status`
// (parsed live in Rust — not a hardcoded check). Returns true if authenticated;
// otherwise shows a blocking notice that points at setup.
// Gates only on not_signed_in and no_profile; unknown is treated as authenticated
// so a profile whose provider omits an Auth Status row never blocks the user.
async function ensureAuthenticated() {
  let st;
  try {
    st = await bridge.inspector.checkProfileStatus();
  } catch {
    st = { state: 'not_signed_in', detail: '' };
  }
  if (isBlockedState(st.state)) {
    showNotice({
      title: 'CodeMie isn’t signed in',
      message:
        `Connecting Claude Desktop needs a signed-in CodeMie profile — "codemie profile status" must report Authenticated.${st.detail ? ` It reported: ${st.detail}.` : ''} Run setup / sign in first, then try again.`,
      primaryLabel: 'Run setup',
      primaryAction: () => enterWizard(),
    });
    return false;
  }
  return true;
}

// Launches `codemie profile login`, streams output, surfaces any error line via
// showNotice, then re-reads profile status. Does NOT trust the exit code — the
// CLI exits 0 on some failure paths; stdout is the source of truth.
// --url is not required: the CLI infers codeMieUrl from the active profile.
// Sign-in button UI surface is provided by EPMCDME-14589; startSignIn is defined
// here so it is available when that ticket wires it.
async function startSignIn() {
  hideNotice();
  try {
    const lines = [];
    // run_stream takes a command string, not an array — matches all existing callers
    await bridge.runner.runStream('codemie profile login', (line) => { lines.push(line); });
    // Exit code is ignored — profile login exits 0 on failure; scan stdout instead.
    const errorLine = findLoginError(lines);
    if (errorLine) {
      showNotice({
        title: 'Sign in failed',
        message: errorLine,
        primaryLabel: 'OK',
        primaryAction: hideNotice,
      });
    }
  } catch (err) {
    showNotice({
      title: 'Sign in failed',
      message: err?.message ?? 'An unexpected error occurred during sign-in.',
      primaryLabel: 'OK',
      primaryAction: hideNotice,
    });
  }
  // Always re-read profile status; never assume success from absence of an error line.
  // Falls back to the safe unknown state if the IPC call itself rejects.
  let st;
  try {
    st = await bridge.inspector.checkProfileStatus();
  } catch {
    st = { state: 'unknown', detail: '' };
  }
  updateIdentityAuthStatus(st);
}

async function runAnalytics() {
  // --report-output is set explicitly: a Finder-launched bundle's CWD is "/",
  // which is not writable. $HOME is expanded by the pty's login shell.
  const { installed } = cliVersionState;
  if (installed && semverLt(installed, '0.4.1')) {
    showNotice({
      title: 'CLI update required',
      message: `Your CodeMie CLI (v${installed}) doesn't support analytics reporting. Use Update CLI to upgrade, then try again.`,
      primaryLabel: 'Go to Update CLI',
      primaryAction: () => hideNotice(),
    });
    return;
  }
  await runAction(
    'Analytics report',
    'codemie analytics --report --open --report-output "$HOME/codemie-analytics.html"',
    'home',
    'Running automatically — no input needed.'
  );
}

// Reachable from two places — the update banner's button and the home grid's
// Update CLI tile — so progress has to render on both. Showing it only on the
// banner meant a click from the tile ran a real `npm install -g` with no visible
// feedback whenever the banner was hidden, and nothing stopped a second click.
let updateCliRunning = false;

function setUpdateProgress(state, label, icon) {
  const btn = document.getElementById('update-banner-run');
  if (btn) {
    btn.dataset.state = state;
    btn.textContent = label;
    btn.disabled = state === 'updating';
  }
  // The grid tile animates in place, as it does on the shipped app.
  const tile = document.getElementById('update-cli-tile');
  if (!tile) return;
  if (state) tile.dataset.state = state;
  else delete tile.dataset.state;
  const iconEl = document.getElementById('update-cli-icon');
  const titleEl = document.getElementById('update-cli-title');
  if (iconEl) iconEl.textContent = icon;
  if (titleEl) titleEl.textContent = label;
  // Its siblings are inert while the update runs, so a second install cannot be
  // started from the same group.
  document.querySelectorAll('#installation-tiles .sub-tile:not(#update-cli-tile)').forEach((t) => {
    t.style.pointerEvents = state === 'updating' ? 'none' : '';
    t.style.opacity = state === 'updating' ? '0.4' : '';
  });
}

async function runUpdateCli() {
  if (updateCliRunning) return;
  updateCliRunning = true;
  setUpdateProgress('updating', 'Updating…', '⏳');
  try {
    await invoke('run_self_update');

    // Re-probe installed version after update
    const newVersion = await invoke('check_codemie_version');
    cliVersionState.installed = newVersion;
    cliVersionState.updateAvailable =
      newVersion && cliVersionState.latest
        ? semverLt(newVersion, cliVersionState.latest)
        : false;

    setUpdateProgress('done', newVersion ? `Updated! → ${newVersion}` : 'Updated!', '✅');

    if (!cliVersionState.updateAvailable) {
      hideUpdateBanner();
    }

    setTimeout(() => {
      setUpdateProgress('', 'Update CLI', '🔄');
      updateCliRunning = false;
    }, 3000);
  } catch {
    setUpdateProgress('error', 'Failed — retry?', '❌');
    updateCliRunning = false;
  }
}

let updateAppRunning = false;

async function runUpdateApp() {
  if (updateAppRunning) return;
  updateAppRunning = true;

  const bannerRunBtn = document.getElementById('app-update-banner-run');
  bannerRunBtn.disabled = true;
  bannerRunBtn.textContent = 'Downloading…';

  const id = `app-update-${Date.now()}`;
  try {
    await bridge.updater.downloadAndInstall(id, ({ percent }) => {
      bannerRunBtn.textContent = `Downloading… ${percent}%`;
    });

    bannerRunBtn.textContent = 'Installer running…';
    bannerRunBtn.disabled = true;
    // The installer window is now visible and running
    // Wait for Tauri's runtime to clean up gracefully before exiting
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await bridge.updater.restartApp();
  } catch (err) {
    bannerRunBtn.disabled = false;
    bannerRunBtn.textContent = 'Update app';
    const banner = document.getElementById('app-update-banner');
    let errorEl = banner.querySelector('.update-error');
    if (!errorEl) {
      errorEl = document.createElement('span');
      errorEl.className = 'update-error';
      banner.appendChild(errorEl);
    }
    errorEl.textContent = String(err);
  } finally {
    updateAppRunning = false;
  }
}

async function boot() {
  const flags = await invoke('smoke_mode');

  // renderer.js is a module and exports nothing, and Setup has no sidebar entry,
  // so the router is otherwise unreachable from devtools. CODEMIE_DEV=1 exposes
  // it for verification only.
  //
  // startSetup is exposed the same way and for the same reason: EPMCDME-14513
  // owns the setup-view UI that will call it, and until that lands the driver
  // has no caller in the app, so EPMCDME-14668's Definition of done ("one
  // in-app smoke with a minimal onPrompt — a CODEMIE_DEV=1 console hook is
  // enough") cannot be executed at all. Lazy-imported so the driver stays out
  // of the production boot path.
  if (flags.dev) {
    const { startSetup } = await import('./setup-driver.js');
    window.__codemie = { showView, startSetup, emit };
  }

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

  // Wire update banner dismiss
  // The banner is shell-level now, so unlike origin/main — where it lived inside
  // the home grid and showView('wizard') hid it — it stays on screen during an
  // install. Both its controls need the same guard the sidebar has, or a
  // self-update can run concurrently with the engine's own CLI install step.
  document.getElementById('update-banner-run').addEventListener('click', () => {
    if (installRunning) return;
    runUpdateCli();
  });
  document.getElementById('update-banner-dismiss').addEventListener('click', () => {
    if (installRunning) return;
    dismissUpdateBanner();
  });
  document.getElementById('app-update-banner-run').addEventListener('click', () => {
    if (installRunning) return;
    runUpdateApp();
  });
  document.getElementById('app-update-banner-dismiss').addEventListener('click', () => {
    if (installRunning) return;
    dismissAppUpdateBanner();
  });

  // Check CLI version vs npm latest at startup (non-blocking)
  Promise.all([
    invoke('check_codemie_version'),
    invoke('fetch_codemie_latest'),
  ]).then(([installed, latest]) => {
    cliVersionState.installed = installed;
    cliVersionState.latest = latest;
    cliVersionState.updateAvailable =
      Boolean(installed) && Boolean(latest) && semverLt(installed, latest);
    showUpdateBanner();
  }).catch(() => {
    // Silently ignore — offline or CLI not installed
  });

  // App self-update check — once per 24 h
  // Use version-based localStorage key so each app version has its own check state
  const appVersion = await invoke('get_app_version');
  const lastUpdateCheckKey = `codemie.app.lastUpdateCheck.${appVersion}`;
  const lastAppCheck = localStorage.getItem(lastUpdateCheckKey);
  
  if (shouldCheckForAppUpdate(lastAppCheck)) {
    bridge.updater.checkForAppUpdate().then((latestVersion) => {
      if (latestVersion) {
        appVersionState.latest = latestVersion;
        appVersionState.updateAvailable = true;
        showAppUpdateBanner(latestVersion);
      }
      localStorage.setItem(lastUpdateCheckKey, new Date().toISOString());
    }).catch((err) => {
      console.error('[app-updater] check failed:', err);
      // Silent failure on boot — do not show an error banner.
    });
  }

  // Identity bar: live auth status.
  bridge.inspector.checkProfileStatus().then((st) => {
    updateIdentityAuthStatus(st);
  }).catch(() => {
    updateIdentityAuthStatus({ state: 'not_signed_in', detail: '' });
  });

  // Identity bar: profile / model / project / account, read from the config file.
  bridge.codemieConfig.read()
    .then((cfg) => renderIdentity(cfg || {}))
    .catch(() => renderIdentity({}));

  const [platformInfo, tmpDir] = await Promise.all([
    invoke('get_platform_info'),
    invoke('temp_dir'),
  ]);

  handlers = makeHandlers({
    inspector: bridge.inspector,
    runner: bridge.runner,
    installer: bridge.installer,
    pathman: bridge.pathman,
    downloader: bridge.downloader,
    pty: bridge.pty,
    externalWindow: bridge.externalWindow,
    arch: platformInfo.arch,
    platform: platformInfo,
    tmpDir,
  });

  engine = new Engine({
    steps: allSteps,
    handlers,
    emit,
    isUnattended: () => unattended,
  });

  // Rust-origin events: PTY output/exit stream from the portable-pty reader threads.
  await listen('engine:pty-data', (e) => writeData(e.payload.data));
  await listen('engine:pty-exit', (e) => handlePtyExit(e.payload.code));

  // ---- controls ----
  unattendedCb.addEventListener('change', () => {
    unattended = unattendedCb.checked;
  });
  installBtn.addEventListener('click', () => {
    installBtn.disabled = true;
    unattended = unattendedCb.checked;
    wizardBack.classList.add('hidden');
    setInstallRunning(true);
    setSprite('working');
    engine.run().catch((err) => {
      setInstallRunning(false); // otherwise the sidebar stays inert with no way back
      emit('terminal-line', { text: `Engine error: ${(err && err.message) || err}`, tag: 'stderr' });
    });
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
        enterWizard();
        break;
      case 'connect-desktop':
        showView('connect');
        break;
      case 'analytics':
        runAnalytics();
        break;
      case 'update-cli':
        runUpdateCli();
        break;
      default:
        break;
    }
  });
  document.querySelectorAll('#sidebar-main-group .sidebar-item, #sidebar-about').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (installRunning) return; // CSS blocks the pointer; this covers keyboard activation
      showView(btn.dataset.view);
    });
  });
  showView('home');
  document.getElementById('sidebar-analytics').addEventListener('click', () => {
    if (installRunning) return; // hidden today, but restoring it must not restore the gap
    runAnalytics();
  });

  wizardBack.addEventListener('click', () => showView('home'));
  connectBack.addEventListener('click', () => showView('home'));
  connectBtn.addEventListener('click', async () => {
    if (await ensureAuthenticated()) {
      runAction('Connect Claude Desktop', 'codemie proxy connect desktop', 'connect', 'Running automatically — no input needed.');
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

// Non-destructive detection-only run (CODEMIE_PROBE_SMOKE). Runs only the
// detection steps so the smoke never runs an actual install.
async function runProbe(handlers) {
  unattended = true;
  const safe = new Set(['2.3.3', '2.3.5', '2.4']);
  engine.steps = engine.steps.filter((s) => safe.has(s.id));
  if (engine.steps.length === 0) {
    await invoke('smoke_emit', { line: 'PROBE_ERR no steps matched the probe filter — safe set out of date' });
    await invoke('smoke_emit', { line: 'PROBE_DONE' });
    await invoke('close_app');
    return;
  }
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
    // The identity bar as actually rendered, so the config-state checks in the
    // Definition of Done can be made against the built binary instead of a
    // stubbed page. Empty segments are dropped, not marked: CSS hides them, so
    // omitting them here is what the bar really reads — and a placeholder
    // character in this line would look exactly like the em-dashes the
    // identity criterion forbids.
    identity: ['product', 'account', 'profile', 'model', 'project']
      .map((k) => document.getElementById(`identity-${k}`).textContent)
      .filter(Boolean)
      .join(' · '),
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
    const { code } = await bridge.pty.spawnPty('echo PTY_SELFTEST_OK; exit 0', 80, 24);
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
