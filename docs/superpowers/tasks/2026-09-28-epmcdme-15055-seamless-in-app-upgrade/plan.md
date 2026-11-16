# EPMCDME-15055 Seamless In-App Upgrade — Bug-Fix Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the buggy `version.txt`-plus-filename-guessing update source with a JSON manifest (fixing the macOS aarch64-hardcoding and `_signed`-filename-mismatch bugs), and make the Windows app-triggered upgrade run silently with no NSIS "Already Installed" dialog.

**Architecture:** Bug-fix pass on the existing hand-rolled `reqwest` self-update flow in `src-tauri/src/commands/app_updater.rs` — no new subsystem, no new dependency. A `Manifest`/`PlatformEntry` pair (`serde::Deserialize`) and a `platform_key()` selector (cfg-gated on `target_os`/`target_arch`) replace `get_version_url`/`get_installer_url`'s filename guessing. The parsed manifest is cached once in `AppState` by `check_for_update` and reused by `download_and_install` instead of being re-fetched. Windows silent install is a one-line spawn-flag change plus one new NSIS pre-install hook macro.

**Tech Stack:** Rust (Tauri commands, `reqwest`, `serde`/`serde_json`, already-present deps), NSIS (`installer-hooks.nsi`).

**Spec:** none — requirements arrived inline (see `## Acceptance criteria` below, and the full text in `docs/superpowers/tasks/2026-09-28-epmcdme-15055-seamless-in-app-upgrade/technical-analysis.md` §1 "Original Context"). Reuse `technical-analysis.md` throughout; it documents the existing implementation this plan modifies.

## Global Constraints

- No new Cargo.toml dependency — `serde`/`serde_json` (with `derive`) are already present.
- Every failure path returns `InstallerError::Other("...")` via `CmdResult<T>` (`src-tauri/src/error.rs`), matching every existing failure path in this file.
- Platform branching stays `#[cfg(target_os = ...)]` / `#[cfg(target_arch = ...)]` inside the single existing file — no new per-platform module.
- No checksum/signature verification code or scaffolding (deferred to a separate ticket) — a comment only, at the point verification would hook in.
- No change to the macOS mount-DMG/swap-`.app`-bundle mechanism itself — only what's needed to consume the manifest URL instead of a guessed one.
- Do not touch: `sign-dmg.sh`'s hardcoded version/product-name issue, the dual update-check throttle (Rust `Instant` vs JS `localStorage`), `tauri-plugin-updater` (not used, not introduced).
- Commit per task using the repository's existing convention.

---

## Acceptance criteria

- [ ] App fetches a JSON manifest (`manifest.json`, not `version.txt`) to determine the latest version and per-platform download URL.
- [ ] `check_for_update` and `download_and_install` share one manifest fetch per update cycle — `download_and_install` no longer independently re-fetches and re-parses the version source.
- [ ] Manifest platform-key selection is correct for `windows-x86_64`, `darwin-aarch64`, and `darwin-x86_64` (no more aarch64-only hardcoding on macOS).
- [ ] Windows app-triggered upgrade spawns the installer with `/S` (no UI).
- [ ] `installer-hooks.nsi` silently runs the prior install's `UninstallString` before install proceeds, so there is nothing left to trigger the NSIS "Already Installed" dialog.
- [ ] macOS DMG-mount/swap-`.app`-bundle mechanism is unchanged apart from consuming the manifest-provided URL.
- [ ] No checksum/signature verification step is added; a comment marks the future hook point.

---

### Task 1: Manifest data model and platform selection

**Files:**
- Modify: `src-tauri/src/commands/app_updater.rs:143-167` (add new code near the existing `get_version_url`/`get_installer_url`, which stay in place and in use until Tasks 2–3 rewire their callers)
- Modify: `src-tauri/src/commands/app_updater.rs:390-445` (tests module — remove the now-superseded `installer_url_names_the_arm64_dmg` assertion target is `get_installer_url`, which Task 3 removes; leave that specific test alone here since deleting it now without deleting `get_installer_url` would just delete coverage early — add the new tests alongside it instead)

**Interfaces:**
- Produces: `struct Manifest { version: String, platforms: HashMap<String, PlatformEntry> }`, `struct PlatformEntry { url: String }` (both `pub(crate)`, `Deserialize + Clone`), `fn platform_key() -> &'static str`, `fn get_manifest_url() -> String`, `fn get_platform_entry(manifest: &Manifest) -> CmdResult<PlatformEntry>`, `async fn fetch_manifest(client: &Client) -> CmdResult<Manifest>` — Task 2 and Task 3 call `fetch_manifest`/`get_platform_entry`; Task 2 also needs `Manifest` importable from `state.rs`.

Test-first: yes — new tests for platform-key entry selection (found and missing) fail to compile until `get_platform_entry`/`platform_key`/`Manifest`/`PlatformEntry` exist.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block (after the existing tests, before the macOS-only ones):

```rust
#[test]
fn platform_entry_found_for_current_platform() {
    let json = format!(
        r#"{{"version":"9.9.9","platforms":{{"{}":{{"url":"https://example.com/x"}}}}}}"#,
        platform_key()
    );
    let manifest: Manifest = serde_json::from_str(&json).unwrap();
    let entry = get_platform_entry(&manifest).unwrap();
    assert_eq!(entry.url, "https://example.com/x");
}

#[test]
fn platform_entry_missing_returns_error() {
    let manifest: Manifest =
        serde_json::from_str(r#"{"version":"9.9.9","platforms":{}}"#).unwrap();
    assert!(get_platform_entry(&manifest).is_err());
}
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml platform_entry`
Expected: compile error — `Manifest`, `get_platform_entry`, `platform_key` not found.

- [ ] **Step 3: Implement the manifest model and platform selection**

Add above `get_version_url` (around current line 143), keeping `get_version_url`/`get_installer_url` untouched for now:

```rust
#[derive(serde::Deserialize, Clone)]
pub(crate) struct PlatformEntry {
    pub(crate) url: String,
}

#[derive(serde::Deserialize, Clone)]
pub(crate) struct Manifest {
    pub(crate) version: String,
    platforms: std::collections::HashMap<String, PlatformEntry>,
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn platform_key() -> &'static str {
    "windows-x86_64"
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn platform_key() -> &'static str {
    "darwin-aarch64"
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn platform_key() -> &'static str {
    "darwin-x86_64"
}

fn get_manifest_url() -> String {
    format!("{}/manifest.json", get_base_url())
}

fn get_platform_entry(manifest: &Manifest) -> CmdResult<PlatformEntry> {
    manifest.platforms.get(platform_key()).cloned().ok_or_else(|| {
        InstallerError::Other(format!(
            "No installer available for platform '{}'",
            platform_key()
        ))
    })
}

async fn fetch_manifest(client: &Client) -> CmdResult<Manifest> {
    let response = client
        .get(&get_manifest_url())
        .send()
        .await
        .map_err(|e| InstallerError::Other(format!("Failed to fetch manifest: {e}")))?;
    let manifest: Manifest = response
        .json()
        .await
        .map_err(|e| InstallerError::Other(format!("Failed to parse manifest: {e}")))?;
    if !is_valid_version(&manifest.version) {
        return Err(InstallerError::Other(format!(
            "Invalid version in manifest: {}",
            manifest.version
        )));
    }
    Ok(manifest)
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml platform_entry`
Expected: PASS (2 passed). Note `fetch_manifest`/`get_manifest_url` are unused until Task 2 — this is a harmless `dead_code` warning, not a test failure (no `#![deny(warnings)]` in this crate).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/app_updater.rs
git commit -m "EPMCDME-15055: add manifest model and platform-key selection"
```

---

### Task 2: Wire `check_for_update` to the manifest, cached in `AppState`

**Files:**
- Modify: `src-tauri/src/state.rs:9-40` (add `latest_manifest` field + import)
- Modify: `src-tauri/src/commands/app_updater.rs:143-146` (delete `get_version_url` — no longer called by anything after this task)
- Modify: `src-tauri/src/commands/app_updater.rs:209-263` (`check_for_update` body)

**Interfaces:**
- Consumes: `fetch_manifest`, `Manifest`, `is_newer_version`, `should_check`, `CHECK_INTERVAL` (Task 1 / pre-existing).
- Produces: `AppState.latest_manifest: Mutex<Option<Manifest>>`, populated by `check_for_update` with the fetched manifest whenever it reports a newer version available (`None` otherwise) — Task 3 reads this field.

Test-first: no — `check_for_update` is a network-calling async Tauri command with no automated harness in this repo (per `technical-analysis.md` §4, "genuine install operations... and network actions... are never run automatically"); its own logic is now a thin pass-through to `fetch_manifest`/`is_newer_version`, both already covered by existing/Task-1 unit tests.

- [ ] **Step 1: Add the cache field to `AppState`**

In `src-tauri/src/state.rs`, add `use crate::commands::app_updater::Manifest;` near the existing `use crate::commands::pty::PtyHandle;`, and add a field after `last_update_check` (line 39):

```rust
    /// The manifest fetched by the most recent `check_for_update` that found a
    /// newer version, cached so `download_and_install` can reuse it instead of
    /// re-fetching. `None` once no update is pending.
    pub latest_manifest: Mutex<Option<Manifest>>,
```

- [ ] **Step 2: Rewire `check_for_update` and delete `get_version_url`**

Delete `get_version_url` (`src-tauri/src/commands/app_updater.rs:143-146`). Replace the body of `check_for_update` (lines 209-263) so it calls `fetch_manifest(&Client::new())` instead of fetching/validating `version.txt` text directly, keeps the existing `should_check`/`last_update_check` throttle exactly as today, stores the fetched manifest into `state.latest_manifest` only when `is_newer_version(APP_VERSION, &manifest.version)` is true (clearing it to `None` otherwise), and still returns `CmdResult<Option<String>>` — `Some(manifest.version)` or `None` — so `runner-bridge.js`/`renderer.js`'s existing contract is untouched. On any `fetch_manifest` error (network failure or invalid manifest), keep today's behavior: mark checked, return `Ok(None)`, no error surfaced to the UI.

- [ ] **Step 3: Run the existing test suite to confirm nothing broke**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — no test named `check_for_update` exists (network command, untested by design), so this step only confirms the throttle/version-comparison/platform-entry unit tests and the crate still compile and pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/app_updater.rs src-tauri/src/state.rs
git commit -m "EPMCDME-15055: fetch manifest in check_for_update, cache in AppState"
```

---

### Task 3: Wire `download_and_install` to reuse the cached manifest

**Files:**
- Modify: `src-tauri/src/commands/app_updater.rs:148-167` (delete `get_installer_url` — no longer called after this task)
- Modify: `src-tauri/src/commands/app_updater.rs:265-373` (`download_and_install` body)
- Modify: `src-tauri/src/commands/app_updater.rs:440-444` (delete `installer_url_names_the_arm64_dmg`, which asserts `get_installer_url`'s old hardcoded-aarch64 output — the function it tests no longer exists)

**Interfaces:**
- Consumes: `AppState.latest_manifest` (Task 2), `fetch_manifest`, `get_platform_entry` (Task 1).

Test-first: no — same rationale as Task 2; the download/spawn path has never had automated coverage in this repo, and the logic this task adds (`get_platform_entry`) is already covered by Task 1's unit tests.

- [ ] **Step 1: Delete `get_installer_url` and its now-superseded test**

Delete `get_installer_url` (`app_updater.rs:148-167`) and the `installer_url_names_the_arm64_dmg` test (`app_updater.rs:440-444`) — it asserted the old hardcoded-`aarch64` guessed filename, which is exactly the bug this task removes.

- [ ] **Step 2: Rewire `download_and_install`**

Replace lines 277-311 (the re-fetch-`version.txt`-then-guess-URL block) with: take `state.latest_manifest.lock().unwrap().clone()`; if `Some(manifest)`, use it; if `None` (e.g. `download_and_install` invoked without a preceding `check_for_update`, or the cache was already cleared), call `fetch_manifest(&client).await?` to get one. Call `get_platform_entry(&manifest)?` and use `entry.url` as `installer_url` in place of the old `get_installer_url(latest_version)` call — the rest of the function (filename extraction from the URL, streaming download with progress events, writing to `temp_dir`) is unchanged. Immediately before the existing `launch_installer(&installer_str)` call (around old line 363), add the deferred-verification comment:

```rust
    // No checksum/signature verification here yet — deliberate, tracked gap
    // (no signing infra exists). See EPMCDME-15055 scope decision 1; a future
    // ticket adds verification of `installer_bytes` at this point, before launch.
    launch_installer(&installer_str)?;
```

Also reset `state.latest_manifest` to `None` alongside the existing `state.last_update_check` reset at the top of the function, so a stale cached manifest can't be reused across update cycles.

- [ ] **Step 3: Run the existing test suite to confirm nothing broke**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — all remaining tests (throttle, version comparison, `InstallerError`, platform-entry, and on macOS the DMG round-trip tests) still pass; no test references the deleted `get_installer_url`/`installer_url_names_the_arm64_dmg`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/app_updater.rs
git commit -m "EPMCDME-15055: use manifest platform entry in download_and_install"
```

---

### Task 4: Windows silent install — spawn the installer with `/S`

**Files:**
- Modify: `src-tauri/src/commands/app_updater.rs:14-23` (`#[cfg(target_os = "windows")] fn launch_installer`)

**Interfaces:**
- Consumes: nothing new. Produces: nothing new — same `launch_installer(installer_path: &str) -> CmdResult<()>` signature.

Test-first: no — spawning a real NSIS installer isn't exercisable by `cargo test` (per `technical-analysis.md` §4/§6: no harness exists for the Windows spawn path); this is a one-line flag addition verified by the repo's existing manual/smoke convention (AC 19).

- [ ] **Step 1: Add the `/S` flag**

In `src-tauri/src/commands/app_updater.rs:18-20`, change:

```rust
    Command::new(installer_path)
        .spawn()
```

to pass `/S` so NSIS runs with no UI:

```rust
    Command::new(installer_path)
        .arg("/S")
        .spawn()
```

- [ ] **Step 2: Run the existing test suite to confirm nothing broke**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (this function has no existing unit test — it spawns a real process — so this step only confirms the crate still compiles and every other test is unaffected).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/app_updater.rs
git commit -m "EPMCDME-15055: spawn Windows installer silently with /S"
```

---

### Task 5: NSIS pre-install hook — silently uninstall the prior version

**Files:**
- Modify: `src-tauri/installer-hooks.nsi:1-18` (add a new hook macro)

**Interfaces:**
- Produces: `NSIS_HOOK_PREINSTALL` macro — Tauri's NSIS template (via `tauri.conf.json`'s `bundle.windows.nsis.installerHooks`) invokes this macro automatically before install proceeds, the same way it already invokes `NSIS_HOOK_POSTINSTALL`/`NSIS_HOOK_POSTUNINSTALL` from this same file. No other file needs to reference it.

Test-first: no — NSIS scripts have no test harness in this repo (`technical-analysis.md` §4/§6: "not unit-testable with `cargo test`/`node --test`... only manual verification (AC 19) applies"). Verified on a real Windows install-then-upgrade smoke run, not by this plan's task-level check.

- [ ] **Step 1: Add the pre-install hook**

Append to `src-tauri/installer-hooks.nsi` (after the existing `NSIS_HOOK_POSTUNINSTALL` macro, line 17):

```nsis
!macro NSIS_HOOK_PREINSTALL
  ; Silently uninstall a prior install (if any) before proceeding, so nothing
  ; is left registered to trigger the NSIS "Already Installed" dialog.
  ; SHCTX resolves to the hive matching this app's installMode ("currentUser"
  ; -> HKCU). PRODUCTNAME is Tauri's default uninstall registry subkey name;
  ; confirm the exact key/hive against a real built installer during the
  ; manual Windows install-then-upgrade smoke verification (no NSIS test
  ; harness exists in this repo to check it automatically).
  ReadRegStr $0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "UninstallString"
  StrCmp $0 "" done
  ExecWait '$0 /S'
  done:
!macroend
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/installer-hooks.nsi
git commit -m "EPMCDME-15055: silently uninstall prior version before NSIS install"
```

---

## Self-review

**Coverage:** every acceptance-criteria line above maps to a task — manifest fetch/parse (Task 1), single-fetch-reused-across-both-commands (Tasks 2–3), platform-key correctness for all three keys (Task 1's tests, consumed by Tasks 2–3), Windows `/S` (Task 4), NSIS silent pre-uninstall (Task 5), macOS mechanism untouched (Task 3 only swaps the URL source, `install_app_from_dmg`/`replace_app_bundle`/`launch_installer` macOS branch are not modified by any task), no verification scaffolding (Task 3's comment only).

**Negative constraints:** re-scanned against the requirements' scope decisions — (1) no verification code anywhere in this plan, only the Task 3 comment; no task adds a checksum/signature dependency or scaffold. (3) no task modifies `install_app_from_dmg`, `replace_app_bundle`, `app_bundle_of`, or the macOS branch of `launch_installer` — Task 3 only changes where `installer_url` comes from before it's passed in, same as today. No task touches `sign-dmg.sh`, the JS-side `localStorage` throttle, or introduces `tauri-plugin-updater`. No task runs a whole-suite quality gate, manual/browser verification, code review, or a separate commit-only task — each implementation task's own `cargo test` step is scoped to that task's change, and Tasks 4–5 explicitly defer real verification to the calling flow's existing manual/smoke convention rather than fabricating an automated check that can't exist.
