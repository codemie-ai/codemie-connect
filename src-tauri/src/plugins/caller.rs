//! Who is calling a command (DESIGN 7.3). Plugin frames live inside the main window's webview, so
//! the window label (`storage::commands::main_window_only`) can't tell Connect's own page from a
//! frame in it. And Tauri 2.12.6 lets any local origin call app commands: a registered custom
//! scheme such as `connect-plugin` counts as local (`webview/mod.rs` `is_local_url`), and app
//! commands are checked against the ACL only with an app manifest or a remote origin.
//!
//! What Tauri does guarantee: the invoke key is injected into the main frame only
//! (`manager/webview.rs`, `for_main_frame_only`); a call without it is dropped. A call over the
//! `ipc:` scheme carries the browser's own `Origin` header, which page script can't set, and
//! `Origin: null` (a sandboxed frame) is refused before any command runs (`ipc/protocol.rs`).
//! Connect's page always calls over `ipc:`; its CSP allows it.
//!
//! Two checks build on that:
//! - `require_main_frame`, in sensitive commands: the call's `Origin` is Connect's own page. A call
//!   without one came through the `postMessage` fallback, whose headers the caller chooses, so it
//!   is refused too.
//! - `app_page_only`, around every app command (`lib.rs`): the window shows Connect's own page. It
//!   stops a plugin page that became the top-level document (the navigation guard can't tell
//!   frames apart), where Tauri would hand it the invoke key and let it pick any header.
//!
//! Connect's own page is the bundled one, or under `cargo tauri dev` the CLI's dev server
//! (`trust_dev_server`).
use crate::workspace::models::{Result, WorkspaceError};
use std::sync::OnceLock;
use tauri::http::{header::ORIGIN, HeaderMap};
use tauri::ipc::Invoke;
use tauri::{Config, Runtime, Url};

/// The origins of Connect's own page: macOS and Linux, then Windows (WebView2 serves the app over
/// http, or https with `useHttpsScheme`).
const APP_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

/// The origin `cargo tauri dev` serves the UI from, when this dev build runs that way.
static DEV_ORIGIN: OnceLock<String> = OnceLock::new();

/// Counts the configured `devUrl` as Connect's own page. Called once at startup; only dev builds
/// (no `custom-protocol` feature, the ones `cargo tauri dev` and `cargo build` make) trust it, as
/// only they load the UI from it.
pub fn trust_dev_server(config: &Config) {
    if let Some(origin) = config.build.dev_url.as_ref().and_then(origin_of) {
        if tauri::is_dev() {
            let _ = DEV_ORIGIN.set(origin);
        }
    }
}

fn dev_origin() -> Option<&'static str> {
    DEV_ORIGIN.get().map(String::as_str)
}

/// Checks that a command call comes from Connect's own page, not a plugin frame.
///
/// Applied to `workspace_request` and the data-folder commands (`storage_status`,
/// `data_location_*`, `app_relaunch`). Every command that reaches plugins or plugin data must
/// call it too: `plugins_request` (Task 19) and `plugin_call` (Task 22) when they are added
/// (ruling R4).
pub fn require_main_frame(call: &tauri::ipc::Request<'_>) -> Result<()> {
    check_origin(call.headers(), dev_origin())
}

/// Wraps the app's command handler so that no app command runs while the window shows anything
/// but Connect's own page. `Webview::url` is the top-level document, which plugin frames share
/// with Connect's page, so this complements `require_main_frame` rather than replacing it.
pub fn app_page_only<R: Runtime>(
    commands: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let page = invoke.message.webview_ref().url();
        match page
            .map_err(|_| refused())
            .and_then(|p| check_page(&p, dev_origin()))
        {
            Ok(()) => commands(invoke),
            Err(e) => {
                log::warn!("refused {}: {}", invoke.message.command(), e.message);
                invoke.resolver.reject(e);
                true
            }
        }
    }
}

/// Whether a URL is Connect's own page: the bundled one, or the trusted dev server.
pub fn is_app_page(url: &Url) -> bool {
    check_page(url, dev_origin()).is_ok()
}

/// `dev` is the trusted dev-server origin, if any.
fn check_origin(headers: &HeaderMap, dev: Option<&str>) -> Result<()> {
    match headers.get(ORIGIN).and_then(|v| v.to_str().ok()) {
        Some(origin) if is_app_origin(origin, dev) => Ok(()),
        _ => Err(refused()),
    }
}

fn check_page(page: &Url, dev: Option<&str>) -> Result<()> {
    match origin_of(page) {
        Some(origin) if is_app_origin(&origin, dev) => Ok(()),
        _ => Err(refused()),
    }
}

fn is_app_origin(origin: &str, dev: Option<&str>) -> bool {
    APP_ORIGINS.contains(&origin) || dev == Some(origin)
}

/// A URL's origin as a browser writes it in the `Origin` header. `Url::origin` is opaque for
/// custom schemes such as `tauri:`, so it is spelled out: scheme, host, and a port other than the
/// scheme's default.
fn origin_of(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

fn refused() -> WorkspaceError {
    WorkspaceError::new(
        "permission_required",
        "Only Connect's own page can do this.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::HeaderValue;

    fn origin(value: Option<&[u8]>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(v) = value {
            headers.insert("origin", HeaderValue::from_bytes(v).unwrap());
        }
        headers
    }

    #[test]
    fn require_main_frame_rejects_null_and_plugin_origins() {
        for ok in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ] {
            assert!(
                check_origin(&origin(Some(ok.as_bytes())), None).is_ok(),
                "{ok}"
            );
        }
        for bad in [
            Some("null".as_bytes()),
            Some(b"connect-plugin://github"),
            Some(b"connect-plugin://localhost"),
            Some(b"http://connect-plugin.localhost"),
            Some(b"tauri://localhost.evil.test"),
            Some(b"tauri://evil"),
            Some(b"http://tauri.localhost:8080"),
            Some(b"tauri://localhost/index.html"),
            Some(b"TAURI://LOCALHOST"),
            Some(b""),
            Some(b"tauri://localhost\xff"),
            // The postMessage fallback carries caller-chosen headers and no browser Origin.
            None,
        ] {
            let err = check_origin(&origin(bad), None).unwrap_err();
            assert_eq!(err.code, "permission_required", "{bad:?}");
        }
    }

    #[test]
    fn commands_need_connects_own_page() {
        for ok in [
            "tauri://localhost/index.html",
            "tauri://localhost/index.html#/settings/plugins",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
        ] {
            assert!(check_page(&Url::parse(ok).unwrap(), None).is_ok(), "{ok}");
        }
        for bad in [
            "connect-plugin://github/__host/frame.html",
            "http://connect-plugin.localhost/github/__host/frame.html",
            "about:blank",
            "https://example.test/",
            "tauri://evil/index.html",
            "http://localhost:1430/",
        ] {
            let err = check_page(&Url::parse(bad).unwrap(), None).unwrap_err();
            assert_eq!(err.code, "permission_required", "{bad}");
        }
    }

    #[test]
    fn a_dev_server_page_counts_only_when_trusted() {
        // `tauri dev` serves the UI from its own server; startup trusts that origin in dev builds.
        let dev = Some("http://localhost:1430");
        let page = Url::parse("http://localhost:1430/index.html#/today").unwrap();
        assert!(check_page(&page, dev).is_ok());
        assert!(check_origin(&origin(Some(b"http://localhost:1430")), dev).is_ok());
        assert!(check_page(&page, None).is_err());
        assert!(check_origin(&origin(Some(b"http://localhost:1430")), None).is_err());
        for bad in ["http://localhost:1431", "http://127.0.0.1:1430", "null"] {
            assert!(
                check_origin(&origin(Some(bad.as_bytes())), dev).is_err(),
                "{bad}"
            );
        }
        // The bundled origins still count, and plugin origins never do.
        assert!(check_origin(&origin(Some(b"tauri://localhost")), dev).is_ok());
        assert!(check_origin(&origin(Some(b"connect-plugin://github")), dev).is_err());
    }

    #[test]
    fn origins_are_spelled_like_the_origin_header() {
        for (url, want) in [
            ("tauri://localhost/index.html", "tauri://localhost"),
            (
                "http://tauri.localhost/index.html",
                "http://tauri.localhost",
            ),
            ("https://tauri.localhost:443/", "https://tauri.localhost"),
            ("http://localhost:1430/", "http://localhost:1430"),
            (
                "connect-plugin://github/__host/frame.html",
                "connect-plugin://github",
            ),
        ] {
            assert_eq!(
                origin_of(&Url::parse(url).unwrap()).as_deref(),
                Some(want),
                "{url}"
            );
        }
        assert_eq!(origin_of(&Url::parse("about:blank").unwrap()), None);
    }
}
