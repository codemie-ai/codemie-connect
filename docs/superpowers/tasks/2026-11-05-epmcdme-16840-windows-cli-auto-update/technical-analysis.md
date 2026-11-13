# Technical Research

**Task**: windows managed-cli update npm (EPMCDME-16840)
**Generated**: 2026-11-05
**Research path**: filesystem

---

## 1. Original Context

CodeMie Connect (Windows): update the managed CLI to the latest version. Summary: Add a post-setup update check for the CLI managed by CodeMie Connect on Windows. Connect checks npm for a newer CLI version and updates its managed CLI on macOS, but skips this post-install check on Windows (users stay on version pinned by their Connect build). Add equivalent behavior in Windows update flow: check for newer version, install and validate it safely, switch to it only after successful update. Failed update must leave the working CLI in place. Preconditions: Windows, managed CLI, setup completed, npm reachable. Scenarios: (1) after setup, check npm; if newer, install+validate before switching. (2) if check/install/validation fails, keep previous working CLI. (3) if user has own CLI install, or smoke mode, skip update. Affected areas: Windows post-setup update flow; managed-runtime installation, validation, version selection. Acceptance: on Windows after setup Connect checks npm and installs newer CLI for managed runtime; switches only after install+validation succeed; failed/incomplete update leaves current CLI; skips for user-managed CLI and smoke mode; verification covers both a newer npm version and a failed update. Ticket: EPMCDME-16840. Project guides in .ai-run/guides/ (architecture: frontend-brain + thin Rust backend; Rust commands run from src-tauri/). Find the existing macOS update logic and the Windows managed runtime download/install code to reuse.

---

## 2. Codebase Findings

### Existing Implementations

Purpose A: keep the managed CLI current from npm after launch.
- Tauri command `update_cli` -- `src-tauri/src/commands/runtime.rs:36`; dispatches to `imp::update_cli(state.existing_cli_detected)` (`imp` = `mac` on non-windows, `win` on windows, `runtime.rs:11-14`). Registered `lib.rs:101`.
- Sole caller: `ui/renderer.js:897` in `boot()`, fire-and-forget (`.then(version => version && refreshAgents()).catch(()=>{})`); `ui/test/shim.test.mjs:326-327` asserts it is after `refreshAgents()` and never awaited. Not gated on "setup completed".
- macOS impl: `mac::update_cli` `runtime.rs:292` -> `check_and_update_cli` `:307`. Rules: skip if `existing_cli || !macos || smoke_mode()`; `remove_stale`; current = `linked_version(cli_link,"cli-")`; GET `REGISTRY_LATEST` (`:67`, `https://registry.npmjs.org/@codemieai/code/latest`) via reqwest `client()` (30s connect/60s read); `newer(latest,current)` numeric dotted compare (`:142`; prerelease suffixes parse to 0); `install_cli(base, latest, locked=false)`; returns `Some(version)`. Logs success (info) / failure (warn) via `logger::write_line`.
- macOS `install_cli` `:410`: install into unique `attempt_path` staging dir, `npm install` of `{"@codemieai/code": version}` with 600s timeout (`NPM_TIMEOUT`), proxy from scutil, checks `cli_entry` exists, writes `codemie-connect.json` marker, **validates** by running `node codemie.js --version` (60s `CLI_CHECK_TIMEOUT`) and requiring the last stdout line equal the version (`reports_version :128`), writes `.complete`, renames to `cli-<v>`, **switches** via atomic symlink swap `switch_link :191`; staging removed on error. Previous `cli-<old>` dir stays until next launch (`remove_stale :206`).
- Windows impl: `win::update_cli` `runtime.rs:1240-1278` ALREADY EXISTS and runs. Rules: skip only if `existing_cli`; needs `is_ready(runtime_dir())`; in `spawn_blocking` runs `node npm-cli.js install @codemieai/code@latest --omit=dev --no-audit --no-fund` with cwd = the live `<runtime_dir>\cli`, **in place**; on exit 0 rewrites `codemie-connect.json`; then `remove_stale(base, runtime_key(cfg))`. No registry version check, no staging, no `--version` validation, no smoke check, no timeout, no logging, always returns `Ok(None)` (so UI never refreshes agents), ignores spawn failure silently.
- Windows layout: `%LOCALAPPDATA%\CodeMie\runtime\<cliVersion>-node<nodeVersion>\{node\,cli\,.complete}` (`runtime_base :760`, `runtime_key :755`, `runtime_dir :766`, `is_ready :817` = marker + node.exe + npm.cmd + cli entry). No symlinks (comment `runtime.rs:3-4`: need Developer Mode/admin). Directory key comes from the pinned `runtime.json` (`cliVersion 0.16.3`, `nodeVersion 22.23.2`).
- Windows install pieces reusable: `npm_install_cli :1190` (writes `{}` package.json, `npm install pkg@ver`, logs stdout/stderr, errors via `at()`), `path_with :1179`, `npm_cli :796`, `node_exe :774`, `cli_entry :778`, `connect_json_path :787`, `promote :902` (writes marker, moves old dir aside to `.old-<key>`, `rename_retry :887` 5x for AV locks), `remove_stale :930` (deletes everything under base except `keep`), `at :847`, `chain :857`, `INSTALL_LOCK` inside `ensure_runtime :1005` (not taken by `update_cli`). `install_sync :1105` builds `staging\{node,cli}` then `promote`.
- Windows `ensure_runtime :1003`: returns early if `is_ready(runtime_dir())`; otherwise downloads Node zip (SHA-256 verified), `install_sync`, `remove_stale(base, key)`. Always installs pinned `cliVersion` via `npm_install_cli`; no `--version` validation exists anywhere on Windows.
- Windows `runtime_ready :839` / `ready :828`: true when `existing_cli || smoke || dir_ready`.
- `smoke_mode()` is duplicated per module: `win :832`, `mac :165` (`CODEMIE_SMOKE` or `CODEMIE_PROBE_SMOKE` env set). Also `commands/smoke.rs` (not read in depth).

Purpose B: how the CLI actually launches (consumer of "which CLI version is active").
- `assets/windows/bin/codemie.cmd` (same file under every command name): reads `runtime-key` file next to itself (written at build by `build-installer.ps1:14-21`, verified `:40` equals `runtime.json`), runs `%LOCALAPPDATA%\CodeMie\runtime\<KEY>\node\node.exe <KEY>\cli\node_modules\@codemieai\code\bin\<entry>`; requires `.complete`. The key is the build-pinned `<cliVersion>-node<nodeVersion>`; there is no pointer/link the app can retarget at runtime. Whatever sits at `<KEY>\cli\...` is what runs.
- Existing-CLI detection: `lib.rs:42-86` sets `AppState.existing_cli_detected` (`state.rs:28`); `handshake.rs:16-58` trusts a Windows `codemie.cmd` in `%LOCALAPPDATA%\CodeMie\bin` only with a paired `npm-prefix\codemie.cmd`.

Purpose C: "setup completed" signal. Not found in Rust: `update_cli` takes only `existing_cli`. Frontend completion state lives in `ui/home-state.js`, `ui/setup-view.js` (`cfg.state === 'valid'`), `ui/home-view.js` (`done`). Searched `update_cli|setup complete` in ui/ and src-tauri/src.

Other touched code: `ui/runner-bridge.js` (no `update_cli` wrapper; `renderer.js` invokes directly); `ui/cli-update.js` (`semverLt`, unrelated agent/app compare); `src-tauri/installer-hooks.nsi:23` (uninstall removes whole `runtime` dir).

### Decisions Already in the Code

- Unique staging, validate, then promote, never mutate live dir: macOS `install_cli` `:410-495`; Windows `promote :902` doc: "a crash never leaves `dir` without a complete runtime". Convention for readiness: `.complete` marker written last.
- Version authority is macOS "newest wins": `is_ready` accepts CLI >= pin (`mac :150`); stale cleanup runs at launch only so a CLI in use is never pulled away (`mac :202-205` doc). Windows `is_ready` does not read a version at all.
- Windows deliberately avoids symlinks (`runtime.rs:3-4`); macOS uses links. No recorded decision for how Windows would select a newer CLI version. `runtime-key` shim indirection is baked at build.
- `update_cli` is non-fatal and non-blocking by design (`renderer.js:895-901`, doc `runtime.rs:1238-1239`).
- Windows `npm_install_cli` comment `:1193-1194`: exact version pin; package.json `{}` required so npm does not walk up to a stray node_modules (`:1196-1198`).
- Data direction: Windows stores no installed-CLI version except directory name (pinned) and `.complete` content (key). The installed version is only in `cli\node_modules\@codemieai\code\package.json` (not read anywhere in Rust on Windows). macOS stores it in the dir name `cli-<v>`.
- Decision records in `.ai-run/decisions/` (14514 agent-version-authority, npm-for-agent-install) concern agent installs, not the CLI runtime; specs `.ai-run/specs/2026-09-03-EPMCDME-14505-bundled-node-runtime.md` and `2026-09-05-EPMCDME-14572-...` are the runtime design records (not read in detail).

### Task Statements Checked Against the Code

- "Connect ... skips this post-install check on Windows": **contradicted in part**. `win::update_cli` `runtime.rs:1240` runs `npm install @latest` in place on every launch (no version check, no validation, no smoke skip). The macOS-only gate `!cfg!(target_os="macos")` is in `mac::check_and_update_cli :308`, not in the Windows module. Observable on Windows: update not reported to UI (`Ok(None)`) and not validated.
- "users stay on version pinned by their Connect build": holds for the shim key/dir name; but the in-place install can already change the files under the pinned-key dir.
- "updates its managed CLI on macOS": holds (`mac :292-335`).
- "skip for smoke mode": macOS holds (`:308`); Windows update does **not** check smoke (`win::update_cli :1241` only `existing_cli`). Keeps nothing.
- "skip for user-managed CLI": holds on both (`existing_cli` param).
- "switch to it only after successful update": no Windows switch mechanism exists; keeps in place the runtime-key dir that the shim addresses (`codemie.cmd`) and `is_ready`/`runtime_ready` (`:817`, `:839`) which consumers expect at `<key>\cli` + `.complete`.
- "after setup": unverified in Rust; `boot()` calls `update_cli` at every app start regardless of setup state (`renderer.js:897`).
- "npm reachable": no pre-check on Windows; macOS fetches registry JSON via reqwest.
- "Find the existing macOS update logic ... reuse": macOS code is in `mod mac` (`#[cfg(not(windows))]`), not compiled on Windows; `newer`, `reports_version`, `REGISTRY_LATEST`, `attempt_path`, `NPM_TIMEOUT`, `CLI_CHECK_TIMEOUT` are private to it. Windows has its own `win` module with parallel helpers (`hex`, `smoke_mode`, `verify_sha`, `ready` duplicated).

### Consumers of Changed Contracts

Contract: what lives at `<runtime_dir>\cli` and what `update_cli` returns/does.
- `codemie.cmd` shim (`assets/windows/bin/codemie.cmd`): runs `<KEY>\cli\node_modules\@codemieai\code\bin\<entry>`; requires `<KEY>\.complete`; `ui/test/shim.test.mjs:15-40` asserts key path, `.complete`, `node\node.exe`, `bin` entry names.
- `win::is_ready :817`: requires marker, node.exe, npm.cmd, `cli_entry`; used by `runtime_ready`, `ensure_runtime`, `update_cli`.
- `ensure_runtime` / `remove_stale(base, key)` `:930, :1083, :1271`: delete everything under `runtime\` except the pinned-key dir -- any sibling dir used for a newer CLI would be deleted by these (also uninstall `installer-hooks.nsi:23`).
- Running processes: the shim and CLI-spawned agents/proxy run from `<KEY>\cli`; on Windows files in use are locked (`rename_retry` exists for AV holds; `promote` renames whole key dir).
- `ui/renderer.js:897-901`: uses return value only to `refreshAgents()`; `ui/test/shim.test.mjs:324-328`, `ui/test/runtime-gate.test.mjs` exercise `runtime_ready`/`ensure_runtime` invocation order.
- `commands/handshake.rs`, `pathman.rs`, `inspector.rs` probe the CLI (version/`codemie` lookups) -- not read for dependency on dir layout; searched `runtime_dir|runtime_base|cli_entry|LOCALAPPDATA` outside runtime.rs: only handshake.rs and installer-hooks.nsi.
- `runtime.json` `cliVersion`/`build-installer.ps1` key check: a changed layout must still match `runtime-key`.

### Architecture and Layers Affected

- Rust backend only for the mechanism: `src-tauri/src/commands/runtime.rs` `mod win` (+ possibly sharing with `mod mac`). Frontend: `ui/renderer.js` call site (unchanged unless gating on setup completion or return handling). Shim `codemie.cmd` and `build-installer.ps1` only if the switching mechanism changes how the version is located.

### Integration Points

- npm registry `https://registry.npmjs.org/@codemieai/code/latest` (macOS only today); `npm install` via bundled node.exe + npm-cli.js; reqwest 30s/60s timeouts; `logger::write_line`; env `CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE`, `CODEMIE_RUNTIME_URL` (Node zip override). No Windows proxy handling for npm (macOS reads scutil); Windows relies on env/.npmrc.

### Patterns and Conventions

- Per `.ai-run/guides/architecture/architecture.md`: new commands registered in `lib.rs`, `CmdResult<T>`, thin Rust, tests inline `#[cfg(test)]`; errors named via `at()`; per-OS `mod mac`/`mod win` with `imp` alias; Windows-only fns carry `#[cfg(windows)]` while `mod win` itself is compiled only on Windows.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md:52` documents `update_cli` as "installs a newer npm release in the background" with macOS link layout only; no Windows update description. `testing-patterns.md`: runtime tests take explicit paths in tempdirs, no network. `quality-gates.md`: cargo fmt, clippy `-D warnings`, cargo test, npm test; CI `.github/workflows/ci.yaml:29-43`.

### Architectural Decisions
- No ADR on Windows CLI update or version selection (searched `.ai-run/decisions`, `docs/`). Runtime specs under `.ai-run/specs/` exist (not read in detail).

### Derived Conventions
- Stage under unique path, validate by running the CLI, marker last, atomic switch, delete old at next launch.

---

## 4. Testing Landscape

### Existing Coverage
- `runtime.rs` `mod tests` (mac, `:503-707`): `newer`, `is_ready`, `switch_link`, `remove_stale`, `reports_version`, `attempt_path` (mostly `#[cfg(unix)]`). Windows tests `:1280-1524`: `is_ready` without marker/npm.cmd, `promote`, `at`, `chain`, `remove_stale`, `runtime_key`, `serve_once` local HTTP server for `download_verified` (a pattern for faking a registry).
- JS: `ui/test/shim.test.mjs` (shim + boot ordering of `update_cli`), `runtime-gate.test.mjs`.

### Testing Framework and Patterns
- Rust built-in `#[test]`/`#[tokio::test]`, tempdir layouts, no mocks; JS `node --test` source-text assertions and stubbed `invoke`.

### Coverage Gaps
- No test of `win::update_cli` (success, failure, skip). No fake npm/node for a Windows install; spawning real npm is the only current path (`npm_install_cli` untested). Windows tests only run on a Windows runner; check whether CI uses one.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE` (smoke), `CODEMIE_RUNTIME_URL` (Node zip override, Windows), `LOCALAPPDATA`, `PATH`, `HTTPS_PROXY`/`HTTP_PROXY` (mac install).

### Configuration Files
- `runtime.json` (pins), `assets/codemie-cli/package.json|package-lock.json` (embedded for macOS `npm ci`; Windows does not use them), `assets/windows/bin/runtime-key` (generated by `build-installer.ps1`), `src-tauri/tauri.windows.conf.json`.

### Feature Flags and Deployment Concerns
- None for update. NSIS uninstall wipes `%LOCALAPPDATA%\CodeMie\runtime` (`installer-hooks.nsi:23`).

---

## 6. Risk Indicators

- Existing Windows `update_cli` (`runtime.rs:1240-1278`) already mutates the live CLI in place with no validation or smoke guard; failed/partial `npm install` can leave `<key>\cli` broken while `.complete` remains (see Task Statements).
- The task's premise "Windows skips the check" does not match the code; the work replaces behavior that ships today.
- No Windows mechanism to select a version: shim is bound to build-time `runtime-key`; `remove_stale` and `ensure_runtime` delete non-key dirs; no symlinks. Speculative: any "switch" design must cooperate with shim, `is_ready`, `remove_stale`, uninstall.
- Windows file locking: CLI/proxy/agents running from `<key>\cli` can block rename/replace (`rename_retry` only handles transient AV holds). Speculative: swap while a CLI process is active may fail.
- `update_cli` does not take `INSTALL_LOCK`, so it can race `ensure_runtime` (same `.staging-<key>` names) on first launch.
- macOS helpers (`newer`, `reports_version`, constants) are in a cfg-excluded module; sharing needs moving them out of `mod mac`. `newer` ignores prerelease tags.
- Update runs at every `boot()` regardless of setup completion; "setup completed" has no backend signal.
- Tests: Windows branch needs Windows CI/dev machine; no fake npm/registry harness (existing `serve_once` local-server pattern could be a base).
- Windows npm proxy support absent in the install path (corporate networks).
- Undocumented: no ADR/guide describes Windows update; architecture guide describes macOS only.

---

## 7. Summary for Complexity Assessment

The change sits in one backend file, `src-tauri/src/commands/runtime.rs`, in the `win` module (with optional extraction of shared helpers from `mac`), plus a possible small touch to `ui/renderer.js` and, depending on the version-selection mechanism, `assets/windows/bin/codemie.cmd` and `build-installer.ps1`. Pieces for registry check, staged install, `--version` validation, marker and promote exist across `mac` (check/validate/switch) and `win` (npm install, promote, rename retry); none is shared across the cfg boundary.

The Windows updater already exists in a weaker form (in-place `npm install @latest`, no validation, no smoke skip, returns `None`), so this is a replacement of live behavior rather than a greenfield add. The main novelty is "switching" on Windows: the shim resolves a build-time `runtime-key` directory, symlinks are avoided, and cleanup code deletes anything not matching the pinned key, so version selection touches shim, readiness, cleanup and uninstall contracts.

Test posture: Windows runtime helpers have unit tests (promote, is_ready, remove_stale, local HTTP server pattern); `update_cli` itself and npm installation are untested on both platforms except macOS pure helpers. Acceptance requires covering a newer-version success and a failed update, which needs an injectable registry/npm command or tempdir fake. Key risks: file locking of a running CLI, race with `ensure_runtime`, contract with the shim and `remove_stale`.

---

## 8. External References

None named by the task
