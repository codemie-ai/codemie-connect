# Building the CodeMie Installer on Windows

The Windows bundle must be built **on a Windows machine** — it cannot be
cross-compiled from macOS (the `ring` crypto dependency needs a Windows C
toolchain, and NSIS bundling is Windows-only).

> **Phase scope:** Phase 1 produces a per-user NSIS installer (`.exe`) that
> launches the wizard UI. Installer **steps** (shell invocation, PATH,
> downloads, elevation) are being ported in later phases and are not yet
> functional on Windows.

---

## Prerequisites

1. **Visual Studio Build Tools** with the "Desktop development with C++"
   workload — provides the MSVC linker and the Windows SDK headers that the
   `ring` crypto dependency requires.
   Download: <https://visualstudio.microsoft.com/visual-cpp-build-tools/>

2. **Rust (MSVC toolchain)**: install via <https://rustup.rs>. The default
   target `x86_64-pc-windows-msvc` is correct.

3. **Node.js LTS** — needed for the frontend tooling and any npm build scripts.
   Download: <https://nodejs.org/>

4. **WebView2 Runtime** — preinstalled on Windows 11; on older Windows the
   NSIS installer bootstraps it automatically at install time
   (`webviewInstallMode: downloadBootstrapper`).

5. **Tauri CLI**:
   ```powershell
   cargo install tauri-cli --version "^2"
   ```

---

## Build

```powershell
# From the repository root
cargo tauri build
```

The per-user NSIS installer is written to:

```
src-tauri\target\release\bundle\nsis\CodeMie Installer_2.0.0_x64-setup.exe
```

(Exact filename may vary with version.)

---

## Install and Launch Verification

1. Run the `*-setup.exe`. Because `installMode` is `currentUser`, **no admin
   prompt appears** for the app install itself.
2. Launch "CodeMie Installation Wizard" from the Start Menu or the install
   completion screen.
3. Confirm the window and UI look identical to the macOS build: same dark
   theme, same layout, same step list.

---

## Test Suite Verification

Unix-only shell tests are excluded on Windows by `#[cfg(unix)]`. The rest must
compile and pass:

```powershell
# From the repo root
cargo test
cargo clippy --all-targets -- -D warnings
```

Expected: all tests PASS, no warnings.

If `cargo clippy` reports a dead-code warning, note the symbol and report it —
that is a Phase 1 gap to fix.

---

## Known Limitations (Phase 1)

The following are **intentionally deferred** and will not work until later phases:

| Feature | Phase |
|---|---|
| Shell/terminal invocation (run_capture, run_stream, PTY) | Phase 2 |
| PATH management (candidate dirs, zprofile persistence) | Phase 3 |
| Node + Git installer downloads | Phase 4 |
| Elevation / UAC | Phase 4 |
| Logger path (`%LOCALAPPDATA%`) | Phase 2 |
| Windows-specific `steps.yaml` wording | Phase 2 |

The wizard UI will render, but install steps will fail or behave unexpectedly
until those phases land.
