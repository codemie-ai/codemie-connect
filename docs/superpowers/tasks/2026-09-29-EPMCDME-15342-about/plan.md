# EPMCDME-15342 About Tab Implementation Plan

> **For agentic workers:** Implement task-by-task; steps use `- [ ]` tracking.

**Goal:** Add an About view (versions, update buttons, resources, support), un-hide its sidebar entry, and move the analytics button under Health.

**Architecture:** A pure render module `ui/about-view.js` (no `invoke`), driven from `ui/renderer.js` via an `about` hook in `showView`. Rust gains one allowlisted `open_external` command and an optional `force` flag on `check_for_update`.

**Tech Stack:** Tauri v2, Rust, vanilla JS ESM, `node:test`.

**Requirements source:** inline (ticket EPMCDME-15342 + settled decisions D1-D7); research in `technical-analysis.md` beside this file.

**Commits:** Commit per task using the repository's existing convention for this branch: subject `EPMCDME-15342 : <Subject>`, short body, no Co-Authored-By. Stage by explicit path only; never stage `.codemie/codemie-cli.config.json`, `.serena/`, `docs/superpowers/tasks/2026-09-28-EPMCDME-15259-model-discovery/`.

## Acceptance criteria

- [ ] About tab is at the bottom of the sidebar; clicking it shows "About CodeMie Connect" in the shell, no reload.
- [ ] "Version information" shows installed app version and installed CLI version.
- [ ] App update button present iff an app update is known; click runs `runUpdateApp()`.
- [ ] CLI update button present iff CLI update known and CLI not bundled; click runs `runUpdateCli()`. Bundled CLI shows a "updates with the app" note instead.
- [ ] Update buttons remain on About after the corresponding banner was dismissed.
- [ ] "Resources" has a "GitHub Repository" link opening `https://github.com/codemie-ai/codemie-code#native-bootstrap-installers`; no documentation link.
- [ ] "Support" has a "Request Help" link opening `mailto:AskCodeMie@epam.com`.
- [ ] Link labels are friendly text, not raw URL/email.
- [ ] Analytics button sits directly below Health, keeps its behavior and onboarding lock.
- [ ] Sidebar entries, command-log footer and main content don't overlap.
- [ ] Offline/failed checks: installed versions still shown; no fabricated update; a known update is never cleared by a failed/null re-check.

## Global Constraints

- No `tauri-plugin-opener`, no new crates or npm deps.
- `open_external` accepts exact-match allowlist only: `https://github.com/codemie-ai/codemie-code#native-bootstrap-installers`, `mailto:AskCodeMie@epam.com`.
- Boot update-check behavior unchanged (throttle still applies when `force` is absent).
- Every About button click is guarded by `if (installRunning) return;`.
- Reuse Health view classes (`.health-head/.health-title/.health-group-heading/.health-row/.health-row-main/.health-label/.health-detail/.health-actions`, `btn btn-accent`); minimal new CSS.

## Review Focus

- Re-check returns `null` (backend throttle, offline, invalid version) after boot found an update → button must stay (T5 regex test on the guard).
- `codemie --version` returns `""` offline/not-installed → CLI row shows "Not available", not blank (T3 test).
- User clicks an About update button while an update is already running from the banner → no second run; About button shows "Updating…" disabled (T3 `running` test; existing `*Running` guards).
- Bundled CLI with `cliVersionState.updateAvailable` stale-true → no CLI button (T3 test).
- Non-allowlisted URL, or allowlisted URL with trailing whitespace/case change → rejected (T1 test).

---

### Task 1: Rust `open_external` allowlisted command

**Files:** Modify `src-tauri/src/commands/logger.rs` (beside `spawn_open` :57-74 and `open_log` :133-138; tests in its `#[cfg(test)]` module ~:140), `src-tauri/src/lib.rs:127-170` (`generate_handler!`).

**Produces:** `invoke('open_external', { url })` → `Ok(())` or `InstallerError::Other("URL not allowed")`.

Test-first: yes — `is_allowed_external_url` accepts exactly the two allowlisted strings and rejects others (`https://github.com/codemie-ai/codemie-code`, `https://evil.com`, `mailto:someone@x.com`, allowlisted URL + `" "`, `MAILTO:AskCodeMie@epam.com`, `""`).

- [ ] Write the failing test in logger.rs tests; run `cargo test is_allowed_external_url` from `src-tauri/` → FAIL (not defined).
- [ ] Implement:

```rust
const EXTERNAL_URLS: [&str; 2] = [
    "https://github.com/codemie-ai/codemie-code#native-bootstrap-installers",
    "mailto:AskCodeMie@epam.com",
];

pub(crate) fn is_allowed_external_url(url: &str) -> bool {
    EXTERNAL_URLS.contains(&url)
}

/// About page links. Exact-match allowlist: this hands input to the OS opener.
#[tauri::command]
pub fn open_external(url: String) -> CmdResult<()> {
    if !is_allowed_external_url(&url) {
        return Err(InstallerError::Other(format!("URL not allowed: {url}")));
    }
    spawn_open(&url)
}
```

- [ ] Register `commands::logger::open_external` in `lib.rs` `generate_handler!`; rerun test → PASS.

### Task 2: `force` flag on `check_for_update`

**Files:** Modify `src-tauri/src/commands/app_updater.rs:209-214`, `ui/runner-bridge.js:111-113`.

**Produces:** `bridge.updater.checkForAppUpdate(force = false)` → `invoke('check_for_update', { force })`.

Test-first: no — one-line guard on a `#[tauri::command]` wrapper (wrappers aren't unit-tested here; `should_check` stays covered). Add param `force: Option<bool>` and change the guard to `if !force.unwrap_or(false) && !should_check(last, CHECK_INTERVAL) { return Ok(None); }`; bridge passes `{ force }`. Boot call site (`renderer.js:1010`) stays argument-less.

### Task 3: `ui/about-view.js` render module

**Files:** Create `ui/about-view.js`, `ui/test/about-view.test.mjs` (fake-DOM pattern from `ui/test/health-ui.test.mjs`).

**Produces:**

```js
export const GITHUB_URL = 'https://github.com/codemie-ai/codemie-code#native-bootstrap-installers';
export const SUPPORT_MAILTO = 'mailto:AskCodeMie@epam.com';
// model: { appVersion, appLatest, appUpdateAvailable, appRunning, appError,
//          cliVersion, cliBundled, cliLatest, cliUpdateAvailable, cliRunning, cliError }
// handlers: { onUpdateApp(), onUpdateCli(), onOpenLink(url) }
export function renderAbout(container, model, handlers) { /* ... */ }
```

Structure: `.health-head` > `h1.health-title` "About CodeMie Connect"; three `.health-group-heading` sections "Version information", "Resources", "Support". Version rows: "CodeMie Connect" / "CodeMie CLI", detail = version or "Not available". App button id `about-app-update` ("Update to <appLatest>") only when `appUpdateAvailable`; CLI button id `about-cli-update` only when `cliUpdateAvailable && !cliBundled`; bundled CLI row detail appends "Updates with the app". `*Running` → button text "Updating…", disabled. `*Error` → `.update-error` text in that row. Links are `<button class="btn btn-ghost">` labelled "GitHub Repository" / "Request Help" calling `onOpenLink(GITHUB_URL|SUPPORT_MAILTO)`. No `invoke` in this module.

Test-first: yes — tests assert: title and three section headings; both versions rendered, empty → "Not available"; app button present/absent by `appUpdateAvailable`, click calls `onUpdateApp`; CLI button present/absent by `cliUpdateAvailable`, absent when `cliBundled` even if available, bundled note shown; `appRunning` → disabled "Updating…"; `appError` text rendered; link labels are friendly (text contains no `http`/`@`), clicks pass exact URLs; no element text contains "Documentation".

- [ ] Write test; `node --test ui/test/about-view.test.mjs` → FAIL (module missing).
- [ ] Implement; rerun → PASS.

### Task 4: Sidebar markup, CSS, and pinned-shape tests

**Files:** Modify `ui/index.html:38-63`, `ui/styles.css` (sidebar block 153-226, comment ~:171; Health block 724-771), `ui/test/home-copy.test.mjs:26-35`.

Test-first: yes — update `home-copy.test.mjs`: About asserted as `id="sidebar-about" class="sidebar-item"` (not hidden), divider not hidden, and `#sidebar-analytics` appears inside `#sidebar-main-group` immediately after `#sidebar-health` (regex over the main-group markup). Run `npm test` → FAIL.

- [ ] Move the `#sidebar-analytics` button into `#sidebar-main-group` right after `#sidebar-health` (keep id/markup; wiring by id at `renderer.js:1106-1117` and `ONBOARDING_LOCKED` in `ui/shell-nav.js:11` are id-based, unchanged). Remove `hidden` from `#sidebar-about` and `#sidebar-divider`. Rewrite stale comments (index.html 38-39, 47-60; styles.css ~171).
- [ ] Add `#about-view` to the Health view padding/max-width/animation rule (selector list), plus only whatever CSS the About rows need. Rerun `npm test` → PASS.

### Task 5: Renderer wiring — About hook, update-state reuse, progress mirroring

**Files:** Modify `ui/renderer.js` (`showView` :315-356; `setUpdateProgress` :828-835; `runUpdateCli` :826-878; `runUpdateApp` :880-917); tests in `ui/test/home-copy.test.mjs`.

**Consumes:** `renderAbout`, `GITHUB_URL`/`SUPPORT_MAILTO` (T3), `checkForAppUpdate(true)` (T2), `open_external` (T1).

Test-first: yes — regex assertions in `home-copy.test.mjs`: `showView` calls `refreshAbout()` when `name === 'about'`; `refreshAbout` calls `bridge.updater.checkForAppUpdate(true)`; its result handler only assigns `appVersionState` inside an `if (latest)` branch (never clears); About handlers guard `installRunning` and call `runUpdateApp()`/`runUpdateCli()`; links call `invoke('open_external', { url })`. Existing pins at `home-copy.test.mjs:57` (boot probe shape) and `:73-81` (`runUpdateCli` body) must still pass — do not reshape those code paths.

- [ ] Write tests; `npm test` → FAIL.
- [ ] Add `renderAboutView()` building the model from `appVersionState`, `cliVersionState`, module-level `aboutInfo = { appVersion: '', cliVersion: '', cliBundled: false }`, `updateAppRunning`/`updateCliRunning`, and `aboutErrors = { app: '', cli: '' }`; calls `renderAbout(views.about, model, handlers)`.
- [ ] Add `async refreshAbout()`: render immediately, then `Promise.allSettled([invoke('get_app_version'), invoke('cli_is_bundled'), updateCliRunning ? cliVersionState.installed : bridge.inspector.checkCodemieVersion(), bridge.updater.checkForAppUpdate(true)])`; fill `aboutInfo` from fulfilled values only; if the check returned a non-null version newer than installed, set `appVersionState = { latest, updateAvailable: true }` (null/rejected → leave as is); re-render. CLI row version = probed value, falling back to `cliVersionState.installed`.
- [ ] Mirror progress: `setUpdateProgress` also writes text/disabled to `#about-cli-update` if present; in `runUpdateApp` do the same for `#about-app-update`. On failure set `aboutErrors.app/cli`; clear it at the start of a run. In each `finally`, call `renderAboutView()` when `#about-view` is visible.
- [ ] Rerun `npm test` → PASS.

---

negative-constraints:
- "CodeMie Documentation link NOT displayed" → T3 (test asserts no "Documentation").
- "No tauri-plugin-opener, no new dependency" → T1 uses existing `spawn_open`.
- "No new Rust commands other than open_external and the force flag" → T1, T2 only.
- "never clear a known update, never fabricate one" → T5 `if (latest)` guard + test.
- "default behavior unchanged for boot" → T2 (`force` optional; boot call unchanged).
- "bundled → no update button" → T3 test.
- "not the raw URL/email as primary label" → T3 test.
- "don't overlap sidebar/footer/main" → T4 (no layout rule changes beyond un-hiding; `#app-sidebar` already scrolls).
- "never commit excluded paths / no Co-Authored-By" → header.
- "no speculative abstractions" → no bridge wrapper for `open_external`; one render module.
