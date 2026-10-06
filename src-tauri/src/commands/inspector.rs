// System inspection: probe git / node / npm / codemie. Port of src/main/inspector.js.
use std::path::Path;

use serde::Serialize;

use crate::commands::runner::capture;

#[cfg(not(windows))]
const GIT_BINARIES: &[&str] = &[
    "/usr/bin/git",
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
];
#[cfg(not(windows))]
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
#[derive(Serialize, Clone)]
pub struct ProfileStatus {
    pub state: String,
    pub detail: String,
}

impl Default for ProfileStatus {
    fn default() -> Self {
        ProfileStatus {
            state: "unknown".into(),
            detail: String::new(),
        }
    }
}

/// Pure parser for `codemie profile status` output.
/// Returns a `ProfileStatus` with `state` set to one of:
/// `"signed_in"` | `"not_signed_in"` | `"unknown"` | `"no_profile"`.
fn parse_profile_status(stdout: &str, stderr: &str) -> ProfileStatus {
    // CR-001: always merge both streams so stderr auth errors are never discarded.
    let combined = format!("{stdout}\n{stderr}");
    if combined.contains("No active profile found") {
        return ProfileStatus {
            state: "no_profile".into(),
            detail: combined.trim().to_string(),
        };
    }
    if combined.contains("Authentication required to use this profile") {
        let detail = combined
            .lines()
            .find(|l| l.trim_start().starts_with('✗'))
            .unwrap_or("")
            .to_string();
        return ProfileStatus {
            state: "not_signed_in".into(),
            detail,
        };
    }
    // CR-003: standalone "✗ Token expired" without an "Authentication required" line.
    if let Some(exp_line) = combined
        .lines()
        .find(|l| l.trim_start().starts_with('✗') && l.to_lowercase().contains("expired"))
    {
        return ProfileStatus {
            state: "not_signed_in".into(),
            detail: exp_line.to_string(),
        };
    }
    // U+2502 (│) separators — look for the Auth Status row. Trimmed and matched
    // case-insensitively, same as the pre-14515 parser.
    if let Some(auth_line) = combined
        .lines()
        .map(str::trim)
        .find(|l| l.to_lowercase().contains("auth status"))
    {
        let lower = auth_line.to_lowercase();
        if lower.contains("expired") {
            return ProfileStatus {
                state: "not_signed_in".into(),
                detail: auth_line.to_string(),
            };
        }
        // CR-002: explicit "not authenticated" check must come before the positive one.
        if lower.contains("not authenticated") {
            return ProfileStatus {
                state: "not_signed_in".into(),
                detail: auth_line.to_string(),
            };
        }
        if lower.contains("authenticated") {
            return ProfileStatus {
                state: "signed_in".into(),
                detail: auth_line.to_string(),
            };
        }
    }
    ProfileStatus {
        state: "unknown".into(),
        detail: String::new(),
    }
}

/// Runs `codemie profile status` and reports whether the active profile is
/// authenticated. On macOS stdin is closed (`< /dev/null`) so the CLI's
/// interactive re-auth prompt cannot hang the capture. On Windows the redirect
/// is omitted (PowerShell does not support it) and the command exits on its own.
#[tauri::command]
pub async fn check_profile_status() -> ProfileStatusRun {
    #[cfg(not(windows))]
    let status_cmd = "codemie profile status < /dev/null";
    #[cfg(windows)]
    let status_cmd = "codemie profile status";
    let r = capture(status_cmd, None).await;
    ProfileStatusRun {
        status: parse_profile_status(&r.stdout, &r.stderr),
        code: r.code,
    }
}

/// The parsed status plus the command's exit code, which the "what CodeMie
/// ran" footer shows next to the command.
#[derive(Serialize, Clone)]
pub struct ProfileStatusRun {
    #[serde(flatten)]
    pub status: ProfileStatus,
    pub code: i32,
}

/// Find a binary by checking well-known install locations, then falling back to
/// `where.exe` (Windows) or static paths (macOS) to find it anywhere on PATH.
#[cfg(windows)]
fn find_binary(exe_name: &str, common_locations: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;

    // 1. Check common default install locations.
    if let Some(p) = common_locations.iter().find(|p| Path::new(p).exists()) {
        return Some(p.to_string());
    }
    // 2. Fall back to `where.exe` — finds the binary anywhere in PATH/system.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("where.exe")
        .arg(exe_name)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| {
            String::from_utf8(out.stdout)
                .ok()
                .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
                .filter(|s| !s.is_empty())
        })
}

#[tauri::command]
#[cfg(not(windows))]
pub fn git_binary_path() -> Option<String> {
    GIT_BINARIES
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|s| s.to_string())
}

#[tauri::command]
#[cfg(windows)]
pub fn git_binary_path() -> Option<String> {
    find_binary("git.exe", &[r"C:\Program Files\Git\cmd\git.exe"])
}

#[tauri::command]
#[cfg(not(windows))]
pub fn node_binary_path() -> Option<String> {
    NODE_BINARIES
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|s| s.to_string())
}

#[tauri::command]
#[cfg(windows)]
pub fn node_binary_path() -> Option<String> {
    find_binary("node.exe", &[r"C:\Program Files\nodejs\node.exe"])
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

    // Row 1 — signed_in
    #[test]
    fn profile_status_authenticated() {
        let stdout =
            "│ Auth Status │ ✓ Authenticated (expires in 2h) │\n│ Provider │ ai-run-sso │\n";
        let r = parse_profile_status(stdout, "");
        assert_eq!(r.state, "signed_in");
        assert!(r.detail.contains("Authenticated"));
    }

    // Row 2 — not_signed_in, expired
    // NOTE: No real-CLI-output fixture exists for this row (the available SSO session is
    // fresh and cannot be aged; credentials are encrypted at rest). This test asserts
    // against the documented string pattern only. Documented in MR description.
    #[test]
    fn profile_status_expired_no_real_fixture_pattern_only() {
        let stdout = "│ Auth Status │ Expired │\n│ Provider │ ai-run-sso │\n";
        let r = parse_profile_status(stdout, "");
        assert_eq!(r.state, "not_signed_in");
        assert!(r.detail.to_lowercase().contains("expired"));
    }

    // Row 3 — unknown: profile rows present, no Auth Status row; detail must be ""
    #[test]
    fn profile_status_no_auth_status_row_is_unknown_not_not_signed_in() {
        let stdout =
            "│ Provider │ anthropic-subscription │\n│ Profile  │ MertPersonal           │\n";
        let r = parse_profile_status(stdout, "");
        assert_eq!(r.state, "unknown");
        assert_eq!(r.detail, "");
    }

    // Row 4 — not_signed_in: "✗ …" reason line + warning (verified fixture)
    #[test]
    fn profile_status_sso_credentials_missing_is_not_signed_in() {
        let stdout = "✗ No SSO credentials found for https://codemie.lab.epam.com. Please run: codemie profile login --url https://codemie.lab.epam.com\n⚠️  Authentication required to use this profile\n";
        let r = parse_profile_status(stdout, "");
        assert_eq!(r.state, "not_signed_in");
        assert!(r.detail.starts_with("✗ No SSO credentials found"));
    }

    // Row 5 — no_profile (verified fixture)
    #[test]
    fn profile_status_no_active_profile() {
        let stdout = "No active profile found. Run \"codemie setup\" to create one.\n";
        let r = parse_profile_status(stdout, "");
        assert_eq!(r.state, "no_profile");
        assert!(r.detail.contains("No active profile found"));
    }

    // Empty output fallback
    #[test]
    fn profile_status_empty_output_is_unknown() {
        let r = parse_profile_status("", "");
        assert_eq!(r.state, "unknown");
        assert_eq!(r.detail, "");
    }

    // "expires in" must not be mistaken for "expired"
    #[test]
    fn profile_status_expires_in_future_not_mistaken_for_expired() {
        let stdout = "│ Auth Status │ ✓ Authenticated (expires in 3d) │\n";
        let r = parse_profile_status(stdout, "");
        assert_eq!(r.state, "signed_in");
    }

    // CR-001 regression: non-empty stdout must not shadow stderr auth errors
    #[test]
    fn profile_status_stderr_merged_when_stdout_nonempty() {
        let stdout = "some unrelated line\n";
        let stderr = "No active profile found. Run \"codemie setup\" to create one.\n";
        let r = parse_profile_status(stdout, stderr);
        assert_eq!(r.state, "no_profile");
    }

    // CR-002 regression: "Not authenticated" Auth Status row must return not_signed_in
    #[test]
    fn profile_status_not_authenticated_is_not_signed_in() {
        let stdout = "│ Auth Status │ Not authenticated │\n│ Provider │ some-provider │\n";
        let r = parse_profile_status(stdout, "");
        assert_eq!(r.state, "not_signed_in");
    }

    // CR-003: standalone "✗ Token expired" line (no table row, no "Authentication required")
    #[test]
    fn profile_status_standalone_token_expired_is_not_signed_in() {
        let stdout = "✗ Token expired\n";
        let r = parse_profile_status(stdout, "");
        assert_eq!(r.state, "not_signed_in");
    }
}
