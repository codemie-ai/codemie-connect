//! `analytics_app` over a `Core` whose records the tests seed and whose CLI is a
//! [`FakeAnalyticsCli`]. The window is `FROM`..`TO` (two local days at +02:00); records sit at
//! `FROM_S + n` seconds.
use super::cli::{CliError, FakeAnalyticsCli};
use super::tests::{core, FROM, TO};
use crate::workspace::models::{id, Operation, Record};
use crate::workspace::Core;
use chrono::DateTime;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

fn ms(rfc: &str) -> i64 {
    DateTime::parse_from_rfc3339(rfc)
        .unwrap()
        .timestamp_millis()
}
fn from_s() -> i64 {
    ms(FROM) / 1000
}
fn rec(kind: &str, updated_at: i64, data: Value) -> Record {
    Record {
        id: id(),
        kind: kind.into(),
        connection_id: None,
        workspace_id: Some("personal".into()),
        source: "test".into(),
        revision: id(),
        updated_at,
        data,
    }
}
fn put(core: &Arc<Core>, r: Record) {
    core.repo().unwrap().put_record(&r).unwrap();
}
/// One ledger row `n` seconds into the window.
fn run(core: &Arc<Core>, n: i64, purpose: &str, status: &str, cost: f64) {
    run_with(core, n, purpose, status, cost, "claude", "sonnet", 1000);
}
#[allow(clippy::too_many_arguments)]
fn run_with(
    core: &Arc<Core>,
    n: i64,
    purpose: &str,
    status: &str,
    cost: f64,
    profile: &str,
    model: &str,
    duration: u64,
) {
    let at = from_s() + n;
    put(
        core,
        rec(
            "ai_run",
            at,
            json!({"purpose": purpose, "profile": profile, "model": model, "status": status,
                "durationMs": duration, "tokens": null, "costUsd": cost, "refId": null,
                "month": "2026-11", "at": at}),
        ),
    );
}
async fn ask_app(core: &Arc<Core>) -> Value {
    // Cut in Kyiv's zone (+02:00 in November), not the machine's, so tests don't depend on TZ.
    core.analytics_app_in(&chrono_tz::Europe::Kyiv, &json!({"from": FROM, "to": TO}))
        .await
        .unwrap()
}
fn log_launches(dir: &Path, launches: &[(i64, &str)]) {
    let text: String = launches
        .iter()
        .map(|(at, folder)| {
            format!(
                "{}\n",
                json!({"at": at, "folder": folder, "program": "claude"})
            )
        })
        .collect();
    std::fs::write(dir.join("terminal-launches.jsonl"), text).unwrap();
}
fn cli_summary(total: f64, sessions: Value) -> Value {
    json!({"schema": "codemie.analytics.summary/1", "totals": {"costUSD": total}, "sessions": sessions})
}
fn near(v: &Value, want: f64) {
    let got = v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"));
    assert!((got - want).abs() < 1e-9, "{got} != {want}");
}

#[tokio::test]
async fn app_totals_split_cost_by_feature_and_count_failures() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    run(&core, 10, "meeting", "ok", 0.5);
    run(&core, 20, "mail_draft", "ok", 0.1);
    run_with(&core, 30, "chat_draft", "ok", 0.2, "bedrock", "opus", 3000);
    run(&core, 40, "summary", "failed", 0.05);
    run(&core, 50, "automation", "ok", 1.0);
    run(&core, 60, "plugin", "ok", 0.3);
    // The Settings test run fits no feature: counted in the totals only.
    run(&core, 70, "test", "ok", 0.01);
    // Outside the window.
    run(&core, -10, "meeting", "ok", 9.0);
    run(&core, 3 * 86_400, "meeting", "ok", 9.0);
    let app = ask_app(&core).await;
    assert_eq!(app["totals"]["runs"], 7);
    assert_eq!(app["totals"]["failed"], 1);
    near(&app["totals"]["costUsd"], 2.16);
    assert_eq!(app["totals"]["terminalSessions"], 0);
    near(&app["totals"]["terminalCostUsd"], 0.0);
    let feature = |key: &str| {
        app["features"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == key)
            .unwrap_or_else(|| panic!("no feature {key}"))
            .clone()
    };
    let keys: Vec<&str> = app["features"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        [
            "meeting",
            "draft",
            "summary",
            "automation",
            "plugin",
            "terminal"
        ]
    );
    near(&feature("meeting")["costUsd"], 0.5);
    assert_eq!(feature("draft")["runs"], 2);
    near(&feature("draft")["costUsd"], 0.3);
    near(&feature("draft")["avgMs"], 2000.0);
    assert_eq!(feature("summary")["failed"], 1);
    assert_eq!(feature("terminal")["runs"], 0);
    // Cost per day: the first day holds every run.
    let series = app["series"].as_array().unwrap();
    assert_eq!(series.len(), 2);
    near(&series[0]["by"]["draft"], 0.3);
    near(&series[0]["by"]["terminal"], 0.0);
    near(&series[1]["by"]["draft"], 0.0);
    assert_eq!(series[0]["from"], ms(FROM));
    assert_eq!(series[1]["to"], ms(TO));
    // Profiles, the dearest first.
    assert_eq!(app["profiles"][0]["profile"], "claude");
    assert_eq!(app["profiles"][0]["runs"], 6);
    assert_eq!(app["profiles"][1]["model"], "opus");
}

#[tokio::test]
async fn recent_is_newest_first_and_capped_at_50() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    for n in 0..60 {
        run(&core, n, "summary", "ok", 0.01);
    }
    let app = ask_app(&core).await;
    let recent = app["recent"].as_array().unwrap();
    assert_eq!(recent.len(), 50);
    assert_eq!(recent[0]["at"], from_s() + 59);
    assert_eq!(recent[49]["at"], from_s() + 10);
    assert_eq!(app["totals"]["runs"], 60);
}

#[tokio::test]
async fn recent_rows_carry_the_feature_their_purpose_belongs_to() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    let purposes = [
        ("meeting", json!("meeting")),
        ("mail_draft", json!("draft")),
        ("chat_draft", json!("draft")),
        ("summary", json!("summary")),
        ("automation", json!("automation")),
        ("plugin", json!("plugin")),
        // The Settings test run fits no feature.
        ("test", Value::Null),
    ];
    for (n, (purpose, _)) in purposes.iter().enumerate() {
        run(&core, n as i64, purpose, "ok", 0.01);
    }
    let app = ask_app(&core).await;
    let recent = app["recent"].as_array().unwrap();
    assert_eq!(recent.len(), purposes.len());
    for row in recent {
        let purpose = row["purpose"].as_str().unwrap();
        let (_, want) = purposes.iter().find(|(p, _)| *p == purpose).unwrap();
        assert_eq!(&row["feature"], want, "{purpose}");
    }
}

#[tokio::test]
async fn background_share_counts_only_connects_own_runs_against_all_cost() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    run(&core, 10, "meeting", "ok", 1.0);
    let t = ms(FROM) + 3_600_000;
    log_launches(dir.path(), &[(t, "/w/a")]);
    // The CLI counted 3.0 in all, 2.0 of it a session started in Connect's terminal.
    cli.script_view(Ok(cli_summary(
        3.0,
        json!([{"sessionId": id(), "startTime": t + 1_000, "project": "/w/a", "costUSD": 2.0}]),
    )));
    let app = ask_app(&core).await;
    near(&app["totals"]["terminalCostUsd"], 2.0);
    // Background runs only: 1 / (1 + 3); with the terminal: (1 + 2) / (1 + 3).
    near(&app["totals"]["backgroundShareOfAll"], 1.0 / 4.0);
    near(&app["totals"]["shareOfAll"], 3.0 / 4.0);
    // Without the CLI there is no total to compare against.
    let none_dir = tempfile::tempdir().unwrap();
    let none_cli = Arc::new(FakeAnalyticsCli::new());
    let none = super::tests::core(none_dir.path(), &none_cli);
    run(&none, 10, "meeting", "ok", 1.0);
    none_cli.set_supports_view(false);
    let app = ask_app(&none).await;
    assert!(app["totals"]["backgroundShareOfAll"].is_null());
    assert!(app["totals"]["shareOfAll"].is_null());
    // Nothing spent anywhere: no share of nothing.
    let zero_dir = tempfile::tempdir().unwrap();
    let zero_cli = Arc::new(FakeAnalyticsCli::new());
    let zero = super::tests::core(zero_dir.path(), &zero_cli);
    zero_cli.script_view(Ok(cli_summary(0.0, json!([]))));
    let app = ask_app(&zero).await;
    assert!(app["totals"]["backgroundShareOfAll"].is_null());
}

#[tokio::test]
async fn a_cli_session_counts_as_terminal_only_within_120_seconds_in_the_same_folder() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    run(&core, 10, "summary", "ok", 1.0);
    let t = ms(FROM) + 3_600_000;
    log_launches(
        dir.path(),
        &[
            (t, "/w/a"),
            (t + 7_200_000, "/w/a"),
            (t + 9_000_000, "/w/b"),
        ],
    );
    let row = |start: i64, project: &str, cost: f64| json!({"sessionId": id(), "startTime": start, "project": project, "costUSD": cost});
    cli.script_view(Ok(cli_summary(
        20.0,
        json!([
            row(t + 119_000, "/w/a", 2.0),           // matches the first launch
            row(t + 121_000, "/w/a", 3.0),           // 121 s: no
            row(t, "/w/b", 4.0),                     // another folder: no
            row(t + 7_200_000 - 5_000, "/w/a", 5.0), // matches the second launch
            row(t + 9_000_000 + 1_000, "/w/b", 6.0), // matches the third
            row(t + 9_000_000 + 2_000, "/w/b", 7.0), // the third is taken: no
        ]),
    )));
    let app = ask_app(&core).await;
    assert_eq!(app["totals"]["terminalSessions"], 3);
    near(&app["totals"]["terminalCostUsd"], 13.0);
    // (1 + 13) / (1 + 20)
    near(&app["totals"]["shareOfAll"], 14.0 / 21.0);
    near(&app["totals"]["backgroundShareOfAll"], 1.0 / 21.0);
    let terminal = app["features"][5].clone();
    assert_eq!(terminal["key"], "terminal");
    assert_eq!(terminal["runs"], 3);
    near(&terminal["costUsd"], 13.0);
    let by_day: f64 = app["series"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["by"]["terminal"].as_f64().unwrap())
        .sum();
    near(&json!(by_day), 13.0);
    // The CLI was asked for exactly this window.
    let args = match cli.calls().into_iter().find_map(|c| match c {
        super::cli::FakeCall::View { args, .. } => Some(args),
        _ => None,
    }) {
        Some(a) => a,
        None => panic!("no view call"),
    };
    assert_eq!(args, ["--from", FROM, "--to", TO]);
}

#[tokio::test]
async fn without_the_cli_the_terminal_fields_are_zero_and_the_rest_still_answers() {
    for case in ["old", "timeout", "incompatible"] {
        let dir = tempfile::tempdir().unwrap();
        let cli = Arc::new(FakeAnalyticsCli::new());
        let core = core(dir.path(), &cli);
        let t = ms(FROM) + 3_600_000;
        log_launches(dir.path(), &[(t, "/w/a")]);
        run(&core, 10, "meeting", "ok", 1.0);
        match case {
            "old" => cli.set_supports_view(false),
            "timeout" => cli.script_view(Err(CliError::Timeout)),
            // An answer this Connect doesn't read, though it names a matching session.
            _ => cli.script_view(Ok(json!({"schema": "codemie.analytics.other/1",
                "totals": {"costUSD": 3.0},
                "sessions": [{"sessionId": "s", "startTime": t + 1_000, "project": "/w/a", "costUSD": 2.0}]}))),
        }
        let app = ask_app(&core).await;
        assert_eq!(app["totals"]["terminalSessions"], 0);
        near(&app["totals"]["terminalCostUsd"], 0.0);
        assert!(app["totals"]["shareOfAll"].is_null());
        assert!(app["totals"]["backgroundShareOfAll"].is_null());
        assert_eq!(app["totals"]["runs"], 1);
        near(&app["totals"]["costUsd"], 1.0);
    }
}

#[tokio::test]
async fn a_launch_matches_its_session_through_a_symlinked_folder() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("work");
    std::fs::create_dir_all(&real).unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    let t = ms(FROM) + 3_600_000;
    // The dock notes the real folder; the agent noted the folder by the link it was opened in.
    let noted = real.canonicalize().unwrap();
    log_launches(dir.path(), &[(t, noted.to_str().unwrap())]);
    let row = json!([{"sessionId": "s", "startTime": t + 1_000, "project": link.to_str().unwrap(), "costUSD": 2.0}]);
    cli.script_view(Ok(cli_summary(5.0, row.clone())));
    let app = ask_app(&core).await;
    assert_eq!(app["totals"]["terminalSessions"], 1);
    near(&app["totals"]["terminalCostUsd"], 2.0);
    // The AI tab's tag uses the same match.
    let mut summary: Value = serde_json::from_str(include_str!("testdata/summary.json")).unwrap();
    summary["sessions"] = row;
    cli.script_view(Ok(summary));
    let view = super::tests::ask(
        &core,
        Operation::AnalyticsView,
        json!({"from": FROM, "to": TO}),
    )
    .await;
    assert_eq!(view["connect"], json!({"startedInConnect": ["s"]}));
}

#[tokio::test]
async fn outcomes_count_meetings_tasks_sent_replies_inbox_and_automations() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    let s = from_s();
    let meeting = |mid: &str, start: i64, transcripts: Value, main: Value| {
        let mut r = rec(
            "meeting",
            s,
            json!({"eventId": mid, "start": DateTime::from_timestamp(start, 0).unwrap().to_rfc3339(),
                "transcriptIds": transcripts, "main": main}),
        );
        r.id = mid.into();
        r
    };
    put(&core, meeting("m1", s + 100, json!(["t"]), json!("doc1")));
    put(&core, meeting("m2", s + 200, json!(["t"]), Value::Null));
    put(&core, meeting("m3", s + 300, json!([]), Value::Null));
    put(&core, meeting("old", s - 86_400, json!(["t"]), json!("d")));
    let task = |mid: Option<&str>, status: &str| {
        rec(
            "commitment",
            s,
            json!({"meetingId": mid, "status": status, "text": "x"}),
        )
    };
    put(&core, task(Some("m1"), "done"));
    put(&core, task(Some("m1"), "todo"));
    put(&core, task(Some("m2"), "doing"));
    put(&core, task(Some("old"), "done"));
    put(&core, task(None, "done"));
    // A task from before the board has no status, only `done`.
    put(
        &core,
        rec(
            "commitment",
            s,
            json!({"meetingId": "m2", "done": true, "text": "x"}),
        ),
    );
    let action =
        |kind: &str, state: &str, at: i64| rec("action", at, json!({"kind": kind, "state": state}));
    put(&core, action("mail_reply", "accepted", s + 10));
    put(&core, action("mail_reply", "accepted", s + 20));
    put(&core, action("mail_reply", "failed", s + 30));
    put(&core, action("chat_reply", "succeeded", s + 40));
    put(&core, action("mail_reply", "accepted", s - 5));
    let decision = |data: Value, at: i64| rec("decision", at, data);
    put(&core, decision(json!({"lifecycle": "archived"}), s + 10));
    put(
        &core,
        decision(json!({"lifecycle": "open", "acknowledgedAt": 1}), s + 10),
    );
    put(
        &core,
        decision(json!({"lifecycle": "open", "acknowledgedAt": null}), s + 10),
    );
    put(&core, decision(json!({"lifecycle": "archived"}), s - 5));
    let auto = |status: &str, at: i64| {
        rec(
            "automation_run",
            at,
            json!({"status": status, "startedAt": at}),
        )
    };
    put(&core, auto("ok", s + 10));
    put(&core, auto("ok", s + 20));
    put(&core, auto("failed", s + 30));
    put(&core, auto("ok", s - 5));
    run(&core, 10, "meeting", "ok", 1.0);
    run(&core, 10, "meeting", "ok", 0.5);
    run(&core, 10, "mail_draft", "ok", 0.3);
    run(&core, 10, "chat_draft", "failed", 0.2);
    let app = ask_app(&core).await;
    let o = &app["outcomes"];
    assert_eq!(o["meetings"], 3);
    assert_eq!(o["transcribed"], 2);
    assert_eq!(o["noted"], 1);
    assert_eq!(o["tasks"], 4);
    assert_eq!(o["tasksDone"], 2);
    assert_eq!(o["drafts"], 1);
    assert_eq!(o["sent"], 2);
    assert_eq!(o["inboxHandled"], 2);
    assert_eq!(o["autoRuns"], 3);
    assert_eq!(o["autoOk"], 2);
    // All meeting cost per noted meeting; all draft cost (even a failed run's) per sent reply.
    near(&o["perNoteUsd"], 1.5);
    near(&o["perSentUsd"], 0.25);
}

#[tokio::test]
async fn an_empty_range_answers_zeros() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    let app = ask_app(&core).await;
    for key in ["runs", "failed", "terminalSessions"] {
        assert_eq!(app["totals"][key], 0, "{key}");
    }
    near(&app["totals"]["costUsd"], 0.0);
    near(&app["totals"]["terminalCostUsd"], 0.0);
    // A sum of nothing is 0, not -0 (which the page would print as "$-0.00").
    for cost in [
        &app["totals"]["costUsd"],
        &app["totals"]["terminalCostUsd"],
        &app["features"][5]["costUsd"],
    ] {
        assert!(cost.as_f64().unwrap().is_sign_positive(), "{cost}");
    }
    assert!(app["totals"]["shareOfAll"].is_null());
    assert!(app["totals"]["backgroundShareOfAll"].is_null());
    assert_eq!(app["series"].as_array().unwrap().len(), 2);
    assert_eq!(app["features"].as_array().unwrap().len(), 6);
    assert!(app["features"]
        .as_array()
        .unwrap()
        .iter()
        .all(|f| f["runs"] == 0 && f["avgMs"] == 0));
    assert_eq!(app["profiles"], json!([]));
    assert_eq!(app["recent"], json!([]));
    for key in [
        "meetings",
        "transcribed",
        "noted",
        "tasks",
        "tasksDone",
        "drafts",
        "sent",
        "inboxHandled",
        "autoRuns",
        "autoOk",
    ] {
        assert_eq!(app["outcomes"][key], 0, "{key}");
    }
    assert!(app["outcomes"]["perNoteUsd"].is_null());
    assert!(app["outcomes"]["perSentUsd"].is_null());
    // A range that ends before it starts is refused.
    let err = core
        .request(super::tests::read(
            Operation::AnalyticsApp,
            json!({"from": TO, "to": FROM}),
        ))
        .await
        .unwrap_err();
    assert_eq!(err.code, "validation");
}

#[tokio::test]
async fn contract_fixture_analytics_app() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    let s = from_s();
    // Fixed ids: the fixture mustn't change on every run.
    let fixed = |mut r: Record, n: u32| {
        if r.kind != "meeting" {
            r.id = format!("r{n}");
        }
        r.revision = format!("v{n}");
        r
    };
    let mut n = 0;
    let mut add = |r: Record| {
        n += 1;
        put(&core, fixed(r, n));
    };
    let run_rec = |at: i64,
                   purpose: &str,
                   status: &str,
                   cost: f64,
                   profile: &str,
                   model: &str,
                   ms: u64| {
        rec(
            "ai_run",
            at,
            json!({"purpose": purpose, "profile": profile, "model": model, "status": status,
                "durationMs": ms, "tokens": {"input": 120, "output": 40, "cacheRead": 0, "cacheCreation": 0},
                "costUsd": cost, "refId": null, "month": "2026-11", "at": at}),
        )
    };
    add(run_rec(
        s + 3_600,
        "meeting",
        "ok",
        0.42,
        "claude",
        "claude-sonnet-5-5",
        41_000,
    ));
    add(run_rec(
        s + 7_200,
        "mail_draft",
        "ok",
        0.08,
        "claude",
        "claude-sonnet-5-5",
        6_200,
    ));
    add(run_rec(
        s + 90_000,
        "chat_draft",
        "ok",
        0.05,
        "claude",
        "claude-sonnet-5-5",
        4_100,
    ));
    add(run_rec(
        s + 91_000,
        "summary",
        "failed",
        0.02,
        "bedrock",
        "claude-haiku-5",
        2_000,
    ));
    add(run_rec(
        s + 92_000,
        "automation",
        "ok",
        0.31,
        "bedrock",
        "claude-haiku-5",
        18_000,
    ));
    add(run_rec(
        s + 93_000,
        "test",
        "ok",
        0.01,
        "claude",
        "claude-sonnet-5-5",
        900,
    ));
    let meeting = |mid: &str, at: i64, transcripts: Value, main: Value| {
        let mut r = rec(
            "meeting",
            s,
            json!({"eventId": mid, "start": DateTime::from_timestamp(at, 0).unwrap().to_rfc3339(),
                "transcriptIds": transcripts, "main": main}),
        );
        r.id = mid.into();
        r
    };
    add(meeting("m1", s + 3_000, json!(["t1"]), json!("d1")));
    add(meeting("m2", s + 90_000, json!(["t2"]), Value::Null));
    add(rec(
        "commitment",
        s,
        json!({"meetingId": "m1", "status": "done"}),
    ));
    add(rec(
        "commitment",
        s,
        json!({"meetingId": "m1", "status": "todo"}),
    ));
    add(rec(
        "action",
        s + 7_300,
        json!({"kind": "mail_reply", "state": "accepted"}),
    ));
    add(rec("decision", s + 7_400, json!({"lifecycle": "archived"})));
    add(rec(
        "automation_run",
        s + 92_000,
        json!({"status": "ok", "startedAt": s + 92_000}),
    ));
    let t = ms(FROM) + 5_000_000;
    log_launches(dir.path(), &[(t, "/Users/taylor/work/sync-engine")]);
    cli.script_view(Ok(cli_summary(
        31.5,
        json!([{"sessionId": "s1", "startTime": t + 4_000, "project": "/Users/taylor/work/sync-engine", "durationMs": 900000, "costUSD": 3.25}]),
    )));
    let app = ask_app(&core).await;
    crate::plugins::testkit::contract_fixture("analytics-app.json", &app);
}

fn kyiv_ms(date: &str, hour: u32) -> i64 {
    use chrono::TimeZone;
    let t = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .unwrap()
        .and_hms_opt(hour, 0, 0)
        .unwrap();
    chrono_tz::Europe::Kyiv
        .from_local_datetime(&t)
        .earliest()
        .unwrap()
        .timestamp_millis()
}

/// The zone is injected (`buckets` takes it) so the test doesn't depend on the machine's TZ.
#[test]
fn day_buckets_are_local_midnights_across_a_dst_change() {
    // Kyiv leaves summer time on 2026-10-25: that day has 25 hours.
    let (from, to) = (kyiv_ms("2026-10-20", 0), kyiv_ms("2026-10-31", 0) - 1);
    let b = super::app::buckets(&chrono_tz::Europe::Kyiv, from, to);
    assert_eq!(b.len(), 11);
    for (i, (start, end)) in b.iter().enumerate() {
        let day = chrono::NaiveDate::from_ymd_opt(2026, 10, 20 + i as u32).unwrap();
        assert_eq!(*start, kyiv_ms(&day.to_string(), 0), "{day}");
        if i > 0 {
            assert_eq!(*start, b[i - 1].1 + 1);
        }
        assert!(end >= start);
    }
    assert_eq!(b[5].1 - b[5].0 + 1, 25 * 3_600_000);
    assert_eq!(b[10].1, to);
}

#[test]
fn a_long_range_is_monday_weeks_with_clamped_ends() {
    // Wednesday 2026-09-02 to Sunday 2026-11-01 (61 days).
    let (from, to) = (kyiv_ms("2026-09-02", 8), kyiv_ms("2026-11-02", 0) - 1);
    let b = super::app::buckets(&chrono_tz::Europe::Kyiv, from, to);
    assert_eq!(b[0].0, from, "the first week starts where the range does");
    assert_eq!(b[0].1, kyiv_ms("2026-09-07", 0) - 1, "and ends on Sunday");
    assert_eq!(b[1].0, kyiv_ms("2026-09-07", 0), "a Monday");
    assert_eq!(b[b.len() - 1].1, to);
    assert_eq!(b[b.len() - 1].0, kyiv_ms("2026-10-26", 0));
    assert_eq!(b.len(), 9);
    for w in b.windows(2) {
        assert_eq!(w[1].0, w[0].1 + 1);
    }
}
