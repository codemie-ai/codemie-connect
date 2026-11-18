# Meetings, Transcripts, Notes and Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status: waiting for approval. Do not start Task 1 until the person approves this plan.**

**Goal:** Turn Teams transcripts into Echo-compatible meeting folders, AI notes from templates or skills, and a Tasks board, with a calendar badge, a one-page Meetings view and Settings › Meetings.

**Architecture:** Everything durable lives in the native workspace domain (`src-tauri/src/workspace/`): new local record kinds (`meeting`, `note_template`, `meeting_rule`), the existing `commitment` kind grown into tasks, three job kinds (`transcript_check`, `transcript_download`, `meeting_notes`) run by the existing 1-second background loop, Graph reads behind the existing `GraphReads` trait, and AI runs through the existing `run_claude_reported` with a JSON schema. Files go to a visible meetings root. The renderer stays a pure view of the snapshot plus read-only queries for file text, following the Automations split (`view-*.js` pure HTML, `*-controller.js` actions).

**Tech Stack:** Rust 2021 / Tauri 2.12.6 / SQLite (rusqlite) / tokio; vanilla JS ES modules (no bundler); `node:test`; Playwright-core browser e2e with a mocked bridge.

**Spec:** `docs/superpowers/specs/2026-11-17-meetings-transcripts-tasks-design.md` (approved prototype: `prototypes/meetings/`, local).

## Before You Start

- **Base:** `main` at or after `0671e93` (plugins in Today and Settings). On 2026-11-17 the plugin UI work was still uncommitted in `ui/workspace/{app.js,icons.js,shell.js,view-settings.js,view-today.js}` plus new `settings-plugins.js`/`today-plugins.js`; start after it is committed.
- **Parallel branch:** `feat/codemie-native-settings` (not merged) rewrites the *CodeMie tools* group of `SETTINGS_TABS` and adds actions to `app.js` `handle`. The *Meetings* group here is inserted after the *Workspace* group and touches neither; on conflict keep both.
- **References:** Rust references carry line numbers (stable, verified on `0671e93`). UI files under active change are referenced **by symbol** (`ROUTES`, `render()`, `route()`, `handle()`, `submitForm()`, `commitmentDialog`, `eventDialog`, `openNotification`, `boot()`, `SETTINGS_TABS`, `TAB_DESCRIPTIONS`, `WIDGETS`, `commitmentsCard`); look them up, don't trust line numbers there.

## Global Constraints

- Branch `feat/meetings-transcripts-tasks` from `main`; Conventional Commits, type only (`feat: …`, `test: …`); one commit per task minimum; squash merge.
- Every new workspace operation: variant in `Operation` (`src-tauri/src/workspace/models.rs:83-125`), arm in `Core::request` (`mod.rs:764`) or the read-only early returns (`mod.rs:677-737`), mock in `ui/test/browser/workspace-e2e.mjs` `ops` map; read-only ops also go in the e2e no-revision-bump list.
- **Job keys:** `jobs.execution_key` is UNIQUE and `enqueue` is `INSERT OR IGNORE` (`repository.rs:64`, `:1003`), so a reused key is silently dropped. Jobs a person starts use `<kind>:<operationId>` and dedupe on a payload field among `queued|running` jobs, exactly like `queue_ai_job` (`ai_jobs.rs:205-228`). Only jobs the background round creates use fixed keys (`transcript_check:<meetingId>:<slot>`, `transcript_download:auto:<meetingId>:<slot>`, `meeting_notes:auto:<meetingId>`); slot = `now / (checkEveryMin*60)`, so a failed check or save can run again in the next slot.
- **Ownership:** `meeting` records are account-bound like their event (`connection_id = c.id`, `workspace_id = ''`, `source = "calendar:<calendarId>"`, same id as the event), so the snapshot gates them with the `calendar` capability and disconnect purges them like events (folders stay on disk). Round jobs carry the active connection and the workspace bound to it; tasks a notes job creates go to `job.workspace_id`. `note_template` and `meeting_rule` are local records of the active workspace (Connect boots into `personal`; other workspaces are hidden by `WORKSPACES_HIDDEN`).
- **Transcripts are saved automatically.** Every transcript a check finds is downloaded into its meeting folder straight away; there is no setting, rule flag or *Download* button for it. The only download a person starts is *Try again* after a failed save or *Download again* in the ⋯ menu (`meeting_download`). *Make notes* is the one action: on a meeting whose transcript is found but not saved yet, the notes job saves it first; on a meeting still waiting for Teams, *Make notes as soon as it arrives* sets the meeting's `auto`, so notes follow the save. A failed save keeps `last_error` and is retried by the round when the code is `throttled`, `offline` or `provider`; `folder_unwritable` and `needs_login` wait for the person.
- Errors are `WorkspaceError { code, message }`; never flatten to strings. Codes introduced here: `transcript_blocked`, `transcript_missing`, `folder_missing`, `folder_unwritable`, `skill_missing`, `too_large`.
- Provider text is escaped in every template (`escapeHtml` from `store.js`); notes Markdown is rendered by `markdown.js`, which escapes before formatting.
- No optimistic UI updates (store.js contract); the only local state is view state.
- Meetings root default `~/CodeMie Connect/Meetings` (Windows `%USERPROFILE%\CodeMie Connect\Meetings`). Folder name `YYYY-MM-DD_HHMMSS-<slug>`, slug ≤ 60 chars, `-2`, `-3` on collision.
- Built-in template ids: `meeting-notes` (default), `short-summary`. Task statuses: `review`, `todo`, `doing`, `waiting`, `done`, `dismissed`. Meeting states: `upcoming`, `pending`, `available` (found in Teams, being saved, or the save failed with `last_error`), `downloaded` (saved, no notes), `ready`, `failed`, `blocked`, `none`, `offline`.
- Limits: transcript text sent to the AI `MAX_TRANSCRIPT_CHARS = 200_000`; imported file ≤ 5 MB; glossary/tags ≤ 100 KB each; skill text ≤ 50 000 chars; notes Markdown ≤ 300 KB; ≤ 50 tasks per run; notes run timeout 600 s; transcript checks start 10 min after the end, repeat every `checkEveryMin` (5/10/30, default 10), stop after 24 h, ≤ 25 checks per round.
- UI copy follows the prototype verbatim where it exists (labels in the spec tables).
- After any change to a contract JSON: `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, then commit the JSON.
- Quality gates before every commit: `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test`, then `npm test`.

## Review Focus

1. **Recurring meetings** share one online meeting: a weekly sync's lookup returns every week's transcripts. Only transcripts created between 30 min before the occurrence's start and 30 min after its end (3 h if no end) belong to it. → Task 1 `pick_transcripts_keeps_only_this_occurrence`.
2. **Long transcripts** (2-hour workshop, > 200 000 chars): the run still succeeds on the first 200 000 chars and both `run.log` and the document say the transcript was cut. → Task 3 `notes_input_cuts_long_transcripts_and_says_so`.
3. **Speakers that don't match attendees** ("Novak, Marek", "@1", a guest's display name): match on full name, "Last, First", first name or e-mail local part; otherwise `Speaker N`; tasks said by an unmatched speaker get no owner. → Task 1 `segments_match_speakers_to_attendees`.
4. **Titles that slug to nothing or collide** ("🚀 / Q1", two "Daily stand-up" in the same second): Unicode letters are kept, an empty slug becomes `meeting`, the second folder gets `-2`. → Task 1 `folder_names_keep_unicode_and_never_collide`.
5. **Meetings root missing or unwritable**: the **default** root is created on the first download; a **custom** root that is missing (renamed, external disk unplugged) or read-only fails with `folder_unwritable` (“Choose the folder again”) and leaves no half-written folder; reading a meeting whose folder vanished returns `folder_missing` and the UI offers *Download again*. → Task 1 `default_root_is_created_on_first_download`, `missing_custom_root_fails_with_folder_unwritable`, `download_into_unwritable_root_leaves_nothing`; Task 4 `files tab offers download again when the folder is missing`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/workspace/graph.rs` (modify) | `meetings` + `transcripts` capabilities, `graph_text_response`, Graph error code/message kept on 401/403, `Core::graph_get_text`, `seriesId` on events |
| `src-tauri/src/workspace/curl.rs` (modify) | Split `get` into a bytes read plus `decode` (JSON) and `decode_text` |
| `src-tauri/src/workspace/ai_jobs.rs` (modify) | `GraphReads::get_text`; `FakeGraph::answer_text` |
| `src-tauri/src/workspace/meetings/mod.rs` (new) | Op dispatch `meeting_op`, read queries, `meetings_round_at`, job executors, contract fixtures |
| `src-tauri/src/workspace/meetings/model.rs` (new) | `MeetingRecord`, `MeetingState`, `Doc`, `DocVersion`, `MeetingSettings`, `TaskBody` |
| `src-tauri/src/workspace/meetings/transcripts.rs` (new) | Graph URLs, transcript picking, state after a check |
| `src-tauri/src/workspace/meetings/vtt.rs` (new) | VTT/TXT parsing, speaker matching, segments, `transcript.md` |
| `src-tauri/src/workspace/meetings/folder.rs` (new) | Slug, folder name, unique folder, atomic writes of every folder file |
| `src-tauri/src/workspace/meetings/templates.rs` (new) | Built-in templates, template records, skills, resolution with reason |
| `src-tauri/src/workspace/meetings/rules.rs` (new) | `meeting_rule` matching |
| `src-tauri/src/workspace/meetings/glossary.rs` (new) | Glossary and tag parsing, linked or stored files |
| `src-tauri/src/workspace/meetings/notes.rs` (new) | `NOTES_SYSTEM`, `NOTES_SCHEMA`, input assembly, output parsing, applying documents and tasks |
| `src-tauri/src/workspace/tasks.rs` (new) | `task_save` / `task_delete` merge semantics and history |
| `src-tauri/src/workspace/{models.rs,mod.rs,repository.rs}` (modify) | Operations, settings, job kinds, claim limits, widget id |
| `ui/workspace/meetings-model.js` (new) | Pure: rows, derived state, lanes, legend, template resolution mirror, glossary/tag parse mirror |
| `ui/workspace/markdown.js` (new) | Escaping Markdown renderer with `[mm:ss]` links, front matter, tables |
| `ui/workspace/view-meetings.js` (new) | Meetings page: list, detail, status strip, tabs, dialogs |
| `ui/workspace/meetings-controller.js` (new) | Meetings actions, file-text queries with cache, keyboard, deep links |
| `ui/workspace/tasks-model.js`, `view-tasks.js`, `tasks-controller.js` (new) | Tasks board, list, drawer, drag and drop |
| `ui/workspace/view-settings-meetings.js` (new) | The five Settings › Meetings panels |
| `ui/workspace/{app.js,shell.js,icons.js,view-calendar.js,view-today.js,view-settings.js,settings-ai.js,workspace.css}` (modify) | Routes, nav, badges, Today card, settings group, purpose |
| `ui/test/*.test.mjs`, `ui/test/fixtures/**`, `ui/test/browser/workspace-e2e.mjs` | Tests and fixtures per task |
| `.ai-run/guides/architecture/architecture.md`, `.ai-run/guides/testing/testing-patterns.md` | Docs (Task 5) |

---

### Task 1: Transcripts — access, checks, download and the meeting folder

**Files:**
- Modify: `src-tauri/src/workspace/graph.rs:40-47` (`CAPABILITIES`), `graph.rs:1046` (next to `graph_response`), `graph.rs:1185-1225` (`normalize_event` stores `seriesId` from the already-fetched `seriesMasterId`), `src-tauri/src/workspace/curl.rs:38-78` (`decode`/`get`), `src-tauri/src/storage/commands.rs:311-332` (`Place`, `reveal_command` for `meetings_reveal`), `ai_jobs.rs:28-91` (`GraphReads`, `FakeGraph`), `models.rs` (`Operation`, `Settings.meetings`), `mod.rs` (`execute_job`, `background_round`, dispatch, `update_settings`)
- Create: `src-tauri/src/workspace/meetings/{mod.rs,model.rs,transcripts.rs,vtt.rs,folder.rs}`
- Test: inline `#[cfg(test)]` in each new file; contract JSON `ui/test/fixtures/contract/meeting-records.json`, `meeting-transcript.json`, `meeting-files.json`

**Interfaces:**
- Produces:
  - `graph::CAPABILITIES` += `("meetings","OnlineMeetings.Read")`, `("transcripts","OnlineMeetingTranscript.Read.All")`; `pub fn transcripts_permitted(c: &Connection) -> bool` (both permitted).
  - `pub(super) fn graph_text_response(status: u16, retry: &str, bytes: &[u8]) -> Result<String>` (same status → code mapping as `graph_response`; non-UTF-8 → `provider`). On 401/403 both `graph_response` and `graph_text_response` parse Graph's `{"error":{"code","message"}}` body and put `"<code>: <message>"` into the `WorkspaceError` message (today the body is dropped). `curl::get_bytes(...)` returns status, headers and body; `curl::decode` (JSON) and `curl::decode_text` sit on top of it.
  - `GraphReads::get_text(&self, core, c, url) -> BoxFuture<Result<String>>`; `FakeGraph::answer_text(url, text)` and `FakeGraph::fail(url, WorkspaceError)` (a read that fails with that error, e.g. `permission_required` with Graph's message).
  - `meetings::model::MeetingState` (serde snake_case, the nine states); `MeetingRecord { event_id, title, start, end, state, transcript_ids: Vec<String>, transcript_start: Option<String>, folder: Option<String>, checked_at: Option<i64>, error: Option<ErrorInfo>, external: Option<String>, imported: Option<String>, speakers: BTreeMap<String,String>, template: Option<String>, auto: Option<bool>, docs: Vec<Doc>, main: Option<String>, last_error: Option<ErrorInfo> }` stored as local record kind `meeting`, id = the event record id. `Doc`/`DocVersion` are declared here (empty until Task 3). Also declared here: `MeAlias { name: String, aliases: Vec<String> }` (Task 3's glossary fills it), `ErrorInfo { code: String, message: String }` (stored copy of a `WorkspaceError`), `Person { name: String, address: String }`, `TranscriptRef { id: String, created: i64 }`, `TranscriptFiles { vtt: Option<String>, md: String, segments: String, meeting: String, meta: String }`.
  - `MeetingSettings { root, folder_pattern ("echo"|"date-title"|"title-date"), check_every_min, auto_notes ("off"|"rules"|"all"), wait_min, skip_short, keep_vtt, keep_versions, review, only_attendees, we_me, ask_speakers, glossary_source ("connect"|"file"), glossary_file, tags_file, default_template, columns: BTreeMap<String,String>, done_days, remind, due_only_said }` under `Settings.meetings` (serde default), updated through `settings_update { meetings: {...} }` with each field validated.
  - `folder::slug(title: &str) -> String`; `folder::folder_name(local_start: NaiveDateTime, title: &str, pattern: &str) -> String`; `folder::unique_dir(root: &Path, name: &str) -> PathBuf`; `folder::write_transcript_folder(root: &Path, root_is_default: bool, name: &str, event_id: &str, files: &TranscriptFiles) -> Result<PathBuf>` (creates the root only when it is the default, else `folder_unwritable`; reuses an existing folder whose `meeting.json` has the same event id, so a download after reconnecting doesn't make `-2`; otherwise writes into `<name>.partial` and renames when complete).
  - `vtt::Cue { start: f64, end: f64, voice: String, text: String }`; `vtt::parse_vtt(&str) -> Vec<Cue>`; `vtt::parse_txt(&str) -> Vec<Cue>` (`Name: text` lines); `vtt::Segment { voice: String /* as written in the VTT, the key for speaker mapping */, speaker: String /* "me"|"remote" */, name: String, address: Option<String>, start: f64, end: f64, text: String }`; `vtt::segments(cues: &[Cue], people: &[Person], me: &MeAlias) -> Vec<Segment>` (merge same voice when gap < 2 s); `vtt::transcript_md(title, header_lines, &[Segment]) -> String` (`**Name** [hh:mm:ss]` + text).
  - `transcripts::lookup_url(join_url) -> String` (`/me/onlineMeetings?$filter=JoinWebUrl eq '…'`, quotes doubled, URL-encoded); `transcripts::list_url(meeting_id)`; `transcripts::content_url(meeting_id, transcript_id)` (`…/content?$format=text/vtt`); `transcripts::pick_transcripts(list: &Value, start: i64, end: Option<i64>) -> Vec<TranscriptRef>`; `transcripts::state_after_check(found: Result<Vec<TranscriptRef>>, ended_at: i64, now: i64) -> (MeetingState, Option<ErrorInfo>)`.
  - Operations: `meeting_check {meetingId}` (queues a check now), `meeting_download {meetingId}` (*Try again* / *Download again*: fetches the transcript again and rewrites the transcript files; documents and tasks stay), `meeting_import {meetingId, fileName, text}`, `meeting_speakers {meetingId, voice, address}`, `meetings_reveal {meetingId?}` (opens the meeting folder, or the root, in Finder/Explorer; extends the existing `reveal_command` `Place` enum with the meetings paths); read-only `meeting_read {meetingId, part: "transcript"|"files"|"file", name?}` → `{segments}` | `{files:[{name,size,modified}]}` | `{text}`.
  - Job kinds `transcript_check` (round: key `transcript_check:<meetingId>:<slot>`, slot = `now / (checkEveryMin*60)`; `meeting_check`: key `transcript_check:<operationId>`, deduped on payload `meetingId`) and `transcript_download` (`meeting_download`: key `transcript_download:<operationId>`, deduped on payload `meetingId` among queued/running; automatic: the check job queues `transcript_download:auto:<meetingId>:<slot>` as soon as it finds transcripts, and each round queues the same key for every `available` meeting with no queued/running download whose `last_error` is absent or retryable).
  - `meetings::meetings_round_at(core: &Core, now: i64) -> Result<()>`, called every 15 ticks next to automations in `background_round` (`mod.rs:414`).
- Consumes: event record fields `title, start, end, isOnlineMeeting, joinUrl, organizer, attendees, response, cancelled, isOrganizer` (`graph.rs:1185-1225`).

- [ ] **Step 1: Write the failing pure tests**

```rust
// folder.rs
#[test] fn folder_names_keep_unicode_and_never_collide() {
    assert_eq!(slug("Philips CodeMie conversations syncup"), "philips-codemie-conversations-syncup");
    assert_eq!(slug("Планування / Q1 🚀"), "планування-q1");
    assert_eq!(slug("🚀 / !!"), "meeting");
    assert!(slug(&"a ".repeat(80)).chars().count() <= 60);
    let t = NaiveDate::from_ymd_opt(2026,11,4).unwrap().and_hms_opt(16,4,26).unwrap();
    assert_eq!(folder_name(t, "Philips CodeMie conversations syncup", "echo"), "2026-11-04_160426-philips-codemie-conversations-syncup");
    assert_eq!(folder_name(t, "Daily stand-up", "date-title"), "2026-11-04-daily-stand-up");
    let dir = tempdir().unwrap(); fs::create_dir(dir.path().join("x")).unwrap();
    assert_eq!(unique_dir(dir.path(), "x"), dir.path().join("x-2"));
}
#[test] fn download_into_unwritable_root_leaves_nothing() // root is a read-only dir → Err(code "folder_unwritable"), no "<name>" or "<name>.partial" left
#[test] fn default_root_is_created_on_first_download()
#[test] fn missing_custom_root_fails_with_folder_unwritable()
#[test] fn same_event_reuses_its_folder() // meeting.json with the same event id → that folder, not "-2"
// vtt.rs
#[test] fn parse_vtt_reads_voices_and_strips_tags() // "<v Jeroen de Vries>Hi &amp; bye</v>" → voice "Jeroen de Vries", text "Hi & bye"; "<v @1>" → "Speaker 1"
#[test] fn segments_match_speakers_to_attendees() // "Novak, Marek" → marek.novak@…; "Marek" → same when unique; "@1" → "Speaker 1", address None; me alias "TM" → speaker "me"
#[test] fn segments_merge_same_speaker_within_two_seconds() // cues 0-3 s and 4.5-6 s same voice → one segment 0-6 s; gap 2.5 s → two
#[test] fn parse_txt_reads_name_colon_lines()
// transcripts.rs
#[test] fn lookup_url_escapes_the_join_link() // a link containing ' and spaces → doubled quote, %20, still starts with https://graph.microsoft.com/v1.0/me/onlineMeetings
#[test] fn pick_transcripts_keeps_only_this_occurrence() // three weekly transcripts → only the one created between start-30 min and end+30 min
#[test] fn state_after_check_maps_every_outcome() // found → Available; empty & 2 h after end → Pending; empty & 25 h → None; permission_required → Blocked with ErrorInfo code "transcript_blocked"
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd src-tauri && cargo test meetings::`
Expected: FAIL — unresolved module `meetings`.

- [ ] **Step 3: Implement `folder.rs`, `vtt.rs`, `transcripts.rs`, `model.rs`**

Slug: lowercase, keep `char::is_alphanumeric`, map everything else to `-`, collapse, trim, cut at 60 chars on a char boundary, `meeting` when empty. Folder time = first transcript `createdDateTime` converted to the workspace time zone, else the event start. VTT: cue blocks `HH:MM:SS.mmm --> …`, voice from `<v …>`, strip other tags, decode `&amp; &lt; &gt; &quot; &#39;`; several transcripts of one meeting are concatenated with each one's offset from its `createdDateTime`.

- [ ] **Step 4: Run the pure tests to pass**

Run: `cd src-tauri && cargo test meetings::`
Expected: PASS.

- [ ] **Step 5: Write the failing job and op tests (in `meetings/mod.rs`, using `test_core_with_graph` and `FakeGraph`)**

```rust
#[tokio::test] async fn round_queues_checks_only_for_ended_online_meetings() // ended 15 min ago with joinUrl → job; declined, cancelled, all-day, no joinUrl, ended 9 min ago → none; at most 25 per round
#[tokio::test] async fn check_finds_a_transcript_and_saves_it() // check → Available and a transcript_download:auto:<id>:<slot> job queued; running it → Downloaded with the folder; no setting involved
#[tokio::test] async fn check_on_403_marks_blocked_with_the_reason() // FakeGraph::fail(list_url, permission_required "GraphAccessToTranscriptsDisabled: …") → Blocked, error.message contains GraphAccessToTranscriptsDisabled
#[test] fn graph_response_keeps_the_graph_error_on_403() // body {"error":{"code":"Forbidden","message":"…"}} → message "Forbidden: …"
#[tokio::test] async fn check_without_transcripts_is_pending_then_none_after_a_day()
#[tokio::test] async fn checks_need_the_transcripts_capability() // capability off → no jobs, op meeting_check fails "permission_required"
#[tokio::test] async fn download_writes_the_echo_folder() // folder name as spec; files transcript.vtt, transcript.md, segments.json, meeting.json, meta.json; record state Downloaded, folder set; keep_vtt false → no transcript.vtt
#[tokio::test] async fn download_into_unwritable_root_fails_cleanly() // state stays Available, last_error.code "folder_unwritable"; the next round does not queue it again
#[tokio::test] async fn import_writes_imported_vtt_and_marks_downloaded() // also .txt; > 5 MB → "too_large"; no speaker lines → "validation"
#[tokio::test] async fn speakers_mapping_rewrites_segments_and_transcript_md() // with keep_vtt false: mapping by Segment.voice still works; mapping survives a second mapping change
#[tokio::test] async fn download_again_after_success_queues_again() // second meeting_download after a succeeded one creates a new job and runs
#[test] fn normalize_event_keeps_series_id()
#[tokio::test] async fn read_returns_segments_files_and_folder_missing() // folder deleted → Err code "folder_missing"
#[tokio::test] async fn failed_save_retries_in_the_next_slot() // FakeGraph::fail(content_url, throttled) → Available, last_error "throttled"; next slot's round queues it again and it succeeds; same slot → no second job; meeting_download (Try again) runs it at once
#[test] fn contract_fixtures_match_the_real_meetings() // writes meeting-records.json (one record per persisted state), meeting-transcript.json, meeting-files.json
```

- [ ] **Step 6: Run them to see them fail**

Run: `cd src-tauri && cargo test meetings::tests`
Expected: FAIL.

- [ ] **Step 7: Implement Graph text reads, capabilities, ops, jobs and the round**

`graph_get_text` mirrors `graph_get`: on macOS `curl::get_bytes` + `curl::decode_text`, elsewhere reqwest + `graph_text_response`. The check job runs lookup → list → `pick_transcripts` and stores `transcript_ids`; the download job fetches each content URL with `get_text`, builds segments with the event's organizer + attendees + `MeAlias` from the glossary `## Me` section when present (Task 3) else the connection's display name, and writes the folder. Add `transcript_check` and `transcript_download` to `execute_job` (`mod.rs:583-641`). `meeting_*` variants delegate to `meetings::meeting_op`; `MeetingRead` joins the read-only early returns.

- [ ] **Step 8: Run all Rust tests and write the contract fixtures**

Run: `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures && cargo test && cargo clippy -- -D warnings && cargo fmt --check`
Expected: PASS; three new JSON files under `ui/test/fixtures/contract/`.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/workspace ui/test/fixtures/contract/meeting-*.json
git commit -m "feat: check, download and import Teams transcripts into meeting folders"
```

**Test cases (manual, signed in to a test tenant):**

| ID | Steps | Expected |
|---|---|---|
| T1.1 | Turn on *Read Teams transcripts* (Task 5 UI, or `graph_connect` with `meetings`,`transcripts`) | Browser consent lists the two scopes; Activity shows a sync |
| T1.2 | Hold a 5-min Teams call with transcription on; wait 15 min | Meeting record `pending` → `available` → `downloaded` without a click; folder written |
| T1.3 | Open the folder from T1.2, then `meeting_download` (*Download again*) | Folder `<root>/YYYY-MM-DD_HHMMSS-<slug>/` with the five files; `transcript.md` speaker lines read correctly; download again rewrites them, nothing else changes |
| T1.4 | Weekly series: second occurrence | Only that week's transcript is downloaded |
| T1.5 | Meeting in another tenant | State `blocked` with the Graph reason |
| T1.6 | Choose a custom root, rename it, end a meeting with a transcript | State `available` with *folder_unwritable*; nothing half-written; no automatic retry; *Try again* after fixing works |

---

### Task 2: Tasks — commitments become tasks, with the Tasks page

**Files:**
- Create: `src-tauri/src/workspace/tasks.rs`; `ui/workspace/tasks-model.js`, `ui/workspace/view-tasks.js`, `ui/workspace/tasks-controller.js`; `ui/test/tasks-model.test.mjs`, `ui/test/tasks-controller.test.mjs`
- Modify: `models.rs` (`TaskSave`, `TaskDelete`), `mod.rs:880-911` (`local_save` keeps unknown commitment fields), `ui/workspace/shell.js` (`NAV`), `ui/workspace/app.js` (`ROUTES`, `render()`, `handle()` cases `summary-ask-commit` and `commitment-toggle`, `commitmentDialog`), `ui/workspace/icons.js`, `ui/workspace/view-today.js` (`WIDGETS.commitments` title, `commitmentsCard`), `ui/workspace/workspace.css`, `ui/test/workspace.test.mjs` (the `NAV` assert), `ui/test/fixtures/workspace-fixture.mjs`, `ui/test/browser/workspace-e2e.mjs`

**Interfaces:**
- Consumes: `MeetingRecord.folder`, `meeting.json` attendees (Task 1) for `tasks.json`.
- Produces:
  - **Owner:** `owner` is the person's e-mail address when known (tasks from notes, picked from attendees), otherwise free text (existing commitments store `"You"`); `ownerName` holds the display name. A task is *mine* when `owner` is `"You"` (any case), my address, or a name in `MeAlias`; JS `isMine(task, me)` and Rust `tasks::is_mine` implement the same rule.
  - Commitment body (kind stays `commitment` so existing data and the Today card keep working): `{ text, owner, ownerName, due, done, status, notes, meetingId, line, quote, quoteAt, speaker, confidence ("high"|"low"), order: f64, history: [{at, text}], sourceId, sourceRevision }`. `done` always equals `status == "done"`. A record without `status` reads as `done ? "done" : "todo"`.
  - `tasks::task_save(repo, workspace_id, data: &Value, now) -> Result<Record>` — merges into the existing body; appends history for status, owner and due changes (`"Moved from To do to In progress"`, `"Owner set to …"`, `"Due date set to …"`/`"Due date removed"`); when `meetingId` is set, rewrites that meeting's `tasks.json` (`[{id, task, owner, due, confidence, quote, t, status}]`).
  - `tasks::task_delete(repo, workspace_id, id) -> Result<Value>` returns the deleted body so the UI can restore it with `task_save`.
  - Operations `task_save` (fields above; `text` ≤ 2000, `notes` ≤ 20000, `status` in the six statuses) and `task_delete {id}`.
  - JS `tasks-model.js`: `taskStatus(record)`, `COLUMNS = ['review','todo','doing','waiting','done']`, `filterTasks(records, {who,person,meeting,due,q}, me, now)`, `sortTasks(a,b,now)` (overdue first, then `order`), `orderBetween(before, after) -> number`, `dueInfo(due, now) -> {tone,text}`.
  - JS `tasks-controller.js`: `createTasksController({state, snap, mutate, render, openModal, confirmModal, toast})` with `handle(action, el)`, `onDrop(taskId, column, beforeId)`.
  - `tasks::due_today_reminders(core, now) -> Result<()>` called from `meetings_round_at`: at 09:00 local, once per day, when `settings.meetings.remind` is on, queues one `notification` job (“3 tasks due today”, payload `{route:"tasks"}`) for your open tasks due today.
  - `openNotification` in `app.js` handles `route: "tasks"` (opens Tasks) — added here because this task produces that payload.
  - Route `tasks`, `NAV` entry `['tasks','Tasks']` after Calendar, icon `tasks`; Today `commitments` card title becomes `Tasks` (widget id unchanged); *Add a commitment* → *Add a task*; summary *asks* create tasks with `status: "todo"`.

- [ ] **Step 1: Write the failing Rust tests (`tasks.rs`)**

```rust
#[test] fn task_save_merges_and_keeps_meeting_fields() // save {status:"doing"} on a record with meetingId/line/quote → those stay; done false
#[test] fn task_save_keeps_done_in_step_with_status() // status "done" → done true; legacy {done:true} without status reads "done"
#[test] fn task_history_records_status_owner_and_due_changes() // three saves → three history lines with the exact texts above
#[test] fn local_save_of_commitment_keeps_task_fields() // old callers through local_save no longer drop status/history
#[test] fn task_delete_returns_the_body_and_save_restores_it()
#[test] fn task_save_rewrites_the_meeting_tasks_json() // meeting folder gets tasks.json with the Echo shape; folder missing → save still succeeds, tasks.json skipped
#[test] fn task_save_rejects_unknown_status_and_long_text()
#[tokio::test] async fn due_today_reminder_runs_once_a_day() // 08:59 → none; 09:00 → one notification; second round same day → none; remind off → none
```

- [ ] **Step 2: Run to fail** — `cd src-tauri && cargo test tasks::` → FAIL.

- [ ] **Step 3: Implement `tasks.rs`, the two operations, and the `local_save` merge for `commitment`**

- [ ] **Step 4: Run to pass** — `cd src-tauri && cargo test` → PASS.

- [ ] **Step 5: Write the failing JS tests**

```js
// tasks-model.test.mjs
test('legacy commitments read as todo or done')
test('isMine: "You", my address and my aliases are mine; another address is not')
test('filters: I owe, owed to me, nobody named, person, meeting, overdue, this week, no date, search')
test('overdue cards sort first in every column except Done')
test('orderBetween puts a dropped card between its neighbours and at the ends')
test('dueInfo labels yesterday, today, tomorrow, weekday and date with the right tone')
test('done tasks older than doneDays are hidden behind Show older')
// tasks-controller.test.mjs
test('dropping a review card on To do saves status todo and logs "Accepted from review"')
test('Move to menu saves the chosen status')
test('delete shows Undo and Undo saves the returned body back')
test('quick add saves owner, due and the column status')
// workspace.test.mjs
test('NAV lists Today, Calendar, Tasks, Inbox, Automations')
test('tasks board renders five columns, review cards with Accept/Dismiss, overdue in red')
test('task drawer shows the meeting quote with a link to the transcript line')
test('list view groups I owe, Owed to me, Nobody named')
test('dismissed tasks are listed and Restore puts them back in To review')
test('low-confidence review cards show Check the owner')
```

- [ ] **Step 6: Run to fail** — `node --test ui/test/tasks-model.test.mjs ui/test/tasks-controller.test.mjs ui/test/workspace.test.mjs` → FAIL.

- [ ] **Step 7: Build the Tasks page**

Port the prototype's `prototypes/meetings/view-tasks.js` markup to `view-tasks.js` using the app's `ui.js` components; drag and drop with HTML5 events in `tasks-controller.js` (drop indicator, `orderBetween`); the drawer edits save on `change`; column names come from `settings.meetings.columns`. Wire `route('tasks')`, `handle` prefix `task-` → controller (like the `automation*` delegation), `NAV`, icon, Today card copy.

- [ ] **Step 8: Extend the browser e2e**

Add `task_save`/`task_delete` mocks and a scenario `tasks board: review, drag, edit, delete and undo` (dark and light, 1000/1440/1680, `noOverflow`); add `tasks` to the layout loop over `['today','calendar','inbox','settings']`.

Run: `npm test && PLAYWRIGHT_CORE=$(npm root -g)/playwright-core node ui/test/browser/workspace-e2e.mjs`
Expected: all pass; screenshots in `output/playwright/workspace-e2e/`.

- [ ] **Step 9: Commit** — `git commit -m "feat: grow commitments into a Tasks board"`

**Test cases (manual):**

| ID | Steps | Expected |
|---|---|---|
| T2.1 | Open Tasks with existing commitments | Open ones in To do, done ones in Done; Today card titled *Tasks* |
| T2.2 | Drag a card To do → Waiting, between two cards | Lands there after reload; history shows the move |
| T2.3 | Keyboard: card ⋯ › Move to › Done | Same as drag |
| T2.4 | Delete a card, press Undo | Card returns with history intact |
| T2.5 | Filter *Owed to me* + *Overdue* | Only others' overdue tasks; counts match |
| T2.6 | Summary ask → *Add to tasks* in Inbox | Task in To do with the ask's due date |

---

### Task 3: Templates, rules, glossary and notes generation

**Files:**
- Create: `src-tauri/src/workspace/meetings/{templates.rs,rules.rs,glossary.rs,notes.rs}`
- Modify: `models.rs:233-239` (`Purpose::Meeting`), `models.rs` (operations), `repository.rs:1115` (claim SQL: `meeting_notes` joins the AI kinds limited to 2), `mod.rs` (`execute_job`), `meetings/mod.rs` (round: auto-notes), `ui/workspace/settings-ai.js:9-15` (`['meeting','Meeting notes','Notes and summaries from transcripts.']`), `ui/test/ai-settings.test.mjs`
- Test: inline Rust tests; contract JSON `meeting-notes-job.json`, `meeting-ready.json`, `glossary-parse.json`, `meeting-rules-cases.json`

**Interfaces:**
- Consumes: Task 1 records, segments, folder writer; Task 2 `tasks::task_save` body shape.
- Produces:
  - (uses `model::MeAlias` from Task 1)
  - `templates::BUILT_INS` — `meeting-notes` (“Meeting notes”, prompt = the prototype's `NOTES_PROMPT`, sections `frontmatter,tldr,context,knowledge,decisions,plan,actions,questions,transcriptNotes`) and `short-summary` (“Short summary”, `summary,decisions,actions`). Local record kind `note_template` `{ name, kind ("builtin"|"custom"|"skill"), blurb, prompt, sections, extractTasks, color, icon, skillPath }`; a record with a built-in id overrides it (*Edited*); deleting the override is *Reset to built-in*.
  - `templates::resolve(meeting: &MeetingRecord, event: &Value, rules: &[Rule], settings: &MeetingSettings, all: &[Template]) -> (Template, Why)` where `Why` is `Meeting` | `Rule(id)` | `Default`.
  - `rules::Rule { id, field ("title"|"organizer"|"org"|"people"), value, template, auto_notes, on, order }` (kind `meeting_rule`); `rules::matches(&Rule, event) -> bool`; `rules::first(&[Rule], event) -> Option<&Rule>`.
  - `glossary::parse_glossary(md) -> Glossary { me: Option<MeAlias>, pairs: Vec<(String,String)>, terms: Vec<String>, people: Vec<String> }`, `glossary::parse_tags(md) -> Vec<String>`; files `glossary.md`/`tags.md` in the root, or `glossary_file`/`tags_file` when `glossary_source == "file"`.
  - `notes::NOTES_SCHEMA` = `{ notesMarkdown: string, tasks: [{ title: string, owner: string, due: string, line: integer, confidence: "high"|"low" }] }`; `notes::notes_input(meeting, segments, template_text, glossary_md, tags_md, wishes, me) -> (Value, bool /*cut*/)` — transcript as `L{n} [hh:mm] {Name}: {text}`; `notes::parse_notes(v: &Value, n_lines: usize) -> Option<NotesOutput>` (wrapped in a closure for `run_claude_reported`); `notes::apply(meeting: &mut MeetingRecord, template: &Template, out: &NotesOutput, now, auto: bool, cut: bool) -> DocChange` (when `cut`, the note goes to Transcript notes, or to the end of the document when the template has no such section) (same template → new version, older one copied to `notes-history/`; else new `Doc`; first doc becomes main; main file `notes.md`, others `notes.<slug(template name)>.md`); `notes::tasks_from(out, meeting, people, settings, existing) -> Vec<Value>` (owner name → attendee address, `only_attendees`, dedupe by `line`, status `review` or `todo` per `settings.review`).
  - Operations: `meeting_notes {meetingId, templateId, wishes?, findTasks?, remember?}` → `{queued, jobId}` (same key returns the running job); `meeting_set {meetingId, template?: string|null, auto?: bool|null}`; `meeting_doc {meetingId, docId, action: "main"|"delete"|"version"|"edit", version?, text?, baseVersion?}`; `template_save {id?, …}`, `template_delete {id}`; `meeting_rule_save`, `meeting_rule_delete`, `meeting_rule_order {ids}`; `meeting_text_save {name: "glossary"|"tags", text}`; read-only `meeting_text {name}` → `{text, path, linked}`, `meeting_skills` → `[{name, path, description}]` (scans `~/.claude/skills/*/SKILL.md`), `meeting_read {part:"doc", docId, version?}` → `{text}`.
  - Job kind `meeting_notes`: `meeting_notes` op → key `meeting_notes:<operationId>`, deduped on payload `notesKey = <meetingId>:<templateId>` among queued/running jobs (the running job is returned); round auto-notes → key `meeting_notes:auto:<meetingId>`. Payload `{meetingId, templateId, notesKey, wishes, findTasks, auto, step, steps}`; saves the transcript first when the state is `available` (the joined *Make notes*); timeout `NOTES_TIMEOUT = 600 s`; skill templates use `NOTES_SYSTEM` + the `SKILL.md` text read at run time.

- [ ] **Step 1: Write the failing pure tests**

```rust
// glossary.rs
#[test] fn parse_glossary_reads_me_bold_terms_people_and_heard_as() // the spec's example → me "Taylor Morgan" aliases [Taylor, Тейлор, TM]; 7 pairs incl. ("light LLM","LiteLLM"); intro prose before the first ## ignored; heard-as counts in People too
#[test] fn parse_tags_reads_backticked_list_items() // 10 tags, "meeting" first
// rules.rs
#[test] fn rules_match_title_organizer_company_and_people_count()
#[test] fn first_matching_enabled_rule_wins()
// templates.rs
#[test] fn resolve_prefers_meeting_choice_then_rule_then_default()
#[test] fn built_in_override_and_reset()
// notes.rs
#[test] fn notes_input_numbers_lines_and_fills_variables() // {{title}} {{date}} {{participants}} {{me}} {{glossary}} {{tags}} {{wishes}} replaced; {{transcript}} → "the numbered transcript in input.transcript"
#[test] fn notes_input_cuts_long_transcripts_and_says_so() // 250 000 chars → 200 000 sent, cut = true; apply() adds "Transcript cut at 200 000 characters" to run.log and Transcript notes
#[test] fn parse_notes_rejects_bad_dates_lines_and_oversize() // due "2026-02-30" dropped, line ≥ segments → task dropped, > 50 tasks → first 50, > 300 KB → None
#[test] fn apply_adds_documents_and_versions() // run A → doc A main notes.md; run B → notes.short-summary.md; run A again → version 2, history file written; keep_versions false → no history file, version 1 dropped
#[test] fn tasks_from_maps_owners_and_dedupes_by_line() // "we" handled by the model; unknown owner → None; existing task on line 8 not duplicated
```

- [ ] **Step 2: Run to fail** — `cd src-tauri && cargo test meetings::` → FAIL.

- [ ] **Step 3: Implement `glossary.rs`, `rules.rs`, `templates.rs`, `notes.rs`**

- [ ] **Step 4: Run to pass** — PASS.

- [ ] **Step 5: Write the failing job tests (`meetings/mod.rs`, `FakeRunner` from `ai/fake.rs`)**

```rust
#[tokio::test] async fn notes_job_writes_documents_tasks_and_run_log() // FakeRunner returns structured {notesMarkdown, tasks:[…]} → notes.md, tasks.json, run.log; meeting Ready; tasks in "review"
#[tokio::test] async fn notes_job_downloads_first_when_available()
#[tokio::test] async fn queue_notes_twice_returns_the_running_job()
#[tokio::test] async fn notes_same_template_after_success_queues_again() // version 2 really runs
#[tokio::test] async fn notes_failure_keeps_existing_documents() // NeedsLogin on 2nd template → state stays Ready, last_error set; with no docs → Failed
#[tokio::test] async fn skill_template_reads_skill_md_each_run() // file changed between runs → second spec.system contains the new text; missing → "skill_missing"
#[tokio::test] async fn auto_notes_follow_rules_and_wait() // rule auto_notes + 15 min after end → job with auto:true; meeting_set {auto:true} while Pending → job right after the automatic save; skip_short and < 3 min → none
#[tokio::test] async fn meeting_doc_main_delete_and_edit() // edit with stale baseVersion → "conflict"; deleting main promotes the next; deleting last → Downloaded
#[tokio::test] async fn notes_runs_count_against_the_ai_limit() // two ai_summarize running → meeting_notes waits
#[test] fn contract_fixtures_match_the_real_meeting_notes() // meeting-notes-job.json (running with step), meeting-ready.json (2 docs), glossary-parse.json, meeting-rules-cases.json (inputs + expected template ids)
```

- [ ] **Step 6: Run to fail** → FAIL.

- [ ] **Step 7: Implement the job, operations, purpose and claim limit**

Follow `run_ai_summary_within` (`ai_jobs.rs:308-368`): `route(Purpose::Meeting)` → `start_run` → `run_claude_reported(..., parse_notes)` → write files → `commit_job_record` with the updated meeting record; tasks saved through `tasks::task_save`; when `auto`, queue a `notification` job (“Notes ready: <title>”, payload `meetingId`). After writing documents, rewrite `meta.json` (`templates`, `aiProfile`, `model`, `versions`). Report `step`/`steps` in the job payload before each phase (*Getting the transcript from Teams*, *Writing notes with <name>*, *Finding tasks*, *Saving to <folder>*).

- [ ] **Step 8: Run all gates and fixtures** — `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures && cargo test && cargo clippy -- -D warnings && cargo fmt --check && npm test` → PASS.

- [ ] **Step 9: Commit** — `git commit -m "feat: make meeting notes from templates and skills"`

**Test cases (manual):**

| ID | Steps | Expected |
|---|---|---|
| T3.1 | `meeting_notes` with *Meeting notes* on a real transcript | `notes.md` follows the template; tags only from `tags.md`; tasks in To review with attendee owners |
| T3.2 | Same meeting, *Short summary* | Second document `notes.short-summary.md`; first unchanged; no duplicate tasks |
| T3.3 | *Meeting notes* again with wishes | Version 2; version 1 in `notes-history/` |
| T3.4 | Sign out of Claude, run | Error shown; existing documents untouched; `run.log` has the reason |
| T3.5 | Rule “title contains X → auto notes”, hold meeting X | Notes 15 min after the transcript appears; notification opens the meeting |
| T3.6 | Skill template pointing at `~/.claude/skills/interview-review/SKILL.md` | Document follows the skill; edit the skill, run again → new text used |

---

### Task 4: Meetings page, calendar badges and Today

**Files:**
- Create: `ui/workspace/meetings-model.js`, `ui/workspace/markdown.js`, `ui/workspace/view-meetings.js`, `ui/workspace/meetings-controller.js`; `ui/test/meetings-model.test.mjs`, `ui/test/markdown.test.mjs`, `ui/test/meetings-controller.test.mjs`
- Modify: `ui/workspace/shell.js` (`NAV`), `ui/workspace/app.js` (`ROUTES`, `render()`, `route()`, `eventDialog`, `openNotification`, `boot()` hash parsing), `ui/workspace/icons.js`, `ui/workspace/view-calendar.js` (`timeGrid` block at `:128-165`, month row `:185`, agenda row `:218-227`, `eventDetails` `:236-261`), `ui/workspace/view-today.js` (`WIDGETS`, the `widgets` map), `ui/workspace/workspace.css`, `src-tauri/src/workspace/mod.rs:1817` (`WIDGET_IDS` += `"meetings"`), `ui/test/workspace.test.mjs`, `ui/test/fixtures/workspace-fixture.mjs` (`ev()` gains `isOnlineMeeting`; `withMeetings(snapshot, nowMs)` from the Task 1/3 contract JSON), `ui/test/browser/workspace-e2e.mjs`

**Interfaces:**
- Consumes: snapshot records `event`, `meeting`, `note_template`, `meeting_rule`, `commitment`; jobs of kind `transcript_check|transcript_download|meeting_notes`; queries `meeting_read`; all Task 1–3 operations.
- Produces:
  - `meetings-model.js`: `meetingState(event, record, now, transcriptsOn) -> state` (the record's state when there is one; else `upcoming` if not ended, `offline` if not an online meeting, `none` when the Rust round would never check it — declined, cancelled, all-day, no `joinUrl`, or `transcriptsOn` false — `pending` if ended < 24 h, `none` otherwise); `meetingRows(s, filter, q, showNone, now)`; `LANES` (`all`, `process`, `ready`, `attention`, `upcoming`); `LEGEND` and `legendOf(state)`; `resolveTemplate(event, record, s)` and `parseGlossary`/`parseTags` mirrors that must equal `meeting-rules-cases.json` and `glossary-parse.json`; `runOf(s, meetingId)` (the running job with `step`).
  - `markdown.js`: `renderMarkdown(md) -> html` (escape first; headings, lists, `- [ ]`, tables, `>` quotes, `**bold**`, `` `code` ``, front matter as `<dl>`, `[mm:ss]` → `<button data-action="meeting-goto-line" data-t>`).
  - `view-meetings.js`: `meetings(s, ctx)` (list + detail), `makeNotesBody(s, meeting)`, `importBody(s, meeting)`.
  - `meetings-controller.js`: `createMeetingsController({state, store, snap, mutate, render, openModal, confirmModal, toast, writeText, downloadText})`; `open(meetingId, tab)` used by Today, calendar, tasks and notifications; `handle(action, el)` for `meeting-*`, `doc-*`; a per-meeting cache of `meeting_read` results invalidated by the record's `revision`.
  - State slice `state.meetings = { filter, q, selected, tab, showNone, wide, compare, focusLine }`; hash `#/meetings/<encodeURIComponent(meetingId)>/<tab>` (this replaces the spec's `#r=meetings&m=…` form, to match the app's `#/route/tab` hashes), with a meetings branch in `boot()` (today it assigns `hash[2]` to `settingsTab` for every route but automations); `localPref('codemie.meetings.wide')`.
  - Calendar: `tBadge(event, record)` in time grid, month and agenda; `eventDetails` gains the *Transcript & notes* section; side panel toggle *Only meetings with transcripts* + legend; dialog footer *Show in Meetings*.
  - Today widget `meetings` (“From your meetings”: needs-you then to-process, each opens the meeting).

- [ ] **Step 1: Write the failing JS tests**

```js
// markdown.test.mjs
test('escapes HTML in every construct')                    // "<script>" in a heading, list, table cell, quote and front matter stays text
test('renders front matter, tables, checkboxes and [mm:ss] buttons')
// meetings-model.test.mjs
test('meetingState derives upcoming, offline, pending and none without a record, and none for meetings the round never checks')
test('boot opens #/meetings/<encoded id>/transcript')
test('lanes: All hides no-transcript meetings unless showNone; To do counts available+downloaded')
test('resolveTemplate matches meeting-rules-cases.json')   // reads ui/test/fixtures/contract/meeting-rules-cases.json
test('parseGlossary and parseTags match glossary-parse.json')
// meetings-controller.test.mjs
test('open() switches the filter so the meeting is visible and sets the tab')
test('make notes dialog preselects a template without a document when the meeting has some')
test('side by side hides the list and turning it off restores it')
test('doc edit saves with the version it was opened on')
// workspace.test.mjs
test('NAV lists Today, Calendar, Meetings, Tasks, Inbox, Automations')
test('meetings list: rows show time, title, coloured status; spinner only while a job runs; no status icons')
test('meeting detail: people by name with organizer/you/company, dimmed when they never spoke, status strip, five tabs')
test('make notes for all queues one meeting_notes per to-do meeting with its own template')
test('status strip shows a button only for the actionable step')
test('no Download button: available reads "Saving the transcript", a failed save shows Try again, Make notes works from available')
test('a meeting waiting for Teams offers "Make notes as soon as it arrives", which sends meeting_set {auto:true}')
test('files tab offers download again when the folder is missing')
test('calendar badge appears on online meetings only and the event card offers Show in Meetings')
test('today meetings card lists needs-you before to-do and links to the meeting')
```

- [ ] **Step 2: Run to fail** — `npm test` → FAIL.

- [ ] **Step 3: Build `markdown.js`, `meetings-model.js`, `view-meetings.js`, `meetings-controller.js`**

Port the approved prototype markup (`prototypes/meetings/view-meetings.js`, v5: no Download button, *Make notes* saves first, *Make notes as soon as it arrives* while waiting; list + detail, slim strip, document chips, One / Side by side, people chips, transcript with speaker filter and glossary underlines, tasks tab, files tab with Preview/Save a copy, people tab with talk share and speaker mapping) to the app's components and CSS classes; move only new rules to `workspace.css` with the `ws-` prefix. Wire routes, nav, icon, calendar, Today widget, notifications (`meetingId` → `open`, `route:"tasks"` → Tasks).

- [ ] **Step 4: Run to pass** — `npm test` → PASS.

- [ ] **Step 5: Extend the browser e2e**

Mocks for every Task 1/3 op (`meeting_read`, `meeting_text`, `meeting_skills` added to the no-bump list). Scenarios, dark and light, 1000/1440/1680, `noOverflow` on each: *calendar badge → event card → Make notes → strip shows progress → Ready*; *blocked meeting → import sample .vtt → name speakers*; *Philips: two documents, side by side, make main*; *waiting meeting → Make notes as soon as it arrives → check finds it → saved and notes made*; *failed save → Try again*; *Today card → meeting*; *task quote → transcript line highlighted*; ↑/↓ keyboard.

Run: `PLAYWRIGHT_CORE=$(npm root -g)/playwright-core node ui/test/browser/workspace-e2e.mjs` → all checks pass.

- [ ] **Step 6: Commit** — `git commit -m "feat: add the Meetings page, calendar transcript badges and Today card"`

**Test cases (manual):**

| ID | Steps | Expected |
|---|---|---|
| T4.1 | Calendar week with past Teams meetings | Badges match states; legend counts match; in-person meetings have none |
| T4.2 | Event card → *Make notes* | Dialog with templates; progress line on the meeting; badge turns green |
| T4.3 | Meetings › select a meeting, ↑/↓ | Detail updates without leaving the page; URL `#/meetings/<id>/<tab>` |
| T4.4 | Notes tab: *Another summary* → *Short summary*, then *Side by side* | Two documents, list hidden; switching back restores the list |
| T4.5 | Transcript tab: click a `[mm:ss]` in notes | Jumps to and highlights the line |
| T4.6 | Files tab after deleting the folder in Finder | *Download again* offered; works |
| T4.7 | Today › From your meetings → a row | Opens that meeting on the Meetings page |
| T4.8 | A meeting waiting for Teams → switch on *Make notes as soon as it arrives* | When Teams finishes, the transcript is saved and the notes are made with no other click; the notification opens the meeting |

---

### Task 5: Settings › Meetings, Claude purpose and docs

**Files:**
- Create: `ui/workspace/view-settings-meetings.js`; `ui/test/settings-meetings.test.mjs`
- Modify: `ui/workspace/view-settings.js` `SETTINGS_TABS` (group *Meetings*, after *Workspace*: `meetings-transcripts` “Transcripts & folders”, `meetings-templates` “Note templates”, `meetings-rules` “Automatic rules”, `meetings-glossary` “Glossary & tags”, `meetings-tasks` “Tasks”), `TAB_DESCRIPTIONS`, `ui/workspace/meetings-controller.js` (settings actions), `ui/workspace/app.js` (`handle` prefix `meetings-settings-`), `src-tauri/src/storage/commands.rs:546` (`pick_folder` gains a `title` parameter; new Tauri command `meetings_root_pick` beside `data_location_pick`, registered in `lib.rs` `invoke_handler`), `ui/test/browser/workspace-e2e.mjs`, `.ai-run/guides/architecture/architecture.md`, `.ai-run/guides/testing/testing-patterns.md`

**Interfaces:**
- Consumes: `settings.meetings`; `note_template`/`meeting_rule` records; `meeting_text`, `meeting_skills`, `meeting_read {part:"doc"}`; all Task 3 template/rule/text ops; `resolveTemplate`, `parseGlossary`, `parseTags` (Task 4).
- Produces:
  - Panels: **Transcripts & folders** (toggle *Read Teams transcripts* → `graph_connect` with `meetings`+`transcripts`; *Look for transcripts* (says each transcript is saved as soon as Teams has it), *Make notes automatically*, *Wait after the meeting*, *Skip very short meetings*; location + *Change…* + *Show in Finder*; folder name pattern with live preview; files list with *Keep original .vtt* / *Keep earlier versions*). **Note templates** (default template; cards grouped Built-in / Yours / Skills; editor with name, blurb, colour, instructions + variable chips, sections, *Find tasks*, *Save*/*Discard*/*Duplicate*/*Reset to built-in*; right side: latest document made with the template + *Try on a meeting*; *Add a skill* from `meeting_skills` or a path). **Automatic rules** (ordered rules, field/value/template, *Make notes automatically*, on/off, move up/down, delete with Undo; *Otherwise use* default; *Try a meeting* tester using `resolveTemplate`). **Glossary & tags** (where they live: *Here in Connect* / *Files I already keep* with the two paths; two Markdown editors with *Write*/*Preview*; *What Connect picks up* panel live from `parseGlossary`/`parseTags`; *Restore the example*; speaker toggles). **Tasks** (*Review before they reach the board*, *Only assign to people in the meeting*, *Due dates only when someone said one*, column names, *Hide done tasks after*, *Remind me about tasks due today*).
  - Tauri command `meetings_root_pick(app, window) -> Result<Option<String>>` (native picker titled “Choose where Connect keeps meeting folders”; saving the path goes through `settings_update { meetings: { root } }`). *Show in Finder* uses Task 1's `meetings_reveal`.

- [ ] **Step 1: Write the failing JS tests (`settings-meetings.test.mjs`)**

```js
test('settings has a Meetings group with the five tabs in order')
test('folder preview uses the chosen pattern for three sample meetings')
test('template editor marks unsaved changes and Save sends template_save with sections and prompt')
test('built-in shows Reset to built-in only when edited')
test('rule tester shows the template and reason for a typed title and people count')
test('glossary panel parses as you type without re-rendering the textarea')   // caret stays, panel text updates
test('linked mode shows the file path read-only and hides Restore the example')
test('transcripts toggle asks for meetings and transcripts capabilities')
```

- [ ] **Step 2: Run to fail** — `node --test ui/test/settings-meetings.test.mjs` → FAIL.

- [ ] **Step 3: Build the panels and actions**

Port `prototypes/meetings/view-settings.js` (v2 Settings › Meetings) to the app components; typing in the instruction and Markdown editors updates only the dirty bar and the summary panel (no full render), as the prototype's `markDirty`/`mdLive` do.

- [ ] **Step 4: Run to pass** — `npm test` → PASS.

- [ ] **Step 5: Extend the browser e2e and update docs**

Scenarios: edit *Meeting notes* instructions and save; add a skill; add/reorder a rule and test a title; type a glossary line and see it parsed; switch to linked files. Architecture guide: a *Meetings and tasks* section (record kinds, job kinds, ops, meetings root, folder files, contract fixtures); testing guide: the new contract fixtures and the parity tests.

Run: `npm test && PLAYWRIGHT_CORE=$(npm root -g)/playwright-core node ui/test/browser/workspace-e2e.mjs` → PASS.

- [ ] **Step 6: Final gates** — `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd .. && npm test && ./build-installer.sh` → `Done. All assertions passed.`

- [ ] **Step 7: Commit** — `git commit -m "feat: add Settings › Meetings and document meetings and tasks"`

**Test cases (manual):**

| ID | Steps | Expected |
|---|---|---|
| T5.1 | Toggle *Read Teams transcripts* | Consent prompt; on decline the toggle stays off with the reason |
| T5.2 | Change location, pick a new folder | New meeting folders go there; existing meetings keep their folders |
| T5.3 | Edit *Meeting notes*, Save, make notes | New document follows the edit; *Reset to built-in* restores |
| T5.4 | *Add a skill* → `interview-review` | Appears under Skills; usable in Make notes |
| T5.5 | Rules: move a rule up, test a title | Tester shows the new winner and reason |
| T5.6 | Glossary: add `- **Jeroen** — heard as “Yeroen”` | Panel lists the fix; next notes spell “Jeroen”; transcript underlines “Yeroen” |
| T5.7 | Linked files → point at `TERMS_TAXONOMY.md` | Read-only preview; notes use the file's spellings |
| T5.8 | Tasks: turn off *Review before…* | New tasks go straight to To do |

---

## Self-Review

- **Spec coverage:** calendar badge + card (T4), one-page Meetings with people by name, strip, tabs (T4), states incl. blocked/none/offline (T1, T4), Echo folder and files (T1, T3 notes/history/tasks.json), several documents + side by side + main (T3, T4), templates/skills/rules/variables/wishes (T3, T5), glossary/tags Markdown + linked files (T3, T5), tasks board/list/drawer/drag/move/undo/filters (T2), Tasks settings (T5), access toggle (T1, T5), editor preview as last document + Try (T5). Non-goals untouched.
- **Names:** `meeting_notes` job/op, `MeetingRecord.docs/main`, `MeAlias` (declared in Task 1), `task_save`, `resolveTemplate`, `parseGlossary` are used with the same names in every task.
- **Settings with no owner before this review:** due-today reminder (now Task 2), *Keep original .vtt* (Task 1 test), *Keep earlier versions* (Task 3 test), *Hide done tasks after* (Task 2 test).
- **After approval review (2026-11-17, prototype v5):** downloading is no longer a step: transcripts are saved automatically, *Make notes* saves first when needed, and a waiting meeting can be set to make notes as soon as its transcript arrives. Removed `auto_download` (settings and rules), the *Download* buttons and `auto_download_follows_*` tests; added slot keys for automatic saves so a failed save can retry.
- **Independent review (2026-11-17):** request-changes with 1 critical + 6 major findings, all applied: job keys per operation (critical), record/job ownership, Graph 403 reason through curl and `FakeGraph::fail`, `Segment.voice`, task `owner`/`ownerName`/`isMine`, rule-based auto-download owner, default vs custom root; minor: `apply`/`parse_notes` inputs, picker command + `meetings_reveal`, notification route in Task 2, declared types, `seriesId` + `meta.json`, Tasks list/restore/low-confidence tests, deep link + `boot()`, JS state eligibility.
- **References:** Rust file:line references checked on `0671e93`; UI references are symbols because those files had uncommitted plugin changes.
- **Review Focus:** each of the five lines has a named test in Task 1, 3 or 4.
