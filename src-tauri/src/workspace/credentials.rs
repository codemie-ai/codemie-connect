//! Connect-owned Microsoft session cache. No Keychain reads or implicit imports from other apps.
use super::models::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[derive(Serialize, Deserialize)]
pub(super) struct Credential {
    pub refresh: String,
    pub client_id: String,
    pub tenant: String,
}
fn cache_path(dir: &Path, cid: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(cid).map_err(|_| {
        WorkspaceError::new("credential_store", "Invalid Microsoft session identifier.")
    })?;
    Ok(dir.join("credentials").join(format!("graph-{cid}.json")))
}
#[cfg(unix)]
fn private_folder(dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if std::fs::symlink_metadata(dir).is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir()) {
        return Err(WorkspaceError::new(
            "credential_store",
            "Microsoft session-cache folder is unavailable.",
        ));
    }
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}
#[cfg(unix)]
fn save_file(dir: &Path, cid: &str, value: &[u8]) -> Result<()> {
    use std::{
        io::Write,
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
    };
    let path = cache_path(dir, cid)?;
    let folder = path
        .parent()
        .ok_or_else(|| WorkspaceError::new("credential_store", "Missing session folder."))?;
    private_folder(folder)?;
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
        return Err(WorkspaceError::new(
            "credential_store",
            "Microsoft session-cache destination is unavailable.",
        ));
    }
    let temp = folder.join(format!(".session-{}.tmp", id()));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(value)?;
        file.sync_all()?;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
        std::fs::rename(&temp, &path)?;
        std::fs::File::open(folder)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
#[cfg(unix)]
fn load_file(dir: &Path, cid: &str) -> Result<Vec<u8>> {
    use std::{io::Read, os::unix::fs::PermissionsExt};
    let path = cache_path(dir, cid)?;
    let metadata=std::fs::symlink_metadata(&path).map_err(|_|WorkspaceError::new("needs_login","Sign in with Microsoft in Settings to create a Connect-owned session. Existing credentials in other apps are untouched."))?;
    let parent = std::fs::symlink_metadata(path.parent().unwrap_or(dir))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.permissions().mode() & 0o077 != 0
        || parent.file_type().is_symlink()
        || parent.permissions().mode() & 0o077 != 0
    {
        return Err(WorkspaceError::new(
            "needs_login",
            "The Microsoft session cache is not private. Sign in again in Settings to replace it.",
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(65537)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        return Err(WorkspaceError::new(
            "needs_login",
            "The Microsoft session cache needs a new sign-in.",
        ));
    }
    Ok(bytes)
}
pub(super) fn save(dir: &Path, cid: &str, credential: &Credential) -> Result<()> {
    let _validated = cache_path(dir, cid)?;
    let value = serde_json::to_vec(credential)
        .map_err(|_| WorkspaceError::new("credential_store", "Cannot encode Microsoft session."))?;
    if value.len() > 65536 {
        return Err(WorkspaceError::new(
            "credential_store",
            "Microsoft session exceeds the supported cache size.",
        ));
    }
    #[cfg(unix)]
    save_file(dir, cid, &value)?;
    #[cfg(windows)]
    {
        windows_secret(dir, cid, Some(&value))?;
    }
    Ok(())
}
pub(super) fn load(dir: &Path, cid: &str) -> Result<Credential> {
    let _validated = cache_path(dir, cid)?;
    #[cfg(unix)]
    let value = load_file(dir, cid)?;
    #[cfg(windows)]
    let value = windows_secret(dir, cid, None)?;
    serde_json::from_slice(&value).map_err(|_| {
        WorkspaceError::new(
            "needs_login",
            "The Microsoft session cache needs a new sign-in.",
        )
    })
}
pub(super) fn delete(dir: &Path, cid: &str) -> Result<()> {
    let _validated = cache_path(dir, cid)?;
    #[cfg(unix)]
    let path = cache_path(dir, cid)?;
    #[cfg(windows)]
    let path = dir.join(format!("{cid}.credential"));
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(WorkspaceError::new(
            "credential_store",
            "Could not remove the Connect-owned Microsoft session cache. Retry disconnect.",
        )),
    }
}
#[cfg(windows)]
fn windows_secret(dir: &Path, cid: &str, input: Option<&[u8]>) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let path = dir.join(format!("{cid}.credential"));
    let encrypted = if input.is_none() {
        std::fs::read(&path)?
    } else {
        Vec::new()
    };
    let bytes = input.unwrap_or(&encrypted);
    let data = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if input.is_some() {
            CryptProtectData(
                &data,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &data,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(WorkspaceError::new(
            "credential_store",
            "Windows secure credential storage failed. No plaintext fallback is used.",
        ));
    }
    let value = unsafe {
        let v = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut _);
        v
    };
    if input.is_some() {
        let tmp = path.with_extension("pending");
        std::fs::write(&tmp, &value)?;
        std::fs::rename(tmp, path)?;
        Ok(Vec::new())
    } else {
        Ok(value)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn synthetic() -> Credential {
        Credential {
            refresh: "synthetic-refresh-token".into(),
            client_id: "synthetic-client".into(),
            tenant: "common".into(),
        }
    }
    #[test]
    fn private_cache_survives_restart_and_rotation_without_any_os_credential_api() {
        let d = tempfile::tempdir().unwrap();
        let cid = id();
        save(d.path(), &cid, &synthetic()).unwrap();
        let path = cache_path(d.path(), &cid).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            load(d.path(), &cid).unwrap().refresh,
            "synthetic-refresh-token"
        );
        let mut rotated = synthetic();
        rotated.refresh = "rotated-synthetic-token".into();
        save(d.path(), &cid, &rotated).unwrap();
        assert_eq!(
            load(d.path(), &cid).unwrap().refresh,
            "rotated-synthetic-token"
        );
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        delete(d.path(), &cid).unwrap();
        delete(d.path(), &cid).unwrap();
        assert!(matches!(load(d.path(),&cid),Err(e) if e.code=="needs_login"));
    }
    #[test]
    fn cache_rejects_insecure_permissions_links_malformed_and_oversized_files() {
        let d = tempfile::tempdir().unwrap();
        let cid = id();
        save(d.path(), &cid, &synthetic()).unwrap();
        let path = cache_path(d.path(), &cid).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(d.path(), &cid).is_err());
        save(d.path(), &cid, &synthetic()).unwrap();
        std::fs::write(&path, b"invalid").unwrap();
        assert!(load(d.path(), &cid).is_err());
        std::fs::write(&path, vec![b'x'; 65537]).unwrap();
        assert!(load(d.path(), &cid).is_err());
        std::fs::remove_file(&path).unwrap();
        let target = d.path().join("untouched");
        std::fs::write(&target, b"unchanged").unwrap();
        symlink(&target, &path).unwrap();
        assert!(load(d.path(), &cid).is_err());
        assert!(save(d.path(), &cid, &synthetic()).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"unchanged");
        assert!(cache_path(d.path(), "../other-app").is_err());
    }
}
