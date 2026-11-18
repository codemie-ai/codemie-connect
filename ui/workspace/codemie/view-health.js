// Settings → CodeMie → Health: `codemie doctor` in plain language, grouped by who can act on a
// problem, each problem with the one action that fixes it — then every command CodeMie ran.
import { escapeHtml as e } from '../store.js';
import { icon } from '../icons.js';
import { badge, button, card, emptyState, spinner } from '../ui.js';
import { colorLog, logBlock, problem } from './view-common.js';

const GROUPS = [['account', 'Your CodeMie account'], ['tools', 'Your tools'], ['codemie', 'CodeMie itself']];
const STATE = { pass: ['ok', 'check'], warn: ['warn', 'alert'], fail: ['bad', 'close'] };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The button for a doctor row's action (ui/doctor-groups.js kinds), in this screen's words. */
function remedyButton(action, cm, warn) {
  if (!action) return '';
  const variant = warn ? 'secondary' : 'primary';
  if (action.kind === 'signin') return button('Sign in again', { action: 'cm-profile-login', variant, attrs: { 'data-id': cm.config.active || undefined } });
  if (action.kind === 'recheck') return button('Check again', { action: 'cm-doctor', variant });
  if (action.kind === 'navigate' && action.view === 'setup') return button('Set up CodeMie', { action: 'cm-setup-open', variant });
  if (action.kind === 'navigate' && action.view === 'agents') return button('Open Coding agents', { action: 'cm-tab', variant, attrs: { 'data-tab': 'cm-agents' } });
  return '';
}

function remedyText(row) {
  if (row.action?.kind === 'navigate' && row.action.view === 'agents') return 'Update it in Coding agents. Until then it may not start.';
  return row.remedyText || '';
}

function checkRow(row, cm) {
  const [state, ico] = STATE[row.status] || STATE.warn;
  const warn = row.status === 'warn';
  const text = remedyText(row);
  const fix = row.status !== 'pass' && (text || row.action)
    ? `<div class="cm-remedy${warn ? ' cm-remedy-warn' : ''}"><span><strong>What to do:</strong> ${e(text || 'See what CodeMie said below.')}</span>${remedyButton(row.action, cm, warn)}</div>${logBlock('What CodeMie said', row.remedyDetail)}`
    : '';
  return `<div class="cm-check" data-state="${state}">${icon(ico)}<div><strong>${e(row.label)}</strong>${row.detail ? `<span class="cm-check-note">· ${e(row.detail)}</span>` : ''}${fix}</div></div>`;
}

export function healthPanel(cm, runLog, ui = {}) {
  const running = !!cm.busy.doctor;
  let body;
  if (running) {
    body = `<div class="cm-agent-busy" role="status"><span class="cm-status">${spinner('Checking')}<span>Checking your sign-in, coding agents and CodeMie itself…</span></span></div>`;
  } else if (!cm.health) {
    body = emptyState({
      iconName: 'heart', title: 'Check that everything works',
      text: 'Connect checks your sign-in, asks the model a one-word question, and looks at every agent and app. About 10 seconds.',
      actions: button('Check everything', { action: 'cm-doctor', variant: 'primary', iconName: 'refresh' }),
    });
  } else {
    body = GROUPS.map(([group, title]) => {
      const rows = cm.health.rows.filter((r) => r.group === group);
      return rows.length ? `<div class="cm-health-group"><h4>${e(title)}</h4>${rows.map((r) => checkRow(r, cm)).join('')}</div>` : '';
    }).join('') || emptyState({ iconName: 'heart', title: 'CodeMie reported no checks', text: 'Run the check again, or look at what CodeMie printed below.' });
  }
  const error = cm.errors.doctor ? problem({ title: 'The check did not finish', text: cm.errors.doctor.message, retry: 'cm-doctor', cmd: 'codemie doctor', output: cm.errors.doctor.output }) : '';
  const res = cm.health && !running ? cm.health : null;
  return card({
    title: 'Checks', iconName: 'heart',
    actions: res ? `<span class="ws-muted ws-hint">${res.summary.passing} of ${res.summary.total} fine · checked at ${e(clock(res.checkedAt))}</span>` : '',
    body: error + body,
  }) + ranCard(runLog, ui);
}

/** "What CodeMie ran": newest first; a click shows the output. */
export function ranCard(runLog, ui = {}) {
  const entries = runLog.list().slice().reverse().slice(0, 40);
  const rows = entries.map((r) => {
    const chip = r.code === null ? badge('running', 'info') : r.code === 0 ? badge('ok', 'success') : badge('failed', 'error');
    const open = ui.expandedRan === r.id;
    const out = open ? `<div class="cm-ran-out">${r.output ? `<pre class="cm-log-pre">${colorLog(r.output)}</pre>` : '<p class="ws-muted ws-hint">No output.</p>'}</div>` : '';
    return `<div class="cm-ran-row"><time>${e(clock(r.at))}</time><button type="button" data-action="cm-ran-toggle" data-id="${r.id}" title="Show output" aria-expanded="${open}"><code>${e(r.cmd)}</code></button>${chip}${out}</div>`;
  }).join('');
  return card({
    title: 'What CodeMie ran', iconName: 'list', attrs: { style: 'margin-top:16px' },
    actions: button('Copy all', { action: 'cm-copy-all', variant: 'ghost', iconName: 'copy', disabled: !entries.length }),
    body: entries.length
      ? `<div class="cm-ran">${rows}</div><p class="ws-muted ws-hint" style="margin-top:10px">Click a command to see its output. “Copy all” is what to send if you ask for help.</p>`
      : emptyState({ iconName: 'list', title: 'Nothing yet', text: 'Every command Connect runs for CodeMie appears here with its output.' }),
  });
}
