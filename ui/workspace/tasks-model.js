// Tasks (spec "Tasks page"): pure helpers for the board, the list and the drawer. A task is a
// `commitment` record; its body is described in src-tauri/src/workspace/tasks.rs.
import { addDaysToKey, dateFromKey, dayKey, formatDate } from './format.js';

/** Every status a task can have; the first five are the board's columns. */
export const STATUSES = ['review', 'todo', 'doing', 'waiting', 'done', 'dismissed'];
export const COLUMNS = ['review', 'todo', 'doing', 'waiting', 'done'];
export const COLUMN_NAMES = { review: 'To review', todo: 'To do', doing: 'In progress', waiting: 'Waiting', done: 'Done', dismissed: 'Dismissed' };
/** Statuses of a task someone still has to do. */
export const OPEN = ['review', 'todo', 'doing', 'waiting'];
export const DEFAULT_FILTERS = Object.freeze({ who: 'all', person: '', meeting: '', due: 'any', q: '' });

/** The Tasks page's view state (only view state lives in the window: the tasks are native's). */
export const newTasksView = (view = 'board') => ({
  view: view === 'list' ? 'list' : 'board', filters: { ...DEFAULT_FILTERS }, drawer: null, quickAdd: null, showDismissed: false, showOlder: false,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const bodyOf = task => task?.data ?? task ?? {};
const lower = v => String(v ?? '').trim().toLowerCase();

export const tasksOf = s => s.records.filter(r => r.kind === 'commitment');

/** A column's name: the one set in Settings › Meetings › Tasks, or the built-in one. */
export function columnName(status, settings) {
  const own = status !== 'dismissed' && settings?.meetings?.columns?.[status];
  return (typeof own === 'string' && own.trim()) || COLUMN_NAMES[status] || status;
}

/** A task's status; a commitment from before the board reads as `done` or `todo`. */
export function taskStatus(record) {
  const d = bodyOf(record);
  if (STATUSES.includes(d.status)) return d.status;
  return d.done ? 'done' : 'todo';
}

/** Who "me" is: the signed-in account's name and address (no account: only "You" is me). */
export function meOf(s) {
  const c = s?.connection;
  return { name: c?.displayName || '', aliases: [], address: c?.email || null };
}

/** Whether a task is mine: its owner is my address, my name or an alias, or "You" (any case).
 *  Rust's `tasks::is_mine` is the same rule. `task` is a record or a body. */
export function isMine(task, me) {
  const owner = lower(bodyOf(task).owner);
  if (!owner) return false;
  if (me?.address && lower(me.address) === owner) return true;
  if ([me?.name, ...(me?.aliases || [])].some(n => lower(n) && lower(n) === owner)) return true;
  return owner === 'you';
}

const looksLikeAddress = v => /^[^@\s]+@[^@\s]+$/.test(v);

/** The people a task can be given to: the meeting's organizer and attendees first (me among
 *  them), then everyone else on the board and in those meetings, me included. `{key, name, me}`. */
export function peopleFor(s, task, me) {
  const seen = new Set();
  const person = (key, name) => {
    const k = String(key || '').trim();
    if (!k || seen.has(k.toLowerCase())) return null;
    seen.add(k.toLowerCase());
    const mine = isMine({ owner: k }, me);
    return { key: k, name: mine && me?.name ? me.name : String(name || '').trim() || k, me: mine };
  };
  const meKey = me?.address || 'You';
  const attendees = meetingId => {
    const ev = s.records.find(r => r.kind === 'event' && r.id === meetingId);
    return ev ? [ev.data.organizer, ...(ev.data.attendees || [])].filter(p => p?.address) : [];
  };
  const meetingId = bodyOf(task).meetingId;
  const inMeeting = meetingId ? attendees(meetingId).map(p => person(p.address, p.name)).filter(Boolean) : [];
  const all = tasksOf(s);
  const others = [
    person(meKey, me?.name),
    ...all.filter(r => !isMine(r, me) && lower(r.data.owner)).map(r => person(r.data.owner, r.data.ownerName)),
    ...[...new Set(all.map(r => r.data.meetingId).filter(Boolean))].flatMap(attendees).map(p => person(p.address, p.name)),
  ].filter(Boolean);
  const current = bodyOf(task).owner && !isMine(task, me) ? person(bodyOf(task).owner, bodyOf(task).ownerName) : null;
  if (current) others.push(current);
  others.sort((a, b) => (b.me - a.me) || a.name.localeCompare(b.name));
  return { meeting: inMeeting, others };
}

/** The name to show for an owner key (an address or free text), from the people Connect knows. */
export function personName(s, key, me) {
  if (!key) return null;
  if (isMine({ owner: key }, me)) return me?.name || null;
  const k = lower(key);
  const owned = tasksOf(s).find(r => lower(r.data.owner) === k && r.data.ownerName);
  if (owned) return owned.data.ownerName;
  for (const ev of s.records.filter(r => r.kind === 'event')) {
    const p = [ev.data.organizer, ...(ev.data.attendees || [])].find(x => lower(x?.address) === k);
    if (p?.name) return p.name;
  }
  return looksLikeAddress(key) ? null : key;
}

/** How a task's owner is shown: `{key, name, first, mine, seed}` (`seed` colours the avatar, the
 *  same for every way of saying "me"); `key` empty for nobody. */
export function ownerOf(task, me) {
  const d = bodyOf(task);
  const key = String(d.owner || '').trim();
  if (!key) return { key: '', name: 'Nobody named', first: 'Nobody', mine: false, seed: '' };
  if (isMine(d, me)) return { key, name: me?.name || 'You', first: 'You', mine: true, seed: me?.address || me?.name || 'You' };
  const name = String(d.ownerName || '').trim() || (looksLikeAddress(key) ? key.split('@')[0] : key);
  const first = name.includes(',') ? name.split(',')[1].trim().split(/\s+/)[0] : name.split(/\s+/)[0];
  return { key, name, first: first || name, mine: false, seed: key.toLowerCase() };
}

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const daysBetween = (from, to) => Math.round((dateFromKey(to) - dateFromKey(from)) / DAY_MS);

/** A due date as a chip, relative to today in the workspace `zone`: `{tone, text, title}` with
 *  tone `overdue`, `today`, `soon` (within six days) or `later`; null without a date. */
export function dueInfo(due, now = Date.now(), zone) {
  if (!DATE.test(String(due || '')) || Number.isNaN(dateFromKey(due).getTime()) || dateFromKey(due).getMonth() + 1 !== Number(due.slice(5, 7))) return null;
  const d = daysBetween(dayKey(now, zone), due);
  const date = dateFromKey(due);
  const short = formatDate(date, undefined, { month: 'short', day: 'numeric' });
  if (d < 0) return { tone: 'overdue', text: d === -1 ? 'Yesterday' : short, title: `Overdue by ${plural(-d, 'day')}` };
  if (d === 0) return { tone: 'today', text: 'Today', title: 'Due today' };
  if (d === 1) return { tone: 'soon', text: 'Tomorrow', title: 'Due tomorrow' };
  if (d < 7) return { tone: 'soon', text: formatDate(date, undefined, { weekday: 'short' }), title: `Due ${short}` };
  return { tone: 'later', text: short, title: `Due ${short}` };
}

/** Quick picks for a due date: Today, Tomorrow, the next Friday and next week's Monday. */
export function quickDates(now = Date.now(), zone) {
  const today = dayKey(now, zone);
  const weekday = dateFromKey(today).getDay();
  return [
    ['Today', today],
    ['Tomorrow', addDaysToKey(today, 1)],
    ['Friday', addDaysToKey(today, (5 - weekday + 7) % 7 || 7)],
    ['Next week', addDaysToKey(today, 7 - ((weekday + 6) % 7))],
  ];
}

/** Seconds into the meeting as `m:ss` or `h:mm:ss`. */
export function quoteTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const t = Math.floor(seconds);
  const pad = n => String(n).padStart(2, '0');
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
}

/** Where a task sits in its column; a commitment from before the board by when it changed. */
// ---------------------------------------------------------------- previews

/** Copies `snapshot` with the task `id` replaced by `next(task)`; null when it isn't there. */
function withTask(snapshot, id, next) {
  const i = id ? snapshot.records.findIndex(r => r.kind === 'commitment' && r.id === id) : -1;
  if (i < 0) return null;
  const records = snapshot.records.slice();
  const task = next(records[i]);
  if (task) records[i] = task;
  else records.splice(i, 1);
  return { ...snapshot, records };
}

/**
 * What `task_save` does, shown before native has it (the store lays it over the snapshot until
 * the snapshot after the write lands): a task on the board gets its text, notes, owner, due
 * date, order and column, with the done flag and time as tasks.rs `task_save` sets them; a new
 * one (a quick add, Undo of a delete) appears under the id native gives it, `data.id` or else
 * the write's operation id, at the end of its column. Times are seconds, as native's.
 */
export function previewTaskSave(snapshot, data, { operationId = null, now = Date.now() } = {}) {
  const id = data?.id || operationId;
  if (!id) return null;
  const known = snapshot.records.some(r => r.kind === 'commitment' && r.id === id);
  return known ? withTask(snapshot, id, task => saved(task, data, now)) : created(snapshot, id, data, now);
}

function created(snapshot, id, data, now) {
  const { id: _id, kind: _kind, log: _log, ...fields } = data;
  const text = typeof fields.text === 'string' ? fields.text.trim() : '';
  if (!text) return null;
  const status = STATUSES.includes(fields.status) ? fields.status : fields.done ? 'done' : 'todo';
  const sec = Math.floor(now / 1000);
  const given = Number(fields.order);
  const order = fields.order !== null && fields.order !== undefined && Number.isFinite(given)
    ? given
    : Math.max(sec, ...snapshot.records.filter(r => r.kind === 'commitment').map(taskOrder)) + 1;
  const task = {
    id, kind: 'commitment', connectionId: null, workspaceId: snapshot.settings?.activeWorkspace ?? null, source: 'local', revision: 'preview', updatedAt: sec,
    data: { ...fields, text, status, done: status === 'done', doneAt: status === 'done' ? fields.doneAt ?? sec : null, order, createdAt: fields.createdAt ?? sec },
  };
  return { ...snapshot, records: [task, ...snapshot.records] };
}

function saved(task, data, now) {
  const d = { ...task.data };
  const has = key => Object.hasOwn(data, key);
  if (has('text') && typeof data.text === 'string' && data.text.trim()) d.text = data.text.trim();
  for (const key of ['notes', 'owner', 'ownerName', 'due', 'order']) if (has(key)) d[key] = data[key];
  if (has('owner') && (data.owner ?? null) !== (task.data.owner ?? null) && !has('ownerName')) d.ownerName = null;
  const before = taskStatus(task);
  const status = has('status') ? data.status : has('done') ? (data.done ? 'done' : before === 'done' ? 'todo' : before) : before;
  if (!STATUSES.includes(status)) return task;
  const sec = Math.floor(now / 1000);
  d.status = status;
  d.done = status === 'done';
  d.doneAt = status !== 'done' ? null : before === 'done' ? task.data.doneAt ?? sec : sec;
  return { ...task, data: d };
}

/** What `task_delete` does, shown before native has it: the task is gone. */
export const previewTaskDelete = (snapshot, data) => withTask(snapshot, data?.id, () => null);

export function taskOrder(record) {
  const o = Number(record?.data?.order);
  return Number.isFinite(o) && record?.data?.order !== null ? o : Number(record?.updatedAt) || 0;
}

const overdue = (r, now, zone) => taskStatus(r) !== 'done' && dueInfo(r.data.due, now, zone)?.tone === 'overdue';

/** Board order: overdue cards first (except in Done), then by `order`. */
export function sortTasks(a, b, now = Date.now(), zone) {
  const oa = overdue(a, now, zone);
  const ob = overdue(b, now, zone);
  if (oa !== ob) return oa ? -1 : 1;
  return taskOrder(a) - taskOrder(b) || String(a.id).localeCompare(String(b.id));
}

/** The order for a card dropped between `before` (the order of the card above, or null at the
 *  top) and `after` (the card below, or null at the end). */
export function orderBetween(before, after) {
  const has = v => v !== null && v !== undefined && Number.isFinite(Number(v));
  if (has(before) && has(after)) return (Number(before) + Number(after)) / 2;
  if (has(before)) return Number(before) + 1;
  if (has(after)) return Number(after) - 1;
  return 0;
}

/** When a done task was done (a commitment from before the board: when it last changed), ms. */
export const doneAt = r => (Number(r.data.doneAt) || Number(r.updatedAt) || 0) * 1000;

/** Done tasks split into those done in the last `doneDays` days and the older ones. */
export function splitDone(records, doneDays = 14, now = Date.now()) {
  const cutoff = now - Math.max(1, Number(doneDays) || 14) * DAY_MS;
  const shown = [];
  const older = [];
  for (const r of records) (doneAt(r) >= cutoff ? shown : older).push(r);
  return { shown, older };
}

/** The end of this week (Sunday) as a day key. */
const weekEnd = today => addDaysToKey(today, (7 - dateFromKey(today).getDay()) % 7);

/**
 * The tasks on the board (dismissed ones never are) that match the filters: `who` (`all`, `me`,
 * `others`, `nobody`), `person` (an owner key), `meeting` (a meeting id), `due` (`any`,
 * `overdue`, `week` (until Sunday, overdue included), `none`) and `q` (the task, its notes and
 * quote, its owner's name and its meeting's title via `meetingTitle(id)`).
 */
export function filterTasks(records, filters = DEFAULT_FILTERS, me, now = Date.now(), { zone, meetingTitle = () => '' } = {}) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const q = lower(f.q);
  const today = dayKey(now, zone);
  const end = weekEnd(today);
  return records.filter(r => {
    const d = r.data;
    const status = taskStatus(r);
    if (status === 'dismissed') return false;
    const owner = lower(d.owner);
    const mine = isMine(r, me);
    if (f.who === 'me' && !mine) return false;
    if (f.who === 'others' && (!owner || mine)) return false;
    if (f.who === 'nobody' && owner) return false;
    if (f.person && owner !== lower(f.person) && !(mine && isMine({ owner: f.person }, me))) return false;
    if (f.meeting && d.meetingId !== f.meeting) return false;
    const due = DATE.test(String(d.due || '')) ? d.due : null;
    if (f.due === 'overdue' && !overdue(r, now, zone)) return false;
    if (f.due === 'week' && (!due || due > end)) return false;
    if (f.due === 'none' && due) return false;
    if (q) {
      const text = [d.text, d.notes, d.quote, d.ownerName, d.owner, d.meetingId ? meetingTitle(d.meetingId) : ''].map(lower).join(' ');
      if (!text.includes(q)) return false;
    }
    return true;
  });
}

/** Open tasks per lane of the "Whose tasks" filter. */
export function laneCounts(records, me) {
  const open = records.filter(r => OPEN.includes(taskStatus(r)));
  const mine = open.filter(r => isMine(r, me));
  const nobody = open.filter(r => !lower(r.data.owner));
  return { all: open.length, me: mine.length, others: open.length - mine.length - nobody.length, nobody: nobody.length };
}

/** A task's meeting as the board shows it: `{id, title, start}` from the meeting record (or its
 *  event while the meeting has none); null when neither is in the snapshot. */
export function meetingOf(s, id) {
  if (!id) return null;
  const rec = s.records.find(r => r.kind === 'meeting' && r.id === id) || s.records.find(r => r.kind === 'event' && r.id === id);
  return rec ? { id, title: rec.data.title || 'Untitled meeting', start: rec.data.start || null } : null;
}
