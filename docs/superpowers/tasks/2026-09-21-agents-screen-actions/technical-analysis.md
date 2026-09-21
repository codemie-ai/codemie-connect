# Technical Research

**Task**: agents screen update-check install remove runner steps-ui
**Generated**: 2026-09-21
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14514 — Agents screen: update check + three actions.

The Agents screen already renders its list (ui/agents-ui.js draws rows, ui/agents-controller.js runs `codemie list` and renders — both done, tested, leave alone). ui/agents-parse.js belongs to Home, leave it.

Scope of remaining work:
1. New parser module for `codemie update --check` output, with a fixture captured from the real command. Format differs from `list`: heading "📦 Agent Update Status:", lists installed agents only, "Current:" and "Latest:" lines (Latest followed by two spaces), and a trailing summary line to stop at — same stopping approach as the list parser stopping at the frameworks heading.
2. Update-available state: join list-parser and update-check-parser results by agent name, mark WARNING on the row when an update is available, and the screen header count gains "· N update available" (matches docs/wireframes/03-agents.png).
3. Wire Install/Update/Remove through runner.runStream, always with the agent name in the command (never bare): `codemie install <agent> --supported`, `codemie update <agent>`, `codemie uninstall <agent>`. Never pass an explicit version.
4. Progress/output inline in the row using the screen's existing steps-ui instance: startSpinner while running, setSubtitle for the current output line. No modals.
5. Failure handling: failed install shows the CLI's own error text, agent stays listed as not installed; no-network case shows "installing needs a connection" in the row.
6. After every action, re-run `codemie list` and re-render from the fresh result — do not mutate local row state.

Every row already has `.agent-actions`; buildActions() in agents-ui.js already draws Update/Remove for installed agents and Install for non-installed, but only when the matching handler is passed in; the controller forwards an `actions` option straight through. That's where the wiring goes.

`codemie uninstall <agent>` needs no PTY/prompts — Remove goes through runner.runStream (see decision doc .ai-run/decisions/2026-09-21-EPMCDME-14514-remove-transport.md).
A row's version comes only from `codemie list`. `update --check`'s "Current:" value for the built-in agent is the CLI package version by design — read update --check only for the update-available flag, never for a displayed Current value (see .ai-run/decisions/2026-09-21-EPMCDME-14514-agent-version-authority.md).
Spinner output for these commands goes to stderr like doctor's — read both stdout/stderr tags when rendering row output.
Installing agents needs npm (not bundled); npm is on PATH on this dev machine so actions work here — do not build or design around the clean-machine npm fix (see .ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md).

Out of scope: list-and-detail layout (EPMCDME-14655) — everything stays within the row.

---

## 2. Codebase Findings

### Existing Implementations

- `ui/agents-ui.js` — presentational render module for `#agents-view`. `renderAgents(container, { agents }, handlers)` draws the head (`agents-title` + `agents-summary`, currently `"N of M installed"`), a note, and delegates rows to the screen's `stepsUi` instance. `buildActions(agent, { onInstall, onUpdate, onRemove })` already draws Update/Remove for `agent.installed` and Install otherwise, but only appends a button when its handler function is truthy — no code change needed there to *start* wiring, only to add a handler. `subtitleOf()` renders `description · version` from the list record only, per the version-authority decision. `statusOf()` currently derives only COMPLETE/PENDING from `agent.installed`; the comment on line 24 already anticipates ERROR/WARNING being "set on the live row by the actions, not derived here."
- `ui/agents-controller.js` — `createAgentsController({ container, runCapture, stepsUi, onFailure, onResult, actions = {} })`. Runs `codemie list` via `runCapture`, parses with `parseAgentList`, renders via `renderAgents(container, { agents }, { stepsUi, ...actions })`. Already forwards an `actions` object straight into the render call, guards re-entrant `run()` calls with a `running` flag, and exposes `getLastAgents()`. This is the entry point where update-check results and action handlers must be threaded through, per the ticket's own pointer.
- `ui/agents-parse.js` — `parseAgentList(stdout)`, pure parser for `codemie list`. Explicitly commented as shared with Home (EPMCDME-14589) — out of scope for this ticket, must not change. Its heading/stop-heading pattern (`AGENTS_HEADING` / `OTHER_HEADING`, break on frameworks heading) is the template a new `update --check` parser should mirror.
- `ui/renderer.js` (around line 470-485) — constructs `agentsController` with `container: views.agents`, `runCapture: bridge.runner.runCapture`, its own `stepsUi: stepsUI.createStepsUi()` instance, and `onResult`/`onFailure` callbacks that keep `home.agents` (used by the Home screen/checklist) in sync. No `actions` object is passed yet — this is where install/update/remove handlers and a `runStream` reference would need to be wired in.
- `ui/health-controller.js` — sibling controller for the Health screen, the closest existing precedent for streaming a command with `runStream` and reading both `tag === 'stdout'`/`'stderr'` lines, and for the `running` guard / `lastResult` caching pattern already mirrored in `agents-controller.js`.
- `ui/doctor-parse.js` — precedent for a stop-at-blank-line / stop-at-summary-line parser feeding off streamed doctor output; less directly reusable than `agents-parse.js`'s heading-based structure but shows the "trailing summary line is intentionally dropped" convention this ticket also calls for.
- `ui/runner-bridge.js` — `runner.runCapture(cmd)` and `runner.runStream(cmd, onLine)` are the only two transports available. `runStream` invokes `onLine(text, tag)` per line with `tag` being `'stdout'` or `'stderr'` (plus a synthetic `'prompt'` line for `> <cmd>`), and resolves `{ code }` on completion. No PTY needed for any of the three actions per the decision docs.
- `ui/steps-ui.js` — `createStepsUi()` factory returns `{ renderSteps, setStatus, setSubtitle, startSpinner, stopSpinner, setProgress, insertSubStep, showApproval, stampApproval }`. `startSpinner(id)` only animates the row icon (does not itself set status); `stopSpinner` is called automatically by `applyStatus` whenever `setStatus` moves the row off `ACTIVE`. `setSubtitle(id, text)` is a no-op when `text` is falsy — a later `setSubtitle` call with a real line will not clear itself back to blank on its own.
- `ui/models.js` — `StepStatus` enum includes `WARNING` and `ERROR`, both already used elsewhere (Health) for exactly the "state that carries acceptance criteria" semantics the wireframe shows (amber update-available ring, red install-failed ring).
- Shipped CLI source read directly from the installed app bundle (`/Applications/CodeMie Connect.app/Contents/Resources/cli/node_modules/@codemieai/code/dist/cli/commands/update.js`) — authoritative for the `update --check` text format (see Section 8).

### Architecture and Layers Affected

- **Parsing layer**: a new pure parser module alongside `ui/agents-parse.js` (e.g. `ui/agents-update-parse.js`), following its no-DOM/no-Tauri convention so it is directly `node:test`-importable.
- **Controller layer**: `ui/agents-controller.js` — orchestrates the second read (`codemie update --check`) and the join with the list read; owns the three action handlers using `runStream`; owns re-running `codemie list` after any action.
- **Presentation layer**: `ui/agents-ui.js` — `buildActions`/`renderAgents` already accept the handler shapes needed; `statusOf`/`subtitleOf` need to account for a WARNING (update-available) state and for an action in flight, and the head's summary string needs the "· N update available" suffix.
- **Bridge layer**: `ui/runner-bridge.js`'s existing `runner.runStream` is the transport for all three actions; no Rust/`src-tauri` change is implied by anything in scope.
- **Wiring layer**: `ui/renderer.js` — where `runStream` and the three action handlers get passed into `createAgentsController`, mirroring how `runStream`/`openLog` are passed into `createHealthController`.

### Integration Points

- `ui/renderer.js` also drives `refreshAgents()`/`home.agents` for the Home screen (EPMCDME-14589), which consumes `parseAgentList` output only — the update-check/action work is scoped entirely to the Agents screen's own controller and does not appear to feed Home.
- No Rust/`src-tauri` commands are implicated; `run_capture` and `run_stream` already exist and are exercised by other controllers.
- The three CLI subcommands (`codemie install <agent> --supported`, `codemie update <agent>`, `codemie uninstall <agent>`) are external processes reached only through `runner.runStream`; their real behavior (spinner-on-stderr, no prompts for uninstall) is documented in the decision docs and confirmed by direct reads of the shipped CLI source under `/Applications/CodeMie Connect.app/Contents/Resources/cli/node_modules/@codemieai/code/dist/`.

### Patterns and Conventions

- Controller factory pattern: `createXController({ container, transport-fn, stepsUi, onFailure, onResult, ...extra })` returning `{ run, getLast... }`, consistent across `agents-controller.js` and `health-controller.js`. A new controller responsibility (actions) fits by extending this same factory's parameter object, matching how `actions = {}` was already added.
- Parser convention: pure function, heading regex to enter a block, a second regex to know when to stop, indentation-based field matching (`agents-parse.js`), or blank-line/next-header-based block splitting (`doctor-parse.js`). A real captured fixture under `ui/test/fixtures/agents/` (parallel to `list.txt`) is the existing convention for parser tests.
- Row action convention: a handler is drawn only if passed (`buildActions`'s `if (!fn) return`) — "never shows a control that does nothing" is a stated invariant, worth preserving for any state (e.g. an action in flight) where a button should disappear or disable rather than a new codepath being invented.
- Re-render-from-source convention: both existing controllers set `lastAgents`/`lastResult` only from a fresh run and never mutate a rendered row's data model directly — matches the ticket's "re-run `codemie list` and re-render from the fresh result" instruction exactly.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — confirms the "frontend-brain, thin Rust backend" split; nothing in this ticket's scope requires a new Rust command (`runner.runStream`/`runCapture` already registered).
- `.ai-run/guides/testing/testing-patterns.md` — JS tests use `node:test` + `node:assert/strict`, one `*.test.mjs` per module under `ui/test/`, no test framework dependency; matches the existing `agents-*.test.mjs` files.
- No guide file specifically named "agents" or "update" exists under `.ai-run/guides/`; conventions for this domain are derived entirely from the existing `agents-*.js` modules and their tests, and from `health-controller.js` as the closest sibling.

### Architectural Decisions

Three decision docs exist, dated the same day as this ticket, and are directly load-bearing for the remaining work (see Section 8 for the specifics each one settles):
- `.ai-run/decisions/2026-09-21-EPMCDME-14514-remove-transport.md` — Remove goes through `runStream`, not a PTY.
- `.ai-run/decisions/2026-09-21-EPMCDME-14514-agent-version-authority.md` — `codemie list` is the only source for a displayed version; `update --check` is read only for the boolean update-available flag.
- `.ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md` — npm reachability is a solved question for dev machines only; the clean-machine (no bundled npm) fix is explicitly out of this MR's scope.

### Derived Conventions

- Inline code comments in `agents-ui.js` (lines 1-13, 24, 27-31) already document forward-looking design intent — e.g. that ERROR/WARNING states belong to the actions, not to `statusOf()` — meaning the ticket's design was clearly anticipated when the "leave alone" modules were built.
- The doctor/health precedent (`groupDoctorResults`, `createHealthController`) is the nearest existing analogue for "run a command, parse it, and derive a joined/grouped view," useful as a structural template for joining list + update-check results by agent name.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/agents-parse.test.mjs` (53 lines) — covers `parseAgentList` against `ui/test/fixtures/agents/list.txt`, a real captured fixture (11 agents, 3 installed, frameworks section, "Next Steps" trailer).
- `ui/test/agents-ui.test.mjs` (166 lines) — covers `renderAgents`, `buildActions` (button presence per install state, click wiring, "no button drawn without a handler"), `summarise`, `showLoading`, `showRunError`. Uses a hand-built DOM stub (`makeEl`) shared in shape with other view tests.
- `ui/test/agents-controller.test.mjs` (184 lines) — covers the `codemie list` read/parse/render cycle, non-zero exit, thrown/rejected `runCapture`, empty-parse-is-an-error, re-entrant no-op, and — directly relevant — a test titled "the action handlers the caller supplies reach the rows," which exercises `actions.onInstall` end-to-end through the controller into a rendered `.agent-actions` button click.

### Testing Framework and Patterns

- `node:test` + `node:assert/strict`, no external test framework or DOM library — DOM is a minimal hand-rolled stub (`makeEl`) reused with small variations across `agents-controller.test.mjs`, `agents-ui.test.mjs`, and other view tests (`health-ui.test.mjs`, etc.).
- Fixture convention: real captured CLI output stored under `ui/test/fixtures/<domain>/<name>.txt`, loaded via `readFileSync(fileURLToPath(new URL(...)))`.
- Transport stubbing convention: a fake `runCapture`/`runStream` function is passed directly into the controller factory (`ok(stdout)` helper in `agents-controller.test.mjs`); a `fakeStepsUi()` helper records every call for assertion instead of touching real DOM/animation.

### Coverage Gaps

- No parser, fixture, or test exists yet for `codemie update --check` output — greenfield for this ticket.
- No test exists for joining list + update-check results by name, for a WARNING row state, or for the header's "· N update available" suffix.
- No test exists for `runStream`-driven install/update/remove action handlers in the controller (spinner start, subtitle updates from stdout/stderr, re-run of `codemie list` after settling, failure text surfaced in the row, no-network wording).
- No existing fixture or test captures a failed install/update/remove CLI transcript (error text, no-network case) — will need to be authored fresh, since the CLI evidence gathered here (Section 8) describes the success-path console output precisely, but this session did not capture a failure transcript.

---

## 5. Configuration and Environment

### Environment Variables

- No feature-specific environment variables were found referenced in `ui/agents-*.js` or `ui/renderer.js`. `CODEMIE_SMOKE` / `CODEMIE_PROBE_SMOKE` (mentioned in the architecture guide) govern smoke-test modes generally, not this feature.
- The npm-for-agent-install decision doc discusses `npm_config_prefix` and PATH as the mechanism a *future* clean-machine fix would use — explicitly deferred, not part of this ticket's environment surface.

### Configuration Files

- `config/steps.yaml` / `config/steps-windows.yaml` govern the legacy install-engine step list — unrelated to the Agents screen's own `steps-ui` instance, which is built directly in `renderer.js` (`stepsUI.createStepsUi()`), not sourced from these YAML files.
- `ui/styles.css` already defines `.agents-head`, `.agents-summary`, `.agent-actions`, `.btn-accent`, `.btn-ghost` — the classes `buildActions`/`renderAgents` use today; no new CSS class is evidenced as required, though the wireframe's amber "update available" pill/ring is not yet backed by a status style beyond the existing `STATUS_META.WARNING` color (`#d29922`) already wired into `steps-ui.js`.

### Feature Flags and Deployment Concerns

- None found specific to this feature. No CI/CD manifests reference `agents` or `update --check`.
- Speculative: npm's presence on the developer's own PATH (confirmed by the npm-for-agent-install decision doc and by this session's own `which codemie` / running the shipped CLI) is what makes install/update actions functional in dev/test today; a machine without npm on PATH will have Install/Update calls fail via the CLI's own `npm error` text, which is exactly the failure text the ticket asks the row to surface as-is.

---

## 6. Risk Indicators

- Speculative: joining `codemie list` and `codemie update --check` records by agent name needs a stable join key; `list`'s records carry `command` (e.g. `claude`) and `name` (e.g. `Claude Code`), while `update --check`'s records (per the shipped CLI's `displayUpdateStatus`) print only `displayName` (`result.displayName`, matching `agent.displayName` — the same string `list` calls `name`), with no `command`/CLI-invocation string in the text at all. The join is therefore by display name, not by command, and a parser reading only `update --check`'s output cannot recover the `command` field for a downstream action if it needs to reference the agent by anything other than name.
- Speculative: `update --check`'s output lists **only installed agents that had a checkable result** — a `null` result (uninstalled, unversioned, non-semver-valid, or `npmPackage`-less agent) is silently skipped by `checkAllAgentsForUpdates`. A parser must not assume every installed agent from `codemie list` appears in `update --check`'s output.
- No captured real-machine fixture exists for `update --check`'s actual stdout on this dev machine — this session attempted to run it live but it did not complete within its timeout (background network calls against the npm registry per installed agent take longer than expected, or hung) and was killed. The exact console.log call sites in the shipped `update.js` (Section 8) are authoritative for the format, but the fixture itself still needs to be captured by a completed real run before the parser's test can point at it, per the ticket's explicit ask for "a fixture captured from the real command."
- No existing test or fixture captures a failed install/update/remove transcript or a no-network transcript — both need to be authored (or captured) fresh; nothing in the repo today exercises `runStream`'s stderr-tag path for these three commands specifically.
- `setSubtitle`'s no-op-on-falsy behavior (steps-ui.js:73-76) means a design that wants a row's subtitle to clear back to the plain "description · version" after an action completes will need an explicit re-render (which the ticket's "always re-run `codemie list`" instruction already provides) rather than relying on `setSubtitle('')`.
- `startSpinner`/`stopSpinner` are tied to `ACTIVE` status via `applyStatus`; using `startSpinner` while independently trying to hold a status like WARNING or ERROR on the same row (e.g., spinner during an update on a row that is also flagged update-available) will need the ordering of `setStatus`/`startSpinner` calls worked out carefully, since `applyStatus` calls `stopSpinner` for any non-ACTIVE status.

---

## 7. Summary for Complexity Assessment

This ticket lands entirely in the frontend JS layer of a Tauri v2 app (`ui/agents-*.js`, plus wiring in `ui/renderer.js`); no Rust/`src-tauri` change is implicated, since `runner.runCapture`/`runner.runStream` already exist and are exercised elsewhere (`health-controller.js`). The concrete change surface is: one new pure parser module + fixture (mirroring `agents-parse.js`'s existing heading/stop-heading shape), extensions to `agents-controller.js` (join list + update-check results, three `runStream`-backed action handlers, re-run-list-after-every-action), small additions to `agents-ui.js` (WARNING status derivation, "· N update available" in the header, in-flight row rendering via the existing `startSpinner`/`setSubtitle`), and wiring three handlers plus a `runStream` reference into the `createAgentsController(...)` call in `renderer.js`. The touched modules are already unit-tested to a fine grain (three `*.test.mjs` files, 400+ lines combined) and follow a consistent controller/parser/presentational split that a new controller test can extend directly, matching the existing "the action handlers the caller supplies reach the rows" test's shape.

Technical novelty is low to moderate: the streaming-command-with-stdout/stderr-tags pattern, the fake-transport-injected-into-controller test pattern, and the pure-parser-with-real-fixture pattern are all established precedent in this codebase (`health-controller.js`, `doctor-parse.js`, `agents-parse.js`). The genuinely new pieces are (a) joining two independently-shaped CLI outputs by display name rather than command, since `update --check`'s text carries no CLI-invocation string, and (b) reasoning through `steps-ui.js`'s status/spinner interaction (spinner ties to ACTIVE, which clears on any other `setStatus` call) for a row that needs to show both "update available" and "action in progress" without a modal, per the wireframe.

The primary risk is evidentiary rather than architectural: this session read the shipped CLI's `update.js` directly to get the exact console.log format (heading, `Current:`/`Latest:` lines, hasUpdate/upToDate wording, and the two possible trailing summary lines) but a live `codemie update --check` run against the installed CLI did not complete within a reasonable window and had to be killed, so the fixture file the ticket asks for still needs to be captured by a completed real run before parser tests can be finalized against it. Coverage gaps are otherwise the expected shape for greenfield work: no parser/join/action-handler tests exist yet, and no failure or no-network transcript has been captured. Given the decision docs already resolve the three hardest open questions (Remove's transport, version authority, npm's dev-machine availability), the remaining implementation work is mostly assembly against well-tested, well-commented existing modules rather than new architectural discovery.

---

## 8. External References

The task named the three decision docs and the wireframe explicitly as sources of truth. All four resolved and were read in full.

- `.ai-run/decisions/2026-09-21-EPMCDME-14514-remove-transport.md` — Resolved. Key fact: `codemie uninstall <agent>`'s shipped implementation (`cli/commands/uninstall.js` in the bundle) has no `inquirer`/`readline`/confirmation of any kind — it resolves the agent, returns early with a plain message if not installed, otherwise calls `agent.uninstall()` behind an `ora` spinner. Decision: **Remove uses `runner.runStream('codemie uninstall <agent>')`, no PTY.** The spinner writes to stderr like doctor's, so a stdout-only reader sees nothing on success. Removing an already-gone agent exits 0 with a plain message — no special-case handling needed beyond re-reading `codemie list`.
- `.ai-run/decisions/2026-09-21-EPMCDME-14514-agent-version-authority.md` — Resolved. Key fact: `codemie list` and `codemie update --check` can print two different version numbers for the same built-in agent by design — `list` always prints `agent.getVersion()` (the binary's own `--version`), while `update --check` substitutes `getCurrentCliVersion()` (the CLI package's own version) for the built-in agent only, per a source comment in the shipped CLI acknowledged as intentional. Decision: **the row's displayed version comes only from `codemie list`; `update --check` is read only for the update-available boolean, never for a displayed "Current" value.** `ui/agents-ui.js`'s `subtitleOf()` already implements this and is covered by `ui/test/agents-ui.test.mjs`.
- `.ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md` — Resolved. Key facts: measured on a clean macOS VM, `codemie install`/`codemie uninstall` shell out to a bare `npm` resolved from PATH; the app bundle ships only the `node` binary, not npm; on a clean machine two of ten agents would install and none would uninstall correctly. On *this* dev machine (and any dev machine), npm is on PATH, so the three actions work today with no change needed. The clean-machine fix (staging npm from the pinned Node tarball, `npm_config_prefix` pointed at a writable directory, PATH additions in two places) is fully scoped but explicitly **deferred out of this MR** — it belongs to EPMCDME-14571 (runtime staging), touches EPMCDME-14505's admin-credential rule, and needs EPMCDME-14508/14899 to sign the added ~10 MB. Task-relevant conclusion: build/test the three actions assuming npm is reachable; do not add clean-machine handling.
- `docs/wireframes/03-agents.png` — Resolved (read as an image). Confirms: the list header shows `"N of M installed · K update available"`; a row with an update available shows an amber "update available" pill next to its name and an amber ring/arrow icon in the list; the detail area for an in-progress action shows a spinner line ("Updating — downloading 0.6.2"), a progress bar, and a small terminal-style transcript panel with the literal command and its output lines; a failed install state shows plain-language text plus the CLI's own raw error block, and states explicitly "OpenCode is still listed as **not installed**. Nothing was left behind." A no-network state reads "Installing an agent needs an internet connection. You are offline, so nothing was started." (the ticket's "installing needs a connection" wording is a paraphrase of this). Note: the wireframe's right-hand detail-pane layout itself is EPMCDME-14655 and out of scope here per the ticket; only the header count, the row-level WARNING pill/ring, and the row-inline spinner/output/failure text are in this ticket's scope.

Additionally (not named by the task but load-bearing for item 1 of the scope, and read directly rather than guessed): the shipped CLI's `update.js` at `/Applications/CodeMie Connect.app/Contents/Resources/cli/node_modules/@codemieai/code/dist/cli/commands/update.js` gives the exact, authoritative `console.log` sequence for `codemie update --check`'s all-agents branch: a blank line, bold `"📦 Agent Update Status:\n"`, then per checkable agent a bold `"  {displayName}"` line, `"    Current: {currentVersion}"`, and `"    Latest:  {latestVersion} (update available)"` or `"    Latest:  {latestVersion} (up to date)"` (two spaces after `Latest:` exactly as the ticket states), followed by a blank line — then a trailing summary of either `"✓ All agents are up to date!"` or `"{N} update(s) available"` followed (in `--check` mode) by a `💡 Run 'codemie update' to install updates` tip line. A live run of `codemie update --check` was attempted on this machine to capture a real fixture but did not complete in the available time and was terminated; the fixture file itself still needs to be captured by a completed run.
