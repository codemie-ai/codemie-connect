//! The main window shows only Connect's own pages. Anything else (a link Claude wrote, a drag of
//! a link, "Open Link" in a context menu) must never replace the app in its window; external
//! links open in the browser through the workspace's `open_source` path instead.
use tauri::{plugin::TauriPlugin, Runtime, Url};

/// Whether a navigation stays inside the app: its bundled pages (`tauri://localhost` on macOS,
/// `http(s)://tauri.localhost` on Windows) and `about:blank`. Plugin UIs (Task 17) add their
/// own scheme here.
pub fn allowed(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        "about" => url.path() == "blank",
        _ => false,
    }
}

/// A plugin that refuses (and logs) every navigation of any webview that leaves the app.
pub fn guard<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|_, url| {
            let ok = allowed(url);
            if !ok {
                log::warn!(
                    "navigation: refused {}://{}",
                    url.scheme(),
                    url.host_str().unwrap_or("")
                );
            }
            ok
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_inside_the_app() {
        let ok = |u: &str| allowed(&Url::parse(u).unwrap());
        for inside in [
            "tauri://localhost/index.html",
            "tauri://localhost/index.html#/automations/runs",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            "about:blank",
        ] {
            assert!(ok(inside), "{inside}");
        }
        for outside in [
            "https://example.test/plan",
            "http://example.test/old",
            "https://tauri.localhost.evil.test/",
            "tauri://evil/index.html",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<p>x</p>",
            "about:srcdoc",
        ] {
            assert!(!ok(outside), "{outside}");
        }
    }
}
