use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use reqwest::Client;
use std::process::Command;
use futures_util::StreamExt;

use crate::error::{CmdResult, InstallerError};
use crate::state::AppState;

/// Launches the installer and lets the NSIS/DMG installer handle the rest (including uninstall).
fn launch_installer(installer_path: &str) -> CmdResult<()> {
    eprintln!("[app-updater] Launching installer: {}", installer_path);
    
    Command::new(installer_path)
        .spawn()
        .map_err(|e| InstallerError::Other(format!("Failed to spawn installer: {e}")))?;

    Ok(())
}

const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Get the base URL for installer repository (platform-specific, configurable via env)
fn get_base_url() -> String {
    #[cfg(target_os = "windows")]
    {
        get_base_url_windows()
    }
    
    #[cfg(target_os = "macos")]
    {
        get_base_url_macos()
    }
}

/// Get the Windows installer base URL (configurable via CODEMIE_INSTALLER_BASE_URL_WINDOWS)
#[cfg(target_os = "windows")]
fn get_base_url_windows() -> String {
    std::env::var("CODEMIE_INSTALLER_BASE_URL_WINDOWS")
        .unwrap_or_else(|_| "https://github.com/codemie-ai/codemie-code/tree/main/install/windows".to_string())
}

/// Get the macOS installer base URL (configurable via CODEMIE_INSTALLER_BASE_URL_MACOS)
#[cfg(target_os = "macos")]
fn get_base_url_macos() -> String {
    std::env::var("CODEMIE_INSTALLER_BASE_URL_MACOS")
        .unwrap_or_else(|_| "https://github.com/codemie-ai/codemie-code/tree/main/install/macos".to_string())
}

/// Get the version.txt URL
fn get_version_url() -> String {
    format!("{}/version.txt", get_base_url())
}

/// Get the installer URL (looks for .exe on Windows, .dmg on macOS)
fn get_installer_url(version: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("{}/CodeMie%20Connect_{}_x64-setup.exe", get_base_url(), version)
    }
    
    #[cfg(target_os = "macos")]
    {
        format!("{}/CodeMie%20Connect_{}_x64.dmg", get_base_url(), version)
    }
}

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

fn should_check(last: Option<Instant>, interval: Duration) -> bool {
    match last {
        None => true,
        Some(t) => t.elapsed() >= interval,
    }
}

/// Compare semantic versions: returns true if new_version > current_version
fn is_newer_version(current: &str, new: &str) -> bool {
    let current_parts: Vec<u32> = current
        .split('.')
        .filter_map(|p| p.parse().ok())
        .collect();
    let new_parts: Vec<u32> = new
        .split('.')
        .filter_map(|p| p.parse().ok())
        .collect();

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
) -> CmdResult<Option<String>> {
    let last = *state.last_update_check.lock().unwrap();
    if !should_check(last, CHECK_INTERVAL) {
        return Ok(None);
    }

    // Fetch latest version from remote repository
    let version_url = get_version_url();
    eprintln!("[app-updater] Checking for updates at: {}", version_url);
    
    let client = Client::new();
    match client.get(&version_url).send().await {
        Ok(response) => {
            match response.text().await {
                Ok(version_text) => {
                    let latest_version = version_text.trim();
                    *state.last_update_check.lock().unwrap() = Some(Instant::now());

                    eprintln!("[app-updater] Current version: {}, Latest available: {}", APP_VERSION, latest_version);
                    
                    if is_newer_version(APP_VERSION, latest_version) {
                        eprintln!("[app-updater] Update available: {} -> {}", APP_VERSION, latest_version);
                        Ok(Some(latest_version.to_string()))
                    } else {
                        eprintln!("[app-updater] Already on latest version");
                        Ok(None)
                    }
                }
                Err(e) => Err(InstallerError::Other(format!("Failed to read version: {e}"))),
            }
        }
        Err(_e) => {
            // Silently fail and mark as checked — don't spam errors on network issues
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

    // First, fetch the latest version to construct the correct installer URL
    let version_url = get_version_url();
    eprintln!("[app-updater] Fetching version from: {}", version_url);
    
    let client = Client::new();
    let version_response = client
        .get(&version_url)
        .send()
        .await
        .map_err(|e| InstallerError::Other(format!("Failed to fetch version: {e}")))?;
    
    let version_text = version_response
        .text()
        .await
        .map_err(|e| InstallerError::Other(format!("Failed to read version: {e}")))?;
    
    let latest_version = version_text.trim();
    eprintln!("[app-updater] Latest version available: {}", latest_version);

    // Construct the installer URL based on the version
    let installer_url = get_installer_url(latest_version);
    eprintln!("[app-updater] Downloading installer from: {}", installer_url);
    
    // Extract filename from URL (last part after /)
    let filename = installer_url
        .split('/')
        .last()
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

    eprintln!("[app-updater] Installer saved to: {}", installer_path.display());

    // Launch the installer (NSIS/DMG will handle uninstall as part of its process)
    let installer_str = installer_path.to_string_lossy().to_string();
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

    #[test]
    fn error_serialises_to_string() {
        let e = InstallerError::Other("update failed".to_string());
        assert_eq!(e.to_string(), "update failed");
    }
}
