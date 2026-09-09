# Guided Setup Driver (EPMCDME-14668) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `ui/setup-driver.js`, a headless testable driver that runs `codemie setup --force` in a PTY, drives it through `ui/setup-parse.js`'s `detectPrompt`, calls `onPrompt` for real prompts, auto-answers fixed-policy prompts, and resolves/rejects per the ticket's contract.

**Architecture:** New ESM module `ui/setup-driver.js` owns a module-level single-flight lock, constructs a headless `xterm.mjs` `Terminal` to turn PTY byte output into screen-line arrays, feeds those to `detectPrompt`, and drives an injected PTY bridge (defaulting to `ui/runner-bridge.js`'s `pty` export) by writing translated bytes back. `ui/terminal.js` gets a narrowly scoped edit to make its existing `onData` -> `pty_input` forwarding suspendable; `setup-driver.js` consumes `suspendPtyInput`/`resumePtyInput` as **injected deps**, defaulting to `ui/terminal.js`'s real exports via the same lazy `import()` pattern used for the PTY bridge — never a static top-level import, since `terminal.js` reads `window.__TAURI__` at module scope and `setup-driver.test.mjs` never stubs `window`.

**Tech Stack:** Plain ESM (no bundler), `node:test` + `node:assert/strict`, existing `ui/vendor/xterm.mjs` headless `Terminal`, existing `ui/test/fixtures/setup/*.json` fixtures.

**Spec:** Requirements supplied inline by the caller (no `spec.md` for this task) — reproduced in Acceptance Criteria below. Technical analysis: `docs/superpowers/tasks/2026-09-08-epmcdme-14668-guided-setup-driver/technical-analysis.md`.

**Revision note (round 2):** This revision fixes six problems found in round-1 review: (1) Task 12 (formerly Task 10) no longer statically imports `./terminal.js` — it injects `suspendPtyInput`/`resumePtyInput` as deps, lazily defaulted, same as the PTY bridge; (2) Task 11's (formerly Task 9) stale-id test is replaced with a real, driver-observable assertion (late data after settlement is a no-op); (3) Task 4's (formerly Task 3) dead `require`-referencing line is removed; (4) a new Task 3 implements and tests `onLog`; (5) a new Task 8 makes all `kind: 'input'` prompts (`codemieUrl`, `credential`, `profileName`) go through one uniform code path; (6) Task 9 (formerly Task 7) now defines a concrete idle-timer settle-detection mechanism for the `(y/N)`-fallback. Everything else — DI shape, model-list pagination/index-mapping (Task 6), auto-answered prompts (Task 5), free-text rejects (Task 7), the single-PTY-slot reality, and the DoD/mutation-check task — is unchanged from round 1.

**Revision note (round 3):** Fixes one bug found by inspecting round-2's task-by-task logic: every task described the per-chunk loop as "on detecting prompt X, write the answer" with no guard against re-detecting the SAME prompt occurrence more than once. Inquirer redraws a single prompt across several PTY-data chunks before it is answered, and the driver's `await onPrompt(prompt)` can still be pending when another redraw chunk of the same unanswered prompt (or an echo of what was already typed) arrives — without a guard this calls `onPrompt` a second time and/or writes the answer twice. This revision inserts a new **Task 3** (single-occurrence dedup guard, depended on by every prompt-answering task from Task 4 onward) and renumbers every subsequent task by +1 (old Task 3–13 are now Task 4–14; no other task's logic, tests, or scope changed). It also tightens the (renumbered) Task 4 `onLog` test to assert on `writes`, not just on `onLog`'s own call count — that test already feeds two chunks with the same fixture seeded on both, so it is the one that would have caught this bug had it asserted writes.

## Global Constraints

- Do not modify `ui/setup-parse.js` or its fixtures, or add the analyticsSync prompt to its table.
- No UI rendering (`setup-view` is EPMCDME-14513, out of scope).
- `replay` parameter is accepted and is a documented no-op (EPMCDME-14656 implements it later).
- Only `ui/terminal.js` may be touched outside `setup-driver.js`/its test, and only to add suspend/restore of `onData` forwarding — no other behavior change there.
- Driver's `onLog` must never feed any existing command-log recording.
- No Rust changes (`pty.rs` already guards the single PTY slot).
- `setup-driver.js` must never statically top-level-import anything that touches `window`/Tauri globals at module scope (`./terminal.js`, `./runner-bridge.js`, `./vendor/xterm.mjs`) — all such dependencies are injected `deps` fields, lazily defaulted via dynamic `import()` inside the function body. `setup-driver.test.mjs` never stubs `window`, so any static top-level import of one of these breaks every test in the file at import time, not just the test exercising that dependency.
- The driver must never call `onPrompt` a second time, or write an answer a second time, for the same detected prompt occurrence re-surfacing across multiple PTY redraw chunks.
- Commit per task using the repository's existing convention (see `.ai-run/guides/standards/git-workflow.md`).

---

## Acceptance criteria

- [ ] `startSetup({ onPrompt, onLog, replay })` resolves `{ profileName }` on a zero exit, rejects `{ step, message, raw }` on failure; `replay` is accepted and ignored.
- [ ] `gate`, `activate`, `installClaude` prompts are answered automatically (create-new-profile branch, `y`, `n` respectively) and never reach `onPrompt`.
- [ ] `storage` is answered `global` automatically, never `local`, never reaches `onPrompt`.
- [ ] The `model` list is paginated by the driver (arrow-down until no new options, arrow-up back to top, then arrow-down to the caller's chosen index); the `Custom` row is excluded from `onPrompt`'s `options`.
- [ ] `customModel` / `modelManual` prompts immediately reject `startSetup` with `{ step: 'model', message, raw }` and never call `onPrompt`.
- [ ] All `kind: 'input'` prompts (`codemieUrl`, `credential`, `profileName`) go through one uniform code path: call `onPrompt`, write the returned string + `\r`.
- [ ] `onLog(line)` is called once per PTY data write-and-reparse cycle when provided, is optional (omission never throws), and never routes through any existing command-log mechanism.
- [ ] The driver detects and ignores re-detections of the SAME prompt occurrence across multiple PTY redraw chunks — no second `onPrompt` call, no second write — and only becomes eligible for the next prompt once the screen has demonstrably moved on to a different occurrence.
- [ ] A settled screen that `detectPrompt` returns `null` for but that ends in a `(y/N)`/`(Y/n)`-style hint is auto-answered `n\r` without calling `onPrompt` and without hanging (covers `analyticsSync`), via a concrete idle-timer settle-detection mechanism.
- [ ] A module-level single-flight lock rejects a second concurrent `startSetup()` call with a distinct error; a `spawn_pty` "PTY already active" rejection surfaces as a normal `startSetup` rejection.
- [ ] Incoming `engine:pty-data`/`engine:pty-exit` events are filtered by this run's own spawn correlation id; late/stale data arriving after a run has settled causes no further `onPrompt` calls or state changes.
- [ ] A fresh `startSetup()` call after a rejection/exit confirms (or forces, via `kill` + awaited exit) the previous child has exited before spawning again.
- [ ] `ui/terminal.js` exports functions to suspend/restore its `onData` -> `pty_input` forwarding; the driver suspends it for the run's duration and restores it in all exit paths (success or rejection), consumed as an injected, lazily-defaulted dep — never a static import.
- [ ] `startSetup` accepts an optional second argument for injected PTY functions, terminal-suspend functions, and the `Terminal` constructor, defaulting to `ui/runner-bridge.js`'s `pty` export, `ui/terminal.js`'s suspend/resume exports, and `ui/vendor/xterm.mjs`'s `Terminal`, with no other new module importing `pty` functions or `engine:pty-*` listeners.
- [ ] `ui/test/setup-driver.test.mjs` and a small `ui/terminal.js` suspend/restore test exist and pass via `node --test`.

## Negative constraints

- Never write list-option text as PTY input for a `list` prompt — only arrow-key bytes + `\r` (contract, req. 1). Honored by Task 5 (arrow-key-only translation, asserted by exact-bytes test).
- Never surface `gate`'s "Update an existing profile" branch — always take "create new" (req. 2). Honored by Task 6 (`gate` fixture test asserts create-new path, never calls `onPrompt`).
- Never make `storage`'s `local` option selectable/reachable (req. 3). Honored by Task 6 (asserts only `global` bytes written).
- Never present the `Custom` row as a normal `model` option via `onPrompt` (req. 4). Honored by Task 7 (windowing test asserts Custom excluded from `options`).
- Never call `onPrompt` for `customModel`/`modelManual` — always reject instead (req. 5). Honored by Task 8.
- Never special-case only `profileName` among `kind: 'input'` prompts — `codemieUrl`/`credential` must not be silently unhandled. Honored by Task 9 (uniform input-kind dispatch, tested against all three ids).
- Never modify `ui/setup-parse.js` to recognize the analytics-sync prompt (req. 6, non-goal). Honored throughout — no task touches that file.
- Never use the `(y/N)`-fallback auto-answer to answer `credential`, `model`, or any other classified prompt — it must only fire when `detectPrompt` returned `null` on a screen confirmed settled by the idle timer (req. 6). Honored by Task 10 (fallback check gated strictly on `null` result plus idle-timer settlement).
- Never let the `(y/N)`-fallback's idle timer fire mid-redraw, and never let it stall a real run indefinitely — the debounce duration is a stated, deliberate choice (req. 6). Honored by Task 10.
- Never conflate the driver's own single-flight rejection with a `spawn_pty` "PTY already active" rejection — distinct error shapes (req. 7). Honored by Task 11.
- Never let `pty_input`/`pty_kill` calls, or incoming events, cross between an old (killed/exited) run and a new run — correlation-id filtering, not just optimistic ordering; late data after settlement must be a verified no-op, not an untested assumption (req. 8, 9). Honored by Tasks 2 and 12.
- Never leave `onData` forwarding suspended after a run settles, including on rejection — restore must happen in a `finally`-equivalent path, and the suspend/resume functions must be consumed as injected, lazily-defaulted deps rather than a static top-level import that would break every test in the file (req. 10). Honored by Task 13.
- Never route driver `onLog` output into the existing command-log recording — `onLog`'s only effect is calling the caller's own callback (contract). Honored by Task 4 (`onLog` is a bare passthrough with no logging side-channel, asserted by a positive delivery test and a no-other-side-effect test).
- Never call `onPrompt` a second time, or write a second answer, for a prompt occurrence that Inquirer has merely redrawn across another PTY-data chunk — the driver only advances to a new occurrence once the screen has demonstrably changed (round-3 fix). Honored by Task 3 (single-occurrence dedup guard, tested with an async-resolving `onPrompt` across three redraw chunks of the same fixture, plus a positive case proving a genuinely new prompt is still processed) and by Task 4's tightened `onLog` test (asserts exactly one write despite two chunks of the same fixture, not just the `onLog` call count).
- Never import `pty` functions, terminal-suspend functions, or listen to `engine:pty-*` from any module other than `setup-driver.js` (req. 12, non-goal). Honored throughout — no other module is touched except `terminal.js`'s scoped suspend/restore export, and `setup-driver.js` only ever reaches those via injected/lazily-defaulted deps.
- negative-constraints: all addressed above — none stated in the requirements that aren't covered by a task.

---

### Task 1: `ui/terminal.js` — suspendable `onData` forwarding

**Files:**
- Modify: `ui/terminal.js:39-40` (keep the `onData` disposable; route forwarding through a settable flag)
- Test: `ui/test/terminal-suspend.test.mjs` (new)

**Interfaces:**
- Produces: `suspendPtyInput()` / `resumePtyInput()`, exported from `ui/terminal.js`. While suspended, keystrokes from `term.onData` must not call the injected/real `pty_input` invoke.
- `ui/terminal.js` has no existing test coverage and imports `window.__TAURI__.core.invoke` at module top (`ui/terminal.js:6`) — the test must stub `window.__TAURI__` before importing the module, following the pattern in `ui/test/pty-bridge.test.mjs`.

Since `ui/terminal.js`'s `initTerminal` requires a real DOM host element (`term.open(hostEl)`) that isn't available under `node:test`, this task tests only the forwarding-suspension logic in isolation: extract the forwarding decision into a small exported helper pair (`suspendPtyInput`/`resumePtyInput`) backed by a module-level boolean, and have the `onData` callback consult it before calling `invoke`. The test constructs the same `onData` callback logic directly (by importing the module and invoking its exported test seam) rather than mounting a real terminal.

- [ ] **Step 1: Write the failing test**

```js
// ui/test/terminal-suspend.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
globalThis.window = { __TAURI__: { core: { invoke: (...a) => { calls.push(a); return Promise.resolve(); } } } };

const { suspendPtyInput, resumePtyInput, __forwardOnData } = await import('../terminal.js');

test('onData forwarding is suspended and restored', () => {
  __forwardOnData('a');
  assert.equal(calls.length, 1, 'forwards while active');
  suspendPtyInput();
  __forwardOnData('b');
  assert.equal(calls.length, 1, 'suspended: no new invoke call');
  resumePtyInput();
  __forwardOnData('c');
  assert.equal(calls.length, 2, 'resumed: forwards again');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/terminal-suspend.test.mjs`
Expected: FAIL — `suspendPtyInput`/`resumePtyInput`/`__forwardOnData` are not exported yet.

- [ ] **Step 3: Implement the suspend/restore seam**

In `ui/terminal.js`, replace line 40 (`term.onData((d) => invoke('pty_input', { data: d }));`) with a module-level `let ptyInputSuspended = false;`, an exported `__forwardOnData(d)` that calls `invoke('pty_input', { data: d })` only when `!ptyInputSuspended`, and wire `term.onData(__forwardOnData)` (still discarding the disposable — out of scope to change further). Export `suspendPtyInput` / `resumePtyInput` that set the flag.

```js
export function suspendPtyInput() { ptyInputSuspended = true; }
export function resumePtyInput() { ptyInputSuspended = false; }
export function __forwardOnData(d) {
  if (!ptyInputSuspended) invoke('pty_input', { data: d });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/terminal-suspend.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — "onData forwarding is suspended and restored" fails before Step 3's export exists.

---

### Task 2: `ui/setup-driver.js` scaffold — DI shape, headless screen buffer, single-flight lock

**Files:**
- Create: `ui/setup-driver.js`
- Test: `ui/test/setup-driver.test.mjs` (new; this task adds the file's setup harness and the single-flight + correlation-id tests only — later tasks add more cases to the same file)

**Interfaces:**
- Produces: `export async function startSetup({ onPrompt, onLog, replay } = {}, deps = {})`. `deps` fields: `spawnPty`, `input`, `kill`, `Terminal` — each defaults to the real implementation (`ui/runner-bridge.js`'s `pty.spawnPty`/`pty.input`/`pty.kill`, `ui/vendor/xterm.mjs`'s `Terminal`) via a lazy dynamic `import()` inside the function body, never a static top-level import, so tests can override without ever touching `window.__TAURI__`. (Task 13 extends this same `deps` object with `suspendPtyInput`/`resumePtyInput`, resolved the identical lazy way.)
- `deps.spawnPty(cmd, cols, rows, onData) -> Promise<{ code, id }>` — same shape as `ui/runner-bridge.js:106-131`.
- `deps.input(data) -> Promise<void>`, `deps.kill() -> Promise<void>` — same shape as `ui/runner-bridge.js:132-134`.
- `deps.Terminal` — constructor matching `ui/vendor/xterm.mjs`'s `Terminal({ cols, rows, scrollback })`, exposing `.write(bytes, cb)` and `.buffer.active.getLine(r).translateToString(true)`.
- Rejects with `Error`-like objects: `{ step: string|null, message: string, raw: string }` (plain object, not necessarily an `Error` instance — tests assert on these three fields).
- Consumes (Task 1): nothing directly here — `setup-driver.js` calls `ui/terminal.js`'s `suspendPtyInput`/`resumePtyInput` (via injected deps, wired in Task 13) around the run.

This task establishes the fake-PTY test harness reused by every later task in this file: a `makeFakePty()` helper that returns `{ spawnPty, input, kill, writes, feed(lines), exit(code) }`, where `feed(lines)` simulates the real bridge's `onData` callback receiving base64-encoded bytes that render to the given screen-line array in a fake `Terminal`. Because constructing a real `ui/vendor/xterm.mjs` `Terminal` per test is expensive and this task only needs to prove the DI wiring, the fake `Terminal` in this task's tests is itself a stub whose `buffer.active.getLine` returns pre-seeded lines directly — later tasks that need faithful screen assembly load fixtures through the real `Terminal` (see Task 6).

- [ ] **Step 1: Write the failing tests**

```js
// ui/test/setup-driver.test.mjs (initial content)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSetup } from '../setup-driver.js';

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
  const p1 = startSetup({ onPrompt: async () => 0 }, { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: makeFakeTerminal() });
  await Promise.resolve(); // let p1 start spawning
  await assert.rejects(
    startSetup({ onPrompt: async () => 0 }, { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: makeFakeTerminal() }),
    (err) => { assert.match(err.message, /already in progress|already running/i); return true; },
  );
  fake.exit(1); // unblock p1 so the test process can exit; p1's own assertions live in later tasks
  await p1.catch(() => {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — `ui/setup-driver.js` does not exist / `startSetup` is undefined.

- [ ] **Step 3: Implement the scaffold**

Create `ui/setup-driver.js` with: a module-level `let active = null;` single-flight guard; `startSetup` that immediately throws/rejects `{ step: null, message: 'startSetup already in progress', raw: '' }` if `active` is truthy, otherwise sets `active = true` and runs the body in a `try/finally` that always resets `active = null`; resolves default `deps` via `deps.spawnPty ?? (await import('./runner-bridge.js')).pty.spawnPty` (and similarly for `input`/`kill`), and `deps.Terminal ?? (await import('./vendor/xterm.mjs')).Terminal`. The body constructs the headless terminal at `{ cols: 100, rows: 30, scrollback: 0 }`, calls `deps.spawnPty('codemie setup --force', 100, 30, onData)` where `onData` decodes base64 (reuse the `atob`/`Uint8Array` pattern from `ui/terminal.js:81-91`) and writes into the terminal, then reads back lines via `term.buffer.active.getLine(r).translateToString(true)` for `r` in `0..30`. Subsequent tasks add the prompt-loop body; this task's implementation resolves `{ profileName: null }` on zero exit and rejects `{ step: null, message: 'setup exited with code N', raw: '' }` on non-zero exit, with no prompt handling yet (later tasks fill this in — this step only needs the single-flight/DI/lock plumbing to pass Step 1's test).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — "single-flight: second concurrent startSetup rejects immediately" fails until Task 2's guard exists.

---

### Task 3: Single-occurrence dedup guard — never answer the same redrawn prompt twice

**Files:**
- Modify: `ui/setup-driver.js` (add the per-run "current prompt occurrence" tracker and the detect-and-guard seam every later prompt-handling task dispatches through)
- Test: `ui/test/setup-driver.test.mjs` (append)

**Interfaces:**
- Produces: a per-run (closure-scoped, not module-level — a single `startSetup` call already means a single PTY, so there is no concurrency beyond this single-flight guard) `lastPromptSignature` variable, and `promptSignature(prompt) = JSON.stringify({ id: prompt.id, message: prompt.message, options: prompt.options ?? null })`. On every PTY-data chunk's screen re-read, when `detectPrompt(lines)` returns non-null, the driver computes that prompt's signature. If it equals `lastPromptSignature`, the detection is ignored entirely — no dispatch, no `onPrompt` call, no write — because it is either still in flight (an earlier `await onPrompt(...)` hasn't resolved yet) or already answered and merely re-rendered. If it differs (including the very first detection of a run, where `lastPromptSignature` is `null`), the driver immediately sets `lastPromptSignature` to the new signature — *before* calling into any per-kind dispatch or awaiting `onPrompt` — so a redraw chunk arriving mid-await is caught by the same check, then proceeds to dispatch as normal. `message`/`options` are compared alongside `id` (not `id` alone) so a genuinely new occurrence sharing an id with a prior one in the sequence is still treated as new, matching detectPrompt's own returned shape exactly with no guesswork about which fields signal "same occurrence."
- Produces: this task introduces the generic dispatch fallback that later tasks' kind-specific branches (Task 5 list, Task 6 auto-answer, Task 7 model, Task 8 reject, Task 9 input) replace piece by piece: on a newly-signatured, non-null detection, `const answer = await onPrompt(prompt); await deps.input(String(answer));`. Every later task's "wire into the prompt-handling loop" instruction means: add a branch inside this same guarded dispatch point, checked before the generic fallback.
- Scope note: the guard governs only the *outer* per-chunk decision to start handling a newly-detected occurrence. Once a specific handler owns an occurrence (an in-flight `onPrompt` await, or Task 7's model-list pagination walk), that handler's own internal screen re-reads (e.g. the pagination walk's `readScreen()` between arrow-key writes) are not re-routed through this guard — they are that handler's own implementation detail, not a new top-level detection.

This task's test drives the exact scenario the round-3 revision was written to catch: Inquirer redraws the same prompt across multiple PTY-data chunks while `onPrompt` is still pending, using an `onPrompt` that resolves asynchronously (not instantly) so a chunk can plausibly arrive mid-await.

- [ ] **Step 1: Write the failing tests**

```js
test('detecting the SAME prompt again while an answer is in-flight or already given is ignored (no second onPrompt call, no second write)', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('activate'));
  let onPromptCalls = 0;
  let resolveAnswer;
  const p = startSetup(
    { onPrompt: async () => { onPromptCalls += 1; return new Promise((r) => { resolveAnswer = r; }); } },
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // first redraw chunk of the 'activate' prompt: dispatches onPrompt, await pending
  await Promise.resolve();
  fake.feedRaw('BBBB'); // a second redraw chunk of the SAME still-unanswered prompt (same fixture, unchanged)
  await Promise.resolve();
  resolveAnswer(true); // caller finally answers
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
  termInstance.__setLines(fixture('activate'));
  const seenIds = [];
  const p = startSetup(
    { onPrompt: async (prompt) => { seenIds.push(prompt.id); return true; } },
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // 'activate' prompt detected and answered
  await Promise.resolve();
  termInstance.__setLines(fixture('installClaude')); // screen has demonstrably moved on
  fake.feedRaw('BBBB');
  await Promise.resolve();
  fake.exit(0);
  await p.catch(() => {});
  assert.deepEqual(seenIds, ['activate', 'installClaude'], 'the new occurrence is processed, guard does not freeze the driver on the first prompt');
  assert.equal(fake.writes.length, 2, 'one write per occurrence, not zero and not more than two');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — no dedup guard exists yet; each redraw chunk currently re-dispatches independently, so `onPromptCalls`/`fake.writes.length` in the first test would be 3, not 1 (or the driver has no dispatch loop at all yet, since Task 2 left the prompt-loop body unimplemented).

- [ ] **Step 3: Implement the dedup guard and generic dispatch seam**

```js
let lastPromptSignature = null; // declared inside startSetup's run body — one per call, not module-level

function promptSignature(prompt) {
  return JSON.stringify({ id: prompt.id, message: prompt.message, options: prompt.options ?? null });
}

async function handleDetectedPrompt(prompt, { onPrompt, deps }) {
  const sig = promptSignature(prompt);
  if (sig === lastPromptSignature) return; // same occurrence already in-flight or answered: ignore
  lastPromptSignature = sig; // mark in-flight before awaiting anything, so mid-await redraws are caught too
  // Generic fallback for this task; Tasks 5-9 add kind-specific branches ahead of this line.
  const answer = await onPrompt(prompt);
  await deps.input(String(answer));
}
```

Call `handleDetectedPrompt(prompt, { onPrompt, deps })` from the `onData` handler's screen-read cycle whenever `detectPrompt(lines)` returns non-null.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — both dedup-guard tests fail until Task 3's guard and dispatch seam exist.

---

### Task 4: `onLog` passthrough — per-chunk callback, optional, never touches the command log

**Files:**
- Modify: `ui/setup-driver.js` (call `onLog` once per PTY-data decode-and-reparse cycle)
- Test: `ui/test/setup-driver.test.mjs` (append)

**Interfaces:**
- Produces: inside the `onData` handler built in Tasks 2-3 — after decoding a chunk's base64 payload into text and before/after re-parsing the screen — call `onLog?.(decodedChunkText)` exactly once per chunk received from the PTY. Granularity is per PTY-data write-and-reparse cycle (one call per `deps.spawnPty`'s `onData` invocation), not per detected screen line or per prompt occurrence — this is the concrete, stated choice, and it does not change when the same prompt is redrawn across chunks (that only affects the dedup guard from Task 3, not `onLog`'s per-chunk cadence). `onLog` is optional: omitting it must never throw (`onLog?.(...)`, no unconditional call).
- The only effect of `onLog` is invoking the caller-supplied function with that chunk's text. `setup-driver.js` has no dependency on, or reference to, EPMCDME-14512's command-log module anywhere in its DI surface or imports — there is nothing else for `onLog`'s output to reach, which this task's second test asserts structurally (see Step 1).

- [ ] **Step 1: Write the failing tests**

```js
test('onLog receives representative output once per PTY-data chunk during a run, and exactly one answer write results despite two chunks of the same fixture', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('activate'));
  const logged = [];
  const p = startSetup(
    { onPrompt: async () => true, onLog: (line) => logged.push(line) },
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
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
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  fake.exit(0);
  await assert.doesNotReject(p);
});

test('onLog is a bare passthrough: setup-driver.js has no command-log side-channel to route through', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../setup-driver.js', import.meta.url), 'utf8');
  assert.ok(!/command-?log/i.test(src), 'no reference to any command-log module exists for onLog output to reach');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — `onLog` is not called anywhere yet, and the `writes.length` assertion has no dedup implementation to satisfy for this specific two-chunk-same-prompt shape without Task 3.

- [ ] **Step 3: Implement the passthrough**

In the `onData` handler (Task 2), immediately after decoding the chunk's bytes to text, add `onLog?.(decodedChunkText);` — a single, unconditional-if-present call, before the screen is re-read/re-parsed. No other file or module is touched.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — all three `onLog` tests fail until Task 4's passthrough exists.

---

### Task 5: List-answer byte translation (arrow keys, never option text)

**Files:**
- Modify: `ui/setup-driver.js` (add `translateListAnswer(currentIndex, targetIndex) -> string` and wire it into the prompt-handling loop for `list`-kind prompts)
- Test: `ui/test/setup-driver.test.mjs` (append)

**Interfaces:**
- Produces: `translateListAnswer(fromIndex, toIndex)` returning the exact byte string: `toIndex > fromIndex` → `'\x1b[B'.repeat(toIndex - fromIndex) + '\r'`; `toIndex < fromIndex` → `'\x1b[A'.repeat(fromIndex - toIndex) + '\r'`; `toIndex === fromIndex` → `'\r'`. Not exported (internal), but the test drives it through a full `provider` fixture run and asserts on `fake.writes`.
- Consumes: the detected prompt's `selectedIndex` (from `detectPrompt`) as `fromIndex`.

This task wires the real `provider` fixture (a `list` prompt) through `onPrompt`, asserting the exact bytes written to the fake PTY equal the expected arrow-key sequence for a given caller answer — not "some bytes were written."

- [ ] **Step 1: Write the failing test**

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
function fixture(id) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/setup/${id}.json`, import.meta.url)), 'utf8'));
}

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
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // triggers a screen read; content comes from termInstance.__setLines
  fake.exit(1); // end the run so the test can settle; profileName not asserted here
  await p.catch(() => {});
  const expected = '\x1b[B'.repeat(2 - selectedIndex) + '\r';
  assert.deepEqual(fake.writes, [expected]);
  assert.ok(!fake.writes.some((w) => /[a-zA-Z]{3,}/.test(w)), 'never writes option label text');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — the driver does not yet call `onPrompt` or write translated bytes for `list` prompts (it only has Task 3's generic fallback, which writes `String(answer)` unstranslated).

- [ ] **Step 3: Implement the prompt-detection loop and list-answer translation**

In `ui/setup-driver.js`, inside `handleDetectedPrompt` (Task 3), ahead of the generic fallback: when the result is a `list`-kind prompt not in the auto-answered set (`gate`, `storage` — handled in Task 6), call `onPrompt({ kind, id, message, options })`, await the caller's index answer, compute `translateListAnswer(selectedIndex, answer)`, and write it via `deps.input`.

```js
function translateListAnswer(fromIndex, toIndex) {
  if (toIndex === fromIndex) return '\r';
  return toIndex > fromIndex
    ? '\x1b[B'.repeat(toIndex - fromIndex) + '\r'
    : '\x1b[A'.repeat(fromIndex - toIndex) + '\r';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — "list answer becomes exact arrow-key bytes, never option text" fails until Task 5's translation + wiring exists.

---

### Task 6: Auto-answered prompts — `gate`, `storage`, `activate`, `installClaude`

**Files:**
- Modify: `ui/setup-driver.js` (add the auto-answer table/dispatch for these four ids)
- Test: `ui/test/setup-driver.test.mjs` (append)

**Interfaces:**
- Produces: an internal auto-answer map used before the driver ever calls `onPrompt`, keyed by prompt id: `gate` → `list`, index of the option whose label matches `/create/i` (never `/update/i`); `storage` → `list`, index of the option matching `/global/i` (never `/local/i`); `activate` → `confirm`, `true`; `installClaude` → `confirm`, `false`.
- Consumes: `translateListAnswer` (Task 5) for `gate`/`storage`; a new `translateConfirmAnswer(bool) -> 'y\r'|'n\r'` for `activate`/`installClaude`.

- [ ] **Step 1: Write the failing tests**

```js
for (const [id, expectRe, forbidRe] of [
  ['gate', /create/i, /update/i],
  ['storage', /global/i, /local/i],
]) {
  test(`${id} fixture is auto-answered, never calls onPrompt`, async () => {
    const fake = makeFakePty();
    const termInstance = makeFakeTerminal()();
    termInstance.__setLines(fixture(id));
    let onPromptCalled = false;
    const p = startSetup(
      { onPrompt: async () => { onPromptCalled = true; return 0; } },
      { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
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
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA'); fake.exit(1);
  await p.catch(() => {});
  assert.equal(called, false);
  assert.deepEqual(fake.writes, ['y\r']);
});

test('installClaude fixture auto-answered n\\r, no onPrompt', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('installClaude'));
  let called = false;
  const p = startSetup({ onPrompt: async () => { called = true; return false; } },
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA'); fake.exit(1);
  await p.catch(() => {});
  assert.equal(called, false);
  assert.deepEqual(fake.writes, ['n\r']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — these four ids currently fall through to Task 3's generic `onPrompt` fallback.

- [ ] **Step 3: Implement the auto-answer dispatch**

Add, inside `handleDetectedPrompt`, before the generic fallback and before Task 5's list dispatch:

```js
const AUTO_CONFIRM = { activate: true, installClaude: false };
function translateConfirmAnswer(v) { return v ? 'y\r' : 'n\r'; }
function pickAutoListIndex(options, wantRe) {
  const i = options.findIndex((o) => wantRe.test(o));
  if (i === -1) throw { step: null, message: 'expected auto-answer option not found', raw: options.join('\n') };
  return i;
}
```

Wire `gate` → `pickAutoListIndex(options, /create/i)`, `storage` → `pickAutoListIndex(options, /global/i)`, both through `translateListAnswer(selectedIndex, chosenIndex)`; `activate`/`installClaude` → `translateConfirmAnswer(AUTO_CONFIRM[id])`. Write the result via `deps.input` and never call `onPrompt` for these four ids.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — the four auto-answer tests fail until Task 6's dispatch table exists.

---

### Task 7: Model-list pagination walk, Custom row excluded

**Files:**
- Modify: `ui/setup-driver.js` (add `collectModelOptions(...)` pagination walk for the `model` id)
- Test: `ui/test/setup-driver.test.mjs` (append)

**Interfaces:**
- Produces: an internal async `collectModelOptions({ readScreen, writeArrowDown, writeArrowUp })` that: repeatedly calls `writeArrowDown()` then `readScreen()` to re-run `detectPrompt`, appending any option text not already seen, until a call yields no new entries; then calls `writeArrowUp()` the same number of times to return to the top; returns the deduplicated, Custom-excluded option list (any option matching `/^custom/i` is dropped from what's passed to `onPrompt`, though it still occupies its row in the underlying index math).
- Consumes: `deps.input` for writing raw arrow bytes (`'\x1b[B'`, `'\x1b[A'`) one keystroke at a time (no `\r` between pagination steps — only the final answer selection ends in `\r`).
- The caller's chosen index is an index into the filtered (Custom-excluded) list; the driver maps it back to the raw (unfiltered) list's index before calling `translateListAnswer`, so excluding Custom never shifts which raw row the caller's answer actually selects.
- Scope note (Task 3): `collectModelOptions`'s own `readScreen()` calls between arrow-key writes are internal to this already-in-flight handler and are not re-routed through Task 3's outer dedup guard — that guard only gates the initial top-level detection of the `model` prompt occurrence, before this walk begins.

This task's test drives a synthetic multi-frame sequence via the fake `Terminal`'s `__setLines`, changing the seeded lines each time `fake.input` is called with a bare `'\x1b[B'` (no `\r`), simulating the real CLI revealing one new option per key-press until repeats appear.

- [ ] **Step 1: Write the failing test**

```js
test('model list pagination walk stops on repeat, returns to top, excludes Custom', async () => {
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
  const fakeInput = async (d) => {
    fake.writes.push(d);
    if (d === '\x1b[B' && frameIdx < frames.length - 1) { frameIdx += 1; termInstance.__setLines(frames[frameIdx]); }
  };
  const seenOptions = [];
  const p = startSetup(
    { onPrompt: async (prompt) => { seenOptions.push(...prompt.options); return 0; } },
    { spawnPty: fake.spawnPty, input: fakeInput, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); fake.exit(1);
  await p.catch(() => {});
  assert.ok(!seenOptions.some((o) => /^custom/i.test(o)), 'Custom never presented as a normal option');
  assert.ok(seenOptions.includes('gpt-4o'), 'discovers options revealed by later pagination frames');
  const upCount = fake.writes.filter((w) => w === '\x1b[A').length;
  const downCount = fake.writes.filter((w) => w === '\x1b[B').length;
  assert.equal(upCount, downCount, 'returns to top by the same number of arrow-ups as arrow-downs walked');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — no pagination walk exists yet; the driver currently offers only the first-screen options for `model`, including any `Custom` row.

- [ ] **Step 3: Implement the pagination walk**

Add `collectModelOptions` per the Interfaces block above, invoked specifically when `detectPrompt` returns `{ id: 'model', kind: 'list', ... }`. After collecting, filter `/^custom/i` matches out of the array passed to `onPrompt`'s `options`, but keep the raw (unfiltered) list and its indices for translating the caller's chosen index (which is an index into the filtered list) back to a raw-list index before calling `translateListAnswer`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — "model list pagination walk stops on repeat, returns to top, excludes Custom" fails until Task 7's walk exists.

---

### Task 8: `customModel` / `modelManual` reject immediately with `step: 'model'`

**Files:**
- Modify: `ui/setup-driver.js` (special-case these two ids before the generic `input`-kind dispatch)
- Test: `ui/test/setup-driver.test.mjs` (append)

**Interfaces:**
- Produces: on detecting `{ id: 'customModel' }` or `{ id: 'modelManual' }`, the driver rejects `startSetup`'s promise with `{ step: 'model', message: <descriptive string mentioning the id>, raw: <full 30-line screen joined by '\n'> }` without calling `onPrompt`, and without writing anything to the PTY.

- [ ] **Step 1: Write the failing test**

```js
for (const id of ['customModel', 'modelManual']) {
  test(`${id} fixture rejects with step:'model', never calls onPrompt`, async () => {
    const fake = makeFakePty();
    const termInstance = makeFakeTerminal()();
    termInstance.__setLines(fixture(id));
    let called = false;
    const p = startSetup({ onPrompt: async () => { called = true; return 'x'; } },
      { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
    fake.feedRaw('AAAA');
    await assert.rejects(p, (err) => { assert.equal(err.step, 'model'); assert.ok(err.message); assert.ok(err.raw); return true; });
    assert.equal(called, false);
    assert.equal(fake.writes.length, 0);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — `customModel`/`modelManual` currently fall through to Task 3's generic fallback and call `onPrompt`.

- [ ] **Step 3: Implement the special-case rejection**

Inside `handleDetectedPrompt`, before the generic `input`-kind dispatch (Task 9), add:

```js
if (prompt.id === 'customModel' || prompt.id === 'modelManual') {
  throw { step: 'model', message: `model step requires a fetched list; got free-text fallback prompt "${prompt.id}"`, raw: lines.join('\n') };
}
```

(Thrown inside the async run body, caught by the top-level `try/catch` that rejects `startSetup`'s promise — same mechanism as the non-zero-exit rejection in Task 2.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — both `customModel`/`modelManual` rejection tests fail until Task 8's special-case exists.

---

### Task 9: Uniform `kind: 'input'` prompt handling — `codemieUrl`, `credential`, `profileName`

**Files:**
- Modify: `ui/setup-driver.js` (add one generic dispatch branch for any `kind: 'input'` prompt, used by all three ids alike)
- Test: `ui/test/setup-driver.test.mjs` (append)

**Interfaces:**
- Produces: when `detectPrompt` returns `{ kind: 'input', id, message }` for any id (`codemieUrl`, `credential`, `profileName` — and any future `input`-kind id, with no per-id special-casing beyond this one branch, aside from Task 8's `customModel`/`modelManual` rejects and Task 6's auto-answered ids, both of which are checked first and never reach this branch), the driver calls `onPrompt({ kind: 'input', id, message })`, awaits the caller's string answer, and writes `answer + '\r'` via `deps.input` — never arrow-key bytes. The answer string is also captured by the caller of this branch (used by Task 13 to build the resolved `{ profileName }` result when `id === 'profileName'`).
- Consumes: nothing new beyond the existing prompt-detection loop from Tasks 3-5.

- [ ] **Step 1: Write the failing tests**

```js
for (const id of ['codemieUrl', 'credential']) {
  test(`${id} fixture: onPrompt called with kind 'input' and this id; answer text + \\r written, not arrow keys`, async () => {
    const fake = makeFakePty();
    const termInstance = makeFakeTerminal()();
    termInstance.__setLines(fixture(id));
    let seenPrompt = null;
    const p = startSetup(
      { onPrompt: async (prompt) => { seenPrompt = prompt; return 'answer-value'; } },
      { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — `codemieUrl` and `credential` currently fall through to Task 3's generic fallback, which writes `String(answer)` with no trailing `\r`.

- [ ] **Step 3: Implement the uniform dispatch**

Inside `handleDetectedPrompt`, after the auto-answer checks (Task 6) and the `customModel`/`modelManual` reject (Task 8), add a single branch: `if (prompt.kind === 'input') { const answer = await onPrompt({ kind: 'input', id: prompt.id, message: prompt.message }); await deps.input(String(answer) + '\r'); /* Task 13 records `answer` when prompt.id === 'profileName' */ }`. This one branch is the only place any `input`-kind prompt is handled — no separate `profileName`-only code path exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — both `codemieUrl`/`credential` tests fail until Task 9's uniform branch exists.

---

### Task 10: Unrecognized `(y/N)`-hint fallback (analyticsSync) — idle-timer settle detection, auto-answer `n`, never hang, never touch classified prompts

**Files:**
- Modify: `ui/setup-driver.js` (add an idle-timer settle-detection mechanism plus the narrowly-scoped fallback check, gated on `detectPrompt` returning `null` on a screen the timer has confirmed settled)
- Test: `ui/test/setup-driver.test.mjs` (append)

**Interfaces:**
- Produces: after each PTY-data write, the driver (re)schedules a single idle timer for **200ms** after the most recent write (`setTimeout`, cleared and rescheduled on every new PTY-data chunk). 200ms is the concrete, chosen debounce: short enough that a real run answering the analytics-sync prompt doesn't visibly stall past what a user would read as "still working," long enough that a burst of redraw frames from the CLI (which land well under 100ms apart in practice) will not trigger a spurious mid-redraw check. If the timer fires (no further PTY data arrived in that window), the driver re-runs `detectPrompt` on the *current* screen; if it is still `null` and the last non-blank line matches `/\([yY]\/[nN]\)\s*$/`, the driver writes `'n\r'` and continues the loop, without calling `onPrompt`. If new PTY data arrives before the timer fires, the timer is cleared/rescheduled and normal processing continues — the fallback never fires on a screen that is still actively being redrawn.
- Produces: this fallback must never fire on a screen that IS a recognized (non-null) prompt, and never substitutes for `credential`/`model`/any classified-prompt handling — the `null`-result gate from `detectPrompt` is checked first, unconditionally, ahead of Task 3's dedup guard (which only applies to non-null detections).
- Consumes: the same base64-decode + terminal-write + line-read cycle already built in Tasks 2-4.

- [ ] **Step 1: Write the failing test**

```js
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
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance },
  );
  fake.feedRaw('AAAA'); // one write, then the CLI goes quiet waiting for input
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
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  await t.mock.timers.tick(150); // under the 200ms threshold
  fake.feedRaw('BBBB'); // more data arrives: resets the idle window
  await t.mock.timers.tick(150); // still under 200ms since the reset
  assert.ok(!fake.writes.includes('n\r'), 'fallback has not fired yet: window was reset by new data');
  await t.mock.timers.tick(200); // now let it settle
  assert.ok(fake.writes.includes('n\r'));
  fake.exit(0);
  await p.catch(() => {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — the driver currently has no idle-timer settle-detection or fallback for `detectPrompt() === null`; it either hangs waiting for a prompt or takes no forward-progress action.

- [ ] **Step 3: Implement the idle-timer and fallback**

```js
// Unrecognized (y/N)-style prompt (e.g. the analytics-sync consent screen): setup-parse.js
// deliberately returns null for these (its own defect-fix guard) since answering them as
// 'credential' would type an API key into a consent question. We wait for the screen to go
// idle for IDLE_MS (a burst of CLI redraw frames lands well under 100ms apart in practice, so
// this never fires mid-redraw; it also never stalls a real run long enough to look hung), then
// accept the CLI's own displayed default — (y/N) capitalizes N — rather than rejecting the
// whole run over a non-essential question. This must only fire when detectPrompt returned null
// for a screen the idle timer has confirmed settled, and must never be used for
// credential/model/any classified prompt.
const IDLE_MS = 200;
const YN_HINT = /\([yY]\/[nN]\)\s*$/;
let idleTimer = null;
function scheduleIdleCheck(onIdle) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(onIdle, IDLE_MS);
}
// ...inside onData, after each write+reparse: scheduleIdleCheck(() => {
//   const lines = readScreen();
//   if (detectPrompt(lines) === null) {
//     const lastLine = [...lines].reverse().find((l) => l.trim())?.trim() ?? '';
//     if (YN_HINT.test(lastLine)) deps.input('n\r');
//   }
// });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — both idle-timer/fallback tests fail until Task 10's mechanism exists.

---

### Task 11: Single-flight guard vs. `spawn_pty` rejection — distinct error shapes

**Files:**
- Modify: `ui/setup-driver.js` (ensure the two failure paths never share a message/shape)
- Test: `ui/test/setup-driver.test.mjs` (append)

**Interfaces:**
- Produces: the single-flight rejection (Task 2) always has `step: null, message: 'startSetup already in progress'` (or equivalent, but distinct wording) and is thrown synchronously before any `deps.spawnPty` call; a `deps.spawnPty` rejection (simulating the Rust `"PTY already active"` error) is caught and re-wrapped as `{ step: null, message: <includes the original error's message>, raw: '' }` — a *different* message text from the single-flight guard's, so callers can distinguish "you raced yourself" from "another PTY consumer beat you to the slot."

- [ ] **Step 1: Write the failing test**

```js
test('spawn_pty rejection surfaces as a normal startSetup rejection, distinct from single-flight', async () => {
  const failingSpawn = async () => { throw new Error('PTY already active'); };
  await assert.rejects(
    startSetup({ onPrompt: async () => 0 }, { spawnPty: failingSpawn, input: async () => {}, kill: async () => {}, Terminal: makeFakeTerminal() }),
    (err) => {
      assert.match(err.message, /PTY already active/);
      assert.ok(!/already in progress/i.test(err.message), 'must not be conflated with the single-flight message');
      return true;
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — until this task, a `spawnPty` throw may propagate unwrapped or with the wrong shape.

- [ ] **Step 3: Implement the wrapping**

Wrap the `deps.spawnPty(...)` call in `try/catch`; on catch, `throw { step: null, message: \`spawn failed: ${err.message}\`, raw: '' }` — re-thrown inside the same top-level `try/finally` from Task 2, which already resets the single-flight lock regardless of which branch threw.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — the "distinct from single-flight" assertion fails until Task 11's wrapping exists.

---

### Task 12: Correlation-id event filtering and retry sequencing

**Files:**
- Modify: `ui/setup-driver.js` (track this run's own spawn id; ignore data after settlement; on retry, confirm prior exit or force-kill before respawning)
- Test: `ui/test/setup-driver.test.mjs` (append)

**Interfaces:**
- Produces: the driver stores the `id` returned by `deps.spawnPty`'s resolved `{ code, id }`. Since real `engine:pty-data` events are already pre-filtered by id one layer down in `ui/runner-bridge.js:117-119` before the driver's `onData` callback ever sees them, the driver's own observable safety net is behavioral, not id-based: once `startSetup`'s promise has settled (resolved or rejected), any further invocation of the injected `onData` callback must be a complete no-op — no further `onPrompt` calls, no further `deps.input` writes, no state mutation.
- Produces: before a second `startSetup()` call spawns, if a previous run's process has not reported exit, the driver awaits it; if the fake bridge's `kill()` is what produces that exit (simulating a hang), the driver calls `deps.kill()` and awaits the resulting exit before its own `deps.spawnPty` call.

- [ ] **Step 1: Write the failing tests**

```js
test('data arriving after startSetup has settled is ignored: no further onPrompt calls or writes', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('activate'));
  let onPromptCalls = 0;
  let dataCb;
  const spawnCapture = async (_cmd, _cols, _rows, onData) => { dataCb = onData; return fake.spawnPty('codemie setup --force', 100, 30, onData); };
  const p = startSetup({ onPrompt: async () => { onPromptCalls += 1; return true; } },
    { spawnPty: spawnCapture, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
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
  const p1 = startSetup({ onPrompt: async () => 0 },
    { spawnPty: fake1.spawnPty, input: fake1.input, kill: fake1.kill, Terminal: () => termInstance1 });
  fake1.feedRaw('AAAA');
  await assert.rejects(p1);
  // p1's fake pty never explicitly exited; startSetup must have killed it before returning.
  let secondSpawned = false;
  const fake2 = makeFakePty();
  const termInstance2 = makeFakeTerminal()();
  termInstance2.__setLines(fixture('activate'));
  const spawn2 = async (...args) => { secondSpawned = true; return fake2.spawnPty(...args); };
  const p2 = startSetup({ onPrompt: async () => true },
    { spawnPty: spawn2, input: fake2.input, kill: fake2.kill, Terminal: () => termInstance2 });
  fake2.feedRaw('AAAA');
  fake2.exit(0);
  await p2;
  assert.ok(secondSpawned, 'second run spawns only after the first run fully settled');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — no post-settlement no-op guard and no retry-sequencing/kill-before-respawn logic exists yet.

- [ ] **Step 3: Implement post-settlement no-op guard and retry sequencing**

Add a per-run `let settled = false;` flag, set immediately before `startSetup`'s promise resolves/rejects; have the `onData` callback (and any timer callback from Task 10) check `if (settled) return;` as their first line, so nothing they do can call `onPrompt`, write, or mutate state once the run has settled. Separately, in the top-level `finally` (Task 2), before releasing the single-flight lock: if the run's PTY child has not reported `engine:pty-exit` (tracked via a `let exited = false` flag set only inside the exit-resolution path), call `await deps.kill()` and await the pending exit promise before returning/rethrowing. This guarantees any subsequent `startSetup()` call only proceeds once the prior child is confirmed gone.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — both the post-settlement no-op test and the retry-sequencing test fail until Task 12's guard/kill-before-respawn logic exists.

---

### Task 13: Suspend/restore `ui/terminal.js` forwarding via injected deps; full-run resolve/reject; `replay` no-op

**Files:**
- Modify: `ui/setup-driver.js` (extend the `deps` object from Task 2 with `suspendPtyInput`/`resumePtyInput`, lazily defaulted to `ui/terminal.js`'s real exports; call them around the spawn-to-settle window; resolve `{ profileName }` from the answer captured by Task 9's uniform `input`-kind branch when `id === 'profileName'`)
- Test: `ui/test/setup-driver.test.mjs` (append; this is also where the full-success and generic-failure cases land)

**Interfaces:**
- Produces: `deps.suspendPtyInput` / `deps.resumePtyInput` default via `deps.suspendPtyInput ?? (await import('./terminal.js')).suspendPtyInput` (same pattern for `resumePtyInput`) — resolved lazily inside the function body, identically to Task 2's `spawnPty`/`input`/`kill`/`Terminal` defaults. This is the fix for round-1's blocking defect: `setup-driver.js` never statically imports `./terminal.js` at module top level, so merely importing `setup-driver.js` (which every test in the file does) never touches `window`.
- Produces: the driver calls `deps.suspendPtyInput()` right after `deps.spawnPty` is invoked (spawn initiated, not settled), and calls `deps.resumePtyInput()` in the same `finally` block used for the single-flight release (Task 2) and the kill-before-respawn logic (Task 12) — so forwarding is restored on every exit path, success or rejection.
- Produces: on the `profileName` prompt (handled by Task 9's uniform `input`-kind branch), the driver stores the captured answer string; on zero exit, resolves `{ profileName: <that captured string> }`. If no `profileName` prompt was seen before a zero exit (shouldn't happen in practice but must not throw), resolves `{ profileName: null }`.
- Produces: `startSetup`'s `replay` field is read but never referenced anywhere else in the function body (verified by the no-op test below).

- [ ] **Step 1: Write the failing tests**

```js
test('successful full run resolves { profileName } on zero exit', async () => {
  const fake = makeFakePty();
  const term = makeFakeTerminal();
  const termInstance = term();
  termInstance.__setLines(fixture('profileName'));
  const p = startSetup({ onPrompt: async (prompt) => (prompt.id === 'profileName' ? 'my-profile' : 0) },
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
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
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  fake.exit(1);
  await assert.rejects(p, (err) => { assert.ok('step' in err); assert.ok(err.message); assert.ok('raw' in err); return true; });
});

test('replay parameter accepted and is a documented no-op', async () => {
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('activate'));
  const p = startSetup({ onPrompt: async () => true, replay: [{ some: 'frame' }] },
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  fake.exit(0);
  await p; // no throw, no different behavior than the no-replay activate case in Task 6
});

test('ui/terminal.js onData forwarding is suspended for the run duration and restored after, via default deps', async () => {
  globalThis.window = globalThis.window ?? { __TAURI__: { core: { invoke: async () => {} } } };
  const { suspendPtyInput, resumePtyInput, __forwardOnData } = await import('../terminal.js');
  resumePtyInput(); // ensure baseline
  const fake = makeFakePty();
  const termInstance = makeFakeTerminal()();
  termInstance.__setLines(fixture('activate'));
  // deps deliberately omit suspendPtyInput/resumePtyInput so the driver's lazy default
  // (real ./terminal.js exports) is exercised, proving the DI wiring end-to-end.
  const p = startSetup({ onPrompt: async () => true },
    { spawnPty: fake.spawnPty, input: fake.input, kill: fake.kill, Terminal: () => termInstance });
  fake.feedRaw('AAAA');
  // While the run is in flight, forwarding must be suspended.
  const calls = [];
  globalThis.window.__TAURI__.core.invoke = (...a) => { calls.push(a); return Promise.resolve(); };
  __forwardOnData('x');
  assert.equal(calls.length, 0, 'forwarding suspended during the run');
  fake.exit(0);
  await p;
  __forwardOnData('y');
  assert.equal(calls.length, 1, 'forwarding restored after the run settles');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — `profileName` capture/resolve, non-zero-exit rejection shape, and the suspend/restore DI wiring aren't in place yet.

- [ ] **Step 3: Implement**

Extend the `deps` resolution block from Task 2 with `suspendPtyInput`/`resumePtyInput` per the Interfaces block above; wire the `suspendPtyInput()`/`resumePtyInput()` calls as described; capture the `profileName` answer (from Task 9's branch) into a local variable; on the exit promise resolving with `code === 0`, resolve `{ profileName }`; on non-zero, reject `{ step: null, message: \`setup exited with code ${code}\`, raw: lines.join('\n') }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

Commit per the repository's existing convention.

Test-first: yes — the four tests in Step 1 (full success, non-zero exit shape, replay no-op, suspend/restore via default deps) fail until Task 13's wiring exists.

---

### Task 14: Definition-of-done gates

**Files:** none (verification only)

- [ ] **Step 1: Run the full JS test suite**

Run: `npm test`
Expected: PASS — all new `setup-driver.test.mjs`/`terminal-suspend.test.mjs` cases plus every pre-existing `ui/test/*.test.mjs` file.

- [ ] **Step 2: Run the Rust quality gates to confirm nothing broke**

Run: `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test`
Expected: PASS — no Rust files were touched by this plan, so this should already be green; it confirms that fact rather than fixing anything.

- [ ] **Step 3: Mutation check on the new driver tests**

Temporarily comment out or no-op `translateListAnswer`'s body (e.g. make it always return `'\r'` regardless of `fromIndex`/`toIndex`) in `ui/setup-driver.js`. Re-run `node --test ui/test/setup-driver.test.mjs`. Confirm exactly one test fails (the Task 5 "list answer becomes exact arrow-key bytes" test — any other failure means the tests are entangled or too loose). Restore `translateListAnswer` to its working implementation and re-run to confirm the suite is green again. Report the before/after result (which test failed, count of failures) as this task's output — this step verifies test quality, it does not ship code.

Test-first: no — this task is a verification/reporting step over already-implemented and already-tested code from Tasks 1-13, not new production code.
