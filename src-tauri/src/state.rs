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
    pub pty: Mutex<Option<PtyHandle>>,
}
