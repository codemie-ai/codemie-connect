// Entry point: wires the preload IPC API to the UI modules.
import { initSprite } from './sprite.js';
import * as steps from './steps-ui.js';
import { initLog, appendLine } from './log.js';
import { initTerminal, openTerminal, writeData, closeTerminal } from './terminal.js';

// Capture boot/runtime errors so the main-process self-test can read them.
window.addEventListener('error', (e) => {
  window.__bootError = String((e.error && e.error.stack) || e.message || e);
});
window.addEventListener('unhandledrejection', (e) => {
  window.__bootError = String((e.reason && e.reason.stack) || e.reason || e);
});

const api = window.codemie;

const PILL = {
  idle: { label: 'Idle', color: '#484f58' },
  working: { label: 'Working…', color: '#58a6ff' },
  warning: { label: 'Attention', color: '#d29922' },
  success: { label: 'Success!', color: '#3fb950' },
  error: { label: 'Error', color: '#ff6b6b' },
  victory: { label: 'Complete!', color: '#3fb950' },
};

let sprite = null;
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

async function boot() {
  const list = await api.getSteps();
  steps.renderSteps(document.getElementById('step-list'), list);

  const logoPath = await api.getLogoPath();
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

  // ---- engine events -> UI ----
  api.onStatusChange(({ id, status }) => steps.setStatus(id, status));
  api.onSubtitle(({ id, text }) => steps.setSubtitle(id, text));
  api.onSpinnerStart(({ id }) => steps.startSpinner(id));
  api.onSubstepActivate(({ parent_id, step }) => steps.insertSubStep(parent_id, step));
  api.onDownloadProgress(({ id, fraction }) => steps.setProgress(id, fraction));
  api.onTerminalLine(({ text, tag }) => appendLine(text, tag));
  api.onApprovalNeeded(({ id, message }) =>
    steps.showApproval(id, message, () => api.approve(), () => api.ignore())
  );
  api.onPtyOpen(({ title }) => openTerminal(title));
  api.onPtyData(({ data }) => writeData(data));
  api.onPtyExit(() => closeTerminal());
  api.onFatal(({ message, recommendation }) => {
    setSprite('error');
    document.getElementById('fatal-message').textContent = message || 'Installation failed.';
    document.getElementById('fatal-reco').textContent = recommendation || '';
    document.getElementById('fatal-overlay').classList.remove('hidden');
  });
  api.onComplete(({ ok } = {}) => {
    setSprite(ok === false ? 'warning' : 'victory');
    installBtn.classList.add('hidden');
    closeBtn.classList.remove('hidden');
  });

  // ---- controls ----
  unattendedCb.addEventListener('change', () => api.setUnattended(unattendedCb.checked));
  installBtn.addEventListener('click', () => {
    installBtn.disabled = true;
    api.setUnattended(unattendedCb.checked);
    setSprite('working');
    api.start();
  });
  closeBtn.addEventListener('click', () => api.close());
  document.getElementById('fatal-close').addEventListener('click', () => api.close());
}

boot().catch((e) => {
  window.__bootError = String((e && e.stack) || e);
});
