// Node and the CLI are not inside the app. On first launch the app downloads
// Node.js from nodejs.org (checked against the pinned SHA-256) and installs the
// pinned CLI from npm with the lock file written by scripts/stage-runtime.sh.
// Later launches update the CLI from npm in the background, so a new CLI never
// needs a new installer. Everything lives under
// ~/Library/Application Support/CodeMie/runtime:
//
//   node-<version>/   bin/node, lib/node_modules/npm
//   cli-<version>/    node_modules/@codemieai/code/...
//   node -> node-<version>, cli -> cli-<version>   (what the shim runs)
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::error::{CmdResult, InstallerError};

#[cfg(unix)]
use std::os::unix::fs::symlink;
#[cfg(windows)]
use std::os::windows::fs::symlink_dir as symlink;

const RUNTIME_JSON: &str = include_str!("../../../runtime.json");
// The CLI's exact dependency tree, so the first install is what was tested.
const CLI_PACKAGE_JSON: &str = include_str!("../../../assets/codemie-cli/package.json");
const CLI_PACKAGE_LOCK: &str = include_str!("../../../assets/codemie-cli/package-lock.json");
const COMPLETE_MARKER: &str = ".complete";
// Tells the CLI it is managed by CodeMie Connect, so its own self-update hands
// over to the app (codemie-code #598, CLI 0.15.7 and later).
const CONNECT_MARKER: &str = "{ \"managedBy\": \"CodeMie Connect\" }\n";
const REGISTRY_LATEST: &str = "https://registry.npmjs.org/@codemieai/code/latest";
const NPM_TIMEOUT: Duration = Duration::from_secs(600);

/// The pinned versions from runtime.json.
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pins {
    pub node_version: String,
    pub node_macos_arm64_sha256: String,
    pub cli_version: String,
}

pub fn pins() -> Pins {
    serde_json::from_str(RUNTIME_JSON).expect("runtime.json is malformed")
}

pub fn runtime_base(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("CodeMie")
        .join("runtime")
}

fn node_link(base: &Path) -> PathBuf {
    base.join("node")
}

fn cli_link(base: &Path) -> PathBuf {
    base.join("cli")
}

fn cli_entry(cli: &Path) -> PathBuf {
    cli.join("node_modules")
        .join("@codemieai")
        .join("code")
        .join("bin")
        .join("codemie.js")
}

fn complete(dir: &Path) -> bool {
    dir.join(COMPLETE_MARKER).is_file()
}

/// The version of the dir a link points at (`cli-0.15.7` -> `0.15.7`), only
/// when that dir finished installing.
fn linked_version(link: &Path, prefix: &str) -> Option<String> {
    let target = std::fs::read_link(link).ok()?;
    let name = target.file_name()?.to_string_lossy().into_owned();
    let version = name.strip_prefix(prefix)?.to_string();
    complete(&link.parent()?.join(&name)).then_some(version)
}

/// `a` is newer than `b`, comparing dot-separated numbers.
pub fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    parse(a) > parse(b)
}

/// Ready when both links point at finished installs, Node is the pinned one
/// and the CLI is at least the pinned one (it may be newer after an update).
pub fn is_ready(base: &Path, pins: &Pins) -> bool {
    let node_ok = linked_version(&node_link(base), "node-").as_deref() == Some(&pins.node_version);
    let cli_ok =
        linked_version(&cli_link(base), "cli-").is_some_and(|v| !newer(&pins.cli_version, &v));
    node_ok && cli_ok
}

/// Whether the app can go on without installing: the user has their own CLI,
/// a smoke launch must never sit on the overlay, Windows still bundles its
/// runtime, or the runtime is in place.
fn ready(existing_cli: bool, smoke: bool, dir_ready: bool) -> bool {
    existing_cli || smoke || !cfg!(target_os = "macos") || dir_ready
}

fn smoke_mode() -> bool {
    std::env::var_os("CODEMIE_SMOKE").is_some() || std::env::var_os("CODEMIE_PROBE_SMOKE").is_some()
}

fn home() -> CmdResult<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| InstallerError::Other("HOME is not set".into()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn verify_sha(got_hex: &str, expected: &str) -> CmdResult<()> {
    if got_hex == expected {
        return Ok(());
    }
    Err(InstallerError::Download(format!(
        "the downloaded Node.js is damaged (checksum {got_hex}, expected {expected})"
    )))
}

/// Points `link` at `target` (a sibling dir name) in one atomic rename, so the
/// shim never sees a missing link.
pub fn switch_link(link: &Path, target: &str) -> CmdResult<()> {
    let tmp = link.with_file_name(format!(
        ".{}.new",
        link.file_name().unwrap_or_default().to_string_lossy()
    ));
    let _ = std::fs::remove_file(&tmp);
    symlink(target, &tmp)?;
    std::fs::rename(&tmp, link)?;
    Ok(())
}

/// Removes everything in `base` the links do not point at: Node or CLI dirs a
/// newer one replaced, and leftovers of a launch quit mid-install. Runs at
/// launch only, so a CLI replaced during a session (and a proxy started from
/// it) is never pulled away while in use.
pub fn remove_stale(base: &Path) {
    let keep: Vec<String> = [node_link(base), cli_link(base)]
        .iter()
        .filter_map(|l| std::fs::read_link(l).ok())
        .filter_map(|t| t.file_name().map(|n| n.to_string_lossy().into_owned()))
        .chain(["node".to_string(), "cli".to_string()])
        .collect();
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !keep.contains(&name) {
            let p = e.path();
            let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
        }
    }
}

/// The HTTPS (else HTTP) proxy from the macOS network settings, as a URL npm
/// understands. npm reads env vars and .npmrc only, not the system settings.
pub fn mac_proxy(scutil: &str) -> Option<String> {
    let get = |k: &str| {
        scutil.lines().find_map(|l| {
            let (key, val) = l.split_once(" : ")?;
            (key.trim() == k).then(|| val.trim().to_string())
        })
    };
    for scheme in ["HTTPS", "HTTP"] {
        if get(&format!("{scheme}Enable")).as_deref() == Some("1") {
            let host = get(&format!("{scheme}Proxy"))?;
            let port = get(&format!("{scheme}Port")).unwrap_or_else(|| "80".into());
            return Some(format!("http://{host}:{port}"));
        }
    }
    None
}

fn client() -> CmdResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| InstallerError::Download(e.to_string()))
}

fn progress(app: &AppHandle, phase: &str, fraction: f64) {
    let _ = app.emit(
        "runtime:progress",
        serde_json::json!({ "phase": phase, "fraction": fraction }),
    );
}

/// True when nothing has to be installed before the app can run the CLI.
#[tauri::command]
pub fn runtime_ready(state: tauri::State<'_, crate::state::AppState>) -> CmdResult<bool> {
    Ok(ready(
        state.existing_cli_detected,
        smoke_mode(),
        is_ready(&runtime_base(&home()?), &pins()),
    ))
}

/// First launch (or an app update that pins a newer Node or CLI): installs what
/// is missing and points the links at it. Emits `runtime:progress`.
#[tauri::command]
pub async fn ensure_runtime(app: AppHandle) -> CmdResult<()> {
    let base = runtime_base(&home()?);
    let pins = pins();
    tokio::fs::create_dir_all(&base).await?;
    let b = base.clone();
    let _ = tokio::task::spawn_blocking(move || remove_stale(&b)).await;

    if linked_version(&node_link(&base), "node-").as_deref() != Some(&pins.node_version) {
        install_node(&app, &base, &pins).await?;
    }
    let cli_ok =
        linked_version(&cli_link(&base), "cli-").is_some_and(|v| !newer(&pins.cli_version, &v));
    if !cli_ok {
        progress(&app, "cli", 0.35);
        install_cli(&base, &pins.cli_version, true).await?;
    }
    Ok(())
}

/// Called after the app is up: installs a newer CLI from npm, if there is one,
/// and switches to it. Returns the version it moved to. The CLI the user had
/// stays in place until the next launch.
#[tauri::command]
pub async fn update_cli(
    state: tauri::State<'_, crate::state::AppState>,
) -> CmdResult<Option<String>> {
    let result = check_and_update_cli(state.existing_cli_detected).await;
    match &result {
        Ok(Some(v)) => {
            crate::commands::logger::write_line(&format!("CodeMie CLI updated to {v}"), "info")
        }
        Ok(None) => {}
        Err(e) => {
            crate::commands::logger::write_line(&format!("CodeMie CLI update failed: {e}"), "warn")
        }
    }
    result
}

async fn check_and_update_cli(existing_cli: bool) -> CmdResult<Option<String>> {
    if existing_cli || !cfg!(target_os = "macos") || smoke_mode() {
        return Ok(None);
    }
    let base = runtime_base(&home()?);
    // Every launch: drop what a previous update replaced. ensure_runtime does
    // the same, but it only runs when something has to be installed.
    let b = base.clone();
    let _ = tokio::task::spawn_blocking(move || remove_stale(&b)).await;
    let Some(current) = linked_version(&cli_link(&base), "cli-") else {
        return Ok(None);
    };
    let latest: serde_json::Value = client()?
        .get(REGISTRY_LATEST)
        .send()
        .await
        .map_err(|e| InstallerError::Download(e.to_string()))?
        .json()
        .await
        .map_err(|e| InstallerError::Download(e.to_string()))?;
    let Some(latest) = latest["version"].as_str().map(str::to_string) else {
        return Ok(None);
    };
    if !newer(&latest, &current) {
        return Ok(None);
    }
    install_cli(&base, &latest, false).await?;
    Ok(Some(latest))
}

async fn install_node(app: &AppHandle, base: &Path, pins: &Pins) -> CmdResult<()> {
    let v = &pins.node_version;
    let name = format!("node-{v}");
    let staging = base.join(format!(".staging-{name}"));
    let archive = base.join(format!(".download-{name}.tar.gz"));
    let result = async {
        let url = format!("https://nodejs.org/dist/v{v}/node-v{v}-darwin-arm64.tar.gz");
        let resp = client()?
            .get(&url)
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
        let mut file = tokio::fs::File::create(&archive).await?;
        let mut hasher = Sha256::new();
        let mut done: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| InstallerError::Download(e.to_string()))?;
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            done += chunk.len() as u64;
            if total > 0 {
                let _ = app.emit(
                    "runtime:progress",
                    serde_json::json!({ "phase": "node", "fraction": done as f64 / total as f64 * 0.3, "total": total }),
                );
            }
        }
        file.flush().await?;
        drop(file);
        verify_sha(&hex(&hasher.finalize()), &pins.node_macos_arm64_sha256)?;

        tokio::fs::create_dir_all(&staging).await?;
        let top = format!("node-v{v}-darwin-arm64");
        let out = tokio::process::Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&staging)
            .arg("--strip-components=1")
            .arg(format!("{top}/bin"))
            .arg(format!("{top}/lib/node_modules/npm"))
            .output()
            .await?;
        if !out.status.success() || !staging.join("bin").join("node").is_file() {
            return Err(InstallerError::Other(format!(
                "unpacking Node.js failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        tokio::fs::write(staging.join(COMPLETE_MARKER), v).await?;
        let _ = tokio::fs::remove_dir_all(base.join(&name)).await;
        tokio::fs::rename(&staging, base.join(&name)).await?;
        switch_link(&node_link(base), &name)
    }
    .await;
    let _ = tokio::fs::remove_file(&archive).await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result
}

/// Installs `version` of the CLI with the runtime's Node and npm, then points
/// the `cli` link at it. `locked` uses the shipped lock file (the pinned
/// version); a newer version resolves its dependencies from npm.
async fn install_cli(base: &Path, version: &str, locked: bool) -> CmdResult<()> {
    let name = format!("cli-{version}");
    let staging = base.join(format!(".staging-{name}"));
    let result = async {
        let node = std::fs::canonicalize(node_link(base))?;
        let _ = tokio::fs::remove_dir_all(&staging).await;
        tokio::fs::create_dir_all(&staging).await?;
        let args: &[&str] = if locked {
            tokio::fs::write(staging.join("package.json"), CLI_PACKAGE_JSON).await?;
            tokio::fs::write(staging.join("package-lock.json"), CLI_PACKAGE_LOCK).await?;
            &["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"]
        } else {
            tokio::fs::write(
                staging.join("package.json"),
                format!(
                    "{{\"name\":\"codemie-cli-bundle\",\"version\":\"0.0.0\",\"private\":true,\"dependencies\":{{\"@codemieai/code\":\"{version}\"}}}}\n"
                ),
            )
            .await?;
            &["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"]
        };
        let mut npm = tokio::process::Command::new(node.join("bin").join("node"));
        npm.arg(node.join("lib/node_modules/npm/bin/npm-cli.js"))
            .args(args)
            .current_dir(&staging)
            .env(
                "PATH",
                format!("{}:{}", node.join("bin").display(), std::env::var("PATH").unwrap_or_default()),
            )
            .env("npm_config_update_notifier", "false");
        let env_proxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
            .iter()
            .any(|k| std::env::var_os(k).is_some());
        if !env_proxy {
            if let Ok(o) = tokio::process::Command::new("/usr/sbin/scutil")
                .arg("--proxy")
                .output()
                .await
            {
                if let Some(proxy) = mac_proxy(&String::from_utf8_lossy(&o.stdout)) {
                    npm.env("npm_config_https_proxy", &proxy).env("npm_config_proxy", &proxy);
                }
            }
        }
        // npm retries on its own and can wait many minutes behind a dead proxy;
        // past this limit it is stopped and the user gets Try again.
        npm.kill_on_drop(true);
        let out = tokio::time::timeout(NPM_TIMEOUT, npm.output())
            .await
            .map_err(|_| {
                InstallerError::Other(
                    "installing the CodeMie CLI from npm took too long; check the network or proxy".into(),
                )
            })??;
        if !out.status.success() || !cli_entry(&staging).is_file() {
            let err = String::from_utf8_lossy(&out.stderr);
            let lines: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
            return Err(InstallerError::Other(format!(
                "installing the CodeMie CLI from npm failed: {}",
                lines[lines.len().saturating_sub(3)..].join(" ")
            )));
        }
        let pkg = cli_entry(&staging).parent().unwrap().parent().unwrap().to_path_buf();
        tokio::fs::write(pkg.join("codemie-connect.json"), CONNECT_MARKER).await?;
        tokio::fs::write(staging.join(COMPLETE_MARKER), version).await?;
        let _ = tokio::fs::remove_dir_all(base.join(&name)).await;
        tokio::fs::rename(&staging, base.join(&name)).await?;
        switch_link(&cli_link(base), &name)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pins_for(node: &str, cli: &str) -> Pins {
        Pins {
            node_version: node.into(),
            node_macos_arm64_sha256: "0".repeat(64),
            cli_version: cli.into(),
        }
    }

    /// A finished install named `name` under `base`, linked from `link`.
    #[cfg(unix)]
    fn installed(base: &Path, name: &str, link: &str) {
        std::fs::create_dir_all(base.join(name)).unwrap();
        std::fs::write(base.join(name).join(COMPLETE_MARKER), "x").unwrap();
        switch_link(&base.join(link), name).unwrap();
    }

    #[test]
    fn newer_compares_numbers_not_text() {
        assert!(newer("0.15.10", "0.15.7"));
        assert!(newer("0.16.0", "0.15.7"));
        assert!(!newer("0.15.7", "0.15.7"));
        assert!(!newer("0.15.2", "0.15.7"));
    }

    #[cfg(unix)]
    #[test]
    fn ready_only_when_both_links_point_at_finished_installs() {
        let t = tempfile::tempdir().unwrap();
        let b = t.path();
        let p = pins_for("22.23.2", "0.15.7");
        assert!(!is_ready(b, &p));
        installed(b, "node-22.23.2", "node");
        assert!(!is_ready(b, &p));
        installed(b, "cli-0.15.7", "cli");
        assert!(is_ready(b, &p));
    }

    #[cfg(unix)]
    #[test]
    fn a_dir_without_the_marker_is_never_used() {
        let t = tempfile::tempdir().unwrap();
        let b = t.path();
        installed(b, "node-22.23.2", "node");
        std::fs::create_dir_all(b.join("cli-0.15.7")).unwrap();
        switch_link(&b.join("cli"), "cli-0.15.7").unwrap();
        assert!(!is_ready(b, &pins_for("22.23.2", "0.15.7")));
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_updated_past_the_pin_stays_ready_an_older_one_does_not() {
        let t = tempfile::tempdir().unwrap();
        let b = t.path();
        installed(b, "node-22.23.2", "node");
        installed(b, "cli-0.15.9", "cli");
        assert!(is_ready(b, &pins_for("22.23.2", "0.15.7")));
        assert!(!is_ready(b, &pins_for("22.23.2", "0.16.0")));
    }

    #[cfg(unix)]
    #[test]
    fn a_new_node_pin_is_not_ready_until_installed() {
        let t = tempfile::tempdir().unwrap();
        let b = t.path();
        installed(b, "node-22.23.2", "node");
        installed(b, "cli-0.15.7", "cli");
        assert!(!is_ready(b, &pins_for("24.0.0", "0.15.7")));
    }

    #[cfg(unix)]
    #[test]
    fn switch_link_replaces_the_target() {
        let t = tempfile::tempdir().unwrap();
        let b = t.path();
        installed(b, "cli-0.15.7", "cli");
        installed(b, "cli-0.15.8", "cli");
        assert_eq!(
            linked_version(&b.join("cli"), "cli-").as_deref(),
            Some("0.15.8")
        );
    }

    #[cfg(unix)]
    #[test]
    fn remove_stale_keeps_only_what_the_links_point_at() {
        let t = tempfile::tempdir().unwrap();
        let b = t.path();
        installed(b, "node-22.23.2", "node");
        installed(b, "cli-0.15.7", "cli");
        installed(b, "cli-0.15.8", "cli");
        for d in [
            "node-20.0.0",
            ".staging-cli-0.15.9",
            ".download-node-22.23.2.tar.gz",
        ] {
            std::fs::create_dir_all(b.join(d)).unwrap();
        }
        remove_stale(b);
        let mut left: Vec<_> = std::fs::read_dir(b)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["cli", "cli-0.15.8", "node", "node-22.23.2"]);
    }

    #[test]
    fn ready_when_a_cli_already_exists_even_with_an_empty_dir() {
        assert!(ready(true, false, false));
    }

    #[test]
    fn ready_in_smoke_mode_so_the_overlay_never_blocks_it() {
        assert!(ready(false, true, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn not_ready_on_macos_without_cli_smoke_or_runtime() {
        assert!(!ready(false, false, false));
        assert!(ready(false, false, true));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn always_ready_off_macos() {
        assert!(ready(false, false, false));
    }

    #[test]
    fn verify_sha_accepts_equal_and_rejects_different() {
        assert!(verify_sha("abc", "abc").is_ok());
        assert!(verify_sha("abc", "abd").is_err());
    }

    #[test]
    fn mac_proxy_prefers_https_then_http() {
        let both = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : h.example\n  HTTPSEnable : 1\n  HTTPSPort : 3128\n  HTTPSProxy : s.example\n}";
        assert_eq!(mac_proxy(both).as_deref(), Some("http://s.example:3128"));
        let http =
            "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : h.example\n}";
        assert_eq!(mac_proxy(http).as_deref(), Some("http://h.example:8080"));
        assert_eq!(mac_proxy("<dictionary> {\n}"), None);
    }

    #[test]
    fn the_lock_pins_the_same_cli_as_runtime_json() {
        let lock: serde_json::Value = serde_json::from_str(CLI_PACKAGE_LOCK).unwrap();
        let v = &lock["packages"]["node_modules/@codemieai/code"]["version"];
        assert_eq!(v.as_str(), Some(pins().cli_version.as_str()));
        assert_eq!(pins().node_macos_arm64_sha256.len(), 64);
    }

    #[test]
    fn hex_matches_known_sha256() {
        assert_eq!(
            hex(&Sha256::digest(b"hello")),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}
