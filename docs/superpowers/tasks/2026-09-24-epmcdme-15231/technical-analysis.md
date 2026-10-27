# Technical Research

**Task**: cmdlog runner-bridge pty renderer
**Generated**: 2026-09-24T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15231 — CodeMie Desktop: Command log — bridge instrumentation by intent.

Scope:
- Wrap all five command-execution paths in ui/runner-bridge.js and ui/renderer.js so each records against the Rust cmdlog store (cmdlog_open/cmdlog_append/cmdlog_close via Tauri invoke).
- The five paths: runner.runStream, runner.runCapture/runFreshEnv, pty.spawnPty, renderer's runAction, updater.runSelfUpdate (re-pointed through bridge.updater.runSelfUpdate).
- Classify each call site as user-initiated vs read-only probe (explicitly, not by transport).
- Add streaming TextDecoder (stream:true) for engine:pty-data accumulating decoded+ANSI-stripped bytes.
- Strip ANSI escape sequences before storing PTY output.
- Use per-command correlation ID from EPMCDME-14647 (spawnPty returns {code, id}) for overlapping PTY.
- Add node:test coverage extending ui/test/pty-bridge.test.mjs pattern.

---

## 2. Codebase Findings

### Existing Implementations

**`ui/runner-bridge.js` (158 lines) — the primary instrumentation file:**
- `runner.runCapture(cmd)` (line 12) → `invoke('run_capture', { cmd })`; no cmdlog wrapping yet.
- `runner.runFreshEnv(cmd)` (line 13) → `invoke('run_fresh_env', { cmd })`; no cmdlog wrapping yet.
- `runner.runStream(cmd, onLine)` (lines 17–30) — generates `id = nextId('stream')`, emits `> cmd` prompt via `onLine`, listens on `engine:cmd-line` keyed by id, resolves `{ code }` from `invoke('run_stream', { cmd, streamId: id })`; no cmdlog wrapping yet.
- `updater.runSelfUpdate` (line 82) → `invoke('run_self_update')` — declared in the bridge but **has zero call sites** in `ui/`; the only live caller is `renderer.js` line 485 via a **direct** `invoke('run_self_update')`, bypassing the bridge entirely.
- `pty.spawnPty(cmd, cols, rows, onData)` (lines 128–153) — generates `id = nextId('pty')`, registers `engine:pty-data` listener (filtering by `id`) before `invoke('spawn_pty')`, registers `engine:pty-exit` listener, resolves `{ code, id }`. Both listeners are inside a try/finally (CR-005 fix). The per-command correlation id is live and functioning — EPMCDME-14647 is confirmed landed. No cmdlog wrapping yet.
- `pty.kill` (line 156), `pty.input`, `pty.resize` — present; not in scope for cmdlog.
- No `cmdlog` export exists in `runner-bridge.js` — this is a greenfield addition to the bridge surface.

**`ui/renderer.js` (869 lines) — two call sites to change:**
- `runAction(title, cmd, returnView, hint)` (lines 352–361) — opens terminal overlay, calls `bridge.pty.spawnPty(cmd)` without `onData`, destructures `{ code }`, writes a colored finish line via `writeLine`. Called from `runAnalytics()` (line 442) and two proxy-connect event listeners (lines 757, 764). Once `spawnPty` is wrapped in the bridge, `runAction`'s cmdlog coverage is inherited automatically; the classification (`user-initiated`) must be explicit at the call site or at the bridge wrap level.
- `runUpdateCli()` (lines 480–509) — calls `invoke('run_self_update')` **directly** (line 485), bypassing `bridge.updater.runSelfUpdate`. This is the exact re-pointing the task requires: change `invoke('run_self_update')` → `bridge.updater.runSelfUpdate()`.
- `startSignIn()` (lines 394–427) — calls `bridge.runner.runStream('codemie profile login', ...)`. Once `runStream` is wrapped, this is covered.

**`src-tauri/src/commands/cmdlog.rs` (213 lines) — fully implemented and landed (EPMCDME-15230):**
- `CmdRecord { id, command, start_time, exit_code, duration_ms, raw_output }` — the struct the JS bridge writes to.
- `CmdLogStore` with `open(command) -> String`, `append(id, chunk)`, `close(id, exit_code)`, `list() -> Vec<CmdRecord>`, `get(id) -> Option<CmdRecord>`.
- `cmdlog_open`, `cmdlog_append`, `cmdlog_close`, `cmdlog_list`, `cmdlog_get` — all `#[tauri::command]`, all registered. No JS action needed on the Rust side.
- Extensive inline `#[cfg(test)]` coverage: open/append/close lifecycle, double-close error, append-after-close error, unknown-id errors, insertion-order list, overlapping open/close isolation.

**`src-tauri/src/state.rs` (42 lines):**
- `AppState.cmdlog: Mutex<crate::commands::cmdlog::CmdLogStore>` — already added; derives `Default` so `CmdLogStore::default()` is called at app start.

**`src-tauri/src/lib.rs`:**
- `cmdlog_open`, `cmdlog_append`, `cmdlog_close`, `cmdlog_list`, `cmdlog_get` — all present in the `generate_handler!` block (lines 122–126). No further Rust registration work needed.

**`src-tauri/src/commands/mod.rs`:**
- `pub mod cmdlog;` — present (line 2). No changes needed.

**`src-tauri/src/commands/pty.rs` (relevant detail):**
- Each chunk from the PTY reader is base64-encoded before `app.emit("engine:pty-data", {id, data})`. PTY children run with `TERM=xterm-256color`, so ANSI escape sequences are present in the byte stream and must be stripped before storing in `raw_output`.
- `engine:pty-data` payload shape: `{ id: String, data: base64-encoded-bytes }`.
- `engine:pty-exit` payload shape: `{ id: String, code: i32 }`.

**`ui/terminal.js` (partial read, lines 1–30):**
- `writeData(b64)` decodes base64 to `Uint8Array` and feeds raw bytes to xterm.js — this is **not** reusable for the command log. The command log needs decoded text, not raw bytes. A new `TextDecoder({ stream: true })` per pty run (not per event) is required.

**`ui/test/pty-bridge.test.mjs` (82 lines) — the test pattern to extend:**
- Stubs `window.__TAURI__.core.invoke` and `.event.listen` via mutable delegate variables (`listenImpl`, `invokeImpl`) set before import, then reassigned per test.
- Captures registered listeners per event name in a `listeners` dict; fires synthetic payloads to verify id-filtered routing.
- Two tests: id-filtering correctness + CR-005 cleanup-on-throw ordering.
- This is the exact pattern for testing cmdlog wrapping in `runStream`, `spawnPty`, etc.

### Architecture and Layers Affected

- **Frontend IPC bridge layer** (`ui/runner-bridge.js`): primary file — 3 of 5 paths live here (`runStream`, `runCapture`/`runFreshEnv`, `spawnPty`); also `updater.runSelfUpdate`.
- **Frontend view/action layer** (`ui/renderer.js`): 1 direct call-site change (`runUpdateCli` re-pointed) plus any explicit intent annotation on `runAction`.
- **Rust command layer** (`src-tauri/src/commands/cmdlog.rs` + `state.rs` + `mod.rs` + `lib.rs`): fully complete; **no changes needed**.
- **Test layer** (`ui/test/`): new test file extending `pty-bridge.test.mjs` pattern.

### Integration Points

- `engine:cmd-line` events (from `run_stream`) carry `{ id, text, tag }` — the bridge's `runStream` already filters by id; cmdlog_append can be called per line from the same listener.
- `engine:pty-data` events carry `{ id, data: base64 }` — the bridge's `spawnPty` already filters by id in the `onData` listener; cmdlog_append with decoded+ANSI-stripped text goes in the same filtered handler.
- `engine:pty-exit` events carry `{ id, code }` — the bridge's `spawnPty` resolves `{ code, id }` from this event; cmdlog_close fires in the `finally` after the exit promise settles.
- `invoke('run_self_update')` in `renderer.js:485` must be re-pointed to `bridge.updater.runSelfUpdate()`, which in turn needs cmdlog_open/close wrapping inside the bridge.
- `invoke('run_capture')` / `invoke('run_fresh_env')` return a capture result directly (no streaming events) — cmdlog_open before invoke, cmdlog_close after resolution.

### Patterns and Conventions

- **Bridge pattern**: one `const <domain> = { ... }` export per concern in `runner-bridge.js`; a new `export const cmdlog = { open, append, close }` thin-wrapper export follows this pattern.
- **nextId(prefix)** counter (line 7) — already used for `'stream'`, `'dl'`, `'pty'`; no new counter needed since cmdlog ids come from `cmdlog_open`'s return value, not from the bridge's own counter.
- **Intent classification**: must be explicit at each call site as a parameter or comment, not inferred from which bridge method was called — per the task's "explicitly, not by transport" requirement. The prior task analysis (EPMCDME-14512) noted that `runCapture`/`runFreshEnv` currently have **zero live call sites** in `ui/`; the intent classification requirement applies when they gain call sites, not retrospectively.
- **Streaming TextDecoder**: `new TextDecoder('utf-8', { fatal: false })` with `decode(chunk, { stream: true })` — one decoder instance per `spawnPty` invocation (not per event), allocated inside the async function before the listener is registered.
- **ANSI stripping**: no utility exists in the codebase. A minimal regex-based strip function (covering `\x1b[...m`, `\x1b[...J/K/H`, OSC sequences) needs to be written and tested. The task's do-not list for EPMCDME-14512 says "don't skip ANSI stripping" — the stripping is required; a standalone importable function with its own test is the correct shape per the `app-updater-utils.mjs` precedent.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — confirmed present; covers "Adding New System Commands" 6-step checklist (create module → `#[tauri::command]` → `CmdResult<T>` → register in `lib.rs` → JS wrapper in `runner-bridge.js` → unit test). All Rust steps are already done for cmdlog; the JS-wrapper and unit-test steps are what this task adds.
- `.ai-run/guides/testing/testing-patterns.md` — present; governs Rust inline tests + `node:test` JS patterns; `npm test` runs `node --test ui/test/*.test.mjs`.
- `.ai-run/guides/development/development-practices.md` — present; not read in full, but error-handling and async patterns guide exists.
- No guide specific to "bridge instrumentation" or "cmdlog intent classification" — conventions are derived from code.

### Architectural Decisions

- **CR-005** (inline in `runner-bridge.js` `spawnPty`): both listeners registered inside the try block so the finally always unlistens both. Any new listeners added for cmdlog-append inside `spawnPty` must follow the same pattern.
- **EPMCDME-14647** (correlation id for PTY): `spawnPty` returns `{ code, id }`, and the pty id is the same id used to filter `engine:pty-data` events. For cmdlog, the `id` returned by `cmdlog_open` is separate (Rust-generated `cmd-N`); the bridge closure already has both ids in scope and can route data to the right cmdlog record without an external mapping.
- **Single-slot PTY guard** in `pty.rs` (line ~111): `spawn_pty` rejects a second concurrent PTY at the Rust level. This is a pre-existing constraint, not introduced by this task; it limits the "overlapping PTY" scenario the task mentions to concurrent runs that succeed (e.g., EPMCDME-14513's future work) rather than today's reality.

### Derived Conventions

- Test files are in `ui/test/*.test.mjs`; each imports the module under test after stubbing `window.__TAURI__` — never stub at module level with a separate helper, always with a mutable-delegate pattern per test.
- Pure utility modules (e.g., `app-updater-utils.mjs`) live directly under `ui/` with a co-located test in `ui/test/`.
- No ESLint, no Prettier, no bundler — files are loaded as ES modules directly by Tauri's WebView.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/pty-bridge.test.mjs` (82 lines) — direct precedent: stubs Tauri globals, captures listeners by event name, fires synthetic payloads. Covers `spawnPty` id-filtering and CR-005 cleanup ordering. **This is the file the task says to extend.**
- `src-tauri/src/commands/cmdlog.rs` `#[cfg(test)]` block (lines 128–213) — 7 tests covering the full store lifecycle: open defaults, append/close accumulation, append-after-close error, double-close error, unknown-id errors, insertion-order list, overlapping records isolation. All Rust-side correctness is covered.
- No existing test covers: ANSI stripping, streaming TextDecoder behavior across chunk boundaries, cmdlog_open/append/close being called around any bridge path, or the `runUpdateCli` → `bridge.updater.runSelfUpdate` re-point.

### Testing Framework and Patterns

- JS: Node built-in `node:test` + `node:assert/strict`. No third-party test framework. `npm test` = `node --test ui/test/*.test.mjs`.
- Mocking: mutable delegate pattern (`let invokeImpl = async () => null; let listenImpl = async () => () => {};`) set before the module is imported; per-test reassignment in the test body.
- Rust: `cargo test`, inline `#[cfg(test)] mod tests { use super::*; }`.

### Coverage Gaps

- No test for cmdlog wrapping inside `runner.runStream` (open before, append per line, close after).
- No test for cmdlog wrapping inside `runner.runCapture` / `runFreshEnv` (open/close around a single invoke).
- No test for cmdlog wrapping inside `pty.spawnPty` (open before invoke, append per decoded+stripped chunk, close on exit).
- No test for `updater.runSelfUpdate` cmdlog wrapping.
- No test for ANSI stripping utility (new code).
- No test for streaming TextDecoder across split multi-byte UTF-8 chunk boundaries (new code).
- No test for `runUpdateCli` → `bridge.updater.runSelfUpdate` re-point in `renderer.js`.

---

## 5. Configuration and Environment

### Environment Variables

- No environment variables govern cmdlog behavior. The Rust store is always active; the bridge wrapping is unconditional.
- `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` — existing smoke-mode toggles; `runSmoke` in `renderer.js` calls `bridge.runner.runStream` and `bridge.pty.spawnPty`, so those will also be instrumented once the bridge is wrapped.

### Configuration Files

- `package.json` (`"test": "node --test ui/test/*.test.mjs"`) — the new test file must match `ui/test/*.test.mjs` to be picked up automatically.
- `src-tauri/Cargo.toml` — no changes needed; `cmdlog.rs` depends only on `chrono` and `serde`, both already present.

### Feature Flags and Deployment Concerns

- No feature flag for cmdlog instrumentation — it is unconditional once the bridge wrapping lands.
- No clipboard dependency is in scope for this task (EPMCDME-15231 scope is bridge instrumentation only; the "Copy all" UI is a separate concern from EPMCDME-14512's larger scope).

---

## 6. Risk Indicators

- **`runUpdateCli` bypasses the bridge**: `renderer.js:485` calls `invoke('run_self_update')` directly. This is a confirmed discrepancy — the bridge's `updater.runSelfUpdate` exists but has zero call sites. The re-point is a one-line change in `renderer.js`, but it must be coordinated with adding cmdlog wrapping to `updater.runSelfUpdate` in the bridge, otherwise the re-pointed call would write to cmdlog while the old path does nothing — partial instrumentation during an edit window.
- **Streaming TextDecoder per invocation**: a `TextDecoder({ stream: true })` must be allocated once per `spawnPty` call (not once per module load), and held in the closure until the pty exits. If it is accidentally shared across concurrent PTY runs (unlikely given single-slot guard, but possible in tests), decoded state will bleed across runs. Allocate inside the async function body, not at module scope.
- **ANSI stripping correctness at chunk boundaries**: ANSI escape sequences like `\x1b[...m` can split across `engine:pty-data` chunks. The TextDecoder handles UTF-8 boundaries with `stream:true`; ANSI stripping must operate on the decoded text *after* TextDecoder. If stripping uses a stateless regex per chunk, a sequence split across two decoded strings will produce a partial escape in the output. A stateful stripper or a regex that tolerates incomplete escapes at end-of-string is needed.
- **`runner.runCapture`/`runFreshEnv` have zero live call sites**: the task requires instrumenting these paths, but there are no live callers in `ui/` today (confirmed by repo-wide grep). The intent-classification requirement ("user-initiated vs read-only probe") has no live example to validate against. The wrapping should be added regardless, but a test will need to be synthetic.
- **`runAction` in `renderer.js` delegates to `bridge.pty.spawnPty`**: once `spawnPty` is wrapped in the bridge, `runAction` gets cmdlog coverage for free. However, `runAction` passes no `onData` callback to `spawnPty`, which means the wrapped version must handle the cmdlog-append path even when `onData` is `undefined` — the TextDecoder and ANSI-strip accumulation must run regardless of whether the caller provided an `onData` callback.
- **`runSmoke` in `renderer.js` calls both `bridge.runner.runStream` and `bridge.pty.spawnPty`**: once wrapped, these smoke-test invocations will also write to cmdlog. The smoke test records are benign but could cause unexpected failures if the cmdlog store rejects duplicate opens in CI — confirmed that `CmdLogStore` does not reject duplicate opens (each call to `open` creates a fresh record with a new id), so this is not a problem.
- **No ANSI stripping utility exists anywhere in the codebase**: the vendored `xterm.mjs` handles ANSI internally but is not importable as a utility. This is genuinely new code that must be written and tested. The complexity is bounded (a standard regex covers `CSI` sequences and `OSC` sequences), but the test for split-sequence handling at chunk boundaries is non-trivial.

---

## 7. Summary for Complexity Assessment

This task is the JS instrumentation half of the command-log feature, building on top of the Rust store that EPMCDME-15230 fully landed. The Rust side (`cmdlog.rs`, `state.rs`, `mod.rs`, `lib.rs`) requires zero changes — all five Tauri commands are registered and tested. The change surface is confined to two JS files (`ui/runner-bridge.js`, `ui/renderer.js`), one new utility (ANSI-strip, likely a small pure-function module following the `app-updater-utils.mjs` precedent), and one new test file extending the `pty-bridge.test.mjs` mutable-delegate pattern. The `renderer.js` change is a one-line re-point (`invoke('run_self_update')` → `bridge.updater.runSelfUpdate()`); the bridge changes wrap the existing `runStream`, `runCapture`, `runFreshEnv`, `spawnPty`, and `runSelfUpdate` functions with `cmdlog_open`/`cmdlog_append`/`cmdlog_close` calls.

Technical novelty is concentrated in two places: (1) the streaming `TextDecoder({ stream: true })` path inside the `spawnPty` wrapper — one decoder instance per invocation, accumulating decoded text from base64 PTY chunks, feeding the ANSI stripper before each `cmdlog_append` — this pattern has no precedent in the codebase (the only existing base64/PTY path in `terminal.js` feeds raw bytes to xterm.js, not decoded text); (2) the ANSI escape sequence stripper itself, which must handle sequences split across `engine:pty-data` chunk boundaries after text decoding. The per-command correlation ID from EPMCDME-14647 (`spawnPty` returns `{ code, id }`) is already correct and functional — the `id` is already used to filter `engine:pty-data` events, so cmdlog-append inside the same filtered closure routes to the correct record for any future overlapping runs without an external mapping.

Test coverage posture is good for the Rust primitives and the existing bridge behavior (`pty-bridge.test.mjs`), but zero coverage exists for the new cmdlog wrapping, the ANSI stripper, or the TextDecoder streaming path. The single most important risk is the ANSI-stripping correctness at chunk boundaries — a stateless regex applied per-chunk will corrupt split escape sequences. The re-point of `runUpdateCli` and the intent-classification annotation at each call site are straightforward once the bridge wrappers are in place.

---

## 8. External References

None named by the task.
