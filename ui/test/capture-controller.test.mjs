// The quick-capture controller over fakes (ask-capture design § 9, § 11): the parse ask and its
// pause, late answers, ×, Add with Enter and ⌘↩, Undo, Note, refusals, Esc and ⌘N.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCaptureController } from '../workspace/capture-controller.js';
import { captureBar } from '../workspace/capture-model.js';
import { buildSnapshot, withMeetings } from './fixtures/workspace-fixture.mjs';

const NOW = Date.UTC(2026, 10, 26, 9);
const STATES = JSON.parse(readFileSync(new URL('./fixtures/contract/task-provider-states.json', import.meta.url), 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
/** Past the parse pause (`wait: 0` in these tests) and its answer. */
const rest = () => new Promise(resolve => setTimeout(resolve, 5));

function snapshot({ provider = 'ready' } = {}) {
  const s = buildSnapshot(NOW, { photo: false, zone: 'UTC' });
  if (provider) s.taskProvider = structuredClone(STATES[provider]);
  s.records.push({
    id: 'm-atlas', kind: 'message', source: 'mail:inbox', connectionId: s.connection.id, workspaceId: null, revision: 'r-atlas', updatedAt: NOW / 1000,
    data: { channel: 'mail', title: 'Atlas budget', text: 'Can you send the deck by Friday?', from: 'Priya N.', fromAddress: 'priya.n@example.test', at: NOW / 1000, lane: 'reply', lifecycle: 'open', conversationId: 'conv-atlas', isRead: false, isMine: false, to: [] },
  });
  return s;
}

/** A controller over fakes. `parse(text)` answers `capture_parse` (a promise or a value);
 *  `refuse[op]` makes that write throw `{code: 'validation', message}`. */
function harness({ s = snapshot(), state = { route: 'today' }, parse = text => ({ title: text, due: null }), refuse = {}, wait = 0 } = {}) {
  const calls = { mutate: [], queries: [], render: 0, toasts: [], go: [], saved: 0, focusBack: 0, order: [] };
  const ctl = createCaptureController({
    state,
    snap: () => s,
    mutate: async (op, data) => {
      calls.mutate.push([op, data]);
      calls.order.push(op);
      if (refuse[op]) throw { code: 'validation', message: refuse[op], field: op === 'note_append' && /2,000/.test(refuse[op]) ? 'text' : undefined };
      return op === 'note_append' ? { id: 'note-1' } : { id: 'task-new' };
    },
    query: async (op, data) => {
      calls.queries.push([op, data]);
      return parse(data.text);
    },
    render: () => { calls.render++; calls.html = state.capture.open ? captureBar(state, s) : ''; },
    toast: (message, tone, action) => calls.toasts.push({ message, tone, action }),
    go: hash => calls.go.push(hash),
    savePendingNote: async () => { calls.saved++; calls.order.push('savePendingNote'); },
    focusBack: () => { calls.focusBack++; },
    wait,
  });
  return { ctl, state, calls, s };
}

/** A keydown as the bar's capture-phase listener gets it. */
function keyEvent(over = {}) {
  const ev = { key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: { id: 'capture-input', dataset: {} }, defaultPrevented: false, propagationStopped: false, ...over };
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  ev.stopPropagation = () => { ev.propagationStopped = true; };
  return ev;
}

async function typed(h, text, answer) {
  h.ctl.input(text);
  await rest();
  if (answer) assert.equal(h.state.capture.parsed?.due ?? null, answer);
}

test('× keeps the words and sends no due until the text changes', async () => {
  const h = harness({ parse: text => (/by fri/.test(text) ? { title: text.replace(/\s*by fri/, ''), due: '2026-11-27' } : { title: text, due: null }) });
  h.ctl.open();
  await typed(h, 'Send the deck by fri', '2026-11-27');
  await h.ctl.handle('capture-due-drop');
  assert.doesNotMatch(h.calls.html, /data-capture-due/);
  await h.ctl.add();
  assert.deepEqual(h.calls.mutate.at(-1)[1].text, 'Send the deck by fri');
  assert.equal(h.calls.mutate.at(-1)[1].due, null);
  // A change brings the read date back.
  h.ctl.open();
  await typed(h, 'Send the deck by fri', '2026-11-27');
  await h.ctl.handle('capture-due-drop');
  await typed(h, 'Send the decks by fri', '2026-11-27');
  assert.match(h.calls.html, /data-capture-due="2026-11-27"/);
});

test('a_late_parse_answer_is_dropped', async () => {
  const pending = {};
  const h = harness({ parse: text => new Promise(resolve => { pending[text] = resolve; }) });
  h.ctl.open();
  h.ctl.input('send by f');
  await rest();
  h.ctl.input('send by fri');
  await rest();
  assert.deepEqual(h.calls.queries.map(([, d]) => d.text), ['send by f', 'send by fri']);
  pending['send by fri']({ title: 'send', due: '2026-11-27' });
  await tick();
  pending['send by f']({ title: 'send by f', due: '2026-12-31' });
  await tick();
  assert.equal(h.state.capture.parsed.due, '2026-11-27');
  assert.match(h.calls.html, /Due Fri 27 Nov/);
  assert.doesNotMatch(h.calls.html, /Dec/);
});

test('parse is asked at most every 120 ms', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = harness({ wait: 120 });
    h.ctl.open();
    for (const [i, text] of ['S', 'Se', 'Sen', 'Send', 'Send ', 'Send t'].entries()) {
      h.ctl.input(text);
      mock.timers.tick(i < 5 ? 20 : 0);
    }
    assert.equal(h.calls.queries.length, 0, 'asked while typing');
    mock.timers.tick(120);
    assert.equal(h.calls.queries.length, 1);
    assert.deepEqual(h.calls.queries[0], ['capture_parse', { text: 'Send t' }]);
  } finally {
    mock.timers.reset();
  }
});

test('Add sends one task_save with title, due, owner, ownerName, status todo and the message source fields', async () => {
  const s = snapshot();
  const h = harness({ s, state: { route: 'inbox', selectedMessage: 'm-atlas' }, parse: () => ({ title: 'Send the deck to Priya', due: '2026-11-27' }) });
  h.ctl.open();
  assert.match(h.calls.html, /From: Atlas budget/);
  await typed(h, 'Send the deck to Priya by fri', '2026-11-27');
  await h.ctl.handle('capture-add');
  const saves = h.calls.mutate.filter(([op]) => op === 'task_save');
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0][1], {
    text: 'Send the deck to Priya', due: '2026-11-27', owner: s.connection.email, ownerName: 'Taylor Morgan', status: 'todo',
    sourceId: 'm-atlas', sourceRevision: 'r-atlas', quote: 'Can you send the deck by Friday?',
  });
});

test('Add right after typing reads the words first, so the due sent matches them', async () => {
  const h = harness({ wait: 10_000, parse: () => ({ title: 'Call Priya', due: '2026-11-27' }) });
  h.ctl.open();
  h.ctl.input('Call Priya tomorrow');
  await h.ctl.add();
  assert.equal(h.calls.queries.length, 1);
  assert.equal(h.calls.mutate[0][1].due, '2026-11-27');
  assert.equal(h.calls.mutate[0][1].text, 'Call Priya');
});

test('a meeting source sends meetingId', async () => {
  const s = withMeetings(snapshot(), NOW);
  const h = harness({ s, state: { route: 'meetings', meetings: { selected: 'mtg-philips' } } });
  h.ctl.open();
  await typed(h, 'Send Legal the requirement');
  await h.ctl.add();
  assert.equal(h.calls.mutate[0][1].meetingId, 'mtg-philips');
  // × on the source: nothing linked.
  h.ctl.open();
  await h.ctl.handle('capture-source-drop');
  await typed(h, 'Another');
  await h.ctl.add();
  assert.equal(h.calls.mutate[1][1].meetingId, undefined);
});

test('the toast says "Added to Todoist · Undo" and Undo sends one task_delete with the new id', async () => {
  const h = harness();
  h.ctl.open();
  await typed(h, 'Send the deck');
  await h.ctl.add();
  const t = h.calls.toasts.at(-1);
  assert.equal(`${t.message} · ${t.action.label}`, 'Added to Todoist · Undo');
  await t.action.run();
  assert.deepEqual(h.calls.mutate.filter(([op]) => op === 'task_delete'), [['task_delete', { id: 'task-new' }]]);
  // Local says Connect.
  const local = harness({ s: snapshot({ provider: 'local' }) });
  local.ctl.open();
  await typed(local, 'x');
  await local.ctl.add();
  assert.equal(local.calls.toasts.at(-1).message, 'Added to Connect');
});

test('⌘↩ adds and keeps the bar open and empty; Enter adds and closes', async () => {
  const h = harness();
  h.ctl.open();
  await typed(h, 'First');
  const cmd = keyEvent({ metaKey: true });
  assert.equal(h.ctl.key(cmd), true);
  await tick();
  await tick();
  assert.equal(h.state.capture.open, true);
  assert.equal(h.state.capture.text, '');
  assert.match(h.calls.html, /value=""/);
  await typed(h, 'Second');
  h.ctl.key(keyEvent());
  await tick();
  await tick();
  assert.equal(h.state.capture.open, false);
  assert.equal(h.calls.focusBack, 1);
  assert.deepEqual(h.calls.mutate.map(([op, d]) => [op, d.text]), [['task_save', 'First'], ['task_save', 'Second']]);
});

test('cmd_enter_in_the_bar_never_sends_the_reply', async () => {
  // The Inbox with a reply box the user touched, and the bar open over it: ⌘↩ belongs to the bar.
  const h = harness({ state: { route: 'inbox', selectedMessage: 'm-atlas', replyTouched: 'm-atlas' } });
  h.ctl.open();
  await typed(h, 'Send the deck');
  const ev = keyEvent({ metaKey: true });
  assert.equal(h.ctl.key(ev), true);
  await tick();
  await tick();
  assert.equal(ev.defaultPrevented, true, 'the Inbox ⌘↩ skips a prevented event');
  assert.equal(ev.propagationStopped, true, 'and never sees it');
  assert.deepEqual(h.calls.mutate.map(([op]) => op), ['task_save']);
  assert.ok(!h.calls.mutate.some(([op]) => op.startsWith('action_') || op === 'draft_save'));
});

test('Note: no parse, "Adds a line to Notes on Today", savePendingNote first, then one note_append; toast "Added to Notes on Today" with Open → #/today', async () => {
  const h = harness();
  h.ctl.open();
  await h.ctl.handle('capture-mode', { dataset: { captureMode: 'note' } });
  assert.match(h.calls.html, /Adds a line to Notes on Today/);
  await typed(h, 'Ask Marek about the Q1 headcount tomorrow');
  assert.equal(h.calls.queries.length, 0, 'dates are not read in a note');
  await h.ctl.add();
  assert.deepEqual(h.calls.order, ['savePendingNote', 'note_append']);
  assert.deepEqual(h.calls.mutate, [['note_append', { text: 'Ask Marek about the Q1 headcount tomorrow' }]]);
  const t = h.calls.toasts.at(-1);
  assert.equal(t.message, 'Added to Notes on Today');
  assert.equal(t.action.label, 'Open');
  t.action.run();
  assert.deepEqual(h.calls.go, ['#/today']);
  // From the Inbox, the note names its message.
  const inbox = harness({ state: { route: 'inbox', selectedMessage: 'm-atlas' } });
  inbox.ctl.open({ mode: 'note' });
  await typed(inbox, 'Check the deck');
  await inbox.ctl.add();
  assert.deepEqual(inbox.calls.mutate, [['note_append', { text: 'Check the deck', sourceId: 'm-atlas' }]]);
});

test('the Task/Note choice is kept for the session', async () => {
  const h = harness();
  h.ctl.open();
  await h.ctl.handle('capture-mode', { dataset: { captureMode: 'note' } });
  h.ctl.close();
  h.ctl.open();
  assert.equal(h.state.capture.mode, 'note');
  // An opening that names its mode (Ask's Add as task) leaves the choice alone.
  h.ctl.open({ mode: 'task', text: 'Send the deck', due: '2026-11-27' });
  assert.equal(h.state.capture.mode, 'task');
  assert.match(h.calls.html, /Due Fri 27 Nov/);
  h.ctl.close();
  h.ctl.open();
  assert.equal(h.state.capture.mode, 'note');
  // ← → on Task / Note switch it too.
  const ev = keyEvent({ key: 'ArrowLeft', target: { id: '', dataset: { captureMode: 'note' } } });
  assert.equal(h.ctl.key(ev), true);
  assert.equal(h.state.capture.mode, 'task');
});

test('refusals show under the box: task_save "Write what needs doing (up to 2,000 characters)." and note_append "Notes on Today is full. Tidy it first."', async () => {
  const h = harness({ refuse: { task_save: 'Write what needs doing (up to 2,000 characters).', note_append: 'Notes on Today is full. Tidy it first.' } });
  h.ctl.open();
  await typed(h, ' ');
  await h.ctl.add();
  assert.equal(h.state.capture.open, true);
  assert.match(h.calls.html, /role="alert" data-capture-part="error">Write what needs doing \(up to 2,000 characters\)\.</);
  assert.equal(h.calls.toasts.length, 0);
  await h.ctl.handle('capture-mode', { dataset: { captureMode: 'note' } });
  assert.match(h.calls.html, /data-capture-part="error" hidden>/, 'a new choice clears the refusal');
  await typed(h, 'One more line');
  await h.ctl.add();
  assert.match(h.calls.html, /Notes on Today is full\. Tidy it first\./);
  assert.equal(h.state.capture.text, 'One more line', 'the words stay');
});

test('Esc clears typed text first, then closes and returns focus', async () => {
  const h = harness();
  h.ctl.open();
  await typed(h, 'Half a thought');
  const first = keyEvent({ key: 'Escape' });
  assert.equal(h.ctl.key(first), true);
  assert.equal(first.propagationStopped, true);
  assert.equal(h.state.capture.open, true);
  assert.equal(h.state.capture.text, '');
  h.ctl.key(keyEvent({ key: 'Escape' }));
  assert.equal(h.state.capture.open, false);
  assert.equal(h.calls.focusBack, 1);
  assert.equal(h.calls.mutate.length, 0);
});

test('keys typed while composing are the input method\'s', () => {
  const h = harness();
  h.ctl.open();
  for (const over of [{ isComposing: true }, { keyCode: 229 }, { key: 'Escape', isComposing: true }, { metaKey: true, isComposing: true }]) {
    const ev = keyEvent(over);
    assert.equal(h.ctl.key(ev), false);
    assert.equal(ev.defaultPrevented, false);
  }
  assert.equal(h.state.capture.open, true);
  assert.equal(h.calls.mutate.length, 0);
});
