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

/// Pure, testable function. `probe` returns true when a codemie binary is
/// found at a given path; inject a closure in tests, pass a real fs check in production.
pub fn detect_handshake_state(
    path_env: &str,
    bundled_injected: bool,
    probe: &dyn Fn(&std::path::Path) -> bool,
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
        std::process::Command::new("codemie")
            .arg("--version")
            .env("PATH", path_env)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                let text = String::from_utf8_lossy(&o.stdout).to_string();
                // Extract first token that looks like X.Y.Z semver.
                text.split_whitespace()
                    .find(|s| {
                        let parts: Vec<&str> = s.split('.').collect();
                        parts.len() == 3
                            && parts.iter().all(|p| {
                                !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())
                            })
                    })
                    .map(str::to_string)
            })
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
#[tauri::command]
pub async fn check_handshake_state(app: tauri::AppHandle) -> HandshakeState {
    let state = app.state::<AppState>();
    let real_probe = |p: &std::path::Path| p.exists();
    detect_handshake_state(&state.pre_injection_path, state.bundled_injected, &real_probe)
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

    #[test]
    fn no_global_when_path_empty() {
        let s = detect_handshake_state("", false, &never);
        assert!(!s.global_found);
        assert!(!s.bundled_takes_precedence);
    }

    #[test]
    fn global_found_when_probe_matches() {
        let s = detect_handshake_state("/usr/local/bin", false, &always);
        assert!(s.global_found);
    }

    #[test]
    fn bundled_takes_precedence_when_injected_and_global_found() {
        let s = detect_handshake_state("/usr/local/bin", true, &always);
        assert!(s.bundled_takes_precedence);
    }
}
