# Rebrand + CLI Update Action + Analytics Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the app to "EPAM AI/Run CodeMie Connect", add a silent CLI self-update action with startup version-check banner, fix analytics for old CLI versions, and improve terminal hint text.

**Architecture:** Frontend-brain (JS orchestration) + thin Rust command layer (Tauri v2). Three new Rust commands feed data to JS; all update logic and UI state live in `renderer.js`. The home screen is restructured to group install sub-tiles under an "Installation" section.

**Tech Stack:** Rust (Tauri commands, `reqwest`, `serde_json`), Vanilla JS ESM, xterm.js terminal widget, `node:test` for JS tests, `#[cfg(test)]` inline Rust tests.

---

## File Map

| File | Change type | What changes |
|---|---|---|
| `src-tauri/tauri.conf.json` | Modify | `productName`, window `title` |
| `ui/index.html` | Modify | `<title>`, `#home-title`, `#sprite-label`, home-grid restructure, update banner, Update CLI tile |
| `ui/styles.css` | Modify | Add `#installation-group`, `.group-label`, `#update-banner`, `#installation-tiles`, `.sub-tile`, `#update-cli-tile` state variants |
| `src-tauri/src/commands/inspector.rs` | Modify | Add `parse_codemie_version` pure fn + `check_codemie_version` command + unit tests |
| `src-tauri/src/commands/installer.rs` | Modify | Add `parse_npm_latest` pure fn + `fetch_codemie_latest` command + unit tests |
| `src-tauri/src/commands/runner.rs` | Modify | Add `run_self_update` command |
| `src-tauri/src/lib.rs` | Modify | Register 3 new commands in `invoke_handler!` |
| `ui/runner-bridge.js` | Modify | Add 3 JS wrappers |
| `ui/renderer.js` | Modify | `semverLt`, `cliVersionState`, `boot()` version check, `showUpdateBanner`, `runUpdateCli`, analytics gate, `runAction` hint param, connect hint |
| `ui/terminal.js` | Modify | `openTerminal` uses `opts.hint` when provided |
| `ui/test/version-utils.test.mjs` | Create | `semverLt` unit tests |

---

## Task 1: Rebrand string changes

**Files:**
- Modify: `src-tauri/tauri.conf.json:3,14`
- Modify: `ui/index.html:5,27,72`

- [ ] **Step 1: Edit `src-tauri/tauri.conf.json`**

Change `productName` (line 3) and window `title` (line 14):

```json
"productName": "CodeMie Connect",
```
```json
"title": "EPAM AI/Run CodeMie Connect",
```

The bundle `"identifier": "com.epam.codemie.installer"` is **not changed**.

- [ ] **Step 2: Edit `ui/index.html` — three text nodes**

Line 5: `<title>EPAM AI/Run CodeMie Connect</title>`

Line 27: `<div id="home-title">EPAM AI/Run CodeMie Connect</div>`

Line 72: `<div id="sprite-label">Connect</div>`

- [ ] **Step 3: Verify no other user-visible "Installer" strings remain**

```bash
grep -rn "CodeMie Installer\|Installation Wizard\|Installer\"" ui/index.html src-tauri/tauri.conf.json
```

Expected: zero matches.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tauri.conf.json ui/index.html
git commit -m "feat: rebrand app to EPAM AI/Run CodeMie Connect"
```

---

## Task 2: Rust — `check_codemie_version` command (TDD)

**Files:**
- Modify: `src-tauri/src/commands/inspector.rs`

The `codemie --version` output format is unknown in advance. The parser extracts the first token that looks like `X.Y.Z` (three dot-separated all-digit segments) by splitting each whitespace token on non-digit/non-dot chars and checking each sub-part.

- [ ] **Step 1: Write failing tests in `inspector.rs`**

Add inside `#[cfg(test)] mod tests` at the bottom of `src-tauri/src/commands/inspector.rs`:

```rust
#[test]
fn parse_codemie_version_plain_semver() {
    assert_eq!(parse_codemie_version("0.4.1\n"), "0.4.1");
}

#[test]
fn parse_codemie_version_with_name_prefix() {
    assert_eq!(parse_codemie_version("codemie 0.4.1\n"), "0.4.1");
}

#[test]
fn parse_codemie_version_strips_v_prefix() {
    assert_eq!(parse_codemie_version("v0.4.1"), "0.4.1");
}

#[test]
fn parse_codemie_version_handles_slash_path_format() {
    // e.g. "@codemieai/code/0.4.1 darwin-arm64 node-v20.0.0"
    assert_eq!(
        parse_codemie_version("@codemieai/code/0.4.1 darwin-arm64 node-v20.0.0"),
        "0.4.1"
    );
}

#[test]
fn parse_codemie_version_returns_empty_on_no_version() {
    assert_eq!(parse_codemie_version(""), "");
}

#[test]
fn parse_codemie_version_returns_empty_on_command_not_found() {
    assert_eq!(parse_codemie_version("zsh:1: command not found: codemie"), "");
}
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd src-tauri && cargo test parse_codemie_version 2>&1 | tail -20
```

Expected: `error[E0425]: cannot find function 'parse_codemie_version'`

- [ ] **Step 3: Implement `parse_codemie_version` in `inspector.rs`**

Add this function above the `#[tauri::command]` block (after `codemie_from`):

```rust
/// Extract the first X.Y.Z semver token from arbitrary CLI output.
/// Handles formats: "0.4.1", "codemie 0.4.1", "v0.4.1",
/// "@codemieai/code/0.4.1 darwin-arm64 …"
fn parse_codemie_version(stdout: &str) -> String {
    for token in stdout.split_whitespace() {
        for part in token.split(|c: char| !c.is_ascii_digit() && c != '.') {
            let p = part.trim_start_matches('v');
            let segs: Vec<&str> = p.split('.').collect();
            if segs.len() >= 3
                && segs
                    .iter()
                    .all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
            {
                return p.to_string();
            }
        }
    }
    String::new()
}
```

- [ ] **Step 4: Add the `check_codemie_version` Tauri command**

Add after `check_codemie`:

```rust
/// Return the installed codemie CLI version string (e.g. "0.4.1"),
/// or an empty string if not found or version cannot be parsed.
#[tauri::command]
pub async fn check_codemie_version() -> String {
    let r = capture("codemie --version", None).await;
    parse_codemie_version(&r.stdout)
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd src-tauri && cargo test parse_codemie_version 2>&1 | tail -15
```

Expected: `6 passed`

- [ ] **Step 6: cargo fmt + clippy**

```bash
cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -10
```

Expected: no warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/inspector.rs
git commit -m "feat: add check_codemie_version Rust command with version parser"
```

---

## Task 3: Rust — `fetch_codemie_latest` command (TDD)

**Files:**
- Modify: `src-tauri/src/commands/installer.rs`

Queries `https://registry.npmjs.org/@codemieai/code` and extracts `dist-tags.latest`. Reuses the `reqwest::get` + `.json::<serde_json::Value>()` pattern from `fetch_lts` in the same file.

- [ ] **Step 1: Write failing tests in `installer.rs`**

Add inside the `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/commands/installer.rs`:

```rust
#[test]
fn parse_npm_latest_extracts_version_from_dist_tags() {
    let json = serde_json::json!({
        "name": "@codemieai/code",
        "dist-tags": { "latest": "0.5.0", "next": "0.6.0-beta" }
    });
    assert_eq!(parse_npm_latest(&json), Some("0.5.0".to_string()));
}

#[test]
fn parse_npm_latest_returns_none_on_missing_dist_tags() {
    let json = serde_json::json!({ "name": "@codemieai/code" });
    assert_eq!(parse_npm_latest(&json), None);
}

#[test]
fn parse_npm_latest_returns_none_on_missing_latest_key() {
    let json = serde_json::json!({ "dist-tags": { "next": "0.6.0-beta" } });
    assert_eq!(parse_npm_latest(&json), None);
}
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd src-tauri && cargo test parse_npm_latest 2>&1 | tail -10
```

Expected: `error[E0425]: cannot find function 'parse_npm_latest'`

- [ ] **Step 3: Implement `parse_npm_latest` pure function in `installer.rs`**

Add after `fetch_lts` function:

```rust
fn parse_npm_latest(data: &serde_json::Value) -> Option<String> {
    data.get("dist-tags")
        .and_then(|d| d.get("latest"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}
```

- [ ] **Step 4: Add `fetch_codemie_latest` async helper + Tauri command**

Add after `parse_npm_latest`:

```rust
async fn fetch_codemie_npm_latest() -> Option<String> {
    let data: serde_json::Value =
        reqwest::get("https://registry.npmjs.org/@codemieai/code")
            .await
            .ok()?
            .json()
            .await
            .ok()?;
    parse_npm_latest(&data)
}

/// Return the latest published version of @codemieai/code from the npm registry,
/// or an empty string when offline or the fetch fails.
#[tauri::command]
pub async fn fetch_codemie_latest() -> String {
    fetch_codemie_npm_latest().await.unwrap_or_default()
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd src-tauri && cargo test parse_npm_latest 2>&1 | tail -10
```

Expected: `3 passed`

- [ ] **Step 6: cargo fmt + clippy**

```bash
cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -10
```

Expected: no warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/installer.rs
git commit -m "feat: add fetch_codemie_latest Rust command (npm registry)"
```

---

## Task 4: Rust — `run_self_update` + register all 3 commands + JS bridge

**Files:**
- Modify: `src-tauri/src/commands/runner.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `ui/runner-bridge.js`

- [ ] **Step 1: Add `run_self_update` to `runner.rs`**

Add after `run_stream`:

```rust
/// Run `codemie self-update` silently (captured, not PTY).
/// Returns stdout on exit 0; serializes as an error string on non-zero exit.
#[tauri::command]
pub async fn run_self_update() -> CmdResult<String> {
    let r = capture("codemie self-update", None).await;
    if r.code == 0 {
        Ok(r.stdout)
    } else {
        Err(crate::error::InstallerError::Other(format!(
            "codemie self-update failed (exit {}): {}",
            r.code,
            r.stderr.trim()
        )))
    }
}
```

- [ ] **Step 2: Register all 3 new commands in `lib.rs`**

In `src-tauri/src/lib.rs`, add three lines to the `invoke_handler!` block after the existing `commands::inspector::check_profile_status` line:

```rust
commands::inspector::check_codemie_version,
commands::installer::fetch_codemie_latest,
commands::runner::run_self_update,
```

The updated handler block excerpt:

```rust
commands::inspector::check_codemie,
commands::inspector::check_profile_status,
commands::inspector::check_codemie_version,
commands::installer::fetch_codemie_latest,
commands::runner::run_self_update,
```

- [ ] **Step 3: Verify build compiles**

```bash
cd src-tauri && cargo build 2>&1 | tail -15
```

Expected: `Compiling codemie-installer-macos-tauri ...` then `Finished`.

- [ ] **Step 4: Add JS wrappers in `runner-bridge.js`**

In `ui/runner-bridge.js`, extend the `inspector` export and add updater entries.

Replace the existing `inspector` export:

```js
export const inspector = {
  checkGit: () => invoke('check_git'),
  checkNode: () => invoke('check_node'),
  checkNpm: () => invoke('check_npm'),
  checkCodemie: () => invoke('check_codemie'),
  checkCodemieVersion: () => invoke('check_codemie_version'),
  gitBinaryPath: () => invoke('git_binary_path'),
  nodeBinaryPath: () => invoke('node_binary_path'),
};
```

Add a new `updater` export after the `installer` export block:

```js
// ---- updater ----
export const updater = {
  fetchCodemieLatest: () => invoke('fetch_codemie_latest'),
  runSelfUpdate: () => invoke('run_self_update'),
};
```

- [ ] **Step 5: cargo fmt**

```bash
cd src-tauri && cargo fmt
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/runner.rs src-tauri/src/lib.rs ui/runner-bridge.js
git commit -m "feat: register run_self_update, check_codemie_version, fetch_codemie_latest commands"
```

---

## Task 5: JS — `semverLt` utility and tests (TDD)

**Files:**
- Create: `ui/test/version-utils.test.mjs`
- Modify: `ui/renderer.js` (add `semverLt` near the top)

- [ ] **Step 1: Write failing test file**

Create `ui/test/version-utils.test.mjs`:

```js
// Tests for semverLt — copy the function here for isolated testing.
// The implementation lives in renderer.js; keep this in sync.
import test from 'node:test';
import assert from 'node:assert/strict';

function semverLt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return true;
    if (na > nb) return false;
  }
  return false;
}

test('lower minor is less than', () => {
  assert.strictEqual(semverLt('0.3.9', '0.4.1'), true);
});

test('equal versions are not less than', () => {
  assert.strictEqual(semverLt('0.4.1', '0.4.1'), false);
});

test('higher version is not less than', () => {
  assert.strictEqual(semverLt('0.5.0', '0.4.1'), false);
});

test('major boundary: 0.9.9 < 1.0.0', () => {
  assert.strictEqual(semverLt('0.9.9', '1.0.0'), true);
});

test('analytics threshold: 0.4.0 < 0.4.1', () => {
  assert.strictEqual(semverLt('0.4.0', '0.4.1'), true);
});

test('analytics threshold: 0.4.1 is not < 0.4.1', () => {
  assert.strictEqual(semverLt('0.4.1', '0.4.1'), false);
});

test('analytics threshold: 0.4.2 is not < 0.4.1', () => {
  assert.strictEqual(semverLt('0.4.2', '0.4.1'), false);
});
```

- [ ] **Step 2: Run tests — verify they pass (function is defined inline)**

```bash
node --test ui/test/version-utils.test.mjs
```

Expected: `7 pass`

- [ ] **Step 3: Add `semverLt` to `renderer.js`**

In `ui/renderer.js`, add after the `INSTALL_ONLY_IDS` constant (around line 19):

```js
// Compare semver strings. Returns true when a < b. Works for X.Y.Z format.
function semverLt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return true;
    if (na > nb) return false;
  }
  return false;
}

// Populated during boot(); consumed by runAnalytics() and runUpdateCli().
const cliVersionState = { installed: '', latest: '', updateAvailable: false };
```

- [ ] **Step 4: Run full JS test suite**

```bash
npm test
```

Expected: all existing tests pass (engine + models + version-utils).

- [ ] **Step 5: Commit**

```bash
git add ui/test/version-utils.test.mjs ui/renderer.js
git commit -m "feat: add semverLt helper and cliVersionState to renderer.js"
```

---

## Task 6: HTML/CSS — installation group restructure

**Files:**
- Modify: `ui/index.html`
- Modify: `ui/styles.css`

This replaces the flat 4-tile `#home-grid` with a 2-row layout: an `#installation-group` spanning full width (containing 3 sub-tiles + update banner), then Connect and Analytics tiles in a 2-column row below.

- [ ] **Step 1: Replace `#home-grid` contents in `index.html`**

Replace the entire `<div id="home-grid">…</div>` block (lines 32–57) with:

```html
        <div id="home-grid">
          <div id="installation-group">
            <div class="group-label">Installation</div>
            <div id="update-banner" class="hidden">
              <span>⬆️ Update available: <span id="update-from"></span> → <span id="update-to"></span>. Run <strong>Update CLI</strong> to get the latest version.</span>
              <button id="update-banner-dismiss" aria-label="Dismiss">✕</button>
            </div>
            <div id="installation-tiles">
              <button class="home-tile sub-tile" data-action="full">
                <div class="tile-icon">🚀</div>
                <div class="tile-title">Full installation</div>
                <div class="tile-desc">Install Git, Node &amp; the CodeMie CLI, then run the setup wizard and Claude engine.</div>
              </button>
              <button class="home-tile sub-tile" data-action="install-only">
                <div class="tile-icon">📦</div>
                <div class="tile-title">Install only</div>
                <div class="tile-desc">Install Git, Node &amp; the CodeMie CLI — skip the setup wizard.</div>
              </button>
              <button class="home-tile sub-tile" id="update-cli-tile" data-action="update-cli">
                <div class="tile-icon" id="update-cli-icon">🔄</div>
                <div class="tile-title" id="update-cli-title">Update CLI</div>
                <div class="tile-desc">Update the CodeMie CLI to the latest version.</div>
              </button>
            </div>
          </div>

          <button class="home-tile" data-action="connect-desktop">
            <div class="tile-icon">🖥️</div>
            <div class="tile-title">Connect Claude Desktop</div>
            <div class="tile-desc">Point Claude Desktop at the CodeMie proxy gateway.</div>
          </button>

          <button class="home-tile" data-action="analytics">
            <div class="tile-icon">📊</div>
            <div class="tile-title">CLI usage analytics</div>
            <div class="tile-desc">Build an HTML report of your local AI CLI usage (Claude Code, Codex, …) and open it in the browser.</div>
          </button>
        </div>
```

- [ ] **Step 2: Add CSS for new elements in `styles.css`**

Add after the `#home-footer` rule (around line 151):

```css
/* ---- Installation group ---- */
#installation-group {
  grid-column: 1 / -1;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-xl);
  padding: 16px 20px;
  transition: border-color 0.14s ease;
}
#installation-group.update-available { border-color: var(--accent); }
.group-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-bottom: 12px;
}
#update-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: rgba(88, 166, 255, 0.08);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--text);
}
#update-banner.hidden { display: none; }
#update-banner-dismiss {
  background: none;
  border: 1px solid var(--border-2);
  color: var(--muted);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  flex-shrink: 0;
  font: inherit;
}
#installation-tiles {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
}
.sub-tile { padding: 14px 12px; }
.sub-tile .tile-icon { font-size: 22px; }
.sub-tile .tile-title { font-size: 13px; }
/* Update CLI tile state variants */
#update-cli-tile[data-state="highlight"] { border-color: var(--accent); }
#update-cli-tile[data-state="updating"] {
  border-color: var(--accent);
  background: var(--surface-2);
  pointer-events: none;
}
#update-cli-tile[data-state="done"] {
  border-color: #3fb950;
  background: rgba(63, 185, 80, 0.08);
  pointer-events: none;
}
#update-cli-tile[data-state="error"] {
  border-color: #ff6b6b;
  background: rgba(255, 107, 107, 0.08);
}
```

- [ ] **Step 3: Verify the app renders correctly**

```bash
npm run tauri dev
```

Open the app. Confirm:
- Home title reads "EPAM AI/Run CodeMie Connect"
- Installation group appears with 3 sub-tiles (Full installation, Install only, Update CLI)
- Connect and Analytics tiles sit below as 2-column row
- No banner visible yet (hidden by default)
- Clicking existing tiles (Full, Install only, Connect, Analytics) still works

- [ ] **Step 4: Commit**

```bash
git add ui/index.html ui/styles.css
git commit -m "feat: restructure home grid — installation group with 3 sub-tiles"
```

---

## Task 7: JS — version state, boot check, banner, `runUpdateCli`

**Files:**
- Modify: `ui/renderer.js`

- [ ] **Step 1: Add `showUpdateBanner` and `dismissUpdateBanner` functions**

Add after the `hideNotice` function in `renderer.js`:

```js
// ---- CLI version banner ----
function showUpdateBanner() {
  if (!cliVersionState.updateAvailable) return;
  if (sessionStorage.getItem('update-banner-dismissed') === '1') return;
  document.getElementById('update-from').textContent = cliVersionState.installed;
  document.getElementById('update-to').textContent = cliVersionState.latest;
  document.getElementById('update-banner').classList.remove('hidden');
  document.getElementById('installation-group').classList.add('update-available');
  document.getElementById('update-cli-tile').dataset.state = 'highlight';
}

function dismissUpdateBanner() {
  sessionStorage.setItem('update-banner-dismissed', '1');
  document.getElementById('update-banner').classList.add('hidden');
  document.getElementById('installation-group').classList.remove('update-available');
  const tile = document.getElementById('update-cli-tile');
  if (tile.dataset.state === 'highlight') delete tile.dataset.state;
}
```

- [ ] **Step 2: Add `runUpdateCli` function**

Add after `runAnalytics`:

```js
async function runUpdateCli() {
  const tile = document.getElementById('update-cli-tile');
  const iconEl = document.getElementById('update-cli-icon');
  const titleEl = document.getElementById('update-cli-title');
  const siblings = document.querySelectorAll('#installation-tiles .sub-tile:not(#update-cli-tile)');

  // Enter updating state
  tile.dataset.state = 'updating';
  iconEl.textContent = '⏳';
  titleEl.textContent = 'Updating…';
  siblings.forEach((t) => { t.style.pointerEvents = 'none'; t.style.opacity = '0.4'; });

  try {
    await invoke('run_self_update');

    // Re-probe installed version after update
    const newVersion = await invoke('check_codemie_version');
    cliVersionState.installed = newVersion;
    cliVersionState.updateAvailable =
      newVersion && cliVersionState.latest
        ? semverLt(newVersion, cliVersionState.latest)
        : false;

    tile.dataset.state = 'done';
    iconEl.textContent = '✅';
    titleEl.textContent = newVersion ? `Updated! → ${newVersion}` : 'Updated!';

    if (!cliVersionState.updateAvailable) {
      dismissUpdateBanner();
    }

    setTimeout(() => {
      delete tile.dataset.state;
      iconEl.textContent = '🔄';
      titleEl.textContent = 'Update CLI';
      siblings.forEach((t) => { t.style.pointerEvents = ''; t.style.opacity = ''; });
    }, 3000);
  } catch (e) {
    tile.dataset.state = 'error';
    iconEl.textContent = '❌';
    titleEl.textContent = 'Failed — retry?';
    siblings.forEach((t) => { t.style.pointerEvents = ''; t.style.opacity = ''; });
  }
}
```

- [ ] **Step 3: Wire the dismiss button and `update-cli` action in `boot()`**

In `boot()`, after `initTerminal(...)` and before `handlers = makeHandlers(...)`, add the banner dismiss listener and the version check:

```js
  // Wire update banner dismiss
  document.getElementById('update-banner-dismiss').addEventListener('click', dismissUpdateBanner);

  // Check CLI version vs npm latest at startup (non-blocking)
  Promise.all([
    invoke('check_codemie_version'),
    invoke('fetch_codemie_latest'),
  ]).then(([installed, latest]) => {
    cliVersionState.installed = installed;
    cliVersionState.latest = latest;
    cliVersionState.updateAvailable =
      Boolean(installed) && Boolean(latest) && semverLt(installed, latest);
    showUpdateBanner();
  }).catch(() => {
    // Silently ignore — offline or CLI not installed
  });
```

- [ ] **Step 4: Add `update-cli` case to the home tile click handler**

In `boot()`, in the `homeGrid.addEventListener('click', ...)` switch block, add after the `analytics` case:

```js
      case 'update-cli':
        runUpdateCli();
        break;
```

- [ ] **Step 5: Verify end-to-end in the app**

```bash
npm run tauri dev
```

- If CodeMie CLI is installed: check console for version fetch completing
- If a newer version exists: banner appears inside the Installation group with correct version strings
- Click ✕: banner dismisses; refreshing the app shows it again (sessionStorage resets)
- Click Update CLI: tile shows ⏳ Updating… during the command; shows ✅ / ❌ on completion

- [ ] **Step 6: Commit**

```bash
git add ui/renderer.js
git commit -m "feat: version check on boot, update banner, runUpdateCli state machine"
```

---

## Task 8: JS — analytics version gate + terminal hint fix

**Files:**
- Modify: `ui/renderer.js`
- Modify: `ui/terminal.js`

- [ ] **Step 1: Update `openTerminal` in `terminal.js` to support per-call hint**

In `ui/terminal.js`, change line 69 from:

```js
  if (hintEl) hintEl.textContent = DEFAULT_HINT;
```

to:

```js
  if (hintEl) hintEl.textContent = opts.hint || DEFAULT_HINT;
```

- [ ] **Step 2: Add optional `hint` parameter to `runAction` in `renderer.js`**

Change the `runAction` signature and `openTerminal` call:

```js
async function runAction(title, cmd, returnView = 'home', hint) {
  openTerminal(title, { keepOpen: true, hint, onClose: () => showView(returnView) });
  try {
    const code = await bridge.pty.spawnPty(cmd);
    writeLine(`\r\n${code === 0 ? '\x1b[32m✓' : '\x1b[31m✗'} Finished (exit ${code}).\x1b[0m Click "‹ Back" to return.\r\n`);
  } catch (e) {
    writeLine(`\r\n\x1b[31m✗ Error: ${(e && e.message) || e}\x1b[0m\r\n`);
    handlePtyExit();
  }
}
```

- [ ] **Step 3: Replace `runAnalytics` with version-gated version**

Replace the existing `runAnalytics` function:

```js
async function runAnalytics() {
  // --report-output is set explicitly: a Finder-launched bundle's CWD is "/",
  // which is not writable. $HOME is expanded by the pty's login shell.
  const { installed } = cliVersionState;
  if (installed && semverLt(installed, '0.4.1')) {
    showNotice({
      title: 'CLI update required',
      message: `Your CodeMie CLI (v${installed}) doesn't support analytics reporting. Use Update CLI to upgrade, then try again.`,
      primaryLabel: 'Go to Update CLI',
      primaryAction: () => hideNotice(),
    });
    return;
  }
  await runAction(
    'Analytics report',
    'codemie analytics --report --open --report-output "$HOME/codemie-analytics.html"',
    'home',
    'Running automatically — no input needed.'
  );
}
```

- [ ] **Step 4: Add hint to the Connect action call**

In `boot()`, find the connect button handler:

```js
connectBtn.addEventListener('click', async () => {
  if (await ensureAuthenticated()) {
    runAction('Connect Claude Desktop', 'codemie proxy connect desktop', 'connect');
  }
```

Change to:

```js
connectBtn.addEventListener('click', async () => {
  if (await ensureAuthenticated()) {
    runAction('Connect Claude Desktop', 'codemie proxy connect desktop', 'connect', 'Running automatically — no input needed.');
  }
```

- [ ] **Step 5: Verify analytics gate**

```bash
npm run tauri dev
```

With the app open:
- If CLI version `< 0.4.1`: clicking "CLI usage analytics" shows the notice modal ("CLI update required") instead of opening the terminal
- If CLI version `>= 0.4.1`: clicking analytics opens the terminal with hint text "Running automatically — no input needed." (not the wizard hint)
- Connect action: hint reads "Running automatically — no input needed."
- Wizard steps: hint still reads "Follow the prompts above. This will close automatically…" (DEFAULT_HINT unchanged)

- [ ] **Step 6: Run full quality gate**

```bash
npm test
cd src-tauri && cargo fmt && cargo clippy -- -D warnings && cargo test
```

Expected: all JS tests pass; no Rust warnings; all Rust tests pass.

- [ ] **Step 7: Commit**

```bash
git add ui/renderer.js ui/terminal.js
git commit -m "fix: analytics version gate (< 0.4.1 shows update notice) + terminal hint for one-shot actions"
```

---

## Done

All 8 tasks complete. Run the full quality gate before opening an MR:

```bash
npm test
cd src-tauri && cargo fmt && cargo clippy -- -D warnings && cargo test
```

The branch `feat/rebrand-connect-cli-update-analytics-fix` is ready for MR.
