//! The meeting operations a person starts, and the read-only reads of a meeting folder.
use super::docs;
use super::folder;
use super::folder_files::{read_segments, READ_MAX};
use super::model::*;
use super::record::*;
use crate::storage::commands::{reveal, Place};
use crate::workspace::{graph, models::*, new_job, Core};
use serde_json::{json, Value};
use std::path::PathBuf;

impl Core {
    /// `meeting_check`, `meeting_download`, `meeting_import`, `meeting_speakers`.
    pub(in crate::workspace) fn meeting_op(&self, req: &Request) -> Result<Value> {
        match req.op {
            Operation::MeetingCheck => self.queue_meeting_job(req, "transcript_check"),
            Operation::MeetingDownload => self.queue_meeting_job(req, "transcript_download"),
            Operation::MeetingImport => self.meeting_import(req),
            Operation::MeetingSpeakers => self.meeting_speakers(req),
            _ => Err(invalid("Unsupported operation.")),
        }
    }

    /// Check now (`transcript_check`) or Try again / Download again (`transcript_download`):
    /// the job already waiting or running for the meeting, else a new one keyed by the operation.
    pub(super) fn queue_meeting_job(&self, req: &Request, kind: &str) -> Result<Value> {
        let t = self.target(req)?;
        if !graph::transcripts_permitted(&t.c) {
            return Err(transcripts_off());
        }
        let state = t.meeting.as_ref().map(|m| m.state);
        let title = t
            .meeting
            .as_ref()
            .map(|m| m.title.clone())
            .or_else(|| {
                t.event
                    .as_ref()
                    .and_then(|e| e.data["title"].as_str().map(String::from))
            })
            .unwrap_or_default();
        if kind == "transcript_check" {
            let event = t.event.as_ref().ok_or_else(not_found)?;
            if !has_link(event) {
                return Err(invalid("This meeting has no Teams link to check."));
            }
            if graph::timestamp(event.data["start"].as_str().unwrap_or("")) > now() {
                return Err(invalid("This meeting hasn’t started yet."));
            }
            if state.is_some_and(|s| saved(s) || s == MeetingState::Available) {
                return Err(invalid("Connect already has this meeting’s transcript."));
            }
        } else {
            let found = t.meeting.as_ref().is_some_and(|m| {
                m.external.as_deref().is_some_and(|e| !e.is_empty()) && !m.transcript_ids.is_empty()
            });
            if !found {
                return Err(transcript_missing());
            }
        }
        let mut r = self.repo()?;
        if let Some(running) = r.jobs()?.into_iter().find(|j| {
            j.kind == kind
                && j.payload["meetingId"] == t.id.as_str()
                && matches!(j.state.as_str(), "queued" | "running")
        }) {
            return Ok(json!({"queued": true, "jobId": running.id}));
        }
        let policy = r.policy(Some(&t.w.id), Some(&t.c.id))?;
        let job = new_job(
            kind,
            format!("{kind}:{}", req.operation_id.as_deref().unwrap_or("")),
            Some(t.w.id),
            Some(t.c.id),
            now(),
            policy,
            json!({"meetingId": t.id, "title": title, "auto": false}),
        );
        r.enqueue(&job)?;
        Ok(json!({"queued": true, "jobId": job.id}))
    }

    /// `meeting_read {meetingId, part}`: `transcript` → `{segments}`, `files` →
    /// `{files: [{name, size, modified}]}`, `file` (with `name`) → `{text}`, `doc` (with
    /// `docId`, and `version` for an earlier one) → `{text}`. Read-only.
    pub(in crate::workspace) fn meeting_read(&self, req: &Request) -> Result<Value> {
        let part = req.data["part"].as_str().unwrap_or("");
        if !matches!(part, "transcript" | "files" | "file" | "doc") {
            return Err(invalid(
                "Choose the transcript, the files, one file or a document.",
            ));
        }
        let t = self.target(req)?;
        let meeting = t.meeting.ok_or_else(no_transcript)?;
        let dir = meeting
            .folder
            .clone()
            .map(PathBuf::from)
            .ok_or_else(no_transcript)?;
        if !dir.is_dir() {
            return Err(folder_missing());
        }
        match part {
            "transcript" => Ok(json!({"segments": read_segments(&dir)?})),
            "doc" => {
                let doc = required(&req.data, "docId", 200)?;
                let version = match &req.data["version"] {
                    Value::Null => None,
                    v => Some(
                        v.as_u64()
                            .and_then(|v| u32::try_from(v).ok())
                            .ok_or_else(|| invalid("Choose a version."))?,
                    ),
                };
                Ok(json!({"text": docs::read(&dir, &meeting, doc, version)?}))
            }
            "files" => {
                let mut files: Vec<Value> = std::fs::read_dir(&dir)
                    .map_err(|_| folder_missing())?
                    .flatten()
                    .filter_map(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let meta = entry.metadata().ok().filter(|m| m.is_file())?;
                        let modified = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map_or(0, |d| d.as_secs() as i64);
                        (plain_name(&name) && !name.ends_with(".tmp")).then(
                            || json!({"name": name, "size": meta.len(), "modified": modified}),
                        )
                    })
                    .collect();
                files.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
                Ok(json!({ "files": files }))
            }
            _ => {
                let name = req.data["name"].as_str().unwrap_or("");
                if !plain_name(name) {
                    return Err(invalid("Choose a file in the meeting folder."));
                }
                let path = dir.join(name);
                let meta = std::fs::metadata(&path)
                    .ok()
                    .filter(|m| m.is_file())
                    .ok_or_else(|| {
                        WorkspaceError::new("not_found", "That file isn’t in the meeting folder.")
                    })?;
                if meta.len() > READ_MAX {
                    return Err(WorkspaceError::new(
                        "too_large",
                        "This file is too large to show.",
                    ));
                }
                let bytes = std::fs::read(&path).map_err(|_| folder_missing())?;
                Ok(json!({"text": String::from_utf8_lossy(&bytes)}))
            }
        }
    }

    /// `meetings_reveal {meetingId?}`: shows the meeting's folder, or the meetings root, in
    /// Finder.
    pub(in crate::workspace) fn meetings_reveal(&self, req: &Request) -> Result<Value> {
        let path = self.reveal_target(req)?;
        let place = if names_meeting(req) {
            Place::Meeting
        } else {
            Place::Meetings
        };
        reveal(place, &path)?;
        Ok(json!({"opened": true}))
    }

    /// The folder `meetings_reveal` shows. The default root is created so there is something to
    /// show; a chosen root that is gone is `folder_unwritable` (choose it again).
    pub(in crate::workspace) fn reveal_target(&self, req: &Request) -> Result<PathBuf> {
        if names_meeting(req) {
            let t = self.target(req)?;
            return t
                .meeting
                .and_then(|m| m.folder)
                .map(PathBuf::from)
                .filter(|dir| dir.is_dir())
                .ok_or_else(folder_missing);
        }
        let s = self.repo()?.settings()?.meetings;
        let (root, is_default) = self.meetings_root(&s)?;
        if root.is_dir() || is_default && std::fs::create_dir_all(&root).is_ok() && root.is_dir() {
            Ok(root)
        } else {
            Err(folder::unwritable(&root))
        }
    }
}

pub(super) fn names_meeting(req: &Request) -> bool {
    req.data.get("meetingId").is_some_and(|v| !v.is_null())
}

/// A file name `meeting_read` may open: one plain name inside the folder.
pub(super) fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0'])
}
