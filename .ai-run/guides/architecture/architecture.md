# Architecture

**Project**: CodeMie Installer (macOS)
**Style**: Frontend installer orchestration (Option B) plus a native workspace service
**Languages**: Rust (backend) + Vanilla JS ESM (frontend)
**Framework**: Tauri v2 (2.12.6)

---

## Workspace boundary (Milestone 1)

`ui/workspace/` owns Today, Calendar, Inbox and Settings (workspaces are hidden until redesigned: Connect boots into `personal`, and `WORKSPACES_HIDDEN` in `src-tauri/src/workspace/mod.rs` pauses other workspaces' schedules and critical alerts; their data and operations stay). `workspace_request` accepts a typed operation, workspace ID, expected snapshot revision and unique operation ID; native SQLite remains authoritative. `src-tauri/src/workspace/` owns credential storage, Graph HTTP/PKCE, canonical provider records, policy fencing, reviewed actions and durable sync/reminder/schedule jobs. Provider tokens never enter the renderer. Microsoft sessions use Connect-owned private cache files on macOS, following Echo/CLI browser-PKCE behavior; Windows keeps a DPAPI-protected file. No automatic credential import or Keychain access. This domain intentionally lives natively because it must work while views are hidden and must enforce policy before HTTP dispatch and result commit.

**Microsoft sources are automatic.** Sign-in requests `calendar`, `mail` and `chats` read capabilities by default, binds the default workspace (and unbound or same-account workspaces) with `sources = {"all": true}`, and queues a forced sync. `all` means every calendar in the calendars catalog, Outlook Inbox + Sent, and recently active Teams chats. Legacy explicit selections still validate but are upgraded to `all` on open. Write capabilities (`calendar_write`, `mail_send`, `chat_send`) are opt-in toggles that trigger a fresh consent. Each sync round: calendars catalog → one `/me/chats?$expand=lastMessagePreview` discovery (members via a separate `$expand=members` read every 30 min) → calendarView per calendar (at most every 5 min unless forced) → mail delta → messages only for chats whose last-message id changed (cursor `chat:{id}` = `previewId|maxLastModified`). Profile fields and the 120×120 photo (data URL, ≤256 KB) refresh at sign-in and daily; a photo failure never fails sign-in. The sign-in browser tab is `src-tauri/src/workspace/callback.html`, served with a nonce-only CSP.

**Frontend modules** (plain ES modules, no bundler, every template escapes provider text):

| Module | Responsibility |
|---|---|
| `app.js` | Controller: routing, shell (sidebar profile, sync status), actions, forms, notes autosave, live minute re-render, legacy tools mount |
| `store.js` | Serialized mutations against native revisions; `escapeHtml` |
| `calendar-model.js` | Pure calendar geometry: view days, coverage, event spans in the workspace zone, overlap columns, free slots |
| `format.js` | Zone-aware date/time labels, initials, avatar colours (numbers < 1e11 are epoch seconds, else ms) |
| `selectors.js` | Snapshot projections: messages, attention, decisions, connection state, chat titles |
| `ui.js` / `icons.js` | CodeMie components (button variants, switch, checkbox, modal, toast, segmented, badge, avatar) and stroke icons |
| `view-today.js`, `view-calendar.js`, `view-inbox.js`, `view-settings.js` | Pure HTML renderers for each route |

Visual values follow `prototypes/milestone-1/CODEMIE-DESIGN-SPEC.md` (extracted from `codemie-ui`): GeistMono UI, 28 px buttons, 32×16 switches, 16 px checkboxes, 8 px dialogs over a 50% scrim.

The existing `renderer.js` / Engine / runner / PTY are mounted once, lazily, in Settings. Runtime preparation is requested only for CLI-dependent tools. Preserve the installer contracts and original CLI/profile/PATH ownership. Workspace storage failure leaves existing tools accessible; runtime failure leaves the local workspace usable.

Workspace presentation, source access and pinned-profile revisions are separate. Account-bound sources are canonical; workspace decisions remain local. Background jobs recheck account generation, policy, selected sources, claim attempt and current schedule/rule before acting. Calendar cursors and completed resource rounds commit together. Unknown send/OS outcomes are never blindly retried.

## Architecture Overview

```
ui/                         (frontend — ES modules, no bundler)
  index.html                views + overlays
  renderer.js               view routing + Engine construction
  engine.js / handlers.js   install orchestration + per-step logic
  runner-bridge.js          wraps Rust commands as JS module surface
  models.js / steps.js      data models + step loading
  terminal.js / log.js      UI widgets

src-tauri/src/              (backend — thin Rust command layer)
  lib.rs                    builder, state, command registration
  state.rs                  AppState { remembered, pty, pre_injection_path, bundled_injected, existing_cli_detected }
  error.rs                  InstallerError + CmdResult<T>
  commands/                 one module per system concern
    runner.rs               shell execution (capture / stream / fresh_env)
    inspector.rs            git / node / npm / codemie probes
    installer.rs            Node .pkg download + sudo install
    runtime.rs              macOS first-launch install of Node + CLI into Application Support, CLI updates
    downloader.rs           reqwest streaming download
    pathman.rs              login-shell PATH + ~/.zprofile persistence
    pty.rs                  portable-pty interactive terminal
    logger.rs               ~/Library/Logs/CodeMie/ file logger
    window.rs / smoke.rs    window control + smoke test modes
  steps.rs                  get_steps: embedded config/steps.yaml
```

**Key decision (Option B):** orchestration brain stays in JS (reused from Electron app). Rust provides only thin system commands. This eliminates the highest-risk port (async approval-gate) and reuses ~400 lines of already-tested JS.

---

## Component Responsibilities

| Component | Responsibility | Depends on |
|---|---|---|
| `engine.js` | Step sequencing, approval gates, fatal/non-fatal logic | handlers.js, models.js |
| `handlers.js` | Per-step logic — calls `runner-bridge.js` for system ops | runner-bridge.js |
| `runner-bridge.js` | Tauri `invoke()` / `listen()` wrappers | Tauri IPC |
| `renderer.js` | View routing (home/wizard/connect), Engine construction | engine.js, runner-bridge.js |
| `commands/runner.rs` | `run_capture`, `run_stream`, `run_fresh_env` — login-shell exec | tokio, state.rs |
| `commands/inspector.rs` | `check_git/node/npm/codemie`, `check_profile_status` | runner.rs |
| `commands/runtime.rs` | `runtime_ready`, `ensure_runtime`, `update_cli` — Node from nodejs.org (pinned SHA-256 in runtime.json) into `runtime/node-<v>`, the CLI via `npm ci` with the embedded `assets/codemie-cli` lock into `runtime/cli-<v>`, `node`/`cli` links switched atomically; `update_cli` installs a newer npm release in the background; stale dirs removed at launch; the legacy adapter gates CLI-dependent boot on it | reqwest, sha2, state.rs |
| `state.rs` | `AppState` — PTY handle, remembered PATH dirs, `bundled_injected`, `existing_cli_detected` (the user's own CLI: no download) | pty.rs |
| `error.rs` | `InstallerError` (thiserror) → serializes to String for IPC | — |

---

## IPC Pattern

Frontend→backend: `invoke('<command_name>', { arg })` via Tauri IPC.
Backend→frontend: `app.emit("engine:<event>", payload)` events — see `src-tauri/src/commands/runner.rs:87`.

All commands registered in `src-tauri/src/lib.rs:27–56`.

| ✅ DO | ❌ DON'T |
|---|---|
| Call system ops via `invoke()` in `runner-bridge.js` | Import Node/OS APIs directly in frontend JS |
| Add new Rust commands to `commands/` + register in `lib.rs` | Move installer Engine orchestration into Rust |
| Use `CmdResult<T>` for fallible commands | Return raw `String` errors from commands |

---

## Error Handling Pattern

`InstallerError` (thiserror) is the single error type for all Rust commands. It serializes to a plain String so the frontend receives a readable message — mirrors the Electron app's `throw new Error(msg)` pattern.

- Definition: `src-tauri/src/error.rs:6`
- Alias: `pub type CmdResult<T> = Result<T, InstallerError>` — `src-tauri/src/error.rs:25`
- Usage: fallible commands return `CmdResult<T>`; infallible ones return `T` directly

---

## State Pattern

`AppState` is managed via Tauri's `manage()` call (`lib.rs:10`) and injected into commands via `State<'_, AppState>`.

- `remembered` — `Vec<String>` of PATH dirs discovered during the session; used by `run_fresh_env` so a just-installed binary is found without restart
- `pty` — `Option<PtyHandle>` for the active pseudo-terminal

Reference: `src-tauri/src/state.rs:14`

---

## Adding New System Commands

1. Create or extend a file in `src-tauri/src/commands/`.
2. Annotate the function with `#[tauri::command]`.
3. Return `T` (infallible) or `CmdResult<T>` (fallible).
4. Register in `lib.rs` `invoke_handler!` block.
5. Add a JS wrapper in `runner-bridge.js`.
6. Add a unit test in the same Rust module under `#[cfg(test)]`.

---

## Configuration

| Config | Location | Access |
|---|---|---|
| Install steps | `config/steps.yaml` (embedded via `include_str!`) | `steps::get_steps()` — `src-tauri/src/steps.rs` |
| Smoke mode flags | `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` env vars | `lib.rs` startup + `commands/smoke.rs` |
| Session log | `~/Library/Logs/CodeMie/codemie_wizard.log` | `commands/logger.rs:34` |
