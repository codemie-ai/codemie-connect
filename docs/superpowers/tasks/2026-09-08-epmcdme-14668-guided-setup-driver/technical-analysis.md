
# Technical Research

**Task**: setup-driver pty ipc xterm
**Generated**: 2026-09-08T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-14668 — CodeMie Desktop: Guided setup driver (ui/setup-driver.js).

Build ui/setup-driver.js: a Node module that runs `codemie setup --force` in a PTY (via injected PTY functions defaulting to ui/runner-bridge.js), constructs a headless xterm screen buffer (ui/vendor/xterm.mjs) at the PTY's cols/rows, feeds PTY output through it, and after each write calls EPMCDME-14651's ui/setup-parse.js `detectPrompt(screenLines)` to detect the current prompt. Contract:

  startSetup({ onPrompt, onLog, replay }) -> Promise<{ profileName: string }>

- onPrompt(prompt) -> Promise<answer>: called per detected prompt (kind: 'list'|'input'|'confirm', id one of gate/storage/provider/codemieUrl/codemieProject/credential/model/customModel/modelManual/profileName/activate/installClaude). Answer for 'list' is chosen option's index, translate to arrow-key bytes (\x1b[B down / \x1b[A up) + \r written to PTY — never write option text. 'input' writes the string + \r. 'confirm' writes y/n + \r.
- onLog(line): optional passthrough, must NOT feed into any existing command-log recording (bridge already does that).
- replay: accepted, ignored in this stage (future ticket EPMCDME-14656 implements it).
- Rejects with { step: id|null, message, raw } on failure.

Specific behaviors needed, all to research against current code:
1. Storage prompt (id 'storage') is answered 'global' automatically without calling onPrompt.
2. Model list ('model' id): windowed/paginated list — walk down with arrow-key-down + short pauses until the list stops yielding new entries (not until a count in the message matches), read all entries, then return selection to top (arrow-up N times) before choosing final index. The "Custom" row must never be selected. 'customModel' and 'modelManual' ids are free-text escape hatches — treat as rejects with step:'model' (retryable failure), not as prompts to render.
3. Claude-install confirm (id 'installClaude') is answered 'no' automatically.
4. detectPrompt returns null for a real, reachable prompt: "Login to CodeMie platform to enable analytics sync? (y/N)" (fixture ui/test/fixtures/setup/analyticsSync.json in EPMCDME-14651's test dir) on the anthropic-subscription path. The driver must detect "screen is not changing / detectPrompt keeps returning null for N cycles while process is still alive" and handle it — needs a decision: answer the CLi's own default (n) by inspecting the raw screen text for a (y/N) hint, or reject with {step:null,...}. Must NOT modify ui/setup-parse.js.
5. Single PTY slot hazard: src-tauri/src/commands/pty.rs keeps ONE PTY in AppState; pty_input/pty_kill act on whatever is in that slot (no run id); spawn_pty replaces the slot with no guard. Other code paths that spawn a PTY while a guided run might be active: ui/renderer.js runAction (Connect Claude Desktop / CLI usage analytics) and the legacy install engine (per interactive step). The driver needs an in-process single-flight guard (module-level lock) refusing a second startSetup call while one is active, and should document/expose enough for the UI to keep the user off the other spawn paths during a run.
6. ui/terminal.js:40 area — term.onData(...) forwards every xterm keystroke to pty_input, disposable currently discarded in initTerminal, nothing exported to suspend it. Need a small, scoped change to ui/terminal.js: keep the disposable (or route through a settable sink) and export functions to suspend/restore input forwarding, used by the driver for the duration of a run.
7. Filtering: engine:pty-data / engine:pty-exit events carry a per-command correlation id (from EPMCDME-14647). The driver must filter incoming events by the id of the child it spawned, so a late event from a killed/replaced previous run never reaches the new run's logic. On retry: must confirm previous PTY child has exited (poll pty-exit, or use pty_kill if hung) before spawning a fresh run.
8. Driver must be structured for dependency injection: accept spawnPty/input/kill and a data/exit subscription mechanism as parameters (defaulting to ui/runner-bridge.js's real implementations imported lazily/as default, not at module top), so node:test can substitute a fake PTY.

Please research and report on:
- Exact current shape/exports of ui/runner-bridge.js (the PTY bridge module) — what functions exist for spawn/input/kill/subscribe to pty-data and pty-exit, their signatures, and whether/how they already carry a correlation id.
- Exact current shape of src-tauri/src/commands/pty.rs — spawn_pty, pty_input, pty_kill signatures and the AppState PTY slot, to confirm the single-slot hazard description above is accurate on this branch.
- Exact current shape of ui/setup-parse.js's detectPrompt (EPMCDME-14651) — the exported function signature, the prompt id enum, the list-windowing/pagination behavior already implemented there for the model list, and confirm where/how it returns null for unrecognized (y/N)-style prompts (cite exact line numbers).
- Existing fixtures under ui/test/fixtures/setup/ (especially analyticsSync.json) — their shape (are they raw byte sequences? screen line arrays? multiple redraw frames?) so the driver test can consume them.
- Current shape and exports of ui/terminal.js — exact onData usage, initTerminal, and what "opening the overlay" (openTerminal calls from renderer.js) does, to scope the input-forwarding-suspend change precisely.
- ui/vendor/xterm.mjs — how a headless terminal buffer is constructed off-DOM (cols/rows params, how to read back screen lines as an array of strings) since setup-parse.js's detectPrompt takes screenLines as input.
- Where ui/setup-driver.js would sit relative to existing test conventions (ui/test/*.test.mjs using node:test) and how npm test / package.json wires that directory in, plus how EPMCDME-14647's PTY correlation id is threaded through IPC events today (exact event names and payload shape for engine:pty-data / engine:pty-exit).
- Any existing code in ui/renderer.js that spawns PTYs (runAction, legacy engine per-step install) so the risk-indicator about a second spawn racing a guided-setup run is grounded in actual call sites (line numbers, function names).

This is a Node/JS driver module with no UI (UI is a separate ticket, EPMCDME-14513). Cargo/Rust side is read-only research here (pty.rs) — no Rust changes are anticipated in this ticket, though the ticket text asks you to confirm whether a Rust change would be needed and flag it as a raised-but-out-of-scope item if so.

---

## 2. Codebase Findings

### Existing Implementations

- `ui/runner-bridge.js:101-135` — the `pty` export: `spawnPty(cmd, cols = 100, rows = 30, onData)` generates a local id via `nextId('pty')` (`id => \`pty${++counter}\``), registers `listen('engine:pty-data', ...)` and `listen('engine:pty-exit', ...)` filtered by `e.payload.id === id` BEFORE calling `invoke('spawn_pty', { cmd, cols, rows, runId: id })`, and resolves `{ code, id }` on matching exit. Also exports `input: (data) => invoke('pty_input', { data })`, `resize: (cols, rows) => invoke('pty_resize', { cols, rows })`, `kill: () => invoke('pty_kill')`. Note: `input`/`resize`/`kill` take **no id parameter** — they act on whatever Rust has in its single slot, matching the described hazard.
- `ui/test/pty-bridge.test.mjs:1-15` — the established DI/fake pattern: overwrites `globalThis.window.__TAURI__` with mutable `listenImpl`/`invokeImpl` delegates before importing `runner-bridge.js`, then swaps behavior per test. `setup-driver.test.mjs` would need an analogous approach if it imports `runner-bridge.js` directly, or (per the ticket's DI requirement) accept fake spawn/input/kill/subscribe functions as constructor params instead.
- `src-tauri/src/commands/pty.rs:40-165` (`spawn_pty`) — confirms the single-slot hazard exactly as described: `state.pty.lock()`; if `guard.is_some()` returns `Err(InstallerError::Pty("PTY already active"))` — i.e. Rust itself already refuses a second concurrent PTY, but only at the moment of `spawn_pty`; nothing prevents a UI action from calling `spawn_pty` and getting that error instead of the driver's own guard producing a friendlier reject. `pty_input` (line 168) and `pty_kill` (line 196) act on `state.pty` with no run-id argument — first-class confirmation that any code path holding the slot can be written to / killed by any other caller.
- `src-tauri/src/state.rs:14-16` — `AppState.pty: Mutex<Option<(String, PtyHandle)>>` — the tuple's `String` is the `run_id`; `clear_if_owner` (pty.rs:28) only clears the slot if the id matches, so a killed/replaced PTY's exit thread cannot clobber a newer occupant's slot-clearing — but this is a Rust-side guard, not a driver-side one.
- `ui/setup-parse.js` (EPMCDME-14651, already delivered) — `export function detectPrompt(lines)` (line 29) takes a 30-line screen array; `PROMPTS` (lines 13-27) is the ordered anchor table matching every id named in the ticket (`gate, storage, provider, codemieUrl, codemieProject, model, customModel, modelManual, profileName, activate, installClaude`, plus a `credential` catch-all). Line 39: `if (!named && /\(y\/N\)\s*$|.../i.test(line)) return null;` — this is the exact mechanism that returns `null` for the analytics-sync prompt, since it has no named anchor and ends in `(y/N)`. `parseOptions` (line 56) implements list-option extraction with a `Custom model`/`manual` skip (line 63) and first-selection-wins logic (line 68) — but it operates on a single already-windowed screen; **the multi-cycle windowing/pagination walk (arrow-down until no new entries, then arrow-up N times) described in the ticket is NOT implemented in setup-parse.js** — it is out of scope for that module (pure, single-screen) and must live entirely in the new driver.
- `ui/terminal.js:1-119` — `initTerminal` (line 23) wires `term.onData((d) => invoke('pty_input', { data: d }))` (line 40) with the `Disposable` return value **discarded** (not assigned to a variable) — confirms the ticket's claim exactly. No exported suspend/resume function exists today. `openTerminal` (line 65) is called by `ui/renderer.js` from three places: the `pty-open` engine event (line 139, legacy per-step install), and `runAction` (line 317, one-shot Connect Claude Desktop / analytics commands).
- `ui/renderer.js:316-325` (`runAction`) — calls `bridge.pty.spawnPty(cmd)` directly (no id passed to the driver, no guard) after `openTerminal(...)`; this is one of the two "other spawn paths" the ticket flags as a hazard during a guided-setup run.
- `ui/handlers.js:60-76` (`runPty`) — the legacy install engine's per-step interactive handler; calls `pty.spawnPty(cmd)` for steps `2.3.3` (`codemie setup`) and `2.3.5` (`codemie install claude --supported`) (lines 80-87) — the second flagged hazard path, and notably already runs the very `codemie setup` command the new guided driver targets, so the legacy step and the new driver are two independent front-ends onto the same underlying CLI invocation and the same single PTY slot.
- `ui/engine.js` — the orchestration engine driving `handlers.js`; unrelated to setup-driver's design but shares the PTY slot at runtime, reinforcing risk 5.

### Architecture and Layers Affected

- **Frontend orchestration layer** (`ui/*.js`, ESM, no bundler) — `setup-driver.js` is a new peer module in this layer, alongside `runner-bridge.js` (IPC wrapper), `terminal.js` (UI widget), `setup-parse.js` (pure parser), `engine.js`/`handlers.js` (legacy step orchestration).
- **Backend thin-command layer** (`src-tauri/src/commands/pty.rs`, `state.rs`) — read-only for this ticket; the single-slot design there is pre-existing and is the reason the driver needs its own guard and event filtering.
- **IPC boundary** — `engine:pty-data` / `engine:pty-exit` Tauri events, `spawn_pty`/`pty_input`/`pty_resize`/`pty_kill` invoke commands — the driver consumes these exclusively through injected functions, never `window.__TAURI__` directly (per the DI requirement).

### Integration Points

- `ui/runner-bridge.js`'s `pty` export is the default real implementation the driver should default its injected `spawnPty`/`input`/`kill` params to (lazy/default import, not static top-level import, per requirement 8).
- `ui/setup-parse.js`'s `detectPrompt` is a hard dependency, imported directly (not injected) — the ticket explicitly says not to modify it.
- `ui/vendor/xterm.mjs`'s `Terminal` class is the headless screen-buffer engine; `ui/terminal.js` already imports it the same way (`import { Terminal } from './vendor/xterm.mjs'`) for the DOM-attached terminal, but never off-DOM. The vendor file is ~93k tokens (a full xterm.js bundle) and was not fully read in this session — codegraph did not surface a `class Terminal` symbol directly (only its two consumers). The standard xterm.js public API (`new Terminal({ cols, rows })` without calling `.open(el)`, feed bytes via `term.write(data)`, read back lines via `term.buffer.active.getLine(y).translateToString(true)` for `y` in `0..rows`) is a widely-documented headless usage pattern for this library version family, but this session did not verify the exact method/property names inside this vendor bundle — **treat the exact headless-buffer API as unconfirmed** pending a direct grep/read of `ui/vendor/xterm.mjs` for `class Terminal`, `buffer`, `getLine`, `translateToString` before implementation.
- `ui/terminal.js` needs a scoped edit (per requirement 6) to keep the `onData` disposable and export suspend/resume — this is the one production file outside `setup-driver.js` itself the ticket anticipates touching.

### Patterns and Conventions

- Correlation-id-per-call pattern: every bridge call that needs to demux a shared event stream generates its own id via `nextId(prefix)` and filters `e.payload.id === id` (see `runner.runStream`, `downloader.download`, `pty.spawnPty` — all in `runner-bridge.js`). The driver's event-filtering requirement (7) is this same established convention, not a new one.
- Dependency-injection-for-testability pattern: `handlers.js`'s `makeHandlers(deps)` and `engine.js`'s `Engine({ steps, handlers, emit, isUnattended })` both take an injected-dependencies object with defaults resolved by the caller, never importing Tauri globals directly inside the injectable surface — `setup-driver.js`'s `startSetup({ onPrompt, onLog, replay }, deps)`-shaped signature (deps defaulting to real bridge functions) matches this convention.
- Pure-function-plus-fixture-driven-test pattern: `setup-parse.js` is a pure function tested against JSON fixture arrays (`ui/test/fixtures/setup/*.json`) in `ui/test/setup-parse.test.mjs` — the new driver's own tests will need a different pattern (byte-stream fixtures feeding a fake PTY across multiple ticks) since the driver is stateful and asynchronous, unlike `detectPrompt`.
- `module-level lock` / single-flight pattern is not yet present anywhere in the codebase (no existing module uses an in-process mutex/lock variable) — this will be a new pattern introduced by requirement 5, not copied from an existing module.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — describes the Option B split (frontend-brain + thin Rust backend), lists `runner-bridge.js` as "wraps Rust commands as JS module surface" and `pty.rs` as "portable-pty interactive terminal"; documents `AppState { remembered, pty }` and the `engine:<event>` emit convention. Confirms `state.rs:14` (`AppState.pty: Option<PtyHandle>`, single-slot) as the intended design, not a bug — the ticket's "hazard" framing is accurate but is a pre-existing accepted architectural constraint, not a defect to fix in Rust.
- `.ai-run/guides/testing/testing-patterns.md` — documents `ui/test/*.test.mjs` via `node --test`, `node:assert/strict`, no framework dependency; explicitly notes "Test Tauri invoke() — that's handler/integration territory" as a DON'T, reinforcing that `setup-driver.test.mjs` should fake the injected PTY functions rather than exercising `runner-bridge.js`'s real Tauri calls.
- No guide file specifically covers `setup-parse.js`, `setup-driver.js`, or the guided-setup feature — this is new-ish functionality (EPMCDME-14651 delivered `setup-parse.js` without a dedicated guide addition).

### Architectural Decisions

- Inline comment at `ui/runner-bridge.js:101` — "pty (replaces node-pty; the active PTY lives in Rust managed state)" — records the decision to centralize PTY state in Rust rather than JS, which is the root cause of the single-slot hazard.
- Inline comments in `pty.rs` (CR-002 through CR-005) — record prior code-review fixes for `pty_kill` (race on already-exited child) and `spawn_pty`'s slot guard; these establish that the Rust side already treats "PTY already active" as an error condition, which the driver's own guard should pre-empt with a friendlier message rather than relying on the Rust-side rejection.
- `ui/setup-parse.js`'s CR-003/CR-005 comments — record why confirm-kind prompts strip only exact yes/no hint patterns, and why only the first selection marker wins; relevant if the driver ever needs to reason about screen-parsing edge cases beyond what `detectPrompt` already returns.

### Derived Conventions

- Event-payload shape for `engine:pty-data` is `{ id: string, data: string }` where `data` is base64-encoded raw bytes (see `pty.rs:134-138`, decoded in `ui/terminal.js:81-91` via `atob` + `Uint8Array`). The driver will need this same base64-decode step before feeding bytes into the headless xterm buffer.
- Event-payload shape for `engine:pty-exit` is `{ id: string, code: number }` (`pty.rs:158-161`).
- `spawn_pty`'s Rust-side rejection message on slot contention is the literal string `"PTY already active"` (`pty.rs:112`) — useful for the driver to recognize/wrap if it ever races the Rust guard despite its own lock.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/setup-parse.test.mjs` — parametrized fixture-driven tests for every `detectPrompt` id (`gate, storage, provider, codemieUrl, codemieProject, credential, model, customModel, modelManual, profileName, activate, installClaude`), plus dedicated `options`/`selectedIndex` assertions for `gate`, `storage`, `provider`, `codemieProject`, and a windowing-specific test for `model` ("windowed at 15, Custom row excluded") that asserts exactly 15 returned options from the `model.json` fixture (a single 30-line screen, not a multi-frame walk).
- `ui/test/pty-bridge.test.mjs` — tests `runner-bridge.js`'s `pty.spawnPty` id-filtering and listener-cleanup (CR-005) behavior using the fake-`window.__TAURI__` pattern; no test file yet exists for `setup-driver.js`, `terminal.js`, or `xterm.mjs` headless usage.
- No `ui/test/setup-driver.test.mjs` exists — this ticket's test file is new.

### Testing Framework and Patterns

- `node:test` + `node:assert/strict`, no external framework, per `package.json`'s `"test": "node --test ui/test/*.test.mjs"` script — a new `ui/test/setup-driver.test.mjs` will be auto-discovered by this glob with no wiring changes needed.
- Fixture pattern: JSON arrays of screen lines under `ui/test/fixtures/setup/*.json`, loaded via `fileURLToPath(new URL('fixtures/setup/${id}.json', import.meta.url))` + `JSON.parse(readFileSync(...))` — confirmed in `setup-parse.test.mjs:7-10`. `analyticsSync.json` fixture is a flat 31-element array of plain strings — the same "screenLines" shape `detectPrompt` consumes, ending in the exact unrecognized-prompt line `"? Login to CodeMie platform to enable analytics sync? (y/N) "`. It is a single static screen snapshot, not a byte-sequence or multi-frame recording — so it directly validates `detectPrompt` returning `null` on this input, but a driver test exercising "N cycles of null while alive" will need to feed this same screen repeatedly (or a synthetic near-identical one) across ticks, since the fixture itself is single-shot.
- Fake-Tauri-window pattern from `pty-bridge.test.mjs` is the closest existing precedent for a driver test that needs to simulate PTY events, though the ticket's explicit DI design (inject spawn/input/kill/subscribe as constructor params) means `setup-driver.test.mjs` likely won't need to touch `window.__TAURI__` at all — it can pass fakes straight to `startSetup`.

### Coverage Gaps

- No existing test constructs or exercises a headless `xterm.mjs` `Terminal` instance off-DOM — this is a wholly new usage of the vendor library with no prior test precedent in this repo.
- No existing test covers `ui/terminal.js`'s `onData` wiring, disposable lifecycle, or any suspend/resume behavior — `terminal.js` currently has zero test coverage (confirmed by codegraph's "⚠️ no covering tests found" flags on `initTerminal`, `openTerminal`, `closeTerminal`).
- No existing test covers `ui/renderer.js`'s `runAction` or `handlers.js`'s `runPty` — both flagged spawn-hazard call sites are untested today, so a regression there (e.g. a race introduced during this ticket) would not be caught by the existing suite.
- No existing single-flight / module-level-lock pattern exists anywhere to model the new guard on.

---

## 5. Configuration and Environment

### Environment Variables

- No environment variables specific to guided-setup or PTY behavior were found. `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` (documented in architecture.md and referenced by `lib.rs` / `commands/smoke.rs`) govern non-destructive integration smoke checks generally, not this feature specifically.

### Configuration Files

- `package.json` — `"test": "node --test ui/test/*.test.mjs"` is the only config touching how the new test file will run; no changes needed there since the glob already covers any new `*.test.mjs` file dropped into `ui/test/`.
- `config/steps.yaml` (embedded via `include_str!`, per architecture.md) governs the legacy install engine's step list, including steps `2.3.3`/`2.3.5` that already run `codemie setup` / `codemie install claude --supported` via `runPty` — relevant context for the hazard, not something this ticket is expected to edit.

### Feature Flags and Deployment Concerns

- No feature flag currently gates the legacy per-step `codemie setup` (`2.3.3`) path versus a future guided-setup path — the ticket's UI counterpart (EPMCDME-14513) will presumably need to decide how the two coexist, but that decision is out of scope for this research.

---

## 6. Risk Indicators

- Speculative: the exact headless-buffer read-back API of `ui/vendor/xterm.mjs` (method names for constructing off-DOM and reading lines back as strings) was not directly confirmed in this session — the vendor file is a ~93k-token bundle that exceeded the read budget. Implementation must grep/read it directly for `class Terminal`, `buffer`, `getLine`, `translateToString` (or equivalent) before writing the screen-buffer feed loop; if the API differs from the standard xterm.js shape assumed here, the core "feed PTY output through a screen buffer" mechanism could look different than expected.
- The single PTY slot in `src-tauri/src/commands/pty.rs`/`state.rs` is confirmed real and exactly as described: `pty_input`/`pty_resize`/`pty_kill` have no run-id parameter and act on whichever PTY currently occupies `AppState.pty`; `spawn_pty` itself already rejects a second concurrent spawn with `"PTY already active"`, but only at spawn time — nothing stops `ui/renderer.js`'s `runAction` (line 317-325) or `handlers.js`'s `runPty` (lines 60-76, driving legacy steps `2.3.3`/`2.3.5`) from racing a guided-setup run if the JS-side single-flight guard required by this ticket is missing or incompletely wired into those call sites (the ticket only requires the driver to *guard its own* re-entry and to *document* the hazard for the UI ticket — it does not require editing `renderer.js`/`handlers.js` here, which is itself a scope-boundary risk if the UI ticket does not follow through).
- `ui/terminal.js` has zero existing test coverage (confirmed via codegraph blast-radius flags on `initTerminal`, `openTerminal`, `closeTerminal`), so the scoped edit to keep the `onData` disposable and add suspend/resume exports is a change to an already-untested file — any regression risk there compounds.
- `ui/setup-parse.js`'s `detectPrompt` intentionally returns `null` for any unrecognized `(y/N)`-style line (line 39) as a deliberate defect fix (per its own inline comment) — the ticket's requirement 4 (deciding what to do when this happens for `analyticsSync`) is working exactly as that module's authors intended, so the driver-side "stuck" detection and recovery is new logic with no existing precedent to model, and the decision between "auto-answer n by scanning raw screen text" versus "reject" is unresolved by any prior pattern in the codebase.
- The model-list windowing/pagination walk (arrow-down-until-no-new-entries, then arrow-up N times) described in ticket item 2 has **no existing implementation anywhere** — `setup-parse.js`'s own windowing test (`model.json`) validates only a single already-scrolled 15-row screen, not a multi-cycle walk. This is greenfield logic within the driver with no test fixture yet capturing multiple redraw frames of a paginated list; a fixture covering that sequence will likely need to be authored as part of this ticket's own test-writing, since none exists under `ui/test/fixtures/setup/`.
- No existing module in this codebase implements a single-flight/module-level lock — the pattern required by risk 5 is new, so there's no established convention to copy for how such a lock should surface its state (module-level boolean vs. exported `isRunning()` getter, etc.) to the future UI ticket (EPMCDME-14513).
- Rust-side change: based on the confirmed shape of `pty.rs`/`state.rs`, no Rust change is structurally required for this ticket's driver logic — `runner-bridge.js`'s existing `pty.spawnPty` already threads a correlation id end-to-end and filters events by it, and the existing slot-rejection error is sufficient as a backstop. This is a research finding, not a design decision: flagging per the ticket's own request that a Rust change be explicitly confirmed unnecessary or raised — this session's finding is "not needed," but final confirmation belongs to the spec/plan stage.

---

## 7. Summary for Complexity Assessment

This task adds one new frontend module (`ui/setup-driver.js`) plus a small scoped edit to an existing, currently-untested module (`ui/terminal.js`, to preserve the `onData` disposable and expose suspend/resume). It sits entirely in the frontend orchestration layer (ESM, no bundler) and touches three already-confirmed integration points: `ui/runner-bridge.js`'s `pty` export (spawn/input/kill, correlation-id-filtered `engine:pty-data`/`engine:pty-exit` events — confirmed exact signatures and payload shapes), `ui/setup-parse.js`'s pure `detectPrompt(lines)` (confirmed prompt-id enum and its deliberate `null`-on-unrecognized-(y/N) behavior at line 39), and `ui/vendor/xterm.mjs`'s `Terminal` class for an off-DOM screen buffer (API not directly confirmed this session — flagged as the one open verification gap). The Rust side (`pty.rs`/`state.rs`) is read-only research and, per the findings above, does not appear to need any change.

Technical novelty is concentrated in three places with no existing precedent to copy: (1) constructing and feeding a headless xterm buffer off-DOM — a new usage pattern for a vendor library only ever used DOM-attached before; (2) the model-list pagination walk (arrow-down until no new entries, return to top, select) — genuinely new stateful logic with no existing fixture covering a multi-frame redraw sequence; (3) the module-level single-flight lock — a pattern type not present anywhere else in this codebase. All other pieces (correlation-id event filtering, dependency-injection defaults, fake-PTY test doubles) directly extend conventions already established in `runner-bridge.js`, `handlers.js`, and `pty-bridge.test.mjs`.

Test coverage posture is mixed: `setup-parse.js` and `runner-bridge.js`'s `pty` export are both well-tested with an established fixture/fake pattern the new driver tests can extend, but `ui/terminal.js` (the file requiring the scoped edit) has zero coverage today, and the new driver's own hardest-to-test behaviors (multi-cycle model-list windowing, "stuck" null-detection recovery, single-flight lock, retry-after-confirmed-exit) have no existing fixtures or test patterns to build from — most new fixtures (a multi-frame paginated-list sequence, a repeated-null-screen sequence) will need to be authored from scratch as part of this ticket.

---

## 8. External References

None named by the task as absolute paths or URLs outside this repository. All referenced files (`ui/setup-parse.js`, `ui/test/fixtures/setup/*.json`, `ui/runner-bridge.js`, `src-tauri/src/commands/pty.rs`, `ui/terminal.js`, `ui/vendor/xterm.mjs`, `ui/renderer.js`, `ui/handlers.js`, `package.json`, `.ai-run/guides/architecture/architecture.md`, `.ai-run/guides/testing/testing-patterns.md`) are inside this repository and were resolved and read/explored directly in Sections 2–4 above.
