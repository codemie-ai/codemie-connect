# Technical Research

**Task**: updater manifest installer nsis
**Generated**: 2026-09-28T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-15055 — CodeMie Connect: Seamless in-app upgrade without manual installer download and app replacement on Windows and macOS.

SUMMARY: Implement a seamless in-app upgrade experience for CodeMie Connect on Windows and macOS so users with an old version installed can upgrade to the new app directly from the application UI, without manually downloading an installer, replacing the app, or doing cleanup. Update flow must preserve the user's profile, settings, and agents. Home/status screen shows an available-version banner and an "Update and restart" action; app downloads, installs, cleans up the old version, and restarts into the new version.

ACCEPTANCE CRITERIA (from Jira, abridged to what applies given the scope decisions below):
1. App detects when a newer version is available.
2. UI shows the available version and an "Update and restart" action.
3. UI communicates profile/settings/agents are kept.
4-7. User upgrades from inside the app with no manual installer download, no manual app replacement, no manual uninstall/cleanup.
8-9. Windows app-triggered upgrade completes with no NSIS "Already Installed" dialog; silently handles previous-version uninstall/replacement.
10-12. macOS app-triggered upgrade requires no manual DMG download, no Finder "Replace?" dialog, handles a running process safely, restarts into the updated version.
13-15. New version running after upgrade; profile/settings/agents preserved; no re-onboarding.
16-18. Progress visible during download/verify/install/restart; clear error + retry/fallback on failure.
19. Verified on Windows x86-64, macOS x86-64, macOS Apple Silicon.
20. Installer/update behavior documented.

SCOPE DECISIONS MADE FOR THIS IMPLEMENTATION (override/narrow the ticket's Technical Approach — treat these as binding requirements, not open questions):

1. Artifact verification (checksum/signature) is DEFERRED to a separate ticket. No signing infra exists yet (no Windows cert, macOS notarization not wired into this flow). Build the rest of the update flow WITHOUT a verification step for now. This is a deliberate, tracked gap — research should note it as a known gap, not something to design around.

2. Windows silent-install: FIX NOW, in scope. Current code spawns the downloaded installer with no flags (`Command::new(installer_path).spawn()`), and `installer-hooks.nsi` has no silent-uninstall hook — so today it shows the full interactive NSIS wizard, including a possible "Already Installed" dialog. Required fix:
   (a) pass `/S` when spawning the installer so it runs with no UI;
   (b) add an `.onInit`/pre-install hook in `installer-hooks.nsi` that reads the existing install's `UninstallString` from the registry and runs it silently (`/S`) first, so nothing is left to trigger a conflict dialog.

3. macOS packaging mechanism: NO CHANGE, out of scope. The ticket's Technical Approach mentions possibly migrating from DMG-swap to a PKG-based installer — explicitly NOT pursuing that. Keep the current mount-DMG/swap-`.app`-bundle mechanism as-is; research the existing mechanism as-is, don't look for PKG alternatives.

4. Update source: move from plain-text `version.txt` to a JSON manifest containing version + exact per-platform download URL (and later signature), e.g.:
   `{"version": "2.1.1", "platforms": {"windows-x86_64": {"url": "..."}, "darwin-aarch64": {"url": "..."}, "darwin-x86_64": {"url": "..."}}}`
   This replaces the current filename-guessing logic in `app_updater.rs`, which is also where a hardcoded-aarch64-only bug and a `_signed` filename mismatch bug live — both should go away once the URL comes directly from the manifest instead of being reconstructed from a guessed filename.

RESEARCH GOAL: find and document the current update/installer flow end to end — where `app_updater.rs` (or equivalent) lives, how it currently fetches `version.txt` and guesses filenames (including the aarch64-only and `_signed` bugs), how/where it spawns the Windows installer, the structure and hooks of `installer-hooks.nsi`, the macOS DMG-mount/swap-app-bundle code, how update UI (if any) surfaces on Home/status screen today, IPC pattern between Rust backend and frontend for this feature, and existing tests/patterns for this area. Flag any code that must change to satisfy the scope decisions above.

---

## 2. Codebase Findings

### Existing Implementations

The in-app self-update feature already exists end to end (built under EPMCDME-14507, see git log `028941c`, `db255f2`, `fcd4974`, `d54da6f`, `febb544`, `fdab61c`). This task is a bug-fix/hardening pass on that existing flow, not a greenfield build.

- `src-tauri/src/commands/app_updater.rs` (505 lines incl. tests) — the entire backend update flow:
  - `get_base_url()` — shared base URL, overridable via `CODEMIE_INSTALLER_BASE_URL`, default `https://github.com/codemie-ai/codemie-code/raw/main/install`.
  - `get_version_url()` — `{base}/version.txt` (plain-text, one line, the version).
  - `get_installer_url(version)` (lines 149-167) — **the filename-guessing logic named in the research goal**:
    - Windows: `{base}/CodeMie%20Connect_{version}_x64-setup.exe`
    - macOS: `{base}/CodeMie%20Connect_{version}_aarch64.dmg` — **hardcoded to `aarch64` unconditionally; there is no x86_64/Intel branch at all** (confirms the "hardcoded-aarch64-only bug" named in the ticket's scope decisions). An Intel Mac running this code would request a URL for the arm64 DMG.
    - The `_signed` filename mismatch: `sign-dmg.sh` (see Configuration below) produces the distributable macOS artifact at `CodeMie Installer_2.0.0_aarch64_signed.dmg` (note also the product-name mismatch, `CodeMie Installer` vs. the DMG guess's `CodeMie%20Connect`), but `get_installer_url` guesses `CodeMie%20Connect_{version}_aarch64.dmg` with no `_signed` suffix. If the hosted release artifact is the signed one, the guessed URL 404s.
  - `is_valid_version` / `is_newer_version` — semver-ish validation (≥3 dot-separated numeric parts) and comparison; added across `028941c`→`fdab61c` specifically to stop HTML 404 pages being treated as a valid version string.
  - `should_check` / `CHECK_INTERVAL` (24h) — throttle backed by `AppState.last_update_check: Mutex<Option<Instant>>` (in-process only; resets on app restart, see Risk Indicators).
  - `#[tauri::command] check_for_update` — fetches `version.txt`, validates, compares to `env!("CARGO_PKG_VERSION")`, returns `Option<String>` (new version or `None`). Silently swallows network errors (returns `Ok(None)`, marks checked) — "don't spam errors on network issues".
  - `#[tauri::command] download_and_install` — re-fetches `version.txt` (a second network round-trip; the check and the download do NOT share the version they saw), builds the installer URL via `get_installer_url`, streams the download into memory (`Vec<u8>`, not to disk incrementally) while emitting `engine:update-progress` events with a percent, writes it to `std::env::temp_dir()` under the guessed filename, calls `launch_installer`, sleeps 500ms, then `app.exit(0)`.
  - `launch_installer` — **platform-specific, `#[cfg]`-gated**:
    - Windows (line 14-23): `Command::new(installer_path).spawn()` — **no flags at all**, confirming the ticket's claim: this launches the full interactive NSIS wizard today.
    - macOS (line 29-47): mounts the DMG via `hdiutil attach -nobrowse -readonly -noautoopen -mountpoint <tmp>`, finds the `.app` inside, calls `replace_app_bundle`, detaches the DMG, then spawns a detached shell (`while kill -0 $pid; do sleep 0.2; done; open <app>`) so the new app launches only after this process exits.
    - `replace_app_bundle` — copies the new `.app` via `ditto` to `<target>.app-update`, renames the currently-installed `.app` to `<target>.app-old`, renames the staged copy into place, and only then removes the old one — ordered so a failed copy leaves the original untouched, and a failed final rename restores it.
  - `#[tauri::command] restart_app` — just `app.exit(0)`; comment notes `app.restart()` "crashes when the installer is running" so exit-and-let-the-platform-installer-relaunch is deliberate on Windows. On macOS this command's usefulness after `download_and_install` already exited is unclear (see Risk Indicators).
  - `#[tauri::command] get_app_version` — returns `env!("CARGO_PKG_VERSION")`.
- `src-tauri/installer-hooks.nsi` — the current NSIS hook file, referenced from `tauri.conf.json`'s `bundle.windows.nsis.installerHooks`. Currently defines only `NSIS_HOOK_POSTINSTALL` (empty, PATH registration removed) and `NSIS_HOOK_POSTUNINSTALL` (PowerShell command stripping the app's bin dir from the user `PATH`). **No `.onInit` / pre-install hook exists today** — confirms there is nothing currently reading `UninstallString` from the registry or running a prior uninstall silently, exactly the gap the ticket's scope decision 2(b) names.
- `src-tauri/src/commands/pathman.rs` — existing precedent for Windows registry access from Rust: uses the `winreg` crate (`RegKey::predef(HKEY_CURRENT_USER)`) to read/write `HKCU\Environment`. Not itself part of the update flow, but the only place in the codebase that already touches the Windows registry from Rust — relevant if any registry read needs to happen from Rust rather than from the `.nsi` script.
- `ui/app-updater-utils.mjs` — tiny pure-JS module: `shouldCheckForAppUpdate(lastCheckIso)`, compares against a 24h `CHECK_INTERVAL_MS`, mirrors the Rust-side throttle but is the one actually enforced client-side (see below — the persisted check timestamp lives in `localStorage`, not in Rust state, which resets every launch).
- `ui/renderer.js` — boot-time wiring for the *existing* app-update UI:
  - `appVersionState = { latest: null, updateAvailable: false }` (distinct from `cliVersionState`, which covers the separate "Update CLI" feature — same banner pattern, different subsystem).
  - `showAppUpdateBanner(latestVersion)` / `hideAppUpdateBanner()` / `dismissAppUpdateBanner()` — toggle the `#app-update-banner` element, dismiss recorded per-session in `sessionStorage['app-update-banner-dismissed']`.
  - `runUpdateApp()` (line 513) — click handler for the banner's "Update app" button: generates an id, calls `bridge.updater.downloadAndInstall(id, onProgress)` (listens for `engine:update-progress`), then `bridge.updater.restartApp()`. On failure, resets the button to "Update app" and renders an inline `.update-error` element inside the banner (no explicit retry button beyond re-clicking "Update app"; no distinct "verify" progress phase — the ticket's AC 16-18 progress states (download/verify/install/restart) only map to download progress today, there is no verify phase since no signature/checksum check exists).
  - Boot sequence (~line 624-639): builds `lastUpdateCheckKey = codemie.app.lastUpdateCheck.${appVersion}` (namespaced per-installed-version, in `localStorage`, not Rust state), calls `shouldCheckForAppUpdate`, and if due calls `bridge.updater.checkForAppUpdate()`, showing the banner on a truthy result and always stamping the checked timestamp (even on `null`/no-update). Uses `console.error` (not a UI error) if the check throws.
- `ui/index.html` — `#app-update-banner` (lines ~41-45) already exists: `"⬆️ CodeMie Connect update available → <span id="app-update-to"></span>"`, an `#app-update-banner-run` ("Update app") button, and a dismiss button. **No text anywhere in this banner communicates that profile/settings/agents are preserved** — AC 3 has no current UI text to satisfy it.
- `ui/runner-bridge.js` (lines 60-85) — the JS↔Rust bridge for this feature: wraps `check_for_update`, `download_and_install` (plus the `engine:update-progress` listener), and `restart_app` invokes; exported as `bridge.updater.{checkForAppUpdate, downloadAndInstall, restartApp}` alongside the separate CLI self-update (`fetchCodemieLatest`, `runSelfUpdate`).
- `src-tauri/src/lib.rs` (lines 128-131) — the four app-updater commands are registered in the `invoke_handler!` list, following the same pattern as every other command module.
- `src-tauri/src/state.rs` (lines 37-39) — `AppState.last_update_check: Mutex<Option<Instant>>`, documented as guarding the 24h throttle in `check_for_update`. Because `Instant` is process-relative and the Mutex is in-memory `AppState`, this throttle resets on every app restart — the JS-side `localStorage` timestamp (`ui/renderer.js`) is the one that actually persists across restarts; the two throttles are independent and can disagree.

### Architecture and Layers Affected

Per `.ai-run/guides/architecture/architecture.md` ("Frontend-brain + thin Rust backend, Option B"), this feature already follows the documented pattern, though the guide's component map (written before/without the updater) does not mention `app_updater.rs` or the update banner at all:

- **Rust command layer** (`src-tauri/src/commands/app_updater.rs`) — thin system commands: network fetch, file write, process spawn. This is where scope decisions 2(a) (spawn flags) and 4 (manifest parsing, URL construction) land.
- **Installer/packaging layer** — `src-tauri/installer-hooks.nsi` (Windows NSIS hooks) and the macOS DMG-mount/swap logic inside `app_updater.rs` itself (no separate module). Scope decision 2(b) lands in the `.nsi` file.
- **Frontend orchestration** (`ui/renderer.js`) — banner state, boot-time check, click handlers; already has the "Option B" JS-brain role for this feature (throttle persistence, error rendering, retry-by-reclick).
- **IPC bridge** (`ui/runner-bridge.js`) — thin `invoke()`/`listen()` wrappers, per the documented pattern.
- **State** (`src-tauri/src/state.rs`) — `AppState.last_update_check`, per the documented state pattern.
- **Build/release tooling** — `sign-dmg.sh` (macOS signing, produces the actual artifact filename that `get_installer_url` must eventually match or be replaced by manifest-provided URLs), `build-installer.sh` / `build-installer.ps1` (produce the base `.app`/`.dmg` and NSIS `.exe`, no signing step wired in for Windows), `tauri.conf.json` (`bundle.windows.nsis.installerHooks`, `bundle.targets`, `productName`).

### Integration Points

- **External**: GitHub raw content (`github.com/codemie-ai/codemie-code/raw/main/install/{windows,macos}/version.txt` and the guessed installer filename) is the only external service this flow talks to. No existing tauri-plugin-updater dependency (confirmed absent from `Cargo.toml`) — an earlier research doc for EPMCDME-14507 (`docs/superpowers/tasks/2026-09-07-epmcdme-14507/`) explored `tauri-plugin-updater` but the code that actually shipped is a hand-rolled `reqwest`-based flow instead; that plugin is not present anywhere in the current codebase.
- **Internal, Rust→JS**: `engine:update-progress` event (`{ id, percent }`), emitted from `download_and_install`, consumed in `runner-bridge.js`'s `downloadAndInstall` wrapper.
- **Internal, JS→Rust**: `check_for_update`, `download_and_install { id }`, `restart_app`, `get_app_version` — all via `invoke()`.
- **Internal, cross-feature**: the "Update CLI" feature (`runUpdateCli`, `cliVersionState`, `#update-banner`) is a structurally parallel but separate subsystem (updates the bundled `codemie` CLI via `run_self_update`, not the Tauri app itself) — shares the banner/tile visual pattern in `renderer.js`/`index.html` but no code.
- **Windows registry**: none from the update flow today (the gap scope decision 2(b) asks to close); `pathman.rs`'s `winreg` usage against `HKCU\Environment` is the only existing precedent for touching the registry from this codebase, and is unrelated to `UninstallString`/`HKLM`\Uninstall keys.

### Patterns and Conventions

- All fallible Tauri commands return `CmdResult<T>` (`src-tauri/src/error.rs`), a `thiserror` enum (`InstallerError`) that serializes to a plain string for the frontend — `app_updater.rs` follows this consistently (`InstallerError::Other(...)` for every failure path).
- `#[cfg(target_os = "...")]` gating is the established way to branch Windows/macOS behavior within one file (see `launch_installer`), rather than separate per-platform modules.
- Inline `#[cfg(test)] mod tests` at the bottom of the same file, per `.ai-run/guides/testing/testing-patterns.md` — `app_updater.rs` already has 11 tests, including two that shell out to real `hdiutil` (macOS-only, `#[cfg(target_os = "macos")]`) to round-trip a real DMG.
- New Rust commands are registered in `lib.rs`'s `invoke_handler!` list and wrapped in `runner-bridge.js` — both already done for this feature's 4 commands; any new command (e.g. a manifest-based variant) would follow the same two-step registration.
- Env-var-overridable config follows a `CODEMIE_<NAME>` naming convention (`CODEMIE_INSTALLER_BASE_URL`, `CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE`) with `unwrap_or_else` fallback to a hardcoded default.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — describes the "Option B" frontend-brain/thin-Rust-backend split and the IPC/error/state patterns this feature already follows, but its component map predates (or omits) `app_updater.rs`, `installer-hooks.nsi`, and the update banner entirely — no mention of self-update anywhere in the guide.
- `.ai-run/guides/testing/testing-patterns.md` — general Rust (`#[cfg(test)]`, `cargo test`) / JS (`node --test`) conventions; does not mention the updater specifically. States plainly: "genuine install operations... and network actions... are never run automatically" — i.e. there is no existing precedent for automated integration testing of a real download-and-install cycle; this has to stay manual/smoke-tested per existing convention.
- `.ai-run/guides/quality-gates.md` — `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test`, then `./build-installer.sh` / `.\build-installer.ps1` (which assert bundle contents, not update behavior).
- `docs/superpowers/tasks/2026-09-07-epmcdme-14507/` — prior research/spec/plan for the original self-update feature (EPMCDME-14507). Its `technical-analysis.md` explored adding `tauri-plugin-updater` and flagged CSP/manifest-hosting/signing as open questions; its `complexity-assessment.json` scored the feature XXL partly because of "integration with new external service." **The plugin route was not the one actually implemented** — the shipped code (`app_updater.rs`) is a hand-rolled `reqwest` flow, so that prior doc's plugin-specific findings (CSP allowances for `tauri-plugin-updater`, its `pubkey`/`endpoints` config) do not describe the current codebase and should not be treated as current state.

### Architectural Decisions

- No ADR exists for the update mechanism. The design decisions visible are inferred from code/commit history only: hand-rolled `reqwest` flow over `tauri-plugin-updater` (see above); DMG-mount-and-swap over PKG on macOS (matches this ticket's scope decision 3, already the status quo); NSIS with no code signing on Windows currently (matches the gap scope decision 2 is fixing around, not signing itself).
- `installer-hooks.nsi`'s header comment records one prior decision explicitly: PATH registration was deliberately moved out of the NSIS installer and into the Tauri app's runtime logic (`pathman::inject_bundled_bin_path`), with the installer only responsible for removing that PATH entry on uninstall — relevant context for scope decision 2(b), since any new pre-install hook added to this file joins an existing hook file that already runs PowerShell for registry/environment work.

### Derived Conventions

- Error messages surfaced to the user are plain strings via `InstallerError`, not structured error codes — any new failure mode (manifest fetch failure, missing platform key, invalid manifest JSON) should produce a `InstallerError::Other("...")` with a human-readable message, consistent with every existing failure path in this file.
- Platform branching happens via `#[cfg(target_os = ...)]` within a single file rather than platform-specific files/modules — a manifest-based replacement for `get_installer_url` would naturally follow the same shape (one function, `#[cfg]`-branched platform key selection, e.g. `"windows-x86_64"` vs `"darwin-aarch64"` vs `"darwin-x86_64"`).

---

## 4. Testing Landscape

### Existing Coverage

- `src-tauri/src/commands/app_updater.rs` `#[cfg(test)] mod tests` (11 tests): `should_check` throttle logic (4 tests), `is_newer_version` (2 tests covering basic + edge cases), one `InstallerError` serialization sanity check, and three macOS-only tests (`#[cfg(target_os = "macos")]`): `installer_url_names_the_arm64_dmg` (asserts the *current*, buggy hardcoded-aarch64 URL — this test will need to change/be replaced once the manifest-based URL lands), `finds_the_app_bundle_the_binary_runs_from`, and `replaces_the_app_bundle_with_the_one_in_the_dmg` (the only test that exercises `install_app_from_dmg` end-to-end, using a real `hdiutil`-created DMG in a tempdir).
- `ui/test/app-updater-utils.test.mjs` — 4 `node:test` cases covering `shouldCheckForAppUpdate` (null/undefined/empty, within-24h, past-24h, exactly-24h boundary). No frontend test exists for `showAppUpdateBanner`, `runUpdateApp`, or the boot-time check-and-show wiring in `renderer.js` (that logic is inline in the boot function, not exported for testing — matches the existing gap noted in `testing-patterns.md` for genuine install operations).
- No test exists anywhere for: `get_installer_url` on Windows, `get_base_url`, `get_version_url`, `launch_installer` on Windows (spawning with/without `/S`), `installer-hooks.nsi` behavior (NSIS scripts are not unit-testable with `cargo test`/`node --test` in this repo — no NSIS test harness exists), or any manifest-parsing logic (doesn't exist yet).

### Testing Framework and Patterns

- Rust: inline `#[cfg(test)] mod tests` in the same file, `cargo test`, real-system tests preferred over mocks (the macOS DMG tests literally shell out to `hdiutil create`/`attach`/`detach` against a tempdir rather than mocking the filesystem or process calls) — this is the established convention per `testing-patterns.md` ("Tests that invoke `capture()` run actual shell commands... Mock the shell — test value is lost" — DON'T column).
- JS: `node:test` + `node:assert/strict`, one `*.test.mjs` file per module under `ui/test/`, pure-function-level testing (the existing `app-updater-utils.mjs` was specifically extracted as a pure function so it could be tested without Tauri).

### Coverage Gaps

- Windows-side `launch_installer` and the `/S` silent-install flag (scope decision 2a) have zero existing tests — and cannot be meaningfully tested by `cargo test` since it would require actually spawning a real NSIS installer; likely bounded to manual/smoke verification, matching the documented "genuine install operations... never run automatically" convention.
- `installer-hooks.nsi` has no test harness in this repo at all — the new `.onInit` pre-uninstall hook (scope decision 2b) will be unverifiable by any automated test in this codebase; only manual verification (AC 19: "Verified on Windows x86-64, macOS x86-64, macOS Apple Silicon") applies.
- The macOS x86_64 (Intel) path is entirely untested — the one existing macOS-specific URL test (`installer_url_names_the_arm64_dmg`) only covers the arm64 branch, and there is no Intel branch in code to test yet (the bug the ticket names).
- No test exists for the manifest format at all — it does not exist in code yet.
- No test exists for the update-banner "profile/settings preserved" messaging (AC 3) — it doesn't exist in the UI yet either.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_INSTALLER_BASE_URL` — overrides the shared installer base URL (both platforms); default `https://github.com/codemie-ai/codemie-code/raw/main/install`.
- `CODEMIE_SMOKE` / `CODEMIE_PROBE_SMOKE` — unrelated smoke-mode flags for the renderer/PTY wiring (`lib.rs` startup, `commands/smoke.rs`); not specific to the updater but part of the same env-var-config convention.

### Configuration Files

- `src-tauri/tauri.conf.json` — `productName: "CodeMie Connect"`, `version: "2.1.0"` (currently out of sync with `Cargo.toml`'s `version = "2.1.0"` — consistent at present, but two separate version sources to keep aligned), `bundle.targets: ["dmg", "nsis"]`, `bundle.windows.nsis.installMode: "currentUser"` (no UAC elevation prompt expected), `bundle.windows.nsis.installerHooks: "installer-hooks.nsi"`, `app.security.csp` locked to `'self' ipc: http://ipc.localhost` (no external host allowed for `fetch()`; irrelevant to this flow since all network calls are Rust-side `reqwest`, which bypasses webview CSP entirely — confirmed by the prior EPMCDME-14507 research doc, still true here).
- `src-tauri/installer-hooks.nsi` — the file scope decision 2(b) modifies; currently only `NSIS_HOOK_POSTINSTALL` (no-op) and `NSIS_HOOK_POSTUNINSTALL` (PATH cleanup via PowerShell).
- `sign-dmg.sh` — macOS signing/notarization script; reads/writes hardcoded paths under `src-tauri/target/release/bundle/dmg/CodeMie Installer_2.0.0_aarch64(_signed).dmg` (note: product name `CodeMie Installer` here vs. `CodeMie Connect` in `tauri.conf.json`'s `productName` and in `get_installer_url`'s guess — a further naming inconsistency across the build/release surface, and the version `2.0.0` is hardcoded rather than derived, so this script itself needs updating per-release today independent of this ticket).
- `build-installer.sh` / `build-installer.ps1` — build and verify the base `.app`/`.dmg` (macOS) and NSIS `.exe` (Windows); no code-signing step invoked for Windows anywhere in this repo (confirms scope decision 1's "no Windows cert" premise); macOS signing is a separate manual script (`sign-dmg.sh`), not part of the automated build.
- `runtime.json` / `assets/staging-manifest.json` — unrelated to the app-update manifest named in scope decision 4; these govern the *bundled Node/CLI runtime* staged into the installer at build time, a different "manifest" concept. No existing "app version manifest" (e.g. a `latest.json`) exists anywhere in the repo today — scope decision 4's JSON manifest is new.

### Feature Flags and Deployment Concerns

- No feature flag gates the update banner — it always attempts a check on boot if the 24h throttle allows it.
- Deployment concern already flagged in the ticket and confirmed by code: the update source is currently a plain-text `version.txt` plus filename-guessing, with no per-platform correctness (confirmed hardcoded-aarch64 bug) and no artifact-existence guarantee (confirmed `_signed` naming mismatch risk) — both are exactly what scope decision 4's manifest is meant to fix, and both are real, reproducible defects in the current code, not speculative.
- No CI/CD workflow files were found in this repo (no `.github/workflows`, no `.gitlab-ci.yml`) that reference `version.txt`, the manifest, or artifact publishing — release/publishing to the GitHub raw-content host is not automated from this repository; it is out of this repo's visibility entirely.

---

## 6. Risk Indicators

- **Speculative**: the JSON manifest schema in scope decision 4 will need a Rust struct (`serde::Deserialize`) and a platform-key selection function; the natural location is `app_updater.rs` replacing `get_installer_url`/`get_version_url`, but the exact shape of that change is a design decision, not a finding.
- **Speculative**: satisfying AC 3 (UI communicates profile/settings/agents are kept) likely means adding a line of copy to `#app-update-banner` in `index.html`; today that banner has no such text.
- **Speculative**: the Windows `/S` flag (scope decision 2a) is a one-line change to `launch_installer`'s `Command::new(installer_path)` call; the `.onInit` hook (2b) is new NSIS script content with no existing test harness to verify it beyond manual runs.
- The two update-check throttles are independent and can disagree: Rust's `AppState.last_update_check` (in-memory `Instant`, resets every process restart) vs. JS's `localStorage['codemie.app.lastUpdateCheck.<version>']` (persists across restarts). In practice the JS-side throttle is the one that actually prevents repeat prompts across app restarts, since `check_for_update`'s own throttle is reset by every relaunch; worth confirming this dual-throttle design is intentional rather than redundant/confusing before extending it.
- `download_and_install` re-fetches `version.txt` independently of the version `check_for_update` already saw — under scope decision 4 (manifest), this "fetch manifest twice" pattern would carry over unless consolidated; a manifest fetched once and reused for both the banner version and the download URL would avoid a second round-trip and a theoretical (very unlikely) version-changed-between-calls race.
- `install_app_from_dmg` on macOS has no safety check that the running process actually is the one being replaced beyond `app_bundle_of(current_exe)` — AC 10-12 ("handles a running process safely") is partially addressed today by the wait-for-pid-then-open shell one-liner in `launch_installer`, but there's no check that no *other* instance of the app is also running and could be racing the same swap.
- The whole download in `download_and_install` is buffered fully in memory (`Vec<u8>`) before being written to disk — fine for installer-sized artifacts (tens of MB) but worth knowing if a much larger artifact is ever hosted.
- `restart_app`'s purpose is unclear on macOS: `download_and_install` already calls `app.exit(0)` itself after spawning the installer/replace-and-relaunch logic, so the separate `restart_app` command (called after `downloadAndInstall` resolves in `runUpdateApp`) may be dead code on the success path today, or exists purely for a manual "app version banner exists but download already happened" scenario that isn't obviously reachable — worth clarifying in design, not asserting as a bug.
- No automated test harness exists for NSIS scripts, Windows installer spawning, or the macOS Intel path — the new/changed logic in scope decisions 2 and 4 (Windows x86-64 leg, macOS Intel leg) will rely on the documented manual-verification convention (AC 19) rather than `cargo test`/`npm test` coverage.
- The `sign-dmg.sh` script has a hardcoded version string (`2.0.0`) and a product-name mismatch (`CodeMie Installer` vs. `CodeMie Connect`) independent of this ticket, but relevant context if the manifest work touches how the signed macOS artifact's filename/URL is derived.
- Verification (checksum/signature) is explicitly out of scope per scope decision 1 — flagged here only as a known, deliberate gap per the task's own instruction, not a risk to design around.

---

## 7. Summary for Complexity Assessment

This is a bug-fix/hardening pass on an existing, already-shipped self-update feature (EPMCDME-14507), not a greenfield build — `app_updater.rs` (Rust command layer, ~500 lines incl. 11 tests), `installer-hooks.nsi` (Windows NSIS hooks), `ui/renderer.js` + `ui/index.html` + `ui/runner-bridge.js` (existing update banner, boot-time check, IPC bridge) all already exist and follow the repo's documented "thin Rust backend + frontend-brain" pattern consistently. The work named by the ticket's four scope decisions touches: (1) no code — a deferred gap only; (2) a one-line spawn-flag change plus new NSIS hook script content with zero existing test harness; (3) no code — explicitly out of scope; (4) a replacement of `get_version_url`/`get_installer_url`'s filename-guessing with manifest-fetch-and-parse logic, which is where two confirmed, reproducible bugs live today (macOS URL hardcoded to `aarch64` with no Intel branch at all, and a `_signed`/product-name filename mismatch against the actual signed release artifact produced by `sign-dmg.sh`).

Complexity signals: three of four scope decisions are either no-ops or small, well-scoped diffs in files with an established pattern to extend (`#[cfg(target_os)]` branching, `CmdResult`/`InstallerError`, inline tests). The manifest change (decision 4) is the most substantial piece — it changes the shape of two functions and their tests, and needs a new per-platform key scheme (`windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`), but has no external dependency to add (no `tauri-plugin-updater`; a prior research doc explored that plugin for the original feature but the code that shipped does not use it) and no CSP implication (Rust-side `reqwest` bypasses the webview CSP). The UI banner already exists structurally; AC 3's "profile/settings preserved" messaging is a small copy addition with no current text to build on. Coverage gaps are concentrated exactly where the ticket's changes land: no test exists for the Windows spawn path, the NSIS hook file (untestable by any harness in this repo), or the macOS Intel leg — verification here is bounded to the documented manual/smoke convention (AC 19), which the plan should account for rather than assume away.

---

## 8. External References

None named by the task. `task_context` states scope decisions inline as binding requirements rather than pointing to an external document, guide, or ticket-linked file for their content.
