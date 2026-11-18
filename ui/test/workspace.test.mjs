import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, escapeHtml, REBASE_SAFE } from '../workspace/store.js';
import { runReadOnlyProbe } from '../workspace/safe-probe.js';
import {
  calendarDays, calendarWindow, calendarCoverage, calendarIds, calendarColor, eventSpan, eventsOnDay,
  layoutColumns, freeSlots, groupCalendarEvents,
} from '../workspace/calendar-model.js';
import {
  dayKey, addDaysToKey, minutesOfDay, initials, firstName, relativeAge, agoLabel, countdownLabel, durationLabel, greeting, colorFor, formatTime,
} from '../workspace/format.js';
import { attentionMessages, messageTitle, connectionState, decisions, sourceCounts, conversation, collapseChats } from '../workspace/selectors.js';
import { snoozeUntil, filteredMessages, inbox } from '../workspace/view-inbox.js';
import { today, todayModel } from '../workspace/view-today.js';
import { calendar, periodTitle, eventDetails } from '../workspace/view-calendar.js';
import { settings, jobLabel } from '../workspace/view-settings.js';
import { renderShell, NAV } from '../workspace/shell.js';
import { bootWorkspace, notificationWorkspaceToSelect } from '../workspace/boot.js';
import { controlSelector, soleMatch } from '../workspace/ui.js';
import { tasksPage } from '../workspace/view-tasks.js';
import { createTasksController } from '../workspace/tasks-controller.js';
import { newTasksView } from '../workspace/tasks-model.js';
import { buildSnapshot, withTasks } from './fixtures/workspace-fixture.mjs';

// ---------------------------------------------------------------- store

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

test('mutate retries only once when the revision keeps moving', async () => {
  let revision = 0;
  let writes = 0;
  const store = createStore(async (_, { request: r }) => {
    if (r.op === 'snapshot') return { snapshot: { revision, settings: { activeWorkspace: 'personal' } } };
    writes++;
    revision++;
    throw { code: 'stale_view' };
  });
  await store.refresh();
  await assert.rejects(store.mutate('local_save', {}), { code: 'stale_view' });
  assert.equal(writes, 2);
});

test('mutate surfaces stale_view for review ops', async () => {
  let writes = 0;
  const store = createStore(async (_, { request: r }) => {
    if (r.op === 'snapshot') return { snapshot: { revision: 1, settings: { activeWorkspace: 'personal' } } };
    writes++;
    throw { code: 'stale_view' };
  });
  await store.refresh();
  assert.ok(!REBASE_SAFE.has('action_prepare'));
  await assert.rejects(store.mutate('action_prepare', {}), { code: 'stale_view' });
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
  assert.deepEqual(NAV.map(([id]) => id), ['today', 'calendar', 'tasks', 'inbox', 'automations']);
  assert.match(html, /data-route="automations"/);
  assert.doesNotMatch(html, /data-route="workspaces"/);
  assert.doesNotMatch(html, /workspace-select|ws-workspace-switch|ws-ws-dot|Active workspace/);
  assert.match(html, /data-route="settings"/);
  assert.match(html, /data-action="theme-toggle"/);
  assert.match(html, /ws-bell/);
  assert.match(html, /ws-sync-pill/);
});

test('NAV lists Today, Calendar, Tasks, Inbox, Automations', () => {
  assert.deepEqual(NAV, [['today', 'Today'], ['calendar', 'Calendar'], ['tasks', 'Tasks'], ['inbox', 'Inbox'], ['automations', 'Automations']]);
  const now = Date.UTC(2026, 10, 18, 12);
  const html = renderShell({ snapshot: withTasks(buildSnapshot(now, { photo: false }), now), route: 'tasks', resolvedDark: true });
  assert.match(html, /data-route="tasks" aria-current="page"><svg[^]*?<span>Tasks<\/span><small class="ws-count" title="Tasks to review">2<\/small>/, 'Tasks is current and counts the tasks to review');
  assert.doesNotMatch(renderShell({ snapshot: buildSnapshot(now, { photo: false }), route: 'today', resolvedDark: true }), /Tasks to review/);
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
