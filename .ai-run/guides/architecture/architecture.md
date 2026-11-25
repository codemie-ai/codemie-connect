# Architecture

**Project**: CodeMie Connect
**Style**: Frontend installer orchestration (Option B) plus a native workspace service
**Languages**: Rust (backend) + Vanilla JS ESM (frontend)
**Framework**: Tauri v2 (2.12.6)

---

## Overview

CodeMie Connect is a Tauri v2 desktop app: the window (`ui/`, plain ES modules, no bundler) renders the Personal Workspace and Settings, and Rust (`src-tauri/src/`) owns the system commands, the workspace domain with its background jobs, Claude runs, the data folder and the plugin host. The legacy installer flow keeps its Engine in JS and calls thin Rust commands (Option B).

| Part | What it holds | Start here |
|---|---|---|
| `ui/workspace/` | the window: routing, pure views and models, controllers, the store | `ui/workspace/app.js::handle` |
| `ui/workspace/codemie/` | Settings → CodeMie: CLI state and calls, setup sheet, views | `ui/workspace/codemie/service.js::createCodemieService` |
| `ui/plugins/` | plugin frames, their MessageChannel and message schema | `ui/plugins/host.js::createPluginHost` |
| `ui/ (top level)` | legacy installer UI (Engine, handlers, renderer) and the CLI output parsers Settings reuses | `ui/engine.js::Engine` |
| `src-tauri/src/commands/` | installer and system commands: shell, PTY, runtime, PATH, logs, updater, smokes | `src-tauri/src/commands/runner.rs::run_capture` |
| `src-tauri/src/workspace/` | Core, SQLite repository, Graph sync, jobs, inbox, tasks | `src-tauri/src/workspace/mod.rs::Core.request` |
| `src-tauri/src/workspace/meetings/` | Teams transcripts, meeting folders, notes from templates | `src-tauri/src/workspace/meetings/record.rs::Core.meeting_lock` |
| `src-tauri/src/workspace/automations/` | automation rules, engine, runs and delivery to Today | `src-tauri/src/workspace/automations/engine.rs::automation_op` |
| `src-tauri/src/ai/` | Claude CLI discovery, profiles, the isolated runner | `src-tauri/src/ai/runner.rs::ClaudeRunner` |
| `src-tauri/src/storage/` | data-folder pointer, target checks, move, old copy, recovery commands | `src-tauri/src/storage/location.rs::LocationFile` |
| `src-tauri/src/plugins/` | Echo-compatible plugins: manifest, marketplaces, install, caller checks, connect-plugin scheme | `src-tauri/src/plugins/caller.rs::require_main_frame` |
| `src-tauri/src/plugins/host/` | one QuickJS runtime per plugin and the JSON bridge | `src-tauri/src/plugins/host/mod.rs::PluginHost` |
| `src-tauri/src/plugins/services/` | Connect's side of the plugin ctx, with grant checks | `src-tauri/src/plugins/services/mod.rs::Granted` |
| `src-tauri/tests/` | integration tests: bundle resources, the published Echo plugins | `src-tauri/tests/bundle_resources.rs::resources_map` |

## Key abstractions

| Abstraction | What it is | Where |
|---|---|---|
| Core | the opened workspace: repository, Graph session, Claude runner, background loop | `src-tauri/src/workspace/mod.rs::Core` |
| Request / Operation | the typed `workspace_request` payload and its operations | `src-tauri/src/workspace/models.rs::Request` |
| WorkspaceError | the error that crosses IPC: `code`, `message`, optional `retry_after`, `class` and `field` | `src-tauri/src/workspace/models.rs::WorkspaceError` |
| Repository | SQLite store with the revision and operation reservations | `src-tauri/src/workspace/repository.rs::Repository` |
| ClaudeRunner | runs one Claude call; `CliRunner` in the app, `FakeRunner` in tests | `src-tauri/src/ai/runner.rs::ClaudeRunner` |
| Granted | what one loaded plugin may do: its package and the agreed `uses` keys | `src-tauri/src/plugins/services/mod.rs::Granted` |
| AppState | installer-side managed state: PATH, PTY, CLI detection, update check | `src-tauri/src/state.rs::AppState` |
| Terminals | the terminal dock's sessions: one PTY per tab, kept output, start again with `--continue` | `src-tauri/src/commands/terminal.rs::Terminals` |
| createStore | the window's store: snapshot, serialized mutations, queries | `ui/workspace/store.js::createStore` |
| Refresher | keeps the macOS tray in step with the workspace: woken by `Core::emit`, debounced 300 ms, applies a view only when it differs from the last one | `src-tauri/src/workspace/menu_bar.rs::Refresher` |

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
| `terminal-dock.js`, `terminal-model.js` | Connect's terminal: a dock under the page (outside what `app.js` redraws, like the plugin layer) with a tab per Claude Code session, drawn with xterm.js; the model holds the tabs, the output offsets, Mac keys, links and colours. Rust runs the sessions (`commands/terminal.rs`): a plugin's `ctx.claude.session` and Settings → CodeMie's Start coding open there; the window can type into, resize, start again, close or move a tab to Terminal.app, never name a program |
| `view-today.js`, `view-calendar.js`, `view-inbox.js`, `view-settings.js` | Pure HTML renderers for each route |
| `view-tasks.js`, `tasks-model.js`, `tasks-controller.js` | Tasks page (board, list, drawer): pure renderer, pure model (status, owner, filters, order) and the controller for moves, drag and drop and Undo. Tasks are `commitment` records written by `task_save` / `task_delete` (`src-tauri/src/workspace/tasks.rs`, which also keeps each meeting folder's `tasks.json` and queues the 09:00 due-today reminder) |
| `task-target.js`, `settings-tasks.js`, `tasks-dates-model.js`, `view-tasks-dates.js` | The task-provider UI: `task-target.js`'s `activeTaskTarget` is the meeting column's one swap point for "Add N to …" and its Undo, following `taskProvider.active`; `settings-tasks.js` draws Settings › Tasks's "Where your tasks live" radio group and the chosen plugin's own settings (never a prefilled token), which `tasks-controller.js` saves; `tasks-dates-model.js` (drawn by `view-tasks-dates.js`) is By date's pure groups (Late, Today, Next 7 days, No date, Later), rows, chips and the header's status line. All read `taskProvider` and a task's `provider`/`remote`/`pending`/`syncError` fields from the snapshot, never a plugin's own frame |
| `view-meetings.js`, `view-meeting-tabs.js`, `meetings-model.js`, `meetings-controller.js`, `markdown.js` | Meetings page (the list with its Needs you card, days that fold and hidden meetings; the meeting with its people popover and four tabs, shown once it has a transcript; the calendar badge and event card, Today's card): pure renderers, the pure model (`meetingState`, lanes, `listModel` / `listOrder`, `resolveTemplate`, `parseGlossary` / `parseTags` mirroring native) and the controller for every `meeting-*` / `doc-*` action. Hidden meetings are a window preference (`codemie.meetings.hidden`: ids and event `seriesId`s), not native data: they leave the list, the sidebar count and Today, never Calendar or the round. `markdown.js` renders notes, escaping first (`front: 'tags'`, `dropTitle` for the notes page) |
| `view-settings-meetings.js`, `settings-meetings-editors.js`, `meetings-settings-controller.js` | Settings › Meetings (Transcripts & folders, Note templates, Automatic rules, Glossary & tags, Tasks): pure panels, the live editors (template editor, Markdown editors, rule tester) the controller patches in place while the person types, and the `meetings-settings-*` actions |
| `today-grid.js` | Pure Today grid: 12 columns of 56 px rows, packing (`compact`, `moveItem`, `resizeItem`, `placeAtTop`, `removeItem`), the built-in layouts (`PRESETS`: Default, Focus, Meeting day), `todayOf` (the saved `today`, or the grid an older `layout` and `widgetWidths` stand for) and `payloadOf` (what `layout_save` gets) |
| `today-controller.js`, `today-edit-view.js` | Today arranged by hand: `createTodayController` runs every `today-*` action (Customize, gallery, widget ⋯ menu, options, rename, saved layouts, lock, Undo and Redo, keys), each change one `layout_save` of the whole grid; `attachTodayDrag` wires the header drag, edge resize, gallery drag, grip keys and title double-click. `today-edit-view.js` is Customize mode's pure markup (edit bar, layouts menu, gallery, ⋯ menu, options panel, add tile) |
| `press.js` | `trackPress`: a press that becomes a drag for mouse, pen and touch (pen and touch after a long press), Escape cancels, the click after a drag is swallowed; `autoScroll` near a scroller's edges. Today and the page sections drag through it |
| `dock-model.js`, `dock-view.js`, `dock-controller.js` | Page sections on Calendar, Meetings, Inbox and Automations: the pure model (a stored layout checked against the page's `*_DOCK` definition, dividers, moving tabs, collapse, maximize, swap, `loadDock` / `saveDock`), the pure `renderDock`, and `attachDock` (the `dock-*` actions, divider and tab drags, keys) |
| `settings-layout.js` | Settings → Layout (pure): lock and handles, Today layouts, page layouts, side menus, keyboard shortcuts; its buttons reuse the `today-layout-*`, `dock-reset`, `sidebar-toggle` and `settings-menu-toggle` actions |

**Where layouts are stored.** The Today grid lives with the workspace in native storage: `layout_save {today, layout}`, which `src-tauri/src/workspace/today.rs::valid_today` checks whole (refused as `validation` "Invalid Today layout.", field `today`). Page sections, the lock, handles and both menus are preferences of this Mac in localStorage: `codemie.layout.<page>.v1`, `codemie.layout.locked`, `codemie.layout.handles`, `codemie.sidebar.collapsed`, `codemie.sidebar.folded` (the main menu's Work, AI and Plugins groups folded by hand), `codemie.settings.folded`, `codemie.settings.menu`.

### Meetings and tasks

Native code is `src-tauri/src/workspace/meetings/` (transcripts, folders, notes) and `workspace/tasks.rs` (the board); spec `docs/superpowers/specs/2026-11-17-meetings-transcripts-tasks-design.md`, plan `docs/superpowers/plans/2026-11-17-meetings-transcripts-tasks.md`. The visual reference, `prototypes/meetings/`, is local and git-ignored (`prototypes/` in `.gitignore`), so it is not in a clone.

- **Records.** `meeting` is account-bound like its event (same id, `source = calendar:<id>`, purged on disconnect; folders stay on disk): state, transcript ids, folder, documents (`docs`, `main`), `saveError` (the last save from Teams; `cancelled` when the person stopped it, which the round then never retries) and `notesError` (the last notes run), each cleared by its own step working, `pendingNotes` (a Make notes whose save failed for a reason that passes: queued once by the next save that works), `removedLines`. Older records' single `lastError` is split once when read (`split_legacy_error`; the UI's `meetingErrors` reads it the same way). `note_template` (built-ins `meeting-notes`, `short-summary` merged with overrides, which say `edited`; the person's own and skills) and `meeting_rule` are local to the active workspace. Tasks are `commitment` records (see the Tasks row above). The snapshot adds `noteTemplates` (all templates) and `meetingsRoot {path, isDefault}`.
- **Jobs.** `transcript_check` (`transcript_check:<meetingId>:<slot>`), `transcript_download` (`transcript_download:auto:<meetingId>:<slot>` from the round, `transcript_download:<operationId>` for Try again / Download again), `meeting_notes` (`meeting_notes:<operationId>`, deduped on `notesKey` among queued and running jobs; automatic `meeting_notes:auto:<meetingId>`, which a failed notes job doesn't stand in for; `meeting_notes:after-save:<jobId>` for `pendingNotes`; *Make notes for all* marks its jobs `batch`, claimed after drafts, summaries and notes for one meeting and before background Claude work), and the 09:00 `notification` keyed `tasks_due:<date>`. `slot = now / (checkEveryMin·60)`: a check that didn't get through runs again next slot; a failed save does only for `throttled`, `offline`, `provider` and (once Microsoft is signed in again) `needs_login`, within a day after the meeting. `folder_unwritable`, `transcript_missing` and a save the person stopped wait for the person. Transcript lists are read page by page (`@odata.nextLink`, at most ten pages).
- **Operations.** `meeting_check`, `meeting_download`, `meeting_import`, `meeting_speakers`, `meeting_notes`, `meeting_set`, `meeting_doc`, `template_save`, `template_delete`, `meeting_rule_save`, `meeting_rule_delete` (answers the body; Undo saves it back), `meeting_rule_order`, `meeting_text_save`, `task_save`, `task_delete`; read-only `meeting_read {part: transcript|files|file|doc}`, `meeting_text`, `meeting_skills`, `meetings_reveal`. Settings › Meetings saves through `settings_update {meetings: {…}}` (`MeetingSettings::apply`: camelCase fields, one checked at a time, refusals carry `field`). Errors added: `transcript_blocked`, `transcript_missing`, `folder_missing`, `folder_unwritable`, `skill_missing`, `too_large`, `unreadable`. `meeting_text` answers `{text, path, linked, cut}`: a glossary or tag list that exists but can't be read is `unreadable`, one over 100 KB comes back cut (`cut: true`), and `meeting_text_save` refuses to write over either, so Settings shows them read-only.
- **Meetings root.** `~/CodeMie Connect/Meetings` by default, made on the first save. A custom root (picked with the `meetings_root_pick` Tauri command, saved with `settings_update {meetings: {root}}`) must already exist; a missing or read-only one is `folder_unwritable` (“choose the folder again”). New meetings go to the root of the moment; saved ones keep their folders. A root change copies `glossary.md` and `tags.md` into the new root when it has none (never over one it has); `settings_update` then answers `texts {copied, kept, failed}` and the toast says which. Folder names follow `folderPattern` (`echo` `YYYY-MM-DD_HHMMSS-<slug>`, `date-title`, `title-date`; slug ≤ 60 characters, `-2`, `-3` on a collision).
- **Folder files** (Echo-compatible): `transcript.vtt` (kept with `keepVtt`), `transcript.md`, `segments.json`, `meeting.json`, `meta.json` (snake_case), `notes.md` (the main document) and `notes.<template>.md`, `notes-history/` (`keepVersions`; a document file the record doesn't know, e.g. after signing out and back in, moves there before a run or *Make main* would write or rename over it), `tasks.json` (Echo's `actions.json` shape), `run.log`. `glossary.md` and `tags.md` live in the root unless `glossarySource` is `file` (then the two linked files are only read).
- **Contract fixtures.** `meeting-records.json`, `meeting-transcript.json`, `meeting-files.json` (`contract_fixtures_match_the_real_meetings`), `meeting-notes-job.json`, `meeting-ready.json`, `note-templates.json`, `meeting-rules-cases.json`, `glossary-parse.json` (`contract_fixtures_match_the_real_meeting_notes`), `task-records.json`, `task-delete.json` (`contract_fixtures_match_the_real_tasks`), `task-provider-states.json`, `task-sync-cases.json` (`contract_fixtures_match_the_task_sync_cases`, below).

### Task providers

`src-tauri/src/workspace/task_provider/` (design `docs/superpowers/specs/2026-11-23-task-provider-design.md`) lets a plugin that declares `provides: ["tasks"]` become the active task provider instead of Connect's own board; the built-in **Local** provider is the default. `TaskSettings` (`mod.rs`, settings key `tasks`) holds the choice (`"local"` or `"plugin:<id>"`) and which providers a Local copy was already offered to. `TaskProviders` (`mod.rs`) is Connect's way into a provider plugin's host half: `call` reaches its registered `tasks:<op>`, `available` lists every installed task plugin with its on/ready state, `secret_matches` keeps its stored token out of a log or error message; the plugin manager implements it (`plugins/manager.rs::ManagerTasks`), tests use `task_provider::fake::FakeProvider`.

- **Keys.** Every task carries a stable `key` (`task_provider::keys::task_key`, the first 16 hex characters of `sha1("<source>#<normalized text>")`; `normalize` matches the reference `normalizeCommitment` byte for byte, pinned by `keys-vectors.json`) so a retry, a rerun or a crash between "sent" and "acknowledged" never makes a second task. The ledger (record kind `task_key`, `keys::ledger_get` / `ledger_put`) remembers, per provider and key, the remote id a create got and its state (`created`, `done`, `withdrawn`, `removed`) — Local keeps its own ledger too (no remote id, the key itself stands in for one), so `tasks::create_by_key` (the automations create-tasks delivery's only way to make a task) is just as idempotent, and just as final once a Local task is deleted or finished, without a provider plugin at all.
- **Outbox.** A change is saved locally first and queued (`task_provider::outbox`, record kind `task_outbox`: `enqueue_all`, `delete_task`, `park`, `stale_removes`) in the same transaction as the task, so a write never fails because the provider is unreachable; consecutive updates coalesce and a task's later entries wait behind its still-queued create.
- **Sync.** The `task_sync` job (`task_provider::sync::run`) pushes the outbox to the active provider, oldest first (at most 50 entries a pass), then pulls `changedSince` (first, when an `update` waits, so the merge decides a field changed on both sides) and merges the answer into the cache, field by field, against the provider's last-seen fields (`task_provider::merge::merge`: Connect's edit wins unless the provider's is later, a provider `done`/reopened always wins) over the wire shape (`task_provider::wire::to_wire` / `from_wire`). It backs off on `offline` (30 s, doubling to 15 min) and `rate_limited` (the provider's `retryAt`), stops calling on `needs_token` until `Core::task_secret_saved`, and keeps a request budget (4/s, 300/15 min). `sync::reread` (a switch, Check, a changed provider setting via `Core::task_setting_saved`) pulls since the cursor, then the full list, and retires cached open tasks the full list no longer holds without deleting them anywhere.
- **Operations.** `task_provider::ops` adds `task_provider_set` (switch provider, the Local copy offered once), `task_provider_check` (Settings › Tasks's Check, read-only), `task_withdraw` (the meeting column's Undo: drops an unsent create or queues a `remove` — a delete, never a close — and marks the key `withdrawn` so a later add creates again), `task_bulk` (By date's moves, answering `before` for Undo), `task_handled` (Done / Keep open; evidence only flags a task, `task_provider::handled::kept`) and `task_parked` (Try again / Discard change for a refused entry). `task_provider::handled::sweep` runs after a Microsoft sync round and closes an open `reply` task the user answered themselves.
- **Fixtures.** `contract_fixtures_match_the_task_sync_cases` (`task_provider/sync.rs`) writes `task-provider-states.json` (the snapshot's `taskProvider` for each state: `local`, `ready`, `syncing`, `offline`, `rate_limited`, `needs_token`, `off`, `failed`) and `task-sync-cases.json` (task records for the offline-replay, adopted-create, parked-entry and merged-both-sides cases); UI tests and the browser mock read `task-provider-states.json` by name (`STATES.ready`, …).

### Menu bar count

`src-tauri/src/workspace/menu_bar.rs` (design `docs/superpowers/specs/2026-11-24-menu-bar-count-design.md`) is the number beside CodeMie Connect's icon in the macOS menu bar: Settings › Notifications' four switches (`MenuBarSettings`, settings key `menuBar`, `settings_update {menuBar: {...}}` applies only the fields given), what counts as "new" (replies and unacknowledged critical messages as Inbox counts them, tasks due or late, a meeting's notes made since it was last opened, an automation result since Today or Automations was last looked at — each a seen record, kind `menu_bar_seen`, id `personal`, unversioned, holding `{since, automations, meetings: {<id>: ts}}`), what needs fixing (a sign-in, a task plugin's token or a failed plugin, parked task changes, a failed automation, an unwritable meetings folder), and the snapshot's `menuBar` (`Core::menu_bar_snapshot`: `count`, `label` (`""` at 0, the number to 99, `"99+"` above), `amber`, `sources`, `counted`, `fixes`, `tooltip`, `newMeetings`).

- **The tray.** `Refresher` (`menu_bar.rs::Refresher`) keeps the tray (id `"main"`, `TrayIconBuilder::with_id("main")` in `workspace/mod.rs::setup_tray`) in step: `Core::emit("workspace:changed")` only wakes it (`self.menu_bar.wake()`) — the count happens later, so a caller holding the repository guard never blocks on it. The refresher (`Core::start_menu_bar`) waits `DEBOUNCE` (300 ms) after each wake for more, then counts once (`Core::refresh_menu_bar_now`: reads under the repository guard, computes, drops the guard, then offers the view to the tray) and applies only when the view differs from the last one applied. `offer`'s main-thread guard: each macOS tray setter blocks on the thread that installed the sink (`install` records it); on that thread a busy `applying` lock is never waited on (that would deadlock the apply holding it) — `offer` just asks for another recount instead. Tests use `FakeTray` (records each applied view, can be slowed to prove applies never overlap) instead of the real tray.
- **`menu_bar_seen`** (`Core::menu_bar_seen`, `ui/workspace/menu-bar.js`'s `seenToSend` / `sendSeen`): marks a meeting's notes or the automation results seen, dropping them out of `newMeetings` / zeroing `sources.automations`. The window sends a mark only while the document is visible and focused, nothing is being typed in and no dialog is open, at most once per snapshot revision (`"<revision>|<key>"` in a sent-set); a refusal keeps that key rather than clearing it, so a mark is retried only once the revision moves, not on the very next render — two marks refused together would otherwise retry each other forever (Task 6 review).

Visual values follow `prototypes/milestone-1/CODEMIE-DESIGN-SPEC.md` (extracted from `codemie-ui`): GeistMono UI, 28 px buttons, 32×16 switches, 16 px checkboxes, 8 px dialogs over a 50% scrim.

Settings → CodeMie is native (`ui/workspace/codemie/`). It runs the CLI through `run_capture` / `run_stream`, uses the PTY only for `codemie setup`, and asks Rust only for what the CLI cannot tell it (`read_codemie_profiles`, `codemie_url_check`, `codemie_org_defaults`, `codemie_app_states`, `open_agent_in_terminal`). The legacy `renderer.js` installer UI is no longer mounted in Settings; it serves smoke/probe mode and the storage-recovery page only. The CodeMie runtime downloads in the background on first launch. Preserve the installer contracts and original CLI/profile/PATH ownership. Workspace storage failure leaves existing tools accessible; runtime failure leaves the local workspace usable.

Workspace presentation, source access and pinned-profile revisions are separate. Account-bound sources are canonical; workspace decisions remain local. Background jobs recheck account generation, policy, selected sources, claim attempt and current schedule/rule before acting. Calendar cursors and completed resource rounds commit together. Unknown send/OS outcomes are never blindly retried.

## Milestone 2 boundaries: `ai/`, `storage/`, `plugins/`

Spec: `prototypes/milestone-2/DESIGN.md`; plugin contract: `prototypes/milestone-2/PLUGIN-ENGINE.md`; evidence: `VALIDATION.md` and `PLUGIN-CONFORMANCE.md` next to them.

| Module | Owns | Does not own |
|---|---|---|
| `src-tauri/src/ai/` | Finding Claude Code CLIs (`discover`), reporting which AI profiles are usable (`profiles`: the user's own Claude Code, or a `codemie-claude` profile from `~/.codemie/codemie-cli.config.json`; secrets never read), an Ollama engine reached only through a CodeMie profile whose `provider` is `ollama` (local only — empty `baseUrl`, or loopback with no explicit port or port 11434 — probed once per detection with `ollama list` through `CommandProbe`, never in tests), and running Claude headless and tool-free (`command`, `runner`, `stream`) | What to ask Claude, or what happens to the answer |
| `src-tauri/src/workspace/ai.rs` (`prompts`, `automations/`) | Which profile and model each job uses: one row per job and plugin (`RouteKey`, wire name `wire()`), a row that sets nothing inherits its group's choice up to Default (`group_of`); `choose`/`choose_default` is the single resolution rule (profile and model travel together, fallback inherits on its own); `resolve` picks a ready fallback before a run, `Core::run_resolved` runs once more on it after a qualifying failure (`needs_login`, `not_installed`, `too_old`, `not_configured`, `rate_limited` — never a timeout, invalid output, failed or cancelled run), except a run in a folder, which is never retried on the fallback after it failed (its edits may already be in the folder — the fallback before the run still applies); `chosen` (the resolved profile, model, fallback and group per row) is answered by both `ai_status` and `ai_settings_save` so the window never resolves a row itself. Prompts for drafts, summaries and automations, the `ai_draft` / `ai_summarize` / `automation_run` jobs, drafts and summaries as records, automation rules, runs and delivery to Today, the create-tasks delivery (a run's cited messages become tasks through `tasks::create_by_key`, one create per key — a rerun or a retry never makes a second task), and the `meeting_ready` summary automation (queues a note-template document for each ready meeting, after any automatic notes, finding no tasks). Nothing is sent: a draft only fills the reply box | Running the CLI (`ai::runner`) |
| `src-tauri/src/storage/` | The user-chosen data folder: `location.json` pointer and root resolution, target validation (cloud folders, network volumes, exFAT, free space), move and adopt (`migrate`), the old copy a move leaves (`old_copy`), and the Settings and recovery commands (`commands`) | The workspace schema |
| `src-tauri/src/plugins/` | Echo-compatible plugins: manifest and permission sheet (`manifest`, `capabilities`), the roles a plugin can take beyond `uses` (`manifest::ROLES`, today just `tasks`), marketplaces over git (`market`, `git`), install, update and remove (`install`, `registry`, `tree`), the QuickJS host (`host/`), Connect's side of `ctx` including `ctx.tasks.provide` (`services/`), the manager that loads enabled plugins and turns the ones with the `tasks` role into task providers (`manager::ManagerTasks`, `workspace::task_provider::TaskProviders`), the `connect-plugin://` scheme (`protocol`) and caller checks (`caller`); `plugins_request` and `plugin_call` (`commands`) | Plugin UI code, which runs in the frame (`ui/plugins/`); the task-provider contract itself (`workspace::task_provider`) |

Frontend counterparts: `ui/workspace/settings-ai.js`, `draft-state.js`, `summary-state.js`, `view-automations.js` and `automations-controller.js` (pure state and renderers), `settings-storage.js` and `data-location-flow.js`, `settings-plugins.js` and `today-plugins.js`, and `ui/plugins/host.js` (frame management in the window). The Claude chooser (`ai-chooser.js`) is shared by Inbox, Today and Settings. Detection (`ai::profiles`) calls a CodeMie profile ready once `codemie-claude` and the profile exist (an Ollama one additionally needs `ollama list` to answer and the profile's default model to be pulled, else it is `not_running` or `not_configured`); Settings › AI (tab id `ai`, still) and the chooser take the active CodeMie profile's sign-in from Settings → CodeMie (`withCodemieSignIn` over `codemie/controller.js` `signIn()`), so one profile never shows two readiness states, and a profile that needs sign-in offers CodeMie's browser sign-in (`cm-profile-login`). Settings › AI draws the profile cards (now with Engine and Provider facts) and "What each job uses": one row per job (Mail/Teams replies, Summaries, Meeting notes, Morning briefing, Inbox triage, Commitments, Automations, Ask — hidden until step 9) grouped under Replies, Summaries and notes, Automations and Plugins, plus one row per enabled plugin that agreed to `claude` under "All plugins"; each row's Profile, Model and Fallback selects, and its working/fallback/broken/unset status (`routeState`, pure, over `ai.chosen` and the profiles after `withCodemieSignIn`), come from Rust's `choose` through `ai_status`/`ai_settings_save` — the window never resolves a row itself. There is no per-row Test; the paid Test stays on the profile cards. The CodeMie setup sheet opens only after the workspace opens, never over the recovery page (which closes it), and not in the marketplace smoke (`CODEMIE_PLUGIN_SMOKE`), which runs no CodeMie CLI command.

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
- **Services.** `plugins/services/` implements Connect's `ctx`: scoped store and cache, files, `http` (hosts the plugin declared, nothing private), notifications, settings (secrets in the private root), Claude runs (tool-free, or with read or edit tools in a folder the user gave the plugin; a folder whose `.claude/settings.json` or `settings.local.json` names a key or credential helper, or an `env` variable that would send the run elsewhere — `ANTHROPIC_*`, `AWS_*`, `CLAUDE_CODE_USE_*`, proxies, `CLAUDE_CONFIG_DIR` and the like — is refused; telemetry and other `env` pass, `services/claude.rs::refuse_redirecting`), git in those folders (`vault_git.rs`), one web page from an address the user typed (`web.rs`), deliveries to Today, `echo.read`, Microsoft 365 reads (`m365.rs`), events, sign-in (GitHub reads `gh auth token` only after the user presses Sign in), and `tasks` (`services/tasks.rs`: `ctx.tasks.provide`, gated on the `tasks` role below). A service checks the plugin's grants on every call.
- **Client half.** Each plugin UI is an `<iframe sandbox="allow-scripts">` (opaque origin, no `allow-same-origin`) whose `src` is `connect-plugin://<id>/…` (macOS only, R30). Each plugin is its own origin with its own CSP; files come from the plugin's active version only; Connect's shim is served from `__host/`.
- **Bridge rules.** The frame and the window talk over a `MessageChannel` made afresh on each load; messages are versioned, have exactly the documented fields, and anything else is dropped (`ui/plugins/frame/messages.js`). The window never takes a plugin id from a message: the channel names the frame. A frame can call only its own plugin's host-half commands. Inside a frame `__TAURI__` and `__TAURI_INTERNALS__` are absent, `ipc://` fetches fail and `parent.document` throws; `plugins::caller` also refuses `Origin: null` and non-main-page callers in sensitive commands. This is checked by the isolation smoke, not assumed.
- **Permission sheets.** Installing or updating reads the manifest's `uses`, and `capabilities` builds a sheet listing every capability with its Connect status (supported, partial with its limit, unsupported). The user agrees to the sheet; the backend recomputes it and compares `sheetHash`, so an install or update that changed since the sheet was shown is refused and shown again. An update that changes what the plugin asks for needs a new agreement.
- **Roles.** `provides` (`manifest::ROLES`, today just `tasks`) lets a plugin take on a role Connect itself defines, separate from `uses`: a manifest with `provides: ["tasks"]` must also list the feature it needs (`requires: ["tasks_provider"]`, in `manifest`'s `FEATURES`) and gets its own sheet line (`capabilities::role_key("tasks")` → `provides_tasks`, text from `role_text`). Only once the user agreed to that line can the plugin call `ctx.tasks.provide({status, list, changedSince, create, update, complete, remove})` (`plugins/services/tasks.rs::call`); Connect records which of those ops it gave (`services::tasks::ops_of`), forgotten when the plugin unloads (`Services::forget`). `PluginManager` turns every installed, agreed-to, on and loaded plugin with the role into a `workspace::task_provider::TaskProviders` the core calls through (`manager.rs::ManagerTasks`, `PluginManager::available`).
- **Plugin settings.** The window's `set_setting` (`plugins_request`, `plugins/commands.rs::set_setting`) and a plugin's own `ctx.settings.set` both rewrite the same per-plugin files — plain values in `<data>/plugins/data/<id>/settings.json`, `secret` ones only in `<private>/credentials/plugins/<id>/secrets.json` (written `0600`) — behind one lock per plugin store (`plugins/services/settings.rs::WRITES`) so a write between another's read and write never loses a value. A secret is write-only: the window is told only whether it is `set`, never its value; saving or clearing the secret of a plugin that provides tasks and agreed to that role answers `true`, so `set_setting_then_sync` (`plugins/commands.rs`) tells the core (`Core::task_secret_saved`) to lift `needs_token` and queue a sync. A setting named in a plugin's `uses.network.hosts_from` is the user's own address list, set only through `set_addresses`; `extras::extras` deliberately keeps it out of `installed[].settings` (it has its own `addresses` array instead), so it never reads as a plain settable value.

Plugin ids are lowercase (`valid_id`), because they are also URL hosts.

### Where Milestone 2 differs from Echo

Connect implements plugin engine 1.0 (PLUGIN-ENGINE.md §10) and gives plugins what Echo 0.10.1 does (`manifest::ECHO_COMPAT`): `engine` is checked, and a manifest whose `echo` range needs a newer Echo is refused with "needs a newer Connect". Knowledge (`obsidian` 1.0.1 and 1.1.0) runs unmodified on it.

- **Host half, Echo 0.10's members.** `crypto.sha256`; `store.update` and `store.walk`; `fs` writes guarded by `ifSha` or `createNew` (`cas.rs`), `stat`, `search`, `append`, `copyIn`, strict reads and `walk {sha}`, never into a hidden file or a skill (`hidden.rs`); `markdown(md, opts)` and `markdown.links`; `git.info/status/log/show/commit/init`; `web.read` and `http.askAddress` (the address typed in Connect's own box); `claude.run` in a granted folder (`read`, `edit`, or `copy` into a snapshot under the plugin's cache), with keys and `claude.stop`; `system.pickFiles` (handles, never paths); `echo.read('calls' | 'source' | 'me' | 'recording' | 'dictionary')` from Connect's saved meetings and glossary (`workspace/plugin_calls.rs`; a `thread` or `client` filter finds no call, Connect having neither); `echo.read('people')` as Echo 0.10.1's row (`places`, `reports_to`, `reports` and the rest), from who wrote and who was in the meetings, with no place in any thread, so Knowledge 1.1.0's person pages write nothing; `m365.search/mailThread/chat` from synced mail and Teams chats (`workspace/plugin_m365.rs`); events `minutes_written` (after a notes run writes the main notes) and `transcribed` (after a transcript is saved).
- **Client half.** `ctx.claude.session` (Claude Code in Connect's terminal dock, in the folder, as in Echo's panel; started from a clean environment plus the login shell's exports, `commands/terminal.rs::command`), `installSkill/removeSkill` (after Connect's own confirmation, `skills.rs`), `system.reveal`, `onFileDrop`, `ui.sheet`, and `slots`: a meeting's page is Echo's call page (`where().view === 'calls'`); the frame draws `call.header`, `call.menu` and `call.minutes` and the window shows them as text only; a sheet opened while the plugin's page isn't on screen lays its frame over the window; `echo://call/<folder>` opens that meeting. `thread.profile` and `client.profile` are accepted, not drawn.
- **Connect's words and look.** Echo's plugins say "Echo" for the app they run in. The frame reads Connect instead in the plugin's own phrases only: `host_phrases` (`plugins/phrases.rs`) collects the text around each "Echo" in the package's scripts, and the shim rewrites text nodes and `title`/`aria-label`/`placeholder` that match one (`ui/plugins/frame/host-words.js`), never inside text boxes, code or `[contenteditable]`, nor a vault page's own text (Knowledge's `.kn-doc`, `.kn-props`, `.kn-tree`); Settings' summaries use the same words. Files a plugin writes keep its words. Knowledge 1.0.x and 1.1.x also get `skins/obsidian.css`, which restyles its components in Connect's look and is checked against the published `knowledge.css` (`ui/test/knowledge-skin.test.mjs`).
- **Error texts are Echo's words**, which plugins match by regex (`/is there already/`, `/changed since( you read it)?/`, `/not UTF-8/i`, `/hidden/`, `/isn't installed/`, `/isn't connected/`, `/may reach only/`, `/the run's key is busy/`, `/isn't a skill .* added/`); `services/contract_tests.rs` runs each regex against Connect's real message.
- **Still Echo-only.** `sessions`, `channel`, `agent`, `scripts`, `threads`, `view`, `knowledge` and `claude.hasPlugin/installPlugin` are `undefined`, so plugins feature-detect them; `terminal` is `false`. `echo.read('threads')` is `[]`; `threads_changed`, `recording_started` and `recording_stopped` are not sent. A plugin that calls an Echo-only member without a check fails to load with a clear `unsupported:` message (Telegram today; its fix is in the plugin). Page widgets on Today are text only. Deliveries to mail and Teams are held on Today with Copy; Connect never sends them. Knowledge 1.0.x gets Connect's look from `ui/plugins/frame/skins/obsidian.css`, restyling only.

---

## Structure and boundaries

### Rules
- R1. Put Personal Workspace domain code (Microsoft sign-in and sync, records, jobs, meetings, tasks, automations) in `src-tauri/src/workspace/` and reach it from the window through the `workspace_request` command, which hands a typed `Request` to `Core::request`; installer and CLI system calls stay in `src-tauri/src/commands/` (the workspace keeps running while its views are hidden). Evidence: `src-tauri/src/workspace/mod.rs::workspace_request`
- R2. Keep the installer step flow in JS (`ui/engine.js`, `ui/handlers.js`, Option B) and load the legacy installer UI (`ui/renderer.js`) through `initLegacyTools`, which `boot` does for smoke and probe runs and `recoveryAction` for the recovery page's tools; the window's page is `ui/workspace/app.js`, the module `ui/index.html` loads. Evidence: `ui/workspace/app.js::boot`
- R3. Keep Microsoft credentials in Rust: the refresh token is a `Credential` written to `credentials/graph-<connection id>.json` by `cache_path`, and `models::Connection`, which the snapshot carries to the window, holds account and sync fields and no token field. Evidence: `src-tauri/src/workspace/credentials.rs::cache_path`
- R4. Put credentials and plugin secrets under `CorePaths.private`, which a data-folder move leaves in place; movable data goes under `CorePaths.data`. Evidence: `src-tauri/src/workspace/paths.rs::CorePaths`

### Constraints
| Do not | Do instead | Why | Evidence |
|---|---|---|---|
| Add a token or secret field to a snapshot type (`Connection`, `Settings`, `Record`) | Keep it in `workspace/credentials.rs` or the plugin secret store under the private root | the snapshot crosses IPC into the webview | `src-tauri/src/workspace/models.rs::Connection` |
| Move installer Engine orchestration into Rust | Add a thin command in `src-tauri/src/commands/` and call it from the JS handler | Option B keeps the tested Engine and its approval gate in JS | `ui/engine.js::Engine` |

### Read first
| When you are | Exemplar | Why this one | Tests |
|---|---|---|---|
| adding a workspace feature end to end | `src-tauri/src/workspace/tasks.rs::Core.task_op` | newest complete feature: operation dispatch, meeting-folder lock, repository write, history | `src-tauri/src/workspace/tasks.rs::task_delete_returns_the_body_and_save_restores_it` |

---

## Component Responsibilities

| Component | Responsibility | Depends on |
|---|---|---|
| `engine.js` | Step sequencing, approval gates, fatal/non-fatal logic | handlers.js, models.js |
| `handlers.js` | Per-step logic — calls `runner-bridge.js` for system ops | runner-bridge.js |
| `runner-bridge.js` | Tauri `invoke()` / `listen()` wrappers | Tauri IPC |
| `renderer.js` | Legacy installer UI (home/wizard/connect views, Engine construction), loaded by `initLegacyTools` for smoke/probe runs and the recovery tools | engine.js, runner-bridge.js |
| `commands/runner.rs` | `run_capture`, `run_stream`, `run_fresh_env` — login-shell exec | tokio, state.rs |
| `commands/inspector.rs` | `check_git/node/npm/codemie`, `check_profile_status` | runner.rs |
| `commands/runtime.rs` | `runtime_ready`, `ensure_runtime`, `update_cli` — Node from nodejs.org (pinned SHA-256 in runtime.json) into `runtime/node-<v>`, the CLI via `npm ci` with the embedded `assets/codemie-cli` lock into `runtime/cli-<v>`, `node`/`cli` links switched atomically; `update_cli` installs a newer npm release in the background; stale dirs removed at launch; the legacy adapter gates CLI-dependent boot on it | reqwest, sha2, state.rs |
| `state.rs` | `AppState` — PTY handle, remembered PATH dirs, `bundled_injected`, `existing_cli_detected` (the user's own CLI: no download) | pty.rs |
| `error.rs` | `InstallerError` (thiserror) → serializes to String for IPC | — |

## Patterns in use

### Rules
- R1. Send a workspace mutation through `store.mutate`: it runs calls one at a time, sends a new `operationId` UUID with the snapshot's `expectedRevision`, and reads a fresh snapshot afterwards, so the UI renders what native storage kept. Evidence: `ui/workspace/store.js::createStore`
- R2. Add an operation to `REBASE_SAFE` when its outcome does not depend on the revision the person saw; the store then retries it once after `stale_view`, with the same operation id, on the fresh snapshot. Evidence: `ui/workspace/store.js::REBASE_SAFE`
- R3. Keep `view-*.js`, `*-model.js` and `shell.js` pure (state in, HTML string or value out, provider text through `escapeHtml`) so `node:test` can import them; `app.js` reads `document` at import and wires them to the DOM. Evidence: `ui/workspace/shell.js::renderShell`
- R4. Give a new control a `data-action` with its feature's prefix (`task`, `meeting-`, `doc-`, `meetings-settings-`, `cm-`, `plugin`, `automation`) and handle it in that feature's controller, made by a `create…Controller` factory that receives `state`, `snap`, `mutate`, `render` and `toast`; `handle` in `app.js` routes by prefix. Evidence: `ui/workspace/app.js::handle`
- R5. Run a Claude prompt through `Core`'s `Arc<dyn ClaudeRunner>` with a `RunSpec`; `build_command` makes the call headless and tool-free (`--tools ""`, `--strict-mcp-config`, `--no-session-persistence`). Evidence: `src-tauri/src/ai/command.rs::build_command`
- R6. Build a CodeMie CLI command string in `cliCommands` and pass each interpolated value through `assertSafe`, because `run_capture` and `run_stream` hand the string unchecked to `/bin/zsh -lc` or `cmd.exe /c`. Evidence: `ui/workspace/codemie/cli.js::cliCommands`

### Constraints
| Do not | Do instead | Why | Evidence |
|---|---|---|---|
| Call `invoke` from a `view-*.js` renderer | Call the controller, which calls the store or `codemie/service.js` | views stay importable by `node:test` | `ui/workspace/codemie/service.js::createCodemieService` |
| Spawn `claude` with `Command::new` | Go through `ClaudeRunner` (`CliRunner` in the app, `FakeRunner` in tests) | the runner holds the isolation flags, the two-run limit and cancellation | `src-tauri/src/ai/runner.rs::ClaudeRunner` |

### Read first
| When you are | Exemplar | Why this one | Tests |
|---|---|---|---|
| adding a page controller | `ui/workspace/tasks-controller.js::createTasksController` | injected store, render, modal and toast; Undo through `mutate` | `ui/test/tasks-controller.test.mjs::harness` |
| adding a Settings → CodeMie CLI call | `ui/workspace/codemie/service.js::createCodemieService` | `run()` logs to "What CodeMie ran", throws a sentence on a non-zero exit, tells Rust the installer is busy | `ui/test/codemie-service.test.mjs::harness` |

---

## Request flow

Frontend→backend: `invoke('<command_name>', { arg })` via Tauri IPC; the workspace window's invoke is wrapped by `withAppOrigin`.
Backend→frontend: `app.emit("<area>:<event>", payload)` events, e.g. `engine:cmd-line` from `src-tauri/src/commands/runner.rs::run_stream`, and `workspace:analytics` (`{running, done, total, label, failedDays}`, the failed days as `[{day, reason}]`), which the analytics fetch sends after each window it reads and when it ends (`src-tauri/src/workspace/analytics/fetch.rs::Core.emit_progress`).

Commands are registered in `src-tauri/src/lib.rs::run`, inside `plugins::caller::app_page_only(tauri::generate_handler![…])`.

| ✅ DO | ❌ DON'T |
|---|---|
| Call installer system ops via `invoke()` in `runner-bridge.js` (legacy installer) or `codemie/service.js` (Settings → CodeMie) | Import Node/OS APIs directly in frontend JS |
| Add new Rust commands to a module file + register them in `lib.rs` | Move installer Engine orchestration into Rust |
| Use `CmdResult<T>` in `src-tauri/src/commands/` and `workspace::models::Result<T>` in workspace, storage and plugins commands | Return raw `String` errors from commands |

### Rules
- R1. Reach native workspace state with `store.mutate` or `store.query`, which call `invoke('workspace_request', {request})`; `withAppOrigin` adds the page's `Origin` header, which `require_main_frame` checks after Tauri falls back to postMessage. Evidence: `ui/workspace/app-invoke.js::withAppOrigin`
- R2. `workspace_request` runs `require_main_frame(&call)?` first; `Core::request` then answers read-only operations (`snapshot`, `ai_status`, `ai_usage`, `meeting_read`, `meeting_text`, the analytics operations `analytics_status`, `analytics_refresh`, `analytics_retry`, `analytics_view`, `analytics_session`, `analytics_report` and `analytics_app`, …) before it takes the mutation lock and the revision fence. The analytics ones carry no operation id: `analytics_refresh` and `analytics_retry` start the background fetch (one at a time) and answer at once. Evidence: `src-tauri/src/workspace/mod.rs::Core.request`
- R3. A mutation reserves its operation id and bumps the revision in `check_request` before asynchronous work; a repeated id with the same content returns the stored result through `operation_result` instead of running again, and other content under that id is `conflict`. Evidence: `src-tauri/src/workspace/repository.rs::Repository.check_request`
- R4. Queue Claude work as a job keyed by its source (`queue_ai_job` reuses a queued or running job with the same key) that the background loop claims; the operation returns at once and the UI follows the job in the snapshot. Evidence: `src-tauri/src/workspace/ai_jobs.rs::queue_ai_job`
- R5. Branch on `code` of a workspace error in the UI (`stale_view`, `storage_unavailable`, `needs_login`, `validation`, `conflict`) and show `message` as written; `storage_unavailable` from a workspace call opens the recovery page. The Analytics page's errors stay on that page: `needs_cli`, `cli_incompatible` (the CLI answers in a format this Connect doesn't read), `analytics_unavailable` (its files in `<data root>/analytics/` can't be read or written), `cli_failed` and `timeout`. Evidence: `ui/workspace/app.js::watched`

### Constraints
| Do not | Do instead | Why | Evidence |
|---|---|---|---|
| Await Graph or Claude inside a synchronous mutation | Queue a job and return | the mutation lock holds the person's other edits behind it | `src-tauri/src/workspace/mod.rs::Core.request` |

### Read first
| When you are | Exemplar | Why this one | Tests |
|---|---|---|---|
| tracing a workspace request end to end | `src-tauri/src/workspace/mod.rs::Core.request` | read-only answers, mutation lock, revision fence, dispatch, operation result | `src-tauri/src/workspace/mod.rs::runtime_io_failure_reports_storage_unavailable` |

---

## Error Handling Pattern

`InstallerError` (thiserror) is the error type of the installer commands in `src-tauri/src/commands/`. It serializes to a plain String so the frontend receives a readable message — mirrors the Electron app's `throw new Error(msg)` pattern. Workspace, storage and plugins commands return `WorkspaceError` (`code`, `message`, optional `retry_after`, `class`, `field`) instead.

- Definition: `src-tauri/src/error.rs::InstallerError`
- Alias: `pub type CmdResult<T> = Result<T, InstallerError>` — `src-tauri/src/error.rs::CmdResult`
- Usage: fallible commands return `CmdResult<T>`; infallible ones return `T` directly

---

## State Pattern

`AppState` is managed via Tauri's `manage()` call in `src-tauri/src/lib.rs::run` and injected into commands via `State<'_, AppState>`; `WorkspaceState` (the opened `Core`) and `PluginManager` are managed the same way.

- `remembered` — `Vec<String>` of PATH dirs discovered during the session; used by `run_fresh_env` so a just-installed binary is found without restart
- `pty` — `Option<(String, PtyHandle)>`: the active pseudo-terminal and its id

Reference: `src-tauri/src/state.rs::AppState`

---

## Extension points

1. Create or extend a file in `src-tauri/src/commands/` (installer and CLI system ops) or in the owning module (`workspace/`, `storage/`, `plugins/`).
2. Annotate the function with `#[tauri::command]`.
3. Return `T` (infallible) or `CmdResult<T>` (fallible) in `commands/`; `workspace::models::Result<T>` elsewhere.
4. Register it in `lib.rs` `run`, inside the `generate_handler!` list that `app_page_only` wraps.
5. Call it from JS: `runner-bridge.js` for the legacy installer, `codemie/service.js` for Settings → CodeMie, the store for workspace data.
6. Add a unit test in the same Rust module under `#[cfg(test)]`.

### Rules
- R1. Make `require_main_frame(&call)?;` the first statement of a command that reads or changes workspace, plugin or data-folder state, and list it in `every_guarded_command_checks_its_caller_first`, which checks `storage/commands.rs`, `workspace_request` and `plugins/commands.rs`. Evidence: `src-tauri/src/plugins/caller.rs::require_main_frame`
- R2. Add a workspace operation as a variant of `models::Operation` (sent in snake_case), dispatch it in `Core::request` (a read-only one before the mutation lock), and add it to `REBASE_SAFE` in `store.js` when its outcome does not depend on the revision the person saw. Evidence: `src-tauri/src/workspace/models.rs::Operation`
- R3. Route a plugin `ctx` service in `HostServices for Services` and check the agreed `uses` key with `Granted::needs` before acting; a plugin's own checks are no protection. Evidence: `src-tauri/src/plugins/services/mod.rs::Granted.needs`

### Read first
| When you are | Exemplar | Why this one | Tests |
|---|---|---|---|
| adding a data-folder command | `src-tauri/src/storage/commands.rs::storage_status` | caller check, main-window check, blocking work off the async runtime | `src-tauri/src/plugins/caller.rs::every_guarded_command_checks_its_caller_first` |

---

## Configuration

| Config | Location | Access |
|---|---|---|
| Install steps | `config/steps.yaml` (macOS) and `config/steps-windows.yaml` (Windows), embedded via `include_str!` | `src-tauri/src/steps.rs::get_steps` |
| Smoke mode flags | `CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE`, `CODEMIE_PLUGIN_SMOKE`, `CODEMIE_STATUS_SMOKE`, `CODEMIE_TOUR` (the stops to run: `all`, rollout steps, or stop ids), `CODEMIE_TOUR_SHA` (the build's git SHA, named in the report) env vars | read by `src-tauri/src/commands/smoke.rs::smoke_mode`; the plugin and status smokes start in `src-tauri/src/lib.rs::run`; `CODEMIE_TOUR`/`CODEMIE_TOUR_SHA` are read by `src-tauri/src/commands/tour/mod.rs::requested`, behind the `tour` Cargo feature that only `make tour` turns on |
| Session log | `~/Library/Logs/CodeMie/codemie_wizard.log` (Windows: `%USERPROFILE%\AppData\Local\CodeMie\Logs`) | `src-tauri/src/commands/logger.rs::log_path` |
| Pinned runtime | `runtime.json` (Node version and SHA-256s, CLI package and version) | `scripts/stage-runtime.sh`, `build-installer.sh`; the app embeds `assets/codemie-cli/package.json` and `package-lock.json` (`src-tauri/src/commands/runtime.rs::CLI_PACKAGE_LOCK`) |
| Test data folder | `CODEMIE_WORKSPACE_TEST_DIR` (debug builds) | `src-tauri/src/lib.rs::run` |

## Examples

### A workspace operation

Source: `src-tauri/src/workspace/tasks.rs::Core.task_op`

```rust
    pub(in crate::workspace) fn task_op(&self, req: &Request) -> Result<Value> {
        let (w, _) = self.active_workspace(req, false)?;
        // Same order as the other meeting-folder writers: their lock, then the repository.
        let _folders = self.meeting_lock();
        let mut r = self.repo()?;
        match req.op {
            Operation::TaskSave => {
                let mut data = req.data.clone();
                if let (Some(fields), Some(op)) = (data.as_object_mut(), &req.operation_id) {
                    // A new task takes the operation's id, so a retried request makes one task.
                    if fields.get("id").is_none_or(Value::is_null) {
                        fields.insert("id".into(), op.clone().into());
                    }
                }
                let task = task_save(&mut r, &w.id, &data, now())?;
                Ok(json!({"id": task.id}))
            }
            Operation::TaskDelete => {
                let id = required(&req.data, "id", ID_MAX)?;
                let body = task_delete(&mut r, &w.id, id)?;
```

### A serialized mutation

Source: `ui/workspace/store.js::createStore.mutate`

```js
  function mutate(op, data = {}, workspaceId, { retry = REBASE_SAFE.has(op) } = {}) {
    const run = async () => {
      if (!state) await refresh();
      const operationId = crypto.randomUUID();
      const send = () => invoke('workspace_request', {
        request: {
          op,
          data,
          workspaceId: workspaceId ?? state.snapshot.settings.activeWorkspace,
          expectedRevision: state.snapshot.revision,
          operationId,
        },
      });
      try {
        // A background sync moved the revision. Rebase onto the fresh snapshot with the same
        // operation ID; a sync writing record after record can move it again in between, so a
        // few times. A refused attempt reserves nothing natively.
        for (let attempt = 1; ; attempt++) {
          try {
            return await send();
```

## Common pitfalls

| Symptom | Cause | Fix | Evidence |
|---|---|---|---|
| A save fails with `stale_view` right after a background sync | the sync bumped the revision and the operation is not in `REBASE_SAFE` | refresh and let the person review, or add the operation to `REBASE_SAFE` when its outcome does not depend on what they saw | `ui/workspace/store.js::REBASE_SAFE` |
| A command is refused when called from a plugin page or with no `Origin` | `require_main_frame` accepts Connect's own page origin only | call it from Connect's page through the `withAppOrigin` invoke | `src-tauri/src/plugins/caller.rs::require_main_frame` |
| A bundle builds with `errors: 0` but Node cannot resolve its files | a glob key in `bundle.resources` flattens the tree onto file names | map each source to its target; `tests/bundle_resources.rs` checks the map | `src-tauri/tests/bundle_resources.rs::resources_map` |
| A plugin call fails with a permission error although the plugin asked for it | the person did not agree to that `uses` key on the permission sheet | update the plugin and agree to the new sheet | `src-tauri/src/plugins/services/mod.rs::Granted.needs` |

## Quick reference

| Task | Do | Where |
|---|---|---|
| Add a workspace operation | variant in `Operation`, dispatch in `Core::request`, decide `REBASE_SAFE`, test with `mutation` | `src-tauri/src/workspace/models.rs::Operation` |
| Add an installer or system command | function in `commands/`, register in `run`, wrapper in `runner-bridge.js` | `src-tauri/src/lib.rs::run` |
| Add a Settings → CodeMie CLI call | command string in `cliCommands`, run through `run()` in the service | `ui/workspace/codemie/cli.js::cliCommands` |
| Add a plugin ctx service | route it in `HostServices for Services`, check `Granted::needs` | `src-tauri/src/plugins/services/mod.rs::Granted.needs` |
| Add a task provider | its manifest declares `provides: ["tasks"]` and `requires: ["tasks_provider"]`, agrees to the `provides_tasks` sheet line, and calls `ctx.tasks.provide({status, list, changedSince, create, update, complete, remove})`; Connect reaches it through `TaskProviders`, caches and queues its changes through `task_provider::outbox` / `task_provider::sync` | `src-tauri/src/plugins/services/tasks.rs::call` |
| Read the plugin host design | packages, host half, client half, limits | `prototypes/milestone-2/DESIGN.md` § 7. Plugin host |
| Read the meetings design | transcript states, folder and files, templates | `docs/superpowers/specs/2026-11-17-meetings-transcripts-tasks-design.md` § Transcript states |