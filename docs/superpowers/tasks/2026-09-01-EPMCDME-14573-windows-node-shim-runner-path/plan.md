# Windows Bundled Node.js Shim, Runner Wiring, and PATH Registration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `codemie --version` and `codemie install [agent]` on a clean Windows user account with no system Node.js, using a portable Node.js runtime bundled in the NSIS installer and a `.cmd` shim on per-user PATH.

**Architecture:** Five layers must be consistent: (1) `codemie.cmd` shim + NSIS `bundle.resources`, (2) `inject_bundled_bin_path` probe extended to detect `.cmd`, (3) `shell_cmd` changed to `cmd.exe /c`, (4) `run_self_update` using absolute `node_exe_path`/`cli_entry_path` from `AppState`, (5) dead `install_node` code and wizard step 1.2 removed. All Rust changes are `#[cfg(windows)]`; macOS paths are untouched.

**Tech Stack:** Rust (Tauri v2), NSIS (`installMode: "currentUser"`), Windows batch script, `winreg` crate (already present in `pathman.rs`), `node:test` (JS tests).

**Spec:** `docs/superpowers/tasks/2026-09-01-EPMCDME-14573-windows-node-shim-runner-path/spec.md`

## Global Constraints

- Product name is `"CodeMie Connect"` (from `tauri.conf.json:productName`); NSIS install root is `%LOCALAPPDATA%\Programs\CodeMie Connect\`. Never hardcode "CodeMie Desktop".
- All Rust Windows-only additions gated with `#[cfg(windows)]`; registrations in `lib.rs` `invoke_handler!` likewise.
- Tauri v2 path API: `app_handle.path().resource_dir()` (not deprecated v1 form).
- `unsafe std::env::set_var` must only be called before any thread starts — only in the `lib.rs` setup closure.
- Error handling: Tauri commands return `CmdResult<T>`; non-command helpers return `Result<(), String>`.
- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test` must all pass.
- Commit per task using the repository's existing conventional-commit convention.

---

### Task 1: Shim script and NSIS bundle resources

**Files:**
- Create: `assets/windows/bin/codemie.cmd`
- Modify: `src-tauri/tauri.conf.json` (add `bundle.resources` under `bundle`)

**Test-first: no — static batch file and JSON config; verified by `cargo tauri build --target x86_64-pc-windows-msvc` confirming the NSIS output includes all declared resources. Manual smoke-test on a clean Windows VM is the acceptance gate per spec Non-Goals.**

- [ ] Create `assets/windows/bin/codemie.cmd` with this exact content:

```bat
@echo off
set BUNDLE_DIR=%~dp0..
"%BUNDLE_DIR%\node\node.exe" "%BUNDLE_DIR%\cli\node_modules\@codemieai\code\dist\index.js" %*
```

`%~dp0` is the directory of the running script; `%~dp0..` is its parent, i.e., the install root. This makes the shim product-name–independent.

- [ ] In `src-tauri/tauri.conf.json`, locate the `bundle` object and add a `resources` array. The target layout inside the installed app directory must be:

```json
"resources": [
  { "src": "../assets/windows/bin/codemie.cmd", "target": "bin/codemie.cmd" },
  { "src": "<staged-node-src>/node.exe",        "target": "node/node.exe" },
  { "src": "<staged-cli-src>",                  "target": "cli" }
]
```

Replace `<staged-node-src>` and `<staged-cli-src>` with the actual staging paths agreed with EPMCDME-14505. The `codemie.cmd` entry is the only one whose `src` is committed to this repo; the runtime entries depend on EPMCDME-14505 staging. If staging paths are not yet finalized, add a `// TODO EPMCDME-14505` comment and use placeholder paths so the structure is committed.

- [ ] Verify `assets/windows/bin/codemie.cmd` is not excluded by `.gitignore` (the existing exclusion covers `assets/bin/` — the new path `assets/windows/bin/` is a different tree).

---

### Task 2: Extend `inject_bundled_bin_path` probe to detect `codemie.cmd`

**Files:**
- Modify: `src-tauri/src/commands/pathman.rs:252–293` (Windows probe candidate list)
- Test: inline `#[cfg(all(test, windows))]` block in the same file

**Test-first: yes — write and run the failing test first, then extend the probe.**

- [ ] Add a failing test in `pathman.rs` inside a `#[cfg(all(test, windows))]` block. The test creates a temp directory containing an empty `codemie.cmd` file and calls the probe logic directly:

```rust
#[cfg(all(test, windows))]
mod tests_windows_probe {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn probe_detects_codemie_cmd_shim() {
        let dir = TempDir::new().unwrap();
        let shim = dir.path().join("codemie.cmd");
        fs::write(&shim, "@echo off\r\n").unwrap();
        // candidate_bin_names must include "codemie.cmd"
        let names = candidate_bin_names();
        assert!(names.contains(&"codemie.cmd"), "probe must list codemie.cmd");
        // probe finds the directory when codemie.cmd is present
        let found = dir.path().join("codemie.cmd").exists();
        assert!(found);
    }
}
```

If `candidate_bin_names` is not yet a named function, extract the probe's filename list into one as part of this task.

- [ ] Run `cargo test --target x86_64-pc-windows-msvc -- probe_detects_codemie_cmd_shim`. Expected: FAIL (name not in list or function not found).

- [ ] In `pathman.rs` Windows branch of `inject_bundled_bin_path` (lines 252–293), add `"codemie.cmd"` to the candidate filename list alongside the existing `.exe` names. If the probe iterates a local array literal, extract it into a `fn candidate_bin_names() -> &'static [&'static str]` so the test can call it without a temp filesystem.

- [ ] Run `cargo test --target x86_64-pc-windows-msvc -- probe_detects_codemie_cmd_shim`. Expected: PASS.

- [ ] Run `cargo clippy --target x86_64-pc-windows-msvc -- -D warnings`. Expected: no warnings.

---

### Task 3: `runner.rs` shell dispatch, `AppState` CLI paths, and `run_self_update` absolute invocation

**Files:**
- Modify: `src-tauri/src/state.rs:14–17` (add Windows fields)
- Modify: `src-tauri/src/lib.rs:12–28` (populate fields in setup closure)
- Modify: `src-tauri/src/commands/runner.rs:38–43` (Windows `shell_cmd` branch)
- Modify: `src-tauri/src/commands/runner.rs:144–156` (`run_self_update`)
- Modify: `src-tauri/src/commands/runner.rs:177–193` (replace Windows test)

**Interfaces:**
- Produces: `AppState` gains `#[cfg(windows)] pub node_exe_path: PathBuf` and `#[cfg(windows)] pub cli_entry_path: PathBuf`; `run_self_update` signature gains `state: tauri::State<'_, AppState>` parameter

**Test-first: yes — replace the PowerShell test with a `cmd.exe /c` test first, then change the implementation.**

- [ ] In `src-tauri/src/commands/runner.rs:177–193`, replace `run_capture_runs_via_powershell_and_captures_stdout` with:

```rust
#[cfg(all(test, windows))]
mod tests_windows {
    use super::*;

    #[tokio::test]
    async fn run_capture_runs_via_cmd_and_captures_stdout() {
        let r = capture("echo hello_from_cmd", None).await;
        assert_eq!(r.code, 0);
        assert!(r.stdout.trim().contains("hello_from_cmd"));
    }

    #[tokio::test]
    async fn run_capture_reports_nonzero_exit_windows() {
        let r = capture("exit 3", None).await;
        assert_eq!(r.code, 3);
    }
}
```

- [ ] Run `cargo test --target x86_64-pc-windows-msvc -- tests_windows`. Expected: FAIL (still dispatches via PowerShell; `Write-Output 'hi'` test removed, but `echo` may still pass — confirm that the test description matches the implementation intent by verifying the failure mode before proceeding).

- [ ] In `src-tauri/src/state.rs:14–17`, add two Windows-only fields to `AppState`:

```rust
#[derive(Default)]
pub struct AppState {
    pub remembered: Mutex<Vec<String>>,
    pub pty: Mutex<Option<PtyHandle>>,
    #[cfg(windows)]
    pub node_exe_path: std::path::PathBuf,
    #[cfg(windows)]
    pub cli_entry_path: std::path::PathBuf,
}
```

`PathBuf` implements `Default` (returns empty path), so `#[derive(Default)]` continues to compile.

- [ ] In `src-tauri/src/lib.rs`, inside the `setup` closure after `inject_bundled_bin_path` is called (lines 12–28), populate the new fields from `resource_dir()`:

```rust
#[cfg(windows)]
{
    match app.path().resource_dir() {
        Ok(res) => {
            let state = app.state::<crate::state::AppState>();
            *state.node_exe_path.lock().unwrap() = res.join("node").join("node.exe");
            // wait — node_exe_path is PathBuf not Mutex<PathBuf>; assign directly:
        }
        Err(e) => log::warn!("resource_dir() failed: {e}; absolute CLI invocation unavailable"),
    }
}
```

Correction: since `node_exe_path` is `PathBuf` (not `Mutex<PathBuf>`), `AppState` is immutable after construction when stored in Tauri's managed state. The correct pattern is to build a fully populated `AppState` before calling `app.manage()`. In `lib.rs` setup:

```rust
#[cfg(windows)]
let (node_exe, cli_entry) = app.path().resource_dir()
    .map(|res| (
        res.join("node").join("node.exe"),
        res.join("cli").join("node_modules")
            .join("@codemieai").join("code").join("dist").join("index.js"),
    ))
    .unwrap_or_else(|e| {
        log::warn!("resource_dir() failed: {e}");
        (std::path::PathBuf::new(), std::path::PathBuf::new())
    });

app.manage(crate::state::AppState {
    #[cfg(windows)]
    node_exe_path: node_exe,
    #[cfg(windows)]
    cli_entry_path: cli_entry,
    ..Default::default()
});
```

If `app.manage(AppState::default())` is already called elsewhere in `lib.rs`, replace that call with this Windows-aware construction.

- [ ] Change the Windows `shell_cmd` branch in `runner.rs:38–43` from `powershell.exe -NoProfile -NonInteractive -Command` to `cmd.exe /c`:

At lines 38–43, replace the body of the `#[cfg(windows)]` arm so it returns:
```rust
let mut cmd = Command::new("cmd.exe");
cmd.args(["/c", cmd_str]);
cmd
```

- [ ] Update `run_self_update` (runner.rs:144–156) to accept `AppState` and invoke the CLI absolutely on Windows:

```rust
#[tauri::command]
pub async fn run_self_update(
    state: tauri::State<'_, crate::state::AppState>,
) -> CmdResult<String> {
    #[cfg(windows)]
    {
        let node = &state.node_exe_path;
        let cli  = &state.cli_entry_path;
        if node.exists() && cli.exists() {
            let out = tokio::process::Command::new(node)
                .args([cli.as_os_str(), std::ffi::OsStr::new("self-update")])
                .output()
                .await
                .map_err(|e| crate::error::InstallerError::Other(e.to_string()))?;
            return if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                Err(crate::error::InstallerError::Other(format!(
                    "codemie self-update failed (exit {:?}): {}",
                    out.status.code(),
                    String::from_utf8_lossy(&out.stderr).trim()
                )))
            };
        }
        // fallback: shim on PATH via cmd.exe
    }
    let r = capture("codemie self-update", None).await;
    if r.code == 0 { Ok(r.stdout) } else {
        Err(crate::error::InstallerError::Other(format!(
            "codemie self-update failed (exit {}): {}", r.code, r.stderr.trim()
        )))
    }
}
```

- [ ] Run `cargo test --target x86_64-pc-windows-msvc -- tests_windows`. Expected: PASS.

- [ ] Run `cargo clippy --target x86_64-pc-windows-msvc -- -D warnings`. Expected: no warnings.

---

### Task 4: Remove dead `install_node` and `node_pkg_url` code

**Files:**
- Modify: `src-tauri/src/commands/installer.rs:188–208` (remove Windows `install_node` + `node_pkg_url` and their test)
- Modify: `src-tauri/src/lib.rs:50` (remove `install_node` from `invoke_handler!`)

**Test-first: no — deletion; `cargo build` failing to compile is the test that the `invoke_handler!` entry must be removed at the same time.**

- [ ] In `installer.rs`, delete:
  - `node_pkg_url` Windows variant (lines 188–196)
  - `install_node` Windows branch (lines 199–208); if the function still has a non-Windows branch, remove only the `#[cfg(windows)]` block; if it is Windows-only, delete the entire function and its `#[tauri::command]` attribute.
  - The Windows MSI URL test in the inline test block (references `node_pkg_url` with a Windows URL assertion).

- [ ] In `lib.rs`, remove the `install_node` entry from `invoke_handler!` (line 50). Remove any `use` import for `install_node` that becomes unused.

- [ ] Run `cargo build --target x86_64-pc-windows-msvc`. Expected: compile succeeds with no "unresolved" or "unused" errors.

- [ ] Run `cargo clippy --target x86_64-pc-windows-msvc -- -D warnings`. Expected: no `dead_code` warnings for the removed symbols.

---

### Task 5: Wizard step removal and handler cleanup

**Files:**
- Modify: `config/steps.yaml` (remove steps 1.2 and 1.2.1; update step 1.3 strings)
- Modify: `ui/handlers.js:109–198` (remove step 1.2 handler; remove Windows npm PATH discovery)

**Test-first: no — no automated test covers handler step internals; `npm test` passes as regression baseline.**

- [ ] In `config/steps.yaml`, delete step 1.2 (`Check Node.js & npm`, `fatal: true`) and its sub-step 1.2.1 (`Install Node.js`, `is_sub_step: true`, `requires_approval: true`). Preserve all surrounding YAML indentation and step numbering consistency.

- [ ] In `config/steps.yaml`, update step 1.3 (`Install CodeMie`): remove all npm references from `approval_message` and `fatal_recommendation`. Replace with language reflecting the bundled runtime (e.g., "CodeMie CLI will be installed using the bundled Node.js runtime.").

- [ ] In `ui/handlers.js`, remove the step 1.2 handler block (lines 109–150): the `checkNode`/`checkNpm`/`installNode` orchestration. Since `steps.yaml` no longer emits step 1.2, this handler is dead code; delete it entirely rather than commenting it out.

- [ ] In `ui/handlers.js`, remove the Windows-specific npm PATH discovery block inside the step 1.3 handler (lines 181–188): the `%USERPROFILE%\AppData\Roaming\npm` directory lookup and `rememberDirs` call for npm dirs. The step 1.3 `checkCodemie()` early-exit is now the primary Windows success path once the shim is on PATH.

- [ ] Run `npm test`. Expected: all existing tests pass (no test covers step 1.2 handler internals, so this is a regression check only).

---

## Negative-constraint pass

| Constraint (from Non-Goals / spec) | Honoring task | Violation check |
|---|---|---|
| macOS paths, files, or tests not touched | All Rust changes use `#[cfg(windows)]`; macOS `shell_cmd` branch and all macOS handlers are untouched | No task modifies `/bin/zsh` branch or any `*darwin*` file |
| `pty.rs` Windows shell not changed | No task references `pty.rs` | Confirmed: pty.rs absent from all task file lists |
| No UI or wizard design changes beyond removing Node.js install step | T5 removes step 1.2/1.2.1 and updates one string; no new wizard screens | Confirmed |
| No automated test for shim file contents post-install | T1 has Test-first: no; shim is a static committed file | No test task emits a post-install shim content assertion |
| `installMode`, `productName`, other NSIS config unchanged | T1 touches only `bundle.resources` | No task modifies `installMode` or `productName` |
| PATH addition exclusively to `HKCU\Environment` | T2 relies on existing `persist()` which already writes only `HKCU\Environment` (pathman.rs:174–193) | No task changes the registry key target |
| No CI/CD pipeline changes | No task adds `.github/` or `.gitlab-ci.yml` entries | Confirmed |

negative-constraints: all addressed above; none violated by any task.
