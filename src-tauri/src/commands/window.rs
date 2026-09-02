// Window control. Replaces Electron's win.setContentSize / app.quit IPC.
use tauri::{AppHandle, LogicalSize, WebviewWindow};

// Must match tauri.conf.json's window width: set_window_height rewrites both
// dimensions, so a stale value here snaps the window narrow on the first
// log-panel toggle. The shell's 180px sidebar is why this is not 900.
const WIN_WIDTH: f64 = 1000.0;
const MIN_HEIGHT: f64 = 660.0;
// Must stay above ui/log.js's EXPANDED_H, or opening the log panel silently
// clamps the window short instead of growing it.
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

#[cfg(test)]
mod tests {
    use super::*;

    // ui/log.js: COLLAPSED_H = 660, EXPANDED_H = 660 + 220 + 36 + 18.
    const LOG_COLLAPSED_H: f64 = 660.0;
    const LOG_EXPANDED_H: f64 = 660.0 + 220.0 + 36.0 + 18.0;

    // Both heights the log panel asks for must survive the clamp untouched,
    // or the window snaps to the wrong size instead of resizing.
    #[test]
    fn log_panel_heights_are_not_clamped() {
        assert_eq!(
            LOG_COLLAPSED_H.clamp(MIN_HEIGHT, MAX_HEIGHT),
            LOG_COLLAPSED_H
        );
        assert_eq!(LOG_EXPANDED_H.clamp(MIN_HEIGHT, MAX_HEIGHT), LOG_EXPANDED_H);
    }
}
