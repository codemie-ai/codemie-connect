//! Who is calling a command (DESIGN 7.3). Plugin frames live inside the main window's webview, so
//! the window label (`storage::commands::main_window_only`) can't tell Connect's own page from a
//! frame in it. And Tauri 2.12.6 lets any local origin call app commands: a registered custom
//! scheme such as `connect-plugin` counts as local (`webview/mod.rs` `is_local_url`), and app
//! commands are checked against the ACL only with an app manifest or a remote origin.
//!
//! What Tauri does guarantee on macOS: the invoke key is injected into the main frame only
//! (`manager/webview.rs`, `for_main_frame_only`); a call without it is dropped. That key, the
//! frame sandbox and the frame CSP are the barriers. (On Windows wry injects into subframes too,
//! so plugin frames aren't served there at all; see `protocol`.) A call over the `ipc:` scheme
//! carries the browser's own `Origin` header, which page script can't set, and `Origin: null` (a
//! sandboxed frame) is refused before any command runs (`ipc/protocol.rs`).
//!
//! Two checks build on that, as defence in depth:
//! - `require_main_frame`, first in sensitive commands: the call's `Origin` is Connect's own page.
//!   A call without one is refused. After Tauri's `postMessage` fallback the browser sets no
//!   `Origin`, so Connect's own invoke (`ui/workspace/app-invoke.js`) sends the page origin as a
//!   header; there the header is the caller's word, and the invoke key is what vouches for it.
//! - `app_page_only`, around every app command (`lib.rs`): the window shows Connect's own page.
//!   It narrows what a plugin page could do if it ever became the top-level document (the
//!   navigation guard can't tell frames apart); it is not the primary barrier.
//!
//! Connect's own page is the bundled one, or in a debug `cargo tauri dev` run the CLI's dev
//! server (`trust_dev_server`).
use crate::workspace::models::{Result, WorkspaceError};
use std::sync::OnceLock;
use tauri::http::{header::ORIGIN, HeaderMap};
use tauri::ipc::Invoke;
use tauri::{Config, Runtime, Url};

/// The origins of Connect's bundled page: `tauri://localhost` on macOS and Linux; on Windows
/// WebView2 serves the app over http, or https with `useHttpsScheme`.
fn app_origins(windows: bool) -> &'static [&'static str] {
    if windows {
        &["http://tauri.localhost", "https://tauri.localhost"]
    } else {
        &["tauri://localhost"]
    }
}

/// The origin `cargo tauri dev` serves the UI from, when this dev build runs that way.
static DEV_ORIGIN: OnceLock<String> = OnceLock::new();

/// Counts the configured `devUrl` as Connect's own page. Called once at startup; only a debug dev
/// build (`cargo tauri dev`: debug assertions and no `custom-protocol` feature) trusts it, as only
/// it loads the UI from there.
pub fn trust_dev_server(config: &Config) {
    let dev_url = config.build.dev_url.as_ref();
    if let Some(origin) = dev_origin_to_trust(dev_url, cfg!(debug_assertions), tauri::is_dev()) {
        let _ = DEV_ORIGIN.set(origin);
    }
}

fn dev_origin_to_trust(
    dev_url: Option<&Url>,
    debug_build: bool,
    dev_build: bool,
) -> Option<String> {
    (debug_build && dev_build).then(|| dev_url.and_then(origin_of))?
}

fn dev_origin() -> Option<&'static str> {
    DEV_ORIGIN.get().map(String::as_str)
}

/// Checks that a command call comes from Connect's own page, not a plugin frame.
///
/// Applied to `workspace_request`, `plugins_request`, `plugin_call` and the data-folder commands
/// (`storage_status`, `data_location_*`, `app_relaunch`). Every command that reaches plugins or
/// plugin data must call it first (ruling R4).
pub fn require_main_frame(call: &tauri::ipc::Request<'_>) -> Result<()> {
    check_origin(call.headers(), dev_origin())
}

/// Wraps the app's command handler so that no app command runs while the window shows anything
/// but Connect's own page. Defence in depth, not the primary barrier: `Webview::url` is the
/// top-level document, which plugin frames share with Connect's page, so it says nothing about
/// frames (that is `require_main_frame`'s and the invoke key's job).
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
    app_origins(cfg!(windows)).contains(&origin) || dev == Some(origin)
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
    fn each_platform_has_its_own_app_origins() {
        assert_eq!(app_origins(false), ["tauri://localhost"]);
        assert_eq!(
            app_origins(true),
            ["http://tauri.localhost", "https://tauri.localhost"]
        );
    }

    #[test]
    fn require_main_frame_rejects_null_and_plugin_origins() {
        for ok in app_origins(cfg!(windows)) {
            assert!(
                check_origin(&origin(Some(ok.as_bytes())), None).is_ok(),
                "{ok}"
            );
        }
        // The other platform's page origins don't count here.
        for other in app_origins(!cfg!(windows)) {
            assert!(
                check_origin(&origin(Some(other.as_bytes())), None).is_err(),
                "{other}"
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
            // A call with no Origin at all.
            None,
        ] {
            let err = check_origin(&origin(bad), None).unwrap_err();
            assert_eq!(err.code, "permission_required", "{bad:?}");
        }
    }

    #[test]
    fn commands_need_connects_own_page() {
        let own: &[&str] = if cfg!(windows) {
            &[
                "http://tauri.localhost/index.html",
                "https://tauri.localhost/",
            ]
        } else {
            &[
                "tauri://localhost/index.html",
                "tauri://localhost/index.html#/settings/plugins",
            ]
        };
        for ok in own {
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
        // The bundled origin still counts, and plugin origins never do.
        let own = app_origins(cfg!(windows))[0];
        assert!(check_origin(&origin(Some(own.as_bytes())), dev).is_ok());
        assert!(check_origin(&origin(Some(b"connect-plugin://github")), dev).is_err());
    }

    #[test]
    fn only_a_debug_dev_build_trusts_the_dev_server() {
        let url = Url::parse("http://localhost:1430/").unwrap();
        let want = Some("http://localhost:1430".to_string());
        assert_eq!(dev_origin_to_trust(Some(&url), true, true), want);
        assert_eq!(dev_origin_to_trust(Some(&url), false, true), None);
        assert_eq!(dev_origin_to_trust(Some(&url), true, false), None);
        assert_eq!(dev_origin_to_trust(None, true, true), None);
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

    /// The names of the `#[tauri::command]` functions in a source file.
    fn command_names(src: &str) -> Vec<&str> {
        src.split("#[tauri::command]\n")
            .skip(1)
            .filter_map(|part| {
                let after = &part[part.find("fn ")? + 3..];
                Some(&after[..after.find('(')?])
            })
            .collect()
    }

    /// The first statement in the body of function `name`.
    fn first_statement<'a>(src: &'a str, name: &str) -> &'a str {
        let start = src.find(&format!("fn {name}(")).expect(name);
        let body = start + src[start..].find("{\n").expect(name) + 2;
        src[body..]
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap()
    }

    #[test]
    fn every_guarded_command_checks_its_caller_first() {
        let storage = include_str!("../storage/commands.rs");
        let mut names = command_names(storage);
        names.sort_unstable();
        // Every data-folder command is guarded, so a new one can't be added without the check.
        assert_eq!(
            names,
            [
                "app_relaunch",
                "data_location_change",
                "data_location_check",
                "data_location_get",
                "data_location_pick",
                "data_location_remove_old",
                "data_location_reveal",
                "data_location_use_default",
                "meetings_root_pick",
                "storage_status",
            ]
        );
        for name in names {
            assert_eq!(
                first_statement(storage, name),
                "require_main_frame(&call)?;",
                "{name}"
            );
        }
        let workspace = include_str!("../workspace/mod.rs");
        assert_eq!(
            first_statement(workspace, "workspace_request"),
            "crate::plugins::caller::require_main_frame(&call)?;"
        );
        // Every plugin command reaches plugins or plugin data (ruling R4).
        let plugins = include_str!("commands.rs");
        assert_eq!(command_names(plugins), ["plugins_request", "plugin_call"]);
        for name in ["plugins_request", "plugin_call"] {
            assert_eq!(
                first_statement(plugins, name),
                "require_main_frame(&call)?;",
                "{name}"
            );
        }
    }
}
