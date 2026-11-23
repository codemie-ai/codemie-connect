# Meeting Task Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each task on the Meeting page's Tasks tab takes two short lines: title + actions, then owner/date chips and the quote.

**Architecture:** View-only change in `tasksTab` (`ui/workspace/view-meeting-tabs.js`) and its CSS. Owner and status keep native `<select>`s styled as chips; the date becomes a `details.ws-menu` with the drawer's quick picks and a date field. Existing actions (`task-owner`, `task-due-pick`, `task-due`, `task-status`, `task-accept`, `task-dismiss`) are reused; no controller or native change.

**Tech Stack:** plain ES modules, CSS container queries, node:test, Playwright (browser run).

**Spec:** `docs/superpowers/specs/2026-11-20-meeting-task-rows-design.md`

## Global Constraints

- Chips: "Add date" for no due date; due text and tone from `dueInfo` (`ws-due-overdue|today|soon|later`).
- Quick picks: `quickDates(p.now, p.zone)` plus "No date" only when the task has a date.
- Low-confidence owner on a review task: chip text "Check owner", amber.
- No `<input type=date>` visible on the row itself (WebKit shows today's date in an empty one).

## Review Focus

- Task without an owner → chip "Nobody named" with the person-less icon, still a select. (Task 1 test)
- Done task → status pill says Done, title struck through, no due tone. (Task 1 test)
- Date menu open while a background snapshot re-renders → stays open (`data-menu`). (Task 2 browser check)
- Very long title / owner name in a 420 px pane → no horizontal overflow. (Task 2 browser check, `noOverflow`)
- Choosing a quick pick closes the menu and saves (`task-due-pick` already closes `details`). (Task 2 browser check)

---

### Task 1: Row markup

**Files:**
- Modify: `ui/workspace/view-meeting-tabs.js` (`ownerSelect`, `tasksTab` `row`)
- Test: `ui/test/workspace.test.mjs` (next to `tasks: "2 to review · 1 on the board"…`)

**Interfaces:**
- Consumes: `dueInfo`, `quickDates` from `tasks-model.js`; `selectBox`, `menuItems` in the same file.
- Produces: row classes `.ws-mtg-trow`, `.ws-mtg-trow-line`, `.ws-mtg-trow-meta`, `.ws-mtg-chip`, `.ws-mtg-chip-owner`, `.ws-mtg-chip-due`, `.ws-mtg-chip-warn`, `.ws-mtg-chip-status`, `details.ws-mtg-due[data-menu="due-<id>"]`.

- [ ] **Step 1: Failing test** `tasks: two lines — owner and date chips, a date menu, no bare date field`:
  render `mtg-philips` tasks tab; assert each `.ws-mtg-trow` has one `ws-mtg-trow-meta`; no `type="date"` outside `details.ws-mtg-due`; a task without `due` shows `Add date`; a task with `due` shows its `dueInfo` text in `ws-due-<tone>`; the menu holds `data-action="task-due-pick"` for Today/Tomorrow/Friday/Next week and `data-commit="task-due"`; "No date" only when due is set; owner select keeps `data-action="task-owner"`; review rows keep `task-dismiss` + `task-accept`, others `data-action="task-status"`; a low-confidence review task shows `Check owner`.
- [ ] **Step 2:** `cd ui && node --test --test-name-pattern="two lines" test/workspace.test.mjs` → FAIL.
- [ ] **Step 3:** Rewrite `row` and `ownerSelect` (chip = visible label + transparent select on top).
- [ ] **Step 4:** Same command → PASS; `npm test` → all pass.

### Task 2: Styles and browser check

**Files:**
- Modify: `ui/workspace/workspace.css` (`.ws-mtg-trow*` block ~2546–2570 and the 760 px container rule)
- Test: `ui/test/browser/meetings-checks.mjs` (the `task quote → transcript line` check area)

- [ ] **Step 1:** Browser check `tasks tab: rows are two lines; the date menu picks a date`: each `.ws-mtg-trow` ≤ 72 px tall at 1000 px and in a 420 px pane; open `.ws-mtg-due`, click Tomorrow → a `task_save` with that `due`, menu closed; `noOverflow`.
- [ ] **Step 2:** CSS: row = grid `24px 1fr auto` × two lines; chips 24 px like `.ws-task-chip`; quote `text-overflow:ellipsis`; drop the 760 px owner/date stacking rule.
- [ ] **Step 3:** `WORKSPACE_E2E_ONLY=meetings PLAYWRIGHT_CORE=… node ui/test/browser/workspace-e2e.mjs` → new check passes; no new failures beyond the known "Today card → meeting" cascade.
- [ ] **Step 4:** Check by eye in the real app (Connect Look test copy).
