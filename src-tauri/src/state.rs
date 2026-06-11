// Tauri managed application state.
//
// `remembered` holds tool directories discovered during installs (npm prefix, etc.)
// so `run_fresh_env` can find a just-installed binary without an app restart —
// the Rust analog of the Electron `pathman.augmentProcessPath` mutation.
//
// The active pseudo-terminal handle is added to this struct in Phase 3 (PTY).
use std::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    pub remembered: Mutex<Vec<String>>,
}
