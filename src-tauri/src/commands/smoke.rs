// Env-gated smoke-test support. The renderer calls smoke_mode() on boot to learn
// which non-destructive self-test to run, and smoke_emit() to print results to
// stdout (reliable channel, independent of webview console forwarding).
use crate::error::{CmdResult, InstallerError};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

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
    /// `CODEMIE_PLUGIN_SMOKE`: the plugin smoke to run (`isolation`, DESIGN 7.3).
    pub plugin: Option<String>,
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
    }
}

const PLUGIN_SMOKE: &str = "CODEMIE_PLUGIN_SMOKE";

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

/// The frame's report with Rust's own view added: whether a forged call got through, which
/// fields fail, and the verdict.
fn isolation_report(mut report: Value, forged_reached: bool) -> Value {
    if !report.is_object() {
        report = json!({ "error": "the report is not an object" });
    }
    if forged_reached {
        report["invokeRejected"] = json!(false);
    }
    report["forgedIpcReachedRust"] = json!(forged_reached);
    let failed: Vec<&str> = ISOLATION_GATE
        .iter()
        .filter(|(field, want)| report.get(field).and_then(Value::as_bool) != Some(*want))
        .map(|(field, _)| *field)
        .collect();
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
    let report = isolation_report(report, FORGED_IPC_REACHED.load(Ordering::SeqCst));
    let path = std::env::temp_dir().join("connect-plugin-isolation.json");
    let text =
        serde_json::to_string_pretty(&report).map_err(|e| InstallerError::Other(e.to_string()))?;
    std::fs::write(&path, text)?;
    Ok(json!({ "path": path, "pass": report["pass"] }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated() -> Value {
        json!({
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
        let ok = isolation_report(isolated(), false);
        assert_eq!(ok["pass"], json!(true));
        assert_eq!(ok["failed"], json!([]));
        assert_eq!(ok["forgedIpcReachedRust"], json!(false));
        assert_eq!(ok["observed"]["origin"], json!("null"));

        // A forged call that reached Rust fails the gate even if the frame saw nothing.
        let forged = isolation_report(isolated(), true);
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
            let out = isolation_report(report, false);
            assert_eq!(out["pass"], json!(false), "{field}");
            assert_eq!(out["failed"], json!([field]), "{field}");
        }
        // A frame that never reported: every field fails.
        let none = isolation_report(json!({ "error": "frame did not report" }), false);
        assert_eq!(none["pass"], json!(false));
        assert_eq!(none["failed"].as_array().unwrap().len(), 7);
    }
}
