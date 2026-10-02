// Node and the CLI tree are not inside the app. On first launch they are
// downloaded as one pinned, checksummed archive into
// ~/Library/Application Support/CodeMie/runtime/<key>/, with the layout the
// bundle used to have under Resources (node/bin/node, cli/node_modules/...).
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::error::{CmdResult, InstallerError};

/// What scripts/pack-runtime.sh produced for this build: the folder key (one per
/// CLI and Node pair), where the archive is published and its checksum. Baked
/// in at compile time, so the app only ever accepts the archive it was built with.
#[derive(serde::Deserialize, Clone)]
pub struct Pack {
    pub key: String,
    pub url: String,
    pub sha256: String,
}

#[cfg(target_os = "macos")]
const PACK_JSON: &str = include_str!("../../../assets/macos/runtime-pack.json");
#[cfg(not(target_os = "macos"))]
const PACK_JSON: &str = r#"{"key":"","url":"","sha256":""}"#;

const COMPLETE_MARKER: &str = ".complete";

pub fn pack() -> Pack {
    serde_json::from_str(PACK_JSON).expect("assets/macos/runtime-pack.json is malformed")
}

pub fn runtime_base(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("CodeMie")
        .join("runtime")
}

pub fn runtime_dir(home: &Path) -> PathBuf {
    runtime_base(home).join(pack().key)
}

pub fn node_exe(dir: &Path) -> PathBuf {
    dir.join("node").join("bin").join("node")
}

pub fn cli_entry(dir: &Path) -> PathBuf {
    dir.join("cli")
        .join("node_modules")
        .join("@codemieai")
        .join("code")
        .join("bin")
        .join("codemie.js")
}

/// Ready only when the last step of an install (the marker) happened, so a
/// download or unpack that was cut off half way is never used.
pub fn is_ready(dir: &Path) -> bool {
    dir.join(COMPLETE_MARKER).is_file() && node_exe(dir).is_file() && cli_entry(dir).is_file()
}

fn home() -> CmdResult<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| InstallerError::Other("HOME is not set".into()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether the app can go on without a download: the user has their own CLI,
/// a smoke launch must never sit on the overlay, Windows still bundles its
/// runtime, or the runtime is in place.
fn ready(existing_cli: bool, smoke: bool, dir_ready: bool) -> bool {
    existing_cli || smoke || !cfg!(target_os = "macos") || dir_ready
}

fn smoke_mode() -> bool {
    std::env::var_os("CODEMIE_SMOKE").is_some() || std::env::var_os("CODEMIE_PROBE_SMOKE").is_some()
}

/// True when nothing has to be downloaded: the runtime is in place, or the user
/// has their own CLI, which the app uses instead (EPMCDME-14581).
#[tauri::command]
pub fn runtime_ready(state: tauri::State<'_, crate::state::AppState>) -> CmdResult<bool> {
    Ok(ready(
        state.existing_cli_detected,
        smoke_mode(),
        is_ready(&runtime_dir(&home()?)),
    ))
}

/// Downloads, verifies and unpacks the runtime archive unless it is already in
/// place. Emits `runtime:progress` with `{ phase, fraction, total }`.
#[tauri::command]
pub async fn ensure_runtime(app: AppHandle) -> CmdResult<String> {
    let home = home()?;
    let dir = runtime_dir(&home);
    if is_ready(&dir) {
        return Ok(dir.to_string_lossy().into_owned());
    }
    let pack = pack();
    let base = runtime_base(&home);
    tokio::fs::create_dir_all(&base).await?;

    // CODEMIE_RUNTIME_URL is for testing against a local server only.
    let url = std::env::var("CODEMIE_RUNTIME_URL").unwrap_or_else(|_| pack.url.clone());
    let archive = base.join(format!(".download-{}.tar.gz", pack.key));
    let staging = base.join(format!(".staging-{}", pack.key));
    // Leftovers of a launch that was quit mid-download or mid-unpack.
    let _ = tokio::fs::remove_file(&archive).await;
    let _ = tokio::fs::remove_dir_all(&staging).await;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
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
                serde_json::json!({ "phase": "download", "fraction": done as f64 / total as f64, "total": total }),
            );
        }
    }
    file.flush().await?;
    drop(file);

    let got = hex(&hasher.finalize());
    if got != pack.sha256 {
        let _ = tokio::fs::remove_file(&archive).await;
        return Err(InstallerError::Download(format!(
            "the downloaded file is damaged (checksum {got}, expected {})",
            pack.sha256
        )));
    }

    let _ = app.emit(
        "runtime:progress",
        serde_json::json!({ "phase": "unpack", "fraction": 1.0 }),
    );
    tokio::fs::create_dir_all(&staging).await?;
    let out = tokio::process::Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(&staging)
        .output()
        .await?;
    let _ = tokio::fs::remove_file(&archive).await;
    if !out.status.success() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(InstallerError::Other(format!(
            "unpack failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    if !node_exe(&staging).is_file() || !cli_entry(&staging).is_file() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(InstallerError::Other(
            "the downloaded file is missing Node or the CLI".into(),
        ));
    }
    tokio::fs::write(staging.join(COMPLETE_MARKER), &pack.key).await?;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::rename(&staging, &dir).await?;

    // Older runtimes left by a previous app version.
    if let Ok(mut entries) = tokio::fs::read_dir(&base).await {
        while let Ok(Some(e)) = entries.next_entry().await {
            if e.file_name().to_string_lossy() != pack.key {
                let _ = tokio::fs::remove_dir_all(e.path()).await;
            }
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_ready_without_marker_even_with_files() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        std::fs::create_dir_all(node_exe(d).parent().unwrap()).unwrap();
        std::fs::write(node_exe(d), "x").unwrap();
        std::fs::create_dir_all(cli_entry(d).parent().unwrap()).unwrap();
        std::fs::write(cli_entry(d), "x").unwrap();
        assert!(!is_ready(d));
        std::fs::write(d.join(COMPLETE_MARKER), "k").unwrap();
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
    fn the_baked_pack_is_complete() {
        let p = pack();
        assert!(!p.key.is_empty() && p.url.starts_with("https://") && p.sha256.len() == 64);
        assert!(p.url.contains(&p.key));
    }

    #[test]
    fn hex_matches_known_sha256() {
        assert_eq!(
            hex(&Sha256::digest(b"hello")),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}
