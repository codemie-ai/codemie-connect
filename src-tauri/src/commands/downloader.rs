// File download with streaming progress. Port of src/main/downloader.js.
// reqwest follows redirects by default (nodejs.org / github releases use them).
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::error::{CmdResult, InstallerError};

/// Verify downloaded bytes: reject empty data, and when `expected_hash` is
/// supplied, compare it against the SHA-256 hex digest of `data`.
pub fn verify_download(data: &[u8], expected_hash: Option<&str>) -> Result<(), InstallerError> {
    if data.is_empty() {
        return Err(InstallerError::Download("downloaded file is empty".into()));
    }
    if let Some(want) = expected_hash {
        let got: String = Sha256::digest(data)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if got != want {
            return Err(InstallerError::Download(format!(
                "hash mismatch: expected {want}, got {got}"
            )));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn download_file(
    app: AppHandle,
    url: String,
    dest: String,
    progress_id: String,
    expected_sha256: Option<String>,
) -> CmdResult<String> {
    // CR-005: Validate destination to prevent path traversal.
    let dest_path = std::path::PathBuf::from(&dest);
    if !dest_path.is_absolute() {
        return Err(InstallerError::Download(
            "destination must be an absolute path".into(),
        ));
    }
    if dest_path
        .components()
        .any(|c| c == std::path::Component::ParentDir)
    {
        return Err(InstallerError::Download(
            "destination path must not contain '..' components".into(),
        ));
    }
    let safe_root = std::env::temp_dir();
    if !dest_path.starts_with(&safe_root) {
        return Err(InstallerError::Download(format!(
            "destination is outside the allowed download directory '{}'",
            safe_root.display()
        )));
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| InstallerError::Download(e.to_string()))?;

    let resp = client
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

    const MAX_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024; // 512 MB
    let total = resp.content_length().unwrap_or(0);
    let mut done: u64 = 0;
    let mut bytes: Vec<u8> = if total > 0 {
        Vec::with_capacity((total as usize).min(MAX_DOWNLOAD_BYTES))
    } else {
        Vec::new()
    };
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| InstallerError::Download(e.to_string()))?;
        if bytes.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
            return Err(InstallerError::Download(
                "download exceeds 512 MB limit".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
        done += chunk.len() as u64;
        if total > 0 {
            let fraction = done as f64 / total as f64;
            let _ = app.emit(
                "engine:download-progress",
                serde_json::json!({ "id": progress_id, "fraction": fraction }),
            );
        }
    }

    verify_download(&bytes, expected_sha256.as_deref())?;
    tokio::fs::write(&dest, &bytes).await?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_rejects_empty_data() {
        assert!(verify_download(&[], None).is_err());
    }

    #[test]
    fn verify_rejects_hash_mismatch() {
        assert!(verify_download(b"hello", Some("000000")).is_err());
    }

    #[test]
    fn verify_accepts_correct_sha256() {
        // SHA-256("hello")
        let h = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify_download(b"hello", Some(h)).is_ok());
    }

    #[test]
    fn verify_accepts_none_hash_nonempty() {
        assert!(verify_download(b"payload", None).is_ok());
    }

    // CR-005: path validation helpers — exercised through the guard logic directly
    // because calling the async command requires a full Tauri AppHandle fixture.

    fn path_is_safe(dest: &str) -> Result<(), InstallerError> {
        let dest_path = std::path::PathBuf::from(dest);
        if !dest_path.is_absolute() {
            return Err(InstallerError::Download(
                "destination must be an absolute path".into(),
            ));
        }
        if dest_path
            .components()
            .any(|c| c == std::path::Component::ParentDir)
        {
            return Err(InstallerError::Download(
                "destination path must not contain '..' components".into(),
            ));
        }
        let safe_root = std::env::temp_dir();
        if !dest_path.starts_with(&safe_root) {
            return Err(InstallerError::Download(format!(
                "destination is outside the allowed download directory '{}'",
                safe_root.display()
            )));
        }
        Ok(())
    }

    #[test]
    fn path_rejects_relative_path() {
        assert!(path_is_safe("relative/path/file.pkg").is_err());
    }

    #[test]
    fn path_rejects_parent_dir_component() {
        let tmp = std::env::temp_dir();
        // Construct a path that starts in temp but tries to escape via "..".
        let bad = tmp.join("..").join("etc").join("passwd");
        assert!(path_is_safe(&bad.to_string_lossy()).is_err());
    }

    #[test]
    fn path_rejects_outside_temp_dir() {
        // /etc/passwd (or C:\Windows\System32\...) is not inside temp_dir.
        #[cfg(unix)]
        let outside = "/etc/passwd";
        #[cfg(windows)]
        let outside = r"C:\Windows\System32\evil.exe";
        assert!(path_is_safe(outside).is_err());
    }

    #[test]
    fn path_accepts_file_inside_temp_dir() {
        let tmp = std::env::temp_dir();
        let good = tmp.join("codemie-installer-test.pkg");
        // This should pass the guard (no "..", is absolute, within temp).
        assert!(path_is_safe(&good.to_string_lossy()).is_ok());
    }
}
