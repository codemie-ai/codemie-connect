# Windows first-launch runtime download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Stop bundling Windows Node.js + CodeMie CLI; download one SHA-256-verified archive on first launch into `%LOCALAPPDATA%\CodeMie\runtime\<key>`.

**Architecture:** Port macOS MR !53 (`mr53.diff`, read-only reference) cross-platform. New `commands/runtime.rs` (stream+hash, verify, unpack to staging, promote with `.complete` marker last, remove stale keys); frontend gate in `boot()`; bundled `codemie.cmd` shim reads `runtime-key` and runs the downloaded runtime.

**Tech Stack:** Tauri v2/Rust (reqwest 0.12, sha2, tokio), PowerShell build scripts, NSIS, node:test.

**Spec:** inline requirements (EPMCDME-15549); research in `technical-analysis.md`.

Commit per task using the repository's existing convention.

## Global Constraints

- Archive format: tar.gz unpacked with in-box `%SystemRoot%\System32\tar.exe` (bsdtar). Least risk: same format and flow as macOS, no new crate; unpack runs in `spawn_blocking`.
- Key = `<cliVersion>-node<nodeVersion>`; URL `https://github.com/codemie-ai/codemie-code/releases/download/runtime-{key}/codemie-runtime-<key>-win-x64.tar.gz`; `runtime.json` gets `runtimeBaseUrlWindows`.
- No admin rights; macOS behavior and files unchanged; `~/.codemie` never removed.
- Uploading the archive to GitHub Releases is out of scope.

## Acceptance criteria

(Omitted-section rule does not apply: requirements are inline.)

- [ ] First launch downloads once with visible "Preparing CodeMie…" progress; later launches do not download.
- [ ] No internet shows failure + "Try again"; works after successful retry.
- [ ] Damaged/modified/incomplete archive is never used; no half-installed staging/partial files remain.
- [ ] Download honours the Windows system proxy.
- [ ] Sign-in, guided setup, Tools, Health, Connections work with the downloaded runtime.
- [ ] Existing user CodeMie CLI: nothing downloaded.
- [ ] `codemie --version` in a new terminal prints the CLI version.
- [ ] No admin rights needed (install, first launch, uninstall).

---

### Task 1: Rust runtime module

**Files:**
- Create: `src-tauri/src/commands/runtime.rs`
- Modify: `src-tauri/Cargo.toml` (reqwest add `system-proxy`), `src-tauri/src/commands/mod.rs`, `src-tauri/src/state.rs` (add `existing_cli_detected: bool`), `src-tauri/src/lib.rs` (set field from the `probe_global_codemie` result in setup; register `runtime_ready`, `ensure_runtime` in invoke_handler), `runtime.json`

**Interfaces:**
- Produces: `#[tauri::command] runtime_ready(state) -> bool`, `ensure_runtime(app) -> CmdResult<()>` emitting `runtime:progress {phase, fraction, total}`; `runtime::node_dir()/cli_entry()` helpers; `pub fn runtime_dir() -> PathBuf` (`%LOCALAPPDATA%\CodeMie\runtime\<key>`).
- Pack data: `include_str!` of generated `assets/windows/runtime-pack.json` (`{key,url,sha256}`) under `cfg(windows)`; empty stub elsewhere (macOS has its own pack file in !53 reference, not on this branch; non-Windows stays "ready" so macOS is unchanged).

Port `runtime.rs` from mr53.diff with Windows adaptation: layout `node\node.exe`, `node\npm.cmd`, `cli\node_modules\@codemieai\code\bin\codemie.js`; `ready(existing_cli, smoke, dir_ready)` = `existing_cli || smoke || !cfg!(windows) || dir_ready`; unpack via `System32\tar.exe -xzf`; `promote` retries rename ~5x with short sleeps (AV locks); keep `CODEMIE_RUNTIME_URL` override, 30s connect/60s read timeouts, failed/partial download and staging deleted on any error, `remove_stale` after promote.

Test-first: yes — inline tests (tempfile): wrong sha is rejected and leaves no `.download-*`/`.staging-*`; marker-less dir is not ready; `ready()` true for existing CLI and smoke; promote removes other-key dirs; tar.gz fixture unpacks (cfg(windows)).

- [ ] Write failing tests in `runtime.rs`, run `cargo test runtime` (from `src-tauri/`), expect FAIL.
- [ ] Implement module and wiring, run tests, expect PASS.

### Task 2: Shim, bundle config, PATH trust, NSIS

**Files:**
- Modify: `assets/windows/bin/codemie.cmd` (whole file), `src-tauri/tauri.windows.conf.json` (resources: shim + `bin/runtime-key` only), `src-tauri/src/commands/pathman.rs:~531-585` and `probe_dir`, `src-tauri/installer-hooks.nsi` (POSTUNINSTALL), `ui/test/shim.test.mjs`, `src-tauri/tests/bundle_resources.rs`

**Interfaces:**
- Consumes: `runtime-key` file written by Task 3 beside the shim; runtime layout from Task 1.

Shim: read `%~dp0runtime-key`, runtime = `%LOCALAPPDATA%\CodeMie\runtime\<key>`; require `.complete`, else print "CodeMie is not set up yet. Open CodeMie Connect once to finish setting it up." and `exit /b 1`; append `<rt>\node` to PATH, run `node.exe` on `codemie.js`, `exit /b %ERRORLEVEL%`.
Stale-shim safety (15395): `pathman::probe_dir` trusts a bundled `codemie.cmd` only when its runtime `.complete` exists (so an unready shim is never counted as a user CLI); `inject_bundled_bin_path` still persists the shim dir (shim self-explains). NSIS POSTUNINSTALL: `RMDir /r "$LOCALAPPDATA\CodeMie\runtime"` (per-user, no admin; do not touch `.codemie`).

Test-first: yes — rewrite `shim.test.mjs` Windows cases (cmd.exe-executed, skipped off Windows): no runtime prints the "open CodeMie Connect once" text and exits 1; `.complete`-less runtime refused; fake runtime runs and passes exit code; plus regex that the nsi removes `CodeMie\runtime` and not `.codemie`. Rust: `probe_dir` returns none for shim without ready runtime.

- [ ] Write failing tests, run `npm test` and `cargo test pathman`, expect FAIL.
- [ ] Implement, rerun, expect PASS.

### Task 3: Pack and build scripts

**Files:**
- Create: `scripts/pack-runtime.ps1`
- Modify: `build-installer.ps1`, `scripts/stage-runtime.ps1` (keep staging, output to temp archive input), `runtime.json`, `.gitignore` (`assets/windows/runtime-pack.json`, `assets/windows/bin/runtime-key`), `.ai-run/guides/quality-gates.md` (Windows paragraph)

`pack-runtime.ps1`: stage Node + CLI, create `codemie-runtime-<key>-win-x64.tar.gz` with `tar.exe -czf` (root entries `node/`, `cli/`), compute SHA-256, write `assets/windows/runtime-pack.json` and `bin/runtime-key`. It must run before `tauri build`. `build-installer.ps1`: run pack step; replace post-build asserts so `node\node.exe` and `cli\...` must be ABSENT and `bin\runtime-key` present; assert archive sha equals `runtime-pack.json`; unpack archive into a temp `LOCALAPPDATA` and run the bundled shim with `--version`. Never offer a verification bypass.

Test-first: no — build script verified by its own post-build assertions in the flow's gate stage.

- [ ] Implement scripts and guide edit.

### Task 4: Frontend gate

**Files:**
- Modify: `ui/index.html` (`#runtime-overlay`: title "Preparing CodeMie…", `#runtime-bar`, `#runtime-error`, `#runtime-retry` "Try again"), `ui/renderer.js` (`ensureRuntime()` first call in `boot()`), `ui/test/shim.test.mjs` (or new `ui/test/runtime-gate.test.mjs`)

`ensureRuntime()`: `runtime_ready`; if not ready listen `runtime:progress`, loop `invoke('ensure_runtime')`, on error show message and await retry click; smoke modes bypass via `runtime_ready` returning true.

Test-first: yes — node:test asserts html contains the overlay ids/copy and `boot()` awaits `ensureRuntime()` before any other invoke; loop retries after an error (stubbed invoke).

- [ ] Write failing tests, run `npm test`, expect FAIL; implement; expect PASS.

---

## Negative-constraint pass

- No admin: Task 2 per-user `$LOCALAPPDATA`, no HKLM; Task 1 writes only under LOCALAPPDATA.
- Partial/damaged never used: Task 1 (verify, staging, marker last, cleanup).
- `~/.codemie` kept on uninstall: Task 2 NSIS removes only `runtime`.
- Smoke must not block: Task 1 `ready()`, Task 4 bypass.
- macOS unchanged: Task 1 `!cfg!(windows)` stays ready; no macOS files touched.
- Archive upload out of scope: no task.
- Existing user CLI untouched: `ready()` existing_cli term.
