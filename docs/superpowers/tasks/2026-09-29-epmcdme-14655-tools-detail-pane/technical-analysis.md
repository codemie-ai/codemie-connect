# Technical Research

**Task**: agents list detail pane launcher parse update-check
**Generated**: 2026-09-29
**Research path**: filesystem

---

## 1. Original Context

feature_area: agents list detail pane launcher parse update-check
run_dir: /Users/mert_efe/codemie-installers/codemie-claude-installer-macos/docs/superpowers/tasks/2026-09-29-epmcdme-14655-tools-detail-pane

task_context (verbatim requirements; repo is a Tauri app, frontend in ui/, Rust in src-tauri/; load .ai-run/guides/ first per AGENTS.md):

EPMCDME-14655 — CodeMie Desktop Stage 2: Tools detail pane. Branch feat/EPMCDME-14655-tools-detail-pane, MR to main.

Wireframe: docs/wireframes/03-agents.png (open it). Left half is this ticket: list with detail pane beside it; right-hand cards are just the states drawn out.

Ticket: The Agents detail pane: list-and-detail layout, selecting a row shows the agent's description, version state, the launcher command that runs it, the actions valid for that state (and progress / plain-language failure of the last action). Prereqs already on main: EPMCDME-14514 list, both parsers (ui/agents-parse.js), install/update/remove actions (ui/agents-controller.js, ui/agents-ui.js).

Launcher: `codemie list` prints the vendor binary as `Command:` (claude, gemini, codex, kimi-acp, codemie-code). Launcher on PATH = `codemie-` + Command unless it already starts with `codemie-` (so codemie-code stays codemie-code). Derive it in ui/agents-parse.js for all 11 agents in ui/test/fixtures/agents/list.txt, cover both branches with a test. Do not look in `Next Steps:`.

Newer-than-supported state ("Newer than CodeMie supports — kept"): `codemie update --check` prints Claude's Latest as CodeMie's supported version (hard-coded 2.1.281 in the CLI), not npm's latest. When installed Claude is newer it still prints "(up to date)", so state = Current higher than Latest. ui/agents-update-parse.js reads only Latest today: add Current there and let the state come from comparing the two.

Acceptance: selecting an agent shows description, version state and valid actions in a fixed pane, no modals. Installed agent's pane names launcher (codemie-gemini for Gemini CLI, codemie-code for CodeMie Code). While an action runs on the selected agent, its progress and, on failure, plain-language reason are shown in the pane; the row keeps its badge.

Raw output is OUT of this ticket (EPMCDME-14512 command log not on main; ui/command-log.js footer has no output/record id). Do not keep a copy of output.

Constraints: Do not add launch/run button. Do not render raw Command: as launcher. No modals for progress/errors. Built-in CodeMie Code keeps no actions. Home installs through controller.install with its own onLine, keep that path working. List, row badges, one-action-at-a-time rule and Install/Update/Remove wiring are settled — build the pane on top.
Gates: npm test; from src-tauri/: cargo fmt --check, cargo clippy -- -D warnings, cargo test. Rebuild before smoking: cd src-tauri && CI=true cargo tauri build.

Research goals: map ui/agents-*.js, index/html wiring, styles, existing tests and fixtures, how update --check output is parsed and fixture format (including any fixture where Current > Latest), how progress/failure currently render in rows, the failure-panel (ui/failure-panel.js) usage, and test patterns (node:test). Note exact file/function names and line refs.

---

## 2. Codebase Findings

### Existing Implementations

All under `/Users/mert_efe/codemie-installers/codemie-claude-installer-macos/ui/` (vanilla ESM, no bundler).

- `agents-parse.js` (49 lines) — `parseAgentList(stdout)` (l.18-49). Reads only the block after `Available Agents:` and stops at `OTHER_HEADING = /Available Frameworks:|^\s*Next Steps:/` (l.16, 29). Record built at l.42: `{ name, command, installed, version, description }`. `command` is the raw `Command:` value (l.35). There is no `launcher` field yet.
- `agents-update-parse.js` (53 lines) — `parseUpdateStatus(stdout)` (l.26-53). Per record: `{ displayName, updateAvailable }` (l.42); `Latest:` regex `^\s{4}Latest:\s+(\S+)` (l.40) sets `current.latest` and `updateAvailable` when the line says `(update available)` (l.48-49). The `Current:` line is not matched at all. `SUMMARY` (l.24) is anchored to avoid stopping on a record's own "(update available)".
- `agents-join.js` (13 lines) — `joinUpdateStatus(agents, updateRecords)`; joins by display name (`a.name` vs `rec.displayName`); returns `{...a, updateAvailable, latest: updateAvailable ? rec.latest : undefined}`. `latest` is dropped unless an update is available, and nothing carries `Current`.
- `agents-controller.js` (202 lines) — `createAgentsController({container, runCapture, runStream, stepsUi, onFailure, onResult})`.
  - `load({silent})` l.55-113: `codemie list` (l.63), then best-effort `codemie update --check` (l.85), join (l.91), merge `rowErrors`/`rowNotes` into `actionStatus`/`actionMessage` (l.92-97), `renderAgents(container, {agents}, {stepsUi, onInstall, onUpdate, onRemove})` (l.100), `onResult?.(agents)`.
  - `runAction(agent, command, {onLine, note, verb})` l.119-163: refuses when `inFlight.size` (l.121, one-at-a-time); `SAFE_COMMAND` check (l.26, 122); sets `stepsUi.setStatus(agent.command,'ACTIVE')` + `startSpinner` (l.131-132); streams via `runStream(command, (text, tag)=>...)` (l.136): `tag==='prompt'` is skipped (l.141), other lines go to `stepsUi.setSubtitle(agent.command, text.replace(/^\s*-\s+/, ''))` (l.144) and `onLine`. On non-zero exit `messageFor(lines, verb)` (l.165-180) goes into `rowErrors`; on success with `note` the last `✔✓⚠` line goes into `rowNotes` (l.150-153). `finally` clears `inFlight` and `load({silent:true})` (l.159-160).
  - Exposed: `run`, `refresh`, `getLastAgents`, `install(agent, onLine)` (l.193-201). `onInstall/onUpdate/onRemove` l.189-191 (`codemie install|update|uninstall <command>`).
  - `messageFor` order: NO_NETWORK regex (l.20) -> "`<verb>` needs a connection."; "timed out after N ms" -> minutes text; last `ERROR_LINE` match with glyph stripped; last non-empty line; fallback "The command failed with no output.".
  - Progress state lives only in the step row (subtitle text) and in `rowErrors`/`rowNotes` maps keyed by `agent.command`. The controller keeps NO per-agent "current progress line" state that a detail pane could re-read after a re-render (the `load()` re-render at l.100 rebuilds the DOM).
- `agents-ui.js` (148 lines) — presentational.
  - `statusOf(agent)` l.29-33: `actionStatus==='error'` -> ERROR, `'running'` -> ACTIVE, else installed -> COMPLETE / PENDING. Note the controller never sets `actionStatus:'running'`; running is shown via `stepsUi.setStatus(...,'ACTIVE')` directly.
  - `subtitleOf(agent)` l.40-46: `actionMessage` wins; else `description · version`; built-in adds " · built into the CLI"; update adds " · <latest> available".
  - `summarise(agents)` l.48-55 (header count; excludes built-in from update count).
  - `renderAgents(container, {agents}, handlers)` l.57-84: builds `.agents-head` (title "Tools" + summary), `.agents-note` ("Run a tool from a terminal. This screen only sets them up."), `.agents-list`; `stepsUi.renderSteps` with `makeStep({id: a.command, title: a.name})`; per row `setStatus`, `setSubtitle`, appends `buildActions(...)` to the `.step-row`, sets `row.title` for updates (l.80-82). No selection concept, no click handler on rows, no detail pane.
  - `buildActions(agent, handlers, screenButtons)` l.94-120: `.agent-actions` slot with `dataset.id`; built-in (`BUILTIN_AGENT_COMMAND`, l.99) returns an empty slot; installed -> `Update` only if `agent.updateAvailable`, always `Remove`; not installed -> `Install`. Click handler (l.103-108) disables ALL screen buttons, relabels via `BUSY_LABEL` (l.86), calls `fn(agent)`.
  - `showLoading` l.122, `showRunError` l.133 (`.agents-error` block, its own markup, does NOT use `renderFailurePanel`).
  - File header comment l.11-13 already says the detail pane is EPMCDME-14655.
- `steps-ui.js` — `createStepsUi()` (l.13); returned API `renderSteps, setStatus, setSubtitle, startSpinner, stopSpinner, setProgress, insertSubStep, showApproval, stampApproval` (l.135). `setSubtitle` ignores empty text (l.73-76). `rows` map is per instance; agents screen has its own instance (renderer.js l.589).
- `failure-panel.js` (100 lines) — `renderFailurePanel(container, {variant='error'|'warning', title, explanation, detail, raw, command, primaryLabel, onPrimary})` (l.26). One `.failure-block` per container (l.36 removes previous). Adds a "Show details" button and hidden `<pre class="failure-raw">` only when `raw` is passed (l.66-92) — passing `raw` would be keeping output, which the ticket rules out; omit `raw`/`command`. Pure DOM, importable under node:test.
- `home-state.js` l.58 — `export const BUILTIN_AGENT_COMMAND = 'codemie-code'`; imported by `agents-ui.js`, `home-agent-picker.js` (l.12, 73).
- `cli-update.js` l.5 — `semverLt(a, b)` (exported, X.Y.Z numeric compare, `a<b`). Only version comparator in the codebase; `ui/test/version-utils.test.mjs` tests a COPY of it (header says "copy the function here"). Usable for `Current > Latest` as `semverLt(latest, current)`. Caveat: `Number('2-beta')` -> NaN, no pre-release handling.
- `renderer.js` — imports at l.18, 23, 25; `views.agents = #agents-view` (l.69); `home.agents` (l.183); `onInstallAgent: (agent, onLine) => agentsController.install(agent, onLine)` (l.196); Home's own `parseAgentList` read at l.245 (so Home records also gain any new parse field); `agentsController.run()` on first open of the view (l.346-348, guarded by `agentsChecked`); controller construction l.586-598 (`onResult` updates `home.agents` and `renderHome()`; `onFailure` resets `agentsChecked`); l.717 resets `agentsReadAt`.
- `index.html` l.43 sidebar button `#sidebar-agents` (`data-view="agents"`, label "Tools"); l.161 `<div id="agents-view" class="hidden"></div>`. The view is an empty container, fully rendered by JS.
- `home-agent-picker.js` and `home-view.js` consume agents records and `controller.install` with `onLine` (Home path that must keep working).

### Architecture and Layers Affected

- Parser layer (pure): `agents-parse.js`, `agents-update-parse.js`, `agents-join.js`.
- Controller layer: `agents-controller.js` (data merge, action progress/failure state).
- View layer: `agents-ui.js` (+ possibly a new pure-DOM module next to it), `steps-ui.js` per-instance rows (settled, must keep badges).
- Styles: `styles.css` (see Section 5).
- Wiring: `renderer.js` controller construction (probably unchanged). No Rust/backend change is implied by anything found; the CLI reads go through existing `runCapture`/`runStream`.

### Integration Points

- `agents-controller` -> `agents-parse`, `agents-update-parse`, `agents-join`, `agents-ui`; `renderer.js` -> controller; Home -> `controller.install(agent, onLine)` and `onResult(agents)`.
- Any new field on the agent record flows to `home.agents` (renderer.js l.591-594, 245) and to `deriveHome` (`home-state.js`), and into the `deepEqual` fixtures in tests (see Section 4).
- External: the `codemie` CLI only (`codemie list`, `codemie update --check`, `codemie install|update|uninstall <cmd>`); no HTTP/SDK clients.

### Patterns and Conventions

- Pure parsers with heading/stop-heading shape; controller injects `runCapture`, `runStream`, `stepsUi` for testability; view modules are DOM-only using a local `el(tag, className, text)` helper (`agents-ui.js` l.18).
- Per-agent state is keyed by `agent.command` (`rowErrors`, `rowNotes`, `inFlight`, step-row `data-id`).
- Failure text is produced by `messageFor` (plain language) and re-merged on each `load()`.
- Decisions recorded in `.ai-run/decisions/`: `2026-09-21-EPMCDME-14514-agent-version-authority.md` (see Section 3 - relevant conflict), `...-install-without-supported.md`, `...-npm-for-agent-install.md`, `...-remove-transport.md`, `2026-09-22-EPMCDME-15189-builtin-agent-does-not-tick.md`.
- Wireframe `docs/wireframes/03-agents.png` (read): left column list rows (name, description subtitle, right-hand status glyph: green tick / amber up-arrow / red "!"); selected row highlighted; right pane shows title + badge ("update available"), "Google's coding agent. Installed 0.4.0 · CodeMie supports 0.6.2", buttons Update (accent) and Remove (ghost), a progress line "Updating — downloading 0.6.2", a progress bar, a mono command block (raw output, OUT of scope), and a footer "Run it from a terminal: `codemie-gemini` in your project folder." Cards on the right: "Below the minimum version" (red, Update button), "Newer than CodeMie supports" (amber, `kept` pill; text "You have Claude Code 2.4.0; CodeMie has verified 2.0.1. CodeMie will not downgrade it."), "Installation failed" (plain language + raw, raw out of scope), "No network at all" (grey). The wireframe list footer also lists "+ Claude Code ACP · Kimi Code ACP · Cursor · CodeMie built-in" (a collapsed group; not in ticket text, list is settled).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — frontend-brain + thin Rust (Option B); says nothing about agents/detail pane (stale for the agents feature; lists older ui files).
- `.ai-run/guides/testing/testing-patterns.md` — node:test + `node:assert/strict`, `ui/test/<module>.test.mjs`, `npm test`.
- Also present, not needed here: `development/development-practices.md`, `standards/git-workflow.md`, `quality-gates.md`, `project.md`.

### Architectural Decisions

- `2026-09-21-EPMCDME-14514-agent-version-authority.md`: "The version shown in a row comes from `codemie list`... `codemie update --check` is read only for the update-available flag, never for a version the screen displays. Its `Current:` value is not rendered anywhere... the join between the two parsers carries a boolean, not a number." This ticket explicitly adds `Current` to `agents-update-parse.js` to derive the newer-than-supported state, which departs from that decision's "boolean not a number" join. Also the built-in agent's `Current:` is the CLI package version (0.15.2) not the agent's (0.0.47), so `Current` must not be shown for `codemie-code` and must not drive its state. The decision file will need an update or a new decision note. Speculative: whether the ticket wants Current displayed or only used for state.
- `2026-09-22-EPMCDME-15189-builtin-agent-does-not-tick.md`: built-in is reported installed by the CLI but not user-installable.
- `2026-09-21-EPMCDME-14514-install-without-supported.md`: bare `codemie install <cmd>`.

### Derived Conventions

- Commit subjects `EPMCDME-NNNNN : subject`, no Co-Authored-By (user memory rule, overrides the harness attribution reminder), branch `feat/EPMCDME-14655-...` uppercase ID already satisfied.
- Fixture files are real CLI captures with descriptive headers in the test file; hand-invented fixtures have been called out as a problem in project memory (fixtures must match real output).

---

## 4. Testing Landscape

### Existing Coverage

All in `ui/test/`, run by `npm test` = `node --test ui/test/*.test.mjs` (package.json).

- `agents-parse.test.mjs` (53 lines) — 4 tests. Test at l.20-38 `deepEqual`s the whole Claude record `{name, command, installed, version, description}` (l.24-30): adding a `launcher` (or any) field to the record breaks this assertion and it must be updated. l.13-18 asserts 11 commands in order `['codemie-code','claude','claude-acp','gemini','opencode','codex','pi','kimi','kimi-acp','openwiki','copilot']`, and excludes frameworks / Next Steps.
- `agents-update-parse.test.mjs` (63 lines) — `deepEqual`s full record arrays `{displayName, updateAvailable, latest}` at l.19-23 and l.32-36; adding `current` will break these two.
- `agents-join.test.mjs` (50 lines) — 4 tests (join flags, missing record, no mutation of version/description/installed, latest only when update).
- `agents-ui.test.mjs` (249 lines) — hand-rolled DOM stub `makeEl` (l.8-46) with `_children`, `querySelector` supporting only `.class` and `.class[data-id="x"]` (l.47-58), `innerHTML` setter that empties children, `globalThis.document = {createElement: makeEl}` (l.60); `fakeStepsUi()` (l.65-81) recording `renderSteps/setStatus/setSubtitle` (no `startSpinner`); sample `agents` array l.85-89; helper `buttons(container)` l.90. Tests at l.92-249 cover rows, statuses, subtitles, buttons, disabled-on-click, loading/error, update wording, summary. The stub lacks `addEventListener`, `classList`, `setAttribute`, `hidden`; a detail pane using those needs the stub extended (or `onclick` assignment like existing code).
- `agents-controller.test.mjs` (628 lines) — `makeEl` l.8, `fakeStepsUi` l.53, `fakeRunCapture(listStdout, checkStdout)` l.89, `ok()` l.100, `fakeRunStream(scriptedLines, code)` l.221; tests l.102-609 covering load, best-effort update check, failures, in-flight subtitle/ACTIVE/spinner (l.267), failure message wording (l.314-540), one-at-a-time (l.399), Update note (l.561), echoed prompt never shown (l.429, 609), Home path `install`.
- `failure-panel.test.mjs` (107 lines) — panel DOM contract.
- Fixtures `ui/test/fixtures/agents/`: `list.txt` (real capture, CLI 0.15.2, 11 agents + 3 frameworks + others incl. codebase-memory/codegraph/graphify below l.70; agent Commands: codemie-code, claude, claude-acp, gemini, opencode, codex, pi, kimi, kimi-acp, openwiki, copilot), `update-check.txt` (real; 3 agents CodeMie Code 0.15.2/0.15.2, Claude Code 2.1.269/2.1.269, OpenCode CLI 1.18.31/1.18.31, "up to date"), `update-check-available.txt` (real capture 2026-09-23; OpenCode Current 1.18.31 Latest 1.18.32 "(update available)", trailer "1 update available" + tip), `install-no-registry.txt` (real failed-install capture, ECONNREFUSED).
- **No fixture has Current > Latest.** Claude in both update fixtures is equal (2.1.269). A newer-than-supported fixture does not exist and would have to be created (real capture requires an installed Claude above 2.1.281, not on this machine's fixtures; synthetic per the existing "synthetic" precedent in `agents-update-parse.js` header comment).
- Related: `version-utils.test.mjs` (copy of `semverLt`), `cli-update.test.mjs` (tests the real `semverLt` from `cli-update.js`), `home-*.test.mjs` (Home consumes agents records).

### Testing Framework and Patterns

`node:test` + `node:assert/strict`, no framework dependency; DOM stubbed by hand per file (each test file re-declares `makeEl`); dynamic `await import('../agents-ui.js')` after setting `globalThis.document`; fixtures read with `readFileSync(fileURLToPath(new URL('fixtures/agents/...', import.meta.url)))`. Rust: inline `#[cfg(test)]`. Project memory rule: mutation-verify new tests (delete mechanism, exactly one test should fail). `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests` holds a playwright suite (`npm run test:ui`) — not part of the gates listed.

### Coverage Gaps

- No test for a launcher field (none exists), no test of a selection/detail concept, no test of Current parsing or Current > Latest, no fixture for the newer-than-supported state.
- CSS is not tested (`top-banner-style.test.mjs`, `identity-bar-layout.test.mjs` show a CSS-string test pattern exists for other views).
- No test drives Home + Agents through the same controller with a selected-agent state.

---

## 5. Configuration and Environment

### Environment Variables

None relevant to the feature. (`CODEMIE_SMOKE=1`, `CODEMIE_PROBE_SMOKE=1` smoke modes exist per architecture guide/README.)

### Configuration Files

- `ui/styles.css` — Agents styles at l.911-956: `#agents-view { padding: 22px 28px 28px }` (l.912), `.agents-head` (l.932), `.agents-title`, `.agents-summary`, `.agents-note` (l.942), `.agents-list` (l.943), `.agent-actions { margin: 6px 0 2px 26px }` and `.agent-actions .btn` (l.944-945), `.agents-error*` (l.946-953). Step rows: `.step-row` l.560, `.step-row.active` l.569 (highlight uses `--surface-2`), `.hidden { display:none !important }` l.44. Failure panel styles l.859-891 (`.failure-block { margin: 14px 12px 0 }`, `.failure-panel`, `.failure-title`, `.failure-body`, `.failure-detail`, `.failure-actions`, `.failure-raw`, `.failure-panel.warning` amber). Health-specific overrides at l.724-744 show how an embedded panel is restyled. `#agents-view:has(> .screen-loading)` l.918. There is no two-column/list-detail style anywhere; `.step-row.active` is bound to running status, not selection, so a selected-row style must be new and distinct from `.active`.
- `ui/index.html` l.161 `#agents-view`; `ui/codemie-tokens.css` has design tokens (`--violet`, `--amber`, `--red`, `--muted`, `--dim`, `--surface-2`, `--accent`).

### Feature Flags and Deployment Concerns

None. Frontend changes need a rebuild (`cd src-tauri && CI=true cargo tauri build`) before smoking. Working tree has an unrelated modification `.codemie/codemie-cli.config.json` (do not commit). Project memory: never run a real `codemie` in tests; never touch the tree while the wrapper (codemie-claude) is running.

---

## 6. Risk Indicators

- Existing `deepEqual` tests will break when record fields are added: `agents-parse.test.mjs` l.24-30 (launcher) and `agents-update-parse.test.mjs` l.19-23, l.32-36 (current). Expected but must be updated deliberately.
- Decision conflict: `2026-09-21-EPMCDME-14514-agent-version-authority.md` says `Current:` is never rendered and the join carries a boolean. The ticket reverses part of it. Built-in `codemie-code` `Current` is the CLI package version (0.15.2 vs agent 0.0.47), so comparing Current to Latest for it, or showing it, would be wrong; needs an explicit exclusion.
- `agents-join.js` drops `latest` unless `updateAvailable`, and carries no Current; the newer state needs Current and Latest both to reach the view (join and its tests change).
- Newer-than-supported applies to Claude only in the CLI's logic (`agent.name === 'claude'` compares against supported version, per the decision doc); other agents compare to npm latest and would print "(update available)" when behind, and Current > Latest for them would be unusual. Speculative: state rule should not need per-agent branching, but the wireframe example and ticket text are Claude-specific.
- Version compare: only `semverLt` (cli-update.js) exists, plain numeric X.Y.Z, NaN on pre-release tags; `version-utils.test.mjs` tests a copy, not the real function. Speculative: reuse `semverLt` from `cli-update.js` and guard non-numeric versions.
- No real fixture for Current > Latest; any fixture is synthetic (needs an honest header like `update-check-available.txt`'s history; project memory warns invented fixtures pass guards that fail the real CLI).
- Re-render on every `load()` (`agents-controller.js` l.100 rebuilds `container.innerHTML`): selection and the in-flight progress line are lost unless the controller keeps a selected id and a per-agent progress string. Progress today lives only in the step-row subtitle (`stepsUi.setSubtitle`, controller l.144); it would need a controller-side value (e.g. keyed by `agent.command`, like `rowErrors`) so the pane can re-render mid-action. Post-action `load({silent:true})` (l.160) redraws while the pane is open.
- Wiring hazard: `runAction` calls `stepsUi.setStatus/startSpinner/setSubtitle` directly on row ids; the "row keeps its badge" requirement means the pane must not replace the row status logic, and the progress text now goes to the pane, likely not the row subtitle (row subtitle currently shows progress and error text - `subtitleOf` uses `actionMessage`). Changing that overlaps "row badges settled".
- Home path: `controller.install(agent, onLine)` (l.200) goes through `runAction`; any progress-state change in `runAction` must keep `onLine` calls and the `{ok,message}` return, and Home's own records (renderer.js l.245) get the new `launcher` field too (only `deriveHome` shape/tests may need to tolerate it).
- Raw output is out of scope: `renderFailurePanel` shows "Show details" only when `raw` is passed; passing `raw`/`command` would retain output, so omit them. `showRunError` in `agents-ui.js` does not use the failure panel; the ticket's "no modals" plus plain-language failure could reuse `renderFailurePanel` (title, explanation, no raw) or a small inline block; Section 5's `.failure-block` margins (14px 12px) are tuned for full-width screens and likely need a scoped override as done for Health (styles.css l.724-744).
- Test DOM stub limits (`querySelector` only `.class` / `.class[data-id]`, no `classList`, no `dataset` on `hidden`) constrain how selection/pane code can be written or force stub extension in three test files (`agents-ui`, `agents-controller`, possibly `home-*`).
- Launcher rule: 4 of 11 commands begin `codemie-` only for `codemie-code`; the other 10 get prefix (`claude-acp` -> `codemie-claude-acp`, `kimi-acp` -> `codemie-kimi-acp`, `opencode` -> `codemie-opencode`, `pi` -> `codemie-pi`, `openwiki` -> `codemie-openwiki`, `copilot` -> `codemie-copilot`). Speculative: whether the CLI really installs these launcher names for every agent was not verified in this research (the ticket states the rule; only codemie-gemini/codemie-code are named as acceptance examples). `SAFE_COMMAND` is checked on `agent.command`, not on the derived launcher; the launcher is display-only text, so `textContent` rendering keeps it safe.
- Wireframe includes the list footer group "+ Claude Code ACP · Kimi Code ACP · Cursor · CodeMie built-in" and the "Below the minimum version" and "No network at all" cards; the ticket text lists only newer-than-supported, so these are scope-ambiguous. Ticket says list is settled.

---

## 7. Summary for Complexity Assessment

The change is entirely frontend (no Rust, no config, no new dependencies) across three layers: the pure parsers (`agents-parse.js` launcher derivation; `agents-update-parse.js` + `agents-join.js` Current/Latest comparison), the controller (`agents-controller.js` needs selection and per-agent progress state that survives the full re-render in `load()`), and the view (`agents-ui.js` gains a list-and-detail layout, selection, and a fixed pane; `styles.css` gets a two-column layout with no existing precedent, plus a distinct selected-row style since `.step-row.active` already means "running"). Roughly 5 source files, 1 stylesheet region and 5-6 test files change; `renderer.js` and `index.html` likely stay as is because `#agents-view` is a JS-rendered empty container.

Technical novelty is moderate. Nothing new in dependencies, but the pane reverses part of a recorded decision (Current is never rendered), there is no existing selection pattern, and the newer-than-supported rule has a built-in-agent trap (Current is the CLI package version for `codemie-code`). Progress currently lives only in the step-row subtitle, so moving it to the pane while "the row keeps its badge" touches settled behaviour and the Home `install(agent, onLine)` path. The `failure-panel.js` module exists and is reusable if `raw`/`command` are omitted.

Test posture is good for parsers, join, controller and view (node:test, ~1150 lines across the agents tests, real-capture fixtures), but several `deepEqual` assertions on whole records will change, hand-rolled DOM stubs limit selection/pane tests, and there is no real fixture for Current > Latest, so a synthetic one is unavoidable. Key risks: selection and progress lost on re-render, decision-doc conflict, semver compare edge cases (pre-release), scope ambiguity between the ticket text and the wireframe's extra cards.

---

## 8. External References

None named by the task. (In-repo paths it named were read: `docs/wireframes/03-agents.png` viewed and summarised in Section 2; `ui/agents-parse.js`, `ui/agents-update-parse.js`, `ui/agents-controller.js`, `ui/agents-ui.js`, `ui/failure-panel.js`, fixtures under `ui/test/fixtures/agents/`.)
