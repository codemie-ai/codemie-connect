# Meetings view · design

**Status:** written on 2026-11-23 from the rollout overview's decisions and the code. This is step 3 of `2026-11-22-workspace-next-rollout-design.md`. Decisions the overview and the user left open are ruled on below, under "Rulings for the user".
**Builds on:**
- step 1, `2026-11-22-compact-view-design.md`: the Compact / Default view, `ctx.view`, the `--ws-*` size tokens;
- step 2, `2026-11-22-reply-design.md`: one gated send path and the three-control rule;
- the calm Meetings page, `2026-11-19-meetings-calm-design.md`: the list, the Needs you card, hidden meetings, the header and the run line.

**Reference (read-only):**
- the reference app's meeting panel (panes, the primary, the ⋯ items, and the action items column);
- the reference app's meetings mockup.

## Intent

A meeting in Connect opens on four page sections: Notes, Transcript, Tasks and Files. Its documents sit behind a picker with versions, Side by side and a toolbar. The person has to choose a tab before reading anything, and the Tasks tab holds the action items far from the summary they came from.

The reference app opens a meeting on what the person came for. It shows the summary first, with tabs for the summaries they use (Formal, Informal). The action items sit in a column beside it, with "Add N to Todoist" and the person's own items ticked. Transcript and notes wait behind ⋯, and "← Back to summary" returns. The user wants Connect to open meetings this way in both views. It must build on Connect's template processing and automatic rules, and keep every tool the page has today.

## Goals

- **Summary first.** A meeting with notes opens on its main summary. Nothing has to be chosen first.
- **Summary tabs are the templates the person pins.** For example, "Formal" and "Informal" (up to four), in their order. With nothing pinned, the tabs are the meeting's documents, main first. That is how it works today.
- **One strip** under the header holds three things: the summary tabs (or "← Back to summary" in a pane), one primary action, and ⋯.
- **Transcript and Notes behind ⋯**, with Files under ⋯ › Advanced. The raw `.vtt` shows only when the person previews it in Files.
- **An action items column on the right** of every pane. It holds the meeting's tasks still to review, each with a box; the person's own are ticked. "Add N to Tasks" puts the ticked ones on the board in one click, with Undo. The tasks already on the board are listed below.
- **Settings › Meetings** gets three settings: "Open a meeting on: Summary / Transcript / Notes", "Show action items beside the summary", and the pinned summary tabs.
- **A plugin's minutes can be a summary tab.** A marketplace plugin can fill a tab through `call.minutes`, so the Podervianskyi Informal summary can come later without new plumbing.
- **Compact and Default** draw the same markup. Compact uses the step-1 tokens.

## Non-goals

- A new processing engine, layouts per meeting type, or automatic runs of several templates per meeting. Step 5 brings the Formal and Informal automations.
- Sending the summary to the attendees (see ruling 1).
- The task provider and Todoist, which are step 4. This step writes local tasks behind one swappable target.
- The Podervianskyi plugin itself.
- Changing the meetings list, the Needs you card, hiding, the calendar's event card, Today's "From your meetings" card or the Make notes and Import dialogs.
- The reference app's recording, rename, "Hear it" player and speaker-naming chips. Connect names speakers in the Transcript pane, as today.

## Anti-goals

- **Losing access to the transcript, the files, a document, a version or any action the page has today.** These include versions, compare, edit, make main, make again, delete, import, download again, check now, Make notes for all, Always use this template, folder actions, and plugins' call chips and ⋯ items.
- **Breaking existing deep links.** No `#/meetings/<id>/<tab>` written before this step may land on an error or on Today.
- **Breaking automatic notes or rules.** Their native code and their records are unchanged.
- **Default and Compact diverging.** One set of functions draws the strip, the panes and the column for both views. A check compares their markup.
- **Anything sent without a click, or a new Microsoft consent scope.** This step adds no send path at all.
- **A task written without a click.** Ticks are view state. Only "Add N to Tasks", a row's own controls and "+ Add" write.
- **Showing a plugin's HTML in the window.** Minutes stay text, drawn through the escaping Markdown renderer.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **A. One meeting section with panes.** The Meetings page keeps two page sections, the list and the meeting. The meeting section draws the header, the strip, the current pane (summary, Transcript, Notes, Files) and the action items column. The existing tab bodies become the panes. | The meeting's panes can no longer be dragged into separate sections ("Notes beside Transcript"). Stored layouts move to a new key. | **Chosen** |
| B. Keep the four sections and add a fifth "Summary" section and a sixth "Action items" section. | Least change, but it keeps the tab-first page the decision replaces. Transcript and Notes stay as visible sections instead of going behind ⋯. | Rejected: contradicts the decision |
| C. The reference app's layout in Compact only; Default keeps the sections. | Faithful in Compact, but two meeting pages to keep in step. The user asked for both views. | Rejected: views diverge |

## Design

### Page sections

- `MEETINGS_DOCK` becomes two tabs: `mtg-list` (unchanged) and `mtg-meeting` ("Meeting", min 420, w 900). The initial layout is `[['mtg-list'], ['mtg-meeting']]`.
- `dock-model.js` reads a definition's `version` into its storage key (`codemie.layout.<page>.v<version>`, default 1). `MEETINGS_DOCK.version = 2`.
- With no v2 layout stored, the legacy hook reads `codemie.layout.meetings.v1` once. It keeps only the list section's width and whether it was collapsed (and `codemie.meetings.wide`, as today). v1 is never written again.
- The list toggle in the header (`meeting-list-toggle`) and Side by side collapsing the list work as today.

### The meeting section

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ☰  Philips CodeMie conversations syncup                         [Philips ✓] (plugin chip) │
│    Mon 16 Nov · 13:30–14:30 · Teams · with Jeroen V., Anouk D. and 3 more                 │
│ ✦ Making Short summary · Writing notes… · step 2 of 3  ▬▬▬▬▬▬▬░░░░  Cancel   (runs only)  │
│ ──────────────────────────────────────────────────────────────────────────────────────── │
│ [Formal] [Informal] [More ▾]                                       [ Copy ]  [ ⋯ ]        │
│ ──────────────────────────────────────────────────────────────────────────────────────── │
│ TL;DR                                                   │ Action items             + Add   │
│ - The demo is ready.                                    │ ☑ Add the by-id endpoint for …   │
│ Decisions                                               │   you · no date                   │
│ - …                                                     │ ☐ Prepare the pilot user list    │
│                                                         │   Sam O. · not sure of the owner  │
│ Built-in template · made 2 days ago automatically ·     │ [ Add 1 to Tasks              ]  │
│ Claude Code on this Mac · 412 words                     │ In Tasks                          │
│                                                         │ ☐ Send Legal the written …  Thu  │
│                                                         │ 1 in Tasks ›                      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Header (`meetingHeader`)

- The list toggle and the title, once (the lock icon for a private meeting, as today).
- One meta line: day, time range and where (Teams, the place, or "In person"), then "with …".
  - "with …" lists up to three other people by short name: "with Jeroen V.", "with Jeroen V. and Anouk D.", "with Jeroen V., Anouk D. and Priya N.". With four or more it reads "with 6 people".
  - "with …" is a `button` that opens today's people popover (`peopleList`): who each person is, their talking share, "didn't speak", and their tasks. The faces (`peopleStack`) go.
- The hidden meeting's note ("Hidden from the list · Show again") stays on the meta line.
- On the right: the plugins' `call.header` chips. "Review N tasks" shows only while the action items column is off, and it opens the Action items pane. The ⋯ moves to the strip.
- Under the header: the run line (`runLine`) and the plugins' minutes lines during a notes run, unchanged. Each minutes line is that plugin's first line of minutes, cut to 300 characters.

#### The strip

`div.ws-mtg-strip`, a flex row with a bottom rule. From the left:

1. **In the summary:** the summary tabs, a `role="tablist"` of buttons (`meeting-summary-tab`, `data-key`). At most four are visible. The rest sit in a "More ▾" menu at the end of the tabs. **In any other pane:** "← Back to summary" (`meeting-back`) and the pane's name as a quiet label ("Transcript", "Notes", "Files", "Action items").
2. A spacer.
3. **The primary**, at most one, by the table below.
4. **⋯** (`data-menu="meeting-<id>"`), the meeting's menu (below).

A meeting without a transcript yet (upcoming, pending, blocked, none, offline) has no tabs. The strip holds only ⋯, and the explainer card shows in the pane area as it does today.

**The primary in the summary**, by the tab shown:

| The tab | Primary | Notes |
|---|---|---|
| Has a document (a template tab with its document, or a document tab) | "Copy" (`meeting-copy-tab`) | Copies the document's Markdown (today's `doc-copy`). The label reads "Copied" for 1.5 s. |
| A plugin tab with minutes | "Copy" | Copies the minutes text. |
| A plugin tab without minutes | none | The pane says "No <plugin> summary for this meeting yet." |
| A template tab without its document, while a run makes it | none | The words "Writing <name>…" sit in the primary's place (not a control). The run line shows the steps. |
| A template tab without its document, whose last run with that template failed | "Try again" (`meeting-make-tab`) | The pane shows today's `lastRunBanner` text. |
| A template tab without its document, on a meeting with a transcript (saved, saving or found) | "Make <name>" (`meeting-make-tab`, `data-template`) | One click: `meeting_notes {templateId, findTasks: true}` through `withChoice`, as Make notes does. |

In a pane the strip has no primary. The Notes pane keeps its own toolbar, and Transcript and Files have their own tools.

#### Summary tabs (a pure model, `meeting-view-model.js` `summaryTabs`)

- **Pins:** `settings.meetings.summaryTabs`, in order. A pin stays only while its template exists (`templatesOf`), or, for `plugin:<id>`, while that plugin is installed and on.
- **A template pin** is a tab labelled with the template's name. Its document is the meeting's document whose `template` (or `id`) is that template.
- **A plugin pin** is a tab labelled with the plugin's name. Its text is that plugin's `call.minutes` for this meeting.
- **The meeting's other documents** (unpinned templates, older documents) follow the pins as tabs, the main document first.
- **With nothing pinned,** the tabs are the meeting's documents, main first. A meeting with no document gets one tab for the template it would use (`mc.tpl.template`).
- At most four tabs show. The rest go under "More ▾", in the same order.
- **The tab shown:** the one chosen for this meeting in this session (`v.summaryTab[id]`) while it exists. Otherwise the first tab with a document or minutes. Otherwise the first tab.

**The summary pane** of a tab with a document:
- the failure banners, as today (`saveBanner`, `lastRunBanner`);
- the document as a page (`docBody`, max 720 px, the tags only, no repeated title);
- the grey line saying who made it (`docParts().foot`), with "make it the main notes".

**Before there is a document:**
- **A transcript saved, no document:** a quiet card "No <name> yet." with the line "<n> lines from <m> speakers are in the meeting folder." and the link "More options…". The link opens today's Make notes dialog (template, wishes, find tasks, remember).
- **Saving from Teams:** today's saving card or save banner, then the same card.
- **A run making it:** the skeleton, as today.

#### Panes behind ⋯

| Pane | Body | Hash |
|---|---|---|
| Summary | above | `summary` |
| Transcript | today's `transcriptTab`: search, speaker chips with talking share, glossary marks, "Who is this?", task links | `transcript` |
| Notes | today's `notesTab`: the document picker with every document, New summary, versions, Side by side, Copy, Save a copy, Edit, the document's ⋯ (make main, make again, edit the template, delete), the earlier-version bar, the edit conflict, and the Make notes form when there is no document | `notes` |
| Files | today's `filesTab`: every file with Preview and Save a copy, Copy path, Show in Finder | `files` |
| Action items | the column's content full width; only while the column is off | `tasks` |

- Esc in a pane (focus outside a field, nothing open) returns to the summary. So does "← Back to summary".
- The pane is view state (`v.pane`), kept for the meeting while it stays selected. A new meeting opens on the "Open a meeting on" setting.

#### The ⋯ menu (in this order; an item shows only when it applies)

1. Transcript
2. Notes
3. Action items (only while the column is off)
4. —
5. Make “<tab>” again (new version), when the shown tab has a document
6. Edit “<tab>”…, when the shown tab has a document. It opens the Notes pane with that document in the editor.
7. Save a copy (.md), when the shown tab has a document
8. Make notes with…
9. —
10. Hide from the list / Hide every “<title>” / Show in the list again (today's `hideMenuItems`)
11. Show in calendar
12. The plugins' `call.menu` items
13. — heading **Advanced**
14. Files
15. Show folder in Finder
16. Copy folder path
17. Download again from Teams
18. Import a transcript file…
19. —
20. Delete “<document>”… (danger), for the document shown

#### The action items column (`actionItems`)

- `aside.ws-mtg-items` with `aria-label="Action items"`, 300 px wide (280 px in Compact, from a token), beside every pane.
  - It sits beside the pane when the meeting section is at least 760 px wide, and drops below the pane when it is narrower (a container query on the meeting section). Nothing clips at 1000 px with the list open.
  - When "Show action items beside the summary" is off, the column is not drawn. Its content is the Action items pane, and the header shows "Review N tasks".
- **Header:** "Action items" and "+ Add". "+ Add" toggles today's add-a-task form (`data-form="meeting-task"`: the text, the owner select with Me first, Add).
- **To add:** the meeting's tasks in To review, in transcript order. A closed row has:
  - a checkbox `data-action="meeting-item-tick"`, labelled "Add <text>";
  - the text;
  - an owner line: "you · Fri 20 Nov", "you · no date", "Sam O. · not sure of the owner" (low confidence), "Nobody named".
  - A click on the row (not its box) opens it, closing any other. The open row shows:
    - the quote, a button to the transcript line (today's `meeting-goto-line`);
    - the owner select and the due date (today's `task-owner`, `task-due`);
    - "Not a task" (today's `task-dismiss`).
- **Ticks:** the person's own tasks (`isMine`) with an owner Connect is sure of are ticked when the column first shows a meeting. Ticks are view state per meeting (`v.ticked[id]`), never saved. A task that leaves To review leaves the ticks.
- **"Add N to Tasks"**, full width, shows while N ≥ 1 ticked. It calls the task target's `add(ids)` (below). Then:
  - the added rows move to "In Tasks";
  - the footer says "Added 2 to Tasks · Undo" (`role="status"`);
  - Undo calls `undo(ids)` for the rows this add moved, and only those, and they come back ticked.
  - A failure leaves the failed rows ticked, with the native sentence in red under the button.
- **In Tasks:** the meeting's tasks on the board (To do, In progress, Waiting, Done), each with:
  - a done checkbox (today's `task-done`);
  - the text, a button that opens it in Tasks (`task-open-today`);
  - its due date, or its column name when it has none.
  - Done tasks show greyed, last.
- **Footer:** "<n> in Tasks ›" opens the Tasks page filtered to this meeting (today's `meeting-board`). "None in this meeting yet." shows when the meeting has no task at all.
- The current Tasks tab's status select and "Accept all N" go. Status changes happen on the Tasks page. "Add N to Tasks" with everything ticked accepts all.

**The task target** (the one swap point for step 4):

```js
// ui/workspace/task-target.js
export function localTaskTarget({ moveTask }) {
  return {
    label: 'Tasks',
    add: async ids => /* moveTask(id, 'todo', { log: 'Accepted from review' }) for each */,
    undo: async ids => /* moveTask(id, 'review', { log: 'Moved back to review' }) for each */,
  };
}
```

`add` and `undo` both answer `{ done: [ids], failed: [{ id, message }] }`. The meetings controller gets the target injected (`taskTarget`). app.js passes `localTaskTarget({ moveTask })`. Step 4 passes the provider's target, and the label becomes the provider's name ("Add 2 to Todoist").

### Settings › Meetings

On the Note templates tab, above "Default template", a new card **"When you open a meeting"**:

- **Open a meeting on:** a segmented control "Summary | Transcript | Notes" (`openOn`).
- **Show action items beside the summary:** a switch (`actionItems`), with the line "Off: they move to ⋯ › Action items."
- **Summary tabs:**
  - the pinned entries in order, each with its colour dot, its name, "Move up", "Move down" and "Unpin";
  - under them, a "Pin a summary ▾" menu listing the templates and the plugins that write meeting summaries, not pinned yet;
  - the line "The first one that has a summary opens. With none pinned, a meeting shows its own documents.";
  - at four pins the menu is disabled, with the tooltip "Pin up to 4 summaries."
- Each template card's ⋯ gains "Pin as a summary tab" / "Unpin from summary tabs".

Each change saves at once through `mutate('settings_update', { meetings: { … } })`, as the other meeting settings do.

### Plugins' minutes as a tab

- **What a plugin draws.** `call.minutes` items are text, as now. The shim reads a minutes item with block breaks kept (`minutesText`):
  - `p`, `div`, `br` and headings end a line; a heading line starts with `#` marks; `li` starts a line with "- ";
  - entities are read, spaces are folded within a line, and runs of blank lines fold to one;
  - at most 20,000 characters per item, eight items per plugin.
  - `call.header` and `call.menu` keep `textOf` and its 300-character limit.
- **What the window shows.** A plugin tab joins that plugin's minutes items with blank lines and draws them with `renderMarkdown`. It escapes every character and makes no links, as for notes. The run line under the header still shows each plugin's first minutes line during a notes run.
- **Which plugins can be pinned.** The shim's `slots` event gains `minutesSlot: true` when the frame has added a `call.minutes` item, with or without a meeting shown. `pluginHost.minutesPlugins()` lists those plugins (`{id, name}`) for Settings.
- **What is pinned.** A pin is `plugin:<id>`. It shows while the plugin is installed and on, and is skipped otherwise.

### Native changes

- **`MeetingSettings` gains three fields** (`model.rs`; `apply` validates each, as for the other fields):
  - `openOn: "summary" | "transcript" | "notes"`, default `"summary"`. Otherwise refused with "Choose Summary, Transcript or Notes."
  - `actionItems: bool`, default `true`.
  - `summaryTabs: [string]`, default `[]`. Each entry matches `^[A-Za-z0-9_.:-]{1,100}$` (a template id, or `plugin:<id>`). Duplicates are dropped.
    - More than four is refused: "Pin up to 4 summaries."
    - A bad entry is refused: "Choose a template or a plugin to pin."
- **`template_delete`** also removes the deleted id from `summaryTabs`, beside resetting `defaultTemplate` and rules.
- **A new contract fixture, `meeting-view-settings.json`**, written by a test from the real settings: `{default, updated, afterTemplateDelete}`, each holding `{openOn, actionItems, summaryTabs}`. `meeting-rules-cases.json` changes because it carries the serialized meeting settings. Both are regenerated and committed.
- No change to records, jobs, notes runs, rules or sending.

### Deep links and opening

- `TABS` becomes `PANES = ['summary', 'transcript', 'notes', 'files', 'tasks']`.
  - `parseHash` reads any of them.
  - `meetingHash(id, pane)` writes the pane shown.
  - A link with no pane, or an unknown one, opens on the "Open a meeting on" setting.
- **Old links keep their meaning:**
  - `/notes` opens the Notes pane, which is today's Notes tab;
  - `/transcript` and `/files` open the same content as before;
  - `/tasks` opens the summary with focus on the column's first row, or the Action items pane while the column is off.
- **Opens from inside Connect pass no pane**, so the setting decides: a notification, Today's card, the calendar's Open notes and `openMeeting`'s default. The exceptions keep theirs:
  - a transcript line (task quote, `[hh:mm]`) opens the Transcript pane;
  - Settings › Meetings' "open the latest document" opens the Notes pane on that document.

## Copy

- Strip:
  - "← Back to summary", "More ▾", "Copy" / "Copied", "Make <name>", "Try again", "Writing <name>…".
  - Pane labels "Transcript", "Notes", "Files", "Action items".
- Summary pane: "No <name> yet.", "<n> lines from <m> speakers are in the meeting folder.", "More options…", "No <plugin> summary for this meeting yet."
- Header meta: "with <A>", "with <A> and <B>", "with <A>, <B> and <C>", "with <n> people".
- ⋯:
  - "Transcript", "Notes", "Action items";
  - "Make “<tab>” again (new version)", "Edit “<tab>”…", "Save a copy (.md)", "Make notes with…";
  - the hide items (unchanged), "Show in calendar";
  - heading "Advanced": "Files", "Show folder in Finder", "Copy folder path", "Download again from Teams", "Import a transcript file…";
  - "Delete “<document>”…".
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
  - the line "The first one that has a summary opens. With none pinned, a meeting shows its own documents.";
  - the tooltip "Pin up to 4 summaries.";
  - template ⋯ "Pin as a summary tab" / "Unpin from summary tabs".
- Native refusals: "Choose Summary, Transcript or Notes.", "Pin up to 4 summaries.", "Choose a template or a plugin to pin."

## Accessibility

- The summary tabs are a `role="tablist"` with `aria-label="Summaries"`. Each tab is a `button role="tab"` with `aria-selected` and `aria-controls` on the pane, which is a `role="tabpanel"`. ←/→ move between tabs, as other tablists in Connect do.
- "← Back to summary" is a button. Esc in a pane does the same when focus is not in a field and no menu or dialog is open.
- "with …" is a button with `aria-haspopup="dialog"`, labelled "Who was invited: <n> people". The popover keeps today's Esc handling.
- The column is an `aside` labelled "Action items". Each box is a real checkbox labelled "Add <text>". A row's open control is a `button` with `aria-expanded`. "Add N to Tasks" is a button. The footer status is `role="status"` (polite), so "Added 2 to Tasks" is announced once.
- The ⋯ menu keeps the existing menu handling (Enter, Space, Esc back to ⋯). "Advanced" is a menu label, not an item.
- Text stays at or above the step-1 minimum (10.5 px in Compact), and focus rings are unchanged.

## Rulings for the user

1. **The strip's primary is "Copy", with no "Send summary to <attendees>".** *Why:* sending a summary to the attendees is a new mail to several, often external, people. That needs a new native send path with its own recipient rules and confirm. Step 2 kept one gated path, replies only. Copy works with no new scope, and a send can come as its own step.
2. **Before a transcript, the header and today's explainer show, with no tabs. The column still shows, with "+ Add".** *Why:* the explainer already says what to do. Tasks added by hand belong to the meeting.
3. **Before a summary, the tab says "No <name> yet." and the primary is "Make <name>"** (one click, find tasks on). "More options…" opens today's Make notes dialog. *Why:* one click to the summary, and the wishes and remember options stay one step away.
4. **Pinned tabs are chosen in Settings › Meetings › Note templates** ("When you open a meeting", or a template's ⋯ › "Pin as a summary tab"). They are ordered with Move up / Move down, up to four, and stored natively as `summaryTabs`. *Why:* templates already live there. Native storage lets step 5's automations read the pins.
5. **With nothing pinned, the tabs are the meeting's own documents, main first. The meeting's unpinned documents always follow the pins, past four under "More ▾".** *Why:* it works with no setup, and a pin never hides a document.
6. **Automatic notes still make one template per meeting** (the rule's or the default). A pinned tab not made yet offers "Make <name>". *Why:* no new processing engine. Step 5 brings the Formal and Informal automations.
7. **The Notes pane is today's Notes tab:** every document, versions, Side by side, edit, make main, delete, and the Make notes form. *Why:* Connect has no personal notes, so its notes are the documents. This keeps every document tool one click behind ⋯.
8. **Transcript and Notes go behind ⋯, and Files under ⋯ › Advanced** with the folder actions, Download again and Import. The `.vtt` shows only through Files › Preview. *Why:* the user's decision. Advanced holds what only matters when something is wrong.
9. **The Tasks tab goes. Its rows live in the column:** to add, then "In Tasks" with done boxes. Owner, date and "Not a task" open in the row, and status changes on the Tasks page. With the column off, ⋯ › Action items and the header's "Review N tasks" open the same content as a pane. *Why:* the action items sit beside the summary they came from, and turning the column off loses nothing.
10. **"Add N to Tasks" accepts the ticked To review tasks** (review → todo) through an injected `taskTarget` (`label`, `add`, `undo`). Own tasks with a sure owner are pre-ticked. Undo moves only that add's rows back to review. *Why:* it reuses the existing tasks code and gives step 4 one object to swap.
11. **`#/meetings/<id>/<pane>` takes summary, transcript, notes, files or tasks.** Old links open what they showed before (`/notes` the Notes pane, `/tasks` the column). A link without a pane, and every open from inside Connect, uses "Open a meeting on". *Why:* no old link breaks, and the setting decides everywhere else.
12. **The Meetings page keeps two sections, the list and the meeting.** The panes are no longer separate sections, so "Notes beside Transcript" goes. The layout moves to the v2 key, keeping the list's width and folded state. *Why:* panes behind ⋯ cannot also be movable sections. Side by side for documents stays in Notes.
13. **The header's people line is the reference app's "with Jeroen V. and Anouk D."** (up to three names, else "with 6 people"). It opens today's people popover with talking share and tasks, and the faces go. *Why:* one calm line, and the talking share keeps a single home.
14. **The column sits beside every pane at a meeting width of 760 px or more, and below the pane when narrower.** *Why:* at 1000 px with the list open, three columns do not fit, and nothing may clip.
15. **A plugin's `call.minutes` can be a pinned tab (`plugin:<id>`), drawn as escaped Markdown with Copy.** The shim keeps line breaks in minutes, up to 20,000 characters an item. The run line keeps one line per plugin. *Why:* the Podervianskyi Informal summary can arrive as a marketplace plugin with no new plumbing, and the window still never shows plugin HTML.
16. **The ⋯ moves from the header to the strip, and "Review N tasks" shows only with the column off.** *Why:* the reference app's strip, where the one primary and ⋯ sit together, keeps at most two visible controls beside the tabs.
17. **The three settings are app-wide, in native `MeetingSettings`.** *Why:* they sit with the other meeting settings, and like `view` they are not per workspace.
18. **Esc in a pane returns to the summary.** *Why:* the keyboard way back that the reference app's "← Back to summary" implies.

## Left to the builder

- Exact CSS values within the step-1 tokens, and whether the column's narrow rule is a container query or a class set from the section's width.
- Where `summaryTabs`, the primary and the owner line live (a new `meeting-view-model.js` is suggested, kept pure and tested).
- Whether a column row's open state is a `button` with `aria-expanded` and a region, or a `details`, as long as the box stays outside the open control.
- Plan order. Suggested:
  1. native settings and the fixture;
  2. the pure model;
  3. the section, strip and panes (the column off);
  4. the column and the task target;
  5. settings;
  6. plugin minutes;
  7. the checks.
