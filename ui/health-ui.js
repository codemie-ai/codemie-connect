// Presentational render module for the Health screen (#health-view). Pure
// DOM building from the { rows, summary } shape produced by doctor-groups.js
// — no invoke()/runStream() calls live here; those belong to renderer.js.
//
// A problem's remedy, and the log that cannot be opened, are drawn with the
// app's failure panel (ui/failure-panel.js) rather than a second look of their
// own: red for a failure, amber for a warning, the action inside the panel.
import { renderFailurePanel } from './failure-panel.js';

const GROUP_LABELS = { account: 'Your CodeMie account', tools: 'Your tools', codemie: 'CodeMie itself' };
const GROUP_ORDER = ['account', 'tools', 'codemie'];
const ICONS = { pass: '✓', warn: '!', fail: '✕' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const clock = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function renderHealth(container, { rows, summary, checkedAt }, handlers = {}) {
  const { onRecheck, onOpenLog } = handlers;
  container.innerHTML = '';

  const head = el('div', 'health-head');
  const counted = `${summary.passing} of ${summary.total} fine`;
  head.append(
    el('span', 'health-title', 'Health'),
    el('span', 'health-summary', checkedAt ? `${counted} · checked at ${clock(checkedAt)}` : counted),
  );
  container.appendChild(head);

  for (const group of GROUP_ORDER) {
    const groupRows = rows.filter((r) => r.group === group);
    if (!groupRows.length) continue;
    container.appendChild(el('div', 'health-group-heading', GROUP_LABELS[group]));
    groupRows.forEach((row) => container.appendChild(buildRow(row, handlers)));
  }

  const actions = el('div', 'health-actions');
  const recheckBtn = el('button', 'btn btn-accent', 'Check everything again');
  recheckBtn.onclick = () => onRecheck && onRecheck();
  const logBtn = el('button', 'btn btn-ghost', "Open today's log");
  logBtn.onclick = () => onOpenLog && onOpenLog();
  actions.append(recheckBtn, logBtn);
  container.appendChild(actions);

  container.appendChild(el('div', 'health-log-slot'));
}

function buildRow(row, { onRecheck, onNavigate, onSignIn }) {
  const node = el('div', `health-row health-${row.status}`);

  const main = el('div', 'health-row-main');
  main.append(el('span', 'health-icon', ICONS[row.status]), el('span', 'health-label', row.label));
  if (row.detail) main.appendChild(el('span', 'health-detail', row.detail));
  node.appendChild(main);

  if (row.remedyText) {
    const { action } = row;
    renderFailurePanel(node, {
      variant: row.status === 'warn' ? 'warning' : 'error',
      title: 'What to do',
      explanation: row.remedyText,
      detail: row.remedyDetail,
      primaryLabel: action && action.label,
      onPrimary: () => {
        if (action.kind === 'navigate') onNavigate?.(action.view);
        else if (action.kind === 'signin') onSignIn?.();
        else onRecheck?.();
      },
    });
  }
  return node;
}

// Keeps the screen's header while the checks run, so the title does not
// vanish and come back on every recheck.
export function showLoading(container) {
  container.innerHTML = '';
  const head = el('div', 'health-head');
  head.append(el('span', 'health-title', 'Health'), el('span', 'health-summary', 'Checking…'));
  container.appendChild(head);
}

// A log that opened makes an earlier "cannot open your log" untrue.
export function clearLogError(container) {
  container.querySelector('.health-log-slot')?.querySelector('.failure-block')?.remove();
}

export function showLogError(container, message) {
  // CR-003: showLoading() wipes the whole container, including this slot.
  // "Check everything again" can race a pending open_log rejection — when
  // that rejection's handler finally runs, the lookup below would otherwise
  // return null and drop the failure with no user-visible message. Recreate
  // the slot rather than no-op, so the message is never silently lost.
  let slot = container.querySelector('.health-log-slot');
  if (!slot) {
    slot = el('div', 'health-log-slot');
    container.appendChild(slot);
  }
  renderFailurePanel(slot, { title: 'CodeMie cannot open your log', explanation: message });
}

// Explicit failure/empty-result state for the Health screen, rendered by
// health-controller.js when the doctor run itself could not be trusted
// (CR-005: zero stdout records look identical to a real all-clear; CR-006: a
// runStream rejection must not leave the screen stuck on "Checking…"
// forever). Always offers a retry so the user is never stranded.
export function showRunError(container, message, onRetry) {
  container.innerHTML = '';
  renderFailurePanel(container, {
    title: 'CodeMie could not check its health',
    explanation: message,
    primaryLabel: 'Check everything again',
    onPrimary: () => onRetry && onRetry(),
  });
}
