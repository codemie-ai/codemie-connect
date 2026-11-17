//! Data-folder commands that work with or without an open workspace (DESIGN.md section 8):
//! what the recovery page shows, switching back to the default folder, and restarting.
use crate::storage::location::{self, LocationFile, RootStatus};
use crate::workspace::models::{Result, WorkspaceError};
use crate::workspace::WorkspaceState;
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

/// What the recovery page (and later Settings) shows about the data folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub status: RootStatus,
    pub data_root: PathBuf,
    pub private_root: PathBuf,
    pub custom: bool,
    pub default_root: PathBuf,
    /// Why the workspace is not open when the folder itself looks fine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
}

/// Resolves the folder again, so a drive that went away while Connect ran reads as missing.
/// `open_error` is why a ready folder did not open; `open` is whether a workspace is running.
pub fn storage_status_of(
    default_root: &Path,
    open_error: Option<String>,
    open: bool,
) -> StorageStatus {
    let live = location::resolve(default_root);
    let back = live.status == RootStatus::Ready && !open;
    let issue = open_error
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

/// The `.app` bundle that contains the running executable; `None` for a development build.
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|a| a.extension().is_some_and(|x| x == "app"))
        .map(Path::to_path_buf)
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

/// Lets go of the workspace (best effort) and starts Connect again.
fn relaunch(app: &tauri::AppHandle, state: &WorkspaceState) -> Result<()> {
    let release = || {
        if let Some(core) = &state.core {
            core.release_for_restart();
        }
    };
    #[cfg(target_os = "macos")]
    if let Some(bundle) = std::env::current_exe().ok().and_then(|e| app_bundle(&e)) {
        let (program, args) = relaunch_command(std::process::id(), &bundle);
        spawn_detached(&program, &args).map_err(|_| {
            WorkspaceError::new(
                "io",
                "Connect couldn't restart itself. Quit and open it again.",
            )
        })?;
        release();
        app.exit(0);
        return Ok(());
    }
    release();
    app.restart()
}

/// Where the data folder stands, for the recovery page.
#[tauri::command]
pub fn storage_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<StorageStatus> {
    main_window_only(window.label())?;
    Ok(storage_status_of(
        &state.resolved.private_root,
        state.error.clone(),
        state.core.is_some(),
    ))
}

/// Rewrites the pointer to the default folder, then restarts.
#[tauri::command]
pub fn data_location_use_default(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<()> {
    main_window_only(window.label())?;
    ensure_can_restart(&state)?;
    use_default_location(&state.resolved.private_root).map_err(|e| {
        WorkspaceError::new(
            "io",
            format!("Connect couldn't switch to the default folder: {e}."),
        )
    })?;
    relaunch(&app, &state)
}

/// Releases the workspace and starts Connect again, so the data folder is resolved afresh.
#[tauri::command]
pub fn app_relaunch(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<()> {
    main_window_only(window.label())?;
    ensure_can_restart(&state)?;
    relaunch(&app, &state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::location::{read_location, try_read_location, LocationFile, DATA_DIR_NAME};

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
        let status = storage_status_of(&default, None, false);
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["status"], "missing");
        assert_eq!(json["dataRoot"], custom.to_string_lossy().as_ref());
        assert_eq!(json["privateRoot"], default.to_string_lossy().as_ref());
        assert_eq!(json["defaultRoot"], default.to_string_lossy().as_ref());
        assert_eq!(json["custom"], true);
        assert!(json.get("issue").is_none());

        // The default folder is ready but the workspace did not open: say why.
        let other = tempfile::tempdir().unwrap();
        let status =
            storage_status_of(other.path(), Some("Another Connect owns it.".into()), false);
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["status"], "ready");
        assert_eq!(json["custom"], false);
        assert_eq!(json["issue"], "Another Connect owns it.");

        // A folder that came back while the recovery page was up only needs a restart.
        let status = storage_status_of(other.path(), None, false);
        assert!(status.issue.unwrap().contains("Retry"));
        // A running workspace with a ready folder has nothing to report.
        assert!(storage_status_of(other.path(), None, true).issue.is_none());
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
    fn app_bundle_is_the_enclosing_dot_app() {
        assert_eq!(
            app_bundle(Path::new(
                "/Applications/CodeMie Connect.app/Contents/MacOS/app"
            )),
            Some(PathBuf::from("/Applications/CodeMie Connect.app"))
        );
        // A development build is not inside a bundle: the caller falls back to a plain restart.
        assert_eq!(
            app_bundle(Path::new("/repo/src-tauri/target/debug/app")),
            None
        );
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
