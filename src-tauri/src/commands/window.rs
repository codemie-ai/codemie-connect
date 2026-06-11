// Window control. Replaces Electron's win.setContentSize / app.quit IPC.
use tauri::{AppHandle, LogicalSize, WebviewWindow};

const WIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 600.0;
const MAX_HEIGHT: f64 = 1000.0;

/// Resize the window height (log-panel expand/collapse). Uses LogicalSize so it
/// behaves identically on Retina displays (PhysicalSize would double on 2x).
#[tauri::command]
pub fn set_window_height(window: WebviewWindow, height: f64) {
    let h = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let _ = window.set_size(LogicalSize::new(WIN_WIDTH, h));
}

#[tauri::command]
pub fn close_app(app: AppHandle) {
    app.exit(0);
}
