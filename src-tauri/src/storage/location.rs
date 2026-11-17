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
    /// `previous` is a complete copy of the data in use: only a finished move sets it. After
    /// "Use the default folder", adopting or starting empty, `previous` may hold newer data,
    /// so Remove old copy refuses. Missing in older pointers, which reads as false.
    #[serde(default)]
    pub previous_copied: bool,
}

impl Default for LocationFile {
    fn default() -> Self {
        Self {
            version: 1,
            data_dir: None,
            marker_id: None,
            previous: None,
            previous_copied: false,
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

#[derive(Debug)]
pub enum LocationError {
    /// Present but unreadable, unparseable, an unknown version or an invalid `dataDir`.
    Unreadable(String),
}

/// Only "file not found" means "use the default folder". Anything else that
/// stops the pointer being understood is an error, so the caller can show the
/// recovery page instead of silently opening an empty default workspace.
pub fn try_read_location(default_root: &Path) -> Result<LocationFile, LocationError> {
    let bytes = match std::fs::read(default_root.join(POINTER_FILE)) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(LocationFile::default()),
        Err(e) => return Err(LocationError::Unreadable(e.to_string())),
    };
    let loc: LocationFile =
        serde_json::from_slice(&bytes).map_err(|e| LocationError::Unreadable(e.to_string()))?;
    if loc.version != 1 {
        return Err(LocationError::Unreadable(format!(
            "unknown version {}",
            loc.version
        )));
    }
    if let Some(dir) = &loc.data_dir {
        if !dir.is_absolute() || dir.file_name().is_none_or(|n| n != DATA_DIR_NAME) {
            return Err(LocationError::Unreadable("invalid dataDir".into()));
        }
    }
    Ok(loc)
}

/// Lenient reader: errors read as the default pointer. Only for display; use
/// `try_read_location` / `resolve` for decisions.
pub fn read_location(default_root: &Path) -> LocationFile {
    try_read_location(default_root).unwrap_or_default()
}

/// Atomic: write a sibling temp file, fsync, rename over the target, then
/// (best effort) fsync the directory. The temp file is removed on failure.
fn write_atomic(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!("{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, target)
    })();
    match result {
        Ok(()) => {
            if let Ok(d) = std::fs::File::open(dir) {
                let _ = d.sync_all();
            }
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Writes the pointer atomically. A present-but-unreadable pointer is first
/// preserved as `location.json.bad-<timestamp>` so it is never lost.
pub fn write_location(default_root: &Path, loc: &LocationFile) -> io::Result<()> {
    std::fs::create_dir_all(default_root)?;
    let path = default_root.join(POINTER_FILE);
    if path.is_file() && try_read_location(default_root).is_err() {
        let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3f");
        std::fs::rename(&path, default_root.join(format!("{POINTER_FILE}.bad-{ts}")))?;
    }
    write_atomic(
        &path,
        &serde_json::to_vec_pretty(loc).map_err(io::Error::other)?,
    )
}

// ------------------------------------------------------------- resolution

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RootStatus {
    Ready,
    Missing,
    NoMarker,
    MarkerMismatch,
    NotWritable,
    /// `location.json` exists but cannot be trusted: show the recovery page.
    PointerUnreadable,
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

/// Writes the marker atomically at the top of `root`.
pub fn write_marker(root: &Path, marker: &Marker) -> io::Result<()> {
    write_atomic(
        &root.join(MARKER),
        &serde_json::to_vec_pretty(marker).map_err(io::Error::other)?,
    )
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
    let private_root = default_root.to_path_buf();
    let loc = match try_read_location(default_root) {
        Ok(l) => l,
        Err(_) => {
            return Resolved {
                data_root: private_root.clone(),
                private_root,
                custom: false,
                status: RootStatus::PointerUnreadable,
            }
        }
    };
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
    /// The default folder holds sign-in data and the pointer.
    InsideDefaultRoot,
    InsideAppBundle,
    /// Names the sync provider, e.g. "iCloud Drive".
    CloudSynced(String),
    /// Names the filesystem, e.g. "smbfs".
    NetworkVolume(String),
    /// Anything that is not APFS/HFS+/exFAT/FAT/known-network (NTFS, FUSE, autofs,
    /// unknown on macOS...): names the filesystem.
    UnsupportedVolume(String),
    /// exFAT/FAT: names the filesystem. Allowed only after the user acknowledges it.
    NoUnixPermissions(String),
}

/// No issues means the folder is usable; acknowledging a `NoUnixPermissions` issue is the
/// caller's decision.
#[derive(Debug, Clone)]
pub struct TargetReport {
    pub issues: Vec<TargetIssue>,
    pub existing_marker: Option<Marker>,
    pub free_bytes: u64,
    pub fs_type: String,
}

impl TargetIssue {
    /// Stable code for the UI.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotAbsolute => "not_absolute",
            Self::NotADirectory => "not_a_directory",
            Self::NotWritable => "not_writable",
            Self::InsideCurrentRoot => "inside_current",
            Self::InsideDefaultRoot => "inside_private",
            Self::InsideAppBundle => "inside_app",
            Self::CloudSynced(_) => "cloud_synced",
            Self::NetworkVolume(_) => "network_volume",
            Self::UnsupportedVolume(_) => "unsupported_volume",
            Self::NoUnixPermissions(_) => "no_permissions",
        }
    }

    /// User-facing reason: what is wrong with the folder and why it matters, in plain words.
    pub fn reason(&self) -> String {
        match self {
            Self::NotAbsolute => "Choose a full folder path.".into(),
            Self::NotADirectory => {
                "That folder isn’t there: it may have been moved, or its drive disconnected.".into()
            }
            Self::NotWritable => {
                "Connect can’t create files in that folder, so it can’t keep your data there.".into()
            }
            Self::InsideCurrentRoot => {
                "That folder is inside your current data folder, and data can’t move into itself."
                    .into()
            }
            Self::InsideDefaultRoot => {
                "That folder is inside Connect’s private folder, which holds your sign-in data and never moves.".into()
            }
            Self::InsideAppBundle => {
                "Folders inside apps can’t hold your data. Apps are replaced when they update.".into()
            }
            Self::CloudSynced(p) => {
                // "a cloud storage provider" starts the sentence; brand names keep their case.
                let provider = match p.strip_prefix("a ") {
                    Some(rest) => format!("A {rest}"),
                    None => p.clone(),
                };
                format!("{provider} syncs that folder, and syncing can damage the workspace database.")
            }
            Self::NetworkVolume(t) => format!(
                "That folder is on a network drive ({}). The workspace database needs a disk connected to this Mac.",
                volume_name(t)
            ),
            Self::UnsupportedVolume(t) => format!(
                "That disk is formatted as {}. Connect needs APFS or Mac OS Extended.",
                volume_name(t)
            ),
            Self::NoUnixPermissions(t) => format!(
                "This {} drive has no file permissions, so anyone with access to it can read your workspace.",
                volume_name(t)
            ),
        }
    }
}

/// How macOS names a filesystem type in Finder and Disk Utility.
pub fn volume_name(fs_type: &str) -> String {
    match fs_type {
        "apfs" => "APFS",
        "hfs" => "Mac OS Extended",
        "exfat" => "exFAT",
        "msdos" => "FAT",
        "smbfs" | "cifs" => "SMB",
        "afpfs" => "AFP",
        "nfs" => "NFS",
        "webdav" => "WebDAV",
        "ftp" => "FTP",
        "ntfs" => "NTFS",
        other => other,
    }
    .into()
}

/// Canonical form that also works for paths that do not exist yet. Walks the
/// components: each existing prefix is canonicalised (resolving symlinks), so a
/// following `..` pops the real parent; once a prefix is missing, the rest is
/// folded lexically (`.` skipped, `..` pops).
pub(crate) fn canonical(p: &Path) -> PathBuf {
    let mut base = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                base.pop();
            }
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir => base.push(c.as_os_str()),
            Component::Normal(n) => {
                base.push(n);
                if let Ok(real) = dunce::canonicalize(&base) {
                    base = real;
                }
            }
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

/// Component-wise, case-insensitive `starts_with` (APFS is usually case-insensitive).
pub(crate) fn starts_with_ci(path: &Path, prefix: &Path) -> bool {
    let lower = |c: Component| c.as_os_str().to_string_lossy().to_lowercase();
    let mut p = path.components();
    prefix
        .components()
        .all(|pc| p.next().is_some_and(|c| lower(c) == lower(pc)))
}

fn cloud_provider(path: &Path, home: &Path) -> Option<String> {
    let lib = home.join("Library");
    if starts_with_ci(path, &lib.join("Mobile Documents")) {
        return Some("iCloud Drive".into());
    }
    if starts_with_ci(path, &lib.join("CloudStorage")) {
        return Some("a cloud storage provider".into());
    }
    for c in path.components() {
        let name = c.as_os_str().to_string_lossy().to_lowercase();
        if name.starts_with("dropbox") {
            return Some("Dropbox".into());
        }
        if name.starts_with("onedrive") {
            return Some("OneDrive".into());
        }
        if name.starts_with("google drive") || name.starts_with("googledrive") {
            return Some("Google Drive".into());
        }
    }
    // iCloud Desktop & Documents: those two folders are synced when this exists.
    let icloud = lib.join("Mobile Documents/com~apple~CloudDocs");
    for folder in ["Desktop", "Documents"] {
        if starts_with_ci(path, &home.join(folder)) && icloud.join(folder).exists() {
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
    default_root: &Path,
    home: &Path,
    vol: &dyn VolumeInfo,
) -> TargetReport {
    // Ask about the canonical path so a symlink onto another volume is seen.
    let canon = canonical(path);
    let fs_type = vol.fs_type(&canon);
    let free_bytes = vol.free_bytes(&canon);
    let finish = |issues: Vec<TargetIssue>, existing_marker| TargetReport {
        issues,
        existing_marker,
        free_bytes,
        fs_type: fs_type.clone(),
    };

    if !path.is_absolute() {
        return finish(vec![TargetIssue::NotAbsolute], None);
    }
    let mut issues = Vec::new();
    let home = canonical(home);
    let is_dir = canon.is_dir();
    if !is_dir {
        issues.push(TargetIssue::NotADirectory);
    }
    if canon.starts_with(canonical(current_root)) {
        issues.push(TargetIssue::InsideCurrentRoot);
    } else if canon.starts_with(canonical(default_root)) {
        issues.push(TargetIssue::InsideDefaultRoot);
    }
    let exe = std::env::current_exe().ok();
    if in_app_bundle(&canon, exe.as_deref()) {
        issues.push(TargetIssue::InsideAppBundle);
    }
    if let Some(p) = cloud_provider(&canon, &home) {
        issues.push(TargetIssue::CloudSynced(p));
    }
    // Allowlist: only APFS/HFS+ pass; off macOS an unknown type is tolerated.
    match fs_type.as_str() {
        "apfs" | "hfs" => {}
        "smbfs" | "afpfs" | "nfs" | "webdav" | "cifs" | "ftp" => {
            issues.push(TargetIssue::NetworkVolume(fs_type.clone()))
        }
        "exfat" | "msdos" => issues.push(TargetIssue::NoUnixPermissions(fs_type.clone())),
        "unknown" if !cfg!(target_os = "macos") => {}
        _ => issues.push(TargetIssue::UnsupportedVolume(fs_type.clone())),
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

    fn ct(p: &Path, root: &Path, home: &Path, vol: &dyn VolumeInfo) -> TargetReport {
        check_target(p, root, Path::new("/codemie-test-default-root"), home, vol)
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
        assert_eq!(read_location(d.path()), LocationFile::default());
    }

    #[test]
    fn corrupt_or_untrusted_pointer_is_unreadable_not_default() {
        let d = tempfile::tempdir().unwrap();
        let ptr = d.path().join("location.json");
        for bad in [
            "{not json".to_string(),
            r#"{"version":2,"dataDir":null,"markerId":null,"previous":null}"#.to_string(),
            r#"{"version":1,"dataDir":"relative/CodeMie Connect Data","markerId":"A","previous":null}"#
                .to_string(),
            r#"{"version":1,"dataDir":"/x/Other Name","markerId":"A","previous":null}"#.to_string(),
        ] {
            std::fs::write(&ptr, &bad).unwrap();
            assert_eq!(resolve(d.path()).status, RootStatus::PointerUnreadable, "{bad}");
        }
        // An unreadable pointer (a directory) is not "not found" either.
        std::fs::remove_file(&ptr).unwrap();
        std::fs::create_dir(&ptr).unwrap();
        assert_eq!(resolve(d.path()).status, RootStatus::PointerUnreadable);
    }

    #[test]
    fn write_location_preserves_a_corrupt_pointer() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("location.json"), "{broken").unwrap();
        write_location(d.path(), &LocationFile::default()).unwrap();
        assert_eq!(resolve(d.path()).status, RootStatus::Ready);
        let bad: Vec<_> = std::fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("location.json.bad-"))
            .collect();
        assert_eq!(bad.len(), 1);
        assert_eq!(
            std::fs::read_to_string(d.path().join(&bad[0])).unwrap(),
            "{broken"
        );
    }

    #[test]
    fn resolve_reports_missing_no_marker_mismatch_not_writable() {
        let d = tempfile::tempdir().unwrap();
        let default = d.path().join("default");
        let data = d.path().join("ext").join(DATA_DIR_NAME);
        write_location(
            &default,
            &LocationFile {
                version: 1,
                data_dir: Some(data.clone()),
                marker_id: Some("A".into()),
                previous: None,
                previous_copied: false,
            },
        )
        .unwrap();
        assert_eq!(resolve(&default).status, RootStatus::Missing);
        assert!(!data.exists(), "resolve must not create the folder");
        std::fs::create_dir_all(&data).unwrap();
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
        ct(p, root, home, &FakeVol("apfs"))
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
        let ok = ct(&plain, &root, &home, &FakeVol("apfs"));
        assert!(ok.issues.is_empty(), "{:?}", ok.issues);
        assert_eq!(ok.free_bytes, 42);
        for fs in ["smbfs", "afpfs", "nfs", "webdav"] {
            let r = ct(&plain, &root, &home, &FakeVol(fs));
            assert!(!r.issues.is_empty());
            assert_eq!(r.issues, vec![TargetIssue::NetworkVolume(fs.into())]);
        }
        assert!(ct(&plain, &root, &home, &FakeVol("hfs")).issues.is_empty());
    }

    #[test]
    fn check_target_flags_exfat_as_no_unix_permissions() {
        let d = tempfile::tempdir().unwrap();
        for fs in ["exfat", "msdos"] {
            let r = ct(d.path(), &d.path().join("root"), d.path(), &FakeVol(fs));
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
        let r = ct(Path::new("rel/dir"), &root, &home, &vol);
        assert_eq!(r.issues, vec![TargetIssue::NotAbsolute]);
        let missing = d.path().join("nope");
        let r = ct(&missing, &root, &home, &vol);
        assert_eq!(r.issues, vec![TargetIssue::NotADirectory]);
        assert!(!missing.exists(), "check_target must not create the target");
        let file = d.path().join("f");
        std::fs::write(&file, "x").unwrap();
        assert!(ct(&file, &root, &home, &vol)
            .issues
            .contains(&TargetIssue::NotADirectory));
        let r = ct(&root.join("sub"), &root, &home, &vol);
        assert!(r.issues.contains(&TargetIssue::InsideCurrentRoot));
        assert!(ct(&root, &root, &home, &vol)
            .issues
            .contains(&TargetIssue::InsideCurrentRoot));
        let app = d.path().join("CodeMie Connect.app/Contents/Resources");
        std::fs::create_dir_all(&app).unwrap();
        assert!(ct(&app, &root, &home, &vol)
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
            let r = ct(&ro, &root, &home, &vol);
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
        assert!(ct(d.path(), &root, d.path(), &vol)
            .existing_marker
            .is_none());
        let data = d.path().join(DATA_DIR_NAME);
        std::fs::create_dir(&data).unwrap();
        std::fs::write(data.join(MARKER), marker("X1")).unwrap();
        let r = ct(d.path(), &root, d.path(), &vol);
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
            previous_copied: true,
        };
        write_location(d.path(), &a).unwrap();
        assert_eq!(read_location(d.path()), a);
        let raw = std::fs::read_to_string(d.path().join("location.json")).unwrap();
        assert!(raw.contains("\"dataDir\"") && raw.contains("\"markerId\""));
        assert!(raw.contains("\"previousCopied\": true"));
        // Pointers written before `previousCopied` existed read as "not a copy".
        std::fs::write(
            d.path().join("location.json"),
            r#"{"version":1,"dataDir":null,"markerId":null,"previous":"/old"}"#,
        )
        .unwrap();
        assert!(!try_read_location(d.path()).unwrap().previous_copied);
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

    #[test]
    fn volume_allowlist_refuses_everything_but_apfs_hfs() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("root");
        for fs in ["apfs", "hfs"] {
            assert!(
                ct(d.path(), &root, d.path(), &FakeVol(fs))
                    .issues
                    .is_empty(),
                "{fs}"
            );
        }
        for fs in ["ntfs", "macfuse", "osxfuse", "autofs", "ufs", "cifs", "ftp"] {
            assert!(
                !ct(d.path(), &root, d.path(), &FakeVol(fs))
                    .issues
                    .is_empty(),
                "{fs}"
            );
        }
        let r = ct(d.path(), &root, d.path(), &FakeVol("macfuse"));
        assert_eq!(
            r.issues,
            vec![TargetIssue::UnsupportedVolume("macfuse".into())]
        );
        let r = ct(d.path(), &root, d.path(), &FakeVol("ntfs"));
        assert_eq!(
            r.issues,
            vec![TargetIssue::UnsupportedVolume("ntfs".into())]
        );
        let r = ct(d.path(), &root, d.path(), &FakeVol("cifs"));
        assert_eq!(r.issues, vec![TargetIssue::NetworkVolume("cifs".into())]);
        let unknown = ct(d.path(), &root, d.path(), &FakeVol("unknown"));
        assert_eq!(unknown.issues.is_empty(), !cfg!(target_os = "macos"));
        assert!(!ct(d.path(), &root, d.path(), &FakeVol("exfat"))
            .issues
            .is_empty());
    }

    #[test]
    fn canonical_folds_dotdot_through_missing_ancestors() {
        let d = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(d.path()).unwrap();
        let p = d.path().join("missing/a/../../Dropbox/./x/..");
        assert_eq!(canonical(&p), base.join("Dropbox"));
        let home = d.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let sneaky = home.join("nope/../Library/Mobile Documents/x");
        assert!(cloud(&sneaky, &home, &d.path().join("root")));
        #[cfg(unix)]
        {
            // `..` after a symlink pops the real parent.
            let real = d.path().join("real/inner");
            std::fs::create_dir_all(&real).unwrap();
            std::os::unix::fs::symlink(&real, d.path().join("ln")).unwrap();
            assert_eq!(
                canonical(&d.path().join("ln/../zzz")),
                base.join("real/zzz")
            );
        }
    }

    #[test]
    fn cloud_matching_is_case_insensitive_and_prefix_based() {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().join("home");
        let root = d.path().join("root");
        std::fs::create_dir_all(home.join("Library/Mobile Documents/com~apple~CloudDocs/Desktop"))
            .unwrap();
        assert!(cloud(
            &home.join("library/mobile documents/x"),
            &home,
            &root
        ));
        assert!(cloud(&home.join("LIBRARY/cloudstorage/x"), &home, &root));
        assert!(cloud(&home.join("desktop/x"), &home, &root));
        assert!(cloud(&home.join("Dropbox (Personal)/x"), &home, &root));
        assert!(cloud(&home.join("Google Drive (me@x.com)/x"), &home, &root));
        assert!(cloud(&home.join("OneDrive - EPAM/x"), &home, &root));
        assert!(!cloud(&home.join("projects/x"), &home, &root));
    }

    #[test]
    fn check_target_refuses_the_default_private_root() {
        let d = tempfile::tempdir().unwrap();
        let default = d.path().join("default");
        let custom = d.path().join("custom");
        std::fs::create_dir_all(default.join("credentials")).unwrap();
        std::fs::create_dir_all(&custom).unwrap();
        let vol = FakeVol("apfs");
        for t in [default.clone(), default.join("credentials")] {
            let r = check_target(&t, &custom, &default, d.path(), &vol);
            assert_eq!(r.issues, vec![TargetIssue::InsideDefaultRoot]);
        }
        assert!(TargetIssue::InsideAppBundle
            .reason()
            .contains("Folders inside apps can’t hold your data."));
    }

    #[test]
    fn each_issue_reads_as_a_plain_reason_with_the_disk_named() {
        let all = [
            TargetIssue::NotAbsolute,
            TargetIssue::NotADirectory,
            TargetIssue::NotWritable,
            TargetIssue::InsideCurrentRoot,
            TargetIssue::InsideDefaultRoot,
            TargetIssue::InsideAppBundle,
            TargetIssue::CloudSynced("iCloud Drive".into()),
            TargetIssue::CloudSynced("a cloud storage provider".into()),
            TargetIssue::NetworkVolume("smbfs".into()),
            TargetIssue::UnsupportedVolume("ntfs".into()),
            TargetIssue::NoUnixPermissions("exfat".into()),
        ];
        for issue in &all {
            let reason = issue.reason();
            let capital = reason.starts_with(char::is_uppercase) || reason.starts_with("iCloud");
            assert!(capital, "{reason}");
            assert!(reason.ends_with('.'), "{reason}");
            assert!(!reason.contains('\''), "typographic apostrophes: {reason}");
        }
        assert_eq!(
            TargetIssue::CloudSynced("iCloud Drive".into()).reason(),
            "iCloud Drive syncs that folder, and syncing can damage the workspace database."
        );
        assert!(TargetIssue::CloudSynced("a cloud storage provider".into())
            .reason()
            .starts_with("A cloud storage provider syncs"));
        assert!(TargetIssue::NetworkVolume("smbfs".into())
            .reason()
            .contains("network drive (SMB)"));
        assert!(TargetIssue::UnsupportedVolume("ntfs".into())
            .reason()
            .contains("formatted as NTFS"));
        assert!(TargetIssue::NoUnixPermissions("exfat".into())
            .reason()
            .starts_with("This exFAT drive has no file permissions"));
        assert_eq!(volume_name("msdos"), "FAT");
        assert_eq!(volume_name("hfs"), "Mac OS Extended");
        assert_eq!(volume_name("macfuse"), "macfuse");
    }

    #[test]
    fn write_atomic_failure_keeps_target_and_removes_temp() {
        let d = tempfile::tempdir().unwrap();
        // A non-empty directory occupies the target, so the final rename fails.
        let target = d.path().join("location.json");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "old").unwrap();
        assert!(write_atomic(&target, b"new").is_err());
        assert_eq!(std::fs::read_to_string(target.join("keep")).unwrap(), "old");
        let names: Vec<_> = std::fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["location.json"], "temp file removed");
        // A good pointer survives a later failed write attempt on a bad default root.
        let good = d.path().join("good");
        let a = LocationFile::default();
        write_location(&good, &a).unwrap();
        assert_eq!(read_location(&good), a);
    }
}
