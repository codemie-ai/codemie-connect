//! The tour's verdict, `results.json` and the Rust half of the HTML report (design § 8).
//!
//! [`verdict`] is pure: it takes the window's own report (`runner.js`'s `{runId, stops, ops,
//! refused}`), this run's identity ([`TourRun`]) and a live snapshot of the menu bar
//! ([`tour_menu_bar`]'s own facts), and decides pass or fail from them — never trusting a stop's
//! own `pass` field, so a stale or tampered report can't pass (design's anti-goals, ruling 13).
//! [`tour_report`] calls it once, writes `<test dir>/tour/results.json`, prints `TOUR {…}` and
//! exits. [`arm_watchdog`] answers the same way if nothing ever calls it within 600 s.
use super::{active, TourRun};
use crate::commands::status_smoke;
use crate::error::{CmdResult, InstallerError};
use crate::workspace::WorkspaceState;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How long the window has to call [`tour_report`] before the watchdog reports a timeout itself.
const WATCHDOG: Duration = Duration::from_secs(600);

/// The first call to report wins; the watchdog and a stray second call from the window are no-ops.
static REPORTED: AtomicBool = AtomicBool::new(false);

fn require_main_frame(call: &tauri::ipc::Request<'_>) -> CmdResult<()> {
    crate::plugins::caller::require_main_frame(call).map_err(|e| InstallerError::Other(e.message))
}

/// This run's live menu bar: [`status_smoke::menu_bar_facts`] (tray, applied, forced recount)
/// plus the applied menu's own row texts (design § 5's `menu_bar::rows`, read off the view
/// already applied to the tray, `core.menu_bar.last()`). `{tray: false, applied: null, computed:
/// null, rowTexts: []}` when the workspace never opened.
fn live_menu_bar(app: &AppHandle) -> Value {
    let state = app.state::<WorkspaceState>();
    let Some(core) = state.core.clone() else {
        return json!({"tray": false, "applied": null, "computed": null, "rowTexts": []});
    };
    let mut facts = status_smoke::menu_bar_facts(app, &core);
    let row_texts: Vec<String> = core
        .menu_bar
        .last()
        .map(|v| v.rows.into_iter().map(|r| r.text).collect())
        .unwrap_or_default();
    facts["rowTexts"] = json!(row_texts);
    facts
}

/// The running binary's own path and when it was built (its file's mtime), for the report's
/// header: the tour never runs a bundle, so this is the evidence of what was actually tested.
fn current_binary() -> Value {
    let path = std::env::current_exe().ok();
    let mtime = path
        .as_deref()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
    json!({"path": path, "mtime": mtime})
}

/// Rust's verdict on `window` (`runner.js`'s report), this run's identity and a live
/// [`live_menu_bar`] snapshot: `{runId, sha, startedAt, finishedAt, binary, stops, ops, refused,
/// menuBar, pass, failed}` (design § 8). Fails on: a report from another run; a stop with no
/// checks; a stop whose capture is blank; a failed check or a thrown error; anything refused; or
/// the applied menu bar not matching a fresh recount — checked here independently of whatever
/// T28's own check in `window` already found.
pub fn verdict(window: Value, run: &TourRun, facts: Value) -> Value {
    let mut failed: Vec<String> = Vec::new();

    let window_run_id = window.get("runId").and_then(Value::as_str).unwrap_or("");
    if window_run_id != run.run_id {
        failed.push(format!(
            "runId: the report is from {window_run_id:?}, not this run ({:?})",
            run.run_id
        ));
    }

    let stops = window
        .get("stops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for stop in &stops {
        let id = stop.get("id").and_then(Value::as_str).unwrap_or("?");
        let checks = stop
            .get("checks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if checks.is_empty() {
            failed.push(format!("{id}: no checks ran"));
        }
        for check in &checks {
            if check.get("pass") != Some(&Value::Bool(true)) {
                let name = check.get("name").and_then(Value::as_str).unwrap_or("check");
                let detail = check.get("detail").and_then(Value::as_str).unwrap_or("");
                failed.push(if detail.is_empty() {
                    format!("{id}: {name}")
                } else {
                    format!("{id}: {name} ({detail})")
                });
            }
        }
        if let Some(error) = stop.get("error").and_then(Value::as_str) {
            failed.push(format!("{id}: {error}"));
        }
        if stop.get("capture").and_then(|c| c.get("blank")) == Some(&Value::Bool(true)) {
            failed.push(format!("{id}: the capture is blank"));
        }
    }

    let refused = window
        .get("refused")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in &refused {
        failed.push(format!("refused: {r}"));
    }

    if facts.get("applied").is_none_or(Value::is_null)
        || facts.get("computed").is_none_or(Value::is_null)
    {
        failed.push("menuBar: nothing was applied or computed".into());
    } else {
        let applied_title = facts["applied"]["title"].as_str().unwrap_or_default();
        let applied_amber = facts["applied"]["amber"] == true;
        let computed_label = facts["computed"]["label"].as_str().unwrap_or_default();
        let computed_amber = facts["computed"]["amber"] == true;
        let computed_count = facts["computed"]["count"].as_u64().unwrap_or(0);
        if applied_title != computed_label || applied_amber != computed_amber {
            failed.push(format!(
                "menuBar: the applied view shows {applied_title:?} but the recount is {computed_label:?}"
            ));
        }
        // Design ruling 13: the seeded tour always has something to fix, so the recount is
        // amber with a non-zero count; a tour whose seed stops doing that loses its own evidence.
        if !computed_amber {
            failed.push("menuBar: the recount isn't amber".into());
        }
        if computed_count == 0 {
            failed.push("menuBar: the recount's count is 0".into());
        }
    }

    json!({
        "runId": run.run_id,
        "sha": run.sha,
        "startedAt": chrono::DateTime::from_timestamp(run.started_unix, 0).map(|d| d.to_rfc3339()),
        "finishedAt": chrono::Utc::now().to_rfc3339(),
        "binary": current_binary(),
        "stops": stops,
        "ops": window.get("ops").cloned().unwrap_or(json!([])),
        "refused": refused,
        "menuBar": facts,
        "pass": failed.is_empty(),
        "failed": failed,
    })
}

/// Writes `result` to `<test dir>/tour/results.json` and prints `TOUR {…}`. `Err` names what
/// failed (the folder, the encoding or the write itself): a run whose own evidence can't be
/// written must not be mistaken for a quiet success by `run.sh`, which only renders a report
/// when this file exists.
fn write_report(run: &TourRun, result: &Value) -> Result<std::path::PathBuf, String> {
    let dir = run.test_dir.join("tour");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("CODEMIE_TOUR: can't create {}: {e}", dir.display()))?;
    let path = dir.join("results.json");
    let text = serde_json::to_string_pretty(result)
        .map_err(|e| format!("CODEMIE_TOUR: can't encode results.json: {e}"))?;
    std::fs::write(&path, &text)
        .map_err(|e| format!("CODEMIE_TOUR: can't write {}: {e}", path.display()))?;
    println!(
        "TOUR {}",
        json!({"path": &path, "pass": result["pass"], "failed": result["failed"]})
    );
    Ok(path)
}

/// [`write_report`], then exits after 300 ms (so the answer reaches the caller first) with `code`
/// on success, or 1 with a clear stderr message when `results.json` couldn't be written at all —
/// never a silent `eprintln!` that leaves the run looking like whatever `code` would have been.
fn finish(app: &AppHandle, run: &'static TourRun, result: Value, code: i32) -> std::path::PathBuf {
    let app = app.clone();
    match write_report(run, &result) {
        Ok(path) => {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                app.exit(code);
            });
            path
        }
        Err(e) => {
            eprintln!("{e}");
            let path = run.test_dir.join("tour").join("results.json");
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                app.exit(1);
            });
            path
        }
    }
}

/// The window's own menu-bar facts (design § 5): [`live_menu_bar`] plus the applied menu's row
/// texts. `require_main_frame` first; a plugin frame never reaches native commands at all.
#[tauri::command]
pub async fn tour_menu_bar(app: AppHandle, call: tauri::ipc::Request<'_>) -> CmdResult<Value> {
    require_main_frame(&call)?;
    let blocking = app.clone();
    tauri::async_runtime::spawn_blocking(move || live_menu_bar(&blocking))
        .await
        .map_err(|e| InstallerError::Other(e.to_string()))
}

/// Ends the tour: [`verdict`] over `report` (the window's own) and this run's live menu bar, then
/// [`finish`]. Fails ("No tour is running.") off a tour build, or once the watchdog or a second
/// call already reported.
#[tauri::command]
pub async fn tour_report(
    app: AppHandle,
    call: tauri::ipc::Request<'_>,
    report: Value,
) -> CmdResult<Value> {
    require_main_frame(&call)?;
    let run = active().ok_or_else(|| InstallerError::Other("No tour is running.".into()))?;
    if REPORTED.swap(true, Ordering::SeqCst) {
        return Err(InstallerError::Other("The tour already reported.".into()));
    }
    let blocking = app.clone();
    let facts = tauri::async_runtime::spawn_blocking(move || live_menu_bar(&blocking))
        .await
        .map_err(|e| InstallerError::Other(e.to_string()))?;
    let result = verdict(report, run, facts);
    let code = if result["pass"] == true { 0 } else { 1 };
    let path = finish(&app, run, result.clone(), code);
    Ok(json!({"path": path, "pass": result["pass"], "failed": result["failed"]}))
}

/// Arms the 600 s watchdog (design's exit codes: 2 "nothing reported within 600 s"). Only while a
/// tour runs; a no-op otherwise. The first caller wins: once the window calls [`tour_report`],
/// this is a no-op too.
pub fn arm_watchdog(app: &AppHandle) {
    let Some(run) = active() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(WATCHDOG);
        if REPORTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let result = json!({"pass": false, "failed": ["nothing reported within 600 s"]});
        finish(&app, run, result, 2);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::tour::Only;
    use std::path::PathBuf;

    fn run() -> TourRun {
        TourRun {
            run_id: "run-1".into(),
            sha: "abc1234".into(),
            only: Only::All,
            test_dir: PathBuf::from("/tmp/connect-tour-x/workspace"),
            started_unix: 1_700_000_000,
        }
    }

    fn passing_facts() -> Value {
        json!({
            "tray": false,
            "applied": {"title": "2", "amber": true, "tooltipLength": 20, "rows": 1},
            "computed": {"count": 2, "label": "2", "amber": true},
            "rowTexts": ["Replies: 2"],
        })
    }

    fn passing_window() -> Value {
        json!({
            "runId": "run-1",
            "stops": [
                {"id": "T01", "checks": [{"name": "a", "pass": true, "detail": ""}],
                 "capture": {"blank": false}, "error": null},
            ],
            "ops": ["snapshot"],
            "refused": [],
        })
    }

    fn failed_strings(v: &Value) -> Vec<String> {
        v["failed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn all_passing_passes() {
        let v = verdict(passing_window(), &run(), passing_facts());
        assert_eq!(v["pass"], true, "{v}");
        assert_eq!(v["failed"], json!([]));
        assert_eq!(v["runId"], "run-1");
        assert_eq!(v["sha"], "abc1234");
        assert_eq!(v["menuBar"], passing_facts());
    }

    #[test]
    fn a_report_from_another_run_fails() {
        let mut w = passing_window();
        w["runId"] = json!("run-2");
        let v = verdict(w, &run(), passing_facts());
        assert_eq!(v["pass"], false);
        assert!(
            failed_strings(&v).iter().any(|f| f.contains("runId")),
            "{v}"
        );
    }

    #[test]
    fn a_stop_with_no_checks_fails() {
        let mut w = passing_window();
        w["stops"][0]["checks"] = json!([]);
        let v = verdict(w, &run(), passing_facts());
        assert_eq!(v["pass"], false);
        assert!(
            failed_strings(&v)
                .iter()
                .any(|f| f.contains("T01") && f.contains("no checks")),
            "{v}"
        );
    }

    #[test]
    fn a_blank_capture_fails() {
        let mut w = passing_window();
        w["stops"][0]["capture"]["blank"] = json!(true);
        let v = verdict(w, &run(), passing_facts());
        assert_eq!(v["pass"], false);
        assert!(
            failed_strings(&v).iter().any(|f| f.contains("blank")),
            "{v}"
        );
    }

    #[test]
    fn menu_bar_mismatch_fails() {
        let mut f = passing_facts();
        f["applied"]["title"] = json!("2");
        f["computed"]["label"] = json!("3");
        let v = verdict(passing_window(), &run(), f);
        assert_eq!(v["pass"], false);
        assert!(
            failed_strings(&v).iter().any(|f| f.contains("menuBar")),
            "{v}"
        );
    }

    /// A failed `results.json` write must be `Err`, never a swallowed `eprintln!`: `finish` (and
    /// so `tour_report` and the watchdog) only forces a non-zero exit because this is `Err`, not
    /// just a side-effecting print, when the file can't be made.
    #[test]
    fn write_report_fails_when_the_tour_folder_cant_be_made() {
        let dir = tempfile::tempdir().unwrap();
        // A plain file named `tour` blocks `create_dir_all("<test dir>/tour")`.
        std::fs::write(dir.path().join("tour"), "").unwrap();
        let mut r = run();
        r.test_dir = dir.path().to_path_buf();
        let result = write_report(&r, &json!({"pass": true, "failed": []}));
        assert!(result.is_err(), "{result:?}");
        assert!(result.unwrap_err().contains("tour"));
    }
}
