// The Ask controller over fakes (ask-capture design § 2, § 11, rulings 16, 32 and 34): the field's
// keys, the About chip read at Enter, Recent, Esc, the busy refusal, the first-use chooser, ⌘K
// and the rail, and the hidden calendars `ask_start` carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAskController } from '../workspace/ask-controller.js';
import { askField, citeTarget } from '../workspace/ask-model.js';
import { createCaptureController } from '../workspace/capture-controller.js';
import { captureBar } from '../workspace/capture-model.js';
import { askThread, buildSnapshot, withAsk } from './fixtures/workspace-fixture.mjs';

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
  // Final review M2: reading a thread with the field hidden, ⌘K asks a follow-up in place.
  const reading = harness({ shown: false, state: { route: 'ask' }, here: '#/ask/ask-7f2c' });
  await reading.ctl.focusField();
  assert.deepEqual(reading.calls.go, [], 'the open thread stays');
  assert.deepEqual(reading.calls.focus, [['#ask-follow-up', null]]);
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

test('a click that focuses the field selects its words, as ⌘K does', () => {
  const { ctl, state, calls } = harness();
  ctl.input('typed before');
  ctl.opened();
  assert.equal(state.ask.open, true);
  assert.deepEqual(calls.focus, [['#ask-input', { select: true }]]);
  ctl.opened();
  assert.equal(calls.focus.length, 1, 'already open: nothing more');
});

test('every close forgets where focus came from: Esc, Enter, a click away', async () => {
  const esc = harness();
  await esc.ctl.focusField({ from: '#reply-body' });
  esc.ctl.key(keyEvent({ key: 'Escape' }));
  assert.equal(esc.state.ask.focusBack, null);
  const enter = harness();
  await enter.ctl.focusField({ from: '#reply-body' });
  enter.ctl.input('q');
  await enter.ctl.submitField();
  assert.equal(enter.state.ask.focusBack, null);
  const away = harness();
  await away.ctl.focusField({ from: '#reply-body' });
  away.ctl.closed();
  assert.equal(away.state.ask.focusBack, null);
  // A later Esc from a click-focused field goes to the page, not the stale control.
  away.ctl.opened();
  away.ctl.key(keyEvent({ key: 'Escape' }));
  assert.deepEqual(away.calls.focusBack, [null]);
});


// ---------------------------------------------------------------- the Ask page (Task 10)

/** A controller on `#/ask/ask-7f2c` over fakes: `ask_read` answers `threads[id]` (a copy), or
 *  throws not_found; every other request is recorded and answered as native does. */
function pageHarness({ askState = 'idle', threadId = 'ask-7f2c', threads = { 'ask-7f2c': askThread() }, from = '#/inbox', focusBack = '[data-id="m-priya"]', refuse = null } = {}) {
  const s = withAsk(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), askState);
  const calls = { mutate: [], query: [], go: [], focus: [], focusBack: [], render: 0, announce: [], confirm: [], failed: [] };
  const state = { route: 'ask', ask: { from, backFocus: focusBack, focusBack: null, threadId } };
  let refusal = refuse;
  let hash = threadId ? `#/ask/${threadId}` : '#/ask';
  const ctl = createAskController({
    state,
    snap: () => s,
    query: async (op, data) => {
      calls.query.push([op, data]);
      const t = threads[data.threadId];
      if (!t) throw Object.assign(new Error('That conversation is gone. Ask again.'), { code: 'not_found' });
      return structuredClone(t);
    },
    mutate: async (op, data) => {
      calls.mutate.push([op, data]);
      if (refusal) {
        const err = refusal;
        refusal = null;
        throw err;
      }
      if (op === 'ask_start') return { threadId: data.threadId || 'ask-new1', turnId: 'turn-9', jobId: 'job-9' };
      if (op === 'ask_delete') return { deleted: data.all ? 3 : 1 };
      return {};
    },
    render: () => { calls.render++; },
    go: async h => {
      calls.go.push(h);
      hash = h;
      const m = /^#\/ask(?:\/(.+))?$/.exec(h);
      state.route = m ? 'ask' : h.replace(/^#\/?/, '').split('/')[0];
      if (m) state.ask.threadId = m[1] ? decodeURIComponent(m[1]) : null;
      else state.ask.focusBack = null;
    },
    focus: (sel, o) => calls.focus.push([sel, o || null]),
    focusBack: sel => calls.focusBack.push(sel),
    hash: () => hash,
    hiddenCalendars: () => ['cal-home'],
    announce: text => calls.announce.push(text),
    confirm: o => calls.confirm.push(o),
    fail: err => calls.failed.push(err),
  });
  return { ctl, state, calls, s, threads };
}
const el = data => ({ dataset: data });

test('opening a thread reads it once with ask_read, draws it and focuses the newest turn\'s heading', async () => {
  const { ctl, calls } = pageHarness();
  await ctl.openThread();
  assert.deepEqual(calls.query, [['ask_read', { threadId: 'ask-7f2c' }]]);
  assert.equal(ctl.thread().id, 'ask-7f2c');
  assert.ok(calls.render >= 1);
  assert.deepEqual(calls.focus.at(-1), ['[data-ask-turn="turn-3"] .ws-ask-q', null]);
  // Nothing changed in the snapshot: no second read.
  await ctl.refresh();
  assert.equal(calls.query.length, 1);
  // Rendering a thread writes nothing.
  assert.equal(calls.mutate.length, 0);
});

test('a change to the open thread in the snapshot reads it again; a finished answer is announced once', async () => {
  const running = structuredClone(askThread());
  running.turns[2] = { ...running.turns[2], state: 'running', id: 'turn-3' };
  const { ctl, calls, s, threads } = pageHarness({ askState: 'running', threads: { 'ask-7f2c': running } });
  await ctl.openThread();
  assert.equal(calls.announce.length, 0);
  // The answer lands: the snapshot moves on, the thread reads again, "Answer ready" once.
  const done = structuredClone(running);
  done.turns[2] = { ...done.turns[2], state: 'done', answer: 'Marek Novak owns the rollout.' };
  threads['ask-7f2c'] = done;
  s.ask = { ...s.ask, running: null, threads: s.ask.threads.map(t => (t.id === 'ask-7f2c' ? { ...t, last: 'done', updatedAt: t.updatedAt + 5 } : t)) };
  await ctl.refresh();
  assert.equal(calls.query.length, 2);
  assert.deepEqual(calls.announce, ['Answer ready']);
  await ctl.refresh();
  assert.deepEqual(calls.announce, ['Answer ready'], 'announced once');
  // A failed one says so.
  const failed = structuredClone(done);
  failed.turns.push({ ...done.turns[2], id: 'turn-4', state: 'queued', answer: null });
  threads['ask-7f2c'] = failed;
  s.ask = { ...s.ask, threads: s.ask.threads.map(t => (t.id === 'ask-7f2c' ? { ...t, turns: 4, last: 'queued', updatedAt: t.updatedAt + 1 } : t)) };
  await ctl.refresh();
  const after = structuredClone(failed);
  after.turns[3] = { ...after.turns[3], state: 'failed', error: { code: 'timeout', message: 'Claude took too long.' } };
  threads['ask-7f2c'] = after;
  s.ask = { ...s.ask, threads: s.ask.threads.map(t => (t.id === 'ask-7f2c' ? { ...t, last: 'failed', updatedAt: t.updatedAt + 1 } : t)) };
  await ctl.refresh();
  assert.deepEqual(calls.announce, ['Answer ready', 'Couldn’t answer']);
});

test('a thread that is gone reads as missing, and the box then asks a new question', async () => {
  const { ctl, calls } = pageHarness({ threads: {} });
  await ctl.openThread();
  assert.deepEqual(ctl.thread(), { id: 'ask-7f2c', missing: true });
  assert.equal(calls.failed.length, 0);
  await ctl.submitPage('When is the QBR?');
  assert.deepEqual(calls.mutate[0], ['ask_start', { question: 'When is the QBR?', hiddenCalendars: ['cal-home'] }]);
});

test('Stop and ⌘. send one job_cancel {id}', async () => {
  const { ctl, calls } = pageHarness({ askState: 'running' });
  await ctl.handle('ask-stop', el({ job: 'job-9' }));
  assert.deepEqual(calls.mutate, [['job_cancel', { id: 'job-9' }]]);
  await ctl.stop();
  assert.deepEqual(calls.mutate.at(-1), ['job_cancel', { id: 'job-9' }]);
  assert.equal(calls.mutate.length, 2);
  // Nothing runs: ⌘. sends nothing.
  const idle = pageHarness();
  await idle.ctl.stop();
  assert.equal(idle.calls.mutate.length, 0);
});

test('a failed Stop shows its error, and Stop can be pressed again', async () => {
  const refusal = Object.assign(new Error('Workspace storage could not complete the operation.'), { code: 'storage' });
  const { ctl, calls } = pageHarness({ askState: 'running', refuse: refusal });
  await ctl.stop();
  assert.deepEqual(calls.failed, [refusal]);
  await ctl.stop();
  assert.equal(calls.mutate.length, 2);
  assert.equal(calls.failed.length, 1);
});

test('Ask again and Try again send ask_start {threadId, question} with the turn\'s question', async () => {
  const { ctl, calls } = pageHarness();
  await ctl.openThread();
  await ctl.handle('ask-again', el({ askTurn: 'turn-3' }));
  await ctl.handle('ask-retry', el({ askTurn: 'turn-2' }));
  assert.deepEqual(calls.mutate, [
    ['ask_start', { threadId: 'ask-7f2c', question: 'Who is Marek Novak?', hiddenCalendars: ['cal-home'] }],
    ['ask_start', { threadId: 'ask-7f2c', question: 'And Jordan Lee?', hiddenCalendars: ['cal-home'] }],
  ]);
  // A busy refusal shows under the box.
  const busy = pageHarness({ refuse: Object.assign(new Error('Connect is still answering. Stop it or wait.'), { code: 'busy' }) });
  await busy.ctl.openThread();
  await busy.ctl.handle('ask-again', el({ askTurn: 'turn-3' }));
  assert.equal(busy.state.ask.pageError, 'Connect is still answering. Stop it or wait.');
});

test('the follow-up box asks ask_start {threadId, question} and keeps the words until it is asked', async () => {
  const { ctl, state, calls } = pageHarness();
  ctl.pageInput('And Jordan?');
  assert.equal(state.ask.pageText, 'And Jordan?');
  await ctl.handle('ask-follow-up', null);
  assert.deepEqual(calls.mutate[0], ['ask_start', { question: 'And Jordan?', threadId: 'ask-7f2c', hiddenCalendars: ['cal-home'] }]);
  assert.equal(state.ask.pageText, '');
  // While a turn runs it is refused here, before native.
  const running = pageHarness({ askState: 'running' });
  running.ctl.pageInput('More?');
  await running.ctl.handle('ask-follow-up', null);
  assert.equal(running.calls.mutate.length, 0);
});

test('⋯ Delete sends one ask_delete {threadId} at once; deleting the open thread goes to #/ask', async () => {
  const { ctl, calls } = pageHarness();
  await ctl.handle('ask-delete', el({ askThread: 'ask-3a9e' }));
  assert.deepEqual(calls.mutate, [['ask_delete', { threadId: 'ask-3a9e' }]]);
  assert.deepEqual(calls.confirm, [], 'no dialog');
  assert.deepEqual(calls.go, []);
  await ctl.handle('ask-delete', el({ askThread: 'ask-7f2c' }));
  assert.deepEqual(calls.mutate.at(-1), ['ask_delete', { threadId: 'ask-7f2c' }]);
  assert.deepEqual(calls.go, ['#/ask']);
});

test('Clear history opens "Clear Ask history?" with Cancel focused and Return cancelling; "Clear history" sends one ask_delete {all:true}', async () => {
  const { ctl, calls } = pageHarness();
  await ctl.handle('ask-clear', el({}));
  assert.equal(calls.mutate.length, 0, 'nothing before the dialog answers');
  const [dialog] = calls.confirm;
  assert.equal(dialog.title, 'Clear Ask history?');
  assert.equal(dialog.text, 'Connect deletes every question and answer kept on this Mac. Your mail, tasks and notes are not touched.');
  assert.equal(dialog.confirm, 'Clear history');
  assert.equal(dialog.initialFocus, 'cancel');
  assert.equal(dialog.returnCancels, true);
  await dialog.onConfirm();
  assert.deepEqual(calls.mutate, [['ask_delete', { all: true }]]);
  assert.deepEqual(calls.go, ['#/ask']);
});

test('the examples fill the box without asking', async () => {
  const { ctl, state, calls } = pageHarness({ askState: 'empty', threadId: null, threads: {} });
  await ctl.handle('ask-example', el({ text: 'What’s due this week?' }));
  assert.equal(state.ask.pageText, 'What’s due this week?');
  assert.deepEqual(calls.focus.at(-1), ['#ask-follow-up', null]);
  assert.equal(calls.mutate.length, 0);
});

test('Back and Esc go to state.ask.from; focus returns to where it was before ⌘K', async () => {
  const { ctl, calls } = pageHarness();
  await ctl.handle('ask-back', el({}));
  assert.deepEqual(calls.go, ['#/inbox']);
  assert.deepEqual(calls.focusBack, ['[data-id="m-priya"]']);
  // Esc in the box clears its words first, then leaves.
  const esc = pageHarness();
  esc.ctl.pageInput('typed');
  const ev = keyEvent({ key: 'Escape', target: { id: 'ask-follow-up', value: 'typed' } });
  assert.equal(esc.ctl.key(ev), true);
  assert.equal(esc.state.ask.pageText, '');
  assert.deepEqual(esc.calls.go, []);
  esc.ctl.key(keyEvent({ key: 'Escape', target: { id: 'ask-follow-up', value: '' } }));
  await tick();
  assert.deepEqual(esc.calls.go, ['#/inbox']);
  // Opened with no page before: back to Today.
  const none = pageHarness({ from: null, focusBack: null });
  await none.ctl.back();
  assert.deepEqual(none.calls.go, ['#/today']);
});

test('History, New ask and Check Settings › AI navigate; a mark focuses its chip', async () => {
  const { ctl, calls } = pageHarness();
  await ctl.handle('ask-history', el({ askThread: 'ask-3a9e' }));
  await ctl.handle('ask-new', el({}));
  await ctl.handle('ask-settings', el({}));
  assert.deepEqual(calls.go, ['#/ask/ask-3a9e', '#/ask', '#/settings/ai']);
  assert.deepEqual(calls.focus.find(([sel]) => sel === '#ask-follow-up'), ['#ask-follow-up', null]);
  await ctl.handle('ask-mark', el({ askMark: 'ask-cite-turn-1-a1' }));
  assert.deepEqual(calls.focus.at(-1), ['#ask-cite-turn-1-a1', null]);
});

test('I1: Back returns focus to where it was before ⌘K, though the field forgot it when it closed', async () => {
  // ⌘K on an Inbox row, a question, Enter: the field closes (and forgets), the page opens.
  const { ctl, state, calls } = harness();
  await ctl.focusField({ from: '[data-id="m-priya"]' });
  ctl.input('what did I promise?');
  await ctl.submitField();
  assert.equal(state.ask.focusBack, null, 'the field forgot');
  assert.equal(state.ask.backFocus, '[data-id="m-priya"]', 'the page kept it');
  state.route = 'ask';
  await ctl.handle('ask-back', { dataset: {} });
  assert.deepEqual(calls.go.at(-1), '#/inbox');
  assert.deepEqual(calls.focusBack, ['[data-id="m-priya"]']);
  assert.equal(state.ask.backFocus, null, 'used once');
  // Through a Recent row too.
  const recent = harness();
  await recent.ctl.focusField({ from: '[data-id="m-jordan"]' });
  await recent.ctl.handle('ask-recent', { dataset: { askRecent: 'ask-3a9e' } });
  assert.equal(recent.state.ask.backFocus, '[data-id="m-jordan"]');
  // Moving between threads keeps it; a later ⌘K from another page replaces it.
  await recent.ctl.handle('ask-history', { dataset: { askThread: 'ask-7f2c' } });
  assert.equal(recent.state.ask.backFocus, '[data-id="m-jordan"]');
});

test('I1: a close while ⌘K draws the field (focus put back on the row a moment) keeps Back\'s focus; Esc giving focus back drops it', async () => {
  const { ctl, state, calls } = harness();
  await ctl.focusField({ from: '[data-id="m-priya"]' });
  ctl.closed();
  ctl.opened();
  ctl.input('what did I promise?');
  await ctl.submitField();
  assert.equal(state.ask.backFocus, '[data-id="m-priya"]');
  state.route = 'ask';
  await ctl.back();
  assert.deepEqual(calls.focusBack.at(-1), '[data-id="m-priya"]');
  // Esc on an empty field gives focus back there itself: nothing is left for a later page.
  const esc = harness();
  await esc.ctl.focusField({ from: '[data-id="m-priya"]' });
  esc.ctl.key(keyEvent({ key: 'Escape' }));
  assert.equal(esc.state.ask.backFocus, null);
});

// ---------------------------------------------------------------- cites and actions (Task 11)

/** The records ask-thread.json's cites and actions point at; Priya's mail is "Atlas budget". */
function withThreadRecords(s) {
  const msg = (id, from, channel) => ({ id, kind: 'message', source: 'mail:inbox', connectionId: s.connection.id, workspaceId: null, revision: `r-${id}`, updatedAt: TUE,
    data: { channel, title: 'Atlas budget', text: 'Can you send the deck?', from, fromAddress: 'x@example.test', at: TUE, lane: 'reply', lifecycle: 'open', conversationId: `conv-${id}`, isMine: false, to: [] } });
  s.records.push(
    msg('msg-17', 'Priya N.', 'mail'), msg('msg-21', 'Jordan Lee', 'chat'),
    { id: 'task-3', kind: 'commitment', source: 'local', connectionId: null, workspaceId: 'personal', revision: 'r-t', updatedAt: TUE, data: { text: 'Send the Atlas budget', status: 'todo' } },
    { id: 'ev-9', kind: 'event', source: 'calendar:cal-main', connectionId: s.connection.id, workspaceId: null, revision: 'r-e', updatedAt: TUE, data: { title: 'QBR', start: '2026-11-27T10:00:00Z', end: '2026-11-27T11:00:00Z', allDay: false, calendarId: 'cal-main' } },
    { id: 'ev-4', kind: 'event', source: 'calendar:cal-main', connectionId: s.connection.id, workspaceId: null, revision: 'r-e4', updatedAt: TUE, data: { title: 'Atlas sync', start: '2026-11-20T14:00:00Z', end: '2026-11-20T15:00:00Z', allDay: false, calendarId: 'cal-main' } },
  );
  return s;
}

/** The page over fakes with the thread's records, app.js's record opener, its quick capture
 *  (the real controller, drawn with `captureBar`) and the toasts recorded. */
function actionHarness({ drop = [], ...over } = {}) {
  const h = pageHarness(over);
  withThreadRecords(h.s);
  h.s.records = h.s.records.filter(r => !drop.includes(r.id));
  Object.assign(h.calls, { opened: [], toasts: [], drafts: [], captureHtml: '', parse: 0 });
  h.state.capture = undefined;
  const capture = createCaptureController({
    state: h.state, snap: () => h.s,
    mutate: async (op, data) => { h.calls.mutate.push([op, data]); return { id: 'task-new' }; },
    query: async () => { h.calls.parse++; return { title: '', due: null }; },
    render: () => { h.calls.captureHtml = h.state.capture.open ? captureBar(h.state, h.s) : ''; },
    wait: 0,
  });
  h.state.capture = { ...h.state.capture };
  return { ...h, capture };
}

/** Builds the controller of `h` again with Task 11's dependencies (the harness made it without). */
function withActions(h, { claude = run => run() } = {}) {
  const { state, calls, s } = h;
  let hash = `#/ask/${state.ask.threadId}`;
  const ctl = createAskController({
    state, snap: () => s,
    query: async (op, data) => { calls.query.push([op, data]); return structuredClone(h.threads[data.threadId]); },
    mutate: async (op, data) => { calls.mutate.push([op, data]); return {}; },
    render: () => { calls.render++; },
    go: async target => {
      calls.go.push(target);
      hash = target;
      const m = /^#\/ask(?:\/(.+))?$/.exec(target);
      state.route = m ? 'ask' : target.replace(/^#\/?/, '').split('/')[0];
      if (m) state.ask.threadId = m[1] ? decodeURIComponent(m[1]) : null;
    },
    openRecord: async (target, options) => {
      calls.opened.push(target);
      calls.closed = options?.closed;
      if (h.refuseOpen) return false;
      hash = target.hash;
      state.route = target.hash.replace(/^#\/?/, '').split('/')[0];
    },
    hash: () => hash,
    toast: (message, tone, action, options) => calls.toasts.push({ message, tone, action, options }),
    now: () => h.clock ?? 0,
    withClaudeChoice: claude,
    draftOptions: channel => ({ intent: 'reply', tone: 'neutral', length: 'short', includeFreeTimes: false, channel }),
    openCapture: o => h.capture.open(o),
    focus: (sel, o) => calls.focus.push([sel, o || null]),
    focusBack: sel => calls.focusBack.push(sel),
    fail: err => calls.failed.push(err),
  });
  return ctl;
}

const writes = calls => calls.mutate.filter(([op]) => op !== 'job_cancel');

test('a cite chip navigates and toasts "← Back to Ask" for 6 s; the toast returns to the thread', async () => {
  const h = actionHarness();
  const ctl = withActions(h);
  await ctl.openThread();
  await ctl.handle('ask-cite', el({ askTurn: 'turn-1', askCite: 'a1' }));
  assert.deepEqual(h.calls.opened, [{ hash: '#/inbox', select: { kind: 'message', id: 'msg-17', lane: 'reply' } }]);
  assert.equal(h.calls.toasts.length, 1);
  const t = h.calls.toasts[0];
  assert.equal(t.action.label, '← Back to Ask');
  assert.equal(t.options.life, 6000);
  await t.action.run();
  assert.deepEqual(h.calls.go.at(-1), '#/ask/ask-7f2c');
  assert.equal(h.state.route, 'ask');
  // Every kind goes where its cite says; a person and a fact go nowhere.
  for (const id of ['t2', 'e3', 'n5']) await ctl.handle('ask-cite', el({ askTurn: 'turn-1', askCite: id }));
  assert.deepEqual(h.calls.opened.slice(1).map(o => o.hash), ['#/tasks', '#/calendar', '#/meetings/ev-4/summary']);
  for (const id of ['p6', 'f7', 'zz']) await ctl.handle('ask-cite', el({ askTurn: 'turn-1', askCite: id }));
  assert.equal(h.calls.opened.length, 4);
  assert.equal(h.calls.toasts.length, 4);
  assert.deepEqual(writes(h.calls), [], 'a cite sends nothing');
});

test('+ Add as task opens the capture bar with the action\'s text and due and the turn\'s About as source; nothing is sent until Add', async () => {
  const h = actionHarness();
  const ctl = withActions(h);
  await ctl.openThread();
  await ctl.handle('ask-task', el({ askTurn: 'turn-1', askIndex: '0' }));
  assert.equal(h.state.capture.open, true);
  assert.equal(h.state.capture.mode, 'task');
  assert.equal(h.state.capture.text, 'Send Priya the Atlas budget');
  assert.deepEqual(h.state.capture.source, { kind: 'message', id: 'msg-17' });
  assert.match(h.calls.captureHtml, /value="Send Priya the Atlas budget"/);
  assert.match(h.calls.captureHtml, /Due Fri 27 Nov/);
  assert.match(h.calls.captureHtml, /From: Atlas budget/);
  assert.deepEqual(h.calls.mutate, [], 'no task_save before Add');
  assert.equal(h.calls.opened.length, 0, 'the page stays');
  // An About that is not a message or a meeting links nothing; none at all, nothing.
  h.capture.close({ refocus: false });
  h.threads['ask-7f2c'].turns[0].about = { kind: 'task', recordId: 'task-3', label: 'Task · Send the Atlas budget' };
  await ctl.refresh({ force: true });
  await ctl.handle('ask-task', el({ askTurn: 'turn-1', askIndex: '0' }));
  assert.equal(h.state.capture.source, null);
});

test('"Open <label>" navigates as its cite does', async () => {
  const h = actionHarness();
  const ctl = withActions(h);
  await ctl.openThread();
  await ctl.handle('ask-go', el({ askTurn: 'turn-1', askIndex: '1' }));
  const turn = h.threads['ask-7f2c'].turns[0];
  assert.deepEqual(h.calls.opened, [citeTarget(turn.cites.find(c => c.id === 'e3'), h.s)]);
  assert.deepEqual(h.calls.opened[0], { hash: '#/calendar', select: { kind: 'event', id: 'ev-9', day: '2026-11-27' } });
  assert.equal(h.calls.toasts[0].action.label, '← Back to Ask');
  assert.deepEqual(h.calls.mutate, []);
});

test('"✦ Draft a reply to Priya N." opens the message, then sends one ai_draft whose instructions are the action\'s hint; nothing is sent', async () => {
  const h = actionHarness();
  let chooser = 0;
  const ctl = withActions(h, { claude: async run => { chooser++; return run(); } });
  await ctl.openThread();
  await ctl.handle('ask-reply', el({ askTurn: 'turn-1', askIndex: '2' }));
  assert.deepEqual(h.calls.opened, [{ hash: '#/inbox', select: { kind: 'message', id: 'msg-21', lane: 'reply' } }]);
  assert.deepEqual(h.calls.mutate, [['ai_draft', { sourceId: 'msg-21', intent: 'reply', tone: 'neutral', length: 'short', includeFreeTimes: false, instructions: 'Say the deck comes Thursday.' }]]);
  assert.equal(chooser, 1, 'through withClaudeChoice');
  assert.equal(h.calls.toasts[0].action.label, '← Back to Ask');
  assert.ok(!h.calls.mutate.some(([op]) => /send|task_save|reply_save/.test(op)), 'nothing sent');
  // The hint stays one line of at most 200 characters on the instructions path.
  h.threads['ask-7f2c'].turns[0].actions[2].hint = `Line one\nline two ${'x'.repeat(300)}`;
  h.state.route = 'ask';
  await ctl.refresh({ force: true });
  await ctl.handle('ask-reply', el({ askTurn: 'turn-1', askIndex: '2' }));
  const instructions = h.calls.mutate.at(-1)[1].instructions;
  assert.ok(!instructions.includes('\n'));
  assert.ok(instructions.length <= 200);
  assert.ok(instructions.startsWith('Line one line two'));
});

test('a record gone by the click says "No longer in Connect." and offers no way back; a stale click does nothing', async () => {
  const h = actionHarness({ drop: ['ev-9', 'msg-21', 'task-3'] });
  const ctl = withActions(h);
  await ctl.openThread();
  await ctl.handle('ask-go', el({ askTurn: 'turn-1', askIndex: '1' }));
  await ctl.handle('ask-reply', el({ askTurn: 'turn-1', askIndex: '2' }));
  await ctl.handle('ask-cite', el({ askTurn: 'turn-1', askCite: 'e3' }));
  await ctl.handle('ask-cite', el({ askTurn: 'turn-1', askCite: 't2' }));
  assert.deepEqual(h.calls.opened, [], 'nothing routed (a gone task does not open Tasks)');
  assert.deepEqual(h.calls.toasts.map(t => [t.message, t.tone, t.action]), Array(4).fill(['No longer in Connect.', 'error', null]));
  // A wrong index, kind or turn, a person or a fact does nothing at all.
  h.calls.toasts.length = 0;
  await ctl.handle('ask-reply', el({ askTurn: 'turn-1', askIndex: '0' }));
  await ctl.handle('ask-task', el({ askTurn: 'turn-9', askIndex: '0' }));
  await ctl.handle('ask-cite', el({ askTurn: 'turn-1', askCite: 'p6' }));
  await ctl.handle('ask-cite', el({ askTurn: 'turn-1', askCite: 'zz' }));
  assert.deepEqual(h.calls.opened, []);
  assert.deepEqual(h.calls.mutate, []);
  assert.equal(h.calls.toasts.length, 0);
  assert.notEqual(h.state.capture.open, true);
  // The record leaves between the check and the opening: app.js says so, no way back, no draft.
  const late = actionHarness();
  late.refuseOpen = true;
  const lateCtl = withActions(late);
  await lateCtl.openThread();
  await lateCtl.handle('ask-cite', el({ askTurn: 'turn-1', askCite: 'a1' }));
  await lateCtl.handle('ask-reply', el({ askTurn: 'turn-1', askIndex: '2' }));
  assert.deepEqual(late.calls.toasts.map(t => t.message), ['No longer in Connect.', 'No longer in Connect.']);
  assert.deepEqual(late.calls.mutate, []);
});

test('M2: the event card closing after the toast timed out offers "← Back to Ask" again', async () => {
  const h = actionHarness();
  h.clock = 1000;
  const ctl = withActions(h);
  await ctl.openThread();
  await ctl.handle('ask-cite', el({ askTurn: 'turn-1', askCite: 'e3' }));
  assert.equal(h.calls.toasts.length, 1);
  // Closed within 6 s: the first toast is still there.
  h.clock = 6999;
  h.calls.closed();
  assert.equal(h.calls.toasts.length, 1);
  // Closed later: once more, for another 6 s.
  h.clock = 7000;
  h.calls.closed();
  assert.equal(h.calls.toasts.length, 2);
  assert.equal(h.calls.toasts[1].action.label, '← Back to Ask');
  assert.equal(h.calls.toasts[1].options.life, 6000);
  await h.calls.toasts[1].action.run();
  assert.deepEqual(h.calls.go.at(-1), '#/ask/ask-7f2c');
});

test('rendering a thread sends nothing', async () => {
  const h = actionHarness();
  const ctl = withActions(h);
  await ctl.openThread();
  await ctl.refresh({ force: true });
  assert.deepEqual(h.calls.mutate, [], 'no mutate on open');
  assert.ok(h.calls.query.every(([op]) => op === 'ask_read'), 'only ask_read');
  assert.equal(h.calls.opened.length + h.calls.toasts.length, 0);
});
