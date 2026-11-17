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

`ui/test/fixtures/contract/ai-*.json` are the real `ai_status`, `ai_usage` and `ai_test` responses, written by the Rust test `contract_fixtures_match_the_real_responses`; the UI fixtures, the browser mock and `ai-settings.test.mjs` read them. `draft-ai.json` (Outlook), `draft-ai-chat.json` (Teams), `summary.json`, `job-ai-draft-failed.json`, `job-ai-draft-conflict.json` and `job-ai-draft-running.json` are AI draft records, a summary record, and `ai_draft` jobs that failed on a Claude sign-in (`errorClass`), failed on a changed conversation (`errorCode: conflict`) and are still running (with the `runModel` Claude reported), exactly as the snapshot carries them, written by `contract_fixtures_match_the_real_ai_jobs` (random ids and clock values pinned). After changing any of those responses or records run `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, then commit the JSON; without the variable the test fails when the files are stale.

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

## What Is Not Tested Automatically

The genuine install operations (`install_node`, `codemie setup`, `sudo .pkg`, `~/.zprofile` edits) and network actions (`proxy connect`, analytics) are **never run automatically**. Verify them by hand from the home page. Smoke modes (`CODEMIE_SMOKE=1`, `CODEMIE_PROBE_SMOKE=1`) provide a non-destructive integration check for the renderer and PTY wiring — see `README.md:157`.
