# Testing Patterns

**Project**: CodeMie Connect
**Rust tests**: `cargo test` — inline `#[cfg(test)]` modules
**JS tests**: `node --test` — `ui/test/*.test.mjs`

---

## Overview

Two suites run in CI: `node:test` files in `ui/test/` (pure UI modules, controllers over fakes, contract-fixture parity) and `cargo test` in `src-tauri/` (unit tests beside the code, integration tests in `src-tauri/tests/`). Rust tests write the JSON contract fixtures that the UI tests and the browser mock read; the Playwright browser run, the live Claude tests and the smoke modes are run by hand.

| Part | What it holds | Start here |
|---|---|---|
| `ui/test/` | node:test suites, one file per module | `package.json::test` |
| `ui/test/fixtures/` | snapshot builders and the contract JSON | `ui/test/fixtures/workspace-fixture.mjs::buildSnapshot` |
| `ui/test/browser/` | Chromium run of the real ui/ against a mocked native bridge | `ui/test/browser/workspace-e2e.mjs::WORKSPACE_E2E_ONLY` |
| `ui/test/tools/` | replays a captured setup transcript into fixtures | `ui/test/tools/replay-capture.mjs::FIXTURE_DIR` |
| `src-tauri/src/ (mod tests)` | unit tests next to the code, `test_core` for workspace tests | `src-tauri/src/workspace/mod.rs::test_core` |
| `src-tauri/src/testing.rs` | doubles for the integration tests (test-support feature) | `src-tauri/src/testing.rs::claude_profile` |
| `src-tauri/tests/` | integration tests: bundle resources, the published Echo plugins, Connect's own marketplace (Todoist) | `src-tauri/tests/echo_plugins.rs::CONNECT_ECHO_PLUGINS_DIR`, `src-tauri/tests/connect_marketplace.rs::CONNECT_MARKETPLACE_DIR` |

## Key abstractions

| Abstraction | What it is | Where |
|---|---|---|
| test_core | a `Core` over a temp folder with a scripted runner and fixed profiles | `src-tauri/src/workspace/mod.rs::test_core` |
| FakeRunner | scripted Claude outcomes; records each `RunSpec` | `src-tauri/src/ai/fake.rs::FakeRunner` |
| contract_fixture | checks or writes `ui/test/fixtures/contract/<name>` | `src-tauri/src/plugins/testkit.rs::contract_fixture` |
| buildSnapshot | synthetic snapshot for UI tests | `ui/test/fixtures/workspace-fixture.mjs::buildSnapshot` |
| fakeService | Settings → CodeMie service stand-in | `ui/test/codemie-fakes.mjs::fakeService` |
| FakeProvider | scripted `TaskProviders` for Core-only task-sync tests; records each call, can fail or lose an answer | `src-tauri/src/workspace/task_provider/fake.rs::FakeProvider` |
| FakeVoice | scripted `VoiceProviders` (a reply-context plugin) for Core-only voice tests; records each call, can answer, fail, be slow or still loading | `src-tauri/src/workspace/voice/fake.rs::FakeVoice` |
| FakeTodoist | a loopback server with the real Todoist plugin's habits, for the real plugin + real host sync tests in `connect_marketplace.rs` | `src-tauri/src/testing.rs::FakeTodoist` |
| FakeTray | records each tray view the menu-bar `Refresher` applies; `set_slow` proves applies never overlap | `src-tauri/src/workspace/menu_bar.rs::FakeTray` |

## Organization and naming

```
src-tauri/src/commands/
  runner.rs         unix-only mod tests — shell execution (real login shell)
  logger.rs         #[cfg(test)] mod tests — log line formatting, CLI debug log path
  inspector.rs      #[cfg(test)] mod tests — probes
src-tauri/src/workspace/meetings/
  tests.rs, notes_tests.rs   test modules declared in meetings/mod.rs
src-tauri/tests/
  bundle_resources.rs, echo_plugins.rs, connect_marketplace.rs   integration tests (test-support feature)
  fixtures/voice-skills/   invented skills for the skill import (budget-answers, long-standard, reply-style, and
                    broken, deploy-helper, meeting-notes that are not imported), read by workspace::voice tests

ui/test/
  engine.test.mjs   Engine orchestration (step sequencing, gates, fatal logic)
  models.test.mjs   StepStatus, STATUS_META, makeStep normalization
  workspace.test.mjs  Workspace store, calendar geometry, formatting, selectors and view rendering
  meetings-model.test.mjs, meetings-controller.test.mjs, settings-meetings.test.mjs, tasks-*.test.mjs
                    Meetings page, Settings › Meetings and the Tasks board (models, views, controllers over fakes)
  tasks-dates-model.test.mjs, settings-tasks.test.mjs
                    By date (groups, rows, chips, status line) and Settings › Tasks (the radio group, a plugin's
                    own settings, the copy dialog) over `task-provider-states.json`'s named states
  fixtures/workspace-fixture.mjs  Synthetic snapshot (invented people, relative times) for unit and browser tests
  browser/workspace-e2e.mjs       Chromium run of the real ui/ with a MOCKED native bridge
  browser/meetings-checks.mjs, browser/meetings-settings-checks.mjs   its Meetings and Settings › Meetings checks
  browser/tasks-dates-checks.mjs, browser/settings-tasks-checks.mjs   its By date and Settings › Tasks checks
  browser/layout-checks.mjs       its flexible-layout scenarios E1–E8 (Today grid, page sections, menus)
  browser/menu-bar-checks.mjs     its Menu bar card, seen marks and menu-row routing, M1–M8
  browser/ai-routes-checks.mjs    Settings › AI's rows, fallbacks and statuses, R1–R8
  browser/voice-checks.mjs        Settings › Your voice, the skill import and a draft's voice and facts, V1–V13
```

### Naming Conventions

| Element | Pattern | Example |
|---|---|---|
| Rust test fns | `snake_case describing behavior` | `run_capture_runs_via_shell_and_captures_stdout` |
| JS test names | plain string describing behavior | `'fatal failure halts and marks remaining SKIPPED'` |
| JS test files | `<module>.test.mjs` | `engine.test.mjs` |

### Rules
- R1. Put a JS test at `ui/test/<module>.test.mjs`: `npm test` runs the glob `ui/test/*.test.mjs`, so a file in a subfolder (`ui/test/browser/`) or without the `.test.mjs` suffix is not run. Evidence: `package.json::test`
- R2. Put Rust unit tests in a `#[cfg(test)] mod tests` inside the file under test; a module whose tests outgrow it keeps them in a sibling file declared `#[cfg(test)] mod tests;`, as `workspace/meetings/` does. Evidence: `src-tauri/src/workspace/meetings/tests.rs::contract_fixtures_match_the_real_meetings`
- R3. Put a test that needs crate internals from outside the crate in `src-tauri/tests/` and take its doubles from `app_lib::testing`, which exists with the `test-support` feature that the crate's own dev-dependency turns on. Evidence: `src-tauri/Cargo.toml::test-support`

---

## Running Tests

| Action | Command |
|---|---|
| All Rust tests | `cd src-tauri && cargo test` |
| Single Rust test | `cd src-tauri && cargo test <test_fn_name>` |
| All JS tests | `npm test` |
| Single JS file | `node --test ui/test/engine.test.mjs` |

---

## Rust Test Pattern

`commands/` tests run against the real system: tests that invoke `capture()` run actual shell commands via `/bin/zsh -lc`. Workspace, AI and plugin tests use doubles instead (see Mocking).

- Runner tests: `src-tauri/src/commands/runner.rs::run_capture_runs_via_shell_and_captures_stdout` — `#[tokio::test]` for async
- Logger tests: `src-tauri/src/commands/logger.rs::cli_debug_log_is_the_dated_file_under_codemie_logs` — synchronous `#[test]`
- Runtime tests: `src-tauri/src/commands/runtime.rs` (`mod tests`) — helpers take explicit paths, so tests lay out versioned dirs and links in tempdirs; no network

| ✅ DO | ❌ DON'T |
|---|---|
| Use `#[tokio::test]` for async command tests | Mix sync and async in the same test |
| Test behavior via real shell output | Mock the shell — test value is lost |
| Assert specific exit codes and trimmed stdout | Assert against raw untrimmed output |

---

## JS Test Pattern

JS tests use the `node:test` built-in runner with `node:assert/strict`. No test framework dependency.

Engine tests inject a synthetic `emit` function and stub `handlers` to verify orchestration behavior without Tauri — see `ui/test/engine.test.mjs::mkSteps`.

The macOS shim (`assets/macos/bin/codemie`) is executed in `ui/test/shim.test.mjs` under a throwaway `HOME` with a fake linked runtime, never against the real one.

Approval gate tests (`ignore()` / `approve()`) use a `setTimeout` shim to yield before calling the gate — see the approval-gate tests in `ui/test/engine.test.mjs`, which drive `ui/engine.js::Engine.approve`.

| ✅ DO | ❌ DON'T |
|---|---|
| Stub `emit` to capture events; assert on event names | Test Tauri `invoke()` — that's handler/integration territory |
| Use `assert.deepStrictEqual` for arrays | Use `==` loose equality |

---

## Writing New Tests

**Rust**: add a `#[cfg(test)]` block inside the same file as the code under test. For async commands use `#[tokio::test]`.

**JS**: add a `*.test.mjs` file under `ui/test/`. Import the module under test with a relative path. Use `node:test` and `node:assert`.

## Test shape

### Rules
- R1. Test a workspace UI controller through its factory with fakes for `mutate`, `render`, `openModal` and `toast`, asserting on the recorded calls and on the snapshot the fake `mutate` changed, as `harness` does; `node:test` cannot load `app.js`. Evidence: `ui/test/tasks-controller.test.mjs::harness`
- R2. Test a workspace operation in Rust over `test_core(tempdir, Arc::new(FakeRunner::new(...)), ready())`, building the request with `mutation(&core, Operation::…, data)` (a fresh operation id and the current revision) and calling `core.request`. Evidence: `src-tauri/src/workspace/ai.rs::mutation`

### Read first
| When you are | Exemplar | Why this one | Tests |
|---|---|---|---|
| testing a workspace operation | `src-tauri/src/workspace/ai.rs::mutation` | builds a request with a fresh operation id and the current revision | `src-tauri/src/workspace/tasks.rs::task_delete_returns_the_body_and_save_restores_it` |
| testing a page controller | `ui/test/tasks-controller.test.mjs::harness` | fakes record `mutate` calls and apply them to the snapshot | exemplar is a test |

## Fixtures and factories

### Rules
- R1. Write a native response the UI depends on to `ui/test/fixtures/contract/` with `contract_fixture` from a real call in a Rust test; UI tests and the browser mock read that JSON, and the Rust test fails while the file is stale. Evidence: `src-tauri/src/plugins/testkit.rs::contract_fixture`
- R2. Build UI test state with `buildSnapshot(now, options)` and the `with…` helpers (`withTasks`, `withMeetings`, `withAutomations`), which merge the contract records, rather than hand-written snapshots. Evidence: `ui/test/fixtures/workspace-fixture.mjs::withTasks`
- R3. Use invented people and mapped paths in fixtures (`MEETINGS_ROOT` is under `/Users/taylor`), not real accounts or home folders. Evidence: `ui/test/fixtures/workspace-fixture.mjs::MEETINGS_ROOT`

## Mocking

### Rules
- R1. Stand in for Claude with `FakeRunner` (scripted outcomes, recorded `RunSpec`s) and for the Microsoft reads an AI run makes with `ai_jobs::FakeGraph`; `test_core` wires both into the `Core` a workspace test opens. Evidence: `src-tauri/src/ai/fake.rs::FakeRunner`
- R2. Fake Settings → CodeMie with `fakeService` from `ui/test/codemie-fakes.mjs`, which records each call by name. Evidence: `ui/test/codemie-fakes.mjs::fakeService`
- R3. Keep `commands/runner.rs` tests on the real login shell, asserting the exit code and trimmed stdout; they compile under `#[cfg(all(test, unix))]`. Evidence: `src-tauri/src/commands/runner.rs::run_capture_runs_via_shell_and_captures_stdout`

### Constraints
| Do not | Do instead | Why | Evidence |
|---|---|---|---|
| Start `claude` from a test | `FakeRunner` through `test_core`; real runs only in the `#[ignore]` `live_*` tests | a real run spends tokens and needs a signed-in Claude | `src-tauri/src/ai/runner.rs::live_native_isolated_run` |

## Database testing

### Rules
- R1. Test repository and workspace code against real SQLite in a `tempfile::tempdir()` through `test_core`, which puts the data and private roots in that folder; a test does not open the person's data folder. Evidence: `src-tauri/src/workspace/mod.rs::test_core`

## Test environment

### Rules
- R1. Point `CONNECT_ECHO_PLUGINS_DIR` at an echo-plugins checkout to run `tests/echo_plugins.rs` for real; when the folder is missing, its tests print `skipped:` and pass. Evidence: `src-tauri/tests/echo_plugins.rs::CONNECT_ECHO_PLUGINS_DIR`
- R2. Point `CONNECT_MARKETPLACE_DIR` at a codemie-connect-marketplace checkout (default `$HOME/repos/codemie-ai/codemie-connect-marketplace`) to run `tests/connect_marketplace.rs` for real; when it has no Todoist plugin, its tests print `skipped:` and pass. Evidence: `src-tauri/tests/connect_marketplace.rs::CONNECT_MARKETPLACE_DIR`

---

## Milestone 2 test patterns

**Live `#[ignore]` tests.** `src-tauri/src/ai/runner.rs` has real one-word Claude prompts (`live_native_isolated_run`, `live_codemie_isolated_run`) that need a signed-in Claude and are never part of `cargo test`. Run them by hand: `cd src-tauri && cargo test live_ -- --ignored`. Nothing else in the suite spends tokens or touches the network.

**Live analytics tests.** `src-tauri/src/workspace/analytics/live_tests.rs` has seven `#[ignore]` `live_*` tests that run Connect's real analytics backend (a `Core` with the real `CodemieCli`) against the `codemie` on `PATH` and this Mac's own agent logs: a first open of 91 UTC days, numbers and a trace against direct CLI calls, a terminal launch, Connect's own runs, a stop and restart, and an old CLI (`live_old_cli_shows_needs_cli`, which takes the `codemie` in `~/.npm-global/bin`). They start no Claude and spend no tokens, but a first open takes minutes and up to 6 GB per CLI call. Put a CLI build that has `analytics view` first on `PATH` and run them one at a time: `cd src-tauri && PATH=<folder of that codemie>:$PATH cargo test analytics::live_tests -- --ignored --nocapture --test-threads=1` (or name one test; `cargo test live_ -- --ignored` runs them along with the Claude ones). They print counts, sums and session ids only; the shared first open stays in `$TMPDIR/connect-analytics-live/`, a copy of this Mac's sessions: delete it when done.

**Real Echo plugins (`src-tauri/tests/echo_plugins.rs`).** The published plugins are never copied into this repo. The tests read them from `CONNECT_ECHO_PLUGINS_DIR` (a marketplace folder or its `plugins/`; default `$HOME/AI/projects/other/echo-plugins/plugins`), and skip with a message when it is missing. The conformance tests install the four plugins into a temp data root and load them in the real host with the real services over a real `Core`; only things outside Connect are faked (Claude by `FakeRunner`, whose `on_run` hook edits the folder a run was given; the folder and file pickers by `Picked`; web pages by `HttpClient::canned`). Knowledge has a test per flow (reads; writes with git history and picked files; Claude in the vault and in a copy; a web page; Connect's meetings into a vault) and `knowledge_full_flow_in_connect`, which chains them. `testing::signed_in`, `testing::saved_meeting` and `testing::minutes_written` give a test core a Microsoft account, a meeting with saved notes and the event a notes run sends. `my_vault_reads_in_connect` is `#[ignore]`: it runs Knowledge over a copy of a real vault the developer names (`KN_MY_VAULT=<copy> cargo test --test echo_plugins my_vault -- --ignored --nocapture`) and prints counts and timings only.

**Connect's own marketplace (`src-tauri/tests/connect_marketplace.rs`).** The Todoist plugin is never copied into this repo either: the tests read the marketplace from `CONNECT_MARKETPLACE_DIR`, install Todoist from a temp copy (its sheet agreed to), load it in the real host through the real `PluginManager`, and drive the real `task_sync` over a real `Core` (`testing::workspace_op` runs a workspace operation as the window sends it, `testing::task_sync(core, at)` one sync run at a given time, `testing::task_provider` the snapshot's `taskProvider`). Todoist itself is `testing::FakeTodoist`, a loopback server with the endpoints of the marketplace's `tests/helpers/fake-todoist.mjs`, Todoist's own habits (project names may repeat, a full sync lists open tasks only, a 429 carries `error_extra.retry_after`, a completed task answers 404 to a read, reads never move the sync revision), failures by route (`fail_once`, e.g. a 429 with `Retry-After`) and a lost answer (`lose_once`: the work is done, the connection closes unanswered); `HttpClient::for_tests(&[("api.todoist.com", fake.base())], …)` sends the plugin's requests there after the host checked the plugin may reach `api.todoist.com`. The token is the sentinel `tk_SENTINEL_do_not_log_0123456789`; no test calls the real Todoist. Core-only sync tests use `task_provider::fake::FakeProvider` instead. The same file runs the real Knowledge plugin as the reply-context provider (`knowledge_*`: its manifest asks for nothing that leaves the Mac, `needs_setup` until a folder is chosen, the copy filled from its folder, a draft shaped and grounded by it, a turned-off Knowledge drafting from the copy, Delete Connect's copy leaving the folder alone, an edit in Connect landing in `Voice/rules.md` — and a page that isn't UTF-8 or is over 1 MB refused, never overwritten — an import landing in `rules.md`, `sent` reading only synced messages, a git folder left alone); its folder is a temp folder, its people and pages invented, and Claude is `FakeRunner`. Run them with `cd src-tauri && cargo test --test connect_marketplace knowledge`. Core-only voice tests use `voice::fake::FakeVoice`.

**Echo's contract.** `src-tauri/src/plugins/services/contract_tests.rs` runs each regex the plugin matches errors by in QuickJS against Connect's real message, and compares each answer's keys and types with what echo-plugins' `tests/helpers/fake-ctx.mjs` gives (`testing::shape`, or `has_shape` where Connect's answer says more). A new member or a changed message gets its case there.

**`test-support` feature.** `app_lib::testing` (`FakeRunner` for Claude, `FakeGh`, an offline HTTP client that records requests, a folder picker, `Core`) exists only with `--features test-support`. The crate lists itself as a dev-dependency with that feature, so `cargo test` has it and the app build never does. Integration tests use it; unit tests use `#[cfg(test)]` helpers (`plugins::testkit`, `ai::fake`).

**Smoke modes** (debug builds, run the real native app; the isolation smoke needs `CODEMIE_WORKSPACE_TEST_DIR=$(mktemp -d)/workspace`, the marketplace smoke makes its own temp data root, so the user's data is never touched; the status smoke opens the user's own data folder unless `CODEMIE_WORKSPACE_TEST_DIR` is set; each writes a JSON report in `$TMPDIR` and quits with an exit code).

| Mode | What it proves |
|---|---|
| `CODEMIE_PLUGIN_SMOKE=isolation ./target/debug/app` | In a real sandboxed `connect-plugin://` frame, `__TAURI__` and `__TAURI_INTERNALS__` are absent, `fetch('ipc://…')` fails, `parent.document` throws. Report: `connect-plugin-isolation.json`. Run it after any change to the frame, CSP, scheme or caller checks |
| `CODEMIE_PLUGIN_SMOKE=<marketplace folder>` | Installs every plugin the marketplace offers into a fresh temp data root (agreeing to sheets by hash, only in this mode), loads them, opens each page and Settings section, then tells every frame a meeting's page shows (`SMOKE_CALL`) so their `call.*` slots draw, and reports what loaded and why the rest did not. Each plugin that provides tasks is asked `tasks:status`; the report's `tasks` lists `{plugin, status}`, and `ok` or `needs_token` (no token in the smoke's data root, so nothing reaches the network) passes, any other code fails. Each plugin that provides reply-context is asked `replyContext:status`; the report's `replyContext` lists `{plugin, status}`, and `ok` or `needs_setup` (no folder granted) passes. Report: `connect-plugin-smoke.json`. Exit 0 pass, 1 fail, 2 window never reported, 3 cannot run. Telegram is an expected, named failure |
| `CODEMIE_STATUS_SMOKE=status` | The real app boots as the user's own launch does (their data folder unless `CODEMIE_WORKSPACE_TEST_DIR` is set), waits for the workspace, the first sync and the plugin manager, and reports the version, Claude profiles and routes (the `claude` part gains `chosen`: the resolved profile id and model per row and plugin, from `ai_status`'s own `chosen`; each profile's `provider` and state; `ollama: {probed, running, models}` — `probed` true for any local Ollama profile, `running` false only for `not_running`/`not_installed`, `models` the largest pulled count among them — never a base URL, key or token, and a broken row is reported, not failed), the data folder, plugins, workspace counts, what needs attention, whether the CodeMie setup sheet would open, the voice (`voice`: `{provider, state, copy, people, rules, style, facts, refreshedAt}` — counts and bools only, never style, rule or people text), and the menu bar (`menuBar`: whether the `"main"` tray exists, the view it last applied and a forced recount's view, each as `{title/label, amber, tooltipLength or count}` — lengths and counts only, the fail list naming `menuBar: no tray icon` or a mismatch between what the tray shows and what a fresh count computes). Report: `connect-status-smoke.json`, statuses, counts, lengths, timings and ids only (e-mail addresses `<redacted>`, the home folder `~`, no message, draft or summary text). Exit 0 pass, 1 fail, 2 nothing reported in time, 3 cannot run (also beside a running Connect) |
| `CODEMIE_STATUS_SMOKE=live` | The status report, then one AI draft (discarded), one thread summary (removed) and one Morning brief run (an automation it made is deleted) through the UI's workspace ops; fails on any send op or a change in outgoing actions. Runs Claude three times: only with the owner's approval |
| `CODEMIE_STATUS_SMOKE=move:<folder>`, `=default` | On a test data root only (refused without `CODEMIE_WORKSPACE_TEST_DIR`): the data-folder check and move into `<folder>`, or "Use the default folder", without the restart; a `status` run after each shows the rows the next start opens |
| `CODEMIE_SMOKE=1`, `CODEMIE_PROBE_SMOKE=1` | The installer renderer and PTY wiring, and a detection-only probe (existing) |
| `CODEMIE_TOUR=all` (or a step/stop list, e.g. `0,3,7` / `T05,T21`), under the `tour` Cargo feature (`make tour`, never set by hand) | The real app: a debug build with the `tour` feature walks every implemented screen inside its own hidden, click-through webview over a freshly seeded test folder, screenshotting each stop (`ui/workspace/tour/script.js`'s 70 stops for steps 0–8) and checking what must be on screen; offline and sends nothing (fakes for Claude, Graph, analytics, tasks and the reply voice, every send op refused, proxy/`PATH`/`GIT_ALLOW_PROTOCOL` backstops); never focuses, activates or shows on screen, and runs beside the user's own Connect without touching its data, socket or window. Writes `<test dir>/tour/results.json` and the self-contained HTML report `output/tour/<stamp>-<sha>/index.html`, whose coverage table reds out a built feature with no passing stop. Exit 0 pass, 1 a check failed, 2 nothing reported within 600 s, 3 cannot run |

The status checks for Claude (`ai_status`, `ai_usage`) are read-only by construction: they list profiles and read this month's usage, never send a prompt. Only `ai_test`, which the user starts, runs Claude.

**Connect's terminal (`src-tauri/src/commands/terminal.rs`).** Its tests open real PTYs and run small system programs (`/bin/cat`, `/bin/pwd`, `/bin/sleep`, `/bin/sh -c`), never `claude`: typing reaches the program, output is kept and offset, starting again adds the resume words, closing ends the process, a missing program ends with 127, and the session starts from a clean environment with nothing the login shell prints. A sandbox that forbids `openpty` fails them with "Operation not permitted". The dock's logic without a DOM is `ui/test/terminal-model.test.mjs`.

**Contract fixtures.** The JSON in `ui/test/fixtures/contract/` is written by Rust tests and read by UI tests and the browser mock, so the mock cannot drift from the real responses. After changing a response or record shape run `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, then commit the JSON; without the variable the tests fail when the files are stale. Sets: `ai-*` (`ai-status.json`: an Ollama profile, a fallback and a plugin row, plus `chosen`; `ai-route-cases.json`: `[{name, settings, chosen}]` for empty settings, old default+summary, a group giving its row (automation → triage), a plugin row and fallback inheritance, written from Rust's `choose` by `workspace::ai::tests::contract_fixtures` — `ai-settings.test.mjs` pins the window's "Same as" labels against it and `workspace-e2e.mjs::chooseAll` is the same mirror the browser mock's `ai_status`/`ai_settings_save` use; `ai-route-status-cases.json`: `[{name, chosen, profiles, state, using}]`, what Rust's `resolve` does before a run, which `ai-settings.test.mjs::route_state_says_what_a_run_does` pins `routeState` against), `draft-*`, `summary`, `job-ai-draft-*`, `job-ai-summarize-*`, `automation*` (`automation-run-summary.json`: a queued `meeting_ready` summary run, `delivered: ["meeting_summary"]`; `workspace-fixture.mjs::habitRecords` re-points it at the habits fixture's own meeting), `location-*`, `check-*`, `plugins-*`, `meeting-*`, `note-templates`, `glossary-parse`, `analytics-*` (`analytics::tests::contract_fixtures_match_the_real_analytics`, `analytics::app_tests::contract_fixture_analytics_app`), `task-*` (`task-records.json`: task bodies as `task_save` stores them; `task-delete.json`: the `task_delete` answer Undo saves back; `task-provider-states.json`: the snapshot's `taskProvider` for each named state — `local`, `ready`, `syncing`, `offline`, `rate_limited`, `needs_token`, `off`, `failed` — read by name as `STATES.ready` etc.; `task-sync-cases.json`: task records for the offline-replay, adopted-create, parked-entry and merged-both-sides cases; both written by `task_provider::sync::contract_fixtures_match_the_task_sync_cases`), `today-layout` (`today-layout.json`: a workspace's `layout`, `widgetWidths` and `today` after `layout_save`, written by `contract_fixtures_match_the_today_layout` in `workspace/today.rs`; `today-grid.test.mjs` checks that `todayOf` reads it back), `menu-bar-*` (`menu-bar-states.json`: the snapshot's `menuBar` for each named state — `zero`, `replies`, `several`, `capped`, `amberOnly`, `amberWithCount`, `nothingChosen` — read by name as `withMenuBar(s, 'several')` / `STATES.several` in UI tests and the browser mock's `settings_update` test hook; `menu-bar-reply-cases.json`: the reply-count cases `replies_match_inbox_one_per_chat` pins the JS mirror against; both written by `contract_fixtures_match_the_menu_bar` in `workspace/menu_bar.rs`), `voice-*` (`voice-states.json`: the snapshot's `replyVoice` for each named state — `off`, `offWithCopy`, `ready`, `needsSetup`, `unavailable`, `pluginOff`, `loading`, `noFacts` — read by name with `withVoice(s, 'ready')`, `contract_fixtures_match_the_voice_states`; `voice-import-preview.json`: the `voice_import_scan` answer for `src-tauri/tests/fixtures/voice-skills`; `voice-forget.json`; `voice-assemble-cases.json`, `voice-terms-cases.json`, `voice-facts-cases.json`: the matching, terms and facts cases the JS mirrors are pinned to) and `draft-ai-voice.json` (a mail draft whose `provenance.voice` names the style card, one instruction, two earlier messages and two facts, `contract_fixtures_match_the_voice_draft` in `workspace/ai_jobs.rs`).

**Meetings and tasks fixtures.** `contract_fixtures_match_the_real_meetings` writes `meeting-records.json` (records pending, available, downloaded, blocked, none, ready, failed, and ready after a failed Download again: `saveError` beside the notes), `meeting-transcript.json` and `meeting-files.json` (`meeting_read` answers); `contract_fixtures_match_the_real_meeting_notes` writes `meeting-notes-job.json` (a running `meeting_notes` job with `step`/`steps`), `meeting-ready.json` (two documents), `note-templates.json` (the snapshot's `noteTemplates`), `meeting-rules-cases.json` (settings, templates, rules and cases with the expected template, reason and automatic notes) and `glossary-parse.json` (the example glossary and tag list with native's parse, and `tagEdges`: tag lines whose blanks differ between Rust and JavaScript, a byte order mark among them); `contract_fixtures_match_the_real_tasks` writes `task-records.json` and `task-delete.json`. `withMeetings` / `withTasks` in `workspace-fixture.mjs` build the UI fixture from them, and the browser mock answers every meeting, template, rule, glossary and task operation in their shapes (refusals with `field`). **Parity tests** keep the JS mirrors of native logic honest: `meetings-model.test.mjs` checks `resolveTemplate` against every case in `meeting-rules-cases.json` and `parseGlossary` / `parseTags` against `glossary-parse.json`; `settings-meetings.test.mjs` checks the folder-name preview against folder.rs's rules (Unicode letters kept, cut at 60, `meeting` when empty) and that Restore the example writes native's example texts.

**Pure-module rule.** `ui/workspace/app.js` touches `document` at import, so it cannot be loaded by `node:test`. Logic that needs a test lives in pure modules (`draft-state.js`, `summary-state.js`, `settings-ai.js`, `settings-storage.js`, `data-location-flow.js`, `automations-controller.js`, `settings-plugins.js`, `today-plugins.js`, `tasks-model.js`, `tasks-controller.js`, `meetings-model.js`, `meetings-controller.js`, `meetings-settings-controller.js`, `settings-meetings-editors.js`, `markdown.js`, `view-*.js`, `calendar-model.js`, `selectors.js`, `today-grid.js`, `today-edit-view.js`, `today-controller.js`, `dock-model.js`, `dock-view.js`, `dock-controller.js`, `settings-layout.js`, `press.js`) that take state and return values or HTML; `app.js` only wires them to the DOM. The controllers' `attach*` functions and `press.js` take the document (or the press's event) as an argument, so their tests pass a fake one.

**Browser E2E.** `PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs` (screenshots in `output/playwright/workspace-e2e/`; binds loopback, so run it outside the sandbox). It drives the real `ui/` against a mocked native bridge in both themes at 1000/1440/1680 px: Today, Calendar, Inbox with AI drafts and summaries, Settings (Claude, Storage, Plugins), automations, and the plugin frames. `ui/test/browser/plugins-checks.mjs` holds its plugin checks, `meetings-checks.mjs` the Meetings page, calendar badges and Today card, `meetings-settings-checks.mjs` Settings › Meetings, `analytics-checks.mjs` the Analytics page (A1–A10, the `analytics_*` operations answered from the `analytics-*.json` contract fixtures and a fetch acted out with `workspace:analytics` events), `tasks-dates-checks.mjs` By date with Todoist active (every completion's footer "Marked 1 done · Undo", a folded row keeping only its done box, Nudge filling the reply box without sending, Late ⋯ acting on exactly the rows shown, the page redrawn when the day turns), `settings-tasks-checks.mjs` Settings › Tasks over the real DOM rather than `ctl.handle` directly (the radio's `change` event, the copy dialog, the write-only secret field — this is what caught the radio's `data-action` never reaching a real `change` event and `openModal`'s `FormData` losing the clicked submitter), `layout-checks.mjs` the flexible layout's scenarios E1–E8 (Today moved and resized by pen, mouse, touch and keys, Customize, saved and older layouts, the lock, page sections, the folding and shrinking menus; screenshots `layout-*`), `automations-checks.mjs` the habit templates and the create-tasks delivery (A1–A9: the Templates gallery's five new cards, the editor's "Tasks in <provider>" switch and the backend's "no message" refusal shown at Deliver, the Formal summary editor, the Budget request reply template, a triage run's made tasks and a summary run's meeting link in the Run log, Today's "Made N tasks" line, Default/Compact parity, nothing written or sent by rendering; `open({ automations: 'habits' })` adds the Inbox triage and Formal meeting summary automations and their runs), `menu-bar-checks.mjs` the Settings › Notifications Menu bar card, its seen marks and its menu-row routing (M1–M8: the card and its four switches across both views/themes/three widths, a switch's `settings_update {menuBar: {...}}` and a forced refusal putting it back off, the amber "Needs fixing" row and its Fix button, "Nothing is counted.", `menu_bar_seen` sent on open — never twice at the same snapshot revision, never while the page reports no focus — `workspace:notification-open` routing, Default/Compact parity, nothing written or sent by rendering alone; plus a persistent `storage` refusal of `menu_bar_seen` with two marks due at once sending at most 2 in 1 s, and the card listing every fix with no cap, unlike the native tray's "and N more"); and `ai-routes-checks.mjs` Settings › AI's rows, fallbacks and statuses (R1–R8: the profile cards — Claude Code, two CodeMie profiles and an Ollama one — and "What each job uses" across both views/themes/three widths, Ask hidden and no per-row Test button; the working/fallback/broken/unset statuses, a missing profile shown as "not ready"; exactly one `ai_settings_save` per fallback or plugin-row change with the chip tracking the answer's `chosen`; a kept model on another row while Ollama is down; the first-use chooser's Ollama line; the automation editor's row-aware label and a fallback run's "Ran on …" line; Default/Compact parity; no `ai_test` from drawing the page or Check again); and `voice-checks.mjs` reply in the user's voice (V1–V13: Settings › Your voice across both views/themes/three widths, each `voice-states.json` state's line, the style card and instruction edits with one `voice_save`/`voice_delete` each and refusals beside the field, the radio and facts with one `voice_set` each and a refusal putting the radio back, Refresh now and Delete Connect's copy with Return cancelling, a draft's " · in your voice" and Context lines including the copy, cut and facts-missed variants, the role's sheet line, Default/Compact parity, no `voice_*` op or `pick_folder` and no voice text in `localStorage` from drawing, and the skill import's pick, preview, Shorten with AI, save and layout). `open({ voice: '<state>' })` sets `replyVoice` to that `voice-states.json` state (Off otherwise), `draftVoice: true` gives AI drafts `draft-ai-voice.json`'s `provenance.voice` (a check changes it through `window.__draftVoice`), `replyPlugin: true` makes a folder marketplace offer an invented reply-context plugin whose sheet has the role's line; `window.__voiceRefuse = {op, message, field?}` refuses that voice op once and `window.__skillsFolder` is what the skills folder pick answers (null cancels). `open({ ai: 'ollama-running'|'ollama-down'|'ollama-no-model', aiSettings, aiProfilePatch, aiPlugin })` builds these scenarios on `ai-status.json` with only the Ollama profile (or any profile named in `aiProfilePatch`) patched, and `aiSettings` recomputes `chosen` with the same `chooseAll` mirror; `aiPlugin: true` adds an enabled "Knowledge" plugin with `claude` agreed to `plugins_request installed`, so a plugin row draws under "All plugins". The mock's `settings_update` merges `d.menuBar` into the existing four booleans and, when a test sets `window.__nextMenuBarState`, answers with that `menu-bar-states.json` state; its `menu_bar_seen` records every call and, unless `window.__menuBarSeenRefuse` is set, drops the id from `newMeetings` or zeros `sources.automations`. Each set has no horizontal overflow at each width; `WORKSPACE_E2E_ONLY=plugins|meetings|meetings-settings|layout|analytics|tasks-dates|settings-tasks|automations|menu-bar|ai-routes|voice` runs one set alone. `open({ workspace })` merges fields into the active workspace before the page loads (a saved `today`, or an older `layout` and `widgetWidths`); the mock records `layout_save` (and other writes) in `window.__bridgeCalls`, which a check set reads through its `calls(page, op)`, and keeps the workspaces in sessionStorage, so a `page.reload()` opens what was saved. It proves UI behaviour only, not native storage, Graph or Claude.

---

## What Is Not Tested Automatically

The genuine install operations (the first-launch runtime download in `ensure_runtime`, `codemie setup`, the `~/.zprofile` edits of `persist_to_zprofile`) and network actions (`proxy connect`, analytics) are not run by `npm test` or `cargo test`. Verify them by hand in the app. Smoke modes (`CODEMIE_SMOKE=1`, `CODEMIE_PROBE_SMOKE=1`) provide a non-destructive integration check for the renderer and PTY wiring — see the Smoke modes table above.

## Examples

### A controller harness over fakes

Source: `ui/test/tasks-controller.test.mjs::harness`

```js
function harness({ answers = {}, snapshot = withTasks(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), NOW) } = {}) {
  const calls = { mutate: [], render: 0, toasts: [], modals: [], meetings: [], focus: [] };
  const state = { route: 'tasks', tasks: newTasksView() };
  const ctl = createTasksController({
    state,
    snap: () => snapshot,
    mutate: async (op, data) => {
      calls.mutate.push([op, data]);
      const stored = snapshot.records.find(r => r.kind === 'commitment' && r.id === data.id);
      if (op === 'task_save' && stored) {
        const { log, ...fields } = data;
        Object.assign(stored.data, fields, fields.status ? { done: fields.status === 'done' } : {});
      }
      if (op === 'task_delete') snapshot.records = snapshot.records.filter(r => r !== stored);
      return typeof answers[op] === 'function' ? answers[op](data) : answers[op] ?? { id: data.id || 'task-new' };
    },
    render: async () => { calls.render++; },
    openModal: options => { calls.modals.push(options); return { querySelector: () => null }; },
    confirmModal: options => { calls.modals.push(options); },
    toast: (message, tone, action) => calls.toasts.push({ message, tone, action }),
```

### Checking a contract fixture

Source: `src-tauri/src/plugins/testkit.rs::contract_fixture`

```rust
pub fn contract_fixture(name: &str, value: &Value) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/test/fixtures/contract");
    let text = serde_json::to_string_pretty(value).unwrap() + "\n";
    let path = dir.join(name);
    if std::env::var("UPDATE_CONTRACT_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, &text).unwrap();
    } else {
        let saved = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            saved, text,
            "{name} is stale: run UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures"
        );
    }
}
```

## Common pitfalls

| Symptom | Cause | Fix | Evidence |
|---|---|---|---|
| `cargo test` fails with `<name> is stale: run UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures` | a native response or record shape changed | regenerate the fixtures and commit the JSON with the change | `src-tauri/src/plugins/testkit.rs::contract_fixture` |
| A test that imports `app.js` fails under `node:test` | `app.js` reads `window` and `document` at import | move the logic into a pure module and test that | `ui/workspace/app.js::rawInvoke` |
| `tests/echo_plugins.rs` passes but tested nothing | the plugins folder is missing, so each test prints `skipped:` and returns | set `CONNECT_ECHO_PLUGINS_DIR` | `src-tauri/tests/echo_plugins.rs::CONNECT_ECHO_PLUGINS_DIR` |
| `tests/connect_marketplace.rs` passes but tested nothing | the marketplace folder is missing, so each test prints `skipped:` and returns | set `CONNECT_MARKETPLACE_DIR` | `src-tauri/tests/connect_marketplace.rs::CONNECT_MARKETPLACE_DIR` |
| The browser run fails at start inside the agent sandbox | it serves `ui/` on a loopback port | run it outside the sandbox with `PLAYWRIGHT_CORE` set | `ui/test/browser/workspace-e2e.mjs::WORKSPACE_E2E_ONLY` |
| `resolve_shell_path_captures_real_login_shell_path` fails under a full `cargo test` run | it shells out to the real login shell and is flaky under parallel load (passes alone) | re-run it alone (`cargo test resolve_shell_path_captures_real_login_shell_path`) and report both results | `src-tauri/src/commands/pathman.rs::resolve_shell_path_captures_real_login_shell_path` |
| Layout E1 fails in the browser run | a known-flaky scenario in the flexible-layout set | re-run `WORKSPACE_E2E_ONLY=layout` alone once and report both results | `ui/test/browser/layout-checks.mjs` |
| "Today Draft reply opens the conversation and starts a draft" fails on its `'label shows on hover'` assertion | a known-flaky hover-timing check | re-run the full browser run (or that check alone) once and report both results | `ui/test/browser/workspace-e2e.mjs` (the assertion: `el.querySelector('span').getBoundingClientRect().width > 40`) |

## Quick reference

| Task | Do | Where |
|---|---|---|
| Run one JS test file | `node --test ui/test/<name>.test.mjs` | `package.json::test` |
| Run one Rust test | `cd src-tauri && cargo test <name>` | `Makefile::test-rust` |
| Regenerate contract fixtures | `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, commit the JSON | `src-tauri/src/plugins/testkit.rs::contract_fixture` |
| Run the live Claude tests | `cd src-tauri && cargo test live_ -- --ignored` (spends tokens) | `src-tauri/src/ai/runner.rs::live_native_isolated_run` |
| Run one browser check set | `WORKSPACE_E2E_ONLY=meetings PLAYWRIGHT_CORE=… node ui/test/browser/workspace-e2e.mjs` (`analytics` for the Analytics page, `menu-bar` for the Menu bar card) | `ui/test/browser/workspace-e2e.mjs::WORKSPACE_E2E_ONLY` |
| Run the real-app tour | `make tour` | `scripts/tour/run.sh` |
| Run the live analytics tests | `cd src-tauri && PATH=<folder of a codemie with analytics view>:$PATH cargo test analytics::live_tests -- --ignored --nocapture --test-threads=1` | `src-tauri/src/workspace/analytics/live_tests.rs` |