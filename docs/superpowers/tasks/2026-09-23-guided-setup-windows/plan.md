# Guided Setup on Windows (EPMCDME-14982) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the headless guided-setup PTY driver (`ui/setup-driver.js`) work correctly against `powershell.exe` on Windows, with no macOS regression, by recording a real Windows session first and fixing only what the recording proves is wrong.

**Architecture:** No new architecture. `ui/setup-driver.js` (headless xterm.js reader over a PTY byte stream) and its pure parser `ui/setup-parse.js` already isolate all platform-touching deps behind lazy `import()` + `deps` injection, and `src-tauri/src/commands/pty.rs` already branches `spawn_pty` on `cfg!(windows)`. This plan is procedural: capture real Windows PTY frames via temporary debug logging, diff them against the macOS-derived contract encoded in the driver's own comments/constants, fix only proven divergences (platform-neutral fix preferred over an `isWin` fork), add Windows fixture-replay tests mirroring the existing `'real stream: ...'` pattern, then strip the logging.

**Tech Stack:** Vanilla JS (ES modules), Node's built-in `node:test` + `node:assert/strict`, Tauri/Rust backend (untouched here), `cargo tauri dev` for manual verification.

**Spec:** `docs/superpowers/tasks/2026-09-23-guided-setup-windows/spec.md`

## Global Constraints

- macOS behavior, macOS-titled tests, and macOS fixtures in `ui/test/setup-driver.test.mjs` / `ui/test/fixtures/setup/*.json` must stay untouched — they are the regression gate.
- No `src-tauri` change (`spawn_pty` already branches on `cfg!(windows)`).
- No change to `ui/handlers.js` or `config/steps-windows.yaml` (unrelated legacy Wizard flow, confirmed out of scope).
- Do not add `isWin` branching to `setup-driver.js`/`setup-parse.js`/`setup-view.js` unless the Windows recording proves the two PTYs need different logic — prefer one platform-neutral fix.
- All temporary debug logging must be removed before the final commit; none of it ships.
- One MR for the whole ticket; commit per task using the repo's existing convention: subject `"EPMCDME-14982 : <short subject>"`, short body, no `Co-Authored-By` trailer.
- Test count is not required to match the ticket's "six" — mirror the *shape* of the four existing `'real stream: ...'` tests (`ui/test/setup-driver.test.mjs:849,880,903,936`), not their count.

---

### Task 1: Stage the runtime once

**Files:** none (environment step only).

- [ ] **Step 1:** From the repo root on the Windows machine, run `.\scripts\stage-runtime.ps1` once so the app runs against the bundled CLI.
- [ ] **Step 2:** Confirm it exits 0 and the expected staged CLI path exists (per the script's own output).

Test-first: no — one-time environment setup, not logic; nothing to fail-then-pass.

No commit (no repo change).

---

### Task 2: Add temporary Windows debug logging to the driver

**Files:**
- Modify: `ui/setup-driver.js` (temporary only — reverted in Task 7)

**Interfaces:**
- Consumes: existing `onLog` callback param of `startSetup` (`ui/setup-driver.js:229`), existing call site `onLog?.(text)` inside `processChunk` (`ui/setup-driver.js:822`), `handleDetectedPrompt` (`ui/setup-driver.js:408`), `settleResolve`/`settleReject` (`ui/setup-driver.js:305,310`).
- Produces: a plaintext file at `%TEMP%\codemie-setup-debug.log`, appended to (not overwritten) for the duration of one recording session.

- [ ] **Step 1:** In `runSetup` (`ui/setup-driver.js:277`), add a small local helper, guarded so it only ever runs in this temporary build:

```js
// TEMP DEBUG — EPMCDME-14982, remove before commit (Task 7)
async function debugLog(tag, payload) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const line = `[${new Date().toISOString()}] ${tag} ${JSON.stringify(payload)}\n`;
  fs.appendFileSync(path.join(os.tmpdir(), 'codemie-setup-debug.log'), line);
}
```

- [ ] **Step 2:** Call `debugLog('chunk', { b64 })` at the top of `processChunk` (`ui/setup-driver.js:817`), before any parsing.
- [ ] **Step 3:** Call `debugLog('screen', { lines })` right after `readScreen()` is used to build `lines` inside `processChunk`, and `debugLog('prompt', { prompt })` right where `detectPrompt` result is dispatched into `handleDetectedPrompt` (`ui/setup-driver.js:874`).
- [ ] **Step 4:** Call `debugLog('resolve', { value })` inside `settleResolve` (`ui/setup-driver.js:305`) and `debugLog('reject', { error })` inside `settleReject` (`ui/setup-driver.js:310`), each before the existing body runs.
- [ ] **Step 5:** Rebuild the frontend bundle (`npm run build` or the project's existing dev-build command) since the app bundles `ui/` at build time and a `cargo tauri dev` session will not pick up an unbundled edit otherwise.

Test-first: no — this step only adds temporary observability, not behavior; there is no assertion to write against a logging call.

Commit: `EPMCDME-14982 : Add temporary Windows debug logging to setup-driver.js` (temporary; will be reverted by Task 7's commit).

---

### Task 3: Record a real Windows `codemie setup` session

**Files:** none (produces a raw log file consumed by Task 4).

- [ ] **Step 1:** Run `cargo tauri dev` from `src-tauri/` on the Windows machine.
- [ ] **Step 2:** In the running app, open Home, click the "Choose how CodeMie reaches a model" checklist item to open guided setup.
- [ ] **Step 3:** Drive one full run end-to-end: gate → storage → provider → url → project → model list (page through with arrow keys at least once) → custom model → profile name — on the profile-name step, deliberately submit a name the CLI will reject first (e.g. one that already exists, or a blank/whitespace value), observe the rejection, then submit a corrected value — → the "Switch to profile … as active?" confirm.
- [ ] **Step 4:** Copy `%TEMP%\codemie-setup-debug.log` somewhere safe (e.g. `docs/superpowers/tasks/2026-09-23-guided-setup-windows/windows-capture-raw.log`, not committed) before it is overwritten by any later run.

Test-first: no — this is a manual, one-time real-CLI capture; there is no automatable assertion at this step, only an artifact for Task 4 to analyze.

No commit (no repo change; the raw capture stays local/uncommitted).

---

### Task 4: Diagnose the capture and extract Windows fixtures

**Files:**
- Create: `ui/test/fixtures/setup/windows-*.json` (one or more, 30-line-array shape matching existing macOS fixtures under `ui/test/fixtures/setup/`)

**Interfaces:**
- Produces: fixture files consumed by Task 6's new tests, in the same shape `replay()`/`typedOut()` expect — an array of frames, each frame a 30-element array of strings (padded with `''` where the captured screen had fewer lines), matching the pattern at `ui/test/setup-driver.test.mjs:832` (`pad`).

- [ ] **Step 1:** Read the captured log from Task 3 and, for each `screen`-tagged entry, extract the parsed line array for the sequence covering: rejected profile-name attempt → correction → activate confirm (minimum spec-required coverage), plus any other phase where the log shows a chunk/echo/redraw shape that looks different from the macOS comments in `ui/setup-driver.js` (chunk boundaries, CRLF vs LF, ctrl-U line-clear, `>>` marker position, arrow-key list-nav redraw ordering, `AUTO_LIST`/`AUTO_CONFIRM` regex match against the actual Windows prompt text).
- [ ] **Step 2:** Save each extracted sequence as a fixture JSON file, e.g. `ui/test/fixtures/setup/windows-profile-name-correction.json` and `ui/test/fixtures/setup/windows-activate-confirm.json`, each a JSON array of 30-string-element frame arrays (no trailing padding needed in the file — the test's own `pad()` helper pads to 30 at load time, matching how existing macOS fixtures are stored).
- [ ] **Step 3:** For each of the six axes named in the spec's "Diagnose" phase (chunk/echo/repaint order, ctrl-U line-clear, arrow-key list nav, `AUTO_LIST`/`AUTO_CONFIRM` regex matches, `VALIDATION_ERROR_MARKER=/^>>/` positioning, CRLF-vs-LF), write one line in this task's commit body stating "matches macOS" or "diverges: <one-line description>" — this is the record Task 5 acts on.

Test-first: no — this is data extraction and comparison against existing constants/comments, not code under test; the fixtures it produces become Task 6's test inputs.

Commit: `EPMCDME-14982 : Add captured Windows PTY fixtures` (body: the per-axis diagnosis from Step 3).

---

### Task 5: Fix the driver only where Task 4 proved a divergence

**Files:**
- Modify: `ui/setup-driver.js` and, only if Task 4's diagnosis names it specifically, `ui/setup-parse.js` and/or `ui/setup-view.js`.

**Interfaces:**
- Consumes: whichever constant/helper Task 4 names as divergent — one of `IDLE_MS`, `VALIDATION_ERROR_MARKER`, `AUTO_LIST`, `AUTO_CONFIRM` (all in `ui/setup-driver.js:15-40` and nearby), or `detectPrompt`'s `PROMPTS` table in `ui/setup-parse.js`.
- Produces: unchanged public contract (`startSetup`/`cancelSetup` signatures, `onPrompt`/`onLog`/`onScreen` shapes) — a divergence fix must not change what callers see, only how the driver classifies/answers a Windows screen.

**If Task 4 found no divergence:** skip this task's fix steps; record in the commit for Task 6 that "no driver/parser fix was needed — Windows PTY output already matches the macOS-derived contract" and proceed straight to Task 6. Do not fabricate a change.

**If Task 4 found a divergence**, for each one:

- [ ] **Step 1:** Write a new unit test in `ui/test/setup-driver.test.mjs` (near the existing constant/behavior it targets) that replays the specific captured Windows frame sequence from Task 4's fixture and asserts the currently-wrong behavior — e.g. a wrong `seen` question list, or a write that doesn't match the expected `ans(...)` re-answer — confirming the test fails against today's code.
- [ ] **Step 2:** Run `node --test ui/test/setup-driver.test.mjs` and confirm this new test fails, matching the confirmed divergence.
- [ ] **Step 3:** Apply the minimal platform-neutral fix to `ui/setup-driver.js` (or `ui/setup-parse.js`/`ui/setup-view.js` only if Task 4 pinned the divergence there specifically) — prefer a fix that also still passes every existing macOS `'real stream: ...'` test unmodified. Only introduce an `isWin` fork if a platform-neutral fix is provably impossible (e.g. the two PTYs need genuinely opposite handling of the same signal) and say so in the commit body.
- [ ] **Step 4:** Rebuild the frontend bundle, then re-run `node --test ui/test/setup-driver.test.mjs` and confirm the new test now passes and every existing macOS test still passes.

Test-first: yes — each divergence fix starts from a failing replay test built from the captured Windows fixture, per Step 1/2 above.

Commit: `EPMCDME-14982 : Fix <named divergence> for Windows PTY` (one commit per divergence, or a single commit noting "no fix needed" if Task 4 found none).

---

### Task 6: Add Windows real-stream tests

**Files:**
- Modify: `ui/test/setup-driver.test.mjs` (append new tests near the existing `'real stream: ...'` block, `ui/test/setup-driver.test.mjs:849-1000`)
- Consume: fixtures created in Task 4 under `ui/test/fixtures/setup/windows-*.json`

**Interfaces:**
- Consumes: `replay(frames, answers)` (`ui/test/setup-driver.test.mjs:829`), `typedOut(prefix, text)` (`ui/test/setup-driver.test.mjs:827`), `ans(text)` (`ui/test/setup-driver.test.mjs:11`), `makeFakePty()`/`makeFakeTerminal()` (used identically to the existing macOS tests), `startSetup` from `ui/setup-driver.js`.
- Produces: nothing consumed by later tasks — these are terminal test cases.

- [ ] **Step 1:** Add a Windows-equivalent of the "re-ask-once correction" test, built from the `windows-profile-name-correction.json` fixture (Task 4), mirroring the shape of `ui/test/setup-driver.test.mjs:849-878`:

```js
test('real stream (windows): a rejected profile name is re-asked once and the correction is accepted', async () => {
  const frames = JSON.parse(readFileSync(fixturePath('windows-profile-name-correction.json'), 'utf8'));
  const { seen, writes, result } = await replay(frames, ['taken-name', 'fresh-name']);
  assert.equal(seen.filter((q) => q.startsWith('Enter a name for this profile')).length, 2,
    'the rejected name is asked once, the correction accepted without a third ask');
  assert.deepEqual(writes.slice(-1), [ans('fresh-name')]);
  assert.equal(result.profileName, 'fresh-name');
});
```

(Adjust the literal `seen`/`writes` assertions to match what the captured fixture actually shows — the frames are Task 4's real data, so the exact question text and write bytes come from there, not from this plan.)

- [ ] **Step 2:** Add a second test for the activate-confirm scenario, built from `windows-activate-confirm.json`, asserting the final write is `'y\r'` (or the fixture's actual captured confirm answer) and that `result.profileName` is set — mirroring `ui/test/setup-driver.test.mjs:849-878`'s final two assertions.
- [ ] **Step 3:** If `readFileSync`/`fixturePath` helpers for loading a named fixture by filename don't already exist in the test file, add a one-line helper next to the existing `fixture(id)` loader (per the technical analysis, fixtures are loaded via `readFileSync`/`fileURLToPath` relative to the test file's own URL) rather than inlining path-joining logic in each test.
- [ ] **Step 4:** Run `node --test ui/test/setup-driver.test.mjs` and confirm the two new tests pass and every existing test (macOS and any from Task 5) still passes.

Test-first: yes — Step 1/2 write the new assertions against real captured frames; Step 4 is the first green run confirming they pass without having existed before.

Commit: `EPMCDME-14982 : Add Windows real-stream tests for profile-name correction and activate confirm`

---

### Task 7: Remove debug logging, run gates, verify end-to-end

**Files:**
- Modify: `ui/setup-driver.js` (revert Task 2's temporary logging additions)

- [ ] **Step 1:** Remove every line added in Task 2 (`debugLog` helper and its four call sites) from `ui/setup-driver.js`. Confirm with `git diff ui/setup-driver.js` against the pre-Task-2 state (or a targeted grep for `debugLog`/`codemie-setup-debug.log`) that nothing temporary remains.
- [ ] **Step 2:** Rebuild the frontend bundle.
- [ ] **Step 3:** Run the four gates: `npm test` (repo root), `cargo fmt --check` (from `src-tauri/`), `cargo clippy -- -D warnings` (from `src-tauri/`), `cargo test` (from `src-tauri/`). All four must pass.
- [ ] **Step 4:** On the real Windows machine, do one final manual `cargo tauri dev` walkthrough of Home → guided setup → a full `codemie setup` run ending at the activate confirm, then open `%USERPROFILE%\.codemie\codemie-cli.config.json` and confirm the newly created profile is the active one.

Test-first: no — Step 1 is a removal (nothing to fail-then-pass), and Step 4 is manual DoD verification; Step 3's gate run is this task's own check, not a new test to write (the automated tests it runs were already written test-first in Tasks 5/6).

Commit: `EPMCDME-14982 : Remove temporary Windows debug logging`

---

## Self-Review

**Spec coverage:**
- Record phase → Tasks 2-3. Diagnose/fix-if-proven phase → Tasks 4-5. Test phase → Task 6. Clean-up/verify phase → Task 7. All four spec phases have a task.
- Acceptance criteria: "same decisions/order as macOS" → Task 5 (platform-neutral fix preference) + Task 6/7 (macOS tests untouched, still green). "Rejected answer re-asked once, correction accepted" → Task 6 Step 1. "Activate confirm ends with new profile active" → Task 6 Step 2 (automated) + Task 7 Step 4 (manual DoD). "No question shown the CLI isn't waiting on" → covered by Task 5's fix-only-if-proven discipline plus the existing driver's dedup guards, unchanged unless proven wrong. "Windows recordings as tests in the shape of existing tests" → Task 6. "macOS untouched" → Global Constraints + Task 5/6/7 explicit checks. "Walked end-to-end on real Windows machine" → Task 3 (recording) + Task 7 Step 4 (final verification). "Four gates pass" → Task 7 Step 3.
- Non-goals respected: no task touches `ui/handlers.js`, `config/steps-windows.yaml`, or `src-tauri`; no task adds a Rust test for `spawn_pty`; no task adds `isWin` branching preemptively (Task 5 only allows it as a last resort with justification); one MR (no task creates a second).

**Placeholder scan:** no TBD/TODO; Task 6's example test code is explicitly flagged as needing the real fixture's actual values, which is unavoidable since the fixture doesn't exist until Task 4 runs — the plan states exactly which assertions to adapt and against what data, not "add appropriate assertions."

**Type/name consistency:** `startSetup`, `onPrompt`/`onLog`/`onScreen`, `replay`/`typedOut`/`ans`, `makeFakePty`/`makeFakeTerminal`, `detectPrompt` are used identically to their existing signatures across Tasks 2, 5, and 6 — no renamed helper.

**Negative-constraint pass:**
- "No src-tauri change" — no task modifies any file under `src-tauri/`; Task 7's gates run `cargo` commands but don't edit Rust source. Satisfied.
- "Do not touch `ui/handlers.js`/`config/steps-windows.yaml`" — no task names these files. Satisfied.
- "Existing macOS fixtures/tests untouched" — Task 5 Step 4 and Task 6 Step 4 both require the pre-existing macOS tests to still pass unmodified; no task's Files section lists any existing fixture file or existing test by name for modification, only "append new tests." Satisfied.
- "Do not add `isWin` branching preemptively" — Task 5 only permits it as a last-resort, justified-in-commit exception, not a default. Satisfied.
- "Don't add a whole-suite gate-running task or a manual-verification task as their own top-level tasks" — the four gates and the final E2E walkthrough are Task 7's own Steps 3-4, not separate tasks. Satisfied.
- "Matching the literal 'six' test count" is explicitly a non-goal — Task 6 adds two tests (spec's stated minimum coverage) and does not claim to hit six. Satisfied.
- negative-constraints: all covered above; none skipped.
