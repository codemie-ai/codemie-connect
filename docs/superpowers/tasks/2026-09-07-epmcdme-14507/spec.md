# Spec: EPMCDME-14507 — CodeMie Desktop: Self-update (Tauri Updater + Banner)

**Task directory**: `docs/superpowers/tasks/2026-09-07-epmcdme-14507/`
**Technical analysis**: `technical-analysis.md` (read: confirmed, used as primary input)

---

## 1. Goal

Give the application its own self-update mechanism: a daily background check using `tauri-plugin-updater`, an app-scoped update banner (visually distinct from the existing CLI update banner), user-confirmed download + install, and an automatic restart on both macOS and Windows. The CLI updater and the app updater coexist as separate, clearly-labelled banners.

---

## 2. IPC Contract (Rust → Frontend)

### `check_for_update() → CmdResult<Option<String>>`
- Returns `Ok(Some("2.2.0"))` when a newer release is available (version string only — no pub_date, no release notes).
- Returns `Ok(None)` when already on the latest version.
- Returns `Err(...)` when the manifest endpoint is unreachable (offline or corporate proxy blocks it).
- Error message is user-displayable: e.g. `"Update check failed: connection timeout"`.
- The daily throttle is enforced here: if called within 24 h of the last successful check, returns `Ok(None)` immediately (no network call).

### `download_and_install() → CmdResult<()>`
- Triggers `tauri-plugin-updater`'s download + install pipeline.
- Emits `engine:update-progress` Tauri events (keyed by a caller-generated id) so the frontend can show progress. Event payload: `{ id: string, percent: number }`.
- Returns `Ok(())` when install completes successfully and the app is ready to restart.
- Returns `Err(...)` on any download/install failure; the error message is user-displayable.

### `restart_app() → ()` (infallible)
- Calls `app_handle.restart()` (Tauri 2.x `AppHandle::restart`) to close the current process and relaunch the newly-installed binary.
- No return value / no error surfaced — once this fires the process exits.
- Called by the frontend immediately after `download_and_install` succeeds, after displaying a "Restarting…" confirmation state.
- Works on both macOS (AppImage/tar.gz in-place update + relaunch) and Windows (NSIS silent-install + relaunch) via Tauri's built-in restart API — no platform-specific Rust branches needed.

---

## 3. Daily-Throttle Persistence

- `localStorage` key `codemie.app.lastUpdateCheck` stores an ISO-8601 timestamp.
- Set by the frontend on every successful `check_for_update()` call (success = `Ok(Some)` or `Ok(None)`, i.e. network reachable).
- On boot, before invoking `check_for_update`, the frontend checks if `< 24 h` has elapsed; if so, skips the IPC call entirely.
- The Rust side performs the same guard independently (prevents concurrent calls from bypassing the frontend check), storing the timestamp in `AppState`.
- `localStorage` was chosen because:
  - It survives app restarts (unlike `sessionStorage`).
  - Theme is the only existing `localStorage` use — adding a second key is straightforward.
  - User data (`~/.codemie/codemie-cli.config.json`) is unchanged — no coupling.

---

## 4. Frontend Changes (`ui/`)

### Banner (`renderer.js` + `ui/index.html`)
- Add a second, independent banner: `#app-update-banner` (id distinct from existing `#update-banner` which is CLI-scoped).
- Same visual pattern as the CLI banner, different label: "CodeMie Desktop update available" + version string (e.g. "→ v2.2.0").
- New `appVersionState = { latest: null, updateAvailable: false }` module-level object (mirrors existing `cliVersionState`).
- `showAppUpdateBanner(latestVersion)` / `hideAppUpdateBanner()` / `dismissAppUpdateBanner()` added alongside existing CLI equivalents.
- Dismiss is session-scoped (`sessionStorage.getItem('app-update-banner-dismissed')`) — same pattern as CLI banner.

### Boot flow (`boot()`)
- After CLI version check, add:
  1. Check `localStorage` timestamp; if ≥ 24 h elapsed (or never set), call `check_for_update()`.
  2. On `Ok(Some(version))`: set `appVersionState.latest`, call `showAppUpdateBanner(version)`.
  3. On `Ok(None)`: no banner.
  4. On `Err(...)`: no banner, no crash — silent failure on boot (consistent with `fetch_codemie_latest`'s existing "return empty string" behavior for CLI, but we do log the error to console).
  5. Update `localStorage` timestamp on any non-error result.

### Update flow (`runUpdateApp()`)
- Triggered by `#app-update-banner-run` button click.
- Guards against concurrent runs (`updateAppRunning` flag — mirrors `updateCliRunning`).
- Shows progress via `engine:update-progress` events (same `listen()` + unlisten-in-`finally` idiom as `download_file`).
- On success:
  1. Display "Restarting…" state in the banner.
  2. Short delay (e.g. 800 ms) so the user sees the confirmation.
  3. Call `invoke('restart_app')`.
- On error: display the error string from `CmdResult`, keep the banner visible for retry.

### Bridge (`runner-bridge.js`)
- Extend the existing `updater` export (currently CLI-only, lines 59–63) with:
  - `checkForAppUpdate()` → wraps `invoke('check_for_update')`
  - `downloadAndInstall(id, onProgress)` → wraps `invoke('download_and_install')` + `listen('engine:update-progress', ...)`
  - `restartApp()` → wraps `invoke('restart_app')`

---

## 5. Backend Changes (`src-tauri/`)

### New module: `src-tauri/src/commands/app_updater.rs`
- Adds `tauri-plugin-updater` as a Rust crate dependency.
- Exposes three `#[tauri::command]` functions matching the IPC contract in §2.
- `check_for_update`: reads/writes a `last_check_at: Option<Instant>` field on `AppState`; compares to 24 h; delegates to `tauri_plugin_updater::UpdaterExt::updater().check()`.
- `download_and_install`: delegates to the update handle returned by the last `check()` call (cached on `AppState`); emits `engine:update-progress` events via `app_handle.emit()`.
- `restart_app`: calls `app_handle.restart()`.
- Unit tests (inline `#[cfg(test)]`): throttle guard logic (< 24 h → skip), error-to-string serialization for offline/blocked cases, version-string extraction from the update record.

### `AppState` (`src-tauri/src/state.rs`)
- Add fields:
  - `last_update_check: Option<std::time::Instant>` — throttle anchor.
  - `pending_update: Option<tauri_plugin_updater::Update>` — cached update handle for `download_and_install` to consume.

### `lib.rs`
- Add `commands::app_updater::{check_for_update, download_and_install, restart_app}` to `invoke_handler!`.
- Register `tauri_plugin_updater::Builder::new().build()` in Tauri plugin chain.

### `Cargo.toml`
- Add: `tauri-plugin-updater = { version = "2", features = [] }` (or latest 2.x).

### `tauri.conf.json`
- Add `plugins.updater.pubkey` (Ed25519 public key — placeholder; actual key provisioned when S6/EPMCDME-14509 sets up CI signing).
- Add `plugins.updater.endpoints` — placeholder endpoint URL; actual URL determined by S6.
- CSP `connect-src`: add the future manifest/artifact hostname. For now, add a placeholder comment; the actual value is an S6 deliverable.

### `capabilities/default.json`
- Add `"updater:default"` to the grants list.

---

## 6. Acceptance Criteria Coverage

| AC | Coverage |
|---|---|
| Newer release exists → app reports it on next open | `check_for_update` in boot(), `showAppUpdateBanner` |
| User confirms → app updates + restarts | `runUpdateApp()` → `download_and_install` → `restart_app` |
| Post-update: profile/settings/agents unchanged | NSIS/Tauri updater replaces binaries only, not `~/.codemie/`; Agents view is a placeholder (§8) |
| Offline/blocked download → app says so + keeps working | `Err(...)` from `check_for_update`/`download_and_install` surfaces error string in banner; no crash |
| `codemie self-update` in terminal → routes to app flow | **Out of scope for this task** (CLI team dependency, confirmed unimplemented in staged CLI 0.14.1) |
| CLI background check → routes to app flow | **Out of scope for this task** (same CLI team dependency) |
| Check at most once per day | `localStorage` timestamp + `AppState.last_update_check` dual guard |

The two AC items marked out-of-scope are confirmed (by reading the vendored CLI source) to require changes inside `@codemieai/code/dist/`, code this repo stages but does not author.

---

## 7. Testing

### Rust (inline `#[cfg(test)]` in `app_updater.rs`)
- `throttle_skips_within_24h` — `last_check_at` set < 24 h ago → `check_for_update` returns `Ok(None)` without calling the plugin.
- `throttle_fires_after_24h` — `last_check_at` set > 24 h ago → proceeds to plugin call.
- `error_serialises_to_string` — offline error maps to a non-empty displayable string.

### JS (`ui/test/app-updater-utils.test.mjs`)
- Throttle guard (pure function extracted from `boot()`) — timestamp < 24 h → skip; > 24 h → proceed; missing → proceed.
- `semverLt` reuse check — confirm the app-version comparator calls the existing `semverLt` rather than duplicating it (resolves the existing "keep in sync" risk noted in the technical analysis).

---

## 8. Out of Scope

- **S6/EPMCDME-14509**: CI signing, release publication, actual manifest/artifact hosting endpoint, actual Ed25519 keypair — `tauri.conf.json`'s `plugins.updater.pubkey` and `endpoints` will be placeholders.
- **`codemie self-update` terminal redirect** and **CLI background-check redirect** — require CLI team changes inside the bundled `@codemieai/code` package.
- **Installed-agents preservation verification** — `#agents-view` is an empty placeholder in the current codebase; the AC can be verified end-to-end only after the Agents view sub-task ships.
- **CSP final value** — the `connect-src` addition depends on S6's hosting endpoint; a comment placeholder is added in this task, the real value lands in S6.
- **Release notes / pub_date in banner** — IPC returns version string only (`CmdResult<Option<String>>`); richer metadata is a future enhancement.

---

## 9. Key Risks and Mitigations

| Risk | Mitigation |
|---|---|
| S6 not shipped when this lands | `check_for_update` returns `Ok(None)` when no manifest endpoint is configured — no banner, no error; safe to ship before S6 |
| Windows NSIS silent-install + relaunch fails | `app_handle.restart()` is Tauri's official cross-platform API; test on Windows VM before merge |
| `pending_update` stale if user waits > session | `download_and_install` re-calls `check()` if `pending_update` is `None`; no silent stale-state bug |
| CSP blocks manifest fetch | Rust-side `reqwest` (used by `tauri-plugin-updater`) bypasses webview CSP — only JS `fetch()` is governed by CSP; updater calls are safe |
