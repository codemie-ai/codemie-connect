# Technical Research

**Task**: npm bundling, runtime staging, tauri backend, PATH management
**Generated**: 2026-09-22
**Research path**: filesystem

---

## 1. Original Context

CodeMie Desktop: Bundle npm so agent install and uninstall work on a clean machine (EPMCDME-15180).

Why: EPMCDME-14572 closed with the acceptance criterion "codemie install [agent] completes using
only the bundled runtime" but it was never verified for npm — the clean-VM run only checked
`codemie --version`. The app bundles node (Contents/Resources/node/bin/node) and the CodeMie CLI
(Contents/Resources/cli) but not npm. scripts/stage-runtime.sh strips npm on purpose. 8 of 11
agents install through npm and every uninstall does, so on a machine with no system npm the
Agents screen can install two agents and remove none. Adding npm alone is not enough: npm derives
its global prefix from where node lives, which inside the app is a read-only, signed directory.

Context already verified by the user:
- CLI's utils/processes.js passes env: options.env and the agent adapters pass none, so the child
  inherits our environment — an npm_config_prefix set when spawning the CLI reaches npm.
- isInstalled() is a plain `which`, so an agent installed into a prefix not on PATH reads as "not
  installed".
- bin/npm in the Node tarball is a relative symlink into lib/node_modules/npm/bin/npm-cli.js;
  whether the Tauri bundler preserves it is unverified — plan is to write a two-line shim that
  execs the bundled node against npm-cli.js instead of relying on the symlink.

Build order specified by the ticket:
1. Stage npm from the Node version already pinned in runtime.json — scripts/stage-runtime.sh and
   scripts/stage-runtime.ps1 (Windows twin) — next to the node binary. Use the same tarball
   already being fetched, don't fetch npm from elsewhere.
2. Spawn the CLI with npm_config_prefix pointing at ~/.codemie/agents, and prepend that directory's
   bin to PATH. Every command the app runs is built in src-tauri/src/commands/runner.rs, in the
   shell helper that already does command.env("PATH", p) (around line 53) — npm_config_prefix
   belongs next to it.
3. Add the same bin to the PATH entries src-tauri/src/commands/pathman.rs's persist_to_zprofile
   (around line 233) already writes to ~/.zprofile, so an installed agent runs in the user's own
   terminal.

Acceptance criteria:
- On a clean macOS machine (no Node, no npm), installing an npm-based agent from the Agents screen
  succeeds.
- Removing that agent from the Agents screen succeeds on the same machine.
- The installed agent runs from a fresh terminal.
- No admin credential prompt appears.
- The user's own Node.js and global npm packages are unchanged.
- The PATH change stays in ~/.zprofile, one block.
- build-installer.sh exits non-zero with a named path if npm is missing, empty or unexecutable.
- cargo fmt --check, cargo clippy -- -D warnings, cargo test and npm test pass.

Out of scope: signing the added files (EPMCDME-14508/14899), running staging steps in CI
(EPMCDME-14630), any change to the Agents screen itself (EPMCDME-14514).

Reference doc already in repo: .ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md
— read it, it has the measurements behind this decision.

---

## 2. Codebase Findings

### Existing Implementations

**Staging scripts** (`scripts/stage-runtime.sh`, `scripts/stage-runtime.ps1`):
- Read `runtime.json` with a system node (`command -v node` required just to parse JSON / run npm
  install; the shipped product never needs a system node).
- Step 1 (Node runtime): downloads `node-v$NODE_VERSION-darwin-arm64.tar.gz` (macOS) /
  `node-v$NODE_VERSION-win-x64.zip` (Windows) from `https://nodejs.org/dist/v$NODE_VERSION/...`,
  verifies SHA-256 against `runtime.json`, then extracts **only**
  `node-v$NODE_VERSION-darwin-arm64/bin/node` via `tar -xzf ... -C "$TMP" "node-v.../bin/node"`
  (macOS) — a single-file tar extraction — and copies it to `assets/macos/node/bin/node`
  (`chmod 755`). The macOS script's own comment: "Only the binary ships; npm, headers and docs
  stay out (spec §2)." The Windows script similarly copies only `node.exe` out of the expanded zip.
  Neither script currently touches `lib/node_modules/npm` or `bin/npm` at all.
- Step 2 (CLI tree): writes a throwaway `assets/codemie-cli/package.json` pinning
  `"$CLI_PACKAGE": "$CLI_VERSION"` and runs `npm install --omit=dev` inside `assets/codemie-cli`
  using whatever system npm exists on the developer/CI machine — this is the *build-time* npm use,
  distinct from the *bundled* npm this ticket adds.
- Step 3 (Prune): deletes `*.map`, `test/tests/__tests__/example/examples/docs` dirs, and
  `node-pty`, `typescript`, `@rollup`, `@esbuild`.
- Step 4 (Verify): asserts `node` binary exists, executable, >10 MB, and `node --version` matches
  `runtime.json`'s `nodeVersion`; asserts required CLI files exist and are non-empty
  (`@codemieai/code/bin/codemie.js`, `.../dist/cli/index.js`, `.../package.json`,
  `keytar/build/Release/keytar.node`); asserts no dangling symlinks in the CLI tree ("the bundler
  copies symlink targets" — directly relevant to the bin/npm symlink concern in the ticket).
- Step 5 (Manifest): writes `assets/staging-manifest.json` with `nodeVersion`, `cliPackage`,
  `cliVersion`, `fileCount`, `byteSize`.
- Both scripts are explicitly documented as idempotent and as "the sole producer" of the staged
  runtime artifacts.

**runtime.json** (repo root), exact current contents:
```json
{
  "nodeVersion": "22.23.2",
  "nodeWin64Sha256": "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
  "nodeMacosArm64Sha256": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  "cliPackage": "@codemieai/code",
  "cliVersion": "0.15.2"
}
```
No npm-specific sha field exists yet (npm ships inside the same Node tarball, so no separate hash
is needed unless a design decides otherwise — flagged as a design question, not asserted here).

**`src-tauri/src/commands/runner.rs`** (198 lines total incl. tests):
- `shell_cmd(cmd_str: &str) -> Command` (lines 30–46): builds a `tokio::process::Command` — macOS
  runs `/bin/zsh -lc <cmd_str>` (login shell so `.zprofile` PATH loads), Windows runs
  `cmd.exe /c <cmd_str>` with `CREATE_NO_WINDOW`.
- `pub async fn capture(cmd: &str, path_override: Option<String>) -> CaptureResult` (lines 50–67):
  the function named in the ticket. Current body:
  ```rust
  pub async fn capture(cmd: &str, path_override: Option<String>) -> CaptureResult {
      let mut command = shell_cmd(cmd);
      if let Some(p) = path_override {
          command.env("PATH", p);
      }
      match command.output().await { ... }
  }
  ```
  Line 53 is exactly `command.env("PATH", p);` as the ticket describes. There is currently only a
  single optional env var applied (`PATH`); no other env vars are set here today.
- Callers of `capture`: `run_capture` (Tauri command, `path_override: None`), `run_fresh_env`
  (Tauri command; computes `path` via `pathman::fresh_env_path(&remembered)` and passes
  `Some(path)`), and `run_self_update`'s fallback branch (`capture("codemie self-update", None)`).
- `run_stream` (lines 86–123) is a **separate** spawn path (also via `shell_cmd`, but with piped
  stdio for line-by-line streaming to the frontend) — it does not go through `capture` and does not
  accept a `path_override` or any env override today.
- `self_update_direct` (lines 147–172) invokes the bundled node binary and CLI entry-point
  directly (`tokio::process::Command::new(node_exe)`), bypassing the shell entirely; no PATH/env
  injection point here either.

**`src-tauri/src/commands/pathman.rs`** (717 lines incl. tests):
- `persist_to_zprofile` Tauri command (lines 232–235):
  ```rust
  #[tauri::command]
  pub fn persist_to_zprofile(entries: Vec<String>) -> CmdResult<String> {
      persist(&entries).map_err(Into::into)
  }
  ```
  This is a thin wrapper; the real logic is the platform-specific `persist()` fn (lines 150–171 for
  macOS). Current macOS `persist()`:
  - Reads `~/.zprofile` (or empty string if absent).
  - Filters `entries` to those not already substring-present in the existing file content.
  - If nothing new, returns early without writing.
  - Otherwise appends **one block**: `"\n{MARKER}\nexport PATH=\"{joined}:$PATH\"\n"` where
    `MARKER = "# Added by CodeMie Installer"` and `joined` is all new entries colon-joined.
  - This block format already satisfies "the PATH change stays in ~/.zprofile, one block" as long
    as future calls pass all desired entries together (repeated calls append additional blocks
    only for genuinely new entries, since existing ones are filtered out via substring match).
- `candidate_dirs()` (lines 23–43, macOS branch): static list `/opt/homebrew/bin`, `/usr/local/bin`,
  `/usr/bin`, `{home}/.npm-global/bin` — no `~/.codemie/agents/bin`-style entry exists yet.
- `inject_bundled_bin_path(app: &AppHandle)` (lines 345–395): the current PATH-injection entry
  point, called from `lib.rs` setup before any plugin loads. It locates the bundled `bin/codemie`
  shim directory (next to the executable, or via `resource_dir()`), prepends it to the in-process
  `PATH` via `std::env::set_var`, and persists it via `maybe_persist(...)` → `persist(...)` when the
  directory `is_install_location` (excludes `/Volumes` DMG mounts and `AppTranslocation` paths) and
  it's not a dev build.
- `fresh_env_path(remembered: &[String])` (lines 85–97): builds a PATH for `run_fresh_env` from
  current `PATH` + `state.remembered` dirs + `candidate_dirs()`, deduped. `remembered` is populated
  by the `augment_path` Tauri command (lines 238–247).
- Windows persistence writes `HKCU\Environment` + broadcasts `WM_SETTINGCHANGE`, separate code path
  (`#[cfg(windows)] fn persist`, lines 173–193) — a Windows equivalent of the npm-prefix bin dir
  would need its own entry in `candidate_dirs()` (Windows branch, lines 34–43) and would flow
  through the same `persist()`/registry path.

**`scripts/build-installer.sh`** (126 lines): five numbered stages, each asserting rather than
warning:
1. `[1/5] Staging` — runs `stage-runtime.sh` (unless `--skip-stage`).
2. `[2/5] Verifying staged artifacts` — checks `assets/macos/node/bin/node` exists, is executable,
   >10 MB, reports the pinned version; checks the same 4 required CLI files as the staging script;
   checks `assets/staging-manifest.json` exists and its `cliVersion` matches `runtime.json`. No
   npm-specific assertion exists yet — this is the natural location for the ticket's "exits
   non-zero with a named path if npm is missing, empty or unexecutable" check (pattern: `[ -f ... ]
   || fail "..."`, `[ -x ... ] || fail "..."`, `[ -s ... ] || fail "..."`).
3. `[3/5] Smoke-testing the staged CLI` — runs the staged node against the staged CLI entry and
   asserts non-empty stdout.
4. `[4/5] Building .app and DMG via Tauri` — `cargo tauri build --bundles app dmg`.
5. `[5/5] Verifying the produced bundle` — checks `Contents/Resources/bin/codemie`,
   `.../node/bin/node` (size >10 MB), `.../cli/node_modules/@codemieai/code/bin/codemie.js`,
   asserts the CLI tree is not flattened (`find -mindepth 4`), asserts no stray `.exe` files in a
   macOS bundle, and finally runs the bundled shim (`$RES/bin/codemie --version`) exactly as an
   installed user would — the file's own comment calls this "the strongest check". This same
   pattern (run the real artifact, assert non-empty output) is the template a post-build npm smoke
   check would follow.
- The header comment is explicit that there is deliberately no verification-skip switch, listing
  three past defects (silent-success `pkg`, silent-exit CLI entry, flattened glob) as the reason.

**Bundle resource mapping** (`src-tauri/tauri.macos.conf.json`, the entire file):
```json
{
  "bundle": {
    "resources": {
      "../assets/macos/bin/codemie": "bin/codemie",
      "../assets/macos/node/bin/node": "node/bin/node",
      "../assets/codemie-cli/node_modules": "cli/node_modules"
    }
  }
}
```
Exactly three resource entries exist today. There is no npm entry. Any staged npm artifact (binary,
shim script, or `lib/node_modules/npm` tree) will need its own key here to end up inside
`Contents/Resources` — this is the mechanism `build-installer.sh`'s post-build assertions (stage 5)
check against (`$RES/...` paths).

**Bundled CLI's own npm usage** (`assets/codemie-cli/node_modules/@codemieai/code/dist/` — this is
the *already-staged* npm package tree checked into the local working copy, gitignored, present
because a prior `stage-runtime.sh` run installed it):
- `dist/utils/exec.js` — the single low-level spawn wrapper. Its `spawn(finalCommand, finalArgs, {
  cwd: options.cwd || process.cwd(), env: { ...process.env, ...options.env }, shell: useShell, ...
  })` (line 44–50) is the exact mechanism the ticket's "context already verified" note relies on:
  any `options.env` passed by a caller is merged **on top of** `process.env`, so an
  `npm_config_prefix` present in the CLI process's own environment (i.e. set by the Rust side when
  it spawns the CLI) is inherited into every `npm`/`npx` child unless a caller explicitly
  overrides `env`.
- `dist/utils/processes.js` — `installGlobal`, `uninstallGlobal`, `listGlobal`, `getVersion`,
  `npxRun` all call `exec('npm', [...], { cwd: options.cwd, env: options.env, timeout, shell:
  isWindows })` — every one forwards `options.env` (which is `undefined` unless the caller sets
  it) straight into `exec`'s `{ ...process.env, ...options.env }` merge. `commandExists(command)`
  (used by `isInstalled`) runs `which <command>` (`where.exe` on Windows) with no env override —
  confirms the ticket's "isInstalled() is a plain `which`" claim exactly.
- `dist/agents/core/BaseAgentAdapter.js` — `install()` (line 140), `installVersion()` (line 162),
  `uninstall()` (line 197) all call `npm.installGlobal`/`npm.uninstallGlobal` with **no** `env`
  argument, and `isInstalled()` (line 224) calls `commandExists(this.metadata.cliCommand)` with no
  env override — confirming the "agent adapters pass none [env]" claim.
- `npmPackage` values found across `dist/agents/plugins/*`: `@codemieai/codemie-opencode` (codemie
  code), `@zed-industries/claude-code-acp`, `@anthropic-ai/claude-code`, `@openai/codex`,
  `@github/copilot`, `@google/gemini-cli`, `@moonshot-ai/kimi-code`, `opencode-ai`, `openwiki`,
  `@earendil-works/pi-coding-agent` — 10 distinct npm-installed agent packages found by this grep
  (the ticket states "8 of 11"; the discrepancy is not reconciled here — some plugins may be
  built-in/non-npm and were not greppable this way, or the count includes ACP variants
  differently. Not resolved by this research pass).

### Architecture and Layers Affected

- **Build/staging layer**: `scripts/stage-runtime.sh` / `stage-runtime.ps1` — where npm would be
  extracted from the already-downloaded Node tarball.
- **Rust backend, command layer** (`src-tauri/src/commands/`):
  - `runner.rs` — `capture()`, the shell execution primitive; `shell_cmd()` builds the login-shell
    invocation all captured/streamed commands run through.
  - `pathman.rs` — `persist_to_zprofile` / `persist()`, `candidate_dirs()`, `inject_bundled_bin_path`.
  - `pty.rs` — `spawn_pty` builds a **separate** `portable_pty::CommandBuilder` with its own
    explicit `TERM`/`HOME`/`PATH` env calls (lines 59–88); this is the actual path used today for
    at least one long-running install command (`codemie install claude --supported`, via
    `ui/handlers.js`'s `runPty`). It is a distinct spawn mechanism from `runner.rs::capture`.
  - `state.rs` — `AppState.node_exe_path` / `cli_entry_path` are populated once at startup from
    `resource_dir()`; a bundled npm path would plausibly be tracked the same way if the design
    calls for it (not asserted here — speculative, see §6).
- **Bundle configuration**: `src-tauri/tauri.macos.conf.json` (`bundle.resources` map) and the
  Windows twin (not yet read in this pass, but architecturally symmetric).
- **Build/verification script**: `build-installer.sh` (and its `.ps1` twin) — pre-build and
  post-build assertion stages.
- **Frontend orchestration** (out of scope per the ticket for the Agents screen itself, but the
  existing install call path passes through it): `ui/handlers.js` (`runPty`,
  `runExternalWindow`), `ui/runner-bridge.js` (`runCapture`, `runFreshEnv`, wraps `run_stream`).

### Integration Points

- **Node tarball → staged assets**: `nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz`,
  same tarball already fetched and checksummed by `stage-runtime.sh` for `bin/node`; the file also
  contains `bin/npm`, `bin/npx`, and `lib/node_modules/npm/` (contents not directly inspected in
  this pass — no cached tarball was found locally; see §6 risk).
- **Rust → CLI child process**: `runner.rs::shell_cmd` → `/bin/zsh -lc <cmd>` (login shell, so
  `~/.zprofile` — where step 3 of the ticket writes the PATH block — is sourced for any command NOT
  routed through `capture`'s explicit `PATH` env override; note `capture`'s `command.env("PATH",
  p)` today only fires when `path_override` is `Some`, i.e. currently only from `run_fresh_env`).
- **CLI child process → npm child process**: `dist/utils/exec.js`'s `env: { ...process.env,
  ...options.env }` merge — confirmed above; this is the load-bearing mechanism for an
  `npm_config_prefix` set on the CLI process to reach npm without any CLI-side code change.
- **Bundle resource mapping → runtime resource_dir()**: `state.rs`'s `node_exe_path`/
  `cli_entry_path` are populated from `resource_dir()` in the `setup` closure (referenced by
  `pathman.rs`'s `inject_bundled_bin_path` doc comment and `runner.rs`'s `run_self_update`); any new
  bundled npm path would resolve the same way.

### Patterns and Conventions

- **Fail-loud, named-path assertions**: every verification step in `stage-runtime.sh` and
  `build-installer.sh` follows `[ -f "$PATH" ] || fail "descriptive message naming $PATH"` /
  `[ -x ... ] || fail ...` / `[ -s ... ] || fail ...`. The ticket's npm-check acceptance criterion
  ("exits non-zero with a named path if npm is missing, empty or unexecutable") is a direct
  continuation of this existing pattern, not a new one.
- **Idempotent staging**: both staging scripts skip re-fetching when the target artifact already
  exists and is valid (`[ ! -x "$NODE_BIN" ]` guard), only forcing a refetch with `--force`.
- **Injected function for testability** (`pathman.rs`): `maybe_persist(dir, dev_build, persist_fn:
  impl FnOnce(&[String]) -> io::Result<String>)` takes the actual `persist` function as a
  parameter so tests can substitute a recording closure without touching the real filesystem
  (`tests_persist_decision` module, lines 468–559). Any new persistence logic in this area would
  likely follow the same injectable-function pattern.
- **Platform split via `#[cfg(windows)]` / `#[cfg(not(windows))]`**: consistent throughout
  `pathman.rs` and `runner.rs` — separate implementations, shared public function names.
- **Verify-with-the-real-artifact, not just presence**: `build-installer.sh` stage 5's strongest
  check is running the actual bundled shim and asserting non-empty output, not just checking the
  file exists — the same pattern would apply to an npm smoke check (e.g. running the bundled
  npm/shim's `--version`).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — describes the "Option B" frontend-brain / thin
  Rust backend split, the full `commands/` module list (including `runner.rs`, `pathman.rs`,
  `pty.rs`), the IPC pattern, and "Adding New System Commands" (6-step recipe: add/extend a
  `commands/` file, `#[tauri::command]`, `CmdResult<T>`, register in `lib.rs`, JS wrapper in
  `runner-bridge.js`, inline `#[cfg(test)]` test).
- `.ai-run/guides/testing/testing-patterns.md` — Rust inline `#[cfg(test)]` tests run against the
  real system (no mocks); JS tests use `node:test` with no framework dependency. Explicitly states
  "the genuine install operations (`install_node`, `codemie setup`, `sudo .pkg`, `~/.zprofile`
  edits) ... are never run automatically. Verify them by hand" — directly relevant since this
  ticket touches `.zprofile` edits and agent install/uninstall.
- `.ai-run/guides/quality-gates.md` — exact commands for `cargo fmt --check`, `cargo clippy -- -D
  warnings`, `cargo test`, `npm test`, and the two-tier build check
  (`./build-installer.sh` full vs. `cargo tauri build` logic-only). Notes the staged runtime must
  exist once per checkout or `tauri-build` aborts with `resource path ... doesn't exist` — relevant
  since this ticket changes what "staged" means.

### Architectural Decisions

- **Requested reference doc not found**: `.ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md`,
  named by the task as already present in the repo, does not exist. See §8.
- The only file present under `.ai-run/decisions/` is
  `2026-09-03-EPMCDME-14505-packaging-approach.md` (not read in depth — different ticket).
- Inline architectural notes found in code (not full ADRs, but decision rationale in comments):
  - `stage-runtime.sh`: "Only the binary ships; npm, headers and docs stay out (spec §2)." — the
    exact line this ticket reverses for npm.
  - `stage-runtime.sh` verify step: "spec §2 step 4, not negotiable".
  - `build-installer.sh` header: three concrete past failure modes that justify "no bypass" for
    verification.
  - `pty.rs` header: references "technical-analysis §12" for the PTY threading design (a prior
    ticket's own generated doc, not this one).
  - `runner.rs::run_self_update`: comment explaining why an absent `node_exe_path`/`cli_entry_path`
    is expected (not an error) when `existing_cli_detected` — precedent for how "bundled path
    absent, fall back" is handled elsewhere in this codebase.

### Derived Conventions

- New Tauri commands are added as `#[tauri::command]` functions in the relevant `commands/*.rs`
  file, registered in `lib.rs`, and given a same-file inline test.
- Cross-platform logic is split via `#[cfg(windows)]`/`#[cfg(not(windows))]` twin functions sharing
  a name, not via a runtime `if cfg!(windows)` inside one function body (exception:
  `is_install_location` and `candidate_bin_names`/`probe_dir`, which do branch at runtime — mixed
  convention, follow whichever is already used by the function being touched).

---

## 4. Testing Landscape

### Existing Coverage

- `src-tauri/src/commands/runner.rs` (lines 215–276): `run_capture_runs_via_shell_and_captures_stdout`,
  `run_capture_reports_nonzero_exit` (unix + windows variants), and
  `self_update_direct_errors_when_node_not_executable` (uses a `tempfile::TempDir` with a
  non-executable placeholder file standing in for the bundled node binary — the stated pattern for
  "success path needs the real bundled node and is exercised by build-installer's post-build shim
  smoke," i.e. some behaviors are deliberately left to the build-script smoke test rather than unit
  tests).
- `src-tauri/src/commands/pathman.rs`: extensive coverage of `dedupe_path`, `missing_entries`,
  `merge_shell_path`, `resolve_shell_path` (real login-shell run, unix only),
  `maybe_persist`/`PersistOutcome` (dev-build skip, DMG/AppTranslocation skip, error propagation —
  all via the injected `persist_fn` pattern), `probe_dir`/`probe_with_bin_dir`/`build_new_path`.
  No existing test calls the real `persist()` function against a real `~/.zprofile` — all
  `persist()`-touching tests substitute a recorder closure.
- `ui/test/setup-driver.test.mjs` (63.4 KB — the largest test file in the repo) and
  `ui/test/setup-parse.test.mjs` — not read in depth this pass, but their size/naming strongly
  suggests they already cover the wizard's install-step driving logic that `runPty`/`runExternalWindow`
  feed into.
- `.ai-run/guides/testing/testing-patterns.md` explicitly states install operations and
  `~/.zprofile` edits are **not** exercised by the automated suite; they're checked by hand and by
  `build-installer.sh`'s smoke stage.

### Testing Framework and Patterns

- Rust: `#[cfg(test)] mod tests { ... }` inline in the same file, `#[tokio::test]` for async,
  `cargo test` from `src-tauri/`. Real system calls, no mocking framework — the existing pattern
  substitutes plain closures/`impl Fn` parameters (`maybe_persist`, `probe_with_bin_dir`) when a
  side effect needs to be observed without touching the real filesystem.
- JS: `node --test ui/test/*.test.mjs`, `node:assert/strict`, no external test framework.

### Coverage Gaps

- No test exercises the real macOS `persist()` writing to an actual `.zprofile`-equivalent file
  end-to-end (all tests go through the injected closure) — a new PATH block written by this ticket
  would need either a new closure-injection test or a tempfile-backed integration test if "one
  block" formatting is to be verified against real file I/O.
- No existing test covers `capture()`'s env-var handling beyond `PATH` (no test today sets any
  other env var through `capture`), so an `npm_config_prefix` addition has no existing pattern to
  extend beyond the `PATH` precedent at line 53.
- `pty.rs`'s `spawn_pty` has no visible inline test coverage in the portion read (lines 1–100); if
  agent installs route through PTY rather than `capture`, this is an uncovered path for any
  npm-prefix env change (see §6).
- No test in the repo currently exercises `stage-runtime.sh`'s npm-staging step, since it doesn't
  exist yet — a "npm binary present, executable, correct version" assertion would need to be added
  following the existing `node --version` verify-step pattern.
- `build-installer.sh` has no automated test harness of its own (it's a shell script, verified by
  running it) — consistent with the guide's note that install operations are checked by hand.

---

## 5. Configuration and Environment

### Environment Variables

- `PATH` — read via `std::env::var("PATH")` throughout `runner.rs`, `pathman.rs`, `pty.rs`;
  written via `std::env::set_var` in `inject_bundled_bin_path` and read/merged in
  `fresh_env_path`/`merge_shell_path`.
- `HOME` (macOS) / `USERPROFILE` (Windows) — used by `pathman.rs::persist` to locate the profile
  file / registry, and by `pty.rs` for the spawned shell's `cwd`/env.
- `SHELL` — read in `pathman.rs::resolve_shell_path` (defaults to `/bin/zsh` if unset).
- `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` — smoke-mode flags referenced in
  `architecture.md` and `commands/smoke.rs` (not read in depth this pass).
- No `npm_config_prefix` or any `npm_config_*` variable currently appears anywhere in
  `src-tauri/src/` (confirmed by the searches run in this pass) or in the staged CLI's own
  `dist/utils/*.js` files.

### Configuration Files

- `runtime.json` (repo root) — pins `nodeVersion`, per-platform Node sha256, `cliPackage`,
  `cliVersion`. Read by both staging scripts and by `build-installer.sh`/`.ps1` (via a one-off
  `node -e` JSON read).
- `src-tauri/tauri.macos.conf.json` / `tauri.windows.conf.json` — `bundle.resources` maps staged
  asset paths to their location inside the built app bundle; currently 3 entries on macOS (shim,
  node binary, CLI node_modules).
- `assets/staging-manifest.json` — generated, not hand-edited; records what a given staging run
  produced (node/CLI versions, file count, byte size). Checked by `build-installer.sh` stage 2.
- `assets/codemie-cli/package.json` — a throwaway manifest written by the staging scripts solely to
  pin the CLI's npm resolution; regenerated whenever its content would differ.

### Feature Flags and Deployment Concerns

- No feature flag or runtime toggle governs npm bundling today — its absence is unconditional
  (`stage-runtime.sh` never stages it, `tauri.macos.conf.json` never maps it).
- Deployment concern explicitly named in the ticket as out of scope: signing the newly-added files
  (separate tickets EPMCDME-14508/14899) and running staging steps in CI (EPMCDME-14630) — i.e.
  this ticket's staging-script changes will run locally/manually, not yet from a CI pipeline, and
  the added npm files will not be independently signed as part of this ticket.
- `build-installer.sh`'s bundle-resources verification (stage 5) already asserts no stray `.exe`
  files ship in the macOS bundle — a parallel assertion for a correctly-placed npm tree/shim would
  fit the same stage.

---

## 6. Risk Indicators

- **PTY spawn path is a second, unaccounted-for env-injection point.** `src-tauri/src/commands/pty.rs::spawn_pty`
  builds its own `portable_pty::CommandBuilder` with only `TERM`, `HOME`/`USERPROFILE`, and `PATH`
  explicitly set (lines 59–88) — a separate mechanism from `runner.rs::capture`. Today at least one
  install command (`codemie install claude --supported`, in `ui/handlers.js`'s `runPty`) already
  runs through this path, not through `capture`. The ticket's plan places `npm_config_prefix` only
  in `runner.rs`'s `capture()` (around line 53); if the not-yet-built Agents screen (EPMCDME-14514,
  explicitly out of scope here) or any current install step invokes agent installs via `runPty`
  instead of `run_capture`/`run_fresh_env`, the env var would not reach that install. Speculative:
  the implementation may need to add the same env var to `pty.rs::spawn_pty` for full coverage —
  not decided by research, but the existing dual-path structure makes this a real fork point.
- **Node tarball's `bin/npm` layout not independently inspected.** No cached/downloaded Node
  22.23.2 darwin-arm64 tarball was found on this machine, so the "relative symlink into
  `lib/node_modules/npm/bin/npm-cli.js`" claim in the ticket (attributed to the user's own prior
  verification) could not be independently re-confirmed by this research pass. `stage-runtime.sh`'s
  own verify step already asserts "no dangling symlink in the CLI tree (the bundler copies symlink
  targets)" for the *CLI* node_modules tree specifically — the same bundler behavior around
  symlinks is the direct motivation for the ticket's planned "two-line shim" approach, but whether
  `tar -x` (as used by the macOS staging step for `bin/node`) preserves or resolves the `bin/npm`
  symlink was not verified here either.
- **Bundle resource mapping has no npm entry.** `tauri.macos.conf.json`'s `bundle.resources` has
  exactly 3 keys today; a new key (or keys, for a shim script plus `lib/node_modules/npm`) is a
  needed structural change and increases file count non-trivially (npm's own `node_modules` tree is
  itself substantial) — not sized in this pass, and not covered by any existing "flattened tree" or
  "nesting depth" assertion in `build-installer.sh` until one is added.
- **No unit-test precedent for `capture()`'s env vars beyond `PATH`.** Every existing test of
  `capture`/`shell_cmd` only ever sets or asserts `PATH`; adding a second env var
  (`npm_config_prefix`) has no established test shape to imitate directly in this file.
- **`persist()`'s "one block" behavior is substring-matched, not marker-scoped for updates.** The
  current macOS `persist()` filters candidate entries against the raw *file content* via
  `existing.contains(e.as_str())`. If a future PATH entry is a substring of, or overlaps
  unexpectedly with, an already-written line, the dedup logic could behave unexpectedly; today's
  single-purpose use (the bundled `bin/codemie` shim dir only) has never exercised a second,
  independent PATH addition from a different call site in the same file — this ticket is the first
  to add a second distinct call site into the same `.zprofile` block mechanism, another
  candidate but not asserted to be broken.
- **npm-package count discrepancy (8 of 11 vs. 10 npmPackage entries found).** A grep across
  `assets/codemie-cli/node_modules/@codemieai/code/dist/agents/plugins/**/*.js` for
  `npmPackage:` found 10 distinct npm-backed agent entries, not the ticket's stated "8 of 11" — not
  reconciled by this research pass (could reflect a different CLI version at the ticket's time of
  writing, ACP variants counted differently, or agents not read in this grep's scope).
- **Requested decision doc is missing from the repo**, so none of its "measurements behind this
  decision" could be sourced — see §8. Anything the spec/plan stage would draw from that doc must
  instead be re-derived or re-confirmed with the requester.

---

## 7. Summary for Complexity Assessment

This task touches the build/staging layer (`scripts/stage-runtime.sh` and its Windows twin), the
Rust backend command layer (`runner.rs::capture`, `pathman.rs::persist`/`candidate_dirs`, and
possibly `pty.rs::spawn_pty` — a second, currently-unaddressed spawn path already used by at least
one install command), the bundle resource configuration (`tauri.macos.conf.json`/
`tauri.windows.conf.json`, currently 3 mapped resources with no npm entry), and the build
verification script (`build-installer.sh`/`.ps1`). Every location the ticket names was located and
read at the exact line it named (`runner.rs` line 53's `command.env("PATH", p)`, `pathman.rs`'s
`persist_to_zprofile` at line 232), and the CLI-side env-inheritance and `isInstalled()`/`which`
claims were independently confirmed by reading the staged `@codemieai/code` package's
`dist/utils/exec.js`, `dist/utils/processes.js`, and `dist/agents/core/BaseAgentAdapter.js`.

Technical novelty is moderate-to-high: this is the first ticket to stage a second binary/tree out
of the Node tarball (today's script deliberately extracts only `bin/node`), the first to add a
second Tauri-bundle resource beyond the existing 3, and — per the PTY-path risk above — the fix may
need to reach a spawn mechanism (`pty.rs`) the ticket's own build-order does not mention. Test
coverage for the exact functions this ticket touches is solid for the *decision logic*
(`maybe_persist`, `dedupe_path`, `missing_entries`) via injected closures, but there is no existing
test of `capture()`'s env handling beyond `PATH`, no test of the real `persist()` writing to a real
file, and the testing guide explicitly excludes install operations and `.zprofile` edits from
automated coverage — hand verification (and the `build-installer.sh` smoke stage) will carry real
weight here, consistent with how the existing bundled-node and bundled-CLI verification already
works.

Key risk factors: the requester-named decision doc
(`.ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md`) does not exist in the repo
and its "measurements" are unavailable to this or later stages; the Node tarball's `bin/npm`
symlink structure could not be independently verified locally (no cached tarball); and the PTY
spawn path is a real, code-confirmed second place agent installs can run through, which the
ticket's stated build order does not address.

---

## 8. External References

**`.ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md`** — **unresolved**. The
task names this as "already in repo" and as the source of "the measurements behind this decision."
It does not exist: `.ai-run/decisions/` contains only
`2026-09-03-EPMCDME-14505-packaging-approach.md`. A repo-wide search for `14514` and for
`npm-for-agent-install` in any filename found no matches, and no `decisions/` directory exists
anywhere else in the tree. This should be raised with the requester before the spec/plan stages
proceed on the assumption that doc's measurements are available — none of its content could be
sourced by this research pass.
