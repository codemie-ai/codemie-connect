# Development Practices

**Project**: CodeMie Installer (macOS)
**Languages**: Rust 2021 (1.77.2+) + Vanilla JS ESM
**Framework**: Tauri v2 (2.11.2)
**Linter**: cargo clippy | **Formatter**: cargo fmt (Rust); no JS formatter configured

---

## Code Style

### Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Rust files | `snake_case` | `runner.rs`, `pathman.rs` |
| Rust functions | `snake_case` | `run_capture`, `write_line` |
| Rust types/enums | `PascalCase` | `InstallerError`, `AppState` |
| Rust constants | `SCREAMING_SNAKE_CASE` | `SHELL`, `GIT_BINARIES` — `inspector.rs:8` |
| JS files | `kebab-case` | `runner-bridge.js`, `steps-ui.js` |
| JS classes | `PascalCase` | `Engine`, `StepStatus` |
| JS functions/vars | `camelCase` | `mkSteps`, `streamId` |

### File Organization (Rust commands)

One file per system concern under `src-tauri/src/commands/`. Each file has:
1. A module-level doc comment naming the ported Electron module.
2. Pure helper functions (no `#[tauri::command]`).
3. `#[tauri::command]` public async functions that delegate to helpers.
4. A `#[cfg(test)]` block at the bottom.

Reference: `src-tauri/src/commands/runner.rs:1–13`.

---

## Error Handling

All fallible Rust commands use `CmdResult<T>` — defined at `src-tauri/src/error.rs:25`.

`InstallerError` variants map system error categories to readable strings:

| Variant | Use when |
|---|---|
| `InstallerError::Io` | `std::io::Error` from fs/process ops |
| `InstallerError::Download(String)` | reqwest / HTTP failures |
| `InstallerError::Pty(String)` | portable-pty errors |
| `InstallerError::Sudo(String)` | osascript / elevated-privilege failures |
| `InstallerError::Other(String)` | everything else |

The error serializes to a plain String so the frontend receives a readable message — mirrors `throw new Error(msg)` from the Electron app.

| ✅ DO | ❌ DON'T |
|---|---|
| Return `CmdResult<T>` for anything that can fail | Return `String` errors directly from commands |
| Use `InstallerError::Other(msg)` for one-off cases | Add a new variant for every error message |
| Let the Tauri IPC layer serialize the error | `unwrap()` in command functions |

---

## Logging

Session log: `~/Library/Logs/CodeMie/codemie_wizard.log`. File is opened/created on each session start.

- Write from Rust: `commands::logger::write_line(text, tag)` — `src-tauri/src/commands/logger.rs:39`
- Write from JS (via IPC): `invoke('log_line', { text, tag })`
- Open in Console.app: `invoke('open_log')`

Log tags: `stdout` → `OUT`, `stderr` → `ERR`, `info` → `INF`, `success` → `OK`, `dim` → `---`, `prompt` → `CMD`.

---

## Async Patterns

**Rust**: `tokio` async runtime. Command functions annotated with `#[tauri::command]` can be `async`. Background tasks use `tokio::spawn`. Streaming uses `BufReader::lines()` — `runner.rs:110`.

**JS**: `async/await` throughout. The install engine drives steps sequentially via `await handler()`. The approval gate is a `Promise` resolver stored in `engine._gate` — JS ownership means no Rust oneshot needed.

---

## Configuration & Environment

| Config | How it flows |
|---|---|
| `config/steps.yaml` | Embedded at compile time via `include_str!` in `steps.rs`; never read from disk at runtime |
| Smoke env vars | `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` checked at startup in `main.rs` |
| PATH | Resolved from user's login shell at startup via `pathman::apply_resolved_shell_path()` — `lib.rs:22` |

---

## Dependencies

```bash
# Add a Rust dependency
cd src-tauri && cargo add <crate>

# Add a JS dependency (dev only — no runtime JS bundler)
npm install --save-dev <package>
```

Lock files (`Cargo.lock`, `package-lock.json`): always commit both.

---

## Quick Reference

| Need | Location |
|---|---|
| Error types | `src-tauri/src/error.rs` |
| Managed state | `src-tauri/src/state.rs` |
| Logger | `src-tauri/src/commands/logger.rs` |
| Command registration | `src-tauri/src/lib.rs:27` |
| JS IPC wrappers | `ui/runner-bridge.js` |
| Install step config | `config/steps.yaml` |
