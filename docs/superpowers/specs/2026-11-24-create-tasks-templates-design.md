# Create-tasks delivery and automation templates · design

**Status:** written on 2026-11-24 from the rollout overview's decisions and the code. This is step 5 of `2026-11-22-workspace-next-rollout-design.md`. Decisions the overview leaves open are ruled on below, under "Rulings".
**Builds on:**
- step 4, `2026-11-23-task-provider-design.md`: one active task provider (Local or a plugin such as Todoist), stable task keys, the key ledger, `tasks::create_by_key`, the kinds `task | reply | waiting | budget`, the outbox and the `task_sync` job that runs with the window closed, and "looks handled" (`handled`, `keptEvidence`, `task_handled {id, evidence}`);
- step 3, `2026-11-23-meetings-view-design.md`: summary tabs pinned in `settings.meetings.summaryTabs` (a template id or `plugin:<id>`), a plugin's `call.minutes` as a tab;
- the meetings design, `2026-11-17-meetings-transcripts-tasks-design.md`: note templates, automatic rules, the `meeting_notes` job and its automatic key `meeting_notes:auto:<meetingId>`;
- the automations engine (DESIGN 6.6): `src-tauri/src/workspace/automations/` (`rules.rs` model and matching, `engine.rs` rounds and operations, `context.rs` what a run reads, `run.rs` the run and its deliveries) and `ui/workspace/view-automations.js` / `automations-controller.js`.

**Reference (read-only):** the reference app's daily habits as the overview lists them: the morning briefing, the inbox triage with a `@reply` task per item needing the user, commitments in both directions (`@waiting` for others' promises), the budget-request reply (a `@budget` task and a reply draft) and the formal meeting summary.

## Intent

The user keeps their day running on a few habits of the reference app: a briefing before work, every message that needs them turned into a reply task, promises (theirs and other people's) turned into tasks, a budget request answered with a task and a draft, and a formal summary of each meeting they can share. Connect already has the Automations page (schedules, events, Claude runs, Today and notification deliveries, reply drafts) and, since step 4, a task provider that holds tasks with the window closed. What is missing is a way for an automation to make tasks, and ready-made templates for those habits.

This step adds one delivery, **Create tasks**, which makes tasks in the active provider through `create_by_key`, so a rerun, a retry or a task the user removed never makes a second one. It adds five templates to the gallery: Morning briefing (replacing Morning brief), Inbox triage, Commitments, Budget request reply and Formal meeting summary. The Formal summary does not run Claude itself: it hands a meeting to the existing note-template processing.

## Goals

- **Create tasks** as a Deliver switch on an automation that reads messages. Claude's answer may list tasks; each one cites a message it was given, gets a key from that message and its kind, and is made once in the active provider (Local, or Todoist while it is on), window open or closed.
- **Looks handled from automations.** Inbox triage and Commitments may say that an open `reply` or `waiting` task looks handled; Connect flags it and never closes it.
- **A read of recent messages** ("Messages since the last run", both directions) for Commitments.
- **Five templates** in the gallery, with the reference app's schedule and words.
- **Formal meeting summary** on the existing note-template processing: a built-in "Formal summary" note template, made for each meeting once its transcript is ready.
- **Compact and Default** draw the same markup; Compact differs only through the step-1 tokens.

## Non-goals

- The Informal (Podervianskyi) meeting summary. It is a later marketplace plugin. Its slot already exists (below, "Informal summary"); nothing is built for it here.
- End of day, repo digest and performance in the reference app's form. Connect's own End-of-day wrap-up and Weekly reflection templates stay as they are.
- Several times a day in one schedule, AI-drafted nudges, sentence-based inbox rules.
- Checking that a budget request's project exists.
- Real-desktop screenshots. They are deferred to one announced pass at the end of the rollout.

## Anti-goals

- **Duplicate tasks.** A rerun of the same morning, a retry of a failed job, a catch-up after a closed night, a second run reading the same message: none may make a second task for the same message and kind.
- **Recreating what the user removed or finished.** A task the user deleted, completed or withdrew (in Connect or in Todoist) is never made again by an automation.
- **Tasks from nowhere.** A task Claude names without citing a message Connect gave it is dropped. Claude cannot invent a source, a link, an address or a key.
- **Anything sent to a person.** Automations still send nothing. The budget reply is a draft in the reply box until the user's step-2 Send. Drafts stay drafts.
- **Losing tasks with the window closed.** A task made at 08:00 with the window closed is in the cache and the outbox, and reaches Todoist when it can.
- **Breaking automatic meeting notes.** A Formal summary never takes the place of a meeting's automatic notes.
- **Token leaks.** No change here touches the provider token; it stays where step 4 put it.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **A. Tasks in Claude's structured answer, made natively by key.** The run asks for a `tasks` array only when Create tasks is on; Connect validates each entry against the blocks it gave Claude and calls `create_by_key`. | Small schema addition; the key and the provider logic stay native and tested; works with the window closed. | **Chosen** |
| B. Reuse the answer's `items` as tasks. | No schema change, but items are free summary lines (FYIs too); a kind, a due date and an owner can't be told apart. | Rejected |
| C. Let Claude write task text into the key. | Simpler parsing, but Claude words the same task differently each morning, so every rerun would make a new task. | Rejected: anti-goal "duplicate tasks" |
| D. Formal summary as a Claude automation with the transcript in its context. | One engine, but it duplicates note templates (glossary, speakers, versions, Copy, the summary tab) and the transcript budget. | Rejected: the overview says "built on the existing meeting-template processing" |

## Design

### 1. The model (`automations/rules.rs`)

`Automation` gains:

| Field | Meaning |
|---|---|
| `read.recentMessages` (bool) | "Messages since the last run" (§3). |
| `deliver.createTasks` (bool) | Create tasks (§2). |
| `deliver.meetingSummary` (string or null) | A note template id: this automation makes that template's document for a meeting (§6). |
| trigger event `meeting_ready` | "A meeting's transcript is ready" (§6). |

Validation (each refusal carries `field`):
- `createTasks` needs something to make tasks from: `needsReply`, `recentMessages`, or a message trigger (`mail_from`, `chat_from`, `critical`) with `triggerConversation`. Otherwise: "Tasks are made from messages. Tick Needs your reply or Messages since the last run, or start it from a message." (`field: deliver`).
- `meetingSummary` goes only with the `meeting_ready` event, and a `meeting_ready` automation must have one: "A meeting summary starts when a meeting's transcript is ready." / "Choose the template to make." (`field: deliver`; asked before the instructions, which a summary automation may leave empty). The template must exist (`templates::all`): "Choose a note template." One that reads something or makes tasks: "A meeting summary automation reads nothing and makes no tasks." A summary automation reads nothing (`read` all off), creates no tasks and no reply draft; its `prompt` is optional and becomes the run's wishes (up to 4,000 characters).
- Every other automation keeps its rules (a prompt is required).

**Event cooldown per sender.** Today an event automation waits ten minutes after any event run, so three budget mails in one sync round start one run. The cooldown is now kept per automation and sender: the mail sender's address, the Teams chat id, or the meeting for `meeting_ended`; `meeting_ready` has no cooldown (one run per meeting, deduped by key). The hourly cap of 30 runs and "one run at a time per automation" stay. *(amended 2026-11-27)* Scheduled runs (a schedule slot or its catch-up) are exempt from the hourly cap: they neither wait for it nor count toward it, so event runs can never starve a schedule such as the weekday morning briefing. Event-triggered and manual runs keep the cap.

### 2. Create tasks

**Asking.** When `deliver.createTasks` is on, the run's input gains `"createTasks": true` and the system prompt gains a task section (`prompts::AUTOMATION_TASK_RULES`, added only then). The schema gains two optional arrays:

```json
{ "tasks": [{ "text": "Reply to Olga about SOW section 4", "kind": "reply", "sourceId": "s4",
              "due": "2026-11-24", "owner": "Olga Petrova" }],
  "handled": [{ "sourceId": "s9", "evidence": "Olga sent the signed SOW at 14:10" }] }
```

The task rules tell Claude: one task per message and kind; `kind` is `reply` (the user owes an answer), `waiting` (someone promised the user something), `task` (the user promised something) or `budget` (a budget request to approve); write the text as a short instruction that starts with a verb; set `due` only when the message fixes the date, resolved to `YYYY-MM-DD` from the message's own date; never a task for a message that only informs; `handled` only for a `<item kind="commitment">` block whose kind is `reply` or `waiting` and only with evidence in the data.

**Checking** (`prompts::parse_automation`, Rust, before anything is written):
- `tasks` is read only when Create tasks is on; at most 10 entries are kept.
- `sourceId` must be a handle Connect gave for a **message** block; anything else drops the entry.
- `kind` must be one of the four, else `task`. Text is one line, cleaned like items, at most 300 characters, not empty.
- `due` must parse as a date from 2000 on; otherwise it is left out. `owner` is one line, at most 100 characters.
- Two entries with the same message and kind: the first is kept.
- `handled` entries must cite a commitment block of an open `reply` or `waiting` task; evidence is one line, at most 200 characters; at most 10.

**Making** (`run.rs`, after Claude answered, before the run is committed):
- The message must still be readable (`source_available`, selected, permitted); a message gone meanwhile drops its task.
- **Key:** `task_key("message:<message record id>", "<kind>")` (§3 of step 4's key, with the kind in place of the text). The wording Claude chose never changes the key.
- **Body:** `{text, kind, status: "todo", sourceId, sourceRevision, due, owner, ownerName, notes, history}`:
  - `owner`: the user's own task (`task`, `reply`, `budget`) has `owner: "You"`. A `waiting` task's owner is the cited message's sender (`fromAddress`, `from`) unless that sender is the user, else Claude's `owner` as a name only; with neither, it is the user's (step 4, "Nobody named goes as the user's own").
  - `due`: `reply` and `budget` default to the run's local day; `waiting` defaults to two working days after the message; `task` has none unless Claude gave one. Claude's date wins when given.
  - `notes`: "From <sender> · <subject or chat title> · <date>" (escaped, from Connect's record, never from Claude).
  - first history line: "Made by <automation name>".
- `tasks::create_by_key(core, "personal", body, key)` makes it in the active provider, or answers that the key already has a task (or had one). Each call takes the meeting-folder lock and the repository itself, so the run drops its repository guard before the first call and takes it again to commit.
- **Order and retries.** Tasks are made before the run record is committed. A crash or a failed commit in between makes nothing new when the job runs again: the keys find the tasks.
- **Looks handled:** each checked `handled` entry flags its task through the same code as `task_handled {id, evidence}` (moved to `task_provider::handled::flag`), which skips a task already flagged with that evidence or kept open against it, and never completes anything.

**What the run records:** `tasks: {made: [{id, text, kind}], existing: <n>, dropped: <n>}` and `handled: <n>`; `delivered` gains `"tasks"` whenever Create tasks is on and the run is `ok`. A run that made nothing still says "Tasks: none needed", or "Tasks: none made" when entries were left out.

**Local never makes a removed task again.** Step 4's ledger is consulted for a provider only. With Local, a deleted task leaves no trace, so tomorrow's triage would make it again. `task_delete` of a Local task that has a key now writes the ledger entry `local|<key>` `removed` in the same transaction, and `create_by_key` reads the ledger for Local too. Undo of the delete still saves the task back (`task_save` does not read the ledger). A Local task that is done stays a record, so its key is found.

### 3. What a run reads

- **Messages since the last run** (`recentMessages`, section `recentMessages`, after `needsReply`): every synced mail and Teams message the workspace shows, both directions, newest first, since this automation's last `ok` run started, or first stored by Connect since then (`seenAt`, so a message synced late is still read; the first run: the last 24 hours; never more than 3 days back), at most 40, each cut to 500 characters, with `received=` and `by="user"` on the user's own. It reads Microsoft, so it needs the signed-in account like the other message reads.
- **Commitment blocks say their kind.** `<item kind="commitment">` gains `task-kind="reply|waiting|budget"` (absent for a plain task) and `handled="true"` when flagged, so the briefing can put budget requests first and the triage knows which reply tasks exist.
- The system prompt documents both (`recentMessages`, the `task-kind` attribute, `createTasks`).

### 4. The templates

The gallery (`TEMPLATES` in `view-automations.js`) lists, in this order:

| Template (id) | When | Reads | Delivers | Catch up |
|---|---|---|---|---|
| **Morning briefing** (`morning-brief`) | Weekdays 08:07 | Today's calendar, Needs your reply, My commitments and notes | Today, notification | on |
| **Inbox triage** (`inbox-triage`) | Weekdays 08:00 | Needs your reply, My commitments and notes | Tasks, Today | on |
| **Commitments** (`commitments`) | Weekdays 08:03 | Messages since the last run, My commitments and notes | Tasks, Today | on |
| **Budget request reply** (`budget-reply`) | Mail arrives from… (you name the sender), mentioning "budget" | The message and its conversation | Tasks, reply draft, Today, notification | — |
| **Formal meeting summary** (`formal-summary`) | A meeting's transcript is ready | (the meeting's transcript, through its template) | A Formal summary document | — |
| Draft replies to someone (`draft-replies`) | as today | | | |
| End-of-day wrap-up (`end-of-day`) | as today | | | |
| Weekly reflection (`weekly-reflection`) | as today | | | |

Runs are claimed one at a time, so at 08:00 triage runs, then Commitments, then the briefing reads the tasks both made.

**Prompts** (the template's `prompt`, editable like any other):
- **Morning briefing:** "Write my morning briefing. First the budget requests that wait for me. Then the replies I owe: those that look handled first, then 1:1 chats, group chats, mail. Then what is late or due today. Then the meetings today that need preparation and why. End with what can wait and any FYI worth a line. Skip anything that needs nothing from me."
- **Inbox triage:** "Go through the messages waiting for my reply. Make a reply task for each one that needs an answer or a decision from me; skip newsletters, notifications and messages that only inform. If an open reply task already looks answered by someone else in its thread, say so under handled. Summarise what came in, in two lines."
- **Commitments:** "Find the promises in these messages. When I promised something, make a task for me with the date I gave. When someone promised me something, make a waiting task for that person with the date they gave. Ignore vague talk such as \"let's catch up sometime\". If something I was waiting for arrived, say so under handled."
- **Budget request reply:** "This message is a budget request. Make one budget task named after the project and the amount asked. Draft my reply: confirm what I approve, or ask for what is missing, with my choices in square brackets. Don't judge whether the project exists; I check that myself."
- **Formal meeting summary:** no instructions; the optional wishes field reads "e.g. Keep it to one page".

**Morning briefing replaces Morning brief** as a template: same id (`morning-brief`, which the status smoke uses), new name, 08:07, new prompt. Automations the user already saved from the old template are records and are not touched.

**Use template** works as today: the editor opens prefilled; Budget request reply opens with its empty From field marked, as Draft replies does.

### 5. The editor and the page

**Read** gains a box: "Messages since the last run" — "Mail and Teams messages, yours too, since this automation last ran (at most 3 days)."

**Deliver** gains, for a Claude automation:
- "Tasks in <provider>" (`taskProvider.name`: "Tasks in Todoist", "Tasks in Connect"), hint "One task per message that needs it. A rerun, or a task you deleted or finished, never makes it again." Shown when the Read set or trigger gives messages; hidden (and kept in the form) otherwise, like the reply-draft switch.

A **summary automation** (event "A meeting's transcript is ready") shows, instead of Read, Instructions, Claude and Deliver:
- "Make" with a select of note templates ("Formal summary" first, then the others as in Settings › Meetings);
- "Only meetings whose title mentions (optional)", as for "A meeting ends";
- "Wishes (optional)", the prompt field, 4,000 characters;
- the line "Runs with the Claude route for meeting notes (Settings › Claude). Pin it as a summary tab in Settings › Meetings to open meetings on it."

```
┌ New automation ─────────────────────────────────────────────┐
│ Name  [ Inbox triage                                      ] │
│ When  (On a schedule) ( When something happens )            │
│       Mon Tue Wed Thu Fri  ·  08:00  ·  ◉ Catch up          │
│ Read  ☑ Needs your reply   ☐ Messages since the last run    │
│       ☑ My commitments and notes   ☐ Today’s calendar       │
│ Instructions  [ Go through the messages waiting for my … ]  │
│ Deliver                                                     │
│   ◉ A card on Today                                         │
│   ○ A notification                                          │
│   ◉ Tasks in Todoist                                        │
│     One task per message that needs it. A rerun, or a task  │
│     you deleted or finished, never makes it again.          │
└─────────────────────────────────────────────────────────────┘
```

**The list row** shows "Today · Tasks" (or "Formal summary") in its Deliver chip; `deliveriesSentence` reads "Delivers to Today and tasks in Todoist." / "Makes a Formal summary for each meeting."

**The Run log detail** adds, after "Delivered to …":
- "Tasks: 2 made in Todoist, 1 already there" with each made task as a link "<text> ›" to the Tasks page (`#/tasks`, the task's drawer), and "1 left out (no message given)" when entries were dropped;
- "Looks handled: 1 task flagged";
- for a summary run: "Formal summary queued for <meeting title>" with "Open meeting ›".

```
┌ Run log ─────────────────────────────────────────────────────┐
│ ▾ Inbox triage   Schedule · 08:00    Done   4.1 s   ≈ $0.02  │
│   3 messages need you; two are about the SOW.                │
│   Delivered to Today, Tasks                                  │
│   Tasks: 2 made in Todoist, 1 already there                  │
│     Reply to Olga about SOW section 4 ›                      │
│     Reply to Marek about the pilot users ›                   │
│   Looks handled: 1 task flagged                              │
└──────────────────────────────────────────────────────────────┘
```

**Today's Automation results card** adds one line under a result that made tasks: "Made 2 tasks in Todoist ›" (opens Tasks).

**Gallery card** for a template that creates tasks says "Delivers to Today and tasks in <provider>." (the provider's name at the moment).

### 6. Formal meeting summary

- **The template.** A third built-in note template, `formal-summary`, "Formal summary": blurb "A summary you can send to the attendees: in English, the real title and people, what was discussed, decided and who does what by when." Sections `summary`, `attendees`, `discussion`, `decisions`, `actions`. The prompt uses the existing variables (`{{title}}`, `{{date}}`, `{{participants}}`, `{{me}}`, `{{glossary}}`, `{{wishes}}`, `{{transcript}}`): always English; a heading with the title and date; attendees from `{{participants}}`; two or three sentences of summary; discussion by topic; decisions; action items as "owner · action · due date only when someone said one"; neutral, no opinions of people. It can be edited and reset like the other built-ins.
- **The event `meeting_ready`.** The automations round looks at meeting records (not calendar events) and starts a run for a meeting when all hold:
  - its transcript is saved (state `downloaded` or `ready`);
  - it ended within the last two days, after the automation was saved or turned on (`State.armed_at[id]`);
  - it is not short when Settings › Meetings › Skip short meetings is on (under 3 minutes, the existing `SHORT`);
  - it is not waiting for its automatic notes: when automatic notes are wanted for it (`rules::auto_notes`) and it has no document yet, or a `meeting_notes` job for it is queued or running, it waits for the next round;
  - its title matches the keywords, if any;
  - this automation has not run for it (`fired_sources` `<id>:<meetingId>`).
- **The run** (`run.rs`, no Claude): if the meeting already has a document of the template, the run is `skipped` with "<Meeting> already has a Formal summary." Otherwise it queues the existing `meeting_notes` job with key `meeting_notes:auto:<meetingId>:<templateId>`, `templateId`, `wishes` (the automation's prompt), `auto: true` (so "Notes ready: <title>" notifies as automatic notes do) and `findTasks` only when the meeting has no document yet (then the summary is its first document and finds its tasks, which wait To review as today). The run is `ok` with the output title "Formal summary queued for <meeting title>", `meetingId` and `delivered: ["meeting_summary"]`.
- **The notes job** is unchanged. The summary becomes the main document only when the meeting has none, as any first document does. The background class of the claim (`meeting_notes:auto:%`) covers the new key; the one automatic attempt of a meeting's own notes keeps its exact key `meeting_notes:auto:<meetingId>`.
- **Where it shows.** The document is a tab on the meeting (step 3 shows every document after the pins). It is not pinned automatically.

### 7. Informal summary (not built)

The Podervianskyi notes plugin arrives later from the Connect marketplace. Its slot already exists and needs nothing from this step:
- it draws its text in `call.minutes`, which step 3 can pin as a summary tab (`plugin:<id>`);
- it hears `transcribed` and `minutes_written` and runs on its own, so it needs no Connect automation;
- the gallery shows no card for it until then.

### 8. Native operations and shapes

No new operation. `automation_save` accepts the new fields; `automation_runs` and the snapshot's run records carry `tasks`, `handled` and `meetingId`. Contract fixtures that change: `automation.json` (a third saved automation: a summary automation), `automation-run-ok.json` (with `tasks` and `handled`), `automation-snapshot-runs.json`, `note-templates.json` (the third built-in), `task-records.json` only if the Local ledger touches it (it should not). A new fixture `automation-run-summary.json` holds a summary run.

## Copy

- **Templates:** names "Morning briefing", "Inbox triage", "Commitments", "Budget request reply", "Formal meeting summary"; descriptions:
  - "Before work: budget requests, the replies you owe, what is late or due today and the meetings to prepare for.";
  - "Every message that needs your answer becomes a reply task. Messages that only inform are left alone.";
  - "Your promises become your tasks; other people's promises become waiting tasks with their date.";
  - "A budget request becomes a budget task and a reply draft for you to check and send.";
  - "Each meeting with a transcript gets a Formal summary you can share. Built from the transcript with your note templates."
- **Editor:** "Messages since the last run", "Mail and Teams messages, yours too, since this automation last ran (at most 3 days).", "Tasks in <provider>", "One task per message that needs it. A rerun, or a task you deleted or finished, never makes it again.", event "A meeting's transcript is ready", "Make", "Wishes (optional)", "Runs with the Claude route for meeting notes (Settings › Claude). Pin it as a summary tab in Settings › Meetings to open meetings on it."
- **Refusals:** "Tasks are made from messages. Tick Needs your reply or Messages since the last run, or start it from a message.", "A meeting summary starts when a meeting's transcript is ready.", "Choose the template to make.", "Choose a note template."
- **Sentences:** "Delivers to Today and tasks in <provider>.", "Makes a <template> for each meeting."
- **Run log:** "Tasks: <n> made in <provider>, <m> already there", "Tasks: none needed", "Tasks: none made", "<n> left out (no message given)", "Looks handled: <n> task(s) flagged", "<Template> queued for <meeting>", "Open meeting ›", skipped "<Meeting> already has a <template>."
- **Today:** "Made <n> task(s) in <provider> ›".
- **Task history:** "Made by <automation name>"; notes "From <sender> · <subject> · <date>".
- **Note template:** "Formal summary", blurb above.

## Accessibility

- The new Read box and Deliver switch use the existing checkbox and switch components with their hints as `aria-describedby`.
- The summary form's template select has a visible label "Make"; the hidden Claude sections are `hidden`, not merely styled away, so they are not read out.
- Run-log task links are real links named by the task text; the counts line is plain text, not colour.
- Today's "Made 2 tasks in Todoist ›" is a link with that name.
- Text stays at or above the step-1 minimum in Compact; focus rings unchanged.

## Rulings

Each ruling says what it costs if it is wrong.

1. **Create tasks is a fourth Deliver switch, and tasks come in their own `tasks` array, at most 10 a run, each citing a message Connect gave.** *If wrong:* a habit that needs tasks from a meeting or a calendar event can't use it; adding another source later is one parse rule.
2. **The key is the message and the kind (`task_key("message:<id>", kind)`), not Claude's wording.** *If wrong:* two different promises in one message become one task (Claude is told to join them).
3. **Automation-made tasks go straight to To do in the active provider, not To review.** *If wrong:* noise reaches Todoist before the user looked; the cap of 10 and the keys limit it, and Done or Delete remove it for good.
4. **Local keeps a ledger of removed keys too**, so a task the user deleted in Connect is never made again by an automation. *If wrong:* a task deleted by mistake does not come back on the next run (Undo still brings it back).
5. **Due dates:** reply and budget tasks are due the run's day, waiting tasks two working days after the message, the user's own tasks only when a date was said; a date in the message always wins. *If wrong:* unanswered reply tasks show as Late the next day; the user can snooze, or edit the template's prompt.
6. **A waiting task's owner is the cited message's sender**, or the person Claude names when the message is the user's own (name only, no address). *If wrong:* a promise relayed by a third person is filed under the relayer.
7. **Inbox triage and Commitments may flag "looks handled" with evidence; they never close a task.** *If wrong:* the user clicks Done once more than needed.
8. **A new read, "Messages since the last run"**, both directions, since the last `ok` run (first run 24 hours, never more than 3 days, at most 40). *If wrong:* a busy day beyond 40 messages leaves the oldest out of Commitments; the next run's window does not reach back to them.
9. **Schedules:** Inbox triage 08:00, Commitments 08:03, Morning briefing 08:07, weekdays, catch-up on; one time per schedule stays. *If wrong:* a user who wants triage several times a day duplicates the automation.
10. **Morning briefing replaces Morning brief in the gallery under the same id; saved automations are not migrated.** *If wrong:* a user keeps their old Morning brief and makes the new one by hand.
11. **Budget request reply is a "mail arrives from…" automation with "budget" as its keyword and the sender left for the user**, making a budget task and a reply draft, with no project-exists check. *If wrong:* budget requests from a sender the user didn't name get no task until the morning triage makes a reply task for them.
12. **The event cooldown becomes per automation and sender (or chat, or meeting); `meeting_ready` has none.** *If wrong:* a mail storm from many senders starts more runs; the hourly cap of 30 still bounds it.
13. **Formal meeting summary is a built-in note template plus an automation that queues the existing `meeting_notes` job on a new `meeting_ready` event; the automation runs no Claude itself.** *If wrong:* a user who wanted the summary as an automation result card gets a meeting document instead.
14. **The Formal summary waits for a meeting's automatic notes, finds tasks only when it is the meeting's first document, and is not pinned automatically.** *If wrong:* the summary arrives a few minutes later than it could, and the user pins it once by hand.
15. **The Informal summary gets no slot beyond what exists** (`call.minutes`, `plugin:<id>` pins, `transcribed` / `minutes_written` events); no gallery card until its plugin exists. *If wrong:* the plugin step adds a gallery card then.
16. **Connect's own Draft replies, End-of-day wrap-up and Weekly reflection stay, after the five new templates;** the reference app's end of day, repo digest and performance are not ported. *If wrong:* the gallery holds three templates the user doesn't use.
17. **Commitment blocks carry `task-kind` and `handled`**, so the briefing can put budget requests and handled-looking replies first. *If wrong:* a few more characters of each run's budget go to two attributes.
18. **Tasks are made before the run record is committed, outside the run's repository guard; a retried job makes nothing new because of the keys.** *If wrong:* a crash between the two leaves tasks without a run-log line saying who made them (their history line still does).

## Definition of done

1. **Quality gates** (`.ai-run/guides/quality-gates.md`): `make fmt-check`, `make lint`, `npm test`, `cargo test` (with the known skip), the contract fixtures regenerated and committed.
2. **Browser run, new checks:** `ui/test/browser/automations-checks.mjs` (`WORKSPACE_E2E_ONLY=automations`): the gallery with the five templates, the Inbox triage editor with "Tasks in Todoist" and "Tasks in Connect", the summary editor, a run detail with tasks and a summary run, Today's "Made 2 tasks in Todoist ›", in both themes, in Compact and Default, at 1000 / 1440 / 1680 px, no horizontal overflow, screenshots saved.
3. **Browser run, no regressions:** the whole `workspace-e2e.mjs` run passes (plugins, meetings, meetings-view, meetings-settings, layout, analytics, compact, reply, tasks-dates, settings-tasks, tasks-provider and the new set).
4. **Headless smokes only** (real-desktop screenshots are deferred to the announced pass at the end of the rollout): `CODEMIE_STATUS_SMOKE=status` on `CODEMIE_WORKSPACE_TEST_DIR` passes, and `CODEMIE_PLUGIN_SMOKE=<codemie-connect-marketplace>` passes.
5. **A comparison with this design's own mockups** (§5 editor, run log): the browser screenshots beside them, each difference named as kept or as a follow-up.

## Left to the builder

- Exact CSS within the step-1 tokens.
- Where `armed_at` and the per-sender cooldown keys live in `State` (stored, like `last_slot`), as long as an old state reads without them.
- Whether the summary editor is a branch of `automationEditor` or a small `summaryEditor` it calls.
- The Formal summary prompt's exact wording within the rules above.
- Plan order. Suggested: the model; the Local ledger and `handled::flag`; reading and prompts; the create-tasks delivery; Formal summary; the UI; the browser checks; the definition of done.
