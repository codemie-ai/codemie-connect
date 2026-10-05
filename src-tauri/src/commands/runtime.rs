// Node and the CLI are not inside the app. On first launch they are
// downloaded and installed into %LOCALAPPDATA%\CodeMie\runtime\<key>\
// (node\node.exe, cli\node_modules\...). Config is pinned at compile time
// via runtime.json; the key encodes both the CLI and Node versions.
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::error::{CmdResult, InstallerError};

const RUNTIME_JSON: &str = include_str!("../../../runtime.json");
const COMPLETE_MARKER: &str = ".complete";
const CONNECT_JSON: &str = r#"{ "managedBy": "CodeMie Connect" }"#;

/// Pinned versions from runtime.json, baked in at compile time.
#[derive(serde::Deserialize, Clone)]
pub struct Config {
    #[serde(rename = "nodeVersion")]
    pub node_version: String,
    #[serde(rename = "nodeWin64Sha256")]
    pub node_win64_sha256: Option<String>,
    #[serde(rename = "nodeMacosArm64Sha256")]
    #[allow(dead_code)] // used by macOS path added in MR !53
    pub node_macos_arm64_sha256: Option<String>,
    #[serde(rename = "cliPackage")]
    pub cli_package: String,
    #[serde(rename = "cliVersion")]
    pub cli_version: String,
}

impl Config {
    pub fn node_sha256(&self) -> &str {
        #[cfg(windows)]
        return self.node_win64_sha256.as_deref().unwrap_or("");
        #[cfg(not(windows))]
        return self.node_macos_arm64_sha256.as_deref().unwrap_or("");
    }
}

pub fn config() -> Config {
    serde_json::from_str(RUNTIME_JSON).expect("runtime.json is malformed")
}

fn runtime_key(cfg: &Config) -> String {
    format!("{}-node{}", cfg.cli_version, cfg.node_version)
}

/// `%LOCALAPPDATA%\CodeMie\runtime`; per-user, no admin rights.
pub fn runtime_base() -> CmdResult<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("CodeMie").join("runtime"))
        .ok_or_else(|| InstallerError::Other("LOCALAPPDATA is not set".into()))
}

pub fn runtime_dir() -> CmdResult<PathBuf> {
    Ok(runtime_base()?.join(runtime_key(&config())))
}

pub fn node_dir(dir: &Path) -> PathBuf {
    dir.join("node")
}

pub fn node_exe(dir: &Path) -> PathBuf {
    node_dir(dir).join(if cfg!(windows) { "node.exe" } else { "node" })
}

pub fn cli_entry(dir: &Path) -> PathBuf {
    dir.join("cli")
        .join("node_modules")
        .join("@codemieai")
        .join("code")
        .join("bin")
        .join("codemie.js")
}

fn connect_json_path(dir: &Path) -> PathBuf {
    dir.join("cli")
        .join("node_modules")
        .join("@codemieai")
        .join("code")
        .join("codemie-connect.json")
}

/// npm-cli.js path inside a staged/installed node tree.
fn npm_cli(node_dir: &Path) -> PathBuf {
    // Windows: node_modules/npm next to node.exe
    // macOS:   lib/node_modules/npm under the node prefix
    #[cfg(windows)]
    return node_dir
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    #[cfg(not(windows))]
    return node_dir
        .join("lib")
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
}

/// Ready only when the last step of an install (the marker) happened, so a
/// partial download or install is never used.
pub fn is_ready(dir: &Path) -> bool {
    dir.join(COMPLETE_MARKER).is_file() && node_exe(dir).is_file() && cli_entry(dir).is_file()
}

/// Whether the runtime named `key` under `base` is complete.
pub fn key_ready(base: &Path, key: &str) -> bool {
    !key.is_empty() && is_ready(&base.join(key))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn ready(existing_cli: bool, smoke: bool, dir_ready: bool) -> bool {
    existing_cli || smoke || !cfg!(windows) || dir_ready
}

fn smoke_mode() -> bool {
    std::env::var_os("CODEMIE_SMOKE").is_some() || std::env::var_os("CODEMIE_PROBE_SMOKE").is_some()
}

/// True when nothing has to be downloaded: the runtime is in place, or the
/// user has their own CLI (EPMCDME-14581).
#[tauri::command]
pub fn runtime_ready(state: tauri::State<'_, crate::state::AppState>) -> CmdResult<bool> {
    let dir_ready = cfg!(windows) && is_ready(&runtime_dir()?);
    Ok(ready(state.existing_cli_detected, smoke_mode(), dir_ready))
}

pub fn verify_sha(got_hex: &str, expected: &str) -> CmdResult<()> {
    if got_hex == expected {
        return Ok(());
    }
    Err(InstallerError::Download(format!(
        "checksum mismatch (got {got_hex}, expected {expected})"
    )))
}

fn tar_exe() -> PathBuf {
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        PathBuf::from(root).join("System32").join("tar.exe")
    } else {
        PathBuf::from("tar")
    }
}

/// Renames with retries for virus-scanner hold windows.
fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for i in 0..5 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(200 * (i + 1)));
    }
    Err(last.unwrap())
}

/// Atomically promotes a verified staging tree into place. The marker is
/// written inside staging first; an existing `dir` is moved aside before the
/// rename so a crash never leaves `dir` without a complete runtime.
pub fn promote(staging: &Path, dir: &Path) -> CmdResult<()> {
    let key = dir.file_name().unwrap_or_default().to_string_lossy();
    let aside = dir.with_file_name(format!(".old-{key}"));
    std::fs::write(staging.join(COMPLETE_MARKER), key.as_bytes())?;
    let _ = std::fs::remove_dir_all(&aside);
    if dir.exists() {
        rename_retry(dir, &aside)?;
    }
    rename_retry(staging, dir)?;
    let _ = std::fs::remove_dir_all(&aside);
    Ok(())
}

/// Removes everything under `base` except the current runtime, cleaning up
/// stale versions and download/staging leftovers.
pub fn remove_stale(base: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy() != keep {
            let p = e.path();
            let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
        }
    }
}

/// Streams `url` into `archive`, verifying the SHA-256 on completion.
/// On any failure `archive` is removed. `progress(done, total)` per chunk.
pub async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    archive: &Path,
    expected_sha: &str,
    progress: impl Fn(u64, u64),
) -> CmdResult<()> {
    let r = fetch(client, url, archive, expected_sha, progress).await;
    if r.is_err() {
        let _ = tokio::fs::remove_file(archive).await;
    }
    r
}

async fn fetch(
    client: &reqwest::Client,
    url: &str,
    archive: &Path,
    expected_sha: &str,
    progress: impl Fn(u64, u64),
) -> CmdResult<()> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| InstallerError::Download(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(InstallerError::Download(format!(
            "HTTP {} for {url}",
            resp.status().as_u16()
        )));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(archive).await?;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| InstallerError::Download(e.to_string()))?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        done += chunk.len() as u64;
        progress(done, total);
    }
    file.flush().await?;
    drop(file);
    if total > 0 && done != total {
        return Err(InstallerError::Download("download was cut short".into()));
    }
    verify_sha(&hex(&hasher.finalize()), expected_sha)
}

/// Downloads Node from nodejs.org, then installs the CLI via npm, unless the
/// runtime is already in place. Emits `runtime:progress` with `{ phase, fraction, total }`.
#[tauri::command]
pub async fn ensure_runtime(app: AppHandle) -> CmdResult<()> {
    // ponytail: global lock — one install at a time; per-user app so one instance is typical
    static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = INSTALL_LOCK.lock().await;
    let dir = runtime_dir()?;
    if is_ready(&dir) {
        return Ok(());
    }
    let cfg = config();
    let base = runtime_base()?;
    tokio::fs::create_dir_all(&base).await?;
    let key = runtime_key(&cfg);
    let zip = base.join(format!(".download-{key}.zip"));
    let staging = base.join(format!(".staging-{key}"));
    let result = install(&app, &cfg, &base, &dir, &zip, &staging).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&zip).await;
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result
}

#[cfg(windows)]
async fn install(
    app: &AppHandle,
    cfg: &Config,
    base: &Path,
    dir: &Path,
    zip: &Path,
    staging: &Path,
) -> CmdResult<()> {
    // CODEMIE_RUNTIME_URL overrides the nodejs.org download for local testing.
    let url = std::env::var("CODEMIE_RUNTIME_URL").unwrap_or_else(|_| {
        let v = &cfg.node_version;
        format!("https://nodejs.org/dist/v{v}/node-v{v}-win-x64.zip")
    });
    let _ = tokio::fs::remove_file(zip).await;
    let _ = tokio::fs::remove_dir_all(staging).await;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| InstallerError::Download(e.to_string()))?;

    download_verified(&client, &url, zip, cfg.node_sha256(), |done, total| {
        if total > 0 {
            let _ = app.emit(
                "runtime:progress",
                serde_json::json!({ "phase": "download", "fraction": done as f64 / total as f64, "total": total }),
            );
        }
    })
    .await?;

    // Reuse the "unpack" phase label the UI already knows ("Unpacking…").
    let _ = app.emit(
        "runtime:progress",
        serde_json::json!({ "phase": "unpack", "fraction": 1.0 }),
    );

    let (zip, staging, dir, base, key, cfg) = (
        zip.to_path_buf(),
        staging.to_path_buf(),
        dir.to_path_buf(),
        base.to_path_buf(),
        runtime_key(cfg),
        cfg.clone(),
    );
    tokio::task::spawn_blocking(move || {
        let r = install_sync(&cfg, &zip, &staging, &dir);
        let _ = std::fs::remove_file(&zip);
        if r.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        r?;
        remove_stale(&base, &key);
        Ok(())
    })
    .await
    .map_err(|e| InstallerError::Other(e.to_string()))?
}

#[cfg(not(windows))]
async fn install(
    _app: &AppHandle,
    _cfg: &Config,
    _base: &Path,
    _dir: &Path,
    _zip: &Path,
    _staging: &Path,
) -> CmdResult<()> {
    // macOS install path is implemented in MR !53 and will extend this function.
    Ok(())
}

/// Synchronous install: extract Node zip then npm-install the pinned CLI.
#[cfg(windows)]
fn install_sync(cfg: &Config, zip: &Path, staging: &Path, dir: &Path) -> CmdResult<()> {
    let node_staging = node_dir(staging);
    let cli_staging = staging.join("cli");

    std::fs::create_dir_all(&node_staging)?;
    extract_node_zip(zip, &node_staging, &cfg.node_version)?;

    std::fs::create_dir_all(&cli_staging)?;
    npm_install_cli(cfg, &node_staging, &cli_staging)?;

    std::fs::write(connect_json_path(staging), CONNECT_JSON)?;

    if !cli_entry(staging).is_file() {
        return Err(InstallerError::Other(
            "CLI entry not found after npm install".into(),
        ));
    }

    promote(staging, dir)
}

/// Extracts node.exe and the npm tree from a nodejs.org win-x64 zip.
/// Uses the in-box bsdtar (Windows 10+) so no extra dependency is needed.
#[cfg(windows)]
fn extract_node_zip(zip: &Path, dest: &Path, node_version: &str) -> CmdResult<()> {
    let prefix = format!("node-v{node_version}-win-x64");
    let out = std::process::Command::new(tar_exe())
        .arg("-xf")
        .arg(zip)
        .arg("--strip-components=1")
        .arg("-C")
        .arg(dest)
        .arg(format!("{prefix}/node.exe"))
        .arg(format!("{prefix}/node_modules/npm"))
        .output()?;
    if !out.status.success() {
        return Err(InstallerError::Other(format!(
            "Node zip extraction failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// Installs the pinned CLI version into `cli_dir` via npm.
/// Uses the just-extracted node.exe so no system Node is required.
#[cfg(windows)]
fn npm_install_cli(cfg: &Config, node_dir: &Path, cli_dir: &Path) -> CmdResult<()> {
    let node = node_dir.join("node.exe");
    let npm = npm_cli(node_dir);
    // Exact version pin so the installed CLI is always >= 0.15.7 regardless of
    // whether the lock file has been regenerated for the new version yet.
    let spec = format!("{}@{}", cfg.cli_package, cfg.cli_version);
    let out = std::process::Command::new(&node)
        .arg(&npm)
        .arg("install")
        .arg(&spec)
        .arg("--omit=dev")
        .arg("--no-audit")
        .arg("--no-fund")
        .current_dir(cli_dir)
        .output()?;
    if !out.status.success() {
        return Err(InstallerError::Other(format!(
            "npm install {spec} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// Runs a background CLI update on launch and removes replaced runtime dirs.
/// Non-fatal: errors are swallowed so a failing update never blocks the app.
#[tauri::command]
pub async fn update_cli() -> CmdResult<()> {
    #[cfg(windows)]
    {
        let dir = match runtime_dir() {
            Ok(d) if is_ready(&d) => d,
            _ => return Ok(()),
        };
        tokio::task::spawn_blocking(move || {
            let cfg = config();
            let node = node_exe(&dir);
            let npm = npm_cli(&node_dir(&dir));
            let cli_dir = dir.join("cli");
            let out = std::process::Command::new(&node)
                .arg(&npm)
                .arg("install")
                .arg(format!("{}@latest", cfg.cli_package))
                .arg("--omit=dev")
                .arg("--no-audit")
                .arg("--no-fund")
                .current_dir(&cli_dir)
                .output();
            if let Ok(out) = out {
                if out.status.success() {
                    let _ = std::fs::write(connect_json_path(&dir), CONNECT_JSON);
                }
            }
            if let Ok(base) = runtime_base() {
                remove_stale(&base, &runtime_key(&cfg));
            }
        })
        .await
        .ok();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn not_ready_without_marker_even_with_files() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        std::fs::create_dir_all(node_exe(d).parent().unwrap()).unwrap();
        std::fs::write(node_exe(d), "x").unwrap();
        std::fs::create_dir_all(cli_entry(d).parent().unwrap()).unwrap();
        std::fs::write(cli_entry(d), "x").unwrap();
        assert!(!is_ready(d));
        std::fs::write(d.join(COMPLETE_MARKER), "k").unwrap();
        assert!(is_ready(d));
    }

    #[test]
    fn ready_when_a_cli_already_exists_even_with_an_empty_dir() {
        assert!(ready(true, false, false));
    }

    #[test]
    fn ready_in_smoke_mode_so_the_overlay_never_blocks_it() {
        assert!(ready(false, true, false));
    }

    #[cfg(windows)]
    #[test]
    fn not_ready_on_windows_without_cli_smoke_or_runtime() {
        assert!(!ready(false, false, false));
        assert!(ready(false, false, true));
    }

    #[cfg(not(windows))]
    #[test]
    fn always_ready_off_windows() {
        assert!(ready(false, false, false));
    }

    #[test]
    fn verify_sha_accepts_equal_and_rejects_different() {
        assert!(verify_sha("abc", "abc").is_ok());
        assert!(verify_sha("abc", "abd").is_err());
    }

    #[test]
    fn hex_matches_known_sha256() {
        assert_eq!(
            hex(&sha2::Sha256::digest(b"hello")),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn promote_makes_the_dir_ready_and_replaces_an_existing_one() {
        let t = tempfile::tempdir().unwrap();
        let staging = t.path().join("staging");
        let node = node_exe(&staging);
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();
        std::fs::write(&node, "x").unwrap();
        let cli = cli_entry(&staging);
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, "x").unwrap();

        assert!(!is_ready(&staging));
        let dir = t.path().join("key");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stale-file"), "old").unwrap();
        promote(&staging, &dir).unwrap();
        assert!(is_ready(&dir));
        assert!(key_ready(t.path(), "key"));
        assert!(!dir.join("stale-file").exists());
        assert!(!staging.exists());
        assert!(!t.path().join(".old-key").exists());
    }

    #[test]
    fn remove_stale_deletes_old_runtimes_and_leftovers_but_keeps_the_current_one() {
        let t = tempfile::tempdir().unwrap();
        for d in ["keep", "old-key", ".staging-x", ".old-keep"] {
            std::fs::create_dir_all(t.path().join(d)).unwrap();
        }
        std::fs::write(t.path().join(".download-x.zip"), b"").unwrap();
        remove_stale(t.path(), "keep");
        let mut left: Vec<_> = std::fs::read_dir(t.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["keep".to_string()]);
    }

    #[test]
    fn runtime_key_combines_cli_and_node_versions() {
        let cfg = Config {
            node_version: "22.23.2".into(),
            node_win64_sha256: None,
            node_macos_arm64_sha256: None,
            cli_package: "@codemieai/code".into(),
            cli_version: "0.15.7".into(),
        };
        assert_eq!(runtime_key(&cfg), "0.15.7-node22.23.2");
    }

    #[cfg(windows)]
    #[test]
    fn the_config_is_complete() {
        let cfg = config();
        assert!(!cfg.node_version.is_empty(), "nodeVersion must be set");
        assert_eq!(cfg.node_sha256().len(), 64, "SHA-256 must be 64 hex chars");
        assert!(!cfg.cli_package.is_empty(), "cliPackage must be set");
        assert!(!cfg.cli_version.is_empty(), "cliVersion must be set");
    }

    /// Serves `body` once on a local port; returns its URL.
    fn serve_once(body: &'static [u8]) -> String {
        use std::io::Read;
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(body);
            }
        });
        format!("http://127.0.0.1:{port}/a.zip")
    }

    fn local_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn a_download_with_the_wrong_sha_is_rejected_and_leaves_no_file() {
        let t = tempfile::tempdir().unwrap();
        let archive = t.path().join(".download-k.zip");
        let url = serve_once(b"hello");
        let r =
            download_verified(&local_client(), &url, &archive, &"0".repeat(64), |_, _| {}).await;
        assert!(r.is_err());
        assert!(!archive.exists());
    }

    #[tokio::test]
    async fn a_download_with_the_right_sha_is_kept() {
        let t = tempfile::tempdir().unwrap();
        let archive = t.path().join("a.zip");
        let url = serve_once(b"hello");
        let sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        download_verified(&local_client(), &url, &archive, sha, |_, _| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&archive).unwrap(), b"hello");
    }

    #[tokio::test]
    async fn a_failed_request_leaves_no_file() {
        let t = tempfile::tempdir().unwrap();
        let archive = t.path().join("a.zip");
        let r = download_verified(
            &local_client(),
            "http://127.0.0.1:1/x",
            &archive,
            "0",
            |_, _| {},
        )
        .await;
        assert!(r.is_err());
        assert!(!archive.exists());
    }
}
