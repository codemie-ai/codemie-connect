// By date (task provider design §9): To review, Late (with its ⋯ menu), Today and Later's folds
// (Next 7 days, No date, Later than that), "Check with <name>" rows with Nudge and Snooze ▾,
// "Looks handled", pending and parked rows (a folded row has only its done box; unfolded, at most
// three controls), the provider's banner and the footer. Pure: takes
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

/** A menu item: `[label, action, attrs, danger]`. */
const item = ([label, action, attrs = {}, danger = false]) => `<button type="button" class="ws-menu-item${danger ? ' ws-menu-danger' : ''}" data-action="${action}"${Object.entries(attrs).map(([k, v]) => ` ${k}="${e(v)}"`).join('')}><span>${e(label)}</span></button>`;

/** The date choices of a row as menu items: a day sets the due date, Pick date… asks for one. */
const dateItems = (id, group, p) => chipsFor(group, p).map(([label, day]) => item(day
  ? [label, 'task-snooze', { 'data-id': id, 'data-value': day }]
  : [label, 'task-pick-date', { 'data-id': id }]));

/** Snooze ▾: the row's date choices, the only place they are offered. */
const snoozeMenu = (x, group, p, primary) => `<details class="ws-menu ws-tdate-snooze" data-menu="task-snooze-${e(x.id)}">
      <summary class="ws-btn ws-btn-${primary ? 'primary' : 'ghost'} ws-btn-sm" aria-label="Snooze: ${e(x.text)}">Snooze ▾</summary>
      <div class="ws-menu-panel">${dateItems(x.id, group, p).join('')}</div></details>`;

/** The row's ⋯: where it lives and what else can be done with it (dates too, when Snooze ▾
 *  isn't one of the row's own controls). */
function moreMenu(x, group, p, { dates }) {
  const items = [
    ...(dates ? [`<div class="ws-menu-label">Snooze</div>${dateItems(x.id, group, p).join('')}<hr>`] : []),
    x.url ? item([`Open in ${p.providerName} ↗`, 'task-open-remote', { 'data-id': x.id }]) : '',
    x.source?.kind === 'meeting' ? item(['Open meeting', 'task-open-meeting', { 'data-id': x.source.id }]) : '',
    x.source?.kind === 'message' ? item(['Open message', 'task-open-message', { 'data-id': x.source.id }]) : '',
    item(['Details', 'task-open', { 'data-id': x.id }]),
    `<hr>${item(['Delete', 'task-delete', { 'data-id': x.id }, true])}`,
  ].join('');
  return `<details class="ws-menu ws-menu-right ws-tdate-more" data-menu="task-more-${e(x.id)}">
      <summary class="ws-btn ws-btn-ghost ws-btn-icon ws-btn-sm" aria-label="More for “${e(x.text)}”" title="More">${icon('dots')}</summary>
      <div class="ws-menu-panel">${items}</div></details>`;
}

/**
 * An unfolded row's controls, at most three, the first the row's primary:
 *   To review: Accept, Not a task, ⋯; parked: Try again, Discard change, ⋯;
 *   looks handled: Done, Keep open, ⋯; check-in: Nudge <name> (with a synced thread), Snooze ▾, ⋯;
 *   any other: Snooze ▾, ⋯. Done is the done box.
 */
function controls(x, group, p) {
  const sm = (label, action, attrs, primary = false) => button(label, { action, size: 'sm', variant: primary ? 'primary' : 'ghost', attrs: { 'data-id': x.id, ...attrs } });
  if (group === 'review') return [button('Accept', { action: 'task-accept', size: 'sm', attrs: { 'data-id': x.id, 'aria-label': `Accept: ${x.text}` } }), sm('Not a task', 'task-dismiss', { 'aria-label': `Not a task: ${x.text}` }), moreMenu(x, group, p, { dates: false })];
  if (x.syncError) return [sm('Try again', 'task-parked', { 'data-act': 'retry' }, true), sm('Discard change', 'task-parked', { 'data-act': 'discard' }), moreMenu(x, group, p, { dates: true })];
  if (x.handled) return [sm('Done', 'task-handled', { 'data-act': 'done', 'aria-label': `Done: ${x.text}` }, true), sm('Keep open', 'task-handled', { 'data-act': 'keep', 'aria-label': `Keep open: ${x.text}` }), moreMenu(x, group, p, { dates: true })];
  const nudge = x.checkWith && x.nudge ? [sm(`Nudge ${x.checkWith.first}`, 'task-nudge', {}, true)] : [];
  return [...nudge, snoozeMenu(x, group, p, !nudge.length), moreMenu(x, group, p, { dates: false })];
}

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
  // What the row says about itself shows folded too; its controls only unfolded.
  const notes = [
    x.handled && !review ? `<p class="ws-tdate-handled">${icon('check-circle')}<span>Looks handled · ${e(x.handled.evidence)}</span></p>` : '',
    x.syncError ? `<p class="ws-tdate-error" id="${errId}">${e(x.syncError)}</p>` : '',
  ].join('');
  // Folded, a row to review keeps its one control, Accept (its done box, as it were).
  const shown = open ? controls(x, group, p) : review ? controls(x, group, p).slice(0, 1) : [];
  const acts = shown.length ? `<div class="ws-tdate-acts">${shown.join('')}</div>` : '';
  const classes = ['ws-tdate-row', open && 'ws-tdate-open', x.due?.tone === 'late' && 'ws-tdate-late', x.syncError && 'ws-tdate-row-parked'].filter(Boolean).join(' ');
  return `<div class="${classes}" data-task="${id}"><div class="ws-tdate-line">${box}${main}</div>${notes}${acts}</div>`;
}

function section(key, title, body, tools = '') {
  return `<section class="ws-tdate-group ws-tdate-${key}" aria-labelledby="tdate-h-${key}">
    <header class="ws-tdate-head"><h2 id="tdate-h-${key}">${e(title)}</h2>${tools}</header>${body}</section>`;
}

/** Late ⋯: each item carries the tasks and the day the screen shows, so a page left open past
 *  midnight acts on what it says. */
function lateMenu(p, late) {
  if (!late.length) return '';
  const ids = JSON.stringify(late.map(r => r.id));
  const [[, tomorrow], [, monday]] = chipsFor('late', p);
  return `<details class="ws-menu ws-menu-right ws-tdate-menu" data-menu="tasks-late">
    <summary class="ws-btn ws-btn-ghost ws-btn-icon ws-btn-sm" aria-label="Late tasks: actions" title="Late tasks">${icon('dots')}</summary>
    <div class="ws-menu-panel">${item(['Move all to Tomorrow', 'tasks-late-move', { 'data-to': 'tomorrow', 'data-day': tomorrow, 'data-ids': ids }])}${item(['Move all to Monday', 'tasks-late-move', { 'data-to': 'monday', 'data-day': monday, 'data-ids': ids }])}${item(['Pick date…', 'tasks-late-move', { 'data-to': 'pick', 'data-ids': ids }])}<hr>${item(['Done all', 'tasks-late-done', { 'data-ids': ids }])}</div></details>`;
}

function fold(p, key, label, items) {
  const open = !!p.v.folds?.[key];
  const panel = `tdate-fold-${key}`;
  return `<div class="ws-tdate-fold">
    <button type="button" class="ws-tdate-fold-btn" data-action="tasks-fold" data-fold="${key}" aria-expanded="${open}" aria-controls="${panel}">${icon(open ? 'chevron-down' : 'chevron-right')}<span>${e(label)}</span><span class="ws-tdate-count">${items.length}</span></button>
    <div class="ws-tdate-rows" id="${panel}"${open ? '' : ' hidden'}>${open ? items.map(r => row(p, r, key)).join('') : ''}</div></div>`;
}

function footer(p, doneToday) {
  // The last action's Undo, while the provider it was made with is still the active one.
  const f = p.v.footer && p.v.footer.provider === activeProvider(p.s) ? p.v.footer : null;
  const last = f ? ` · <span>${e(f.text)}</span> · <button type="button" class="ws-link" data-action="tasks-undo">Undo</button>` : '';
  return `<p class="ws-tdate-foot" role="status"><span>${doneToday} done today</span>${last}</p>`;
}

/** By date for the page state `p` (`pageOf` in view-tasks.js): the active provider's tasks. */
export function datesView(p) {
  const g = dateGroups(p.all, { now: p.now, zone: p.zone, me: p.me });
  p = { ...p, providerName: p.s.taskProvider?.name || 'Connect' };
  const rows = (list, group) => `<div class="ws-tdate-rows">${list.map(r => row(p, r, group)).join('')}</div>`;
  const review = g.review.length
    ? section('review', `To review · ${g.review.length}`, rows(g.review, 'review'), g.review.length > 1 ? button('Accept all', { action: 'task-accept-all', size: 'sm', variant: 'primary' }) : '')
    : '';
  const late = section('late', g.late.length ? `Late · ${g.late.length}` : 'Late', g.late.length ? rows(g.late, 'late') : '<p class="ws-tdate-empty">Nothing late.</p>', lateMenu(p, g.late));
  const today = section('today', 'Today', g.today.length ? rows(g.today, 'today') : '<p class="ws-tdate-empty">Nothing for today.</p>');
  const folds = FOLDS.filter(([key]) => g[key].length).map(([key, label]) => fold(p, key, label, g[key])).join('');
  const later = folds ? section('later', 'Later', folds) : '';
  return `<div class="ws-tdate"${activeProvider(p.s) === 'local' ? '' : ' data-provider'}>
    ${banner(p.s.taskProvider)}
    <div class="ws-tdate-cols">
      <div class="ws-tdate-col">${review}${late}${today}</div>
      <div class="ws-tdate-col">${later}</div>
    </div>
    ${footer(p, g.doneToday.length)}
  </div>`;
}
