// Quick capture's pure parts (ask-capture design § 9): the bar's markup and line, the due label,
// the target line, the source and Add's `task_save` request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captureBar, captureRequest, captureSource, dueLabel, isCaptureKey, newCaptureView, pageSource, targetLine } from '../workspace/capture-model.js';
import { meOf } from '../workspace/tasks-model.js';
import { buildSnapshot, withMeetings } from './fixtures/workspace-fixture.mjs';

const NOW = Date.UTC(2026, 10, 26, 9);
const STATES = JSON.parse(readFileSync(new URL('./fixtures/contract/task-provider-states.json', import.meta.url), 'utf8'));

function snapshot({ provider = 'ready' } = {}) {
  const s = buildSnapshot(NOW, { photo: false, zone: 'UTC' });
  if (provider) s.taskProvider = structuredClone(STATES[provider]);
  s.records.push({
    id: 'm-atlas', kind: 'message', source: 'mail:inbox', connectionId: s.connection.id, workspaceId: null, revision: 'r-atlas', updatedAt: NOW / 1000,
    data: { channel: 'mail', title: 'Atlas budget', text: 'Can you send the deck by Friday?', from: 'Priya N.', fromAddress: 'priya.n@example.test', at: NOW / 1000, lane: 'reply', lifecycle: 'open', conversationId: 'conv-atlas', isRead: false, isMine: false, to: [] },
  });
  return s;
}
const view = (over = {}) => ({ ...newCaptureView(), open: true, ...over });
const html = (state, s) => captureBar(state, s).replace(/\s+/g, ' ');

test('the bar draws Task by default with the target line, a labelled form and a radiogroup', () => {
  const s = snapshot();
  const out = html({ route: 'today', capture: view() }, s);
  assert.match(out, /<form class="ws-capture" aria-label="Quick capture"/);
  assert.match(out, /id="capture-input"[^>]*aria-keyshortcuts="Meta\+N"[^>]*aria-describedby="capture-line"/);
  assert.match(out, /role="radiogroup"/);
  assert.match(out, /role="radio" aria-checked="true"[^>]*data-capture-mode="task"[^>]*>Task</);
  assert.match(out, /role="radio" aria-checked="false"[^>]*data-capture-mode="note"[^>]*>Note</);
  assert.match(out, /id="capture-line"[^>]*role="status" aria-live="polite"/);
  assert.match(out, /<span data-capture-target>Task in Todoist<\/span>/);
  assert.equal(targetLine(snapshot({ provider: 'local' })), 'Task in Connect');
  assert.equal(targetLine(snapshot({ provider: null })), 'Task in Connect');
  assert.match(out, /data-action="capture-add"[^>]*>Add</);
});

test('a read date shows "Due Fri 27 Nov" with × labelled "Keep the words, no due date"', () => {
  assert.equal(dueLabel('2026-11-27'), 'Due Fri 27 Nov');
  assert.equal(dueLabel('2027-01-04'), 'Due Mon 4 Jan');
  assert.equal(dueLabel(null), null);
  const text = 'Send the deck by fri';
  const out = html({ route: 'today', capture: view({ text, parsed: { text, title: 'Send the deck', due: '2026-11-27' } }) }, snapshot());
  assert.match(out, /data-capture-due="2026-11-27">Due Fri 27 Nov<button[^>]*data-action="capture-due-drop" aria-label="Keep the words, no due date">×<\/button>/);
});

test('while newer words wait for their answer, the read date stays in the line marked stale (not shown, not sent)', () => {
  const text = 'Send the deck by fri';
  const state = { route: 'today', capture: view({ text: `${text} or`, parsed: { text, title: 'Send the deck', due: '2026-11-27' } }) };
  const s = snapshot();
  assert.match(html(state, s), /<span class="ws-capture-item" data-stale>[^]*data-capture-due="2026-11-27"/);
  // Nothing else in the line changes, so the live region has nothing new to say.
  const settled = html({ route: 'today', capture: view({ text, parsed: { text, title: 'Send the deck', due: '2026-11-27' } }) }, s);
  const line = out => out.match(/<p id="capture-line"[^]*?<\/p>/)[0];
  assert.equal(line(html(state, s)).replace(' data-stale', ''), line(settled));
  assert.equal(captureRequest(state, s, meOf(s)).due, null, 'a stale date is never sent');
});

test('Tab goes from the box to Task, Note, then Add', () => {
  const out = html({ route: 'today', capture: view() }, snapshot());
  const at = needle => out.indexOf(needle);
  assert.ok(at('id="capture-input"') < at('data-capture-mode="task"'));
  assert.ok(at('data-capture-mode="task"') < at('data-capture-mode="note"'));
  assert.ok(at('data-capture-mode="note"') < at('data-action="capture-add"'));
  assert.doesNotMatch(out, /tabindex="-1"/);
});

test('a note links a message only, labelled with its subject as note_append writes it', () => {
  const s = withMeetings(snapshot(), NOW);
  s.records.find(r => r.id === 'm-atlas').data.title = 'Atlas\n  budget';
  const note = source => ({ capture: view({ mode: 'note', source }) });
  assert.equal(captureSource(note({ kind: 'meeting', id: 'mtg-philips' }), s), null);
  assert.doesNotMatch(html(note({ kind: 'meeting', id: 'mtg-philips' }), s), /data-capture-source/);
  assert.equal(captureSource(note({ kind: 'message', id: 'm-atlas' }), s).label, 'Atlas budget');
  // A Teams chat with no subject of its own: the native line would say nothing, so no chip.
  const chat = s.records.find(r => r.id === 'c-reply-1');
  s.records.push({ ...chat, id: 'c-untitled', data: { ...chat.data, title: '' } });
  assert.equal(captureSource(note({ kind: 'message', id: 'c-untitled' }), s), null);
  assert.ok(captureSource({ capture: view({ source: { kind: 'message', id: 'c-untitled' } }) }, s), 'a task still links the chat');
});

test('a selected Inbox message is the source: "From: Atlas budget" with × "Don\'t link Atlas budget"', () => {
  const s = snapshot();
  const state = { route: 'inbox', selectedMessage: 'm-atlas', capture: view() };
  assert.deepEqual(pageSource(state, s), { kind: 'message', id: 'm-atlas' });
  state.capture.source = pageSource(state, s);
  const out = html(state, s);
  assert.match(out, /data-capture-source="message">From: Atlas budget<button[^>]*data-action="capture-source-drop" aria-label="Don’t link Atlas budget">×<\/button>/);
  // Compact: the open row is the source.
  s.settings.view = 'compact';
  assert.deepEqual(pageSource({ route: 'inbox', selectedMessage: null, openMessage: 'm-atlas' }, s), { kind: 'message', id: 'm-atlas' });
  // A meeting page names its meeting; other pages none.
  const m = withMeetings(snapshot(), NOW);
  assert.deepEqual(pageSource({ route: 'meetings', meetings: { selected: 'mtg-philips' } }, m), { kind: 'meeting', id: 'mtg-philips' });
  assert.equal(pageSource({ route: 'today' }, s), null);
  // A source whose record went is not drawn.
  assert.equal(captureSource({ capture: view({ source: { kind: 'message', id: 'gone' } }) }, s), null);
});

test('Add sends one task_save with title, due, owner, ownerName, status todo and the message source fields', () => {
  const s = snapshot();
  const text = 'Send the deck to Priya by fri';
  const state = { route: 'inbox', capture: view({ text, parsed: { text, title: 'Send the deck to Priya', due: '2026-11-27' }, source: { kind: 'message', id: 'm-atlas' } }) };
  const me = meOf(s);
  assert.deepEqual(captureRequest(state, s, me), {
    text: 'Send the deck to Priya', due: '2026-11-27', owner: me.address, ownerName: me.name, status: 'todo',
    sourceId: 'm-atlas', sourceRevision: 'r-atlas', quote: 'Can you send the deck by Friday?',
  });
  // × keeps the words, with no due.
  state.capture.dueDropped = true;
  assert.deepEqual(captureRequest(state, s, me).text, text);
  assert.equal(captureRequest(state, s, me).due, null);
});

test('a meeting source sends meetingId', () => {
  const s = withMeetings(snapshot(), NOW);
  const req = captureRequest({ capture: view({ text: 'Send Legal the requirement', source: { kind: 'meeting', id: 'mtg-philips' } }) }, s, meOf(s));
  assert.equal(req.meetingId, 'mtg-philips');
  assert.equal(req.sourceId, undefined);
  assert.match(html({ capture: view({ source: { kind: 'meeting', id: 'mtg-philips' } }) }, s), /From: Philips CodeMie conversations syncup/);
});

test('Note: the line says "Adds a line to Notes on Today" and no date', () => {
  const text = 'Ask Marek about the Q1 headcount tomorrow';
  const out = html({ route: 'today', capture: view({ mode: 'note', text, parsed: { text, title: 'x', due: '2026-11-27' } }) }, snapshot());
  assert.match(out, /<span data-capture-target>Adds a line to Notes on Today<\/span>/);
  assert.doesNotMatch(out, /data-capture-due/);
  assert.match(out, /aria-checked="true"[^>]*data-capture-mode="note"/);
});

test('every title and source string is escaped', () => {
  const s = snapshot();
  s.records.find(r => r.id === 'm-atlas').data.title = '<img src=x onerror=alert(1)>"';
  const out = captureBar({ capture: view({ text: '"><script>x</script>', source: { kind: 'message', id: 'm-atlas' }, error: '<b>no</b>' }) }, s);
  assert.doesNotMatch(out, /<script>|<img|<b>no/);
  assert.match(out, /value="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);
  assert.match(out, /From: &lt;img src=x onerror=alert\(1\)&gt;&quot;/);
});

test('Default and Compact draw the same bar markup', () => {
  const s = snapshot();
  const state = { route: 'inbox', capture: view({ text: 'a', source: { kind: 'message', id: 'm-atlas' } }) };
  const a = captureBar(state, s);
  s.settings.view = 'compact';
  assert.equal(captureBar(state, s), a);
});

test('⌘N is ignored while a dialog or the setup sheet is open, and while composing', () => {
  const ev = over => ({ key: 'n', code: 'KeyN', metaKey: true, ctrlKey: false, altKey: false, isComposing: false, ...over });
  assert.equal(isCaptureKey(ev()), true);
  assert.equal(isCaptureKey(ev({ metaKey: false, ctrlKey: true })), true);
  assert.equal(isCaptureKey(ev({ metaKey: false })), false);
  assert.equal(isCaptureKey(ev({ altKey: true })), false);
  assert.equal(isCaptureKey(ev({ isComposing: true })), false);
  assert.equal(isCaptureKey(ev(), { modal: true }), false);
  assert.equal(isCaptureKey(ev(), { sheet: true }), false);
  assert.equal(isCaptureKey(ev({ key: 'k', code: 'KeyK' })), false);
});
