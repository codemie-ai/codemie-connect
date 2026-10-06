// Install operations — shared platform utilities.
// macOS-specific acquisition functions (node_pkg_url, sudo_exec, install_node, install_git_clt)
// and Windows-specific acquisition functions (install_git_clt, download_to_file) have been removed;
// a bundled runtime now supplies all required tools.
use serde::Serialize;

// Used only if the live LTS lookup fails (offline / index unreachable).
const FALLBACK_NODE_VERSION: &str = "24.16.0";

// ---- platform info --------------------------------------------------------

#[derive(Serialize)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
}

/// Return the compile-time target OS and CPU architecture. Used by the JS
/// frontend to select platform-specific paths and file extensions at runtime.
#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(), // "macos" | "windows" | "linux"
        arch: std::env::consts::ARCH.to_string(), // "x86_64" | "aarch64"
    }
}

// ---- shared commands ------------------------------------------------------

/// The OS temp dir — download destination for installers.
#[tauri::command]
pub fn temp_dir() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
}

/// Resolve the newest Node.js LTS version from the official dist index,
/// falling back to FALLBACK_NODE_VERSION when offline.
#[tauri::command]
pub async fn latest_lts_node_version() -> String {
    fetch_lts()
        .await
        .unwrap_or_else(|| FALLBACK_NODE_VERSION.to_string())
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
