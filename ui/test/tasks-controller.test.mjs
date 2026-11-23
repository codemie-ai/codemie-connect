// The Tasks controller with its store, dialogs and navigation faked: drops, the Move to menu,
// delete with Undo, quick add, review and the drawer's fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTasksController } from '../workspace/tasks-controller.js';
import { newTasksView, taskOrder, sortTasks, taskStatus } from '../workspace/tasks-model.js';
import { buildSnapshot, withTasks, taskContract } from './fixtures/workspace-fixture.mjs';
import { REBASE_SAFE } from '../workspace/store.js';

const NOW = Date.UTC(2026, 10, 18, 12);

/** A controller over fakes. `mutate` applies saves and deletes to the snapshot, as the snapshot
 *  after a real write would show them; `answers` maps an op to what it returns. */
function harness({ answers = {}, snapshot = withTasks(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), NOW) } = {}) {
  const calls = { mutate: [], render: 0, toasts: [], modals: [], meetings: [], focus: [] };
  const state = { route: 'tasks', tasks: newTasksView() };
  const ctl = createTasksController({
    state,
    snap: () => snapshot,
    mutate: async (op, data) => {
      calls.mutate.push([op, data]);
      const stored = snapshot.records.find(r => r.kind === 'commitment' && r.id === data.id);
      if (op === 'task_save' && stored) {
        const { log, ...fields } = data;
        Object.assign(stored.data, fields, fields.status ? { done: fields.status === 'done' } : {});
      }
      if (op === 'task_delete') snapshot.records = snapshot.records.filter(r => r !== stored);
      return typeof answers[op] === 'function' ? answers[op](data) : answers[op] ?? { id: data.id || 'task-new' };
    },
    render: async () => { calls.render++; },
    openModal: options => { calls.modals.push(options); return { querySelector: () => null }; },
    confirmModal: options => { calls.modals.push(options); },
    toast: (message, tone, action) => calls.toasts.push({ message, tone, action }),
    openMeeting: (...args) => calls.meetings.push(args),
    focus: selector => calls.focus.push(selector),
    now: () => NOW,
  });
  const record = id => snapshot.records.find(r => r.id === id);
  return { ctl, state, calls, snapshot, record };
}
const control = (dataset = {}, extra = {}) => ({ dataset, closest: () => null, ...extra });

test('dropping a review card on To do saves status todo and logs "Accepted from review"', async () => {
  const { ctl, calls, record } = harness();
  // To do shows the overdue task first, then by order: legal (3, overdue), commit-…, names (4), tenant (7).
  await ctl.onDrop('task-share', 'todo', 'task-tenant');
  assert.equal(calls.mutate.length, 1);
  const [op, data] = calls.mutate[0];
  assert.equal(op, 'task_save');
  assert.equal(data.id, 'task-share');
  assert.equal(data.status, 'todo');
  assert.equal(data.log, 'Accepted from review');
  assert.ok(data.order > taskOrder(record('task-names')) && data.order < taskOrder(record('task-tenant')), `${data.order}`);
  // A drop at the end of another column; no log for an ordinary move.
  await ctl.onDrop('task-hr', 'done', null);
  const [, moved] = calls.mutate[1];
  assert.equal(moved.status, 'done');
  assert.equal(moved.log, undefined);
  assert.ok(moved.order > taskOrder(record('task-room')), 'after every done card');
  // Reordering inside a column changes only the order; dropping a card where it is saves nothing.
  await ctl.onDrop('task-tenant', 'todo', 'task-names');
  assert.deepEqual(Object.keys(calls.mutate[2][1]).sort(), ['id', 'order']);
  // To do is now: legal (overdue), tenant (3.5), names, share (5.5), …
  await ctl.onDrop('task-names', 'todo', 'task-share');
  assert.equal(calls.mutate.length, 3, 'a card dropped in its own place stays put');
  // Not onto To review, and nothing for a card that is gone.
  await ctl.onDrop('task-legal', 'review', null);
  await ctl.onDrop('task-missing', 'todo', null);
  assert.equal(calls.mutate.length, 3);
});

test('Move to menu saves the chosen status', async () => {
  const { ctl, calls, record } = harness();
  let closed = false;
  const menuItem = control({ id: 'task-legal', col: 'waiting' }, { closest: sel => (sel === 'details' ? { removeAttribute: () => { closed = true; } } : null) });
  await ctl.handle('task-move', menuItem);
  assert.ok(closed, 'the menu closes');
  const [op, data] = calls.mutate[0];
  assert.equal(op, 'task_save');
  assert.deepEqual({ id: data.id, status: data.status }, { id: 'task-legal', status: 'waiting' });
  assert.ok(data.order > taskOrder(record('task-hr')), 'at the end of Waiting');
  // From review it is an acceptance; the drawer's status buttons use the same action.
  await ctl.handle('task-move', control({ id: 'task-bug', col: 'doing' }));
  assert.equal(calls.mutate[1][1].log, 'Accepted from review');
  // Accept and Dismiss on a review card; Dismiss offers Undo.
  await ctl.handle('task-accept', control({ id: 'task-share' }));
  assert.deepEqual([calls.mutate[2][1].status, calls.mutate[2][1].log], ['todo', 'Accepted from review']);
  await ctl.handle('task-dismiss', control({ id: 'task-bug' }));
  assert.deepEqual([calls.mutate[3][1].status, calls.mutate[3][1].log], ['dismissed', 'Dismissed — not a task']);
  const undo = calls.toasts.at(-1).action;
  assert.equal(undo.label, 'Undo');
  await undo.run();
  // Undo puts it back where it was (In progress, since the move above).
  assert.deepEqual([calls.mutate[4][1].id, calls.mutate[4][1].status, calls.mutate[4][1].log], ['task-bug', 'doing', 'Restored']);
  // The list's status select.
  await ctl.handle('task-status', control({ id: 'task-names' }, { value: 'doing' }));
  assert.equal(calls.mutate[5][1].status, 'doing');
});

test('delete shows Undo and Undo saves the returned body back', async () => {
  const { deleted } = taskContract();
  const { ctl, state, calls } = harness({ answers: { task_delete: data => ({ ...deleted, id: data.id }) } });
  state.tasks.drawer = 'task-room';
  let opened = false;
  await ctl.handle('task-delete', control({ id: 'task-room' }, { closest: sel => (sel === 'details' ? { removeAttribute: () => { opened = true; } } : null) }));
  assert.deepEqual(calls.mutate[0], ['task_delete', { id: 'task-room' }]);
  assert.equal(state.tasks.drawer, null, 'the drawer of a deleted task closes');
  assert.ok(opened);
  const toast = calls.toasts.at(-1);
  assert.equal(toast.message, 'Deleted “Book a room for demo day”');
  assert.equal(toast.action.label, 'Undo');
  await toast.action.run();
  assert.deepEqual(calls.mutate[1], ['task_save', { ...deleted.body, id: 'task-room' }]);
});

test('quick add saves owner, due and the column status', async () => {
  const { ctl, state, calls } = harness();
  await ctl.handle('task-quick', control({ col: 'doing' }));
  assert.equal(state.tasks.quickAdd, 'doing');
  assert.ok(calls.focus.includes('[data-form="task-quick"] textarea'));
  await ctl.quickAdd('doing', { text: '  Write the release notes  ', owner: 'jordan.lee@example.test', due: '2026-11-20' });
  assert.deepEqual(calls.mutate[0], ['task_save', { text: 'Write the release notes', owner: 'jordan.lee@example.test', ownerName: 'Jordan Lee', due: '2026-11-20', status: 'doing' }]);
  // It stays open for the next one; mine and nobody's work too; an empty one saves nothing.
  assert.equal(state.tasks.quickAdd, 'doing');
  await ctl.quickAdd('todo', { text: 'Renew the certificate', owner: 'taylor.morgan@example.test', due: '' });
  assert.deepEqual(calls.mutate[1][1], { text: 'Renew the certificate', owner: 'taylor.morgan@example.test', ownerName: 'Taylor Morgan', due: null, status: 'todo' });
  await ctl.quickAdd('waiting', { text: 'Ask IT', owner: '', due: '' });
  assert.deepEqual(calls.mutate[2][1], { text: 'Ask IT', owner: null, ownerName: null, due: null, status: 'waiting' });
  await ctl.quickAdd('todo', { text: '   ', owner: '', due: '' });
  assert.equal(calls.mutate.length, 3);
  await ctl.handle('task-quick-cancel', control());
  assert.equal(state.tasks.quickAdd, null);
});

test('the drawer opens, saves its fields on change and closes', async () => {
  const { ctl, state, calls } = harness();
  await ctl.handle('task-open', control({ id: 'task-bug' }));
  assert.equal(state.tasks.drawer, 'task-bug');
  assert.ok(calls.focus.includes('.ws-task-drawer-title'));
  await ctl.handle('task-owner', control({ id: 'task-bug' }, { value: 'sam.okafor@example.test' }));
  assert.deepEqual(calls.mutate[0][1], { id: 'task-bug', owner: 'sam.okafor@example.test', ownerName: 'Sam Okafor' });
  await ctl.handle('task-due-pick', control({ id: 'task-bug', value: '2026-11-20' }));
  assert.deepEqual(calls.mutate[1][1], { id: 'task-bug', due: '2026-11-20' });
  await ctl.handle('task-due', control({ id: 'task-bug' }, { value: '' }));
  assert.deepEqual(calls.mutate[2][1], { id: 'task-bug', due: null });
  await ctl.handle('task-title', control({ id: 'task-bug' }, { value: 'Move the sync bug to 2.5 ' }));
  assert.deepEqual(calls.mutate[3][1], { id: 'task-bug', text: 'Move the sync bug to 2.5' });
  // Unchanged or blank: nothing is saved (a blank title comes back).
  await ctl.handle('task-title', control({ id: 'task-bug' }, { value: 'Move the sync bug to 2.5' }));
  await ctl.handle('task-title', control({ id: 'task-bug' }, { value: '  ' }));
  assert.equal(calls.mutate.length, 4);
  await ctl.handle('task-notes', control({ id: 'task-bug' }, { value: 'Check with QA first.' }));
  assert.deepEqual(calls.mutate[4][1], { id: 'task-bug', notes: 'Check with QA first.' });
  // The quote opens the transcript at its line.
  await ctl.handle('task-quote', control({ id: 'task-bug' }));
  assert.deepEqual(calls.meetings.at(-1), ['ev-sync', 'transcript', 7]);
  // "Open the meeting" (the drawer's source, the menu item, the row's link) passes no pane, so
  // "Open a meeting on" decides.
  await ctl.handle('task-open-meeting', control({ id: 'ev-sync' }));
  assert.deepEqual(calls.meetings.at(-1), ['ev-sync']);
  await ctl.handle('task-close', control());
  assert.equal(state.tasks.drawer, null);
  assert.ok(calls.focus.includes('[data-action="task-open"][data-id="task-bug"]'), 'focus goes back to the card');
});

test('Escape closes an open quick add first, then the drawer', async () => {
  const { ctl, state } = harness();
  Object.assign(state.tasks, { drawer: 'task-bug', quickAdd: 'todo' });
  const key = () => ({ key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, target: { closest: () => null } });
  const first = key();
  assert.equal(await ctl.key(first), true);
  assert.equal(state.tasks.quickAdd, null);
  assert.equal(state.tasks.drawer, 'task-bug');
  assert.equal(await ctl.key(key()), true);
  assert.equal(state.tasks.drawer, null);
  assert.equal(await ctl.key(key()), false, 'nothing left to close');
});

/** A snapshot holding only `tasks`: [id, order, status, due?]. */
const board = tasks => ({
  settings: { timeZone: 'UTC', meetings: {} }, connection: null,
  records: tasks.map(([id, order, status, due = null]) => ({ id, kind: 'commitment', updatedAt: 0, data: { text: id, owner: 'You', order, status, due } })),
});
/** A column as the board shows it. */
const column = (snapshot, status) => snapshot.records.filter(r => r.kind === 'commitment' && taskStatus(r) === status)
  .sort((a, b) => sortTasks(a, b, NOW, 'UTC')).map(r => r.id);

test('a card dropped next to an overdue card lands where it was dropped', async () => {
  // To do shows B (overdue, order 2000) above A (due next week, order 1000).
  const { ctl, snapshot } = harness({ snapshot: board([['A', 1000, 'todo', '2026-11-25'], ['B', 2000, 'todo', '2026-11-17'], ['C', 500, 'waiting'], ['D', 600, 'waiting'], ['E', 700, 'waiting', '2026-11-10']]) });
  assert.deepEqual(column(snapshot, 'todo'), ['B', 'A']);
  await ctl.onDrop('C', 'todo', 'A');
  assert.deepEqual(column(snapshot, 'todo'), ['B', 'C', 'A'], 'between B and A');
  // At the very top: the first of the cards that are not overdue (overdue ones stay first).
  await ctl.onDrop('D', 'todo', 'B');
  assert.deepEqual(column(snapshot, 'todo'), ['B', 'D', 'C', 'A']);
  // An overdue card dropped among the others goes to the end of the overdue ones.
  await ctl.onDrop('E', 'todo', 'A');
  assert.deepEqual(column(snapshot, 'todo'), ['B', 'E', 'D', 'C', 'A']);
  // Reordering inside the overdue group.
  await ctl.onDrop('E', 'todo', 'B');
  assert.deepEqual(column(snapshot, 'todo'), ['E', 'B', 'D', 'C', 'A']);
});

test('repeated drops into one gap renumber the column and keep their places', async () => {
  const cards = Array.from({ length: 40 }, (_, i) => [`c${i}`, 100 + i, 'waiting']);
  const { ctl, snapshot, calls } = harness({ snapshot: board([['X', 1_795_000_000, 'todo'], ['Y', 1_795_000_001, 'todo'], ...cards]) });
  for (const [id] of cards) await ctl.onDrop(id, 'todo', 'Y');
  assert.deepEqual(column(snapshot, 'todo'), ['X', ...cards.map(([id]) => id), 'Y']);
  const orders = column(snapshot, 'todo').map(id => taskOrder(snapshot.records.find(r => r.id === id)));
  assert.ok(orders.every((o, i) => i === 0 || o - orders[i - 1] >= 1e-3), 'room between every two cards');
  // Renumbering saved only orders.
  const renumbered = calls.mutate.filter(([, d]) => !('status' in d));
  assert.ok(renumbered.length > 0 && renumbered.every(([op, d]) => op === 'task_save' && Object.keys(d).sort().join() === 'id,order'));
});

test('keyboard focus follows a moved card, and goes to the next card after delete or dismiss', async () => {
  const { ctl, calls } = harness({ answers: { task_delete: data => ({ deleted: true, id: data.id, body: {} }) } });
  const first = list => (Array.isArray(list) ? list[0] : list);
  // Move to: the card's ⋯ in its new column; from the drawer, focus stays in the drawer.
  await ctl.handle('task-move', control({ id: 'task-legal', col: 'waiting' }));
  assert.equal(first(calls.focus.at(-1)), '[data-menu-trigger="task-legal"]');
  const focused = calls.focus.length;
  await ctl.handle('task-move', control({ id: 'task-names', col: 'doing' }, { closest: sel => (sel === '.ws-task-drawer' ? {} : null) }));
  assert.equal(calls.focus.length, focused, 'the drawer keeps its own focus');
  // Dismiss the last card of To review: focus goes to the one above it.
  await ctl.handle('task-dismiss', control({ id: 'task-bug' }));
  assert.equal(first(calls.focus.at(-1)), '[data-task="task-share"] .ws-task-title');
  // Accept: the card's title in To do.
  await ctl.handle('task-accept', control({ id: 'task-share' }));
  assert.equal(first(calls.focus.at(-1)), '[data-task="task-share"] .ws-task-title');
  // Delete: the next card of the column (To do: legal moved away, so names, tenant, share, …).
  await ctl.handle('task-delete', control({ id: 'task-tenant' }));
  const after = calls.focus.at(-1);
  assert.ok(Array.isArray(after) && after[0].startsWith('[data-task="') && after[0] !== '[data-task="task-tenant"] .ws-task-title', JSON.stringify(after));
  assert.equal(after.at(-1), '[data-action="task-new"]', 'something to land on, always');

});

test('Enter that confirms an input method candidate does not add the task', async () => {
  const { ctl } = harness();
  let submitted = 0;
  const target = { matches: () => true, form: { requestSubmit: () => { submitted++; } } };
  const key = extra => ({ key: 'Enter', shiftKey: false, preventDefault() {}, target, ...extra });
  assert.equal(await ctl.key(key({ isComposing: true })), false);
  assert.equal(await ctl.key(key({ keyCode: 229 })), false);
  assert.equal(submitted, 0);
  assert.equal(await ctl.key(key({})), true);
  assert.equal(submitted, 1);
});

test('a typed due date saves once, only when it changed', async () => {
  const { ctl, calls } = harness();
  await ctl.handle('task-due', control({ id: 'task-legal' }, { value: '2026-11-15' }));
  assert.equal(calls.mutate.length, 0, 'unchanged');
  await ctl.handle('task-due', control({ id: 'task-legal' }, { value: '2026-11-27' }));
  assert.deepEqual(calls.mutate[0], ['task_save', { id: 'task-legal', due: '2026-11-27' }]);
});

test('a date typed only in part, left behind, keeps the due date', async () => {
  const { ctl, calls } = harness();
  // The field reads "" while its text isn't a whole date (validity.badInput): nothing is cleared.
  await ctl.handle('task-due', control({ id: 'task-legal' }, { value: '', validity: { badInput: true } }));
  assert.equal(calls.mutate.length, 0);
  // Emptied on purpose: the date goes.
  await ctl.handle('task-due', control({ id: 'task-legal' }, { value: '', validity: { badInput: false } }));
  assert.deepEqual(calls.mutate[0], ['task_save', { id: 'task-legal', due: null }]);
});

test('the task provider operations rebase onto a fresh snapshot (native fences them itself)', () => {
  for (const op of ['task_provider_set', 'task_withdraw', 'task_bulk', 'task_handled', 'task_parked']) assert.ok(REBASE_SAFE.has(op), op);
});
