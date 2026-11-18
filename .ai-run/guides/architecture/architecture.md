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
| `app.js` | Controller: routing, shell (sidebar profile, sync status), actions, forms, notes autosave, live minute re-render; delegates `cm-*` actions to `codemie/controller.js` |
| `codemie/` | Settings → CodeMie (Overview, Profiles, Coding agents, Connected apps, Health), the guided setup sheet and the Today setup card: `service.js` (CLI state and every CLI/native call, logged in "What CodeMie ran"), `model.js` (pure derivations), `setup-session.js` (answers `codemie setup` through `setup-driver.js`), pure `view-*.js` renderers, `controller.js` |
| `store.js` | Serialized mutations against native revisions; `escapeHtml` |
| `calendar-model.js` | Pure calendar geometry: view days, coverage, event spans in the workspace zone, overlap columns, free slots |
| `format.js` | Zone-aware date/time labels, initials, avatar colours (numbers < 1e11 are epoch seconds, else ms) |
| `selectors.js` | Snapshot projections: messages, attention, decisions, connection state, chat titles |
| `ui.js` / `icons.js` | CodeMie components (button variants, switch, checkbox, modal, toast, segmented, badge, avatar) and stroke icons |
| `view-today.js`, `view-calendar.js`, `view-inbox.js`, `view-settings.js` | Pure HTML renderers for each route |
| `view-tasks.js`, `tasks-model.js`, `tasks-controller.js` | Tasks page (board, list, drawer): pure renderer, pure model (status, owner, filters, order) and the controller for moves, drag and drop and Undo. Tasks are `commitment` records written by `task_save` / `task_delete` (`src-tauri/src/workspace/tasks.rs`, which also keeps each meeting folder's `tasks.json` and queues the 09:00 due-today reminder) |
| `view-meetings.js`, `view-meeting-tabs.js`, `meetings-model.js`, `meetings-controller.js`, `markdown.js` | Meetings page (list, the meeting, its five tabs, the calendar badge and event card, Today's card): pure renderers, the pure model (`meetingState`, lanes, `resolveTemplate`, `parseGlossary` / `parseTags` mirroring native) and the controller for every `meeting-*` / `doc-*` action. `markdown.js` renders notes, escaping first |
| `view-settings-meetings.js`, `settings-meetings-editors.js`, `meetings-settings-controller.js` | Settings › Meetings (Transcripts & folders, Note templates, Automatic rules, Glossary & tags, Tasks): pure panels, the live editors (template editor, Markdown editors, rule tester) the controller patches in place while the person types, and the `meetings-settings-*` actions |

### Meetings and tasks

Native code is `src-tauri/src/workspace/meetings/` (transcripts, folders, notes) and `workspace/tasks.rs` (the board); spec `docs/superpowers/plans/2026-11-17-meetings-transcripts-tasks.md`, prototype `prototypes/meetings/`.

- **Records.** `meeting` is account-bound like its event (same id, `source = calendar:<id>`, purged on disconnect; folders stay on disk): state, transcript ids, folder, documents (`docs`, `main`), `lastError`, `removedLines`. `note_template` (built-ins `meeting-notes`, `short-summary` merged with overrides, which say `edited`; the person's own and skills) and `meeting_rule` are local to the active workspace. Tasks are `commitment` records (see the Tasks row above). The snapshot adds `noteTemplates` (all templates) and `meetingsRoot {path, isDefault}`.
- **Jobs.** `transcript_check` (`transcript_check:<meetingId>:<slot>`), `transcript_download` (`transcript_download:auto:<meetingId>:<slot>` from the round, `transcript_download:<operationId>` for Try again / Download again), `meeting_notes` (`meeting_notes:<operationId>`, deduped on `notesKey` among queued and running jobs; automatic `meeting_notes:auto:<meetingId>`), and the 09:00 `notification` keyed `tasks_due:<date>`. `slot = now / (checkEveryMin·60)`, so a failed round job runs again next slot.
- **Operations.** `meeting_check`, `meeting_download`, `meeting_import`, `meeting_speakers`, `meeting_notes`, `meeting_set`, `meeting_doc`, `template_save`, `template_delete`, `meeting_rule_save`, `meeting_rule_delete` (answers the body; Undo saves it back), `meeting_rule_order`, `meeting_text_save`, `task_save`, `task_delete`; read-only `meeting_read {part: transcript|files|file|doc}`, `meeting_text`, `meeting_skills`, `meetings_reveal`. Settings › Meetings saves through `settings_update {meetings: {…}}` (`MeetingSettings::apply`: camelCase fields, one checked at a time, refusals carry `field`). Errors added: `transcript_blocked`, `transcript_missing`, `folder_missing`, `folder_unwritable`, `skill_missing`, `too_large`, `unreadable`. `meeting_text` answers `{text, path, linked, cut}`: a glossary or tag list that exists but can't be read is `unreadable`, one over 100 KB comes back cut (`cut: true`), and `meeting_text_save` refuses to write over either, so Settings shows them read-only.
- **Meetings root.** `~/CodeMie Connect/Meetings` by default, made on the first save. A custom root (picked with the `meetings_root_pick` Tauri command, saved with `settings_update {meetings: {root}}`) must already exist; a missing or read-only one is `folder_unwritable` (“choose the folder again”). New meetings go to the root of the moment; saved ones keep their folders. Folder names follow `folderPattern` (`echo` `YYYY-MM-DD_HHMMSS-<slug>`, `date-title`, `title-date`; slug ≤ 60 characters, `-2`, `-3` on a collision).
- **Folder files** (Echo-compatible): `transcript.vtt` (kept with `keepVtt`), `transcript.md`, `segments.json`, `meeting.json`, `meta.json` (snake_case), `notes.md` (the main document) and `notes.<template>.md`, `notes-history/` (`keepVersions`; a document file the record doesn't know, e.g. after signing out and back in, moves there before a run or *Make main* would write or rename over it), `tasks.json` (Echo's `actions.json` shape), `run.log`. `glossary.md` and `tags.md` live in the root unless `glossarySource` is `file` (then the two linked files are only read).
- **Contract fixtures.** `meeting-records.json`, `meeting-transcript.json`, `meeting-files.json` (`contract_fixtures_match_the_real_meetings`), `meeting-notes-job.json`, `meeting-ready.json`, `note-templates.json`, `meeting-rules-cases.json`, `glossary-parse.json` (`contract_fixtures_match_the_real_meeting_notes`), `task-records.json`, `task-delete.json` (`contract_fixtures_match_the_real_tasks`).

Visual values follow `prototypes/milestone-1/CODEMIE-DESIGN-SPEC.md` (extracted from `codemie-ui`): GeistMono UI, 28 px buttons, 32×16 switches, 16 px checkboxes, 8 px dialogs over a 50% scrim.

Settings → CodeMie is native (`ui/workspace/codemie/`). It runs the CLI through `run_capture` / `run_stream`, uses the PTY only for `codemie setup`, and asks Rust only for what the CLI cannot tell it (`read_codemie_profiles`, `codemie_url_check`, `codemie_org_defaults`, `codemie_app_states`, `open_agent_in_terminal`). The legacy `renderer.js` installer UI is no longer mounted in Settings; it serves smoke/probe mode and the storage-recovery page only. The CodeMie runtime downloads in the background on first launch. Preserve the installer contracts and original CLI/profile/PATH ownership. Workspace storage failure leaves existing tools accessible; runtime failure leaves the local workspace usable.

Workspace presentation, source access and pinned-profile revisions are separate. Account-bound sources are canonical; workspace decisions remain local. Background jobs recheck account generation, policy, selected sources, claim attempt and current schedule/rule before acting. Calendar cursors and completed resource rounds commit together. Unknown send/OS outcomes are never blindly retried.

## Milestone 2 boundaries: `ai/`, `storage/`, `plugins/`

Spec: `prototypes/milestone-2/DESIGN.md`; plugin contract: `prototypes/milestone-2/PLUGIN-ENGINE.md`; evidence: `VALIDATION.md` and `PLUGIN-CONFORMANCE.md` next to them.

| Module | Owns | Does not own |
|---|---|---|
| `src-tauri/src/ai/` | Finding Claude Code CLIs (`discover`), reporting which AI profiles are usable (`profiles`: the user's own Claude Code, or a `codemie-claude` profile from `~/.codemie/codemie-cli.config.json`; secrets never read), and running Claude headless and tool-free (`command`, `runner`, `stream`) | What to ask Claude, or what happens to the answer |
| `src-tauri/src/workspace/` (`prompts`, `automations/`) | Prompts for drafts, summaries and automations, the `ai_draft` / `ai_summarize` / `automation_run` jobs, drafts and summaries as records, automation rules, runs and delivery to Today. Nothing is sent: a draft only fills the reply box | Running the CLI (`ai::runner`) |
| `src-tauri/src/storage/` | The user-chosen data folder: `location.json` pointer and root resolution, target validation (cloud folders, network volumes, exFAT, free space), move and adopt (`migrate`), the old copy a move leaves (`old_copy`), and the Settings and recovery commands (`commands`) | The workspace schema |
| `src-tauri/src/plugins/` | Echo-compatible plugins: manifest and permission sheet (`manifest`, `capabilities`), marketplaces over git (`market`, `git`), install, update and remove (`install`, `registry`, `tree`), the QuickJS host (`host/`), Connect's side of `ctx` (`services/`), the manager that loads enabled plugins, the `connect-plugin://` scheme (`protocol`) and caller checks (`caller`); `plugins_request` and `plugin_call` (`commands`) | Plugin UI code, which runs in the frame (`ui/plugins/`) |

Frontend counterparts: `ui/workspace/settings-ai.js`, `draft-state.js`, `summary-state.js`, `view-automations.js` and `automations-controller.js` (pure state and renderers), `settings-storage.js` and `data-location-flow.js`, `settings-plugins.js` and `today-plugins.js`, and `ui/plugins/host.js` (frame management in the window). The Claude chooser (`ai-chooser.js`) is shared by Inbox, Today and Settings. Detection (`ai::profiles`) calls a CodeMie profile ready once `codemie-claude` and the profile exist; Settings → Claude and the chooser take the active CodeMie profile's sign-in from Settings → CodeMie (`withCodemieSignIn` over `codemie/controller.js` `signIn()`), so one profile never shows two readiness states, and a profile that needs sign-in offers CodeMie's browser sign-in (`cm-profile-login`). The CodeMie setup sheet opens only after the workspace opens, never over the recovery page (which closes it), and not in the marketplace smoke (`CODEMIE_PLUGIN_SMOKE`), which runs no CodeMie CLI command.

### Data root and private root

`storage::location` resolves a data root and a private root (DESIGN.md §8). By default both are `~/Library/Application Support/com.epam.codemie.installer/workspace/`; when the user moves the data, the data root is `<picked folder>/CodeMie Connect Data/` (marked by `.codemie-connect.json`, with its own lock so two Macs cannot share one drive) and the private root stays where it was.

| Root | Holds |
|---|---|
| Data root (movable) | `workspace.sqlite` (+ WAL/SHM), `ai-staging/`, `plugins/` (packages in `installed/<id>/<version>/`, plugin data, registry) and automation run output |
| Private root (never moves) | `credentials/` (Microsoft sign-in), plugin secrets (written `0600`), `owner.lock`, `window.json` and `location.json` |

Credentials and plugin secrets therefore never land in a cloud-synced or external folder; target validation also refuses cloud-synced folders, network volumes and exFAT, and checks free space. A move copies and verifies, swaps the pointer, then leaves the old copy for the user to remove. Contract fixtures `location-*.json` and `check-*.json` pin the commands' responses.

### Plugin host and isolation

A plugin has two halves. Its host half (`main.js`) runs in Rust; its client half (`client.js`) runs in the UI.

- **Host half.** One QuickJS runtime on its own OS thread per plugin (`host/worker.rs`), so a stuck plugin holds up no other. Only JSON text crosses the bridge (`host/bridge.rs`, `prelude.js`); bridge functions never throw and never call back into JavaScript. Every entry into JS is a turn with a JS-time and wall-time budget (30 s call limit; awaiting a host call such as `claude.run` does not count). A plugin that overruns is faulted: its runtime is dropped, waiting callers hear `timeout`, and it is rebuilt on next use or after a backoff (30 s, doubling to 10 min) so its timers resume. JSON crossing the boundary is capped at 16 MB (R35).
- **Services.** `plugins/services/` implements Connect's `ctx`: scoped store and cache, files, `http` (hosts the plugin declared, nothing private), notifications, settings (secrets in the private root), Claude runs (tool-free), deliveries to Today, `echo.read`, events, sign-in (GitHub reads `gh auth token` only after the user presses Sign in). A service checks the plugin's grants on every call.
- **Client half.** Each plugin UI is an `<iframe sandbox="allow-scripts">` (opaque origin, no `allow-same-origin`) whose `src` is `connect-plugin://<id>/…` (macOS only, R30). Each plugin is its own origin with its own CSP; files come from the plugin's active version only; Connect's shim is served from `__host/`.
- **Bridge rules.** The frame and the window talk over a `MessageChannel` made afresh on each load; messages are versioned, have exactly the documented fields, and anything else is dropped (`ui/plugins/frame/messages.js`). The window never takes a plugin id from a message: the channel names the frame. A frame can call only its own plugin's host-half commands. Inside a frame `__TAURI__` and `__TAURI_INTERNALS__` are absent, `ipc://` fetches fail and `parent.document` throws; `plugins::caller` also refuses `Origin: null` and non-main-page callers in sensitive commands. This is checked by the isolation smoke, not assumed.
- **Permission sheets.** Installing or updating reads the manifest's `uses`, and `capabilities` builds a sheet listing every capability with its Connect status (supported, partial with its limit, unsupported). The user agrees to the sheet; the backend recomputes it and compares `sheetHash`, so an install or update that changed since the sheet was shown is refused and shown again. An update that changes what the plugin asks for needs a new agreement.

Plugin ids are lowercase (`valid_id`), because they are also URL hosts.

### Where Milestone 2 differs from Echo

Connect implements plugin engine 1.0 (PLUGIN-ENGINE.md §10). `sessions`, `channel`, `agent`, `scripts`, `threads`, `slots`, `view`, `knowledge` and `claude.hasPlugin/installPlugin` are `undefined`, so plugins feature-detect them; `terminal` is `false`. The manifest's `echo` version is ignored and `engine` is checked. `echo.read('threads')` is `[]`; `threads_changed` is not sent. Claude runs are tool-free. A plugin that calls an Echo-only member without a check fails to load with a clear `unsupported:` message (Telegram today; its fix is in the plugin). Page widgets on Today are text only. Deliveries to mail and Teams are held on Today with Copy; Connect never sends them.

---

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
