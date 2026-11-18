//! The meeting record: read with its event, stored beside it, and who its people are.
use super::model::*;
use crate::workspace::{
    graph,
    models::*,
    repository::{record_selected, source_permitted, Repository},
    Core,
};
use std::collections::HashSet;
use std::sync::MutexGuard;

/// The slot a check or save belongs to: a failed one can run again in the next slot.
pub(super) fn slot(now: i64, s: &MeetingSettings) -> i64 {
    now / (s.check_every_min.max(1) * 60)
}

pub(super) fn rfc3339(at: i64) -> String {
    chrono::DateTime::from_timestamp(at, 0)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

/// `at` (RFC 3339) as a wall-clock time in the workspace time zone.
pub(super) fn local_time(at: &str, zone: &str) -> chrono::NaiveDateTime {
    let tz: chrono_tz::Tz = zone.parse().unwrap_or(chrono_tz::UTC);
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|d| d.with_timezone(&tz).naive_local())
        .unwrap_or_else(|_| chrono::Utc::now().with_timezone(&tz).naive_local())
}

pub(super) fn not_found() -> WorkspaceError {
    WorkspaceError::new("not_found", "This meeting is no longer in your calendar.")
}

pub(super) fn no_transcript() -> WorkspaceError {
    WorkspaceError::new("not_found", "This meeting has no transcript yet.")
}

pub(super) fn folder_missing() -> WorkspaceError {
    WorkspaceError::new(
        "folder_missing",
        "The meeting folder was moved or deleted. Download the transcript again.",
    )
}

pub(super) fn transcript_missing() -> WorkspaceError {
    WorkspaceError::new(
        "transcript_missing",
        "Teams has no transcript of this meeting for Connect to save. Check again later.",
    )
}

/// A save found the transcript gone from Teams (a 404, or no longer listed). Not retried by
/// itself; Try again stays on offer.
pub(super) fn transcript_gone() -> WorkspaceError {
    WorkspaceError::new(
        "transcript_missing",
        "Teams no longer has this transcript. It may have been deleted; try again later or import a file.",
    )
}

/// Teams answered a save with a transcript that has nothing anyone said. Not retried by itself.
pub(super) fn transcript_empty() -> WorkspaceError {
    WorkspaceError::new(
        "transcript_missing",
        "Teams returned an empty transcript. Try again later, or import a file.",
    )
}
/// A read during a save that Teams answered with a 404 means the transcript is gone.
pub(super) fn gone_if_not_found(e: WorkspaceError) -> WorkspaceError {
    if e.code == "not_found" {
        transcript_gone()
    } else {
        e
    }
}

pub(super) fn transcripts_off() -> WorkspaceError {
    WorkspaceError::new(
        "permission_required",
        "Turn on Read Teams transcripts in Settings › Meetings first.",
    )
}

pub(super) fn invalid(message: &str) -> WorkspaceError {
    WorkspaceError::new("validation", message)
}

pub(super) fn storage(_: serde_json::Error) -> WorkspaceError {
    WorkspaceError::new("storage", "A meeting record could not be read or saved.")
}

pub(super) fn parse(record: &Record) -> Result<MeetingRecord> {
    serde_json::from_value(record.data.clone()).map_err(storage)
}

/// Writes the meeting record beside its event (`source` is the event's `calendar:` source).
pub(super) fn store(
    r: &mut Repository,
    c: &Connection,
    source: &str,
    m: &MeetingRecord,
) -> Result<()> {
    r.put_record(&Record {
        id: m.event_id.clone(),
        kind: KIND.into(),
        connection_id: Some(c.id.clone()),
        workspace_id: None,
        source: source.into(),
        revision: id(),
        updated_at: now(),
        data: serde_json::to_value(m).map_err(storage)?,
    })
}

/// Title and times follow the event (an organizer may rename or move it).
pub(super) fn follow_event(m: &mut MeetingRecord, event: &Record) {
    m.event_id = event.id.clone();
    for (field, key) in [
        (&mut m.title, "title"),
        (&mut m.start, "start"),
        (&mut m.end, "end"),
    ] {
        if let Some(v) = event.data[key].as_str() {
            *field = v.into();
        }
    }
}

pub(super) fn has_link(event: &Record) -> bool {
    event.data["joinUrl"]
        .as_str()
        .is_some_and(|u| !u.trim().is_empty())
}

/// A new meeting record for an event: `offline` without a Teams link, `upcoming` before its
/// end, `pending` after.
pub(super) fn from_event(event: &Record) -> MeetingRecord {
    let mut m = MeetingRecord::default();
    follow_event(&mut m, event);
    m.state = if !has_link(event) {
        MeetingState::Offline
    } else if graph::timestamp(&m.end) > now() {
        MeetingState::Upcoming
    } else {
        MeetingState::Pending
    };
    m
}

/// A transcript is saved in the folder (with or without notes).
pub(super) fn saved(state: MeetingState) -> bool {
    matches!(
        state,
        MeetingState::Downloaded | MeetingState::Ready | MeetingState::Failed
    )
}

/// The state once a transcript is in the folder: documents keep a meeting `ready` (or `failed`).
pub(super) fn after_save(m: &MeetingRecord) -> MeetingState {
    if m.docs.is_empty() {
        MeetingState::Downloaded
    } else if m.state == MeetingState::Failed {
        MeetingState::Failed
    } else {
        MeetingState::Ready
    }
}

/// The organizer and attendees of an event with an address, each once.
pub(super) fn people_of(event: Option<&Record>) -> Vec<Person> {
    let Some(event) = event else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    std::iter::once(&event.data["organizer"])
        .chain(event.data["attendees"].as_array().into_iter().flatten())
        .filter_map(|p| {
            let address = p["address"].as_str()?.trim();
            let name = p["name"].as_str().map(str::trim).filter(|n| !n.is_empty());
            (!address.is_empty() && seen.insert(address.to_lowercase())).then(|| Person {
                name: name.unwrap_or(address).into(),
                address: address.into(),
            })
        })
        .collect()
}

/// [`people_of`] with the account itself, so "me" can be named even when the event lists
/// nobody (a meeting someone forwarded).
pub(super) fn with_me(mut people: Vec<Person>, c: &Connection) -> Vec<Person> {
    let email = c.email.trim();
    if !email.is_empty() && !people.iter().any(|p| p.address.eq_ignore_ascii_case(email)) {
        people.push(Person {
            name: c.display_name.clone(),
            address: email.into(),
        });
    }
    people
}

/// What a meeting operation is about: the visible event and/or meeting record.
pub(super) struct Target {
    pub(super) w: Workspace,
    pub(super) c: Connection,
    pub(super) id: String,
    pub(super) event: Option<Record>,
    pub(super) meeting: Option<MeetingRecord>,
}

impl Core {
    /// One writer of meeting records and transcript files at a time (the round, the jobs and
    /// the operations), so a save never drops a speaker mapping made while it read from Teams.
    /// Taken before the repository and never held across an await.
    pub(super) fn meeting_lock(&self) -> MutexGuard<'_, ()> {
        self.meeting_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn target(&self, req: &Request) -> Result<Target> {
        let (w, c) = self.active_workspace(req, true)?;
        let c = c.ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?;
        let id = required(&req.data, "meetingId", 2000)?.to_string();
        let r = self.repo()?;
        let visible = |rec: &Record| record_selected(rec, &w) && source_permitted(rec, &c);
        let event = r
            .record("event", &id, Some(&c.id), None)
            .ok()
            .filter(visible);
        let stored = r.record(KIND, &id, Some(&c.id), None).ok().filter(visible);
        if event.is_none() && stored.is_none() {
            return Err(not_found());
        }
        let meeting = stored.as_ref().map(parse).transpose()?;
        drop(r);
        Ok(Target {
            w,
            c,
            id,
            event,
            meeting,
        })
    }

    /// The meeting record as stored now (or a new one from its event), its event and source.
    /// Callers hold [`Core::meeting_lock`].
    pub(super) fn current(
        &self,
        r: &Repository,
        c: &Connection,
        id: &str,
    ) -> Result<(MeetingRecord, Option<Record>, String)> {
        let event = r.record("event", id, Some(&c.id), None).ok();
        let stored = r.record(KIND, id, Some(&c.id), None).ok();
        let source = stored
            .as_ref()
            .or(event.as_ref())
            .map(|r| r.source.clone())
            .ok_or_else(not_found)?;
        let mut m = match &stored {
            Some(record) => parse(record)?,
            None => from_event(event.as_ref().ok_or_else(not_found)?),
        };
        if let Some(event) = &event {
            follow_event(&mut m, event);
        }
        Ok((m, event, source))
    }
}
