# Flexible layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today is arranged by hand on a 12-column grid. Calendar, Meetings, Inbox and Automations get sections you resize and move by touch. The Settings menu groups fold, and both menus can shrink to icons.

**Architecture:**
- The Today grid is stored natively on the workspace. `layout_save` gains a checked `today` object, so it stays revision-fenced like every workspace change.
- A pure grid engine (`today-grid.js`) and pure views place widgets with CSS variables. A controller turns pointer and keyboard input into `layout_save` calls.
- Page sections use one pure dock model and view (`dock-model.js`, `dock-view.js`) and one controller. Their layouts and the menu states are device preferences in localStorage.
- One press tracker (`press.js`) serves every drag.

**Tech Stack:** Rust (Tauri v2, serde_json) for `layout_save`. Plain ES modules with no bundler and no new dependencies. node:test. The Playwright browser run (`ui/test/browser/`).

**Spec:** `docs/superpowers/specs/2026-11-19-flexible-layout-design.md`. Visual reference: `prototypes/today-customize/` (local, git-ignored).

## Global Constraints

- **Branch.** Cut `feat/flexible-layout` from `workspace-app` and merge back there (git-workflow R2). Line numbers in this plan are from `feat/connect-terminal-dock`, so find code by name on `workspace-app`. For example, `customizeDialog` is about :1272 there and :1383 here.
- **Commits.** Conventional Commits: `feat|fix|test|docs|refactor(scope): subject`, subject at most 100 characters.
- **No new dependencies.** No npm or cargo packages.
- **Views stay pure.** `view-*.js`, `*-model.js`, `today-grid.js`, `today-edit-view.js`, `dock-model.js`, `dock-view.js`, `settings-layout.js`: state in, HTML or value out, text through `escapeHtml`. Only `app.js`, `press.js` and the `attach*` functions touch `document`.
- **Workspace data goes through `store.mutate`.** The Today layout changes only via `mutate('layout_save', …)`, which is already in `REBASE_SAFE`. Page sections and menus use `localPref`, `localJson` and `setLocalPref` from `app.js` (:168–176), passed to controllers as `prefs = { get, json, set }`.
- **Action prefixes.** `today-` for Today, `dock-` for sections, `settings-menu-` / `settings-group` for the Settings menu, `sidebar-toggle` for the main menu, `layout-` for Settings → Layout preferences.
- **Fixed values.**
  - Grid: 12 columns, 56 px rows, 16 px gap. w 2–12, h 1–24, at most 16 widgets per layout. Stack below 640 px.
  - Layouts: at most 15 entries in `layouts` (12 own plus 3 built-in names). Names and titles 1–40 characters. `options` at most 8 KB.
  - Touch long press: 380 ms on a header, 220 ms on a gallery card, 300 ms on a section tab.
  - Sections: a section collapses at 55% of its minimum width.
  - Rails: section 42 px, main menu 64 px (the existing ≤1050 px rail), Settings menu 58 px.
  - Settings menu width 200–400 px, default 272.
- **Storage keys:**
  - `codemie.layout.<page>.v1`
  - `codemie.layout.locked` (`"1"` / `"0"`)
  - `codemie.layout.handles` (`hover` | `always` | `customize`)
  - `codemie.sidebar.collapsed`
  - `codemie.settings.folded` (JSON list)
  - `codemie.settings.menu` (JSON `{collapsed, width}`)
- **Copy.** Every user-facing string listed under "Copy" in the spec is used exactly.
- **Drags.** Drags listen on `window` for `pointermove` and `pointerup`, never with `setPointerCapture`, as the prototype does. That way synthetic pen and touch events in the browser run behave like real ones.
- **Shell.** Run commands in zsh. Raw `cargo` runs from `src-tauri/`, `make` from the repository root. The browser run binds loopback, so run it outside the agent sandbox with `PLAYWRIGHT_CORE` set.

## Review Focus

1. **A redraw while a widget, tab or divider is held** must not redraw the page under the pointer. Store updates, the minute render, `mutate`'s `finally` (app.js:197), `pluginsChanged` (:656) and Meetings' `canRender` (:1230) all reach `render()`.
   - `render()` itself returns early while `layoutDrag` is set, and marks `heldRender`.
   - `layoutDrag` clears only after the drop's `layout_save` settles, and then the held render runs.
   - Pinned by e2e E1, which uses pen pointer events because a mouse sets `pressing` and would hide the bug.
2. **When native storage refuses a layout,** the widgets go back to where they were and the message shows. Pinned by `a refused save puts the widgets back and shows the message` (Task 3).
3. **Moving to the grid.** A never-customized workspace (`widgetWidths` `{}`) opens on Default. A customized one opens as "My layout" in the same order and widths, with Notes after Tasks, and hidden auto cards stay hidden. Opening saves nothing. Pinned by the `todayOf …` tests (Task 2) and e2e E5.
4. **A plugin widget whose plugin is off** is not drawn once the catalog is known, keeps its entry, and the next save packs it after the visible widgets. Before the catalog is known, it draws as a placeholder. Pinned by `an unavailable widget is skipped in the view and kept in the save` (Task 3) and `before plugins load a plugin widget still draws` (Task 2).
5. **A stored page layout from an older build** (a tab that no longer exists, a new tab, unreadable JSON) opens normalized, and the old Calendar and Meetings collapse preferences carry over once. Pinned by `normalize …`, `loadDock ignores unreadable storage` (Task 4) and the migration tests in Tasks 4 and 5.

---

### Task 1: Native storage for the Today grid, and the mock that the browser run needs

**Files:**
- Create: `src-tauri/src/workspace/today.rs` (`valid_today`, a private `invalid()` like `tasks.rs:70`, and `#[cfg(test)] mod tests`)
- Modify: `src-tauri/src/workspace/models.rs:162` (`Workspace` gets `#[serde(default = "empty_object")] pub today: Value`)
- Modify: `src-tauri/src/workspace/mod.rs`:
  - `mod today;`
  - `WIDGET_IDS` (:1930) gains `"notes"` and `"timer"`
  - the `Operation::LayoutSave` branch (:846–899) reads `today`
  - the Workspace literal at :838 gets `today: json!({})`
- Modify: `src-tauri/src/workspace/repository.rs:94`, `:1701` (`today: json!({})`)
- Modify: `src-tauri/src/workspace/automations/engine.rs:327-335`. When delivery turns on and `automations` is pushed onto `layout`, also remove `"automations"` from `w.today["hidden"]` if it is there.
- Create: `ui/test/fixtures/contract/today-layout.json` (generated)
- Modify: `ui/test/fixtures/workspace-fixture.mjs:143-144` (`today: {}` on both workspaces)
- Modify: `ui/test/browser/workspace-e2e.mjs`:
  - the mock's `layout_save` (:224) records `calls.push(['layout_save', clone(d)])`, sets `layout` only when given, stores `today` when given, and keeps `widgetWidths` when absent
  - the mock keeps `s.workspaces` in `sessionStorage['e2e.workspaces']` after each `layout_save`, and its init reads it back when present, so `page.reload()` keeps saved layouts
  - `open()` (:1145) gains a `workspace` option (an object merged onto the active workspace before the snapshot is installed)

**Interfaces:**
- Produces: `pub(in crate::workspace) fn valid_today(v: &Value) -> Result<Value>`. It returns the checked object with only the keys `active`, `items`, `layouts`, `titles`, `options` and `hidden`. Items keep only `id x y w h collapsed prevH`.
- Every refusal is `invalid("today", "Invalid Today layout.")`.
- Produces: the snapshot's workspace record carries `today` (`{}` until saved), and `layout_save {today, layout}` saves both.
- Produces for the browser run: `open({ workspace: {...} })` and recorded `layout_save` calls.

- [ ] **Step 1: Write the failing tests** in `today.rs`, over `test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready())` with `mutation(&core, Operation::LayoutSave, …)` (`quiet_core` is private to `mod.rs` tests):
  - `layout_saves_the_today_grid`:
    - Save `{"layout": ["brief","focus"], "today": {"active":"Default","items":[{"id":"brief","x":0,"y":0,"w":8,"h":4},{"id":"focus","x":8,"y":0,"w":4,"h":4,"collapsed":false}],"layouts":{"Default":[{"id":"brief","x":0,"y":0,"w":8,"h":4},{"id":"focus","x":8,"y":0,"w":4,"h":4}],"Mine":[{"id":"notes","x":0,"y":0,"w":4,"h":6}]},"titles":{"brief":"Next up"},"options":{"inbox":{"max":"3","sources":["mail"]}},"hidden":["plugins"],"extra":1}}`.
    - Assert that `w.today` equals the input without `"extra"`, and that `w.layout == ["brief","focus"]`.
  - `layout_refuses_a_broken_today_grid`. Each case gives `code == "validation"`, `message == "Invalid Today layout."` and `field == Some("today")`:
    - overlapping items (`x0 w6` and `x4 w6` on the same row)
    - `x:7,w:6`
    - `w:1`
    - `h:0`
    - `h:25`
    - `y:401`
    - 17 items
    - a repeated id
    - `"weather"`
    - a title of 41 characters
    - 16 entries in `layouts`
    - a layout named `""`
    - an option value `{"a":{"b":1}}`
    - an options list of 9 strings
    - options of 9 KB
    - `items` that is not an array
  - `layout_accepts_notes_and_timer`: `{"layout":["notes","timer"]}` saves.
  - `turning today delivery on brings back a hidden automations card` (in `automations/engine.rs` tests, or here through `Operation::AutomationSave`): with `today.hidden = ["automations"]` and `layout` without it, saving an automation with `deliver.today` on gives `layout` containing it and `hidden` empty.
  - `contract_fixtures_match_the_today_layout`: `crate::plugins::testkit::contract_fixture("today-layout.json", &json!({"layout": w.layout, "widgetWidths": w.widget_widths, "today": w.today}))` after the first test's save.

- [ ] **Step 2: Run them and see them fail.** Run: `cd src-tauri && cargo test --lib today`. Expected: compile errors (`valid_today` and the `today` field missing).

- [ ] **Step 3: Implement.**
  - Write `valid_today` against the spec's storage section. Overlap is `a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y`. Check each saved layout like `items`. The 8 KB limit is `serde_json::to_vec(options).len()`.
  - In `LayoutSave`, after the `layout` block: `if let Some(t) = req.data.get("today") { w.today = today::valid_today(t)?; }`.
  - Add the field, the defaults, the two ids and the engine's un-hide.

- [ ] **Step 4: Change the mock and `open()`** as listed under Files.

- [ ] **Step 5: Run the tests, write the fixture, and see them pass.**
  - Run: `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures_match_the_today_layout && cargo test --lib workspace`. Expected: `test result: ok`, and `today-layout.json` is written.
  - Run: `npm test`. Expected: no failures.

- [ ] **Step 6: Commit.**
  ```bash
  git add src-tauri/src/workspace ui/test/fixtures ui/test/browser/workspace-e2e.mjs
  git commit -m "feat(workspace): store the Today grid with layout_save and check it natively"
  ```

---

### Task 2: Grid engine and the Today grid view

**Files:**
- Create: `ui/workspace/today-grid.js`
- Modify: `ui/workspace/view-today.js`:
  - `WIDGETS` gets `h`, `minW`, `minH` and `options` defs, plus the new `notes` and `timer`
  - `today()` draws tiles from the grid
  - widget bodies honour their options
  - Notes moves out of `commitmentsCard`
  - a `timerCard`
  - the empty state's button becomes `today-customize` (:107)
  - the page wrapper gets the class `ws-today-page` (`.ws-today` is also a Calendar cell class)
- Modify: `ui/workspace/view-meetings.js:413` (`showMeetingsCard`) and `ui/workspace/today-plugins.js:162` (`showPluginsCard`): false when `w.today.hidden` includes the card or `w.today.items` places it, and the legacy rule is kept for workspaces with no `today`
- Modify: `ui/workspace/workspace.css`:
  - `.ws-tiles` and `.ws-tile` placed by CSS variables
  - `.ws-tile { container-type: size }`, with a fixed height in the stacked layout too
  - the container rules from the spec
  - `.ws-today-page { container-type: inline-size }`, and `@container (max-width: 639px)` makes the tiles static and ordered by `--order`
- Test:
  - `ui/test/today-grid.test.mjs` (new)
  - `ui/test/workspace.test.mjs`: Today view cases at :816, :852 and :1060 that assert `ws-span-*`, card order or `customize`
  - `ui/test/settings-plugins.test.mjs:243`, `:297-303` (plugin widgets with an empty catalog, and `showPluginsCard` with `today`)

**Interfaces:**
- Consumes: the `w.today` shape and `today-layout.json` from Task 1.
- Produces (`today-grid.js`):
  - `GRID = { cols: 12, rowHeight: 56, gap: 16, stackBelow: 640, maxItems: 16, maxLayouts: 15, maxOwnLayouts: 12 }`
  - `PRESETS`: `Default`, `Focus` and `Meeting day`:
    - **Default:** `brief 0,0,8,4` · `focus 8,0,4,4` · `calendar 0,4,6,7` · `inbox 6,4,6,7` · `commitments 0,11,8,6` · `notes 8,11,4,6` · `meetings 0,17,6,5` · `automations 6,17,6,5`
    - **Focus:** `brief 0,0,8,3` · `timer 8,0,4,3` · `commitments 0,3,8,7` · `notes 8,3,4,7` · `inbox 0,10,6,5` · `calendar 6,10,6,5`
    - **Meeting day:** `brief 0,0,6,4` · `calendar 6,0,6,9` · `meetings 0,4,6,5` · `inbox 0,9,6,6` · `commitments 6,9,6,6`
  - `compact(items, held = null): items` (mutates; items overlapping `held` first slide to the nearest free x in their row)
  - `moveItem(items, id, x, y, orig): items` and `resizeItem(items, id, w, h, orig, def): items` (new arrays; the others start from `orig`; x, w and h clamped)
  - `placeAtTop(items, item): items`, `removeItem(items, id): items`
  - `fromLegacy(layout, widgetWidths, defs): items`
  - `todayOf(w, defs): {active, items, layouts, titles, options, hidden}`, following the spec's "Moving to the new grid": `widgetWidths` `{}` gives Default, otherwise "My layout" from `fromLegacy`, and legacy auto-card width keys go into `hidden`
  - `autoCards(w, today, wanted): string[]`: ids in `w.layout`, or wanted by `showMeetingsCard` / `showPluginsCard`, that are not in `items` and not in `hidden`
  - `layoutChanged(today, name): boolean` (built-ins only; compares id, x, y, w, h and collapsed, ignoring order)
  - `payloadOf(today): {today, layout}`. `layouts[active]` mirrors `items`, and `layout` is the ids sorted by y, then x.
  - `sizeName(w): string`, `optionsOf(today, id, def): object`
- Produces (`view-today.js`):
  - each tile is `<section class="ws-card ws-tile" data-tile="<id>" style="--x:..;--y:..;--w:..;--h:..;--order:..">` with `.ws-tile-head` (grip button `.ws-tile-grip`, title `h2`, extras `.ws-tile-extra`, `data-action="today-options"` and `data-action="today-menu"` buttons), `.ws-tile-body`, and handles `.ws-rz[data-edge=r|b|c]`
  - the grid is `<div class="ws-tiles" data-today-grid style="--rows:N">`
  - `export function tileDefs(pluginCatalog)`
  - `today(s, ctx)` reads `ctx.pluginsKnown` to decide whether a plugin item is unavailable

- [ ] **Step 1: Write the failing tests.** In `today-grid.test.mjs`:
  - `a held widget swaps places with the one beside it`: in Default, moving `focus` to x 0, y 0 gives `brief.x === 4 && brief.y === 0`.
  - `a widget that cannot slide drops below the held one`: widening `brief` to 12 gives `focus.y === 4`.
  - `compact floats widgets up and keeps x`
  - `resize clamps to the widget minimum and to the right edge`: `calendar` at x 6 asked for w 9 gives 6. Asked for w 1, it gives 2.
  - `todayOf gives Default to a never-customized workspace`: the seeded `layout` from `repository.rs:86` with `widgetWidths {}` gives `active 'Default'` and the Default items.
  - `todayOf turns a customized layout into My layout with Notes after Tasks`: `["brief","commitments","inbox"]` with `{brief:8, commitments:8, inbox:6}` gives `brief 0,0,8,4`, `commitments 0,4,8,6`, `notes 8,4,4,6`, `inbox 0,10,6,7` and `active 'My layout'`.
  - `todayOf hides an auto card the old layout hid`: `widgetWidths {meetings:6}` without `meetings` in `layout` gives `hidden ['meetings']`.
  - `todayOf reads the native fixture`: `today-layout.json` round-trips.
  - `autoCards shows an id in layout that the grid lacks, unless hidden`
  - `payloadOf orders layout ids by row then column and mirrors items into layouts[active]`
  - `layoutChanged ignores item order and own layouts`

  In `workspace.test.mjs`:
  - `Today draws tiles from the grid with their positions` (`--x:8;--y:0;--w:4;--h:4` on `focus`)
  - `Schedule draws an agenda list for narrow sizes` (`.ws-tl-agenda` present)
  - `Needs your reply shows the number of messages its options ask for`
  - `Tasks no longer draws Notes; Notes keeps the textarea id today-note`
  - `before plugins load a plugin widget still draws` (`pluginsKnown: false` with an empty catalog gives the placeholder tile)

  Then update the cases that are now stale (:816, :852, :1060; `settings-plugins.test.mjs:243`, `:297-303`) to the grid's markup and rules.

- [ ] **Step 2: Run them and see them fail.** Run: `node --test ui/test/today-grid.test.mjs ui/test/workspace.test.mjs ui/test/settings-plugins.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement `today-grid.js`.** The packing is the prototype's `compact` in `prototypes/today-customize/proto-today.js`.

- [ ] **Step 4: Rework `view-today.js` and the CSS.** Tile CSS:
  - `left: calc((100% - 11*16px)/12*var(--x) + 16px*var(--x))`
  - `width: calc((100% - 11*16px)/12*var(--w) + 16px*(var(--w) - 1))`
  - `top: calc(var(--y)*72px)`, `height: calc(var(--h)*56px + (var(--h) - 1)*16px)`

- [ ] **Step 5: Run the tests and see them pass.** Run: `npm test`. Expected: no failing test.

- [ ] **Step 6: Commit.**
  ```bash
  git add ui/workspace/today-grid.js ui/workspace/view-today.js ui/workspace/view-meetings.js ui/workspace/today-plugins.js ui/workspace/workspace.css ui/test
  git commit -m "feat(today): draw Today from a 12-column grid with sizes, options, Notes and Focus timer"
  ```

---

### Task 3: Arranging Today by hand

**Files:**
- Create: `ui/workspace/press.js` (the shared press tracker)
- Create: `ui/workspace/today-controller.js`
- Create: `ui/workspace/today-edit-view.js` (pure: edit bar, gallery, widget ⋯ menu as `details.ws-menu[data-menu]` so `render()` keeps it open, options panel, layouts menu)
- Modify: `ui/workspace/app.js`:
  - add a `layoutDrag` flag. `render()` starts with `if (layoutDrag) { heldRender = true; return; }`, and the subscribe hold (:2496) checks it too.
  - create `todayUi` and call `attachTodayDrag`, whose `dragging(false)` runs only after the drop's save settles, then `if (heldRender) render()`
  - route `today-*` actions
  - `handle(action, el, ev)`, with the click listener (:1929) passing `ev`
  - the gallery search input listener
  - `today-layout-save` through `submitForm` (:1882)
  - ⌘Z / ⇧⌘Z outside text fields
  - delete `customizeDialog` (:1383) and the `customize` case (:1850)
- Modify: `ui/workspace/view-today.js` (the header gets the layout menu, lock, "Add widget" and "Customize" `data-action="today-customize"`; edit mode adds the edit bar, gallery, × and the add tile)
- Modify: `ui/workspace/icons.js` (`layout`, `hand`, `redo`, `collapse`, `expand`, `sidebar-open`, `sidebar-close`, `split`, `max`, `min`, copied from `prototypes/today-customize/proto-icons.js`)
- Modify: `ui/workspace/workspace.css` (lifted tile, placeholder, guides, handles, badge, gallery, options panel, `ws-handles-always` / `ws-handles-customize`, `ws-locked`, reduced motion)
- Modify: `ui/test/browser/workspace-e2e.mjs` (the Customize dialog check at :1289 now goes through Customize mode and the gallery; the `.ws-grid` selector at :3035 becomes `.ws-tiles`)
- Test: `ui/test/today-controller.test.mjs` (new)

**Interfaces:**
- Consumes: `today-grid.js`, `tileDefs` and `autoCards` from Task 2, and `layout_save {today, layout}` from Task 1.
- Produces (`press.js`): `trackPress(ev, { threshold = 4, longPress = 0, cursor, onStart(ev, {sx, sy}), onMove(ev, {dx, dy}), onEnd(ev, {dx, dy}), onCancel() })`. It listens on `window` with no pointer capture, and long-presses only for non-mouse pointers. A released point that differs from the last move counts as a final move. Escape cancels, and it swallows the click after a drag. This is the prototype's `P.drag`.
- Produces:
  - `createTodayController({ state, snap, mutate, render, toast, prefs, announce, now })` returns `{ handle(action, el, ev), moveTo(id, x, y, orig), resizeTo(id, w, h, orig), commit(nextToday, before, message?): Promise, undo(), redo(), locked(): boolean, stacked(): boolean }`
    - `state.today = { editing: false, history: [], future: [], options: null, gallery: '' }`
  - `attachTodayDrag(doc, ui, { dragging, fail })` handles:
    - pointer move on `.ws-tile-head` (not its buttons), resize on `.ws-rz`, and gallery drag on `.ws-gallery-card`
    - keyboard on `.ws-tile-grip`, and double-click on `.ws-tile-head h2` (rename)
    - long press: 380 ms on a header, 0 ms in Customize, 220 ms on a gallery card
  - Actions: `today-customize`, `today-done`, `today-undo`, `today-redo`, `today-lock`, `today-key`, `today-add`, `today-remove`, `today-width` (`data-w`), `today-height` (`data-h`), `today-collapse`, `today-top`, `today-options`, `today-rename`, `today-layout-use` (`data-name`), `today-layout-save`, `today-layout-reset`, `today-layout-delete`, `today-gallery-search`

- [ ] **Step 1: Write the failing tests** in `today-controller.test.mjs`. Use a harness like `tasks-controller.test.mjs::harness`: a fake `mutate` that applies `layout_save` to the active workspace, and records `toast` and `render` calls.
  - `moving a widget saves the grid once with the layout order`: `moveTo('focus',0,0)` then `commit` gives one `layout_save` whose `layout` starts `['focus','brief']`.
  - `undo saves the layout from before the change and redo the one after`
  - `a refused save puts the widgets back and shows the message`: `mutate` rejects `{code:'validation', message:'Invalid Today layout.'}`, so `today` is unchanged, `render` is called and the toast says `Invalid Today layout.`.
  - `locked: moving does nothing and the toast offers Unlock`: `prefs codemie.layout.locked = "1"` gives no mutate, and the toast `Layouts are locked` has action label `Unlock`.
  - `Add puts the widget at the top left and pushes the others down`: `timer` lands at 0,0 and `brief.y` becomes 3.
  - `removing a widget toasts with Undo, and removing an auto card hides it`
  - `switching layouts keeps the changes of the layout left`
  - `Reset brings a built-in layout back; an own layout can be deleted; an own layout can't take a built-in name`
  - `a title is saved on Enter or blur, not per keystroke`
  - `an unavailable widget is skipped in the view and kept in the save` (`pluginsKnown` true, and `plugin:gone:w` is kept below the visible ones with no overlap)
  - `a stacked grid ignores moves and resizes`
  - `keyboard: ArrowRight moves one column, Shift+ArrowDown adds a row, Delete removes` (`handle('today-key', el, {key, shiftKey})`)

- [ ] **Step 2: Run them and see them fail.** Run: `node --test ui/test/today-controller.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement `press.js`, the controller and the edit view.**
  - The pointer logic follows `prototypes/today-customize/proto-today.js`:
    - take the offset from `sx`/`sy`;
    - Escape restores `orig`;
    - auto-scroll `#workspace-main` near its edges.
  - The live drag moves the DOM directly, and `commit` runs once on drop. It calls `compact([...visible, ...unavailable])` before `mutate`. On a refusal it restores `before`, calls `render()` and toasts the message.

- [ ] **Step 4: Wire `app.js`, the header and the browser checks** listed under Files.

- [ ] **Step 5: Run the tests and see them pass.**
  - Run: `npm test`. Expected: no failing test.
  - Outside the sandbox, run the full browser run: `PLAYWRIGHT_CORE=… node ui/test/browser/workspace-e2e.mjs`. Expected: every existing check passes.

- [ ] **Step 6: Commit.**
  ```bash
  git add ui/workspace/press.js ui/workspace/today-controller.js ui/workspace/today-edit-view.js ui/workspace/app.js ui/workspace/view-today.js ui/workspace/icons.js ui/workspace/workspace.css ui/test
  git commit -m "feat(today): move, resize, add and remove widgets by hand, with saved layouts, lock and undo"
  ```

---

### Task 4: Section engine, then Inbox and Calendar on it

**Files:**
- Create: `ui/workspace/dock-model.js` (pure), `ui/workspace/dock-view.js` (pure), `ui/workspace/dock-controller.js` (uses `press.js`)
- Modify: `ui/workspace/view-inbox.js`:
  - `export const INBOX_DOCK`
  - `inboxSections(s, ctx)` returns `{'inbox-list': html, 'inbox-reader': html}`
  - `inbox()` renders through `renderDock`
- Modify: `ui/workspace/view-calendar.js`:
  - `CALENDAR_DOCK`, `calendarSections`, and `calendar()` the same way
  - the `.ws-cal-collapsed` markup and the sidebar toggle become the dock's collapse of `cal-side`
- Modify: `ui/workspace/app.js`:
  - `ctx.dock = { layouts, locked }` through `loadDock`
  - call `attachDock` (its `dragging` shares `layoutDrag`)
  - `dock-*` actions
  - the `calendar-sidebar` case (:1622) calls the dock's `setCollapsed('calendar', …)`
  - the first `loadDock('calendar')` with no stored layout reads `codemie.calendar.sidebar` once
  - the Calendar arrow keys (:2147) skip `ev.target.closest('.ws-split, [role=tab], .ws-tile-grip')`
- Modify: `ui/workspace/workspace.css` (`.ws-dock`, `.ws-pane`, `.ws-pane-strip`, `.ws-dock-tab`, `.ws-split`, rail, drop zone and bar, tab ghost, sideways scroll; remove the ≤1180 px calendar side auto-hide at :904)
- Test: `ui/test/dock-model.test.mjs` (new), `ui/test/workspace.test.mjs` (Inbox and Calendar view cases)

**Interfaces:**
- Produces (`dock-model.js`):
  - `normalizeDock(def, saved): {panes: [{id, tabs, active, w, collapsed}], max: null | {[id]: bool}}`
    - `def` is `{tabs: {[id]: {title, icon, min, w, pin?}}, initial: string[][]}`
  - `resizePair(layout, def, i, startA, startB, dx): layout` (the 55% rule; never collapses the last open section)
  - `moveTab(layout, def, tab, target): {layout, message}`
    - `target` is `{type: 'tab', pane, index}`, `{type: 'merge', pane}`, `{type: 'split', pane, side}` or `{type: 'between', index}`
  - `swapPanes(layout, id, dir)`, `setCollapsed(layout, def, id, on): {layout, refused?}`, `toggleMax(layout, id)`
  - `visibleTabs(layout): string[]` (the active tab of each open section)
  - `loadDock(storage, page, def, legacy = null)` and `saveDock(storage, page, layout)`
    - key `codemie.layout.<page>.v1`; `storage` is `{getItem, setItem}`
    - `legacy` is `{collapse: [tabId]}`, applied only when nothing is stored
- Produces (`dock-view.js`):
  - `renderDock(page, def, layout, renderTab, { locked = false, before = () => '' }): string`
    - `.ws-pane[data-pane]` with an inline `flex: <w> 1 0px; min-width: <min>px`
    - `.ws-split[role=separator][tabindex=0][data-split=i][aria-valuenow]`
    - tabs `.ws-dock-tab[role=tab][data-action=dock-tab][data-page][data-tab]`
    - the rail `.ws-pane-rail`
    - `before(pane, index)` returns HTML above a pane's strip
- Produces (`dock-controller.js`): `attachDock(doc, { defs, layouts: {get(page), set(page, layout)}, render, toast, announce, dragging, locked, pin(widgetId), onToday(widgetId): boolean })`, handling:
  - split and tab drags (long press 300 ms)
  - keys on splits (←/→, Shift, Enter) and tabs (⌥⇧←/→)
  - double-clicks on splits and strips
  - actions: `dock-tab`, `dock-collapse`, `dock-expand`, `dock-menu`, `dock-move`, `dock-max`, `dock-beside`, `dock-pin`, `dock-reset`
  - `pin` is `todayUi.handle('today-add', …)`
- Produces: `INBOX_DOCK` and `CALENDAR_DOCK` with the spec's ids, minimum widths, default widths and pins

- [ ] **Step 1: Write the failing tests** in `dock-model.test.mjs`:
  - `normalize drops unknown tabs and adds missing ones to the last section`
  - `loadDock ignores unreadable storage` (`getItem` returns `'{'` or throws, giving the initial layout)
  - `loadDock carries the old calendar sidebar choice once` (`legacy {collapse:['cal-side']}` with nothing stored gives `cal-side` collapsed, and a stored layout ignores `legacy`)
  - `pulling a divider past 55% of the minimum collapses that section`
  - `the last open section cannot collapse` (`refused: true`)
  - `a tab dropped on a section's right side opens a new section beside it with half its width`
  - `a tab dropped on another strip joins that section at the drop index`
  - `a section left without tabs is removed and its width goes to its neighbour`
  - `reordering inside one strip keeps the section`
  - `swapPanes moves a section left`
  - `toggleMax collapses the others and restores them`
  - `visibleTabs lists the active tab of each open section`
  - `renderDock draws separators with aria-valuenow, rails for collapsed sections and no grips when locked`

  In `workspace.test.mjs`:
  - `Inbox draws its two sections in the saved order`
  - `Calendar's sidebar toggle collapses the Calendars section`

- [ ] **Step 2: Run them and see them fail.** Run: `node --test ui/test/dock-model.test.mjs ui/test/workspace.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement the dock model, view and controller.** The behaviour follows `prototypes/today-customize/proto-dock.js`:
  - targets come from `elementFromPoint`;
  - the left or right 30% of a section is a split, and a strip is an insert;
  - drop positions add `dock.scrollLeft`;
  - widths sync from the DOM at drag start.

- [ ] **Step 4: Move Inbox and Calendar onto `renderDock`,** with the `app.js` changes listed under Files.

- [ ] **Step 5: Run the tests and see them pass.**
  - Run: `npm test`. Expected: no failing test.
  - Then the full browser run. Expected: the existing Inbox and Calendar checks pass.

- [ ] **Step 6: Commit.**
  ```bash
  git add ui/workspace/dock-model.js ui/workspace/dock-view.js ui/workspace/dock-controller.js ui/workspace/view-inbox.js ui/workspace/view-calendar.js ui/workspace/app.js ui/workspace/workspace.css ui/test
  git commit -m "feat(layout): resizable, movable page sections with dockable tabs on Inbox and Calendar"
  ```

---

### Task 5: Meetings and Automations on sections

**Files:**
- Modify: `ui/workspace/view-meetings.js`:
  - `MEETINGS_DOCK`
  - `meetings()` renders through `renderDock`
  - `detail()` splits into `meetingHeader(p, m)` and the tab bodies (`notesTab` … `peopleTab` exist in `view-meeting-tabs.js`)
  - the header goes through `before` on the first pane that holds a `mtg-*` meeting tab
- Modify: `ui/workspace/meetings-controller.js`:
  - the factory gains `dock: { layout(), collapse(id, on), visible(): string[] }`
  - `meeting-list-toggle` and compare mode call `dock.collapse('mtg-list', …)` instead of `view.wide`
  - `load()` (:130-140) reads for every visible meeting tab
  - `meeting-tab` maps `notes`↔`mtg-notes` …
  - `view.tab` follows the tab chosen last
- Modify: `ui/workspace/view-automations.js` (`AUTOMATIONS_DOCK`; the three tabs become dock tabs, and the heading stays above the dock)
- Modify: `ui/workspace/automations-controller.js` (`runLogOpen` (:41) is true when `auto-runs` is visible; `automations-tab` maps to `dock-tab`)
- Modify: `ui/workspace/app.js`:
  - pass `dock` to both controllers
  - opening a hash activates its tab wherever it is
  - the first `loadDock('meetings')` reads `codemie.meetings.wide` (:83) once
  - stop writing `codemie.meetings.wide` (meetings-controller.js:578)
- Modify (selectors that change):
  - `ui/test/browser/meetings-checks.mjs:75`, `:80` (`.ws-mtg-wide`)
  - `ui/test/browser/workspace-e2e.mjs:2456`, `:2475`, `:2506`, `:2516`, `:2547`, `:2609` (automations tabs)
  - `ui/test/meetings-controller.test.mjs:103-116`
- Test: `ui/test/meetings-controller.test.mjs`, `ui/test/automations.test.mjs`

**Interfaces:**
- Consumes: `renderDock`, `setCollapsed`, `visibleTabs`, `loadDock` and `saveDock` from Task 4.
- Produces: `MEETINGS_DOCK`, `AUTOMATIONS_DOCK` (the spec's ids and widths), and `meetingHeader(p, m): string`.

- [ ] **Step 1: Write the failing tests:**
  - `the meeting header shows once, above the first section holding a meeting tab`: put transcript on the left of notes in a split layout, and the header sits on the transcript pane.
  - `the list toggle collapses and expands the meeting list section`
  - `compare mode collapses the list and gives it back afterwards`
  - `with Notes and Transcript side by side both load` (`load()` reads the transcript and the notes docs)
  - `opening #/meetings/<id>/transcript activates Transcript in the section that holds it`
  - `the old wide preference collapses the list once`
  - `the Run log loads when it sits beside Automations`

- [ ] **Step 2: Run them and see them fail.** Run: `node --test ui/test/meetings-controller.test.mjs ui/test/automations.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement,** then update the selectors listed under Files.

- [ ] **Step 4: Run the tests and see them pass.**
  - Run: `npm test`. Expected: no failing test.
  - Outside the sandbox, the full browser run: `PLAYWRIGHT_CORE=… node ui/test/browser/workspace-e2e.mjs`. Expected: every check passes (meetings, automations, plugins and the rest).

- [ ] **Step 5: Commit.**
  ```bash
  git add ui/workspace/view-meetings.js ui/workspace/meetings-controller.js ui/workspace/view-automations.js ui/workspace/automations-controller.js ui/workspace/app.js ui/test
  git commit -m "feat(layout): Meetings and Automations sections: tabs side by side, collapsible meeting list"
  ```

---

### Task 6: Menus that collapse, folding Settings groups, and Settings → Layout

**Files:**
- Modify: `ui/workspace/shell.js`:
  - `renderShell` takes `sidebarCollapsed` and draws the existing ≤1050 px 64 px rail as `.ws-sidebar-rail`
  - `data-tip` labels and count dots
  - a "Collapse menu" button `data-action="sidebar-toggle"`
  - a `.ws-sidebar-edge`
- Modify: `ui/workspace/view-settings.js`:
  - `SETTINGS_TABS` gains `['', 'layout', 'Layout', 'layout']` after Appearance
  - group headers become `button.ws-nav-group[data-action=settings-group][aria-expanded][aria-controls]`
  - "Find a setting"
  - folded groups show counts and the existing `dot(id)` alerts
  - the menu shrinks to a rail
  - `.ws-settings-edge` (role separator)
- Create: `ui/workspace/settings-layout.js` (`layoutPanel(s, { prefs, docks, today })`, pure: the spec's five cards)
- Modify: `ui/workspace/app.js`:
  - prefs
  - actions `sidebar-toggle`, `settings-group` (⌥ from `ev.altKey`), `settings-groups-all`, `settings-menu-toggle`, `layout-lock`, `layout-handles`
  - the menu edges drag through `press.js`
  - ⌘\ and ⌘⇧\
  - a `.ws-tooltip` for rails
- Modify: `ui/workspace/workspace.css`
- Test: `ui/test/shell-nav.test.mjs`, `ui/test/settings-menu.test.mjs` (new)

**Interfaces:**
- Consumes: `todayOf` and `layoutChanged` (Task 2), `today-layout-*` (Task 3), `dock-reset` and `loadDock` (Task 4), `trackPress` (Task 3).
- Produces: `settings(s, ctx)` reads `ctx.menu = { folded: string[], collapsed: boolean, width: number, query: string }`, and `renderShell({ …, sidebarCollapsed })`.

- [ ] **Step 1: Write the failing tests:**
  - `a folded group hides its items but keeps the current one, with its count`: with Meetings folded and the current tab `meetings-templates`, the group shows count `5`, `meetings-templates` is drawn and `meetings-rules` is not.
  - `a folded group shows a dot when a hidden tab needs attention` (CodeMie folded with `tabDots` holding `cm-health`)
  - `search ignores folding and shows only matches` (`query 'temp'` gives only Note templates, even with Meetings folded)
  - `the shrunk menu draws icons with data-tip and no group names`
  - `the collapsed main menu draws the rail with dots for counts` (`renderShell`)
  - `Settings → Layout lists layouts with In use, Use, Reset and Delete, and each page with Reset`

- [ ] **Step 2: Run them and see them fail.** Run: `node --test ui/test/settings-menu.test.mjs ui/test/shell-nav.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement the views, the prefs wiring and the shortcuts.**

- [ ] **Step 4: Run the tests and see them pass.** Run: `npm test`. Expected: no failing test.

- [ ] **Step 5: Commit.**
  ```bash
  git add ui/workspace/shell.js ui/workspace/view-settings.js ui/workspace/settings-layout.js ui/workspace/app.js ui/workspace/workspace.css ui/test
  git commit -m "feat(settings): fold Settings menu groups, shrink both menus to icons, add Settings > Layout"
  ```

---

### Task 7: Browser scenarios, guides and the full gates

**Files:**
- Create: `ui/test/browser/layout-checks.mjs` (`export async function layoutChecks({ open, check, assert, shot, settled, OUT, calls })`)
- Modify: `ui/test/browser/workspace-e2e.mjs`:
  - import the check set
  - add `layout` to the `WORKSPACE_E2E_ONLY` list (:1185)
  - run it after the meetings checks in the full run
  - expose the mock's recorded calls to the check set
- Modify: `.ai-run/guides/architecture/architecture.md` (module rows for `today-grid.js`, `today-controller.js`, `today-edit-view.js`, `press.js`, `dock-*.js`, `settings-layout.js`; one line on where layouts are stored)
- Modify: `.ai-run/guides/testing/testing-patterns.md` (the `layout` check set, the `today-layout.json` fixture, `open({ workspace })`, the mock keeping workspaces across reloads)

**E2E scenarios.** Each is one `check(...)` with screenshots in `output/playwright/workspace-e2e/layout-*`. Mouse drags use `page.mouse` with `steps: 12`. A "reload" is `page.reload()`, which the mock survives (Task 1). Unless stated otherwise, a check opens with `workspace: { today: <Default preset as todayOf builds it> }`.

| # | Scenario | Steps | Expected |
|---|---|---|---|
| E1 | Move and swap; a redraw mid-drag | At 1440 px, dispatch pen `pointerdown` on the Day at a glance header and `pointermove` halfway. Then call `await window.__workspace.store.refresh()`, which triggers a redraw. Finish with `pointermove` and `pointerup` on Up next's left edge. Reload. | The tile is still under the pen after the refresh. Day at a glance is at x 0 and Up next at x 4, both y 0. Exactly one `layout_save` is recorded, and its `layout` starts `focus, brief`. After reload the order is the same. |
| E2 | Resize and adapting content | Pull Schedule's right edge 3 columns to the left, then its bottom edge down 2 rows. | The badge reads `3 × 7`, then `3 × 9`. The timeline hides and `.ws-tl-agenda` is visible. The saved Schedule is `w 3, h 9`. |
| E3 | Customize: gallery, remove, undo | Click Customize. Drag "Focus timer" from "Add to Today" onto row 0, column 0. Click × on Automation results. Click Undo in the toast. Click Done. | Focus timer is at 0,0 and the others moved down. Automation results comes back. The gallery's "On Today · 9" includes Focus timer. Done shows "Today is saved — every change is kept as you make it". |
| E4 | Widget menu, options, rename | On Tasks, ⋯ → Width 1/2, then Collapse. On Needs your reply, sliders → Messages shown 3. Double-click the Schedule title, type "My day" and press Enter. Reload. | Tasks is 6 wide with only its header. The reply list has 3 rows without closing the panel. After reload the title "My day", Tasks' size and the 3 rows persist. |
| E5 | Moving from older layouts, and saved layouts | **(a)** Open with the fixture's never-customized workspace (`widgetWidths {}`). **(b)** Open with `workspace: { layout: ['brief','commitments','inbox'], widgetWidths: {brief:8, commitments:8, inbox:6, meetings:6}, today: {} }`. Then switch to Focus, move a widget, switch back to "My layout", and use "Reset “Focus”". | **(a)** The Default layout, and no `layout_save`. **(b)** "My layout": brief 8 wide, then Tasks 8 with Notes 4 beside it, then Needs your reply 6. "From your meetings" stays hidden, and no `layout_save` is sent on open. Focus keeps its move until Reset, then matches the preset. |
| E6 | Lock, keyboard, touch | Turn the lock on and drag the Up next header with the mouse. Unlock. Tab to the Schedule grip, press → then Shift+↓, then Delete, and Undo. Dispatch touch `pointerdown`, then after 400 ms `pointermove` and `pointerup` on the Notes header. | Locked: nothing moves, and the toast "Layouts are locked" has Unlock. Keyboard: x + 1, then h + 1, then removed, then restored, and the live region announces each. The touch long press moves Notes. |
| E7 | Page sections | Open Meetings and drag the Transcript tab onto the right 30% of the Notes section. Pull the new divider 120 px. Pull the list's divider far to the left. Reload, then "Reset layout". On Calendar, press ← with the divider focused. On Inbox, ⋯ → Move section left on Message. | Two meeting sections, with the header once and above Notes, and both bodies loaded (the transcript lines and the notes text). Widths change. The list becomes a 42 px rail. The layout persists after reload, and Reset brings it back with a toast. On Calendar the divider moves and the week does not change. Inbox shows Message before Messages. |
| E8 | Menus, the narrow page, no overflow | In Settings, open Layout, fold Workspace, ⌥-click CodeMie, type "temp" in Find a setting, clear it, then shrink the menu with its button. Press ⌘\. Resize to 600 px on Today. Visit Today, Meetings and Settings at 1000, 1440 and 1680 px in both themes. | Workspace shows count 10 and still shows Layout. Only CodeMie (and the current item) stays open. The search shows Note templates. The rail is 58 px with tooltips. The main menu is the 64 px rail. At 600 px Today is one column, with no grips and no `layout_save`. No horizontal page overflow at any width (`scrollWidth <= clientWidth` on `#workspace-main`; the section row's own scroll excepted). |

- [ ] **Step 1: Write `layout-checks.mjs`** with E1–E8 as specified, using `check`, `assert`, `shot` and the recorded calls the way `meetings-checks.mjs` does.

- [ ] **Step 2: Run it.** Outside the sandbox: `WORKSPACE_E2E_ONLY=layout PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs`. Expected: 8 checks pass and screenshots are written. Fix failures in the task that owns the code, and commit those fixes separately.

- [ ] **Step 3: Run the full browser run** (the same command without `WORKSPACE_E2E_ONLY`). Expected: every check passes.

- [ ] **Step 4: Update the two guides** as listed under Files.

- [ ] **Step 5: Run the gates.** Run: `make check`. Expected: exit 0: fmt-check clean, clippy with no warnings, `npm test` and `cargo test` ok.

- [ ] **Step 6: Commit.**
  ```bash
  git add ui/test/browser .ai-run/guides
  git commit -m "test(layout): browser scenarios for Today, page sections and menus; guide updates"
  ```

---

## Manual checks after the plan (in the real app)

- A debug `.app` with `CODEMIE_WORKSPACE_TEST_DIR`: drag, resize and long press on a trackpad, in WKWebView.
- While dragging a widget over a plugin widget's frame on Today, the frame must not swallow `pointermove` (if it does, set `pointer-events: none` on frames during a drag).
- An existing personal data folder opens with its old layout in place, and nothing is saved until the first change.
