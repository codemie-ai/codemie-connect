# Spec: Windows Bundled Node.js Shim, Runtime Wiring, and PATH Registration

**Ticket**: EPMCDME-14573
**Branch**: spike/EPMCDME-14504-pkg-binary (current), target: feature branch off codemie-desktop
**Date**: 2026-09-01

---

## Goal

Enable `codemie --version` and `codemie install [agent]` on a clean Windows user account with no
system Node.js or npm, using a portable Node.js runtime bundled inside the NSIS installer and a
`.cmd` shim script registered on per-user PATH. Five layers must be consistent: the shim script,
the NSIS bundle resources, the startup PATH probe, the runner shell dispatch, and the wizard step
configuration.

## Background

The EPMCDME-14504 spike established the portable-Node shim approach and merged
`inject_bundled_bin_path` to main. The Windows probe (pathman.rs:252–293) still looks for a
`.exe` binary (pkg approach) — it finds nothing on the shim approach, silently skipping PATH
injection. The runner (runner.rs:38–43) still dispatches through PowerShell, which cannot treat
`.cmd` files the same way `cmd.exe` can. The NSIS installer has no `bundle.resources` section.
The `install_node` msiexec path in installer.rs is dead weight. This ticket closes all five gaps.

**Product name**: `tauri.conf.json:productName` is `"CodeMie Connect"`. NSIS
`installMode: "currentUser"` installs to `%LOCALAPPDATA%\Programs\CodeMie Connect\`. The ticket
text uses "CodeMie Desktop" — that is incorrect. All paths use the actual product name, or
`%~dp0`-relative addressing where product-name independence is needed.

---

## Design

### 1. Shim Script — `bin\codemie.cmd`

A static batch file delivered by the NSIS installer to `bin\codemie.cmd` inside the install root.
Content is fixed (see below); it uses `%~dp0..` for `BUNDLE_DIR` so the script is correct
regardless of the install root path and will not need updating if the product name changes.

```bat
@echo off
set BUNDLE_DIR=%~dp0..
"%BUNDLE_DIR%\node\node.exe" "%BUNDLE_DIR%\cli\node_modules\@codemieai\code\dist\index.js" %*
```

The file is committed to the repo (e.g., `assets/windows/bin/codemie.cmd`) and declared in
`bundle.resources` as a build-time source.

### 2. NSIS Bundle Resources — `tauri.conf.json`

Add a `bundle.resources` array to `tauri.conf.json` (Windows-scoped). The **target** layout
inside the installed application directory must be:

| Target path (relative to install root) | Content |
|---|---|
| `bin\codemie.cmd` | The shim script |
| `node\node.exe` | Windows portable Node.js binary |
| `cli\node_modules\@codemieai\code\dist\index.js` | CLI entry point |
| `cli\node_modules\...` (rest of tree) | CLI runtime dependencies |

The `src` side of each `bundle.resources` entry — where these files live in the repo during build —
is a staging concern coordinated with EPMCDME-14505. The spec fixes the target layout; EPMCDME-14505
fixes source preparation.

### 3. `pathman.rs` — Probe Update

`inject_bundled_bin_path` (pathman.rs:252–293) Windows probe currently checks for
`codemie-<ARCH>-pc-windows-msvc.exe`, `codemie`, and `codemie.exe`. Add `codemie.cmd` to the
candidate filename list. When the probe finds `codemie.cmd` in a candidate directory, it treats
that directory as the shim `bin\` directory, prepends it to the process PATH via `unsafe set_var`
(called before any thread starts, as required by the existing safety comment), and calls `persist()`
with that directory to write `HKCU\Environment` and broadcast `WM_SETTINGCHANGE`.

No change to the system-directory fallback list or the macOS branch.

Add a `#[cfg(all(test, windows))]` test that constructs a temp directory containing a
`codemie.cmd` file and asserts the probe detects it.

### 4. `runner.rs` — Shell Dispatch and CLI Wiring

Two independent changes, both gated `#[cfg(windows)]`:

**a. General shell dispatch** (runner.rs:38–43): Change the Windows branch of `shell_cmd` from
`powershell.exe -NoProfile -NonInteractive -Command <cmd>` to `cmd.exe /c <cmd>`. This makes
`.cmd` files findable via PATH for all general-purpose commands routed through `capture()`,
`run_capture`, `run_stream`, and `run_fresh_env`. The function signature `shell_cmd(cmd_str: &str)`
is unchanged.

**b. CodeMie CLI absolute-path invocation**: Add two `#[cfg(windows)]` fields to `AppState`:
`node_exe_path: PathBuf` and `cli_entry_path: PathBuf`, populated in the `lib.rs` setup closure
from `app_handle.path().resource_dir()` (Tauri v2 API, confirmed at pathman.rs:274). Any runner
function that invokes the CodeMie CLI — specifically `run_self_update` (runner.rs:144) — builds a
`Command` from `node_exe_path` with arguments `[cli_entry_path, user_args...]` directly, bypassing
`shell_cmd`. This satisfies the acceptance criterion "invokes CLI via absolute resource path, not
through PowerShell PATH."

`shell_cmd` remains a free function with no `AppHandle` parameter. The AppState fields are
populated before any thread starts, consistent with the `unsafe set_var` safety contract already
established in the codebase.

Replace the existing Windows test `run_capture_runs_via_powershell_and_captures_stdout`
(runner.rs:181) with a `cmd.exe /c echo` equivalent that verifies `cmd.exe /c` dispatch and exit
code propagation.

### 5. `installer.rs` and `lib.rs` — Removal

Delete in a single change:
- `install_node` Windows branch (installer.rs:199–208)
- `node_pkg_url` Windows variant (installer.rs:188–196)
- The `node_pkg_url` Windows MSI URL test
- `install_node` entry in `invoke_handler!` (lib.rs:50)

All four must be removed together. Leaving `install_node` in `invoke_handler!` causes a compile
error. Leaving `node_pkg_url` produces a `dead_code` clippy warning on Windows builds.

### 6. `config/steps.yaml` — Wizard Steps

Remove steps 1.2 (`Check Node.js & npm`, `fatal: true`) and 1.2.1 (`Install Node.js`,
`is_sub_step: true`, `requires_approval: true`). Update step 1.3 `approval_message` and
`fatal_recommendation` strings to remove npm references and reflect the bundled approach.
Coordinate timing with EPMCDME-14505.

### 7. `ui/handlers.js` — Handler Cleanup

Remove the step 1.2 handler (handlers.js:109–150): the `checkNode`/`checkNpm`/`installNode`
orchestration is dead once step 1.2 is gone from `steps.yaml`.

Remove Windows-specific npm PATH discovery in the step 1.3 handler (handlers.js:181–188). The
step 1.3 `checkCodemie()` early-exit is the primary success path on Windows once the shim
directory is on PATH via `inject_bundled_bin_path`. No replacement npm install logic is needed.

---

## Acceptance Criteria

- `codemie --version` exits 0 on a clean Windows user account with no system Node.js or npm installed
- `codemie install [agent]` completes end-to-end using only the runtime bundled in the installer
- A pre-existing system Node.js installation is unmodified after CodeMie Connect is installed
- No UAC credential prompt appears at any point during installation or first run
- The PATH addition is written exclusively to `HKCU\Environment` (not HKLM or any system-wide key)
- `runner.rs` builds codemie invocations from absolute `node_exe_path` and `cli_entry_path` values
  stored in `AppState`, not via PowerShell PATH lookup
- `cargo build` and `cargo clippy -- -D warnings` pass with no new warnings on Windows
- `cargo test` passes; the PowerShell runner test is replaced, not merely deleted

---

## Non-Goals

- macOS paths, files, or tests (covered by EPMCDME-14503)
- App code-signing or notarization (EPMCDME-14508)
- NSIS installer packaging automation or CI pipeline changes (EPMCDME-14505)
- Changing `pty.rs` Windows shell from PowerShell
- Any UI or wizard design changes beyond removing the Node.js install step
- Verifying shim file contents post-install via automated test (manual VM validation is the gate)
- Changing `installMode`, `productName`, or any other NSIS configuration beyond `bundle.resources`
- Handling the case where `resource_dir()` returns an error during setup (log and continue; the
  shim is still findable via PATH injection if the directory is correct)

---

## Open Risks

- **EPMCDME-14505 staging dependency**: if node runtime and CLI tree are not staged in the
  expected `src` locations before `cargo tauri build`, the NSIS installer produces a bundle with
  no runtime and the shim script cannot function. The build must fail loudly rather than silently
  omitting resources.
- **`pty.rs` consistency gap**: the Windows PTY builder (pty.rs:63–74) still spawns
  `powershell.exe`. Current wizard steps use `spawn_external_ps`, not the PTY on Windows, so this
  is not a runtime problem today — but it is an inconsistency that will need resolution before any
  interactive PTY steps are added for Windows.
- **Manual-only acceptance gate**: no CI pipeline exists. Full acceptance requires running the
  NSIS installer on a clean Windows VM with no system Node.js. The Rust unit tests and JS tests
  cover the surrounding logic but cannot exercise the end-to-end install path.
