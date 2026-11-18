//! Job and operation tests for meetings: a real `Core` over a temp folder, Graph answered by
//! `FakeGraph`, files in the temp folder's home.
use super::model::*;
use super::transcripts::{content_url, list_url, lookup_url};
use super::*;
use crate::ai::fake::FakeRunner;
use crate::workspace::ai::tests::{mutation, ready};
use crate::workspace::ai_jobs::FakeGraph;
use crate::workspace::{graph, models::*};
use crate::workspace::{test_core_with_graph, Core};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const ACCT: &str = "7f1c2a4e-0000-4000-8000-000000000001";
const JOIN: &str =
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%7d";
const ONLINE: &str = "MSo1N2Y5ZGFj";
const SYNC: &str = "Philips CodeMie conversations syncup";
/// 16:00 in Kyiv (UTC+2 in November).
const START: &str = "2026-11-04T14:00:00Z";
const END: &str = "2026-11-04T14:30:00Z";
/// Teams started transcribing at 16:04:26 Kyiv time.
const CREATED: &str = "2026-11-04T14:04:26Z";

const VTT: &str = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Jeroen de Vries>Welcome to the sync.</v>\n\n00:00:05.000 --> 00:00:09.000\n<v Novak, Marek>Thanks. The demo is ready.</v>\n\n00:00:12.000 --> 00:00:15.000\n<v @1>Can I join late?</v>\n\n00:00:20.000 --> 00:00:24.000\n<v Taylor Morgan>I&#39;ll send the notes.</v>\n";

struct Env {
    _dir: tempfile::TempDir,
    core: Arc<Core>,
    graph: Arc<FakeGraph>,
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let graph = Arc::new(FakeGraph::default());
    let core = test_core_with_graph(
        dir.path(),
        Arc::new(FakeRunner::new(vec![])),
        ready(),
        graph.clone(),
    );
    connect(&core, &["calendar", "meetings", "transcripts"]);
    Env {
        _dir: dir,
        core,
        graph,
    }
}

/// The signed-in account (Taylor Morgan) with `enabled` capabilities, bound to `personal`.
fn connect(core: &Core, enabled: &[&str]) {
    let mut r = core.repo().unwrap();
    let c = Connection {
        id: ACCT.into(),
        account_key: ACCT.into(),
        display_name: "Taylor Morgan".into(),
        email: "taylor@example.test".into(),
        user_id: "me-1".into(),
        generation: 1,
        policy_revision: 1,
        scopes: vec![
            "Calendars.Read".into(),
            "OnlineMeetings.Read".into(),
            "OnlineMeetingTranscript.Read.All".into(),
        ],
        enabled: enabled.iter().map(|s| s.to_string()).collect(),
        status: "connected".into(),
        ..Default::default()
    };
    r.save_connection(&c).unwrap();
    let mut s = r.settings().unwrap();
    s.active_connection = Some(ACCT.into());
    s.time_zone = "Europe/Kyiv".into();
    r.settings_update(&s).unwrap();
    let mut w = r.workspace("personal").unwrap();
    w.connection_id = Some(ACCT.into());
    w.sources = json!({"all": true});
    r.save_workspace(&w).unwrap();
}

fn rfc(at: i64) -> String {
    chrono::DateTime::from_timestamp(at, 0)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

/// A Teams meeting from `start` to `end` (RFC 3339), as `graph::normalize_event` stores it.
fn event(id: &str, title: &str, start: &str, end: &str, extra: Value) -> Record {
    let mut data = json!({"title": title, "start": start, "end": end, "allDay": false,
    "cancelled": false, "isOnlineMeeting": true, "joinUrl": JOIN, "response": "accepted",
    "isOrganizer": false, "seriesId": "series-1", "calendarId": "cal-1",
    "organizer": {"name": "Jeroen de Vries", "address": "jeroen@example.test"},
    "attendees": [
        {"name": "Marek Novak", "address": "marek.novak@example.test", "type": "required", "response": "accepted"},
        {"name": "Taylor Morgan", "address": "taylor@example.test", "type": "required", "response": "accepted"}
    ]});
    for (k, v) in extra.as_object().unwrap() {
        data[k] = v.clone();
    }
    Record {
        id: id.into(),
        kind: "event".into(),
        connection_id: Some(ACCT.into()),
        workspace_id: None,
        source: "calendar:cal-1".into(),
        revision: "v1".into(),
        updated_at: now(),
        data,
    }
}

/// A meeting that ended `minutes` ago, half an hour long.
fn ended(id: &str, minutes: i64, extra: Value) -> Record {
    let end = now() - minutes * 60;
    event(id, SYNC, &rfc(end - 1800), &rfc(end), extra)
}

fn put(core: &Core, record: Record) {
    core.repo().unwrap().put_record(&record).unwrap();
}

/// Teams answers for one meeting: the lookup, a transcript created at `created`, its content.
fn teams(graph: &FakeGraph, created: &str, vtt: &str) {
    graph.answer(
        &lookup_url(JOIN),
        json!({"value": [{"id": ONLINE, "joinWebUrl": JOIN}]}),
    );
    graph.answer(
        &list_url(ONLINE),
        json!({"value": [{"id": "t1", "createdDateTime": created}]}),
    );
    graph.answer_text(&content_url(ONLINE, "t1"), vtt);
}

fn store_for_test(core: &Core, id: &str, m: &MeetingRecord) {
    put(
        core,
        Record {
            id: id.into(),
            kind: KIND.into(),
            connection_id: Some(ACCT.into()),
            workspace_id: None,
            source: "calendar:cal-1".into(),
            revision: "r".into(),
            updated_at: now(),
            data: serde_json::to_value(m).unwrap(),
        },
    );
}

fn meeting(core: &Core, id: &str) -> MeetingRecord {
    let record = core
        .repo()
        .unwrap()
        .record(KIND, id, Some(ACCT), None)
        .unwrap();
    serde_json::from_value(record.data).unwrap()
}

fn jobs(core: &Core, kind: &str) -> Vec<Job> {
    core.repo()
        .unwrap()
        .jobs()
        .unwrap()
        .into_iter()
        .filter(|j| j.kind == kind)
        .collect()
}

fn job_by_id(core: &Core, id: &str) -> Job {
    core.repo()
        .unwrap()
        .jobs()
        .unwrap()
        .into_iter()
        .find(|j| j.id == id)
        .unwrap()
}

/// Claims and runs every due job, one at a time, as the background loop does, with the clock
/// `ahead` seconds in the future (a later slot). The clock is read for every claim: a job queued
/// by the previous one may be due a second later.
async fn run_jobs_ahead(core: &Arc<Core>, ahead: i64) -> Vec<Job> {
    let mut ran = Vec::new();
    loop {
        let job = core.repo().unwrap().claim(now() + ahead).unwrap();
        let Some(job) = job else { break };
        let id = job.id.clone();
        core.clone().run_claimed_job(job).await;
        ran.push(job_by_id(core, &id));
    }
    ran
}

async fn run_jobs(core: &Arc<Core>) -> Vec<Job> {
    run_jobs_ahead(core, 0).await
}

fn read(op: Operation, data: Value) -> Request {
    Request {
        op,
        workspace_id: Some("personal".into()),
        expected_revision: None,
        operation_id: None,
        data,
    }
}

async fn op(core: &Arc<Core>, op: Operation, data: Value) -> Result<Value> {
    core.request(mutation(core, op, data)).await
}

fn slot(at: i64) -> i64 {
    at / 600
}

fn default_root(core: &Core) -> PathBuf {
    core.home
        .clone()
        .unwrap()
        .join("CodeMie Connect")
        .join("Meetings")
}

fn folder_of(core: &Core, id: &str) -> PathBuf {
    let m = meeting(core, id);
    let Some(folder) = m.folder.clone() else {
        let jobs = core.repo().unwrap().jobs().unwrap();
        panic!("{id} has no folder: {m:?}\njobs: {jobs:#?}");
    };
    PathBuf::from(folder)
}

const FILES: [&str; 5] = [
    "transcript.vtt",
    "transcript.md",
    "segments.json",
    "meeting.json",
    "meta.json",
];

#[tokio::test]
async fn round_queues_checks_only_for_ended_online_meetings() {
    let e = env();
    put(&e.core, ended("due", 15, json!({})));
    put(
        &e.core,
        ended("declined", 15, json!({"response": "declined"})),
    );
    put(&e.core, ended("cancelled", 15, json!({"cancelled": true})));
    put(&e.core, ended("all-day", 15, json!({"allDay": true})));
    put(&e.core, ended("no-link", 15, json!({"joinUrl": null})));
    put(
        &e.core,
        ended(
            "not-online",
            15,
            json!({"isOnlineMeeting": false, "joinUrl": null}),
        ),
    );
    put(&e.core, ended("just-ended", 9, json!({})));
    put(&e.core, ended("yesterday", 25 * 60, json!({})));
    put(
        &e.core,
        event(
            "later",
            SYNC,
            &rfc(now() + 600),
            &rfc(now() + 2400),
            json!({}),
        ),
    );
    let at = now();
    meetings_round_at(&e.core, at).unwrap();
    let checks = jobs(&e.core, "transcript_check");
    assert_eq!(checks.len(), 1, "{checks:?}");
    assert_eq!(checks[0].key, format!("transcript_check:due:{}", slot(at)));
    assert_eq!(checks[0].payload["meetingId"], "due");
    assert_eq!(checks[0].workspace_id.as_deref(), Some("personal"));
    assert_eq!(checks[0].connection_id.as_deref(), Some(ACCT));
    // The same slot, or a check still waiting, never queues a second one; ten minutes on,
    // the meeting that had just ended is due too.
    meetings_round_at(&e.core, at).unwrap();
    meetings_round_at(&e.core, at + 600).unwrap();
    let checks = jobs(&e.core, "transcript_check");
    let ids: Vec<&str> = checks
        .iter()
        .map(|j| j.payload["meetingId"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "{ids:?}");
    assert!(
        ids.contains(&"due") && ids.contains(&"just-ended"),
        "{ids:?}"
    );
    // A meeting whose transcript was already found is not checked again.
    put(&e.core, ended("found", 15, json!({})));
    let mut found = MeetingRecord {
        event_id: "found".into(),
        state: MeetingState::Available,
        ..Default::default()
    };
    found.title = SYNC.into();
    store_for_test(&e.core, "found", &found);
    meetings_round_at(&e.core, at).unwrap();
    assert!(jobs(&e.core, "transcript_check")
        .iter()
        .all(|j| j.payload["meetingId"] != "found"));
    // At most 25 checks a round; the rest follow in the next round.
    for i in 0..30 {
        put(&e.core, ended(&format!("many-{i}"), 20 + i, json!({})));
    }
    meetings_round_at(&e.core, at).unwrap();
    assert_eq!(jobs(&e.core, "transcript_check").len(), 2 + 25);
    meetings_round_at(&e.core, at).unwrap();
    assert_eq!(jobs(&e.core, "transcript_check").len(), 2 + 30);
}

#[tokio::test]
async fn check_finds_a_transcript_and_saves_it() {
    let e = env();
    let record = ended("m1", 15, json!({}));
    let created = rfc(graph::timestamp(record.data["start"].as_str().unwrap()) + 60);
    put(&e.core, record);
    teams(&e.graph, &created, VTT);
    let at = now();
    meetings_round_at(&e.core, at).unwrap();
    let check = run_jobs(&e.core).await;
    assert_eq!(check[0].kind, "transcript_check");
    assert_eq!(check[0].state, "succeeded", "{:?}", check[0].result);
    // The check found it and queued the save at once; the save ran in the same pass.
    let saves = jobs(&e.core, "transcript_download");
    assert_eq!(saves.len(), 1);
    assert!(
        saves[0].key.starts_with("transcript_download:auto:m1:"),
        "{}",
        saves[0].key
    );
    assert_eq!(saves[0].payload["auto"], true);
    assert_eq!(saves[0].state, "succeeded", "{:?}", saves[0].result);
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Downloaded);
    assert_eq!(m.transcript_ids, vec!["t1".to_string()]);
    assert_eq!(m.external.as_deref(), Some(ONLINE));
    assert_eq!(m.transcript_start.as_deref(), Some(created.as_str()));
    assert!(m.checked_at.is_some() && m.error.is_none() && m.last_error.is_none());
    let folder = PathBuf::from(m.folder.unwrap());
    assert!(
        folder.starts_with(default_root(&e.core)),
        "the default root was made"
    );
    assert!(folder.join("transcript.md").is_file());
    // Nothing else to do.
    meetings_round_at(&e.core, at + 600).unwrap();
    assert_eq!(jobs(&e.core, "transcript_download").len(), 1);
    assert_eq!(jobs(&e.core, "transcript_check").len(), 1);
}

#[tokio::test]
async fn check_on_403_marks_blocked_with_the_reason() {
    let e = env();
    put(&e.core, ended("m1", 15, json!({})));
    e.graph
        .answer(&lookup_url(JOIN), json!({"value": [{"id": ONLINE}]}));
    e.graph.fail(
        &list_url(ONLINE),
        WorkspaceError::new(
            "permission_required",
            "Forbidden: GraphAccessToTranscriptsDisabled: transcripts are turned off for this organization.",
        ),
    );
    meetings_round_at(&e.core, now()).unwrap();
    let ran = run_jobs(&e.core).await;
    assert_eq!(ran.len(), 1, "nothing to save");
    assert_eq!(ran[0].state, "succeeded");
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Blocked);
    let error = m.error.unwrap();
    assert_eq!(error.code, "transcript_blocked");
    assert!(error.message.contains("GraphAccessToTranscriptsDisabled"));
    // A blocked meeting is not checked again by the round.
    meetings_round_at(&e.core, now() + 600).unwrap();
    assert_eq!(jobs(&e.core, "transcript_check").len(), 1);
    // A lookup that finds no meeting (another organization's) is blocked too.
    put(
        &e.core,
        ended(
            "m2",
            15,
            json!({"joinUrl": "https://teams.microsoft.com/l/other"}),
        ),
    );
    e.graph.answer(
        &lookup_url("https://teams.microsoft.com/l/other"),
        json!({"value": []}),
    );
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m2"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let m2 = meeting(&e.core, "m2");
    assert_eq!(m2.state, MeetingState::Blocked);
    assert_eq!(m2.error.unwrap().code, "transcript_blocked");
}

#[tokio::test]
async fn check_without_transcripts_is_pending_then_none_after_a_day() {
    let e = env();
    put(&e.core, ended("m1", 15, json!({})));
    e.graph
        .answer(&lookup_url(JOIN), json!({"value": [{"id": ONLINE}]}));
    e.graph.answer(&list_url(ONLINE), json!({"value": []}));
    let at = now();
    meetings_round_at(&e.core, at).unwrap();
    run_jobs(&e.core).await;
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Pending);
    assert!(m.checked_at.is_some());
    // Every slot checks again while the day lasts.
    meetings_round_at(&e.core, at + 600).unwrap();
    assert_eq!(jobs(&e.core, "transcript_check").len(), 2);
    run_jobs_ahead(&e.core, 600).await;
    // A day after the end the round gives up without asking Teams again.
    meetings_round_at(&e.core, at + 25 * 3600).unwrap();
    assert_eq!(meeting(&e.core, "m1").state, MeetingState::None);
    assert_eq!(jobs(&e.core, "transcript_check").len(), 2);
    // A check of an old meeting with no transcript says so too.
    put(&e.core, ended("old", 3 * 24 * 60, json!({})));
    op(
        &e.core,
        Operation::MeetingCheck,
        json!({"meetingId": "old"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(meeting(&e.core, "old").state, MeetingState::None);
    // A check that did not get through keeps the meeting waiting, with the reason.
    put(
        &e.core,
        ended(
            "offline",
            15,
            json!({"joinUrl": "https://teams.microsoft.com/l/offline"}),
        ),
    );
    op(
        &e.core,
        Operation::MeetingCheck,
        json!({"meetingId": "offline"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    let offline = meeting(&e.core, "offline");
    assert_eq!(offline.state, MeetingState::Pending);
    assert_eq!(offline.error.unwrap().code, "offline");
}

#[tokio::test]
async fn checks_need_the_transcripts_capability() {
    for enabled in [
        &["calendar", "meetings"][..],
        &["calendar", "transcripts"][..],
        &["calendar"][..],
    ] {
        let e = env();
        connect(&e.core, enabled);
        put(&e.core, ended("m1", 15, json!({})));
        meetings_round_at(&e.core, now()).unwrap();
        assert!(jobs(&e.core, "transcript_check").is_empty(), "{enabled:?}");
        let error = op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m1"}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "permission_required", "{enabled:?}");
        let error = op(
            &e.core,
            Operation::MeetingDownload,
            json!({"meetingId": "m1"}),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "permission_required", "{enabled:?}");
    }
    // Enabled but not granted by Microsoft.
    let e = env();
    {
        let mut r = e.core.repo().unwrap();
        let mut c = r.connection(ACCT).unwrap();
        c.scopes = vec!["Calendars.Read".into(), "OnlineMeetings.Read".into()];
        r.save_connection(&c).unwrap();
    }
    put(&e.core, ended("m1", 15, json!({})));
    meetings_round_at(&e.core, now()).unwrap();
    assert!(jobs(&e.core, "transcript_check").is_empty());
}

#[tokio::test]
async fn download_writes_the_echo_folder() {
    let e = env();
    put(&e.core, event("m1", SYNC, START, END, json!({})));
    teams(&e.graph, CREATED, VTT);
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m1"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Downloaded);
    let folder = PathBuf::from(m.folder.unwrap());
    assert_eq!(
        folder,
        default_root(&e.core).join("2026-11-04_160426-philips-codemie-conversations-syncup")
    );
    for name in FILES {
        assert!(folder.join(name).is_file(), "{name}");
    }
    assert_eq!(
        std::fs::read_to_string(folder.join("transcript.vtt")).unwrap(),
        VTT
    );
    let md = std::fs::read_to_string(folder.join("transcript.md")).unwrap();
    assert!(md.starts_with(&format!("# {SYNC}\n\n")), "{md}");
    assert!(
        md.contains("**Jeroen de Vries** [00:00:01]\nWelcome to the sync."),
        "{md}"
    );
    assert!(md.contains("**Marek Novak** [00:00:05]"), "{md}");
    assert!(md.contains("**Speaker 1** [00:00:12]"), "{md}");
    assert!(
        md.contains("**Taylor Morgan** [00:00:20]\nI'll send the notes."),
        "{md}"
    );
    let segments: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(folder.join("segments.json")).unwrap())
            .unwrap();
    assert_eq!(segments.len(), 4);
    assert_eq!(segments[1]["voice"], "Novak, Marek");
    assert_eq!(segments[1]["address"], "marek.novak@example.test");
    assert_eq!(segments[3]["speaker"], "me");
    let meeting_json: Value =
        serde_json::from_str(&std::fs::read_to_string(folder.join("meeting.json")).unwrap())
            .unwrap();
    assert_eq!(meeting_json["event_id"], "m1");
    assert_eq!(meeting_json["subject"], SYNC);
    assert_eq!(meeting_json["join_url"], JOIN);
    assert_eq!(meeting_json["series_id"], "series-1");
    assert_eq!(meeting_json["organizer"]["address"], "jeroen@example.test");
    assert_eq!(meeting_json["attendees"].as_array().unwrap().len(), 2);
    assert_eq!(meeting_json["source"], "teams");
    let meta: Value =
        serde_json::from_str(&std::fs::read_to_string(folder.join("meta.json")).unwrap()).unwrap();
    assert_eq!(meta["source"], "teams");
    assert_eq!(meta["started_at"], CREATED);
    assert_eq!(meta["ended_at"], END);
    assert_eq!(meta["transcript_ids"], json!(["t1"]));
    // Without "Keep original .vtt" the folder has no transcript.vtt.
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"keepVtt": false, "folderPattern": "date-title"}}),
    )
    .await
    .unwrap();
    put(
        &e.core,
        event("m2", "Daily stand-up", START, END, json!({})),
    );
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m2"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let second = folder_of(&e.core, "m2");
    assert_eq!(
        second,
        default_root(&e.core).join("2026-11-04-daily-stand-up")
    );
    assert!(!second.join("transcript.vtt").exists());
    assert!(second.join("segments.json").is_file());
}

#[tokio::test]
async fn download_into_unwritable_root_fails_cleanly() {
    let e = env();
    let chosen = e.core.paths.data.join("Chosen");
    std::fs::create_dir(&chosen).unwrap();
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"root": chosen.to_string_lossy()}}),
    )
    .await
    .unwrap();
    // The folder is renamed after it was chosen.
    let renamed = e.core.paths.data.join("Renamed");
    std::fs::rename(&chosen, &renamed).unwrap();
    let record = ended("m1", 15, json!({}));
    let created = rfc(graph::timestamp(record.data["start"].as_str().unwrap()) + 60);
    put(&e.core, record);
    teams(&e.graph, &created, VTT);
    let at = now();
    meetings_round_at(&e.core, at).unwrap();
    let ran = run_jobs(&e.core).await;
    let save = ran
        .iter()
        .find(|j| j.kind == "transcript_download")
        .unwrap();
    assert_eq!(save.state, "failed");
    assert_eq!(save.error_code.as_deref(), Some("folder_unwritable"));
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Available);
    assert_eq!(m.last_error.as_ref().unwrap().code, "folder_unwritable");
    assert!(m.folder.is_none());
    assert!(!chosen.exists(), "a custom root is never created");
    // It waits for the person: no automatic retry in later slots.
    meetings_round_at(&e.core, at + 600).unwrap();
    meetings_round_at(&e.core, at + 1200).unwrap();
    assert_eq!(jobs(&e.core, "transcript_download").len(), 1);
    // The folder is back: Try again works.
    std::fs::rename(&renamed, &chosen).unwrap();
    let queued = op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m1"}),
    )
    .await
    .unwrap();
    assert_eq!(queued["queued"], true);
    run_jobs(&e.core).await;
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Downloaded);
    assert!(m.last_error.is_none());
    assert!(PathBuf::from(m.folder.unwrap()).starts_with(&chosen));
}

#[tokio::test]
async fn import_writes_imported_vtt_and_marks_downloaded() {
    let e = env();
    put(&e.core, event("m1", SYNC, START, END, json!({})));
    let saved = op(
        &e.core,
        Operation::MeetingImport,
        json!({"meetingId": "m1", "fileName": "Weekly sync.vtt", "text": VTT}),
    )
    .await
    .unwrap();
    assert_eq!(saved["saved"], true);
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Downloaded);
    assert_eq!(m.imported.as_deref(), Some("Weekly sync.vtt"));
    let folder = PathBuf::from(m.folder.unwrap());
    // The event's own start: no transcript said when transcribing began.
    assert_eq!(
        folder.file_name().unwrap().to_string_lossy(),
        "2026-11-04_160000-philips-codemie-conversations-syncup"
    );
    assert_eq!(
        std::fs::read_to_string(folder.join("imported.vtt")).unwrap(),
        VTT
    );
    assert!(!folder.join("transcript.vtt").exists());
    for name in [
        "transcript.md",
        "segments.json",
        "meeting.json",
        "meta.json",
    ] {
        assert!(folder.join(name).is_file(), "{name}");
    }
    let meta: Value =
        serde_json::from_str(&std::fs::read_to_string(folder.join("meta.json")).unwrap()).unwrap();
    assert_eq!(meta["source"], "import");
    assert_eq!(meta["imported_from"], "Weekly sync.vtt");
    // A plain-text transcript, on a meeting that is not online: same folder for the same event.
    put(
        &e.core,
        event(
            "m2",
            "Offsite",
            START,
            END,
            json!({"isOnlineMeeting": false, "joinUrl": null}),
        ),
    );
    op(
        &e.core,
        Operation::MeetingImport,
        json!({"meetingId": "m2", "fileName": "C:\\fakepath\\notes.TXT", "text": "Jeroen de Vries: Hello\nTaylor Morgan: Hi\n"}),
    )
    .await
    .unwrap();
    let m2 = meeting(&e.core, "m2");
    assert_eq!(m2.state, MeetingState::Downloaded);
    assert_eq!(
        m2.imported.as_deref(),
        Some("notes.TXT"),
        "only the file's own name"
    );
    let folder2 = PathBuf::from(m2.folder.unwrap());
    assert!(folder2.join("imported.txt").is_file());
    let segments: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(folder2.join("segments.json")).unwrap())
            .unwrap();
    assert_eq!(segments[1]["speaker"], "me");
    let again = op(
        &e.core,
        Operation::MeetingImport,
        json!({"meetingId": "m2", "fileName": "notes.txt", "text": "Jeroen de Vries: Second\n"}),
    )
    .await
    .unwrap();
    assert_eq!(again["saved"], true);
    assert_eq!(
        folder_of(&e.core, "m2"),
        folder2,
        "importing again reuses the folder"
    );
    // Refused: too large, nothing a speaker said, a file type Connect doesn't read.
    let big = format!("WEBVTT\n\n{}", "x".repeat(5 * 1024 * 1024));
    for (data, code) in [
        (
            json!({"meetingId": "m1", "fileName": "big.vtt", "text": big}),
            "too_large",
        ),
        (
            json!({"meetingId": "m1", "fileName": "prose.txt", "text": "Just prose.\nNo speakers."}),
            "validation",
        ),
        (
            json!({"meetingId": "m1", "fileName": "empty.vtt", "text": "WEBVTT\n"}),
            "validation",
        ),
        (
            json!({"meetingId": "m1", "fileName": "minutes.docx", "text": "Jeroen: hi"}),
            "validation",
        ),
        (
            json!({"meetingId": "missing", "fileName": "a.vtt", "text": VTT}),
            "not_found",
        ),
    ] {
        let error = op(&e.core, Operation::MeetingImport, data.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code, code, "{}", data["fileName"]);
    }
    assert_eq!(
        meeting(&e.core, "m1").imported.as_deref(),
        Some("Weekly sync.vtt")
    );
}

#[tokio::test]
async fn speakers_mapping_rewrites_segments_and_transcript_md() {
    let e = env();
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"keepVtt": false}}),
    )
    .await
    .unwrap();
    put(&e.core, event("m1", SYNC, START, END, json!({})));
    teams(&e.graph, CREATED, VTT);
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m1"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let folder = folder_of(&e.core, "m1");
    assert!(!folder.join("transcript.vtt").exists());
    let segments = |folder: &Path| -> Vec<Value> {
        serde_json::from_str(&std::fs::read_to_string(folder.join("segments.json")).unwrap())
            .unwrap()
    };
    let md = |folder: &Path| std::fs::read_to_string(folder.join("transcript.md")).unwrap();
    // "@1" was Marek; the mapping is by the voice the transcript wrote.
    op(
        &e.core,
        Operation::MeetingSpeakers,
        json!({"meetingId": "m1", "voice": "@1", "address": "marek.novak@example.test"}),
    )
    .await
    .unwrap();
    assert_eq!(segments(&folder)[2]["name"], "Marek Novak");
    assert_eq!(segments(&folder)[2]["address"], "marek.novak@example.test");
    assert_eq!(segments(&folder)[2]["voice"], "@1");
    assert!(
        md(&folder).contains("**Marek Novak** [00:00:12]"),
        "{}",
        md(&folder)
    );
    assert!(!md(&folder).contains("Speaker 1"));
    // A second mapping keeps the first.
    op(
        &e.core,
        Operation::MeetingSpeakers,
        json!({"meetingId": "m1", "voice": "Novak, Marek", "address": "taylor@example.test"}),
    )
    .await
    .unwrap();
    let after = segments(&folder);
    assert_eq!(after[1]["name"], "Taylor Morgan");
    assert_eq!(after[1]["speaker"], "me");
    assert_eq!(after[2]["name"], "Marek Novak");
    let m = meeting(&e.core, "m1");
    assert_eq!(
        m.speakers.get("@1").map(String::as_str),
        Some("marek.novak@example.test")
    );
    assert_eq!(m.speakers.len(), 2);
    // Clearing a mapping matches the voice again.
    op(
        &e.core,
        Operation::MeetingSpeakers,
        json!({"meetingId": "m1", "voice": "Novak, Marek", "address": ""}),
    )
    .await
    .unwrap();
    assert_eq!(segments(&folder)[1]["name"], "Marek Novak");
    assert_eq!(segments(&folder)[1]["speaker"], "remote");
    // Download again keeps the mapping.
    op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m1"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(segments(&folder)[2]["name"], "Marek Novak");
    // Refused: someone who was not at the meeting, a voice the transcript doesn't have.
    for (data, code) in [
        (
            json!({"meetingId": "m1", "voice": "@1", "address": "stranger@example.test"}),
            "validation",
        ),
        (
            json!({"meetingId": "m1", "voice": "@9", "address": "marek.novak@example.test"}),
            "validation",
        ),
    ] {
        let error = op(&e.core, Operation::MeetingSpeakers, data)
            .await
            .unwrap_err();
        assert_eq!(error.code, code);
    }
    std::fs::remove_dir_all(&folder).unwrap();
    let error = op(
        &e.core,
        Operation::MeetingSpeakers,
        json!({"meetingId": "m1", "voice": "@1", "address": "marek.novak@example.test"}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "folder_missing");
}

#[tokio::test]
async fn download_again_after_success_queues_again() {
    let e = env();
    put(&e.core, event("m1", SYNC, START, END, json!({})));
    teams(&e.graph, CREATED, VTT);
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m1"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let folder = folder_of(&e.core, "m1");
    std::fs::write(folder.join("notes.md"), "my notes").unwrap();
    // Teams updated the transcript.
    let updated = VTT.replace("Welcome to the sync.", "Welcome, everyone.");
    e.graph.answer_text(&content_url(ONLINE, "t1"), &updated);
    let first = op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m1"}),
    )
    .await
    .unwrap();
    // Asked twice while it waits: one job.
    let same = op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m1"}),
    )
    .await
    .unwrap();
    assert_eq!(first["jobId"], same["jobId"]);
    run_jobs(&e.core).await;
    assert_eq!(
        job_by_id(&e.core, first["jobId"].as_str().unwrap()).state,
        "succeeded"
    );
    assert!(std::fs::read_to_string(folder.join("transcript.md"))
        .unwrap()
        .contains("Welcome, everyone."));
    assert_eq!(
        std::fs::read_to_string(folder.join("notes.md")).unwrap(),
        "my notes"
    );
    assert_eq!(folder_of(&e.core, "m1"), folder, "the same folder, no -2");
    // After it succeeded, asking again really runs again.
    let again = op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m1"}),
    )
    .await
    .unwrap();
    assert_ne!(again["jobId"], first["jobId"]);
    let ran = run_jobs(&e.core).await;
    assert_eq!(ran.len(), 1);
    assert_eq!(ran[0].state, "succeeded");
    // The folder was deleted: Download again makes it anew.
    std::fs::remove_dir_all(&folder).unwrap();
    op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m1"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    assert!(folder_of(&e.core, "m1").join("transcript.md").is_file());
    // Nothing found in Teams yet: nothing to download.
    put(&e.core, ended("waiting", 15, json!({})));
    let error = op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "waiting"}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "transcript_missing");
}

#[tokio::test]
async fn read_returns_segments_files_and_folder_missing() {
    let e = env();
    put(&e.core, event("m1", SYNC, START, END, json!({})));
    teams(&e.graph, CREATED, VTT);
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m1"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let revision = e.core.repo().unwrap().revision().unwrap();
    let transcript = e
        .core
        .request(read(
            Operation::MeetingRead,
            json!({"meetingId": "m1", "part": "transcript"}),
        ))
        .await
        .unwrap();
    assert_eq!(transcript["segments"].as_array().unwrap().len(), 4);
    assert_eq!(transcript["segments"][0]["name"], "Jeroen de Vries");
    let files = e
        .core
        .request(read(
            Operation::MeetingRead,
            json!({"meetingId": "m1", "part": "files"}),
        ))
        .await
        .unwrap();
    let names: Vec<&str> = files["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![
            "meeting.json",
            "meta.json",
            "segments.json",
            "transcript.md",
            "transcript.vtt"
        ]
    );
    assert!(files["files"][0]["size"].as_u64().unwrap() > 0);
    assert!(files["files"][0]["modified"].as_i64().unwrap() > 0);
    let text = e
        .core
        .request(read(
            Operation::MeetingRead,
            json!({"meetingId": "m1", "part": "file", "name": "transcript.md"}),
        ))
        .await
        .unwrap();
    assert!(text["text"].as_str().unwrap().starts_with("# Philips"));
    assert_eq!(
        e.core.repo().unwrap().revision().unwrap(),
        revision,
        "reads change nothing"
    );
    for (data, code) in [
        (
            json!({"meetingId": "m1", "part": "file", "name": "../meeting.json"}),
            "validation",
        ),
        (
            json!({"meetingId": "m1", "part": "file", "name": "/etc/hosts"}),
            "validation",
        ),
        (
            json!({"meetingId": "m1", "part": "file", "name": ".hidden"}),
            "validation",
        ),
        (
            json!({"meetingId": "m1", "part": "file", "name": "missing.md"}),
            "not_found",
        ),
        (json!({"meetingId": "m1", "part": "doc"}), "validation"),
        (json!({"meetingId": "nope", "part": "files"}), "not_found"),
    ] {
        let error = e
            .core
            .request(read(Operation::MeetingRead, data.clone()))
            .await
            .unwrap_err();
        assert_eq!(error.code, code, "{data}");
    }
    std::fs::remove_dir_all(folder_of(&e.core, "m1")).unwrap();
    for part in ["transcript", "files"] {
        let error = e
            .core
            .request(read(
                Operation::MeetingRead,
                json!({"meetingId": "m1", "part": part}),
            ))
            .await
            .unwrap_err();
        assert_eq!(error.code, "folder_missing", "{part}");
    }
    // A meeting with no folder yet has nothing to read either.
    put(&e.core, ended("waiting", 15, json!({})));
    let error = e
        .core
        .request(read(
            Operation::MeetingRead,
            json!({"meetingId": "waiting", "part": "files"}),
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, "not_found");
}

#[tokio::test]
async fn failed_save_retries_in_the_next_slot() {
    let e = env();
    let record = ended("m1", 15, json!({}));
    let created = rfc(graph::timestamp(record.data["start"].as_str().unwrap()) + 60);
    put(&e.core, record);
    teams(&e.graph, &created, VTT);
    e.graph.fail(
        &content_url(ONLINE, "t1"),
        WorkspaceError::new(
            "throttled",
            "Microsoft returned 429. Retry after at least 60 seconds.",
        ),
    );
    let at = now();
    meetings_round_at(&e.core, at).unwrap();
    run_jobs(&e.core).await;
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Available);
    assert_eq!(m.last_error.unwrap().code, "throttled");
    // The same slot never queues it twice.
    meetings_round_at(&e.core, at).unwrap();
    assert_eq!(jobs(&e.core, "transcript_download").len(), 1);
    // The next slot tries again, and Teams answers this time.
    e.graph.answer_text(&content_url(ONLINE, "t1"), VTT);
    meetings_round_at(&e.core, at + 600).unwrap();
    let saves = jobs(&e.core, "transcript_download");
    assert_eq!(saves.len(), 2);
    assert!(saves
        .iter()
        .any(|j| j.key == format!("transcript_download:auto:m1:{}", slot(at + 600))));
    run_jobs_ahead(&e.core, 600).await;
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Downloaded);
    assert!(m.last_error.is_none());
    // Try again starts at once, without waiting for a slot.
    put(
        &e.core,
        ended(
            "m2",
            15,
            json!({"joinUrl": "https://teams.microsoft.com/l/m2"}),
        ),
    );
    e.graph.answer(
        &lookup_url("https://teams.microsoft.com/l/m2"),
        json!({"value": [{"id": "ONLINE2"}]}),
    );
    e.graph.answer(
        &list_url("ONLINE2"),
        json!({"value": [{"id": "t2", "createdDateTime": created}]}),
    );
    e.graph.fail(
        &content_url("ONLINE2", "t2"),
        WorkspaceError::new("offline", "Microsoft read timed out."),
    );
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m2"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(meeting(&e.core, "m2").last_error.unwrap().code, "offline");
    e.graph.answer_text(&content_url("ONLINE2", "t2"), VTT);
    let retry = op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m2"}),
    )
    .await
    .unwrap();
    let ran = run_jobs(&e.core).await;
    assert_eq!(ran.len(), 1);
    assert_eq!(ran[0].id, retry["jobId"].as_str().unwrap());
    assert!(ran[0].key.starts_with("transcript_download:"));
    assert!(!ran[0].key.contains(":auto:"));
    assert_eq!(meeting(&e.core, "m2").state, MeetingState::Downloaded);
}

#[tokio::test]
async fn save_of_a_deleted_transcript_is_not_retried() {
    let e = env();
    let record = ended("m1", 15, json!({}));
    let created = rfc(graph::timestamp(record.data["start"].as_str().unwrap()) + 60);
    put(&e.core, record);
    teams(&e.graph, &created, VTT);
    // Teams deleted the transcript between the check and the save: reading it is a 404.
    let gone = || graph::graph_text_response(404, "60", b"").unwrap_err();
    e.graph.fail(&content_url(ONLINE, "t1"), gone());
    let at = now();
    meetings_round_at(&e.core, at).unwrap();
    let ran = run_jobs(&e.core).await;
    let save = ran
        .iter()
        .find(|j| j.kind == "transcript_download")
        .unwrap();
    assert_eq!(save.state, "failed");
    assert_eq!(save.error_code.as_deref(), Some("transcript_missing"));
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Available, "Try again stays on offer");
    let error = m.last_error.unwrap();
    assert_eq!(error.code, "transcript_missing");
    assert!(
        error
            .message
            .contains("Teams no longer has this transcript"),
        "{}",
        error.message
    );
    // Never again by itself, in any later slot.
    for later in [600, 1200, 3600] {
        meetings_round_at(&e.core, at + later).unwrap();
    }
    assert_eq!(jobs(&e.core, "transcript_download").len(), 1);
    // The list read is a 404 too, or no longer lists it: the same answer.
    e.graph.fail(&list_url(ONLINE), gone());
    op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m1"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(
        meeting(&e.core, "m1").last_error.unwrap().code,
        "transcript_missing"
    );
    e.graph.answer(&list_url(ONLINE), json!({"value": []}));
    op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m1"}),
    )
    .await
    .unwrap();
    let ran = run_jobs(&e.core).await;
    assert_eq!(ran[0].error_code.as_deref(), Some("transcript_missing"));
    meetings_round_at(&e.core, at + 4200).unwrap();
    assert_eq!(jobs(&e.core, "transcript_download").len(), 3);
    // Teams has it again: Try again saves it.
    e.graph.answer(
        &list_url(ONLINE),
        json!({"value": [{"id": "t1", "createdDateTime": created}]}),
    );
    e.graph.answer_text(&content_url(ONLINE, "t1"), VTT);
    op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m1"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    let m = meeting(&e.core, "m1");
    assert_eq!(m.state, MeetingState::Downloaded);
    assert!(m.last_error.is_none());
}

#[tokio::test]
async fn automatic_retries_stop_after_the_check_window() {
    let e = env();
    let record = ended("m1", 15, json!({}));
    let end = graph::timestamp(record.data["end"].as_str().unwrap());
    let created = rfc(end - 1800 + 60);
    put(&e.core, record);
    teams(&e.graph, &created, VTT);
    e.graph.fail(
        &content_url(ONLINE, "t1"),
        WorkspaceError::new(
            "throttled",
            "Microsoft returned 429. Retry after at least 60 seconds.",
        ),
    );
    let at = now();
    meetings_round_at(&e.core, at).unwrap();
    run_jobs(&e.core).await;
    // Within the day after the meeting, every slot tries again.
    meetings_round_at(&e.core, at + 600).unwrap();
    assert_eq!(jobs(&e.core, "transcript_download").len(), 2);
    run_jobs_ahead(&e.core, 600).await;
    assert_eq!(meeting(&e.core, "m1").last_error.unwrap().code, "throttled");
    // Once the check window is over, it waits for the person.
    for late in [end + 24 * 3600, end + 25 * 3600, end + 3 * 24 * 3600] {
        meetings_round_at(&e.core, late).unwrap();
    }
    assert_eq!(jobs(&e.core, "transcript_download").len(), 2);
    // Try again still runs it.
    e.graph.answer_text(&content_url(ONLINE, "t1"), VTT);
    op(
        &e.core,
        Operation::MeetingDownload,
        json!({"meetingId": "m1"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(meeting(&e.core, "m1").state, MeetingState::Downloaded);
    // Found days later by Check now: its failed save is not retried by the round either.
    put(
        &e.core,
        event(
            "m2",
            SYNC,
            START,
            END,
            json!({"joinUrl": "https://teams.microsoft.com/l/m2"}),
        ),
    );
    e.graph.answer(
        &lookup_url("https://teams.microsoft.com/l/m2"),
        json!({"value": [{"id": "ONLINE2"}]}),
    );
    e.graph.answer(
        &list_url("ONLINE2"),
        json!({"value": [{"id": "t2", "createdDateTime": CREATED}]}),
    );
    e.graph.fail(
        &content_url("ONLINE2", "t2"),
        WorkspaceError::new("offline", "Microsoft read timed out."),
    );
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m2"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    assert_eq!(meeting(&e.core, "m2").last_error.unwrap().code, "offline");
    let before = jobs(&e.core, "transcript_download").len();
    meetings_round_at(&e.core, now() + 600).unwrap();
    assert_eq!(jobs(&e.core, "transcript_download").len(), before);
}

#[tokio::test]
async fn snapshot_carries_the_meetings_root() {
    let e = env();
    let root = |core: &Arc<Core>| {
        let core = core.clone();
        async move {
            core.request(read(Operation::Snapshot, json!({})))
                .await
                .unwrap()["snapshot"]["meetingsRoot"]
                .clone()
        }
    };
    let default = json!({"path": default_root(&e.core).to_string_lossy(), "isDefault": true});
    assert_eq!(root(&e.core).await, default);
    // It is a setting, not account data: shown with calendar and transcripts off too.
    connect(&e.core, &["mail"]);
    assert_eq!(root(&e.core).await, default);
    let chosen = e.core.paths.data.join("Chosen");
    std::fs::create_dir(&chosen).unwrap();
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"root": chosen.to_string_lossy()}}),
    )
    .await
    .unwrap();
    assert_eq!(
        root(&e.core).await,
        json!({"path": chosen.to_string_lossy(), "isDefault": false})
    );
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"root": ""}}),
    )
    .await
    .unwrap();
    assert_eq!(root(&e.core).await, default);
}

#[tokio::test]
async fn meeting_records_follow_the_calendar_capability_and_disconnect() {
    let e = env();
    put(&e.core, event("m1", SYNC, START, END, json!({})));
    teams(&e.graph, CREATED, VTT);
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m1"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let shown = |core: &Core| {
        core.repo()
            .unwrap()
            .snapshot()
            .unwrap()
            .records
            .into_iter()
            .filter(|r| r.kind == KIND)
            .collect::<Vec<_>>()
    };
    let records = shown(&e.core);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].id, "m1");
    assert_eq!(records[0].source, "calendar:cal-1");
    assert_eq!(records[0].data["state"], "downloaded");
    let folder = folder_of(&e.core, "m1");
    // Calendar reads off: the meeting goes with its event.
    connect(&e.core, &["meetings", "transcripts"]);
    assert!(shown(&e.core).is_empty());
    connect(&e.core, &["calendar", "meetings", "transcripts"]);
    assert_eq!(shown(&e.core).len(), 1);
    // Signing out removes the record; the folder is the person's and stays.
    op(&e.core, Operation::GraphDisconnect, json!({}))
        .await
        .unwrap();
    assert!(e
        .core
        .repo()
        .unwrap()
        .records_of_kind(KIND)
        .unwrap()
        .is_empty());
    assert!(folder.join("transcript.md").is_file());
}

#[tokio::test]
async fn reveal_opens_the_meeting_folder_or_the_root() {
    let e = env();
    let root = default_root(&e.core);
    assert!(!root.exists());
    // The default root is made so there is something to show.
    assert_eq!(
        e.core
            .reveal_target(&read(Operation::MeetingsReveal, json!({})))
            .unwrap(),
        root
    );
    assert!(root.is_dir());
    put(&e.core, event("m1", SYNC, START, END, json!({})));
    teams(&e.graph, CREATED, VTT);
    op(&e.core, Operation::MeetingCheck, json!({"meetingId": "m1"}))
        .await
        .unwrap();
    run_jobs(&e.core).await;
    let folder = folder_of(&e.core, "m1");
    assert_eq!(
        e.core
            .reveal_target(&read(Operation::MeetingsReveal, json!({"meetingId": "m1"})))
            .unwrap(),
        folder
    );
    std::fs::remove_dir_all(&folder).unwrap();
    let error = e
        .core
        .reveal_target(&read(Operation::MeetingsReveal, json!({"meetingId": "m1"})))
        .unwrap_err();
    assert_eq!(error.code, "folder_missing");
    // A chosen root that is gone is never made again.
    let chosen = e.core.paths.data.join("Chosen");
    std::fs::create_dir(&chosen).unwrap();
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"root": chosen.to_string_lossy()}}),
    )
    .await
    .unwrap();
    std::fs::remove_dir(&chosen).unwrap();
    let error = e
        .core
        .reveal_target(&read(Operation::MeetingsReveal, json!({})))
        .unwrap_err();
    assert_eq!(error.code, "folder_unwritable");
    assert!(!chosen.exists());
}

#[tokio::test]
async fn settings_update_validates_meeting_settings() {
    let e = env();
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"checkEveryMin": 30, "columns": {"todo": "Next"}}}),
    )
    .await
    .unwrap();
    let s = e.core.repo().unwrap().settings().unwrap();
    assert_eq!(s.meetings.check_every_min, 30);
    assert_eq!(
        s.meetings.columns.get("todo").map(String::as_str),
        Some("Next")
    );
    let error = op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"theme": "dark", "meetings": {"checkEveryMin": 7}}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "validation");
    assert_eq!(error.field.as_deref(), Some("checkEveryMin"));
    let s = e.core.repo().unwrap().settings().unwrap();
    assert_eq!(s.theme, "system", "a refused update changes nothing");
    assert_eq!(s.meetings.check_every_min, 30);
    // The slot follows the setting: every 30 minutes.
    put(&e.core, ended("m1", 15, json!({})));
    let at = now();
    meetings_round_at(&e.core, at).unwrap();
    assert_eq!(
        jobs(&e.core, "transcript_check")[0].key,
        format!("transcript_check:m1:{}", at / 1800)
    );
}

/// The meeting records, transcript and file list the UI (Task 4) builds against.
/// Regenerate with `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
#[tokio::test]
async fn contract_fixtures_match_the_real_meetings() {
    let e = env();
    // downloaded: saved from Teams.
    put(&e.core, event("m-downloaded", SYNC, START, END, json!({})));
    teams(&e.graph, CREATED, VTT);
    op(
        &e.core,
        Operation::MeetingCheck,
        json!({"meetingId": "m-downloaded"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    // pending: Teams has nothing yet.
    put(
        &e.core,
        ended(
            "m-pending",
            15,
            json!({"title": "Daily stand-up", "joinUrl": "https://teams.microsoft.com/l/pending"}),
        ),
    );
    e.graph.answer(
        &lookup_url("https://teams.microsoft.com/l/pending"),
        json!({"value": [{"id": "ONLINE-P"}]}),
    );
    e.graph.answer(&list_url("ONLINE-P"), json!({"value": []}));
    op(
        &e.core,
        Operation::MeetingCheck,
        json!({"meetingId": "m-pending"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    // blocked: another organization's meeting.
    put(
        &e.core,
        ended(
            "m-blocked",
            40,
            json!({"title": "Vendor review", "joinUrl": "https://teams.microsoft.com/l/blocked"}),
        ),
    );
    e.graph.answer(
        &lookup_url("https://teams.microsoft.com/l/blocked"),
        json!({"value": [{"id": "ONLINE-B"}]}),
    );
    e.graph.fail(
        &list_url("ONLINE-B"),
        WorkspaceError::new(
            "permission_required",
            "Forbidden: GraphAccessToTranscriptsDisabled: The organizer's organization does not allow transcript access.",
        ),
    );
    op(
        &e.core,
        Operation::MeetingCheck,
        json!({"meetingId": "m-blocked"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    // none: a day went by with no transcript.
    put(
        &e.core,
        ended(
            "m-none",
            2 * 24 * 60,
            json!({"title": "Planning", "joinUrl": "https://teams.microsoft.com/l/none"}),
        ),
    );
    e.graph.answer(
        &lookup_url("https://teams.microsoft.com/l/none"),
        json!({"value": [{"id": "ONLINE-N"}]}),
    );
    e.graph.answer(&list_url("ONLINE-N"), json!({"value": []}));
    op(
        &e.core,
        Operation::MeetingCheck,
        json!({"meetingId": "m-none"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;
    // available: found in Teams, the save is waiting for the person (folder gone).
    put(
        &e.core,
        event(
            "m-available",
            "Roadmap review",
            START,
            END,
            json!({"joinUrl": "https://teams.microsoft.com/l/available"}),
        ),
    );
    e.graph.answer(
        &lookup_url("https://teams.microsoft.com/l/available"),
        json!({"value": [{"id": "ONLINE-A"}]}),
    );
    e.graph.answer(
        &list_url("ONLINE-A"),
        json!({"value": [{"id": "t-a", "createdDateTime": CREATED}]}),
    );
    let chosen = e.core.paths.data.join("Chosen");
    std::fs::create_dir(&chosen).unwrap();
    op(
        &e.core,
        Operation::SettingsUpdate,
        json!({"meetings": {"root": chosen.to_string_lossy()}}),
    )
    .await
    .unwrap();
    std::fs::remove_dir(&chosen).unwrap();
    e.graph.answer_text(&content_url("ONLINE-A", "t-a"), VTT);
    op(
        &e.core,
        Operation::MeetingCheck,
        json!({"meetingId": "m-available"}),
    )
    .await
    .unwrap();
    run_jobs(&e.core).await;

    let transcript = e
        .core
        .request(read(
            Operation::MeetingRead,
            json!({"meetingId": "m-downloaded", "part": "transcript"}),
        ))
        .await
        .unwrap();
    let mut files = e
        .core
        .request(read(
            Operation::MeetingRead,
            json!({"meetingId": "m-downloaded", "part": "files"}),
        ))
        .await
        .unwrap();
    for f in files["files"].as_array_mut().unwrap() {
        f["modified"] = 1_795_000_500.into();
    }
    // Random ids, clock values and temp paths are pinned so the files only change with the shapes.
    let home = e.core.home.clone().unwrap();
    let data = e.core.paths.data.clone();
    let mut records = Vec::new();
    for (i, id) in [
        "m-pending",
        "m-available",
        "m-downloaded",
        "m-blocked",
        "m-none",
    ]
    .into_iter()
    .enumerate()
    {
        let record = e
            .core
            .repo()
            .unwrap()
            .record(KIND, id, Some(ACCT), None)
            .unwrap();
        let mut v = serde_json::to_value(&record).unwrap();
        v["revision"] = format!("rev-{i}").into();
        v["updatedAt"] = 1_795_000_500.into();
        let d = &mut v["data"];
        if d["checkedAt"].is_i64() {
            d["checkedAt"] = 1_795_000_400.into();
        }
        if !matches!(id, "m-downloaded" | "m-available") {
            d["start"] = "2026-11-04T09:00:00Z".into();
            d["end"] = "2026-11-04T09:30:00Z".into();
        }
        let text = serde_json::to_string(&v)
            .unwrap()
            .replace(&home.to_string_lossy().to_string(), "/Users/taylor")
            .replace(&data.to_string_lossy().to_string(), "/Users/taylor/Work");
        records.push(serde_json::from_str::<Value>(&text).unwrap());
    }
    let states: Vec<&str> = records
        .iter()
        .map(|r| r["data"]["state"].as_str().unwrap())
        .collect();
    assert_eq!(
        states,
        vec!["pending", "available", "downloaded", "blocked", "none"]
    );
    assert_eq!(records[1]["data"]["lastError"]["code"], "folder_unwritable");
    crate::plugins::testkit::contract_fixture("meeting-records.json", &Value::Array(records));
    crate::plugins::testkit::contract_fixture("meeting-transcript.json", &transcript);
    crate::plugins::testkit::contract_fixture("meeting-files.json", &files);
}
