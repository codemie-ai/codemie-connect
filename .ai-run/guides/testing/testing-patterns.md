# Testing Patterns

**Project**: CodeMie Installer (macOS)
**Rust tests**: `cargo test` — inline `#[cfg(test)]` modules
**JS tests**: `node --test` — `ui/test/*.test.mjs`

---

## Test Organization

```
src-tauri/src/commands/
  runner.rs:129     #[cfg(test)] — shell execution (real login shell)
  logger.rs:67      #[cfg(test)] — log line formatting
  inspector.rs      (probes; tested via runner integration)

ui/test/
  engine.test.mjs   Engine orchestration (step sequencing, gates, fatal logic)
  models.test.mjs   StepStatus, STATUS_META, makeStep normalization
  workspace.test.mjs  Workspace store, calendar geometry, formatting, selectors and view rendering
  fixtures/workspace-fixture.mjs  Synthetic snapshot (invented people, relative times) for unit and browser tests
  browser/workspace-e2e.mjs       Chromium run of the real ui/ with a MOCKED native bridge
```

### Workspace browser end-to-end

`PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs` serves `ui/` on loopback, injects a mocked `window.__TAURI__`, and drives sign-in, Today, Calendar (all modes), Inbox, Settings, the absence of any Workspaces UI, and sign-out in both themes at 1000/1440/1680 px. Screenshots land in `output/playwright/workspace-e2e/` (git-ignored). It needs loopback binding (outside the default sandbox) and proves UI behaviour only — never native Graph, storage or notifications.

### Contract fixtures

`ui/test/fixtures/contract/ai-*.json` are the real `ai_status`, `ai_usage` and `ai_test` responses, written by the Rust test `contract_fixtures_match_the_real_responses`; the UI fixtures, the browser mock and `ai-settings.test.mjs` read them. `draft-ai.json` (Outlook), `draft-ai-chat.json` (Teams), `summary.json`, `job-ai-draft-failed.json`, `job-ai-draft-conflict.json` and `job-ai-draft-running.json` are AI draft records, a summary record, and `ai_draft` jobs that failed on a Claude sign-in (`errorClass`), failed on a changed conversation (`errorCode: conflict`) and are still running (with the `runModel` Claude reported), exactly as the snapshot carries them, written by `contract_fixtures_match_the_real_ai_jobs` (random ids and clock values pinned). `location-*.json` (`data_location_get`: default, custom, after a move, after adopting, after "Use the default folder") and `check-*.json` (`data_location_check`: ok, cloud, network, exFAT, too little space, Connect data there, recovery) are written by `contract_fixtures_match_the_real_data_location` from a real move, removal and adopt in temp folders (paths mapped to `/Users/taylor` and `/Volumes/Work Drive`, sizes pinned); `settings-storage.test.mjs` and the browser mock read them. `plugins-*.json` (`plugins_request`: `markets`, `catalog` with a Knowledge-blocked and a newer-Echo plugin, `inspect` with its sheet and `sheetHash`, `installed` with an update offered, and an `update` that needs consent, with its `sheetHash`) are written by `contract_fixtures_match_the_real_plugins` from a synthetic marketplace fetched through a stand-in git (times pinned). After changing any of those responses or records run `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, then commit the JSON; without the variable the test fails when the files are stale.

### Naming Conventions

| Element | Pattern | Example |
|---|---|---|
| Rust test fns | `snake_case describing behavior` | `run_capture_runs_via_shell_and_captures_stdout` |
| JS test names | plain string describing behavior | `'fatal failure halts and marks remaining SKIPPED'` |
| JS test files | `<module>.test.mjs` | `engine.test.mjs` |

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

Rust tests run against the real system (no mocks). Tests that invoke `capture()` run actual shell commands via `/bin/zsh -lc`.

- Runner tests: `src-tauri/src/commands/runner.rs:133` — `#[tokio::test]` for async
- Logger tests: `src-tauri/src/commands/logger.rs:71` — synchronous `#[test]`
- Runtime tests: `src-tauri/src/commands/runtime.rs` (`mod tests`) — helpers take explicit paths, so tests lay out versioned dirs and links in tempdirs; no network

| ✅ DO | ❌ DON'T |
|---|---|
| Use `#[tokio::test]` for async command tests | Mix sync and async in the same test |
| Test behavior via real shell output | Mock the shell — test value is lost |
| Assert specific exit codes and trimmed stdout | Assert against raw untrimmed output |

---

## JS Test Pattern

JS tests use the `node:test` built-in runner with `node:assert/strict`. No test framework dependency.

Engine tests inject a synthetic `emit` function and stub `handlers` to verify orchestration behavior without Tauri — see `ui/test/engine.test.mjs:15`.

The macOS shim (`assets/macos/bin/codemie`) is executed in `ui/test/shim.test.mjs` under a throwaway `HOME` with a fake linked runtime, never against the real one.

Approval gate tests (`ignore()` / `approve()`) use a `setTimeout` shim to yield before calling the gate — see `ui/test/engine.test.mjs:61`.

| ✅ DO | ❌ DON'T |
|---|---|
| Stub `emit` to capture events; assert on event names | Test Tauri `invoke()` — that's handler/integration territory |
| Use `assert.deepStrictEqual` for arrays | Use `==` loose equality |

---

## Writing New Tests

**Rust**: add a `#[cfg(test)]` block inside the same file as the code under test. For async commands use `#[tokio::test]`.

**JS**: add a `*.test.mjs` file under `ui/test/`. Import the module under test with a relative path. Use `node:test` and `node:assert`.

---

## Milestone 2 test patterns

**Live `#[ignore]` tests.** `src-tauri/src/ai/runner.rs` has real one-word Claude prompts (`live_native_isolated_run`, `live_codemie_isolated_run`) that need a signed-in Claude and are never part of `cargo test`. Run them by hand: `cd src-tauri && cargo test live_ -- --ignored`. Nothing else in the suite spends tokens or touches the network.

**Real Echo plugins (`src-tauri/tests/echo_plugins.rs`).** The published plugins are never copied into this repo. The tests read them from `CONNECT_ECHO_PLUGINS_DIR` (a marketplace folder or its `plugins/`; default `$HOME/AI/projects/other/echo-plugins/plugins`) and `CONNECT_KNOWLEDGE_PLUGINS_DIR` (a moving Knowledge worktree, used only for Knowledge's blocked line and the compatibility refusal). Each directory skips on its own, with a message, when it is missing. The conformance tests install the four plugins into a temp data root and load them in the real host with the real services over a real `Core`; only things outside Connect are faked.

**`test-support` feature.** `app_lib::testing` (`FakeRunner` for Claude, `FakeGh`, an offline HTTP client that records requests, a folder picker, `Core`) exists only with `--features test-support`. The crate lists itself as a dev-dependency with that feature, so `cargo test` has it and the app build never does. Integration tests use it; unit tests use `#[cfg(test)]` helpers (`plugins::testkit`, `ai::fake`).

**Smoke modes** (debug builds, run the real native app; the isolation smoke needs `CODEMIE_WORKSPACE_TEST_DIR=$(mktemp -d)/workspace`, the marketplace smoke makes its own temp data root, so the user's data is never touched; each writes a JSON report in `$TMPDIR` and quits with an exit code).

| Mode | What it proves |
|---|---|
| `CODEMIE_PLUGIN_SMOKE=isolation ./target/debug/app` | In a real sandboxed `connect-plugin://` frame, `__TAURI__` and `__TAURI_INTERNALS__` are absent, `fetch('ipc://…')` fails, `parent.document` throws. Report: `connect-plugin-isolation.json`. Run it after any change to the frame, CSP, scheme or caller checks |
| `CODEMIE_PLUGIN_SMOKE=<marketplace folder>` | Installs every plugin the marketplace offers into a fresh temp data root (agreeing to sheets by hash, only in this mode), loads them, opens each page and Settings section and reports what loaded and why the rest did not. Report: `connect-plugin-smoke.json`. Exit 0 pass, 1 fail, 2 window never reported, 3 cannot run. Telegram is an expected, named failure |
| `CODEMIE_SMOKE=1`, `CODEMIE_PROBE_SMOKE=1` | The installer renderer and PTY wiring, and a detection-only probe (existing) |

The status checks for Claude (`ai_status`, `ai_usage`) are read-only by construction: they list profiles and read this month's usage, never send a prompt. Only `ai_test`, which the user starts, runs Claude.

**Contract fixtures.** The JSON in `ui/test/fixtures/contract/` is written by Rust tests and read by UI tests and the browser mock, so the mock cannot drift from the real responses. After changing a response or record shape run `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, then commit the JSON; without the variable the tests fail when the files are stale. Sets: `ai-*`, `draft-*`, `summary`, `job-ai-draft-*`, `automation*`, `location-*`, `check-*`, `plugins-*`.

**Pure-module rule.** `ui/workspace/app.js` touches `document` at import, so it cannot be loaded by `node:test`. Logic that needs a test lives in pure modules (`draft-state.js`, `summary-state.js`, `settings-ai.js`, `settings-storage.js`, `data-location-flow.js`, `automations-controller.js`, `settings-plugins.js`, `today-plugins.js`, `view-*.js`, `calendar-model.js`, `selectors.js`) that take state and return values or HTML; `app.js` only wires them to the DOM.

**Browser E2E.** `PLAYWRIGHT_CORE=/Users/Vadym_Vlasenko/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs` (screenshots in `output/playwright/workspace-e2e/`; binds loopback, so run it outside the sandbox). It drives the real `ui/` against a mocked native bridge in both themes at 1000/1440/1680 px: Today, Calendar, Inbox with AI drafts and summaries, Settings (Claude, Storage, Plugins), automations, and the plugin frames. `ui/test/browser/plugins-checks.mjs` holds its plugin checks. It proves UI behaviour only, never native storage, Graph or Claude.

---

## What Is Not Tested Automatically

The genuine install operations (`install_node`, `codemie setup`, `sudo .pkg`, `~/.zprofile` edits) and network actions (`proxy connect`, analytics) are **never run automatically**. Verify them by hand from the home page. Smoke modes (`CODEMIE_SMOKE=1`, `CODEMIE_PROBE_SMOKE=1`) provide a non-destructive integration check for the renderer and PTY wiring — see `README.md:157`.
