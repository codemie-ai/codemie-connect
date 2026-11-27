# Meeting page task rows: two short lines — design

Date: 2026-11-20 · Status: approved by the user in chat ("Yes, build it") · Size: small change

## Why

On the Meeting page's Tasks tab, each task is about 150 px tall in a pane narrower than 760 px:
the owner select and the date field each drop onto their own line (`@container (max-width:760px)`
in `workspace.css`). The user found it "too big and not pretty". Every row also shows today's date
in grey because WKWebView fills an empty `<input type=date>` with today: it reads as "due today"
for tasks without a date.

## Goals

- Every task takes two short lines at any pane width: title and actions, then quiet chips.
- Owner, due date and status stay editable on the row; review tasks keep ✕ and Accept.
- A task without a date says so ("Add date"), never shows a date it doesn't have.

Non-goals: the Tasks board, the task drawer, Accept all, Add a task, native code, task data.
Anti-goal: a row that looks calm but takes more clicks to check the owner and the date before
Accept (the hint above the list asks for exactly that).

## Approaches

1. **Chips with the native controls inside (picked).** Owner: avatar + name over a transparent
   native `<select>` (the same owner list as today). Date: a chip that opens a small menu with the
   quick picks the drawer has (Today, Tomorrow, Friday, Next week), a date field and No date. Status:
   a small pill over a native select. Fewest new parts, keyboard and screen readers keep native
   controls, reuses `task-owner`, `task-due-pick`, `task-due`, `task-status`.
2. **Board-card look**, editing only in the task drawer. Calmer, but checking an owner before
   Accept becomes a trip to the Tasks page.
3. **Fix only the narrow breakpoint** (keep boxes, put them on one line). Still four boxed fields
   per row; doesn't fix the date or the look.

## Design

```
☐  Send the release plan                              ✕   ✓ Accept
   (AL) Ann Lee ▾ · 📅 Add date ▾ · “We ship in May.” 09:12

☐  Check the May date with legal                            To do ▾
   (AL) Ann Lee ▾ · 📅 Fri 21 Nov ▾ · “We ship in May.” 09:12
```

- Line 1: checkbox, title (opens the task, as now), then ✕ + Accept (review) or a status pill.
- Line 2: owner chip · date chip · the quote (one line, ellipsis; the button that shows the
  transcript line, as now). In a very narrow pane the quote wraps under the chips.
- Owner chip: avatar + name; "Nobody named" with the person-less icon. A low-confidence owner on a
  review task: amber chip "Check owner" (replaces the separate warning line).
- Date chip: "Add date" (muted) or the board's due text and tone (`dueInfo`: overdue red, today
  amber, soon blue). Menu: quick picks from `quickDates`, a date field (`data-commit="task-due"`),
  "No date" when there is one. The menu stays open through a re-render (`data-menu`).
- Status pill: the column name over the native select (To do, In progress, Waiting, Done).
- Row: ~56 px; the purple tint stays on review rows.

## Left to the builder

Exact spacing, chip heights (match `.ws-due` 20–24 px), focus rings, and the narrow-width rule.
