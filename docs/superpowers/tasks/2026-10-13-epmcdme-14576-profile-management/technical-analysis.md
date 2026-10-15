# Technical Research

**Task**: profile management codemie_config runner-bridge home-view
**Generated**: 2026-10-13
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14576. Manage all CodeMie CLI profiles from the app: list, switch, rename, delete. Every action goes through the CLI and the shared ~/.codemie/codemie-cli.config.json.

Spec / constraints from the user:
- Branch feat/EPMCDME-14576-profile-management off codemie-desktop-stage-2. PR goes to codemie-desktop-stage-2. Never commit .codemie/codemie-cli.config.json, .ai-run/guides/project.md, AGENTS.md (local edits).
- CLI: `codemie profile switch <name>`, `codemie profile rename <old> <new>`, `codemie profile delete <name> --yes` each print a line starting with ✓ on success and exit 1 on failure (exit code trustworthy, unlike profile login).
- src-tauri/src/commands/profile.rs already has delete_profile, quote_arg, codemie_in_root (runs from filesystem root on both platforms, name always quoted). Add switch and rename next to delete, same shape. ui/runner-bridge.js has `export const profile` with delete wrapped in logged(...) so it shows in "what CodeMie ran". Add new ones the same way.
- List: read the config file, not the CLI. src-tauri/src/commands/codemie_config.rs only resolves the active profile today (parse_config). Add a list of every profile with name, provider, model, and which is active. Keep the existing CodemieConfig result as is.
- After every action, re-read and re-render; never update UI from the action's own reply. refreshIdentityOnComplete() in ui/renderer.js already does that for the identity bar.
- Deleting the last profile already returns Home to the checklist (ui/home-state.js brokenKind treats empty activeProfile as no profile). No new path. Broken-profile panel on Home unchanged.
- List entry point: open from the Profile card on Home, in ui/home-view.js where the "Set up again" button is; keep entry point in one place so it can move to the sidebar later. "Add a profile" in the list calls the same onSetupAgain. No wireframe for the list; follow Home's card look in docs/wireframes/01-home.png and Tools rows in ui/agents-ui.js.
- Never run a real codemie in tests; use fake commands. Do mutation check on new tests.
Scope: List (name, provider, model, active); Switch (Home Profile card + identity bar update without restart); Rename (inline entry; if CLI refuses (name exists) show its message, nothing changes); Delete (confirmation first, says so when it is the active profile; afterwards shows which profile is active now; reuses delete_profile / bridge.profile.delete, no second delete call); Add (opens existing guided setup).
AC: several profiles -> each shows name/provider/model, exactly one active; rename to existing name -> nothing changes, CLI message shown; delete active with others remaining -> list and Home show the profile CLI made active; delete last -> Home shows setup checklist; every action's command shown in "what CodeMie ran" with real output; CLI-created profiles listed as is with no migration.
Out of scope: editing provider/credentials/model form; repo-local .codemie profiles; broken-profile panel.

Load the repo's .ai-run/guides (architecture, testing, development, quality-gates) as relevant. Pay particular attention to: the config file shape (profiles map vs array, activeProfile key), existing JS tests (node:test) and Rust inline tests patterns, how home-view/agents-ui render rows, and how failure panel/confirm dialogs are done.

---

## 2. Codebase Findings

Stack: Tauri v2 app, Rust backend (`src-tauri/`) plus vanilla JS ES modules (`ui/`, no bundler, `"type": "module"`). package.json has no dependencies, only scripts (`npm test` = `node --test ui/test/*.test.mjs`).

### Existing Implementations
- `src-tauri/src/commands/profile.rs` (129 lines, from commit 9584dbb, EPMCDME-14658):
  - `pub fn quote_arg(s, windows) -> Result<String,String>`: rejects empty/blank and NUL; on Windows also `%`, `\n`, `\r`; POSIX single-quote escaping, Windows double-quote doubling.
  - `pub fn codemie_in_root(args: &[&str], windows)`: `cd / && codemie {args} < /dev/null` (POSIX) or `cd /d %SystemDrive%\ && codemie {args}` (Windows).
  - private `delete_command(name, windows)` builds `profile delete <quoted> --yes`.
  - `#[tauri::command] pub async fn delete_profile(name: String) -> CmdResult<CaptureResult>`: maps a build error to `InstallerError::Other`, then `capture(&cmd, None).await`. A non-zero exit is NOT an Err: it comes back as `CaptureResult { code, stdout, stderr }`.
  - Inline tests: quoting (POSIX/Windows/hostile name via real `/bin/zsh -c printf`), `builds_the_delete_command_per_platform` asserting exact command strings.
  - No switch or rename exists yet.
- `src-tauri/src/commands/codemie_config.rs`:
  - `ConfigState` enum (`no-configuration` | `valid` | `broken`, kebab-case serde), `CodemieConfig { state, profile, model, project, account }`.
  - `parse_config(raw: &str) -> CodemieConfig` is the pure seam; `read_codemie_config()` is the `#[tauri::command]` (sync, never fails; missing file = default). `config_path()` uses `$HOME`/`$USERPROFILE` + `/.codemie/codemie-cli.config.json`; `config_path_with(home)` is the testable form.
  - Header comment explains why a file read is used rather than `runCapture("cat")` (typed contract, no login shell, tests).
  - No list function exists.
- `ui/runner-bridge.js`:
  - `logged(cmd, run, codeOf)` opens a cmdlog record (`cmdlog_open`), runs, closes with exit code (`codeOf(res) ?? -1`, rejection = -1). NOTE: it logs only the command string and the exit code. `logged` never appends output (`cmdlog.append`) — unlike `runner.runCapture`, which appends `String(res)`. AC "with real output" therefore needs the new wrappers (or `logged`) to append stdout/stderr; the existing `profile.delete` does not.
  - Also note the logged label for delete is the fixed string `'codemie profile delete'` (no profile name, no `--yes`), not the real command line that Rust builds.
  - `export const codemieConfig = { read: () => invoke('read_codemie_config') }` and `export const profile = { delete: (name) => logged('codemie profile delete', () => invoke('delete_profile', { name }), (r) => r?.code ?? 0) }`.
- `ui/home-view.js` (`createHomeView(container, { stepsUi, onItem, onSignIn, onCard, onSetupAgain, onInstallAgent, onDeleteProfile })`):
  - `renderCards` builds `.home-card` per `state.cards`; for `card.id === 'profile'` it adds a `btn btn-ghost home-card-action` "Set up again" button (title "Add a new profile, or update one you already have.") in the card head, calling `onSetupAgain?.()`, and the Profile card has no `onclick` (other cards call `onCard`).
  - View-local state lives outside `render()` (`expanded`, `busy`, `failure`, `deleting`, `deleteFailure`, `lastState`) so a re-render does not lose in-flight work; `rerender()` re-calls `render(lastState)`.
  - `renderBroken` uses `renderFailurePanel` with `Delete this profile` (secondary, disabled while deleting) for the `expired` kind only; `dangling` shows only "Set up again". This is the existing delete UI and is out of scope.
- `ui/renderer.js`:
  - `home = { config, auth, agents, health, connection }` (line ~176); `homeScreen = createHomeView(...)` at 178 with `onSetupAgain: () => openGuidedSetup()` and `onDeleteProfile: deleteActiveProfile`.
  - `deleteActiveProfile()` (line ~195): takes the name from `home.config.profile`, calls `bridge.profile.delete(name)`, treats `res.code === 0` as ok, otherwise builds `{ok:false, message: last non-empty line of stdout+stderr, raw}`; catches rejections; always `await refreshIdentityOnComplete()`. This is the pattern the new switch/rename/delete handlers would mirror.
  - `refreshIdentityOnComplete()` (line ~458): `bridge.codemieConfig.read()` -> `renderIdentity(cfg)`, then `bridge.inspector.checkProfileStatus()` -> `updateIdentityAuthStatus(st)`, which sets `home.auth` and calls `renderHome()`. Presumably `renderIdentity` sets `home.config` (not read; verify before relying on it).
- `ui/home-state.js`: `brokenKind({config,auth})` returns null when `config.profile` is empty (so last-profile delete falls to the checklist); `profileCard(config, auth)` yields `{id:'profile', title:'Profile', badge, line:"<profile> · <model>", note:"Project <x>"}`; `deriveHome` returns `cards` array and `done`/`broken`.
- `ui/agents-ui.js`: `renderAgents(container, {agents, selected, progress}, {stepsUi, onInstall, onUpdate, onRemove, onSelect})`. Rows are the shared steps-ui list (`stepsUi.renderSteps` + `setStatus` + `setSubtitle`), then per-row `.agent-actions` slot of `btn btn-accent|btn-ghost` buttons appended to the `.step-row`; one details block `.agent-pane` is moved under the selected row; any action click disables every button on the screen and swaps the label to a busy label; failures use `renderFailurePanel` inside the pane. `showLoading` / `showRunError` for the load states.
- `ui/failure-panel.js`: `renderFailurePanel(container, {variant, title, explanation, detail, raw, command, primaryLabel, onPrimary, secondaryLabel, onSecondary, secondaryDisabled})`; one panel per container (replaces prior); `raw` gets a "Show details" toggle. Pure DOM.
- `src-tauri/src/lib.rs`: `commands::profile::delete_profile` is registered at line 115 (in `invoke_handler`; `commands::inspector::check_profile_status` at 110). `commands/mod.rs` already declares `pub mod profile;` and `pub mod codemie_config;`.
- `ui/styles.css`: `.home-card-head` (403), `.home-card .btn.home-card-action` (421, `width:auto; padding:4px 10px; font-size:12px; margin-left:auto`), `.agent-actions` (1057-1058).

### Architecture and Layers Affected
- Rust command layer: `commands/profile.rs` (new switch/rename commands), `commands/codemie_config.rs` (new list reader), `lib.rs` (register new commands).
- JS bridge layer: `ui/runner-bridge.js` (`profile` and `codemieConfig` objects).
- JS controller/wiring layer: `ui/renderer.js` (handlers, refresh, `createHomeView` options).
- JS view layer: `ui/home-view.js` (Profile card entry point), plus a new presentational module for the list is the natural home (the repo splits view modules: `agents-ui.js`, `home-agent-picker.js`, `connections-render.js`); `ui/styles.css`; possibly `ui/index.html` if the list gets its own container (not decided).
- Pure derivation: `ui/home-state.js` unchanged by the stated scope.

### Integration Points
- `codemie` CLI via `runner::capture` (login shell `/bin/zsh -lc`, `cmd.exe /c` on Windows) from `/` (no project config).
- Shared `~/.codemie/codemie-cli.config.json`, read by Rust, written only by the CLI.
- `cmdlog_*` commands (`commands/cmdlog.rs`) feed "what CodeMie ran" (`ui/cmdlog-ui.js`, `ui/cmdlog-failure-map.mjs`); I did not read these.
- Guided setup: `openGuidedSetup()` in renderer.js (used by `onSetupAgain`), for "Add a profile".
- Identity bar and `home.config`/`home.auth` are refreshed together by `refreshIdentityOnComplete`.

### Patterns and Conventions
- Rust command: pure builder returning `Result<String,String>` + thin `#[tauri::command] async fn` returning `CmdResult<CaptureResult>`; exact-string tests per platform. Parse seam as a pure function over raw text, command wrapper reads the file.
- JS bridge: one `invoke` wrapper per command, `logged(...)` for Rust-run CLI commands, doc comment above the export describing the resolved shape.
- Handlers in renderer.js never throw: they return `{ok, message, raw}`, and always re-read after the action.
- Views take injected callbacks (`onX`) and are tested with DOM stubs; state that must survive re-render is kept outside `render()`.
- Failure/errors render inline with `renderFailurePanel`, never a modal (project memory and the `failure-panel.js` header agree).
- Commit style per memory: `EPMCDME-14576 : subject`; branch name uppercase ticket ID (given branch matches).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md`: Option B; 6-step recipe for new commands (commands/ file, `#[tauri::command]`, `CmdResult`, register in `lib.rs`, JS wrapper in runner-bridge.js, inline test). Its file map is dated (does not list profile.rs/codemie_config.rs).
- `.ai-run/guides/testing/testing-patterns.md`: Rust inline `#[cfg(test)]`, `#[tokio::test]` for async, no shell mocks in Rust; JS `node:test` + `node:assert/strict`, files `ui/test/<module>.test.mjs`; "don't test Tauri invoke()" (but `ui/test/connectors-bridge.test.mjs` stubs `window.__TAURI__` and imports the bridge, and `cmdlog-bridge.test.mjs` exists, so a bridge test is an established pattern).
- `.ai-run/guides/development/development-practices.md`: `CmdResult<T>`, no `unwrap()` in commands, `InstallerError::Other` for one-offs.
- `.ai-run/guides/quality-gates.md`: `cd src-tauri && cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test`; macOS cargo needs `scripts/stage-runtime.sh` once per checkout.
- `.ai-run/guides/standards/git-workflow.md`, `project.md` (project.md is locally modified; do not commit).

### Architectural Decisions
- `.ai-run/decisions/2026-09-23-EPMCDME-14513-add-or-update.md` (guided setup add-or-update; not read, relevant to "Add a profile").
- `.ai-run/decisions/2026-09-21-EPMCDME-14589-home-grid-actions.md` (Home grid retired; Home content in home-view.js).
- No ADR specific to profile management found.

### Derived Conventions
- Comments explain "why" in file headers; ticket IDs appear in comments.
- No existing confirm dialog for destructive actions was found: grep for confirm/are you sure in `ui/*.js` hits only setup-parse/setup-view (CLI prompt answering). Overlays in `index.html`: `terminal-overlay`, `notice-overlay`, `fatal-overlay`, `runtime-overlay`. So "confirmation first" has no existing helper; the nearest inline precedents are the failure panel with primary/secondary buttons and the Agents Remove button (which acts on click, no confirmation).
- Config file shape (from this machine's real `~/.codemie/codemie-cli.config.json`, keys only, no values read): top-level keys `version`, `activeProfile` (string), `userEmail`, `profiles` (OBJECT map keyed by profile name), `workspace`. Each profile object has `provider`, `baseUrl`, `apiKey`, `model`, optional `authMethod`, `codeMieUrl`, `codeMieProject`, `haikuModel`/`sonnetModel`/`opusModel`, and a `name` field repeating the key. Profiles is a map, not an array. `parse_config` already treats it as a map (`json.get("profiles").and_then(|p| p.get(profile))`). The `apiKey` field is present in profile objects, so a list struct must not include it.

---

## 4. Testing Landscape

### Existing Coverage
- `profile.rs` inline tests (quote_arg, delete command strings, hostile name through real zsh).
- `codemie_config.rs` inline tests (unreadable, valid, no account, workspace project, workspace wins, broken, serialization, path helpers).
- `ui/test/home-view.test.mjs`: DOM stub (`makeEl`, `find`, `matches`, `_click` bubbling), `fakeStepsUi()`, helpers `buttons(container)`, `labels(container)`; covers expired panel with Sign in/Delete, dangling shows no Delete, delete runs once while in flight, failed delete shows CLI sentence inline.
- `ui/test/agents-ui.test.mjs` (own DOM stub with insertBefore/parentNode), `failure-panel.test.mjs`, `home-state.test.mjs`, `home-copy.test.mjs`, `connectors-bridge.test.mjs`, `cmdlog-bridge.test.mjs`, `agents-controller.test.mjs`.
- No test of `deleteActiveProfile` in renderer.js (renderer.js is not imported by tests; it needs `window`/DOM). No test of `ui/runner-bridge.js` `profile.delete` was found by name (not exhaustively checked).

### Testing Framework and Patterns
- Rust: built-in test harness, inline modules, real system shell where needed; tokio for async. JS: `node:test`, `node:assert/strict`, hand-rolled DOM stubs per test file (no jsdom), injected callbacks, bridge tests stub `globalThis.window.__TAURI__`.
- Fake CLIs: the memory rule "never run a real codemie in tests" applies; Rust tests of the command path should assert command strings (as `builds_the_delete_command_per_platform` does) or run a fake script rather than `codemie`. Fixtures dirs `ui/test/fixtures/{agents,doctor,setup}` hold recorded CLI output; none exists for profile output.
- `ui/test/tools/replay-capture.mjs` exists for replaying recorded captures.

### Coverage Gaps
- Profile list parsing (new), switch/rename command builders (new).
- Renderer-level orchestration (handler -> re-read -> render) is untestable as written because it lives in renderer.js; testing it needs extraction into an importable module (as `agents-controller.js` does).
- Output logging in `logged` is untested for profile.
- Mutation check is required by the task: no existing script for it; per memory, done by deleting the mechanism from production and re-running.

---

## 5. Configuration and Environment

### Environment Variables
- `HOME` / `USERPROFILE` used by `codemie_config.rs::config_path()`. No profile-specific env vars. `CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE` are smoke-mode flags (not relevant).

### Configuration Files
- `~/.codemie/codemie-cli.config.json` (global, shared with the CLI; many `.bak*` siblings exist on this machine, CLI-made).
- `.codemie/codemie-cli.config.json` in the repo (repo-local, modified locally, never commit; repo-local profiles are out of scope).
- `src-tauri/Cargo.toml` (not read in this pass; serde and serde_json are already used by codemie_config.rs).
- `src-tauri/capabilities`: per codemie_config.rs header, only `core:default` is granted and no fs plugin, so the file read must stay in Rust.

### Feature Flags and Deployment Concerns
- None found. Windows parity matters: `codemie_in_root` and `quote_arg` branch on `windows`; build via `build-installer.sh` / `.ps1`. Local uncommitted edits to `.ai-run/guides/project.md`, `.codemie/codemie-cli.config.json`, `AGENTS.md` are present in the working tree (git status) and must be left out of commits.

---

## 6. Risk Indicators

- Output not in the command log: `logged()` records only the command label and exit code, never stdout/stderr; the AC says every action's command appears "with real output". Existing `profile.delete` label is the fixed string `'codemie profile delete'` without the name. Speculative: new wrappers will need to append output (and probably the real command text) to the cmdlog record; check `cmdlog.rs` and `cmdlog-ui.js` for how the record is displayed.
- Secrets: the real config's profile objects contain `apiKey`. Speculative: the list result should be an explicit allow-list of name/provider/model/active so the key never crosses IPC.
- Profile name versus key: profiles carry a `name` field in addition to the map key; they could differ for hand-edited or CLI-created entries. The CLI argument is whichever the CLI resolves; this needs verification against the CLI before choosing which to pass.
- Order and `activeProfile` edge cases: `activeProfile` may be empty (after last delete) or name a missing profile (the "broken/dangling" state); a list must tell "exactly one active" from zero actives.
- Names with special characters: `quote_arg` rejects `%`, newline on Windows; rename takes two names, both need quoting; rename new-name validation by the CLI only.
- Exit code for `profile switch`/`rename` is trusted (per task), but `capture()` returns non-zero as `Ok(CaptureResult)`; handlers must check `code`, as `deleteActiveProfile` does.
- Delete flow: delete confirmation has no existing component; the active-profile delete must reuse `bridge.profile.delete` once; `deleteActiveProfile` is tied to `home.config.profile` and cannot be reused as is for an arbitrary named profile. Concurrency: Home already guards double delete with a `deleting` flag outside `render()`; the list needs the equivalent for switch/rename/delete (one CLI action at a time, as Agents does).
- renderer.js is 46 KB and untestable under node; logic added there is unverified by the test suite unless extracted.
- Stale docs: the architecture guide's component map omits profile.rs / codemie_config.rs; testing guide says not to test `invoke()` but bridge tests do it.
- Wireframe: none for the list; `docs/wireframes/01-home.png` not viewed in this pass.
- Parallel writers: the CLI and wrapper agents share the config file; a re-read after an action can race an in-progress CLI write (unlikely given sequential awaits).

---

## 7. Summary for Complexity Assessment

The change touches four layers: Rust commands (`profile.rs` adds switch and rename beside the existing delete using the same builder pattern, `codemie_config.rs` adds a list reader beside `parse_config`, `lib.rs` registers the commands), the JS bridge (`runner-bridge.js` `profile` and `codemieConfig`), JS wiring in `renderer.js` (handlers mirroring `deleteActiveProfile`, refresh via `refreshIdentityOnComplete`), and the view layer (`home-view.js` Profile card entry point plus a new list view, CSS). Every piece has a close precedent in the repo, so technical novelty is low: no new dependencies, no new IPC mechanism, config is a plain `profiles` map plus `activeProfile`.

Test posture is good for the Rust side (inline pure-seam tests for both files) and for pure view modules (`home-view`, `agents-ui`, `failure-panel` all have DOM-stub tests that serve as templates). Gaps are renderer.js orchestration (not importable under node) and the cmdlog output recording. There are no fixtures of profile CLI output and no existing confirmation component, so Delete's confirm-first behavior and the rename inline entry are new UI patterns without a direct precedent.

Main risks are the "real output in what CodeMie ran" requirement (the current `logged` helper does not record output), keeping `apiKey` out of the list payload, choosing map key versus `name` field, serialising CLI actions while the view re-renders, and keeping new logic outside renderer.js so it can be tested and mutation-checked. Local uncommitted edits to three tracked files must stay out of commits.

---

## 8. External References

None named by the task. The task points at in-repo files (`ui/runner-bridge.js`, `ui/home-view.js`, `ui/home-state.js`, `ui/agents-ui.js`, `docs/wireframes/01-home.png`) and the `~/.codemie/codemie-cli.config.json` file. The config was inspected for key names only (top-level keys, profile field names), never values. The CLI behaviour in the task (`✓` line, exit 1, `--yes`) is taken from the task text; no CLI was run and `docs/wireframes/01-home.png` was not opened.
