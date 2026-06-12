# Spec: Rebrand + CLI Update Action + Analytics Fix

**Date**: 2026-06-12
**Branch**: `feat/rebrand-connect-cli-update-analytics-fix`

---

## Overview

Three improvements bundled into one branch:

1. **Rebrand** — rename the app from "CodeMie Installer" to "EPAM AI/Run CodeMie Connect" across all user-visible surfaces
2. **CLI update action** — add an Update CLI sub-tile that silently runs `codemie self-update`, with a startup version check that shows a dismissable update banner when a newer version is available on npm
3. **Analytics fix** — gate the analytics action on CLI version `>= 0.4.1`; block older versions with a notice that directs the user to Update CLI; improve terminal hint text so users know no input is required

---

## Section 1 — Rebrand

### Changes

| File | Field / Element | Old value | New value |
|---|---|---|---|
| `src-tauri/tauri.conf.json` | `productName` | `CodeMie Installer` | `CodeMie Connect` |
| `src-tauri/tauri.conf.json` | `windows[0].title` | `CodeMie Installation Wizard` | `EPAM AI/Run CodeMie Connect` |
| `ui/index.html` | `<title>` | `CodeMie Installation Wizard` | `EPAM AI/Run CodeMie Connect` |
| `ui/index.html` | `#home-title` text | `CodeMie Installer` | `EPAM AI/Run CodeMie Connect` |
| `ui/index.html` | `#sprite-label` text | `Installer` | `Connect` |

### Constraints

- Bundle identifier `com.epam.codemie.installer` is **not changed** — changing it is a breaking macOS deployment event.
- `productName = "CodeMie Connect"` (no `/`) controls the `.app` bundle filename. The full "EPAM AI/Run" branding lives only in visible UI strings where it renders correctly.

---

## Section 2 — Version checking architecture

### New Rust commands (`src-tauri/src/commands/inspector.rs`)

**`check_codemie_version() -> String`**
- Runs `codemie --version`, captures stdout
- Parses the version token from the first non-empty output line (strip any `v` prefix, trim whitespace)
- Returns the version string (e.g. `"0.4.1"`) or empty string if the CLI is not found or produces no parseable output
- Infallible — returns `String` directly (no `CmdResult`)

**`fetch_codemie_latest() -> String`**
- GET `https://registry.npmjs.org/@codemieai/code`
- Extracts `dist-tags.latest` from the JSON response
- Returns the version string or empty string on network failure
- Reuses the `reqwest::get` + `.json::<serde_json::Value>()` pattern from `installer.rs::fetch_lts`
- Infallible — returns `String` directly

Both commands registered in `lib.rs` `invoke_handler!` block. Both get JS wrappers in `runner-bridge.js`.

### Boot-time check (`ui/renderer.js`)

In `boot()`, after `get_steps` and logo load, fire both version commands concurrently:

```js
const [installed, latest] = await Promise.all([
  invoke('check_codemie_version'),
  invoke('fetch_codemie_latest'),
]);
```

Store result in module-level state: `{ installed, latest, updateAvailable }` where `updateAvailable = installed && latest && semverLt(installed, latest)`.

Semver comparison: a small inline `semverLt(a, b)` pure function that splits on `.`, compares numeric segments left to right. No external dependency.

Failure handling: if either call throws or returns empty string, `updateAvailable` stays `false`. The banner silently doesn't appear.

---

## Section 3 — Home screen restructure

### HTML (`ui/index.html`)

The existing flat tile grid is restructured:

```
#installation-group  (new wrapper div)
  .group-label        "Installation"
  #update-banner      (hidden by default)
    banner text + version info + dismiss ✕
  .sub-tiles          3-column grid
    Full installation tile  (existing, moved inside group)
    Install only tile       (existing, moved inside group)
    Update CLI tile         (new)

Connect Claude Desktop tile  (existing, unchanged position)
CLI usage analytics tile     (existing, unchanged position)
```

`#update-banner` is hidden (`display: none`) by default. JS shows it when `updateAvailable === true` and `sessionStorage.getItem('update-banner-dismissed') !== '1'`.

### Update banner content

```
⬆️  Update available: {installed} → {latest}
    Run Update CLI to get the latest version.       [✕]
```

Dismiss ✕ sets `sessionStorage.update-banner-dismissed = '1'` and hides the banner. Clears on next launch (sessionStorage is tab-session scoped).

When the banner is visible, the Installation group gets a blue border highlight and the Update CLI tile gets a matching blue border.

---

## Section 4 — Update CLI silent action

### New Rust command (`src-tauri/src/commands/runner.rs`)

**`run_self_update() -> CmdResult<String>`**
- Runs `codemie self-update` via `run_capture` (not PTY — silent, captures stdout/stderr)
- Returns stdout on exit 0, or `InstallerError` on non-zero exit
- Registered in `lib.rs`, wrapped in `runner-bridge.js`

### JS tile state machine (`ui/renderer.js`)

`runUpdateCli()` manages four tile states on the Update CLI sub-tile:

| State | Tile appearance | Other install tiles |
|---|---|---|
| **idle** | 🔄 "Update CLI" | normal |
| **updating** | ⏳ "Updating…" (blue border) | dimmed, `pointer-events: none` |
| **done** | ✅ "Updated! → {newVersion}" (green border) | normal |
| **error** | ❌ "Failed — retry?" (red border) | normal |

Transitions:
- idle → updating: on tile click
- updating → done: `invoke('run_self_update')` resolves successfully; reset to idle after 3 s; re-run version check to update `updateAvailable` state and hide the banner if now on latest
- updating → error: command rejects; click on error tile re-enters updating
- done → idle: `setTimeout(3000)`

Connect and Analytics tiles remain fully active during an update.

---

## Section 5 — Analytics version gate + terminal hint

### Analytics gate (`ui/renderer.js`)

`runAnalytics()` checks CLI version before opening the terminal:

```js
async function runAnalytics() {
  // Use the installed version cached at boot — no extra IPC call needed.
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

Version threshold: `< 0.4.1` blocks; `>= 0.4.1` proceeds.

### Terminal hint override (`ui/renderer.js` + `ui/terminal.js`)

`runAction(title, cmd, returnView, hint)` gains a fourth optional `hint` parameter. When provided, it is passed to `openTerminal(title, { keepOpen: true, hint, onClose })`. `openTerminal` already reads `opts.hint` — it currently ignores it and always resets to `DEFAULT_HINT`. Change: if `opts.hint` is provided, use it instead of `DEFAULT_HINT`.

All existing `runAction` call sites that don't pass `hint` continue to show `DEFAULT_HINT` unchanged.

The Connect action (`runProxyConnect`) also passes `hint: 'Running automatically — no input needed.'`.

---

## Out of scope

- No changes to install wizard steps, PTY logic, or the Connect flow beyond the hint text
- No changes to the bundle identifier
- No persistent update-check cache (TTL): the check runs on every launch; it's a single async HTTP call and adds negligible startup time
