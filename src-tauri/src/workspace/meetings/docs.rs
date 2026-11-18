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

fn doc_gone() -> WorkspaceError {
    WorkspaceError::new("not_found", "This document is no longer there.")
}

fn version_gone() -> WorkspaceError {
    WorkspaceError::new("not_found", "That version of the document wasn’t kept.")
}

/// Writes a run's document; the version it replaces is copied to `notes-history/` first.
pub(super) fn write_change(dir: &Path, change: &DocChange) -> Result<()> {
    let unwritable = |_| meeting_unwritable(dir);
    if let Some((from, to)) = &change.history {
        // A document file someone removed has nothing to keep.
        if let Ok(old) = fs::read(dir.join(from)) {
            fs::create_dir_all(dir.join(HISTORY)).map_err(unwritable)?;
            folder::write_file(&dir.join(to), &old).map_err(unwritable)?;
        }
    }
    folder::write_file(&dir.join(&change.file), change.text.as_bytes()).map_err(unwritable)
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
/// `notes.<template-slug>.md`.
pub(super) fn set_main(dir: &Path, m: &mut MeetingRecord, doc_id: &str) -> Result<()> {
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
    // Out of the way first, so the old main can't be overwritten.
    let swap = ".notes.md.swap";
    rename_if_there(dir, &m.docs[target].file.clone(), swap)?;
    if let Some(i) = old {
        let file = side_file(m, i);
        rename_if_there(dir, MAIN, &file)?;
        m.docs[i].file = file;
    }
    rename_if_there(dir, swap, MAIN)?;
    m.docs[target].file = MAIN.into();
    m.main = Some(doc_id.into());
    Ok(())
}

/// Deletes a document: its text moves to `notes-history/`, its earlier versions stay there.
/// The next document becomes the main one; without documents the meeting has no notes.
pub(super) fn delete(dir: &Path, m: &mut MeetingRecord, doc_id: &str, zone: &str) -> Result<()> {
    let index = m
        .docs
        .iter()
        .position(|d| d.id == doc_id)
        .ok_or_else(doc_gone)?;
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
            set_main(dir, m, &next)?;
        }
    }
    if m.docs.is_empty() && m.state == MeetingState::Ready {
        m.state = MeetingState::Downloaded;
    }
    Ok(())
}

/// Uses an earlier, kept version of a document again: it becomes the document (with its own
/// number), and the version it replaces is kept in `notes-history/`.
pub(super) fn use_version(
    dir: &Path,
    m: &mut MeetingRecord,
    doc_id: &str,
    version: u32,
    zone: &str,
) -> Result<()> {
    let index = m
        .docs
        .iter()
        .position(|d| d.id == doc_id)
        .ok_or_else(doc_gone)?;
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

/// What an edit was opened on: the document's `version` and `rev` when the editor opened it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Base {
    pub(super) version: Option<u32>,
    pub(super) rev: Option<u32>,
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
    if base.version != Some(doc.version) || base.rev != Some(doc.rev) {
        return Err(WorkspaceError::new(
            "conflict",
            "This document changed while you were editing it. Copy your text, then open the document again.",
        ));
    }
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
