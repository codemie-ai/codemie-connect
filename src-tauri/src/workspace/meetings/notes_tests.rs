//! Notes job and operation tests: a real `Core` over a temp folder, Teams answered by
//! `FakeGraph`, Claude by `FakeRunner`.
use super::model::*;
use super::notes::{NOTES_SCHEMA, NOTES_SYSTEM};
use super::tests::*;
use super::transcripts::{content_url, list_url, lookup_url};
use super::*;
use crate::ai::fake::FakeRunner;
use crate::ai::stream::{AiError, ErrorClass, RunOutcome, Usage};
use crate::workspace::models::*;
use crate::workspace::Core;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Three people talking for almost four minutes.
const LONG_VTT: &str = "WEBVTT\n\n00:00:01.000 --> 00:01:10.000\n<v Jeroen de Vries>Welcome. Let us go through the pilot plan.</v>\n\n00:01:12.000 --> 00:02:30.000\n<v Taylor Morgan>We will send the export sample by Friday.</v>\n\n00:02:31.000 --> 00:03:40.000\n<v Novak, Marek>I will prepare the demo.</v>\n";

const FOLDER: &str = "2026-11-04_160426-philips-codemie-conversations-syncup";

fn outcome(notes: &str, tasks: Value) -> std::result::Result<RunOutcome, AiError> {
    Ok(RunOutcome {
        structured: Some(json!({"notesMarkdown": notes, "tasks": tasks})),
        text: String::new(),
        usage: Usage::default(),
        cost_usd: Some(0.02),
        duration_ms: 4200,
        model: Some("claude-sonnet-4-5".into()),
    })
}

struct Notes {
    e: Env,
    runner: Arc<FakeRunner>,
}

/// A signed-in account with transcripts on and Claude Code chosen, Claude answering `script`.
fn notes_env(script: Vec<std::result::Result<RunOutcome, AiError>>) -> Notes {
    let runner = Arc::new(FakeRunner::new(script));
    let e = env_with(runner.clone());
    choose_claude(&e.core);
    Notes { e, runner }
}

fn choose_claude(core: &Core) {
    let mut r = core.repo().unwrap();
    let mut s = r.settings().unwrap();
    s.ai.default_profile = Some("claude".into());
    r.settings_update(&s).unwrap();
}

/// The weekly sync of 4 Nov, its transcript saved from Teams; its folder.
async fn downloaded(e: &Env, id: &str) -> PathBuf {
    put(&e.core, event(id, SYNC, START, END, json!({})));
    teams(&e.graph, CREATED, VTT);
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": id}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(meeting(&e.core, id).state, MeetingState::Downloaded);
    folder_of(&e.core, id)
}

async fn make_notes(e: &Env, id: &str, template: &str, extra: Value) -> Result<Value> {
    let mut data = json!({"meetingId": id, "templateId": template});
    for (k, v) in extra.as_object().unwrap() {
        data[k] = v.clone();
    }
    op(&e.core, Operation::MeetingNotes, data).await
}

fn text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn tasks_of(core: &Core, id: &str) -> Vec<Record> {
    let mut tasks: Vec<Record> = core
        .repo()
        .unwrap()
        .local_records("personal", crate::workspace::tasks::KIND)
        .unwrap()
        .into_iter()
        .filter(|t| t.data["meetingId"] == id)
        .collect();
    tasks.sort_by_key(|t| t.data["line"].as_u64());
    tasks
}

fn notes_jobs(core: &Core) -> Vec<Job> {
    jobs(core, "meeting_notes")
}

#[tokio::test]
async fn notes_job_writes_documents_tasks_and_run_log() {
    let n = notes_env(vec![outcome(
        "---\ntitle: Sync\ntags: [meeting]\n---\n# Sync\n\n## Action Items\n- Send the notes",
        json!([
            {"title": "Send the notes", "owner": "Taylor Morgan", "due": "", "line": 3, "confidence": "high"},
            {"title": "Prepare the demo", "owner": "Marek Novak", "due": "2026-11-20", "line": 1, "confidence": "low"}
        ]),
    )]);
    let e = &n.e;
    let dir = downloaded(e, "m1").await;
    assert_eq!(dir.file_name().unwrap(), FOLDER);
    let queued = make_notes(
        e,
        "m1",
        "meeting-notes",
        json!({"wishes": "focus on the demo"}),
    )
    .await
    .unwrap();
    let ran = run_jobs(&e.core).await;
    let job = ran.iter().find(|j| j.kind == "meeting_notes").unwrap();
    assert_eq!(job.id, queued["jobId"]);
    assert_eq!(job.state, "succeeded", "{job:?}");
    assert_eq!(job.result.as_deref(), Some("Notes ready"));
    assert_eq!(
        job.payload["steps"],
        json!([
            "Writing notes with Meeting notes",
            "Finding tasks",
            format!("Saving to {FOLDER}")
        ])
    );
    assert_eq!(job.payload["step"], format!("Saving to {FOLDER}"));
    assert_eq!(job.payload["notesKey"], "m1:meeting-notes");
    assert_eq!(job.payload["auto"], false);
    // What Claude was given.
    let calls = n.runner.calls();
    assert_eq!(calls.len(), 1);
    let spec = &calls[0];
    assert_eq!(spec.purpose, "meeting");
    assert_eq!(spec.system, NOTES_SYSTEM);
    assert_eq!(
        spec.schema,
        Some(serde_json::from_str::<Value>(NOTES_SCHEMA).unwrap())
    );
    assert_eq!(spec.timeout, std::time::Duration::from_secs(600));
    let input = &spec.input;
    assert!(input["transcript"].as_str().unwrap().starts_with(
        "L0 [00:00] Jeroen de Vries: Welcome to the sync.\nL1 [00:00] Marek Novak: Thanks."
    ));
    assert_eq!(input["lines"], 4);
    let instructions = input["instructions"].as_str().unwrap();
    assert!(instructions.contains("Extra wishes for this run: focus on the demo"));
    assert!(instructions.contains(
        "Meeting: Philips CodeMie conversations syncup · 2026-11-04 (Wednesday), 16:00–16:30"
    ));
    assert!(instructions.contains("Taylor Morgan (me)"));
    // The folder: the main notes, run.log, tasks.json and meta.json.
    assert_eq!(
        text(&dir.join("notes.md")),
        "---\ntitle: Sync\ntags: [meeting]\n---\n# Sync\n\n## Action Items\n- Send the notes"
    );
    let log = text(&dir.join("run.log"));
    assert!(log.contains("Meeting notes"), "{log}");
    assert!(
        log.contains("Wrote notes.md (Meeting notes, version 1)"),
        "{log}"
    );
    assert!(log.contains("claude-sonnet-4-5"), "{log}");
    assert!(log.contains("2 new tasks to review"), "{log}");
    let meta: Value = serde_json::from_str(&text(&dir.join("meta.json"))).unwrap();
    assert_eq!(meta["templates"], json!(["meeting-notes"]));
    assert_eq!(meta["versions"], json!({"meeting-notes": 1}));
    assert_eq!(meta["ai_profile"], "claude");
    assert_eq!(meta["model"], "claude-sonnet-4-5");
    let listed: Vec<Value> = serde_json::from_str(&text(&dir.join("tasks.json"))).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0]["owner"], "Taylor Morgan");
    assert_eq!(listed[1]["owner"], "Marek Novak");
    // The meeting is ready, its first document the main one.
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Ready);
    assert_eq!(m.main.as_deref(), Some("meeting-notes"));
    assert_eq!(m.docs.len(), 1);
    assert_eq!(m.docs[0].file, "notes.md");
    assert_eq!(m.docs[0].wishes.as_deref(), Some("focus on the demo"));
    assert_eq!(m.docs[0].model.as_deref(), Some("claude-sonnet-4-5"));
    // Tasks wait in To review with attendee owners and their quote.
    let tasks = tasks_of(&e.core, "m1");
    assert_eq!(tasks.len(), 2);
    let demo = &tasks[0].data;
    assert_eq!(demo["text"], "Prepare the demo");
    assert_eq!(demo["status"], "review");
    assert_eq!(demo["owner"], "marek.novak@example.test");
    assert_eq!(demo["ownerName"], "Marek Novak");
    assert_eq!(demo["due"], "2026-11-20");
    assert_eq!(demo["confidence"], "low");
    assert_eq!(demo["quote"], "Thanks. The demo is ready.");
    assert_eq!(demo["quoteAt"], 5.0);
    assert_eq!(
        demo["history"][0]["text"],
        "Found in the notes (Meeting notes)"
    );
    let mine = &tasks[1].data;
    assert_eq!(mine["owner"], "taylor@example.test");
    assert_eq!(mine["line"], 3);
    assert_eq!(tasks[1].id, super::notes::task_id("m1", 3));
}

#[tokio::test]
async fn notes_job_downloads_first_when_available() {
    let n = notes_env(vec![outcome("# Notes", json!([]))]);
    let e = &n.e;
    put(&e.core, event("m1", SYNC, START, END, json!({})));
    teams(&e.graph, CREATED, VTT);
    let content = content_url(ONLINE, "t1");
    // Found, but the automatic save fails: the transcript waits in Teams.
    e.graph.fail(
        &content,
        WorkspaceError::new("throttled", "Too many requests."),
    );
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m1"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Available);
    assert_eq!(m.last_error.unwrap().code, "throttled");
    // Make notes saves it first; while that fails, no notes and no Claude.
    make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    let ran = run_jobs(&e.core).await;
    let failed = ran.iter().find(|j| j.kind == "meeting_notes").unwrap();
    assert_eq!(failed.state, "failed");
    assert_eq!(failed.error_code.as_deref(), Some("throttled"));
    assert_eq!(
        failed.payload["steps"][0],
        "Getting the transcript from Teams"
    );
    assert_eq!(failed.payload["step"], "Getting the transcript from Teams");
    let m = meeting(&e.core, "m1");
    assert_eq!(
        m.state,
        MeetingState::Available,
        "a failed save is not a failed notes run"
    );
    assert_eq!(m.last_error.unwrap().code, "throttled");
    assert!(n.runner.calls().is_empty());
    // Teams answers: one Make notes saves the transcript and writes the notes.
    e.graph.answer_text(&content, VTT);
    make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    let ran = run_jobs(&e.core).await;
    let job = ran.iter().find(|j| j.kind == "meeting_notes").unwrap();
    assert_eq!(job.state, "succeeded", "{job:?}");
    assert_eq!(
        job.payload["steps"],
        json!([
            "Getting the transcript from Teams",
            "Writing notes with Meeting notes",
            "Finding tasks",
            format!("Saving to {FOLDER}")
        ])
    );
    let dir = folder_of(&e.core, "m1");
    for file in ["transcript.vtt", "segments.json", "notes.md", "run.log"] {
        assert!(dir.join(file).is_file(), "{file}");
    }
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Ready);
    assert_eq!(m.last_error, None);
    assert_eq!(n.runner.calls().len(), 1);
}

#[tokio::test]
async fn queue_notes_twice_returns_the_running_job() {
    let n = notes_env(vec![]);
    let e = &n.e;
    downloaded(e, "m1").await;
    let first = make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    let again = make_notes(e, "m1", "meeting-notes", json!({"wishes": "other"}))
        .await
        .unwrap();
    assert_eq!(first["jobId"], again["jobId"]);
    let other = make_notes(e, "m1", "short-summary", json!({}))
        .await
        .unwrap();
    assert_ne!(first["jobId"], other["jobId"]);
    let queued = notes_jobs(&e.core);
    assert_eq!(queued.len(), 2);
    assert!(queued
        .iter()
        .all(|j| j.key.starts_with("meeting_notes:") && !j.key.starts_with("meeting_notes:auto:")));
    // What can't be queued.
    let unknown = make_notes(e, "m1", "no-such-template", json!({}))
        .await
        .unwrap_err();
    assert_eq!(unknown.code, "validation");
    let long = make_notes(
        e,
        "m1",
        "meeting-notes",
        json!({"wishes": "x".repeat(1001)}),
    )
    .await
    .unwrap_err();
    assert_eq!(long.code, "validation");
    put(&e.core, ended("later", 5, json!({"title": "Not yet"})));
    let none = make_notes(e, "later", "meeting-notes", json!({}))
        .await
        .unwrap_err();
    assert_eq!(none.code, "not_found");
    {
        let mut r = e.core.repo().unwrap();
        let mut s = r.settings().unwrap();
        s.ai.default_profile = None;
        r.settings_update(&s).unwrap();
    }
    let choose = make_notes(e, "m1", "short-summary", json!({"wishes": "new"}))
        .await
        .unwrap_err();
    assert_eq!(choose.code, "needs_choice");
}

#[tokio::test]
async fn notes_same_template_after_success_queues_again() {
    let n = notes_env(vec![
        outcome("# Version one", json!([])),
        outcome("# Version two", json!([])),
        outcome("# Version three", json!([])),
    ]);
    let e = &n.e;
    let dir = downloaded(e, "m1").await;
    let first = make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let second = make_notes(e, "m1", "meeting-notes", json!({"wishes": "shorter"}))
        .await
        .unwrap();
    assert_ne!(first["jobId"], second["jobId"]);
    run_jobs(&e.core).await;
    assert_eq!(
        job_by_id(&e.core, second["jobId"].as_str().unwrap()).state,
        "succeeded"
    );
    assert_eq!(n.runner.calls().len(), 2);
    assert_eq!(text(&dir.join("notes.md")), "# Version two");
    let m = meeting(&e.core, "m1");
    let doc = &m.docs[0];
    assert_eq!(doc.version, 2);
    let kept = doc.versions[0].file.clone().unwrap();
    assert!(
        kept.starts_with("notes-history/") && kept.ends_with("-meeting-notes.md"),
        "{kept}"
    );
    assert_eq!(text(&dir.join(&kept)), "# Version one");
    assert!(text(&dir.join("run.log")).contains("version 1 kept in notes-history/"));
    // Earlier versions read back, by number.
    let v1 = e
        .core
        .request(read(
            Operation::MeetingRead,
            json!({"meetingId": "m1", "part": "doc", "docId": "meeting-notes", "version": 1}),
        ))
        .await
        .unwrap();
    assert_eq!(v1["text"], "# Version one");
    let current = e
        .core
        .request(read(
            Operation::MeetingRead,
            json!({"meetingId": "m1", "part": "doc", "docId": "meeting-notes"}),
        ))
        .await
        .unwrap();
    assert_eq!(current["text"], "# Version two");
    // Use version 1 again: it is the document, version 2 is kept.
    op(
        &e.core,
        Operation::MeetingDoc,
        json!({"meetingId": "m1", "docId": "meeting-notes", "action": "version", "version": 1}),
    )
    .await
    .unwrap();
    assert_eq!(text(&dir.join("notes.md")), "# Version one");
    let doc = meeting(&e.core, "m1").docs[0].clone();
    assert_eq!(doc.version, 1);
    assert_eq!(
        doc.versions.iter().map(|v| v.version).collect::<Vec<_>>(),
        vec![2]
    );
    let v2 = doc.versions[0].file.clone().unwrap();
    assert_eq!(text(&dir.join(v2)), "# Version two");
    assert!(
        !dir.join(kept).exists(),
        "version 1's history copy is the document now"
    );
    // Notes again after using version 1: version 3, and version 2 is still there to read.
    make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(text(&dir.join("notes.md")), "# Version three");
    let doc = meeting(&e.core, "m1").docs[0].clone();
    assert_eq!(doc.version, 3);
    assert_eq!(
        doc.versions.iter().map(|v| v.version).collect::<Vec<_>>(),
        vec![1, 2]
    );
    for (version, said) in [
        (1, "# Version one"),
        (2, "# Version two"),
        (3, "# Version three"),
    ] {
        let read_back = e
            .core
            .request(read(
                Operation::MeetingRead,
                json!({"meetingId": "m1", "part": "doc", "docId": "meeting-notes", "version": version}),
            ))
            .await
            .unwrap();
        assert_eq!(read_back["text"], said, "version {version}");
    }
}

#[tokio::test]
async fn notes_failure_keeps_existing_documents() {
    let n = notes_env(vec![
        outcome("# Meeting notes", json!([])),
        Err(AiError::new(ErrorClass::NeedsLogin)),
        Err(AiError::new(ErrorClass::InvalidOutput)),
    ]);
    let e = &n.e;
    let dir = downloaded(e, "m1").await;
    make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    // The second template fails on a Claude sign-in.
    make_notes(e, "m1", "short-summary", json!({}))
        .await
        .unwrap();
    let ran = run_jobs(&e.core).await;
    let failed = ran.iter().find(|j| j.kind == "meeting_notes").unwrap();
    assert_eq!(failed.state, "blocked");
    assert_eq!(failed.error_code.as_deref(), Some("needs_login"));
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Ready, "documents keep it ready");
    assert_eq!(m.last_error.as_ref().unwrap().code, "needs_login");
    assert_eq!(m.docs.len(), 1);
    assert_eq!(text(&dir.join("notes.md")), "# Meeting notes");
    assert!(!dir.join("notes.short-summary.md").exists());
    let log = text(&dir.join("run.log"));
    assert!(log.contains("Short summary · failed"), "{log}");
    assert!(log.contains("Claude is not signed in."), "{log}");
    assert!(log.contains("Your documents were not changed."), "{log}");
    // A meeting without documents fails.
    put(
        &e.core,
        event(
            "m2",
            "Roadmap review",
            START,
            END,
            json!({"joinUrl": "https://teams.microsoft.com/l/m2"}),
        ),
    );
    e.graph.answer(
        &lookup_url("https://teams.microsoft.com/l/m2"),
        json!({"value": [{"id": "ONLINE-2"}]}),
    );
    e.graph.answer(
        &list_url("ONLINE-2"),
        json!({"value": [{"id": "t2", "createdDateTime": CREATED}]}),
    );
    e.graph.answer_text(&content_url("ONLINE-2", "t2"), VTT);
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m2"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    make_notes(e, "m2", "meeting-notes", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let m2 = meeting(&e.core, "m2");
    assert_eq!(m2.state, MeetingState::Failed);
    assert_eq!(m2.last_error.unwrap().code, "invalid_output");
    assert!(m2.docs.is_empty());
    let dir2 = folder_of(&e.core, "m2");
    assert!(!dir2.join("notes.md").exists());
    let log = text(&dir2.join("run.log"));
    assert!(log.contains("Meeting notes · failed"), "{log}");
    assert!(log.contains("No notes were written."), "{log}");
}

#[tokio::test]
async fn skill_template_reads_skill_md_each_run() {
    let n = notes_env(vec![
        outcome("# One", json!([])),
        outcome("# Two", json!([])),
    ]);
    let e = &n.e;
    let skills = e.core.home.clone().unwrap().join(".claude/skills");
    let folder = skills.join("interview-review");
    std::fs::create_dir_all(&folder).unwrap();
    let skill = folder.join("SKILL.md");
    std::fs::write(
        &skill,
        "---\nname: interview-review\ndescription: Assess an interview you ran.\n---\n# Interview review\nVERSION ONE",
    )
    .unwrap();
    std::fs::create_dir_all(skills.join("not-a-skill")).unwrap();
    // The skills on this Mac.
    let found = e
        .core
        .request(read(Operation::MeetingSkills, json!({})))
        .await
        .unwrap();
    assert_eq!(
        found,
        json!([{"name": "interview-review", "path": skill.to_string_lossy(), "description": "Assess an interview you ran."}])
    );
    let saved = op(
        &e.core,
        Operation::TemplateSave,
        json!({"name": "Interview assessment", "kind": "skill", "skillPath": skill.to_string_lossy(), "extractTasks": false}),
    )
    .await
    .unwrap();
    let id = saved["id"].as_str().unwrap().to_string();
    downloaded(e, "m1").await;
    make_notes(e, "m1", &id, json!({})).await.unwrap();
    run_jobs(&e.core).await;
    std::fs::write(&skill, "# Interview review\nVERSION TWO").unwrap();
    make_notes(e, "m1", &id, json!({})).await.unwrap();
    run_jobs(&e.core).await;
    let calls = n.runner.calls();
    assert_eq!(calls.len(), 2);
    assert!(calls[0].system.starts_with(NOTES_SYSTEM));
    assert!(calls[0].system.contains("VERSION ONE"));
    assert!(calls[1].system.contains("VERSION TWO"));
    assert!(!calls[1].system.contains("VERSION ONE"));
    assert_eq!(calls[1].input["instructions"], "");
    assert_eq!(calls[1].input["taskRules"]["findTasks"], false);
    // The skill file is gone: the run says so and Claude is not asked.
    std::fs::remove_file(&skill).unwrap();
    make_notes(e, "m1", &id, json!({})).await.unwrap();
    let ran = run_jobs(&e.core).await;
    let failed = ran.iter().find(|j| j.kind == "meeting_notes").unwrap();
    assert_eq!(failed.error_code.as_deref(), Some("skill_missing"));
    assert_eq!(n.runner.calls().len(), 2);
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Ready);
    assert_eq!(m.last_error.unwrap().code, "skill_missing");
}

#[tokio::test]
async fn auto_notes_follow_rules_and_wait() {
    let n = notes_env(vec![
        outcome("# Philips", json!([])),
        outcome(
            "# Planning",
            json!([{"title": "Send the notes", "owner": "Taylor Morgan", "due": "", "line": 3, "confidence": "high"}]),
        ),
    ]);
    let e = &n.e;
    {
        let mut r = e.core.repo().unwrap();
        let mut s = r.settings().unwrap();
        s.notifications = true;
        r.settings_update(&s).unwrap();
    }
    op(
        &e.core,
        Operation::MeetingRuleSave,
        json!({"field": "title", "value": "Philips", "template": "short-summary", "autoNotes": true}),
    )
    .await
    .unwrap();
    // A Philips meeting that ended 10 minutes ago, its transcript saved now.
    let end = now() - 600;
    put(
        &e.core,
        event("auto", SYNC, &rfc(end - 1800), &rfc(end), json!({})),
    );
    teams(&e.graph, &rfc(end - 1500), LONG_VTT);
    meetings_round_at(&e.core, now()).unwrap();
    run_jobs(&e.core).await;
    assert_eq!(meeting(&e.core, "auto").state, MeetingState::Downloaded);
    // The rule waits 15 minutes after the meeting.
    assert!(notes_jobs(&e.core).is_empty());
    meetings_round_at(&e.core, now()).unwrap();
    assert!(notes_jobs(&e.core).is_empty());
    meetings_round_at(&e.core, end + 15 * 60).unwrap();
    let auto = notes_jobs(&e.core);
    assert_eq!(auto.len(), 1);
    assert_eq!(auto[0].key, "meeting_notes:auto:auto");
    assert_eq!(auto[0].payload["auto"], true);
    assert_eq!(auto[0].payload["templateId"], "short-summary");
    // Queued by the round of 15 minutes after the meeting: due then.
    run_jobs_ahead(&e.core, 300).await;
    let m = meeting(&e.core, "auto");
    assert_eq!(m.state, MeetingState::Ready);
    assert!(m.docs[0].auto);
    // The notification opens the meeting.
    let note = jobs(&e.core, "notification")
        .into_iter()
        .find(|j| j.payload["meetingId"] == "auto")
        .expect("a Notes ready notification");
    assert_eq!(note.payload["title"], format!("Notes ready: {SYNC}"));
    assert_eq!(note.payload["route"], "meetings");
    assert!(note.payload["body"]
        .as_str()
        .unwrap()
        .contains("Short summary"));
    // One automatic attempt per meeting.
    meetings_round_at(&e.core, end + 3600).unwrap();
    assert_eq!(notes_jobs(&e.core).len(), 1);

    // Tasks that skip review: the notification says where they went, as run.log does.
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"review": false}}),
    )
    .await
    .unwrap();
    // "Make notes as soon as it arrives" on a meeting still waiting for Teams: the notes follow
    // the automatic save at once.
    let end2 = now() - 12 * 60;
    let join = "https://teams.microsoft.com/l/planning";
    put(
        &e.core,
        event(
            "asap",
            "Sprint 25 planning",
            &rfc(end2 - 1800),
            &rfc(end2),
            json!({"joinUrl": join}),
        ),
    );
    op(
        &e.core,
        Operation::MeetingSet,
        json!({"meetingId": "asap", "auto": true}),
    )
    .await
    .unwrap();
    assert_eq!(meeting(&e.core, "asap").auto, Some(true));
    assert_eq!(meeting(&e.core, "asap").state, MeetingState::Pending);
    e.graph
        .answer(&lookup_url(join), json!({"value": [{"id": "ONLINE-P"}]}));
    e.graph.answer(
        &list_url("ONLINE-P"),
        json!({"value": [{"id": "tp", "createdDateTime": rfc(end2 - 1700)}]}),
    );
    e.graph.answer_text(&content_url("ONLINE-P", "tp"), VTT);
    meetings_round_at(&e.core, now()).unwrap();
    let ran = run_jobs(&e.core).await;
    let kinds: Vec<&str> = ran.iter().map(|j| j.kind.as_str()).collect();
    assert_eq!(
        &kinds[..3],
        &["transcript_check", "transcript_download", "meeting_notes"]
    );
    let asap = notes_jobs(&e.core)
        .into_iter()
        .find(|j| j.payload["meetingId"] == "asap")
        .unwrap();
    assert_eq!(asap.key, "meeting_notes:auto:asap");
    assert_eq!(asap.state, "succeeded");
    assert_eq!(asap.payload["templateId"], "meeting-notes");
    assert_eq!(meeting(&e.core, "asap").state, MeetingState::Ready);
    let note = jobs(&e.core, "notification")
        .into_iter()
        .find(|j| j.payload["meetingId"] == "asap")
        .unwrap();
    assert_eq!(
        note.payload["body"],
        "Made with Meeting notes. 1 new task on the board."
    );
    assert!(text(&folder_of(&e.core, "asap").join("run.log"))
        .contains("Tasks: 1 new task on the board"));

    // Very short meetings, or ones with almost no talking, get no automatic notes.
    for (id, minutes, vtt) in [("short", 2, LONG_VTT), ("quiet", 30, VTT)] {
        let end = now() - 30 * 60;
        let join = format!("https://teams.microsoft.com/l/{id}");
        put(
            &e.core,
            event(
                id,
                "Philips quick call",
                &rfc(end - minutes * 60),
                &rfc(end),
                json!({"joinUrl": join}),
            ),
        );
        e.graph.answer(
            &lookup_url(&join),
            json!({"value": [{"id": format!("ONLINE-{id}")}]}),
        );
        e.graph.answer(
            &list_url(&format!("ONLINE-{id}")),
            json!({"value": [{"id": "t", "createdDateTime": rfc(end - minutes * 60 + 10)}]}),
        );
        e.graph
            .answer_text(&content_url(&format!("ONLINE-{id}"), "t"), vtt);
        op(&e.core, Operation::MeetingCheck, json!({"meetingId": id}))
            .await
            .unwrap();
        run_jobs(&e.core).await;
        assert_eq!(meeting(&e.core, id).state, MeetingState::Downloaded, "{id}");
        meetings_round_at(&e.core, now()).unwrap();
        assert!(
            !notes_jobs(&e.core)
                .iter()
                .any(|j| j.payload["meetingId"] == id),
            "{id}"
        );
    }
    // With Skip very short meetings off, the quiet one gets its notes.
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"skipShort": false}}),
    )
    .await
    .unwrap();
    meetings_round_at(&e.core, now()).unwrap();
    assert!(notes_jobs(&e.core)
        .iter()
        .any(|j| j.payload["meetingId"] == "quiet"));
}

#[tokio::test]
async fn meeting_doc_main_delete_and_edit() {
    let n = notes_env(vec![outcome("# A", json!([])), outcome("# B", json!([]))]);
    let e = &n.e;
    let dir = downloaded(e, "m1").await;
    make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    make_notes(e, "m1", "short-summary", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(text(&dir.join("notes.short-summary.md")), "# B");
    let doc = |action: &str, extra: Value| {
        let mut data = json!({"meetingId": "m1", "action": action});
        for (k, v) in extra.as_object().unwrap() {
            data[k] = v.clone();
        }
        op(&e.core, Operation::MeetingDoc, data)
    };
    // Make Short summary the main notes: the files swap names.
    doc("main", json!({"docId": "short-summary"}))
        .await
        .unwrap();
    assert_eq!(text(&dir.join("notes.md")), "# B");
    assert_eq!(text(&dir.join("notes.meeting-notes.md")), "# A");
    assert!(!dir.join("notes.short-summary.md").exists());
    let m = meeting(&e.core, "m1");
    assert_eq!(m.main.as_deref(), Some("short-summary"));
    let files: Vec<(&str, &str)> = m
        .docs
        .iter()
        .map(|d| (d.id.as_str(), d.file.as_str()))
        .collect();
    assert_eq!(
        files,
        vec![
            ("meeting-notes", "notes.meeting-notes.md"),
            ("short-summary", "notes.md")
        ]
    );
    // An edit sends the version and rev it was opened on; one made on an older version, or
    // without saying what it was opened on, is refused.
    assert_eq!(meeting(&e.core, "m1").docs[0].rev, 1);
    for base in [
        json!({"baseVersion": 2, "baseRev": 1}),
        json!({"baseVersion": 1}),
    ] {
        let mut data = json!({"docId": "meeting-notes", "text": "# A, edited"});
        data.as_object_mut()
            .unwrap()
            .extend(base.as_object().unwrap().clone());
        let stale = doc("edit", data).await.unwrap_err();
        assert_eq!(stale.code, "conflict", "{base}");
    }
    assert_eq!(text(&dir.join("notes.meeting-notes.md")), "# A");
    doc(
        "edit",
        json!({"docId": "meeting-notes", "text": "# A, edited", "baseVersion": 1, "baseRev": 1}),
    )
    .await
    .unwrap();
    assert_eq!(text(&dir.join("notes.meeting-notes.md")), "# A, edited");
    let m = meeting(&e.core, "m1");
    assert!(m.docs[0].edited);
    assert_eq!((m.docs[0].version, m.docs[0].rev), (1, 2));
    // A second window that opened the same text: refused, the first edit stays.
    let other = doc(
        "edit",
        json!({"docId": "meeting-notes", "text": "# A, other window", "baseVersion": 1, "baseRev": 1}),
    )
    .await
    .unwrap_err();
    assert_eq!(other.code, "conflict");
    assert_eq!(text(&dir.join("notes.meeting-notes.md")), "# A, edited");
    let read_back = e
        .core
        .request(read(
            Operation::MeetingRead,
            json!({"meetingId": "m1", "part": "doc", "docId": "meeting-notes"}),
        ))
        .await
        .unwrap();
    assert_eq!(read_back["text"], "# A, edited");
    // Deleting the main document promotes the next one; its text is kept in notes-history/.
    doc("delete", json!({"docId": "short-summary"}))
        .await
        .unwrap();
    assert_eq!(text(&dir.join("notes.md")), "# A, edited");
    assert!(!dir.join("notes.meeting-notes.md").exists());
    let history: Vec<String> = std::fs::read_dir(dir.join("notes-history"))
        .unwrap()
        .map(|f| text(&f.unwrap().path()))
        .collect();
    assert_eq!(history, vec!["# B"]);
    let m = meeting(&e.core, "m1");
    assert_eq!(m.main.as_deref(), Some("meeting-notes"));
    assert_eq!(m.docs.len(), 1);
    assert_eq!(m.docs[0].file, "notes.md");
    assert_eq!(m.state, MeetingState::Ready);
    // Deleting the last one: the transcript is still there, no notes.
    doc("delete", json!({"docId": "meeting-notes"}))
        .await
        .unwrap();
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Downloaded);
    assert!(m.docs.is_empty());
    assert_eq!(m.main, None);
    assert!(!dir.join("notes.md").exists());
    assert!(dir.join("transcript.md").exists());
    let meta: Value = serde_json::from_str(&text(&dir.join("meta.json"))).unwrap();
    assert_eq!(meta["templates"], json!([]));
    // A document that isn't there, an unknown action.
    assert_eq!(
        doc("delete", json!({"docId": "nope"}))
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    assert_eq!(
        doc("rename", json!({"docId": "nope"}))
            .await
            .unwrap_err()
            .code,
        "validation"
    );
}

#[tokio::test]
async fn notes_runs_count_against_the_ai_limit() {
    let e = env();
    let mut r = e.core.repo().unwrap();
    let job = |kind: &str, key: &str| {
        crate::workspace::new_job(
            kind,
            key.into(),
            Some("personal".into()),
            None,
            now() - 10,
            json!({}),
            json!({}),
        )
    };
    r.enqueue(&job("ai_summarize", "s1")).unwrap();
    r.enqueue(&job("ai_summarize", "s2")).unwrap();
    r.enqueue(&job("meeting_notes", "n1")).unwrap();
    let a = r.claim(now()).unwrap().unwrap();
    let b = r.claim(now()).unwrap().unwrap();
    assert_eq!(
        (a.kind.as_str(), b.kind.as_str()),
        ("ai_summarize", "ai_summarize")
    );
    // Two Claude runs at once: the notes wait.
    assert!(r.claim(now()).unwrap().is_none());
    let mut done = a.clone();
    done.state = "succeeded".into();
    done.lease_until = None;
    r.save_job(&done).unwrap();
    let notes = r.claim(now()).unwrap().unwrap();
    assert_eq!(notes.kind, "meeting_notes");
    // Notes runs count too: a draft waits behind them.
    r.enqueue(&job("ai_draft", "d1")).unwrap();
    assert!(r.claim(now()).unwrap().is_none());
}

#[tokio::test]
async fn meeting_set_chooses_the_template_and_auto() {
    let e = env();
    put(&e.core, event("m1", SYNC, START, END, json!({})));
    op(
        &e.core,
        Operation::MeetingSet,
        json!({"meetingId": "m1", "template": "short-summary", "auto": false}),
    )
    .await
    .unwrap();
    let m = meeting(&e.core, "m1");
    assert_eq!(
        (m.template.as_deref(), m.auto),
        (Some("short-summary"), Some(false))
    );
    // Only what is given changes; null takes it back.
    op(
        &e.core,
        Operation::MeetingSet,
        json!({"meetingId": "m1", "auto": null}),
    )
    .await
    .unwrap();
    let m = meeting(&e.core, "m1");
    assert_eq!(
        (m.template.as_deref(), m.auto),
        (Some("short-summary"), None)
    );
    op(
        &e.core,
        Operation::MeetingSet,
        json!({"meetingId": "m1", "template": null}),
    )
    .await
    .unwrap();
    assert_eq!(meeting(&e.core, "m1").template, None);
    let bad = op(
        &e.core,
        Operation::MeetingSet,
        json!({"meetingId": "m1", "template": "gone"}),
    )
    .await
    .unwrap_err();
    assert_eq!(bad.code, "validation");
    let bad = op(
        &e.core,
        Operation::MeetingSet,
        json!({"meetingId": "m1", "auto": "yes"}),
    )
    .await
    .unwrap_err();
    assert_eq!(bad.code, "validation");
    // Remember: the meeting's title becomes a rule, first in the list.
    let n = notes_env(vec![]);
    downloaded(&n.e, "m2").await;
    op(
        &n.e.core,
        Operation::MeetingRuleSave,
        json!({"field": "org", "value": "philips", "template": "meeting-notes"}),
    )
    .await
    .unwrap();
    op(
        &n.e.core,
        Operation::MeetingSet,
        json!({"meetingId": "m2", "template": "meeting-notes"}),
    )
    .await
    .unwrap();
    make_notes(&n.e, "m2", "short-summary", json!({"remember": true}))
        .await
        .unwrap();
    let rules: Vec<super::rules::Rule> =
        n.e.core
            .repo()
            .unwrap()
            .local_records("personal", super::rules::KIND)
            .unwrap()
            .iter()
            .filter_map(super::rules::from_record)
            .collect();
    let first = rules.iter().min_by_key(|r| r.order).unwrap();
    assert_eq!(
        (
            first.field.as_str(),
            first.value.as_str(),
            first.template.as_str()
        ),
        ("title", SYNC, "short-summary")
    );
    assert!(!first.auto_notes);
    assert_eq!(meeting(&n.e.core, "m2").template, None);
}

#[tokio::test]
async fn templates_and_rules_save_validate_and_delete() {
    let e = env();
    let save = |data: Value| op(&e.core, Operation::TemplateSave, data);
    // A template of your own.
    let mine = save(json!({"name": "  My client recap ", "prompt": "Recap {{title}}", "sections": ["summary", "risks"], "color": "#C084FC", "icon": "users"}))
        .await
        .unwrap();
    let mine = mine["id"].as_str().unwrap().to_string();
    let snapshot = |core: &Arc<Core>| {
        let core = core.clone();
        async move {
            core.request(read(Operation::Snapshot, json!({})))
                .await
                .unwrap()["snapshot"]
                .clone()
        }
    };
    let s = snapshot(&e.core).await;
    let names: Vec<&str> = s["noteTemplates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["Meeting notes", "Short summary", "My client recap"]
    );
    let own = &s["noteTemplates"][2];
    assert_eq!(
        (own["kind"].as_str(), own["id"].as_str()),
        (Some("custom"), Some(mine.as_str()))
    );
    // Edit a built-in: it stays built in and says Edited; Reset brings the original back.
    save(json!({"id": "meeting-notes", "prompt": "Only the decisions."}))
        .await
        .unwrap();
    let s = snapshot(&e.core).await;
    let notes = &s["noteTemplates"][0];
    assert_eq!(
        (
            notes["prompt"].as_str(),
            notes["edited"].as_bool(),
            notes["kind"].as_str(),
            notes["name"].as_str()
        ),
        (
            Some("Only the decisions."),
            Some(true),
            Some("builtin"),
            Some("Meeting notes")
        )
    );
    let reset = op(
        &e.core,
        Operation::TemplateDelete,
        json!({"id": "meeting-notes"}),
    )
    .await
    .unwrap();
    assert_eq!(reset["reset"], true);
    let s = snapshot(&e.core).await;
    assert_eq!(s["noteTemplates"][0]["edited"], false);
    assert!(s["noteTemplates"][0]["prompt"]
        .as_str()
        .unwrap()
        .starts_with("You turn one meeting transcript"));
    // What a template can't be.
    // A new template may bring its own id (a retried save makes one template).
    let given = save(json!({"id": "custom-1", "name": "Given", "prompt": "p"}))
        .await
        .unwrap();
    assert_eq!(given["id"], "custom-1");
    op(
        &e.core,
        Operation::TemplateDelete,
        json!({"id": "custom-1"}),
    )
    .await
    .unwrap();
    for (data, field) in [
        (
            json!({"id": "bad id/../x", "name": "A", "prompt": "p"}),
            "id",
        ),
        (json!({"name": ""}), "name"),
        (json!({"name": "x".repeat(81)}), "name"),
        (json!({"name": "A", "prompt": ""}), "prompt"),
        (json!({"name": "A", "prompt": "x".repeat(50_001)}), "prompt"),
        (
            json!({"name": "A", "prompt": "p", "sections": ["ok", "no spaces"]}),
            "sections",
        ),
        (json!({"name": "A", "prompt": "p", "color": "red"}), "color"),
        (json!({"name": "A", "kind": "skill"}), "skillPath"),
        (
            json!({"name": "A", "kind": "skill", "skillPath": "relative/SKILL.md"}),
            "skillPath",
        ),
        (
            json!({"name": "A", "kind": "skill", "skillPath": "/nowhere/SKILL.md"}),
            "skillPath",
        ),
        (
            json!({"name": "A", "prompt": "p", "extractTasks": "yes"}),
            "extractTasks",
        ),
    ] {
        let err = save(data.clone()).await.unwrap_err();
        assert_eq!(
            (err.code.as_str(), err.field.as_deref()),
            ("validation", Some(field)),
            "{data}"
        );
    }
    // Rules: added at the end, reordered, deleted with what Undo needs.
    let rule = |data: Value| op(&e.core, Operation::MeetingRuleSave, data);
    let r1 =
        rule(json!({"field": "title", "value": "Philips", "template": mine, "autoNotes": true}))
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
    let r2 = rule(json!({"field": "people", "value": "2", "template": "short-summary"}))
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let rules = || {
        let mut rules: Vec<super::rules::Rule> = e
            .core
            .repo()
            .unwrap()
            .local_records("personal", super::rules::KIND)
            .unwrap()
            .iter()
            .filter_map(super::rules::from_record)
            .collect();
        rules.sort_by_key(|r| r.order);
        rules
    };
    assert_eq!(
        rules().iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        vec![r1.clone(), r2.clone()]
    );
    assert!(rules()[0].on && rules()[0].auto_notes);
    op(
        &e.core,
        Operation::MeetingRuleOrder,
        json!({"ids": [r2, r1]}),
    )
    .await
    .unwrap();
    assert_eq!(
        rules().iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        vec![r2.clone(), r1.clone()]
    );
    rule(json!({"id": r2, "field": "people", "value": "2", "template": "short-summary", "on": false})).await.unwrap();
    assert!(!rules()[0].on, "an edit keeps its place");
    for (data, field) in [
        (
            json!({"field": "subject", "value": "x", "template": "meeting-notes"}),
            "field",
        ),
        (
            json!({"field": "title", "value": "x", "template": "gone"}),
            "template",
        ),
        (
            json!({"field": "title", "value": "x".repeat(201), "template": "meeting-notes"}),
            "value",
        ),
        (
            json!({"field": "title", "value": "x", "template": "meeting-notes", "autoNotes": 1}),
            "autoNotes",
        ),
    ] {
        let err = rule(data.clone()).await.unwrap_err();
        assert_eq!(
            (err.code.as_str(), err.field.as_deref()),
            ("validation", Some(field)),
            "{data}"
        );
    }
    // Deleting a template moves its rules to the default template.
    let gone = op(&e.core, Operation::TemplateDelete, json!({"id": mine}))
        .await
        .unwrap();
    assert_eq!(gone["deleted"], true);
    assert_eq!(rules()[1].template, "meeting-notes");
    let deleted = op(&e.core, Operation::MeetingRuleDelete, json!({"id": r1}))
        .await
        .unwrap();
    assert_eq!(deleted["deleted"], true);
    assert_eq!(deleted["body"]["value"], "Philips");
    assert_eq!(rules().len(), 1);
    // Undo: the body saved back under its id.
    let mut body = deleted["body"].clone();
    body["id"] = r1.clone().into();
    rule(body).await.unwrap();
    assert_eq!(
        rules().iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        vec![r2, r1]
    );
}

#[tokio::test]
async fn glossary_and_tags_are_saved_in_the_root_or_read_from_linked_files() {
    let e = env();
    let text_of = |name: &str| {
        let core = e.core.clone();
        let name = name.to_string();
        async move {
            core.request(read(Operation::MeetingText, json!({"name": name})))
                .await
        }
    };
    let root = default_root(&e.core);
    let empty = text_of("glossary").await.unwrap();
    assert_eq!(
        empty,
        json!({"text": "", "path": root.join("glossary.md").to_string_lossy(), "linked": false, "cut": false})
    );
    let saved = op(
        &e.core,
        Operation::MeetingTextSave,
        json!({"name": "glossary", "text": "## Me\n**Taylor Morgan** — “TM”"}),
    )
    .await
    .unwrap();
    assert_eq!(saved["saved"], true);
    assert_eq!(
        text(&root.join("glossary.md")),
        "## Me\n**Taylor Morgan** — “TM”"
    );
    assert_eq!(
        text_of("glossary").await.unwrap()["text"],
        "## Me\n**Taylor Morgan** — “TM”"
    );
    op(
        &e.core,
        Operation::MeetingTextSave,
        json!({"name": "tags", "text": "- `meeting`"}),
    )
    .await
    .unwrap();
    assert_eq!(text(&root.join("tags.md")), "- `meeting`");
    // The glossary's Me names me in transcripts and tasks.
    let c = e.core.repo().unwrap().connection(ACCT).unwrap();
    let s = e.core.repo().unwrap().settings().unwrap().meetings;
    let me = e.core.me_alias(&c, &s);
    assert_eq!(
        (me.name.as_str(), me.aliases.clone()),
        ("Taylor Morgan", vec!["TM".to_string()])
    );
    // Too large, an unknown name.
    let big = op(
        &e.core,
        Operation::MeetingTextSave,
        json!({"name": "tags", "text": "x".repeat(100 * 1024 + 1)}),
    )
    .await
    .unwrap_err();
    assert_eq!(big.code, "too_large");
    assert_eq!(text_of("notes").await.unwrap_err().code, "validation");
    // Files I already keep: read from there, never written by Connect.
    let terms = e.core.paths.data.join("TERMS_TAXONOMY.md");
    std::fs::write(&terms, "- **LiteLLM** — heard as “light LLM”").unwrap();
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"glossarySource": "file", "glossaryFile": terms.to_string_lossy()}}),
    )
    .await
    .unwrap();
    assert_eq!(
        text_of("glossary").await.unwrap(),
        json!({"text": "- **LiteLLM** — heard as “light LLM”", "path": terms.to_string_lossy(), "linked": true, "cut": false})
    );
    assert_eq!(
        text_of("tags").await.unwrap(),
        json!({"text": "", "path": null, "linked": true, "cut": false})
    );
    let refused = op(
        &e.core,
        Operation::MeetingTextSave,
        json!({"name": "glossary", "text": "x"}),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, "validation");
    assert_eq!(text(&terms), "- **LiteLLM** — heard as “light LLM”");
}

#[tokio::test]
async fn a_glossary_that_cannot_be_read_whole_is_never_written_over() {
    use std::os::unix::fs::PermissionsExt;
    let e = env();
    let root = default_root(&e.core);
    std::fs::create_dir_all(&root).unwrap();
    let text_of = |name: &str| {
        e.core
            .request(read(Operation::MeetingText, json!({"name": name})))
    };
    let save = |name: &str, text: &str| {
        op(
            &e.core,
            Operation::MeetingTextSave,
            json!({"name": name, "text": text}),
        )
    };
    // Longer than 100 KB: the first 100 KB, said to be cut; saving over it is refused.
    let long = format!(
        "## Me\n**Taylor Morgan**\n{}",
        "- **Term**\n".repeat(12_000)
    );
    std::fs::write(root.join("glossary.md"), &long).unwrap();
    let cut = text_of("glossary").await.unwrap();
    assert_eq!(cut["cut"], true);
    assert_eq!(cut["text"].as_str().unwrap().len(), 100 * 1024);
    let refused = save("glossary", "## Me\n**Taylor Morgan**")
        .await
        .unwrap_err();
    assert_eq!(refused.code, "too_large", "{refused:?}");
    assert!(refused.message.contains("glossary.md"), "{refused:?}");
    assert_eq!(text(&root.join("glossary.md")), long);
    // A file Connect may not read: an error that names it, and nothing is written over it.
    let tags = root.join("tags.md");
    std::fs::write(&tags, "- `meeting`\n- `pilot`\n").unwrap();
    std::fs::set_permissions(&tags, std::fs::Permissions::from_mode(0o000)).unwrap();
    let read_error = text_of("tags").await;
    let save_error = save("tags", "").await;
    std::fs::set_permissions(&tags, std::fs::Permissions::from_mode(0o644)).unwrap();
    let read_error = read_error.unwrap_err();
    assert_eq!(read_error.code, "unreadable");
    assert!(read_error.message.contains("tags.md"), "{read_error:?}");
    assert_eq!(save_error.unwrap_err().code, "unreadable");
    assert_eq!(text(&tags), "- `meeting`\n- `pilot`\n");
    // A folder where the file should be.
    std::fs::remove_file(&tags).unwrap();
    std::fs::create_dir(&tags).unwrap();
    assert_eq!(text_of("tags").await.unwrap_err().code, "unreadable");
    assert_eq!(save("tags", "- `x`").await.unwrap_err().code, "unreadable");
    assert!(tags.is_dir());
    // Missing is simply empty, and can be written.
    std::fs::remove_dir(&tags).unwrap();
    assert_eq!(text_of("tags").await.unwrap()["text"], "");
    save("tags", "- `x`").await.unwrap();
    assert_eq!(text(&tags), "- `x`");
}

/// The notes job, a meeting with two documents, the glossary parse and the template choice the
/// UI (Tasks 4 and 5) mirrors. Regenerate with
/// `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
#[tokio::test]
async fn contract_fixtures_match_the_real_meeting_notes() {
    use super::glossary::{parse_glossary, parse_tags, EXAMPLE_GLOSSARY, EXAMPLE_TAGS};
    use super::rules::Rule;
    use super::templates;
    let (runner, gate) = FakeRunner::gated(vec![
        outcome(
            "---\ntitle: Philips CodeMie conversations syncup — 2026-11-04\ntags: [meeting, philips]\n---\n# Philips CodeMie conversations syncup\n\n## TL;DR\n- The demo is ready.\n\n## Action Items\n| Owner | Action | Due | Said at |\n|---|---|---|---|\n| Taylor Morgan | Send the notes | — | [00:20] |",
            json!([{"title": "Send the notes", "owner": "Taylor Morgan", "due": "", "line": 3, "confidence": "high"}]),
        ),
        outcome(
            "# Philips CodeMie conversations syncup\n\n## Summary\nThe weekly sync: the demo is ready.\n\n## Action items\n- Taylor Morgan · Send the notes",
            json!([{"title": "Send the notes", "owner": "Taylor Morgan", "due": "", "line": 3, "confidence": "high"}]),
        ),
    ]);
    let runner = Arc::new(runner);
    let e = env_with(runner.clone());
    choose_claude(&e.core);
    downloaded(&e, "m-ready").await;
    // Each run waits at the gate: the first one is caught while Claude writes.
    let mut running = None;
    for (template, wishes) in [
        ("meeting-notes", "focus on the pilot"),
        ("short-summary", ""),
    ] {
        make_notes(&e, "m-ready", template, json!({"wishes": wishes}))
            .await
            .unwrap();
        let job = e.core.repo().unwrap().claim(now()).unwrap().unwrap();
        let core = e.core.clone();
        let run = tokio::spawn(async move { core.run_claimed_job(job).await });
        gate.started.notified().await;
        if running.is_none() {
            running = notes_jobs(&e.core)
                .into_iter()
                .find(|j| j.state == "running");
        }
        gate.release.notify_one();
        run.await.unwrap();
    }
    let mut job = serde_json::to_value(running.unwrap()).unwrap();
    assert_eq!(job["payload"]["step"], "Writing notes with Meeting notes");
    job["id"] = "job-notes-1".into();
    job["key"] = "meeting_notes:op-1".into();
    job["dueAt"] = 1_795_000_400.into();
    job["leaseUntil"] = 1_795_000_700.into();
    job["payload"]["startedAt"] = 1_795_000_401.into();
    let home = e.core.home.clone().unwrap();
    let pin = |v: Value| -> Value {
        let text = serde_json::to_string(&v)
            .unwrap()
            .replace(&home.to_string_lossy().to_string(), "/Users/taylor");
        serde_json::from_str(&text).unwrap()
    };
    let record = e
        .core
        .repo()
        .unwrap()
        .record(KIND, "m-ready", Some(ACCT), None)
        .unwrap();
    let mut ready = serde_json::to_value(&record).unwrap();
    ready["revision"] = "rev-ready".into();
    ready["updatedAt"] = 1_795_000_900.into();
    ready["data"]["checkedAt"] = 1_795_000_400.into();
    for (i, doc) in ready["data"]["docs"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        doc["createdAt"] = (1_795_000_500 + 60 * i as i64).into();
        doc["updatedAt"] = (1_795_000_500 + 60 * i as i64).into();
    }
    let ready = pin(ready);
    assert_eq!(ready["data"]["state"], "ready");
    assert_eq!(ready["data"]["docs"].as_array().unwrap().len(), 2);
    assert_eq!(ready["data"]["main"], "meeting-notes");

    // The glossary and tag list as Settings › Glossary & tags shows them parsed.
    let glossary = format!("{EXAMPLE_GLOSSARY}- **Jeroen** — heard as “Yeroen”\n");
    let parse = json!({"glossary": glossary, "tags": EXAMPLE_TAGS,
        "expected": {"glossary": parse_glossary(&glossary), "tags": parse_tags(EXAMPLE_TAGS)}});

    // Which template a meeting uses, and whether notes are made by themselves.
    let local = |id: &str, kind: &str, data: Value| Record {
        id: id.into(),
        kind: kind.into(),
        connection_id: None,
        workspace_id: Some("personal".into()),
        source: "local".into(),
        revision: format!("rev-{id}"),
        updated_at: 1_795_000_000,
        data,
    };
    let rule =
        |id: &str, field: &str, value: &str, template: &str, auto: bool, on: bool, order: i64| {
            local(
                id,
                super::rules::KIND,
                serde_json::to_value(Rule {
                    id: String::new(),
                    field: field.into(),
                    value: value.into(),
                    template: template.into(),
                    auto_notes: auto,
                    on,
                    order,
                })
                .unwrap(),
            )
        };
    let records = vec![
        local(
            "client",
            templates::KIND,
            json!({"name": "My client recap", "kind": "custom", "blurb": "", "prompt": "Recap {{title}}", "sections": ["summary"], "extractTasks": true, "color": "#C084FC", "icon": "users", "skillPath": null}),
        ),
        rule("r-off", "title", "Philips", "short-summary", true, false, 0),
        rule(
            "r-standup",
            "title",
            "stand-up",
            "short-summary",
            false,
            true,
            1,
        ),
        rule(
            "r-philips",
            "org",
            "philips",
            "meeting-notes",
            true,
            true,
            2,
        ),
        rule("r-pair", "people", "2", "client", false, true, 3),
        rule(
            "r-boss",
            "organizer",
            "priya",
            "deleted-template",
            false,
            true,
            4,
        ),
    ];
    let settings = MeetingSettings {
        default_template: "client".into(),
        ..Default::default()
    };
    let all = templates::all(&records);
    let rules: Vec<Rule> = records
        .iter()
        .filter_map(super::rules::from_record)
        .collect();
    let person =
        |name: &str, address: &str| json!({"name": name, "address": address, "type": "required"});
    let cases = [
        (
            "chosen for the meeting",
            json!({"title": "Philips stand-up", "attendees": [person("Jeroen de Vries", "jeroen@philips.com")]}),
            json!({"template": "short-summary", "auto": null}),
        ),
        (
            "title rule",
            json!({"title": "Daily stand-up", "attendees": [person("Sam", "sam@epam.com"), person("Ann", "ann@epam.com"), person("Lee", "lee@epam.com")]}),
            Value::Null,
        ),
        (
            "company rule makes notes automatically",
            json!({"title": "Weekly sync", "organizer": person("Jeroen de Vries", "jeroen@philips.com"), "attendees": [person("Taylor Morgan", "taylor@epam.com")]}),
            Value::Null,
        ),
        (
            "the meeting says no",
            json!({"title": "Weekly sync", "attendees": [person("Anouk Bakker", "anouk@philips.com"), person("Taylor Morgan", "taylor@epam.com"), person("Sam", "sam@epam.com")]}),
            json!({"template": null, "auto": false}),
        ),
        (
            "people count",
            json!({"title": "1:1", "organizer": person("Sam", "sam@epam.com"), "attendees": [person("Taylor Morgan", "taylor@epam.com")]}),
            Value::Null,
        ),
        (
            "rule template gone",
            json!({"title": "Budget", "organizer": person("Priya Raman", "priya@epam.com"), "attendees": [person("A", "a@epam.com"), person("B", "b@epam.com")]}),
            Value::Null,
        ),
        (
            "default",
            json!({"title": "Lunch and learn", "attendees": []}),
            json!({"template": null, "auto": true}),
        ),
    ];
    let cases: Vec<Value> = cases
        .into_iter()
        .map(|(name, event, own)| {
            let m = MeetingRecord {
                template: own["template"].as_str().map(String::from),
                auto: own["auto"].as_bool(),
                ..Default::default()
            };
            let (t, why) = templates::resolve(&m, &event, &rules, &settings, &all);
            let (auto, _) = super::rules::auto_notes(m.auto, &event, &rules, &settings);
            let mut expected = why.to_json();
            expected["template"] = t.id.into();
            expected["auto"] = auto.into();
            json!({"name": name, "event": event, "meeting": own, "expected": expected})
        })
        .collect();
    let expected: Vec<(&str, &str)> = cases
        .iter()
        .map(|c| {
            (
                c["expected"]["template"].as_str().unwrap(),
                c["expected"]["why"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        expected,
        vec![
            ("short-summary", "meeting"),
            ("short-summary", "rule"),
            ("meeting-notes", "rule"),
            ("meeting-notes", "rule"),
            ("client", "rule"),
            ("client", "default"),
            ("client", "default"),
        ]
    );
    assert_eq!(cases[2]["expected"]["auto"], true);
    assert_eq!(cases[3]["expected"]["auto"], false);
    assert_eq!(cases[6]["expected"]["auto"], true);
    let rule_cases = json!({"settings": {"meetings": serde_json::to_value(&settings).unwrap()},
        "records": records, "noteTemplates": all, "cases": cases});

    crate::plugins::testkit::contract_fixture("meeting-notes-job.json", &job);
    crate::plugins::testkit::contract_fixture("meeting-ready.json", &ready);
    crate::plugins::testkit::contract_fixture("glossary-parse.json", &parse);
    crate::plugins::testkit::contract_fixture("meeting-rules-cases.json", &rule_cases);
    // `noteTemplates` as a snapshot carries it with no template of the person's own.
    let snapshot = e
        .core
        .request(read(Operation::Snapshot, json!({})))
        .await
        .unwrap();
    assert_eq!(
        snapshot["snapshot"]["noteTemplates"],
        serde_json::to_value(templates::all(&[])).unwrap()
    );
    crate::plugins::testkit::contract_fixture(
        "note-templates.json",
        &snapshot["snapshot"]["noteTemplates"],
    );
}

#[tokio::test]
async fn deleted_tasks_stay_deleted_when_notes_are_made_again() {
    let found = json!([
        {"title": "Send the notes", "owner": "Taylor Morgan", "due": "", "line": 3, "confidence": "high"},
        {"title": "Prepare the demo", "owner": "Marek Novak", "due": "", "line": 1, "confidence": "high"}
    ]);
    // The second run finds the same two, one of them twice.
    let again = json!([
        {"title": "Send the notes", "owner": "Taylor Morgan", "due": "", "line": 3, "confidence": "high"},
        {"title": "Send the notes today", "owner": "Taylor Morgan", "due": "", "line": 3, "confidence": "high"},
        {"title": "Prepare the demo", "owner": "Marek Novak", "due": "", "line": 1, "confidence": "high"}
    ]);
    let n = notes_env(vec![outcome("# Notes", found), outcome("# Summary", again)]);
    let e = &n.e;
    let dir = downloaded(e, "m1").await;
    make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(tasks_of(&e.core, "m1").len(), 2);
    // The demo task was wrong: deleted, its line is remembered on the meeting.
    let wrong = tasks_of(&e.core, "m1")
        .into_iter()
        .find(|t| t.data["line"] == 1)
        .unwrap();
    let deleted = op(&e.core, Operation::TaskDelete, json!({"id": wrong.id}))
        .await
        .unwrap();
    assert_eq!(meeting(&e.core, "m1").removed_lines, vec![1]);
    // Another summary finds the same tasks: nothing comes back, nothing is doubled.
    make_notes(e, "m1", "short-summary", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let left = tasks_of(&e.core, "m1");
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].data["line"], 3);
    let log = text(&dir.join("run.log"));
    assert!(
        log.contains(
            "Tasks: 1 task already on the board, 1 task you deleted before, not added again"
        ),
        "{log}"
    );
    // Undo still brings the deleted task back.
    let mut body = deleted["body"].clone();
    body["id"] = wrong.id.clone().into();
    op(&e.core, Operation::TaskSave, body).await.unwrap();
    let back = tasks_of(&e.core, "m1");
    assert_eq!(back.len(), 2);
    assert_eq!(back[0].data["text"], "Prepare the demo");
}

#[tokio::test]
async fn history_copies_never_overwrite_an_archived_document() {
    let n = notes_env(vec![
        outcome("# A1", json!([])),
        outcome("# A2", json!([])),
        outcome("# A3", json!([])),
    ]);
    let e = &n.e;
    let dir = downloaded(e, "m1").await;
    make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    // Deleted: its text is archived in notes-history/ under the time it was written.
    op(
        &e.core,
        Operation::MeetingDoc,
        json!({"meetingId": "m1", "docId": "meeting-notes", "action": "delete"}),
    )
    .await
    .unwrap();
    // The same template twice more within the same minute: the replaced version gets its own
    // history file next to the archived one.
    for _ in 0..2 {
        make_notes(e, "m1", "meeting-notes", json!({}))
            .await
            .unwrap();
        run_jobs(&e.core).await;
    }
    assert_eq!(text(&dir.join("notes.md")), "# A3");
    let mut history: Vec<String> = std::fs::read_dir(dir.join("notes-history"))
        .unwrap()
        .map(|f| text(&f.unwrap().path()))
        .collect();
    history.sort();
    assert_eq!(history, vec!["# A1", "# A2"]);
    let kept = meeting(&e.core, "m1").docs[0].versions[0]
        .file
        .clone()
        .unwrap();
    assert_eq!(text(&dir.join(kept)), "# A2");
}

/// The texts in `notes-history/`, sorted.
fn history_texts(dir: &Path) -> Vec<String> {
    let mut texts: Vec<String> = std::fs::read_dir(dir.join("notes-history"))
        .map(|entries| entries.map(|f| text(&f.unwrap().path())).collect())
        .unwrap_or_default();
    texts.sort();
    texts
}

#[tokio::test]
async fn notes_never_overwrite_a_document_the_meeting_does_not_know() {
    // Signed out and back in: the folder is reused, the new record knows no documents.
    let n = notes_env(vec![
        outcome("# New notes", json!([])),
        outcome("# New summary", json!([])),
    ]);
    let e = &n.e;
    let dir = downloaded(e, "m1").await;
    std::fs::write(dir.join("notes.md"), "# My notes, edited by hand").unwrap();
    std::fs::write(dir.join("notes.short-summary.md"), "# My old summary").unwrap();
    assert!(meeting(&e.core, "m1").docs.is_empty());
    make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    let ran = run_jobs(&e.core).await;
    assert_eq!(ran[0].state, "succeeded", "{ran:?}");
    assert_eq!(text(&dir.join("notes.md")), "# New notes");
    assert_eq!(history_texts(&dir), vec!["# My notes, edited by hand"]);
    let log = text(&dir.join("run.log"));
    assert!(
        log.contains("notes.md was already in the folder: kept as notes-history/"),
        "{log}"
    );
    // A second template's file, unique among the meeting's documents but already on disk.
    make_notes(e, "m1", "short-summary", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(text(&dir.join("notes.short-summary.md")), "# New summary");
    assert_eq!(
        history_texts(&dir),
        vec!["# My notes, edited by hand", "# My old summary"]
    );
}

#[tokio::test]
async fn choosing_the_main_document_never_overwrites_an_unknown_file_and_rolls_back() {
    let n = notes_env(vec![outcome("# A", json!([])), outcome("# B", json!([]))]);
    let e = &n.e;
    let dir = downloaded(e, "m1").await;
    for template in ["meeting-notes", "short-summary"] {
        make_notes(e, "m1", template, json!({})).await.unwrap();
        run_jobs(&e.core).await;
    }
    let main = |id: &str| {
        op(
            &e.core,
            Operation::MeetingDoc,
            json!({"meetingId": "m1", "action": "main", "docId": id}),
        )
    };
    // The old main document can't be renamed (a folder has its name): nothing changes, and no
    // hidden swap file is left behind.
    std::fs::create_dir(dir.join("notes.meeting-notes.md")).unwrap();
    let failed = main("short-summary").await.unwrap_err();
    assert_eq!(failed.code, "folder_unwritable", "{failed:?}");
    assert!(!dir.join(".notes.md.swap").exists());
    assert_eq!(text(&dir.join("notes.md")), "# A");
    assert_eq!(text(&dir.join("notes.short-summary.md")), "# B");
    assert_eq!(
        meeting(&e.core, "m1").main.as_deref(),
        Some("meeting-notes")
    );
    // A file the meeting doesn't know has that name: it is kept in notes-history/ first.
    std::fs::remove_dir(dir.join("notes.meeting-notes.md")).unwrap();
    std::fs::write(dir.join("notes.meeting-notes.md"), "# Mine").unwrap();
    main("short-summary").await.unwrap();
    assert_eq!(text(&dir.join("notes.md")), "# B");
    assert_eq!(text(&dir.join("notes.meeting-notes.md")), "# A");
    assert_eq!(history_texts(&dir), vec!["# Mine"]);
    assert!(!dir.join(".notes.md.swap").exists());
}

#[tokio::test]
async fn a_failure_after_the_document_is_written_says_so() {
    let n = notes_env(vec![
        outcome("# Old", json!([])),
        outcome("# New", json!([])),
    ]);
    let e = &n.e;
    let dir = downloaded(e, "m1").await;
    make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    make_notes(e, "m1", "meeting-notes", json!({}))
        .await
        .unwrap();
    // The data folder goes read-only right after notes.md is written.
    super::notes_job::FAIL_AFTER_WRITE.with(|f| f.set(true));
    let job = e.core.repo().unwrap().claim(now()).unwrap().unwrap();
    e.core.clone().run_claimed_job(job).await;
    assert_eq!(text(&dir.join("notes.md")), "# New");
    let log = text(&dir.join("run.log"));
    let last = log.trim_end().rsplit("\n\n").next().unwrap();
    assert!(last.contains("Meeting notes · failed"), "{log}");
    assert!(
        last.contains("notes.md has the new notes, but Connect couldn’t record them."),
        "{last}"
    );
    assert!(!last.contains("not changed"), "{last}");
    // The record still names version 1: making notes again sets it right.
    assert_eq!(meeting(&e.core, "m1").docs[0].version, 1);
}
