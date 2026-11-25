import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, escapeHtml, REBASE_SAFE, refreshDelay } from '../workspace/store.js';
import { runReadOnlyProbe } from '../workspace/safe-probe.js';
import {
  calendarDays, calendarWindow, calendarCoverage, calendarIds, calendarColor, eventSpan, eventsOnDay,
  layoutColumns, freeSlots, groupCalendarEvents,
} from '../workspace/calendar-model.js';
import {
  dayKey, addDaysToKey, minutesOfDay, initials, firstName, relativeAge, agoLabel, countdownLabel, durationLabel, greeting, colorFor, formatTime, formatDate,
} from '../workspace/format.js';
import { attentionMessages, messageTitle, connectionState, decisions, sourceCounts, conversation, collapseChats } from '../workspace/selectors.js';
import { snoozeUntil, filteredMessages, inbox, inboxSections, INBOX_DOCK } from '../workspace/view-inbox.js';
import { today, todayModel, WIDGETS } from '../workspace/view-today.js';
import { PRESETS } from '../workspace/today-grid.js';
import { calendar, periodTitle, eventDetails, eventActions, CALENDAR_DOCK } from '../workspace/view-calendar.js';
import { normalizeDock, resizePair, swapPanes } from '../workspace/dock-model.js';
import { attachDock } from '../workspace/dock-controller.js';
import { settings, jobLabel } from '../workspace/view-settings.js';
import { renderShell, NAV } from '../workspace/shell.js';
import { bootWorkspace, notificationWorkspaceToSelect } from '../workspace/boot.js';
import { controlSelector, soleMatch } from '../workspace/ui.js';
import { tasksPage } from '../workspace/view-tasks.js';
import { createTasksController } from '../workspace/tasks-controller.js';
import { dueInfo, newTasksView, quickDates } from '../workspace/tasks-model.js';
import { meetings, makeNotesBody, shownCall } from '../workspace/view-meetings.js';
import { createMeetingsController } from '../workspace/meetings-controller.js';
import { callOfMeeting, meetingItems, newMeetingsView } from '../workspace/meetings-model.js';
import { active } from '../workspace/selectors.js';
import { buildSnapshot, withTasks, withMeetings, meetingFolders, meetingContract } from './fixtures/workspace-fixture.mjs';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------- store

test('the fixture snapshot carries the note templates native sends', () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/contract/note-templates.json', import.meta.url), 'utf8'));
  for (const connected of [true, false]) {
    const { noteTemplates } = buildSnapshot(Date.now(), { connected });
    assert.deepEqual(noteTemplates, native);
  }
  assert.deepEqual(native.map(t => [t.id, t.kind, t.edited]), [['meeting-notes', 'builtin', false], ['short-summary', 'builtin', false]]);
  assert.match(native[0].prompt, /^You turn one meeting transcript into meeting notes for \{\{me\}\}\./);
});

test('the probe only invokes explicit read-only inspectors', async () => {
  const calls = [];
  const inspectors = new Proxy(Object.fromEntries(['checkGit', 'checkNode', 'checkNpm', 'checkCodemie'].map(k => [k, async () => { calls.push(k); return { ok: true }; }])), {
    get(target, key) { if (!(key in target)) throw Error(`Mutation or unsupported probe: ${key}`); return target[key]; },
  });
  assert.equal(Object.keys(await runReadOnlyProbe(inspectors)).length, 4);
  assert.deepEqual(calls, ['checkGit', 'checkNode', 'checkNpm', 'checkCodemie']);
});

test('workspace mutations serialize against refreshed native revisions', async () => {
  let revision = 0;
  const mutations = [];
  const store = createStore(async (_, { request: r }) => {
    if (r.op === 'snapshot') return { snapshot: { revision, settings: { activeWorkspace: 'personal' } } };
    assert.equal(r.expectedRevision, revision);
    assert.ok(r.operationId);
    mutations.push(r.op);
    await new Promise(resolve => setTimeout(resolve, 5));
    revision++;
    return { saved: true };
  });
  await store.refresh();
  await Promise.all([store.mutate('workspace_create', { name: 'A' }), store.mutate('settings_update', { theme: 'dark' })]);
  assert.deepEqual(mutations, ['workspace_create', 'settings_update']);
  assert.equal(store.get().snapshot.revision, 2);
});

/** A native stand-in whose snapshot reads wait until the test lets them go (`reads[i].go()`); a
 *  read sees `value` as it was when the read was asked, as native does. */
function slowReads() {
  const bridge = { value: 0, reads: [], writes: [] };
  bridge.invoke = (_, { request: r }) => {
    if (r.op === 'snapshot') {
      const seen = bridge.value;
      return new Promise(resolve => bridge.reads.push({ seen, go: () => resolve({ snapshot: { revision: seen, value: seen, settings: { activeWorkspace: 'personal' } } }) }));
    }
    return new Promise(resolve => bridge.writes.push({ go: () => { bridge.value = r.data.value; resolve({ saved: true }); } }));
  };
  return bridge;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('a write settles on its own read, not on a background read asked after it', async () => {
  const bridge = slowReads();
  const store = createStore(bridge.invoke);
  const loaded = store.refresh();
  bridge.reads[0].go();
  await loaded;
  const shown = [];
  store.subscribe(r => shown.push(r.snapshot.value));
  let settled = false;
  const write = store.mutate('layout_save', { value: 1 }).then(() => { settled = true; });
  await tick();
  bridge.writes[0].go();
  await tick();
  // The write's own read is on its way when a workspace:changed starts another one.
  assert.equal(bridge.reads.length, 2);
  const background = store.refresh();
  bridge.reads[1].go();
  await tick();
  await tick();
  // Its own read has the write: shown and settled without waiting for the later read (a full
  // snapshot of a real workspace takes about a second).
  assert.equal(settled, true);
  assert.equal(store.get().snapshot.value, 1);
  assert.deepEqual(shown, [1]);
  bridge.reads[2].go();
  await write;
  await background;
  assert.equal(store.get().snapshot.value, 1);
  assert.deepEqual(shown, [1, 1]);
});

test('a read that lands after a newer one is dropped: the view never goes back', async () => {
  const bridge = slowReads();
  const store = createStore(bridge.invoke);
  const shown = [];
  store.subscribe(r => shown.push(r.snapshot.value));
  const older = store.refresh();
  bridge.value = 1;
  const newer = store.refresh();
  bridge.reads[1].go();
  await newer;
  bridge.reads[0].go();
  // The overtaken read settles with the newer state.
  assert.equal((await older).snapshot.value, 1);
  assert.equal(store.get().snapshot.value, 1);
  assert.deepEqual(shown, [1]);
});

test('a read asked while a write is sent, landing before the write’s own read, is not shown', async () => {
  const bridge = slowReads();
  const store = createStore(bridge.invoke);
  const loaded = store.refresh();
  bridge.reads[0].go();
  await loaded;
  const shown = [];
  store.subscribe(r => shown.push(r.snapshot.value));
  const write = store.mutate('meeting_set', { value: 1 });
  await tick();
  // Native may answer this read before it applies the write.
  const background = store.refresh();
  bridge.writes[0].go();
  await tick();
  assert.equal(bridge.reads.length, 3);
  bridge.reads[1].go();
  await background;
  // Drawn, it would put back the switch the person just turned on.
  assert.deepEqual(shown, []);
  bridge.reads[2].go();
  await write;
  assert.deepEqual(shown, [1]);
  assert.equal(store.get().snapshot.value, 1);
});

test('a workspace:changed heard before a read was asked needs no read of its own', async () => {
  let clock = 0;
  const bridge = slowReads();
  const store = createStore(bridge.invoke, { now: () => clock });
  const loaded = store.refresh();
  bridge.reads[0].go();
  await loaded;
  // A write: native announces its change before it answers, then the write reads.
  const write = store.mutate('task_save', { value: 1 });
  await tick();
  clock = 10;
  const heard = clock;
  bridge.writes[0].go();
  clock = 20;
  await tick();
  assert.equal(bridge.reads.length, 2);
  // The echo of the write's own change: its own read, asked after it, already brings it.
  const echo = store.refreshAfter(heard);
  assert.equal(bridge.reads.length, 2);
  bridge.reads[1].go();
  await write;
  assert.equal((await echo).snapshot.value, 1);
  // A change heard after the last read was asked is read.
  clock = 30;
  const later = store.refreshAfter(clock);
  assert.equal(bridge.reads.length, 3);
  bridge.reads[2].go();
  await later;
});

test('a background read that lands while a write is being sent is not shown; the write’s own read is', async () => {
  const bridge = slowReads();
  const store = createStore(bridge.invoke);
  const loaded = store.refresh();
  bridge.reads[0].go();
  await loaded;
  const shown = [];
  store.subscribe(r => shown.push(r.snapshot.value));
  // A workspace:changed read asked before the write lands while the write is on its way: drawn,
  // it would put back the switch the person just turned on.
  const background = store.refresh();
  const write = store.mutate('meeting_set', { value: 1 });
  await tick();
  bridge.reads[1].go();
  await background;
  assert.deepEqual(shown, []);
  bridge.writes[0].go();
  await tick();
  bridge.reads[2].go();
  await write;
  assert.deepEqual(shown, [1]);
  assert.equal(store.get().snapshot.value, 1);
});

test('a rejected mutation refreshes canonical state before the next write', async () => {
  let revision = 0;
  const store = createStore(async (_, { request: r }) => {
    if (r.op === 'snapshot') return { snapshot: { revision, settings: { activeWorkspace: 'personal' } } };
    if (r.op === 'first') { revision = 3; throw { code: 'conflict' }; }
    assert.equal(r.expectedRevision, 3);
    return {};
  });
  await store.refresh();
  await assert.rejects(store.mutate('first'));
  await store.mutate('second');
});

test('mutate retries once after stale_view for rebase-safe ops', async () => {
  let revision = 0;
  const calls = [];
  const store = createStore(async (_, { request: r }) => {
    if (r.op === 'snapshot') return { snapshot: { revision, settings: { activeWorkspace: 'personal' } } };
    calls.push(r);
    if (calls.length === 1) { revision = 5; throw { code: 'stale_view' }; }
    return { saved: true };
  });
  await store.refresh();
  assert.deepEqual(await store.mutate('settings_update', { theme: 'dark' }, 'ws-2'), { saved: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].expectedRevision, 0);
  assert.equal(calls[1].expectedRevision, 5);
  assert.equal(calls[1].operationId, calls[0].operationId);
  assert.equal(calls[1].workspaceId, 'ws-2');
});

test('mutate rebases through a sync that keeps moving the revision, then gives up', async () => {
  let revision = 0;
  let writes = 0;
  let acceptAt = 4;
  const store = createStore(async (_, { request: r }) => {
    if (r.op === 'snapshot') return { snapshot: { revision, settings: { activeWorkspace: 'personal' } } };
    writes++;
    if (writes === acceptAt) return { ok: true, expectedRevision: r.expectedRevision };
    revision++;
    throw { code: 'stale_view' };
  });
  await store.refresh();
  // A mail sync writes record after record: the fourth try lands, on the revision it read last.
  assert.deepEqual(await store.mutate('meeting_check', {}), { ok: true, expectedRevision: 3 });
  writes = 0;
  acceptAt = Infinity;
  await assert.rejects(store.mutate('local_save', {}), { code: 'stale_view' });
  assert.equal(writes, 5, 'five tries, then the stale view is reported');
});

/** A native stand-in that counts what it is asked: reads, cheap revision reads and writes. Each
 *  write moves the revision by two (native reserves one and stores one). */
function countingNative({ refuse = () => null } = {}) {
  const bridge = { revision: 0, value: 0, ops: [] };
  bridge.invoke = async (_, { request: r }) => {
    bridge.ops.push(r.op);
    if (r.op === 'snapshot') return { snapshot: { revision: bridge.revision, value: bridge.value, settings: { activeWorkspace: 'personal' } } };
    if (r.op === 'revision') return { revision: bridge.revision };
    if (r.expectedRevision !== bridge.revision) throw { code: 'stale_view' };
    await tick();
    const refused = refuse(r);
    if (refused) throw refused;
    bridge.revision += 2;
    bridge.value = r.data.value;
    return { saved: true };
  };
  return bridge;
}
const preview = { task_save: (s, d) => ({ ...s, value: d.value }) };

test('a change with a preview shows the moment it is asked, before native answers', async () => {
  const bridge = slowReads();
  const store = createStore(bridge.invoke, { optimistic: preview });
  const loaded = store.refresh();
  bridge.reads[0].go();
  await loaded;
  const shown = [];
  store.subscribe(r => shown.push(r.snapshot.value));
  const write = store.mutate('task_save', { value: 1 });
  assert.equal(store.get().snapshot.value, 1, 'shown at once');
  assert.deepEqual(shown, [1]);
  await tick();
  bridge.writes[0].go();
  await tick();
  bridge.reads[1].go();
  await write;
  assert.equal(store.get().snapshot.value, 1, 'kept by the read that has it');
});

test('a refused change is taken back at once and its error still reaches the caller', async () => {
  const bridge = countingNative({ refuse: r => (r.data.value === 2 ? { code: 'validation', message: 'No.' } : null) });
  const store = createStore(bridge.invoke, { optimistic: preview });
  await store.refresh();
  const shown = [];
  store.subscribe(r => shown.push(r.snapshot.value));
  const write = store.mutate('task_save', { value: 2 });
  assert.equal(store.get().snapshot.value, 2);
  await assert.rejects(write, { code: 'validation' });
  assert.equal(store.get().snapshot.value, 0);
  assert.equal(shown.at(-1), 0, 'drawn back');
});

test('queued rebase-safe writes share one snapshot read; between them native is asked only its revision', async () => {
  const bridge = countingNative();
  const store = createStore(bridge.invoke, { optimistic: preview });
  await store.refresh();
  bridge.ops.length = 0;
  const writes = [1, 2, 3].map(value => store.mutate('task_save', { value }));
  assert.equal(store.get().snapshot.value, 3, 'every change shown at once');
  await Promise.all(writes);
  // Each settled when native answered it; the shared read follows.
  await store.refreshAfter(Infinity);
  assert.deepEqual(bridge.ops, ['task_save', 'revision', 'task_save', 'revision', 'task_save', 'snapshot']);
  assert.equal(store.get().snapshot.value, 3);
  assert.equal(store.get().snapshot.revision, 6);
});

test('a preview names a new record by the operation id the write is sent with', async () => {
  const sent = [];
  const seen = [];
  const store = createStore(async (_, { request: r }) => {
    if (r.op === 'snapshot') return { snapshot: { revision: sent.length, settings: { activeWorkspace: 'personal' } } };
    sent.push(r.operationId);
    return { id: r.operationId };
  }, { optimistic: { task_save: (s, d, { operationId }) => { seen.push(operationId); return { ...s, added: operationId }; } } });
  await store.refresh();
  const write = store.mutate('task_save', { text: 'New' });
  assert.ok(store.get().snapshot.added, 'shown at once');
  await write;
  assert.equal(new Set(seen).size, 1);
  assert.deepEqual(sent, [seen[0]]);
});

test('idle settles once the queue’s read has landed, after a previewed write already has', async () => {
  const bridge = slowReads();
  const store = createStore(bridge.invoke, { optimistic: preview });
  const loaded = store.refresh();
  bridge.reads[0].go();
  await loaded;
  const write = store.mutate('task_save', { value: 1 });
  let idle = false;
  const waiting = store.idle().then(() => { idle = true; });
  await tick();
  bridge.writes[0].go();
  await write;
  await tick();
  assert.equal(idle, false, 'the write settled; its read is still on its way');
  bridge.reads[1].go();
  await waiting;
  assert.equal(store.get().snapshot.value, 1);
  assert.equal((await store.idle()).snapshot.value, 1, 'nothing queued: at once');
});

test('a write that is not rebase-safe waits for a full read before it is sent', async () => {
  const bridge = countingNative();
  const store = createStore(bridge.invoke, { optimistic: preview });
  await store.refresh();
  bridge.ops.length = 0;
  await Promise.all([store.mutate('task_save', { value: 1 }), store.mutate('graph_disconnect', { value: 2 })]);
  assert.deepEqual(bridge.ops, ['task_save', 'snapshot', 'graph_disconnect', 'snapshot']);
});

test('without a revision read native answers, queued writes read the whole snapshot as before', async () => {
  const bridge = countingNative();
  const invoke = (cmd, args) => (args.request.op === 'revision' ? Promise.reject({ code: 'validation' }) : bridge.invoke(cmd, args));
  const store = createStore(invoke, { optimistic: preview });
  await store.refresh();
  bridge.ops.length = 0;
  await Promise.all([store.mutate('task_save', { value: 1 }), store.mutate('task_save', { value: 2 })]);
  assert.deepEqual(bridge.ops, ['task_save', 'snapshot', 'task_save', 'snapshot']);
  assert.equal(store.get().snapshot.value, 2);
});

test('a workspace:changed heard while writes are queued reads nothing: the queue’s last read brings it', async () => {
  const bridge = countingNative();
  const store = createStore(bridge.invoke, { optimistic: preview });
  await store.refresh();
  bridge.ops.length = 0;
  const writes = [1, 2].map(value => store.mutate('task_save', { value }));
  await store.refreshAfter(Infinity);
  await Promise.all(writes);
  assert.equal(bridge.ops.filter(op => op === 'snapshot').length, 1);
});

/** A native stand-in that answers `changes_since` with a delta of what `value` became (or a
 *  reset when told to), and counts its requests. */
function deltaNative() {
  const bridge = { revision: 1, value: 0, scope: 's1', ops: [], reset: false, fail: false };
  const answer = () => ({ snapshot: { revision: bridge.revision, records: [{ kind: 'v', id: 'v', connectionId: null, workspaceId: 'personal', data: { value: bridge.value } }], jobs: [], settings: { activeWorkspace: 'personal' } }, scope: bridge.scope, authPending: false, authError: null });
  bridge.invoke = async (_, { request: r }) => {
    bridge.ops.push(r.op);
    if (r.op === 'snapshot') return answer();
    if (r.op === 'revision') return { revision: bridge.revision };
    if (r.op === 'changes_since') {
      if (bridge.fail) throw { code: 'storage', message: 'boom' };
      if (bridge.reset || r.data.scope !== bridge.scope) return { reset: true };
      const a = answer();
      return { reset: false, revision: bridge.revision, scope: bridge.scope, records: a.snapshot.records, removed: [], replace: [], jobs: [], removedJobs: [], jobsAll: false, settings: a.snapshot.settings, workspaces: [], connection: null, available: true, meetingsRoot: null, noteTemplates: [], authPending: false, authError: null };
    }
    if (r.expectedRevision !== bridge.revision) throw { code: 'stale_view' };
    bridge.revision += 2;
    bridge.value = r.data.value;
    return { saved: true };
  };
  return bridge;
}
const valueOf = store => store.get().snapshot.records.find(r => r.kind === 'v').data.value;

test('with a snapshot in hand a read asks changes_since and applies it; a reset or an error reads the snapshot', async () => {
  const bridge = deltaNative();
  const store = createStore(bridge.invoke, { deltas: true });
  await store.refresh();
  bridge.value = 3;
  bridge.revision = 4;
  await store.refresh();
  assert.deepEqual(bridge.ops, ['snapshot', 'changes_since']);
  assert.equal(valueOf(store), 3);
  assert.equal(store.get().snapshot.revision, 4);
  bridge.reset = true;
  await store.refresh();
  assert.deepEqual(bridge.ops.slice(2), ['changes_since', 'snapshot']);
  bridge.reset = false;
  bridge.fail = true;
  await store.refresh();
  assert.deepEqual(bridge.ops.slice(4), ['changes_since', 'snapshot']);
});

test('a write with a preview settles on a delta, the preview laid over it until then', async () => {
  const bridge = deltaNative();
  const store = createStore(bridge.invoke, { deltas: true, optimistic: { task_save: (s, d) => ({ ...s, records: s.records.map(r => (r.kind === 'v' ? { ...r, data: { value: d.value } } : r)) }) } });
  await store.refresh();
  bridge.ops.length = 0;
  const writes = [5, 6].map(value => store.mutate('task_save', { value }));
  assert.equal(valueOf(store), 6, 'shown at once');
  await Promise.all(writes);
  await store.idle();
  assert.deepEqual(bridge.ops, ['task_save', 'revision', 'task_save', 'changes_since']);
  assert.equal(valueOf(store), 6);
});

test('a change is read again 300 ms after the last read at most, and never sooner than 150 ms', () => {
  assert.equal(refreshDelay(0), 300);
  assert.equal(refreshDelay(100), 200);
  assert.equal(refreshDelay(250), 150);
  assert.equal(refreshDelay(60_000), 150);
});

test('sending rebases; native guards the review itself', async () => {
  // action_confirm refuses a used, expired or changed-source review (actions.rs), so a sync
  // that moved the revision while the review was open must not block Send.
  for (const op of ['action_prepare', 'action_confirm', 'sync_request', 'job_retry', 'calendar_window']) assert.ok(REBASE_SAFE.has(op), op);
  let writes = 0;
  const store = createStore(async (_, { request: r }) => {
    if (r.op === 'snapshot') return { snapshot: { revision: 1, settings: { activeWorkspace: 'personal' } } };
    writes++;
    throw { code: 'stale_view' };
  });
  await store.refresh();
  // Operations outside the set still report a stale view at once.
  assert.ok(!REBASE_SAFE.has('graph_disconnect'));
  await assert.rejects(store.mutate('graph_disconnect', {}), { code: 'stale_view' });
  assert.equal(writes, 1);
});

test('untrusted source text is escaped before HTML rendering', () => {
  assert.equal(escapeHtml('<img onerror="run()">&\''), '&lt;img onerror=&quot;run()&quot;&gt;&amp;&#39;');
});

// ---------------------------------------------------------------- calendar geometry

test('calendar grid crosses month/year boundaries without missing days', () => {
  const days = calendarDays(new Date(2026, 11, 31, 12), 'month');
  assert.equal(days.length, 42);
  assert.equal(days[0].getDay(), 1);
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1]);
    prev.setDate(prev.getDate() + 1);
    assert.equal(days[i].getDate(), prev.getDate());
  }
  assert.equal(calendarDays(new Date(2026, 10, 18, 12), 'week')[0].getDate(), 16, 'weeks start on Monday');
  assert.equal(calendarDays(new Date(2026, 10, 18, 12), 'day').length, 1);
});

test('calendar coverage uses every catalog calendar when sources are automatic', () => {
  const window = calendarWindow(new Date(2026, 10, 16, 12), 'week');
  assert.ok(window.end - window.start >= 7 * 86400);
  const s = {
    settings: { activeWorkspace: 'p' },
    workspaces: [{ id: 'p', sources: { all: true } }],
    records: [
      { kind: 'catalog', id: 'calendars', data: { values: [{ id: 'a' }, { id: 'b' }] } },
      { kind: 'calendar_window', source: 'calendar:a', data: window },
    ],
  };
  assert.deepEqual(calendarIds(s), ['a', 'b']);
  assert.equal(calendarCoverage(s, window), true, 'a calendar that never completed any window (e.g. 403) does not block');
  s.records.push({ kind: 'calendar_window', source: 'calendar:b', data: { start: window.start + 1, end: window.end } });
  assert.equal(calendarCoverage(s, window), false, 'a window that starts late is not complete');
  s.records[2].data.start = window.start;
  assert.equal(calendarCoverage(s, window), true);
  assert.equal(calendarCoverage({ ...s, records: s.records.filter(r => r.kind !== 'calendar_window') }, window), false, 'nothing synced yet is not covered');
  s.workspaces[0].sources = { calendars: ['a'], chats: [], mail: true };
  assert.deepEqual(calendarIds(s), ['a'], 'legacy explicit selections still work');
});

test('overnight timed events and all-day exclusive ends occupy exactly their covered dates', () => {
  const days = [16, 17, 18].map(day => new Date(2026, 10, day, 12));
  const timed = { id: 'overnight', data: { start: '2026-11-16T23:00:00Z', end: '2026-11-18T00:00:00Z', allDay: false } };
  const allDay = { id: 'all-day', data: { start: '2026-11-16T00:00:00Z', end: '2026-11-18T00:00:00Z', startDate: '2026-11-16', endDate: '2026-11-18', allDay: true } };
  const groups = groupCalendarEvents([timed, allDay], days, 'UTC');
  assert.deepEqual(groups.map(g => g.events.length), [2, 2, 0]);
  const first = eventsOnDay([timed], '2026-11-16', 'UTC').timed[0];
  assert.deepEqual([first.startMin, first.endMin], [23 * 60, 1440]);
  const second = eventsOnDay([timed], '2026-11-17', 'UTC').timed[0];
  assert.deepEqual([second.startMin, second.endMin], [0, 1440], 'the middle day is fully covered');
  assert.equal(eventSpan(allDay, 'UTC').endKey, '2026-11-17');
});

test('zero-length events stay a point in time; DST days step by calendar day', () => {
  const point = { data: { start: '2026-11-16T00:00:00Z', end: '2026-11-16T00:00:00Z', allDay: false } };
  const [p] = eventsOnDay([point], '2026-11-16', 'UTC').timed;
  assert.deepEqual([p.startMin, p.endMin], [0, 0]);
  assert.equal(addDaysToKey('2027-03-27', 1), '2027-03-28');
  assert.equal(addDaysToKey('2026-10-25', 1), '2026-10-26');
  assert.equal(addDaysToKey('2026-03-01', -1), '2026-02-28');
  // 2026-10-25 23:30 in Kyiv (the 25-hour DST day): 24 h earlier is still the 25th, but yesterday is the 24th.
  assert.equal(relativeAge(Date.parse('2026-10-24T20:00:00Z'), 'Europe/Kyiv', Date.parse('2026-10-25T21:30:00Z')), 'Yesterday', 'yesterday across the autumn DST change');
});

test('event days and minutes follow the workspace time zone, not the machine zone', () => {
  const ev = { data: { start: '2026-11-16T22:30:00Z', end: '2026-11-16T23:00:00Z', allDay: false } };
  assert.equal(eventSpan(ev, 'UTC').startKey, '2026-11-16');
  assert.equal(eventSpan(ev, 'Europe/Kyiv').startKey, '2026-11-17');
  assert.equal(minutesOfDay('2026-11-16T22:30:00Z', 'Europe/Kyiv'), 30);
  assert.equal(dayKey('2026-03-29T01:30:00Z', 'Europe/Kyiv'), '2026-03-29', 'DST change day keeps its date');
});

test('overlapping events share columns and separate clusters reset', () => {
  const item = (id, s, e) => ({ record: { id }, startMin: s, endMin: e });
  const laid = layoutColumns([item('a', 540, 600), item('b', 570, 630), item('c', 585, 600), item('d', 660, 720)]);
  const by = Object.fromEntries(laid.map(x => [x.record.id, x]));
  assert.equal(by.a.cols, 3);
  assert.deepEqual([by.a.col, by.b.col, by.c.col], [0, 1, 2]);
  assert.equal(by.d.cols, 1, 'a later, non-overlapping event uses the full width');
  const short = layoutColumns([item('x', 600, 605), item('y', 610, 640)], 20);
  assert.equal(short[0].cols, 2, 'very short events reserve label room');
});

test('free slots skip busy time and ignore events shown as free', () => {
  const slot = (s, e, showAs = 'busy') => ({ startMin: s, endMin: e, record: { data: { showAs } } });
  assert.deepEqual(freeSlots([slot(600, 660), slot(720, 780), slot(800, 900, 'free')], 540, 1080, 30), [[540, 600], [660, 720], [780, 1080]]);
  assert.deepEqual(freeSlots([slot(500, 1100)], 540, 1080), []);
});

test('free slots match the draft rule: declined meetings are free, an all-day absence takes the day', () => {
  const slot = (s, e, data = {}) => ({ startMin: s, endMin: e, record: { data: { showAs: 'busy', ...data } } });
  assert.deepEqual(freeSlots([slot(600, 660, { response: 'declined' })], 540, 1080, 30), [[540, 1080]]);
  const allDay = (showAs, data = {}) => ({ data: { allDay: true, showAs, response: 'accepted', ...data } });
  assert.deepEqual(freeSlots([], 540, 1080, 30, [allDay('oof')]), [], 'out of office');
  assert.deepEqual(freeSlots([], 540, 1080, 30, [allDay('busy')]), [], 'busy all day');
  assert.deepEqual(freeSlots([], 540, 1080, 30, [allDay('free'), allDay('tentative')]), [[540, 1080]], 'free and tentative all-day items do not block');
  assert.deepEqual(freeSlots([], 540, 1080, 30, [allDay('oof', { response: 'declined' }), allDay('busy', { cancelled: true })]), [[540, 1080]]);
  const s = buildSnapshot(Date.parse('2026-11-16T07:00:00Z'), { photo: false });
  s.records.find(r => r.id === 'ev-allday').data.showAs = 'oof';
  assert.equal(todayModel(s, new Set(), Date.parse('2026-11-16T07:00:00Z')).freeMinutes, 0, 'Today agrees with the drafts');
});

test('calendar colours use hex, then Outlook names, then a stable palette', () => {
  assert.equal(calendarColor({ hexColor: '#123456' }), '#123456');
  assert.equal(calendarColor({ color: 'lightGreen', hexColor: '' }), '#3FB27F');
  assert.match(calendarColor({ color: 'auto' }, 2), /^#[0-9A-F]{6}$/i);
});

test('period titles describe the visible range', () => {
  assert.match(periodTitle(new Date(2026, 10, 18, 12), 'week'), /16.*22.*2026/);
  assert.match(periodTitle(new Date(2026, 10, 18, 12), 'month'), /2026/);
});

// ---------------------------------------------------------------- formatting

test('names, initials and colours are stable', () => {
  assert.equal(initials('Taylor Morgan'), 'TM');
  assert.equal(initials('Morgan, Taylor'), 'TM');
  assert.equal(initials('Prince'), 'PR');
  assert.equal(initials(''), '?');
  assert.equal(firstName({ givenName: 'Taylor', displayName: 'X Y' }), 'Taylor');
  assert.equal(firstName({ displayName: 'Morgan, Taylor' }), 'Taylor');
  assert.equal(firstName({ displayName: 'Taylor Morgan' }), 'Taylor');
  assert.equal(colorFor('a@b'), colorFor('a@b'));
});

test('relative and countdown labels read naturally', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.equal(relativeAge(now - 30_000, 'UTC', now), 'now');
  assert.equal(relativeAge(now - 5 * 60_000, 'UTC', now), '5m');
  assert.equal(relativeAge(now - 3 * 3_600_000, 'UTC', now), '3h');
  assert.equal(relativeAge(now - 20 * 3_600_000, 'UTC', now), 'Yesterday');
  assert.equal(agoLabel(now - 20_000, 'UTC', now), 'just now');
  assert.equal(agoLabel(now - 7 * 60_000, 'UTC', now), '7 min ago');
  assert.equal(countdownLabel(now + 25 * 60_000, now), 'in 25 min');
  assert.equal(countdownLabel(now + 90 * 60_000, now), 'in 1 h 30 min');
  assert.equal(countdownLabel(now - 1, now), 'now');
  assert.equal(durationLabel(120), '2 h');
  assert.equal(greeting(9), 'Good morning');
  assert.equal(greeting(14), 'Good afternoon');
  assert.equal(greeting(21), 'Good evening');
});

test('snooze presets land on sensible local times', () => {
  const now = new Date(2026, 10, 18, 15, 10).getTime(); // Wednesday
  assert.equal(snoozeUntil('3h', now), Math.floor(now / 1000) + 3 * 3600);
  const tomorrow = new Date(snoozeUntil('tomorrow', now) * 1000);
  assert.deepEqual([tomorrow.getDate(), tomorrow.getHours()], [19, 9]);
  const monday = new Date(snoozeUntil('monday', now) * 1000);
  assert.deepEqual([monday.getDay(), monday.getDate(), monday.getHours()], [1, 23, 9]);
  const fromMonday = new Date(snoozeUntil('monday', new Date(2026, 10, 23, 8).getTime()) * 1000);
  assert.equal(fromMonday.getDate(), 30, 'on a Monday, next Monday is a week later');
});

// ---------------------------------------------------------------- selectors

test('attention lists critical first, then replies, newest first', () => {
  const s = buildSnapshot(Date.parse('2026-11-16T12:00:00Z'), { photo: false });
  const ids = attentionMessages(s).map(m => m.id);
  assert.equal(ids[0], 'm-critical');
  assert.deepEqual(ids.slice(1), ['c-reply-1', 'm-reply-1', 'm-reply-2', 'c-reply-2']);
  assert.equal(sourceCounts(s).events, 12);
  assert.equal(conversation(s, s.records.find(r => r.id === 'm-reply-1')).length, 2, 'own reply joins the thread');
});

test('Teams chats collapse to their newest message with a count; mail stays per message', () => {
  const msg = (id, channel, conversationId, at) => ({ id, source: channel === 'chat' ? `chat:${conversationId}` : 'mail:inbox', data: { channel, conversationId, at } });
  const list = [msg('c3', 'chat', 'g', 30), msg('m2', 'mail', 'x', 25), msg('c2', 'chat', 'g', 20), msg('d1', 'chat', 'h', 15), msg('m1', 'mail', 'x', 10), msg('c1', 'chat', 'g', 5)];
  const { items, counts } = collapseChats(list);
  assert.deepEqual(items.map(m => m.id), ['c3', 'm2', 'd1', 'm1']);
  assert.equal(counts.get('c3'), 3);
  assert.equal(counts.get('d1'), undefined);
});

test('a chat with a critical message is shown by that message, not a newer reply', () => {
  const s = buildSnapshot(Date.parse('2026-11-16T12:00:00Z'), { photo: false });
  const chat = (id, lane, at) => ({ id, kind: 'message', source: 'chat:chat-group', connectionId: 'x', data: { channel: 'chat', conversationId: 'chat:chat-group', lane, at, lifecycle: 'open', from: 'Priya' } });
  s.records = s.records.filter(r => r.kind !== 'message').concat([chat('new-reply', 'reply', 2000), chat('old-critical', 'critical', 1000)]);
  assert.deepEqual(attentionMessages(s).map(m => m.id), ['old-critical']);
});

test('Teams titles fall back to chat topic, then other members', () => {
  const s = buildSnapshot(Date.parse('2026-11-16T12:00:00Z'), { photo: false });
  const generic = { source: 'chat:chat-jordan', data: { channel: 'chat', title: 'Teams conversation' } };
  assert.equal(messageTitle(generic, s), 'Jordan Lee');
  assert.equal(messageTitle({ ...generic, data: { ...generic.data, title: 'Teams chat' } }, s), 'Jordan Lee', 'new backend placeholder too');
  assert.equal(messageTitle({ source: 'chat:chat-group', data: { channel: 'chat' } }, s), 'Release crew');
  assert.equal(messageTitle({ source: 'mail:inbox', data: { channel: 'mail', title: '' } }, s), '(No subject)');
});

test('connection state distinguishes sign-in, re-auth and other accounts', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  assert.equal(connectionState(s), 'connected');
  assert.equal(connectionState(s, { authPending: true }), 'authorizing');
  s.connection.status = 'needs_login';
  assert.equal(connectionState(s), 'needs_login');
  s.connection.status = 'connected';
  s.workspaces[0].connectionId = 'other';
  assert.equal(connectionState(s), 'other_account');
  assert.equal(connectionState(buildSnapshot(Date.now(), { connected: false })), 'none');
  assert.equal(decisions(s).length, 0, 'succeeded sync jobs are not decisions');
});

test('inbox filters by channel and search without changing lanes', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const base = { showArchived: false, showSnoozed: false, search: '', channel: 'all' };
  assert.equal(filteredMessages(s, { ...base, channel: 'chat' }).every(m => m.data.channel === 'chat'), true);
  assert.deepEqual(filteredMessages(s, { ...base, search: 'roadmap' }).map(m => m.id).sort(), ['m-reply-1', 'm-thread-mine']);
});

// ---------------------------------------------------------------- views

const ctx = (state = {}) => ({
  state: { calendarMode: 'week', calendarDate: new Date(), lane: 'fyi', channel: 'all', search: '', showArchived: false, showSnoozed: false, inboxLimit: 200, selectedMessage: 'm-xss', settingsTab: 'microsoft', ...state },
  auth: {}, hidden: new Set(), banners: '',
});

test('Today shows the live meeting, a join action, attention and commitments', () => {
  const now = Date.now();
  const s = buildSnapshot(now, { photo: false });
  const html = today(s, ctx());
  assert.match(html, /Good (morning|afternoon|evening), Taylor/);
  assert.match(html, /Happening now/);
  assert.match(html, /Architecture review: Connect sync/);
  assert.match(html, /Join Teams meeting/);
  assert.match(html, /Production alert/);
  assert.match(html, /Send the roadmap comments to Priya/);
  assert.match(html, /<h2 class="ws-card-title"><span class="ws-card-icon">[^]*?<\/span>Tasks<\/h2>/, 'the commitments card is Tasks');
  assert.match(html, /placeholder="Add a task…/);
  assert.match(html, /data-now-line/);
  const m = todayModel(s, new Set(), now);
  assert.equal(m.current[0].record.id, 'ev-current');
  assert.ok(!m.timed.some(t => t.record.id === 'ev-cancelled'), 'cancelled events are hidden');
});

test('Today stays calm: the meeting on now is marked, the pill turns amber only near its end, Next is one line', () => {
  const now = Date.now();
  const s = buildSnapshot(now, { photo: false });
  const at = ms => ({ ...ctx(), now: ms });
  const html = today(s, at(now));
  const schedule = tileOf(html, 'calendar');
  assert.match(schedule, /class="ws-tl-event ws-current[^"]*"[^>]*data-id="ev-current"/, 'the event on now is marked');
  assert.doesNotMatch(schedule, /ws-current"[^>]*data-id="ev-next"/);
  const brief = tileOf(html, 'brief');
  assert.match(brief, /class="ws-live-chip"/, '25 minutes left: the accent pill');
  assert.match(brief, /<strong><span class="ws-upnext-dot" style="--event-color:[^"]+" aria-hidden="true"><\/span>/, 'the calendar colour is a dot before the time');
  assert.match(brief, /class="ws-next" data-action="event" data-id="ev-next"[^>]*>[^]*?<span class="ws-next-label">Next<\/span>[^]*?<strong>1:1 with Jordan<\/strong>[^]*?<span class="ws-next-in">· in /);
  assert.doesNotMatch(brief, /ws-later/, 'no Later today chips');
  assert.match(brief, /data-action="source"[^>]*class="ws-btn ws-btn-ghost|class="ws-btn ws-btn-ghost[^"]*"[^>]*data-action="source"/, 'Open in Outlook is a quiet button');
  // Four minutes before the end, the pill says so in amber.
  assert.match(tileOf(today(s, at(now + 21 * 60_000)), 'brief'), /class="ws-live-chip ws-ending"/);
});

test('Today’s header is Customize and a ⋯; Tasks has one review line and an add row; replies keep the name and conversation on one line', () => {
  const now = Date.now();
  const s = withTasks(buildSnapshot(now, { photo: false }), now);
  const html = today(s, { ...ctx(), now });
  const actions = html.match(/<div class="ws-actions ws-today-actions">[^]*?<\/details><\/div>/)?.[0] || '';
  assert.match(actions, /class="ws-btn ws-btn-secondary" data-action="today-customize"><svg[^]*?<span>Customize<\/span>/, 'Customize, not the primary button');
  assert.match(actions, /<summary class="ws-btn ws-btn-secondary ws-btn-icon ws-today-more"[^>]*aria-label="Layouts and more"/);
  assert.match(actions, /role="menuitemcheckbox" aria-checked="false" aria-pressed="false" data-action="today-lock">[^]*?Lock layout/);
  assert.doesNotMatch(actions, /ws-today-layout-pill|<button[^>]*ws-btn[^>]*data-action="today-lock"/, 'no layout pill, no lock button while unlocked');
  const locked = today(s, { ...ctx(), now, today: { locked: true } });
  assert.match(locked, /<div class="ws-actions ws-today-actions"><button[^>]*data-action="today-lock"[^>]*aria-pressed="true"/, 'locked: a lock to undo it, first');
  const tasks = tileOf(html, 'commitments');
  assert.match(tasks, /class="ws-today-review" data-action="route" data-route="tasks"><svg[^]*?<span><strong>\d+<\/strong> tasks? from meeting notes to review<\/span>/);
  assert.doesNotMatch(tasks, /Check owners and dates/);
  assert.match(tasks, /<details class="ws-menu ws-task-add" data-menu="today-task-add"><summary class="ws-task-add-row">[^]*?Add task<\/span><\/summary><form class="ws-quick-add" data-form="commitment-add">/);
  assert.match(tileOf(html, 'inbox'), /<span class="ws-msg-top"><strong>[^<]+<\/strong><span class="ws-msg-title">[^]*?<\/span><\/span><time>/, 'name, conversation, time on one line');
});

test('Day at a glance says when free time ends on the same clock as the header', t => {
  // 09:00 in Kyiv: the workday ends at 18:00 there.
  const now = Date.parse('2026-11-18T07:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const s = buildSnapshot(now, { photo: false, zone: 'Europe/Kyiv' });
  const html = today(s, ctx());
  const until = formatTime(Date.parse('2026-11-18T16:00:00Z'), 'Europe/Kyiv');
  assert.match(html, new RegExp(`free until ${until}`), 'the header names the end of the workday');
  // "Until" keeps the label inside the tile at 1440 px with a 12-hour clock (the browser E2E measures it).
  assert.match(html, new RegExp(`<span>Until ${until}</span>`), 'the tile uses the same clock');
  assert.doesNotMatch(html, /Free to 18:00/);
});

test('Today without Microsoft invites one sign-in and keeps local work', () => {
  const s = buildSnapshot(Date.now(), { connected: false });
  const html = today(s, ctx());
  assert.match(html, /Sign in with Microsoft/);
  assert.match(html, /Book the workshop room/);
  assert.doesNotMatch(html, /Happening now/);
});

const tileOf = (html, id) => html.match(new RegExp(`<section class="ws-card ws-tile[^"]*"[^>]*? data-tile="${id}"[^]*?</section>`))?.[0] || '';

test('Today draws tiles from the grid with their positions', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const html = today(s, ctx());
  assert.match(html, /<div class="ws-today ws-today-page">/);
  assert.match(html, /<div class="ws-tiles" data-today-grid style="--rows:22">/, 'Default ends at row 22');
  assert.doesNotMatch(html, /ws-span-|class="ws-grid"/);
  const focus = html.match(/<section class="ws-card ws-tile[^"]*" data-tile="focus" style="([^"]*)"/);
  assert.ok(focus, 'Day at a glance is a tile');
  assert.match(focus[1], /^--x:8;--y:0;--w:4;--h:4;--order:1$/);
  // The stacked layout reads them by row, then column.
  assert.deepEqual([...html.matchAll(/data-tile="([^"]+)" style="[^"]*--order:(\d+)"/g)].map(m => [m[1], Number(m[2])]),
    [['brief', 0], ['focus', 1], ['calendar', 2], ['inbox', 3], ['commitments', 4], ['notes', 5], ['meetings', 6], ['automations', 7]]);
  // A tile: the grip, its title, the widget buttons, a body and three resize handles.
  const tile = tileOf(html, 'focus');
  assert.match(tile, /<header class="ws-card-header ws-tile-head"><button type="button" class="ws-tile-grip" data-grip="focus" aria-label="Move Day at a glance\. Arrow keys move it, Shift and arrow keys resize it\."/);
  assert.match(tile, /<h2 class="ws-card-title"><span class="ws-card-icon">[^]*?<\/span>Day at a glance<\/h2>/);
  assert.match(tile, /data-action="today-options" data-id="focus"[^>]*aria-label="Customize Day at a glance"/);
  assert.match(tile, /<details class="ws-menu ws-menu-right ws-tile-menu" data-menu="today-w-focus">\s*<summary[^>]*aria-label="More for Day at a glance"/);
  assert.match(tile, /<div class="ws-card-body ws-tile-body">/);
  assert.deepEqual([...tile.matchAll(/class="ws-rz" data-edge="([a-z])"/g)].map(m => m[1]), ['r', 'b', 'c']);
  assert.match(tileOf(html, 'calendar'), /<div class="ws-card-actions ws-tile-extra">[^]*?data-route="calendar"/, 'header extras are marked');

  // A saved grid: its positions, the user's titles (escaped) and a collapsed widget.
  const w = active(s);
  w.layout = ['calendar', 'brief'];
  w.today = { active: 'Mine', items: [{ id: 'calendar', x: 0, y: 0, w: 4, h: 1, collapsed: true, prevH: 7 }, { id: 'brief', x: 4, y: 0, w: 8, h: 4 }], titles: { brief: 'Next <b>up</b>' } };
  const saved = today(s, ctx());
  assert.match(saved, /data-today-grid style="--rows:4"/);
  assert.deepEqual([...saved.matchAll(/data-tile="([^"]+)"/g)].map(m => m[1]), ['calendar', 'brief']);
  assert.match(saved, /class="ws-card ws-tile ws-tile-collapsed ws-schedule-card" data-tile="calendar" style="--x:0;--y:0;--w:4;--h:1;--order:0"/);
  const brief = tileOf(saved, 'brief');
  assert.match(brief, /<\/span>Next &lt;b&gt;up&lt;\/b&gt;<\/h2>/);
  assert.match(brief, /aria-label="Move Next &lt;b&gt;up&lt;\/b&gt;\./);
  assert.doesNotMatch(saved, /<b>up<\/b>/);
  // Nothing on the grid: the empty state starts Customize.
  w.layout = [];
  w.today = { active: 'Mine', items: [] };
  assert.match(today(s, ctx()), /Make Today your own[^]*?data-action="today-customize"/);
});

test('Schedule draws an agenda list for narrow sizes', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const tile = tileOf(today(s, ctx()), 'calendar');
  const agenda = tile.slice(tile.indexOf('<div class="ws-tl-agenda">'));
  assert.ok(tile.includes('<div class="ws-tl-agenda">'), tile);
  assert.match(agenda, /<button type="button" class="ws-tl-agenda-item" data-action="event" data-id="ev-current"[^>]*><b>[^<]+<\/b><span>Architecture review: Connect sync<\/span><\/button>/);
  assert.match(tile, /class="ws-timeline"/, 'the timeline is still there for wider sizes');
});

test('Needs your reply shows the number of messages its options ask for', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const ids = html => [...tileOf(html, 'inbox').matchAll(/class="ws-msg-row" data-action="open-message" data-id="([^"]+)"/g)].map(m => m[1]);
  const waiting = attentionMessages(s);
  assert.ok(waiting.length > 3, 'the fixture has more than 3 to show');
  assert.equal(ids(today(s, ctx())).length, Math.min(6, waiting.length), '6 by default');
  active(s).today = { active: 'Default', items: PRESETS.Default, options: { inbox: { max: '3' } } };
  assert.equal(ids(today(s, ctx())).length, 3);
  active(s).today.options.inbox = { sources: ['chat'] };
  const chats = ids(today(s, ctx()));
  assert.ok(chats.length > 0);
  assert.ok(chats.every(id => s.records.find(r => r.id === id).data.channel === 'chat'), 'Teams only');
});

test('Tasks no longer draws Notes; Notes keeps the textarea id today-note', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const html = today(s, ctx());
  assert.doesNotMatch(tileOf(html, 'commitments'), /today-note|ws-notes/);
  const notes = tileOf(html, 'notes');
  assert.match(notes, /<\/span>Notes<\/h2>/);
  assert.match(notes, /id="note-state"/);
  assert.match(notes, /<textarea id="today-note" class="ws-textarea ws-notes ws-notes-small" data-workspace-id="personal"/);
  active(s).today = { active: 'Default', items: PRESETS.Default, options: { notes: { size: 'large' } } };
  assert.match(tileOf(today(s, ctx()), 'notes'), /class="ws-textarea ws-notes ws-notes-large"/);
});

test('widgets honour their options', t => {
  const now = Date.parse('2026-11-18T09:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const s = buildSnapshot(now, { photo: false });
  const w = active(s);
  const items = [...PRESETS.Default, { id: 'timer', x: 0, y: 22, w: 4, h: 3 }];
  const before = today(s, ctx());
  assert.match(tileOf(before, 'brief'), /class="ws-next"[^]*?class="ws-people"|class="ws-people"[^]*?class="ws-next"/);
  assert.match(tileOf(before, 'calendar'), /ws-tl-free/);
  assert.match(tileOf(before, 'commitments'), /data-form="commitment-add"/);
  assert.match(tileOf(before, 'focus'), /class="ws-focus"/);
  w.today = {
    active: 'Default', items,
    options: {
      brief: { later: false, people: false },
      focus: { stats: ['tasks', 'left'], focus: false },
      calendar: { free: false },
      commitments: { add: false, done: false },
      timer: { minutes: '50' },
    },
  };
  const html = today(s, ctx());
  assert.doesNotMatch(tileOf(html, 'brief'), /class="ws-next"|class="ws-people"/);
  const glance = tileOf(html, 'focus');
  assert.deepEqual([...glance.matchAll(/<strong>[^<]*<\/strong><span>([^<]+)<\/span>/g)].map(m => m[1]), ['Meetings left', 'Open tasks'], 'in their usual order');
  assert.doesNotMatch(glance, /class="ws-focus/);
  assert.doesNotMatch(tileOf(html, 'calendar'), /ws-tl-free/);
  assert.doesNotMatch(tileOf(html, 'commitments'), /data-form="commitment-add"|ws-done-list/);
  // Focus timer starts the length it is set to, through the same focus action as Day at a glance.
  assert.match(tileOf(html, 'timer'), /<strong>50:00<\/strong>[^]*?data-action="focus" data-minutes="50"/);
  s.settings.focusUntil = Math.floor(now / 1000) + 600;
  assert.match(tileOf(today(s, ctx()), 'timer'), /data-countdown-end="[0-9]+"[^]*?data-action="focus" data-minutes="0"/);
});

test('before plugins load a plugin widget still draws', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const w = active(s);
  w.layout = ['brief', 'plugin:github:ci'];
  w.today = { active: 'Mine', items: [{ id: 'brief', x: 0, y: 0, w: 8, h: 4 }, { id: 'plugin:github:ci', x: 8, y: 0, w: 4, h: 4 }] };
  const draw = (pluginsKnown, catalog = []) => today(s, { ...ctx(), pluginsKnown, plugins: { catalog, drawn: {} } });
  const loading = tileOf(draw(false), 'plugin:github:ci');
  assert.match(loading, /data-widget="plugin:github:ci" data-tile="plugin:github:ci" style="--x:8;--y:0;--w:4;--h:4;--order:1"/);
  assert.match(loading, /Its plugin is off/);
  // Once the catalog is known, a widget whose plugin is off isn't drawn; the others stay put.
  const off = draw(true);
  assert.doesNotMatch(off, /data-tile="plugin:github:ci"/);
  assert.match(off, /data-tile="brief" style="--x:0;--y:0;--w:8;--h:4;--order:0"/);
  assert.match(draw(true, [{ id: 'plugin:github:ci', title: 'GitHub CI', description: '', width: 4, plugin: 'github' }]), /data-tile="plugin:github:ci"[^]*?Waiting for its first data/);
});

test('Calendar renders a time grid with hours, overlap columns and escaped titles', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  for (const mode of ['day', 'week', 'month', 'agenda']) {
    const html = calendar(s, ctx({ calendarMode: mode }));
    assert.doesNotMatch(html, /<b>prep<\/b>/, `${mode} escapes provider titles`);
  }
  const week = calendar(s, ctx({ calendarMode: 'week' }));
  assert.match(week, /class="ws-tg"/);
  assert.match(week, /ws-tg-hour/);
  assert.match(week, /Release week/);
  assert.match(week, /Team events/);
  const hidden = calendar(s, { ...ctx({ calendarMode: 'week' }), hidden: new Set(['cal-team']) });
  assert.doesNotMatch(hidden, /Hiring sync/, 'hidden calendars are filtered');
  const detail = eventDetails(s, s.records.find(r => r.id === 'ev-current'));
  assert.match(detail, /Microsoft Teams meeting/);
  assert.match(detail, /4 attendees/);
});

test('Inbox reader escapes untrusted mail and offers provider actions', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const html = inbox(s, ctx());
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>window/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Open in Outlook/);
  assert.match(html, /Snooze/);
});

test('Inbox draws its two sections in the saved order', () => {
  // The spec's ids, minimum and default widths, and the pin to Today.
  assert.deepEqual(INBOX_DOCK.initial, [['inbox-list'], ['inbox-reader']]);
  assert.deepEqual(Object.entries(INBOX_DOCK.tabs).map(([id, t]) => [id, t.title, t.min, t.w, t.pin]), [['inbox-list', 'Messages', 320, 420, 'inbox'], ['inbox-reader', 'Message', 380, 720, undefined]]);
  assert.equal(INBOX_DOCK.tabs['inbox-list'].pinTitle, WIDGETS.inbox.title);
  const s = buildSnapshot(Date.now(), { photo: false });
  const sections = inboxSections(s, ctx());
  assert.deepEqual(Object.keys(sections), ['inbox-list', 'inbox-reader']);
  assert.match(sections['inbox-list'], /id="inbox-search"[^]*class="ws-inbox-items"/);
  assert.match(sections['inbox-reader'], /^<section class="ws-reader"/);
  const at = (html, id) => html.indexOf(`data-tab="${id}"`);
  // Without a stored layout: Messages, then Message.
  const plain = inbox(s, ctx());
  assert.match(plain, /^<div class="ws-dock" data-page="inbox">/);
  assert.ok(at(plain, 'inbox-list') > 0 && at(plain, 'inbox-list') < at(plain, 'inbox-reader'));
  // Message moved left: it is drawn first, with both bodies.
  const swapped = swapPanes(normalizeDock(INBOX_DOCK, null), 'p2', -1);
  const html = inbox(s, { ...ctx(), dock: { layouts: { inbox: swapped }, locked: false } });
  assert.ok(at(html, 'inbox-reader') > 0 && at(html, 'inbox-reader') < at(html, 'inbox-list'));
  assert.ok(html.indexOf('class="ws-reader"') < html.indexOf('class="ws-inbox-items"'));
  assert.match(html, /ws-dock-grip/);
  assert.doesNotMatch(inbox(s, { ...ctx(), dock: { layouts: { inbox: swapped }, locked: true } }), /ws-dock-grip/, 'locked: no grips');
});

test("Calendar's sidebar toggle collapses the Calendars section", async () => {
  assert.deepEqual(CALENDAR_DOCK.initial, [['cal-side'], ['cal-main']]);
  assert.deepEqual(Object.entries(CALENDAR_DOCK.tabs).map(([id, t]) => [id, t.title, t.min, t.w, t.pin]), [['cal-side', 'Calendars', 220, 260, undefined], ['cal-main', 'Calendar', 480, 1000, 'calendar']]);
  assert.equal(CALENDAR_DOCK.tabs['cal-main'].pinTitle, WIDGETS.calendar.title);
  const s = buildSnapshot(Date.now(), { photo: false });
  const open = calendar(s, ctx());
  assert.match(open, /class="ws-mini"/);
  assert.match(open, /data-action="calendar-sidebar"/);
  assert.doesNotMatch(open, /ws-cal-collapsed/);
  // The toolbar's toggle collapses the Calendars section through the page's sections.
  const saved = {};
  let renders = 0;
  const dock = attachDock({ addEventListener() {} }, {
    defs: { calendar: CALENDAR_DOCK },
    layouts: { get: page => saved[page] || normalizeDock(CALENDAR_DOCK, null), set: (page, layout) => { saved[page] = layout; } },
    render: async () => { renders++; },
  });
  await dock.setCollapsed('calendar', 'cal-side', true);
  assert.equal(renders, 1);
  const html = calendar(s, { ...ctx(), dock: { layouts: saved, locked: false } });
  assert.match(html, /<section class="ws-pane ws-pane-collapsed" data-pane="p1"[^>]*>\s*<div class="ws-pane-rail"[^]*?Calendars/);
  assert.doesNotMatch(html, /class="ws-mini"/, 'the collapsed section draws no mini month');
  assert.match(html, /data-action="calendar-sidebar"/);
  await dock.setCollapsed('calendar', 'cal-side', false);
  assert.match(calendar(s, { ...ctx(), dock: { layouts: saved, locked: false } }), /class="ws-mini"/);
});

test('the section menu moves a section, resets the page with Undo and keeps one section open', async () => {
  const saved = {};
  const toasts = [];
  const said = [];
  const dock = attachDock({ addEventListener() {} }, {
    defs: { inbox: INBOX_DOCK },
    layouts: { get: page => saved[page] || normalizeDock(INBOX_DOCK, null), set: (page, layout) => { saved[page] = layout; } },
    render: async () => {},
    toast: (message, tone, action) => toasts.push({ message, action }),
    announce: text => said.push(text),
  });
  const el = dataset => ({ dataset: { page: 'inbox', ...dataset } });
  await dock.handle('dock-move', el({ pane: 'p2', dir: '-1' }));
  assert.deepEqual(saved.inbox.panes.map(p => p.tabs[0]), ['inbox-reader', 'inbox-list']);
  await dock.handle('dock-collapse', el({ pane: 'p2' }));
  assert.equal(said.at(-1), 'Message collapsed to a rail');
  await dock.handle('dock-collapse', el({ pane: 'p1' }));
  assert.equal(toasts.at(-1).message, 'Keep at least one section open');
  assert.deepEqual(saved.inbox.panes.map(p => p.collapsed), [true, false]);
  await dock.handle('dock-reset', el({}));
  assert.deepEqual(saved.inbox, normalizeDock(INBOX_DOCK, null));
  assert.equal(toasts.at(-1).message, 'Inbox is back to its original layout');
  await toasts.at(-1).action.run();
  assert.deepEqual(saved.inbox.panes.map(p => [p.tabs[0], p.collapsed]), [['inbox-reader', true], ['inbox-list', false]], 'Undo brings the layout back');
});

test('locked: a double-click on a divider keeps the widths and says the layouts are locked', async () => {
  const saved = {};
  const on = {};
  const nudged = [];
  let locked = true;
  attachDock({ addEventListener: (type, fn) => { on[type] = fn; } }, {
    defs: { inbox: INBOX_DOCK },
    layouts: { get: page => saved[page] || normalizeDock(INBOX_DOCK, null), set: (page, layout) => { saved[page] = layout; } },
    render: async () => {},
    locked: () => locked,
    nudge: () => { nudged.push('Layouts are locked'); },
  });
  // Messages pulled 200 px wider than its default.
  saved.inbox = resizePair(normalizeDock(INBOX_DOCK, null), INBOX_DOCK, 0, 420, 720, 200);
  const split = { dataset: { page: 'inbox', split: '0' } };
  const dblclick = async () => {
    on.dblclick({ target: { closest: sel => (sel === '.ws-dock > .ws-split' ? split : null) } });
    await new Promise(resolve => setImmediate(resolve));
  };
  await dblclick();
  assert.deepEqual(saved.inbox.panes.map(p => p.w), [620, 520], 'the widths are kept');
  assert.equal(nudged.length, 1, 'the lock says so, with Unlock');
  // Unlocked, the same double-click gives both sections their default widths.
  locked = false;
  await dblclick();
  assert.deepEqual(saved.inbox.panes.map(p => p.w), [420, 720]);
  assert.equal(nudged.length, 1);
});

test('old_ai_pin_controls_are_gone', async () => {
  const { readFile } = await import('node:fs/promises');
  const general = settings(buildSnapshot(Date.now()), ctx({ settingsTab: 'general' }));
  assert.doesNotMatch(general, /ai-probe|ai-pin|Pin profile|Re-pin/);
  assert.match(general, /data-action="settings-tab"[^>]*data-tab="ai"[^>]*>(?:(?!<\/button>).)*Claude settings/);
  assert.match(general, /Choose Claude Code or a CodeMie profile/);
  for (const file of ['app.js', 'view-inbox.js', 'view-settings.js']) {
    const source = await readFile(new URL(`../workspace/${file}`, import.meta.url), 'utf8');
    // `ai-draft` is the Milestone 2 composer (Task 8); the Milestone 1 pin and probe stay gone.
    assert.doesNotMatch(source, /ai-probe|ai-pin|ai-load|ai_probe|aiProfile|claude-api/, file);
  }
  assert.ok(REBASE_SAFE.has('ai_settings_save'));
  assert.ok(!REBASE_SAFE.has('ai_test'));
});

test('background syncs stay quiet; a sync you start shows; the interval is a setting, every minute by default', () => {
  const s = buildSnapshot(Date.now());
  s.connection.lastSync = Math.floor(Date.now() / 1000) - 30;
  const sync = (force, state = 'running') => ({ id: `sync-${force}`, kind: 'sync', state, dueAt: 0, payload: { force } });
  const shell = () => renderShell({ snapshot: s, route: 'today', resolvedDark: false });
  const microsoft = () => settings(s, ctx({ settingsTab: 'microsoft' }));
  s.jobs = [sync(false)];
  assert.doesNotMatch(shell(), /Syncing…/, 'a background round is quiet');
  assert.match(microsoft(), /data-action="sync"[^>]*>[^]*?Sync now/, 'Sync now stays available');
  s.jobs = [sync(true, 'queued')];
  assert.match(shell(), /Syncing…/, 'Sync now shows');
  assert.match(microsoft(), /Syncing…/);
  s.connection.lastSync = null;
  s.jobs = [sync(false)];
  assert.match(shell(), /Syncing…/, 'the very first sync shows');
  s.jobs = [];
  delete s.settings.syncEveryMin;
  const html = microsoft();
  assert.match(html, /Check for new mail and chats/);
  assert.match(html, /<option value="1" selected>Every minute \(default\)<\/option>/);
  s.settings.syncEveryMin = 15;
  assert.match(microsoft(), /<option value="15" selected>Every 15 minutes<\/option>/);
});

test('Settings shows the account profile and automatic sources, no source picker', () => {
  const s = buildSnapshot(Date.now());
  const html = settings(s, ctx({ settingsTab: 'microsoft' }));
  assert.match(html, /Taylor Morgan/);
  assert.match(html, /Lead Software Engineer/);
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, /Synced automatically/);
  assert.match(html, /3 calendars/);
  assert.doesNotMatch(html, /name="chat"/, 'no Teams chat checkboxes');
  const signedOut = settings(buildSnapshot(Date.now(), { connected: false }), ctx({ settingsTab: 'microsoft' }));
  assert.match(signedOut, /Sign in with Microsoft/);
  for (const tab of ['general', 'appearance', 'notifications', 'queues', 'privacy', 'activity', 'updates']) {
    assert.ok(settings(s, ctx({ settingsTab: tab })).length > 200, tab);
  }
  // The CodeMie tabs render what the CodeMie controller gives them, never the embedded installer.
  const codemie = { panel: (tab) => `<p data-panel="${tab}">panel</p>`, headerActions: () => '<button data-action="cm-x">Act</button>', tabDots: new Set(['cm-agents']) };
  const overview = settings(s, { ...ctx({ settingsTab: 'cm-overview' }), codemie });
  assert.match(overview, /data-panel="cm-overview"/);
  assert.match(overview, /data-action="cm-x"/);
  assert.match(overview, /data-tab="cm-agents"[^>]*>.*?ws-dot-alert/s);
  assert.doesNotMatch(overview, /legacy-host|CLI usage analytics/);
});

// ---------------------------------------------------------------- hidden workspaces

test('shell_has_no_workspaces_entry_or_switcher', () => {
  const html = renderShell({ snapshot: buildSnapshot(Date.now()), route: 'today', resolvedDark: false });
  assert.deepEqual(NAV.map(([id]) => id), ['today', 'inbox', 'calendar', 'meetings', 'tasks', 'automations', 'analytics']);
  assert.match(html, /data-route="automations"/);
  assert.doesNotMatch(html, /data-route="workspaces"/);
  assert.doesNotMatch(html, /workspace-select|ws-workspace-switch|ws-ws-dot|Active workspace/);
  assert.match(html, /data-route="settings"/);
  assert.match(html, /data-action="theme-toggle"/);
  assert.match(html, /ws-bell/);
  assert.match(html, /ws-sync-pill/);
});

test('NAV lists Today, then Work (Inbox, Calendar, Meetings, Tasks) and AI (Automations, Analytics)', () => {
  assert.deepEqual(NAV, [['today', 'Today'], ['inbox', 'Inbox'], ['calendar', 'Calendar'], ['meetings', 'Meetings'], ['tasks', 'Tasks'], ['automations', 'Automations'], ['analytics', 'Analytics']]);
  const now = Date.UTC(2026, 10, 18, 12);
  const html = renderShell({ snapshot: withTasks(buildSnapshot(now, { photo: false }), now), route: 'tasks', resolvedDark: true });
  assert.match(html, /data-route="tasks" aria-current="page"><svg[^]*?<span>Tasks<\/span><small class="ws-count" title="Tasks to review">2<\/small>/, 'Tasks is current and counts the tasks to review');
  assert.doesNotMatch(renderShell({ snapshot: buildSnapshot(now, { photo: false }), route: 'today', resolvedDark: true }), /Tasks to review/);
  // Meetings has its own icon and counts what waits for the person: to do and needs you.
  const meetingsHtml = renderShell({ snapshot: withMeetings(buildSnapshot(now, { photo: false }), now), route: 'meetings', resolvedDark: true, now });
  assert.match(meetingsHtml, /data-route="meetings" aria-current="page"><svg[^>]*>(?!<circle cx="5")[^]*?<span>Meetings<\/span><small class="ws-count" title="Transcripts waiting for you">5<\/small>/);
});

test('boot_selects_personal_when_another_workspace_is_active', async () => {
  const calls = [];
  const store = { mutate: async (...args) => { calls.push(args); } };
  await bootWorkspace(store, { settings: { activeWorkspace: 'atlas' } });
  assert.deepEqual(calls, [['workspace_select', { id: 'personal' }]]);
});

test('boot_does_nothing_when_personal_is_active', async () => {
  const calls = [];
  const store = { mutate: async (...args) => { calls.push(args); } };
  await bootWorkspace(store, { settings: { activeWorkspace: 'personal' } });
  assert.deepEqual(calls, []);
});

test('notifications never navigate into a hidden workspace', () => {
  assert.equal(notificationWorkspaceToSelect({ workspaceId: 'atlas' }, 'personal'), null);
  assert.equal(notificationWorkspaceToSelect({ workspaceId: 'atlas' }, 'atlas'), null);
  assert.equal(notificationWorkspaceToSelect({ workspaceId: 'personal' }, 'personal'), null);
  assert.equal(notificationWorkspaceToSelect({}, 'personal'), null);
  assert.equal(notificationWorkspaceToSelect({ workspaceId: 'personal' }, 'atlas'), 'personal');
});

// ---------------------------------------------------------------- focus after a re-render

/** A stand-in for a DOM element: a tag and its attributes, in source order. */
const control = (tag, attrs) => ({ tagName: tag.toUpperCase(), attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })) });

test('focus_returns_only_to_the_exact_control', () => {
  // Siblings that differ only by one data-* attribute must get different selectors.
  const pairs = [
    [{ 'data-action': 'ai-draft-choice', 'data-index': '0', 'data-option': 'Yes, 11:00 works for me' }, { 'data-action': 'ai-draft-choice', 'data-index': '0', 'data-option': "Sorry, I can't make 11:00" }],
    [{ role: 'tab', 'data-action': 'channel', 'data-channel': 'mail', 'aria-selected': 'true' }, { role: 'tab', 'data-action': 'channel', 'data-channel': 'chat', 'aria-selected': 'false' }],
    [{ type: 'checkbox', 'data-action': 'graph-permission', 'data-cap': 'mail_send' }, { type: 'checkbox', 'data-action': 'graph-permission', 'data-cap': 'chat_send' }],
  ];
  for (const [a, b] of pairs) {
    const sa = controlSelector(control('button', a));
    const sb = controlSelector(control('button', b));
    assert.ok(sa && sb && sa !== sb, `${sa} vs ${sb}`);
    assert.doesNotMatch(sa, /aria-|role=/, 'state that changes on render is not part of the identity');
  }
  assert.equal(controlSelector(control('button', { 'data-action': 'ai-draft-choice', 'data-option': 'Say "yes" \\ no' })),
    'button[data-action="ai-draft-choice"][data-option="Say \\"yes\\" \\\\ no"]', 'quotes and backslashes are escaped');
  assert.equal(controlSelector(control('textarea', { id: 'reply-body', name: 'body', class: 'ws-textarea' })), 'textarea[id="reply-body"][name="body"]');
  assert.equal(controlSelector(control('button', { class: 'ws-btn', type: 'button' })), null, 'nothing that tells it apart');
  // A tooltip's text changes with the control's state (Fold AI, then AI: Automations, Analytics).
  assert.equal(controlSelector(control('button', { 'data-action': 'sidebar-fold', 'data-group': 'ai', 'data-tip': 'Fold AI' })), 'button[data-action="sidebar-fold"][data-group="ai"]', 'data-tip is not part of the identity');
  assert.equal(controlSelector(null), null);

  // Focus goes back only when exactly one control matches.
  const root = n => ({ querySelectorAll: () => Array.from({ length: n }, (_, i) => ({ i })) });
  assert.deepEqual(soleMatch(root(1), 'button'), { i: 0 });
  assert.equal(soleMatch(root(2), 'button'), null, 'two candidates: leave focus alone');
  assert.equal(soleMatch(root(0), 'button'), null);
  assert.equal(soleMatch(root(1), null), null);
});

// ---------------------------------------------------------------- tasks

const TASKS_NOW = Date.UTC(2026, 10, 18, 12);
const tasksSnapshot = () => withTasks(buildSnapshot(TASKS_NOW, { photo: false, zone: 'UTC' }), TASKS_NOW);
const tasksCtx = (view = {}) => ({ state: { tasks: { ...newTasksView(), ...view } }, now: TASKS_NOW, banners: '' });
/** The markup of one card, from its article to the next one. */
const cardOf = (html, id) => html.match(new RegExp(`<article[^>]*data-task="${id}"[^]*?</article>`))?.[0] || '';

test('tasks board renders five columns, review cards with Accept/Dismiss, overdue in red', () => {
  const s = tasksSnapshot();
  s.records.push({ ...s.records.find(r => r.id === 'task-tenant'), id: 'task-xss', data: { ...s.records.find(r => r.id === 'task-tenant').data, text: '<img src=x onerror=alert(1)> escaped task', order: 20 } });
  const html = tasksPage(s, tasksCtx());
  assert.match(html, /<h1>Tasks<\/h1>/);
  const columns = [...html.matchAll(/<section class="ws-task-col[^"]*" data-col="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(columns, ['review', 'todo', 'doing', 'waiting', 'done']);
  for (const [col, name, count] of [['review', 'To review', 2], ['todo', 'To do', 6], ['doing', 'In progress', 1], ['waiting', 'Waiting', 1], ['done', 'Done', 2]]) {
    assert.match(html, new RegExp(`data-col="${col}"[^>]*>[^]*?<h2>${name}</h2><span class="ws-task-col-count"[^>]*>${count}</span>`), col);
  }
  // Review cards: the quote, Accept and Dismiss, no quick check.
  const review = cardOf(html, 'task-share');
  assert.match(review, /data-action="task-accept" data-id="task-share"/);
  assert.match(review, /data-action="task-dismiss" data-id="task-share"/);
  assert.match(review, /“I’ll share the Tasks board mockups tomorrow\.”/);
  assert.match(review, /Daily stand-up/);
  assert.doesNotMatch(review, /data-action="task-done"/);
  // Overdue: first in To do, red, with its chip.
  const todo = html.match(/<section class="ws-task-col" data-col="todo"[^]*?<\/section>/)[0];
  assert.ok(todo.indexOf('data-task="task-legal"') < todo.indexOf('data-task="task-names"'), 'overdue first');
  const legal = cardOf(html, 'task-legal');
  assert.match(legal, /class="ws-task ws-task-overdue"/);
  assert.match(legal, /ws-due ws-due-overdue/);
  assert.match(legal, /Sam/);
  // Owners by name with initials; mine says You; nobody's says Nobody.
  assert.match(cardOf(html, 'task-demo'), /<span class="ws-avatar[^"]*"[^>]*>TM<\/span><span>You<\/span>/);
  assert.match(cardOf(html, 'task-tenant'), /Nobody/);
  // Every card can be dragged and has a Move to menu for the keyboard.
  assert.match(legal, /draggable="true"/);
  assert.match(legal, /Move to[^]*?data-action="task-move" data-id="task-legal" data-col="doing"/);
  // Its title is the one task-open control on the card, so focus finds it again after a render.
  assert.equal([...legal.matchAll(/data-action="task-open"/g)].length, 1);
  assert.match(legal, /data-action="task-edit" data-id="task-legal"/);
  assert.doesNotMatch(legal, /data-action="task-move" data-id="task-legal" data-col="todo"/, 'not to where it is');
  assert.doesNotMatch(legal, /data-col="review"/, 'never back to review');
  // Quick add in every column but To review; drop zones too.
  assert.deepEqual([...html.matchAll(/data-action="task-quick" data-col="([a-z]+)"/g)].map(m => m[1]).filter((c, i, a) => a.indexOf(c) === i), ['todo', 'doing', 'waiting', 'done']);
  assert.deepEqual([...html.matchAll(/data-drop="([a-z]+)"/g)].map(m => m[1]), ['todo', 'doing', 'waiting', 'done']);
  // Done a month ago waits behind Show older; dismissed ones behind their link.
  assert.doesNotMatch(html, /data-task="task-room"/);
  assert.match(html, /data-action="tasks-older"[^>]*>[^]*?Show 1 older done task/);
  assert.match(tasksPage(s, tasksCtx({ showOlder: true })), /data-task="task-room"/);
  assert.match(html, /data-action="tasks-dismissed"[^>]*>[^]*?1 dismissed task/);
  // Provider and person text is escaped.
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; escaped task/);
  // Filters: lanes with counts, person, meeting and due selects, search.
  assert.match(html, /data-action="tasks-who" data-who="others" aria-selected="false">Owed to me<span class="ws-count">5<\/span>/);
  assert.match(html, /data-filter="meeting"[^]*?<option value="ev-sync">Philips CodeMie conversations syncup/);
  assert.match(html, /<option value="overdue">Overdue \(1\)<\/option>/);
  assert.match(html, /id="tasks-search"/);
  // Renamed columns come from Settings › Meetings.
  s.settings.meetings = { columns: { todo: 'Next up' } };
  assert.match(tasksPage(s, tasksCtx()), /<h2>Next up<\/h2>/);
  // A filter shows only what matches, with Clear filters.
  const owed = tasksPage(s, tasksCtx({ filters: { who: 'others', person: '', meeting: '', due: 'overdue', q: '' } }));
  assert.deepEqual([...owed.matchAll(/data-task="([^"]+)"/g)].map(m => m[1]), ['task-legal']);
  assert.match(owed, /data-action="tasks-clear"/);
  // Without the meetings in the snapshot (signed out) a card still says where it came from.
  const out = tasksSnapshot();
  out.records = out.records.filter(r => !['meeting', 'event'].includes(r.kind));
  const plain = tasksPage(out, tasksCtx());
  assert.match(cardOf(plain, 'task-legal'), /From a meeting/);
  assert.match(cardOf(plain, 'task-tenant'), /Added by you/);
});

test('low-confidence review cards show Check the owner', () => {
  const html = tasksPage(tasksSnapshot(), tasksCtx());
  assert.match(cardOf(html, 'task-bug'), /Check the owner/);
  assert.doesNotMatch(cardOf(html, 'task-share'), /Check the owner/);
  // The drawer says why.
  const drawer = tasksPage(tasksSnapshot(), tasksCtx({ drawer: 'task-bug' }));
  assert.match(drawer, /Found in the notes — owner unsure/);
});

test('task drawer shows the meeting quote with a link to the transcript line', () => {
  const s = tasksSnapshot();
  const html = tasksPage(s, tasksCtx({ drawer: 'task-legal' }));
  const drawer = html.match(/<aside class="ws-task-drawer"[^]*?<\/aside>/)?.[0] || '';
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /<textarea class="ws-task-drawer-title"[^>]*data-change="task-title"[^>]*>Send Legal the written legal-hold requirement<\/textarea>/);
  assert.match(drawer, /Philips CodeMie conversations syncup/);
  assert.match(drawer, /“I’ll send Legal the written requirement\.”/);
  assert.match(drawer, /Sam Okafor ·/);
  assert.match(drawer, /<a class="ws-link" href="#\/meetings\/ev-sync\/transcript" data-action="task-quote" data-id="task-legal">10:55 into the meeting — show in transcript<\/a>/);
  // Status, owner from the meeting's people first, due with quick picks, notes, history.
  assert.match(drawer, /data-action="task-move" data-id="task-legal" data-col="todo" aria-pressed="true"/);
  assert.match(drawer, /<optgroup label="In this meeting"><option value="jordan.lee@example.test">Jordan Lee<\/option>[^]*?<option value="sam.okafor@example.test" selected>Sam Okafor<\/option>[^]*?<option value="taylor.morgan@example.test">Taylor Morgan \(you\)<\/option><\/optgroup><optgroup label="Everyone else">/);
  // A typed date saves when the field is left (blur or Enter), not on every finished segment.
  assert.match(drawer, /data-commit="task-due"[^>]*value="2026-11-15"/);
  assert.doesNotMatch(drawer, /data-change="task-due"/);
  for (const [label, day] of [['Today', '2026-11-18'], ['Tomorrow', '2026-11-19'], ['Friday', '2026-11-20'], ['Next week', '2026-11-23'], ['No date', '']]) {
    assert.match(drawer, new RegExp(`data-action="task-due-pick" data-id="task-legal" data-value="${day}">${label}<`), label);
  }
  assert.match(drawer, /data-change="task-notes"/);
  assert.match(drawer, /Found in the notes \(Meeting notes\)/);
  assert.match(drawer, /update tasks\.json in the meeting folder/);
  // A task added by hand has no meeting section.
  const own = tasksPage(s, tasksCtx({ drawer: 'task-tenant' }));
  assert.doesNotMatch(own, /show in transcript|tasks\.json/);
  assert.match(own, /<option value="" selected>Nobody named<\/option>/);
});

test('list view groups I owe, Owed to me, Nobody named', () => {
  const html = tasksPage(tasksSnapshot(), tasksCtx({ view: 'list' }));
  const groups = [...html.matchAll(/<h2 class="ws-card-title">([^<]+)<span class="ws-tab-count">(\d+)<\/span><\/h2>/g)].map(m => [m[1], Number(m[2])]);
  assert.deepEqual(groups, [['I owe', 4], ['Owed to me', 6], ['Nobody named', 1]]);
  assert.doesNotMatch(html, /data-col="todo"/, 'no board');
  // Rows: done checkbox, title, owner, due, where it came from and a status select.
  assert.match(html, /<input type="checkbox" data-action="task-done" data-id="task-pilot" checked/);
  assert.match(html, /data-action="task-status" data-id="task-legal"/);
  assert.match(html, /To review<\/span>/);
  // Open tasks before done ones within a group.
  const owe = html.match(/I owe[^]*?<\/section>/)[0];
  assert.ok(owe.indexOf('task-demo') < owe.indexOf('commit-3'), 'open first');
  // Nothing matches: an empty state with Clear filters.
  const none = tasksPage(tasksSnapshot(), tasksCtx({ view: 'list', filters: { who: 'all', person: '', meeting: '', due: 'any', q: 'zzz' } }));
  assert.match(none, /No tasks match[^]*?data-action="tasks-clear"/);
});

test('dismissed tasks are listed and Restore puts them back in To review', async () => {
  const s = tasksSnapshot();
  const html = tasksPage(s, tasksCtx({ showDismissed: true }));
  const list = html.match(/<section class="ws-card ws-task-dismissed-list"[^]*?<\/section>/)?.[0] || '';
  assert.match(list, /Re-check the old dashboard/);
  assert.match(list, /data-action="task-restore" data-id="task-dashboard"/);
  const calls = [];
  const ctl = createTasksController({ state: { route: 'tasks', tasks: newTasksView() }, snap: () => s, mutate: async (op, data) => { calls.push([op, data]); return {}; }, render: async () => {}, toast: () => {}, now: () => TASKS_NOW });
  await ctl.handle('task-restore', { dataset: { id: 'task-dashboard' }, closest: () => null });
  assert.equal(calls[0][0], 'task_save');
  assert.deepEqual([calls[0][1].id, calls[0][1].status, calls[0][1].log], ['task-dashboard', 'review', 'Restored']);
});

test('Activity and the decisions call the due-today reminder by its name, not a critical alert', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const now = Math.floor(Date.now() / 1000);
  const job = (id, key, state, result) => ({ id, workspaceId: 'personal', connectionId: null, kind: 'notification', key, state, dueAt: now - 60, leaseUntil: null, attempts: 1, policy: null, payload: { title: '2 tasks due today', route: 'tasks' }, result });
  s.jobs.push(job('due-1', 'tasks_due:2026-11-18', 'succeeded', 'OS submission requested'), job('crit-1', 'critical:i1:e1:0', 'succeeded', 'Shown'));
  assert.equal(jobLabel(s.jobs.find(j => j.id === 'due-1')), 'Tasks due today');
  assert.equal(jobLabel(s.jobs.find(j => j.id === 'crit-1')), 'Critical alert');
  assert.equal(jobLabel({ kind: 'reminder', key: 'schedule-1:1795000000' }), 'Reminder');
  const activity = settings(s, ctx({ settingsTab: 'activity' }));
  assert.match(activity, /<strong>Tasks due today<\/strong><span>OS submission requested<\/span>/);
  assert.match(activity, /<strong>Critical alert<\/strong><span>Shown<\/span>/);
  s.jobs.push(job('due-2', 'tasks_due:2026-11-19', 'failed', 'OS notification submission failed.'));
  const decisions = inbox(s, ctx({ lane: 'decisions' }));
  assert.match(decisions, /<strong>Tasks due today<\/strong><p>OS notification submission failed\.<\/p>/);
});

// ---------------------------------------------------------------- meetings

const MEET_NOW = Date.UTC(2026, 10, 18, 15, 20);
const meetingsSnapshot = () => withMeetings(buildSnapshot(MEET_NOW, { photo: false, zone: 'UTC' }), MEET_NOW);
const FOLDERS = meetingFolders(MEET_NOW);
/** What the controller has read for a meeting: its transcript and documents, as native answers. */
const reads = (overrides = {}) => id => ({
  transcript: FOLDERS[id] ? { segments: FOLDERS[id].segments } : undefined,
  files: FOLDERS[id] ? { files: FOLDERS[id].files } : undefined,
  docs: Object.fromEntries(Object.entries(FOLDERS[id]?.docs || {}).map(([doc, text]) => [doc, { text }])),
  ...(overrides[id] || {}),
});
const meetingsCtx = (view = {}, extra = {}) => ({ state: { meetings: { ...newMeetingsView(), ...view }, tasks: newTasksView() }, now: MEET_NOW, banners: '', reads: reads(), ...extra });
/** One list row, from its button to the next. */
const rowOf = (html, id) => html.match(new RegExp(`<button type="button" class="ws-mtg-row[^"]*"[^>]*data-id="${id}"[^]*?</button>`))?.[0] || '';
/** The meeting: its header above the meeting's section, its tabs and the tab shown. */
const detailOf = html => html.match(/<div class="ws-mtg-top">[^]*$/)?.[0] || '';
const headOf = html => html.match(/<header class="ws-mtg-head"[^]*?<\/header>/)?.[0] || '';
/** A part of the page without its menus (what is on screen before a menu opens). */
const outsideMenus = html => html.replace(/<details[^]*?<\/details>/g, '');
/** A meetings controller over fakes: `calls` records what it sent and showed. */
function meetingsHarness(s, view = {}, answers = {}) {
  const calls = { mutate: [], toasts: [], modals: [] };
  const state = { route: 'meetings', meetings: { ...newMeetingsView(), ...view }, tasks: newTasksView() };
  const ctl = createMeetingsController({
    state, snap: () => s, store: { query: async () => ({}) },
    mutate: async (op, data) => { calls.mutate.push([op, data]); return answers[op] ?? { queued: true, jobId: `job-${calls.mutate.length}` }; },
    render: async () => {}, route: async () => {}, openModal: o => { calls.modals.push(o); return { querySelector: () => null }; }, confirmModal: o => calls.modals.push(o),
    toast: (message, tone, action) => calls.toasts.push({ message, tone, action }), writeText: async () => {}, downloadText: () => {}, focus: () => {}, now: () => MEET_NOW,
  });
  return { ctl, state, calls };
}
const notesJob = (meetingId, extra = {}) => ({ ...meetingContract().job, id: `job-${meetingId}`, payload: { ...meetingContract().job.payload, meetingId, ...extra } });

test('meetings list: one header row with search, filter and more; no segmented filter, no bulk banner, no footer switch', () => {
  const s = meetingsSnapshot();
  const html = meetings(s, meetingsCtx({ selected: 'mtg-philips' }));
  const head = html.match(/<header class="ws-mtg-list-head"[^]*?<\/header>/)?.[0] || '';
  assert.match(head, /<h1>Meetings<\/h1>/);
  assert.match(head, /data-action="meeting-search-open"/);
  const filter = head.match(/<details class="ws-menu[^"]*" data-menu="meetings-filter"[^]*?<\/details>/)?.[0] || '';
  for (const label of ['All meetings', 'Needs you', 'With notes', 'Coming up', 'Without a transcript (4)', 'Hidden meetings (0)']) assert.ok(filter.includes(label), label);
  assert.match(filter, /data-action="meeting-filter" data-filter="all"[^>]*aria-checked="true"/);
  assert.match(filter, /data-action="meeting-show-none"/);
  assert.match(filter, /data-action="meeting-show-hidden"/);
  const more = head.match(/<details class="ws-menu[^"]*" data-menu="meetings-more"[^]*?<\/details>/)?.[0] || '';
  for (const [label, action] of [['Fold all days', 'meeting-fold-all'], ['Unfold all days', 'meeting-unfold-all'], ['Import a transcript file…', 'meeting-import'], ['Check Teams for new transcripts', 'meeting-check-all'], ['Meetings settings', 'settings-tab']]) {
    assert.match(more, new RegExp(`data-action="${action}"[^]*?${label}`), label);
  }
  assert.doesNotMatch(html, /ws-mtg-filters|ws-mtg-bulk|ws-mtg-list-foot|ws-segmented-count/);
  assert.doesNotMatch(html, /id="meetings-search"/, 'the search field opens when asked');
  assert.match(meetings(s, meetingsCtx({ searchOpen: true })), /id="meetings-search"/);
  assert.match(meetings(s, meetingsCtx({ q: 'zzz' })), /id="meetings-search"[^>]*value="zzz"/, 'it stays while it has text');
  assert.match(meetings(s, meetingsCtx({ q: 'zzz' })), /Nothing matches “zzz”/);
});

test('meetings list: Needs you card with Make notes for N, rows without buttons', () => {
  const s = meetingsSnapshot();
  s.records.find(r => r.kind === 'meeting' && r.id === 'mtg-roadmap').data.title = 'Roadmap <b>review</b>';
  s.records.find(r => r.kind === 'event' && r.id === 'mtg-roadmap').data.title = 'Roadmap <b>review</b>';
  let html = meetings(s, meetingsCtx({ selected: 'mtg-philips' }));
  const card = html.match(/<section class="ws-mtg-needs"[^]*?<\/section>/)?.[0] || '';
  assert.match(card, /Needs you/);
  const inCard = [...card.matchAll(/class="ws-mtg-row[^"]*"[^>]*data-id="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...inCard].sort(), ['mtg-critique', 'mtg-northwind', 'mtg-release', 'mtg-roadmap', 'mtg-vendor']);
  assert.match(card, /data-action="meeting-make-all"[^>]*>(<span>)?Make notes for 3/);
  assert.match(card, /data-action="meeting-needs-fold"/);
  // Each row is one button holding no other control.
  for (const id of ['mtg-philips', ...inCard]) {
    const row = rowOf(html, id);
    assert.ok(row, id);
    assert.equal((row.match(/<button/g) || []).length, 1, `${id} holds no button`);
    assert.equal((row.match(/data-action=/g) || []).length, 1, `${id} holds no other control`);
  }
  // Colour only for what needs the person; a ready meeting says its documents in grey.
  const philips = rowOf(html, 'mtg-philips');
  assert.match(philips, /class="ws-mtg-row ws-mtg-on" role="option" aria-selected="true"/);
  assert.ok(philips.includes(formatTime(Date.UTC(2026, 10, 16, 13), 'UTC')), philips);
  assert.match(philips, /<strong>Philips CodeMie conversations syncup<\/strong>/);
  assert.doesNotMatch(philips, /ws-tone-|Notes ready/);
  assert.match(philips, /2 documents<i>·<\/i><span class="ws-mtg-accent">2 to review<\/span>/);
  for (const [id, tone, label] of [
    ['mtg-roadmap', 'info', 'No notes yet'], ['mtg-vendor', 'error', 'Couldn’t get the transcript'],
    ['mtg-northwind', 'warning', 'Teams blocked access'], ['mtg-critique', 'error', 'Notes failed'],
  ]) assert.match(rowOf(html, id), new RegExp(`<em class="ws-tone-${tone}"><i class="ws-mtg-dot"></i>${label}</em>`), id);
  // In the card each row says its day.
  assert.match(rowOf(html, 'mtg-roadmap'), /Yesterday/);
  assert.match(rowOf(html, 'mtg-roadmap'), /<strong>Roadmap &lt;b&gt;review&lt;\/b&gt;<\/strong>/, 'titles are escaped');
  for (const id of ['mtg-philips', 'mtg-roadmap', 'mtg-critique']) assert.doesNotMatch(rowOf(html, id), /<svg/, `${id} has no status icon`);
  assert.doesNotMatch(html, /ws-mtg-row-spin/, 'nothing runs: no spinner');
  // Waiting for Teams is no transcript yet: only with Meetings without a transcript.
  assert.equal(rowOf(html, 'mtg-sprint'), '', 'a meeting waiting for Teams stays out of All');
  const withNone = meetings(s, meetingsCtx({ selected: 'mtg-philips', showNone: true }));
  assert.match(rowOf(withNone, 'mtg-sprint'), /Waiting for Teams/);
  // A run: the row shows its step in purple and the one spinner; Make notes for all counts the rest.
  s.jobs.push(notesJob('mtg-roadmap'));
  html = meetings(s, meetingsCtx({ selected: 'mtg-philips' }));
  assert.match(rowOf(html, 'mtg-roadmap'), /<em class="ws-tone-purple">Writing notes with Meeting notes…<\/em>/);
  assert.match(rowOf(html, 'mtg-roadmap'), /<span class="ws-spinner ws-mtg-row-spin" role="status" aria-label="In progress"><\/span>/);
  assert.equal((html.match(/ws-mtg-row-spin/g) || []).length, 1);
  assert.match(html, /data-action="meeting-make-all"[^>]*>(<span>)?Make notes for 2/);
  // Today's meetings still to come: their own group on top of the days, greyed.
  assert.match(html, /aria-label="Coming up, [^"]*" data-day="coming"><div class="ws-mtg-day"><button type="button" class="ws-mtg-fold" data-action="meeting-day-fold" data-day="coming"[^>]*>[^]*?<strong>Coming up<\/strong><span>Today<\/span>/);
  assert.ok(html.indexOf('data-day="coming"') < html.indexOf('data-day="2026-'), 'Coming up comes before the days');
  assert.match(rowOf(html, 'ev-next'), /class="ws-mtg-row ws-mtg-future/);
});

test('meetings list: a folded day shows its count and a dot for what needs you', () => {
  const s = meetingsSnapshot();
  const html = meetings(s, meetingsCtx({ selected: 'mtg-roadmap', folded: { '2026-11-16': true } }));
  const day = html.match(/<div class="ws-mtg-group"[^>]*data-day="2026-11-16"[^]*?<\/div>\s*<\/div>/)?.[0] || '';
  assert.match(day, /data-action="meeting-day-fold" data-day="2026-11-16" aria-expanded="false"/);
  assert.equal(rowOf(html, 'mtg-philips'), '', 'a folded day shows no rows');
  assert.match(day, /1 meeting/);
  assert.match(day, /class="ws-mtg-day-dot"[^>]*>● 1</, 'the Philips sync has tasks to review');
  const open = meetings(s, meetingsCtx({ selected: 'mtg-roadmap' }));
  assert.match(open, /data-action="meeting-day-fold" data-day="2026-11-16" aria-expanded="true"/);
  assert.doesNotMatch(open, /ws-mtg-day-dot/);
  // The folded card keeps its header and count.
  const folded = meetings(s, meetingsCtx({ selected: 'mtg-philips', needsFolded: true }));
  const card = folded.match(/<section class="ws-mtg-needs"[^]*?<\/section>/)?.[0] || '';
  assert.match(card, /aria-expanded="false"/);
  assert.equal(rowOf(card, 'mtg-roadmap'), '');
  assert.match(card, />5</);
});

test('meetings list: hidden meetings leave the list and come back greyed', () => {
  const s = meetingsSnapshot();
  s.records.find(r => r.kind === 'event' && r.id === 'mtg-philips').data.seriesId = 'series-philips';
  const hidden = { ids: ['mtg-critique'], series: ['series-philips'] };
  let html = meetings(s, meetingsCtx({ selected: 'mtg-roadmap', hidden }));
  assert.equal(rowOf(html, 'mtg-critique'), '');
  assert.equal(rowOf(html, 'mtg-philips'), '', 'hidden by its series');
  assert.match(html, /data-action="meeting-show-hidden"[^>]*>[^]*?2 hidden meetings · <u>Show<\/u>/);
  assert.match(html, /Hidden meetings \(2\)/);
  html = meetings(s, meetingsCtx({ selected: 'mtg-roadmap', hidden, showHidden: true }));
  assert.match(rowOf(html, 'mtg-critique'), /class="ws-mtg-row ws-mtg-hid/);
  assert.match(rowOf(html, 'mtg-critique'), /Hidden/);
  assert.match(html, /Showing 2 hidden meetings · <u>Hide them<\/u>/);
  assert.doesNotMatch(html.match(/<section class="ws-mtg-needs"[^]*?<\/section>/)?.[0] || '', /mtg-critique/, 'never back in Needs you');
  // The row's right-click menu.
  html = meetings(s, meetingsCtx({ selected: 'mtg-roadmap', rowMenu: { id: 'mtg-roadmap', x: 40, y: 120 } }));
  const menu = html.match(/<div class="ws-menu-panel ws-mtg-rowmenu"[^]*?<\/div>/)?.[0] || '';
  assert.match(menu, /style="left:40px;top:120px"/);
  assert.match(menu, /data-action="meeting-select" data-id="mtg-roadmap"[^]*?Open/);
  assert.match(menu, /data-action="meeting-hide" data-id="mtg-roadmap"[^]*?Hide from the list/);
  assert.doesNotMatch(menu, /meeting-hide-series/, 'not a recurring meeting');
  assert.match(menu, /data-action="meeting-calendar" data-id="mtg-roadmap"[^]*?Show in calendar/);
  s.records.find(r => r.kind === 'event' && r.id === 'mtg-roadmap').data.seriesId = 'series-roadmap';
  html = meetings(s, meetingsCtx({ selected: 'mtg-roadmap', rowMenu: { id: 'mtg-roadmap', x: 40, y: 120 } }));
  assert.match(html, /data-action="meeting-hide-series" data-id="mtg-roadmap"[^>]*>[^]*?Hide every “Roadmap review”/);
  html = meetings(s, meetingsCtx({ selected: 'mtg-roadmap', hidden, showHidden: true, rowMenu: { id: 'mtg-philips', x: 0, y: 0 } }));
  assert.match(html, /data-action="meeting-unhide" data-id="mtg-philips"[^>]*>[^]*?Show every “Philips CodeMie conversations syncup” again/);
});

test('sidebar count and Today card leave hidden meetings out', () => {
  const s = meetingsSnapshot();
  const hidden = { ids: ['mtg-critique'], series: [] };
  const count = html => html.match(/title="Transcripts waiting for you">(\d+)</)?.[1];
  assert.equal(count(renderShell({ snapshot: s, route: 'meetings', resolvedDark: false, now: MEET_NOW })), '5');
  assert.equal(count(renderShell({ snapshot: s, route: 'meetings', resolvedDark: false, now: MEET_NOW, meetingsHidden: hidden })), '4');
  const ctx = { auth: {}, hidden: new Set(), banners: '', state: {}, now: MEET_NOW };
  assert.match(today(s, ctx), /data-action="meeting-open" data-id="mtg-critique"/);
  assert.doesNotMatch(today(s, { ...ctx, meetingsHidden: hidden }), /data-action="meeting-open" data-id="mtg-critique"/);
});

test('meeting detail: the title once, one meta line with faces, no strip, four tabs', () => {
  const s = meetingsSnapshot();
  const html = meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'notes' }));
  const detail = detailOf(html);
  const head = headOf(detail);
  assert.match(head, /<h2>Philips CodeMie conversations syncup<\/h2>/);
  assert.equal((head.match(/Philips CodeMie conversations syncup/g) || []).length, 1, 'the title once');
  const when = `${formatDate(Date.UTC(2026, 10, 16, 12), 'UTC', { weekday: 'short', month: 'short', day: 'numeric' })} · ${formatTime(Date.UTC(2026, 10, 16, 13), 'UTC')}–${formatTime(Date.UTC(2026, 10, 16, 14), 'UTC')} · Teams`;
  assert.ok(head.includes(when), `${when} in ${head}`);
  // People as faces: the stack says how many; its popover lists them with who they are.
  const stack = head.match(/<details class="ws-menu[^"]*ws-mtg-stack[^"]*"[^]*?<\/details>/)?.[0] || '';
  assert.match(stack, /<summary[^>]*>[^]*?6 people[^]*?<\/summary>/);
  assert.equal((stack.match(/<summary[^]*?<\/summary>/)[0].match(/class="ws-avatar/g) || []).length, 4, 'four faces');
  assert.match(stack, /<strong>Jeroen de Vries<\/strong><small>organizer · Philips<\/small>/);
  assert.match(stack, /<strong>Taylor Morgan<\/strong><small>you<\/small>/);
  assert.match(stack, /<strong>Anouk Bakker<\/strong><small>Philips<\/small>/);
  assert.match(stack, /class="ws-mtg-person ws-mtg-quiet"[^>]*>[^]*?Jordan Lee[^]*?didn’t speak/);
  assert.doesNotMatch(stack, /class="ws-mtg-person ws-mtg-quiet"[^>]*>[^]*?Priya Natarajan<\/strong>/);
  assert.match(stack, /% talking/);
  // No chip row, no strip, no People tab.
  assert.doesNotMatch(detail, /ws-mtg-pchip|ws-mtg-strip|data-tab="(mtg-)?people"/);
  // Four tabs in the meeting's section; a count only where tasks wait for review.
  const tabs = [...detail.matchAll(/data-action="dock-tab" data-page="meetings" data-tab="mtg-([a-z]+)" aria-selected="(true|false)"[^>]*>[^]*?<span>([A-Za-z]+)<\/span>(?:<span class="ws-tab-count">(\d+)<\/span>)?<\/button>/g)].map(m => [m[1], m[2], m[3], m[4] || '']);
  assert.deepEqual(tabs, [['notes', 'true', 'Notes', ''], ['transcript', 'false', 'Transcript', ''], ['tasks', 'false', 'Tasks', '2'], ['files', 'false', 'Files', '']]);
  // The header asks only for what waits: Review 2 tasks; no Another summary, no Make notes.
  const buttons = outsideMenus(head);
  assert.match(buttons, /data-action="meeting-tab"[^>]*data-tab="tasks"[^>]*>[^]*?Review 2 tasks/);
  assert.doesNotMatch(buttons, /Another summary|meeting-make-notes/);
  assert.match(detail, /<article class="ws-md">[^]*?<h3>TL;DR<\/h3>/);
  assert.match(detail, /data-action="meeting-goto-line" data-t="00:01"/);
  // Transcript: speaker filter, a line with its task, the unnamed guest to match, glossary underline.
  const transcript = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'transcript' }, { glossary: { pairs: [['code me', 'CodeMie']] } })));
  assert.match(transcript, /1 speaker without a name/);
  assert.match(transcript, /<select class="ws-select" data-action="meeting-speaker" data-id="mtg-philips" data-voice="@1" data-name="Speaker 1"/);
  assert.match(transcript, /<mark class="ws-mtg-fix" title="Written as “CodeMie” in notes \(your glossary\)">Code me<\/mark>/);
  assert.match(transcript, /data-action="task-open-today" data-id="task-endpoint"[^>]*>[^]*?Task for You: Add the by-id endpoint/);
  assert.match(transcript, /id="meeting-line-3"/);
  // An old link to the People tab opens Notes.
  assert.match(detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'people' }))), /data-tab="mtg-notes" aria-selected="true"/);
});

test('an upcoming, blocked, pending or untranscribed meeting shows its explainer instead of its tabs', () => {
  const s = meetingsSnapshot();
  for (const [id, text, action] of [
    ['mtg-sprint', 'Teams is still preparing the transcript', 'meeting-check'],
    ['mtg-northwind', 'doesn’t share this transcript with you', 'meeting-import'],
    ['mtg-planning', 'Nobody transcribed this meeting', 'meeting-import'],
    ['ev-next', 'After this meeting', null],
  ]) {
    const d = detailOf(meetings(s, meetingsCtx({ selected: id, showNone: true })));
    assert.match(d, /class="ws-mtg-panel-alone"/, id);
    assert.match(d, new RegExp(text), id);
    if (action) assert.match(d, new RegExp(`data-action="${action}"`), id);
  }
});

test('a Teams meeting on now by the calendar says so and offers Check now, as it may have ended early', () => {
  const s = meetingsSnapshot();
  const next = s.records.find(r => r.kind === 'event' && r.id === 'ev-next');
  next.data = { ...next.data, start: new Date(MEET_NOW - 10 * 60_000).toISOString(), end: new Date(MEET_NOW + 20 * 60_000).toISOString() };
  const m = meetingItems(s, MEET_NOW).find(x => x.id === 'ev-next');
  assert.equal(m.state, 'upcoming');
  assert.equal(m.live, true);
  const html = meetings(s, meetingsCtx({ selected: 'ev-next' }));
  assert.match(rowOf(html, 'ev-next'), /On now/);
  const d = detailOf(html);
  assert.match(d, /This meeting is still going[^]*?looks every 5 minutes, so it finds one that ends early too/);
  assert.match(d, /data-action="meeting-check" data-id="ev-next"|data-id="ev-next"[^>]*data-action="meeting-check"/);
  // One still to come is neither.
  const later = meetingItems(meetingsSnapshot(), MEET_NOW).find(x => x.id === 'ev-next');
  assert.equal(later.live, false);
  assert.doesNotMatch(detailOf(meetings(meetingsSnapshot(), meetingsCtx({ selected: 'ev-next' }))), /meeting-check|On now/);
});

test("the meeting's ⋯ menu offers Hide from the list, and a hidden meeting says so", () => {
  const s = meetingsSnapshot();
  let d = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips' })));
  assert.match(d, /data-action="meeting-hide" data-id="mtg-philips"/);
  assert.doesNotMatch(d, /Hidden from the list/);
  d = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', hidden: { ids: ['mtg-philips'], series: [] } })));
  assert.match(headOf(d), /Hidden from the list[^]*?data-action="meeting-unhide" data-id="mtg-philips"[^>]*>Show again/);
});

test('make notes for all queues one meeting_notes per to-do meeting with its own template', async () => {
  const s = meetingsSnapshot();
  s.records.find(r => r.kind === 'meeting' && r.id === 'mtg-release').data.template = 'short-summary';
  s.jobs.push(notesJob('mtg-vendor', { notesKey: 'mtg-vendor:meeting-notes' }));
  const { ctl, calls } = meetingsHarness(s);
  await ctl.handle('meeting-make-all', { dataset: {}, closest: () => null });
  const queued = calls.mutate.filter(([op]) => op === 'meeting_notes').map(([, d]) => [d.meetingId, d.templateId]).sort();
  assert.deepEqual(queued, [['mtg-release', 'short-summary'], ['mtg-roadmap', 'meeting-notes']], 'a running one is left alone');
  assert.ok(calls.mutate.every(([, d]) => d.findTasks === true && d.wishes === '' && d.batch === true), 'marked as a batch: a draft asked for meanwhile goes first');
  assert.match(calls.toasts.at(-1).message, /Making notes for 2 meetings/);
});

test('the meeting asks only where something waits: Review in the header, the rest in its tab or card', () => {
  const s = meetingsSnapshot();
  const detail = id => detailOf(meetings(s, meetingsCtx({ selected: id, showNone: true })));
  for (const id of ['mtg-philips', 'mtg-roadmap', 'mtg-sprint', 'mtg-critique', 'mtg-northwind', 'mtg-vendor', 'mtg-release']) {
    assert.doesNotMatch(outsideMenus(headOf(detail(id))), /data-action="meeting-(make-notes|retry|import|check|download)"/, `${id}: no step in the header`);
  }
  assert.match(detail('mtg-roadmap'), /data-form="meeting-notes" data-id="mtg-roadmap"/, 'Make notes: the Notes tab form');
  assert.match(detail('mtg-sprint'), /data-action="meeting-check"/, 'Check now: the waiting card');
  assert.match(detail('mtg-critique'), /data-action="meeting-retry"/, 'Try again: the failed run banner');
  assert.match(detail('mtg-northwind'), /data-action="meeting-import"/, 'Import: the blocked card');
  assert.match(detail('mtg-vendor'), /ws-mtg-run-failed[^]*?data-action="meeting-download"/, 'Try again: the failed save banner');
  assert.doesNotMatch(outsideMenus(headOf(detail('mtg-roadmap'))), /Review/);
  // Every task reviewed: no Review button.
  for (const t of s.records.filter(r => r.kind === 'commitment' && r.data.meetingId === 'mtg-philips')) t.data.status = 'todo';
  assert.doesNotMatch(headOf(detail('mtg-philips')), /Review \d task/);
  // A run: one slim line under the header with its progress and Cancel.
  s.jobs.push(notesJob('mtg-roadmap', { step: 'Finding tasks' }));
  const run = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-roadmap' })));
  const line = run.match(/<div class="ws-mtg-runline"[^]*?<\/div>/)?.[0] || '';
  assert.match(line, /aria-live="polite"/);
  assert.match(line, /<strong>Making Meeting notes<\/strong><small>Finding tasks… · step 2 of 3<\/small>/);
  assert.match(line, /<span class="ws-runbar" role="progressbar"[^>]*aria-valuenow="50"/);
  assert.match(line, /data-action="meeting-cancel" data-id="job-mtg-roadmap"/);
  assert.equal((run.match(/role="progressbar"/g) || []).length, 1);
});

test('no Download button: available reads "Saving the transcript", a failed save shows Try again, Make notes works from available', async () => {
  const s = meetingsSnapshot();
  const release = meetings(s, meetingsCtx({ selected: 'mtg-release' }));
  assert.doesNotMatch(release, />Download</);
  assert.match(detailOf(release), /Connect gets the transcript from Teams first, then writes the notes\./);
  assert.match(detailOf(release), /data-action="meeting-make-notes" data-id="mtg-release"/);
  const vendor = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-vendor', tab: 'transcript' })));
  assert.match(vendor, /Couldn’t get the transcript from Teams[^]*?Teams didn’t answer in time\.[^]*?data-action="meeting-download"/);
  // Make notes from a transcript still in Teams: the dialog says it saves it first.
  const { ctl, calls } = meetingsHarness(s);
  await ctl.handle('meeting-make-notes', { dataset: { id: 'mtg-release' }, closest: () => null });
  assert.match(calls.modals.at(-1).body, /Connect gets the transcript from Teams first, then writes the notes\./);
  const f = new FormData();
  f.append('template', 'meeting-notes');
  f.append('findTasks', 'on');
  await calls.modals.at(-1).onSubmit(f);
  assert.deepEqual(calls.mutate.at(-1), ['meeting_notes', { meetingId: 'mtg-release', templateId: 'meeting-notes', wishes: '', findTasks: true, remember: false }]);
  // Download again lives in the ⋯ menu of a saved transcript only.
  assert.match(detailOf(meetings(s, meetingsCtx({ selected: 'mtg-roadmap' }))), /data-action="meeting-download" data-id="mtg-roadmap"[^>]*>[^]*?<span>Download again from Teams<\/span>/);
});

const meetingData = (s, id) => s.records.find(r => r.kind === 'meeting' && r.id === id).data;

test('the Notes tab’s Make notes form renders what the view state keeps, so a refresh never resets it', () => {
  const s = meetingsSnapshot();
  const notes = view => detailOf(meetings(s, meetingsCtx({ selected: 'mtg-roadmap', tab: 'notes', ...view })));
  const radio = (html, id) => html.match(new RegExp(`<input type="radio" name="template" value="${id}"[^>]*>`))?.[0] || '';
  // Nothing chosen yet: the meeting's template, tasks on, nothing typed; fields say which meeting.
  let html = notes({});
  assert.match(radio(html, 'meeting-notes'), / checked/);
  assert.match(html, /<textarea[^>]*name="wishes"[^>]*data-make="mtg-roadmap"[^>]*><\/textarea>/);
  // Chosen and typed: rendered back as they were.
  html = notes({ makeForm: { 'mtg-roadmap': { templateId: 'short-summary', wishes: 'Only <the> decisions', findTasks: false, remember: true } } });
  assert.doesNotMatch(radio(html, 'meeting-notes'), / checked/);
  assert.match(radio(html, 'short-summary'), / checked/);
  assert.match(html, /name="wishes"[^>]*>Only &lt;the&gt; decisions<\/textarea>/);
  assert.match(html, /<input type="checkbox" name="findTasks"(?![^>]* checked)[^>]*>/);
  assert.match(html, /<input type="checkbox" name="remember"[^>]* checked/);
  // The dialog keeps its own fields (a dialog blocks renders).
  assert.doesNotMatch(makeNotesBody(s, meetingItems(s, MEET_NOW).find(m => m.id === 'mtg-roadmap'), { now: MEET_NOW }), /data-make=/);
});

test('save and notes errors show apart: a failed Download again on saved notes, the notes banner only for a notes run', () => {
  const s = meetingsSnapshot();
  // Ready, and Download again failed: a save banner whose Try again downloads; no notes banner.
  meetingData(s, 'mtg-philips').saveError = { code: 'provider', message: 'Teams didn’t answer in time.' };
  const philips = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips' })));
  assert.match(philips, /Download again didn’t work[^]*?Teams didn’t answer in time\.[^]*?Your transcript and notes are as they were\.[^]*?data-action="meeting-download" data-id="mtg-philips"/);
  assert.doesNotMatch(philips, /notes run didn’t finish|notes weren’t written|data-action="meeting-retry"/);
  // Downloaded, the same: visible on the meeting.
  meetingData(s, 'mtg-roadmap').saveError = { code: 'provider', message: 'Teams didn’t answer in time.' };
  assert.match(detailOf(meetings(s, meetingsCtx({ selected: 'mtg-roadmap' }))), /Download again didn’t work[^]*?data-action="meeting-download" data-id="mtg-roadmap"/);
  // A failed notes run: the notes banner, whose Try again makes the notes again.
  const critique = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-critique' })));
  assert.match(critique, /The notes weren’t written[^]*?data-action="meeting-retry" data-id="mtg-critique"/);
  assert.doesNotMatch(critique, /Download again didn’t work|Couldn’t get the transcript/);
  // An older record with one lastError reads as before: on a found transcript, the save's.
  const vendor = meetingData(s, 'mtg-vendor');
  delete vendor.saveError;
  delete vendor.notesError;
  vendor.lastError = { code: 'provider', message: 'An older failure.' };
  assert.match(detailOf(meetings(s, meetingsCtx({ selected: 'mtg-vendor' }))), /Couldn’t get the transcript from Teams[^]*?An older failure\./);
});

test('a save that needs a Microsoft sign-in offers Sign in again, then Try again once signed in; an unwritable folder leads to Settings', () => {
  const s = meetingsSnapshot();
  const vendor = meetingData(s, 'mtg-vendor');
  vendor.saveError = { code: 'needs_login', message: 'Microsoft authorization expired.' };
  s.connection.status = 'needs_login';
  let html = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-vendor' })));
  assert.match(html, /ws-mtg-paused[^]*?data-action="graph-connect"[^>]*>[^]*?Sign in again/, 'the waiting banner signs in again');
  // Signed in again: no Sign in again anywhere; Try again saves it, and the round will too.
  s.connection.status = 'connected';
  html = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-vendor' })));
  assert.doesNotMatch(html, /Sign in again|graph-connect/);
  assert.match(html, /ws-mtg-run-failed[^]*?data-action="meeting-download"[^>]*data-id="mtg-vendor"[^>]*>[^]*?Try again/);
  assert.match(html, /You’re signed in again: Connect tries again by itself in a few minutes\./);
  // A meetings folder Connect can't write to: the button goes where the text says.
  vendor.saveError = { code: 'folder_unwritable', message: 'Connect can’t write to /Volumes/Gone/Meetings. Choose the folder again in Settings › Meetings.' };
  html = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-vendor' })));
  assert.match(html, /ws-mtg-run-failed[^]*?data-action="settings-tab"[^>]*data-tab="meetings-transcripts"[^>]*>[^]*?Open Settings › Meetings/);
  assert.doesNotMatch(html, /data-action="meeting-download"/);
  // Stopped by the person: said so, and only they start it again.
  vendor.saveError = { code: 'cancelled', message: 'You stopped saving the transcript, so Connect won’t try again by itself.' };
  html = meetings(s, meetingsCtx({ selected: 'mtg-vendor' }));
  assert.match(rowOf(html, 'mtg-vendor'), /<small><span>Saving stopped<\/span><i>·<\/i><span class="ws-mtg-row-time">/, 'a save the person stopped is grey, first in the card');
  assert.match(detailOf(html), /Saving the transcript stopped[^]*?data-action="meeting-download"[^>]*>[^]*?Try again/);
});

test('notes asked for during a failed save are promised after the transcript; without a request nothing is promised', () => {
  const s = meetingsSnapshot();
  assert.doesNotMatch(detailOf(meetings(s, meetingsCtx({ selected: 'mtg-vendor' }))), /is made as soon as it’s saved/);
  meetingData(s, 'mtg-vendor').pendingNotes = { templateId: 'short-summary', wishes: 'Only decisions', findTasks: true, workspaceId: 'personal', jobId: 'job-1' };
  assert.match(detailOf(meetings(s, meetingsCtx({ selected: 'mtg-vendor' }))), /Short summary is made as soon as it’s saved\./);
});

test('stored available and pending meetings show as waiting, with why, while transcripts are off', () => {
  const s = meetingsSnapshot();
  s.connection.enabled = s.connection.enabled.filter(c => c !== 'transcripts');
  const html = meetings(s, meetingsCtx({ selected: 'mtg-release', showNone: true }));
  for (const id of ['mtg-release', 'mtg-sprint']) assert.match(rowOf(html, id), /<em class="ws-tone-warning"><i class="ws-mtg-dot"><\/i>Waiting: transcripts are off<\/em>/, id);
  const detail = detailOf(html);
  assert.doesNotMatch(detail, /ws-spin|ws-mtg-runline/);
  assert.match(detail, /Reading Teams transcripts is off[^]*?data-action="meeting-transcripts-on"/);
  // Not "Make notes for all" (it can't save them now), and one meeting left needs no batch.
  assert.doesNotMatch(html, /data-action="meeting-make-all"/);
});

test('a meeting waiting for Teams offers "Make notes as soon as it arrives", which sends meeting_set {auto:true}', async () => {
  const s = meetingsSnapshot();
  const html = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-sprint' })));
  assert.match(html, /Teams is still preparing the transcript/);
  assert.match(html, /<input type="checkbox" role="switch" data-action="meeting-auto" data-id="mtg-sprint"><span class="ws-switch-track"[^]*?Make notes as soon as it arrives/);
  const { ctl, calls } = meetingsHarness(s);
  await ctl.handle('meeting-auto', { dataset: { id: 'mtg-sprint' }, checked: true, closest: () => null });
  assert.deepEqual(calls.mutate.at(-1), ['meeting_set', { meetingId: 'mtg-sprint', auto: true }]);
  assert.match(calls.toasts.at(-1).message, /as soon as Teams has the transcript/);
  // Once on, the switch is on and the row says so.
  s.records.find(r => r.kind === 'meeting' && r.id === 'mtg-sprint').data.auto = true;
  const after = meetings(s, meetingsCtx({ selected: 'mtg-sprint', showNone: true }));
  assert.match(after, /role="switch" checked data-action="meeting-auto" data-id="mtg-sprint"/);
  assert.match(rowOf(after, 'mtg-sprint'), /notes when it arrives/);
});

test('files tab offers download again when the folder is missing', () => {
  const s = meetingsSnapshot();
  const ok = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-roadmap', tab: 'files' })));
  assert.match(ok, /<strong>transcript\.md<\/strong>/);
  assert.match(ok, /data-action="meeting-file-preview" data-id="mtg-roadmap" data-file="segments\.json"/);
  assert.match(ok, /data-action="meeting-file-save"[^>]*data-id="mtg-roadmap" data-file="segments\.json"/);
  const missing = { files: { error: { code: 'folder_missing', message: 'The meeting folder is gone.' } } };
  const gone = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-roadmap', tab: 'files' }, { reads: reads({ 'mtg-roadmap': missing }) })));
  assert.match(gone, /The meeting folder is gone/);
  assert.match(gone, /data-action="meeting-download" data-id="mtg-roadmap"[^>]*>[^]*?<span>Download again<\/span>/);
  // An imported transcript can't come from Teams again: import it again instead.
  s.records.find(r => r.kind === 'meeting' && r.id === 'mtg-roadmap').data.imported = 'roadmap.vtt';
  const imported = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-roadmap', tab: 'files' }, { reads: reads({ 'mtg-roadmap': missing }) })));
  assert.match(imported, /data-action="meeting-import" data-id="mtg-roadmap"/);
});

test('calendar badge appears on online meetings only and the event card offers Show in Meetings', () => {
  const s = meetingsSnapshot();
  const state = { calendarMode: 'week', calendarDate: new Date(MEET_NOW), meetings: newMeetingsView() };
  const html = calendar(s, { state, auth: {}, hidden: new Set(), banners: '', now: MEET_NOW });
  const block = id => html.match(new RegExp(`<button type="button" class="ws-ev[^"]*" data-action="event" data-id="${id}"[^]*?</button>`))?.[0] || '';
  assert.match(block('mtg-philips'), /<span class="ws-tb ws-tb-ready" title="Notes ready · Meeting notes">/);
  assert.match(block('mtg-roadmap'), /ws-tb ws-tb-process/);
  assert.match(block('mtg-sprint'), /ws-tb ws-tb-busy/);
  assert.match(block('mtg-critique'), /ws-tb ws-tb-attention/);
  assert.match(block('ev-week-1'), /ws-tb ws-tb-auto/);
  assert.doesNotMatch(block('mtg-lunch'), /ws-tb/, 'in person: no badge');
  assert.doesNotMatch(block('ev-next'), /ws-tb/, 'upcoming without automatic notes: no badge');
  // The side panel: the switch and the legend with this view's counts.
  assert.match(html, /data-action="calendar-transcripts"[^>]*>[^]*?Only meetings with transcripts/);
  assert.match(html, /<span class="ws-tb ws-tb-attention">[^]*?<span>Needs you<\/span><small>2<\/small>/);
  // The event card: Transcript & notes with the next step; the footer opens the meeting.
  const roadmap = s.records.find(r => r.kind === 'event' && r.id === 'mtg-roadmap');
  const card = eventDetails(s, roadmap);
  assert.match(card, /<section class="ws-mtg-ev">[^]*?<strong>Transcript &amp; notes<\/strong>[^]*?No notes yet/);
  assert.match(card, /data-action="meeting-make-notes" data-id="mtg-roadmap"/);
  assert.match(eventActions(s, roadmap), /data-action="meeting-open" data-id="mtg-roadmap"[^>]*><span>Show in Meetings<\/span>/);
  const lunch = s.records.find(r => r.kind === 'event' && r.id === 'mtg-lunch');
  assert.match(eventDetails(s, lunch), /In-person meeting — Teams won’t have a transcript/);
  assert.doesNotMatch(eventActions(s, lunch), /Show in Meetings/);
  // Only meetings with transcripts: the others are dimmed in the week.
  const only = calendar(s, { state: { ...state, calendarTranscripts: true }, auth: {}, hidden: new Set(), banners: '' });
  assert.match(only, /class="ws-ev[^"]*ws-mtg-dim[^"]*" data-action="event" data-id="mtg-lunch"/);
  assert.doesNotMatch(only, /class="ws-ev[^"]*ws-mtg-dim[^"]*" data-action="event" data-id="mtg-philips"/);
});

test('today meetings card lists needs-you before to-do and links to the meeting', () => {
  const s = meetingsSnapshot();
  const ctx = { auth: {}, hidden: new Set(), banners: '', state: {}, now: MEET_NOW };
  const w = active(s);
  // Not on the grid and never removed: it shows itself at the bottom, full width, while something waits.
  w.layout = ['brief'];
  w.today = { active: 'Mine', items: [{ id: 'brief', x: 0, y: 0, w: 8, h: 4 }], hidden: [] };
  let html = today(s, ctx);
  const card = html.match(/<section class="ws-card[^"]*ws-mtg-today[^"]*"[^]*?<\/section>/)?.[0] || '';
  assert.match(card, /data-tile="meetings" style="--x:0;--y:4;--w:12;--h:5;--order:1"/);
  assert.match(card, /From your meetings/);
  const rows = [...card.matchAll(/data-action="meeting-open" data-id="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(rows.slice(0, 2).sort(), ['mtg-critique', 'mtg-northwind'], 'needs you first');
  assert.deepEqual(rows.slice(2).sort(), ['mtg-release', 'mtg-roadmap', 'mtg-vendor']);
  assert.match(card, /Teams blocked the transcript/);
  assert.match(card, /Notes failed — try again/);
  assert.match(card, /Transcript saved, no notes yet/);
  assert.match(card, /data-action="route" data-route="meetings"/);
  // "Only meetings that need me": the to-do ones go.
  w.today.options = { meetings: { needsMe: true } };
  const needsMe = today(s, ctx).match(/<section class="ws-card[^"]*ws-mtg-today[^"]*"[^]*?<\/section>/)?.[0] || '';
  assert.deepEqual([...needsMe.matchAll(/data-action="meeting-open" data-id="([^"]+)"/g)].map(m => m[1]).sort(), ['mtg-critique', 'mtg-northwind']);
  // Removed from Today: it stays away.
  w.today.hidden = ['meetings'];
  assert.doesNotMatch(today(s, ctx), /ws-mtg-today/);
  // No grid saved yet: the old Customize dialog's rule still hides it.
  w.today = {};
  w.widgetWidths = { brief: 8, meetings: 6 };
  assert.doesNotMatch(today(s, ctx), /ws-mtg-today/);
  // On the grid and nothing waiting: all caught up.
  w.today = { active: 'Mine', items: [{ id: 'meetings', x: 0, y: 0, w: 6, h: 5 }] };
  for (const r of s.records.filter(x => x.kind === 'meeting')) r.data.state = 'ready';
  html = today(s, ctx);
  assert.match(html, /ws-mtg-today[^]*?All caught up[^]*?Every transcript has notes\./);
  assert.ok(WIDGETS.meetings && WIDGETS.meetings.title === 'From your meetings');
});

test('Activity names transcript checks, transcript saves and meeting notes', () => {
  assert.equal(jobLabel({ kind: 'transcript_check', key: 'transcript_check:m:1' }), 'Transcript check');
  assert.equal(jobLabel({ kind: 'transcript_download', key: 'transcript_download:auto:m:1' }), 'Transcript save');
  assert.equal(jobLabel({ kind: 'meeting_notes', key: 'meeting_notes:op' }), 'Meeting notes');
});

test('transcript search and glossary marks never split escaped text', () => {
  const s = meetingsSnapshot();
  const segments = [{ address: 'jordan.lee@example.test', end: 9, name: 'Jordan Lee', speaker: 'remote', start: 0, text: 'R&D said <b>code me</b> & amp', voice: 'Jordan Lee' }];
  const read = reads({ 'mtg-roadmap': { transcript: { segments } } });
  const html = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-roadmap', tab: 'transcript', tq: 'amp' }, { reads: read, glossary: { pairs: [['code me', 'CodeMie']] } })));
  assert.match(html, /<p>R&amp;D said &lt;b&gt;<mark class="ws-mtg-fix" title="Written as “CodeMie” in notes \(your glossary\)">code me<\/mark>&lt;\/b&gt; &amp; <mark class="ws-mtg-hit">amp<\/mark><\/p>/);
  assert.match(html, /1 match/);
});

test('meeting operations survive a background sync: they rebase once on a stale view', async () => {
  // Their outcome never depends on the revision the person saw: notes and saves dedupe natively,
  // and a document edit is fenced by its own baseVersion/baseRev (conflict).
  for (const op of ['meeting_check', 'meeting_download', 'meeting_import', 'meeting_speakers', 'meeting_notes', 'meeting_set', 'meeting_doc', 'meeting_rule_save']) assert.ok(REBASE_SAFE.has(op), op);
  let revision = 7;
  const sent = [];
  const store = createStore(async (cmd, { request }) => {
    if (request.op === 'snapshot') return { snapshot: { revision, settings: { activeWorkspace: 'personal' } } };
    sent.push(request.expectedRevision);
    if (sent.length === 1) { revision = 8; throw { code: 'stale_view', message: 'This view changed.' }; }
    return { saved: true };
  });
  await store.refresh();
  assert.deepEqual(await store.mutate('meeting_doc', { action: 'edit' }), { saved: true });
  assert.deepEqual(sent, [7, 8]);
});

test('a meeting is Echo\'s call for plugins, and their call slots show as text on its page', () => {
  const s = meetingsSnapshot();
  const rec = s.records.find(r => r.kind === 'meeting' && r.id === 'mtg-philips');
  const name = rec.data.folder.split('/').pop();
  const call = shownCall(s, meetingsCtx({ selected: 'mtg-philips' }));
  assert.deepEqual(Object.keys(call), ['name', 'stamp', 'title', 'started_at', 'notes', 'profile', 'memo', 'threads', 'client']);
  assert.equal(call.name, name);
  assert.equal(call.title, 'Philips CodeMie conversations syncup');
  assert.equal(call.notes, true, 'it has notes');
  assert.match(call.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(callOfMeeting({ rec: { data: { folder: '/m/2026-11-04_160426-sync/' } }, title: 'Sync', start: NaN }).stamp, '2026-11-04_160426');
  assert.equal(callOfMeeting({ rec: { data: { folder: '/m/Atlas' } }, title: 'A', start: 0 }).stamp, 'Atlas');
  assert.equal(callOfMeeting({ rec: null, title: 'No folder' }), null);
  assert.equal(callOfMeeting(null), null);
  // What plugins' slots say, for this meeting only: a chip, ⋯ items, a line while notes run.
  const callSlots = [
    { plugin: 'obsidian', pluginName: 'Knowledge', call: name, header: ['Minutes → Work <b>'], menu: ['Save to Knowledge…', 'Open in Work'], minutes: ['Then saved to Work, with a row in the index.'] },
    { plugin: 'other', pluginName: 'Other', call: 'another-folder', header: ['Not this one'], menu: ['Nope'], minutes: [] },
  ];
  const html = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips' }, { callSlots })));
  assert.match(html, /<span class="ws-mtg-plugin-chip" title="Knowledge: Minutes → Work &lt;b&gt;">.*<span>Minutes → Work &lt;b&gt;<\/span><\/span>/, 'text, escaped');
  assert.match(html, /data-action="plugin-call-menu" data-plugin-id="obsidian" data-index="0"[^>]*>.*<span>Save to Knowledge…<\/span>/);
  assert.match(html, /data-action="plugin-call-menu" data-plugin-id="obsidian" data-index="1"[^>]*>.*<span>Open in Work<\/span>/);
  assert.doesNotMatch(html, /Not this one|Nope/, 'another meeting\'s slots');
  assert.doesNotMatch(html, /ws-mtg-plugin-line/, 'the line shows only while notes are made');
  s.jobs.push(notesJob('mtg-philips', { step: 'Finding tasks' }));
  const running = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips' }, { callSlots })));
  assert.match(running, /<p class="ws-mtg-plugin-line" title="Knowledge">.*<span>Then saved to Work, with a row in the index\.<\/span><\/p>/);
  // No slots: the page as before.
  const plain = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips' })));
  assert.doesNotMatch(plain, /ws-mtg-plugin|plugin-call-menu/);
});

test('an unnamed speaker\'s line asks "Who is this?" without leaving the transcript', () => {
  const s = meetingsSnapshot();
  const transcript = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'transcript' })));
  assert.match(transcript, /data-action="meeting-name-speaker" data-voice="@1"[^>]*>Who is this\?/);
  assert.doesNotMatch(transcript, /data-tab="people"/);
});

test('notes: one toolbar, no document chips, no One/Side by side switch', () => {
  const s = meetingsSnapshot();
  const detail = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'notes' })));
  const tools = detail.match(/<div class="ws-mtg-doctools">[^]*?<\/div>(?=\s*<div class="ws-mtg-docpage")/)?.[0] || '';
  assert.ok(tools, 'the toolbar');
  const picker = tools.match(/<details class="ws-menu[^"]*ws-mtg-doc-picker[^"]*"[^]*?<\/details>/)?.[0] || '';
  assert.match(picker, /<summary[^>]*>[^]*?Meeting notes[^]*?<small>1 of 2<\/small>/);
  assert.match(picker, /data-action="doc-view" data-id="mtg-philips" data-doc="meeting-notes"[^>]*aria-checked="true"[^>]*>[^]*?Meeting notes \(main\)/);
  assert.match(picker, /data-action="doc-view" data-id="mtg-philips" data-doc="short-summary"[^>]*aria-checked="false"/);
  assert.match(picker, /data-action="meeting-compare" data-v="1"[^>]*>[^]*?Compare side by side/);
  assert.match(tools, /data-action="meeting-make-notes"[^>]*data-id="mtg-philips"[^>]*>[^]*?New summary/);
  assert.match(tools, /data-action="meeting-compare"[^>]*data-v="1"[^>]*aria-pressed="false"/, 'the side-by-side toggle');
  for (const action of ['doc-copy', 'doc-save', 'doc-edit']) assert.match(tools, new RegExp(`data-action="${action}"`), action);
  assert.match(tools, /data-action="doc-delete"/, 'the document’s ⋯ menu');
  assert.doesNotMatch(detail, /ws-mtg-doctab|aria-label="Documents"|aria-label="Layout"|Another summary/);
  // Side by side: two columns, each with its own document select.
  const compare = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'notes', compare: true })));
  assert.equal((compare.match(/data-action="doc-compare-pick"/g) || []).length, 2);
  assert.match(compare, /data-action="meeting-compare"[^>]*data-v="0"[^>]*aria-pressed="true"/);
  // A run making another document: said once, by the line under the header; the notes stay.
  s.jobs.push(notesJob('mtg-philips', { templateId: 'short-summary' }));
  const busy = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'notes' })));
  assert.equal((busy.match(/Making Short summary/g) || []).length, 1);
  assert.match(busy, /class="ws-mtg-runline"[^]*?Making Short summary/);
  assert.match(busy, /<div class="ws-mtg-docpage"/);
});

test('notes: the document reads as a page', () => {
  const s = meetingsSnapshot();
  const detail = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'notes' })));
  const page = detail.match(/<div class="ws-mtg-docpage"[^]*$/)?.[0] || '';
  assert.ok(page, 'the page');
  assert.doesNotMatch(page, /ws-md-front|<dl/, 'no properties table');
  assert.match(page, /<p class="ws-md-tags"><span class="ws-md-tag">meeting<\/span><span class="ws-md-tag">philips<\/span><span class="ws-md-tag">pilot<\/span><\/p>/);
  assert.doesNotMatch(page, /<h2>Philips CodeMie conversations syncup<\/h2>/, 'the title isn’t repeated');
  assert.match(page, /<h3>TL;DR<\/h3>/);
  const foot = page.match(/<p class="ws-mtg-docfoot">[^]*?<\/p>/)?.[0] || '';
  assert.match(foot, /Built-in template · made [^·]+ automatically/);
  assert.match(foot, /You asked: “[^”]+”/);
  assert.match(foot, /\d+ words · notes\.md/);
  assert.doesNotMatch(detail, /ws-mtg-doc-meta|ws-mtg-wishes/, 'no provenance line or banner above the notes');
  // The other document: its own words, and a way to make it the main notes.
  const other = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'notes', docView: { 'mtg-philips': 'short-summary' } })));
  assert.match(other.match(/<p class="ws-mtg-docfoot">[^]*?<\/p>/)?.[0] || '', /data-action="doc-main" data-id="mtg-philips" data-doc="short-summary"[^>]*>make it the main notes/);
});

test('tasks: "2 to review · 1 on the board", Accept only on tasks to review', () => {
  const s = meetingsSnapshot();
  const tab = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'tasks' })));
  assert.match(tab, /<h3>2 to review<\/h3><small>· 1 on the board<\/small>/);
  assert.match(tab, /data-action="meeting-tasks-accept"[^>]*>[^]*?Accept all 2/);
  assert.match(tab, /data-action="meeting-board"[^>]*>[^]*?Open board/);
  assert.equal((tab.match(/data-action="task-accept"/g) || []).length, 2);
  assert.doesNotMatch(tab, /Tasks from this meeting/);
  // Nothing to review: just how many.
  for (const t of s.records.filter(r => r.kind === 'commitment' && r.data.meetingId === 'mtg-philips')) t.data.status = 'todo';
  assert.match(detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'tasks' }))), /<h3>3 tasks<\/h3>/);
});

test('tasks: two lines — owner and date chips, a date menu, no bare date field', () => {
  const s = meetingsSnapshot();
  const tab = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-philips', tab: 'tasks' })));
  const rows = tab.split(/<div class="ws-mtg-trow(?=[" ])/).slice(1);
  assert.equal(rows.length, 3);
  const rowFor = id => rows.find(r => r.includes(`data-id="${id}"`)) || '';
  for (const r of rows) {
    assert.equal((r.match(/class="ws-mtg-trow-meta"/g) || []).length, 1);
    // The only date field is inside the date menu: WebKit shows today's date in an empty one.
    assert.doesNotMatch(outsideMenus(r), /type="date"/);
    assert.match(r, /<select class="ws-select" data-action="task-owner" data-id="task-/);
  }
  // No date yet: "Add date"; the menu has the quick picks and a date field, and nothing to clear.
  const endpoint = rowFor('task-endpoint');
  const menu = endpoint.match(/<details class="ws-menu[^"]*ws-mtg-due"[^]*?<\/details>/)?.[0] || '';
  assert.match(menu, /data-menu="due-task-endpoint"/);
  assert.match(menu, /<summary[^>]*>[^]*?Add date/);
  for (const [label, day] of quickDates(MEET_NOW, 'UTC')) assert.match(menu, new RegExp(`data-action="task-due-pick" data-id="task-endpoint" data-value="${day}"[^>]*>[^]*?${label}<`), label);
  assert.match(menu, /type="date"[^>]*data-commit="task-due" data-id="task-endpoint"/);
  assert.doesNotMatch(menu, /No date/);
  assert.match(endpoint, /data-action="task-dismiss"[^>]*data-id="task-endpoint"/);
  assert.match(endpoint, /data-action="task-accept"[^>]*data-id="task-endpoint"/);
  // A due date: the board's text and tone, No date to clear it; on the board: the status pill.
  const legal = rowFor('task-legal-req');
  const due = dueInfo(s.records.find(r => r.id === 'task-legal-req').data.due, MEET_NOW, 'UTC');
  assert.match(legal, new RegExp(`<summary class="[^"]*ws-due-${due.tone}[^>]*>[^]*?${due.text}`));
  assert.match(legal, /data-action="task-due-pick" data-id="task-legal-req" data-value=""[^>]*>[^]*?No date</);
  assert.match(legal, /data-action="task-status" data-id="task-legal-req"/);
  assert.doesNotMatch(legal, /task-accept/);
  // An owner Connect isn't sure of: the chip says so (no separate warning line).
  assert.match(rowFor('task-pilot-list'), /ws-mtg-chip-warn[^]*?Check owner/);
  assert.doesNotMatch(tab, /Not sure about the owner — check it<\/span>/);
});

test('a meeting without a transcript keeps its tasks and the add form under its card', () => {
  const s = meetingsSnapshot();
  for (const id of ['mtg-northwind', 'ev-next']) {
    const d = detailOf(meetings(s, meetingsCtx({ selected: id })));
    assert.match(d, /class="ws-mtg-panel-alone"/, id);
    assert.match(d, /form class="ws-mtg-add-task" data-form="meeting-task" data-id="[^"]+"/, `${id}: Add a task`);
    assert.doesNotMatch(d, /Tasks come from the notes/, `${id}: no empty state under the card`);
  }
  // A task already linked to it shows there.
  const t = s.records.find(r => r.kind === 'commitment' && r.data.meetingId === 'mtg-philips');
  t.data.meetingId = 'mtg-northwind';
  const d = detailOf(meetings(s, meetingsCtx({ selected: 'mtg-northwind' })));
  assert.match(d, new RegExp(`data-action="task-open-today" data-id="${t.id}"`));
  // The people popover names a person's tasks, without a link to a tab that isn't there.
  assert.doesNotMatch(d.match(/<details class="ws-menu[^"]*ws-mtg-stack[^"]*"[^]*?<\/details>/)?.[0] || '', /data-action="meeting-tab"/);
});
