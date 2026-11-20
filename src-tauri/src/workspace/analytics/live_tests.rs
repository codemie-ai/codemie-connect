//! Live checks of the analytics backend, the headless real-app pass: a real `Core` with the real
//! [`CodemieCli`], resolved as `Core::open` resolves it, against the CodeMie CLI on `PATH` and
//! this Mac's own agent logs. Every test is `#[ignore]`, like the `live_*` Claude tests in
//! `ai/runner.rs`: a first open reads 90 days of logs (minutes to tens of minutes, up to the
//! 6 GB heap per CLI call). Run them by hand, one at a time, with a `codemie` that has
//! `analytics view` first on `PATH`:
//!
//! ```text
//! cd src-tauri && PATH=<folder of that codemie>:$PATH cargo test live_ -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Nothing here starts Claude or a model: the runner is a `FakeRunner` with nothing scripted, a
//! terminal launch is a line written to the launch log, and Connect's runs are seeded records.
//! Each test prints one line of counts, sums, times and session ids, never a title, prompt,
//! project path or branch; a failed check names counts and fields, not records.
//!
//! The CLI is reached through a pass-through `codemie` (a shell script that notes its pid and
//! arguments, then `exec`s the real one), so a test can tell which windows were read and which
//! processes ran. The first open that `live_first_open_reads_history_newest_first` makes stays in
//! `$TMPDIR/connect-analytics-live/history` for the other tests, which make one there first when
//! there is none. It is a copy of this Mac's sessions: delete the folder when done.
use super::cli::CodemieCli;
use super::store::State;
use super::tests::{ask, read};
use crate::ai::discover::find_program_in;
use crate::ai::fake::FakeRunner;
use crate::ai::profiles::{DetectEnv, ProfileCache};
use crate::workspace::ai_jobs::FakeGraph;
use crate::workspace::models::{id, Operation, Record};
use crate::workspace::{Core, CorePaths};
use chrono::{DateTime, Days, NaiveDate, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The heap Connect gives every CLI call; the direct calls here use it too.
const HEAP: &str = "--max-old-space-size=6144";
/// How long M1 lets a first open take.
const FIRST_OPEN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// How long a first open that other checks build on may take: each day the CLI can't read
/// costs a failed call of its own.
const SETUP_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
/// A refresh is one call over two days.
const REFRESH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// A difference smaller than this is the same amount of money.
const CENT: f64 = 0.005;

fn key(day: NaiveDate) -> String {
    day.format("%Y-%m-%d").to_string()
}

fn iso(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn secs(d: Duration) -> f64 {
    d.as_secs_f64()
}

/// The `codemie` that `Core::open` would run: the first on this process's PATH, then the usual
/// install folders under HOME.
fn real_codemie() -> PathBuf {
    let env = DetectEnv::system(Vec::new());
    find_program_in("codemie", &env.path_var, &env.home, &env.extra_dirs)
        .expect("no codemie on PATH or in the usual install folders")
}

/// A `codemie` in `dir/bin` that notes each call as `<pid> <arguments>` in `dir/calls.log`, then
/// becomes `target` (`exec` keeps the pid, so the pid noted is the CLI's own and leads its
/// process group). Returns the `bin` folder, to put first on the CLI's PATH.
fn shim(dir: &Path, target: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = format!(
        "#!/bin/sh\nprintf '%s %s\\n' \"$$\" \"$*\" >> '{}'\nexec '{}' \"$@\"\n",
        dir.join("calls.log").display(),
        target.display()
    );
    let path = bin.join("codemie");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

/// One CLI call the shim noted.
struct Call {
    pid: i32,
    args: Vec<String>,
}

fn calls(dir: &Path) -> Vec<Call> {
    std::fs::read_to_string(dir.join("calls.log"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let mut parts = line.split(' ');
            let pid = parts.next()?.parse().ok()?;
            Some(Call {
                pid,
                args: parts.map(str::to_string).collect(),
            })
        })
        .collect()
}

/// The export calls (`analytics --from D --to D …`) among `calls`, in order, with their pids.
fn exports(calls: &[Call]) -> Vec<(i32, NaiveDate, NaiveDate)> {
    calls
        .iter()
        .filter_map(|c| {
            let arg = |i: usize| c.args.get(i).map(String::as_str);
            if arg(0) != Some("analytics") || arg(1) != Some("--from") || arg(3) != Some("--to") {
                return None;
            }
            let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
            Some((c.pid, day(arg(2)?)?, day(arg(4)?)?))
        })
        .collect()
}

fn windows(calls: &[Call]) -> Vec<(NaiveDate, NaiveDate)> {
    exports(calls).into_iter().map(|(_, f, t)| (f, t)).collect()
}

fn days_of(windows: &[(NaiveDate, NaiveDate)]) -> BTreeSet<NaiveDate> {
    windows
        .iter()
        .flat_map(|&(from, to)| from.iter_days().take_while(move |d| *d <= to))
        .collect()
}

/// A `Core` over `data` (data and private files in one folder, the default layout) with the real
/// `CodemieCli` found as `Core::open` finds it, `shim` first on its PATH. The runner is a
/// `FakeRunner` with nothing scripted, so nothing can start Claude.
fn live_core(data: &Path, shim: &Path) -> Arc<Core> {
    std::fs::create_dir_all(data).unwrap();
    let mut env = DetectEnv::system(Vec::new());
    env.path_var = format!("{}:{}", shim.display(), env.path_var);
    Core::open_with(
        None,
        &CorePaths {
            data: data.into(),
            private: data.into(),
        },
        Arc::new(FakeRunner::new(vec![])),
        ProfileCache::fixed(vec![]),
        Arc::new(FakeGraph::default()),
        Arc::new(CodemieCli::new(env)),
    )
    .unwrap()
}

fn running(core: &Core) -> bool {
    core.analytics_run.lock().unwrap().is_some()
}

async fn wait_idle(core: &Core, timeout: Duration) -> Duration {
    let started = Instant::now();
    while running(core) {
        assert!(
            started.elapsed() < timeout,
            "the fetch still runs after {} s: {}",
            timeout.as_secs(),
            days_so_far(&core.paths.analytics_dir())
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    started.elapsed()
}

/// How far the fetch state in `dir` got, in days.
fn days_so_far(dir: &Path) -> String {
    let s = State::load(dir);
    format!(
        "{} days read, {} failed (oldest read {}, newest failed {})",
        s.days_done.len(),
        s.failed_days.len(),
        s.days_done.first().map_or("-", String::as_str),
        s.failed_days.last().map_or("-", String::as_str),
    )
}

/// [`days_so_far`] and the CLI calls the shim in `cli_dir` noted.
fn so_far_in(dir: &Path, cli_dir: &Path) -> String {
    let all = calls(cli_dir);
    format!(
        "{}, {} CLI calls ({} exports)",
        days_so_far(dir),
        all.len(),
        exports(&all).len()
    )
}

fn so_far(core: &Core, cli_dir: &Path) -> String {
    so_far_in(&core.paths.analytics_dir(), cli_dir)
}

/// The CLI's temp files left in the analytics folder.
fn temp_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| (n.starts_with("export-") || n.starts_with("view-")) && n.ends_with(".json"))
        .collect()
}

/// Whether nothing is left of `pid`; a negative pid asks for the whole process group. A killed
/// process its parent hasn't reaped yet still counts as there.
fn gone(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process or group exists.
    let answer = unsafe { libc::kill(pid, 0) };
    answer == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

fn sessions_json(data: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(data.join("analytics/sessions.json")).unwrap()).unwrap()
}

fn rows(export: &Value) -> Vec<Value> {
    export["sessions"].as_array().cloned().unwrap_or_default()
}

/// When a session's record stops, as the store's merge reads it.
fn ends(row: &Value) -> i64 {
    row["observedEnd"].as_i64().unwrap_or_else(|| {
        row["startTime"].as_i64().unwrap_or(0) + row["durationMs"].as_i64().unwrap_or(0)
    })
}

fn cost(row: &Value) -> f64 {
    row["costUSD"].as_f64().unwrap_or(0.0)
}

/// Runs the CLI as a person would, outside Connect, with the raised heap.
async fn codemie(args: &[&str]) {
    let out = tokio::process::Command::new(real_codemie())
        .args(args)
        .env("NODE_OPTIONS", HEAP)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    let last = stderr.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("");
    assert!(
        out.status.success(),
        "codemie {} ended with {:?}: {last}",
        args[..2].join(" "),
        out.status.code()
    );
}

/// `codemie analytics --from <from> --to <to> --include-external always --export json -o <out>`.
/// The CLI writes no file when it finds no session; `out` then holds an empty export.
async fn direct_export(from: NaiveDate, to: NaiveDate, out: &Path) -> Value {
    let (from, to, path) = (key(from), key(to), out.to_string_lossy());
    codemie(&[
        "analytics",
        "--from",
        &from,
        "--to",
        &to,
        "--include-external",
        "always",
        "--export",
        "json",
        "-o",
        &path,
    ])
    .await;
    if !out.exists() {
        std::fs::write(out, r#"{"meta":{"periodStart":null},"sessions":[]}"#).unwrap();
    }
    serde_json::from_slice(&std::fs::read(out).unwrap()).unwrap()
}

/// `codemie analytics view --input <input> <args> -o <file>`: the JSON it wrote.
async fn direct_view(input: &Path, args: &[&str]) -> Value {
    let out = input.with_file_name(format!("direct-view-{}.json", id()));
    let (input, path) = (input.to_string_lossy(), out.to_string_lossy());
    let mut all = vec!["analytics", "view", "--input", &*input];
    all.extend_from_slice(args);
    all.extend(["-o", &*path]);
    codemie(&all).await;
    let answer = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
    let _ = std::fs::remove_file(&out);
    answer
}

/// What a first open measured.
struct FirstOpen {
    today: NaiveDate,
    /// Until the first window's days were in `state.json`.
    first_window: Duration,
    /// Until the fetch stopped running.
    total: Duration,
    windows: Vec<(NaiveDate, NaiveDate)>,
}

/// Opens the page on an empty data folder: the status, then `analytics_refresh`, waited out
/// for up to `timeout`.
async fn first_open(core: &Arc<Core>, cli_dir: &Path, timeout: Duration) -> FirstOpen {
    let status = ask(core, Operation::AnalyticsStatus, json!({})).await;
    assert_ne!(
        status["state"], "needs_cli",
        "the codemie found has no `analytics view`: put the CLI branch build first on PATH"
    );
    assert_eq!(status["state"], "empty", "a new data folder holds nothing");
    let today = Utc::now().date_naive();
    // The first window is today and the two days before; today stays unread until it is over.
    let first_days = [key(today - Days::new(1)), key(today - Days::new(2))];
    let dir = core.paths.analytics_dir();
    let first_done = || {
        let s = State::load(&dir);
        first_days
            .iter()
            .all(|d| s.days_done.contains(d) || s.failed_days.contains(d))
    };
    let started = Instant::now();
    assert_eq!(
        ask(core, Operation::AnalyticsRefresh, json!({})).await,
        json!({"started": true})
    );
    let mut first_window = None;
    while running(core) {
        if first_window.is_none() && first_done() {
            first_window = Some(started.elapsed());
        }
        assert!(
            started.elapsed() < timeout,
            "the first open still runs after {} min (first window done in {}): {}",
            timeout.as_secs() / 60,
            first_window.map_or("-".into(), |d| format!("{:.0} s", secs(d))),
            so_far(core, cli_dir)
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let total = started.elapsed();
    assert!(
        first_done(),
        "the first window's days are neither read nor failed"
    );
    FirstOpen {
        today,
        first_window: first_window.unwrap_or(total),
        total,
        windows: windows(&calls(cli_dir)),
    }
}

/// Where the shared first open lives.
fn live_root() -> PathBuf {
    std::env::temp_dir().join("connect-analytics-live")
}

/// A first open in the shared folder, from nothing.
async fn fresh_history(timeout: Duration) -> (Arc<Core>, FirstOpen) {
    let root = live_root();
    let _ = std::fs::remove_dir_all(&root);
    let core = live_core(
        &root.join("history"),
        &shim(&root.join("cli"), &real_codemie()),
    );
    let run = first_open(&core, &root.join("cli"), timeout).await;
    (core, run)
}

/// The shared data folder with a finished first open. One is made first when there is none; one
/// that didn't finish (M1 ran out of time) goes on where it stopped, as the next start of the app
/// would.
async fn history() -> PathBuf {
    let root = live_root();
    let data = root.join("history");
    let state = State::load(&data.join("analytics"));
    if state.last_fetch_at.is_some() {
        return data;
    }
    let started = Instant::now();
    if state.days_done.is_empty() && state.failed_days.is_empty() {
        println!("(no first open to share yet: making one, which takes minutes)");
        drop(fresh_history(SETUP_TIMEOUT).await);
    } else {
        println!("(the shared first open didn't finish: going on with it)");
        let core = live_core(&data, &shim(&root.join("cli"), &real_codemie()));
        assert_eq!(
            ask(&core, Operation::AnalyticsRefresh, json!({})).await,
            json!({"started": true})
        );
        wait_idle(&core, SETUP_TIMEOUT).await;
    }
    println!(
        "(shared first open finished in {:.0} s: {})",
        secs(started.elapsed()),
        so_far_in(&data.join("analytics"), &root.join("cli"))
    );
    data
}

/// A new data folder in `tmp` holding a copy of the shared store and its state.
fn copy_of_history(history: &Path, tmp: &Path) -> PathBuf {
    let data = tmp.join("data");
    std::fs::create_dir_all(data.join("analytics")).unwrap();
    for name in ["sessions.json", "state.json"] {
        std::fs::copy(
            history.join("analytics").join(name),
            data.join("analytics").join(name),
        )
        .unwrap();
    }
    data
}

/// M1: a first open reads 90 days, newest first, into a store with sessions and no temp files.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_first_open_reads_history_newest_first() {
    let (core, run) = fresh_history(FIRST_OPEN_TIMEOUT).await;
    let status = ask(&core, Operation::AnalyticsStatus, json!({})).await;
    let state = State::load(&core.paths.analytics_dir());
    let sessions = status["sessions"].as_u64().unwrap_or(0);
    println!(
        "M1 first open: {sessions} sessions, {} days read, {} failed day(s) {:?}, {} CLI calls; first window in {:.0} s, whole first open in {:.0} s",
        state.days_done.len(),
        state.failed_days.len(),
        state.failed_days,
        run.windows.len(),
        secs(run.first_window),
        secs(run.total),
    );
    assert_eq!(status["state"], "ready");
    assert!(sessions > 0, "the store is empty after reading 90 days");
    assert!(state.last_fetch_at.is_some(), "the fetch didn't finish");
    // Newest first: no call reaches past the end of the one before it (a failed window is read
    // again day by day, newest first, inside itself).
    assert_eq!(run.windows.first().map(|w| w.1), Some(run.today));
    for (i, pair) in run.windows.windows(2).enumerate() {
        assert!(
            pair[1].1 <= pair[0].1,
            "call {} ({:?}) reads days after call {} ({:?})",
            i + 2,
            pair[1],
            i + 1,
            pair[0]
        );
    }
    let read = days_of(&run.windows);
    assert_eq!(read.len(), 90, "the calls cover {} days", read.len());
    assert_eq!(read.first(), Some(&(run.today - Days::new(89))));
    let left = temp_files(&core.paths.analytics_dir());
    assert!(left.is_empty(), "the CLI's temp files are left: {left:?}");
    // The page heard the end of the run.
    let events = core.analytics_events.lock().unwrap().clone();
    let last = events.last().expect("no progress event");
    assert_eq!(last["running"], false);
    assert_eq!(last["done"], last["total"]);
}

/// M2: the last 7 UTC days from Connect's store against one direct CLI export of them.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_numbers_equal_a_direct_cli_export() {
    let data = history().await;
    let tmp = tempfile::tempdir().unwrap();
    let core = live_core(&data, &shim(tmp.path(), &real_codemie()));
    // Brought up to now first, as opening the page does.
    let now = Utc::now();
    assert_eq!(
        ask(&core, Operation::AnalyticsRefresh, json!({})).await,
        json!({"started": true})
    );
    let refresh = wait_idle(&core, REFRESH_TIMEOUT).await;
    let today = now.date_naive();
    let from_day = today - Days::new(6);
    let from = format!("{}T00:00:00Z", key(from_day));
    // Up to when the refresh began: a session started after it can only be in the direct export.
    let to = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let ours = ask(
        &core,
        Operation::AnalyticsView,
        json!({"from": from, "to": to}),
    )
    .await;
    let export = tmp.path().join("direct.json");
    let started = Instant::now();
    let direct = direct_export(from_day, today, &export).await;
    let export_secs = secs(started.elapsed());
    let theirs = direct_view(&export, &["--from", &from, "--to", &to]).await;

    let (from_ms, to_ms) = (
        DateTime::parse_from_rfc3339(&from)
            .unwrap()
            .timestamp_millis(),
        now.timestamp_millis(),
    );
    let all = rows(&direct);
    let exported: BTreeSet<String> = all
        .iter()
        .filter(|r| {
            r["startTime"]
                .as_i64()
                .is_some_and(|t| (from_ms..=to_ms).contains(&t))
        })
        .filter_map(|r| r["sessionId"].as_str().map(str::to_string))
        .collect();
    let later = all
        .iter()
        .filter(|r| r["startTime"].as_i64().is_some_and(|t| t > to_ms))
        .count();
    let costs = |summary: &Value| -> BTreeMap<String, f64> {
        rows(summary)
            .iter()
            .filter_map(|r| Some((r["sessionId"].as_str()?.to_string(), cost(r))))
            .collect()
    };
    let (ours_cost, theirs_cost) = (costs(&ours), costs(&theirs));
    let only_ours = ours_cost
        .keys()
        .filter(|k| !theirs_cost.contains_key(*k))
        .count();
    let only_theirs = theirs_cost
        .keys()
        .filter(|k| !ours_cost.contains_key(*k))
        .count();
    // A session priced differently either grew after the store last read it (it was still
    // running), or is the same capture priced in another window (a resumed session).
    let ends_of = |rows: &[Value]| -> HashMap<String, i64> {
        rows.iter()
            .filter_map(|r| Some((r["sessionId"].as_str()?.to_string(), ends(r))))
            .collect()
    };
    let (stored_ends, exported_ends) = (ends_of(&rows(&sessions_json(&data))), ends_of(&all));
    let gaps: Vec<(f64, bool)> = ours_cost
        .iter()
        .filter_map(|(id, c)| {
            let grew = stored_ends.get(id) != exported_ends.get(id);
            theirs_cost.get(id).map(|t| (c - t, grew))
        })
        .filter(|(d, _)| d.abs() >= CENT)
        .collect();
    let grew = gaps.iter().filter(|(_, grew)| *grew).count();
    let total = |v: &Value, k: &str| v["totals"][k].as_f64().unwrap_or(f64::NAN);
    println!(
        "M2 last 7 UTC days ({}..now): sessions Connect {} / direct export {} (CLI view of it {}; {} id(s) only in Connect, {} only in the export, {later} started after the refresh) | cost Connect ${:.2} / export ${:.2}, {} session(s) priced differently (Connect higher in {}, lower in {}, net ${:+.2}; {grew} of them grew after the store read them, {} are the same capture) | turns {} / {} | tool success {:.1}% / {:.1}% | refresh {:.0} s, direct export {:.0} s",
        key(from_day),
        ours["totals"]["sessions"],
        exported.len(),
        theirs["totals"]["sessions"],
        only_ours,
        only_theirs,
        total(&ours, "costUSD"),
        total(&theirs, "costUSD"),
        gaps.len(),
        gaps.iter().filter(|(d, _)| *d > 0.0).count(),
        gaps.iter().filter(|(d, _)| *d < 0.0).count(),
        gaps.iter().map(|(d, _)| d).sum::<f64>(),
        gaps.len() - grew,
        ours["totals"]["turns"],
        theirs["totals"]["turns"],
        total(&ours, "toolSuccessRate"),
        total(&theirs, "toolSuccessRate"),
        secs(refresh),
        export_secs,
    );
    assert_eq!(
        ours["totals"]["sessions"].as_u64(),
        Some(exported.len() as u64),
        "Connect's store and a direct export count different sessions in the last 7 UTC days"
    );
    assert_eq!(
        (only_ours, only_theirs),
        (0, 0),
        "the same number of sessions, but not the same ones"
    );
}

/// Whether one of the session's dispatches hangs under another.
fn nested(row: &Value) -> bool {
    let session = row["sessionId"].as_str();
    row["dispatches"].as_array().into_iter().flatten().any(|d| {
        !d["parentId"].is_null()
            || d["ownerAgentId"]
                .as_str()
                .is_some_and(|o| o != "root" && Some(o) != session)
    })
}

fn dispatches(row: &Value) -> usize {
    row["dispatches"].as_array().map_or(0, Vec::len)
}

/// M3: a session's trace from Connect equals `view --session` over a direct export.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_trace_matches_the_cli() {
    let data = history().await;
    let tmp = tempfile::tempdir().unwrap();
    let core = live_core(&data, &shim(tmp.path(), &real_codemie()));
    let today = Utc::now().date_naive();
    let export = tmp.path().join("direct.json");
    let direct = direct_export(today - Days::new(6), today, &export).await;
    let copy = tmp.path().join("copy.json");
    std::fs::copy(&export, &copy).unwrap();
    let exported: HashMap<String, Value> = rows(&direct)
        .into_iter()
        .filter_map(|r| Some((r["sessionId"].as_str()?.to_string(), r)))
        .collect();
    // A session the store and the export hold in the same capture: one still running has grown
    // since the store read it.
    let stored = rows(&sessions_json(&data));
    let same: Vec<&Value> = stored
        .iter()
        .filter(|r| {
            r["sessionId"]
                .as_str()
                .and_then(|id| exported.get(id))
                .is_some_and(|e| ends(e) == ends(r) && dispatches(e) == dispatches(r))
        })
        .collect();
    let pick = same
        .iter()
        .max_by_key(|r| (nested(r), dispatches(r)))
        .expect("no session of the last 7 days is in the store and a direct export unchanged");
    let id = pick["sessionId"].as_str().unwrap();
    let ours = ask(&core, Operation::AnalyticsSession, json!({"id": id})).await;
    let theirs = direct_view(&copy, &["--session", id]).await;
    let trace = ours["trace"].as_array().cloned().unwrap_or_default();
    let cli_trace = theirs["trace"].as_array().cloned().unwrap_or_default();
    let keyed = dispatches(&ours["session"]);
    let max_level = trace
        .iter()
        .filter_map(|e| e["level"].as_u64())
        .max()
        .unwrap_or(0);
    let under = trace.iter().filter(|e| !e["parentKey"].is_null()).count();
    println!(
        "M3 session {id} (most dispatches of {} sessions held unchanged in both{}): trace {} entries for {keyed} dispatches, max level {max_level}, {under} under a parent; the direct CLI answer has {} entries",
        same.len(),
        if nested(pick) { ", nested" } else { ", none nested" },
        trace.len(),
        cli_trace.len(),
    );
    assert_eq!(ours["schema"], "codemie.analytics.session/1");
    assert_eq!(
        trace.len(),
        cli_trace.len(),
        "trace lengths differ from the direct CLI answer"
    );
    for (i, (a, b)) in trace.iter().zip(&cli_trace).enumerate() {
        for field in [
            "key",
            "kind",
            "name",
            "label",
            "level",
            "parentKey",
            "childKeys",
            "issue",
        ] {
            assert!(
                a[field] == b[field],
                "trace entry {i}: `{field}` differs from the direct CLI answer"
            );
        }
        assert!(
            a == b,
            "trace entry {i} has fields the direct CLI answer doesn't"
        );
    }
    assert_eq!(
        trace.len(),
        keyed,
        "the trace has one entry per dispatch the CLI keyed"
    );
}

/// Appends a launch as the terminal dock notes one (`commands/terminal.rs`, `log_launch`: one
/// JSON line, appended); its writer stamps the current time, so the line is written here.
fn launch(log: &Path, at: i64, folder: &str) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .unwrap();
    let line = json!({"at": at, "folder": folder, "program": "codemie-claude"});
    writeln!(file, "{line}").unwrap();
}

/// M4: a terminal launch in a session's folder 30 s from its start marks it started in Connect.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_terminal_launch_marks_the_session() {
    let history = history().await;
    let tmp = tempfile::tempdir().unwrap();
    let data = copy_of_history(&history, tmp.path());
    let core = live_core(&data, &shim(&tmp.path().join("cli"), &real_codemie()));
    let stored = rows(&sessions_json(&data));
    let start = |r: &Value| r["startTime"].as_i64().unwrap_or(0);
    // The newest priced session with no other session of its folder starting within 5 minutes,
    // so a launch near it can only match it.
    let pick = stored
        .iter()
        .filter(|r| cost(r) > 0.0 && r["project"].as_str().is_some_and(|p| !p.is_empty()))
        .filter(|r| {
            !stored.iter().any(|o| {
                o["sessionId"] != r["sessionId"]
                    && o["project"] == r["project"]
                    && (start(o) - start(r)).abs() <= 300_000
            })
        })
        .max_by_key(|r| start(r))
        .expect("no priced session stands alone in its folder");
    let (id, at, folder, price) = (
        pick["sessionId"].as_str().unwrap(),
        start(pick),
        pick["project"].as_str().unwrap(),
        cost(pick),
    );
    let range = json!({"from": iso(at - 3_600_000), "to": iso(at + 3_600_000)});
    let log = core.paths.private.join("terminal-launches.jsonl");
    let marked = |view: &Value| view["connect"]["startedInConnect"].clone();
    // Launches that match nothing: 121 s after it in its folder, 30 s after it in another.
    launch(&log, at + 121_000, folder);
    launch(&log, at + 30_000, &format!("{folder}-elsewhere"));
    let view_before = ask(&core, Operation::AnalyticsView, range.clone()).await;
    let app_before = ask(&core, Operation::AnalyticsApp, range.clone()).await;
    launch(&log, at + 30_000, folder);
    let view = ask(&core, Operation::AnalyticsView, range.clone()).await;
    let app = ask(&core, Operation::AnalyticsApp, range).await;
    let terminal = app["totals"]["terminalCostUsd"]
        .as_f64()
        .unwrap_or(f64::NAN);
    println!(
        "M4 session {id} (${price:.2}): launches at +121 s in its folder and +30 s in another folder mark {} session(s), App terminal sessions {}; a launch at +30 s in its folder marks {}, App terminal sessions {}, terminal cost ${terminal:.2}",
        marked(&view_before).as_array().map_or(0, Vec::len),
        app_before["totals"]["terminalSessions"],
        if marked(&view) == json!([id]) { "it" } else { "something else" },
        app["totals"]["terminalSessions"],
    );
    assert_eq!(
        marked(&view_before),
        json!([]),
        "a launch out of range matched"
    );
    assert_eq!(app_before["totals"]["terminalSessions"], 0);
    assert_eq!(marked(&view), json!([id]));
    assert_eq!(app["totals"]["terminalSessions"], 1);
    assert!(
        (terminal - price).abs() < CENT,
        "the App tab's terminal cost ${terminal:.2} isn't the session's ${price:.2}"
    );
}

/// One `ai_run` in the ledger, as Connect writes it after a run (`workspace/ai.rs`).
fn seed_run(core: &Arc<Core>, at: i64, purpose: &str, cost: f64) {
    let month = DateTime::from_timestamp(at, 0)
        .unwrap()
        .format("%Y-%m")
        .to_string();
    let record = Record {
        id: id(),
        kind: "ai_run".into(),
        connection_id: None,
        workspace_id: Some("personal".into()),
        source: "test".into(),
        revision: id(),
        updated_at: at,
        data: json!({"purpose": purpose, "profile": "claude", "model": "sonnet", "status": "ok",
            "durationMs": 1000, "tokens": null, "costUsd": cost, "refId": null,
            "month": month, "at": at}),
    };
    core.repo().unwrap().put_record(&record).unwrap();
}

/// M5: Connect's own runs show in the App tab beside the CLI's sessions.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_connect_runs_count_in_the_app_tab() {
    let history = history().await;
    let tmp = tempfile::tempdir().unwrap();
    let data = copy_of_history(&history, tmp.path());
    let core = live_core(&data, &shim(&tmp.path().join("cli"), &real_codemie()));
    let now = Utc::now().timestamp();
    seed_run(&core, now - 7200, "meeting", 0.42);
    seed_run(&core, now - 3600, "mail_draft", 0.08);
    let range = json!({"from": iso((now - 7 * 86_400) * 1000), "to": iso(now * 1000)});
    let app = ask(&core, Operation::AnalyticsApp, range).await;
    let feature = |key: &str| {
        app["features"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|f| f["key"] == key)
            .cloned()
            .unwrap_or(Value::Null)
    };
    let totals = &app["totals"];
    let share = totals["backgroundShareOfAll"].as_f64();
    let background = totals["costUsd"].as_f64().unwrap_or(f64::NAN);
    println!(
        "M5 last 7 days: {} runs ${background:.2} (meeting {} ${:.2}, draft {} ${:.2}); background share of all AI cost on this Mac {}{}",
        totals["runs"],
        feature("meeting")["runs"],
        feature("meeting")["costUsd"].as_f64().unwrap_or(f64::NAN),
        feature("draft")["runs"],
        feature("draft")["costUsd"].as_f64().unwrap_or(f64::NAN),
        share.map_or("null".to_string(), |s| format!("{:.4}%", s * 100.0)),
        share.map_or(String::new(), |s| format!(
            " (CLI sessions ${:.2})",
            background / s - background
        )),
    );
    let near = |v: &Value, want: f64| (v.as_f64().unwrap_or(f64::NAN) - want).abs() < 1e-9;
    assert_eq!(totals["runs"], 2);
    assert!(near(&totals["costUsd"], 0.50), "{}", totals["costUsd"]);
    assert_eq!(feature("meeting")["runs"], 1);
    assert!(near(&feature("meeting")["costUsd"], 0.42));
    assert_eq!(feature("draft")["runs"], 1);
    assert!(near(&feature("draft")["costUsd"], 0.08));
    assert!(
        share.is_some_and(|s| s > 0.0 && s <= 1.0),
        "backgroundShareOfAll is {} with the CLI present",
        totals["backgroundShareOfAll"]
    );
}

/// M6: Connect quitting in the middle of a first open kills the CLI; the next start goes on
/// with the days not read.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_a_stopped_first_open_continues_after_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let (data, cli_dir) = (tmp.path().join("data"), tmp.path().join("cli"));
    let bin = shim(&cli_dir, &real_codemie());
    let dir = data.join("analytics");
    let first = live_core(&data, &bin);
    let today = Utc::now().date_naive();
    let first_days = [key(today - Days::new(1)), key(today - Days::new(2))];
    let started = Instant::now();
    assert_eq!(
        ask(&first, Operation::AnalyticsRefresh, json!({})).await,
        json!({"started": true})
    );
    while !first_days.iter().all(|d| {
        let s = State::load(&dir);
        s.days_done.contains(d) || s.failed_days.contains(d)
    }) {
        assert!(running(&first), "the fetch ended before its first window");
        assert!(started.elapsed() < REFRESH_TIMEOUT, "no first window");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let first_window = started.elapsed();
    // The fetch goes straight on to its second window: stop while that call runs.
    let pid = loop {
        if let Some(&(pid, _, _)) = exports(&calls(&cli_dir)).get(1) {
            break pid;
        }
        assert!(
            started.elapsed() < first_window + Duration::from_secs(60),
            "the second window's call never started"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(!gone(pid), "the second window's CLI isn't running");
    let before = State::load(&dir);
    let handled: BTreeSet<String> = before
        .days_done
        .union(&before.failed_days)
        .cloned()
        .collect();
    let stopped = Instant::now();
    first.stop_background();
    wait_idle(&first, Duration::from_secs(30)).await;
    while !(gone(pid) && gone(-pid)) && stopped.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let ended = stopped.elapsed();
    let alive: Vec<i32> = calls(&cli_dir)
        .iter()
        .map(|c| c.pid)
        .filter(|p| !gone(*p))
        .collect();
    let after = State::load(&dir);
    let first_calls = calls(&cli_dir).len();
    println!(
        "M6 stop: during window 2 ({:.0} s in; window 1 done at {:.0} s), CLI pid {pid} and its process group gone {:.2} s after stop_background, {} of this test's {first_calls} CLI processes left, {} day(s) kept as read",
        secs(stopped - started),
        secs(first_window),
        secs(ended),
        alive.len(),
        handled.len(),
    );
    assert!(gone(pid), "the CLI still runs after stop");
    assert!(
        gone(-pid),
        "a process of the CLI's group still runs after stop"
    );
    assert!(alive.is_empty(), "CLI processes still run: {alive:?}");
    assert_eq!(
        (after.days_done, after.failed_days),
        (before.days_done, before.failed_days),
        "the interrupted window was marked"
    );
    assert_eq!(after.last_fetch_at, None, "a stopped fetch isn't finished");
    drop(first);

    let next = live_core(&data, &bin);
    let restarted = Instant::now();
    assert_eq!(
        ask(&next, Operation::AnalyticsRefresh, json!({})).await,
        json!({"started": true})
    );
    wait_idle(&next, SETUP_TIMEOUT).await;
    let finished = restarted.elapsed();
    let again = windows(&calls(&cli_dir)[first_calls..]);
    let reread = days_of(&again)
        .iter()
        .filter(|d| handled.contains(&key(**d)))
        .count();
    let state = State::load(&dir);
    let status = ask(&next, Operation::AnalyticsStatus, json!({})).await;
    println!(
        "M6 next start: {} export calls covering {}..{}, re-read {reread} of the {} days kept, finished in {:.0} s with {} sessions, {} days read, {} failed day(s)",
        again.len(),
        again.last().map_or("-".into(), |w| key(w.0)),
        again.first().map_or("-".into(), |w| key(w.1)),
        handled.len(),
        secs(finished),
        status["sessions"],
        state.days_done.len(),
        state.failed_days.len(),
    );
    assert_eq!(reread, 0, "the next start read days the first had done");
    assert_eq!(
        again.first().map(|w| w.1),
        Some(today),
        "today is read again"
    );
    let all: BTreeSet<String> = days_of(&again)
        .iter()
        .map(|d| key(*d))
        .chain(handled)
        .collect();
    assert_eq!(all.len(), 90, "the two runs read {} of 90 days", all.len());
    assert!(
        state.last_fetch_at.is_some(),
        "the next start didn't finish"
    );
    assert_eq!(status["state"], "ready");
    let left = temp_files(&dir);
    assert!(left.is_empty(), "the CLI's temp files are left: {left:?}");
}

/// M6, second half: a `codemie` without `analytics view` (the installed 0.17.0) shows the
/// "needs a newer CLI" state and starts no fetch.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live_old_cli_shows_needs_cli() {
    let env = DetectEnv::system(Vec::new());
    let old_bin = env.home.join(".npm-global/bin");
    let old = find_program_in("codemie", &old_bin.to_string_lossy(), &env.home, &[])
        .filter(|p| p.starts_with(&old_bin))
        .expect("no codemie in ~/.npm-global/bin");
    let version = std::process::Command::new(&old)
        .arg("--version")
        .output()
        .unwrap();
    let version = String::from_utf8_lossy(&version.stdout).trim().to_string();
    let tmp = tempfile::tempdir().unwrap();
    let cli_dir = tmp.path().join("cli");
    let core = live_core(&tmp.path().join("data"), &shim(&cli_dir, &old));
    let status = ask(&core, Operation::AnalyticsStatus, json!({})).await;
    // What the page would get if it asked for numbers anyway.
    let now = Utc::now().timestamp_millis();
    let view = core
        .request(read(
            Operation::AnalyticsView,
            json!({"from": iso(now - 86_400_000), "to": iso(now)}),
        ))
        .await;
    let refresh = ask(&core, Operation::AnalyticsRefresh, json!({})).await;
    if refresh == json!({"started": true}) {
        // Not what should happen: let the first export start, as evidence, then stop it.
        let started = Instant::now();
        while exports(&calls(&cli_dir)).is_empty() && started.elapsed() < Duration::from_secs(10) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        core.stop_background();
        wait_idle(&core, Duration::from_secs(30)).await;
    }
    let export_calls = exports(&calls(&cli_dir)).len();
    println!(
        "M7 codemie {version} from ~/.npm-global/bin: status {}, refresh {refresh}, {export_calls} export call(s); the page's view call answers {}",
        status["state"],
        match &view {
            Ok(_) => "a summary".to_string(),
            Err(e) => format!("{} \"{}\"", e.code, e.message),
        },
    );
    assert_eq!(
        status["state"], "needs_cli",
        "a CLI without `analytics view` isn't shown as needing a newer one"
    );
    assert_eq!(refresh, json!({"needsCli": true}));
    assert_eq!(export_calls, 0, "the old CLI was asked for exports");
}
