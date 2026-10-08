# Technical Research

**Task**: setup-view setup-driver replay onAnswer steps-ui
**Generated**: 2026-10-01
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14656 — Replay, and clicking back into an answered guided-setup step: resuming a restarted run at a chosen step without re-answering the steps before it. Wireframe docs/wireframes/02-setup.png (top line: answered steps collapse to a line you can click back into, so when a later step fails an earlier answer can be changed without starting over).

Already established:
- Replay already exists in the driver and is tested; driver needs no more work. startSetup in ui/setup-driver.js takes `replay`, a list of earlier answers [{ id, answer, label }]. Each prompt matching the next entry is answered from it without calling onPrompt; onReplayed(prompt, answer) is called instead so the view can show that step as answered. First non-matching prompt ends replay and goes to onPrompt. Entries are matched by label. onAnswer({ id, kind, answer, label }) reports every answer of a run in order, replayed or not; that list is exactly what the next replay takes. See comment above startSetup and replay tests at end of ui/test/setup-driver.test.mjs.
- Restarting = cancelSetup() then startSetup(). cancelSetup kills the child and awaits exit. setup-view.js already does this for Try again (renderFailurePanel, onPrimary) but starts from top with no replay.
- App runs `cd /; codemie setup` with no --force (SETUP_COMMAND comment explains); keep it.
- Work is all in ui/setup-view.js: keep the run's onAnswer list in the view. Make collapsed answered rows clickable, but NOT the storage row (fixed policy). A click replays the answers given before that step so that step opens again. A run-ending failure's Try again replays the answers given before the failed step; when the step isn't known, replay everything answered. Replayed steps show as answered rows, same as user-answered.
- Clicking back must stop once the CLI has saved the profile: it prints `✔ Profile "<name>" saved to global config` (see recorded frames in setup-driver.test.mjs). From that line on, rows are not clickable.
- Replay list can hold an API key: memory only, never log, never persist.
- With CodeMie SSO each run reopens the browser; expected.

Research goals: map ui/setup-view.js (how steps/rows/answered rows are rendered via steps-ui, how startSetup/cancelSetup/onPrompt/onReplayed/onAnswer are wired, Try again path, storage row, how the failed step is identified, where the 'profile saved' line would be observable — onLog? driver event?), existing view tests (ui/test/*), how views are tested (DOM stubs?), and CSS for clickable rows. Report precise file:line anchors and risks.

---

## 2. Codebase Findings

### Existing Implementations

All line numbers are for the working tree on branch feat/EPMCDME-14656-setup-step-revisit (HEAD d97d35c, the driver replay commit). setup-view.js is 906 lines.

ui/setup-view.js (`createSetupView(container, deps)`, line 247; returns `{ start, getAnsweredValues }` at 905):
- Imports: `createStepsUi` from steps-ui.js (line 13), `renderFailurePanel as renderPanel` from failure-panel.js (line 16). Driver, runner-bridge are lazy-imported through deps defaults (312-323).
- Module-level helpers: `findRow(container, id)` (123) walks `container.children` matching `dataset.id`; `findControlHost` (131). `PROMPT_COPY` (101-121) holds heading/helper/collapsedLabel per prompt id (gate, updateProfile, provider, codemieProject, model, profileName, installClaude). `NEVER_RENDERED_PROMPT_IDS = {'activate'}` (26). `isSecretPrompt` (63), `maskSecret` (72).
- Per-view state (248-308): `stepsUi`, `occurrenceCounts`, `baseMessageByPromptId`, `answeredValues` Map (259; a placeholder comment names EPMCDME-14656, "Nothing in this file reads it"; only `getAnsweredValues()` exposes it, and only a test uses it, setup-view.test.mjs:1780), `firstAskByPromptId`, `activeRowId`, `lastRowId`, `transient`, `install`, `failureOnScreen`, `pendingFailure`, `waitingForSignIn`, `signInLineSeen`.
- Row id scheme: `${promptId}-${occurrence}` (589); `nextOccurrence`/`latestOccurrenceRowId` (325-334). Transient rows `working-N` (447). Storage row id is literally `'storage'` (874).
- Answered row rendering: `renderControl`'s inner `submit(value, humanText)` (498-517): `answeredValues.set`, clear controls and helper, `setStatus COMPLETE`, `setSubtitle(humanText)`, `collapseRow(rowId, prompt.id)`, then `showTransientSpinner()`, then `resolve(value)`. Secret input gets `maskSecret(value)` as the subtitle (227). installClaude=yes takes a different branch (503-508): row stays active with a spinner until `onLog` sees INSTALL_OK/INSTALL_FAILED (480-489, `finishInstall` 471 which also calls `collapseRow`). installClaude=no shows subtitle "Skipped" (510).
- `collapseRow(rowId, promptId)` (385-394): adds class `collapsed`, replaces title with `PROMPT_COPY[promptId].collapsedLabel`. This is the only place a row becomes "answered looking"; it is also what the storage row uses (877). Any click affordance would naturally hang off this function plus a per-row marker.
- `onPrompt(prompt)` (534-600): the only entry the driver's `onPrompt` goes through. Reopen path (551-582, a validation-rejected re-ask of the same question reuses the row, un-collapses, status ACTIVE) vs new-occurrence path (584-599: insert row, ACTIVE, `activeRowId`, `lastRowId`, control host, returns a Promise resolved by `submit`). No `onReplayed` or `onAnswer` handler exists anywhere in the view; `run()` passes only `{ onPrompt, onLog, onScreen: handleScreen }` (886).
- `run()` (842-903): resets all per-run state (846-860, including `answeredValues.clear()` at 860 with a comment saying a retry re-answers from the top and "EPMCDME-14656's replay would otherwise read a mix of two runs"), `stepsUi.renderSteps(container, [])` (861, clears the container), appends `h1.setup-view-heading` (866-869), storage row (874-878: insertSubStep, COMPLETE, subtitle 'This computer', `collapseRow('storage','storage')`, `lastRowId='storage'`), `showTransientSpinner()` (882), then `await startSetup(...)` and `handleReject` / `handleResolve`.
- `start()` (833-840): single-flight via `inFlight`; calls `deps.onRun?.(inFlight)` on every run. `start()` takes no arguments today.
- Try again path: `renderFailurePanel({ id, cliMessage, raw, recoverable })` (778-791). `onPrimary` for a non-recoverable failure is `async (block) => { block.remove(); await cancelSetupFn(); start(); }` (789). Recoverable (authTimeout from handleScreen, 816-821) only removes the block (788). No replay passed on either.
- Failed-step identification, `handleReject(err)` (671-732): `err.cancelled === true` returns early (675). `step = err.step ?? null` (676). Branches (686-712): step present in `occurrenceCounts` -> `latestOccurrenceRowId(step)`; `step === 'model' || 'updateProfile'` (689) -> row added by the view because the driver rejected inside its list walk before onPrompt; else `activeRowId`; else transient row ("Setup stopped"); else `lastRowId`. The `step` string is the prompt id, so it is the key for "answers given before the failed step". When `step` is null (e.g. "unrecognized prompt, run stalled", setup-view.test.mjs:1726) the view falls to activeRowId/transient/lastRowId, none of which gives a reliable prompt id.
- `handleScreen(lines)` (797-822): the onScreen callback. Uses a transition latch (`failureOnScreen`) to react once per occurrence. This is the existing idiom for reacting to a line appearing on the CLI screen.
- `handleResolve` (620-667): hides transient, settles install, releases open row, reads config, appends `.setup-view-status` and redirect (`deps.onDone` after `DONE_DELAY_MS`=1800, 168). On unverified config marks `lastRowId` ERROR and returns null.

ui/steps-ui.js (150 lines, `createStepsUi()` 13):
- `buildRow` (19-43) creates `div.step-row[data-id]` with `.step-progress`, `.step-icon`, `.step-main > .step-title + .step-sub`. No click handling, no role/tabindex. `applyStatus` (45) sets `dataset.status` and `active` class. Returns `{renderSteps, setStatus, setSubtitle, startSpinner, stopSpinner, setProgress, insertSubStep, showApproval, stampApproval}`. There is no remove-row primitive (comment at 439-443 in setup-view). `insertSubStep(null, step)` appends at the end of the list (106-108) and dedupes on id (101).
- Rows are plain DOM elements held in `rows` Map (steps-ui internal), reachable from the view only via `findRow(container, id)`.

ui/setup-driver.js:
- `startSetup({ onPrompt, onLog, replay, onScreen, onReplayed, onAnswer }, deps)` (310), doc comment 291-309. Single-flight `active` lock; throws `{step:null, message:'startSetup already in progress'}` if one is active (311-313).
- `cancelSetup()` (341-355): sets `cancelPending`, calls `requestCancel` (settleReject with `{ step:null, cancelled:true, message:'setup cancelled', raw }`, 411-417), then awaits `activeDone` bounded by `CANCEL_UNWIND_TIMEOUT_MS` = 6000 (287). Returns false if nothing was running. After the 6s bound it returns anyway, and the next `startSetup` may throw the already-in-progress rejection.
- `ask(prompt)` (425-437): replay matching via `replayedAnswer(entry, prompt)` (359): entry id must equal prompt.id; list entries with `label` are matched by `prompt.options.indexOf(label)`. On match: `pending.shift()`, `onReplayed?.(prompt, answer)`. On non-match: `pending.length = 0`, `await onPrompt(prompt)`. Then ALWAYS `onAnswer?.({ id, kind, answer, ...(label !== undefined && { label }) })` (434-435), so a replayed answer is reported through onAnswer too. `label` for lists is `prompt.options?.[answer]`.
- onReplayed receives the full `prompt` (id, kind, message, options) plus the answer; for list `answer` is a numeric index in the NEW list, for input a string, for confirm a boolean.
- Auto-answered prompts (AUTO_LIST at 87; AUTO_CONFIRM; the `activate` confirm) never reach `ask`, so they are in neither onAnswer nor replay.
- `processChunk` (965-975): `onLog?.(text)` receives the raw decoded chunk (ANSI included, comment at 972), then `onScreen?.(lines)` receives the settled, ANSI-free 30-row viewport. There is no driver event for "profile saved". grep for `saved to global` finds the line only in test frames (setup-driver.test.mjs:851, comment 923); the driver and setup-parse.js do not match it.

### Architecture and Layers Affected

Frontend-only (vanilla ES modules, no framework). Only the view layer (ui/setup-view.js) is in scope. The driver (IPC to the Rust PTY via runner-bridge/pty) is explicitly out of scope. Possibly ui/styles.css for the clickable affordance. No Rust, no config, no IPC change. The setup view is mounted by ui/renderer.js and takes deps `onDone`, `onRun`, `startSetup`, `cancelSetup`, `readConfig`.

### Integration Points

- `deps.startSetup` / `deps.cancelSetup` injection (312-323) is how tests drive the view; any new replay argument rides in the single argument object passed to `startSetup` (886).
- `deps.onRun(inFlight)` fires once per `start()`; callers (renderer/home) treat a retry as a new run, so a replayed restart must still go through `start()`.
- ui/setup-leave.js (748B) and ui/renderer.js consume the view; not read in depth. Speculative: check setup-leave.js for any assumption about `start()` signature.
- ui/failure-panel.js (`renderFailurePanel`, 3.5K) builds the panel; `onPrimary(block)` is the hook. Panel tests in ui/test/failure-panel.test.mjs.

### Patterns and Conventions

- State is closure-scoped inside `createSetupView`, reset in `run()` (846-860).
- Reacting to something on the CLI screen is done as a transition latch in `handleScreen` (failureOnScreen) because rows renumber in the 30-row viewport (comment 279-286).
- A fresh row id per occurrence; transient rows are removed from the DOM directly.
- Row tests find rows by `dataset.id` and use hand-written `.onclick` handlers on stub elements.
- Handlers are assigned as `el.onclick = ...` (home-view.js:62, 141, 208, 217), `addEventListener` only in places where the stub supports it (stub supports both: setup-view.test.mjs `addEventListener` stores one listener per event name, `onclick` setter writes `_listeners.click`).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- .ai-run/guides/architecture/architecture.md, development/development-practices.md, testing/testing-patterns.md, quality-gates.md, project.md, standards/git-workflow.md exist. testing-patterns.md describes `node --test ui/test/*.test.mjs`, `node:test` + `node:assert/strict`, no framework. Quality gates: `npm test`, cargo fmt/clippy/test, build.
- docs/wireframes/02-setup.png is the visual spec cited by the task (not opened; image file).

### Architectural Decisions

- Option B architecture: frontend-brain, thin Rust backend (architecture guide).
- Storage is a fixed-policy answer (setup-driver.js AUTO_LIST, view comment 871-873).
- `SETUP_COMMAND` runs `cd /; codemie setup` with no `--force` (per task; guided setup add-or-update, since 2026-09-23).
- setup-view.js:257-258 and 858-859 are in-code TODO markers naming EPMCDME-14656 as the consumer of `answeredValues`.

### Derived Conventions

- Comments explain WHY with measured dates (e.g. "Measured 2026-09-15").
- Every behavior change has a node:test in ui/test/setup-view.test.mjs using fakes for startSetup/cancelSetup/readConfig; tests use real recorded screens from ui/test/fixtures/setup/*.json for classification.
- Project memory (outside repo) asks for mutation-verified tests; not a repo convention.

---

## 4. Testing Landscape

### Existing Coverage

- ui/test/setup-view.test.mjs (104.9K, about 2200 lines, 84 `test(` blocks). Relevant:
  - 1603: handleReject ignores cancelSetup's own rejection.
  - 1656-1760: failure notice and "Try again" (1722: order assertion `['start','cancel-start','cancel-done','start']`; helpers `failureBlocks`, `panelButton`).
  - 1780: `getAnsweredValues()` holds the latest value per prompt id.
  - ~1839-1844: Try again with cancel counting; 1908-1911: retry starts from empty answeredValues map ("not a mix of two runs"). This assertion encodes the current behaviour that replay work may need to change if `answeredValues` is retained or replaced.
  - 1147 `installYesHarness`, 1223 `runProfileFlow`, 1820 `untilRow`, 2132 area for another Try-again-related test.
- ui/test/setup-driver.test.mjs (116K): replay tests at the end of the file (added in d97d35c, +123 lines); recorded frame with `✔ Profile "walk-check" saved to global config` at 851 and the update-profile recording at 918-938 (`fixture('windows-update-profile')`).
- ui/test/failure-panel.test.mjs, steps-ui.test.mjs (hand-rolled stub origin), setup-leave.test.mjs, home-view.test.mjs (stub with onclick).

### Testing Framework and Patterns

- node:test + assert/strict, run via `npm test` (package.json) or `node --test ui/test/setup-view.test.mjs`.
- DOM stub `makeEl` (setup-view.test.mjs:~39-102): `children`, `nextSibling`, `parentNode`, `querySelector(sel)` that only supports a bare class selector (it strips a leading `.` and matches `_cls`/`className` tokens; so attribute or compound selectors do not work), `appendChild`, `insertBefore`, `classList` (toggle/add/remove/contains over a Set; note `classList._set` is created once per `makeEl` call and shared properly per element), `remove`, `addEventListener` (one listener per event name, overwrites), `onclick` getter/setter, `innerHTML` setter that regex-creates children from `class="..."` of div/button only. `dataset` is a plain object. There is no `getAttribute/setAttribute` (steps-ui or view code calling them would need `?.`; the view uses `spin.setAttribute?.(...)` at 658, showing that convention), no `tabIndex`, no `closest`, no `event` object.
- Fake `startSetup({ onPrompt, ... })` functions in tests call `onPrompt` directly. A fake used for replay tests must itself call `onReplayed`/`onAnswer` the way the driver does, since the view tests do not run the real driver.
- Helpers: `findRowById` (162), `okConfig` (172), `clickContinue`, `tick`, `untilRow`, `failureBlocks`, `panelButton`.

### Coverage Gaps

- No view test covers `onReplayed`, `onAnswer`, row click, or a replay argument to `startSetup` (none of these exist in the view).
- No test of the "profile saved" line in the view.
- No CSS test for a clickable collapsed row (styles are tested only structurally in a few files such as top-banner-style.test.mjs and identity-bar-layout.test.mjs; they read styles.css as text).
- No test covers a click on an answered row while a prompt is open or while the install spinner is running.

---

## 5. Configuration and Environment

### Environment Variables

None used by the setup view or driver in this area.

### Configuration Files

- ui/styles.css, relevant rules: `.step-row` (560-568), `.step-row.active` (569), `.step-row.sub` (570), `.step-title` (580-581), `.step-sub` (583), `#setup-view .step-row.collapsed .step-main/.step-sub/.step-icon` (684-691), `#setup-view .step-row[data-status="COMPLETE"] .step-icon` (~900), `#setup-view .step-sub:empty` (896). There is NO `cursor: pointer` or hover rule for setup-view rows. Precedent for a clickable row exists for Home: `.home-check-list .step-row { cursor: pointer; }` (290) and `... :hover .step-title { color: var(--violet); }` (291), with per-row opt-outs `[data-id="sign-in"] { cursor: default }` (292-295). `.setup-option-card:hover` (615), `.setup-continue-btn:hover` (673) are other setup hover rules.
- `.codemie/codemie-cli.config.json` is modified in the working tree (git status at start); unrelated to this work (project CLI config), not to be committed with it.

### Feature Flags and Deployment Concerns

None. The replay list can contain an API key (secret input prompt answered raw; setup-view.js:227 passes the raw value to the driver and the masked value only to the row). Keep it in view memory only. Check: the driver logs? `grep` of setup-driver.js for log calls on answers was not done in depth; the view has no logger usage in this file (no `log` import found in the grepped symbols).

---

## 6. Risk Indicators

- Speculative: the "profile saved" signal has no driver event. It is only observable through `onScreen(lines)` (settled, ANSI-free; matches the existing transition-latch idiom at 797-822) or `onLog(text)` (raw chunk, ANSI included, chunk boundaries can split the line; onLog is currently a no-op unless `install` is active, 480-481). The saved line stays on screen for several chunks, so a latch that fires once and stays latched until the next `run()` is needed. Rows are also never un-saved: after the line, clicking back must stay disabled for the rest of the run, including after the later "Switch to profile" confirm and resolve.
- Speculative: the `saved` line text depends on the profile name inside quotes and on the Windows/mac recording; matching `✔ Profile ".*" saved to global config` against a 30-row viewport could miss it if the screen scrolls it away before the next chunk; the same scroll hazard documented at 288-295 for Ollama. Both `onScreen` and the saved-line frame in setup-driver.test.mjs:851 show it sitting alongside the name input and the next prompt, so it is visible for at least a couple of chunks, but not proven for every provider.
- Race: a click mid-flight. Clicking a row means `cancelSetup()` then `start(replay)`. The old run's pending `onPrompt` promise (a Promise from `renderControl` that never resolves) is abandoned; the old `handleReject` receives the cancelled rejection and returns early (675), but `run()`'s `catch` in the old run still does `return { ok:false, error: err }` and `.finally(() => inFlight = null)` (835) can null the NEW run's `inFlight` flag if ordering is wrong, because `start()` is called while the old `inFlight` is still set (the Try again path today calls `start()` after `await cancelSetupFn()`, by which time old `run()` has most likely settled, but `cancelSetup` returns after a 6s bound even if it has not). Needs a test and likely a run-generation guard.
- Stale callbacks: after a restart, a late `onLog`/`onScreen`/`onAnswer`/`onPrompt` from the old run could write into the new run's rows/answer list, since all handlers close over shared view state and nothing identifies which run a callback belongs to. The driver's own `settled` guard (processChunk 960-962) lowers but does not eliminate this.
- Answer list identity: `onAnswer` reports replayed answers too, so the view's list after a replayed run equals replay-prefix plus new answers; but the view should not append twice (e.g. from submit and from onAnswer). Also a rejected-then-corrected input appears twice in onAnswer (re-ask); the driver comment (301-305) says the correction after it answers the re-ask, so the list must keep both, in order, and "answers given before the failed step" must be computed by position, not by id (ids repeat on a re-ask: profileName twice, see recorded frames 851-866 with three answers 'codemie','   ','  walk-check ').
- Replay prefix selection: clicking row X must replay answers before X. Rows are keyed by `${id}-${occurrence}`; mapping a row to a position in the onAnswer list needs a per-row index recorded at answer time. Reopen rows (a validation re-ask reuses the row, 551-582) correspond to several answers.
- Replayed rows: `onReplayed(prompt, answer)` gets no `rowId`; the view must create the row itself (same as onPrompt's new-occurrence path: occurrence counters, `baseMessageByPromptId`, `firstAskByPromptId`, insert row, COMPLETE, subtitle, collapse), including the human text: for a list it must be derived from `prompt.options[answer]` (the card title as `renderListControl` would show, see 182-206) and for a secret input the masked value; for confirm 'Yes'/'No'; installClaude has special subtitles ('Skipped', 'Installing…' flow). installClaude=yes replayed would re-run the real install watch, which depends on onLog; replayed answers do not flow through `submit`, so the install row would not complete unless handled (and re-answering yes re-runs the Claude Code install).
- Model/list label drift: replay matches list answers by label; `prompt.options` shape in the driver is the parsed option string (full `"CodeMie SSO - x"` text), so the stored label is that full string; the subtitle shown in a replayed row should be derived the same way as a user-picked row to keep rows identical (task requirement).
- Update flow: `updateProfile`'s `model`/`updateProfile` steps are rejected before onPrompt (689-695); `step` there maps to no row in the answer list.
- Secrets: the `answeredValues` Map (259) and the new answer list hold raw secret values. Do not add them to `getAnsweredValues()` logs, the failure panel `raw` (it prints the CLI screen, where the secret is hidden by the CLI), or any `console.*`. Note `getAnsweredValues()` already returns the raw map (905) -- includes API keys; used only by a test today.
- SSO re-opens the browser on every replayed run (accepted). `waitingForSignIn`/`signInLineSeen` are reset in `run()` (856-857) so replay does not leak them.
- Storage row: id `'storage'`, built outside onPrompt (874-878) and collapsed via the same `collapseRow` (877); a generic "every `.collapsed` row is clickable" selector would include it. Must be excluded explicitly (by id or by not marking it).
- Rows after the clicked step must be removed (no remove primitive: direct `findRow(...).remove()` as at 460) -- but `run()` clears everything with `renderSteps(container, [])` (861), so a restart re-draws the earlier rows from replay. Note `stepsUi` row Map: `renderSteps` clears `rows` (66), so stale row records do not leak. The scroll position and the h1 heading are re-created each run.
- The ACTIVE-row/click interaction: the user could click an earlier row while another prompt is open and while the transient spinner runs (just after submit). Needs a decision on whether clicks are allowed during install spinner or the SSO wait.
- Test impact: existing assertion at setup-view.test.mjs:1908-1911 (`getAnsweredValues().size === 0` after retry) and the 1780 test relate to `answeredValues`; changing that map's semantics will require updating them.
- CSS: no clickable styling or focus affordance for setup rows; steps-ui rows are `div`s without role/tabindex, so keyboard access would be new. The `.step-row { overflow: hidden }` and `.collapsed` flex layout (684-691) need a hover rule that does not shift layout.
- No external docs or ADR for replay beyond the code comments and the d97d35c commit.

---

## 7. Summary for Complexity Assessment

The change is confined to the view layer: ui/setup-view.js (906 lines, one `createSetupView` closure) plus a few CSS rules in ui/styles.css and new tests in ui/test/setup-view.test.mjs. The driver already supplies `replay`, `onReplayed`, `onAnswer` and `cancelSetup` (setup-driver.js:310, 341, 425-437) and needs no change; the view wires none of them yet (`run()` passes only onPrompt/onLog/onScreen at line 886). Needed view surface is: record the onAnswer list, build rows from `onReplayed` that match user-answered rows, make non-storage collapsed rows clickable, pass a replay prefix to `startSetup` from a row click and from Try again (non-recoverable path, line 789), and stop clickability once the saved-profile line appears. There is no driver event for the saved line; the observable points are `onScreen(lines)` (settled, ANSI-free, existing latch idiom) and `onLog(text)` (raw chunks).

The code is not novel: it follows existing patterns (closure state reset in `run()`, transition latch in handleScreen, DOM-direct row removal, `deps` injection). Complexity comes from state coupling: row ids per occurrence, reopen rows reusing a row for several answers, repeated prompt ids in the answer list, rows created outside `submit` (replayed), installClaude's onLog-driven row, and run-boundary races between cancelSetup and the next start (stale callbacks, `inFlight` clearing, 6s cancel bound). Failed-step identification already exists in `handleReject` (`err.step`, 676-712) but `step` can be null and `model`/`updateProfile` failures have no onPrompt row.

Test posture is good for the surrounding behaviour (84 view tests, DOM stub, injected fakes, recorded fixtures) but there is nothing for replay in the view; new tests must make fakes emulate the driver's onReplayed/onAnswer calls. The DOM stub's `querySelector` only supports a bare class selector and has no attributes API, which constrains how clickability can be implemented and tested. Existing tests asserting `answeredValues` semantics (setup-view.test.mjs:1780, 1908-1911) may need adjusting. Risk factors: stale-run callbacks, secret handling in the in-memory replay list, and the unverified assumption that the saved line is reliably visible on a settled screen for every provider.

---

## 8. External References

None named by the task. (docs/wireframes/02-setup.png is a repo file named in the task; it was not opened in this run, its content is only known from the task's own description: "answered steps collapse to a line you can click back into".)
