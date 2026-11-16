use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{LogicalPosition, LogicalSize, Manager};
#[derive(Serialize, Deserialize)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
pub fn restore(app: &tauri::AppHandle, root: &Path) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let bounds = std::fs::read(root.join("window.json"))
        .ok()
        .and_then(|v| serde_json::from_slice::<Bounds>(&v).ok());
    let Ok(Some(monitor)) = w.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width_max = f64::from(area.size.width) / scale;
    let height_max = f64::from(area.size.height) / scale;
    let x_min = f64::from(area.position.x) / scale;
    let y_min = f64::from(area.position.y) / scale;
    let b = bounds
        .filter(|b| [b.x, b.y, b.width, b.height].iter().all(|n| n.is_finite()))
        .unwrap_or(Bounds {
            x: x_min + 24.0,
            y: y_min + 24.0,
            width: 1360.0,
            height: 900.0,
        });
    let width = b.width.max(1000.0).min(width_max);
    let height = b.height.max(700.0).min(height_max);
    let _ = w.set_size(LogicalSize::new(width, height));
    let _ = w.set_position(LogicalPosition::new(
        b.x.clamp(x_min, x_min + (width_max - width).max(0.0)),
        b.y.clamp(y_min, y_min + (height_max - height).max(0.0)),
    ));
}
pub fn save(w: &tauri::Window, root: &Path) {
    if w.is_minimized().unwrap_or(true) || w.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.inner_size(), w.scale_factor())
    else {
        return;
    };
    let bounds = Bounds {
        x: f64::from(pos.x) / scale,
        y: f64::from(pos.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
    };
    if let Ok(bytes) = serde_json::to_vec(&bounds) {
        let tmp = root.join("window.pending");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(tmp, root.join("window.json"));
        }
    }
}
