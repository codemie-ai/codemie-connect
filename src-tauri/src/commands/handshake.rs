// Handshake precedence detection — determines whether a global npm CodeMie
// installation is present and whether the bundled runtime takes PATH precedence.
use std::ffi::OsStr;

use serde::Serialize;
use tauri::Manager;

use crate::state::AppState;

/// True when a working user-owned CodeMie CLI exists on `path_env`.
///
/// No subprocess is spawned — the CLI's own update check fires on `--version`
/// and either runs `npm update` (slow, mutates the user's install) or blocks on
/// an interactive prompt, so we must not call it at startup.
///
/// On Windows: a `codemie.cmd` in `%LOCALAPPDATA%\CodeMie\bin` is trusted only
/// when `%LOCALAPPDATA%\CodeMie\npm-prefix\codemie.cmd` also exists; that pair
/// means the user ran `npm install -g @codemieai/code` which wrote both files.
/// Without the npm-prefix companion the bin-dir entry is our own app shim left
/// over from an earlier launch — treat it as absent and keep the bundled bin
/// ahead of it (EPMCDME-15395).
///
/// On macOS: file existence is sufficient.
pub fn find_working_global_codemie(path_env: &str) -> Option<String> {
    if probe_global_codemie(path_env, &cli_exists) {
        Some(String::new()) // version unknown — we never run the CLI
    } else {
        None
    }
}

/// Filesystem-only probe used by [`find_working_global_codemie`].
/// On Windows it enforces the npm-prefix corroboration rule.
fn cli_exists(path: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        let localappdata = std::env::var("LOCALAPPDATA").ok();
        cli_exists_in(path, localappdata.as_deref().map(std::path::Path::new))
    }
    #[cfg(not(windows))]
    path.exists()
}

/// Pure inner function for [`cli_exists`] on Windows; injecting `localappdata`
/// makes it testable without mutating the process environment.
#[cfg(windows)]
pub(crate) fn cli_exists_in(
    path: &std::path::Path,
    localappdata: Option<&std::path::Path>,
) -> bool {
    if !path.exists() {
        return false;
    }
    let Some(dir) = path.parent() else {
        return true;
    };
    let Some(base) = localappdata else {
        return true; // no LOCALAPPDATA → can't apply the rule, trust it
    };
    let codemie_bin = base.join("CodeMie").join("bin");
    let norm = |p: &std::path::Path| {
        p.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    if norm(dir) == norm(&codemie_bin) {
        base.join("CodeMie")
            .join("npm-prefix")
            .join("codemie.cmd")
            .exists()
    } else {
        true
    }
}

#[derive(Serialize)]
pub struct HandshakeState {
    pub global_found: bool,
    pub global_version: Option<String>,
    pub bundled_takes_precedence: bool,
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
        let real_probe = |p: &std::path::Path| cli_exists(p);
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

}

#[cfg(all(test, windows))]
mod tests_cli_exists_in {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_shim(dir: &std::path::Path) -> std::path::PathBuf {
        let p = dir.join("codemie.cmd");
        fs::write(&p, b"@echo off\r\n").unwrap();
        p
    }

    #[test]
    fn missing_file_is_false() {
        let t = TempDir::new().unwrap();
        assert!(!cli_exists_in(&t.path().join("codemie.cmd"), None));
    }

    #[test]
    fn shim_outside_codemie_bin_is_trusted_unconditionally() {
        let t = TempDir::new().unwrap();
        let shim = make_shim(t.path());
        // Any dir other than %LOCALAPPDATA%\CodeMie\bin is trusted without the
        // npm-prefix check — it's the user's own global install.
        let localappdata = TempDir::new().unwrap();
        assert!(cli_exists_in(&shim, Some(localappdata.path())));
    }

    #[test]
    fn codemie_bin_shim_without_npm_prefix_is_rejected() {
        let t = TempDir::new().unwrap();
        // Create %LOCALAPPDATA%\CodeMie\bin\codemie.cmd
        let bin_dir = t.path().join("CodeMie").join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let shim = make_shim(&bin_dir);
        // No npm-prefix\codemie.cmd → our own stale shim, not the user's CLI.
        assert!(!cli_exists_in(&shim, Some(t.path())));
    }

    #[test]
    fn codemie_bin_shim_with_npm_prefix_is_trusted() {
        let t = TempDir::new().unwrap();
        let bin_dir = t.path().join("CodeMie").join("bin");
        let npm_dir = t.path().join("CodeMie").join("npm-prefix");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::create_dir_all(&npm_dir).unwrap();
        let shim = make_shim(&bin_dir);
        // Write the npm-prefix companion → user ran npm install -g.
        fs::write(npm_dir.join("codemie.cmd"), b"@echo off\r\n").unwrap();
        assert!(cli_exists_in(&shim, Some(t.path())));
    }
}
