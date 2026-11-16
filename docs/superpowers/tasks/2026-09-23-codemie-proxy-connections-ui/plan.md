# Connections Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-app, hardcoded `#connect-view` with a data-driven 4-row Connections
screen (Claude Desktop, VS Code Copilot Chat BYOK, VS Code Claude Code extension, Codex desktop),
each row showing a composite status and the right action.

**Architecture:** New Rust command module resolves per-app config-file presence (file reads are
Rust-only in this app). A new pure-JS parser module reads `codemie proxy connect`/`status --deep`
output. `renderer.js` composes the two signals per app into one of 4 states and renders the rows,
reusing the existing `runAction()`/`ensureAuthenticated()` helpers and the app's single PTY slot.

**Tech Stack:** Vanilla JS frontend, Tauri v2 / Rust backend, `portable-pty`, Node's `node:test`,
Rust inline `#[cfg(test)]`.

**Spec:** `docs/superpowers/tasks/2026-09-23-codemie-proxy-connections-ui/spec.md`

**Correction to the spec, from confirmed research (see task's brainstorming/planning history):**
the spec's "existing path getters" (`getDesktopConfigPath` etc.) live only in the separate,
non-imported `@codemieai/code` CLI package — not reachable from this repo. All per-app
config-presence logic below is net-new Rust work, mirroring `inspector.rs`'s
`check_profile_status()`/pure-parse-function pattern. This also supersedes the spec's non-goal
"never reading/interpreting file contents" for the two VS Code rows, which require real JSON
parsing to find CodeMie's marker inside a shared file — the file is read but never rewritten.

## Global Constraints

- macOS only (this repo targets macOS only).
- Never trust CLI exit codes for success/failure — parse stdout, per `findLoginError` /
  `parse_profile_status` convention.
- All 4 rows' actions and the status check share the single PTY slot
  (`src-tauri/src/state.rs`) — disable all row actions while one is in flight.
- Preserve the `CODEMIE_SMOKE=1`/`CODEMIE_PROBE_SMOKE=1` exclusion: proxy actions run only from
  explicit user clicks, never from `boot()`/smoke code paths (same as today's `connect-btn`).
- No sidebar reveal, no standalone proxy start/stop control, no installer-download flow — do not
  add any of these.
- Disconnect is enabled only for Codex desktop (`--codex-desktop`); the other 3 rows show a
  disabled Disconnect with an inline "CLI support pending" note.
- Commit per task using the repository's existing convention.

## Review Focus

- Malformed/partial JSON in `chatLanguageModels.json` or `settings.json` (user hand-edited, VS
  Code mid-write) must read as "not connected", never throw and blank the row.
- `_meta.json` present but `appliedId` points at a `configLibrary/<id>.json` that doesn't exist
  (stale/corrupted state) must read as "not connected", not "connected".
- `codemie proxy status --deep` failing (non-zero exit, or stderr with no parseable JSON) while a
  config file is present must land on "Disconnected"/Fix, not crash the composite-status function.
- Two rows sharing the same underlying `codemie proxy connect` command output (e.g. both VS Code
  rows) must not cross-report each other's success/failure when parsing PTY output.
- Triggering a row action while another is in flight (disabled state bypassed via stale event
  handler) must not spawn a second PTY — `spawnPty`'s single-slot contract already rejects
  concurrent use; the row-disable is UI-level insurance, not the only guard.

---

### Task 1: Rust — Claude Desktop and Codex desktop presence checks

**Files:**
- Create: `src-tauri/src/commands/connectors.rs`
- Modify: `src-tauri/src/commands/mod.rs` — add `pub mod connectors;`
- Modify: `src-tauri/src/lib.rs:99-107` — register `commands::connectors::check_connector_status`
  in the `invoke_handler!` list, alongside the existing `commands::inspector::*` entries.

**Interfaces:**
- Produces: `pub struct ConnectorStatus { pub claude_desktop: bool, pub codex_desktop: bool,
  pub vscode_copilot: bool, pub vscode_claude_code: bool }` (all `bool` = "CodeMie config present",
  serialized via `#[derive(Serialize)]`, `serde(rename_all = "camelCase")`). `#[tauri::command] pub
  fn check_connector_status() -> ConnectorStatus`. Task 2 and 3 fill in the two `false` stubs.

- [ ] **Step 1: Write the failing Rust tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn claude_desktop_connected_when_meta_and_applied_file_exist() {
        let tmp = tempdir_for_test("claude-ok");
        fs::create_dir_all(tmp.join("configLibrary")).unwrap();
        fs::write(tmp.join("configLibrary/_meta.json"), r#"{"appliedId":"abc"}"#).unwrap();
        fs::write(tmp.join("configLibrary/abc.json"), "{}").unwrap();
        assert!(claude_desktop_connected(&tmp));
    }

    #[test]
    fn claude_desktop_not_connected_when_applied_file_missing() {
        let tmp = tempdir_for_test("claude-stale");
        fs::create_dir_all(tmp.join("configLibrary")).unwrap();
        fs::write(tmp.join("configLibrary/_meta.json"), r#"{"appliedId":"missing"}"#).unwrap();
        assert!(!claude_desktop_connected(&tmp));
    }

    #[test]
    fn claude_desktop_not_connected_when_meta_absent_or_malformed() {
        let tmp = tempdir_for_test("claude-none");
        assert!(!claude_desktop_connected(&tmp));
        fs::create_dir_all(tmp.join("configLibrary")).unwrap();
        fs::write(tmp.join("configLibrary/_meta.json"), "not json").unwrap();
        assert!(!claude_desktop_connected(&tmp));
    }

    #[test]
    fn codex_desktop_connected_when_state_file_exists() {
        let tmp = tempdir_for_test("codex-ok");
        fs::write(&tmp, "{}").unwrap(); // state file path itself, not a dir
        assert!(codex_desktop_connected(&tmp));
    }

    #[test]
    fn codex_desktop_not_connected_when_state_file_absent() {
        let tmp = tempdir_for_test("codex-missing/state.json");
        assert!(!codex_desktop_connected(&tmp));
    }
}
```

Run: `cargo test -p codemie-installer connectors::tests -- --nocapture` (from `src-tauri/`).
Expected: FAIL to compile — `claude_desktop_connected`/`codex_desktop_connected` undefined.

- [ ] **Step 2: Implement**

Pure functions take a `&Path` so tests never touch the real `$HOME` (mirrors
`codemie_config.rs`'s `config_path_with(home)` seam):

```rust
use std::path::Path;

fn claude_desktop_connected(base_dir: &Path) -> bool {
    let meta_path = base_dir.join("configLibrary/_meta.json");
    let Ok(raw) = std::fs::read_to_string(&meta_path) else { return false };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else { return false };
    let Some(applied_id) = json.get("appliedId").and_then(|v| v.as_str()) else { return false };
    base_dir.join("configLibrary").join(format!("{applied_id}.json")).exists()
}

fn codex_desktop_connected(state_file: &Path) -> bool {
    state_file.exists()
}
```

`check_connector_status()` resolves `$HOME/Library/Application Support/Claude-3p` and
`$HOME/.codemie/proxy/codex-desktop-state.json` (falling back to empty string if `HOME` is unset,
matching `codemie_config.rs:106-112`'s `config_path()` pattern) and calls these two; leaves
`vscode_copilot`/`vscode_claude_code` as `false` for now.

- [ ] **Step 3: Run tests, verify pass.** Run: `cargo test -p codemie-installer connectors::tests`.
- [ ] **Step 4: Commit.**

---

### Task 2: Rust — VS Code Copilot Chat (BYOK) presence check

**Files:**
- Modify: `src-tauri/src/commands/connectors.rs` (add function + tests + wire into
  `check_connector_status`).

**Interfaces:**
- Consumes: `ConnectorStatus` from Task 1.
- Produces: `fn vscode_copilot_connected(raw: &str) -> bool`, a pure parser.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn vscode_copilot_connected_when_codemie_entry_present() {
    let raw = r#"[{"vendor":"other","name":"X"},
                  {"vendor":"customendpoint","name":"CodeMie"}]"#;
    assert!(vscode_copilot_connected(raw));
}

#[test]
fn vscode_copilot_not_connected_without_matching_entry() {
    assert!(!vscode_copilot_connected(r#"[{"vendor":"other","name":"X"}]"#));
}

#[test]
fn vscode_copilot_not_connected_on_malformed_or_missing_json() {
    assert!(!vscode_copilot_connected("not json"));
    assert!(!vscode_copilot_connected(""));
}
```

Run: `cargo test -p codemie-installer connectors::tests -- --nocapture`. Expected: FAIL, function
undefined.

- [ ] **Step 2: Implement**

```rust
fn vscode_copilot_connected(raw: &str) -> bool {
    let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(raw) else { return false };
    arr.iter().any(|p| {
        p.get("vendor").and_then(|v| v.as_str()) == Some("customendpoint")
            && p.get("name").and_then(|v| v.as_str()) == Some("CodeMie")
    })
}
```

Wire into `check_connector_status()`: read `~/Library/Application Support/Code/User/
chatLanguageModels.json`, and if absent/empty try the `Code - Insiders` variant, passing whichever
raw text was read (or `""` if neither exists) to `vscode_copilot_connected`.

- [ ] **Step 3: Run tests, verify pass.**
- [ ] **Step 4: Commit.**

---

### Task 3: Rust — VS Code Claude Code extension presence check

**Files:**
- Modify: `src-tauri/src/commands/connectors.rs` (add function + tests, complete
  `check_connector_status` wiring, add `#[tauri::command]` attribute if not already present).

**Interfaces:**
- Consumes: `ConnectorStatus` from Task 1/2.
- Produces: `fn vscode_claude_code_connected(raw: &str) -> bool`. `check_connector_status()` now
  returns all 4 fields correctly populated — this is what Task 6's bridge wrapper calls.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn vscode_claude_code_connected_when_both_env_entries_present() {
    let raw = r#"{"claudeCode.environmentVariables":[
        {"name":"ANTHROPIC_BASE_URL","value":"x"},
        {"name":"ANTHROPIC_AUTH_TOKEN","value":"y"}]}"#;
    assert!(vscode_claude_code_connected(raw));
}

#[test]
fn vscode_claude_code_not_connected_when_one_entry_missing() {
    let raw = r#"{"claudeCode.environmentVariables":[{"name":"ANTHROPIC_BASE_URL","value":"x"}]}"#;
    assert!(!vscode_claude_code_connected(raw));
}

#[test]
fn vscode_claude_code_not_connected_without_the_key_or_on_malformed_json() {
    assert!(!vscode_claude_code_connected(r#"{"other":"x"}"#));
    assert!(!vscode_claude_code_connected("not json"));
}
```

- [ ] **Step 2: Implement**

```rust
fn vscode_claude_code_connected(raw: &str) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) else { return false };
    let Some(vars) = json.get("claudeCode.environmentVariables").and_then(|v| v.as_array())
    else { return false };
    let names: Vec<&str> = vars.iter()
        .filter_map(|e| e.get("name").and_then(|n| n.as_str()))
        .collect();
    names.contains(&"ANTHROPIC_BASE_URL") && names.contains(&"ANTHROPIC_AUTH_TOKEN")
}
```

Wire into `check_connector_status()`: read `~/Library/Application Support/Code/User/settings.json`
(`Code - Insiders` fallback, same pattern as Task 2), pass raw text to
`vscode_claude_code_connected`.

- [ ] **Step 3: Run tests, verify pass.** Run: `cargo test -p codemie-installer connectors::`.
- [ ] **Step 4: Commit.**

---

### Task 4: Bridge — expose `check_connector_status` to the frontend

**Files:**
- Modify: `ui/runner-bridge.js` — add a `connectors` export group after the `inspector` group
  (`ui/runner-bridge.js:44`), mirroring its shape:
  `export const connectors = { checkStatus: () => invoke('check_connector_status') };`
- Test: `ui/test/connectors-bridge.test.mjs`

**Interfaces:**
- Consumes: `check_connector_status` Tauri command (Task 1-3).
- Produces: `connectors.checkStatus()` resolving `{ claudeDesktop, codexDesktop, vscodeCopilot,
  vscodeClaudeCode }` (booleans) for Task 7 to call.

- [ ] **Step 1: Write the failing test** (mirrors the shape of `ui/test/pty-bridge.test.mjs`'s
  invoke-call assertions — stub `window.__TAURI__.core.invoke`, assert
  `connectors.checkStatus()` calls `invoke('check_connector_status')` and returns its resolved
  value unchanged).

```js
import test from 'node:test';
import assert from 'node:assert/strict';

test('connectors.checkStatus invokes check_connector_status', async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async (cmd) => {
    assert.equal(cmd, 'check_connector_status');
    return { claudeDesktop: true, codexDesktop: false, vscodeCopilot: false, vscodeClaudeCode: false };
  } }, event: { listen: async () => () => {} } } };
  const { connectors } = await import('../runner-bridge.js');
  const result = await connectors.checkStatus();
  assert.equal(result.claudeDesktop, true);
});
```

Run: `npm test`. Expected: FAIL — `connectors` export does not exist.

- [ ] **Step 2: Implement the export (shown above under Files).**
- [ ] **Step 3: Run `npm test`, verify pass.**
- [ ] **Step 4: Commit.**

---

### Task 5: `ui/proxy-parse.js` — proxy connect/status output parser

**Files:**
- Create: `ui/proxy-parse.js`
- Test: `ui/test/proxy-parse.test.mjs`

**Interfaces:**
- Produces: `findProxyConnectError(lines)` (same shape as `findLoginError` in
  `ui/signin-parse.js:4-7`) and `parseProxyStatusDeep(stdout)` returning `{ healthy: boolean }`
  from `codemie proxy status --json --deep` output (`true` only if the JSON parses and reports a
  running/reachable daemon; any parse failure or explicit not-running value is `false`). Consumed
  by Task 7.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { findProxyConnectError, parseProxyStatusDeep } from '../proxy-parse.js';

test('findProxyConnectError finds an error-prefixed line', () => {
  const line = findProxyConnectError(['Connecting…', '✗ Error: no active profile']);
  assert.equal(line, '✗ Error: no active profile');
});

test('findProxyConnectError returns null when no error line is present', () => {
  assert.equal(findProxyConnectError(['Connecting…', 'Done.']), null);
});

test('parseProxyStatusDeep reports healthy for a running daemon', () => {
  assert.deepEqual(parseProxyStatusDeep('{"status":"running"}'), { healthy: true });
});

test('parseProxyStatusDeep reports unhealthy for stopped/malformed output', () => {
  assert.deepEqual(parseProxyStatusDeep('{"status":"stopped"}'), { healthy: false });
  assert.deepEqual(parseProxyStatusDeep('not json'), { healthy: false });
  assert.deepEqual(parseProxyStatusDeep(''), { healthy: false });
});
```

Run: `npm test`. Expected: FAIL — module does not exist.

- [ ] **Step 2: Implement**

```js
// Pure parser — no browser globals, safe to import in Node tests.
export function findProxyConnectError(lines) {
  const found = lines.find(l => /^\s*(✗|[Ee]rror:|FAILED:|failed:)/.test(l));
  return found ? found.trim() : null;
}

export function parseProxyStatusDeep(stdout) {
  try {
    const json = JSON.parse(stdout);
    return { healthy: json && json.status === 'running' };
  } catch {
    return { healthy: false };
  }
}
```

- [ ] **Step 3: Run `npm test`, verify pass.**
- [ ] **Step 4: Commit.**

---

### Task 6: Composite status logic — `ui/connections-status.js`

**Files:**
- Create: `ui/connections-status.js`
- Test: `ui/test/connections-status.test.mjs`

**Interfaces:**
- Consumes: per-app `configPresent: boolean` (from Task 4's `connectors.checkStatus()`),
  `daemonHealthy: boolean` (from Task 5's `parseProxyStatusDeep`), `appInstalled: boolean`.
- Produces: `computeRowStatus({ appInstalled, configPresent, daemonHealthy }) => 'not-installed' |
  'not-set' | 'connected' | 'disconnected'`, consumed by Task 7's row renderer. This is the pure
  decision table from spec's "Per-row status model" section, extracted so it is unit-testable
  without any DOM.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRowStatus } from '../connections-status.js';

test('app not installed wins regardless of other signals', () => {
  assert.equal(computeRowStatus({ appInstalled: false, configPresent: true, daemonHealthy: true }), 'not-installed');
});

test('installed with no config file is not-set', () => {
  assert.equal(computeRowStatus({ appInstalled: true, configPresent: false, daemonHealthy: true }), 'not-set');
});

test('config present and daemon healthy is connected', () => {
  assert.equal(computeRowStatus({ appInstalled: true, configPresent: true, daemonHealthy: true }), 'connected');
});

test('config present but daemon unhealthy is disconnected', () => {
  assert.equal(computeRowStatus({ appInstalled: true, configPresent: true, daemonHealthy: false }), 'disconnected');
});
```

Run: `npm test`. Expected: FAIL — module does not exist.

- [ ] **Step 2: Implement**

```js
export function computeRowStatus({ appInstalled, configPresent, daemonHealthy }) {
  if (!appInstalled) return 'not-installed';
  if (!configPresent) return 'not-set';
  return daemonHealthy ? 'connected' : 'disconnected';
}
```

- [ ] **Step 3: Run `npm test`, verify pass.**
- [ ] **Step 4: Commit.**

---

### Task 7: Connections view markup — 4-row list

**Files:**
- Modify: `ui/index.html:196-225` — replace the `#connect-view` two-button body with a 4-row list:
  one `.connection-row` per app (`data-app="claude-desktop"|"codex-desktop"|"vscode-copilot"|
  "vscode-claude-code"`), each with a name, a `.row-status` badge span, and a `.row-action` button
  slot. Keep `#connect-topbar`/`#connect-back` and the view id `connect-view` unchanged — Task 8
  populates rows into a new `#connect-rows` container element added inside `#connect-body`.
- Modify: `ui/styles.css` — add `.connection-row`, `.row-status` (badge per state: not-installed /
  not-set / connected / disconnected), `.row-action[disabled]` styles, following the existing
  `.connect-action` block's structure (`ui/styles.css` — locate via existing `.connect-action`
  selector) rather than introducing a new visual language.

**Interfaces:**
- Produces: DOM hook `#connect-rows` and per-row `data-app` attributes that Task 8's renderer
  targets.

- [ ] **Step 1: Make the markup/CSS change** (no test-first — pure structural markup with no logic
  to pin; Task 8's DOM tests cover the rendered result).
- [ ] **Step 2: Commit.**

Test-first: no — static markup/CSS scaffold with no branching logic; behavior is pinned by Task 8's tests against the rendered rows.

---

### Task 8: Renderer — populate and drive the Connections screen

**Files:**
- Modify: `ui/renderer.js:72` (`views` object — unchanged, `connect-view` already mapped),
  `ui/renderer.js:83-84` (remove `connectBtn`/`restartBtn` refs, no longer used),
  `ui/renderer.js:751-770`-ish (replace the two hardcoded `runAction` call sites for
  `connect-btn`/`restart-btn` with row-driven wiring).
- Test: `ui/test/connections-render.test.mjs`

**Interfaces:**
- Consumes: `bridge.connectors.checkStatus()` (Task 4), `computeRowStatus` (Task 6),
  `findProxyConnectError`/`parseProxyStatusDeep` (Task 5), `runAction()`
  (`ui/renderer.js:352-361`), `ensureAuthenticated()` (`ui/renderer.js:368-386`).
- Produces: `renderConnectionRows(statuses)` — pure function taking the 4-app status object and
  returning row view-models (`{ app, status, actionLabel, actionDisabled, note }`), so the
  per-app action-label/disabled/note logic is unit-tested without touching the DOM. A thin
  `refreshConnectionsView()` wrapper calls the bridge, computes statuses, calls
  `renderConnectionRows`, and paints `#connect-rows`.

- [ ] **Step 1: Write the failing tests** for `renderConnectionRows` (pure logic, `node:test`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConnectionRows } from '../renderer.js'; // exported for testing

test('codex-desktop disconnect is enabled when connected', () => {
  const rows = renderConnectionRows({
    'codex-desktop': { status: 'connected' }, 'claude-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const codex = rows.find(r => r.app === 'codex-desktop');
  assert.equal(codex.actionLabel, 'Disconnect');
  assert.equal(codex.actionDisabled, false);
});

test('claude-desktop disconnect is disabled with CLI-support-pending note when connected', () => {
  const rows = renderConnectionRows({
    'claude-desktop': { status: 'connected' }, 'codex-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const row = rows.find(r => r.app === 'claude-desktop');
  assert.equal(row.actionDisabled, true);
  assert.match(row.note, /CLI support pending/);
});

test('not-installed rows show no action', () => {
  const rows = renderConnectionRows({
    'claude-desktop': { status: 'not-installed' }, 'codex-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const row = rows.find(r => r.app === 'claude-desktop');
  assert.equal(row.actionLabel, null);
});

test('disconnected rows offer Reconnect (Fix), not-set rows offer Connect', () => {
  const rows = renderConnectionRows({
    'claude-desktop': { status: 'disconnected' }, 'codex-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  assert.equal(rows.find(r => r.app === 'claude-desktop').actionLabel, 'Fix');
  assert.equal(rows.find(r => r.app === 'codex-desktop').actionLabel, 'Connect');
});
```

Run: `npm test`. Expected: FAIL — `renderConnectionRows` not exported / not implemented.

- [ ] **Step 2: Implement.** `renderConnectionRows(statusesByApp)` maps each of the 4 fixed app
  keys through a small per-app table `{ label, connectFlag, disconnectFlag }` (per spec's flag
  table) and the `status` field already computed via `computeRowStatus` (Task 6) upstream, to
  produce `{ app, status, actionLabel, actionDisabled, note }`:
  - `not-installed` → `actionLabel: null`.
  - `not-set` → `actionLabel: 'Connect'`, disabled `false`.
  - `disconnected` → `actionLabel: 'Fix'` (runs `connect --force`), disabled `false`.
  - `connected` → `actionLabel: 'Disconnect'`; disabled `false` only for `codex-desktop` (has a
    disconnect flag); disabled `true` with `note: 'CLI support pending'` for the other 3.

  `refreshConnectionsView()` (not unit-tested, thin DOM glue): calls
  `bridge.connectors.checkStatus()`, builds `{app: {status: computeRowStatus(...)}}` per app
  (using each app's `configPresent` from the bridge result and a shared `daemonHealthy` read via
  `bridge.runner.runCapture('codemie proxy status --json --deep')` parsed with
  `parseProxyStatusDeep`; `appInstalled` from a static per-app check — see step 3), calls
  `renderConnectionRows`, paints `#connect-rows`, and wires each row's button to: call
  `ensureAuthenticated()`; if it passes, disable all rows, call `runAction(title, cmd, 'connect')`
  with `cmd` built from the per-app connect flag (`connect --force` for Fix,
  `disconnect --codex-desktop` for Codex disconnect); re-enable rows and call
  `refreshConnectionsView()` again on PTY completion (`runAction`'s `onClose`, per
  `ui/renderer.js:353`).

  `appInstalled` per app: check for the app's `/Applications/<Name>.app` bundle via a small
  existing-or-new inspector check — **note**: this repo has no existing "does this .app bundle
  exist" Rust command; add `#[tauri::command] pub fn app_bundle_exists(name: &str) -> bool { Path::new(&format!("/Applications/{name}.app")).exists() }` to `connectors.rs` (Task 1's file) with one
  unit test each for present/absent, and a matching `connectors.appBundleExists(name)` bridge
  export (Task 4's file), called once per app name (`Claude`, `Visual Studio Code`, `Codex`) during
  `refreshConnectionsView()`. This is a best-effort install signal (bundle name assumed from
  convention, not confirmed with the CLI/product team) — flag for verification during code
  review, not a blocker for this task.

  Call `refreshConnectionsView()` from the existing `'connect-desktop'` case
  (`ui/renderer.js:728-729`) after `showView('connect')`, replacing the old
  `connectBtn`/`restartBtn` click handlers entirely.

- [ ] **Step 3: Run `npm test`, verify pass.**
- [ ] **Step 4: Commit.**

Test-first: yes — `renderConnectionRows`'s per-status action/disabled/note table (Step 1 above).

---

## Self-review

**Spec coverage:** 4-row list (Task 7/8), per-row composite status (Task 6), config-presence
checks for all 4 apps (Tasks 1-3), `codemie proxy status --deep` health input (Task 5), Connect/Fix
via `runAction`+`ensureAuthenticated` (Task 8), Disconnect enabled only for Codex desktop with
"CLI support pending" note on the rest (Task 8), PTY single-slot serialization (Task 8 disables all
rows during an in-flight action), CODEMIE_SMOKE exclusion preserved (Global Constraints — actions
stay click-only, no new boot-path wiring), no sidebar/no start-stop/no installer-download (Global
Constraints, nothing in any task adds these).

**Negative constraints:** spec's non-goal "never reading/interpreting file contents" is
deliberately overridden for the 2 VS Code rows per confirmed research (documented in the plan
header) — Tasks 2-3 read but never write these files, satisfying the underlying intent (no
connector config-parsing/rewriting logic) while doing the presence check the actual mechanism
requires. "No `codemie proxy list` usage" — no task calls it. "No local-only last-known-state
tracking" — `refreshConnectionsView()` re-reads the bridge/CLI every time, no cached/stale state
kept between renders. "No installer-download flow" — Task 8's `not-installed` rows set
`actionLabel: null`, no download affordance. "No visible proxy start/stop control" — no task adds
one; `daemonHealthy` is only ever consumed as an input to `computeRowStatus`, never rendered
standalone. "No sidebar reveal" — no task touches `#app-sidebar`'s `hidden` class.

**Placeholder scan:** none — every step shows concrete code, or (Task 7) is explicitly justified
as static markup with no logic to pin.
