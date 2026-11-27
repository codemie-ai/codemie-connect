# Meetings view (step 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers also follow the shared rules in `.superpowers/sdd/common-implementer.md`.

**Goal:** A meeting opens the way the reference app opens it, in both views:
- the main summary first, with summary tabs for the templates the user pins;
- one strip holding the tabs (or "← Back to summary"), one primary and ⋯;
- Transcript and Notes behind ⋯, Files under ⋯ › Advanced;
- an action items column on the right with "Add N to Tasks" and the user's own items ticked;
- three new Settings › Meetings settings.

**Architecture:**
- The Meetings page keeps two page sections, the list and one meeting section (`mtg-meeting`). The meeting section draws the header, the strip, the current pane and the column.
- Today's tab bodies (`notesTab`, `transcriptTab`, `filesTab`) become panes unchanged.
- A pure `meeting-view-model.js` decides the tabs, the primary, the owner lines and the default ticks.
- Native gains three `MeetingSettings` fields and a `template_delete` cleanup; nothing else native changes.
- "Add N to Tasks" goes through an injected `taskTarget` (`task-target.js`), so step 4 can swap it.
- Plugins' `call.minutes` keep line breaks and can fill a pinned tab.

**Tech Stack:** Rust (Tauri v2), `cargo test`; vanilla JS ES modules, `node:test`; Playwright (`playwright-core` 1.63) against the mocked bridge.

**Spec:** `docs/superpowers/specs/2026-11-23-meetings-view-design.md`. Definition of done: `docs/superpowers/specs/2026-11-22-workspace-next-rollout-design.md` § "Definition of done for every step".

## Global Constraints

- **Branch, commits, rules:**
  - Branch `feat/workspace-next` (already checked out). Do not switch branches or push.
  - One commit per task, Conventional Commit subject, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - The shared implementer rules are in `.superpowers/sdd/common-implementer.md`.
- **Running things:**
  - Raw `cargo` runs from `src-tauri/` with `export PATH="$HOME/.cargo/bin:$PATH"`. `make`, `npm` and `node` run from the repo root, in macOS/zsh syntax.
  - Skip the known failure: `cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`.
  - Browser run: `PLAYWRIGHT_CORE=/Users/Nikita_Levyankov/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs`, outside the sandbox (`dangerouslyDisableSandbox: true`).
  - One set: prefix `WORKSPACE_E2E_ONLY=meetings` (or `meetings-settings`, `meetings-view`, `layout`, `compact`).
  - A normal task runs only the sets it touches, plus `compact` and `layout`. The whole run (about 35 minutes, `run_in_background`) is for Task 8.
- **Safety, every task:**
  - Nothing is sent: this step adds no send path and no consent scope.
  - No task is written without a click (ticks are view state).
  - The window never shows a plugin's HTML (minutes go through `renderMarkdown`).
  - Automatic notes, rules and notes jobs are unchanged.
- **Code rules:**
  - Views stay pure (`view-meetings.js`, `view-meeting-tabs.js`, `meeting-view-model.js`). Only controllers and `app.js` touch the DOM.
  - Workspace writes go through `mutate`. Escape every meeting, transcript and plugin string with `escapeHtml` (`e`).
  - Default and Compact draw the same markup. Compact differs only through `--ws-*` tokens.
- **Values:**
  - pins: at most 4 `summaryTabs`, each matching `^[A-Za-z0-9_.:-]{1,100}$`;
  - `openOn` ∈ `summary | transcript | notes` (default `summary`); `actionItems` default `true`;
  - column 300 px (Compact 280 px), beside the pane at a meeting-section width ≥ 760 px, below it when narrower;
  - at most 4 visible tabs; "Copied" for 1.5 s;
  - minutes items at most 20,000 characters, 8 per plugin; run-line minutes cut to 300 characters;
  - dock key `codemie.layout.meetings.v2`.
- **Copy, verbatim from the spec:**
  - Strip:
    - "← Back to summary", "More ▾", "Copy" / "Copied", "Make <name>", "Try again", "Writing <name>…";
    - pane labels "Transcript", "Notes", "Files", "Action items".
  - Summary pane: "No <name> yet.", "<n> lines from <m> speakers are in the meeting folder.", "More options…", "No <plugin> summary for this meeting yet."
  - Meta: "with <A>", "with <A> and <B>", "with <A>, <B> and <C>", "with <n> people". Short name = first name + last initial with a dot ("Jeroen V.").
  - ⋯, in order:
    - "Transcript", "Notes", "Action items" (column off only);
    - —, "Make “<tab>” again (new version)", "Edit “<tab>”…", "Save a copy (.md)", "Make notes with…";
    - —, the hide items, "Show in calendar", the plugin items;
    - heading "Advanced": "Files", "Show folder in Finder", "Copy folder path", "Download again from Teams", "Import a transcript file…";
    - —, "Delete “<document>”…".
  - Column:
    - "Action items", "+ Add", "Add <n> to Tasks", "In Tasks", "<n> in Tasks ›", "None in this meeting yet.";
    - "Added <n> to Tasks · Undo", "Not a task";
    - owner lines "you · <date>", "you · no date", "<Name> · not sure of the owner", "Nobody named";
    - checkbox label "Add <text>".
  - Settings:
    - card "When you open a meeting";
    - "Open a meeting on" with "Summary | Transcript | Notes";
    - "Show action items beside the summary" with "Off: they move to ⋯ › Action items.";
    - "Summary tabs", "Pin a summary ▾", "Move up", "Move down", "Unpin";
    - "The first one that has a summary opens. With none pinned, a meeting shows its own documents.";
    - tooltip "Pin up to 4 summaries.";
    - template ⋯ "Pin as a summary tab" / "Unpin from summary tabs".
  - Native refusals: "Choose Summary, Transcript or Notes.", "Pin up to 4 summaries.", "Choose a template or a plugin to pin."
- **Contract fixtures:** after a native shape change run `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures` and commit the JSON.

## Review Focus

1. **A pinned template is deleted, or a pinned plugin is turned off.** The meeting shows the remaining tabs and never an empty or broken one. Settings no longer lists it. (Task 1 native test, Task 2 `summaryTabs` test, Task 7 V6.)
2. **A user has a stored v1 layout** (e.g. Notes beside Transcript, list narrowed to 300 px). Meetings opens with two sections, the list at 300 px, nothing missing, and no v1 write. (Task 3 `loadDock` test, Task 7 V8.)
3. **A background sync re-renders the column** while boxes are ticked or an add is in flight. The ticks stay, and a double click on "Add 2 to Tasks" moves each task once. (Task 4 controller test, Task 7 V4.)
4. **Old links:** `#/meetings/<id>/notes`, `/transcript`, `/files`, `/tasks` and `/people` open the content they did before. A link with no pane follows "Open a meeting on". (Task 2 `parseHash` test, Task 7 V7.)
5. **A plugin's minutes contain `<script>`, `<img onerror>` or a Markdown link.** The tab shows text, nothing runs, and no link is made. (Task 6 shim test, Task 7 V9.)

---

### Task 1: Native meeting view settings, template cleanup, contract fixture

**Files:**
- Modify: `src-tauri/src/workspace/meetings/model.rs`
  - `MeetingSettings` :249-302
  - `apply` :351-468
  - tests :478 (`meeting_settings_default_and_serialize_camel_case` exact JSON), :500
- Modify: `src-tauri/src/workspace/meetings/library_ops.rs` (`template_delete` :267-290; tests at the end)
- Create: `ui/test/fixtures/contract/meeting-view-settings.json` (generated). Regenerate `meeting-rules-cases.json`.
- Modify: `ui/test/browser/workspace-e2e.mjs` (`settings_update` mock :273: merge `meetings.openOn|actionItems|summaryTabs` with the same refusals)
- Test: `ui/test/meetings-model.test.mjs`

**Interfaces:**
- Produces, in native settings (`settings.meetings`):
  - `openOn: String` (`"summary"` default);
  - `actionItems: bool` (`true`);
  - `summaryTabs: Vec<String>` (`[]`).
- `apply` refusals carry `field` = the key, with the spec's messages. Duplicates are dropped in order. 5+ entries after the dedupe are refused.
- `template_delete {id}` removes `id` from `summaryTabs`.
- `meeting-view-settings.json` = `{"default": {...}, "updated": {...}, "afterTemplateDelete": {...}}`, each holding `{openOn, actionItems, summaryTabs}`.
  - `updated` comes from `settings_update {meetings: {openOn: "transcript", actionItems: false, summaryTabs: ["short-summary", "custom-formal", "plugin:podervianskyi", "short-summary"]}}`.
  - `afterTemplateDelete` comes from deleting `custom-formal`.

- [ ] **Step 1: Write the failing Rust tests**

```rust
#[test] fn meeting_view_settings_validate()
// openOn "notes" ok; "board" → Err field "openOn" "Choose Summary, Transcript or Notes."
// summaryTabs ["a","a","b"] → ["a","b"]; five distinct → Err "Pin up to 4 summaries.";
// ["../x"] or [3] or ["x".repeat(101)] → Err "Choose a template or a plugin to pin."; actionItems "yes" → Err
#[tokio::test] async fn deleting_a_template_unpins_it()   // in library_ops tests
#[tokio::test] async fn contract_fixtures_match_the_real_meeting_view_settings()
// writes meeting-view-settings.json as in Interfaces
```

Update the exact JSON in `meeting_settings_default_and_serialize_camel_case` with `"openOn": "summary", "actionItems": true, "summaryTabs": []`.

- [ ] **Step 2: Run them and see them fail.** Run `cd src-tauri && cargo test meetings::`. Expected: FAIL (unknown fields).

- [ ] **Step 3: Implement** the fields (`#[serde(default)]` already covers old settings), the `apply` arms and the `template_delete` cleanup.

- [ ] **Step 4: Write the fixtures and run the suite.** Run `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, then the whole suite with the skip. Expected:
  - `meeting-view-settings.json` is new;
  - `meeting-rules-cases.json` changes only by the three new keys;
  - every test passes.

- [ ] **Step 5: UI parity test.** In `meetings-model.test.mjs`, add `'the meeting view settings fixture: defaults, a dedupe and a delete unpin'`:
  - `default` is `{openOn:'summary', actionItems:true, summaryTabs:[]}`;
  - `updated.summaryTabs` is `['short-summary','custom-formal','plugin:podervianskyi']`;
  - `afterTemplateDelete.summaryTabs` lacks `custom-formal`.

  Then update the mock (Interfaces) and run `npm test`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/workspace/meetings ui/test/fixtures/contract ui/test/browser/workspace-e2e.mjs ui/test/meetings-model.test.mjs
git commit -m "feat(meetings): open-on, action items and pinned summary tabs settings"
```

### Task 2: Pure model: panes and hashes, summary tabs, the primary, owner lines, ticks, the task target

**Files:**
- Modify: `ui/workspace/meetings-model.js`
  - `TABS` :10 becomes `PANES`;
  - `tabsOf` :14 becomes `hasTranscript`;
  - `newMeetingsView` :80-92;
  - `parseHash` :574, `meetingHash` :589
- Create: `ui/workspace/meeting-view-model.js`, `ui/workspace/task-target.js`
- Test: create `ui/test/meeting-view.test.mjs`; update `ui/test/meetings-model.test.mjs` (:284 `tabsOf`, :297 people hash)

**Interfaces:**
- Produces, in `meetings-model.js`:
  - `PANES = ['summary','transcript','notes','files','tasks']`.
  - `hasTranscript(m) -> boolean`: the old `tabsOf(m).length > 0` rule.
  - `parseHash(hash) -> {route, meetingId, pane}`: `pane` is null when missing or unknown (`people` included). The old `tab` key goes.
  - `meetingHash(id, pane) -> string`: `#/meetings/<enc id>/<pane>`, with `pane` defaulting to `summary`.
  - `newMeetingsView()` loses `tab` and gains:
    - `pane: null` (null = the setting's choice for the next meeting);
    - `summaryTab: {}`, `ticked: {}` (meeting id → array of task ids), `itemOpen: null`;
    - `added: null` (`{meetingId, ids}` of the last add), `addError: null`, `addOpen: false`.
- Produces, in `meeting-view-model.js` (pure; `s` snapshot, `mc` from `meetingContext`, `slots` the page's `callSlots`, `plugins` `[{id, name}]` installed and on):
  - `pinsOf(s, plugins) -> string[]`: `settings.meetings.summaryTabs` minus missing templates and missing or off plugins.
  - `summaryTabs(s, mc, { slots = [], plugins = [] }) -> { tabs: Tab[], more: Tab[] }`.
    - `Tab = { key, label, kind: 'template'|'doc'|'plugin', templateId, doc, pluginId, text }`.
    - Keys: `tpl:<id>`, `doc:<id>`, `plugin:<id>`.
    - Order and fallbacks follow the spec's "Summary tabs" rules. `tabs` holds at most 4 entries, `more` the rest.
  - `shownTab(tabs, more, chosenKey) -> Tab`: the chosen tab while it exists, else the first with `doc` or `text`, else the first.
  - `stripPrimary(mc, tab, { pane, runningTemplateId, failedTemplateId }) -> { kind: 'copy'|'make'|'retry'|'writing'|'none', label }`. These are the spec's table: labels "Copy", `Make ${name}`, "Try again", `Writing ${name}…`.
  - `withLine(people, me) -> string`: the spec's "with …" copy, from people who are not me. `shortName("Vermeer, Jeroen")` gives "Jeroen V."; `shortName("Anouk de Vries")` gives "Anouk V." (the last word's initial).
  - `ownerLine(t, me, zone, now) -> string`: the spec's owner lines. The date reads like "Fri 20 Nov" (`formatDate` weekday short, day, month short).
  - `defaultTicks(tasks, me) -> string[]`: ids of To review tasks that are `isMine` and not `confidence === 'low'`.
  - `itemsOf(mc) -> { toAdd: task[], inTasks: task[] }`:
    - `toAdd`: To review tasks, by `line`;
    - `inTasks`: todo, doing and waiting by order, then done.
- Produces, in `task-target.js`: `localTaskTarget({ moveTask }) -> { label: 'Tasks', add(ids), undo(ids) }`.
  - `add` calls `moveTask(id, 'todo', { log: 'Accepted from review' })` one at a time.
  - `undo` calls `moveTask(id, 'review', { log: 'Moved back to review' })`.
  - Both resolve `{ done: string[], failed: [{ id, message }] }` and never throw for one task's failure.

- [ ] **Step 1: Write the failing tests** (`meeting-view.test.mjs`, using `buildSnapshot` + `withMeetings` and `meetingContext`):

```js
test('with nothing pinned the tabs are the documents, main first', …);            // mtg-philips → ['doc:meeting-notes','doc:short-summary']
test('a meeting without documents gets one tab for the template it would use', …);  // mtg-roadmap → [{kind:'template', label:'Meeting notes', doc:null}]
test('pins come first in order, unpinned documents follow, past four under More', …);
// pins ['short-summary','plugin:pod','meeting-notes'] with pod on → keys tpl:short-summary, plugin:pod, tpl:meeting-notes; 5 docs → more.length > 0
test('a deleted template or an off plugin is not a tab', …);                        // Review Focus 1
test('the shown tab is the chosen one, else the first with a summary', …);
test('the primary follows the tab', …);
// doc → copy 'Copy'; template no doc → make 'Make Short summary'; running same template → writing 'Writing Short summary…';
// failed same template → retry 'Try again'; no transcript (pending) → none; pane 'transcript' → none; plugin with text → copy; without → none
test('with-line names up to three people, else counts them', …);
// ['Jeroen Vermeer'] → 'with Jeroen V.'; two → 'with Jeroen V. and Anouk V.'; three → 'with A, B and C'; four → 'with 4 people'
test('owner lines and default ticks', …);
// task-endpoint (mine, review) ticked; task-pilot-list (Sam, low) not; line 'Sam O. · not sure of the owner'; mine no due → 'you · no date'
test('the local task target moves to todo and back, and reports a failure per task', …);
```

`meetings-model.test.mjs`:
- `'old meeting links open the same content'`: `/notes` gives pane `notes`, `/transcript` gives `transcript`, `/files` gives `files`, `/tasks` gives `tasks`, `/people` gives null, `#/meetings/x` gives null.
- `meetingHash('a b','summary')` is `'#/meetings/a%20b/summary'`.
- `hasTranscript` replaces the `tabsOf` test.

- [ ] **Step 2: Run** `node --test ui/test/meeting-view.test.mjs ui/test/meetings-model.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** as in Interfaces.
  - Keep `TABS` and `tabsOf` exported as deprecated aliases only until Task 3 removes their last callers (Task 3 deletes them).

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/workspace/meetings-model.js ui/workspace/meeting-view-model.js ui/workspace/task-target.js ui/test
git commit -m "feat(meetings): pure rules for summary tabs, the strip's primary, owner lines, ticks and panes"
```

### Task 3: One meeting section: header, strip, panes, the ⋯ menu, opening and links

**Files:**
- Modify: `ui/workspace/dock-model.js`: `KEY` :18 takes `def.version`; `loadDock` :219 and `saveDock` :239 pass the def.
- Modify: `ui/workspace/view-meetings.js`
  - `MEETINGS_DOCK` :31-41
  - `peopleStack` :310 → `withButton`
  - `meetingMenu` :334-354
  - `meetingHeader` :360-374
  - `tabBody` / `meetings` :376-429 → `meetingSection(p, m, mc)`, `strip(p, mc, tabs)`, `paneBody(p, mc, pane, tab)`
- Modify: `ui/workspace/view-meeting-tabs.js`: new `summaryPane(p, mc, tab)` and `noSummaryCard(p, mc, tab)` reusing `docBody`, `docParts().foot`, `saveBanner`, `lastRunBanner`, `skeleton`. `tasksTab` stays as the Action items pane body until Task 4.
- Modify: `ui/workspace/meetings-controller.js`
  - `open` :207-233 (`open(id, pane = null, line = null)`)
  - `follow` / `showTab` / `shownTabs` :131-150: removed
  - `load` :160-186: reads by pane and by the shown tab's doc
  - `gotoLine` :642
  - `handle`:
    - `meeting-tab` :730 → `meeting-pane` and `meeting-back`;
    - new `meeting-summary-tab`, `meeting-make-tab`, `meeting-copy-tab`, `meeting-edit-tab`;
  - `key` :261: Esc in a pane
- Modify: `ui/workspace/app.js`
  - `routeHash` :763 (`state.meetings.pane`)
  - `goHash` :796
  - `DOCK_LEGACY.meetings` :1566 (reads v1 once)
  - `openMeeting` :1926 (`tab = null`)
  - the notification :3169 (`open(id)` with no pane)
  - the `layouts.set` hook (`meetingsUi.follow` removed)
- Modify: `ui/workspace/meetings-settings-controller.js:718-719` (`openMeeting(id, 'notes')` stays; `'transcript'` stays)
- Modify: `ui/workspace/workspace.css` (`.ws-mtg-strip`, `.ws-mtg-tabs`, `.ws-mtg-back`, `.ws-mtg-with`, `.ws-mtg-body`; Compact via tokens)
- Modify tests:
  - `ui/test/workspace.test.mjs` :1136, :1177, :1192, :1213, :1262, :1478, :1577
  - `ui/test/meetings-controller.test.mjs` :81, :133
  - `ui/test/dock-model.test.mjs`
  - `ui/test/browser/meetings-checks.mjs` (`select` :71-82, the `mtg-files` tab clicks, the sections check :585-650)
  - `ui/test/browser/layout-checks.mjs` :468-540

**Interfaces:**
- Consumes: Task 2 `PANES`, `hasTranscript`, `parseHash`, `meetingHash`, `summaryTabs`, `shownTab`, `stripPrimary`, `withLine`. Settings `openOn`, `actionItems` (Task 1).
- Produces:
  - `MEETINGS_DOCK = { title: 'Meetings', version: 2, tabs: { 'mtg-list': (unchanged), 'mtg-meeting': { title: 'Meeting', icon: 'meetings', min: 420, w: 900 } }, initial: [['mtg-list'], ['mtg-meeting']] }`.
  - `loadDock(storage, page, def, legacy)` reads `codemie.layout.<page>.v<def.version||1>`. The meetings legacy hook returns `{ collapse: ['mtg-list'] }` when v1's list pane was collapsed (or `codemie.meetings.wide` is true), plus `{ widths: { 'mtg-list': w } }` from v1. `loadDock` applies `widths` to the initial layout.
  - DOM:
    - `section.ws-mtg-meeting-section[data-meeting][data-pane]` holds `.ws-mtg-meeting` (the header), `div.ws-mtg-strip`, then `div.ws-mtg-body` with `div.ws-mtg-pane[role=tabpanel]`. Task 4 adds the column here.
    - Tabs: `div.ws-mtg-tabs[role=tablist][aria-label=Summaries]` of `button[role=tab][data-action=meeting-summary-tab][data-key]`, plus `details[data-menu="meeting-more-tabs-<id>"]` "More ▾".
    - In a pane: `button[data-action=meeting-back]` "← Back to summary" and `span.ws-mtg-pane-name`.
    - Primary: `button[data-action=meeting-copy-tab|meeting-make-tab][data-key]`, or `span.ws-mtg-writing` for `writing`.
    - ⋯: `details[data-menu="meeting-<id>"]` with the spec's items. New actions:
      - `meeting-pane` (`data-pane`) for Transcript, Notes, Files and Action items;
      - `meeting-make-tab` for "Make … again" (the template of the shown tab);
      - `meeting-edit-tab` (Notes pane, then `startEdit`);
      - `doc-save` for Save a copy;
      - the rest are today's actions.
  - Header: `button.ws-mtg-with[data-action=meeting-people][aria-haspopup=dialog]` toggles the people popover (`details.ws-mtg-stack` keeps its `data-menu`). Plugin chips stay. "Review N tasks" (`meeting-pane`, `data-pane=tasks`) shows only when `actionItems === false`.
  - Controller:
    - `open(id, pane, line)` sets `v.pane = PANES.includes(pane) ? pane : settings.meetings.openOn || 'summary'`. The same meeting keeps its pane when `pane` is null. Selecting another meeting from the list resets `v.pane` to the setting.
    - `meeting-summary-tab` sets `v.summaryTab[id]` and `v.pane = 'summary'`.
    - `meeting-make-tab` calls `guarded(id, () => makeNotes(id, { templateId, findTasks: true }))`.
    - `meeting-copy-tab` copies the shown doc's text (`docText`) or the plugin tab's text, then sets the label to "Copied" for 1500 ms (the controller re-renders after).
    - `meeting-back` and Esc (no field focused, no `details[open]`, no modal) set `v.pane = 'summary'`.
    - A `tasks` pane while `actionItems` is on shows the summary and focuses `.ws-mtg-items [data-action=meeting-item-tick]` (Task 4). Until Task 4, it shows the Action items pane.
  - `load()` reads the transcript when saved (as today), the glossary in the transcript pane, the files in the files pane, the notes pane's docs as today, and in the summary the shown tab's doc.

- [ ] **Step 1: Write the failing tests.**
  - `dock-model.test.mjs`: `'a versioned definition stores under its own key and a legacy hook carries widths'`.
    - `loadDock` with def `{version:2,…}` reads `codemie.layout.meetings.v2`.
    - With nothing there, a legacy `{collapse:['mtg-list'], widths:{'mtg-list':300}}` gives a collapsed list of w 300.
    - `saveDock` writes v2 only.
  - `workspace.test.mjs`: rewrite :1136 as `'meeting: the title once, a with-line, a strip with summary tabs, Copy and ⋯, no section per tab'`:
    - for `mtg-philips`: `/role="tablist"[^]*?data-key="doc:meeting-notes"[^]*?aria-selected="true"/`;
    - `/data-action="meeting-copy-tab"/`;
    - `/class="ws-mtg-with"[^>]*>with Jeroen V\., Anouk/` (or the count form, from the fixture's people);
    - `doesNotMatch(/data-tab="mtg-notes"|ws-mtg-faces/)`.
  - New `'⋯ holds Transcript, Notes and an Advanced group with Files'`: the order regex over the menu panel's labels matches the Global Constraints list.
  - New `'a pane shows Back to summary and no primary'`: `ctx.state.meetings.pane = 'transcript'`, then `/data-action="meeting-back"[^>]*>← Back to summary/` and no `meeting-copy-tab`.
  - New `'before a summary: No Short summary yet. and Make Short summary'`: pins `['short-summary']`, `mtg-roadmap`.
  - Keep :1177 (the explainer, no tablist), :1192 (the hide items now in the strip ⋯), :1213 (Review only with the column off), :1262 (the form in the Notes pane), :1478 (plugin chips and run-line minutes), :1577, each retargeted to the new markup.
  - `meetings-controller.test.mjs` :81 becomes `'open() with no pane uses Open a meeting on; the same meeting keeps its pane; a line opens Transcript'`. :133 becomes `'one header, above the strip, in the meeting section'`.

- [ ] **Step 2: Run** `node --test ui/test/dock-model.test.mjs ui/test/workspace.test.mjs ui/test/meetings-controller.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces.
  - Remove `TABS`, `tabsOf` and the controller's `follow`.
  - CSS: the strip is a flex row with a bottom rule (`--ws-line`); tabs are pills (the reference app's tab style: 4×12 padding, radius `--ws-radius-control`, the open one on `--ws-surface-2`); `.ws-mtg-body` is a grid that Task 4 extends.

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Move the browser checks onto the new page, keeping their assertions:**
  - `meetings-checks.mjs`:
    - `select(page, id, filter, pane = 'summary')` waits for `#/meetings/<id>/summary`;
    - the Notes steps (picker, side by side, make main, edit conflict) first open ⋯ › Notes (`[data-action=meeting-pane][data-pane=notes]`);
    - the Files step uses ⋯ › Advanced › Files, and the hash ends `/files`;
    - the People step clicks `.ws-mtg-with`;
    - "Review N tasks" assertions move to the Action items pane;
    - the sections check (:585) becomes `'meetings sections: v1 layout read once, two sections, the hash’s pane, the header menu inside the section, the row’s scroll'`. It loses "Notes beside Transcript" (ruling 12) and gains `localStorage.getItem('codemie.layout.meetings.v2')` set after a change, with v1 untouched.
  - `layout-checks.mjs` :468-540: drive `#/meetings/mtg-philips/notes` as the Notes pane. Replace "Notes beside Transcript" with "the list section resizes and collapses and the meeting section keeps the strip in view".

- [ ] **Step 6: Run** `WORKSPACE_E2E_ONLY=meetings …`, then `layout` and `compact`. Expected: all PASS, with no page errors. Look at the `*-meetings-notes` and `*-meetings-files` screenshots at 1000 px.

- [ ] **Step 7: Commit**

```bash
git add ui/workspace ui/test
git commit -m "feat(meetings): summary first in one meeting section; transcript, notes and files behind ⋯"
```

### Task 4: The action items column and "Add N to Tasks"

**Files:**
- Modify: `ui/workspace/view-meeting-tabs.js`: new `actionItems(p, mc, { pane = false })`; `tasksTab` :518-564 is removed, and its add form and quote markup move into `actionItems`.
- Modify: `ui/workspace/view-meetings.js`: `meetingSection` puts `actionItems` beside the pane when `actionItems !== false`, and as the `tasks` pane body otherwise.
- Modify: `ui/workspace/meetings-controller.js`
  - new actions `meeting-item-tick`, `meeting-item-open`, `meeting-items-add`, `meeting-items-undo`, `meeting-item-add-open`;
  - `acceptAll` :656 removed (and `meeting-tasks-accept`);
  - the factory takes `taskTarget`.
- Modify: `ui/workspace/app.js` (pass `taskTarget: localTaskTarget({ moveTask: (id, status, o) => tasksUi.move(id, status, o) })` beside `moveTask` :1873)
- Modify: `ui/workspace/workspace.css` (`.ws-mtg-items`, `--ws-mtg-items-w: 300px`, `280px` under Compact; `container-type: inline-size` on `.ws-mtg-meeting-section`; `@container (max-width: 759px)` puts the column under the pane)
- Test: `ui/test/meeting-view.test.mjs`, `ui/test/meetings-controller.test.mjs`, `ui/test/workspace.test.mjs`

**Interfaces:**
- Consumes: Task 2 `itemsOf`, `ownerLine`, `defaultTicks`, `localTaskTarget`; the existing `task-owner`, `task-due`, `task-dismiss`, `task-done`, `task-open-today`, `meeting-goto-line`, `meeting-board` and the `meeting-task` form.
- Produces:
  - `aside.ws-mtg-items[aria-label="Action items"]`:
    - `h3` "Action items" and `button[data-action=meeting-item-add-open]` "+ Add";
    - `form[data-form=meeting-task]` while `v.addOpen`;
    - to-add rows `div.ws-mtg-item[data-task]` with `input[type=checkbox][data-action=meeting-item-tick][data-task][aria-label="Add <text>"]` and `button.ws-mtg-item-open[data-action=meeting-item-open][aria-expanded]` (text plus owner line). The open row holds the quote button, the owner select, the date input and `button[data-action=task-dismiss]` "Not a task".
    - `button[data-action=meeting-items-add]` "Add <n> to <target.label>" (only when n ≥ 1);
    - `p.ws-mtg-items-error` (red, when `v.addError`);
    - "In Tasks" rows (done checkbox, `task-open-today` text, due date or `columnName`);
    - footer `p[role=status]`: "Added <n> to Tasks · <button data-action=meeting-items-undo>Undo</button>" after an add, else `button[data-action=meeting-board]` "<n> in Tasks ›", or "None in this meeting yet.".
  - `actionItems` takes the label from `p.taskLabel` (the page gets `ctx.taskLabel`, default `'Tasks'`).
  - Controller:
    - Ticks start from `defaultTicks` the first time a meeting's column is drawn (`v.ticked[id]` undefined).
    - Ticks are pruned to tasks still in To review on every render.
    - `meeting-items-add` runs once at a time (an in-flight flag; a second click is ignored).
    - It calls `taskTarget.add(ticked)`, sets `v.added = {meetingId, ids: done}`, keeps the failed ids ticked and sets `v.addError` to the first failure's message.
    - `meeting-items-undo` calls `taskTarget.undo(v.added.ids)`, re-ticks those ids and clears `v.added`.

- [ ] **Step 1: Write the failing tests.**
  - `workspace.test.mjs` `'the column: my sure task ticked, Sam’s not, Add 1 to Tasks, one In Tasks, the footer'` on `mtg-philips`:
    - `task-endpoint` checkbox `checked`, `task-pilot-list` not;
    - `/Add 1 to Tasks/`; `/In Tasks[^]*?Send Legal the written retention requirement/`; `/1 in Tasks ›/`.
  - `'with the column off, ⋯ has Action items and the header Review 2 tasks'`.
  - `'the column’s markup is the same in Default and Compact'`: the `<aside class="ws-mtg-items"…</aside>` strings from both views are equal.
  - `meetings-controller.test.mjs`:
    - `'Add moves the ticked tasks once, even on a double click; Undo moves only those back'`: a fake target records calls; two quick `handle('meeting-items-add')` give one `add(['task-endpoint'])`; `undo(['task-endpoint'])`; the tick comes back.
    - `'a re-render keeps ticks; a task that left review leaves the ticks'` (Review Focus 3).
    - `'a failed add keeps the row ticked and shows why'`.

- [ ] **Step 2: Run** `node --test ui/test/workspace.test.mjs ui/test/meetings-controller.test.mjs ui/test/meeting-view.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Browser checks.** In `meetings-checks.mjs`, change "task quote → transcript line highlighted" (:421) to open the row in the column and click its quote. Any step that used the Tasks tab's Accept now ticks and adds. Run `WORKSPACE_E2E_ONLY=meetings`, then `layout` and `compact`. Expected: PASS. Look at the 1000 px screenshots: the column sits below the pane, with no clipping.

- [ ] **Step 6: Commit**

```bash
git add ui/workspace ui/test
git commit -m "feat(meetings): action items column with Add N to Tasks, your own ticked, Undo"
```

### Task 5: Settings › Meetings: "When you open a meeting" and pinning

**Files:**
- Modify: `ui/workspace/view-settings-meetings.js`: `templatesPanel` :206 gains the card above "Default template"; `templateCard` :183 ⋯ gains pin/unpin.
- Modify: `ui/workspace/meetings-settings-controller.js`: new actions `meetings-settings-open-on`, `meetings-settings-pin`, `meetings-settings-unpin`, `meetings-settings-pin-move`; `meetings-settings-set` already handles `actionItems`. Saves go through the existing `settings_update {meetings}` path :75.
- Modify: `ui/workspace/app.js` (pass `minutesPlugins` into the settings ctx: `pluginHost?.minutesPlugins() || []`; Task 6 adds the host function, and until then `[]`)
- Test: `ui/test/settings-meetings.test.mjs`, `ui/test/browser/meetings-settings-checks.mjs`

**Interfaces:**
- Consumes: Task 1 fields; Task 2 `pinsOf`.
- Produces:
  - `meetingViewCard(s, { v, plugins })`:
    - `.ws-segmented[aria-label="Open a meeting on"]` with three `button[data-action=meetings-settings-open-on][data-v=summary|transcript|notes][aria-pressed]`;
    - the `actionItems` toggle row;
    - `ol.ws-ms-pins` of `li[data-pin]` with Move up / Move down (`meetings-settings-pin-move`, `data-d=-1|1`) and Unpin;
    - `details[data-menu=ms-pin-add]` "Pin a summary ▾" listing unpinned templates (`meetings-settings-pin`, `data-pin=<id>`) and, under a "Plugins" label, `plugin:<id>` entries. It is disabled at 4 pins, with the title "Pin up to 4 summaries.".
  - Each change sends `settings_update {meetings: {openOn}|{actionItems}|{summaryTabs: next}}`. A refusal shows under the card with `fieldError(v, 'meetings.summaryTabs')`.

- [ ] **Step 1: Write the failing tests** (`settings-meetings.test.mjs`):
  - `'the open-a-meeting card: three choices, the switch, pins in order with move and unpin'`;
  - `'Pin a summary lists unpinned templates and summary plugins, disabled at four'`;
  - `'pinning sends summaryTabs with the new id last; Move up swaps; Unpin removes'` (the controller over a fake `mutate`);
  - `'a template card’s ⋯ says Pin as a summary tab, or Unpin from summary tabs when pinned'`.

- [ ] **Step 2: Run** `node --test ui/test/settings-meetings.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Browser check.** In `meetings-settings-checks.mjs`, add to the templates check:
  - pin Short summary, then Meeting notes;
  - Move up;
  - `settings_update` carries `summaryTabs: ['meeting-notes','short-summary']`;
  - Open a meeting on → Transcript is recorded;
  - screenshot `${tag}-settings-meetings-open`.

  Run `WORKSPACE_E2E_ONLY=meetings-settings`, then `compact`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/workspace ui/test
git commit -m "feat(settings): open a meeting on, the action items switch and pinned summary tabs"
```

### Task 6: Plugins' minutes as a summary tab

**Files:**
- Modify: `ui/plugins/frame/shim.js`
  - new `minutesText(html)` beside `textOf` (:50-60);
  - `drawSlots` :622-664 uses it for `call.minutes`;
  - the posted event gains `minutesSlot: (s.slots.get('call.minutes') || []).length > 0`
- Modify: `ui/plugins/host.js`: :318 keeps `rec.minutesSlot = !!m.minutesSlot`; new `minutesPlugins() -> [{id, name}]` in `api` :493
- Modify: `ui/workspace/view-meetings.js`:
  - `pluginLines` :72 uses each plugin's first minutes line, cut to 300;
  - the page passes `plugins: ctx.minutesPlugins` into `summaryTabs`;
  - the plugin tab body is `renderMarkdown(text, {})` inside `article.ws-md`
- Modify: `ui/workspace/app.js:501` (`minutesPlugins: pluginHost?.minutesPlugins() || []` into the meetings ctx)
- Test: `ui/test/shim.test.mjs`, `ui/test/meeting-view.test.mjs`, `ui/test/workspace.test.mjs`

**Interfaces:**
- Produces:
  - `minutesText(html) -> string`, as the spec says:
    - `<br>`, `</p>` and `</div>` end a line;
    - `<hN>` starts a line with N `#` and a space;
    - `<li>` starts a line with `- `;
    - other tags are dropped, the `ENTITIES` are read, spaces are folded within a line, lines are trimmed, 3+ newlines become 2;
    - the result is sliced to 20,000 characters.
  - `renameHost` is applied after.
  - `callSlots()` entries keep `minutes: string[]` (multi-line now).
  - `minutesPlugins()` lists frames with `minutesSlot`, installed and on.
  - A plugin tab's `text` = that plugin's `minutes.join('\n\n')` for the shown meeting (`summaryTabs` from Task 2 already takes `slots`).

- [ ] **Step 1: Write the failing tests.**
  - `shim.test.mjs` `'minutes keep lines, headings and bullets, and never markup'`:

```js
minutesText('<h2>Mood</h2><p>Calm &amp; dry</p><ul><li>one</li><li>two</li></ul><script>x()</script><img src=x onerror=y>')
// === '## Mood\nCalm & dry\n- one\n- two'  (script text dropped with its tag pair; img gone)
minutesText('a'.repeat(30000)).length === 20000
```

  - `meeting-view.test.mjs` `'a pinned plugin with minutes is a tab with its text and Copy; without minutes it says so'`.
  - `workspace.test.mjs` `'a plugin tab draws escaped Markdown, no links'`:
    - minutes `['## Mood\n[x](https://e.test) <b>hi</b>']` give `<h2`/`<h3` (whatever `renderMarkdown` makes of `##`);
    - `&lt;b&gt;hi&lt;/b&gt;`; no `<a `. This pins Review Focus 5.
  - `'the run line shows one line per plugin'`.

- [ ] **Step 2: Run** `node --test ui/test/shim.test.mjs ui/test/meeting-view.test.mjs ui/test/workspace.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement.** A `<script>` or `<style>` element's text is removed with the element before the tags are dropped.

- [ ] **Step 4: Run** `npm test`, then `WORKSPACE_E2E_ONLY=plugins` (the call-slot checks still pass). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/plugins ui/workspace ui/test
git commit -m "feat(plugins): call.minutes keep their lines and can be a pinned summary tab"
```

### Task 7: Browser check set `meetings-view-checks.mjs`

**Files:**
- Create: `ui/test/browser/meetings-view-checks.mjs`
- Modify: `ui/test/browser/workspace-e2e.mjs`
  - the import;
  - the `WORKSPACE_E2E_ONLY` list :1300-1308 gains `meetings-view`;
  - the full run calls `meetingsViewChecks` after `meetingChecks` (:3133);
  - the header comment;
  - a mock plugin frame hook `window.__minutes = {pluginId, name, minutes}`, which makes `pluginHost.callSlots()` / `minutesPlugins()` answer it (beside the existing plugin mocks)

**Interfaces:**
- Consumes: `open({ theme, width, height, hash, settings, meetings: true, localPrefs })`, `check`, `assert`, `shot`, `settled`, `calls`, `OUT`; `noClip`, `CLIP_SELECTORS` and `FIXED_NOW` from `compact-checks.mjs`; the `noOverflow` pattern from `reply-checks.mjs`.
- Produces: `export async function meetingsViewChecks({ open, check, assert, shot, settled, calls, OUT })`, run alone with `WORKSPACE_E2E_ONLY=meetings-view`.

- [ ] **Step 1: Write the checks.**
  - **V1 `meetings-view V1: <theme> <view> <width>`**, for both themes × {compact, default} × {1000, 1440, 1680}, on `mtg-philips` with pins `['meeting-notes','short-summary']`:
    - the summary pane shows a `.ws-md h3`;
    - the strip has the tablist, exactly one primary and ⋯;
    - `.ws-mtg-items` is beside the pane at 1440 and 1680 and below it at 1000 (list open), from the bounding boxes;
    - no horizontal overflow; `noClip` is empty with `.ws-mtg-strip button`, `.ws-mtg-item-open` and `.ws-mtg-items button` added;
    - screenshots `meetings-view-<theme>-<view>-<width>`, plus `-roadmap` (no summary yet) and `-pending` (explainer, no tabs).
  - **V2 strip and panes:**
    - ⋯ › Transcript shows `#meeting-line-3` and "← Back to summary"; the hash ends `/transcript`;
    - Esc returns to the summary;
    - ⋯ › Notes shows the doc picker with "1 of 2";
    - ⋯ › Advanced › Files lists `transcript.vtt`, and its text is never on the summary;
    - Back.
  - **V3 Copy and Make:**
    - Copy puts the document's Markdown on the clipboard stub and reads "Copied";
    - on `mtg-roadmap` with pins `['short-summary']`: "No Short summary yet.", then "Make Short summary" records `meeting_notes {templateId:'short-summary', findTasks:true}`, and the run line appears.
  - **V4 the column** (Review Focus 3):
    - `task-endpoint` is ticked and the pilot list is not;
    - double-click "Add 1 to Tasks": exactly one `task_save {id:'task-endpoint', status:'todo'}`;
    - "Added 1 to Tasks · Undo"; Undo records `status:'review'`, and the tick is back;
    - tick both, then `window.__workspace.render()` three times: both are still ticked;
    - open the pilot row: the owner select and date show; "Not a task" records `status:'dismissed'`.
  - **V5 column off:**
    - with `actionItems:false`, no `.ws-mtg-items`; the header shows "Review 2 tasks", which opens the Action items pane (hash `/tasks`).
  - **V6 pins that vanish** (Review Focus 1):
    - pins `['custom-gone','short-summary','plugin:off']` show one pinned tab, Short summary, then Meeting notes as a document tab;
    - no empty tab, no page error.
  - **V7 links** (Review Focus 4):
    - `#/meetings/mtg-philips/notes` opens the Notes pane; `/files` opens Files;
    - `/tasks` (column on) shows the summary with focus in `.ws-mtg-items`;
    - `/people` follows "Open a meeting on";
    - with `openOn:'transcript'`, a click on a list row opens the Transcript pane;
    - Today's "From your meetings" row opens per the setting.
  - **V8 stored v1 layout** (Review Focus 2):
    - with `localPrefs: {'codemie.layout.meetings.v1': <Notes beside Transcript, list w 300>}`: two sections, the list is 300 px wide (±2);
    - after the list is resized, v2 is written and v1 is byte-identical.
  - **V9 plugin minutes** (Review Focus 5):
    - with `window.__minutes = {pluginId:'pod', name:'Podervianskyi', minutes:['## Настрій\n<img src=x onerror="window.__xss=1"> [l](https://e.test)']}` and pins `['plugin:pod']`, the tab "Podervianskyi" shows the heading;
    - `window.__xss` is undefined; no `a[href]` in the pane; Copy copies the text;
    - screenshot `meetings-view-plugin-tab`.
  - **V10 parity:** the normalized `outerHTML` of `.ws-mtg-strip` and `.ws-mtg-items` (ids and `aria-controls` stripped) is identical in Default and Compact.
  - **V11 nothing sent or written without a click:** open three meetings, switch tabs and panes, switch view, and render five times. `task_save`, `meeting_notes`, `action_prepare` and `action_confirm` counts stay 0.

- [ ] **Step 2: Run** `WORKSPACE_E2E_ONLY=meetings-view …` outside the sandbox. Expected: V1–V11 PASS in both themes.
  - Fix product code only in a `fix:` commit that names the check.
  - Look at the V1 screenshots at 1000 px in both views.

- [ ] **Step 3: Commit**

```bash
git add ui/test/browser/meetings-view-checks.mjs ui/test/browser/workspace-e2e.mjs
git commit -m "test(meetings): browser checks for the meeting view in both views, both themes and three widths"
```

### Task 8: Definition of done

**Files:** none change unless a check fails. A fix goes in a `fix:` commit naming the check.

- [ ] **Step 1: Gates.**
  - Run `make fmt-check lint test-js`.
  - Then run `cd src-tauri && cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches` (PATH from Global Constraints). `make check` is the same set without the skip.
  - Expected:
    - fmt and clippy are clean;
    - `npm test` has no failures;
    - every cargo target says `test result: ok`;
    - `git status` is clean (fixtures committed).

- [ ] **Step 2: Whole browser run** in the background, outside the sandbox, about 35 minutes: `PLAYWRIGHT_CORE=/Users/Nikita_Levyankov/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs`.
  - Expected: `N/N browser checks passed`, covering meetings-view V1–V11, meetings, meetings-settings, reply R1–R12, compact C0–C6, layout E1–E8, plugins and analytics.
  - Screenshots are in `output/playwright/workspace-e2e/`.
  - Known flaky checks: re-run that set alone once and report both results, as `.superpowers/sdd/common-implementer.md` says.

- [ ] **Step 3: The real app.** Ask the user to quit their Connect. The status smoke refuses to run beside it; do not quit it for them.
  1. Build with `cd src-tauri && cargo build`.
  2. Prepare the data folder: `T=$(mktemp -d)/workspace`, and copy `~/Library/Application Support/com.epam.codemie.installer/workspace/workspace.sqlite` (with `-wal` and `-shm`) into it. Do not copy `credentials/`.
  3. Launch `CODEMIE_WORKSPACE_TEST_DIR=$T ./target/debug/app`.
  4. Drive it with `/private/tmp/claude-501/s0/click` and capture each screen with `screencapture -l <windowid>`.
  5. Capture in Default and Compact:
     - a meeting with notes (summary, tabs, column);
     - the ⋯ menu with Advanced;
     - the Transcript, Notes and Files panes;
     - a meeting without a summary ("Make …");
     - a meeting without a transcript;
     - the column below the pane at 1000 px;
     - Settings › Meetings › Note templates' "When you open a meeting".
  6. Pin two templates there first. Real meeting folders are read from disk, and nothing reaches Microsoft.
  7. Quit, and run `CODEMIE_WORKSPACE_TEST_DIR=$T CODEMIE_STATUS_SMOKE=status ./target/debug/app`. Expected: exit 0, and `$TMPDIR/connect-status-smoke.json` reports the workspace and settings.

- [ ] **Step 4: A side-by-side comparison with the reference mockups.**
  1. Capture the reference app's open meeting at the same width: a live run of the reference app if one is available, else the reference meetings mockup.
  2. Put it next to the Compact and Default screenshots.
  3. List every visible difference, either as kept on purpose (with the ruling number from the spec) or as a follow-up. Examples:
     - no "Send summary to …" (ruling 1);
     - "Add N to Tasks" in place of Todoist (step 4);
     - the Advanced group;
     - no recording or "Hear it";
     - the people line opening a popover.

- [ ] **Step 5: Show the user** the browser-run summary, the real-app screenshots in both views, the status smoke result, and the reference-mockup comparison with its differences. Do not push.
