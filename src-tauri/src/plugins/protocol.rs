//! The `connect-plugin` scheme (DESIGN 7.3): plugin UIs and Connect's frame shim, served to the
//! sandboxed frames inside the main window.
//!
//! URLs: `connect-plugin://<id>/<path>`. Each plugin is its own origin, so its CSP (`frame_csp`)
//! admits that plugin's files and the shim served under it, not another plugin's.
//!
//! macOS only (ruling R30). On Windows wry injects its init scripts, the invoke key among them,
//! into subframes, and WebView2 guards only top-level navigation and messages, so a plugin frame
//! would hold the key; on Linux (WebKitGTK) isolation is not verified. Every request is refused
//! off macOS (`PLUGIN_FRAMES_SUPPORTED`).
//! - `__host/<file>` is the bundled shim, `ui/plugins/frame/<file>`. It is Connect's own code and
//!   the same for every plugin, so any well-formed id serves it.
//! - `__host/plugin/<id>/folder/<root>/<rel>` is an image in a folder the user gave plugin `<id>`
//!   (a vault page's picture; Knowledge writes the address relative to its frame), served only on
//!   `<id>`'s own origin, only from a granted root, only png, jpg, gif and webp up to 10 MB.
//! - Any other path is a file of the plugin's active version,
//!   `<data root>/plugins/installed/<id>/<version>/<path>`: the version the registry records,
//!   while the plugin is enabled (`registry::active_version`).
//!
//! Every response carries a CSP and `nosniff`. Files also carry
//! `Access-Control-Allow-Origin: null`: a sandboxed frame has an opaque origin, and module scripts
//! load in CORS mode. Serving never makes a frame trusted; the sandbox, the CSP, the navigation
//! guard and `caller` keep plugin code away from Connect's commands.
use super::registry::PluginPaths;
use crate::workspace::WorkspaceState;
use std::path::PathBuf;
use tauri::http::header::{
    ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE,
    X_CONTENT_TYPE_OPTIONS,
};
use tauri::http::{Method, Request, Response, StatusCode, Uri};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "connect-plugin";
/// Whether plugin frames can be isolated on this platform (see the module comment).
pub const PLUGIN_FRAMES_SUPPORTED: bool = cfg!(target_os = "macos");
/// The path prefix of the bundled shim under every plugin.
pub const HOST_DIR: &str = "__host";
/// The policy of every refusal.
const REFUSED_CSP: &str = "default-src 'none'";

/// The policy of a plugin's files: DESIGN 7.3's, with `'self'` spelled out as the plugin's own
/// origin. WebKit matches `'self'` against the document's origin, which in a sandboxed frame is
/// opaque, so `'self'` admits nothing there: the native isolation smoke saw the shim's own module
/// script blocked. Naming the origin is what `'self'` was meant to say.
pub fn frame_csp(origin: &str) -> String {
    format!(
        "default-src {origin}; script-src {origin}; style-src {origin} 'unsafe-inline'; \
         img-src {origin} data:; connect-src 'none'"
    )
}

/// A lookup by name (a shim file, a plugin id).
pub type Lookup<T> = Box<dyn Fn(&str) -> Option<T> + Send + Sync>;

/// Where `serve` finds files.
pub struct PluginRoots {
    /// `<data root>/plugins/installed`.
    pub installed: PathBuf,
    /// A bundled shim file by its path under `ui/plugins/frame/`, exact names only.
    pub host_file: Lookup<Vec<u8>>,
    /// The installed plugin's active version, or `None` when it isn't installed.
    pub active_version: Lookup<String>,
    /// The folders the user gave a plugin (`system.pickFolder`), by their real paths.
    pub granted_roots: Lookup<Vec<String>>,
}

/// The images a page may show from a granted folder, and the largest one.
const FOLDER_IMAGES: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
const FOLDER_IMAGE_MAX: u64 = 10 << 20;

/// Answers one `connect-plugin` request: a file with the frame headers, or a refusal.
pub fn serve(req: &Request<Vec<u8>>, roots: &PluginRoots) -> Response<Vec<u8>> {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return refuse(StatusCode::METHOD_NOT_ALLOWED);
    }
    if req
        .uri()
        .path()
        .starts_with(&format!("/{HOST_DIR}/plugin/"))
    {
        return match folder_image(roots, req.uri()) {
            Some((name, mut body, origin)) => {
                if req.method() == Method::HEAD {
                    body.clear();
                }
                respond(StatusCode::OK, mime(&name), body, Some(&frame_csp(&origin)))
            }
            None => refuse(StatusCode::NOT_FOUND),
        };
    }
    let Some(Target { id, origin, path }) = target(req.uri()) else {
        return refuse(StatusCode::NOT_FOUND);
    };
    let body = match path.split_first() {
        Some((first, rest)) if first == HOST_DIR => (!rest.is_empty())
            .then(|| (roots.host_file)(&rest.join("/")))
            .flatten(),
        _ => plugin_file(roots, &id, &path),
    };
    let Some(mut body) = body else {
        return refuse(StatusCode::NOT_FOUND);
    };
    if req.method() == Method::HEAD {
        body.clear();
    }
    let name = path.last().map(String::as_str).unwrap_or_default();
    respond(StatusCode::OK, mime(name), body, Some(&frame_csp(&origin)))
}

/// What a URL names.
struct Target {
    id: String,
    /// The plugin frame's own origin (before the sandbox makes it opaque).
    origin: String,
    /// Decoded path segments.
    path: Vec<String>,
}

/// The plugin a URL is addressed to: its host, a valid id, with no user info or port.
fn plugin_of(uri: &Uri) -> Option<&str> {
    let authority = uri.authority()?;
    // No user info and no port: the authority is the host alone.
    if authority.as_str() != authority.host() {
        return None;
    }
    let id = authority.host();
    (uri.scheme_str()? == SCHEME && super::valid_id(id)).then_some(id)
}

/// `__host/plugin/<id>/folder/<root>/<rel…>`: the file's name and bytes, and the origin it is
/// served on, when `<id>` is the plugin the URL is addressed to, `<root>` (one encoded segment)
/// is a folder the user gave it, and `<rel>` a plain path in it to an image of 10 MB at most.
fn folder_image(roots: &PluginRoots, uri: &Uri) -> Option<(String, Vec<u8>, String)> {
    let id = plugin_of(uri)?;
    let rest = uri.path().strip_prefix(&format!("/{HOST_DIR}/plugin/"))?;
    let mut parts = rest.split('/');
    if parts.next()? != id || parts.next()? != "folder" {
        return None;
    }
    (roots.active_version)(id)?;
    let root = percent_decode(parts.next()?)?;
    if !(roots.granted_roots)(id)
        .unwrap_or_default()
        .contains(&root)
    {
        return None;
    }
    let rel = parts.map(decode_segment).collect::<Option<Vec<_>>>()?;
    let name = rel.last()?.clone();
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    if !FOLDER_IMAGES.contains(&ext.as_str()) {
        return None;
    }
    let base = std::path::Path::new(&root).canonicalize().ok()?;
    let file = rel
        .iter()
        .fold(base.clone(), |dir, n| dir.join(n))
        .canonicalize()
        .ok()?;
    let meta = std::fs::metadata(&file).ok()?;
    if !file.starts_with(&base) || !meta.is_file() || meta.len() > FOLDER_IMAGE_MAX {
        return None;
    }
    let body = std::fs::read(&file).ok()?;
    Some((name, body, format!("{SCHEME}://{id}")))
}

fn target(uri: &Uri) -> Option<Target> {
    let id = plugin_of(uri)?;
    let path = uri
        .path()
        .strip_prefix('/')?
        .split('/')
        .map(decode_segment)
        .collect::<Option<Vec<_>>>()?;
    Some(Target {
        id: id.to_string(),
        origin: format!("{SCHEME}://{id}"),
        path,
    })
}

/// One percent-decoded path segment that names a plain entry inside its folder.
fn decode_segment(raw: &str) -> Option<String> {
    percent_decode(raw).filter(|s| plain_name(s))
}

/// `raw` with its `%XX` escapes decoded, when that is UTF-8 (a bad escape is refused).
fn percent_decode(raw: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(raw.len());
    let mut it = raw.bytes();
    while let Some(b) = it.next() {
        if b == b'%' {
            let hex = |c: u8| (c as char).to_digit(16);
            let (hi, lo) = (hex(it.next()?)?, hex(it.next()?)?);
            bytes.push((hi * 16 + lo) as u8);
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).ok()
}

/// Refuses an empty name (`//`, a trailing `/`), anything starting with `.` (`..`, `.%2e`,
/// dotfiles), separators of either platform (decoded `%2f`/`%5c`), `:` (drive letters, Windows
/// streams), NUL and other control characters.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':') || c.is_control())
}

fn plugin_file(roots: &PluginRoots, id: &str, path: &[String]) -> Option<Vec<u8>> {
    let version = (roots.active_version)(id).filter(|v| plain_name(v))?;
    let base = roots.installed.join(id).join(version).canonicalize().ok()?;
    let file = path
        .iter()
        .fold(base.clone(), |dir, name| dir.join(name))
        .canonicalize()
        .ok()?;
    // Canonical paths resolve every symlink, so a link out of the plugin's folder lands outside
    // it here.
    if !file.starts_with(&base) || !std::fs::metadata(&file).ok()?.is_file() {
        return None;
    }
    std::fs::read(&file).ok()
}

fn mime(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// A response with the common headers. `file_csp` is set for a served file, which also gets CORS.
fn respond(
    status: StatusCode,
    mime: &str,
    body: Vec<u8>,
    file_csp: Option<&str>,
) -> Response<Vec<u8>> {
    let mut res = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, mime)
        .header(CONTENT_SECURITY_POLICY, file_csp.unwrap_or(REFUSED_CSP))
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        // A plugin update replaces its files under the same URLs.
        .header(CACHE_CONTROL, "no-store");
    if file_csp.is_some() {
        res = res.header(ACCESS_CONTROL_ALLOW_ORIGIN, "null");
    }
    res.body(body)
        .expect("header values come from validated ids and constants")
}

fn refuse(status: StatusCode) -> Response<Vec<u8>> {
    let text = status.canonical_reason().unwrap_or("Refused");
    respond(
        status,
        "text/plain; charset=utf-8",
        text.as_bytes().to_vec(),
        None,
    )
}

/// The app's handler for the scheme. Files are read off the main thread, so a slow data drive
/// can't freeze the window.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let roots = app_roots(&app);
        responder.respond(answer(&req, roots.as_ref(), PLUGIN_FRAMES_SUPPORTED));
    });
}

/// `serve`, unless plugin frames aren't supported here (404) or the data folder wasn't resolved
/// (503).
fn answer(
    req: &Request<Vec<u8>>,
    roots: Option<&PluginRoots>,
    supported: bool,
) -> Response<Vec<u8>> {
    match (supported, roots) {
        (false, _) => refuse(StatusCode::NOT_FOUND),
        (true, None) => refuse(StatusCode::SERVICE_UNAVAILABLE),
        (true, Some(roots)) => serve(req, roots),
    }
}

/// A file of the bundled shim by its exact asset key. Tauri's resolver falls back to
/// `<path>.html`, `<path>/index.html` and finally `index.html` (`manager/mod.rs` `get_asset`), so
/// the key is checked first: a missing shim file must never come back as Connect's own page.
fn bundled_frame_file(
    rel: &str,
    has_key: impl Fn(&str) -> bool,
    get: impl FnOnce(String) -> Option<Vec<u8>>,
) -> Option<Vec<u8>> {
    let key = format!("/plugins/frame/{rel}");
    has_key(&key).then(|| get(key)).flatten()
}

/// A shim file read from `dir` (`ui/plugins/frame/` on disk). Under `cargo tauri dev` the UI
/// comes from the CLI's dev server and Tauri embeds no assets, so the resolver has no shim; debug
/// builds then read it from the checkout (`app_roots`). Each segment is a plain name, and the
/// file's real path stays inside `dir`.
fn disk_frame_file(dir: &std::path::Path, rel: &str) -> Option<Vec<u8>> {
    if rel.split('/').any(|s| !plain_name(s)) {
        return None;
    }
    let base = dir.canonicalize().ok()?;
    let file = base.join(rel).canonicalize().ok()?;
    (file.starts_with(&base) && file.is_file())
        .then(|| std::fs::read(&file).ok())
        .flatten()
}

/// Roots that serve the plugins installed under `paths`, each at the version the registry
/// records while it is enabled. The registry is read per request, so an install, update,
/// disable or removal is served at once.
pub fn registry_roots(paths: PluginPaths, host_file: Lookup<Vec<u8>>) -> PluginRoots {
    let granted = paths.clone();
    PluginRoots {
        installed: paths.installed(),
        host_file,
        active_version: Box::new(move |id| super::registry::active_version(&paths, id)),
        granted_roots: Box::new(move |id| Some(super::services::fs::granted_roots(&granted, id))),
    }
}

/// The app's roots, or `None` while the data folder isn't open (no workspace state, or a
/// folder that couldn't be opened): nothing is served from a folder Connect isn't using.
fn app_roots<R: Runtime>(app: &AppHandle<R>) -> Option<PluginRoots> {
    let state = app.try_state::<WorkspaceState>()?;
    let core = state.core.as_ref()?;
    let resolver = app.asset_resolver();
    let paths = PluginPaths::new(&core.paths.data, &core.paths.private);
    // Debug builds under `cargo tauri dev` only: the shim from the checkout (Task 17, M8).
    let dev_dir = (cfg!(debug_assertions) && tauri::is_dev())
        .then(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/plugins/frame"));
    Some(registry_roots(
        paths,
        Box::new(move |rel| {
            bundled_frame_file(
                rel,
                |key| resolver.iter().any(|(k, _)| k == key),
                |key| resolver.get(key).map(|a| a.bytes),
            )
            .or_else(|| dev_dir.as_deref().and_then(|dir| disk_frame_file(dir, rel)))
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const SECRET: &str = "owner-secret-contents";

    struct Fixture {
        _dir: tempfile::TempDir,
        roots: PluginRoots,
    }

    /// `hello` 1.0.0 is installed with a client, a stylesheet, an icon, a binary and a
    /// sub-folder; a secret sits next to the plugin root and outside it; `link.js` and
    /// `linkdir/` are symlinks that escape the plugin folder.
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let installed = dir.path().join("plugins/installed");
        let plugin = installed.join("hello/1.0.0");
        fs::create_dir_all(plugin.join("sub")).unwrap();
        fs::write(plugin.join("client.js"), "export function apply() {}").unwrap();
        fs::write(plugin.join("style.css"), "a{}").unwrap();
        fs::write(plugin.join("icon.svg"), "<svg/>").unwrap();
        fs::write(plugin.join("data.bin"), [0u8, 1, 2]).unwrap();
        fs::write(plugin.join("sub/page.js"), "export {}").unwrap();
        fs::write(plugin.join(".hidden.js"), "x").unwrap();
        fs::write(dir.path().join("secret.txt"), SECRET).unwrap();
        fs::write(installed.join("hello/secret.txt"), SECRET).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret.txt"), plugin.join("link.js"))
                .unwrap();
            std::os::unix::fs::symlink(dir.path(), plugin.join("linkdir")).unwrap();
        }
        let host = dir.path().join("frame");
        fs::create_dir_all(&host).unwrap();
        fs::write(host.join("frame.html"), "<!doctype html>").unwrap();
        fs::write(host.join("probe.js"), "export {}").unwrap();
        let host_dir = host.clone();
        // A vault the user gave `hello`, with pictures and other files.
        let vault = dir.path().join("My Vault");
        fs::create_dir_all(vault.join("Files")).unwrap();
        fs::write(vault.join("Files/chart.png"), b"\x89PNG").unwrap();
        fs::write(vault.join("Files/notes.md"), "# notes").unwrap();
        fs::write(vault.join("big.png"), vec![0u8; (10 << 20) + 1]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), vault.join("Files/leak.png"))
            .unwrap();
        let vault_root = vault.canonicalize().unwrap().display().to_string();
        Fixture {
            roots: PluginRoots {
                installed,
                host_file: Box::new(move |rel| {
                    // Like the asset resolver: exact keys only, never a parent or a fallback.
                    (!rel.contains("..")).then(|| fs::read(host_dir.join(rel)).ok())?
                }),
                active_version: Box::new(|id| (id == "hello").then(|| "1.0.0".to_string())),
                granted_roots: Box::new(move |id| {
                    (id == "hello").then(|| vec![vault_root.clone()])
                }),
            },
            _dir: dir,
        }
    }

    #[test]
    fn the_dev_shim_is_read_only_from_inside_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let frame = dir.path().join("frame");
        fs::create_dir_all(frame.join("vendor")).unwrap();
        fs::write(frame.join("frame.html"), "<!doctype html>").unwrap();
        fs::write(frame.join("vendor/sigma.min.js"), "x").unwrap();
        fs::write(dir.path().join("secret.txt"), SECRET).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), frame.join("link.js")).unwrap();
        assert_eq!(
            disk_frame_file(&frame, "frame.html").as_deref(),
            Some(&b"<!doctype html>"[..])
        );
        assert!(disk_frame_file(&frame, "vendor/sigma.min.js").is_some());
        for bad in [
            "../secret.txt",
            "vendor/../../secret.txt",
            "link.js",
            ".hidden",
            "",
            "vendor",
            "missing.js",
            "/etc/passwd",
        ] {
            assert_eq!(disk_frame_file(&frame, bad), None, "{bad}");
        }
    }

    #[test]
    fn folder_images_come_only_from_a_granted_folder_of_the_frames_own_plugin() {
        let f = fixture();
        let root = (f.roots.granted_roots)("hello").unwrap().remove(0);
        let enc: String = root
            .bytes()
            .map(|b| match b {
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect();
        let url =
            |rest: &str| format!("connect-plugin://hello/__host/plugin/hello/folder/{enc}/{rest}");
        let ok = get(&f.roots, &url("Files/chart.png"));
        assert_eq!(ok.status(), 200);
        assert_eq!(header(&ok, "content-type"), Some("image/png"));
        assert_eq!(ok.body(), b"\x89PNG");
        assert!(header(&ok, "content-security-policy")
            .unwrap()
            .contains("connect-plugin://hello"));
        for bad in [
            url("Files/notes.md"),
            url("big.png"),
            url("Files/leak.png"),
            url("Files/../../secret.txt"),
            url("Files/%2e%2e/%2e%2e/secret.txt"),
            url("missing.png"),
            // Another plugin's address on this origin, or this plugin's on another's.
            format!("connect-plugin://hello/__host/plugin/other/folder/{enc}/Files/chart.png"),
            format!("connect-plugin://other/__host/plugin/hello/folder/{enc}/Files/chart.png"),
            // A folder it wasn't given.
            "connect-plugin://hello/__host/plugin/hello/folder/%2Fetc/hosts.png".to_string(),
            format!("connect-plugin://hello/__host/plugin/hello/folder/{enc}%2FFiles/chart.png"),
        ] {
            assert_eq!(get(&f.roots, &bad).status(), 404, "{bad}");
        }
    }

    fn get(roots: &PluginRoots, uri: &str) -> Response<Vec<u8>> {
        serve(&Request::get(uri).body(Vec::new()).unwrap(), roots)
    }

    fn header<'a>(res: &'a Response<Vec<u8>>, name: &str) -> Option<&'a str> {
        res.headers().get(name).and_then(|v| v.to_str().ok())
    }

    #[test]
    fn serve_rejects_traversal_and_unknown_plugin() {
        let f = fixture();
        // The happy paths, so the refusals below are refusals and not a broken fixture.
        for ok in [
            "connect-plugin://hello/client.js",
            "connect-plugin://hello/sub/page.js",
            "connect-plugin://hello/__host/frame.html",
            "connect-plugin://not-installed/__host/frame.html?probe=1",
        ] {
            assert_eq!(get(&f.roots, ok).status(), 200, "{ok}");
        }
        for (uri, status) in [
            // Traversal, raw and encoded, out of the version folder and out of the shim.
            ("connect-plugin://hello/../secret.txt", 404),
            ("connect-plugin://hello/..%2fsecret.txt", 404),
            ("connect-plugin://hello/..%2F..%2Fsecret.txt", 404),
            ("connect-plugin://hello/%2e%2e/secret.txt", 404),
            ("connect-plugin://hello/%2E%2E/%2e%2e/secret.txt", 404),
            ("connect-plugin://hello/.%2e/secret.txt", 404),
            ("connect-plugin://hello/sub/..%2f..%2fsecret.txt", 404),
            ("connect-plugin://hello/..%5csecret.txt", 404),
            ("connect-plugin://hello/__host/..%2fprobe.js", 404),
            ("connect-plugin://hello/__host/../../secret.txt", 404),
            // Absolute paths, a NUL, a drive letter and a dotfile.
            ("connect-plugin://hello//etc/passwd", 404),
            ("connect-plugin://hello/%2fetc%2fpasswd", 404),
            ("connect-plugin://hello/C:%5cWindows%5cwin.ini", 404),
            ("connect-plugin://hello/client.js%00.png", 404),
            ("connect-plugin://hello/.hidden.js", 404),
            // Symlinks that leave the plugin folder, as a file and as a folder.
            ("connect-plugin://hello/link.js", 404),
            ("connect-plugin://hello/linkdir/secret.txt", 404),
            // Folders, a missing file and a missing shim file.
            ("connect-plugin://hello/", 404),
            ("connect-plugin://hello/sub", 404),
            ("connect-plugin://hello/missing.js", 404),
            ("connect-plugin://hello/__host/", 404),
            ("connect-plugin://hello/__host/missing.js", 404),
            // Unknown or malformed plugins and hosts.
            ("connect-plugin://nope/client.js", 404),
            ("connect-plugin://Hello/client.js", 404),
            ("connect-plugin://__host/frame.html", 404),
            ("connect-plugin://hello:80/client.js", 404),
            ("connect-plugin://user@hello/client.js", 404),
            ("http://evil.localhost/hello/client.js", 404),
            ("tauri://localhost/index.html", 404),
            // WebView2's form of the scheme: plugin frames aren't served off macOS at all.
            ("http://connect-plugin.localhost/hello/client.js", 404),
            (
                "https://connect-plugin.localhost/hello/__host/frame.html",
                404,
            ),
            ("http://connect-plugin.localhost/", 404),
        ] {
            let res = get(&f.roots, uri);
            assert_eq!(res.status(), status, "{uri}");
            assert!(
                !String::from_utf8_lossy(res.body()).contains(SECRET),
                "{uri} leaked the secret"
            );
            assert_eq!(header(&res, "access-control-allow-origin"), None, "{uri}");
            assert_eq!(header(&res, "x-content-type-options"), Some("nosniff"));
            assert_eq!(
                header(&res, "content-security-policy"),
                Some("default-src 'none'")
            );
        }
        let post = Request::post("connect-plugin://hello/client.js")
            .body(Vec::new())
            .unwrap();
        assert_eq!(serve(&post, &f.roots).status(), 405);
    }

    #[test]
    fn serve_sets_csp_cors_and_mime() {
        let f = fixture();
        let mac = "connect-plugin://hello";
        for (uri, origin, mime, body) in [
            (
                "connect-plugin://hello/client.js",
                mac,
                "text/javascript; charset=utf-8",
                &b"export function apply() {}"[..],
            ),
            (
                "connect-plugin://hello/__host/frame.html?probe=1",
                mac,
                "text/html; charset=utf-8",
                b"<!doctype html>",
            ),
            (
                "connect-plugin://hello/style.css",
                mac,
                "text/css; charset=utf-8",
                b"a{}",
            ),
            (
                "connect-plugin://hello/icon.svg",
                mac,
                "image/svg+xml",
                b"<svg/>",
            ),
            (
                "connect-plugin://hello/data.bin",
                mac,
                "application/octet-stream",
                &[0, 1, 2],
            ),
            (
                "connect-plugin://hello/__host/probe.js",
                mac,
                "text/javascript; charset=utf-8",
                b"export {}",
            ),
        ] {
            let res = get(&f.roots, uri);
            assert_eq!(res.status(), 200, "{uri}");
            assert_eq!(res.body(), body, "{uri}");
            assert_eq!(header(&res, "content-type"), Some(mime), "{uri}");
            let csp = frame_csp(origin);
            assert_eq!(
                header(&res, "content-security-policy"),
                Some(csp.as_str()),
                "{uri}"
            );
            assert_eq!(
                header(&res, "access-control-allow-origin"),
                Some("null"),
                "{uri}"
            );
            assert_eq!(
                header(&res, "x-content-type-options"),
                Some("nosniff"),
                "{uri}"
            );
        }
        // DESIGN 7.3's policy, with 'self' spelled out as the plugin's own origin: WebKit matches
        // 'self' against a sandboxed frame's opaque origin, so 'self' allows nothing there.
        let design = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
                      img-src 'self' data:; connect-src 'none'";
        assert_eq!(frame_csp(mac), design.replace("'self'", mac));
        assert_eq!(
            frame_csp(mac),
            "default-src connect-plugin://hello; script-src connect-plugin://hello; \
             style-src connect-plugin://hello 'unsafe-inline'; \
             img-src connect-plugin://hello data:; connect-src 'none'"
        );
        let head = Request::head("connect-plugin://hello/client.js")
            .body(Vec::new())
            .unwrap();
        let res = serve(&head, &f.roots);
        assert_eq!(res.status(), 200);
        assert!(res.body().is_empty());
    }

    #[test]
    fn app_csp_frames_only_the_plugin_scheme() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let directives: Vec<&str> = csp.split(';').map(str::trim).collect();
        assert_eq!(
            directives,
            [
                "default-src 'self'",
                "img-src 'self' data:",
                "style-src 'self' 'unsafe-inline'",
                "script-src 'self'",
                "connect-src 'self' ipc: http://ipc.localhost",
                &format!("frame-src {SCHEME}:"),
            ]
        );
    }

    #[test]
    fn plugin_frames_are_refused_off_macos() {
        // Windows gives a plugin frame the invoke key and Linux isn't verified (R30); nothing is
        // served off macOS.
        assert_eq!(PLUGIN_FRAMES_SUPPORTED, cfg!(target_os = "macos"));
        let f = fixture();
        for uri in [
            "connect-plugin://hello/client.js",
            "connect-plugin://hello/__host/frame.html",
        ] {
            let req = Request::get(uri).body(Vec::new()).unwrap();
            let res = answer(&req, Some(&f.roots), false);
            assert_eq!(res.status(), 404, "{uri}");
            assert!(res.body().starts_with(b"Not Found"), "{uri}");
            assert_eq!(answer(&req, Some(&f.roots), true).status(), 200, "{uri}");
        }
    }

    #[test]
    fn nothing_is_served_without_a_resolved_data_folder() {
        let req = Request::get("connect-plugin://hello/__host/frame.html")
            .body(Vec::new())
            .unwrap();
        let res = answer(&req, None, true);
        assert_eq!(res.status(), 503);
        assert_eq!(header(&res, "access-control-allow-origin"), None);
    }

    #[test]
    fn serves_the_enabled_install_from_the_registry() {
        use crate::plugins::install::{install, remove, set_enabled, update};
        use crate::plugins::testkit::{self, manifest};
        let env = testkit::env();
        testkit::local_market(&env, &[manifest("hello", "1.0.0")]);
        let roots = || {
            registry_roots(
                env.paths.clone(),
                Box::new(|rel| (rel == "frame.html").then(|| b"<!doctype html>".to_vec())),
            )
        };
        let client = "connect-plugin://hello/client.js";
        // Not installed: only the shim.
        assert_eq!(get(&roots(), client).status(), 404);
        assert_eq!(
            get(&roots(), "connect-plugin://hello/__host/frame.html").status(),
            200
        );

        let empty = crate::plugins::install::sheet_hash(&[]);
        let nothing = crate::plugins::install::Agreement {
            keys: &[],
            sheet_hash: &empty,
        };
        install(&env.paths, "local", "hello", nothing).unwrap();
        let res = get(&roots(), client);
        assert_eq!(res.status(), 200);
        assert_eq!(res.body(), b"export function apply(ctx) {}\n");
        assert_eq!(
            header(&res, "content-security-policy"),
            Some(frame_csp("connect-plugin://hello").as_str())
        );
        // Nothing outside the version folder: the registry sits two folders up.
        assert_eq!(
            get(&roots(), "connect-plugin://hello/../registry.json").status(),
            404
        );

        // Off: nothing of it is served; on again: served.
        set_enabled(&env.paths, "hello", false).unwrap();
        assert_eq!(get(&roots(), client).status(), 404);
        set_enabled(&env.paths, "hello", true).unwrap();
        assert_eq!(get(&roots(), client).status(), 200);

        // Updated: the new version's files, at once.
        let src = env.market.join("plugins/hello");
        testkit::write_plugin(&src, manifest("hello", "1.1.0"));
        fs::write(src.join("client.js"), "export const v = 2;").unwrap();
        update(&env.paths, "hello", None).unwrap();
        assert_eq!(get(&roots(), client).body(), b"export const v = 2;");

        remove(&env.paths, "hello", false).unwrap();
        assert_eq!(get(&roots(), client).status(), 404);
    }

    #[test]
    fn bundled_frame_files_are_exact_keys_only() {
        // Tauri's resolver falls back to `<path>.html`, `<path>/index.html` and then
        // `index.html` (manager/mod.rs `get_asset`); `get` here does the same.
        let keys = [
            "/index.html",
            "/plugins/frame/frame.html",
            "/plugins/frame/probe.js",
        ];
        let has_key = |k: &str| keys.contains(&k);
        let get = |k: String| -> Option<Vec<u8>> {
            Some(match k.as_str() {
                "/plugins/frame/frame.html" => b"frame".to_vec(),
                "/plugins/frame/probe.js" => b"probe".to_vec(),
                _ => b"<html>Connect's own page</html>".to_vec(),
            })
        };
        assert_eq!(
            bundled_frame_file("frame.html", has_key, get),
            Some(b"frame".to_vec())
        );
        assert_eq!(
            bundled_frame_file("probe.js", has_key, get),
            Some(b"probe".to_vec())
        );
        for missing in [
            "missing.js",
            "frame",
            "",
            "../index.html",
            "../../index.html",
            "index.html",
        ] {
            assert_eq!(bundled_frame_file(missing, has_key, get), None, "{missing}");
        }
    }
}
