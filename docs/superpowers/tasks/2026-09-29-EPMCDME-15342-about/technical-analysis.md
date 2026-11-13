# Technical Research

**Task**: about-view sidebar app-updater cli-update
**Generated**: 2026-09-29
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-15342 — CodeMie Connect: add About tab (parent EPMCDME-14350 "CodeMie Connect/Desktop: A new Graphical Front End for the CodeMie CLI"). Repo: C:\repositories\dodemie_gui\codemie-claude-installer-macos (Tauri v2, vanilla JS ESM in ui/, Rust in src-tauri/). Branch feat/EPMCDME-15342-about based on codemie-desktop-stage-2.

Jira acceptance criteria (verbatim):
1. Given CodeMie Connect is opened, when the left menu-bar renders, then a About tab is shown at the bottom of the left menu-bar.
2. Given the user clicks the About tab, then a page titled "About CodeMie Connect" opens without a page reload and within the existing application shell.
3. Given the About page is shown, then it displays a Version information section.
4. ...Version information displays the current installed CodeMie Connect application version.
5. ...Version information displays the current installed CodeMie CLI version.
6. Given a CodeMie Connect application update is available, when the About page renders, then it shows an app update button.
7. Clicking the app update button from About starts the same app update flow as the app update banner.
8. No app update available → no app update button.
9. CLI update available → About shows a CLI update button.
10. Clicking the CLI update button starts the same CLI update flow as the CLI update banner.
11. No CLI update → no CLI update button.
12. User dismissed an app or CLI update banner, update still available → update action remains available from About.
13. About page displays a Resources section.
14. Clicking "GitHub Repository" opens https://github.com/codemie-ai/codemie-code#native-bootstrap-installers
15/16. CodeMie Documentation link (https://docs.codemie.ai/) only if EPMCDME-14862 is done — it is OPEN, so the link is NOT displayed (out of scope).
17. About page displays a Support section.
18. Clicking "Request Help" opens default mail client with AskCodeMie@epam.com as recipient.
19. The existing CLI usage analytics button appears directly below the Health tab.
20. Moved analytics button keeps its existing behavior.
21. About tab and analytics button don't overlap existing sidebar entries, the command-log footer, or main content.
22. Offline / checks fail → About still renders available installed version values and shows no fabricated update availability.
23. External links show user-friendly visible text, not raw URL/email as primary label.

Settled decisions (user-approved):
1. External links open via a new small Rust command `open_external` that runs `open <url>` (like src-tauri/src/commands/logger.rs:59) and only accepts an allowlist of the known URLs (GitHub URL, mailto:AskCodeMie@epam.com); register in src-tauri/src/lib.rs invoke_handler. No tauri-plugin-opener.
2. On each About visit, re-run app update check (bridge.updater.checkForAppUpdate) ignoring the 24h throttle; installed app version from invoke('get_app_version').
3. CLI row: fetch installed CLI version on About visit. If CLI is bundled (invoke('cli_is_bundled')), show version + note it updates with the app, no update button. Otherwise update button when cliVersionState.updateAvailable; buttons call existing runUpdateCli()/runUpdateApp() in ui/renderer.js (same flow as banners; must work after banner dismissal).
4. Styling: match existing Health/Tools view classes; no mockup.
5. Documentation link skipped.

Known facts: `#about-view` placeholder exists in ui/index.html; `#sidebar-about` and `#sidebar-divider` have class `hidden`; move `#sidebar-analytics` from #sidebar-bottom-group into #sidebar-main-group right after #sidebar-health; ui/test/home-copy.test.mjs:26 asserts About hidden — must be updated. cliVersionState/appVersionState/runUpdateCli/runUpdateApp/showView live in ui/renderer.js; boot skips CLI version probe when bundled (~line 863). ui/shell-nav.js ONBOARDING_LOCKED includes sidebar-analytics. Offline: show installed versions, no update buttons.

---

## 2. Codebase Findings

### Existing Implementations

- `ui/index.html:40-63` — sidebar. `#sidebar-main-group` holds home/agents/connections/health (`data-view` attrs). `#sidebar-divider` (line 50, `hidden`). `#sidebar-bottom-group` holds `#sidebar-analytics` (line 54, no `data-view`) and `#sidebar-about` (line 61, `class="sidebar-item hidden" data-view="about"`). HTML comments at 38-39, 47-49, 52-53, 55-60 explain why About/divider are hidden — they become stale.
- `ui/index.html:166-167` — `<div id="about-view" class="hidden"></div>` placeholder.
- `ui/index.html:83-107` — `#home-updates` with `#update-banner` (`#update-banner-run`, `#update-banner-dismiss`, `#update-to`) and `#app-update-banner` (`#app-update-banner-run`, `#app-update-banner-dismiss`, `#app-update-to`). Both live inside `#home-view`, so they are not visible on any other view.
- `ui/renderer.js:34-36` — `cliVersionState = { installed, latest, updateAvailable }`, `appVersionState = { latest, updateAvailable }` (module-level, not exported; renderer.js exports nothing).
- `ui/renderer.js:69-77` — `views` map already includes `about: #about-view`.
- `ui/renderer.js:315-356` — `showView(name)`: toggles `hidden` on all views, sets `aria-current` on `#app-sidebar .sidebar-item[data-view=name]`, and runs per-view first-visit hooks (`health`, `agents`) and every-visit hook (`home` → refreshAgents/refreshConnection). No `about` hook exists.
- `ui/renderer.js:460-504` — `setVersionBadge`, `showUpdateBanner` (skips when `sessionStorage['update-banner-dismissed']==='1'`), `hideUpdateBanner`, `dismissUpdateBanner`, `showAppUpdateBanner`, `hideAppUpdateBanner`, `dismissAppUpdateBanner` (sets `app-update-banner-dismissed`). Dismissal does not change `cliVersionState`/`appVersionState`.
- `ui/renderer.js:801-820` — `runAnalytics()`; reads `cliVersionState.installed` for the `<0.4.1` guard.
- `ui/renderer.js:826-878` — `runUpdateCli()`: guarded by `updateCliRunning`; progress via `setUpdateProgress()` (828-835) which only writes to `#update-banner-run`. Re-probes version and updates `cliVersionState` after update; `hideUpdateBanner()` on success.
- `ui/renderer.js:880-917` — `runUpdateApp()`: guarded by `updateAppRunning`; hardcodes `#app-update-banner-run` for progress text and appends `.update-error` into `#app-update-banner .top-banner-body` on failure.
- `ui/renderer.js:967-982` — banner button wiring, each guarded by `if (installRunning) return;`.
- `ui/renderer.js:988-1001` — boot CLI probe: `Promise.all([invoke('cli_is_bundled'), bridge.inspector.checkCodemieVersion(), invoke('fetch_codemie_latest')])`; `if (bundled) return;` — so for a bundled CLI `cliVersionState.installed` stays `''` (version is probed but discarded).
- `ui/renderer.js:1003-1021` — boot app check: `invoke('get_app_version')`, frontend 24h throttle via `localStorage['codemie.app.lastUpdateCheck.<version>']` + `shouldCheckForAppUpdate` (`ui/app-updater-utils.mjs`), then `bridge.updater.checkForAppUpdate()` → sets `appVersionState` and shows banner.
- `ui/renderer.js:1106-1117` — sidebar click wiring: `querySelectorAll('#sidebar-main-group .sidebar-item, #sidebar-about')` → `showView(btn.dataset.view)`; `#sidebar-analytics` wired separately by id to `runAnalytics()`.
- `ui/shell-nav.js:11` — `ONBOARDING_LOCKED = ['sidebar-agents','sidebar-connections','sidebar-health','sidebar-analytics']`; lookup is by id, so moving the analytics button between groups does not affect locking. `sidebar-about` is not in the list (About would remain clickable during onboarding).
- `ui/runner-bridge.js:83` — `inspector.checkCodemieVersion` → `invoke('check_codemie_version')`, wrapped in `logged('codemie --version', …)` (appears in command-log footer).
- `ui/runner-bridge.js:110-136` — `updater.checkForAppUpdate` → `invoke('check_for_update')`; `fetchCodemieLatest`, `runSelfUpdate`, `downloadAndInstall`, `restartApp`.
- `src-tauri/src/commands/app_updater.rs:112` — `CHECK_INTERVAL = 24h`; `:209-263` — `check_for_update` has its **own backend throttle** on `state.last_update_check` (`src-tauri/src/state.rs:39`, in-memory `Mutex<Option<Instant>>`): returns `Ok(None)` when checked within 24h. Network error → `Ok(None)` and marks checked. Invalid version text → `Ok(None)`. Only `download_and_install` resets the throttle (line 272).
- `src-tauri/src/commands/app_updater.rs:385-388` — `get_app_version()` returns `APP_VERSION` (tauri.conf.json version currently 2.1.0).
- `src-tauri/src/commands/runner.rs:187-194` — `cli_is_bundled` (sync, uses `AppState`).
- `src-tauri/src/commands/inspector.rs:93-96` — `check_codemie_version` runs `codemie --version`, returns `""` on failure.
- `src-tauri/src/commands/logger.rs:57-74` — `spawn_open(path)`: `open <path>` on non-Windows, `cmd /c start "" <path>` on Windows (both `#[cfg]` variants). `open_log` (133-138) is the command pattern.
- No existing `open_external`, `mailto`, `AskCodeMie`, or GitHub URL references anywhere in `ui/` or `src-tauri/src/`.

### Architecture and Layers Affected

- **UI shell / markup**: `ui/index.html` (sidebar groups, `#about-view`).
- **UI routing / orchestration**: `ui/renderer.js` (`showView`, sidebar wiring, update state + update flows).
- **UI presentation**: pattern is a pure render module per screen (`ui/health-ui.js`, `ui/agents-ui.js`, `ui/home-view.js`); none exists for About.
- **UI styles**: `ui/styles.css` (sidebar block 153-226; Health view block 724-771).
- **IPC bridge**: `ui/runner-bridge.js` (namespaced wrappers over `invoke`).
- **Rust command layer**: `src-tauri/src/commands/*.rs` + registration in `src-tauri/src/lib.rs:127-170` `generate_handler![…]`.
- **Tests**: `ui/test/*.test.mjs` (node:test), Rust inline `#[cfg(test)]`.

### Integration Points

- `renderer.js` → `runner-bridge.js` → Tauri `invoke` → `commands::{app_updater, runner, inspector, installer::fetch_codemie_latest}`.
- `check_for_update` → HTTP GET `get_version_url()` via `reqwest`.
- `fetch_codemie_latest` → npm registry (`commands/installer.rs`).
- New link opening would go through OS handler (`open` / `cmd start`) like `logger::spawn_open`.
- `shell-nav.js` `applyOnboardingNav` is applied to the sidebar root by id.
- Command-log footer (`ui/command-log.js`) displays every `logged(...)` bridge call — a CLI version probe on each About visit will appear there.
- CSP (`src-tauri/tauri.conf.json:25`) is `default-src 'self' … connect-src 'self' ipc: http://ipc.localhost`; capabilities `src-tauri/capabilities/default.json` only `core:default`. No opener plugin installed.

### Patterns and Conventions

- Render modules: local `el(tag, className, text)` helper, `container.innerHTML = ''` then append; handlers passed in as callbacks; no `invoke()` inside render modules (`ui/health-ui.js:1-3` comment states this).
- Health styling: `#health-view { padding: 22px 28px 28px; max-width: 760px; animation: cm-fade-in … }`, `.health-head/.health-title/.health-summary/.health-group-heading/.health-row/.health-row-main/.health-label/.health-detail/.health-actions`, buttons `btn btn-accent` / `btn btn-ghost`.
- Sidebar entries: `<button class="sidebar-item" data-view="…">`; routed state via `aria-current="page"`.
- Concurrency guards: module-level `*Running` booleans; `installRunning` checked in every click handler.
- Rust commands: `#[tauri::command] pub fn …() -> CmdResult<…>` with `InstallerError` (`src-tauri/src/error.rs`); pure helpers split out for testing; Windows/non-Windows split with `#[cfg(windows)]`.
- Guide rule (AGENTS.md, architecture.md:66,97): new Rust commands go in `commands/` and are registered in `lib.rs`; business logic stays in the frontend.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — frontend-brain + thin Rust backend; line 66 and 97 on adding/registering commands.
- `.ai-run/guides/development/development-practices.md` — error/logging conventions; line 66 references `invoke('open_log')`.
- `.ai-run/guides/testing/testing-patterns.md` — Rust inline tests + node:test.
- `.ai-run/guides/quality-gates.md` — `cargo fmt --check`, `cargo clippy -- -D warnings`, `npm test`, `cargo test` (from `src-tauri/`); cargo requires staged runtime (`scripts/stage-runtime.ps1` on Windows).

### Architectural Decisions

- `.ai-run/decisions/2026-09-21-EPMCDME-14589-home-grid-actions.md:31-41` — analytics and About sidebar entries shipped; "`#sidebar-about` remains hidden pending an owning ticket". This ticket is that owner.
- `ui/index.html:52-53` — analytics sidebar button is "the only entry point to the analytics report" (per the decision above).
- `ui/test/home-copy.test.mjs:53-58` + `renderer.js:984-987` — decision: no CLI update offered when the bundled CLI is in use (self-update would update user npm, not the app's copy).
- `renderer.js:457-459` — badge vs banner: badge reports update existence, banner reports whether user still wants to be told; dismissal only hides the banner.

### Derived Conventions

- Per-view first-visit/every-visit hooks live in `showView`.
- Views are populated by a controller or render module passed `views.<name>` as container.
- User-facing copy is plain-language, no raw technical strings as primary labels.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/home-copy.test.mjs` — static regex assertions over `index.html` and `renderer.js`: line 26 asserts `id="sidebar-about" class="sidebar-item hidden"`; lines 29-35 assert analytics button markup and wiring to `runAnalytics()`; line 57 asserts the exact boot `Promise.all([invoke('cli_is_bundled'), bridge.inspector.checkCodemieVersion(), invoke('fetch_codemie_latest')]).then(([bundled, installed, latest]) => { if (bundled) return;` shape; lines 73-81 assert `runUpdateCli` body shape (`cliReplacing = true … runSelfUpdate() … finally … refreshAgents(); refreshConnection();`).
- `ui/test/shell-nav.test.mjs` — onboarding lock by id for the four locked entries incl. `sidebar-analytics`.
- `ui/test/app-updater-utils.test.mjs` — `shouldCheckForAppUpdate`.
- `ui/test/cli-update.test.mjs`, `ui/test/version-utils.test.mjs` — `semverLt`, `cliUpdateResult`.
- `ui/test/health-ui.test.mjs`, `agents-ui.test.mjs` — render-module tests with fake DOM (pattern for an About render test).
- `ui/test/top-banner-style.test.mjs`, `identity-bar-layout.test.mjs` — CSS-level static assertions.
- Rust: `app_updater.rs:390+` (`should_check`, version compare), `runner.rs:318+` (`bundled_cli_in_use`), `logger.rs:140+` (path helpers), `inspector.rs:388+` (version parse).

### Testing Framework and Patterns

- JS: `node --test ui/test/*.test.mjs` (package.json), `node:assert/strict`, hand-rolled fake DOM / fake roots, static `readFileSync` regex checks on HTML/renderer.
- Rust: inline `#[cfg(test)] mod tests`, `tempfile` for FS; pure helpers tested, `#[tauri::command]` wrappers not.
- Playwright dynamic tests exist only under a past task dir (`test:ui` script), not general.

### Coverage Gaps

- No tests for `showView` routing, `runUpdateApp`, or banner dismissal state (renderer.js is untested beyond regex).
- No About view/render module or its tests.
- No test covering sidebar group ordering (analytics directly after Health).
- `logger::spawn_open` has no test (spawns a process).

---

## 5. Configuration and Environment

### Environment Variables

- None used by the About domain. `CODEMIE_DEV=1` (smoke flags `flags.dev`) exposes `window.__codemie.showView` for manual verification (`renderer.js:936-939`).

### Configuration Files

- `src-tauri/tauri.conf.json` — `version: 2.1.0` (source of `APP_VERSION`), `withGlobalTauri: true`, CSP at line 25.
- `src-tauri/capabilities/default.json` — `core:default` only.
- `package.json` — `version 2.1.0`, `npm test`.
- Browser storage keys: `sessionStorage['update-banner-dismissed']`, `sessionStorage['app-update-banner-dismissed']`, `localStorage['codemie.app.lastUpdateCheck.<appVersion>']`.

### Feature Flags and Deployment Concerns

- No feature flags. Backend in-memory 24h throttle in `AppState.last_update_check` (resets on app restart).
- Windows is also a target (`#[cfg(windows)]` branches, `build-installer.ps1`, recent Windows tasks) despite the repo name.

---

## 6. Risk Indicators

- **Backend throttle defeats "re-check on each About visit"**: `check_for_update` (`app_updater.rs:211-214`) returns `Ok(None)` for 24h after any check, including boot's. Calling `bridge.updater.checkForAppUpdate()` from About will return `null` after boot, so a naive "null ⇒ no update" would hide the button even when `appVersionState.updateAvailable` is true (AC6/AC12 break). Speculative: either keep `appVersionState` when the result is `null` due to throttle, or add a bypass parameter to the Rust command; decision 2 as written cannot be met frontend-only.
- **Update-flow progress UI is banner-bound**: `setUpdateProgress` writes only to `#update-banner-run`; `runUpdateApp` writes only to `#app-update-banner-run` and appends errors inside `#app-update-banner`. Both banners live inside `#home-view`, so from About the user sees no progress/error feedback. Speculative: these functions need to also reflect state on the About buttons (or a shared state re-render).
- **Bundled CLI version is discarded at boot** (`renderer.js:993`), so `cliVersionState.installed` is `''` when bundled; About must probe itself (decision 3). Each probe runs `codemie --version`, which shows in the command-log footer and may race `runUpdateCli` (`cliReplacing` guard exists for Home reads, `renderer.js:841`).
- **Regex tests pin renderer shapes**: `home-copy.test.mjs:26` (About hidden) must change; `:57` and `:73-81` pin exact code shapes of boot probe and `runUpdateCli` — editing those functions can break them.
- **Offline behavior (AC22)**: `check_for_update` network error → `Ok(None)`; `fetch_codemie_latest` failure makes boot `.catch` silently skip, leaving `cliVersionState.installed` empty even for non-bundled CLI. About must independently show installed versions.
- **Onboarding lock**: `sidebar-about` is not in `ONBOARDING_LOCKED`; analytics stays locked via id after the move. Not a defect, but behavior should be deliberate.
- **Sidebar layout (AC21)**: `#sidebar-bottom-group { margin-top: auto }` and `#app-sidebar overflow-y: auto`; un-hiding `#sidebar-divider` (it has a margin rule) and moving analytics changes spacing; short windows may scroll the sidebar. Stale explanatory HTML comments at `index.html:38-39,47-60` and `styles.css:171`.
- **`open_external` security boundary**: new command runs an OS handler on caller-provided input; allowlist must be exact-match. Windows `cmd /c start "" <url>` treats `&`/`^` specially — the GitHub URL contains `#` only, mailto has none, but exact allowlisting is the guard. No existing opener pattern for URLs.
- **Concurrency**: About buttons need the same `installRunning` guard banner buttons have (`renderer.js:967-982`); `updateCliRunning`/`updateAppRunning` already dedupe.
- **No mockup**: styling is derived from Health classes; visual acceptance is subjective.

---

## 7. Summary for Complexity Assessment

The change touches four layers: shell markup (`ui/index.html` sidebar and the existing `#about-view` placeholder), UI orchestration in `ui/renderer.js` (new `about` hook in `showView`, reuse of `cliVersionState`/`appVersionState`, `runUpdateCli`/`runUpdateApp`), styles in `ui/styles.css`, and the Rust command layer (one new allowlisted `open_external` command beside `logger::spawn_open`, registered in `src-tauri/src/lib.rs`). Routing infrastructure already exists (`views.about`, `data-view="about"`, sidebar click wiring includes `#sidebar-about`), so the About entry is largely unhide-and-render. The expected surface is roughly index.html, renderer.js, styles.css, likely one new render module, one Rust command file edit, lib.rs, and 2-3 test files.

Novelty is low-to-moderate: the render-module and Rust-command patterns are well established, but no URL/mailto opener exists yet, and the update flows were written for a single banner consumer. Two non-obvious constraints raise effort: the Rust `check_for_update` has its own in-memory 24h throttle that returns `None` after boot's check (so a naive About re-check reports "no update" even when one is known), and `runUpdateCli`/`runUpdateApp` render progress and errors only into banner buttons inside `#home-view`, invisible from About.

Test posture: node:test with fake DOM for render modules and regex assertions over index.html/renderer.js; `home-copy.test.mjs` pins About-hidden and the exact shapes of the boot CLI probe and `runUpdateCli`, so edits there require test updates. renderer.js routing and update flows have no behavioral tests; Rust pure helpers are tested inline and an allowlist helper fits that pattern. Main risks: throttle interaction, banner-bound update feedback, bundled-CLI version not retained at boot, offline rendering, and exact-match allowlisting for the OS-open command on both macOS and Windows.

---

## 8. External References

None named by the task. (The GitHub URL, docs URL and mailto address in the acceptance criteria are link targets, not sources of truth; no existing references to them were found in the repo.)
