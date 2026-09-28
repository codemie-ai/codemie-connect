# Technical Research

**Task**: windows setup codemie-doctor npm-shim
**Generated**: 2026-09-25
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15257 — CodeMie Connect: codemie-code installation fails on Windows when Setup is started without an existing codemie-code installation. On Windows, when codemie-code is not installed and the user clicks Setup in CodeMie Connect, CodeMie Connect attempts to configure CodeMie and install the Claude Code engine, but validation fails. Log shows: 'CodeMie command shim could not find codemie.cmd in C:\Users\<user>\AppData\Local\CodeMie\npm-prefix'. All three setup steps (Configure CodeMie, Install Claude Code engine, Validate installation) fail with exit code 1. Acceptance criteria: (1) CodeMie Connect can install codemie-code successfully on Windows when not already installed; (2) setup validation can locate the installed codemie.cmd command shim after installation; (3) the setup flow does not fail with the shim-not-found error; (4) if installation genuinely fails, show a clear actionable error naming the failed command/step; (5) verified on Windows in a clean environment with no pre-existing codemie-code install. Note: ui/setup-view.js (the CodeMie Connect Windows setup flow UI) is the likely affected area; this is on branch feat/EPMCDME-14514-agents-and-home, not on main yet. Investigate how codemie doctor / the command shim / npm-prefix resolution works on Windows, and why the shim can't find codemie.cmd right after a fresh install.

---

## 2. Codebase Findings

### Existing Implementations

- `config/steps-windows.yaml` — the Windows step list for the "Setup" wizard. Three steps with **titles that match the ticket verbatim**: `2.3.3 "Configure CodeMie"` (`codemie setup`, `interactive: true`, `external_window: true`), `2.3.5 "Install Claude Code engine"` (`codemie install claude --supported`, `interactive: true`, `external_window: true`), `2.4 "Validate installation"` (`codemie doctor`, `spinner: true`). `src-tauri/src/steps.rs:55-57` selects this file via `#[cfg(windows)] include_str!("../../config/steps-windows.yaml")` at compile time (macOS compiles `config/steps.yaml`, same step ids/titles, no `external_window` flag).
- `ui/handlers.js` — `makeHandlers(deps)` dispatch table for these step ids:
  - `'2.3.3'` and `'2.3.5'`: `isWin ? runExternalWindow(...) : runPty(...)`. `runExternalWindow` (lines 46-57) calls `externalWindow.spawnPs(cmd)`, which is `invoke('spawn_external_ps', { cmd })` (`ui/runner-bridge.js:141-142`) — a Rust command that spawns a **new, separate visible PowerShell window** via `tokio::process::Command`.
  - `'2.4'`: platform-agnostic — `runner.runStream('codemie doctor', ...)`, which is `invoke('run_stream', ...)` → Rust `run_stream` (`src-tauri/src/commands/runner.rs:111-148`), which builds its child process through `shell_cmd()` → `shell_cmd_for()`.
- `src-tauri/src/commands/pty.rs:283-294` — `spawn_external_ps` (Windows-only `#[tauri::command]`): spawns `powershell.exe -NoProfile -Command <cmd>` with `CREATE_NEW_CONSOLE`, via a bare `tokio::process::Command`. **It sets no `env()` calls at all** — it does not call `crate::commands::npm_env::npm_env()`, does not set `npm_config_prefix`, and does not prepend the npm-agents bin dir to `PATH`. The child inherits the Tauri process's own environment unmodified (aside from whatever the process-wide `PATH` mutation from `inject_bundled_bin_path` already did at startup — see below).
- `src-tauri/src/commands/runner.rs:33-59` — `shell_cmd_for()` (used by `run_stream`/`capture`/`run_capture`/`run_fresh_env`, i.e. step 2.4's `codemie doctor` call): calls `npm_env::npm_env_for(home, windows)`, and when `env.prefix` is non-empty sets `npm_config_prefix` to it, and sets `PATH` to `prefixed_path_with_bin_dir(env.bin_dir, base_path)` — i.e. the agents bin dir prepended.
- `src-tauri/src/commands/pty.rs:48-68` — `pty_env_pairs_for()` (used by `spawn_pty`, the **embedded** PTY path used by macOS's `runPty` and by the newer guided-setup screen's `startSetup`/`ui/setup-driver.js`): sets the same `npm_config_prefix`/`PATH` pair as `shell_cmd_for`.
- `src-tauri/src/commands/npm_env.rs:39-52` — `npm_env_for(home, windows)`: on Windows, `prefix = "{USERPROFILE}\.codemie\agents"`, `bin_dir` = the same string (no `bin` subdir on Windows, unlike macOS's `.../agents/bin`). This is the app's **current, intended** override — set on every spawn path except `spawn_external_ps`.
- `src-tauri/src/commands/pathman.rs:41-51` — `candidate_dirs()` (Windows): includes **both** `"{profile}\AppData\Local\CodeMie\npm-prefix"` (line 48) and `"{profile}\.codemie\agents"` (line 49). Used only by `run_fresh_env`/`fresh_env_path` (`pathman.rs:114-127`), which none of steps 2.3.3/2.3.5/2.4's handlers call.
- `docs/superpowers/tasks/2026-06-11-windows-support/technical-analysis.md:82` records that `%USERPROFILE%\AppData\Local\CodeMie\npm-prefix` is the npm prefix probed by the **reference Windows installer** (`codemie-claude-installer-win`, a separate Python/customtkinter repo, `system_inspector.py:35-39`, `step_engine.py:374-377`) — i.e. this is a path this app's own current Rust code does not set anywhere in `npm_env.rs`, but that a sibling reference implementation and/or the `codemie` CLI/`codemie-code` package's own internal default treats as the npm prefix when no `npm_config_prefix` override is present in its environment.
- `.ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md` — records (from reading the shipped `@codemieai/code` CLI's own source) that `codemie install`/`codemie uninstall` shell out to a bare `npm` inherited from the spawning process's environment (`utils/processes.js`, `agents/core/BaseAgentAdapter.js`), and that `isInstalled()` is a plain PATH lookup (`commandExists`/`which`) — so **whatever `npm_config_prefix` (or its absence) is present in the environment the CLI is spawned with decides where the agent installs, and PATH decides whether it is later found.**
- `src-tauri/src/commands/pathman.rs:382-432` — `inject_bundled_bin_path` prepends the bundled `codemie` CLI's own shim dir (`assets/windows/bin/codemie.cmd`, not `codemie-code`'s shim) to the process-wide `PATH` at startup and persists it to `HKCU\Environment`. This puts the app's own `codemie` command on PATH; it is unrelated to where `codemie install claude --supported` installs the `codemie-code`/Claude engine binary.
- `assets/windows/bin/codemie.cmd` — the bundled CodeMie CLI shim itself; its own two `if not exist` guards report `bundled node runtime not found` / `bundled CLI entry not found`, not the `"CodeMie command shim could not find codemie.cmd"` wording from the ticket's log — that wording is not produced by anything in this repo (grepped, no match) and is therefore either the `codemie`/`codemie-code` CLI's own internal message or `codemie doctor`'s own output, printed verbatim by `runner.runStream`/the wizard terminal.

### Architecture and Layers Affected

- **Config layer**: `config/steps-windows.yaml` (step definitions — titles, `external_window` flag). Compiled in via `src-tauri/src/steps.rs`.
- **Frontend dispatch layer**: `ui/handlers.js` (`makeHandlers`, the `isWin` fork for steps `2.3.3`/`2.3.5`), `ui/renderer.js` (`enterWizard()`, `Engine` construction — this is the legacy install-Wizard `modeLabel.textContent = 'Setup'` flow, distinct from the newer guided-setup screen at `onSetupAgain`/`ui/setup-view.js`).
- **Frontend bridge layer**: `ui/runner-bridge.js` (`externalWindow.spawnPs`, `runner.runStream`).
- **Backend command layer**: `src-tauri/src/commands/pty.rs` (`spawn_external_ps`, Windows-only), `src-tauri/src/commands/runner.rs` (`shell_cmd`/`shell_cmd_for`, `run_stream`), `src-tauri/src/commands/npm_env.rs` (`npm_env`/`npm_env_for` — the single source of truth for the app's own npm-prefix override), `src-tauri/src/commands/pathman.rs` (`candidate_dirs`, `inject_bundled_bin_path` — PATH management, unrelated to `npm_config_prefix`).

### Integration Points

- `ui/handlers.js` → `ui/runner-bridge.js::externalWindow.spawnPs` → Rust `spawn_external_ps` (`pty.rs`) for steps `2.3.3`/`2.3.5` on Windows.
- `ui/handlers.js` → `ui/runner-bridge.js::runner.runStream` → Rust `run_stream` (`runner.rs`) → `shell_cmd`/`shell_cmd_for` → `npm_env::npm_env_for` for step `2.4`.
- `src-tauri/src/commands/pty.rs::spawn_pty` (embedded PTY, macOS's `runPty` and the guided-setup screen) and `src-tauri/src/commands/runner.rs::shell_cmd_for` both independently call `npm_env::npm_env_for` and agree on the same `npm_config_prefix`/`PATH` shape; `spawn_external_ps` is the one Windows spawn path in the codebase that does not.
- External: the `codemie`/`codemie-code` CLI (a separate npm-distributed product, `@codemieai/code`, vendored into the app bundle at `cli/node_modules/@codemieai/code`) is the process actually performing the install (`codemie install claude --supported`) and the validation (`codemie doctor`); this repo does not control that CLI's own source, only the environment it is spawned with.

### Patterns and Conventions

- Every other cross-platform spawn path (`shell_cmd_for` in `runner.rs`, `pty_env_pairs_for` in `pty.rs`) is built as a small **pure function taking an explicit `home`/`windows`/`existing_path`**, unit-tested directly without touching the real process environment, then a thin `#[cfg]`-free wrapper reads the real env var and calls it. `spawn_external_ps` does not follow this pattern — it has no corresponding pure/testable env-builder and sets no env at all.
- `npm_env::npm_env_for` is the single named function that both `runner.rs` and `pty.rs` route through for the `npm_config_prefix`/agents-bin-dir decision — the established convention for "any place that spawns the CLI must go through this."
- Windows-specific behavior throughout the backend is expressed as `#[cfg(windows)]` branches inside the same command file, not separate `_windows.rs` modules (`development-practices.md`'s stated convention, corroborated by `pathman.rs`, `npm_env.rs`, `runner.rs`, `pty.rs` all doing this in-file).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — P0 guide for architecture-classified tasks per `AGENTS.md`; describes the frontend-brain + thin Rust backend (Option B) IPC pattern this bug's fix must follow (new/changed Rust commands registered in `lib.rs`, wrapped in `runner-bridge.js`).
- `.ai-run/guides/development/development-practices.md` — P0 guide for development tasks; documents the `#[cfg(windows)]`-in-file convention observed above.
- `docs/superpowers/tasks/2026-06-11-windows-support/technical-analysis.md` — prior research doc for the original Windows port; §3's reference-installer table is the origin of the `AppData\Local\CodeMie\npm-prefix` path and confirms it comes from the **separate** `codemie-claude-installer-win` Python reference repo, not from this app's current Rust source.
- `docs/superpowers/tasks/2026-09-22-EPMCDME-15180-bundle-npm/` (plan.md, technical-analysis.md) — prior task that added `npm_config_prefix`/agents-bin `PATH` to `shell_cmd`/`spawn_pty`. Its own technical-analysis (line 411) states: "No `npm_config_prefix` or any `npm_config_*` variable currently appears anywhere in [the codebase, before that ticket]" — i.e. `spawn_external_ps` predates and was never revisited by that npm-env-wiring effort.
- `docs/superpowers/tasks/2026-09-23-guided-setup-windows/technical-analysis.md` — prior research on the **separate**, newer guided-setup screen (`ui/setup-driver.js`/`ui/setup-view.js`/`ui/setup-parse.js`, reached via Home's "Choose how CodeMie reaches a model" / `onSetupAgain`). That screen runs `codemie setup` through the embedded `spawn_pty` (which *does* set `npm_config_prefix`), not through `spawn_external_ps`. Confirms this ticket's `ui/setup-view.js` framing in the task context is a naming mismatch, not the actually-affected screen (see Risk Indicators).

### Architectural Decisions

- `.ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md` — the decision record establishing that `npm_config_prefix` inherited from the spawning process is how this app makes `codemie install`/agent installs land in a writable, known directory (`~/.codemie/agents`), and that PATH containing that directory's bin is what makes `codemie list`/`commandExists` see the result. This decision was implemented for `shell_cmd`/`spawn_pty` (EPMCDME-15180) but the decision record itself does not mention `spawn_external_ps` — the Windows external-console step path predates it and is not covered by its reasoning.
- `config/steps-windows.yaml:3` — comment: "Step IDs kept verbatim from the Windows reference (`codemie-claude-installer-win`)" — i.e. `external_window: true` for 2.3.3/2.3.5 is an intentional, inherited design choice (interactive TUI steps get a separate visible console on Windows, matching the reference installer), not an oversight — the gap is specifically the missing env wiring on that path, not the external-window approach itself.

### Derived Conventions

- No guide documents `spawn_external_ps`'s env contract explicitly; the convention is derived by comparison with `shell_cmd_for`/`pty_env_pairs_for`, both of which route through `npm_env::npm_env_for` and both of which have direct unit tests asserting the `npm_config_prefix`/`PATH` shape they produce.

---

## 4. Testing Landscape

### Existing Coverage

- `src-tauri/src/commands/runner.rs` — `shell_cmd_sets_npm_config_prefix_and_prefixed_path_by_default` (unix-only `#[cfg(all(test, unix))]`) asserts `shell_cmd_for` sets `npm_config_prefix`/`PATH` correctly; no Windows-cfg equivalent test exists for `shell_cmd_for`'s Windows branch specifically, though the pure `npm_env_for`/`shell_cmd_for` logic is platform-parametrized and testable from any host.
- `src-tauri/src/commands/pty.rs` — `pty_env_pairs_includes_npm_config_prefix_and_prefixed_path` (`#[cfg(not(windows))]`) covers `pty_env_pairs_for`'s unix shape only; the module's `#[cfg(all(test, windows))] mod win_tests` contains exactly one test, `spawn_external_ps_exits_zero_for_noop_command`, which only asserts the exit code of a no-op command — **it does not assert anything about the environment `spawn_external_ps` passes to the child**, i.e. the exact gap this ticket needs to close is not exercised by any existing test.
- `src-tauri/src/commands/npm_env.rs` — `npm_env_for`'s Windows shape (`npm_env_for_windows_uses_profile_codemie_agents_with_no_bin_subdir`) is tested and platform-independent (parametrized by a `windows: bool` argument), so it is exercisable from any host.
- No JS test file exists for `ui/handlers.js` (`ls ui/test/` has no `handlers.test.mjs`); the `isWin`/`runExternalWindow`/`spawn_external_ps` dispatch for steps `2.3.3`/`2.3.5` has zero test coverage at the JS layer.
- `ui/test/engine.test.mjs` and `ui/test/pty-bridge.test.mjs` exist but exercise `Engine`/PTY-bridge mechanics generically, not this specific `isWin` step-dispatch fork.

### Testing Framework and Patterns

- Rust: inline `#[cfg(test)]` modules per file, `#[cfg(windows)]`/`#[cfg(not(windows))]`-gated test modules for platform-specific behavior, pure-function-with-explicit-parameters pattern so cross-platform logic (e.g. `npm_env_for(home, windows)`) is testable from either host.
- JS: `node --test ui/test/*.test.mjs` (Node's built-in `node:test` + `node:assert/strict`), hand-rolled fakes/deps-injection (no mocking library), fixture JSON files under `ui/test/fixtures/`.

### Coverage Gaps

- `spawn_external_ps`'s environment (or lack thereof) is untested — the single existing Windows test for it only checks exit code, not env vars.
- `ui/handlers.js`'s `runExternalWindow` path (steps `2.3.3`/`2.3.5`) has no JS test at all, on either platform.
- No test anywhere asserts an end-to-end "install via external window, then validate via `codemie doctor`" agreement on install location — the exact scenario that's broken.

---

## 5. Configuration and Environment

### Environment Variables

- `npm_config_prefix` — set by `shell_cmd_for` (`runner.rs`) and `pty_env_pairs_for` (`pty.rs`) via `npm_env::npm_env_for`, to `%USERPROFILE%\.codemie\agents` on Windows when `USERPROFILE` is non-empty. **Not set** by `spawn_external_ps`.
- `PATH` — prepended with the agents bin dir (`prefixed_path_with_bin_dir`) by the same two functions; `spawn_external_ps` passes no `PATH` override, inheriting the Tauri process's own `PATH` (which does include the bundled `codemie` shim dir via `inject_bundled_bin_path`, but not the agents/`codemie-code` bin dir unless something else already put it there).
- `USERPROFILE` — read by `npm_env::npm_env()`/`npm_env_for` and by `pty_env_pairs`/`pty_env_pairs_for` to build the home-relative prefix.

### Configuration Files

- `config/steps-windows.yaml` — governs the three step ids/titles/commands/`external_window` flags this ticket's acceptance criteria reference directly.
- `config/steps.yaml` — the macOS equivalent (same ids/titles, no `external_window`); useful as the cross-platform baseline for what "should" happen once env parity is restored.

### Feature Flags and Deployment Concerns

- `external_window: true` (steps.yaml field, `ui/models.js:35` maps it to `externalWindow`) is the only toggle distinguishing the Windows-only spawn path from the embedded-PTY path; it is data (YAML), not a runtime feature flag.
- No secrets or vault references in this flow. No deployment-manifest changes evident for a fix confined to `spawn_external_ps`'s env wiring.

---

## 6. Risk Indicators

- **Task-context file-naming mismatch**: the ticket names `ui/setup-view.js` as "the likely affected area." Per this research (and corroborated by the prior `2026-09-23-guided-setup-windows` research doc), `ui/setup-view.js`/`ui/setup-driver.js` drive a **different** screen (the newer "guided setup," reached via Home → "Choose how CodeMie reaches a model" → `onSetupAgain`), which runs `codemie setup` through the embedded `spawn_pty` — a path that **does** set `npm_config_prefix` correctly. The three step titles the ticket's log names ("Configure CodeMie", "Install Claude Code engine", "Validate installation") match `config/steps-windows.yaml`/`ui/handlers.js`'s legacy install-Wizard exactly, which is a structurally separate flow (`ui/renderer.js::enterWizard()`, `modeLabel.textContent = 'Setup'`). Downstream planning should confirm which screen QA actually exercised before assuming `setup-view.js` is where the fix belongs.
- **Untested spawn path**: `spawn_external_ps` (`src-tauri/src/commands/pty.rs:283-294`) is the only Windows process-spawn path in the codebase with no environment-injection logic and no test asserting its environment — every sibling spawn path (`shell_cmd_for`, `pty_env_pairs_for`) was deliberately wired for `npm_config_prefix`/PATH in EPMCDME-15180 and this one was not touched.
- **Two install/validate paths can disagree**: because `spawn_external_ps` (steps 2.3.3/2.3.5) and `shell_cmd`/`run_stream` (step 2.4) resolve `npm_config_prefix` differently, the installer and the validator can be looking in two different directories for the same artifact — the exact shape of the reported symptom (doctor's shim-not-found error naming a prefix path this app's own `npm_env.rs` never sets).
- **`candidate_dirs()`'s stale legacy path** (`pathman.rs:48`, `AppData\Local\CodeMie\npm-prefix`) is dead weight relative to the app's actual `.codemie\agents` convention and is not used by any of steps 2.3.3/2.3.5/2.4's code paths (only by the unused-in-this-flow `run_fresh_env`) — a fix should not assume adding this path to `run_fresh_env`'s candidates addresses the bug, since that function is not in the failing call chain.
- **Exact source of the "CodeMie command shim could not find codemie.cmd" wording is external to this repo** — it was not found anywhere in this codebase's source or vendored CLI docs by search; it is very likely printed by the vendored `@codemieai/code` CLI's own `codemie doctor`/install logic (not something this repo formats), so acceptance criterion 4 ("clear actionable error naming the failed command/step") is achievable at the CodeMie Connect UI layer (wrapping/labeling the wizard step's failure) but not by editing that CLI-internal message itself.
- No JS test exists for `ui/handlers.js`'s `isWin` dispatch, so a regression here would not be caught by `npm test` today — relevant to acceptance criterion 5's "verified on Windows" requirement, which will need either a real Windows run or a new unit test around whatever env-injection fix is chosen.

---

## 7. Summary for Complexity Assessment

The failure is fully explained by existing code, not a missing feature: on Windows, the legacy install-Wizard's "Configure CodeMie" and "Install Claude Code engine" steps (`config/steps-windows.yaml` ids `2.3.3`/`2.3.5`) run through `ui/handlers.js::runExternalWindow` → Rust `spawn_external_ps` (`src-tauri/src/commands/pty.rs`), the one Windows child-process spawn path in the codebase that does not set `npm_config_prefix` or prepend the agents bin dir to `PATH`. Every other spawn path — `shell_cmd_for` (used by step `2.4`'s `codemie doctor` validation) and `pty_env_pairs_for` (used by macOS's embedded PTY and the separate newer guided-setup screen) — routes through `npm_env::npm_env_for` and agrees on `%USERPROFILE%\.codemie\agents` as the install prefix, a convention established in EPMCDME-15180/the `2026-09-21-EPMCDME-14514-npm-for-agent-install.md` decision record. `spawn_external_ps` predates that wiring and was never updated, so `codemie install claude --supported` installs (or the CLI's own internal shim-generation looks) into whatever default prefix the vendored `@codemieai/code` CLI falls back to when no override is present, while the immediately-following `codemie doctor` validation step looks in the app's own overridden `.codemie\agents` location — a mismatch that produces exactly the reported "shim could not find codemie.cmd" failure across all three steps.

The technical surface for a fix is narrow and localized: one Rust function (`spawn_external_ps`) needs the same environment treatment its two siblings already have, ideally by extracting/reusing the existing `npm_env`-based pattern rather than inventing a new one — this is a small, mechanical, well-precedented change with an established test pattern to mirror (`pty_env_pairs_includes_npm_config_prefix_and_prefixed_path`, `shell_cmd_sets_npm_config_prefix_and_prefixed_path_by_default`). The main non-trivial risk is verification: no automated test currently exercises `spawn_external_ps`'s environment, no JS test covers `ui/handlers.js`'s `isWin` dispatch, and the exact end-to-end confirmation (acceptance criterion 5) requires a real clean Windows environment, since `spawn_external_ps` opens a genuine separate console window and the CLI's own error message text is not owned by this repo. A secondary, non-technical risk worth resolving during planning is the task context's naming mismatch: it names `ui/setup-view.js`, but the step titles and error text in the ticket's own log point at the older, structurally separate install-Wizard flow (`ui/handlers.js`/`config/steps-windows.yaml`), not the guided-setup screen `setup-view.js` actually drives.

---

## 8. External References

None named by the task. The task context points at an in-repo file (`ui/setup-view.js`) as "the likely affected area," which this research found to be a naming mismatch (see Risk Indicators) rather than a pointer to an external source of truth. No path or URL outside this repository was named.
