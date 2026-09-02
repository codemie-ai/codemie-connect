// Tauri managed application state.
//
// `remembered` holds tool directories discovered during installs (npm prefix, etc.)
// so `run_fresh_env` can find a just-installed binary without an app restart —
// the Rust analog of the Electron `pathman.augmentProcessPath` mutation.
//
// `pty` holds the active pseudo-terminal so `pty_input` / `pty_resize` can reach
// the currently running interactive command.
use std::sync::Mutex;

use crate::commands::pty::PtyHandle;

#[derive(Default)]
pub struct AppState {
    pub remembered: Mutex<Vec<String>>,
    pub pty: Mutex<Option<(String, PtyHandle)>>,
    /// Absolute path to the bundled node.exe (Windows only).
    /// Populated in the `setup` closure from `resource_dir()`.
    #[cfg(windows)]
    pub node_exe_path: std::path::PathBuf,
    /// Absolute path to the bundled CLI entry-point (Windows only).
    /// Populated in the `setup` closure from `resource_dir()`.
    #[cfg(windows)]
    pub cli_entry_path: std::path::PathBuf,
}
