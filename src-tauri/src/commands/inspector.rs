// System inspection: probe git / node / npm / codemie. Port of src/main/inspector.js.
use std::path::Path;

use serde::Serialize;

use crate::commands::runner::capture;

const GIT_BINARIES: &[&str] = &["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
const NODE_BINARIES: &[&str] = &["/opt/homebrew/bin/node", "/usr/local/bin/node"];

#[derive(Serialize, Default, Clone)]
pub struct Probe {
    pub found: bool,
    pub version: String,
}

/// Generic probe: found when exit 0 and the first output line is non-empty.
fn probe_from(code: i32, stdout: &str) -> Probe {
    let version = stdout.trim().split('\n').next().unwrap_or("").to_string();
    Probe {
        found: code == 0 && !version.is_empty(),
        version,
    }
}

/// CodeMie probe: lenient about exit code (the CLI may exit non-zero while still
/// printing help) but treats exit 127 / "command not found" as a genuine miss.
fn codemie_from(code: i32, stdout: &str, stderr: &str) -> Probe {
    let out = format!("{stdout}{stderr}");
    let lower = out.to_lowercase();
    if code == 127 || lower.contains("command not found") || lower.contains("not found:") {
        return Probe::default();
    }
    Probe {
        found: !out.trim().is_empty(),
        version: String::new(),
    }
}

#[tauri::command]
pub async fn check_git() -> Probe {
    let r = capture("git --version", None).await;
    probe_from(r.code, &r.stdout)
}

#[tauri::command]
pub async fn check_node() -> Probe {
    let r = capture("node --version", None).await;
    probe_from(r.code, &r.stdout)
}

#[tauri::command]
pub async fn check_npm() -> Probe {
    let r = capture("npm --version", None).await;
    probe_from(r.code, &r.stdout)
}

#[tauri::command]
pub async fn check_codemie() -> Probe {
    let r = capture("codemie --help", None).await;
    codemie_from(r.code, &r.stdout, &r.stderr)
}

/// Setup-completeness status for the CodeMie CLI.
#[derive(Serialize, Default, Clone)]
pub struct SetupStatus {
    pub configured: bool,
    pub profile_count: usize,
}

/// Pure parser: a CodeMie CLI config is "configured" when it parses as JSON and
/// carries at least one entry under `profiles`. Returns (configured, profile_count).
fn parse_setup_config(json: &str) -> (bool, usize) {
    let count = serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| {
            v.get("profiles")
                .and_then(|p| p.as_object())
                .map(|o| o.len())
        })
        .unwrap_or(0);
    (count >= 1, count)
}

/// Reads `$HOME/.codemie/codemie-cli.config.json` and reports whether the CLI has
/// been set up (used to gate `codemie proxy connect desktop`). Missing/unreadable
/// file → not configured.
#[tauri::command]
pub fn check_codemie_setup() -> SetupStatus {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = format!("{home}/.codemie/codemie-cli.config.json");
    let (configured, profile_count) = std::fs::read_to_string(&path)
        .map(|s| parse_setup_config(&s))
        .unwrap_or((false, 0));
    SetupStatus {
        configured,
        profile_count,
    }
}

#[tauri::command]
pub fn git_binary_path() -> Option<String> {
    GIT_BINARIES
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|s| s.to_string())
}

#[tauri::command]
pub fn node_binary_path() -> Option<String> {
    NODE_BINARIES
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from test/inspector.test.js (testing the pure parsing logic directly).
    #[test]
    fn check_node_parses_version_and_found_on_exit_0() {
        let r = probe_from(0, "v24.15.0\n");
        assert!(r.found);
        assert_eq!(r.version, "v24.15.0");
    }

    #[test]
    fn probe_found_false_on_nonzero_exit() {
        assert!(!probe_from(127, "").found);
    }

    #[test]
    fn codemie_lenient_nonempty_output_is_installed_even_if_exit_nonzero() {
        assert!(codemie_from(1, "Usage: codemie ...", "").found);
    }

    #[test]
    fn codemie_found_false_when_output_empty() {
        assert!(!codemie_from(127, "", "").found);
    }

    #[test]
    fn codemie_treats_command_not_found_as_not_installed() {
        assert!(!codemie_from(127, "", "zsh:1: command not found: codemie").found);
    }

    // --- check_codemie_setup: pure config parsing (home-launcher) ---

    #[test]
    fn setup_config_empty_or_invalid_json_is_not_configured() {
        assert_eq!(parse_setup_config(""), (false, 0));
        assert_eq!(parse_setup_config("{ not json"), (false, 0));
        assert_eq!(parse_setup_config("null"), (false, 0));
    }

    #[test]
    fn setup_config_no_profiles_key_is_not_configured() {
        assert_eq!(parse_setup_config(r#"{"version":2}"#), (false, 0));
    }

    #[test]
    fn setup_config_empty_profiles_is_not_configured() {
        assert_eq!(parse_setup_config(r#"{"profiles":{}}"#), (false, 0));
    }

    #[test]
    fn setup_config_one_profile_is_configured() {
        let cfg = r#"{"version":2,"activeProfile":"prod","profiles":{"prod":{"baseUrl":"x"}}}"#;
        assert_eq!(parse_setup_config(cfg), (true, 1));
    }

    #[test]
    fn setup_config_counts_multiple_profiles() {
        let cfg = r#"{"profiles":{"prod":{},"dev":{}}}"#;
        assert_eq!(parse_setup_config(cfg), (true, 2));
    }
}
