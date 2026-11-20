# Connect Analytics page · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Analytics page in Connect. **AI analytics** (Overview, Efficiency, Sessions with traces) is fed entirely by the CodeMie CLI binary. **App analytics** is fed by Connect's own records.

**Architecture:**
- **Rust (`workspace/analytics/`)**
  - It finds the `codemie` binary and runs `codemie analytics --from --to --export json` per window in the background.
  - It upserts the sessions into `<data root>/analytics/sessions.json`, the CLI's own export shape.
  - It answers read-only workspace operations by running `codemie analytics view --input sessions.json …` and passing that JSON to the UI unchanged.
  - App analytics comes from Connect's records plus a log of terminal-dock launches.
- **UI:** pure renderers and models, built from the prototype in `prototypes/analytics/`, with a controller over `store.query`.

**Tech Stack:** Rust (Tauri v2, tokio, serde_json), vanilla ES modules, node:test, Playwright browser run.

**Spec:** `docs/superpowers/specs/2026-11-19-analytics-design.md`. The "`view` contract" section there is the CLI interface. The prototype `prototypes/analytics/` (gitignored) is the visual reference: open it with launch config `analytics-prototype`.

**Depends on:** the CLI PR from `docs/superpowers/plans/2026-11-19-analytics-cli.md` (`codemie analytics view`). Until it is released, the page shows the "needs a newer CLI" state; the real-app checks run against a build of the CLI branch put first on `PATH` through a `codemie` wrapper script. The bundled pin in `assets/codemie-cli` and `runtime.json` moves to that release when it is published (Connect's own CLI update also fetches the newest release at start).

## Global Constraints

- **No AI metric computed in Connect.** Every AI analytics number comes from `codemie analytics view`. The one exception, written in the spec: the App tab adds up `costUSD` of the CLI sessions matched to Connect terminal launches.
- **How the CLI runs:** `tokio::process::Command` with an argument array, never a shell string. Environment: `NODE_OPTIONS=--max-old-space-size=6144`. Timeout: 600 s per call, then kill.
- **Support check:** `codemie analytics view --help` exits 0. Otherwise status is `needs_cli`.
- **Where data lives:**
  - store `<data root>/analytics/sessions.json`
  - state `<data root>/analytics/state.json`
  - launch log `<private root>/terminal-launches.jsonl`
  - Every write is atomic: a temp file in the same folder, then rename.
- **Fetch schedule:**
  - First open reads 90 days, newest first, 3 UTC days per call.
  - A failed call splits into single days. A day that still fails goes into `failedDays`.
  - Refresh is one call from the start of yesterday (UTC) to today.
  - The page refreshes itself when `lastFetchAt` is older than 15 minutes.
  - Only one fetch runs at a time.
- **Operations** (read-only: no operation id, no revision bump, answered before the mutation lock like `ai_usage`): `analytics_status`, `analytics_refresh`, `analytics_retry`, `analytics_view`, `analytics_session`, `analytics_report`, `analytics_app`. Progress goes out on the event `workspace:analytics`.
- **App analytics feature keys:** `meeting`, `draft`, `summary`, `automation`, `plugin`, `terminal`. A terminal match needs `|session.startTime − launch.at| ≤ 120 000 ms` and `session.project == launch.folder`.
- **Every session on this Mac counts.** Every fetch passes `--include-external always`, so agents run without CodeMie (plain `claude`) are counted too. The "What's counted" popover says so and has no toggle (spec, Non-goals).
- **Copy:**
  - notice title: "Based on sessions saved on this Mac."
  - empty state: "No coding-agent sessions on this Mac yet. Sessions from Claude Code, codemie-claude or Connect's terminal show up here after a refresh."
  - old CLI: "Analytics needs a newer CodeMie CLI."
  - Visual values follow the prototype and `prototypes/milestone-1/CODEMIE-DESIGN-SPEC.md`.
- **Repo rules:**
  - Views and models stay pure; actions use the `analytics-` prefix.
  - Native response shapes are written as contract fixtures (`UPDATE_CONTRACT_FIXTURES=1`).
  - The plan has at most 7 tasks.
  - Gates: `make check`; the browser run with `WORKSPACE_E2E_ONLY=analytics`.

## Review Focus

1. **No CLI, or a CLI that's too old** (the user's own CLI is used, `existing_cli_detected`). Status `needs_cli`, the page shows the update state, nothing crashes, and no fetch starts. Covered in Task 1.
2. **Refresh pressed while a fetch runs.** No second CLI process: it returns `{running: true}`. Covered in Task 2.
3. **The app quits halfway through first open.** The next start continues with the days not yet read; it doesn't restart from zero. Covered in Task 2.
4. **`sessions.json` is unreadable** (manual edit, disk full mid-write). It's renamed to `sessions.json.bad`, and a fresh first open starts. Covered in Task 1.
5. **The data folder moves.** The analytics files move with it, because they live under the data root, and the next open uses the new path. Covered in Task 2 (the path comes from `CorePaths`).

---

### Task 1: CLI adapter and store

**Files:**
- Create:
  - `src-tauri/src/workspace/analytics/mod.rs` (module root; operations come in Task 2)
  - `src-tauri/src/workspace/analytics/cli.rs`
  - `src-tauri/src/workspace/analytics/store.rs`
  - `src-tauri/src/workspace/analytics/testdata/{export-day.json,summary.json,session.json}`. These are invented data from a real `view` run: titles changed, paths under `/Users/taylor`.
- Modify:
  - `src-tauri/src/workspace/mod.rs`: add `mod analytics;`; `Core` gets `analytics_cli: Arc<dyn AnalyticsCli>`; `test_core` wires `FakeAnalyticsCli`.
  - `src-tauri/src/workspace/paths.rs`: `CorePaths::analytics_dir() -> PathBuf` (`data.join("analytics")`).
  - `src-tauri/src/testing.rs`: re-export `FakeAnalyticsCli`.

**Interfaces:**
- Produces:
  - `#[async_trait] trait AnalyticsCli: Send + Sync`:
    - `async fn supports_view(&self) -> bool`
    - `async fn export(&self, from: NaiveDate, to: NaiveDate, out: &Path) -> Result<ExportOutcome, CliError>`
    - `async fn view(&self, input: &Path, args: &[String]) -> Result<Value, CliError>`
    - `async fn report(&self, input: &Path, args: &[String], out: &Path) -> Result<(), CliError>`
  - `enum ExportOutcome { Written, Empty }`. `Empty` means exit 0 and no file written, which is how the CLI reports no sessions.
  - `enum CliError { NotFound, Timeout, Failed { code: i32, stderr_tail: String } }`
  - `struct CodemieCli { program: PathBuf }`, found by `ai::discover::find_program_in("codemie", …)` with the same environment the profiles detection uses.
  - `FakeAnalyticsCli`: scripted outcomes per call and a record of the arguments.
  - `store::Store::open(dir: &Path) -> Store`. When `sessions.json` is missing it writes an empty export (`{"meta":{"periodStart":null},"sessions":[]}`), so `view` always has an input.
  - `Store::merge(&self, export: &Value) -> Result<usize /* sessions changed */>`. It upserts by `sessionId`, sets `meta.periodStart` to the oldest stored day, and writes atomically.
  - `Store::path(&self) -> PathBuf`
  - `store::State { cli_version: Option<String>, stored_from: Option<String /*YYYY-MM-DD*/>, days_done: BTreeSet<String>, failed_days: BTreeSet<String>, last_fetch_at: Option<i64 /*ms*/> }` with `State::load(dir)` / `State::save(dir)`.

- [ ] **Step 1: Write the failing tests**

In `analytics/cli.rs` `mod tests`, use a fake `codemie` shell script in a tempdir that prints known output and records its argv and environment:

```rust
#[tokio::test] async fn export_runs_without_a_shell_with_dates_and_raised_heap() // argv == ["analytics","--from","2026-11-17","--to","2026-11-19","--include-external","always","--export","json","-o",<out>]; env NODE_OPTIONS == "--max-old-space-size=6144"
#[tokio::test] async fn export_without_a_written_file_is_empty()                // script exits 0, writes nothing → ExportOutcome::Empty
#[tokio::test] async fn a_failing_export_keeps_the_last_stderr_lines()           // exit 3 → CliError::Failed{code:3, stderr_tail ends with the script's last line}
#[tokio::test] async fn view_support_is_the_help_exit_code()                     // `analytics view --help` exit 0 → true; exit 1 → false; missing binary → false
#[tokio::test] async fn a_call_past_the_timeout_is_killed()                      // timeout injected as 200 ms for the test → CliError::Timeout
```

In `analytics/store.rs` `mod tests`:

```rust
#[test] fn merge_upserts_by_session_id_and_keeps_the_newer_row()
#[test] fn merge_sets_period_start_to_the_oldest_stored_day()
#[test] fn an_unreadable_store_is_moved_aside_and_starts_empty()   // Review Focus 4: sessions.json.bad exists, store is empty
#[test] fn writes_are_atomic()                                      // a leftover .tmp from a crashed write is ignored and replaced
#[test] fn state_round_trips_days_and_failures()
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd src-tauri && cargo test analytics::`
Expected: FAIL to compile, because the module doesn't exist yet.

- [ ] **Step 3: Implement `cli.rs` and `store.rs`, wire `Core` and `test_core`**

`CodemieCli` takes the timeout from a constant `CALL_TIMEOUT = Duration::from_secs(600)`; tests pass a shorter one through `CodemieCli::with_timeout`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `cd src-tauri && cargo test analytics:: && cargo clippy -- -D warnings`
Expected: `test result: ok`; clippy is clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/workspace/analytics src-tauri/src/workspace/mod.rs src-tauri/src/workspace/paths.rs src-tauri/src/testing.rs
git commit -m "feat(analytics): run the CodeMie CLI for analytics and keep its sessions in the data folder"
```

---

### Task 2: Fetching and AI analytics operations

**Files:**
- Create: `src-tauri/src/workspace/analytics/fetch.rs`
- Modify:
  - `src-tauri/src/workspace/analytics/mod.rs`: the `Core` methods.
  - `src-tauri/src/workspace/models.rs`: `Operation` variants.
  - `src-tauri/src/workspace/mod.rs`: read-only dispatch in `Core::request`, next to `AiUsage`.
- Test: `src-tauri/src/workspace/analytics/tests.rs`, declared `#[cfg(test)] mod tests;`.
- Contract fixtures: `ui/test/fixtures/contract/analytics-status.json`, `analytics-summary.json`, `analytics-session.json`, `analytics-progress.json`.

**Interfaces:**
- Consumes: Task 1's `AnalyticsCli`, `Store` and `State`.
- Produces:
  - `fetch::plan_first_open(today_utc: NaiveDate, days: u32, done: &BTreeSet<String>) -> Vec<(NaiveDate, NaiveDate)>`: 3-day windows, newest first, skipping days already done. Days are UTC, because the CLI reads date-only `--from/--to` as UTC days.
  - `fetch::plan_refresh(today_utc: NaiveDate) -> (NaiveDate, NaiveDate)`: yesterday to today (UTC).
  - The operations:

    | Operation | Data in | Answer |
    |---|---|---|
    | `analytics_status` | `{}` | `{state: "ready"\|"needs_cli"\|"empty"\|"running", lastFetchAt, storedFrom, sessions, failedDays: [..], progress: {done,total,label}\|null}` |
    | `analytics_refresh` | `{}` | `{started: true}` or `{running: true}` |
    | `analytics_retry` | `{day: "YYYY-MM-DD"}` | `{started: true}` |
    | `analytics_view` | `{from, to, agent?, project?, compare?}` | the CLI's `summary/1` JSON, unchanged; `from`/`to` are ISO strings with an offset, made by the UI from local days |
    | `analytics_session` | `{id}` | the CLI's `session/1` JSON, unchanged |
    | `analytics_report` | `{from, to, agent?, project?}` | writes `<data root>/analytics/report.html` with the CLI, opens it, answers `{opened: true}` |

  - The event `workspace:analytics` carries `{running, done, total, label, failedDays}`.

- [ ] **Step 1: Write the failing tests**

All tests run over `test_core` with a `FakeAnalyticsCli` that serves `testdata/export-day.json`.

```rust
#[test] fn first_open_plans_three_day_windows_newest_first_and_skips_done_days()      // today 2026-11-19, 90 days → first window (11-17,11-19), last ends 2026-08-22; 30 windows
#[tokio::test] async fn a_failed_window_is_retried_day_by_day_and_only_the_bad_day_is_listed() // fake fails (11-14,11-16) and 11-15 alone → failedDays == ["2026-11-15"]
#[tokio::test] async fn refresh_reads_yesterday_to_today_in_one_call()
#[tokio::test] async fn a_second_refresh_while_one_runs_starts_nothing()            // Review Focus 2: fake records exactly one export call; answer {running:true}
#[tokio::test] async fn a_restart_continues_with_the_days_not_yet_read()             // Review Focus 3: State.days_done persisted after each window; new Core plans only the rest
#[tokio::test] async fn view_passes_filters_to_the_cli_and_returns_its_json_unchanged() // args contain --input <store>, --from, --to, --agent claude, --compare; answer == testdata/summary.json
#[tokio::test] async fn session_returns_the_cli_trace_unchanged()
#[tokio::test] async fn without_view_support_status_is_needs_cli_and_no_fetch_starts() // Review Focus 1
#[tokio::test] async fn the_store_follows_the_data_root()                             // Review Focus 5: Store path == CorePaths.analytics_dir()
#[tokio::test] async fn contract_fixtures_match_the_real_analytics()                 // writes the four analytics-*.json with contract_fixture
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd src-tauri && cargo test analytics::tests`
Expected: FAIL; the operations are unknown.

- [ ] **Step 3: Implement**

- `fetch.rs`:
  - The planner functions.
  - A single `run_fetch(core, windows)` task guarded by `Core.analytics_run: Mutex<Option<Progress>>`. Per window it calls `export → store.merge → state.days_done += days → state.save → emit progress`.
  - On `CliError` for a multi-day window it splits into single days; a failing single day goes into `failed_days`.
  - It sets `last_fetch_at` on finish.
- `mod.rs`: the operation handlers. `analytics_view` and `analytics_session` call `cli.view` with `--input <store path>` plus the mapped arguments. When the store has no sessions, `analytics_view` answers the CLI's own empty summary (from the CLI run on an empty export) and does not short-circuit.
- `analytics_report` writes through `cli.report`, then opens the file in the default browser. Make `commands/logger.rs::spawn_open` `pub(crate)` and reuse it. `graph::open_url` won't work here: it accepts only https links.

- [ ] **Step 4: Regenerate the contract fixtures and run all Rust tests**

Run: `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures && cargo test`
Expected: `test result: ok`; four new JSON files exist in `ui/test/fixtures/contract/`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/workspace ui/test/fixtures/contract/analytics-*.json
git commit -m "feat(analytics): fetch sessions day by day in the background and answer analytics views through the CLI"
```

---

### Task 3: App analytics and terminal launches

**Files:**
- Create: `src-tauri/src/workspace/analytics/app.rs`
- Modify:
  - `src-tauri/src/commands/terminal.rs`: `Terminals` gets `launch_log: Mutex<Option<PathBuf>>` and `pub fn set_launch_log(&self, p: PathBuf)`. `Terminals::open` and `Terminals::restart` append `{"at":<ms>,"folder":"…","program":"<argv[0]>"}` as one line, and keep at most 2,000 lines.
  - `src-tauri/src/lib.rs`: where the workspace `Core` is opened, call `terminals.set_launch_log(paths.private.join("terminal-launches.jsonl"))`.
  - `src-tauri/src/workspace/models.rs` and `mod.rs`: operation `AnalyticsApp`.
- Test: `src-tauri/src/workspace/analytics/app_tests.rs`, plus a `terminal.rs` unit test.
- Contract fixture: `ui/test/fixtures/contract/analytics-app.json`.

**Interfaces:**
- Produces:
  - `analytics_app {from, to}` answers:
    ```
    {totals:   {costUsd, runs, failed, terminalSessions, terminalCostUsd, shareOfAll},
     series:   [{from, to, by: {meeting, draft, summary, automation, plugin, terminal}}],
     features: [{key, runs, costUsd, failed, avgMs}],
     profiles: [{profile, model, runs, costUsd}],
     outcomes: {meetings, transcribed, noted, tasks, tasksDone, drafts, sent, inboxHandled, autoRuns, autoOk, perNoteUsd, perSentUsd},
     recent:   [ai_run rows, newest first, 50 max]}
    ```
  - `shareOfAll` = (background cost + terminal cost) / (background cost + the CLI's `totals.costUSD` for the same range). The CLI number comes from `analytics_view`.
- Where each number comes from:
  - **Feature mapping** from `ai_run.purpose`: `mail_draft` and `chat_draft` → `draft`; `summary`; `automation`; `plugin`; `meeting`.
  - **Meetings:** `meeting` records by `data.start`; `transcribed` = `transcriptIds` not empty; `noted` = `data.main` set.
  - **Tasks:** `commitment` records with `meetingId`; `tasksDone` = `status == "done"`.
  - **Drafts:** `drafts` = `ai_run` with a draft purpose and `status == "ok"`; `sent` = `action` records with `kind == "mail_reply"` and `state == "accepted"`.
  - **Inbox:** `inboxHandled` = `decision` records with `lifecycle == "archived"` or `acknowledgedAt` set, by `updated_at`.
  - **Automations:** `automation_run` records.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn terminal_open_and_restart_append_one_launch_line_each()          // terminal.rs, real PTY with /bin/cat as today's tests do
#[tokio::test] async fn app_totals_split_cost_by_feature_and_count_failures() // ai_run records seeded via repo.put_ai_run
#[tokio::test] async fn a_cli_session_counts_as_terminal_only_within_120_seconds_in_the_same_folder() // 119 s match; 121 s no; other folder no
#[tokio::test] async fn outcomes_count_meetings_tasks_sent_replies_inbox_and_automations()
#[tokio::test] async fn an_empty_range_answers_zeros()
#[tokio::test] async fn contract_fixture_analytics_app()
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd src-tauri && cargo test analytics::app && cargo test terminal_open_and_restart`
Expected: FAIL.

- [ ] **Step 3: Implement `app.rs`, the launch log and the operation**

- [ ] **Step 4: Run the tests and regenerate the fixtures**

Run: `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixture && cargo test`
Expected: `test result: ok`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src ui/test/fixtures/contract/analytics-app.json
git commit -m "feat(analytics): app analytics from Connect's records and the sessions its terminal started"
```

---

### Task 4: Analytics page: AI analytics (Overview, Efficiency, Sessions list)

**Files:**
- Create:
  - `ui/workspace/analytics-model.js` (pure: view state, range presets → ISO from/to, formatters, chart inputs from `summary/1`; no metric math)
  - `ui/workspace/analytics-charts.js` (pure SVG: `columns`, `stackedColumns`, `area`; port of `prototypes/analytics/charts.js`)
  - `ui/workspace/view-analytics.js` (pure renderers: header and mode switch, filter row, notice, progress line, Overview, Efficiency, Sessions list, empty and `needs_cli` states)
  - `ui/workspace/analytics-controller.js` (`createAnalyticsController({ state, query, render, toast, openModal, listen })`)
- Modify:
  - `ui/workspace/shell.js`: add `['analytics', 'Analytics']` to `NAV` after Automations.
  - `ui/workspace/icons.js`: an `analytics` icon (the bar-chart path).
  - `ui/workspace/app.js`: the route, the controller, the `workspace:analytics` listener, and dispatch for `analytics-*` actions.
  - `ui/workspace/workspace.css`: `.ws-an-*` styles, lifted from `prototypes/analytics/analytics.css` and mapped onto the existing `--ws-*` tokens.
- Test: `ui/test/analytics-model.test.mjs`, `ui/test/analytics-view.test.mjs`, `ui/test/analytics-controller.test.mjs`.

**Interfaces:**
- Consumes: the contract fixtures `analytics-status.json`, `analytics-summary.json` (Task 2).
- Produces:
  - `analyticsView(state, data) -> string`
  - `presetRange(id: 'today'|'7d'|'30d'|'90d'|'month', now: number, zone: string) -> { from: string, to: string, label: string }`
  - The controller actions: `analytics-mode`, `analytics-view`, `analytics-range`, `analytics-agent`, `analytics-project`, `analytics-metric`, `analytics-inv`, `analytics-refresh`, `analytics-retry`, `analytics-notice`, `analytics-table`, `analytics-open-session`, `analytics-report`.
  - Persisted UI preferences in `localStorage` key `codemie.analytics`: `{mode, view, range, noticeHidden, tables}`. Every read and write is in try/catch.

- [ ] **Step 1: Write the failing tests**

```js
// analytics-model.test.mjs
test('presets give local-day ISO bounds with the zone offset', ...)            // '30d' at 2026-11-19 16:40 Europe/Kyiv → from '2026-10-21T00:00:00+03:00', to '2026-11-19T23:59:59.999+02:00'
test('a delta is shown only when the CLI sent previous and change', ...)       // change null → no delta text
test('formatters: usd under a cent, tokens in K/M, durations', ...)
// analytics-view.test.mjs (reads the contract fixtures)
test('overview shows the four KPIs from totals, the trend chart and tools/models/projects cards', ...)
test('efficiency shows dead sessions, depth buckets with the CLI labels and the token mix', ...)
test('sessions list groups by day, newest first, with Running and Started in Connect tags', ...)
test('needs_cli renders the update state and no data cards', ...)
test('the notice hides into a "Local sessions only" chip', ...)
test('provider text is escaped', ...)                                          // a session title with <script> renders as text
// analytics-controller.test.mjs (fakes for query, render, toast)
test('changing the range calls analytics_view with the new from/to once', ...)
test('refresh calls analytics_refresh and shows progress from workspace:analytics events', ...)
test('opening the page refreshes on its own when lastFetchAt is older than 15 minutes', ...)
test('a click on a project filters by it', ...)
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test ui/test/analytics-model.test.mjs ui/test/analytics-view.test.mjs ui/test/analytics-controller.test.mjs`
Expected: FAIL; the modules don't exist yet.

- [ ] **Step 3: Implement the modules and the wiring**

Port the markup and behavior from `prototypes/analytics/app.js`, minus its data generator and its `model.js`: the data now comes from the operations.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npm test`
Expected: no failing test.

- [ ] **Step 5: Commit**

```bash
git add ui/workspace ui/test/analytics-*.test.mjs
git commit -m "feat(analytics): Analytics page with Overview, Efficiency and Sessions from the CodeMie CLI"
```

---

### Task 5: Session drawer and App analytics tab

**Files:**
- Create:
  - `ui/workspace/view-analytics-session.js` (pure: header with ID and log path, five-number strip, Trace with the step tree and side panel, Tokens & cost, Tools)
  - `ui/workspace/view-analytics-app.js` (pure: App KPIs, stacked cost chart with the "With terminal" switch, By feature, By profile and model, What Connect did, Recent runs with an All/Failed switch)
- Modify:
  - `ui/workspace/analytics-controller.js`: the actions `analytics-session-tab`, `analytics-step`, `analytics-step-toggle`, `analytics-copy`, `analytics-app-feature`, `analytics-app-list`, `analytics-app-terminal`, `analytics-close`.
  - `ui/workspace/view-analytics.js`: mount the App tab.
- Test: `ui/test/analytics-session.test.mjs`, `ui/test/analytics-app.test.mjs`.

**Interfaces:**
- Consumes: `analytics-session.json` (Task 2) and `analytics-app.json` (Task 3). The trace comes from `trace[]`; Connect does not rebuild the tree.
- Produces:
  - `sessionDrawer(detail, ui) -> string`, with `ui = { tab, selected, collapsed: Set<string> }`
  - `appTab(data, ui) -> string`

- [ ] **Step 1: Write the failing tests**

```js
test('trace lists the Session row first, then steps at their CLI level with #n labels', ...)
test('selecting a step shows parent link, own vs total cost, timing evidence, tools and children', ...)
test('collapsing a parent hides its children but keeps the parent row', ...)
test('the Session row shows where the cost went and hides the subagent row when there are none', ...)
test('a session without a log shows the CLI reason instead of costs', ...)
test('app tab: background runs by default, terminal only after the switch', ...)
test('app tab: a feature click filters Recent runs; Failed shows only failed runs', ...)
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test ui/test/analytics-session.test.mjs ui/test/analytics-app.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Port the drawer and App tab from `prototypes/analytics/app.js` (`renderDrawer`, `sessionDetail`, `stepDetail`, `viewApp`). Escape keys go through the controller's existing Escape handling.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npm test`
Expected: no failing test.

- [ ] **Step 5: Commit**

```bash
git add ui/workspace ui/test/analytics-session.test.mjs ui/test/analytics-app.test.mjs
git commit -m "feat(analytics): session trace drawer and the App analytics tab"
```

---

### Task 6: Browser end-to-end checks and the real-app pass

**Files:**
- Create: `ui/test/browser/analytics-checks.mjs` (`export async function analyticsChecks({ open, check, assert, shot, settled, OUT })`, the same shape as `meetingChecks`)
- Modify: `ui/test/browser/workspace-e2e.mjs`:
  - `WORKSPACE_E2E_ONLY=analytics` runs only these checks.
  - The full run includes them.
  - The mocked bridge answers the `analytics_*` operations from the contract fixtures, and emits `workspace:analytics` progress on `analytics_refresh`.

- [ ] **Step 1: Write the checks A1–A10 below**

- [ ] **Step 2: Run them**

Run (outside the sandbox): `WORKSPACE_E2E_ONLY=analytics PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs`
Expected: every check prints ✓; screenshots land in `output/playwright/workspace-e2e/` in both themes at 1000/1440/1680 px; no console errors.

- [ ] **Step 3: Do the real-app pass M1–M7 and note the results in the PR**

- [ ] **Step 4: Run all gates, then commit**

Run: `make check`
Expected: exit 0.

```bash
git add ui/test/browser
git commit -m "test(analytics): browser checks for the Analytics page"
```

---

## End-to-end scenarios

### Browser run (automated, mocked bridge, `WORKSPACE_E2E_ONLY=analytics`)

| # | Scenario | Steps | Expected |
|---|---|---|---|
| A1 | Overview | Open Analytics | Four KPIs equal the `analytics-summary.json` totals; the trend chart has one bar per series item; Tools, Models and Projects cards are filled; hovering a bar shows a tooltip; the table toggle shows the same numbers |
| A2 | Filters | Pick Last 7 days, Agent Claude Code, then a project; clear one | Each change sends one `analytics_view` with the matching `from`, `to`, `agent` and `project`; the chips show the values; × clears |
| A3 | Local-only notice | Hide the notice, reload, open "What's counted", show it again | The chip appears and survives a reload; the popover lists coverage per agent; the notice returns |
| A4 | Refresh | Press Refresh; the mock emits 3 progress events | The button is disabled; the progress line updates; "Updated just now" afterwards; one toast |
| A5 | First open | Status `running` with `done < total` | KPIs say "n of N days read so far"; days not yet read are shaded "Still reading…", not drawn as $0 |
| A6 | Failed day | Status with `failedDays: ["2026-10-13"]` | "1 day couldn't be read (Tue 13 Oct)"; "Try again" sends `analytics_retry {day}` |
| A7 | Needs a newer CLI, and no sessions | Status `needs_cli`; then status `empty` | `needs_cli`: the warning notice, no data cards, and the button opens Settings → CodeMie. `empty`: the empty-state copy, Refresh enabled, and the App tab still shows Connect's own data |
| A8 | Sessions and drawer | Search "webhook", sort by cost, open a session, select a nested subagent, collapse its parent, switch tabs, press Escape | The list filters and re-sorts; the drawer shows the trace from `analytics-session.json`; the side panel shows the parent link and timing; the children hide; Escape closes |
| A9 | App tab | Switch to App analytics; toggle "With terminal"; click Meeting notes; switch Recent runs to Failed | Values match `analytics-app.json`; the terminal series appears only after the switch; Recent runs filters as asked |
| A10 | Looks | Both themes at 1000/1440/1680 px | No horizontal scroll, no overlapping text, no console errors; screenshots saved |

### Real app (debug bundle with a test data folder; see the by-eye recipe in project memory)

| # | Scenario | Steps | Expected |
|---|---|---|---|
| M1 | First open on a real Mac | Fresh test data folder; open Analytics | This week shows within about 20 s; history fills newest first while the page stays responsive; `analytics/sessions.json` grows |
| M2 | Numbers equal the CLI | Compare Overview (Last 30 days) with `codemie analytics --last 30d --include-external always --export json` `meta.totals` | Sessions, cost (to the cent), turns and tool success match |
| M3 | Trace equals the CLI report | Open a session with subagents; then **Open the CLI report** for it | Same steps, nesting, numbering and costs |
| M4 | Terminal session | Start Claude Code from Connect's terminal in a project, do one prompt, quit, Refresh | The session shows "Started in Connect"; the App tab's terminal count goes up by 1 and its cost matches the session |
| M5 | Connect's own AI | Make meeting notes and one reply draft, then open the App tab | Runs, cost and the feature rows go up; Recent runs lists both |
| M6 | Survives problems | Quit during first open, then reopen; temporarily point PATH at an old CLI | It continues with the remaining days; the old CLI shows the update state with no crash |
| M7 | Data folder move | Settings → Storage → move the data folder; open Analytics | The page loads from the moved `analytics/` folder without refetching |
