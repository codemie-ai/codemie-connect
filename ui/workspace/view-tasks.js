// Tasks (spec "Tasks page"): the board (To review · To do · In progress · Waiting · Done), the
// list (I owe · Owed to me · Nobody named), the filters, dismissed tasks and the task drawer.
// Pure: takes the snapshot and the page's view state (`ctx.state.tasks`) and returns HTML;
// tasks-controller.js handles the actions, drag and drop and the keyboard.
import { escapeHtml as e } from './store.js';
import { icon, teamsGlyph } from './icons.js';
import { avatar, badge, button, emptyState } from './ui.js';
import { addDaysToKey, agoLabel, dayKey, formatDate, formatDateTime, formatTime } from './format.js';
import {
  COLUMNS, DEFAULT_FILTERS, columnName, dueInfo, filterTasks, isMine, laneCounts, meOf, meetingOf, newTasksView, ownerOf, peopleFor, quickDates, quoteTime,
  sortTasks, splitDone, taskStatus, tasksOf, activeProvider,
} from './tasks-model.js';
import { shownView, statusLine, viewsFor } from './tasks-dates-model.js';
import { datesView } from './view-tasks-dates.js';

const TONES = { review: 'purple', todo: 'muted', doing: 'blue', waiting: 'amber', done: 'green' };
const BADGE = { review: 'purple', todo: 'neutral', doing: 'info', waiting: 'warning', done: 'success', dismissed: 'neutral' };
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const option = (value, label, selected) => `<option value="${e(value)}"${selected ? ' selected' : ''}>${e(label)}</option>`;
const selectBox = (attrs, options) => `<span class="ws-select-wrap"><select class="ws-select" ${attrs}>${options}</select>${icon('chevron-down', 'ws-select-caret')}</span>`;

/** Everything a render needs, computed once. */
function pageOf(s, ctx) {
  const v = { ...newTasksView(), ...(ctx.state?.tasks || {}) };
  v.filters = { ...DEFAULT_FILTERS, ...v.filters };
  v.shown = shownView(v, s);
  const now = ctx.now ?? Date.now();
  const zone = s.settings.timeZone;
  const me = meOf(s);
  const all = tasksOf(s);
  const meetings = new Map();
  const meeting = id => {
    if (!id) return null;
    if (!meetings.has(id)) meetings.set(id, meetingOf(s, id));
    return meetings.get(id);
  };
  const list = filterTasks(all, v.filters, me, now, { zone, meetingTitle: id => meeting(id)?.title || '' })
    .sort((a, b) => sortTasks(a, b, now, zone));
  return { s, v, now, zone, me, all, list, meeting, doneDays: s.settings.meetings?.doneDays ?? 14 };
}

export function tasksPage(s, ctx = {}) {
  const p = pageOf(s, ctx);
  return `<div class="ws-tasks">
    ${heading(p)}
    ${ctx.banners || ''}
    ${p.v.shown === 'dates' ? datesView(p) : `${toolbar(p)}${p.v.shown === 'list' ? listView(p) : boardView(p)}`}
    ${dismissed(p)}
  </div>${drawer(p)}`;
}

/** Tasks to review: with two or more, By date's "Accept all" is the page's one primary. */
const reviewCount = p => p.all.filter(r => taskStatus(r) === 'review').length;

/** What the page holds, said for the view shown (only the Board has cards to drag). */
const DESCRIPTIONS = {
  board: 'What people agreed to do in your meetings, and anything you add yourself. Drag cards between columns, or use a card’s menu.',
  list: 'What people agreed to do in your meetings, and anything you add yourself, by who owes it.',
  dates: 'What people agreed to do in your meetings, and anything you add yourself, by when it’s due.',
};

/** The header's ⋯ with a provider: Sync now and Settings › Tasks (design §9 "Header"). */
const moreMenu = () => `<details class="ws-menu ws-menu-right" data-menu="tasks-more">
      <summary class="ws-btn ws-btn-ghost ws-btn-icon" aria-label="More for Tasks" title="More">${icon('dots')}</summary>
      <div class="ws-menu-panel">${menuItem('tasks-sync', 'refresh', 'Sync now', {})}${menuItem('settings-tab', 'settings', 'Settings › Tasks', { 'data-tab': 'meetings-tasks' })}</div></details>`;

/** "From <meeting> ✕" while By date shows one meeting's tasks (its "N in Todoist ›"). */
function meetingChip(p) {
  const id = p.v.shown === 'dates' ? p.v.filters.meeting : '';
  if (!id) return '';
  const title = p.meeting(id)?.title || 'a meeting';
  return `<button type="button" class="ws-tasks-chip" data-action="tasks-meeting-clear" aria-label="Show the tasks of every meeting">From ${e(title)} ✕</button>`;
}

function heading(p) {
  // The status line is no live region: "synced <ago>" changes text on every redraw.
  const views = viewsFor(p.s);
  const provider = activeProvider(p.s) !== 'local';
  return `<header class="ws-page-heading ws-tasks-heading">
    <div><h1>Tasks</h1><p class="ws-description">${e(DESCRIPTIONS[p.v.shown] || DESCRIPTIONS.board)}</p>
      <div class="ws-tasks-status"><p class="ws-tasks-line">${e(statusLine(p.s.taskProvider, p.now, p.zone))}</p>${meetingChip(p)}</div></div>
    <div class="ws-actions">
      <div class="ws-segmented" role="tablist" aria-label="View">${views.map(([id, label, ico]) => `<button type="button" role="tab" data-action="tasks-view" data-view="${id}" aria-selected="${p.v.shown === id}">${icon(ico)}${label}</button>`).join('')}</div>
      ${button('New task', { action: 'task-new', variant: p.v.shown === 'dates' && reviewCount(p) > 1 ? 'secondary' : 'primary', iconName: 'plus' })}
      ${provider ? moreMenu() : ''}
    </div>
  </header>`;
}

// ---------------------------------------------------------------- filters

function toolbar(p) {
  const f = p.v.filters;
  const open = p.all.filter(r => taskStatus(r) !== 'dismissed');
  const counts = laneCounts(open, p.me);
  const lanes = [['all', 'Everyone'], ['me', 'I owe'], ['others', 'Owed to me'], ['nobody', 'Nobody named']];
  const people = new Map();
  for (const r of open) {
    const o = ownerOf(r, p.me);
    if (o.key && !o.mine && !people.has(o.key.toLowerCase())) people.set(o.key.toLowerCase(), [o.key, o.name]);
  }
  const persons = [...people.values()].sort((a, b) => a[1].localeCompare(b[1]));
  const mineKey = p.me.address || 'You';
  const meetings = [...new Set(open.map(r => r.data.meetingId).filter(Boolean))].map(p.meeting).filter(Boolean)
    .sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
  const overdue = filterTasks(open, { due: 'overdue' }, p.me, p.now, { zone: p.zone }).length;
  const any = f.who !== 'all' || f.person || f.meeting || f.due !== 'any' || f.q;
  return `<div class="ws-tasks-toolbar">
    <div class="ws-lanes" role="tablist" aria-label="Whose tasks">${lanes.map(([who, label]) => `<button type="button" role="tab" class="ws-lane" data-action="tasks-who" data-who="${who}" aria-selected="${f.who === who}">${label}<span class="ws-count">${counts[who]}</span></button>`).join('')}</div>
    <div class="ws-tasks-filters">
      ${selectBox('data-action="tasks-filter" data-filter="person" aria-label="Person"', `${option('', 'Any person', !f.person)}${option(mineKey, 'Me', f.person && isMine({ owner: f.person }, p.me))}${persons.map(([key, name]) => option(key, name, f.person.toLowerCase() === key.toLowerCase())).join('')}`)}
      ${selectBox('data-action="tasks-filter" data-filter="meeting" aria-label="Meeting"', `${option('', 'Any meeting', !f.meeting)}${meetings.map(m => option(m.id, `${m.title}${m.start ? ` · ${formatDate(m.start, p.zone)}` : ''}`, f.meeting === m.id)).join('')}`)}
      ${selectBox('data-action="tasks-filter" data-filter="due" aria-label="Due"', [['any', 'Any due date'], ['overdue', `Overdue${overdue ? ` (${overdue})` : ''}`], ['week', 'Due this week'], ['none', 'No due date']].map(([v, l]) => option(v, l, f.due === v)).join(''))}
      <label class="ws-search ws-tasks-search">${icon('search')}<input id="tasks-search" type="search" value="${e(f.q)}" placeholder="Search tasks" aria-label="Search tasks" autocomplete="off"></label>
      ${any ? button('Clear filters', { action: 'tasks-clear', variant: 'ghost', size: 'sm', iconName: 'close' }) : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- board

function boardView(p) {
  const showReview = p.s.settings.meetings?.review !== false || p.all.some(r => taskStatus(r) === 'review');
  const columns = COLUMNS.filter(c => c !== 'review' || showReview);
  return `<div class="ws-task-board" data-board style="--cols:${columns.length}">${columns.map(c => column(p, c)).join('')}</div>`;
}

function column(p, c) {
  let items = p.list.filter(r => taskStatus(r) === c);
  let older = 0;
  if (c === 'done') {
    const split = splitDone(items, p.doneDays, p.now);
    older = split.older.length;
    if (!p.v.showOlder) items = split.shown;
  }
  const name = columnName(c, p.s.settings);
  const review = c === 'review';
  const adding = p.v.quickAdd === c && !review;
  const empty = review ? 'Nothing to review. New tasks from notes land here.' : c === 'waiting' ? 'Tasks blocked on someone else.' : 'Drop cards here';
  return `<section class="ws-task-col${review ? ' ws-task-col-review' : ''}" data-col="${c}" style="--col:var(--ws-${TONES[c]})" aria-label="${e(name)}">
    <header class="ws-task-col-head">
      <span class="ws-task-col-dot" aria-hidden="true"></span><h2>${e(name)}</h2><span class="ws-task-col-count" aria-label="${plural(items.length, 'task')}">${items.length}</span>
      <span class="ws-spacer"></span>
      ${!review ? button('', { action: 'task-quick', iconName: 'plus', variant: 'ghost', size: 'sm', title: `Add a task to ${name}`, attrs: { 'data-col': c } }) : ''}
    </header>
    ${review ? `<p class="ws-task-col-note">${icon('sparkles')}<span>Found in meeting notes. Check the owner and date, then accept.</span></p>` : ''}
    <div class="ws-task-col-body"${review ? '' : ` data-drop="${c}"`}>
      ${items.map(r => taskCard(p, r)).join('')}
      ${!items.length && !adding ? `<div class="ws-task-col-empty">${e(empty)}</div>` : ''}
      ${adding ? quickForm(p, c, name) : ''}
      ${older ? `<button type="button" class="ws-task-col-more" data-action="tasks-older">${icon('history')}<span>${p.v.showOlder ? 'Hide older done tasks' : `Show ${plural(older, 'older done task')}`}</span></button>` : ''}
    </div>
    ${!review && !adding ? `<button type="button" class="ws-task-col-add" data-action="task-quick" data-col="${c}">${icon('plus')}<span>Add a task</span></button>` : ''}
    ${review && items.length > 1 ? `<button type="button" class="ws-task-col-add" data-action="task-accept-all">${icon('check')}<span>Accept all ${items.length}</span></button>` : ''}
  </section>`;
}

const face = (owner, size) => (owner.key
  ? avatar({ name: owner.name, size, seed: owner.seed || owner.key })
  : `<span class="ws-task-nobody" style="--size:${size}px" aria-hidden="true">${icon('user')}</span>`);

/** Where a task came from, when its meeting isn't in the snapshot (signed out, calendar off). */
const origin = d => (d.meetingId ? 'From a meeting' : d.sourceId ? 'From a message' : 'Added by you');

const dueChip = info => (info ? `<span class="ws-due ws-due-${info.tone}" title="${e(info.title)}">${icon('calendar')}${e(info.text)}</span>` : '');

function menuItem(action, iconName, label, attrs, danger = false) {
  const extra = Object.entries(attrs).map(([k, v]) => ` ${k}="${e(v)}"`).join('');
  return `<button type="button" class="ws-menu-item${danger ? ' ws-menu-danger' : ''}" data-action="${action}"${extra}>${icon(iconName)}<span>${e(label)}</span></button>`;
}

function taskCard(p, r) {
  const d = r.data;
  const id = r.id;
  const status = taskStatus(r);
  const review = status === 'review';
  const done = status === 'done';
  const m = p.meeting(d.meetingId);
  const due = done ? null : dueInfo(d.due, p.now, p.zone);
  const owner = ownerOf(r, p.me);
  const classes = ['ws-task', review && 'ws-task-review', done && 'ws-task-done', due?.tone === 'overdue' && 'ws-task-overdue', p.v.drawer === id && 'ws-task-open'].filter(Boolean).join(' ');
  const when = m?.start ? formatDate(m.start, p.zone) : '';
  const source = m
    ? `<button type="button" class="ws-task-src" data-action="task-open-meeting" data-id="${e(m.id)}" title="${e(`${m.title}${when ? ` · ${when}` : ''}`)}">${teamsGlyph}<span>${e(m.title)}</span>${when ? `<em>${e(when)}</em>` : ''}</button>`
    : `<span class="ws-task-src ws-task-src-own">${d.meetingId ? teamsGlyph : icon(d.sourceId ? 'mail' : 'edit')}<span>${origin(d)}</span></span>`;
  const moves = COLUMNS.filter(c => c !== status && c !== 'review')
    .map(c => menuItem('task-move', 'arrow', columnName(c, p.s.settings), { 'data-id': id, 'data-col': c })).join('');
  const menu = `<details class="ws-menu ws-menu-right ws-task-menu" data-menu="task-${e(id)}">
      <summary class="ws-btn ws-btn-ghost ws-btn-icon ws-btn-sm" data-menu-trigger="${e(id)}" aria-label="Actions for “${e(d.text)}”" title="Task actions">${icon('dots')}</summary>
      <div class="ws-menu-panel"><div class="ws-menu-label">Move to</div>${moves}<hr>
        ${menuItem('task-edit', 'edit', 'Edit…', { 'data-id': id })}
        ${m ? menuItem('task-open-meeting', 'video', 'Open the meeting', { 'data-id': m.id }) : ''}
        ${m && d.quote ? menuItem('task-quote', 'quote', 'Show where it was said', { 'data-id': id }) : ''}
        <hr>${menuItem('task-delete', 'trash', 'Delete', { 'data-id': id }, true)}
      </div></details>`;
  return `<article class="${classes}" draggable="true" data-task="${e(id)}" aria-label="${e(d.text)}">
    <div class="ws-task-top">${source}<span class="ws-task-tools">${!review && !done ? `<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon ws-task-check" data-action="task-done" data-id="${e(id)}" title="Mark as done" aria-label="Mark “${e(d.text)}” as done">${icon('check')}</button>` : ''}${menu}</span></div>
    <button type="button" class="ws-task-title" data-action="task-open" data-id="${e(id)}">${done ? icon('check-circle', 'ws-task-done-icon') : ''}<span>${e(d.text)}</span></button>
    ${review && d.confidence === 'low' ? `<span class="ws-task-low">${icon('alert')}Check the owner</span>` : ''}
    ${review && d.quote ? `<p class="ws-task-said" title="${e(d.quote)}">“${e(d.quote)}”</p>` : ''}
    <div class="ws-task-foot">
      <span class="ws-task-owner" title="${e(owner.name)}">${face(owner, 20)}<span>${e(owner.first)}</span></span>
      ${dueChip(due)}
      ${!review && d.quote ? `<span class="ws-task-mark" title="${e(`“${d.quote}”`)}">${icon('quote')}</span>` : ''}
      ${d.notes ? `<span class="ws-task-mark" title="Has notes">${icon('note')}</span>` : ''}
    </div>
    ${review ? `<div class="ws-task-actions">${button('Dismiss', { action: 'task-dismiss', variant: 'ghost', size: 'sm', iconName: 'close', attrs: { 'data-id': id } })}${button('Accept', { action: 'task-accept', variant: 'primary', size: 'sm', iconName: 'check', attrs: { 'data-id': id } })}</div>` : ''}
  </article>`;
}

/** The owner choices: the meeting's people first when there is a meeting, then everyone else. */
function ownerOptions(p, task, { nobody = 'Nobody named', selected } = {}) {
  const people = peopleFor(p.s, task, p.me);
  const current = String(selected ?? task?.data?.owner ?? '').trim().toLowerCase();
  const mine = task?.data && isMine(task, p.me);
  const pick = person => (person.me ? mine || (!task?.data && current === person.key.toLowerCase()) : current === person.key.toLowerCase());
  const label = person => (person.me ? `${person.name || 'Me'} (you)` : person.name);
  const opts = list => list.map(person => option(person.key, label(person), pick(person))).join('');
  const none = option('', nobody, !current);
  if (!people.meeting.length) return `${none}${opts(people.others)}`;
  return `${none}<optgroup label="In this meeting">${opts(people.meeting)}</optgroup><optgroup label="Everyone else">${opts(people.others)}</optgroup>`;
}

function quickForm(p, c, name) {
  const mineKey = p.me.address || 'You';
  return `<form class="ws-task-quick" data-form="task-quick" data-col="${c}">
    <textarea class="ws-textarea" name="text" rows="2" maxlength="2000" required placeholder="What needs doing?" aria-label="New task in ${e(name)}"></textarea>
    <div class="ws-task-quick-row">
      ${selectBox('name="owner" aria-label="Owner"', ownerOptions(p, null, { nobody: 'Nobody yet', selected: mineKey }))}
      <input type="date" class="ws-input" name="due" aria-label="Due date">
    </div>
    <div class="ws-task-quick-row">${button('Cancel', { action: 'task-quick-cancel', variant: 'ghost', size: 'sm' })}<span class="ws-spacer"></span>${button('Add task', { type: 'submit', variant: 'primary', size: 'sm' })}</div>
  </form>`;
}

function dismissed(p) {
  const items = p.all.filter(r => taskStatus(r) === 'dismissed').sort((a, b) => b.updatedAt - a.updatedAt);
  if (!items.length) return '';
  if (!p.v.showDismissed) return `<div class="ws-task-dismissed"><button type="button" class="ws-link ws-task-dismissed-toggle" data-action="tasks-dismissed">${icon('archive')}<span>${plural(items.length, 'dismissed task')}</span></button></div>`;
  const rows = items.map(r => {
    const m = p.meeting(r.data.meetingId);
    return `<div class="ws-task-dismissed-row"><span>${e(r.data.text)}</span><small class="ws-muted">${e(m ? m.title : origin(r.data))}</small>${button('Restore', { action: 'task-restore', size: 'sm', variant: 'ghost', iconName: 'undo', attrs: { 'data-id': r.id } })}</div>`;
  }).join('');
  return `<div class="ws-task-dismissed"><section class="ws-card ws-task-dismissed-list"><header class="ws-card-header"><h2 class="ws-card-title"><span class="ws-card-icon">${icon('archive')}</span>Dismissed</h2>${button('Hide', { action: 'tasks-dismissed', variant: 'ghost', size: 'sm' })}</header><div class="ws-card-body">${rows}</div></section></div>`;
}

// ---------------------------------------------------------------- list

function listView(p) {
  let list = p.list;
  const done = list.filter(r => taskStatus(r) === 'done');
  const { older } = splitDone(done, p.doneDays, p.now);
  if (!p.v.showOlder && older.length) list = list.filter(r => !older.includes(r));
  const groups = [
    ['I owe', r => isMine(r, p.me)],
    ['Owed to me', r => String(r.data.owner || '').trim() && !isMine(r, p.me)],
    ['Nobody named', r => !String(r.data.owner || '').trim()],
  ];
  const sections = groups.map(([label, test]) => {
    const items = list.filter(test).sort((a, b) => (taskStatus(a) === 'done') - (taskStatus(b) === 'done') || sortTasks(a, b, p.now, p.zone));
    if (!items.length) return '';
    return `<section class="ws-card ws-task-group"><header class="ws-card-header"><h2 class="ws-card-title">${e(label)}<span class="ws-tab-count">${items.length}</span></h2></header>
      <div class="ws-task-table" role="table" aria-label="${e(label)}">
        <div class="ws-task-row ws-task-row-head" role="row"><span role="columnheader"><span class="ws-sr">Done</span></span><span role="columnheader">Task</span><span role="columnheader">Owner</span><span role="columnheader">Due</span><span role="columnheader">From</span><span role="columnheader">Status</span></div>
        ${items.map(r => listRow(p, r)).join('')}
      </div></section>`;
  }).join('');
  const more = older.length ? `<button type="button" class="ws-task-col-more ws-task-list-more" data-action="tasks-older">${icon('history')}<span>${p.v.showOlder ? 'Hide older done tasks' : `Show ${plural(older.length, 'older done task')}`}</span></button>` : '';
  if (sections) return `<div class="ws-task-list">${sections}${more}</div>`;
  const f = p.v.filters;
  const filtered = f.who !== 'all' || f.person || f.meeting || f.due !== 'any' || f.q;
  return `<section class="ws-card ws-task-empty">${emptyState(filtered
    ? { iconName: 'tasks', title: 'No tasks match', text: 'Clear the filters to see everything.', actions: button('Clear filters', { action: 'tasks-clear' }) }
    : { iconName: 'tasks', title: 'No tasks yet', text: 'Add one with New task, or from any Inbox message. Tasks found in meeting notes appear here too.', actions: button('New task', { action: 'task-new', variant: 'primary', iconName: 'plus' }) })}${more}</section>`;
}

function listRow(p, r) {
  const d = r.data;
  const id = e(r.id);
  const status = taskStatus(r);
  const done = status === 'done';
  const owner = ownerOf(r, p.me);
  const m = p.meeting(d.meetingId);
  const due = dueInfo(d.due, p.now, p.zone);
  // A provider has no lanes: To do, Waiting and Done (and the task's own status, to show it).
  const statuses = activeProvider(p.s) === 'local' ? COLUMNS.filter(c => c !== 'review' || status === 'review')
    : COLUMNS.filter(c => ['todo', 'waiting', 'done'].includes(c) || c === status);
  return `<div class="ws-task-row${done ? ' ws-task-row-done' : ''}${!done && due?.tone === 'overdue' ? ' ws-task-row-overdue' : ''}" role="row">
    <span role="cell"><label class="ws-check"><input type="checkbox" data-action="task-done" data-id="${id}"${done ? ' checked' : ''} aria-label="${done ? 'Reopen' : 'Mark as done'}: ${e(d.text)}"><span class="ws-check-box" aria-hidden="true">${icon('check')}</span></label></span>
    <span role="cell" class="ws-task-row-title"><button type="button" class="ws-link-title" data-action="task-open" data-id="${id}">${e(d.text)}</button>${status === 'review' ? badge('To review', 'purple') : ''}</span>
    <span role="cell" class="ws-task-row-owner" title="${e(owner.name)}">${face(owner, 20)}<span>${e(owner.mine ? 'Me' : owner.key ? owner.name : 'Nobody')}</span></span>
    <span role="cell">${done ? `<small class="ws-muted">${due ? e(formatDate(`${d.due}T12:00:00`, undefined)) : '—'}</small>` : dueChip(due) || '<small class="ws-muted">—</small>'}</span>
    <span role="cell" class="ws-task-row-from">${m ? `<button type="button" class="ws-link" data-action="task-open-meeting" data-id="${e(m.id)}">${e(m.title)}${m.start ? ` · ${e(formatDate(m.start, p.zone))}` : ''}</button>` : `<small class="ws-muted">${origin(d)}</small>`}</span>
    <span role="cell">${selectBox(`data-action="task-status" data-id="${id}" aria-label="Status of ${e(d.text)}"`, statuses.map(c => option(c, columnName(c, p.s.settings), c === status)).join(''))}</span>
  </div>`;
}

// ---------------------------------------------------------------- drawer

function dayLabel(value, zone, now) {
  const key = dayKey(value, zone);
  const today = dayKey(now, zone);
  if (key === today) return 'Today';
  if (key === addDaysToKey(today, -1)) return 'Yesterday';
  if (key === addDaysToKey(today, 1)) return 'Tomorrow';
  return formatDate(value, zone, { weekday: 'short', month: 'short', day: 'numeric' });
}

function drawer(p) {
  const r = p.v.drawer && p.all.find(x => x.id === p.v.drawer);
  if (!r) return '';
  const d = r.data;
  const id = e(r.id);
  const status = taskStatus(r);
  const review = status === 'review';
  const low = d.confidence === 'low';
  const owner = ownerOf(r, p.me);
  const m = p.meeting(d.meetingId);
  const info = dueInfo(d.due, p.now, p.zone);
  const reviewBox = review ? `<div class="ws-task-review-box">${icon('sparkles')}<div><strong>Found in the notes${low ? ' — owner unsure' : ''}</strong><p>${low ? 'The transcript doesn’t say clearly who takes this. Check the owner before you accept.' : 'Check the owner and the date, then accept it onto the board.'}</p></div><div class="ws-actions">${button('Dismiss', { action: 'task-dismiss', variant: 'ghost', size: 'sm', attrs: { 'data-id': r.id } })}${button('Accept', { action: 'task-accept', variant: 'primary', size: 'sm', iconName: 'check', attrs: { 'data-id': r.id } })}</div></div>` : '';
  const statuses = ['todo', 'doing', 'waiting', 'done'].map(c => `<button type="button" data-action="task-move" data-id="${id}" data-col="${c}" aria-pressed="${status === c}">${e(columnName(c, p.s.settings))}</button>`).join('');
  const picks = [...quickDates(p.now, p.zone), ...(d.due ? [['No date', '']] : [])]
    .map(([label, day]) => `<button type="button" class="ws-task-chip" data-action="task-due-pick" data-id="${id}" data-value="${day}">${label}</button>`).join('');
  // The transcript line, while the meeting is there to open.
  const link = m && ((d.line !== null && d.line !== undefined) || Number.isFinite(d.quoteAt))
    ? `<a class="ws-link" href="#/meetings/${e(encodeURIComponent(m.id))}/transcript" data-action="task-quote" data-id="${id}">${Number.isFinite(d.quoteAt) ? `${quoteTime(d.quoteAt)} into the meeting — show in transcript` : 'Show in transcript'}</a>` : '';
  const said = d.quote ? `<figure class="ws-task-quote">${d.speaker ? avatar({ name: d.speaker, size: 28 }) : `<span class="ws-task-nobody" style="--size:28px" aria-hidden="true">${icon('quote')}</span>`}<blockquote><p>“${e(d.quote)}”</p>${d.speaker || link ? `<figcaption>${d.speaker ? `${e(d.speaker)}${link ? ' · ' : ''}` : ''}${link}</figcaption>` : ''}</blockquote></figure>` : '';
  let source = '';
  if (d.meetingId) {
    source = `<section class="ws-task-source"><span class="ws-field-label">From the meeting</span>
      ${m ? `<button type="button" class="ws-task-source-meeting" data-action="task-open-meeting" data-id="${e(m.id)}">${teamsGlyph}<span><strong>${e(m.title)}</strong>${m.start ? `<small>${e(dayLabel(m.start, p.zone, p.now))} · ${e(formatTime(m.start, p.zone))}</small>` : ''}</span>${icon('chevron-right')}</button>` : '<p class="ws-muted ws-hint">This meeting is no longer in your calendar.</p>'}
      ${said}</section>`;
  } else if (d.sourceId) {
    const message = p.s.records.find(x => x.kind === 'message' && x.id === d.sourceId);
    source = `<section class="ws-task-source"><span class="ws-field-label">From a message</span>${d.quote ? `<blockquote class="ws-quote">${e(String(d.quote).slice(0, 400))}</blockquote>` : ''}${message ? button('Open in Inbox', { action: 'task-open-message', variant: 'ghost', size: 'sm', iconName: 'inbox', attrs: { 'data-id': message.id } }) : ''}</section>`;
  }
  const history = (Array.isArray(d.history) ? d.history : []).slice().reverse()
    .map(h => `<li><span>${e(h.text)}</span><small title="${e(formatDateTime(h.at, p.zone))}">${e(agoLabel(h.at, p.zone, p.now))}</small></li>`).join('');
  return `<div class="ws-task-scrim" data-action="task-close" aria-hidden="true"></div>
  <aside class="ws-task-drawer" role="dialog" aria-modal="false" aria-label="Task details">
    <header class="ws-task-drawer-head">
      ${badge(columnName(status, p.s.settings), BADGE[status], review ? 'sparkles' : undefined)}
      <span class="ws-spacer"></span>
      ${button('', { action: 'task-delete', iconName: 'trash', variant: 'ghost', title: 'Delete task', attrs: { 'data-id': r.id } })}
      ${button('', { action: 'task-close', iconName: 'close', variant: 'ghost', title: 'Close' })}
    </header>
    <div class="ws-task-drawer-body">
      <textarea class="ws-task-drawer-title" data-change="task-title" data-id="${id}" rows="2" maxlength="2000" aria-label="Task">${e(d.text)}</textarea>
      ${reviewBox}
      <div class="ws-task-fields">
        <span class="ws-task-field-label">Status</span>
        <div class="ws-segmented ws-task-status" role="group" aria-label="Status">${statuses}</div>
        <span class="ws-task-field-label">Owner</span>
        <span class="ws-task-owner-field">${face(owner, 24)}${selectBox(`data-action="task-owner" data-id="${id}" aria-label="Owner"`, ownerOptions(p, r))}</span>
        <span class="ws-task-field-label">Due</span>
        <div class="ws-task-due-field"><input type="date" class="ws-input" data-commit="task-due" data-id="${id}" value="${e(d.due || '')}" aria-label="Due date">${dueChip(status === 'done' ? null : info)}<div class="ws-task-due-quick">${picks}</div></div>
      </div>
      <label class="ws-field"><span class="ws-field-label">Notes</span><textarea class="ws-textarea" rows="3" maxlength="20000" data-change="task-notes" data-id="${id}" placeholder="Links, context, what “done” means…">${e(d.notes || '')}</textarea></label>
      ${source}
      ${history ? `<section class="ws-task-history"><span class="ws-field-label">History</span><ol>${history}</ol></section>` : ''}
    </div>
    <footer class="ws-task-drawer-foot"><small>${icon('check-circle')}<span>Changes save as you go${m ? ' and update tasks.json in the meeting folder' : ''}.</span></small></footer>
  </aside>`;
}
