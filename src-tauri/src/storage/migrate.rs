//! Changing where Connect keeps its data (DESIGN.md section 8): move a copy of it to a folder
//! the user chooses, use the Connect data already in a folder, or start empty there. The
//! pointer is written only once the new folder is complete, so a failure at any earlier step
//! leaves Connect where it was, running. The old copy a move leaves is handled in `old_copy`.

use super::folders::{self, failed, flush, flush_dir, flush_file, DATABASE, MOVING_FOLDERS};
use crate::storage::location::{
    self, LocationFile, Marker, TargetIssue, VolumeInfo, DATA_DIR_NAME,
};
use crate::workspace::models::{Result, WorkspaceError};
use crate::workspace::repository::SCHEMA_VERSION;
use crate::workspace::Core;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// A safety net for background work that ignores cancellation; running jobs normally stop
/// within moments of `quiesce`.
pub const QUIESCE_WAIT: Duration = Duration::from_secs(15);
/// Room a move leaves free on the target disk beyond the copy itself.
const HEADROOM: u64 = 64 * 1024 * 1024;
/// A new data folder is built under this name beside its final place, then renamed.
const STAGING_PREFIX: &str = ".codemie-connect-incoming-";
/// A staging folder nothing has changed for this long was left by a crash, not a move.
const STALE_STAGING: Duration = Duration::from_secs(60 * 60);

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
    /// The data folder Connect would use: `<picked>/CodeMie Connect Data`, or the picked folder
    /// itself when it already is a marked Connect data folder.
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
    let base = location::canonical(picked);
    // The user may pick the `CodeMie Connect Data` folder itself rather than the one around it.
    let picked_is_data = base
        .file_name()
        .is_some_and(|n| n == DATA_DIR_NAME)
        .then(|| location::read_marker(&base))
        .flatten();
    let (target, existing) = match picked_is_data {
        Some(marker) => (base, Some(marker)),
        None => (base.join(DATA_DIR_NAME), report.existing_marker),
    };
    let acknowledgeable = |i: &TargetIssue| matches!(i, TargetIssue::NoUnixPermissions(_));
    let mut issues: Vec<Issue> = report.issues.iter().map(Issue::from).collect();
    let blocked = report.issues.iter().any(|i| !acknowledgeable(i));
    let required_bytes = folders::movable_bytes(places.data_root);
    let mut modes = Vec::new();
    if blocked {
        // The reasons are already in `issues`.
    } else if folders::same_folder(&target, places.data_root) {
        issues.push(Issue::new(
            "current_folder",
            "That folder already holds your data.",
        ));
    } else if existing.is_some() {
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
        existing,
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
    let held = Held::hold(core, wait)?;
    match switch(places, &check.target, plan) {
        Ok(target) => {
            held.commit();
            Ok(target)
        }
        Err(error) => match held.release() {
            Ok(()) => Err(error),
            Err(_) => Err(WorkspaceError::new(
                &error.code,
                format!(
                    "{} Restart Connect to open your workspace again.",
                    error.message
                ),
            )),
        },
    }
}

/// The workspace held still for a change. Committed once the pointer names the new folder;
/// dropped any other way (an early return, a panic), it lets the workspace run again.
struct Held<'a>(Option<&'a Core>);
impl<'a> Held<'a> {
    fn hold(core: Option<&'a Core>, wait: Duration) -> Result<Self> {
        if let Some(core) = core {
            core.quiesce(wait)?;
        }
        Ok(Self(core))
    }
    /// The restart takes over: the workspace stays held until the process exits.
    fn commit(mut self) {
        self.0 = None;
    }
    /// Lets the workspace run again and says whether it could.
    fn release(mut self) -> Result<()> {
        self.0.take().map_or(Ok(()), |core| core.resume())
    }
}
impl Drop for Held<'_> {
    fn drop(&mut self) {
        if let Some(core) = self.0.take() {
            let _ = core.resume();
        }
    }
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
/// next start opens `target`; the old data root is remembered as `previous`, and as a copy
/// only after a move.
fn switch(places: &Places, target: &Path, plan: Plan) -> Result<PathBuf> {
    let copied = matches!(plan, Plan::Copy);
    let (marker, created) = match plan {
        Plan::Copy => (build(target, Some(places.data_root))?, true),
        Plan::Empty => (build(target, None)?, true),
        Plan::Adopt(marker) => (marker, false),
    };
    let pointer = LocationFile {
        data_dir: Some(target.to_path_buf()),
        marker_id: Some(marker.id),
        previous: Some(places.data_root.to_path_buf()),
        previous_copied: copied,
        ..Default::default()
    };
    if let Err(e) = location::write_location(places.private_root, &pointer) {
        if created {
            // Only the folder this call just built.
            let _ = folders::remove_tree(target);
        }
        return Err(failed("Connect couldn’t save where your data now lives", e));
    }
    Ok(target.to_path_buf())
}

// ------------------------------------------------------------- the new folder

/// Builds the new data folder in a hidden staging folder beside `target` and renames it into
/// place once complete and on disk, so `target` never exists half-built. Copies the data from
/// `source` when given. Returns the new folder's marker; on failure nothing is left behind.
fn build(target: &Path, source: Option<&Path>) -> Result<Marker> {
    let parent = target.parent().ok_or_else(|| {
        WorkspaceError::new("validation", "Choose a folder to keep your data in.")
    })?;
    sweep_staging(parent);
    let staging = parent.join(format!("{STAGING_PREFIX}{}", uuid::Uuid::new_v4()));
    let built = fill(&staging, source).and_then(|marker| {
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
        Ok(marker)
    });
    let marker = match built {
        Ok(marker) => marker,
        Err(e) => {
            let _ = folders::remove_tree(&staging);
            return Err(e);
        }
    };
    if let Err(e) = flush_dir(parent) {
        // Renamed but maybe not on disk yet: this is the copy just built, so it goes.
        let _ = folders::remove_tree(target);
        return Err(failed("Connect couldn’t finish the new data folder", e));
    }
    Ok(marker)
}

/// Fills a new staging folder: the copied data (if any), then the marker, all on disk.
fn fill(staging: &Path, source: Option<&Path>) -> Result<Marker> {
    create_private_dir(staging).map_err(|e| failed("Connect couldn’t create a folder there", e))?;
    if let Some(source) = source {
        copy_data(source, staging)?;
    }
    let marker = new_marker();
    location::write_marker(staging, &marker)
        .and_then(|()| flush_dir(staging))
        .map_err(|e| failed("Connect couldn’t mark the new data folder", e))?;
    Ok(marker)
}

/// Removes staging folders a crash or power loss left behind. Only a real folder (never a
/// symlink) of the staging name that holds nothing but what staging holds, and that nothing
/// has changed for an hour, goes: one another Connect is still filling, or anything with the
/// user's files in it, stays.
fn sweep_staging(parent: &Path) {
    for entry in fs::read_dir(parent).into_iter().flatten().flatten() {
        let named = entry
            .file_name()
            .to_string_lossy()
            .starts_with(STAGING_PREFIX);
        if named && stale_staging(&entry.path()) {
            let _ = folders::remove_tree(&entry.path());
        }
    }
}
fn stale_staging(dir: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return false;
    };
    let old = meta
        .modified()
        .ok()
        .and_then(|changed| SystemTime::now().duration_since(changed).ok())
        .is_some_and(|age| age > STALE_STAGING);
    meta.is_dir()
        && old
        && fs::read_dir(dir).is_ok_and(|mut entries| {
            entries.all(|e| e.is_ok_and(|e| staging_entry(&e.file_name().to_string_lossy())))
        })
}
/// What a staging folder holds: the database copy, plugins, automations and the marker, with
/// the temporary file `write_marker` renames into place.
fn staging_entry(name: &str) -> bool {
    matches!(
        name,
        "workspace.sqlite"
            | "workspace.sqlite-wal"
            | "workspace.sqlite-shm"
            | "plugins"
            | "automations"
            | location::MARKER
    ) || name
        .strip_prefix(location::MARKER)
        .is_some_and(|rest| rest.starts_with('.') && rest.ends_with(".tmp"))
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

/// `VACUUM INTO` a consistent copy of the (quiesced) database, puts it on disk, then proves it
/// with [`verify_copy`].
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
    flush(copy).map_err(|e| failed("Connect couldn’t save the copy of your workspace", e))?;
    #[cfg(test)]
    let original = tests::sabotage(copy, original);
    verify_copy(copy, original)
}

/// Proves a copy of the workspace database: it opens read-only, passes `integrity_check`, and
/// has the original's revision and record count (`expected`).
fn verify_copy(copy: &Path, expected: (i64, i64)) -> Result<()> {
    let db_failed = |e: rusqlite::Error| failed("The copy of your workspace can’t be read", e);
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
    if tally(&copied).map_err(db_failed)? != expected {
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

/// Copies a file, folder or symlink without following symlinks, and puts it on disk. Files
/// and folders keep their permission bits, applied last so read-only ones can still be
/// written and flushed.
fn copy_entry(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    let kind = meta.file_type();
    if kind.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_entry(&entry.path(), &to.join(entry.file_name()))?;
        }
        flush_dir(to)?;
        fs::set_permissions(to, meta.permissions())
    } else if kind.is_file() {
        let mut source = fs::File::open(from)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut copy = options.open(to)?;
        io::copy(&mut source, &mut copy)?;
        flush_file(&copy)?;
        drop(copy);
        fs::set_permissions(to, meta.permissions())
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
    if folders::in_use_elsewhere(root) {
        return Err(folders::in_use());
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
    if version > SCHEMA_VERSION {
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::storage::location::{try_read_location, write_location, RootStatus, MARKER};
    use crate::workspace::models::Record;
    use crate::workspace::repository::Repository;
    use crate::workspace::{open_for_tests, startup};
    use serde_json::json;
    use std::cell::Cell;
    use std::sync::Arc;

    /// A volume of one filesystem type with a fixed amount of free space.
    pub(crate) struct Vol(pub &'static str, pub u64);
    impl VolumeInfo for Vol {
        fn fs_type(&self, _: &Path) -> String {
            self.0.into()
        }
        fn free_bytes(&self, _: &Path) -> u64 {
            self.1
        }
    }
    pub(crate) const ROOMY: Vol = Vol("apfs", 1 << 40);
    pub(crate) const WAIT: Duration = Duration::from_millis(500);

    /// A running workspace in the default layout, a home folder and an empty folder to move to.
    pub(crate) struct Fixture {
        pub dir: tempfile::TempDir,
        pub default: PathBuf,
        pub home: PathBuf,
        pub picked: PathBuf,
        pub core: Arc<Core>,
    }
    impl Fixture {
        pub(crate) fn new() -> Self {
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
        pub(crate) fn places(&self) -> Places<'_> {
            places(&self.default, &self.core, &self.home)
        }
        pub(crate) fn change(&self, mode: Mode) -> Result<PathBuf> {
            self.change_to(&self.picked, mode)
        }
        pub(crate) fn change_to(&self, picked: &Path, mode: Mode) -> Result<PathBuf> {
            change_with(&self.places(), picked, mode, &self.core)
        }
        /// What the relaunch does: let go of this workspace and start again from the pointer.
        pub(crate) fn restart(&self, core: &Core) -> Arc<Core> {
            core.release_for_restart();
            startup(&self.default, open_for_tests)
                .core
                .expect("the folder opens")
        }
    }
    pub(crate) fn places<'a>(default: &'a Path, core: &'a Core, home: &'a Path) -> Places<'a> {
        Places {
            private_root: default,
            data_root: &core.paths.data,
            home,
        }
    }
    pub(crate) fn change_with(
        places: &Places,
        picked: &Path,
        mode: Mode,
        core: &Core,
    ) -> Result<PathBuf> {
        let choice = Choice {
            picked,
            mode,
            acknowledged: false,
        };
        change(places, &choice, Some(core), &ROOMY, WAIT)
    }

    pub(crate) fn note(id: &str, text: &str) -> Record {
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
    pub(crate) fn notes(core: &Core) -> Vec<String> {
        core.repo()
            .unwrap()
            .local_records("personal", "note")
            .unwrap()
            .iter()
            .map(|r| r.data["text"].as_str().unwrap_or_default().to_string())
            .collect()
    }
    /// The sorted names in a folder.
    pub(crate) fn names(dir: &Path) -> Vec<String> {
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
    pub(crate) fn contents(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
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
    pub(crate) fn marked_root(parent: &Path, id: &str) -> PathBuf {
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
    /// A marked data folder holding a workspace with one note.
    pub(crate) fn connect_data(parent: &Path, id: &str, text: &str) -> PathBuf {
        let root = marked_root(parent, id);
        let mut r = Repository::open(&root.join(DATABASE)).unwrap();
        r.put_record(&note("n9", text)).unwrap();
        root
    }
    #[cfg(unix)]
    pub(crate) fn mode(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
    }
    #[cfg(unix)]
    pub(crate) fn chmod(p: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(mode)).unwrap();
    }
    /// Makes a folder look untouched for two hours.
    fn backdate(dir: &Path) {
        let then = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        fs::File::open(dir).unwrap().set_modified(then).unwrap();
    }
    /// [`backdate`] for a symlink itself, not what it points at.
    #[cfg(unix)]
    fn backdate_link(link: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(link.as_os_str().as_bytes()).unwrap();
        let then = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        let secs = then
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let time = libc::timeval {
            tv_sec: secs as libc::time_t,
            tv_usec: 0,
        };
        // SAFETY: a NUL-terminated path and two valid timevals for the duration of the call.
        assert_eq!(
            unsafe { libc::lutimes(path.as_ptr(), [time, time].as_ptr()) },
            0
        );
    }

    // ------------------------------------------------------------ failpoints

    /// Ways to spoil a database copy between `VACUUM INTO` and its verification.
    #[derive(Debug, Clone, Copy)]
    pub(crate) enum Sabotage {
        CorruptCopy,
        WrongTally,
    }
    thread_local! {
        static SABOTAGE: Cell<Option<Sabotage>> = const { Cell::new(None) };
    }
    /// Test failpoint in `copy_database`.
    pub(super) fn sabotage(copy: &Path, tally: (i64, i64)) -> (i64, i64) {
        match SABOTAGE.with(|s| s.get()) {
            Some(Sabotage::CorruptCopy) => {
                corrupt(copy);
                tally
            }
            Some(Sabotage::WrongTally) => (tally.0 + 1, tally.1),
            None => tally,
        }
    }
    /// Overwrites every page after the first, as a failing disk would.
    fn corrupt(db: &Path) {
        let mut bytes = fs::read(db).unwrap();
        assert!(bytes.len() > 4096, "the database has more than one page");
        for b in &mut bytes[4096..] {
            *b = 0xA5;
        }
        fs::write(db, bytes).unwrap();
    }

    // ----------------------------------------------------------------- move

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
            chmod(&plugins.join("echo/manifest.json"), 0o400);
            chmod(&plugins.join("echo/bin"), 0o555);
            std::os::unix::fs::symlink("manifest.json", plugins.join("echo/link")).unwrap();
        }
        // What stays: AI staging is transient; sign-in data, the window and the locks are private.
        fs::create_dir_all(f.default.join("ai-staging/run-1")).unwrap();
        fs::write(f.default.join("ai-staging/run-1/prompt.txt"), "x").unwrap();
        fs::create_dir_all(f.default.join("credentials")).unwrap();
        fs::write(f.default.join("credentials/graph-a.json"), "secret").unwrap();
        fs::write(f.default.join("window.json"), "{}").unwrap();
        // A staging folder an earlier crash left behind is swept away.
        let stale = f.picked.join(format!("{STAGING_PREFIX}crashed"));
        fs::create_dir_all(stale.join("plugins/locked")).unwrap();
        #[cfg(unix)]
        chmod(&stale.join("plugins/locked"), 0o555);
        backdate(&stale);

        let target = f.change(Mode::Move).unwrap();
        assert_eq!(target, location::canonical(&f.picked).join(DATA_DIR_NAME));

        // The pointer names the new folder and its marker, and remembers the old one as a copy.
        let pointer = try_read_location(&f.default).unwrap();
        let marker = location::read_marker(&target).unwrap();
        assert_eq!(pointer.data_dir.as_deref(), Some(target.as_path()));
        assert_eq!(pointer.marker_id.as_deref(), Some(marker.id.as_str()));
        assert_eq!(pointer.previous.as_deref(), Some(f.default.as_path()));
        assert!(pointer.previous_copied);
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
            assert_eq!(mode(&moved.join("echo/manifest.json")), 0o400);
            assert_eq!(
                fs::read_to_string(moved.join("echo/manifest.json")).unwrap(),
                "{}"
            );
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
        let core = f.restart(&f.core);
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
            // Connect carries on where it was: nothing is held and the database is open.
            assert!(!f.core.is_held());
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
        assert!(!f.core.is_held());
        f.core
            .repo()
            .unwrap()
            .put_record(&note("n3", "Still running"))
            .unwrap();
        assert!(notes(&f.core).contains(&"Keep me".to_string()));
    }

    #[test]
    fn move_rolls_back_when_the_copy_fails_its_checks() {
        let f = Fixture::new();
        f.core
            .repo()
            .unwrap()
            .put_record(&note("n1", "Keep me"))
            .unwrap();
        fs::create_dir_all(f.default.join("plugins/echo")).unwrap();
        fs::write(f.default.join("plugins/echo/main.js"), "x").unwrap();
        for sabotage in [Sabotage::CorruptCopy, Sabotage::WrongTally] {
            SABOTAGE.with(|s| s.set(Some(sabotage)));
            let err = f.change(Mode::Move).unwrap_err();
            SABOTAGE.with(|s| s.set(None));
            assert_eq!(err.code, "io", "{sabotage:?}");
            assert!(names(&f.picked).is_empty(), "{sabotage:?}: staging removed");
            assert!(!f.default.join("location.json").exists(), "{sabotage:?}");
            assert!(!f.core.is_held(), "{sabotage:?}");
        }
        assert_eq!(notes(&f.core), ["Keep me"]);
        // Nothing wrong: the same move goes ahead.
        f.change(Mode::Move).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn a_move_that_cannot_flush_any_part_rolls_back() {
        let f = Fixture::new();
        f.core
            .repo()
            .unwrap()
            .put_record(&note("n1", "Keep me"))
            .unwrap();
        fs::create_dir_all(f.default.join("plugins/echo")).unwrap();
        fs::write(f.default.join("plugins/echo/main.js"), "x").unwrap();
        fs::create_dir_all(f.default.join("automations")).unwrap();
        fs::write(f.default.join("automations/run.json"), "{}").unwrap();
        // The disk fails the first flush, then the second, and so on until the move gets
        // through.
        let lost = io::Error::from_raw_os_error(libc::EIO).to_string();
        let mut failed_at = 0;
        loop {
            folders::FLUSH_FAILURE.with(|x| x.set(Some((failed_at, libc::EIO))));
            let result = f.change(Mode::Move);
            folders::FLUSH_FAILURE.with(|x| x.set(None));
            let Err(err) = result else { break };
            assert_eq!(err.code, "io", "flush {failed_at}");
            assert!(
                err.message.contains(&lost),
                "flush {failed_at}: {}",
                err.message
            );
            assert!(
                names(&f.picked).is_empty(),
                "flush {failed_at}: nothing left"
            );
            assert!(
                !f.default.join("location.json").exists(),
                "flush {failed_at}"
            );
            assert!(!f.core.is_held(), "flush {failed_at}");
            failed_at += 1;
        }
        // The database copy; main.js, echo/ and plugins/; run.json and automations/; the
        // finished folder; and its parent after the rename.
        assert_eq!(failed_at, 8);
        let core = f.restart(&f.core);
        assert_eq!(notes(&core), ["Keep me"]);
    }

    #[test]
    #[cfg(unix)]
    fn a_folder_flush_the_volume_cannot_do_is_skipped_but_a_file_flush_is_not() {
        // Each flush point in turn fails as on a volume without that kind of flush. Only the
        // files must reach the disk: the database copy, main.js and run.json.
        let mut fatal = Vec::new();
        for point in 0..8 {
            let f = Fixture::new();
            fs::create_dir_all(f.default.join("plugins/echo")).unwrap();
            fs::write(f.default.join("plugins/echo/main.js"), "x").unwrap();
            fs::create_dir_all(f.default.join("automations")).unwrap();
            fs::write(f.default.join("automations/run.json"), "{}").unwrap();
            folders::FLUSH_FAILURE.with(|x| x.set(Some((point, libc::ENOTSUP))));
            let result = f.change(Mode::Move);
            folders::FLUSH_FAILURE.with(|x| x.set(None));
            match result {
                Ok(target) => {
                    assert_eq!(location::resolve(&f.default).status, RootStatus::Ready);
                    assert!(target.join(DATABASE).is_file());
                }
                Err(err) => {
                    assert_eq!(err.code, "io");
                    assert!(names(&f.picked).is_empty(), "point {point}: nothing left");
                    assert!(!f.core.is_held());
                    fatal.push(point);
                }
            }
        }
        // The database copy; main.js (echo/ and plugins/ are folders); run.json (automations/,
        // the finished folder and its parent are folders).
        assert_eq!(fatal, [0, 1, 4]);
    }

    #[test]
    fn sweep_removes_only_old_staging_folders_holding_only_staging_files() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path();
        let staging = |name: &str, extra: Option<&str>, old: bool| {
            let folder = parent.join(format!("{STAGING_PREFIX}{name}"));
            fs::create_dir_all(folder.join("plugins/echo")).unwrap();
            fs::write(folder.join("plugins/echo/main.js"), "x").unwrap();
            fs::write(folder.join(DATABASE), "copy").unwrap();
            fs::write(folder.join(format!("{MARKER}.1234.tmp")), "{}").unwrap();
            if let Some(extra) = extra {
                fs::write(folder.join(extra), "the user's").unwrap();
            }
            if old {
                backdate(&folder);
            }
            folder
        };
        let crashed = staging("crashed", None, true);
        let filling = staging("filling", None, false);
        let foreign = staging("foreign", Some("notes.txt"), true);
        // The same contents under another name are not staging.
        let other = parent.join("Other");
        fs::create_dir(&other).unwrap();
        fs::write(other.join(DATABASE), "theirs").unwrap();
        backdate(&other);
        // A symlink with the staging name is never followed.
        let elsewhere = parent.join("Elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join(DATABASE), "keep").unwrap();
        backdate(&elsewhere);
        let link = parent.join(format!("{STAGING_PREFIX}link"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
            backdate_link(&link);
        }

        sweep_staging(parent);
        assert!(!crashed.exists(), "an old staging folder is swept");
        assert!(
            filling.join(DATABASE).is_file(),
            "a recent one may still be filling"
        );
        assert!(
            foreign.join("notes.txt").is_file(),
            "anything unexpected keeps it"
        );
        assert!(other.join(DATABASE).is_file());
        assert!(elsewhere.join(DATABASE).is_file());
        #[cfg(unix)]
        assert!(fs::symlink_metadata(&link).is_ok(), "the link itself stays");
    }

    #[test]
    fn verify_copy_rejects_a_damaged_or_different_copy() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.sqlite");
        {
            let mut r = Repository::open(&source).unwrap();
            r.put_record(&note("n1", "x")).unwrap();
        }
        let db = Connection::open(&source).unwrap();
        let expected = tally(&db).unwrap();
        let copy = dir.path().join("copy.sqlite");
        db.execute("VACUUM INTO ?1", [copy.to_str().unwrap()])
            .unwrap();
        verify_copy(&copy, expected).unwrap();
        let err = verify_copy(&copy, (expected.0, expected.1 + 1)).unwrap_err();
        assert!(err.message.contains("doesn’t match"), "{}", err.message);
        corrupt(&copy);
        assert_eq!(verify_copy(&copy, expected).unwrap_err().code, "io");
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
        // Nothing was held: the send records its outcome in the open database.
        assert!(!f.core.is_held());
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
    fn move_handles_quotes_and_spaces_in_the_path() {
        let f = Fixture::new();
        f.core
            .repo()
            .unwrap()
            .put_record(&note("n1", "Quoted"))
            .unwrap();
        let picked = f.dir.path().join("Drive 'A' \"B\" & C");
        fs::create_dir(&picked).unwrap();
        let target = f.change_to(&picked, Mode::Move).unwrap();
        assert!(target.starts_with(location::canonical(&picked)));
        let core = f.restart(&f.core);
        assert_eq!(core.paths.data, target);
        assert_eq!(notes(&core), ["Quoted"]);
    }

    #[test]
    fn a_dropped_hold_lets_the_workspace_run_again() {
        let f = Fixture::new();
        {
            let _held = Held::hold(Some(&f.core), WAIT).unwrap();
            assert!(f.core.is_held());
            // Leaving here without `commit` (an early return, or a panic unwinding).
        }
        assert!(!f.core.is_held());
        f.core.repo().unwrap().put_record(&note("n1", "x")).unwrap();
        // Committed, it stays held for the restart.
        Held::hold(Some(&f.core), WAIT).unwrap().commit();
        assert!(f.core.is_held());
    }

    // ---------------------------------------------------------- adopt, fresh

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
            let db = Connection::open(root.join("workspace.sqlite")).unwrap();
            db.execute_batch(&format!("PRAGMA user_version={}", SCHEMA_VERSION + 1))
                .unwrap();
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
        assert!(!f.core.is_held());

        // Connect data from another Mac: marked, with an intact database.
        let other = f.dir.path().join("Other Mac");
        let root = connect_data(&other, "other-mac", "From the other Mac");
        let before = contents(&root);
        let target = f.change_to(&other, Mode::Adopt).unwrap();
        assert_eq!(contents(&root), before, "adopted data is never modified");
        assert_eq!(target, location::canonical(&root));
        let pointer = try_read_location(&f.default).unwrap();
        assert_eq!(pointer.data_dir, Some(target.clone()));
        assert_eq!(pointer.marker_id.as_deref(), Some("other-mac"));
        assert_eq!(pointer.previous, Some(f.default.clone()));
        assert!(
            !pointer.previous_copied,
            "the old folder is not a copy of it"
        );

        let core = f.restart(&f.core);
        assert_eq!(core.paths.data, target);
        assert_eq!(notes(&core), ["From the other Mac"]);
    }

    #[test]
    fn picking_the_data_folder_itself_offers_to_use_it() {
        let f = Fixture::new();
        let root = connect_data(&f.dir.path().join("Other Mac"), "other-mac", "Theirs");
        let check = check(&f.places(), &root, true, &ROOMY);
        assert_eq!(check.modes, [Mode::Adopt]);
        assert_eq!(check.target, location::canonical(&root));
        assert_eq!(check.existing.map(|m| m.id).as_deref(), Some("other-mac"));

        let target = f.change_to(&root, Mode::Adopt).unwrap();
        assert_eq!(target, location::canonical(&root));
        assert!(!root.join(DATA_DIR_NAME).exists(), "nothing nested is made");
        let core = f.restart(&f.core);
        assert_eq!(notes(&core), ["Theirs"]);
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
        assert!(!pointer.previous_copied);

        let core = f.restart(&f.core);
        assert_eq!(core.paths.data, target);
        assert!(target.join("workspace.sqlite").is_file());
        assert!(notes(&core).is_empty());
        // The old data is still there.
        assert!(f.default.join("workspace.sqlite").is_file());
    }

    // ---------------------------------------------------------------- check

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
