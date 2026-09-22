# EPMCDME-15180: Bundle npm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle npm alongside the already-bundled node runtime so npm-based agent install/uninstall work on a machine with no system Node/npm, without touching the read-only signed app bundle.

**Architecture:** Extract npm from the same Node tarball `stage-runtime.sh`/`.ps1` already download (no separate fetch), plus a 2-line shim exec'ing the staged node against `npm-cli.js`. Map the new files into the Tauri bundle. A new shared helper (`src-tauri/src/commands/npm_env.rs`) computes `npm_config_prefix=~/.codemie/agents` and its PATH entry; it's wired into two independent CLI spawn points so neither can drift: `runner.rs::shell_cmd()` (which `capture`, `run_stream` — the actual path the Agents screen drives install/update/remove through, via `ui/agents-controller.js:122` → `runner.runStream` — and `run_fresh_env` all build their command through) and `pty.rs::spawn_pty` (a separate spawn mechanism that does not go through `shell_cmd`). `pathman.rs::persist_to_zprofile` always includes the same PATH entry in its one managed block. `build-installer.sh`/`.ps1` gain a pre-build assertion mirroring the existing node checks.

**Tech Stack:** Rust (Tauri commands), bash/PowerShell staging scripts, Tauri bundle config (JSON).

**Requirements:** inline ticket text (EPMCDME-15180), reproduced in the task dispatch — no spec.md.

**Technical analysis:** `docs/superpowers/tasks/2026-09-22-EPMCDME-15180-bundle-npm/technical-analysis.md`

## Global Constraints

- Do not fetch npm separately — extract it from the Node tarball `stage-runtime.sh`/`.ps1` already download for `bin/node`.
- The `.zprofile` PATH change must land in pathman.rs's single existing marker block — never a second block, never a duplicate entry (its dedup is a raw substring match).
- No CI staging changes (EPMCDME-14630), no Agents-screen changes (EPMCDME-14514), no signing changes (EPMCDME-14508/14899) — out of scope. (The Agents screen's call into `runner.runStream` is read, not modified — the fix lands entirely in the Rust backend it already calls.)
- This machine has a system npm on PATH, so a local install test never verifies the clean-machine acceptance criteria. Verify only what's honestly local (file trees, shim exec, unit tests, the new build-installer failure path); the MR must state which criteria (clean-machine install/uninstall, fresh-terminal run, no admin prompt, user's own npm packages untouched) remain unverified pending a separate clean-machine run.
- Commit per task using the repo's convention: `EPMCDME-15180 : <subject>`, short body, no `Co-Authored-By` line.

## Acceptance criteria

- [ ] On a clean macOS machine (no Node, no npm), installing an npm-based agent from the Agents screen succeeds. **(unverifiable locally — flag in MR)**
- [ ] Removing that agent from the Agents screen succeeds on the same machine. **(unverifiable locally — flag in MR)**
- [ ] The installed agent runs from a fresh terminal. **(unverifiable locally — flag in MR)**
- [ ] No admin credential prompt appears. **(unverifiable locally — flag in MR)**
- [ ] The user's own Node.js and global npm packages are unchanged. **(unverifiable locally — flag in MR)**
- [ ] The PATH change stays in `~/.zprofile`, one block.
- [ ] `build-installer.sh` (and `.ps1`) exit non-zero with a named path if the staged npm is missing, empty or unexecutable.
- [ ] `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test` pass.

---

### Task 1: Shared npm-env helper

**Files:**
- Create: `src-tauri/src/commands/npm_env.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod npm_env;`)

**Interfaces:**
- Produces: `pub struct NpmEnv { pub prefix: String, pub bin_dir: String }`, `pub fn npm_env() -> NpmEnv`, `pub fn prefixed_path(existing_path: &str) -> String` (prepends `bin_dir` to `existing_path`, deduped via `pathman::dedupe_path`, which is already `pub`).
- Consumes: `crate::commands::pathman::dedupe_path` (existing, `pub`).

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn npm_env_uses_home_codemie_agents_with_bin_subdir() {
        std::env::set_var("HOME", "/Users/test");
        let e = npm_env();
        assert_eq!(e.prefix, "/Users/test/.codemie/agents");
        assert_eq!(e.bin_dir, "/Users/test/.codemie/agents/bin");
    }

    #[cfg(not(windows))]
    #[test]
    fn prefixed_path_prepends_bin_dir_and_dedupes() {
        std::env::set_var("HOME", "/Users/test");
        let result = prefixed_path("/usr/bin:/Users/test/.codemie/agents/bin");
        assert_eq!(result, "/Users/test/.codemie/agents/bin:/usr/bin");
    }
}
```

- [ ] **Step 2: Run `cargo test npm_env -- --test-threads=1` from `src-tauri/`; expect FAIL (module doesn't exist)**

- [ ] **Step 3: Implement**

```rust
// Shared npm environment construction for CLI child processes. Used by
// runner.rs::shell_cmd (covering capture/run_stream/run_fresh_env) and
// pty.rs::spawn_pty so all spawn paths agree on npm_config_prefix and the
// PATH entry that makes globally-installed agents runnable without a
// system npm.
//
// Unix: npm puts global bins in `$prefix/bin`. Windows: npm puts them
// directly in `$prefix` (no `bin` subdir) — reflected below, not asserted
// by any test on this platform.
#[cfg(not(windows))]
const PATH_SEP: char = ':';
#[cfg(windows)]
const PATH_SEP: char = ';';

pub struct NpmEnv {
    pub prefix: String,
    pub bin_dir: String,
}

#[cfg(not(windows))]
pub fn npm_env() -> NpmEnv {
    let home = std::env::var("HOME").unwrap_or_default();
    let prefix = format!("{home}/.codemie/agents");
    let bin_dir = format!("{prefix}/bin");
    NpmEnv { prefix, bin_dir }
}

#[cfg(windows)]
pub fn npm_env() -> NpmEnv {
    let profile = std::env::var("USERPROFILE").unwrap_or_default();
    let prefix = format!(r"{profile}\.codemie\agents");
    let bin_dir = prefix.clone();
    NpmEnv { prefix, bin_dir }
}

pub fn prefixed_path(existing_path: &str) -> String {
    let env = npm_env();
    let combined = format!("{}{PATH_SEP}{existing_path}", env.bin_dir);
    crate::commands::pathman::dedupe_path(&combined)
}
```

- [ ] **Step 4: Run `cargo test npm_env -- --test-threads=1`; expect PASS**

- [ ] **Step 5: Commit** — `EPMCDME-15180 : add shared npm-env helper for prefix + PATH construction`

---

### Task 2: Wire helper into `runner.rs::shell_cmd()` (covers `capture`, `run_stream`, `run_fresh_env`)

Test-first: yes — new test asserting `shell_cmd()` itself sets `npm_config_prefix` and prefixes `PATH` with the agents bin dir by default. `capture`, `run_stream`, and `run_fresh_env` all build their command through `shell_cmd()`, so wiring the helper in there once covers all three — including the actual Agents-screen install/update/remove path (`ui/agents-controller.js:122` → `runner.runStream` → `run_stream` → `shell_cmd`), which does **not** go through `capture()` and would otherwise stay unfixed.

**Files:**
- Modify: `src-tauri/src/commands/runner.rs:30-46` (`shell_cmd`)

**Interfaces:**
- Consumes: `npm_env::npm_env()`, `npm_env::prefixed_path()` (Task 1).
- No change to `capture`'s signature or body (`runner.rs:50-67`): its existing `if let Some(p) = path_override { command.env("PATH", p); }` runs *after* `shell_cmd(cmd)` returns, so an explicit `path_override` (e.g. from `run_fresh_env`) continues to win over the default npm-env-prefixed `PATH` that `shell_cmd` now sets — no existing override semantics are discarded.

- [ ] **Step 1: Write failing test** in runner.rs's existing `#[cfg(all(test, unix))] mod tests`:

```rust
#[tokio::test]
async fn shell_cmd_sets_npm_config_prefix_and_prefixed_path_by_default() {
    std::env::set_var("HOME", "/Users/test");
    let out = shell_cmd("echo $npm_config_prefix; echo $PATH")
        .output()
        .await
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines();
    assert_eq!(lines.next().unwrap(), "/Users/test/.codemie/agents");
    assert!(lines.next().unwrap().starts_with("/Users/test/.codemie/agents/bin:"));
}
```

- [ ] **Step 2: Run `cargo test shell_cmd_sets_npm_config_prefix -- --test-threads=1` from `src-tauri/`; expect FAIL**

- [ ] **Step 3: Implement** — in `shell_cmd` (`runner.rs:30-46`), before returning `c` in each `#[cfg]` branch, add: `let env = crate::commands::npm_env::npm_env(); let base = std::env::var("PATH").unwrap_or_default(); c.env("npm_config_prefix", &env.prefix).env("PATH", crate::commands::npm_env::prefixed_path(&base));`

- [ ] **Step 4: Run `cargo test shell_cmd_sets_npm_config_prefix -- --test-threads=1`; expect PASS. Also re-run the existing `run_capture_*` tests (unchanged) to confirm `path_override` behavior in `capture` still passes.**

- [ ] **Step 5: Commit** — `EPMCDME-15180 : set npm_config_prefix and agents-bin PATH in shell_cmd() (capture, run_stream, run_fresh_env)`

---

### Task 3: Wire helper into `pty.rs::spawn_pty`

Test-first: yes — `spawn_pty` itself has no inline test today and isn't easily unit-testable (it opens a real PTY). Extract the env-pairs it builds into a small pure function and test that directly. `spawn_pty` is an independent spawn path that does not go through `shell_cmd` (Task 2), so it needs the shared helper wired in separately.

**Files:**
- Modify: `src-tauri/src/commands/pty.rs:59-88`

**Interfaces:**
- Produces: `fn pty_env_pairs(existing_path: &str) -> Vec<(String, String)>` (unix: `TERM`, `HOME`, `PATH`, `npm_config_prefix`; windows: `TERM`, `USERPROFILE`, `PATH`, `npm_config_prefix`).
- Consumes: `npm_env::npm_env()`, `npm_env::prefixed_path()` (Task 1).

- [ ] **Step 1: Write failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn pty_env_pairs_includes_npm_config_prefix_and_prefixed_path() {
        std::env::set_var("HOME", "/Users/test");
        let pairs = pty_env_pairs("/usr/bin");
        let prefix = pairs.iter().find(|(k, _)| k == "npm_config_prefix").unwrap();
        assert_eq!(prefix.1, "/Users/test/.codemie/agents");
        let path = pairs.iter().find(|(k, _)| k == "PATH").unwrap();
        assert!(path.1.starts_with("/Users/test/.codemie/agents/bin:"));
    }
}
```

- [ ] **Step 2: Run `cargo test pty_env -- --test-threads=1`; expect FAIL**

- [ ] **Step 3: Implement** — add `fn pty_env_pairs(existing_path: &str) -> Vec<(String, String)>` above `spawn_pty`, building the same pairs each `#[cfg]` branch of `spawn_pty` currently sets inline (`TERM`, `HOME`/`USERPROFILE`, `PATH` via `npm_env::prefixed_path(existing_path)`, `npm_config_prefix` via `npm_env::npm_env().prefix`). Replace `pty.rs:59-88`'s per-branch `b.env(...)` calls with a loop over `pty_env_pairs(&path)` calling `b.env(k, v)`.

- [ ] **Step 4: Run `cargo test pty_env -- --test-threads=1`; expect PASS**

- [ ] **Step 5: Commit** — `EPMCDME-15180 : set npm_config_prefix and agents-bin PATH in spawn_pty()` (body notes: pty.rs is a spawn path independent of runner.rs::shell_cmd, already used by at least one install command via ui/handlers.js::runPty — wired in separately so PTY-driven installs get the same env fix as the shell_cmd-based paths from Task 2).

---

### Task 4: `pathman.rs` — agents bin dir in the zprofile PATH block

Test-first: yes — a pure function that always includes the agents bin dir in the entries passed to `persist()`, so the existing single-block/dedup behavior (raw substring match against file content) is exercised without touching a real file.

**Files:**
- Modify: `src-tauri/src/commands/pathman.rs:24-32` (`candidate_dirs`, unix branch), `pathman.rs:232-235` (`persist_to_zprofile`)

**Interfaces:**
- Consumes: `npm_env::npm_env().bin_dir` (Task 1).
- Produces: `pub fn build_persist_entries(entries: Vec<String>) -> Vec<String>`.

- [ ] **Step 1: Write failing test** in `pathman.rs`'s existing test module

```rust
#[test]
fn build_persist_entries_appends_agents_bin_dir_once() {
    let out = build_persist_entries(vec!["/opt/homebrew/bin".to_string()]);
    let agents_bin = crate::commands::npm_env::npm_env().bin_dir;
    assert_eq!(out, vec!["/opt/homebrew/bin".to_string(), agents_bin]);
}

#[test]
fn build_persist_entries_does_not_duplicate_if_caller_already_included_it() {
    let agents_bin = crate::commands::npm_env::npm_env().bin_dir;
    let out = build_persist_entries(vec![agents_bin.clone()]);
    assert_eq!(out, vec![agents_bin]);
}
```

- [ ] **Step 2: Run `cargo test build_persist_entries -- --test-threads=1`; expect FAIL**

- [ ] **Step 3: Implement** — add `pub fn build_persist_entries(mut entries: Vec<String>) -> Vec<String> { let agents_bin = crate::commands::npm_env::npm_env().bin_dir; if !entries.contains(&agents_bin) { entries.push(agents_bin); } entries }`; change `persist_to_zprofile` (`pathman.rs:232-235`) to `persist(&build_persist_entries(entries)).map_err(Into::into)`. Add `format!(r"{profile}\.codemie\agents")` to the Windows `candidate_dirs()` list (`pathman.rs:34-43`) alongside the existing entries, for parity with the Windows registry-persist path.

- [ ] **Step 4: Run `cargo test build_persist_entries -- --test-threads=1`; expect PASS. Also run the full `cargo test -- --test-threads=1` from `src-tauri/` to confirm `persist()`'s existing substring-dedup tests still pass unchanged.**

- [ ] **Step 5: Commit** — `EPMCDME-15180 : always include agents bin dir in the zprofile PATH block`

---

### Task 5: Stage npm on macOS

Test-first: no — this is a bash script; verified by actually running it against the real pinned tarball and asserting the resulting file tree plus a real `--version` invocation. Integration-shaped, not a unit test (per testing-patterns.md, install/staging operations aren't in the automated suite).

**Files:**
- Modify: `scripts/stage-runtime.sh:41-66` (Node runtime section), `scripts/stage-runtime.sh:106-122` (Verify section)

- [ ] **Step 1: Extend the tarball extraction** (`stage-runtime.sh:59`) — replace the single-file `tar -xzf ... "node-v$NODE_VERSION-darwin-arm64/bin/node"` with a two-path extraction also pulling `node-v$NODE_VERSION-darwin-arm64/lib/node_modules/npm`: `tar -xzf "$TMP/$TARBALL" -C "$TMP" "node-v$NODE_VERSION-darwin-arm64/bin/node" "node-v$NODE_VERSION-darwin-arm64/lib/node_modules/npm"`. Fail loudly if the extracted npm dir is absent: `[ -d "$TMP/node-v$NODE_VERSION-darwin-arm64/lib/node_modules/npm" ] || fail "npm tree not found in Node tarball at lib/node_modules/npm — tarball layout may have changed"`. Copy it to `$NODE_DIR/lib/node_modules/npm` (`mkdir -p "$NODE_DIR/lib/node_modules" && cp -R "$TMP/node-v$NODE_VERSION-darwin-arm64/lib/node_modules/npm" "$NODE_DIR/lib/node_modules/npm"`).

- [ ] **Step 2: Write the shim** — after the copy, write `$NODE_DIR/bin/npm`:

```sh
#!/bin/sh
# npm shim: execs the staged node against npm's own CLI entry. Written
# instead of relying on the tarball's bin/npm relative symlink surviving
# Tauri bundling (unverified — see technical-analysis.md §6).
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/bin/node" "$DIR/lib/node_modules/npm/bin/npm-cli.js" "$@"
```
then `chmod 755 "$NODE_DIR/bin/npm"`.

- [ ] **Step 3: Extend the verify section** (`stage-runtime.sh:106-122`) — add after the existing node checks: `[ -x "$NODE_DIR/bin/npm" ] || fail "missing or not executable: $NODE_DIR/bin/npm"`; `[ -s "$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js" ] || fail "missing or empty: $NODE_DIR/lib/node_modules/npm/bin/npm-cli.js"`; run `NPM_REPORTED="$("$NODE_DIR/bin/npm" --version 2>&1)" || fail "npm --version failed: $NPM_REPORTED"` and echo it, mirroring the existing node-version check pattern.

- [ ] **Step 4: Run manually** — `rm -rf assets/macos/node && ./scripts/stage-runtime.sh`, then confirm: `assets/macos/node/bin/npm` exists and is executable; `assets/macos/node/lib/node_modules/npm/bin/npm-cli.js` exists and is non-empty. Verify staging actually worked by running the staged npm through the shim — `assets/macos/node/bin/npm --version` — and asserting it prints the npm version bundled with the pinned Node release (cross-check against `assets/macos/node/lib/node_modules/npm/package.json`'s `version` field). Do **not** check the staged tree for absence of `docs/`, `test/` or `.md` files — npm's own package legitimately ships its own README/CHANGELOG/docs under `lib/node_modules/npm`, and pruning them would break npm itself; the `--version` run is the verification that staging succeeded.

- [ ] **Step 5: Commit** — `EPMCDME-15180 : stage npm from the pinned Node tarball on macOS`

---

### Task 6: Stage npm on Windows

Test-first: no — same integration-shaped verification as Task 5, run via PowerShell if available; otherwise reviewed for parity with the macOS script.

**Files:**
- Modify: `scripts/stage-runtime.ps1:24-55` (Node runtime section), `scripts/stage-runtime.ps1:117-140` (Verify section)

- [ ] **Step 1: Extend extraction** (`stage-runtime.ps1:47-52`) — after `Expand-Archive`, also copy `node-v$($Cfg.nodeVersion)-win-x64\node_modules\npm` (sibling of `node.exe` in the Windows zip layout, not under `lib/`) to `$NodeDir\node_modules\npm`, failing loudly first if the source path is absent: `$npmSrc = Join-Path $tmp "node-v$($Cfg.nodeVersion)-win-x64\node_modules\npm"; if (-not (Test-Path $npmSrc)) { Fail "npm tree not found in Node zip at node_modules\npm — zip layout may have changed" }; Copy-Item $npmSrc (Join-Path $NodeDir "node_modules\npm") -Recurse -Force`.

- [ ] **Step 2: Write the shim** — write `$NodeDir\npm.cmd`:

```
@echo off
"%~dp0node.exe" "%~dp0node_modules\npm\bin\npm-cli.js" %*
```

- [ ] **Step 3: Extend verify section** (`stage-runtime.ps1:117-140`) — add: `if (-not (Test-Path (Join-Path $NodeDir "npm.cmd"))) { Fail "missing: $NodeDir\npm.cmd" }`; `$npmCli = Join-Path $NodeDir "node_modules\npm\bin\npm-cli.js"; if (-not (Test-Path $npmCli)) { Fail "missing: $npmCli" }; if ((Get-Item $npmCli).Length -eq 0) { Fail "empty: $npmCli" }`.

- [ ] **Step 4: Run manually if a Windows/PowerShell environment is available** — mirror Task 5's Step 4 checks (existence/executability plus a real `npm.cmd --version` run) against `$NodeDir\npm.cmd` and `node_modules\npm`. If unavailable on this machine, note in the MR that this task's script change is unverified by execution and needs a Windows run before merge.

- [ ] **Step 5: Commit** — `EPMCDME-15180 : stage npm from the pinned Node zip on Windows`

---

### Task 7: Bundle resource mapping

Test-first: no — static JSON config, verified by `build-installer.sh`'s existing post-build presence assertions (Task 8 extends the pre-build side; post-build coverage of the exact npm paths is a natural follow-up but is not required by the ticket's acceptance criteria and is left to the clean-machine run).

**Files:**
- Modify: `src-tauri/tauri.macos.conf.json`, `src-tauri/tauri.windows.conf.json`

- [ ] **Step 1:** Add to `tauri.macos.conf.json`'s `bundle.resources` (currently 3 entries): `"../assets/macos/node/bin/npm": "node/bin/npm"` and `"../assets/macos/node/lib/node_modules/npm": "node/lib/node_modules/npm"`.

- [ ] **Step 2:** Add to `tauri.windows.conf.json`'s `bundle.resources` (currently 3 entries): `"../assets/windows/node/npm.cmd": "node/npm.cmd"` and `"../assets/windows/node/node_modules/npm": "node/node_modules/npm"`.

- [ ] **Step 3:** Run `cd src-tauri && cargo build` to confirm the JSON is still valid and `tauri-build` doesn't reject the config (it will fail loudly if a resource source path doesn't exist, per the analysis — this also re-confirms Task 5/6's staged output is present).

- [ ] **Step 4: Commit** — `EPMCDME-15180 : map staged npm into the Tauri bundle resources`

---

### Task 8: build-installer failure-path checks

Test-first: no — shell/PowerShell validation logic with no test harness in the repo; verified by deliberately breaking the staged npm and confirming the script fails with the named path, then restoring it.

**Files:**
- Modify: `build-installer.sh:56-63` (stage `[2/5]`), `build-installer.ps1:50-63` (stage `[2/5]`)

- [ ] **Step 1:** In `build-installer.sh`, after the existing node checks (`build-installer.sh:56-63`), add: `NPM_BIN="$ROOT/assets/macos/node/bin/npm"`; `[ -f "$NPM_BIN" ] || fail "missing bundled npm: $NPM_BIN"`; `[ -x "$NPM_BIN" ] || fail "bundled npm is not executable: $NPM_BIN"`; `[ -s "$NPM_BIN" ] || fail "bundled npm is empty: $NPM_BIN"`.

- [ ] **Step 2:** In `build-installer.ps1`, after the existing node checks (`build-installer.ps1:52-63`), add: `$NpmCmd = Join-Path $Root "assets\windows\node\npm.cmd"; if (-not (Test-Path $NpmCmd)) { Fail "missing bundled npm: $NpmCmd" }; if ((Get-Item $NpmCmd).Length -eq 0) { Fail "bundled npm is empty: $NpmCmd" }`.

- [ ] **Step 3: Verify by breaking it** — `mv assets/macos/node/bin/npm /tmp/npm.bak && ./build-installer.sh --skip-stage; echo "exit: $?"` — expect a non-zero exit naming `assets/macos/node/bin/npm` in the message. Then `mv /tmp/npm.bak assets/macos/node/bin/npm` to restore.

- [ ] **Step 4: Commit** — `EPMCDME-15180 : fail build-installer loudly if bundled npm is missing, empty or unexecutable`

---

## Negative-constraint pass

- **No separate npm fetch** — Task 5/6 extract npm from the tarball `stage-runtime.sh`/`.ps1` already download for `bin/node`; no new URL is introduced. No task fetches npm independently.
- **No second `.zprofile` PATH block / no duplicate entries** — Task 4's `build_persist_entries` feeds into the existing single-block `persist()` (unchanged), and its own dedup guard (`if !entries.contains(...)`) plus `persist()`'s pre-existing substring dedup both prevent a duplicate. No task calls `persist()` a second time or writes a second marker.
- **No CI staging changes** — no task touches CI config; Tasks 5/6 change scripts run locally/manually only, consistent with EPMCDME-14630 staying out of scope.
- **No Agents-screen changes** — no task touches any UI file; the frontend (`ui/agents-controller.js`, `ui/handlers.js`, the Agents screen itself) is untouched — Task 2 fixes the Rust backend (`shell_cmd`) that `ui/agents-controller.js:122`'s existing call into `runner.runStream` already reaches, per EPMCDME-14514.
- **No signing changes** — no task touches signing/entitlements/notarization config, per EPMCDME-14508/14899.
- **Staged npm's own docs/test/md files are not pruned** — Task 5 Step 4 verifies staging via a real `--version` invocation of the staged shim, not a file-tree content check; no task deletes or filters files inside the staged `node_modules/npm` tree.
- negative-constraints: all covered above (none left unaddressed).
