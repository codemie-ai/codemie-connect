//! `CODEMIE_PLUGIN_SMOKE=<marketplace folder>` (Task 25): the published plugins in the real app,
//! their pages in real sandboxed frames in the native WebView. Debug builds only.
//!
//! At start it makes a fresh data root (`$TMPDIR/connect-plugin-smoke-<run id>/workspace`), which
//! the app opens instead of the user's own (the `location.json` pointer goes there too). The window
//! (`ui/plugins/market-smoke.js`) then adds the marketplace, installs every plugin it offers,
//! agreeing to each permission sheet by its hash (only in this mode), waits for the plugin manager,
//! opens each plugin's pages and Settings sections and collects what their frames reported. Rust
//! adds its own view (which plugins loaded, why the others didn't, and what each task provider's
//! `tasks:status` answered: `ok`, or `needs_token` with no token saved, both a pass), decides the
//! verdict, writes `$TMPDIR/connect-plugin-smoke.json` and quits: 0 when it passed, 1 when it
//! didn't, 2 when the window never reported, 3 when the smoke can't run.
use super::smoke::SmokeRun;
use crate::error::{CmdResult, InstallerError};
use crate::plugins::manager::PluginManager;
use crate::workspace::task_provider::{ProviderError, TaskProviders};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const REPORT_FILE: &str = "connect-plugin-smoke.json";
/// The window reports well within this, or the smoke fails (exit 2).
const DEADLINE: Duration = Duration::from_secs(300);

/// Plugins expected to fail, and why: their host half doesn't load in Connect until the plugin
/// changes (PLUGIN-ENGINE.md §10, ruling R39). `(plugin, words its load error has, why)`.
const KNOWN_FAILURES: &[(&str, &str, &str)] = &[(
    "telegram",
    "doesn't have ctx.sessions",
    "needs plugin change: sessions API",
)];

/// This run's marketplace and data root.
pub struct MarketSmoke {
    pub market: PathBuf,
    pub data_root: PathBuf,
}

static MARKET: OnceLock<MarketSmoke> = OnceLock::new();
static REPORTED: AtomicBool = AtomicBool::new(false);

pub fn report_path() -> PathBuf {
    std::env::temp_dir().join(REPORT_FILE)
}

fn refuse(why: &str) -> ! {
    eprintln!("CODEMIE_PLUGIN_SMOKE: {why}");
    std::process::exit(3);
}

/// Sets up a marketplace smoke for `value` (the marketplace folder), or exits 3 when it can't
/// run. Called once at startup, before the workspace opens.
pub fn prepare(value: &str, run_id: &str) {
    if !cfg!(debug_assertions) {
        refuse("a marketplace smoke runs in a debug build only");
    }
    let market = PathBuf::from(value);
    if !market.join("echo-marketplace.json").is_file() {
        refuse(&format!(
            "{value} isn't a plugin marketplace folder (no echo-marketplace.json); give \
             `isolation` or a marketplace folder"
        ));
    }
    let data_root = std::env::temp_dir()
        .join(format!("connect-plugin-smoke-{run_id}"))
        .join("workspace");
    if let Err(e) = std::fs::create_dir_all(&data_root) {
        refuse(&format!("can't make {}: {e}", data_root.display()));
    }
    let _ = MARKET.set(MarketSmoke { market, data_root });
}

/// The data root the app opens during a marketplace smoke, instead of the user's own.
pub fn data_root() -> Option<&'static Path> {
    MARKET.get().map(|m| m.data_root.as_path())
}

/// Fails the smoke (exit 2) when the window hasn't reported by the deadline.
pub fn arm_watchdog(app: &AppHandle) {
    if MARKET.get().is_none() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(DEADLINE);
        if REPORTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let report = json!({
            "pass": false,
            "failed": [format!("the window didn't report within {} s", DEADLINE.as_secs())],
            "runId": super::smoke::run().map(|r| r.run_id.clone()),
        });
        let _ = std::fs::write(report_path(), report.to_string());
        eprintln!("PLUGIN_SMOKE {report}");
        app.exit(2);
    });
}

fn running() -> CmdResult<&'static MarketSmoke> {
    MARKET
        .get()
        .ok_or_else(|| InstallerError::Other("No plugin marketplace smoke is running.".into()))
}

fn manager(app: &AppHandle) -> Option<Arc<PluginManager>> {
    app.try_state::<Arc<PluginManager>>()
        .map(|m| m.inner().clone())
}

/// Which plugins the manager loaded, and why the others that are on didn't load.
#[tauri::command]
pub fn smoke_plugins_state(app: AppHandle) -> CmdResult<Value> {
    running()?;
    let m = manager(&app)
        .ok_or_else(|| InstallerError::Other("The plugin manager isn't running.".into()))?;
    Ok(json!({"loaded": m.loaded(), "problems": m.problems()}))
}

/// The code a provider's failure maps to (design §5 "Errors").
fn code_of(e: &ProviderError) -> &'static str {
    match e {
        ProviderError::NeedsToken => "needs_token",
        ProviderError::RateLimited { .. } => "rate_limited",
        ProviderError::Offline => "offline",
        ProviderError::NotFound(_) => "not_found",
        ProviderError::Refused(_) => "refused",
    }
}

/// What each installed plugin that provides tasks answers to `tasks:status`: `{plugin, status}`,
/// `ok` or the code it failed with.
async fn task_statuses(m: &PluginManager) -> Vec<Value> {
    let mut out = Vec::new();
    for p in TaskProviders::available(m) {
        let plugin = p.id.strip_prefix("plugin:").unwrap_or(&p.id).to_string();
        let status = match TaskProviders::call(m, &plugin, "status", json!({})).await {
            Ok(_) => "ok",
            Err(e) => code_of(&e),
        };
        out.push(json!({"plugin": plugin, "status": status}));
    }
    out
}

/// Writes the smoke's report with Rust's own view and the verdict, prints it, and quits with
/// the verdict's exit code.
#[tauri::command]
pub async fn smoke_plugins_report(app: AppHandle, report: Value) -> CmdResult<Value> {
    let smoke = running()?;
    if REPORTED.swap(true, Ordering::SeqCst) {
        return Err(InstallerError::Other("This smoke already reported.".into()));
    }
    let (loaded, problems, tasks) = match manager(&app) {
        Some(m) => (m.loaded(), m.problems(), task_statuses(&m).await),
        None => Default::default(),
    };
    let report = verdict(
        report,
        &loaded,
        &problems,
        &tasks,
        super::smoke::run(),
        Some(smoke),
    );
    let path = report_path();
    let text =
        serde_json::to_string_pretty(&report).map_err(|e| InstallerError::Other(e.to_string()))?;
    std::fs::write(&path, &text)?;
    let pass = report["pass"] == true;
    println!(
        "PLUGIN_SMOKE {}",
        json!({"path": path, "pass": pass, "runId": report["runId"], "failed": report["failed"],
               "knownFailures": report["knownFailures"]})
    );
    // After this answer reaches the window.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        app.exit(if pass { 0 } else { 1 });
    });
    Ok(json!({"path": path, "pass": pass}))
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// The errors a frame or a view reported.
fn errors_of(v: &Value) -> Vec<String> {
    v["errors"]
        .as_array()
        .map(|a| a.iter().map(text).collect())
        .unwrap_or_default()
}

/// The host-half commands a frame or a view asked for that failed.
fn failed_calls(v: &Value) -> Vec<String> {
    v["calls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["ok"] != true)
        .map(|c| {
            let command = text(&c["command"]);
            format!("its command “{command}” failed: {}", text(&c["error"]))
        })
        .collect()
}

/// One plugin's verdict: `pass`, `known-failure` or `fail`, with why.
fn plugin_verdict(
    p: &Value,
    loaded: &[String],
    problems: &BTreeMap<String, String>,
) -> (&'static str, Vec<String>) {
    let id = text(&p["id"]);
    let install = text(&p["install"]);
    if install != "installed" {
        return ("fail", vec![format!("not installed: {install}")]);
    }
    if let Some(problem) = problems.get(&id) {
        let known = KNOWN_FAILURES
            .iter()
            .find(|(plugin, words, _)| *plugin == id && problem.contains(words));
        return match known {
            Some((_, _, why)) => ("known-failure", vec![why.to_string()]),
            None => (
                "fail",
                vec![format!("its host half didn't load: {problem}")],
            ),
        };
    }
    if !loaded.contains(&id) {
        return ("fail", vec!["its host half never loaded".into()]);
    }
    let mut why = Vec::new();
    let frame = &p["frame"];
    if frame.is_object() {
        if frame["ready"] != true {
            why.push(format!("its page didn't start: {}", text(&frame["error"])));
        }
        why.extend(
            errors_of(frame)
                .into_iter()
                .map(|e| format!("page error: {e}")),
        );
        why.extend(failed_calls(frame));
        let views = p["views"].as_array().cloned().unwrap_or_default();
        if views.is_empty() && frame["ready"] == true {
            why.push("it added no page, section or card to open".into());
        }
        for v in &views {
            let name = format!("{} {}", text(&v["view"]), text(&v["id"]));
            if v["shown"] != true {
                why.push(format!("{name}: its frame wasn't shown"));
            }
            why.extend(
                errors_of(v)
                    .into_iter()
                    .map(|e| format!("{name}: page error: {e}")),
            );
            why.extend(failed_calls(v).into_iter().map(|c| format!("{name}: {c}")));
        }
        // A meeting's page (Echo's call page), its call slots drawn for it.
        let call = &p["call"];
        why.extend(
            errors_of(call)
                .into_iter()
                .map(|e| format!("meeting page: page error: {e}")),
        );
        why.extend(
            failed_calls(call)
                .into_iter()
                .map(|c| format!("meeting page: {c}")),
        );
    }
    why.dedup();
    (if why.is_empty() { "pass" } else { "fail" }, why)
}

/// The window's report with Rust's view added: this run's identity, which plugins loaded and why
/// the others didn't, what each task provider's `tasks:status` answered (`tasks`), each plugin's
/// verdict, the known failures, what failed, and `pass`.
fn verdict(
    mut report: Value,
    loaded: &[String],
    problems: &BTreeMap<String, String>,
    tasks: &[Value],
    run: Option<&SmokeRun>,
    smoke: Option<&MarketSmoke>,
) -> Value {
    if !report.is_object() {
        report = json!({"error": "the report is not an object"});
    }
    let window_run_id = report.get("runId").cloned().unwrap_or(Value::Null);
    report["windowRunId"] = window_run_id.clone();
    report["runId"] = json!(run.map(|r| &r.run_id));
    report["startedAt"] = json!(run.map(|r| &r.started_at));
    report["pid"] = json!(run.map(|r| r.pid));
    report["version"] = json!(run.map(|r| &r.version));
    report["reportedAt"] = json!(chrono::Utc::now().to_rfc3339());
    report["marketDir"] = json!(smoke.map(|s| &s.market));
    report["dataRoot"] = json!(smoke.map(|s| &s.data_root));
    report["loaded"] = json!(loaded);
    report["problems"] = json!(problems);
    report["tasks"] = json!(tasks);
    let mut failed = Vec::new();
    if run.is_none() || window_run_id != report["runId"] {
        failed.push("runId: the window's run isn't this one".to_string());
    }
    if let Some(e) = report.get("error").filter(|e| !e.is_null()) {
        failed.push(format!("the window: {}", text(e)));
    }
    let plugins = report["plugins"].as_array().cloned().unwrap_or_default();
    if plugins.is_empty() {
        failed.push("no plugin was installed".into());
    }
    // Review C-I1: the window makes each frame right after the install, while the manager is
    // still loading; a plugin's first call then must wait for its host half, never be refused.
    let early: Vec<String> = plugins
        .iter()
        .filter(|p| p["framedBeforeLoad"] == true)
        .map(|p| text(&p["id"]))
        .collect();
    // Only a plugin with a page has a frame to make early.
    let framed = plugins.iter().any(|p| p["frame"].is_object());
    if framed && early.is_empty() {
        failed.push(
            "no frame was made before its plugin loaded, so the smoke didn't try that case".into(),
        );
    }
    report["framedBeforeLoad"] = json!(early);
    let mut known = Vec::new();
    let mut verdicts = Map::new();
    for p in &plugins {
        let id = text(&p["id"]);
        let (status, why) = plugin_verdict(p, loaded, problems);
        match status {
            "known-failure" => known.push(json!({
                "id": id, "why": why.join("; "), "problem": problems.get(&id),
            })),
            "fail" => failed.extend(why.iter().map(|w| format!("{id}: {w}"))),
            _ => {}
        }
        verdicts.insert(id, json!({"status": status, "why": why}));
    }
    // With no token saved, a task provider answers `needs_token`; anything but that or `ok` fails.
    for t in tasks {
        let status = text(&t["status"]);
        if status != "ok" && status != "needs_token" {
            failed.push(format!(
                "{}: tasks:status answered {status}",
                text(&t["plugin"])
            ));
        }
    }
    report["verdicts"] = Value::Object(verdicts);
    report["knownFailures"] = json!(known);
    report["pass"] = json!(failed.is_empty());
    report["failed"] = json!(failed);
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> SmokeRun {
        SmokeRun {
            run_id: "run-1".into(),
            started_at: "2026-11-17T21:00:00+00:00".into(),
            pid: 42,
            version: "2.1.1".into(),
        }
    }

    const SESSIONS: &str = "unsupported: CodeMie Connect doesn't have ctx.sessions (only Echo \
        has it), so this plugin needs a change to run here: cannot read property 'clearChannel' \
        of undefined";

    fn page(id: &str, views: Value) -> Value {
        json!({"id": id, "install": "installed", "framedBeforeLoad": true, "frame": {"ready": true, "error": "", "errors": []}, "views": views})
    }

    fn section(id: &str) -> Value {
        json!({"view": "section", "id": id, "shown": true, "ready": true, "errors": [], "height": 400})
    }

    /// The published four as they run today: three pass, Telegram is the known failure.
    fn published() -> (Value, Vec<String>, BTreeMap<String, String>) {
        let report = json!({
            "runId": "run-1",
            "market": {"name": "onetest-2"},
            "plugins": [
                page("scheduler", json!([section("main")])),
                page("github", json!([section("main")])),
                page("obsidian", json!([{"view": "activity", "id": "kb", "shown": true, "ready": true, "errors": []}, section("main")])),
                {"id": "telegram", "install": "installed", "framedBeforeLoad": true, "frame": null, "views": []},
            ],
        });
        let loaded = vec!["github".into(), "obsidian".into(), "scheduler".into()];
        let problems = BTreeMap::from([("telegram".to_string(), SESSIONS.to_string())]);
        (report, loaded, problems)
    }

    #[test]
    fn telegram_is_a_known_failure_and_the_rest_pass() {
        let (report, loaded, problems) = published();
        let out = verdict(report, &loaded, &problems, &[], Some(&run()), None);
        assert_eq!(out["pass"], true, "{out:#}");
        assert_eq!(out["failed"], json!([]));
        assert_eq!(
            out["knownFailures"],
            json!([{"id": "telegram", "why": "needs plugin change: sessions API", "problem": SESSIONS}])
        );
        assert_eq!(out["verdicts"]["scheduler"]["status"], "pass");
        assert_eq!(out["verdicts"]["telegram"]["status"], "known-failure");
        assert_eq!(out["runId"], "run-1");
        assert_eq!(out["windowRunId"], "run-1");
        assert_eq!(out["pid"], 42);
        assert_eq!(out["loaded"], json!(["github", "obsidian", "scheduler"]));
        assert_eq!(out["problems"]["telegram"], SESSIONS);
        assert_eq!(
            out["framedBeforeLoad"],
            json!(["scheduler", "github", "obsidian", "telegram"])
        );
    }

    /// A change to the published run: its report, the loaded plugins, the load problems.
    type Change = Box<dyn Fn(&mut Value, &mut Vec<String>, &mut BTreeMap<String, String>)>;

    #[test]
    fn any_unexpected_error_fails_the_smoke() {
        let cases: Vec<(&str, Change)> = vec![
            (
                "scheduler: page error: TypeError: x is undefined",
                Box::new(|r, _, _| {
                    r["plugins"][0]["frame"]["errors"] = json!(["TypeError: x is undefined"]);
                }),
            ),
            (
                "github: section main: page error: CSP blocked inline (style-src)",
                Box::new(|r, _, _| {
                    r["plugins"][1]["views"][0]["errors"] =
                        json!(["CSP blocked inline (style-src)"]);
                }),
            ),
            (
                "github: section main: its frame wasn't shown",
                Box::new(|r, _, _| {
                    r["plugins"][1]["views"][0]["shown"] = json!(false);
                }),
            ),
            (
                "obsidian: its page didn't start: Could not load client.js",
                Box::new(|r, _, _| {
                    r["plugins"][2]["frame"] =
                        json!({"ready": false, "error": "Could not load client.js", "errors": []});
                }),
            ),
            (
                "scheduler: it added no page, section or card to open",
                Box::new(|r, _, _| {
                    r["plugins"][0]["views"] = json!([]);
                }),
            ),
            (
                "github: its host half didn't load: plugin_error: boom",
                Box::new(|_, l, p| {
                    l.retain(|id| id != "github");
                    p.insert("github".into(), "plugin_error: boom".into());
                }),
            ),
            (
                "telegram: its host half didn't load: plugin_error: something else",
                Box::new(|_, _, p| {
                    p.insert("telegram".into(), "plugin_error: something else".into());
                }),
            ),
            (
                "obsidian: its host half never loaded",
                Box::new(|_, l, _| {
                    l.retain(|id| id != "obsidian");
                }),
            ),
            (
                "github: section main: its command “status” failed: permission: no",
                Box::new(|r, _, _| {
                    r["plugins"][1]["views"][0]["calls"] =
                        json!([{"command": "status", "ok": false, "error": "permission: no"}]);
                }),
            ),
            (
                "obsidian: meeting page: page error: Slot call.header: x is null",
                Box::new(|r, _, _| {
                    r["plugins"][2]["call"] = json!({"errors": ["Slot call.header: x is null"], "calls": [],
                                                     "header": [], "menu": [], "minutes": []});
                }),
            ),
            (
                "obsidian: meeting page: its command “call_knowledge” failed: plugin_error: no",
                Box::new(|r, _, _| {
                    r["plugins"][2]["call"] = json!({"errors": [], "header": [], "menu": [], "minutes": [],
                        "calls": [{"command": "call_knowledge", "ok": false, "error": "plugin_error: no"}]});
                }),
            ),
            (
                "obsidian: its command “knowledge_wake” failed: timeout: slow",
                Box::new(|r, _, _| {
                    r["plugins"][2]["frame"]["calls"] = json!([
                        {"command": "view", "ok": true, "error": ""},
                        {"command": "knowledge_wake", "ok": false, "error": "timeout: slow"},
                    ]);
                }),
            ),
            (
                "scheduler: not installed: refused: it needs Echo 0.9.13",
                Box::new(|r, _, _| {
                    r["plugins"][0]["install"] = json!("refused: it needs Echo 0.9.13");
                }),
            ),
            (
                "the window: the marketplace couldn't be added",
                Box::new(|r, _, _| {
                    r["error"] = json!("the marketplace couldn't be added");
                }),
            ),
            (
                "runId: the window's run isn't this one",
                Box::new(|r, _, _| {
                    r["runId"] = json!("an-earlier-run");
                }),
            ),
            // Review C-I1: a frame made before its host half loaded called too early.
            (
                "scheduler: its command “view” failed: “scheduler” isn't on in Connect",
                Box::new(|r, _, _| {
                    r["plugins"][0]["frame"]["calls"] = json!([
                        {"command": "view", "ok": false, "error": "“scheduler” isn't on in Connect"},
                    ]);
                }),
            ),
            (
                "no frame was made before its plugin loaded, so the smoke didn't try that case",
                Box::new(|r, _, _| {
                    for p in r["plugins"].as_array_mut().unwrap() {
                        p["framedBeforeLoad"] = json!(false);
                    }
                }),
            ),
        ];
        for (want, change) in cases {
            let (mut report, mut loaded, mut problems) = published();
            change(&mut report, &mut loaded, &mut problems);
            let out = verdict(report, &loaded, &problems, &[], Some(&run()), None);
            assert_eq!(out["pass"], false, "{want}: {out:#}");
            assert_eq!(out["failed"], json!([want]), "{want}");
        }
        // Nothing installed, or no run fixed at startup: nothing can pass.
        let empty = verdict(
            json!({"runId": "run-1", "plugins": []}),
            &[],
            &BTreeMap::new(),
            &[],
            Some(&run()),
            None,
        );
        assert_eq!(empty["failed"], json!(["no plugin was installed"]));
        let (report, loaded, problems) = published();
        let unprepared = verdict(report, &loaded, &problems, &[], None, None);
        assert_eq!(unprepared["pass"], false);
    }

    /// The marketplace's Todoist: no page, so no frame to make early; with no token saved its
    /// `tasks:status` answers `needs_token`, which passes; any other failure code fails.
    #[test]
    fn a_task_provider_passes_with_ok_or_needs_token() {
        let report = json!({"runId": "run-1", "plugins": [{"id": "todoist", "install": "installed",
            "framedBeforeLoad": false, "frame": null, "views": []}]});
        let loaded = vec!["todoist".to_string()];
        let run_with = |status: &str| {
            let tasks = [json!({"plugin": "todoist", "status": status})];
            verdict(
                report.clone(),
                &loaded,
                &BTreeMap::new(),
                &tasks,
                Some(&run()),
                None,
            )
        };
        for status in ["needs_token", "ok"] {
            let out = run_with(status);
            assert_eq!(out["pass"], true, "{status}: {out:#}");
            assert_eq!(
                out["tasks"],
                json!([{"plugin": "todoist", "status": status}])
            );
            assert_eq!(out["verdicts"]["todoist"]["status"], "pass");
        }
        for status in ["offline", "refused", "rate_limited"] {
            let out = run_with(status);
            assert_eq!(out["pass"], false, "{status}");
            assert_eq!(
                out["failed"],
                json!([format!("todoist: tasks:status answered {status}")])
            );
        }
    }

    #[test]
    fn a_fixed_telegram_simply_passes() {
        let (mut report, mut loaded, _) = published();
        report["plugins"][3] = page("telegram", json!([section("main")]));
        loaded.push("telegram".into());
        let out = verdict(report, &loaded, &BTreeMap::new(), &[], Some(&run()), None);
        assert_eq!(out["pass"], true, "{out:#}");
        assert_eq!(out["knownFailures"], json!([]));
        assert_eq!(out["verdicts"]["telegram"]["status"], "pass");
    }
}
