# macOS runtime download (EPMCDME-15548) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** The macOS app downloads Node.js + CodeMie CLI once as a SHA-256-verified archive instead of bundling them.

**Architecture:** Build on the reference in `/Users/mert_efe/codemie-installers/runtime-download-poc/poc.diff` (12 files vs eec4d45); do not redesign. Rust `commands/runtime.rs` downloads, verifies, unpacks; `ui/renderer.js` gates `boot()` on it; the shim `assets/macos/bin/codemie` finds the runtime under Application Support.

**Tech Stack:** Tauri 2, Rust (reqwest, sha2, tokio), vanilla JS, node:test, bash.

**Spec:** none (requirements inline); analysis in `technical-analysis.md` next to this file.

Commit per task using the repository's existing convention (`EPMCDME-15548 : subject` plus a short body, no Co-Authored-By line). Never stage `.codemie/codemie-cli.config.json`. Rust commands run from `src-tauri/`.

## Acceptance criteria

- [ ] Fresh install, first open: Node+CLI downloaded once with visible progress ("Preparing CodeMie…"); later launches do not download; unpacked to `~/Library/Application Support/CodeMie/runtime/<version>`.
- [ ] No internet or blocked download shows a failure with Try again; works after a successful retry.
- [ ] A damaged, modified or incomplete download is never used; nothing half-installed remains.
- [ ] The system-settings proxy is honoured (reqwest `system-proxy` feature in `src-tauri/Cargo.toml`).
- [ ] After download, sign-in, guided setup, Tools, Health and Connections work as with the bundled runtime.
- [ ] Machine with an existing CodeMie CLI: nothing downloaded (new `AppState.existing_cli_detected`, separate from `bundled_injected`).
- [ ] `codemie --version` in a new terminal after first launch prints the CLI version; before download the shim says to open CodeMie Connect once.
- [ ] An app update needing a new CLI/Node version downloads the same way and removes the old runtime.
- [ ] Windows (EPMCDME-15549) does not regress: `runtime_ready` is true on non-macOS.

## Global Constraints

- Windows build unchanged (`tauri.windows.conf.json` still bundles node/CLI). Uploading the archive to GitHub Releases is out of scope (`runtime.json` `runtimeBaseUrlMacos` holds the location).
- `runtime-pack.json` and `assets/macos/bin/runtime-key` are generated and gitignored. Do not carry the poc's `poc-test/` gitignore line.
- Simplest thing that works; each new test must be mutation-checkable (remove the mechanism from production code, re-run, exactly one test fails).
- Gates: `cd src-tauri && cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`; `npm test`; `./build-installer.sh`. Cargo needs `scripts/stage-runtime.sh` then `scripts/pack-runtime.sh` run first.

## Review Focus

- Existing CLI on PATH but PATH injection failed: must still not download (uses `existing_cli_detected`, not `bundled_injected`).
- `CODEMIE_SMOKE` / `CODEMIE_PROBE_SMOKE` launches on a machine without the runtime must not sit on the overlay.
- Process killed between unpack and rename: next launch re-downloads cleanly, never uses a partial tree.
- Stale-runtime cleanup must remove only old runtime dirs, not the new one.
- Wrong-hash and truncated archive leave no `.download-*` or `.staging-*` behind.

### Task 1: Apply the poc, wire Rust, enable proxy

**Files:**
- Apply from poc.diff (`git apply` with `--include` for the 10 clean files): `.gitignore` (minus `poc-test/`), `runtime.json`, `scripts/pack-runtime.sh`, `assets/macos/bin/codemie`, `src-tauri/Cargo.toml`, `src-tauri/tauri.macos.conf.json`, `src-tauri/src/commands/runtime.rs`, `ui/index.html`, `ui/renderer.js`, `ui/test/shim.test.mjs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod runtime;` after `pub mod runner;`), `src-tauri/src/state.rs` (add `pub existing_cli_detected: bool`), `src-tauri/src/lib.rs:71-75` (set it from the local at `lib.rs:41`; add `commands::runtime::runtime_ready` and `ensure_runtime` to `generate_handler!` after `run_stream`; skip the poc's node_exe/cli_entry hunk)
- Modify: `src-tauri/Cargo.toml:35` ensure reqwest features include `"system-proxy"`.

**Interfaces:**
- Produces: `runtime::is_ready(&Path) -> bool`, `runtime::runtime_dir(&Path)`, `runtime_ready(State<AppState>) -> CmdResult<bool>`, `ensure_runtime(AppHandle) -> CmdResult<String>`.

Test-first: yes — a unit test on a pure `fn ready(existing_cli: bool, smoke: bool, dir_ready: bool) -> bool` in `runtime.rs`: true when `existing_cli` is set even if the dir is empty (mutation: drop the existing-CLI clause, test fails).

- [ ] Write the failing test for `ready(...)` covering existing CLI. Also add a `#[cfg(not(target_os = "macos"))]` test asserting `runtime_ready` logic is true on non-macOS (put the cfg inside `ready`).
- [ ] Apply the clean poc files, make the manual edits above, implement `ready` and have `runtime_ready` call it. It returns true when `existing_cli`, or env `CODEMIE_SMOKE`/`CODEMIE_PROBE_SMOKE` is set (so smoke modes never hit the overlay), or not macOS, or `is_ready`.
- [ ] Run `scripts/stage-runtime.sh && scripts/pack-runtime.sh`, then `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test`. Commit.

### Task 2: Make install flow testable, atomic and cleaned up

**Files:**
- Modify: `src-tauri/src/commands/runtime.rs` (the `ensure_runtime` body, poc lines ~269-371)

**Interfaces:**
- Produces (all sync, take explicit paths so tests use tempdirs): `verify_sha(got_hex: &str, expected: &str) -> CmdResult<()>`, `unpack(archive: &Path, staging: &Path) -> CmdResult<()>` (runs `/usr/bin/tar -xzf`, removes staging on failure, checks node + CLI entry present), `promote(staging: &Path, dir: &Path) -> CmdResult<()>`, `remove_stale(base: &Path, keep: &str)`.

Test-first: yes — each helper gets one failing-first test: `verify_sha` rejects a different hash and accepts the equal one; `unpack` of a tiny tar.gz built in the test with a missing CLI entry errors and leaves no staging dir; `unpack` of a truncated gz errors and leaves no staging; `promote` yields `is_ready(dir)` only after the marker is written and replaces an existing `dir`; `remove_stale` deletes sibling `old-key`, `.staging-*` and `.download-*` entries but keeps `keep`.

- [ ] Write the failing tests above in the `runtime.rs` test module.
- [ ] Extract the helpers from `ensure_runtime` and call them from it. In `promote`, write the marker inside staging, then rename an existing `dir` aside to `.old-<key>` before renaming staging in, and delete the aside afterwards, so a crash never leaves a dir without a complete runtime where one existed. Keep it to those few lines.
- [ ] On every error path in `ensure_runtime`, remove `.download-<key>.tar.gz` and `.staging-<key>`. Keep the `CODEMIE_RUNTIME_URL` override and the poc's timeouts.
- [ ] Run cargo fmt/clippy/test. Mutation-check each helper test. Commit.

### Task 3: Frontend gate and shim tests

**Files:**
- Modify: `ui/renderer.js` (`ensureRuntime()` called first in `boot()` at ~line 676, from poc), `ui/index.html` (`#runtime-overlay`), `ui/test/shim.test.mjs`

Test-first: yes — extend `shim.test.mjs` (poc already rewrites it) to assert: shim prints "Open CodeMie Connect once" and exits 1 when `.complete` is absent; `tauri.macos.conf.json` bundles only the shim and `runtime-key` (no node/cli); `renderer.js` calls `ensureRuntime` before `smoke_mode` and the overlay has a Try again button wired to a retry. Add one test that executes the shim under a temp HOME with a fake runtime (`.complete`, fake `node/bin/node` script printing a version, fake `codemie.js`) and checks output, and the missing-runtime message with an empty HOME.

- [ ] Write the failing tests, then apply/adjust poc frontend changes until they pass. Confirm overlay text is "Preparing CodeMie…", progress comes from `runtime:progress`, failure shows the error and Try again that re-runs `ensure_runtime`.
- [ ] Run `npm test`. Commit.

### Task 4: Build script

**Files:**
- Modify: `build-installer.sh` (stage at ~line 52, `cargo tauri build` at ~line 100, step-5 assertions ~110-135, header and `[n/5]` labels)

Test-first: no — script verified by running `./build-installer.sh`.

- [ ] Run `scripts/pack-runtime.sh` between stage and `cargo tauri build` (also under `--skip-stage`, which must still pack if `runtime-pack.json` is absent). Replace assertions requiring bundled `node`/`cli`/nesting depth with: bundle has `bin/codemie` and `bin/runtime-key`, has no `node` or `cli` directory, DMG is under ~20 MB, `runtime-pack.json` sha matches the archive in `dist/`. Run the bundled shim smoke against a temp HOME into which the archive was unpacked at the key path with `.complete` written, using `env -i`. Keep "no bypass" header; update it. Run `./build-installer.sh`. Commit.

### Task 5: Docs and manual verification

**Files:**
- Modify: `README.md` (~46-55 module list, 85-91 bundle description), `.ai-run/guides/quality-gates.md` (stage then pack before cargo), `.ai-run/guides/architecture/architecture.md` (`commands/runtime.rs`, `state.rs` fields, runtime pack config), `.ai-run/guides/testing/testing-patterns.md` (runtime.rs tests, shim execution test)

Test-first: no — documentation.

- [ ] Update the four docs; delete obsolete lines outright, no strikethrough.
- [ ] Manual checks, only under a test HOME with `env -i` and clean PATH (never real HOME, never sign out or delete profiles), using `poc-test/slowserve.py` and `launch.sh` from the poc dir with `CODEMIE_RUNTIME_URL`: first-launch progress and second launch no download; server down then Try again succeeds; flipped byte in the archive is rejected with nothing left in the runtime base; existing CLI on PATH downloads nothing; new-terminal `codemie --version`. The proxy (AC4) needs a real system proxy; report it unverified if none is available. Commit docs.

## Negative-constraint pass

- Do not carry `poc-test/` gitignore line: Task 1.
- Do not reuse `bundled_injected` for the existing-CLI flag: Task 1 (`existing_cli_detected`).
- Do not touch or stage `.codemie/codemie-cli.config.json`: header.
- Windows out of scope, no regression: Task 1 cfg guard; no Windows files edited.
- No archive upload: none planned.
- No verification bypass in `build-installer.sh`: Task 4.
- No `git commit` blocks or Co-Authored-By: header.
- Manual checks never use the real HOME: Task 5.
