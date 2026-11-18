//! Meetings: Teams transcripts found, saved into meeting folders and read back (spec
//! "Transcript states", "Folder and files"). The background round checks ended Teams meetings and
//! saves every transcript it finds; people check now, save again, import a file and name speakers
//! through `meeting_*` operations.
//!
//! A meeting record (kind [`model::KIND`]) is account-bound like its event: same id, the event's
//! `calendar:` source, no workspace. So the snapshot shows it only with calendar reads on, and
//! signing out removes it; its folder is the person's and stays.
pub(crate) mod folder;
pub mod model;
#[cfg(test)]
mod tests;
pub(crate) mod transcripts;
pub(crate) mod vtt;

use self::model::*;
use self::transcripts::{content_url, list_url, lookup_url, pick_transcripts, state_after_check};
use self::vtt::Segment;
use crate::storage::commands::{reveal, Place};
use crate::workspace::{
    graph,
    models::*,
    new_job, paths,
    repository::{record_selected, source_permitted, Repository},
    workspace_id_active, Core,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// Round jobs belong to the workspace Connect boots into.
const PERSONAL: &str = "personal";
/// Checks start this long after a meeting ends.
const CHECK_AFTER: i64 = 10 * 60;
/// The most checks, and the most saves, one round queues.
const ROUND_LIMIT: usize = 25;
/// An imported transcript is at most 5 MB.
const IMPORT_MAX: usize = 5 * 1024 * 1024;
/// `meeting_read` returns files up to this size.
const READ_MAX: u64 = 8 * 1024 * 1024;
/// A save that failed with one of these is tried again by the round in its next slot, within
/// the check window; the rest (`folder_unwritable`, `needs_login`, `transcript_missing`, …) wait
/// for the person.
const RETRYABLE: [&str; 3] = ["throttled", "offline", "provider"];

/// One writer of meeting records and transcript files at a time (the round, the jobs and the
/// operations), so a save never drops a speaker mapping made while it read from Teams. Taken
/// before the repository and never held across an await.
static WRITES: Mutex<()> = Mutex::new(());

fn writes() -> MutexGuard<'static, ()> {
    WRITES.lock().unwrap_or_else(|e| e.into_inner())
}

/// The slot a check or save belongs to: a failed one can run again in the next slot.
fn slot(now: i64, s: &MeetingSettings) -> i64 {
    now / (s.check_every_min.max(1) * 60)
}

fn rfc3339(at: i64) -> String {
    chrono::DateTime::from_timestamp(at, 0)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

/// `at` (RFC 3339) as a wall-clock time in the workspace time zone.
fn local_time(at: &str, zone: &str) -> chrono::NaiveDateTime {
    let tz: chrono_tz::Tz = zone.parse().unwrap_or(chrono_tz::UTC);
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|d| d.with_timezone(&tz).naive_local())
        .unwrap_or_else(|_| chrono::Utc::now().with_timezone(&tz).naive_local())
}

fn not_found() -> WorkspaceError {
    WorkspaceError::new("not_found", "This meeting is no longer in your calendar.")
}
fn no_transcript() -> WorkspaceError {
    WorkspaceError::new("not_found", "This meeting has no transcript yet.")
}
fn folder_missing() -> WorkspaceError {
    WorkspaceError::new(
        "folder_missing",
        "The meeting folder was moved or deleted. Download the transcript again.",
    )
}
fn transcript_missing() -> WorkspaceError {
    WorkspaceError::new(
        "transcript_missing",
        "Teams has no transcript of this meeting for Connect to save. Check again later.",
    )
}
/// A save found the transcript gone from Teams (a 404, or no longer listed). Not retried by
/// itself; Try again stays on offer.
fn transcript_gone() -> WorkspaceError {
    WorkspaceError::new(
        "transcript_missing",
        "Teams no longer has this transcript. It may have been deleted; try again later or import a file.",
    )
}
/// A read during a save that Teams answered with a 404 means the transcript is gone.
fn gone_if_not_found(e: WorkspaceError) -> WorkspaceError {
    if e.code == "not_found" {
        transcript_gone()
    } else {
        e
    }
}
fn transcripts_off() -> WorkspaceError {
    WorkspaceError::new(
        "permission_required",
        "Turn on Read Teams transcripts in Settings › Meetings first.",
    )
}
fn invalid(message: &str) -> WorkspaceError {
    WorkspaceError::new("validation", message)
}
fn storage(_: serde_json::Error) -> WorkspaceError {
    WorkspaceError::new("storage", "A meeting record could not be read or saved.")
}

fn parse(record: &Record) -> Result<MeetingRecord> {
    serde_json::from_value(record.data.clone()).map_err(storage)
}

/// Writes the meeting record beside its event (`source` is the event's `calendar:` source).
fn store(r: &mut Repository, c: &Connection, source: &str, m: &MeetingRecord) -> Result<()> {
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
fn follow_event(m: &mut MeetingRecord, event: &Record) {
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

fn has_link(event: &Record) -> bool {
    event.data["joinUrl"]
        .as_str()
        .is_some_and(|u| !u.trim().is_empty())
}

/// A new meeting record for an event: `offline` without a Teams link, `upcoming` before its
/// end, `pending` after.
fn from_event(event: &Record) -> MeetingRecord {
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
fn saved(state: MeetingState) -> bool {
    matches!(
        state,
        MeetingState::Downloaded | MeetingState::Ready | MeetingState::Failed
    )
}

/// The state once a transcript is in the folder: documents keep a meeting `ready` (or `failed`).
fn after_save(m: &MeetingRecord) -> MeetingState {
    if m.docs.is_empty() {
        MeetingState::Downloaded
    } else if m.state == MeetingState::Failed {
        MeetingState::Failed
    } else {
        MeetingState::Ready
    }
}

/// An ended Teams meeting worth asking Teams about: not declined, cancelled or all-day, with a
/// join link, ended at least 10 minutes and less than a day ago.
fn checkable(event: &Record, now: i64) -> bool {
    let d = &event.data;
    let declined = d["response"]
        .as_str()
        .is_some_and(|r| r.eq_ignore_ascii_case("declined"));
    let end = graph::timestamp(d["end"].as_str().unwrap_or(""));
    has_link(event)
        && d["allDay"] != true
        && d["cancelled"] != true
        && !declined
        && end > 0
        && end + CHECK_AFTER <= now
        && now - end < transcripts::STOP_AFTER
}

/// The organizer and attendees of an event with an address, each once.
fn people_of(event: Option<&Record>) -> Vec<Person> {
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
fn with_me(mut people: Vec<Person>, c: &Connection) -> Vec<Person> {
    let email = c.email.trim();
    if !email.is_empty() && !people.iter().any(|p| p.address.eq_ignore_ascii_case(email)) {
        people.push(Person {
            name: c.display_name.clone(),
            address: email.into(),
        });
    }
    people
}

fn header_lines(m: &MeetingRecord, event: Option<&Record>, zone: &str) -> Vec<String> {
    let mut lines = vec![format!(
        "Date: {}",
        local_time(&m.start, zone).format("%Y-%m-%d %H:%M")
    )];
    if let Some(event) = event {
        if let Some(name) = event.data["organizer"]["name"]
            .as_str()
            .filter(|n| !n.trim().is_empty())
        {
            lines.push(format!("Organizer: {name}"));
        }
        let names: Vec<&str> = event.data["attendees"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a["name"].as_str().filter(|n| !n.trim().is_empty()))
            .collect();
        if !names.is_empty() {
            lines.push(format!("Attendees: {}", names.join(", ")));
        }
    }
    lines.push(match &m.imported {
        Some(file) => format!("Source: imported from {file}"),
        None => "Source: Microsoft Teams".into(),
    });
    lines
}

/// `meeting.json` (Echo's names): what the meeting was, and the event it belongs to, so saving
/// again finds the folder.
fn meeting_json(m: &MeetingRecord, event: Option<&Record>) -> String {
    let field = |key: &str| event.map(|e| e.data[key].clone()).unwrap_or(Value::Null);
    let organizer = event
        .map(|e| &e.data["organizer"])
        .filter(|o| o.is_object())
        .map(|o| json!({"name": o["name"], "address": o["address"]}))
        .unwrap_or(Value::Null);
    let attendees = event
        .and_then(|e| e.data["attendees"].as_array().cloned())
        .unwrap_or_default();
    let source = if m.imported.is_some() {
        "import"
    } else {
        "teams"
    };
    let v = json!({"event_id": m.event_id, "subject": m.title, "start": m.start, "end": m.end,
        "organizer": organizer, "attendees": attendees, "join_url": field("joinUrl"),
        "series_id": field("seriesId"), "online_meeting_id": m.external, "source": source});
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

/// `meta.json`: where the transcript came from and which documents were made from it.
pub(crate) fn meta_json(m: &MeetingRecord) -> String {
    let source = if m.imported.is_some() {
        "import"
    } else {
        "teams"
    };
    let versions: serde_json::Map<String, Value> = m
        .docs
        .iter()
        .map(|d| (d.template.clone(), json!(d.version)))
        .collect();
    let v = json!({"source": source,
        "started_at": m.transcript_start.clone().unwrap_or_else(|| m.start.clone()),
        "ended_at": m.end, "transcript_ids": m.transcript_ids, "imported_from": m.imported,
        "templates": m.docs.iter().map(|d| d.template.clone()).collect::<Vec<_>>(),
        "ai_profile": Value::Null, "versions": versions});
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

/// A file name `meeting_read` may open: one plain name inside the folder.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0'])
}

fn read_segments(dir: &Path) -> Result<Vec<Segment>> {
    let path = dir.join("segments.json");
    let len = std::fs::metadata(&path)
        .map_err(|_| folder_missing())?
        .len();
    if len > READ_MAX {
        return Err(WorkspaceError::new(
            "too_large",
            "This transcript is too large to show.",
        ));
    }
    let bytes = std::fs::read(&path).map_err(|_| folder_missing())?;
    serde_json::from_slice(&bytes).map_err(|_| {
        WorkspaceError::new(
            "folder_missing",
            "The meeting’s segments.json can’t be read. Download the transcript again.",
        )
    })
}

/// What a meeting operation is about: the visible event and/or meeting record.
struct Target {
    w: Workspace,
    c: Connection,
    id: String,
    event: Option<Record>,
    meeting: Option<MeetingRecord>,
}

/// What a transcript save writes besides the record's own fields.
struct Transcript<'a> {
    cues: &'a [vtt::Cue],
    /// The original from Teams (`transcript.vtt`).
    teams: Option<&'a str>,
    /// An imported original: (`imported.vtt` or `imported.txt`, its text).
    imported: Option<(&'a str, &'a str)>,
}

impl Core {
    /// Who "me" is in transcripts. Task 3 reads the glossary's `## Me` section here; until then
    /// it is the account's display name with no aliases.
    pub(crate) fn me_alias(&self, c: &Connection) -> MeAlias {
        MeAlias {
            name: c.display_name.clone(),
            aliases: Vec::new(),
        }
    }

    /// The meetings root and whether it is the default one (which may be created).
    pub(crate) fn meetings_root(&self, s: &MeetingSettings) -> Result<(PathBuf, bool)> {
        match s.root.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
            Some(root) => Ok((PathBuf::from(root), false)),
            None => self
                .home
                .as_deref()
                .map(|home| (paths::default_meetings_root(home), true))
                .ok_or_else(|| {
                    WorkspaceError::new(
                        "folder_unwritable",
                        "Connect can’t find your home folder. Choose the folder again in Settings › Meetings.",
                    )
                }),
        }
    }

    fn target(&self, req: &Request) -> Result<Target> {
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
    /// Callers hold [`WRITES`].
    fn current(
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

    /// Writes the transcript files of `m` into its folder (the one it has, else a new one under
    /// the root) and points `m` at it. Speakers are matched to the event's people, then the
    /// meeting's own speaker mapping is applied.
    fn write_transcript(
        &self,
        c: &Connection,
        m: &mut MeetingRecord,
        event: Option<&Record>,
        settings: &Settings,
        t: Transcript<'_>,
    ) -> Result<PathBuf> {
        let s = &settings.meetings;
        let people = with_me(people_of(event), c);
        let me = self.me_alias(c);
        let mut segments = vtt::segments(t.cues, &people, &me);
        if !m.speakers.is_empty() {
            vtt::map_speakers(&mut segments, &m.speakers, &people, &me);
        }
        let files = TranscriptFiles {
            vtt: t.teams.filter(|_| s.keep_vtt).map(String::from),
            md: vtt::transcript_md(
                &m.title,
                &header_lines(m, event, &settings.time_zone),
                &segments,
            ),
            segments: serde_json::to_string_pretty(&segments).map_err(storage)?,
            meeting: meeting_json(m, event),
            meta: meta_json(m),
        };
        let own = m
            .folder
            .as_deref()
            .map(PathBuf::from)
            .filter(|dir| dir.is_dir());
        let dir = match own {
            // Saving again rewrites the meeting's own folder, wherever the root is now.
            Some(dir) => {
                folder::rewrite_folder(&dir, &files)?;
                dir
            }
            None => {
                let (root, is_default) = self.meetings_root(s)?;
                let at = m
                    .transcript_start
                    .clone()
                    .unwrap_or_else(|| m.start.clone());
                let name = folder::folder_name(
                    local_time(&at, &settings.time_zone),
                    &m.title,
                    &s.folder_pattern,
                );
                folder::write_transcript_folder(&root, is_default, &name, &m.event_id, &files)?
            }
        };
        if let Some((file, text)) = t.imported.filter(|_| s.keep_vtt) {
            folder::write_file(&dir.join(file), text.as_bytes())
                .map_err(|_| folder::unwritable(&dir))?;
        }
        m.folder = Some(dir.to_string_lossy().into_owned());
        Ok(dir)
    }

    /// `transcript_check`: finds the meeting in Teams by its join link and lists this
    /// occurrence's transcripts. Found: `available`, and its save is queued at once.
    pub(in crate::workspace) async fn run_transcript_check(&self, job: &Job) -> Result<String> {
        let c = self.job_connection(job)?;
        let id = required(&job.payload, "meetingId", 2000)?.to_string();
        let event = self
            .repo()?
            .record("event", &id, Some(&c.id), None)
            .map_err(|_| not_found())?;
        let join = event.data["joinUrl"]
            .as_str()
            .filter(|u| !u.trim().is_empty())
            .ok_or_else(|| invalid("This meeting has no Teams link."))?
            .to_string();
        let start = graph::timestamp(event.data["start"].as_str().unwrap_or(""));
        let end =
            Some(graph::timestamp(event.data["end"].as_str().unwrap_or(""))).filter(|e| *e > 0);
        let (external, found) = self.find_transcripts(&c, &join, start, end).await;
        if let Err(e) = &found {
            // The job's own fence, or the account signing out, is not about this meeting.
            let account_gone = e.code == "needs_login"
                && self
                    .repo()?
                    .connection(&c.id)
                    .map_or(true, |now| now.status != "connected");
            if e.code == "cancelled" || account_gone {
                return Err(e.clone());
            }
        }
        let refs = found.as_ref().cloned().unwrap_or_default();
        let (state, error) = state_after_check(found, end.unwrap_or(start), now());
        {
            let _w = writes();
            let mut r = self.repo()?;
            r.check_claim(&job.id, job.attempts)?;
            r.check_policy(
                job.workspace_id.as_deref(),
                job.connection_id.as_deref(),
                &job.policy,
            )?;
            let (mut m, _, source) = self.current(&r, &c, &id)?;
            if saved(m.state) || m.state == MeetingState::Available {
                // Found or saved meanwhile, by an import or another check.
                return Ok("The transcript was already found".into());
            }
            m.state = state;
            m.error = error.clone();
            m.checked_at = Some(now());
            if let Some(external) = external {
                m.external = Some(external);
            }
            if state == MeetingState::Available {
                m.transcript_ids = refs.iter().map(|t| t.id.clone()).collect();
                m.transcript_start = refs.first().map(|t| rfc3339(t.created));
                m.last_error = None;
            }
            store(&mut r, &c, &source, &m)?;
            if state == MeetingState::Available {
                let s = r.settings()?.meetings;
                let slot = job.payload["slot"]
                    .as_i64()
                    .unwrap_or_else(|| slot(now(), &s));
                r.enqueue(&new_job(
                    "transcript_download",
                    format!("transcript_download:auto:{id}:{slot}"),
                    job.workspace_id.clone(),
                    job.connection_id.clone(),
                    now(),
                    job.policy.clone(),
                    json!({"meetingId": id, "title": m.title, "auto": true}),
                ))?;
            }
        }
        self.emit("workspace:changed");
        match (state, error) {
            (MeetingState::Available, _) => Ok("Transcript found; saving it".into()),
            (MeetingState::Blocked, _) => Ok("Teams didn’t allow reading the transcript".into()),
            (_, Some(error)) => Err(WorkspaceError::new(&error.code, error.message)),
            (MeetingState::None, None) => Ok("Teams has no transcript of this meeting".into()),
            _ => Ok("No transcript yet; Connect will check again".into()),
        }
    }

    /// The online meeting behind `join` (when the lookup found it) and this occurrence's
    /// transcripts. A lookup that finds no meeting is `transcript_blocked`: it belongs to an
    /// organization this account can't see.
    async fn find_transcripts(
        &self,
        c: &Connection,
        join: &str,
        start: i64,
        end: Option<i64>,
    ) -> (Option<String>, Result<Vec<TranscriptRef>>) {
        let lookup = match self.graph_reads.get(self, c, &lookup_url(join)).await {
            Ok(lookup) => lookup,
            Err(e) => return (None, Err(e)),
        };
        let Some(external) = lookup["value"][0]["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(String::from)
        else {
            return (
                None,
                Err(WorkspaceError::new(
                    "transcript_blocked",
                    "Teams didn’t return this meeting for your account. It may belong to another organization: ask the organizer for the transcript.",
                )),
            );
        };
        let list = self.graph_reads.get(self, c, &list_url(&external)).await;
        let refs = list.map(|list| pick_transcripts(&list, start, end));
        (Some(external), refs)
    }

    /// `transcript_download`: saves the transcript ([`save_transcript`]).
    pub(in crate::workspace) async fn run_transcript_download(&self, job: &Job) -> Result<String> {
        let c = self.job_connection(job)?;
        let id = required(&job.payload, "meetingId", 2000)?;
        save_transcript(self, &c, id).await?;
        Ok("Transcript saved".into())
    }

    /// The job's account, fenced by the job's claim.
    fn job_connection(&self, job: &Job) -> Result<Connection> {
        let cid = job
            .connection_id
            .as_deref()
            .ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?;
        let mut c = self.repo()?.connection(cid)?;
        if !graph::transcripts_permitted(&c) {
            return Err(transcripts_off());
        }
        c.job_fence = Some((job.id.clone(), job.attempts));
        Ok(c)
    }

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
    fn queue_meeting_job(&self, req: &Request, kind: &str) -> Result<Value> {
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

    /// `meeting_import {meetingId, fileName, text}`: a Teams `.vtt`, or a `.txt` of `Name: text`
    /// lines, becomes the meeting's transcript; `imported.vtt`/`imported.txt` keep the original.
    fn meeting_import(&self, req: &Request) -> Result<Value> {
        let t = self.target(req)?;
        // Only the file's own name is kept: a picker may send a whole path.
        let file_name = required(&req.data, "fileName", 1024)?
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_string();
        if file_name.is_empty() || file_name.chars().count() > 255 {
            return Err(invalid("Choose a transcript file."));
        }
        let ext = Path::new(&file_name)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "vtt" | "txt") {
            return Err(invalid("Import a Teams .vtt or a .txt transcript."));
        }
        let text = req.data["text"]
            .as_str()
            .ok_or_else(|| invalid("The file has no text."))?;
        if text.len() > IMPORT_MAX {
            return Err(WorkspaceError::new(
                "too_large",
                "This file is larger than 5 MB. Import a smaller transcript.",
            ));
        }
        let cues = if ext == "vtt" {
            vtt::parse_vtt(text)
        } else {
            vtt::parse_txt(text)
        };
        if cues.is_empty() {
            return Err(invalid(
                "Connect found no one speaking in this file. Use a Teams .vtt, or lines like “Name: what they said”.",
            ));
        }
        let original = format!("imported.{ext}");
        let _w = writes();
        let (mut m, event, source, settings) = {
            let r = self.repo()?;
            let (m, event, source) = self.current(&r, &t.c, &t.id)?;
            (m, event, source, r.settings()?)
        };
        m.imported = Some(file_name);
        m.transcript_start = None;
        self.write_transcript(
            &t.c,
            &mut m,
            event.as_ref(),
            &settings,
            Transcript {
                cues: &cues,
                teams: None,
                imported: Some((&original, text)),
            },
        )?;
        m.state = after_save(&m);
        m.error = None;
        m.last_error = None;
        store(&mut *self.repo()?, &t.c, &source, &m)?;
        Ok(json!({"saved": true}))
    }

    /// `meeting_speakers {meetingId, voice, address}`: names a voice as one of the meeting's
    /// people (an empty address takes the name back), then rewrites `segments.json` and
    /// `transcript.md`.
    fn meeting_speakers(&self, req: &Request) -> Result<Value> {
        let t = self.target(req)?;
        let voice = req.data["voice"]
            .as_str()
            .filter(|v| v.len() <= 200)
            .ok_or_else(|| invalid("Choose a speaker."))?
            .to_string();
        let address = req.data["address"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();
        let _w = writes();
        let (mut m, event, source, zone) = {
            let r = self.repo()?;
            let (m, event, source) = self.current(&r, &t.c, &t.id)?;
            (m, event, source, r.settings()?.time_zone)
        };
        let dir = m
            .folder
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(no_transcript)?;
        if !dir.is_dir() {
            return Err(folder_missing());
        }
        let mut segments = read_segments(&dir)?;
        if !segments.iter().any(|s| s.voice == voice) {
            return Err(invalid("That speaker isn’t in this transcript."));
        }
        let people = with_me(people_of(event.as_ref()), &t.c);
        if address.is_empty() {
            m.speakers.remove(&voice);
        } else {
            let person = people
                .iter()
                .find(|p| p.address.eq_ignore_ascii_case(&address))
                .ok_or_else(|| invalid("Choose someone who was at the meeting."))?;
            m.speakers.insert(voice, person.address.clone());
        }
        vtt::map_speakers(&mut segments, &m.speakers, &people, &self.me_alias(&t.c));
        let md = vtt::transcript_md(
            &m.title,
            &header_lines(&m, event.as_ref(), &zone),
            &segments,
        );
        let json = serde_json::to_string_pretty(&segments).map_err(storage)?;
        folder::write_file(&dir.join("segments.json"), json.as_bytes())
            .and_then(|_| folder::write_file(&dir.join("transcript.md"), md.as_bytes()))
            .map_err(|_| folder::unwritable(&dir))?;
        store(&mut *self.repo()?, &t.c, &source, &m)?;
        Ok(json!({"saved": true}))
    }

    /// `meeting_read {meetingId, part}`: `transcript` → `{segments}`, `files` →
    /// `{files: [{name, size, modified}]}`, `file` (with `name`) → `{text}`. Read-only.
    pub(in crate::workspace) fn meeting_read(&self, req: &Request) -> Result<Value> {
        let part = req.data["part"].as_str().unwrap_or("");
        if !matches!(part, "transcript" | "files" | "file") {
            return Err(invalid("Choose the transcript, the files or one file."));
        }
        let t = self.target(req)?;
        let dir = t
            .meeting
            .and_then(|m| m.folder)
            .map(PathBuf::from)
            .ok_or_else(no_transcript)?;
        if !dir.is_dir() {
            return Err(folder_missing());
        }
        match part {
            "transcript" => Ok(json!({"segments": read_segments(&dir)?})),
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

fn names_meeting(req: &Request) -> bool {
    req.data.get("meetingId").is_some_and(|v| !v.is_null())
}

/// Saves a meeting's Teams transcript into its meeting folder: lists this occurrence's
/// transcripts again (Teams may have added or updated one), reads each one's WebVTT, joins them
/// at each one's offset from when it started, and writes the folder. Documents and tasks stay;
/// the state becomes `downloaded` (or stays `ready`). A failure is kept on the meeting
/// (`last_error`) and returned. Any job with a fenced `c` may call it: the transcript save, and
/// the notes run when a meeting is `available`.
pub(crate) async fn save_transcript(
    core: &Core,
    c: &Connection,
    meeting_id: &str,
) -> Result<MeetingRecord> {
    let result = fetch_and_write(core, c, meeting_id).await;
    if let Err(e) = &result {
        if e.code != "cancelled" {
            let _w = writes();
            if let Ok(mut r) = core.repo() {
                if let Ok((mut m, _, source)) = core.current(&r, c, meeting_id) {
                    m.last_error = Some(ErrorInfo::from(e));
                    if let Err(stored) = store(&mut r, c, &source, &m) {
                        log::warn!("meetings: cannot note a failed save: {}", stored.code);
                    }
                }
            }
        }
    }
    result
}

async fn fetch_and_write(core: &Core, c: &Connection, id: &str) -> Result<MeetingRecord> {
    let m = {
        let r = core.repo()?;
        let stored = r
            .record(KIND, id, Some(&c.id), None)
            .map_err(|_| transcript_missing())?;
        parse(&stored)?
    };
    let external = m
        .external
        .clone()
        .filter(|e| !e.is_empty())
        .ok_or_else(transcript_missing)?;
    let start = graph::timestamp(&m.start);
    let end = Some(graph::timestamp(&m.end)).filter(|e| *e > 0);
    let list = core
        .graph_reads
        .get(core, c, &list_url(&external))
        .await
        .map_err(gone_if_not_found)?;
    let refs = pick_transcripts(&list, start, end);
    let first = refs.first().ok_or_else(transcript_gone)?.created;
    let mut cues = Vec::new();
    let mut originals = Vec::new();
    for t in &refs {
        let text = core
            .graph_reads
            .get_text(core, c, &content_url(&external, &t.id))
            .await
            .map_err(gone_if_not_found)?;
        let offset = (t.created - first) as f64;
        cues.extend(vtt::parse_vtt(&text).into_iter().map(|mut cue| {
            cue.start += offset;
            cue.end += offset;
            cue
        }));
        originals.push(text);
    }
    let original = originals.join("\n\n");
    // Written from the record as it is now, so a speaker named meanwhile is kept.
    let _w = writes();
    let (mut m, event, source, settings) = {
        let r = core.repo()?;
        r.validate_claim(c)?;
        let (m, event, source) = core.current(&r, c, id)?;
        (m, event, source, r.settings()?)
    };
    m.transcript_ids = refs.iter().map(|t| t.id.clone()).collect();
    m.transcript_start = Some(rfc3339(first));
    m.imported = None;
    core.write_transcript(
        c,
        &mut m,
        event.as_ref(),
        &settings,
        Transcript {
            cues: &cues,
            teams: Some(&original),
            imported: None,
        },
    )?;
    m.state = after_save(&m);
    m.error = None;
    m.last_error = None;
    {
        let mut r = core.repo()?;
        r.validate_claim(c)?;
        store(&mut r, c, &source, &m)?;
    }
    core.emit("workspace:changed");
    Ok(m)
}

/// Whether the round may still try a failed save again: its last error is one that passes
/// (`throttled`, `offline`, `provider`) and the meeting is within the check window (a day
/// after it ended). After that only Try again / Download again run it.
fn retry_due(m: &MeetingRecord, now: i64) -> bool {
    let Some(e) = &m.last_error else {
        return true;
    };
    let end = graph::timestamp(&m.end);
    RETRYABLE.contains(&e.code.as_str()) && end > 0 && now - end < transcripts::STOP_AFTER
}

/// The background look at meetings, every 15 seconds: queues a check for every ended Teams
/// meeting still waiting for its transcript (once per slot, at most 25 a round), queues a save
/// for every transcript found but not saved (a failed one again only while [`retry_due`]), and
/// gives up on meetings that waited a day.
pub(crate) fn meetings_round_at(core: &Core, now: i64) -> Result<()> {
    if !workspace_id_active(PERSONAL) {
        return Ok(());
    }
    let _w = writes();
    let mut r = core.repo()?;
    let Some(c) = r
        .settings()?
        .active_connection
        .and_then(|id| r.connection(&id).ok())
        .filter(|c| c.status == "connected")
    else {
        return Ok(());
    };
    if !graph::transcripts_permitted(&c) || !graph::permitted(&c, "calendar") {
        return Ok(());
    }
    let w = r.workspace(PERSONAL)?;
    if w.archived || w.connection_id.as_deref() != Some(&c.id) {
        return Ok(());
    }
    let settings = r.settings()?.meetings;
    let slot = slot(now, &settings);
    let policy = r.policy(Some(PERSONAL), Some(&c.id))?;
    let jobs = r.jobs()?;
    let keys: HashSet<&str> = jobs.iter().map(|j| j.key.as_str()).collect();
    let busy = |kind: &str, id: &str| {
        jobs.iter().any(|j| {
            j.kind == kind
                && j.payload["meetingId"] == id
                && matches!(j.state.as_str(), "queued" | "running")
        })
    };
    let visible = |rec: &Record| record_selected(rec, &w) && source_permitted(rec, &c);
    let meetings: HashMap<String, (String, MeetingRecord)> = r
        .provider_records(&c.id, KIND)?
        .into_iter()
        .filter(|rec| visible(rec))
        .filter_map(|rec| Some((rec.id.clone(), (rec.source.clone(), parse(&rec).ok()?))))
        .collect();
    let mut due: Vec<(i64, Record)> = r
        .provider_records(&c.id, "event")?
        .into_iter()
        .filter(|e| visible(e) && checkable(e, now))
        .filter(|e| {
            meetings.get(&e.id).is_none_or(|(_, m)| {
                matches!(m.state, MeetingState::Pending | MeetingState::Upcoming)
            })
        })
        .filter(|e| !busy("transcript_check", &e.id))
        .map(|e| (graph::timestamp(e.data["end"].as_str().unwrap_or("")), e))
        .collect();
    // The most recent meetings first: theirs are the transcripts people wait for.
    due.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    let mut queued = 0;
    for (_, e) in due {
        if queued >= ROUND_LIMIT {
            break;
        }
        let key = format!("transcript_check:{}:{slot}", e.id);
        if keys.contains(key.as_str()) {
            continue;
        }
        r.enqueue(&new_job(
            "transcript_check",
            key,
            Some(PERSONAL.into()),
            Some(c.id.clone()),
            now,
            policy.clone(),
            json!({"meetingId": e.id, "title": e.data["title"], "slot": slot}),
        ))?;
        queued += 1;
    }
    let mut found: Vec<(&String, &MeetingRecord)> = meetings
        .iter()
        .filter(|(id, (_, m))| {
            m.state == MeetingState::Available
                && retry_due(m, now)
                && !busy("transcript_download", id)
        })
        .map(|(id, (_, m))| (id, m))
        .collect();
    found.sort_by(|a, b| b.1.end.cmp(&a.1.end).then_with(|| a.0.cmp(b.0)));
    let mut saves = 0;
    for (id, m) in found {
        if saves >= ROUND_LIMIT {
            break;
        }
        let key = format!("transcript_download:auto:{id}:{slot}");
        if keys.contains(key.as_str()) {
            continue;
        }
        r.enqueue(&new_job(
            "transcript_download",
            key,
            Some(PERSONAL.into()),
            Some(c.id.clone()),
            now,
            policy.clone(),
            json!({"meetingId": id, "title": m.title, "auto": true}),
        ))?;
        saves += 1;
    }
    for (id, (source, m)) in &meetings {
        let end = graph::timestamp(&m.end);
        if m.state == MeetingState::Pending
            && end > 0
            && now - end >= transcripts::STOP_AFTER
            && !busy("transcript_check", id)
        {
            let mut m = m.clone();
            m.state = MeetingState::None;
            store(&mut r, &c, source, &m)?;
        }
    }
    Ok(())
}
