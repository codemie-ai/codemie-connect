# Calmer Meetings page — design

**Date:** 2026-11-19 · **Branch:** `feat/meetings-calm` from `workspace-app` · **Prototype:** `prototypes/meetings-calm/` (local, git-ignored; port 5213; Before/After switch and a "What changed" list)

## Why

The Meetings page that shipped on `workspace-app` works but reads as noisy. On one ready meeting the title appears three times (header, the notes' properties table, the notes' own heading), the people three times (six chips, the properties table, the People tab), and the counts three times (the Transcript › Notes › Tasks strip, the tab badges, the document chips). Seven bands of controls sit above the first line of the notes. Every row in the list is coloured, including the normal "Notes ready". The user approved a calmer prototype and asked for three additions: hide noisy meetings (and see hidden ones), no buttons that appear on a list row, and days that fold.

## Goals

- The list shows what needs the person first, and colour only for that.
- A meeting's title, people and counts appear once.
- Noisy meetings can be hidden from the list, one at a time or a whole recurring series, and brought back.
- Days in the list fold and unfold.
- Every feature the page has today stays reachable: versions, compare, edit, make main, make again, delete, import, download again, check now, Make notes for all, plugins' call slots.

## Non-goals

- No native change: no new operation, record field or contract fixture. Hiding is a view preference, like hidden calendars.
- Hiding doesn't stop automatic notes, transcript checks or Calendar badges. It only takes the meeting out of the list, the Needs you card, the sidebar count and Today's "From your meetings" card.
- Settings › Meetings, the Calendar event card and the Make notes / Import dialogs keep their current look.

## Anti-goals

- A button that appears when the pointer is over a list row. A click on a row only opens the meeting, so it can never start notes by accident.
- A hidden meeting that can't be found again.
- Losing any action the page offers today.

## Approaches considered

1. **Restyle in place (picked).** Rework `view-meetings.js`, `view-meeting-tabs.js`, `meetings-model.js` and `meetings-controller.js` and their CSS, and keep hidden meetings in `localStorage` (`codemie.meetings.hidden`), as `codemie.calendar.hidden` does for calendars. This needs no native change, and the tests stay where they are.
2. **Hide natively.** Add `hidden` to the meeting record through `meeting_set`, and `hiddenSeries` to `MeetingSettings`. This would survive a reinstall and could feed plugins, but it needs Rust, contract fixtures and a record for every event. It also loses the hidden flag on sign-out, because meeting records are purged then. Not worth it for a view preference.
3. **A new page beside the old one.** Twice the code to keep up, for no gain.

## The design

### The list (`view-meetings.js` `list`, `meetings-model.js`)

- **Header: one row.** "Meetings", then three icon buttons:
  - Search shows the field when clicked, or on `/`. The field stays visible while it has text.
  - Filter opens a menu:
    - one of **All meetings · Needs you · With notes · Coming up**;
    - two switches: **Meetings without a transcript (n)** and **Hidden meetings (n)**.
  - ⋯ holds **Fold all days · Unfold all days · Import a transcript file… · Check Teams for new transcripts · Meetings settings**.

  This replaces the five-way segmented filter, the import/check icons, the "N transcripts without notes" banner and the footer switch. The "Connect isn't reading Teams transcripts yet" notice stays.
- **Needs you card**, pinned on top in *All meetings*. It holds today's `process` and `attention` meetings: no notes yet, couldn't save, failed, blocked, waiting. Hidden meetings are left out, the newest come first, and each row shows its day. Its header has a fold chevron, the count and **Make notes for N** (the existing `meeting-make-all`) when N ≥ 2. The card isn't drawn when it's empty.
- **Day groups.** Below the card, the other meetings are grouped by day, newest first. In *All meetings*, today's meetings still to come show greyed at the top of Today, with "in 50 min" and "notes after" (my call; the current All shows only meetings that have ended).
  - Clicking a day's heading folds it; ⌥-click keeps only that day open.
  - A folded day shows "N meetings", and a blue "● n" when some of them need the person or have tasks to review.
  - Folded days are view state for the session (`v.folded`, a set of day keys), not saved.
- **Rows.** Title, then a grey line with the time, the document name ("2 documents" when there are more) and any "n to review".
  - Colour and a dot appear only for what needs the person: no notes yet (blue), notes failed and couldn't save (red), blocked (amber). A running job shows "Writing notes…" in purple with the spinner.
  - Rows carry no buttons; right-click opens a menu (below).
  - Meeting titles use Geist (sans), while times and labels stay in Geist Mono.
- **Hiding.**
  - **How:** right-click a row (the menu: Open · Hide from the list · Hide every "<title>" when the event has a `seriesId` · Show in calendar), or use the meeting's ⋯ menu. Every hide shows a toast with Undo.
  - **What it does:** a hidden meeting leaves the list, the Needs you card, the sidebar count (`shell.js`) and Today's card. If it was the one shown, the next visible row opens.
  - **Storage:** `codemie.meetings.hidden` holds `{ids: [...], series: [...]}`; a series entry covers past and future occurrences.
  - **Getting it back:**
    - The list ends with "N hidden meetings · Show".
    - Filter › Hidden meetings shows them greyed, each with a "Hidden" tag.
    - A search also finds hidden meetings, greyed.
    - A hidden meeting opened from Calendar, Today or a link shows in the list greyed while it is selected. Its header says "Hidden from the list · Show again".
- **Keyboard:** ↑/↓ still move through the rows on screen, which skips folded days.

### The meeting (`view-meetings.js` `detail`, `view-meeting-tabs.js`)

- **Header.**
  - The title, once.
  - One grey line: day, time range, Teams or the place, and an avatar stack ("6 people"). The stack opens a popover with today's People tab content: name, organizer/you/company, dimmed when they didn't speak, "+n more".
  - The People tab and the chip row go.
  - On the right: **Review N tasks** while tasks wait for review (it opens the Tasks tab), the plugins' call-slot chips, and ⋯.
  - The ⋯ menu adds Hide from the list / Hide every "<title>" / Show in the list again to today's items.
- **No status strip.** `statusStrip` goes. A running notes job or save shows one slim line under the header: the step text, a progress bar and Cancel, the same data the strip shows now. Plugins' `call.minutes` lines stay under it.
- **Actions sit where they're explained.** The header's `primaryAction` goes.
  - Make notes lives in the Notes tab's form, and Try again in the run-failed and save-failed banners. Import and Check now live in the explainer cards.
  - "Make notes with…" stays in ⋯.
- **Tabs: Notes · Transcript · Tasks · Files.**
  - Tabs show only when the meeting has a transcript, saved or being saved.
  - For upcoming, pending, blocked, none and offline meetings the explainer card shows alone (`explainer` already has the text and actions), with no tabs.
  - Tab counts go, except a blue count on Tasks while tasks wait for review.

### Notes (`view-meeting-tabs.js` `notesTab`, `docCard`; `markdown.js`)

- **One toolbar** replaces the document chips, the "+ Another summary" chip, the One / Side by side switch and the card header.
  - **The document picker:** a ⋯-style menu button showing the current document with "1 of 2". Its menu lists each document (main, words, made when and how) and **Compare side by side** / **Show one at a time**.
  - **New summary:** opens today's Make notes dialog.
  - **Version:** the select stays when there are versions.
  - **Side by side:** an icon toggle, shown with 2 or more documents.
  - Then Copy, Save a copy and Edit, plus the document's ⋯ menu (Make it the main notes, Make again, Edit the template, Delete…).
  - While a run makes another document, a slim purple line sits under the toolbar ("Making Short summary…").
- **The document reads as a page.**
  - No card border, max width 720 px, Geist 15 px.
  - `renderMarkdown(md, {front: 'tags', dropTitle})` shows only the front matter's `tags`, as small chips, and drops a first `#` heading that equals the meeting title. Other front-matter keys stay in the file and aren't drawn.
- **Who made it moves to the bottom.** The provenance line and "You asked: …" go to one grey line under the document: template kind, words, made when, automatically or by you, the Claude profile and model, and the version. The earlier-version bar and the edit conflict banner stay where they are.
- **Compare:** two columns, each with its document select, as today.

### Tasks (`view-meeting-tabs.js` `tasksTab`)

- The heading reads "2 to review · 1 on the board", with **Accept all N** (N ≥ 2) and **Open board →**.
- Rows keep the native owner and date controls and status select, styled as quiet chips: no border until hover. The controller stays unchanged.
- Accept and × show only on tasks waiting for review. The quote line keeps its link to the transcript moment.

## Left to the builder

- Exact CSS values, within `workspace.css`'s tokens and the prototype's spacing.
- How the right-click menu is drawn. One `details.ws-menu` positioned at the pointer, closed by the next click or Escape, is enough, as long as the same items stay reachable from the meeting's ⋯ menu for keyboard users.
- Folding the Needs you card: view state, like the days.
