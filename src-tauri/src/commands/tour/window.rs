//! The tour's window (design § 3): kept invisible on the main screen, and captured from inside.

use crate::error::{CmdResult, InstallerError};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSNormalWindowLevel, NSScreen,
    NSWindow, NSWindowCollectionBehavior,
};
use objc2_foundation::{NSDictionary, NSError, NSObjectProtocol, NSPoint};
use objc2_web_kit::WKWebView;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, LogicalSize, Manager, WebviewWindow};

/// Samples per side of the grid `is_blank` reads: 1,024 pixels in all.
const GRID: usize = 32;

/// How long a snapshot may take before its stop fails.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// Whether a 4-bytes-per-pixel bitmap is one colour: the centres of a 32x32 grid of cells all
/// hold the same pixel. A blank capture fails its stop (design § 3).
pub fn is_blank(rgba: &[u8], width: usize, height: usize, stride: usize) -> bool {
    let pixel = |x: usize, y: usize| rgba.get(y * stride + x * 4..y * stride + x * 4 + 4);
    let first = pixel(width / (2 * GRID), height / (2 * GRID));
    (0..GRID).all(|j| {
        let y = (2 * j + 1) * height / (2 * GRID);
        (0..GRID).all(|i| pixel((2 * i + 1) * width / (2 * GRID), y) == first)
    })
}

/// Where a window's origin goes so it sits in the bottom-left corner of a screen's visible frame
/// `(x, y, width, height)`. AppKit's origin is the bottom-left corner, so that is the frame's
/// own origin whatever the window's size; a window larger than the frame overflows up and to the
/// right, never off the screen's left or bottom edge.
pub fn bottom_left(visible_frame: (f64, f64, f64, f64), _size: (f64, f64)) -> (f64, f64) {
    (visible_frame.0, visible_frame.1)
}

/// A capture id names a stop and becomes a file name: `^T\d{2}[a-z0-9-]*$`.
pub fn capture_id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() >= 3
        && b[0] == b'T'
        && b[1..3].iter().all(u8::is_ascii_digit)
        && b[3..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn ns_window(w: &WebviewWindow) -> Option<&NSWindow> {
    // SAFETY: on macOS tauri's `ns_window` is the window's live `NSWindow`, owned by tao for as
    // long as `w` is; the reference doesn't outlive the borrow of `w`.
    w.ns_window()
        .ok()
        .and_then(|ptr| unsafe { ptr.cast::<NSWindow>().as_ref() })
}

/// Moves the window to the bottom-left of the main screen's visible frame (main thread).
fn place(window: &NSWindow, mtm: MainThreadMarker) {
    let Some(screen) = NSScreen::mainScreen(mtm) else {
        return;
    };
    let f = screen.visibleFrame();
    let size = window.frame().size;
    let (x, y) = bottom_left(
        (f.origin.x, f.origin.y, f.size.width, f.size.height),
        (size.width, size.height),
    );
    window.setFrameOrigin(NSPoint::new(x, y));
}

/// Makes the tour's window invisible (design § 3), in this order: alpha 0, click-through, below
/// normal windows, out of Mission Control and the window cycle, bottom-left on the main screen,
/// ordered in behind everything (never key, main or active). WebKit's occlusion detection goes
/// off where the webview has it, so it keeps painting while other windows cover this one.
/// Call on the main thread (setup is).
pub fn hide_window(w: &WebviewWindow) {
    let (Some(mtm), Some(window)) = (MainThreadMarker::new(), ns_window(w)) else {
        log::warn!("tour: the window can't be hidden off the main thread");
        return;
    };
    window.setAlphaValue(0.0);
    window.setIgnoresMouseEvents(true);
    window.setLevel(NSNormalWindowLevel - 1);
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::Transient | NSWindowCollectionBehavior::IgnoresCycle,
    );
    place(window, mtm);
    window.orderBack(None);
    let _ = w.with_webview(|pv| {
        // SAFETY: on macOS `inner()` is the window's `WKWebView`, alive for this callback.
        let Some(webview) = (unsafe { pv.inner().cast::<WKWebView>().as_ref() }) else {
            return;
        };
        let private = sel!(_setWindowOcclusionDetectionEnabled:);
        if webview.respondsToSelector(private) {
            // SAFETY: the webview answers this selector (checked above); it takes one BOOL.
            let _: () = unsafe { msg_send![webview, _setWindowOcclusionDetectionEnabled: false] };
        } else {
            log::warn!("tour: WKWebView has no occlusion switch; captures may go stale");
        }
    });
}

fn main_window(app: &AppHandle) -> CmdResult<WebviewWindow> {
    app.get_webview_window("main")
        .ok_or_else(|| InstallerError::Other("The tour has no main window.".into()))
}

fn require_main_frame(call: &tauri::ipc::Request<'_>) -> CmdResult<()> {
    crate::plugins::caller::require_main_frame(call).map_err(|e| InstallerError::Other(e.message))
}

/// Sets the window's inner size (height 900; widths 1000, 1440 or 1680) and keeps it in the
/// bottom-left corner, out of sight.
#[tauri::command]
pub async fn tour_window(
    app: AppHandle,
    call: tauri::ipc::Request<'_>,
    width: u32,
    height: u32,
) -> CmdResult<Value> {
    require_main_frame(&call)?;
    let w = main_window(&app)?;
    w.set_size(LogicalSize::new(width, height))
        .map_err(|e| InstallerError::Other(e.to_string()))?;
    let placed = w.clone();
    w.run_on_main_thread(move || {
        if let (Some(mtm), Some(window)) = (MainThreadMarker::new(), ns_window(&placed)) {
            place(window, mtm);
        }
    })
    .map_err(|e| InstallerError::Other(e.to_string()))?;
    Ok(json!({ "width": width, "height": height }))
}

/// A snapshot as the main thread hands it back: the PNG and what `is_blank` saw.
struct Shot {
    png: Vec<u8>,
    width: usize,
    height: usize,
    blank: bool,
}

/// Encodes WebKit's snapshot as PNG and judges it blank from its own pixels (main thread).
fn encode(image: &NSImage) -> Result<Shot, String> {
    let tiff = image
        .TIFFRepresentation()
        .ok_or("The snapshot has no bitmap.")?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("The snapshot has no bitmap.")?;
    let (width, height) = (rep.pixelsWide() as usize, rep.pixelsHigh() as usize);
    let stride = rep.bytesPerRow() as usize;
    if rep.isPlanar() || rep.bitsPerPixel() != 32 || width == 0 || height == 0 {
        return Err(format!(
            "The snapshot's bitmap isn't 8-bit RGBA ({} bits per pixel, planar {}).",
            rep.bitsPerPixel(),
            rep.isPlanar()
        ));
    }
    // SAFETY: a meshed 32-bit rep holds `bytesPerRow * pixelsHigh` bytes at `bitmapData`, alive
    // as long as `rep`, which outlives this slice.
    let pixels = unsafe { std::slice::from_raw_parts(rep.bitmapData(), stride * height) };
    let blank = is_blank(pixels, width, height, stride);
    let props = NSDictionary::new();
    // SAFETY: an empty property dictionary is valid for every file type.
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }
        .ok_or("The snapshot can't be encoded as PNG.")?;
    Ok(Shot {
        png: png.to_vec(),
        width,
        height,
        blank,
    })
}

/// Snapshots the window's own web content in-process (`WKWebView takeSnapshot`): no Screen
/// Recording, nothing on the real screen is read. Writes `<test dir>/tour/shots/<id>.png` and
/// answers `{path, width, height, blank, sha256}`.
#[tauri::command]
pub async fn tour_capture(
    app: AppHandle,
    call: tauri::ipc::Request<'_>,
    id: String,
) -> CmdResult<Value> {
    require_main_frame(&call)?;
    if !capture_id_ok(&id) {
        return Err(InstallerError::Other(format!(
            "{id:?} isn't a stop id (T01, T21-unfold)."
        )));
    }
    let run = super::active().ok_or_else(|| InstallerError::Other("No tour is running.".into()))?;
    let w = main_window(&app)?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Shot, String>>();
    let tx = Mutex::new(Some(tx));
    w.with_webview(move |pv| {
        let reply = move |shot: Result<Shot, String>| {
            if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
                let _ = tx.send(shot);
            }
        };
        // SAFETY: on macOS `inner()` is the window's `WKWebView`, alive for this callback.
        let Some(webview) = (unsafe { pv.inner().cast::<WKWebView>().as_ref() }) else {
            return reply(Err("The tour window has no web view.".into()));
        };
        let reply = Mutex::new(Some(reply));
        let done = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let Some(reply) = reply.lock().ok().and_then(|mut r| r.take()) else {
                return;
            };
            // SAFETY: WebKit passes either a live image or a live error for this call.
            let shot = match unsafe { (image.as_ref(), error.as_ref()) } {
                (Some(image), _) => encode(image),
                (None, Some(error)) => Err(error.localizedDescription().to_string()),
                (None, None) => Err("WebKit returned no snapshot.".into()),
            };
            reply(shot);
        });
        // SAFETY: a nil configuration snapshots the visible content at the view's size; the
        // block is copied by WebKit and called once on the main thread.
        unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &done) };
    })
    .map_err(|e| InstallerError::Other(e.to_string()))?;
    let shot = tokio::time::timeout(CAPTURE_TIMEOUT, rx)
        .await
        .map_err(|_| InstallerError::Other("The snapshot took longer than 10 s.".into()))?
        .map_err(|_| InstallerError::Other("The snapshot was dropped.".into()))?
        .map_err(InstallerError::Other)?;
    let dir = run.test_dir.join("tour").join("shots");
    let path = dir.join(format!("{id}.png"));
    tokio::fs::create_dir_all(&dir).await?;
    tokio::fs::write(&path, &shot.png).await?;
    let sha256: String = Sha256::digest(&shot.png)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(json!({
        "path": path,
        "width": shot.width,
        "height": shot.height,
        "blank": shot.blank,
        "sha256": sha256,
    }))
}

/// Whether the tour app is the active app or its window is key; both must stay false (Ruling 3).
fn focus_now(app: &AppHandle, mtm: MainThreadMarker) -> Value {
    let window_key = app
        .get_webview_window("main")
        .and_then(|w| ns_window(&w).map(NSWindow::isKeyWindow))
        .unwrap_or(false);
    json!({
        "appActive": NSApplication::sharedApplication(mtm).isActive(),
        "windowKey": window_key,
    })
}

/// `{appActive, windowKey}`, read from AppKit on the main thread.
#[tauri::command]
pub fn tour_focus(app: AppHandle) -> Value {
    if let Some(mtm) = MainThreadMarker::new() {
        return focus_now(&app, mtm);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    let asked = app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            let _ = tx.send(focus_now(&handle, mtm));
        }
    });
    // Unknown counts as focused, so a check that can't read AppKit fails rather than passes.
    let unknown = json!({ "appActive": true, "windowKey": true });
    asked
        .ok()
        .and_then(|()| rx.recv_timeout(Duration::from_secs(5)).ok())
        .unwrap_or(unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bitmap(width: usize, height: usize) -> Vec<u8> {
        [255u8; 4].repeat(width * height)
    }

    #[test]
    fn a_uniform_bitmap_is_blank() {
        let (w, h) = (1440, 900);
        let mut rgba = bitmap(w, h);
        assert!(is_blank(&rgba, w, h, w * 4));
        // An 8x8 block of another colour around the first sample point (cell 0,0's centre).
        let (cx, cy) = (w / 64, h / 64);
        for y in cy - 4..cy + 4 {
            for x in cx - 4..cx + 4 {
                rgba[y * w * 4 + x * 4..][..4].copy_from_slice(&[26, 26, 26, 255]);
            }
        }
        assert!(!is_blank(&rgba, w, h, w * 4));
        // Rows padded past the pixels are read by stride, not by width.
        let stride = w * 4 + 64;
        let mut padded = vec![255u8; stride * h];
        assert!(is_blank(&padded, w, h, stride));
        padded[cy * stride + cx * 4] = 0;
        assert!(!is_blank(&padded, w, h, stride));
    }

    #[test]
    fn bottom_left_stays_inside_the_visible_frame() {
        assert_eq!(
            bottom_left((0.0, 25.0, 1512.0, 957.0), (1440.0, 900.0)),
            (0.0, 25.0)
        );
        // A window larger than the frame starts at the frame's origin.
        assert_eq!(
            bottom_left((0.0, 25.0, 1512.0, 957.0), (1680.0, 1000.0)),
            (0.0, 25.0)
        );
        // A secondary layout whose frame doesn't start at zero.
        assert_eq!(
            bottom_left((-1920.0, 40.0, 1920.0, 1040.0), (1000.0, 900.0)),
            (-1920.0, 40.0)
        );
    }

    #[test]
    fn capture_ids_are_checked() {
        for ok in ["T05", "T21-unfold", "T01", "T99a-b2"] {
            assert!(capture_id_ok(ok), "{ok}");
        }
        for bad in [
            "../x", "T5", "", "T05/x", "T05-Up", "t05", "T05.png", "T05 x", "T05\n",
        ] {
            assert!(!capture_id_ok(bad), "{bad:?}");
        }
    }
}
