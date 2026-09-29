# Technical Research

**Task**: guided-setup ui-notice steps-ui renderer failure-states
**Generated**: 2026-09-15T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14588 — CodeMie Desktop: Guided setup — failure states (UI portion only; driver/parser already committed on this branch in commits ec0ce62 and 5d3fd54).

Remaining scope to implement:
1. Extend `showNotice` (ui/renderer.js:212 area) to accept an optional secondary action alongside the existing single action, and to accept either a string or a DOM node as the body (currently sets body via textContent). Export `showNotice` and `hideNotice` from ui/renderer.js (currently not exported). Markup is in ui/index.html around lines 249-256 (#notice-primary, #notice-close). Close handler is wired at ui/renderer.js:672. Keep existing single-action callers (e.g. Connect Claude Desktop auth gate) working unchanged.
2. In ui/setup-view.js: render failure state two ways —
   - step-level StepStatus.ERROR (from ui/models.js) for a failure confined to one step (the Ollama-not-running case: message "Ollama is not running" in CLI's own words, no profile written)
   - showNotice with "Try again" + "Show details" for a failure that stops the whole flow (the CodeMie-unreachable / SSO auth timeout case: message "Authentication timeout - no response received")
   setup-view.js already has named seams for this ticket: markError(rowId) at ~:403 ("EPMCDME-14588 puts the retry affordance here"), handleReject(err) at ~:617, and start() at ~:657 which resolves { ok: false, error } and never rejects.
3. "Show details" / raw output must render INSIDE the notice body (a DOM node), not a separate panel — this reuses capability #1.
4. As the flow proceeds, record each answered step's value in some accessible structure (e.g. on the steps-ui instance or a local array) so a later ticket (EPMCDME-14656) can build a replay array — do NOT implement replay itself, just capture values.
5. Retry ("Try again") for the flow-stopping case must call the driver's cancelSetup() (already exported), await it, then call startSetup() again — never with two `codemie setup` processes running at once.
6. Use the SAME steps-ui instance the guided flow already created (ui/setup-view.js ~:286 via createStepsUi()), never the module-level default instance.

Already committed and NOT to be touched/redone:
- ui/setup-driver.js: re-ask filter fix (distinguishing a re-asked prompt from a cosmetic redraw), raw filled from readScreen() on driver rejections, cancelSetup() export.
- ui/setup-parse.js: detectFailure(lines) export returning null or { id, message, line } for 'authTimeout' and 'ollamaDown'.
- ui/test/fixtures/setup/authTimeout.json, ollamaNotRunning.json: captured real CLI screens.

Need research on: current shape of ui/renderer.js showNotice/hideNotice and index.html markup around #notice-*; ui/setup-view.js current structure around markError/handleReject/start and the guided-flow steps-ui instance creation; ui/models.js StepStatus; ui/steps-ui.js setStatus/setSubtitle and its private STATUS_META icon/colour table; ui/setup-driver.js's current exports (startSetup, cancelSetup) and rejection shape { step, message, raw }; ui/setup-parse.js's detectFailure and how existing callers of setup-driver in setup-view.js currently consume onPrompt/onLog and the resolved/rejected run promise; existing test patterns in ui/test/*.test.mjs and ui/test/fixtures/setup/*.json for both driver and parser tests, and the renderer.js test file if one exists, to establish idiomatic test style (node:test, real fixtures, no hand-written fixtures for CLI screens).

---

## 2. Codebase Findings

### Existing Implementations

- `ui/renderer.js:212-229` — current `showNotice({ title, message, primaryLabel, primaryAction })` / `hideNotice()`. `noticeMessage.textContent = message` (string-only body today). Single action only: `noticePrimary` shown/hidden based on `primaryLabel`; no secondary button element exists. Neither function is exported (module has zero `export` statements — confirmed by grep, `grep -n "^export" ui/renderer.js` returns nothing).
- `ui/renderer.js:672` — `noticeClose.addEventListener('click', hideNotice)`, wired once in `boot()`.
- `ui/renderer.js:340-350, 367-380, 398-403` — existing single-action `showNotice` callers: the auth-gate notice (`ensureAuthenticated`), sign-in failure (`startSignIn`), and the CLI-update-required notice (`runAnalytics`). All three must keep working with a single `primaryLabel`/`primaryAction` after the signature is extended.
- `ui/index.html:249-256` — notice markup: `#notice-overlay > #notice-card > #notice-title, #notice-message, #notice-actions > #notice-primary, #notice-close`. No secondary-action button element exists yet.
- `ui/setup-view.js` — the guided-setup glue module (717 lines).
  - `createSetupView(container, deps)` (`:285`) builds one `stepsUi = createStepsUi()` (`:286`) — a fresh, per-view-instance steps-ui, never the module-level default export from `ui/steps-ui.js`.
  - `markError(rowId)` (`:403-414`) — sets `StepStatus.ERROR` on a row, clears its live control and helper text. Comment: "EPMCDME-14588 puts the retry affordance here."
  - `handleReject(err)` (`:617-646`) — receives the driver's `{ step, message, raw }` (or `{ step: null, cancelled: true, ... }` from a cancel). Currently only marks the best-guess row (`step` → its latest occurrence row; `'model'` → a freshly-inserted row; else the `activeRowId`; else the transient "Working…" row, retitled "Setup stopped"; else `lastRowId`) — it does not yet look at `err.raw` or call `detectFailure`, and does not yet distinguish an Ollama-style step failure from a flow-stopping failure (auth timeout / unreachable CodeMie) or open any notice.
  - `run()` (`:663-713`) calls `startSetup({ onPrompt, onLog })`, catches a rejection into `handleReject(err)` and returns `{ ok: false, error: err }`; never throws. `start()` (`:657-661`) is the single-flight wrapper other callers use, already safe to call again on a settled instance.
  - `handleResolve(result)` (`:589-613`) verifies the written config, and on a mismatch also calls `markError(lastRowId)`, returning `{ ok: false, error: { step: null, message: 'the created profile is not the active one', raw: '' } }` from `run()`.
  - No structure currently records each answered step's value across the run — `occurrenceCounts`, `baseMessageByPromptId`, `firstAskByPromptId` track prompt bookkeeping, not user-supplied answers, and all are cleared at the top of every `run()`. There is no existing per-answer log for a later replay array (EPMCDME-14656).
- `ui/models.js` — `StepStatus` enum (`PENDING, ACTIVE, COMPLETE, WARNING, ERROR, SKIPPED`) and a `STATUS_META` icon/color table (`✗` / `#ff6b6b` for `ERROR`). This `STATUS_META` is exported from `models.js` but is a separate, duplicate table from the one inside `ui/steps-ui.js`.
- `ui/steps-ui.js` — `createStepsUi()` factory (also exported as a shared default instance for backward compatibility). Holds its own **private, non-exported** `STATUS_META` (`:3-10`, identical values to `models.js`'s copy) and `SPINNER` frames. Exposes `renderSteps, setStatus, setSubtitle, startSpinner, stopSpinner, setProgress, insertSubStep, showApproval, stampApproval`. `setStatus(id, status)` just calls `applyStatus`, which sets the icon/color from its private table and toggles the `active` class; it has no special-cased visual treatment for `ERROR` beyond the icon/color already in the table — no additional "failed" styling hook exists today.
- `ui/setup-driver.js` — exports `startSetup({ onPrompt, onLog, replay }, deps)` and `cancelSetup()`. `cancelSetup()` (`:255-261`) sets `cancelPending`, invokes `requestCancel()` if a run is active, awaits `activeDone` (swallowing its own rejection), and resolves `false` if no run was active. `runSetup`'s rejections are always the shape `{ step, message, raw }` (or `{ step: null, cancelled: true, message: 'setup cancelled', raw: readScreen().join('\n') }` when cancelled) — `raw` is always populated from `readScreen()` on every rejection path (spawn failure, non-zero exit, unrecognized-prompt stall, model-pagination timeout, invalid-answer rejections). A single in-flight run is enforced module-level (`active` boolean) — `startSetup()` throws `{ step: null, message: 'startSetup already in progress', raw: '' }` if called while one is running, so a caller invoking `cancelSetup()` then `startSetup()` again must await the cancel's resolution first (already true of the described retry flow).
- `ui/setup-parse.js` — exports `detectPrompt`, `isQ`, `detectFailure`. `detectFailure(lines)` (`:95-102`) is fully implemented already (commit 5d3fd54, as the task states) and returns `null` or `{ id: 'authTimeout' | 'ollamaDown', message, line }`, keyed on two fixed anchors (`FAILURES` table `:69-83`). It is edge-triggered by design (`line` lets a caller act once per occurrence) but **is not called from anywhere in `ui/setup-driver.js` or `ui/setup-view.js`** — confirmed by `grep -n "detectFailure" ui/setup-view.js ui/setup-driver.js` returning nothing. Today, only `ui/test/setup-parse.test.mjs` exercises it directly.

### Architecture and Layers Affected

- **Frontend-brain, thin Rust backend (Option B)** per `.ai-run/guides/architecture/architecture.md`: all of this ticket's remaining work is pure JS/DOM in `ui/`; no Rust changes are implicated.
- Layers touched: the **UI-widget layer** (`ui/renderer.js` notice modal, `ui/index.html` markup), the **glue/view layer** (`ui/setup-view.js`, which mediates between the headless driver and the DOM), and, read-only, the **driver/parser layer** (`ui/setup-driver.js`, `ui/setup-parse.js` — already committed, per the task not to be touched) and the **pure data layer** (`ui/models.js` StepStatus, `ui/steps-ui.js` status rendering).

### Integration Points

- `ui/setup-view.js` dynamically imports `./setup-driver.js` (`startSetup`) lazily via its `deps.startSetup` default, per the module's own header rule against static top-level imports of anything window/Tauri-touching. `cancelSetup` is not currently imported anywhere in `setup-view.js` — it would need the same lazy-import treatment as `startSetup`.
- `ui/renderer.js` is the only module that currently calls `showNotice`/`hideNotice`; `ui/setup-view.js` currently has no dependency on `renderer.js` at all (by design — `setup-view.js` is testable headlessly and must not import anything window-touching at module scope). Wiring `setup-view.js`'s new notice usage will need `showNotice`/`hideNotice` to be reachable from `setup-view.js` without a static top-level import — most likely via the same `deps`-injection pattern already used for `startSetup`/`readConfig` (`:316-323`), given the module's own documented constraint.
- `ui/renderer.js:496-505` (`boot()`, dev-only path) is the one existing caller of `createSetupView`; it holds `setupView` as a `let` closure and never calls `showNotice`/`hideNotice` on it, so the two modules are not yet connected for this ticket's failure-state work.

### Patterns and Conventions

- **Per-instance state via factories, never module-level singletons for new call sites**: `createStepsUi()` returns a closure-scoped object; `ui/steps-ui.js` keeps a module-level default instance only for backward-compat with `ui/renderer.js`'s `import * as stepsUI`, and `ui/setup-view.js` explicitly does NOT use it (`:286`, and the ticket's own point 6 reiterates this).
- **Lazy dependency injection to keep modules testable headlessly**: both `ui/setup-view.js` and `ui/setup-driver.js` declare, in header comments, that they must never statically import anything touching `window`/Tauri; real dependencies are injected via a `deps` parameter and dynamically `import()`ed only inside function bodies when the caller doesn't supply a fake.
- **DOM built via `document.createElement` + `.textContent`, never `innerHTML`**, for anything containing CLI- or user-supplied text (see `makeCard`'s explicit comment at `:170-171`). This is directly relevant to point 3 (rendering raw CLI output inside the notice body as a DOM node).
- **Rejections carry a fixed shape `{ step, message, raw }`** across the driver/view boundary; `setup-view.js`'s `handleReject` and `run()` already treat this shape as contract.
- **`run()` never throws — resolves `{ ok, ... }` or `{ ok: false, error }`** — the view layer's own convention for "no unhandled promise rejection reaches the caller."

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — confirms the frontend-brain/thin-backend split and the `ui/` module map; no guided-setup-specific notes.
- `.ai-run/guides/testing/testing-patterns.md` — states the JS test convention: `node --test` on `ui/test/*.test.mjs`, `node:assert/strict`, no framework dependency, filenames `<module>.test.mjs`, test names as plain behavior strings.
- No guide file specifically documents the guided-setup driver/view split or the notice modal; that context lives entirely in code comments inside `ui/setup-view.js`, `ui/setup-driver.js`, and `ui/setup-parse.js`.

### Architectural Decisions

- Inline "EPMCDME-14588" markers in `ui/setup-view.js` (`markError` at `:403`, `handleReject` at `:617`) and in `ui/setup-driver.js` (`cancelSetup` at `:216-261`, the auth-timeout re-ask handling at `:469-507`, and the exit-code rejection comment at `:919-923`) are the project's own forward-declared seams for this exact ticket — they are load-bearing comments, not incidental.
- `ui/setup-parse.js:60-68` records the measured, closed set of CLI-visible failures ("measured 2026-09-15... this is the whole set") — `authTimeout` and `ollamaDown` are the only two failure screens the CLI puts on screen; every other failure path (fatal handler) logs to file only and never reaches the terminal.
- `ui/setup-driver.js:242-254` (`cancelSetup` doc comment) explicitly names the retry motivation: an unreachable CodeMie service re-asks rather than exiting, so "Try again" must end the existing run via `cancelSetup()` before starting a new one, or a second `codemie setup` races the first over the config file.

### Derived Conventions

- Failure-message text is always the CLI's own words, never invented UI copy (`detectFailure`'s `reason()` extractors, and the ticket's own phrasing "in the CLI's own words").
- New UI text elsewhere in `setup-view.js` (e.g., `PROMPT_COPY`, the "Setup complete." status line) is added as static string literals inline, not pulled from a strings/i18n table — there is no i18n layer in this codebase.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/setup-parse.test.mjs` (249 lines) — includes `detectFailure` tests for both `authTimeout` and `ollamaNotRunning` fixtures, and a `null`-on-normal-prompt-screens check (`:218-241`), using the real captured fixtures in `ui/test/fixtures/setup/authTimeout.json` and `ollamaNotRunning.json`.
- `ui/test/setup-driver.test.mjs` (1725 lines) — large driver-behavior suite (fixture-driven PTY chunk replay, per the file's own tests around cancelSetup/re-ask handling per the header comments read in `setup-driver.js`).
- `ui/test/setup-view.test.mjs` (1512 lines) — uses a hand-rolled minimal DOM stub (`makeEl`/`findByClass`, extended from `steps-ui.test.mjs`'s stub) rather than a real DOM or jsdom; covers `markError`/`handleReject`/`start`/`onPrompt` behavior against fake `startSetup`/`readConfig` deps.
- `ui/test/steps-ui.test.mjs` (209 lines) — tests `createStepsUi()` against the same hand-rolled DOM stub.
- `ui/test/models.test.mjs` (28 lines) — `StepStatus`/`STATUS_META`/`makeStep` tests.
- No `ui/test/renderer.test.mjs` exists — `renderer.js` is currently untested directly (it touches `window.__TAURI__` at module scope and is exercised only via the app's own smoke-mode paths in `boot()`, not via `node:test`).
- `ui/test/tools/replay-capture.mjs` — a script (not a test) that drives the vendored `../../vendor/xterm.mjs` Terminal against a real captured PTY session to regenerate `ui/test/fixtures/setup/*.json` fixtures; this is how `authTimeout.json`/`ollamaNotRunning.json` were produced, confirming the project's "real captured screens, never hand-written CLI-screen fixtures" convention.

### Testing Framework and Patterns

- Framework: Node's built-in `node:test` + `node:assert/strict`; run via `npm test` → `node --test ui/test/*.test.mjs`.
- DOM: no jsdom/happy-dom dependency in `package.json`; all DOM-touching modules (`steps-ui.js`, `setup-view.js`) are tested against a shared, hand-rolled minimal DOM stub duplicated/extended per test file rather than a real browser DOM.
- Fixtures: CLI-screen fixtures are always captured from the real CLI (never hand-written) — this is a documented, hard-learned convention (see MEMORY: "Fixtures must match vendored rendering" — a hand-written fixture passed a guard the real CLI failed).
- Dependency injection for tests: both `setup-driver.js` and `setup-view.js` accept a `deps` object so tests supply fakes (`spawnPty`, `Terminal`, `startSetup`, `readConfig`, etc.) without touching `window`.

### Coverage Gaps

- `showNotice`/`hideNotice` in `ui/renderer.js` have **zero existing test coverage** — there is no renderer test file, and extending the signature (secondary action, DOM-node body) introduces new untested surface with no established test-stub pattern for it (unlike `setup-view.js`/`steps-ui.js`, which share a DOM stub across three test files).
- The step-vs-notice failure-classification logic this ticket adds to `handleReject`/`run()` (calling `detectFailure` on `err.raw` to decide `markError` vs. `showNotice`) has no existing test — `detectFailure` itself is tested in isolation (`setup-parse.test.mjs`) but never in combination with the view layer's rejection handling.
- The "record each answered step's value" capture point (item 4) has no existing structure or test to extend — it is new state.
- `cancelSetup()` is tested in `setup-driver.test.mjs` for driver-internal behavior, but `setup-view.js`'s retry flow (cancel-then-restart) calling it has no existing coverage from the view layer's side.

---

## 5. Configuration and Environment

### Environment Variables

- No task-relevant environment variables were found referenced in `ui/renderer.js`, `ui/setup-view.js`, `ui/setup-driver.js`, or `ui/setup-parse.js`. (`CODEMIE_DEV`/`CODEMIE_DEBUG`/`CODEMIE_PROBE_SMOKE`/`CODEMIE_SMOKE` appear elsewhere in `renderer.js`'s `boot()` for dev/smoke routing, unrelated to notice/failure rendering.)

### Configuration Files

- None specific to this feature area; `config/steps.yaml` (referenced by `src-tauri/src/steps.rs`) governs the install-wizard step list, not the guided-setup driver/view pair, which has no YAML/JSON config of its own beyond the test fixtures.

### Feature Flags and Deployment Concerns

- None found. `smoke_mode` flags (`flags.dev`, `flags.probe`, `flags.smoke`) gate dev-console exposure of `startSetup`/`createSetupView` in `renderer.js:boot()` but do not affect the failure-state rendering itself.

---

## 6. Risk Indicators

- Speculative: `showNotice`/`hideNotice` have no existing tests and no DOM-stub convention of their own; adding coverage for the extended signature (secondary action, DOM-node body) will likely require either a new lightweight DOM stub for `renderer.js` or reuse/adaptation of the stub duplicated across `setup-view.test.mjs`/`steps-ui.test.mjs` — neither currently models `#notice-*` elements.
- `ui/setup-view.js` must gain a dependency on `showNotice`/`hideNotice` without violating its own documented header constraint (never statically import anything window/Tauri-touching at module scope); the existing `deps`-injection pattern for `startSetup`/`readConfig` is the established way to satisfy this, but it is a new instance of that pattern for a new kind of dependency (a UI-widget function, not a driver/bridge call).
- `detectFailure` is fully implemented and tested in isolation but has **zero callers** anywhere in the driver or view layer today — the entire "classify raw into step-vs-flow failure" logic this ticket needs is net-new integration work, not a matter of wiring an existing call.
- `cancelSetup()` is not currently imported by `setup-view.js` at all; the retry flow (cancel existing run, await, call `startSetup` again) is new integration surface with its own single-flight-guard interaction (`startSetup` throws if called before `cancelSetup`'s promise settles) that must be gotten right to avoid two concurrent `codemie setup` processes — a failure mode the codebase's own comments call out explicitly as the reason `cancelSetup` exists.
- The "record answered-step values for later replay" requirement (item 4) touches `createSetupView`'s closure state with no existing structure to extend, and its correctness cannot be directly verified within this ticket (EPMCDME-14656 consumes it later) — a risk of building the wrong shape without a concrete consumer to test against.
- `ui/steps-ui.js`'s `STATUS_META` (icon/color per status) is duplicated, not shared, with `ui/models.js`'s `STATUS_META` — any visual distinction wanted for the ERROR state beyond the existing `✗ / #ff6b6b` icon/color would need to be added to (or reconciled between) two separate tables.
- `ui/renderer.js` itself has no test file; changes to `showNotice`/`hideNotice`'s exported surface are effectively going live in the app's dev/smoke paths (`window.__codemie`) without an automated regression net beyond whatever new tests this ticket's plan adds.

---

## 7. Summary for Complexity Assessment

This ticket is confined to the UI layer of a Tauri v2 + vanilla-ESM frontend (`ui/renderer.js`, `ui/index.html`, `ui/setup-view.js`), with the driver (`ui/setup-driver.js`) and parser (`ui/setup-parse.js`) already committed and explicitly out of scope. The main file-change surface is: extending `showNotice`/`hideNotice`'s signature and export list in `ui/renderer.js`, adding a secondary-action button to `ui/index.html`'s notice markup, and building new failure-classification/retry/capture logic inside `ui/setup-view.js`'s already-named seams (`markError`, `handleReject`, `run`/`start`). No Rust or config changes are implicated.

Technical novelty is concentrated in three places: (1) making `setup-view.js` depend on `renderer.js`'s notice functions without violating its documented "never statically import window-touching modules" rule, which requires extending its existing lazy-`deps`-injection pattern to a new kind of dependency; (2) wiring the already-implemented-but-uncalled `detectFailure` into `handleReject`/`run()` to decide between a step-level `StepStatus.ERROR` and a flow-stopping `showNotice`, which is genuinely new integration logic despite each half already existing in isolation; and (3) the cancel-then-restart retry flow, which must respect the driver's single-flight guard (`cancelSetup()` must fully settle before a new `startSetup()` call) to avoid racing two `codemie setup` processes over the config file — a failure mode the codebase's own comments treat as a first-class risk.

Test-coverage posture is mixed: `setup-parse.js`, `setup-driver.js`, and `setup-view.js` each have deep existing suites (1500–1700+ lines for the latter two) built against a shared hand-rolled DOM stub and real captured CLI-screen fixtures, but `ui/renderer.js` has no test file at all, and none of the specific new behavior this ticket adds (extended `showNotice`, failure classification, retry, and step-value capture) has any existing coverage to extend from. Key risks are therefore: introducing renderer test infrastructure from scratch, integrating two already-tested-in-isolation pieces (`detectFailure` and the notice modal) for the first time, and getting the cancel/restart single-flight interaction right without a prior pattern for it in this codebase.

---

## 8. External References

None named by the task. `task_context` points only at paths inside this repository (`ui/renderer.js`, `ui/index.html`, `ui/setup-view.js`, `ui/models.js`, `ui/steps-ui.js`, `ui/setup-driver.js`, `ui/setup-parse.js`, `ui/test/*`), all of which were read directly as part of this research rather than treated as an external source of truth.
