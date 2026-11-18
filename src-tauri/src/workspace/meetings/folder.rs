//! Meeting folders under the meetings root (Echo-compatible names and files).
use super::model::TranscriptFiles;
use crate::workspace::models::*;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// A slug is at most this many characters.
const SLUG_MAX: usize = 60;
/// `meeting.json` is read back only up to this size.
const MEETING_JSON_MAX: u64 = 1024 * 1024;

/// The title in lower case, every run of characters that are not letters or digits turned into
/// one `-`, trimmed and cut to 60 characters; `meeting` when nothing is left. Letters of every
/// script are kept.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for ch in title.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            if gap && !out.is_empty() {
                out.push('-');
            }
            gap = false;
            out.push(ch);
        } else {
            gap = true;
        }
    }
    let cut: String = out.chars().take(SLUG_MAX).collect();
    let cut = cut.trim_matches('-');
    if cut.is_empty() {
        "meeting".into()
    } else {
        cut.into()
    }
}

/// The folder name for a meeting that started (or began transcribing) at `local_start`:
/// `echo` `YYYY-MM-DD_HHMMSS-<slug>`, `date-title` `YYYY-MM-DD-<slug>`, `title-date`
/// `<slug>-YYYY-MM-DD`.
pub fn folder_name(local_start: chrono::NaiveDateTime, title: &str, pattern: &str) -> String {
    let slug = slug(title);
    match pattern {
        "date-title" => format!("{}-{slug}", local_start.format("%Y-%m-%d")),
        "title-date" => format!("{slug}-{}", local_start.format("%Y-%m-%d")),
        _ => format!("{}-{slug}", local_start.format("%Y-%m-%d_%H%M%S")),
    }
}

/// Whether anything (a folder, a file, a dangling link) is at `path`.
fn taken(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn numbered(root: &Path, name: &str, n: u32) -> PathBuf {
    if n < 2 {
        root.join(name)
    } else {
        root.join(format!("{name}-{n}"))
    }
}

/// `root/name`, or `name-2`, `name-3`, … when it is taken.
pub fn unique_dir(root: &Path, name: &str) -> PathBuf {
    let mut n = 1;
    loop {
        let candidate = numbered(root, name, n);
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// The folder is missing, read-only or full: the person has to choose the folder again.
pub(crate) fn unwritable(path: &Path) -> WorkspaceError {
    WorkspaceError::new(
        "folder_unwritable",
        format!(
            "Connect can’t write to {}. Choose the folder again in Settings › Meetings.",
            path.display()
        ),
    )
}

/// The event id a meeting folder's `meeting.json` names.
pub fn folder_event(dir: &Path) -> Option<String> {
    let path = dir.join("meeting.json");
    if fs::metadata(&path).ok()?.len() > MEETING_JSON_MAX {
        return None;
    }
    let meeting: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    meeting["event_id"].as_str().map(String::from)
}

/// Writes `contents` to `path` through a temporary file beside it, so a reader never sees half
/// a file.
pub fn write_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("no file name"))?
        .to_string_lossy()
        .to_string();
    let tmp = path.with_file_name(format!("{name}.tmp"));
    let written = fs::write(&tmp, contents).and_then(|_| fs::rename(&tmp, path));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

fn write_files(dir: &Path, files: &TranscriptFiles) -> io::Result<()> {
    for (i, vtt) in files.vtt.iter().enumerate() {
        let name = if i == 0 {
            "transcript.vtt".to_string()
        } else {
            format!("transcript-{}.vtt", i + 1)
        };
        write_file(&dir.join(name), vtt.as_bytes())?;
    }
    write_file(&dir.join("transcript.md"), files.md.as_bytes())?;
    write_file(&dir.join("segments.json"), files.segments.as_bytes())?;
    write_file(&dir.join("meeting.json"), files.meeting.as_bytes())?;
    write_file(&dir.join("meta.json"), files.meta.as_bytes())
}

/// One meeting's folder is read-only or full (the meetings folder itself may be fine).
pub(crate) fn meeting_unwritable(dir: &Path) -> WorkspaceError {
    WorkspaceError::new(
        "folder_unwritable",
        format!(
            "Connect can’t write to this meeting’s folder: {}",
            dir.display()
        ),
    )
}

/// Writes the transcript files into a meeting's own folder again (Download again, a new speaker
/// name); its other files are left alone.
pub(crate) fn rewrite_folder(dir: &Path, files: &TranscriptFiles) -> Result<()> {
    write_files(dir, files).map_err(|_| meeting_unwritable(dir))
}

/// The root is there, or it is the default one and is created now. A custom root is never
/// created: a missing one was renamed or is on a disk that is not plugged in.
fn ensure_root(root: &Path, root_is_default: bool) -> Result<()> {
    if root.is_dir() {
        return Ok(());
    }
    if root_is_default && !taken(root) && fs::create_dir_all(root).is_ok() && root.is_dir() {
        return Ok(());
    }
    Err(unwritable(root))
}

/// Writes a meeting's transcript files into `root/name`. A folder of that name (or `name-2`, …)
/// whose `meeting.json` names the same event is the meeting's own and is written into, so saving
/// again never makes `-2`; other files in it are left alone. Otherwise the files go into
/// `<folder>.partial`, which becomes the folder only when every file is written. A failure
/// leaves nothing behind and is `folder_unwritable`.
pub fn write_transcript_folder(
    root: &Path,
    root_is_default: bool,
    name: &str,
    event_id: &str,
    files: &TranscriptFiles,
) -> Result<PathBuf> {
    ensure_root(root, root_is_default)?;
    let mut n = 1;
    loop {
        let candidate = numbered(root, name, n);
        if !taken(&candidate) {
            break;
        }
        if candidate.is_dir() && folder_event(&candidate).as_deref() == Some(event_id) {
            write_files(&candidate, files).map_err(|_| meeting_unwritable(&candidate))?;
            return Ok(candidate);
        }
        n += 1;
    }
    let target = unique_dir(root, name);
    let leaf = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let partial = root.join(format!("{leaf}.partial"));
    // A `.partial` folder is only ever Connect's own, left by a save that was cut off.
    let _ = fs::remove_dir_all(&partial);
    let written = fs::create_dir(&partial)
        .and_then(|_| write_files(&partial, files))
        .and_then(|_| fs::rename(&partial, &target));
    if written.is_err() {
        let _ = fs::remove_dir_all(&partial);
        return Err(unwritable(root));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use std::fs;
    use tempfile::tempdir;

    fn files(event: &str, md: &str) -> TranscriptFiles {
        TranscriptFiles {
            vtt: vec!["WEBVTT\n".into()],
            md: md.into(),
            segments: "[]".into(),
            meeting: serde_json::json!({ "event_id": event }).to_string(),
            meta: "{}".into(),
        }
    }

    const NAMES: [&str; 5] = [
        "transcript.vtt",
        "transcript.md",
        "segments.json",
        "meeting.json",
        "meta.json",
    ];

    #[test]
    fn folder_names_keep_unicode_and_never_collide() {
        assert_eq!(
            slug("Philips CodeMie conversations syncup"),
            "philips-codemie-conversations-syncup"
        );
        assert_eq!(slug("Планування / Q1 🚀"), "планування-q1");
        assert_eq!(slug("🚀 / !!"), "meeting");
        assert_eq!(slug(""), "meeting");
        let long = slug(&"a ".repeat(80));
        assert!(long.chars().count() <= 60);
        assert!(!long.ends_with('-'), "a cut never leaves a dash: {long}");
        assert!(slug(&"ж".repeat(100)).chars().count() == 60);
        let t = NaiveDate::from_ymd_opt(2026, 11, 4)
            .unwrap()
            .and_hms_opt(16, 4, 26)
            .unwrap();
        assert_eq!(
            folder_name(t, "Philips CodeMie conversations syncup", "echo"),
            "2026-11-04_160426-philips-codemie-conversations-syncup"
        );
        assert_eq!(
            folder_name(t, "Daily stand-up", "date-title"),
            "2026-11-04-daily-stand-up"
        );
        assert_eq!(
            folder_name(t, "Daily stand-up", "title-date"),
            "daily-stand-up-2026-11-04"
        );
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("x")).unwrap();
        assert_eq!(unique_dir(dir.path(), "x"), dir.path().join("x-2"));
        fs::create_dir(dir.path().join("x-2")).unwrap();
        assert_eq!(unique_dir(dir.path(), "x"), dir.path().join("x-3"));
        assert_eq!(unique_dir(dir.path(), "y"), dir.path().join("y"));
        // Two "Daily stand-up" meetings that started in the same second.
        let name = folder_name(t, "Daily stand-up", "echo");
        let a =
            write_transcript_folder(dir.path(), false, &name, "event-a", &files("event-a", "a"))
                .unwrap();
        let b =
            write_transcript_folder(dir.path(), false, &name, "event-b", &files("event-b", "b"))
                .unwrap();
        assert_eq!(a, dir.path().join(&name));
        assert_eq!(b, dir.path().join(format!("{name}-2")));
        assert_eq!(fs::read_to_string(b.join("transcript.md")).unwrap(), "b");
    }

    #[cfg(unix)]
    #[test]
    fn download_into_unwritable_root_leaves_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let root = dir.path().join("Meetings");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        let custom = write_transcript_folder(
            &root,
            false,
            "2026-11-04_160426-sync",
            "e",
            &files("e", "x"),
        );
        let default =
            write_transcript_folder(&root, true, "2026-11-04_160426-sync", "e", &files("e", "x"));
        let left = fs::read_dir(&root).unwrap().count();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        for result in [custom, default] {
            let e = result.unwrap_err();
            assert_eq!(e.code, "folder_unwritable");
            assert!(
                e.message.contains("Choose the folder again"),
                "{}",
                e.message
            );
        }
        assert_eq!(left, 0, "no folder and no .partial folder is left behind");
    }

    #[test]
    fn default_root_is_created_on_first_download() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("CodeMie Connect").join("Meetings");
        let path = write_transcript_folder(
            &root,
            true,
            "2026-11-04_160426-sync",
            "e",
            &files("e", "md"),
        )
        .unwrap();
        assert_eq!(path, root.join("2026-11-04_160426-sync"));
        for name in NAMES {
            assert!(path.join(name).is_file(), "{name}");
        }
        assert!(!root.join("2026-11-04_160426-sync.partial").exists());
        // Without the original VTT there is no transcript.vtt.
        let mut no_vtt = files("f", "md");
        no_vtt.vtt = Vec::new();
        let other = write_transcript_folder(&root, true, "other", "f", &no_vtt).unwrap();
        assert!(!other.join("transcript.vtt").exists());
        assert!(other.join("transcript.md").is_file());
    }

    #[test]
    fn missing_custom_root_fails_with_folder_unwritable() {
        let dir = tempdir().unwrap();
        // Renamed, or on an external disk that is unplugged.
        let root = dir.path().join("Renamed").join("Meetings");
        let e = write_transcript_folder(&root, false, "n", "e", &files("e", "x")).unwrap_err();
        assert_eq!(e.code, "folder_unwritable");
        assert!(
            e.message.contains("Choose the folder again"),
            "{}",
            e.message
        );
        assert!(!root.exists(), "a custom root is never created");
        assert!(!dir.path().join("Renamed").exists());
        // A file where the folder should be.
        let file = dir.path().join("file");
        fs::write(&file, "x").unwrap();
        let e = write_transcript_folder(&file, true, "n", "e", &files("e", "x")).unwrap_err();
        assert_eq!(e.code, "folder_unwritable");
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_meeting_folder_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let root = dir.path();
        let own = write_transcript_folder(root, false, "n", "e", &files("e", "one")).unwrap();
        fs::set_permissions(&own, fs::Permissions::from_mode(0o555)).unwrap();
        let rewrite = rewrite_folder(&own, &files("e", "two"));
        let again = write_transcript_folder(root, false, "n", "e", &files("e", "two"));
        fs::set_permissions(&own, fs::Permissions::from_mode(0o755)).unwrap();
        for result in [rewrite.map(|_| own.clone()), again] {
            let e = result.unwrap_err();
            assert_eq!(e.code, "folder_unwritable");
            assert_eq!(
                e.message,
                format!(
                    "Connect can’t write to this meeting’s folder: {}",
                    own.display()
                )
            );
        }
    }

    #[test]
    fn several_originals_are_numbered() {
        let dir = tempdir().unwrap();
        let mut two = files("e", "md");
        two.vtt = vec!["WEBVTT\n\nfirst".into(), "WEBVTT\n\nsecond".into()];
        let path = write_transcript_folder(dir.path(), false, "n", "e", &two).unwrap();
        assert_eq!(
            fs::read_to_string(path.join("transcript.vtt")).unwrap(),
            "WEBVTT\n\nfirst"
        );
        assert_eq!(
            fs::read_to_string(path.join("transcript-2.vtt")).unwrap(),
            "WEBVTT\n\nsecond"
        );
        assert!(!path.join("transcript-3.vtt").exists());
    }

    #[test]
    fn same_event_reuses_its_folder() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let first = write_transcript_folder(root, false, "n", "e", &files("e", "one")).unwrap();
        fs::write(first.join("notes.md"), "my notes").unwrap();
        let again = write_transcript_folder(root, false, "n", "e", &files("e", "two")).unwrap();
        assert_eq!(
            again, first,
            "the same event writes into its own folder, not n-2"
        );
        assert_eq!(
            fs::read_to_string(again.join("transcript.md")).unwrap(),
            "two"
        );
        assert_eq!(
            fs::read_to_string(again.join("notes.md")).unwrap(),
            "my notes",
            "files other than the transcript's are left alone"
        );
        // Another event that slugs to the same name gets -2, and keeps it afterwards.
        let other = write_transcript_folder(root, false, "n", "o", &files("o", "x")).unwrap();
        assert_eq!(other, root.join("n-2"));
        let other_again = write_transcript_folder(root, false, "n", "o", &files("o", "y")).unwrap();
        assert_eq!(other_again, root.join("n-2"));
        // A rewrite without the original VTT keeps the one already there.
        let mut no_vtt = files("e", "three");
        no_vtt.vtt = Vec::new();
        write_transcript_folder(root, false, "n", "e", &no_vtt).unwrap();
        assert!(first.join("transcript.vtt").is_file());
        // A folder whose meeting.json is unreadable is never taken over.
        fs::create_dir(root.join("m")).unwrap();
        fs::write(root.join("m").join("meeting.json"), "{not json").unwrap();
        assert_eq!(
            write_transcript_folder(root, false, "m", "e2", &files("e2", "x")).unwrap(),
            root.join("m-2")
        );
        assert_eq!(
            fs::read_to_string(root.join("m").join("meeting.json")).unwrap(),
            "{not json"
        );
        // No temporary files are left anywhere.
        for entry in fs::read_dir(root).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            assert!(!name.ends_with(".partial"), "{name}");
            for inner in fs::read_dir(entry.path()).unwrap().flatten() {
                assert!(!inner.file_name().to_string_lossy().ends_with(".tmp"));
            }
        }
    }
}
