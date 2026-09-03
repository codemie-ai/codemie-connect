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

fn parse_npm_latest(data: &serde_json::Value) -> Option<String> {
    data.get("dist-tags")
        .and_then(|d| d.get("latest"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

async fn fetch_codemie_npm_latest() -> Option<String> {
    let data: serde_json::Value = reqwest::Client::new()
        .get("https://registry.npmjs.org/@codemieai/code")
        .header("Accept", "application/vnd.npm.install-v1+json")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    parse_npm_latest(&data)
}

/// Return the latest published version of @codemieai/code from the npm registry,
/// or an empty string when offline or the fetch fails.
#[tauri::command]
pub async fn fetch_codemie_latest() -> String {
    fetch_codemie_npm_latest().await.unwrap_or_default()
}

// ---- tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_npm_latest_extracts_version_from_dist_tags() {
        let json = serde_json::json!({
            "name": "@codemieai/code",
            "dist-tags": { "latest": "0.5.0", "next": "0.6.0-beta" }
        });
        assert_eq!(parse_npm_latest(&json), Some("0.5.0".to_string()));
    }

    #[test]
    fn parse_npm_latest_returns_none_on_missing_dist_tags() {
        let json = serde_json::json!({ "name": "@codemieai/code" });
        assert_eq!(parse_npm_latest(&json), None);
    }

    #[test]
    fn parse_npm_latest_returns_none_on_missing_latest_key() {
        let json = serde_json::json!({ "dist-tags": { "next": "0.6.0-beta" } });
        assert_eq!(parse_npm_latest(&json), None);
    }

    #[tokio::test]
    async fn fetch_codemie_latest_returns_version_or_empty_string() {
        // fetch_codemie_latest wraps fetch_codemie_npm_latest with unwrap_or_default().
        // In an offline or CI environment it returns ""; in an online environment it
        // returns the latest semver from the npm registry. Both outcomes are valid.
        // This test validates the function's contract: String return, no panic.
        let result = fetch_codemie_latest().await;
        assert!(
            result.is_empty() || result.split('.').count() >= 2,
            "expected a semver-like version string or empty string, got: {result}"
        );
    }
}
