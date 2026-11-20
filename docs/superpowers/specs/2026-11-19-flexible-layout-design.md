# Flexible layout · design

**Status:** prototype approved for planning on 2026-11-19 (`prototypes/today-customize/`, local and git-ignored).
**Plan:** `docs/superpowers/plans/2026-11-19-flexible-layout.md`

## Intent

Today, the user arranges the page in a dialog: a list of switches, a width picker per card and up and down arrows. They want to arrange it by hand instead. They want to drag a widget, pull it bigger or smaller, and add or remove widgets, without opening a dialog. The other pages should work the same way: their sections can be resized and moved left or right by touching them. The Settings menu has too many items, so its groups (Workspace, Meetings, CodeMie, Application) fold.

## Goals

- Today is a grid of widgets. You move a widget by dragging its header and resize it from its right edge, bottom edge or corner. You add widgets from a gallery, remove them, collapse them, rename them and change their options. Every change is saved at once and can be undone.
- A widget's content changes with its size instead of being cut off.
- Calendar, Meetings, Inbox and Automations are built from sections. You resize a section by pulling the divider next to it, and you move it by dragging its tab. A section can collapse to a narrow rail.
- The Settings menu groups fold. The Settings menu and the main menu can also shrink to icons.
- Every drag has a keyboard and a menu equivalent. Touch works with a long press.

## Non-goals

- New data widgets beyond splitting Notes out of Tasks and Focus timer out of Day at a glance. The prototype's Claude Code sessions widget is not built.
- Tasks board columns as sections. Card drag-and-drop between columns already exists there, and making each column a section would duplicate it. Tasks keeps its board and its drawer. This is a call for the user to confirm at review.
- Top and bottom splits of sections.
- Switching layouts automatically and a density setting. Both are ideas from the prototype guide.
- Layouts that follow the user to another device. The Today layout lives with the workspace (native). Page sections and menus are preferences of this device (localStorage, with keys starting `codemie.`), as the calendar visibility and terminal dock preferences already are.

## Anti-goals

These would count as failure even if everything else worked.

- A background sync or the minute re-render drops a widget or tab the user is holding.
- An old saved layout opens empty or in a different order after the update.
- Content is clipped with no way to reach it. A widget too small for its content scrolls inside itself. A page too narrow for its sections scrolls sideways.
- A layout change that native storage refused is left on screen.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| Keep the ordered list and let CSS place cards (`grid-auto-flow: dense`) | Small change, but no free placement and no heights. Dragging into a gap does nothing predictable. | Rejected |
| Positions on a 12-column grid (x, y, w, h) that pack upward, with neighbours sliding sideways first | Predictable, swaps two widgets naturally. Needs a small engine. | **Chosen.** The prototype proves the behaviour. |
| A grid library (gridstack and similar) | The app has no bundler and no UI dependencies, and the library brings its own look and touch handling | Rejected |
| Sections with splitters only (resize, collapse, swap) | Simpler, but a tab cannot move out and sit beside the others, which was the point of "moved left/right" | Rejected |
| Sections with tabs that dock: join another section, split beside it, collapse, maximize | One engine serves every page | **Chosen** |

## Today grid

**Geometry.** 12 columns, rows 56 px high, 16 px gaps. Width goes from 2 to 12 columns, and never past the right edge. Height goes from 1 to 24 rows. A collapsed widget is 1 row and keeps its previous height to come back to. Positions are CSS variables (`--x --y --w --h`), so the view stays pure and the browser places the widgets with no measuring. The page holds at most 16 widgets.

**Packing.** Widgets float up as far as they can. While you hold a widget, it stays where your pointer puts it. A widget it overlaps first slides sideways within its own row to the nearest free spot, so two widgets swap places. If there is no free spot, it drops below. Everyone else is placed from their position before the drag began, so wiggling the pointer does not leave holes behind. When you let go, everything packs upward again. Nothing moves sideways except during a drag.

**Widgets.** Default sizes are width × height.

| id | Title | Default size | Smallest size | Options (default) |
|---|---|---|---|---|
| `brief` | Up next | 8×4 | 3×2 | Show "Later today" (on) · Show who is invited (on) |
| `focus` | Day at a glance | 4×4 | 2×2 | Numbers: Meetings left, In meetings, Free time, Need reply (on), Open tasks (off) · Focus session buttons (on) |
| `calendar` | Schedule | 6×7 | 2×3 | Show free time (on) · Day starts at 07:00 / 08:00 / 09:00 (08:00) |
| `inbox` | Needs your reply | 6×7 | 2×3 | Messages shown 3 / 6 / 10 (6) · Sources Outlook, Teams (both) |
| `commitments` | Tasks | 8×6 | 3×3 | Quick add box (on) · Only my tasks (off) · Show completed (on) |
| `notes` *(new)* | Notes | 4×6 | 2×2 | Text size Small / Medium / Large (Small) |
| `meetings` | From your meetings | 6×5 | 3×2 | Only meetings that need me (off) |
| `automations` | Automation results | 6×5 | 3×2 | Only failures (off) |
| `timer` *(new)* | Focus timer | 4×3 | 2×2 | Default length 25 / 50 min (25) |
| `plugins` | From plugins | 12×3 | 4×2 | none |
| `plugin:<id>:<widget>` | the plugin's title | the plugin's width × 4 | 2×2 | none |

**What content does with size.** Each tile (`.ws-tile`, not just its body) is a size container, because header extras and footers sit outside the body. In the stacked layout a tile keeps a fixed height of its rows, so the container never collapses. Each widget changes its content with its own width and height:
- Schedule narrower than 300 px shows an agenda list instead of the timeline.
- Up next narrower than 460 px drops the time column, the faces and the secondary buttons. Below 190 px tall it drops "Later today" and the faces. Below 110 px tall it drops its buttons.
- Day at a glance shows 4 numbers in a row from 520 px wide, otherwise 2. Below 200 px tall it drops the focus row.
- Needs your reply drops the preview line below 420 px wide and the avatars below 280 px.
- Tasks drops owners and the date field below 420 px wide.
- Header extras ("Calendar →", "Inbox · 4") hide when the widget is narrower than 300 px.

**Notes and the timer.** Notes is the notes column of Tasks, now a widget of its own. It keeps the textarea id `today-note`, so autosave and the render that keeps typed text work unchanged. Tasks no longer draws notes. Focus timer uses the same `focus` action and `settings.focusUntil` that Day at a glance uses.

**Auto cards.** "From your meetings" and "From plugins" already show themselves when they have something and the layout has not placed them. They keep doing that at the bottom of the grid, full width and at their default height, until the user removes them. A removed auto card goes into `today.hidden` and stays away. Adding it from the gallery takes it out of `hidden`.

Native code also adds `automations` to `layout` when an automation turns Today delivery on (`automations/engine.rs`). So any id that is in `layout` but not in the grid or in `hidden` shows at the bottom the same way. When delivery turns on, native also takes `automations` out of `today.hidden`. That keeps today's rule: turning delivery on brings the card back, and a card the user removed stays removed while delivery stays on.

**Plugin widgets before plugins load.** The plugin catalog is empty until the plugins load (`state.pluginsKnown`). Until then, a plugin item draws as it does now, as a placeholder, and counts as visible. Only after the catalog is known does an item whose plugin is off count as unavailable. An unavailable item is not drawn, keeps its saved entry, and is packed after the visible widgets on the next save.

**Saved layouts.** There are three built-in layouts: Default, Focus and Meeting day. The positions come from the prototype; see the plan's Task 2.
- `items` is the grid of the layout in use (`active`). Every save also writes the same items into `layouts[active]`, so switching layouts never loses work.
- A built-in name in `layouts` is the user's changed copy. It shows "· changed" when it differs from the preset, and Reset deletes the copy.
- The user can have at most 12 layouts of their own, so `layouts` holds at most 15 entries. Names are 1 to 40 characters, and an own layout can't take a built-in name ("That name belongs to a built-in layout."). Own layouts can be deleted.
- Titles, options and `hidden` belong to the workspace, not to one layout.

**Moving to the new grid.** Every workspace has a `layout`, because native code seeds one for Personal and for every new workspace. Without `today`, the grid comes from it:
- **Never customized** (`widgetWidths` is `{}`, since the old Customize dialog always saved a width for every card): the grid is the Default layout, with `active: "Default"`.
- **Customized:** the grid keeps the same order and widths. Widgets fill each row left to right at their default heights, and a width that isn't a whole number of columns falls back to the default. When `commitments` is there, it becomes 8 columns wide with `notes` placed after it at 4 columns. This becomes the user's own layout "My layout" (`active: "My layout"`), and Default stays the preset.
- An auto card with a `widgetWidths` key but no place in `layout` was hidden before, so it goes into `hidden`.

The first change the user makes saves the grid. Opening the page saves nothing.

**Interactions.**
- **Move.** Drag the header with mouse, pen or touch (a long press of 380 ms). The grip appears on hover. The widget follows the pointer with a lifted shadow, a dashed outline shows where it will land, and the column guides show. The page scrolls when the pointer nears the top or bottom edge. Escape cancels the drag.
- **Resize.** The right edge changes the width, the bottom edge the height and the corner both. A badge shows "w × h" and a size name (quarter, third, half, two thirds, full width).
- **Customize** (the header button, which already exists) turns on edit mode:
  - a toolbar shows "Customizing Today" with a hint, Undo, Redo, the layout menu and Done;
  - a gallery appears on the right with "Add to Today" (cards you can drag in or press Add on) and "On Today · N" (each with Remove);
  - every widget gets an × to remove it, and there is an "Add a widget here" tile.
- **Header buttons.**
  - The sliders button opens an options panel next to the widget. It holds Title, the widget's options and Reset widget, and applies changes as they are made.
  - The ⋯ menu holds Customize widget…, Rename, Width (1/4, 1/3, 1/2, 2/3, Full), Height (S 3, M 5, L 7, XL 9), Collapse to its header or Expand, Move to the top, and Remove from Today.
  - Double-click a title to rename it.
- **Adding.** Add puts the widget at the top left and pushes the others down. Dropping from the gallery puts it where it is dropped.
- **Lock** (the header lock button) stops moving and resizing on Today and on the page sections. Trying to drag then shows "Layouts are locked" with an Unlock button.
- **Undo and Redo.** Every layout change can be undone, and Undo saves the layout as it was before. ⌘Z and ⇧⌘Z work outside text fields. Removing a widget and switching layouts show a toast with Undo.
- **Keyboard.** Tab reaches each widget's grip. The arrow keys move the widget. Up jumps above the widget directly over it. Shift with the arrow keys resizes, and Delete removes. A live region says the result, for example "Schedule moved to column 1, row 5".
- **Narrow pages.** When the Today grid is narrower than 640 px, the widgets stack in one column in reading order, and drag and resize are off. Saved positions are not touched.

**Storage.** `layout_save` gains `today` on the workspace record:

```
today: { active: "Default", items: [{id, x, y, w, h, collapsed?, prevH?}],
         layouts: { "<name>": [items] }, titles: { "<id>": "text" },
         options: { "<id>": { "<key>": bool | number | string | [string] } }, hidden: ["<id>"] }
```

Native storage checks the whole grid and refuses it with `validation`, the message "Invalid Today layout." and the field `today` when:
- an id is unknown or repeated;
- x is outside 0–11, w is outside 2–12, or x + w is over 12;
- y is outside 0–400, or h is outside 1–24;
- two items overlap;
- there are more than 16 items in the layout or in any saved one;
- there are more than 15 entries in `layouts`, or a name is empty or longer than 40 characters;
- a title is empty or longer than 40 characters;
- an option value is anything other than a bool, a number, a string of 40 characters or fewer, or a list of at most 8 such strings;
- `options` is larger than 8 KB.

The UI also sends `layout` (the ids ordered by row, then column), so code that reads `layout` keeps working. It stops sending `widgetWidths`.

## Page sections

**Engine.** A page is a list of sections, and each section holds one or more tabs (`{tabs, active, w, collapsed}`). Widths are weights in px, used as flex-grow with each section's minimum as its min-width.
- **Divider.** Pull it to resize the two sections beside it. Pull it past 55% of a section's minimum and that section collapses to a 42 px rail. The rail shows the section's tab icons and a vertical label, and a click expands it. Double-click a divider to reset the two sections beside it to their default widths. With the keyboard, ←/→ move a divider by 24 px (80 px with Shift), and Enter collapses or expands the narrower section.
- **Dragging a tab** onto:
  - another tab strip joins that section at the drop position;
  - the left or right 30% of a section opens a new section on that side, taking half the width;
  - a divider makes a new section there;
  - its own strip reorders it.

  A section left with no tabs disappears, and its width goes to a neighbour. ⌥⇧←/→ moves a focused tab to the next section, or splits it out when there is none.
- **Section ⋯ menu.** Move section left, Move section right, Open "<tab>" beside, Maximize this section (double-clicking the tab strip does the same) or Restore sections, Collapse to a rail, Pin "<widget>" to Today or Show "<widget>" on Today, and Reset page layout.
- **Rules.** At least one section stays open. The section row scrolls sideways when the sum of the minimum widths is wider than the page.
- **Storage.** In localStorage under `codemie.layout.<page>.v1`. A stored layout is checked against the page's definition when read. Unknown tabs are dropped, missing tabs join the last section, and empty sections are removed. Unreadable storage gives the default layout.
- **Lock** (shared with Today) stops divider drags and tab drags. Clicks still switch tabs.

**Pages.**

| Page | Tabs (minimum / default width, px) | Default sections | Pins to Today |
|---|---|---|---|
| Calendar | `cal-side` Calendars (220/260), `cal-main` Calendar (480/1000) | [cal-side] [cal-main] | `cal-main` → Schedule |
| Meetings | `mtg-list` Meetings (260/340), `mtg-notes` Notes (340/760), `mtg-transcript` Transcript (320/520), `mtg-tasks` Tasks (300/420), `mtg-files` Files (300/420) | [mtg-list] [notes, transcript, tasks, files] | `mtg-list` → From your meetings |
| Inbox | `inbox-list` Messages (320/420), `inbox-reader` Message (380/720) | [inbox-list] [inbox-reader] | `inbox-list` → Needs your reply |
| Automations | `auto-list` Automations (420/900), `auto-runs` Run log (380/600), `auto-templates` Templates (380/600) | [auto-list, auto-runs, auto-templates] | `auto-list` → Automation results |

- **Meetings.** The meeting's header (as the calmer Meetings design has it: the title once, when and the people as faces, a hidden meeting's note, Review, plugin chips, the ⋯ menu and the run line) shows once, above the tab strip of the first section from the left that holds a meeting tab. Who was there is the header's popover, not a tab. Before a meeting has a transcript, that first section shows the explainer and the meeting's tasks whatever tab it shows, and any other open meeting section says it waits for the transcript. Only the Tasks tab has a count: the tasks to review. The meeting list's toggle button (`meeting-list-toggle`) collapses and expands the `mtg-list` section, replacing the old `view.wide`. Compare mode collapses the list as before and restores it afterwards.
- **Hash routes** (`#/meetings/<id>/<tab>`, `#/automations/<tab>`). The hash names the tab chosen last. Opening a hash activates that tab in whichever section holds it. The tab names map to section tab ids: `notes`↔`mtg-notes`, `runs`↔`auto-runs`, and so on.
- **Every visible tab loads its data.** The Meetings controller reads the transcript, files and notes for every meeting tab that is visible in any section, not only for the tab chosen last. The Automations Run log loads whenever `auto-runs` is visible.
- **Old collapse states move over.** On the first open with no stored page layout:
  - Calendar's `codemie.calendar.sidebar = "false"` becomes `cal-side` collapsed. The old `calendar-sidebar` toggle collapses and expands that section, and the ≤1180 px auto-hide goes.
  - Meetings' `codemie.meetings.wide = "true"` becomes `mtg-list` collapsed.

  The old keys are then no longer written.
- **Arrow keys.** Calendar's global ←/→ (which change the week) ignore keys pressed on a divider, a section tab or a widget grip.

## Menus

- **Main menu.** It collapses to the same 64 px icon rail the app already uses at ≤1050 px, with tooltips and a dot in place of each count. Use ⌘\, the "Collapse menu" button at the bottom of the menu, the button at the left of the top bar, or drag the menu edge left or right by 60 px. Stored in `codemie.sidebar.collapsed`. At ≤1050 px the rail stays, as now.
- **Settings menu groups.**
  - Clicking a group name folds it. It shows a chevron, and `aria-expanded` follows.
  - A folded group shows its item count, keeps the current page's item visible, and shows a red dot when a hidden item needs attention (the same dots as now: Microsoft 365, CodeMie tabs).
  - ⌥-click keeps only that group open. A fold-all and unfold-all button sits next to the "Settings" title.
  - "Find a setting" (new) searches labels and group names, and ignores folding while it holds text.
  - Stored in `codemie.settings.folded` (a list of group names).
- **Settings menu shrink.** It shrinks to a 58 px icon rail with ⌘⇧\, the button next to the title, or by dragging its edge past 150 px. Dragging the edge also resizes it between 200 and 400 px, and double-clicking the edge resets it to 272 px. Stored in `codemie.settings.menu` `{collapsed, width}`.
- **Settings → Layout** is a new tab under Workspace, after Appearance. It has five cards:
  1. **Moving and resizing:** Lock layouts, and Show handles (On hover, Always or In Customize; stored in `codemie.layout.handles`). The lock is stored in `codemie.layout.locked`.
  2. **Today layouts:** each layout with "In use", Use, Reset (when changed) and Delete (for your own).
  3. **Page layouts:** each page with a summary of its sections, Open and Reset.
  4. **Side menus:** Collapse the main menu, Settings menu groups (explained in text), and Shrink the Settings menu to icons.
  5. **Keyboard:** the shortcuts.

## Copy

These strings are exact:
- "Customize"
- "Customizing Today"
- "Drag a header to move · pull an edge or corner to resize · drag cards in from the right"
- "Add to Today"
- "On Today · N"
- "Add a widget here — or drag one in"
- "Layouts are locked"
- "Unlock"
- "<Title> removed from Today"
- "Undo"
- "Switched to “<name>”"
- "Saved as “<name>” — changes now go to this layout"
- "“<name>” is back to the original"
- "Today is saved — every change is kept as you make it" (on Done)
- "Make Today your own" (empty grid)
- "<Tab> opened beside <Tab>"
- "<Tab> joined the <Tab> section"
- "<Tab> collapsed to a rail"
- "<Page> is back to its original layout"
- "Keep at least one section open"
- "Find a setting"

## Accessibility

- A grip is a `button` labelled "Move <title>. Arrow keys move it, Shift and arrow keys resize it."
- A divider is `role="separator"` with `aria-orientation="vertical"` and `aria-valuenow` (the left section's width), and it is focusable.
- A tab strip is `role="tablist"` with roving `tabindex`.
- A folded group header has `aria-expanded` and `aria-controls`.
- Each move or resize is announced in a polite live region.
- With `prefers-reduced-motion`, there is no lift or tilt animation.

## What the builder decides

- The exact CSS for lift and guides (follow the prototype).
- How the controller keeps listeners off `app.js` (`attachTodayDrag` and `attachDock`, following `attachBoardDrag`).
- The live-region wording beyond the examples.
- The order of the gallery cards inside a group.
