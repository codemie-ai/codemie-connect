//! The main window shows only Connect's own pages. Anything else (a link Claude wrote, a drag of
//! a link, "Open Link" in a context menu) must never replace the app in its window; external
//! links open in the browser through the workspace's `open_source` path instead.
use tauri::{plugin::TauriPlugin, Runtime, Url};

/// Whether a navigation stays inside the app: Connect's own page (`plugins::caller::is_app_page`:
/// `tauri://localhost` on macOS, `http(s)://tauri.localhost` on Windows, and under
/// `cargo tauri dev` the CLI's dev server), `about:blank`, and the plugin frame shim.
///
/// wry asks this for subframe navigations too and can't say which frame is navigating, so the
/// main frame could also open the shim (a dropped link, say). That is why only the shim page is
/// allowed, never a plugin's own HTML or SVG: the shim is Connect's code and runs a plugin only
/// inside a frame, and `plugins::caller` refuses commands while the window shows anything but
/// Connect's page. `about:srcdoc` stays refused, so plugin frames are always loaded by `src`.
pub fn allowed(url: &Url) -> bool {
    use crate::plugins::protocol::{HOST_DIR, SCHEME, WINDOWS_HOST};
    let shim = format!("/{HOST_DIR}/frame.html");
    match url.scheme() {
        s if s == SCHEME => {
            url.host_str().is_some_and(crate::plugins::valid_id) && url.path() == shim
        }
        "http" | "https" if url.host_str() == Some(WINDOWS_HOST) => {
            url.path().strip_prefix('/').is_some_and(|p| {
                p.split_once('/').is_some_and(|(id, rest)| {
                    crate::plugins::valid_id(id) && format!("/{rest}") == shim
                })
            })
        }
        "about" => url.path() == "blank",
        _ => crate::plugins::caller::is_app_page(url),
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

    #[test]
    fn plugin_frames_may_open_only_the_shim_page() {
        let ok = |u: &str| allowed(&Url::parse(u).unwrap());
        for shim in [
            "connect-plugin://github/__host/frame.html",
            "connect-plugin://isolation-probe/__host/frame.html?probe=1",
            "http://connect-plugin.localhost/github/__host/frame.html",
            "https://connect-plugin.localhost/github/__host/frame.html#x",
        ] {
            assert!(ok(shim), "{shim}");
        }
        // A plugin's own documents (HTML, SVG, XML) would run its code as a page; only the shim,
        // Connect's code, may be one. Its scripts and images load as subresources.
        for refused in [
            "connect-plugin://github/client.js",
            "connect-plugin://github/page.html",
            "connect-plugin://github/icon.svg",
            "connect-plugin://github/__host/probe.js",
            "connect-plugin://github/__host/frame.html/x",
            "connect-plugin://github/sub/__host/frame.html",
            "connect-plugin://Github/__host/frame.html",
            "connect-plugin://__host/frame.html",
            "http://connect-plugin.localhost/github/page.html",
            "http://connect-plugin.localhost/__host/frame.html",
            "http://evil.localhost/github/__host/frame.html",
        ] {
            assert!(!ok(refused), "{refused}");
        }
    }
}
