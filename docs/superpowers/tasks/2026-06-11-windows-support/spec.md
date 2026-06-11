# Spec — Phase 1: Windows build foundation + clean launch

**Task slug:** windows-support
**Phase:** 1 of 4 (Foundation)
**Branch:** feat/windows-support
**Date:** 2026-06-11

---

## Context

The app (`codemie-claude-installer-macos-tauri`) is a Tauri installer wizard that
currently targets macOS only. The goal of the overall effort is to add Windows
support so the **same UI/UX** runs on Windows, without regressing the working
macOS path. The architecture is "Option B": a platform-agnostic JS orchestration
brain over a thin, platform-specific Rust command layer. The JS↔Rust IPC
contract (command names + `engine:*` events) is already platform-neutral, so the
frontend does not change.

The complexity assessment scored the full port **XL (28/36) — SPLIT REQUIRED**.
The work was split into four phases; this spec covers **Phase 1 only**.

### Phase roadmap (for context — only Phase 1 is in scope here)

| Phase | Scope | Status |
|---|---|---|
| **1 — Foundation** | Windows NSIS bundle target, clean launch, `cfg` pattern, build guide | **THIS SPEC** |
| 2 — Low-risk command ports | shell string (`runner`/`pty`), `inspector` (`/dev/null`→`NUL`, binary paths), `logger` paths, frontend strings, Windows `steps.yaml` | deferred |
| 3 — PATH (registry) | `HKCU\Environment` + `WM_SETTINGCHANGE` reimplementation | deferred |
| 4 — Installer + elevation | Node `.msi`/`msiexec`, Git-for-Windows `.exe`, elevation model decision | deferred |

The elevation-model decision (per-op UAC vs full-process relaunch) was explicitly
deferred to Phase 4 by the user.

---

## Goal

Produce a Windows build target that compiles, bundles as a per-user NSIS
installer, and **launches the existing wizard UI cleanly** — while leaving the
macOS build and behavior byte-for-byte unchanged. This phase establishes the
`#[cfg(windows)]` convention that Phases 2–4 follow.

**This phase does NOT make installer steps function on Windows.** Shell
invocation, PATH management, downloads, and elevation remain macOS-only behavior
and are addressed in later phases.

---

## Requirements

### R1 — Windows bundle target (NSIS, per-user)
`src-tauri/tauri.conf.json`:
- `bundle.targets`: `["dmg"]` → `["dmg", "nsis"]`. Tauri builds each target only on
  its native OS, so `dmg` stays macOS-only and `nsis` is produced on Windows.
- Add a `bundle.windows` block:
  - `nsis.installMode = "perUser"` — the installer itself requires no admin
    rights (keeps elevation concerns isolated to Phase 4).
  - `webviewInstallMode = { "type": "downloadBootstrapper" }` — Tauri's default;
    install-time internet is already assumed (the app downloads Node/Git).
- `icon.ico` is already present in the icon list — no icon work required.

### R2 — Clean launch on Windows (no PATH corruption)
`src-tauri/src/commands/pathman.rs`:
- `apply_resolved_shell_path()` gains a `#[cfg(windows)]` branch that returns the
  process's inherited `PATH` unchanged — it must NOT run `$SHELL -ilc` and must
  NOT pass the PATH through the `:`-based merge/dedupe (which would corrupt the
  Windows `;`-delimited PATH).
- The macOS body is preserved verbatim under `#[cfg(not(windows))]`.
- Login-shell-only helpers (`resolve_shell_path`, `PATH_MARKER`, and any helper
  rendered unused on Windows) are gated so the Windows build produces **no
  dead-code warnings**. Acceptable mechanisms: `#[cfg(not(windows))]` on the item,
  or `#[cfg_attr(windows, allow(dead_code))]`.
- Real registry-based PATH handling is **Phase 3** — not in scope here.

### R3 — Gate Unix-coupled tests (and only those)
A Windows `cargo test` must compile and pass. Gate **only** the genuinely
shell/login-coupled tests with `#[cfg(unix)]`:
- `src-tauri/src/commands/runner.rs` — both tests in `mod tests`
  (`run_capture_runs_via_shell_and_captures_stdout`,
  `run_capture_reports_nonzero_exit`) spawn `/bin/zsh`. Gate the module (or each fn)
  with `#[cfg(unix)]`.
- `src-tauri/src/commands/pathman.rs` — gate **only**
  `resolve_shell_path_captures_real_login_shell_path` with `#[cfg(unix)]`.

**Must NOT be gated** (pure / OS-neutral — they pass on any OS):
`pathman` `dedupe_path` / `missing_entries` / `merge_shell_path` tests; all
`inspector` tests (pure parsing); all `installer` tests (pure URL building);
`logger` tests; `steps` test.

### R4 — Windows build guide
New file `docs/windows-build.md` documenting, for a Windows machine:
- Prerequisites: Rust + MSVC toolchain (`x86_64-pc-windows-msvc`), Visual Studio
  Build Tools (C/C++ + Windows SDK, required by the `ring` dependency), Node.js,
  `cargo-tauri` (`cargo install tauri-cli` or the npm script), and the WebView2
  runtime (present on Windows 11; bootstrapped on older Windows).
- The build command (e.g. `cd src-tauri && cargo tauri build`, or the project's
  npm build script).
- Where the per-user NSIS `.exe` artifact is produced
  (`src-tauri/target/release/bundle/nsis/`).
- How to run `cargo test` on Windows to confirm the gated suite is green.

---

## Acceptance Criteria

### Locally verifiable on macOS (hard gates for this session)
- [ ] `cargo build` succeeds (from `src-tauri/`).
- [ ] `cargo clippy` is clean (no new warnings; if `-D warnings` is in effect, no errors).
- [ ] `cargo test` is green — the gated tests still **run on macOS** (because
      `cfg(unix)` is true here) and pass.
- [ ] `cargo tauri build` still produces the macOS DMG with no error introduced by
      the new `nsis` target.
- [ ] `tauri.conf.json` remains valid against its `$schema`.
- [ ] The macOS code paths are unchanged — the diff shows only additive `cfg`
      branches and config additions; no macOS behavior is altered.

### Verifiable on the user's Windows machine (documented; performed by the user)
- [ ] Following `docs/windows-build.md`, `cargo tauri build` produces a per-user
      NSIS `.exe`.
- [ ] Installing and launching the `.exe` shows the wizard UI identical to macOS.
- [ ] `cargo test` is green on Windows (Unix-coupled tests excluded by `cfg`).

### Explicitly deferred (NOT acceptance for this phase)
Install steps functioning on Windows; registry PATH; shell/PTY invocation;
installer downloads; elevation/UAC; logger path on Windows; CI.

---

## Out of Scope

- **CI / Windows runners** — no CI exists in the repo today; the user has a
  Windows machine and will build manually. CI is a separate future decision.
- **MSI/WiX** — NSIS only (user choice). No WiX toolchain dependency.
- **Any runtime behavior beyond clean launch** — see the phase roadmap.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Windows-only dead-code warnings from `cfg(not(windows))` helpers break a `-D warnings` build | Gate or `allow(dead_code)` the affected items; user confirms `cargo clippy`/`build` clean on Windows via the guide. |
| Windows bundle cannot be validated in this session (no Windows toolchain on the macOS dev box; `ring` C-crypto won't cross-compile) | Acceptance split into macOS-local gates (this session) and Windows-machine gates (user, via `docs/windows-build.md`). Spec states this honestly. |
| `webviewInstallMode: downloadBootstrapper` needs install-time internet | Acceptable for an installer app; documented in the build guide. |
| Accidentally regressing macOS while adding `cfg` branches | macOS body preserved verbatim under `cfg(not(windows))`; diff review confirms only additive changes; full macOS `cargo test`/`tauri build` gate. |

---

## Files Touched

| File | Change |
|---|---|
| `src-tauri/tauri.conf.json` | Add `nsis` bundle target + `bundle.windows` (perUser NSIS, WebView2 downloadBootstrapper). |
| `src-tauri/src/commands/pathman.rs` | `cfg(windows)` no-op branch in `apply_resolved_shell_path`; gate login-shell-only helpers; gate one Unix test. |
| `src-tauri/src/commands/runner.rs` | `cfg(unix)` on `mod tests`. |
| `docs/windows-build.md` (new) | Windows build/verify guide. |
