# Grouped main menu

Prototype: `prototypes/sidebar-groups/compact.html` (approved 2026-11-20). The main menu groups its pages, folds groups, and takes less height. No Pinned block.

## What the menu shows

| Part | Holds | Notes |
|---|---|---|
| Brand row | logo, the shrink button (`sidebar-toggle`) | replaces the "Collapse menu" row; ⌘\ and the top-bar button stay |
| Today | Today | no group |
| Work | Inbox, Calendar, Meetings, Tasks | foldable |
| AI | Automations, Analytics | foldable |
| Plugins | one row per plugin | foldable; only when a plugin adds a page |
| Footer | account and Settings in one row | Settings is a gear with the attention dot |

- Rows are 30 px (were 36), group labels are 20 px uppercase lines with a chevron, not rows.
- A group label is a button (`data-action="sidebar-fold"`, `aria-expanded`). Folded, it shows the summed counts of the pages it hides. The page you're on stays under a folded label.
- Plugins starts folded when more than 3 plugins add pages; a click on its label decides from then on. Folded, the label line shows up to 4 plugin marks and `+N`.
- A plugin row has a letter mark (first letter of the plugin's name, a hue from its id) instead of the shared puzzle icon. A plugin with one page: its row is that page, labelled as now. A plugin with several pages: the row is the plugin's name and opens its first page; its pages are listed under it only while one of them is open.
- Plugin badges are plugin text (`1`–`99`, `99+`, or a mark like `!`). A roll-up adds the numbers (shown as `99+` above 99); with no number, the first mark shows as it is.

## Icons only (collapsed, or the window ≤ 1050 px)

- Groups are separated by a hairline; an open group's hairline folds it on click.
- A folded group is one icon button (Work: board, AI: sparkles, Plugins: puzzle) with a dot when it hides counts; its tooltip says what it holds.
- Counts become dots, names show as tooltips (the existing `data-tip`), a plugin's pages are small dots with their names as tooltips, the footer stacks the gear above the avatar, the shrink button shows on hover or focus of the logo.
- `data-tip` is not part of a control's identity for focus after a redraw (`ui.js::controlSelector`): it changes with the state (Fold AI, then AI: Automations, Analytics), like `aria-*`.
- Rail styles key on the menu's own width (a container query on `.ws-sidebar`), so the hand-collapsed rail and the narrow window share one set of rules.

## Stored

`codemie.sidebar.folded` in localStorage: `{work, ai, plugins}` booleans, set by a click. Missing keys use the default (open; Plugins folded when more than 3 plugins). A preference of this Mac, like `codemie.sidebar.collapsed`.

## Out of scope

Pinned pages, reordering, a Chat page (not on this branch), plugin-supplied icons (the manifest has none).

## Plan (5 tasks)

1. **Model and markup** (`ui/workspace/shell.js`): `NAV_GROUPS`, plugin rows grouped by plugin, roll-ups, marks, brand toggle, one-row footer; `renderShell` takes `sidebarFolded`. Unit tests in `ui/test/shell-nav.test.mjs`, `settings-plugins.test.mjs`, `workspace.test.mjs`.
2. **Wiring** (`ui/workspace/app.js`): read and save `codemie.sidebar.folded`, the `sidebar-fold` action (announced, focus kept), pass the fold state to the shell.
3. **Styles** (`ui/workspace/workspace.css`): compact rows, labels, marks, footer, both themes, the rail via a container query; drop the rules the new markup no longer uses.
4. **Browser checks**: a menu scenario in `ui/test/browser/layout-checks.mjs` (fold and roll-up, current page kept, fold kept after reload, 4+ plugins folded with marks, a plugin's pages nested, rail tooltips and folded-group icon, no overflow, screenshots in both themes); fix selectors the old menu needed.
5. **Gates and a look**: `npm test`, the full browser run, screenshots checked by eye.
