// By date (task provider design §9): To review, Late (with its ⋯ menu), Today and Later's folds
// (Next 7 days, No date, Later than that), "Check with <name>" rows with Nudge / Done / Snooze,
// "Looks handled", pending and parked rows, the provider's banner and the footer. Pure: takes
// the Tasks page's computed state (`pageOf` in view-tasks.js) and returns HTML; tasks-controller.js
// handles the actions. Every provider string goes through `escapeHtml`.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { button } from './ui.js';
import { activeProvider } from './tasks-model.js';
import { chipsFor, dateGroups, rowOf } from './tasks-dates-model.js';

const FOLDS = [['next7', 'Next 7 days'], ['noDate', 'No date'], ['later', 'Later than that']];
/** A DOM id from a task id (ids are attribute-escaped where they are used). */
const domId = (prefix, id) => `${prefix}-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** The banner for a provider that can't sync on its own (one at a time; offline and rate
 *  limits stay in the header line). */
function banner(tp) {
  const name = e(tp?.name || 'Your task app');
  if (tp?.state === 'needs_token') {
    return `<div class="ws-tdate-banner" role="alert">${icon('alert')}<span>${name} needs your API token.</span>${button('Open Settings', { action: 'settings-tab', size: 'sm', attrs: { 'data-tab': 'meetings-tasks' } })}</div>`;
  }
  if (tp?.state === 'off') return `<div class="ws-tdate-banner" role="alert">${icon('alert')}<span>${name} is turned off in Settings › Plugins. You're seeing the last copy; changes wait.</span></div>`;
  if (tp?.state === 'failed') return `<div class="ws-tdate-banner" role="alert">${icon('alert')}<span>The ${name} plugin didn't load${tp.message ? `: ${e(tp.message)}` : ''}.</span></div>`;
  return '';
}

/** Date chips as buttons: a day sets the due date, Pick date… asks for one. */
const chipButtons = (id, chips) => chips.map(([label, day]) => (day
  ? `<button type="button" class="ws-tdate-chip" data-action="task-snooze" data-id="${e(id)}" data-value="${e(day)}">${e(label)}</button>`
  : `<button type="button" class="ws-tdate-chip" data-action="task-pick-date" data-id="${e(id)}">${e(label)}</button>`)).join('');

function row(p, r, group) {
  const x = rowOf(r, { me: p.me, s: p.s, now: p.now, zone: p.zone });
  const id = e(x.id);
  const review = group === 'review';
  const open = p.v.rowOpen === x.id;
  const errId = x.syncError ? domId('tdate-err', x.id) : '';
  const due = x.due && group !== 'today' ? `<span class="ws-tdate-due ws-tdate-due-${x.due.tone}">${e(x.due.text)}</span>` : '';
  const src = x.source ? `<span class="ws-tdate-src">· ${e(x.source.title)}</span>` : '';
  const pending = x.pending ? `<span class="ws-tdate-pending" title="Not in ${e(p.providerName)} yet"><span class="ws-sr">Not in ${e(p.providerName)} yet</span></span>` : '';
  const box = review ? '' : `<label class="ws-check ws-tdate-box"><input type="checkbox" data-action="task-done" data-id="${id}" aria-label="Mark “${e(x.text)}” done"><span class="ws-check-box" aria-hidden="true">${icon('check')}</span></label>`;
  const main = `<button type="button" class="ws-tdate-main" data-action="task-row-open" data-id="${id}" aria-expanded="${open}"${errId ? ` aria-describedby="${errId}"` : ''}><span class="ws-tdate-text">${e(review ? x.text : x.label)}</span>${src}${pending}${due}</button>`;
  const acts = [];
  if (review) {
    acts.push(`<div class="ws-tdate-acts">${button('Accept', { action: 'task-accept', size: 'sm', variant: 'primary', attrs: { 'data-id': x.id, 'aria-label': `Accept: ${x.text}` } })}${button('Not a task', { action: 'task-dismiss', size: 'sm', variant: 'ghost', attrs: { 'data-id': x.id, 'aria-label': `Not a task: ${x.text}` } })}</div>`);
  } else if (x.checkWith) {
    const first = x.checkWith.first;
    const snooze = `<details class="ws-menu ws-tdate-snooze" data-menu="task-snooze-${id}">
      <summary class="ws-btn ws-btn-ghost ws-btn-sm" aria-label="Snooze: ${e(x.text)}">Snooze ▾</summary>
      <div class="ws-menu-panel">${chipsFor(group, p).map(([label, day]) => (day
        ? `<button type="button" class="ws-menu-item" data-action="task-snooze" data-id="${id}" data-value="${e(day)}"><span>${e(label)}</span></button>`
        : `<button type="button" class="ws-menu-item" data-action="task-pick-date" data-id="${id}"><span>${e(label)}</span></button>`)).join('')}</div></details>`;
    acts.push(`<div class="ws-tdate-acts">${x.nudge ? button(`Nudge ${first}`, { action: 'task-nudge', size: 'sm', variant: 'ghost', attrs: { 'data-id': x.id } }) : ''}${button('Done', { action: 'task-done', size: 'sm', variant: 'ghost', attrs: { 'data-id': x.id, 'aria-label': `Done: ${x.text}` } })}${snooze}</div>`);
  }
  if (x.handled && !review) {
    acts.push(`<div class="ws-tdate-handled"><span>${icon('check-circle')}Looks handled · ${e(x.handled.evidence)}</span>${button('Done', { action: 'task-handled', size: 'sm', variant: 'ghost', attrs: { 'data-id': x.id, 'data-act': 'done', 'aria-label': `Done: ${x.text}` } })}${button('Keep open', { action: 'task-handled', size: 'sm', variant: 'ghost', attrs: { 'data-id': x.id, 'data-act': 'keep', 'aria-label': `Keep open: ${x.text}` } })}</div>`);
  }
  if (x.syncError) {
    acts.push(`<div class="ws-tdate-parked"><span class="ws-tdate-error" id="${errId}">${e(x.syncError)}</span>${button('Try again', { action: 'task-parked', size: 'sm', variant: 'ghost', attrs: { 'data-id': x.id, 'data-act': 'retry' } })}${button('Discard change', { action: 'task-parked', size: 'sm', variant: 'ghost', attrs: { 'data-id': x.id, 'data-act': 'discard' } })}</div>`);
  }
  let chips = '';
  if (open) {
    const links = [
      !review ? chipButtons(x.id, chipsFor(group, p)) : '',
      x.url ? `<button type="button" class="ws-tdate-chip" data-action="task-open-remote" data-id="${id}">Open in ${e(p.providerName)} ↗</button>` : '',
      x.source?.kind === 'meeting' ? `<button type="button" class="ws-tdate-chip" data-action="task-open-meeting" data-id="${e(x.source.id)}">Open meeting</button>` : '',
      x.source?.kind === 'message' ? `<button type="button" class="ws-tdate-chip" data-action="task-open-message" data-id="${e(x.source.id)}">Open message</button>` : '',
      `<button type="button" class="ws-tdate-chip" data-action="task-open" data-id="${id}">Details</button>`,
    ].join('');
    chips = `<div class="ws-tdate-chips">${links}</div>`;
  }
  const classes = ['ws-tdate-row', open && 'ws-tdate-open', x.due?.tone === 'late' && 'ws-tdate-late', x.syncError && 'ws-tdate-row-parked'].filter(Boolean).join(' ');
  return `<div class="${classes}" data-task="${id}"><div class="ws-tdate-line">${box}${main}</div>${acts.join('')}${chips}</div>`;
}

function section(key, title, body, tools = '') {
  return `<section class="ws-tdate-group ws-tdate-${key}" aria-labelledby="tdate-h-${key}">
    <header class="ws-tdate-head"><h2 id="tdate-h-${key}">${e(title)}</h2>${tools}</header>${body}</section>`;
}

function lateMenu(n) {
  if (!n) return '';
  const item = (action, label, attrs = '') => `<button type="button" class="ws-menu-item" data-action="${action}"${attrs}><span>${e(label)}</span></button>`;
  return `<details class="ws-menu ws-menu-right ws-tdate-menu" data-menu="tasks-late">
    <summary class="ws-btn ws-btn-ghost ws-btn-icon ws-btn-sm" aria-label="Late tasks: actions" title="Late tasks">${icon('dots')}</summary>
    <div class="ws-menu-panel">${item('tasks-late-move', 'Move all to Tomorrow', ' data-to="tomorrow"')}${item('tasks-late-move', 'Move all to Monday', ' data-to="monday"')}${item('tasks-late-move', 'Pick date…', ' data-to="pick"')}<hr>${item('tasks-late-done', 'Done all')}</div></details>`;
}

function fold(p, key, label, items) {
  const open = !!p.v.folds?.[key];
  const panel = `tdate-fold-${key}`;
  return `<div class="ws-tdate-fold">
    <button type="button" class="ws-tdate-fold-btn" data-action="tasks-fold" data-fold="${key}" aria-expanded="${open}" aria-controls="${panel}">${icon(open ? 'chevron-down' : 'chevron-right')}<span>${e(label)}</span><span class="ws-tdate-count">${items.length}</span></button>
    <div class="ws-tdate-rows" id="${panel}"${open ? '' : ' hidden'}>${open ? items.map(r => row(p, r, key)).join('') : ''}</div></div>`;
}

function footer(p, doneToday) {
  const f = p.v.footer;
  const last = f ? ` · <span>${e(f.text)}</span> · <button type="button" class="ws-link" data-action="tasks-undo">Undo</button>` : '';
  return `<p class="ws-tdate-foot" role="status"><span>${doneToday} done today</span>${last}</p>`;
}

/** By date for the page state `p` (`pageOf` in view-tasks.js): the active provider's tasks. */
export function datesView(p) {
  const g = dateGroups(p.all, { now: p.now, zone: p.zone, me: p.me });
  p = { ...p, providerName: p.s.taskProvider?.name || 'Connect' };
  const rows = (list, group) => `<div class="ws-tdate-rows">${list.map(r => row(p, r, group)).join('')}</div>`;
  const review = g.review.length
    ? section('review', `To review · ${g.review.length}`, rows(g.review, 'review'), g.review.length > 1 ? button('Accept all', { action: 'task-accept-all', size: 'sm', variant: 'ghost' }) : '')
    : '';
  const late = section('late', g.late.length ? `Late · ${g.late.length}` : 'Late', g.late.length ? rows(g.late, 'late') : '<p class="ws-tdate-empty">Nothing late.</p>', lateMenu(g.late.length));
  const today = section('today', 'Today', g.today.length ? rows(g.today, 'today') : '<p class="ws-tdate-empty">Nothing for today.</p>');
  const folds = FOLDS.filter(([key]) => g[key].length).map(([key, label]) => fold(p, key, label, g[key])).join('');
  const later = folds ? section('later', 'Later', folds) : '';
  return `<div class="ws-tdate"${activeProvider(p.s) === 'local' ? '' : ' data-provider'}>
    ${banner(p.s.taskProvider)}
    <div class="ws-tdate-cols">
      <div class="ws-tdate-col">${review}${late}${today}${footer(p, g.doneToday.length)}</div>
      <div class="ws-tdate-col">${later}</div>
    </div>
  </div>`;
}
