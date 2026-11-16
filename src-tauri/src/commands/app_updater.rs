use futures_util::StreamExt;
use reqwest::Client;
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::error::{CmdResult, InstallerError};
use crate::state::AppState;

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

/// Launches the installer and lets the NSIS installer handle the rest (including uninstall).
#[cfg(target_os = "windows")]
fn launch_installer(installer_path: &str) -> CmdResult<()> {
    eprintln!("[app-updater] Launching installer: {}", installer_path);

    let mut child = Command::new(installer_path)
        // /S = silent; /R = relaunch the app afterwards (Tauri's NSIS template
        // only relaunches in silent mode when /R is passed). /UPDATE marks an
        // in-place update: the template forwards it to the old uninstaller, whose
        // hook then keeps the downloaded runtime instead of wiping it.
        .args(["/S", "/R", "/UPDATE"])
        .spawn()
        .map_err(|e| InstallerError::Other(format!("Failed to spawn installer: {e}")))?;

    // Give the installer a moment to start, then make sure it didn't die
    // immediately (corrupt exe, missing dependency, permission issue) — the
    // app is about to exit and release its file locks, so a launch failure
    // must be caught here or it goes unnoticed.
    std::thread::sleep(Duration::from_millis(500));
    check_not_exited_early(&mut child)
}

#[cfg(target_os = "windows")]
fn check_not_exited_early(child: &mut std::process::Child) -> CmdResult<()> {
    match child.try_wait() {
        Ok(Some(status)) if !status.success() => Err(InstallerError::Other(format!(
            "Installer exited immediately with status: {status}"
        ))),
        _ => Ok(()),
    }
}

/// A DMG cannot be run like the Windows setup exe. Mount it, swap the running
/// app's bundle for the one inside, and start the new app once this process
/// has exited.
#[cfg(target_os = "macos")]
fn launch_installer(installer_path: &str) -> CmdResult<()> {
    let exe = std::env::current_exe()?;
    let app = app_bundle_of(&exe).ok_or_else(|| {
        InstallerError::Other("CodeMie Connect is not running from an app bundle".to_string())
    })?;
    install_app_from_dmg(Path::new(installer_path), &app)?;

    // Wait for this process to exit, so the new app does not start next to the old one.
    Command::new("/bin/sh")
        .args([
            "-c",
            "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; open \"$2\"",
            "sh",
        ])
        .arg(std::process::id().to_string())
        .arg(&app)
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn app_bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn install_app_from_dmg(dmg: &Path, target: &Path) -> CmdResult<()> {
    let mount = std::env::temp_dir().join(format!("codemie-update-{}", std::process::id()));
    run_tool(
        Command::new("hdiutil")
            .args([
                "attach",
                "-nobrowse",
                "-readonly",
                "-noautoopen",
                "-mountpoint",
            ])
            .arg(&mount)
            .arg(dmg),
    )?;
    let result = replace_app_bundle(&mount, target);
    let _ = Command::new("hdiutil").arg("detach").arg(&mount).status();
    result
}

#[cfg(target_os = "macos")]
fn replace_app_bundle(mount: &Path, target: &Path) -> CmdResult<()> {
    let new_app = std::fs::read_dir(mount)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .ok_or_else(|| InstallerError::Other("The update has no app in it".to_string()))?;

    // Copy next to the installed app first, so a failed copy leaves it untouched.
    let staged = target.with_extension("app-update");
    let old = target.with_extension("app-old");
    let _ = std::fs::remove_dir_all(&staged);
    let _ = std::fs::remove_dir_all(&old);
    run_tool(Command::new("ditto").arg(&new_app).arg(&staged))?;

    std::fs::rename(target, &old)?;
    if let Err(e) = std::fs::rename(&staged, target) {
        let _ = std::fs::rename(&old, target);
        return Err(e.into());
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_tool(cmd: &mut Command) -> CmdResult<()> {
    let out = cmd.output()?;
    if out.status.success() {
        return Ok(());
    }
    Err(InstallerError::Other(format!(
        "{} failed: {}",
        cmd.get_program().to_string_lossy(),
        String::from_utf8_lossy(&out.stderr).trim()
    )))
}

/// Throttle interval between update checks (configurable via CODEMIE_UPDATE_CHECK_INTERVAL_SECS, dev-only)
fn check_interval() -> Duration {
    let secs = std::env::var("CODEMIE_UPDATE_CHECK_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(24 * 60 * 60);
    Duration::from_secs(secs)
}

const DEFAULT_BASE_URL: &str =
    "https://github.com/codemie-ai/codemie-connect/releases/latest/download";

/// Where the update manifest lives (configurable via CODEMIE_INSTALLER_BASE_URL).
fn get_base_url() -> String {
    base_url_from(std::env::var("CODEMIE_INSTALLER_BASE_URL").ok())
}

/// The override when one is set, the latest codemie-connect release otherwise.
/// Split out so the default is tested without touching the process env.
fn base_url_from(override_url: Option<String>) -> String {
    override_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// One manifest for every platform: the latest version and, per platform,
/// where its installer is.
fn get_manifest_url() -> String {
    format!("{}/manifest.json", get_base_url())
}

#[derive(serde::Deserialize, Clone)]
pub(crate) struct PlatformEntry {
    pub(crate) url: String,
}

#[derive(serde::Deserialize, Clone)]
pub(crate) struct Manifest {
    pub(crate) version: String,
    platforms: std::collections::HashMap<String, PlatformEntry>,
}

#[cfg(target_os = "windows")]
fn platform_key() -> &'static str {
    "windows-x86_64"
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn platform_key() -> &'static str {
    "darwin-x86_64"
}

#[cfg(not(any(
    target_os = "windows",
    all(target_os = "macos", target_arch = "x86_64")
)))]
fn platform_key() -> &'static str {
    "darwin-aarch64"
}

/// A manifest with a bad version offers no update.
fn parse_manifest(text: &str) -> CmdResult<Manifest> {
    let manifest: Manifest = serde_json::from_str(text)
        .map_err(|e| InstallerError::Other(format!("Failed to parse manifest: {e}")))?;
    if !is_valid_version(&manifest.version) {
        return Err(InstallerError::Other(format!(
            "Invalid version in manifest: {}",
            manifest.version
        )));
    }
    Ok(manifest)
}

fn get_platform_entry(manifest: &Manifest, platform: &str) -> CmdResult<PlatformEntry> {
    manifest.platforms.get(platform).cloned().ok_or_else(|| {
        InstallerError::Other(format!("No installer available for platform '{platform}'"))
    })
}

async fn fetch_manifest(client: &Client, url: &str) -> CmdResult<Manifest> {
    let text = client
        .get(url)
        .send()
        .await
        .map_err(|e| InstallerError::Other(format!("Failed to fetch manifest: {e}")))?
        .text()
        .await
        .map_err(|e| InstallerError::Other(format!("Failed to read manifest: {e}")))?;
    parse_manifest(&text)
}

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

fn should_check(last: Option<Instant>, interval: Duration) -> bool {
    match last {
        None => true,
        Some(t) => t.elapsed() >= interval,
    }
}

/// A forced check (About view) skips the 24h throttle; the boot check does not.
fn gate_allows(force: Option<bool>, last: Option<Instant>) -> bool {
    force.unwrap_or(false) || should_check(last, check_interval())
}

/// Validate that a version string is a valid semantic version (minimum: N.N.N, e.g., 2.1.0)
/// Also accepts 4+ part versions like N.N.N.N (e.g., 2.1.0.1)
fn is_valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    // Require at least 3 parts (MAJOR.MINOR.PATCH as minimum)
    if parts.len() < 3 {
        return false;
    }
    // All parts must be non-empty and contain only digits
    parts
        .iter()
        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Compare semantic versions: returns true if new_version > current_version
fn is_newer_version(current: &str, new: &str) -> bool {
    let current_parts: Vec<u32> = current.split('.').filter_map(|p| p.parse().ok()).collect();
    let new_parts: Vec<u32> = new.split('.').filter_map(|p| p.parse().ok()).collect();

    for i in 0..new_parts.len().max(current_parts.len()) {
        let new_part = new_parts.get(i).copied().unwrap_or(0);
        let current_part = current_parts.get(i).copied().unwrap_or(0);
        if new_part > current_part {
            return true;
        } else if new_part < current_part {
            return false;
        }
    }
    false
}

#[tauri::command]
pub async fn check_for_update(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> CmdResult<Option<String>> {
    let last = *state.last_update_check.lock().unwrap();
    if !gate_allows(force, last) {
        return Ok(None);
    }

    eprintln!(
        "[app-updater] Checking for updates at: {}",
        get_manifest_url()
    );

    let client = Client::new();
    match fetch_manifest(&client, &get_manifest_url()).await {
        Ok(manifest) => {
            *state.last_update_check.lock().unwrap() = Some(Instant::now());

            eprintln!(
                "[app-updater] Current version: {}, Latest available: {}",
                APP_VERSION, manifest.version
            );

            if is_newer_version(APP_VERSION, &manifest.version) {
                eprintln!(
                    "[app-updater] Update available: {} -> {}",
                    APP_VERSION, manifest.version
                );
                let version = manifest.version.clone();
                *state.latest_manifest.lock().unwrap() = Some(manifest);
                Ok(Some(version))
            } else {
                eprintln!("[app-updater] Already on latest version");
                *state.latest_manifest.lock().unwrap() = None;
                Ok(None)
            }
        }
        Err(e) => {
            // Mark as checked so a network problem or a bad manifest doesn't
            // retry on every boot; log it so field failures can be diagnosed.
            eprintln!("[app-updater] update check failed: {e}");
            *state.last_update_check.lock().unwrap() = Some(Instant::now());
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn download_and_install(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<()> {
    // Reset throttle so the next boot re-checks after the new version is running
    *state.last_update_check.lock().unwrap() = None;

    let app_clone = app.clone();
    let id_clone = id.clone();

    let client = Client::new();

    // Reuse the manifest `check_for_update` already fetched, if present; otherwise
    // (e.g. called without a preceding check) fetch it now.
    let cached_manifest = state.latest_manifest.lock().unwrap().clone();
    *state.latest_manifest.lock().unwrap() = None;
    let manifest = match cached_manifest {
        Some(manifest) => manifest,
        None => fetch_manifest(&client, &get_manifest_url()).await?,
    };

    eprintln!(
        "[app-updater] Latest version available: {}",
        manifest.version
    );

    let installer_url = get_platform_entry(&manifest, platform_key())?.url;
    eprintln!(
        "[app-updater] Downloading installer from: {}",
        installer_url
    );

    // Extract filename from URL (last part after /)
    let filename = installer_url
        .split('/')
        .next_back()
        .unwrap_or("installer.exe")
        .split('?')
        .next()
        .unwrap_or("installer.exe");

    let response = client
        .get(&installer_url)
        .send()
        .await
        .map_err(|e| InstallerError::Other(format!("Failed to download installer: {e}")))?;

    let total_size = response
        .content_length()
        .ok_or_else(|| InstallerError::Other("Unable to determine installer size".to_string()))?;

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut installer_bytes = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| InstallerError::Other(format!("Download error: {e}")))?;
        downloaded += chunk.len() as u64;
        installer_bytes.extend_from_slice(&chunk);

        // Emit progress
        let percent = ((downloaded as f64 / total_size as f64) * 100.0) as u8;
        let _ = app_clone.emit(
            "engine:update-progress",
            serde_json::json!({ "id": id_clone, "percent": percent }),
        );
    }

    // Save installer to temp directory with original filename
    let temp_dir = std::env::temp_dir();
    let installer_path = temp_dir.join(filename);

    std::fs::write(&installer_path, installer_bytes)
        .map_err(|e| InstallerError::Other(format!("Failed to save installer: {e}")))?;

    eprintln!(
        "[app-updater] Installer saved to: {}",
        installer_path.display()
    );

    // Launch the installer (NSIS/DMG will handle uninstall as part of its process)
    let installer_str = installer_path.to_string_lossy().to_string();

    // No checksum/signature verification here yet — deliberate, tracked gap
    // (no signing infra exists). See EPMCDME-15055 scope decision 1; a future
    // ticket adds verification of `installer_bytes` at this point, before launch.
    launch_installer(&installer_str)?;

    // Give the installer a moment to start
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Exit the app to release file locks and allow installer to proceed
    eprintln!("[app-updater] Exiting app to release file locks. Installer will proceed...");
    app.exit(0);

    Ok(())
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    eprintln!("[app-updater] Exiting app to let installer take over");
    // Don't call app.restart() — it crashes when the installer is running.
    // The NSIS installer will close the old app and launch the new one.
    // Exit via Tauri's API to allow proper cleanup.
    app.exit(0);
}

/// Get the current app version (for version-specific localStorage keys)
#[tauri::command]
pub fn get_app_version() -> String {
    APP_VERSION.to_string()
}

/// Get the update-check throttle interval in ms (for the JS-side localStorage gate)
#[tauri::command]
pub fn get_update_check_interval_ms() -> u64 {
    check_interval().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_when_no_prior_check() {
        assert!(should_check(None, Duration::from_secs(86400)));
    }

    #[test]
    fn blocks_when_check_is_recent() {
        let just_now = Instant::now();
        assert!(!should_check(Some(just_now), Duration::from_secs(86400)));
    }

    #[test]
    fn allows_when_interval_is_zero() {
        let just_now = Instant::now();
        assert!(should_check(Some(just_now), Duration::from_secs(0)));
    }

    #[test]
    fn throttle_fires_after_24h() {
        let past = Instant::now() - Duration::from_secs(1);
        assert!(should_check(Some(past), Duration::from_secs(1)));
    }

    #[test]
    fn force_bypasses_recent_check() {
        assert!(gate_allows(Some(true), Some(Instant::now())));
    }

    #[test]
    fn unforced_respects_recent_check() {
        assert!(!gate_allows(None, Some(Instant::now())));
        assert!(!gate_allows(Some(false), Some(Instant::now())));
        assert!(gate_allows(None, None));
    }

    #[test]
    fn version_comparison_basic() {
        assert!(is_newer_version("2.0.1", "2.2.1"));
        assert!(is_newer_version("2.0.1", "2.1.0"));
        assert!(is_newer_version("1.9.9", "2.0.0"));
        assert!(!is_newer_version("2.2.1", "2.0.1"));
        assert!(!is_newer_version("2.2.1", "2.2.1"));
    }

    #[test]
    fn version_comparison_edge_cases() {
        assert!(is_newer_version("1.0.0", "1.0.1"));
        assert!(is_newer_version("1.0.0", "1.1.0"));
        assert!(is_newer_version("0.0.1", "1.0.0"));
        assert!(!is_newer_version("2.0.0", "2.0.0"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn detects_installer_that_exited_immediately_with_failure() {
        let mut child = Command::new("cmd").args(["/C", "exit 1"]).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(check_not_exited_early(&mut child).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn allows_installer_still_running() {
        let mut child = Command::new("cmd")
            .args(["/C", "timeout /T 5"])
            .spawn()
            .unwrap();
        assert!(check_not_exited_early(&mut child).is_ok());
        let _ = child.kill();
    }

    #[test]
    fn error_serialises_to_string() {
        let e = InstallerError::Other("update failed".to_string());
        assert_eq!(e.to_string(), "update failed");
    }

    const MANIFEST: &str = r#"{
  "version": "2.1.1",
  "platforms": {
    "darwin-aarch64": { "url": "https://github.com/codemie-ai/codemie-connect/releases/download/v2.1.1/CodeMie-Connect-2.1.1-aarch64.dmg" },
    "darwin-x86_64": { "url": "https://github.com/codemie-ai/codemie-connect/releases/download/v2.1.1/CodeMie-Connect-2.1.1-x86_64.dmg" },
    "windows-x86_64": { "url": "https://github.com/codemie-ai/codemie-connect/releases/download/v2.1.1/CodeMie-Connect-2.1.1-x64-setup.exe" }
  }
}"#;

    #[test]
    fn manifest_gives_the_version_and_each_platforms_installer() {
        let m = parse_manifest(MANIFEST).unwrap();
        assert_eq!(m.version, "2.1.1");
        let url = |p| get_platform_entry(&m, p).unwrap().url;
        assert!(url("darwin-aarch64").ends_with("/CodeMie-Connect-2.1.1-aarch64.dmg"));
        assert!(url("darwin-x86_64").ends_with("/CodeMie-Connect-2.1.1-x86_64.dmg"));
        assert!(url("windows-x86_64").ends_with("/CodeMie-Connect-2.1.1-x64-setup.exe"));
    }

    #[test]
    fn manifest_without_this_platform_offers_no_update() {
        let m = parse_manifest(MANIFEST).unwrap();
        assert!(get_platform_entry(&m, "linux-x86_64").is_err());
        let empty = parse_manifest(r#"{"version":"9.9.9","platforms":{}}"#).unwrap();
        assert!(get_platform_entry(&empty, platform_key()).is_err());
    }

    #[test]
    fn manifest_with_a_bad_version_or_an_html_page_is_refused() {
        let bad = MANIFEST.replace("\"2.1.1\"", "\"latest\"");
        assert!(parse_manifest(&bad).is_err());
        assert!(parse_manifest("<!DOCTYPE html><html>404</html>").is_err());
    }

    #[test]
    fn manifest_is_read_from_the_latest_release_for_every_platform() {
        assert_eq!(
            DEFAULT_BASE_URL,
            "https://github.com/codemie-ai/codemie-connect/releases/latest/download"
        );
        assert_eq!(
            base_url_from(None),
            "https://github.com/codemie-ai/codemie-connect/releases/latest/download"
        );
        assert_eq!(
            base_url_from(Some("http://127.0.0.1:9/install".to_string())),
            "http://127.0.0.1:9/install"
        );
    }

    #[tokio::test]
    async fn manifest_is_fetched_over_http() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MANIFEST.len()
            );
            s.write_all(head.as_bytes()).await.unwrap();
            s.write_all(MANIFEST.as_bytes()).await.unwrap();
        });
        let url = format!("http://{addr}/manifest.json");
        let m = fetch_manifest(&Client::new(), &url).await.unwrap();
        assert_eq!(m.version, "2.1.1");
        let installer = get_platform_entry(&m, platform_key()).unwrap().url;
        assert!(installer.ends_with(match platform_key() {
            "windows-x86_64" => "x64-setup.exe",
            "darwin-x86_64" => "x86_64.dmg",
            _ => "aarch64.dmg",
        }));
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn this_mac_build_reads_the_arm64_entry() {
        assert_eq!(platform_key(), "darwin-aarch64");
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    #[test]
    fn this_mac_build_reads_the_intel_entry() {
        assert_eq!(platform_key(), "darwin-x86_64");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finds_the_app_bundle_the_binary_runs_from() {
        assert_eq!(
            app_bundle_of(Path::new(
                "/Applications/CodeMie Connect.app/Contents/MacOS/app"
            )),
            Some(Path::new("/Applications/CodeMie Connect.app").to_path_buf())
        );
        assert_eq!(
            app_bundle_of(Path::new("/repo/src-tauri/target/release/app")),
            None
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn replaces_the_app_bundle_with_the_one_in_the_dmg() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(src.join("New.app/Contents")).unwrap();
        std::fs::write(src.join("New.app/Contents/version"), "new").unwrap();
        let dmg = dir.path().join("update.dmg");
        let created = Command::new("hdiutil")
            .args([
                "create",
                "-quiet",
                "-fs",
                "HFS+",
                "-volname",
                "Update",
                "-srcfolder",
            ])
            .arg(&src)
            .arg(&dmg)
            .status()
            .unwrap();
        assert!(created.success());

        let target = dir.path().join("CodeMie Connect.app");
        std::fs::create_dir_all(target.join("Contents")).unwrap();
        std::fs::write(target.join("Contents/version"), "old").unwrap();
        std::fs::write(target.join("Contents/stale"), "").unwrap();

        install_app_from_dmg(&dmg, &target).unwrap();

        let version = std::fs::read_to_string(target.join("Contents/version")).unwrap();
        assert_eq!(version, "new");
        assert!(!target.join("Contents/stale").exists());
        let mut left: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        left.sort();
        assert_eq!(left, ["CodeMie Connect.app", "src", "update.dmg"]);
        let mounted = Command::new("hdiutil").arg("info").output().unwrap();
        let canonical = dmg.canonicalize().unwrap();
        assert!(!String::from_utf8_lossy(&mounted.stdout).contains(canonical.to_str().unwrap()));
    }
}
