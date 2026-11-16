import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, escapeHtml } from '../workspace/store.js';
import { runReadOnlyProbe } from '../workspace/safe-probe.js';
import {
  calendarDays, calendarWindow, calendarCoverage, calendarIds, calendarColor, eventSpan, eventsOnDay,
  layoutColumns, freeSlots, groupCalendarEvents,
} from '../workspace/calendar-model.js';
import {
  dayKey, addDaysToKey, minutesOfDay, initials, firstName, relativeAge, agoLabel, countdownLabel, durationLabel, greeting, colorFor,
} from '../workspace/format.js';
import { attentionMessages, messageTitle, connectionState, decisions, sourceCounts, conversation, collapseChats } from '../workspace/selectors.js';
import { snoozeUntil, filteredMessages, inbox } from '../workspace/view-inbox.js';
import { today, todayModel } from '../workspace/view-today.js';
import { calendar, periodTitle, eventDetails } from '../workspace/view-calendar.js';
import { settings, workspaces } from '../workspace/view-settings.js';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';

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
  assert.match(html, /data-now-line/);
  const m = todayModel(s, new Set(), now);
  assert.equal(m.current[0].record.id, 'ev-current');
  assert.ok(!m.timed.some(t => t.record.id === 'ev-cancelled'), 'cancelled events are hidden');
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
  for (const tab of ['general', 'appearance', 'notifications', 'queues', 'privacy', 'activity', 'updates', 'installation']) {
    assert.ok(settings(s, ctx({ settingsTab: tab })).length > 200, tab);
  }
  assert.match(workspaces(s), /Project Atlas/);
});
