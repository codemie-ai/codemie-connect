# Meetings, transcripts, notes and tasks — design

**Status:** approved prototype (v5), awaiting implementation plan approval
**Prototype:** `prototypes/meetings/` (local, git-ignored): `index.html`, `README.md`, screenshots in `validation/`
**Replaces:** Echo's call import, minutes and “commitments” for people who use Connect

## Problem

Teams transcripts sit unused. Echo can import them and write minutes, but the UI hides the template choice until after the first run, shows a 403 like “no transcript”, keeps action items read-only, and stores owners as free text. Connect already has the calendar and the AI runner; it should turn a meeting into notes and tasks in a couple of clicks.

## What the person gets

**Transcripts arrive on their own.** When Teams has a transcript, Connect saves it into the meeting folder straight away; there is no Download button or setting (nothing goes to the AI until notes are made). **Make notes** is the one action: it saves the transcript first if needed, and while a meeting is still waiting for Teams, *Make notes as soon as it arrives* queues them. *Download again* stays in the ⋯ menu for when Teams updates a transcript or the folder was deleted.

1. **Calendar** — every Teams meeting shows a transcript badge: *notes ready*, *transcript to process*, *working on it*, *needs you*, *notes after the meeting*. A switch shows only meetings with transcripts. The event card has a “Transcript & notes” section with the state, the template and the next action (Make notes, Check now, Import, Try again, Show in Meetings).
2. **Meetings page (one page, no separate meeting page)** — left: a compact list grouped by day (time, title, coloured status + template; a spinner only while something runs), filters *All · To do (n) · Ready · Needs you (n) · Upcoming*, search, “Make notes for all n”, a switch for meetings without a transcript, ↑/↓ moves. Right: the selected meeting — date/time/place, **people by name** (organizer, you, company for guests; dimmed if they never spoke), a one-line status strip *Transcript › Notes › Tasks* with a button only where something is needed, a slim progress line during a run, and tabs **Notes · Transcript · Tasks · Files · People**. The list can be hidden for more room. Today, calendar cards, task quotes and notifications open the meeting here (`#/meetings/<id>/<tab>`).
3. **Several documents per transcript** — each template run is its own document next to the others (automatic *Meeting notes* plus any summary made on demand); the same template again adds a version. Document chips, **One / Side by side**, one **main** document (`notes.md`), copy, save a copy, edit, delete.
4. **Tasks page (renamed from commitments)** — board *To review · To do · In progress · Waiting · Done* plus a list view (*I owe · Owed to me · Nobody named*), filters (who, person, meeting, due, search), drag and drop **and** a “Move to” menu, quick add per column, a drawer (title, status, owner from attendees first, due with quick picks, notes, the meeting and the exact quote with a link to the transcript line, history), delete with undo, dismissed tasks restorable. Overdue cards sort first and show red.
5. **Settings › Meetings** — *Transcripts & folders*, *Note templates*, *Automatic rules*, *Glossary & tags*, *Tasks*.

## Transcript states

| State | Meaning | Next action |
|---|---|---|
| `upcoming` | Meeting not over | toggle “make notes automatically” |
| `pending` | Ended < 24 h ago, Teams has no transcript yet | Check now (auto every 10 min, from 10 min after the end, for 24 h); *Make notes as soon as it arrives* |
| `available` | Found in Teams; Connect is saving it, or the save failed (reason kept; retried automatically unless the folder or sign-in needs you) | Make notes (saves first); Try again after a failed save |
| `downloaded` | Transcript saved, no notes (“No notes yet”) | Make notes |
| `ready` | ≥ 1 document | Another summary |
| `failed` | Last notes run failed (reason kept) | Sign in again / Try again; existing documents untouched |
| `blocked` | Graph 401/403 (e.g. other tenant, `GraphAccessToTranscriptsDisabled`) | Import file; copyable message to the organizer |
| `none` | Ended > 24 h, no transcript | Import file |
| `offline` | Not an online meeting | Import file |

`downloading` (“Saving the transcript”) and `processing` are transient run states, never persisted.

## Folder and files (Echo-compatible)

`<meetings root>/<YYYY-MM-DD>_<HHMMSS>-<slug>/` — time = when Teams started transcribing (fallback: event start), local time. Slug: lowercase; every run of non-letters/digits → `-`; trimmed; cut to 60 chars; `-2`, `-3` on collision. Default root: `~/CodeMie Connect/Meetings` (`%USERPROFILE%\CodeMie Connect\Meetings` on Windows) — visible and outside `~/Documents`, so macOS asks no folder-access question; changeable in Settings. (The Connect data folder lives in Application Support and is not meant to be browsed.) Alternative patterns: `<date>-<slug>`, `<slug>-<date>`.

| File | Content |
|---|---|
| `transcript.vtt` | Original from Teams, untouched (or `imported.vtt` / `imported.txt`) |
| `transcript.md` | `# Title`, header lines, then `**Name** [hh:mm:ss]` + text; same speaker within 2 s merged |
| `segments.json` | `[{speaker:"me"\|"remote", name, start, end, text}]` |
| `meeting.json` | subject, start, end, organizer, attendees, join_url, series_id, source |
| `meta.json` | source, started_at, ended_at, template(s), ai profile, versions |
| `notes.md` | the main document |
| `notes.<template-slug>.md` | every other document |
| `notes-history/<YYYY-MM-DD_HHMM>-<template-id>.md` | earlier versions |
| `tasks.json` | `[{id, task, owner, due, confidence, quote, t, status}]` (Echo `actions.json` shape) |
| `run.log` | what each AI run did, or why it failed |

## Templates

Built-in **Meeting notes** (default; adapted from `ai-twin-knowledge/.claude/agents/meeting-note-writer.md`: knowledge not minutes, topics, standalone bullets, decisions with why, conditional sections, glossary spelling, tags only from the tag list with a missing one named, one owner per task, “we” → me, due only when stated, quote per task) and **Short summary** (summary, decisions, action items). Plus the person's own templates and **skills**: a local `SKILL.md` (found in `~/.claude/skills/*/` or added by path), whose text is read at every run and used as the instructions, with the transcript passed as input (the runner keeps tools disabled, so a skill cannot read the folder itself). Built-ins are editable with “Reset to built-in”. Variables: `{{title}} {{date}} {{participants}} {{me}} {{glossary}} {{tags}} {{wishes}} {{transcript}}`. Per-run “Anything to focus on?” wishes.

Choice order: chosen for this meeting → first matching automatic rule (title contains / organizer / attendee company / number of people; may make notes automatically) → default template. The choice and its reason are shown wherever the template appears.

## Glossary and tags

Two free-text Markdown documents (`glossary.md`, `tags.md` in the meetings root) edited in Settings with Write/Preview, or linked files the person already keeps (e.g. `TERMS_TAXONOMY.md`, `TAG_TAXONOMY.md`). Connect reads: the name under `## Me` and quoted aliases after it; every **bold** term/person; quoted spellings after “heard as” (any section); every `` `tag` `` starting a list item. A live “What Connect picks up” panel shows the parse.

## Tasks from notes

Owner must be an attendee (else nobody) unless the person picks someone else; “we” → me; due only when stated; low-confidence owners flagged “Check the owner”; new tasks land in *To review* (setting can send them to *To do*); re-runs keep existing tasks (match by transcript line), add only new ones.

## Access

Reading transcripts needs two new Microsoft scopes, `OnlineMeetings.Read` (find the meeting by its join link) and `OnlineMeetingTranscript.Read.All` (list and download transcripts). They are an opt-in toggle, *Read Teams transcripts*, in Settings › Meetings › Transcripts & folders, which re-runs sign-in like the existing write toggles. A tenant that has not consented shows the reason instead of an empty list.

## Template editor preview

The editor shows the latest document made with that template (from any meeting) and a **Try on a meeting** action that runs it for real; there is no simulated preview.

## Non-goals (this release)

Recording audio; syncing tasks to To Do/Planner/Jira; editing Teams meetings; DOCX import (VTT and TXT only); sharing notes; CodeMie (remote) skills as templates.
