# Technical Research

**Task**: profile management config switch
**Generated**: 2026-09-23T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-14576 — CodeMie Desktop: Stage 2 — Profile management (list, switch, rename, delete profiles)

Summary: Full profile lifecycle management: list all profiles, switch the active profile, rename a profile,
and delete a profile — reflected both in the app and in the terminal shared ~/.codemie/codemie-cli.config.json.

Context: The Stage 1 POC creates a single profile via Guided Setup and shows the active profile on Home. Any
further profile lifecycle work is deferred. A single broken-profile delete flow is included in Stage 1 as an
emergency recovery path (EPMCDME-14515); this ticket covers everything else.

Scope (to be refined at start of Stage 2):
- List profiles: display all profiles in ~/.codemie/codemie-cli.config.json, showing name, provider, active status.
- Switch active profile: call `codemie profile use [name]`, confirm switch, update Home to reflect new active profile.
- Rename profile: call `codemie profile rename [old] [new]` or equivalent; validate name uniqueness before calling.
- Delete profile: confirm, call `codemie profile delete [name]`, reflect result; guard against deleting the
  active profile without switching first.
- Changes must be reflected in a new terminal opened after the action, using the shared config file.

Dependencies: Requires Stage 1 complete. Requires CLI team to confirm `codemie profile rename` and
`codemie profile use` sub-command interface.

Out of scope: Creating a new profile from this screen (use Guided Setup flow).

---

## 2. Codebase Findings

### Existing Implementations

- `src-tauri/src/commands/codemie_config.rs` — the only existing reader of `~/.codemie/codemie-cli.config.json`. `#[tauri::command] pub fn read_codemie_config() -> CodemieConfig` (sync, never fails) parses the file into `{ state, profile, model, project, account }` where `state` is `no-configuration | valid | broken` (kebab-case on the wire). `parse_config(raw: &str)` is a pure, fully unit-tested helper (7 tests) split out specifically so every state is testable without touching the filesystem. It currently reads only the **active** profile's `model`/`codeMieProject` (with a CLI-0.15 workspace-project-wins-over-profile override) — it does not enumerate `profiles` as a list, and it does not read `provider`, `codeMieUrl`, `apiKey`, `baseUrl`, or `name` from any profile.
- `~/.codemie/codemie-cli.config.json` real shape, taken from the repository's own checked-in sample at `.codemie/codemie-cli.config.json`:
  ```json
  {
    "version": 2,
    "activeProfile": "epm-cdme",
    "profiles": {
      "epm-cdme": {
        "codeMieProject": "epm-cdme", "provider": "ai-run-sso",
        "codeMieUrl": "https://codemie.lab.epam.com", "apiKey": "sso-provided",
        "baseUrl": "...", "model": "claude-sonnet-4-6",
        "haikuModel": "...", "sonnetModel": "...", "opusModel": "...", "name": "epm-cdme"
      }
    },
    "codemieAssistants": [ ... ]
  }
  ```
  `profiles` is a JSON object keyed by profile name, each value carrying its own `provider` and `name` fields — the raw material for a profile list.
- `ui/renderer.js:232-244` — `renderIdentity(cfg)`. Pure DOM-write function; sets five `#identity-*` spans from the config object. `cfg.state === 'valid' || cfg.state === 'broken'` toggles the `#identity-product` fallback text.
- `ui/renderer.js:251-266` — `refreshIdentityOnComplete()`. The established "re-read both sources, then re-render" pattern: re-reads `bridge.codemieConfig.read()` and `bridge.inspector.checkProfileStatus()`, then calls `renderIdentity` and `updateIdentityAuthStatus`. Invoked fire-and-forget from `emit()`'s `case 'complete':` (`renderer.js:145-152`) after a setup run finishes, and from a `window` `focus` listener (`renderer.js:660-665`) so a profile switched in an external terminal is picked up when the app regains focus (throttled to once per 5s, skipped while `installRunning`).
- `ui/renderer.js:394-...` — `startSignIn()`. Runs `codemie profile login` via `bridge.runner.runStream`, does **not** trust the exit code (profile login exits 0 on failure), scans stdout with a pure parser (`findLoginError` in `ui/signin-parse.js`) for `✗ …` / `Error: …` lines, surfaces the first hit via `showNotice`, then always re-reads `checkProfileStatus` and calls `updateIdentityAuthStatus`. This is the closest existing precedent for "run a `codemie profile <verb>`, don't trust exit code, scan output for the CLI's own error line, re-render."
- `src-tauri/src/commands/inspector.rs:98-193` — `ProfileStatus { state: String, detail: String }` and `check_profile_status()`, which runs `codemie profile status` (stdin closed with `< /dev/null` on macOS to prevent an interactive re-auth prompt from hanging the capture; omitted on Windows) via `runner::capture`, then parses stdout/stderr with a pure `parse_profile_status` helper into one of `signed_in | not_signed_in | unknown | no_profile`.
- `src-tauri/src/commands/runner.rs` — `capture(cmd, path_override)` (used by `check_profile_status`) and the `run_capture` / `run_stream` `#[tauri::command]`s it backs, callable from JS as `bridge.runner.runCapture(cmd)` / `bridge.runner.runStream(cmd, onLine)`. `run_stream` streams via `engine:cmd-line` events keyed by a caller-supplied id and resolves `{ code }`.
- `ui/runner-bridge.js` — the full IPC surface. `inspector.checkProfileStatus`, `codemieConfig.read`, `runner.runCapture` / `runStream` already exist; there is **no** `profiles.list` / `use` / `rename` / `delete` export anywhere in this file today.
- `ui/handlers.js:80-82` — the only existing call site that shells to a `codemie` sub-command as part of the install flow: `runExternalWindow(ctx, '2.3.3', 'codemie setup')` (Windows) / `runPty(ctx, 'codemie setup', …)` (macOS/PTY). Shows the PTY-vs-external-window split for interactive CLI commands.

### Architecture and Layers Affected

- **Rust command layer** (`src-tauri/src/commands/`) — `codemie_config.rs` (file read/parse) and `inspector.rs` (shell-out + parse) are the two established patterns for getting profile data into the app; a `codemie profile use/rename/delete` action would follow the `inspector.rs` shell-out-and-parse-output shape, not the config-file-read shape (the CLI, not the app, owns the write to the config file).
- **Bridge layer** (`ui/runner-bridge.js`) — new `invoke()` wrappers would be added here, in the existing per-domain export-object style (`inspector`, `codemieConfig`, `runner`).
- **Renderer layer** (`ui/renderer.js`) — currently has no profile-list UI at all; only the single-profile identity bar (`renderIdentity`) and the auth-status segment (`updateIdentityAuthStatus`).
- **View/shell layer** (`ui/index.html`, `ui/renderer.js:68-76` `views` object) — the sidebar (`#app-sidebar`) is present in markup but has `class="hidden"` with an inline comment: *"Hidden for v1, not deleted. Agents, Connections and Health are Stage 2 screens, so shipping the nav now would advertise three entries that lead nowhere."* There is no `profiles` entry in `views` or `data-view` sidebar button at all — a profile-management screen has no existing routed view to extend.
- **Command registration** (`src-tauri/src/lib.rs:92-132`) — `invoke_handler![...]` is the single list every new command must be added to; `commands::codemie_config::read_codemie_config` and `commands::inspector::check_profile_status` are the two closest existing entries.

### Integration Points

- Chain for the existing single-profile display: `renderIdentity(cfg)` ← `bridge.codemieConfig.read()` ← `invoke('read_codemie_config')` ← Rust `read_codemie_config()` ← `~/.codemie/codemie-cli.config.json`.
- Chain for auth/action verbs: `bridge.inspector.checkProfileStatus()` / a future `profiles.*` export ← `invoke(...)` ← Rust command ← `runner::capture`/`run_stream` ← `codemie profile <verb>` subprocess (zsh -lc on macOS, cmd.exe /c on Windows) ← the same config file, but written by the CLI, not by this app.
- External sync requirement ("reflected... in a new terminal"): already solved one direction (terminal → app) by the `window` `focus` listener at `renderer.js:660-665` calling `refreshIdentityOnComplete()`. The other direction (app → terminal) needs no special handling — a new terminal always re-reads the file fresh; nothing in this app's process holds a lock or cache the CLI would need to see through.

### Patterns and Conventions

- **Pure parser + thin command wrapper**: every existing CLI-output consumer (`parse_config`, `parse_profile_status`, `findLoginError`) is a pure function taking strings, independently unit-tested, called by a thin `#[tauri::command]` or async JS function that does only the I/O. Any new `codemie profile list/use/rename/delete` output parser should follow this split.
- **Never trust exit code for `codemie profile *`**: documented explicitly at `renderer.js:399-400` for `profile login` ("Exit code is ignored — profile login exits 0 on failure; scan stdout instead"). The same caution is worth carrying into `use`/`rename`/`delete` until each CLI sub-command's actual failure signaling is confirmed.
- **Re-read-then-render after every state-changing action**: `refreshIdentityOnComplete()` / `updateIdentityAuthStatus()` — never optimistically update the UI from the action's own response; always re-invoke the read command afterward.
- **`< /dev/null` stdin guard on macOS**: used in `check_profile_status` specifically because an unauthenticated `codemie profile status` can prompt interactively; any new profile sub-command invocation should be checked for the same hazard.
- **One Rust file per system concern**, registered in `lib.rs`, with a JS wrapper added to the matching `runner-bridge.js` export object, and inline tests in the same Rust file (`.ai-run/guides/architecture/architecture.md` "Adding New System Commands" checklist; also `development-practices.md` "File Organization").

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — Option B (frontend-brain + thin Rust backend), full IPC pattern, and the exact "Adding New System Commands" checklist (create/extend a `commands/` file → `#[tauri::command]` → `CmdResult<T>` → register in `lib.rs` → JS wrapper in `runner-bridge.js` → inline test).
- `.ai-run/guides/testing/testing-patterns.md` — Rust: `#[cfg(test)]` inline, `#[tokio::test]` for async, tests run against the real shell (no mocks) for `capture()`-based tests. JS: `node:test` + `node:assert/strict`, no framework, stub `emit`/`handlers` for orchestration tests, do not test `invoke()` directly.
- `.ai-run/guides/development/development-practices.md` — naming conventions (Rust `snake_case`/`PascalCase`, JS `kebab-case` files / `camelCase` functions), `InstallerError` variants and when to use each, logging via `commands::logger::write_line`.
- `.ai-run/guides/quality-gates.md` — `cargo fmt --check`, `cargo clippy -- -D warnings`, `npm test`, `cargo test`, then the staged build via `build-installer.sh`/`.ps1`.
- No guide file specifically covers profile *lifecycle* management (list/use/rename/delete) — this domain is new relative to the existing guides, which only cover the single-active-profile read and the sign-in/status flow.

### Architectural Decisions

- `src-tauri/src/commands/codemie_config.rs:1-12` (module doc comment) — explains **why** the config file, not `codemie profile status` or a shelled `cat`, is the identity bar's data source: the CLI never prints the account email, no file-read API is reachable from the frontend (no bridge export, no `tauri-plugin-fs`, capabilities grant only `core:default`), and a typed `ConfigState` enum gives one tested contract instead of "untyped conventions each consumer re-derives" — explicitly citing EPMCDME-14515 and EPMCDME-14589 as consumers of that absent-vs-unread distinction. The same reasoning is directly relevant to this ticket: a `list profiles` feature should likely extend this same reader/parser rather than add a second one.
- `ui/index.html:51-58` inline comment — the sidebar is deliberately hidden for v1 because "Agents, Connections and Health are Stage 2 screens" with no working destination yet; profile management has no sidebar entry defined at all (`views` object at `renderer.js:68-76` lists only `home, setup, agents, connect, health, about, wizard`).
- `docs/superpowers/tasks/2026-09-07-epmcdme-14515-signin-auth-state/plan.md:18` — global constraint explicitly lists five tickets this work must **not** build, including `profile management (14576)` (this ticket) and a "broken-profile panel (14658)". **EPMCDME-14515, as actually implemented in this codebase, is scoped to sign-in/auth state only** (`ProfileStatus{state,detail}`, `checkProfileStatus`, `startSignIn`) — it does not contain a delete action. No `EPMCDME-14658` task directory or broken-profile-delete code exists anywhere in the repository (verified by full-repo search for "14658", "broken-profile", "emergency", "recovery"). This is a discrepancy the task_context should be aware of — see Risk Indicators.
- `docs/superpowers/tasks/2026-09-07-epmcdme-14515-signin-auth-state/code-review-deferred.md` — documents known gaps in `startSignIn` (catch-maps-to-blocked on transient IPC error, no timeout/cancellation, no concurrent-invocation guard) explicitly deferred to "EPMCDME-14589, which owns the sign-in button surface." Worth checking whether 14589 (home screen) landed and whether it added any profile-adjacent UI surface before starting design.

### Derived Conventions

- New Tauri commands consistently return either a plain struct (infallible, e.g. `CodemieConfig`, `ProfileStatus`) or `CmdResult<T>` (fallible) — never a raw `String`/`bool`.
- `kebab-case` serde renaming is used for enum-like `state` fields crossing the IPC boundary (`ConfigState` → `"no-configuration"`; `ProfileStatus.state` is a plain lowercase-with-underscore String, e.g. `"not_signed_in"` — the two existing state enums do not share one casing convention, worth deciding explicitly for any new profile-list state).

---

## 4. Testing Landscape

### Existing Coverage

- `src-tauri/src/commands/codemie_config.rs:128-213` — 9 inline tests covering every `parse_config` branch: unreadable file, resolving active profile, absent account, CLI-0.15 workspace-project-wins, unresolvable active profile ("broken"), state serialization, and both Unix/Windows `config_path_with` forms.
- `src-tauri/src/commands/inspector.rs:283+` — 7+ inline tests for `parse_profile_status` covering all four `state` outcomes plus edge cases (no Auth Status row, "expires in" vs "expired", stderr-merged-when-stdout-empty).
- `ui/test/signin.test.mjs` — `node:test` coverage for `findLoginError` (pure parser), following the same "pure module, `node:test`, no framework" pattern.
- `ui/test/auth-gate.test.mjs` — covers `shouldBlockForAuth(state)` in `ui/auth-gate.js` (currently `state === 'not_signed_in' || state === 'no_profile'`).

### Testing Framework and Patterns

- Rust: `#[cfg(test)]` inline modules, `#[tokio::test]` for async command tests, tests exercise real shell output (no mocking layer exists for `capture()`).
- JS: `node --test ui/test/*.test.mjs`, `node:assert/strict`, no fixtures/mocking framework — pure-function modules (`*-parse.js`) are extracted specifically so they're testable without a browser or Tauri runtime.
- A parallel Playwright suite exists under `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests` (`npm run test:ui`), used at least once for identity-bar verification (`ui\test\fixtures` / `evidence/verification/identity-bar.json` in that ticket's task dir) — a precedent for browser-level verification of identity/config-bar rendering, if this ticket needs the same.

### Coverage Gaps

- No parser exists yet for `codemie profile list` output (nor confirmation this sub-command exists — see Risk Indicators), so there is no fixture-based test to extend.
- No parser or tests exist for `codemie profile use`, `rename`, or `delete` output/exit behavior.
- No existing Rust command enumerates `profiles` as a list from the config file — `codemie_config.rs`'s `parse_config` only ever resolves the single `activeProfile` entry, so a "list all profiles with name/provider/active-status" reader has zero test coverage to build on (greenfield within this file).
- No sidebar/view exists for a profile-management screen, so there is no existing DOM/renderer test surface to extend either (the `views` object and `showView()` routing would be new territory for whatever screen this lands on).

---

## 5. Configuration and Environment

### Environment Variables

- `HOME` (macOS) / `USERPROFILE` (Windows fallback) — resolved in `codemie_config.rs:106-112` (`config_path()`) to locate `~/.codemie/codemie-cli.config.json`. A known gap flagged by a prior ticket's lens-verification (`docs/superpowers/tasks/2026-09-02-EPMCDME-14505-bundle-shim-runtime-path/lens-verification-gap.json:24`): on Windows without `HOME` set, the reader silently falls back and can show `no-configuration` even when a valid config exists.
- `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` — smoke-mode toggles checked at startup (`lib.rs`, `commands/smoke.rs`); unrelated to profile data but part of the same startup path.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — the single shared source of truth this ticket must read and expect the CLI to mutate; documented shape confirmed via the repository's own checked-in sample at `.codemie/codemie-cli.config.json` (see Section 2).
- `config/steps.yaml` — embedded install-step config, unrelated to profile management, included here only because it's the other config file `src-tauri` reads (via `include_str!`, not at runtime) — for contrast: profile data is read live from disk, not embedded.

### Feature Flags and Deployment Concerns

- No feature flags gate the identity bar or profile-status code paths today.
- The sidebar-hidden state (`ui/index.html:51-58`) functions as an informal feature gate for Stage-2 screens; un-hiding it (or adding a new routed view without it) is a decision this ticket's design phase will need to make.

---

## 6. Risk Indicators

- **Speculative: ticket text vs. actual code disagree on which ticket owns the broken-profile delete flow.** The task_context states "a single broken-profile delete flow is included in Stage 1... (EPMCDME-14515)." The EPMCDME-14515 plan.md found in this repo (`docs/superpowers/tasks/2026-09-07-epmcdme-14515-signin-auth-state/plan.md`) instead lists a "broken-profile panel" as ticket **14658**, and explicitly forbids 14515 from building it. No EPMCDME-14658 task directory, no delete-flow code, and no reference to "broken-profile panel" content exist anywhere else in the repo. Either that flow has not shipped yet (in which case "reuse patterns from it" in the parent instructions has nothing to reuse) or it shipped under a different ticket number this research did not surface. This should be confirmed with the requester/CLI team before planning assumes an existing delete-flow implementation to extend.
- **Speculative: `codemie profile use`/`rename`/`delete` sub-command existence and output shape are unconfirmed.** Grepping the full repository (source, tests, docs) finds only `codemie profile status` and `codemie profile login` actually invoked or parsed anywhere. The task_context itself flags this as an open dependency ("Requires CLI team to confirm `codemie profile rename` and `codemie profile use` sub-command interface"). No parser, fixture, or test exists for `list`/`use`/`rename`/`delete` — every part of that surface is new work with no precedent output format to design a `parse_*` helper against.
- **No existing UI surface (view, sidebar entry, or component) for listing/managing multiple profiles.** The sidebar is fully hidden for v1 and its `views` routing object has no `profiles` entry. Whatever screen this lands on is new design, not an extension of a hidden-but-built screen.
- **Config reader (`codemie_config.rs::parse_config`) currently resolves only the single active profile**, not the full `profiles` map — enumerating all profiles (name/provider/active-status) for a list view touches code with 9 passing tests built around the single-profile contract; extending it needs care not to regress `ConfigState`/absent-account semantics that EPMCDME-14515/14589 depend on per the file's own doc comment.
- **Exit-code trust is an established hazard for `codemie profile *` commands** (`profile login` exits 0 on failure per `renderer.js:399-400`) — `use`/`rename`/`delete` should not be assumed to signal failure via exit code either, until verified against the real CLI.
- **Windows `HOME`-unset gap** (noted above) is a pre-existing, unresolved risk in the exact code path (`config_path()`) any profile-list reader would extend.
- Two different casing/shape conventions already exist for CLI-derived state strings (`ConfigState` kebab-case enum vs. `ProfileStatus.state` snake_case-ish plain string) — a third profile-list-specific state shape risks a third inconsistent convention if not decided deliberately.

---

## 7. Summary for Complexity Assessment

This task touches three of the four architectural layers already established in this codebase: the Rust command layer (a new reader to enumerate `profiles` from the config file, alongside `codemie_config.rs`, plus new shell-out commands for `use`/`rename`/`delete` alongside the `inspector.rs` pattern), the IPC bridge layer (`runner-bridge.js` new export entries), and the renderer/view layer (a wholly new profile-list UI surface — there is no existing sidebar entry, routed view, or DOM scaffold to extend; the sidebar is currently hidden entirely for v1). The single-profile identity bar and its "re-read then re-render" pattern (`refreshIdentityOnComplete`, `updateIdentityAuthStatus`) are directly reusable precedent for the "reflect the result" requirement, and the focus-listener re-read already solves the terminal-to-app sync direction — but app-to-list, list-to-detail, and the multi-profile data model are all new.

Technical novelty is high on the CLI-integration side: three of the four required sub-commands (`profile use`, `profile rename`, `profile delete` — only `profile status`/`profile login` are wired today) have no confirmed interface, output format, or exit-code semantics in this codebase, and the task_context itself names this as an open, CLI-team-owned dependency. The one existing precedent for a state-changing `codemie profile` invocation (`profile login` in `startSignIn`) establishes that exit codes cannot be trusted and output must be scanned — a caution to carry forward, not a solved problem, since the new commands' output shapes are unknown.

Test coverage posture is strong for the code this ticket would extend (9 tests on `parse_config`, 7+ on `parse_profile_status`) but there is zero existing coverage for anything this ticket adds — no fixtures for `list`/`use`/`rename`/`delete` output exist to build tests against until the CLI interface is confirmed. Combined with the unresolved discrepancy over which ticket (14515 vs. an unfound 14658) actually owns the "reuse patterns from" emergency delete flow the task_context points at, and the complete absence of a profile-management UI shell, this should be treated as a multi-layer, CLI-interface-blocked feature rather than an extension of existing screens.

---

## 8. External References

None named by the task. `task_context` refers to Jira ticket numbers (EPMCDME-14515) and to "the CLI team" as sources, not to filesystem paths or URLs — those are tracked as open dependencies/risks in Section 6, not resolved as external references. No `~/…`, sibling-checkout, or explicit doc path was named to source content from.
