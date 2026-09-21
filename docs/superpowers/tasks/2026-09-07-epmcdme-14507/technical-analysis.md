# Technical Research

**Task**: self-update tauri-updater installer banner
**Generated**: 2026-09-07T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-14507 — "CodeMie Desktop: Self-update" (sub-task S4 of EPMCDME-14350, parent epic "CodeMie Desktop: A Graphical Front End for the CodeMie CLI").

## Summary
Give the application its own updater. Today, everything called "update" in this codebase updates the CLI through npm, not the Tauri application itself; that gap is what this sub-task closes.

## Important context (from ticket, read before assuming the update banner already does this)
Everything reusable that currently exists in this codebase updates the CLI (the npm package), not the application:
 - `ui/renderer.js:265-308` — `runUpdateCli()` is triggered by a manual "Update CLI" button click. It calls `invoke('run_self_update')`, which shells an `npm install -g` for the CLI package, then re-probes the version via `check_codemie_version`. This is CLI self-update, not app self-update. npm can't be used anymore since it is no longer used for installation.
 - `ui/renderer.js:337-349`, inside `boot()`, checks the installed CLI version against the npm registry's latest on every single app launch, via `check_codemie_version` and `fetch_codemie_latest`, and calls `showUpdateBanner()` if the CLI is behind. There is no "once per day" throttle anywhere in this code; it runs every boot. npm can't be used anymore.
 - `ui/renderer.js:191-207` — `showUpdateBanner` and `dismissUpdateBanner` render and dismiss a banner, but its data (`cliVersionState`) is entirely about the CLI's version, not the application's own version.
 - There is no `tauri-plugin-updater` dependency in `src-tauri/Cargo.toml`, and no app-level version-check or update-download code anywhere in this repo.

What this means concretely: reuse the banner's UI pattern and layout, not the underlying update-check code, since that code answers a different question ("is the CLI behind") than this ticket needs ("is the application behind"). The two updaters, CLI and app, will likely need to coexist and stay clearly distinguishable to the user; conflating them under one banner would be a real user-facing bug, not just an implementation shortcut.

## Scope
The application updates itself, not just the CLI: daily check, user-confirmed update, restart preserving state. Backend: Tauri updater plus manifest. Frontend: an update banner in the same visual pattern as the existing CLI one, but backed by the application's own version data.

## Acceptance Criteria
 - Given a newer CodeMie release exists, when the user next opens the application, then it tells them an update is available.
 - Given an available update, when the user confirms it, then the application updates itself and restarts on the new version.
 - Given the application has updated itself, when the user opens it, then their profile, settings and installed agents are as they were.
 - Given the update cannot be downloaded because the machine is offline or a corporate proxy blocks it, when the attempt fails, then the application says so and keeps working on the current version.
 - Given an application-managed installation, when the user runs `codemie self-update` in a terminal, then they are directed into the application's update flow instead of an npm package being installed.
 - Given an application-managed installation, the CLI's own automatic background update check (the once-a-day check described above that today runs on every boot) also routes into the application's update flow rather than silently running an npm install.
 - The check for an application update happens at most once per day — a new throttle, since none exists today for the CLI check either.

## Definition of done / how to verify
 1. Ship a build one version behind the "latest" the update manifest points to; open the app; confirm it reports an update is available and the banner is visibly the application's own version, not the CLI's.
 2. Confirm the update, let the app restart; confirm the profile, settings and installed agents are unchanged afterward.
 3. Simulate an offline or blocked download; confirm the app reports the failure and keeps working on the current version.
 4. On an application-managed install, run `codemie self-update` in a terminal; confirm it does not run an npm install and instead routes into the app's own update flow.

## Notes
 - Both criteria involving self-update (the terminal command and the automatic background check) depend on the same CLI-side change owned by another team: `self-update` recognising an app-managed install. Confirm with the CLI team whether the command and the background check share one code path or need to be fixed separately. Raise in week 1.
 - Reuse `showUpdateBanner`'s visual pattern, and `check_codemie_version`/`fetch_codemie_latest`'s general approach (poll, compare semver, show banner) as a pattern to copy for the app's own version, not as code to call directly, since it currently answers the wrong question.

## Out of Scope
 - Release publication and CI artifact wiring — sub-task S6/EPMCDME-14509.

---

## 2. Codebase Findings

### Existing Implementations

**CLI-updater code (the thing this task must NOT reuse as-is, only as a UI/approach pattern):**
- `src-tauri/src/commands/runner.rs:141-208` — `self_update_direct()` and `run_self_update()`. On Windows, when the bundled `node.exe` and CLI entry-point paths exist (populated in `lib.rs` setup from `resource_dir()`), it directly spawns `node.exe <cli-entry> self-update` with a 120 s timeout. Otherwise it falls back to `capture("codemie self-update", None)` — a `cmd.exe /c codemie self-update` shell call resolved through PATH. **Correction to the ticket's framing**: the Rust side does not itself shell `npm install -g`; it shells `codemie self-update`, which is a subcommand of the bundled CLI. The actual `npm install -g` call happens one layer down, inside the CLI package (see below).
- `src-tauri/src/commands/installer.rs:73-91` — `fetch_codemie_npm_latest()` / `fetch_codemie_latest()`: queries `https://registry.npmjs.org/@codemieai/code`, `dist-tags.latest`, returns `""` on any failure (never rejects to the frontend).
- `src-tauri/src/commands/inspector.rs:70-96` — `check_codemie_version()`: runs `codemie --version` and parses the first semver-looking token out of stdout via `parse_codemie_version()`.
- `ui/renderer.js:23-34` — `semverLt(a, b)`: hand-rolled dot-separated numeric semver comparator (no pre-release/build-metadata handling). Duplicated verbatim in `ui/test/version-utils.test.mjs` for isolated testing (comment: "keep this in sync").
- `ui/renderer.js:36-37` — module-level `cliVersionState = { installed, latest, updateAvailable }`, populated once in `boot()` (lines 457-469) via `Promise.all([check_codemie_version, fetch_codemie_latest])`, with no persisted throttle — this network round-trip happens on every launch.
- `ui/renderer.js:191-207,247-295` — `showUpdateBanner()` / `hideUpdateBanner()` / `dismissUpdateBanner()` / `setVersionBadge()` / `setGridUpdateCue()`: banner visibility keys off `cliVersionState.updateAvailable` and `sessionStorage.getItem('update-banner-dismissed')`. `sessionStorage` does not survive an app restart, so "dismissed" only holds for the current run, not across launches.
- `ui/renderer.js:383-412` — `runUpdateCli()`: guards against concurrent runs (`updateCliRunning`), calls `invoke('run_self_update')`, re-probes `check_codemie_version`, updates the banner/tile UI, resets after 3 s.
- `ui/index.html:34-39,99-103` — the banner markup (`#update-banner`, `#update-from`, `#update-to`, `#update-banner-run`, `#update-banner-dismiss`) and the home-grid "Update CLI" tile (`#update-cli-tile`).
- `ui/runner-bridge.js:59-63` — `export const updater = { fetchCodemieLatest, runSelfUpdate }` — the existing bridge module is literally named `updater` already, but wraps only the CLI-update commands.

**The actual `npm install -g` call, and the CLI's existing daily-throttled background check** (found inside the bundled CLI package tree shipped as a Tauri resource, `assets/codemie-cli/node_modules/@codemieai/code/`, not in this repo's own Rust/JS source, but staged and shipped by this repo's build):
- `assets/codemie-cli/node_modules/@codemieai/code/bin/codemie.js:8-34` — the CLI's real entry point. On every invocation it runs pending migrations, then (unless `NODE_ENV=test`/`VITEST=true`) calls `checkAndPromptForUpdate()`, non-blocking, before importing `dist/cli/index.js`.
- `.../dist/utils/cli-updater.js` — this is the code the ticket calls "the CLI's own automatic background update check (the once-a-day check ... that today runs on every boot)":
  - `shouldCheckForUpdate()` / `recordUpdateCheck()` already implement a 24 h throttle via a timestamp file at `getCodemiePath()/.last-update-check` (i.e. `~/.codemie/.last-update-check`), configurable via `CODEMIE_UPDATE_CHECK_INTERVAL` (default `86400000` ms).
  - `acquireUpdateLock()` / `releaseUpdateLock()` implement an exclusive-create lock file at `~/.codemie/.update-lock` to prevent concurrent updates from multiple CLI processes.
  - `isAutoUpdateEnabled()` reads `CODEMIE_AUTO_UPDATE` (default `true` = silent auto-update; `false` = prompt via `inquirer`). Setting it to `false` does **not** disable the check — only switches silent-update to a confirmation prompt.
  - `updateCli(latestVersion, silent)` calls `installGlobal(CLI_PACKAGE_NAME, { version, force: true, timeout: 60000 })` from `dist/utils/processes.js`, which shells the actual `npm install -g @codemieai/code@<version>` (confirmed at `dist/utils/processes.js:88-107`: "npm install exited with code ...").
  - `checkAndPromptForUpdate()` is the single function called from `bin/codemie.js` on every CLI invocation; it is the shared code path behind **both** the ticket's two dependent ACs (`codemie self-update` in a terminal and the automatic background check) — confirmed by reading the source, not merely inferred from the ticket's note.
- `.../dist/cli/commands/self-update.js` — the `codemie self-update` command itself: calls `checkForCliUpdate()` then `updateCli(result.latestVersion, false)` — i.e. the *same* `updateCli`/`installGlobal`/npm-install code as the background check. There is no branch anywhere in this file, or in `cli-updater.js`, for an "app-managed install" — the concept does not exist yet in the bundled CLI version staged in this repo (`0.14.1` per `runtime.json`/`docs/EPMCDME-14505-...`).
- On update failure, `updateCli()`'s catch block prints `npm install -g @codemieai/code@<version>` as manual-recovery guidance — this is dead/misleading advice for a bundled, no-system-npm install, already flagged as a follow-up in `docs/EPMCDME-14505-installer-packaging-approaches.md` and `.ai-run/decisions/2026-09-03-EPMCDME-14505-packaging-approach.md:250`.

### Architecture and Layers Affected

Per `.ai-run/guides/architecture/architecture.md` (Option B: "frontend-brain + thin Rust backend"):
- **Frontend (JS, `ui/`)**: `renderer.js` owns view routing, banner state, and boot-time orchestration; `runner-bridge.js` is the sole `invoke()`/`listen()` wrapper surface consumed by the rest of the frontend.
- **Backend (Rust, `src-tauri/src/commands/`)**: one module per system concern, registered as `#[tauri::command]`s in `lib.rs`'s `invoke_handler!` block (currently ~28 commands, none updater-plugin-related).
- **State (`src-tauri/src/state.rs`)**: `AppState` managed via `tauri::Builder::manage()`, injected via `State<'_, AppState>`; currently holds only PTY/remembered-PATH/Windows bundled-path fields — no version-check-timestamp or update-state field exists.
- **Bundled CLI (staged, not this repo's source)**: `assets/codemie-cli/node_modules/@codemieai/code/` — the update-check-and-self-update logic that actually shells npm lives one layer beneath this repo's own code, inside the vendored CLI package.

### Integration Points

- **Internal**: `renderer.js` boot() → `invoke('check_codemie_version')` / `invoke('fetch_codemie_latest')` (Rust commands) → CLI subprocess (`codemie --version`) / npm registry HTTP call. `runUpdateCli()` → `invoke('run_self_update')` → `node.exe <cli> self-update` or shell `codemie self-update` → (inside the CLI) `checkForCliUpdate()` → npm registry HTTP → `installGlobal()` → `npm install -g`.
- **External services already reached from Rust**: `https://registry.npmjs.org/@codemieai/code` (`installer.rs`), `https://nodejs.org/dist/index.json` (`installer.rs::fetch_lts`) — both via `reqwest` with no custom proxy configuration visible; both `unwrap_or_default()`/`unwrap_or_else()` on failure rather than surfacing a distinguishable "offline vs blocked" error to the frontend.
- **No GitHub Releases, no S3, no other release-artifact host is referenced anywhere in this repo's Rust or JS source** — the only existing "check latest version" precedent is the npm registry call, which is explicitly the wrong mechanism for the app's own binary per the ticket.
- **Cross-module**: `ui/runner-bridge.js` is imported by `ui/renderer.js` (only); `src-tauri/src/lib.rs` imports every `commands::*` module and registers its `#[tauri::command]` functions; `commands/runner.rs` reads `state::AppState` for the bundled node/CLI paths.

### Patterns and Conventions

- **Command module pattern**: one file per concern under `src-tauri/src/commands/`, each exposing `#[tauri::command]` functions returning either `T` (infallible) or `CmdResult<T>` (`= Result<T, InstallerError>`, `error.rs`). New commands are registered in `lib.rs`'s `invoke_handler!` list and get a JS wrapper added to `runner-bridge.js` (documented explicitly in `architecture.md`'s "Adding New System Commands" section, steps 1-6, including "add a unit test in the same Rust module under `#[cfg(test)]`").
- **Error type**: single `InstallerError` enum (`thiserror`), `Serialize`s to a plain string for IPC — mirrors the Electron predecessor's `throw new Error(msg)` convention.
- **Frontend module pattern**: `runner-bridge.js` groups bridge functions by domain object (`runner`, `inspector`, `codemieConfig`, `installer`, `updater`, `pathman`, `downloader`, `platformInfo`, `externalWindow`, `pty`) — an `updater` export already exists (lines 59-63) but is scoped to the CLI, not the app.
- **Progress/streaming pattern**: long-running operations (`download_file`, `run_stream`, `spawn_pty`) emit `engine:<event>` Tauri events keyed by a caller-generated id (`nextId()` in `runner-bridge.js`), consumed via `listen()` with an unlisten-in-`finally` idiom.
- **Windows-vs-fallback dual path**: `run_self_update()` demonstrates the existing pattern for "prefer an absolute bundled-resource path, fall back to a PATH-resolved shell command" — relevant precedent for any Windows-specific updater binary-replacement path.
- **Testing pattern**: pure logic (parsers, comparators, guards) is extracted into free functions and unit-tested inline (`#[cfg(test)] mod tests` in the same Rust file, or a standalone `node:test` file for JS) — see `parse_codemie_version`, `parse_npm_latest`, `verify_download`'s path-safety helpers, and `semverLt`'s copy in `ui/test/version-utils.test.mjs`.
- **Downloader precedent**: `commands/downloader.rs::download_file` already implements streaming download + SHA-256 verification + path-traversal guards + a 512 MB size cap + `engine:download-progress` events — the closest existing analog to what an update-artifact download would need, though it is currently restricted to writing inside `std::env::temp_dir()` only.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — describes the Option B frontend-brain/thin-backend split, the command-module/IPC/error/state patterns, and "Adding New System Commands" checklist. Makes no mention of an app updater; its "Configuration" table lists only install-steps YAML, smoke-mode env vars, and the session log path.
- `.ai-run/guides/quality-gates.md` — gate order and commands: `cargo fmt --check`, `cargo clippy -- -D warnings`, `npm test` (`ui/test/*.test.mjs`), `cargo test`, `CI=true cargo tauri build` (DMG) / `cargo tauri build --target universal-apple-darwin`. No Windows-specific build gate is listed here even though this repo is currently Windows-focused (per `tauri.windows.conf.json`, NSIS bundling) — likely stale relative to the Windows-support work.
- `.ai-run/guides/testing/testing-patterns.md`, `.ai-run/guides/development/development-practices.md`, `.ai-run/guides/standards/git-workflow.md` — general conventions; none mention updater/self-update/release-manifest concerns (confirmed by grep).
- `docs/EPMCDME-14505-installer-packaging-approaches.md` — a design-decision document for the *installer packaging* question (bundled Node runtime vs `pkg` compilation), not the app-updater question, but directly relevant here: its "Follow-ups" section explicitly names the gap this ticket must close from the CLI side ("**Improve bundled update messaging**: `dist/utils/cli-updater.js` currently suggests `npm install -g @codemieai/code@<version>`, which is not actionable for a bundled installation... Add a bundled-install update path or suppress that recommendation.").
- `.ai-run/decisions/2026-09-03-EPMCDME-14505-packaging-approach.md:250` — same follow-up, phrased as a recorded decision-record risk: "`cli-updater` advises npm on a bundled install... Needs a bundled-install branch."
- No `docs/superpowers/tasks/` sibling directory exists yet for this epic's other self-update-adjacent sub-tasks (e.g. release publication S6/EPMCDME-14509) — this is the first sub-task in this area to get a task research folder.

### Architectural Decisions

- The recorded decision to bundle a real Node.js runtime + CLI tree (rather than a single compiled `.exe` via `pkg`) means the installed application's "own version" and the "CLI version" are two independently-versioned, independently-staged artifacts from the start — reinforcing the ticket's insistence that the two updaters must stay distinguishable.
- No ADR or guide addresses signing/notarization/update-manifest hosting for this repo; `docs/EPMCDME-14505-...md`'s validation matrix lists "signing, notarization, and hardened-runtime tests where applicable" only as a follow-up for the (different) compilation approach, not as something already implemented.

### Derived Conventions

- New Rust system commands: module in `commands/`, `#[tauri::command]`, `CmdResult<T>` or infallible `T`, registered in `lib.rs`, JS wrapper in `runner-bridge.js`, inline `#[cfg(test)]` unit tests (derived from `architecture.md` + observed pattern across every existing command module).
- Frontend state that must survive only "this session" uses `sessionStorage` (banner dismissal); state that must survive across app launches uses `localStorage` (`theme-init.js`) — the only two existing persistence mechanisms in the frontend; neither is currently used for a daily-check timestamp.
- Platform-conditional code is guarded with `#[cfg(windows)]` / `#[cfg(not(windows))]` at both the function and field level (see `AppState`, `runner.rs`, `inspector.rs`), rather than a runtime branch — the established idiom for anything Windows-only (which a Windows-updater implementation would be, given the repo's current Windows-first NSIS focus per `tauri.conf.json`/`tauri.windows.conf.json`).

---

## 4. Testing Landscape

### Existing Coverage

- `src-tauri/src/commands/runner.rs` — `self_update_direct` has a Windows-only unit test (`tests_windows_self_update`) asserting `Err` when the supplied `node.exe` is not a valid PE binary; the success path is explicitly deferred to "integration-test time on a Windows VM (stage 7)" per its doc comment — i.e. even the existing CLI-self-update path has no automated success-path test today.
- `src-tauri/src/commands/installer.rs` — unit tests for `parse_npm_latest` (dist-tags parsing) and an integration-style async test for `fetch_codemie_latest` that accepts either a real semver or an empty string (tolerant of offline CI).
- `src-tauri/src/commands/inspector.rs` — unit tests for `parse_codemie_version` covering plain/prefixed/`v`-prefixed/slash-path/empty/command-not-found inputs.
- `src-tauri/src/commands/downloader.rs` — unit tests for `verify_download` (empty/hash-mismatch/hash-match/no-hash) and for the path-safety guard (`relative`, `..`, outside-temp, inside-temp cases) — the nearest existing precedent for testing an update-artifact download's safety guards.
- `ui/test/version-utils.test.mjs` — 7 `node:test` cases for a **duplicated copy** of `semverLt` (explicitly commented "keep this in sync" with `renderer.js`), covering minor/equal/major-boundary/analytics-threshold cases.
- `src-tauri/tests/bundle_resources.rs` — exists but not read in depth; name suggests it verifies staged bundle resources rather than update logic.

### Testing Framework and Patterns

- **Rust**: inline `#[cfg(test)] mod tests` per module, `#[tokio::test]` for async commands, `tempfile` crate for filesystem fixtures (dev-dependency), `#[cfg(all(test, windows))]` / `#[cfg(all(test, unix))]` gating for platform-specific suites.
- **JS**: Node's built-in `node:test` + `node:assert/strict`, run via `npm test` → `node --test ui/test/*.test.mjs`; pure-logic functions are copy-tested in isolation rather than imported (see the `semverLt` duplication) when the source module has side effects (Tauri `invoke`/`window` globals) that would otherwise require a browser/webview harness.
- **UI/dynamic tests**: `package.json`'s `test:ui` script runs Playwright from a separate `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests` directory — a precedent for browser-level assertions on rendered UI state (e.g. banner visibility) if this task needs them.

### Coverage Gaps

- **No tests exist for any update-throttle/timestamp logic** — none exists in this repo to test (the daily throttle the ticket asks for is new).
- **No tests exist for the banner's "which version am I showing" logic** beyond the CLI-scoped `cliVersionState` — an app-scoped equivalent has zero coverage today because it has zero implementation.
- **No tests exist for restart-preserving-state behavior** — nothing in this repo currently restarts the app or verifies post-restart state; `AppState` has no serialization/persistence and none is tested.
- **No tests exist for offline/blocked-download failure reporting** distinct from the existing tolerant "return empty string on failure" pattern (`fetch_codemie_latest`, `latest_lts_node_version`) — those two functions swallow all failure modes into a single fallback value rather than distinguishing and surfacing "offline" to the UI, which is exactly what one of this ticket's ACs requires.
- **The CLI's own `self-update` / background-check code (`cli-updater.js`, `self-update.js`) has no test files inside the staged `assets/codemie-cli/node_modules/@codemieai/code/dist/` tree** (only `.d.ts` type-declaration siblings) — expected, since that package's own test suite ships separately and is not part of this repo's build; any behavior change to it is out of this repo's control per the ticket's own note that it is owned by another team.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE`, `CODEMIE_DEV`, `CODEMIE_SMOKE_MS`, `CODEMIE_SHOT` — read in `src-tauri/src/commands/smoke.rs::smoke_mode()`, gate non-destructive self-test/dev-router behavior at boot; no update-related flag exists among them today.
- `CODEMIE_AUTO_UPDATE` (default `true`) and `CODEMIE_UPDATE_CHECK_INTERVAL` (default `86400000` ms) — read inside the *bundled CLI* (`cli-updater.js`), not by this repo's own Rust/JS. These are the CLI's existing update-behavior toggles; `CODEMIE_AUTO_UPDATE=false` only switches silent-update to a prompt, it does not disable the check.
- `NODE_ENV` / `VITEST` — read by `bin/codemie.js` to skip the update check entirely in test environments.
- `HOME` (falls back to `USERPROFILE` on Windows) — read by `codemie_config.rs::config_path()` to locate `~/.codemie/codemie-cli.config.json`.

### Configuration Files

- `src-tauri/tauri.conf.json` — product identity (`identifier: com.epam.codemie.installer`), window config, CSP (`connect-src 'self' ipc: http://ipc.localhost` — notably does **not** whitelist any external update-manifest host), bundle targets (`dmg`, `nsis`), no `plugins` block (a `tauri-plugin-updater` config block, if added, would live here under `plugins.updater`, and its `endpoints`/pubkey would need a CSP allowance).
- `src-tauri/tauri.windows.conf.json` — Windows-only overlay: `bundle.resources` mapping for the bundled `node.exe`/CLI tree/`codemie.cmd` shim, and (per the NSIS bundle config in the base file) `installMode: currentUser` + `installerHooks: installer-hooks.nsi`.
- `src-tauri/capabilities/default.json` — grants only `core:default` to the `main` window; an updater plugin's permission (`updater:default`) is not present and would need to be added here.
- `runtime.json` — pins `nodeVersion`, `nodeWin64Sha256`, `cliPackage`, `cliVersion` for the bundled runtime; `assets/staging-manifest.json` is the generated companion recording file count/byte size, cross-checked in `build-installer.ps1`. No equivalent "app version manifest" (e.g. a `latest.json` for a Tauri updater) exists yet anywhere in the repo.
- `src-tauri/installer-hooks.nsi` — NSIS post-install/post-uninstall hooks that add/remove `$INSTDIR\bin` from the current user's `PATH`; no update-related hook exists.
- `build-installer.ps1` — stages, verifies, and builds the NSIS installer; asserts artifact presence/size/version rather than trusting exit codes; no release/manifest-publishing step (confirmed out of scope, owned by S6/EPMCDME-14509).

### Feature Flags and Deployment Concerns

- No existing feature-flag mechanism beyond the `CODEMIE_*` smoke/dev env vars described above.
- Deployment: this repo currently targets Windows NSIS packaging (`webviewInstallMode: offlineInstaller`, `installMode: currentUser`); `bundle.targets` also lists `dmg` (macOS) though the currently-read Windows-specific overlay and PowerShell build scripts suggest active work is Windows-first. Any updater artifact-hosting/signing/CI wiring is explicitly out of scope per the ticket (S6/EPMCDME-14509).
- Secrets management: no existing pattern for signing keys, update-manifest tokens, or credential loading is present in this repo (the closest analog, `keytar`, belongs to the bundled CLI's credential storage, not this app).

---

## 6. Risk Indicators

- **Ticket's own description of the Rust-side behavior is slightly imprecise** — `run_self_update` shells `codemie self-update`, not `npm install -g` directly; the actual `npm install -g` happens one layer down inside the bundled CLI's `installGlobal()`. A spec that assumes the Rust code itself needs an npm-removal edit may target the wrong layer; the CLI-side npm call is inside vendored, staged code this repo does not own.
- **The dependency this ticket flags on "another team" is now concretely located and unimplemented**: `codemie self-update` (`dist/cli/commands/self-update.js`) and the background check (`bin/codemie.js` → `checkAndPromptForUpdate` in `dist/utils/cli-updater.js`) are **confirmed to share the exact same code path** (`updateCli`/`installGlobal`) in the CLI version currently staged in this repo (`0.14.1`). Neither has any "app-managed install" branch today. Two of the ticket's seven ACs cannot be satisfied by changes to this repo alone.
- **No `tauri-plugin-updater` dependency, capability, or config exists** — adding one touches `Cargo.toml`, `tauri.conf.json` (`plugins.updater`), `capabilities/default.json` (`updater:default` permission), and the CSP (`connect-src`) to allow the manifest/artifact host — a multi-file, cross-cutting change with no existing precedent in this repo to copy from.
- **No "app version manifest" or release-artifact hosting exists anywhere in this repo or its build scripts** — `build-installer.ps1` builds and verifies a local NSIS installer only; publishing and manifest wiring is explicitly deferred to S6/EPMCDME-14509, but the app-side updater still needs *something* to poll even before that ships, which is a sequencing risk between sub-tasks.
- **No daily-throttle persistence mechanism exists in this app** — the CLI's own `cli-updater.js` has one (file-based, `~/.codemie/.last-update-check`), but this repo's frontend has only `sessionStorage` (session-scoped, does not survive restart) and `localStorage` (used only for theme) as precedent; a new persistent, cross-launch, once-per-day mechanism has no direct analog to copy in this repo today.
- **No existing distinction between "offline" and "blocked/failed" is surfaced to the UI** — `fetch_codemie_latest` and `latest_lts_node_version` both collapse every failure mode into a fallback value (`""` / a hardcoded version) with no error passed to the frontend; the AC requiring the app to "say so" on a failed download has no existing error-surfacing precedent to extend, only the `download_file` command's `CmdResult<T>` (which does propagate errors) as an analog.
- **"Installed agents" — one of the three things the update must leave unchanged — has no implementation in this repo yet**: `ui/index.html`'s `#agents-view` is an explicit empty placeholder (`<!-- AGENTS (placeholder) -->`), and no Rust command or file format for "installed agents" was found anywhere in `src-tauri/src` or `ui/`. Verifying that AC end-to-end may be blocked on whatever sub-task implements the Agents view.
- **Profile/settings preservation is comparatively low-risk**: `~/.codemie/codemie-cli.config.json` (read by `codemie_config.rs`) lives under the user's home directory, not under the application's own install directory — a binary-replacement-style update (the normal `tauri-plugin-updater` model) would not touch it by construction, provided the update mechanism only replaces the installed app binary/resources and not arbitrary user-home paths.
- **CSP is currently locked to `'self' ipc: http://ipc.localhost`** — no external host is allowed for `connect-src`; a manifest/artifact-hosting endpoint (wherever S6 ends up serving `latest.json`/binaries from) will need an explicit CSP addition, or the updater's own Rust-side HTTP client (bypassing the webview's CSP entirely, as `reqwest` calls already do for the npm registry) — worth confirming in the spec.
- **Existing CLI-version-check code duplicates logic** (`semverLt` copy-pasted into a test file "kept in sync" by convention, not by import) — a new app-version comparator should decide up front whether to reuse/import `semverLt` or accept the same duplication-by-convention risk already present in this codebase.
- **`quality-gates.md`'s Build gate only documents macOS (DMG) commands** (`cargo tauri build`, universal target) despite the repo's current NSIS/Windows-first focus visible in `tauri.windows.conf.json` and `build-installer.ps1` — suggests the guide is stale; anyone following it literally for verification would build the wrong artifact.

---

## 7. Summary for Complexity Assessment

This task touches three architectural layers with no existing app-scoped precedent to extend: the Rust backend (a new updater command module plus, most likely, a new `tauri-plugin-updater` dependency, capability grant, and `tauri.conf.json` plugin/CSP configuration — none of which exist today), the frontend (`renderer.js`'s boot-time flow and the `#update-banner` markup, which must gain a second, app-scoped, visually-distinguishable state fed by new backend commands rather than the existing CLI-scoped `cliVersionState`/`showUpdateBanner`), and a persistence layer for the once-per-day throttle that has no existing analog (only session-scoped `sessionStorage` and a theme-only `localStorage` use exist in this app; the CLI's own file-based throttle lives in a package this repo does not own). Two of the seven acceptance criteria (the `codemie self-update` terminal redirect and the CLI's background-check redirect) are confirmed, by reading the actual vendored source, to depend entirely on an "app-managed install" branch inside the bundled `@codemieai/code` package's `cli-updater.js`/`self-update.js` — code this repo stages but does not author, owned by another team, with zero existing scaffolding for that concept.

Test coverage in the touched area is present but narrow: the existing CLI-update commands (`run_self_update`, `check_codemie_version`, `fetch_codemie_latest`) have unit tests for their pure-parsing helpers only, with the Windows success path explicitly deferred to manual VM verification, and the frontend's only update-related test is a hand-copied, "kept in sync by comment" duplicate of `semverLt`. Nothing tests restart-preserving-state, throttle timing, or offline/blocked-download error surfacing, because none of those behaviors exist yet to test. Key risk factors are the cross-repo dependency on the CLI team's unshipped "app-managed install" awareness (explicitly flagged by the ticket itself and now confirmed concretely at the code level), the complete absence of any release-manifest/artifact-hosting mechanism in this repo (deliberately deferred to sub-task S6/EPMCDME-14509, which this task must design against without yet existing), the CSP lockdown that will need an explicit, deliberate widening for whatever endpoint the updater polls, and the "installed agents" verification step in the DoD depending on a feature (`#agents-view`) that is currently an empty placeholder in this same codebase.

---

## 8. External References

None named by the task. `task_context` describes file:line locations entirely within this repository (`ui/renderer.js`, `src-tauri/Cargo.toml`) and a dependency on "another team" for a CLI-side change, but names no external path, URL, or sibling checkout as a source of truth to read. The CLI-side dependency was nonetheless traceable and read directly, because the CLI package in question is vendored into this repository's own build tree at `assets/codemie-cli/node_modules/@codemieai/code/` (staged by `scripts/stage-runtime.ps1` per `runtime.json`'s pinned `cliVersion`) — see Section 2's "The actual `npm install -g` call..." subsection for what was found there.
