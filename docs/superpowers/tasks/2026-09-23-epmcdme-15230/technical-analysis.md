# Technical Research

**Task**: command-log runner-bridge pty cmdlog
**Generated**: 2026-09-23T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-14512 — CodeMie Desktop: Command log ("What CodeMie ran")

Build a structured record of every CLI command the application runs, and the screen that shows it.
Today the only logging is flat tagged text lines with no notion of a command, exit code, or duration.

Reference wireframe attachment: 05-health.png shows "Health, and the command log" as one design pass,
but only the RIGHT half (command log) is in scope here; the left half (Health screen) is EPMCDME-14506.

Prerequisites (already landed on main, since codemie-desktop was merged into main):
- EPMCDME-14511: provides the shell and the `command-log-footer` / `command-log-body` region in
  ui/index.html to render into, plus reusable line styling classes (.log-line, .log-stdout,
  .log-stderr, .log-info, .log-success, .log-dim, .log-prompt).
- EPMCDME-14647: provides a per-command correlation id on `engine:pty-data` / `engine:pty-exit`,
  carried through the bridge, plus `pty_kill`. Must be consumed, not re-added.

Where to instrument: `ui/runner-bridge.js` (NOT the renderer's emit sink — it only carries tagged
text, no structured exit code). Five command paths to cover:
1. runner.runStream(cmd, onLine) — ui/runner-bridge.js:17-30 — streams via engine:cmd-line, resolves {code}
2. runner.runCapture(cmd) / runFreshEnv — ui/runner-bridge.js:12-13 — returns {code, stdout, stderr}
3. pty.spawnPty(cmd, cols, rows) — ui/runner-bridge.js:104-116 — streams via engine:pty-data, exit via engine:pty-exit
4. runAction(title, cmd, ...) — ui/renderer.js:219 — delegates to bridge.pty.spawnPty
5. codemie self-update — ui/renderer.js:287 — direct invoke('run_self_update'), bridge already
   declares runSelfUpdate at ui/runner-bridge.js:64 but it has zero call sites; must re-point
   runUpdateCli at updater.runSelfUpdate.

PTY requirements: pty.rs base64-encodes each chunk before emitting engine:pty-data so multi-byte
UTF-8/ANSI sequences split across reads aren't corrupted — frontend must accumulate decoded bytes
and use a streaming TextDecoder with stream:true. PTY children set TERM=xterm-256color so ANSI
escapes must be stripped before storing/rendering (command log rows are plain divs using textContent).

Capture classification: runCapture/runFreshEnv are mostly read-only probes (git --version, node
--version, npm config get prefix) but ui/handlers.js:171 runs `npm config set prefix` which mutates
the machine and must be recorded. Classify by intent (user-initiated vs read-only probe) marked
explicitly at each call site, not by transport.

Current state: src-tauri/src/commands/logger.rs:39-50 writes one flat line
`[timestamp] [TAG] text` to $HOME/Library/Logs/CodeMie/codemie_wizard.log (the debug log, separate
from this command log). ui/log.js is line-oriented, insufficient for this data model. run_capture,
run_stream, and log_line are already registered as Tauri commands.

New Rust module required: src-tauri/src/commands/cmdlog.rs, registered via
`pub mod cmdlog;` in src-tauri/src/commands/mod.rs AND added to generate_handler! in
src-tauri/src/lib.rs. Record model: id, command string, exit code, start time, duration, raw output.
Commands needed: open a record, append output, close with exit code, list records, get one record
by id.

Clipboard "Copy all": prefer browser clipboard API (window.isSecureContext + navigator.clipboard),
fallback tauri-plugin-clipboard-manager if unavailable; must fire inside the click handler (user
activation requirement).

Plain-language failure interpretation: small explicit mapping (non-zero exit w/ no output, network
error string, command-not-found) as an importable ES module with its own test; unrecognised
failures show raw output alone; never replaces raw output; do not build a general error-classifier.

Explicit do-not list: don't instrument the renderer's emit sink; don't record per screen; don't
decode engine:pty-data chunk-by-chunk into strings; don't skip ANSI stripping; don't add a guard
rejecting concurrent PTY spawns (EPMCDME-14513 needs overlapping lifetimes); don't classify
recorded-or-not by which bridge function was used; don't reuse ui/log.js's window-resizing expand
behavior; don't build the Health screen (EPMCDME-14506); no filtering/search/tail/export/clear/session-list.

Tests: UI tests in ui/test/*.test.mjs with node:test (run by npm test); Rust tests inline under
#[cfg(test)].

---

## 2. Codebase Findings

### Existing Implementations

**Frontend bridge — `ui/runner-bridge.js` (158 lines total, current content read in full):**
- `runner.runCapture(cmd)` (line 12) → `invoke('run_capture', { cmd })`
- `runner.runFreshEnv(cmd)` (line 13) → `invoke('run_fresh_env', { cmd })`
- `runner.runStream(cmd, onLine)` (lines 17-30) → emits the `> cmd` prompt line itself via `onLine`, listens on `engine:cmd-line` keyed by a locally generated `id` (via `nextId('stream')`), resolves `{ code }` from `invoke('run_stream', { cmd, streamId: id })`
- `updater.runSelfUpdate` (line 82) → `invoke('run_self_update')` — **declared but has zero call sites anywhere in `ui/`** (confirmed by repo-wide grep); the only actual caller of `run_self_update` is `ui/renderer.js:485` via a **direct** `invoke('run_self_update')`, bypassing the bridge entirely — this matches the task's point 5 exactly.
- `pty.spawnPty(cmd, cols, rows, onData)` (lines 128-153) — generates `id = nextId('pty')`, registers the `onData` listener on `engine:pty-data` **before** invoking `spawn_pty` (comment: "so no early events for this id are missed"), registers `engine:pty-exit` listener, resolves `{ code, id }`. Both listeners are inside the `try` so a `finally` always unregisters both — this is the EPMCDME-14647 correlation-id landing (CR-005 fix noted inline). Confirmed present and functioning — the prerequisite is satisfied.
- `pty.kill: () => invoke('pty_kill')` (line 156) — the EPMCDME-14647 kill export, present.
- No `cmdlog`/command-log export exists yet in this file — greenfield addition.

**`ui/renderer.js` (2000+ lines; relevant sections read at 85-130, 190-310, 330-500):**
- `emit(event, payload)` (line 103) — **this is the renderer's emit sink the task explicitly excludes from instrumentation.** It routes `terminal-line` events to `invoke('log_line', ...)` (the existing flat debug log) and to `appendLine` (ui/log.js's collapsible panel), plus a switch over `status-change`/`subtitle-change`/`spinner-start`/`substep-activate`/`download-progress`/`approval-needed`. It carries only `{text, tag}` for terminal lines — no exit code, no command string, no duration — confirming the task's statement that this sink is structurally insufficient for the command-log data model.
- `runAction(title, cmd, returnView, hint)` (lines 352-361, not 219 as the ticket text states in this checkout — see Risk Indicators) — opens the terminal overlay, calls `bridge.pty.spawnPty(cmd)`, destructures `{ code }`, writes a colored finish/fail line via `writeLine`. Called from `runAnalytics()` (line 442, `codemie analytics --report ...`) and from two proxy-connect buttons (lines 757, 764: `codemie proxy connect desktop`, `codemie proxy stop; codemie proxy connect desktop`).
- `runUpdateCli()` (lines 480-499+) — calls `invoke('run_self_update')` directly (line 485), then `invoke('check_codemie_version')` to re-probe. This is the exact call site the task wants re-pointed at `updater.runSelfUpdate`.
- `startSignIn()` (lines 394-427) uses `bridge.runner.runStream('codemie profile login', ...)`.
- Step handler `'2.4'` in `ui/handlers.js` also calls `runner.runStream('codemie doctor', ...)`.

**`ui/handlers.js` (currently 100 lines total — read in full):**
- Contains exactly **three** step handlers: `'2.3.3'` (runPty 'codemie setup'), `'2.3.5'` (runPty 'codemie install claude --supported'), and `'2.4'` (runStream 'codemie doctor'). Windows variants of 2.3.3/2.3.5 go through `runExternalWindow` → `externalWindow.spawnPs`, not through runner-bridge's runner/pty paths.
- **The `npm config set prefix` mutation call site the task names at `ui/handlers.js:171` does not exist in this checkout.** It existed transiently (added originally, still present in the intermediate commit `2755aa6`) but was deleted wholesale by commit `e417c99` ("refactor(EPMCDME-14505): delete six-layer acquisition flow", 2026-09-02) along with the entire `'1.1'`/`'1.3'` acquisition-flow handlers. See Risk Indicators — this is a discovered fact, not a guess.
- Consequently `runner.runCapture` / `runner.runFreshEnv` currently have **zero call sites** anywhere in `ui/*.js` (repo-wide grep confirms only the two bridge declarations at lines 12-13). The only remaining reads named in the task ("git --version, node --version, npm config get prefix") do not exist as live call sites in this checkout either.

**`ui/log.js` (34 lines, read in full):** collapsible panel bound to `#log-content`/`#log-panel`/toggle button; `appendLine(text, tag)` creates a `div.log-line.log-<tag>` with `textContent = text`. Resizes the whole Tauri window (`COLLAPSED_H`/`EXPANDED_H`, `invoke('set_window_height', ...)`) on toggle — this is the "window-resizing expand behavior" the task says not to reuse.

**`ui/index.html`** (region read at lines 224-248): the command-log region already exists exactly as EPMCDME-14511 left it —
```html
<!-- Hidden for v1, not deleted: nothing writes to #command-log-body yet,
     so the disclosure opens on an empty panel. Remove the `hidden` class
     when the ticket that fills it lands. -->
<details id="command-log-footer" class="hidden">
  <summary>what CodeMie ran</summary>
  <div id="command-log-body"></div>
</details>
```
It is a sibling of `#terminal-overlay` and `#notice-overlay`, still marked `hidden` and empty.

**`ui/styles.css`** — confirmed present (lines 145-164, 543-549): `#command-log-footer` collapsible-`<details>` styling with a `▸`/`▾` `::before` marker on `<summary>`, `#command-log-body { padding: 0 16px 10px; }`, and the reusable line classes `.log-line`, `.log-stdout`, `.log-stderr`, `.log-info`, `.log-success`, `.log-dim`, `.log-prompt` — all exactly as EPMCDME-14511 was said to provide.

**Backend — `src-tauri/src/commands/logger.rs`** (86 lines, read in full): `write_line`/`format_line` write `[iso-ts] [TAG] text\n` to `~/Library/Logs/CodeMie/codemie_wizard.log`; `map_tag` maps renderer tags (`stdout`/`stderr`/`info`/`success`/`dim`/`prompt`/`approved`) to short codes (`OUT`/`ERR`/`INF`/`OK`/`---`/`CMD`). `#[tauri::command] pub fn log_line` and `pub fn open_log` are the two registered commands. This is the flat text log the task says is insufficient and separate from the new command log.

**`src-tauri/src/commands/pty.rs`** (419 lines, read in full):
- `spawn_pty(app, state, cmd, cols, rows, run_id)` — reader thread pumps 4096-byte chunks, base64-encodes each (`base64::engine::general_purpose::STANDARD.encode`) before `app.emit("engine:pty-data", {id: run_id, data})`; a separate child-wait thread emits `engine:pty-exit` with `{id, code}` and clears the `AppState.pty` slot only `if` it still belongs to that `run_id` (`clear_if_owner`). PTY children get `TERM=xterm-256color` (both unix and windows builders) — confirms the task's ANSI-stripping requirement is real (escape sequences will appear in the byte stream).
- A single-slot guard already exists (`if guard.is_some() { return Err("PTY already active") }`, line ~111) — this is the *existing* concurrency guard on `spawn_pty` itself, distinct from the "don't add a guard rejecting concurrent PTY spawns" instruction in the task (which is about not adding a *new* one in the command-log feature for EPMCDME-14513's benefit — the existing one is pre-existing runner.rs/pty.rs behavior, not something this task touches).
- `pty_kill` (lines 195-233) — async command using `tokio::task::spawn_blocking` + a condvar wait with a 5s timeout; already handles the benign-race case where the child exits between slot-release and kill(). This is the EPMCDME-14647 kill export the bridge's `pty.kill` wraps.
- Extensive inline `#[cfg(test)]` coverage in this file already (real-child kill, condvar timing, `clear_if_owner` ownership).

**`src-tauri/src/commands/runner.rs`** (277 lines, read in full):
- `shell_cmd(cmd_str)` — platform branch (`/bin/zsh -lc` on unix, `cmd.exe /c` + `CREATE_NO_WINDOW` on Windows).
- `capture(cmd, path_override)` → `CaptureResult { code, stdout, stderr }`; spawn error maps to code 127.
- `run_capture` / `run_fresh_env` — both `#[tauri::command]`, thin wrappers around `capture`.
- `run_stream(app, cmd, stream_id)` — spawns with piped stdout/stderr, `pump()` (tokio task per stream) emits `engine:cmd-line { id, text, tag }` per line, returns the exit code as `i32`.
- `run_self_update` — resolves `state.node_exe_path`/`state.cli_entry_path` (bundled node+CLI) when present, else falls back to `capture("codemie self-update", None)`; the `existing_cli_detected` flag on `AppState` suppresses spurious warnings when an existing CLI took precedence over the bundled one (EPMCDME-14581). This is the command the ticket's point 5 concerns.
- Inline `#[cfg(test)]`/`#[cfg(all(test, unix/windows))]` tests for `capture`, plus a `tests_self_update` module using `tempfile::TempDir` to fabricate a non-executable "node" and assert `self_update_direct` errors.

**`src-tauri/src/commands/mod.rs`** (13 lines, read in full) — one `pub mod <name>;` line per command module: `app_updater`, `codemie_config`, `downloader`, `handshake`, `inspector`, `installer`, `logger`, `pathman`, `pty`, `runner`, `smoke`, `window`. No `cmdlog` module yet — this is exactly where `pub mod cmdlog;` needs to be added.

**`src-tauri/src/lib.rs`** — `generate_handler!` block (lines 92-132, read in full) lists every registered command explicitly, one per line, grouped by originating module with no macro/registry indirection — a new `cmdlog::*` command must be added here by hand, following the existing flat-list convention (e.g. immediately after the `logger::*` entries, matching the module's place in `mod.rs`).

**`src-tauri/src/state.rs`** (41 lines, read in full) — `AppState` is a single `#[derive(Default)]` struct holding `remembered: Mutex<Vec<String>>`, `pty: Mutex<Option<(String, PtyHandle)>>`, `node_exe_path`/`cli_entry_path: PathBuf`, `pre_injection_path: String`, `bundled_injected: bool`, `existing_cli_detected: bool`, `last_update_check: Mutex<Option<Instant>>`. This is the natural place a `cmdlog` record store (e.g. `Mutex<Vec<CmdRecord>>` or `Mutex<HashMap<String, CmdRecord>>`) would be added, following the existing `Mutex<T>`-field-per-concern pattern — but note this is a design choice for the spec/plan stage, not a discovered requirement.

### Architecture and Layers Affected

Per `.ai-run/guides/architecture/architecture.md` ("Option B: frontend-brain + thin Rust backend"):
- **Frontend orchestration layer**: `ui/runner-bridge.js` (IPC wrapper layer — the task's primary instrumentation point), `ui/renderer.js` (view routing + two direct call sites: `runAction`, `runUpdateCli`), `ui/handlers.js` (per-step logic — currently only 3 handlers, none call `runner.runCapture` directly).
- **New Rust command layer**: `src-tauri/src/commands/cmdlog.rs` (new module, mirrors the one-module-per-concern pattern of `runner.rs`/`pty.rs`/`logger.rs`), registered in `commands/mod.rs` and `lib.rs`'s `generate_handler!`.
- **State layer**: `src-tauri/src/state.rs` `AppState` — likely extension point for an in-memory record store (design decision, not yet made).
- **UI layer**: `ui/index.html`'s existing `#command-log-footer`/`#command-log-body` region, `ui/styles.css`'s existing `.log-*` classes — both already landed and unused.
- **Not touched**: the Health screen (EPMCDME-14506, out of scope), `ui/log.js` (explicitly not to be reused for its resize behavior, though its `appendLine`/tag-class pattern is a precedent for row rendering).

### Integration Points

- `engine:cmd-line` (from `run_stream`) and `engine:pty-data`/`engine:pty-exit` (from `spawn_pty`) are the two Tauri event channels the command-log must observe, both already correlation-id-keyed (`id`/`stream_id`/`run_id` — all frontend-generated via `nextId(prefix)` in `runner-bridge.js`).
- `run_self_update` (Rust) ↔ `updater.runSelfUpdate` (bridge, currently unused) ↔ `runUpdateCli` (renderer, currently bypasses the bridge) — the three-way link the task's point 5 asks to be closed.
- `log_line` (Rust, flat debug log) is invoked directly from `renderer.js`'s `emit()` sink — separate system, not to be touched by this task, but a naming-collision risk: the debug log and the new command log both use `Utc::now()` timestamp formatting conventions in `logger.rs`, which is a reasonable pattern for `cmdlog.rs` to mirror (`chrono::Utc`, already a dependency).

### Patterns and Conventions

- **Command module pattern**: one file per concern in `src-tauri/src/commands/`, `#[tauri::command]` free functions, `CmdResult<T>` (thiserror-based `InstallerError` alias, `src-tauri/src/error.rs`) for fallible commands, plain `T` for infallible ones. Registration is a flat, hand-maintained list in `mod.rs` (module declarations) and `lib.rs` (`generate_handler!` — no macro-based auto-registration).
- **Bridge pattern**: `runner-bridge.js` groups exports into one `const <domain> = {...}` object per Rust module (`runner`, `inspector`, `updater`, `pathman`, `downloader`, `pty`), each method a thin `invoke()`/`listen()` wrapper; a module-local `nextId(prefix)` counter generates correlation ids for any command that needs to key an event stream.
- **Pure-function ES module + dedicated test file pattern**: `ui/app-updater-utils.mjs` (6 lines: one exported pure function, `shouldCheckForAppUpdate`) + `ui/test/app-updater-utils.test.mjs` (node:test, no mocking) is the exact precedent to mirror for the "plain-language failure interpretation" module the task calls for.
- **PTY byte handling precedent**: `ui/terminal.js:100-110` (`writeData(b64)`) already does the base64-decode-to-`Uint8Array` dance for `engine:pty-data`, but hands the raw byte stream straight to xterm.js, which interprets ANSI itself — this is *not* directly reusable for the command log, since the log renders into plain `textContent` divs and must decode text (not raw bytes) and strip ANSI, not just feed a terminal emulator. This is exactly why the task calls for a streaming `TextDecoder`, not a re-use of `writeData`.
- **Rust test placement convention**: tests live in the same file under `#[cfg(test)] mod tests { use super::*; ... }`, sometimes split further by platform (`#[cfg(all(test, unix))]`, `#[cfg(all(test, windows))]`) — see `runner.rs` and `pty.rs` for the pattern to mirror in `cmdlog.rs`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — full component map, IPC pattern (`invoke()`/`listen()`, `engine:*` events), state pattern (`AppState`), and an explicit "Adding New System Commands" 6-step checklist (create/extend module → `#[tauri::command]` → `CmdResult<T>` → register in `lib.rs` → JS wrapper in `runner-bridge.js` → unit test in the same module) that `cmdlog.rs` should follow verbatim.
- `.ai-run/guides/testing/testing-patterns.md` — confirms the Rust/JS test organization and naming conventions above; explicitly documents what is *not* tested automatically (destructive install ops, network actions) via smoke modes.
- `docs/superpowers/tasks/2026-08-31-epmcdme-14511/` and `docs/superpowers/tasks/2026-09-02-epmcdme-14647-pty-correlation-id/` — prior task run directories exist for both named prerequisites, confirming they were run as tracked SDLC tasks (not read in full; out of scope per the "sourcing vs. survey" cap, and the task itself did not name these paths as sources of truth).

### Architectural Decisions

- Inline decision markers found in code, not separate ADR files: `pty.rs`'s header comment cites "technical-analysis §12" for the blocking-reader-on-a-dedicated-thread decision; `runner-bridge.js`'s `spawnPty` has a `CR-005` comment explaining the try/finally listener-cleanup ordering; `pty.rs`'s `pty_kill` has `CR-002`/`CR-003`/`CR-004` comments explaining the benign-race and spurious-wakeup handling — these are all inline "DECISION"-equivalent markers worth preserving as precedent for documenting non-obvious choices in `cmdlog.rs`.
- `state.rs`'s `existing_cli_detected` field comment documents the EPMCDME-14581 decision to skip bundled-path injection when an existing CLI is found — relevant context for how `run_self_update` behaves, though not directly part of this task.

### Derived Conventions

- No guide exists specifically for "command log" or "cmdlog" domain concepts — conventions are derived entirely from the `runner.rs`/`pty.rs`/`logger.rs` sibling-module pattern and the architecture guide's generic command-addition checklist, both covered above.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/pty-bridge.test.mjs` (82 lines, read in full) — the closest existing precedent for testing `runner-bridge.js`: stubs `window.__TAURI__.core.invoke` and `.event.listen` with mutable delegates (`listenImpl`/`invokeImpl`), captures registered listeners per event name, and fires synthetic payloads to verify id-filtered routing (`spawnPty resolves only on its own id and onData filters by id`) and cleanup-on-throw ordering (`CR-005: data listener is cleaned up when exit-listen throws`). This is the direct pattern to extend for testing any new cmdlog instrumentation wrapped around `spawnPty`/`runStream`/`runCapture`.
- `ui/test/app-updater-utils.test.mjs` — precedent for testing a small, pure, importable ES module (see Patterns above).
- `src-tauri/src/commands/pty.rs` and `runner.rs` — extensive inline `#[cfg(test)]` coverage of the primitives the command log will observe (id-filtering via `clear_if_owner`, condvar timing, exit-code mapping), but **no test exercises the frontend-side aggregation or recording of that data** — there is no existing test asserting anything about "a command was recorded with exit code X after Y ms."
- `src-tauri/src/commands/logger.rs` — inline tests only cover `format_line`'s timestamp/tag formatting, not any structured-record concept.

### Testing Framework and Patterns

- JS: Node's built-in `node:test` + `node:assert/strict`, no third-party test framework or mocking library. Global `window.__TAURI__` is hand-stubbed per test file (see `pty-bridge.test.mjs` lines 10-15).
- Rust: `cargo test`, `#[tokio::test]` for async, `tempfile` crate already a dev-dependency for filesystem-touching tests (used in `runner.rs`'s `tests_self_update` module) — directly reusable if `cmdlog.rs` needs to touch a temp file/dir in a test.

### Coverage Gaps

- No existing test covers ANSI-stripping logic (doesn't exist yet).
- No existing test covers streaming `TextDecoder` usage with multi-chunk UTF-8 boundaries (the base64/atob path in `terminal.js` handles raw bytes to xterm, not decoded text — a genuinely new code path).
- No existing test covers the clipboard "Copy all" behavior (no clipboard code exists anywhere in `ui/` or `src-tauri/` today — confirmed by repo-wide case-insensitive grep for "clipboard", which matched only `ui/vendor/xterm.mjs`, a bundled third-party file, not application code).
- No existing test covers a Rust-side record store (list/get/open/append/close) since `cmdlog.rs` doesn't exist yet.
- No existing test covers the "plain-language failure interpretation" mapping (module doesn't exist yet, though the `app-updater-utils.mjs` pattern is a ready precedent).

---

## 5. Configuration and Environment

### Environment Variables

- `HOME` (unix) / `USERPROFILE` (windows) — read by `logger.rs::log_dir()` and `pty.rs`'s command builders; no new env var is used or implied by any code found for the command-log feature.
- `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` — existing smoke-mode toggles (`commands/smoke.rs`, referenced in architecture.md and README.md:157), unrelated to command-log but the nearest existing "feature flag" precedent in this codebase.
- No env var named or implied for command-log retention, max-record-count, or similar in any file found.

### Configuration Files

- `config/steps.yaml` / `config/steps-windows.yaml` — embedded step definitions (`include_str!`), read via `steps::get_steps()`; the three handlers in `ui/handlers.js` correspond to steps `2.3.3`/`2.3.5`/`2.4` defined here. Not modified by this task per the do-not list (no per-screen recording implied).
- `src-tauri/Cargo.toml` (read, lines 1-48) — current `[dependencies]`: `serde_json`, `serde`, `serde_yaml`, `log`, `tauri = "2.11.2"`, `tauri-plugin-log = "2"`, `tokio` (features: macros/rt/rt-multi-thread/process/io-util/time/fs), `reqwest` (rustls-tls/stream/json), `futures-util`, `sha2`, `thiserror = "2"`, `chrono` (clock feature), `base64 = "0.22"`, `portable-pty = "0.8"`. Windows-only: `winreg`. Dev-deps: `tempfile`, `tauri-utils`.
- `package.json` — single script `"test": "node --test ui/test/*.test.mjs"`; no test runner config beyond the glob.

### Feature Flags and Deployment Concerns

- **`tauri-plugin-clipboard-manager` is NOT currently a dependency** — confirmed absent from `src-tauri/Cargo.toml`'s dependency list and absent from any `tauri.conf.json` plugin registration found. If the fallback path is implemented, it will be a genuinely new dependency addition (build.rs / capabilities/permissions changes typically required for Tauri v2 plugins) — this is a real integration cost, not just a code addition.
- No Dockerfile/CI config found referencing "command log", "cmdlog", or "clipboard" in this repo (not searched exhaustively beyond the areas above, since none of the guide files or manifests suggested CI gating on this feature specifically).

---

## 6. Risk Indicators

- **Stale ticket line-references, confirmed by git history**: the task's own text names `ui/handlers.js:171` as the `npm config set prefix` mutation call site. That code existed only transiently (visible in commit `2755aa6`) and was **deleted entirely** by commit `e417c99` ("delete six-layer acquisition flow", 2026-09-02) — the same day, and `ui/handlers.js` is now only 100 lines with exactly 3 handlers (`2.3.3`, `2.3.5`, `2.4`), none of which call `runner.runCapture`/`runFreshEnv` at all. `runner.runCapture`/`runFreshEnv` currently have **zero call sites** anywhere in `ui/`. Any spec/plan built on "instrument the mutating call at handlers.js:171" will target dead code; the actual current mutating-vs-read-only classification question the task raises has no live example to anchor on in this checkout. This needs to be resolved before implementation — either the ticket's premise predates the EPMCDME-14505 refactor, or a different, not-yet-identified call site is intended.
- **`runAction` is at `ui/renderer.js:352`, not line 219** as stated in the task text — a minor location drift, likely from the same code churn, but worth a fresh line-number check before editing.
- **No clipboard code exists anywhere in the app today** (only a false-positive match inside the vendored `xterm.mjs`). The fallback path (`tauri-plugin-clipboard-manager`) is a wholly new dependency, not currently present in `Cargo.toml` or any plugin registration — adding it is a larger integration than "call an existing plugin," and its Tauri v2 permissions/capabilities wiring is untested territory in this repo.
- **No streaming-text-decode precedent exists.** The only existing base64/PTY-byte handling (`ui/terminal.js:100-110`) decodes to raw bytes for xterm.js, which does its own ANSI interpretation — it does not decode to text or strip ANSI, so the command-log's `TextDecoder({stream:true}) + ANSI-strip` path is new code with no in-repo template, raising correctness risk around split multi-byte UTF-8 sequences and split ANSI escape sequences across chunk boundaries.
- **No ANSI-stripping utility exists** in the codebase (confirmed no "ansi"/"strip" hits outside vendored xterm) — will need to be written and unit-tested from scratch, including edge cases like partial escape sequences split across `engine:pty-data` chunks.
- **`AppState` extension is undecided**: a new record store needs a home (likely a `Mutex<...>` field on `AppState`, following the existing per-concern-field pattern), but no schema or storage strategy exists today — this is a design decision for the spec stage, not a discovered constraint.
- **Concurrency**: `spawn_pty` already refuses a second concurrent PTY (`state.pty` single-slot guard, `pty.rs` ~line 111) — pre-existing, unrelated to this task, but any command-log design that assumes one-active-record-at-a-time for PTY commands should double check this existing guard's interaction with EPMCDME-14513's stated need for overlapping PTY lifetimes (which the task explicitly says not to touch here, but the existing guard already restricts it at the Rust level, independent of anything this task does).
- **Five instrumentation points, one file gets busiest**: `ui/runner-bridge.js` is the named central instrumentation point for 3 of 5 paths (`runStream`, `runCapture`/`runFreshEnv`, `spawnPty`), while `renderer.js` needs two separate edits (`runAction`, `runUpdateCli`) — a cross-cutting change touching two files plus a new Rust module plus new UI rendering code plus a new pure-JS module (failure-mapping) plus (possibly) a new Cargo dependency (clipboard) is a wide surface for one ticket.
- **No guide names retention/limits for an in-memory command-log record store** — an unbounded `Vec`/`HashMap` growing for the lifetime of the app session is a plausible naive implementation with no upper bound; whether that matters is a spec/plan decision, not something discovered in code.

---

## 7. Summary for Complexity Assessment

This task touches four architectural layers: the frontend IPC bridge (`ui/runner-bridge.js`, the named central instrumentation point for 3 of 5 command paths), the renderer's view/action layer (`ui/renderer.js`, two separate call sites: `runAction` and `runUpdateCli`), a brand-new Rust command module (`src-tauri/src/commands/cmdlog.rs`, to be registered in both `commands/mod.rs` and `lib.rs`'s hand-maintained `generate_handler!` list), and existing-but-inert UI surface (`ui/index.html`'s `#command-log-footer`/`#command-log-body`, `ui/styles.css`'s `.log-*` classes) that the EPMCDME-14511 prerequisite already landed and confirmed present. A new pure-JS module (plain-language failure mapping) and its own test file round out the file-change surface — realistically six-plus files touched across two languages.

Technical novelty is real in three places: (1) decoding `engine:pty-data`'s base64 payload into text via a streaming `TextDecoder({stream:true})` rather than raw bytes-to-xterm (the only existing precedent, `ui/terminal.js:writeData`, does the latter and is explicitly not reusable here), (2) ANSI-escape stripping, for which zero prior art exists in this codebase, and (3) clipboard access, which requires adding `tauri-plugin-clipboard-manager` as a genuinely new dependency with Tauri v2 permissions/capabilities wiring — none of which exists today. The correlation-id plumbing this task depends on (EPMCDME-14647) is, by contrast, solidly landed and tested (`ui/test/pty-bridge.test.mjs`, inline `pty.rs` tests) and should be treated as a stable foundation, not a risk.

Test coverage posture is good for the primitives being consumed (extensive inline Rust tests on `pty.rs`/`runner.rs`, a working bridge-mocking pattern in `pty-bridge.test.mjs`, and a clean pure-function-module test precedent in `app-updater-utils.mjs`) but there is zero existing coverage for anything this task actually adds — record aggregation, ANSI stripping, decode-streaming, clipboard, or failure-mapping all start from scratch. The single highest-priority risk to resolve before planning is the confirmed factual discrepancy between the ticket's stated `ui/handlers.js:171` mutating-command call site and the current checkout, where that code was deleted by an unrelated refactor (`e417c99`) on the same day EPMCDME-14647 landed — the ticket's illustrative example of "capture vs. mutation" classification currently has no live instance to anchor on.

---

## 8. External References

The task names one external artifact: the wireframe attachment **05-health.png** ("Health, and the command log" design pass — only the right half, the command log, is in scope; the left half is EPMCDME-14506). This is a Jira attachment, not a filesystem path or URL resolvable from this repository — a repo-wide glob for `05-health.png` and for any `*.png` found no such file anywhere in the working tree (only unrelated Playwright evidence screenshots from prior tasks and app icon assets exist). **Unresolved**: the wireframe's visual layout (row structure, "Copy all" button placement, disclosure vs. modal presentation, failure-message placement relative to raw output) could not be sourced from the filesystem and must come from Jira directly or from whoever has access to the attachment.

No other path, directory, or URL is named by the task as a source of truth (the "Reference wireframe attachment" is the only such pointer, and it resolves outside this repository's reach).
