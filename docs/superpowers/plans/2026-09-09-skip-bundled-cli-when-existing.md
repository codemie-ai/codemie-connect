# Skip Bundled CLI When Existing CodeMie CLI Is Detected — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a CodeMie CLI is already installed/resolvable on the machine, the installer must not install or register its own bundled/standalone CLI — the app must detect the existing CLI before touching PATH and resolve to it instead, on both macOS and Windows.

**Architecture:** Extract the existing-CLI PATH probe already used by the (currently UI-dead) handshake detector into a standalone function, run it once at the very start of the Tauri `setup()` closure — before `inject_bundled_bin_path` runs and before the bundled `node_exe`/`cli_entry` paths are resolved from `resource_dir()`. When an existing CLI is found, both are skipped and left as empty `PathBuf`s, which is exactly the condition `run_self_update` already checks to fall back to the PATH-resolved `codemie` shim — so no change to its core branching is needed, only a guard on its diagnostic `log::warn!` calls so they don't misfire in the now-expected "existing CLI" case.

**Tech Stack:** Rust (Tauri v2 backend, `tokio`), no new dependencies.

**Spec:** Jira ticket [EPMCDME-14581](https://jiraeu.epam.com/browse/EPMCDME-14581) — "Skip installing the bundled standalone CLI when an existing CodeMie CLI is detected; use the installed CLI instead."

## Global Constraints

- Scope covers both macOS and Windows — the detection/skip logic is platform-neutral; `pathman.rs`/`handshake.rs` already branch per-OS internally for probe/persist, so no per-platform task split is needed.
- No regression: a machine with no existing CodeMie CLI must install/use the bundled CLI exactly as before.
- No hardcoded reference may remain that assumes the app always ships/uses its own bundled CLI binary.
- Out of scope (per ticket "What is excluded"): consolidating an existing npm install into the bundled one (follow-up story), CLI version-compatibility handling, and the old binary-rename approach (superseded).
- Apply appropriate types to function args (user's global convention).
- Follow existing code style: Rust inline `#[cfg(test)]` modules, `cargo fmt`/`cargo clippy -- -D warnings` clean, JS tests via `node --test` under `ui/test/*.test.mjs` (no JS logic changes in this plan, so no new JS tests are required).

---

## File Structure

- Modify: `src-tauri/src/commands/handshake.rs` — extract `probe_global_codemie` from the inline loop in `detect_handshake_state`.
- Modify: `src-tauri/src/state.rs` — add `existing_cli_detected: bool` field.
- Modify: `src-tauri/src/lib.rs` — gate `inject_bundled_bin_path` and the `resource_dir()`-based path resolution behind a pre-injection detection call; log the outcome.
- Modify: `src-tauri/src/commands/runner.rs` — guard the two `log::warn!` calls in `run_self_update` so they don't fire when the missing bundled paths are expected (existing CLI took precedence).
- Modify: `estimations-poc.md`, `estimations2.md` — update T1/T3 demo-step wording so `codemie --version` is described as reporting whichever installation (bundled or pre-existing) is actually resolved, per ticket item "Update T1/T3 acceptance-criteria demo steps."

No new files. No UI/JS changes: `check_handshake_state` and the `bundled_takes_precedence`/"S2 precedence warning" concept it was built for have no live frontend caller (confirmed via repo-wide search — `ui/runner-bridge.js` exposes `inspector.checkHandshakeState` but nothing invokes it), so there is no shipped "S2" banner text to replace. The ticket's intent — surfacing "using your existing installed CodeMie CLI" to the user — is satisfied by the new startup log line added in Task 2, which is visible in the app's log panel (`commands::logger::write_line`).

---

### Task 1: Extract `probe_global_codemie` from `handshake.rs`

**Files:**
- Modify: `src-tauri/src/commands/handshake.rs:38-73` (the `detect_handshake_state` function body)
- Test: same file, `mod tests` block (`src-tauri/src/commands/handshake.rs:105-171`)

**Interfaces:**
- Produces: `pub fn probe_global_codemie(path_env: &str, probe: &dyn Fn(&std::path::Path) -> bool) -> bool` — used by Task 2's `lib.rs::setup()` change and internally by `detect_handshake_state`.
- Consumes: nothing new; reuses the `bin_names` selection logic already inline in `detect_handshake_state`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `mod tests` block in `src-tauri/src/commands/handshake.rs` (after `global_found_when_probe_matches`):

```rust
    #[test]
    fn probe_global_codemie_false_on_empty_path() {
        assert!(!probe_global_codemie("", &never));
    }

    #[test]
    fn probe_global_codemie_true_when_probe_matches() {
        assert!(probe_global_codemie("/usr/local/bin", &always));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `src-tauri/`): `cargo test handshake`
Expected: compile error — `cannot find function \`probe_global_codemie\` in this scope`

- [ ] **Step 3: Implement `probe_global_codemie` and refactor `detect_handshake_state` to use it**

Replace `src-tauri/src/commands/handshake.rs:38-73` with:

```rust
/// Returns true when a `codemie` binary exists in any directory of `path_env`.
/// Windows checks both the npm `.cmd` shim and a plain `.exe`; other platforms
/// check the extension-less binary name.
pub fn probe_global_codemie(path_env: &str, probe: &dyn Fn(&std::path::Path) -> bool) -> bool {
    let bin_names: &[&str] = if cfg!(windows) {
        &["codemie.cmd", "codemie.exe"]
    } else {
        &["codemie"]
    };
    std::env::split_paths(OsStr::new(path_env))
        .any(|dir| bin_names.iter().any(|&name| probe(&dir.join(name))))
}

/// Pure, testable function. `probe` returns true when a codemie binary is
/// found at a given path; `version_cmd` returns the version string for a given
/// PATH env string. Inject closures in tests, pass real implementations in production.
pub fn detect_handshake_state(
    path_env: &str,
    bundled_injected: bool,
    probe: &dyn Fn(&std::path::Path) -> bool,
    version_cmd: &dyn Fn(&str) -> Option<String>,
) -> HandshakeState {
    let global_found = probe_global_codemie(path_env, probe);

    let global_version = if global_found {
        version_cmd(path_env)
    } else {
        None
    };

    HandshakeState {
        global_found,
        global_version,
        bundled_takes_precedence: bundled_injected && global_found,
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test handshake`
Expected: `test result: ok` — all 9 tests in `commands::handshake::tests` pass (the 7 pre-existing plus the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/handshake.rs
git commit -m "refactor: extract probe_global_codemie from detect_handshake_state"
```

---

### Task 2: Detect existing CLI before PATH injection and skip the bundled install

**Files:**
- Modify: `src-tauri/src/state.rs:13-30` (add field)
- Modify: `src-tauri/src/lib.rs:12-69` (`setup()` closure)

**Interfaces:**
- Consumes: `commands::handshake::probe_global_codemie(path_env: &str, probe: &dyn Fn(&std::path::Path) -> bool) -> bool` (Task 1).
- Produces: `AppState.existing_cli_detected: bool` — consumed by Task 3's guard in `runner.rs`.

- [ ] **Step 1: Add the `existing_cli_detected` field to `AppState`**

In `src-tauri/src/state.rs`, add after the `bundled_injected` field (line 29):

```rust
    /// True when an existing CodeMie CLI was found on PATH before the bundled
    /// bin dir would have been injected. When true, `inject_bundled_bin_path`
    /// is skipped and `node_exe_path`/`cli_entry_path` are left empty so
    /// `run_self_update` falls back to the PATH-resolved CLI instead of a
    /// bundled one that was never installed (EPMCDME-14581).
    pub existing_cli_detected: bool,
```

- [ ] **Step 2: Verify the crate still compiles with the new (unused) field**

Run (from `src-tauri/`): `cargo build`
Expected: succeeds — `AppState` derives `Default`, so the new `bool` field defaults to `false` and every existing `..AppState::default()` call site remains valid.

- [ ] **Step 3: Gate detection, injection, and path resolution in `lib.rs::setup()`**

Replace `src-tauri/src/lib.rs:12-69` with:

```rust
        .setup(|app| {
            // PATH injection uses set_var and must run before any plugin starts a thread.
            let resolved = commands::pathman::apply_resolved_shell_path();
            // Capture PATH before injection so detection searches the pre-bundle PATH.
            let pre_injection_path = std::env::var("PATH").unwrap_or_default();

            // Detect an existing CodeMie CLI before touching PATH ourselves. If found,
            // the bundle must not be installed or registered at all (EPMCDME-14581).
            let existing_cli_detected =
                commands::handshake::probe_global_codemie(&pre_injection_path, &|p| p.exists());

            let bundled_injected = if existing_cli_detected {
                false
            } else {
                let injected = commands::pathman::inject_bundled_bin_path(app.handle()).is_ok();
                if !injected {
                    // eprintln! is swallowed in a packaged GUI; use log::error! so the
                    // message is captured by the log plugin (debug builds) and any
                    // custom log subscriber wired up before this point.
                    log::error!("inject_bundled_bin_path failed");
                }
                injected
            };

            // The bundled runtime and CLI entry live under resource_dir(): node/node.exe
            // on Windows (tauri.windows.conf.json), node/bin/node on macOS
            // (tauri.macos.conf.json). Skipped entirely when an existing CLI takes
            // precedence, so run_self_update falls back to the PATH-resolved `codemie`
            // shim instead of a bundled binary that was never installed.
            let (node_exe, cli_entry) = if existing_cli_detected {
                (std::path::PathBuf::new(), std::path::PathBuf::new())
            } else {
                app.path()
                    .resource_dir()
                    .map(|res| {
                        let node = if cfg!(windows) {
                            res.join("node").join("node.exe")
                        } else {
                            res.join("node").join("bin").join("node")
                        };
                        let entry = res
                            .join("cli")
                            .join("node_modules")
                            .join("@codemieai")
                            .join("code")
                            .join("bin")
                            .join("codemie.js");
                        (node, entry)
                    })
                    .unwrap_or_else(|e| {
                        log::warn!("resource_dir() failed: {e}; absolute CLI invocation unavailable");
                        (std::path::PathBuf::new(), std::path::PathBuf::new())
                    })
            };

            app.manage(AppState {
                pre_injection_path,
                bundled_injected,
                existing_cli_detected,
                node_exe_path: node_exe,
                cli_entry_path: cli_entry,
                ..AppState::default()
            });
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            commands::logger::write_line("=== CodeMie Installer session started ===", "dim");
            if existing_cli_detected {
                commands::logger::write_line(
                    "Existing CodeMie CLI detected on PATH — using it instead of installing the bundled CLI.",
                    "info",
                );
            }
            commands::logger::write_line(&format!("Resolved PATH: {resolved}"), "dim");
            Ok(())
        })
```

- [ ] **Step 4: Run the existing test suite to confirm no regressions**

Run (from `src-tauri/`): `cargo test`
Expected: `test result: ok` for every module, including `commands::handshake::tests` (Task 1) and `commands::runner::tests_self_update`. `lib.rs::setup()` itself has no unit test (it requires a running Tauri app) — this is a pre-existing gap, not introduced by this change.

- [ ] **Step 5: Manually verify the detection gate end-to-end**

This is the only behavior in this plan that cannot be covered by `cargo test` (it depends on real PATH state and `AppHandle::path()`), so verify it directly:

1. Create a fake `codemie` on PATH ahead of everything else:
   - macOS: `mkdir -p /tmp/fake-cli && printf '#!/bin/sh\necho 9.9.9\n' > /tmp/fake-cli/codemie && chmod +x /tmp/fake-cli/codemie && PATH="/tmp/fake-cli:$PATH" cargo tauri dev` (run from `src-tauri/`)
   - Windows (PowerShell): `New-Item -ItemType Directory -Force C:\temp\fake-cli; Set-Content C:\temp\fake-cli\codemie.cmd '@echo 9.9.9'; $env:PATH = "C:\temp\fake-cli;$env:PATH"; cargo tauri dev` (run from `src-tauri/`)
2. Confirm the app's log panel shows `Existing CodeMie CLI detected on PATH — using it instead of installing the bundled CLI.`
3. Confirm no entry was appended to `~/.zprofile` (macOS) / `HKCU\Environment` (Windows) for the bundled bin dir — `inject_bundled_bin_path` (and therefore `maybe_persist`) was never called.
4. Close the app, remove `/tmp/fake-cli` (or `C:\temp\fake-cli`) from PATH, run `cargo tauri dev` again, and confirm the log panel does **not** show the "Existing CodeMie CLI detected" line — the no-regression path.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat: skip bundled CLI install when an existing CodeMie CLI is detected"
```

---

### Task 3: Stop `run_self_update` from logging misleading warnings for the expected case

**Files:**
- Modify: `src-tauri/src/commands/runner.rs:172-203` (`run_self_update`)

**Interfaces:**
- Consumes: `AppState.existing_cli_detected: bool` (Task 2).
- Produces: no new symbols — behavior-only change to an existing `#[tauri::command]`.

- [ ] **Step 1: Guard the diagnostic warnings**

Replace `src-tauri/src/commands/runner.rs:178-192` (the block between the `if node.exists() && cli.exists()` early return and the `capture(...)` call) with:

```rust
    // At least one bundled path is absent. When an existing CLI took precedence
    // (EPMCDME-14581), node_exe_path/cli_entry_path were never populated by
    // design — that's expected, not a PATH-injection failure, so only warn
    // when it wasn't.
    if !state.existing_cli_detected {
        if !node.exists() {
            log::warn!(
                "[run_self_update] node_exe_path not found ({}); falling back to PATH shim",
                node.display()
            );
        }
        if !cli.exists() {
            log::warn!(
                "[run_self_update] cli_entry_path not found ({}); falling back to PATH shim",
                cli.display()
            );
        }
    }
```

- [ ] **Step 2: Run the existing test suite to confirm no regressions**

Run (from `src-tauri/`): `cargo test runner`
Expected: `test result: ok` — `tests_self_update::self_update_direct_errors_when_node_not_executable` and the platform-specific `run_capture_*` tests all pass unchanged (none of them exercise `run_self_update` itself, since it requires a Tauri `State`; this guard is covered by Task 2 Step 5's manual verification instead).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/runner.rs
git commit -m "fix: silence run_self_update warnings when an existing CLI is expected"
```

---

### Task 4: Update T1/T3 demo-step wording for pre-existing installations

**Files:**
- Modify: `estimations-poc.md:91-98`, `estimations-poc.md:127`, `estimations-poc.md:155`
- Modify: `estimations2.md:300`, `estimations2.md:304`

These are the local estimation-planning documents that define the "T1" and "T3" acceptance-criteria demo steps the ticket names explicitly ("Update T1/T3 acceptance-criteria demo steps: `codemie --version` should report the pre-existing installation's version"). They are not shipped with the app and are not covered by any quality gate, but the ticket names them directly, so they're updated for consistency with the new behavior.

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update `estimations-poc.md`**

In the "What the demo must prove" list (`estimations-poc.md:91-94`), change line 92 from:

```
2. `codemie --version` prints a version (bundled runtime used).
```

to:

```
2. `codemie --version` prints a version — the bundled runtime's version on a machine with no prior install, or the pre-existing installation's version if `codemie` was already on PATH before the app ran (EPMCDME-14581).
```

In the T5 acceptance criteria (`estimations-poc.md:127`), change:

```
- `<new-name> --version` works on a clean macOS machine after a manual build.
```

to:

```
- `<new-name> --version` works on a clean macOS machine after a manual build, and continues to resolve to an already-installed CodeMie CLI's version (not the bundled one) when one is present (EPMCDME-14581).
```

In the T3 acceptance criteria (`estimations-poc.md:155`), change:

```
- `codemie --version` works on a clean macOS machine after a manual build.
```

to:

```
- `codemie --version` works on a clean macOS machine after a manual build, and reports the pre-existing installation's version instead of installing the bundled CLI when one is already on PATH (EPMCDME-14581).
```

- [ ] **Step 2: Update `estimations2.md`**

In the T3 end-to-end verification step (`estimations2.md:300`), change:

```
**5. End-to-end verification on a clean macOS VM** — On macOS aarch64 with no Node.js, no npm, no codemie: install the app, open a terminal, run `codemie --version` (must print version), run `codemie install [agent]` (must complete), confirm `which node` / `which npm` do not return the bundle, confirm `~/.zprofile` has the PATH block without admin prompt, confirm existing system Node.js (if any) is unchanged.
```

to:

```
**5. End-to-end verification on a clean macOS VM** — On macOS aarch64 with no Node.js, no npm, no codemie: install the app, open a terminal, run `codemie --version` (must print version), run `codemie install [agent]` (must complete), confirm `which node` / `which npm` do not return the bundle, confirm `~/.zprofile` has the PATH block without admin prompt, confirm existing system Node.js (if any) is unchanged. Separately, on a VM with `codemie` already on PATH, confirm the app does not append a PATH entry and `codemie --version` still resolves to the pre-existing install (EPMCDME-14581).
```

In the T3 acceptance criteria (`estimations2.md:304`), change:

```
- `codemie --version` works on a clean macOS machine (no Node, no npm) after installation.
```

to:

```
- `codemie --version` works on a clean macOS machine (no Node, no npm) after installation, and resolves to the pre-existing installation (not the bundled CLI) when `codemie` is already on PATH (EPMCDME-14581).
```

- [ ] **Step 3: Commit**

```bash
git add estimations-poc.md estimations2.md
git commit -m "docs: update T1/T3 demo steps for pre-existing CLI detection"
```

---

### Task 5: Final quality gates

**Files:** none (verification only)

- [ ] **Step 1: Format check**

Run: `cd src-tauri && cargo fmt --check`
Expected: exits 0, no output. If it lists files, run `cargo fmt` and re-check.

- [ ] **Step 2: Lint**

Run: `cd src-tauri && cargo clippy -- -D warnings`
Expected: exits 0.

- [ ] **Step 3: Rust unit tests**

Run: `cd src-tauri && cargo test`
Expected: `test result: ok` across every module — record the pass count for the MR description.

- [ ] **Step 4: JS unit tests**

Run: `npm test` (from repo root)
Expected: all `node:test` suites in `ui/test/*.test.mjs` exit 0. No JS logic changed in this plan, so this is a regression check only — record the pass count for the MR description.

- [ ] **Step 5: Commit any formatting fixes**

```bash
git add -A
git commit -m "chore: cargo fmt"
```
(Only if Step 1 required `cargo fmt` to auto-fix something; otherwise skip.)

---

## Self-Review

**1. Spec coverage:**
- AC "no bundled/standalone CLI binary or shim is installed when an existing CLI is present" → Task 2 (`inject_bundled_bin_path` skipped when `existing_cli_detected`).
- AC "app invokes CLI internally or `codemie --version` resolves to the already-installed CLI" → Task 2 (`node_exe_path`/`cli_entry_path` left empty) + Task 3 (no misleading warning) — `run_self_update`'s pre-existing fallback to `capture("codemie self-update", None)` (PATH-resolved) already satisfies this without further change; `check_codemie_version` in `inspector.rs` already runs `codemie --version` via PATH.
- AC "PATH registration does not add an entry for a bundled binary that was never installed" → Task 2 (`inject_bundled_bin_path`, and therefore `maybe_persist`/`persist`, is never called when detected).
- AC "no existing CodeMie CLI → bundled CLI installed and used as before (no regression)" → Task 2 Step 5.4 (manual no-regression check) + Task 2 Step 4 (full existing suite still passes).
- AC "no hardcoded reference remains assuming the app always ships/uses its own bundled CLI" → confirmed via repo-wide search that `ui/renderer.js`'s CLI-related strings (`:344`, `:400-401`) are about sign-in state and version-compatibility gating, not install-ownership assumptions (version-compatibility handling is explicitly out of scope per the ticket) — no change needed there.
- "Replace S2 precedence-warning messaging" → confirmed `check_handshake_state` has no live frontend caller (dead code), so there is no shipped banner to replace; the new startup log line in Task 2 covers the ticket's underlying intent.
- "Update T1/T3 acceptance-criteria demo steps" → Task 4.
- Windows scope → every code change in Tasks 1-3 is inside functions that already branch on `cfg!(windows)` internally (`probe_global_codemie`'s `bin_names`, `node_exe`/`cli_entry` extensions); no platform-specific task split was needed.

**2. Placeholder scan:** no "TBD"/"handle appropriately"/unshown code — every step has the literal code or exact file/line diff.

**3. Type consistency:** `probe_global_codemie(path_env: &str, probe: &dyn Fn(&std::path::Path) -> bool) -> bool` is defined in Task 1 and consumed with that exact signature in Task 2 Step 3 (`&|p| p.exists()` matches `&dyn Fn(&std::path::Path) -> bool`). `AppState.existing_cli_detected: bool` is defined in Task 2 Step 1 and consumed with that exact name in Task 2 Step 3 and Task 3 Step 1.
