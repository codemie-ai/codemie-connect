# Calmer Meetings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Meetings page shows each thing once and colour only for what needs the person. Noisy meetings can be hidden from the list and brought back, and days fold.

**Architecture:** This is a UI-only change in `ui/workspace/`: the pure model (`meetings-model.js`), pure views (`view-meetings.js`, `view-meeting-tabs.js`, `markdown.js`), the controller (`meetings-controller.js`) and `workspace.css`. Hidden meetings are a window preference in `localStorage` (`codemie.meetings.hidden`), read once into the view state and written by the controller through `setPref`, like `codemie.calendar.hidden`. There is no native change and no contract fixture.

**Tech Stack:** Vanilla ES modules, `node:test`, and the Playwright browser run (`ui/test/browser/`).

**Spec:** `docs/superpowers/specs/2026-11-19-meetings-calm-design.md`. The visual reference is `prototypes/meetings-calm/index.html` (local, git-ignored; launch config `meetings-calm-prototype`, port 5213).

## Global Constraints

- **Branch.** `feat/meetings-calm`, cut from `workspace-app`; merge back into `workspace-app` (git-workflow R2). Conventional Commit subjects.
- **Purity.** `view-*.js`, `*-model.js` and `markdown.js` stay pure (state in, HTML out). Provider text goes through `escapeHtml`. A new control gets a `data-action` with the `meeting-` or `doc-` prefix, handled in `meetings-controller.js` (architecture, Patterns R3/R4).
- **No native change.** No new operation, record field or contract fixture. Hiding never stops checks, saves or automatic notes, and never changes Calendar badges or the event card.
- **Preference key.** `codemie.meetings.hidden` holds the JSON `{"ids": string[], "series": string[]}`. A series id is the event's `data.seriesId`; a meeting's own id is the event id.
- **Rows carry no buttons.** No `<button>` and no `[data-action]` other than the row itself inside `.ws-mtg-row`.
- **Every current action stays reachable.** This covers versions, compare, edit, make main, make again, delete, import, download again, check now, Make notes for all, *Always use this template*, plugins' call chips, `call.menu` and `call.minutes`, and the hash routes `#/meetings/<id>/<tab>`. An old `people` tab in a hash opens Notes.
- **Copy.** Use the exact words below. Filter menu: `All meetings`, `Needs you`, `With notes`, `Coming up`, `Meetings without a transcript (n)`, `Hidden meetings (n)`. List ⋯ menu: `Fold all days`, `Unfold all days`. Hiding: `Hide from the list`, `Hide every “<title>”`, `Show in the list again`, `Show every “<title>” again`, `Hidden from the list`, `Show again`, `N hidden meeting(s) · Show`. Header: `Review N task(s)`. Needs you card: `Make notes for N`.
- **Shell.** Use zsh. The browser run binds loopback, so run it outside the agent sandbox with `PLAYWRIGHT_CORE` set to a `playwright-core` install.
- **Overlap.** The unapproved plan `docs/superpowers/plans/2026-11-19-flexible-layout.md` Task 5 moves this page onto dock sections and still names `peopleTab` and `view.wide`. Whichever plan lands second rebases on the other. This plan drops the People tab and keeps `view.wide`.

## Review Focus

1. **A hidden meeting opened from Today, the Calendar card or a hash.** It must still open. The list shows it greyed while it is selected, and the header says `Hidden from the list · Show again`. Test: Task 1, `listModel keeps the selected hidden meeting`.
2. **Hiding the meeting that is on screen.** The next visible row opens, never a blank page; if it was the last one, the previous row opens. Test: Task 1, `hiding the selected meeting opens the next visible one`.
3. **A broken or old preference value** (`null`, invalid JSON, missing keys, non-string entries). The page must render as if nothing is hidden. Test: Task 1, `readHidden survives bad values`.
4. **A search while meetings are hidden.** Hidden matches show greyed, so a hidden meeting can always be found. Test: Task 1, `search finds hidden meetings`.
5. **A notes file whose first heading is not the meeting title, or with no front matter.** Nothing is dropped and nothing breaks. Test: Task 3, `renderMarkdown keeps a heading that is not the title, and text without front matter`.

---

### Task 1: The list — Needs you, folding days, the filter menu, quiet rows and hiding

**Files:**
- Modify: `ui/workspace/meetings-model.js`. Changes: `FILTERS` replaces `LANES` (:29); `newMeetingsView` (:54); `IN_LANE` gets `needs`; `meetingCounts` (:282); and the new `seriesOf`, `readHidden`, `isHidden`, `listModel`.
- Modify: `ui/workspace/view-meetings.js`. Changes: `list`, `row` and `rowExtra` (:161-229); `todayMeetingsCard` and `showMeetingsCard` (:413-442) take `hidden`; and the new `rowMenu(p)`.
- Modify: `ui/workspace/meetings-controller.js`, `handle` (:552):
  - new actions: `meeting-filter` (from a menu item), `meeting-show-none` and `meeting-show-hidden` (both now toggles), `meeting-search-open`, `meeting-day-fold`, `meeting-fold-all`, `meeting-unfold-all`, `meeting-needs-fold`, `meeting-hide`, `meeting-hide-series`, `meeting-unhide`;
  - `contextMenu(id, x, y)`;
  - Escape and the next click close the row menu.
- Modify: `ui/workspace/app.js`:
  - :83, seed `newMeetingsView({wide, hidden: readHidden(localJson('codemie.meetings.hidden', null))})`;
  - :218, `renderShell` gets `meetingsHidden`;
  - the Today ctx gets `meetingsHidden`;
  - `handle(action, el, opts)` passes `{alt: ev.altKey}` from the click listener (:1929) to `meetingsUi.handle`;
  - a `contextmenu` listener on `.ws-mtg-row` calls `meetingsUi.contextMenu` and prevents the default.
- Modify: `ui/workspace/shell.js:37` (`meetingCounts(s, now, undefined, meetingsHidden)`), `ui/workspace/view-today.js:81,88`.
- Modify: `ui/workspace/workspace.css`, the `.ws-mtg-list*` and `.ws-mtg-row*` rules, plus the new `.ws-mtg-needs`, `.ws-mtg-day-fold`, `.ws-mtg-hid`, `.ws-mtg-hid-foot` and `.ws-mtg-rowmenu`.
- Test: `ui/test/meetings-model.test.mjs`, `ui/test/workspace.test.mjs` (the list test at :751, the Today card test at :1045), `ui/test/meetings-controller.test.mjs`.

**Interfaces:**
- Produces, `meetings-model.js`:
  - `FILTERS: [id, label][]` = `[['all','All meetings'],['needs','Needs you'],['ready','With notes'],['upcoming','Coming up']]`.
  - `IN_LANE.needs = m => IN_LANE.process(m) || IN_LANE.attention(m)`. The `process` and `attention` lanes stay, because Today and `laneFor` use them.
  - `seriesOf(m) -> string|null`: `m.ev?.data?.seriesId || m.rec?.data?.seriesId || null`.
  - `readHidden(value) -> {ids: string[], series: string[]}`: string entries only, de-duplicated; anything else gives empty lists.
  - `isHidden(m, hidden) -> boolean`.
  - `newMeetingsView({wide, hidden})` adds `hidden`, `showHidden: false`, `searchOpen: false`, `folded: {}` (day key → true) and `needsFolded: false`, and keeps every existing field.
  - `meetingCounts(s, now, items, hidden = {ids: [], series: []})` leaves hidden meetings out of `process`, `attention` and `none`, and adds `hidden: number`.
  - `listModel(s, v, {now, zone, items}) -> {needs: Item[], days: {key, start, items: Item[]}[], hiddenCount: number}`:
    - `needs` is filled only for `v.filter === 'all'`: the needs lane minus hidden ones, newest first.
    - `days` holds the rest of the lane, newest first, grouped by `dayKey(start, zone)`.
    - In `all` it also holds today's `upcoming` meetings, at the top of today.
    - Hidden meetings are left out unless `v.showHidden`, `v.q` matches them, or they are `v.selected`.
  - `listOrder(model, v) -> string[]`: the ids in screen order. It starts with `needs` unless `v.needsFolded`, then the items of each day not in `v.folded`. `key()` (controller :216), `ensureSelection()` (:120), `meeting-filter`, the hide action and `selectedOf` (`view-meetings.js:356`) use it instead of `meetingRows`.
- Produces, `meetings-controller.js`:
  - `handle(action, el, {alt = false} = {})`.
  - `contextMenu(id: string, x: number, y: number) -> Promise<void>` sets `view.rowMenu = {id, x, y}` and renders.
  - `hideItems(m)` is shared with Task 2's ⋯ menu. It is exported from `view-meetings.js` as `hideMenuItems(m, hidden) -> menuItems entries`.
- Produces, `view-meetings.js`: `todayMeetingsCard(s, now, hidden)`, `showMeetingsCard(w, s, now, hidden)`.

- [ ] **Step 1: Write the failing model tests** in `ui/test/meetings-model.test.mjs`, on `withMeetings(buildSnapshot(NOW))` with one event given `data.seriesId = 'series-standup'` on two occurrences:
  - `readHidden survives bad values`: `readHidden(null)`, `readHidden('x')`, `readHidden({ids: [1, 'a', 'a']})` give `{ids: []|['a'], series: []}` as appropriate.
  - `isHidden by id and by series`: true for the hidden id, and true for both occurrences once `'series-standup'` is in `series`.
  - `meetingCounts leaves hidden meetings out`: hiding a `failed` meeting lowers `attention` by 1 and sets `hidden: 1`.
  - `listModel puts the needs lane in a card and the rest in days`:
    - `needs` holds every `available`/`downloaded`/`failed`/`blocked` item, newest first;
    - no `needs` item appears in `days`;
    - today's `upcoming` item is first in today's day.
  - `listModel keeps the selected hidden meeting`: with `v.selected` hidden and `showHidden: false`, it is in `days` and `hiddenCount` still counts it.
  - `search finds hidden meetings`: `v.q` = a hidden meeting's title returns it.
  - `with filter needs, there is no card`: `needs` is `[]` and `days` holds the needs lane.
  - `listOrder follows the screen`: the needs ids come first, then the days. Folding a day drops its ids, `needsFolded` drops the card's ids, and hidden ids are absent.
- [ ] **Step 2: Run** `node --test ui/test/meetings-model.test.mjs`. Expected: the new tests FAIL (`readHidden` is not a function).
- [ ] **Step 3: Implement** the model interfaces above in `meetings-model.js`. Replace `LANES` with `FILTERS` and update its only importer, `view-meetings.js:17`.
- [ ] **Step 4: Run** the model tests. Expected: PASS.
- [ ] **Step 5: Write the failing view tests** in `ui/test/workspace.test.mjs`. Replace the list test at :751 with:
  - `meetings list: one header row with search, filter and more; no segmented filter, no bulk banner, no footer switch`:
    - `.ws-mtg-list-head` holds exactly 3 buttons (`meeting-search-open`, a filter `details.ws-menu`, a ⋯ `details.ws-menu`);
    - there is no `.ws-mtg-filters`, `.ws-mtg-bulk` or `.ws-mtg-list-foot`.
  - `meetings list: Needs you card with Make notes for N, rows without buttons`:
    - `.ws-mtg-needs` lists the needs items and contains `Make notes for 2` (fixture: two `downloaded`/`available` without a run);
    - every `.ws-mtg-row` contains no `<button` and no `data-action=` other than its own;
    - a `ready` row has no `ws-tone-success`.
  - `meetings list: a folded day shows its count and a dot for what needs you`: with `folded: {[todayKey]: true}`, today's group has no rows, says `N meetings`, and shows `●` when a meeting there has tasks to review.
  - `meetings list: hidden meetings leave the list and come back greyed`:
    - with one id hidden, the row is gone and the list ends with `1 hidden meeting · Show`;
    - with `showHidden: true` it is back with class `ws-mtg-hid` and the text `Hidden`.
  - `sidebar count and Today card leave hidden meetings out`: `renderShell({…, meetingsHidden})`'s Meetings count and `todayMeetingsCard(s, NOW, hidden)` both drop the hidden `failed` meeting.
- [ ] **Step 6: Run** `node --test ui/test/workspace.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 7: Implement** `list`, `row` and `rowMenu` in `view-meetings.js`, the CSS, and the `shell.js` and `view-today.js` call sites:
  - Rows show the title in Geist (`font-family: var(--font-sans)`), then the grey line `time · document name or N documents · n to review`.
  - Tone classes appear only on the exception states listed in the spec.
  - `rowMenu(p)` draws `menuItems` in a fixed panel at `p.v.rowMenu.x/y` with `Open`, then `hideMenuItems(m, hidden)`, `-`, then `Show in calendar`.
  - Keep the transcripts-off notice.
- [ ] **Step 8: Run** the view tests. Expected: PASS.
- [ ] **Step 9: Write the failing controller tests** in `ui/test/meetings-controller.test.mjs`, using `harness()`:
  - `hide saves the preference and Undo brings it back`:
    - `handle('meeting-hide', control({id}))` makes `calls.prefs` end with `['codemie.meetings.hidden', JSON with ids [id]]`;
    - the last toast has `action.label === 'Undo'`, and running it empties `ids` and saves again.
  - `hide every in a series`: `meeting-hide-series` adds the `seriesId`. `meeting-unhide` on any occurrence removes both the id and its series.
  - `hiding the selected meeting opens the next visible one`: the selection moves to the next row of `listModel`, or the previous row when it was last.
  - `a day folds; alt keeps only that day open; fold all and unfold all`:
    - `handle('meeting-day-fold', control({day: k}), {alt: true})` leaves `folded` with every shown day except `k`;
    - `meeting-unfold-all` gives `{}`.
  - `the filter menu keeps the selection visible`: `meeting-filter` with `filter: 'ready'` selects the first ready row when the selected one isn't ready (today's behaviour, now with `needs`).
  - `contextMenu opens the row menu and Escape closes it`.
  - `↑/↓ skips folded days and hidden meetings`: `key({key: 'ArrowDown'})` from the last needs row lands on the first row of the first unfolded day.
- [ ] **Step 10: Run** `node --test ui/test/meetings-controller.test.mjs`. Expected: FAIL.
- [ ] **Step 11: Implement** the controller actions, `contextMenu` and the `app.js` wiring listed under Files. Persist with `setPref('codemie.meetings.hidden', JSON.stringify(view.hidden))`, and toast with `{label: 'Undo', run}` as `tasks-controller.js:155` does.
- [ ] **Step 12: Run** `npm test`. Expected: all pass. Fix any older test that still names `LANES`, the segmented filter or `meeting-show-none` as a checkbox.
- [ ] **Step 13: Commit.** `git commit -m "feat(meetings): a calmer list: Needs you first, days that fold, hide noisy meetings"`

---

### Task 2: The meeting — title once, people as faces, no status strip, tabs only with a transcript

**Files:**
- Modify: `ui/workspace/view-meetings.js`:
  - `peopleLine`, `seg`, `segBtn` and `statusStrip` (:233-304) go; `peopleStack` and `runLine` replace them;
  - `meetingMenu` (:306) adds `hideMenuItems`;
  - `detail` (:326-346).
- Modify: `ui/workspace/view-meeting-tabs.js`: `peopleTab` (:587) becomes `peopleList(p, mc)`, the popover body.
- Modify: `ui/workspace/meetings-model.js`: `TABS = ['notes','transcript','tasks','files']`, `TAB_LABELS` without `people`, the new `tabsOf(m)`, and `parseHash` mapping an unknown tab to `notes`.
- Modify: `ui/workspace/meetings-controller.js`: `meeting-tab` with `people` falls back to `notes`; `meeting-people-all` stays and is used inside the popover.
- Modify: `ui/workspace/workspace.css`: `.ws-mtg-head*`, the new `.ws-mtg-stack` and `.ws-mtg-runline`, and the strip rules removed.
- Test: `ui/test/workspace.test.mjs` (the detail test at :796, the plugin call-slot test at :1102), `ui/test/meetings-model.test.mjs`.

**Interfaces:**
- Consumes: `hideMenuItems(m, hidden)`, `isHidden`, `view.hidden` from Task 1.
- Produces:
  - `tabsOf(m) -> string[]`: `TABS` for states `available | downloaded | ready | failed` or while `m.run` saves or makes notes; otherwise `[]`.
  - `runLine(p, mc) -> string`: the strip's two `run` branches (:258-266) as one line under the header. It keeps `role="progressbar"` and Cancel `meeting-cancel`.
  - `peopleStack(p, mc) -> string`: a `details.ws-menu` whose summary holds up to 4 avatars and `N people`, and whose panel is `peopleList(p, mc)`.
  - `statusStrip` is no longer exported. Before removing it, grep for importers; none outside this file is expected.

- [ ] **Step 1: Write the failing tests.**
  - Replace `ui/test/workspace.test.mjs:796` with `meeting detail: the title once, one meta line with faces, no strip, four tabs`:
    - the title text appears once in `.ws-mtg-head`;
    - `.ws-mtg-stack` says `6 people`, and its panel lists each name with `organizer`, `you` and the company, and `ws-mtg-quiet` for one who didn't speak;
    - there is no `.ws-mtg-strip` and no People tab;
    - tabs read `Notes`, `Transcript`, `Tasks 2`, `Files`, with a count only on Tasks while 2 tasks wait for review;
    - the header has `Review 2 tasks` with `data-action="meeting-tab" data-tab="tasks"`, and no `Another summary` or `Make notes` button.
  - Add `an upcoming, blocked or pending meeting shows its explainer and no tabs`: no `.ws-mtg-tabs`, and the explainer card's actions (`Import transcript file`, `Check now`) are present.
  - Add `a running notes job shows one run line with Cancel`: one `[role=progressbar]` and `meeting-cancel`.
  - Add `the meeting's ⋯ menu offers Hide from the list, and a hidden meeting says so`: the menu has `meeting-hide`; with the meeting hidden, the header shows `Hidden from the list` and a `meeting-unhide` `Show again`.
  - In `meetings-model.test.mjs`, add `tabsOf gives four tabs with a transcript and none without` and `a #/meetings/<id>/people hash opens notes`.
- [ ] **Step 2: Run** `node --test ui/test/workspace.test.mjs ui/test/meetings-model.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `tabsOf`, `runLine`, `peopleStack`/`peopleList`, the header and the CSS:
  - The header shows the title, then the meta line (`day · start–end · Teams or place`, then `peopleStack`, then the hidden note).
  - On the right: `Review N tasks` when `mc.review.length`, the plugins' `pluginChips`, then `meetingMenu`.
  - Plugins' `pluginLines` stay under `runLine`.
  - `primaryAction` stays exported for `meetingCard` and is no longer called by `detail`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, including the plugin call-slot test at :1102.
- [ ] **Step 5: Commit.** `git commit -m "feat(meetings): the meeting's title once, people as faces, no status strip"`

---

### Task 3: Notes and Tasks — one toolbar, the document as a page, quiet task rows

**Files:**
- Modify: `ui/workspace/markdown.js`: `renderMarkdown(md, opts)` (:139) and `frontMatter` (:27).
- Modify: `ui/workspace/view-meeting-tabs.js`:
  - `notesTab` (:259-292) and `docCard` (:221-257) split into `docToolbar`, `docPage` and `docFoot`;
  - `docBody` (:205) passes `{front: 'tags', dropTitle: mc.d.title || mc.m.title}`;
  - `tasksTab` (:497).
- Modify: `ui/workspace/workspace.css`:
  - removes `.ws-mtg-doctab*` and the doc card border;
  - adds `.ws-mtg-doctools`, `.ws-mtg-docpage` (max-width 720px, `var(--font-sans)` 15px), `.ws-mtg-docfoot`, `.ws-md-tags`, `.ws-mtg-subrun`, and task chips (`.ws-mtg-task .ws-select`, borderless until hover).
- Test: `ui/test/markdown.test.mjs`, `ui/test/workspace.test.mjs`, `ui/test/meetings-controller.test.mjs` (the compare and edit tests keep passing).

**Interfaces:**
- Consumes: `tabsOf` from Task 2.
- Produces:
  - `renderMarkdown(md: string, {front = 'all', dropTitle = ''} = {}) -> string`:
    - `front: 'tags'` draws only `tags` as `<p class="ws-md-tags"><span class="ws-md-tag">…</span></p>` and nothing for other keys;
    - `dropTitle` removes the first `# ` heading whose text equals it (trimmed, case-insensitive);
    - every other caller keeps `front: 'all'`.
  - `docToolbar(p, mc, view, compare) -> string`: holds the picker (a `details.ws-menu` whose summary is the current document's dot, name and `1 of N`), then `New summary`, then the version select, then the side-by-side toggle, then Copy, Save a copy and Edit, then the document's ⋯ menu.
    - The picker's items are each document as `doc-view` (main, words, made), then `-`, then `Compare side by side` or `Show one at a time` (`meeting-compare`).
    - `New summary` uses the existing `meeting-make-notes`, which opens today's dialog.
    - The version select is today's `vSelect`, shown only with more than one version.
    - The side-by-side toggle is `meeting-compare`, an icon shown only with 2 or more documents.
    - Copy, Save a copy, Edit and the ⋯ menu are today's, unchanged.
    - While a `meeting_notes` run makes another document, `.ws-mtg-subrun` under the toolbar says `Making <template>…`.
  - `docFoot(p, mc, doc, made) -> string`: today's meta and wishes text (:246-250) as one grey line. It keeps `make it the main notes` and `You asked: “…”`.

- [ ] **Step 1: Write the failing tests.**
  - In `ui/test/markdown.test.mjs`:
    - `renderMarkdown with front tags draws only the tags`: front matter `title`, `date` and `tags: [meeting, philips]` give the two `.ws-md-tag` and no `<dl>`.
    - `renderMarkdown drops the first heading equal to the title`.
    - `renderMarkdown keeps a heading that is not the title, and text without front matter`.
    - `the default still draws the whole front matter`.
  - In `ui/test/workspace.test.mjs`:
    - `notes: one toolbar, no document chips, no One/Side by side switch`: `.ws-mtg-doctools` has the picker with `1 of 2`, `New summary` and `doc-copy`, and there is no `.ws-mtg-doctab` or `role="tablist"` labelled Documents.
    - `notes: the document reads as a page`: with the Philips fixture's main document read, there is no `.ws-md-front`, the tags show, the title is not an `<h1>` in the page, and `.ws-mtg-docfoot` contains `Built-in template` and `You asked`.
    - `tasks: "2 to review · 1 on the board", Accept only on tasks to review`: the heading text, two `Accept`, and none on the board task.
- [ ] **Step 2: Run** `node --test ui/test/markdown.test.mjs ui/test/workspace.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `renderMarkdown`'s options, then `docToolbar`, `docPage`, `docFoot`, the `notesTab` layout and the `tasksTab` heading and chips, with the CSS. Compare mode keeps its two `docCard(..., {compare: true})` columns and their selects. The earlier-version bar and the edit conflict banner stay above the page.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, including the controller's compare, version and edit tests.
- [ ] **Step 5: Commit.** `git commit -m "feat(meetings): notes under one toolbar, read as a page; quieter task rows"`

---

### Task 4: Browser checks, guides and the gates

**Files:**
- Modify: `ui/test/browser/meetings-checks.mjs`:
  - the scenarios at :52 (segmented filters, chips, the One/Side by side switch);
  - :122 (the strip shows progress → `runLine`);
  - :222 (the switch → `Filter › Meetings without a transcript`);
  - :343 (the Today card);
  - :390 (↑/↓);
  - new scenarios below.
- Modify: `.ai-run/guides/architecture/architecture.md:65`: the Meetings page row reads four tabs and a people popover, and adds the `codemie.meetings.hidden` preference.
- Modify: `ui/test/browser/workspace-e2e.mjs` only if a new scenario needs a mock answer (none is expected: hiding is local).

- [ ] **Step 1: Update the existing scenarios** to the new controls. Each keeps its intent: two documents, side by side and make main; progress then Ready; meetings without a transcript shown and hidden again; the Today card opens the meeting; ↑/↓ move.
- [ ] **Step 2: Add the scenarios:**
  - `right-click → Hide from the list → Undo`: the row leaves, the sidebar count drops, Undo brings it back, and the preference survives a reload.
  - `Hide every “<series>” → N hidden meetings · Show → Show again`.
  - `a folded day; ⌥-click keeps one day open; Fold all / Unfold all`.
  - `no row holds a button`: `page.$$('.ws-mtg-row button')` is empty.
  - `the people popover lists who was there`.

  Each scenario also asserts no horizontal overflow at 1000, 1440 and 1680 px in both themes, as the existing checks do.
- [ ] **Step 3: Run the browser checks** outside the sandbox: `WORKSPACE_E2E_ONLY=meetings PLAYWRIGHT_CORE=<path to playwright-core> node ui/test/browser/workspace-e2e.mjs`. Expected: every meetings check passes, with screenshots in `output/playwright/workspace-e2e/`. Open the 1440 light and dark Notes, Tasks and list shots and compare them with the prototype (launch config `meetings-calm-prototype`, port 5213).
- [ ] **Step 4: Run the full gates** with `make check`. Expected: exit 0 (fmt, clippy, `npm test`, `cargo test`; Rust is untouched).
- [ ] **Step 5: Update the architecture guide line** (`architecture.md:65`) as listed under Files.
- [ ] **Step 6: Commit.** `git commit -m "test(meetings): browser checks for hiding, folding and the calmer page"`

## Manual checks after the plan (in the real app)

- **Right-click** in WKWebView: the row menu opens at the pointer, and the system's context menu doesn't show as well.
- **⌥-click** on a day folds the others; check that macOS delivers `altKey`.
- **Real data:** a real recurring meeting carries `seriesId`, and Hide every covers the next occurrence after the next sync.
