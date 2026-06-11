// macOS install operations. Port of src/main/installer-macos.js.
use std::process::Stdio;

use tauri::{AppHandle, Emitter};

use crate::error::{CmdResult, InstallerError};

// Used only if the live LTS lookup fails (offline / index unreachable).
const FALLBACK_NODE_VERSION: &str = "24.16.0";

/// The OS temp dir — download destination for the Node .pkg (replaces app.getPath('temp')).
#[tauri::command]
pub fn temp_dir() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
}

/// Build the official universal Node .pkg URL. The macOS Node installer is a single
/// universal .pkg (Intel + Apple Silicon), so the URL does not depend on arch.
#[tauri::command]
pub fn node_pkg_url(arch: String, version: String) -> String {
    let _ = arch; // intentionally unused — universal installer
    let v = version.strip_prefix('v').unwrap_or(&version);
    format!("https://nodejs.org/dist/v{v}/node-v{v}.pkg")
}

/// Resolve the newest Node.js LTS version from the official dist index,
/// falling back to FALLBACK_NODE_VERSION when offline.
#[tauri::command]
pub async fn latest_lts_node_version() -> String {
    fetch_lts().await.unwrap_or_else(|| FALLBACK_NODE_VERSION.to_string())
}

async fn fetch_lts() -> Option<String> {
    let idx: serde_json::Value = reqwest::get("https://nodejs.org/dist/index.json")
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    for v in idx.as_array()? {
        let is_lts = matches!(
            v.get("lts"),
            Some(serde_json::Value::String(_)) | Some(serde_json::Value::Bool(true))
        );
        if is_lts {
            if let Some(ver) = v.get("version").and_then(|x| x.as_str()) {
                return Some(ver.strip_prefix('v').unwrap_or(ver).to_string());
            }
        }
    }
    None
}

/// Run a command with administrator privileges via osascript (native auth dialog).
/// Replaces @vscode/sudo-prompt; requires no entitlements on an unsigned app.
fn sudo_exec(cmd: &str) -> CmdResult<String> {
    let escaped = cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("do shell script \"{escaped}\" with administrator privileges");
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| InstallerError::Sudo(e.to_string()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(InstallerError::Sudo(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ))
    }
}

/// Install a downloaded Node .pkg system-wide (requires admin auth).
#[tauri::command]
pub async fn install_node(pkg_path: String) -> CmdResult<bool> {
    let cmd = format!("installer -pkg \"{pkg_path}\" -target /");
    tokio::task::spawn_blocking(move || sudo_exec(&cmd))
        .await
        .map_err(|e| InstallerError::Other(e.to_string()))??;
    Ok(true)
}

/// Trigger the Xcode Command Line Tools GUI installer (which provides Git), then poll
/// until `git` becomes available. Emits human-readable ticks via `engine:git-tick`.
#[tauri::command]
pub async fn install_git_clt(app: AppHandle) -> bool {
    let _ = std::process::Command::new("xcode-select")
        .arg("--install")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let _ = app.emit("engine:git-tick", "Opening the Command Line Tools installer…");

    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(20 * 60);
    loop {
        if let Ok(out) = std::process::Command::new("git").arg("--version").output() {
            if out.status.success()
                && String::from_utf8_lossy(&out.stdout)
                    .to_lowercase()
                    .contains("git version")
            {
                let _ = app.emit("engine:git-tick", "Git is now available.");
                return true;
            }
        }
        if start.elapsed() > timeout {
            let _ = app.emit("engine:git-tick", "Timed out waiting for the Command Line Tools.");
            return false;
        }
        let _ = app.emit(
            "engine:git-tick",
            "Waiting for the Command Line Tools to finish installing…",
        );
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from test/installer.test.js.
    #[test]
    fn node_pkg_url_builds_official_universal_url() {
        assert_eq!(
            node_pkg_url("arm64".into(), "24.15.0".into()),
            "https://nodejs.org/dist/v24.15.0/node-v24.15.0.pkg"
        );
    }

    #[test]
    fn node_pkg_url_is_arch_independent() {
        assert_eq!(
            node_pkg_url("x64".into(), "24.15.0".into()),
            node_pkg_url("arm64".into(), "24.15.0".into())
        );
    }
}
