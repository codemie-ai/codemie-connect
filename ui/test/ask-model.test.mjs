// The Ask field's model (ask-capture design § 2, Copy "Field" and "Rail", Accessibility, rulings
// 19, 32 and 34): the About label, Recent, the field's markup and the ⌘K test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboutOf, actionControl, actionTarget, askField, askRailButton, citeTarget, fieldRunning, isAskKey, isStopKey, recentQuestions, newAskView } from '../workspace/ask-model.js';
import { readFileSync } from 'node:fs';
import { buildSnapshot, withAsk, askStates } from './fixtures/workspace-fixture.mjs';

const PROVIDERS = JSON.parse(readFileSync(new URL('./fixtures/contract/task-provider-states.json', import.meta.url), 'utf8'));

const NOW = Date.UTC(2026, 10, 26, 9);
const TUE = Date.UTC(2026, 10, 24, 10) / 1000;

/** A snapshot with Priya's and Jordan's mail, the Atlas QBR meeting, a task and an event. */
function askSnapshot() {
  const s = buildSnapshot(NOW, { photo: false, zone: 'UTC' });
  const msg = (id, from, data = {}) => ({ id, kind: 'message', source: 'mail:inbox', connectionId: s.connection.id, workspaceId: null, revision: `r-${id}`, updatedAt: TUE,
    data: { channel: 'mail', title: 'Atlas budget', text: 'Can you send the deck?', from, fromAddress: 'x@example.test', at: TUE, lane: 'reply', lifecycle: 'open', conversationId: `conv-${id}`, isMine: false, to: [], ...data } });
  s.records.push(
    msg('m-priya', 'Priya N.'),
    msg('m-jordan', 'Jordan Lee', { channel: 'chat', at: TUE - 86400 }),
    { id: 'mtg-qbr', kind: 'meeting', source: 'calendar:cal-main', connectionId: s.connection.id, workspaceId: null, revision: 'r-q', updatedAt: TUE, data: { title: 'Atlas QBR', start: '2026-11-20T14:00:00Z', end: '2026-11-20T15:00:00Z' } },
    { id: 'task-budget', kind: 'commitment', source: 'local', connectionId: null, workspaceId: 'personal', revision: 'r-t', updatedAt: TUE, data: { text: 'Send the Atlas budget', status: 'todo' } },
    { id: 'ev-qbr', kind: 'event', source: 'calendar:cal-main', connectionId: s.connection.id, workspaceId: null, revision: 'r-e', updatedAt: TUE, data: { title: 'QBR', start: '2026-11-27T10:00:00Z', end: '2026-11-27T11:00:00Z', allDay: false, cancelled: false, calendarId: 'cal-main' } },
  );
  return s;
}

test('aboutOf: a selected or open Inbox message, a meeting route, an open task, an open event give a label; nothing else does', () => {
  const s = askSnapshot();
  assert.deepEqual(aboutOf({ route: 'inbox', selectedMessage: 'm-priya' }, s), { kind: 'message', recordId: 'm-priya', label: 'Priya N. · mail · Tue 24 Nov' });
  assert.equal(aboutOf({ route: 'inbox', selectedMessage: 'm-jordan' }, s).label, 'Jordan Lee · Teams · Mon 23 Nov');
  // Compact: the open row first.
  s.settings.view = 'compact';
  assert.equal(aboutOf({ route: 'inbox', selectedMessage: 'm-priya', openMessage: 'm-jordan' }, s).recordId, 'm-jordan');
  s.settings.view = 'default';
  assert.deepEqual(aboutOf({ route: 'meetings', meetings: { selected: 'mtg-qbr' } }, s), { kind: 'meeting', recordId: 'mtg-qbr', label: 'Meeting · Atlas QBR · Fri 20 Nov' });
  assert.deepEqual(aboutOf({ route: 'tasks', tasks: { view: 'board', drawer: 'task-budget' } }, s), { kind: 'task', recordId: 'task-budget', label: 'Task · Send the Atlas budget' });
  assert.equal(aboutOf({ route: 'tasks', tasks: { view: 'dates', rowOpen: 'task-budget', drawer: null } }, s).recordId, 'task-budget');
  assert.deepEqual(aboutOf({ route: 'calendar', openEvent: 'ev-qbr' }, s), { kind: 'event', recordId: 'ev-qbr', label: 'Event · Fri 27 Nov 10:00 · QBR' });
  // Ruling 32: nowhere else, and not a record that is gone.
  for (const st of [
    { route: 'today' }, { route: 'calendar' }, { route: 'tasks', tasks: { view: 'board', drawer: null } }, { route: 'settings' },
    { route: 'ask' }, { route: 'plugin', pluginPage: { id: 'hello', activity: 'main' } }, { route: 'inbox', selectedMessage: 'm-gone' },
  ]) assert.equal(aboutOf(st, s), null, JSON.stringify(st));
});

test('aboutOf follows the Tasks view the page shows: with a provider active, By date’s unfolded row', () => {
  const s = askSnapshot();
  s.taskProvider = structuredClone(PROVIDERS.ready);
  // The provider's own view (By date by default) while the Local choice stays Board.
  const tasks = { view: 'board', providerView: null, drawer: null, rowOpen: 'task-budget' };
  assert.deepEqual(aboutOf({ route: 'tasks', tasks }, s), { kind: 'task', recordId: 'task-budget', label: 'Task · Send the Atlas budget' });
  // List shown (a provider has no Board): the drawer counts, not a By date row left unfolded.
  assert.equal(aboutOf({ route: 'tasks', tasks: { ...tasks, providerView: 'list' } }, s), null);
  assert.equal(aboutOf({ route: 'tasks', tasks: { ...tasks, providerView: 'list', drawer: 'task-budget' } }, s).recordId, 'task-budget');
});

test('Recent lists up to 5 first questions, newest first', () => {
  const s = withAsk(askSnapshot(), 'idle');
  assert.deepEqual(recentQuestions(s).map(r => r.title), ['What did I promise Priya this week?', 'When is the QBR?', 'Who is Marek Novak?']);
  s.ask = structuredClone(s.ask);
  for (let i = 0; i < 4; i++) s.ask.threads.push({ id: `ask-old${i}`, title: `Old ${i}`, updatedAt: 1000 + i, turns: 1, last: 'done' });
  assert.equal(recentQuestions(s).length, 5);
  assert.equal(recentQuestions(withAsk(askSnapshot(), 'empty')).length, 0);
});

test('the field: role="search" "Ask", "Ask…" and "⌘K", labelled "Ask Connect" with Meta+K; Recent is a listbox the box controls', () => {
  const s = withAsk(askSnapshot(), 'idle');
  const closed = askField({ route: 'today', ask: newAskView() }, s);
  assert.match(closed, /<form class="ws-ask-field" role="search" aria-label="Ask"/);
  assert.match(closed, /id="ask-input"[^>]*placeholder="Ask…"/);
  assert.match(closed, /aria-label="Ask Connect"/);
  assert.match(closed, /aria-keyshortcuts="Meta\+K"/);
  assert.match(closed, /<kbd class="ws-ask-hint"[^>]*>⌘K<\/kbd>/);
  assert.doesNotMatch(closed, /aria-controls/, 'no list drawn: nothing to control');
  assert.doesNotMatch(closed, /Recent|Enter to ask/);
  const open = askField({ route: 'today', ask: { ...newAskView(), open: true, active: 1 } }, s);
  assert.match(open, /aria-controls="ask-recent"/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /aria-activedescendant="ask-recent-1"/);
  assert.match(open, /<ul id="ask-recent" role="listbox"/);
  assert.match(open, /<li role="option" id="ask-recent-1" aria-selected="true" data-action="ask-recent" data-ask-recent="ask-3a9e"/);
  assert.match(open, />Recent</);
  assert.match(open, /Enter to ask · Esc to close/);
  // With words typed, Recent goes.
  assert.doesNotMatch(askField({ route: 'today', ask: { ...newAskView(), open: true, text: 'w' } }, s), /role="listbox"/);
});

test('the About chip shows "About: <label>" with × "Don’t ask about <label>" while open or holding words; dropped, none', () => {
  const s = askSnapshot();
  const st = { route: 'inbox', selectedMessage: 'm-priya', ask: { ...newAskView(), open: true } };
  const html = askField(st, s);
  assert.match(html, /data-ask-about="message"><span>About: Priya N\. · mail · Tue 24 Nov<\/span><button type="button" class="ws-ask-x" data-action="ask-about-drop" aria-label="Don’t ask about Priya N\. · mail · Tue 24 Nov">×<\/button>/);
  assert.doesNotMatch(askField({ ...st, ask: newAskView() }, s), /data-ask-about/, 'closed and empty: no chip');
  assert.match(askField({ ...st, ask: { ...newAskView(), text: 'what' } }, s), /data-ask-about/, 'words typed: the chip stays');
  assert.doesNotMatch(askField({ ...st, ask: { ...newAskView(), open: true, aboutDropped: true } }, s), /data-ask-about/);
});

test('while an answer runs the field reads "Answering… ⌘. to stop"', () => {
  const s = withAsk(askSnapshot(), 'running');
  assert.equal(fieldRunning(s), true);
  assert.equal(fieldRunning(withAsk(askSnapshot(), 'idle')), false);
  const html = askField({ route: 'today', ask: newAskView() }, s);
  assert.match(html, /placeholder="Answering… ⌘\. to stop"/);
  assert.match(html, /data-running/);
  assert.match(askField({ route: 'today', ask: { ...newAskView(), error: 'Connect is still answering. Stop it or wait.' } }, s), /role="alert">Connect is still answering\. Stop it or wait\./);
});

test('the rail shows a ✦ button "Ask (⌘K)" with aria-label "Ask" and aria-keyshortcuts "Meta+K"', () => {
  const html = askRailButton();
  assert.match(html, /data-action="ask-rail"/);
  assert.match(html, /aria-label="Ask"/);
  assert.match(html, /aria-keyshortcuts="Meta\+K"/);
  assert.match(html, /title="Ask \(⌘K\)"/);
});

test('the question and the About label are escaped', () => {
  const s = askSnapshot();
  s.records.find(r => r.id === 'm-priya').data.from = '<img src=x onerror=alert(1)>';
  s.ask = structuredClone(askStates().idle);
  s.ask.threads[0].title = '<script>x</script>';
  const html = askField({ route: 'inbox', selectedMessage: 'm-priya', ask: { ...newAskView(), open: true, text: '"><b>q</b>' } }, s);
  assert.doesNotMatch(html, /<img src=x|<script>|<b>q<\/b>/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /value="&quot;&gt;&lt;b&gt;q/);
  assert.doesNotMatch(askField({ route: 'today', ask: { ...newAskView(), open: true } }, s), /<script>/);
});

test('⌘K does nothing inside the terminal dock, with a dialog or the setup sheet open, or while composing', () => {
  const ev = (over = {}) => ({ key: 'k', code: 'KeyK', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: { closest: () => null }, ...over });
  assert.equal(isAskKey(ev()), true);
  // Meta only: Ctrl+K stays the text boxes' "kill to end of line".
  assert.equal(isAskKey(ev({ metaKey: false, ctrlKey: true })), false);
  assert.equal(isAskKey(ev({ ctrlKey: true })), false);
  assert.equal(isAskKey(ev({ target: { closest: sel => (sel === '.ws-term' ? {} : null) } })), false, 'the terminal keeps its ⌘K');
  assert.equal(isAskKey(ev(), { modal: true }), false);
  assert.equal(isAskKey(ev(), { sheet: true }), false);
  assert.equal(isAskKey(ev({ isComposing: true })), false);
  assert.equal(isAskKey(ev({ altKey: true })), false);
  assert.equal(isAskKey(ev({ metaKey: false })), false);
  assert.equal(isAskKey(ev({ key: 'n', code: 'KeyN' })), false);
});

test('⌘. is Stop: Meta only, not with ⌥ ⇧ ⌃ or mid-composition', () => {
  const ev = over => ({ key: '.', code: 'Period', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...over });
  assert.equal(isStopKey(ev()), true);
  for (const o of [{ metaKey: false }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { key: ',', code: 'Comma' }]) assert.equal(isStopKey(ev(o)), false, JSON.stringify(o));
  // M2: never under a dialog or the setup sheet.
  assert.equal(isStopKey(ev(), { modal: true }), false);
  assert.equal(isStopKey(ev(), { sheet: true }), false);
});

// ---------------------------------------------------------------- cites and actions (Task 11)

test('citeTarget: message → #/inbox on its lane with the row selected; meeting → #/meetings/<id>/summary; task → #/tasks with its drawer or row; event → #/calendar on its day with it open; person and fact → null', () => {
  const s = askSnapshot();
  s.records.find(r => r.id === 'm-jordan').data.lane = 'waiting';
  assert.deepEqual(citeTarget({ id: 'a1', kind: 'message', recordId: 'm-priya', label: 'Priya N. · mail · Tue 24 Nov' }, s), { hash: '#/inbox', select: { kind: 'message', id: 'm-priya', lane: 'reply' } });
  assert.deepEqual(citeTarget({ id: 'm4', kind: 'message', recordId: 'm-jordan' }, s).select.lane, 'waiting');
  assert.deepEqual(citeTarget({ id: 'n5', kind: 'meeting', recordId: 'mtg-qbr' }, s), { hash: '#/meetings/mtg-qbr/summary' });
  // A meeting cite may name the calendar event the meeting is.
  assert.deepEqual(citeTarget({ id: 'n5', kind: 'meeting', recordId: 'ev-qbr' }, s), { hash: '#/meetings/ev-qbr/summary' });
  assert.deepEqual(citeTarget({ id: 't2', kind: 'task', recordId: 'task-budget' }, s), { hash: '#/tasks', select: { kind: 'task', id: 'task-budget' } });
  assert.deepEqual(citeTarget({ id: 'e3', kind: 'event', recordId: 'ev-qbr' }, s), { hash: '#/calendar', select: { kind: 'event', id: 'ev-qbr', day: '2026-11-27' } });
  // An all-day event's day is its start date, whatever the zone.
  s.records.push({ id: 'ev-day', kind: 'event', source: 'calendar:cal-main', data: { title: 'Offsite', allDay: true, startDate: '2026-12-01', start: '2026-11-30T23:00:00Z', calendarId: 'cal-main' } });
  assert.equal(citeTarget({ id: 'e9', kind: 'event', recordId: 'ev-day' }, { ...s, settings: { ...s.settings, timeZone: 'America/New_York' } }).select.day, '2026-12-01');
  assert.equal(citeTarget({ id: 'p6', kind: 'person', recordId: 'p-1', label: 'Person · Marek Novak' }, s), null);
  assert.equal(citeTarget({ id: 'f7', kind: 'fact', recordId: null, title: 'Atlas rollout' }, s), null);
  // A record no longer in Connect opens nothing.
  assert.equal(citeTarget({ id: 'a1', kind: 'message', recordId: 'gone' }, s), null);
  assert.equal(citeTarget({ id: 't2', kind: 'task', recordId: 'gone' }, s), null);
  assert.equal(citeTarget(null, s), null);
});

test('actionControl: "+ Add as task", "Open <label>" and "✦ Draft a reply to <name>"; an action whose record is gone is not drawn', () => {
  const s = askSnapshot();
  const turn = { cites: [{ id: 'a1', kind: 'message', recordId: 'm-priya', label: 'Priya N. · mail · Tue 24 Nov' }, { id: 'e3', kind: 'event', recordId: 'ev-qbr', label: 'Event · Fri 27 Nov 10:00 · QBR' }] };
  assert.deepEqual(actionControl({ kind: 'task', text: 'Send Priya the Atlas budget', due: '2026-11-27' }, turn, s), { kind: 'task', label: '+ Add as task' });
  assert.deepEqual(actionControl({ kind: 'open', ref: 'e3', recordId: 'ev-qbr', label: 'Event · Fri 27 Nov 10:00 · QBR' }, turn, s), { kind: 'go', label: 'Open Event · Fri 27 Nov 10:00 · QBR' });
  assert.deepEqual(actionControl({ kind: 'draft', ref: 'a1', recordId: 'm-priya', label: 'Priya N. · mail · Tue 24 Nov', hint: 'Say Friday.' }, turn, s), { kind: 'reply', label: '✦ Draft a reply to Priya N.' });
  // Open goes as its cite does; an uncited ref (the About) is found by its record.
  assert.deepEqual(actionTarget({ kind: 'open', ref: 'e3', recordId: 'ev-qbr' }, turn, s), citeTarget(turn.cites[1], s));
  assert.deepEqual(actionTarget({ kind: 'open', ref: 'a9', recordId: 'task-budget', label: 'Task · Send the Atlas budget' }, turn, s), { hash: '#/tasks', select: { kind: 'task', id: 'task-budget' } });
  // Gone: the record left, the draft's record is not a message, an empty task, an unknown kind.
  assert.equal(actionControl({ kind: 'open', ref: 'e3', recordId: 'gone', label: 'x' }, { cites: [] }, s), null);
  assert.equal(actionControl({ kind: 'draft', ref: 'a1', recordId: 'gone', label: 'Priya N. · mail' }, turn, s), null);
  assert.equal(actionControl({ kind: 'draft', ref: 't2', recordId: 'task-budget', label: 'Task · Send' }, turn, s), null);
  assert.equal(actionControl({ kind: 'task', text: '  ' }, turn, s), null);
  assert.equal(actionControl({ kind: 'send', ref: 'a1', recordId: 'm-priya' }, turn, s), null);
});
