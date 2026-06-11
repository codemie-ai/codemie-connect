# Windows Build Foundation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development where a task is test-first; this plan is config + compile-time `cfg`, so most tasks are verified by the macOS no-regression suite rather than a new failing test. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows NSIS build target to the macOS-only Tauri installer and make the app launch cleanly on Windows, while leaving macOS byte-for-byte unchanged and establishing the `#[cfg(windows)]` convention later phases follow.

**Architecture:** "Option B" — platform-agnostic JS brain over a thin Rust command layer. Phase 1 touches only the Rust command layer (`pathman.rs`, `runner.rs` tests), the bundle config (`tauri.conf.json`), and adds a build guide. No JS, no IPC, no install behavior. All Windows-specific code is additive `cfg` branches; macOS code paths are preserved verbatim under `cfg(not(windows))`.

**Tech Stack:** Rust 2021 (Tauri v2.11, tokio, portable-pty), `tauri.conf.json` (schema v2), NSIS bundler, WebView2.

**Verification reality:** This macOS dev box cannot build/launch the Windows bundle (no MSVC/mingw toolchain; `ring` C-crypto won't cross-compile). Local gates = `cargo build` / `cargo clippy` / `cargo test` / `cargo tauri build` (DMG) all green and macOS-unchanged. Windows-side gates (NSIS `.exe` builds, app launches, `cargo test` green) are performed by the user on their Windows machine via `docs/windows-build.md`.

---

### Task 1: Gate the Unix-coupled tests in `runner.rs`

Both tests in `runner.rs`'s test module spawn the real `/bin/zsh` and will fail on a Windows `cargo test`. They are genuinely shell-coupled, so gate the whole module with `unix`. On macOS, `unix` is true, so both still run.

**Files:**
- Modify: `src-tauri/src/commands/runner.rs:129`

**Test-first:** no — these *are* tests; the change only restricts the platform they compile on. The gate is the macOS `cargo test` still running and passing them.

- [ ] **Step 1: Change the test module attribute**

In `src-tauri/src/commands/runner.rs`, change line 129 from:

```rust
#[cfg(test)]
mod tests {
```

to:

```rust
#[cfg(all(test, unix))]
mod tests {
```

- [ ] **Step 2: Verify macOS tests still run and pass**

Run: `cd src-tauri && cargo test --lib commands::runner`
Expected: PASS — `run_capture_runs_via_shell_and_captures_stdout` and `run_capture_reports_nonzero_exit` both run (macOS is `unix`) and pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/runner.rs
git commit -m "test: gate unix-coupled runner tests behind cfg(unix) for windows build"
```

---

### Task 2: Windows clean-launch guard + helper gating in `pathman.rs`

`apply_resolved_shell_path()` runs at startup (`lib.rs:22`). On Windows it would run `/bin/zsh -ilc` (absent → `None`, no crash) then merge/dedupe the PATH on `:`, **corrupting** the Windows `;`-delimited PATH. Split it per-OS: macOS keeps its exact body; Windows returns the inherited PATH untouched. Then gate the now-Windows-unused login-shell helpers so the Windows build has no dead-code warnings, and gate the one Unix-coupled `pathman` test.

Dead-code analysis (verified against current usage):
- `resolve_shell_path` + `PATH_MARKER` → used only by the macOS `apply` body and the `cfg(unix)` test → `#[cfg(not(windows))]` (removed entirely on Windows).
- `merge_shell_path` → used by the macOS `apply` body **and** the un-gated `merge_shell_path_orders…` test (which must keep running on Windows). Keep it defined on all platforms but silence the Windows-release dead-code warning with `#[cfg_attr(windows, allow(dead_code))]`.
- `candidate_dirs`, `dedupe_path`, `missing_entries`, `fresh_env_path`, `persist` → still reached on Windows via `run_fresh_env` / `augment_path` / `persist_to_zprofile` → no change.

**Files:**
- Modify: `src-tauri/src/commands/pathman.rs` (lines 10, 48, 74, 98-105, 178)

**Test-first:** no — Windows runtime behavior cannot be exercised on this macOS box. The gate is: macOS `cargo test` + `cargo clippy` clean (proving the non-windows path is unchanged and no new warnings), and the user's Windows `cargo build`/`cargo test`.

- [ ] **Step 1: Gate `PATH_MARKER` to non-windows**

Change `src-tauri/src/commands/pathman.rs:10` from:

```rust
const PATH_MARKER: &str = "__CODEMIE_PATH_MARKER__";
```

to:

```rust
#[cfg(not(windows))]
const PATH_MARKER: &str = "__CODEMIE_PATH_MARKER__";
```

(Leave `MARKER` on line 9 unchanged — it is used by `persist`, which compiles on Windows.)

- [ ] **Step 2: Annotate `merge_shell_path` for Windows dead-code**

Change `src-tauri/src/commands/pathman.rs:48` from:

```rust
pub fn merge_shell_path(shell_path: &str, current_path: &str, candidates: &[String]) -> String {
```

to:

```rust
// Used by the macOS apply path and by an OS-neutral unit test. On Windows the
// production code does not call it yet (registry PATH lands in a later phase),
// so silence the dead-code warning there without removing the tested function.
#[cfg_attr(windows, allow(dead_code))]
pub fn merge_shell_path(shell_path: &str, current_path: &str, candidates: &[String]) -> String {
```

- [ ] **Step 3: Gate `resolve_shell_path` to non-windows**

Change `src-tauri/src/commands/pathman.rs:74` — add the attribute immediately above the doc comment / `pub fn resolve_shell_path`:

```rust
/// Resolve the user's interactive-login shell PATH. Runs `$SHELL -ilc` with a marker
/// trick (brace-delimited ${PATH}) and a hard 8s timeout via a worker thread.
#[cfg(not(windows))]
pub fn resolve_shell_path() -> Option<String> {
```

(The attribute goes between the doc comment and `pub fn`, or above the doc comment — either is valid. Keep the function body unchanged.)

- [ ] **Step 4: Split `apply_resolved_shell_path` per-OS**

Replace the whole function at `src-tauri/src/commands/pathman.rs:98-105`:

```rust
/// Resolve and apply the user's shell PATH to this process so child processes inherit it.
pub fn apply_resolved_shell_path() -> String {
    let shell_path = resolve_shell_path().unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();
    let merged = merge_shell_path(&shell_path, &current, &candidate_dirs());
    std::env::set_var("PATH", &merged);
    merged
}
```

with two `cfg`-gated definitions:

```rust
/// Resolve and apply the user's login-shell PATH so child processes inherit it (macOS).
#[cfg(not(windows))]
pub fn apply_resolved_shell_path() -> String {
    let shell_path = resolve_shell_path().unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();
    let merged = merge_shell_path(&shell_path, &current, &candidate_dirs());
    std::env::set_var("PATH", &merged);
    merged
}

/// On Windows the GUI process already inherits a usable PATH and there is no
/// login-shell concept, so this is a no-op that returns the current PATH
/// unchanged. It must NOT run a shell or pass PATH through the `:`-based merge,
/// which would corrupt the `;`-delimited Windows PATH. Registry-based PATH
/// handling lands in a later phase.
#[cfg(windows)]
pub fn apply_resolved_shell_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}
```

(`lib.rs:22` calls `apply_resolved_shell_path()` and stays unchanged.)

- [ ] **Step 5: Gate the Unix-coupled `pathman` test only**

Change `src-tauri/src/commands/pathman.rs:177-178` — add `#[cfg(unix)]` above the `#[test]` for `resolve_shell_path_captures_real_login_shell_path`:

```rust
    // Regression: resolveShellPath must brace-delimit ${PATH} and strip markers.
    #[cfg(unix)]
    #[test]
    fn resolve_shell_path_captures_real_login_shell_path() {
```

Leave `dedupe_path_*`, `missing_entries_*`, and `merge_shell_path_orders_*` tests un-gated (pure, OS-neutral).

- [ ] **Step 6: Verify macOS build, lint, and tests are clean**

Run: `cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings && cargo test --lib commands::pathman`
Expected:
- `cargo build` succeeds.
- `cargo clippy` reports no warnings (the macOS `apply`, `resolve_shell_path`, `merge_shell_path` are all still used → no dead-code warnings on macOS).
- `cargo test` PASS — all four `pathman` tests run on macOS (`unix` true) and pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/pathman.rs
git commit -m "feat: cfg(windows) no-op for startup PATH resolution; gate login-shell helpers"
```

---

### Task 3: Add the Windows NSIS bundle target to `tauri.conf.json`

Add `nsis` to `bundle.targets` (Tauri builds each target only on its native OS, so `dmg` stays macOS-only and `nsis` is produced on Windows), and add a `bundle.windows` block with explicit per-user NSIS install + WebView2 download bootstrapper. `tauri-build` runs during `cargo build` and deserializes the whole bundle config, so an invalid key/value fails the build on macOS — that is the local gate.

**Files:**
- Modify: `src-tauri/tauri.conf.json:26-41`

**Test-first:** no — config change. The gate is `cargo build` (tauri-build validates the config) + valid JSON + the macOS DMG still bundling.

- [ ] **Step 1: Edit the bundle block**

In `src-tauri/tauri.conf.json`, change the `bundle` object so `targets` includes `nsis` and a `windows` block is added after `macOS`:

```json
  "bundle": {
    "active": true,
    "targets": ["dmg", "nsis"],
    "category": "DeveloperTool",
    "copyright": "EPAM AI/Run CodeMie ©",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "macOS": {
      "minimumSystemVersion": "10.15"
    },
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper"
      },
      "nsis": {
        "installMode": "currentUser"
      }
    }
  }
```

(Note: Tauri v2's per-user NSIS value is `"currentUser"`, nested under `bundle.windows.nsis`. `webviewInstallMode` sits directly under `bundle.windows`.)

- [ ] **Step 2: Verify the config is valid JSON and deserializes**

Run: `cd src-tauri && python3 -c "import json;json.load(open('tauri.conf.json'));print('valid json')" && cargo build`
Expected:
- `valid json` printed.
- `cargo build` succeeds — `tauri-build` accepts the new `bundle.windows` keys (an invalid `installMode` enum or misplaced key would error here on macOS).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat: add per-user NSIS windows bundle target + WebView2 bootstrapper"
```

---

### Task 4: Write the Windows build guide

A user-facing doc so the Windows half can be built and verified on a Windows machine (the only place it can be).

**Files:**
- Create: `docs/windows-build.md`

**Test-first:** no — documentation.

- [ ] **Step 1: Create `docs/windows-build.md`**

```markdown
# Building the CodeMie Installer on Windows

The Windows bundle must be built **on a Windows machine** — it cannot be
cross-compiled from macOS (the `ring` crypto dependency needs a Windows C
toolchain, and NSIS bundling is Windows-only).

> Scope: this produces a per-user NSIS installer (`.exe`) that launches the
> wizard UI. Installer **steps** (shell, PATH, downloads, elevation) are being
> ported to Windows in later phases and are not yet functional.

## Prerequisites

1. **Visual Studio Build Tools** with the "Desktop development with C++"
   workload (provides the MSVC linker and the Windows SDK headers `ring` needs).
2. **Rust** (MSVC toolchain): install via <https://rustup.rs>; the default
   `x86_64-pc-windows-msvc` target is correct.
3. **Node.js** LTS (for the frontend tooling / npm scripts).
4. **WebView2 Runtime** — preinstalled on Windows 11; on older Windows the
   app's installer bootstraps it (we use `downloadBootstrapper`).
5. **Tauri CLI**: `cargo install tauri-cli --version "^2"` (or use the project's
   npm script if one is configured).

## Build

```powershell
# from the repo root
cd src-tauri
cargo tauri build
```

The per-user NSIS installer is written to:

```
src-tauri\target\release\bundle\nsis\*-setup.exe
```

## Verify

1. Run the `*-setup.exe`; it installs **per-user** (no admin prompt for the
   install itself) and launches "CodeMie Installation Wizard".
2. Confirm the window and UI look identical to the macOS build (same theme,
   layout, steps list).
3. Run the test suite — the Unix-only shell/login tests are excluded by
   `cfg(unix)`, the rest must pass:

   ```powershell
   cd src-tauri
   cargo test
   cargo clippy --all-targets -- -D warnings
   ```

If `cargo clippy` reports a dead-code warning on Windows, that is a Phase 1
gating gap — note the symbol and report it.
```

- [ ] **Step 2: Commit**

```bash
git add docs/windows-build.md
git commit -m "docs: add windows build + verification guide"
```

---

### Task 5: Final macOS no-regression verification

The strongest "didn't break macOS" signal is a real release bundle build (per quality-gates "build the DMG"). Run the full gate set once at the end.

**Files:** none (verification only).

**Test-first:** no — verification task.

- [ ] **Step 1: Format check**

Run: `cd src-tauri && cargo fmt --check`
Expected: no diff.

- [ ] **Step 2: Lint**

Run: `cd src-tauri && cargo clippy --all-targets -- -D warnings`
Expected: no warnings/errors.

- [ ] **Step 3: Full test suite**

Run: `cd src-tauri && cargo test`
Expected: all tests PASS (gated tests run on macOS since `unix` is true).

- [ ] **Step 4: macOS DMG bundle build (heavy, confirms `nsis` target doesn't break macOS bundling)**

Run: `cd src-tauri && cargo tauri build`
Expected: succeeds; produces the macOS `.dmg`; the `nsis` target is silently skipped on macOS (not an error). Note: this is a release build (`lto = true`), so it is slow.

- [ ] **Step 5: JS tests unaffected (sanity)**

Run: `npm test`
Expected: existing JS tests pass (no JS was touched).

---

## Self-Review

**Spec coverage:**
- R1 (NSIS per-user bundle) → Task 3. ✓
- R2 (clean launch, no PATH corruption + helper gating) → Task 2. ✓
- R3 (gate only the 3 Unix-coupled tests) → Task 1 (runner ×2) + Task 2 Step 5 (pathman ×1); pure tests left un-gated. ✓
- R4 (Windows build guide) → Task 4. ✓
- Acceptance "macOS local gates" → Task 5. ✓

**Placeholder scan:** none — every code/config/doc step shows the exact content.

**Type/symbol consistency:** `apply_resolved_shell_path` keeps its signature; `resolve_shell_path`/`merge_shell_path`/`candidate_dirs` names match the source; `lib.rs:22` call site unchanged. NSIS key `installMode: "currentUser"` under `bundle.windows.nsis` per Tauri v2 schema.

**Scope:** Phase 1 only — no install behavior, registry PATH, downloads, elevation, or CI.
