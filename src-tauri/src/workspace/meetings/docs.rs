//! The documents in a meeting folder: writing a run's document, choosing the main one (the one
//! called `notes.md`), deleting one (its text moves to `notes-history/`), using an earlier
//! version again and saving an edit. Every function changes the meeting record to match the
//! files; the caller stores it and rewrites `meta.json`.
use super::folder::{self, meeting_unwritable};
use super::folder_files::READ_MAX;
use super::model::*;
use super::notes::{history_name, unique_name, DocChange, NOTES_MAX};
use crate::workspace::models::*;
use std::fs;
use std::path::Path;

const HISTORY: &str = "notes-history";
/// The main document's file.
const MAIN: &str = "notes.md";
/// Where the new main document waits while the old one is renamed.
const SWAP: &str = ".notes.md.swap";

fn doc_gone() -> WorkspaceError {
    WorkspaceError::new("not_found", "This document is no longer there.")
}

fn version_gone() -> WorkspaceError {
    WorkspaceError::new("not_found", "That version of the document wasn’t kept.")
}

/// Writes a run's document; the version it replaces is copied to `notes-history/` first. A new
/// document whose file is already in the folder (the meeting's record doesn't know it, e.g.
/// after signing out and back in) never writes over it: that file moves to `notes-history/`
/// first, and its new name is returned.
pub(super) fn write_change(
    dir: &Path,
    m: &MeetingRecord,
    change: &DocChange,
    zone: &str,
) -> Result<Option<String>> {
    let unwritable = |_| meeting_unwritable(dir);
    if let Some((from, to)) = &change.history {
        // A document file someone removed has nothing to keep.
        if let Ok(old) = fs::read(dir.join(from)) {
            fs::create_dir_all(dir.join(HISTORY)).map_err(unwritable)?;
            folder::write_file(&dir.join(to), &old).map_err(unwritable)?;
        }
    }
    let kept = if change.created {
        keep_unknown(dir, m, &change.file, Some(&change.doc_id), zone)?
    } else {
        None
    };
    if let Err(e) = folder::write_file(&dir.join(&change.file), change.text.as_bytes()) {
        // Back where it was: a failed run leaves the folder as it found it.
        if let Some(name) = &kept {
            let _ = fs::rename(dir.join(name), dir.join(&change.file));
        }
        return Err(unwritable(e));
    }
    Ok(kept)
}

/// Moves `file` into `notes-history/` (named for when it was last changed) when it is in the
/// folder, so whatever is renamed or written to that name next can't destroy it. Only for a
/// name no document of the record has (besides `new`, the document about to get it): the
/// person's own file, or one from before a sign-out. The history name, or `None` when there
/// was no such file.
fn keep_unknown(
    dir: &Path,
    m: &MeetingRecord,
    file: &str,
    new: Option<&str>,
    zone: &str,
) -> Result<Option<String>> {
    if m.docs
        .iter()
        .any(|d| d.file == file && Some(d.id.as_str()) != new)
    {
        return Ok(None);
    }
    let source = dir.join(file);
    let Ok(meta) = fs::metadata(&source) else {
        return Ok(None);
    };
    if !meta.is_file() {
        return Ok(None);
    }
    let at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or_else(now, |d| d.as_secs() as i64);
    let stem = file.strip_suffix(".md").unwrap_or(file);
    let name = unique_name(&history_name(at, zone, stem), &history_taken(dir, m));
    fs::create_dir_all(dir.join(HISTORY))
        .and_then(|_| fs::rename(&source, dir.join(&name)))
        .map_err(|_| meeting_unwritable(dir))?;
    Ok(Some(name))
}

/// The history files the record names and the ones in the folder: a new one never replaces any.
pub(super) fn history_taken(dir: &Path, m: &MeetingRecord) -> Vec<String> {
    let mut taken: Vec<String> = m
        .docs
        .iter()
        .flat_map(|d| d.versions.iter().filter_map(|v| v.file.clone()))
        .collect();
    if let Ok(entries) = fs::read_dir(dir.join(HISTORY)) {
        taken.extend(
            entries
                .flatten()
                .map(|e| format!("{HISTORY}/{}", e.file_name().to_string_lossy())),
        );
    }
    taken
}

/// Moves `from` into `notes-history/` under a new name for a version made at `at`.
fn archive(
    dir: &Path,
    m: &MeetingRecord,
    from: &str,
    at: i64,
    template: &str,
    zone: &str,
) -> Result<Option<String>> {
    let source = dir.join(from);
    if !source.is_file() {
        return Ok(None);
    }
    let name = unique_name(&history_name(at, zone, template), &history_taken(dir, m));
    fs::create_dir_all(dir.join(HISTORY))
        .and_then(|_| fs::rename(&source, dir.join(&name)))
        .map_err(|_| meeting_unwritable(dir))?;
    Ok(Some(name))
}

fn rename_if_there(dir: &Path, from: &str, to: &str) -> Result<()> {
    let source = dir.join(from);
    if from == to || !source.exists() {
        return Ok(());
    }
    fs::rename(source, dir.join(to)).map_err(|_| meeting_unwritable(dir))
}

/// The file a document has when it is not the main one: `notes.<template-slug>.md`, unique
/// among the meeting's other documents.
fn side_file(m: &MeetingRecord, index: usize) -> String {
    let taken: Vec<String> = m
        .docs
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, d)| d.file.clone())
        .chain(std::iter::once(MAIN.to_string()))
        .collect();
    unique_name(
        &format!("notes.{}.md", folder::slug(&m.docs[index].name)),
        &taken,
    )
}

/// Makes `doc_id` the main document: it becomes `notes.md`, the old main one
/// `notes.<template-slug>.md`. A file the record doesn't know that has one of those names is
/// kept in `notes-history/` first; when a rename fails, the files are put back as they were.
pub(super) fn set_main(dir: &Path, m: &mut MeetingRecord, doc_id: &str, zone: &str) -> Result<()> {
    let target = m
        .docs
        .iter()
        .position(|d| d.id == doc_id)
        .ok_or_else(doc_gone)?;
    if m.main.as_deref() == Some(doc_id) && m.docs[target].file == MAIN {
        return Ok(());
    }
    let old = m
        .docs
        .iter()
        .position(|d| d.file == MAIN)
        .filter(|i| *i != target);
    let target_file = m.docs[target].file.clone();
    let side = old.map(|i| (i, side_file(m, i)));
    // Names something is renamed onto: never over a file the record doesn't know.
    keep_unknown(dir, m, SWAP, None, zone)?;
    match &side {
        Some((_, file)) => keep_unknown(dir, m, file, None, zone)?,
        None => keep_unknown(dir, m, MAIN, None, zone)?,
    };
    // Out of the way first, so the old main can't be overwritten.
    rename_if_there(dir, &target_file, SWAP)?;
    if let Some((_, file)) = &side {
        if let Err(e) = rename_if_there(dir, MAIN, file) {
            let _ = rename_if_there(dir, SWAP, &target_file);
            return Err(e);
        }
    }
    if let Err(e) = rename_if_there(dir, SWAP, MAIN) {
        if let Some((_, file)) = &side {
            let _ = rename_if_there(dir, file, MAIN);
        }
        let _ = rename_if_there(dir, SWAP, &target_file);
        return Err(e);
    }
    if let Some((i, file)) = side {
        m.docs[i].file = file;
    }
    m.docs[target].file = MAIN.into();
    m.main = Some(doc_id.into());
    Ok(())
}

/// Deletes a document: its text moves to `notes-history/`, its earlier versions stay there.
/// The next document becomes the main one; without documents the meeting has no notes. Only
/// the text the person saw (`base`) is deleted: one changed since is a `conflict`.
pub(super) fn delete(
    dir: &Path,
    m: &mut MeetingRecord,
    doc_id: &str,
    base: Base,
    zone: &str,
) -> Result<()> {
    let index = m
        .docs
        .iter()
        .position(|d| d.id == doc_id)
        .ok_or_else(doc_gone)?;
    base.check(
        &m.docs[index],
        "A new version of this document was just made, so it wasn’t deleted. Look at it, then delete it if you still want to.",
    )?;
    let doc = m.docs[index].clone();
    archive(dir, m, &doc.file, doc.updated_at, &doc.template, zone)?;
    m.docs.remove(index);
    let main_gone = m
        .main
        .as_deref()
        .is_none_or(|id| id == doc_id || !m.docs.iter().any(|d| d.id == id));
    if main_gone {
        m.main = None;
        if let Some(next) = m.docs.first().map(|d| d.id.clone()) {
            set_main(dir, m, &next, zone)?;
        }
    }
    if m.docs.is_empty() && m.state == MeetingState::Ready {
        m.state = MeetingState::Downloaded;
    }
    Ok(())
}

/// Uses an earlier, kept version of a document again: it becomes the document (with its own
/// number), and the version it replaces is kept in `notes-history/`. Only over the text the
/// person saw (`base`): a document changed since is a `conflict`.
pub(super) fn use_version(
    dir: &Path,
    m: &mut MeetingRecord,
    doc_id: &str,
    version: u32,
    base: Base,
    zone: &str,
) -> Result<()> {
    let index = m
        .docs
        .iter()
        .position(|d| d.id == doc_id)
        .ok_or_else(doc_gone)?;
    base.check(
        &m.docs[index],
        "This document changed since you chose that version, so nothing was replaced. Look at it again, then choose.",
    )?;
    if m.docs[index].version == version {
        return Ok(());
    }
    let wanted = m.docs[index]
        .versions
        .iter()
        .position(|v| v.version == version && v.file.is_some())
        .ok_or_else(version_gone)?;
    let kept = m.docs[index].versions[wanted]
        .file
        .clone()
        .unwrap_or_default();
    let text = fs::read(dir.join(&kept)).map_err(|_| version_gone())?;
    let doc = m.docs[index].clone();
    let name = unique_name(
        &history_name(doc.updated_at, zone, &doc.template),
        &history_taken(dir, m),
    );
    let current = fs::read(dir.join(&doc.file)).ok();
    if let Some(current) = &current {
        fs::create_dir_all(dir.join(HISTORY)).map_err(|_| meeting_unwritable(dir))?;
        folder::write_file(&dir.join(&name), current).map_err(|_| meeting_unwritable(dir))?;
    }
    folder::write_file(&dir.join(&doc.file), &text).map_err(|_| meeting_unwritable(dir))?;
    let _ = fs::remove_file(dir.join(&kept));
    let doc = &mut m.docs[index];
    let used = doc.versions.remove(wanted);
    if current.is_some() {
        doc.versions.push(DocVersion {
            version: doc.version,
            at: doc.updated_at,
            file: Some(name),
            profile: doc.profile.take(),
            model: doc.model.take(),
            auto: doc.auto,
            edited: doc.edited,
            wishes: doc.wishes.take(),
        });
        doc.versions.sort_by_key(|v| v.version);
    }
    doc.version = used.version;
    doc.rev += 1;
    doc.updated_at = used.at;
    doc.profile = used.profile;
    doc.model = used.model;
    doc.auto = used.auto;
    doc.edited = used.edited;
    doc.wishes = used.wishes;
    Ok(())
}

/// What a change was made on: the document's `version` and `rev` as the person saw it (when
/// the editor opened it, or when Delete or an earlier version was chosen).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Base {
    pub(super) version: Option<u32>,
    pub(super) rev: Option<u32>,
}

impl Base {
    /// `conflict` (saying `message`) unless `doc` is still what the person saw; a change that
    /// doesn't say what it saw is refused the same way.
    fn check(self, doc: &Doc, message: &str) -> Result<()> {
        if self.version != Some(doc.version) || self.rev != Some(doc.rev) {
            return Err(WorkspaceError::new("conflict", message));
        }
        Ok(())
    }
}

/// Saves the person's edit of a document, unless its text changed since they opened it: a new
/// run, an earlier version used again, or another edit (`rev`), so two windows editing from the
/// same text can't silently overwrite each other.
pub(super) fn edit(
    dir: &Path,
    m: &mut MeetingRecord,
    doc_id: &str,
    text: &str,
    base: Base,
    now: i64,
) -> Result<()> {
    let doc = m
        .docs
        .iter_mut()
        .find(|d| d.id == doc_id)
        .ok_or_else(doc_gone)?;
    base.check(
        doc,
        "This document changed while you were editing it. Copy your text, then open the document again.",
    )?;
    if text.contains('\0') {
        return Err(WorkspaceError::new(
            "validation",
            "The notes can’t be saved as they are.",
        ));
    }
    if text.len() > NOTES_MAX {
        return Err(WorkspaceError::new(
            "too_large",
            "Notes can be at most 300 KB.",
        ));
    }
    folder::write_file(&dir.join(&doc.file), text.as_bytes())
        .map_err(|_| meeting_unwritable(dir))?;
    doc.edited = true;
    doc.rev += 1;
    doc.updated_at = now;
    Ok(())
}

/// A document's text: its current version, or an earlier one that was kept.
pub(super) fn read(
    dir: &Path,
    m: &MeetingRecord,
    doc_id: &str,
    version: Option<u32>,
) -> Result<String> {
    let doc = m
        .docs
        .iter()
        .find(|d| d.id == doc_id)
        .ok_or_else(doc_gone)?;
    let file = match version {
        None => doc.file.clone(),
        Some(v) if v == doc.version => doc.file.clone(),
        Some(v) => doc
            .versions
            .iter()
            .find(|x| x.version == v)
            .and_then(|x| x.file.clone())
            .ok_or_else(version_gone)?,
    };
    let path = dir.join(&file);
    let len = fs::metadata(&path).map_err(|_| doc_gone())?.len();
    if len > READ_MAX {
        return Err(WorkspaceError::new(
            "too_large",
            "This document is too large to show.",
        ));
    }
    let bytes = fs::read(&path).map_err(|_| doc_gone())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
