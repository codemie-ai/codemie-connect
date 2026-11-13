# cmdlog Bridge Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap all five JS command-execution paths with `cmdlog_open`/`cmdlog_append`/`cmdlog_close` recording against the already-registered Rust CmdLogStore; add streaming PTY TextDecoder, ANSI stripping, and node:test coverage.

**Architecture:** A thin `cmdlog` export added to `runner-bridge.js` delegates to the three Tauri commands. Each path wraps with open before/close in finally; `spawnPty` holds a per-invocation `TextDecoder` and appends decoded+ANSI-stripped PTY chunks. A new pure-function `ui/ansi-strip.mjs` handles stripping — stateless, boundary-safe (partial escapes at chunk end left as artefacts). One line in `renderer.js` re-routes `runUpdateCli` through `bridge.updater.runSelfUpdate()`.

**Tech Stack:** ES modules (no bundler), Tauri invoke, node:test, TextDecoder (Web API), atob.

**Spec:** docs/superpowers/tasks/2026-09-24-epmcdme-15231/spec.md

## Global Constraints

- Zero Rust changes — `cmdlog_open`/`append`/`close`/`list`/`get` are registered and tested.
- No new npm dependencies.
- cmdlog failures (`open`/`append`/`close`) must not throw to callers — `console.warn` and swallow.
- `TextDecoder` allocated once per `spawnPty` invocation, inside the function body, not at module scope.
- Commit per task using the repository's existing conventional-commit convention.

---

### Task 1: ANSI-strip utility

**Files:**
- Create: `ui/ansi-strip.mjs`
- Create: `ui/test/ansi-strip.test.mjs`

**Interfaces:**
- Produces: `export default function stripAnsi(text: string): string`

**Test-first: yes — five failing assertions: complete CSI strip, complete OSC strip, plain text passthrough, partial-escape preservation (trailing `\x1b[0` left unchanged), chunk-boundary simulation (partial in chunk1 is an artefact; chunk2 strips independently without corrupting plain text). Plus one TextDecoder streaming assertion: a 3-byte UTF-8 character split across two decode calls completes correctly with `{ stream: true }`.**

- [ ] **Step 1: Write `ui/test/ansi-strip.test.mjs`**

Use `import { test } from 'node:test'` and `import { strict as assert } from 'node:assert'`. Dynamic-import `stripAnsi` from `'../ansi-strip.mjs'`.

```js
test('strips complete CSI sequence', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('\x1b[31mred\x1b[0m'), 'red');
});
test('strips complete OSC sequence', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('\x1b]0;title\x07text'), 'text');
});
test('leaves plain text unchanged', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('hello'), 'hello');
});
test('leaves partial escape at end of string unchanged', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('text\x1b[0'), 'text\x1b[0');
});
test('chunk boundary: partial artefact in chunk1, chunk2 processes independently', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('abc\x1b[3'), 'abc\x1b[3'); // partial preserved
  assert.equal(s('1mXYZ\x1b[0m'), '1mXYZ');  // chunk2: '1m' is plain text; '\x1b[0m' stripped
});
test('TextDecoder streams multi-byte UTF-8 split across two payloads', () => {
  const dec = new TextDecoder('utf-8', { fatal: false });
  const bytes1 = new Uint8Array([0xE2, 0x82]); // first 2 bytes of U+20AC '€'
  const bytes2 = new Uint8Array([0xAC]);
  assert.equal(dec.decode(bytes1, { stream: true }), '');
  assert.equal(dec.decode(bytes2, { stream: false }), '€');
});
```

- [ ] **Step 2: Run `npm test` — confirm 6 failures (import error / ReferenceError)**

- [ ] **Step 3: Create `ui/ansi-strip.mjs`**

```js
// Strips complete ANSI/VT escape sequences. Partial escapes at end-of-string
// are left unchanged (boundary-safe, stateless).
const RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|[^[\]])/g;
export default function stripAnsi(text) { return text.replace(RE, ''); }
```

- [ ] **Step 4: Run `npm test` — confirm all 6 new tests pass, prior tests unaffected**

- [ ] **Step 5: Commit**

---

### Task 2: cmdlog export + runStream / runCapture / runFreshEnv instrumentation

**Files:**
- Modify: `ui/runner-bridge.js` — add `cmdlog` export; wrap `runner.runCapture` (line 12), `runner.runFreshEnv` (line 13), `runner.runStream` (lines 17–30)
- Create: `ui/test/cmdlog-bridge.test.mjs` — tests 1–3 from spec

**Interfaces:**
- Produces: `export const cmdlog = { open, append, close }` — delegates to Tauri; used internally by all five wrapped paths

**Test-first: yes — three tests (mutable-delegate pattern from `pty-bridge.test.mjs`): (1) runStream: verify invoke order is `cmdlog_open → run_stream → cmdlog_append(logId, text) → cmdlog_close(logId, code)`; (2) runCapture: `cmdlog_open → run_capture → cmdlog_append(logId, result) → cmdlog_close(logId, 0)`; (3) runFreshEnv: same shape as runCapture with `run_fresh_env`.**

- [ ] **Step 1: Write `ui/test/cmdlog-bridge.test.mjs` (tests 1–3)**

Copy the stub scaffold from `ui/test/pty-bridge.test.mjs` lines 1–20 (`let invokeImpl`, `let listenImpl`, dynamic `import()`). In each test, capture all `invokeImpl` call records (`{ cmd, args }`) in an array. For runStream: after the module import, fire a synthetic `engine:cmd-line` event via `listenImpl` capture before asserting order. Assert the captured call sequence matches `['cmdlog_open', 'run_stream', 'cmdlog_append', 'cmdlog_close']` and that `cmdlog_close` receives the stream's exit code.

- [ ] **Step 2: Run `npm test` — confirm 3 new failures**

- [ ] **Step 3: Add `cmdlog` export to `runner-bridge.js`**

Add after the `invoke` / `listen` imports, before the first `export const`:

```js
export const cmdlog = {
  open:   (cmd)       => invoke('cmdlog_open',   { command: cmd }),
  append: (id, chunk) => invoke('cmdlog_append', { id, chunk }),
  close:  (id, code)  => invoke('cmdlog_close',  { id, exitCode: code }),
};
```

- [ ] **Step 4: Wrap `runner.runCapture` (`ui/runner-bridge.js:12`)**

Replace the single `invoke` call with:

```js
let _code = -1;
const logId = await cmdlog.open(cmd).catch(() => null);
try {
  const result = await invoke('run_capture', { cmd });
  if (logId) await cmdlog.append(logId, result).catch(console.warn);
  _code = 0;
  return result;
} finally {
  if (logId) await cmdlog.close(logId, _code).catch(console.warn);
}
```

Apply the identical pattern to `runner.runFreshEnv` (`runner-bridge.js:13`), replacing `invoke('run_fresh_env', { cmd })`.

- [ ] **Step 5: Wrap `runner.runStream` (`ui/runner-bridge.js:17–30`)**

In `runStream`'s async body, before `invoke('run_stream', ...)`:
`const logId = await cmdlog.open(cmd).catch(() => null);`

Inside the existing `engine:cmd-line` filtered handler, after the existing `onLine` call, append:
`if (logId) cmdlog.append(logId, text).catch(console.warn);`

Inside the existing `finally` block, append:
`if (logId) await cmdlog.close(logId, code ?? -1).catch(console.warn);`

- [ ] **Step 6: Run `npm test` — confirm tests 1–3 pass; all prior tests pass**

- [ ] **Step 7: Commit**

---

### Task 3: spawnPty instrumentation

**Files:**
- Modify: `ui/runner-bridge.js` — top-level import of `stripAnsi`; `pty.spawnPty` body (lines 128–153)
- Modify: `ui/test/cmdlog-bridge.test.mjs` — add tests 4–5

**Interfaces:**
- Consumes: `stripAnsi` from `ui/ansi-strip.mjs` (Task 1); `cmdlog` export from Task 2

**Test-first: yes — test 4: spawnPty with `onData` — fire synthetic `engine:pty-data` payload (base64 of `'\x1b[31mhi\x1b[0m'`); assert `cmdlog_append` receives `'hi'` (decoded+stripped), not raw base64; assert `onData` receives original base64 unchanged; assert `cmdlog_close(logId, 0)` on pty-exit. Test 5: same with `onData = undefined`; cmdlog behavior identical.**

- [ ] **Step 1: Add tests 4–5 to `ui/test/cmdlog-bridge.test.mjs`**

In the stub, for `spawn_pty` capture the call and immediately trigger the stored `engine:pty-data` listener with `{ id, data: btoa('\x1b[31mhi\x1b[0m') }`, then trigger `engine:pty-exit` with `{ id, code: 0 }`. Assert `cmdlog_append` was called with `(logId, 'hi')`. Assert `cmdlog_close` was called with `(logId, 0)`.

- [ ] **Step 2: Run `npm test` — confirm 2 new failures**

- [ ] **Step 3: Add import to `ui/runner-bridge.js` top**

```js
import stripAnsi from './ansi-strip.mjs';
```

- [ ] **Step 4: Update `pty.spawnPty` body (`ui/runner-bridge.js:128–153`)**

At the top of the `spawnPty` async function body, before the `try` block:

```js
const logId = await cmdlog.open(cmd).catch(() => null);
const decoder = new TextDecoder('utf-8', { fatal: false });
```

Inside the existing `engine:pty-data` filtered handler (inside the try block, after the existing `if (onData) onData(event.payload.data)` call):

```js
const raw = Uint8Array.from(atob(event.payload.data), c => c.charCodeAt(0));
const stripped = stripAnsi(decoder.decode(raw, { stream: true }));
if (stripped && logId) cmdlog.append(logId, stripped).catch(console.warn);
```

Inside the existing `finally` block, before or after the `unlisten` calls:

```js
const tail = stripAnsi(decoder.decode(new Uint8Array(0), { stream: false }));
if (tail && logId) await cmdlog.append(logId, tail).catch(console.warn);
if (logId) await cmdlog.close(logId, exitCode ?? -1).catch(console.warn);
```

(`exitCode` is already in scope from the resolved `engine:pty-exit` payload.)

- [ ] **Step 5: Run `npm test` — confirm tests 4–5 pass; all prior tests pass**

- [ ] **Step 6: Commit**

---

### Task 4: runSelfUpdate instrumentation + renderer re-point + intent comments

**Files:**
- Modify: `ui/runner-bridge.js` `updater.runSelfUpdate` (~line 82)
- Modify: `ui/renderer.js:485` — one-line re-point
- Modify: `ui/renderer.js` — intent comments at three call sites
- Modify: `ui/test/cmdlog-bridge.test.mjs` — add test 6

**Interfaces:**
- Consumes: `cmdlog` export from Task 2

**Test-first: yes — test 6: two sub-cases: resolve path (`invokeImpl` returns for `run_self_update`) → `cmdlog_close(logId, 0)`; rejection path (`invokeImpl` throws) → `cmdlog_close(logId, -1)`. Assert `cmdlog_open` fires before `invoke('run_self_update')` in both cases.**

- [ ] **Step 1: Add test 6 to `ui/test/cmdlog-bridge.test.mjs`**

Two assertions per sub-case: call order (`cmdlog_open` index < `run_self_update` index) and the exit code passed to `cmdlog_close`.

- [ ] **Step 2: Run `npm test` — confirm 1 new failure**

- [ ] **Step 3: Wrap `updater.runSelfUpdate` in `ui/runner-bridge.js` (~line 82)**

Replace `invoke('run_self_update')` with:

```js
const logId = await cmdlog.open('run_self_update').catch(() => null);
let _code = -1;
try {
  const result = await invoke('run_self_update');
  _code = 0;
  return result;
} finally {
  if (logId) await cmdlog.close(logId, _code).catch(console.warn);
}
```

- [ ] **Step 4: Re-point `ui/renderer.js:485`**

Change `invoke('run_self_update')` → `bridge.updater.runSelfUpdate()`. (The `invoke` import remains used elsewhere in `renderer.js`; do not remove it.)

- [ ] **Step 5: Add intent comments at call sites in `ui/renderer.js`**

Add `// cmdlog intent: user-initiated` on the line immediately preceding:
- `bridge.runner.runStream(...)` inside `startSignIn` (~line 394 area)
- `bridge.pty.spawnPty(...)` inside `runAction` (~line 352 area)
- `bridge.updater.runSelfUpdate()` inside `runUpdateCli` (~line 485)

- [ ] **Step 6: Run `npm test` — confirm all tests pass**

- [ ] **Step 7: Commit**

---

## negative-constraints

All Non-goals from spec §Non-goals are honored:

| Constraint | Honored by |
|---|---|
| No Rust changes | No `src-tauri/` file in any task |
| No UI for command log | No renderer display tasks |
| No `intent` field on `CmdRecord` | Rust not touched; intent is a comment only |
| No stateful ANSI carry-buffer | Task 1 uses a stateless regex; boundary artefacts are acceptable |
| No cmdlog for pty.kill/input/resize | Not mentioned in any task |
| No new Tauri permissions | No capability changes |
| No changes to `ui/terminal.js` | Not in any task |
| No new npm dependencies | None added |
