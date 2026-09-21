# Technical Research

**Task**: pty rust tauri bridge correlation-id kill
**Generated**: 2026-09-02T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-14647 — PTY correlation id + pty_kill.

Give every PTY run its own identity, and a way to end it. Today `engine:pty-data` and `engine:pty-exit` are global broadcasts with no correlation id, `spawn_pty` overwrites the single handle with no guard, and nothing can terminate a running child.

Context:
- `src-tauri/src/state.rs:16` holds one `Mutex<Option<PtyHandle>>` — one handle, no guard on spawn.
- `src-tauri/src/commands/pty.rs:109` emits `{ data }` (engine:pty-data); `:122` emits `{ code }` (engine:pty-exit). No id on either.
- `PtyHandle` (pty.rs:20-23) holds only `writer` and `master` — no killer, no way to terminate the child.
- `ui/runner-bridge.js` — `pty.spawnPty` registers its exit listener before invoking, so it resolves on any `engine:pty-exit` (not scoped to its own run).
- `portable-pty` 0.8.1 is already in Cargo.toml; `ChildKiller` / `clone_killer()` need no new dependency.

Build order (suggested, not binding):
- Return an id from `spawn_pty`; carry it on every `engine:pty-data` / `engine:pty-exit` payload from both the reader thread and the wait thread.
- In `ui/runner-bridge.js`: return the id from `pty.spawnPty`, allow a caller to subscribe to data for one id, resolve exit only on the matching id. Keep existing global listeners (terminal overlay, legacy engine) working unchanged.
- Store a `clone_killer()` in `PtyHandle`; add `pty_kill` command that kills the child and awaits exit; register in `mod.rs` and `lib.rs`; export from bridge.
- Inline Rust tests for id propagation and kill; a node:test for the bridge's per-id filtering.

Acceptance criteria:
- Every `engine:pty-data`/`engine:pty-exit` event carries the id of the run that produced it; bridge exposes that id to callers.
- Two PTY commands (sequential or overlapping) can each be followed by id — consumer sees only its own output/exit.
- `pty_kill` terminates the running child and resolves after it exits; a respawn after it is not nulled by the previous child's wait thread; `pty_input` reaches the new child.
- No guard rejecting concurrent spawns.
- Legacy install engine, `runAction`, and the terminal overlay behave exactly as before.
- Registered in both `mod.rs` and `lib.rs`.

Need: exact current implementation of spawn_pty, PtyHandle, state.rs, the reader/wait threads, mod.rs and lib.rs registration pattern for pty commands, and runner-bridge.js's pty.spawnPty/listener wiring plus all its current consumers (terminal overlay, legacy install engine, runAction) so the plan can determine how to add the id/kill without breaking them.

---

## 2. Codebase Findings

### Existing Implementations

- `src-tauri/src/commands/pty.rs` — All PTY Rust logic. Four public commands: `spawn_pty`, `pty_input`, `pty_resize`, `spawn_external_ps` (Windows-only). The `PtyHandle` struct at line 20-23 holds only `writer: Box<dyn Write + Send>` and `master: Box<dyn portable_pty::MasterPty + Send>`. No kill handle, no id field.
- `src-tauri/src/state.rs` — `AppState` struct with `pty: Mutex<Option<PtyHandle>>`. Single-slot; no id storage, no kill handle.
- `src-tauri/src/commands/mod.rs` — Flat list of `pub mod` declarations. `pub mod pty;` at line 7. New commands in the PTY module require no mod.rs change beyond the existing `pub mod pty;`.
- `src-tauri/src/lib.rs` — `invoke_handler!` macro at line 27-64 registers all Tauri commands. PTY commands at lines 51-55: `commands::pty::spawn_pty`, `commands::pty::pty_input`, `commands::pty::pty_resize`, `commands::pty::spawn_external_ps` (cfg-gated). Any new `pty_kill` command must be appended here.
- `src-tauri/src/error.rs` — `InstallerError` enum: `Io`, `Download`, `Pty(String)`, `Other(String)`. `CmdResult<T>` is `Result<T, InstallerError>`. The `Pty` variant covers all portable-pty errors.
- `ui/runner-bridge.js` — Bridge module. The `pty` export at line 110-128: `spawnPty(cmd, cols, rows)` — registers a global `engine:pty-exit` listener BEFORE invoking `spawn_pty`, then awaits exit. No id generated, no id filtering. Returns a raw exit code number. `input` and `resize` are thin `invoke` wrappers. The `nextId(prefix)` function at line 7-8 already exists and is used by `runStream` and `downloader.download`.
- `ui/terminal.js` — xterm.js overlay. `initTerminal` wires `term.onData` directly to `invoke('pty_input', ...)` (line 40), bypassing the bridge. `handlePtyExit(code)` (line 101) receives a raw code and manages overlay state. `writeData(b64)` (line 81) decodes base64 and writes bytes to the terminal. These are called from `renderer.js` global listeners.
- `ui/renderer.js` — Two callers of `bridge.pty.spawnPty`:
  1. `runAction` (line 297-306): one-shot home-page commands (proxy connect, analytics). `const code = await bridge.pty.spawnPty(cmd)` — uses return value as a number.
  2. Via `handlers.js:runPty` (line 60-76), called for wizard steps `2.3.3` (codemie setup) and `2.3.5` (claude install): `pty.spawnPty(cmd).then((code) => {...})` — return value used as a number.
- `ui/handlers.js` — `runPty(ctx, cmd, title)` at line 60 calls `pty.spawnPty(cmd)` (no cols/rows override). `makeHandlers` receives `pty` as a dep-injected object.

### Architecture and Layers Affected

- **Rust backend — managed state layer**: `src-tauri/src/state.rs` (`AppState.pty`). The single-slot handle must gain an id alongside the `PtyHandle`.
- **Rust backend — command layer**: `src-tauri/src/commands/pty.rs`. `PtyHandle` struct, `spawn_pty` command, both reader and wait threads. A new `pty_kill` command lives in the same file.
- **Rust backend — registration layer**: `src-tauri/src/lib.rs` `invoke_handler!` macro. `pty_kill` must be appended.
- **JS bridge layer**: `ui/runner-bridge.js` `pty.spawnPty`. The id-generation and per-id filtering logic lives here. A new `kill` export is added to the `pty` object.
- **JS renderer/consumer layer**: `ui/renderer.js` (`runAction`, global listeners), `ui/handlers.js` (`runPty`), `ui/terminal.js` (`handlePtyExit`, `writeData`). The global `engine:pty-data` and `engine:pty-exit` listeners in `renderer.js` call `writeData` and `handlePtyExit` respectively and must continue to work after the payload gains an `id` field.

### Integration Points

- `portable_pty` 0.8.1 (already in `Cargo.toml`): `ChildKiller` trait and `clone_killer()` method on `Child` are the kill mechanism. No new Cargo dependency.
- `tauri::Emitter` / `tauri::Manager`: used in both threads to emit events. The `app_exit.try_state::<AppState>()` call at pty.rs:119 is the wait-thread's path back to shared state to clear the handle.
- `serde_json::json!` macro: builds event payloads inline in both threads. Adding an `id` field is a local change to each `json!` call.
- `ui/renderer.js` global listeners: the file imports `writeData` and `handlePtyExit` from `terminal.js` and wires them to `engine:pty-data` / `engine:pty-exit` events. These listeners are in `renderer.js` (not shown fully in codegraph output) and will keep working as long as `payload.data` and `payload.code` remain present alongside the new `payload.id`.

### Patterns and Conventions

- **Id generation in the bridge**: `nextId(prefix)` at runner-bridge.js:7-8 returns `${prefix}${++counter}`. `runStream` uses `nextId('stream')` and `downloader.download` uses `nextId('dl')`. The PTY id would follow as `nextId('pty')`, generated client-side, passed to `invoke('spawn_pty', ...)`, and echoed back on every event payload — matching the `run_stream` / `download_file` pattern exactly.
- **Per-id event filtering in the bridge**: `runStream` listens to `engine:cmd-line` and filters `if (p && p.id === id)`. `downloader.download` filters `engine:download-progress` the same way. `spawnPty` currently does not filter — aligning it to this pattern is the core JS change.
- **Tauri command return type**: commands that return a correlation token return `CmdResult<String>` (see `run_stream` which returns `CmdResult<i32>` for exit code). `spawn_pty` currently returns `CmdResult<()>` and must change to `CmdResult<String>` to surface the id.
- **Inline Rust tests**: `#[cfg(test)]` block at bottom of the same file. Existing example at pty.rs:174-183 (Windows-only). New tests follow the same placement pattern.
- **`#[tauri::command]` + `invoke_handler!` registration**: every new Tauri command requires both the attribute on the `pub fn` and an entry in `lib.rs` `invoke_handler!`. The mod.rs `pub mod pty;` line already covers the module; no mod.rs change needed for new functions inside the existing `pty.rs`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — covers the frontend-brain + thin Rust backend (Option B) pattern and the IPC flow.
- `.ai-run/guides/testing/testing-patterns.md` — Rust inline tests (`#[cfg(test)]` in same file, `#[tokio::test]` for async) and JS `node:test` patterns (`ui/test/*.test.mjs`). Confirms smoke modes for PTY wiring verification.
- `.ai-run/guides/development/development-practices.md` — error handling, async patterns, naming conventions.

### Architectural Decisions

- The reader thread uses `std::thread::spawn` (not `tokio::spawn`) because `portable_pty`'s reader is blocking and would starve a Tokio executor. This is documented in pty.rs:3-6. The kill thread (`pty_kill`) also needs a blocking wait, making `std::thread::spawn` the right vehicle there too.
- Events carry base64-encoded data (not raw bytes or UTF-8 strings) to prevent multi-byte character corruption across 4096-byte read boundaries. This constraint stays unchanged.

### Derived Conventions

- The state-clear in the wait thread (`*state.pty.lock().unwrap() = None` at pty.rs:120) runs unconditionally. With an id, the clear must be conditional: only clear if the stored id matches the spawned run's id. This is derived from the race condition described in the ticket and the wait-thread implementation.
- `pty_input` and `pty_resize` silently no-op when `state.pty` is `None` (pattern at lines 131 and 143). This graceful-ignore convention should be preserved.

---

## 4. Testing Landscape

### Existing Coverage

- `src-tauri/src/commands/pty.rs:174-183` — one `#[cfg(all(test, windows))]` test for `spawn_external_ps` (noop cmd exits 0). No tests for `spawn_pty`, `pty_input`, `pty_resize`, or `PtyHandle` on any platform.
- `ui/test/engine.test.mjs` — covers `Engine` orchestration (step sequencing, gates, fatal logic). No pty-specific coverage.
- `ui/test/models.test.mjs` — covers `StepStatus`, `STATUS_META`, `makeStep`. No bridge/pty coverage.
- `spawnPty` (runner-bridge.js:113) — blast radius note: 2 callers in renderer.js, no covering tests found.
- `handlePtyExit` (terminal.js:101) — 3 callers in renderer.js, no covering tests found.

### Testing Framework and Patterns

- **Rust**: `#[cfg(test)]` inline module at the bottom of the file under test. Async tests use `#[tokio::test]`. Real shell execution, no mocks. Runner examples at `runner.rs:133`.
- **JS**: `node:test` built-in + `node:assert/strict`. Files in `ui/test/*.test.mjs`. Engine tests inject a synthetic `emit` stub and fake `handlers` — no Tauri invocation. Approval gate tests use `setTimeout` to yield before resolving.

### Coverage Gaps

- `spawn_pty`, `pty_input`, `pty_resize`, and `PtyHandle` have zero test coverage. The task adds new behavior (id propagation, kill) to all of these with no safety net from existing tests.
- `pty.spawnPty` in `runner-bridge.js` and its two consumer sites (`runAction`, `runPty`) have no JS tests.
- `handlePtyExit` and `writeData` in `terminal.js` have no tests.

---

## 5. Configuration and Environment

### Environment Variables

- `PATH` — read at pty.rs:45 via `std::env::var("PATH")` and forwarded to the child process.
- `HOME` (macOS/Linux) — read at pty.rs:49, forwarded to the child process and used as `cwd`.
- `USERPROFILE` (Windows) — read at pty.rs:64, forwarded to the child process.
- `TERM` — hard-set to `xterm-256color` for the child process.
- No PTY-specific feature flags or env variables.

### Configuration Files

- `src-tauri/Cargo.toml` — `portable-pty = "0.8.1"` already present. No new dependency needed for `ChildKiller`/`clone_killer()`.
- `src-tauri/src/lib.rs` — `invoke_handler!` macro is the registration surface; adding `pty_kill` here is the only config-layer change.

### Feature Flags and Deployment Concerns

- `#[cfg(windows)]` gates `spawn_external_ps` and its test. The new `pty_kill` command should be cross-platform (portable-pty's `ChildKiller` works on both macOS and Windows).
- Smoke modes (`CODEMIE_SMOKE=1`, `CODEMIE_PROBE_SMOKE=1`) provide non-destructive PTY wiring checks per the testing guide. These are renderer/integration level and are not automated tests.

---

## 6. Risk Indicators

- **Stale-clear race in wait thread** — `pty.rs:119-120`: the wait thread captures `app_exit` by move and calls `app_exit.try_state::<AppState>()` to clear `state.pty`. If a second `spawn_pty` runs before the first wait thread resolves, the first wait thread's `None`-assignment will evict the second run's `PtyHandle`. The id-conditional clear (`only clear if stored id == spawned id`) is required to close this race.
- **`spawn_pty` return type change breaks bridge** — changing `CmdResult<()>` to `CmdResult<String>` changes the IPC contract. `runner-bridge.js:120` currently discards the return value (`await invoke('spawn_pty', ...)`). This is non-breaking for the bridge but must be accounted for in the JS change. The two callers of `spawnPty` in `renderer.js` (`runAction:300`, `handlers.js runPty:65`) treat the return as a plain number; if `spawnPty` returns `{ code, id }` instead of a number, both callers break.
- **Global listener backward compatibility** — `renderer.js` wires global `engine:pty-data` and `engine:pty-exit` listeners that call `writeData(payload.data)` and `handlePtyExit(payload.code)`. Adding `id` to the payloads is additive and does not break these, provided `data` and `code` remain present in the same payload shape.
- **No existing Rust tests for PTY** — `spawn_pty`, `pty_input`, `pty_resize`, and `PtyHandle` have zero test coverage on any platform. New behavior (id propagation, kill) is added to an untested surface; the ticket requires inline tests but there is no existing test harness to verify regression.
- **`terminal.js` bypasses the bridge for `pty_input`** — `initTerminal` calls `invoke('pty_input', ...)` directly (line 40). This is correct and should stay unchanged, but it means the terminal's keystroke path does not go through the bridge's `pty.input` wrapper. Any id-aware input routing (if needed) cannot rely on the bridge path.
- **`pty_kill` await-exit design** — the ticket specifies `pty_kill` "resolves after it exits." If kill is implemented as a synchronous Tauri command that blocks the Tauri command thread on `child.wait()`, it will hold the Mutex while waiting. The `pty_input`/`pty_resize` path also locks the same Mutex. Architectural choice between holding the lock during wait vs. using an async channel is left to the plan, but the Mutex contention is a concrete risk to name.
- **`PtyHandle` is not `Default`** — `AppState` derives `Default`, which requires `PtyHandle` to implement `Default` (via `Option<PtyHandle>` being `None`). Adding a `killer` field to `PtyHandle` does not affect this since the default is `None`. However, if the state slot changes structure (e.g., wrapping handle and id together), `AppState`'s `Default` derive must remain valid.
- **No codegraph results for renderer.js global pty-data/pty-exit listener wiring** — the renderer.js code that sets up `listen('engine:pty-data', ...)` and `listen('engine:pty-exit', ...)` global handlers was not returned in full by codegraph. These wiring sites are the legacy consumers that must keep working; they should be confirmed before the JS change is written.

---

## 7. Summary for Complexity Assessment

The task touches three distinct layers: the Rust backend (one file, `pty.rs`, plus `state.rs` and the `lib.rs` registration table), the JS bridge (`runner-bridge.js`), and two JS consumer sites (`renderer.js` `runAction` and `handlers.js` `runPty`). The Rust surface is well-understood from the source — `PtyHandle`, `spawn_pty`, its two threads, and the state slot are fully visible. The id-generation and per-id filtering pattern is already established in the codebase by `runStream` and `downloader.download`; the PTY changes are a direct application of that pattern. The `ChildKiller`/`clone_killer()` addition to `PtyHandle` requires no new dependency, and the kill command follows the same `#[tauri::command]` + `invoke_handler!` + bridge export template used by every existing command.

The main technical novelty is the stale-clear race in the wait thread: the existing code unconditionally nulls `state.pty` on child exit, which will evict a concurrently spawned handle. The fix requires threading the spawned id into the wait closure so it can guard the clear. This is a targeted, well-scoped change with no novel patterns, but it is easy to get wrong because the wait thread has no reference to the `State<AppState>` injection — it acquires state only through `app_exit.try_state::<AppState>()`. The `pty_kill` command's "resolve after exit" requirement also raises a question about Mutex hold time during a blocking `child.wait()` call; this is a concrete design decision the plan must address.

Test coverage posture is the main risk amplifier: `spawn_pty`, `PtyHandle`, and `pty.spawnPty` are completely untested at present. The ticket requires new inline Rust tests and a `node:test` for per-id bridge filtering, which adds coverage where none exists. The testing patterns guide gives clear placement rules (`#[cfg(test)]` at the bottom of the same Rust file; `ui/test/*.test.mjs` for JS). The key risk factors are: (a) the stale-clear race, (b) the `spawn_pty` return-type change propagating to two consumer call sites in `renderer.js` and `handlers.js`, and (c) the need to verify that the existing global `engine:pty-data`/`engine:pty-exit` listeners in `renderer.js` (not fully captured in codegraph) handle the enriched payload shape without breakage.

---

## 8. External References

None named by the task.
