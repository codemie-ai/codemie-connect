// By date (task provider design §9): pure helpers for the Tasks page's date layout. Late, Today
// and Later's folds (Next 7 days, No date, Later than that) over the active provider's tasks, in
// the workspace time zone; "Check with <name>" rows; the date chips; the header's status line;
// and which views the page offers. view-tasks-dates.js draws them.
import { addDaysToKey, agoLabel, dateFromKey, dayKey, formatDate, formatTime } from './format.js';
import { activeProvider, dueInfo, meetingOf, ownerOf, taskOrder, taskStatus } from './tasks-model.js';

/** Statuses By date lists by their due date (To review has its own section). */
const OPEN = ['todo', 'doing', 'waiting'];
const DAY_MS = 86_400_000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const daysFrom = (today, due) => Math.round((dateFromKey(due) - dateFromKey(today)) / DAY_MS);
/** A due date By date can place: a real `YYYY-MM-DD` day (dueInfo's own check). */
const dueOf = (r, now, zone) => (dueInfo(r.data.due, now, zone) ? r.data.due : null);

const byDue = (now, zone) => (a, b) => String(dueOf(a, now, zone) || '').localeCompare(String(dueOf(b, now, zone) || ''))
  || taskOrder(a) - taskOrder(b) || String(a.id).localeCompare(String(b.id));

/**
 * The tasks of By date: `review` (To review), `late` (open, due before today), `today`, `next7`
 * (due in 1–7 days), `noDate`, `later` (due after 7 days) and `doneToday` (done today, for the
 * footer). Open is To do, In progress and Waiting. Each list is sorted by due, then by order.
 */
export function dateGroups(records, { now = Date.now(), zone } = {}) {
  const today = dayKey(now, zone);
  const g = { review: [], late: [], today: [], next7: [], noDate: [], later: [], doneToday: [] };
  for (const r of records) {
    const status = taskStatus(r);
    if (status === 'review') g.review.push(r);
    else if (status === 'done') {
      const at = Number(r.data.doneAt) || 0;
      if (at && dayKey(at * 1000, zone) === today) g.doneToday.push(r);
    } else if (OPEN.includes(status)) {
      const due = dueOf(r, now, zone);
      const d = due ? daysFrom(today, due) : null;
      if (d === null) g.noDate.push(r);
      else if (d < 0) g.late.push(r);
      else if (d === 0) g.today.push(r);
      else if (d <= 7) g.next7.push(r);
      else g.later.push(r);
    }
  }
  for (const list of Object.values(g)) list.sort(byDue(now, zone));
  return g;
}

/** A row's due as By date shows it: "2d late", "Today", a weekday within six days, else the day. */
function dueTone(due, now, zone) {
  if (!due) return null;
  const d = daysFrom(dayKey(now, zone), due);
  const date = dateFromKey(due);
  if (d < 0) return { tone: 'late', text: `${-d}d late` };
  if (d === 0) return { tone: 'today', text: 'Today' };
  if (d < 7) return { tone: 'soon', text: formatDate(date, undefined, { weekday: 'short' }) };
  return { tone: 'later', text: formatDate(date, undefined, { month: 'short', day: 'numeric' }) };
}

/** The hosts of a task's own link that Open in Todoist ↗ opens (native checks them again, in
 *  ops.rs's `REMOTE_HOSTS`); a second provider adds its own hosts in both places. */
const REMOTE_HOSTS = ['todoist.com', 'app.todoist.com'];
function remoteUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\/[^\s/@:]+(\/|$)/i.test(url)) return null;
  try {
    return REMOTE_HOSTS.includes(new URL(url).hostname) ? url : null;
  } catch {
    return null;
  }
}

/** The tasks By date shows: one meeting's while the header's "From <meeting> ✕" chip is on. */
export const datesTasks = (records, filters) => (filters?.meeting ? records.filter(r => r.data.meetingId === filters.meeting) : records);

/**
 * A By date row: `{id, text, label, status, checkWith: {first} | null, due: {tone, text} | null,
 * source: {kind: 'meeting' | 'message', id, title} | null, nudge, url, pending, parked, syncError,
 * handled: {evidence} | null}`. A task waiting on someone else (its kind or status is waiting,
 * or its owner is someone else) reads "Check with <first>: <text>". `nudge` says its source is a
 * synced mail thread or Teams chat, the only place Nudge can open. `url` is the task's own
 * https link on a Todoist host. `parked`: a change the provider refused waits for Try again or
 * Discard change; `syncError` is its sentence, null when native withheld it.
 */
export function rowOf(record, { me, s, now = Date.now(), zone } = {}) {
  const d = record.data;
  const status = taskStatus(record);
  const owner = ownerOf(record, me);
  const other = !!owner.key && !owner.mine;
  // Waiting on nobody in particular (or on me) has nobody to check with.
  const waiting = d.kind === 'waiting' || status === 'waiting' || other;
  const checkWith = waiting && other ? { first: owner.first } : null;
  const text = String(d.text ?? '');
  let source = null;
  let nudge = false;
  if (d.meetingId) {
    const m = s ? meetingOf(s, d.meetingId) : null;
    if (m) source = { kind: 'meeting', id: m.id, title: m.title };
  } else if (d.sourceId) {
    const msg = s?.records.find(r => r.kind === 'message' && r.id === d.sourceId);
    if (msg) {
      source = { kind: 'message', id: msg.id, title: msg.data.from || msg.data.title || 'A message' };
      nudge = ['mail', 'chat'].includes(msg.data.channel);
    }
  }
  return {
    id: record.id, text, status,
    label: checkWith ? `Check with ${checkWith.first}: ${text}` : text,
    checkWith,
    due: dueTone(dueOf(record, now, zone), now, zone),
    source, nudge: nudge && !!checkWith,
    url: remoteUrl(d.remote?.url),
    pending: !!d.pending,
    // Parked: native keeps the provider's sentence, or "" when it held a secret and was dropped.
    parked: typeof d.syncError === 'string',
    syncError: d.syncError ? String(d.syncError) : null,
    handled: d.handled?.evidence ? { evidence: String(d.handled.evidence) } : null,
  };
}

/** The day keys behind the date chips: Today, Tomorrow and the next Monday (never today). */
function days(now, zone) {
  const today = dayKey(now, zone);
  const weekday = dateFromKey(today).getDay();
  return { today, tomorrow: addDaysToKey(today, 1), monday: addDaysToKey(today, ((8 - weekday) % 7) || 7) };
}

/** A row's date chips, `[label, dayKey | null]` (null: Pick date…): Tomorrow · Monday for Late
 *  and Today, Today · Tomorrow for Later's folds. */
export function chipsFor(group, { now = Date.now(), zone } = {}) {
  const k = days(now, zone);
  const pick = ['Pick date…', null];
  if (group === 'late' || group === 'today') return [['Tomorrow', k.tomorrow], ['Monday', k.monday], pick];
  return [['Today', k.today], ['Tomorrow', k.tomorrow], pick];
}

/** The day key of the Late ⋯ menu's Tomorrow or Monday. */
export const dayFor = (to, now = Date.now(), zone) => days(now, zone)[to] || null;

/**
 * The Tasks header's line for the provider (`taskProvider` of the snapshot): "Connect · on this
 * Mac", "Todoist · synced 5 min ago", "Todoist · syncing…", "Todoist can't be reached · 3
 * changes wait · trying again at 14:05", "Todoist asked Connect to slow down · trying again at
 * 14:05". With a banner (no token, turned off, didn't load) it is the provider's name alone.
 */
export function statusLine(tp, now = Date.now(), zone) {
  if (!tp || tp.active === 'local' || tp.state === 'local') return 'Connect · on this Mac';
  const name = tp.name || 'Your task app';
  const at = tp.retryAt ? ` · trying again at ${formatTime(tp.retryAt * 1000, zone)}` : '';
  switch (tp.state) {
    case 'ready': return tp.lastSync ? `${name} · synced ${agoLabel(tp.lastSync * 1000, zone, now)}` : `${name} · syncing…`;
    case 'syncing': return `${name} · syncing…`;
    case 'offline': return `${name} can't be reached${tp.pending ? ` · ${plural(tp.pending, 'change waits', 'changes wait')}` : ''}${at}`;
    case 'rate_limited': return `${name} asked Connect to slow down${at}`;
    default: return name;
  }
}

/** The view the Tasks page opens on: By date with a provider, the Board with Local. */
export const defaultView = s => (activeProvider(s) === 'local' ? 'board' : 'dates');

/** The views the page offers, `[id, label, icon]`: Board, List and By date with Local; By date
 *  and List with a provider (Todoist has no lanes). */
export function viewsFor(s) {
  if (activeProvider(s) === 'local') return [['board', 'Board', 'board'], ['list', 'List', 'list'], ['dates', 'By date', 'calendar']];
  return [['dates', 'By date', 'calendar'], ['list', 'List', 'list']];
}

/** The view shown: Local's choice (`view`) or the provider's (`providerView`), when the page
 *  offers it, else the default. */
export function shownView(v, s) {
  const chosen = activeProvider(s) === 'local' ? v?.view : v?.providerView;
  return viewsFor(s).some(([id]) => id === chosen) ? chosen : defaultView(s);
}
