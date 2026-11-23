# Task provider and the Todoist plugin (step 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers also follow the shared rules in `.superpowers/sdd/common-implementer.md`.

**Goal:** Tasks get one active provider:
- built-in Local (Connect) by default; a provider plugin replaces it while it is on, everywhere a task is shown or added;
- the core keeps a cache and an outbox and talks to the provider through the QuickJS host, window open or closed;
- the first provider is a Todoist plugin in `codemie-connect-marketplace` that works the way the reference app uses Todoist;
- with a provider on, the Tasks page shows the reference app's date layout.

**Architecture:**
- Native: `commitment` records gain `provider`, `key`, `kind`, `remote`, `pending`, `syncError`, `handled`. A new module `src-tauri/src/workspace/task_provider/` holds the `TaskProviders` trait, keys and the ledger, the outbox, the `task_sync` job, the merge and the new operations.
- Plugins: `"provides": ["tasks"]` with `"requires": ["tasks_provider"]`, `ctx.tasks.provide({...})` in the prelude, and the manager implementing `TaskProviders` over `PluginHost::ask(id, "tasks:<op>")`. `plugins_request set_setting` keeps secrets write-only.
- Marketplace: `plugins/todoist/main.js` (host half only), with node tests over a fake ctx and a fake Todoist.
- UI: `tasksOf` filters by the active provider, a pure By date model and view, Settings › Tasks, `providerTaskTarget` for the meeting column, the Today widget and Inbox toasts.

**Tech Stack:** Rust (Tauri v2), `cargo test`; vanilla JS ES modules, `node:test`; Playwright (`playwright-core` 1.63) against the mocked bridge; the plugin's QuickJS host half; Todoist API v1 (faked, never real).

**Spec:** `docs/superpowers/specs/2026-11-23-task-provider-design.md` (§ numbers below refer to it). Definition of done: `docs/superpowers/specs/2026-11-22-workspace-next-rollout-design.md` § "Definition of done for every step". Real-desktop GUI checks and the live token check are deferred to the end of the rollout; this step's real-app checks are the headless smokes.

## Global Constraints

- **Repositories, branches, commits:**
  - Connect: `/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect`, branch `feat/workspace-next` (checked out). Do not switch branches or push.
  - Marketplace: `/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect-marketplace`, branch `main`. Commit locally; **push only in Task 12 Step 7**, with the user's explicit yes.
  - One commit per task (per repository), Conventional Commit subject, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Running things:**
  - Raw `cargo` from `src-tauri/` with `export PATH="$HOME/.cargo/bin:$PATH"`; `make`, `npm`, `node` from the repo root; macOS/zsh syntax (BSD `sed`, `find`).
  - Skip the known failure: `cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`.
  - Browser run: `PLAYWRIGHT_CORE=/Users/Nikita_Levyankov/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs`, outside the sandbox (`dangerouslyDisableSandbox: true`). One set: prefix `WORKSPACE_E2E_ONLY=<set>`. A normal task runs the sets it touches plus `compact` and `layout`; the whole run (about 40 minutes, `run_in_background`) is for Task 12.
  - Marketplace gates: `scripts/check.sh` from the marketplace root (`node --check`, then `node --test 'tests/**/*.test.mjs'`).
- **Safety, every task:**
  - Never type, read, print or store a real Todoist token. Tests use the sentinel `tk_SENTINEL_do_not_log_0123456789` and a fake Todoist.
  - No network in any test. The plugin's network is exactly `["api.todoist.com"]`; Rust tests map it to a loopback fake through `Client::for_tests`.
  - The token never enters a snapshot, a fixture, a log, the outbox, a frame or an error message (§8).
  - Nothing is sent to a person without the step-2 Send. Switching, turning off or removing a provider deletes and closes nothing (§11).
  - With Local active, every existing task test and browser check passes unchanged.
- **Code rules:**
  - Views and models stay pure (`view-*.js`, `*-model.js`, `settings-tasks.js`); only controllers and `app.js` touch the DOM; writes go through `mutate`; every provider string goes through `escapeHtml`.
  - Native writes of a task and its outbox entry share one repository transaction; the lock order stays `meeting_lock` then the repository.
  - New Tauri-facing state goes through `workspace_request` or `plugins_request`, both already caller-checked; no new Tauri command.
  - Default and Compact draw the same markup.
- **Values:**
  - key: first 16 hex of `sha1("<source>#<normalized text>")`, the reference app's `normalizeCommitment` (NFKC, lower case, keep letters, digits and `#`, collapse the rest to one space, trim);
  - key sources: `meeting:<meetingId>:<line>`, `message:<sourceId>`, `manual:<task id>`;
  - kinds: `task | reply | waiting | budget`; labels `reply`, `waiting`, `budget`, app label default `connect`; project default `Connect`;
  - states: `local | ready | syncing | offline | rate_limited | needs_token | off | failed`;
  - outbox ops `create | update | complete | remove`; at most 50 entries a pass;
  - cadence: pull at most every 60 s, background every 300 s, `task_sync_now` at most once in 30 s; offline backoff 30 s doubling to 900 s; `rate_limited` default 60 s; provider answer limit 30 s;
  - budget: 4 requests a second, 300 per 15 minutes;
  - `task_bulk` at most 200 items; By date two columns from 1100 px; Later folds Next 7 days (1–7 days), No date, Later than that (> 7 days);
  - marker lines, last, in order: `key: `, `source: `, `meeting: `, `owner: `.
- **Copy, verbatim from the spec § Copy** (each task quotes the strings it draws). Refusals: "Choose Connect or an installed task plugin.", "Turn <name> on in Settings › Plugins first.", "Choose up to 200 tasks."; sheet line "Hold your tasks: what you add and change in Connect goes to it, and Connect shows the tasks it lists."
- **Contract fixtures:** after a native shape change run `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures` and commit the JSON with the change.

## Review Focus

1. **A create times out after Todoist made the task, and the app quits before the answer.** On the next launch the replayed create adopts the task by key; Todoist holds exactly one. (Task 3 `a_create_lost_after_todoist_answered_is_adopted_not_repeated`; Task 6 the same case against the real plugin and the fake Todoist.)
2. **The user edits a task's due date in Connect while offline, and changes its text in Todoist meanwhile.** Both changes survive; when both changed the same field, the later one wins and the history says so. (Task 3 `merge_keeps_both_sides_and_the_later_edit_of_one_field`.)
3. **A user who never touches Todoist.** Local's board, the meeting column, the Today widget, the reminder and every old fixture behave as before, and no `task_sync` job is ever queued. (Task 1 `local_saves_queue_nothing`, Task 11 P12.)
4. **The token shows up somewhere.** A sentinel token saved through Settings appears in no snapshot, fixture, log line, outbox entry, `installed` answer, DOM or `localStorage`, and in no provider error message even when Todoist echoes the request. (Task 2 `secret_settings_are_write_only`, Task 3 `a_provider_message_with_the_token_is_dropped`, Task 5 `no_message_carries_the_token`, Task 11 P2.)
5. **Switching back and forth with work in flight.** Local → Todoist (copy) → Local → Todoist with three unsent changes: nothing is deleted anywhere, the second copy creates nothing new, and the three changes are sent once on return. (Task 4 `switching_back_and_forth_deletes_nothing_and_copies_once`.)

---

### Task 1: Task records with a provider, keys, settings and the snapshot (Local only)

**Files:**
- Create: `src-tauri/src/workspace/task_provider/mod.rs` (module doc, `TaskProviders` trait, `ProviderError`, `ProviderState`, `active_provider`)
- Create: `src-tauri/src/workspace/task_provider/keys.rs` (`normalize`, `task_key`, ledger read and write)
- Modify:
  - `src-tauri/src/workspace/mod.rs` (`mod task_provider;`, `Core.task_providers: OnceLock<Arc<dyn TaskProviders>>`, `set_task_providers`, the snapshot's `taskProvider`);
  - `src-tauri/src/workspace/models.rs` (`Settings.tasks: TaskSettings` near :215);
  - `src-tauri/src/workspace/tasks.rs` (`task_save` stamps `provider` and `key`, accepts `kind`; `tasks::active`; `due_today_reminders` :557 reads `active`);
  - `src-tauri/src/workspace/automations/context.rs` (:582, read `tasks::active`).
- Modify: `ui/workspace/tasks-model.js` (`tasksOf`, `activeProvider`)
- Fixtures: regenerate `task-records.json`, `task-delete.json` and every settings-carrying fixture; create `task-provider-states.json` (the `local` state only for now; Task 3 adds the rest).
- Test: `src-tauri/src/workspace/tasks.rs` tests, `task_provider/keys.rs` tests, `ui/test/tasks-model.test.mjs`

**Interfaces:**
- Produces (Rust):
  - `pub(crate) struct TaskSettings { pub provider: String /* "local" */, pub copy_offered: Vec<String> }`, serde camelCase, `#[serde(default)]`.
  - `pub(crate) fn active_provider(s: &Settings) -> &str` → `"local"` or `"plugin:<id>"`.
  - `pub(crate) fn tasks::active(r: &Repository, workspace: &str) -> Result<Vec<Record>>`: the records whose `provider` (absent = `"local"`) equals the active one.
  - `pub(crate) fn keys::normalize(text: &str) -> String`, `pub(crate) fn keys::task_key(source: &str, text: &str) -> String` (16 hex).
  - `pub(crate) fn keys::ledger_get(r, provider, key) -> Result<Option<Value>>` and `ledger_put(r, provider, key, remote_id: Option<&str>, state: &str, now)`: kind `task_key`, id `<provider>|<key>`, unversioned.
  - `pub trait TaskProviders: Send + Sync { fn call(&self, plugin: &str, op: &str, args: Value) -> BoxFuture<'static, Result<Value, ProviderError>>; fn available(&self) -> Vec<ProviderInfo>; fn secret_matches(&self, plugin: &str, text: &str) -> bool; }`, with `ProviderInfo {id: String /* "plugin:<id>" */, name, on: bool, ready: bool}`.
  - `pub enum ProviderError { NeedsToken, RateLimited { retry_after: u64 }, Offline, NotFound(String), Refused(String) }` and `pub fn ProviderError::parse(message: &str) -> ProviderError` (the prefix mapping in §5).
  - In the snapshot: `taskProvider {active, name, available, state, pending, parked, lastSync, retryAt, message, copyOffered}`. With Local: `state: "local"`, `name: "Connect"`, `available: [{id: "local", name: "Connect"}]` plus any providers.
- `task_save` on create: `provider` = the active provider unless the data names one; `key` = `task_key(source, text)`, where `source` is `meeting:<meetingId>:<line>` when both are given, else `message:<sourceId>` when given, else `manual:<id>`; `kind` ∈ `task|reply|waiting|budget`, refused otherwise with "Choose a kind of task." (`field: kind`). A saved task without a `key` gets one.
- Produces (JS): `activeProvider(s) → s.taskProvider?.active || 'local'`; `tasksOf(s)` keeps the `commitment` records whose `data.provider || 'local'` equals it.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn task_key_matches_reference_normalization()
// task_key("meeting:m1:4", "I'll send you the names by Friday.") == task_key("meeting:m1:4", "  i'll SEND you the names, by friday ")
// len 16, all hex; another source gives another key; normalize("Ёлка — #2!") == "ёлка #2"
#[test] fn task_save_stamps_provider_key_and_kind()
// Local: no "provider" field written, key present, kind absent reads "task";
// with settings.tasks.provider = "plugin:todoist": provider "plugin:todoist"; kind "bogus" → Err field "kind"
#[test] fn tasks_active_and_the_reminder_follow_the_provider()
// a local and a todoist task both due today: the reminder names only the active provider's
#[tokio::test] async fn local_saves_queue_nothing()        // no job of kind task_sync, no task_outbox record
#[tokio::test] async fn contract_fixtures_match_the_task_provider_states()  // writes task-provider-states.json {local: <taskProvider>}
#[test] fn provider_error_parses_the_prefixes()
// "needs_token: x"→NeedsToken; "rate_limited:120: slow"→RateLimited{120}; "offline: x"→Offline;
// "not_found: gone"→NotFound("gone"); "refused: Todoist didn't accept the change (400)"→Refused(..); "boom"→Offline
```

JS (`tasks-model.test.mjs`): `'tasksOf keeps the active provider's tasks; no taskProvider means Local'`.

- [ ] **Step 2: Run them and see them fail.** `cd src-tauri && cargo test task_provider:: tasks::` and `node --test ui/test/tasks-model.test.mjs`. Expected: FAIL (missing items).

- [ ] **Step 3: Implement** the items in Interfaces. Use the `sha1` crate already in the tree if present, else add `sha1 = "0.10"` (Cargo.lock updated, per `development-practices.md`). `normalize` uses `unicode-normalization` NFKC if it is in the tree; otherwise add it.

- [ ] **Step 4: Fixtures and the suite.** `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, then the whole suite with the skip, then `npm test`. Expected: every test passes. `task-records.json` differs only by `key`, and the settings fixtures only by `tasks`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui/workspace/tasks-model.js ui/test
git commit -m "feat(tasks): task records carry a provider, a stable key and a kind; Local stays the default"
```

### Task 2: The plugin role, `ctx.tasks.provide`, host wiring and write-only settings

**Files:**
- Modify:
  - `src-tauri/src/plugins/manifest.rs` (`FEATURES` :20 gains `"tasks_provider"`; `Manifest.provides: Vec<String>`; `Raw.provides` accepts a string or an array; unknown role → `ManifestError::Invalid("provides a role Connect doesn't know (<role>)")`);
  - `src-tauri/src/plugins/capabilities.rs` (`sheet` :157 adds the role's line);
  - `src-tauri/src/plugins/host/prelude.js` (`tasks: {provide}` beside `deliver` :291);
  - `src-tauri/src/plugins/services/mod.rs` (route `tasks.provide` :344 area) and a new `src-tauri/src/plugins/services/tasks.rs`;
  - `src-tauri/src/plugins/manager.rs` (an `impl TaskProviders`, set on `Core` next to the `EventSink`);
  - `src-tauri/src/plugins/extras.rs` (the `settings` view) and `src-tauri/src/plugins/commands.rs` (`set_setting` op near `set_addresses` :499, doc table);
  - `src-tauri/src/plugins/services/contract_tests.rs` (a case for the new member).
- Fixtures: create `plugin-settings.json` (the `installed` settings view of a synthetic provider plugin, with the secret as `set`).
- Modify: `ui/test/browser/workspace-e2e.mjs` (`plugins_request` mock :1180: `set_setting`; `installed` items carry `settings`)
- Test: tests in each modified Rust file

**Interfaces:**
- Consumes: `TaskProviders`, `ProviderInfo`, `ProviderError` (Task 1).
- Produces:
  - prelude: `ctx.tasks.provide({status, list, changedSince, create, update, complete, remove})`. Each given function becomes provider `tasks:<op>`. A plugin whose manifest lacks `provides: ["tasks"]` gets `permission`: "<id> doesn't provide tasks (provides in its manifest)".
  - `services::tasks::call(s, p, "tasks.provide", args)` records `{plugin, ops}` in `Services.task_plugins`.
  - `impl TaskProviders for Manager`:
    - `call` → `host.ask(id, "tasks:<op>", args)` under `tokio::time::timeout(30 s)`; a host error message goes through `ProviderError::parse`; `timeout` → `Offline`;
    - `available()` → installed plugins whose manifest provides tasks, with `on` (enabled), `ready` (loaded and registered);
    - `secret_matches(plugin, text)` → whether `text` contains any of that plugin's stored secret values (for Task 3's message check).
  - `plugins_request set_setting {id, key, value}` → `Installed`:
    - refuses an undeclared key ("<id> has no setting “<key>” in its manifest") and `hosts_from` keys;
    - a secret: `""` or `null` clears; stored through `settings::write_private`;
    - after a provider's secret changes, calls `core.task_sync_now()` (Task 3 defines it; until then a no-op stub with that name).
  - `installed[].settings: [{key, label, type, help, value} | {key, label, type: "secret", help, set: bool}]`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn provides_tasks_parses_and_needs_the_feature()
// "provides": "tasks" and ["tasks"] both → vec!["tasks"]; ["calendar"] → Invalid("provides a role Connect doesn't know (calendar)");
// check_compat passes with requires ["tasks_provider"]
#[test] fn the_sheet_says_it_holds_your_tasks()   // line text exactly the spec's
#[tokio::test] async fn a_provider_plugin_answers_tasks_ops_through_the_host()
// testkit plugin main.js: ctx.tasks.provide({status: async () => ({ok: true, account: 'Taylor', project: 'Connect'})});
// Manager as TaskProviders: call("todoist","status",{}) == that; available() == [{id:"plugin:todoist", name:"Todoist", on:true, ready:true}]
#[tokio::test] async fn tasks_provide_is_refused_without_the_role()
#[tokio::test] async fn provider_errors_map_to_codes()   // main.js throws new Error('rate_limited:90: slow down') → RateLimited{90}
#[test] fn secret_settings_are_write_only()
// set_setting(token = SENTINEL) → secrets.json mode 0600 under the private root; installed() JSON contains no SENTINEL and "set": true;
// the data root holds no SENTINEL (walk and grep); set_setting(token = "") → "set": false
#[tokio::test] async fn contract_fixtures_match_the_plugin_settings()  // plugin-settings.json
```

- [ ] **Step 2: Run them and see them fail.** `cargo test plugins::`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces, mirroring `deliver.provide` (registration recorded in `Services`, dropped when the plugin unloads). Register the trait on `Core` the way `set_event_sink` is called.

- [ ] **Step 4: Fixtures, the suite, isolation.** Regenerate the fixtures and run the whole suite with the skip. Then build and run `CODEMIE_WORKSPACE_TEST_DIR=$(mktemp -d)/workspace CODEMIE_PLUGIN_SMOKE=isolation ./target/debug/app` (the prelude changed). Expected: all pass; isolation smoke exit 0.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui/test
git commit -m "feat(plugins): a tasks provider role, ctx.tasks.provide and write-only plugin secrets set in Connect"
```

### Task 3: The outbox, the `task_sync` job and the merge

**Files:**
- Create:
  - `src-tauri/src/workspace/task_provider/outbox.rs`;
  - `src-tauri/src/workspace/task_provider/sync.rs` (push, pull, backoff, budget);
  - `src-tauri/src/workspace/task_provider/merge.rs`;
  - `src-tauri/src/workspace/task_provider/wire.rs` (record ⇄ wire task);
  - `src-tauri/src/workspace/task_provider/fake.rs` (`#[cfg(any(test, feature = "test-support"))] FakeProvider`).
- Modify:
  - `src-tauri/src/workspace/tasks.rs` (`task_save` and `task_delete` enqueue in the same transaction when the provider isn't Local);
  - `src-tauri/src/workspace/mod.rs` (`background_round` :459 queues `task_sync` every 300 s; the job dispatch; `task_sync_now`; the snapshot's state fields).
- Fixtures: extend `task-provider-states.json` with every state; create `task-sync-cases.json`.
- Test: tests in the new files

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `outbox::enqueue(r, task: &Record, op: &str, patch: Value, now) -> Result<()>`: kind `task_outbox`, unversioned; coalesces into the last waiting `update` of the same task; sets the task's `pending: true`.
  - `outbox::waiting(r, provider) -> Result<Vec<Value>>`, oldest first; `outbox::park(r, id, message)`; `outbox::drop_for(r, task_id, op)`.
  - `wire::to_wire(task: &Record) -> Value` and `wire::from_wire(v: &Value, provider: &str) -> Value` (a body), per §5's shape.
  - `merge::merge(local: &Value, remote: &Value, edited_at: i64) -> (Value, Vec<String>)`: the new body and its history lines, per §4's rule.
  - `sync::run(core: &Arc<Core>, provider: &str, now) -> Result<SyncOutcome>`, the `task_sync` job's executor:
    - pushes up to 50 entries, then pulls `changedSince` with the cursor stored in `task_state` `sync:<provider>`;
    - keeps `{cursor, lastSync, backoffUntil, backoff, state, message, requests: [timestamps]}` there;
    - enforces 4 requests a second and 300 per 15 minutes by waiting.
  - `Core::task_sync_now(self: &Arc<Self>) -> Result<Value>`: queues `task_sync:<provider>` unless one ran in the last 30 s; answers `{queued}`. The read-only `workspace_request` op `task_sync_now` maps to it (Operation variant `TaskSyncNow`, answered before the mutation lock).
  - Snapshot state:
    - `pending` is the count of waiting entries, `parked` the parked ones;
    - `state` comes from the plugin's availability (off / failed) and the last outcome (offline / rate_limited / needs_token / ready), `syncing` while the job runs;
    - `message` is a provider's refusal text unless `secret_matches`, then `null`.
  - `FakeProvider::new()`: scripted `answer(op, Result<Value, ProviderError>)`, an in-memory Todoist-like store (`create` adopts by key), `calls()`.

- [ ] **Step 1: Write the failing tests** (each over `test_core` with `FakeProvider` set as `TaskProviders` and the provider `plugin:todoist`)

```rust
#[tokio::test] async fn a_save_while_offline_waits_and_replays_in_order()
// fake Offline; save t1 (create), edit t1 due, save t2; outbox has 2 entries (t1 coalesced), state "offline", backoff 30 s;
// fake back; run sync: calls = [create t1, create t2, changedSince]; outbox empty; both tasks have remote.id; pending false
#[tokio::test] async fn a_task_waits_for_its_create_and_updates_coalesce()
#[tokio::test] async fn a_create_lost_after_todoist_answered_is_adopted_not_repeated()   // Review Focus 1
// fake makes the task, then the call reports Offline; next run: create answers adopted:true; the fake store holds one task with that key
#[tokio::test] async fn a_refused_entry_parks_and_blocks_nothing()
// t1 update → Refused("Todoist didn't accept the change (400)"); t2 create goes through; t1 syncError is that sentence; parked == 1
#[tokio::test] async fn rate_limited_waits_until_retry_at_and_needs_token_stops()
// RateLimited{120}: no call before now+120; NeedsToken: no call until set_setting(token) queues a sync
#[tokio::test] async fn offline_backoff_doubles_to_fifteen_minutes()   // 30, 60, … 900, reset on success
#[tokio::test] async fn the_request_budget_is_kept()   // 400 waiting entries: never more than 300 calls in a 15-min window, ≤4/s
#[tokio::test] async fn pull_adds_updates_and_removes()
// unknown remote → new record with provider, kind from labels; removed id → record gone and ledger "removed"; done → status done
#[test] fn merge_keeps_both_sides_and_the_later_edit_of_one_field()   // Review Focus 2
// base {text:A,due:D1}; local due D2 at t=200; remote text B, updatedAt t=100 → {text:B, due:D2};
// both changed due: remote D3 at t=300 → D3 with history "Todoist had a newer due date; Connect kept it."
#[test] fn done_beats_an_edit_and_a_delete_beats_everything()
#[tokio::test] async fn a_provider_message_with_the_token_is_dropped()   // Refused containing SENTINEL → message null, code kept
#[tokio::test] async fn the_window_closed_core_syncs_on_the_background_round()
// no UI call: background_round after 300 s queues and runs task_sync for a queued create
#[tokio::test] async fn contract_fixtures_match_the_task_sync_cases()
// task-provider-states.json: one taskProvider per state; task-sync-cases.json: {offlineReplay, adopted, parked, merged} as real records
```

- [ ] **Step 2: Run them and see them fail.** `cargo test task_provider::`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces. Store the remote id in the task and the ledger before removing a `create` entry. Write history lines with the spec's copy.

- [ ] **Step 4: Fixtures and the suite.** Regenerate, then the whole suite with the skip. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui/test/fixtures/contract
git commit -m "feat(tasks): a provider cache and outbox, synced in order with backoff, a request budget and a field merge"
```

### Task 4: Switching, withdraw, bulk, looks handled, parked entries and delete

**Files:**
- Create: `src-tauri/src/workspace/task_provider/ops.rs` (`Core.task_provider_op`), `src-tauri/src/workspace/task_provider/handled.rs` (the own-reply sweep)
- Modify:
  - `src-tauri/src/workspace/models.rs` (Operation variants `TaskProviderSet`, `TaskWithdraw`, `TaskBulk`, `TaskHandled`, `TaskParked` near :142);
  - `src-tauri/src/workspace/mod.rs` (dispatch; call the sweep after each Graph sync round that changed messages);
  - `src-tauri/src/workspace/tasks.rs` (`create_by_key` for step 5);
  - `ui/workspace/store.js` (`REBASE_SAFE` :20 gains `task_provider_set`, `task_withdraw`, `task_bulk`, `task_handled`, `task_parked`).
- Modify: `ui/test/browser/workspace-e2e.mjs` (the workspace mock answers the five ops and `task_sync_now`, and keeps `taskProvider` in the mocked snapshot)
- Test: tests in `ops.rs`, `handled.rs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (§12):
  - `task_provider_set {provider, copy?}` → `{provider, copied}`:
    - validates against `available()`; re-stamps To review tasks; adds the provider to `copyOffered` once;
    - `copy: true` creates provider records for open Local tasks (`todo|doing|waiting`), each with `copiedFrom`, the same `key`, history "Copied from Connect", and queues their creates; a task whose key the ledger already knows creates nothing;
    - queues a full pull (cursor reset) on a switch to a provider.
  - `task_withdraw {ids}` → `{done, failed}`: status `review`, log "Moved back to review"; drops a waiting `create`, else enqueues `remove` and marks the ledger `withdrawn`.
  - `task_bulk {items: [{id, due?, status?}]}` → `{done, failed, before}`; more than 200 → "Choose up to 200 tasks." (`field: items`).
  - `task_handled {id, action: "done"|"keep"}` or `{id, evidence}` → `{id}`; keep appends `sha1(evidence)[..16]` to `keptEvidence`; evidence already kept sets nothing.
  - `task_parked {id, action: "retry"|"discard"}` → `{id}`.
  - `task_delete` with a provider enqueues `remove` (ledger `removed`); a later `task_save` of the returned body creates again with the same key.
  - `handled::sweep(core, now)`: for each open `reply` task with `sourceId`, a newer message from the user in the same conversation completes it with `handled {evidence: "you replied in Teams at 17:32", auto: true}` and the history line "Closed: you replied in Teams at 17:32" ("in Outlook" for mail), zone-local time.
  - `tasks::create_by_key(core, workspace, body, key) -> Result<(String, bool)>` (id, created): an existing record or a live ledger entry with that key → `(id, false)`.

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test] async fn switching_back_and_forth_deletes_nothing_and_copies_once()   // Review Focus 5
// 3 open local, 1 review; set todoist copy:true → copied 3, review re-stamped, local 3 untouched;
// set local → todoist records kept (hidden), review back to local; 3 edits queued while todoist off stay queued;
// set todoist copy:true again → copied 0; queued edits sent once; fake store never saw a remove or close
#[tokio::test] async fn task_provider_set_refuses_unknown_and_off_plugins()   // both refusals, field "provider"
#[tokio::test] async fn withdraw_drops_an_unsent_create_or_removes_a_sent_one()
#[tokio::test] async fn bulk_moves_and_answers_before_for_undo()   // 201 items refused
#[tokio::test] async fn handled_keep_and_done()
#[tokio::test] async fn the_sweep_closes_only_reply_tasks_the_user_answered()
// reply task + my newer Teams message → done, history "Closed: you replied in Teams at 14:32" (Europe/Kyiv);
// someone else's newer message → untouched; a task kind "task" → untouched
#[tokio::test] async fn delete_with_a_provider_removes_and_undo_creates_again()
#[tokio::test] async fn create_by_key_is_idempotent()
```

- [ ] **Step 2: Run them and see them fail.** `cargo test task_provider::`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Fixtures and the suite.** Regenerate if a shape changed, then the whole suite with the skip, then `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui/workspace/store.js ui/test
git commit -m "feat(tasks): switch providers safely, withdraw, bulk moves, looks handled and the own-reply sweep"
```

### Task 5 (marketplace repo): The Todoist plugin's mapping, with a fake ctx and a fake Todoist

**Files (all in `codemie-connect-marketplace`):**
- Create:
  - `plugins/todoist/echo-plugin.json` (exactly §7's manifest);
  - `plugins/todoist/main.js` (exported pure helpers; `apply(ctx)` comes in Task 6);
  - `plugins/todoist/icon.svg`, `plugins/todoist/README.md` (what it does, settings, labels, markers, changelog "1.0.0: first version");
  - `tests/helpers/fake-ctx.mjs` (a subset of echo-plugins' `fake-ctx.mjs`: `settings`, `http.fetch` over a handler, `store`, `tasks.provide`, `run(op, args)` calling the provided function, `log` recorded);
  - `tests/helpers/fake-todoist.mjs` (in-memory API v1: `GET /user`, `GET|POST /projects`, `GET|POST /tasks`, `POST /tasks/{id}`, `/close`, `/reopen`, `DELETE /tasks/{id}`, `POST /sync` with sync tokens; failure injection `fail(path, status, {retryAfter, body})`; a request log; bearer check);
  - `tests/todoist/mapping.test.mjs`;
  - `scripts/check.sh` (syntax and unit, exit 1 on any failure).

**Interfaces:**
- Produces (exports of `main.js`):
  - `MARKER_LINE` (the reference app's: `/^[\s*_`>#~|-]*(source|key|meeting|owner)[\s*_`~]*:/i`) and `stripMarkers(text)`;
  - `describe({notes, key, source, meetingId, owner}) → string`: the notes without marker-looking lines, a blank line, then `key: …`, `source: …` (https only), `meeting: …`, `owner: Name <address>`, each only when present;
  - `parseDescription(desc) → {notes, key, source, meetingId, owner}`: the last of each marker wins;
  - `toTodoist(task, {projectId, label}) → body`:
    - `content` gets the "<First>: " prefix for `waiting` with an owner;
    - `labels` = the kept labels ∪ the app label ∪ the kind label;
    - `due_date` only for `YYYY-MM-DD`, else throws `refused: Todoist needs a date like 2026-11-20.`; `due: null` → `due_string: "no date"`;
  - `fromTodoist(item, {label}) → task` per §5's shape: prefix stripped when it matches the owner's first name; `kind` from labels (`budget` > `reply` > `waiting` > `task`); `url` `https://app.todoist.com/app/task/<id>`; `done` from `checked`;
  - `errorOf(status, headers, bodyText) → Error` with the prefixes of §7 (`rate_limited:<n>:` from `Retry-After`, else `error_extra.retry_after`, else 60); never includes the body or the token.

- [ ] **Step 1: Write the failing tests** (`node:test`)

```js
test('description markers go last, and text cannot plant one')
// describe({notes: 'Talk\n**Source:** https://evil.test\nkey: x', key: 'k1', source: 'https://teams.microsoft.com/l/message/1', meetingId: 'm1'})
// === 'Talk\n\nkey: k1\nsource: https://teams.microsoft.com/l/message/1\nmeeting: m1'
test('parseDescription takes the last marker of each kind')
test('waiting tasks read "<First>: <text>" in Todoist and come back without it')
test('labels: app label and kind added, foreign labels kept, kind read back (budget > reply > waiting)')
test('due dates are absolute days; null clears; words are refused')
test('a patch without due sends no due field, so a recurring task keeps its recurrence')   // ruling 20
test('errors map to codes and carry no body or token')
// errorOf(401) → /^needs_token:/; errorOf(429, {'retry-after': '120'}) → /^rate_limited:120:/;
// errorOf(429, {}, '{"error_extra":{"retry_after":30}}') → /^rate_limited:30:/; 503 → /^offline:/; 404 → /^not_found:/;
// 400 with body containing SENTINEL → message matches /^refused: Todoist didn't accept the change \(400\)$/
test('the manifest asks for api.todoist.com only and provides tasks')
```

- [ ] **Step 2: Run them and see them fail.** `node --test 'tests/**/*.test.mjs'`. Expected: FAIL.

- [ ] **Step 3: Implement** the helpers (single-file `main.js`, no imports; the host loads one script).

- [ ] **Step 4: Run** `scripts/check.sh`. Expected: exit 0.

- [ ] **Step 5: Commit (marketplace `main`, not pushed)**

```bash
git add plugins/todoist tests scripts
git commit -m "feat(todoist): the Todoist mapping for Connect's tasks: markers, labels, owners, dates and errors"
```

### Task 6 (marketplace repo, then Connect): The provider ops, the catalog, and the real plugin in Connect's host

**Files:**
- Marketplace:
  - modify `plugins/todoist/main.js` (`apply(ctx)` with `ctx.tasks.provide`);
  - modify `echo-marketplace.json` (`featured: ["todoist"]`, plugin `{id: "todoist", source: "./plugins/todoist", categories: ["tasks"]}`);
  - modify `README.md` (the table's Todoist row says "available");
  - create `tests/todoist/provider.test.mjs`.
- Connect:
  - create `src-tauri/tests/connect_marketplace.rs`, reading `CONNECT_MARKETPLACE_DIR` (default `$HOME/repos/codemie-ai/codemie-connect-marketplace`) and skipping with `skipped:` when missing;
  - modify `src-tauri/src/testing.rs` (`FakeTodoist`: a loopback HTTP server with the same endpoints as `fake-todoist.mjs`, after the `http.rs` test `serve` pattern);
  - modify `src-tauri/src/plugins/services/http.rs` (`Client::for_tests` also under `feature = "test-support"`);
  - modify `src-tauri/src/commands/plugin_smoke.rs` (for each plugin that provides tasks, call `tasks:status` and record `{plugin, status: "ok" | <code>}`; `needs_token` counts as a pass);
  - modify `.ai-run/guides/testing/testing-patterns.md` (the new integration test and the smoke's tasks line).

**Interfaces:**
- Consumes: Task 5's helpers; Task 2's prelude and `TaskProviders`; Task 3's `FakeProvider` shape (the ops' answers must match it).
- Produces (each op as §5's table):
  - `status`: `GET /user`, then the project; answers `{ok: true, account: full_name, project}`.
  - The project: found by name (paged), else `POST /projects {name}` once; its id kept in `ctx.store` as `project.json` `{name, id}` and re-found when the name setting changes.
  - `list`: paged `GET /tasks?project_id=`.
  - `changedSince({cursor})`: `POST /sync {sync_token: cursor ?? '*', resource_types: ['items']}`, items of the project only.
  - `create({key, task, requestId})`: open tasks scanned for `key: <key>` → `{...fromTodoist(found), adopted: true}`; else `POST /tasks` with header `X-Request-Id: requestId`.
  - `update({id, patch, requestId})`: reads the task, rebuilds the description keeping its markers, merges labels, `POST /tasks/{id}`.
  - `complete({id, done})`, `remove({id})`.
  - Every request has `Authorization: Bearer ${ctx.settings.get('token')}`; no token → `needs_token: Add your Todoist API token in Settings › Tasks.`
- Smoke report gains `tasks: [{plugin, status}]`.

- [ ] **Step 1: Write the failing tests**

Marketplace `provider.test.mjs` (fake ctx over fake Todoist, sentinel token):

```js
test('status finds or makes the project once')            // second status makes no POST /projects
test('create adopts an open task with the same key')      // two creates with key k1 → one task in the store
test('changedSince returns changed, done and removed tasks of the project only')
test('update keeps markers and foreign labels')
test('complete reopens with done:false; remove deletes')
test('no message carries the token')                      // every failure mode: no SENTINEL in any thrown message or ctx.log
test('only api.todoist.com is fetched')
```

Connect `tests/connect_marketplace.rs`:

```rust
#[tokio::test] async fn todoist_installs_with_its_sheet_and_loads()
// sheet lines include "Hold your tasks…" and network api.todoist.com; loads; available() ready
#[tokio::test] async fn todoist_syncs_a_core_task_through_the_real_host()
// test core + real Manager + Client::for_tests(api.todoist.com → FakeTodoist); set_setting token SENTINEL;
// task_provider_set todoist; task_save → sync → FakeTodoist holds it with "key: " line and label "connect";
// edit in FakeTodoist → pull brings it; FakeTodoist answers 429 Retry-After 5 → state rate_limited
#[tokio::test] async fn a_lost_create_is_adopted_by_the_real_plugin()   // Review Focus 1 against the real plugin
```

- [ ] **Step 2: Run them and see them fail.** Marketplace `scripts/check.sh`; Connect `cargo test --test connect_marketplace`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Verify.**
  - `scripts/check.sh` exits 0.
  - The `cargo test --test connect_marketplace` tests pass, and the whole Connect suite passes with the skip.
  - Build, then run `CODEMIE_PLUGIN_SMOKE=/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect-marketplace ./target/debug/app`. Expected: exit 0; `$TMPDIR/connect-plugin-smoke.json` lists `todoist` loaded and `tasks: [{plugin: "todoist", status: "needs_token"}]`.

- [ ] **Step 5: Commit both**

```bash
# marketplace
git add plugins/todoist echo-marketplace.json README.md tests
git commit -m "feat(todoist): provide Connect's tasks from one Todoist project, adopting by key, with a fake Todoist in tests"
# connect
git add src-tauri .ai-run/guides/testing/testing-patterns.md
git commit -m "test(plugins): the real Todoist plugin syncs core tasks against a fake Todoist; the plugin smoke checks task providers"
```

### Task 7: By date: the pure model, the view and its actions

**Files:**
- Create: `ui/workspace/tasks-dates-model.js`, `ui/workspace/view-tasks-dates.js`
- Modify:
  - `ui/workspace/view-tasks.js` (the view switch :55 gains `dates`; `tasksPage` renders `datesView` for it; with a provider, Board is hidden and List's status select offers To do, Waiting and Done);
  - `ui/workspace/tasks-model.js` (`newTasksView(view)` accepts `dates`);
  - `ui/workspace/tasks-controller.js` (new actions);
  - the workspace CSS file the Tasks page uses (`ws-tdate-*` rules, step-1 tokens).
- Test: `ui/test/tasks-dates-model.test.mjs`, `ui/test/tasks-controller.test.mjs`

**Interfaces:**
- Consumes: `tasksOf`, `activeProvider`, `isMine`, `ownerOf`, `dueInfo`, `meetingOf` (tasks-model); `taskProvider` from the snapshot; the ops of Task 4.
- Produces:
  - `dateGroups(records, {now, zone, me}) → {review, late, today, next7, noDate, later, doneToday}`. Open means `todo|doing|waiting`. Each list is sorted by due, then `taskOrder`.
  - `rowOf(record, {me, s, now, zone}) → {id, text, label, checkWith: {first} | null, due: {tone, text}, source: {kind: 'meeting'|'message', id, title} | null, url, pending, syncError, handled}`. `label` is "Check with <first>: <text>" for a waiting row (kind `waiting`, status `waiting`, or someone else's owner).
  - `chipsFor(group) → [['Tomorrow', key], ['Monday', key], ['Pick date…', null]]` for late and today; `[['Today'…], ['Tomorrow'…], ['Pick date…']]` for the later folds.
  - `statusLine(taskProvider, now, zone) → string`, the spec's header copy.
  - `defaultView(s)`: `'dates'` with a provider, else `'board'`.
  - `datesView(p) → html` (pure): §9's sections, folds, rows, banners, footer and the Late ⋯ menu (`data-menu="tasks-late"`).
  - Controller actions:
    - `tasks-fold` (`data-fold`), `task-row-open`, `task-snooze` (`data-id`, `data-value`), `task-pick-date`;
    - `tasks-late-move` (`data-to` = `tomorrow|monday|pick`) and `tasks-late-done`, each one `task_bulk` with footer Undo sending `before`;
    - `task-handled` (`data-act`), `task-parked` (`data-act`), `task-nudge` (opens `#/inbox/<sourceId>` with the reply box filled "Hi <first>, any news on <text>?", nothing sent), `tasks-sync` (`task_sync_now`), `task-accept` (existing), `task-dismiss` (existing).
  - The done box uses the existing `task-done`.

- [ ] **Step 1: Write the failing tests**

```js
// tasks-dates-model.test.mjs, now = Wed 18 Nov 2026 12:00 Europe/Kyiv
test('groups: late, today, next 7 days, no date, later than that; done today counted')
// due 11-16 → late; 11-18 → today; 11-25 → next7; 11-26 → later; none → noDate; review → review
test('waiting rows read "Check with <first>: <text>" and sit at their check date')
test('chips: Tomorrow/Monday/Pick date… for late and today, Today/Tomorrow/Pick date… for later')
test('statusLine covers every provider state')   // from task-provider-states.json
test('datesView escapes provider text and draws only folds with rows')
test('defaultView: dates with a provider, board with Local; Board hidden with a provider')
// tasks-controller.test.mjs (harness)
test('Move all to Tomorrow is one task_bulk with Undo sending before')
test('Nudge opens the thread with the prefilled line and sends nothing')
test('Keep open sends task_handled keep; Discard change sends task_parked discard')
```

- [ ] **Step 2: Run them and see them fail.** `node --test ui/test/tasks-dates-model.test.mjs ui/test/tasks-controller.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces with the spec's copy verbatim; the accessibility of §Accessibility (sections with `h2`, folds with `aria-expanded`, done box outside the unfold button, `role="status"` footer).

- [ ] **Step 4: Run** `npm test`, then `WORKSPACE_E2E_ONLY=compact` and `layout`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(tasks): a By date view with Late, Today and Later, check-in rows, looks handled and bulk moves"
```

### Task 8: Settings › Tasks

**Files:**
- Create: `ui/workspace/settings-tasks.js` (pure: `whereTasksLive(p)`, `providerSettings(p)`, `copyDialog(p)`)
- Modify:
  - `ui/workspace/view-settings.js` (`SETTINGS_TABS` :15: move `['', 'meetings-tasks', 'Tasks', 'tasks']` into the Workspace group after `notifications`, id unchanged; the panel draws `whereTasksLive` first);
  - `ui/workspace/settings-plugins.js` (a provider's summary gains "Provides tasks · Settings › Tasks");
  - `ui/workspace/tasks-controller.js` (`tasks-provider-*` actions);
  - `ui/workspace/app.js` (`handle` routes `tasks-provider-`; the plugins call for `set_setting`; the removed-provider toast).
- Test: `ui/test/settings-tasks.test.mjs`, `ui/test/settings-menu.test.mjs` (the moved tab)

**Interfaces:**
- Consumes: `taskProvider`; `installed[].settings` (Task 2); `task_provider_set`, `task_sync_now`; the plugin `status` through a new read-only `workspace_request` op `task_provider_check {}` → `{ok, account, project}` or the provider error as a `WorkspaceError` (`code` = the state, `message` = the sentence). Add it natively here, in `task_provider/ops.rs`, with a Rust test over `FakeProvider`.
- Produces actions:
  - `tasks-provider-choose` (`data-provider`; the first choice of a provider while Local has open tasks opens `copyDialog`; "Copy <n> tasks" sends `copy: true`, "Not now" sends `copy: false`);
  - `tasks-provider-secret-save` (reads the field, sends `set_setting`, clears the field at once), `tasks-provider-secret-remove`;
  - `tasks-provider-setting` (string settings, on change);
  - `tasks-provider-check`, `tasks-provider-sync`, `tasks-provider-copy`, `tasks-provider-turn-on` (existing `set_enabled`);
  - the token link through the existing link confirmation.

- [ ] **Step 1: Write the failing tests**

```js
test('Where your tasks live lists Connect and each task plugin as a radio group with state lines')
test('the token field is a password field, never prefilled, and says "Saved on this Mac. Connect never shows it again." once set')
test('the copy dialog shows once, with the counts and the project, and offers the quiet link afterwards')
test('saving the token sends set_setting and empties the field; nothing is written to localStorage')
test('the Tasks tab sits in the Workspace group after Notifications; #/settings/meetings-tasks still opens it')
```

```rust
#[tokio::test] async fn task_provider_check_answers_status_or_the_state()   // ok, needs_token, offline
```

- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.

- [ ] **Step 3: Implement** with the spec's copy and accessibility (radiogroup, `aria-describedby`, `type="password"`, `autocomplete="off"`).

- [ ] **Step 4: Run** `npm test`, `cargo test task_provider::`, then `WORKSPACE_E2E_ONLY=plugins` and `compact`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add ui src-tauri
git commit -m "feat(settings): Settings › Tasks chooses where tasks live and sets up a task plugin with a write-only token"
```

### Task 9: The provider everywhere: meeting column, Today, Inbox, the Tasks header

**Files:**
- Modify:
  - `ui/workspace/task-target.js` (`providerTaskTarget`; `localTaskTarget` uses `withdraw` for undo);
  - `ui/workspace/app.js` (:1880: the target from the active provider, rebuilt when `taskProvider.active` changes; Inbox toasts; window focus calls `task_sync_now`; the Tasks page open calls it);
  - `ui/workspace/view-today.js` (Tasks widget :472-500: no trash with a provider, header button "Tasks");
  - `ui/workspace/view-tasks.js` (header status line and ⋯ "Sync now");
  - `ui/workspace/tasks-controller.js` (the delete confirm with a provider).
- Test: `ui/test/meeting-view.test.mjs` or `ui/test/meetings-controller.test.mjs` (the target), `ui/test/workspace.test.mjs` (Today widget), `ui/test/tasks-controller.test.mjs`

**Interfaces:**
- Consumes: Task 4 ops; `activeProvider`; `taskProvider.name`.
- Produces:
  - `providerTaskTarget({ label, moveTask, withdraw }) → {label, add, undo}`: `add(ids)` moves each to `todo` with log "Accepted from review" (as Local); `undo(ids)` = one `withdraw(ids)` → `{done, failed}`.
  - `localTaskTarget({ moveTask, withdraw })` keeps `label: 'Tasks'` and undoes through `withdraw`.
  - app.js: `withdraw = ids => mutate('task_withdraw', { ids })`.
- Copy: "Add <n> to <provider>", "In <provider>", "<n> in <provider> ›", "Added <n> to <provider> · Undo"; toast "Added to Todoist"; confirm "Delete “<text>” in Todoist too? Undo makes it again as a new task."

- [ ] **Step 1: Write the failing tests**

```js
test('providerTaskTarget labels the column with the provider and undoes with one task_withdraw')
test('a double click on "Add 2 to Todoist" saves each task once')     // existing in-flight guard, provider target
test('Today\'s Tasks widget with a provider: no trash, a done box, "Tasks" button, the provider\'s tasks only')
test('Local: the widget and the column are unchanged')                 // exact markup of today's snapshot test
test('delete with a provider asks first; Undo saves the body back')
```

- [ ] **Step 2: Run them and see them fail.** Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run** `npm test`, then `WORKSPACE_E2E_ONLY=meetings-view`, `meetings`, `compact` and `layout`. Expected: all pass, with no change for Local.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(tasks): the meeting column, Today and Inbox add to the active provider, with Undo that withdraws"
```

### Task 10: Docs and guides

**Files:**
- Modify: `.ai-run/guides/architecture/architecture.md`:
  - the Tasks module row and "Meetings and tasks": provider, cache, outbox, keys, the `task_sync` job, the new ops and fixtures;
  - the plugin host: the `tasks` role, `ctx.tasks.provide`, `set_setting`;
  - Quick reference: "Add a task provider".
- Modify: `.ai-run/guides/testing/testing-patterns.md` (`FakeProvider`, `FakeTodoist`, `CONNECT_MARKETPLACE_DIR`) if Task 6 did not cover it.

- [ ] **Step 1:** Write the sections, naming real symbols (`task_provider::sync::run`, `TaskProviders`, `outbox::enqueue`, `services::tasks`). No invented names: `grep` each one.
- [ ] **Step 2: Commit**

```bash
git add .ai-run/guides
git commit -m "docs: the task provider, its outbox and the tasks plugin role in the guides"
```

### Task 11: Browser check set `tasks-provider-checks.mjs`

**Files:**
- Create: `ui/test/browser/tasks-provider-checks.mjs`
- Modify: `ui/test/browser/workspace-e2e.mjs`:
  - the import, and the `WORKSPACE_E2E_ONLY` list :1359 gains `tasks-provider`;
  - the full run calls `tasksProviderChecks` after `meetingsViewChecks`; the header comment :1358;
  - mock helpers `taskProvider(state)` (from `task-provider-states.json`) and Todoist-provider task records built from `task-sync-cases.json`.

**Interfaces:**
- Consumes: `open({ theme, width, height, hash, settings, meetings, localPrefs })`, `check`, `assert`, `shot`, `settled`, `calls`, `OUT`; `noClip`, `CLIP_SELECTORS`, `FIXED_NOW` from `compact-checks.mjs`; the `noOverflow` pattern from `reply-checks.mjs`.
- Produces: `export async function tasksProviderChecks({ open, check, assert, shot, settled, calls, OUT })`.

- [ ] **Step 1: Write the checks.**
  - **P1 `tasks-provider P1: <theme> <view> <width>`**, both themes × {compact, default} × {1000, 1440, 1680}, Todoist on, By date:
    - Late, Today and Later sections exist; two columns at 1440 and 1680, one at 1000;
    - no horizontal overflow; `noClip` empty with `.ws-tdate-row button` added;
    - screenshots `tasks-provider-<theme>-<view>-<width>`, plus `-folds-open` and `-banner-needs-token`.
  - **P2 Settings › Tasks** (Review Focus 4):
    - the radio group; choose Todoist → the copy dialog with "Copy 3 tasks" → `task_provider_set {provider:'plugin:todoist', copy:true}`;
    - type the sentinel, Save → `set_setting`; the field is empty;
    - the sentinel is in no DOM text or attribute, no `localStorage` or `sessionStorage` value, and no later `workspace_request` answer;
    - choosing Connect and Todoist again shows no dialog, only the quiet link;
    - screenshot `tasks-provider-settings-<theme>`.
  - **P3 Late ⋯:** "Move all to Tomorrow" → exactly one `task_bulk` with 3 items; the footer reads "Moved 3 to Tomorrow · Undo"; Undo sends `before`; "Done all" → "Marked 3 done · Undo".
  - **P4 check-in row:** "Check with Marek: …"; Nudge opens Inbox with the reply box holding "Hi Marek, any news on …?"; `action_prepare` and `action_confirm` stay 0; Snooze ▾ › Monday → `task_save {due}`.
  - **P5 looks handled:** the row shows "Looks handled · you replied in Teams 17:32"; Keep open → `task_handled keep`; the flag is gone after render.
  - **P6 meeting column:** "Add 1 to Todoist" → one `task_save {status:'todo'}`; "Added 1 to Todoist · Undo" → one `task_withdraw {ids:[…]}`; "In Todoist" heading.
  - **P7 Today widget:** Todoist tasks only; no trash button; the button reads "Tasks"; quick add → `task_save`.
  - **P8 states:** for `offline`, `rate_limited`, `needs_token`, `off` and `failed`, the header line or banner reads the spec's text; a pending row shows "Not in Todoist yet"; a parked row shows its sentence with "Try again" / "Discard change".
  - **P9 back to Local:** the Board is the default again, with Local's tasks; Todoist's are not shown.
  - **P10 parity:** the normalized `outerHTML` of `.ws-tdate` (ids stripped) is identical in Default and Compact.
  - **P11 nothing written without a click:** open Tasks, Today, a meeting and Settings › Tasks, switch views and render five times. `task_save`, `task_bulk`, `task_withdraw` and `task_provider_set` counts stay 0; `task_sync_now` is at most 2.
  - **P12 Local untouched** (Review Focus 3): with no `taskProvider`, the Tasks page, the column and the widget markup equal the pre-step snapshots the meetings and compact sets already check, and By date is offered third.

- [ ] **Step 2: Run** `WORKSPACE_E2E_ONLY=tasks-provider …` outside the sandbox. Expected: P1–P12 PASS. Fix product code only in a `fix:` commit naming the check. Look at the 1000 px screenshots in both views.

- [ ] **Step 3: Commit**

```bash
git add ui/test/browser/tasks-provider-checks.mjs ui/test/browser/workspace-e2e.mjs
git commit -m "test(tasks): browser checks for the task provider in both views, both themes and three widths"
```

### Task 12: Definition of done, then publishing the plugin (outward-facing)

**Files:** none change unless a check fails. A fix goes in a `fix:` commit naming the check.

- [ ] **Step 1: Connect gates.**
  - `make fmt-check lint test-js`, then `cd src-tauri && cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`, then `cargo test --test connect_marketplace` with the marketplace folder present.
  - Expected: fmt and clippy clean; `npm test` no failures; every target `test result: ok`, and `connect_marketplace` ran (no `skipped:`); `git status` clean, fixtures committed.

- [ ] **Step 2: Marketplace gates.** `scripts/check.sh`. Expected: exit 0; `git status` clean.

- [ ] **Step 3: Whole browser run** in the background, outside the sandbox (about 40 minutes).
  - Expected: `N/N browser checks passed`, covering tasks-provider P1–P12, meetings-view, meetings, meetings-settings, reply, compact, layout, plugins and analytics.
  - Screenshots are in `output/playwright/workspace-e2e/`. For a known flaky check, re-run that set alone once and report both results.

- [ ] **Step 4: Headless smokes** (no desktop driving; the real-app screenshots and the live token check are deferred to the end of the rollout). Ask the user to quit their Connect first; the status smoke refuses to run beside it, and do not quit it for them.
  1. `cd src-tauri && cargo build`.
  2. `CODEMIE_PLUGIN_SMOKE=/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect-marketplace ./target/debug/app`. Expected: exit 0, now that the marketplace has a plugin; `todoist` loaded; `tasks: [{plugin:'todoist', status:'needs_token'}]`.
  3. `CODEMIE_WORKSPACE_TEST_DIR=$(mktemp -d)/workspace CODEMIE_PLUGIN_SMOKE=isolation ./target/debug/app`. Expected: exit 0.
  4. `T=$(mktemp -d)/workspace`; copy `workspace.sqlite` (with `-wal` and `-shm`) from `~/Library/Application Support/com.epam.codemie.installer/workspace/` into it, never `credentials/`; then `CODEMIE_WORKSPACE_TEST_DIR=$T CODEMIE_STATUS_SMOKE=status ./target/debug/app`. Expected: exit 0; the report shows the workspace with Local as the task provider and no `task_sync` job.
  5. Grep for the sentinel: `grep -r tk_SENTINEL ui/test/fixtures output/playwright "$TMPDIR"/connect-*-smoke.json ~/Library/Logs/CodeMie/` finds nothing.

- [ ] **Step 5: A side-by-side comparison with the reference mockups, from browser screenshots.**
  1. Render the reference tasks mockup in Playwright at 1440 px (light), saved as `output/playwright/reference-tasks-v1.png`.
  2. Put it beside `tasks-provider-light-compact-1440` and `-default-1440`.
  3. List every visible difference, as kept on purpose (with the spec's ruling number) or as a follow-up. Examples:
     - Later than that fold (ruling 7);
     - To review panel (§9);
     - no ✦ nudge draft and no inline composer (ruling 19);
     - the header status line in place of "updated 16:15 ↻";
     - no "Add task ⌘N" (step 9);
     - no Waiting on others panel, check-in rows by date instead (an earlier revision, 2026-11-14).

- [ ] **Step 6: Show the user:**
  - the gate results, the browser-run summary and the P1/P2 screenshots in both views;
  - the three smoke reports;
  - the reference-mockup comparison with its differences;
  - the marketplace commits to be pushed (`git -C <marketplace> log origin/main..main --oneline`).

  Ask: "Push the Todoist plugin to codemie-ai/codemie-connect-marketplace (public)?" Do not push Connect.

- [ ] **Step 7: Publish (outward-facing, only after the user's explicit yes).**
  - From the marketplace folder: `git push origin main`, then `git tag todoist/v1.0.0 && git push origin todoist/v1.0.0`.
  - Confirm with `gh api repos/codemie-ai/codemie-connect-marketplace/contents/plugins/todoist/echo-plugin.json --jq .name` (expects `echo-plugin.json`).
  - Report the pushed commit hashes and the tag.
  - Without a yes, stop here and report that the push is held.
