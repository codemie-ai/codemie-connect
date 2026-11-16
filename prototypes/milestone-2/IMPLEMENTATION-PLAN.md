# Milestone 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude-drafted Outlook and Teams replies, summaries and automations, run on the user's own Claude subscription or a CodeMie profile. An Echo-compatible plugin host, proven with the four published Echo plugins. A user-chosen data folder. Workspaces hidden.

**Architecture:** New Rust modules:
- `ai/`: profile discovery and an isolated, tool-free CLI runner behind a `ClaudeRunner` trait.
- `storage/`: the data-folder pointer, validation and moves.
- `plugins/`: manifest, marketplaces, registry, per-plugin QuickJS runtimes, services, the `connect-plugin://` scheme and a `PluginManager`.

The workspace module gains draft, summary and automation jobs on the runner. The UI gets:
- new Settings panels and an Automations page, with testable logic moved into pure modules;
- a main-window plugin bridge;
- a sandboxed, opaque-origin frame per plugin with an Echo-compatible `pluginCtx`.

**Tech Stack:**
- Tauri 2.12.6 (lockfile).
- Rust: tokio, rusqlite, reqwest and fs2. New: rquickjs, pulldown-cmark, tauri-plugin-dialog, tokio-util, semver, libc and dunce, plus the `tauri` `test` feature as a dev-dependency.
- Vanilla ES modules.
- Tests: `node:test`, and playwright-core browser E2E against a mocked bridge.
- CLIs: Claude Code ≥ 2.1.322, CodeMie CLI `codemie-claude`.

**Spec:** [DESIGN.md](DESIGN.md). Read it first; § numbers below refer to it. Knowledge is out of scope; see [KNOWLEDGE.md](KNOWLEDGE.md).

## Global Constraints

- **TDD for every task.** Write the listed tests, run them and see them fail, implement, run them and see them pass, then commit. Each "Tests" list names the tests and their key assertions.
- **Rust and Tauri.** Rust commands run from `src-tauri/`. New Tauri commands are registered in `src-tauri/src/lib.rs` `invoke_handler`.
- **Commits.** Use conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`) with no ticket. End each one with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never add `Makefile` or `prototypes/validation/`. Push only when the owner asks.
- **Gates.**
  - At the end of each phase: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test` and the browser E2E.
  - `./build-installer.sh --skip-stage` must pass at the end of Phases 1, 3, 5 and 6.
  - Loopback, PTY, `hdiutil`, native smoke and live tests run outside the sandbox.
- **Testing on real accounts.**
  - **No sends, Teams posts or calendar writes during testing, and no approving consent prompts.**
  - A live AI run on the owner's real messages needs the owner's yes at that step.
  - Automated tests use only synthetic fixtures (`ui/test/fixtures/`, Rust `tempfile`).
- **No copied Echo code.** Code written by Echo's maintainer (`jshost.rs`, `plugins.rs`, `33-plugins-client.js`, `ai.rs`, `claudejob.rs`, `guard.rs`) may be read to match behaviour but never copied. The vendored third-party MIT libraries (Sigma, graphology) are fine with their licences.
- **No plugin source in this repo.** Conformance tests read real plugins from `CONNECT_ECHO_PLUGINS_DIR` (default `/Users/Vadym_Vlasenko/.codex/worktrees/knowledge-plugin-0300/echo-plugins`) and skip with a message when it is absent. Unit tests use synthetic plugins under `ui/test/fixtures/plugins/` and Rust `tempfile`.
- **Verbatim command.** The isolated-run arguments in DESIGN §6.2 are copied verbatim into the command builder and its snapshot test.
- **UI testability.** `ui/workspace/app.js` touches `document` at import, so logic that needs unit tests goes into pure modules that `app.js` imports.
- **UI design.** Follow `prototypes/milestone-1/CODEMIE-DESIGN-SPEC.md` in light and dark. Check every new screen at 1000, 1440 and 1680 px. Icons come from `ui/workspace/icons.js`; add an icon there before using a new name.
- **Read-only references:**
  - plugins: `/Users/Vadym_Vlasenko/.codex/worktrees/knowledge-plugin-0300/echo-plugins`
  - plugin API: `/Users/Vadym_Vlasenko/.codex/worktrees/knowledge-plugin/echo/.ai-run/reference/plugins/plugin-api.md`
  - mockups: `/Users/Vadym_Vlasenko/AI/projects/other/echo/future/mockups/{inbox,automations,settings}.html`
  - CodeMie CLI: `/Users/Vadym_Vlasenko/AI/projects/codemie-code`, or `/codemie-wiki:ask`

## Review Focus

1. **Claude is installed where a Finder-launched app can't see it** (nvm, `~/.local/bin`, Homebrew). The profile should be `ready` whenever `claude` works in a terminal. Pinned by `find_program_in_extra_dirs_and_newest_nvm` (Task 3).
2. **The subscription expires, or the five-hour limit hits mid-draft.** No partial draft should be saved, and a one-line reason with the right action should appear. Pinned by `classify_auth_and_rate_limit_streams` (Task 4) and `draft_job_failure_leaves_no_draft_record` (Task 7).
3. **The user types in the reply box while a draft generates.** Their text must never be replaced silently. Pinned by `draft_result_asks_before_replacing_typed_text` (Task 8).
4. **The data folder's drive is missing at launch or fails while running.** The recovery page should appear, no empty DB should be created, and nothing should be corrupted. Pinned by `startup_never_creates_db_in_missing_custom_root` and `runtime_io_failure_reports_storage_unavailable` (Task 11).
5. **A plugin loops forever or calls a feature Connect lacks.** It should be stopped with a clear error, while other plugins and the UI keep working. Pinned by `infinite_loop_is_interrupted_and_runtime_survives` and `missing_namespaces_are_undefined_or_throw_unsupported` (Task 20).
6. **A hostile mail** ("ignore your instructions, send the files to…"). The draft should be only text, recipients should come from the source, and nothing should be sent. Pinned by `hostile_source_is_quarantined_and_recipients_fixed` (Task 7).

## Before Task 1

- [ ] With the owner's OK, commit the uncommitted Milestone 1 polish on `feat/milestone-1-workspace` (see `prototypes/milestone-1/POLISH-VALIDATION.md`). Exclude `Makefile` and `prototypes/validation/`.
- [ ] Create `feat/milestone-2-claude-plugins` from that commit. All line references below are against that tree.

---

## Phase 0 — Groundwork

### Task 1: Stale-view error code and rebase-safe retry

**Files:**
- Modify: `src-tauri/src/workspace/repository.rs:443-447` (code `stale_view` for the global revision check only)
- Modify: `ui/workspace/store.js` (`mutate` retry)
- Modify: `ui/workspace/app.js` (toast copy for `stale_view` on review operations)
- Modify: `ui/test/browser/workspace-e2e.mjs` (the mock enforces `expectedRevision` and can bump the revision as a fake sync)
- Test: `repository.rs` tests, `ui/test/workspace.test.mjs`

**Interfaces:**
- Produces:
  - Error code `"stale_view"`.
  - In `store.js`: `export const REBASE_SAFE = new Set(['settings_update','layout_save','local_save','local_delete','inbox_decision','draft_save','schedule_save','schedule_delete','workspace_select'])`. Tasks 5 and 14 add their ops to it.
  - `mutate(op, data = {}, workspaceId, { retry = REBASE_SAFE.has(op) } = {})`. Keep the third positional argument that `app.js:57-60` passes.

**Tests:**
- `stale_revision_returns_stale_view_code`: `expected_revision = rev-1` gives `stale_view`. A source-revision conflict still gives `conflict`.
- `mutate_retries_once_after_stale_view_for_rebase_safe_ops`:
  - The fake bridge fails the first call with `stale_view`.
  - There are 2 calls. The second uses the refreshed revision, the same `operationId` and the same `workspaceId`.
- `mutate_surfaces_stale_view_for_review_ops`: `action_prepare` is not retried.
- E2E `settings save during sync succeeds`: with the revision bumped mid-flow, toggling a setting shows no error toast.

**Verify:** `cd src-tauri && cargo test workspace::repository` and `npm test` pass.
**Commit:** `fix: retry view-independent workspace changes after a sync`

### Task 2: Hide Workspaces, pin Personal, pause hidden workspaces

**Files:**
- Create: `ui/workspace/shell.js` (`renderShell(state)` and `NAV`, moved out of `app.js`) and `ui/workspace/boot.js` (`bootWorkspace(store, snapshot)`)
- Modify: `ui/workspace/app.js`:
  - remove the `workspaces` route (`:15`), nav entry (`:95`), topbar dot and `#workspace-select` (`:111-112`), render branch (`:211`), import (`:13`), `workspaceDialog` (`:327-340`) and handlers (`:740-746`, `:831-839`)
  - change "this workspace" copy at `:676`
  - call `bootWorkspace`
- Modify: `ui/workspace/view-settings.js` (delete `workspaces()` at `:263-279`), `ui/workspace/view-today.js:14,79` (copy)
- Modify: `src-tauri/src/workspace/mod.rs` (`materialize_schedules` at `:1166` and `refresh_incidents` at `:1353` skip non-personal workspaces while `WORKSPACES_HIDDEN` is `true`)
- Modify: `ui/test/workspace.test.mjs:16,332`, `ui/test/browser/workspace-e2e.mjs:330-338`
- Modify: `.ai-run/guides/architecture/architecture.md:12`, `.ai-run/guides/testing/testing-patterns.md:27`

**Interfaces:**
- Produces:
  - `export function renderShell(state) -> string` and `export const NAV`.
  - `export async function bootWorkspace(store, snapshot)`, which calls `store.mutate('workspace_select', { id: 'personal' })` only when `snapshot.settings.activeWorkspace !== 'personal'`.
  - `pub(crate) const WORKSPACES_HIDDEN: bool = true;`

**Tests:**
- `shell_has_no_workspaces_entry_or_switcher`
- `boot_selects_personal_when_another_workspace_is_active`: one call, payload `{ id: 'personal' }`.
- `boot_does_nothing_when_personal_is_active`
- Rust `hidden_workspaces_schedules_and_incidents_pause`: a reminder in the `atlas` workspace does not materialise; one in Personal does.
- E2E `no workspaces UI`: in both themes.

**Verify:** `npm test`, `cargo test workspace::` and the browser E2E pass.
**Commit:** `feat: hide workspaces until they are redesigned`

---

## Phase 1 — Claude foundation

### Task 3: Program discovery and AI profile detection

**Files:**
- Create: `src-tauri/src/ai/mod.rs`, `src-tauri/src/ai/discover.rs`, `src-tauri/src/ai/profiles.rs`
- Modify: `src-tauri/src/commands/codemie_config.rs` (list every profile with name, provider, model and haiku/sonnet/opus models; never secrets)
- Modify: `src-tauri/src/lib.rs` (`mod ai;`)

**Interfaces:**
- Produces:
  - `pub fn find_program_in(name: &str, path_var: &str, home: &Path, extra: &[PathBuf]) -> Option<PathBuf>`. It is pure and tested. The search order is the one in DESIGN §6.1, then `extra`.
  - `pub fn find_program(name: &str, extra: &[PathBuf]) -> Option<PathBuf>`, which reads PATH and HOME.
  - `pub enum ProfileKind { Native, CodeMie { name: String } }`
  - `pub struct AiProfile { id, kind, label, state: ProfileState, version: Option<String>, account: Option<AccountInfo>, models: Vec<ModelChoice>, default_model: Option<String>, message: Option<String> }`
  - `pub enum ProfileState { Ready, NotInstalled, TooOld, NeedsLogin, NotConfigured, Checking, Error }`
  - `AccountInfo { plan, email, org, method }`, kept in memory only and never logged.
  - `pub struct ProfileCache` with `pub async fn profiles(&self) -> Vec<AiProfile>` (30 s cache, 10 s after a failure) and `invalidate()`.
  - `pub const REQUIRED_FLAGS: &[&str]`: every flag in DESIGN §6.2.
  - Pure parsers: `parse_version`, `parse_auth_status`, `missing_flags(help) -> Vec<&str>`, `codemie_profiles(&Value)`.

**Tests:**
- `find_program_in_extra_dirs_and_newest_nvm`:
  - With an empty PATH, `~/.local/bin/claude` wins.
  - Without it, nvm `v22.3.0` beats `v20.1.0`.
  - A non-executable file is ignored.
- `parse_version_reads_claude_code_line`
- `auth_status_maps_logged_in_subscription_and_logged_out`: plan "Max", `NeedsLogin`, `Error` for non-JSON.
- `missing_required_flag_marks_too_old_and_names_it`
- `codemie_profiles_lists_names_and_models_without_secrets`

**Verify:** `cargo test ai::` passes.
**Commit:** `feat: detect Claude Code and CodeMie profiles for AI features`

### Task 4: Isolated runner behind a `ClaudeRunner` trait

**Files:**
- Add dependencies: `tokio-util` (CancellationToken), `libc` (killpg)
- Create: `src-tauri/src/ai/command.rs`, `src-tauri/src/ai/stream.rs`, `src-tauri/src/ai/runner.rs`, `src-tauri/src/ai/fake.rs` (`#[cfg(test)]` and test helpers)
- Create: `src-tauri/src/ai/testdata/*.jsonl` (synthetic streams)

**Interfaces:**
- Consumes: `AiProfile`, `find_program` (Task 3).
- Produces:
  - `pub struct RunSpec { purpose: String, profile_id: String, model: Option<String>, system: String, input: Value, schema: Option<Value>, timeout: Duration, cap_usd: Option<f64>, staging_root: PathBuf }`
  - `pub fn build_command(spec: &RunSpec, profile: &AiProfile, bin: &Path, cwd: &Path) -> CommandPlan { program, args, env_remove, env_set }`
  - `pub enum RunEvent { Started { version, model }, RateLimit { status, kind }, Progress { elapsed_ms } }`
  - `pub struct RunOutcome { structured: Option<Value>, text: String, usage: Usage, cost_usd: Option<f64>, duration_ms: u64, model: Option<String> }`
  - `pub struct AiError { class: ErrorClass, message: String }`, with `ErrorClass` as in DESIGN §6.2.
  - `#[async_trait] pub trait ClaudeRunner: Send + Sync { async fn run(&self, spec: RunSpec, profile: &AiProfile, cancel: CancellationToken, on_event: Box<dyn Fn(RunEvent) + Send>) -> Result<RunOutcome, AiError>; }`. If `async_trait` is not wanted, return a boxed future instead.
  - `pub struct CliRunner`: semaphore of 2, `process_group(0)`, TERM→3 s→KILL via `libc::killpg` on cancel, timeout or drop, a 1 MB stdout cap, and a fresh `staging_root/<uuid>` that is removed afterwards.
  - `pub struct FakeRunner` (scripted outcomes, records specs).
  - `pub fn parse_stream(lines) -> Result<RunOutcome, AiError>`

**Tests:**
- `build_command_native_isolated_matches_design`: exact vector, with and without `--json-schema`/`--model`. `env_remove` includes `ANTHROPIC_API_KEY`.
- `build_command_codemie_puts_wrapper_options_first`: ANTHROPIC_* are not removed.
- `parse_stream_success_with_structured_output`
- `parse_stream_tolerates_non_json_lines`
- `classify_auth_and_rate_limit_streams`:

  | Input | Expected class |
  |---|---|
  | "Not logged in · Please run /login" | `NeedsLogin` |
  | CodeMie "Authentication required" | `NeedsLogin` |
  | "Configuration incomplete" | `NotConfigured` |
  | `rate_limit_event` with `status:"rejected"` | `RateLimited` |
  | `is_error:true` | `Failed` |

- `run_cancel_kills_process_group`: a fake script `sleep 30 & wait`. Cancel after 200 ms gives `Cancelled` within 4 s, and both pids are gone.
- `run_timeout_reports_timeout`
- `run_output_cap_discards_oversize`
- `#[ignore] live_native_isolated_run` and `#[ignore] live_codemie_isolated_run`:
  - Each runs a real one-word prompt and asserts `structured.draft` is non-empty.
  - They also record whether `stream-json` carried `structured_output`. If it didn't, switch to `--output-format json` (DESIGN §6.2) and update the snapshot.

**Verify:** `cargo test ai::` passes. Then, outside the sandbox and with the owner's OK for two one-word prompts:
```bash
cd src-tauri && cargo test ai::runner::live -- --ignored --nocapture
```
Expected: both pass.
**Commit:** `feat: run Claude headless and tool-free on a subscription or CodeMie profile`

### Task 5: AI settings, routing, usage ledger and migration (backend)

**Files:**
- Add a dev-dependency: `tauri` with `features = ["test"]`
- Modify: `src-tauri/src/workspace/models.rs` (`Operation::{AiStatus, AiSettingsSave, AiTest, AiUsage}`; `Settings.ai: AiSettings`)
- Modify: `src-tauri/src/workspace/mod.rs`:
  - `Core.runner: Arc<dyn ClaudeRunner>` and `Core.profiles: ProfileCache`
  - `AiStatus` and `AiUsage` return before `check_request`, like `snapshot`
  - `AiTest` joins the non-synchronous list at `:454-463`, replacing `AiProbe`
  - a test helper `test_core(dir, runner) -> Arc<Core>` using `tauri::test::mock_app()`
- Modify: `src-tauri/src/workspace/repository.rs` (record kind `ai_run`; drop `aiProfile`/`claude-api` on open)
- Modify: `src-tauri/src/workspace/ai.rs` (delete `ai_probe`, `REQUIRED_FLAGS` and the `--bare` command; `ai_draft` returns `ai_unavailable` until Task 7)
- Modify: `ui/workspace/app.js:698-717`, `ui/workspace/view-settings.js:78`, `ui/workspace/view-inbox.js:137` (remove the old Pin/Check/Draft with AI/Load AI draft controls)
- Modify: `ui/workspace/store.js` (add `ai_settings_save` to `REBASE_SAFE`)

**Interfaces:**
- Produces:
  - `pub struct AiSettings { default_profile: Option<String>, routes: BTreeMap<Purpose, Route> }` with `Route { profile: Option<String>, model: Option<String> }`
  - `enum Purpose { MailDraft, ChatDraft, Summary, Automation, Plugin }` (snake_case)
  - `fn resolve_route(settings, profiles, purpose) -> Result<(AiProfile, Option<String>), AiError>`:
    - no default and no route → `AiError { class: NeedsChoice }`, a new class shown as the first-use chooser
    - an unready profile → its state
  - `Core::record_ai_run(purpose, &Result<RunOutcome, AiError>, ref_id)`
  - Ops:

    | Op | Input | Output |
    |---|---|---|
    | `ai_status` (read) | — | `{profiles, settings}` |
    | `ai_settings_save` | `{defaultProfile, routes}` | — (ids and models validated) |
    | `ai_test` | `{profileId, model?}` | `{ok, ms, costUsd, model}` |
    | `ai_usage` (read) | `{month}` | `{runs, costUsd, byProfile}` |

**Tests:**
- `resolve_route_without_choice_needs_choice`
- `resolve_route_uses_route_then_default`
- `resolve_route_unready_profile_errors_with_state`
- `ai_settings_save_rejects_unknown_profile_and_model`
- `ai_status_and_usage_need_no_operation_id`
- `ai_test_runs_with_fake_runner_and_records_ai_run`
- `open_migrates_claude_api_pin_away`
- `ai_usage_sums_month_by_profile`
- JS `old_ai_pin_controls_are_gone`

**Verify:** `cargo test workspace::` and `npm test` pass.
**Commit:** `feat: route AI work to a chosen Claude profile and record usage`

### Task 6: Settings → Claude page and first-use chooser

**Files:**
- Create: `ui/workspace/settings-ai.js` (`aiPanel(ai)`, pure) and `ui/workspace/ai-chooser.js` (`chooserBody(profiles)`, pure)
- Modify: `ui/workspace/view-settings.js`:
  - add tab `['', 'ai', 'Claude', 'spark']` after `general`
  - rename the `tools` label to `Coding agents`
  - the AI row on the General tab links to `ai`
- Modify: `ui/workspace/app.js`:
  - load `ai_status` when the tab opens
  - handlers `ai-test`, `ai-default`, `ai-route`, `ai-copy-login`
  - `ensureClaudeChoice()`: opens the chooser when an AI op fails with `needs_choice`
- Modify: `ui/workspace/workspace.css`, `ui/test/fixtures/workspace-fixture.mjs` (`aiStatus(kind)` presets `none`, `native`, `native_needs_login`, `codemie_only`, `both`)

**Interfaces:**
- Consumes: Task 5 ops.
- Produces hooks:
  - profile cards and testing: `[data-ai-profile]`, `[data-action="ai-test"][data-profile]`
  - default and routes: `select[name="ai-default"]`, `select[data-route][data-field="profile|model"]`
  - usage: `#ai-usage`
  - chooser: `[data-action="ai-choose"][data-profile]`

**Page content (DESIGN §6.1):**
- A native card: state chip, version, plan, signed-in email, model select, and Test with its result. When the state is NeedsLogin, it shows "Open Terminal and run `claude`, then type `/login`" with a Copy button.
- One card per CodeMie profile.
- The Default select, and a "Use for" table with five rows.
- This month's runs and cost.
- The privacy note.

**Tests:**
- `ai_panel_renders_each_state`
- `ai_panel_escapes_profile_names`
- `chooser_lists_only_ready_profiles_with_privacy_note`
- E2E `settings claude page`:
  - Test shows "OK · 2.1 s".
  - Changing the default calls `ai_settings_save`.
  - Both themes; no overflow at 1000 px.

**Verify:** `npm test` and the browser E2E pass. In the release build on the owner's Mac, the page shows "Claude Code · Ready · Max". Then run `./build-installer.sh --skip-stage`.
**Commit:** `feat: choose Claude Code or a CodeMie profile in Settings`

---

## Phase 2 — Drafting and summaries

### Task 7: Draft and summary jobs (backend)

**Files:**
- Modify: `src-tauri/src/workspace/ai.rs` (rewrite on `ClaudeRunner`)
- Create: `src-tauri/src/workspace/prompts.rs` (system prompts, schemas, sanitiser)
- Create: `src-tauri/src/workspace/slots.rs` (free slots, matching `ui/workspace/calendar-model.js` `freeSlots`)
- Modify: `src-tauri/src/workspace/models.rs` (the new `AiDraft` payload; `Operation::AiSummarize`)

**Interfaces:**
- Consumes: `ClaudeRunner`, `resolve_route`, `record_ai_run`, `test_core` (Tasks 4-5).
- Produces:
  - Op `ai_draft`:
    - Input: `{sourceId, intent: "reply"|"acknowledge"|"decline"|"ask"|"propose_times", tone: "neutral"|"friendly"|"formal", length: "short"|"medium"|"detailed", instructions?: string (≤ 1000), includeFreeTimes: bool}`
    - Returns `{queued, jobId}`.
    - The job writes a `draft` record `{text, questions, sourceId, conversationKey, aiSuggested: true, provenance: {profile, model, durationMs, costUsd, messageIds, at}}`.
  - Op `ai_summarize {sourceId}`: a job that writes a `summary` record `{conversationKey, text, asks: [{text, due?}], sourceRevision, provenance}`.
  - `pub fn draft_context(repo, source, me: &Connection, opts: &DraftOptions, now, zone) -> DraftInput`
  - `pub fn sanitize_line(s, cap) -> String`
  - `pub fn free_slots(events, day_start_min, day_end_min, days, min_len, zone, now) -> Vec<(i64, i64)>`
  - Prompts and schemas: `DRAFT_SYSTEM_MAIL`, `DRAFT_SYSTEM_TEAMS`, `SUMMARY_SYSTEM`, `DRAFT_SCHEMA`, `SUMMARY_SCHEMA`.

**Tests:**
- `draft_context_takes_newest_twelve_in_order_and_caps_text`
- `sanitize_line_replaces_angle_brackets_and_controls`
- `hostile_source_is_quarantined_and_recipients_fixed`:
  - The injected text appears only inside `<message>`.
  - The system prompt contains the quarantine sentence.
  - The `draft` record has no recipient field.
  - `action_prepare` later takes recipients from the source.
- `free_slots_skip_busy_and_past_and_respect_working_hours`: includes a DST day in Europe/Kyiv.
- `draft_job_with_fake_runner_writes_draft_with_provenance`
- `draft_job_failure_leaves_no_draft_record`
- `draft_job_conflicts_when_source_changes_mid_run`
- `summary_marks_stale_when_new_message_arrives`

**Verify:** `cargo test workspace::` passes.
**Commit:** `feat: draft Outlook and Teams replies and summarize threads with Claude`

### Task 8: Inbox composer and Today "Draft reply"

**Files:**
- Create: `ui/workspace/draft-state.js` (pure)
- Modify: `ui/workspace/view-inbox.js`:
  - Draft with AI button and options popover
  - running row with Stop
  - provenance line and questions list
  - Regenerate and Restore my text
- Modify: `ui/workspace/view-today.js` (Draft reply on attention rows)
- Modify: `ui/workspace/app.js`:
  - handlers `ai-draft`, `ai-draft-stop` (via `job_cancel`), `ai-draft-regenerate`, `ai-draft-restore`, `ai-draft-options`
  - options remembered in `localStorage` under `codemie.draft.options.<channel>`
- Modify: `ui/workspace/selectors.js` (`draftJob(snapshot, key)`, `latestDraft(snapshot, key)`), `ui/workspace/workspace.css`

**Interfaces:**
- Produces:
  - `export function applyDraftResult({ current, dirty, result }) -> { action: 'fill'|'confirm', text }`
  - `export function restoreText(state) -> string`
  - Hooks:
    - options popover: `[data-action="ai-draft"]`, `#draft-options`, `[data-draft-intent|tone|length]`, `#draft-instructions`, `#draft-free-times`
    - running and result: `.ws-draft-running`, `.ws-draft-provenance`, `[data-action="ai-draft-stop|ai-draft-restore"]`
    - Today rows: `[data-action="draft-reply"][data-key]`

**Tests:**
- `reply_box_offers_draft_with_ai_or_set_up_claude`
- `running_draft_shows_profile_model_and_stop`
- `draft_result_fills_empty_box_and_shows_provenance`
- `draft_result_asks_before_replacing_typed_text`: "Keep mine" leaves the text unchanged; "Replace" swaps it, and Restore brings it back.
- `each_error_class_shows_its_sentence_and_action`
- `today_draft_reply_opens_inbox_and_starts_draft`
- E2E `ai draft flow`:
  1. Draft on a Teams chat with Propose times + Friendly.
  2. The mocked job completes and the text appears.
  3. Review & send opens the review dialog.
  4. Cancel: no `action_confirm` call.

  Run it in both themes.

**Verify:** `npm test` and the browser E2E pass.
**Commit:** `feat: draft replies with Claude from Inbox and Today`

### Task 9: Thread summary card

**Files:**
- Modify: `ui/workspace/view-inbox.js`, `ui/workspace/app.js`, `ui/workspace/selectors.js` (`summaryFor`), `ui/workspace/workspace.css`

**Interfaces:**
- Produces hooks: `[data-action="ai-summarize"]`, `.ws-summary`, `[data-action="summary-ask-commit"][data-index]`.

**Tests:**
- `summarize_button_only_for_long_threads`
- `summary_card_lists_asks_and_adds_commitment`
- `stale_summary_offers_refresh`
- E2E `summary flow`

**Verify:** `npm test` and the browser E2E pass.
**Commit:** `feat: summarize long threads with Claude`

---

## Phase 3 — Data location

### Task 10: Location pointer and target validation

**Files:**
- Add dependency: `dunce`
- Create: `src-tauri/src/storage/mod.rs`, `src-tauri/src/storage/location.rs`; `mod storage;` in `lib.rs`

**Interfaces:**
- Produces:
  - Pointer file:
    - `pub struct LocationFile { version: u32, data_dir: Option<PathBuf>, marker_id: Option<String>, previous: Option<PathBuf> }`
    - `pub fn read_location(default_root) -> LocationFile` and `pub fn write_location(default_root, &LocationFile) -> io::Result<()>` (atomic).
  - Resolution:
    - `pub enum RootStatus { Ready, Missing, NoMarker, MarkerMismatch, NotWritable }`
    - `pub struct Resolved { data_root, private_root, custom, status }`
    - `pub fn resolve(default_root) -> Resolved`
  - Target checks:
    - `pub trait VolumeInfo { fn fs_type(&self, p: &Path) -> String; fn free_bytes(&self, p: &Path) -> u64; }`. The macOS implementation uses `libc::statfs` `f_fstypename`; tests use a fake.
    - `pub enum TargetIssue { NotAbsolute, NotADirectory, NotWritable, InsideCurrentRoot, InsideAppBundle, CloudSynced(String), NetworkVolume(String), NoUnixPermissions(String) }`
    - `pub fn check_target(path, current_root, home, vol: &dyn VolumeInfo) -> TargetReport { ok, issues, existing_marker, free_bytes, fs_type }`
  - Constants: `DATA_DIR_NAME = "CodeMie Connect Data"`, `MARKER = ".codemie-connect.json"`.

**Tests:**
- `default_when_pointer_missing_or_invalid`
- `resolve_reports_missing_no_marker_mismatch_not_writable`
- `check_target_refuses_cloud_and_network_paths`:
  - `~/Library/Mobile Documents/x`
  - `~/Library/CloudStorage/OneDrive-X/x`
  - `/Users/a/Dropbox/x`
  - `~/Documents/x` when `~/Library/Mobile Documents/com~apple~CloudDocs/Documents` exists
  - `fs_type` `smbfs`
- `check_target_flags_exfat_as_no_unix_permissions`
- `check_target_detects_existing_marker`
- `write_location_is_atomic`

**Verify:** `cargo test storage::` passes.
**Commit:** `feat: resolve a user-chosen Connect data folder safely`

### Task 11: Start from the resolved root, split private and data paths, recovery

**Files:**
- Modify: `src-tauri/src/lib.rs:89-91`:
  - resolve before `Core::open`; keep `CODEMIE_WORKSPACE_TEST_DIR` for debug builds
  - acquire `owner.lock` in private, and `connect.lock` in a custom data root, with a 5 s retry
- Modify: `src-tauri/src/workspace/mod.rs:52-91`:
  - `Core::open(paths: CorePaths { data, private })`
  - credentials, plugin secrets and `window.json` go to `private`; the DB, `ai-staging` and curl temp files go to `data`
  - never `create_dir_all` or chmod a custom root
- Modify: call sites in `credentials.rs`, `geometry.rs`, `curl.rs`, and the `test_core` helper (Task 5)
- Modify: `src-tauri/src/workspace/repository.rs`:
  - I/O errors map to `storage_unavailable`
  - `#[cfg(test)]` failpoint `fail_next_write()`
- Create Tauri commands (they work while `core` is None): `storage_status() -> StorageStatus`, `data_location_use_default()` (rewrites the pointer only), `app_relaunch()` (releases locks, then restarts)
- Create: `ui/workspace/recovery.js` (pure `recoveryPage(status)`). Modify `ui/workspace/app.js:996-1002` to use it (Retry, Use the default folder; Task 13 adds Choose another folder)

**Interfaces:**
- Consumes: `resolve` (Task 10).
- Produces:
  - `StorageStatus { status, dataRoot, privateRoot, custom, defaultRoot }`
  - The three commands above.
  - Error code `storage_unavailable`.

**Tests:**
- `startup_never_creates_db_in_missing_custom_root`
- `credentials_stay_in_private_root_with_custom_data_root`
- `runtime_io_failure_reports_storage_unavailable`: arm the failpoint, run a write op, and get `storage_unavailable` with no panic.
- `use_default_rewrites_pointer_without_core`
- JS `recovery_page_offers_retry_and_default`

**Verify:** `cargo test` (outside the sandbox) and `npm test` pass.
**Commit:** `feat: keep private sign-in data local and recover when the data folder is missing`

### Task 12: Move, adopt, start fresh, remove old copy

**Files:**
- Create: `src-tauri/src/storage/migrate.rs`
- Create Tauri commands, registered in `lib.rs`: `data_location_get`, `data_location_check`, `data_location_change`, `data_location_remove_old`, `data_location_reveal`
- Modify: `src-tauri/src/workspace/mod.rs` (`Core::quiesce(timeout) -> Result<()>`: stops the background loop, waits for jobs, refuses while an action is `dispatching`, then closes the DB)

**Interfaces:**
- Consumes: `check_target`, `write_location`, `Core::quiesce`, `app_relaunch`.
- Produces:
  - `data_location_change { path, mode: "move"|"adopt"|"fresh", acceptNoPermissions?: bool }` returns `{ restarting: true }`.
  - `data_location_get` returns `{ dataRoot, privateRoot, logs, custom, sizeBytes, previous }`.
  - `data_location_remove_old` returns `{ removedBytes }`. Within `previous` it deletes only `workspace.sqlite*`, `ai-staging/`, `plugins/` and `automations/`.
  - Move order: checkpoint → `VACUUM INTO <target>/workspace.sqlite.tmp` → `integrity_check` → revision equality → rename → copy folders → marker → pointer → `app_relaunch`.

**Tests:**
- `move_copies_db_and_folders_then_points_to_target`
- `move_failure_leaves_pointer_unchanged`: an injected copy failure; the target tmp file is removed.
- `move_refused_while_action_dispatching`
- `adopt_requires_existing_marker`
- `fresh_creates_marker_and_empty_db_on_next_start`
- `remove_old_deletes_only_connect_files`

**Verify:** `cargo test storage::` passes.
**Commit:** `feat: move Connect data to a folder the user chooses`

### Task 13: Settings → General → Data location

**Files:**
- Add dependency: `tauri-plugin-dialog` (with `dialog:allow-open` for the main window only)
- Create: `ui/workspace/settings-storage.js` (pure `storageCard(info)`, `changeLocationBody(report)`)
- Modify: `ui/workspace/view-settings.js` (General tab includes the card), `ui/workspace/recovery.js` (Choose another folder), `ui/workspace/app.js` (handlers), `ui/workspace/workspace.css`

**Interfaces:**
- Produces hooks: `#data-location-path`, `[data-action="data-reveal|data-change|data-default|data-remove-old|data-copy-path|data-choose"]` and the radio `name="data-mode"`.

**Tests:**
- `storage_card_shows_paths_size_and_chip`
- `change_dialog_lists_issues_and_disables_continue`
- `change_dialog_offers_adopt_only_with_marker`
- `exfat_requires_acknowledgement_checkbox`
- E2E `data location flow`: a mocked pick → check → Move → confirm → `data_location_change` called with `mode: "move"`.

**Verify:** `npm test` and the browser E2E pass. Native check on a temp folder on the internal disk: move there and back, then Remove old copy. The owner's real data is never moved without their yes. Then run `./build-installer.sh --skip-stage`.
**Commit:** `feat: show and change where Connect keeps its data`

---

## Phase 4 — Automations

### Task 14: Automation model, scheduling and triggers

**Files:**
- Create: `src-tauri/src/workspace/automations.rs`
- Modify: `src-tauri/src/workspace/models.rs` (`Operation::{AutomationSave, AutomationDelete, AutomationToggle, AutomationRunNow}`; record kinds `automation`, `automation_run`)
- Modify: `src-tauri/src/workspace/schedules.rs` (reuse next-occurrence logic)
- Modify: `src-tauri/src/workspace/mod.rs` (background loop: due schedules and meeting-ended checks; after each sync commit, `match_events(new_ids)`)
- Modify: `ui/workspace/store.js` (add the automation ops to `REBASE_SAFE`)

**Interfaces:**
- Produces:
  - `pub struct Automation { id, name (≤ 80), enabled, trigger: Trigger, read: ReadSet, prompt (≤ 4000), ai: Route, cap_usd: Option<f64>, deliver: Deliver, catch_up: bool }`
  - `Trigger = Schedule { days: Vec<u8>, time: String } | Event { event: MailFrom|ChatFrom|Critical|MeetingEnded, senders: Vec<String>, keywords: Vec<String> }`
  - `ReadSet { calendar_today, needs_reply, trigger_conversation, mail_from_sender_days: u8, commitments_notes }`
  - `Deliver { today, notify, draft_reply }` (`draft_reply` only for MailFrom/ChatFrom)
  - `pub fn next_run(a, after, zone) -> Option<i64>`
  - `pub fn due(a, last_run, now, zone, app_started_at) -> Due { Now, CatchUp, No }`
  - `pub fn match_events(automations, new_messages, ended_meetings, critical_ids, state) -> Vec<(automation_id, source_id)>`: 10 min cooldown per automation, 30 runs per hour overall, no overlap.

**Tests:**
- `validate_rejects_bad_time_empty_days_long_prompt_and_draft_on_schedule`
- `next_run_respects_zone_and_dst`
- `catch_up_runs_once_within_12h_and_never_twice`
- `event_match_by_sender_domain_and_keyword`
- `critical_and_meeting_ended_triggers_fire_once`
- `cooldown_and_hourly_cap_are_enforced`
- `no_overlap_while_run_in_progress`

**Verify:** `cargo test workspace::automations` passes.
**Commit:** `feat: schedule and trigger automations`

### Task 15: Automation runs, deliveries, run log, brief removal

**Files:**
- Modify: `src-tauri/src/workspace/automations.rs` (job `automation_run`)
- Modify: `src-tauri/src/workspace/prompts.rs` (`AUTOMATION_SYSTEM`, `AUTOMATION_SCHEMA`)
- Modify: `src-tauri/src/workspace/mod.rs`:
  - remove `generate_brief` (`:1418-1501`), the `brief_generate` op and the `brief` job branch (`:327-333`)
  - migration on open: delete `brief` jobs and `brief`-kind schedules
  - remove the repository test that relies on them (`repository.rs:~1893`)

**Interfaces:**
- Consumes: `ClaudeRunner`, `resolve_route(Purpose::Automation)`, `draft_context`, `sanitize_line`.
- Produces:
  - `automation_run` record `{automationId, trigger: {kind, sourceId?}, status: "ok"|"failed"|"skipped", startedAt, durationMs, costUsd, profile, model, sources, output: {title, summaryMarkdown, items}, error?}`
  - Deliveries: Today (latest run per automation), notification (via `deliver_notification`), and a draft (a `draft` record on the trigger conversation with `provenance.automationId`).
  - Retention: 90 days or 200 runs, pruned at open.

**Tests:**
- `run_builds_context_from_read_set_only`
- `run_success_writes_run_and_delivers_today_and_notification`
- `event_run_with_draft_reply_creates_draft_never_action`
- `cap_usd_passes_max_budget_for_codemie_only`
- `failed_run_records_error_class_and_no_output`
- `retention_prunes_old_runs`
- `open_removes_brief_jobs_and_schedules`

**Verify:** `cargo test workspace::` passes.
**Commit:** `feat: run automations with Claude and deliver to Today, notifications or drafts`

### Task 16: Automations page, templates, Today card

**Files:**
- Create: `ui/workspace/view-automations.js` (pure `automations(state)`, `automationEditor(a)`, `runLog(runs)`, `TEMPLATES`)
- Modify: `ui/workspace/app.js` and `ui/workspace/shell.js` (route and sidebar entry `automations`, handlers, editor dialog)
- Modify: `ui/workspace/view-today.js` (`WIDGETS.automations = { title: 'Automation results', width: 6, … }`)
- Modify: `src-tauri/src/workspace/mod.rs:532-557` layout validation:
  - allowed ids from one `WIDGET_IDS` list (`brief`, `focus`, `calendar`, `inbox`, `commitments`, `automations`), plus `plugin:<id>:<widget>` ids (used by Task 24)
  - at most 16 ids; widths validated for the same ids
- Modify: `ui/workspace/workspace.css`, `ui/test/fixtures/workspace-fixture.mjs`

**Interfaces:**
- Produces hooks:
  - route and tabs: `[data-route="automations"]`, `[data-tab="automations|runs|templates"]`
  - row and template actions: `[data-action="automation-toggle|automation-run|automation-edit|automation-delete|automation-duplicate|automation-template"][data-id]`
  - editor fields: `#auto-name`, `[data-day]`, `#auto-time`, `select[name="auto-event"]`, `#auto-senders`, `[data-read]`, `#auto-prompt`, `select[name="auto-profile"]`, `#auto-cap`, `[data-deliver]`, `#auto-catchup`

**Tests:**
- `automations_list_shows_trigger_summary_last_run_and_cost`
- `editor_validates_and_hides_draft_reply_for_schedules`
- `template_prefills_editor`
- `run_log_expands_output_sources_and_error`
- `today_automation_card_shows_latest_results_with_sources`
- Rust `layout_accepts_automations_and_plugin_widgets_rejects_unknown`
- E2E `automations`:
  1. Create from Morning brief, save, Run now.
  2. The mocked run completes and the Today card shows it.
  3. Toggle the automation off.

  Run it in both themes and at all three widths.

**Verify:** `npm test`, `cargo test workspace::` and the browser E2E pass.
**Commit:** `feat: add the Automations page and Today results card`

---

## Phase 5 — Echo-compatible plugin host

### Task 17: Plugin frame isolation (gate)

**Files:**
- Create: `src-tauri/src/plugins/mod.rs`, `src-tauri/src/plugins/protocol.rs`:
  - register the `connect-plugin` scheme
  - serve `__host/*` from the bundled `ui/plugins/frame/` and `<id>/*` from the installed dir
  - MIME map, the CSP from DESIGN §7.3, and `Access-Control-Allow-Origin: null`
- Create: `src-tauri/src/plugins/caller.rs` (`fn require_main_frame(req: &tauri::ipc::Request) -> Result<()>`, which checks the request origin is `tauri://localhost` or `http://tauri.localhost`). Add it to `workspace_request`, `plugins_request`, `plugin_call` and all `data_location_*` commands.
- Create: `ui/plugins/frame/frame.html`, `ui/plugins/frame/probe.js` (smoke only)
- Modify: `src-tauri/tauri.conf.json` (CSP `frame-src connect-plugin:`)
- Create: native smoke mode `CODEMIE_PLUGIN_SMOKE=isolation` (`src-tauri/src/commands/smoke.rs`)

**Interfaces:**
- Produces:
  - `pub fn serve(req, roots: &PluginRoots) -> http::Response<Vec<u8>>`
  - `require_main_frame`
  - A smoke report at `$TMPDIR/connect-plugin-isolation.json`: `{tauriGlobal: false, internals: false, ipcFetchRejected: true, invokeRejected: true, parentBlocked: true, moduleImportWorks: true, localStorageThrows: true}`

**Tests:**
- `serve_rejects_traversal_and_unknown_plugin`: `..%2f`, absolute paths, a symlinked file.
- `serve_sets_csp_cors_and_mime`
- `require_main_frame_rejects_null_and_plugin_origins`
- Native smoke (outside the sandbox): every report field as listed.

**Gate:** Tasks 23-24 start only after the smoke passes. Record the result in `prototypes/milestone-2/VALIDATION.md`. If a field fails, stop and report; don't weaken the sandbox.
**Commit:** `feat: serve plugin UIs from an isolated sandboxed origin`

### Task 18: Manifest, capability catalog, permission sheet

**Files:**
- Add dependency: `semver`
- Create: `src-tauri/src/plugins/manifest.rs`, `src-tauri/src/plugins/capabilities.rs`
- Create: `src-tauri/tests/echo_plugins.rs` (env-gated)

**Interfaces:**
- Produces:
  - `pub struct Manifest { id, name, version: semver::Version, echo: semver::VersionReq, summary, uses: Map<String, Value>, settings: Vec<SettingDef>, main, client, widgets: Vec<WidgetDef>, skills, agent: Option<AgentDef>, icon }`
  - `pub fn parse_manifest(dir) -> Result<Manifest, ManifestError>`:
    - id matches `^[a-z][a-z0-9-]{1,40}$`
    - entry files are inside the dir
    - widget kinds are `stat|stats|chart|list|status|card|table|page`
  - `pub const ECHO_COMPAT: &str = "0.9.11";`
  - `pub enum Support { Supported, Partial(&'static str), Unsupported, Blocking(&'static str) }`. `knowledge` is `Blocking("Needs Connect's Knowledge engine (coming later)")`, and `claude` is `Partial("Claude runs without tools in Connect")`.
  - `pub fn sheet(m) -> Result<Vec<SheetLine { key, text, support }>, ManifestError>`: an unknown key gives the error "needs <key>, which Connect doesn't know".

**Tests:**
- `parse_valid_and_reject_bad_id_missing_entry_bad_widget_kind`
- `echo_range_excluding_compat_is_refused_with_reason`
- `sheet_marks_partial_unsupported_and_blocking`
- Env-gated `published_manifests_parse_and_only_knowledge_is_blocked`: all five manifests parse; Knowledge is blocked; the other four have no unknown keys.

**Verify:** `cargo test plugins::` passes, and `CONNECT_ECHO_PLUGINS_DIR=… cargo test --test echo_plugins` passes.
**Commit:** `feat: read Echo plugin manifests and build permission sheets`

### Task 19: Marketplaces, install, registry, update, remove

**Files:**
- Create: `src-tauri/src/plugins/market.rs`, `src-tauri/src/plugins/install.rs`, `src-tauri/src/plugins/registry.rs`
- Create: Tauri command `plugins_request(op, data)` with these ops:
  - Markets: `markets`, `market_add {source}`, `market_remove`, `catalog {market}`
  - Plugins: `inspect {market, id}`, `install {market, id, agreed}`, `set_enabled`, `update`, `remove {id, deleteData}`, `installed`

**Interfaces:**
- Consumes: `parse_manifest`, `sheet`, the data root (Task 11).
- Produces:
  - `Registry { installed: Map<id, Installed { version, source, commit, hash, enabled, agreed, installed_at }>, markets: Vec<Market> }` in `<data>/plugins/registry.json`, under an `fs2` lock.
  - Market sources:
    - `Local(path)`
    - `Git(url, ref)`; `owner/repo[@ref]` expands to `https://github.com/owner/repo`
    - built-in `onetest` = `onetest-ai/echo-plugins`
  - Clones go to `<data>/plugins/markets/<name>-<hash8>/` via `git clone --depth 1`; only `https:` and local folders are allowed.
  - `pub fn tree_hash(dir)` and `pub fn check_tree(dir)` (≤ 400 files, ≤ 20 MB, no symlinks).
  - Install dir: `<data>/plugins/installed/<id>/<version>/`.

**Tests:**
- `install_from_local_market_copies_and_hashes`
- `install_rejects_symlink_oversize_traversal_and_blocking_capability`
- `install_requires_every_sheet_line_agreed`
- `update_with_new_capability_requires_reconsent`
- `disable_and_remove_keep_or_delete_data`
- `concurrent_registry_writes_are_serialised`
- `market_add_expands_owner_repo_and_rejects_http_and_ssh`

**Verify:** `cargo test plugins::` passes.
**Commit:** `feat: install, update and remove Echo plugins from marketplaces`

### Task 20: QuickJS runtimes and the `ctx` prelude

**Files:**
- Add dependency: `rquickjs` (with the features needed for classes, properties and async futures)
- Create: `src-tauri/src/plugins/host/mod.rs`, `src-tauri/src/plugins/host/prelude.js`, `src-tauri/src/plugins/host/bridge.rs`

**Interfaces:**
- Produces:
  - `pub struct PluginHost`, with one runtime and context per plugin, all on one dedicated thread. Methods:
    - `load(id, main_js_path, grants)`
    - `call(id, cmd, args) -> Result<Value, HostError>`
    - `emit(event, payload)`
    - `unload(id)`
  - `pub trait HostServices: Send + Sync { fn sync(&self, plugin, name, args) -> Result<Value, HostError>; fn spawn_async(&self, plugin, name, args) -> BoxFuture<'static, Result<Value, HostError>>; }`
  - Limits: 64 MB per runtime, a 5 s slice, 30 s per call, and `every` at least 10 s.
  - Namespace policy from DESIGN §7.2:
    - `slots`, `threads`, `view`, `terminal` and `knowledge` are absent.
    - `sessions`, `channel`, `agent`, `scripts` and `claude.hasPlugin/installPlugin` throw `unsupported`.
  - `HostError { code: "unsupported"|"permission"|"timeout"|"limit"|"plugin_error"|"not_found", message }`

**Tests:**
- `command_registered_and_called_returns_value`
- `async_host_call_settles_promise`
- `infinite_loop_is_interrupted_and_runtime_survives`
- `memory_limit_is_per_plugin`: plugin A's allocation bomb fails; plugin B keeps working.
- `every_rejects_interval_below_10s`
- `missing_namespaces_are_undefined_or_throw_unsupported`
- `stores_are_isolated_between_plugins`

**Verify:** `cargo test plugins::host` passes.
**Commit:** `feat: run plugin host code in sandboxed QuickJS runtimes`

### Task 21: Host services A — storage, settings, files, network, notifications

**Files:**
- Add dependency: `pulldown-cmark`
- Create: `src-tauri/src/plugins/services/{mod.rs, store.rs, settings.rs, fs.rs, http.rs, notify.rs, markdown.rs}`

**Interfaces:**
- Consumes: `HostServices`, registry grants, the private root.
- Produces:
  - `store.read/write/list/remove/path` → `<data>/plugins/data/<id>/store/`
  - `settings.get/set`: `secret` values go to `<private>/plugins/<id>/secrets.json` (0600)
  - `package.read/list`: the plugin's own files only
  - `fs.folders/list/read/readMany/walk/write/move/remove/forget`: granted roots only, `dunce` canonicalisation, no symlink escape; writes need `folders.write`
  - `system.pickFolder` (adds a grant) and `system.which` (`find_program`)
  - `http.fetch`: HTTPS, host allowlist, no redirects, 10 MB, 60 s
  - `notify`
  - `markdown` → sanitised HTML (no raw HTML; `http(s):` links only)
  - `log` → `[plugin:<id>]` in the app log

**Tests:**
- `fs_denies_outside_grant_and_symlink_escape`
- `fs_write_requires_folders_write`
- `http_blocks_non_allowlisted_host_redirect_and_http_scheme`
- `secret_settings_are_written_0600_in_private_root`
- `markdown_strips_raw_html_and_javascript_links`

**Verify:** `cargo test plugins::services` passes (loopback tests run outside the sandbox).
**Commit:** `feat: give plugins scoped storage, files, network and notifications`

### Task 22: Host services B, and the PluginManager lifecycle

**Files:**
- Create: `src-tauri/src/plugins/services/{claude.rs, deliver.rs, today.rs, events.rs, echo_read.rs, signin.rs}`
- Create: `src-tauri/src/plugins/manager.rs` (`PluginManager`)
- Modify: `src-tauri/src/lib.rs` (create `PluginManager` after `Core` in setup; manage it in app state; the `plugin_call` command)
- Modify: `src-tauri/src/workspace/mod.rs`:
  - `Core.events: Arc<dyn EventSink>`
  - emit `sources_changed` and `threads_changed` once per sync round, and `meeting_soon` 10 min before events
  - `shared_changed` when plugin shared data changes
- Create: record kinds `plugin_item` and `plugin_widget`

**Interfaces:**
- Consumes: `ClaudeRunner` + `resolve_route(Purpose::Plugin)`, workspace records, `PluginHost`.
- Produces:
  - `pub trait EventSink: Send + Sync { fn emit(&self, event: &str, payload: Value); }`
  - `PluginManager`:
    - `start(app, core) -> Arc<PluginManager>` loads enabled plugins
    - `on_registry_change()` reloads after enable, disable, update or remove
    - `call(id, cmd, args)`
  - `claude.run({prompt, title?, profile?, model?, tools?, dir?, timeout?})`:
    - always tool-free, with `tools` recorded
    - returns `{answer, model, usage, costUsd, actions: []}`
    - records an `ai_run` with purpose `plugin`
  - `profiles()`
  - `deliver.send`, `deliver.provide/ready/status`, `inbox.set/clear`, `widgets.provide/set/clear/changed`, `work.provide/changed`, as specified in DESIGN §7.2
  - `echo.read`, `echo.dictionary.add`
  - `signin.get/keep/forget/sources` for `github.com` (`gh auth token` read only after the user's Sign in click)

**Tests:**
- `claude_run_is_tool_free_returns_answer_and_records_ai_run`: `tools: "read"` is recorded, and the run is still isolated.
- `deliver_mail_creates_held_message_to_self_never_confirmed`
- `deliver_telegram_routes_to_provider_plugin`
- `inbox_and_widgets_appear_in_snapshot`
- `sync_emits_sources_and_threads_changed_once_per_round`
- `echo_read_people_and_sources_map_connect_records`
- `signin_without_user_click_returns_permission`
- `manager_loads_enabled_and_reloads_on_change`

**Verify:** `cargo test plugins::` passes.
**Commit:** `feat: connect plugins to Claude, Today, deliveries and workspace data`

### Task 23: Plugin frame shim, main-window bridge, Echo CSS compatibility

**Files:**
- Create:
  - `ui/plugins/frame/frame.js`: the `pluginCtx` shim (DESIGN §7.3), the `ui` helpers (`esc, patch, setRow, setCard, sw, ICON, relDay, ago, notice, copy, stylesheet, style, graph, newGraph`), and a `localStorage` stand-in backed by the plugin store (preloaded at boot, writes flushed asynchronously)
  - `ui/plugins/frame/echo-compat.css`
  - `ui/plugins/frame/vendor/{sigma.min.js, graphology.umd.min.js, graphology-library.min.js}` with their LICENSE files (third-party MIT; copied from Echo's `crates/echoctl/ui/vendor/`)
  - `ui/plugins/host.js` (main window):
    - one sandboxed iframe per enabled client plugin
    - an RPC that accepts only known frame windows and the message schema
    - show and hide over the content area
- Remove: `ui/plugins/frame/probe.js`
- Test: `ui/test/plugin-bridge.test.mjs`, a synthetic plugin `ui/test/fixtures/plugins/hello/`, browser E2E

**Interfaces:**
- Consumes: `plugins_request`, `plugin_call`.
- Produces:
  - `export function mountPlugins(store, container)` and `export function showPluginRoute(id, route)`.
  - Message schema `{ v: 1, id, kind: "call"|"reply"|"event"|"contribution", … }`.
  - `pluginCtx.go(hash)` maps to `#/p/<id>/<hash>`.

**Tests:**
- `frame_ctx_call_round_trips_and_rejects_unknown_source`
- `settings_section_and_palette_contributions_reach_main`
- `local_storage_shim_persists_through_plugin_store`
- `listenWindow_and_onUnload_cleanup_on_disable`
- `ui_helpers_escape_text`
- E2E `plugin frame`:
  - The hello plugin renders a page, calls a host command and shows a settings section.
  - There are no page errors, in both themes.

**Verify:** `npm test` and the browser E2E pass.
**Commit:** `feat: run plugin UIs in isolated frames with an Echo-compatible context`

### Task 24: Plugins in Settings, sidebar and Today

**Files:**
- Modify: `ui/workspace/icons.js` (add `puzzle`)
- Create: `ui/workspace/settings-plugins.js` (pure). It covers:
  - the installed list and markets
  - the catalog, with Knowledge marked "Coming later"
  - a detail view: sheet with support markers, the unverified notice, Install, Enable, Update and Remove
- Modify:
  - `ui/workspace/view-settings.js` (tab `['', 'plugins', 'Plugins', 'puzzle']`)
  - `ui/workspace/shell.js` (sidebar "Plugins" group with plugin activities)
  - `ui/workspace/app.js` (routes `#/p/<id>/…`)
  - `ui/workspace/view-today.js` (plugin widgets as `plugin:<id>:<widget>` ids, and a "From plugins" card in Customize)

**Interfaces:**
- Produces hooks: `[data-plugin-id]`, `[data-action="plugin-install|plugin-enable|plugin-update|plugin-remove|market-add|market-remove"]` and `#plugin-sheet`.

**Tests:**
- `detail_shows_sheet_markers_and_unverified_notice`
- `knowledge_shows_coming_later_and_no_install`
- `install_dialog_requires_ticking_every_line`
- `disabled_plugin_activity_leaves_sidebar_and_frame_unloads`
- `today_customize_lists_plugin_widgets`
- E2E `plugins`: add a local market (mocked) → install hello → enable → sidebar entry → open the page → disable → the entry is gone.

**Verify:** `npm test` and the browser E2E pass.
**Commit:** `feat: manage Echo plugins from Settings, sidebar and Today`

### Task 25: Conformance — Scheduler, GitHub, Obsidian, Telegram

**Files:**
- Modify: `src-tauri/tests/echo_plugins.rs` (env-gated): load each real `main.js` in `PluginHost` with fake services (`FakeRunner`, recorded HTTP, temp folders)
- Create: `prototypes/milestone-2/PLUGIN-CONFORMANCE.md` (matrix: plugin × capability × status × evidence)
- Create: native smoke `CODEMIE_PLUGIN_SMOKE=<market dir>`: installs all four into a temp data root, opens each activity, and reports load errors and page errors

**Tests:**
- `scheduler_routine_runs_claude_tool_free_and_delivers_today`
- `github_without_signin_shows_prompt_and_makes_no_requests`
- `obsidian_walks_fixture_vault_sets_inbox_and_survives_unsupported_agent_calls`
- `telegram_without_token_reports_not_ready_and_survives_unsupported_sessions`
- `all_four_load_without_unknown_capability_errors`

**Verify:**
- `CONNECT_ECHO_PLUGINS_DIR=… cargo test --test echo_plugins` passes.
- The native smoke report shows zero load and page errors.
- `./build-installer.sh --skip-stage` passes.

**Commit:** `test: qualify the four published Echo plugins in Connect`

---

## Phase 6 — Release qualification

### Task 26: Documentation, full gates, independent review, validation report

**Files:**
- Modify:
  - `.ai-run/guides/architecture/architecture.md`: the `ai/`, `storage/` and `plugins/` boundaries, the isolation model, and the data and private roots.
  - `.ai-run/guides/testing/testing-patterns.md`: live `#[ignore]` tests, `CONNECT_ECHO_PLUGINS_DIR`, smoke modes, and the pure-module rule.
  - `prototypes/milestone-2/README.md` (create).
- Create: `prototypes/milestone-2/VALIDATION.md` (every gate with numbers; live checks done and not done; open gates)

**Steps:**
- [ ] Run every gate:
  ```bash
  cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
  ```
  ```bash
  npm test
  ```
  ```bash
  PLAYWRIGHT_CORE=/Users/Vadym_Vlasenko/AI/projects/other/codemie-desktop/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs
  ```
  ```bash
  ./build-installer.sh --skip-stage
  ```
  Expected: all pass; the E2E reports 0 failures.
- [ ] Dispatch an independent reviewer (a fresh subagent on the most capable model) on the whole branch diff against the Milestone 1 commit. Fix every confirmed finding with a test.
- [ ] Native live read-only checks, with the owner present:
  - the Claude page states;
  - one AI draft on a real conversation (not sent);
  - one summary;
  - one Morning brief run;
  - a data folder move to a temp folder and back;
  - installing the four plugins from the local marketplace and opening each.
- [ ] Write the validation report and send the owner screenshots.

**Commit:** `docs: record Milestone 2 validation`

---

## Order

**Sequence:** Phase 0 → 1 → 2 → 3 → 4 → 5 → 6. The phases share `models.rs`, `mod.rs`, `app.js`, `shell.js` and `view-today.js`, so they run one after another in one branch.

**Gates:** Task 4's live contract check and Task 17's isolation smoke. If either fails, stop and decide with the owner.

| Phase | Tasks | Size |
|---|---|---|
| 0 Groundwork | 2 | small |
| 1 Claude foundation | 4 | medium |
| 2 Drafting | 3 | medium |
| 3 Data location | 4 | medium |
| 4 Automations | 3 | medium |
| 5 Plugin host | 9 | large |
| 6 Release | 1 | small |
