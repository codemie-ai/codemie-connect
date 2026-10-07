# Technical Research

**Task**: handshake probe bundled CLI installation codemie-code
**Generated**: 2026-10-02T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15395 — Install codemie-code when no existing CodeMie CLI is present. This is the macOS Tauri installer for CodeMie (codemie-claude-installer-macos-tauri). The problem: when a CodeMie CLI was previously installed via npm and then removed (npm uninstall), a broken shim can remain on PATH. The old probe_global_codemie() checked only file existence, so it treated the broken shim as 'CLI found', and the bundled CLI was never injected. The fix (already committed on this branch as EPMCDME-15257): find_working_global_codemie() verifies the CLI with --version before treating it as found; detect_handshake_state and lib.rs startup both use this new function. Key question: is the implementation already complete, or are there additional gaps? Specifically: (a) are there macOS-specific unit tests for find_working_global_codemie that use a temp dir with a real (but broken) binary? (b) does the installer UI/frontend handle the case where no global CLI was found and show appropriate messaging? (c) is there any npm install step that runs codemie-code install when global_found=false? Focus on: src-tauri/src/commands/handshake.rs, src-tauri/src/lib.rs, ui/handlers.js, ui/home-state.js, config/steps.yaml.

---

## 2. Codebase Findings

### Existing Implementations

- `src-tauri/src/commands/handshake.rs` — Contains `find_working_global_codemie(path_env)` (line 40), `probe_global_codemie(path_env, probe)` (line 86), `detect_handshake_state(path_env, bundled_injected, probe, version_cmd)` (line 99), `check_handshake_state` IPC command (line 122), `version_at(path)` (line 12), and `parse_global_version(output)` (line 67).
- `src-tauri/src/lib.rs` — Startup calls `find_working_global_codemie(&pre_injection_path)` (line 22) to gate whether `inject_bundled_bin_path` runs. Sets `existing_cli_detected` on `AppState`. Logs a message when the existing CLI is detected (line 84).
- `src-tauri/src/state.rs` — `AppState` holds `existing_cli_detected: bool`, `bundled_injected: bool`, `pre_injection_path: String`, `node_exe_path: PathBuf`, `cli_entry_path: PathBuf`.
- `src-tauri/src/commands/runner.rs` — `bundled_cli_in_use()` helper (line 173), `cli_is_bundled` IPC command (line 184), `run_self_update` guards against calling self-update on the bundled CLI (line 196).
- `ui/runner-bridge.js` — Exposes `inspector.checkHandshakeState` (line 62) and calls `invoke('cli_is_bundled')` through `updater.runSelfUpdate` path. `checkHandshakeState` bridge wrapper is defined but not called in any JS file.
- `ui/renderer.js` — Calls `invoke('cli_is_bundled')` at line 825 to skip the CLI update banner when the bundled CLI is in use. Does not call `checkHandshakeState` anywhere.
- `ui/handlers.js` — Step `2.3.5` calls `codemie install claude --supported` via PTY (line 87 for macOS). This is the mechanism by which the bundled CLI installs codemie-code.
- `ui/home-state.js` — `BUILTIN_AGENT_COMMAND = 'codemie-code'` (line 58). No handling of `global_found` or `existing_cli_detected`.
- `config/steps.yaml` — Three steps: `2.3.3` (Configure CodeMie), `2.3.5` (Install Claude Code engine), `2.4` (Validate). No step conditional on `global_found`.

### Architecture and Layers Affected

- **Rust startup layer** (`lib.rs`): PATH detection and bundled-bin injection at app start. `find_working_global_codemie` is called here before any plugin or thread starts.
- **Rust command layer** (`commands/handshake.rs`, `commands/runner.rs`): IPC commands exposing handshake state and bundled-CLI detection to the frontend.
- **Rust state layer** (`state.rs`): `AppState` carries `existing_cli_detected` and `bundled_injected` as read-only flags set at startup.
- **Frontend orchestration** (`renderer.js`, `handlers.js`): Wizard steps run `codemie setup` and `codemie install claude --supported` via PTY, using whichever codemie is on PATH (bundled or global).
- **Frontend step config** (`config/steps.yaml`): Drives the wizard — steps are platform-agnostic with no conditional branching on CLI origin.

### Integration Points

- `find_working_global_codemie` → `version_at` → `std::process::Command` (real subprocess).
- `inject_bundled_bin_path` (commands/pathman.rs) prepends the bundled bin dir to `PATH`; called only when `existing_cli_detected = false`.
- `cli_is_bundled` IPC → renderer.js CLI update banner suppression.
- `checkHandshakeState` IPC → bridge wrapper exists but no caller in the frontend JS.
- Step 2.3.5 (`codemie install claude --supported`) → PTY in Rust → bundled codemie shim → npm install of codemie-code.

### Patterns and Conventions

- Dependency injection for testability: `detect_handshake_state` accepts `probe` and `version_cmd` closures, letting tests mock both without touching the filesystem.
- `#[cfg(test)]` inline modules in Rust; `node:test` + `node:assert/strict` for JS tests (no external frameworks).
- Infallible IPC commands return `T` directly; fallible ones return `CmdResult<T>`.
- All new Rust commands registered in `lib.rs` `invoke_handler!` block and wrapped in `runner-bridge.js`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — Describes Frontend-brain + thin Rust backend (Option B), IPC pattern, `AppState` pattern, component map. Covers this domain directly.
- `.ai-run/guides/testing/testing-patterns.md` — Rust inline `#[cfg(test)]` + JS `node:test` patterns. States that runner tests use the real shell; genuine install operations are never run automatically.

### Architectural Decisions

- `.ai-run/decisions/2026-09-22-EPMCDME-15189-builtin-agent-does-not-tick.md` — The built-in `codemie-code` agent (the one the CLI ships with) is explicitly excluded from the "installed agent" count in `home-state.js` (`BUILTIN_AGENT_COMMAND`). Referenced inline at `home-state.js:53–57`.
- Inline comment in `lib.rs:18–21` documents the EPMCDME-15257 fix: "File-existence alone is not enough: the old PowerShell shim can be on PATH but broken (exits 1). Only a passing --version counts."
- Inline comment in `runner.rs:169–172` explains why `cli_is_bundled` matters for `run_self_update`.

### Derived Conventions

- Broken-shim detection is done entirely in the Rust startup layer; the frontend is not expected to re-probe.
- `AppState` flags set at startup are treated as immutable for the app session.
- The wizard steps are data-driven from `config/steps.yaml`; per-step conditional logic lives in `handlers.js`, not in the YAML.

---

## 4. Testing Landscape

### Existing Coverage

- `src-tauri/src/commands/handshake.rs` lines 142–227 — 8 inline `#[test]` functions covering:
  - `no_global_when_path_empty` — empty PATH gives `global_found=false`.
  - `global_found_when_probe_matches_and_version_succeeds` — mock probe + mock version → `global_found=true`.
  - `global_not_found_when_file_exists_but_version_fails` — mock probe always-true + mock version always-None → `global_found=false` (the broken-shim case).
  - `probe_global_codemie_false_on_empty_path`, `probe_global_codemie_true_when_probe_matches`.
  - `bundled_takes_precedence_when_injected_and_global_found`.
  - `global_version_populated_via_injectable_version_cmd`.
  - `parse_global_version_accepts_bare_semver`, `parse_global_version_strips_v_prefix`, `parse_global_version_returns_none_for_non_semver`.
- `ui/test/shim.test.mjs` — Tests the macOS bundled shim script, including that it guards against missing `node` and `codemie.js`, correct path resolution, exit-code propagation.
- `ui/test/home-state.test.mjs` — Tests `deriveHome`, `signInAction`, `autoHealthCheck`; does not touch handshake state or `existing_cli_detected`.

### Testing Framework and Patterns

- Rust: `#[test]` (sync) in `handshake.rs`; `#[tokio::test]` (async) in `runner.rs`. Dependency injection via closures for probe and version_cmd in handshake tests.
- JS: `node:test` + `node:assert/strict`, no external frameworks. Tests under `ui/test/`.
- Real shell execution used in `runner.rs` tests; handshake tests use only mocks.

### Coverage Gaps

- `find_working_global_codemie()` itself has no direct test. All existing tests call `detect_handshake_state()` with mock `version_cmd` closures, bypassing `version_at()` and the real filesystem walk entirely. There is no test that constructs a temp directory with a non-executable (or zero-exit-failing) real binary and calls `find_working_global_codemie` on it.
- `version_at()` (the `std::process::Command` + `--version` runner) has no test of any kind — neither mock nor real.
- The startup logic in `lib.rs` that gates `inject_bundled_bin_path` on `find_working_global_codemie` has no integration test; it is exercised only by running the real app.
- `checkHandshakeState` IPC command is registered and bridged but has no JS-side caller test.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_SMOKE=1` — activates smoke mode (suppresses real install actions); see `commands/smoke.rs`.
- `CODEMIE_PROBE_SMOKE=1` — smoke mode for the probes specifically.
- `PATH` — read at startup via `std::env::var("PATH")`, captured as `pre_injection_path` before bundled bin injection.

### Configuration Files

- `config/steps.yaml` — three wizard steps (2.3.3, 2.3.5, 2.4); consumed by `src-tauri/src/steps.rs` via `include_str!`. No conditional branching on CLI origin.
- `src-tauri/tauri.macos.conf.json` — bundles the macOS codemie shim (`assets/macos/bin/codemie`), bundled node (`assets/macos/node/bin/node`), and CLI tree (`assets/codemie-cli/node_modules`).
- `runtime.json` — pins Node version and SHA-256 for the bundled darwin-arm64 node binary.

### Feature Flags and Deployment Concerns

- No runtime feature flags for the `find_working_global_codemie` path.
- Smoke mode (`CODEMIE_SMOKE=1`) provides a non-destructive integration check but does not exercise the PATH probe or bundled injection path.

---

## 6. Risk Indicators

- **`find_working_global_codemie` is untested against a real filesystem.** All tests mock the `version_cmd` closure; the actual `version_at()` + real subprocess path is exercised only at runtime. A regression in how `version_at` handles non-executable binaries, or a platform difference in how `Command::new(path)` vs. `cmd /C path` handles broken files, would not be caught by tests.
- **`checkHandshakeState` IPC command is dead UI-side.** It is registered in `invoke_handler!` and exposed in `runner-bridge.js` but never called in `renderer.js` or any other JS file. If the task intent included surfacing handshake state in the UI (e.g., a "no global CLI found, using bundled" message), that plumbing is absent.
- **No UI messaging for the "bundled CLI in use" branch.** `cli_is_bundled` suppresses the update banner (correct), but there is no affirmative message to the user explaining that the bundled CLI is being used because no global one was found. Home screen and setup wizard are silent on this distinction.
- **The codemie-code npm install is wizard-triggered only.** Step 2.3.5 (`codemie install claude --supported`) runs the install, but only when the user advances through the wizard. There is no automatic install triggered at startup by `global_found=false`; the user must run the wizard.
- **Speculative:** A macOS-specific test for `find_working_global_codemie` using a temp dir with a `chmod -x` binary (or a script that `exit 1`s) would directly validate `version_at`'s non-zero-exit handling on the platform the app ships on.

---

## 7. Summary for Complexity Assessment

The EPMCDME-15257 Rust backend fix is complete and correctly wired: `find_working_global_codemie` replaces the old existence-only probe, `lib.rs` startup uses it to gate bundled injection, and `AppState.existing_cli_detected` propagates the result to every downstream command. The change touches three files (`handshake.rs`, `lib.rs`, `state.rs`) and has seven mock-based unit tests covering the key logic branches. The codemie-code install path (step 2.3.5) is unchanged and correctly delegates to `codemie install claude --supported` via the bundled CLI once it is on PATH.

Two gaps remain open. First, `find_working_global_codemie` and `version_at` have no real-filesystem test — all coverage uses injected mocks that bypass the actual subprocess call and path walk. Adding a single `#[test]` that writes a shell script exiting 1 to a temp dir and calls `find_working_global_codemie` with that dir on the path would close this. Second, the `checkHandshakeState` IPC command is plumbed (registered and bridged) but never called from the frontend. If the task requires UI messaging for the "no global CLI, using bundled" case, that work is absent from both `renderer.js` and `home-state.js`. The current UI silently uses the bundled CLI with no user-visible explanation; the only differentiation is the suppressed update banner via `cli_is_bundled`.

The complexity band is low-to-medium for the real-filesystem test gap (one Rust test, self-contained, no new dependencies), and medium for the UI messaging gap (requires deciding where the message lives — renderer startup, Home screen, or wizard preamble — and plumbing the `checkHandshakeState` call through to a display point).

---

## 8. External References

None named by the task.
