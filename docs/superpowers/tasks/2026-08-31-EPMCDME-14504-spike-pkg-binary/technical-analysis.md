# Technical Research

**Task**: pkg binary tauri externalBin sidecar
**Generated**: 2026-09-01T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14504 follow-on spike — compile the CodeMie CLI (@codemieai/code) into a single self-contained binary using @yao-pkg/pkg targeting node20-macos-arm64 and node20-win-x64, then bundle the resulting binary as a Tauri externalBin sidecar. Validate that `codemie --version` and `codemie install [agent]` work correctly from inside a signed and notarised macOS .app bundle on a clean aarch64 VM — no system Node.js, no npm, no separate JS files required. Deliverable: working demo OR spike report. Context: the previous spike (EPMCDME-14504) validated the externalBin Tauri mechanism and PATH injection pattern (inject_bundled_bin_path in pathman.rs, wired in lib.rs setup). This spike replaces the 70MB Node tarball + JS tree bundle with a single ~40-60MB compiled binary. The previous spike branch is spike/epmcdme-14504-bundle-node.

---

## 2. Codebase Findings

### Existing Implementations

**What the previous spike (spike/epmcdme-14504-bundle-node) established — NOT yet on main:**

- `src-tauri/src/commands/pathman.rs` — the previous spike added `inject_bundled_bin_path(app: &tauri::AppHandle)` at lines 110–146 (from plan.md). This function prepends the bundled binary directory to process PATH inside the `lib.rs::run()::setup` closure. It detects Approach B (sidecar in `Contents/MacOS/` as a sibling of the main exe) via `concat!("node-", env!("TARGET"))`, then falls back to Approach A (resource_dir). For this spike the detection filename changes to `codemie` rather than `node`. The function is not present on `main`.
- `src-tauri/src/lib.rs:22` — the previous spike added a call to `inject_bundled_bin_path` immediately after `apply_resolved_shell_path()`. This call is not on `main`.
- `src-tauri/tauri.conf.json` — the previous spike added `externalBin: ["../assets/bin/node"]` and `bundle.macOS.signingIdentity: "Developer ID Application: ULADZISLAU SVETLAKOU (9H5BAHWPG9)"` (verified by lens-acceptance.md, but without throwaway labels). These additions are not present in the current `main` copy, which has no `externalBin`, no `resources`, and no `signingIdentity` key.
- `ui/handlers.js:175` — step 1.3 was partially short-circuited in the previous spike: `npm install -g @codemieai/code` was replaced with `runner.runCapture('node --version')`. Current `main` still runs the full npm install.

**What is on main now:**

- `src-tauri/src/lib.rs` — `apply_resolved_shell_path()` called at line 22 in the `setup` closure; this is the designated injection point. The `inject_bundled_bin_path` call is absent.
- `src-tauri/tauri.conf.json` — `bundle` object contains only `active`, `targets` (`["dmg","nsis"]`), `category`, `copyright`, `icon`, and `macOS: { minimumSystemVersion: "10.15" }` and `windows: { ... }`. No `externalBin`, no `resources`, no `signingIdentity`.
- `src-tauri/src/commands/pathman.rs` — `apply_resolved_shell_path()`, `candidate_dirs()`, `fresh_env_path()`, `persist()`, `augment_path()`, and `dedupe_path()`. No `inject_bundled_bin_path` function.
- `assets/codemie-cli/` — full `node_modules` tree installed via `npm install @codemieai/code` (`package.json` declares `"@codemieai/code": "^0.14.1"`). This is the JS-tree artifact from the previous spike's assembly step. **Critically: `assets/codemie-cli/node_modules/keytar/build/Release/keytar.node` is present** — a compiled native Node.js addon.
- `assets/bin/node-x86_64-pc-windows-msvc.exe` — a Windows binary artifact left from prior spike work. Its presence in `assets/bin/` with the Tauri naming convention (`<name>-<target-triple>.exe`) is directly relevant to the Windows part of this spike.
- `ui/handlers.js:155–197` — step 1.3 handler still runs `runner.runStream('npm install -g @codemieai/code', ...)` at line 175. Step 1.2 (lines 109–149) checks for and optionally installs Node.js. Both steps need short-circuiting for the pkg-binary approach.

### Architecture and Layers Affected

| Layer | File(s) | Current state on main | What this spike needs |
|---|---|---|---|
| Tauri bundle config | `src-tauri/tauri.conf.json` | No `externalBin`, no `signingIdentity` | Add `externalBin: ["../assets/bin/codemie"]`, `macOS.signingIdentity`, and no `resources` needed (JS files replaced by compiled binary) |
| Rust startup | `src-tauri/src/lib.rs:22` | Only `apply_resolved_shell_path()` called | Call `inject_bundled_bin_path(app.handle())` immediately after line 22 |
| Rust PATH injection | `src-tauri/src/commands/pathman.rs` | No `inject_bundled_bin_path` | Add function detecting `codemie-<TARGET>` sidecar in exe-sibling dir; prepend to process PATH |
| JS orchestration | `ui/handlers.js` (steps 1.2, 1.3) | 1.2 checks/installs Node.js; 1.3 runs npm install | 1.2: short-circuit (bundled binary needs no system Node); 1.3: path-check against bundled `codemie --version` |
| Binary artifact | `assets/bin/` | Contains `node-x86_64-pc-windows-msvc.exe` (prior work) | Requires `codemie-aarch64-apple-darwin` (macOS) and `codemie-x86_64-pc-windows-msvc.exe` (Windows) compiled via `@yao-pkg/pkg` |

The engine/models/UI widget layers (`engine.js`, `models.js`, `steps-ui.js`, `terminal.js`, `renderer.js`), `runner-bridge.js`, and all of `commands/runner.rs` are unchanged. Steps 2.x (`codemie setup`, `codemie install claude --supported`, `codemie doctor`) require no changes — they invoke `codemie` via the login shell and will find the bundled binary transparently once PATH is injected.

### Integration Points

- `src-tauri/src/lib.rs:22` — `setup` closure: `apply_resolved_shell_path()` is the PATH injection hook. `inject_bundled_bin_path` must be called here before any window is shown.
- `src-tauri/src/commands/runner.rs::shell_cmd()` — all `run_capture`, `run_stream`, `run_fresh_env` go through `/bin/zsh -lc` (macOS) or `powershell.exe` (Windows). Once PATH is augmented, the bundled `codemie` binary is discoverable transparently.
- `src-tauri/src/commands/pty.rs::spawn_pty()` — reads `std::env::var("PATH")` to set the PTY child environment. PATH must be augmented before PTY launch; the startup injection in `lib.rs::setup` covers this.
- `ui/handlers.js:1.3` (line 175) — currently runs `npm install -g @codemieai/code`. Must be replaced with a bundled-binary check for this spike.
- `ui/handlers.js:1.2` (lines 109–149) — currently checks for and installs Node.js. Can be short-circuited because the pkg-compiled binary is self-contained.
- `assets/codemie-cli/node_modules/keytar/build/Release/keytar.node` — native addon present in the existing JS tree. If `@codemieai/code` requires `keytar` at runtime, `@yao-pkg/pkg` must handle it as an asset (not bundled JS). This is the highest-risk technical unknown for pkg compilation.
- `sign-dmg.sh` — uses `codesign --deep --force --options runtime` with Developer ID `9H5BAHWPG9`. The pkg-compiled binary is a Mach-O produced by `@yao-pkg/pkg`; it will need to survive re-signing with hardened runtime, same as the `node` binary in the previous spike.

### Patterns and Conventions

- All new Rust commands follow the convention: one file per concern in `src-tauri/src/commands/`, annotated `#[tauri::command]`, returning `CmdResult<T>`, registered in `lib.rs` `invoke_handler!`, with a JS wrapper in `runner-bridge.js`. New helper functions (like `inject_bundled_bin_path`) that are not Tauri commands go in the same file without the annotation.
- `inject_bundled_bin_path` from the previous spike plan uses `concat!("codemie-", env!("TARGET"))` to detect the correct sidecar filename (Tauri strips the target-triple suffix when placing the sidecar, so the exe-sibling directory is queried for `codemie`). For this spike the detection filename is `codemie` (not `node`).
- Tauri `externalBin` paths in `tauri.conf.json` are relative to `src-tauri/` (the location of `tauri.conf.json`). The binary on disk must be named `<name>-<target-triple>` (e.g. `codemie-aarch64-apple-darwin`) at the path specified. Tauri appends the triple automatically. A naming mismatch causes a hard `tauri build` failure.
- The runtime Tauri v2 API for resolving resource paths is `app_handle.path().resource_dir()` (not the deprecated v1 `tauri::api::path::resource_dir()`).
- `unsafe { std::env::set_var(...) }` in the `setup` closure is the accepted pattern for PATH injection (the closure runs before threads are spawned; the safety comment must be present per prior spike code review).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — covers the full component map, IPC pattern, command registration sequence (`commands/` → `lib.rs` → `runner-bridge.js`). Confirms the `setup` closure in `lib.rs` is the startup hook. Does not cover `externalBin` or `@yao-pkg/pkg` — this remains uncharted in the project guides.
- `.ai-run/guides/development/development-practices.md` — error handling (`CmdResult<T>`, `InstallerError` variants), naming conventions, async patterns, `unsafe` comment expectations.
- `.ai-run/guides/testing/testing-patterns.md` — Rust inline `#[cfg(test)]` with real shell; no mocking. Notes that genuine install operations (including binary-path probes) are never run automatically.
- `.ai-run/guides/quality-gates.md` — `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test`, `cargo tauri build`.
- `.ai-run/guides/standards/git-workflow.md` — throwaway spike branches use the `spike/<slug>` pattern; all spike commits labeled `[throwaway]`.

### Architectural Decisions

- **Option B (engine in JS)**: orchestration stays in frontend JS; Rust provides thin system commands. This spike works within that decision — no logic moves to Rust.
- **Login-shell execution**: `runner.rs` doc comment: "macOS: commands run via `/bin/zsh -lc`". PATH augmentation at startup is the correct and only way to make the bundled binary discoverable to all shell invocations.
- **PTY PATH inheritance**: `pty.rs` reads `std::env::var("PATH")` — the startup injection in `lib.rs::setup` propagates to PTY children automatically.
- **Previous spike code review (CR-003, CR-004)**: confirmed that the Approach B detection uses `concat!("node-", env!("TARGET"))` and that a runtime symlink in `$TMPDIR/codemie_spike_bin/node` was used to make the sidecar reachable under a plain `node` name. For the `codemie` binary spike, no symlink trickery is needed — the binary name matches the command name.
- **Previous spike code review (CR-006, CR-007)**: the externalBin + signingIdentity additions were isolated to a separate `src-tauri/tauri.macos.conf.json` override file rather than the base `tauri.conf.json` to prevent production contamination. This same isolation pattern should be followed here.
- **Previous spike AC gap (lens-acceptance.md)**: `bundle.resources` for the CLI JS tree was missing from `tauri.conf.json`, causing a module-not-found failure path. For this spike the JS tree is replaced by the compiled binary, so `bundle.resources` is not required — this gap is eliminated by design.

### Derived Conventions

- Spike-only config changes (externalBin, signingIdentity) belong in a separate `tauri.macos.conf.json` (or `tauri.windows.conf.json`) override file, not in the base `tauri.conf.json`, and must carry explicit `[throwaway]` comments.
- The `assets/bin/` directory holds Tauri-named sidecar binaries and is excluded from git (per `.gitignore` rules added in the previous spike for `assets/bin/`).
- pkg compilation is run on a development machine and the output binary is placed at `assets/bin/codemie-aarch64-apple-darwin` before `cargo tauri build` runs — the binary is never committed; a build-time fetch or documented preparation step is required.

---

## 4. Testing Landscape

### Existing Coverage

| Test file | What it covers |
|---|---|
| `src-tauri/src/commands/pathman.rs` (inline) | `dedupe_path`, `missing_entries`, `merge_shell_path`, `resolve_shell_path` against real `/bin/zsh` |
| `src-tauri/src/commands/runner.rs` (inline) | `capture()` via real login shell; exit code propagation; Windows PowerShell variant |
| `src-tauri/src/commands/installer.rs` (inline) | `node_pkg_url` URL building; `parse_npm_latest` JSON parsing |
| `src-tauri/src/commands/inspector.rs` (inline) | `probe_from`, `codemie_from`, `parse_codemie_version`, `parse_profile_status` — pure parsing |
| `ui/test/engine.test.mjs` | Engine orchestration: step sequencing, approval gates, fatal propagation, skip logic |
| `ui/test/models.test.mjs` | `StepStatus`, `STATUS_META`, `makeStep` normalization |
| `ui/test/version-utils.test.mjs` | Version utility functions |

### Testing Framework and Patterns

- **Rust**: `cargo test`, inline `#[cfg(test)]` modules. Async tests use `#[tokio::test]`. Tests run against the real shell — no mocking layer.
- **JS**: `node --test` (`npm test`). `node:test` + `node:assert/strict`. Engine tests inject a synthetic `emit` function and stub handlers.
- No integration test harness, no snapshot testing, no E2E layer.

### Coverage Gaps

The following areas touched by this spike have no existing tests:

- `inject_bundled_bin_path` — bundle-relative sidecar path resolution and process PATH injection. Per the previous spike spec and plan, unit tests for this function are explicitly out of scope for the spike; a follow-on story owns this.
- `check_codemie()` / `check_codemie_version()` invoked against the pkg-compiled binary instead of an npm-installed binary — no test exercises this execution path.
- Step 1.2 short-circuit logic (skip Node.js check/install when bundled binary is present).
- Step 1.3 bundled-binary path-check in `handlers.js` — the spike replaces npm install with a `codemie --version` check; this handler path has no JS test coverage.
- `@yao-pkg/pkg` compatibility with `keytar` native addon — entirely untested in this repo.
- Windows `codemie-x86_64-pc-windows-msvc.exe` sidecar invocation via PowerShell shell_cmd.

---

## 5. Configuration and Environment

### Environment Variables

| Variable | File | Purpose |
|---|---|---|
| `PATH` | `pathman.rs`, `runner.rs`, `pty.rs` | Resolved from login shell at startup; the critical injection point for the bundled binary directory |
| `HOME` | `pathman.rs`, `pty.rs` | PTY cwd; `~/.zprofile` path |
| `SHELL` | `pathman.rs::resolve_shell_path()` | User's shell, defaults to `/bin/zsh` |
| `CODEMIE_SMOKE` | `smoke.rs` | Smoke test mode; non-destructive renderer + PTY check |
| `CODEMIE_PROBE_SMOKE` | `smoke.rs` | Probe-only smoke mode |
| `NOTARIZE` | `sign-dmg.sh` | Triggers notarization workflow when set to `1` |
| `KEYCHAIN_PASSWORD` | `sign-dmg.sh` | Required for keychain unlock during signing |
| `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` | `sign-dmg.sh` | Notarization credentials |

### Configuration Files

- `src-tauri/tauri.conf.json` — governs Tauri bundle: product name, identifier, targets (`["dmg","nsis"]`), macOS minimum version (`10.15`). The `bundle` object has no `externalBin`, no `resources`, no `signingIdentity`. Per the previous spike's code review pattern, spike-only additions (externalBin for `codemie`, signingIdentity) should go into a separate `tauri.macos.conf.json` override file, not the base config.
- `config/steps.yaml` — embedded at compile time via `include_str!`; step 1.3 title is "Install CodeMie" with `approval_message` referencing npm. No changes to this file are required for the spike — step behavior is controlled by `handlers.js`.
- `assets/codemie-cli/package.json` — `{ "dependencies": { "@codemieai/code": "^0.14.1" } }`. The `assets/codemie-cli/node_modules/` tree is the JS-based artifact from the previous spike assembly. For this spike, this tree is the input to `@yao-pkg/pkg` compilation (or installed fresh at pkg compile time).
- `.gitignore` — the previous spike added `assets/node-runtime/` and `assets/bin/` exclusion rules. `assets/codemie-cli/` exclusion status needs verification; the `node_modules/` tree is currently tracked (files visible in Glob output).

### Feature Flags and Deployment Concerns

- No feature flags in the codebase.
- `sign-dmg.sh` uses `codesign --deep --force --options runtime --timestamp` with identity `9H5BAHWPG9`. The pkg-compiled `codemie` binary is a Mach-O; it must survive re-signing with hardened runtime. The `--deep` flag will reach it in `Contents/MacOS/` (Approach B sidecar location).
- For Approach B sidecar, Tauri signs the declared binary automatically during `cargo tauri build` when `signingIdentity` is set in the macOS config override — this is the pattern established and verified by the previous spike.
- No CI/CD pipeline exists (no `.github/` or `.gitlab-ci.yml`). All quality gates and build/sign steps are manual.
- The `minimumSystemVersion: "10.15"` in `tauri.conf.json` is technically incorrect for aarch64-only Macs (require macOS 11.0+), but the previous spike left it unchanged and this spike should follow the same constraint.

---

## 6. Risk Indicators

- **`keytar` native addon in `@codemieai/code`**: `assets/codemie-cli/node_modules/keytar/build/Release/keytar.node` is present, confirming `@codemieai/code` depends on `keytar`. `@yao-pkg/pkg` cannot bundle `.node` native addons as static code — they must be declared as `--assets` and are extracted to a temp directory at runtime. On macOS with hardened runtime, writing to a temp directory from a notarized app is permitted, but the extracted `.node` file itself will be unsigned, which may trigger macOS library validation checks. This is the highest-risk unknown specific to the pkg-compilation approach and has no prior validation in this repo.
- **`@yao-pkg/pkg` is entirely new to this repo**: No prior use, no established pattern, no guide coverage. The pkg compilation step (CLI invocation, target flag `node20-macos-arm64`, asset declaration for native addons) must be documented in the spike branch as a preparation step.
- **`inject_bundled_bin_path` is not on main**: The function exists only in the previous spike branch (`spike/epmcdme-14504-bundle-node`). This spike must either rebase that branch or re-implement the function from scratch. The previous spike's plan.md contains the implementation at `pathman.rs:110-146`; it works as a starting point but the detection filename changes from `node` to `codemie`.
- **Previous spike had a `bundle.resources` gap for CLI JS files** (confirmed by lens-acceptance.md CR finding). This spike eliminates that gap by design — the compiled binary is self-contained — but if `keytar` must be shipped as a separate `.node` asset, a `bundle.resources` entry for that asset would be required, reintroducing a similar gap.
- **Windows target**: `codemie-x86_64-pc-windows-msvc.exe` must be compiled with `@yao-pkg/pkg` targeting `node20-win-x64` on a Windows or cross-compilation-capable machine. The existing `assets/bin/node-x86_64-pc-windows-msvc.exe` artifact suggests prior Windows sidecar work; its origin and usability for this spike are unclear. The NSIS bundler in `tauri.conf.json` targets Windows, so the Tauri Windows externalBin convention applies.
- **Sidecar binary filename mismatch causes hard build failure**: `tauri build` fails if the file named `<entry>-<target-triple>[.exe]` is not present at the path declared in `externalBin` before the build runs. For macOS: `codemie-aarch64-apple-darwin` at `../assets/bin/`. For Windows: `codemie-x86_64-pc-windows-msvc.exe` at `../assets/bin/`. The build fails early and clearly on mismatch, so this is a recoverable error.
- **Step 1.2 skip logic in `handlers.js`**: The current step 1.2 handler (lines 109–149) checks for and installs Node.js. If left unchanged, it will probe `node --version` via the process PATH, find the bundled binary's embedded node (since it will be on PATH), and potentially trigger step 1.2.1 (download + install Node.js) when the probe returns unexpectedly. The step must be short-circuited or the probe logic made aware of the bundled binary. An incorrect probe response here would add a spurious Node.js download to the wizard flow.
- **Previous spike's tauri.conf.json changes lacked throwaway labels** (CR-009 and CR finding in lens-acceptance.md). This spike must follow the code-review-enforced convention: externalBin and signingIdentity additions in a separate override conf file with explicit `[throwaway]` comments.
- **Speculative**: If `keytar` is only used for credential caching and degrades gracefully when unavailable, the pkg binary may work without it on a clean VM where no credentials are stored. This would make the native addon issue a non-blocker for the specific validation steps (`codemie --version`, `codemie install [agent]`). This must be confirmed by reading `@codemieai/code`'s usage of keytar before pkg compilation.
- **DMG size impact**: A single pkg-compiled binary is expected to be ~40–60 MB. The current DMG is ~4 MB. Bundling even one such binary increases the macOS DMG by ~10–15x; bundling both architectures in a universal binary is not supported by pkg (separate per-arch builds required). This is acceptable for a spike but would need re-evaluation for production.

---

## 7. Summary for Complexity Assessment

This spike shares significant structural overlap with the preceding EPMCDME-14504 spike: the same three layers are touched (Tauri bundle config, `pathman.rs` PATH injection, `handlers.js` step bypass) and the `inject_bundled_bin_path` Rust function and `externalBin` tauri.conf.json pattern are already designed and partially code-reviewed. The file change surface is narrower than the previous spike because the pkg-compiled binary approach eliminates the need for `bundle.resources` (the JS tree is compiled in) and simplifies the step 1.2 bypass (no node runtime needed at all). The `inject_bundled_bin_path` function from the previous spike's `plan.md` is directly reusable with a single string change (`"node-"` → `"codemie-"`). The spike branch can rebase on or cherry-pick from `spike/epmcdme-14504-bundle-node`.

The concentrated technical risk is in `@yao-pkg/pkg` compatibility with `@codemieai/code`'s `keytar` native addon. `keytar` is a compiled `.node` module (confirmed at `assets/codemie-cli/node_modules/keytar/build/Release/keytar.node`) that pkg cannot bundle statically. If `codemie` calls `keytar` at startup or during `--version`/`install`, the pkg compilation either fails (if the call is unconditional) or works degraded (if the call is guarded). This must be determined by inspecting the `@codemieai/code` source for its `require('keytar')` usage pattern before compiling. The macOS hardened runtime behaviour of an extracted-at-runtime unsigned `.node` file is a secondary signing risk that parallels the node binary re-signing risk in the previous spike.

Test coverage posture is thin by design — this is a spike. The existing Rust and JS tests (pathman, inspector, runner, engine) cover all the unchanged surrounding logic and serve as a baseline. `CODEMIE_SMOKE=1` provides a non-destructive renderer/PTY sanity check after the binary is placed. The spike's primary deliverable is a `SPIKE_RESULT.md` recording pkg compilation success/failure, codesign output, and `codemie --version` / `codemie install [agent]` output from a clean aarch64 VM — the same empirical evidence format as the previous spike.

---

## 8. External References

The task names `spike/epmcdme-14504-bundle-node` as the source of truth for the prior spike's validated patterns. The following specific facts were sourced from that branch's documentation present in this repository:

- `docs/superpowers/tasks/2026-08-31-EPMCDME-14504-spike-bundle-node-macos/plan.md` — resolved at path above. Contains the complete `inject_bundled_bin_path` implementation (lines targeting `pathman.rs:110-146`), the `lib.rs` call site diff (after line 22), and the `tauri.conf.json` externalBin/signingIdentity pattern. The detection string is `concat!("node-", env!("TARGET"))` — must change to `concat!("codemie-", env!("TARGET"))` for this spike.
- `docs/superpowers/tasks/2026-08-31-EPMCDME-14504-spike-bundle-node-macos/lens-acceptance.md` — resolved at path above. Records which spec items passed/failed in the previous spike. Key facts for this spike: `bundle.resources` for CLI JS was missing (not needed here); step 1.3 path-check was partial; tauri.conf.json changes lacked throwaway labels (must fix here); VM validation was PENDING (the spike's primary deliverable).
- `docs/superpowers/tasks/2026-08-31-EPMCDME-14504-spike-bundle-node-macos/code-review-brief.md` — resolved at path above. Code review findings: CR-003 (target-triple suffix pattern for detection), CR-004 (runtime symlink workaround — not needed for `codemie` binary since name matches command), CR-006/CR-007 (externalBin/signingIdentity must be in a separate override conf file, not base `tauri.conf.json`). The symlink workaround (CR-004) is not needed in this spike because the pkg-compiled binary is named `codemie`, matching the command name directly.
