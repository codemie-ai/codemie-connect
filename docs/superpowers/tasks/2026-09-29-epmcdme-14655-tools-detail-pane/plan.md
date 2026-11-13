# Tools detail pane (EPMCDME-14655) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Two-column Tools screen: agent list plus a fixed detail pane (description, version state, derived launcher, valid actions, progress, plain-language failure).

**Architecture:** Frontend only (`ui/`). Parsers derive `launcher` and carry `current`/`latest`; the controller owns selection and per-agent progress/failure keyed by `agent.command` so the full `load()` re-render keeps them. The full `renderAgents` runs only from `load()`, as today. Progress updates and `select()` never call it (it calls `stepsUi.renderSteps`, which would wipe the running row's spinner, ACTIVE badge and disabled buttons); they redraw only the pane and toggle `.selected` on rows directly.

**Tech Stack:** vanilla ESM, node:test, `ui/styles.css`.

**Spec:** requirements inline in the dispatch; research in `technical-analysis.md` (same dir).

Commit per task using the repository's existing convention (`EPMCDME-14655 : subject`, no Co-Authored-By). Never stage `.codemie/codemie-cli.config.json` or `.codegraph/`. Load `.ai-run/guides/` first (AGENTS.md).

## Global Constraints

- No launch/run button, no modals, no raw output kept (never pass `raw` or `command` to `renderFailurePanel`).
- Launcher shown is the derived one, never raw `Command:`.
- Built-in `codemie-code` (`BUILTIN_AGENT_COMMAND`) keeps no actions; its `Current` is never displayed or compared.
- `controller.install(agent, onLine)` (Home path) unchanged; Home's `parseAgentList` read (renderer.js ~l.245) keeps working.
- Gates at the end: `npm test`; in `src-tauri/`: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`. Rebuild before smoking: `cd src-tauri && CI=true cargo tauri build`.

## Review Focus

- Streamed line or row click while an action runs: the running row keeps spinner, ACTIVE badge and disabled buttons.
- Selected agent disappears from a reloaded list: pane shows the empty state, no throw.
- Action finishes while the pane is open: post-action `load({silent:true})` keeps selection and shows the failure/note.
- Prerelease or non-numeric version strings: no "newer" state, no throw.
- Installed Claude equal to Latest: not "newer".

### Task 1: Launcher derivation

**Files:** Modify `ui/agents-parse.js:42` (record build); Test `ui/test/agents-parse.test.mjs` (whole-record deepEqual at l.20-38).

**Produces:** every record from `parseAgentList` has `launcher: string` = `codemie-` + `command`, unless `command` starts with `codemie-`.

Test-first: yes — parsing `fixtures/agents/list.txt` gives `launcher` `codemie-gemini` for gemini (prefix branch) and `codemie-code` for codemie-code (no-prefix branch), and all 11 records have a launcher starting `codemie-`.

- [ ] Add the failing test (both branches plus all 11); update the Claude deepEqual to include `launcher: 'codemie-claude'`.
- [ ] Implement in the record build; run `node --test ui/test/agents-parse.test.mjs` and `ui/test/home-*.test.mjs` (Home tolerates the new field).

### Task 2: Current/Latest parsing and newer-than-supported state

**Files:** Modify `ui/agents-update-parse.js:26-53` (match `^\s{4}Current:\s+(\S+)`, add `current` to record), `ui/agents-join.js` (carry `current`, `latest` always; add `newerThanSupported`), `.ai-run/decisions/2026-09-21-EPMCDME-14514-agent-version-authority.md`. Tests: `ui/test/agents-update-parse.test.mjs` (deepEqual l.19-23, l.32-36), `ui/test/agents-join.test.mjs`. New fixture `ui/test/fixtures/agents/update-check-newer.txt`.

**Produces:** joined agent has `current`, `latest` (strings) and `newerThanSupported: boolean` = not built-in and `semverLt(latest, current)`. Reuse `semverLt` from `ui/cli-update.js:5`; guard so any version not matching `^\d+\.\d+\.\d+$` yields false (no prerelease handling added). `updateAvailable` behavior unchanged; "<latest> available" text still only when an update is available.

Test-first: yes — parsing the synthetic fixture yields `current` > `latest` for Claude and joining gives `newerThanSupported: true` for claude, false for equal versions, false for built-in codemie-code even if its Current is higher than its Latest, false for a `1.0.0-beta` value.

- [ ] Create the fixture by copying real `update-check.txt` and changing only Claude's Current to a version above 2.1.281 and Latest to 2.1.281 (keeping "(up to date)"); state in the test's header comment that it is synthetic, derived from the real capture with versions changed only.
- [ ] Write failing tests, update the two deepEquals with `current`, implement, run the three test files.
- [ ] Edit the decision file: replace the "Current never rendered / join carries a boolean" lines with what now holds (Current is read and compared to Latest for the newer-than-supported state, shown in the pane for non-built-in agents only; built-in Current is the CLI package version and is excluded). Delete obsolete lines outright.

### Task 3: Controller selection and per-agent progress (no full re-render)

**Files:** Modify `ui/agents-controller.js` (`load` l.55-113, `runAction` l.119-163, exposed API l.193-201); Test `ui/test/agents-controller.test.mjs`.

**Interfaces:** Produces controller state `selected` (an `agent.command` or null) and `progress` map (command -> last non-prompt line, deleted when the action ends); failure keeps using `rowErrors`/`rowNotes`. New API `select(command)`. Consumes from Task 4: `renderAgents(container, {agents, selected, progress}, {..., onSelect})` (called only from `load()`), `renderPane(container, agent, {progress, message, busy}, handlers)` and `setSelectedRow(container, command)`.

Rules:
- `load()` calls `renderAgents` exactly as now, passing `selected`/`progress`; selection survives it.
- On each streamed line, `runAction` stores it in `progress` and calls only `renderPane` for the selected agent (if the streamed agent is the selected one). It must not call `renderAgents` and must not call `stepsUi.setSubtitle` for progress (row subtitle stays `description · version`).
- `select(command)` sets `selected`, calls `setSelectedRow` and `renderPane`; never `renderAgents`.
- `runAction` still sets row `ACTIVE` + spinner via `stepsUi`, still calls `onLine`, still returns `{ok,message}`; `busy` passed to the pane is `inFlight.size > 0`.

Test-first: yes — with a scripted stream held open: (a) after a progress line, `renderSteps` call count is unchanged since the action started and the running row's last `setStatus` is still `ACTIVE`; (b) after `select('other')` mid-stream the same holds and the row buttons stay disabled; (c) after `select('gemini')` then `load()`, the render data still has `selected: 'gemini'`; (d) `progress['gemini']` holds the last line during the action and is gone after; (e) a failed action leaves its plain-language message for that command after the silent reload; (f) Home `install(agent, onLine)` still receives every line.

- [ ] Write the failing tests, implement, update existing controller tests that expected progress in the row subtitle (l.267 area).

### Task 4: List and detail pane view

**Files:** Modify `ui/agents-ui.js` (`renderAgents` l.57-84, `subtitleOf` l.40-46, `buildActions` l.94-120), `ui/styles.css` (agents block l.911-956; scope the `.failure-block` margin override to `.agent-pane`, like Health l.724-744); Test `ui/test/agents-ui.test.mjs` (extend `makeEl` `querySelector` minimally, only as far as tests need).

**Produces:** `renderAgents` builds `.agents-body` with `.agents-list` left and a fixed `.agent-pane` right, calling `renderPane` for `selected`. Row click (not on its buttons) calls `onSelect(command)`. Exported `renderPane(container, agent, {progress, message, busy}, handlers)` redraws only `.agent-pane`; exported `setSelectedRow(container, command)` toggles `.selected` on the `.step-row`s (distinct from `.active`). Neither touches `stepsUi` or row buttons.

Pane content for the agent: name, description, version state (Not installed / Installed <version> / Update available <latest> / "Newer than CodeMie supports — kept" with current and latest; built-in shows "built into the CLI", no Current), launcher line "Run it from a terminal: <launcher>" when installed, actions built by the same `buildActions` (built-in none; buttons disabled with `BUSY_LABEL` when `busy`), progress line while set, and on failure `renderFailurePanel(slot, {variant:'error', title, explanation: message})` without `raw`/`command`. Empty state when nothing is selected or the selected agent is gone. Row subtitle is `description · version` only.

Test-first: yes — `renderPane` with gemini shows `codemie-gemini` (not `gemini`) and valid actions; built-in shows `codemie-code`, no buttons, no Current; newer state shows the "kept" text; progress text appears in the pane and not in a row subtitle; failure renders a `.failure-block` with no "Show details"; `busy: true` disables pane buttons; `renderPane` and `setSelectedRow` make zero `stepsUi` calls (fake stepsUi records none); clicking a row calls `onSelect`; no Launch/Run button exists.

- [ ] Write failing tests, implement view and CSS, update existing subtitle tests.

### Task 5: Mutation-check the new tests

**Files:** none kept (temporary edits reverted).

Test-first: no — one step: for each mechanism (launcher prefix branch, `newerThanSupported` compare, built-in exclusion, controller `selected` preserved across `load`, `progress` set/cleared, pane failure via `renderFailurePanel`, `onSelect` click wiring, and pane-only redraw on progress/`select`) remove it from production code (for the last one, make the progress path call `renderAgents`), run `npm test`, confirm a test fails for that mechanism, restore, and confirm `git diff` shows no leftover mutation.

## Self-check

negative-constraints: launch button, modals, raw output/copy, Command as launcher, built-in Current/actions, pinning, touching `.codemie/` and `.codegraph/`, and (from the coordinator) re-rendering the list on progress or selection — honored by Global Constraints and Tasks 2 (built-in exclusion), 3 (pane-only redraw, output cleared on end), 4 (no raw/command, no Launch button, no modal). No task violates them.
