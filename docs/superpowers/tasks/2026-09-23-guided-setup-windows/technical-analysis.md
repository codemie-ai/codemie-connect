# Technical Research

**Task**: guided setup pty windows
**Generated**: 2026-09-23
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14982 - CodeMie Desktop: Guided setup on Windows. Home's checklist item 'Choose how CodeMie reaches a model' opens a graphical 'guided setup' screen that drives `codemie setup` step-by-step via a headless PTY + xterm.js reader; it already works on macOS. Ticket wants the same flow to work correctly on Windows. Key files: ui/setup-driver.js (headless driver: feeds PTY bytes into headless xterm.js Terminal, re-parses screen via ui/setup-prompt.js's detectPrompt after every chunk, auto-answers fixed-policy prompts or calls onPrompt), ui/setup-view.js (renders the screen, drives visual state machine), ui/setup-prompt.js (pure prompt recognizer detectPrompt), ui/test/setup-driver.test.mjs (has six 'real stream' tests replaying byte-for-byte captured macOS PTY frames — need Windows equivalents). Backend: src-tauri/src/commands/pty.rs already branches on cfg!(windows) for spawn_pty (powershell.exe vs /bin/zsh), so PTY spawning is already cross-platform. Separately, ui/handlers.js has an unrelated legacy Wizard `isWin ? runExternalWindow : runPty` fork for install-wizard steps 2.3.3/2.3.5 (added in commits c348632/437d17b) — CONFIRMED OUT OF SCOPE for this ticket per prior analysis (it's a different screen/flow, config/steps.yaml-driven, not guided setup). The real work: (1) add temporary debug logging to ui/setup-driver.js to record real Windows CLI PTY behavior (chunking, echo/repaint order, ctrl-U line-clear behavior, arrow-key list nav, AUTO_LIST/AUTO_CONFIRM regex matches, validation-error marker `>>` positioning) since assumption-based tests missed 3 real bugs on macOS; (2) fix setup-driver.js/setup-prompt.js only if the Windows recording proves a divergence from the macOS contract; (3) add six Windows 'real stream' tests to ui/test/setup-driver.test.mjs alongside the existing macOS ones, without touching macOS tests/frames; (4) remove all debug logging before commit. No src-tauri changes expected. Explore: exact current structure/exports of ui/setup-driver.js (test hooks, IDLE_MS, VALIDATION_ERROR_MARKER, VALIDATION_ERROR_WINDOW, AUTO_LIST, AUTO_CONFIRM, translateListAnswer, translateConfirmAnswer, stableQuestion, processChunk, settleResolve/settleReject, onPrompt dispatch), ui/setup-prompt.js's detectPrompt shape, the six existing 'real stream' test structure/helpers (makeFakePty, makeFakeTerminal, flushMicrotasks, ans()) in ui/test/setup-driver.test.mjs so new tests can mirror them exactly, and confirm there is truly no isWin/platform branching inside setup-driver.js/setup-view.js/setup-prompt.js today.

---

## 2. Codebase Findings

### Existing Implementations

- `ui/setup-driver.js` (969 lines) — the headless driver. Exports `startSetup({ onPrompt, onLog, replay, onScreen }, deps)` and `cancelSetup()`. Note: the task description calls the parser module `ui/setup-prompt.js`, but the actual file on disk is **`ui/setup-parse.js`** — `setup-driver.js` imports `{ detectPrompt, isQ }` from `./setup-parse.js`. There is no `ui/setup-prompt.js` in the repo.
  - Constants: `COLS = 100`, `ROWS = 30`, `IDLE_MS = 200`, `YN_HINT`, `MODEL_STEP_REDRAW_TIMEOUT_MS = IDLE_MS * 5`, `MAX_MODEL_PAGINATION_STEPS = ROWS * 20`, `AUTO_LIST = { gate: /add a new profile/i, storage: /global/i }`, `AUTO_CONFIRM = { activate: true }`, `VALIDATION_ERROR_MARKER = /^>>/`, `DEFAULT_HINT = /\s*\([^()]*\)\s*$/`, `VALIDATION_ERROR_WINDOW = 3`.
  - Helper functions (all module-private, not exported): `translateListAnswer(fromIndex, toIndex)`, `translateConfirmAnswer(v)`, `pickAutoListIndex`, `collectModelOptions` (arrow-key pagination walk), `validationErrorText(lines)`, `stableQuestion(message)`.
  - Inside `runSetup` (closure-scoped, per-run state, not exported/hookable directly): `settleResolve`/`settleReject`, `handleDetectedPrompt`, `readScreen`, `decode`, `scheduleIdleCheck`, `writeToTerminal`, `processChunk`, `onData`. None of these inner functions are exposed as test hooks — tests exercise them only through `startSetup`'s public `deps` injection points (`spawnPty`, `input`, `kill`, `Terminal`, `suspendPtyInput`, `resumePtyInput`) and the `onPrompt`/`onLog`/`onScreen` callbacks.
  - The module comment block (lines 1–11) states the driver "must never statically top-level-import anything that touches window/Tauri globals" — all such deps are lazily `import()`ed inside `runSetup` with `deps` overrides for tests.
- `ui/setup-parse.js` (140 lines) — pure `detectPrompt(lines)` and `detectFailure(lines)`, plus exported `isQ`. `detectPrompt` returns `{ kind, id, message, options?, selectedIndex? } | null`. `PROMPTS` table maps 11 named anchors (`gate`, `storage`, `provider`, `codemieUrl`, `codemieProject`, `model`, `customModel`, `modelManual`, `profileName`, `activate`, `installClaude`) plus a `credential` catch-all (`anchor: null`, requires a `:` in the message). `detectFailure` recognizes two visible CLI failure screens: `authTimeout` and `ollamaDown` (`ollamaNotRunning.json` fixture — the module's internal id is `ollamaDown` but the fixture file is named `ollamaNotRunning.json`).
- `ui/setup-view.js` (841 lines) — `createSetupView(container, deps)` glues driver prompts to `ui/steps-ui.js` rows. Imports `detectFailure` from `./setup-parse.js` and `renderFailurePanel` from `./failure-panel.js`. Independently re-declares `DEFAULT_HINT` (duplicated from setup-driver.js by design, per its own header comment, since it must not statically import setup-driver.js).
- `ui/test/setup-driver.test.mjs` (1824 lines total; only lines 1–1515 read in this pass) — the test suite.
  - `ans(text)` = `` `\x15${text}\r` `` — a re-answer written behind ctrl-U (line-kill).
  - `flushMicrotasks()` — awaits `Promise.resolve()` six times, to let the real async `Terminal.write()`/write-queue chain settle before advancing mocked timers.
  - `makeFakeTerminal(linesPerFeed)` — returns a constructor whose instance has `write(bytes, cb)` (calls `cb()` synchronously), `buffer.active.getLine(r)` reading from an internal `current` array, and `__setLines(lines)` to seed the next read.
  - `makeFakePty()` — returns `{ id, writes, spawnPty(cmd, cols, rows, onData), input, kill, feedRaw(b64), exit(code) }`; `spawnPty` captures `onData` and resolves the exit promise via `exit(code)`; `feedRaw` invokes the captured `onData` directly with a **base64 string is not actually required** — the fake terminal ignores the bytes entirely and only reads whatever `__setLines` last set, so `feedRaw('AAAA')` (or any string) is just a trigger to re-run `processChunk`.
  - `replay(frames, answers)` helper (added for the "real stream" tests) — seeds `t.__setLines(frames[0])`, calls `fake.feedRaw('AAAA')`, then for each subsequent frame sets lines and re-feeds, `await flushMicrotasks()` between each, then `fake.exit(0)`. Returns `{ seen, writes, result }`.
  - `typedOut(prefix, text)` helper — builds one frame per character typed, each carrying `[MODELS_DONE, MODEL_ECHO, `${NAME_Q}${prefix}${partial}`]`, simulating the CLI's own character-by-character terminal echo.
  - Actual count of tests explicitly titled `'real stream: ...'`: **4**, not 6 as the task description states — `'real stream: a whitespace correction is re-asked once...'`, `'real stream: the same rejected name entered twice is asked a third time'`, `'real stream: a question-less chunk right after our answer...'`, `'real stream: an earlier answered line that is the last question again...'`. Two further tests reuse the same `replay`/typed-out machinery style (`'once the CLI moves on to another prompt...'`, `'a password validate failure...'`) but are not labeled `real stream:` in their title. This discrepancy should be reconciled with whoever wrote the task description before deciding how many new Windows tests to add.
- `ui/test/fixtures/setup/*.json` — 16 captured fixture files (macOS), one per named prompt id plus `authTimeout.json`, `analyticsSync.json`, `ollamaNotRunning.json`, and `provider-answered-then-next-open.json`. All are macOS PTY captures; no Windows fixtures exist yet.
- `src-tauri/src/commands/pty.rs` (480 lines) — `spawn_pty` already has a `#[cfg(not(windows))]`/`#[cfg(windows)]` split: unix spawns `/bin/zsh -lc <cmd>`, Windows spawns `powershell.exe -NoProfile -Command <cmd>`. `pty_env_pairs_for` sets `HOME` (unix) or `USERPROFILE` (Windows). `pty_input`, `pty_resize`, `pty_kill` are platform-agnostic. There is also a separate, Windows-only `spawn_external_ps` command (`#[cfg(windows)]`) used by the **unrelated** legacy wizard flow (see below), plus a `#[cfg(all(test, windows))] mod win_tests` and a `#[cfg(all(test, not(windows))) ] mod tests` for platform-specific Rust unit tests.
- `ui/handlers.js` — confirmed the `isWin` fork exists at lines 28, 80–87: `platform.os === 'windows'` picks `runExternalWindow` over `runPty` for wizard steps `'2.3.3'` (`codemie setup`) and `'2.3.5'` (`codemie install claude --supported`). This is a config/steps.yaml-driven legacy Wizard flow, structurally separate from `ui/setup-driver.js`/`ui/setup-view.js`'s guided-setup screen — confirmed genuinely out of scope for this ticket; it does not import or call `startSetup`/`createSetupView` at all.

### Architecture and Layers Affected

- **Frontend headless driver layer**: `ui/setup-driver.js` — the byte-stream/prompt-detection state machine. This is the layer the ticket's debug-logging and any fix work targets.
- **Frontend pure-parser layer**: `ui/setup-parse.js` — `detectPrompt`/`detectFailure`, called by the driver after every chunk. A fix here would only be warranted if the Windows recording shows CLI screen text that this parser misclassifies (e.g. different anchor wording, different ANSI cursor markers).
- **Frontend view layer**: `ui/setup-view.js` — consumes the driver's `onPrompt`/`onLog`/`onScreen` contract; not expected to need changes per the ticket, but is the layer that would surface any driver-contract change.
- **Backend PTY layer**: `src-tauri/src/commands/pty.rs` — already cross-platform (`cfg!(windows)` branch for `spawn_pty`); ticket explicitly says no src-tauri changes expected.
- **Test layer**: `ui/test/setup-driver.test.mjs` + `ui/test/fixtures/setup/*.json` — six (per ticket) or four (per actual file content) `real stream:`-labeled tests replay byte-for-byte captured frames through `startSetup` with `makeFakePty`/`makeFakeTerminal`. New Windows-parallel tests belong here, using the same `replay`/`typedOut`/`ans` helpers.

### Integration Points

- `ui/setup-driver.js` → `./setup-parse.js` (static import of `detectPrompt`, `isQ`) — the only static cross-module import in the driver.
- `ui/setup-driver.js` → `./runner-bridge.js` (`pty.spawnPty`, `pty.input`, `pty.kill`) and `./vendor/xterm.mjs` (`Terminal`) and `./terminal.js` (`suspendPtyInput`, `resumePtyInput`) — all lazily `import()`ed inside `runSetup`, all overridable via `deps` in tests.
- `ui/setup-view.js` → `./setup-driver.js` (`startSetup`, `cancelSetup`, lazily imported), `./setup-parse.js` (`detectFailure`, statically imported — safe since it is a pure module with no window dependency), `./steps-ui.js`, `./models.js`, `./failure-panel.js`, `./option-cards.js`.
- `ui/handlers.js` → `deps.platform` (from `get_platform_info`) for its own, unrelated `isWin` fork; no shared code path with `setup-driver.js`.
- Backend: `spawn_pty` Tauri command → emits `engine:pty-data` (base64-encoded chunks) and `engine:pty-exit` events; the frontend `runner-bridge.js` (not read in this pass, but referenced by the driver) presumably subscribes to these and re-exposes `pty.spawnPty`/`pty.input`/`pty.kill` to the driver.

### Patterns and Conventions

- Lazy dynamic `import()` inside function bodies (never static top-level import) for any module touching `window`/Tauri globals, so headless/node:test can exercise the driver and view without a real browser — documented explicitly in both files' header comments.
- `deps` dependency-injection object as the sole test seam; no class hierarchy, no factory registry — every fake is a plain object/closure (`makeFakePty`, `makeFakeTerminal`).
- Extensive inline "why" comments citing specific vendored CLI source lines (e.g. `inquirer/lib/prompts/input.js:50`) and specific dated real-world PTY recordings (e.g. "measured 2026-09-14", "measured in the app on 2026-09-09") as the evidentiary basis for driver logic — this is the established convention the ticket's own instructions (record real Windows behavior before fixing) are asking to be followed for Windows too.
- Fixture-replay test pattern: `fixture(id)` reads a captured JSON array of 30 terminal lines from `ui/test/fixtures/setup/<id>.json`; `replay(frames, answers)` drives a sequence of such frames through a fake PTY to reproduce exact real-world CLI byte-stream ordering.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — describes the frontend-brain + thin Rust backend (Option B) pattern and IPC conventions; not fully read in this pass but is AGENTS.md's designated P0 guide for architecture-classified tasks.
- `.ai-run/guides/testing/testing-patterns.md` — designated P0 guide for testing tasks (adding the Windows real-stream tests falls under this); not read in full here, but AGENTS.md names it explicitly as covering "Rust inline tests + JS node:test patterns, smoke modes."
- `.ai-run/guides/quality-gates.md`, `.ai-run/guides/standards/git-workflow.md`, `.ai-run/guides/development/development-practices.md`, `.ai-run/guides/project.md` also exist per AGENTS.md's table but were not read in depth in this research pass; the caller should load the ones matching the eventual task category (testing + development) before implementation.
- Sibling task docs in `docs/superpowers/tasks/` provide direct prior-art on this exact feature: `2026-09-08-epmcdme-14668-guided-setup-driver/` (the driver's original spec/plan), `2026-09-09-epmcdme-14513-setup-view-ui/` (the view's spec/plan), `2026-09-04-epmcdme-14651-setup-prompt-parser/` (the parser's technical-analysis). These are the tasks whose plans produced the code read above and are the natural place to find the original (macOS) round-numbered review-fix history (CR-001..CR-005, round-2..round-5) that the driver's comments reference.

### Architectural Decisions

- Driver comments encode numbered decisions directly in-line rather than in a separate ADR file: "round-3 review fix #1/#2" (async `Terminal.write()` parsing), "CR-001..CR-005" (model pagination bounds, in-flight guard, kill-error handling, etc.), "round-4 review fix (R4-1/R4-2)" (idle-based signature staleness, page-viewport pagination). These are load-bearing invariants for any Windows-specific change and must not be broken by a Windows fix.
- `ui/handlers.js`'s wizard-step `isWin` fork is confirmed (per the task's own framing, corroborated by this research) architecturally distinct from the guided-setup driver/view pair — no shared module, no shared test file, no shared fixture set.

### Derived Conventions

- No `.ai-run/guides/` file specifically documents the setup-driver/setup-parse contract; conventions were derived from the extensive inline comments and the existing macOS "real stream" test pattern, which is itself the documented convention for adding new coverage of a real captured CLI interaction.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/setup-driver.test.mjs` is the single test file covering `setup-driver.js` and (indirectly, via re-exported `detectPrompt`/`detectFailure`) `setup-parse.js`. It contains on the order of 60+ individual `test(...)` cases (single-flight guard, dedup/echo-suppression logic, model pagination, validation-error re-ask, idle-timer fallback/rejection, retry/cancel semantics, and the 4 `real stream:`-labeled fixture-replay tests plus 2 more using the same replay machinery under different titles).
- All existing "real stream" replay fixtures/inline frame arrays are captured from a macOS PTY session (explicitly dated "2026-09-14" in comments); none are Windows captures.
- No test file for `ui/setup-view.js` was located in this pass beyond what is referenced in the sibling task doc `2026-09-09-epmcdme-14513-setup-view-ui/`; not directly in scope for this ticket per the task description (only `setup-driver.test.mjs` is named as the target for new tests).
- No dedicated Rust test exists for the Windows `spawn_pty` branch beyond `win_tests::spawn_external_ps_exits_zero_for_noop_command` (which tests the unrelated `spawn_external_ps` command, not `spawn_pty` itself); `pty.rs`'s Windows `spawn_pty` code path has no `#[cfg(all(test, windows))]` equivalent to the unix `kill_terminates_real_child` test.

### Testing Framework and Patterns

- `node --test ui/test/*.test.mjs` (from `package.json`'s `"test"` script) — Node's built-in `node:test` runner, `node:assert/strict`.
- Fixture files loaded via `readFileSync`/`fileURLToPath` relative to the test file's own URL.
- Fake/mock pattern throughout: no mocking library: hand-rolled `makeFakePty`/`makeFakeTerminal` closures, plus `node:test`'s built-in `ctx.mock.timers` for controlled idle-timer advancement in several tests.

### Coverage Gaps

- Zero Windows-captured PTY fixtures or frame sequences exist anywhere in `ui/test/fixtures/setup/` or inline in `setup-driver.test.mjs` — this is precisely the gap task EPMCDME-14982 exists to close.
- No test asserts anything about `powershell.exe`'s echo/redraw timing, chunk boundaries, or CRLF-vs-LF line endings, all of which are exactly the axes the task calls out as likely to diverge (chunking, echo/repaint order, ctrl-U behavior, arrow-key nav, `>>` marker positioning).
- `pty.rs`'s Windows `spawn_pty` branch (as opposed to the separate `spawn_external_ps`) has no platform-gated Rust test at all.

---

## 5. Configuration and Environment

### Environment Variables

- `HOME` (unix) / `USERPROFILE` (windows) — read by `pty_env_pairs` in `src-tauri/src/commands/pty.rs` to set the child's home-dir env var and `cwd`.
- `PATH` — read from the parent process and prepended with the npm-agents bin dir via `crate::commands::npm_env::prefixed_path_with_bin_dir`.
- `npm_config_prefix` — set conditionally when `npm_env_for` resolves a non-empty prefix.
- `TERM` — hardcoded to `"xterm-256color"` for both platforms in `pty_env_pairs_for`.

### Configuration Files

- No JSON/YAML config file governs `setup-driver.js`'s behavior directly; all tunables (`IDLE_MS`, `COLS`/`ROWS`, pagination bounds) are in-file constants, not externally configurable.
- `config/steps.yaml` (referenced by the task description as driving the unrelated legacy Wizard flow via `ui/handlers.js`) was not located by glob under this exact name/path in this pass, but its existence is asserted by the task description and by `handlers.js`'s step-id dispatch table (`'2.3.3'`, `'2.3.5'`) — confirmed structurally separate from the guided-setup driver.

### Feature Flags and Deployment Concerns

- None found specific to guided setup or Windows PTY behavior. `spawn_pty`'s platform branch (`#[cfg(windows)]`/`#[cfg(not(windows))]`) is a compile-time, not runtime, toggle.

---

## 6. Risk Indicators

- **Task-description factual mismatch**: the task names the parser module `ui/setup-prompt.js`; the file on disk is `ui/setup-parse.js`. Any plan/spec referencing the wrong filename will fail at import time — this must be corrected before implementation.
- **Test-count mismatch**: the task says there are "six 'real stream' tests" to mirror; only four tests are actually titled `'real stream: ...'` in `ui/test/setup-driver.test.mjs` (two more tests use the same `replay`/fixture-frame style under different, non-`real stream:` titles). The plan should explicitly decide whether "six" means the four literally-titled tests plus the two stylistically-similar ones, or something else, rather than assuming the ticket's count is literally correct.
- Speculative: capturing real Windows PTY behavior requires running the actual app on a Windows machine (or CI Windows runner) with a real `codemie setup --force` invocation through `powershell.exe`; this research pass cannot itself produce that capture, only the harness to receive it (the existing `deps.onLog`/temporary debug-log points inside `runSetup`/`processChunk`/`handleDetectedPrompt`).
- The driver's dedup/echo-suppression logic (signature guard, `lastAnsweredInput`, `answeredOnce`, idle-staleness gating) is dense, timing-sensitive, and validated today only against macOS-recorded byte sequences; PowerShell's own line-editing/redraw behavior (which may differ from zsh's TTY driver in chunk boundaries, CRLF handling, or ANSI cursor-positioning sequences) is exactly the kind of divergence the extensive inline "measured against the real CLI" comments warn is easy to get wrong by assumption alone — this is the documented reason three real bugs were previously missed on macOS by inference rather than recording.
- No Windows-specific Rust test exists for `spawn_pty` itself (only for the unrelated `spawn_external_ps`), so any Windows PTY-spawning regression in `pty.rs` would not be caught by the existing Rust test suite — though the ticket states no `src-tauri` changes are expected.
- `ui/handlers.js`'s `isWin` fork is a plausible source of confusion for anyone searching the codebase for "windows" + "pty" + "setup"; it must be actively excluded from scope during planning, as the task description already flags.

---

## 7. Summary for Complexity Assessment

This task touches a single, already-well-isolated frontend layer: the headless PTY driver (`ui/setup-driver.js`, ~970 lines) and its pure prompt parser (`ui/setup-parse.js`, ~140 lines), both already structured for dependency injection and lazy-import testability, with a matching test file (`ui/test/setup-driver.test.mjs`, ~1800 lines, 60+ existing tests) that already contains the exact "byte-for-byte captured real stream, replayed through fake PTY/terminal" pattern the new Windows tests need to mirror. The backend PTY-spawning layer (`src-tauri/src/commands/pty.rs`) is already cross-platform via `cfg!(windows)` and the ticket explicitly expects no changes there. This narrows the technical surface considerably: no new architecture, no new dependencies, no new files beyond test fixtures/cases, and (per the ticket) any production-code fix in `setup-driver.js`/`setup-parse.js` is conditional on what a live Windows recording actually shows, not a known-upfront requirement.

The primary complexity driver is procedural rather than architectural: the work is gated on an artifact (a real captured Windows PTY session) that cannot be produced by static code research and requires running the actual app on Windows with temporary debug logging, observing real `powershell.exe` echo/chunking/redraw behavior, and only then deciding whether `setup-driver.js` needs a genuine fix or whether the six new tests can simply assert the existing macOS-derived logic already holds on Windows too. The task description itself flags that assumption-based tests previously missed three real bugs on macOS, which is the explicit rationale for requiring a live recording step before writing Windows tests — skipping that step and inferring Windows byte-stream shapes from macOS fixtures would carry the same risk of writing tests that pass against a wrong assumption rather than real CLI behavior.

Secondary risk factors are two factual discrepancies inside the task description itself (a wrong filename for the parser module, and a test count of "six" against four actually-titled `real stream:` tests) that should be resolved during planning rather than carried forward uncorrected, plus the general density and timing-sensitivity of the driver's existing dedup/idle-timer logic, which any Windows-specific fix must not regress on the macOS path — the existing macOS "real stream" tests and their fixtures must remain untouched, as the ticket explicitly requires.

---

## 8. External References

None named by the task. The task's own text points at in-repo files (`ui/setup-driver.js`, `ui/setup-view.js`, `ui/setup-prompt.js` [actually `ui/setup-parse.js`], `ui/test/setup-driver.test.mjs`, `src-tauri/src/commands/pty.rs`, `ui/handlers.js`) and at "prior analysis" of the `ui/handlers.js` isWin fork's out-of-scope status; no path or URL outside this repository, and no path under a guide/plugin/sibling-checkout, was named as a source of truth to read. The referenced "prior analysis" was searched for under `docs/` and not found as a separate document beyond this task's own `state.local.json` (empty phase marker) — treated as informal context rather than a citable external source.
