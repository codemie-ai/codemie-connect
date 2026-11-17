// Env-gated smoke-test support. The renderer calls smoke_mode() on boot to learn
// which non-destructive self-test to run, and smoke_emit() to print results to
// stdout (reliable channel, independent of webview console forwarding).
use crate::error::{CmdResult, InstallerError};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

#[derive(Serialize)]
pub struct SmokeFlags {
    pub probe: bool,
    pub smoke: bool,
    /// Exposes the view router for manual verification. Deliberately separate
    /// from the smoke flags, which take an early-return boot path that closes
    /// the app within seconds.
    pub dev: bool,
    pub smoke_ms: u64,
    pub shot: Option<String>,
    /// `CODEMIE_PLUGIN_SMOKE`: the plugin smoke to run: `isolation` (DESIGN 7.3), or a plugin
    /// marketplace folder (`plugin_smoke`, Task 25).
    pub plugin: Option<String>,
    /// This plugin smoke run's id, which the probe frame must echo back.
    pub plugin_run_id: Option<String>,
}

#[tauri::command]
pub fn smoke_mode() -> SmokeFlags {
    SmokeFlags {
        probe: std::env::var("CODEMIE_PROBE_SMOKE").is_ok(),
        smoke: std::env::var("CODEMIE_SMOKE").is_ok(),
        dev: std::env::var("CODEMIE_DEV").is_ok(),
        smoke_ms: std::env::var("CODEMIE_SMOKE_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2500),
        shot: std::env::var("CODEMIE_SHOT").ok(),
        plugin: std::env::var(PLUGIN_SMOKE).ok(),
        plugin_run_id: PLUGIN_RUN.get().map(|run| run.run_id.clone()),
    }
}

const PLUGIN_SMOKE: &str = "CODEMIE_PLUGIN_SMOKE";

/// One plugin smoke run, fixed at startup, so its report can't be mistaken for another run's.
pub struct SmokeRun {
    pub run_id: String,
    pub started_at: String,
    pub pid: u32,
    pub version: String,
}
static PLUGIN_RUN: OnceLock<SmokeRun> = OnceLock::new();

fn isolation_report_path() -> PathBuf {
    std::env::temp_dir().join("connect-plugin-isolation.json")
}

/// tauri-plugin-single-instance 2.4.5's socket on macOS (`platform_impl/macos.rs` `socket_path`,
/// built without its `semver` feature).
fn single_instance_socket(identifier: &str) -> PathBuf {
    PathBuf::from(format!(
        "/tmp/{}_si.sock",
        identifier.replace(['.', '-'], "_")
    ))
}

/// Starts a plugin smoke run, when `CODEMIE_PLUGIN_SMOKE` is set. Called in setup before the
/// single-instance plugin: it removes the previous report, so a stale PASS can never be read, and
/// refuses to run beside another Connect. That launch would be handed to the running app, which
/// exits 0 having tested nothing. Checking for the socket, rather than connecting to it, leaves the
/// other app alone.
pub fn start_plugin_smoke(identifier: &str, version: &str) {
    if std::env::var_os(PLUGIN_SMOKE).is_none() {
        return;
    }
    for report in [isolation_report_path(), super::plugin_smoke::report_path()] {
        if let Err(e) = std::fs::remove_file(&report) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "CODEMIE_PLUGIN_SMOKE: can't remove the old report {}: {e}",
                    report.display()
                );
                std::process::exit(3);
            }
        }
    }
    let socket = single_instance_socket(identifier);
    if cfg!(target_os = "macos") && socket.exists() {
        eprintln!(
            "CODEMIE_PLUGIN_SMOKE: another Connect is running ({} exists). This launch would be \
             handed to it and test nothing. Quit it (or delete the socket if no Connect is \
             running) and run the smoke again.",
            socket.display()
        );
        std::process::exit(3);
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    // Anything but `isolation` names a marketplace folder (`plugin_smoke`).
    if let Some(value) = std::env::var(PLUGIN_SMOKE)
        .ok()
        .filter(|v| v != "isolation")
    {
        super::plugin_smoke::prepare(&value, &run_id);
    }
    let _ = PLUGIN_RUN.set(SmokeRun {
        run_id,
        started_at: chrono::Utc::now().to_rfc3339(),
        pid: std::process::id(),
        version: version.to_string(),
    });
}

/// This plugin smoke run, once started.
pub fn run() -> Option<&'static SmokeRun> {
    PLUGIN_RUN.get()
}

/// How a forged IPC call from the isolation probe's frame starts its line. If one ever reached a
/// command, `smoke_emit` would print it, so the gate hears about it from Rust and not only from
/// the frame.
const FORGED_IPC_MARKER: &str = "PLUGIN_FRAME_FORGED_IPC";
static FORGED_IPC_REACHED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn smoke_emit(line: String) {
    if line.starts_with(FORGED_IPC_MARKER) {
        FORGED_IPC_REACHED.store(true, Ordering::SeqCst);
    }
    println!("{line}");
}

/// The isolation gate's fields and the value each must have (DESIGN 7.3).
const ISOLATION_GATE: [(&str, bool); 7] = [
    ("tauriGlobal", false),
    ("internals", false),
    ("ipcFetchRejected", true),
    ("invokeRejected", true),
    ("parentBlocked", true),
    ("moduleImportWorks", true),
    ("localStorageThrows", true),
];

/// The frame's report with Rust's own view added: this run's identity, whether the probe echoed
/// it (`probeRunId`), whether a forged call got through, which fields fail, and the verdict.
fn isolation_report(mut report: Value, forged_reached: bool, run: Option<&SmokeRun>) -> Value {
    if !report.is_object() {
        report = json!({ "error": "the report is not an object" });
    }
    let probe_run_id = report.get("runId").cloned().unwrap_or(Value::Null);
    report["probeRunId"] = probe_run_id.clone();
    report["runId"] = json!(run.map(|r| &r.run_id));
    report["startedAt"] = json!(run.map(|r| &r.started_at));
    report["pid"] = json!(run.map(|r| r.pid));
    report["version"] = json!(run.map(|r| &r.version));
    report["reportedAt"] = json!(chrono::Utc::now().to_rfc3339());
    if forged_reached {
        report["invokeRejected"] = json!(false);
    }
    report["forgedIpcReachedRust"] = json!(forged_reached);
    let mut failed: Vec<&str> = ISOLATION_GATE
        .iter()
        .filter(|(field, want)| report.get(field).and_then(Value::as_bool) != Some(*want))
        .map(|(field, _)| *field)
        .collect();
    if run.is_none() || probe_run_id != report["runId"] {
        failed.push("runId");
    }
    report["pass"] = json!(failed.is_empty());
    report["failed"] = json!(failed);
    report
}

/// Writes the plugin isolation report to `$TMPDIR/connect-plugin-isolation.json` and returns
/// where it went and whether the gate passed. Only during the plugin smoke.
#[tauri::command]
pub fn smoke_plugin_report(report: Value) -> CmdResult<Value> {
    if std::env::var_os(PLUGIN_SMOKE).is_none() {
        return Err(InstallerError::Other("No plugin smoke is running.".into()));
    }
    let report = isolation_report(
        report,
        FORGED_IPC_REACHED.load(Ordering::SeqCst),
        PLUGIN_RUN.get(),
    );
    let path = isolation_report_path();
    let text =
        serde_json::to_string_pretty(&report).map_err(|e| InstallerError::Other(e.to_string()))?;
    std::fs::write(&path, text)?;
    Ok(json!({ "path": path, "pass": report["pass"], "runId": report["runId"] }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> SmokeRun {
        SmokeRun {
            run_id: "run-1".into(),
            started_at: "2026-11-17T11:00:00+00:00".into(),
            pid: 42,
            version: "2.1.1".into(),
        }
    }

    fn isolated() -> Value {
        json!({
            "runId": "run-1",
            "tauriGlobal": false,
            "internals": false,
            "ipcFetchRejected": true,
            "invokeRejected": true,
            "parentBlocked": true,
            "moduleImportWorks": true,
            "localStorageThrows": true,
            "observed": { "origin": "null" }
        })
    }

    #[test]
    fn isolation_report_passes_only_when_every_field_holds() {
        let ok = isolation_report(isolated(), false, Some(&run()));
        assert_eq!(ok["pass"], json!(true));
        assert_eq!(ok["failed"], json!([]));
        assert_eq!(ok["forgedIpcReachedRust"], json!(false));
        assert_eq!(ok["observed"]["origin"], json!("null"));
        // The run is identified, so a report can't be mistaken for another run's.
        assert_eq!(ok["runId"], json!("run-1"));
        assert_eq!(ok["probeRunId"], json!("run-1"));
        assert_eq!(ok["startedAt"], json!("2026-11-17T11:00:00+00:00"));
        assert_eq!(ok["pid"], json!(42));
        assert_eq!(ok["version"], json!("2.1.1"));
        assert!(ok["reportedAt"].as_str().is_some_and(|t| t.contains('T')));

        // A forged call that reached Rust fails the gate even if the frame saw nothing.
        let forged = isolation_report(isolated(), true, Some(&run()));
        assert_eq!(forged["invokeRejected"], json!(false));
        assert_eq!(forged["pass"], json!(false));
        assert_eq!(forged["failed"], json!(["invokeRejected"]));

        for (field, wrong) in [
            ("tauriGlobal", json!(true)),
            ("internals", json!(true)),
            ("ipcFetchRejected", json!(false)),
            ("parentBlocked", json!(false)),
            ("moduleImportWorks", json!(false)),
            ("localStorageThrows", json!(false)),
            ("localStorageThrows", Value::Null),
        ] {
            let mut report = isolated();
            report[field] = wrong;
            let out = isolation_report(report, false, Some(&run()));
            assert_eq!(out["pass"], json!(false), "{field}");
            assert_eq!(out["failed"], json!([field]), "{field}");
        }
        // A frame that never reported: every field fails, the run id too.
        let none = isolation_report(
            json!({ "error": "frame did not report" }),
            false,
            Some(&run()),
        );
        assert_eq!(none["pass"], json!(false));
        assert_eq!(none["failed"].as_array().unwrap().len(), 8);
    }

    #[test]
    fn a_probe_from_another_run_fails_the_gate() {
        let mut stale = isolated();
        stale["runId"] = json!("an-earlier-run");
        let out = isolation_report(stale, false, Some(&run()));
        assert_eq!(out["pass"], json!(false));
        assert_eq!(out["failed"], json!(["runId"]));
        assert_eq!(out["probeRunId"], json!("an-earlier-run"));
        // Without a run fixed at startup nothing can pass.
        let unprepared = isolation_report(isolated(), false, None);
        assert_eq!(unprepared["pass"], json!(false));
        assert_eq!(unprepared["failed"], json!(["runId"]));
    }

    #[test]
    fn the_single_instance_socket_is_found_where_the_plugin_puts_it() {
        assert_eq!(
            single_instance_socket("com.epam.codemie.installer"),
            std::path::Path::new("/tmp/com_epam_codemie_installer_si.sock")
        );
        assert_eq!(
            single_instance_socket("a-b.c"),
            std::path::Path::new("/tmp/a_b_c_si.sock")
        );
    }
}
