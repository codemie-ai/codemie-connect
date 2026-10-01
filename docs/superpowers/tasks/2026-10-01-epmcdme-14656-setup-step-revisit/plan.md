# EPMCDME-14656 Setup step revisit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Let the user click an answered guided-setup row to restart the run at that step, and make Try again resume from the failed step, using the driver's existing replay.

**Architecture:** View-only. `createSetupView` keeps the run's `onAnswer` list in memory, records for each row the list position at which it opened, and restarts with `cancelSetup()` then `startSetup({ replay })` for a prefix of that list. A run-generation counter drops late callbacks from a cancelled run. A `profileSaved` latch, set when the CLI prints the saved line, disables both row clicks and replay for the rest of the run.

**Tech Stack:** vanilla ES modules, node:test with the DOM stub in `ui/test/setup-view.test.mjs`.

**Spec:** requirements inline in the task brief; research in `technical-analysis.md` (same directory).

Commit per task using the repository's existing convention (`EPMCDME-14656 : subject` plus a short body). Never stage `.codemie/codemie-cli.config.json`; no Co-Authored-By line.

## Acceptance criteria

- Collapsed answered rows (not the storage row) are clickable and keyboard-operable; clicking one reopens that step with all earlier answers replayed and later steps pending.
- Try again after a run-ending failure replays the answers given before the failed step (all answers when the step is unknown), except after the profile was saved: then it starts fresh with no replay.
- Replayed steps look identical to user-answered rows; a replayed installClaude never re-runs the install.
- After `✔ Profile "<name>" saved to global config` appears, rows are no longer clickable for the rest of the run.
- Only one `codemie setup` process runs at a time; clicks during a restart are ignored; a cancelled run cannot touch the new run.
- Answers (which may hold an API key) are never logged or persisted.
- `ui/setup-driver.js` is unchanged; `SETUP_COMMAND` is unchanged.

## Global Constraints

- Do not edit `ui/setup-driver.js`. Keep `cd /; codemie setup` (no `--force`).
- Answer list: memory only, never logged, never persisted, never exposed.
- Storage row (`id 'storage'`) is never clickable.
- Once the saved line has been seen in a run, nothing replays: Try again passes `replay: []`. Replaying would resend the profile name, the CLI would reject it as taken, and a second profile would be created.
- Assumption (simplest safe rule): rows are clickable only while a prompt is open or after the run has failed. Not during the install spinner, the "Working..." gap or the SSO wait. One boolean (`revisitOpen`) implements it.
- Assumption: a replay prefix is cut at the first `installClaude` entry. The driver then asks that prompt live (replay ends at the first non-match), so a replayed yes can never start a real install. Rows after it are asked again.
- SSO reopens the browser each run: expected, no workaround.

## Review Focus

- Re-asked input (validation reject): `profileName` appears twice in the answer list; the prefix is by position, not id.
- Click on a row whose prompt was re-asked: it replays answers before the row's first ask.
- Failure with `err.step` null, or `model`/`updateProfile` (no row in the list): replay all answered.
- Failure after the profile was saved: Try again starts fresh, never replays.
- Slow cancel: the old run's `.finally` must not clear the new run's `inFlight`.
- Saved line that has scrolled out of the viewport: latch must stay set.

## File map

- Modify `ui/setup-view.js` (all logic), `ui/styles.css` (clickable affordance), `ui/test/setup-view.test.mjs`.

### Task 1: Record answers, saved latch, replayed rows, restart with replay

**Files:**
- Modify: `ui/setup-view.js:247-262` (replace `answeredValues` with `answers` and `rowAnswerIndex`), `:480` (`onLog`), `:497-517` (drop `answeredValues.set`), `:584-599` (extract), `:778-791` (Try again), `:797-822` (`handleScreen`), `:832-860` (start/run), `:886` (callbacks), `:905` (drop `getAnsweredValues`)
- Test: `ui/test/setup-view.test.mjs` (rewrite the tests near 1780 and 1908-1911)

**Interfaces:**
- Produces: `profileSaved` (boolean, reset only in `run`), set by `/Profile ".*" saved to global config/` tested on `lines.join('\n')` in `handleScreen` and on the raw chunk at the top of `onLog` (before the `install` early return).
- Produces: `startRun(replay)` (always launches, bumps `generation`), `start()` (unchanged public behavior: returns in-flight run or `startRun([])`), `restart(replay)` (async, awaits `cancelSetupFn()` then `startRun(replay)`; returns early while `restarting`), `replayPrefix(rowId | null)` (copy of `answers` before that row's index, whole list for null or unknown row, cut at the first `installClaude`, `[]` when `profileSaved`), `beginOccurrence(prompt)` (the new-occurrence lines of `onPrompt`, returns `rowId`, records `rowAnswerIndex.set(rowId, answers.length)`).
- Remove `getAnsweredValues` from the returned object.

- [ ] **Step 1: Write failing tests** (fakes call `onReplayed`/`onAnswer` the way the driver does, per `setup-driver.js:425-437`):
  1. `try again replays answers given before the failed step`: fake run answers provider, then rejects `{step:'codemieProject'}` after its prompt opens; click Try again; second `startSetup` receives `replay` equal to `[{id:'provider',answer,label}]`.
  2. `try again with unknown step replays every answer`: reject with `step:null`; replay equals the full list.
  3. `try again after the profile was saved starts fresh`: fake answers provider, calls `onScreen` with a frame containing `✔ Profile "x" saved to global config`, then rejects; click Try again; second `startSetup` receives `replay: []`.
  4. `replayed prompt renders an answered row identical to a user-answered one`: fake calls `onReplayed(listPrompt, 1)` then `onAnswer`; the row has status COMPLETE, class `collapsed`, same collapsed title and subtitle as in the existing user-answered list test.
  5. `replay is cut at installClaude`: list with provider then installClaude=true; second start's `replay` has only the provider entry.
  6. `old run's late callbacks and finally do not touch the new run`: start, restart with a fake whose first run settles late; call old `onPrompt`/`onAnswer` after the restart (no row added, list unchanged), settle the old run, assert `start()` still returns the new run (new `inFlight` not cleared).
- [ ] **Step 2: Run** `node --test ui/test/setup-view.test.mjs`; expect the new tests to fail. The old `answeredValues` tests fail against the removed API, so rewrite them in this step: 1780 asserts the answer list through the next start's `replay` argument; 1908-1911 asserts a plain `start()` passes `replay: []`.
- [ ] **Step 3: Implement.**
  - `answers = []`, `rowAnswerIndex = new Map()` (both reset in `run`), `generation`, `restarting`, `retryReplay`, `profileSaved`.
  - In `run(replay, gen)` pass `{ onPrompt, onLog, onScreen, onReplayed, onAnswer, replay }` to `startSetup`, each wrapped so a stale `gen !== generation` call is a no-op; a stale `onPrompt` returns a never-settling promise. `onAnswer(e)` pushes `{...e}`. `onReplayed(prompt, answer)`: `hideTransientSpinner()`, `beginOccurrence(prompt)`, set COMPLETE and the subtitle from `subtitleFor(prompt, answer)` (list: `renderOptionCards(prompt.options, {})[answer].title`, confirm: Yes/No, input: `maskSecret` for a secret prompt else the value, the same strings the three `render*Control` functions pass to `submit`), `collapseRow`, `showTransientSpinner()`.
  - `start()` and `startRun` per Interfaces: `const p = run(...).finally(() => { if (inFlight === p) inFlight = null; })`, then `deps.onRun?.(p)`.
  - `handleReject`: compute `retryReplay = replayPrefix(failedRowId)` where `failedRowId` is `latestOccurrenceRowId(step)` only when `step` is in `occurrenceCounts` (else null, meaning all); `replayPrefix` already returns `[]` once `profileSaved`. The non-recoverable `onPrimary` becomes `block.remove(); restart(retryReplay)`; the recoverable path is unchanged.
  - Update the comments at 257-258 and 858-859 to match.
- [ ] **Step 4: Run** `node --test ui/test/setup-view.test.mjs`; expect PASS.
- [ ] **Step 5: Mutation-check, then commit.** Delete each mechanism in turn (replay argument, the `profileSaved` check in `replayPrefix`, `onReplayed` row, installClaude cut, generation guard, the `inFlight === p` check); each time exactly the matching test fails. Restore and commit.

Test-first: yes — `try again replays answers given before the failed step` fails because `startSetup` is called with no `replay`.

### Task 2: Clickable answered rows and styles

**Files:**
- Modify: `ui/setup-view.js` (`submit` 498-517, `finishInstall` 471-478, `onPrompt`, `handleReject`; new `makeRevisitable`, `revisit`, `syncRevisit`), `ui/styles.css` (near `#setup-view .step-row.collapsed`, ~684-691; precedent `.home-check-list .step-row` at 290-295)
- Test: `ui/test/setup-view.test.mjs`

**Interfaces:**
- Consumes: `restart`, `replayPrefix`, `rowAnswerIndex`, `profileSaved` from Task 1.
- Produces: `revisitOpen` flag; `makeRevisitable(rowId)`; `revisit(rowId)` = no-op unless `revisitOpen && !profileSaved && !restarting`, else `restart(replayPrefix(rowId))`; `syncRevisit()` toggles class `can-revisit` on `container`.

- [ ] **Step 1: Write failing tests:**
  1. `clicking an answered row restarts with the answers before it`: answer provider, project, model (one input re-asked so an id repeats in the list); click the project row; assert order `cancel`, then `start` with `replay` holding only the provider entry (by position).
  2. `storage row has no click handler`.
  3. `rows are not clickable while the install spinner or Working gap shows`: after submit, a click does not call `cancelSetup`.
  4. `row Enter and Space activate the row like a click` (stub `addEventListener('keydown')`, `tabIndex` 0).
  5. `profile saved line turns rows off`: `onScreen` with the saved line, then a later `onScreen` without it; click does nothing.
  6. `a click during a restart is ignored`: cancel fake held pending; two clicks yield one `cancelSetup` and one `startSetup`.
  7. `rows before the failed step stay clickable after a failure`.
- [ ] **Step 2: Run** the file; expect those tests to fail.
- [ ] **Step 3: Implement.** `makeRevisitable(rowId)` runs where a row collapses with an answer (`submit`'s non-install branch, `finishInstall`, `onReplayed`); it sets `row.onclick`, `tabIndex = 0`, `setAttribute?.('role','button')`, a keydown listener for Enter and Space calling `revisit`, and adds class `revisit`. Never call it for `storage`. `revisitOpen = true` in `onPrompt` (both paths) and `handleReject`; `false` in `submit`, `restart`, and at `run` start. Call `syncRevisit()` on every flag change, including when `profileSaved` is set (hook it in Task 1's detection). CSS: `#setup-view.can-revisit .step-row.revisit { cursor: pointer; }`, hover colors the title with `var(--violet)` without shifting layout, `:focus-visible` outline.
- [ ] **Step 4: Run** `node --test ui/test/setup-view.test.mjs`; expect PASS.
- [ ] **Step 5: Mutation-check, then commit.** Remove each of: the `profileSaved` check in `revisit`, the `restarting` check, the `revisitOpen` check, the storage exclusion, the keydown listener; exactly one test fails per removal.

Test-first: yes — `clicking an answered row restarts with the answers before it` fails because rows have no click handler.

## Negative-constraint pass

- Driver must not change: no task touches `ui/setup-driver.js`.
- Keep `SETUP_COMMAND` (no `--force`): untouched.
- Storage row not clickable: Task 2 test 2.
- Never log or persist answers: `answeredValues`/`getAnsweredValues` removed, list is closure-local (Task 1).
- Replayed installClaude must not re-run a real install: cut at `installClaude` (Task 1 test 5).
- No second profile after save: row latch (Task 2 test 5) and Try again starting fresh with `replay: []` (Task 1 test 3).
- One process at a time, no stale-run effects: `restart` awaits cancel, generation guard (Task 1 test 6, Task 2 test 6).
- SSO browser reopen: no workaround planned.
- Do not stage `.codemie/codemie-cli.config.json`; no Co-Authored-By.
