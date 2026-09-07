// Handshake precedence detection — determines whether a global npm CodeMie
// installation is present and whether the bundled runtime takes PATH precedence.
use std::ffi::OsStr;

use serde::Serialize;
use tauri::Manager;

use crate::state::AppState;

#[derive(Serialize)]
pub struct HandshakeState {
    pub global_found: bool,
    pub global_version: Option<String>,
    pub bundled_takes_precedence: bool,
}

/// Extract the first X.Y.Z semver token from `output`, stripping a leading `v`
/// so both "1.2.3" and "v1.2.3" (common npm CLI format) are accepted.
pub fn parse_global_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|s| {
        let candidate = s.strip_prefix('v').unwrap_or(s);
        let parts: Vec<&str> = candidate.split('.').collect();
        if parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        {
            Some(candidate.to_string())
        } else {
            None
        }
    })
}

/// Pure, testable function. `probe` returns true when a codemie binary is
/// found at a given path; `version_cmd` returns the version string for a given
/// PATH env string. Inject closures in tests, pass real implementations in production.
pub fn detect_handshake_state(
    path_env: &str,
    bundled_injected: bool,
    probe: &dyn Fn(&std::path::Path) -> bool,
    version_cmd: &dyn Fn(&str) -> Option<String>,
) -> HandshakeState {
    // On Windows npm global packages install a .cmd shim; fall back to .exe.
    // On macOS/Linux the binary has no extension.
    let bin_names: &[&str] = if cfg!(windows) {
        &["codemie.cmd", "codemie.exe"]
    } else {
        &["codemie"]
    };

    let mut global_found = false;
    'outer: for dir in std::env::split_paths(OsStr::new(path_env)) {
        for &name in bin_names {
            if probe(&dir.join(name)) {
                global_found = true;
                break 'outer;
            }
        }
    }

    let global_version = if global_found {
        version_cmd(path_env)
    } else {
        None
    };

    HandshakeState {
        global_found,
        global_version,
        bundled_takes_precedence: bundled_injected && global_found,
    }
}

/// IPC command: returns handshake state using AppState's pre-injection PATH.
/// The detection involves a blocking `std::process::Command` (codemie --version),
/// so we offload it to a dedicated thread via `spawn_blocking` to avoid blocking
/// the tokio worker thread.
#[tauri::command]
pub async fn check_handshake_state(app: tauri::AppHandle) -> HandshakeState {
    let state = app.state::<AppState>();
    let path_env = state.pre_injection_path.clone();
    let bundled_injected = state.bundled_injected;
    tokio::task::spawn_blocking(move || {
        let real_probe = |p: &std::path::Path| p.exists();
        let real_version_cmd = |path: &str| -> Option<String> {
            std::process::Command::new("codemie")
                .arg("--version")
                .env("PATH", path)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| parse_global_version(&String::from_utf8_lossy(&o.stdout)))
        };
        detect_handshake_state(&path_env, bundled_injected, &real_probe, &real_version_cmd)
    })
    .await
    .unwrap_or(HandshakeState {
        global_found: false,
        global_version: None,
        bundled_takes_precedence: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never(_: &std::path::Path) -> bool {
        false
    }
    fn always(_: &std::path::Path) -> bool {
        true
    }
    fn no_version(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn no_global_when_path_empty() {
        let s = detect_handshake_state("", false, &never, &no_version);
        assert!(!s.global_found);
        assert!(!s.bundled_takes_precedence);
    }

    #[test]
    fn global_found_when_probe_matches() {
        let s = detect_handshake_state("/usr/local/bin", false, &always, &no_version);
        assert!(s.global_found);
    }

    #[test]
    fn bundled_takes_precedence_when_injected_and_global_found() {
        let s = detect_handshake_state("/usr/local/bin", true, &always, &no_version);
        assert!(s.bundled_takes_precedence);
    }

    #[test]
    fn global_version_populated_via_injectable_version_cmd() {
        let mock_version = |_: &str| Some("2.0.1".to_string());
        let s = detect_handshake_state("/usr/local/bin", false, &always, &mock_version);
        assert!(s.global_found);
        assert_eq!(s.global_version, Some("2.0.1".to_string()));
    }

    #[test]
    fn parse_global_version_accepts_bare_semver() {
        assert_eq!(
            parse_global_version("codemie 1.2.3"),
            Some("1.2.3".to_string())
        );
    }

    #[test]
    fn parse_global_version_strips_v_prefix() {
        // npm CLI binaries commonly output "v1.2.3"; the leading 'v' must be stripped.
        assert_eq!(parse_global_version("v1.2.3"), Some("1.2.3".to_string()));
        // Multi-word output: "codemie v2.0.1" — picks the space-separated v-prefixed token.
        assert_eq!(
            parse_global_version("codemie v2.0.1"),
            Some("2.0.1".to_string())
        );
    }

    #[test]
    fn parse_global_version_returns_none_for_non_semver() {
        assert_eq!(parse_global_version("codemie"), None);
        assert_eq!(parse_global_version(""), None);
        assert_eq!(parse_global_version("vX.Y.Z"), None);
    }
}
