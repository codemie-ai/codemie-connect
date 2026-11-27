//! `CODEMIE_STATUS_SMOKE` (ruling R14): the real app checked without anyone at its window. Debug
//! builds only.
//!
//! - `status`: Connect boots as the user's own launch does (their data folder, unless
//!   `CODEMIE_WORKSPACE_TEST_DIR` names another), waits for the workspace, the first sync and the
//!   plugin manager, and reports what it found: the version, the Claude profiles and routes, the
//!   data folder, the plugins and whether they loaded, the workspace's counts, the voice copy's
//!   counts and state (reply-voice design ruling 22: never its style, rule or people text), the
//!   Ask route's state and its thread/turn counts (ask-capture design § 6: never a question or an
//!   answer), what needs attention and whether the CodeMie setup sheet would open
//!   (`ui/workspace/status-smoke.js`).
//! - `live`: the same report, then the checks the owner approved, through the workspace ops the
//!   UI uses: one AI draft (discarded), one thread summary (removed) and one Morning brief run.
//!   Nothing is sent, posted or written to the calendar.
//! - `move:<folder>` and `default`, on a test data root only: the data-folder move to `<folder>`
//!   (its check, then the switch Settings makes) and "Use the default folder", each without the
//!   restart; a `status` run after each shows what the next start opens.
//!
//! The report goes to `$TMPDIR/connect-status-smoke.json` and a `STATUS_SMOKE {…}` line. It holds
//! statuses, counts, lengths, timings and ids only: e-mail addresses become `<redacted>`, the
//! home folder `~`, and message, draft and summary text never enters it. Exit 0 pass, 1 fail,
//! 2 nothing reported in time, 3 can't run.
use super::smoke::SmokeRun;
use crate::error::{CmdResult, InstallerError};
use crate::plugins::manager::PluginManager;
use crate::storage::location::SystemVolume;
use crate::storage::{commands as storage, migrate, old_copy};
use crate::workspace::models::{Operation, Request};
use crate::workspace::WorkspaceState;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const VAR: &str = "CODEMIE_STATUS_SMOKE";
const REPORT_FILE: &str = "connect-status-smoke.json";
/// Strings in the window's part of the report are cut to this many characters.
const MAX_TEXT: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    Status,
    Live,
    /// Move the data folder into this folder (a test data root only).
    Move(PathBuf),
    /// "Use the default folder" (a test data root only).
    UseDefault,
}

impl Mode {
    pub fn name(&self) -> &'static str {
        match self {
            Mode::Status => "status",
            Mode::Live => "live",
            Mode::Move(_) => "move",
            Mode::UseDefault => "default",
        }
    }
    /// Whether the window runs the checks (`status`, `live`) or Rust does (`move`, `default`).
    fn by_window(&self) -> bool {
        matches!(self, Mode::Status | Mode::Live)
    }
    /// A report comes within this, or the smoke fails (exit 2). A live run waits for Claude
    /// three times.
    fn deadline(&self) -> Duration {
        Duration::from_secs(if *self == Mode::Live { 1500 } else { 420 })
    }
}

/// This run: its identity, its mode and when it started (unix seconds).
pub struct StatusRun {
    pub run: SmokeRun,
    pub mode: Mode,
    pub started_unix: i64,
}

static RUN: OnceLock<StatusRun> = OnceLock::new();
static REPORTED: AtomicBool = AtomicBool::new(false);
/// The AI drafts and summaries there were when the window first asked for the facts: the smoke
/// never removes one of them.
static PREEXISTING: OnceLock<HashSet<(String, String)>> = OnceLock::new();

/// This status smoke run, once started.
pub fn running() -> Option<&'static StatusRun> {
    RUN.get()
}

pub fn report_path() -> PathBuf {
    std::env::temp_dir().join(REPORT_FILE)
}

/// The mode `value` names. `test_root` says whether `CODEMIE_WORKSPACE_TEST_DIR` is set: a
/// data-folder change never runs on the user's own folder.
pub fn parse_mode(value: Option<&str>, test_root: bool) -> Result<Option<Mode>, String> {
    let Some(value) = value.map(str::trim) else {
        return Ok(None);
    };
    let mode = match value {
        "status" => return Ok(Some(Mode::Status)),
        "live" => return Ok(Some(Mode::Live)),
        "default" => Mode::UseDefault,
        _ => match value.strip_prefix("move:") {
            Some(folder) => {
                let folder = PathBuf::from(folder.trim());
                if !folder.is_absolute() {
                    return Err(format!(
                        "move needs the full path of a folder, as move:/path/to/folder (got {value:?})"
                    ));
                }
                Mode::Move(folder)
            }
            None => {
                return Err(format!(
                    "unknown mode {value:?}: give status, live, move:<folder> or default"
                ))
            }
        },
    };
    if !test_root {
        return Err(format!(
            "{} changes the data folder, so it runs only on a test data root: set \
             CODEMIE_WORKSPACE_TEST_DIR to a copy. It never changes your own data folder.",
            mode.name()
        ));
    }
    Ok(Some(mode))
}

fn refuse(why: &str) -> ! {
    eprintln!("{VAR}: {why}");
    std::process::exit(3);
}

/// Starts a status smoke run when `CODEMIE_STATUS_SMOKE` is set, or exits 3 when it can't run.
/// Called in setup before the single-instance plugin, like the plugin smokes: it removes the
/// previous report and refuses to run beside another Connect. Without the variable it does
/// nothing.
pub fn start(identifier: &str, version: &str) {
    let Some(value) = std::env::var(VAR).ok() else {
        return;
    };
    if !cfg!(debug_assertions) {
        refuse("the status smoke runs in a debug build only");
    }
    if std::env::var_os("CODEMIE_PLUGIN_SMOKE").is_some() {
        refuse("run it without CODEMIE_PLUGIN_SMOKE");
    }
    let test_root = std::env::var_os("CODEMIE_WORKSPACE_TEST_DIR").is_some();
    let mode = match parse_mode(Some(&value), test_root) {
        Ok(Some(mode)) => mode,
        Ok(None) => return,
        Err(why) => refuse(&why),
    };
    if let Err(e) = std::fs::remove_file(report_path()) {
        if e.kind() != std::io::ErrorKind::NotFound {
            refuse(&format!(
                "can't remove the old report {}: {e}",
                report_path().display()
            ));
        }
    }
    super::smoke::refuse_beside_running(VAR, identifier);
    let now = chrono::Utc::now();
    let _ = RUN.set(StatusRun {
        run: SmokeRun {
            run_id: uuid::Uuid::new_v4().to_string(),
            started_at: now.to_rfc3339(),
            pid: std::process::id(),
            version: version.to_string(),
        },
        mode,
        started_unix: now.timestamp(),
    });
}

/// After setup: fails the smoke (exit 2) when nothing reported by the deadline, and runs a
/// `move` or `default` check once the workspace and plugins have settled.
pub fn arm(app: &AppHandle) {
    let Some(status) = running() else {
        return;
    };
    let watchdog = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(status.mode.deadline());
        let failed = format!(
            "nothing reported within {} s",
            status.mode.deadline().as_secs()
        );
        finish(
            &watchdog,
            json!({"runId": status.run.run_id, "failed": [failed]}),
            2,
        );
    });
    if !status.mode.by_window() {
        let worker = app.clone();
        std::thread::spawn(move || {
            let outcome = folder_change(&worker, &status.mode);
            finish(&worker, outcome, 0);
        });
    }
}

fn manager(app: &AppHandle) -> Option<Arc<PluginManager>> {
    app.try_state::<Arc<PluginManager>>()
        .map(|m| m.inner().clone())
}

/// Waits (at most `limit`) until the plugin manager has no reload left.
fn wait_for_plugins(app: &AppHandle, limit: Duration) {
    let started = Instant::now();
    while started.elapsed() < limit {
        if manager(app).is_none_or(|m| m.reloads_pending() == 0) {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// `move:<folder>`: the check Settings shows for the folder, then the move with the running
/// workspace held still, as `data_location_change` does, but without the restart. `default`:
/// "Use the default folder". The next start opens the folder the pointer names.
fn folder_change(app: &AppHandle, mode: &Mode) -> Value {
    let run_id = running().map(|s| s.run.run_id.clone());
    let state = app.state::<WorkspaceState>();
    let Some(core) = state.core.clone() else {
        return json!({"runId": run_id, "failed": ["the workspace didn't open"]});
    };
    wait_for_plugins(app, Duration::from_secs(120));
    std::thread::sleep(Duration::from_secs(2));
    let private = state.resolved.private_root.clone();
    let mut out = json!({"runId": run_id, "failed": []});
    out["rowsBefore"] = core
        .repo()
        .and_then(|r| r.row_counts())
        .map(|rows| json!(rows))
        .unwrap_or(Value::Null);
    let failed = match mode {
        Mode::Move(target) => {
            let data = core.paths.data.clone();
            let home = app.path().home_dir().unwrap_or_default();
            let places = migrate::Places {
                private_root: &private,
                data_root: &data,
                home: &home,
            };
            let usable = migrate::workspace_usable(true, &private);
            let check = migrate::check(&places, target, usable, &SystemVolume);
            out["check"] = json!(check);
            let started = Instant::now();
            let choice = migrate::Choice {
                picked: target,
                mode: migrate::Mode::Move,
                acknowledged: false,
            };
            match migrate::change_from_running(
                &places,
                &choice,
                Some(&core),
                &SystemVolume,
                migrate::QUIESCE_WAIT,
            ) {
                Ok(new_root) => {
                    out["moved"] =
                        json!({"dataRoot": new_root, "ms": started.elapsed().as_millis() as u64});
                    None
                }
                Err(e) => Some(format!("the move failed: {} ({})", e.message, e.code)),
            }
        }
        Mode::UseDefault => match storage::use_default_location(&private) {
            Ok(pointer) => {
                out["pointer"] =
                    json!({"custom": pointer.data_dir.is_some(), "previous": pointer.previous});
                None
            }
            Err(e) => Some(format!("Use the default folder failed: {e}")),
        },
        _ => None,
    };
    if let Some(why) = failed {
        out["failed"] = json!([why]);
    }
    out["location"] = json!(old_copy::location_info(&private, &storage::logs_dir()));
    out
}

/// The tray's menu-bar count, checked against a forced recount (ruling: the status smoke checks
/// the tray, not just the workspace). Forces a refresh first (off the main thread: the caller
/// runs this under `spawn_blocking`), then reads whether the tray with id `main` exists and the
/// view it last applied. `None` title compares as `""`.
pub(crate) fn menu_bar_facts(app: &AppHandle, core: &crate::workspace::Core) -> Value {
    let computed = core.refresh_menu_bar_now().ok();
    let tray = app.tray_by_id("main").is_some();
    let applied = core.menu_bar.last();
    let label_of = |title: &Option<String>| title.clone().unwrap_or_default();
    // The label parses back to the raw count, except capped at 99 ("99+" never ran further).
    let count_of = |label: &str| -> u64 {
        match label {
            "" => 0,
            "99+" => 100,
            n => n.parse().unwrap_or(0),
        }
    };
    let applied = applied.map(|v| {
        json!({
            "title": label_of(&v.title),
            "amber": v.amber,
            "tooltipLength": v.tooltip.chars().count(),
            "rows": v.rows.len(),
        })
    });
    let computed = computed.map(|v| {
        let label = label_of(&v.title);
        json!({"count": count_of(&label), "label": label, "amber": v.amber})
    });
    json!({"tray": tray, "applied": applied, "computed": computed})
}

/// What Rust knows: whether the workspace opened, the data folder, its rows, the plugins, the
/// menu-bar tray.
fn facts(app: &AppHandle) -> Value {
    let state = app.state::<WorkspaceState>();
    let core = state.core.clone();
    let private = state.resolved.private_root.clone();
    let storage =
        storage::storage_status_of(&private, state.error.clone(), core.is_some(), &SystemVolume);
    let location = old_copy::location_info(&private, &storage::logs_dir());
    let rows = core
        .as_ref()
        .and_then(|c| c.repo().ok().and_then(|r| r.row_counts().ok()));
    let plugins = match manager(app) {
        Some(m) => {
            let installed = match m.installed() {
                Ok(list) => json!(list
                    .into_iter()
                    .map(|(id, version, on)| json!({"id": id, "version": version, "on": on}))
                    .collect::<Vec<_>>()),
                Err(why) => json!({"error": why}),
            };
            json!({"settled": m.reloads_pending() == 0, "installed": installed,
                   "loaded": m.loaded(), "problems": m.problems()})
        }
        None => json!({"settled": core.is_none(), "running": false}),
    };
    let menu_bar = core.as_ref().map(|c| menu_bar_facts(app, c));
    let voice = core.as_ref().map(|c| voice_facts(c));
    let ask = core.as_ref().map(|c| ask_facts(c));
    json!({
        "workspaceOpen": core.is_some(),
        "storage": storage,
        "location": location,
        "rows": rows,
        "plugins": plugins,
        "menuBar": menu_bar,
        "voice": voice,
        "ask": ask,
    })
}

/// The report's `voice` part (reply-voice design ruling 22, task 8): the snapshot's
/// `replyVoice`, cut to counts and bools only — never the style, rule or people text it carries
/// for Settings › Your voice and the composer.
pub(crate) fn voice_facts(core: &crate::workspace::Core) -> Value {
    let Ok(settings) = core.repo().and_then(|r| r.settings()) else {
        return Value::Null;
    };
    let v = core.voice_snapshot(&settings);
    json!({
        "provider": v["provider"],
        "state": v["state"],
        "copy": v["copy"],
        "people": v["people"].as_array().map_or(0, Vec::len),
        "rules": v["rules"].as_array().map_or(0, Vec::len),
        "style": v["style"].is_object(),
        "facts": v["facts"]["on"],
        "refreshedAt": v["refreshedAt"],
    })
}

/// The report's `ask` part (ask-capture design § 6, task 8): the Ask route's state (task 7's
/// `resolve_key`, never a profile id) and the thread and turn counts and whether a turn runs now
/// (`ask::store::list`, task 4) — never a question, an answer or a context item.
pub(crate) fn ask_facts(core: &crate::workspace::Core) -> Value {
    use crate::workspace::ask::store::{self, TurnState};
    let threads = core
        .repo()
        .ok()
        .and_then(|r| store::list(&r).ok())
        .unwrap_or_default();
    let turns: usize = threads.iter().map(|t| t.turns.len()).sum();
    let running = threads.iter().any(|t| {
        t.turns
            .iter()
            .any(|turn| matches!(turn.state, TurnState::Queued | TurnState::Running))
    });
    json!({
        "route": tauri::async_runtime::block_on(core.ask_route_state()),
        "threads": threads.len(),
        "turns": turns,
        "running": running,
    })
}

/// Notes the AI drafts and summaries there are now, the first time, so none of them is removed.
fn remember_preexisting(app: &AppHandle) {
    if PREEXISTING.get().is_some() {
        return;
    }
    let state = app.state::<WorkspaceState>();
    let Some(core) = state.core.clone() else {
        return;
    };
    let Ok(snapshot) = core.repo().and_then(|r| r.snapshot()) else {
        return;
    };
    let ids = snapshot
        .records
        .into_iter()
        .filter(|r| r.kind == "summary" || (r.kind == "draft" && r.id.starts_with("ai:")))
        .map(|r| (r.kind, r.id))
        .collect();
    let _ = PREEXISTING.set(ids);
}

fn this_run() -> CmdResult<&'static StatusRun> {
    running()
        .filter(|s| s.mode.by_window())
        .ok_or_else(|| InstallerError::Other("No status smoke is running.".into()))
}

/// The facts the window waits on (the plugin manager settling) and reports with: whether the
/// workspace opened, the data folder, its rows and the plugins. The first call notes which AI
/// drafts and summaries were there before the smoke.
#[tauri::command]
pub async fn smoke_status_facts(app: AppHandle) -> CmdResult<Value> {
    this_run()?;
    tauri::async_runtime::spawn_blocking(move || {
        remember_preexisting(&app);
        facts(&app)
    })
    .await
    .map_err(|e| InstallerError::Other(e.to_string()))
}

/// Whether the smoke may remove this record: only an AI draft (`ai:<key>`) or a summary that
/// was not there before the smoke and was written after it started.
fn may_discard(
    kind: &str,
    id: &str,
    updated_at: i64,
    started: i64,
    preexisting: &HashSet<(String, String)>,
) -> Result<(), String> {
    let ours = kind == "summary" || (kind == "draft" && id.starts_with("ai:"));
    if !ours {
        return Err("the smoke removes only an AI draft or a summary".into());
    }
    if preexisting.contains(&(kind.to_string(), id.to_string())) {
        return Err("it was there before the smoke, so it stays".into());
    }
    if updated_at < started {
        return Err("it was written before the smoke started, so it stays".into());
    }
    Ok(())
}

/// Live mode: removes the AI draft or summary this run made, so the conversation is left as it
/// was. `{deleted}`.
#[tauri::command]
pub async fn smoke_status_discard(
    app: AppHandle,
    kind: String,
    id: String,
    connection_id: String,
    workspace_id: String,
) -> CmdResult<Value> {
    let status = this_run()?;
    if status.mode != Mode::Live {
        return Err(InstallerError::Other(
            "Only a live status smoke removes what it made.".into(),
        ));
    }
    let state = app.state::<WorkspaceState>();
    let core = state
        .core
        .clone()
        .ok_or_else(|| InstallerError::Other("The workspace isn't open.".into()))?;
    let empty = HashSet::new();
    let before = PREEXISTING.get().unwrap_or(&empty);
    let fail = |e: crate::workspace::models::WorkspaceError| InstallerError::Other(e.message);
    let mut repo = core.repo().map_err(fail)?;
    let record = repo
        .record(&kind, &id, Some(&connection_id), Some(&workspace_id))
        .map_err(fail)?;
    may_discard(&kind, &id, record.updated_at, status.started_unix, before)
        .map_err(InstallerError::Other)?;
    let deleted = repo
        .delete_record(&kind, &id, &connection_id, &workspace_id)
        .map_err(fail)?;
    drop(repo);
    core.emit("workspace:changed");
    Ok(json!({"deleted": deleted}))
}

/// The window's report, with Rust's view added: writes the report, prints it and quits with the
/// verdict's exit code.
#[tauri::command]
pub async fn smoke_status_report(app: AppHandle, report: Value) -> CmdResult<Value> {
    this_run()?;
    let path = report_path();
    let pass = finish_with(&app, report, None).await;
    Ok(json!({"path": path, "pass": pass}))
}

/// Builds and writes the report once; the first caller wins (the window, a folder change or
/// the watchdog). `code` forces the exit code (the watchdog's 2).
async fn finish_with(app: &AppHandle, window: Value, code: Option<i32>) -> bool {
    if REPORTED.swap(true, Ordering::SeqCst) {
        return false;
    }
    let Some(status) = running() else {
        return false;
    };
    let ai = match app.state::<WorkspaceState>().core.clone() {
        Some(core) => core
            .request(Request {
                op: Operation::AiStatus,
                workspace_id: None,
                expected_revision: None,
                operation_id: None,
                data: json!({}),
            })
            .await
            .unwrap_or_else(|e| json!({"error": e.message})),
        None => json!({"error": "the workspace isn't open"}),
    };
    let blocking = app.clone();
    let facts = tauri::async_runtime::spawn_blocking(move || facts(&blocking))
        .await
        .unwrap_or_else(|e| json!({"error": e.to_string()}));
    let home = app.path().home_dir().unwrap_or_default();
    let report = build_report(Inputs {
        mode: &status.mode,
        run: Some(&status.run),
        home: &home,
        facts,
        ai,
        window,
    });
    let pass = report["pass"] == true;
    let text = serde_json::to_string_pretty(&report).unwrap_or_default();
    if let Err(e) = std::fs::write(report_path(), &text) {
        eprintln!("{VAR}: can't write {}: {e}", report_path().display());
    }
    println!(
        "STATUS_SMOKE {}",
        json!({"path": report_path(), "mode": status.mode.name(), "pass": pass,
               "runId": report["runId"], "failed": report["failed"]})
    );
    let exit = code.unwrap_or(if pass { 0 } else { 1 });
    let app = app.clone();
    // After the answer reaches the window.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        app.exit(exit);
    });
    pass
}

/// [`finish_with`] from a plain thread (the watchdog, a folder change): `code` 2 for the
/// watchdog, else the verdict's.
fn finish(app: &AppHandle, outcome: Value, code: i32) {
    let forced = (code != 0).then_some(code);
    tauri::async_runtime::block_on(finish_with(app, outcome, forced));
}

// ---------------------------------------------------------------- the report (pure)

/// Replaces every e-mail address in `text` with `<redacted>`: a local part and a domain with a
/// dot around an `@`.
fn redact_emails(text: &str) -> String {
    let local = |c: char| c.is_ascii_alphanumeric() || "._%+-'".contains(c);
    let domain = |c: char| c.is_ascii_alphanumeric() || ".-".contains(c);
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' {
            let mut start = out.chars().count();
            let taken: Vec<char> = out.chars().collect();
            while start > 0 && local(taken[start - 1]) {
                start -= 1;
            }
            let mut end = i + 1;
            while end < chars.len() && domain(chars[end]) {
                end += 1;
            }
            let host: String = chars[i + 1..end].iter().collect();
            let host = host.trim_end_matches(['.', '-']);
            let is_address = start < taken.len()
                && host.contains('.')
                && !host.starts_with('.')
                && host.rsplit('.').next().is_some_and(|tld| tld.len() >= 2);
            if is_address {
                out = taken[..start].iter().collect();
                out.push_str("<redacted>");
                i += 1 + host.chars().count();
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// The whole report with e-mail addresses redacted and the home folder written `~`.
fn scrub(v: Value, home: &Path) -> Value {
    let home = home.to_string_lossy().trim_end_matches('/').to_string();
    fn walk(v: Value, home: &str) -> Value {
        match v {
            Value::String(s) => {
                let mut s = redact_emails(&s);
                if !home.is_empty() {
                    let mut out = String::new();
                    let mut rest = s.as_str();
                    while let Some(at) = rest.find(home) {
                        let after = &rest[at + home.len()..];
                        let boundary = after.is_empty() || after.starts_with('/');
                        out.push_str(&rest[..at]);
                        out.push_str(if boundary { "~" } else { home });
                        rest = after;
                    }
                    out.push_str(rest);
                    s = out;
                }
                Value::String(s)
            }
            Value::Array(a) => Value::Array(a.into_iter().map(|x| walk(x, home)).collect()),
            Value::Object(o) => {
                Value::Object(o.into_iter().map(|(k, x)| (k, walk(x, home))).collect())
            }
            other => other,
        }
    }
    walk(v, &home)
}

/// Keys whose values are what people wrote or who they are; dropped from the window's part
/// wherever they appear.
const TEXT_KEYS: &[&str] = &[
    "text",
    "subject",
    "body",
    "preview",
    "quote",
    "from",
    "sender",
    "senders",
    "to",
    "cc",
    "recipients",
    "email",
    "displayName",
    "givenName",
    "name",
    "title",
    "questions",
    "asks",
    "instructions",
    "prompt",
    "output",
    "items",
    "summaryMarkdown",
    "summaryBlocks",
    "content",
    "snippet",
    "photo",
];

/// The window's part of the report: counts, statuses, lengths, timings and ids. Text keys are
/// dropped and strings are cut, so no message, draft or summary text can pass through.
fn sanitize_window(v: Value) -> Value {
    match v {
        Value::Object(o) => Value::Object(
            o.into_iter()
                .filter(|(k, _)| !TEXT_KEYS.contains(&k.as_str()))
                .map(|(k, x)| (k, sanitize_window(x)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.into_iter().map(sanitize_window).collect()),
        Value::String(s) if s.chars().count() > MAX_TEXT => {
            Value::String(s.chars().take(MAX_TEXT).chain(['…']).collect())
        }
        other => other,
    }
}

/// `ai_status` as the report shows it: each profile's id, type, state and models, its account
/// without the address, the default profile and the routes, and which profiles are ready.
fn ai_summary(status: &Value) -> Value {
    if let Some(error) = status.get("error") {
        return json!({"error": error});
    }
    let profiles: Vec<Value> = status["profiles"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            let account = p["account"].as_object().map(|a| {
                let mut out = Map::new();
                for key in ["method", "plan"] {
                    out.insert(key.into(), a.get(key).cloned().unwrap_or(Value::Null));
                }
                if a.get("email").is_some_and(|e| !e.is_null()) {
                    out.insert("email".into(), json!("<redacted>"));
                }
                Value::Object(out)
            });
            json!({
                "id": p["id"],
                "type": p["kind"]["type"],
                "label": p["label"],
                "provider": p["provider"],
                "state": p["state"],
                "message": p["message"],
                "version": p["version"],
                "defaultModel": p["defaultModel"],
                "models": p["models"].as_array().map_or(0, Vec::len),
                "account": account,
                "local": p["local"],
            })
        })
        .collect();
    let ready: Vec<&Value> = profiles
        .iter()
        .filter(|p| p["state"] == "ready")
        .map(|p| &p["id"])
        .collect();
    json!({
        "profiles": profiles,
        "ready": ready,
        "defaultProfile": status["settings"]["defaultProfile"],
        "routes": status["settings"]["routes"],
        "chosen": status["chosen"],
        "ollama": ollama_facts(&profiles),
    })
}

/// Ollama facts for the smoke, from the profiles [`ai_summary`] already redacted of any
/// `baseUrl`/`apiKey`: `probed` is whether a *local* Ollama profile was found (`local ==
/// true`, ruling 10 — a remote Ollama is never probed and must not count, even though it
/// also reports `state: "ready"`), `running` whether one of them answers, `models` the most
/// models any of them offers.
fn ollama_facts(profiles: &[Value]) -> Value {
    let ollama: Vec<&Value> = profiles
        .iter()
        .filter(|p| p["provider"] == "ollama" && p["local"] == true)
        .collect();
    let running = ollama
        .iter()
        .any(|p| !matches!(p["state"].as_str(), Some("not_running" | "not_installed")));
    let models = ollama
        .iter()
        .map(|p| p["models"].as_u64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    json!({"probed": !ollama.is_empty(), "running": running, "models": models})
}

pub struct Inputs<'a> {
    pub mode: &'a Mode,
    pub run: Option<&'a SmokeRun>,
    pub home: &'a Path,
    /// [`facts`]: the workspace, the data folder, its rows, the plugins.
    pub facts: Value,
    /// The `ai_status` answer, or `{error}`.
    pub ai: Value,
    /// What the window reported, or what a folder change did.
    pub window: Value,
}

/// The report: this run's identity, Rust's facts, Claude's profiles, the window's findings,
/// what failed and the verdict, with addresses and the home folder scrubbed.
fn build_report(i: Inputs) -> Value {
    let window = sanitize_window(if i.window.is_object() {
        i.window
    } else {
        json!({"error": "the report is not an object"})
    });
    let mut failed: Vec<String> = Vec::new();
    let window_run = window.get("runId").cloned().unwrap_or(Value::Null);
    if i.run.is_none() || window_run != json!(i.run.map(|r| &r.run_id)) {
        failed.push("runId: the window's run isn't this one".into());
    }
    if i.facts["workspaceOpen"] != true {
        let issue = i.facts["storage"]["issue"]
            .as_str()
            .or(i.facts["storage"]["status"].as_str())
            .unwrap_or("unknown");
        failed.push(format!("the workspace didn't open: {issue}"));
    } else if i.facts["plugins"]["settled"] != true {
        failed.push("the plugin manager didn't settle".into());
    }
    if let Some(e) = window.get("error").filter(|e| !e.is_null()) {
        failed.push(format!(
            "the window: {}",
            e.as_str().unwrap_or(&e.to_string())
        ));
    }
    failed.extend(
        window["failed"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| f.as_str().map_or_else(|| f.to_string(), String::from)),
    );
    // menuBar is absent when the workspace never opened; present otherwise (facts always adds
    // it once a Core exists). The tray must exist, and what it shows must match a forced count.
    if let Some(menu_bar) = i.facts.get("menuBar").filter(|m| !m.is_null()) {
        if menu_bar["tray"] != true {
            failed.push("menuBar: no tray icon".into());
        } else if menu_bar["computed"].is_null() {
            // T4/M3: a compute error folds into `computed: null`, which must not be read as an
            // empty, non-amber view that happens to match a quiet tray.
            failed.push("menuBar: the count could not be computed".into());
        } else {
            let applied_title = menu_bar["applied"]["title"].as_str().unwrap_or_default();
            let applied_amber = menu_bar["applied"]["amber"] == true;
            let computed_label = menu_bar["computed"]["label"].as_str().unwrap_or_default();
            let computed_amber = menu_bar["computed"]["amber"] == true;
            if applied_title != computed_label || applied_amber != computed_amber {
                failed.push(format!(
                    "menuBar: the tray shows {applied_title} but the count is {computed_label}"
                ));
            }
        }
    }
    let report = json!({
        "mode": i.mode.name(),
        "runId": i.run.map(|r| &r.run_id),
        "startedAt": i.run.map(|r| &r.started_at),
        "reportedAt": chrono::Utc::now().to_rfc3339(),
        "pid": i.run.map(|r| r.pid),
        "version": i.run.map(|r| &r.version),
        "workspaceOpen": i.facts["workspaceOpen"],
        "storage": i.facts["storage"],
        "location": i.facts["location"],
        "rows": i.facts["rows"],
        "plugins": i.facts["plugins"],
        "menuBar": i.facts["menuBar"],
        "voice": i.facts["voice"],
        "ask": i.facts["ask"],
        "ai": ai_summary(&i.ai),
        "window": window,
        "pass": failed.is_empty(),
        "failed": failed,
    });
    scrub(report, i.home)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> SmokeRun {
        SmokeRun {
            run_id: "run-1".into(),
            started_at: "2026-11-18T08:00:00+00:00".into(),
            pid: 42,
            version: "2.1.1".into(),
        }
    }

    #[test]
    fn the_mode_comes_from_the_variable() {
        assert_eq!(parse_mode(None, false), Ok(None));
        assert_eq!(parse_mode(Some("status"), false), Ok(Some(Mode::Status)));
        assert_eq!(parse_mode(Some(" live "), false), Ok(Some(Mode::Live)));
        assert_eq!(
            parse_mode(Some("move:/tmp/elsewhere"), true),
            Ok(Some(Mode::Move(PathBuf::from("/tmp/elsewhere"))))
        );
        assert_eq!(
            parse_mode(Some("default"), true),
            Ok(Some(Mode::UseDefault))
        );
        // A data-folder change runs on a test data root only, never on the user's own folder.
        for value in ["move:/tmp/elsewhere", "default"] {
            let why = parse_mode(Some(value), false).unwrap_err();
            assert!(why.contains("CODEMIE_WORKSPACE_TEST_DIR"), "{value}: {why}");
        }
        assert!(parse_mode(Some("move:relative/path"), true)
            .unwrap_err()
            .contains("full path"));
        assert!(parse_mode(Some("move:"), true).is_err());
        let unknown = parse_mode(Some("everything"), true).unwrap_err();
        assert!(
            unknown.contains("status, live, move:<folder> or default"),
            "{unknown}"
        );
        assert_eq!(Mode::Status.name(), "status");
        assert_eq!(Mode::Live.name(), "live");
        assert_eq!(Mode::Move(PathBuf::from("/x")).name(), "move");
        assert_eq!(Mode::UseDefault.name(), "default");
    }

    #[test]
    fn e_mail_addresses_and_the_home_folder_never_reach_the_report() {
        assert_eq!(
            redact_emails("Signed in as taylor.lee+work@example.co.uk, ok"),
            "Signed in as <redacted>, ok"
        );
        assert_eq!(
            redact_emails("a@b"),
            "a@b",
            "no dot in the domain: not an address"
        );
        assert_eq!(redact_emails("@epam.com and x@ y"), "@epam.com and x@ y");
        let scrubbed = scrub(
            json!({
                "dataRoot": "/Users/taylor/Library/Application Support/x/workspace",
                "nested": [{"why": "mail from ann@example.org failed in /Users/taylor/tmp"}],
                "other": "/Users/taylorx/keep",
                "n": 3,
            }),
            Path::new("/Users/taylor"),
        );
        assert_eq!(
            scrubbed["dataRoot"],
            "~/Library/Application Support/x/workspace"
        );
        assert_eq!(
            scrubbed["nested"][0]["why"],
            "mail from <redacted> failed in ~/tmp"
        );
        // Only the home folder itself is replaced, not a folder that starts with its name.
        assert_eq!(scrubbed["other"], "/Users/taylorx/keep");
        assert_eq!(scrubbed["n"], 3);
    }

    #[test]
    fn the_window_report_keeps_no_message_text() {
        let out = sanitize_window(json!({
            "runId": "run-1",
            "counts": {"inbox": {"reply": 4}, "needsReply": 4},
            "live": {"draft": {
                "status": "ok", "length": 412, "channel": "mail",
                "text": "Hi Ann, yes I can send it",
                "subject": "Q3 budget", "from": "ann@example.org",
                "questions": ["Can you send it?"],
                "error": "x".repeat(1000),
            }},
            "summary": {"asks": [{"text": "Send Ann the budget"}], "asksCount": 1},
        }));
        let text = out.to_string();
        for secret in [
            "Hi Ann",
            "Q3 budget",
            "ann@example.org",
            "Can you send it?",
            "Send Ann",
        ] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert_eq!(out["counts"]["inbox"]["reply"], 4);
        assert_eq!(out["live"]["draft"]["length"], 412);
        assert_eq!(out["live"]["draft"]["status"], "ok");
        assert_eq!(out["summary"]["asksCount"], 1);
        // Long strings are cut.
        assert!(
            out["live"]["draft"]["error"]
                .as_str()
                .unwrap()
                .chars()
                .count()
                <= 301
        );
    }

    fn ai_status() -> Value {
        json!({
            "profiles": [
                {"id": "claude", "kind": {"type": "native"}, "label": "Claude Code · your subscription",
                 "state": "ready", "version": "2.1.150", "message": null, "defaultModel": null,
                 "models": [{"id": "", "label": "Account default"}, {"id": "haiku", "label": "Haiku"}],
                 "account": {"email": "taylor@example.com", "method": "claude.ai", "org": "Example Org", "plan": "Max"}},
                {"id": "codemie:prod", "kind": {"type": "code_mie", "name": "prod"}, "label": "CodeMie · prod",
                 "state": "needs_login", "message": "Sign in to this CodeMie profile.", "account": null,
                 "defaultModel": "claude-sonnet-4-5", "models": [{"id": "claude-sonnet-4-5"}], "version": null}
            ],
            "settings": {"defaultProfile": "claude",
                         "routes": {"summary": {"profile": "codemie:prod", "model": "claude-haiku-4-5"}}}
        })
    }

    #[test]
    fn claude_profiles_are_reported_without_the_account_address() {
        let ai = ai_summary(&ai_status());
        assert_eq!(ai["defaultProfile"], "claude");
        assert_eq!(ai["routes"]["summary"]["profile"], "codemie:prod");
        assert_eq!(ai["profiles"][0]["id"], "claude");
        assert_eq!(ai["profiles"][0]["state"], "ready");
        assert_eq!(ai["profiles"][0]["type"], "native");
        assert_eq!(ai["profiles"][0]["models"], 2);
        assert_eq!(ai["profiles"][0]["account"]["email"], "<redacted>");
        assert_eq!(ai["profiles"][0]["account"]["plan"], "Max");
        assert!(ai["profiles"][0]["account"].get("org").is_none());
        assert_eq!(ai["profiles"][1]["state"], "needs_login");
        assert_eq!(ai["profiles"][1]["account"], Value::Null);
        assert_eq!(ai["ready"], json!(["claude"]));
        assert!(!ai.to_string().contains("taylor@example.com"));
        // An error answer is kept as one.
        let failed = ai_summary(&json!({"error": "Workspace storage is unavailable"}));
        assert_eq!(failed["error"], "Workspace storage is unavailable");
    }

    #[test]
    fn status_smoke_reports_rows_and_ollama_without_urls() {
        let status = json!({
            "profiles": [
                {"id": "claude", "kind": {"type": "native"}, "label": "Claude Code · your subscription",
                 "state": "ready", "version": "2.1.150", "message": null, "defaultModel": null,
                 "models": [], "account": null},
                {"id": "codemie:ol", "kind": {"type": "code_mie", "name": "ol"}, "label": "CodeMie \u{b7} ol",
                 "provider": "ollama", "state": "not_running", "message": "Ollama isn't running.",
                 "account": null, "defaultModel": "llama3.2", "models": [], "version": null,
                 "local": true}
            ],
            "chosen": {
                "default": {"profile": "claude", "model": null, "fallback": null, "group": null},
                "triage": {"profile": "codemie:ol", "model": null, "fallback": "claude", "group": "automation"},
                // A broken row: it names a profile nothing detected. Reporting it is not
                // evaluating it, so it must not turn the smoke's own pass/fail.
                "commitments": {"profile": "codemie:missing", "model": null, "fallback": null, "group": "automation"},
            },
            "settings": {"defaultProfile": "claude", "routes": {}},
        });
        let window = json!({"runId": "run-1", "failed": []});
        let report = build_report(Inputs {
            mode: &Mode::Status,
            run: Some(&run()),
            home: Path::new("/Users/taylor"),
            facts: facts(),
            ai: status,
            window,
        });
        assert_eq!(report["pass"], true, "{report:#}");
        assert_eq!(report["failed"], json!([]));
        assert_eq!(report["ai"]["chosen"]["triage"]["fallback"], "claude");
        assert_eq!(report["ai"]["chosen"]["triage"]["profile"], "codemie:ol");
        assert_eq!(
            report["ai"]["chosen"]["commitments"]["profile"],
            "codemie:missing"
        );
        assert_eq!(report["ai"]["profiles"][1]["provider"], "ollama");
        assert_eq!(
            report["ai"]["ollama"],
            json!({"probed": true, "running": false, "models": 0})
        );
        let dump = report.to_string();
        assert!(!dump.contains("http"), "{dump}");
        assert!(!dump.contains("apiKey"), "{dump}");

        // A remote Ollama (ruling 10: never probed, its own `ollama list` was never run)
        // reports `state: "ready"` too, same as a working local one — only `local` tells them
        // apart. It must not count as probed.
        let remote = ai_summary(&json!({
            "profiles": [
                {"id": "codemie:remote-ol", "kind": {"type": "code_mie", "name": "remote-ol"},
                 "label": "CodeMie \u{b7} remote-ol", "provider": "ollama", "state": "ready",
                 "message": null, "account": null, "defaultModel": "llama3.2",
                 "models": [{"id": "llama3.2:latest"}], "version": null, "local": false}
            ],
            "chosen": {},
            "settings": {"defaultProfile": null, "routes": {}},
        }));
        assert_eq!(
            remote["ollama"],
            json!({"probed": false, "running": false, "models": 0})
        );
        let remote_dump = remote.to_string();
        assert!(!remote_dump.contains("http"), "{remote_dump}");
        assert!(!remote_dump.contains("example.test"), "{remote_dump}");
    }

    fn facts() -> Value {
        json!({
            "workspaceOpen": true,
            "storage": {"status": "ready", "dataRoot": "/Users/taylor/Library/Application Support/c/workspace",
                        "privateRoot": "/Users/taylor/Library/Application Support/c/workspace", "custom": false},
            "rows": {"records.message": 120, "jobs": 9},
            "plugins": {"settled": true, "installed": [], "loaded": [], "problems": {}},
        })
    }

    /// Task 8 (ruling 22): a ready copy's `voice` part is counts and bools only — a profile's
    /// name/about, a rule's text and the style's text all carry the sentinel, yet neither it nor
    /// an `@` reaches `voice_facts` or the whole report.
    #[test]
    fn status_smoke_reports_voice_counts_only() {
        use crate::testing::{claude_profile, core as test_core, FakeRunner};
        use crate::workspace::voice::{copy, fake::FakeVoice, VoiceInfo, VoiceState};
        const SENTINEL: &str = "VOICE_SENTINEL_9f3a";

        let dir = tempfile::tempdir().unwrap();
        let core = test_core(
            dir.path(),
            Arc::new(FakeRunner::new(vec![])),
            vec![claude_profile()],
        );

        let person = |n: usize| copy::Person {
            id: format!("p{n}"),
            name: format!("Person {n} {SENTINEL}"),
            names: Vec::new(),
            addresses: vec![format!("p{n}@example.test")],
            ids: Vec::new(),
            text: format!("Role notes. {SENTINEL}"),
            about: format!("Prefers mornings. {SENTINEL}"),
            updated_at: "2026-11-24T09:00:00Z".into(),
            source: "People/p.md".into(),
        };
        let rule = |n: usize| copy::Rule {
            id: format!("r{n}"),
            applies: copy::Applies {
                kind: copy::AppliesKind::Everyone,
                value: None,
                channel: None,
            },
            text: format!("Rule {n}. {SENTINEL}"),
            source: "Voice/rules.md".into(),
            editable: true,
        };
        let c = copy::Copy {
            provider: "plugin:knowledge".into(),
            refreshed_at: 1_764_000_000,
            state: VoiceState::Ready,
            style: Some(copy::Style {
                text: format!("Short and direct. {SENTINEL}"),
                updated_at: "2026-11-24T09:00:00Z".into(),
                source: "Voice/style.md".into(),
                based_on: None,
                head: None,
            }),
            rules: (0..6).map(rule).collect(),
            people: (0..3).map(person).collect(),
        };
        copy::replace(
            &mut core.repo().unwrap(),
            "plugin:knowledge",
            &c,
            1_764_000_000,
        )
        .unwrap();

        let mut r = core.repo().unwrap();
        let mut settings = r.settings().unwrap();
        settings.voice.provider = "plugin:knowledge".into();
        r.settings_update(&settings).unwrap();
        drop(r);

        let fake = Arc::new(FakeVoice::new());
        fake.set_available(vec![VoiceInfo {
            id: "plugin:knowledge".into(),
            name: "Knowledge".into(),
            on: true,
            ready: true,
            facts: true,
        }]);
        core.set_voice_providers(fake);

        let voice = voice_facts(&core);
        assert_eq!(
            voice,
            json!({
                "provider": "plugin:knowledge",
                "state": "ready",
                "copy": true,
                "people": 3,
                "rules": 6,
                "style": true,
                "facts": true,
                "refreshedAt": 1_764_000_000,
            }),
            "{voice:#}"
        );
        let voice_dump = voice.to_string();
        assert!(!voice_dump.contains(SENTINEL), "{voice_dump}");
        assert!(!voice_dump.contains('@'), "{voice_dump}");

        let mut f = facts();
        f["voice"] = voice;
        let report = build_report(Inputs {
            mode: &Mode::Status,
            run: Some(&run()),
            home: Path::new("/Users/taylor"),
            facts: f,
            ai: ai_status(),
            window: json!({"runId": "run-1", "failed": []}),
        });
        let dump = report.to_string();
        assert!(!dump.contains(SENTINEL), "{dump}");
        assert!(!dump.contains('@'), "{dump}");
    }

    /// Task 8 (ask-capture design § 6): the `ask` part is the route's state and counts and a
    /// bool only — two threads with 3 turns, one running, a sentinel in every question and
    /// answer, yet it reaches neither `ask_facts` nor the whole report.
    #[test]
    fn status_smoke_reports_ask_counts_only() {
        use crate::testing::{choose_profile, claude_profile, core as test_core, FakeRunner};
        use crate::workspace::ask::store::{
            self,
            tests::{thread, turn},
            TurnState,
        };
        const SENTINEL: &str = "ASK_SENTINEL_5c1e";

        let dir = tempfile::tempdir().unwrap();
        let core = test_core(
            dir.path(),
            Arc::new(FakeRunner::new(vec![])),
            vec![claude_profile()],
        );
        choose_profile(&core, "claude");

        let mut first_done = turn(
            1,
            1_795_000_000,
            &format!("First? {SENTINEL}"),
            TurnState::Done,
        );
        first_done.answer = Some(format!("Answer one. {SENTINEL}"));
        let mut running = turn(
            2,
            1_795_000_010,
            &format!("Second? {SENTINEL}"),
            TurnState::Running,
        );
        running.job_id = Some("job-2".into());
        let mut second_done = turn(
            3,
            1_795_000_020,
            &format!("Third? {SENTINEL}"),
            TurnState::Done,
        );
        second_done.answer = Some(format!("Answer two. {SENTINEL}"));

        let mut r = core.repo().unwrap();
        store::write(
            &mut r,
            &thread("ask-1", 1_795_000_010, vec![first_done, running]),
        )
        .unwrap();
        store::write(&mut r, &thread("ask-2", 1_795_000_020, vec![second_done])).unwrap();
        drop(r);

        let ask = ask_facts(&core);
        assert_eq!(
            ask,
            json!({"route": "ready", "threads": 2, "turns": 3, "running": true}),
            "{ask:#}"
        );
        let ask_dump = ask.to_string();
        assert!(!ask_dump.contains(SENTINEL), "{ask_dump}");

        let mut f = facts();
        f["ask"] = ask;
        let report = build_report(Inputs {
            mode: &Mode::Status,
            run: Some(&run()),
            home: Path::new("/Users/taylor"),
            facts: f,
            ai: ai_status(),
            window: json!({"runId": "run-1", "failed": []}),
        });
        let dump = report.to_string();
        assert!(!dump.contains(SENTINEL), "{dump}");
    }

    #[test]
    fn a_status_report_passes_when_the_window_reported_this_run() {
        let window = json!({"runId": "run-1", "failed": [], "counts": {"needsReply": 2}});
        let out = build_report(Inputs {
            mode: &Mode::Status,
            run: Some(&run()),
            home: Path::new("/Users/taylor"),
            facts: facts(),
            ai: ai_status(),
            window,
        });
        assert_eq!(out["pass"], true, "{out:#}");
        assert_eq!(out["failed"], json!([]));
        assert_eq!(out["mode"], "status");
        assert_eq!(out["runId"], "run-1");
        assert_eq!(out["pid"], 42);
        assert_eq!(out["version"], "2.1.1");
        assert_eq!(
            out["storage"]["dataRoot"],
            "~/Library/Application Support/c/workspace"
        );
        assert_eq!(out["window"]["counts"]["needsReply"], 2);
        assert_eq!(out["ai"]["profiles"][0]["account"]["email"], "<redacted>");
        assert!(!out.to_string().contains("/Users/taylor/"));
        assert!(!out.to_string().contains("taylor@example.com"));
    }

    #[test]
    fn a_report_fails_on_what_went_wrong() {
        let report = |facts: Value, window: Value| {
            build_report(Inputs {
                mode: &Mode::Live,
                run: Some(&run()),
                home: Path::new("/Users/taylor"),
                facts,
                ai: ai_status(),
                window,
            })
        };
        let ok = json!({"runId": "run-1", "failed": []});
        let stale = report(facts(), json!({"runId": "an-earlier-run", "failed": []}));
        assert_eq!(
            stale["failed"],
            json!(["runId: the window's run isn't this one"])
        );
        let window_failed = report(
            facts(),
            json!({"runId": "run-1", "failed": ["draft: no draft text"]}),
        );
        assert_eq!(window_failed["pass"], false);
        assert_eq!(window_failed["failed"], json!(["draft: no draft text"]));
        let mut closed = facts();
        closed["workspaceOpen"] = json!(false);
        closed["storage"]["issue"] = json!("another Connect holds it");
        assert_eq!(
            report(closed, ok.clone())["failed"],
            json!(["the workspace didn't open: another Connect holds it"])
        );
        let mut busy = facts();
        busy["plugins"]["settled"] = json!(false);
        assert_eq!(
            report(busy, ok.clone())["failed"],
            json!(["the plugin manager didn't settle"])
        );
        // Without a run fixed at startup nothing passes.
        let unprepared = build_report(Inputs {
            mode: &Mode::Status,
            run: None,
            home: Path::new("/Users/taylor"),
            facts: facts(),
            ai: ai_status(),
            window: ok,
        });
        assert_eq!(unprepared["pass"], false);
    }

    fn menu_bar(tray: bool, applied: Value, computed: Value) -> Value {
        json!({"tray": tray, "applied": applied, "computed": computed})
    }

    fn report_with_menu_bar(menu_bar: Value) -> Value {
        let mut f = facts();
        f["menuBar"] = menu_bar;
        build_report(Inputs {
            mode: &Mode::Status,
            run: Some(&run()),
            home: Path::new("/Users/taylor"),
            facts: f,
            ai: ai_status(),
            window: json!({"runId": "run-1", "failed": []}),
        })
    }

    #[test]
    fn the_report_checks_the_tray() {
        let no_tray = report_with_menu_bar(menu_bar(
            false,
            json!({"title": "", "amber": false, "tooltipLength": 18, "rows": 0}),
            json!({"count": 0, "label": "", "amber": false}),
        ));
        assert_eq!(no_tray["pass"], false, "{no_tray:#}");
        assert!(
            no_tray["failed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f == "menuBar: no tray icon"),
            "{no_tray:#}"
        );

        let mismatch = report_with_menu_bar(menu_bar(
            true,
            json!({"title": "2", "amber": false, "tooltipLength": 40, "rows": 1}),
            json!({"count": 3, "label": "3", "amber": false}),
        ));
        assert!(
            mismatch["failed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f == "menuBar: the tray shows 2 but the count is 3"),
            "{mismatch:#}"
        );

        let equal = report_with_menu_bar(menu_bar(
            true,
            json!({"title": "3", "amber": false, "tooltipLength": 40, "rows": 1}),
            json!({"count": 3, "label": "3", "amber": false}),
        ));
        assert_eq!(equal["pass"], true, "{equal:#}");
        assert!(
            !equal["failed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f.as_str().unwrap_or_default().starts_with("menuBar")),
            "{equal:#}"
        );
        // No string in the report's menuBar is longer than the label; tooltipLength is a number.
        assert!(equal["menuBar"]["applied"]["tooltipLength"].is_number());
        assert!(equal["menuBar"]["applied"]["rows"].is_number());
        assert!(equal["menuBar"]["computed"]["count"].is_number());
        for v in [
            &equal["menuBar"]["applied"]["title"],
            &equal["menuBar"]["computed"]["label"],
        ] {
            let s = v.as_str().expect("a string");
            assert!(s.chars().count() <= 1, "{equal:#}");
        }
    }

    #[test]
    fn a_failed_recount_fails_the_check_instead_of_matching_a_quiet_tray() {
        // T4/M3: `computed` folds a compute error into `null`. Indexing into it reads back as
        // "" and `false`, which must not be allowed to match a tray that happens to show
        // nothing right now.
        let null_computed = report_with_menu_bar(menu_bar(
            true,
            json!({"title": "", "amber": false, "tooltipLength": 18, "rows": 0}),
            Value::Null,
        ));
        assert_eq!(null_computed["pass"], false, "{null_computed:#}");
        assert!(
            null_computed["failed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f == "menuBar: the count could not be computed"),
            "{null_computed:#}"
        );
    }

    #[test]
    fn only_an_ai_draft_or_summary_this_run_made_can_be_removed() {
        let before: HashSet<(String, String)> =
            [("summary".to_string(), "mail:old".to_string())].into();
        let started = 1_000;
        assert_eq!(
            may_discard("draft", "ai:m1", 1_005, started, &before),
            Ok(())
        );
        assert_eq!(
            may_discard("summary", "mail:new", 1_000, started, &before),
            Ok(())
        );
        for (kind, id, at) in [
            ("summary", "mail:old", 1_005), // was there before this run
            ("draft", "manual:m1", 1_005),  // the user's own reply
            ("draft", "ai:m1", 999),        // made before this run
            ("note", "n1", 1_005),          // anything else
        ] {
            assert!(
                may_discard(kind, id, at, started, &before).is_err(),
                "{kind} {id} {at}"
            );
        }
    }
}
