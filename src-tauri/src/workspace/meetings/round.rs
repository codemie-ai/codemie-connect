//! The background look at meetings: which ended meetings to check, which found transcripts to
//! save (and when a failed save is tried again), which saved ones get notes by themselves, and
//! when a meeting stops waiting.
use super::model::*;
use super::notes_job::AutoNotes;
use super::record::{has_link, parse, slot, store};
use super::transcripts;
use crate::workspace::{
    graph,
    models::*,
    new_job,
    repository::{record_selected, source_permitted},
    workspace_id_active, Core,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};

/// Round jobs belong to the workspace Connect boots into.
const PERSONAL: &str = "personal";
/// Finished check and save jobs are kept this long (a slot each, so a meeting without a
/// transcript leaves up to 144 a day), then the round deletes them.
const JOBS_KEPT: i64 = 48 * 3600;

/// Checks start this long after a meeting ends.
pub(super) const CHECK_AFTER: i64 = 10 * 60;

/// The most checks, and the most saves, one round queues.
pub(super) const ROUND_LIMIT: usize = 25;

/// A save that failed with one of these is tried again by the round in its next slot, within
/// the check window: they pass by themselves, and `needs_login` passes once the person signs in
/// again (the round runs only while the account is connected). The rest (`folder_unwritable`,
/// `transcript_missing`, a save the person stopped, …) wait for the person.
pub(super) const RETRYABLE: [&str; 4] = ["throttled", "offline", "provider", "needs_login"];

/// How long after a meeting ended the round still tries a failed save of a found transcript.
pub(super) const RETRY_FOR: i64 = 24 * 3600;

/// An ended Teams meeting worth asking Teams about: not declined, cancelled or all-day, with a
/// join link, ended at least 10 minutes and less than two hours ago.
pub(super) fn checkable(event: &Record, now: i64) -> bool {
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

/// Whether the round may still try a failed save again: its last error is one that passes
/// ([`RETRYABLE`]) and the meeting ended less than [`RETRY_FOR`] ago. After
/// that only Try again / Download again run it.
pub(super) fn retry_due(m: &MeetingRecord, now: i64) -> bool {
    let Some(e) = &m.save_error else {
        return true;
    };
    let end = graph::timestamp(&m.end);
    RETRYABLE.contains(&e.code.as_str()) && end > 0 && now - end < RETRY_FOR
}

/// The background look at meetings, every 15 seconds: queues a check for every ended Teams
/// meeting still waiting for its transcript (once per slot, at most 25 a round), queues a save
/// for every transcript found but not saved (a failed one again only while [`retry_due`], and
/// not while notes for it are saving it), queues automatic notes for saved transcripts that ask
/// for them (see `notes_job::auto_due`), and gives up on meetings that waited two hours. Finished
/// check and save jobs older than two days are deleted first.
pub(crate) fn meetings_round_at(core: &Core, now: i64) -> Result<()> {
    if !workspace_id_active(PERSONAL) {
        return Ok(());
    }
    // Tasks due today: one reminder a day from 09:00. Its failure never holds up transcripts.
    if let Err(e) = crate::workspace::tasks::due_today_reminders(core, now) {
        log::warn!("tasks: the due-today reminder failed: {}", e.code);
    }
    let _w = core.meeting_lock();
    let mut r = core.repo()?;
    r.prune_finished_jobs(
        &["transcript_check", "transcript_download"],
        now - JOBS_KEPT,
    )?;
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
    let events: Vec<Record> = r
        .provider_records(&c.id, "event")?
        .into_iter()
        .filter(|e| visible(e))
        .collect();
    let mut due: Vec<(i64, Record)> = events
        .iter()
        .filter(|e| checkable(e, now))
        .filter(|e| {
            meetings.get(&e.id).is_none_or(|(_, m)| {
                matches!(m.state, MeetingState::Pending | MeetingState::Upcoming)
            })
        })
        .filter(|e| !busy("transcript_check", &e.id))
        .map(|e| {
            (
                graph::timestamp(e.data["end"].as_str().unwrap_or("")),
                e.clone(),
            )
        })
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
                && !busy("meeting_notes", id)
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
    // Notes by themselves: the meeting's own switch, a rule or the setting.
    let auto = AutoNotes::read(&r, &c, &jobs)?;
    let mut waiting: Vec<(&String, &MeetingRecord)> = meetings
        .iter()
        .filter(|(_, (_, m))| m.state == MeetingState::Downloaded)
        .map(|(id, (_, m))| (id, m))
        .collect();
    waiting.sort_by(|a, b| b.1.end.cmp(&a.1.end).then_with(|| a.0.cmp(b.0)));
    for (id, m) in waiting {
        let event = events.iter().find(|e| &e.id == id);
        auto.queue(&mut r, m, event, now)?;
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
