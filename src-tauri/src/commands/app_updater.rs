use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{CmdResult, InstallerError};
use crate::state::AppState;

const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

fn should_check(last: Option<Instant>, interval: Duration) -> bool {
    match last {
        None => true,
        Some(t) => t.elapsed() >= interval,
    }
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let last = *state.last_update_check.lock().unwrap();
    if !should_check(last, CHECK_INTERVAL) {
        return Ok(None);
    }

    let updater = app
        .updater()
        .map_err(|e| InstallerError::Other(format!("Update check failed: {e}")))?;

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            *state.last_update_check.lock().unwrap() = Some(Instant::now());
            Ok(Some(version))
        }
        Ok(None) => {
            *state.last_update_check.lock().unwrap() = Some(Instant::now());
            Ok(None)
        }
        Err(e) => Err(InstallerError::Other(format!("Update check failed: {e}"))),
    }
}

#[tauri::command]
pub async fn download_and_install(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<()> {
    let updater = app
        .updater()
        .map_err(|e| InstallerError::Other(format!("Update check failed: {e}")))?;

    let update = updater
        .check()
        .await
        .map_err(|e| InstallerError::Other(format!("Update check failed: {e}")))?
        .ok_or_else(|| InstallerError::Other("No update available".to_string()))?;

    // Reset throttle so the next boot re-checks after the new version is running.
    *state.last_update_check.lock().unwrap() = None;

    let app_clone = app.clone();
    let id_clone = id.clone();

    update
        .download_and_install(
            move |downloaded, total| {
                let percent = total
                    .map(|t| ((downloaded as f64 / t as f64) * 100.0) as u8)
                    .unwrap_or(0u8);
                let _ = app_clone.emit(
                    "engine:update-progress",
                    serde_json::json!({ "id": id_clone, "percent": percent }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| InstallerError::Other(format!("Update install failed: {e}")))
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
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
    fn error_serialises_to_string() {
        let e = InstallerError::Other("update failed".to_string());
        assert_eq!(e.to_string(), "update failed");
    }
}
