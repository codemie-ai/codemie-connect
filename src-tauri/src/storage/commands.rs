//! Data-folder commands (DESIGN.md section 8): what the recovery page and Settings show,
//! checking a picked folder, moving to it, adopting or starting empty there, removing the old
//! copy, switching back to the default folder, and restarting. All but a move work without an
//! open workspace. They are async and do their file work off the main thread, so a stalled
//! drive can't freeze the window.
use crate::plugins::caller::require_main_frame;
use crate::storage::location::{self, LocationFile, RootStatus, SystemVolume, VolumeInfo};
use crate::storage::{migrate, old_copy};
use crate::workspace::models::{Result, WorkspaceError};
use crate::workspace::{Core, WorkspaceState};
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
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
/// workspace needs to be open, and the folder it pointed at is kept as `previous`. That folder
/// is not a copy of the default one (it may hold newer data), so it can't be removed as one.
pub fn use_default_location(default_root: &Path) -> std::io::Result<LocationFile> {
    let current = location::try_read_location(default_root).unwrap_or_default();
    let next = LocationFile {
        data_dir: None,
        marker_id: None,
        previous_copied: current.data_dir.is_none() && current.previous_copied,
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

/// What holds the data-folder guard: one restart, data-folder change or old-copy removal at a
/// time, so none of them reads or writes the pointer under another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Holder {
    Restart = 1,
    Change = 2,
    Removal = 3,
}
impl Holder {
    /// What a request that finds the guard taken is told.
    fn busy(self) -> WorkspaceError {
        let message = match self {
            Self::Restart => "Connect is already restarting.",
            Self::Change => "Connect is changing its data folder and will restart in a moment.",
            Self::Removal => {
                "Connect is removing the old copy of your data. Try again in a moment."
            }
        };
        WorkspaceError::new("busy", message)
    }
}

/// The data-folder guard in [`WorkspaceState`], and who holds it.
#[derive(Debug, Default)]
pub struct FolderGuard(AtomicU8);
impl FolderGuard {
    /// Takes the guard for `holder`, or says who has it.
    pub fn claim(&self, holder: Holder) -> std::result::Result<(), Holder> {
        self.0
            .compare_exchange(0, holder as u8, Ordering::SeqCst, Ordering::SeqCst)
            .map(drop)
            .map_err(Holder::from_u8)
    }
    pub fn release(&self) {
        self.0.store(0, Ordering::SeqCst);
    }
    pub fn holder(&self) -> Option<Holder> {
        match self.0.load(Ordering::SeqCst) {
            0 => None,
            held => Some(Holder::from_u8(held)),
        }
    }
}
impl Holder {
    fn from_u8(held: u8) -> Self {
        match held {
            1 => Self::Restart,
            2 => Self::Change,
            _ => Self::Removal,
        }
    }
}

pub(crate) fn main_window_only(label: &str) -> Result<()> {
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
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T> {
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
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<StorageStatus> {
    require_main_frame(&call)?;
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
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<()> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    ensure_can_restart(&state)?;
    state
        .folder_guard
        .claim(Holder::Change)
        .map_err(Holder::busy)?;
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
        state.folder_guard.release();
    }
    result
}

/// Refuses while a restart, a data-folder change or Remove old copy holds the guard, saying
/// which.
pub(crate) fn not_restarting(state: &WorkspaceState) -> Result<()> {
    match state.folder_guard.holder() {
        Some(holder) => Err(holder.busy()),
        None => Ok(()),
    }
}

/// The folders Settings can show in Finder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    Data,
    Private,
    Logs,
    /// The data folder Connect used before the last change (`previous` in the pointer).
    Previous,
    /// The meetings root (Settings › Meetings), opened so its meeting folders are in view.
    Meetings,
    /// One meeting's folder, opened so its files are in view.
    Meeting,
}
impl Place {
    pub fn parse(which: &str) -> Result<Self> {
        match which {
            "data" => Ok(Self::Data),
            "private" => Ok(Self::Private),
            "logs" => Ok(Self::Logs),
            "previous" => Ok(Self::Previous),
            _ => Err(WorkspaceError::new("validation", "Unknown folder.")),
        }
    }
}

/// `open -R` selects a data folder in its parent's Finder window; the logs folder and meeting
/// folders open, so their files are in view.
pub fn reveal_command(place: Place, path: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = Vec::new();
    if !matches!(place, Place::Logs | Place::Meetings | Place::Meeting) {
        args.push(OsString::from("-R"));
    }
    args.push(path.as_os_str().to_owned());
    (PathBuf::from("/usr/bin/open"), args)
}

/// `~/Library/Logs/CodeMie`: the folder of the session log.
pub fn logs_folder(log_file: &Path) -> PathBuf {
    log_file.parent().unwrap_or(log_file).to_path_buf()
}
pub(crate) fn logs_dir() -> PathBuf {
    logs_folder(Path::new(&crate::commands::logger::log_path()))
}

/// The user's home folder, for the cloud-sync checks.
fn home_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .home_dir()
        .ok()
        .or_else(|| Some(crate::ai::discover::home_dir()))
        .unwrap_or_default()
}

/// Where the workspace data is now: the open workspace's folder, else the one startup resolved.
fn current_data_root(state: &WorkspaceState) -> PathBuf {
    state
        .core
        .as_ref()
        .map(|c| c.paths.data.clone())
        .unwrap_or_else(|| state.resolved.data_root.clone())
}

/// Settings → Data location: the data, private and logs folders, the data folder's size and
/// the old copy a move left behind.
#[tauri::command]
pub async fn data_location_get(
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<old_copy::LocationInfo> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    not_restarting(&state)?;
    let root = state.resolved.private_root.clone();
    blocking(move || old_copy::location_info(&root, &logs_dir())).await
}

/// What Connect can do with a folder the user picked: move, use the data there, start empty.
#[tauri::command]
pub async fn data_location_check(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
    path: PathBuf,
) -> Result<migrate::Check> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    not_restarting(&state)?;
    let (private, data, open) = (
        state.resolved.private_root.clone(),
        current_data_root(&state),
        state.core.is_some(),
    );
    let home = home_dir(&app);
    blocking(move || {
        let places = migrate::Places {
            private_root: &private,
            data_root: &data,
            home: &home,
        };
        // A workspace whose folder broke while it ran can't be copied from.
        let open = migrate::workspace_usable(open, &private);
        migrate::check(&places, &path, open, &SystemVolume)
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct Restarting {
    restarting: bool,
}

/// The pointer names the new folder but Connect couldn't restart itself: nothing is lost, and
/// the next start opens the new folder.
fn restart_failed() -> WorkspaceError {
    WorkspaceError::new(
        "restart_failed",
        "Your data folder was changed. Connect couldn’t restart itself: quit Connect and open it again to finish.",
    )
}

/// Moves the data to, adopts or starts empty in the picked folder, then restarts Connect.
#[tauri::command]
pub async fn data_location_change(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
    path: PathBuf,
    mode: migrate::Mode,
    accept_no_permissions: Option<bool>,
) -> Result<Restarting> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    ensure_can_restart(&state)?;
    state
        .folder_guard
        .claim(Holder::Change)
        .map_err(Holder::busy)?;
    let core = state.core.clone();
    let (private, data) = (
        state.resolved.private_root.clone(),
        current_data_root(&state),
    );
    let home = home_dir(&app);
    let worker = core.clone();
    let changed = blocking(move || {
        let places = migrate::Places {
            private_root: &private,
            data_root: &data,
            home: &home,
        };
        let choice = migrate::Choice {
            picked: &path,
            mode,
            acknowledged: accept_no_permissions.unwrap_or(false),
        };
        migrate::change_from_running(
            &places,
            &choice,
            worker.as_deref(),
            &SystemVolume,
            migrate::QUIESCE_WAIT,
        )
    })
    .await
    .and_then(|r| r);
    // Once the pointer is written the next start opens the new folder, so a failed restart
    // only needs the user to quit and reopen; the old data is still intact.
    let result = match changed {
        Ok(_) => relaunch(app, core).await.map_err(|_| restart_failed()),
        Err(e) => Err(e),
    };
    if result.is_err() {
        state.folder_guard.release();
    }
    result.map(|()| Restarting { restarting: true })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    removed_bytes: u64,
}

/// Deletes Connect's own files from the old data folder, after the user confirmed. Holds the
/// data-folder guard while it reads and rewrites the pointer, so a change, "Use the default
/// folder" or a restart can't run at the same time and have its pointer overwritten.
#[tauri::command]
pub async fn data_location_remove_old(
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Removed> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    state
        .folder_guard
        .claim(Holder::Removal)
        .map_err(Holder::busy)?;
    let root = state.resolved.private_root.clone();
    let removed = blocking(move || old_copy::remove_old(&root)).await;
    state.folder_guard.release();
    Ok(Removed {
        removed_bytes: removed??,
    })
}

/// Shows the data, private or logs folder in Finder.
#[tauri::command]
pub async fn data_location_reveal(
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
    which: String,
) -> Result<()> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    not_restarting(&state)?;
    let place = Place::parse(&which)?;
    let private = state.resolved.private_root.clone();
    blocking(move || reveal(place, &place_path(place, &private, &logs_dir())?)).await?
}

/// Where a place is now: the data folder the pointer resolves to, the default folder, the logs
/// folder, or the previous data folder the pointer remembers.
pub fn place_path(place: Place, private_root: &Path, logs: &Path) -> Result<PathBuf> {
    Ok(match place {
        Place::Data => location::resolve(private_root).data_root,
        Place::Private => private_root.to_path_buf(),
        Place::Logs => logs.to_path_buf(),
        Place::Previous => location::read_location(private_root)
            .previous
            .ok_or_else(|| WorkspaceError::new("not_found", "There is no previous data folder."))?,
        // Meeting folders come from the workspace (`meetings_reveal`), never from here.
        Place::Meetings | Place::Meeting => {
            return Err(WorkspaceError::new("validation", "Unknown folder."))
        }
    })
}

/// Asks for a folder with the system folder picker, as a sheet on the window. `None` when the
/// user cancels. `rfd` opens the panel on the main thread, as macOS requires, and the command
/// waits for the answer elsewhere.
#[tauri::command]
pub async fn data_location_pick(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Option<String>> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    not_restarting(&state)?;
    pick_folder(
        &app,
        window,
        home_dir(&app),
        "Choose where Connect keeps its data",
    )
    .await
}

/// Asks for the folder Connect keeps meeting folders in (Settings › Meetings › Transcripts &
/// folders), as a sheet on the window. `None` when the user cancels. Saving the folder goes
/// through `settings_update {meetings: {root}}`, which checks it; meetings saved before keep
/// their folders.
#[tauri::command]
pub async fn meetings_root_pick(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Option<String>> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    let root = state.core.as_ref().and_then(|core| {
        let settings = core.repo().ok()?.settings().ok()?.meetings;
        core.meetings_root(&settings).ok().map(|(root, _)| root)
    });
    let start = meetings_picker_start(root.as_deref(), &home_dir(&app));
    pick_folder(
        &app,
        window,
        start,
        "Choose where Connect keeps meeting folders",
    )
    .await
}

/// Where the meetings folder picker opens: the meetings folder, else the folder it would be
/// made in (the default one is made on the first save), else home.
pub fn meetings_picker_start(root: Option<&Path>, home: &Path) -> PathBuf {
    root.into_iter()
        .flat_map(|r| [Some(r), r.parent()])
        .flatten()
        .find(|dir| dir.is_dir())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.to_path_buf())
}

#[cfg(any(target_os = "macos", windows))]
pub(crate) async fn pick_folder(
    app: &tauri::AppHandle,
    window: tauri::WebviewWindow,
    start: PathBuf,
    title: &str,
) -> Result<Option<String>> {
    let unavailable = || WorkspaceError::new("io", "Connect couldn’t open the folder picker.");
    let (tx, rx) = tokio::sync::oneshot::channel();
    let title = title.to_string();
    app.run_on_main_thread(move || {
        let picking = rfd::AsyncFileDialog::new()
            .set_parent(&window)
            .set_title(title)
            .set_can_create_directories(true)
            .set_directory(start)
            .pick_folder();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(picking.await);
        });
    })
    .map_err(|_| unavailable())?;
    let picked = rx.await.map_err(|_| unavailable())?;
    Ok(picked.map(|folder| folder.path().to_string_lossy().into_owned()))
}
#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) async fn pick_folder(
    _app: &tauri::AppHandle,
    _window: tauri::WebviewWindow,
    _start: PathBuf,
    _title: &str,
) -> Result<Option<String>> {
    Err(WorkspaceError::new(
        "unsupported",
        "Choosing a folder is available on macOS and Windows.",
    ))
}

#[cfg(target_os = "macos")]
pub(crate) fn reveal(place: Place, path: &Path) -> Result<()> {
    if !path.exists() {
        return Err(WorkspaceError::new(
            "not_found",
            "That folder doesn’t exist right now.",
        ));
    }
    let (program, args) = reveal_command(place, path);
    let shown = std::process::Command::new(program)
        .args(args)
        .status()
        .is_ok_and(|s| s.success());
    if shown {
        Ok(())
    } else {
        Err(WorkspaceError::new("io", "Connect couldn’t open Finder."))
    }
}
/// File Explorer: `/select,` shows a data folder in its parent's window; the logs folder and
/// meeting folders open. Explorer answers 1 even when it worked, so only a failed start counts.
#[cfg(windows)]
pub(crate) fn reveal(place: Place, path: &Path) -> Result<()> {
    if !path.exists() {
        return Err(WorkspaceError::new(
            "not_found",
            "That folder doesn’t exist right now.",
        ));
    }
    let mut arg = OsString::new();
    if !matches!(place, Place::Logs | Place::Meetings | Place::Meeting) {
        arg.push("/select,");
    }
    arg.push(path);
    std::process::Command::new("explorer.exe")
        .arg(arg)
        .status()
        .map(drop)
        .map_err(|_| WorkspaceError::new("io", "Connect couldn’t open File Explorer."))
}
#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) fn reveal(_place: Place, _path: &Path) -> Result<()> {
    Err(WorkspaceError::new(
        "unsupported",
        "Showing folders is available on macOS and Windows.",
    ))
}

/// Releases the workspace and starts Connect again, so the data folder is resolved afresh. A
/// second call while the first is under way does nothing; during a data-folder change or a
/// removal it is refused with the reason.
#[tauri::command]
pub async fn app_relaunch(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<()> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    ensure_can_restart(&state)?;
    match state.folder_guard.claim(Holder::Restart) {
        Ok(()) => {}
        Err(Holder::Restart) => return Ok(()),
        Err(other) => return Err(other.busy()),
    }
    let result = relaunch(app, state.core.clone()).await;
    if result.is_err() {
        state.folder_guard.release();
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
    fn meetings_picker_opens_at_the_meetings_folder_or_the_nearest_one_there() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let parent = home.join("CodeMie Connect");
        let root = parent.join("Meetings");
        std::fs::create_dir_all(&home).unwrap();
        // The default folder is made on the first save: before that, its parent, else home.
        assert_eq!(meetings_picker_start(Some(&root), &home), home);
        std::fs::create_dir_all(&parent).unwrap();
        assert_eq!(meetings_picker_start(Some(&root), &home), parent);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(meetings_picker_start(Some(&root), &home), root);
        // No workspace open (or no home): home.
        assert_eq!(meetings_picker_start(None, &home), home);
    }

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
                // An earlier move left a copy of the default folder.
                previous: Some(default.clone()),
                previous_copied: true,
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
        assert!(
            !loc.previous_copied,
            "the custom folder may hold newer data: it is not a copy"
        );
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
    fn the_data_folder_guard_has_one_holder_and_names_it() {
        let guard = FolderGuard::default();
        assert_eq!(guard.holder(), None);
        assert_eq!(guard.claim(Holder::Removal), Ok(()));
        // Everything else is refused while the old copy is removed, and told so.
        for other in [Holder::Restart, Holder::Change, Holder::Removal] {
            assert_eq!(guard.claim(other), Err(Holder::Removal));
        }
        assert_eq!(guard.holder(), Some(Holder::Removal));
        assert!(Holder::Removal.busy().message.contains("old copy"));
        guard.release();
        assert_eq!(guard.claim(Holder::Change), Ok(()));
        assert_eq!(guard.claim(Holder::Restart), Err(Holder::Change));
        assert!(Holder::Change
            .busy()
            .message
            .contains("changing its data folder"));
        guard.release();
        // A second restart request finds the first one holding the guard.
        assert_eq!(guard.claim(Holder::Restart), Ok(()));
        assert_eq!(guard.claim(Holder::Restart), Err(Holder::Restart));
        assert_eq!(
            Holder::Restart.busy().message,
            "Connect is already restarting."
        );
        for holder in [Holder::Restart, Holder::Change, Holder::Removal] {
            assert_eq!(Holder::from_u8(holder as u8), holder);
            assert_eq!(holder.busy().code, "busy");
        }
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
    fn reveal_shows_each_folder_in_finder() {
        let data = Path::new("/Volumes/Drive \"A\"/CodeMie Connect Data");
        let (program, args) = reveal_command(Place::Data, data);
        assert_eq!(program, Path::new("/usr/bin/open"));
        assert_eq!(
            args,
            vec![OsString::from("-R"), data.as_os_str().to_owned()]
        );
        let (_, args) = reveal_command(Place::Private, Path::new("/Users/u/workspace"));
        assert_eq!(args[0], "-R");
        let (_, args) = reveal_command(Place::Previous, data);
        assert_eq!(args[0], "-R");
        assert_eq!(Place::parse("previous").unwrap(), Place::Previous);
        // The logs folder opens, so its files are in view.
        let logs = Path::new("/Users/u/Library/Logs/CodeMie");
        let (_, args) = reveal_command(Place::Logs, logs);
        assert_eq!(args, vec![logs.as_os_str().to_owned()]);
        // Meeting folders and their root open too; the UI can't name them through `parse`.
        let meeting = Path::new("/Users/u/CodeMie Connect/Meetings/2026-11-04_160426-sync");
        let (_, args) = reveal_command(Place::Meeting, meeting);
        assert_eq!(args, vec![meeting.as_os_str().to_owned()]);
        let (_, args) = reveal_command(Place::Meetings, meeting.parent().unwrap());
        assert_eq!(args.len(), 1);
        assert_eq!(Place::parse("meetings").unwrap_err().code, "validation");
        assert_eq!(
            place_path(Place::Meeting, Path::new("/x"), Path::new("/y"))
                .unwrap_err()
                .code,
            "validation"
        );
        assert_eq!(Place::parse("data").unwrap(), Place::Data);
        assert_eq!(Place::parse("private").unwrap(), Place::Private);
        assert_eq!(Place::parse("logs").unwrap(), Place::Logs);
        assert_eq!(Place::parse("credentials").unwrap_err().code, "validation");
        assert_eq!(
            logs_folder(Path::new(
                "/Users/u/Library/Logs/CodeMie/codemie_wizard.log"
            )),
            logs
        );
    }

    /// The `data_location_get` and `data_location_check` responses the UI reads, written from
    /// the real functions so the UI fixtures can't drift. Paths are mapped onto a made-up home
    /// folder and drive, and sizes and free space are pinned. Regenerate with
    /// `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
    #[test]
    fn contract_fixtures_match_the_real_data_location() {
        use crate::storage::migrate::tests::{marked_root, Vol, WAIT};
        use crate::storage::migrate::{self, Choice, Mode, Places};
        use crate::storage::old_copy::{location_info, remove_old};
        use crate::workspace::{open_for_tests, startup};
        use std::fs;

        let home_dir = tempfile::tempdir().unwrap();
        let drive_dir = tempfile::tempdir().unwrap();
        let home = home_dir.path().to_path_buf();
        let default = home.join("Library/Application Support/com.epam.codemie.installer/workspace");
        let logs = home.join("Library/Logs/CodeMie");
        let projects = drive_dir.path().join("Projects");
        let icloud = home.join("Library/Mobile Documents/com~apple~CloudDocs/Work");
        for dir in [&logs, &projects, &icloud] {
            fs::create_dir_all(dir).unwrap();
        }
        let archive = drive_dir.path().join("Archive");
        let archived = marked_root(&archive, "8d1f2c3e-5b7a-4c9d-9e0f-1a2b3c4d5e6f");
        let info = || json(&location_info(&default, &logs));
        let apfs = Vol("apfs", 1 << 40);
        let mut fixtures = Vec::new();

        let core = startup(&default, open_for_tests).core.unwrap();
        fixtures.push(("location-default.json", info()));
        {
            let places = Places {
                private_root: &default,
                data_root: &core.paths.data,
                home: &home,
            };
            let check = |picked: &Path, open: bool, vol: &Vol| {
                json(&migrate::check(&places, picked, open, vol))
            };
            let required = migrate::check(&places, &projects, true, &apfs).required_bytes;
            fixtures.extend([
                ("check-ok.json", check(&projects, true, &apfs)),
                ("check-cloud.json", check(&icloud, true, &apfs)),
                (
                    "check-network.json",
                    check(&projects, true, &Vol("smbfs", 1 << 40)),
                ),
                (
                    "check-exfat.json",
                    check(&projects, true, &Vol("exfat", 1 << 40)),
                ),
                (
                    "check-tight.json",
                    check(&projects, true, &Vol("apfs", required + 1)),
                ),
                ("check-existing.json", check(&archive, true, &apfs)),
                ("check-existing-data.json", check(&archived, true, &apfs)),
                ("check-recovery.json", check(&projects, false, &apfs)),
            ]);
            // A move to the drive: the default folder keeps a copy.
            let choice = Choice {
                picked: &projects,
                mode: Mode::Move,
                acknowledged: false,
            };
            migrate::change(&places, &choice, Some(&core), &apfs, WAIT).unwrap();
        }
        fixtures.push(("location-custom-copied.json", info()));
        // Connect restarts on the drive, and Remove old copy deletes the copy.
        core.release_for_restart();
        let core = startup(&default, open_for_tests).core.unwrap();
        remove_old(&default).unwrap();
        fixtures.push(("location-custom.json", info()));
        // "Use the default folder": the drive's folder is kept as the previous one, not a copy.
        core.release_for_restart();
        use_default_location(&default).unwrap();
        fixtures.push(("location-default-previous.json", info()));
        // Back on the drive with "Use the Connect data already there": the default folder is
        // the previous one, and not a copy either.
        let core = startup(&default, open_for_tests).core.unwrap();
        let places = Places {
            private_root: &default,
            data_root: &core.paths.data,
            home: &home,
        };
        let choice = Choice {
            picked: &projects,
            mode: Mode::Adopt,
            acknowledged: false,
        };
        migrate::change(&places, &choice, Some(&core), &apfs, WAIT).unwrap();
        fixtures.push(("location-custom-adopted.json", info()));
        core.release_for_restart();

        // Made-up places instead of the temporary folders: the resolved form first, since the
        // plain one is part of it.
        let places = [
            (drive_dir.path(), "/Volumes/Work Drive"),
            (home_dir.path(), "/Users/taylor"),
        ];
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/test/fixtures/contract");
        let update = std::env::var("UPDATE_CONTRACT_FIXTURES").is_ok_and(|v| v == "1");
        for (name, mut value) in fixtures {
            pin_sizes(
                &mut value,
                name == "check-tight.json",
                name == "check-recovery.json",
            );
            let mut text = serde_json::to_string_pretty(&value).unwrap() + "\n";
            for (real, shown) in places {
                let resolved = location::canonical(real);
                text = text
                    .replace(resolved.to_str().unwrap(), shown)
                    .replace(real.to_str().unwrap(), shown);
            }
            assert!(
                !text.contains("tmp"),
                "{name} names a temporary folder: {text}"
            );
            let path = dir.join(name);
            if update {
                fs::create_dir_all(&dir).unwrap();
                fs::write(&path, &text).unwrap();
            } else {
                let saved = fs::read_to_string(&path).unwrap_or_default();
                assert_eq!(
                    saved, text,
                    "{name} is stale: run UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures"
                );
            }
        }
    }

    fn json<T: Serialize>(response: &T) -> serde_json::Value {
        serde_json::to_value(response).unwrap()
    }

    /// Fixed sizes, so the fixtures don't depend on SQLite's file sizes: 46 MiB of data on a
    /// roomy disk; a tight disk has less free than a move needs; in recovery the data folder is
    /// out of reach, so it measures nothing.
    fn pin_sizes(value: &mut serde_json::Value, tight: bool, recovery: bool) {
        const DATA: u64 = 48_234_496;
        let data = if recovery { 0 } else { DATA };
        let o = value.as_object_mut().unwrap();
        if o.contains_key("sizeBytes") {
            o.insert("sizeBytes".into(), DATA.into());
            let previous = if o["previousExists"] == true { DATA } else { 0 };
            o.insert("previousSizeBytes".into(), previous.into());
        }
        if o.contains_key("requiredBytes") {
            o.insert("requiredBytes".into(), data.into());
            o.insert(
                "neededBytes".into(),
                crate::storage::migrate::space_for_move(data).into(),
            );
            if tight {
                o.insert("freeBytes".into(), 72_000_000u64.into());
            }
        }
    }

    #[test]
    fn each_place_resolves_from_the_pointer() {
        let dir = tempfile::tempdir().unwrap();
        let default = dir.path().join("workspace");
        let logs = dir.path().join("Logs");
        let custom = dir.path().join("Drive").join(DATA_DIR_NAME);
        std::fs::create_dir_all(&default).unwrap();
        // The default folder, with nothing before it.
        assert_eq!(place_path(Place::Data, &default, &logs).unwrap(), default);
        assert_eq!(
            place_path(Place::Private, &default, &logs).unwrap(),
            default
        );
        assert_eq!(place_path(Place::Logs, &default, &logs).unwrap(), logs);
        assert_eq!(
            place_path(Place::Previous, &default, &logs)
                .unwrap_err()
                .code,
            "not_found"
        );
        // After a move: the data folder is the custom one, the previous one is the default.
        location::write_location(
            &default,
            &LocationFile {
                data_dir: Some(custom.clone()),
                marker_id: Some("m-1".into()),
                previous: Some(default.clone()),
                previous_copied: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(place_path(Place::Data, &default, &logs).unwrap(), custom);
        assert_eq!(
            place_path(Place::Private, &default, &logs).unwrap(),
            default
        );
        assert_eq!(
            place_path(Place::Previous, &default, &logs).unwrap(),
            default
        );
    }

    #[test]
    fn a_change_whose_restart_failed_says_the_folder_changed() {
        let e = restart_failed();
        assert_eq!(e.code, "restart_failed");
        assert!(e.message.starts_with("Your data folder was changed."));
        assert!(e.message.contains("open it again"));
    }

    /// Ruling R23: no dependency may put a script in the window that replaces `window.alert` or
    /// `window.confirm` (tauri-plugin-dialog does), so the folder picker uses `rfd` directly.
    #[test]
    fn the_folder_picker_adds_no_script_to_the_window() {
        let manifest = include_str!("../../Cargo.toml");
        let lock = include_str!("../../Cargo.lock");
        let depends = |name: &str| manifest.lines().any(|l| l.trim_start().starts_with(name));
        assert!(!depends("tauri-plugin-dialog"));
        assert!(depends("rfd"));
        assert!(!lock.contains("name = \"tauri-plugin-dialog\""));
        assert!(lock.contains("name = \"rfd\""));
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
