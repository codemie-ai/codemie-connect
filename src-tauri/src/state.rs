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
    /// The value of the PATH environment variable captured before
    /// `inject_bundled_bin_path` prepends the bundled bin directory.
    /// Written once during setup; read-only thereafter.
    pub pre_injection_path: String,
    /// True when `inject_bundled_bin_path` succeeded during setup.
    /// Used by `check_handshake_state` to determine precedence.
    pub bundled_injected: bool,
    /// True when the user already has a CodeMie CLI on PATH. Unlike
    /// `bundled_injected` it does not depend on PATH injection succeeding, so
    /// the runtime download is skipped whenever their CLI exists.
    pub existing_cli_detected: bool,
    /// Timestamp of the last successful app update check. Guards the 24 h throttle in
    /// `commands::app_updater::check_for_update`.
    pub last_update_check: Mutex<Option<Instant>>,
    /// In-memory command-log record store backing the `cmdlog_*` commands.
    pub cmdlog: Mutex<crate::commands::cmdlog::CmdLogStore>,
}
