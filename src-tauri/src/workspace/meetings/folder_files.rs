//! What a meeting folder says besides the transcript itself: `meeting.json`, `meta.json`, the
//! `transcript.md` header, and `segments.json` read back.
use super::model::MeetingRecord;
use super::record::{folder_missing, local_time};
use super::vtt::Segment;
use crate::workspace::models::*;
use serde_json::{json, Value};
use std::path::Path;

/// `meeting_read` returns files up to this size.
pub(super) const READ_MAX: u64 = 8 * 1024 * 1024;

pub(super) fn header_lines(m: &MeetingRecord, event: Option<&Record>, zone: &str) -> Vec<String> {
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
pub(super) fn meeting_json(m: &MeetingRecord, event: Option<&Record>) -> String {
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

pub(super) fn read_segments(dir: &Path) -> Result<Vec<Segment>> {
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
