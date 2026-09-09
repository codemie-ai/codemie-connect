# EPMCDME-14513: Guided Setup, setup-view UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `codemie setup`'s live list/input/confirm prompt sequence inside `setup-view`, driven entirely by the already-landed `ui/setup-driver.js`, with no PTY/parser/driver changes.

**Architecture:** One new ES module, `ui/setup-view.js`, exporting `createSetupView(container, deps)` → `{ start() }`. It owns a private `createStepsUi()` instance, wires `startSetup({ onPrompt, onLog })`'s callbacks to row insertion/reopen/control rendering, and verifies success via `deps.readConfig()`. Wired into `ui/renderer.js`'s existing `CODEMIE_DEV` block as `window.__codemie.startGuidedSetup`.

**Tech Stack:** Vanilla ES modules, no bundler, `node --test` + `node:assert/strict`, hand-rolled DOM stubs (no jsdom).

**Spec:** `docs/superpowers/tasks/2026-09-09-epmcdme-14513-setup-view-ui/spec.md`

Commit per task using the repository's existing convention.

## Global Constraints

- No changes to `ui/setup-driver.js`, `ui/steps-ui.js`, `ui/models.js`, or the legacy wizard/engine.
- No new Rust/IPC. No new `StepStatus` values.
- No sidebar/Home entry, no Back button, no progress-dot indicator, no failure-detail UI beyond marking a row ERROR, no resume/replay.
- `storage` is inserted positionally before `startSetup` is called, collapsed/COMPLETE, value "This computer"; `gate` and `activate` are never rendered, in any state.
- Row ids are `<promptId>-<occurrence>` (e.g. `credential-1`), never the bare prompt id.
- The legacy wizard's `.step-row` block (`ui/styles.css:489-512`, verified directly — `.step-row`, `.step-row.active`, `.step-row.sub`, `.step-progress`, `.step-main`, `.step-icon`, `.step-title`, `.step-row.active .step-title`, `.step-sub`; the unrelated `.approval`/`.stamp` rules start at line 514) already applies to this view's rows too, since both consume the same `ui/steps-ui.js` row-building primitive — do not edit those rules. New markup this ticket introduces (option cards, Continue button, the collapsed-row layout) gets new, separately-scoped selectors added alongside the block, never inside it.

---

### Task 1: Module skeleton, storage row, one-shot round trip per prompt kind

**Files:**
- Create: `ui/setup-view.js`
- Create: `ui/test/setup-view.test.mjs`

**Interfaces:**
- Produces: `export function createSetupView(container, deps = {}) { ... return { start }; }` where `start(): Promise<void>`. `deps.startSetup` defaults via lazy `import('./setup-driver.js')`; `deps.readConfig` defaults via lazy `import('./runner-bridge.js')`'s `codemieConfig.read`.
- Consumes: `createStepsUi()` (`ui/steps-ui.js:13`) → `{ renderSteps, setStatus, setSubtitle, insertSubStep, ... }`; `StepStatus` (`ui/models.js:3`).

Test-first: yes — write `setup-view.test.mjs` first, asserting: (a) calling `start()` inserts a `storage` row collapsed/COMPLETE with subtitle "This computer" before the fake `startSetup` is invoked; (b) no `gate` or `activate` row ever appears; (c) for each of a fake `list`, `input`, `confirm` prompt fed through a fake `onPrompt`, a new row `<id>-1` appears ACTIVE with the expected control, and submitting it resolves the prompt with the driver's expected shape (index/string/boolean) and sets the row COMPLETE with the human-readable subtitle.

- [ ] Write the failing test per above, using `steps-ui.test.mjs`'s hand-rolled DOM stub (`makeEl`/`findByClass`) and `setup-driver.test.mjs`'s injected-`deps` fake-driver idiom — fake `deps.startSetup` that calls the real `onPrompt` argument itself rather than spawning anything.
- [ ] Run `node --test ui/test/setup-view.test.mjs`; confirm FAIL (`createSetupView` not defined).
- [ ] Implement `createSetupView`: call `stepsUi.renderSteps(container, [])` once to bind the container, insert the `storage` row via `insertSubStep(null, { id: 'storage', title: 'Where to store it', ... })` then `setStatus('storage','COMPLETE')`/`setSubtitle('storage','This computer')`, track an occurrence counter map (`Map<promptId, count>`), and in `onPrompt(prompt)` insert a new row `${prompt.id}-${nextOccurrence}`, render a generic control per `prompt.kind` (list: radio buttons over `prompt.options`; input: text field; confirm: Yes/No, Yes pre-selected — copy/markup refined by Task 4), and on submit resolve with the index/string/boolean the driver expects, then `setStatus(...,'COMPLETE')` + `setSubtitle`.
- [ ] Run the test; confirm PASS.
- [ ] Commit.

---

### Task 2: Row title/default derivation, occurrence naming, reopen-vs-new-row

**Files:**
- Modify: `ui/setup-view.js` (add `deriveRowTitle`, `stableQuestion`-equivalent, occurrence-tracking helpers)
- Modify: `ui/test/setup-view.test.mjs`

**Interfaces:**
- Produces: `deriveRowTitle(message): { title, defaultValue }` — strips `ui/setup-driver.js:108`'s `DEFAULT_HINT` pattern (`/\s*\([^()]*\)\s*$/`), independently re-declared here (do not import), then strips a trailing colon; the hint's inner text becomes `defaultValue` (empty if no hint). Produces an internal `stripHint(message)` helper (same regex) used by the reopen comparison — reused, not re-derived, in Task 3.
- Consumes: nothing new.

Test-first: yes — assert `"CodeMie organization URL: (https://codemie.lab.epam.com)"` → `{ title: "CodeMie organization URL", defaultValue: "https://codemie.lab.epam.com" }`; a hint-less `credential` message strips only its trailing colon with empty `defaultValue`. Reopen comparison: use the real driver strings — first ask `"Enter a name for this profile: (sso)"`, re-ask `"Enter a name for this profile: taken"` (inquirer drops the hint and appends the rejected input once the field is re-asked) — assert these two, after both are run through `stripHint`, are recognized as the *same* row reopening (stripped forms are `"Enter a name for this profile:"` and `"Enter a name for this profile: taken"`, and the second starts-with the first once colon-stripped too — compare on the hint-stripped strings, not the raw messages). Also assert: a byte-identical hint-stripped message (the masked-password case) reopens; a same-id but different hint-stripped message inserts a new occurrence row. **Double-rejection test:** the same row is rejected twice in a row (e.g. `"Enter a name for this profile: taken"` then, on a second rejection, `"Enter a name for this profile: taken2"`) — assert the stored comparison base used to recognize the reopen is **never advanced** past the original first-ask question (mirroring `setup-driver.js:519-524`'s own `if (!reAnswer) lastAnsweredInput = ...` — the stored base updates only when the incoming message did *not* count as a re-answer), and that after both rejections there is still exactly **one** row for that prompt id, not two.

- [ ] Write the failing tests above.
- [ ] Run `node --test ui/test/setup-view.test.mjs`; confirm FAIL.
- [ ] Implement `deriveRowTitle`/`stripHint` and a `baseMessageByPromptId: Map<id,string>` (storing the **hint-stripped, original-ask** message — never overwritten by a recognized reopen, only set the first time a prompt id is seen or when a genuinely new/different message arrives) used to decide reopen vs. new-row: same id AND (`stripHint(newMessage) === storedBase` OR `stripHint(newMessage).startsWith(storedBase)`) → reopen latest occurrence row for that id, clearing its old subtitle by touching the DOM node directly (bypassing `setSubtitle`, which ignores empty strings, `ui/steps-ui.js:70-73`), **and leave `storedBase` unchanged** so a third, fourth, etc. rejection still compares against the original; otherwise treat as new occurrence and set `storedBase` to this message's hint-stripped form. Wire `deriveRowTitle` into the `input`-kind control from Task 1 (title + pre-filled default).
- [ ] Run the test; confirm PASS.
- [ ] Commit.

---

### Task 3: Provider/model option-card string parsing

**Files:**
- Modify: `ui/setup-view.js` (add `renderOptionCards`)
- Modify: `ui/test/setup-view.test.mjs`

**Interfaces:**
- Produces: `renderOptionCards(options, { badgeIndex } = {})` → array of `{ title, description, recommended }`, used by the `list`-kind control.

Test-first: yes — assert an option string `"CodeMie SSO - Enterprise SSO Authentication with centralized model management"` splits at the *first* `" - "` into title/description. Model fixtures: use the **real** parsed strings from `ui/test/fixtures/setup/model.json` — the recommended entry is `"❯ ⭐ claude-sonnet-5 "` (line 16) before parser trimming; after cursor/whitespace trimming (already `setup-parse.js`'s job, not this module's) the string this module receives is `"⭐ claude-sonnet-5"`. Assert `"⭐ claude-sonnet-5"` strips the leading `"⭐ "` to title `"claude-sonnet-5"` with `recommended: true`; the fixture's own plain, non-recommended entry `"claude-4-5-sonnet"` (line 17, `"  claude-4-5-sonnet "` after trim/parse) has `recommended: false` and no star to strip. For a `provider` prompt (`prompt.id === 'provider'`) index 0 is badged `recommended` regardless of star; for `model` the badge follows the star only, never the index.
- [ ] Write the failing tests above.
- [ ] Run `node --test ui/test/setup-view.test.mjs`; confirm FAIL.
- [ ] Implement `renderOptionCards`, splitting at the first `" - "` (`indexOf`, not a regex, to keep "first occurrence" unambiguous) and the `/^⭐\s*/` strip; call it from the `list`-kind control path, passing `badgeIndex: 0` only when `prompt.id === 'provider'`.
- [ ] Run the test; confirm PASS.
- [ ] Commit.

---

### Task 4: Layout and copy — header, collapsed row shape, helper lines, option-card markup, Continue button

**Files:**
- Modify: `ui/setup-view.js` (mount-time header render, `PROMPT_COPY` table and lookup, option-card DOM, Continue-button control, collapsed-row class toggle)
- Modify: `ui/styles.css` (new selectors only, added alongside — never inside — the existing `.step-row` block at lines 489-512)
- Modify: `ui/test/setup-view.test.mjs`

**Interfaces:**
- Produces: a "Set up CodeMie" heading element, rendered once when `createSetupView`'s returned `start()` first mounts (before the `storage` row is inserted).
- Produces: `PROMPT_COPY: { provider: { heading: 'How should CodeMie reach a model?', helper: 'You can change this later.', collapsedLabel: 'How to reach a model' }, codemieProject: { collapsedLabel: 'CodeMie project' }, model: { heading: 'Which model?', helper: 'These are the models your account can use.', collapsedLabel: 'Model' }, profileName: { heading: 'Profile name', collapsedLabel: 'Profile name' }, installClaude: { collapsedLabel: 'Claude Code' } }` (id `codemieProject` confirmed directly against `ui/setup-parse.js:22`'s `PROMPTS` table). `storage` keeps the fixed copy already implemented in Task 1. Every prompt id **not** in this table (`codemieUrl`, `credential`, any other) falls back to `deriveRowTitle` from Task 2 — this table only overrides the wireframe's named steps, never replaces the general rule.
- Produces: option-card markup (title + description per `renderOptionCards` entry, a "recommended" badge element, never literal text in the title/description) and a Continue button per active row that submits the currently-selected card (list) or entered/default value (input).
- Produces: a `collapsed` class (or equivalent chosen name) added to a row's element the moment that row reaches COMPLETE — a plain DOM class toggle on top of `steps-ui.js`'s existing row, not a `steps-ui.js` change. New CSS scoped under `#setup-view .step-row.collapsed ...` (exact selector prefix TBD at implementation, but must be scoped to this view, never the bare `.step-row` selector) inlines `.step-sub` onto the same line as `.step-title` instead of stacking, bolds the subtitle/value text, and moves the status icon to the row's right side for the collapsed state only — matching the wireframe's "label — **value** ✓" shape.
- `installClaude`'s collapsed line reads label + value, e.g. "Claude Code — v1.2.3" (answered yes, version captured by Task 6) or "Claude Code — Skipped" (answered no), consistent with every other collapsed row's label + value shape.

Test-first: yes — assert the "Set up CodeMie" header renders once at mount, before the `storage` row exists. Assert the `provider` row renders heading "How should CodeMie reach a model?" and helper "You can change this later.", and once answered collapses with label "How to reach a model"; the `model` row renders heading "Which model?" and helper "These are the models your account can use.", and collapses with label "Model" (and that this is never swapped with the provider's "How to reach a model" label). Assert a row for a prompt id outside the table (e.g. `credential`) falls back to `deriveRowTitle`'s message-derived title, proving the table is an override, not a takeover. Assert a COMPLETE row carries the `collapsed` class (or chosen name) and a PENDING/ACTIVE row does not. A Continue-button test: for an active `list` row with a card selected, clicking Continue resolves the prompt with that card's index; for an active `input` row with a typed value, clicking Continue resolves with that string.

- [ ] Write the failing tests above.
- [ ] Run `node --test ui/test/setup-view.test.mjs`; confirm FAIL.
- [ ] Implement the header render, `PROMPT_COPY` lookup (checked before falling back to `deriveRowTitle`), the option-card DOM (title/description/badge) built from Task 3's `renderOptionCards` output, the Continue button reading current selection/input state on click, and the `collapsed` class toggle applied wherever a row's status transitions to COMPLETE. Add new CSS selectors scoped to this view (e.g. `.setup-option-card`, `.setup-option-card.recommended`, `.setup-continue-btn`, `#setup-view .step-row.collapsed .step-sub`, `#setup-view .step-row.collapsed .step-icon`) in `ui/styles.css` alongside — not inside — the existing `.step-row` block (re-verify the exact current range, 489-512, before editing, in case earlier tasks in this plan shifted it).
- [ ] Run the test; confirm PASS.
- [ ] Commit.

---

### Task 5: Transient "Working…" spinner for automatic no-prompt gaps

**Files:**
- Modify: `ui/setup-view.js` (add spinner insert/remove around each automatic phase, including at flow start; coordinate ordering with Task 7's rejection mapping)
- Modify: `ui/test/setup-view.test.mjs`

**Interfaces:**
- Produces: internal `showTransientSpinner()` / `hideTransientSpinner()`. Called (a) immediately after `start()` calls `deps.startSetup(...)`, before the first `onPrompt` arrives, so the screen never sits with only the collapsed `storage` row and nothing indicating activity; and (b) after any row completes, until the next `onPrompt` fires or `startSetup` settles.
- **Ordering with Task 7 on rejection (must not contradict it):** on `startSetup`'s rejection path, run Task 7's `handleReject` mapping **first**. Only afterward does this task's hide logic run, and only conditionally — hide/remove the transient spinner row unless `handleReject` itself converted that same transient row into the ERROR indicator (the `step: null`-with-no-ACTIVE-row case). If the transient row was the one marked ERROR, leave it visible; do not hide it out from under the mapping. On the **success** path (resolution), hide/remove the transient spinner unconditionally first, before/as part of `handleResolve` — nothing needs to remain in a transient state after a successful resolution.

Test-first: yes — assert a spinner row appears right after `start()` invokes the fake `startSetup`, before any `onPrompt` call; assert it disappears the moment the first `onPrompt` fires. Assert a spinner row appears after a later completed step while no next prompt has arrived yet, and disappears the moment the fake driver's `onPrompt` fires again. Assert it is **never** inserted after an `installClaude` "yes" answer (stub that row as already ACTIVE and confirm no second spinner row appears). Assert on **success** (resolution) the spinner is gone. Assert on **rejection with `step: null` and no other row ACTIVE** (the transient spinner showing at the time), the transient row is **not** hidden by this task's logic — it remains, now marked ERROR by Task 7's mapping (cross-checked by Task 7's own test in that task).

- [ ] Write the failing tests above.
- [ ] Run `node --test ui/test/setup-view.test.mjs`; confirm FAIL.
- [ ] Implement: call `showTransientSpinner()` right after invoking `deps.startSetup(...)` and after any row's control resolves and sets COMPLETE, unless the just-completed row was `installClaude` answered "yes"; `onPrompt`'s entry point calls `hideTransientSpinner()` first thing. On `start()`'s overall settle: for **resolution**, call `hideTransientSpinner()` then run `handleResolve`. For **rejection**, run `handleReject` (Task 7) first, then call `hideTransientSpinner()` only if the transient row was not the one `handleReject` marked ERROR.
- [ ] Run the test; confirm PASS.
- [ ] Commit.

---

### Task 6: `installClaude` row driven by `onLog`

**Files:**
- Modify: `ui/setup-view.js` (add `wireInstallClaudeLog`)
- Modify: `ui/test/setup-view.test.mjs`

**Interfaces:**
- Produces: internal `onLog` handler, active only once the `installClaude` confirm has been answered "yes"; maintains a running text buffer for that row and matches against the accumulated buffer (never a single chunk in isolation), tolerant of ANSI escape sequences wrapped around or interleaved with the target phrase. Success match: `/Claude Code(\s+v\S+)?\s+installed successfully/` against the ANSI-stripped buffer (strip ANSI via a simple `/\x1b\[[0-9;]*m/g` replace before matching, since `onLog` passes the raw/lightly-processed PTY chunk through — verified against the vendored CLI, `assets/codemie-cli/node_modules/@codemieai/code/dist/cli/commands/setup.js:717,727-728,737`: `ora`/`chalk` wrap the success and failure lines in color codes, and the version suffix is conditionally empty). Subtitle is the captured version (e.g. `"v1.2.3"`) when present, else `"Installed"`. Collapsed label is `PROMPT_COPY.installClaude.collapsedLabel` ("Claude Code", from Task 4), so the finished line reads "Claude Code — v1.2.3" or "Claude Code — Installed"/"Claude Code — Skipped".

Test-first: yes — assert: answering `installClaude` "no" marks the row COMPLETE/"Skipped" immediately with no `onLog` involvement (collapsed line "Claude Code — Skipped"); answering "yes" leaves it ACTIVE with a spinner and inserts no generic transient spinner (covered by Task 5's negative case); feeding `onLog` two chunks that together spell `"Installing Claude Code (supported version)..."` split mid-word moves the row to ACTIVE-with-spinner (already is); feeding the success line **with** a version, chunked and ANSI-wrapped (`"\x1b[32mClaude Code v1.2.3 installed successfully\x1b[0m"` split across two `onLog` calls) sets COMPLETE with subtitle `"v1.2.3"` (collapsed line "Claude Code — v1.2.3"); feeding the success line **without** a version (`"Claude Code installed successfully"`, no ANSI) sets COMPLETE with subtitle `"Installed"`; feeding the failure line `"Failed to install Claude Code"` (ANSI-wrapped) sets ERROR; if `start()`'s overall promise settles while this row is still ACTIVE and none of the three trigger lines ever matched, the row is forced ERROR (safety net).

- [ ] Write the failing tests above.
- [ ] Run `node --test ui/test/setup-view.test.mjs`; confirm FAIL.
- [ ] Implement: on the `installClaude` confirm resolving `true`, register an `onLog` buffer-append-and-strip-ANSI-and-match callback for that row only (this is the only row that ever reads `onLog`); on `start()`'s settle path, check this row's terminal state and force ERROR if still ACTIVE.
- [ ] Run the test; confirm PASS.
- [ ] Commit.

---

### Task 7: Success/failure resolution mapping

**Files:**
- Modify: `ui/setup-view.js` (add `handleResolve`, `handleReject`)
- Modify: `ui/test/setup-view.test.mjs`

**Interfaces:**
- Consumes: `deps.readConfig()` → `Promise<{ state, profile, model, project, account }>` (`ui/runner-bridge.js:52`, backed by `src-tauri/src/commands/codemie_config.rs:110`, never rejects).
- **Ordering with Task 5 (must not contradict it):** `handleReject` runs *before* Task 5's transient-spinner hide on the rejection path (see Task 5). When the incoming rejection is `step === null` and no row is currently ACTIVE, the row `handleReject` marks ERROR **is the transient spinner row itself** (converted in place to an ERROR row, not hidden then re-created) — this is the only branch where the "row currently ACTIVE" and "transient spinner row" cases overlap, and Task 5 must leave that row alone afterward.

Test-first: yes — assert: on `{ profileName }` resolution, `state === 'valid' && profile === profileName` is treated as success (no row changes beyond what's already COMPLETE); a mismatch marks the *last* rendered row ERROR; on rejection `{ step, message, raw }`: a `step` matching a rendered prompt id marks the **latest occurrence row for that id** ERROR (not a bare-id lookup); `step === 'model'` with no model row yet inserted inserts a new `model-1` row directly in ERROR state; `step === null` with some OTHER row currently ACTIVE marks that ACTIVE row ERROR. **New test:** `step === null` occurring during an automatic no-prompt gap (no other row currently ACTIVE, only the transient spinner showing) results in exactly **one** ERROR row visible on screen afterward — the transient row itself, now marked ERROR — not zero rows, not two (i.e., Task 5's hide logic must not also remove it).

- [ ] Write the failing tests above.
- [ ] Run `node --test ui/test/setup-view.test.mjs`; confirm FAIL.
- [ ] Implement `handleResolve`/`handleReject` and wire them to `start()`'s `deps.startSetup(...).then(handleResolve, handleReject)`, with `handleReject` running before Task 5's conditional spinner-hide as described above.
- [ ] Run the test; confirm PASS.
- [ ] Commit.

---

### Task 8: Wire the dev hook

**Files:**
- Modify: `ui/renderer.js:488-491` (the existing `if (flags.dev) { const { startSetup } = await import('./setup-driver.js'); window.__codemie = { showView, startSetup }; }` block, verified directly at these line numbers)

**Interfaces:**
- Consumes: `createSetupView` (Task 1).

Test-first: no — this is a two-line addition to an existing devtools-only hook with no test harness of its own (`ui/renderer.js` has no `*.test.mjs` covering `boot()`'s dev block); manual verification is the calling flow's job, not this task's.

- [ ] Add, inside the existing `if (flags.dev) { const { startSetup } = await import('./setup-driver.js'); ... }` block: `const { createSetupView } = await import('./setup-view.js');` and extend the `window.__codemie = { showView, startSetup, ... }` object literal with `startGuidedSetup: () => { showView('setup'); return createSetupView(document.getElementById('setup-view')).start(); }`. Leave the existing `showView`/`startSetup` entries untouched.
- [ ] Commit.

---

### Task 9: Mutation-verify pass

**Depends on:** Tasks 1-8 complete.

**Files:** none (verification only; a discovered gap gets fixed in `ui/setup-view.js` / `ui/test/setup-view.test.mjs` as part of this task, then re-verified).

Test-first: no — this task's whole job is running the existing test suite under deliberate mutation, not writing new production code from a failing test.

For each mechanism below, remove it from `ui/setup-view.js` one at a time, re-run `node --test ui/test/setup-view.test.mjs`, and confirm **exactly** its own test(s) fail — not more, not fewer. If a mutation causes zero failures or the wrong failures, the covering test is broken; fix it before moving to the next mechanism.
- [ ] The reopen rule (Task 2): disable the reopen branch (force always-new-row) → only the reopen tests fail.
- [ ] The "stored base question never advances across repeated re-asks" rule (Task 2): make the stored base always update to the latest re-ask → only the double-rejection test fails.
- [ ] Hint-stripping, both title and pre-fill (Task 2): disable `stripHint`/`deriveRowTitle`'s hint removal → only the title/default-derivation tests fail.
- [ ] Provider-string first-`" - "` split (Task 3): disable the split → only the provider-card tests fail.
- [ ] Model star-badge stripping (Task 3): disable the strip → only the model-card tests fail.
- [ ] The `collapsed`-class toggle on COMPLETE (Task 4): disable it → only the collapsed-class test fails.
- [ ] The transient-spinner "never insert after `installClaude` yes" exception (Task 5): remove the exception → only that negative-case test fails.
- [ ] The transient-spinner-hide "unless the transient row was converted to ERROR" guard (Task 5/7 ordering): remove the guard so the spinner is always hidden on rejection → only the `step: null`-no-ACTIVE-row test fails (should now show zero rows instead of one).
- [ ] The `installClaude` ACTIVE-when-settled safety net (Task 6): remove the safety net → only that test fails.
- [ ] Each of the three rejection-mapping branches (Task 7) — named-row, model-pre-row, `step: null`-fallback — disabled one at a time → only that branch's test(s) fail each time.
- [ ] Record the pass as complete once all mechanisms above have been verified; commit any test fixes made along the way.

---

## Self-Review Notes

- Spec coverage: storage/gate/activate handling (Task 1), title/default derivation + reopen logic including the stored-base-never-advances rule (Task 2), provider/model string parsing (Task 3), header/layout/copy/collapsed-row shape/option-card markup/Continue button (Task 4), transient spinner including flow-start and its ordering against rejection-mapping (Task 5), installClaude onLog special case with its own collapsed label (Task 6), success/failure mapping including the transient-row-becomes-ERROR case (Task 7), production wiring (Task 8), mutation-verify pass (Task 9) — every numbered spec section has a task.
- Negative-constraint pass:
  - "No changes to `setup-driver.js`/`steps-ui.js`/`models.js`/legacy wizard" — no task modifies those files; Task 8 only adds two lines inside `renderer.js`'s existing dev block, consuming `setup-driver.js`/`setup-view.js` without editing the former. Task 4's `collapsed` class is a DOM class toggle from `setup-view.js`, not a `steps-ui.js` edit.
  - "No new Rust/IPC, no new `StepStatus` values" — no task touches `src-tauri/` or adds enum values; Task 7 only reads existing `StepStatus` states (ACTIVE/COMPLETE/ERROR).
  - "No sidebar/Home entry, no Back button, no progress-dot indicator" — Task 4's markup is header/heading/helper/option-card/Continue/collapsed-row only; no task adds a Back control, a dot indicator, or any router/sidebar entry.
  - "No failure-detail UI beyond marking the failing row ERROR" — Task 7 only sets row status (including the transient-row-becomes-ERROR case); no task renders error text, a retry control, or the two out-of-scope failure panels.
  - "`activate` and `gate` are never rendered, in or out of collapsed form" — Task 1's test explicitly asserts their absence, including on a simulated first-profile path; no later task inserts either.
  - "The wireframe's illustrative provider grouping (SSO / API-key submenu / local-model) must not be rendered as the option-card list" — Task 3/4 render the CLI's own flat `prompt.options` list one card per option, never a hand-built three-group structure; nothing groups or reorders options.
  - "No retry-with-resume or step revisit/replay" — no task adds a Back/re-open-by-click UI action; Task 2's reopen logic is driven only by the driver's own re-ask signal, never by user action, and explicitly never advances its stored comparison base in response to a re-answer (mirroring the driver's own restraint for the same reason).
  - "Do NOT reuse or modify the legacy wizard's `.step-row` rules" — Task 4 adds new, separately-scoped selectors (including the `collapsed`-state rules) alongside the verified 489-512 block, never inside it.
  - "Transient spinner hide must not erase an ERROR state, and the rejection mapping must not run against a row that's already been hidden" — Tasks 5 and 7 now share one explicit ordering: `handleReject` (Task 7) runs first on rejection; Task 5's hide is conditional on Task 7 not having converted the transient row to ERROR; on success, Task 5's hide runs unconditionally before/with `handleResolve`.
  - negative-constraints beyond the above: none stated.
- No task runs the whole quality-gate suite, browser verification, or code review; those are the calling flow's own stages.

---

## Status note, 2026-09-09 evening (Mert)

Tasks 5, 6 and 7 were done by hand on this branch, together with the four
fixes to Tasks 1-4 that the real walk exposed. Commits on
`feat/epmcdme-14513-setup-view-ui`:

- `3b109df` transient spinner, installClaude via onLog, success/failure mapping,
  answered rows drop their controls, card titles as values, first card
  pre-selected, headings without the trailing colon.
- `1bbaa63` **driver change, an exception to the Global Constraints:**
  `ui/setup-driver.js` now marks an answered list prompt in `answeredOnce`,
  like confirms. Found on the first real walk: the provider question ends in
  a newline, its answered echo parsed as a one-entry list and was re-dispatched,
  and answering it again wrote a stray Enter that accepted the URL default.
  Test built from the real recording; mutation-checked.
- `bda58d4` polish: cards without visible radios, styled input and
  Continue, closing status line, per-run state reset in `start()`.

Walked end to end in the built app against the real CLI: SSO provider, URL
default, project list, 15 models with the starred one badged, profile name,
profile saved and active, existing profiles untouched. Tests: 49 in
`ui/test/setup-view.test.mjs`, 175+ overall, all green.

**Remaining for this run:** Task 8 (dev hook in `ui/renderer.js`, two lines),
Task 9 (mutation pass, the mechanisms are listed above; most were already
checked by hand), then the flow's own gates, review and MR. Resume from
Task 8; do not redo 5-7.

Code-review round 1 (2026-09-09, late): all five findings resolved by hand.
CR-004 and CR-005 in 4b1f7fd (secrets masked and never echoed; one run at a
time), CR-002 in 887709f (model-branch mark test, mutation-checked), CR-003 by
tidying spec.md's input-title rule (the code keeps the fixed "Profile name"
heading Mert asked for), CR-001 by rewriting every subject on the branch to
Conventional Commits (history rewritten locally; the branch was never pushed
past 923e8b2). Trees unchanged. 183 tests green.
