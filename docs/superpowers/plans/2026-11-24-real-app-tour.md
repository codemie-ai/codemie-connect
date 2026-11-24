# Real-app tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers also follow the shared rules in `.superpowers/sdd/common-implementer.md`.

**Goal:** `make tour` builds a debug Connect with the `tour` feature, seeds a fresh test folder, lets the real app walk every implemented screen of steps 0–7 hidden from the user, captures its own web content at each stop and writes one self-contained HTML report with a coverage matrix.

**Architecture:**
- **Rust**, `src-tauri/src/commands/tour/` (feature `tour`): the switch and refusals (`mod.rs`), the seed import (`seed.rs`), the hidden window and the in-process WKWebView capture (`window.rs`), and the verdict and report write (`report.rs`). Tour mode also gives Core quiet doubles and no background loop, and refuses sends.
- **Window**, `ui/workspace/tour/`: the stops (`script.js`), the features (`coverage.js`) and the runner (`runner.js`), wired in `app.js` when `flags.tour` is set.
- **Node**, `scripts/tour/`: `seed.mjs` builds the seed from the browser run's fixture builders, `report.mjs` builds the HTML, and `run.sh` drives the whole run for `make tour`.

**Tech Stack:** Rust (Tauri v2 2.12.6, objc2 0.6 / objc2-web-kit 0.3.2 / objc2-app-kit 0.3.2, already in `Cargo.lock` through wry), `cargo test`; vanilla JS ES modules, `node:test`; bash (macOS).

**Spec:** `docs/superpowers/specs/2026-11-24-real-app-tour-design.md` (§ numbers and "Ruling N" below refer to it).

## Global Constraints

- **Repository, branch, commits:**
  - `/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect`, branch `feat/workspace-next`. Do not switch branches. Do not push.
  - One commit per task, Conventional Commit subject (`.ai-run/guides/standards/git-workflow.md`), trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Before each commit, the case-insensitive `git grep -il` check for the reference app's name (the controller gives the word) must print nothing. Never name the user's other assistant app or read its files.
- **Running things:**
  - Raw `cargo` from `src-tauri/` with `export PATH="$HOME/.cargo/bin:$PATH"`; `make`, `npm`, `node` from the repo root; macOS/zsh syntax.
  - Tour builds use `CARGO_TARGET_DIR=target/tour cargo build --features tour`, never the default target folder.
  - Skip the known failure: `cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`.
- **Never drive the desktop.** No OS mouse or keyboard events, no AppleScript, no `screencapture` (unless the user approves Ruling 4c), no activating any app. The app is launched only by `scripts/tour/run.sh`, and only in Tasks 5 and 10.
- **Safety, every task:**
  - The tour reads and writes only under `CODEMIE_WORKSPACE_TEST_DIR`, its `HOME` (`<run>/home`) and `output/tour/`. It never opens the user's data folder or reads `~/Library` app data.
  - It sends nothing: no send op is called, `action_prepare` and `action_confirm` refuse in tour mode, and the network backstops of spec § 2 are always set.
  - It kills only the PID it started.
- **Values (verbatim from the spec):**
  - env `CODEMIE_TOUR` (`all`, steps `0,3,7`, or stop ids `T05,T21`) and `CODEMIE_TOUR_SHA`;
  - feature `tour = ["test-support"]`;
  - exit codes 0 pass, 1 fail, 2 nothing reported within 600 s, 3 can't run;
  - refusal sentences from spec § Copy, word for word;
  - shots in `<test dir>/tour/shots/<id>.png`, results in `<test dir>/tour/results.json`, report in `output/tour/<yyyymmdd-hhmmss>-<sha>/index.html`;
  - window height 900, widths 1000 / 1440 / 1680;
  - backstop env `HTTPS_PROXY=HTTP_PROXY=ALL_PROXY=http://127.0.0.1:9`, `NO_PROXY=`, `GIT_ALLOW_PROTOCOL=file`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `HOME=CFFIXED_USER_HOME=<run>/home`.
- **Code rules:**
  - Every tour item is `#[cfg(feature = "tour")]`. Normal builds compile the stub `requested() -> bool` only.
  - Tour commands go inside `app_page_only(generate_handler![…])` with `#[cfg(feature = "tour")]`. `tour_menu_bar` and `tour_report` call `require_main_frame(&call)?` first.
  - UI modules stay pure: `runner.js` gets `invoke`, `goHash`, `store`, `doc`, `raf` passed in. Writes go through `mutate`, and HTML strings go through `escapeHtml`.

## Review Focus

1. **The user's Connect is running when the tour starts.** The tour must neither hand off to it nor touch its socket, and the user's app must keep working. (Task 1 `tour_never_registers_single_instance`.)
2. **A capture comes back blank or stale** (window behind others, or WebKit throttling). The stop must fail, never pass on an empty picture. (Task 5 `a_uniform_bitmap_is_blank`, and `runner.js` "two stops with identical PNG hashes fail the later one".)
3. **A stop's action reaches a send or a network op** (a misnamed `data-action`, a script edit in step 8). It must be refused before dispatch and recorded. (Task 6 "the deny-list refuses send, confirm, fetch and install", Task 2 `tour_refuses_action_prepare_and_confirm`.)
4. **A stale report**: an earlier run's `results.json` or PNGs in a reused folder. These must not pass. (Task 1 refuses a non-fresh test folder; Task 7 `a_report_from_another_run_fails`.)
5. **A built feature without a stop** after a later step lands. It must show red and fail `npm test`. (Task 6 "every built feature has a stop, and every stop covers a known feature".)

---

### Task 1: The tour switch, gates and launch-time isolation

**Files:**
- Modify: `src-tauri/Cargo.toml` (`[features]`: add `tour = ["test-support"]` and the macOS optional deps; reword the `test-support` comment to "the app is built with it only by `make tour`")
- Create: `src-tauri/src/commands/tour/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` (compile gate, builder, skip single-instance, config edit), `src-tauri/src/commands/smoke.rs` (`SmokeFlags.tour`)

**Interfaces:**
- Produces:
  - `pub fn requested() -> bool` (feature-independent; `false` when `CODEMIE_TOUR` is unset).
  - `#[cfg(feature="tour")] pub struct TourRun { pub run_id: String, pub sha: String, pub only: Only, pub test_dir: PathBuf, pub started_unix: i64 }`
  - `pub enum Only { All, Steps(Vec<u8>), Stops(Vec<String>) }`
  - `pub fn parse(env: &TourEnv) -> Result<TourRun, String>`, where `pub struct TourEnv { tour: Option<String>, sha: Option<String>, test_dir: Option<String>, status_smoke: bool, plugin_smoke: bool, debug: bool }`
  - `pub fn start() -> Option<&'static TourRun>` (exits 3 on refusal)
  - `pub fn active() -> Option<&'static TourRun>`
  - `pub fn fresh_folder(dir: &Path) -> Result<(), String>` (allows only `tour-seed.json`, `Meetings/`, `home/`)
  - `pub fn edit_window_config(w: &mut tauri::utils::config::WindowConfig)`
  - `SmokeFlags.tour: Option<String>` (the `only` value, as given) and `SmokeFlags.tour_run_id: Option<String>`

- [ ] **Step 1: Write the failing tests** in `commands/tour/mod.rs`:
  - `parse_refuses_what_spec_lists`: each case returns `Err` with the spec's sentence:
    - not debug → "CODEMIE_TOUR runs in a debug build made with `make tour`.";
    - no test dir, or a relative one → "Set CODEMIE_WORKSPACE_TEST_DIR to a fresh folder; the tour never opens your own data.";
    - status or plugin smoke set → "Run the tour without CODEMIE_STATUS_SMOKE or CODEMIE_PLUGIN_SMOKE.";
    - no SHA → `Err` containing `CODEMIE_TOUR_SHA`;
    - `CODEMIE_TOUR=nine` → `Err` naming `"nine"`.
  - `parse_reads_all_steps_and_stops`: `all` → `Only::All`, `"0, 3,7"` → `Steps([0,3,7])`, `"T05,T21"` → `Stops(["T05","T21"])`.
  - `fresh_folder_allows_only_the_seed`: a tempdir with `tour-seed.json`, `Meetings/`, `home/` is `Ok`. Adding `workspace.sqlite` or `tour/results.json` is `Err("That folder isn't a fresh tour seed: <path>.")`.
  - `edit_window_config_hides_and_unfocuses`: after the call, `visible == false`, `focus == false`, `focusable == false`, `skip_taskbar == true`, `incognito == true`, and the label is still `"main"`.
  - `tour_never_registers_single_instance`: a pure `fn lifecycle_plugins(tour: bool) -> Vec<&'static str>` returns `["single-instance","notification","autostart"]` for `false` and lacks `"single-instance"` for `true`. `lib.rs` registers from it.

- [ ] **Step 2: Run them, expect FAIL**

Run: `cd src-tauri && CARGO_TARGET_DIR=target/tour cargo test --features tour commands::tour`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.**
  - In `lib.rs`:
    - add `#[cfg(all(feature = "tour", not(debug_assertions)))] compile_error!("the tour runs in debug builds only");`;
    - in `run()`, before the builder: `let tour = commands::tour::start().is_some();`. Without the feature, `start` exits 3 with "Build the tour with `make tour`." when `requested()` in debug; in release it is a no-op;
    - `tauri::Builder::default().activate_ignoring_other_apps(!tour)`;
    - `let mut context = tauri::generate_context!(); if tour { edit_window_config(&mut context.config_mut().app.windows[0]) }`;
    - in setup, when `tour`: `app.set_activation_policy(tauri::ActivationPolicy::Accessory)`; register lifecycle plugins from `lifecycle_plugins(tour)`.
  - `smoke_mode` fills `tour` and `tour_run_id` from `active()`.

- [ ] **Step 4: Run the tests, expect PASS; then prove the release gate**

Run:
- `cd src-tauri && CARGO_TARGET_DIR=target/tour cargo test --features tour commands::tour`
- `cargo build --release` (expect success, no tour code)
- `CARGO_TARGET_DIR=target/tour cargo check --release --features tour 2>&1 | grep "the tour runs in debug builds only"` (expect one match)

- [ ] **Step 5: Gates and commit**

Run: `make fmt-check lint && cd src-tauri && cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`
Then: `git commit -m "feat(tour): CODEMIE_TOUR switch, debug-only feature and launch isolation"`

### Task 2: A quiet Core for the tour

**Files:**
- Modify: `src-tauri/src/workspace/mod.rs` (`Core::open_tour`, the start branch, the send refusal in `Core::request`), `src-tauri/src/plugins/manager.rs` (`PluginManager::start_with_http`), `src-tauri/src/lib.rs` (choose the open closure, hide the tray), `src-tauri/src/commands/status_smoke.rs` (make `menu_bar_facts` `pub(crate)`)
- Create: `src-tauri/src/commands/tour/quiet.rs` (the tour's three profiles and FakeRunner answer)

**Interfaces:**
- Consumes: `commands::tour::active()`.
- Produces:
  - `#[cfg(feature="tour")] pub fn Core::open_tour(app: AppHandle, paths: &CorePaths, profiles: Vec<AiProfile>) -> Result<Arc<Core>>`, built on `open_with` with:
    - `FakeRunner` scripted "The tour doesn't call Claude.";
    - `ProfileCache::fixed(profiles)`;
    - `FakeGraph::default()`;
    - `FakeAnalyticsCli::new()`.
  - `Core::start` starts only `start_menu_bar()` when `tour::active()`.
  - `quiet::profiles() -> Vec<AiProfile>`: `claude` "Claude Code" ready; `codemie-prod` "CodeMie · prod" ready; `codemie-local-ollama` "CodeMie · local-ollama" with provider `ollama` and state `not_running`.
  - `PluginManager::start_with_http(app, core, http: http::Client) -> Arc<PluginManager>`; `start` calls it with `Client::new()`.
  - `pub(crate) fn menu_bar_facts(app, core) -> Value`.

- [ ] **Step 1: Write the failing tests**
  - In `workspace/mod.rs` tests, `tour_refuses_action_prepare_and_confirm`: with a test flag `TOUR_FOR_TESTS` set, `core.request(mutation(&core, Operation::ActionPrepare, json!({"kind":"chat_reply"})))` is `Err` with code `"tour"` and message `"The tour sends nothing."`. Same for `ActionConfirm`. The revision is unchanged, so the refusal runs before the mutation lock. The check reads `tour_sends_nothing()`, which is `tour::active().is_some()` in the app and the test flag under `cfg(test)`.
  - `a_tour_core_starts_no_background_loop`: after `start` in tour mode, `loop_busy` never turns true within 1.5 s, and `jobs()` keeps a seeded ready `sync` job `queued`.
  - In `quiet.rs`, `the_tour_profiles_are_two_ready_and_ollama_not_running`.

- [ ] **Step 2: Run, expect FAIL**

Run: `cd src-tauri && CARGO_TARGET_DIR=target/tour cargo test --features tour tour_`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - In `lib.rs`, when touring:
    - the `workspace::startup` closure calls `Core::open_tour(handle, paths, quiet::profiles())`;
    - after `Core` opens, `core.set_task_providers(seeded FakeProvider)`. The provider is built in Task 3; until then use `FakeProvider::new()` with `set_available([todoist on, ready])`;
    - then `PluginManager::start_with_http(app, core, http::Client::offline().0)`;
    - after `setup_tray`, `app.tray_by_id("main").map(|t| t.set_visible(false))`.

- [ ] **Step 4: Run, expect PASS**, then run the full `cargo test` with the skip above.

- [ ] **Step 5: Commit** `feat(tour): fakes, no background loop and no sends in tour mode`

### Task 3: Seed import (Rust)

**Files:**
- Create: `src-tauri/src/commands/tour/seed.rs`
- Modify: `src-tauri/src/lib.rs` (import before `startup` when touring)

**Interfaces:**
- Consumes: `Repository::open`, `settings_update`, `save_connection`, `save_workspace`, `put_record`, `put_record_unversioned`; `FakeProvider::{new, set_available, put_remote}`.
- Produces:
  - `pub struct Seed { settings: Settings, connections: Vec<Connection>, workspaces: Vec<Workspace>, records: Vec<Record>, seen: Value, provider: ProviderSeed }`, deserialized from `tour-seed.json` (camelCase);
  - `pub struct ProviderSeed { available: Vec<ProviderInfo>, remote: Vec<Value> }`;
  - `pub fn import(test_dir: &Path) -> Result<(SeedCounts, Arc<FakeProvider>), WorkspaceError>`;
  - `pub struct SeedCounts { records: usize, connections: usize }`.

- [ ] **Step 1: Write the failing tests**
  - `import_writes_every_part`: a tempdir with an inline seed (one connection, the `personal` workspace, two records, `seen.since`, one remote task). After `import`, `Repository::open(...)` shows:
    - the connection;
    - the records by kind and id;
    - the `menu_bar_seen` record `personal` with that `since`;
    - `FakeProvider::tasks().len() == 1`.
  - `import_refuses_a_path_outside_the_test_dir`: a `meeting` record whose `folder` is `/Users/taylor/...` → `Err` code `validation`, `field == "records[0].data.folder"`.
  - `import_refuses_a_secret_field`: any key matching `/token|secret|password/i` anywhere in the seed → `validation`.
  - `import_then_core_open_keeps_since`: after `import`, `Core::open_tour` runs `menu_bar::ensure_since`, and `since` is still the seeded value.

- [ ] **Step 2: Run, expect FAIL** (`cargo test --features tour commands::tour::seed`, `CARGO_TARGET_DIR=target/tour`).

- [ ] **Step 3: Implement** `import`. Write into `<test_dir>/workspace.sqlite`, the path `CorePaths.database()` gives for that root, in one transaction-free pass (a failed import leaves a folder the next run refuses as not fresh). Then wire it in `lib.rs`: tour → `seed::import(&test_dir)`, and on `Err` print the message and exit 3.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** `feat(tour): import the tour seed into a fresh test folder`

### Task 4: The seed builder (Node)

**Files:**
- Create: `scripts/tour/seed.mjs`, `ui/test/tour-seed.test.mjs`
- Modify: `ui/test/browser/tasks-provider-checks.mjs` (export `allTodoist`, `marekCheckIn`, `demoHandled`; no behaviour change)

**Interfaces:**
- Consumes: `buildSnapshot`, `withTasks`, `withMeetings`, `meetingFolders`, `withAutomations(s, now, {habits: true})`, `contract(...)` from `ui/test/fixtures/workspace-fixture.mjs`.
- Produces:
  - `export function buildSeed(testDir: string, nowMs: number) -> { seed, folders: [{path, files: {name: text}}] }`;
  - `export const SEED_IDS = { teams1to1, groupChat, priyaMail, critical, readyMeeting, checkWithTask, triageRun, fallbackRun }`, the ids the tour script uses;
  - CLI: `node scripts/tour/seed.mjs <testDir>` writes `tour-seed.json` and the folders, refuses a non-empty `<testDir>`, and prints the counts.

- [ ] **Step 1: Write the failing tests** in `ui/test/tour-seed.test.mjs`:
  - "every path in the seed is inside the test folder": walk all strings; none starts with `/Users/` unless it starts with `testDir`.
  - "no secret, every address @example.test".
  - "the seed matches spec § 4":
    - `settings.tasks.provider === 'plugin:todoist'`;
    - `settings.menuBar` is all true;
    - `seen.since === now/1000 - 86400`;
    - pinned summaries are `['formal-summary','short-summary']`;
    - the connection's `enabled` includes `mail_send` and `chat_send`;
    - `provider.available[0]` is `{id: 'plugin:todoist', name: 'Todoist', on: true, ready: true}`;
    - one automation run has `status: 'failed'` and one has `fallbackFrom`.
  - "SEED_IDS all exist in the seed's records".
  - "the CLI refuses a non-empty folder" (spawn with a tmp folder holding a file; exit code 1).

- [ ] **Step 2: Run, expect FAIL**: `node --test ui/test/tour-seed.test.mjs`

- [ ] **Step 3: Implement** `buildSeed`. Build the snapshot with the fixture builders, apply the exported task transforms, and move `MEETINGS_ROOT` to `<testDir>/Meetings`. Keep only the storable parts (`settings`, `connections`, `workspaces`, `records` minus `menu_bar_seen`). Add `seen`, the provider seed and the AI settings of spec § 4 (default `claude` with fallback `codemie-prod`; the Inbox triage route on `codemie-local-ollama` with fallback `claude`; one job on `codemie-local-ollama` with no fallback).

- [ ] **Step 4: Run, expect PASS**, then `npm test`.

- [ ] **Step 5: Commit** `feat(tour): build the tour seed from the browser run's fixtures`

### Task 5: The hidden window and in-process capture

**Files:**
- Create: `src-tauri/src/commands/tour/window.rs`
- Modify: `src-tauri/Cargo.toml` (`[target.'cfg(target_os = "macos")'.dependencies]`: optional `objc2 = "0.6"`, `objc2-foundation = "0.3"`, `objc2-app-kit = { version = "0.3", features = ["NSWindow","NSBitmapImageRep","NSImage","NSImageRep","NSGraphics","NSRunningApplication","NSApplication","NSScreen"] }`, `objc2-web-kit = { version = "0.3", features = ["WKWebView","WKSnapshotConfiguration","block2"] }`, `block2 = "0.6"`, all enabled by `tour`; `Cargo.lock` must not gain new versions), `src-tauri/src/lib.rs` (register commands, call `hide_window` after setup)

**Interfaces:**
- Produces:
  - `pub fn is_blank(rgba: &[u8], width: usize, height: usize, stride: usize) -> bool` (samples a 32×32 grid);
  - `pub fn bottom_left(visible_frame: (f64,f64,f64,f64), size: (f64,f64)) -> (f64,f64)`;
  - `pub fn hide_window(w: &WebviewWindow)` (macOS; spec § 3);
  - `#[tauri::command] async fn tour_window(app, width: u32, height: u32) -> CmdResult<Value>`;
  - `#[tauri::command] async fn tour_capture(app, id: String) -> CmdResult<Value>`, answering `{path, width, height, blank, sha256}`; `id` must match `^T\d{2}[a-z0-9-]*$`;
  - `#[tauri::command] fn tour_focus(app) -> Value`, answering `{appActive, windowKey}`.

- [ ] **Step 1: Write the failing tests**:
  - `a_uniform_bitmap_is_blank`: all-white 1440×900 → true; one 8×8 block of another colour inside a sample cell → false.
  - `bottom_left_stays_inside_the_visible_frame`: frame `(0,25,1512,957)`, size `(1440,900)` → `(0,25)`. A window larger than the frame is clamped to the frame's origin.
  - `capture_ids_are_checked`: `"T05"` and `"T21-unfold"` are ok; `"../x"` and `"T5"` are refused.

- [ ] **Step 2: Run, expect FAIL** (`cargo test --features tour commands::tour::window`).

- [ ] **Step 3: Implement.**
  - **`hide_window`** follows spec § 3 in this order: alpha 0, ignores mouse, level `kCGNormalWindowLevel - 1`, `collectionBehavior` `.transient | .ignoresCycle`, frame at `bottom_left`, `orderBack:`. Then on the webview: `respondsToSelector(sel!(_setWindowOcclusionDetectionEnabled:))` → send `NO`.
  - **`tour_capture`**:
    - `with_webview` → `pv.inner()` as `&WKWebView`;
    - `takeSnapshotWithConfiguration_completionHandler(None, block)`;
    - the PNG goes through `NSBitmapImageRep::imageRepWithData(image.TIFFRepresentation())` → `representationUsingType_properties(PNG)`;
    - compute `blank` from `bitmapData`;
    - write `<test dir>/tour/shots/<id>.png`;
    - send the result back through a `tokio::sync::oneshot` with a 10 s timeout.
  - **`tour_window`** calls `set_size(LogicalSize)`, then re-applies `bottom_left`.

- [ ] **Step 4: Run, expect PASS. Then the decisive check** (Rulings 3–5), through a minimal run script: until Task 8 exists, a temporary local command not committed, with the spec § 2 environment, `CODEMIE_TOUR=T01` and a seed from Task 4. The window half is not built yet, so drive the capture from the dev console hook: `flags.tour` makes `app.js` expose `window.__tour = { invoke }`; call `tour_capture` twice, on `#/settings/plugins` and `#/inbox`.
  Expected:
  - both PNGs are non-blank and their hashes differ;
  - `tour_focus` answers `{appActive: false, windowKey: false}`;
  - nothing appears on screen (the implementer reports what the controller saw: no Dock icon, no menu-bar icon).

  If a PNG is blank or stale, try the Ruling 4 fallbacks in order (a), then (b). Record the result in the task digest. Do **not** use (c) without the user's approval through the controller.

- [ ] **Step 5: Commit** `feat(tour): keep the tour window invisible and capture its own web content`

### Task 6: Stops, coverage and the runner (window)

**Files:**
- Create: `ui/workspace/tour/script.js`, `ui/workspace/tour/coverage.js`, `ui/workspace/tour/runner.js`, `ui/test/tour.test.mjs`
- Modify: `ui/workspace/app.js` (boot: when `flags.tour`, skip `codemie.boot()`, the update check and the setup sheet; after boot, `import('./tour/runner.js')` and `runTour(...)`, then `invoke('tour_report', {report})`)

**Interfaces:**
- Consumes: Task 4's `SEED_IDS` (copied as plain ids into `script.js`; `ui/` can't import `scripts/`, and a test pins them equal); `recordOps` from `status-smoke.js`; the commands `tour_window`, `tour_capture`, `tour_focus` and `tour_menu_bar`.
- Produces:
  - `export const FEATURES = [{id, step, text, spec, status: 'built'|'browser'|'planned', browserCheck?}]`. Ids by step:
    - step 0: `m0.builtin-first`, `m0.not-fetched`;
    - step 1: `c1.view-setting`, `c1.compact-sizes`, `c1.default-unchanged`, `c1.compact-inbox`, `c1.open-in-place`, `c1.compact-today`, `c1.today-menu`, `c1.hide-pages`;
    - step 2: `r2.named-send`, `r2.mail-ellipsis`, `r2.draft-link`, `r2.change-line`, `r2.three-controls`, `r2.more-menu`, `r2.acknowledge`, `r2.autosave`, `r2.mail-confirm` (browser: `reply-checks.mjs`);
    - step 3: `mv3.summary-first`, `mv3.strip`, `mv3.pinned-tabs`, `mv3.panes-behind-more`, `mv3.back-to-summary`, `mv3.action-items`, `mv3.list-needs-you`, `mv3.settings-open-on`;
    - step 4: `tp4.by-date`, `tp4.check-with`, `tp4.looks-handled`, `tp4.pending-parked`, `tp4.add-to-provider`, `tp4.today-widget`, `tp4.settings-radio`, `tp4.local-board`, `tp4.banners` (browser: `tasks-provider-checks.mjs`);
    - step 5: `ct5.gallery`, `ct5.editor-tasks`, `ct5.run-log-tasks`, `ct5.today-made`, `ct5.formal-template`;
    - step 6: `mb6.settings-card`, `mb6.fix-rows`, `mb6.tray-state`;
    - step 7: `pm7.ai-label`, `pm7.groups`, `pm7.fallback`, `pm7.status-chips`, `pm7.ollama`, `pm7.narrow`, `pm7.run-fallback`, `pm7.plugin-rows` (browser: `workspace.test.mjs` settings-ai cases);
    - planned: `s8.reply-voice`, `s9.ask-inline`.
  - `export const STOPS = [...]`: T01–T30 exactly as spec § 6, each `{id, step: number[], title, route, view, theme, width, action?, checks, covers}`.
  - `export const ACTIONS = { openRow(id), openMore(scope), typeReply(text), selectRow(id), openTodayMore(), hidePage(id)/showPage(id), unfoldTask(id), setProvider(p), useTemplate(id)/cancelModal(), unfoldRun(id), menuBar() }`.
  - `export async function runTour({invoke, goHash, store, mutate, doc, raf, only, runId}) -> {runId, stops: [...], ops: [...], refused: [...]}`.
  - `export function denied(kind: 'op'|'action'|'invoke', name: string) -> boolean`.

- [ ] **Step 1: Write the failing tests** in `ui/test/tour.test.mjs`:
  - "every built feature has a stop, and every stop covers a known feature".
  - "every browser feature names a check file that exists" (`fs.existsSync`).
  - "stops are T01..T30 in order, widths in {1000,1440,1680}, views and themes both used for steps 1–5 and 7".
  - "the deny-list refuses send, confirm, fetch and install": `denied('op','action_confirm')`, `denied('action','reply-send')`, `denied('action','market-fetch')`, `denied('invoke','plugins_request:install')` are all true; `denied('op','settings_update')` is false.
  - "a stop whose action is denied fails and dispatches nothing".
  - "a thrown check fails only its stop".
  - "a blank capture fails its stop".
  - "two stops on different routes with identical PNG hashes fail the later one".
  - "a stop with `tour_focus` reporting appActive fails, and the tour goes on".
  - "only=Steps([3]) runs only stops whose step includes 3".
  - "SEED_IDS in script.js equal those of scripts/tour/seed.mjs".
  - All of these use a fake `doc` (`querySelectorAll` over canned nodes), a fake `invoke` that records calls, and `raf = fn => fn()`.

- [ ] **Step 2: Run, expect FAIL**: `node --test ui/test/tour.test.mjs`

- [ ] **Step 3: Implement** the three modules and the `app.js` wiring. The runner follows spec § 5 per stop: settings, `tour_window`, `goHash`, settle (no `.ws-loading` or `.ws-spinner`, two frames, at most 8 s), action, checks plus `noOverflow`, `tour_focus`, `tour_capture`. Take each check's selectors from the browser check set named in the feature, not invented.

- [ ] **Step 4: Run, expect PASS**, then `npm test`.

- [ ] **Step 5: Commit** `feat(tour): stops for steps 0–7, the coverage list and the runner`

### Task 7: Verdict and the HTML report

**Files:**
- Create: `src-tauri/src/commands/tour/report.rs`, `scripts/tour/report.mjs`, `ui/test/tour-report.test.mjs`
- Modify: `src-tauri/src/lib.rs` (register `tour_report`, `tour_menu_bar`; arm a 600 s watchdog that writes `{pass:false, failed:["nothing reported within 600 s"]}` and exits 2)

**Interfaces:**
- Consumes: `TourRun`; `menu_bar_facts`; `menu_bar::rows`.
- Produces:
  - `pub fn verdict(window: Value, run: &TourRun, facts: Value) -> Value`, returning `{runId, sha, startedAt, finishedAt, binary: {path, mtime}, stops, ops, refused, menuBar, pass, failed: [string]}`;
  - `#[tauri::command] async fn tour_report(app, call, report: Value) -> CmdResult<Value>`, which writes `<test dir>/tour/results.json`, prints `TOUR {path, pass, failed}`, then `app.exit(0|1)` after 300 ms;
  - `#[tauri::command] async fn tour_menu_bar(app, call) -> CmdResult<Value>`, answering `menu_bar_facts` plus `rowTexts`;
  - `export function renderReport(results, shots: {id: base64}, features) -> string` and the CLI `node scripts/tour/report.mjs <testDir> <outDir>`.

- [ ] **Step 1: Write the failing tests**
  - Rust:
    - `a_report_from_another_run_fails` (window `runId` differs → `pass:false`, `failed` contains `"runId"`);
    - `a_stop_with_no_checks_fails`;
    - `a_blank_capture_fails`;
    - `menu_bar_mismatch_fails` (applied title `"2"`, computed label `"3"`);
    - `all_passing_passes`.
  - JS (`tour-report.test.mjs`):
    - "coverage rows are green, red, amber and grey by status and stop results": a built feature whose only stop failed is red;
    - "screenshots are inline data URIs and the file has no `<script` and no `http`";
    - "text is escaped": a check detail `<img onerror>` appears escaped;
    - "sections are grouped by rollout step 0..7 in order";
    - "the menu bar section says Computed state, not a screenshot";
    - "the header shows the sha with +dirty".

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** both. The CSS uses Connect's light tokens with a `prefers-color-scheme: dark` block, system fonts, and no external resources.

- [ ] **Step 4: Run, expect PASS** (`cargo test --features tour commands::tour::report`, `node --test ui/test/tour-report.test.mjs`).

- [ ] **Step 5: Commit** `feat(tour): verdict, results.json and the self-contained HTML report`

### Task 8: `make tour`

**Files:**
- Create: `scripts/tour/run.sh` (executable), `ui/test/tour-run.test.mjs`
- Modify: `Makefile` (`tour: | $(NODE_BIN) ## Build, seed and run the real-app tour; report in output/tour/`; add `tour` to `.PHONY`)

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: `scripts/tour/run.sh [--dry-run] [--only <value>]`.
  - `--dry-run` prints the build command, the run folder and the full launch environment (one `KEY=value` per line), then exits 0 without building or launching.
  - `make tour ONLY=…` passes `--only`.

- [ ] **Step 1: Write the failing tests** in `ui/test/tour-run.test.mjs` (spawn `run.sh --dry-run`):
  - "the launch environment is exactly spec § 2's": `HOME` and `CFFIXED_USER_HOME` under the run folder; the three proxies `http://127.0.0.1:9`; `NO_PROXY=`; `GIT_ALLOW_PROTOCOL=file`; the four-entry PATH; `CODEMIE_WORKSPACE_TEST_DIR` under `$TMPDIR`; `CODEMIE_TOUR_SHA` = `git rev-parse --short HEAD`, plus `+dirty` when `git status --porcelain` prints anything.
  - "the build uses target/tour and --features tour".
  - "a held lock refuses": with `$TMPDIR/connect-tour.lock` made first, exit 3 and "Another tour is running.".
  - "the script kills only its own PID": `grep` the script for `kill`; every occurrence is `kill "$pid"` or `kill -9 "$pid"`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** `run.sh` per spec § 9:
  - `set -euo pipefail`;
  - a `trap` that removes the lock and kills `$pid` if it is still alive;
  - the 660 s watchdog as a background subshell on `$pid` only;
  - the report step runs whenever `results.json` exists;
  - print `Report: <path>` and exit with the app's code.

- [ ] **Step 4: Run, expect PASS**, then `npm test`.

- [ ] **Step 5: Commit** `feat(tour): make tour builds, seeds, runs and reports`

### Task 9: The tour in the pipeline and the guides

**Files:**
- Modify:
  - `docs/superpowers/specs/2026-11-22-workspace-next-rollout-design.md` (Definition of done item 4, spec § 10 wording);
  - `docs/superpowers/specs/2026-11-24-profiles-models-design.md` (its Definition of done: add `make tour`);
  - `.ai-run/guides/testing/testing-patterns.md` (Smoke modes table: a `CODEMIE_TOUR` row; Quick reference: "Run the real-app tour | `make tour`");
  - `.ai-run/guides/architecture/architecture.md` (Configuration: `CODEMIE_TOUR`, `CODEMIE_TOUR_SHA`; the Smoke mode flags row);
  - `.ai-run/guides/quality-gates.md` (a `### tour` gate: Run `make tour`, Pass exit 0 and `TOUR {"pass":true…}`, Fail exit 1/2/3, Side effects: builds `src-tauri/target/tour`, writes `$TMPDIR/connect-tour-*` and `output/tour/`).

- [ ] **Step 1: Edit the five files** with the spec's words (no new rules beyond the spec).
- [ ] **Step 2: Verify** with `grep -n "make tour" docs/superpowers/specs/2026-11-22-workspace-next-rollout-design.md .ai-run/guides/quality-gates.md .ai-run/guides/testing/testing-patterns.md`: at least one line each.
- [ ] **Step 3: Commit** `docs(tour): make tour is item 4 of the Definition of done`

### Task 10: Run the tour for steps 0–7 and produce the report

**Files:** none changed, unless a stop is wrong. A wrong stop is fixed in `script.js` with its test in its own commit. A product bug is reported to the controller, not fixed here.

- [ ] **Step 1: Gates**: `make check`, and `cd src-tauri && cargo build --release`. Expected: pass.
- [ ] **Step 2: Run** `make tour` (first build takes several minutes; `run_in_background`).
  Expected:
  - exit 0;
  - `TOUR {"pass":true…}`;
  - `Report: output/tour/<stamp>-<sha>/index.html`.
- [ ] **Step 3: Check the evidence**:
  - 29 screenshots (T28 has none), none blank;
  - the coverage table has no red row;
  - each amber row's check file exists and holds the check named (`grep` it);
  - the ops list holds no `action_*` and no send;
  - `<run>/home/Library/Logs/CodeMie/codemie_wizard.log` exists, which proves the session log stayed in the test folder.
- [ ] **Step 4: If a stop fails**: re-run that stop alone (`make tour ONLY=T<nn>`) once and report both results. A failing check that the browser run passes for the same feature is a real-app bug: report it with the stop's screenshot and stop.
- [ ] **Step 5: Hand the report path, the verdict and the red/amber/green counts to the controller**, which shows the report to the user as the step 0–7 evidence for item 4. Nothing to commit unless Step 4 changed a stop.
