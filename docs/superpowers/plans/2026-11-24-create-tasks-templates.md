# Create-tasks delivery and automation templates (step 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers also follow the shared rules in `.superpowers/sdd/common-implementer.md`.

**Goal:** Automations can make tasks in the active task provider (Local, or Todoist while it is on) through `create_by_key`, flag tasks that look handled, and the gallery offers Morning briefing, Inbox triage, Commitments, Budget request reply and Formal meeting summary.

**Architecture:**
- Native model (`automations/rules.rs`): `read.recentMessages`, `deliver.createTasks`, `deliver.meetingSummary`, the event `meeting_ready`, a per-sender event cooldown.
- Reading and prompts (`automations/context.rs`, `prompts.rs`): a `recentMessages` section, `task-kind` / `handled` on commitment blocks, and a `tasks` / `handled` part of Claude's answer asked only when Create tasks is on.
- Delivery (`automations/run.rs`): checked tasks are made through `tasks::create_by_key` with the key `task_key("message:<id>", kind)`; handled evidence goes through `task_provider::handled::flag`. Local gets a removed-key ledger.
- Formal summary: a third built-in note template; a `meeting_ready` automation queues the existing `meeting_notes` job and runs no Claude.
- UI (`view-automations.js`, `automations-controller.js`): templates, the Read box, the Deliver switch named for the provider, the summary form, run detail and Today lines.

**Tech Stack:** Rust (Tauri v2), `cargo test`; vanilla JS ES modules, `node:test`; Playwright (`playwright-core`) against the mocked bridge.

**Spec:** `docs/superpowers/specs/2026-11-24-create-tasks-templates-design.md` (§ numbers and "ruling N" below refer to it). Builds on `docs/superpowers/specs/2026-11-23-task-provider-design.md`. Definition of done: the spec's "Definition of done" (adapted from the rollout overview); real-desktop screenshots are deferred to the end of the rollout.

## Global Constraints

- **Repository, branch, commits:**
  - `/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect`, branch `feat/workspace-next` (checked out). Do not switch branches. Do not push.
  - One commit per task, Conventional Commit subject, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Before each commit, the case-insensitive `git grep -il` check for the reference app's name (the controller gives the word) must print nothing; never name the user's other assistant app or reference its files ("the reference app" if needed).
- **Running things:**
  - Raw `cargo` from `src-tauri/` with `export PATH="$HOME/.cargo/bin:$PATH"`; `make`, `npm`, `node` from the repo root; macOS/zsh syntax (BSD `sed`, `find`).
  - Skip the known failure: `cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`.
  - Browser run: `PLAYWRIGHT_CORE=/Users/Nikita_Levyankov/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs`, outside the sandbox (`dangerouslyDisableSandbox: true`). One set: prefix `WORKSPACE_E2E_ONLY=<set>`. A normal UI task runs `automations` (once it exists), `compact` and `layout`; the whole run (about 40 minutes, `run_in_background`) is for Task 8.
  - Never drive the desktop. No GUI launch of the app except the headless smokes in Task 8.
- **Safety, every task:**
  - **No network in any test.** Claude is `FakeRunner`; the task provider is `task_provider::fake::FakeProvider`; Microsoft is the test core's seeded records.
  - **Nothing is sent to a person without the user's click.** No automation, delivery or test calls a send op; the budget reply is an `ai_draft` record only. A test in Task 4 asserts no outgoing action record and no `action_*` job after a run.
  - **Drafts stay drafts:** a draft fills the reply box; only the step-2 Send sends.
  - **Never write a real token.** No test, fixture or log holds a provider token; where one is needed use the sentinel `tk_SENTINEL_do_not_log_0123456789`.
  - Automations never close a task: `handled` only flags (ruling 7).
- **Code rules:**
  - Views and models stay pure; only controllers and `app.js` touch the DOM; writes go through `mutate`; every provider and Claude string goes through `escapeHtml`.
  - Lock order: `meeting_lock` then the repository; never call `create_by_key` while holding a repository guard; drop guards before `.await`.
  - No new Tauri command and no new workspace operation; new fields ride `automation_save` and the run records.
  - Default and Compact draw the same markup.
- **Values:**
  - task key for an automation task: `keys::task_key(&format!("message:{message_record_id}"), kind)`;
  - kinds `task | reply | waiting | budget`; at most 10 tasks and 10 handled entries a run; task text ≤ 300 characters, owner ≤ 100, evidence ≤ 200;
  - due defaults: `reply` and `budget` the run's local day; `waiting` two working days (Mon–Fri) after the message's local day; `task` none;
  - `recentMessages`: since the automation's last `ok` run's `startedAt`, first run `now − 86 400`, floor `now − 3 × 86 400`, at most 40, 500 characters each;
  - templates: `inbox-triage` weekdays 08:00, `commitments` weekdays 08:03, `morning-brief` (name "Morning briefing") weekdays 08:07, all `catchUp: true`; `budget-reply` `mail_from`, senders `[]`, keywords `["budget"]`; `formal-summary` event `meeting_ready`, `deliver.meetingSummary: "formal-summary"`;
  - Formal summary job key `meeting_notes:auto:<meetingId>:<templateId>`; meeting window 2 days (`AUTO_WINDOW`), short = 180 s (`SHORT`);
  - event cooldown 600 s per `(automation id, sender key)`: mail `fromAddress` lower-case, Teams chat id, meeting id for `meeting_ended`; none for `meeting_ready`; hourly cap 30 unchanged.
- **Copy, verbatim from the spec § Copy** (each task quotes what it draws). Refusals: "Tasks are made from messages. Tick Needs your reply or Messages since the last run, or start it from a message.", "A meeting summary starts when a meeting's transcript is ready.", "Choose the template to make.", "Choose a note template."
- **Contract fixtures:** after a native shape change run `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures` and commit the JSON with the change.

## Review Focus

1. **The same morning runs twice** (a catch-up after Run now, or a retried job after a crash between making tasks and committing the run). Each message still has exactly one reply task, and the provider got one create per key. (Task 4 `a_rerun_and_a_retry_make_no_second_task`.)
2. **The user deleted yesterday's reply task in Connect (Local), or completed it in Todoist.** Today's triage reading the same message makes nothing. (Task 2 `local_delete_tombstones_the_key`, Task 4 `removed_or_done_keys_are_never_made_again` for Local and for the fake provider.)
3. **Claude cites a block that is not a message, an id it was never given, or the same message twice with different wording.** No task is made from the first two; the third makes one task. (Task 3 `parse_keeps_only_cited_messages_one_per_kind`.)
4. **Three budget mails from two senders arrive in one sync round.** Each sender gets a run (the second mail from the same sender within 10 minutes is skipped and recorded); a later meeting's `meeting_ready` is never held back by a cooldown. (Task 1 `cooldown_is_per_sender_and_meeting_ready_has_none`.)
5. **A meeting with automatic notes on gets its transcript saved while a Formal summary automation is on.** The automatic notes are queued and become the main document; the Formal summary is queued after them, as a second document, without finding tasks. (Task 5 `formal_summary_waits_for_automatic_notes`.)

---

### Task 1: The automation model: new read, deliveries, `meeting_ready`, validation and the per-sender cooldown

**Files:**
- Modify: `src-tauri/src/workspace/automations/rules.rs` (`ReadSet`, `Deliver`, `EventKind`, `validate`, `State`, `refusal`/`started`, `match_events`, `MessageIn`)
- Modify: `src-tauri/src/workspace/automations/engine.rs` (`automation_op` save/toggle set `armed_at`; `contract_fixtures` gains a summary automation)
- Fixtures: regenerate `automation.json`
- Test: `rules.rs` and `engine.rs` test modules

**Interfaces:**
- Produces (Rust, serde camelCase, `#[serde(default)]` so stored automations still read):
  - `ReadSet.recent_messages: bool`;
  - `Deliver.create_tasks: bool`, `Deliver.meeting_summary: Option<String>`;
  - `EventKind::MeetingReady` (`"meeting_ready"`);
  - `Automation::makes_tasks_from_messages(&self) -> bool` = `read.needs_reply || read.recent_messages || (event ∈ {MailFrom, ChatFrom, Critical} && read.trigger_conversation)`;
  - `Automation::is_summary(&self) -> bool` = `deliver.meeting_summary.is_some()`;
  - `State.armed_at: BTreeMap<String, i64>`; `State.fired` keyed `"<id>|<sender key>"`; `pub fn sender_key(m: &MessageIn) -> String` (`chat:<chatId>` or the lower-case address); `MessageIn.chat_id: String` read from the record's `chatId`.
  - `validate(a, templates: &[Template])` (new parameter: the note templates, for `meetingSummary`).
- A summary automation may have an empty prompt; `PROMPT_MAX` still applies.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn stored_automations_without_new_fields_still_read()
// serde_json::from_value(<automation.json "schedule" as of main>) → recent_messages false, create_tasks false, meeting_summary None
#[test] fn create_tasks_needs_a_message_read()
// schedule + calendarToday only + createTasks → Err field "deliver", message == "Tasks are made from messages. Tick Needs your reply or Messages since the last run, or start it from a message."
// needsReply → Ok; recentMessages → Ok; mail_from + triggerConversation → Ok; meeting_ended + triggerConversation → Err
#[test] fn a_summary_automation_is_meeting_ready_with_an_existing_template()
// meeting_ready without meetingSummary → Err "Choose the template to make."; meetingSummary on a schedule → Err "A meeting summary starts when a meeting's transcript is ready.";
// meetingSummary "nope" → Err "Choose a note template."; "formal-summary" with empty prompt → Ok; with createTasks or draftReply or any read → Err field "deliver"
#[test] fn cooldown_is_per_sender_and_meeting_ready_has_none()
// one round, mail_from automation: ann@x (m1), bob@y (m2), ann@x (m3) → started [m1, m2]; state.skipped has m3 with "This automation already ran in the last 10 minutes."
// meeting_ready matches never consult the cooldown (tested through the engine in Task 5)
#[tokio::test] async fn saving_or_turning_on_arms_the_automation()
// automation_save then automation_toggle(enabled) set State.armed_at[id] to now; turning off leaves it
```

- [ ] **Step 2: Run them and see them fail.** `cd src-tauri && cargo test automations::`. Expected: FAIL (missing fields and functions).

- [ ] **Step 3: Implement** the Interfaces. `validate` reads the templates through `meetings::templates::all` at the call site in `engine.rs`. `refusal(id, sender: Option<&str>, now)` checks `fired["<id>|<sender>"]` for events; `None` (schedules, manual, `meeting_ready`) skips the cooldown.

- [ ] **Step 4: Fixtures and the suite.** Add `("automation-summary.json", summary_json())` to `engine.rs::contract_fixtures` so `automation.json` gains `"summary"`; `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, then the whole Rust suite with the skip, then `npm test`. Expected: all pass; `automation.json` differs by the new default fields and the `summary` entry.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui/test/fixtures/contract
git commit -m "feat(automations): create-tasks and meeting-summary deliveries, messages since the last run, a per-sender cooldown"
```

### Task 2: Local remembers removed keys, and one `handled::flag` for every evidence

**Files:**
- Modify: `src-tauri/src/workspace/tasks.rs` (`task_delete` :616, `create_by_key` :852 — drop its `allow(dead_code)`)
- Modify: `src-tauri/src/workspace/task_provider/handled.rs` (new `flag`), `src-tauri/src/workspace/task_provider/ops.rs` (`handled` :531 calls `flag`)
- Test: `tasks.rs`, `handled.rs`, `ops.rs` test modules

**Interfaces:**
- Produces:
  - `create_by_key` consults `keys::ledger_get(r, "local", key)` when the active provider is Local, with the same `created | done | removed` rule.
  - `task_delete` of a Local task with a `key` puts `keys::ledger_record("local", key, None, "removed", now)` in the same `commit_local` as the delete.
  - `pub(crate) fn handled::flag(r: &mut Repository, wid: &str, task: &Record, evidence: &str, now: i64) -> Result<bool>`: `true` when it flagged; `false` for a task not open, already flagged with that evidence, or kept open against it. Never completes.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn local_delete_tombstones_the_key()
// Local: create_by_key(k) → (id, true); task_delete(id); create_by_key(k) → (_, false), no record with key k
// Undo: task_save(the deleted body) brings it back; create_by_key(k) → (id, false)
#[test] fn local_done_keys_are_not_made_again()   // status done → create_by_key(k) → (id, false)
#[test] fn flag_never_closes_and_respects_keep_open()
// open reply task: flag(e) → true, handled.evidence == e, status unchanged; flag(e) again → false;
// keep (task_handled action keep) then flag(e) → false; done task → false
#[tokio::test] async fn task_handled_evidence_still_answers_as_before()   // existing op behaviour through flag
```

- [ ] **Step 2: Run them and see them fail.** `cargo test tasks:: task_provider::handled task_provider::ops`. Expected: the two Local tests and `flag_*` FAIL.

- [ ] **Step 3: Implement** as in Interfaces; `ops::handled`'s evidence branch becomes a call to `flag`.

- [ ] **Step 4: Run the suite** with the skip, and `npm test`. Expected: all pass; no fixture changes (`git status` shows none under `ui/test/fixtures`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(tasks): Local remembers removed keys; one flag for looks-handled evidence"
```

### Task 3: What a run reads and what Claude may answer

**Files:**
- Modify: `src-tauri/src/workspace/automations/context.rs` (`SECTIONS` :111 gains `recentMessages` after `needsReply`; `build`; a `recent_messages` reader; `commitments` :580 attributes; `Source` keeps the task's kind and openness for `handled`)
- Modify: `src-tauri/src/workspace/prompts.rs` (`AUTOMATION_SYSTEM` documents `recentMessages`, `task-kind`, `handled`, `createTasks`; new `AUTOMATION_TASK_RULES`; `automation_schema(create_tasks: bool) -> Value`; `parse_automation` reads `tasks` and `handled`)
- Test: `context.rs`, `prompts.rs` test modules

**Interfaces:**
- Consumes: Task 1's `ReadSet.recent_messages`, `Deliver.create_tasks`.
- Produces:
  - `context::Run.since: Option<i64>`, the start of `recentMessages` (Task 4 computes it);
  - `Source.kind` stays `"message" | "event" | "commitment" | "note"`; `Source.task_kind: Option<String>` and `Source.open: bool` for commitments;
  - `pub struct AutomationTask { pub text: String, pub kind: String, pub source_id: String /* message record id */, pub due: Option<String>, pub owner: Option<String> }`;
  - `pub struct HandledEntry { pub task_id: String, pub evidence: String }`;
  - `AutomationOutput` gains `tasks: Vec<AutomationTask>`, `handled: Vec<HandledEntry>`, `dropped: usize` (task entries left out);
  - `parse_automation(structured, sources: &[context::Source], allow_draft, allow_tasks)` (sources by handle, so kind is known).
- Input JSON gains `"createTasks": true` only when on; the schema gains `tasks` and `handled` only then (`required` unchanged).

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn recent_messages_read_both_directions_since_the_last_run()
// records at since-10, since+10 (by me), since+20 (from Ann): section holds the two after since, newest first, by="user" on mine;
// 45 messages → 40 shown and truncated {shown: 40, total: 45}; each text cut to 500
#[test] fn commitment_blocks_carry_task_kind_and_handled()
// a reply task flagged handled → `<item id="s1" kind="commitment" task-kind="reply" handled="true">`; a plain task has neither
#[test] fn the_task_part_is_asked_only_with_create_tasks()
// automation_schema(false)["properties"] has no "tasks"; (true) has "tasks" and "handled"; AUTOMATION_SYSTEM unchanged otherwise
// AUTOMATION_TASK_RULES contains "one task per message and kind", "reply", "waiting", "budget", "only informs"
#[test] fn parse_keeps_only_cited_messages_one_per_kind()
// s1 message, s2 event, s3 commitment(reply, open), s4 commitment(task, open), s5 commitment(waiting, done)
// tasks: [{s1 reply "Reply to Olga"}, {s1 reply "Answer Olga"}, {s1 waiting "Olga sends SOW"}, {s2 task}, {s9 task}, {s1 kind "bogus"}]
//  → [s1 reply "Reply to Olga", s1 waiting, s1 task ("bogus" → "task")], dropped == 3
// handled: [{s3 e}, {s4 e}, {s5 e}, {s1 e}] → only s3; evidence one line ≤ 200
// due "2026-11-24" kept; "Friday" and "1999-01-01" dropped; owner 300 chars → 100; 15 tasks → 10; allow_tasks false → tasks empty
```

- [ ] **Step 2: Run them and see them fail.** `cargo test automations::context prompts::`. Expected: FAIL.

- [ ] **Step 3: Implement.** `recent_messages(repo, w, c, since, now, tz)` follows `needs_reply`'s filters (`record_selected`, `source_permitted`, `source_available`) without the "waiting for my reply" condition and with the user's own messages marked. `reads_microsoft` in `run.rs` gains `a.read.recent_messages`. Rules text from spec §2 "Asking".

- [ ] **Step 4: Run the suite** with the skip. Expected: all pass, including the existing `AUTOMATION_SYSTEM` assertions.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(automations): read messages since the last run; ask Claude for tasks and handled evidence only when tasks are made"
```

### Task 4: The create-tasks delivery

**Files:**
- Modify: `src-tauri/src/workspace/automations/run.rs` (`attempt` :190: `since`, schema, the delivery after Claude, the run record; `RunLog` unchanged)
- Modify: `src-tauri/src/workspace/automations/engine.rs` (`contract_fixtures`: none) and the run fixture test that writes `automation-run-ok.json`
- Fixtures: regenerate `automation-run-ok.json`, `automation-snapshot-runs.json`
- Test: `run.rs` test module (it already has `FakeRunner` scripts and a signed-in core)

**Interfaces:**
- Consumes: Task 1 (`create_tasks`), Task 2 (`create_by_key` with Local ledger, `handled::flag`), Task 3 (`AutomationTask`, `HandledEntry`, `parse_automation`, `Run.since`).
- Produces:
  - `fn task_body(t: &AutomationTask, message: &Record, me: &MeAlias, automation_name: &str, run_day: NaiveDate, zone: &str) -> Value` (pure; spec §2 "Making": owner, due defaults, notes "From <sender> · <subject> · <date>", history "Made by <name>", `status: "todo"`, `sourceId`, `sourceRevision`);
  - `fn working_days_after(day: NaiveDate, n: u32) -> NaiveDate`;
  - run record fields `tasks: {made: [{id, text, kind}], existing, dropped}`, `handled: <n>`; `delivered` gains `"tasks"` when `create_tasks` and status `ok`.
- `since` = the latest `ok` run of this automation's `startedAt` (from `automation_run` records), else `now − 86 400`, never before `now − 3 × 86 400`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn task_body_follows_the_kind()
// reply from Olga on Tue 2026-11-24 run → owner "You", due "2026-11-24"; budget same; task → no due;
// waiting from Marek's mail Fri 2026-11-20 → owner marek@…/"Marek Novak", due "2026-11-24"; waiting on my own mail with owner "Ann" → ownerName "Ann", no address
// Claude's due wins; notes == "From Olga Petrova · SOW section 4 · 24 Nov 2026"; history[0] text "Made by Inbox triage"
#[tokio::test] async fn a_triage_run_makes_reply_tasks_in_the_active_provider()
// Local: FakeRunner answers 2 tasks (s1, s2) → 2 commitment records kind reply, status todo, keys task_key("message:<id>","reply");
// run record tasks.made len 2, delivered contains "tasks", "today"
// FakeProvider active ("plugin:todoist"): same run → 2 tasks provider "plugin:todoist", pending true, a task_sync job queued; no network
#[tokio::test] async fn a_rerun_and_a_retry_make_no_second_task()
// run twice with the same answer → still 2 tasks, run 2 tasks.existing == 2, made == 0;
// fail the run commit once after tasks were made (test hook), let the job retry → 2 tasks
#[tokio::test] async fn removed_or_done_keys_are_never_made_again()
// Local: delete one, complete the other, rerun → no new task; provider: ledger "removed"/"done" → none, FakeProvider got no create
#[tokio::test] async fn a_message_gone_while_claude_worked_gets_no_task()   // source_available false at commit → dropped += 1
#[tokio::test] async fn handled_evidence_flags_and_never_closes()   // open reply task flagged, status todo; run handled == 1
#[tokio::test] async fn a_budget_run_makes_a_budget_task_and_a_draft_and_sends_nothing()
// mail_from run with createTasks + draftReply: one budget task, one ai_draft record on the conversation;
// no record of kind "action", no job of kind action_* or send_*; the draft text is only in the ai_draft record
```

- [ ] **Step 2: Run them and see them fail.** `cargo test automations::run`. Expected: FAIL.

- [ ] **Step 3: Implement.** After `answer?`, while holding no guard: re-read each cited message, build bodies, call `tasks::create_by_key(self, PERSONAL, &body, &key)` for each, then flag handled entries under `meeting_lock` + repository, then take the repository for the existing policy and account checks and `commit_automation_run`. A `validation` error from one task drops that task (counted in `dropped`) and never fails the run.

- [ ] **Step 4: Fixtures and the suite.** `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, the Rust suite with the skip, `npm test`. Expected: all pass; `automation-run-ok.json` gains `tasks` and `handled`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui/test/fixtures/contract
git commit -m "feat(automations): the create-tasks delivery makes each message's task once in the active provider"
```

### Task 5: Formal meeting summary

**Files:**
- Modify: `src-tauri/src/workspace/meetings/templates.rs` (`BUILT_INS` :95 gains `formal-summary`; `FORMAL_PROMPT`)
- Modify: `src-tauri/src/workspace/automations/engine.rs` (`automations_round_at` :101 finds ready meetings), `rules.rs` (`pub fn ready_meetings(...)`), `run.rs` (`run_summary` path in `run_automation`)
- Modify: `src-tauri/src/workspace/meetings/notes_job.rs` only if the `noted` set or the claim reads keys by prefix in a way the new key breaks
- Fixtures: regenerate `note-templates.json`; create `automation-run-summary.json`
- Test: `templates.rs`, `engine.rs`, `run.rs` test modules

**Interfaces:**
- Consumes: Task 1 (`EventKind::MeetingReady`, `is_summary`, `armed_at`).
- Produces:
  - built-in `{id: "formal-summary", name: "Formal summary", sections: ["summary","attendees","discussion","decisions","actions"], color: "#8A5CC2", icon: "list"}` with the spec §6 blurb;
  - `pub fn ready_meetings(meetings: &[MeetingRecord], wants_auto: impl Fn(&MeetingRecord) -> bool, busy: &HashSet<String>, armed_at: i64, now: i64, skip_short: bool) -> Vec<MeetingIn>` (pure: state `Downloaded | Ready`, ended within `AUTO_WINDOW` and after `armed_at`, not short, not (`wants_auto` && no docs), not in `busy` = meetings with a queued or running `meeting_notes` job);
  - the run queues `meeting_notes` with key `meeting_notes:auto:<meetingId>:<templateId>`, payload as `notes_job::queue` builds it plus `findTasks = template.extract_tasks && meeting.docs.is_empty()`, `wishes = automation.prompt`, `auto: true`; run record `ok`, output title "Formal summary queued for <title>", `meetingId`, `delivered: ["meeting_summary"]`; skipped "<title> already has a Formal summary." when a doc of that template exists.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn formal_summary_is_a_built_in()   // all(&[]) has 3 built-ins, third "formal-summary"; prompt contains "{{participants}}", "English", "{{transcript}}"
#[test] fn ready_meetings_follow_the_rules()
// downloaded, ended 1h ago after armed_at → in; ended 3 days ago → out; ended before armed_at → out; 2-minute meeting with skip_short → out;
// wants_auto && no docs → out; same with a main doc (ready) → in; in busy → out
#[tokio::test] async fn formal_summary_waits_for_automatic_notes()
// rule auto notes on: transcript saved → round queues meeting_notes:auto:<m> only; after its run (ready, main doc) → next round queues
// one automation_run; running it queues meeting_notes:auto:<m>:formal-summary with findTasks false; FakeRunner ran once for notes, never for the automation
#[tokio::test] async fn a_meeting_without_notes_gets_its_summary_as_first_document()   // findTasks true; the doc becomes main through the unchanged job
#[tokio::test] async fn a_meeting_runs_once_and_never_waits_for_a_cooldown()
// two meetings ready in one round → two runs; a third round → none (fired_sources); an existing formal doc → run skipped with the sentence
#[tokio::test] async fn contract_fixture_summary_run()   // writes automation-run-summary.json
```

- [ ] **Step 2: Run them and see them fail.** `cargo test meetings::templates automations::`. Expected: FAIL.

- [ ] **Step 3: Implement.** The round reads `meeting` records of `personal` and the queued/running jobs once; matching respects `enabled`, keywords on the title, `fired_sources` and `refusal` without a sender. Check (and pin with a test) that the meeting's own automatic key `meeting_notes:auto:<meetingId>` is still queued when a `…:<templateId>` job exists.

- [ ] **Step 4: Fixtures and the suite.** `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, the Rust suite with the skip, `npm test` (the meetings UI tests read `note-templates.json`; update any count they assert). Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui/test
git commit -m "feat(meetings): a Formal summary template, made for each ready meeting by a summary automation"
```

### Task 6: The Automations page: templates, editor, run detail and Today

**Files:**
- Modify: `ui/workspace/view-automations.js` (`TEMPLATES` :46, `DELIVER_LABELS` :123, `deliveriesSentence`, `READS` :695, `automationEditor` :708, `draftFromAutomation` :521, `editorDraft` :548, `toAutomation` :573, `ERROR_FIELDS` :599, `runDetail` :295, `templatesPanel` :446, `resultItem` :502, `EVENTS` :33, `triggerSummary`, `runTrigger`)
- Modify: `ui/workspace/automations-controller.js` (the editor redraw for `meeting_ready`; the template select needs `noteTemplates` from the snapshot and the provider name from `taskProvider`)
- Modify: `ui/workspace/status-smoke.js` only if it reads the template's name (the id stays `morning-brief`)
- Modify: `ui/test/fixtures/workspace-fixture.mjs` (`withAutomations`: an Inbox triage automation and a run with `tasks`, a summary automation and its run from `automation-run-summary.json`)
- Modify: `ui/test/browser/workspace-e2e.mjs` (mock `automation_save` keeps the new fields; the existing Morning brief check uses the new name and time)
- Test: `ui/test/automations.test.mjs`, `ui/test/automations-controller.test.mjs`, `ui/test/status-smoke.test.mjs`

**Interfaces:**
- Consumes: Task 1's fields (`read.recentMessages`, `deliver.createTasks`, `deliver.meetingSummary`, event `meeting_ready`), Task 4's run fields, Task 5's `automation-run-summary.json`.
- Produces (pure):
  - `TEMPLATES` ids in order: `morning-brief`, `inbox-triage`, `commitments`, `budget-reply`, `formal-summary`, `draft-replies`, `end-of-day`, `weekly-reflection`, with spec §4's names, descriptions, schedules, reads, deliveries and prompts;
  - `deliveriesSentence(deliver, providerName = 'Connect')` → "Delivers to Today and tasks in Todoist." / "Makes a Formal summary for each meeting." (template name from `noteTemplates`);
  - `automationEditor(draft, {zone, ai, error, providerName, templates})`;
  - `tasksLine(run, providerName) → "Tasks: 2 made in Todoist, 1 already there"` / "Tasks: none needed";
  - Today's result item: "Made 2 tasks in Todoist ›" (`href="#/tasks"`).

- [ ] **Step 1: Write the failing tests**

```js
test('the gallery lists the five habits first, Morning briefing at 08:07')
// TEMPLATES.map(t => t.id) deep-equals the order above; morning-brief name 'Morning briefing', time '08:07'; inbox-triage 08:00, commitments 08:03
test('Tasks in <provider> shows only with a message read')
// draft with needsReply → html has 'Tasks in Todoist' (providerName 'Todoist') and the hint text; calendarToday only → the switch is inside [hidden]
test('a summary automation shows Make, keywords and Wishes, not Read or Claude')
// event meeting_ready → select#auto-summary with 'Formal summary' first; no visible #auto-read; toAutomation → deliver.meetingSummary 'formal-summary', read all false
test('the editor round-trips the new fields')   // draftFromAutomation(toAutomation(d)) keeps recentMessages, createTasks, meetingSummary
test('the run detail says what tasks were made and links them')
// automation-run-ok.json → 'Tasks: 2 made in Todoist, 1 already there', two links to #/tasks, 'Looks handled: 1 task flagged'; every text escaped
test('Today says Made 2 tasks in Todoist')
test('the refusals point at the Deliver section')   // fieldForError of each new sentence → 'auto-deliver'
```

Update `status-smoke.test.mjs` (`'the Morning briefing is made from the template, off so no schedule runs it'`) and the copies in `automations-controller.test.mjs`.

- [ ] **Step 2: Run them and see them fail.** `node --test ui/test/automations.test.mjs ui/test/automations-controller.test.mjs ui/test/status-smoke.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** per spec §4–§5. The provider name comes from `snapshot.taskProvider.name` (absent → "Connect"); templates from `snapshot.noteTemplates`.

- [ ] **Step 4: Run** `npm test`, then the `compact` and `layout` browser sets. Expected: all pass. The existing automations checks in `workspace-e2e.mjs`'s main body (renamed Morning briefing) run in Task 8's whole run.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(automations): the habit templates, a Tasks delivery named for the provider, the summary editor and what a run made"
```

### Task 7: Browser check set `automations-checks.mjs`, and the guides

**Files:**
- Create: `ui/test/browser/automations-checks.mjs`
- Modify: `ui/test/browser/workspace-e2e.mjs` (import; `WORKSPACE_E2E_ONLY` list :1529 gains `automations`; the full run calls `automationsChecks` after `tasksProviderChecks`; header comment :1528)
- Modify: `.ai-run/guides/architecture/architecture.md` (Milestone 2 boundaries row for `automations/`: the create-tasks delivery through `create_by_key`, the `meeting_ready` summary automation; Task providers "Keys" bullet: Local ledger), `.ai-run/guides/testing/testing-patterns.md` (browser sets list and `WORKSPACE_E2E_ONLY` values gain `automations`; fixtures gain `automation-run-summary.json`)

**Interfaces:**
- Consumes: `open({ theme, width, height, hash, settings, workspace, localPrefs })`, `check`, `assert`, `shot`, `settled`, `calls`, `OUT`; `noClip`, `CLIP_SELECTORS`, `FIXED_NOW` from `compact-checks.mjs`; the `noOverflow` pattern from `reply-checks.mjs`; `task-provider-states.json` `STATES.ready` for "Todoist".
- Produces: `export async function automationsChecks({ open, check, assert, shot, settled, calls, OUT })`.

- [ ] **Step 1: Write the checks.**
  - **A1 `automations A1: <theme> <view> <width>`**, both themes × {compact, default} × {1000, 1440, 1680}: the Templates tab lists the five new cards first; no horizontal overflow; `noClip` empty; screenshots `automations-gallery-<theme>-<view>-<width>`.
  - **A2 editor with a provider:** Use template on Inbox triage with Todoist ready → "Tasks in Todoist" on, hint text present; Save → one `automation_save` with `deliver.createTasks: true`, `read.needsReply: true`, `trigger.time: '08:00'`; with Local → "Tasks in Connect"; untick Needs your reply → the switch hides; screenshots `automations-editor-<theme>-<view>-<width>`.
  - **A3 refusal:** the mock answers the "Tasks are made from messages…" refusal with `field: 'deliver'`; the sentence shows at Deliver with `role="alert"` and `aria-invalid`.
  - **A4 summary editor:** Use template on Formal meeting summary → the Make select reads "Formal summary", no visible Read, Instructions or Claude section, Wishes empty; Save → `deliver.meetingSummary: 'formal-summary'`, `trigger.event: 'meeting_ready'`; screenshot `automations-summary-<theme>`.
  - **A5 budget:** Use template on Budget request reply → the From field is marked and focused, keywords "budget", deliveries Tasks and Reply draft on.
  - **A6 run detail:** the Inbox triage run expands to "Tasks: 2 made in Todoist, 1 already there", two task links (a click opens `#/tasks`), "Looks handled: 1 task flagged"; the summary run shows "Formal summary queued for …" and "Open meeting ›"; screenshot `automations-run-<theme>-<view>`.
  - **A7 Today:** the Automation results card shows "Made 2 tasks in Todoist ›" under Inbox triage's result.
  - **A8 parity:** the normalized `outerHTML` of the editor (ids stripped) is identical in Default and Compact.
  - **A9 nothing written or sent without a click:** open Automations (all tabs), Today and a run detail, render five times; `automation_save`, `automation_run_now`, `task_save`, `action_prepare` and `action_confirm` counts stay 0.

- [ ] **Step 2: Run** `WORKSPACE_E2E_ONLY=automations …` outside the sandbox. Expected: A1–A9 PASS. Fix product code only in a `fix:` commit naming the check. Look at the 1000 px screenshots in both views.

- [ ] **Step 3: Commit**

```bash
git add ui/test/browser .ai-run/guides
git commit -m "test(automations): browser checks for the habit templates and the Tasks delivery in both views, both themes and three widths"
```

### Task 8: Definition of done

**Files:** none change unless a check fails; a fix goes in a `fix:` commit naming the check.

- [ ] **Step 1: Gates.** `make fmt-check lint test-js`, then `cd src-tauri && cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`. Expected: fmt and clippy clean; `npm test` no failures; every target `test result: ok`; `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures` leaves `git status` clean.

- [ ] **Step 2: Whole browser run** in the background, outside the sandbox (about 40 minutes). Expected: `N/N browser checks passed`, covering automations A1–A9 and every earlier set (plugins, meetings, meetings-view, meetings-settings, layout, analytics, compact, reply, tasks-dates, settings-tasks, tasks-provider). For a known flaky check (layout E1, the Today hover label), re-run that set alone once and report both results.

- [ ] **Step 3: Headless smokes only** (no desktop driving; real-desktop screenshots wait for the announced pass at the end of the rollout). Ask the user to quit their Connect first if the status smoke refuses to run beside it; do not quit it for them.
  1. `cd src-tauri && cargo build`.
  2. `T=$(mktemp -d)/workspace`; copy `workspace.sqlite` (with `-wal` and `-shm`) from `~/Library/Application Support/com.epam.codemie.installer/workspace/` into it, never `credentials/`; `CODEMIE_WORKSPACE_TEST_DIR=$T CODEMIE_STATUS_SMOKE=status ./target/debug/app`. Expected: exit 0; the report lists the automations; no Claude ran (no `live` mode).
  3. `CODEMIE_WORKSPACE_TEST_DIR=$(mktemp -d)/workspace CODEMIE_PLUGIN_SMOKE=/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect-marketplace ./target/debug/app`. Expected: exit 0; `todoist` loaded with `tasks: [{plugin:'todoist', status:'needs_token'}]`.
  4. `grep -r tk_SENTINEL ui/test/fixtures output/playwright "$TMPDIR"/connect-*-smoke.json` finds nothing.

- [ ] **Step 4: Compare with the design's own mockups** (spec §5 editor and run log): put `automations-editor-light-default-1440` and `automations-run-light-default` beside them and list each visible difference as kept (with its ruling) or a follow-up.

- [ ] **Step 5: Show the user:** the gate results, the browser-run summary, the A1/A2/A6 screenshots in both views, the two smoke reports, the mockup comparison, and the rulings list from the spec. Do not push.
