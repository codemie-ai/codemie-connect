# Technical Research

**Task**: windows runtime download first-launch tauri
**Generated**: 2026-10-02
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15549 — CodeMie Connect (Windows): download Node.js and the CodeMie CLI on first launch instead of bundling them.

The Windows installer no longer carries Node.js and the CodeMie CLI. On first launch the app downloads them once, as one verified archive, same as macOS (EPMCDME-15548, reference MR !53; its diff, minus docs, is saved at C:/Users/RatiGigauri/AppData/Local/Temp/claude/C--Users-RatiGigauri-source-codemie-claude-installer-macos/86eeeec2-0704-48dc-a2e0-d8899a89c49a/scratchpad/mr53.diff — it is NOT in the current branch; read it as the reference implementation, and note the macOS parts do not exist in this working tree, so identify what must be ported/added on this branch vs what exists).

What changes:
* Build packs the Windows Node.js (node.exe, npm) and the CodeMie CLI into one archive per release, published on GitHub Releases. App only accepts the archive it was built with (SHA-256 baked into build).
* First launch shows "Preparing CodeMie…" with progress, downloads archive, unpacks into %LOCALAPPDATA%\CodeMie\runtime\<version>.
* Download failure: app says so and offers Try again. Half-finished download/unpack never used.
* codemie.cmd shim uses the downloaded runtime so `codemie` works in new terminal. Before runtime downloaded, it tells user to open CodeMie Connect once.
* Existing user CodeMie CLI: nothing downloaded, that CLI used as today.
* When an app update needs a new CLI/Node version, app downloads same way and removes the old one.

Acceptance criteria:
1. Fresh per-user install: first open downloads Node+CLI once with visible progress; later launches don't download.
2. No internet/blocked: shows failure with Try again; works after successful retry.
3. Damaged/modified/incomplete download never used; nothing half-installed remains.
4. Behind a proxy configured in Windows settings: download goes through proxy.
5. After download: sign-in, guided setup, Tools (install/remove), Health, Connections work as with bundled runtime.
6. Existing CodeMie CLI: nothing downloaded.
7. `codemie --version` in new terminal after first launch prints CLI version.
8. No admin rights needed.
Notes: first launch needs internet to GitHub; unpack of many small files may be slow with antivirus, progress screen must stay responsive; Windows uninstall should also remove %LOCALAPPDATA%\CodeMie\runtime (user's ~/.codemie stays); check with stale-shim fix EPMCDME-15395: codemie.cmd on PATH must only be trusted when its runtime exists.

---

## 2. Codebase Findings

### Existing Implementations
Stack: Tauri v2 (Rust, `src-tauri/`) + vanilla-JS frontend (`ui/`, no package deps; `npm test` = `node --test ui/test/*.test.mjs`). Cargo deps include tokio, reqwest 0.12 (rustls, stream, json — NO `system-proxy`), futures-util, sha2, serde_json, `winreg` (windows), dev: tempfile, tauri-utils.

On this branch (Windows bundling, still current):
- `src-tauri/tauri.windows.conf.json` — bundle.resources ships `bin/codemie.cmd`, `node/node.exe`, `node/npm.cmd`, `node/node_modules/npm`, `cli/node_modules` (the full CLI tree). `tauri.conf.json` declares no resources, NSIS `installMode: currentUser`, hooks `installer-hooks.nsi`, targets dmg+nsis.
- `assets/windows/bin/codemie.cmd` — shim resolves `%~dp0..` (install root), checks `node\node.exe` and `cli\node_modules\@codemieai\code\bin\codemie.js`, appends `%BUNDLE_DIR%\node` to PATH (npm.cmd), execs node, `exit /b %ERRORLEVEL%`.
- `assets/windows/node/*` (node.exe, npm.cmd, node_modules/npm) and `assets/codemie-cli/node_modules` — staged, gitignored artifacts.
- `scripts/stage-runtime.ps1` (+ `.sh`), `build-installer.ps1` — stage, verify (node version, npm, CLI files, `--version` smoke), `npx tauri build --bundles nsis`, post-build asserts that `bin\codemie.cmd`, `node\node.exe`, `cli\...codemie.js` exist in `target\release`. These asserts would FAIL once the runtime is no longer bundled.
- `runtime.json` — nodeVersion 22.23.2, nodeWin64Sha256, nodeMacosArm64Sha256, cliPackage, cliVersion 0.15.2. No `runtimeBaseUrl*` key.
- `src-tauri/src/lib.rs` — setup(): `apply_resolved_shell_path`, builds `own_dirs` (exe dir, resource_dir, `bin` of each, agents bin), `existing_cli_detected = handshake::probe_global_codemie(pre_injection_path, ...)`, `normalize_persisted_path`, then either strips app dirs from PATH + `persist_agents_bin` (existing CLI) or `pathman::inject_bundled_bin_path` (prepends shim dir to PATH and persists to HKCU\Environment via `maybe_persist`). `AppState` gets `pre_injection_path`, `bundled_injected` — NO `existing_cli_detected` field.
- `src-tauri/src/commands/pathman.rs` — `candidate_bin_names()` (`codemie.cmd`,`codemie` on windows), `probe_dir` (simple `exists()` of the shim name, no runtime check), `probe_with_bin_dir`, `inject_bundled_bin_path` (lines ~531-585), `normalize_persisted_path` (windows: no-op).
- `src-tauri/src/commands/handshake.rs` — `probe_global_codemie`, `without_dirs`, `check_handshake_state` (uses `bundled_injected`).
- `src-tauri/src/commands/npm_env.rs` — npm prefix `%USERPROFILE%\.codemie\agents` (user data; stays on uninstall).
- `src-tauri/src/commands/downloader.rs` — existing generic `download_file` streaming + `verify_download` (SHA-256 in memory); reqwest Client without proxy feature.
- `src-tauri/src/commands/mod.rs` — no `runtime` module. `inspector.rs` has `check_node` with `C:\Program Files\nodejs\node.exe` fallback.
- `src-tauri/installer-hooks.nsi` — POSTINSTALL empty; POSTUNINSTALL removes `$INSTDIR\bin` from user PATH via PowerShell. Does not touch `%LOCALAPPDATA%\CodeMie`.
- `ui/renderer.js` `boot()` — no runtime gate; `ui/index.html` — no `runtime-overlay`.
- `ui/test/shim.test.mjs` — asserts the CURRENT Windows shim (`%~dp0..`, `node[\\/]node.exe`, `set "PATH=%PATH%;%BUNDLE_DIR%\node"`, exit code, no codemie.exe) plus macOS shim bundled assertions.
- `src-tauri/tests/bundle_resources.rs` — resources flatten guard (cfg(windows) reads `tauri.windows.conf.json`); returns early on empty map; `bundle_resources_ship_no_pkg_exe`.

Reference MR !53 (mr53.diff, macOS) — what it adds:
- NEW `src-tauri/src/commands/runtime.rs` (414 lines): `Pack{key,url,sha256}` from `include_str!("../../../assets/macos/runtime-pack.json")` (cfg(macos); non-macos gets an empty stub); `runtime_base/runtime_dir/node_exe/cli_entry`; `.complete` marker; `is_ready` (marker + node + cli entry); `ready(existing_cli, smoke, dir_ready)` which is `existing_cli || smoke || !cfg!(macos) || dir_ready` (the `!macos` term is why Windows is currently "always ready" and must be changed); commands `runtime_ready` (needs `state.existing_cli_detected`) and `ensure_runtime` (streams via reqwest, hashes while writing to `.download-<key>.tar.gz`, `verify_sha`, emits `runtime:progress {phase,fraction,total}`, `unpack` via `/usr/bin/tar -xzf` into `.staging-<key>` with cleanup on failure, `promote` = write marker, rename old aside, rename staging to dir, `remove_stale` of everything in base except current key); `CODEMIE_RUNTIME_URL` test override; connect 30s / read 60s timeouts; unit tests (tempfile, system tar).
- `Cargo.toml`: reqwest feature `system-proxy` (lock adds `system-configuration`, `windows-registry`, `core-foundation 0.9.4`) — the `windows-registry` crate reads the Windows system proxy; this is what AC 4 needs.
- `lib.rs`: register `runtime_ready`, `ensure_runtime`; `AppState.existing_cli_detected` set in setup. `state.rs` new field.
- `assets/macos/bin/codemie` shim: reads `runtime-key` next to itself, runtime at `$HOME/Library/Application Support/CodeMie/runtime/$KEY`, requires `.complete`, else "CodeMie is not set up yet. Open CodeMie Connect once to finish setting it up." exit 1; appends `$RT/node/bin` to PATH; exec.
- `tauri.macos.conf.json`: resources reduced to shim + `bin/runtime-key`.
- `scripts/pack-runtime.sh`: key = `<cliVersion>-node<nodeVersion>`, file `codemie-runtime-<key>-darwin-arm64.tar.gz`, URL from `runtime.json` `runtimeBaseUrlMacos` (`https://github.com/codemie-ai/codemie-code/releases/download/runtime-{key}`), writes `assets/macos/runtime-pack.json` + `bin/runtime-key`.
- `build-installer.sh`: runs pack step, asserts `runtime-key` present, node/cli NOT bundled, archive sha equals `runtime-pack.json`, unpacks archive into temp HOME and runs the bundled shim with `env -i`, DMG < 20 MB.
- `ui/index.html` `#runtime-overlay` (title "Preparing CodeMie…", `#runtime-bar`, `#runtime-error`, `#runtime-retry` "Try again"); `ui/renderer.js` `ensureRuntime()` called first in `boot()`: `runtime_ready`, listen `runtime:progress`, `for(;;)` invoke `ensure_runtime`, on error show message + wait for retry click.
- `ui/test/shim.test.mjs`: executed-shim tests (no runtime, runs runtime/passes exit code, no `.complete` marker refused) and renderer/html gate assertions. Also guide edits (architecture, quality-gates, testing-patterns), README, .gitignore.

### Architecture and Layers Affected
Per `.ai-run/guides/architecture/architecture.md` (frontend-brain + thin Rust backend). Layers: build/packaging scripts (PowerShell), Tauri bundle config, NSIS installer hook, Rust command layer (new `runtime` module, `lib.rs` setup/invoke_handler, `state.rs`, `pathman.rs`), Windows `.cmd` shim, frontend boot (`renderer.js`, `index.html`), tests (Rust inline, JS node:test).

### Integration Points
- GitHub Releases (external HTTPS) for the archive; Windows system proxy via reqwest `system-proxy`.
- `pathman::inject_bundled_bin_path` / HKCU PATH persistence — decides whether the shim dir is trusted/persisted; relates to EPMCDME-15395 (not found anywhere in this working tree; no code or docs reference it).
- `handshake::probe_global_codemie` / `existing_cli_detected` — gates download.
- Every CLI-running step goes through `runner.rs`/`pty.rs` using the PATH (shim); `boot()` must wait for the runtime.
- NSIS uninstall hook; `build-installer.ps1`; `runtime.json`.

### Patterns and Conventions
Errors via `InstallerError`/`CmdResult` (`error.rs`); `#[tauri::command]` registered in `lib.rs` invoke_handler (critical rule in AGENTS.md); inline `#[cfg(test)]` modules; cfg(windows)/cfg(not(windows)) split fns; build scripts refuse a verification bypass; shims asserted by regex tests in `ui/test/shim.test.mjs`; resources use plain directory keys (never globs).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` present: `project.md`, `quality-gates.md`, `architecture/architecture.md`, `development/development-practices.md`, `standards/git-workflow.md`, `testing/testing-patterns.md`. quality-gates.md line ~45-47 states the prerequisite that the bundled runtime be staged and describes `build-installer.ps1` post-build checks (MR !53 edits this for macOS). Prior specs: `.ai-run/specs/2026-09-03-EPMCDME-14505-bundled-node-runtime.md` (Windows), `...2026-09-05-EPMCDME-14572-macos-bundled-node-runtime.md`; prior task analyses under `docs/superpowers/tasks/` (e.g. 2026-09-25-EPMCDME-15257-windows).

### Architectural Decisions
- EPMCDME-14581: existing user CLI wins, nothing bundled is installed/registered; Windows PATH registration is done by the app, not NSIS, and uninstall removes `$INSTDIR\bin` from PATH.
- EPMCDME-14572/14505: npm dir appended to PATH only inside the shim.
- EPMCDME-15304: app's own bin dir must not shadow the user's CLI.

### Derived Conventions
See Section 2 Patterns.

---

## 4. Testing Landscape

### Existing Coverage
- `ui/test/shim.test.mjs` (Windows shim regexes, macOS shim, resource config); `ui/test/*.test.mjs` broadly for UI modules.
- Rust inline tests in `pathman.rs` (windows probe tests `tests_windows_probe`, `tests_inject_bundled_bin_path`), `handshake.rs`, `app_updater.rs`, etc.; `src-tauri/tests/bundle_resources.rs`.
- Smoke modes (`CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE`) in `commands/smoke.rs`.

### Testing Framework and Patterns
cargo test with tempfile; Node built-in `node:test`; executed-shim tests in MR !53 use `spawnSync('/bin/sh')` with a fake runtime in a temp HOME — the Windows analogue would need `cmd.exe` (only runnable on a Windows host).

### Coverage Gaps
No tests exist for any download/unpack/promote logic, runtime key, Windows shim executed behavior, or the NSIS uninstall hook. MR !53's `runtime.rs` tests use `/usr/bin/tar` and would not run on Windows as written. No CI config in repo (`.github`, `.gitlab-ci.yml` absent).

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE` (smoke); MR !53 adds `CODEMIE_RUNTIME_URL` (test override). Windows home vars: `USERPROFILE` (npm_env); `LOCALAPPDATA` is not currently referenced in Rust (only a stale legacy `AppData\Local\CodeMie\npm-prefix` candidate in pathman `candidate_dirs`).

### Configuration Files
`runtime.json` (pins; needs a Windows base URL key — MR adds `runtimeBaseUrlMacos` only), `src-tauri/tauri.conf.json`, `tauri.windows.conf.json`, `tauri.macos.conf.json`, `config/steps-windows.yaml`, `installer-hooks.nsi`, `Cargo.toml`/`Cargo.lock`.

### Feature Flags and Deployment Concerns
No flags. Bundled `webviewInstallMode: offlineInstaller`. NSIS per-user (no admin). Archive must be uploaded to GitHub Releases before publishing the installer; sha baked at compile time via `include_str!` of a generated JSON, so the pack step must precede cargo (and `tauri-build` aborts on a missing resource path).

---

## 6. Risk Indicators

- Speculative: archive format on Windows — MR uses `/usr/bin/tar` + tar.gz; Windows 10+ ships `tar.exe` (bsdtar) but a many-small-files unpack (CLI tree ~19.7k files) may be slow under AV; a zip crate or tar.exe choice is a design decision. Unpack must run off the UI thread (spawn_blocking in reference).
- Speculative: Windows rename-based `promote` can fail with locked files (AV/indexer) where macOS does not; retry may be needed.
- Reference `ready()` returns true off macOS and `PACK_JSON` is a stub off macOS; both need Windows handling — porting is not copy-paste.
- `existing_cli_detected` is not in `AppState` on this branch; must be added (reference `state.rs`/`lib.rs`).
- Shim/PATH trust (EPMCDME-15395): no trace in this tree. `probe_dir` trusts `codemie.cmd` by mere existence; `inject_bundled_bin_path` persists the shim dir to HKCU PATH regardless of runtime. Interaction needs spec attention (shim on PATH without runtime must print "Open CodeMie Connect once", and detection must not treat it as a user CLI).
- `inject_bundled_bin_path`/detection uses `current_exe` dir and resource_dir; shim remains bundled, so these keep working, but the shim must locate the runtime key (reference writes a `runtime-key` file beside the shim; Windows would need the same resource entry).
- `build-installer.ps1` post-build asserts and `ui/test/shim.test.mjs` Windows tests assert the old bundled layout and will need rewrite; `bundle_resources.rs` test returns early only on an empty map.
- NSIS uninstall currently does not remove `%LOCALAPPDATA%\CodeMie\runtime`; hook uses PowerShell for PATH edit.
- Proxy: reqwest needs `system-proxy` feature (Cargo.lock change pulls windows-registry); PAC/authenticated proxies not covered by that feature — AC4 says "configured in Windows settings".
- Many UI steps may run the CLI at boot; gating must precede them (smoke mode must not block).
- Update flow (new Node/CLI on app update, remove old) is covered by `remove_stale` keyed on version; interplay with `app_updater.rs` unverified.
- Windows uses a different Node archive layout (`node.exe` at node root, `npm.cmd`, `node_modules/npm`), so reference `node_exe()`/PATH dir (`node/bin`) differ.
- Release publishing/URL scheme for a Windows artifact (name, tag) is undecided; `runtime.json` has no Windows URL key.

---

## 7. Summary for Complexity Assessment

The change spans build scripts (new pack step plus rewritten `build-installer.ps1` assertions), Tauri bundle config, the Windows `.cmd` shim, NSIS uninstall hook, a new Rust `runtime` module wired into `lib.rs`/`state.rs`/`Cargo.toml`, and a frontend boot gate with overlay and retry. The reference MR !53 supplies a macOS implementation (~414-line `runtime.rs`, renderer overlay, shim, pack script, tests) that does not exist in this working tree, so everything — runtime module, `AppState.existing_cli_detected`, overlay, `ensureRuntime`, `runtime.json` URL key, pack script, `system-proxy` feature — must be ported or added, with Windows-specific adaptation (paths under `%LOCALAPPDATA%`, archive tool/format, `.cmd` semantics, node layout, file-lock-tolerant promote).

Technical novelty is moderate: the design is proven on macOS, but Windows-specific concerns (AV-slow unpack, rename of locked directories, system proxy, `.cmd` shim, NSIS cleanup) are new here. Test posture: Rust inline and node:test patterns exist and the reference tests are portable in concept, but nothing exists for download/unpack and the macOS tests rely on `/usr/bin/tar` and `/bin/sh`; existing Windows shim and bundle tests must be rewritten. EPMCDME-15395 is absent from the tree, so the PATH-trust requirement is unverified against existing code.

Key risks are the shim/PATH-trust interaction in `pathman.rs`/`handshake.rs`, archive/unpack choice and Windows file locking, proxy coverage, and the build/verify pipeline consistency (sha baked into the app must match the published archive). No CI config in-repo and manual Windows verification are needed.

---

## 8. External References

- `C:/Users/RatiGigauri/AppData/Local/Temp/claude/C--Users-RatiGigauri-source-codemie-claude-installer-macos/86eeeec2-0704-48dc-a2e0-d8899a89c49a/scratchpad/mr53.diff` — resolved (1174 lines). Facts captured in Section 2 ("Reference MR !53"): key = `<cliVersion>-node<nodeVersion>`, `.complete` marker written last, sha256 verified while streaming, staging dir + cleanup on failure, remove_stale of other keys, `system-proxy` reqwest feature, `runtime:progress` event payload `{phase, fraction, total}`, shim message "CodeMie is not set up yet. Open CodeMie Connect once to finish setting it up.", overlay copy "Preparing CodeMie…" / "Couldn't download CodeMie" / "Try again", base URL pattern `https://github.com/codemie-ai/codemie-code/releases/download/runtime-{key}`, DMG size gate < 20 MB.
- EPMCDME-15395 (stale-shim fix) — named by the task but no file or code in this repo references it; unresolved/unavailable locally.
