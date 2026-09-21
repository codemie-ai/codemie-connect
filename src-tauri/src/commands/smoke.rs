// Env-gated smoke-test support. The renderer calls smoke_mode() on boot to learn
// which non-destructive self-test to run, and smoke_emit() to print results to
// stdout (reliable channel, independent of webview console forwarding).
use serde::Serialize;

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
    }
}

#[tauri::command]
pub fn smoke_emit(line: String) {
    println!("{line}");
}
