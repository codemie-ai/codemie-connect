//! `location.json` pointer, root resolution and target-folder validation
//! (DESIGN.md section 8).

use serde::{Deserialize, Serialize};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

pub const DATA_DIR_NAME: &str = "CodeMie Connect Data";
pub const MARKER: &str = ".codemie-connect.json";
const POINTER_FILE: &str = "location.json";

// ---------------------------------------------------------------- pointer

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationFile {
    pub version: u32,
    pub data_dir: Option<PathBuf>,
    pub marker_id: Option<String>,
    pub previous: Option<PathBuf>,
}

impl Default for LocationFile {
    fn default() -> Self {
        Self {
            version: 1,
            data_dir: None,
            marker_id: None,
            previous: None,
        }
    }
}

/// The marker file written at the top of a custom data root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub created_at: String,
    pub app_version: String,
}

/// Missing, unreadable or invalid pointer files all mean "use the default folder".
pub fn read_location(default_root: &Path) -> LocationFile {
    std::fs::read(default_root.join(POINTER_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<LocationFile>(&b).ok())
        .unwrap_or_default()
}

/// Atomic: write a sibling temp file, fsync, then rename over the pointer.
pub fn write_location(default_root: &Path, loc: &LocationFile) -> io::Result<()> {
    std::fs::create_dir_all(default_root)?;
    let tmp = default_root.join(format!("{POINTER_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(loc).map_err(io::Error::other)?)?;
        f.sync_all()?;
        std::fs::rename(&tmp, default_root.join(POINTER_FILE))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

// ------------------------------------------------------------- resolution

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootStatus {
    Ready,
    Missing,
    NoMarker,
    MarkerMismatch,
    NotWritable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub data_root: PathBuf,
    /// Always the default folder: credentials, locks and the pointer stay here.
    pub private_root: PathBuf,
    pub custom: bool,
    pub status: RootStatus,
}

pub fn read_marker(root: &Path) -> Option<Marker> {
    std::fs::read(root.join(MARKER))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

/// Create and delete a uniquely named file; never leaves anything behind.
fn probe_writable(dir: &Path) -> bool {
    let p = dir.join(format!(".codemie-probe-{}", uuid::Uuid::new_v4()));
    match std::fs::File::create(&p) {
        Ok(_) => {
            let _ = std::fs::remove_file(&p);
            true
        }
        Err(_) => false,
    }
}

pub fn resolve(default_root: &Path) -> Resolved {
    let loc = read_location(default_root);
    let private_root = default_root.to_path_buf();
    let Some(dir) = loc.data_dir else {
        return Resolved {
            data_root: private_root.clone(),
            private_root,
            custom: false,
            status: RootStatus::Ready,
        };
    };
    let status = if !dir.is_dir() {
        RootStatus::Missing
    } else {
        match read_marker(&dir) {
            None => RootStatus::NoMarker,
            Some(m) if loc.marker_id.as_deref() != Some(m.id.as_str()) => {
                RootStatus::MarkerMismatch
            }
            Some(_) if !probe_writable(&dir) => RootStatus::NotWritable,
            Some(_) => RootStatus::Ready,
        }
    };
    Resolved {
        data_root: dir,
        private_root,
        custom: true,
        status,
    }
}

// ------------------------------------------------------- target validation

/// Reads filesystem facts about a path. A trait so tests inject fs types.
pub trait VolumeInfo {
    fn fs_type(&self, p: &Path) -> String;
    fn free_bytes(&self, p: &Path) -> u64;
}

/// `statfs`-backed reader. Off macOS the fs type is "unknown" (treated as
/// local but unverified: no volume issue is raised) and non-unix free space is 0.
pub struct SystemVolume;

#[cfg(unix)]
fn statfs_of(p: &Path) -> Option<libc::statfs> {
    use std::os::unix::ffi::OsStrExt;
    // The target may not exist yet: ask about the nearest existing ancestor.
    let existing = p.ancestors().find(|a| a.exists())?;
    let c = std::ffi::CString::new(existing.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statfs(c.as_ptr(), &mut s) } == 0).then_some(s)
}

impl VolumeInfo for SystemVolume {
    #[cfg(target_os = "macos")]
    fn fs_type(&self, p: &Path) -> String {
        statfs_of(p)
            .map(|s| {
                let bytes: Vec<u8> = s
                    .f_fstypename
                    .iter()
                    .take_while(|c| **c != 0)
                    .map(|c| *c as u8)
                    .collect();
                String::from_utf8_lossy(&bytes).to_lowercase()
            })
            .unwrap_or_else(|| "unknown".into())
    }
    #[cfg(not(target_os = "macos"))]
    fn fs_type(&self, _p: &Path) -> String {
        "unknown".into()
    }

    #[cfg(unix)]
    #[allow(clippy::unnecessary_cast)] // field widths differ per platform
    fn free_bytes(&self, p: &Path) -> u64 {
        statfs_of(p)
            .map(|s| (s.f_bavail as u64).saturating_mul(s.f_bsize as u64))
            .unwrap_or(0)
    }
    #[cfg(not(unix))]
    fn free_bytes(&self, _p: &Path) -> u64 {
        0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetIssue {
    NotAbsolute,
    NotADirectory,
    NotWritable,
    InsideCurrentRoot,
    InsideAppBundle,
    /// Names the sync provider, e.g. "iCloud Drive".
    CloudSynced(String),
    /// Names the filesystem, e.g. "smbfs".
    NetworkVolume(String),
    /// exFAT/FAT: names the filesystem. Allowed only after the user acknowledges it.
    NoUnixPermissions(String),
}

#[derive(Debug, Clone)]
pub struct TargetReport {
    /// True when there are no issues at all (acknowledging a
    /// `NoUnixPermissions` issue is the caller's decision).
    pub ok: bool,
    pub issues: Vec<TargetIssue>,
    pub existing_marker: Option<Marker>,
    pub free_bytes: u64,
    pub fs_type: String,
}

/// Canonical form that also works for paths that do not exist yet: the deepest
/// existing ancestor is canonicalised (resolving symlinks), the rest is
/// normalised lexically (`.` and `..` folded).
fn canonical(p: &Path) -> PathBuf {
    if let Ok(c) = dunce::canonicalize(p) {
        return c;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut base = p.to_path_buf();
    loop {
        if let Ok(c) = dunce::canonicalize(&base) {
            base = c;
            break;
        }
        match (base.file_name().map(|n| n.to_os_string()), base.parent()) {
            (Some(n), Some(parent)) => {
                tail.push(n);
                base = parent.to_path_buf();
            }
            _ => break,
        }
    }
    for part in tail.into_iter().rev() {
        if part == ".." {
            base.pop();
        } else if part != "." {
            base.push(part);
        }
    }
    base
}

/// True for any `.app` path segment, or a path inside the running bundle.
fn in_app_bundle(path: &Path, exe: Option<&Path>) -> bool {
    let is_app = |c: Component| {
        c.as_os_str()
            .to_string_lossy()
            .to_lowercase()
            .ends_with(".app")
    };
    if path.components().any(is_app) {
        return true;
    }
    exe.and_then(|e| {
        e.ancestors()
            .find(|a| a.extension().is_some_and(|x| x == "app"))
    })
    .is_some_and(|bundle| path.starts_with(canonical(bundle)))
}

fn cloud_provider(path: &Path, home: &Path) -> Option<String> {
    let lib = home.join("Library");
    if path.starts_with(lib.join("Mobile Documents")) {
        return Some("iCloud Drive".into());
    }
    if path.starts_with(lib.join("CloudStorage")) {
        return Some("a cloud storage provider".into());
    }
    for c in path.components() {
        let name = c.as_os_str().to_string_lossy().to_lowercase();
        if name == "dropbox" {
            return Some("Dropbox".into());
        }
        if name.starts_with("onedrive") {
            return Some("OneDrive".into());
        }
        if name == "google drive" || name == "googledrive" {
            return Some("Google Drive".into());
        }
    }
    // iCloud Desktop & Documents: those two folders are synced when this exists.
    let icloud = lib.join("Mobile Documents/com~apple~CloudDocs");
    for folder in ["Desktop", "Documents"] {
        if path.starts_with(home.join(folder)) && icloud.join(folder).exists() {
            return Some("iCloud Desktop & Documents".into());
        }
    }
    None
}

/// Validates a candidate data-folder parent. Read-only apart from a probe file
/// that is created and removed: never creates, chmods or modifies `path`.
pub fn check_target(
    path: &Path,
    current_root: &Path,
    home: &Path,
    vol: &dyn VolumeInfo,
) -> TargetReport {
    let fs_type = vol.fs_type(path);
    let free_bytes = vol.free_bytes(path);
    let finish = |issues: Vec<TargetIssue>, existing_marker| TargetReport {
        ok: issues.is_empty(),
        issues,
        existing_marker,
        free_bytes,
        fs_type: fs_type.clone(),
    };

    if !path.is_absolute() {
        return finish(vec![TargetIssue::NotAbsolute], None);
    }
    let mut issues = Vec::new();
    let canon = canonical(path);
    let home = canonical(home);
    let is_dir = canon.is_dir();
    if !is_dir {
        issues.push(TargetIssue::NotADirectory);
    }
    if canon.starts_with(canonical(current_root)) {
        issues.push(TargetIssue::InsideCurrentRoot);
    }
    let exe = std::env::current_exe().ok();
    if in_app_bundle(&canon, exe.as_deref()) {
        issues.push(TargetIssue::InsideAppBundle);
    }
    if let Some(p) = cloud_provider(&canon, &home) {
        issues.push(TargetIssue::CloudSynced(p));
    }
    match fs_type.as_str() {
        "smbfs" | "afpfs" | "nfs" | "webdav" => {
            issues.push(TargetIssue::NetworkVolume(fs_type.clone()))
        }
        "exfat" | "msdos" => issues.push(TargetIssue::NoUnixPermissions(fs_type.clone())),
        _ => {}
    }
    if is_dir && !probe_writable(&canon) {
        issues.push(TargetIssue::NotWritable);
    }
    let marker = if is_dir {
        read_marker(&canon.join(DATA_DIR_NAME))
    } else {
        None
    };
    finish(issues, marker)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fake volume reporting one fs type for every path.
    struct FakeVol(&'static str);
    impl VolumeInfo for FakeVol {
        fn fs_type(&self, _p: &Path) -> String {
            self.0.into()
        }
        fn free_bytes(&self, _p: &Path) -> u64 {
            42
        }
    }

    fn marker(id: &str) -> String {
        format!(r#"{{"id":"{id}","createdAt":"2026-01-01T00:00:00Z","appVersion":"2.1.1"}}"#)
    }

    #[test]
    fn default_when_pointer_missing_or_invalid() {
        let d = tempfile::tempdir().unwrap();
        let r = resolve(d.path());
        assert!(!r.custom);
        assert_eq!(r.data_root, d.path());
        assert_eq!(r.private_root, d.path());
        assert_eq!(r.status, RootStatus::Ready);
        std::fs::write(d.path().join("location.json"), "{not json").unwrap();
        assert!(!resolve(d.path()).custom);
        assert_eq!(read_location(d.path()), LocationFile::default());
    }

    #[test]
    fn resolve_reports_missing_no_marker_mismatch_not_writable() {
        let d = tempfile::tempdir().unwrap();
        let default = d.path().join("default");
        let data = d.path().join("data");
        write_location(
            &default,
            &LocationFile {
                version: 1,
                data_dir: Some(data.clone()),
                marker_id: Some("A".into()),
                previous: None,
            },
        )
        .unwrap();
        assert_eq!(resolve(&default).status, RootStatus::Missing);
        assert!(!data.exists(), "resolve must not create the folder");
        std::fs::create_dir(&data).unwrap();
        assert_eq!(resolve(&default).status, RootStatus::NoMarker);
        std::fs::write(data.join(MARKER), marker("B")).unwrap();
        assert_eq!(resolve(&default).status, RootStatus::MarkerMismatch);
        std::fs::write(data.join(MARKER), marker("A")).unwrap();
        let r = resolve(&default);
        assert_eq!(r.status, RootStatus::Ready);
        assert!(r.custom);
        assert_eq!(r.data_root, data);
        assert_eq!(r.private_root, default);
        assert_eq!(
            std::fs::read_dir(&data).unwrap().count(),
            1,
            "probe left nothing behind"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o500)).unwrap();
            let status = resolve(&default).status;
            std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(status, RootStatus::NotWritable);
        }
    }

    fn cloud(p: &Path, home: &Path, root: &Path) -> bool {
        check_target(p, root, home, &FakeVol("apfs"))
            .issues
            .iter()
            .any(|i| matches!(i, TargetIssue::CloudSynced(_)))
    }

    #[test]
    fn check_target_refuses_cloud_and_network_paths() {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().join("home");
        let root = d.path().join("root");
        for sub in [
            "Library/Mobile Documents/x",
            "Library/CloudStorage/OneDrive-X/x",
            "Dropbox/x",
            "Google Drive/x",
            "Documents/x",
        ] {
            std::fs::create_dir_all(home.join(sub)).unwrap();
        }
        assert!(cloud(
            &home.join("Library/Mobile Documents/x"),
            &home,
            &root
        ));
        assert!(cloud(
            &home.join("Library/CloudStorage/OneDrive-X/x"),
            &home,
            &root
        ));
        assert!(cloud(&home.join("Dropbox/x"), &home, &root));
        assert!(cloud(&home.join("Google Drive/x"), &home, &root));
        // Not-yet-existing paths and `..` tricks are caught too.
        assert!(cloud(Path::new("/Users/a/Dropbox/x"), &home, &root));
        assert!(cloud(
            &home.join("Library/../Library/Mobile Documents/x"),
            &home,
            &root
        ));
        // ~/Documents only counts once iCloud Desktop & Documents is on.
        assert!(!cloud(&home.join("Documents/x"), &home, &root));
        std::fs::create_dir_all(
            home.join("Library/Mobile Documents/com~apple~CloudDocs/Documents"),
        )
        .unwrap();
        assert!(cloud(&home.join("Documents/x"), &home, &root));
        #[cfg(unix)]
        {
            let link = d.path().join("link");
            std::os::unix::fs::symlink(home.join("Dropbox"), &link).unwrap();
            assert!(cloud(&link.join("x"), &home, &root));
        }
        let plain = d.path().join("plain");
        std::fs::create_dir(&plain).unwrap();
        let ok = check_target(&plain, &root, &home, &FakeVol("apfs"));
        assert!(ok.ok, "{:?}", ok.issues);
        assert_eq!(ok.free_bytes, 42);
        for fs in ["smbfs", "afpfs", "nfs", "webdav"] {
            let r = check_target(&plain, &root, &home, &FakeVol(fs));
            assert!(!r.ok);
            assert_eq!(r.issues, vec![TargetIssue::NetworkVolume(fs.into())]);
        }
        assert!(check_target(&plain, &root, &home, &FakeVol("hfs")).ok);
    }

    #[test]
    fn check_target_flags_exfat_as_no_unix_permissions() {
        let d = tempfile::tempdir().unwrap();
        for fs in ["exfat", "msdos"] {
            let r = check_target(d.path(), &d.path().join("root"), d.path(), &FakeVol(fs));
            assert_eq!(r.issues, vec![TargetIssue::NoUnixPermissions(fs.into())]);
            assert_eq!(r.fs_type, fs);
        }
    }

    #[test]
    fn check_target_basic_refusals_and_no_side_effects() {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().join("home");
        let root = d.path().join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let vol = FakeVol("apfs");
        let r = check_target(Path::new("rel/dir"), &root, &home, &vol);
        assert_eq!(r.issues, vec![TargetIssue::NotAbsolute]);
        let missing = d.path().join("nope");
        let r = check_target(&missing, &root, &home, &vol);
        assert_eq!(r.issues, vec![TargetIssue::NotADirectory]);
        assert!(!missing.exists(), "check_target must not create the target");
        let file = d.path().join("f");
        std::fs::write(&file, "x").unwrap();
        assert!(check_target(&file, &root, &home, &vol)
            .issues
            .contains(&TargetIssue::NotADirectory));
        let r = check_target(&root.join("sub"), &root, &home, &vol);
        assert!(r.issues.contains(&TargetIssue::InsideCurrentRoot));
        assert!(check_target(&root, &root, &home, &vol)
            .issues
            .contains(&TargetIssue::InsideCurrentRoot));
        let app = d.path().join("CodeMie Connect.app/Contents/Resources");
        std::fs::create_dir_all(&app).unwrap();
        assert!(check_target(&app, &root, &home, &vol)
            .issues
            .contains(&TargetIssue::InsideAppBundle));
        let exe = d.path().join("Other.app/Contents/MacOS/bin");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        assert!(in_app_bundle(
            &d.path().join("Other.app/Contents/Resources"),
            Some(&exe)
        ));
        assert_eq!(
            std::fs::read_dir(root.join("sub")).unwrap().count(),
            0,
            "probe left nothing"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let ro = d.path().join("ro");
            std::fs::create_dir(&ro).unwrap();
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o500)).unwrap();
            let r = check_target(&ro, &root, &home, &vol);
            let mode = std::fs::metadata(&ro).unwrap().permissions().mode() & 0o777;
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert!(r.issues.contains(&TargetIssue::NotWritable));
            assert_eq!(mode, 0o500, "check_target must not chmod");
        }
    }

    #[test]
    fn check_target_detects_existing_marker() {
        let d = tempfile::tempdir().unwrap();
        let vol = FakeVol("apfs");
        let root = d.path().join("root");
        assert!(check_target(d.path(), &root, d.path(), &vol)
            .existing_marker
            .is_none());
        let data = d.path().join(DATA_DIR_NAME);
        std::fs::create_dir(&data).unwrap();
        std::fs::write(data.join(MARKER), marker("X1")).unwrap();
        let r = check_target(d.path(), &root, d.path(), &vol);
        assert_eq!(r.existing_marker.unwrap().id, "X1");
    }

    #[test]
    fn write_location_is_atomic() {
        let d = tempfile::tempdir().unwrap();
        let a = LocationFile {
            version: 1,
            data_dir: Some("/a/CodeMie Connect Data".into()),
            marker_id: Some("m".into()),
            previous: Some("/old".into()),
        };
        write_location(d.path(), &a).unwrap();
        assert_eq!(read_location(d.path()), a);
        let raw = std::fs::read_to_string(d.path().join("location.json")).unwrap();
        assert!(raw.contains("\"dataDir\"") && raw.contains("\"markerId\""));
        write_location(d.path(), &LocationFile::default()).unwrap();
        assert_eq!(read_location(d.path()), LocationFile::default());
        let names: Vec<_> = std::fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["location.json"], "no temp files left behind");
        // A failing write (default root is a file) leaves nothing behind either.
        let file = d.path().join("afile");
        std::fs::write(&file, "x").unwrap();
        assert!(write_location(&file, &a).is_err());
    }

    #[test]
    fn system_volume_reads_real_filesystem() {
        let d = tempfile::tempdir().unwrap();
        let v = SystemVolume;
        #[cfg(unix)]
        assert!(v.free_bytes(&d.path().join("not-yet")) > 0);
        #[cfg(target_os = "macos")]
        assert_ne!(v.fs_type(d.path()), "unknown");
        let _ = v.fs_type(d.path());
    }
}
