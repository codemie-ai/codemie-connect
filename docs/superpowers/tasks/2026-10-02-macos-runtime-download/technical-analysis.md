# Technical Research

**Task**: runtime download tauri macos installer (EPMCDME-15548)
**Generated**: 2026-10-02
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15548 — CodeMie Connect (macOS): download Node.js and the CodeMie CLI on first launch instead of bundling them.

Summary: The macOS installer no longer carries Node.js and the CodeMie CLI. On first launch the application downloads them once, as one verified archive. DMG goes ~100 MB -> ~2.4 MB.

What changes:
- The build packs Node.js and the CodeMie CLI into one archive per release, published on GitHub Releases. The app only accepts the archive it was built with (SHA-256 baked into the build).
- On first launch the app shows "Preparing CodeMie…" with progress, downloads the archive and unpacks it into ~/Library/Application Support/CodeMie/runtime/<version>.
- If download fails, the app says so and offers Try again. A half-finished download or unpack is never used.
- The `codemie` command in a terminal uses the downloaded runtime. Before it is downloaded, it tells the user to open CodeMie Connect once.
- If the user already has their own CodeMie CLI, nothing is downloaded and that CLI is used, as today.
- When an app update needs a new CLI or Node version, the app downloads it the same way and removes the old one.

Acceptance Criteria:
1. Fresh install, first open: Node.js and CLI downloaded once with visible progress; later launches do not download.
2. No internet / blocked download: failure shown with Try again, works after successful retry.
3. Damaged, modified or incomplete download is never used; nothing half-installed remains.
4. Behind a system-settings proxy: download goes through that proxy.
5. After download, sign-in, guided setup, Tools, Health and Connections work as with the bundled runtime.
6. Machine with an existing CodeMie CLI: nothing downloaded.
7. `codemie --version` in a new terminal after first launch prints the CLI version.
Notes: first launch needs internet to GitHub; removing the app leaves ~350 MB runtime in Application Support; Windows is EPMCDME-15549 (out of scope).

Known facts from the requester (reference implementation, build on it, don't redesign):
- ~/codemie-installers/runtime-download-poc is a plain copy (not a git repo) of a working reference; ~/codemie-installers/runtime-download-poc/poc.diff has all 12 changed files against commit eec4d45. Tested in the real app. poc-test/slowserve.py and poc-test/launch.sh there are local test helpers (CODEMIE_RUNTIME_URL points the app at a local server).
- The diff applies to main EXCEPT src-tauri/src/lib.rs and src-tauri/src/commands/mod.rs. Main's AppState no longer has node_exe_path, cli_entry_path or existing_cli_detected, so runtime_ready needs an existing-CLI flag kept in AppState again. Don't reuse bundled_injected for it (also false when PATH injection fails).
- reqwest is built with default-features = false, turning system proxy off; add the "system-proxy" feature in src-tauri/Cargo.toml.
- build-installer.sh runs scripts/stage-runtime.sh (line ~52) and `cargo tauri build` (line ~100). scripts/pack-runtime.sh must run between them, since runtime.rs reads assets/macos/runtime-pack.json with include_str! and the build fails without it. runtime-pack.json and bin/runtime-key are generated and stay gitignored.
- Uploading the archive to GitHub Releases is out of scope; runtime.json's runtimeBaseUrlMacos holds where it will live.
- .codemie/codemie-cli.config.json is modified locally; never touch/commit it.

---

## 2. Codebase Findings

### Existing Implementations

Project: Tauri 2.11.2 app (Rust backend in `src-tauri/`, vanilla ES-module frontend in `ui/`, no bundler). Manifest `package.json` only has `npm test` = `node --test ui/test/*.test.mjs`. No `.codegraph/` index exists.

poc.diff (557 lines, 12 files) checked with `git apply --check` against main:
- Applies cleanly (10 files): `.gitignore`, `runtime.json`, `scripts/pack-runtime.sh` (new), `assets/macos/bin/codemie` (shim rewrite), `src-tauri/Cargo.toml`, `src-tauri/tauri.macos.conf.json`, `src-tauri/src/commands/runtime.rs` (new), `ui/index.html`, `ui/renderer.js`, `ui/test/shim.test.mjs`.
- Fails: `src-tauri/src/lib.rs` (hunk at line 75) and `src-tauri/src/commands/mod.rs` (hunk at line 10). Exactly these two, as the requester said.

Hunk-by-hunk adaptation:
- `commands/mod.rs`: main has more modules (`app_updater, codemie_config, downloader, handshake, inspector, installer, logger, npm_env, pathman, pty, runner, smoke, window`). Only change needed is `pub mod runtime;` after `pub mod runner;`.
- `lib.rs` hunk 1 (node_exe/cli_entry resolution block): irrelevant on main. Main's setup() (`src-tauri/src/lib.rs:11-95`) no longer computes node_exe/cli_entry and `AppState` (`src-tauri/src/state.rs`) has only `remembered, pty, pre_injection_path, bundled_injected, last_update_check`. This hunk must be dropped, not ported.
- `lib.rs` hunk 2 (invoke_handler): main's handler list has no `run_self_update` / `cli_is_bundled`; add `commands::runtime::runtime_ready` and `commands::runtime::ensure_runtime` to `tauri::generate_handler![...]` (e.g. after `commands::runner::run_stream`).
- Missing piece: `existing_cli_detected` is a local `let` in setup (`lib.rs:41`) and is only used for logging/PATH handling; `app.manage(AppState { pre_injection_path, bundled_injected, ..AppState::default() })` at `lib.rs:71-75`. `runtime.rs::runtime_ready` reads `state.existing_cli_detected`, so `AppState` needs a new `pub existing_cli_detected: bool` and the manage call needs it set. `bundled_injected` is false in two cases (existing CLI, and `inject_bundled_bin_path` failure), so it cannot stand in.
- `runtime.rs` (new, 221 lines in poc): `Pack{key,url,sha256}` via `include_str!("../../../assets/macos/runtime-pack.json")` (cfg macos; non-macos fallback is an all-empty JSON), `runtime_dir/node_exe/cli_entry/is_ready`, `runtime_ready` and `ensure_runtime` commands, three inline tests. Flow: wipe leftovers, stream download with `runtime:progress` events, SHA-256 compare while streaming, `/usr/bin/tar -xzf` into `.staging-<key>`, verify node + CLI entry, write `.complete`, rename staging into `<key>`, delete sibling dirs in the runtime base. `CODEMIE_RUNTIME_URL` env overrides the URL (test hook, remains in production code).
- Shim `assets/macos/bin/codemie`: now resolves `runtime-key` next to itself, `$HOME/Library/Application Support/CodeMie/runtime/$KEY/.complete`, prints "CodeMie is not set up yet. Open CodeMie Connect once…" and exits 1 otherwise; appends `$RT/node/bin` to PATH (keeps EPMCDME-14572 behaviour); execs node on `codemie.js`.
- Frontend: `ui/renderer.js` hunk adds `ensureRuntime()` and calls it first in `boot()` (main's `boot()` at `renderer.js:676`; `listen` is destructured at line 28 so the hunk compiles). `ui/index.html` gets the `#runtime-overlay` with inline styles (CSP in `tauri.conf.json:25` has `style-src 'unsafe-inline'`, so allowed).
- `tauri.macos.conf.json` on main bundles node, npm, npm lib and the CLI tree; poc cuts it to shim + `runtime-key`. `tauri.conf.json` shared has no resources (asserted by shim.test.mjs).
- `reqwest` in `Cargo.toml:35` is `default-features=false, features=["rustls-tls","stream","json"]`; Cargo.lock resolves 0.12.28 and that version defines the `system-proxy` feature (`reqwest-0.12.28/Cargo.toml:180`, `hyper-util/client-proxy-system`), so the poc feature edit is valid.

### Architecture and Layers Affected

- Build/packaging: `build-installer.sh`, `scripts/stage-runtime.sh` (unchanged), new `scripts/pack-runtime.sh`, `runtime.json`, `.gitignore`, `src-tauri/tauri.macos.conf.json`, `assets/macos/bin/codemie`.
- Rust backend: new `commands/runtime.rs`, `commands/mod.rs`, `lib.rs` (registration + AppState wiring), `state.rs`, `Cargo.toml`.
- Frontend: `ui/index.html` (overlay), `ui/renderer.js` (boot gate). `runner-bridge.js` is the usual IPC wrapper layer (architecture guide step 5), but the poc calls `invoke` directly from `renderer.js`.
- Tests: `ui/test/shim.test.mjs` (Rust tests inline in runtime.rs).
- Docs/guides: see Section 3.

### Integration Points

- PATH: setup() calls `pathman::inject_bundled_bin_path` (`pathman.rs:531`) which finds the shim dir via `current_exe()` parent or `resource_dir()` and prepends/persists it to `~/.zprofile`. The shim stays in `Contents/Resources/bin`, so this keeps working unchanged; the shim itself finds the runtime under Application Support.
- Existing CLI: `handshake::probe_global_codemie` on the pre-injection PATH (`lib.rs:41`); `normalize_persisted_path` and `persist_agents_bin` follow. `handshake::check_handshake_state` reads `state.bundled_injected` (`handshake.rs:107`); untouched.
- Dev builds skip `.zprofile` persistence (`cfg!(debug_assertions)`).
- `downloader.rs` (generic `download_file`, `reqwest::Client::builder()` at line 62), `app_updater.rs` (reqwest Client) and `installer.rs:46` (`reqwest::get` to nodejs.org) all share the reqwest feature set, so enabling `system-proxy` changes proxy behaviour for them too.
- Smoke modes: `smoke_mode` (`commands/smoke.rs`) is invoked in `boot()` right after the command-log is wired (`renderer.js:681`); the poc puts `ensureRuntime()` before that call.
- npm: the shim's appended `$RT/node/bin` is how agent installs find `npm` (EPMCDME-14572/15180). Nothing in Rust spawns node/npm by absolute path on main (grep for `node_exe`, `node/bin`, `cli_entry` finds no Rust consumers).

### Patterns and Conventions

- New command = module in `commands/`, `#[tauri::command]`, `CmdResult<T>`, register in `lib.rs`, JS wrapper in `runner-bridge.js`, inline `#[cfg(test)]` tests (architecture guide "Adding New System Commands"). `InstallerError` has `Io, Download, Pty, Other` variants (`error.rs`); runtime.rs uses `Download` and `Other`.
- JS tests read source files and assert on text (shim.test.mjs style) as well as pure-module tests.
- Branch/commit: `feat/EPMCDME-15548-...` (current branch `feat/EPMCDME-15548-macos-runtime-download`), commit subject `EPMCDME-15548 : subject`, no Co-Authored-By line (user memory).

---

## 3. Documentation Findings

### Guides and Architecture Docs

`.ai-run/guides/` present: `project.md`, `quality-gates.md`, `architecture/architecture.md`, `development/development-practices.md`, `standards/git-workflow.md`, `testing/testing-patterns.md`. Read: architecture, testing, quality-gates. Guides that go stale with this change:
- `quality-gates.md` "Build" section: states the bundled runtime "must be staged once per checkout or `tauri-build` aborts every cargo command". After the change cargo also needs `assets/macos/runtime-pack.json` (include_str!) and `assets/macos/bin/runtime-key` (resource), so `scripts/stage-runtime.sh` then `scripts/pack-runtime.sh` before any cargo command. It also says `./build-installer.sh` "assert[s] every artifact".
- `architecture/architecture.md`: component map lacks `commands/runtime.rs`; "Configuration" table and `state.rs` description (`AppState { remembered, pty }`, already out of date) should mention the runtime pack/existing-CLI flag.
- `testing/testing-patterns.md`: test organization list; add runtime.rs and note shim.test.mjs.
- `README.md:85-91` says "The DMG ships the CodeMie CLI with its own Node runtime" and "asserts every bundled artifact before and after the Tauri build"; also lines ~46-55 module list.
- `docs/windows-build.md` and `AGENTS.md` need no change (Windows out of scope).

### Architectural Decisions

- Option B (frontend brain, thin Rust) — `ensureRuntime` flow lives in JS, download/verify/unpack in Rust, consistent.
- EPMCDME-14581: existing CLI on PATH wins and the bundle is not installed/registered; EPMCDME-15304: persisted PATH normalization drops the app's own bin dirs when an existing CLI is used; EPMCDME-14572: bundled npm is appended (not prepended) to PATH by the shim; EPMCDME-15247: one update for app and CLI.
- `build-installer.sh` header: "There is deliberately no switch to skip verification... Do not add a bypass."

### Derived Conventions

- Generated assets are gitignored (`assets/macos/node/`, `assets/staging-manifest.json`); poc adds `assets/macos/runtime-pack.json` and `assets/macos/bin/runtime-key`. The poc's `poc-test/` ignore line is poc-local and should not be carried over.
- Shell scripts use `fail()`/`step()` helpers, `cfg()` reading runtime.json with node.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/shim.test.mjs` (4.9K): asserts text of the macOS shim, `runtime.json`, `tauri.macos.conf.json`, and that `tauri.conf.json` has no shared resources. The poc diff rewrites the macOS-shim tests to the new shape and applies cleanly.
- Rust inline tests: `runner.rs`, `logger.rs`, `handshake.rs`, `pathman.rs` (extensive, incl. `is_app_bin`/`normalize_blocks`), `npm_env.rs`.
- 40+ JS test files in `ui/test/` (engine, setup-driver, health, home-state, etc.).
- No tests for `renderer.js` boot flow (renderer is not unit-testable; logic lives in separate modules).

### Testing Framework and Patterns

- Rust: `cargo test`, inline `#[cfg(test)]`, real system (no mocks), `tempfile` dev-dep already present, `#[tokio::test]` for async. JS: `node:test` + `node:assert/strict`, text-assertion tests for shell/config files.
- poc tests in runtime.rs: marker-required readiness, baked pack completeness, hex vs known SHA-256.

### Coverage Gaps

- `ensure_runtime` (download/verify/unpack/cleanup/old-runtime removal) has no automated test in the poc; AC2, AC3, AC4 are only verifiable manually (poc-test `slowserve.py` serves a file at a given rate, `launch.sh` starts the built app with clean env and `CODEMIE_RUNTIME_URL`).
- The download retry loop in `renderer.js` is untestable as is (inline in boot). Extracting a pure helper/state machine (progress text/percent) into a module would allow node:test; this is a design option, not a finding.
- Shim behaviour (run with a fake HOME and a pre-populated runtime dir) is only text-asserted, not executed.
- `runtime_ready` with existing-CLI flag has no test; `is_ready`-style logic can be tested with tempdir.
- The `the_baked_pack_is_complete` test reads the generated `runtime-pack.json`, so `cargo test` depends on `pack-runtime.sh` having run.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_RUNTIME_URL` (poc, new): overrides archive URL; test-only but compiled into production.
- Existing: `CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE`, `CODEMIE_DEV`, `CODEMIE_SMOKE_MS`, `CODEMIE_SHOT` (smoke.rs); `HOME` is read for the runtime path.
- `CARGO_TARGET_DIR` is read by `build-installer.sh`.

### Configuration Files

- `runtime.json`: pins `nodeVersion` 22.23.2, `nodeMacosArm64Sha256`, `cliPackage`, `cliVersion` 0.15.2; poc adds `runtimeBaseUrlMacos` = `https://github.com/codemie-ai/codemie-code/releases/download/runtime-{key}`. Archive name `codemie-runtime-<cli>-node<node>-darwin-arm64.tar.gz`, key = `<cli>-node<node>`.
- Generated (gitignored by poc): `assets/macos/runtime-pack.json` {key,url,sha256,size}, `assets/macos/bin/runtime-key`, archive in `dist/` (already gitignored).
- `src-tauri/tauri.macos.conf.json` resources; `src-tauri/tauri.windows.conf.json` still bundles node/CLI (not touched).
- `src-tauri/tauri.conf.json` CSP `connect-src 'self' ipc: http://ipc.localhost` — only matters to the webview; the download is made from Rust, so no CSP change.
- `sign-dmg.sh`: signs with `--deep` and verifies; has no node-specific lines.

### Feature Flags and Deployment Concerns

- No feature flags. The runtime path `~/Library/Application Support/CodeMie/runtime/` persists after app removal (~350 MB, stated in the ticket).
- `build-installer.sh` (stage line ~52, `cargo tauri build` line ~100). Its step 2 and step 5 assertions are written for a bundled runtime (see risks). Also `--skip-stage` mode.
- No CI config file in the repo (no `.gitlab-ci.yml` at top level).

---

## 6. Risk Indicators

- build-installer.sh post-build assertions (lines ~110-135) require `$RES/node/bin/node`, `$RES/cli/node_modules/...`, a nesting-depth check, and run `$RES/bin/codemie --version` from the bundle. All fail once resources are removed. The poc diff does not touch `build-installer.sh`; this script needs real adaptation (assert bundle has shim + runtime-key and no node/cli, DMG size small; run pack-runtime between steps 2/3 and 4; the shim smoke needs a runtime in `$HOME` — Speculative: unpack the archive into a temp HOME to run the shim exactly as a user would). Also the script header and step labels ("[1/5]") need updating.
- Speculative: Windows regression. poc `runtime_ready` on a non-macOS target evaluates `is_ready(runtime_dir)` against the empty-key fallback pack, which returns false, so Windows would show the download overlay and try an empty URL. Windows still bundles its runtime; `runtime_ready` must return true (and `ensure_runtime` be a no-op) when not macOS. `runtime.rs` is compiled on all platforms, `commands::runtime::*` registered unconditionally.
- Build prerequisite change: `include_str!` and the `runtime-key` resource make every cargo command (test, clippy, fmt-independent build) fail until `stage-runtime.sh` and `pack-runtime.sh` have run. Worktrees need both. Quality-gates guide and README must say so. `pack-runtime.sh` needs the staged tree, so there is no cheaper way to produce a valid key/sha for tests.
- `pack-runtime.sh` uses `cfg()` with system node, `tar -czf` with `COPYFILE_DISABLE=1`; archive is non-reproducible (gzip mtime, tar ordering), so SHA changes every build; the published archive must be the exact file whose SHA is baked into the app — a rebuild without re-upload gives AC3-style "damaged download" errors for users.
- lib.rs/AppState wiring: new field `existing_cli_detected` must be set from the same value used at `lib.rs:41`. Using `bundled_injected` would download on machines where PATH injection failed and skip on none; requester explicitly forbids.
- Boot ordering: `ensureRuntime()` is before the `smoke_mode` call, so `CODEMIE_SMOKE`/`CODEMIE_PROBE_SMOKE` runs on a machine without the runtime will sit on the overlay or download. Also nothing else must run the CLI before it; the app-update and agent flows are inside `boot()` afterwards, but any top-level code in renderer.js that runs before `boot()` should be rechecked.
- Proxy: `system-proxy` also changes `downloader.rs`, `app_updater.rs`, `installer.rs` client behaviour (intended side effect, but they now also honour system proxy, including macOS SystemConfiguration through `hyper-util/client-proxy-system`). AC4 can only be verified manually with a real proxy setting.
- Extraction/security: `/usr/bin/tar -xzf` on an archive whose hash matched; no `--no-same-owner`/path-safety flags, acceptable only because the hash is pinned. Files extracted by tar carry no quarantine attribute; keytar.node and some bundled binaries were noted as unsigned in memory notes (14899), still unsigned here since they are not in the app signature any more — signing/notarization story for the downloaded runtime is open (out of scope but worth noting).
- Atomicity: `remove_dir_all(&dir)` then `rename(staging, dir)` leaves a window with no runtime if the process dies between them (marker is inside staging so never partial; at worst re-download). Old-runtime cleanup deletes every entry in the runtime base not equal to the key, including unrelated files placed there. Two concurrent app instances/launches would share `.download-<key>` and `.staging-<key>` names.
- Poc download timeouts: connect 30 s, read 60 s, no overall retry/resume; stalls surface as the Try again screen. No size check against `pack.size` (only SHA); progress is hidden when no `Content-Length` (bar stays 0%).
- Test-only env `CODEMIE_RUNTIME_URL` ships in production; an attacker-controlled env var could only redirect to content that must still match the baked SHA-256, so impact is limited.
- Frontend copy: overlay strings are inline-styled English in `index.html`; no existing screen-text test pattern covers them (a `home-copy.test.mjs` exists for home copy only).
- `.gitignore` poc line `poc-test/` is poc-specific; do not carry it. `.codemie/codemie-cli.config.json` is modified in the working tree and must stay out of staging.
- Docs drift: README lines 46-55, 85-91; quality-gates Build section; architecture component map and `state.rs` description; testing guide organization list.
- Download host: runtime hosted on GitHub Releases at a URL not yet published (upload out of scope); until it exists the app built from this branch fails AC1 outside local test with `CODEMIE_RUNTIME_URL`.

---

## 7. Summary for Complexity Assessment

The change touches four layers: build/packaging (build-installer.sh, new pack-runtime.sh, runtime.json, gitignore, tauri.macos.conf.json, the shim), the Rust backend (new `commands/runtime.rs`, `mod.rs`, `lib.rs` registration, `state.rs` field, Cargo feature), the frontend (index.html overlay, renderer.js boot gate) and docs/guides. Of the poc's 12 files, 10 apply cleanly; `commands/mod.rs` needs a one-line manual add; `lib.rs` needs a drop of the obsolete node_exe/cli_entry hunk, two handler registrations and an `existing_cli_detected` field in `AppState` set from the already-computed local. The real adaptation work is `build-installer.sh`, which the poc does not touch and whose post-build assertions currently require a bundled node/CLI, plus a cfg guard so Windows (still bundled) is not sent into the download path.

Technical novelty is low: the reference is built and tested in the real app, uses crates already in the tree (reqwest 0.12.28, sha2, tokio fs/process, futures-util, tempfile) and follows the architecture guide's "add a command" recipe. The one dependency change is a feature flag already present in the locked reqwest version. Rough surface: ~12-14 files, one new Rust module of ~220 lines, one new script of ~50 lines, one rewrite of a ~100-line verification script.

Test posture: JS side is well covered by text-assertion tests (shim.test.mjs update ships with the poc). Rust has only the three poc unit tests; the download/verify/unpack/cleanup path, the proxy behaviour and the retry UI have no automated coverage and were verified manually in the poc (slowserve.py rate-limited server, launch.sh clean-env launcher). Main risks are the build-script assertions, the unconditional compile and registration on Windows, the new cargo prerequisite (pack-runtime before any cargo command), and a non-reproducible archive whose SHA is baked into the app. Quality gates to run: `cd src-tauri && cargo fmt --check`, `cd src-tauri && cargo clippy -- -D warnings`, `cd src-tauri && cargo test`, `npm test`, then `./build-installer.sh` (after adaptation) for the build gate.

---

## 8. External References

None named by the task as a source of truth beyond the poc, which the task described as a reference implementation. It was read in full: `/Users/mert_efe/codemie-installers/runtime-download-poc/poc.diff` (resolved, 557 lines, 12 files). Helpers read: `/Users/mert_efe/codemie-installers/runtime-download-poc/poc-test/slowserve.py` (serves `ROOT` files by basename on `127.0.0.1:PORT`, args `ROOT PORT RATE_BYTES_PER_SEC`, 0 = full speed) and `poc-test/launch.sh` (args `<test-home> [env...]`, runs the built app with `env -i`, PATH `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`, log to `poc-test/app.log`). The poc's `lib.rs` still contains node_exe_path/existing_cli_detected fields that main removed.
