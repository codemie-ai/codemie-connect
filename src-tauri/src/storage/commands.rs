//! Data-folder commands that work with or without an open workspace (DESIGN.md section 8):
//! what the recovery page shows, switching back to the default folder, and restarting. They are
//! async and do their file work off the main thread, so a stalled drive can't freeze the window.
use crate::storage::location::{self, LocationFile, RootStatus, SystemVolume, VolumeInfo};
use crate::workspace::models::{Result, WorkspaceError};
use crate::workspace::{Core, WorkspaceState};
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// What the recovery page (and later Settings) shows about the data folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub status: RootStatus,
    pub data_root: PathBuf,
    pub private_root: PathBuf,
    pub custom: bool,
    pub default_root: PathBuf,
    /// A reason more precise than the status alone (why it didn't open, a full disk, the folder
    /// is back). Shown whenever present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
}

/// Below this much free space the data folder's disk counts as full: SQLite can't grow.
const LOW_SPACE: u64 = 64 * 1024 * 1024;

/// Resolves the folder again, so a drive that went away while Connect ran reads as missing.
/// `open_error` is why a ready folder did not open; `open` is whether a workspace is running.
pub fn storage_status_of(
    default_root: &Path,
    open_error: Option<String>,
    open: bool,
    vol: &dyn VolumeInfo,
) -> StorageStatus {
    let live = location::resolve(default_root);
    let there = matches!(live.status, RootStatus::Ready | RootStatus::NotWritable);
    // statfs is unix-only; elsewhere free space reads as 0, which means "unknown".
    let full = cfg!(unix) && there && vol.free_bytes(&live.data_root) < LOW_SPACE;
    let back = live.status == RootStatus::Ready && !open;
    let issue = open_error
        .or_else(|| full.then(|| "The disk that holds your data folder is full.".into()))
        .or_else(|| back.then(|| "Your data folder is available again. Retry to open it.".into()));
    StorageStatus {
        status: live.status,
        data_root: live.data_root,
        private_root: live.private_root,
        custom: live.custom,
        default_root: default_root.into(),
        issue,
    }
}

/// Points Connect back at its default folder. Only the pointer changes: nothing moves, no
/// workspace needs to be open, and the folder it pointed at is kept as `previous`.
pub fn use_default_location(default_root: &Path) -> std::io::Result<LocationFile> {
    let current = location::try_read_location(default_root).unwrap_or_default();
    let next = LocationFile {
        data_dir: None,
        marker_id: None,
        previous: current.data_dir.or(current.previous),
        ..Default::default()
    };
    location::write_location(default_root, &next)?;
    Ok(next)
}

/// Waits for process `$1` to exit, then opens the app bundle `$2` as a new instance. Paths
/// travel as arguments, never inside the script.
const RELAUNCH_SCRIPT: &str =
    "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open -n \"$2\"";

/// The detached helper that reopens Connect once this process (`pid`) has exited (ruling R19).
pub fn relaunch_command(pid: u32, bundle: &Path) -> (PathBuf, Vec<OsString>) {
    (
        PathBuf::from("/bin/sh"),
        vec![
            "-c".into(),
            RELAUNCH_SCRIPT.into(),
            "codemie-relaunch".into(),
            pid.to_string().into(),
            bundle.as_os_str().to_owned(),
        ],
    )
}

/// The `.app` bundle of an executable laid out as `<bundle>.app/Contents/MacOS/<exe>`; `None`
/// for anything else (a development build), which falls back to a plain restart.
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

/// True for the first caller only; once a restart is under way, later ones do nothing.
fn begin_relaunch(flag: &AtomicBool) -> bool {
    !flag.swap(true, Ordering::SeqCst)
}

fn main_window_only(label: &str) -> Result<()> {
    if label == "main" {
        Ok(())
    } else {
        Err(WorkspaceError::new(
            "permission_required",
            "Only the main Connect window can do this.",
        ))
    }
}

fn ensure_can_restart(state: &WorkspaceState) -> Result<()> {
    if state
        .core
        .as_ref()
        .is_some_and(|c| c.installer_busy.load(Ordering::Relaxed))
    {
        return Err(WorkspaceError::new(
            "busy",
            "Setup is still running. Let it finish, then restart Connect.",
        ));
    }
    Ok(())
}

/// Runs file work on the blocking pool, off the main thread and the async workers.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| WorkspaceError::new("io", "Connect couldn’t finish that. Try again."))
}

#[cfg(unix)]
fn spawn_detached(program: &Path, args: &[OsString]) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    std::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(drop)
}
#[cfg(not(unix))]
fn spawn_detached(_program: &Path, _args: &[OsString]) -> std::io::Result<()> {
    Err(std::io::ErrorKind::Unsupported.into())
}

/// Lets go of the workspace (best effort) and starts Connect again: on macOS through a helper
/// that reopens the bundle once this process has exited, elsewhere with Tauri's restart.
async fn relaunch(app: tauri::AppHandle, core: Option<Arc<Core>>) -> Result<()> {
    let helper = if cfg!(target_os = "macos") {
        std::env::current_exe()
            .ok()
            .and_then(|exe| app_bundle(&exe))
            .map(|bundle| relaunch_command(std::process::id(), &bundle))
    } else {
        None
    };
    if let Some((program, args)) = &helper {
        spawn_detached(program, args).map_err(|_| {
            WorkspaceError::new(
                "io",
                "Connect couldn’t restart itself. Quit and open it again.",
            )
        })?;
    }
    blocking(move || {
        if let Some(core) = core {
            core.release_for_restart();
        }
    })
    .await?;
    if helper.is_some() {
        app.exit(0);
        Ok(())
    } else {
        app.restart()
    }
}

/// Where the data folder stands, for the recovery page.
#[tauri::command]
pub async fn storage_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<StorageStatus> {
    main_window_only(window.label())?;
    let (root, error, open) = (
        state.resolved.private_root.clone(),
        state.error.clone(),
        state.core.is_some(),
    );
    blocking(move || storage_status_of(&root, error, open, &SystemVolume)).await
}

/// Rewrites the pointer to the default folder, then restarts.
#[tauri::command]
pub async fn data_location_use_default(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<()> {
    main_window_only(window.label())?;
    ensure_can_restart(&state)?;
    if !begin_relaunch(&state.relaunching) {
        return Err(WorkspaceError::new(
            "busy",
            "Connect is already restarting.",
        ));
    }
    let root = state.resolved.private_root.clone();
    let switched = blocking(move || use_default_location(&root))
        .await
        .and_then(|r| {
            r.map_err(|e| {
                WorkspaceError::new(
                    "io",
                    format!("Connect couldn’t switch to the default folder: {e}."),
                )
            })
        });
    let result = match switched {
        Ok(_) => relaunch(app, state.core.clone()).await,
        Err(e) => Err(e),
    };
    if result.is_err() {
        state.relaunching.store(false, Ordering::SeqCst);
    }
    result
}

/// Releases the workspace and starts Connect again, so the data folder is resolved afresh. A
/// second call while the first is under way does nothing.
#[tauri::command]
pub async fn app_relaunch(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<()> {
    main_window_only(window.label())?;
    ensure_can_restart(&state)?;
    if !begin_relaunch(&state.relaunching) {
        return Ok(());
    }
    let result = relaunch(app, state.core.clone()).await;
    if result.is_err() {
        state.relaunching.store(false, Ordering::SeqCst);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::location::{read_location, try_read_location, LocationFile, DATA_DIR_NAME};

    /// A volume with a fixed amount of free space.
    struct Space(u64);
    impl VolumeInfo for Space {
        fn fs_type(&self, _: &Path) -> String {
            "apfs".into()
        }
        fn free_bytes(&self, _: &Path) -> u64 {
            self.0
        }
    }
    const ROOMY: Space = Space(100 * 1024 * 1024 * 1024);

    #[test]
    fn use_default_rewrites_pointer_without_core() {
        let dir = tempfile::tempdir().unwrap();
        let default = dir.path().join("workspace");
        let custom = dir.path().join("Drive").join(DATA_DIR_NAME);
        location::write_location(
            &default,
            &LocationFile {
                data_dir: Some(custom.clone()),
                marker_id: Some("m-1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        // The custom folder is gone and no workspace is open: only the pointer changes.
        use_default_location(&default).unwrap();
        let loc = try_read_location(&default).unwrap();
        assert_eq!(loc.data_dir, None);
        assert_eq!(loc.marker_id, None);
        assert_eq!(loc.previous, Some(custom.clone()));
        assert!(!custom.exists());
        assert_eq!(
            location::resolve(&default).status,
            location::RootStatus::Ready
        );

        // A corrupt pointer is kept aside, not lost.
        std::fs::write(default.join("location.json"), b"{broken").unwrap();
        use_default_location(&default).unwrap();
        assert_eq!(read_location(&default).data_dir, None);
        let kept = std::fs::read_dir(&default)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("location.json.bad-")
            })
            .count();
        assert_eq!(kept, 1);

        // A pointer that cannot be written is reported, not ignored.
        std::fs::remove_file(default.join("location.json")).unwrap();
        std::fs::create_dir(default.join("location.json")).unwrap();
        assert!(use_default_location(&default).is_err());
    }

    #[test]
    fn storage_status_reports_the_live_folder_and_the_open_error() {
        let dir = tempfile::tempdir().unwrap();
        let default = dir.path().join("workspace");
        let custom = dir.path().join("Drive").join(DATA_DIR_NAME);
        location::write_location(
            &default,
            &LocationFile {
                data_dir: Some(custom.clone()),
                marker_id: Some("m-1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let status = storage_status_of(&default, None, false, &ROOMY);
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["status"], "missing");
        assert_eq!(json["dataRoot"], custom.to_string_lossy().as_ref());
        assert_eq!(json["privateRoot"], default.to_string_lossy().as_ref());
        assert_eq!(json["defaultRoot"], default.to_string_lossy().as_ref());
        assert_eq!(json["custom"], true);
        assert!(json.get("issue").is_none());

        // The default folder is ready but the workspace did not open: say why.
        let other = tempfile::tempdir().unwrap();
        let status = storage_status_of(
            other.path(),
            Some("Another Connect owns it.".into()),
            false,
            &ROOMY,
        );
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["status"], "ready");
        assert_eq!(json["custom"], false);
        assert_eq!(json["issue"], "Another Connect owns it.");

        // A folder that came back while the recovery page was up only needs a restart.
        let status = storage_status_of(other.path(), None, false, &ROOMY);
        assert!(status.issue.unwrap().contains("Retry"));
        // A running workspace with a ready folder has nothing to report.
        assert!(storage_status_of(other.path(), None, true, &ROOMY)
            .issue
            .is_none());
    }

    #[test]
    fn a_full_disk_is_named_more_precisely_than_the_status() {
        let dir = tempfile::tempdir().unwrap();
        let full = Space(1024);
        // The workspace is running and the folder looks ready, but writes fail: the disk is full.
        let status = storage_status_of(dir.path(), None, true, &full);
        assert_eq!(status.status, RootStatus::Ready);
        assert_eq!(
            status.issue.as_deref(),
            Some("The disk that holds your data folder is full.")
        );
        // Why the workspace did not open still comes first.
        let status = storage_status_of(dir.path(), Some("Newer schema.".into()), false, &full);
        assert_eq!(status.issue.as_deref(), Some("Newer schema."));
        // A missing folder has no disk to measure.
        let default = dir.path().join("workspace");
        location::write_location(
            &default,
            &LocationFile {
                data_dir: Some(dir.path().join("Drive").join(DATA_DIR_NAME)),
                marker_id: Some("m-1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(storage_status_of(&default, None, true, &full)
            .issue
            .is_none());
    }

    #[test]
    fn a_second_relaunch_request_is_a_no_op() {
        let flag = AtomicBool::new(false);
        assert!(begin_relaunch(&flag));
        assert!(!begin_relaunch(&flag));
        assert!(!begin_relaunch(&flag));
    }

    #[test]
    fn relaunch_waits_for_this_process_then_opens_the_bundle() {
        let bundle = Path::new("/Applications/CodeMie Connect \"beta\".app");
        let (program, args) = relaunch_command(4242, bundle);
        assert_eq!(program, Path::new("/bin/sh"));
        let args: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "-c".to_string(),
                "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open -n \"$2\""
                    .to_string(),
                "codemie-relaunch".to_string(),
                "4242".to_string(),
                "/Applications/CodeMie Connect \"beta\".app".to_string(),
            ]
        );
        // The path travels as an argument, never inside the script.
        assert!(!args[1].contains("Applications"));
    }

    #[test]
    fn app_bundle_needs_the_contents_macos_layout() {
        assert_eq!(
            app_bundle(Path::new(
                "/Applications/CodeMie Connect.app/Contents/MacOS/app"
            )),
            Some(PathBuf::from("/Applications/CodeMie Connect.app"))
        );
        // Anything else falls back to a plain restart: a development build, a helper elsewhere
        // in a bundle, or a folder that merely ends in `.app`.
        for exe in [
            "/repo/src-tauri/target/debug/app",
            "/Applications/CodeMie Connect.app/Contents/Resources/bin/codemie",
            "/Users/qa/tools.app/app",
            "/Users/qa/tools.app/Contents/app",
            "/Contents/MacOS/app",
            "app",
        ] {
            assert_eq!(app_bundle(Path::new(exe)), None, "{exe}");
        }
    }

    #[test]
    fn only_the_main_window_may_change_the_data_folder() {
        assert!(main_window_only("main").is_ok());
        assert_eq!(
            main_window_only("popup").unwrap_err().code,
            "permission_required"
        );
    }
}
