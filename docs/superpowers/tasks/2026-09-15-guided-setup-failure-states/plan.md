# EPMCDME-14588 — Guided Setup Failure States (UI remainder) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the two CLI-visible guided-setup failures (Ollama not running, CodeMie unreachable / auth timeout) in the UI — one as a step-level error, one as a flow-stopping notice with a working retry — using the already-committed driver/parser, without touching their existing behavior beyond one small additive callback.

**Architecture:** `showNotice`/`hideNotice` move out of `ui/renderer.js` into a new, window-free `ui/notice.js` (extended with a secondary action and a string-or-Node body), so they can be unit-tested without pulling in `window.__TAURI__`; `renderer.js` re-imports them and every existing call site is unchanged. `ui/setup-driver.js` gains one small additive callback, `onScreen(lines)`, fired once per processed PTY chunk right where it already reads the settled screen — so callers get parsed, ANSI-free lines instead of re-deriving them from raw log text. `ui/setup-view.js` classifies failures via `ui/setup-parse.js`'s existing `detectFailure(lines)`, called two ways: `ollamaDown` reaches the view through a genuine driver rejection (`err.raw`), classified inside `handleReject(err)`; `authTimeout` is a warning the CLI's own flow continues past, so it is detected proactively from the new `onScreen` callback's lines, never from `onLog`'s raw/ANSI text. Both non-cancelled paths converge: `ollamaDown` → step-level `StepStatus.ERROR`; `authTimeout` or any other non-step-scoped rejection → `showNotice` with "Try again" (cancel-then-restart) and "Show details" (raw output inside the notice body).

**Tech Stack:** Vanilla ESM, `node:test` + `node:assert/strict`, hand-rolled DOM stub (no jsdom).

**Spec:** Requirements supplied inline for this task (no separate spec doc) — see Acceptance criteria below, and `docs/superpowers/tasks/2026-09-15-guided-setup-failure-states/technical-analysis.md` for the codebase research this plan is built from. This revision folds in reviewer feedback on the prior draft (untestable Task 1 target, wrong classification data source in Task 3, missing cancelled-retry short-circuit).

## Global Constraints

- CLI-own-words only: every user-visible failure message is the CLI's own text from `detectFailure`'s `message`, never invented UI copy.
- No new module imports `pty` or listens to `engine:pty-*` directly.
- Never hand-write CLI-screen fixtures — reuse the committed `ui/test/fixtures/setup/authTimeout.json` and `ollamaNotRunning.json` via `detectFailure`.
- `ui/setup-view.js` must never statically import anything window/Tauri-touching (existing header rule) — new dependencies (`showNotice`, `hideNotice`, `cancelSetup`) go through the same lazy `deps` pattern as `startSetup`/`readConfig`.
- `ui/notice.js` must never import `runner-bridge.js` or anything touching `window.__TAURI__` — it is a plain DOM module, importable by a `node:test` file with only a notice-subtree DOM stub.
- Do not modify `ui/setup-parse.js` content at all — import `detectFailure` only. `ui/setup-driver.js` gets exactly one small additive change (a new optional `onScreen` callback param, one new call site) — no other line in that file changes.
- Do not implement replay or step-revisit (EPMCDME-14656) — capture step values only, hold in memory.
- No separate raw-output panel and no new error visual style — reuse the notice body and `StepStatus.ERROR`'s existing icon/color.
- Keep every existing single-action `showNotice` caller (`renderer.js:340`, `:367`, `:375`, `:398`) working unchanged.
- `cancelSetup()`'s rejection (`{ step: null, cancelled: true, ... }`) must never be classified as a failure — `handleReject` short-circuits on it before any other logic.
- Commit per task using the repository's existing convention.
- No task runs the whole quality-gate suite, manual/browser verification, code review, or artifact commits as its own step — those are the calling flow's stages; each task's own tests live inside that task's `Test-first` line.

## Acceptance criteria

- [ ] A re-asked prompt after a failure is dispatched, not swallowed (already done by the driver — no plan task needed).
- [ ] CodeMie-unreachable / auth timeout is reported as that specific failure, in the CLI's own words ("Authentication timeout - no response received"), and leaves no partial profile.
- [ ] Ollama-not-running stops its step, reports the CLI's own words ("Ollama is not running"), and saves no profile.
- [ ] Both notice-shown failures expose the driver rejection's raw screen output inside the notice body itself, never a separate widget.
- [ ] "Try again" ends the current run and its child process via `cancelSetup()`, fully awaited, before starting a fresh run — never two `codemie setup` processes alive at once — and that cancel's own rejection is never itself rendered as a failure.
- [ ] No profile is written on any failure path.
- [ ] `showNotice`/`hideNotice` support an optional secondary action and a string-or-DOM-Node body, live in a testable module, and every existing single-action caller keeps working unchanged.
- [ ] Failure classification for the flow-stopping case uses parsed terminal lines, never raw ANSI log text.
- [ ] No new module imports `pty` or listens to `engine:pty-*` directly.

negative-constraints: see "Explicitly out of scope" below — each is mapped to the task that honors it.

## Explicitly out of scope (and which task honors it)

- Touching `ui/setup-parse.js` content, or anything in `ui/setup-driver.js` beyond the one new `onScreen` callback → Task 3 adds only that callback; Tasks 2 and 4 only `import` from these modules.
- Replay / step-revisit (EPMCDME-14656) → Task 5 only stores values in a `Map`; no task reads or replays it.
- A separate raw-output panel → Task 4 renders raw output as a child node appended inside the notice body element itself.
- A new error visual style → Task 2 calls the existing `markError`/`StepStatus.ERROR`, no new CSS/icon.
- Importing `pty` / listening to `engine:pty-*` → no task touches those modules; verified per-task by grep in each task's own review.
- Classifying `authTimeout` from raw/ANSI `onLog` text → Task 4 consumes Task 3's parsed-lines callback instead.
- A cancel-for-retry being misclassified as a failure → Task 2's first step in `handleReject` is the `cancelled` short-circuit, landing before any other task's classification logic touches that function.

---

### Task 1: Extract `showNotice`/`hideNotice` into `ui/notice.js` with a secondary action and Node-or-string body

**Files:**
- Create: `ui/notice.js`
- Modify: `ui/renderer.js:92-96` (remove notice element refs, now owned by `notice.js`), `:211-229` (delete local `showNotice`/`hideNotice`, import from `./notice.js` instead), `:1-14` (add the import)
- Modify: `ui/index.html:249-258` (notice markup — add `#notice-secondary`)
- Create: `ui/test/notice.test.mjs`

**Interfaces:**
- Produces: `export function showNotice({ title, message, primaryLabel, primaryAction, secondaryLabel, secondaryAction })` from `ui/notice.js` — `message` may be a `string` (sets `textContent`, current behavior) or a DOM `Node` (appended as a child, after clearing prior content). `secondaryLabel`/`secondaryAction` are optional; omitting them keeps today's single-button behavior exactly. `export function hideNotice()`. Neither function touches `window.__TAURI__`; the module's only DOM dependency is `document.getElementById` on the six `#notice-*` ids.

- [ ] **Step 1: Write the failing tests**

`ui/test/notice.test.mjs`, following `ui/test/setup-view.test.mjs`'s `makeEl`/`findByClass` DOM-stub convention, stubbing only `#notice-overlay`, `#notice-title`, `#notice-message`, `#notice-primary`, `#notice-secondary`, `#notice-close` behind a `document.getElementById` stub, then importing `{ showNotice, hideNotice }` from `../notice.js` (nothing else — confirm no transitive import touches `runner-bridge.js` or `window.__TAURI__`). Cover: (a) an existing single-action call (`primaryLabel`/`primaryAction` only) shows the primary button and clears the overlay's `hidden` class, secondary button stays hidden; (b) a `secondaryLabel`/`secondaryAction` call shows both buttons, and clicking secondary calls `hideNotice()` then the action; (c) a string `message` sets `textContent`; (d) a DOM-Node `message` is appended as a child and `textContent` is left empty; (e) `hideNotice()` re-adds the `hidden` class.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test ui/test/notice.test.mjs`
Expected: FAIL — `ui/notice.js` does not exist yet.

- [ ] **Step 3: Add the secondary button to the markup**

`ui/index.html:253-255` — inside `#notice-actions`, add a second button between `#notice-primary` and `#notice-close`:
```html
<button id="notice-secondary" class="btn btn-ghost hidden"></button>
```

- [ ] **Step 4: Create `ui/notice.js`**

```js
// Notice modal — a plain DOM module with no window.__TAURI__ dependency, so
// it is importable and testable headlessly. ui/renderer.js is the only
// production caller; ui/setup-view.js reaches it via deps-injection
// (EPMCDME-14588) rather than a static import, per its own header rule.
const noticeOverlay = document.getElementById('notice-overlay');
const noticeTitle = document.getElementById('notice-title');
const noticeMessage = document.getElementById('notice-message');
const noticePrimary = document.getElementById('notice-primary');
const noticeSecondary = document.getElementById('notice-secondary');
const noticeClose = document.getElementById('notice-close');

export function showNotice({ title, message, primaryLabel, primaryAction, secondaryLabel, secondaryAction }) {
  noticeTitle.textContent = title;
  if (typeof message === 'string') {
    noticeMessage.replaceChildren();
    noticeMessage.textContent = message;
  } else {
    noticeMessage.replaceChildren();
    if (message) noticeMessage.appendChild(message);
  }
  if (primaryLabel) {
    noticePrimary.textContent = primaryLabel;
    noticePrimary.classList.remove('hidden');
    noticePrimary.onclick = () => { hideNotice(); if (primaryAction) primaryAction(); };
  } else {
    noticePrimary.classList.add('hidden');
  }
  if (secondaryLabel) {
    noticeSecondary.textContent = secondaryLabel;
    noticeSecondary.classList.remove('hidden');
    noticeSecondary.onclick = () => { hideNotice(); if (secondaryAction) secondaryAction(); };
  } else {
    noticeSecondary.classList.add('hidden');
  }
  noticeOverlay.classList.remove('hidden');
}

export function hideNotice() {
  noticeOverlay.classList.add('hidden');
}

noticeClose.addEventListener('click', hideNotice);
```
Note: the close-button wiring moves here too (it only ever manipulates notice elements), so `renderer.js:672`'s `noticeClose.addEventListener(...)` line is deleted rather than duplicated.

- [ ] **Step 5: Wire `renderer.js` to the new module**

`ui/renderer.js:92-96` — delete the six notice `const` lines (now owned by `notice.js`).
`ui/renderer.js:211-229` — delete the local `showNotice`/`hideNotice` function bodies.
`ui/renderer.js:1-14` — add `import { showNotice, hideNotice } from './notice.js';` near the other local imports. Existing callers at `:340`, `:367`, `:375`, `:398` and the (now-deleted) `:672` close-wiring need no other change — same names, same call shapes.

- [ ] **Step 6: Run and confirm pass**

Run: `node --test ui/test/notice.test.mjs`
Expected: PASS, all 5 cases.

- [ ] **Step 7: Mutation-check**

Temporarily revert the `secondaryLabel`/`secondaryAction` wiring in `showNotice` (Step 4) to a no-op, re-run the suite, confirm exactly the secondary-action test (case b) fails and no other. Restore.

- [ ] **Step 8: Commit**

Test-first: yes — `ui/test/notice.test.mjs` fails (module-not-found, then behavior gaps) before Steps 3-5 land.

---

### Task 2: Classify a driver rejection: cancelled short-circuit, then `ollamaDown` as a step-level error

**Files:**
- Modify: `ui/setup-view.js:13` (import), `:617-646` (`handleReject`)
- Modify: `ui/test/setup-view.test.mjs` (extend)

**Interfaces:**
- Consumes: `detectFailure(lines)` from `./setup-parse.js`, returning `null | { id: 'authTimeout' | 'ollamaDown', message, line }` (already committed, unmodified). `markError(rowId)` (`:403`, unchanged signature). `err.raw` — always a `string` on every driver rejection. `err.cancelled` — `true` only on `cancelSetup()`'s own rejection (`{ step: null, cancelled: true, message: 'setup cancelled', raw: ... }`).
- Produces: `handleReject(err)` now (a) returns immediately, doing nothing, when `err?.cancelled === true`; (b) otherwise, when `detectFailure` classifies the rejection as `ollamaDown`, sets the resolved row's subtitle to the CLI's own message in addition to `markError`. Every other case (`null`, or `authTimeout`) falls through unchanged for now — Task 4 adds the notice branch there.

- [ ] **Step 1: Write the failing tests**

Extend `ui/test/setup-view.test.mjs`:
1. Drive `run()` with a fake `startSetup` that rejects with `{ step: null, cancelled: true, message: 'setup cancelled', raw: 'whatever' }`. Assert no row's status changed (snapshot row statuses before/after) and that a fake `showNotice` (passed via `deps`, unused otherwise in this task) was never called.
2. Drive `run()` with a fake `startSetup` that rejects with `{ step: null, message: 'setup exited with code 1', raw: fixtureText('ollamaNotRunning') }` (load the fixture's lines and `.join('\n')` them — never hand-write the screen text). Assert the row `markError` targets ends up `StepStatus.ERROR` with subtitle `'Ollama is not running'` (the fixture's own anchor text, matching `ui/test/setup-parse.test.mjs`'s existing assertion for the same fixture).

- [ ] **Step 2: Run and confirm failure**

Run: `node --test ui/test/setup-view.test.mjs`
Expected: FAIL — the cancelled rejection still runs `markError`; the ollamaDown subtitle is unset.

- [ ] **Step 3: Add the short-circuit and the classification**

`ui/setup-view.js:13` — add `detectFailure` to an import from `./setup-parse.js` (a pure, no-window module like `models.js` — confirmed safe to import statically; add the import line if none exists yet).

`ui/setup-view.js:617` — at the very top of `handleReject(err)`, before any existing branch: `if (err?.cancelled === true) return;` — a deliberate cancel-for-retry must never be classified or rendered as a failure.

`ui/setup-view.js:618-646` — after the short-circuit, compute `const failure = err && typeof err.raw === 'string' ? detectFailure(err.raw.split('\n')) : null;`. Keep every existing row-targeting branch (`step`/`'model'`/`activeRowId`/`transient`/`lastRowId`) exactly as today to pick `rowId`; once resolved, if `failure?.id === 'ollamaDown'`, call `markError(rowId)` then `stepsUi.setSubtitle(rowId, failure.message)` and stop (no notice).

- [ ] **Step 4: Run and confirm pass**

Run: `node --test ui/test/setup-view.test.mjs`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Temporarily delete the `if (err?.cancelled === true) return;` line, re-run the suite, confirm exactly the cancelled-rejection test fails. Restore. Then temporarily hard-code `const failure = null;`, re-run, confirm exactly the ollamaDown test fails. Restore.

- [ ] **Step 6: Commit**

Test-first: yes — both new assertions in `ui/test/setup-view.test.mjs` fail until Step 3 lands.

---

### Task 3: Add a settled-screen callback to `setup-driver.js`'s `startSetup`

**Files:**
- Modify: `ui/setup-driver.js:224` (`startSetup`'s destructured options), `:810-812` (`processChunk`)
- Modify: `ui/test/setup-driver.test.mjs` (extend)

**Interfaces:**
- Produces: `startSetup({ onPrompt, onLog, replay, onScreen } = {}, deps = {})` — `onScreen`, if supplied, is called once per processed PTY chunk as `onScreen(lines)`, where `lines` is the same settled-screen array (`readScreen()`'s return value — plain strings, one per terminal row, ANSI already stripped) the driver already computes internally at this point. Passing the lines rather than `detectFailure(lines)`'s result keeps the driver's public surface free of any dependency on `setup-parse.js`'s specific failure shape; callers run `detectFailure` themselves.

- [ ] **Step 1: Write the failing test**

Extend `ui/test/setup-driver.test.mjs`: using the existing fixture-driven PTY-chunk-replay pattern already in that file, call `startSetup({ onPrompt: fakeOnPrompt, onScreen: recordScreen }, deps)` where `recordScreen` pushes a copy of each `lines` array it receives into a local array. Feed the `authTimeout` fixture's chunks one at a time (same replay mechanism the file already uses for other fixture-driven cases). Assert: `onScreen` fires exactly once per processed chunk (same count as chunks fed), and that `detectFailure(lastLines)` on the last recorded `lines` array classifies as `{ id: 'authTimeout', ... }` with the fixture's own message — i.e., the callback really is receiving the settled, parsed screen, not raw text (import `detectFailure` from `./setup-parse.js` in the test only, to make the assertion — the driver itself does not call it).

- [ ] **Step 2: Run and confirm failure**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: FAIL — `onScreen` is never called (option doesn't exist yet).

- [ ] **Step 3: Add the callback**

`ui/setup-driver.js:224` — add `onScreen` to the destructured options: `export async function startSetup({ onPrompt, onLog, replay, onScreen } = {}, deps = {})`.

`ui/setup-driver.js:810-812` — immediately after the existing `const lines = readScreen(); const prompt = detectPrompt(lines);`, add `onScreen?.(lines);`. No other line in `processChunk` or elsewhere in the file changes.

- [ ] **Step 4: Run and confirm pass**

Run: `node --test ui/test/setup-driver.test.mjs`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Temporarily delete the `onScreen?.(lines);` line, re-run the suite, confirm exactly the new test fails and every pre-existing test still passes. Restore.

- [ ] **Step 6: Commit**

Test-first: yes — the new `onScreen` call-count/content assertion in `ui/test/setup-driver.test.mjs` fails until Step 3 lands.

---

### Task 4: Flow-stopping notice for `authTimeout` / non-step-scoped rejections, with working "Try again"

**Files:**
- Modify: `ui/setup-view.js:285-323` (`createSetupView` deps + closure state), `:663-713` (`run()`, wiring `onScreen` into `startSetup`), `:617-646` (continuing Task 2's `handleReject`)
- Modify: `ui/renderer.js:502` (`boot()`'s dev-console call site)
- Modify: `ui/test/setup-view.test.mjs` (extend)

**Interfaces:**
- Consumes: `cancelSetup()` and `startSetup(...)` from `./setup-driver.js` (`startSetup` now also accepting `onScreen`, per Task 3); `showNotice`/`hideNotice` from `./notice.js` (Task 1); `detectFailure` from `./setup-parse.js` (Task 2's import).
- Produces: `createSetupView(container, deps)` now accepts `deps.showNotice`, `deps.hideNotice`, `deps.cancelSetup`, each lazily defaulted via dynamic `import()` from `./notice.js` / `./setup-driver.js` (same pattern as `deps.startSetup` at `:316-319`). A closure-scoped `noticeFailureShown` flag, reset each `run()`, so `authTimeout` is acted on once per run, not once per PTY chunk. A module-private `openFailureNotice(message, raw)` helper called from both the new `onScreen` handler and `handleReject`'s fallthrough.

- [ ] **Step 1: Write the failing tests**

Extend `ui/test/setup-view.test.mjs` with fakes for `showNotice` (records its call args) and `cancelSetup`/`startSetup` (recording call order via a shared array), passed through `deps`. Cover:
  1. Driving the fake `startSetup`'s `onScreen` callback (captured from the call args `run()` passes to it) with the `authTimeout` fixture's settled lines triggers exactly one `showNotice` call, with `primaryLabel: 'Try again'`, `secondaryLabel: 'Show details'`, and a `message` that is a DOM Node whose rendered text contains the CLI's own reason text.
  2. A generic rejection with no step scope and no `detectFailure` match (e.g. `{ step: null, message: 'unrecognized prompt, run stalled', raw: '' }`) also produces exactly one `showNotice` call via `handleReject`'s fallthrough.
  3. Invoking the notice's `primaryAction` (from the fake `showNotice`'s recorded call args) calls the fakes in order `cancelSetup()` (awaited) then `startSetup()` again — assert via a shared call-order array that `cancelSetup` resolves before `startSetup` is invoked again.
  4. The `cancelled: true` rejection from Task 2 still produces zero `showNotice` calls here too (guards against a regression where this task's fallthrough re-adds a notice for the cancelled case).

- [ ] **Step 2: Run and confirm failure**

Run: `node --test ui/test/setup-view.test.mjs`
Expected: FAIL — `showNotice` fake is never called; `onScreen` isn't passed to `startSetup` yet.

- [ ] **Step 3: Thread the three new deps and the per-run flag**

`ui/setup-view.js:285` — add `let noticeFailureShown = false;` near the other per-run closure flags (`activeRowId`/`lastRowId`).

`ui/setup-view.js:316-323` — add, using the exact same lazy-default shape as `startSetup`/`readConfig`:
```js
const showNoticeFn = deps.showNotice ?? (async (...args) => {
  const mod = await import('./notice.js');
  return mod.showNotice(...args);
});
const hideNoticeFn = deps.hideNotice ?? (async (...args) => {
  const mod = await import('./notice.js');
  return mod.hideNotice(...args);
});
const cancelSetupFn = deps.cancelSetup ?? (async (...args) => {
  const mod = await import('./setup-driver.js');
  return mod.cancelSetup(...args);
});
```

- [ ] **Step 4: Build the notice body and the retry handler**

Add a module-private helper near `handleReject`:
```js
function openFailureNotice(message, raw) {
  if (noticeFailureShown) return;
  noticeFailureShown = true;
  const body = document.createElement('div');
  const summary = document.createElement('div');
  summary.textContent = message;
  const rawEl = document.createElement('pre');
  rawEl.className = 'notice-raw';
  rawEl.textContent = raw;
  body.appendChild(summary);
  body.appendChild(rawEl);
  showNoticeFn({
    title: 'Setup stopped',
    message: body,
    primaryLabel: 'Try again',
    primaryAction: async () => { await cancelSetupFn(); start(); },
    secondaryLabel: 'Show details',
    secondaryAction: () => {}, // the raw output is already in the body; this just re-opens/keeps it visible
  });
}
```

- [ ] **Step 5: Wire the proactive `authTimeout` path via `onScreen` (not `onLog`)**

`ui/setup-view.js:663-713` (`run()`) — change the `startSetup` call at `:700` to `startSetup({ onPrompt, onLog, onScreen: handleScreen })`, and add a module-private `handleScreen(lines)` that calls `const failure = detectFailure(lines);` and, when `failure?.id === 'authTimeout'`, calls `openFailureNotice(failure.message, lines.join('\n'))`. This replaces any raw-`onLog`-text scanning — `handleScreen` only ever sees the parsed, settled lines Task 3's callback provides.

- [ ] **Step 6: Wire `handleReject`'s fallthrough (continuing Task 2)**

`ui/setup-view.js:617-646` — where Task 2 left the non-`ollamaDown`, non-`cancelled` cases falling through unchanged, add, after the existing row-marking branches run (so the row still gets a terminal status): `if (failure?.id !== 'ollamaDown') openFailureNotice(failure?.message ?? err.message, err.raw ?? '');`. Because Task 2's `cancelled` short-circuit already returned before this point, this line never runs for a cancel-for-retry.

- [ ] **Step 7: Reset the per-run flag**

`ui/setup-view.js:663-675` (`run()`) — add `noticeFailureShown = false;` to the existing block that clears `occurrenceCounts`/`activeRowId`/etc. at the top of every run.

- [ ] **Step 8: Wire the real deps at the one production call site**

`ui/renderer.js:502` — change `createSetupView(document.getElementById('setup-view'))` to `createSetupView(document.getElementById('setup-view'), { showNotice, hideNotice })` (both now in scope via Task 1's `./notice.js` import).

- [ ] **Step 9: Run and confirm pass**

Run: `node --test ui/test/setup-view.test.mjs`
Expected: PASS, all 4 new cases plus every pre-existing test.

- [ ] **Step 10: Mutation-check**

Temporarily make `openFailureNotice` an early-return no-op, re-run the suite, confirm exactly the notice/retry tests fail (cases 1-3) and every pre-existing test, including case 4 (cancelled), still passes. Restore.

- [ ] **Step 11: Commit**

Test-first: yes — the 4 new `showNotice`/retry-ordering/cancelled-guard assertions in `ui/test/setup-view.test.mjs` fail until Steps 3-7 land.

---

### Task 5: Capture each answered step's value for a later ticket (EPMCDME-14656)

**Files:**
- Modify: `ui/setup-view.js:285-287` (closure state), `:471-476` (`renderControl`'s `submit`), `:715` (return value)
- Modify: `ui/test/setup-view.test.mjs` (extend)

**Interfaces:**
- Produces: a closure-scoped `const answeredValues = new Map();` inside `createSetupView`, keyed by `prompt.id`, holding the most recently submitted `value` for that id. Not read by any other task or module — purely a data-capture point for EPMCDME-14656 to build on later.

- [ ] **Step 1: Write the failing test**

Extend `ui/test/setup-view.test.mjs`: drive a run through `onPrompt` for a couple of prompt ids with a fake `startSetup` that lets the test submit answers via the row's rendered control (same pattern the existing prompt-answering tests already use), then assert — via a test-only accessor added to `start()`'s return value, `getAnsweredValues: () => new Map(answeredValues)` — that the returned map holds each id's submitted value.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test ui/test/setup-view.test.mjs`
Expected: FAIL — `getAnsweredValues` is undefined.

- [ ] **Step 3: Add the capture map and expose it**

`ui/setup-view.js:285-287` — add `const answeredValues = new Map();` alongside `occurrenceCounts`.

`ui/setup-view.js:471-476` (inside `renderControl`'s `submit(value, humanText)`) — add `answeredValues.set(prompt.id, value);` as the first line of `submit`, before `clearControls(host)`.

`ui/setup-view.js:715` — change `return { start };` to `return { start, getAnsweredValues: () => new Map(answeredValues) };` (a defensive copy, so a caller can't mutate the view's own state).

- [ ] **Step 4: Run and confirm pass**

Run: `node --test ui/test/setup-view.test.mjs`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Temporarily remove the `answeredValues.set(...)` line from `submit`, re-run the suite, confirm exactly the new capture test fails. Restore.

- [ ] **Step 6: Commit**

Test-first: yes — the new `getAnsweredValues` assertion in `ui/test/setup-view.test.mjs` fails until Step 3 lands.

---

## Self-Review Notes

- **Coverage:** every acceptance-criteria line maps to a task — extraction/secondary-action/Node body (Task 1); cancelled short-circuit + ollamaDown step error (Task 2); driver callback (Task 3); authTimeout + generic-rejection notice, raw-in-body, Try again ordering, no-profile-on-failure (Task 4, which never calls anything that writes a profile); step-value capture (Task 5).
- **Negative-constraints re-check:**
  - Touching `setup-parse.js` / broad `setup-driver.js` changes → not violated: Task 3 is the only edit to `setup-driver.js` and is exactly one destructured option plus one call site; no task edits `setup-parse.js`.
  - Replay/step-revisit → not violated: Task 5 only writes to a `Map`; nothing reads it.
  - Separate raw-output panel → not violated: Task 4 Step 4 appends the raw `<pre>` inside the notice body node itself.
  - New error visual style → not violated: Task 2 uses the existing `markError`/`StepStatus.ERROR` only.
  - `pty` / `engine:pty-*` → not violated: no task imports `pty` or subscribes to `engine:pty-*`; all new imports are `./notice.js`, `./setup-parse.js`, `./setup-driver.js` — all already-vetted modules.
  - Classifying `authTimeout` from raw `onLog` text → not violated: Task 4 Step 5 wires `handleScreen` off Task 3's `onScreen(lines)` callback, never off `onLog`'s text.
  - Cancel-for-retry misclassified as a failure → not violated: Task 2 Step 3 puts the `err?.cancelled === true` check as literally the first line of `handleReject`, before Task 2's own `ollamaDown` classification and before Task 4's fallthrough notice logic, and Task 4's own test suite (case 4) re-asserts this holds after Task 4's changes land.
- **Type/signature consistency:** `detectFailure(lines)` → `{ id, message, line } | null` used identically in Tasks 2 and 4; `startSetup({ onPrompt, onLog, replay, onScreen })` defined in Task 3, consumed with that exact shape in Task 4 Step 5; `openFailureNotice(message, raw)` defined once in Task 4 Step 4, called from both Step 5 (`handleScreen`) and Step 6 (`handleReject`) with the same two-argument shape; `showNotice`'s extended signature from Task 1 (`primaryLabel/primaryAction/secondaryLabel/secondaryAction`, `message: string | Node`) is exactly what Task 4's `openFailureNotice` calls.
