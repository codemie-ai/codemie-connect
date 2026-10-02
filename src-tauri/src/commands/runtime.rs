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

pub fn verify_sha(got_hex: &str, expected: &str) -> CmdResult<()> {
    if got_hex == expected {
        return Ok(());
    }
    Err(InstallerError::Download(format!(
        "the downloaded file is damaged (checksum {got_hex}, expected {expected})"
    )))
}

/// Unpacks into `staging` and checks Node and the CLI are in it. On any
/// failure `staging` is removed, so a cut-off archive leaves nothing behind.
pub fn unpack(archive: &Path, staging: &Path) -> CmdResult<()> {
    let result = (|| {
        std::fs::create_dir_all(staging)?;
        let out = std::process::Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(staging)
            .output()?;
        if !out.status.success() {
            return Err(InstallerError::Other(format!(
                "unpack failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        if !node_exe(staging).is_file() || !cli_entry(staging).is_file() {
            return Err(InstallerError::Other(
                "the downloaded file is missing Node or the CLI".into(),
            ));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(staging);
    }
    result
}

/// Moves a verified staging tree into place. The marker is written inside
/// staging first and an existing `dir` is renamed aside rather than deleted
/// up front, so a crash never leaves `dir` without a complete runtime.
pub fn promote(staging: &Path, dir: &Path) -> CmdResult<()> {
    let key = dir.file_name().unwrap_or_default().to_string_lossy();
    let aside = dir.with_file_name(format!(".old-{key}"));
    std::fs::write(staging.join(COMPLETE_MARKER), key.as_bytes())?;
    let _ = std::fs::remove_dir_all(&aside);
    if dir.exists() {
        std::fs::rename(dir, &aside)?;
    }
    std::fs::rename(staging, dir)?;
    let _ = std::fs::remove_dir_all(&aside);
    Ok(())
}

/// Removes everything in `base` but the current runtime: older runtimes left
/// by a previous app version and any download or staging leftovers.
pub fn remove_stale(base: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy() != keep {
            let p = e.path();
            let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
        }
    }
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
    let archive = base.join(format!(".download-{}.tar.gz", pack.key));
    let staging = base.join(format!(".staging-{}", pack.key));
    let result = install(&app, &pack, &base, &dir, &archive, &staging).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&archive).await;
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result.map(|()| dir.to_string_lossy().into_owned())
}

async fn install(
    app: &AppHandle,
    pack: &Pack,
    base: &Path,
    dir: &Path,
    archive: &Path,
    staging: &Path,
) -> CmdResult<()> {
    // CODEMIE_RUNTIME_URL is for testing against a local server only.
    let url = std::env::var("CODEMIE_RUNTIME_URL").unwrap_or_else(|_| pack.url.clone());
    // Leftovers of a launch that was quit mid-download or mid-unpack.
    let _ = tokio::fs::remove_file(archive).await;
    let _ = tokio::fs::remove_dir_all(staging).await;

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
    let mut file = tokio::fs::File::create(archive).await?;
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
    verify_sha(&hex(&hasher.finalize()), &pack.sha256)?;

    let _ = app.emit(
        "runtime:progress",
        serde_json::json!({ "phase": "unpack", "fraction": 1.0 }),
    );
    let (archive, staging, dir, base, key) = (
        archive.to_path_buf(),
        staging.to_path_buf(),
        dir.to_path_buf(),
        base.to_path_buf(),
        pack.key.clone(),
    );
    tokio::task::spawn_blocking(move || {
        let r = unpack(&archive, &staging);
        let _ = std::fs::remove_file(&archive);
        r?;
        promote(&staging, &dir)?;
        remove_stale(&base, &key);
        Ok(())
    })
    .await
    .map_err(|e| InstallerError::Other(e.to_string()))?
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

    /// A tar.gz with the given files (relative paths), built with the system tar.
    fn make_archive(dir: &Path, files: &[&str]) -> PathBuf {
        let src = dir.join("src");
        for f in files {
            let p = src.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        let archive = dir.join("a.tar.gz");
        let st = std::process::Command::new("/usr/bin/tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&src)
            .arg(".")
            .status()
            .unwrap();
        assert!(st.success());
        archive
    }

    const NODE: &str = "node/bin/node";
    const CLI: &str = "cli/node_modules/@codemieai/code/bin/codemie.js";

    #[test]
    fn verify_sha_accepts_equal_and_rejects_different() {
        assert!(verify_sha("abc", "abc").is_ok());
        assert!(verify_sha("abc", "abd").is_err());
    }

    #[test]
    fn unpack_extracts_a_complete_archive() {
        let t = tempfile::tempdir().unwrap();
        let archive = make_archive(t.path(), &[NODE, CLI]);
        let staging = t.path().join("staging");
        unpack(&archive, &staging).unwrap();
        assert!(node_exe(&staging).is_file() && cli_entry(&staging).is_file());
    }

    #[test]
    fn unpack_without_the_cli_entry_fails_and_leaves_no_staging() {
        let t = tempfile::tempdir().unwrap();
        let archive = make_archive(t.path(), &[NODE]);
        let staging = t.path().join("staging");
        assert!(unpack(&archive, &staging).is_err());
        assert!(!staging.exists());
    }

    #[test]
    fn unpack_of_a_truncated_archive_fails_and_leaves_no_staging() {
        let t = tempfile::tempdir().unwrap();
        let archive = make_archive(t.path(), &[NODE, CLI]);
        let bytes = std::fs::read(&archive).unwrap();
        std::fs::write(&archive, &bytes[..bytes.len() / 2]).unwrap();
        let staging = t.path().join("staging");
        assert!(unpack(&archive, &staging).is_err());
        assert!(!staging.exists());
    }

    #[test]
    fn promote_makes_the_dir_ready_and_replaces_an_existing_one() {
        let t = tempfile::tempdir().unwrap();
        let archive = make_archive(t.path(), &[NODE, CLI]);
        let staging = t.path().join("staging");
        unpack(&archive, &staging).unwrap();
        assert!(!is_ready(&staging));
        let dir = t.path().join("key");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stale-file"), "old").unwrap();
        promote(&staging, &dir).unwrap();
        assert!(is_ready(&dir));
        assert!(!dir.join("stale-file").exists());
        assert!(!staging.exists());
        assert!(!t.path().join(".old-key").exists());
    }

    #[test]
    fn remove_stale_deletes_old_runtimes_and_leftovers_but_keeps_the_current_one() {
        let t = tempfile::tempdir().unwrap();
        for d in [
            "keep",
            "old-key",
            ".staging-x",
            ".download-x.tar.gz",
            ".old-keep",
        ] {
            std::fs::create_dir_all(t.path().join(d)).unwrap();
        }
        remove_stale(t.path(), "keep");
        let left: Vec<_> = std::fs::read_dir(t.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["keep".to_string()]);
    }

    #[cfg(target_os = "macos")]
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
