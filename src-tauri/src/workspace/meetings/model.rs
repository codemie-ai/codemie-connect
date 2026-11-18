//! The meeting record, its settings and the small types the meetings code shares.
use crate::workspace::models::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Where a meeting's transcript and notes stand. `downloading` and `processing` are run states
/// shown from the jobs; they are never stored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingState {
    /// The meeting is not over.
    Upcoming,
    /// Ended less than a day ago; Teams has no transcript yet.
    #[default]
    Pending,
    /// Found in Teams: being saved, or the save failed (`save_error`).
    Available,
    /// The transcript is in the meeting folder; no notes yet.
    Downloaded,
    /// At least one document.
    Ready,
    /// The last notes run failed.
    Failed,
    /// Microsoft refused the transcript (another tenant, transcripts turned off).
    Blocked,
    /// Ended over a day ago with no transcript.
    None,
    /// Not an online meeting.
    Offline,
}

/// A stored copy of a [`WorkspaceError`]: why a check, save or run did not work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorInfo {
    pub code: String,
    pub message: String,
}
impl From<&WorkspaceError> for ErrorInfo {
    fn from(e: &WorkspaceError) -> Self {
        Self {
            code: e.code.clone(),
            message: e.message.clone(),
        }
    }
}

/// Someone at the meeting: the organizer or an attendee.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub name: String,
    pub address: String,
}

/// Who "me" is in a transcript: the account's name and the other names people use for it
/// (the glossary's `## Me` section, from Task 3), and the account's e-mail, which finds me among
/// the attendees before any name does.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeAlias {
    pub name: String,
    pub aliases: Vec<String>,
    #[serde(default)]
    pub address: Option<String>,
}

impl MeAlias {
    /// "Me" as the account says it: its display name and e-mail, no aliases.
    pub fn of(c: &Connection) -> Self {
        Self {
            name: c.display_name.clone(),
            aliases: Vec::new(),
            address: Some(c.email.trim().to_string()).filter(|a| !a.is_empty()),
        }
    }
}

/// One Teams transcript of a meeting and when Teams started it (unix seconds).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptRef {
    pub id: String,
    pub created: i64,
}

/// The transcript files of a meeting folder, ready to write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptFiles {
    /// The originals from Teams, untouched: `transcript.vtt`, then `transcript-2.vtt`, … for a
    /// meeting transcribed more than once; empty when they are not kept.
    pub vtt: Vec<String>,
    /// `transcript.md`
    pub md: String,
    /// `segments.json`
    pub segments: String,
    /// `meeting.json`
    pub meeting: String,
    /// `meta.json`
    pub meta: String,
}

/// One earlier version of a document, kept in `notes-history/` while Settings › Meetings keeps
/// earlier versions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DocVersion {
    pub version: u32,
    /// When this version was written (or last edited).
    pub at: i64,
    /// `notes-history/<YYYY-MM-DD_HHMM>-<template-id>.md`.
    pub file: Option<String>,
    /// The Claude profile and model that wrote it.
    pub profile: Option<String>,
    pub model: Option<String>,
    /// Made automatically, not asked for by the person.
    pub auto: bool,
    /// Changed by the person after Claude wrote it.
    pub edited: bool,
    /// What the person asked the run to focus on.
    pub wishes: Option<String>,
}

/// A document made from a transcript with one template. Running the same template again adds
/// a version: the current one is `version`, the earlier ones kept are `versions`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Doc {
    /// The template's id: one document per template.
    pub id: String,
    pub template: String,
    /// The template's name when the document was made.
    pub name: String,
    /// `notes.md` for the main document, `notes.<template-slug>.md` for the others.
    pub file: String,
    pub version: u32,
    /// Goes up by one whenever the document's text changes (a run, a person's edit, an earlier
    /// version used again). An edit names the `version` and `rev` it was opened on; anything
    /// else is a conflict.
    pub rev: u32,
    /// Earlier versions that were kept, oldest first.
    pub versions: Vec<DocVersion>,
    pub created_at: i64,
    /// When the current version was written (or last edited).
    pub updated_at: i64,
    /// The Claude profile and model that wrote the current version.
    pub profile: Option<String>,
    pub model: Option<String>,
    /// The current version was made automatically.
    pub auto: bool,
    /// The current version was changed by the person after Claude wrote it.
    pub edited: bool,
    /// What the person asked the current version to focus on.
    pub wishes: Option<String>,
}

/// The meetings folder as the snapshot carries it (`meetingsRoot`): `settings.meetings.root`
/// resolved, the default one when that is empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingsRoot {
    pub path: String,
    pub is_default: bool,
}

/// The local record kind of a meeting; its id is the event record's id.
pub const KIND: &str = "meeting";

/// A meeting's transcript and notes, stored as record kind [`KIND`] beside its event.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MeetingRecord {
    pub event_id: String,
    pub title: String,
    /// RFC 3339, UTC, as the event has it.
    pub start: String,
    pub end: String,
    pub state: MeetingState,
    /// This occurrence's Teams transcripts, oldest first.
    pub transcript_ids: Vec<String>,
    /// When Teams started transcribing (RFC 3339): the folder's time.
    pub transcript_start: Option<String>,
    /// The meeting folder (absolute path).
    pub folder: Option<String>,
    pub checked_at: Option<i64>,
    /// Why the meeting is in its state (`transcript_blocked`, or a check that did not get through).
    pub error: Option<ErrorInfo>,
    /// The Teams online meeting id the transcripts belong to.
    pub external: Option<String>,
    /// The name of the file the transcript was imported from.
    pub imported: Option<String>,
    /// Speaker mapping: the voice as the transcript writes it -> the attendee's address.
    pub speakers: BTreeMap<String, String>,
    /// The template chosen for this meeting (Task 3).
    pub template: Option<String>,
    /// Make notes as soon as the transcript is saved (Task 3).
    pub auto: Option<bool>,
    pub docs: Vec<Doc>,
    /// The id of the main document (Task 3).
    pub main: Option<String>,
    /// Why the last save from Teams failed (`cancelled` when the person stopped it: then only
    /// they start it again); cleared by a save that works.
    pub save_error: Option<ErrorInfo>,
    /// Why the last notes run failed; cleared by a run that works.
    pub notes_error: Option<ErrorInfo>,
    /// Notes the person asked for while the save failed for a reason that passes: the next save
    /// that works queues them once.
    pub pending_notes: Option<PendingNotes>,
    /// Older records kept one error for both steps: read only, and split by
    /// [`MeetingRecord::split_legacy_error`] when the record is read.
    #[serde(skip_serializing)]
    pub last_error: Option<ErrorInfo>,
    /// Transcript lines whose task the person deleted: notes made again don't bring it back.
    pub removed_lines: Vec<u64>,
}

/// A Make notes that waits for the transcript: what it asked for, where its tasks go, and the
/// job that asked (the job queued after the save is keyed by it, so it is queued once).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PendingNotes {
    pub template_id: String,
    pub wishes: String,
    pub find_tasks: bool,
    pub workspace_id: String,
    pub job_id: String,
}

impl MeetingRecord {
    /// An older record's one `lastError` becomes the step it belonged to, once: before a
    /// transcript is saved (`available`, `downloaded`) only a save wrote it; on a `ready` or
    /// `failed` meeting it was shown as the last notes run's. A record that already has the
    /// two fields keeps them.
    pub fn split_legacy_error(&mut self) {
        let Some(e) = self.last_error.take() else {
            return;
        };
        if self.save_error.is_some() || self.notes_error.is_some() {
            return;
        }
        if matches!(self.state, MeetingState::Ready | MeetingState::Failed) {
            self.notes_error = Some(e);
        } else {
            self.save_error = Some(e);
        }
    }
}

/// `settings.meetings` (Settings › Meetings).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MeetingSettings {
    /// The meetings root; `None` is `~/CodeMie Connect/Meetings`.
    pub root: Option<String>,
    /// `echo` (`YYYY-MM-DD_HHMMSS-<slug>`), `date-title` or `title-date`.
    pub folder_pattern: String,
    /// How often a waiting meeting is checked: 5, 10 or 30 minutes.
    pub check_every_min: i64,
    /// `off`, `rules` or `all`.
    pub auto_notes: String,
    pub wait_min: i64,
    pub skip_short: bool,
    pub keep_vtt: bool,
    pub keep_versions: bool,
    pub review: bool,
    pub only_attendees: bool,
    pub we_me: bool,
    pub ask_speakers: bool,
    /// `connect` (glossary.md and tags.md in the root) or `file` (the two linked files).
    pub glossary_source: String,
    pub glossary_file: Option<String>,
    pub tags_file: Option<String>,
    pub default_template: String,
    /// Board column names by status; a missing one uses the built-in name.
    pub columns: BTreeMap<String, String>,
    pub done_days: i64,
    pub remind: bool,
    pub due_only_said: bool,
}
impl Default for MeetingSettings {
    fn default() -> Self {
        Self {
            root: None,
            folder_pattern: "echo".into(),
            check_every_min: 10,
            auto_notes: "rules".into(),
            wait_min: 15,
            skip_short: true,
            keep_vtt: true,
            keep_versions: true,
            review: true,
            only_attendees: true,
            we_me: true,
            ask_speakers: true,
            glossary_source: "connect".into(),
            glossary_file: None,
            tags_file: None,
            default_template: "meeting-notes".into(),
            columns: BTreeMap::new(),
            done_days: 14,
            remind: true,
            due_only_said: true,
        }
    }
}

/// Task statuses whose board column can be renamed.
const COLUMNS: [&str; 5] = ["review", "todo", "doing", "waiting", "done"];
const PATH_MAX: usize = 1024;

fn invalid(field: &str, message: &str) -> WorkspaceError {
    let mut e = WorkspaceError::new("validation", message);
    e.field = Some(field.into());
    e
}
fn one_of(v: &Value, field: &str, allowed: &[&str], message: &str) -> Result<String> {
    v.as_str()
        .filter(|s| allowed.contains(s))
        .map(String::from)
        .ok_or_else(|| invalid(field, message))
}
fn flag(v: &Value, field: &str) -> Result<bool> {
    v.as_bool()
        .ok_or_else(|| invalid(field, "Turn this setting on or off."))
}
fn number(
    v: &Value,
    field: &str,
    range: std::ops::RangeInclusive<i64>,
    message: &str,
) -> Result<i64> {
    v.as_i64()
        .filter(|n| range.contains(n))
        .ok_or_else(|| invalid(field, message))
}
/// An absolute path, or `None` for empty and null.
fn path(v: &Value, field: &str, message: &str) -> Result<Option<String>> {
    if v.is_null() {
        return Ok(None);
    }
    let s = v.as_str().ok_or_else(|| invalid(field, message))?.trim();
    if s.is_empty() {
        return Ok(None);
    }
    if s.len() > PATH_MAX || s.contains('\0') || !std::path::Path::new(s).is_absolute() {
        return Err(invalid(field, message));
    }
    Ok(Some(s.to_string()))
}

impl MeetingSettings {
    /// Applies `settings_update {meetings: {...}}`: only the fields given change, each one
    /// checked; nothing changes when one of them is refused.
    pub fn apply(&mut self, data: &Value) -> Result<()> {
        let fields = data
            .as_object()
            .ok_or_else(|| invalid("meetings", "Send the meeting settings as an object."))?;
        let mut next = self.clone();
        for (key, v) in fields {
            match key.as_str() {
                "root" => {
                    let root = path(v, key, "Choose a folder for your meetings.")?;
                    // A new folder must be there; the stored one is not checked again, so other
                    // settings still save while its disk is unplugged.
                    if let Some(dir) = root.as_deref().filter(|r| Some(*r) != self.root.as_deref())
                    {
                        if !std::path::Path::new(dir).is_dir() {
                            return Err(invalid(
                                key,
                                "That folder doesn’t exist. Choose another one.",
                            ));
                        }
                    }
                    next.root = root;
                }
                "folderPattern" => {
                    next.folder_pattern = one_of(
                        v,
                        key,
                        &["echo", "date-title", "title-date"],
                        "Choose a folder name pattern.",
                    )?
                }
                "checkEveryMin" => {
                    next.check_every_min = v
                        .as_i64()
                        .filter(|n| matches!(n, 5 | 10 | 30))
                        .ok_or_else(|| {
                            invalid(key, "Look for transcripts every 5, 10 or 30 minutes.")
                        })?
                }
                "autoNotes" => {
                    next.auto_notes = one_of(
                        v,
                        key,
                        &["off", "rules", "all"],
                        "Choose when notes are made automatically.",
                    )?
                }
                "waitMin" => {
                    next.wait_min = number(
                        v,
                        key,
                        0..=240,
                        "Wait between 0 and 240 minutes after the meeting.",
                    )?
                }
                "skipShort" => next.skip_short = flag(v, key)?,
                "keepVtt" => next.keep_vtt = flag(v, key)?,
                "keepVersions" => next.keep_versions = flag(v, key)?,
                "review" => next.review = flag(v, key)?,
                "onlyAttendees" => next.only_attendees = flag(v, key)?,
                "weMe" => next.we_me = flag(v, key)?,
                "askSpeakers" => next.ask_speakers = flag(v, key)?,
                "remind" => next.remind = flag(v, key)?,
                "dueOnlySaid" => next.due_only_said = flag(v, key)?,
                "glossarySource" => {
                    next.glossary_source = one_of(
                        v,
                        key,
                        &["connect", "file"],
                        "Choose where the glossary and tags live.",
                    )?
                }
                "glossaryFile" => {
                    next.glossary_file = path(v, key, "Choose the glossary file by its full path.")?
                }
                "tagsFile" => {
                    next.tags_file = path(v, key, "Choose the tags file by its full path.")?
                }
                "defaultTemplate" => {
                    next.default_template = v
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && s.len() <= 100 && !s.contains('\0'))
                        .map(String::from)
                        .ok_or_else(|| invalid(key, "Choose a default template."))?
                }
                "columns" => {
                    let names = v
                        .as_object()
                        .ok_or_else(|| invalid(key, "Name the board columns."))?;
                    for (status, name) in names {
                        if !COLUMNS.contains(&status.as_str()) {
                            return Err(invalid(key, "Name only the board's own columns."));
                        }
                        let name = if name.is_null() {
                            ""
                        } else {
                            name.as_str()
                                .ok_or_else(|| invalid(key, "Name the board columns."))?
                                .trim()
                        };
                        if name.is_empty() {
                            next.columns.remove(status);
                        } else if name.chars().count() > 40 || name.contains('\0') {
                            return Err(invalid(key, "Keep column names to 40 characters."));
                        } else {
                            next.columns.insert(status.clone(), name.into());
                        }
                    }
                }
                "doneDays" => {
                    next.done_days =
                        number(v, key, 1..=365, "Hide done tasks after 1 to 365 days.")?
                }
                _ => return Err(invalid(key, "Unknown meeting setting.")),
            }
        }
        *self = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn meeting_settings_default_and_serialize_camel_case() {
        let s = MeetingSettings::default();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(
            v,
            json!({"root": null, "folderPattern": "echo", "checkEveryMin": 10, "autoNotes": "rules",
                "waitMin": 15, "skipShort": true, "keepVtt": true, "keepVersions": true, "review": true,
                "onlyAttendees": true, "weMe": true, "askSpeakers": true, "glossarySource": "connect",
                "glossaryFile": null, "tagsFile": null, "defaultTemplate": "meeting-notes", "columns": {},
                "doneDays": 14, "remind": true, "dueOnlySaid": true})
        );
        // Older settings without the group, or with only part of it, read as the defaults.
        let settings: Settings = serde_json::from_value(json!({"theme": "dark"})).unwrap();
        assert_eq!(settings.meetings, MeetingSettings::default());
        let partial: MeetingSettings =
            serde_json::from_value(json!({"checkEveryMin": 30})).unwrap();
        assert_eq!(partial.check_every_min, 30);
        assert_eq!(partial.wait_min, 15);
        assert!(serde_json::to_value(Settings::default()).unwrap()["meetings"].is_object());
    }

    #[test]
    fn meeting_settings_validate_every_field() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let mut s = MeetingSettings::default();
        s.apply(&json!({"root": folder, "folderPattern": "title-date", "checkEveryMin": 5,
            "autoNotes": "all", "waitMin": 0, "skipShort": false, "keepVtt": false, "keepVersions": false,
            "review": false, "onlyAttendees": false, "weMe": false, "askSpeakers": false,
            "glossarySource": "file", "glossaryFile": "/Users/taylor/TERMS_TAXONOMY.md",
            "tagsFile": "/Users/taylor/TAG_TAXONOMY.md", "defaultTemplate": "short-summary",
            "columns": {"review": "Inbox", "done": " Shipped "}, "doneDays": 30, "remind": false,
            "dueOnlySaid": false}))
            .unwrap();
        assert_eq!(s.root.as_deref(), Some(folder.as_str()));
        assert_eq!(s.folder_pattern, "title-date");
        assert_eq!(s.check_every_min, 5);
        assert_eq!(s.auto_notes, "all");
        assert_eq!(s.wait_min, 0);
        assert!(!s.skip_short && !s.keep_vtt && !s.keep_versions && !s.review);
        assert!(!s.only_attendees && !s.we_me && !s.ask_speakers && !s.remind && !s.due_only_said);
        assert_eq!(s.glossary_source, "file");
        assert_eq!(
            s.glossary_file.as_deref(),
            Some("/Users/taylor/TERMS_TAXONOMY.md")
        );
        assert_eq!(
            s.tags_file.as_deref(),
            Some("/Users/taylor/TAG_TAXONOMY.md")
        );
        assert_eq!(s.default_template, "short-summary");
        assert_eq!(s.columns.get("done").map(String::as_str), Some("Shipped"));
        assert_eq!(s.done_days, 30);
        // Empty or null clears: the default root, no linked files, the default column name.
        s.apply(&json!({"root": "", "glossaryFile": null, "columns": {"done": ""}}))
            .unwrap();
        assert_eq!(s.root, None);
        assert_eq!(s.glossary_file, None);
        assert!(!s.columns.contains_key("done"));
        assert_eq!(s.columns.get("review").map(String::as_str), Some("Inbox"));
        let before = s.clone();
        for (data, field) in [
            (json!({"folderPattern": "slug"}), "folderPattern"),
            (json!({"checkEveryMin": 15}), "checkEveryMin"),
            (json!({"checkEveryMin": "10"}), "checkEveryMin"),
            (json!({"autoNotes": "some"}), "autoNotes"),
            (json!({"waitMin": -1}), "waitMin"),
            (json!({"waitMin": 500}), "waitMin"),
            (json!({"skipShort": "yes"}), "skipShort"),
            (json!({"glossarySource": "web"}), "glossarySource"),
            (json!({"glossaryFile": "relative/terms.md"}), "glossaryFile"),
            (json!({"tagsFile": 7}), "tagsFile"),
            (json!({"defaultTemplate": ""}), "defaultTemplate"),
            (json!({"columns": {"later": "Later"}}), "columns"),
            (json!({"columns": {"todo": "x".repeat(41)}}), "columns"),
            (json!({"columns": []}), "columns"),
            (json!({"doneDays": 0}), "doneDays"),
            (json!({"doneDays": 366}), "doneDays"),
            (json!({"root": "relative/path"}), "root"),
            (
                json!({"root": dir.path().join("missing").to_string_lossy()}),
                "root",
            ),
            (json!({"rootDir": "/tmp"}), "rootDir"),
            (json!("all"), "meetings"),
        ] {
            let mut copy = before.clone();
            let e = copy.apply(&data).unwrap_err();
            assert_eq!(e.code, "validation", "{data}");
            assert_eq!(e.field.as_deref(), Some(field), "{data}");
            assert_eq!(copy, before, "a refused update changes nothing: {data}");
        }
        // The stored root is not checked again when other fields change (the disk may be out).
        let mut gone = MeetingSettings {
            root: Some("/Volumes/Gone/Meetings".into()),
            ..Default::default()
        };
        gone.apply(&json!({"root": "/Volumes/Gone/Meetings", "waitMin": 20}))
            .unwrap();
        assert_eq!(gone.wait_min, 20);
    }

    #[test]
    fn meeting_records_serialize_camel_case_with_snake_case_states() {
        let record = MeetingRecord {
            event_id: "e1".into(),
            title: "Weekly sync".into(),
            start: "2026-11-04T16:00:00Z".into(),
            end: "2026-11-04T16:30:00Z".into(),
            state: MeetingState::None,
            transcript_ids: vec!["t1".into()],
            save_error: Some(ErrorInfo {
                code: "folder_unwritable".into(),
                message: "Choose the folder again.".into(),
            }),
            notes_error: Some(ErrorInfo {
                code: "needs_login".into(),
                message: "Claude is not signed in.".into(),
            }),
            pending_notes: Some(PendingNotes {
                template_id: "short-summary".into(),
                wishes: "Keep it short".into(),
                find_tasks: false,
                workspace_id: "personal".into(),
                job_id: "j1".into(),
            }),
            ..Default::default()
        };
        let v = serde_json::to_value(&record).unwrap();
        assert_eq!(v["eventId"], "e1");
        assert_eq!(v["state"], "none");
        assert_eq!(v["transcriptIds"], json!(["t1"]));
        assert_eq!(v["saveError"]["code"], "folder_unwritable");
        assert_eq!(v["notesError"]["code"], "needs_login");
        assert_eq!(
            v["pendingNotes"],
            json!({"templateId": "short-summary", "wishes": "Keep it short", "findTasks": false,
                "workspaceId": "personal", "jobId": "j1"})
        );
        assert!(v.get("lastError").is_none(), "one field per step");
        for key in [
            "transcriptStart",
            "folder",
            "checkedAt",
            "error",
            "external",
            "imported",
            "speakers",
            "template",
            "auto",
            "docs",
            "main",
        ] {
            assert!(v.get(key).is_some(), "{key}");
        }
        let back: MeetingRecord = serde_json::from_value(v).unwrap();
        assert_eq!(back, record);
        // A record a later version wrote with fields this one doesn't know still reads.
        let minimal: MeetingRecord =
            serde_json::from_value(json!({"eventId": "e", "state": "pending", "future": 1}))
                .unwrap();
        assert_eq!(minimal.state, MeetingState::Pending);
        let states: Vec<Value> = [
            MeetingState::Upcoming,
            MeetingState::Pending,
            MeetingState::Available,
            MeetingState::Downloaded,
            MeetingState::Ready,
            MeetingState::Failed,
            MeetingState::Blocked,
            MeetingState::None,
            MeetingState::Offline,
        ]
        .iter()
        .map(|s| serde_json::to_value(s).unwrap())
        .collect();
        assert_eq!(
            states,
            vec![
                json!("upcoming"),
                json!("pending"),
                json!("available"),
                json!("downloaded"),
                json!("ready"),
                json!("failed"),
                json!("blocked"),
                json!("none"),
                json!("offline")
            ]
        );
        assert_eq!(
            ErrorInfo::from(&WorkspaceError::new("throttled", "Wait.")),
            ErrorInfo {
                code: "throttled".into(),
                message: "Wait.".into()
            }
        );
    }

    #[test]
    fn an_old_last_error_is_read_once_as_the_save_or_the_notes_error() {
        let old = |state: &str| {
            let mut m: MeetingRecord = serde_json::from_value(json!({"eventId": "e",
                "state": state, "lastError": {"code": "provider", "message": "Teams didn’t answer."}}))
            .unwrap();
            m.split_legacy_error();
            m
        };
        // Before notes exist the field could only be a save's; a failed or ready meeting showed
        // it as the notes run's.
        for state in ["available", "downloaded"] {
            let m = old(state);
            assert_eq!(m.save_error.unwrap().code, "provider", "{state}");
            assert!(m.notes_error.is_none() && m.last_error.is_none());
        }
        for state in ["ready", "failed"] {
            let m = old(state);
            assert_eq!(m.notes_error.unwrap().code, "provider", "{state}");
            assert!(m.save_error.is_none() && m.last_error.is_none());
        }
        // Written again, the old field is gone.
        let v = serde_json::to_value(old("failed")).unwrap();
        assert!(v.get("lastError").is_none());
        assert_eq!(v["notesError"]["code"], "provider");
        // A record that has the new fields keeps them.
        let mut both: MeetingRecord = serde_json::from_value(json!({"eventId": "e", "state": "ready",
            "lastError": {"code": "x", "message": "x"}, "saveError": {"code": "offline", "message": "o"}}))
        .unwrap();
        both.split_legacy_error();
        assert_eq!(both.save_error.unwrap().code, "offline");
        assert!(both.notes_error.is_none());
    }
}
