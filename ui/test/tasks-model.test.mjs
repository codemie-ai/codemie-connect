// Tasks board model: statuses of old and new commitments, whose task it is, filters, sorting,
// placing a dropped card, due chips and the done tasks behind Show older.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  taskStatus, isMine, meOf, filterTasks, sortTasks, orderBetween, dueInfo, splitDone, COLUMNS, columnName, laneCounts, quoteTime, quickDates, DEFAULT_FILTERS, tasksOf, activeProvider,
} from '../workspace/tasks-model.js';
import { formatDate, dateFromKey } from '../workspace/format.js';
import { buildSnapshot, withTasks } from './fixtures/workspace-fixture.mjs';

// Wed 18 Nov 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 10, 18, 12);
const snapshot = () => withTasks(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), NOW);
const tasks = s => s.records.filter(r => r.kind === 'commitment');
const ids = list => list.map(r => r.id).sort();
const ME = { name: 'Taylor Morgan', aliases: ['Tay'], address: 'taylor.morgan@example.test' };

test('legacy commitments read as todo or done', () => {
  assert.equal(taskStatus({ data: { text: 'Book the room', done: false } }), 'todo');
  assert.equal(taskStatus({ data: { text: 'Share notes', done: true } }), 'done');
  assert.equal(taskStatus({ data: { text: 'x', status: 'waiting', done: false } }), 'waiting');
  assert.equal(taskStatus({ data: { text: 'x', status: 'later', done: true } }), 'done');
  assert.equal(taskStatus({ data: {} }), 'todo');
  const s = snapshot();
  assert.equal(taskStatus(s.records.find(r => r.id === 'commit-1')), 'todo');
  assert.equal(taskStatus(s.records.find(r => r.id === 'commit-3')), 'done');
  assert.deepEqual(COLUMNS, ['review', 'todo', 'doing', 'waiting', 'done']);
  assert.deepEqual(COLUMNS.map(c => columnName(c, {})), ['To review', 'To do', 'In progress', 'Waiting', 'Done']);
  assert.equal(columnName('todo', { meetings: { columns: { todo: 'Next up' } } }), 'Next up');
  assert.equal(columnName('dismissed', { meetings: { columns: { dismissed: 'Gone' } } }), 'Dismissed');
});

test("tasksOf keeps the active provider's tasks; no taskProvider means Local", () => {
  const s = snapshot();
  const all = tasks(s);
  assert.equal(activeProvider(s), 'local', 'no taskProvider on the snapshot: Local');
  assert.deepEqual(ids(tasksOf(s)), ids(all), 'every commitment is Local\'s: none carries a provider');
  const remote = { id: 'todoist-1', kind: 'commitment', data: { text: 'Check with Marek', provider: 'plugin:todoist' } };
  const mixed = { ...s, taskProvider: { active: 'plugin:todoist' }, records: [...s.records, remote] };
  assert.equal(activeProvider(mixed), 'plugin:todoist');
  assert.deepEqual(ids(tasksOf(mixed)), ['todoist-1'], 'only the active provider\'s task, none of Local\'s');
});

test('isMine: "You", my address and my aliases are mine; another address is not', () => {
  for (const owner of ['You', 'you', 'TAYLOR.MORGAN@example.test', 'Taylor Morgan', ' tay ']) assert.ok(isMine({ data: { owner } }, ME), owner);
  for (const owner of ['jordan.lee@example.test', 'Jordan', '', null, undefined]) assert.ok(!isMine({ data: { owner } }, ME), String(owner));
  // A body works as well as a record; signed out, only "You" is mine.
  assert.ok(isMine({ owner: 'taylor.morgan@example.test' }, ME));
  assert.ok(isMine({ owner: 'You' }, { name: '', aliases: [], address: null }));
  assert.ok(!isMine({ owner: 'Taylor Morgan' }, { name: '', aliases: [], address: null }));
  assert.deepEqual(meOf(snapshot()), { name: 'Taylor Morgan', aliases: [], address: 'taylor.morgan@example.test' });
  assert.deepEqual(meOf(buildSnapshot(NOW, { connected: false })), { name: '', aliases: [], address: null });
});

test('filters: I owe, owed to me, nobody named, person, meeting, overdue, this week, no date, search', () => {
  const s = snapshot();
  const me = meOf(s);
  const all = tasks(s);
  const run = filters => ids(filterTasks(all, { ...DEFAULT_FILTERS, ...filters }, me, NOW, { zone: 'UTC', meetingTitle: id => s.records.find(r => r.kind === 'meeting' && r.id === id)?.data.title }));
  // Dismissed tasks are never on the board.
  assert.ok(!run({}).includes('task-dashboard'));
  assert.equal(run({}).length, all.length - 1);
  assert.deepEqual(run({ who: 'me' }), ['commit-1', 'commit-2', 'commit-3', 'task-demo', 'task-room']);
  assert.deepEqual(run({ who: 'others' }), ['task-bug', 'task-hr', 'task-legal', 'task-names', 'task-pilot', 'task-share']);
  assert.deepEqual(run({ who: 'nobody' }), ['task-tenant']);
  assert.deepEqual(run({ person: 'JORDAN.LEE@example.test' }), ['task-hr', 'task-share']);
  assert.deepEqual(run({ meeting: 'ev-sync' }), ['task-bug', 'task-legal', 'task-names']);
  assert.deepEqual(run({ due: 'overdue' }), ['task-legal']);
  // The rest of this week (Wed 18 Nov to Sun 22 Nov), overdue included.
  assert.deepEqual(run({ due: 'week' }), ['commit-1', 'task-demo', 'task-legal', 'task-share']);
  assert.deepEqual(run({ due: 'none' }), ['commit-2', 'commit-3', 'task-bug', 'task-hr', 'task-pilot', 'task-room', 'task-tenant']);
  // Search: the task, its owner's name and its meeting's title.
  assert.deepEqual(run({ q: 'legal' }), ['task-legal']);
  assert.deepEqual(run({ q: 'priya' }), ['commit-1', 'task-bug', 'task-pilot']);
  assert.deepEqual(run({ q: 'philips' }), ['task-bug', 'task-demo', 'task-legal', 'task-names']);
  // Combined: others' overdue tasks.
  assert.deepEqual(run({ who: 'others', due: 'overdue' }), ['task-legal']);
  // Counts per lane are the open tasks (to review, to do, in progress, waiting).
  assert.deepEqual(laneCounts(all, me), { all: 9, me: 3, others: 5, nobody: 1 });
});

test('overdue cards sort first in every column except Done', () => {
  const card = (id, order, status, due) => ({ id, updatedAt: 0, data: { text: id, order, status, due } });
  const todo = [card('a', 1, 'todo', null), card('b', 2, 'todo', '2026-11-10'), card('c', 3, 'todo', '2026-11-30'), card('d', 0.5, 'todo', '2026-11-17')];
  assert.deepEqual(todo.sort((x, y) => sortTasks(x, y, NOW, 'UTC')).map(x => x.id), ['d', 'b', 'a', 'c']);
  const done = [card('a', 1, 'done', null), card('b', 2, 'done', '2026-11-10')];
  assert.deepEqual(done.sort((x, y) => sortTasks(x, y, NOW, 'UTC')).map(x => x.id), ['a', 'b']);
  // A commitment from before the board sorts by when it last changed.
  const legacy = [{ id: 'old', updatedAt: 1_795_000_100, data: { text: 'old' } }, { id: 'new', updatedAt: 0, data: { text: 'new', order: 1_795_000_050 } }];
  assert.deepEqual(legacy.sort((x, y) => sortTasks(x, y, NOW, 'UTC')).map(x => x.id), ['new', 'old']);
});

test('orderBetween puts a dropped card between its neighbours and at the ends', () => {
  assert.equal(orderBetween(1, 2), 1.5);
  assert.equal(orderBetween(5, null), 6);
  assert.equal(orderBetween(null, 5), 4);
  assert.equal(orderBetween(null, null), 0);
  assert.equal(orderBetween(1_795_000_000, 1_795_000_001), 1_795_000_000.5);
  // Repeated drops into the same gap keep landing strictly between.
  let low = 1;
  const high = 2;
  for (let i = 0; i < 30; i++) {
    const next = orderBetween(low, high);
    assert.ok(next > low && next < high, `${next}`);
    low = next;
  }
});

test('dueInfo labels yesterday, today, tomorrow, weekday and date with the right tone', () => {
  const at = key => dateFromKey(key);
  assert.deepEqual(dueInfo('2026-11-17', NOW, 'UTC'), { tone: 'overdue', text: 'Yesterday', title: 'Overdue by 1 day' });
  assert.deepEqual(dueInfo('2026-11-18', NOW, 'UTC'), { tone: 'today', text: 'Today', title: 'Due today' });
  assert.deepEqual(dueInfo('2026-11-19', NOW, 'UTC'), { tone: 'soon', text: 'Tomorrow', title: 'Due tomorrow' });
  const friday = dueInfo('2026-11-20', NOW, 'UTC');
  assert.equal(friday.tone, 'soon');
  assert.equal(friday.text, formatDate(at('2026-11-20'), undefined, { weekday: 'short' }));
  const later = dueInfo('2026-12-01', NOW, 'UTC');
  assert.equal(later.tone, 'later');
  assert.equal(later.text, formatDate(at('2026-12-01'), undefined, { month: 'short', day: 'numeric' }));
  const old = dueInfo('2026-11-10', NOW, 'UTC');
  assert.equal(old.tone, 'overdue');
  assert.equal(old.text, formatDate(at('2026-11-10'), undefined, { month: 'short', day: 'numeric' }));
  assert.equal(old.title, 'Overdue by 8 days');
  // Today is the workspace's today: 23:30 UTC is already the 19th in Kyiv.
  assert.equal(dueInfo('2026-11-19', Date.UTC(2026, 10, 18, 23, 30), 'Europe/Kyiv').tone, 'today');
  for (const none of [null, '', 'soon', '2026-13-01']) assert.equal(dueInfo(none, NOW, 'UTC'), null, String(none));
  assert.deepEqual(quickDates(NOW, 'UTC'), [['Today', '2026-11-18'], ['Tomorrow', '2026-11-19'], ['Friday', '2026-11-20'], ['Next week', '2026-11-23']]);
  // On a Friday, "Friday" is the next one.
  assert.deepEqual(quickDates(Date.UTC(2026, 10, 20, 9), 'UTC')[2], ['Friday', '2026-11-27']);
  assert.equal(quoteTime(173), '2:53');
  assert.equal(quoteTime(3725.4), '1:02:05');
  assert.equal(quoteTime(null), '');
});

test('done tasks older than doneDays are hidden behind Show older', () => {
  const s = snapshot();
  const done = tasks(s).filter(r => taskStatus(r) === 'done');
  const { shown, older } = splitDone(done, 14, NOW);
  // commit-3 has no doneAt: when it last changed counts.
  assert.deepEqual(ids(shown), ['commit-3', 'task-pilot']);
  assert.deepEqual(ids(older), ['task-room']);
  assert.deepEqual(ids(splitDone(done, 60, NOW).older), []);
});
