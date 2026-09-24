// Presentational render module for the Agents screen (#agents-view). Pure DOM
// from the records ui/agents-parse.js produces — no invoke()/runCapture() here,
// that wiring is agents-controller.js's.
//
// The rows are the app's step list on this screen's own steps-ui instance
// (EPMCDME-14654's factory): the module-level default belongs to the legacy
// install engine, and guided setup, Home and Health each hold their own. Views
// are toggled with `hidden` and never unmounted, so every list stays mounted at
// once; sharing an instance would clear another screen's rows.
//
// 03-agents.png draws a list and a detail pane. The detail pane is
// EPMCDME-14655; here progress, failures and the CLI's own output belong in the
// row itself, and never in a modal.
import { StepStatus, makeStep } from './models.js';
import { screenSpinner } from './screen-loading.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// An agent's row state. An in-flight/failed action (agent.actionStatus, set
// by the controller) takes priority; otherwise plain installed/not-installed.
// An available update is not a problem, so it keeps the tick and is said in
// the subtitle instead.
const statusOf = (agent) => {
  if (agent.actionStatus === 'error') return StepStatus.ERROR;
  if (agent.actionStatus === 'running') return StepStatus.ACTIVE;
  return agent.installed ? StepStatus.COMPLETE : StepStatus.PENDING;
};

// The version comes from `codemie list`, which prints the agent's own
// `<command> --version`. `codemie update --check` reports a different number
// for the built-in agent on purpose (it substitutes the CLI package's version),
// so the two are never shown side by side. See
// .ai-run/decisions/2026-09-21-EPMCDME-14514-agent-version-authority.md.
const subtitleOf = (agent) => {
  if (agent.actionMessage) return agent.actionMessage;
  const base = agent.installed && agent.version ? `${agent.description} · ${agent.version}` : agent.description;
  if (agent.updateAvailable) return `${base} · ${agent.latest ? `${agent.latest} available` : 'update available'}`;
  return base;
};

export function summarise(agents) {
  return {
    installed: agents.filter((a) => a.installed).length,
    total: agents.length,
    updateAvailable: agents.filter((a) => a.updateAvailable).length,
  };
}

export function renderAgents(container, { agents }, handlers = {}) {
  const { stepsUi, onInstall, onUpdate, onRemove } = handlers;
  container.innerHTML = '';

  const { installed, total, updateAvailable } = summarise(agents);
  const summaryText = `${installed} of ${total} installed${updateAvailable ? ` · ${updateAvailable} update${updateAvailable === 1 ? '' : 's'} available` : ''}`;
  const head = el('div', 'agents-head');
  head.append(el('span', 'agents-title', 'Agents'), el('span', 'agents-summary', summaryText));
  container.appendChild(head);

  container.appendChild(el('div', 'agents-note', 'Run an agent from a terminal. This screen only sets them up.'));

  const list = el('div', 'agents-list');
  container.appendChild(list);

  stepsUi.renderSteps(list, agents.map((a) => makeStep({ id: a.command, title: a.name })));
  for (const agent of agents) {
    stepsUi.setStatus(agent.command, statusOf(agent));
    stepsUi.setSubtitle(agent.command, subtitleOf(agent));
    const row = list.querySelector(`.step-row[data-id="${agent.command}"]`);
    if (row) row.appendChild(buildActions(agent, { onInstall, onUpdate, onRemove }));
    if (row && agent.updateAvailable) {
      row.title = agent.latest ? `A newer version is out. Update installs ${agent.latest}.` : 'A newer version is out. Update installs it.';
    }
  }
}

const BUSY_LABEL = { Install: 'Installing…', Update: 'Updating…', Remove: 'Removing…' };

// One action slot per row. A button is drawn only when its handler exists, so
// this screen never shows a control that does nothing. A click disables the
// row's buttons and says what is running; the refresh after the action draws
// the row again with fresh buttons.
function buildActions(agent, { onInstall, onUpdate, onRemove }) {
  const slot = el('div', 'agent-actions');
  slot.dataset.id = agent.command;
  const buttons = [];
  const add = (label, variant, fn) => {
    if (!fn) return;
    const btn = el('button', `btn ${variant}`, label);
    btn.onclick = (e) => {
      e?.stopPropagation?.();
      for (const b of buttons) b.disabled = true;
      btn.textContent = BUSY_LABEL[label];
      fn(agent);
    };
    buttons.push(btn);
    slot.appendChild(btn);
  };
  if (agent.installed) {
    add('Update', 'btn-accent', onUpdate);
    add('Remove', 'btn-ghost', onRemove);
  } else {
    add('Install', 'btn-accent', onInstall);
  }
  return slot;
}

export function showLoading(container) {
  container.innerHTML = '';
  const head = el('div', 'agents-head');
  head.append(el('span', 'agents-title', 'Agents'), el('span', 'agents-summary', 'Reading the agent list…'));
  container.appendChild(head);
  container.appendChild(screenSpinner());
}

// A failed `codemie list` leaves the screen with nothing to show, so it states
// what happened and offers the read again rather than rendering an empty list,
// which would read as "there are no agents".
export function showRunError(container, message, onRetry) {
  container.innerHTML = '';
  const head = el('div', 'agents-head');
  head.append(el('span', 'agents-title', 'Agents'), el('span', 'agents-summary', ''));
  container.appendChild(head);

  const panel = el('div', 'agents-error');
  panel.append(
    el('div', 'agents-error-title', 'CodeMie could not read the agent list'),
    el('div', 'agents-error-detail', message),
  );
  const retry = el('button', 'btn btn-accent', 'Try again');
  retry.onclick = () => onRetry && onRetry();
  panel.appendChild(retry);
  container.appendChild(panel);
}
