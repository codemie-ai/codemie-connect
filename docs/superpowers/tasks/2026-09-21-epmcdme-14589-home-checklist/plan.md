# EPMCDME-14589 Home Checklist — Analytics Sidebar Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unhide the analytics sidebar entry (the last unresolved item from the home-grid-to-sidebar
migration), pin it with a regression test, and record the fate of all five original home-grid
actions in a decision doc.

**Architecture:** Single-attribute markup change (`ui/index.html`) exposes an already-live,
already-wired click handler in `ui/renderer.js` — no JS change. A regex-assertion test in the
existing `ui/test/home-copy.test.mjs` (Node's built-in `node:test`, no DOM) guards both the markup
and the wiring. A decision doc closes out the "five actions" bookkeeping from the EPMCDME-14511
spec.

**Tech Stack:** Vanilla JS/HTML front end (Tauri webview), `node:test` + `node:assert/strict`.

**Spec:** Requirements supplied inline by the caller (no `spec.md` for this task) — see
`## Acceptance criteria` below. Background/design source: EPMCDME-14511's
`docs/superpowers/tasks/2026-08-31-epmcdme-14511/spec.md` (lines 4, 19, 33-34). Codebase research:
`docs/superpowers/tasks/2026-09-21-epmcdme-14589-home-checklist/technical-analysis.md`.

## Global Constraints

- Do NOT modify `ui/renderer.js` in Task 1 — the click handler at `ui/renderer.js:819-822` is
  already live and unconditional; unhiding the button alone makes it functional.
- The new test must follow `ui/test/home-copy.test.mjs`'s existing convention exactly: module-level
  `readFileSync` + `assert.match`/`assert.doesNotMatch` regex assertions against raw source strings.
  No DOM simulation, no jsdom, no new dependencies.
- Out of scope, already done — do not touch: `ui/agents-parse.js`, `ui/home-state.js`,
  `ui/home-view.js`, `ui/command-log.js`, `ui/runner-bridge.js`, the grid removal in
  `ui/renderer.js`/`ui/index.html`, the shell-nav and command-log-footer unhide.
- Commit per task using the repository's existing convention (see recent log: `EPMCDME-14589 : <imperative summary>`).
- Do not add tasks for running the whole quality-gate suite, browser/manual verification, code
  review, or committing as a separate step beyond the per-task commit — the calling flow owns those.

---

## Acceptance criteria

- [ ] `ui/index.html`'s `#sidebar-analytics` button no longer carries the `hidden` class; no other
      attribute on that button, and no line in `ui/renderer.js`, changes.
- [ ] `ui/test/home-copy.test.mjs` gains a test that fails against the pre-Task-1 (hidden) markup
      and passes once Task 1 lands, asserting both that `#sidebar-analytics` is unhidden and that
      its `runAnalytics` click-handler wiring is present in `ui/renderer.js`.
- [ ] `.ai-run/decisions/2026-09-21-EPMCDME-14589-home-grid-actions.md` exists and records the fate
      of all five original home-grid actions (`install-only`, `full`, `connect-desktop`,
      `update-cli`, `analytics`), each citing the file/line or test that is its current owner.
- [ ] Full existing `ui/test/*.test.mjs` suite still passes (no regressions in the other tests in
      `home-copy.test.mjs`).

---

### Task 1: Pin the analytics sidebar entry with a regression test (test-first)

**Files:**
- Modify: `ui/test/home-copy.test.mjs` (add a new `test(...)` block after the existing
  `shell: the nav and the command-log footer are no longer hidden` test, currently ending at line 27)

**Interfaces:**
- Consumes: the file's existing module-level `html` (from `ui/index.html`) and `renderer` (from
  `ui/renderer.js`) string constants (`ui/test/home-copy.test.mjs:5-6`) — no new fixtures.
- Produces: nothing consumed by later tasks; this is a standalone regression test.

Test-first: yes — this test must fail against the current markup (`#sidebar-analytics` still
carries `hidden`) before Task 2 removes the class.

- [ ] **Step 1: Write the failing test**

Insert immediately after the `shell: ...` test block (`ui/test/home-copy.test.mjs:23-27`):

```js
test('shell: the analytics sidebar entry is unhidden and wired', () => {
  assert.match(html, /<button id="sidebar-analytics" class="sidebar-item">/);
  assert.match(
    renderer,
    /document\.getElementById\('sidebar-analytics'\)\.addEventListener\('click', \(\) => \{[\s\S]*?runAnalytics\(\);/
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test ui/test/home-copy.test.mjs`
Expected: FAIL on `shell: the analytics sidebar entry is unhidden and wired` — the `html` assertion
fails because `#sidebar-analytics` still has `class="sidebar-item hidden"` (the `renderer` assertion
passes already, since the wiring exists today).

- [ ] **Step 3: Commit**

```bash
git add ui/test/home-copy.test.mjs
git commit -m "EPMCDME-14589 : Pin the analytics sidebar entry with a failing test"
```

---

### Task 2: Unhide the analytics sidebar entry

**Files:**
- Modify: `ui/index.html:70`

**Interfaces:**
- Consumes: nothing new.
- Produces: the unhidden `#sidebar-analytics` button that Task 1's test asserts on.

Test-first: yes — Task 1's test is the failing test this task turns green; no new test is written
here.

- [ ] **Step 1: Remove the `hidden` class**

At `ui/index.html:70`, change:

```html
<button id="sidebar-analytics" class="sidebar-item hidden">CLI usage analytics</button>
```

to:

```html
<button id="sidebar-analytics" class="sidebar-item">CLI usage analytics</button>
```

Do not edit `ui/renderer.js` — the click handler at `ui/renderer.js:819-822` is already live and
unconditional.

- [ ] **Step 2: Run the test to verify it passes**

Run: `node --test ui/test/home-copy.test.mjs`
Expected: PASS, including `shell: the analytics sidebar entry is unhidden and wired`.

- [ ] **Step 3: Run the full JS suite to confirm no regressions**

Run: `node --test ui/test/*.test.mjs`
Expected: PASS (all files, all tests).

- [ ] **Step 4: Commit**

```bash
git add ui/index.html
git commit -m "EPMCDME-14589 : Unhide the analytics sidebar entry"
```

---

### Task 3: Write the home-grid-actions decision doc

**Files:**
- Create: `.ai-run/decisions/2026-09-21-EPMCDME-14589-home-grid-actions.md`

**Interfaces:**
- Consumes: no code interfaces — a documentation task.
- Produces: nothing consumed by later tasks.

Test-first: no — documentation only, no test applies.

- [ ] **Step 1: Write the decision doc**

Follow the header shape of `.ai-run/decisions/2026-09-03-EPMCDME-14505-packaging-approach.md`
(title, `**Ticket**`/`**Date**`/`**Status**`/`**Spec**` block, `## Decision` section) but keep the
body proportionate to this ticket's much smaller scope — a short table plus one paragraph per row,
not that doc's multi-part evidence treatment. Create the file with this content:

```markdown
# Home Grid Actions — Final Disposition of the Five Original Actions

**Ticket**: EPMCDME-14589 (`EPMCDME-14589-home-checklist`)
**Date**: 2026-09-21
**Status**: Decided — closes the last open item from EPMCDME-14511's grid-retention decision
**Spec**: `docs/superpowers/tasks/2026-08-31-epmcdme-14511/spec.md` (the origin of the "five
actions" framing; no dedicated `.ai-run/decisions/` file exists for EPMCDME-14511, so this doc
cites the spec directly)

---

## Decision

The Home launcher grid itself is removed as part of EPMCDME-14589 (Home's content moved to
`ui/home-view.js`). EPMCDME-14511's spec required that none of the grid's five actions —
`install-only`, `full`, `connect-desktop`, `update-cli`, `analytics` — be orphaned by any future
rework of Home. With the analytics sidebar entry unhidden in this ticket, all five now have a
final, settled entry point. None are pending; none require further follow-up.

| Action | Fate | Owning entry point | Evidence |
|---|---|---|---|
| `install-only` | Retired | — (removed before this ticket) | `ui/test/home-copy.test.mjs:17-19`, `:33-37` — regression tests asserting the wording and dead code (`INSTALL_ONLY_IDS`, `'install-only'`, "full installation") stay gone. Retired by EPMCDME-14979 (commits `45c415d`, `8eb4eef`), merged before this ticket started. |
| `full` | Survives | Notice modal raised by `ensureAuthenticated()` | `ui/renderer.js:469-487` — on a blocked profile state, shows a notice with `primaryAction: () => enterWizard()`, replacing the grid tile's direct entry into Setup. |
| `connect-desktop` | Survives | Connections sidebar entry | `ui/index.html:58` (`#sidebar-connections`, `data-view="connect"`); `ui/renderer.js:826-830` (`connectBtn` click handler, gated by `ensureAuthenticated()`, runs `codemie proxy connect desktop`). |
| `update-cli` | Survives | Update CLI button on the update banner | `ui/index.html:37` (`#update-banner-run`); `ui/renderer.js:679-682` (`runUpdateCli()`), invoked from the banner wiring around `ui/renderer.js:552-605`. |
| `analytics` | Survives | `#sidebar-analytics` sidebar entry (this ticket) | `ui/index.html:70` — `hidden` class removed by this ticket. `ui/renderer.js:819-822` — click handler (`runAnalytics()`) was already live and unconditional; only the markup gate needed removing, per EPMCDME-14511 spec.md:19 ("one class restores each"). Pinned by `ui/test/home-copy.test.mjs`'s `shell: the analytics sidebar entry is unhidden and wired` test. |

## Rationale

EPMCDME-14511's spec (`docs/superpowers/tasks/2026-08-31-epmcdme-14511/spec.md:33-34`) required
that the grid's removal not orphan any of its five actions, and shipped `analytics` and `about`
sidebar entries deliberately hidden pending ownership. `about` remains out of scope (no sub-task of
EPMCDME-14350 owns its content) and stays hidden. `analytics` is EPMCDME-14589's to resolve, and
its handler required no change — only the markup gate — because the wiring was built and left live
in anticipation of this moment.

---

## Follow-ups (out of scope here)

- `#sidebar-about` remains hidden pending an owning ticket; not part of this decision.
```

- [ ] **Step 2: Commit**

```bash
git add .ai-run/decisions/2026-09-21-EPMCDME-14589-home-grid-actions.md
git commit -m "EPMCDME-14589 : Record the final disposition of the five home-grid actions"
```

---

## Self-Review Notes

**Coverage:** Task 1+2 implement the sidebar unhide and its test (test-first: write failing test,
then implementation makes it pass). Task 3 implements the decision doc. All three requirements from
the inline requirements source are covered.

**Negative-constraint pass:**
- "Do NOT touch ui/renderer.js" (Task 1's requirement) — Task 2's Step 1 explicitly states not to
  edit `ui/renderer.js`; only `ui/index.html:70` is modified. No task touches `ui/renderer.js`.
- "no DOM simulation" — Task 1's test uses only `readFileSync` + regex `assert.match`, matching the
  file's existing convention; no jsdom or DOM APIs introduced.
- Out-of-scope files (`ui/agents-parse.js`, `ui/home-state.js`, `ui/home-view.js`,
  `ui/command-log.js`, `ui/runner-bridge.js`, grid removal, shell-nav/footer unhide) — none appear
  in any task's Files list.
- No task runs the whole quality-gate suite, browser verification, code review, or a separate
  commit-artifacts step; Task 2 Step 3 runs only the JS test suite as part of its own test-first
  cycle, not a standalone gate task.
- negative-constraints: all four addressed above; none omitted.

**Placeholder scan:** No TBD/TODO; all code blocks are complete and exact.

**Type/name consistency:** `#sidebar-analytics`, `runAnalytics()`, `ensureAuthenticated()`,
`connectBtn`, `runUpdateCli()` are used identically to their names in the technical analysis and the
actual source — no renamed symbols across tasks.
