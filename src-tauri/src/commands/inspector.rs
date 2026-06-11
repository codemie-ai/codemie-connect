// System inspection: probe git / node / npm / codemie. Port of src/main/inspector.js.
use std::path::Path;

use serde::Serialize;

use crate::commands::runner::capture;

const GIT_BINARIES: &[&str] = &[
    "/usr/bin/git",
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
];
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

/// CodeMie profile auth status, parsed from `codemie profile status`.
#[derive(Serialize, Default, Clone)]
pub struct ProfileStatus {
    pub authenticated: bool,
    pub detail: String,
}

/// Pure parser for `codemie profile status` output. The CLI prints an "Auth Status"
/// row in one of three states: "✓ Authenticated (expires in 23h 50m)", "✗ Expired",
/// or "✗ Not authenticated". Returns (authenticated, detail-line). This reads the
/// real command output rather than a hardcoded value.
fn parse_profile_status(stdout: &str, stderr: &str) -> (bool, String) {
    let combined = format!("{stdout}\n{stderr}");
    let detail = combined
        .lines()
        .map(str::trim)
        .find(|l| {
            let low = l.to_lowercase();
            low.contains("auth status") || low.contains("authenticated") || low.contains("expired")
        })
        .unwrap_or("")
        .to_string();
    let low = combined.to_lowercase();
    // Authenticated only when the positive marker is present and neither negative
    // state is. "expires in …" does not contain "expired", so it is not matched.
    let authenticated = low.contains("authenticated")
        && !low.contains("not authenticated")
        && !low.contains("expired");
    (authenticated, detail)
}

/// Runs `codemie profile status` and reports whether the active profile is
/// authenticated. stdin is closed (`< /dev/null`) so the CLI's interactive
/// re-auth prompt (shown when credentials are expired) cannot hang the capture;
/// the status row is printed before any prompt, so the parse still works.
#[tauri::command]
pub async fn check_profile_status() -> ProfileStatus {
    let r = capture("codemie profile status < /dev/null", None).await;
    let (authenticated, detail) = parse_profile_status(&r.stdout, &r.stderr);
    ProfileStatus {
        authenticated,
        detail,
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

    // --- check_profile_status: pure `codemie profile status` parsing (home-launcher) ---

    #[test]
    fn profile_status_authenticated_is_true_and_keeps_detail() {
        let out = "Auth Status  │ ✓ Authenticated (expires in 23h 50m)";
        let (ok, detail) = parse_profile_status(out, "");
        assert!(ok);
        assert!(detail.contains("Authenticated"));
    }

    #[test]
    fn profile_status_expired_is_not_authenticated() {
        assert!(!parse_profile_status("Auth Status  │ ✗ Expired", "").0);
    }

    #[test]
    fn profile_status_not_authenticated_is_false() {
        assert!(!parse_profile_status("Auth Status  │ ✗ Not authenticated", "").0);
    }

    #[test]
    fn profile_status_expires_in_future_not_mistaken_for_expired() {
        // "expires in …" must NOT be read as the expired state.
        assert!(parse_profile_status("✓ Authenticated (expires in 1h 2m)", "").0);
    }

    #[test]
    fn profile_status_empty_output_is_false() {
        assert_eq!(parse_profile_status("", ""), (false, String::new()));
    }
}
