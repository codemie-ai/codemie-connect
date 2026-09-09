import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startSetup } from '../setup-driver.js';

// Most tests in this file don't override deps.suspendPtyInput/resumePtyInput,
// so startSetup lazily default-imports the real ui/terminal.js (Task 13),
// which reads window.__TAURI__.core.invoke at module scope. Stubbing it once,
// here, lets that default import succeed harmlessly everywhere (a no-op
// invoke) without every test needing its own suspend/resume stub -- and
// without setup-driver.js itself ever statically importing terminal.js
// (it doesn't; this is only reached via the runtime dynamic import).
//
// terminal.js destructures `const { invoke } = window.__TAURI__.core;` once,
// at its own (one-time, cached) import -- so a test that later reassigns
// `window.__TAURI__.core.invoke` directly would have no effect on the
// reference terminal.js already captured. Routing through a mutable
// `terminalInvokeImpl` indirection lets the one Task 13 test that needs to
// spy on real invoke calls swap the implementation after the fact.
let terminalInvokeImpl = async () => {};
globalThis.window = globalThis.window ?? { __TAURI__: { core: { invoke: (...args) => terminalInvokeImpl(...args) } } };

function fixture(id) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/setup/${id}.json`, import.meta.url)), 'utf8'));
}

// Round-3 review fix #1/#2: the real Terminal.write() parses asynchronously,
// so the driver's onData handler now needs a few microtask ticks (write's
// completion callback, then the queue's own continuation) between a
// fake.feedRaw() call and the point where scheduleIdleCheck()'s setTimeout is
// actually registered. Tests using t.mock.timers must flush those ticks
// before advancing the mocked clock, or there is no timer yet for tick() to
// find. Using only microtasks (never setTimeout) keeps this safe to call
// while setTimeout itself is mocked.
async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function makeFakeTerminal(linesPerFeed) {
  let current = [];
  return function FakeTerminal() {
    return {
      write(_bytes, cb) { if (cb) cb(); },
      buffer: { active: { baseY: 0, getLine: (r) => ({ translateToString: () => current[r] ?? '' }) } },
      __setLines(lines) { current = lines; },
    };
  };
}

function makeFakePty() {
  const writes = [];
  let dataCb = null;
  let exitResolve = null;
  const exitP = new Promise((r) => { exitResolve = r; });
  return {
    id: 'pty1',
    writes,
    async spawnPty(_cmd, _cols, _rows, onData) { dataCb = onData; return exitP.then((code) => ({ code, id: 'pty1' })); },
    input: async (d) => { writes.push(d); },
    kill: async () => { exitResolve(0); },
    feedRaw(b64) { dataCb?.(b64); },
    exit(code) { exitResolve(code); },
  };
}

test('single-flight: second concurrent startSetup rejects immediately', async () => {
  const fake = makeFakePty();
  const p1 = startSetup({ onPrompt: async () => 0 }, { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: makeFakeTerminal() });
  await Promise.resolve(); // let p1 start spawning
  await assert.rejects(
    startSetup({ onPrompt: async () => 0 }, { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: makeFakeTerminal() }),
    (err) => { assert.match(err.message, /already in progress|already running/i); return true; },
  );
  fake.exit(1); // unblock p1 so the test process can exit; p1's own assertions live in later tasks
  await p1.catch(() => {});
});

// NOTE: the plan's Task 3/4 snippets used the 'activate' fixture for these
// generic-dispatch tests. Task 6 later makes 'activate' a fixed-policy
// auto-answered prompt (never reaches onPrompt), which would silently break
// these earlier tests once Task 6 lands. Using 'credential'/'codemieUrl'
// (kind: 'input', never auto-answered by any later task) keeps these tests
// valid for the lifetime of the file, while still exercising the exact same
// dedup-guard behavior the tests are named for.
test('detecting the SAME prompt again while an answer is in-flight or already given is ignored (no second onPrompt call, no second write)', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('credential'));
  let onPromptCalls = 0;
  let resolveAnswer;
  const p = startSetup(
    { onPrompt: async () => { onPromptCalls += 1; return new Promise((r) => { resolveAnswer = r; }); } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // first redraw chunk of the 'credential' prompt: dispatches onPrompt, await pending
  await Promise.resolve();
  fake.feedRaw('BBBB'); // a second redraw chunk of the SAME still-unanswered prompt (same fixture, unchanged)
  await Promise.resolve();
  resolveAnswer('secret'); // caller finally answers
  await Promise.resolve();
  fake.feedRaw('CCCC'); // a third chunk echoing the same screen after the answer was written
  await Promise.resolve();
  fake.exit(0);
  await p.catch(() => {});
  assert.equal(onPromptCalls, 1, 'onPrompt called exactly once for this prompt occurrence');
  assert.equal(fake.writes.length, 1, 'exactly one write resulted, despite three redraw chunks');
});

test('after a prompt is answered, a genuinely new detected prompt is processed normally (guard does not freeze the driver)', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('credential'));
  const seenIds = [];
  const p = startSetup(
    { onPrompt: async (prompt) => { seenIds.push(prompt.id); return 'answer'; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // 'credential' prompt detected and answered
  // A macrotask tick (not just a microtask) lets handleDetectedPrompt's own
  // await chain (onPrompt, then the answer write) fully finish and clear the
  // CR-002 in-flight flag -- matching the real world, where the CLI can only
  // redraw the NEXT screen after the driver's write has actually landed on
  // the pty, which is always after this handling has returned.
  await new Promise((r) => { setTimeout(r, 0); });
  termInstance.__setLines(fixture('codemieUrl')); // screen has demonstrably moved on
  fake.feedRaw('BBBB');
  await Promise.resolve();
  fake.exit(0);
  await p.catch(() => {});
  assert.deepEqual(seenIds, ['credential', 'codemieUrl'], 'the new occurrence is processed, guard does not freeze the driver on the first prompt');
  assert.equal(fake.writes.length, 2, 'one write per occurrence, not zero and not more than two');
});

test('an outwardly-identical prompt re-asked after the screen has genuinely gone idle and moved on is answered again, not ignored forever (round-3 review fix #3, re-gated on idle time by round-4 review fix #1)', async () => {
  // e.g. a rejected credential: the CLI redraws an error line then re-shows
  // the SAME "Enter your API key:" text. The dedup signature is only
  // eligible to be cleared once IDLE_MS has passed with no further chunk
  // arriving (round-4 review fix #1) -- so this test must let real idle time
  // elapse before the screen changes, not merely let a microtask/macrotask
  // flush, or the signature would never become eligible to clear.
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('credential'));
  const seenCount = [];
  const p = startSetup(
    { onPrompt: async (prompt) => { seenCount.push(prompt.id); return 'secret'; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // first occurrence of 'credential', answered
  // Real idle wait past IDLE_MS (200ms): the CLI goes quiet validating the
  // credential over the network before it ever redraws again -- this is
  // exactly the gap that makes the eventual re-ask "genuine" rather than a
  // quick cosmetic redraw of the same still-open prompt.
  await new Promise((r) => { setTimeout(r, 250); });
  // Screen genuinely moves on: an intervening error/status line, not the prompt at all.
  termInstance.__setLines(['Invalid API key, please try again.'].concat(Array(29).fill('')));
  fake.feedRaw('BBBB');
  await new Promise((r) => { setTimeout(r, 0); });
  // The CLI redraws the SAME credential prompt text again -- a genuinely new occurrence.
  termInstance.__setLines(fixture('credential'));
  fake.feedRaw('CCCC');
  await new Promise((r) => { setTimeout(r, 0); });
  fake.exit(0);
  await p.catch(() => {});
  assert.deepEqual(seenCount, ['credential', 'credential'], 'the re-asked occurrence reaches onPrompt a second time, not suppressed forever');
  assert.equal(fake.writes.length, 2, 'one answer write per occurrence');
});

test('a cosmetic screen change while the same prompt is still open (quick redraw, well under IDLE_MS) is NOT treated as a re-ask (round-4 review fix #1)', async () => {
  // The reviewer's exact repro: an unrelated cosmetic status line rendered
  // above the still-open question changes the raw screen text, but arrives
  // almost immediately -- long before IDLE_MS elapses. The old rule cleared
  // the dedup signature purely because the text differed, causing a second,
  // spurious '\r' to be written for a prompt nobody meant to re-answer.
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('credential'));
  let onPromptCalls = 0;
  const p = startSetup(
    { onPrompt: async () => { onPromptCalls += 1; return 'secret'; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // 'credential' prompt detected and answered
  // A macrotask tick (not just a microtask) lets handleDetectedPrompt's own
  // await chain (onPrompt, then the answer write) fully finish and clear the
  // CR-002 in-flight flag, so the second chunk below actually exercises the
  // signature-staleness check rather than being short-circuited by the
  // still-in-flight guard.
  await new Promise((r) => { setTimeout(r, 0); });
  // Cosmetic-only change: an unrelated status line replaces an already-blank
  // decorative line, while the open question line itself is untouched --
  // detectPrompt's parsed id/message are unaffected, only the raw text differs.
  const cosmeticLines = fixture('credential');
  cosmeticLines[0] = '~~ syncing ~~';
  termInstance.__setLines(cosmeticLines);
  fake.feedRaw('BBBB'); // arrives immediately after: well under IDLE_MS since AAAA
  await Promise.resolve();
  fake.exit(0);
  await p.catch(() => {});
  assert.equal(onPromptCalls, 1, 'the still-open prompt is answered exactly once, not re-dispatched by a cosmetic redraw');
  assert.equal(fake.writes.length, 1, 'exactly one write results, not two');
});

test('onLog receives representative output once per PTY-data chunk during a run, and exactly one answer write results despite two chunks of the same fixture', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('credential'));
  const logged = [];
  const p = startSetup(
    { onPrompt: async () => true, onLog: (line) => logged.push(line) },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // one chunk
  fake.feedRaw('BBBB'); // a second chunk, same fixture/screen still seeded — a redraw of the same prompt
  fake.exit(0);
  await p;
  assert.equal(logged.length, 2, 'onLog called once per PTY-data chunk (unchanged by the dedup guard)');
  assert.ok(logged.every((l) => typeof l === 'string'), 'onLog receives decoded chunk text');
  assert.equal(fake.writes.length, 1, 'exactly one answer write: the dedup guard (Task 3) and the logging path agree');
});

test('startSetup completes normally when onLog is omitted (optional, never throws)', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('activate'));
  const p = startSetup({ onPrompt: async () => true }, // no onLog field at all
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  fake.exit(0);
  await assert.doesNotReject(p);
});

test('onLog is a bare passthrough: setup-driver.js has no command-log side-channel to route through', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../setup-driver.js', import.meta.url), 'utf8');
  assert.ok(!/command-?log/i.test(src), 'no reference to any command-log module exists for onLog output to reach');
});

test('list answer becomes exact arrow-key bytes, never option text', async () => {
  const fake = makeFakePty();
  const lines = fixture('provider');
  const term = makeFakeTerminal();
  const termInstance = term();
  termInstance.__setLines(lines);
  const { detectPrompt } = await import('../setup-parse.js');
  const { selectedIndex } = detectPrompt(lines);
  const p = startSetup(
    { onPrompt: async (prompt) => { assert.equal(prompt.id, 'provider'); return 2; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // triggers a screen read; content comes from termInstance.__setLines
  fake.exit(1); // end the run so the test can settle; profileName not asserted here
  await p.catch(() => {});
  const expected = '\x1b[B'.repeat(2 - selectedIndex) + '\r';
  assert.deepEqual(fake.writes, [expected]);
  assert.ok(!fake.writes.some((w) => /[a-zA-Z]{3,}/.test(w)), 'never writes option label text');
});

test('generic list (provider): an out-of-range onPrompt answer index rejects instead of silently confirming the highlighted option (round-3 review fix #4)', async () => {
  const fake = makeFakePty();
  const lines = fixture('provider');
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(lines);
  const p = startSetup(
    { onPrompt: async (prompt) => { assert.equal(prompt.id, 'provider'); return 99; } }, // out of range
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA');
  await assert.rejects(p, (err) => {
    assert.equal(err.step, 'provider');
    assert.ok(err.message);
    assert.ok('raw' in err);
    return true;
  });
  assert.equal(fake.writes.length, 0, 'no arrow-key/confirm write follows an invalid answer index');
});

test('generic list (provider): a non-numeric onPrompt answer index rejects instead of silently confirming the highlighted option (round-3 review fix #4)', async () => {
  const fake = makeFakePty();
  const lines = fixture('provider');
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(lines);
  const p = startSetup(
    { onPrompt: async () => undefined }, // non-numeric/missing answer
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA');
  await assert.rejects(p, (err) => {
    assert.equal(err.step, 'provider');
    assert.ok(err.message);
    return true;
  });
  assert.equal(fake.writes.length, 0);
});

// NOTE: the plan's Task 6 test used /create/i for the `gate` fixture's expected-option
// regex, but the real gate.json fixture's create-new-profile option is worded "Add a
// new profile" — it never contains the literal substring "create". /create/i can never
// match against this fixture, so the test as originally specified would fail on the
// precondition assertion regardless of driver behavior, not on the behavior being
// tested. Using /add a new profile/i here targets the same branch (create-new, never
// update) that the acceptance criteria and negative constraints describe.
for (const [id, expectRe, forbidRe] of [
  ['gate', /add a new profile/i, /update/i],
  ['storage', /global/i, /local/i],
]) {
  test(`${id} fixture is auto-answered, never calls onPrompt`, async () => {
    const fake = makeFakePty();
    const termInstance = makeFakeTerminal()();
    termInstance.__setLines(fixture(id));
    let onPromptCalled = false;
    const p = startSetup(
      { onPrompt: async () => { onPromptCalled = true; return 0; } },
      { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
    );
    fake.feedRaw('AAAA');
    fake.exit(1);
    await p.catch(() => {});
    assert.equal(onPromptCalled, false);
    assert.equal(fake.writes.length, 1);
    const { detectPrompt } = await import('../setup-parse.js');
    const { options } = detectPrompt(fixture(id));
    const chosenLabel = options.find((o) => expectRe.test(o));
    assert.ok(chosenLabel, `fixture must contain a ${expectRe} option`);
    assert.ok(!options.some((o) => forbidRe.test(o) && fake.writes[0].split('\x1b[B').length - 1 === options.indexOf(o)),
      'never selects the forbidden option');
  });
}

test('activate fixture auto-answered y\\r, no onPrompt', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('activate'));
  let called = false;
  const p = startSetup({ onPrompt: async () => { called = true; return true; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA'); fake.exit(1);
  await p.catch(() => {});
  assert.equal(called, false);
  assert.deepEqual(fake.writes, ['y\r']);
});

// installClaude is NOT fixed-policy: the story author ratified EPMCDME-14513's
// open question -- installing Claude Code is one of the guided-setup decisions,
// so the caller answers it like any other prompt. These two tests are the
// regression guard on that: re-adding installClaude to AUTO_CONFIRM makes the
// first one fail with seen.length 0.
test('installClaude is dispatched to onPrompt as a confirm, and yes writes y\\r', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('installClaude'));
  const seen = [];
  const p = startSetup({ onPrompt: async (prompt) => { seen.push(prompt); return true; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA'); fake.exit(1);
  await p.catch(() => {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 'installClaude');
  assert.equal(seen[0].kind, 'confirm');
  assert.deepEqual(fake.writes, ['y\r']);
});

test('installClaude answered no writes n\\r', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('installClaude'));
  const p = startSetup({ onPrompt: async () => false },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA'); fake.exit(1);
  await p.catch(() => {});
  assert.deepEqual(fake.writes, ['n\r']);
});

test('an answered installClaude echo is not re-dispatched as a second confirm', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('installClaude'));
  const seen = [];
  const p = startSetup({ onPrompt: async (prompt) => { seen.push(prompt); return true; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  // inquirer keeps the '?' prefix on the answered line and appends the answer,
  // so until the next screen renders this is still the last question line and
  // detectPrompt classifies it as installClaude again -- with a different
  // message, so promptSignature does not suppress it. Same shape as the round-5
  // storage defect; without the answered-once mark the confirm is written twice,
  // into a CLI that has already moved on to installing.
  termInstance.__setLines(['', '? Would you like to install Claude Code now? Yes', ...Array(28).fill('')]);
  fake.feedRaw('BBBB');
  await flushMicrotasks();
  fake.exit(0);
  await p.catch(() => {});
  assert.equal(seen.length, 1, 'installClaude must reach onPrompt exactly once');
  assert.deepEqual(fake.writes, ['y\r'], 'and must be answered exactly once');
});

test('a non-boolean confirm answer rejects instead of typing it into the CLI', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('installClaude'));
  const p = startSetup({ onPrompt: async () => 'yes' },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  const err = await p.then(() => null, (e) => e);
  assert.ok(err, 'run must reject');
  assert.equal(err.step, 'installClaude');
  assert.match(err.message, /invalid installClaude confirm answer/);
  assert.deepEqual(fake.writes, [], 'nothing may be written to the PTY');
});

// The kind:'input' counterpart of the answered-echo guard. Input prompts cannot
// join answeredOnce ('credential' is the catch-all, and a rejected credential is
// legitimately re-asked), so they are separated by shape instead: an echo is a
// strict extension of the question just answered, a re-ask is identical to it.
test('an answered input echo is not re-dispatched, and its answer is not written twice', async () => {
  const fake = makeFakePty();
  const t = makeFakeTerminal()();
  // The open form carries inquirer's default hint (setup.js:490 gives profileName
  // a default); the echo does not. The guard must anchor on the question itself.
  t.__setLines(['', '? Enter a name for this profile: (default) ', ...Array(28).fill('')]);
  const seen = [];
  const p = startSetup({ onPrompt: async (prompt) => { seen.push(prompt.id); return 'myprofile'; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => t });
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  t.__setLines(['', '? Enter a name for this profile: myprofile', ...Array(28).fill('')]);
  fake.feedRaw('BBBB');
  await flushMicrotasks();
  fake.exit(0);
  await p.catch(() => {});
  assert.deepEqual(seen, ['profileName']);
  assert.deepEqual(fake.writes, ['myprofile\r'], 'the answer must reach the CLI exactly once');
});

test('a masked credential echo is recognised too (the answer is not rendered back verbatim)', async () => {
  const fake = makeFakePty();
  const t = makeFakeTerminal()();
  t.__setLines(['', '? API key: ', ...Array(28).fill('')]);
  const seen = [];
  const p = startSetup({ onPrompt: async (prompt) => { seen.push(prompt.id); return 'sk-secret'; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => t });
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  t.__setLines(['', '? API key: ****', ...Array(28).fill('')]);
  fake.feedRaw('BBBB');
  await flushMicrotasks();
  fake.exit(0);
  await p.catch(() => {});
  assert.deepEqual(seen, ['credential']);
  assert.deepEqual(fake.writes, ['sk-secret\r']);
});

// The echo guard must not swallow a failed `validate`. inquirer redraws the
// question line with the rejected input still on it and puts the error below it
// prefixed '>> ' (vendored inquirer/lib/prompts/input.js:50, :59, :88), so the
// question line alone is indistinguishable from an echo. codemie setup really
// does validate the profile name (setup.js:491 rejects a name that already
// exists), and suppressing that screen hangs the run with the single-flight
// lock held. This walks the whole sequence: reject, re-ask, answer, echo.
test('a failed validate is re-asked, and the echo after the retry is still suppressed', async () => {
  const fake = makeFakePty();
  const t = makeFakeTerminal()();
  const answers = ['taken', 'fresh'];
  t.__setLines(['', '? Enter a name for this profile: (default) ', ...Array(28).fill('')]);
  const seen = [];
  const p = startSetup({ onPrompt: async (prompt) => { seen.push(prompt.id); return answers.shift(); } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => t });
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  // validate rejected it: same question line, rejected value still on it, error below
  t.__setLines(['', '? Enter a name for this profile: taken', '>> A profile with this name already exists', ...Array(27).fill('')]);
  fake.feedRaw('BBBB');
  await flushMicrotasks();
  // the accepted answer's echo: same shape, no error line
  t.__setLines(['', '? Enter a name for this profile: fresh', ...Array(28).fill('')]);
  fake.feedRaw('CCCC');
  await flushMicrotasks();
  fake.exit(0);
  await p.catch(() => {});
  assert.deepEqual(seen, ['profileName', 'profileName'], 'the rejection must be re-asked, the echo must not');
  assert.deepEqual(fake.writes, ['taken\r', 'fresh\r']);
});

// A password prompt's validate error lands two rows down: screen-manager.js:91
// joins question + '\n' + bottomContent, and password.js:64 starts bottomContent
// with its own '\n'. bedrock's secret prompt validates non-empty
// (bedrock.setup-steps.js:171). The empty row between must not hide the marker.
test('a password validate failure, with its blank row before the >> marker, is re-asked and not mistaken for an echo', async () => {
  const fake = makeFakePty();
  const t = makeFakeTerminal()();
  const answers = ['', 'real-secret'];
  t.__setLines(['', '? AWS Secret Access Key: ', ...Array(28).fill('')]);
  const seen = [];
  const p = startSetup({ onPrompt: async (prompt) => { seen.push(prompt.id); return answers.shift(); } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => t });
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  t.__setLines(['', '? AWS Secret Access Key: [hidden]', '', '>> Secret Access Key is required', ...Array(26).fill('')]);
  fake.feedRaw('BBBB');
  await flushMicrotasks();
  t.__setLines(['', '? AWS Secret Access Key: [hidden]', ...Array(28).fill('')]); // accepted: plain echo
  fake.feedRaw('CCCC');
  await flushMicrotasks();
  fake.exit(0);
  await p.catch(() => {});
  assert.deepEqual(seen, ['credential', 'credential']);
  assert.deepEqual(fake.writes, ['\r', 'real-secret\r']);
});

test('the guard does not suppress a DIFFERENT prompt under the credential catch-all, yet suppresses each of their echoes (bedrock asks three in a row)', async () => {
  const fake = makeFakePty();
  const t = makeFakeTerminal()();
  const pad = (rows) => [...rows, ...Array(30 - rows.length).fill('')];
  // Screens taken from the vendored sources, not from memory: the secret prompt
  // is type 'password' with no mask (bedrock.setup-steps.js:168) and no default,
  // so it opens bare and its ANSWERED echo is "[hidden]" (password.js:71-74) --
  // not "****", which is only what a masked password (litellm) renders.
  const frames = [
    ['', '? AWS Access Key ID: '],
    ['', '? AWS Access Key ID: v'],                 // echo of #1
    ['', '? AWS Access Key ID: v', '? AWS Secret Access Key: '],
    ['', '? AWS Access Key ID: v', '? AWS Secret Access Key: [hidden]'],   // unmasked password echo of #2
    ['', '? AWS Access Key ID: v', '? AWS Secret Access Key: [hidden]', '? AWS Region: (us-east-1) '],
    ['', '? AWS Access Key ID: v', '? AWS Secret Access Key: [hidden]', '? AWS Region: v'],           // echo of #3
  ];
  t.__setLines(pad(frames[0]));
  const seen = [];
  const p = startSetup({ onPrompt: async (prompt) => { seen.push(prompt.message); return 'v'; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => t });
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  for (let i = 1; i < frames.length; i += 1) {
    t.__setLines(pad(frames[i]));
    fake.feedRaw('BBBB');
    await flushMicrotasks();
  }
  fake.exit(0);
  await p.catch(() => {});
  assert.deepEqual(seen, ['AWS Access Key ID:', 'AWS Secret Access Key:', 'AWS Region: (us-east-1)'], 'three distinct prompts, each asked once');
  assert.deepEqual(fake.writes, ['v\r', 'v\r', 'v\r'], 'and each answered exactly once');
});

test('an input prompt with a default hint: the echo drops the hint and is still recognised (CodeMie URL, from the real recording)', async () => {
  const fake = makeFakePty();
  const t = makeFakeTerminal()();
  t.__setLines(['', '? CodeMie organization URL: (https://codemie.lab.epam.com) ', ...Array(28).fill('')]);
  const seen = [];
  const p = startSetup({ onPrompt: async (prompt) => { seen.push(prompt.id); return 'https://codemie.lab.epam.com'; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => t });
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  t.__setLines(['', '? CodeMie organization URL: https://codemie.lab.epam.com', ...Array(28).fill('')]);
  fake.feedRaw('BBBB');
  await flushMicrotasks();
  fake.exit(0);
  await p.catch(() => {});
  assert.deepEqual(seen, ['codemieUrl']);
  assert.deepEqual(fake.writes, ['https://codemie.lab.epam.com\r']);
});

test('model list pagination walk stops on repeat, returns to top, excludes Custom, and is never re-dispatched by its own redraws (CR-002)', async () => {
  const fake = makeFakePty();
  const term = makeFakeTerminal();
  const termInstance = term();
  const baseModel = (opts) => [
    '? Choose a model',
    ...opts.map((o, i) => `${i === 0 ? '❯ ' : '  '}${o}`),
  ].concat(Array(30).fill('')).slice(0, 30);
  const frames = [
    baseModel(['gpt-4', 'gpt-4-turbo']),
    baseModel(['gpt-4-turbo', 'gpt-4o']),
    baseModel(['gpt-4o', 'Custom']),
    baseModel(['gpt-4o', 'Custom']), // repeat: no new entries, stop here
  ];
  termInstance.__setLines(frames[0]);
  let frameIdx = 0;
  // Each arrow-key write simulates the CLI redrawing the screen -- and, per
  // the real PTY bridge, that redraw's bytes are echoed back through the
  // SAME onData callback the driver is fed with (fake.feedRaw). Before the
  // CR-002 fix, each of these redraws carries a distinct detectPrompt
  // signature (new options slice) and would re-enter handleDetectedPrompt,
  // racing a second collectModelOptions() walk against the first. Without
  // this echo, the whole bug class was structurally invisible to this test.
  const fakeInput = async (d) => {
    fake.writes.push(d);
    if (d === '\x1b[B' && frameIdx < frames.length - 1) {
      frameIdx += 1;
      termInstance.__setLines(frames[frameIdx]);
      fake.feedRaw('REDRAW');
    }
  };
  const seenOptions = [];
  let onPromptCalls = 0;
  const p = startSetup(
    // The pagination walk (multiple sequential arrow-key writes + screen re-reads) runs
    // to completion before onPrompt is ever called, so exiting the fake PTY from inside
    // onPrompt -- rather than immediately after feedRaw -- guarantees the walk's writes
    // are all recorded before we make assertions on them (avoids racing the walk against
    // the exit-code promise settling first).
    { onPrompt: async (prompt) => { onPromptCalls += 1; seenOptions.push(...prompt.options); fake.exit(1); return 0; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fakeInput, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA');
  await p.catch(() => {});
  assert.ok(!seenOptions.some((o) => /^custom/i.test(o)), 'Custom never presented as a normal option');
  assert.ok(seenOptions.includes('gpt-4o'), 'discovers options revealed by later pagination frames');
  assert.equal(onPromptCalls, 1, 'exactly one onPrompt call for the whole paginated occurrence, despite redraws echoing through onData mid-walk');
  const upCount = fake.writes.filter((w) => w === '\x1b[A').length;
  const downCount = fake.writes.filter((w) => w === '\x1b[B').length;
  assert.equal(downCount, 3, 'exactly one correct walk: 3 arrow-downs for this fixture (frames 0->1->2->3, settling on the repeat)');
  assert.equal(upCount, 3, 'returns to top by the same number of arrow-ups as arrow-downs walked');
  assert.equal(fake.writes.length, 7, '3 down + 3 up + 1 final answer write, not doubled by a concurrent second walk');
});

test('a concurrent redraw mid-handling (same prompt id, DIFFERENT options -- a different dedup signature) never starts a second onPrompt while the first is in-flight (CR-002)', async () => {
  // Unlike the existing same-signature dedup test, this redraw carries a
  // genuinely different options list -- a different JSON.stringify({id,
  // message, options}) signature -- which the OLD (options-inclusive
  // signature) dedup guard would have treated as a brand new occurrence and
  // re-dispatched. The in-flight flag guards this regardless of signature.
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  const baseList = (opts) => [
    '? Choose your LLM provider:',
    ...opts.map((o, i) => `${i === 0 ? '❯ ' : '  '}${o}`),
  ].concat(Array(30).fill('')).slice(0, 30);
  termInstance.__setLines(baseList(['openai', 'anthropic']));
  let onPromptCalls = 0;
  let resolveAnswer;
  const p = startSetup(
    { onPrompt: async () => { onPromptCalls += 1; return new Promise((r) => { resolveAnswer = r; }); } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // first 'provider' detection: dispatches, onPrompt pending
  await Promise.resolve();
  termInstance.__setLines(baseList(['openai', 'anthropic', 'ollama'])); // different options => different signature
  fake.feedRaw('BBBB'); // must be ignored: a handling is already in-flight
  await Promise.resolve();
  resolveAnswer(0);
  await Promise.resolve();
  fake.exit(1);
  await p.catch(() => {});
  assert.equal(onPromptCalls, 1, 'a differently-signatured redraw during in-flight handling must not trigger a second onPrompt');
});

test('collectModelOptions rejects with step:\'model\' if pagination never settles, instead of hanging forever (CR-001)', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  let counter = 0;
  const baseModel = (opts) => [
    '? Choose a model',
    ...opts.map((o, i) => `${i === 0 ? '❯ ' : '  '}${o}`),
  ].concat(Array(30).fill('')).slice(0, 30);
  termInstance.__setLines(baseModel(['gpt-0']));
  // The real Terminal parses write() asynchronously (round-3 review fix
  // #1/#2): the driver waits for the redraw to arrive as a NEW PTY chunk
  // after each arrow-key press, not by reading synchronously in the same
  // tick -- so this fake must echo each arrow-down back through the same
  // onData callback (fake.feedRaw), exactly like the real bridge would.
  const fakeInput = async (d) => {
    fake.writes.push(d);
    if (d === '\x1b[B') {
      counter += 1;
      termInstance.__setLines(baseModel([`gpt-${counter}`])); // always reveals a "new" option: never settles
      fake.feedRaw('REDRAW');
    }
  };
  const p = startSetup(
    { onPrompt: async () => 0 },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fakeInput, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA');
  await assert.rejects(p, (err) => {
    assert.equal(err.step, 'model');
    assert.ok(err.message);
    assert.ok(err.raw);
    return true;
  });
});

test('model: an out-of-range onPrompt answer index rejects instead of silently misnavigating the cursor (CR-003)', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  const baseModel = (opts) => [
    '? Choose a model',
    ...opts.map((o, i) => `${i === 0 ? '❯ ' : '  '}${o}`),
  ].concat(Array(30).fill('')).slice(0, 30);
  termInstance.__setLines(baseModel(['gpt-4', 'gpt-4-turbo'])); // no further pages revealed: walk settles after one step
  // The real Terminal parses write() asynchronously (round-3 review fix
  // #1/#2): the driver waits for the redraw to arrive as a NEW PTY chunk
  // after the arrow-down press, not by reading synchronously in the same
  // tick -- so this fake must echo it back through onData (fake.feedRaw),
  // exactly like the real bridge would. The redrawn screen reveals no new
  // option, so the walk settles after this one step, as before.
  const fakeInput = async (d) => {
    fake.writes.push(d);
    if (d === '\x1b[B') fake.feedRaw('REDRAW');
  };
  const p = startSetup(
    { onPrompt: async () => 99 }, // out of range for this 2-option filtered list
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fakeInput, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA');
  await assert.rejects(p, (err) => {
    assert.equal(err.step, 'model');
    assert.ok(err.message);
    assert.ok(err.raw);
    return true;
  });
  // Only the pagination walk's own down+up writes must have happened; the
  // invalid answer must never be translated into a confirming arrow-key/\r write.
  assert.equal(fake.writes.length, 2, 'no confirm write follows an invalid answer index');
});

for (const id of ['customModel', 'modelManual']) {
  test(`${id} fixture rejects with step:'model', never calls onPrompt`, async () => {
    const fake = makeFakePty();
    const termInstance = makeFakeTerminal()();
    termInstance.__setLines(fixture(id));
    let called = false;
    const p = startSetup({ onPrompt: async () => { called = true; return 'x'; } },
      { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
    fake.feedRaw('AAAA');
    await assert.rejects(p, (err) => { assert.equal(err.step, 'model'); assert.ok(err.message); assert.ok(err.raw); return true; });
    assert.equal(called, false);
    assert.equal(fake.writes.length, 0);
  });
}

for (const id of ['codemieUrl', 'credential']) {
  test(`${id} fixture: onPrompt called with kind 'input' and this id; answer text + \\r written, not arrow keys`, async () => {
    const fake = makeFakePty();
    const termInstance = makeFakeTerminal()();
    termInstance.__setLines(fixture(id));
    let seenPrompt = null;
    const p = startSetup(
      { onPrompt: async (prompt) => { seenPrompt = prompt; return 'answer-value'; } },
      { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
    );
    fake.feedRaw('AAAA');
    fake.exit(1); // end the run once the answer is written; exit code irrelevant to this assertion
    await p.catch(() => {});
    assert.equal(seenPrompt?.kind, 'input');
    assert.equal(seenPrompt?.id, id);
    assert.deepEqual(fake.writes, ['answer-value\r']);
    assert.ok(!fake.writes.some((w) => w.includes('\x1b[')), 'writes answer text, never arrow-key bytes');
  });
}

test('analyticsSync fixture (detectPrompt null, (y/N) hint, screen goes idle): auto-answers n\\r after the idle window, continues, does not hang', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  const analyticsLines = fixture('analyticsSync');
  termInstance.__setLines(analyticsLines);
  const { detectPrompt } = await import('../setup-parse.js');
  assert.equal(detectPrompt(analyticsLines), null, 'precondition: detectPrompt returns null for this fixture');
  let onPromptCalled = false;
  const p = startSetup(
    { onPrompt: async () => { onPromptCalled = true; return 0; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // one write, then the CLI goes quiet waiting for input
  await flushMicrotasks(); // let the async write-then-parse register scheduleIdleCheck()'s timer
  await t.mock.timers.tick(200); // idle window elapses with no further data
  assert.ok(fake.writes.includes('n\r'), 'auto-answers the (y/N) hint with n once the screen is confirmed idle');
  assert.equal(onPromptCalled, false);
  fake.exit(0);
  const result = await p;
  assert.ok(result); // run continued to completion, did not reject or hang
});

test('analyticsSync fallback does not fire while more data is still arriving (timer reset on each write)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('analyticsSync'));
  const p = startSetup({ onPrompt: async () => 0 },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  await t.mock.timers.tick(150); // under the 200ms threshold
  fake.feedRaw('BBBB'); // more data arrives: resets the idle window
  await flushMicrotasks();
  await t.mock.timers.tick(150); // still under 200ms since the reset
  assert.ok(!fake.writes.includes('n\r'), 'fallback has not fired yet: window was reset by new data');
  await t.mock.timers.tick(200); // now let it settle
  assert.ok(fake.writes.includes('n\r'));
  fake.exit(0);
  await p.catch(() => {});
});

test('idle timer rejects a genuinely unclassified prompt (no anchor match, no (y/N) hint) instead of hanging forever (CR-004)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  // No named anchor matches, no ':' (so the credential catch-all also refuses
  // it), and no trailing (y/N)/(Y/n) hint -- genuinely unclassified.
  const unclassifiedLines = ['? Some brand-new CLI question'].concat(Array(29).fill(''));
  termInstance.__setLines(unclassifiedLines);
  const { detectPrompt } = await import('../setup-parse.js');
  assert.equal(detectPrompt(unclassifiedLines), null, 'precondition: genuinely unclassified, not just a (y/N) case');
  let onPromptCalled = false;
  const p = startSetup(
    { onPrompt: async () => { onPromptCalled = true; return 0; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  await t.mock.timers.tick(200);
  await assert.rejects(p, (err) => {
    assert.equal(err.step, null);
    assert.ok(err.message);
    assert.ok(err.raw);
    return true;
  });
  assert.equal(onPromptCalled, false, 'must reject, never guess an answer for an unclassified prompt');
});

test('idle timer does NOT reject when detectPrompt is null but no question line is on screen at all -- CLI is mid-work, not stalled (round-2 regression fix)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  // Simulates the real happy-path regression: a settled screen showing a completed
  // step ('✔' prefix, not '?') followed by an in-progress status line, with nothing
  // else arriving for longer than IDLE_MS while the CLI does a real network call.
  // No line starts with '?' -- there is no question on screen at all.
  const midWorkLines = [
    '✔ Choose your LLM provider: CodeMie SSO',
    'Fetching projects...',
  ].concat(Array(28).fill(''));
  termInstance.__setLines(midWorkLines);
  const { detectPrompt } = await import('../setup-parse.js');
  assert.equal(detectPrompt(midWorkLines), null, 'precondition: no classified prompt on this screen');
  let onPromptCalled = false;
  const p = startSetup(
    { onPrompt: async () => { onPromptCalled = true; return 0; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  await t.mock.timers.tick(200); // idle window elapses with no further data
  assert.equal(fake.writes.length, 0, 'must not auto-answer a screen with no question line');
  assert.equal(onPromptCalled, false, 'must not call onPrompt either');
  // The run must still be pending, not rejected -- prove it by now delivering the
  // next real prompt and letting the run complete normally.
  termInstance.__setLines(fixture('activate'));
  fake.feedRaw('BBBB');
  await flushMicrotasks();
  fake.exit(0);
  const result = await p;
  assert.ok(result, 'run continued to completion after the mid-work idle window; was never rejected');
});

test('idle timer rejects an unclassified prompt that DOES have a question line, non-(y/N) (real stall, still works after the round-2 fix)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  const unclassifiedLines = ['? Some brand-new CLI question'].concat(Array(29).fill(''));
  termInstance.__setLines(unclassifiedLines);
  const { detectPrompt } = await import('../setup-parse.js');
  assert.equal(detectPrompt(unclassifiedLines), null, 'precondition: genuinely unclassified');
  let onPromptCalled = false;
  const p = startSetup(
    { onPrompt: async () => { onPromptCalled = true; return 0; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  await t.mock.timers.tick(200);
  await assert.rejects(p, (err) => {
    assert.equal(err.step, null);
    assert.ok(err.message);
    assert.ok(err.raw);
    return true;
  });
  assert.equal(onPromptCalled, false);
});

test('idle auto-answer write rejecting is caught and turned into a startSetup rejection, not left unhandled (additional fix)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('analyticsSync'));
  const failingInput = async (d) => {
    if (d === 'n\r') throw new Error('pty write failed');
    fake.writes.push(d);
  };
  const p = startSetup(
    { onPrompt: async () => 0 },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: failingInput, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA');
  await flushMicrotasks();
  await t.mock.timers.tick(200);
  await assert.rejects(p, (err) => {
    assert.match(err.message, /pty write failed/);
    assert.ok('raw' in err);
    return true;
  });
});

test('spawn_pty rejection surfaces as a normal startSetup rejection, distinct from single-flight', async () => {
  const failingSpawn = async () => { throw new Error('PTY already active'); };
  await assert.rejects(
    startSetup({ onPrompt: async () => 0 }, { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: failingSpawn, input: async () => {}, kill: async () => {}, Terminal: makeFakeTerminal() }),
    (err) => {
      assert.match(err.message, /PTY already active/);
      assert.ok(!/already in progress/i.test(err.message), 'must not be conflated with the single-flight message');
      return true;
    },
  );
});

test('data arriving after startSetup has settled is ignored: no further onPrompt calls or writes', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('activate'));
  let onPromptCalls = 0;
  let dataCb;
  const spawnCapture = async (_cmd, _cols, _rows, onData) => { dataCb = onData; return fake.spawnPty('codemie setup --force', 100, 30, onData); };
  const p = startSetup({ onPrompt: async () => { onPromptCalls += 1; return true; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: spawnCapture, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  fake.exit(0);
  await p; // settled
  const callsBeforeLateData = onPromptCalls;
  const writesBeforeLateData = fake.writes.length;
  // Late/spurious data event arriving after the promise has already settled — must be a no-op,
  // not merely "harmless" — this is the driver's own observable behavior, since by this point
  // there is no id on what it receives to filter against (the bridge already demuxed that).
  dataCb?.('AAAA');
  await Promise.resolve();
  assert.equal(onPromptCalls, callsBeforeLateData, 'no further onPrompt calls after settlement');
  assert.equal(fake.writes.length, writesBeforeLateData, 'no further writes after settlement');
});

test('retry after rejection: second startSetup waits for prior exit before respawning', async () => {
  const fake1 = makeFakePty();
  const termInstance1 = makeFakeTerminal()();
  termInstance1.__setLines(fixture('customModel')); // triggers immediate rejection with step:'model'
  let killCalled = false;
  const kill1 = async () => { killCalled = true; await fake1.kill(); };
  const p1 = startSetup({ onPrompt: async () => 0 },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake1.spawnPty, input: fake1.input, kill: kill1, Terminal: () => termInstance1 });
  fake1.feedRaw('AAAA');
  await assert.rejects(p1);
  // p1's fake pty never explicitly exited (rejection came from the customModel
  // handler, not from a real exit code) -- startSetup must have force-killed
  // it and awaited that exit before its own promise settled, not merely
  // released the single-flight lock optimistically.
  assert.equal(killCalled, true, 'startSetup force-kills a child that has not reported its own exit');
  let secondSpawned = false;
  const fake2 = makeFakePty();
  const termInstance2 = makeFakeTerminal()();
  termInstance2.__setLines(fixture('activate'));
  const spawn2 = async (...args) => { secondSpawned = true; return fake2.spawnPty(...args); };
  const p2 = startSetup({ onPrompt: async () => true },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: spawn2, input: fake2.input, kill: fake2.kill, Terminal: () => termInstance2 });
  fake2.feedRaw('AAAA');
  fake2.exit(0);
  await p2;
  assert.ok(secondSpawned, 'second run spawns only after the first run fully settled');
});

test('resumePtyInput() still runs even when kill() rejects during exit cleanup (CR-005)', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('customModel')); // rejects immediately with step:'model'; pty never exits on its own
  let resumeCalled = false;
  const failingKill = async () => { throw new Error('pty_kill failed'); };
  const p = startSetup(
    { onPrompt: async () => 0 },
    { suspendPtyInput: () => {}, resumePtyInput: () => { resumeCalled = true; }, spawnPty: fake.spawnPty, input: fake.input, kill: failingKill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA');
  await assert.rejects(p); // rejects with either the model-step error or the kill failure -- both are acceptable here
  assert.equal(resumeCalled, true, 'resumePtyInput must run even though kill() rejected during exit cleanup');
});

test('successful full run resolves { profileName } on zero exit', async () => {
  const fake = makeFakePty();
  const term = makeFakeTerminal();
  const termInstance = term();
  termInstance.__setLines(fixture('profileName'));
  const p = startSetup({ onPrompt: async (prompt) => (prompt.id === 'profileName' ? 'my-profile' : 0) },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  fake.exit(0);
  const result = await p;
  assert.deepEqual(result, { profileName: 'my-profile' });
});

test('non-zero exit rejects with { step, message, raw }', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('gate'));
  const p = startSetup({ onPrompt: async () => 0 },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  fake.exit(1);
  await assert.rejects(p, (err) => { assert.ok('step' in err); assert.ok(err.message); assert.ok('raw' in err); return true; });
});

test('replay parameter accepted and is a documented no-op', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('activate'));
  const p = startSetup({ onPrompt: async () => true, replay: [{ some: 'frame' }] },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  fake.exit(0);
  await p; // no throw, no different behavior than the no-replay activate case in Task 6
});

test('ui/terminal.js onData forwarding is suspended for the run duration and restored after, via default deps', async () => {
  // NOTE: the plan's literal test reassigned window.__TAURI__.core.invoke directly after
  // terminal.js had already been imported (via the top-of-file stub). terminal.js
  // destructures `const { invoke } = window.__TAURI__.core` once, at its own one-time
  // (cached) import, so that later reassignment has no effect on the reference it already
  // captured -- both assertions in this test would pass/fail independent of the driver's
  // actual behavior. Routing through the file-level `terminalInvokeImpl` indirection (see
  // top of file) makes the spy actually observe calls made through the real captured invoke.
  const { suspendPtyInput, resumePtyInput, __forwardOnData } = await import('../terminal.js');
  resumePtyInput(); // ensure baseline
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('activate'));
  // deps deliberately omit suspendPtyInput/resumePtyInput so the driver's lazy default
  // (real ./terminal.js exports) is exercised, proving the DI wiring end-to-end.
  const p = startSetup({ onPrompt: async () => true },
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  // Resolving deps.suspendPtyInput/resumePtyInput here goes through the real
  // (lazy, dynamic-import) default path -- unlike every other test in this file,
  // which provides no-op stubs and so never awaits that import. A macrotask tick
  // lets that import (and the suspendPtyInput() call after it) actually land
  // before we assert on the suspended state, rather than racing it.
  await new Promise((r) => { setTimeout(r, 0); });
  fake.feedRaw('AAAA');
  // While the run is in flight, forwarding must be suspended.
  const calls = [];
  terminalInvokeImpl = (...a) => { calls.push(a); return Promise.resolve(); };
  __forwardOnData('x');
  assert.equal(calls.length, 0, 'forwarding suspended during the run');
  fake.exit(0);
  await p;
  __forwardOnData('y');
  assert.equal(calls.length, 1, 'forwarding restored after the run settles');
});

// Round-3 review fix #6: the fake Terminal's __setLines() sets the screen
// buffer directly, bypassing write() entirely -- no test above ever
// exercises the real write-then-parse-then-read contract. These two tests
// inject the REAL Terminal from ui/vendor/xterm.mjs instead, fed real
// base64-encoded PTY chunks (matching runner-bridge.js's engine:pty-data
// shape, which setup-driver.js's own decode() reverses via atob()).
function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

test('REAL Terminal: a prompt arriving in the LAST chunk before the CLI goes quiet is dispatched, not missed (round-3 review fix #1)', async () => {
  const { Terminal } = await import('../vendor/xterm.mjs');
  const fake = makeFakePty();
  let seenPrompt = null;
  const p = startSetup(
    { onPrompt: async (prompt) => { seenPrompt = prompt; return 'my-secret-key'; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal },
  );
  fake.feedRaw(b64('Some intro banner text\r\n\r\n'));
  // The complete prompt text arrives in THIS chunk, which is also the LAST
  // chunk the CLI ever sends before going quiet -- no further onData call
  // follows. Before the fix, the real Terminal's write() parses
  // asynchronously, so reading the screen synchronously right after write()
  // always observed the buffer as it was BEFORE this chunk was parsed:
  // detectPrompt() would see nothing, dispatch would never fire, and by the
  // time the idle timer looked later the (by-then-parsed) screen WOULD show
  // a classified prompt -- which the idle timer deliberately ignores,
  // assuming it's already being handled. Net result: a permanent hang. This
  // test proves the fix by requiring onPrompt to be called well within one
  // IDLE_MS window, not via that idle-timer fallback.
  fake.feedRaw(b64('? API key:'));
  const deadline = Date.now() + 2000;
  while (!seenPrompt && Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 5); });
  }
  assert.ok(seenPrompt, 'onPrompt was called -- the run did not hang on the last-chunk prompt');
  assert.equal(seenPrompt.id, 'credential');
  fake.exit(0);
  await p;
  assert.deepEqual(fake.writes, ['my-secret-key\r']);
});

test('REAL Terminal: a model-list pagination walk over a realistic fixed-size viewport page reaches every entry, not just the first page (round-3 review fix #2, corrected for a real page-boundary by round-4 review fix #2)', async () => {
  // The round-3 version of this test paged unrealistically: it revealed a
  // brand-new option on literally EVERY single arrow-down press (a 2-entry
  // "page" that always scrolled), which passed even with the old "stop when
  // no new option appears" termination rule -- masking the real bug. A real
  // inquirer list instead renders a FIXED-SIZE viewport page and only starts
  // scrolling once the cursor reaches the bottom of it: the reviewer's own
  // repro (a 40-entry catalog through a ~15-row viewport) saw the first ~14
  // arrow-down presses reveal ZERO new options, which the old rule mistook
  // for "the list has only one entry" and stopped the walk after one step.
  const { Terminal } = await import('../vendor/xterm.mjs');
  const fake = makeFakePty();
  const PAGE_SIZE = 15;
  const CATALOG = Array.from({ length: 40 }, (_, i) => `model-${String(i + 1).padStart(2, '0')}`);
  // Mirrors a real inquirer list's own pagination: the page only scrolls once
  // the cursor would otherwise fall off the bottom of the currently-rendered
  // window, and never scrolls back past the start.
  function renderPage(cursorIndex) {
    const maxStart = CATALOG.length - PAGE_SIZE;
    const start = Math.max(0, Math.min(cursorIndex - PAGE_SIZE + 1, maxStart));
    const visible = CATALOG.slice(start, start + PAGE_SIZE);
    const cursorInPage = cursorIndex - start;
    const body = visible.map((o, i) => `${i === cursorInPage ? '❯ ' : '  '}${o}`).join('\r\n');
    return `\x1b[2J\x1b[H? Choose a model\r\n${body}\r\n`;
  }
  let cursorIndex = 0;
  const fakeInput = async (d) => {
    fake.writes.push(d);
    if (d === '\x1b[B') {
      // A real list pins the cursor at the last entry rather than wrapping.
      cursorIndex = Math.min(cursorIndex + 1, CATALOG.length - 1);
      // Real PTY bridge behavior: the CLI's redrawn output after an
      // arrow-key press arrives as a NEW, separate onData chunk -- sent even
      // when the redraw is a no-op (cursor already pinned at the bottom),
      // exactly like a real CLI still redrawing an unchanged screen.
      fake.feedRaw(b64(renderPage(cursorIndex)));
    }
  };
  let seenOptions = null;
  const p = startSetup(
    { onPrompt: async (prompt) => { seenOptions = prompt.options; fake.exit(1); return 0; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fakeInput, kill: fake.kill, Terminal },
  );
  fake.feedRaw(b64(renderPage(0)));
  await p.catch(() => {});
  assert.ok(seenOptions, 'onPrompt was called with the collected model options');
  assert.equal(seenOptions.length, CATALOG.length, 'the full 40-entry catalog is collected, not just the first visible page');
  for (const model of CATALOG) {
    assert.ok(seenOptions.includes(model), `${model} is discovered even though it is never visible on the first ~14-entry page`);
  }
  assert.ok(!seenOptions.some((o) => /^custom/i.test(o)), 'Custom never presented as a normal option');
});

test('REAL Terminal: the answered storage line, wrapped at COLS, is not re-dispatched as a fresh storage prompt (round-5 fix)', async () => {
  // Measured against the real codemie CLI 0.14.1. After the driver answers the
  // storage prompt, the CLI redraws that line with the answer appended:
  //
  //   ? Where would you like to store this configuration? Global (~/.codemie/) - Available across all repositories
  //
  // That is 108 characters, so at the driver's COLS=100 the real Terminal wraps
  // it and the tail lands on its own row. The line still starts with '?', so
  // until the NEXT prompt renders it is the last question line on screen and
  // detectPrompt classifies it as `storage` again -- which is all the parser's
  // contract promises. Its message and options both differ from the open form,
  // so promptSignature does not suppress it, and before the fix
  // pickAutoListIndex found no /global/i match in the wrapped tail and rejected
  // the entire run with { step: null, message: 'expected auto-answer option not
  // found' } before onPrompt had been called even once. Guided setup died on its
  // very first step on every machine.
  const { Terminal } = await import('../vendor/xterm.mjs');
  const ESC = String.fromCharCode(27);
  const CLEAR = ESC + '[2J' + ESC + '[H';
  const fake = makeFakePty();
  const seen = [];
  const p = startSetup(
    { onPrompt: async (prompt) => { seen.push(prompt.id); return 0; } },
    { suspendPtyInput: () => {}, resumePtyInput: () => {}, spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal },
  );

  // 1. the OPEN storage prompt -- auto-answered, never surfaced to onPrompt
  fake.feedRaw(b64(
    '? Where would you like to store this configuration? (Use arrow keys)\r\n' +
    '❯ Global (~/.codemie/) - Available across all repositories \r\n' +
    '  Local (.codemie/) - Only for this repository \r\n'
  ));
  const answered = Date.now() + 2000;
  while (fake.writes.length === 0 && Date.now() < answered) {
    await new Promise((r) => { setTimeout(r, 5); });
  }
  assert.deepEqual(fake.writes, ['\r'], 'storage auto-answered with Enter (cursor already on Global)');

  // 2. the ANSWERED echo of that same line, long enough to wrap at COLS=100
  fake.feedRaw(b64(
    CLEAR +
    '? Where would you like to store this configuration? Global (~/.codemie/) - Available across all repositories\r\n'
  ));
  await new Promise((r) => { setTimeout(r, 60); });

  // 3. the real next prompt
  fake.feedRaw(b64(
    CLEAR +
    '? Choose your LLM provider:\r\n' +
    '❯ CodeMie SSO - Enterprise SSO Authentication\r\n' +
    '  LiteLLM - Universal gateway to 100+ LLM providers \r\n'
  ));
  const deadline = Date.now() + 2000;
  while (seen.length === 0 && Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 5); });
  }
  assert.deepEqual(seen, ['provider'], 'the run survived the answered-storage echo and reached the next prompt');
  fake.exit(0);
  await p;
});
