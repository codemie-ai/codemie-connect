# Agents Screen Actions (EPMCDME-14514) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add update-check detection and Install/Update/Remove row actions to the already-built Agents screen, entirely within the existing row — no detail pane (that's EPMCDME-14655).

**Architecture:** A new pure parser (`ui/agents-update-parse.js`) reads `codemie update --check`; a pure join function merges its result into `codemie list`'s records by display name to set an `updateAvailable` flag. `ui/agents-controller.js` gains three `runStream`-backed action handlers that drive the screen's existing `stepsUi` instance directly for in-flight progress, accumulating output from the streaming callback (the only place any text is available), then always refresh via a quiet `refresh()` path — re-running `codemie list` (+ update-check), re-joining and re-rendering in place — never the loading-blanking `run()` and never mutating rendered row state in place. `ui/agents-ui.js` gets small additions: WARNING status/header count, and rendering an in-flight/error row from fields the controller merges onto each agent record. `ui/renderer.js` wires `runStream` and the three handlers into `createAgentsController`.

**Tech Stack:** Vanilla JS, `node:test` + `node:assert/strict`, no DOM library (hand-rolled `makeEl` stub in tests), Tauri `runner.runCapture`/`runner.runStream` bridge.

**Requirements:** Inline ticket text (EPMCDME-14514), reproduced in full task context; no spec.md for this task.

**Technical analysis:** `docs/superpowers/tasks/2026-09-21-agents-screen-actions/technical-analysis.md` — read in full before this plan was written; cited per-task below instead of re-derived.

## Global Constraints

- Do not modify `ui/agents-parse.js` (Home's, EPMCDME-14589) or change `ui/agents-ui.js`'s/`ui/agents-controller.js`'s existing render/read contract beyond the additions named below.
- Never pass an explicit version to any of the three CLI commands; always include the explicit agent name (never a bare command).
- Remove uses `runner.runStream`, no PTY (`.ai-run/decisions/2026-09-21-EPMCDME-14514-remove-transport.md`).
- A displayed version/"Current" value always comes from `codemie list`, never from `update --check` (`.ai-run/decisions/2026-09-21-EPMCDME-14514-agent-version-authority.md`) — confirmed in practice: a real `codemie list` capture shows `CodeMie Code (0.0.47)` while the real `update --check` capture shows `Current: 0.15.2` for the same agent; display names ("CodeMie Code", "Claude Code", "OpenCode CLI") match exactly between the two commands, so the join in Task 2 keys on name safely.
- `runner.runStream`'s resolved/returned promise carries only `{ code }` (`ui/runner-bridge.js:36-47`) — never stdout/stderr text. Any text (for display or for error/no-network detection) must come from the `onLine(text, tag)` streaming callback, accumulated as the action runs — the same mechanism `ui/agents-controller.js`/`ui/health-controller.js` already use for progress.
- npm-on-PATH is assumed; do not build clean-machine handling (`.ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md`).
- Out of scope: the list-and-detail layout (EPMCDME-14655) — all UI stays inside the row.
- Commit per task using the repository's existing convention (see recent `git log`: `EPMCDME-14514 : <subject>`).

## Acceptance criteria

- [ ] `codemie update --check` output parses into records with agent display name, update-available boolean, against a **real captured fixture** (stdout only — the spinner text lives on stderr and is confirmed absent from a stdout-only read) plus a second, clearly-labeled **synthetic** fixture for the update-available case (no real capture on this machine currently has one, since every installed agent is up to date).
- [ ] A row for an agent with an available update shows WARNING status; the header shows "N of M installed · K update available" when K > 0.
- [ ] `update --check` omitting an agent never crashes the join and never falsely flags that agent as having an update.
- [ ] Install/Update/Remove buttons (already drawn by `buildActions` when a handler exists) each run the exact command with the explicit agent name and no version, via `runner.runStream`.
- [ ] While an action runs, the row shows a spinner and the latest streamed line as its subtitle, with no modal.
- [ ] After any action settles (success or failure), a **quiet refresh** (not `run()`'s loading-blanking path) re-runs `codemie list` (+ update-check) and re-renders the whole row set in place — the list is never blanked outside the initial load.
- [ ] A failed action shows the CLI's own error text on that row, taken from the lines accumulated via the `onLine` streaming callback (not from `runStream`'s resolved `{ code }` value, which carries no text); the agent's installed state reflects whatever the post-action `codemie list` reports.
- [ ] A no-network failure — detected against that same accumulated streamed text — shows "Installing needs a connection." on that row instead of raw CLI error text.

---

### Task 1: `codemie update --check` parser + real fixture + synthetic update-available fixture

**Files:**
- Create: `ui/agents-update-parse.js`
- Create: `ui/test/fixtures/agents/update-check.txt` (real capture, verbatim stdout)
- Create: `ui/test/fixtures/agents/update-check-available.txt` (synthetic, header-commented)
- Create: `ui/test/agents-update-parse.test.mjs`

**Interfaces:**
- Produces: `parseUpdateStatus(stdout) -> Array<{ displayName: string, updateAvailable: boolean }>` — consumed by Task 2's join.

**Test-first: yes — parseUpdateStatus against both fixtures must return one record per checkable agent with the right `updateAvailable` boolean, and must stop at the trailing summary/tip lines without emitting a record for them.**

- [ ] Step 1: Create `ui/test/fixtures/agents/update-check.txt` with exactly this verbatim real-captured stdout (no header comment inside the file — it must stay byte-for-byte the real capture; provenance goes in the test file instead):

```
📦 Agent Update Status:

  CodeMie Code
    Current: 0.15.2
    Latest:  0.15.2 (up to date)

  Claude Code
    Current: 2.1.269
    Latest:  2.1.269 (up to date)

  OpenCode CLI
    Current: 1.18.31
    Latest:  1.18.31 (up to date)

✓ All agents are up to date!
```

- [ ] Step 2: Create `ui/test/fixtures/agents/update-check-available.txt` — a second, hand-authored fixture for the update-available path, opening with a comment block (the parser skips any line before the `Agent Update Status:` heading, so this is inert to parsing) stating plainly which lines are real-verbatim-derived vs authored:

```
// SYNTHETIC FIXTURE — not a live capture.
// Real-verbatim-derived (from update-check.txt): the heading line, the
// "  {name}" / "    Current: {v}" / "    Latest:  {v} (up to date)" shape,
// and the trailing summary/tip line shape.
// Authored (no live capture exists with this case): the "(update available)"
// line for Claude Code below, per the ticket's own wording of the shape.

📦 Agent Update Status:

  CodeMie Code
    Current: 0.15.2
    Latest:  0.15.2 (up to date)

  Claude Code
    Current: 2.1.269
    Latest:  2.2.0 (update available)

  OpenCode CLI
    Current: 1.18.31
    Latest:  1.18.31 (up to date)

1 update(s) available
💡 Run 'codemie update' to install updates
```

- [ ] Step 3: Write the failing tests in `ui/test/agents-update-parse.test.mjs`, loaded the same way `agents-parse.test.mjs` loads its fixtures (`readFileSync(fileURLToPath(new URL(...)))`), with a comment noting `update-check.txt` is a real capture from a live run (stdout only; stderr was the spinner text `- Checking for updates...`, confirming a stdout-only read is clean of it) and `update-check-available.txt` is synthetic per its own header:

```js
import { parseUpdateStatus } from '../agents-update-parse.js';
// update-check.txt: 3 records, all updateAvailable: false, none for the "✓ All agents..." line.
// update-check-available.txt: 3 records, Claude Code updateAvailable: true, others false,
// none for the "N update(s) available" / tip lines.
```

- [ ] Step 4: Run `node --test ui/test/agents-update-parse.test.mjs`; confirm it fails (module doesn't exist yet).
- [ ] Step 5: Implement `ui/agents-update-parse.js`, mirroring `ui/agents-parse.js`'s heading/stop-heading shape (`ui/agents-parse.js:15-16`):

```js
const HEADING = /Agent Update Status:/;
const SUMMARY = /update\(s\) available|All agents are up to date/;

export function parseUpdateStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const out = [];
  let inBlock = false;
  let current = null;
  for (const line of lines) {
    if (!inBlock) { if (HEADING.test(line)) inBlock = true; continue; }
    if (SUMMARY.test(line)) break;
    const name = line.match(/^\s{2}(\S.*)$/);
    const latest = line.match(/^\s{4}Latest:\s+.*\(update available\)/);
    if (name) { current = { displayName: name[1].trim(), updateAvailable: false }; out.push(current); continue; }
    if (latest && current) current.updateAvailable = true;
  }
  return out;
}
```

- [ ] Step 6: Run the tests again; confirm they pass.
- [ ] Step 7: Commit.

---

### Task 2: Join list + update-check by display name; WARNING status and header count

**Files:**
- Create: `ui/agents-join.js`
- Modify: `ui/agents-ui.js:25` (`statusOf`), `:34-36` (`summarise`), `:44` (header text)
- Create: `ui/test/agents-join.test.mjs`
- Modify: `ui/test/agents-ui.test.mjs` (add WARNING/header-count cases)

**Interfaces:**
- Consumes: `parseAgentList` records (`ui/agents-parse.js`, shape `{ name, command, installed, version, description }`) and `parseUpdateStatus` records from Task 1 (`{ displayName, updateAvailable }`).
- Produces: `joinUpdateStatus(agents, updateRecords) -> agents` (new array; each element is the input agent plus `updateAvailable: boolean`) — consumed by Task 3's controller and by `agents-ui.js`'s `statusOf`/`summarise`.

**Test-first: yes — joining a list agent whose name has no matching update record must not throw and must leave `updateAvailable: false`; a matching record with `updateAvailable: true` must mark the agent accordingly.**

- [ ] Step 1: Write failing tests in `ui/test/agents-join.test.mjs`: (a) full match sets `updateAvailable` per record, (b) an agent missing from `updateRecords` (the "null result" case per technical-analysis.md §6) gets `updateAvailable: false` and no throw, (c) join never touches `version`/`description`/`installed`.
- [ ] Step 2: Run `node --test ui/test/agents-join.test.mjs`; confirm failure.
- [ ] Step 3: Implement `ui/agents-join.js`:

```js
export function joinUpdateStatus(agents, updateRecords = []) {
  const byName = new Map(updateRecords.map((r) => [r.displayName, r]));
  return agents.map((a) => ({ ...a, updateAvailable: !!byName.get(a.name)?.updateAvailable }));
}
```

- [ ] Step 4: Run the join tests; confirm pass.
- [ ] Step 5: Write failing tests in `ui/test/agents-ui.test.mjs`: a rendered row for an agent with `updateAvailable: true` has WARNING status; `summarise()` returns an `updateAvailable` count; the header text includes `· N update available` only when that count is > 0.
- [ ] Step 6: Run `node --test ui/test/agents-ui.test.mjs`; confirm the new cases fail.
- [ ] Step 7: In `ui/agents-ui.js`, extend `statusOf` (line 25) to check `agent.actionStatus` first (see Task 3), then `agent.updateAvailable`, before falling back to the existing installed/not-installed logic:

```js
const statusOf = (agent) => {
  if (agent.actionStatus === 'error') return StepStatus.ERROR;
  if (agent.actionStatus === 'running') return StepStatus.ACTIVE;
  if (agent.updateAvailable) return StepStatus.WARNING;
  return agent.installed ? StepStatus.COMPLETE : StepStatus.PENDING;
};
```

  Extend `summarise` (lines 34-36) to also return `updateAvailable: agents.filter((a) => a.updateAvailable).length`, and the header append in `renderAgents` (line 44) to append `` · ${updateAvailable} update available`` when that count is truthy.
- [ ] Step 8: Run the `agents-ui` tests; confirm pass.
- [ ] Step 9: Commit.

---

### Task 3: Wire Install/Update/Remove into `ui/agents-controller.js`, with a quiet post-action refresh

**Files:**
- Modify: `ui/agents-controller.js` (whole file; grows from `createAgentsController({ container, runCapture, stepsUi, onFailure, onResult, actions })`)
- Modify: `ui/agents-ui.js:32` (`subtitleOf`, to prefer `agent.actionMessage` when set)
- Modify: `ui/test/agents-controller.test.mjs` (new cases)

**Interfaces:**
- Consumes: `joinUpdateStatus` (Task 2), `parseUpdateStatus` (Task 1), existing `parseAgentList`/`renderAgents`; a new `runStream(cmd, onLine)` param (same shape as `ui/runner-bridge.js`'s `runStream`). Per `ui/runner-bridge.js:36-47`, the promise `runStream` returns resolves **only `{ code }`** — no stdout/stderr text ever lands on that resolved value. `onLine(text, tag)` (`tag` `'stdout'|'stderr'`, per `ui/health-controller.js:59-61`) is the only source of any output text, so the handler must accumulate lines from it into a buffer as the action runs, and use that buffer — never the resolved value — for both display and no-network detection.
- Produces: `createAgentsController({ container, runCapture, runStream, stepsUi, onFailure, onResult, actions })` returning `{ run, refresh, getLastAgents }`. `run()` keeps its existing loading-blanking behavior for the initial load. `refresh()` is new: it performs the same list + update-check + join + render sequence as `run()` but **never calls `showLoading`**, so it re-renders the existing rows in place instead of blanking the container — this is what post-action code calls, since calling `run()` again after every action would empty the whole list on every install/update/remove. `actions` is no longer forwarded verbatim; the controller now builds its own `{ onInstall, onUpdate, onRemove }` internally.

**Test-first: yes — a controller test with a fake `runStream` (resolving only `{ code }`, invoking the injected `onLine` callback with scripted line/tag pairs — matching the real contract, not returning text on the resolved value) must show ACTIVE+spinner while an install is in flight, then a call to `refresh()` (not `run()`) that re-renders without an intervening blank/loading state; a second test must assert a failing `runStream` (non-zero code, `onLine` called with stderr text) leaves the row's `actionMessage` equal to that accumulated stderr text after refresh; a third must assert accumulated text containing `ECONNREFUSED`/`ENOTFOUND`/`ETIMEDOUT`/`getaddrinfo` renders `actionMessage` as "Installing needs a connection." instead of the raw text.**

- [ ] Step 1: Write the three failing controller tests described above in `ui/test/agents-controller.test.mjs`, following the existing `fakeStepsUi()`/fake-`runCapture` pattern already in that file (per technical-analysis.md §4), plus a fake `runStream(cmd, onLine)` that invokes `onLine(text, tag)` for each scripted line and then resolves `{ code }` with no text attached — and an assertion that `showLoading`/the container-clearing path is not re-triggered by the post-action call (i.e. it went through `refresh()`, not `run()`).
- [ ] Step 2: Run `node --test ui/test/agents-controller.test.mjs`; confirm the new cases fail.
- [ ] Step 3: Implement in `ui/agents-controller.js`:
  - Factor the existing body of `run()` into an internal `async function load({ silent })`: identical to today's logic, except it also runs `codemie update --check` via `runCapture` (best-effort: if that read fails or returns non-zero, treat as zero update records rather than failing the whole screen), parses with `parseUpdateStatus`, joins with `joinUpdateStatus`, merges each agent's stored `rowErrors` entry as `{ actionStatus: 'error', actionMessage }`, and only calls `showLoading(container)` when `!silent`.
  - `run()` becomes `() => load({ silent: false })`; add `refresh()` as `() => load({ silent: true })`; return both plus `getLastAgents` from `createAgentsController`.
  - Keep a `Map` `rowErrors` (command -> message) at controller scope, alongside `running`/`lastAgents`.
  - Add a `runAction(agent, command, verb)` helper: `rowErrors.delete(agent.command)`; call `stepsUi.setStatus(agent.command, StepStatus.ACTIVE)` and `stepsUi.startSpinner(agent.command)`; keep a local `const lines = []`; call `const { code } = await runStream(command, (text, tag) => { lines.push(text); stepsUi.setSubtitle(agent.command, text); })`; on `code !== 0` or a thrown error, join `lines` into `accumulated` text, match `/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i` against it, and set `rowErrors.set(agent.command, matched ? 'Installing needs a connection.' : <last non-empty line of lines>)`; always call `await refresh()` at the end (success or failure), never `run()`.
  - Build `onInstall = (agent) => runAction(agent, \`codemie install ${agent.command} --supported\`, 'install')`, `onUpdate = (agent) => runAction(agent, \`codemie update ${agent.command}\`, 'update')`, `onRemove = (agent) => runAction(agent, \`codemie uninstall ${agent.command}\`, 'remove')`; pass these three into `renderAgents(container, { agents }, { stepsUi, onInstall, onUpdate, onRemove })` in place of the old `...actions` spread.
- [ ] Step 4: In `ui/agents-ui.js:32`, change `subtitleOf` to return `agent.actionMessage` first when set, else the existing `description · version` logic.
- [ ] Step 5: Run `node --test ui/test/agents-controller.test.mjs ui/test/agents-ui.test.mjs`; confirm all pass, including the pre-existing "action handlers reach the rows" test from technical-analysis.md §4 (adjust that test only if the `actions` param shape changed under it).
- [ ] Step 6: Commit.

---

### Task 4: Wire `runStream` into `renderer.js`'s `createAgentsController` call

**Files:**
- Modify: `ui/renderer.js` (around lines 470-485, the existing `createAgentsController({...})` call)

**Interfaces:**
- Consumes: `createAgentsController` from Task 3 (now expects `runStream`, and returns `refresh` in addition to `run`); `bridge.runner.runStream`, already used by the Health wiring in the same file for `createHealthController`.

**Test-first: no — this is a one-line wiring change with no new branching logic; Task 3's controller tests already cover the handlers this passes through.**

- [ ] Step 1: In `ui/renderer.js`, add `runStream: bridge.runner.runStream` to the existing `createAgentsController({...})` call, alongside the current `container`, `runCapture`, `stepsUi`, `onResult`, `onFailure` arguments — mirroring how `runStream` is already passed into `createHealthController` in the same file.
- [ ] Step 2: Manual smoke check is out of scope for this task (covered by the calling flow's own verification stage); commit once the file matches.
- [ ] Step 3: Commit.

---

## Negative-constraint pass

- "do not touch [agents-ui.js/agents-controller.js] except to extend it per below" — Task 2/3 changes are additive (`statusOf`, `summarise`, header text, `subtitleOf`, the `actions` internals, the new `refresh` export); no removal or renaming of existing exports. Satisfied.
- "ui/agents-parse.js belongs to Home — leave it untouched" — no task touches it. Satisfied.
- "never with an explicit version" — Task 3's three commands (`install <agent> --supported`, `update <agent>`, `uninstall <agent>`) carry no version argument. Satisfied.
- "Remove... no PTY needed" — Task 3 routes Remove through the same `runStream` as Install/Update, never a PTY transport. Satisfied.
- "update --check['s] data... NEVER for a displayed Current/version value" — Task 2's `joinUpdateStatus` copies only `updateAvailable`, not `currentVersion`/`latestVersion`, onto the agent record; `subtitleOf` (Task 3 Step 4) still reads only `agent.version` (from `codemie list`) for the non-action-message case; confirmed against the real captures cited in Global Constraints. Satisfied.
- "runStream's resolved value carries no text; any text must come from onLine" — Task 3's `runAction` never reads text off the resolved `{ code }`; it accumulates from the `onLine` callback into `lines` and uses only that buffer for both display and the no-network match. Satisfied.
- "refresh after an action must not blank the list" — Task 3 introduces `refresh()` (`silent: true`, no `showLoading` call) and routes every post-action re-read through it; only the initial `run()` blanks the container. Satisfied.
- "the update-available fixture must not be presented as a real capture" — Task 1's `update-check-available.txt` opens with a header comment naming exactly which lines are real-verbatim-derived vs authored; `update-check.txt` stays a byte-for-byte real capture with no fixture-file annotation. Satisfied.
- "never mutate the in-memory row state locally" — Task 3's `runAction` always finishes with a fresh `refresh()` (list + update-check + re-render); it does not splice a locally-mutated agent object into `lastAgents`. Satisfied.
- "Out of scope: the list-and-detail layout" — no task adds a detail pane; all rendering stays inside `agent-actions`/the row via `stepsUi`. Satisfied.
- "Do not build or design around the clean-machine npm-bundling fix" — no task references `npm_config_prefix`, PATH staging, or bundling; npm-on-PATH is assumed per Global Constraints. Satisfied.
- No task in this plan runs a whole-suite quality gate, manual/browser verification, code review, or a commit-artifacts step as its own task — verification lines are single sentences inside existing tasks (Task 4 Step 2) rather than separate stages. Satisfied.
