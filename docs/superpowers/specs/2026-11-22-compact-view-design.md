# Compact view · design

**Status:** draft from brainstorming on 2026-11-22, step 1 of `2026-11-22-workspace-next-rollout-design.md`.

## Intent

The user is moving from their current reference app to Connect as their primary app. Next to the reference app, Connect feels loud: larger text, taller rows, a big Today header with a layout toolbar, an Inbox split into a list and a reading pane that "looks conflicting", and a menu showing pages they do not use (Calendar, for one). They want the reference app's density and its Inbox in Connect, without a separate "reference-app mode", and they want to remove pages and controls they do not need.

## Goals

- **Settings › Appearance › View: Compact | Default.** Default is today's look. Compact uses the compact sizes everywhere and the reference app's layout on Inbox and Today. It applies at once, with no restart and no Save.
- **Compact sizes** (the reference app's): body 13, secondary 12, meta 11, small labels 10.5; page title 20 (Today and Inbox 22); spacing 4 / 8 / 12 / 16 / 24; menu rows 28 px; inputs and buttons 28 px; control radius 6, row radius 8. Font stays Connect's (Geist Mono).
- **Compact Inbox:** one list, no reading pane. A row opens in place and shows the thread and the reply box under it; opening a row closes the one open before. Details below.
- **Compact Today:** no avatar, no greeting line; the date and the summary line ("1 meeting left · 2 h 37 min free until 18:00 · 58 need you") form the header. Each part of the summary opens its page.
- **Today's toolbar hides in both views.** The layout picker, lock, Add widget and Customize move into one ⋯ menu at the right of the Today header. Customize mode itself is unchanged.
- **Hide menu pages.** Settings › Layout › "Menu" lists every main-menu page (Today, Inbox, Calendar, Meetings, Tasks, Automations, Analytics) with a switch. A hidden page leaves the menu, the rail and the menu's count roll-ups. Plugins' pages keep their own on/off in Settings › Plugins.

## Non-goals

- A third "Comfortable" preset or a free text-size slider.
- Reordering menu pages. Not asked for; the grouped menu (`2026-11-20-grouped-menu-design.md`) fixes the order.
- Changing the reply controls. Compact Inbox reuses today's reply form (`replyForm`, Draft with AI, Review & send); step 2 of the rollout changes the reply in both views.
- Changing lanes. The six lanes stay; merging them waits for the inbox-rules step.
- Compact layouts for Calendar, Meetings, Tasks, Automations, Analytics and Settings. They get the compact sizes only; Meetings' layout is step 3.
- Plugin frames. Their own CSS (`ui/plugins/frame/`) is not resized.

## Anti-goals

- Default looks different after this change. Moving sizes into tokens must leave Default pixel-identical.
- Text clipped or overlapping in Compact; a row or control that cannot be reached.
- A hidden page breaking something that points to it: a notification, a Today widget, a link in another page or a `#/<page>` route.
- Switching view loses state: the selected message, a draft being typed, a scroll position in the list.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| Density setting: size tokens for both views, plus compact layouts for the screens where the reference app's is better | Two layouts to keep on Inbox and Today; everything else is one layout with two sets of sizes | **Chosen** |
| A separate "reference-app mode" shell with its own views | Fastest faithful copy, but every feature is built twice and they drift | Rejected by the user |
| Replace Connect's layouts with the reference app's for everyone | Least code, but removes the list-and-reader Inbox and the big Today for anyone who likes them | Rejected |

## How it works

### The setting

- `Settings.view` in native settings (`src-tauri/src/workspace/models.rs` `Settings`), `"default"` or `"compact"`, default `"default"`. App-wide like `theme`, not per workspace (workspaces are hidden, `WORKSPACES_HIDDEN`). Validated in `Core::update_settings` the way `theme` is (unknown values refused).
- `Settings.hiddenPages`: list of page ids from `NAV` (`ui/workspace/shell.js`), default empty. Unknown ids are dropped on save.
- Written through `mutate('settings_update', {...})`. Contract fixtures are regenerated because the snapshot's settings shape changes.
- The UI sets `data-view="compact"` on `#workspace-app` on every snapshot, next to `applyTheme` (`ui/workspace/app.js`). Before the first snapshot it reads a localStorage mirror (`codemie.view`) so the first paint does not jump, like `cm-theme` in `ui/theme-init.js`.

### Sizes as tokens

- `workspace.css` has about 660 hard-coded `font-size` values plus fixed heights and paddings. Add `--ws-*` size tokens (text steps, spacing steps, row and control heights, radii) with Default values equal to today's pixels, move the rules onto them, then override the tokens under `#workspace-app[data-view="compact"]`.
- Rules that need a compact value no token covers get a compact override next to them. No second stylesheet.

### Compact Inbox

What the user sees:

```
Inbox                                   ⟳
[Search people, subjects, text        ]
Needs reply 12 · Critical 2 · Waiting 3 · FYI 30 · Low · Decisions 1     All|Outlook|Teams  View ▾
──────────────────────────────────────────────────────────────────
● Anna Petrova         Re: Q4 budget for CLI                    2h
  Pavel Ivanov  (open)  Teams · CodeMie sync                     5m
  │ Pavel  10:02  can you share the deck before 3?
  │ You    10:05  will do
  │ Pavel  10:07  thanks, also the numbers for Serrala
  ┌──────────────────────────────────────────────────────────┐
  │ Your reply                                               │
  └──────────────────────────────────────────────────────────┘
  Draft with AI   Save draft   Review & send         Snooze ▾  ⋯
  Olga K.               Lunch?                                  1d
```

- The Inbox is one section. In Compact, `INBOX_DOCK` has only `inbox-list`; the reading pane section is not drawn. The user's Default dock layout is kept untouched for when they switch back.
- A closed row is one line: unread dot, sender, title, time, plus a thread count for chats. The preview line and the flags line are dropped; flags show as small marks after the title.
- **Selected and open are separate** (the reference app's behaviour). `state.selectedMessage` stays the focused row, and `ensureSelection` keeps picking one as today. A new `state.openMessage` is the row shown open. The Inbox loads with every row closed.
- Clicking a row selects and opens it; clicking it again, or Esc, closes it and leaves it selected. ↑/↓ and j/k move the selection only; ↵ opens the selected row. One row is open at a time.
- After Done, Snooze or a lane move, the row leaves the list and nothing opens by itself; the next row becomes selected.
- The open row shows, in order: the header actions that `reader()` has today, under one ⋯ except Done, Snooze and, on an unacknowledged critical message, Acknowledge (it stays a visible button so critical alerts are not weakened); the summary if there is one; the last messages of the thread (at most 260 px, scrolling, with "Earlier" to show all); then `replyForm` unchanged.
- Switching to Default shows `selectedMessage` in the reading pane; switching to Compact opens nothing. The reply being typed is kept either way (drafts are keyed by message, not by layout).

### Compact Today

- Header: date (meta size) above the summary line (body size). No avatar, no greeting. The ⋯ menu sits at the right.
- Widgets keep the grid, its 56 px row height (`GRID.rowHeight`) and the user's saved layouts; only their content uses the compact sizes, so nothing can get shorter or clip.
- The "Needs your reply" widget (the Inbox list pinned to Today) keeps its current rows in compact sizes. Its rows open in place too, in both views, with the thread and the same composer (amended 2026-11-26; reply design ruling 19).

### Today's toolbar (both views)

- One ⋯ button replaces the four controls. Its menu: the layout list ("Default · changed" and the saved ones), Add widget, Customize, and Lock / Unlock layouts.
- Customize mode, the gallery and the edit bar are unchanged.

### Hiding menu pages

- Settings › Layout gets a "Menu" card above "Side menus": one switch per page, labelled with the page name, and the line "Hidden pages leave the menu. Links and notifications still open them."
- A hidden page is left out of `renderShell` (`ui/workspace/shell.js`): its row, its badge and its share of the group's roll-up. A group with every page hidden is not drawn.
- A hidden page is still reachable by route: a notification, a Today widget, a link from another page, or a typed `#/calendar` open it, and the menu shows it greyed while it is open (as the grouped menu keeps the current page under a folded group).
- If Today is hidden, the app opens on the first visible page in menu order. If every page is hidden, Settings is still in the footer.
- At least one page must stay visible: the last visible switch is disabled with the tooltip "Keep one page in the menu."

## Copy

- Appearance: card "View", segmented "Compact | Default", line "Compact uses smaller text and opens messages in place."
- Today ⋯ menu items: "Layouts", "Add widget", "Customize", "Lock layouts" / "Unlock layouts".

## Accessibility

- An open row is a disclosure: `aria-expanded` on the row, focus moves into the reply box only when the user tabs, not on open.
- Compact never goes below 10.5 px text; focus rings keep their size.

## Calls made after the builder check

Settled in the design without asking, for the user to check at review: selected and open are separate and nothing opens on load; Acknowledge stays visible; `view` and `hiddenPages` are app-wide; Today's grid keeps 56 px rows; the pinned "Needs your reply" widget keeps its rows.

## Left to the builder

- Exact token names and how many steps.
- Whether the compact Inbox row is built from `listRow` with a flag or a new function.
- Where the localStorage mirror is written and read.
- Plan order (tokens first is suggested, so Default can be checked unchanged before Compact starts).
