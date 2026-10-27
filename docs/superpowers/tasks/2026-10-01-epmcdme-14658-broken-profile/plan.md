# EPMCDME-14658 Broken profile on Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Home shows a broken profile as an inline failure panel: expired sign-in offers "Sign in again" and "Delete this profile"; a dangling active name offers "Set up again".

**Architecture:** Pure `broken` derivation (with a variant) in `ui/home-state.js`; `ui/failure-panel.js` gains a secondary action; `ui/home-view.js` mounts the panel and owns delete busy/failure state outside `render()`; a small Rust helper builds a quoted `cd` plus `codemie profile delete <name> --yes` command behind a bridge call; `ui/renderer.js` wires it and re-reads config and auth.

**Tech Stack:** vanilla JS (node:test), Rust/Tauri (inline tests).

**Spec:** none; acceptance criteria below (as amended by the user: empty name is "no profile", dangling name has no Delete). Analysis: `technical-analysis.md` in this directory.

Commit per task using the repository's existing convention (`EPMCDME-14658 : subject`, no Co-Authored-By). Never stage `.codemie/codemie-cli.config.json` (pre-existing dirty file); stage files by name.

## Acceptance criteria

- Expired sign-in (auth `not_signed_in`, config resolvable) shows in place via `ui/failure-panel.js` error variant: title "Your profile is no longer working", wireframe body naming the profile, actions "Sign in again" (accent) and "Delete this profile" (ghost). No modal, no `codemie doctor`, onboarding not restarted.
- Dangling active name (config `broken`, non-empty `profile`) shows the same panel with ONE action, "Set up again" (opens guided setup), body says the profile no longer exists. No Delete there.
- Config `broken` with an empty `profile` (CLI leaves `activeProfile: ""` after the last delete) is "no profile": checklist, no panel.
- auth `unknown` is never broken; `no_profile` with a valid or empty config stays on the checklist.
- `renderFailurePanel` takes an optional secondary action; Health and setup unchanged.
- Sign in again reuses `startSignIn()`/`signInAction()`, then config and auth are re-read.
- Delete runs `cd / && codemie profile delete <name> --yes` with the name always passed and quoted; registered in `lib.rs` and the JS bridge.
- After delete config and auth are re-read; another active profile is shown, checklist only when none remain; a real CLI error is shown inline, never hangs.

## Global Constraints

- Rust: `CmdResult<T>`, no `unwrap()` in commands, tests inline. JS tests `node:test` + `node:assert/strict`.
- renderer.js is not importable under node:test: keep logic in home-state/home-view/failure-panel.
- Windows runs through `cmd.exe /c` (`runner.rs:47`), so the Windows chain uses `&&`; setup-driver's `;` is for PowerShell/PTY.
- Config shape (`codemie_config.rs:66-99`): `parse_config` yields `state: 'broken'` with `profile: ''` when `activeProfile` is empty or absent, and `profile: '<name>'` when it dangles. JS reads `config.state` and `config.profile`.

## Review Focus

- Profile name with space, quote, `$`, `;`, backtick, newline, empty: must be one inert argument or rejected, never executed.
- Config `broken` + empty name (last profile deleted): checklist, no panel, no "Delete" offered.
- Dangling non-empty name: one "Set up again" button, no Delete button or handler.
- Focus-triggered `renderHome()` during an in-flight delete: busy state survives, no double delete.
- Broken profile after onboarding: panel, not checklist; sidebar stays unlocked.
- Delete succeeds and CLI switches to another profile: Home shows it; delete fails with a real CLI error: message inline, button usable again.

---

### Task 1: Secondary action in failure-panel

**Files:** Modify `ui/failure-panel.js:26-94`; Test `ui/test/failure-panel.test.mjs`

**Produces:** option `secondaryLabel`, `onSecondary(block)`, rendered as ghost button after the primary and before "Show details".

Test-first: yes — a panel with `primaryLabel` + `secondaryLabel` renders both buttons in `.failure-actions` and clicking the second calls `onSecondary` with the block; a panel with only `secondaryLabel` (no primary, no raw) still renders the row.

- [ ] Add the tests, see them fail, add the button (class `btn btn-ghost`, same shape as the "Show details" button at 80-92), widen the row guard at ~94 to `primaryLabel || secondaryLabel || raw`. Run `npm test`; Health/setup tests must stay green.

Mutation: drop `secondaryLabel` from the guard; only the secondary-only test fails.

### Task 2: Pure broken derivation in home-state

**Files:** Modify `ui/home-state.js` (near 31-49, 181-204); Test `ui/test/home-state.test.mjs` (105-110, 131-135, 155-160 only if semantics change)

**Produces:** `brokenKind({config, auth})` returning `'expired' | 'dangling' | null`; `isBroken(s)` = `brokenKind(s) !== null`; `brokenCopy({config, auth})` returning `{title, body, actions}` where `actions` is `['signin','delete']` for expired and `['setup']` for dangling; `broken` (the kind) on `deriveHome`'s result.

Rules for `brokenKind`: auth null (still checking), `unknown` and `signed_in` give null (reuse one shared helper with `signInItem` 38 / `profileCard` 91, not a third copy). Empty or whitespace `config.profile` gives null even when `config.state === 'broken'` (that is "no profile"). `not_signed_in` with a non-empty profile whose config is not broken gives `'expired'`. Config `broken` with a non-empty name and auth `no_profile` or `not_signed_in` gives `'dangling'` (nothing resolvable to sign in to or delete). `no_profile` with a valid config gives null.

`deriveHome`: `done = !broken && (complete || (onboarded && !signedOut))`; `unlocked` unchanged (`done || onboarded`). Copy: expired title "Your profile is no longer working", body "CodeMie signed you out — the sign-in for <profile> expired. Sign in again to keep this profile, or delete it and set up a new one."; dangling title the same, body "<profile> is set as your profile but it no longer exists. Set it up again to keep going."

Test-first: yes — table test over config x auth for `brokenKind`: unknown with broken config null; anthropic-subscription shape null; no_profile + valid null; broken + empty name (with `no_profile` and with `not_signed_in`) null; broken + `'ghost'` + no_profile `'dangling'`; not_signed_in + valid `'expired'`. `deriveHome` for broken + empty name has `broken: null`, `done: false` (checklist); for onboarded + not_signed_in `broken: 'expired'`, `done: false`, `unlocked: true`. Copy tests: actions and body per kind include the profile name.

- [ ] Write tests, fail, implement, run `npm test`. Re-check the three pinned tests: they should stay green; edit one only if it truly pins old behaviour, and say why in the commit body.

Mutation: drop the empty-name check; only the empty-name table case fails (and the checklist derive test, which is that same mechanism: expect those two, no others).

### Task 3: Rust delete helper, command, bridge

**Files:** Create `src-tauri/src/commands/profile.rs`; Modify `src-tauri/src/commands/mod.rs` (alphabetical), `src-tauri/src/lib.rs:93-131`, `ui/runner-bridge.js` (new `profile` group near `codemieConfig` 93-95)

**Produces:**
```rust
pub fn quote_arg(s: &str, windows: bool) -> Result<String, String>;
pub fn codemie_in_root(args: &[&str], windows: bool) -> Result<String, String>; // reusable by 14576
pub async fn delete_profile(name: String) -> CmdResult<CaptureResult>; // #[tauri::command]
```
Bridge: `profile.delete(name)` wrapped in `logged('codemie profile delete', () => invoke('delete_profile', { name }), r => r?.code ?? 0)`.

Behaviour: posix quoting wraps in single quotes with `'` as `'\''`. Windows wraps in double quotes, doubles `"`, and rejects (Err) names containing `%`, newline or NUL since cmd cannot make them inert. Empty or whitespace-only name is Err on both. Command: posix `cd / && codemie profile delete '<n>' --yes < /dev/null`; Windows `cd /d %SystemDrive%\ && codemie profile delete "<n>" --yes`. `delete_profile` runs it via `runner::capture(&cmd, None)` and maps Err to `InstallerError::Other`. Never run a real `codemie` in tests.

Test-first: yes — inline tests on the pure builders: plain name; names with space, `'`, `$HOME`, `;`, backtick, `"` on both platforms (exact strings); Windows rejects `%`; empty name rejected; one test runs the quoted posix argument through `/bin/zsh -c 'printf %s <quoted>'` to prove `$(touch x)` and `;` stay inert.

- [ ] Write tests, fail, implement, register, add bridge. Run `cargo fmt --check`, `cargo test` from `src-tauri/`.

Mutation: replace the `'\''` escape with plain `'`; the single-quote and zsh round-trip tests fail.

### Task 4: Home view mounts the broken panel and owns delete state

**Files:** Modify `ui/home-view.js` (state vars 30-33, `render` 223-237, new `renderBroken`); Test `ui/test/home-view.test.mjs` (add `expired` and `dangling` fixtures next to `checklist`/`steady`)

**Consumes:** `renderFailurePanel` (Task 1); state `{broken: 'expired'|'dangling'|null, brokenCopy: {title, body, actions}}` (Task 2).
**Produces:** `createHomeView(..., { onDeleteProfile })` where `onDeleteProfile()` returns a promise of `{ ok: true }` or `{ ok: false, message, raw }`. `render` checks `state.broken` before `state.done`; the view only ever calls `onSignIn` for 'signin' and for 'setup' (renderer decides by `signInAction`).

Behaviour: `renderBroken` calls `renderFailurePanel(container, {variant:'error', title, explanation: body, detail: deleteFailure?.message, raw: deleteFailure?.raw, ...})`. Expired: `primaryLabel: 'Sign in again', onPrimary: onSignIn, secondaryLabel: 'Delete this profile', onSecondary`. Dangling: `primaryLabel: 'Set up again', onPrimary: onSignIn`, no secondary and the delete handler is never attached. Module-level `deleting` and `deleteFailure` live next to `busy`/`failure`. Delete click: ignore if `deleting`; set `deleting`, clear failure, re-render with the secondary disabled and labelled "Deleting…"; await `onDeleteProfile`; on `ok:false` store the failure; clear `deleting` in `finally`; re-render `lastState`. Never `showNotice`.

Test-first: yes — expired fixture renders title, body, exactly two buttons, no checklist or cards; dangling fixture renders exactly one button "Set up again" and no "Delete this profile"; clicking each primary calls `onSignIn`; Delete calls `onDeleteProfile` once when clicked twice while pending, and a re-`render(state)` mid-flight still shows "Deleting…"; a failed result (`message: 'permission denied'`) shows the text in the panel and re-enables the button.

- [ ] Write tests, fail, implement, `npm test`.

Mutation: drop the `if (deleting) return` guard; only the double-click test fails. Move `deleteFailure` into `render` scope; only the failure-survives assertion fails. Always attach the secondary; only the dangling test fails.

### Task 5: Wire the renderer

**Files:** Modify `ui/renderer.js` (home wiring 174-188, `renderHome` 203-222, `startSignIn` 587-625)

Test-first: no — renderer.js cannot be imported under node:test; behaviour is covered by Tasks 2 and 4 and the orchestrator's manual smoke.

- [ ] Pass `onDeleteProfile` to `createHomeView`: it calls `bridge.profile.delete(home.config.profile)` (name is the config's `profile`; empty returns `{ok:false, message:'No profile name to delete'}`), treats `code !== 0` as failure with `message` = last non-empty stderr/stdout line (the CLI sentence), `raw` = full output, then always calls `refreshIdentityOnComplete()` (re-reads config then auth, ~401-420) so a newly active profile or the empty state is shown. try/catch turns a thrown bridge error into `{ok:false}`, never a hang. The panel's primary button keeps using `onSignIn` (`signInAction(home) === 'setup' ? openGuidedSetup() : startSignIn()`): the dangling case has auth `no_profile` or a missing-name config, which `signInAction` already routes to guided setup; confirm `signInAction` returns `'setup'` for a dangling config with `not_signed_in` auth too, else make that Task 2's pure helper change. When `startSignIn` finishes also call `refreshIdentityOnComplete()` so config is re-read. Pass `broken` and `brokenCopy(state)` through `renderHome`.

### Task 6: Gates and mutation checks

Test-first: no — verification only.

- [ ] Run `npm test`; from `src-tauri/` run `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
- [ ] Perform each mutation listed in Tasks 1-4 (remove the mechanism, confirm only the named tests fail, restore). Confirm `git status` shows `.codemie/codemie-cli.config.json` unstaged.

---
negative-constraints: no showNotice/modal (Tasks 4-5 inline panel only); no doctor read; onboarding not restarted (Task 2 `done`, Task 4 broken-before-done); `unknown` never broken and empty name is "no profile" (Task 2); no Delete for a dangling name (Tasks 2, 4); delete name always passed and quoted, empty rejected (Task 3); no npm two-copies, 14515 parsing, 14576 listing; never stage `.codemie/codemie-cli.config.json` (header, Task 6).
