// By date (task provider design §9): the pure groups, rows, chips, the header's status line, the
// default view and the view itself, over a snapshot built here (Wed 18 Nov 2026, Kyiv).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chipsFor, dateGroups, defaultView, foldOf, rowOf, statusLine, viewsFor, shownView } from '../workspace/tasks-dates-model.js';
import { formatTime } from '../workspace/format.js';
import { tasksPage } from '../workspace/view-tasks.js';
import { newTasksView } from '../workspace/tasks-model.js';

// Wed 18 Nov 2026, 12:00 in Kyiv.
const NOW = Date.parse('2026-11-18T12:00:00+02:00');
const ZONE = 'Europe/Kyiv';
const ME = { name: 'Taylor Morgan', aliases: [], address: 'taylor.morgan@example.test' };
const STATES = JSON.parse(readFileSync(new URL('./fixtures/contract/task-provider-states.json', import.meta.url), 'utf8'));
const sec = Math.floor(NOW / 1000);

const task = (id, data = {}, extra = {}) => ({
  id, kind: 'commitment', source: 'local', connectionId: null, workspaceId: 'personal', revision: `r-${id}`, updatedAt: sec - 600,
  data: { text: id, owner: 'You', due: null, status: 'todo', done: false, order: 1, ...data }, ...extra,
});
const provider = (data = {}) => ({ provider: 'plugin:todoist', ...data });

/** A snapshot with Todoist active (state `state`) and `records`. */
function snapshot(records, state = 'ready') {
  return {
    settings: { timeZone: ZONE, meetings: {} },
    connection: { displayName: ME.name, email: ME.address },
    taskProvider: STATES[state],
    records: [
      { id: 'ev-sync', kind: 'meeting', data: { title: 'Philips sync', start: '2026-11-16T10:00:00Z' } },
      { id: 'm-marek', kind: 'message', data: { channel: 'chat', from: 'Marek Nowak', title: 'Pilot', conversationId: 'c1' } },
      { id: 'm-olga', kind: 'message', data: { channel: 'mail', from: 'Olga Shevchenko', title: 'SOW' } },
      ...records,
    ],
  };
}

const groupIds = g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map(r => r.id)]));

test('groups: late, today, next 7 days, no date, later than that; done today counted', () => {
  const records = [
    task('late', { due: '2026-11-16' }),
    task('late-older', { due: '2026-11-10', order: 5 }),
    task('today-b', { due: '2026-11-18', order: 2 }),
    task('today-a', { due: '2026-11-18', order: 1, status: 'doing' }),
    task('next', { due: '2026-11-25' }),
    task('next-first', { due: '2026-11-19', status: 'waiting' }),
    task('later', { due: '2026-11-26' }),
    task('nodate', {}),
    task('review', { status: 'review', due: '2026-11-10' }),
    task('done-today', { status: 'done', done: true, doneAt: sec - 3600 }),
    task('done-yesterday', { status: 'done', done: true, doneAt: sec - 30 * 3600 }),
    task('dismissed', { status: 'dismissed', due: '2026-11-16' }),
    // A commitment from before the board (no status) reads as To do.
    task('legacy', { status: undefined, due: '2026-11-17' }),
  ];
  const g = dateGroups(records, { now: NOW, zone: ZONE, me: ME });
  assert.deepEqual(groupIds(g), {
    review: ['review'],
    late: ['late-older', 'late', 'legacy'],
    today: ['today-a', 'today-b'],
    next7: ['next-first', 'next'],
    noDate: ['nodate'],
    later: ['later'],
    doneToday: ['done-today'],
  });
});

test('waiting rows read "Check with <first>: <text>" and sit at their check date', () => {
  const s = snapshot([
    task('w1', provider({ text: 'pilot user list', owner: 'marek@example.test', ownerName: 'Marek Nowak', kind: 'waiting', status: 'waiting', due: '2026-11-17', sourceId: 'm-marek' })),
    task('w2', { text: 'the CSV export', owner: 'jordan.lee@example.test', ownerName: 'Lee, Jordan', status: 'todo', due: '2026-11-20' }),
    task('mine', provider({ text: 'Approve the hotfix', owner: ME.address, due: '2026-11-18', meetingId: 'ev-sync', remote: { url: 'https://app.todoist.com/app/task/1' } })),
    task('nobody', { text: 'Book a room', owner: null, status: 'waiting' }),
  ]);
  const g = dateGroups(s.records.filter(r => r.kind === 'commitment'), { now: NOW, zone: ZONE, me: ME });
  assert.deepEqual(groupIds(g).late, ['w1']);
  assert.deepEqual(groupIds(g).next7, ['w2']);
  const at = { me: ME, s, now: NOW, zone: ZONE };
  const w1 = rowOf(g.late[0], at);
  assert.equal(w1.label, 'Check with Marek: pilot user list');
  assert.deepEqual(w1.checkWith, { first: 'Marek' });
  assert.deepEqual(w1.due, { tone: 'late', text: '1d late' });
  assert.deepEqual(w1.source, { kind: 'message', id: 'm-marek', title: 'Marek Nowak' });
  assert.equal(w1.nudge, true, 'a synced chat can be nudged');
  // Someone else's task reads as Check with too, with the first name of "Last, First".
  assert.equal(rowOf(g.next7[0], at).label, 'Check with Jordan: the CSV export');
  assert.deepEqual(rowOf(g.next7[0], at).due, { tone: 'soon', text: 'Fri' });
  const mine = rowOf(g.today[0], at);
  assert.equal(mine.label, 'Approve the hotfix');
  assert.equal(mine.checkWith, null);
  assert.deepEqual(mine.source, { kind: 'meeting', id: 'ev-sync', title: 'Philips sync' });
  assert.equal(mine.url, 'https://app.todoist.com/app/task/1');
  assert.equal(mine.nudge, false);
  // Waiting on nobody named: nobody to check with.
  assert.equal(rowOf(g.noDate[0], at).label, 'Book a room');
  // Pending, parked and looks handled come from the record.
  const flagged = rowOf(task('f', provider({ pending: true, syncError: 'Todoist needs a date like 2026-11-20.', handled: { evidence: 'you replied in Teams 17:32', at: sec, auto: false } })), at);
  assert.deepEqual([flagged.pending, flagged.syncError, flagged.handled], [true, 'Todoist needs a date like 2026-11-20.', { evidence: 'you replied in Teams 17:32' }]);
  // Only https links open.
  assert.equal(rowOf(task('x', { remote: { url: 'javascript:alert(1)' } }), at).url, null);
});

test('chips: Tomorrow/Monday/Pick date… for late and today, Today/Tomorrow/Pick date… for later', () => {
  const at = { now: NOW, zone: ZONE };
  const near = [['Tomorrow', '2026-11-19'], ['Monday', '2026-11-23'], ['Pick date…', null]];
  assert.deepEqual(chipsFor('late', at), near);
  assert.deepEqual(chipsFor('today', at), near);
  const far = [['Today', '2026-11-18'], ['Tomorrow', '2026-11-19'], ['Pick date…', null]];
  for (const g of ['next7', 'noDate', 'later']) assert.deepEqual(chipsFor(g, at), far, g);
  // On a Sunday, Monday is tomorrow; on a Monday, the next one.
  assert.equal(chipsFor('late', { now: Date.parse('2026-11-22T12:00:00+02:00'), zone: ZONE })[1][1], '2026-11-23');
  assert.equal(chipsFor('late', { now: Date.parse('2026-11-23T12:00:00+02:00'), zone: ZONE })[1][1], '2026-11-30');
});

test('statusLine covers every provider state', () => {
  const now = 1795003200 * 1000 + 5 * 60_000;
  const lines = Object.fromEntries(Object.entries(STATES).map(([k, tp]) => [k, statusLine(tp, now, 'UTC')]));
  assert.equal(lines.local, 'Connect · on this Mac');
  assert.equal(lines.ready, 'Todoist · synced 5 min ago');
  assert.equal(lines.syncing, 'Todoist · syncing…');
  assert.equal(lines.offline, `Todoist can't be reached · 1 change waits · trying again at ${formatTime(1795003230 * 1000, 'UTC')}`);
  assert.equal(lines.rate_limited, `Todoist asked Connect to slow down · trying again at ${formatTime(1795003320 * 1000, 'UTC')}`);
  // The banner says the rest; the line keeps the provider's name. A still-loading plugin (I1)
  // reads the same neutral way, never "didn't load".
  for (const k of ['needs_token', 'off', 'failed', 'loading']) assert.equal(lines[k], 'Todoist', k);
  assert.equal(statusLine(undefined, now, 'UTC'), 'Connect · on this Mac');
  assert.equal(statusLine({ ...STATES.offline, pending: 3, retryAt: null }, now, 'UTC'), "Todoist can't be reached · 3 changes wait");
});

test('datesView escapes provider text and draws only folds with rows', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const s = snapshot([
    task('a', provider({ text: evil, due: '2026-11-25', remote: { url: 'https://app.todoist.com/app/task/"><script>' } })),
    task('b', provider({ text: 'Send the follow-ups', due: '2026-11-16', meetingId: 'ev-sync' })),
    task('c', provider({ text: 'Parked one', due: '2026-11-18', pending: true, syncError: `Bad ${evil}` })),
  ], 'needs_token');
  s.records.find(r => r.id === 'ev-sync').data.title = evil;
  const html = tasksPage(s, { state: { tasks: newTasksView() }, now: NOW });
  assert.ok(!html.includes('<img src=x'), 'no raw provider markup');
  assert.ok(!html.includes('"><script>'), 'no raw url');
  assert.ok(html.includes('class="ws-tdate'), 'By date is the view with a provider');
  // Folds: only Next 7 days has rows, closed by default.
  assert.match(html, /data-fold="next7"[^>]*aria-expanded="false"/);
  assert.ok(!html.includes('data-fold="noDate"') && !html.includes('data-fold="later"'));
  assert.ok(!html.includes('data-task="a"'), 'a closed fold draws no rows');
  // Opened, it draws its rows.
  const open = tasksPage(s, { state: { tasks: { ...newTasksView(), folds: { next7: true } } }, now: NOW });
  assert.match(open, /data-fold="next7"[^>]*aria-expanded="true"/);
  assert.ok(open.includes('data-task="a"'));
  // Sections, the Late menu, the banner, the parked row, the pending dot, the footer.
  assert.ok(html.includes('<h2') && html.includes('Late · 1') && html.includes('data-menu="tasks-late"'));
  assert.ok(html.includes('Todoist needs your API token.') && html.includes('Open Settings'));
  assert.ok(html.includes('Not in Todoist yet') && html.includes('Bad &lt;img'), 'pending dot and parked sentence, folded');
  assert.ok(!html.includes('Try again'), 'a folded row has no controls but its done box');
  const parked = tasksPage(s, { state: { tasks: { ...newTasksView(), rowOpen: 'c' } }, now: NOW });
  assert.ok(parked.includes('Try again') && parked.includes('Discard change'));
  assert.match(html, /role="status"[^>]*>[^]*0 done today/);
  assert.ok(!html.includes('Nothing late.') && open.includes('Today'));
  // Empty Late and Today say so.
  const empty = tasksPage(snapshot([], 'ready'), { state: { tasks: newTasksView() }, now: NOW });
  assert.ok(empty.includes('Nothing late.') && empty.includes('Nothing for today.'));
});

test('defaultView: dates with a provider, board with Local; Board hidden with a provider', () => {
  const todoist = snapshot([]);
  const local = { ...snapshot([]), taskProvider: STATES.local };
  const none = { ...snapshot([]), taskProvider: undefined };
  assert.equal(defaultView(todoist), 'dates');
  assert.equal(defaultView(local), 'board');
  assert.equal(defaultView(none), 'board');
  assert.deepEqual(viewsFor(todoist).map(([id]) => id), ['dates', 'list']);
  assert.deepEqual(viewsFor(local).map(([id, label]) => `${id}:${label}`), ['board:Board', 'list:List', 'dates:By date']);
  // The view shown: Local keeps its choice; a provider has its own, By date until one is made.
  assert.equal(shownView(newTasksView('board'), todoist), 'dates');
  assert.equal(shownView({ ...newTasksView('board'), providerView: 'list' }, todoist), 'list');
  assert.equal(shownView(newTasksView('dates'), local), 'dates');
  assert.equal(shownView({ ...newTasksView('board'), providerView: 'dates' }, local), 'board');
  const html = tasksPage(todoist, { state: { tasks: newTasksView('board') }, now: NOW });
  assert.ok(!html.includes('data-view="board"'), 'no Board with a provider');
  assert.ok(html.indexOf('data-view="dates"') < html.indexOf('data-view="list"'), 'By date first');
  const localHtml = tasksPage(local, { state: { tasks: newTasksView('board') }, now: NOW });
  assert.ok(localHtml.includes('ws-task-board'));
  assert.ok(localHtml.indexOf('data-view="list"') < localHtml.indexOf('data-view="dates"'), 'By date third for Local');
  // With a provider, the list's status select offers To do, Waiting and Done.
  const list = tasksPage(snapshot([task('t', provider({ text: 'One' }))]), { state: { tasks: { ...newTasksView(), providerView: 'list' } }, now: NOW });
  const select = list.match(/data-action="task-status"[^]*?<\/select>/)[0];
  assert.deepEqual([...select.matchAll(/value="(\w+)"/g)].map(m => m[1]), ['todo', 'waiting', 'done']);
});

test('one primary per page: "Accept all" with two or more to review, every row Accept secondary', () => {
  const primaries = html => [...html.matchAll(/<button[^>]*class="ws-btn ws-btn-primary[^"]*"[^>]*>([^]*?)<\/button>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  const review = n => Array.from({ length: n }, (_, i) => task(`r${i}`, provider({ status: 'review', text: `Review ${i}` })));
  const two = tasksPage(snapshot(review(2)), { state: { tasks: newTasksView() }, now: NOW });
  assert.deepEqual(primaries(two), ['Accept all']);
  assert.ok((two.match(/data-action="task-accept"/g) || []).length === 2, 'each row keeps its Accept');
  const one = tasksPage(snapshot(review(1)), { state: { tasks: newTasksView() }, now: NOW });
  assert.ok(!one.includes('Accept all'));
  assert.deepEqual(primaries(one), ['New task'], 'the header keeps the page primary');
});

test('foldOf: the Later fold a task sits in (Next 7 days, No date, Later than that); none for review, late and today', () => {
  const records = [task('soon', { due: '2026-11-21' }), task('nodate'), task('far', { due: '2026-12-20' }), task('late', { due: '2026-11-16' }), task('today', { due: '2026-11-18' }), task('review', { status: 'review' })];
  const at = id => foldOf(records, id, { now: NOW, zone: ZONE });
  assert.equal(at('soon'), 'next7');
  assert.equal(at('nodate'), 'noDate');
  assert.equal(at('far'), 'later');
  for (const id of ['late', 'today', 'review', 'gone']) assert.equal(at(id), null);
});

test('a refused pull shows the failed banner with the provider sentence, not "didn\'t load"', () => {
  const s = snapshot([task('a', provider({ text: 'One', due: '2026-11-18' }))], 'failed');
  // The plugin loaded (ready) and refused the pull: its sentence is the reason.
  s.taskProvider = {
    ...STATES.failed,
    available: STATES.failed.available.map(a => (a.id === 'plugin:todoist' ? { ...a, ready: true } : a)),
    message: "Todoist didn't accept the change (400) <b>",
  };
  const html = tasksPage(s, { state: { tasks: newTasksView() }, now: NOW });
  assert.match(html, /class="ws-tdate-banner" role="alert">[^]*Todoist refused the last sync: Todoist didn&#39;t accept the change \(400\) &lt;b&gt;\./);
  assert.ok(!html.includes("plugin didn't load"));
  // A plugin that didn't load keeps its own banner.
  const notLoaded = tasksPage(snapshot([], 'failed'), { state: { tasks: newTasksView() }, now: NOW });
  assert.ok(notLoaded.includes("The Todoist plugin didn't load."));
});
