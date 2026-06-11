// File download with streaming progress. Port of src/main/downloader.js.
// reqwest follows redirects by default (nodejs.org / github releases use them).
use std::time::Duration;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::error::{CmdResult, InstallerError};

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
    let mut file = tokio::fs::File::create(&dest).await?;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| InstallerError::Download(e.to_string()))?;
        file.write_all(&chunk).await?;
        done += chunk.len() as u64;
        if total > 0 {
            let fraction = done as f64 / total as f64;
            let _ = app.emit(
                "engine:download-progress",
                serde_json::json!({ "id": progress_id, "fraction": fraction }),
            );
        }
    }
    file.flush().await?;
    Ok(dest)
}
