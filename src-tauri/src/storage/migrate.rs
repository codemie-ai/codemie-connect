//! Changing where Connect keeps its data (DESIGN.md section 8): move a copy of it to a folder
//! the user chooses, use the Connect data already in a folder, or start empty there; later,
//! remove the old copy. The pointer is written only once the new folder is complete, so a
//! failure at any earlier step leaves Connect where it was, running.

use crate::storage::location::{
    self, LocationFile, Marker, TargetIssue, VolumeInfo, DATA_DIR_NAME, MARKER,
};
use crate::workspace::models::{Result, WorkspaceError};
use crate::workspace::Core;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fmt::Display;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a change waits for background work (a sync round, an AI draft) to finish.
pub const QUIESCE_WAIT: Duration = Duration::from_secs(15);
/// Room a move leaves free on the target disk beyond the copy itself.
const HEADROOM: u64 = 64 * 1024 * 1024;
const DATABASE: &str = "workspace.sqlite";
/// Folders that move with the database. `ai-staging/` is transient: it starts empty.
const MOVING_FOLDERS: [&str; 2] = ["plugins", "automations"];
const AI_STAGING: &str = "ai-staging";
/// What Remove old copy deletes, in this order: the marker (custom folders only) goes last,
/// so an interrupted removal is still recognised as Connect's and can be retried.
const OLD_COPY: [&str; 6] = [
    "plugins",
    "automations",
    AI_STAGING,
    "workspace.sqlite-wal",
    "workspace.sqlite-shm",
    DATABASE,
];
const OLD_CUSTOM_COPY: [&str; 2] = ["connect.lock", MARKER];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Copy the data there and use the copy; the old folder is kept.
    Move,
    /// Use the Connect data already there.
    Adopt,
    /// Start with an empty workspace there.
    Fresh,
}

/// Where Connect keeps things now.
pub struct Places<'a> {
    /// The default folder: the pointer, sign-in data and the locks. It never moves.
    pub private_root: &'a Path,
    /// The folder the workspace data is in now.
    pub data_root: &'a Path,
    pub home: &'a Path,
}

/// What the user chose in the folder picker.
pub struct Choice<'a> {
    pub picked: &'a Path,
    pub mode: Mode,
    /// The user ticked "others with access to this drive can read my workspace" (exFAT, FAT).
    pub acknowledged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    pub code: &'static str,
    pub message: String,
}
impl Issue {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl From<&TargetIssue> for Issue {
    fn from(issue: &TargetIssue) -> Self {
        Self::new(issue.code(), issue.reason())
    }
}

/// What Connect can do with a picked folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// `<picked>/CodeMie Connect Data`: the folder Connect would use.
    pub target: PathBuf,
    /// The choices this folder allows; empty when Connect can't use it at all.
    pub modes: Vec<Mode>,
    pub issues: Vec<Issue>,
    /// exFAT or FAT: allowed only once the user acknowledges others can read the workspace.
    pub needs_acknowledgement: bool,
    /// The marker of the Connect data already there.
    pub existing: Option<Marker>,
    pub free_bytes: u64,
    /// What a move copies: the database, plugins and automations.
    pub required_bytes: u64,
    pub fs_type: String,
}

/// Checks a picked folder without changing anything in it (apart from a probe file that
/// `check_target` creates and removes).
pub fn check(places: &Places, picked: &Path, workspace_open: bool, vol: &dyn VolumeInfo) -> Check {
    let report = location::check_target(
        picked,
        places.data_root,
        places.private_root,
        places.home,
        vol,
    );
    let target = location::canonical(picked).join(DATA_DIR_NAME);
    let acknowledgeable = |i: &TargetIssue| matches!(i, TargetIssue::NoUnixPermissions(_));
    let mut issues: Vec<Issue> = report.issues.iter().map(Issue::from).collect();
    let blocked = report.issues.iter().any(|i| !acknowledgeable(i));
    let required_bytes = movable_bytes(places.data_root);
    let mut modes = Vec::new();
    if blocked {
        // The reasons are already in `issues`.
    } else if same_folder(&target, places.data_root) {
        issues.push(Issue::new(
            "current_folder",
            "That folder already holds your data.",
        ));
    } else if report.existing_marker.is_some() {
        modes.push(Mode::Adopt);
    } else if fs::symlink_metadata(&target).is_ok() {
        issues.push(Issue::new(
            "folder_exists",
            format!("That folder already has a “{DATA_DIR_NAME}” folder that isn’t Connect’s. Choose another folder."),
        ));
    } else {
        // statfs is unix-only; elsewhere free space reads as 0, which means "unknown".
        let roomy = !cfg!(unix) || report.free_bytes >= required_bytes.saturating_add(HEADROOM);
        if workspace_open && roomy {
            modes.push(Mode::Move);
        } else if workspace_open {
            issues.push(Issue::new(
                "not_enough_space",
                "There isn’t enough free space on that disk for your data.",
            ));
        }
        modes.push(Mode::Fresh);
    }
    Check {
        target,
        modes,
        issues,
        needs_acknowledgement: report.issues.iter().any(acknowledgeable),
        existing: report.existing_marker,
        free_bytes: report.free_bytes,
        required_bytes,
        fs_type: report.fs_type,
    }
}

/// Switches Connect to the picked folder: checks it again, holds the workspace still, builds
/// the new folder (move, fresh) or verifies the one there (adopt), then writes the pointer. The
/// caller restarts Connect. On any failure nothing is left behind in the picked folder, the
/// pointer is unchanged and the workspace runs again. Blocking: call it off the async runtime.
pub fn change(
    places: &Places,
    choice: &Choice,
    core: Option<&Core>,
    vol: &dyn VolumeInfo,
    wait: Duration,
) -> Result<PathBuf> {
    let check = check(places, choice.picked, core.is_some(), vol);
    if !check.modes.contains(&choice.mode) {
        return Err(refusal(&check, choice.mode));
    }
    if check.needs_acknowledgement && !choice.acknowledged {
        let reason = check
            .issues
            .iter()
            .find(|i| i.code == "no_permissions")
            .map(|i| i.message.clone())
            .unwrap_or_default();
        return Err(WorkspaceError::new("needs_acknowledgement", reason));
    }
    // Read-only checks of data already there come before anything stops.
    let plan = match choice.mode {
        Mode::Move => Plan::Copy,
        Mode::Fresh => Plan::Empty,
        Mode::Adopt => Plan::Adopt(adoptable(&check.target)?),
    };
    if let Some(core) = core {
        core.quiesce(wait)?;
    }
    let result = switch(places, &check.target, plan);
    if let (Err(error), Some(core)) = (&result, core) {
        if core.resume().is_err() {
            return Err(WorkspaceError::new(
                &error.code,
                format!(
                    "{} Restart Connect to open your workspace again.",
                    error.message
                ),
            ));
        }
    }
    result
}

/// Why a choice the folder doesn't allow was refused.
fn refusal(check: &Check, mode: Mode) -> WorkspaceError {
    if let Some(issue) = check.issues.iter().find(|i| i.code != "no_permissions") {
        return WorkspaceError::new("validation", issue.message.clone());
    }
    let message = match mode {
        Mode::Adopt => "There is no Connect data in that folder.",
        Mode::Move | Mode::Fresh if check.modes.contains(&Mode::Adopt) => {
            "That folder already holds Connect data. Use the data there, or choose another folder."
        }
        Mode::Move | Mode::Fresh => "Connect can move your data only while your workspace is open.",
    };
    WorkspaceError::new("validation", message)
}

/// How the new data folder comes about.
enum Plan {
    /// Build it from a copy of the current data.
    Copy,
    /// Build it with only a marker; Connect creates the database when it starts there.
    Empty,
    /// It is already there, with this marker.
    Adopt(Marker),
}

/// Builds or takes over `target` and points Connect at it. Once the pointer is written, the
/// next start opens `target`; the old data root is remembered as `previous`.
fn switch(places: &Places, target: &Path, plan: Plan) -> Result<PathBuf> {
    let (marker, created) = match plan {
        Plan::Copy => (build(target, Some(places.data_root))?, true),
        Plan::Empty => (build(target, None)?, true),
        Plan::Adopt(marker) => (marker, false),
    };
    let pointer = LocationFile {
        data_dir: Some(target.to_path_buf()),
        marker_id: Some(marker.id),
        previous: Some(places.data_root.to_path_buf()),
        ..Default::default()
    };
    if let Err(e) = location::write_location(places.private_root, &pointer) {
        if created {
            // Only the folder this call just built.
            let _ = remove_tree(target);
        }
        return Err(failed("Connect couldn’t save where your data now lives", e));
    }
    Ok(target.to_path_buf())
}

// ------------------------------------------------------------- the new folder

/// Builds the new data folder in a hidden staging folder beside `target` and renames it into
/// place once complete, so `target` never exists half-built. Copies the data from `source`
/// when given. Returns the new folder's marker; on failure the staging folder is removed.
fn build(target: &Path, source: Option<&Path>) -> Result<Marker> {
    let parent = target.parent().ok_or_else(|| {
        WorkspaceError::new("validation", "Choose a folder to keep your data in.")
    })?;
    let staging = parent.join(format!(
        ".codemie-connect-incoming-{}",
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        create_private_dir(&staging)
            .map_err(|e| failed("Connect couldn’t create a folder there", e))?;
        if let Some(source) = source {
            copy_data(source, &staging)?;
        }
        let marker = new_marker();
        location::write_marker(&staging, &marker)
            .map_err(|e| failed("Connect couldn’t mark the new data folder", e))?;
        sync_dir(&staging);
        // `rename` would quietly replace an empty folder that appeared meanwhile.
        if fs::symlink_metadata(target).is_ok() {
            return Err(WorkspaceError::new(
                "validation",
                format!(
                    "A “{DATA_DIR_NAME}” folder appeared there meanwhile. Choose the folder again."
                ),
            ));
        }
        fs::rename(&staging, target)
            .map_err(|e| failed("Connect couldn’t finish the new data folder", e))?;
        sync_dir(parent);
        Ok(marker)
    })();
    if result.is_err() {
        let _ = remove_tree(&staging);
    }
    result
}

/// Copies what moves: a verified copy of the database, then plugins and automation output
/// with their file modes. AI staging, sign-in data, the locks, `window.json` and the pointer
/// are never copied.
fn copy_data(source: &Path, staging: &Path) -> Result<()> {
    copy_database(&source.join(DATABASE), &staging.join(DATABASE))?;
    for name in MOVING_FOLDERS {
        let from = source.join(name);
        if fs::symlink_metadata(&from).is_ok() {
            copy_entry(&from, &staging.join(name))
                .map_err(|e| failed(&format!("Connect couldn’t copy your {name}"), e))?;
        }
    }
    Ok(())
}

/// `VACUUM INTO` a consistent copy of the (quiesced) database, then proves it: it opens
/// read-only, passes `integrity_check`, and has the source's revision and record count.
fn copy_database(source: &Path, copy: &Path) -> Result<()> {
    let db_failed = |e: rusqlite::Error| failed("Connect couldn’t copy your workspace database", e);
    // Never creates a database: the source must be the one Connect just closed.
    let db = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(db_failed)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(db_failed)?;
    let busy: i64 = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
        .map_err(db_failed)?;
    if busy != 0 {
        return Err(failed(
            "Connect couldn’t copy your workspace database",
            "it is still in use",
        ));
    }
    let original = tally(&db).map_err(db_failed)?;
    let into = copy.to_str().ok_or_else(|| {
        WorkspaceError::new(
            "validation",
            "Connect can’t use a folder whose path has unsupported characters.",
        )
    })?;
    db.execute("VACUUM INTO ?1", [into]).map_err(db_failed)?;
    db.close().map_err(|(_, e)| db_failed(e))?;
    // SQLite doesn't flush the file `VACUUM INTO` writes.
    fs::File::open(copy)
        .and_then(|f| f.sync_all())
        .map_err(|e| failed("Connect couldn’t save the copy of your workspace", e))?;

    let copied = Connection::open_with_flags(
        copy,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(db_failed)?;
    let verdict: String = copied
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(db_failed)?;
    if verdict != "ok" {
        return Err(failed(
            "The copy of your workspace failed its check",
            verdict,
        ));
    }
    if tally(&copied).map_err(db_failed)? != original {
        return Err(WorkspaceError::new(
            "io",
            "The copy of your workspace doesn’t match the original, so Connect kept using the original.",
        ));
    }
    Ok(())
}

/// The workspace revision and the number of records: equal in a faithful copy.
fn tally(db: &Connection) -> rusqlite::Result<(i64, i64)> {
    Ok((
        db.query_row("SELECT revision FROM meta WHERE id=1", [], |r| r.get(0))?,
        db.query_row("SELECT count(*) FROM records", [], |r| r.get(0))?,
    ))
}

/// Copies a file, folder or symlink without following symlinks. Files keep their permission
/// bits; folders get theirs last, so a read-only folder can still be filled.
fn copy_entry(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    let kind = meta.file_type();
    if kind.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_entry(&entry.path(), &to.join(entry.file_name()))?;
        }
        fs::set_permissions(to, meta.permissions())
    } else if kind.is_file() {
        fs::copy(from, to)?;
        if let Ok(file) = fs::File::open(to) {
            let _ = file.sync_all();
        }
        Ok(())
    } else if kind.is_symlink() {
        copy_symlink(from, to)
    } else {
        // Sockets and pipes hold no data.
        Ok(())
    }
}
#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)
}
#[cfg(not(unix))]
fn copy_symlink(_from: &Path, _to: &Path) -> io::Result<()> {
    Ok(())
}

fn new_marker() -> Marker {
    Marker {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        app_version: env!("CARGO_PKG_VERSION").into(),
    }
}

/// A folder only its owner can open: it will hold the workspace.
fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Best effort: flushes a folder's entries (a rename, a new file) to disk.
fn sync_dir(dir: &Path) {
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

// --------------------------------------------------------------------- adopt

/// Read-only checks of Connect data already in a folder: it is marked, no other Connect is
/// using it, and its database (if it has one yet) is one this version opens and is intact.
/// Nothing in the folder is created or changed.
fn adoptable(root: &Path) -> Result<Marker> {
    let marker = location::read_marker(root)
        .filter(|m| !m.id.trim().is_empty())
        .ok_or_else(|| {
            WorkspaceError::new("validation", "There is no Connect data in that folder.")
        })?;
    if in_use_elsewhere(root) {
        return Err(in_use());
    }
    let database = root.join(DATABASE);
    if fs::symlink_metadata(&database).is_ok() {
        verify_database(&database)?;
    }
    Ok(marker)
}

fn verify_database(path: &Path) -> Result<()> {
    let damaged = || {
        WorkspaceError::new(
            "damaged",
            "The Connect data in that folder is damaged, so Connect can’t use it.",
        )
    };
    // `immutable`: no locks, and no `-wal`/`-shm` files are created, so the folder stays
    // exactly as it was found. Unreplayed WAL frames are checked by SQLite when it opens there.
    let db = Connection::open_with_flags(
        file_uri(path, "immutable=1"),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| damaged())?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| damaged())?;
    if version > 1 {
        return Err(WorkspaceError::new(
            "newer_schema",
            "That data was used by a newer version of Connect. Update Connect, then try again.",
        ));
    }
    let verdict: String = db
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|_| damaged())?;
    if verdict != "ok" {
        return Err(damaged());
    }
    Ok(())
}

/// An SQLite `file:` URI for `path`, so query parameters can be passed.
fn file_uri(path: &Path, query: &str) -> String {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    };
    #[cfg(not(unix))]
    let bytes = path.to_string_lossy().replace('\\', "/").into_bytes();
    let mut uri = String::from("file:");
    for b in bytes {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    uri.push('?');
    uri.push_str(query);
    uri
}

/// Whether another Connect holds the folder's `connect.lock` right now. A missing lock file
/// means no one; any error other than contention is left for startup to report.
fn in_use_elsewhere(root: &Path) -> bool {
    let Ok(file) = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("connect.lock"))
    else {
        return false;
    };
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => {
            let _ = fs2::FileExt::unlock(&file);
            false
        }
        Err(e) => {
            e.raw_os_error().is_some()
                && e.raw_os_error() == fs2::lock_contended_error().raw_os_error()
        }
    }
}

fn in_use() -> WorkspaceError {
    WorkspaceError::new(
        "in_use",
        "That data folder is in use by Connect on another Mac or another account.",
    )
}

// ------------------------------------------------------------ the old copy

/// Deletes Connect's own files from the old data folder (`previous` in the pointer), then
/// forgets it. Every other file stays. In the default folder, which also holds sign-in data,
/// `owner.lock`, `window.json` and the pointer, only the workspace files go. Returns the
/// bytes removed.
pub fn remove_old(private_root: &Path) -> Result<u64> {
    let pointer = location::try_read_location(private_root).map_err(
        |location::LocationError::Unreadable(reason)| {
            WorkspaceError::new(
                "pointer_unreadable",
                format!("Connect couldn’t read where your data is kept ({reason}), so nothing was removed."),
            )
        },
    )?;
    let previous = pointer
        .previous
        .clone()
        .ok_or_else(|| WorkspaceError::new("not_found", "There is no old copy to remove."))?;
    let current = pointer.data_dir.as_deref().unwrap_or(private_root);
    let entries = old_copy(&previous, current, private_root)?;
    let mut removed = 0;
    for entry in &entries {
        let size = tree_size(entry);
        remove_tree(entry).map_err(|e| failed("Connect couldn’t remove the old copy", e))?;
        removed += size;
    }
    if !same_folder(&previous, private_root) {
        // Only if nothing of the user's is left in it.
        let _ = fs::remove_dir(&previous);
    }
    location::write_location(
        private_root,
        &LocationFile {
            previous: None,
            ..pointer
        },
    )
    .map_err(|e| {
        failed(
            "Connect removed the old copy but couldn’t update its records",
            e,
        )
    })?;
    Ok(removed)
}

/// The entries Remove old copy would delete inside `previous`, or why it deletes nothing:
/// the folder is gone, overlaps the folder in use, or doesn't look like Connect's own.
fn old_copy(previous: &Path, current: &Path, private_root: &Path) -> Result<Vec<PathBuf>> {
    if !previous.is_dir() {
        return Err(WorkspaceError::new(
            "not_found",
            "The old copy is no longer there.",
        ));
    }
    let default = same_folder(previous, private_root);
    if !default {
        // Anything but the default folder must be a marked Connect data folder outside it.
        let connects = previous.file_name().is_some_and(|n| n == DATA_DIR_NAME)
            && location::read_marker(previous).is_some()
            && !inside(previous, private_root);
        if !connects {
            return Err(WorkspaceError::new(
                "not_connect",
                "That folder doesn’t look like Connect’s data folder, so nothing was removed.",
            ));
        }
    }
    if inside(previous, current) || inside(current, previous) {
        return Err(WorkspaceError::new(
            "current_folder",
            "That folder holds the data Connect uses now, so nothing was removed.",
        ));
    }
    if !default && in_use_elsewhere(previous) {
        return Err(in_use());
    }
    let names = OLD_COPY.iter().chain(if default {
        &[][..]
    } else {
        &OLD_CUSTOM_COPY[..]
    });
    Ok(names
        .map(|name| previous.join(name))
        .filter(|p| fs::symlink_metadata(p).is_ok())
        .collect())
}

// ---------------------------------------------------------------- settings

/// What Settings shows about where Connect keeps things.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationInfo {
    pub data_root: PathBuf,
    pub private_root: PathBuf,
    pub logs: PathBuf,
    pub custom: bool,
    /// The data folder's size, without the transient AI staging folder.
    pub size_bytes: u64,
    pub previous: Option<PathBuf>,
    /// The old copy is still there and Remove old copy would delete something.
    pub previous_exists: bool,
    /// What Remove old copy would free.
    pub previous_size_bytes: u64,
}

pub fn location_info(private_root: &Path, logs: &Path) -> LocationInfo {
    let live = location::resolve(private_root);
    let previous = location::read_location(private_root).previous;
    let old = previous
        .as_deref()
        .and_then(|p| old_copy(p, &live.data_root, private_root).ok())
        .unwrap_or_default();
    LocationInfo {
        size_bytes: folder_size(&live.data_root, &[AI_STAGING]),
        data_root: live.data_root,
        private_root: live.private_root,
        logs: logs.to_path_buf(),
        custom: live.custom,
        previous,
        previous_exists: !old.is_empty(),
        previous_size_bytes: old.iter().map(|p| tree_size(p)).sum(),
    }
}

// ------------------------------------------------------------------ helpers

/// What a move copies out of a data folder.
fn movable_bytes(data_root: &Path) -> u64 {
    [DATABASE, "workspace.sqlite-wal"]
        .iter()
        .chain(MOVING_FOLDERS.iter())
        .map(|name| tree_size(&data_root.join(name)))
        .sum()
}

/// The size of a folder's contents, leaving out the named top-level entries.
fn folder_size(dir: &Path, except: &[&str]) -> u64 {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| !except.iter().any(|x| e.file_name() == *x))
                .map(|e| tree_size(&e.path()))
                .sum()
        })
        .unwrap_or(0)
}

/// The bytes of the files at or under `path`; symlinks are not followed.
fn tree_size(path: &Path) -> u64 {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => folder_size(path, &[]),
        Ok(meta) if meta.is_file() => meta.len(),
        _ => 0,
    }
}

/// Removes a file or a whole folder without following symlinks, first giving its owner write
/// access to every folder inside, so read-only plugin folders don't stop it half way.
fn remove_tree(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        open_up(path);
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}
#[cfg(unix)]
fn open_up(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return;
    };
    if !meta.is_dir() {
        return;
    }
    let mode = meta.permissions().mode();
    if mode & 0o700 != 0o700 {
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(mode | 0o700));
    }
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        open_up(&entry.path());
    }
}
#[cfg(not(unix))]
fn open_up(_dir: &Path) {}

/// Component-wise and case-insensitive (APFS usually is), after resolving symlinks.
fn inside(path: &Path, folder: &Path) -> bool {
    location::starts_with_ci(&location::canonical(path), &location::canonical(folder))
}
fn same_folder(a: &Path, b: &Path) -> bool {
    inside(a, b) && inside(b, a)
}

fn failed(what: &str, reason: impl Display) -> WorkspaceError {
    WorkspaceError::new("io", format!("{what}: {reason}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::location::{try_read_location, write_location, RootStatus};
    use crate::workspace::models::Record;
    use crate::workspace::repository::Repository;
    use crate::workspace::{open_for_tests, startup};
    use serde_json::json;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    /// A volume of one filesystem type with a fixed amount of free space.
    struct Vol(&'static str, u64);
    impl VolumeInfo for Vol {
        fn fs_type(&self, _: &Path) -> String {
            self.0.into()
        }
        fn free_bytes(&self, _: &Path) -> u64 {
            self.1
        }
    }
    const ROOMY: Vol = Vol("apfs", 1 << 40);
    const WAIT: Duration = Duration::from_millis(500);

    /// A running workspace in the default layout, a home folder and an empty folder to move to.
    struct Fixture {
        dir: tempfile::TempDir,
        default: PathBuf,
        home: PathBuf,
        picked: PathBuf,
        core: Arc<Core>,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let default = dir.path().join("workspace");
            let home = dir.path().join("home");
            let picked = dir.path().join("Drive");
            fs::create_dir_all(&home).unwrap();
            fs::create_dir_all(&picked).unwrap();
            let core = startup(&default, open_for_tests).core.unwrap();
            Self {
                dir,
                default,
                home,
                picked,
                core,
            }
        }
        fn places(&self) -> Places<'_> {
            places(&self.default, &self.core, &self.home)
        }
        fn change(&self, mode: Mode) -> Result<PathBuf> {
            self.change_to(&self.picked, mode)
        }
        fn change_to(&self, picked: &Path, mode: Mode) -> Result<PathBuf> {
            let choice = Choice {
                picked,
                mode,
                acknowledged: false,
            };
            change(&self.places(), &choice, Some(&self.core), &ROOMY, WAIT)
        }
    }
    fn places<'a>(default: &'a Path, core: &'a Core, home: &'a Path) -> Places<'a> {
        Places {
            private_root: default,
            data_root: &core.paths.data,
            home,
        }
    }

    fn note(id: &str, text: &str) -> Record {
        Record {
            id: id.into(),
            kind: "note".into(),
            connection_id: None,
            workspace_id: Some("personal".into()),
            source: "local".into(),
            revision: "1".into(),
            updated_at: 1,
            data: json!({ "text": text }),
        }
    }
    fn notes(core: &Core) -> Vec<String> {
        core.repo()
            .unwrap()
            .local_records("personal", "note")
            .unwrap()
            .iter()
            .map(|r| r.data["text"].as_str().unwrap_or_default().to_string())
            .collect()
    }
    /// The sorted names in a folder.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|d| {
                d.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }
    /// Every file under `dir` with its bytes, to prove a folder was left exactly as it was.
    fn contents(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut all = Vec::new();
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                all.extend(contents(&path));
            } else {
                all.push((path.clone(), fs::read(&path).unwrap()));
            }
        }
        all.sort();
        all
    }
    fn marked_root(parent: &Path, id: &str) -> PathBuf {
        let root = parent.join(DATA_DIR_NAME);
        fs::create_dir_all(&root).unwrap();
        let marker = Marker {
            id: id.into(),
            created_at: "2026-11-01T00:00:00Z".into(),
            app_version: "2.0.0".into(),
        };
        location::write_marker(&root, &marker).unwrap();
        root
    }
    #[cfg(unix)]
    fn mode(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
    }
    #[cfg(unix)]
    fn chmod(p: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(mode)).unwrap();
    }
    fn logs(f: &Fixture) -> PathBuf {
        f.dir.path().join("Logs")
    }

    #[test]
    fn move_copies_db_and_folders_then_points_to_target() {
        let f = Fixture::new();
        f.core
            .repo()
            .unwrap()
            .put_record(&note("n1", "Quarterly plan"))
            .unwrap();
        let revision = f.core.repo().unwrap().revision().unwrap();
        // What moves: the database, plugins and automation output.
        let plugins = f.default.join("plugins");
        fs::create_dir_all(plugins.join("echo/bin")).unwrap();
        fs::write(plugins.join("echo/manifest.json"), "{}").unwrap();
        fs::write(plugins.join("echo/bin/run"), "#!/bin/sh\n").unwrap();
        fs::create_dir_all(f.default.join("automations/runs")).unwrap();
        fs::write(f.default.join("automations/runs/1.json"), "{\"ok\":1}").unwrap();
        #[cfg(unix)]
        {
            chmod(&plugins.join("echo/bin/run"), 0o755);
            chmod(&plugins.join("echo/manifest.json"), 0o600);
            chmod(&plugins.join("echo/bin"), 0o555);
            std::os::unix::fs::symlink("manifest.json", plugins.join("echo/link")).unwrap();
        }
        // What stays: AI staging is transient; sign-in data, the window and the locks are private.
        fs::create_dir_all(f.default.join("ai-staging/run-1")).unwrap();
        fs::write(f.default.join("ai-staging/run-1/prompt.txt"), "x").unwrap();
        fs::create_dir_all(f.default.join("credentials")).unwrap();
        fs::write(f.default.join("credentials/graph-a.json"), "secret").unwrap();
        fs::write(f.default.join("window.json"), "{}").unwrap();

        let target = f.change(Mode::Move).unwrap();
        assert_eq!(target, location::canonical(&f.picked).join(DATA_DIR_NAME));

        // The pointer names the new folder and its marker, and remembers the old one.
        let pointer = try_read_location(&f.default).unwrap();
        let marker = location::read_marker(&target).unwrap();
        assert_eq!(pointer.data_dir.as_deref(), Some(target.as_path()));
        assert_eq!(pointer.marker_id.as_deref(), Some(marker.id.as_str()));
        assert_eq!(pointer.previous.as_deref(), Some(f.default.as_path()));
        assert_eq!(marker.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(location::resolve(&f.default).status, RootStatus::Ready);

        // Only Connect's data moved, complete, and nothing half-built is left behind.
        assert_eq!(
            names(&target),
            [MARKER, "automations", "plugins", "workspace.sqlite"]
        );
        assert_eq!(names(&f.picked), [DATA_DIR_NAME]);
        assert_eq!(
            fs::read_to_string(target.join("automations/runs/1.json")).unwrap(),
            "{\"ok\":1}"
        );
        #[cfg(unix)]
        {
            let moved = target.join("plugins");
            assert_eq!(mode(&moved.join("echo/bin/run")), 0o755);
            assert_eq!(mode(&moved.join("echo/manifest.json")), 0o600);
            assert_eq!(mode(&moved.join("echo/bin")), 0o555);
            assert_eq!(
                fs::read_link(moved.join("echo/link")).unwrap(),
                Path::new("manifest.json")
            );
            assert_eq!(mode(&target), 0o700, "the new folder is private");
            chmod(&moved.join("echo/bin"), 0o755);
            chmod(&plugins.join("echo/bin"), 0o755);
        }

        // The old copy is untouched.
        assert!(f.default.join("workspace.sqlite").is_file());
        assert!(f.default.join("plugins/echo/manifest.json").is_file());
        assert!(f.default.join("ai-staging/run-1/prompt.txt").is_file());
        assert!(f.default.join("credentials/graph-a.json").is_file());
        assert!(!target.join("credentials").exists());

        // After the restart Connect opens the copy, with every record.
        f.core.release_for_restart();
        let state = startup(&f.default, open_for_tests);
        let core = state.core.expect("the new folder opens");
        assert_eq!(core.paths.data, target);
        assert_eq!(core.paths.private, f.default);
        assert_eq!(core.repo().unwrap().revision().unwrap(), revision);
        assert_eq!(notes(&core), ["Quarterly plan"]);
    }

    #[test]
    fn move_failure_leaves_pointer_unchanged() {
        let f = Fixture::new();
        f.core
            .repo()
            .unwrap()
            .put_record(&note("n1", "Keep me"))
            .unwrap();
        let earlier = f.dir.path().join("Old").join(DATA_DIR_NAME);
        write_location(
            &f.default,
            &LocationFile {
                previous: Some(earlier),
                ..Default::default()
            },
        )
        .unwrap();
        let pointer = fs::read(f.default.join("location.json")).unwrap();

        #[cfg(unix)]
        {
            // A read-only plugin folder is copied first, then a file Connect can't read stops
            // the copy half way.
            fs::create_dir_all(f.default.join("plugins/locked")).unwrap();
            fs::write(f.default.join("plugins/locked/file"), "x").unwrap();
            fs::create_dir_all(f.default.join("automations")).unwrap();
            let unreadable = f.default.join("automations/run.json");
            fs::write(&unreadable, "{}").unwrap();
            chmod(&f.default.join("plugins/locked"), 0o555);
            chmod(&unreadable, 0o000);

            let err = f.change(Mode::Move).unwrap_err();
            chmod(&unreadable, 0o644);
            chmod(&f.default.join("plugins/locked"), 0o755);
            assert_eq!(err.code, "io");
            assert!(err.message.contains("copy"), "{}", err.message);
            assert!(names(&f.picked).is_empty(), "the staging folder is removed");
            assert_eq!(fs::read(f.default.join("location.json")).unwrap(), pointer);
            // Connect carries on where it was: the database is open and background work runs.
            assert!(!f.core.stop.load(Ordering::Relaxed));
            f.core
                .repo()
                .unwrap()
                .put_record(&note("n2", "Written after the failed move"))
                .unwrap();
            assert_eq!(notes(&f.core).len(), 2);
        }

        // The copy succeeds but the pointer can't be written: the new folder is removed again.
        fs::remove_file(f.default.join("location.json")).unwrap();
        fs::create_dir_all(f.default.join("location.json").join("keep")).unwrap();
        let err = f.change(Mode::Move).unwrap_err();
        assert_eq!(err.code, "io");
        assert!(names(&f.picked).is_empty(), "the new folder is removed");
        assert!(f.default.join("location.json").join("keep").is_dir());
        f.core
            .repo()
            .unwrap()
            .put_record(&note("n3", "Still running"))
            .unwrap();
        assert!(notes(&f.core).contains(&"Keep me".to_string()));
    }

    #[test]
    fn move_refused_while_action_dispatching() {
        let f = Fixture::new();
        let mut send = Record {
            id: "send-1".into(),
            kind: "action".into(),
            connection_id: Some("c1".into()),
            workspace_id: Some("personal".into()),
            source: "action".into(),
            revision: "1".into(),
            updated_at: 1,
            data: json!({ "state": "dispatching" }),
        };
        f.core.repo().unwrap().put_record(&send).unwrap();

        let err = f.change(Mode::Move).unwrap_err();
        assert_eq!(err.code, "busy");
        assert!(err.message.contains("being sent"), "{}", err.message);
        assert!(names(&f.picked).is_empty());
        assert!(!f.default.join("location.json").exists());
        // Nothing was stopped: the send records its outcome in the open database.
        assert!(!f.core.stop.load(Ordering::Relaxed));
        send.data = json!({ "state": "succeeded" });
        f.core.repo().unwrap().put_record(&send).unwrap();

        // Once the send has finished, the move goes ahead.
        let target = f.change(Mode::Move).unwrap();
        assert_eq!(
            try_read_location(&f.default).unwrap().data_dir,
            Some(target)
        );
    }

    #[test]
    fn adopt_requires_existing_marker() {
        let f = Fixture::new();
        // Nothing there.
        let err = f.change(Mode::Adopt).unwrap_err();
        assert_eq!(err.code, "validation");
        // A folder with the right name but no marker isn't Connect's.
        let foreign = f.picked.join(DATA_DIR_NAME);
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("notes.txt"), "mine").unwrap();
        assert_eq!(f.change(Mode::Adopt).unwrap_err().code, "validation");
        assert_eq!(names(&foreign), ["notes.txt"]);

        // Marked, but its database is damaged.
        let broken = f.dir.path().join("Broken Drive");
        let root = marked_root(&broken, "broken");
        fs::write(root.join("workspace.sqlite"), "not a database").unwrap();
        assert_eq!(
            f.change_to(&broken, Mode::Adopt).unwrap_err().code,
            "damaged"
        );
        // Marked, but written by a newer Connect.
        let newer = f.dir.path().join("Newer");
        let root = marked_root(&newer, "newer");
        {
            let db = rusqlite::Connection::open(root.join("workspace.sqlite")).unwrap();
            db.execute_batch("PRAGMA user_version=7").unwrap();
        }
        assert_eq!(
            f.change_to(&newer, Mode::Adopt).unwrap_err().code,
            "newer_schema"
        );
        // Marked, but another Connect is using it right now.
        let busy = f.dir.path().join("Shared");
        let root = marked_root(&busy, "shared");
        let held = fs::File::create(root.join("connect.lock")).unwrap();
        fs2::FileExt::lock_exclusive(&held).unwrap();
        assert_eq!(f.change_to(&busy, Mode::Adopt).unwrap_err().code, "in_use");
        drop(held);
        assert!(!f.default.join("location.json").exists());

        // Connect data from another Mac: marked, with an intact database.
        let other = f.dir.path().join("Other Mac");
        let root = marked_root(&other, "other-mac");
        {
            let mut r = Repository::open(&root.join("workspace.sqlite")).unwrap();
            r.put_record(&note("n9", "From the other Mac")).unwrap();
        }
        let before = contents(&root);
        let target = f.change_to(&other, Mode::Adopt).unwrap();
        assert_eq!(contents(&root), before, "adopted data is never modified");
        assert_eq!(target, location::canonical(&root));
        let pointer = try_read_location(&f.default).unwrap();
        assert_eq!(pointer.data_dir, Some(target.clone()));
        assert_eq!(pointer.marker_id.as_deref(), Some("other-mac"));
        assert_eq!(pointer.previous, Some(f.default.clone()));

        f.core.release_for_restart();
        let core = startup(&f.default, open_for_tests).core.unwrap();
        assert_eq!(core.paths.data, target);
        assert_eq!(notes(&core), ["From the other Mac"]);
    }

    #[test]
    fn fresh_creates_marker_and_empty_db_on_next_start() {
        let f = Fixture::new();
        f.core
            .repo()
            .unwrap()
            .put_record(&note("n1", "Stays behind"))
            .unwrap();
        // A folder of that name already there is never reused for an empty start.
        let taken = f.dir.path().join("Taken");
        fs::create_dir_all(taken.join(DATA_DIR_NAME)).unwrap();
        assert_eq!(
            f.change_to(&taken, Mode::Fresh).unwrap_err().code,
            "validation"
        );

        let target = f.change(Mode::Fresh).unwrap();
        assert_eq!(
            names(&target),
            [MARKER],
            "no database until Connect starts there"
        );
        assert_eq!(names(&f.picked), [DATA_DIR_NAME]);
        let pointer = try_read_location(&f.default).unwrap();
        assert_eq!(pointer.data_dir, Some(target.clone()));
        assert_eq!(
            pointer.marker_id,
            location::read_marker(&target).map(|m| m.id)
        );
        assert_eq!(pointer.previous, Some(f.default.clone()));

        f.core.release_for_restart();
        let core = startup(&f.default, open_for_tests).core.unwrap();
        assert_eq!(core.paths.data, target);
        assert!(target.join("workspace.sqlite").is_file());
        assert!(notes(&core).is_empty());
        // The old data is still there.
        assert!(f.default.join("workspace.sqlite").is_file());
    }

    #[test]
    fn remove_old_deletes_only_connect_files() {
        let f = Fixture::new();
        for dir in [
            "plugins/echo",
            "automations",
            "ai-staging/run",
            "credentials",
        ] {
            fs::create_dir_all(f.default.join(dir)).unwrap();
        }
        fs::write(f.default.join("plugins/echo/main.js"), "x".repeat(1000)).unwrap();
        fs::write(f.default.join("automations/run.json"), "{}").unwrap();
        fs::write(f.default.join("ai-staging/run/prompt"), "p").unwrap();
        fs::write(f.default.join("credentials/graph-a.json"), "secret").unwrap();
        fs::write(f.default.join("window.json"), "{}").unwrap();
        fs::write(f.default.join("notes.txt"), "the user's own file").unwrap();
        let target = f.change(Mode::Move).unwrap();
        f.core.release_for_restart();
        let core = startup(&f.default, open_for_tests).core.unwrap();

        // The old copy is the default folder: its private files stay.
        let info = location_info(&f.default, &logs(&f));
        assert!(info.previous_exists);
        assert!(info.previous_size_bytes > 1000);
        let removed = remove_old(&f.default).unwrap();
        assert_eq!(removed, info.previous_size_bytes);
        assert_eq!(
            names(&f.default),
            [
                "credentials",
                "location.json",
                "notes.txt",
                "owner.lock",
                "window.json"
            ]
        );
        assert_eq!(names(&f.default.join("credentials")), ["graph-a.json"]);
        let pointer = try_read_location(&f.default).unwrap();
        assert_eq!(pointer.previous, None);
        assert_eq!(pointer.data_dir, Some(target.clone()));
        assert_eq!(remove_old(&f.default).unwrap_err().code, "not_found");
        assert!(!location_info(&f.default, &logs(&f)).previous_exists);
        // The current data is untouched and still open.
        core.repo().unwrap().put_record(&note("n1", "x")).unwrap();

        // Move on to a second drive; the old copy is now a custom folder with a user file in it.
        fs::write(target.join("my-notes.txt"), "mine").unwrap();
        let second = f.dir.path().join("Drive 2");
        fs::create_dir(&second).unwrap();
        let choice = Choice {
            picked: &second,
            mode: Mode::Move,
            acknowledged: false,
        };
        let places = places(&f.default, &core, &f.home);
        let newest = change(&places, &choice, Some(&core), &ROOMY, WAIT).unwrap();
        core.release_for_restart();
        let core = startup(&f.default, open_for_tests).core.unwrap();
        assert_eq!(core.paths.data, newest);
        assert!(target.join("connect.lock").is_file());
        assert!(remove_old(&f.default).unwrap() > 0);
        // Its marker and lock go too, but the user's file stays.
        assert_eq!(names(&target), ["my-notes.txt"]);
        assert_eq!(notes(&core), ["x"]);

        // An old folder holding nothing but Connect's files goes altogether.
        let gone = marked_root(&f.dir.path().join("Drive 3"), "gone");
        fs::create_dir_all(gone.join("plugins")).unwrap();
        fs::write(gone.join("workspace.sqlite"), "old").unwrap();
        write_location(
            &f.default,
            &LocationFile {
                previous: Some(gone.clone()),
                ..try_read_location(&f.default).unwrap()
            },
        )
        .unwrap();
        let marker_bytes = fs::metadata(gone.join(MARKER)).unwrap().len();
        assert_eq!(remove_old(&f.default).unwrap(), 3 + marker_bytes);
        assert!(!gone.exists());
        assert!(f.dir.path().join("Drive 3").is_dir());
    }

    #[test]
    fn remove_old_never_touches_a_folder_that_is_not_connects() {
        let f = Fixture::new();
        let point = |previous: &Path| {
            write_location(
                &f.default,
                &LocationFile {
                    previous: Some(previous.to_path_buf()),
                    ..Default::default()
                },
            )
            .unwrap();
        };
        // Any other folder, even with Connect-like names inside.
        let projects = f.dir.path().join("projects");
        fs::create_dir_all(projects.join("plugins")).unwrap();
        fs::write(projects.join("workspace.sqlite"), "theirs").unwrap();
        point(&projects);
        assert_eq!(remove_old(&f.default).unwrap_err().code, "not_connect");
        assert!(!location_info(&f.default, &logs(&f)).previous_exists);
        // The right name without a marker.
        let unmarked = f.dir.path().join("Stick").join(DATA_DIR_NAME);
        fs::create_dir_all(unmarked.join("plugins")).unwrap();
        point(&unmarked);
        assert_eq!(remove_old(&f.default).unwrap_err().code, "not_connect");
        // A marked folder inside the private folder.
        let inside = marked_root(&f.default.join("credentials"), "inside");
        fs::create_dir_all(inside.join("plugins")).unwrap();
        point(&inside);
        assert_eq!(remove_old(&f.default).unwrap_err().code, "not_connect");
        // The folder in use now.
        point(&f.default);
        assert_eq!(remove_old(&f.default).unwrap_err().code, "current_folder");
        // A pointer Connect can't read says why, and nothing is removed.
        fs::write(f.default.join("location.json"), "{broken").unwrap();
        let err = remove_old(&f.default).unwrap_err();
        assert_eq!(err.code, "pointer_unreadable");
        assert!(
            err.message.contains("key must be a string"),
            "{}",
            err.message
        );
        assert!(projects.join("plugins").is_dir());
        assert!(projects.join("workspace.sqlite").is_file());
        assert!(unmarked.join("plugins").is_dir());
        assert!(inside.join("plugins").is_dir());
        assert!(f.default.join("workspace.sqlite").is_file());
        assert_eq!(notes(&f.core).len(), 0);
    }

    #[test]
    fn check_offers_the_modes_the_folder_allows() {
        let f = Fixture::new();
        fs::create_dir_all(f.default.join("plugins")).unwrap();
        fs::write(f.default.join("plugins/main.js"), "x".repeat(4096)).unwrap();
        let places = f.places();
        let check_on = |picked: &Path, open: bool, vol: &Vol| check(&places, picked, open, vol);

        let plain = check_on(&f.picked, true, &ROOMY);
        assert_eq!(plain.modes, [Mode::Move, Mode::Fresh]);
        assert!(plain.issues.is_empty());
        assert_eq!(
            plain.target,
            location::canonical(&f.picked).join(DATA_DIR_NAME)
        );
        assert!(plain.required_bytes > 4096);
        // Without an open workspace there is nothing to move.
        assert_eq!(check_on(&f.picked, false, &ROOMY).modes, [Mode::Fresh]);
        // Not enough room for the copy.
        let tight = check_on(&f.picked, true, &Vol("apfs", 1024));
        assert_eq!(tight.modes, [Mode::Fresh]);
        assert_eq!(tight.issues[0].code, "not_enough_space");
        // exFAT needs the user's acknowledgement, and the change says so.
        let exfat = Vol("exfat", 1 << 40);
        let report = check_on(&f.picked, true, &exfat);
        assert!(report.needs_acknowledgement);
        assert_eq!(report.modes, [Mode::Move, Mode::Fresh]);
        let choice = Choice {
            picked: &f.picked,
            mode: Mode::Fresh,
            acknowledged: false,
        };
        let err = change(&places, &choice, Some(&f.core), &exfat, WAIT).unwrap_err();
        assert_eq!(err.code, "needs_acknowledgement");
        assert!(names(&f.picked).is_empty());
        // A network volume can't be used at all.
        let smb = check_on(&f.picked, true, &Vol("smbfs", 1 << 40));
        assert!(smb.modes.is_empty());
        assert_eq!(smb.issues[0].code, "network_volume");
        // Connect data already there can only be used as it is.
        let marked = f.dir.path().join("Marked");
        marked_root(&marked, "m-9");
        let existing = check_on(&marked, true, &ROOMY);
        assert_eq!(existing.modes, [Mode::Adopt]);
        assert_eq!(existing.existing.map(|m| m.id).as_deref(), Some("m-9"));
        // Someone else's folder of that name blocks every choice.
        fs::create_dir(f.picked.join(DATA_DIR_NAME)).unwrap();
        let taken = check_on(&f.picked, true, &ROOMY);
        assert!(taken.modes.is_empty());
        assert_eq!(taken.issues[0].code, "folder_exists");
        // The folder that already holds the data.
        let current = Places {
            private_root: &f.default,
            data_root: &location::canonical(&marked).join(DATA_DIR_NAME),
            home: &f.home,
        };
        let same = check(&current, &marked, true, &ROOMY);
        assert!(same.modes.is_empty());
        assert_eq!(same.issues[0].code, "current_folder");
    }

    #[test]
    fn location_info_measures_the_data_folder_without_ai_staging() {
        let f = Fixture::new();
        let empty = location_info(&f.default, &logs(&f));
        fs::create_dir_all(f.default.join("ai-staging")).unwrap();
        fs::write(f.default.join("ai-staging/big"), "x".repeat(50_000)).unwrap();
        fs::create_dir_all(f.default.join("plugins")).unwrap();
        fs::write(f.default.join("plugins/main.js"), "x".repeat(3000)).unwrap();
        let info = location_info(&f.default, &logs(&f));
        assert_eq!(info.size_bytes, empty.size_bytes + 3000);
        assert_eq!(info.data_root, f.default);
        assert_eq!(info.private_root, f.default);
        assert_eq!(info.logs, logs(&f));
        assert!(!info.custom);
        assert_eq!(info.previous, None);
        assert!(!info.previous_exists);
        let json = serde_json::to_value(&info).unwrap();
        for key in [
            "dataRoot",
            "privateRoot",
            "logs",
            "custom",
            "sizeBytes",
            "previous",
            "previousExists",
            "previousSizeBytes",
        ] {
            assert!(json.get(key).is_some(), "{key}");
        }
    }

    #[test]
    fn database_uri_escapes_the_path() {
        assert_eq!(
            file_uri(
                Path::new("/Volumes/My Drive/a?b#c%d/w.sqlite"),
                "immutable=1"
            ),
            "file:/Volumes/My%20Drive/a%3Fb%23c%25d/w.sqlite?immutable=1"
        );
    }
}
