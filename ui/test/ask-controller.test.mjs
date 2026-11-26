// The Ask controller over fakes (ask-capture design § 2, § 11, rulings 16, 32 and 34): the field's
// keys, the About chip read at Enter, Recent, Esc, the busy refusal, the first-use chooser, ⌘K
// and the rail, and the hidden calendars `ask_start` carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAskController } from '../workspace/ask-controller.js';
import { askField } from '../workspace/ask-model.js';
import { buildSnapshot, withAsk } from './fixtures/workspace-fixture.mjs';

const NOW = Date.UTC(2026, 10, 26, 9);
const TUE = Date.UTC(2026, 10, 24, 10) / 1000;
const tick = () => new Promise(resolve => setImmediate(resolve));

function snapshot(askState = 'idle') {
  const s = withAsk(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), askState);
  const msg = (id, from) => ({ id, kind: 'message', source: 'mail:inbox', connectionId: s.connection.id, workspaceId: null, revision: `r-${id}`, updatedAt: TUE,
    data: { channel: 'mail', title: 'Atlas budget', text: 'Hello', from, fromAddress: 'x@example.test', at: TUE, lane: 'reply', lifecycle: 'open', conversationId: `conv-${id}`, isMine: false, to: [] } });
  s.records.push(msg('m-priya', 'Priya N.'), msg('m-jordan', 'Jordan Lee'));
  return s;
}

/** A controller over fakes. `refuse` makes `ask_start` throw it (once); `choose` is what the
 *  chooser answers for a `needs_choice`. */
function harness({ s = snapshot(), state = { route: 'inbox', selectedMessage: 'm-priya' }, refuse = null, choose = true, shown = true, here = '#/inbox', hidden = ['cal-home'] } = {}) {
  const calls = { mutate: [], go: [], focus: [], focusBack: [], render: 0, chooser: 0, failed: [] };
  let refusal = refuse;
  let hash = here;
  const ctl = createAskController({
    state,
    snap: () => s,
    mutate: async (op, data) => {
      calls.mutate.push([op, data]);
      if (refusal) {
        const err = refusal;
        refusal = null;
        throw err;
      }
      return { threadId: 'ask-new1', turnId: 'turn-1', jobId: 'job-1' };
    },
    render: () => { calls.render++; calls.html = askField(state, s); },
    go: async h => { calls.go.push(h); hash = h; },
    withClaudeChoice: async run => {
      try {
        return await run();
      } catch (err) {
        if (err?.code !== 'needs_choice') throw err;
        calls.chooser++;
        if (!choose) throw err;
        return run();
      }
    },
    focus: (sel, opts) => calls.focus.push([sel, opts || null]),
    focusBack: sel => calls.focusBack.push(sel),
    fieldShown: () => shown,
    hash: () => hash,
    hiddenCalendars: () => new Set(hidden),
    fail: err => calls.failed.push(err),
  });
  return { ctl, state, calls, s };
}

function keyEvent(over = {}) {
  const ev = { key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: { id: 'ask-input' }, defaultPrevented: false, propagationStopped: false, ...over };
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  ev.stopPropagation = () => { ev.propagationStopped = true; };
  return ev;
}

test('the_about_chip_follows_the_selection_and_is_read_at_enter', async () => {
  const { ctl, state, calls } = harness();
  await ctl.focusField({ from: '[data-id="row"]' });
  assert.match(calls.html, /About: Priya N\./);
  ctl.input('what did I promise?');
  // Jordan's row is selected while the question is typed: the next render shows Jordan.
  state.selectedMessage = 'm-jordan';
  ctl.closed();
  assert.match(calls.html, /About: Jordan Lee/);
  assert.doesNotMatch(calls.html, /Priya/);
  const ev = keyEvent();
  assert.equal(ctl.key(ev), true);
  await tick();
  await tick();
  const starts = calls.mutate.filter(([op]) => op === 'ask_start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0][1].question, 'what did I promise?');
  assert.deepEqual(starts[0][1].about, { kind: 'message', recordId: 'm-jordan', label: 'Jordan Lee · mail · Tue 24 Nov' });
});

test('ask_start carries the window’s hidden calendars, so they stay out of Ask’s context', async () => {
  const { ctl, calls } = harness({ hidden: ['cal-home', 'cal-birthdays'] });
  ctl.input('what is on this week?');
  await ctl.submitField();
  assert.deepEqual(calls.mutate[0][1].hiddenCalendars, ['cal-home', 'cal-birthdays']);
  const none = harness({ hidden: [] });
  none.ctl.input('q');
  await none.ctl.submitField();
  assert.deepEqual(none.calls.mutate[0][1].hiddenCalendars, []);
});

test('× on the chip ("Don\'t ask about <label>") drops it for this question only', async () => {
  const { ctl, state, calls } = harness();
  await ctl.focusField();
  ctl.input('general question');
  await ctl.handle('ask-about-drop');
  assert.doesNotMatch(calls.html, /data-ask-about/);
  assert.deepEqual(calls.focus.at(-1), ['#ask-input', null]);
  await ctl.submitField();
  assert.equal('about' in calls.mutate[0][1], false);
  // The next question has its chip back.
  assert.equal(state.ask.aboutDropped, false);
  await ctl.focusField();
  ctl.input('next');
  await ctl.submitField();
  assert.equal(calls.mutate[1][1].about.recordId, 'm-priya');
});

test('Recent: ↑ ↓ move and Enter opens #/ask/<threadId>; the hash before is kept as `from`', async () => {
  const { ctl, state, calls } = harness({ state: { route: 'today' }, here: '#/today' });
  await ctl.focusField();
  assert.equal(ctl.key(keyEvent({ key: 'ArrowDown' })), true);
  assert.match(calls.html, /aria-activedescendant="ask-recent-0"/);
  ctl.key(keyEvent({ key: 'ArrowDown' }));
  ctl.key(keyEvent({ key: 'ArrowDown' }));
  ctl.key(keyEvent({ key: 'ArrowDown' }));
  assert.equal(state.ask.active, 0, 'wraps after the last');
  ctl.key(keyEvent({ key: 'ArrowUp' }));
  assert.equal(state.ask.active, 2);
  ctl.key(keyEvent());
  await tick();
  assert.deepEqual(calls.go, ['#/ask/ask-51bd']);
  assert.equal(state.ask.from, '#/today');
  assert.equal(calls.mutate.length, 0, 'opening a thread asks nothing');
  // A click on a row does the same.
  await ctl.handle('ask-recent', { dataset: { askRecent: 'ask-3a9e' } });
  assert.equal(calls.go.at(-1), '#/ask/ask-3a9e');
  assert.equal(state.ask.from, '#/today', 'from stays the page before the first #/ask');
});

test('Enter asks once and goes to #/ask/<threadId>; an empty field or ⇧Enter does nothing', async () => {
  const { ctl, state, calls } = harness();
  ctl.key(keyEvent());
  ctl.input('   ');
  ctl.key(keyEvent());
  ctl.input('When is the QBR?');
  const shift = keyEvent({ shiftKey: true });
  assert.equal(ctl.key(shift), true);
  assert.equal(shift.defaultPrevented, true);
  await tick();
  assert.equal(calls.mutate.length, 0);
  const enter = keyEvent();
  ctl.key(enter);
  assert.equal(enter.propagationStopped, true, 'the Inbox’s own Enter never sees it');
  await tick();
  await tick();
  assert.equal(calls.mutate.length, 1);
  assert.deepEqual(calls.go, ['#/ask/ask-new1']);
  assert.equal(state.ask.text, '');
  assert.equal(state.ask.from, '#/inbox');
});

test('Esc clears text first, then returns focus to where it was before ⌘K', async () => {
  const { ctl, state, calls } = harness();
  await ctl.focusField({ from: '#reply-body' });
  ctl.input('half a question');
  ctl.key(keyEvent({ key: 'Escape' }));
  assert.equal(state.ask.text, '');
  assert.equal(state.ask.open, true);
  assert.equal(calls.focusBack.length, 0);
  ctl.key(keyEvent({ key: 'Escape' }));
  assert.equal(state.ask.open, false);
  assert.deepEqual(calls.focusBack, ['#reply-body']);
});

test('while an answer runs Enter shows "Connect is still answering. Stop it or wait." and sends nothing', async () => {
  const { ctl, state, calls } = harness({ s: snapshot('running') });
  ctl.input('another question');
  await ctl.submitField();
  assert.equal(calls.mutate.length, 0);
  assert.equal(state.ask.error, 'Connect is still answering. Stop it or wait.');
  assert.match(calls.html, /role="alert">Connect is still answering/);
  // A busy refusal from native says the same, under the box.
  const raced = harness({ refuse: { code: 'busy', message: 'Connect is still answering. Stop it or wait.' } });
  raced.ctl.input('q');
  await raced.ctl.submitField();
  assert.equal(raced.state.ask.error, 'Connect is still answering. Stop it or wait.');
  assert.equal(raced.state.ask.text, 'q', 'the words stay');
  assert.deepEqual(raced.calls.go, []);
  ctl.input('another question!');
  assert.equal(state.ask.error, '', 'a change clears the refusal');
});

test('needs_choice opens the chooser through withClaudeChoice and asks again after a choice', async () => {
  const { ctl, calls } = harness({ refuse: { code: 'needs_choice', message: 'Choose' } });
  ctl.input('who is waiting on me?');
  await ctl.submitField();
  assert.equal(calls.chooser, 1);
  assert.equal(calls.mutate.length, 2);
  assert.deepEqual(calls.go, ['#/ask/ask-new1']);
  // Cancelled: nothing more, no error toast.
  const cancelled = harness({ refuse: { code: 'needs_choice', message: 'Choose' }, choose: false });
  cancelled.ctl.input('q');
  await cancelled.ctl.submitField();
  assert.equal(cancelled.calls.mutate.length, 1);
  assert.deepEqual(cancelled.calls.failed, []);
  assert.deepEqual(cancelled.calls.go, []);
});

test('⌘K focuses the field with its text selected; with the field hidden or the rail it opens #/ask with the page box focused', async () => {
  const { ctl, state, calls } = harness();
  await ctl.focusField({ from: '#reply-body' });
  assert.equal(state.ask.open, true);
  assert.deepEqual(calls.focus, [['#ask-input', { select: true }]]);
  assert.equal(state.ask.focusBack, '#reply-body');
  const rail = harness({ shown: false });
  await rail.ctl.focusField();
  assert.deepEqual(rail.calls.go, ['#/ask']);
  assert.deepEqual(rail.calls.focus, [['#ask-follow-up', null]]);
  assert.equal(rail.state.ask.from, '#/inbox');
  const button = harness();
  await button.ctl.handle('ask-rail');
  assert.deepEqual(button.calls.go, ['#/ask']);
  assert.deepEqual(button.calls.focus, [['#ask-follow-up', null]]);
});

test('the page box asks a new question on #/ask and a follow-up on #/ask/<id>, with no About', async () => {
  const { ctl, state, calls } = harness({ state: { route: 'ask', ask: undefined }, here: '#/ask' });
  ctl.key(keyEvent({ target: { id: 'ask-follow-up', value: 'What is due?' } }));
  await tick();
  await tick();
  assert.deepEqual(calls.mutate[0][1], { question: 'What is due?', hiddenCalendars: ['cal-home'] });
  state.ask.threadId = 'ask-7f2c';
  await ctl.submitPage('And next week?');
  assert.equal(calls.mutate[1][1].threadId, 'ask-7f2c');
});
