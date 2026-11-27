# Menu-bar count (step 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers also follow the shared rules in `.superpowers/sdd/common-implementer.md`.

**Goal:** The menu-bar icon shows how many things wait for the user (messages that need a reply by default; tasks due or late, meetings with new notes and automation results when chosen in Settings › Notifications) and turns amber when something needs fixing.

**Architecture:**
- Native module `src-tauri/src/workspace/menu_bar.rs`: `MenuBarSettings` (settings key `menuBar`), the `menu_bar_seen` bookkeeping record, pure `compute(...) -> MenuBar` over the snapshot, the task provider part and the seen marks; the snapshot carries it as `menuBar`.
- Native tray: `setup_tray` gets the id `main`; a refresher woken by `Core::emit("workspace:changed")` computes after 300 ms and applies a `TrayView` (title, amber, tooltip, rows) through a `TraySink` (`AppTray` in the app, `FakeTray` in tests).
- Window: a "Menu bar" card in Settings › Notifications, seen marks sent through `mutate('menu_bar_seen', …)`, and menu rows opening their place through `workspace:notification-open`.

**Tech Stack:** Rust (Tauri v2 `tray-icon`), `cargo test`; vanilla JS ES modules, `node:test`; Playwright (`playwright-core`) against the mocked bridge.

**Spec:** `docs/superpowers/specs/2026-11-24-menu-bar-count-design.md` (§ numbers and "ruling N" below refer to it). Builds on `2026-11-23-task-provider-design.md` and `2026-11-24-create-tasks-templates-design.md`. Definition of done: the spec's "Definition of done"; real-desktop screenshots of the menu bar are deferred to the announced pass at the end of the rollout.

## Global Constraints

- **Repository, branch, commits:**
  - `/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect`, branch `feat/workspace-next` (checked out). Do not switch branches. Do not push.
  - One commit per task, Conventional Commit subject, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Before each commit, the case-insensitive `git grep -il` check for the reference app's name (the controller gives the word) must print nothing; never name the user's other assistant app or reference its files ("the reference app" if needed).
- **Running things:**
  - Raw `cargo` from `src-tauri/` with `export PATH="$HOME/.cargo/bin:$PATH"`; `make`, `npm`, `node` from the repo root; macOS/zsh syntax (BSD `sed`, `find`).
  - Skip the known failure: `cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`.
  - Browser run: `PLAYWRIGHT_CORE=/Users/Nikita_Levyankov/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs`, outside the sandbox (`dangerouslyDisableSandbox: true`). One set: prefix `WORKSPACE_E2E_ONLY=<set>`. A UI task runs `menu-bar` (once it exists), `compact` and `layout`; the whole run (about 40 minutes, `run_in_background`) is for Task 8.
  - **Never drive the desktop.** No GUI launch of the app except the headless smokes in Task 8; no screenshot of the real menu bar.
- **Safety, every task:**
  - No network in any test. Claude is `FakeRunner`; the task provider is `task_provider::fake::FakeProvider`; Microsoft is the test core's seeded records.
  - The tray title is a number or nothing. No message, task, meeting or automation text in the title or in the status smoke's report (lengths and counts only).
  - Seen marks are sent only while the document is visible and focused, no dialog is open and nothing is being typed in; nothing else in this step writes without a click.
  - Never write a real token; where a provider token is needed use the sentinel `tk_SENTINEL_do_not_log_0123456789`.
- **Code rules:**
  - Views and models stay pure; only `app.js` touches the DOM; writes go through `mutate`; every provider, automation and meeting string goes through `escapeHtml`.
  - Never compute the menu bar inside `Core::emit` (a caller may hold the repository guard): `emit` only wakes the refresher. Take the repository guard only while computing; drop it before any `.await`. Lock order `meeting_lock` then the repository.
  - One new workspace operation (`menu_bar_seen`); no new Tauri command.
  - Default and Compact draw the same markup.
- **Values:**
  - settings defaults `{replies: true, tasks: false, meetings: false, automations: false}`;
  - seen record: kind `menu_bar_seen`, id `personal`, data `{since, automations, meetings: {<id>: ts}}`, unversioned;
  - "new" window: 7 days (`NEW_FOR = 7 * 86_400`); label `""` at 0, the number to 99, `"99+"` above;
  - refresher debounce 300 ms; tray id `"main"`; amber `#F5A623` = `(245, 166, 35)`, alpha kept;
  - fix ids `microsoft`, `tasks-token`, `tasks-plugin`, `tasks-parked`, `automation:<id>`, `meetings-folder`; at most 3 fix rows in the menu, then "and <n> more".
- **Copy, verbatim from the spec § Copy and §4** (each task quotes what it draws).
- **Contract fixtures:** after a native shape change run `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures` and commit the JSON with the change.

## Review Focus

1. **A Teams chat with five unanswered messages and one critical message in it.** The menu bar adds 1, exactly as the Inbox badge does. (Task 1 `replies_match_inbox_one_per_chat`, pinned in JS by `menu-bar-reply-cases.json` in Task 5.)
2. **The user upgrades with a hundred meetings that already have notes and fifty past automation runs.** Nothing counts as new. (Task 1 `nothing_before_since_is_new`.)
3. **A task due tomorrow, with the window hidden overnight.** It counts as due by the first minute after midnight without the window drawing. (Task 3 `the_minute_emit_recounts_after_midnight`.)
4. **A sync round writes forty messages, each emitting `workspace:changed`.** The tray is set once for the burst, not forty times, and no emit deadlocks while a repository guard is held. (Task 3 `a_burst_of_changes_applies_once`, `emit_under_a_repository_guard_does_not_block`.)
5. **The user is typing in a meeting's notes while a new version arrives, or the window sits behind another app.** No `menu_bar_seen` is sent until they stop typing and the window is in front. (Task 6 `seen_waits_for_focus_and_no_typing`.)

---

### Task 1: Menu-bar settings, seen marks and the four sources

**Files:**
- Create: `src-tauri/src/workspace/menu_bar.rs` (declared in `workspace/mod.rs`)
- Modify: `src-tauri/src/workspace/models.rs` (`Settings.menu_bar`, `Default`)
- Modify: `src-tauri/src/workspace/mod.rs` (`update_settings` applies `menuBar`; `Core::open` writes the seen record's `since` when missing)
- Test: `menu_bar.rs` test module

**Interfaces:**
- Produces:
  - `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase", default)] pub struct MenuBarSettings { pub replies: bool, pub tasks: bool, pub meetings: bool, pub automations: bool }` with `fn apply(&mut self, v: &Value) -> Result<()>` (refusal `validation` "Choose on or off.", field `menuBar`);
  - `pub(crate) struct Seen { pub since: i64, pub automations: i64, pub meetings: BTreeMap<String, i64> }`; `pub(crate) fn seen(r: &Repository) -> Seen` (missing → `since: 0`); `pub(crate) fn ensure_since(r: &mut Repository, now: i64) -> Result<()>`;
  - `pub struct Sources { pub replies: u32, pub tasks: u32, pub meetings: u32, pub automations: u32 }` (serde camelCase);
  - `pub(crate) fn attention_rows(records: &[Record], now: i64) -> u32` (port of `selectors.js::attentionMessages().length`);
  - `pub(crate) fn sources(s: &Snapshot, me: &MeAlias, seen: &Seen, now: i64) -> (Sources, Vec<String> /* newMeetings ids */)`; the tasks rule takes `s.settings.menu_bar.replies` for the reply-kind exclusion.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn settings_default_to_replies_only()
// Settings::default().menu_bar == {replies: true, others false}; serde_json::to_value(...)["menuBar"] == {"replies":true,"tasks":false,"meetings":false,"automations":false};
// settings JSON without menuBar reads as the default; apply({"tasks": true}) keeps replies true; apply({"tasks": "yes"}) → Err field "menuBar", message "Choose on or off."
#[test] fn replies_match_inbox_one_per_chat()
// mail m1 reply; chat c1: 5 reply messages + 1 critical unacknowledged → 1 row; chat c2 critical acknowledged + reply → 1 (the reply);
// archived, deleted, snoozed (snoozedUntil > now) → 0 → total 3
#[test] fn tasks_are_my_open_tasks_due_today_or_late()
// active provider only; due yesterday + today (zone Europe/Vilnius) → counted; tomorrow, done, dismissed, review, owner "Ann" → not;
// a reply-kind task due today counts with replies off and not with replies on
#[test] fn meetings_with_new_notes_since_seen_within_seven_days()
// doc.updatedAt > since and no mark → new; mark after doc → not; doc 8 days old → not; newMeetings lists the ids
#[test] fn automation_results_are_ok_runs_after_the_mark()
// ok with delivered ["today"] after mark → 1; failed, skipped, delivered ["meeting_summary"] only, delivered [] → 0
#[test] fn nothing_before_since_is_new()
// 100 meetings with docs and 50 ok runs, all updatedAt < since → meetings 0, automations 0
#[tokio::test] async fn settings_update_saves_menu_bar_and_open_sets_since()
// test_core: seen(&repo).since > 0 after open; mutation(SettingsUpdate, {"menuBar": {"meetings": true}}) → snapshot settings.menu_bar.meetings true
```

- [ ] **Step 2: Run them and see them fail.** `cd src-tauri && cargo test menu_bar`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** the Interfaces per spec §1–§3. Tasks reuse `tasks::is_open`, `tasks::provider_of` with the settings' active provider, `tasks::is_mine` and the workspace zone's day key (`YYYY-MM-DD` string compare against `due`). `attention_rows` collapses chats by `conversationId` (else `source`), as `messageKey` does.

- [ ] **Step 4: Run** `cargo test menu_bar`, then the whole Rust suite with the skip. Expected: all pass; no fixture under `ui/test/fixtures` changed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(menu-bar): settings, seen marks and the four counted sources"
```

### Task 2: Fixes, the snapshot's `menuBar` and `menu_bar_seen`

**Files:**
- Modify: `src-tauri/src/workspace/menu_bar.rs` (`Fix`, `MenuBar`, `compute`, `label`, `tooltip`, `rows`, `contract_fixtures`)
- Modify: `src-tauri/src/workspace/models.rs` (`Operation::MenuBarSeen` = `"menu_bar_seen"`; `Snapshot.menu_bar: Value`)
- Modify: `src-tauri/src/workspace/repository.rs` (`snapshot` sets `menu_bar: Value::Null`)
- Modify: `src-tauri/src/workspace/mod.rs` (the window's snapshot fills `menu_bar` beside `task_provider` :767; `request` dispatches `MenuBarSeen`)
- Modify: `src-tauri/src/workspace/meetings/notes_ops.rs` (`meeting_set`, `meeting_doc` stamp the meeting seen)
- Fixtures: create `menu-bar-states.json`, `menu-bar-reply-cases.json`
- Test: `menu_bar.rs` test module, `meetings/notes_tests.rs`

**Interfaces:**
- Consumes: Task 1 (`Seen`, `sources`, `MenuBarSettings`).
- Produces:
  - `#[serde(rename_all = "camelCase")] pub struct Fix { pub id: String, pub text: String, pub open: Value /* {route, tab?, runId?, automationId?} */ }`;
  - `#[serde(rename_all = "camelCase")] pub struct MenuBar { pub count: u32, pub label: String, pub amber: bool, pub sources: Sources, pub counted: Vec<String>, pub fixes: Vec<Fix>, pub new_meetings: Vec<String>, pub tooltip: String }`;
  - `pub fn compute(s: &Snapshot, task_provider: &Value, me: &MeAlias, seen: &Seen, now: i64) -> MenuBar` (pure);
  - `pub fn label(count: u32) -> String`;
  - `pub fn rows(m: &MenuBar) -> Vec<(String /* row id: source name or fix id */, String /* text */)>` (counted non-zero sources in the order replies, tasks, meetings, automations, then at most 3 fixes, then "and <n> more");
  - `pub(crate) fn mark_meeting(r: &mut Repository, meeting_id: &str, now: i64) -> Result<()>`, `pub(crate) fn mark_automations(r: &mut Repository, now: i64) -> Result<()>` (both drop entries whose meeting record is gone);
  - `menu_bar_seen {meetingId}` → `{seen: true}`; unknown meeting → `not_found` "This meeting is no longer available."; neither field → `validation` "Say what was seen.".

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn label_and_tooltip()
// label(0) == "", label(7) == "7", label(99) == "99", label(100) == "99+";
// tooltip at zero == "CodeMie Connect"; replies 2 + tasks 1 counted == "CodeMie Connect · 2 messages need a reply, 1 task due or late";
// with fix tasks-token for Todoist: ends " · Needs fixing: Todoist needs your API token."
#[test] fn only_counted_sources_add_up()
// sources {replies 2, tasks 1, meetings 3, automations 4}, settings replies+tasks → count 3, counted ["replies","tasks"]; nothing chosen → count 0, label ""
#[test] fn each_fix_has_its_condition()
// connection status "needs_login" → microsoft; "disconnected" → none;
// taskProvider state needs_token → "Todoist needs your API token.", open {route:"settings", tab:"meetings-tasks"}; failed → "The Todoist plugin didn't load.";
// parked 2 → "Todoist refused 2 task change(s).", open {route:"tasks"}; offline / rate_limited / syncing / off → none;
// enabled automation whose newest run failed with message "Claude is not signed in." → id "automation:auto-brief", text "Morning brief failed: Claude is not signed in.", open {route:"automations", runId, automationId};
// same automation turned off, or a newer ok run → none; a meeting saveError folder_unwritable → "Connect can't write to the meetings folder.", open {route:"settings", tab:"meetings-transcripts"};
// amber == !fixes.is_empty()
#[test] fn rows_name_the_parts_and_cap_fixes()
// 1 reply → "1 message needs a reply"; 2 tasks → "2 tasks due or late"; 1 meeting → "1 meeting with new notes"; 4 results → "4 automation results";
// 5 fixes → 3 fix rows then "and 2 more"
#[tokio::test] async fn menu_bar_seen_clears_and_meeting_ops_stamp()
// a meeting with a new doc: snapshot menuBar.newMeetings == [id]; menu_bar_seen {meetingId} → [] ; {automations: true} → sources.automations 0;
// {meetingId: "nope"} → not_found; {} → validation; meeting_doc edit on a meeting with a newer doc → not new afterwards
#[tokio::test] async fn contract_fixtures()   // writes menu-bar-states.json (zero, replies, several, capped, amberOnly, amberWithCount, nothingChosen) from real compute over test_core, and menu-bar-reply-cases.json {records, replies}
```

- [ ] **Step 2: Run them and see them fail.** `cargo test menu_bar meetings::notes_tests`. Expected: FAIL.

- [ ] **Step 3: Implement** per spec §4, §5 (shape, label, tooltip, rows) and §7. The provider name is `task_provider["name"]`, else "Connect". The window's snapshot computes `menu_bar` after `task_provider` with the same repository read.

- [ ] **Step 4: Fixtures and the suite.** `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, the Rust suite with the skip, `npm test`. Expected: all pass; the two new JSON files appear and no other fixture changes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui/test/fixtures/contract
git commit -m "feat(menu-bar): what needs fixing, the snapshot's menuBar and the menu_bar_seen operation"
```

### Task 3: The tray: title, amber icon, menu rows and the refresher

**Files:**
- Modify: `src-tauri/src/workspace/menu_bar.rs` (`TrayView`, `tray_view`, `amber_rgba`, `TraySink`, `FakeTray` under `cfg(test)`, `Refresher`)
- Modify: `src-tauri/src/workspace/mod.rs` (`setup_tray` :2241 → `TrayIconBuilder::with_id("main")`, `AppTray`, menu event for rows; `Core` holds `menu_bar: Refresher`; `emit` wakes it for `"workspace:changed"`; `start` spawns the refresher loop; `stop_background` stops it; `test_core` installs a `FakeTray`)
- Test: `menu_bar.rs` and `mod.rs` test modules

**Interfaces:**
- Consumes: Task 2 (`compute`, `rows`, `MenuBar`, `Fix.open`).
- Produces:
  - `#[derive(Clone, Debug, PartialEq)] pub struct TrayView { pub title: Option<String>, pub amber: bool, pub tooltip: String, pub rows: Vec<TrayRow> }`, `pub struct TrayRow { pub id: String /* "mb:<row id>" */, pub text: String, pub open: Value }`;
  - `pub fn tray_view(m: &MenuBar) -> TrayView` (title `None` at zero; `open` per spec §5 "A row's click": replies `{route:"inbox", lane:"reply"}`, tasks `{route:"tasks"}`, meetings `{meetingId}` when exactly one new else `{route:"meetings"}`, automations `{route:"automations"}`, a fix its `open`);
  - `pub fn amber_rgba(rgba: &[u8]) -> Vec<u8>` (every pixel becomes `(245, 166, 35, a)`);
  - `pub trait TraySink: Send + Sync { fn apply(&self, view: &TrayView); }`;
  - `pub struct Refresher { … }` with `pub fn wake(&self)`, `pub fn last(&self) -> Option<TrayView>`; `impl Core { pub(crate) fn refresh_menu_bar_now(&self) -> Result<TrayView> }` (compute, apply if different from `last`, return it);
  - a row click: show and focus `main`, emit `workspace:notification-open` with the row's `open` plus `workspaceId: "personal"`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn tray_view_for_each_state()
// over menu-bar-states.json's states: zero → title None, amber false, rows []; replies → Some("2"); capped → Some("99+");
// amberOnly → title None, amber true, one fix row; one new meeting → row open {meetingId: <id>}; two → {route:"meetings"}
#[test] fn amber_keeps_alpha()
// amber_rgba(&[0,0,0,0, 0,0,0,128, 0,0,0,255]) == [245,166,35,0, 245,166,35,128, 245,166,35,255]
#[tokio::test] async fn refresh_applies_only_when_the_view_changes()
// FakeTray: refresh_menu_bar_now twice with no change → 1 apply; add a reply-lane message → second apply with title "1"
#[tokio::test] async fn a_burst_of_changes_applies_once()
// start the refresher on test_core; 40 × core.emit("workspace:changed") within 50 ms → after 600 ms FakeTray has exactly 1 new apply
#[tokio::test] async fn emit_under_a_repository_guard_does_not_block()
// let g = core.repo().unwrap(); core.emit("workspace:changed"); drop(g); → returns at once; the refresher applies afterwards
#[tokio::test] async fn the_minute_emit_recounts_after_midnight()
// tasks counted, replies off; my open task due tomorrow; refresher clock at 23:59:30 local → title None;
// set the clock to 00:00:30 the next day and emit (as the loop's minute emit does) → title "1"; the window never drew
```

- [ ] **Step 2: Run them and see them fail.** `cargo test menu_bar workspace::tests`. Expected: FAIL.

- [ ] **Step 3: Implement.** `Refresher` holds an `Arc<Notify>`, the `last` view in a `Mutex`, a `Box<dyn TraySink>` and a clock (`fn() -> i64`, `now` in the app). The loop: `notified().await`, `sleep(300 ms)`, drain extra permits, `refresh_menu_bar_now()`. `AppTray::apply` on macOS: `set_title(view.title.as_deref())`, `set_icon(Some(template or amber Image))`, `set_icon_as_template(!view.amber)`, `set_tooltip(Some(&view.tooltip))`, `set_menu(Some(rows + separator + show + quit))`; Windows: no title, the amber image when amber. The amber image is `Image::new_owned(amber_rgba(template.rgba()), 36, 36)`, made once.

- [ ] **Step 4: Run** the Rust suite with the skip and `make lint`. Expected: all pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(menu-bar): the tray shows the count, turns amber and lists what it counts"
```

### Task 4: The status smoke checks the tray

**Files:**
- Modify: `src-tauri/src/commands/status_smoke.rs` (`facts` :289 gains `menuBar`; `build_report` :678 fails on a mismatch)
- Test: `status_smoke.rs` test module

**Interfaces:**
- Consumes: Task 3 (`Core::refresh_menu_bar_now`, `Refresher::last`, tray id `"main"`).
- Produces: facts `menuBar: {tray: bool, applied: {title, amber, tooltipLength, rows}, computed: {count, label, amber}}`; report failures "menuBar: no tray icon" and "menuBar: the tray shows <applied> but the count is <computed>".

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn the_report_checks_the_tray()
// build_report with facts.menuBar {tray: false} → failed contains "menuBar: no tray icon";
// applied {title: "2", amber: false} vs computed {label: "3", amber: false} → failed contains "menuBar: the tray shows 2 but the count is 3";
// equal → no menuBar failure; the report's menuBar holds no string longer than the label (tooltipLength is a number)
```

- [ ] **Step 2: Run it and see it fail.** `cargo test status_smoke`. Expected: FAIL.

- [ ] **Step 3: Implement.** `facts` calls `core.refresh_menu_bar_now()` first, then reads `app.tray_by_id("main").is_some()` and `Refresher::last()`. Applied `None` title compares as `""`.

- [ ] **Step 4: Run** the Rust suite with the skip. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "test(menu-bar): the status smoke checks the tray against the count"
```

### Task 5: Settings › Notifications: the Menu bar card

**Files:**
- Create: `ui/workspace/menu-bar.js` (pure: `menuBarCard(s)`, `statusLine(menuBar, settings)`, `ROWS`)
- Modify: `ui/workspace/view-settings.js` (`notificationsPanel` :301 appends `menuBarCard(s)`; `TAB_DESCRIPTIONS.notifications`)
- Modify: `ui/workspace/app.js` (actions `menu-bar-toggle` → `mutate('settings_update', {menuBar: {[source]: checked}})`, the switch reverts on failure; `menu-bar-fix` → the fix's `open` through the same router as §6's notification branch, added in Task 6 — until then `route(open.route, open.tab)`)
- Modify: `ui/test/fixtures/workspace-fixture.mjs` (`buildSnapshot`: `settings.menuBar` defaults, `menuBar` = `menu-bar-states.json` `replies`; `withMenuBar(s, stateName)`)
- Test: `ui/test/menu-bar.test.mjs`

**Interfaces:**
- Consumes: Task 2's `menu-bar-states.json`, `menu-bar-reply-cases.json`.
- Produces: `menuBarCard(s) -> string`; `statusLine(menuBar, menuBarSettings) -> string`; data attributes `data-action="menu-bar-toggle" data-source="<replies|tasks|meetings|automations>"`, `data-action="menu-bar-fix" data-fix="<id>"`.

- [ ] **Step 1: Write the failing tests**

```js
test('the card offers four switches, only replies on by default')
// html has 'Menu bar', 'The number beside CodeMie Connect in the menu bar. Choose what it counts.',
// the four titles and hints verbatim (spec § Copy), 'Your open tasks in Todoist.' with STATES ready provider, 'Your open tasks in Connect.' without;
// exactly one checked toggle (data-source="replies"); each toggle has aria-label = its title and aria-describedby its hint
test('the status line says what the number is made of')
// several → 'Now: 3 — 2 messages need a reply, 1 task due or late'; zero → 'Now: nothing to count.';
// nothingChosen → 'Nothing is counted. The icon still turns amber when something needs fixing.'; role="status"
test('fixes are listed with a Fix button each')
// amberWithCount → 'Needs fixing', a ul, button 'Fix: Todoist needs your API token.' data-fix="tasks-token"; amber footer hint verbatim; texts escaped (an automation named '<b>x</b>')
test('the reply count matches Inbox')
// menu-bar-reply-cases.json: attentionMessages({records, ...base}).length === fixture.replies
test('Default and Compact draw the same card')   // menuBarCard identical for view compact and default
```

- [ ] **Step 2: Run them and see them fail.** `node --test ui/test/menu-bar.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** per spec §6 and § Copy, with `card`, `settingRow`, `toggle`, `button` from `ui.js`.

- [ ] **Step 4: Run** `npm test`, then the `compact` and `layout` browser sets. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(menu-bar): Settings › Notifications chooses what the menu-bar count includes"
```

### Task 6: Seen marks and opening from the menu

**Files:**
- Modify: `ui/workspace/menu-bar.js` (pure `seenToSend`, `openTarget`)
- Modify: `ui/workspace/app.js` (after each render: `seenToSend` → `mutate('menu_bar_seen', …)`, failures ignored, at most once per revision; `openNotification` :3231 gains the general `route` branch through `openTarget`)
- Test: `ui/test/menu-bar.test.mjs`

**Interfaces:**
- Consumes: Task 2 (`menuBar.newMeetings`, `menuBar.sources`), Task 3 (row `open` payloads).
- Produces:
  - `seenToSend({ snapshot, route, openMeeting, todayCards, hidden, focused, editing, modal, sent }) -> Array<{meetingId} | {automations: true}>` — `focused` = `document.visibilityState === 'visible' && document.hasFocus()`; `todayCards` the ids on Today's grid; `hidden` the meetings view's hidden ids and series; `sent` a `Set` of `"<revision>|<key>"` already sent;
  - `openTarget(payload) -> {route, tab?, lane?, meetingId?, runId?, automationId?} | null` for `route` ∈ `inbox | meetings | automations | settings | tasks`.

- [ ] **Step 1: Write the failing tests**

```js
test('an open meeting with new notes is marked seen once')
// newMeetings ['m-ready'], route 'meetings', openMeeting 'm-ready', focused → [{meetingId:'m-ready'}]; same revision with sent → []
test('hidden meetings with new notes are marked seen on any page')   // hidden {ids:['m-x']} and newMeetings ['m-x'] on route 'inbox' → [{meetingId:'m-x'}]
test('automation results are seen on Automations, or on Today with its card')
// sources.automations 2: route 'automations' → [{automations:true}]; 'today' with todayCards ['automations'] → same; without the card → []; sources 0 → []
test('seen waits for focus and no typing')   // focused false, or editing true, or modal true → [] in every case above
test('menu rows open their place')
// openTarget({route:'inbox', lane:'reply'}) → {route:'inbox', lane:'reply'}; {route:'settings', tab:'meetings-tasks'}; {route:'automations', runId:'r1', automationId:'a1'} kept; {route:'nope'} → null
```

- [ ] **Step 2: Run them and see them fail.** `node --test ui/test/menu-bar.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `openNotification`, the existing `itemId`, `eventId`, `meetingId` and `runId` cases keep their order; the `route` branch replaces the `tasks`-only line: `inbox` sets `state.lane` (`'reply'`) before routing, `settings` opens `tab`, `automations` without `runId` opens the Run log tab.

- [ ] **Step 4: Run** `npm test`, then the `compact` and `layout` browser sets. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(menu-bar): the window marks new notes and results seen, and menu rows open their place"
```

### Task 7: Browser check set `menu-bar-checks.mjs`, and the guides

**Files:**
- Create: `ui/test/browser/menu-bar-checks.mjs`
- Modify: `ui/test/browser/workspace-e2e.mjs` (import; mock `settings_update` merges `menuBar` and answers the next `menu-bar-states.json` state named by a test hook; mock `menu_bar_seen` records calls and removes the id from `newMeetings`; `WORKSPACE_E2E_ONLY` list :1537 gains `menu-bar`; the full run calls `menuBarChecks` after `automationsChecks`; header comment :1536)
- Modify: `.ai-run/guides/architecture/architecture.md` (Key abstractions or Workspace boundary: `workspace/menu_bar.rs`, the refresher woken by `emit`, `menu_bar_seen`, snapshot `menuBar`, tray id `main`), `.ai-run/guides/testing/testing-patterns.md` (browser sets and `WORKSPACE_E2E_ONLY` gain `menu-bar`; fixtures gain `menu-bar-states.json`, `menu-bar-reply-cases.json`; `FakeTray`; the status smoke's `menuBar` facts)

**Interfaces:**
- Consumes: `open({ theme, width, height, hash, settings, workspace, localPrefs })`, `check`, `assert`, `shot`, `settled`, `calls`, `OUT`; `noClip`, `CLIP_SELECTORS`, `FIXED_NOW` from `compact-checks.mjs`; the `noOverflow` pattern from `reply-checks.mjs`; `window.__emitNative`.
- Produces: `export async function menuBarChecks({ open, check, assert, shot, settled, calls, OUT })`.

- [ ] **Step 1: Write the checks.**
  - **M1 `menu-bar M1: <theme> <view> <width>`**, both themes × {compact, default} × {1000, 1440, 1680}: `#/settings/notifications` shows the Menu bar card with four switches, only "Messages that need a reply" on, the status line; no horizontal overflow; `noClip` empty; screenshots `menu-bar-card-<theme>-<view>-<width>`.
  - **M2 switch:** turning on "Tasks due today or late" sends exactly one `settings_update` with `{menuBar: {tasks: true}}`; the status line reads the `several` state's sentence; a forced refusal puts the switch back off.
  - **M3 amber:** with `amberWithCount`, "Needs fixing" lists "Todoist needs your API token."; its Fix button opens Settings › Tasks; screenshot `menu-bar-amber-<theme>-<view>`.
  - **M4 nothing chosen:** all four off → "Nothing is counted. The icon still turns amber when something needs fixing."
  - **M5 seen:** with `newMeetings: ['m-ready']`, opening that meeting sends one `menu_bar_seen {meetingId:'m-ready'}`; a redraw sends none; with the page made to report `hasFocus() === false` nothing is sent; opening Automations with results sends one `{automations: true}`; a hidden meeting in `newMeetings` is marked seen from Inbox.
  - **M6 menu rows:** `__emitNative('workspace:notification-open', …)` with `{route:'inbox', lane:'reply'}` lands on Inbox › Needs reply; `{route:'settings', tab:'meetings-tasks'}` on Settings › Tasks; `{route:'automations'}` on the Run log; `{meetingId:'m-ready'}` on that meeting.
  - **M7 parity:** the card's normalized `outerHTML` (ids stripped) is identical in Default and Compact.
  - **M8 nothing written without a click:** open Settings › Notifications, Today, Inbox and Automations with nothing new, render five times; `settings_update` and `menu_bar_seen` counts stay 0.

- [ ] **Step 2: Run** `WORKSPACE_E2E_ONLY=menu-bar …` outside the sandbox. Expected: M1–M8 PASS. Fix product code only in a `fix:` commit naming the check. Look at the 1000 px screenshots in both views.

- [ ] **Step 3: Commit**

```bash
git add ui/test/browser .ai-run/guides
git commit -m "test(menu-bar): browser checks for the Menu bar card, seen marks and menu rows in both views, both themes and three widths"
```

### Task 8: Definition of done

**Files:** none change unless a check fails; a fix goes in a `fix:` commit naming the check.

- [ ] **Step 1: Gates.** `make fmt-check lint test-js`, then `cd src-tauri && cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`. Expected: fmt and clippy clean; `npm test` no failures; every target `test result: ok`, including Task 3's `FakeTray` tests (title, amber, rows, one apply per burst, amber alpha); `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures` leaves `git status` clean.

- [ ] **Step 2: Whole browser run** in the background, outside the sandbox (about 40 minutes). Expected: `N/N browser checks passed`, covering menu-bar M1–M8 and every earlier set (plugins, meetings, meetings-view, meetings-settings, layout, analytics, compact, reply, tasks-dates, settings-tasks, tasks-provider, automations). For a known flaky check (layout E1, the Today hover label), re-run that set alone once and report both results.

- [ ] **Step 3: Headless smokes only** (no desktop driving; real-desktop screenshots of the menu bar wait for the announced pass at the end of the rollout). Ask the user to quit their Connect first if the status smoke refuses to run beside it; do not quit it for them.
  1. `cd src-tauri && cargo build`.
  2. `T=$(mktemp -d)/workspace`; copy `workspace.sqlite` (with `-wal` and `-shm`) from `~/Library/Application Support/com.epam.codemie.installer/workspace/` into it, never `credentials/`; `CODEMIE_WORKSPACE_TEST_DIR=$T CODEMIE_STATUS_SMOKE=status ./target/debug/app`. Expected: exit 0; the report's `menuBar` has `tray: true` and the applied title and amber equal to the computed ones; no tooltip or row text in the report.
  3. `CODEMIE_WORKSPACE_TEST_DIR=$(mktemp -d)/workspace CODEMIE_PLUGIN_SMOKE=/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect-marketplace ./target/debug/app`. Expected: exit 0; `todoist` loaded with `tasks: [{plugin:'todoist', status:'needs_token'}]`.
  4. `grep -r tk_SENTINEL ui/test/fixtures output/playwright "$TMPDIR"/connect-*-smoke.json` finds nothing.

- [ ] **Step 4: Show the user:** the gate results, the browser-run summary, the M1 and M3 screenshots in both views, the status smoke's `menuBar` facts, a note that the real menu bar is checked in the end-of-rollout desktop pass, and the rulings list from the spec. Do not push.
