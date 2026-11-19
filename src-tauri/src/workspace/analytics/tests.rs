//! The analytics operations over a `Core` whose CLI is a [`FakeAnalyticsCli`] serving
//! `testdata/`. Fetches start with a fixed UTC today (`start_fetch`), so the planned days don't
//! depend on when the tests run.
use super::cli::{CliError, ExportOutcome, FakeAnalyticsCli, FakeCall};
use super::fetch::{plan_first_open, plan_refresh};
use super::store::{State, Store};
use crate::ai::fake::FakeRunner;
use crate::ai::profiles::ProfileCache;
use crate::workspace::ai_jobs::FakeGraph;
use crate::workspace::models::{Operation, Request};
use crate::workspace::{Core, CorePaths};
use chrono::{Days, NaiveDate};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const TODAY: &str = "2026-11-19";
pub(super) const FROM: &str = "2026-11-18T00:00:00+02:00";
pub(super) const TO: &str = "2026-11-19T23:59:59.999+02:00";
const SESSION_ID: &str = "0076e846-e3ce-4547-84a2-40b65c8f9503";

fn day(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}
fn days(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|s| s.to_string()).collect()
}
/// `back` days before [`TODAY`], as State keeps days.
fn key(back: u64) -> String {
    (day(TODAY) - Days::new(back))
        .format("%Y-%m-%d")
        .to_string()
}
fn window(from: &str, to: &str) -> (NaiveDate, NaiveDate) {
    (day(from), day(to))
}
fn export_day() -> Value {
    serde_json::from_str(include_str!("testdata/export-day.json")).unwrap()
}
fn summary() -> Value {
    serde_json::from_str(include_str!("testdata/summary.json")).unwrap()
}
fn session() -> Value {
    serde_json::from_str(include_str!("testdata/session.json")).unwrap()
}
fn out_of_memory() -> CliError {
    CliError::Failed {
        code: 134,
        stderr_tail: "FATAL ERROR: JavaScript heap out of memory".into(),
    }
}

fn core_on(paths: &CorePaths, cli: &Arc<FakeAnalyticsCli>) -> Arc<Core> {
    Core::open_with(
        None,
        paths,
        Arc::new(FakeRunner::new(vec![])),
        ProfileCache::fixed(vec![]),
        Arc::new(FakeGraph::default()),
        cli.clone(),
    )
    .unwrap()
}
pub(super) fn core(dir: &Path, cli: &Arc<FakeAnalyticsCli>) -> Arc<Core> {
    core_on(
        &CorePaths {
            data: dir.into(),
            private: dir.into(),
        },
        cli,
    )
}
pub(super) fn read(op: Operation, data: Value) -> Request {
    Request {
        op,
        workspace_id: None,
        expected_revision: None,
        operation_id: None,
        data,
    }
}
pub(super) async fn ask(core: &Arc<Core>, op: Operation, data: Value) -> Value {
    core.request(read(op, data)).await.unwrap()
}
async fn refresh(core: &Arc<Core>) -> Value {
    core.start_fetch(day(TODAY), None).await.unwrap()
}
/// Waits for the background fetch to end.
async fn idle(core: &Core) {
    for _ in 0..2000 {
        if core.analytics_run.lock().unwrap().is_none() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the fetch never ended");
}
fn exports(cli: &FakeAnalyticsCli) -> Vec<(NaiveDate, NaiveDate)> {
    cli.calls()
        .into_iter()
        .filter_map(|c| match c {
            FakeCall::Export { from, to, .. } => Some((from, to)),
            _ => None,
        })
        .collect()
}
/// Every call the fake answered, by kind.
fn kinds(cli: &FakeAnalyticsCli) -> Vec<&'static str> {
    cli.calls()
        .iter()
        .map(|c| match c {
            FakeCall::SupportsView => "supports_view",
            FakeCall::Export { .. } => "export",
            FakeCall::View { .. } => "view",
            FakeCall::Report { .. } => "report",
            FakeCall::Stop => "stop",
        })
        .collect()
}
/// Waits until the fake has been asked for `n` exports.
async fn exports_reach(cli: &FakeAnalyticsCli, n: usize) {
    for _ in 0..2000 {
        if exports(cli).len() >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the fetch never asked for export {n}");
}
fn export_outs(cli: &FakeAnalyticsCli) -> Vec<PathBuf> {
    cli.calls()
        .into_iter()
        .filter_map(|c| match c {
            FakeCall::Export { out, .. } => Some(out),
            _ => None,
        })
        .collect()
}
fn last_view(cli: &FakeAnalyticsCli) -> (PathBuf, Vec<String>) {
    cli.calls()
        .into_iter()
        .rev()
        .find_map(|c| match c {
            FakeCall::View { input, args } => Some((input, args)),
            _ => None,
        })
        .unwrap()
}
fn store_path(core: &Core) -> PathBuf {
    core.paths.analytics_dir().join("sessions.json")
}
fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}
/// Every day before yesterday read, as after a first open that ended before today began.
fn read_until_yesterday(data: &Path) {
    let dir = data.join("analytics");
    std::fs::create_dir_all(&dir).unwrap();
    State {
        days_done: (2..90).map(key).collect(),
        ..Default::default()
    }
    .save(&dir)
    .unwrap();
}
/// A first open where the window 11-14..11-16 fails and, read day by day, only 11-15 does.
async fn first_open_with_a_bad_day(dir: &Path) -> (Arc<Core>, Arc<FakeAnalyticsCli>) {
    let cli = Arc::new(FakeAnalyticsCli::new());
    cli.script_export_json(export_day()); // 11-17..11-19
    cli.script_export(Err(out_of_memory())); // 11-14..11-16
    cli.script_export(Ok(ExportOutcome::Empty)); // 11-16
    cli.script_export(Err(out_of_memory())); // 11-15
    let core = core(dir, &cli);
    assert_eq!(refresh(&core).await, json!({"started": true}));
    idle(&core).await;
    (core, cli)
}

#[test]
fn first_open_plans_three_day_windows_newest_first_and_skips_done_days() {
    let plan = plan_first_open(day(TODAY), 90, &BTreeSet::new());
    assert_eq!(plan.len(), 30);
    assert_eq!(plan[0], window("2026-11-17", TODAY));
    assert_eq!(plan[1], window("2026-11-14", "2026-11-16"));
    assert_eq!(plan[29], window("2026-08-22", "2026-08-24"));
    // Days already read are skipped; one read in the middle of a window cuts it in two.
    let done = days(&["2026-11-19", "2026-11-18", "2026-11-17", "2026-11-15"]);
    let plan = plan_first_open(day(TODAY), 90, &done);
    assert_eq!(
        plan[..3],
        [
            window("2026-11-16", "2026-11-16"),
            window("2026-11-12", "2026-11-14"),
            window("2026-11-09", "2026-11-11"),
        ]
    );
    assert_eq!(plan.last(), Some(&window("2026-08-22", "2026-08-22")));
    assert_eq!(plan.len(), 30);
    let all: BTreeSet<String> = (0..90).map(key).collect();
    assert!(plan_first_open(day(TODAY), 90, &all).is_empty());
    assert_eq!(plan_refresh(day(TODAY)), window("2026-11-18", TODAY));
}

#[tokio::test]
async fn a_failed_window_is_retried_day_by_day_and_only_the_bad_day_is_listed() {
    let dir = tempfile::tempdir().unwrap();
    let (core, cli) = first_open_with_a_bad_day(dir.path()).await;
    let calls = exports(&cli);
    assert_eq!(
        calls[..6],
        [
            window("2026-11-17", TODAY),
            window("2026-11-14", "2026-11-16"),
            window("2026-11-16", "2026-11-16"),
            window("2026-11-15", "2026-11-15"),
            window("2026-11-14", "2026-11-14"),
            window("2026-11-11", "2026-11-13"),
        ]
    );
    assert_eq!(calls.len(), 30 + 3);
    let status = ask(&core, Operation::AnalyticsStatus, json!({})).await;
    assert_eq!(status["state"], "ready");
    assert_eq!(status["failedDays"], json!(["2026-11-15"]));
    assert_eq!(status["sessions"], 3);
    assert_eq!(status["storedFrom"], "2026-08-22");
    assert_eq!(status["progress"], Value::Null);
    assert!(status["lastFetchAt"].as_i64().is_some());
    let state = State::load(&core.paths.analytics_dir());
    assert!(state.days_done.contains("2026-11-14") && state.days_done.contains("2026-11-16"));
    assert!(!state.days_done.contains("2026-11-15"));
    assert!(
        !state.days_done.contains(TODAY),
        "today isn't over, so it is read again"
    );
    // The page heard how far the fetch got, window by window, and when it ended.
    let events = core.analytics_events.lock().unwrap().clone();
    let label = "Reading your history, newest first";
    assert_eq!(
        events[0],
        json!({"running": true, "done": 0, "total": 90, "label": label, "failedDays": []})
    );
    assert_eq!(
        events[2],
        json!({"running": true, "done": 6, "total": 90, "label": label, "failedDays": ["2026-11-15"]})
    );
    assert_eq!(
        events.last().unwrap(),
        &json!({"running": false, "done": 90, "total": 90, "label": label, "failedDays": ["2026-11-15"]})
    );
    // Try again reads that day alone and clears it.
    assert_eq!(
        ask(
            &core,
            Operation::AnalyticsRetry,
            json!({"day": "2026-11-15"})
        )
        .await,
        json!({"started": true})
    );
    idle(&core).await;
    assert_eq!(
        exports(&cli).last(),
        Some(&window("2026-11-15", "2026-11-15"))
    );
    let status = ask(&core, Operation::AnalyticsStatus, json!({})).await;
    assert_eq!(status["failedDays"], json!([]));
    for bad in [
        json!({}),
        json!({"day": "15.11.2026"}),
        json!({"day": "2999-01-01"}),
    ] {
        let e = core
            .request(read(Operation::AnalyticsRetry, bad))
            .await
            .unwrap_err();
        assert_eq!(e.code, "validation");
    }
}

#[tokio::test]
async fn refresh_reads_yesterday_to_today_in_one_call() {
    let dir = tempfile::tempdir().unwrap();
    // A new day began: yesterday and today are the only days not read.
    read_until_yesterday(dir.path());
    let cli = Arc::new(FakeAnalyticsCli::new());
    cli.script_export_json(export_day());
    let core = core(dir.path(), &cli);
    assert_eq!(refresh(&core).await, json!({"started": true}));
    idle(&core).await;
    assert_eq!(exports(&cli), [window("2026-11-18", TODAY)]);
    let status = ask(&core, Operation::AnalyticsStatus, json!({})).await;
    assert_eq!(status["state"], "ready");
    assert_eq!(status["sessions"], 3);
    assert!(status["lastFetchAt"].as_i64().is_some());
    let state = State::load(&core.paths.analytics_dir());
    assert!(state.days_done.contains("2026-11-18"));
    assert!(!state.days_done.contains(TODAY));
    // The next refresh is the same single call: it catches sessions that were still running.
    refresh(&core).await;
    idle(&core).await;
    assert_eq!(
        exports(&cli),
        [window("2026-11-18", TODAY), window("2026-11-18", TODAY)]
    );
}

#[tokio::test]
async fn a_second_refresh_while_one_runs_starts_nothing() {
    let dir = tempfile::tempdir().unwrap();
    read_until_yesterday(dir.path());
    let cli = Arc::new(FakeAnalyticsCli::new());
    cli.script_export_held();
    let core = core(dir.path(), &cli);
    assert_eq!(refresh(&core).await, json!({"started": true}));
    exports_reach(&cli, 1).await;
    // The export is running: these all find it, and start no CLI process of any kind.
    assert_eq!(refresh(&core).await, json!({"running": true}));
    assert_eq!(
        ask(&core, Operation::AnalyticsRefresh, json!({})).await,
        json!({"running": true})
    );
    assert_eq!(
        ask(
            &core,
            Operation::AnalyticsRetry,
            json!({"day": "2026-11-15"})
        )
        .await,
        json!({"running": true})
    );
    assert_eq!(kinds(&cli), ["supports_view", "export"]);
    let status = ask(&core, Operation::AnalyticsStatus, json!({})).await;
    assert_eq!(status["state"], "running");
    assert_eq!(
        status["progress"],
        json!({"done": 0, "total": 2, "label": "Reading yesterday and today"})
    );
    cli.release();
    idle(&core).await;
    assert_eq!(
        kinds(&cli),
        ["supports_view", "export", "supports_view"],
        "one export; the only other call is the status's own check"
    );
    let status = ask(&core, Operation::AnalyticsStatus, json!({})).await;
    assert_eq!(status["state"], "empty");
}

#[tokio::test]
async fn a_restart_continues_with_the_days_not_yet_read() {
    let dir = tempfile::tempdir().unwrap();
    // Two windows are read, then the CLI goes away, as when Connect quits in the middle.
    let cli = Arc::new(FakeAnalyticsCli::new());
    cli.script_export(Ok(ExportOutcome::Empty));
    cli.script_export(Ok(ExportOutcome::Empty));
    cli.script_export(Err(CliError::NotFound));
    let first = core(dir.path(), &cli);
    refresh(&first).await;
    idle(&first).await;
    assert_eq!(
        exports(&cli),
        [
            window("2026-11-17", TODAY),
            window("2026-11-14", "2026-11-16"),
            window("2026-11-11", "2026-11-13"),
        ]
    );
    let saved = State::load(&first.paths.analytics_dir());
    assert_eq!(saved.days_done, (1..=5).map(key).collect());
    assert!(saved.failed_days.is_empty(), "a missing CLI fails no day");
    assert_eq!(saved.last_fetch_at, None, "the run didn't finish");
    drop(first);
    // The next start reads today again (it wasn't over) and then only the days not read.
    let cli = Arc::new(FakeAnalyticsCli::new());
    let next = core(dir.path(), &cli);
    refresh(&next).await;
    idle(&next).await;
    let plan = exports(&cli);
    assert_eq!(
        plan[..2],
        [window(TODAY, TODAY), window("2026-11-11", "2026-11-13")]
    );
    assert_eq!(plan.len(), 1 + 28);
    assert!(State::load(&next.paths.analytics_dir())
        .last_fetch_at
        .is_some());
}

#[tokio::test]
async fn view_passes_filters_to_the_cli_and_returns_its_json_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    cli.script_view(Ok(summary()));
    cli.script_view(Ok(summary()));
    let core = core(dir.path(), &cli);
    // The store is empty: the CLI still answers (its own empty summary), Connect adds nothing.
    assert_eq!(
        ask(&core, Operation::AnalyticsStatus, json!({})).await["sessions"],
        0
    );
    let answer = ask(
        &core,
        Operation::AnalyticsView,
        json!({"from": FROM, "to": TO, "agent": "claude", "compare": true}),
    )
    .await;
    let mut expected = summary();
    expected["connect"] = json!({"startedInConnect": []});
    assert_eq!(answer, expected);
    assert_eq!(
        last_view(&cli),
        (
            store_path(&core),
            strings(&["--from", FROM, "--to", TO, "--agent", "claude", "--compare"])
        )
    );
    ask(
        &core,
        Operation::AnalyticsView,
        json!({"from": FROM, "to": TO, "agent": null, "project": "/Users/taylor/shop", "compare": false}),
    )
    .await;
    assert_eq!(
        last_view(&cli).1,
        strings(&[
            "--from",
            FROM,
            "--to",
            TO,
            "--project",
            "/Users/taylor/shop"
        ])
    );
    // Refused before the CLI runs: a range that isn't a time, a filter that would read as a flag.
    for bad in [
        json!({"from": "yesterday", "to": TO}),
        json!({"from": FROM}),
        json!({"from": FROM, "to": TO, "agent": "--export"}),
    ] {
        let e = core
            .request(read(Operation::AnalyticsView, bad))
            .await
            .unwrap_err();
        assert_eq!(e.code, "validation");
    }
    let views = cli
        .calls()
        .into_iter()
        .filter(|c| matches!(c, FakeCall::View { .. }))
        .count();
    assert_eq!(views, 2);
    // A CLI that fails is an error the page can show.
    cli.script_view(Err(CliError::Timeout));
    let e = core
        .request(read(
            Operation::AnalyticsView,
            json!({"from": FROM, "to": TO}),
        ))
        .await
        .unwrap_err();
    assert_eq!(e.code, "timeout");
}

/// A summary whose `sessions` rows are `(id, startTime, project)`.
fn summary_with(rows: &[(&str, i64, &str)]) -> Value {
    let mut s = summary();
    s["sessions"] = json!(rows
        .iter()
        .map(
            |(id, start, project)| json!({"sessionId": id, "startTime": start, "project": project})
        )
        .collect::<Vec<_>>());
    s
}

async fn view_answer(core: &Arc<Core>) -> Value {
    ask(
        core,
        Operation::AnalyticsView,
        json!({"from": FROM, "to": TO}),
    )
    .await
}

#[tokio::test]
async fn view_reads_the_cli_output_from_a_file_not_stdout() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    // A CLI that prints a banner before anything else and writes its JSON to the -o file.
    let script = dir.path().join("codemie");
    std::fs::write(
        &script,
        "#!/bin/sh\necho 'Migrating settings...'\necho '{\"junk\": true}'\nwhile [ $# -gt 0 ]; do if [ \"$1\" = -o ]; then out=\"$2\"; fi; shift; done\nprintf '%s' '{\"schema\":\"codemie.analytics.summary/1\",\"sessions\":[]}' > \"$out\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let paths = CorePaths {
        data: dir.path().join("data"),
        private: dir.path().join("private"),
    };
    std::fs::create_dir_all(&paths.data).unwrap();
    std::fs::create_dir_all(&paths.private).unwrap();
    let core = Core::open_with(
        None,
        &paths,
        Arc::new(FakeRunner::new(vec![])),
        ProfileCache::fixed(vec![]),
        Arc::new(FakeGraph::default()),
        Arc::new(super::cli::CodemieCli::with_program(script)),
    )
    .unwrap();
    let answer = view_answer(&core).await;
    assert_eq!(answer["schema"], "codemie.analytics.summary/1");
    assert!(answer.get("junk").is_none());
    let left: Vec<String> = std::fs::read_dir(paths.analytics_dir())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("view-"))
        .collect();
    assert!(left.is_empty(), "the temp file is removed: {left:?}");
}

#[tokio::test]
async fn view_lists_sessions_started_in_connect() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let t = 1_795_000_000_000i64;
    let folder = "/Users/taylor/work/sync-engine";
    cli.script_view(Ok(summary_with(&[
        ("near", t + 119_000, folder),
        ("far", t + 400_000, folder),
        ("elsewhere", t + 1_000, "/Users/taylor/other"),
    ])));
    // Two launches: the first matches "near" (119 s); the second, 121 s from "far", matches nothing.
    let log = format!(
        "{}\n{}\n",
        json!({"at": t, "folder": folder, "program": "claude"}),
        json!({"at": t + 400_000 + 121_000, "folder": folder, "program": "claude"}),
    );
    std::fs::write(dir.path().join("terminal-launches.jsonl"), log).unwrap();
    let core = core(dir.path(), &cli);
    let answer = view_answer(&core).await;
    assert_eq!(answer["connect"], json!({"startedInConnect": ["near"]}));
    assert_eq!(
        answer["schema"],
        summary()["schema"],
        "the CLI JSON is kept"
    );
}

#[tokio::test]
async fn view_without_a_launch_log_lists_none() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    cli.script_view(Ok(summary_with(&[("a", 1_795_000_000_000, "/x")])));
    let core = core(dir.path(), &cli);
    let answer = view_answer(&core).await;
    assert_eq!(answer["connect"], json!({"startedInConnect": []}));
}

#[tokio::test]
async fn session_returns_the_cli_trace_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    cli.script_view(Ok(session()));
    let core = core(dir.path(), &cli);
    let answer = ask(
        &core,
        Operation::AnalyticsSession,
        json!({"id": SESSION_ID}),
    )
    .await;
    assert_eq!(answer, session());
    assert_eq!(
        last_view(&cli),
        (store_path(&core), strings(&["--session", SESSION_ID]))
    );
    for bad in [json!({}), json!({"id": "--export"})] {
        let e = core
            .request(read(Operation::AnalyticsSession, bad))
            .await
            .unwrap_err();
        assert_eq!(e.code, "validation");
    }
}

#[tokio::test]
async fn report_is_written_by_the_cli_into_the_data_root_and_opened() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    let mut opened = Vec::new();
    let answer = core
        .analytics_report(
            &json!({"from": FROM, "to": TO, "agent": "claude"}),
            |p: &Path| {
                opened.push(p.to_path_buf());
                Ok(())
            },
        )
        .await
        .unwrap();
    assert_eq!(answer, json!({"opened": true}));
    let out = core.paths.analytics_dir().join("report.html");
    assert_eq!(opened, std::slice::from_ref(&out));
    assert_eq!(
        cli.calls().last(),
        Some(&FakeCall::Report {
            input: store_path(&core),
            args: strings(&["--from", FROM, "--to", TO, "--agent", "claude"]),
            out,
        })
    );
    // A report the CLI couldn't write opens nothing.
    cli.script_report(Err(out_of_memory()));
    let e = core
        .analytics_report(&json!({"from": FROM, "to": TO}), |p: &Path| {
            panic!("opened {}", p.display())
        })
        .await
        .unwrap_err();
    assert_eq!(e.code, "cli_failed");
}

#[tokio::test]
async fn without_view_support_status_is_needs_cli_and_no_fetch_starts() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    cli.set_supports_view(false);
    let core = core(dir.path(), &cli);
    let status = ask(&core, Operation::AnalyticsStatus, json!({})).await;
    assert_eq!(status["state"], "needs_cli");
    assert_eq!(status["progress"], Value::Null);
    assert_eq!(
        ask(&core, Operation::AnalyticsRefresh, json!({})).await,
        json!({"needsCli": true})
    );
    assert_eq!(
        ask(
            &core,
            Operation::AnalyticsRetry,
            json!({"day": "2026-11-15"})
        )
        .await,
        json!({"needsCli": true})
    );
    assert!(core.analytics_run.lock().unwrap().is_none());
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(exports(&cli).is_empty(), "no CLI export ran");
    // With a CLI that can answer, an empty store reads as empty.
    cli.set_supports_view(true);
    let status = ask(&core, Operation::AnalyticsStatus, json!({})).await;
    assert_eq!(status["state"], "empty");
}

#[tokio::test]
async fn the_store_follows_the_data_root() {
    let dir = tempfile::tempdir().unwrap();
    let paths = CorePaths {
        data: dir.path().join("Picked").join("CodeMie Connect Data"),
        private: dir.path().join("private"),
    };
    std::fs::create_dir_all(&paths.data).unwrap();
    read_until_yesterday(&paths.data);
    let cli = Arc::new(FakeAnalyticsCli::new());
    cli.script_view(Ok(summary()));
    cli.script_export_json(export_day());
    let core = core_on(&paths, &cli);
    ask(
        &core,
        Operation::AnalyticsView,
        json!({"from": FROM, "to": TO}),
    )
    .await;
    let store = paths.analytics_dir().join("sessions.json");
    assert!(store.starts_with(&paths.data));
    assert_eq!(last_view(&cli).0, store);
    refresh(&core).await;
    idle(&core).await;
    let out = cli
        .calls()
        .into_iter()
        .find_map(|c| match c {
            FakeCall::Export { out, .. } => Some(out),
            _ => None,
        })
        .unwrap();
    assert!(out.starts_with(paths.analytics_dir()));
    assert_eq!(
        ask(&core, Operation::AnalyticsStatus, json!({})).await["sessions"],
        3
    );
    assert!(State::load(&paths.analytics_dir())
        .days_done
        .contains("2026-11-18"));
    assert!(!paths.private.join("analytics").exists());
}

#[tokio::test]
async fn an_unreadable_store_starts_a_fresh_first_open() {
    let dir = tempfile::tempdir().unwrap();
    // Every day was read, then sessions.json was damaged (a manual edit, a full disk).
    read_until_yesterday(dir.path());
    std::fs::write(dir.path().join("analytics/sessions.json"), "{\"sessi").unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let core = core(dir.path(), &cli);
    refresh(&core).await;
    idle(&core).await;
    assert!(dir.path().join("analytics/sessions.json.bad").exists());
    let plan = exports(&cli);
    assert_eq!(plan.len(), 30, "the days it held are read again");
    assert_eq!(plan[0], window("2026-11-17", TODAY));
}

#[tokio::test]
async fn stopping_connect_during_a_fetch_kills_the_cli_and_marks_nothing_read() {
    let dir = tempfile::tempdir().unwrap();
    let cli = Arc::new(FakeAnalyticsCli::new());
    cli.script_export_held();
    let first = core(dir.path(), &cli);
    refresh(&first).await;
    exports_reach(&cli, 1).await;
    // Quitting stops the CLI at once: the process exits without dropping the fetch's task.
    first.stop_background();
    assert_eq!(kinds(&cli).last(), Some(&"stop"));
    idle(&first).await;
    assert_eq!(
        exports(&cli),
        [window("2026-11-17", TODAY)],
        "nothing more is read"
    );
    let state = State::load(&first.paths.analytics_dir());
    assert!(
        state.days_done.is_empty(),
        "the interrupted window stays unread"
    );
    assert!(state.failed_days.is_empty(), "and isn't listed as failed");
    assert_eq!(state.last_fetch_at, None);
    // What a killed CLI left half written is swept away at the next start.
    let leftover = export_outs(&cli)[0].clone();
    std::fs::write(&leftover, "{\"meta\":").unwrap();
    drop(first);
    let cli = Arc::new(FakeAnalyticsCli::new());
    let next = core(dir.path(), &cli);
    refresh(&next).await;
    idle(&next).await;
    assert!(!leftover.exists());
    assert_eq!(exports(&cli)[0], window("2026-11-17", TODAY));
    let outs = export_outs(&cli);
    assert!(
        outs.iter().all(|out| *out != leftover),
        "every call writes a file of its own"
    );
    assert_eq!(outs.iter().collect::<BTreeSet<_>>().len(), outs.len());
    assert!(
        outs.iter().all(|out| !out.exists()),
        "each is removed once read"
    );
}

#[tokio::test]
async fn a_data_folder_move_takes_the_analytics_along() {
    use crate::storage::migrate::{tests::Fixture, Mode};
    use crate::storage::old_copy::remove_old;
    let f = Fixture::new();
    // A first open that finished: its sessions and the days it read.
    let analytics = f.default.join("analytics");
    Store::open(&analytics).merge(&export_day()).unwrap();
    State {
        days_done: (1..90).map(key).collect(),
        ..Default::default()
    }
    .save(&analytics)
    .unwrap();
    let sessions = std::fs::read(analytics.join("sessions.json")).unwrap();
    let state = std::fs::read(analytics.join("state.json")).unwrap();
    let target = f.change(Mode::Move).unwrap();
    assert_eq!(
        std::fs::read(target.join("analytics/sessions.json")).unwrap(),
        sessions
    );
    assert_eq!(
        std::fs::read(target.join("analytics/state.json")).unwrap(),
        state
    );
    // The next start opens the new folder and reads only yesterday and today.
    f.core.release_for_restart();
    let cli = Arc::new(FakeAnalyticsCli::new());
    let moved = crate::workspace::startup(&f.default, |paths| Ok(core_on(paths, &cli)))
        .core
        .unwrap();
    assert_eq!(moved.paths.analytics_dir(), target.join("analytics"));
    refresh(&moved).await;
    idle(&moved).await;
    assert_eq!(
        exports(&cli),
        [window("2026-11-18", TODAY)],
        "no new first open"
    );
    assert_eq!(
        ask(&moved, Operation::AnalyticsStatus, json!({})).await["sessions"],
        3
    );
    // Remove old copy takes the analytics the move left behind.
    remove_old(&f.default).unwrap();
    assert!(!analytics.exists());
    assert!(target.join("analytics/sessions.json").is_file());
}

#[tokio::test]
async fn contract_fixtures_match_the_real_analytics() {
    let dir = tempfile::tempdir().unwrap();
    let (core, cli) = first_open_with_a_bad_day(dir.path()).await;
    let mut status = ask(&core, Operation::AnalyticsStatus, json!({})).await;
    // A fixed time: the real one changes on every run.
    status["lastFetchAt"] = json!(1_795_132_800_000i64);
    // The event after the second window: one day of it couldn't be read.
    let progress = core.analytics_events.lock().unwrap()[2].clone();
    cli.script_view(Ok(summary()));
    cli.script_view(Ok(session()));
    let summary = ask(
        &core,
        Operation::AnalyticsView,
        json!({"from": FROM, "to": TO}),
    )
    .await;
    let session = ask(
        &core,
        Operation::AnalyticsSession,
        json!({"id": SESSION_ID}),
    )
    .await;
    // A fetch in its second window, and a refresh pressed meanwhile.
    let running_dir = tempfile::tempdir().unwrap();
    let running_cli = Arc::new(FakeAnalyticsCli::new());
    running_cli.script_export(Ok(ExportOutcome::Empty));
    running_cli.script_export_held();
    let running = self::core(running_dir.path(), &running_cli);
    refresh(&running).await;
    exports_reach(&running_cli, 2).await;
    let status_running = ask(&running, Operation::AnalyticsStatus, json!({})).await;
    assert_eq!(status_running["progress"]["done"], 3);
    let refresh_running = ask(&running, Operation::AnalyticsRefresh, json!({})).await;
    running_cli.release();
    idle(&running).await;
    // A CLI without `analytics view`.
    let old_dir = tempfile::tempdir().unwrap();
    let old_cli = Arc::new(FakeAnalyticsCli::new());
    old_cli.set_supports_view(false);
    let old = self::core(old_dir.path(), &old_cli);
    let refresh_needs_cli = ask(&old, Operation::AnalyticsRefresh, json!({})).await;
    use crate::plugins::testkit::contract_fixture;
    contract_fixture("analytics-status-running.json", &status_running);
    contract_fixture("analytics-refresh-running.json", &refresh_running);
    contract_fixture("analytics-refresh-needs-cli.json", &refresh_needs_cli);
    contract_fixture("analytics-status.json", &status);
    contract_fixture("analytics-progress.json", &progress);
    contract_fixture("analytics-summary.json", &summary);
    contract_fixture("analytics-session.json", &session);
}
