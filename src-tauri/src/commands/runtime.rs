// Node and the CLI are not inside the app; they are installed on first launch.
// macOS: ~/Library/Application Support/CodeMie/runtime, `node`/`cli` symlinks
// into versioned dirs. Windows: %LOCALAPPDATA%\CodeMie\runtime\<key>\ (one
// dir per CLI+Node version, no symlinks, which need Developer Mode or admin).
// Both download Node from nodejs.org (pinned SHA-256) and install the pinned
// CLI from npm, and update the CLI in the background on later launches.
use tauri::AppHandle;

use crate::error::CmdResult;

#[cfg(not(windows))]
use mac as imp;
#[cfg(windows)]
use win as imp;

/// True when nothing has to be installed before the app can run the CLI.
#[tauri::command]
pub fn runtime_ready(state: tauri::State<'_, crate::state::AppState>) -> CmdResult<bool> {
    imp::runtime_ready(state.existing_cli_detected)
}

/// First launch (or an app update that pins a newer Node or CLI): installs what
/// is missing. Emits `runtime:progress`.
#[tauri::command]
pub async fn ensure_runtime(app: AppHandle) -> CmdResult<()> {
    imp::ensure_runtime(app).await
}

/// Called after the app is up: installs a newer CLI from npm, if there is one.
/// Returns the version it moved to.
#[tauri::command]
pub async fn update_cli(
    state: tauri::State<'_, crate::state::AppState>,
) -> CmdResult<Option<String>> {
    imp::update_cli(state.existing_cli_detected).await
}

#[cfg(not(windows))]
mod mac {
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
    const CLI_CHECK_TIMEOUT: Duration = Duration::from_secs(60);

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

    /// A path no other attempt uses. Quitting the app mid-install leaves its npm
    /// or tar running; with a fixed name the next launch would install into the
    /// same folder at the same time and could mark a half-written CLI complete.
    /// remove_stale drops the old attempt's folder at the next launch.
    fn attempt_path(base: &Path, kind: &str, name: &str, ext: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        base.join(format!(
            ".{kind}-{name}-{}-{nanos}{ext}",
            std::process::id()
        ))
    }

    /// The last non-empty line of `codemie --version` is the version; a first run
    /// in a new HOME prints migration notes above it.
    fn reports_version(stdout: &str, version: &str) -> bool {
        stdout.lines().rev().map(str::trim).find(|l| !l.is_empty()) == Some(version)
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
        let parse =
            |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
        parse(a) > parse(b)
    }

    /// Ready when both links point at finished installs, Node is the pinned one
    /// and the CLI is at least the pinned one (it may be newer after an update).
    pub fn is_ready(base: &Path, pins: &Pins) -> bool {
        let node_ok =
            linked_version(&node_link(base), "node-").as_deref() == Some(&pins.node_version);
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
        std::env::var_os("CODEMIE_SMOKE").is_some()
            || std::env::var_os("CODEMIE_PROBE_SMOKE").is_some()
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
    pub fn runtime_ready(existing_cli: bool) -> CmdResult<bool> {
        Ok(ready(
            existing_cli,
            smoke_mode(),
            is_ready(&runtime_base(&home()?), &pins()),
        ))
    }

    /// First launch (or an app update that pins a newer Node or CLI): installs what
    /// is missing and points the links at it. Emits `runtime:progress`.
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
    pub async fn update_cli(existing_cli: bool) -> CmdResult<Option<String>> {
        let result = check_and_update_cli(existing_cli).await;
        match &result {
            Ok(Some(v)) => {
                crate::commands::logger::write_line(&format!("CodeMie CLI updated to {v}"), "info")
            }
            Ok(None) => {}
            Err(e) => crate::commands::logger::write_line(
                &format!("CodeMie CLI update failed: {e}"),
                "warn",
            ),
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
        let staging = attempt_path(base, "staging", &name, "");
        let archive = attempt_path(base, "download", &name, ".tar.gz");
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
        let staging = attempt_path(base, "staging", &name, "");
        let result = async {
            let node = std::fs::canonicalize(node_link(base))?;
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
            // npm can report success on a tree that does not run. Start the CLI
            // once before it is marked complete; the marker above keeps it from
            // updating itself while doing so.
            let mut check = tokio::process::Command::new(node.join("bin").join("node"));
            check
                .arg(cli_entry(&staging))
                .arg("--version")
                .current_dir("/")
                .kill_on_drop(true);
            let ran = tokio::time::timeout(CLI_CHECK_TIMEOUT, check.output())
                .await
                .map_err(|_| InstallerError::Other("the installed CodeMie CLI did not start".into()))??;
            if !ran.status.success() || !reports_version(&String::from_utf8_lossy(&ran.stdout), version) {
                return Err(InstallerError::Other(format!(
                    "the installed CodeMie CLI does not start: {}",
                    String::from_utf8_lossy(&ran.stderr).lines().find(|l| l.contains("Error")).unwrap_or("").trim()
                )));
            }
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
        fn every_attempt_gets_its_own_folder() {
            let b = Path::new("/rt");
            let first = attempt_path(b, "staging", "cli-0.15.7", "");
            let second = attempt_path(b, "staging", "cli-0.15.7", "");
            assert_ne!(
                first, second,
                "a quit app's npm must never share the next launch's folder"
            );
            let name = first.file_name().unwrap().to_string_lossy().into_owned();
            assert!(name.starts_with(".staging-cli-0.15.7-"), "{name}");
            let archive = attempt_path(b, "download", "node-22.23.2", ".tar.gz");
            assert!(archive.to_string_lossy().ends_with(".tar.gz"));
        }

        #[cfg(unix)]
        #[test]
        fn remove_stale_drops_a_previous_attempts_folder() {
            let t = tempfile::tempdir().unwrap();
            let b = t.path();
            installed(b, "node-22.23.2", "node");
            installed(b, "cli-0.15.7", "cli");
            let old = attempt_path(b, "staging", "cli-0.15.7", "");
            std::fs::create_dir_all(old.join("node_modules")).unwrap();
            remove_stale(b);
            assert!(!old.exists());
            assert!(is_ready(b, &pins_for("22.23.2", "0.15.7")));
        }

        #[test]
        fn reports_version_reads_the_last_line() {
            assert!(reports_version("0.15.7\n", "0.15.7"));
            assert!(reports_version(
                "\n🔄 Running 2 migration(s)...\n[001-config-rename] done\n\n0.15.7\n",
                "0.15.7"
            ));
            assert!(!reports_version("0.15.6\n", "0.15.7"));
            assert!(!reports_version("", "0.15.7"));
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
}

#[cfg(windows)]
mod win {
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
    /// partial download or install is never used. npm.cmd is required so runtimes
    /// installed before it was extracted get reinstalled once.
    pub fn is_ready(dir: &Path) -> bool {
        dir.join(COMPLETE_MARKER).is_file()
            && node_exe(dir).is_file()
            && node_dir(dir).join("npm.cmd").is_file()
            && cli_entry(dir).is_file()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn ready(existing_cli: bool, smoke: bool, dir_ready: bool) -> bool {
        existing_cli || smoke || !cfg!(windows) || dir_ready
    }

    fn smoke_mode() -> bool {
        std::env::var_os("CODEMIE_SMOKE").is_some()
            || std::env::var_os("CODEMIE_PROBE_SMOKE").is_some()
    }

    /// True when nothing has to be downloaded: the runtime is in place, or the
    /// user has their own CLI (EPMCDME-14581).
    pub fn runtime_ready(existing_cli: bool) -> CmdResult<bool> {
        let dir_ready = cfg!(windows) && is_ready(&runtime_dir()?);
        Ok(ready(existing_cli, smoke_mode(), dir_ready))
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
                    serde_json::json!({ "phase": "node", "fraction": done as f64 / total as f64 * 0.3, "total": total }),
                );
            }
        })
        .await?;

        // Reuse the "unpack" phase label the UI already knows ("Unpacking…").
        let _ = app.emit(
            "runtime:progress",
            serde_json::json!({ "phase": "cli", "fraction": 0.35 }),
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
            .arg(format!("{prefix}/npm.cmd"))
            .arg(format!("{prefix}/npx.cmd"))
            .output()?;
        if !out.status.success() {
            return Err(InstallerError::Other(format!(
                "Node zip extraction failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(())
    }

    /// PATH with the runtime's node dir first. Dependency install scripts run
    /// through cmd.exe and call `node` / `npm` by name (keytar: `prebuild-install
    /// || npm run build`); without a system Node they are "not recognized".
    fn path_with(node_dir: &Path) -> std::ffi::OsString {
        let mut dirs = vec![node_dir.to_path_buf()];
        dirs.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
        std::env::join_paths(dirs).unwrap_or_default()
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
            .env("PATH", path_with(node_dir))
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
    pub async fn update_cli(existing_cli: bool) -> CmdResult<Option<String>> {
        if existing_cli {
            return Ok(None);
        }
        #[cfg(windows)]
        {
            let dir = match runtime_dir() {
                Ok(d) if is_ready(&d) => d,
                _ => return Ok(None),
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
                    .env("PATH", path_with(&node_dir(&dir)))
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
        Ok(None)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::Write;

        #[test]
        fn path_with_puts_the_runtime_node_first() {
            let p = path_with(Path::new(r"C:\rt\node"));
            let first = std::env::split_paths(&p).next().unwrap();
            assert_eq!(first, Path::new(r"C:\rt\node"));
        }

        #[test]
        fn not_ready_without_marker_even_with_files() {
            let t = tempfile::tempdir().unwrap();
            let d = t.path();
            std::fs::create_dir_all(node_exe(d).parent().unwrap()).unwrap();
            std::fs::write(node_exe(d), "x").unwrap();
            std::fs::create_dir_all(cli_entry(d).parent().unwrap()).unwrap();
            std::fs::write(cli_entry(d), "x").unwrap();
            std::fs::write(node_dir(d).join("npm.cmd"), "x").unwrap();
            assert!(!is_ready(d));
            std::fs::write(d.join(COMPLETE_MARKER), "k").unwrap();
            assert!(is_ready(d));
        }

        #[test]
        fn not_ready_without_npm_cmd() {
            let t = tempfile::tempdir().unwrap();
            let d = t.path();
            std::fs::create_dir_all(node_exe(d).parent().unwrap()).unwrap();
            std::fs::write(node_exe(d), "x").unwrap();
            std::fs::create_dir_all(cli_entry(d).parent().unwrap()).unwrap();
            std::fs::write(cli_entry(d), "x").unwrap();
            std::fs::write(d.join(COMPLETE_MARKER), "k").unwrap();
            assert!(!is_ready(d));
            std::fs::write(node_dir(d).join("npm.cmd"), "x").unwrap();
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
            std::fs::write(node_dir(&staging).join("npm.cmd"), "x").unwrap();

            assert!(!is_ready(&staging));
            let dir = t.path().join("key");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("stale-file"), "old").unwrap();
            promote(&staging, &dir).unwrap();
            assert!(is_ready(&dir));
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
            let r = download_verified(&local_client(), &url, &archive, &"0".repeat(64), |_, _| {})
                .await;
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
}
