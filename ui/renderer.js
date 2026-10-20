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
import { stopSetupOnLeave } from './setup-leave.js';
import * as bridge from './runner-bridge.js';
import { findLoginError } from './signin-parse.js';
import { isBlockedState } from './auth-gate.js';
import { shouldCheckForAppUpdate } from './app-updater-utils.mjs';
import { createHealthController } from './health-controller.js';
import { createAgentsController } from './agents-controller.js';
import { applyOnboardingNav } from './shell-nav.js';
import { readOnboarded, rememberOnboarded } from './onboarding-memory.js';
import { createHomeView, applyHomeHeader } from './home-view.js';
import { deriveHome, signInAction, autoHealthCheck, signedInDetail, connectionFromStatus } from './home-state.js';
import { parseAgentList } from './agents-parse.js';
import { createCommandLog } from './command-log.js';
import { analyticsCommand } from './analytics-command.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;


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
const wizardBack = document.getElementById('wizard-back');
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
      refreshAgents();
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

// True once the Health screen's own doctor run has fired for this app
// session — the auto-run-on-first-visit happens exactly once; "Check
// everything again" is the only way to re-run after that.
let healthChecked = false;
let agentsChecked = false;

function setInstallRunning(on) {
  installRunning = on;
  document.getElementById('app-sidebar').dataset.busy = on ? '1' : '';
}

// ---- Home (EPMCDME-14589) ----
// One screen, two states: the checklist until nothing is left to tick, then the
// status cards. Everything it shows comes from four sources that already exist:
// the config reader and auth status (the identity bar's own reads feed them in),
// `codemie list` through ui/agents-parse.js, and Health's last result.
const home = { config: null, auth: null, agents: undefined, health: null, connection: undefined };
const homeScreen = createHomeView(document.getElementById('home-body'), {
  stepsUi: stepsUI.createStepsUi(),
  onItem: (id) => {
    if (id === 'model') openGuidedSetup();
    else if (id === 'agent') showView('agents');
    else if (id === 'health') showView('health');
  },
  onSignIn: () => (signInAction(home) === 'setup' ? openGuidedSetup() : startSignIn()),
  onCard: (id) => showView(id === 'connections' ? 'connect' : id),
  onSetupAgain: () => openGuidedSetup(),
  // Item 3 installs through the Agents controller, which refreshes Home on its
  // own when the action finishes, so the item ticks without a second read here.
  onInstallAgent: (agent, onLine) => agentsController.install(agent, onLine),
});

// Whether the checklist has ever been finished here, read once at boot.
// localStorage itself can throw on access, so it is fetched guarded too.
const homeStorage = (() => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
})();
let onboarded = readOnboarded(homeStorage);

let autoHealthStarted = false;

function renderHome() {
  const state = deriveHome({ ...home, onboarded });
  if (state.done && !onboarded) {
    onboarded = true;
    rememberOnboarded(homeStorage);
  }
  homeScreen.render({ ...state, signingIn: home.signingIn });
  // The last step starts by itself once the ones before it are done, instead
  // of leaving the user on a checklist that waits for a click. Once a session:
  // a check that fails leaves its step saying so, and Home does not retry it.
  if (!autoHealthStarted && autoHealthCheck(state)) {
    autoHealthStarted = true;
    setTimeout(startHealthInPlace, 0);
  }
  // The other screens stay locked until sign-in and model are set (or setup
  // has finished once); Home never is, so an item that opened Agents or
  // Health always has a way back.
  applyOnboardingNav(document, { done: state.unlocked });
  applyHomeHeader(document, { done: state.done });
}

// `codemie list` is Home's one bounded CLI read (its ticket allows exactly this
// one). Spaced out: showView('home') and window focus both ask for it.
let agentsReadAt = 0;
let agentsReading = false;
async function refreshAgents() {
  if (agentsReading || Date.now() - agentsReadAt < 5000) return;
  agentsReading = true;
  try {
    const res = await bridge.runner.runCapture('codemie list');
    home.agents = res && res.code === 0 ? parseAgentList(res.stdout) : null;
  } catch {
    home.agents = null;
  } finally {
    agentsReading = false;
    agentsReadAt = Date.now();
  }
  renderHome();
}

// The Connections card's one read: whether the CLI's local proxy, which Claude
// Desktop is pointed at, is running.
let connectionReading = false;
async function refreshConnection() {
  if (connectionReading) return;
  connectionReading = true;
  try {
    const res = await bridge.runner.runCapture('codemie proxy status --json');
    home.connection = connectionFromStatus((res && res.code === 0 && res.stdout) || '');
  } catch {
    home.connection = null;
  } finally {
    connectionReading = false;
  }
  renderHome();
}

// One view instance for the one #setup-view container, created lazily and
// reused. A second instance would mount over the first one's rows and start a
// second `codemie setup` alongside it (they race over the config file);
// setup-view's own re-entrancy guard is per instance and cannot see that.
// start() is safe to call again on a settled instance: it resets itself. The
// module is imported on first use so the driver stays out of the boot path.
let setupView = null;
// True while a guided setup run is open; runAction reads it. setupSettled
// resolves once that run has fully unwound.
let setupRunning = false;
let setupSettled = Promise.resolve();
// Set while a run left behind by showView is being stopped; the next
// openGuidedSetup waits for it, or start() would hand back the old run.
let setupStopping = null;
async function openGuidedSetup() {
  showView('setup');
  if (setupStopping) await setupStopping;
  if (!setupView) {
    const { createSetupView } = await import('./setup-view.js');
    // A verified run returns to Home by itself, unless the user has already
    // gone somewhere else in the meantime.
    setupView = createSetupView(document.getElementById('setup-view'), {
      onDone: () => {
        if (!views.setup.classList.contains('hidden')) showView('home');
      },
      // Called for each run, including a "Try again" started from the view.
      onRun: (run) => {
        setupRunning = true;
        setupSettled = run.then(() => {}, () => {}).finally(() => {
          setupRunning = false;
          // A run writes the profile and may sign the user in; Home re-reads both.
          refreshIdentityOnComplete();
          refreshAgents();
        });
      },
    });
  }
  return setupView.start();
}

// ---- view routing ----
function showView(name) {
  const stopping = stopSetupOnLeave(
    views.setup.classList.contains('hidden') ? null : 'setup',
    name,
    {
      running: setupRunning,
      cancel: async () => (await import('./setup-driver.js')).cancelSetup(),
      settled: () => setupSettled,
    },
  );
  if (stopping) {
    const wait = stopping.finally(() => {
      if (setupStopping === wait) setupStopping = null;
    });
    setupStopping = wait;
  }
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
  // The first visit runs the checks, however the view was reached: the sidebar,
  // a deep link from another screen, or the dev hook. After that only "Check
  // everything again" re-runs them.
  if (name === 'health' && !healthChecked) {
    healthChecked = true;
    healthController.run();
  }
  if (name === 'agents' && !agentsChecked) {
    agentsChecked = true;
    agentsController.run();
  }
  if (name === 'home') {
    refreshAgents();
    refreshConnection();
  }
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
  set('identity-product', cfg.state === 'valid' || cfg.state === 'broken' ? '' : 'CodeMie Connect');
  // null when the config records no userEmail — omit rather than fill in.
  set('identity-account', cfg.account);
  set('identity-profile', cfg.profile);
  // Empty in the broken state, where only the account and profile are readable.
  set('identity-model', cfg.model);
  set('identity-project', cfg.project);
  home.config = cfg;
  renderHome();
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
    el.textContent = signedInDetail(st.detail);
  } else if (st.state === 'unknown') {
    el.textContent = 'Auth status unknown';
  } else if (st.state === 'no_profile') {
    el.textContent = 'No profile';
  } else {
    el.textContent = 'Not signed in';
  }
  home.auth = st;
  renderHome();
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
// The app has one terminal (PTY) slot, and guided setup holds it for as long
// as a run is open -- including while it waits on a question the user walked
// away from. Anything else that needs the slot (the analytics report, the
// Claude Desktop connection) asks to stop that run first, instead of failing
// with the bridge's bare "PTY already active".
async function runAction(title, cmd, returnView = 'home', hint) {
  if (setupRunning) {
    showNotice({
      title: 'Setup is still running',
      message: 'Guided setup is waiting for an answer, and only one can run at a time. Stop setup to go on; you can start it again from Home.',
      primaryLabel: 'Stop setup and continue',
      primaryAction: async () => {
        const { cancelSetup } = await import('./setup-driver.js');
        await cancelSetup();
        await setupSettled;
        runAction(title, cmd, returnView, hint);
      },
    });
    return;
  }
  openTerminal(title, { keepOpen: true, hint, onClose: () => showView(returnView) });
  try {
    const { code } = await bridge.pty.spawnPty(cmd);
    writeLine(`\r\n${code === 0 ? '\x1b[32m✓' : '\x1b[31m✗'} Finished (exit ${code}).\x1b[0m Click “‹ Back” to return.\r\n`);
  } catch (e) {
    writeLine(`\r\n\x1b[31m✗ Error: ${(e && e.message) || e}\x1b[0m\r\n`);
    handlePtyExit();
  }
}

// Health screen's own doctor invocation — independent of wizard step 2.4,
// which stays exit-code-only. The stdout-filter/parse/group pipeline and the
// open-log failure path live in health-controller.js, which is unit-tested
// directly (ui/test/health-controller.test.mjs); onFailure resets
// healthChecked so a failed run does not permanently consume the one-shot
// auto-run guard below (CR-006).
const healthController = createHealthController({
  container: views.health,
  // Mirror every line (stdout and stderr) to the on-disk log, same as the
  // main terminal's emit() sink does — health-controller.js's own onLine
  // only keeps stdout in memory for parsing, so without this the doctor
  // run's real output (including a stderr-only failure) was invisible in
  // codemie_wizard.log.
  runStream: (cmd, onLine) =>
    bridge.runner.runStream(cmd, (text, tag) => {
      invoke('log_line', { text, tag: tag || 'stdout' }).catch(() => {});
      onLine(text, tag);
    }),
  openLog: () => invoke('open_cli_debug_log'),
  // 'setup' is not a screen to show but a run to start: guided setup.
  onNavigate: (view) => (view === 'setup' ? openGuidedSetup() : showView(view)),
  signIn: () => startSignIn(),
  onResult: (result) => {
    home.health = result;
    home.healthRunning = false;
    home.healthFailed = false;
    renderHome();
  },
  onFailure: () => {
    healthChecked = false;
    home.healthRunning = false;
    home.healthFailed = true;
    renderHome();
  },
});

// Runs the health check from Home, without leaving it: the step shows it
// running, and its result ticks the step (or names the problems) the same way
// a check run from the Health screen does.
function startHealthInPlace() {
  if (healthChecked) return;
  healthChecked = true;
  home.healthRunning = true;
  renderHome();
  healthController.run();
}

// The Agents screen (EPMCDME-14514). Its own steps-ui instance, its own
// `codemie list` read; onResult hands the same records to Home so the checklist
// item and the Agents card do not need a second read to agree with the screen.
// onFailure releases the one-shot guard the way Health's does.
let platformInfoValue = null;
const agentsController = createAgentsController({
  getPlatform: () => platformInfoValue,
  container: views.agents,
  runCapture: (cmd) => bridge.runner.runCapture(cmd),
  runStream: bridge.runner.runStream,
  stepsUi: stepsUI.createStepsUi(),
  onResult: (agents) => {
    home.agents = agents;
    renderHome();
  },
  onFailure: () => {
    agentsChecked = false;
  },
});

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
      primaryAction: () => openGuidedSetup(),
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
  // One browser sign-in at a time: each call starts its own `profile login`.
  if (home.signingIn) return;
  home.signingIn = true;
  renderHome();
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
  home.signingIn = false;
  updateIdentityAuthStatus(st);
}

async function runAnalytics() {
  const help = await bridge.runner.runCapture('codemie analytics --help').catch(() => null);
  await runAction(
    'Analytics report',
    analyticsCommand(help?.stdout),
    'home',
    'Running automatically — no input needed.'
  );
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
    bannerRunBtn.textContent = 'Update and restart';
    const banner = document.getElementById('app-update-banner');
    const banBody = banner.querySelector('.top-banner-body');
    let errorEl = banner.querySelector('.update-error');
    if (!errorEl) {
      errorEl = document.createElement('span');
      errorEl.className = 'update-error';
      banBody.appendChild(errorEl);
    }
    errorEl.textContent = String(err);
  } finally {
    updateAppRunning = false;
  }
}

// Node and the CLI are not in the app: they are installed once, on first
// launch (commands/runtime.rs). Nothing else in boot() may run the CLI before
// this resolves.
async function ensureRuntime() {
  if (await invoke('runtime_ready')) return;
  const overlay = document.getElementById('runtime-overlay');
  const title = document.getElementById('runtime-title');
  const detail = document.getElementById('runtime-detail');
  const bar = document.getElementById('runtime-bar');
  const retry = document.getElementById('runtime-retry');
  const errorEl = document.getElementById('runtime-error');
  const downloading = 'Setting up CodeMie. This happens once.';
  overlay.classList.remove('hidden');
  // npm reports no progress, so during the CLI step the bar eases on toward 95%
  // instead of sitting still; it fills to 100% when the install finishes.
  let creep = null;
  let installing = false;
  const stopCreep = () => { clearInterval(creep); creep = null; };
  const unlisten = await listen('runtime:progress', (e) => {
    const { phase, fraction, total } = e.payload;
    bar.style.width = `${Math.round(fraction * 100)}%`;
    if (phase === 'cli') {
      detail.textContent = 'Installing the CodeMie CLI. This takes about a minute and happens once.';
      let width = fraction * 100;
      if (installing && !creep) creep = setInterval(() => { width += (95 - width) * 0.05; bar.style.width = `${Math.round(width)}%`; }, 1000);
    } else if (phase === 'node' && total) detail.textContent = `Downloading Node.js (${Math.round((fraction / 0.3) * (total / 1048576))} of ${Math.round(total / 1048576)} MB). This happens once.`;
  });
  for (;;) {
    title.textContent = 'Preparing CodeMie…';
    detail.textContent = downloading;
    retry.classList.add('hidden');
    errorEl.classList.add('hidden');
    bar.style.width = '0%';
    installing = true;
    try {
      await invoke('ensure_runtime');
      installing = false;
      stopCreep();
      bar.style.width = '100%';
      await new Promise((r) => setTimeout(r, 400));
      break;
    } catch (err) {
      installing = false;
      stopCreep();
      title.textContent = "Couldn't download CodeMie";
      detail.textContent = 'Check your internet connection or proxy, then try again.';
      errorEl.textContent = String(err);
      errorEl.classList.remove('hidden');
      retry.classList.remove('hidden');
      await new Promise((r) => retry.addEventListener('click', r, { once: true }));
    }
  }
  unlisten();
  overlay.classList.add('hidden');
}

async function boot() {
  await ensureRuntime();
  // The command-log footer hears about every command the bridge runs, so it is
  // wired first: the startup checks below (codemie --version, profile status)
  // would otherwise run before it and never show.
  bridge.setCommandListener(createCommandLog(document.getElementById('command-log-body')).start);
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
    window.__codemie = { showView, startSetup, emit, startGuidedSetup: openGuidedSetup };
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

  document.getElementById('app-update-banner-run').addEventListener('click', () => {
    if (installRunning) return;
    runUpdateApp();
  });
  document.getElementById('app-update-banner-dismiss').addEventListener('click', () => {
    if (installRunning) return;
    dismissAppUpdateBanner();
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

  // Re-read the identity bar when the window comes back to the front, so a
  // profile switched in a terminal shows without restarting the app. Skipped
  // during a setup run, which refreshes the bar itself when it completes, and
  // spaced out because the auth half runs the CLI.
  let identityReadAt = Date.now();
  window.addEventListener('focus', () => {
    if (installRunning || setupRunning || Date.now() - identityReadAt < 5000) return;
    identityReadAt = Date.now();
    refreshIdentityOnComplete();
    refreshAgents();
    refreshConnection();
  });

  const [platformInfo, tmpDir] = await Promise.all([
    invoke('get_platform_info'),
    invoke('temp_dir'),
  ]);
  platformInfoValue = platformInfo;

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

  // ---- home ----
  // The Home body is ui/home-view.js; its sources are wired in the Home section
  // above. The command-log footer is wired at the top of boot().
  refreshAgents();
  refreshConnection();
  // A newer CLI on npm is installed in the background and used from the next
  // command on, so a CLI release never needs a new installer (runtime.rs).
  invoke('update_cli')
    .then((version) => {
      if (version) refreshAgents();
    })
    .catch(() => {});
  document.querySelectorAll('#sidebar-main-group .sidebar-item, #sidebar-about').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (installRunning) return; // CSS blocks the pointer; this covers keyboard activation
      showView(btn.dataset.view);
    });
  });
  showView('home');
  document.getElementById('sidebar-analytics').addEventListener('click', () => {
    if (installRunning) return; // CSS blocks the pointer; this covers keyboard activation
    runAnalytics();
  });

  wizardBack.addEventListener('click', () => showView('home'));
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
  // CODEMIE_SHOT names the view to open at boot. The Rust side has exposed the
  // flag since the smoke work but nothing read it, so a screen other than Home
  // could only be reached by clicking — which a background capture cannot do.
  // Screenshot evidence for a screen's own ticket now needs no temporary hook.
  if (flags.shot && views[flags.shot]) {
    showView(flags.shot);
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
