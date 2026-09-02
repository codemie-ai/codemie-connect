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
) -> CmdResult<String> {
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

    let total = resp.content_length().unwrap_or(0);
    let mut done: u64 = 0;
    let mut bytes: Vec<u8> = if total > 0 {
        Vec::with_capacity(total as usize)
    } else {
        Vec::new()
    };
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| InstallerError::Download(e.to_string()))?;
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

    verify_download(&bytes, None)?;
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
}
