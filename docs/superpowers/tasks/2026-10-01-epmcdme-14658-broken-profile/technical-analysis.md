# Technical Research

**Task**: home failure-panel profile delete (EPMCDME-14658, broken-profile part)
**Generated**: 2026-10-01
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14658 — Broken profile on Home (broken-profile part). Repo: /Users/mert_efe/codemie-installers/codemie-claude-installer-macos (Tauri app: frontend-brain in ui/, thin Rust backend in src-tauri/). Load .ai-run/guides/architecture/architecture.md and development-practices.md and testing-patterns.md first.

User brief: Branch feat/EPMCDME-14658-broken-profile stacked on feat/EPMCDME-15247-qa-fixes. Only the broken-profile panel; the npm "two copies" panel is out of scope. The panel goes inline on Home through ui/failure-panel.js (app-wide panel Health and setup use), not showNotice. renderFailurePanel takes one action today (primaryLabel and onPrimary); add an optional secondary action for "Delete this profile", keep existing callers working (Health and setup tests cover them). Today Home only marks the sign-in step "Your profile is no longer working" (ui/home-state.js ~line 47, config.state === 'broken'). Auth states from check_profile_status: signed_in, not_signed_in, unknown, no_profile. Broken = config.state === 'broken' OR auth not_signed_in. unknown is never broken; no_profile is a first run and stays on the checklist. Sign in again reuses startSignIn() in ui/renderer.js and signInAction() in ui/home-state.js. Bundled CLI has `codemie profile delete [profile] -y`: it reads a project-local .codemie from cwd so run from / like setup does (cd / && codemie profile delete <name> --yes); name must always be passed and shell-quoted (otherwise a selection prompt hangs the capture; name comes from user config). One small helper for the call (Rati's EPMCDME-14576 will reuse it). When the deleted profile was active and others remain, the CLI switches active profile itself and prints "Active profile is now: X"; after delete Home shows that profile, checklist only when none left. Re-read config and auth after deleting rather than assuming.

Spec: panel draws two actions "Sign in again" and "Delete this profile" with body text explaining the choice; an illustrative `codemie doctor` line in the wireframe is texture only — do NOT add a doctor read. Wireframe: docs/wireframes/01-home.png, the "Broken profile" quarter. Expose deletion as `codemie profile delete <name> --yes` behind a bridge call (Rust command registered in src-tauri/src/lib.rs invoke_handler + JS bridge). ACs: expired/unresolvable profile shown broken in place on Home with both actions, deleting does not restart onboarding; `unknown` never broken; delete via UI-callable command with name always supplied. Do NOT build sign-in/auth parsing (14515), no profile listing/switching/renaming. Gates: npm test; cargo fmt --check, cargo clippy -- -D warnings, cargo test from src-tauri/. Rebuild before smoking: cd src-tauri && CI=true cargo tauri build.

Research focus: exact current code in ui/home-state.js, ui/renderer.js (Home render, startSignIn), ui/failure-panel.js and ALL its callers + their tests, the Rust command that runs CLI commands (how setup does `cd /`, quoting, existing helpers), the bridge file, how config state / auth status are read, existing test patterns for home-state and failure-panel. Also view docs/wireframes/01-home.png (Read tool can view images) and describe the Broken profile quarter's layout/text. Report exact file:line anchors.

---

## 2. Codebase Findings

### Existing Implementations

Frontend (all paths under the repo root):

- `ui/failure-panel.js` (100 lines). `renderFailurePanel(container, { variant='error', title, explanation, detail, raw='', command, primaryLabel, onPrimary })` at line 26-35. Removes any existing `.failure-block` in the container (36), builds `.failure-block > .failure-panel(.warning)` with `.failure-title` (44), `.failure-body` from `explanation` (49-54), `.failure-detail` (59-64, skipped when equal to title), hidden `pre.failure-raw` (66-69). The `.failure-actions` row is built at 71-94: primary button `btn btn-accent` (73-79, `onclick = () => onPrimary?.(block)`), then a ghost "Show details" button only when `raw` is non-empty (80-92). The row is appended only if `primaryLabel || raw` (94). Returns `block`. There is no second-action slot today. Header comment (lines 1-13) already names "Home's broken profile (01-home.png)" and says a warning has no actions.
- `ui/home-state.js` (204 lines), pure, no DOM:
  - `signInItem` 31-40: `auth` null gives ACTIVE "Checking…"; `signed_in` and `unknown` give COMPLETE; anything else (not_signed_in, no_profile) gives PENDING "Opens your browser".
  - `modelItem` 42-49: `config.state === 'broken'` gives WARNING "Your profile is no longer working" (line 47). The brief calls this the "sign-in step"; in code it is item 2, `model`.
  - `profileCard` 86-100: badge is `active` for signed_in/unknown; `needs attention` (tone bad) only when `config.state === 'broken'` and auth is neither signed_in nor unknown; otherwise `not signed in` (tone warn). So a valid config with `not_signed_in` shows "not signed in", not "needs attention".
  - `signInAction({config, auth})` 172-175: returns `'setup'` when auth `no_profile` or config missing / `no-configuration`, otherwise `'login'`.
  - `deriveHome(...)` 181-204. Line 188: `signedOut = !!auth && auth.state !== 'signed_in' && auth.state !== 'unknown'` (note this includes `no_profile`). Line 189: `done = complete || (onboarded && !signedOut)`. Line 196: `unlocked = done || onboarded`. Returns `{ items, done, authKnown, unlocked, agents, cards }`. Comment at 185-187 says the checklist's Sign in is Home's only button "until the broken-profile panel (EPMCDME-14658)". There is no `broken` field in the returned state today.
- `ui/home-view.js` (256 lines). `createHomeView(container, { stepsUi, onItem, onSignIn, onCard, onSetupAgain, onInstallAgent })` at 24. `render(state)` 223-237: sets `lastState`, empties the container, then `state.done ? renderCards : renderChecklist`. The sign-in button lives in `renderChecklist` 54-68 (shown while sign-in item is PENDING; disabled while `signingIn`). `renderCards` 196-221 puts "Set up again" in the Profile card head (205-213). `applyHomeHeader` 247-256 toggles `#home-header`, `#home-subtitle`, `#home-updates` by `done`. No call to failure-panel exists in this file yet; the container is `#home-body` (`ui/index.html:78`, header at 69, updates at 81).
- `ui/renderer.js` (965 lines):
  - `home` state object at 173: `{ config, auth, agents, health, connection }`, plus ad hoc `healthRunning`, `healthFailed`, `signingIn`.
  - `createHomeView(...)` wiring 174-188. `onSignIn` at 182: `signInAction(home) === 'setup' ? openGuidedSetup() : startSignIn()`.
  - `onboarded` read once at boot 199 via `readOnboarded(homeStorage)`.
  - `renderHome()` 203-222: `deriveHome({ ...home, onboarded })`; remembers onboarded when `state.done`; `homeScreen.render({ ...state, signingIn: home.signingIn })`; auto health start; `applyOnboardingNav`; `applyHomeHeader`.
  - `showNotice` 362-379 (modal; the brief says not to use it for this panel).
  - `renderIdentity(cfg)` 385-399 (approx; shows product name unless state is valid or broken, sets `home.config = cfg`, calls `renderHome()`).
  - `refreshIdentityOnComplete()` ~ 401-420: re-reads `bridge.codemieConfig.read()` then `bridge.inspector.checkProfileStatus()`, calls `renderIdentity(cfg || {})` then `updateIdentityAuthStatus(st)`. This is the existing "re-read config and auth" sequence, called after setup completes and on window focus (765-771). It is the natural model for re-reading after delete.
  - `updateIdentityAuthStatus(st)` ~ 423-438: sets identity text, `home.auth = st; renderHome()`.
  - `startSignIn()` 587-625: guarded by `home.signingIn`; `renderHome()`; `hideNotice()`; `bridge.runner.runStream('codemie profile login', ...)`; scans lines with `findLoginError` (ui/signin-parse.js) and uses `showNotice` for errors (600-613); then always re-reads `checkProfileStatus` and calls `updateIdentityAuthStatus` (617-624). It does not re-read the config file.
  - Boot reads: auth at 749-753 (rejection becomes `not_signed_in`), config at 756-758 (rejection becomes `{}`). Focus handler 765-771 repeats both, 5s spacing.
  - Health's `signIn: () => startSignIn()` at 510.
  - `ensureAuthenticated()` 561-579 uses `isBlockedState` (ui/auth-gate.js:7: `not_signed_in || no_profile`).
- `ui/runner-bridge.js` (203 lines): `runner.runCapture(cmd)` 26-36 invokes `run_capture` and reports to the command-log footer; `logged(cmd, run, codeOf)` helper 62-74 for commands Rust runs itself; `inspector.checkProfileStatus` 83 uses `logged('codemie profile status', () => invoke('check_profile_status'), st => st?.code ?? 0)`; `codemieConfig.read` 93-95 invokes `read_codemie_config`. This is the file where a delete bridge call would be added.

Backend (Rust):

- `src-tauri/src/lib.rs`: `invoke_handler(tauri::generate_handler![...])` at 93-131. Entries include `commands::runner::run_capture` (94), `commands::inspector::check_profile_status` (103), `commands::codemie_config::read_codemie_config` (107). `commands/mod.rs` lists modules alphabetically (app_updater, codemie_config, downloader, handshake, inspector, installer, logger, npm_env, pathman, pty, runner, smoke, window).
- `src-tauri/src/commands/runner.rs` (239 lines): `capture(cmd, path_override)` 74-81 runs through `/bin/zsh -lc <cmd>` (macOS) or `cmd.exe /c` (Windows) built by `shell_cmd_for` 33-62; no cwd parameter and no argument escaping anywhere in it. `#[tauri::command] run_capture(cmd: String)` 98-100 is a bare string runner. Test block at the bottom uses real shell (`#[tokio::test]`).
- `src-tauri/src/commands/inspector.rs` (359 lines): `check_profile_status()` 158-168 runs `capture("codemie profile status < /dev/null")` (no `< /dev/null` on Windows) and returns `ProfileStatusRun { state, detail, code }` (flattened `ProfileStatus` 72-75 plus code, 172-177). `parse_profile_status` 89-: `No active profile found` gives `no_profile`; `Authentication required to use this profile` gives `not_signed_in`; a `✗ ... expired` line or an Auth Status row with expired gives `not_signed_in`; Auth Status row present and authenticated gives `signed_in`; otherwise `unknown`. Tests from 267 on, one per row, fixtures inline.
- `src-tauri/src/commands/codemie_config.rs` (213 lines): `ConfigState { NoConfiguration, Valid, Broken }` serialized kebab-case (20-27); `CodemieConfig { state, profile, model, project, account: Option<String> }` (35-42); `parse_config(raw)` 53-101: `Broken` means the file parses but `activeProfile` names nothing inside `profiles` (93-99), with `profile` set to the dangling name and `account` kept. `read_codemie_config` command ~120. The file is always `$HOME/.codemie/codemie-cli.config.json` (config_path 106-116).
  - Consequence worth noting: a config `Broken` profile name is by definition not a key in `profiles`, whereas an expired-SSO profile is `Valid` config + `not_signed_in` auth. `codemie profile delete <name>` on a name absent from `profiles` has not been checked against the real CLI (not run: team rule against running a real codemie in tests).
- No shell-quoting helper exists in `ui/*.js` or `src-tauri/src` (greps for quote/escape found nothing). The only existing "cd /" is `ui/setup-driver.js:26`: `const SETUP_COMMAND = 'cd /; codemie setup';` with the rationale at 18-25 (from `~` the CLI reads `~/.codemie/codemie-cli.config.json` as a repository-local config; `;` not `&&` so it works in zsh and Windows PowerShell 5.1; `cd /` goes to the drive root on Windows). That command is run through the PTY, not `run_capture`.

### Architecture and Layers Affected

- View layer: `ui/home-view.js` (where the panel would mount in `#home-body`), `ui/failure-panel.js` (shared component).
- State layer: `ui/home-state.js` (pure derivation; where "broken" is currently only expressed as an item/badge).
- Orchestration: `ui/renderer.js` (wiring, `startSignIn`, re-reads, `home` state object).
- Bridge: `ui/runner-bridge.js` (new bridge call).
- Backend: `src-tauri/src/commands/` (new command, probably in `runner.rs` or `inspector.rs`; neither has a profile-mutating command), registration in `lib.rs:93-131`.
- Styles: `ui/styles.css:857-889` (`.failure-block { margin: 14px 12px 0 }`, `.failure-panel` red border `#ff6b6b`, `.failure-actions { display:flex; gap:10px; margin-top:14px }`, `.failure-actions .btn { width:auto; padding:8px 16px }`, `.failure-panel.warning` amber).

### Integration Points

All callers of `renderFailurePanel` (grep of `failure-panel|renderFailurePanel` across ui, src-tauri/src, scripts):

1. `ui/setup-view.js:16` imports it as `renderPanel`; wrapper `renderFailurePanel({id, cliMessage, raw, recoverable})` at 784-797 calls `renderPanel(container, { title, explanation, detail, raw, command: 'codemie setup', primaryLabel: 'Try again', onPrimary })`. Invoked at 727 (rejection path) and 822 (recoverable authTimeout). `FAILURE_COPY` at 764-773.
2. `ui/health-ui.js:8` import; line 64 (per-row remedy panel: variant error/warning, title 'What to do', `primaryLabel: action && action.label`, `onPrimary` branches on `action.kind` navigate / signin / recheck), line 106 (`showLogError`, no actions), line 116 (`showRunError`, primary 'Check everything again'). Health's `signin` kind calls `signIn` which is `startSignIn` (renderer.js:510).
3. Tests: `ui/test/failure-panel.test.mjs` (lines 49, 65, 80, 86-87, 96, 104), `ui/test/setup-view.test.mjs:1833` (`panelOf = block => block.querySelector('.failure-panel')`), `ui/test/health-ui.test.mjs:131, 154, 181`.

Internal dependency direction: `renderer.js` -> `home-view.js`, `home-state.js`, `runner-bridge.js`, `failure-panel.js` (not yet imported by renderer.js); `home-view.js` -> `models.js`, `home-agent-picker.js`; `health-ui.js`, `setup-view.js` -> `failure-panel.js`. `failure-panel.js` imports nothing.

External: the bundled `codemie` CLI. No Rust crate or JS package is involved in this change surface.

### Patterns and Conventions

- Rust command pattern (architecture.md "Adding New System Commands"): put it in `src-tauri/src/commands/`, `#[tauri::command]`, register in `lib.rs`, JS wrapper in `runner-bridge.js`, `#[cfg(test)]` in the same module; fallible commands return `CmdResult<T>` (`error.rs`, `InstallerError::Other(String)`); "no business logic in Rust commands".
- Bridge pattern: group by module object (`runner`, `inspector`, `codemieConfig`); commands Rust runs itself are wrapped in `logged(cmd, run, codeOf)` so the "what CodeMie ran" footer shows them (`runner-bridge.js:62-74, 83`).
- JS views take injected callbacks (`onSignIn`, `onCard`...) from renderer.js; home-view tests drive it with a hand-rolled fake DOM (`ui/test/home-view.test.mjs:6-72`) and a fake steps-ui (74-95).
- State derivation is pure and exported from `home-state.js`; renderer owns I/O.
- Branch/commit style: `EPMCDME-NNNNN : subject`, no Co-Authored-By (user memory; the harness reminder says otherwise, user rule wins). Branch name uppercase ticket ID.
- Re-read-after-action pattern: `startSignIn` (re-reads auth only) and `refreshIdentityOnComplete` (re-reads config and auth).
- Windows is a live target (setup-driver comments, `#[cfg(windows)]` branches, `windows-build.md`): command strings must be valid in zsh and PowerShell/cmd; `;` rather than `&&` was chosen for that reason in `SETUP_COMMAND`. The brief's `cd / && codemie profile delete ...` uses `&&`; `runner.rs` uses `cmd.exe /c` on Windows where `&&` works but quoting differs from zsh.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — Option B, IPC pattern, steps to add a command. Its line references to `lib.rs:27-56` are stale (handler list is now at 93-131).
- `.ai-run/guides/development/development-practices.md` — `CmdResult<T>`, no `unwrap()` in commands, file organisation for `commands/`, logging via `commands::logger::write_line`.
- `.ai-run/guides/testing/testing-patterns.md` — Rust tests run against the real shell, no mocks; JS tests are `node:test` + `node:assert/strict`; `npm test` is `node --test ui/test/*.test.mjs` (`package.json:8`). Doc lists only engine/models tests; the real suite is far larger (about 38 files in `ui/test/`).
- `.ai-run/guides/quality-gates.md` — fmt, clippy, test, build gates (not re-read in full).
- `docs/wireframes/01-home.png` — see below.
- `.ai-run/decisions/` holds ticket decisions (latest: `2026-09-23-EPMCDME-14513-add-or-update.md`); none concerns profile deletion. `home-state.js:57` cites `2026-09-22-EPMCDME-15189-builtin-agent-does-not-tick.md`.

### Architectural Decisions

- Wireframe caption: "a broken profile is shown and can be deleted in place. Note: profile deletion is carved out of the deferred Profile management in CodeMie Desktop story deliberately — it is not scope creep."
- Home design rule (wireframe text): "The user never drops back into the welcome checklist. A broken profile is a state of the Home screen, not a reason to restart onboarding."
- `home-state.js:185-187` and `ui/test/home-state.test.mjs:129-131` both record that the checklist's Sign in is a stopgap until this ticket.

### Derived Conventions

- Failure/warning UI is rendered inside the screen through `failure-panel.js`, never the modal, for new work (memory: failure panel is app-wide).
- User-facing copy is plain and short; the tool's own sentence is kept in `detail`, transcript in `raw` behind "Show details".

Wireframe `docs/wireframes/01-home.png`, "BROKEN PROFILE — SHOWN IN PLACE, DELETABLE" quarter (bottom right):
- Identity bar: `n_levyankov@epam.com · default` on the left, a red outlined pill "needs attention" on the right (no model/project segments, which matches the `broken` config where only account and profile are readable). No sidebar is visible in this quarter.
- Below it, a red-bordered panel: bold title "Your profile is no longer working"; body "CodeMie signed you out — the sign-in for **default** expired on 22 Aug. Sign in again to keep this profile, or delete it and set up a new one." Two buttons in a row: "Sign in again" (accent/primary, purple outline) and "Delete this profile" (ghost, grey outline). No "Show details" button is drawn.
- Under the panel, a grey note: "The user never drops back into the welcome checklist. A broken profile is a state of the Home screen, not a reason to restart onboarding."
- Then a dark mono block: `$ codemie doctor` / `× JWT auth — token expired 2026-08-22T09:14:02Z` (texture; brief says do not add a doctor read).
- The panel sits directly under the identity bar with no cards or checklist drawn alongside it, so the quarter does not say whether the cards stay visible beneath. Open point for spec.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/failure-panel.test.mjs` (7 tests, lines 49-105): title/explanation/detail text; collapsed transcript with `$ command` header and Show/Hide toggle; detail identical to title is dropped; second render replaces the first; primary action receives the block; warning variant has no `.failure-actions`. Fake DOM `makeEl` (9-42) supports `appendChild`, `remove`, class-based `querySelector`, `classList`, `onclick` setter; helpers `allText` and `button(block, label)` (46-47) find buttons by label within `.failure-actions`.
- `ui/test/health-ui.test.mjs` (131, 154, 181) and `ui/test/setup-view.test.mjs` (1833 `panelOf`) cover the other two callers through `.failure-panel` class lookups.
- `ui/test/home-state.test.mjs`: key existing assertions that interact with this change: line 37 "unknown auth satisfies the sign-in item and is never rendered as not signed in"; line 63 "not signed in keeps item 1 open and the profile card says so"; 105-110 "a broken profile is a warning on item 2, not an error and not first run" (asserts item 2 WARNING with subtitle 'Your profile is no longer working' and card badge 'needs attention'); 131-135 "after setup has finished once, a lapsed sign-in shows the checklist again but keeps the sidebar open" (asserts `done === false`, `unlocked === true`); 155-160 `signInAction` (broken config + not_signed_in gives `'login'`). Tests 131-135 and 105-110 describe behaviour the ticket changes or may change (lapsed sign-in after onboarding currently brings the checklist back; the ticket says broken must not).
- `ui/test/home-view.test.mjs`: fake DOM, fake steps-ui, `createHomeView` driven with `checklist` (99) and `steady` (104) fixtures; tests at 114, 125, 134, 154, 166, 185, 194, 208, 224, 244. No broken-state fixture.
- Rust: `inspector.rs` tests from 267 cover every `parse_profile_status` row; `codemie_config.rs` has `parse_config` tests for the three states; `runner.rs` has real-shell `#[tokio::test]`s.

### Testing Framework and Patterns

- JS: `node:test` + `node:assert/strict`, hand-written fake DOM (duplicated per test file, not shared), no jsdom. Callbacks injected and recorded. Memory rule: mutation-verify tests (remove the mechanism, expect exactly one test to fail); fixtures must match the real CLI output, not invented text.
- Rust: real shell, no mocks; pure helpers split out for unit tests (e.g. `shell_cmd_for`, `parse_config`, `parse_profile_status`).

### Coverage Gaps

- No test anywhere for deleting a profile, quoting a profile name for the shell, or running a CLI command from `/` via `run_capture` (setup's `cd /` is only in the PTY path; `setup-driver.test.mjs` covers that command, not capture).
- No test for Home rendering a failure panel; `home-view.test.mjs` has no broken-state fixture.
- No test of `startSignIn` or `renderHome` (renderer.js is not importable under node:test; it touches `window`/DOM at module level).
- No real-CLI fixture for `codemie profile delete` output (success line, "Active profile is now: X", error cases) exists in the repo (`grep "profile delete"` found nothing outside node_modules/target).
- No two-action case in `failure-panel.test.mjs`.

---

## 5. Configuration and Environment

### Environment Variables

- `HOME` (`USERPROFILE` on Windows) drives `config_path()` in `codemie_config.rs:106-112` and `shell_cmd` in `runner.rs`; no env var is specific to this feature.
- `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` smoke modes exist (`commands/smoke.rs`); not specific here.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` (v2: `version`, `activeProfile`, `profiles{}`, `userEmail`, `workspace`) is the CLI's file; the app only reads it (`read_codemie_config`) and the CLI mutates it on delete. A project-local `.codemie/codemie-cli.config.json` exists in this repo checkout and is currently modified in the working tree (`git status`: ` M .codemie/codemie-cli.config.json`, `activeProfile` changed to `MertPersonal`). That is the local-config effect the `cd /` rule guards against; do not stage it.
- `package.json:8` test script; `src-tauri/Cargo.toml` (not read) for Rust deps.

### Feature Flags and Deployment Concerns

- No feature flags. The app's `capabilities` grant only `core:default` (per `codemie_config.rs:5-6`), so no fs plugin; all CLI work goes through Rust commands.
- Packaging: rebuild with `cd src-tauri && CI=true cargo tauri build` before smoking. Memory notes: never run a real codemie in tests; do not touch the working tree while the codemie wrapper runs; Home smoke uses `~/codemie-demo/open-demo.command`.

---

## 6. Risk Indicators

- Speculative: `parse_config` marks `Broken` when `activeProfile` names nothing in `profiles`, so the name passed to `profile delete` may be a profile that does not exist in the file; behaviour of the CLI for a missing name is unverified in the repo and would need a real-CLI check (in a scratch HOME, not the user's).
- Speculative: broken = `config.state === 'broken' || auth not_signed_in` crosses with `deriveHome`'s `done` rule (`home-state.js:188-189`) and `renderHome` (renderer.js:203-222); existing tests at `home-state.test.mjs:105-110, 131-135, 155-160` encode the current checklist behaviour and would be touched.
- Auth `no_profile` is treated as signed-out by `signedOut` (line 188) and by `isBlockedState`; the ticket says it stays on the checklist, which the current `done` computation only gives for non-onboarded users (an onboarded user with `no_profile` also gets `done = false`).
- `unknown` is handled as signed-in-equivalent in three places (`signInItem` 38, `profileCard` 91, `deriveHome` 188); any new "broken" predicate must reuse that, or it regresses `home-state.test.mjs:37`.
- `startSignIn` only re-reads auth, not config (renderer.js:617-624); if sign-in fixes a `broken` config the panel would persist until the next focus/boot config read.
- `startSignIn` reports errors with `showNotice` (modal) at 600-613 while the panel is inline; two surfaces for one flow. Health also routes through `startSignIn` (510).
- Shell quoting: no helper exists, `run_capture` takes a raw string run through a login shell, and profile names come from user config (injection and prompt-hang risk both named in the brief). zsh and Windows `cmd.exe /c` quote differently; the existing `;`-for-`&&` decision (`setup-driver.js:18-26`) shows Windows parity has bitten before.
- `failure-panel.js` is shared with Health and setup; `failure-actions` row layout and the `primaryLabel || raw` guard (line 94) must keep behaving for them (tests in three files).
- The panel's `Show details` button is omitted in the wireframe; with `raw` empty it is naturally absent, with `raw` set it appears.
- Re-renders rebuild `#home-body` wholesale (`home-view.js:225`); any panel state (a delete in flight, a delete error) must live outside `render()` like `busy`/`failure` do at 30-33, or it vanishes on the next focus-triggered `renderHome()`.
- Delete is destructive and silent on success; spec needs an in-flight and error state (button disabled, error text) which the panel does not model.
- No real CLI transcript for `profile delete`; fixtures would have to be recorded (memory: fixtures must match real output; the "Active profile is now: X" line is quoted from the brief only).
- Architecture guide line refs are stale; testing guide undercounts tests (low risk, but do not trust its line numbers).

---

## 7. Summary for Complexity Assessment

The change touches five layers: the shared `ui/failure-panel.js` component (add a secondary action slot), pure state derivation in `ui/home-state.js` (a broken predicate over config state and auth state, interacting with `done`/`unlocked`), the Home view in `ui/home-view.js` (mount the panel in `#home-body`), orchestration in `ui/renderer.js` (wire Sign in again to `startSignIn`, add delete plus re-read of config and auth, which follows the existing `refreshIdentityOnComplete` shape), and a thin Rust command plus bridge entry (`runner-bridge.js`, `lib.rs:93-131` registration). Roughly 6 to 8 production files and 4 to 6 test files are in play, with no new dependencies, no migrations and no config files.

Technical novelty is low to moderate. The panel, the bridge pattern, the re-read pattern and the `cd /` rule all exist. What is new is a state-mutating CLI command (the first one the app issues outside setup/install), a shell-quoting need with no existing helper, a dual-platform command string, and a change to `done` semantics that existing tests pin. Real CLI behaviour for `profile delete` (including a dangling active-profile name) is unrecorded in the repo.

Test posture: the shared panel and `home-state` have good pure-function tests and an established fake-DOM pattern, so the new logic is testable at that level. `renderer.js` (where delete, re-read and `startSignIn` live) has no unit coverage and cannot be imported under node:test, so end-to-end behaviour rests on manual smoke against a built app. Key risks are the unverified delete-on-missing-name behaviour, changes to tests that encode the old lapsed-sign-in checklist, quoting across zsh and Windows, and panel state surviving whole-body re-renders.

---

## 8. External References

None named by the task as an outside-the-repo source. The in-repo wireframe `docs/wireframes/01-home.png` was read and described in Section 3. The guides named by the task (architecture, development-practices, testing-patterns) were read; they are in-repo.
