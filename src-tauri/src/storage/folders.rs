//! What is in a data folder and how Connect handles it safely: the names of its own files,
//! sizes, flushing to disk, removal that never follows symlinks, and the folder's lock.

use crate::storage::location;
use crate::workspace::models::WorkspaceError;
use std::fmt::Display;
use std::fs;
use std::io;
use std::path::Path;

pub(super) const DATABASE: &str = "workspace.sqlite";
/// Folders that move with the database. `ai-staging/` is transient: it starts empty.
pub(super) const MOVING_FOLDERS: [&str; 3] = ["plugins", "automations", "analytics"];
pub(super) const AI_STAGING: &str = "ai-staging";

/// What a move copies out of a data folder: the database and the folders that move. This is
/// also the data folder's size in Settings, so private files never count.
pub(super) fn movable_bytes(data_root: &Path) -> u64 {
    [DATABASE, "workspace.sqlite-wal"]
        .iter()
        .chain(MOVING_FOLDERS.iter())
        .map(|name| tree_size(&data_root.join(name)))
        .sum()
}

/// The bytes of the files at or under `path`; symlinks are not followed.
pub(super) fn tree_size(path: &Path) -> u64 {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::read_dir(path)
            .map(|entries| entries.flatten().map(|e| tree_size(&e.path())).sum())
            .unwrap_or(0),
        Ok(meta) if meta.is_file() => meta.len(),
        _ => 0,
    }
}

#[cfg(test)]
thread_local! {
    /// Test failpoint: `Some((n, errno))` lets `n` more flushes on this thread succeed and fails
    /// the one after with that OS error, so a test can fail each flush point in turn.
    pub(super) static FLUSH_FAILURE: std::cell::Cell<Option<(u32, i32)>> = const { std::cell::Cell::new(None) };
}

/// Flushes an open file or folder to disk and reports a failure. Where the full flush isn't
/// supported (some non-APFS volumes), falls back to a plain `fsync`, as SQLite does.
pub(super) fn flush_file(file: &fs::File) -> io::Result<()> {
    #[cfg(test)]
    if let Some((left, errno)) = FLUSH_FAILURE.with(|f| f.get()) {
        FLUSH_FAILURE.with(|f| f.set(left.checked_sub(1).map(|left| (left, errno))));
        if left == 0 {
            return Err(io::Error::from_raw_os_error(errno));
        }
    }
    match file.sync_all() {
        Ok(()) => Ok(()),
        #[cfg(unix)]
        Err(e)
            if matches!(
                e.raw_os_error(),
                Some(libc::ENOTSUP | libc::EINVAL | libc::ENOTTY)
            ) =>
        {
            use std::os::fd::AsRawFd;
            // SAFETY: `fsync` on a descriptor `file` owns and keeps open for the call.
            if unsafe { libc::fsync(file.as_raw_fd()) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
        Err(e) => Err(e),
    }
}

/// [`flush_file`] for the file at `path`. Any failure is reported: the bytes may not be on disk.
pub(super) fn flush(path: &Path) -> io::Result<()> {
    flush_file(&fs::File::open(path)?)
}

/// Flushes a folder's entries (new files, a rename) to disk. Only a failure that means the
/// disk lost or refused the write (EIO, ENOSPC) is reported. Any other is logged and skipped,
/// as SQLite does for its folder flushes, because some volumes and platforms can't flush a
/// folder at all (exFAT and FAT are to be checked by hand; Windows can't open a folder as a
/// file). The files themselves are always flushed with [`flush_file`].
pub(super) fn flush_dir(dir: &Path) -> io::Result<()> {
    match fs::File::open(dir).and_then(|d| flush_file(&d)) {
        Ok(()) => Ok(()),
        Err(e) if write_lost(&e) => Err(e),
        Err(e) => {
            log::warn!("Skipped flushing the folder {}: {e}", dir.display());
            Ok(())
        }
    }
}
#[cfg(unix)]
fn write_lost(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(libc::EIO | libc::ENOSPC))
}
#[cfg(not(unix))]
fn write_lost(_e: &io::Error) -> bool {
    false
}

/// Removes a file or a whole folder without following symlinks, first giving its owner write
/// access to every folder inside, so read-only plugin folders don't stop it half way.
pub(super) fn remove_tree(path: &Path) -> io::Result<()> {
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
    // A symlink is never followed, so nothing outside the folder is ever changed.
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
pub(super) fn inside(path: &Path, folder: &Path) -> bool {
    location::starts_with_ci(&location::canonical(path), &location::canonical(folder))
}
pub(super) fn same_folder(a: &Path, b: &Path) -> bool {
    inside(a, b) && inside(b, a)
}

/// Whether another Connect holds the folder's `connect.lock` right now. A missing lock file
/// means no one; any error other than contention is left for startup to report.
pub(super) fn in_use_elsewhere(root: &Path) -> bool {
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

pub(super) fn in_use() -> WorkspaceError {
    WorkspaceError::new(
        "in_use",
        "That data folder is in use by Connect on another Mac or another account.",
    )
}

/// A failure on the target disk. Never `storage_unavailable`: that code means the folder in
/// use failed and shows the recovery page.
pub(super) fn failed(what: &str, reason: impl Display) -> WorkspaceError {
    WorkspaceError::new("io", format!("{what}: {reason}."))
}
