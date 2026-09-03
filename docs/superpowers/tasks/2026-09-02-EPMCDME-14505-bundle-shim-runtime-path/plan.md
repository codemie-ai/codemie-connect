# EPMCDME-14505 — Per-user install, uninstall, and existing-CLI handshake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the admin-elevated Git/Node/CLI acquisition flow, guard downloads with a SHA-256/truncation check, and expose a typed IPC command reporting whether a global npm CodeMie is present and which installation takes PATH precedence.

**Architecture:** Three atomic clusters executed in sequence. Cluster 1 deletes the acquisition flow from six synchronization layers in a single commit that must not be split — any layer omitted breaks the build or leaves a dead UI state. Cluster 2 adds `verify_download` to `downloader.rs` (new `sha2` dep, no signature change to `download_file`). Cluster 3 creates `handshake.rs` with a pure `detect_handshake_state` testable fn and a registered Tauri IPC command; pre-injection PATH is captured in setup and stored in `AppState` before `inject_bundled_bin_path` runs.

**Tech Stack:** Rust 1.77+ (Tauri 2, tokio, reqwest, sha2 0.10), vanilla JS (Tauri invoke), YAML step plans compiled via `include_str!`

**Spec:** docs/superpowers/tasks/2026-09-02-EPMCDME-14505-bundle-shim-runtime-path/spec.md

## Global Constraints

- `sha2 = "0.10"` must be added to `src-tauri/Cargo.toml` — not currently present.
- `inject_bundled_bin_path` (`pathman.rs:296`) already runs in `lib.rs` setup before any IPC command fires; PATH has the bundled dir prepended by the time commands execute.
- Handshake card UI rendering is deferred to S12/EPMCDME-14515 — this ticket delivers the IPC contract and detection logic only.
- Hash manifest delivery is S5 responsibility; `verify_download` is called with `expected_hash: None` throughout this ticket.
- Do not touch bundled runtime acquisition, packaging, or PATH injection (EPMCDME-14573).
- Do not add any step outside the six deletion layers listed in Cluster 1.
- Commit per task using the repository's existing conventional commit convention.

---

### Task 1 — Six-layer acquisition flow deletion

**Test-first: yes — rewrite `steps.rs:100-108` `loads_eight_steps_with_defaults` to assert `["2.3.3", "2.3.5", "2.4"]` and `steps.rs:112-123` `loads_nine_steps_with_defaults` to assert `["2.3.3", "2.3.5", "2.4"]`; both fail until the YAML files are trimmed.**

**Files:**
- Modify: `src-tauri/src/steps.rs:94-145` — rewrite `#[cfg(test)]` block
- Modify: `config/steps.yaml` — delete steps 1.1, 1.1.1, 1.3
- Modify: `config/steps-windows.yaml` — delete steps 1.0, 1.1, 1.1.1, 1.2, 1.2.1, 1.3
- Modify: `src-tauri/src/commands/installer.rs` — delete functions + unit tests (details below)
- Modify: `src-tauri/src/commands/error.rs:13-15` — delete `InstallerError::Sudo`
- Modify: `src-tauri/src/lib.rs:85-91` — deregister three commands from invoke_handler
- Modify: `ui/handlers.js:78-142` — delete handlers `'1.1'`, `'1.1.1'`, `'1.3'`
- Modify: `ui/runner-bridge.js:53-68` — remove three exports from installer object
- Modify: `ui/renderer.js:20` — remove `'1.2'`, `'1.2.1'` from `INSTALL_ONLY_IDS`

- [ ] **Step 1: Rewrite stale step-count tests** (`src-tauri/src/steps.rs:94-145`).

  - Rename `loads_eight_steps_with_defaults` → `loads_three_steps_post_deletion`. Change the asserted slice to `["2.3.3", "2.3.5", "2.4"]`.
  - Rename `loads_nine_steps_with_defaults` → `loads_three_windows_steps_post_deletion`. Change the asserted slice to `["2.3.3", "2.3.5", "2.4"]`. Remove the `1.0` policy block assertion (that step is deleted).
  - Rewrite `_assert_common_fields:125-144`: remove the `let git = steps.iter().find(|s| s.id == "1.1")` block and the `let sub = …id == "1.1.1"` block entirely. Retain only the `let setup = …id == "2.3.3"` assertion block.

- [ ] **Step 2: Confirm test failure.** Run `cargo test --lib -- steps`. Expect: 1-2 failures (step count mismatch) — this confirms the tests now drive the YAML changes.

- [ ] **Step 3: Trim YAML step files.**

  - `config/steps.yaml`: delete the entries with ids `1.1`, `1.1.1`, `1.3`. Retain `2.3.3`, `2.3.5`, `2.4` — 3 entries remain.
  - `config/steps-windows.yaml`: delete entries `1.0`, `1.1`, `1.1.1`, `1.2`, `1.2.1`, `1.3`. Retain `2.3.3`, `2.3.5`, `2.4` — 3 entries remain.

- [ ] **Step 4: Delete Rust acquisition functions** (`src-tauri/src/commands/installer.rs`).

  Delete the following blocks and their unit tests:
  - macOS-gated (`#[cfg(not(windows))]`): `node_pkg_url` (lines 102-108), `sudo_exec` (lines 111-127), `install_node` (lines 130-138).
  - Both-platform: `install_git_clt` — both the macOS variant (lines 142-181) and the Windows variant (lines 194-254).
  - Windows-gated: `download_to_file` (lines 257-288) and `GIT_WIN_URL` constant (lines 187-190).
  - In the `#[cfg(test)]` block: delete `node_pkg_url_builds_official_universal_url` and `node_pkg_url_is_arch_independent` tests. Retain `parse_npm_latest_*` tests (3 tests).
  - Remove the now-dead `#[cfg(not(windows))] use crate::error::{CmdResult, InstallerError};` import (line 10).
  - Retain: `FALLBACK_NODE_VERSION`, `PlatformInfo`, `get_platform_info`, `temp_dir`, `latest_lts_node_version`, `fetch_lts`, `parse_npm_latest`, `fetch_codemie_npm_latest`, `fetch_codemie_latest`.

- [ ] **Step 5: Prune `InstallerError::Sudo`** (`src-tauri/src/commands/error.rs:13-15`). Delete the `#[cfg(not(windows))]` `Sudo(String)` variant. Without this prune `cargo clippy -D warnings` hard-fails on a dead enum variant.

- [ ] **Step 6: Deregister from invoke_handler** (`src-tauri/src/lib.rs:85-91`). Remove these three entries from `tauri::generate_handler![]`:
  - `#[cfg(not(windows))] commands::installer::node_pkg_url`
  - `#[cfg(not(windows))] commands::installer::install_node`
  - `commands::installer::install_git_clt`

- [ ] **Step 7: Delete JS handlers** (`ui/handlers.js:78-142`). Remove:
  - The `'1.1'` handler block (lines 80-104).
  - The `'1.1.1'` no-op entry (line 106).
  - The `'1.3'` handler block (lines 108-142).
  No `'1.2'`/`'1.2.1'` handler entries exist (engine-fallback no-ops). The `handlers` object starts directly with `'2.3.3'` after this step.

- [ ] **Step 8: Remove bridge exports** (`ui/runner-bridge.js:53-68`). From the `installer` export object remove `nodePkgUrl`, `installNode`, and `installGitCLT`. Retain `latestLtsNodeVersion`. Also remove the `listen` import from the `installGitCLT` method if it becomes unused.

- [ ] **Step 9: Update `INSTALL_ONLY_IDS`** (`ui/renderer.js:20`). Change the array from `['1.1', '1.1.1', '1.2', '1.2.1', '1.3']` to `['1.1', '1.1.1', '1.3']` — removes `'1.2'` and `'1.2.1'` per spec. The remaining ids no longer appear in either YAML so the filter produces no steps (install-only mode is effectively dormant).

- [ ] **Step 10: Verify.** Run `cargo test --lib -- steps` — expect: pass. Run `cargo build` — expect: no compile errors. Run `cargo clippy -- -D warnings` — expect: clean. Commit all nine files together.

---

### Task 2 — Download integrity check

**Test-first: yes — write four unit tests for `verify_download` before the function exists: (a) empty slice → `Err`, (b) SHA-256 mismatch → `Err`, (c) SHA-256 match → `Ok`, (d) `None` hash with non-empty data → `Ok`. Tests live in `downloader.rs` `#[cfg(test)]` block and fail until the function is added.**

**Files:**
- Modify: `src-tauri/Cargo.toml` — add `sha2 = "0.10"` under `[dependencies]`
- Modify: `src-tauri/src/commands/downloader.rs` — add `verify_download`, refactor `download_file`

**Interfaces:**
- Produces: `pub fn verify_download(data: &[u8], expected_hash: Option<&str>) -> Result<(), InstallerError>`

- [ ] **Step 1: Add `sha2` dep.** In `Cargo.toml` under `[dependencies]` add `sha2 = "0.10"`. Run `cargo build` to confirm the dep resolves.

- [ ] **Step 2: Write four failing tests** (in `downloader.rs` `#[cfg(test)]` block):

```rust
#[test]
fn verify_rejects_empty_data() {
    assert!(verify_download(&[], None).is_err());
}
#[test]
fn verify_rejects_hash_mismatch() {
    assert!(verify_download(b"hello", Some("000000")).is_err());
}
#[test]
fn verify_accepts_correct_sha256() {
    // SHA-256("hello")
    let h = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert!(verify_download(b"hello", Some(h)).is_ok());
}
#[test]
fn verify_accepts_none_hash_nonempty() {
    assert!(verify_download(b"payload", None).is_ok());
}
```

Run `cargo test --lib -- downloader` — expect: compile error (function missing).

- [ ] **Step 3: Implement `verify_download`.** Add before `download_file`:

```rust
use sha2::{Digest, Sha256};

pub fn verify_download(data: &[u8], expected_hash: Option<&str>) -> Result<(), InstallerError> {
    if data.is_empty() {
        return Err(InstallerError::Download("downloaded file is empty".into()));
    }
    if let Some(want) = expected_hash {
        let got: String = Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect();
        if got != want {
            return Err(InstallerError::Download(format!("hash mismatch: expected {want}, got {got}")));
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Refactor `download_file`** (`downloader.rs:12-55`). Replace the streaming-to-`tokio::fs::File` body with a two-phase approach:
  1. Collect all chunks into a `Vec<u8>` buffer (keep the `done`/`total`/`fraction` progress-emit logic unchanged — emit progress as chunks arrive).
  2. After the stream ends, call `verify_download(&bytes, None)?`.
  3. On success write the buffer atomically: `tokio::fs::write(&dest, &bytes).await?`.
  Function signature stays `(app: AppHandle, url: String, dest: String, progress_id: String) -> CmdResult<String>`. Remove the `file`/`AsyncWriteExt` imports if unused after refactor.

- [ ] **Step 5: Verify.** Run `cargo test --lib -- downloader` — expect: 4 pass. Run `cargo build` — expect: clean.

---

### Task 3 — Handshake precedence detection IPC command

**Test-first: yes — write unit tests for `detect_handshake_state(path_env: &str, bundled_injected: bool, probe: &dyn Fn(&std::path::Path) -> bool) -> HandshakeState` before implementing: (a) empty path_env, bundled_injected false → global_found false, bundled_takes_precedence false; (b) path_env pointing to a dir that probe returns true for → global_found true; (c) bundled_injected true with global found → bundled_takes_precedence true.**

**Files:**
- Modify: `src-tauri/src/state.rs` — add `pre_injection_path: String` field
- Modify: `src-tauri/src/lib.rs` — capture PATH before injection, store in AppState
- Create: `src-tauri/src/commands/handshake.rs`
- Modify: `src-tauri/src/commands/mod.rs` — add `pub mod handshake;`
- Modify: `src-tauri/src/lib.rs` — register `commands::handshake::check_handshake_state`
- Modify: `ui/runner-bridge.js` — add `checkHandshakeState` to `inspector` object

**Interfaces:**
- Produces: `pub struct HandshakeState { pub global_found: bool, pub global_version: Option<String>, pub bundled_takes_precedence: bool }`
- Produces: `pub fn detect_handshake_state(path_env: &str, bundled_injected: bool, probe: &dyn Fn(&std::path::Path) -> bool) -> HandshakeState`
- Produces IPC: `check_handshake_state` → `HandshakeState` (serialized as JSON object)

- [ ] **Step 1: Extend `AppState`** (`src-tauri/src/state.rs`). Add `pub pre_injection_path: String` (no Mutex — written once in setup before any thread starts, read-only thereafter). Derive or impl `Default` so the existing `..AppState::default()` in lib.rs compiles (empty string default is correct).

- [ ] **Step 2: Capture pre-injection PATH in setup** (`src-tauri/src/lib.rs`). Before the `inject_bundled_bin_path` call (line 15), add:
  ```rust
  let pre_injection_path = std::env::var("PATH").unwrap_or_default();
  ```
  Store it in the `AppState` struct initializer alongside the existing Windows fields:
  ```rust
  app.manage(AppState {
      pre_injection_path,
      #[cfg(windows)] node_exe_path: node_exe,
      #[cfg(windows)] cli_entry_path: cli_entry,
      ..AppState::default()
  });
  ```
  Also capture whether injection succeeded:
  ```rust
  let bundled_injected = commands::pathman::inject_bundled_bin_path(app.handle()).is_ok();
  ```
  Add `bundled_injected: bool` to `AppState` (same write-once pattern). Store it alongside `pre_injection_path`.

- [ ] **Step 3: Create `handshake.rs` with failing tests.**

  New file `src-tauri/src/commands/handshake.rs`:

```rust
use serde::Serialize;
use tauri::Manager;
use crate::state::AppState;

#[derive(Serialize)]
pub struct HandshakeState {
    pub global_found: bool,
    pub global_version: Option<String>,
    pub bundled_takes_precedence: bool,
}

/// Pure, testable function. `probe` returns true when a codemie binary is
/// found at a given path; inject a closure in tests, pass a real fs check in production.
pub fn detect_handshake_state(
    path_env: &str,
    bundled_injected: bool,
    probe: &dyn Fn(&std::path::Path) -> bool,
) -> HandshakeState {
    todo!()
}

#[tauri::command]
pub async fn check_handshake_state(app: tauri::AppHandle) -> HandshakeState {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never(_: &std::path::Path) -> bool { false }
    fn always(_: &std::path::Path) -> bool { true }

    #[test]
    fn no_global_when_path_empty() {
        let s = detect_handshake_state("", false, &never);
        assert!(!s.global_found);
        assert!(!s.bundled_takes_precedence);
    }

    #[test]
    fn global_found_when_probe_matches() {
        let s = detect_handshake_state("/usr/local/bin", false, &always);
        assert!(s.global_found);
    }

    #[test]
    fn bundled_takes_precedence_when_injected_and_global_found() {
        let s = detect_handshake_state("/usr/local/bin", true, &always);
        assert!(s.bundled_takes_precedence);
    }
}
```

  Run `cargo test --lib -- handshake` — expect: compile error (todo!).

- [ ] **Step 4: Implement `detect_handshake_state`.** Split `path_env` on `std::path::MAIN_SEPARATOR` / `:` (POSIX) or `;` (Windows) into directory strings. Use `std::env::consts::OS` to pick the binary name to probe (`"codemie"` on macOS, `"codemie.exe"` or `"codemie.cmd"` on Windows). For each dir, call `probe(&std::path::Path::new(dir).join(bin_name))`; first match → `global_found = true`. For `global_version` when found: run `std::process::Command::new("codemie").arg("--version").env("PATH", path_env).output()` and extract a semver substring from stdout; `None` on failure or non-zero exit. `bundled_takes_precedence = bundled_injected && global_found` (prepend always wins if injection succeeded).

- [ ] **Step 5: Implement `check_handshake_state` command.** In the command body:
  1. Read `AppState` via `app.state::<AppState>()`.
  2. Build the real probe closure: `|p: &std::path::Path| p.exists()`.
  3. Call `detect_handshake_state(&state.pre_injection_path, state.bundled_injected, &real_probe)`.
  4. Return the result directly.

- [ ] **Step 6: Wire the module.**
  - `src-tauri/src/commands/mod.rs`: add `pub mod handshake;`.
  - `src-tauri/src/lib.rs` `tauri::generate_handler![]`: add `commands::handshake::check_handshake_state`.
  - `ui/runner-bridge.js` `inspector` object (after `checkCodemieVersion`): add `checkHandshakeState: () => invoke('check_handshake_state'),`.

- [ ] **Step 7: Verify.** Run `cargo test --lib -- handshake` — expect: 3 pass. Run `cargo build` — expect: clean.

---

### Task 4 — Windows Sandbox smoke-test automation

**Test-first: no — new PowerShell scripts; the test IS the script, validated by running it in Windows Sandbox. No prior unit to write a failing assertion against.**

**Files:**
- Create: `docs/testing/codemie-sandbox-smoke.ps1` — in-sandbox script; installs silently, verifies the app starts, creates a `.codemie` sentinel, uninstalls silently, confirms sentinel survives
- Create: `docs/testing/launch-sandbox.ps1` — host-side launcher; builds NSIS via `cargo tauri build`, writes a temp `.wsb` mapping the built installer and `docs/testing/` into the sandbox, launches `WindowsSandbox.exe`

**Covers AC:** "clean-machine install with no terminal or admin prompt" (NSIS `currentUser` mode, `/S` flag), "app starts after install", "uninstall leaves `%APPDATA%\.codemie` in place".

- [ ] **Step 1: Create `docs/testing/codemie-sandbox-smoke.ps1`.**

  This script runs automatically inside the sandbox at first logon via `LogonCommand`. Product name is `CodeMie Connect` (from `tauri.conf.json`), so the NSIS currentUser install lands at `$env:LOCALAPPDATA\Programs\CodeMie Connect\`.

  ```powershell
  # Smoke test — auto-runs inside Windows Sandbox via .wsb LogonCommand.
  # EPMCDME-14505 DoD: clean install, app starts, uninstall, %APPDATA%\.codemie preserved.
  $ErrorActionPreference = 'Stop'
  $log = "$env:USERPROFILE\Desktop\smoke-result.txt"
  function Log($m)  { Add-Content $log "[$(Get-Date -f HH:mm:ss)] $m"; Write-Host $m }
  function Fail($m) { Log "FAIL: $m"; exit 1 }

  # 1 — Find and run the installer silently (NSIS /S = silent, no UAC with currentUser)
  $exe = Get-ChildItem C:\Install -Filter '*.exe' -ErrorAction Stop |
         Sort-Object LastWriteTime -Desc | Select-Object -First 1
  if (-not $exe) { Fail "No installer found in C:\Install" }
  Log "Installing $($exe.Name) silently..."
  $r = Start-Process $exe.FullName -ArgumentList '/S' -PassThru -Wait
  if ($r.ExitCode -ne 0) { Fail "Installer exit code $($r.ExitCode)" }
  Log "PASS: installer exited 0 — no admin credential requested"

  # 2 — Verify app executable exists and the process stays alive for 10 s
  $appExe = "$env:LOCALAPPDATA\Programs\CodeMie Connect\CodeMie Connect.exe"
  if (-not (Test-Path $appExe)) { Fail "App not found at $appExe" }
  $app = Start-Process $appExe -PassThru
  Start-Sleep 10
  if (-not (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) {
      Fail "App process exited within 10 s after launch"
  }
  Log "PASS: app running (pid $($app.Id))"
  $app | Stop-Process -Force -ErrorAction SilentlyContinue

  # 3 — Create .codemie sentinel so we can assert it survives the uninstaller
  $codemieDir = "$env:APPDATA\.codemie"
  New-Item $codemieDir -ItemType Directory -Force | Out-Null
  "smoke" | Set-Content "$codemieDir\sentinel.txt"
  Log "Sentinel created at $codemieDir\sentinel.txt"

  # 4 — Uninstall silently
  $uninst = "$env:LOCALAPPDATA\Programs\CodeMie Connect\uninstall.exe"
  if (-not (Test-Path $uninst)) { Fail "Uninstaller not found at $uninst" }
  $u = Start-Process $uninst -ArgumentList '/S' -PassThru -Wait
  if ($u.ExitCode -ne 0) { Fail "Uninstaller exit code $($u.ExitCode)" }
  Log "PASS: uninstaller exited 0"

  # 5 — Confirm .codemie was not removed by the uninstaller
  if (-not (Test-Path "$codemieDir\sentinel.txt")) {
      Fail "$codemieDir was removed by the uninstaller — AC violated"
  }
  Log "PASS: $codemieDir preserved after uninstall"
  Log "ALL PASS"
  ```

- [ ] **Step 2: Create `docs/testing/launch-sandbox.ps1`.**

  Host-side launcher. Builds the NSIS installer, generates a temp `.wsb` with the correct absolute paths, then opens Windows Sandbox.

  ```powershell
  # Builds the NSIS installer and launches Windows Sandbox with the smoke test.
  # Prereqs: cargo + tauri-cli installed; Windows Sandbox feature enabled (optionalfeatures.exe).
  param([string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..\.." -ErrorAction Stop).Path)
  $ErrorActionPreference = 'Stop'

  # 1 — Build NSIS installer
  Write-Host "Building NSIS installer (cargo tauri build)..."
  Push-Location "$RepoRoot\src-tauri"
  $env:CI = 'true'
  cargo tauri build 2>&1 | Tee-Object -FilePath "$env:TEMP\tauri-build.log"
  Pop-Location

  # 2 — Locate the installer
  $nsisDir = "$RepoRoot\src-tauri\target\release\bundle\nsis"
  $installer = Get-ChildItem $nsisDir -Filter '*_x64-setup.exe' |
               Sort-Object LastWriteTime -Desc | Select-Object -First 1
  if (-not $installer) { Write-Error "NSIS installer not found in $nsisDir"; exit 1 }
  Write-Host "Found: $($installer.FullName)"

  # 3 — Write temp .wsb with resolved absolute paths
  $scriptsDir = "$RepoRoot\docs\testing"
  $wsb = @"
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$($installer.DirectoryName)</HostFolder>
      <SandboxFolder>C:\Install</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$scriptsDir</HostFolder>
      <SandboxFolder>C:\Scripts</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell -ExecutionPolicy Bypass -File C:\Scripts\codemie-sandbox-smoke.ps1</Command>
  </LogonCommand>
</Configuration>
"@
  $wsbPath = "$env:TEMP\codemie-smoke-$(Get-Date -f yyyyMMddHHmmss).wsb"
  $wsb | Set-Content $wsbPath -Encoding UTF8
  Write-Host "Sandbox config written to $wsbPath"

  # 4 — Launch Windows Sandbox
  Start-Process "$env:SystemRoot\System32\WindowsSandbox.exe" -ArgumentList $wsbPath
  Write-Host "Sandbox launched. Read smoke-result.txt on the sandbox desktop when it completes."
  ```

- [ ] **Step 3: Verify.**

  From the repo root in PowerShell:
  ```powershell
  .\docs\testing\launch-sandbox.ps1
  ```
  Windows Sandbox opens, the smoke script runs automatically at logon. When the desktop appears, open `smoke-result.txt` — all entries must end with `PASS` and the last line must read `ALL PASS`. If any line reads `FAIL`, the failure message identifies which AC was violated.

---

## Self-review

**Spec coverage:**
- Cluster 1: six-layer deletion in Task 1 (YAML × 2, installer.rs, lib.rs, handlers.js, runner-bridge.js), InstallerError::Sudo prune (step 5), INSTALL_ONLY_IDS (step 9), steps.rs test rewrite (step 1).
- Cluster 2: `verify_download` in Task 2 — empty guard, hash mismatch, hash match, None-hash pass; called in `download_file`.
- Cluster 3: `HandshakeState`, `detect_handshake_state`, `check_handshake_state` in Task 3; registered in lib.rs and runner-bridge.js.
- `installer.rs` tests for deleted functions removed; `parse_npm_latest` tests retained: Task 1 step 4.
- `steps.rs` test rewrite for post-deletion counts: Task 1 step 1.
- `sha2` added to Cargo.toml: Task 2 step 1.
- NSIS uninstall leaves `~/.codemie` in place: Task 4 (Windows Sandbox smoke test, previously unverifiable from this repo).

**Negative-constraint pass:**
- "Must NOT touch bundled runtime acquisition/packaging/PATH injection": no task touches `tauri.conf.json`, `pathman.rs` inject logic, or bundled sidecar resources.
- "Must NOT render handshake card UI": Task 3 only adds an invoke wrapper in runner-bridge.js; no renderer.js UI changes beyond INSTALL_ONLY_IDS in Task 1.
- "Must NOT touch ~/.codemie content (profile management)": Tasks 1-3 contain no `.codemie` reads or writes. Task 4's smoke script creates a sentinel in `$env:APPDATA\.codemie` to assert the uninstaller leaves it intact — this is test infrastructure inside Windows Sandbox, not production code, and does not violate the profile-management non-goal.
- "Must NOT implement auto-migration": no migration logic anywhere in the plan.
- "Must NOT change uninstaller behavior": no NSIS or tauri.conf.json uninstall changes. Task 4 verifies (not changes) uninstaller behavior.
- "Must NOT deliver hash manifests or signing": `verify_download` called with `None` throughout; no manifest fetch or storage.
- "Must NOT change steps outside the six deletion layers": Task 1 deletes exactly the listed layers; no other step files touched.
- negative-constraints: all Non-goals from spec checked — none violated by any task.
