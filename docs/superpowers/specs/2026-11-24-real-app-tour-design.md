# Real-app tour · design

**Status:** written on 2026-11-24 from the user's request and the code. It changes item 4 of the Definition of done in `2026-11-22-workspace-next-rollout-design.md`. Decisions the user left open are ruled on below, under "Rulings".
**Builds on:**
- the headless smokes: `src-tauri/src/commands/status_smoke.rs` (`CODEMIE_STATUS_SMOKE`), `plugin_smoke.rs` and `smoke.rs` (`CODEMIE_PLUGIN_SMOKE`, `refuse_beside_running`, the single-instance socket `/tmp/com_epam_codemie_installer_si.sock`), and the window halves `ui/workspace/status-smoke.js` and `ui/plugins/market-smoke.js`;
- the browser run's data: `ui/test/fixtures/workspace-fixture.mjs` (`buildSnapshot`, `withTasks`, `withMeetings`, `withAutomations`, `withMenuBar`, `meetingFolders`) and the contract fixtures in `ui/test/fixtures/contract/`;
- the test doubles behind the `test-support` feature: `ai::fake::FakeRunner`, `ProfileCache::fixed`, `ai_jobs::FakeGraph`, `analytics::cli::FakeAnalyticsCli`, `task_provider::fake::FakeProvider`, `plugins::services::http::Client::offline`;
- every step design of the rollout, for the coverage matrix (§ 7).

**The user's words:** "put in pipeline step by step testing of real app with implemented steps. step by step, create screenshots as result and final report with evidences in html format. I need to make sure that all implemented steps are covered. build, rebuild, install app whenever needed".

## Intent

Definition of done item 4 ("The real app") is done by hand today: someone launches a debug build and takes screenshots. That needs the desktop, and the user may be in a meeting sharing their screen. It also covers only "every changed screen" of one step, so a later step can break an earlier one in the real app without anyone seeing it.

The tour makes the real Tauri app check itself. One command builds the debug app, seeds a fresh test folder, starts the app hidden, and the app walks every implemented screen from inside its own webview. It takes a picture of its own web content at each stop, checks what must be on screen, and writes a single HTML report. The report maps every feature of every built step to the stops that show it.

## Goals

- **One command**, `make tour`. It builds the debug app when sources changed, seeds a fresh test folder, runs the tour, writes the report and exits non-zero on any failed check.
- **The real app**: the real Rust core, SQLite, plugin manager, tray refresher and webview. The UI is the real `ui/` over the real `workspace_request`, with no mocked bridge.
- **Self-driving**: navigation, view and theme changes and in-app actions run inside the webview, through the router, the store's `mutate` and DOM events. There are no OS mouse or keyboard events.
- **Invisible to the user**: no focus taken, no activation, no Dock icon, no menu-bar icon, no window on top of theirs, and nothing new on a shared screen.
- **Offline and sends nothing**: no Microsoft, Teams, Todoist, Claude, Ollama or CodeMie call, and no update check.
- **Evidence per stop**: a screenshot, each check with pass or fail, and the git SHA of the build. The menu bar is evidenced by its computed state, because it can't be photographed without the desktop.
- **Coverage you can read**: a table of every spec feature of steps 0–7, each mapped to its tour stops. A built feature with no stop is red.
- **Part of the pipeline**: item 4 of every step's Definition of done from step 7 on. It runs once now for steps 0–7. Steps 8 and 9 extend the matrix.

## Non-goals

- Replacing the browser run (items 2 and 3). The browser run keeps the full matrix of both views, both themes and three widths, plus the interaction-heavy checks: drags, Undo timing, the send confirm. The tour samples the matrix and proves the real app draws the same things over real storage.
- Replacing `CODEMIE_STATUS_SMOKE=status` on the user's own data. Item 4 keeps it.
- Photographing the macOS menu bar, notifications or the tray menu.
- Installing into `/Applications`, signing or making a DMG.
- A tour in a release build, or on Windows.

## Anti-goals

- **Anything leaves the Mac.** That covers a reply, a mail, a Teams message, a task in Todoist, a Claude run, a marketplace fetch and an update check.
- **The tour touches the user's things.** That means their data folder, `~/Library` app data, their WebKit storage, their running Connect or its single-instance socket, their windows, focus or Dock, `~/.zprofile`, `~/.codemie`, or any process the tour didn't start.
- **A pass that tested nothing.** Examples: a blank screenshot, a stop whose check never ran, a report from an earlier run, or a feature counted as covered by a stop that failed.
- **A tour build that can ship.** The tour code must not exist in a release build.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **A. A tour mode inside the debug app.** The window runs a script of stops; Rust snapshots its own WKWebView in-process. | Needs a feature-gated mode, like the smokes have. Capture needs no permission and no desktop. | **Chosen** |
| B. Drive the running app from outside: AppleScript, the accessibility API or synthetic events, with `screencapture` of the screen. | Needs the desktop, steals focus, needs Accessibility and Screen Recording, and breaks while the user works. | Rejected by the user |
| C. WebDriver (`tauri-driver`). | Not supported on macOS for WKWebView. | Rejected |
| D. Point the browser run's Playwright at the app's assets. | Not the real app: it keeps the mocked bridge. | Rejected: that is item 2 |

## Design

### 1. The switch

- **`CODEMIE_TOUR`**: the stops to run. `all`, or a comma list of rollout steps (`0,3,7`) or stop ids (`T05,T21`). An unknown value exits 3 and names it.
- **The `tour` Cargo feature** (`tour = ["test-support"]` in `src-tauri/Cargo.toml`) holds all tour code. Only `make tour` turns it on. The gates:
  - `#[cfg(all(feature = "tour", not(debug_assertions)))] compile_error!("the tour runs in debug builds only")` in `lib.rs`. A release build with the feature does not compile.
  - Without the feature, `commands::tour::requested()` is a stub. A debug build with `CODEMIE_TOUR` set exits 3: "Build the tour with `make tour`." A release build ignores the variable.
  - `test-support` comes with it. Core's `home` is then `<data>/home`, never the real home (`workspace/mod.rs::Core::open_with`). The comment on `test-support` in `Cargo.toml` changes from "the app is never built with it" to "the app is built with it only by `make tour`".
- **Refusals** (exit 3, a sentence on stderr):
  - `CODEMIE_WORKSPACE_TEST_DIR` is not set, or is not absolute;
  - the folder holds anything but the seed (`tour-seed.json`, `Meetings/`, `home/`);
  - `CODEMIE_STATUS_SMOKE` or `CODEMIE_PLUGIN_SMOKE` is set too;
  - `CODEMIE_TOUR_SHA` is missing (the report must name its build).
- **Exit codes**, as the smokes use them: 0 every check passed; 1 a check failed; 2 nothing reported within 600 s (watchdog); 3 can't run.
- **The single-instance lock.** The tour does not register `tauri_plugin_single_instance`, so it never creates or connects to the socket. The user's installed Connect keeps running, and neither app hands a launch to the other. That works only because every other thing the two could share is kept apart (§ 2).

### 2. Kept apart from the user's Connect and their Mac

`scripts/tour/run.sh` launches the binary with a built environment:

| Variable | Value | Why |
|---|---|---|
| `CODEMIE_WORKSPACE_TEST_DIR` | `<run>/workspace` | the data root and private root (credentials, locks, `window.json`) |
| `HOME`, `CFFIXED_USER_HOME` | `<run>/home` | `dirs` and `NSHomeDirectory()` both point here. The session log (`~/Library/Logs/CodeMie`), the default meetings root, `~/.codemie`, `~/.zprofile` reads and any AppKit preferences land in the test folder. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` | `http://127.0.0.1:9` | the backstop: reqwest, curl and git all fail at once on a closed loopback port. `NO_PROXY` is empty. |
| `GIT_ALLOW_PROTOCOL` | `file` | a git fetch of any remote fails |
| `PATH` | `/usr/bin:/bin:/usr/sbin:/sbin` | no `claude`, `codemie`, `ollama` or `gh` to find |
| `CODEMIE_TOUR`, `CODEMIE_TOUR_SHA` | from `make` | |

Here `<run>` is `$TMPDIR/connect-tour-<timestamp>`.

In the app, tour mode adds:
- **A quiet Core** (`Core::open_tour`):
  - `FakeRunner` (any run answers "The tour doesn't call Claude." and is never reached);
  - `ProfileCache::fixed` with the seed's three profiles (§ 4);
  - `FakeGraph::default()` (offline);
  - `FakeAnalyticsCli`.
- **No background loop.** `Core::start` in tour mode starts only the menu-bar refresher. There are no schedules, jobs, Graph sync, task sync, automations, meeting rounds or notifications. The seed is the whole world, so every screenshot is deterministic for its seed.
- **The task provider is `FakeProvider`**, set before the plugin manager starts. The manager's own `set_task_providers` then logs "set already" and does nothing.
- **The plugin manager runs**, with `http::Client::offline()` as its `Outside.http`, so Settings › Plugins is real.
- **Nothing is sent.** `action_prepare` and `action_confirm` refuse with code `tour` and the message "The tour sends nothing." This is checked in `Core::request` before the mutation lock. The runner's deny-list (§ 5) is the first guard; this is the second.
- **The window boot** (`ui/workspace/app.js`) skips `codemie.boot()` (as the marketplace smoke does), the app-update check and the CodeMie setup sheet.
- **WebKit storage**: the main window is `incognito` (a non-persistent `WKWebsiteDataStore`). Window preferences (the view mirror, docks, hidden meetings) live in memory and go when the process ends.

### 3. Invisible: activation, window, capture

**Activation.**
- `tauri::Builder::activate_ignoring_other_apps(false)` when touring. tao otherwise calls `activateIgnoringOtherApps(true)` at launch.
- `ActivationPolicy::Accessory` in setup: no Dock icon, no app menu, and Connect never becomes the active app.

**The window.** `run()` edits the context's config before `build` (`context.config_mut().app.windows[0]`):
- `visible: false`, so tao's launch hack (`window_activation_hack`) never calls `makeKeyAndOrderFront`;
- `focus: false`, `focusable: false`, `skip_taskbar: true`, `incognito: true`.

After setup, `tour::hide_window` (macOS, objc2):
- sets `alphaValue = 0` and `ignoresMouseEvents = YES`;
- sets the level to `kCGNormalWindowLevel - 1`;
- sets `collectionBehavior` to `.transient | .ignoresCycle` (not in Mission Control or ⌘`);
- places the window on the main screen's visible frame, bottom-left, and orders it in with `orderBack:` (no key, no main, no activation);
- calls `-[WKWebView _setWindowOcclusionDetectionEnabled:NO]` when the webview responds to it. That keeps WebKit painting and `visibilityState` "visible" while the window sits behind the user's windows.

Click-through and fully transparent, the window shows nothing on the screen or in a screen share.

**Tray.** `setup_tray` runs as usual, so the refresher has its sink and `app.tray_by_id("main")` exists. The tour then calls `tray.set_visible(false)`: no icon in the menu bar.

**Capture.** `tour_capture {id}` (Rust, main thread through `WebviewWindow::with_webview`):
1. casts the platform webview to `WKWebView`;
2. calls `takeSnapshotWithConfiguration:completionHandler:` with a default `WKSnapshotConfiguration` (the visible web content at the window's size, with plugin frames composited);
3. encodes the `NSImage` as PNG through `NSBitmapImageRep`;
4. writes `<test dir>/tour/shots/<id>.png`.

It answers `{path, width, height, blank}`. `blank` is true when 1,024 sampled pixels are all the same colour, and a blank capture fails its stop. WebKit renders the snapshot in its own process, so no Screen Recording permission is asked for and nothing on the real screen is read.

**Is an off-screen window capturable?** Probably, but not reliably: an off-screen or occluded window is "hidden" to WebKit, which pauses painting, and a snapshot can come back stale or blank. That is why the ruling is a transparent window that stays on screen, with occlusion detection off. Task 5 proves it. If it fails, the fallbacks are in the Rulings.

**Window size.** `tour_window {width, height}` sets the inner size (height 900; widths 1000, 1440 or 1680, as in the browser run) and keeps the window in place.

### 4. The seed

`scripts/tour/seed.mjs <test dir>` builds the seed with the browser run's own builders, so the real app shows the same invented people and the screenshots compare with the browser run's. It writes `<test dir>/tour-seed.json` and the meeting folders. `commands::tour::seed::import` writes it into a fresh `workspace.sqlite` with the `Repository` API before `Core::open_tour` opens it.

| For | Seed (all times relative to the run's start) | From |
|---|---|---|
| Microsoft | the fixture's connection, `status: "connected"`, scopes Calendars.Read, Mail.Read, Chat.Read, Mail.Send, ChatMessage.Send; `enabled` with `mail_send` and `chat_send` (so Send buttons show). No credential file: any Graph call would be `needs_login`, and none is made. | `buildSnapshot` |
| Inbox | the fixture's messages and chats: needs-reply mail from Priya, a Teams 1:1 with Jordan, the Release crew group chat, one unacknowledged critical message, FYI and low; summaries and an AI draft record | `buildSnapshot`, `draft-ai.json`, `summary.json` |
| Meetings | ready, downloaded, pending and failed meetings; the ready one with two documents (Meeting notes, Short summary), a transcript and `tasks.json`; its folder under `<test dir>/Meetings` | `withMeetings`, `meetingFolders` (paths moved from `/Users/taylor/...` to the test folder) |
| Settings › Meetings | `openOn: "summary"`, action items on, pinned summaries `formal-summary` and `short-summary` | `meeting-view-settings.json` |
| Tasks | Todoist active (`tasks.provider = "plugin:todoist"`, `copyOffered` empty, so choosing Todoist again asks to copy): late, today, a task due in 20 days, next 7 days, no date, a `waiting` "Check with Marek" task with a synced thread, a looks-handled reply task, one pending, one parked; Local tasks for the Board stop | `withTasks`, `task-sync-cases.json` and the `allTodoist` and `marekCheckIn` transforms, exported from `ui/test/browser/tasks-provider-checks.mjs` and not copied |
| Task provider | `FakeProvider` with `available = [{id: "plugin:todoist", name: "Todoist", on: true, ready: true}]` and the same tasks in its remote store | `task-provider-states.json` (`ready`) |
| Automations | the habit automations (Inbox triage, Commitments, Morning briefing, Formal meeting summary) and their runs: a triage run that made 2 tasks in Todoist with 1 already there, a summary run, and a failed Commitments run (amber); one run with `fallbackFrom` | `withAutomations(s, now, {habits: true})`, `automation-run-*.json` |
| Menu bar | `menuBar` settings all four on; a `menu_bar_seen` record with `since` one day before the run, so the seeded notes and runs count as new; count above 0 and amber (the failed run and the parked task) | `menu-bar-states.json` (`amberWithCount`) for the expected shape |
| AI | profiles "Claude Code" (ready), "CodeMie · prod" (ready) and "CodeMie · local-ollama" (engine Ollama, `not_running`); default Claude Code with fallback CodeMie · prod; Inbox triage on local-ollama with fallback Claude Code (Using fallback); one job on local-ollama with no fallback (Not working); Ask hidden | `ai-status.json`, `ai-route-cases.json` |
| Plugins | the built-ins `codemie`, then `onetest`, "Not fetched yet"; installed and on: the browser run's `hello` (its page draws in its frame), an offline Todoist stand-in that provides tasks (`scripts/tour/plugins/todoist`, no token), and `digest`, which agreed to Claude and has `call.minutes` (`scripts/tour/plugins/digest`) | step 0 |
| Window | `theme: "light"`, `view: "default"`, `hiddenPages: []` | |

The seed holds no secret. Every e-mail address is `@example.test`. No path in it points outside the test folder; the import refuses one that does (`validation`, naming the field).

### 5. The tour script and runner

**Where.** `ui/workspace/tour/`:
- `script.js` lists the stops (pure data);
- `coverage.js` lists the spec features (pure data);
- `runner.js` (`runTour`) runs them, with its DOM, store and invoke passed in, so `node:test` drives it over fakes.

`app.js` imports the runner only when `flags.tour` is set, after boot.

**A stop:** `{id, step, title, route, view, theme, width, action?, checks, covers}`.
- `route` is a hash: `#/settings/plugins`, or `#/meetings/<id>/summary` from a seed id.
- `view` is `default` or `compact`; `theme` is `light` or `dark`. Both are set through `mutate('settings_update', {view, theme})` when they differ from the current values.
- `action` is a name from `ACTIONS` in `runner.js`. Each one is an in-app step: a DOM `click()` on a `[data-action]` element, an `input` event on a text box, or a `mutate` of a REBASE_SAFE settings or task op.
- `checks` is a list of `{name, selector, text?, count?, absent?, before?}`. `noOverflow` (the page's `scrollWidth <= clientWidth`) is added to every stop.

**Runner, per stop:**
1. settings;
2. `tour_window`;
3. `goHash(route)`;
4. wait until `.ws-loading` and `.ws-spinner` are gone and two animation frames pass (at most 8 s);
5. action, then wait again;
6. checks;
7. `tour_capture`;
8. record the result.

A stop that throws is failed, with the error as its detail, and the tour goes on.

**Deny-list.** Before any action, the runner refuses (fails the stop, sends nothing):
- an op or `data-action` matching `/send|confirm|prepare|fetch|install|update|remove|delete|sign|login|test|refresh/` (`refresh`: a marketplace's Fetch is `market-refresh`), except `settings_update`, and any `settings_update` of `launchAtLogin`;
- a `data-action` matching `/open|reveal|pick|link|terminal|download/` (Finder, Terminal, a browser, a picker, a download), except in-window folds named one by one (`task-row-open`);
- `invoke` of anything but `workspace_request`, `plugins_request` with `markets` or `installed`, `smoke_mode`, `get_app_version` and the `tour_*` commands.

The window's own `invoke` goes through the same gate (`gate` in `runner.js`), for every call it makes to native: a send word, or `/open|reveal|pick|link|download|relaunch|restart/` in the command (or `plugins_request:<op>`), is refused before it is sent and recorded. A stop may lift one named control or request with `allow` (T60 removes the Todoist plugin); `allow` never lifts a send. Rust refuses every desktop opener in tour mode with "The tour opens nothing." (`commands::tour::opens_nothing`, called by the folder pickers, Finder reveals, `open` launches, a relaunch and every external link), so the window's gate is the first guard and Rust the second.

Each captured stop also checks `noClip` (the browser run's: nothing the user sees overflows its box, or is cut off without an ellipsis). A stop with `frame` also judges the capture's area under that element on its own (`tour_capture {region}` answers `regionBlank`). A stop with `next` takes a second picture (`<id>-next`) after a second action.

Every `workspace_request` op is recorded (`recordOps` from `status-smoke.js`), and the report lists them.

**The menu bar stop** calls `tour_menu_bar`. It answers the status smoke's `menu_bar_facts` (made `pub(crate)`): whether the tray exists, the applied view `{title, amber, tooltipLength, rows}` and the forced recount `{count, label, amber}`. It also returns the row texts of the applied menu (`menu_bar::rows`), which are seeded invented text. The stop checks that the applied view equals the recount, `amber == true` and `count > 0`. The report draws this as a table under "Menu bar: computed state, not a screenshot (the tray can't be captured without the desktop)".

### 6. The stops for steps 0–7

Seed ids are named in the plan. 60 stops: every stop but T28 is captured, and T23 also takes `T23-next`, so a full tour writes 60 screenshots. T01–T30 are the first table's; T31–T60 were added in Task 6 (T31 the plugin frame, Ruling 5; T32–T60 every built feature T01–T30 didn't check). The real app's answers changed four rows of the first table: T06's ⋯ has no Summarize (offered only on a long conversation), T14 reads "Add 1 to Todoist" (the seed ticks only the user's own item), T17 goes back to the summary after its capture, and T23 returns to Todoist through the Copy dialog (`copyOffered` starts empty).

| Stop | Step | Route | View · theme · width | Action | Must be visible |
|---|---|---|---|---|---|
| T01 | 0 | settings/plugins | default · light · 1440 | none | `codemie` with Built-in, listed before `onetest`; no remove button on either; `codemie` "Not fetched yet" |
| T02 | 1 | settings/appearance | compact · dark · 1440 | none | View card, Compact pressed; `#workspace-app[data-view="compact"]` |
| T03 | 1 | inbox | default · light · 1440 | none | the list and the reading pane |
| T04 | 1 | inbox | compact · dark · 1440 | none | one list, no reading pane, no row open, rows one line |
| T05 | 1, 2 | inbox | compact · dark · 1440 | open Jordan's 1:1 | thread and reply box under the row; "Write a reply, or ✦ draft with AI"; primary "Send to Jordan", Snooze ▾, ⋯ and no fourth control |
| T06 | 2 | inbox | compact · dark · 1440 | open ⋯ | Done, Draft options…, Summarize, Open in Teams, Move to lane, Add a task, in that order |
| T07 | 2 | inbox | compact · dark · 1440 | type "Sure, at 14:30." | the "✦ Tell AI what to change" line; "Saved on this device" after autosave |
| T08 | 2 | inbox | default · light · 1440 | select Priya's mail | primary "Send to Priya…" |
| T09 | 2 | inbox | default · dark · 1000 | select the critical message | Acknowledge in Snooze's place; three controls |
| T10 | 1 | today | compact · light · 1440 | none | date and summary line, no avatar, no greeting; one ⋯ |
| T11 | 1 | today | compact · light · 1440 | open ⋯ | Layouts, Add widget, Customize, Lock layouts |
| T12 | 1, 4, 5 | today | default · dark · 1680 | none | no layout toolbar, ⋯ present; Tasks widget with no trash button; "Made 2 tasks in Todoist ›" |
| T13 | 1 | settings/layout | default · light · 1440 | hide Calendar, then show it again | Menu card with a switch per page; Calendar gone from `.ws-nav` while hidden |
| T14 | 3, 4 | meetings/<ready>/summary | default · light · 1440 | none | summary tab active; strip with one primary and ⋯; action items column; "Add 2 to Todoist" |
| T15 | 3 | meetings/<ready>/summary | default · light · 1440 | none | pinned tabs Formal summary, Short summary, in that order |
| T16 | 3 | meetings/<ready>/summary | default · light · 1440 | open ⋯ | Transcript, Notes, Advanced › Files |
| T17 | 3 | meetings/<ready>/transcript | compact · dark · 1000 | none | "← Back to summary"; the transcript |
| T18 | 3 | meetings | compact · dark · 1000 | none | the list with Needs you |
| T19 | 3, 5 | settings/meetings-templates | default · light · 1440 | none | "When you open a meeting" (Summary, Transcript, Notes), the switch, the pinned list; a Formal summary template card |
| T20 | 4 | tasks | default · light · 1440 | none | By date and List, no Board; To review; Late, Today; folds Next 7 days, No date, Later than that; "Check with Marek"; Looks handled; the "Not in Todoist yet" dot; the parked row's sentence |
| T21 | 4 | tasks | default · light · 1440 | unfold the Check with row | Nudge Marek, Snooze ▾, ⋯ |
| T22 | 4 | settings/meetings-tasks | default · dark · 1440 | none | "Where your tasks live": Connect, Todoist chosen |
| T23 | 4 | tasks | compact · light · 1440 | `task_provider_set {provider: "local"}`; then (`T23-next`) Settings › Tasks › Todoist, and "Not now" after capture | Board, List and By date; the board; next: "Copy your open tasks to Todoist?" with Not now and Copy |
| T24 | 5 | automations/templates | default · light · 1440 | none | Morning briefing, Inbox triage, Commitments, Budget request reply, Formal meeting summary, in that order |
| T25 | 5 | automations/templates | default · light · 1440 | Use template on Inbox triage, then Cancel after capture | "Tasks in Todoist" in Deliver |
| T26 | 5, 7 | automations/runs | compact · dark · 1440 | unfold the triage run | "Tasks: 2 made in Todoist, 1 already there"; the fallback line on the run with `fallbackFrom` |
| T27 | 6 | settings/notifications | default · light · 1440 | none | Menu bar card with four switches, all on; Needs fixing row with Fix |
| T28 | 6 | (none) | · | `tour_menu_bar` | evidence: tray exists, applied equals recount, amber, count > 0 (no screenshot) |
| T29 | 7 | settings/ai | default · light · 1440 | none | tab label "AI"; groups Replies, Summaries and notes, Automations, Plugins; a Fallback select per row; chips Working, Using fallback, Not working; the Ollama card with Engine Ollama and Not running |
| T30 | 7 | settings/ai | compact · dark · 1000 | none | two-line rows, no overflow |
| T31 | 0 | p/hello/home | default · dark · 1440 | none | its frame told the window it is ready; its frame lies over its slot (plugins-checks.mjs `framed`); its sidebar entry is current |
| T32 | 0 | settings/plugins | default · dark · 1440 | click, type, click; after: click | refused: "That marketplace is already added, as “codemie”." |
| T33 | 1 | settings/layout | compact · light · 1440 | `settings_update`, go #/calendar; after: `settings_update` | Calendar opened; greyed in the menu while open |
| T34 | 1 | settings/layout | default · dark · 1440 | `settings_update`; after: `settings_update` | the Inbox switch is disabled; "Keep one page in the menu." |
| T35 | 2 | inbox | default · dark · 1440 | `settings_update`, selectRow; after: `settings_update` | primary "Copy reply"; no Send |
| T36 | 2 | inbox | default · light · 1440 | selectRow | it is in the reading pane; no reply box; Done is the primary |
| T37 | 2 | inbox | compact · light · 1440 | openRow | primary "Send to Release crew" |
| T38 | 2 | inbox | default · light · 1440 | openMore | Snooze and its four choices under ⋯ |
| T39 | 2 | inbox | default · dark · 1680 | openMore, click; after: click | the Draft with AI popover; its tones |
| T40 | 2 | settings/microsoft | default · light · 1440 | none | the Allow actions copy; a switch per action |
| T41 | 3 | meetings/<ready>/summary | default · light · 1440 | menu | the header’s "with …"; the people popover |
| T42 | 3 | meetings/<ready>/summary | default · dark · 1440 | click | "No Formal summary yet."; the primary "Make Formal summary" |
| T43 | 3 | meetings/<ready>/summary | default · light · 1440 | `settings_update`, menu; after: `settings_update` | no column; "Review N tasks"; ⋯ › Action items |
| T44 | 3, 4 | meetings/<ready>/summary | default · dark · 1680 | click; after: click | "Added 1 to Todoist · Undo" |
| T45 | 3 | meetings/<ready>/summary | default · light · 1000 | none | the column is below the pane |
| T46 | 3 | settings/meetings-templates | compact · dark · 1440 | menu | Pin a summary ▾ offers the other templates; a template card offers "Pin as a summary tab" |
| T47 | 3 | meetings/<ready>/summary | default · light · 1440 | `settings_update`, go #/meetings/mtg-philips/summary, click; after: `settings_update` | the Digest tab, first; its minutes, as text |
| T48 | 3 | meetings/<ready>/notes | default · dark · 1440 | none | the Notes pane with its document picker |
| T49 | 3 | meetings/<ready>/tasks | compact · light · 1440 | none | the summary pane; the action items column |
| T50 | 4 | tasks | default · dark · 1440 | click | To review is cleared; "N tasks accepted. They’re on your board." |
| T51 | 4 | tasks | compact · dark · 1000 | menu | Move all to Tomorrow, Move all to Monday, Pick date…, Done all |
| T52 | 4 | tasks | default · light · 1680 | click; after: click | "Marked 1 done · Undo" |
| T53 | 4 | tasks | default · light · 1440 | menu | the status line names Todoist; ⋯ › Sync now and Settings › Tasks |
| T54 | 4 | inbox | default · light · 1440 | openMore, click, click | the toast says it is in Todoist |
| T55 | 4 | tasks | default · dark · 1440 | unfoldTask, click | the reply box holds the nudge |
| T56 | 5 | automations/templates | compact · dark · 1440 | useTemplate; after: cancelModal | Make is Formal summary; "Wishes (optional)"; no Read box |
| T57 | 5 | automations/automations | default · light · 1440 | none | Inbox triage delivers to Today and Tasks |
| T58 | 5 | automations/runs | default · light · 1440 | unfoldRun | "Formal summary queued for …"; Open meeting |
| T59 | 7 | inbox | default · dark · 1440 | `ai_settings_save`, selectRow, click; after: click, `ai_settings_save` | "Choose which AI writes for you"; Claude Code and CodeMie · prod, the ready profiles; the not-running Ollama profile is not offered |
| T60 | 4 | settings/plugins/todoist | default · light · 1440 | click, click | "Todoist was removed, so tasks are back in Connect." |

### 7. The coverage matrix

`coverage.js` lists every user-visible feature of each step as `{id, step, text, spec, status}`:
- `status` is `built`, `browser` or `planned`;
- `spec` is the design file and section.

Each stop's `covers` names feature ids. The report's table has one row per feature:
- **green**: a passing stop covers it;
- **red**: a built feature with no stop, or whose stops all failed;
- **amber**: `browser`, shown with its reason and the browser set that covers it;
- **grey**: `planned`.

`browser` is only for what the real app can't show without sending or without the desktop, or a state the seed doesn't hold. There are eight today:
- the mail confirm dialog (it needs `action_prepare`, which reads Microsoft): `reply` R6;
- a Teams send on click, and ⌘↩ (real sends): `reply` R4 and R7;
- the task-provider banners for `needs_token`, `off` and `failed` (the seed has one provider state): `tasks-provider` P8;
- "Delete … in Todoist too?" (its yes deletes in Todoist): `tasks-dates` provider check;
- a tray row's click and seen marks (the macOS menu bar; marks need window focus): `menu-bar` M6 and M5;
- the chooser's line for a running Ollama (the seed's Ollama is `not_running`): `ai-routes` R5.

One Settings › AI row per plugin with `claude` agreed is `built`: the seed installs `digest`, which agreed to Claude.

Steps 8 (reply in your voice) and 9 (Ask inline) are listed `planned`. Each later step changes them to `built` and adds its stops in the same change as its code.

### 8. Evidence and report

**What Rust writes.** `tour_report {report}` adds Rust's view (run id, SHA, start and end time, the binary's path and mtime, the menu-bar facts) and decides the verdict:
- the tour fails on any failed check, a blank capture, a stop with no checks, a report whose run id isn't this run's, or a `tour` refusal;
- it writes `<test dir>/tour/results.json`, prints `TOUR {path, pass, failed}` and exits.

**The HTML.** `scripts/tour/report.mjs <test dir> <out dir>` writes `output/tour/<yyyymmdd-hhmmss>-<sha>/index.html` (`output/` is git-ignored). The file is self-contained: screenshots are inlined as `data:image/png;base64`, CSS is inline and there are no scripts.
- **Header:** SHA (with "+dirty" when the tree had changes), build time, run time, verdict, counts.
- **Coverage table** (§ 7) first.
- **Then one section per rollout step**: each stop's title, route, view, theme, width, its checks with pass or fail and detail, and its screenshot. The menu bar stop has its table.
- **Last:** the ops the tour sent, and any refusal.

Every string is escaped. The report is in Connect's light theme with a dark-mode media query, and has no external fonts.

### 9. `make tour`

`make tour` (optional `ONLY=0,3` or `ONLY=T05`) runs `scripts/tour/run.sh`:
1. **Lock**: `mkdir $TMPDIR/connect-tour.lock` (atomic). If it exists: "Another tour is running." and exit 3. It is removed on exit by a `trap`.
2. **Build**: `cd src-tauri && CARGO_TARGET_DIR=target/tour cargo build --features tour`. Cargo rebuilds only when Rust or `ui/` files changed, because Tauri embeds `ui/` and `tauri-build` tracks it. The separate target folder keeps the normal debug build from being rebuilt each time. The staged runtime is a prerequisite, as for the other cargo targets (`| $(NODE_BIN)`).
3. **Seed**: `<run>` = `$TMPDIR/connect-tour-<timestamp>`; `node scripts/tour/seed.mjs <run>/workspace`.
4. **Run**: launch `src-tauri/target/tour/debug/app` with the § 2 environment, in the background, and keep its PID. A 660 s watchdog kills that PID only. `wait` gives the exit code.
5. **Report**: `node scripts/tour/report.mjs <run>/workspace <repo>/output/tour/<stamp>-<sha>`. This runs even after a failed tour, as long as `results.json` exists.
6. **Print**: the report path, the verdict and `<run>`. Exit with the app's code (2 or 3 unchanged).

The test folder is left for inspection, and the OS clears `$TMPDIR`.

### 10. In the pipeline

- **Rollout overview, Definition of done item 4** becomes: "**The real app:** `make tour` passes and its HTML report has been shown to the user, with no red row for this step or an earlier one; `CODEMIE_STATUS_SMOKE=status` passes on the user's data."
- **From step 7 on**, each step's plan ends with `make tour`. A step that adds user-visible features adds their `coverage.js` rows and their stops in the same change.
- **Now**: one run for steps 0–7, retroactively. Its report is the evidence for steps 0–7's item 4.

## Copy

- Refusals: "CODEMIE_TOUR runs in a debug build made with `make tour`." · "Set CODEMIE_WORKSPACE_TEST_DIR to a fresh folder; the tour never opens your own data." · "That folder isn't a fresh tour seed: <path>." · "Run the tour without CODEMIE_STATUS_SMOKE or CODEMIE_PLUGIN_SMOKE." · "Another tour is running."
- `tour` refusal of a send: "The tour sends nothing."
- Report title: "CodeMie Connect · real-app tour · <sha>"; the menu bar's note: "Computed state, not a screenshot: the tray can't be captured without the desktop."

## Rulings

1. **The switch**: `CODEMIE_TOUR=all|<steps>|<stop ids>`, code only under the `tour` Cargo feature, `compile_error!` without debug assertions. *If wrong:* tour code reaches a release build. The compile error makes that impossible, not unlikely.
2. **Single-instance**: the tour skips the lock and runs beside the user's Connect, with nothing shared (§ 2). The user doesn't quit Connect. *If wrong:* the two collide on something missed. The likely one is WebKit storage, which `incognito` plus `CFFIXED_USER_HOME` cover. The fallback is to refuse beside a running Connect, as the smokes do, at the cost of asking the user to quit Connect for each run.
3. **No focus theft**: `activate_ignoring_other_apps(false)`, Accessory policy, a window created invisible and non-focusable, then ordered back at alpha 0, click-through, below normal level, out of Mission Control. *If wrong:* the window flashes or takes focus once during the user's meeting. Task 5 checks `NSApp.isActive == false` and the window's `isKeyWindow == false` after start and after each stop, and the tour fails if either turned true.
4. **Placement**: on the main screen, transparent, behind; not off-screen. Off-screen windows are throttled by WebKit and can be constrained back on screen by AppKit. *If wrong:* blank or stale captures. The blank check catches it. Fallbacks in order: (a) off-screen at the right of all screens with occlusion detection off; (b) on screen at alpha 0.01 at the lowest level; (c) `screencapture -l <windowId>`, which needs Screen Recording.
5. **Capture**: in-process `WKWebView takeSnapshot`, through `with_webview`, with `objc2-web-kit` 0.3.2 (already in `Cargo.lock` through wry). No permission is needed. *If wrong* (for example, frames not composited): plugin frames look empty in the evidence. Only T01 and later plugin stops would show it, and Task 5 checks a frame.
6. **Private API**: `_setWindowOcclusionDetectionEnabled:` is called only in the tour build, only after `respondsToSelector:`. *If wrong* (a macOS update drops it): captures go stale behind other windows. The blank check and a stop-to-stop difference check (two stops on different routes may not give identical PNGs) catch it.
7. **Offline by construction**: fakes for Claude, Graph, analytics and tasks; no background loop; an offline plugin HTTP client; `action_prepare` and `action_confirm` refused; proxy, `GIT_ALLOW_PROTOCOL` and `PATH` backstops. *If wrong:* one request leaks. It goes to a closed loopback port, so even then nothing leaves.
8. **Seed**: built in Node from the browser run's fixture builders and contract JSON, imported by Rust through `Repository` before Core opens. *If wrong* (the fixture drifts from what native stores): the import refuses a record, the tour exits 3 naming it, and the fix goes in the fixture, where the browser run benefits too.
9. **Background loop off**: the tour shows the seed as stored, with no jobs, sync or schedules. *If wrong:* a screen that only fills after a job (a running draft, a sync) can't be toured. Those states are seeded as records instead.
10. **Window state in memory** (`incognito`): docks, the view mirror and hidden meetings start fresh each run. *If wrong:* a stop that depends on a stored dock layout can't be set up; seed it through the runner's `localStorage` before the stop instead.
11. **The matrix is sampled**, not crossed: each step's screens appear in both views and both themes across its stops, and every stop checks for overflow. The browser run keeps the full cross. *If wrong:* a real-app-only bug in one cell of the cross is missed until the browser run or the user sees it.
12. **`browser` coverage**: only for what needs a send or the desktop (§ 7, three rows today), shown amber with the covering set. *If wrong:* amber hides a real gap. Every amber row names the browser check by file, and the plan's final task opens each to confirm it exists.
13. **Menu bar evidence**: the computed and applied tray state from `menu_bar_facts`, not a picture, said so in the report. *If wrong:* the icon's look (amber glyph) is unverified in the real app. That stays for the announced desktop pass the menu-bar plan already defers.
14. **Build**: `cargo build --features tour` into `src-tauri/target/tour`, the binary run in place. No bundle, no `/Applications`. *If wrong:* the bundle differs from the binary (resources, Info.plist). The tour doesn't touch bundled resources (no CLI, no Node runtime), so nothing on its route depends on them.
15. **Report**: one self-contained HTML file with inline PNGs under `output/tour/<stamp>-<sha>/`. *If wrong:* a large file (about 30 PNGs at 1–3 MB total). That is acceptable for a local, git-ignored file.

## What the user may have to do once

- **Nothing to approve**, if Task 5 confirms in-process capture: no Screen Recording, no Accessibility, no quitting Connect.
- **Only if the last fallback is needed** (Ruling 4c): one Screen Recording approval for the terminal app that runs `make tour`.
- **The first `make tour`** compiles a second debug target (`src-tauri/target/tour`, a few GB, several minutes). Later runs rebuild only what changed.

## Definition of done

1. `make check` passes (fmt, clippy, `npm test`, `cargo test`), and `cargo build --release` still compiles without the feature.
2. `make tour` on steps 0–7 exits 0. The report has no red row, every amber row names an existing browser check, and the report has been shown to the user.
3. During that run, the user's own Connect kept running, nothing appeared on screen, and focus never moved: `NSApp.isActive` stayed false (the runner's own check).
4. The guides name the tour: the testing guide's smoke modes table, the architecture guide's configuration table and the quality-gates guide.

## Left to the builder

- The exact selectors behind each check. Take them from the browser check sets, which already name them.
- The PNG sampling pattern for `blank`.
- The report's CSS.
