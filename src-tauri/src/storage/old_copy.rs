//! The old data folder a move leaves behind (`previous` in the pointer): what Settings shows
//! about where Connect keeps things, and Remove old copy, which deletes only Connect's own
//! files from that folder.

use super::folders::{
    self, failed, inside, movable_bytes, same_folder, tree_size, AI_STAGING, DATABASE,
};
use crate::storage::location::{self, LocationFile, RootStatus, DATA_DIR_NAME, MARKER};
use crate::workspace::models::{Result, WorkspaceError};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// What Remove old copy deletes, in this order. In a custom folder the lock and then the
/// marker go last, so an interrupted removal is still recognised as Connect's and can be
/// retried.
const OLD_COPY: [&str; 7] = [
    "plugins",
    "automations",
    "analytics",
    AI_STAGING,
    "workspace.sqlite-wal",
    "workspace.sqlite-shm",
    DATABASE,
];
const OLD_CUSTOM_COPY: [&str; 2] = ["connect.lock", MARKER];

/// What Settings shows about where Connect keeps things.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationInfo {
    pub data_root: PathBuf,
    pub private_root: PathBuf,
    pub logs: PathBuf,
    pub custom: bool,
    /// What the data folder holds of Connect's movable data: the database, plugins,
    /// automations and analytics. Private files and the transient AI staging folder don't count.
    pub size_bytes: u64,
    pub previous: Option<PathBuf>,
    /// The old folder is still there and holds Connect files.
    pub previous_exists: bool,
    /// The old folder is a copy a finished move left; only then can it be removed.
    pub previous_copied: bool,
    /// What Remove old copy would free.
    pub previous_size_bytes: u64,
}

pub fn location_info(private_root: &Path, logs: &Path) -> LocationInfo {
    let live = location::resolve(private_root);
    let pointer = location::read_location(private_root);
    let old = pointer
        .previous
        .as_deref()
        .and_then(|p| old_copy(p, &live.data_root, private_root).ok())
        .unwrap_or_default();
    LocationInfo {
        size_bytes: movable_bytes(&live.data_root),
        data_root: live.data_root,
        private_root: live.private_root,
        logs: logs.to_path_buf(),
        custom: live.custom,
        previous: pointer.previous,
        previous_exists: !old.is_empty(),
        previous_copied: pointer.previous_copied,
        previous_size_bytes: old.iter().map(|p| tree_size(p)).sum(),
    }
}

/// Deletes Connect's own files from the old data folder, then forgets it. Every other file
/// stays. In the default folder, which also holds sign-in data, `owner.lock`, `window.json` and
/// the pointer, only the workspace files go. Refused unless the old folder is a copy a finished
/// move left and the data folder in use is there. Returns the bytes removed.
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
    if !pointer.previous_copied {
        return Err(WorkspaceError::new(
            "not_a_copy",
            "Connect didn’t copy your data from that folder, so it may hold newer data. Nothing was removed.",
        ));
    }
    // With the data in use out of reach, the old copy may be all there is.
    let current = pointer
        .data_dir
        .clone()
        .unwrap_or_else(|| private_root.to_path_buf());
    let live = location::resolve(private_root);
    if live.status != RootStatus::Ready || live.data_root != current {
        return Err(WorkspaceError::new(
            "current_unavailable",
            "Your data folder isn’t available right now, so the old copy is kept.",
        ));
    }
    let entries = old_copy(&previous, &current, private_root)?;
    let mut removed = 0;
    for entry in &entries {
        let size = tree_size(entry);
        folders::remove_tree(entry)
            .map_err(|e| failed("Connect couldn’t remove the old copy", e))?;
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
            previous_copied: false,
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
/// the folder is gone, doesn't look like Connect's own, overlaps the folder in use, or another
/// Connect uses it.
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
    if !default && folders::in_use_elsewhere(previous) {
        return Err(folders::in_use());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::commands::use_default_location;
    use crate::storage::location::{try_read_location, write_location};
    use crate::storage::migrate::tests::{
        change_with, connect_data, marked_root, names, note, notes, places, Fixture,
    };
    use crate::storage::migrate::Mode;

    fn logs(f: &Fixture) -> PathBuf {
        f.dir.path().join("Logs")
    }

    #[test]
    fn remove_old_deletes_only_connect_files() {
        let f = Fixture::new();
        for dir in [
            "plugins/echo",
            "automations",
            "analytics",
            "ai-staging/run",
            "credentials",
        ] {
            fs::create_dir_all(f.default.join(dir)).unwrap();
        }
        fs::write(f.default.join("plugins/echo/main.js"), "x".repeat(1000)).unwrap();
        fs::write(f.default.join("automations/run.json"), "{}").unwrap();
        fs::write(f.default.join("analytics/sessions.json"), "{}").unwrap();
        fs::write(f.default.join("ai-staging/run/prompt"), "p").unwrap();
        fs::write(f.default.join("credentials/graph-a.json"), "secret").unwrap();
        fs::write(f.default.join("window.json"), "{}").unwrap();
        fs::write(f.default.join("notes.txt"), "the user's own file").unwrap();
        let target = f.change(Mode::Move).unwrap();
        let core = f.restart(&f.core);

        // The old copy is the default folder: its private files stay.
        let info = location_info(&f.default, &logs(&f));
        assert!(info.previous_exists);
        assert!(info.previous_copied);
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
        assert!(!pointer.previous_copied);
        assert_eq!(pointer.data_dir, Some(target.clone()));
        assert_eq!(remove_old(&f.default).unwrap_err().code, "not_found");
        assert!(!location_info(&f.default, &logs(&f)).previous_exists);
        // The current data is untouched and still open.
        core.repo().unwrap().put_record(&note("n1", "x")).unwrap();

        // Move on to a second drive; the old copy is now a custom folder with a user file in it.
        fs::write(target.join("my-notes.txt"), "mine").unwrap();
        let second = f.dir.path().join("Drive 2");
        fs::create_dir(&second).unwrap();
        let newest = change_with(
            &places(&f.default, &core, &f.home),
            &second,
            Mode::Move,
            &core,
        )
        .unwrap();
        let core = f.restart(&core);
        assert_eq!(core.paths.data, newest);
        assert!(target.join("connect.lock").is_file());
        assert!(remove_old(&f.default).unwrap() > 0);
        // Its marker and lock go too (the marker last), but the user's file stays.
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
                previous_copied: true,
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
    fn remove_old_refuses_folders_that_are_not_copies() {
        // "Use the default folder" after a move: the custom folder may hold the newer data.
        let f = Fixture::new();
        let custom = f.change(Mode::Move).unwrap();
        let core = f.restart(&f.core);
        core.repo()
            .unwrap()
            .put_record(&note("n1", "Newer"))
            .unwrap();
        use_default_location(&f.default).unwrap();
        let back = f.restart(&core);
        assert_eq!(back.paths.data, f.default);
        let info = location_info(&f.default, &logs(&f));
        assert_eq!(info.previous.as_deref(), Some(custom.as_path()));
        assert!(info.previous_exists);
        assert!(!info.previous_copied);
        assert_eq!(remove_old(&f.default).unwrap_err().code, "not_a_copy");
        assert!(custom.join("workspace.sqlite").is_file());
        assert!(location::read_marker(&custom).is_some());

        // Adopting or starting empty leaves the default folder as `previous`, not as a copy.
        for mode in [Mode::Adopt, Mode::Fresh] {
            let f = Fixture::new();
            f.core
                .repo()
                .unwrap()
                .put_record(&note("n1", "Mine"))
                .unwrap();
            if mode == Mode::Adopt {
                connect_data(&f.picked, "other-mac", "Theirs");
            }
            f.change(mode).unwrap();
            let _core = f.restart(&f.core);
            let err = remove_old(&f.default).unwrap_err();
            assert_eq!(err.code, "not_a_copy", "{mode:?}");
            assert!(f.default.join("workspace.sqlite").is_file(), "{mode:?}");
            assert!(!location_info(&f.default, &logs(&f)).previous_copied);
        }
    }

    #[test]
    fn remove_old_keeps_the_old_copy_while_the_current_folder_is_unavailable() {
        let f = Fixture::new();
        // The pointer names a marked folder on a drive that is unplugged now.
        let gone = f.dir.path().join("Unplugged").join(DATA_DIR_NAME);
        write_location(
            &f.default,
            &LocationFile {
                data_dir: Some(gone.clone()),
                marker_id: Some("m-1".into()),
                previous: Some(f.default.clone()),
                previous_copied: true,
                ..Default::default()
            },
        )
        .unwrap();
        let err = remove_old(&f.default).unwrap_err();
        assert_eq!(err.code, "current_unavailable");
        assert!(f.default.join("workspace.sqlite").is_file());
        assert_eq!(
            try_read_location(&f.default).unwrap().previous,
            Some(f.default.clone())
        );
        // The drive comes back but with another Connect's marker: still not the folder in use.
        marked_root(gone.parent().unwrap(), "someone-else");
        assert_eq!(
            remove_old(&f.default).unwrap_err().code,
            "current_unavailable"
        );
        assert!(f.default.join("workspace.sqlite").is_file());
    }

    #[test]
    fn remove_old_never_touches_a_folder_that_is_not_connects() {
        let f = Fixture::new();
        let point = |previous: &Path| {
            write_location(
                &f.default,
                &LocationFile {
                    previous: Some(previous.to_path_buf()),
                    previous_copied: true,
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
        assert!(notes(&f.core).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn remove_old_never_follows_symlinks() {
        use crate::storage::migrate::tests::{chmod, mode};
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        // The user keeps plugins elsewhere and links them in; automations link out too.
        let elsewhere = f.dir.path().join("Elsewhere");
        fs::create_dir_all(elsewhere.join("plugins-real/echo")).unwrap();
        fs::write(
            elsewhere.join("plugins-real/echo/main.js"),
            "x".repeat(10_000),
        )
        .unwrap();
        fs::create_dir_all(elsewhere.join("keep")).unwrap();
        fs::write(elsewhere.join("keep/report.txt"), "y".repeat(10_000)).unwrap();
        chmod(&elsewhere.join("keep"), 0o555);
        symlink(elsewhere.join("plugins-real"), f.default.join("plugins")).unwrap();
        fs::create_dir_all(f.default.join("automations")).unwrap();
        symlink(elsewhere.join("keep"), f.default.join("automations/link")).unwrap();

        f.change(Mode::Move).unwrap();
        let _core = f.restart(&f.core);
        let info = location_info(&f.default, &logs(&f));
        let database: u64 = [DATABASE, "workspace.sqlite-wal", "workspace.sqlite-shm"]
            .iter()
            .map(|name| tree_size(&f.default.join(name)))
            .sum();
        assert_eq!(
            info.previous_size_bytes, database,
            "linked files are not counted as the old copy"
        );
        remove_old(&f.default).unwrap();
        assert!(!f.default.join("plugins").exists());
        assert!(!f.default.join("automations").exists());
        // What the links pointed at is untouched, permissions included.
        assert_eq!(
            fs::read_to_string(elsewhere.join("plugins-real/echo/main.js"))
                .unwrap()
                .len(),
            10_000
        );
        assert!(elsewhere.join("keep/report.txt").is_file());
        assert_eq!(mode(&elsewhere.join("keep")), 0o555);
        chmod(&elsewhere.join("keep"), 0o755);
    }

    #[test]
    fn location_info_counts_only_movable_data() {
        let f = Fixture::new();
        let empty = location_info(&f.default, &logs(&f));
        assert!(empty.size_bytes > 0, "the database counts");
        // Private files and AI staging don't count; plugins do.
        fs::create_dir_all(f.default.join("ai-staging")).unwrap();
        fs::write(f.default.join("ai-staging/big"), "x".repeat(50_000)).unwrap();
        fs::create_dir_all(f.default.join("credentials")).unwrap();
        fs::write(
            f.default.join("credentials/graph-a.json"),
            "s".repeat(5_000),
        )
        .unwrap();
        fs::write(f.default.join("window.json"), "{}").unwrap();
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
        assert!(!info.previous_copied);
        let json = serde_json::to_value(&info).unwrap();
        for key in [
            "dataRoot",
            "privateRoot",
            "logs",
            "custom",
            "sizeBytes",
            "previous",
            "previousExists",
            "previousCopied",
            "previousSizeBytes",
        ] {
            assert!(json.get(key).is_some(), "{key}");
        }
    }
}
