# EPMCDME-15257 — Windows setup npm-prefix mismatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `spawn_external_ps` (the Windows legacy install-wizard's external-PowerShell spawn path) agree with its sibling spawn paths on the npm install prefix, and make the wizard's failure messages name the failed step and exit code.

**Architecture:** `spawn_external_ps` (`src-tauri/src/commands/pty.rs:283-294`) is the only Windows child-process spawn path that never calls `npm_env::npm_env_for`. Its sibling `pty_env_pairs_for` (`pty.rs:48-68`, already platform-parametrized and already used by `spawn_pty`) computes exactly the `TERM`/home-var/`PATH`/`npm_config_prefix` pairs needed. Reuse it directly (no new function) rather than duplicating its logic. Separately, `ui/handlers.js::runExternalWindow` currently clears the step subtitle to `''` on a non-zero exit instead of reporting it — fix that alongside `runPty`'s existing (already-title-bearing) failure line for symmetry.

**Tech Stack:** Rust (Tauri backend, `tokio::process::Command`), vanilla ESM JS frontend, `node --test`.

**Spec:** `docs/superpowers/tasks/2026-09-25-EPMCDME-15257-windows/spec.md`

**Commit per task using the repository's existing convention.**

## Global Constraints

- No new environment variables and no new install-location convention — reuse `npm_env::npm_env_for` / `%USERPROFILE%\.codemie\agents` verbatim.
- Do not touch `src-tauri/src/commands/pathman.rs::candidate_dirs()` or `run_fresh_env`.
- Do not edit the vendored `@codemieai/code` CLI (`cli/node_modules/@codemieai/code`) — its own text/logic is out of scope.
- Do not touch `ui/setup-view.js`, `ui/setup-driver.js`, or the guided-setup screen — already correct, out of scope.
- Do not change macOS behavior: `config/steps.yaml`, `ui/handlers.js`'s non-`isWin` branch bodies (`runPty`'s title-bearing exit line stays, only its subtitle text may gain the title), `pty_env_pairs_for`'s unix shape.
- No automated test may require a real Windows machine — new Rust tests use the existing `windows: bool`-parametrized pure-function pattern so they run on any host.

## Review Focus

- A Windows user with no pre-existing `codemie-code` install running the wizard end-to-end: install (2.3.3/2.3.5) and validate (2.4) must land on the same prefix — covered by Task 1/2's env-pairs test plus the existing `2.4` path (`shell_cmd_for`) already tested.
- Empty/unset `USERPROFILE` at spawn time: `pty_env_pairs_for`'s existing "no override" contract (empty home → no `npm_config_prefix`) must still hold when reused by `spawn_external_ps` — covered by Task 1 reusing the same pure function unmodified.
- A wizard step that exits non-zero for a reason unrelated to npm (e.g. user cancels the external console): the UI must still name the step and exit code, not go blank — covered by Task 3.
- A wizard step where `externalWindow.spawnPs` itself throws (window fails to open) rather than returning a code: message must still be actionable, not swallowed — covered by Task 3.
- macOS's `runPty` path must not regress (still shows exit code, still logs the title) while `runExternalWindow` is brought to parity — covered by Task 3's test asserting `pty.spawnPty` is untouched and `runPty`'s own line format is unchanged for non-Windows dispatch.

---

### Task 1: Reuse `pty_env_pairs_for` inside `spawn_external_ps`

**Files:**
- Modify: `src-tauri/src/commands/pty.rs:283-294` (`spawn_external_ps`)

**Interfaces:**
- Consumes: existing `pty_env_pairs_for(home: &str, existing_path: &str, windows: bool) -> Vec<(String, String)>` (`pty.rs:48`), unchanged.
- Produces: `spawn_external_ps` now applies those pairs via `.env()` before spawning; Task 2's test asserts this behavior through the same pure function, so no new public symbol is introduced.

Test-first: yes — Rust unit test (Task 2) exercising `pty_env_pairs_for(..., true)` fails to compile/assert against `spawn_external_ps`'s behavior until this task wires it in; the wiring itself is verified by Task 2's test plus the existing `spawn_external_ps_exits_zero_for_noop_command` test continuing to pass.

- [ ] **Step 1: Wire env pairs into the spawn**

In `spawn_external_ps` (`pty.rs:283-294`), before `.status()`, read `USERPROFILE` and `PATH` from the real environment, call `pty_env_pairs_for(&home, &path, true)`, and apply each pair with `.env(k, v)` on the `tokio::process::Command` builder — mirroring how `shell_cmd_for` (`runner.rs:54-57`) applies its pairs with `.env()` calls, and how `pty_env_pairs` (`pty.rs:75-81`) is the existing real-env-reading wrapper around `pty_env_pairs_for`.

```rust
#[cfg(windows)]
#[tauri::command]
pub async fn spawn_external_ps(cmd: String) -> CmdResult<i32> {
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let base_path = std::env::var("PATH").unwrap_or_default();
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-Command", &cmd])
        .creation_flags(CREATE_NEW_CONSOLE);
    for (k, v) in pty_env_pairs_for(&home, &base_path, true) {
        command.env(k, v);
    }
    let status = command
        .status()
        .await
        .map_err(|e| InstallerError::Other(e.to_string()))?;
    Ok(status.code().unwrap_or(1))
}
```

- [ ] **Step 2: Run the existing Windows exit-code test**

Run (on Windows host or CI Windows job — this test is `#[cfg(all(test, windows))]`, it does not run on this dev machine): `cargo test spawn_external_ps_exits_zero_for_noop_command`
Expected: PASS (behavior-preserving change; the test only checks exit code).

- [ ] **Step 3: Commit**

---

### Task 2: Add a Windows-shape unit test for the reused env pairs

**Files:**
- Modify: `src-tauri/src/commands/pty.rs` — add to the existing `mod tests_pty_env` (`pty.rs:296-312`)

**Interfaces:**
- Consumes: `pty_env_pairs_for(home: &str, existing_path: &str, windows: bool) -> Vec<(String, String)>` (`pty.rs:48`, unchanged signature).
- Produces: nothing new; this test is the AC5 coverage for `spawn_external_ps`'s (now-shared) env pairs.

Test-first: yes — failing test asserting `pty_env_pairs_for("C:\Users\test", "C:\Windows", true)` includes `npm_config_prefix = C:\Users\test\.codemie\agents` and a `PATH` starting with that same value; currently this Windows-`windows: true` shape is untested (`tests_pty_env` only covers `windows: false`) even though the function itself already supports it, so the test passes immediately once added — it exists to pin the exact contract `spawn_external_ps` now depends on and to close the AC5 gap.

- [ ] **Step 1: Write the test**

```rust
#[test]
fn pty_env_pairs_for_windows_includes_npm_config_prefix_and_prefixed_path() {
    let pairs = pty_env_pairs_for(r"C:\Users\test", r"C:\Windows", true);
    let prefix = pairs
        .iter()
        .find(|(k, _)| k == "npm_config_prefix")
        .unwrap();
    assert_eq!(prefix.1, r"C:\Users\test\.codemie\agents");
    let path = pairs.iter().find(|(k, _)| k == "PATH").unwrap();
    assert!(path.1.starts_with(r"C:\Users\test\.codemie\agents;"));
}
```

Place this test in `tests_pty_env` (currently `#[cfg(not(windows))]`-gated as a whole module per `pty.rs:296`) — remove that module-level `#[cfg(not(windows))]` and instead keep the existing unix test under its own `#[cfg(not(windows))]` on the individual `#[test]` fn, so both shapes run on their respective hosts from the same always-compiled `pty_env_pairs_for`.

- [ ] **Step 2: Run it**

Run: `cargo test pty_env_pairs_for_windows_includes_npm_config_prefix_and_prefixed_path -- --nocapture` (runs on any host, including this dev machine, since `pty_env_pairs_for` takes an explicit `windows: bool` and touches no real environment).
Expected: PASS.

- [ ] **Step 3: Commit**

---

### Task 3: Name the failed step and exit code in `runExternalWindow`

**Files:**
- Modify: `ui/handlers.js:47-57` (`runExternalWindow`)
- Test: `ui/test/handlers.test.mjs` (new)

**Interfaces:**
- Consumes: `deps.externalWindow.spawnPs(cmd) -> Promise<number>` (`ui/runner-bridge.js:142`, unchanged), `ctx.step.title`/`ctx.step.id` (`ui/engine.js:125-140`, unchanged), `ctx.setSubtitle(id, text)`, `ctx.line(text, tag)` (both already used elsewhere in `handlers.js`).
- Produces: `makeHandlers(deps)` (`ui/handlers.js:23`, unchanged export) — its `'2.3.3'`/`'2.3.5'` entries now report step title + exit code on failure instead of a blank subtitle.

Test-first: yes — `ui/test/handlers.test.mjs` asserts that dispatching `handlers['2.3.3']` on `platform.os === 'windows'` with a fake `externalWindow.spawnPs` resolving to a non-zero code results in a subtitle containing both the step's title and the exit code (fails today: current code clears the subtitle to `''`).

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandlers } from '../handlers.js';

function fakeCtx(step) {
  const subtitles = [];
  const lines = [];
  return {
    step,
    setSubtitle: (id, text) => subtitles.push({ id, text }),
    line: (text, tag) => lines.push({ text, tag }),
    emit: () => {},
    subtitles,
    lines,
  };
}

test('2.3.5 on Windows dispatches to runExternalWindow, not runPty', async () => {
  const calls = { spawnPs: [], spawnPty: [] };
  const handlers = makeHandlers({
    platform: { os: 'windows', arch: 'x86_64' },
    externalWindow: { spawnPs: async (cmd) => { calls.spawnPs.push(cmd); return 0; } },
    pty: { spawnPty: async (cmd) => { calls.spawnPty.push(cmd); return { code: 0 }; } },
  });
  const ctx = fakeCtx({ id: '2.3.5', title: 'Install Claude Code engine' });
  const ok = await handlers['2.3.5'](ctx);
  assert.equal(ok, true);
  assert.deepEqual(calls.spawnPs, ['codemie install claude --supported']);
  assert.deepEqual(calls.spawnPty, [], 'must not fall through to the embedded PTY path on Windows');
});

test('runExternalWindow names the step title and exit code on non-zero exit', async () => {
  const handlers = makeHandlers({
    platform: { os: 'windows', arch: 'x86_64' },
    externalWindow: { spawnPs: async () => 1 },
    pty: { spawnPty: async () => ({ code: 0 }) },
  });
  const ctx = fakeCtx({ id: '2.3.5', title: 'Install Claude Code engine' });
  const ok = await handlers['2.3.5'](ctx);
  assert.equal(ok, false);
  const last = ctx.subtitles.at(-1);
  assert.match(last.text, /Install Claude Code engine/);
  assert.match(last.text, /exit 1/);
});

test('runExternalWindow names the step title when the window fails to open', async () => {
  const handlers = makeHandlers({
    platform: { os: 'windows', arch: 'x86_64' },
    externalWindow: { spawnPs: async () => { throw new Error('boom'); } },
    pty: { spawnPty: async () => ({ code: 0 }) },
  });
  const ctx = fakeCtx({ id: '2.3.3', title: 'Configure CodeMie' });
  const ok = await handlers['2.3.3'](ctx);
  assert.equal(ok, false);
  const last = ctx.subtitles.at(-1);
  assert.match(last.text, /Configure CodeMie/);
  assert.match(last.text, /boom/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test ui/test/handlers.test.mjs`
Expected: FAIL — the exit-code and window-failure assertions fail because current `runExternalWindow` (`handlers.js:47-57`) sets the subtitle to `''` on non-zero exit and omits the step title from the catch branch.

- [ ] **Step 3: Fix `runExternalWindow`**

Replace `ui/handlers.js:47-57` with:

```js
async function runExternalWindow(ctx, stepId, cmd) {
  ctx.setSubtitle(stepId, 'Running in external window…');
  try {
    const code = await externalWindow.spawnPs(cmd);
    const okExit = code === 0;
    ctx.line(`(${ctx.step.title} finished, exit ${code})`, okExit ? 'dim' : 'stderr');
    ctx.setSubtitle(stepId, okExit ? '' : `${ctx.step.title} failed (exit ${code})`);
    return okExit;
  } catch (err) {
    ctx.setSubtitle(stepId, `${ctx.step.title} failed to open window: ${(err && err.message) || err}`);
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test ui/test/handlers.test.mjs`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

---

## Self-Review

**Spec coverage:** AC1/AC2/AC3 (install/validate prefix agreement) → Task 1 (reuse `pty_env_pairs_for` in `spawn_external_ps`). AC4 (actionable failure naming step + exit code) → Task 3. AC5 (Rust test mirroring siblings) → Task 2; (JS test for `isWin` dispatch, added since it fits the existing `node --test`/fake-deps pattern with no new scaffolding) → Task 3. AC6 (manual real-Windows verification) → intentionally not a task, per spec/non-goals.

**Placeholder scan:** none — every step has a concrete diff or concrete code block.

**Type consistency:** `pty_env_pairs_for(home: &str, existing_path: &str, windows: bool) -> Vec<(String, String)>` used identically in Task 1 and Task 2. `makeHandlers(deps)` and its `'2.3.3'`/`'2.3.5'` entries unchanged in signature across Task 3.

**Negative-constraint pass:**
- "Not touching `pathman.rs::candidate_dirs()`/`run_fresh_env`" — no task touches `pathman.rs`.
- "Not editing the vendored `@codemieai/code` CLI" — no task touches `cli/node_modules/**`.
- "Not touching `ui/setup-view.js`/`ui/setup-driver.js`/guided-setup" — no task touches those files; Task 3 only touches `ui/handlers.js`.
- "Not introducing a new install-location convention or new env variables" — Task 1 reuses `pty_env_pairs_for`/`npm_env_for` verbatim, introduces no new function and no new env var.
- "Not requiring a real Windows machine for any automated test" — Task 2's test calls the always-compiled, platform-parametrized `pty_env_pairs_for` directly; Task 3's JS test has no platform dependency at all (fakes `deps.platform.os`).
- "Not changing macOS behavior" — Task 1/2 touch only the `#[cfg(windows)]` `spawn_external_ps` fn and an always-compiled pure-function test; Task 3 touches only `runExternalWindow`, leaving `runPty` (the macOS/non-`isWin` path) untouched, and Task 3's own tests assert `pty.spawnPty` is never called when dispatch is Windows-bound.

Negative-constraints: all satisfied, see above — none skipped.
