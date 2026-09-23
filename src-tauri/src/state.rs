// Tauri managed application state.
//
// `remembered` holds tool directories discovered during installs (npm prefix, etc.)
// so `run_fresh_env` can find a just-installed binary without an app restart —
// the Rust analog of the Electron `pathman.augmentProcessPath` mutation.
//
// `pty` holds the active pseudo-terminal so `pty_input` / `pty_resize` can reach
// the currently running interactive command.
use std::sync::Mutex;
use std::time::Instant;

use crate::commands::pty::PtyHandle;

#[derive(Default)]
pub struct AppState {
    pub remembered: Mutex<Vec<String>>,
    pub pty: Mutex<Option<(String, PtyHandle)>>,
    /// Absolute path to the bundled node binary: `node/node.exe` on Windows,
    /// `node/bin/node` on macOS. Populated in the `setup` closure from `resource_dir()`.
    pub node_exe_path: std::path::PathBuf,
    /// Absolute path to the bundled CLI entry-point (`bin/codemie.js`).
    /// Populated in the `setup` closure from `resource_dir()`.
    pub cli_entry_path: std::path::PathBuf,
    /// The value of the PATH environment variable captured before
    /// `inject_bundled_bin_path` prepends the bundled bin directory.
    /// Written once during setup; read-only thereafter.
    pub pre_injection_path: String,
    /// True when `inject_bundled_bin_path` succeeded during setup.
    /// Used by `check_handshake_state` to determine precedence.
    pub bundled_injected: bool,
    /// True when an existing CodeMie CLI was found on PATH before the bundled
    /// bin dir would have been injected. When true, `inject_bundled_bin_path`
    /// is skipped and `node_exe_path`/`cli_entry_path` are left empty, and
    /// `run_self_update` updates that CLI; the bundled one updates with the
    /// app (EPMCDME-14581).
    pub existing_cli_detected: bool,
    /// Timestamp of the last successful app update check. Guards the 24 h throttle in
    /// `commands::app_updater::check_for_update`.
    pub last_update_check: Mutex<Option<Instant>>,
    /// In-memory command-log record store backing the `cmdlog_*` commands.
    pub cmdlog: Mutex<crate::commands::cmdlog::CmdLogStore>,
}
