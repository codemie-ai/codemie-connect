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
// 03-agents.png draws a list and a detail pane (EPMCDME-14655): the rows say
// what is installed, the pane on the right says what the selected tool is, how
// to run it and what its action is doing. Progress and failures live in the
// pane, never in a modal, and the CLI's own output is not kept.
import { StepStatus, makeStep } from './models.js';
import { renderFailurePanel } from './failure-panel.js';
import { screenSpinner } from './screen-loading.js';
import { BUILTIN_AGENT_COMMAND } from './home-state.js';

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
  const base = agent.installed && agent.version ? `${agent.description} · ${agent.version}` : agent.description;
  if (agent.command === BUILTIN_AGENT_COMMAND) return `${base} · built into the CLI`;
  if (agent.updateAvailable) return `${base} · ${agent.latest ? `${agent.latest} available` : 'update available'}`;
  return base;
};

export function summarise(agents) {
  return {
    installed: agents.filter((a) => a.installed).length,
    total: agents.length,
    // The built-in agent updates with the CLI and its row offers no Update.
    updateAvailable: agents.filter((a) => a.updateAvailable && a.command !== BUILTIN_AGENT_COMMAND).length,
  };
}

// The action buttons currently on screen, so one click can disable them all.
// The rows' are rebuilt by renderAgents, the pane's by renderPane.
let rowButtons = [];
let paneButtons = [];

const EMPTY_PANE = 'Select a tool to see what it is and what you can do with it.';

export function renderAgents(container, { agents, selected = null, progress = {} }, handlers = {}) {
  const { stepsUi, onInstall, onUpdate, onRemove, onSelect } = handlers;
  container.innerHTML = '';

  const { installed, total, updateAvailable } = summarise(agents);
  const summaryText = `${installed} of ${total} installed${updateAvailable ? ` · ${updateAvailable} update${updateAvailable === 1 ? '' : 's'} available` : ''}`;
  const head = el('div', 'agents-head');
  head.append(el('span', 'agents-title', 'Tools'), el('span', 'agents-summary', summaryText));
  container.appendChild(head);

  container.appendChild(el('div', 'agents-note', 'Run a tool from a terminal. This screen only sets them up.'));

  const body = el('div', 'agents-body');
  const list = el('div', 'agents-list');
  const pane = el('div', 'agent-pane');
  body.append(list, pane);
  container.appendChild(body);

  stepsUi.renderSteps(list, agents.map((a) => makeStep({ id: a.command, title: a.name })));
  rowButtons = [];
  for (const agent of agents) {
    stepsUi.setStatus(agent.command, statusOf(agent));
    stepsUi.setSubtitle(agent.command, subtitleOf(agent));
    const row = list.querySelector(`.step-row[data-id="${agent.command}"]`);
    if (row) {
      row.appendChild(buildActions(agent, { onInstall, onUpdate, onRemove }, rowButtons));
      row.onclick = () => onSelect?.(agent.command);
      if (agent.command === selected) row.className = `${row.className} selected`.trim();
    }
    if (row && agent.updateAvailable) {
      row.title = agent.latest ? `A newer version is out. Update installs ${agent.latest}.` : 'A newer version is out. Update installs it.';
    }
  }
  const agent = agents.find((a) => a.command === selected);
  renderPane(container, agent, { progress: agent ? progress[agent.command] : undefined }, handlers);
}

// Marks the selected row without rebuilding the list. The class is `selected`,
// not `active`: `active` is the running row and is never touched here.
export function setSelectedRow(container, command) {
  for (const row of container.querySelectorAll('.step-row')) {
    const others = row.className.split(' ').filter((c) => c && c !== 'selected');
    row.className = (row.dataset.id === command ? [...others, 'selected'] : others).join(' ');
  }
}

// Redraws only the detail pane. It is called for every streamed line and every
// selection, so it must not touch the step list: renderSteps would wipe the
// running row's spinner, its ACTIVE badge and its disabled buttons.
//
// state: { progress, message, busy, action }. `message` overrides the failure
// text; otherwise an errored agent shows its own actionMessage. `action` is the
// label of the button whose action is running ('Install' | 'Update' | 'Remove').
export function renderPane(container, agent, state = {}, handlers = {}) {
  const pane = container.querySelector('.agent-pane');
  if (!pane) return;
  pane.innerHTML = '';
  paneButtons = [];
  if (!agent) {
    pane.appendChild(el('div', 'agent-pane-empty', EMPTY_PANE));
    return;
  }
  const { progress, message, busy, action } = state;
  const builtin = agent.command === BUILTIN_AGENT_COMMAND;

  pane.appendChild(el('div', 'agent-pane-name', agent.name));
  if (agent.description) pane.appendChild(el('div', 'agent-pane-desc', agent.description));
  pane.appendChild(el('div', 'agent-pane-version', versionLine(agent, builtin)));
  if (!builtin && agent.newerThanSupported) {
    pane.appendChild(el('div', 'agent-pane-detail', `Installed ${agent.current}. CodeMie supports ${agent.latest}.`));
  }
  if (agent.installed && agent.launcher) {
    pane.appendChild(el('div', 'agent-pane-launcher', `Run it from a terminal: ${agent.launcher}`));
  }

  const slot = buildActions(agent, handlers, paneButtons, { busy, action });
  if (slot.children.length) pane.appendChild(slot);
  if (progress) pane.appendChild(el('div', 'agent-pane-progress', progress));

  const failure = message ?? (agent.actionStatus === 'error' ? agent.actionMessage : null);
  if (failure) {
    const failureSlot = el('div', 'agent-pane-failure');
    renderFailurePanel(failureSlot, { variant: 'error', title: `Could not finish with ${agent.name}`, explanation: failure });
    pane.appendChild(failureSlot);
  } else if (agent.actionMessage) {
    pane.appendChild(el('div', 'agent-pane-note', agent.actionMessage));
  }
}

function versionLine(agent, builtin) {
  if (builtin) return 'Installed, built into the CLI';
  if (!agent.installed) return 'Not installed';
  if (agent.newerThanSupported) return 'Newer than CodeMie supports — kept';
  if (agent.updateAvailable) return `Update available ${agent.latest || ''}`.trim();
  return `Installed ${agent.version || ''}`.trim();
}

const BUSY_LABEL = { Install: 'Installing…', Update: 'Updating…', Remove: 'Removing…' };

// One action slot per row. A button is drawn only when its handler exists, so
// this screen never shows a control that does nothing. One action runs at a
// time: npm installs into one shared folder, and a second one started beside
// the first leaves the list reading a half-done state. A click disables every
// button on the screen and says what is running; the refresh after the action
// draws the rows again with fresh buttons.
function buildActions(agent, { onInstall, onUpdate, onRemove }, screenButtons = [], { busy = false, action } = {}) {
  const slot = el('div', 'agent-actions');
  slot.dataset.id = agent.command;
  // The built-in agent ships inside the CLI: the CLI refuses to update it and
  // its uninstall leaves it installed, so neither button would do anything.
  if (agent.command === BUILTIN_AGENT_COMMAND) return slot;
  const add = (label, variant, fn) => {
    if (!fn) return;
    const btn = el('button', `btn ${variant}`, label);
    btn.onclick = (e) => {
      e?.stopPropagation?.();
      for (const b of [...rowButtons, ...paneButtons]) b.disabled = true;
      btn.textContent = BUSY_LABEL[label];
      fn(agent);
    };
    if (busy) {
      btn.disabled = true;
      if (label === action) btn.textContent = BUSY_LABEL[label];
    }
    screenButtons.push(btn);
    slot.appendChild(btn);
  };
  if (agent.installed) {
    // Update only when `codemie update --check` says one is out.
    if (agent.updateAvailable) add('Update', 'btn-accent', onUpdate);
    add('Remove', 'btn-ghost', onRemove);
  } else {
    add('Install', 'btn-accent', onInstall);
  }
  return slot;
}

export function showLoading(container) {
  container.innerHTML = '';
  const head = el('div', 'agents-head');
  head.append(el('span', 'agents-title', 'Tools'), el('span', 'agents-summary', 'Reading the tool list…'));
  container.appendChild(head);
  container.appendChild(screenSpinner());
}

// A failed `codemie list` leaves the screen with nothing to show, so it states
// what happened and offers the read again rather than rendering an empty list,
// which would read as "there are no agents".
export function showRunError(container, message, onRetry) {
  container.innerHTML = '';
  const head = el('div', 'agents-head');
  head.append(el('span', 'agents-title', 'Tools'), el('span', 'agents-summary', ''));
  container.appendChild(head);

  const panel = el('div', 'agents-error');
  panel.append(
    el('div', 'agents-error-title', 'CodeMie could not read the tool list'),
    el('div', 'agents-error-detail', message),
  );
  const retry = el('button', 'btn btn-accent', 'Try again');
  retry.onclick = () => onRetry && onRetry();
  panel.appendChild(retry);
  container.appendChild(panel);
}
