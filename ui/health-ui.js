// Presentational render module for the Health screen (#health-view). Pure
// DOM building from the { rows, summary } shape produced by doctor-groups.js
// — no invoke()/runStream() calls live here; those belong to renderer.js.
const GROUP_LABELS = { account: 'Your account', tools: 'Your tools', codemie: 'CodeMie itself' };
const GROUP_ORDER = ['account', 'tools', 'codemie'];

export function renderHealth(container, { rows, summary }, { onRecheck, onOpenLog, onNavigate } = {}) {
  container.innerHTML = '';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'health-summary';
  summaryEl.textContent = `${summary.passing} of ${summary.total} fine`;
  container.appendChild(summaryEl);

  const actions = document.createElement('div');
  actions.className = 'health-actions';
  const recheckBtn = document.createElement('button');
  recheckBtn.textContent = 'Check everything again';
  recheckBtn.onclick = () => onRecheck && onRecheck();
  const logBtn = document.createElement('button');
  logBtn.textContent = "Open today's log";
  logBtn.onclick = () => onOpenLog && onOpenLog();
  actions.append(recheckBtn, logBtn);
  container.appendChild(actions);

  const logError = document.createElement('div');
  logError.className = 'health-log-error hidden';
  container.appendChild(logError);

  for (const group of GROUP_ORDER) {
    const groupRows = rows.filter((r) => r.group === group);
    if (!groupRows.length) continue;
    const heading = document.createElement('div');
    heading.className = 'health-group-heading';
    heading.textContent = GROUP_LABELS[group];
    container.appendChild(heading);
    groupRows.forEach((row) => container.appendChild(buildRow(row, { onRecheck, onNavigate })));
  }
}

function buildRow(row, { onRecheck, onNavigate }) {
  const el = document.createElement('div');
  el.className = `health-row health-${row.status}`;
  const icon = document.createElement('span');
  icon.textContent = row.status === 'pass' ? '✓' : '✗';
  const label = document.createElement('span');
  label.textContent = row.label;
  el.append(icon, label);
  if (row.status === 'fail' && row.remedyText) {
    const remedy = document.createElement('div');
    remedy.className = 'health-remedy';
    remedy.textContent = row.remedyText;
    el.appendChild(remedy);
  }
  if (row.action) {
    const btn = document.createElement('button');
    btn.textContent = row.action.label;
    btn.onclick = () => (row.action.kind === 'recheck' ? onRecheck?.() : onNavigate?.(row.action.view));
    el.appendChild(btn);
  }
  return el;
}

export function showLoading(container) {
  container.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'health-loading';
  el.textContent = 'Checking…';
  container.appendChild(el);
}

export function showLogError(container, message) {
  // CR-003: showLoading() wipes the whole container, including this element.
  // "Check everything again" can race a pending open_log rejection — when
  // that rejection's handler finally runs, the lookup below would otherwise
  // return null and drop the failure with no user-visible message. Recreate
  // the banner rather than no-op, so the message is never silently lost.
  let el = container.querySelector('.health-log-error');
  if (!el) {
    el = document.createElement('div');
    el.className = 'health-log-error';
    container.appendChild(el);
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

// Explicit failure/empty-result state for the Health screen, rendered by
// health-controller.js when the doctor run itself could not be trusted
// (CR-005: zero stdout records look identical to a real all-clear; CR-006: a
// runStream rejection must not leave the screen stuck on "Checking…"
// forever). Always offers a retry so the user is never stranded.
export function showRunError(container, message, onRetry) {
  container.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'health-error';
  el.textContent = message;
  container.appendChild(el);
  const btn = document.createElement('button');
  btn.textContent = 'Check everything again';
  btn.onclick = () => onRetry && onRetry();
  container.appendChild(btn);
}
