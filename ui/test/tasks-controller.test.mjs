// The Tasks controller with its store, dialogs and navigation faked: drops, the Move to menu,
// delete with Undo, quick add, review and the drawer's fields.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createTasksController } from '../workspace/tasks-controller.js';
import { tasksPage } from '../workspace/view-tasks.js';
import { newTasksView, taskOrder, sortTasks, taskStatus } from '../workspace/tasks-model.js';
import { buildSnapshot, withTasks, taskContract } from './fixtures/workspace-fixture.mjs';
import { REBASE_SAFE } from '../workspace/store.js';

const NOW = Date.UTC(2026, 10, 18, 12);

/** A controller over fakes. `mutate` applies saves and deletes to the snapshot, as the snapshot
 *  after a real write would show them; `answers` maps an op to what it returns. */
function harness({ answers = {}, snapshot = withTasks(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), NOW) } = {}) {
  const calls = { mutate: [], render: 0, toasts: [], modals: [], meetings: [], focus: [], replies: [], queries: [], links: [] };
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
      if (op === 'task_handled' && stored && data.action === 'done') Object.assign(stored.data, { status: 'done', done: true, handled: null });
      if (typeof answers[op] === 'function') return answers[op](data);
      if (answers[op]) return answers[op];
      if (op === 'task_bulk') {
        // As native's `bulk`: each item saved, `before` what each had.
        const before = [];
        for (const item of data.items) {
          const t = snapshot.records.find(r => r.kind === 'commitment' && r.id === item.id);
          if (!t) continue;
          before.push({ id: t.id, due: t.data.due ?? null, status: taskStatus(t) });
          Object.assign(t.data, 'due' in item ? { due: item.due } : {}, 'status' in item ? { status: item.status, done: item.status === 'done' } : {});
        }
        return { done: before.length, failed: data.items.length - before.length, before };
      }
      return { id: data.id || 'task-new' };
    },
    // What the page draws after each render (By date's footer, rows).
    render: async () => { calls.render++; calls.html = tasksPage(snapshot, { state, now: NOW }); },
    openModal: options => { calls.modals.push(options); return { querySelector: () => null }; },
    confirmModal: options => { calls.modals.push(options); },
    toast: (message, tone, action) => calls.toasts.push({ message, tone, action }),
    openMeeting: (...args) => calls.meetings.push(args),
    focus: selector => calls.focus.push(selector),
    openReply: (...args) => calls.replies.push(args),
    openLink: (...args) => calls.links.push(args),
    query: async (op, data) => { calls.queries.push([op, data]); return { queued: true }; },
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

// ---------------------------------------------------------------- By date (task provider §9)

const STATES = JSON.parse(readFileSync(new URL('./fixtures/contract/task-provider-states.json', import.meta.url), 'utf8'));
/** Todoist active, three late tasks (one a check-in with Marek from a synced chat), one that
 *  looks handled and one parked. */
const todoist = () => ({
  settings: { timeZone: 'UTC', meetings: {} }, connection: { displayName: 'Taylor Morgan', email: 'taylor.morgan@example.test' },
  taskProvider: STATES.ready,
  records: [
    { id: 'm-marek', kind: 'message', data: { channel: 'chat', from: 'Marek Nowak', conversationId: 'c1' } },
    ...[
      ['late-1', { due: '2026-11-16' }],
      ['late-2', { due: '2026-11-17', status: 'doing' }],
      ['late-3', { text: 'the pilot user list', owner: 'marek@example.test', ownerName: 'Marek Nowak', kind: 'waiting', status: 'waiting', due: '2026-11-17', sourceId: 'm-marek' }],
      ['handled', { due: '2026-11-18', handled: { evidence: 'you replied in Teams 17:32', at: 0, auto: false } }],
      ['parked', { due: '2026-11-20', pending: true, syncError: 'Todoist needs a date like 2026-11-20.' }],
      ['other', { provider: undefined, due: '2026-11-10' }],
    ].map(([id, data], i) => ({ id, kind: 'commitment', updatedAt: 0, data: { text: id, owner: 'You', status: 'todo', order: i, provider: 'plugin:todoist', ...data } })),
  ],
});

test('Move all to Tomorrow is one task_bulk with Undo sending before', async () => {
  const before = [{ id: 'late-1', due: '2026-11-16', status: 'todo' }, { id: 'late-2', due: '2026-11-17', status: 'doing' }, { id: 'late-3', due: '2026-11-17', status: 'waiting' }];
  const { ctl, state, calls } = harness({ snapshot: todoist(), answers: { task_bulk: data => ({ done: data.items.length, failed: 0, before }) } });
  await ctl.handle('tasks-late-move', control({ to: 'tomorrow' }));
  assert.equal(calls.mutate.length, 1);
  assert.deepEqual(calls.mutate[0], ['task_bulk', { items: ['late-1', 'late-2', 'late-3'].map(id => ({ id, due: '2026-11-19' })) }]);
  assert.equal(state.tasks.footer.text, 'Moved 3 to Tomorrow');
  await ctl.handle('tasks-undo', control());
  assert.deepEqual(calls.mutate[1], ['task_bulk', { items: before }]);
  assert.equal(state.tasks.footer, null, 'Undo is used once');
  // Monday, and Done all.
  await ctl.handle('tasks-late-move', control({ to: 'monday' }));
  assert.deepEqual(calls.mutate[2][1].items[0], { id: 'late-1', due: '2026-11-23' });
  assert.equal(state.tasks.footer.text, 'Moved 3 to Monday');
  await ctl.handle('tasks-late-done', control());
  assert.deepEqual(calls.mutate[3], ['task_bulk', { items: ['late-1', 'late-2', 'late-3'].map(id => ({ id, status: 'done' })) }]);
  assert.equal(state.tasks.footer.text, 'Marked 3 done');
  // Pick date… asks for the day first, then moves them all to it.
  await ctl.handle('tasks-late-move', control({ to: 'pick' }));
  assert.equal(calls.mutate.length, 4, 'nothing before a day is picked');
  const form = new Map([['due', '2026-11-30']]);
  await calls.modals.at(-1).onSubmit(form);
  assert.deepEqual(calls.mutate[4][1].items.map(i => i.due), ['2026-11-30', '2026-11-30', '2026-11-30']);
  assert.match(state.tasks.footer.text, /^Moved 3 to /);
});

test('Nudge opens the thread with the prefilled line and sends nothing', async () => {
  const { ctl, calls } = harness({ snapshot: todoist() });
  await ctl.handle('task-nudge', control({ id: 'late-3' }));
  assert.deepEqual(calls.replies, [['m-marek', 'Hi Marek, any news on the pilot user list?']]);
  assert.equal(calls.mutate.length, 0, 'nothing written, nothing sent');
  // A task without a synced thread has no Nudge.
  await ctl.handle('task-nudge', control({ id: 'late-1' }));
  assert.equal(calls.replies.length, 1);
});

test('Keep open sends task_handled keep; Discard change sends task_parked discard', async () => {
  const { ctl, calls } = harness({ snapshot: todoist() });
  await ctl.handle('task-handled', control({ id: 'handled', act: 'keep' }));
  await ctl.handle('task-handled', control({ id: 'handled', act: 'done' }));
  await ctl.handle('task-parked', control({ id: 'parked', act: 'discard' }));
  await ctl.handle('task-parked', control({ id: 'parked', act: 'retry' }));
  assert.deepEqual(calls.mutate, [
    ['task_handled', { id: 'handled', action: 'keep' }],
    ['task_handled', { id: 'handled', action: 'done' }],
    ['task_parked', { id: 'parked', action: 'discard' }],
    ['task_parked', { id: 'parked', action: 'retry' }],
  ]);
});

test('By date: folds, a row unfolds alone, snooze, Sync now, Open in Todoist and the view switch', async () => {
  const snap = todoist();
  snap.records.find(r => r.id === 'late-1').data.remote = { url: 'https://app.todoist.com/app/task/1' };
  const { ctl, state, calls } = harness({ snapshot: snap });
  await ctl.handle('tasks-fold', control({ fold: 'next7' }));
  assert.equal(state.tasks.folds.next7, true);
  await ctl.handle('tasks-fold', control({ fold: 'next7' }));
  assert.equal(state.tasks.folds.next7, false);
  await ctl.handle('task-row-open', control({ id: 'late-1' }));
  assert.equal(state.tasks.rowOpen, 'late-1');
  await ctl.handle('task-row-open', control({ id: 'late-2' }));
  assert.equal(state.tasks.rowOpen, 'late-2', 'one row unfolded at a time');
  await ctl.handle('task-row-open', control({ id: 'late-2' }));
  assert.equal(state.tasks.rowOpen, null);
  await ctl.handle('task-snooze', control({ id: 'late-1', value: '2026-11-23' }));
  assert.deepEqual(calls.mutate.at(-1), ['task_save', { id: 'late-1', due: '2026-11-23' }]);
  await ctl.handle('task-pick-date', control({ id: 'late-1' }));
  await calls.modals.at(-1).onSubmit(new Map([['due', '2026-12-02']]));
  assert.deepEqual(calls.mutate.at(-1), ['task_save', { id: 'late-1', due: '2026-12-02' }]);
  await ctl.handle('tasks-sync', control());
  assert.deepEqual(calls.queries, [['task_sync_now', {}]]);
  await ctl.handle('task-open-remote', control({ id: 'late-1' }));
  assert.deepEqual(calls.queries.at(-1), ['open_source', { kind: 'task', id: 'late-1' }]);
  // The view switch: with a provider the choice is the provider's, Local keeps its own.
  await ctl.handle('tasks-view', control({ view: 'list' }));
  assert.deepEqual([state.tasks.providerView, state.tasks.view], ['list', 'board']);
  await ctl.handle('tasks-view', control({ view: 'board' }));
  assert.equal(state.tasks.providerView, 'list', 'no Board with a provider');
});

/** The By date done box of task `id`. */
const doneBox = id => control({ id }, { type: 'checkbox', checked: true, closest: sel => (sel === '.ws-tdate' ? {} : null) });
const footerOf = html => html.match(/<p class="ws-tdate-foot"[^]*?<\/p>/)?.[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const rowIn = (html, id) => html.includes(`data-task="${id}"`);

test('By date: every completion leaves the row and draws "Marked 1 done · Undo", and Undo brings it back', async () => {
  const { ctl, state, calls } = harness({ snapshot: todoist() });
  state.tasks.rowOpen = 'late-2';
  // The done box.
  await ctl.handle('task-done', doneBox('late-2'));
  assert.ok(!rowIn(calls.html, 'late-2'), 'the row left');
  assert.equal(footerOf(calls.html), '0 done today · Marked 1 done · Undo');
  assert.equal(calls.toasts.length, 0, 'no toast of its own');
  await ctl.handle('tasks-undo', control());
  assert.deepEqual(calls.mutate.at(-1), ['task_bulk', { items: [{ id: 'late-2', due: '2026-11-17', status: 'doing' }] }]);
  assert.ok(rowIn(calls.html, 'late-2'), 'back on the page');
  assert.equal(footerOf(calls.html), '0 done today');
  // Looks handled › Done finishes the same way.
  await ctl.handle('task-handled', control({ id: 'handled', act: 'done' }));
  assert.deepEqual(calls.mutate.at(-1), ['task_handled', { id: 'handled', action: 'done' }]);
  assert.ok(!rowIn(calls.html, 'handled'));
  assert.equal(footerOf(calls.html), '0 done today · Marked 1 done · Undo');
  assert.equal(calls.toasts.length, 0);
  await ctl.handle('tasks-undo', control());
  assert.deepEqual(calls.mutate.at(-1), ['task_bulk', { items: [{ id: 'handled', due: '2026-11-18', status: 'todo' }] }]);
});

test('a failed Undo keeps the footer and its Undo; the Undo of another provider is dropped', async () => {
  let fail = true;
  const { ctl, state, calls, snapshot } = harness({ snapshot: todoist(), answers: { task_bulk: () => { if (fail) throw new Error('offline'); return { done: 1, failed: 0, before: [] }; } } });
  state.tasks.footer = { text: 'Marked 1 done', undo: [{ id: 'late-1', due: '2026-11-16', status: 'todo' }], provider: 'plugin:todoist' };
  await assert.rejects(ctl.handle('tasks-undo', control()), /offline/);
  assert.equal(state.tasks.footer?.text, 'Marked 1 done', 'Undo stays to try again');
  fail = false;
  // Back to Local: the footer's Undo was Todoist's.
  snapshot.taskProvider = STATES.local;
  await ctl.handle('tasks-fold', control({ fold: 'next7' }));
  assert.equal(state.tasks.footer, null);
  const before = calls.mutate.length;
  await ctl.handle('tasks-undo', control());
  assert.equal(calls.mutate.length, before);
});

test('Late ⋯ acts on the tasks and the day the screen showed, in batches of 200', async () => {
  const { ctl, state, calls } = harness({ snapshot: todoist() });
  // Drawn yesterday: two late tasks and yesterday's Tomorrow, whatever the clock says now.
  await ctl.handle('tasks-late-move', control({ to: 'tomorrow', day: '2026-11-18', ids: '["late-1","late-3"]' }));
  assert.deepEqual(calls.mutate.at(-1), ['task_bulk', { items: [{ id: 'late-1', due: '2026-11-18' }, { id: 'late-3', due: '2026-11-18' }] }]);
  assert.equal(state.tasks.footer.text, 'Moved 2 to Tomorrow');
  assert.ok(calls.html.includes('Moved 2 to Tomorrow'), 'drawn');
  await ctl.handle('tasks-late-done', control({ ids: '["late-2"]' }));
  assert.deepEqual(calls.mutate.at(-1), ['task_bulk', { items: [{ id: 'late-2', status: 'done' }] }]);
  // 450 shown: three writes of at most 200, one footer, one Undo over all of them.
  const ids = Array.from({ length: 450 }, (_, i) => `x${i}`);
  const big = harness({ snapshot: todoist(), answers: { task_bulk: d => ({ done: d.items.length, failed: 0, before: d.items.map(i => ({ id: i.id, due: null, status: 'todo' })) }) } });
  await big.ctl.handle('tasks-late-move', control({ to: 'monday', day: '2026-11-23', ids: JSON.stringify(ids) }));
  assert.deepEqual(big.calls.mutate.map(([, d]) => d.items.length), [200, 200, 50]);
  assert.equal(big.state.tasks.footer.text, 'Moved 450 to Monday');
  await big.ctl.handle('tasks-undo', control());
  assert.deepEqual(big.calls.mutate.slice(3).map(([, d]) => d.items.length), [200, 200, 50]);
});

test('By date rows: a closed row has only its done box; an unfolded one at most three controls', async () => {
  const snap = todoist();
  snap.records.find(r => r.id === 'late-1').data.remote = { url: 'https://app.todoist.com/app/task/1' };
  const { ctl, state, calls } = harness({ snapshot: snap });
  await ctl.handle('tasks-fold', control({ fold: 'next7' }));
  /** The controls of row `id` besides the row itself (its unfold button) and the done box,
   *  outside its ⋯ and Snooze ▾ menus' panels. */
  const controls = id => {
    const row = calls.html.match(new RegExp(`<div class="ws-tdate-row[^"]*" data-task="${id}">[^]*?(?=<div class="ws-tdate-row|</div></div><footer|<section|$)`))[0];
    const outside = row.replace(/<div class="ws-menu-panel">[^]*?<\/div><\/details>/g, '</details>');
    return [...outside.matchAll(/<(button|summary)[^>]*>([^]*?)<\/\1>/g)]
      .filter(m => !/ws-tdate-main/.test(m[0])).map(m => m[2].replace(/<[^>]+>/g, '').trim() || 'icon');
  };
  for (const id of ['late-1', 'late-3', 'handled', 'parked']) assert.deepEqual(controls(id), [], `${id} closed`);
  // `tasks-older` only re-renders By date.
  const redraw = () => ctl.handle('tasks-older', control());
  state.tasks.rowOpen = 'late-3';
  await redraw();
  assert.deepEqual(controls('late-3'), ['Nudge Marek', 'Snooze ▾', 'icon']);
  assert.match(calls.html, /data-action="task-nudge"[^>]*class="ws-btn ws-btn-primary|class="ws-btn ws-btn-primary[^"]*"[^>]*data-action="task-nudge"/);
  assert.ok(!/class="ws-tdate-chip"/.test(calls.html), 'no date chips beside Snooze ▾');
  const without = { 'late-1': ['Snooze ▾', 'icon'], handled: ['Done', 'Keep open', 'icon'], parked: ['Try again', 'Discard change', 'icon'] };
  for (const [id, want] of Object.entries(without)) {
    state.tasks.rowOpen = id;
    await redraw();
    assert.deepEqual(controls(id), want, id);
  }
  // Open in Todoist ↗ lives in the row's ⋯.
  state.tasks.rowOpen = 'late-1';
  await redraw();
  assert.match(calls.html, /<div class="ws-menu-panel">[^]*?Open in Todoist ↗/);
});


// ---------------------------------------------------------------- the provider everywhere (Task 9)

test('delete with a provider asks first; Undo saves the body back', async () => {
  const snap = todoist();
  const body = { ...snap.records.find(r => r.id === 'late-1').data };
  const { ctl, calls } = harness({ snapshot: snap, answers: { task_delete: data => ({ deleted: true, id: data.id, body }) } });
  await ctl.handle('task-delete', control({ id: 'late-1' }));
  assert.equal(calls.mutate.length, 0, 'nothing deleted before the confirm');
  const modal = calls.modals.at(-1);
  assert.match(modal.body, /Delete “late-1” in Todoist too\? Undo makes it again as a new task\./);
  assert.equal(modal.variant, 'danger');
  await modal.onSubmit(new Map());
  assert.deepEqual(calls.mutate[0], ['task_delete', { id: 'late-1' }]);
  const toast = calls.toasts.at(-1);
  assert.equal(toast.message, 'Deleted “late-1”');
  await toast.action.run();
  assert.deepEqual(calls.mutate[1], ['task_save', { ...body, id: 'late-1' }]);
  // Local deletes at once, as before.
  const local = harness();
  await local.ctl.handle('task-delete', control({ id: 'task-room' }));
  assert.equal(local.calls.modals.length, 0);
  assert.deepEqual(local.calls.mutate[0], ['task_delete', { id: 'task-room' }]);
});

/** The page heading's text, tags dropped. */
const headingOf = html => html.match(/<header class="ws-page-heading ws-tasks-heading">[^]*?<\/header>/)[0];
const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the Tasks header: the provider status line, ⋯ › Sync now and Settings › Tasks, the meeting chip, a description for the view', async () => {
  const snap = todoist();
  snap.taskProvider = { ...STATES.ready, lastSync: Math.floor(NOW / 1000) - 300 };
  snap.records.push({ id: 'mtg-1', kind: 'meeting', data: { title: 'Philips sync', start: '2026-11-17T10:00:00Z' } });
  snap.records.find(r => r.id === 'late-1').data.meetingId = 'mtg-1';
  const { ctl, state, calls } = harness({ snapshot: snap });
  await ctl.handle('tasks-older', control());
  let head = headingOf(calls.html);
  assert.match(head, /<p class="ws-tasks-line" role="status">Todoist · synced 5 min ago<\/p>/);
  assert.doesNotMatch(textOf(head), /Drag cards/, 'By date has no cards to drag');
  assert.match(head, /data-menu="tasks-more"[^]*?data-action="tasks-sync"[^>]*>[^]*?Sync now[^]*?data-action="settings-tab" data-tab="meetings-tasks"[^]*?Settings › Tasks/);
  assert.doesNotMatch(head, /ws-tasks-chip/, 'no chip without a meeting filter');
  // "1 in Todoist ›" from the meeting: the chip, and By date shows that meeting's tasks only.
  state.tasks.filters.meeting = 'mtg-1';
  await ctl.handle('tasks-older', control());
  head = headingOf(calls.html);
  assert.match(head, /<button type="button" class="ws-tasks-chip" data-action="tasks-meeting-clear" aria-label="Show the tasks of every meeting">From Philips sync ✕<\/button>/);
  assert.ok(calls.html.includes('data-task="late-1"') && !calls.html.includes('data-task="late-2"'), 'only the meeting’s tasks');
  await ctl.handle('tasks-meeting-clear', control());
  assert.equal(state.tasks.filters.meeting, '');
  assert.ok(calls.html.includes('data-task="late-2"'));
  await ctl.handle('tasks-sync', control());
  assert.deepEqual(calls.queries.at(-1), ['task_sync_now', {}]);
  // Local: "Connect · on this Mac", no ⋯, the Board's own description.
  const local = harness();
  await local.ctl.handle('tasks-older', control());
  head = headingOf(local.calls.html);
  assert.match(head, /<p class="ws-tasks-line" role="status">Connect · on this Mac<\/p>/);
  assert.match(textOf(head), /Drag cards between columns/);
  assert.doesNotMatch(head, /tasks-more/);
});

test('Open in Todoist ↗ opens the task’s own link from Connect, only for a Todoist address', async () => {
  const snap = todoist();
  snap.records.find(r => r.id === 'late-1').data.remote = { url: 'https://app.todoist.com/app/task/1' };
  snap.records.find(r => r.id === 'late-2').data.remote = { url: 'https://evil.example/app/task/2' };
  const { ctl, state, calls } = harness({ snapshot: snap });
  await ctl.handle('task-open-remote', control({ id: 'late-1' }));
  assert.deepEqual(calls.queries, [['open_source', { kind: 'task', id: 'late-1' }]]);
  assert.deepEqual(calls.links, [], 'not through the plugin link confirmation');
  state.tasks.rowOpen = 'late-2';
  await ctl.handle('tasks-older', control());
  const row = calls.html.match(/data-task="late-2">[^]*?(?=<div class="ws-tdate-row|$)/)[0];
  assert.doesNotMatch(row, /Open in Todoist/, 'another host is not offered');
  await ctl.handle('task-open-remote', control({ id: 'late-2' }));
  assert.equal(calls.queries.length, 1, 'nor opened');
});

test('a parked change whose sentence was withheld reads "<Provider> refused this change." with Try again and Discard change', async () => {
  const snap = todoist();
  snap.records.find(r => r.id === 'parked').data.syncError = '';
  const { ctl, state, calls } = harness({ snapshot: snap });
  state.tasks.folds = { next7: true };
  state.tasks.rowOpen = 'parked';
  await ctl.handle('tasks-older', control());
  const row = calls.html.match(/data-task="parked">[^]*?(?=<div class="ws-tdate-row|$)/)[0];
  assert.match(row, /<p class="ws-tdate-error" id="tdate-err-parked">Todoist refused this change\.<\/p>/);
  assert.match(row, /aria-describedby="tdate-err-parked"/);
  assert.match(row, /Try again[^]*Discard change/);
  // No sync error at all: an ordinary row.
  snap.records.find(r => r.id === 'parked').data.syncError = null;
  await ctl.handle('tasks-older', control());
  assert.doesNotMatch(calls.html, /ws-tdate-error/);
});
