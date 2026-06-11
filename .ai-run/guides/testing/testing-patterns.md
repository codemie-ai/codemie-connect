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
```

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

| ✅ DO | ❌ DON'T |
|---|---|
| Use `#[tokio::test]` for async command tests | Mix sync and async in the same test |
| Test behavior via real shell output | Mock the shell — test value is lost |
| Assert specific exit codes and trimmed stdout | Assert against raw untrimmed output |

---

## JS Test Pattern

JS tests use the `node:test` built-in runner with `node:assert/strict`. No test framework dependency.

Engine tests inject a synthetic `emit` function and stub `handlers` to verify orchestration behavior without Tauri — see `ui/test/engine.test.mjs:15`.

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
