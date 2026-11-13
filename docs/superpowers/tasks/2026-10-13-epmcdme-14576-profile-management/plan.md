# Profile management (EPMCDME-14576) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** List, switch, rename, delete and add CodeMie CLI profiles from the Home Profile card.

**Architecture:** Rust reads the config file for the list (allow-listed fields) and runs `codemie profile switch|rename|delete` from `/`. A pure controller module runs one action at a time, then re-reads the list and re-renders; a pure view module draws it. `renderer.js` only wires.

**Spec:** inline requirements; research in `technical-analysis.md` (same dir).

Commit per task using the repository's existing convention: `EPMCDME-14576 : Subject`, short body, no Co-Authored-By. Never stage `.codemie/codemie-cli.config.json`, `.ai-run/guides/project.md`, `AGENTS.md`. Tests never run a real `codemie`.

## Acceptance criteria

- Several profiles: each row shows name, provider, model; exactly one is marked active.
- Switch changes the active profile; Home and identity bar update without restart.
- Rename to an existing name: CLI message shown inline, nothing changes.
- Delete asks first, says so for the active profile, then shows which profile is active now.
- Deleting the last profile returns Home to the setup checklist.
- "Add a profile" opens guided setup (same `onSetupAgain`).
- Each action appears in "what CodeMie ran" with its real command and output.
- `apiKey` never crosses IPC; CLI-made profiles list as is.

negative-constraints: apiKey over IPC (Task 2 allow-list); `CodemieConfig` unchanged (Task 2); UI never updated from action reply (Task 4); one delete call only (Task 4); no extra last-profile path, broken panel untouched (Task 5); no real codemie (all tests); local-edit files untouched (header).

## Decisions verified

Profile identity is the `profiles` map key: the CLI indexes `profiles[name]` (codemie-code `src/utils/config.ts` switch/rename/delete) and derives `name` from the key. Pass the key to the CLI; ignore the `name` field.

## Task 1: Rust switch_profile and rename_profile

**Files:** Modify `src-tauri/src/commands/profile.rs` (beside `delete_command`/`delete_profile`), `src-tauri/src/lib.rs:115`.

**Produces:** `switch_profile(name)`, `rename_profile(old, new)`, both `CmdResult<CaptureResult>`.

Test-first: yes — `builds_the_switch_and_rename_commands_per_platform` asserts exact strings (POSIX and Windows) like the delete test, and rename quotes both names (hostile `new` name stays one argument).

- [ ] Add the failing test, run `cargo test profile` from `src-tauri/`, see it fail.
- [ ] Add private `switch_command` / `rename_command` builders using `quote_arg` + `codemie_in_root`, the two commands in delete's shape, and register both in `invoke_handler`.
- [ ] Run test, pass. Mutation check: make `rename_command` drop the quote on `new`, confirm exactly one test fails, restore.

## Task 2: Rust profile list reader

**Files:** Modify `src-tauri/src/commands/codemie_config.rs` (after `parse_config`), `src-tauri/src/lib.rs`.

**Produces:** `ProfileSummary { name, provider, model, active: bool }` (Serialize, only these four fields), `parse_profiles(raw: &str) -> Vec<ProfileSummary>`, `#[tauri::command] list_codemie_profiles()` reading `config_path()`; missing/unparseable file gives empty vec.

Test-first: yes — `parse_profiles` on a config with two profiles (one containing `apiKey`) returns both with the right active flag; serialized JSON contains no `apiKey` or secret value; `activeProfile` naming nothing gives zero active; empty `activeProfile` gives zero active; garbage text gives empty.

- [ ] Write failing tests, run, see fail.
- [ ] Implement using the map key as `name` and `str_field` for provider/model; register command.
- [ ] Pass. Mutation check: add `api_key` to the struct, confirm only the no-secret test fails; restore.

## Task 3: Bridge wrappers with real command and output in the log

**Files:** Modify `ui/runner-bridge.js:82-92` (`logged`), `:119-129` (`codemieConfig`, `profile`). Test: `ui/test/profile-bridge.test.mjs` (stub `window.__TAURI__` as in `ui/test/connectors-bridge.test.mjs`).

**Produces:** `codemieConfig.listProfiles()` → `invoke('list_codemie_profiles')`; `profile.switch(name)`, `profile.rename(oldName, newName)`, `profile.delete(name)`, all via `logged`.

Smallest honest change: give `logged` an optional fourth argument `outputOf(res)`; when it returns text, `cmdlog.append` it before close. For the three profile calls pass a label with the real name(s), e.g. `codemie profile delete <name> --yes`, and `outputOf = r => stdout + stderr`.

Test-first: yes — with a fake invoke returning `{code:1, stdout:'', stderr:'name exists'}`, the recorded `cmdlog_open` command contains the names, `cmdlog_append` receives `name exists`, `cmdlog_close` gets code 1; delete's label now includes the name.

- [ ] Failing test, run `npm test`, see fail.
- [ ] Implement. Pass.
- [ ] Mutation check: remove the append call, confirm exactly one test fails; restore.

## Task 4: Profile list controller and view (pure modules)

**Files:** Create `ui/profile-list-controller.js`, `ui/profile-list-view.js`; tests `ui/test/profile-list-controller.test.mjs`, `ui/test/profile-list-view.test.mjs` (DOM stub patterns from `ui/test/home-view.test.mjs`).

**Interfaces:**
- `createProfileListController({ bridge, onChanged, onAdd })` where bridge is `{ codemieConfig.listProfiles, profile.{switch,rename,delete} }`; exposes `load()`, `switchTo(name)`, `rename(old, new)`, `remove(name)`, `subscribe(fn)`; state `{ profiles, busy, failure, notice }`.
- `renderProfileList(container, state, handlers)`; row layout follows Tools rows (`ui/agents-ui.js`): name, `provider · model`, Active badge, Switch (hidden on active), Rename, Delete. Rename swaps the name for an input with Save/Cancel. Delete shows an inline confirm line (stronger wording for the active profile) with Confirm/Cancel. Failures via `renderFailurePanel` (`ui/failure-panel.js`) with the CLI's last non-empty line. Footer "Add a profile" calls `onAdd`.

Behavior: a second action while `busy` is ignored. After every action (success or failure) the controller calls `listProfiles()`, replaces state from that, then `onChanged()` (renderer's `refreshIdentityOnComplete`); success is judged by `code === 0` only to decide whether to show a failure. After a delete, `notice` is "Active profile now: <name>" taken from the re-read list (none left: no notice).

Test-first: yes — failing tests: (controller) switch calls bridge once then re-reads, state comes from the re-read not the reply; rename failure with code 1 keeps list unchanged and sets failure message; remove calls `bridge.profile.delete` exactly once; concurrent second call ignored; notice names the new active profile. (view) one Active badge, no Switch on the active row, delete asks confirmation first and names the active case, Add button calls `onAdd`.

- [ ] Write failing tests, run, see fail.
- [ ] Implement both modules. Pass.
- [ ] Mutation check: make `remove` call `bridge.profile.delete` twice, then separately remove the confirm step; each time exactly one test fails; restore.

## Task 5: Wire into Home

**Files:** Modify `ui/home-view.js:201-221` (Profile card, beside "Set up again"), `ui/renderer.js:178-188`, `ui/styles.css` (near `.home-card-action`, `.agent-actions`). Test: extend `ui/test/home-view.test.mjs`.

**Interfaces:** `createHomeView` gains `renderProfileList(slot)`; the Profile card gets one "Manage profiles" button (single place, easy to move to the sidebar) toggling a view-local `profilesOpen` flag kept outside `render()`; when open, the card gets a slot passed to `renderProfileList`. `renderer.js` builds the controller with `onChanged: refreshIdentityOnComplete`, `onAdd: () => openGuidedSetup()`, and loads the list when the panel opens. No change to `brokenKind`, `renderBroken` or `deleteActiveProfile`.

Test-first: yes — clicking "Manage profiles" calls `renderProfileList` with a slot inside the Profile card, a second click closes it, and it survives a re-render.

- [ ] Failing test, run, see fail.
- [ ] Implement; add minimal CSS reusing Home card and Tools row styles.
- [ ] Pass. Mutation check: drop the `profilesOpen` flag persistence, confirm exactly one test fails; restore.
