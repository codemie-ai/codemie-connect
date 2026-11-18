# Development Practices

**Project**: CodeMie Connect
**Languages**: Rust 2021 (1.90+) + Vanilla JS ESM
**Framework**: Tauri v2 (2.12.6)
**Linter**: cargo clippy | **Formatter**: cargo fmt (Rust); no JS formatter configured

---

## Overview

Conventions for code in `src-tauri/` (Rust 2021, formatted by `cargo fmt`, linted by `cargo clippy -D warnings`) and `ui/` (plain ES modules, no bundler, no JS linter or formatter). Installer commands use `InstallerError`; workspace, storage and plugins code uses `WorkspaceError`.

| Part | What it holds | Start here |
|---|---|---|
| `src-tauri/src/error.rs` | `InstallerError` and `CmdResult` for installer commands | `src-tauri/src/error.rs::InstallerError` |
| `src-tauri/src/workspace/models.rs` | `WorkspaceError`, `Request`, `required()` | `src-tauri/src/workspace/models.rs::WorkspaceError` |
| `src-tauri/src/commands/logger.rs` | the session log file and its tags | `src-tauri/src/commands/logger.rs::write_line` |
| `src-tauri/src/steps.rs` | the embedded install-step YAML | `src-tauri/src/steps.rs::STEPS_YAML` |
| `ui/workspace/store.js` | the store and `escapeHtml` | `ui/workspace/store.js::escapeHtml` |

## Code Style

### Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Rust files | `snake_case` | `runner.rs`, `pathman.rs` |
| Rust functions | `snake_case` | `run_capture`, `write_line` |
| Rust types/enums | `PascalCase` | `InstallerError`, `AppState` |
| Rust constants | `SCREAMING_SNAKE_CASE` | `GIT_BINARIES`, `NODE_BINARIES` — `src-tauri/src/commands/inspector.rs::GIT_BINARIES` |
| JS files | `kebab-case` | `runner-bridge.js`, `steps-ui.js` |
| JS classes | `PascalCase` | `Engine`, `StepStatus` |
| JS functions/vars | `camelCase` | `mkSteps`, `streamId` |

### File Organization (Rust commands)

One file per system concern under `src-tauri/src/commands/`. Each file has:
1. A module-level comment saying what the file does; files ported from the Electron app name their source (`Port of src/main/runner.js`).
2. Pure helper functions (no `#[tauri::command]`).
3. `#[tauri::command]` public async functions that delegate to helpers.
4. A `#[cfg(test)]` block at the bottom.

Reference: `src-tauri/src/commands/runner.rs::run_capture`.

### Rules
- R1. Name a workspace UI module by its role: `view-*.js` renders HTML from state, `*-model.js` derives values, `*-controller.js` exports a `create…Controller` factory whose dependencies (`state`, `snap`, `mutate`, `render`, `toast`, `now`) are passed in, so tests can pass fakes. Evidence: `ui/workspace/tasks-controller.js::createTasksController`
- R2. Pass each provider or user value interpolated into a template literal through `escapeHtml` (imported as `e`); attribute values included. Evidence: `ui/workspace/store.js::escapeHtml`

---

## Error Handling

Fallible commands in `src-tauri/src/commands/` use `CmdResult<T>` — `src-tauri/src/error.rs::CmdResult`.

`InstallerError` variants map system error categories to readable strings:

| Variant | Use when |
|---|---|
| `InstallerError::Io` | `std::io::Error` from fs/process ops |
| `InstallerError::Download(String)` | reqwest / HTTP failures |
| `InstallerError::Pty(String)` | portable-pty errors |
| `InstallerError::Other(String)` | everything else |

The error serializes to a plain String so the frontend receives a readable message — mirrors `throw new Error(msg)` from the Electron app.

| ✅ DO | ❌ DON'T |
|---|---|
| Return `CmdResult<T>` for anything that can fail | Return `String` errors directly from commands |
| Use `InstallerError::Other(msg)` for one-off cases | Add a new variant for every error message |
| Let the Tauri IPC layer serialize the error | `unwrap()` a fallible I/O or parse result in a command function (`Mutex::lock().unwrap()` on `AppState` fields is the accepted idiom) |

---

Workspace, storage and plugins commands instead return `WorkspaceError` (`code`, `message`, optional `retry_after`, `class`, `field`) (`src-tauri/src/workspace/models.rs::WorkspaceError`); do not flatten it into legacy strings.

### Rules
- R1. Build a workspace error with `WorkspaceError::new(code, sentence)`: `code` is a short token the UI branches on (`validation`, `conflict`, `stale_view`, `needs_login`, `permission_required`, `storage_unavailable`) and the sentence tells the person what to do next. Evidence: `src-tauri/src/workspace/models.rs::WorkspaceError`
- R2. Set `field` on a form validation error through the module's `invalid(field, message)` helper, so the editor shows it beside that input. Evidence: `src-tauri/src/workspace/meetings/model.rs::invalid`
- R3. Let `rusqlite::Error` and `std::io::Error` convert with `?`: the rusqlite `From` impl maps a lost, read-only or refused database to `storage_unavailable` (the window answers with the recovery page) and a full disk to the same code with its own sentence, and an io error becomes `io`. Evidence: `src-tauri/src/workspace/models.rs::WorkspaceError.storage_unavailable`
- R4. Check `code` of a `run_capture` result: it resolves with `code` 127 when the shell cannot start and 1 when the process has no exit code, and does not reject. Evidence: `src-tauri/src/commands/runner.rs::capture_command`

### Constraints
| Do not | Do instead | Why | Evidence |
|---|---|---|---|
| Format a rusqlite or io error into a `WorkspaceError` message | Convert it with `?` through the `From` impls | the UI shows `message` as written and opens recovery on `storage_unavailable` | `src-tauri/src/workspace/models.rs::WorkspaceError` |

## Logging

Session log: `~/Library/Logs/CodeMie/codemie_wizard.log` (Windows: `%USERPROFILE%\AppData\Local\CodeMie\Logs\codemie_wizard.log`). `write_line` creates the file when it is missing and appends each line; `run` in `lib.rs` writes a session-start line.

- Write from Rust: `commands::logger::write_line(text, tag)` — `src-tauri/src/commands/logger.rs::write_line`
- Write from JS (via IPC): `invoke('log_line', { text, tag })`
- Open in Console.app: `invoke('open_log')`

Log tags: `stdout` → `OUT`, `stderr` → `ERR`, `info` → `INF`, `success` → `OK`, `dim` → `---`, `prompt` → `CMD`, `approved` → `OK`; other tags log as `OUT`.

### Rules
- R1. Write a line a release build must keep through `commands::logger::write_line`; `log::warn!` and `log::error!` in `workspace/`, `plugins/`, `storage/` and `ai/` reach output in debug builds, where `run` in `lib.rs` registers `tauri_plugin_log` under `cfg!(debug_assertions)`. Evidence: `src-tauri/src/lib.rs::run`

---

## Async

**Rust**: `tokio` async runtime. Command functions annotated with `#[tauri::command]` can be `async`. The workspace background loop runs on `tauri::async_runtime::spawn` (`src-tauri/src/workspace/mod.rs::Core.start`); streaming uses `BufReader::lines()` (`src-tauri/src/commands/runner.rs::run_stream`).

**JS**: `async/await` throughout. The install engine drives steps sequentially via `await handler()`. The approval gate is a `Promise` resolver stored in `engine._gate` — JS ownership means no Rust oneshot needed.

### Rules
- R1. Take `Core::meeting_lock()` before `Core::repo()` and drop both before an `.await`; both are `std::sync::MutexGuard`s, and the lock order keeps a meeting-folder writer from deadlocking a repository writer. Evidence: `src-tauri/src/workspace/meetings/record.rs::Core.meeting_lock`
- R2. Do slow detection or network reads before taking the `mutations` lock, as `Core::request` probes Claude profiles for `ai_settings_save` first, so other edits are not queued behind them. Evidence: `src-tauri/src/workspace/mod.rs::Core.request`
- R3. Run the blocking filesystem work of an async data-folder command inside `blocking(...)`, off the async runtime. Evidence: `src-tauri/src/storage/commands.rs::blocking`

---

## Configuration

| Config | How it flows |
|---|---|
| `config/steps.yaml`, `config/steps-windows.yaml` | Embedded at compile time via `include_str!` (`src-tauri/src/steps.rs::STEPS_YAML`, one per platform); not read from disk at runtime |
| Smoke env vars | `CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE` read by `src-tauri/src/commands/smoke.rs::smoke_mode`, which the UI calls on boot; `CODEMIE_PLUGIN_SMOKE` and `CODEMIE_STATUS_SMOKE` start from `src-tauri/src/lib.rs::run` |
| PATH | Resolved from the user's login shell at startup via `src-tauri/src/commands/pathman.rs::apply_resolved_shell_path`, called in `src-tauri/src/lib.rs::run` before a plugin starts a thread (it uses `set_var`) |
| Pinned runtime | `runtime.json`: Node version and SHA-256s, CLI package and version |

### Rules
- R1. Change the bundled CLI by editing `cliVersion` in `runtime.json` and running `scripts/stage-runtime.sh`, then commit the rewritten `assets/codemie-cli/package.json` and `package-lock.json`; `commands/runtime.rs` embeds both at compile time and installs that lock on first launch. Evidence: `src-tauri/src/commands/runtime.rs::CLI_PACKAGE_LOCK`
- R2. Read a debug-only switch under `cfg!(debug_assertions)`, as `run` in `lib.rs` reads `CODEMIE_WORKSPACE_TEST_DIR`, so a release build ignores it. Evidence: `src-tauri/src/lib.rs::run`

---

## Dependencies

```bash
# Add a Rust dependency
cd src-tauri && cargo add <crate>

# Add a JS dependency (dev only — no runtime JS bundler)
npm install --save-dev <package>
```

Commit `src-tauri/Cargo.lock` with a Rust dependency change. The root `package.json` holds commitlint dev dependencies and has no tracked lock file; `assets/codemie-cli/package-lock.json` is the pinned CLI the app installs (see Configuration).

### Rules
- R1. Use `rfd` for a native file dialog, not `tauri-plugin-dialog`; the project ruled it out (R23, recorded beside `rfd` in `src-tauri/Cargo.toml`) because its window script replaces `window.alert` and `window.confirm`. Evidence: `src-tauri/Cargo.toml::rfd`

---

## Quick reference

| Task | Do | Where |
|---|---|---|
| Add a Rust dependency | `cd src-tauri && cargo add <crate>`, commit `Cargo.lock` | `src-tauri/Cargo.toml::dependencies` |
| Bump the bundled CLI | edit `cliVersion` in `runtime.json`, run `scripts/stage-runtime.sh`, commit `assets/codemie-cli/` | `src-tauri/src/commands/runtime.rs::CLI_PACKAGE_LOCK` |
| Return an error from a workspace operation | `WorkspaceError::new(code, sentence)`, `invalid(field, message)` for a form | `src-tauri/src/workspace/models.rs::WorkspaceError` |
| Log from Rust or JS | `write_line(text, tag)`; from JS `invoke('log_line', { text, tag })` | `src-tauri/src/commands/logger.rs::write_line` |
| Find installer error types and managed state | `InstallerError`, `CmdResult`, `AppState` | `src-tauri/src/state.rs::AppState` |
| Find command registration and the legacy JS wrappers | `run` in `lib.rs`; `runner-bridge.js` exports `runner`, `pty` and the others | `ui/runner-bridge.js::runner` |
| Change the install steps | edit `config/steps.yaml` or `config/steps-windows.yaml` and rebuild | `src-tauri/src/steps.rs::get_steps` |

## Examples

### A validation error with its field

Source: `src-tauri/src/workspace/meetings/model.rs::invalid`

```rust
fn invalid(field: &str, message: &str) -> WorkspaceError {
    let mut e = WorkspaceError::new("validation", message);
    e.field = Some(field.into());
    e
}
```

### A session log line

Source: `src-tauri/src/commands/logger.rs::write_line`

```rust
pub fn write_line(text: &str, tag: &str) {
    let _ = std::fs::create_dir_all(log_dir());
    let line = format_line(map_tag(tag), text, None) + "\n";
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = f.write_all(line.as_bytes());
    }
}
```

## Common pitfalls

| Symptom | Cause | Fix | Evidence |
|---|---|---|---|
| A `log::warn!` diagnostic is missing from a shipped build | `tauri_plugin_log` is registered under `cfg!(debug_assertions)` only | write what a release build must keep with `write_line` | `src-tauri/src/lib.rs::run` |
| A session-log line written with tag `error` shows as `[OUT]` | `map_tag` knows no `error` tag and falls back to `OUT` (`run` writes the storage note that way) | use `stderr` for errors | `src-tauri/src/commands/logger.rs::map_tag` |
| An async workspace function stops compiling as not `Send`, or other requests hang | a `repo()` or `meeting_lock()` guard is held across an `.await` | scope the guard in a block that ends before the await | `src-tauri/src/workspace/meetings/record.rs::Core.meeting_lock` |