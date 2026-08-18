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

const MINIMUM_NODE_MAJOR: u32 = 20;

/// Parse a version string like "v22.14.0" or "22.14.0" into (22, 14, 0).
/// Returns (0, 0, 0) for unrecognised strings (e.g. "lts/*").
fn parse_node_version(s: &str) -> (u32, u32, u32) {
    let s = s.trim_start_matches('v');
    let mut parts = s.split('.').filter_map(|x| x.parse::<u32>().ok());
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    (major, minor, patch)
}

/// Return candidate Node.js binary paths from version managers, ordered by preference:
/// active/default version first, then all installed versions sorted descending.
/// Paths that do not exist on disk are included — callers must check existence.
#[cfg(not(windows))]
fn find_versioned_node_binaries() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;

    let home = match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => PathBuf::from(h),
        _ => return vec![],
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Push a path only if it has not been seen before.
    let mut push = |p: PathBuf| {
        if seen.insert(p.clone()) {
            candidates.push(p);
        }
    };

    // Helper: read_dir a path and return entries sorted by version descending.
    let sorted_entries = |dir: &std::path::Path| -> Vec<PathBuf> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).collect())
            .unwrap_or_default();
        entries.sort_by_key(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            std::cmp::Reverse(parse_node_version(&name))
        });
        entries
    };

    // ── nvm ──────────────────────────────────────────────────────────────────
    // Active version: ~/.nvm/alias/default contains a version string or alias.
    let nvm_alias = home.join(".nvm/alias/default");
    if let Ok(ver) = std::fs::read_to_string(&nvm_alias) {
        let ver = ver.trim();
        // Only proceed if it looks like a version (starts with v or digit), not "lts/*"
        if ver.starts_with('v') || ver.chars().next().map_or(false, |c| c.is_ascii_digit()) {
            push(home.join(format!(".nvm/versions/node/{}/bin/node", ver)));
        }
    }
    // All nvm versions sorted descending
    for dir in sorted_entries(&home.join(".nvm/versions/node")) {
        push(dir.join("bin/node"));
    }

    // ── fnm ──────────────────────────────────────────────────────────────────
    // Active version: ~/.fnm/aliases/default is a symlink whose target's basename is the version.
    let fnm_alias = home.join(".fnm/aliases/default");
    if let Ok(target) = std::fs::read_link(&fnm_alias) {
        let ver = target.file_name().unwrap_or_default().to_string_lossy().to_string();
        push(home.join(format!(".fnm/node-versions/{}/installation/bin/node", ver)));
    }
    // All fnm versions sorted descending
    for dir in sorted_entries(&home.join(".fnm/node-versions")) {
        push(dir.join("installation/bin/node"));
    }

    // ── asdf ─────────────────────────────────────────────────────────────────
    for dir in sorted_entries(&home.join(".asdf/installs/nodejs")) {
        push(dir.join("bin/node"));
    }

    // ── volta ─────────────────────────────────────────────────────────────────
    for dir in sorted_entries(&home.join(".volta/tools/image/node")) {
        push(dir.join("bin/node"));
    }

    candidates
}

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
    let p = probe_from(r.code, &r.stdout);
    if p.found {
        let (major, _, _) = parse_node_version(&p.version);
        if major >= MINIMUM_NODE_MAJOR {
            return p;
        }
        // version < minimum — fall through to version-manager detection
    }
    // PATH probe failed or version too old (GUI apps inherit launchd PATH, not shell PATH).
    // Try version-manager paths directly.
    let binary = node_binary_path();
    if let Some(ref bin) = binary {
        let cmd = format!("\"{}\" --version", bin);
        let r2 = capture(&cmd, None).await;
        return probe_from(r2.code, &r2.stdout);
    }
    p
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

/// Extract the first X.Y.Z semver token from arbitrary CLI output.
/// Handles formats: "0.4.1", "codemie 0.4.1", "v0.4.1",
/// "@codemieai/code/0.4.1 darwin-arm64 …"
fn parse_codemie_version(stdout: &str) -> String {
    for token in stdout.split_whitespace() {
        for part in token.split(|c: char| !c.is_ascii_digit() && c != '.') {
            let p = part.trim_start_matches('v');
            let segs: Vec<&str> = p.split('.').collect();
            if segs.len() >= 3
                && segs
                    .iter()
                    .all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
            {
                return p.to_string();
            }
        }
    }
    String::new()
}

/// Return the installed codemie CLI version string (e.g. "0.4.1"),
/// or an empty string if not found or version cannot be parsed.
#[tauri::command]
pub async fn check_codemie_version() -> String {
    let r = capture("codemie --version", None).await;
    parse_codemie_version(&r.stdout)
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
/// authenticated. On macOS stdin is closed (`< /dev/null`) so the CLI's
/// interactive re-auth prompt cannot hang the capture. On Windows the redirect
/// is omitted (PowerShell does not support it) and the command exits on its own.
#[tauri::command]
pub async fn check_profile_status() -> ProfileStatus {
    #[cfg(not(windows))]
    let status_cmd = "codemie profile status < /dev/null";
    #[cfg(windows)]
    let status_cmd = "codemie profile status";
    let r = capture(status_cmd, None).await;
    let (authenticated, detail) = parse_profile_status(&r.stdout, &r.stderr);
    ProfileStatus {
        authenticated,
        detail,
    }
}

/// Find a binary by checking well-known install locations, then falling back to
/// `where.exe` (Windows) or static paths (macOS) to find it anywhere on PATH.
#[cfg(windows)]
fn find_binary(exe_name: &str, common_locations: &[&str]) -> Option<String> {
    // 1. Check common default install locations.
    if let Some(p) = common_locations.iter().find(|p| Path::new(p).exists()) {
        return Some(p.to_string());
    }
    // 2. Fall back to `where.exe` — finds the binary anywhere in PATH/system.
    std::process::Command::new("where.exe")
        .arg(exe_name)
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
    // 1. Static Homebrew / system paths — validate version against MINIMUM_NODE_MAJOR
    for p in NODE_BINARIES.iter() {
        let path = Path::new(p);
        if !path.exists() {
            continue;
        }
        if let Ok(out) = std::process::Command::new(p).arg("--version").output() {
            if out.status.success() {
                let ver_str = String::from_utf8_lossy(&out.stdout);
                let (major, _, _) = parse_node_version(ver_str.trim());
                if major >= MINIMUM_NODE_MAJOR {
                    return Some(p.to_string());
                }
            }
        }
    }
    // 2. Version-manager paths — validate each with node --version
    for candidate in find_versioned_node_binaries() {
        if !candidate.exists() {
            continue;
        }
        if let Ok(out) = std::process::Command::new(&candidate).arg("--version").output() {
            if out.status.success() {
                let ver_str = String::from_utf8_lossy(&out.stdout);
                let (major, _, _) = parse_node_version(ver_str.trim());
                if major >= MINIMUM_NODE_MAJOR {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
    }
    None
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

    // --- parse_codemie_version ---

    #[test]
    fn parse_codemie_version_plain_semver() {
        assert_eq!(parse_codemie_version("0.4.1\n"), "0.4.1");
    }

    #[test]
    fn parse_codemie_version_with_name_prefix() {
        assert_eq!(parse_codemie_version("codemie 0.4.1\n"), "0.4.1");
    }

    #[test]
    fn parse_codemie_version_strips_v_prefix() {
        assert_eq!(parse_codemie_version("v0.4.1"), "0.4.1");
    }

    #[test]
    fn parse_codemie_version_handles_slash_path_format() {
        // e.g. "@codemieai/code/0.4.1 darwin-arm64 node-v20.0.0"
        assert_eq!(
            parse_codemie_version("@codemieai/code/0.4.1 darwin-arm64 node-v20.0.0"),
            "0.4.1"
        );
    }

    #[test]
    fn parse_codemie_version_returns_empty_on_no_version() {
        assert_eq!(parse_codemie_version(""), "");
    }

    #[test]
    fn parse_codemie_version_returns_empty_on_command_not_found() {
        // Parser robustness: real not-found errors arrive in stderr (not parsed here);
        // this guards against shell wrappers that forward stderr to stdout.
        assert_eq!(
            parse_codemie_version("zsh:1: command not found: codemie"),
            ""
        );
    }

    // --- parse_node_version ---

    #[test]
    fn parse_node_version_strips_v_prefix() {
        assert_eq!(parse_node_version("v22.14.0"), (22, 14, 0));
    }

    #[test]
    fn parse_node_version_without_prefix() {
        assert_eq!(parse_node_version("20.18.1"), (20, 18, 1));
    }

    #[test]
    fn parse_node_version_alias_string_returns_zero() {
        assert_eq!(parse_node_version("lts/*"), (0, 0, 0));
    }

    #[test]
    fn parse_node_version_partial_version() {
        assert_eq!(parse_node_version("v22"), (22, 0, 0));
    }

    #[test]
    fn parse_node_version_sorts_correctly() {
        let mut versions = vec!["v20.18.1", "v22.14.0", "v24.0.0", "v20.9.0"];
        versions.sort_by_key(|s| std::cmp::Reverse(parse_node_version(s)));
        assert_eq!(versions, vec!["v24.0.0", "v22.14.0", "v20.18.1", "v20.9.0"]);
    }

    #[test]
    fn minimum_node_major_is_twenty() {
        assert_eq!(MINIMUM_NODE_MAJOR, 20);
    }
}
