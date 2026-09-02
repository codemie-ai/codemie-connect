# Technical Research

**Task**: navigation sidebar shell routing identity-bar
**Generated**: 2026-08-31T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-14511 — CodeMie Desktop: Application shell and navigation (Sub-task S8 of EPMCDME-14350)

## Summary
Build a real navigation shell, sidebar, identity bar and view routing for six screens — the current app has none of this, only three hard-coded divs toggled by name. The home grid is kept, so the CLI usage analytics action stays on its existing tile and needs no re-homing.

## Current state, what this repo does today, with evidence
- `ui/renderer.js:146-150` — `showView(name)` is the entire navigation system today: it toggles the `hidden` class on exactly three hard-coded elements, `homeView`, `wizardView` and `connectView`. There is no sidebar, no identity bar, no router, and no concept of more than three views.
- `src-tauri/tauri.conf.json` line 3 sets `productName: "CodeMie Connect"`, line 14 sets window title "EPAM AI/Run CodeMie Connect" — do not change; the rename is owned by a separate ticket (S6/EPMCDME-14509).
- `ui/renderer.js:401-423` — today's "Analytics" entry point is a tile on the home-grid this ticket replaces (`case 'analytics': runAnalytics()`). `ui/renderer.js:244-263` — `runAnalytics()` runs `codemie analytics --report --open --report-output "$HOME/codemie-analytics.html"` and checks installed CLI version, blocking with a plain-language message if older than 0.4.1. No code changes needed to this function — only a new entry point.

## Scope
Build the sidebar, identity bar, and view routing for six screens, replacing the current three-hard-coded-div approach. This is the first task in the whole decomposition plan — every other screen depends on it. The home grid is kept, so the analytics action stays on its tile.

## Acceptance Criteria
- A sidebar exists with a main nav group (Home, Agents, Connections, Health) present from the first run, and "About" pinned separately at the bottom of the sidebar, below a visual divider from the main group.
- An identity bar shows account, active profile, model and project, plus a version badge slot, e.g. "0.14.2 available".
- Switching between the six views works without a page reload.
- A collapsible footer region exists at the bottom of the shell, "what CodeMie ran", ready to host the command log (S9).
- A named region exists in the shell for the update banner (S4) so it does not need to live inside the Home view.
- The existing CLI usage analytics action (including its pre-flight CLI-version check and plain-language message on an old CLI) has a working entry point somewhere in the new shell — it must not silently disappear when the old home-grid is removed.

## Definition of done
- Load the app fresh; sidebar shows Home, Agents, Connections, Health, with About visually separated at the bottom.
- Click through all six views; none triggers a full page reload; each renders in the same shell.
- Footer log region and update-banner region exist as named, empty slots that S9 and S4 can populate without touching this ticket's code again.
- New analytics entry point works exactly as the current one, including the old-CLI warning.

## Notes
- Reuse `renderer.js:runAnalytics` as-is, do not modify its logic.

## Out of Scope
- The content of any individual screen — those are S3, S9, S10, S11, S12.
- Any change to the analytics report itself.

---

## 2. Codebase Findings

### Existing Implementations
- `ui/renderer.js:146-150` — `showView(name)`: the entire current navigation system. Toggles `hidden` class on exactly three DOM references captured at module load (`homeView`, `wizardView`, `connectView` — lines 67-69), obtained via `document.getElementById`. No router abstraction, no view registry, no concept of a sidebar or identity bar.
- `ui/renderer.js:401-423` — `homeGrid` click delegation switches on `tile.dataset.action` (`full`, `install-only`, `connect-desktop`, `analytics`, `update-cli`) to invoke `enterWizard`, `showView('connect')`, `runAnalytics()`, or `runUpdateCli()`. This is the only existing "navigation menu" pattern in the codebase — a flat click-delegated action switch, not a sidebar.
- `ui/renderer.js:244-263` — `runAnalytics()`: reads `cliVersionState.installed` (populated at boot, `ui/renderer.js:337-349`), blocks with `showNotice(...)` if `semverLt(installed, '0.4.1')`, otherwise calls `runAction('Analytics report', 'codemie analytics --report --open --report-output "$HOME/codemie-analytics.html"', 'home', ...)`. Confirmed: no logic changes needed, only a new caller/entry point per the ticket's own note.
- `ui/renderer.js:191-207` — `showUpdateBanner()` / `dismissUpdateBanner()` currently target `document.getElementById('update-banner')`, nested inside the current home view's DOM (`#installation-group`, `#update-cli-tile`). This is the code the ticket wants to be able to point at a new named region instead, without altering its logic (S4 dependency called out in acceptance criteria).
- `ui/renderer.js:310-453` — `boot()`: wires all event listeners, calls `showView('home')` at the end, and is where new nav elements (sidebar buttons, identity bar) would need to be wired to view-switching logic.
- No existing sidebar, identity-bar, router, or per-view-module code exists anywhere in `ui/` — confirmed by three separate codegraph queries ("navigation sidebar shell routing identity-bar" x3, "agents connections health identity-bar") which returned only `renderer.js` and unrelated Rust command modules (pathman/runner — matched on generic "shell"/"config" terms, not app-shell UI). This is a greenfield UI area.

### Architecture and Layers Affected
- **Frontend view/navigation layer** (`ui/renderer.js`) — primary layer touched; `showView` must be generalized from a 3-way toggle to a registry-driven router across 6 views (Home, Agents, Connections, Health, plus wizard/connect flows, plus About).
- **Frontend markup** (`ui/index.html`, not directly returned by codegraph but referenced by every `document.getElementById` call in renderer.js) — new sidebar, identity-bar, footer log region, and update-banner named region must be added here.
- **Existing widget modules** (`ui/steps-ui.js`, `ui/log.js`, `ui/terminal.js`) — pattern precedent for how UI widgets are `init*`'d with DOM element references passed in from `boot()` (see `initLog(...)` and `initTerminal(...)` calls at `ui/renderer.js:320-332`); a new sidebar/router module would likely follow this same `init(...)` convention.
- **Rust changes are required after all.** Routing and layout are frontend, but the identity bar's four fields live in `~/.codemie/codemie-cli.config.json` and no file-read API is reachable from JavaScript — the bridge exports none, the handler list has none, `Cargo.toml` has no `tauri-plugin-fs`, and the capabilities file grants only `core:default`. Three routes existed: `runCapture('cat …')`, adding the fs plugin, or one command. The shell route works but spawns a login shell per read and pushes the three config states and the absent-account contract into untyped JavaScript that EPMCDME-14513, EPMCDME-14515 and EPMCDME-14589 would each re-derive; the plugin widens the filesystem permission surface to read one known path. One command, with the parse split out as a pure function, gives a typed contract and five unit tests for neither cost. `check_profile_status` cannot substitute: its parser keeps only the first auth-status line and discards the profile rows, and it reports not-authenticated for any provider printing no Auth Status row. The window size also lives in Rust: `set_window_height` rewrites both dimensions from `WIN_WIDTH`, so the config, that constant and the log panel's collapsed height must agree or the window jumps on the first log toggle.

### Integration Points
- `runAnalytics()` stays on its grid tile unchanged. `runUpdateCli()` moves onto the update banner, whose own copy points at it, and its progress states are rewritten against the banner button rather than the tile, its icon, its title and its sibling tiles.
- `cliVersionState` (module-level object, `ui/renderer.js:36`, populated at `ui/renderer.js:337-349` via `invoke('check_codemie_version')` / `invoke('fetch_codemie_latest')`) feeds both the version badge slot (identity bar) and the update banner region — both acceptance criteria reference data this state object already holds.
- `showView`'s 3 callers today (`enterWizard`, `boot`'s routing branches, and the various `*.addEventListener('click', () => showView(...))` wiring in `boot()`) are the blast radius any router rewrite must account for.

### Patterns and Conventions
- Vanilla ESM, no framework, no bundler (`ui/*.js` loaded directly as modules) — confirmed by architecture guide and by the plain `document.getElementById` + manual class-toggling style seen throughout `renderer.js`.
- Widget modules follow an `init<Widget>(domRefs)` factory pattern that wires listeners and returns nothing or a small controller object (`initLog`, `initTerminal`, `initSprite` at `ui/renderer.js:317-332`) — the codebase's existing convention for introducing a new stateful UI region, which a new sidebar/router module should likely mirror.
- All system-level actions go through `runner-bridge.js`'s `invoke()`/`listen()` wrappers, never directly into Tauri — irrelevant to pure navigation/layout but relevant if the identity bar needs to source account/profile/model/project data from Rust commands (not confirmed to exist yet — see Risk Indicators).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md` — describes the frontend-brain + thin-Rust-backend split, component responsibility table, and lists `renderer.js` as owning "View routing (home/wizard/connect), Engine construction." This document has not been updated for the six-view shell this ticket introduces and will need a follow-up edit once the shell lands (not in this ticket's stated scope, but a downstream documentation gap).
- `.ai-run/guides/testing/testing-patterns.md` — describes JS test conventions (`node --test`, `ui/test/*.test.mjs`, stubbing `emit`/`handlers`, no Tauri invoke in unit tests).

### Architectural Decisions
- Architecture guide's "Key decision (Option B)" note: orchestration brain stays in JS, Rust provides only thin system commands — reinforces that this ticket's work (navigation shell) is JS-only with no expected Rust changes.
- No ADRs or inline comments found addressing sidebar/multi-view navigation specifically — this is new ground for the project.

### Derived Conventions
- The `init<Widget>({ ...domRefs })` factory convention (log, terminal, sprite) is the closest existing precedent for how a new sidebar/identity-bar/router module should be structured and wired from `boot()`.
- View-toggling today is done by direct class manipulation on cached DOM references rather than a declarative router; any generalization (e.g., a `views` map keyed by name) is a natural extension of `showView`'s existing shape, not a departure from convention.

---

## 4. Testing Landscape

### Existing Coverage
- `ui/test/models.test.mjs` — covers `StepStatus`, `STATUS_META`, `makeStep` (unrelated to navigation).
- `ui/test/engine.test.mjs` — covers step-sequencing/approval/fatal-logic orchestration (unrelated to navigation).
- No test file covers `renderer.js`, `showView`, `runAnalytics`, `runUpdateCli`, or any view-routing behavior. Codegraph's blast-radius annotations explicitly flag `showView`, `renderSteps`, and `runSmoke` (all in `renderer.js`) with "⚠️ no covering tests found."

### Testing Framework and Patterns
- JS: `node:test` + `node:assert/strict`, no framework dependency, files under `ui/test/*.test.mjs` mirroring the module under test.
- Rust: inline `#[cfg(test)]` modules, `#[tokio::test]` for async, real-shell-execution style (no mocks) — not relevant to this ticket's scope since no Rust changes are indicated.
- Smoke modes (`CODEMIE_SMOKE=1`, `CODEMIE_PROBE_SMOKE=1`) exercise renderer boot and DOM assertions (`runSmoke`, `ui/renderer.js:479-...` — checks `.step-row` count, `document.title`, canvas presence, computed background, theme class). A new shell's DOM structure could interact with these smoke assertions (e.g., `.step-row` selectors) since `runSmoke`/`runProbe` force `showView('wizard')` before assertions.

### Coverage Gaps
- Zero existing tests for `renderer.js` view routing, `runAnalytics`, `runUpdateCli`, or any DOM-driven UI behavior in this file. Coverage was established with a Playwright suite asserting computed geometry and computed style rather than element presence, plus inline Rust tests for the config reader's three states and the window clamp. Two further facts shape verification: `frontendDist` is `../ui` with no dev server, so the UI is copied into the bundle at build time and an existing binary never contains new frontend changes; and the smoke probe asserts nothing, printing one line and emitting `SMOKE_OK` on a timer regardless of outcome. Any new router/sidebar/identity-bar code will be added to an area with no prior test scaffolding to extend — a new test file and testing approach (DOM stubbing without a browser, since these are vanilla DOM APIs) would need to be established from scratch, or coverage will remain manual per the "What Is Not Tested Automatically" section of the testing guide.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_SMOKE` / `CODEMIE_PROBE_SMOKE` — control smoke/probe boot modes in `renderer.js`'s `boot()`, both of which currently force `showView('wizard')` before running assertions; a router rewrite must preserve a `showView('wizard')`-equivalent call these modes depend on.

### Configuration Files
- `src-tauri/tauri.conf.json` — sets `productName`/window title; explicitly called out as out-of-scope/do-not-touch by the ticket (owned by EPMCDME-14509).
- No dedicated navigation/menu config file exists (e.g., no `nav.json`, no view registry file) — view names are presently hardcoded string literals in `renderer.js`.

### Feature Flags and Deployment Concerns
- No feature flags found related to navigation. Smoke-mode env vars (above) are the only conditional-boot-path mechanism in the codebase and must remain compatible with any new router.

---

## 6. Risk Indicators

- No existing sidebar, router, or identity-bar code anywhere in the repo — this is a from-scratch UI subsystem, not an extension of an existing one; codegraph found nothing beyond the 3-way `showView` toggle across five separate targeted queries.
- Zero test coverage on `renderer.js`'s view-routing/`showView`/`runAnalytics`/`runUpdateCli` today (flagged directly by codegraph's blast-radius warnings) — any refactor of `showView` into a multi-view router touches code with no regression safety net.
- `runSmoke`/`runProbe` (`ui/renderer.js:440-476`) currently call `showView('wizard')` directly and assert on `.step-row` DOM elements — a router rewrite must preserve whatever call shape these smoke tests depend on, or the smoke-mode CI/manual check breaks silently.
- `showUpdateBanner()`/`dismissUpdateBanner()` (`ui/renderer.js:191-207`) reference specific element IDs (`update-banner`, `installation-group`, `update-cli-tile`) that live inside the current home-view markup being replaced; re-homing this to a named shell region requires re-pointing these DOM lookups without altering their logic, and the current code has secondary side effects on `#installation-group`/`#update-cli-tile` classes that may not have equivalents in the new shell (these elements belong to the home-grid this ticket removes).
- Speculative: the identity bar's "account, active profile, model and project" fields are not sourced from any existing state object or Rust command found in this research (`cliVersionState` only covers CLI version data) — if no existing command supplies this data, populating the identity bar beyond static/empty slots may require new Rust commands or bridge wrappers, which would be a scope decision for spec/plan, not confirmed here.
- Speculative: "Agents" and "Health" as view names have no corresponding code, markup, or data source anywhere in the repo — codegraph queries for "agents connections health identity-bar" returned only the same `renderer.js` content, confirming these are net-new screens with no existing partial implementation to build on (consistent with ticket's Out of Scope note that individual screen content is separate tickets S3/S9-S12).
- The architecture guide (`architecture.md`) documents `renderer.js` as owning "View routing (home/wizard/connect)" — this document will be stale once six views and a sidebar exist; not this ticket's job to fix, but a discoverability risk for the next task reading that guide.

---

## 7. Summary for Complexity Assessment

This task touches exactly one architectural layer in practice: the frontend view/navigation layer (`ui/renderer.js` plus its markup in `ui/index.html`, which codegraph does not directly index as HTML but which every DOM lookup in renderer.js implies). No backend/Rust changes are indicated by any research dimension — the architecture guide's "frontend-brain" split and the absence of any sidebar/identity-bar-related Rust command confirm this is a JS/markup-only change. The file-change surface is concentrated: `renderer.js` (rewrite of `showView` and the `boot()` wiring, ~300 lines of existing logic to touch or wrap around) and `index.html` (new sidebar/identity-bar/footer/update-banner-slot markup), plus possibly one new JS module if the team follows the existing `init<Widget>()` convention for a router/sidebar controller.

Technical novelty is high relative to this codebase: there is no existing sidebar, multi-view router, or identity-bar precedent anywhere in the repository — five targeted codegraph queries across architecture, code structure, tests, dependencies, and config all converged on the same single file (`renderer.js`) and its 3-way `showView` toggle, confirming this is greenfield UI work rather than an extension of an established pattern. The reuse constraints proved well-scoped: `runAnalytics()` needed no change at all once the grid was kept, and only `runUpdateCli()`'s caller and side effects were rewired.

Test coverage posture is a genuine gap: `renderer.js` has zero existing test coverage (confirmed by codegraph's own blast-radius warnings on `showView`, `renderSteps`, and `runSmoke`), and the smoke-mode boot paths (`CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE`) directly depend on `showView('wizard')` and DOM structure (`.step-row`) that a router rewrite must not silently break. Key risk factors are: (1) no test safety net for the code being refactored, (2) the update-banner re-homing touches DOM IDs (`update-banner`, `installation-group`, `update-cli-tile`) tied to markup this ticket removes, and (3) the identity bar's data sources (account/profile/model/project) beyond CLI version are not confirmed to exist anywhere in the codebase — flagged as speculative and left for spec/plan to resolve, not asserted as a required schema change here.

---

## 8. External References

None named by the task — `task_context` references only in-repo files and line ranges (`ui/renderer.js`, `src-tauri/tauri.conf.json`), all of which were reached and verified via codegraph queries above; no path or URL outside this repository was named as a source of truth.

