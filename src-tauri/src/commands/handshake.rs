// Handshake precedence detection — determines whether a global npm CodeMie
// installation is present and whether the bundled runtime takes PATH precedence.
use std::ffi::OsStr;

use serde::Serialize;
use tauri::Manager;

use crate::state::AppState;

/// Run `codemie --version` at the exact `path` and return the parsed version.
/// On Windows `.cmd` files must be invoked via `cmd /C`; direct exec silently fails.
fn version_at(path: &std::path::Path) -> Option<String> {
    #[cfg(windows)]
    let output = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .arg("/C")
            .arg(path)
            .arg("--version")
            .output()
            .ok()?
    };
    #[cfg(not(windows))]
    let output = std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| parse_global_version(&String::from_utf8_lossy(&output.stdout)))?
}

/// Find the first codemie binary on `path_env` whose `--version` succeeds.
/// Returns the version string, or `None` if no working CLI is found.
/// A file that exists but exits non-zero (e.g. the old broken PowerShell shim)
/// is not returned.
pub fn find_working_global_codemie(path_env: &str) -> Option<String> {
    let bin_names: &[&str] = if cfg!(windows) {
        &["codemie.cmd", "codemie.exe"]
    } else {
        &["codemie"]
    };
    std::env::split_paths(OsStr::new(path_env)).find_map(|dir| {
        bin_names.iter().find_map(|&name| {
            let p = dir.join(name);
            if p.exists() {
                version_at(&p)
            } else {
                None
            }
        })
    })
}

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

/// Drops `own` from `path_env`: the app's own shim dir and the agents dir hold
/// a `codemie` the app put there (the first launch writes both into the login
/// PATH, and a CLI that updates itself from inside the app lands in the agents
/// dir), so finding one there must not count as the user's own CLI.
pub fn without_dirs(path_env: &str, own: &[std::path::PathBuf]) -> String {
    let key = |p: &std::path::Path| {
        let s = p.to_string_lossy();
        let s = s.trim_end_matches(['/', '\\']);
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s.to_string()
        }
    };
    let own: Vec<String> = own
        .iter()
        .map(|p| key(p))
        .filter(|k| !k.is_empty())
        .collect();
    let kept: Vec<std::path::PathBuf> = std::env::split_paths(OsStr::new(path_env))
        .filter(|dir| !own.contains(&key(dir)))
        .collect();
    std::env::join_paths(kept)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path_env.to_string())
}

/// Returns true when a `codemie` binary exists in any directory of `path_env`.
/// Windows checks both the npm `.cmd` shim and a plain `.exe`; other platforms
/// check the extension-less binary name.
pub fn probe_global_codemie(path_env: &str, probe: &dyn Fn(&std::path::Path) -> bool) -> bool {
    let bin_names: &[&str] = if cfg!(windows) {
        &["codemie.cmd", "codemie.exe"]
    } else {
        &["codemie"]
    };
    std::env::split_paths(OsStr::new(path_env))
        .any(|dir| bin_names.iter().any(|&name| probe(&dir.join(name))))
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
    // probe guards the cheaper version_cmd call; a file that exists but whose
    // --version fails (broken shim) leaves global_found false.
    let file_found = probe_global_codemie(path_env, probe);
    let global_version = if file_found {
        version_cmd(path_env)
    } else {
        None
    };
    let global_found = global_version.is_some();

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
        let real_version_cmd = |path: &str| -> Option<String> { find_working_global_codemie(path) };
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
    fn without_dirs_drops_the_apps_own_dirs_only() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path = [
            "/app/Resources/bin/",
            "/home/u/.codemie/agents/bin",
            "/opt/homebrew/bin",
        ]
        .join(sep);
        let own = [
            std::path::PathBuf::from("/app/Resources/bin"),
            std::path::PathBuf::from("/home/u/.codemie/agents/bin"),
        ];
        assert_eq!(without_dirs(&path, &own), "/opt/homebrew/bin");
    }

    #[test]
    fn own_shim_on_path_is_not_the_users_cli() {
        let shim = std::path::Path::new("/app/Resources/bin/codemie");
        let only_ours = |p: &std::path::Path| p == shim;
        let path = without_dirs(
            "/app/Resources/bin",
            &[std::path::PathBuf::from("/app/Resources/bin")],
        );
        assert!(!probe_global_codemie(&path, &only_ours));
    }

    #[test]
    fn no_global_when_path_empty() {
        let s = detect_handshake_state("", false, &never, &no_version);
        assert!(!s.global_found);
        assert!(!s.bundled_takes_precedence);
    }

    #[test]
    fn global_found_when_probe_matches_and_version_succeeds() {
        let mock_version = |_: &str| Some("1.0.0".to_string());
        let s = detect_handshake_state("/usr/local/bin", false, &always, &mock_version);
        assert!(s.global_found);
    }

    #[test]
    fn global_not_found_when_file_exists_but_version_fails() {
        // The broken shim case: codemie.cmd exists but --version exits non-zero.
        let s = detect_handshake_state("/usr/local/bin", false, &always, &no_version);
        assert!(
            !s.global_found,
            "broken shim must not count as a working global install"
        );
    }

    #[test]
    fn probe_global_codemie_false_on_empty_path() {
        assert!(!probe_global_codemie("", &never));
    }

    #[test]
    fn probe_global_codemie_true_when_probe_matches() {
        assert!(probe_global_codemie("/usr/local/bin", &always));
    }

    #[test]
    fn bundled_takes_precedence_when_injected_and_global_found() {
        let mock_version = |_: &str| Some("1.0.0".to_string());
        let s = detect_handshake_state("/usr/local/bin", true, &always, &mock_version);
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

#[cfg(test)]
#[cfg(not(windows))]
mod tests_find_working_global {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    #[test]
    fn broken_binary_returns_none() {
        let dir = TempDir::new().unwrap();
        let bin = dir.path().join("codemie");
        fs::write(&bin, b"#!/bin/sh\nexit 1").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let path_env = dir.path().to_str().unwrap().to_string();
        assert!(
            find_working_global_codemie(&path_env).is_none(),
            "a binary that exits 1 must not count as a working global CLI"
        );
    }

    #[test]
    fn working_binary_returns_version() {
        let dir = TempDir::new().unwrap();
        let bin = dir.path().join("codemie");
        fs::write(&bin, b"#!/bin/sh\necho 'codemie 1.2.3'").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let path_env = dir.path().to_str().unwrap().to_string();
        assert_eq!(
            find_working_global_codemie(&path_env),
            Some("1.2.3".to_string()),
            "a binary that exits 0 and prints a semver must be returned"
        );
    }
}
