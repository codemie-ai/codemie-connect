# Technical Research

**Task**: windows installer runner pathman bundled-node
**Generated**: 2026-09-01T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

CodeMie Desktop T4 — Windows: bundled Node.js shim, runtime wiring, and PATH registration (EPMCDME-14573).

FULL TICKET DESCRIPTION:
Windows-specific integration for S1 (EPMCDME-14504): write the codemie.cmd shim, confirm runtime placement in the NSIS installer output, change runner.rs to invoke the CLI by absolute path, and register the shim directory in HKCU\\Environment. On a clean Windows user account after this ticket, codemie --version and codemie install [agent] work with no system Node.js present.

Scope:
1. Shim script — Write codemie.cmd at %LOCALAPPDATA%\Programs\CodeMie Desktop\bin\codemie.cmd:
   @echo off
   set BUNDLE_DIR=%~dp0..
   \"%BUNDLE_DIR%\\node\\node.exe\" \"%BUNDLE_DIR%\\cli\\node_modules\\@codemieai\\code\\dist\\index.js\" %*

2. Runner absolute-path wiring — Change runner.rs Windows branch to resolve CLI path from tauri::api::path::resource_dir() and invoke directly. No more powershell.exe -Command codemie.

3. PATH registration — Call existing Windows persist() Tauri command to write HKCU\\Environment and broadcast WM_SETTINGCHANGE.

4. Remove old admin-elevated Node install path — Delete install_node (Windows branch) in installer.rs and steps 1.2 / 1.2.1 in config/steps.yaml.

Current state:
- src-tauri/src/commands/pathman.rs already implements per-user PATH persistence on Windows via persist() — REUSE this.
- src-tauri/src/commands/installer.rs:198-208 — current install_node on Windows runs msiexec. Delete this once bundled runtime is in place.
- runner.rs currently builds Windows commands as powershell.exe -NoProfile -NonInteractive -Command codemie — must change to absolute path.

Acceptance Criteria:
- codemie --version works on clean Windows user account (no Node, no npm).
- codemie install [agent] completes using only bundled runtime.
- Existing system Node.js is unchanged.
- No UAC credential prompt appears.
- PATH change scoped to HKCU\\Environment.
- runner.rs invokes CLI via absolute resource path, not through PowerShell PATH.

Additional context: The user also wants to reference MR#11 from https://gitbud.epam.com/epm-cdme/codemie-claude-installer-macos/-/merge_requests/11 for how to build the installer. Check docs/codemie/ and docs/superpowers/tasks/2026-08-31-EPMCDME-14504-spike-pkg-binary/ for existing spike documentation about the build approach.

---

## 2. Codebase Findings

### Existing Implementations

**runner.rs — `src-tauri/src/commands/runner.rs`**

- `shell_cmd(cmd_str: &str) -> Command` (line 30) — platform-gated. macOS: `/bin/zsh -lc`. Windows (lines 38–43): `powershell.exe -NoProfile -NonInteractive -Command <cmd_str>`. This is the function the ticket requires to change on Windows.
- `capture()`, `run_capture`, `run_stream`, `run_fresh_env`, `run_self_update` — all delegate to `shell_cmd`. Changing `shell_cmd` changes every invocation.
- `run_self_update` (line 144) calls `capture("codemie self-update", None)` — one of the commands that will be affected by the runner change.
- The function signature `shell_cmd(cmd_str: &str)` takes no `AppHandle`, so it cannot call `app.path().resource_dir()` directly. Any absolute-path resolution must be threaded in from outside or stored in `AppState`.
- Windows test module `tests_windows` (lines 177–193) tests `capture` via PowerShell; will need updating if the Windows shell changes to `cmd.exe`.

**pathman.rs — `src-tauri/src/commands/pathman.rs`**

- `persist()` — two platform-gated variants:
  - macOS (lines 151–171): appends `export PATH=…` to `~/.zprofile`.
  - Windows (lines 174–193): opens `HKCU\Environment` via `winreg`, appends missing entries, then calls `broadcast_env_change()`.
- `broadcast_env_change()` (lines 197–228): sends `WM_SETTINGCHANGE` via `SendMessageTimeoutW` with a 5 s abort-if-hung timeout. No extra crate needed — uses an `extern "system"` block.
- `persist_to_zprofile` Tauri command (line 233): calls `persist()` unconditionally. On Windows this writes to the registry, despite the misleading name. Already registered in `lib.rs` and exposed via `runner-bridge.js` as `pathman.persistToZprofile`.
- `inject_bundled_bin_path(app: &tauri::AppHandle) -> Result<(), String>` (lines 252–293): already implemented and called from `lib.rs:15`. Windows variant looks for `codemie-<ARCH>-pc-windows-msvc.exe` (the pkg binary from the spike). Probe also checks for `codemie` and `codemie.exe` but **not `codemie.cmd`**. On the shim approach, `codemie.cmd` is the file that exists — so the current probe would fail to detect the shim directory and PATH injection would silently do nothing on Windows.
- `candidate_dirs()` Windows variant (lines 35–43) includes `C:\Program Files\nodejs` and `%USERPROFILE%\AppData\Roaming\npm` — both irrelevant once system Node is removed.

**installer.rs — `src-tauri/src/commands/installer.rs`**

- `install_node` Windows branch (lines 199–208): runs `msiexec /i <pkg_path> /quiet /norestart`. The ticket requires deleting this function.
- `node_pkg_url` Windows variant (lines 188–196): builds the `.msi` download URL. Used only by `handlers.js` step 1.2.1. If step 1.2.1 is removed from `steps.yaml`, this command becomes dead code; the ticket should delete or comment it.
- `latest_lts_node_version`, `fetch_codemie_latest`, `temp_dir`, `get_platform_info` — all shared between platforms and untouched by this ticket.

**lib.rs — `src-tauri/src/lib.rs`**

- Setup closure (lines 12–28): calls `apply_resolved_shell_path()` then `inject_bundled_bin_path(app.handle())`. The `inject_bundled_bin_path` call is already present from the spike work (commit `9d21d30`/`ab589fe`). On Windows it will find no sidecar until the probe is updated to detect `codemie.cmd`.
- `invoke_handler!` registration (lines 29–65): `install_node` is registered at line 50. Must be removed if `install_node` is deleted.

**config/steps.yaml**

- Steps 1.2 (`Check Node.js & npm`, `fatal: true`) and 1.2.1 (`Install Node.js`, `is_sub_step: true`, `requires_approval: true`) are present. Deleting them removes both the wizard step and the approval gate. Step 1.3 (`Install CodeMie`, `requires_approval: true`) references npm in its `approval_message` and `fatal_recommendation` — both strings need updating for the bundled approach.

**tauri.conf.json — `src-tauri/tauri.conf.json`**

- `bundle.targets: ["dmg", "nsis"]` — NSIS is already the Windows bundler.
- `bundle.windows.nsis.installMode: "currentUser"` — installs to `%LOCALAPPDATA%\Programs\<productName>\`.
- `productName: "CodeMie Connect"` — so the install root on Windows is `%LOCALAPPDATA%\Programs\CodeMie Connect\`. **The ticket's shim path uses "CodeMie Desktop"; this is a discrepancy** — the actual install path is determined by `productName`, not by a hardcoded name in the shim. The shim uses `%~dp0..` (parent of the `bin\` dir) so `BUNDLE_DIR` resolves correctly regardless of the product name, but the expected full path differs from what the ticket states.
- **No `bundle.resources` section exists.** Bundling `node\node.exe`, `cli\` tree, and `bin\codemie.cmd` into the NSIS installer requires adding `bundle.resources` (or a custom NSIS script). This is the largest missing infrastructure item.

**ui/handlers.js**

- Step 1.2 handler (lines 109–150): calls `inspector.checkNode()`, `inspector.checkNpm()`, then downloads and runs `msiexec` via `installer.installNode`. The ticket requires this to be removed or short-circuited.
- Step 1.3 handler (lines 155–198): calls `inspector.checkCodemie()` first (early-exit if found), then falls through to `runner.runStream('npm install -g @codemieai/code', …)`. Windows-specific PATH discovery at lines 181–188 also needs removal once npm install is gone.
- `rememberDirs(dirs)` (lines 31–44): calls `pathman.augmentProcessPath` (in-process) and `pathman.persistToZprofile` (registry on Windows). The `persistToZprofile` call already handles registry writes correctly. The question is what directory to pass for the bundled shim.

**ui/runner-bridge.js**

- `pathman.persistToZprofile(entries)` (line 70): invokes `persist_to_zprofile` which on Windows calls the registry `persist()`. No changes required here.
- No `resourceDir` or path-resolution helper is exposed to JS via IPC. If the runner absolute-path change needs the resource dir in JS, a new `get_resource_dir` command would be needed — but the ticket scopes the absolute-path change to Rust (`runner.rs`).

**assets/bin/**

Present on disk (excluded from git by `.gitignore`):
- `codemie-aarch64-apple-darwin` — macOS pkg binary from the spike (165 MB)
- `codemie-x86_64-pc-windows-msvc.exe` — Windows pkg binary from the spike (163 MB)
- `node-x86_64-pc-windows-msvc.exe` — Windows Node.js binary from prior spike work

These are spike artifacts. The Windows shim approach in this ticket uses `node.exe` + JS tree, not the pkg binary.

### Architecture and Layers Affected

| Layer | File | Change required |
|---|---|---|
| Shell exec | `src-tauri/src/commands/runner.rs:38–43` | Replace PowerShell branch with `cmd.exe /c` or direct node invocation |
| PATH injection (process) | `src-tauri/src/commands/pathman.rs:252–293` | Extend probe to detect `codemie.cmd` in addition to `.exe` |
| PATH injection (persistent) | `src-tauri/src/commands/pathman.rs:174–193` | Already correct — `persist()` writes `HKCU\Environment`; needs to be called with the shim `bin\` directory |
| Installer cleanup | `src-tauri/src/commands/installer.rs:199–208` | Delete Windows `install_node` function |
| Command registration | `src-tauri/src/lib.rs:50` | Remove `install_node` from `invoke_handler!` |
| Step config | `config/steps.yaml` | Remove steps 1.2 and 1.2.1; update step 1.3 strings |
| JS orchestration | `ui/handlers.js:109–198` | Short-circuit or remove steps 1.2 / 1.2.1 handlers; replace npm install in 1.3 |
| Tauri bundle config | `src-tauri/tauri.conf.json` | Add `bundle.resources` for Windows (node runtime, CLI tree, codemie.cmd) |

The engine (`engine.js`), models, terminal, renderer, and all macOS handler paths are unaffected.

### Integration Points

- `shell_cmd` → all five runner commands (`run_capture`, `run_stream`, `run_fresh_env`, `run_self_update`, and internally `capture()`). Any change to the Windows `shell_cmd` branch affects every command invoked from `handlers.js` and `runner-bridge.js`.
- `inject_bundled_bin_path` → called from `lib.rs` setup before any plugin or thread starts. Its result (or failure) silently determines whether the shim is on PATH for all subsequent runner and PTY invocations.
- `pty.rs` Windows builder (lines 63–74): spawns `powershell.exe -NoProfile -Command`. If the runner changes from PowerShell to `cmd.exe`, consistency requires the same change in `pty.rs`. The PTY is used for interactive steps 2.3.3 and 2.3.5 — on Windows these already use `spawn_external_ps` not the PTY, so PTY Windows shell may be irrelevant in practice.
- `handlers.js:rememberDirs` → calls `pathman.persistToZprofile` → `persist_to_zprofile` → Windows `persist()` → `HKCU\Environment` + `WM_SETTINGCHANGE`. This chain is already functional; wiring the shim `bin\` directory through it is the remaining step.
- NSIS bundle → `tauri.conf.json bundle.resources`. The node runtime, CLI JS tree, and `codemie.cmd` must be declared here for Tauri's NSIS bundler to include them. Without this, the NSIS installer ships a UI with no runtime and the shim cannot exist post-install.

### Patterns and Conventions

- Platform gating: `#[cfg(windows)]` / `#[cfg(not(windows))]` inline in the same file. No separate `windows.rs` files. Pattern confirmed across `runner.rs`, `pathman.rs`, `installer.rs`, `inspector.rs`.
- Tauri v2 path API: `app_handle.path().resource_dir()` (not the deprecated v1 `tauri::api::path::resource_dir()`). Confirmed used in `pathman.rs:274`.
- Error handling: fallible Rust commands return `CmdResult<T>` (alias for `Result<T, InstallerError>`). Non-command helpers (like `inject_bundled_bin_path`) return `Result<(), String>`. The `InstallerError::Other(String)` variant is used for ad hoc errors.
- Unsafe `set_var`: `pathman.rs:287` uses `unsafe { std::env::set_var(...) }` with a safety comment. This must be called before any thread starts; the `setup` closure in `lib.rs` satisfies this.
- `#[cfg(test)]` inline blocks in each command module. Windows tests use `#[cfg(all(test, windows))]`. Any new Windows helper should have a corresponding test block.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — covers the full component map, IPC pattern, and command registration sequence. Confirms `setup` closure in `lib.rs` is the startup hook. Does not cover NSIS bundling or Windows shim scripting.
- `.ai-run/guides/development/development-practices.md` — error handling (`CmdResult<T>`, `InstallerError` variants), naming conventions, async patterns, `unsafe` comment expectations.
- `.ai-run/guides/testing/testing-patterns.md` — Rust inline `#[cfg(test)]` with real shell; `#[tokio::test]` for async. No mocking layer. Notes genuine install operations are never run automatically.
- `.ai-run/guides/quality-gates.md` — `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test`. All Rust commands from `src-tauri/`.

### Architectural Decisions

- **Option B (engine in JS)**: orchestration stays in frontend JS; Rust provides thin system commands. This task works within that constraint — the shim logic and PATH registration are Rust, the wizard flow changes are JS.
- **Windows PATH persistence**: `persist()` uses `HKCU\Environment` (not `HKCU\Software\Microsoft\Command Processor\Autorun` or similar). This is the correct per-user, UAC-free mechanism. `WM_SETTINGCHANGE` broadcast is already implemented.
- **NSIS `installMode: "currentUser"`**: chosen explicitly to avoid UAC (confirmed by acceptance criterion "No UAC credential prompt appears"). Install root is `%LOCALAPPDATA%\Programs\<productName>\`. The shim must use `%~dp0..` (relative) rather than a hardcoded path to be robust across product name changes.
- **Previous spike (EPMCDME-14504)**: `inject_bundled_bin_path` was implemented and hardened on the spike branch and merged to main (commits `9d21d30`, `ab589fe`). The Windows probe looks for `.exe` files but not `.cmd` — this is a gap for the shim approach.
- **`docs/superpowers/tasks/2026-06-11-windows-support/`**: documents the original Windows port. Confirms `installMode: "currentUser"` was a deliberate choice to avoid elevation. Confirms the NSIS bundler path is `%LOCALAPPDATA%\Programs\CodeMie Connect\`.

### Derived Conventions

- A Windows-only Tauri command should be gated with `#[cfg(windows)]` and its `lib.rs` registration with `#[cfg(windows)]` — pattern already used for `spawn_external_ps` at `lib.rs:55–56`.
- When removing a Tauri command, remove both the function and its `invoke_handler!` registration in `lib.rs`.
- `steps.yaml` entries map 1:1 to handlers in `handlers.js`. Removing a step from `steps.yaml` stops the wizard from running it, but the handler code in `handlers.js` can remain (it simply won't be called).
- The `bundle.resources` format in `tauri.conf.json` follows Tauri v2 convention: an array of objects `{ "src": "<path>", "target": "<dest>" }` or a glob string. Files end up in the NSIS-installed directory alongside the app binary.

---

## 4. Testing Landscape

### Existing Coverage

| Test file | What it covers |
|---|---|
| `src-tauri/src/commands/runner.rs` (inline, `#[cfg(all(test, windows))]`) | `capture()` via PowerShell; exit code propagation. Will break if `shell_cmd` Windows branch changes away from PowerShell. |
| `src-tauri/src/commands/pathman.rs` (inline, `#[cfg(windows)]`) | `dedupe_path` with `;` separator; `missing_entries` Windows paths. |
| `src-tauri/src/commands/installer.rs` (inline) | `node_pkg_url` URL building (Windows MSI URL test at line 362); `parse_npm_latest`. The `node_pkg_url` Windows test covers dead code once `install_node` is removed — should be kept unless `node_pkg_url` is also deleted. |
| `src-tauri/src/commands/inspector.rs` (inline) | Probe parsing, `parse_codemie_version`, `parse_profile_status` — all pure parsing, unaffected by this change. |
| `ui/test/engine.test.mjs` | Engine orchestration; does not cover step 1.2/1.3 handler internals. |

### Testing Framework and Patterns

- **Rust**: `cargo test`, inline `#[cfg(test)]`. Async tests use `#[tokio::test]`. Windows tests gated with `#[cfg(all(test, windows))]`. No mocking layer — tests run against the real system where the target platform is the build host.
- **JS**: `node --test` (`npm test`). `node:test` + `node:assert/strict`. No test covers handler step 1.2 or 1.3 internals.

### Coverage Gaps

- Windows `shell_cmd` after change from PowerShell to `cmd.exe`/direct: the existing `tests_windows::run_capture_runs_via_powershell_and_captures_stdout` will fail if PowerShell is removed. A replacement test exercising `cmd.exe /c` is required.
- `inject_bundled_bin_path` probe for `codemie.cmd`: no test verifies the Windows probe detects a `.cmd` shim. The probe is currently tested manually (VM validation) and is out of scope per prior spike decisions, but adding `codemie.cmd` to the probe while skipping other cases should have a unit test.
- Step 1.3 handler short-circuit: no JS test covers the bundled-binary path for step 1.3. The handlers test (`engine.test.mjs`) stubs handlers; handler internals are untested.
- `persist()` Windows registry write: no automated test for the registry path. Verified by manual inspection (confirmed by `winreg` crate usage pattern) and the existing Windows-support QA report.
- Shim script creation: `codemie.cmd` is a static file delivered via NSIS. No automated test verifies its contents post-install; manual validation is required.

---

## 5. Configuration and Environment

### Environment Variables

| Variable | File | Purpose for this task |
|---|---|---|
| `PATH` | `pathman.rs`, `runner.rs`, `pty.rs` | Process PATH modified by `inject_bundled_bin_path`; must include the shim `bin\` directory |
| `LOCALAPPDATA` | Windows standard env var | Install root for `currentUser` NSIS installs: `%LOCALAPPDATA%\Programs\CodeMie Connect\` |
| `USERPROFILE` | `pathman.rs:36`, `pty.rs:64` | Used in `candidate_dirs()` and PTY cwd; `handlers.js:182` also reads `%USERPROFILE%` for npm dirs (to be removed) |
| `HKCU\Environment\PATH` | `pathman.rs:179` | Windows registry key written by `persist()`; the target for per-user PATH registration |

### Configuration Files

- `src-tauri/tauri.conf.json` — governs NSIS bundle: `installMode: "currentUser"`, `productName: "CodeMie Connect"`. Must gain a `bundle.resources` section to include the Windows node runtime, CLI tree, and `codemie.cmd`. Currently no `resources` key exists.
- `config/steps.yaml` — embedded at compile time. Steps 1.2 and 1.2.1 must be deleted. Step 1.3 `approval_message` and `fatal_recommendation` reference npm and need updating.
- `.gitignore` — `assets/bin/` is already excluded. The node runtime and CLI JS tree for Windows bundling should also be excluded or stored via a preparation script, consistent with the spike pattern.

### Feature Flags and Deployment Concerns

- No feature flags in the codebase.
- NSIS `installMode: "currentUser"` means the install root is `%LOCALAPPDATA%\Programs\CodeMie Connect\`. Any hardcoded path in `codemie.cmd` (or in Rust code resolving the shim location) must use `%~dp0` (batch) or `resource_dir()` (Rust) rather than a literal product-name string. The ticket's example path `%LOCALAPPDATA%\Programs\CodeMie Desktop\` uses a different product name than the one in `tauri.conf.json` (`CodeMie Connect`) — a discrepancy that must be resolved before the shim is written.
- No CI/CD pipeline (`no .github/`, no `.gitlab-ci.yml`). All quality gates are manual. Windows build requires a Windows host running `cargo tauri build`.
- The Windows NSIS installer currently builds cleanly from the repo root. Adding `bundle.resources` for large directories (node runtime ~80 MB, CLI tree) will significantly increase installer size.
- `broadcast_env_change()` (pathman.rs:197) uses `SMTO_ABORTIFHUNG` with 5 s timeout and no return-value check. This is safe and matches the Windows-support implementation.

---

## 6. Risk Indicators

- **`inject_bundled_bin_path` probe does not match `codemie.cmd`**: the current Windows probe checks for `codemie-x86_64-pc-windows-msvc.exe`, `codemie`, and `codemie.exe` — none of which exist in the shim approach. On the shim approach the function will log a warning and leave PATH unchanged at startup. Every subsequent `codemie` invocation will fail with "not found." This is the highest-impact gap: the shim directory is never prepended to PATH unless the probe is updated to detect `codemie.cmd`.
- **`shell_cmd` Windows branch change affects all runner commands**: changing from `powershell.exe` to `cmd.exe /c` or direct node invocation affects every command dispatched through `capture()`, `run_capture`, `run_stream`, `run_fresh_env`, and `run_self_update`. Commands like `git --version`, `npm config get prefix`, and `echo %USERPROFILE%` all rely on the current PowerShell dispatch. A `cmd.exe /c` shell handles batch syntax and `.cmd` files but differs in variable expansion (`%VAR%` vs `$env:VAR`). The handlers.js for step 1.2 uses `echo %USERPROFILE%` which is `cmd.exe` syntax — this is consistent with switching to `cmd.exe /c`. However `run_self_update` calls `codemie self-update` which must also work via the new dispatch mechanism.
- **`shell_cmd` has no `AppHandle` access**: the ticket says to resolve the CLI path from `resource_dir()`. The function signature `fn shell_cmd(cmd_str: &str) -> Command` takes no `AppHandle`. Changing this to thread the resource dir through would require modifying all five call sites (`capture`, `run_stream`, plus two test modules). Alternatively, the absolute path to the shim binary can be stored in `AppState` during setup and injected as a `PATH` override — but `AppState` is only available in `State<AppState>`, not in a free function. The simplest approach is to change the Windows shell to `cmd.exe /c` (which finds `.cmd` files via PATH) and rely on `inject_bundled_bin_path` to have already placed the shim directory on PATH, rather than threading an absolute path through every call.
- **Product name discrepancy**: The ticket specifies the shim path as `%LOCALAPPDATA%\Programs\CodeMie Desktop\bin\codemie.cmd`, but `tauri.conf.json:productName` is `"CodeMie Connect"`. Tauri NSIS installs to `%LOCALAPPDATA%\Programs\CodeMie Connect\`. The shim uses `%~dp0..` (relative) so the content is correct, but documentation and any Rust code that builds an absolute path to the shim must use the actual product name, not "CodeMie Desktop."
- **`bundle.resources` not present**: there is no `resources` section in `tauri.conf.json`. Bundling `node\node.exe` (~80 MB), the full CLI `node_modules\` tree (~50–100 MB), and `bin\codemie.cmd` into the NSIS installer requires this section. Without it, the installed app directory contains no runtime and the shim cannot function. This is a greenfield addition with no prior pattern in the repo.
- **`install_node` registered in `invoke_handler!`**: removing the `install_node` function without removing its `invoke_handler!` entry at `lib.rs:50` causes a compile error. Both must be removed together.
- **`node_pkg_url` Windows variant**: if `install_node` is deleted, the JS handler for step 1.2.1 (which calls `installer.nodePkgUrl`) is also removed. The `node_pkg_url` Windows Rust function and its test become dead code. The ticket does not specify whether to delete `node_pkg_url` — leaving it produces a clippy `dead_code` warning on Windows builds.
- **Runner Windows tests**: `tests_windows::run_capture_runs_via_powershell_and_captures_stdout` (runner.rs:181) explicitly tests PowerShell dispatch. Changing to `cmd.exe` will break this test; a replacement is required.
- **Speculative**: The ticket's "runner.rs Windows branch to resolve CLI path from resource_dir() and invoke directly" may intend creating a Windows-specific codemie invocation path (direct `node.exe path/to/index.js`) rather than changing the general `shell_cmd` for all commands. If so, only `run_self_update` and the codemie-specific commands need the absolute-path variant, while `git --version` and other generic commands continue through `cmd.exe /c`. This interpretation is architecturally cleaner but is not clearly stated in the ticket.
- **Speculative**: The node runtime path inside the bundle (`node\node.exe` relative to install root) assumes a specific `bundle.resources` layout. Tauri v2 NSIS resource layout places files relative to the app install directory. The exact `target` path in the `bundle.resources` declaration must match what the shim script and Rust code expect.

---

## 7. Summary for Complexity Assessment

This ticket touches five distinct layers: NSIS bundle configuration (`tauri.conf.json`), Rust startup PATH injection (`pathman.rs`), Rust shell dispatch (`runner.rs`), Rust installer cleanup (`installer.rs` + `lib.rs`), and JS wizard orchestration (`handlers.js` + `steps.yaml`). The file change surface is moderate — six files with substantive edits plus the new shim file. The macOS code paths are entirely unaffected; all changes are gated with `#[cfg(windows)]` or the `isWin` JS flag. The largest greenfield addition is `bundle.resources` in `tauri.conf.json`: no prior Windows resources have been bundled, so the node runtime layout and NSIS target paths must be determined and validated without a prior pattern to follow.

The highest-complexity item is the interaction between `inject_bundled_bin_path` (probe must gain `codemie.cmd` detection), the `shell_cmd` Windows dispatch (must change from PowerShell to `cmd.exe /c` to find `.cmd` files on PATH), and the NSIS resource layout (determines where `node.exe` and the CLI live post-install). These three pieces must be consistent: if the probe finds the shim's `bin\` directory, prepends it to PATH, and `cmd.exe /c codemie --version` subsequently runs `codemie.cmd`, then `%~dp0..` in the shim must resolve to the directory containing `node\node.exe` and `cli\node_modules\`. A mismatch in any of these three coordinates produces a silent failure. The product-name discrepancy (`"CodeMie Desktop"` vs `"CodeMie Connect"`) must be resolved before any hardcoded paths are committed.

Test coverage posture is thin for the new behavior: the runner Windows tests will break with any `shell_cmd` change and must be replaced; `inject_bundled_bin_path` has no automated test for the `.cmd` probe; and the step 1.3 handler short-circuit has no JS test. The existing `cargo test` and `npm test` suites cover all surrounding logic and serve as a regression baseline. Manual validation on a clean Windows user account with no system Node.js is the primary acceptance gate, consistent with the macOS spike approach.

---

## 8. External References

**`docs/superpowers/tasks/2026-08-31-EPMCDME-14504-spike-pkg-binary/` — resolved.**

Key facts for this ticket:

- `SPIKE_RESULT.md` (Phase 2): Windows `codemie-x86_64-pc-windows-msvc.exe` was compiled successfully via `pkg … --target node22-win-x64`, exit code 0, 162.76 MB. The file exists at `assets/bin/codemie-x86_64-pc-windows-msvc.exe` (excluded from git). This is the pkg-binary approach; EPMCDME-14573 uses the shim approach instead — the pkg binary is not used by this ticket.
- `SPIKE_RESULT.md` (Phase 1): `keytar` is a guarded non-blocker — lazy `import('keytar')` inside `try/catch`; not called by `--version` or `install`. This fact is relevant if the shim approach is ever replaced with the pkg binary, but is not blocking for this ticket's shim approach.
- `technical-analysis.md` Section 2: `inject_bundled_bin_path` was ported from `spike/epmcdme-14504-bundle-node` and is already on `main` (commits `9d21d30`, `ab589fe`). The Windows probe checks for `.exe` not `.cmd`. The `pathman.rs` implementation already uses `PATH_SEP = ';'` on Windows.
- `plan.md` Task 3: implementation of `inject_bundled_bin_path` that was adopted on main. Uses `std::env::consts::ARCH` and `cfg target_os` guards at runtime (not `env!("TARGET")`).

**`docs/superpowers/tasks/2026-06-11-windows-support/` — resolved.**

- `plan.md` and `spec.md`: confirm `installMode: "currentUser"` was chosen to avoid UAC elevation. Confirm NSIS install root is `%LOCALAPPDATA%\Programs\CodeMie Connect\`. No `bundle.resources` was added during the windows-support work — there was no bundled runtime at that point.
- `technical-analysis.md`: original identification of all platform touchpoints. Confirms `powershell.exe -NoProfile -NonInteractive -Command` was the deliberate Windows runner choice at that time.

**MR#11 — `https://gitbud.epam.com/epm-cdme/codemie-claude-installer-macos/-/merge_requests/11` — unresolved: external GitLab instance, not accessible via the `gh` CLI. The closest in-repo artifact is the `docs/superpowers/tasks/2026-06-11-windows-support/` folder and commits `55df3fe` / `97e62f3` ("feat: Windows installer.") on the `feat/windows-support` branch, which are the most likely counterparts. No build-procedure facts unique to MR#11 were extractable.**
