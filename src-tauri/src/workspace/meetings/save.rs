//! Checking Teams for a meeting's transcripts, saving them (or an imported file) into its
//! folder, and naming its speakers afterwards.
use super::folder;
use super::folder_files::{header_lines, meeting_json, meta_json, read_segments};
use super::model::*;
use super::record::*;
use super::transcripts::{
    content_url, list_transcripts, lookup_url, pick_transcripts, state_after_check,
};
use super::vtt;
use crate::workspace::{graph, models::*, new_job, Core};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// An imported transcript is at most 5 MB.
pub(super) const IMPORT_MAX: usize = 5 * 1024 * 1024;

/// What a transcript save writes besides the record's own fields.
pub(super) struct Transcript<'a> {
    cues: &'a [vtt::Cue],
    /// The originals from Teams, oldest first (`transcript.vtt`, `transcript-2.vtt`, …).
    teams: &'a [String],
    /// An imported original: (`imported.vtt` or `imported.txt`, its text).
    imported: Option<(&'a str, &'a str)>,
}

impl Core {
    /// Writes the transcript files of `m` into its folder (the one it has, else a new one under
    /// the root) and points `m` at it. Speakers are matched to the event's people, then the
    /// meeting's own speaker mapping is applied.
    pub(super) fn write_transcript(
        &self,
        c: &Connection,
        m: &mut MeetingRecord,
        event: Option<&Record>,
        settings: &Settings,
        t: Transcript<'_>,
    ) -> Result<PathBuf> {
        let s = &settings.meetings;
        let people = with_me(people_of(event), c);
        let me = self.me_alias(c, s);
        let mut segments = vtt::segments(t.cues, &people, &me);
        if !m.speakers.is_empty() {
            vtt::map_speakers(&mut segments, &m.speakers, &people, &me);
        }
        let files = TranscriptFiles {
            vtt: if s.keep_vtt {
                t.teams.to_vec()
            } else {
                Vec::new()
            },
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
                .map_err(|_| folder::meeting_unwritable(&dir))?;
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
        // The online meeting a previous check found: no lookup again.
        let known = self
            .repo()?
            .record(KIND, &id, Some(&c.id), None)
            .ok()
            .and_then(|r| parse(&r).ok())
            .and_then(|m| m.external)
            .filter(|e| !e.is_empty());
        let (external, found) = self
            .find_transcripts(&c, &join, known.as_deref(), start, end)
            .await;
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
            let _w = self.meeting_lock();
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
                m.save_error = None;
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

    /// The online meeting behind `join` (when known or found) and this occurrence's
    /// transcripts. A `known` online meeting is listed straight away; only when Graph no longer
    /// knows it (404) is the join link looked up again. A lookup that finds no meeting is
    /// `transcript_blocked`: it belongs to an organization this account can't see.
    pub(super) async fn find_transcripts(
        &self,
        c: &Connection,
        join: &str,
        known: Option<&str>,
        start: i64,
        end: Option<i64>,
    ) -> (Option<String>, Result<Vec<TranscriptRef>>) {
        if let Some(known) = known {
            match list_transcripts(self, c, known).await {
                Ok(list) => return (Some(known.into()), Ok(pick_transcripts(&list, start, end))),
                Err(e) if e.code != "not_found" => return (Some(known.into()), Err(e)),
                Err(_) => {}
            }
        }
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
        let list = list_transcripts(self, c, &external).await;
        let refs = list.map(|list| pick_transcripts(&list, start, end));
        (Some(external), refs)
    }

    /// `transcript_download`: saves the transcript. An automatic save (the round's, or the one a
    /// check queues) keeps a transcript already in the folder (an import, an earlier save); a
    /// person's Download again replaces it ([`save_transcript`]).
    pub(in crate::workspace) async fn run_transcript_download(&self, job: &Job) -> Result<String> {
        let c = self.job_connection(job)?;
        let id = required(&job.payload, "meetingId", 2000)?;
        let how = if job.payload["auto"] == true {
            Saving::Automatic
        } else {
            Saving::Replace
        };
        match save_as(self, &c, id, how).await? {
            (_, true) => {
                // Notes the person asked for while the save failed are made now; else a meeting
                // that asked for notes as soon as its transcript arrived gets them now.
                if !self.queue_pending_notes(&c, id) {
                    self.auto_notes_after_save(&c, id);
                }
                Ok("Transcript saved".into())
            }
            (_, false) => Ok("The meeting already has a transcript; kept it".into()),
        }
    }

    /// The person stopped a save (`job_cancel`): a meeting still waiting for its transcript keeps
    /// that (`save_error` `cancelled`), so the round doesn't start it again by itself; Try again
    /// does. Takes the meeting lock; the caller holds no repository.
    pub(in crate::workspace) fn note_save_stopped(&self, job: &Job) {
        let (Some(id), Some(cid)) = (
            job.payload["meetingId"].as_str(),
            job.connection_id.as_deref(),
        ) else {
            return;
        };
        let _w = self.meeting_lock();
        let stopped = self.repo().and_then(|mut r| {
            let c = r.connection(cid)?;
            let (mut m, _, source) = self.current(&r, &c, id)?;
            if m.state != MeetingState::Available {
                return Ok(false);
            }
            m.save_error = Some(ErrorInfo {
                code: "cancelled".into(),
                message: "You stopped saving the transcript, so Connect won’t try again by itself."
                    .into(),
            });
            store(&mut r, &c, &source, &m)?;
            Ok(true)
        });
        match stopped {
            Ok(true) => self.emit("workspace:changed"),
            Ok(false) => {}
            Err(e) => log::warn!("meetings: a stopped save was not noted: {}", e.code),
        }
    }

    /// The job's account, fenced by the job's claim.
    pub(super) fn job_connection(&self, job: &Job) -> Result<Connection> {
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

    /// `meeting_import {meetingId, fileName, text}`: a Teams `.vtt`, or a `.txt` of `Name: text`
    /// lines, becomes the meeting's transcript; `imported.vtt`/`imported.txt` keep the original.
    pub(super) fn meeting_import(&self, req: &Request) -> Result<Value> {
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
        let _w = self.meeting_lock();
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
                teams: &[],
                imported: Some((&original, text)),
            },
        )?;
        m.state = after_save(&m);
        m.error = None;
        m.save_error = None;
        // The person has the transcript now; the import asks them to name the speakers before
        // they make notes, so notes waiting for a save from Teams are not made by themselves.
        m.pending_notes = None;
        store(&mut *self.repo()?, &t.c, &source, &m)?;
        Ok(json!({"saved": true}))
    }

    /// `meeting_speakers {meetingId, voice, address}`: names a voice as one of the meeting's
    /// people (an empty address takes the name back), then rewrites `segments.json` and
    /// `transcript.md`.
    pub(super) fn meeting_speakers(&self, req: &Request) -> Result<Value> {
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
        let _w = self.meeting_lock();
        let (mut m, event, source, settings) = {
            let r = self.repo()?;
            let (m, event, source) = self.current(&r, &t.c, &t.id)?;
            (m, event, source, r.settings()?)
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
        let me = self.me_alias(&t.c, &settings.meetings);
        vtt::map_speakers(&mut segments, &m.speakers, &people, &me);
        let md = vtt::transcript_md(
            &m.title,
            &header_lines(&m, event.as_ref(), &settings.time_zone),
            &segments,
        );
        let json = serde_json::to_string_pretty(&segments).map_err(storage)?;
        folder::write_file(&dir.join("segments.json"), json.as_bytes())
            .and_then(|_| folder::write_file(&dir.join("transcript.md"), md.as_bytes()))
            .map_err(|_| folder::meeting_unwritable(&dir))?;
        store(&mut *self.repo()?, &t.c, &source, &m)?;
        Ok(json!({"saved": true}))
    }
}

/// Who a save is for: an automatic one never replaces a transcript already in the folder; a
/// person's Download again (and the notes run) does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Saving {
    Automatic,
    Replace,
}

/// A transcript is in the folder already: saved before, or imported by the person.
fn kept(m: &MeetingRecord) -> bool {
    saved(m.state) || m.imported.is_some()
}

/// Saves a meeting's Teams transcript into its meeting folder: lists this occurrence's
/// transcripts again (Teams may have added or updated one), reads each one's WebVTT, joins them
/// at each one's offset from when it started, and writes the folder. Documents and tasks stay;
/// the state becomes `downloaded` (or stays `ready`). A failure is kept on the meeting
/// (`save_error`) and returned. Any job with a fenced `c` may call it: the transcript save, and
/// the notes run when a meeting is `available`. It takes [`Core::meeting_lock`] itself, so a
/// caller never holds it.
pub(crate) async fn save_transcript(
    core: &Core,
    c: &Connection,
    meeting_id: &str,
) -> Result<MeetingRecord> {
    save_as(core, c, meeting_id, Saving::Replace)
        .await
        .map(|(m, _)| m)
}

/// [`save_transcript`] for `how`: the record, and whether the save wrote it (an automatic save
/// leaves a transcript already in the folder alone).
pub(super) async fn save_as(
    core: &Core,
    c: &Connection,
    meeting_id: &str,
    how: Saving,
) -> Result<(MeetingRecord, bool)> {
    let result = fetch_and_write(core, c, meeting_id, how).await;
    if let Err(e) = &result {
        if e.code != "cancelled" {
            let _w = core.meeting_lock();
            if let Ok(mut r) = core.repo() {
                if let Ok((mut m, _, source)) = core.current(&r, c, meeting_id) {
                    m.save_error = Some(ErrorInfo::from(e));
                    if let Err(stored) = store(&mut r, c, &source, &m) {
                        log::warn!("meetings: cannot note a failed save: {}", stored.code);
                    }
                }
            }
        }
    }
    result
}

async fn fetch_and_write(
    core: &Core,
    c: &Connection,
    id: &str,
    how: Saving,
) -> Result<(MeetingRecord, bool)> {
    let m = {
        let r = core.repo()?;
        let stored = r
            .record(KIND, id, Some(&c.id), None)
            .map_err(|_| transcript_missing())?;
        parse(&stored)?
    };
    if how == Saving::Automatic && kept(&m) {
        return Ok((m, false));
    }
    let external = m
        .external
        .clone()
        .filter(|e| !e.is_empty())
        .ok_or_else(transcript_missing)?;
    let start = graph::timestamp(&m.start);
    let end = Some(graph::timestamp(&m.end)).filter(|e| *e > 0);
    let list = list_transcripts(core, c, &external)
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
    if cues.is_empty() {
        return Err(transcript_empty());
    }
    // Written from the record as it is now, so a speaker named meanwhile is kept, and an
    // import made while this save read from Teams is not replaced by an automatic save.
    let _w = core.meeting_lock();
    let (mut m, event, source, settings) = {
        let r = core.repo()?;
        r.validate_claim(c)?;
        let (m, event, source) = core.current(&r, c, id)?;
        (m, event, source, r.settings()?)
    };
    if how == Saving::Automatic && kept(&m) {
        return Ok((m, false));
    }
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
            teams: &originals,
            imported: None,
        },
    )?;
    m.state = after_save(&m);
    m.error = None;
    m.save_error = None;
    {
        let mut r = core.repo()?;
        r.validate_claim(c)?;
        store(&mut r, c, &source, &m)?;
    }
    core.emit("workspace:changed");
    core.tell_transcribed(id);
    Ok((m, true))
}
