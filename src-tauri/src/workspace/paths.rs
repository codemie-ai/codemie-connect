//! Where a workspace keeps its files, the locks that guard them, and how startup opens the
//! resolved data folder (DESIGN.md section 8).
use super::{models::*, Core, WorkspaceState};
use crate::storage::location::{self, RootStatus};
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

/// `data` holds the database, AI staging and the user's plugins; `private`, always the default
/// folder, holds sign-in data, plugin secrets, `owner.lock` and `window.json`. With no custom
/// folder they are the same folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorePaths {
    pub data: PathBuf,
    pub private: PathBuf,
}
impl CorePaths {
    pub fn custom(&self) -> bool {
        self.data != self.private
    }
    pub fn database(&self) -> PathBuf {
        self.data.join("workspace.sqlite")
    }
    /// The analytics store (`sessions.json`) and its fetch state: they move with the data.
    #[allow(dead_code)] // used from Task 2
    pub fn analytics_dir(&self) -> PathBuf {
        self.data.join("analytics")
    }
    pub fn staging(&self) -> PathBuf {
        self.data.join("ai-staging")
    }
    /// Plugin secrets sit with the sign-in data (an owner-only folder), never in the `plugins/`
    /// folder that moves with the data (`plugins::services`).
    pub fn plugin_secrets(&self) -> PathBuf {
        self.private.join("credentials").join("plugins")
    }
    /// The AI staging folder for a run. Only the `ai-staging` leaf is ever created: a data
    /// folder that went away reads as `storage_unavailable` and is never recreated.
    pub fn ensure_staging(&self) -> Result<PathBuf> {
        let dir = self.staging();
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&dir) {
            Ok(()) => Ok(dir),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && dir.is_dir() => Ok(dir),
            Err(_) => Err(WorkspaceError::storage_unavailable()),
        }
    }
}

/// The user's home folder: `HOME`, or `USERPROFILE` on Windows. `None` when it is unset or
/// not an absolute path, so nothing is ever written relative to the working directory.
#[cfg_attr(any(test, feature = "test-support"), allow(dead_code))]
pub(super) fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// The default meetings root: `~/CodeMie Connect/Meetings` (`%USERPROFILE%\CodeMie
/// Connect\Meetings`), visible and outside `~/Documents`, so macOS asks no folder-access question.
pub(super) fn default_meetings_root(home: &Path) -> PathBuf {
    home.join("CodeMie Connect").join("Meetings")
}

/// How long startup waits for `owner.lock` and `connect.lock`: a relaunch can start before the
/// process it replaces has exited.
pub(super) const LOCK_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Lock {
    /// `owner.lock` in the private folder: one Connect per user account.
    Owner,
    /// `connect.lock` in a custom data folder: one Connect per data folder.
    DataFolder,
}
impl Lock {
    fn in_use(self) -> &'static str {
        match self {
            Self::Owner => "Another Connect process owns this workspace. Return to its window.",
            Self::DataFolder => {
                "This data folder is in use by Connect on another Mac or another account."
            }
        }
    }
}

/// Whether a failed lock attempt means "someone else holds it" (worth waiting for).
fn is_contended(e: &io::Error) -> bool {
    e.raw_os_error().is_some() && e.raw_os_error() == fs2::lock_contended_error().raw_os_error()
}

/// Locks `path` exclusively. Waits up to `wait` only while another process holds it; any other
/// failure is reported at once with its reason.
pub(super) fn acquire_lock(path: &Path, lock: Lock, wait: Duration) -> Result<File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| WorkspaceError::storage_unavailable())?;
    let deadline = std::time::Instant::now() + wait;
    loop {
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => return Ok(file),
            Err(e) if !is_contended(&e) => {
                return Err(WorkspaceError::new(
                    "storage_unavailable",
                    format!("Connect couldn’t lock its data folder: {e}."),
                ))
            }
            Err(_) if std::time::Instant::now() >= deadline => {
                return Err(WorkspaceError::new("instance", lock.in_use()))
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

/// Resolves the data folder and opens the workspace there. Anything but a ready folder leaves
/// `core` empty so the UI shows the recovery page: nothing is created in a missing, unmarked
/// or foreign folder, and an unreadable pointer never falls back to an empty default.
pub fn startup(
    default_root: &Path,
    open: impl FnOnce(&CorePaths) -> Result<Arc<Core>>,
) -> WorkspaceState {
    let resolved = location::resolve(default_root);
    let (core, error) = if resolved.status != RootStatus::Ready {
        (None, None)
    } else {
        let paths = CorePaths {
            data: resolved.data_root.clone(),
            private: resolved.private_root.clone(),
        };
        match open(&paths) {
            Ok(core) => {
                core.start();
                (Some(core), None)
            }
            Err(error) => (None, Some(error.message)),
        }
    };
    WorkspaceState {
        core,
        error,
        resolved,
        folder_guard: Default::default(),
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::{credentials, geometry, Core};
    use super::*;
    use crate::ai::profiles::ProfileCache;
    use crate::storage::location::{LocationFile, Marker, DATA_DIR_NAME, MARKER};
    use crate::workspace::ai::tests::ready;
    use crate::workspace::ai_jobs::FakeGraph;

    pub(crate) fn open_test(paths: &CorePaths) -> Result<Arc<Core>> {
        Core::open_with(
            None,
            paths,
            Arc::new(crate::ai::fake::FakeRunner::new(vec![])),
            ProfileCache::fixed(ready()),
            Arc::new(FakeGraph::default()),
            Arc::new(crate::workspace::analytics::cli::FakeAnalyticsCli::default()),
        )
    }
    /// A marked custom data root under `parent` with the pointer in `default` aimed at it.
    pub(crate) fn custom_root(default: &Path, parent: &Path) -> PathBuf {
        let data = parent.join(DATA_DIR_NAME);
        std::fs::create_dir_all(&data).unwrap();
        let marker = Marker {
            id: "m-1".into(),
            created_at: "2026-11-17T00:00:00Z".into(),
            app_version: "test".into(),
        };
        std::fs::write(data.join(MARKER), serde_json::to_vec(&marker).unwrap()).unwrap();
        point_at(default, &data, Some("m-1"));
        data
    }
    pub(crate) fn point_at(default: &Path, data: &Path, marker: Option<&str>) {
        let loc = LocationFile {
            data_dir: Some(data.into()),
            marker_id: marker.map(Into::into),
            ..Default::default()
        };
        location::write_location(default, &loc).unwrap();
    }
    pub(crate) fn synthetic_credential() -> credentials::Credential {
        credentials::Credential {
            refresh: "synthetic-refresh".into(),
            client_id: "client".into(),
            tenant: "organizations".into(),
        }
    }
    #[cfg(unix)]
    pub(crate) fn mode(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn default_layout_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        let state = startup(&root, open_test);
        let core = state.core.expect("default folder opens");
        assert_eq!(state.resolved.status, RootStatus::Ready);
        assert!(!state.resolved.custom);
        assert_eq!(core.paths.data, root);
        assert_eq!(core.paths.private, root);
        // Exactly where earlier builds kept everything.
        assert!(root.join("workspace.sqlite").is_file());
        assert!(root.join("owner.lock").is_file());
        assert!(!root.join("connect.lock").exists());
        assert_eq!(core.paths.staging(), root.join("ai-staging"));
        assert_eq!(
            geometry::path(&core.paths.private),
            root.join("window.json")
        );
        let cid = id();
        credentials::save(&core.paths.private, &cid, &synthetic_credential()).unwrap();
        assert!(root
            .join("credentials")
            .join(format!("graph-{cid}.json"))
            .is_file());
        #[cfg(unix)]
        assert_eq!(mode(&root), 0o700);
    }

    #[test]
    fn plugin_secrets_never_share_the_plugins_folder_that_moves() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        // The default layout: data and private are one folder, so `data/plugins` is right there.
        let same = CorePaths {
            data: root.clone(),
            private: root.clone(),
        };
        assert_eq!(
            same.plugin_secrets(),
            root.join("credentials").join("plugins")
        );
        assert!(!same.plugin_secrets().starts_with(same.data.join("plugins")));
        let custom = CorePaths {
            data: dir.path().join("Drive").join(DATA_DIR_NAME),
            private: root.clone(),
        };
        assert!(custom.plugin_secrets().starts_with(&custom.private));
        assert!(!custom.plugin_secrets().starts_with(&custom.data));
    }

    #[test]
    fn staging_creates_only_its_own_folder() {
        let dir = tempfile::tempdir().unwrap();
        let paths = CorePaths {
            data: dir.path().join("Drive").join(DATA_DIR_NAME),
            private: dir.path().join("workspace"),
        };
        assert_eq!(
            paths.ensure_staging().unwrap_err().code,
            "storage_unavailable"
        );
        assert!(
            !dir.path().join("Drive").exists(),
            "the data folder is never recreated"
        );
        std::fs::create_dir_all(&paths.data).unwrap();
        let staging = paths.ensure_staging().unwrap();
        assert_eq!(staging, paths.data.join("ai-staging"));
        assert_eq!(
            paths.ensure_staging().unwrap(),
            staging,
            "an existing folder is fine"
        );
        #[cfg(unix)]
        assert_eq!(mode(&staging), 0o700);
    }

    #[test]
    fn startup_never_creates_db_in_missing_custom_root() {
        let dir = tempfile::tempdir().unwrap();
        let default = dir.path().join("workspace");
        // Missing: the drive is gone.
        let missing = dir.path().join("Drive").join(DATA_DIR_NAME);
        point_at(&default, &missing, Some("m-1"));
        let mut opened = false;
        let state = startup(&default, |p| {
            opened = true;
            open_test(p)
        });
        assert!(!opened, "nothing opens until the folder is ready");
        assert!(state.core.is_none());
        assert_eq!(state.resolved.status, RootStatus::Missing);
        assert!(!missing.exists(), "the missing folder is never created");
        assert!(
            !default.join("workspace.sqlite").exists(),
            "no silent empty default"
        );
        // No marker: a folder is there but it is not Connect's.
        let unmarked = dir.path().join("Other").join(DATA_DIR_NAME);
        std::fs::create_dir_all(&unmarked).unwrap();
        point_at(&default, &unmarked, Some("m-1"));
        let state = startup(&default, open_test);
        assert!(state.core.is_none());
        assert_eq!(state.resolved.status, RootStatus::NoMarker);
        assert_eq!(std::fs::read_dir(&unmarked).unwrap().count(), 0);
        // An unreadable pointer is not mistaken for "use the default".
        std::fs::write(default.join("location.json"), b"{not json").unwrap();
        let state = startup(&default, open_test);
        assert!(state.core.is_none());
        assert_eq!(state.resolved.status, RootStatus::PointerUnreadable);
        assert!(!default.join("workspace.sqlite").exists());
        // Core itself never creates a custom root that is gone by the time it opens.
        let paths = CorePaths {
            data: missing.clone(),
            private: default.clone(),
        };
        assert_eq!(
            open_test(&paths).err().map(|e| e.code),
            Some("storage_unavailable".into())
        );
        assert!(!missing.exists());
    }

    #[test]
    fn startup_reports_why_a_ready_folder_did_not_open() {
        let dir = tempfile::tempdir().unwrap();
        let state = startup(dir.path(), |_| {
            Err(WorkspaceError::new(
                "newer_schema",
                "Open the newer version.",
            ))
        });
        assert!(state.core.is_none());
        assert_eq!(state.error.as_deref(), Some("Open the newer version."));
    }

    #[test]
    fn locks_wait_for_a_relaunching_owner_then_give_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("owner.lock");
        let held = acquire_lock(&path, Lock::Owner, Duration::ZERO).unwrap();
        // Still held after the wait: another Connect owns it.
        let err = acquire_lock(&path, Lock::Owner, Duration::from_millis(250)).unwrap_err();
        assert_eq!(err.code, "instance");
        assert_eq!(err.message, Lock::Owner.in_use());
        // Released while we wait: the relaunch gets it.
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            drop(held);
        });
        assert!(acquire_lock(&path, Lock::Owner, Duration::from_secs(5)).is_ok());
        releaser.join().unwrap();
    }

    #[test]
    fn a_data_folder_in_use_elsewhere_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let default = dir.path().join("workspace");
        let data = custom_root(&default, &dir.path().join("Drive"));
        // Another Mac (or account) holds the folder's own lock.
        let _other =
            acquire_lock(&data.join("connect.lock"), Lock::DataFolder, Duration::ZERO).unwrap();
        let err =
            acquire_lock(&data.join("connect.lock"), Lock::DataFolder, Duration::ZERO).unwrap_err();
        assert_eq!(
            err.message,
            "This data folder is in use by Connect on another Mac or another account."
        );
        assert_ne!(err.message, Lock::Owner.in_use());
    }

    #[test]
    fn only_contention_is_worth_waiting_for() {
        assert!(is_contended(&fs2::lock_contended_error()));
        #[cfg(unix)]
        assert!(!is_contended(&io::Error::from_raw_os_error(libc::ENOLCK)));
        assert!(!is_contended(&io::Error::other("no os error")));
    }
}
