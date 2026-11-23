//! Tasks (spec "Tasks page", "Tasks from notes"): what people agreed to do in their meetings and
//! what the person adds by hand, on the Tasks board.
//!
//! A task is a local record of kind [`KIND`] (`commitment`, the kind older commitments and Today's
//! card already use) in its workspace. Its body: `{text, owner, ownerName, due, done, status, notes,
//! meetingId, line, quote, quoteAt, speaker, confidence, order, history, sourceId, sourceRevision}`
//! plus `doneAt` and `createdAt`. `owner` is the person's e-mail when known, otherwise free text
//! (older commitments say `"You"`); `ownerName` is the name to show. `done` always equals
//! `status == "done"`; a body without a status reads as `done ? "done" : "todo"`.
//!
//! [`task_save`] merges a change into the stored body and writes one history line for each move,
//! owner and due date change. A task from a meeting is also written to the meeting folder's
//! `tasks.json` (Echo's `actions.json` shape), so other tools see the same list. Callers hold
//! [`Core::meeting_lock`] (the meeting-folder writer lock), taken before the repository.
use super::meetings::{folder, model::MeAlias};
use super::models::*;
use super::repository::Repository;
use super::task_provider::{active_provider, keys, outbox, sync, wire};
use super::{new_job, workspace_id_active, Core};
use chrono::{Datelike, Timelike};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The record kind of a task.
pub(crate) const KIND: &str = "commitment";
/// Every status a task can have; the first five are the board's columns.
pub(crate) const STATUSES: [&str; 6] = ["review", "todo", "doing", "waiting", "done", "dismissed"];
/// The built-in column names (Settings › Meetings › Tasks can rename them).
const NAMES: [(&str, &str); 6] = [
    ("review", "To review"),
    ("todo", "To do"),
    ("doing", "In progress"),
    ("waiting", "Waiting"),
    ("done", "Done"),
    ("dismissed", "Dismissed"),
];
/// Statuses of a task someone still has to do.
const OPEN: [&str; 3] = ["todo", "doing", "waiting"];
/// Every kind a task can be (design §1): Naya's `TASK_SCHEMA` kinds minus `client`. Absent reads
/// as `"task"`.
const KINDS: [&str; 4] = ["task", "reply", "waiting", "budget"];

const ID_MAX: usize = 200;
const TEXT_MAX: usize = 2000;
const NOTES_MAX: usize = 20_000;
const QUOTE_MAX: usize = 20_000;
const OWNER_MAX: usize = 320;
const NAME_MAX: usize = 200;
const REF_MAX: usize = 2000;
const LOG_MAX: usize = 200;
const HISTORY_TEXT_MAX: usize = 500;
/// What `local_save` let a commitment's text be before the board: a task brought back by Undo
/// keeps it (its quote, the whole message it came from, was not limited either).
const LEGACY_TEXT_MAX: usize = 20_000;
/// The most history lines a task keeps (the oldest go first).
const HISTORY_MAX: usize = 200;
/// `meeting.json` is read for names only up to this size.
const MEETING_JSON_MAX: u64 = 1024 * 1024;

/// Tasks live in the workspace Connect boots into.
const PERSONAL: &str = "personal";
/// The record that remembers which day the due-today reminder was decided on (bookkeeping, no
/// revision bump), so it runs once a day even when nothing was due.
const REMINDER_KIND: &str = "task_state";
const REMINDER_ID: &str = "due-today";
/// Due dates before this year are typing slips ("0002-11-20" while a year is being typed).
const DUE_YEAR_MIN: i32 = 2000;
/// The local hour of the daily "due today" reminder.
const REMIND_HOUR: u32 = 9;

const TEXT_MESSAGE: &str = "Write what needs doing (up to 2,000 characters).";

fn invalid(field: &str, message: &str) -> WorkspaceError {
    let mut e = WorkspaceError::new("validation", message);
    e.field = Some(field.into());
    e
}

/// A task's status: the stored one, or for a body from before the board `done` or `todo`.
pub(crate) fn status_of(body: &Value) -> &str {
    match body["status"].as_str() {
        Some(s) if STATUSES.contains(&s) => s,
        _ if body["done"] == true => "done",
        _ => "todo",
    }
}

/// Whether someone still has to do the task (To do, In progress, Waiting): not one To review,
/// done or dismissed.
pub(crate) fn is_open(body: &Value) -> bool {
    OPEN.contains(&status_of(body))
}

/// A task's provider: the one it was stamped with, or `"local"` for one without a `provider`
/// field (every task before this step, and every Local task since).
pub(crate) fn provider_of(body: &Value) -> &str {
    body["provider"].as_str().unwrap_or("local")
}

/// The records of `workspace` whose provider is the settings' active one (design §1): what the
/// Tasks page, Today's widget, the meeting column and the 09:00 reminder show. A task found in
/// notes and still To review follows this rule too: it is stamped with the active provider at
/// creation and re-stamped on a switch (a later task).
pub(crate) fn active(r: &Repository, workspace: &str) -> Result<Vec<Record>> {
    let active = active_provider(&r.settings()?).to_string();
    Ok(r.local_records(workspace, KIND)?
        .into_iter()
        .filter(|t| provider_of(&t.data) == active)
        .collect())
}

/// The name of a status's column: the person's own name for it, or the built-in one.
pub(crate) fn column_name(
    status: &str,
    columns: &std::collections::BTreeMap<String, String>,
) -> String {
    columns
        .get(status)
        .map(|n| n.trim())
        .filter(|n| !n.is_empty() && status != "dismissed")
        .map(String::from)
        .or_else(|| {
            NAMES
                .iter()
                .find(|(s, _)| *s == status)
                .map(|(_, n)| n.to_string())
        })
        .unwrap_or_else(|| status.to_string())
}

/// Whether a task is mine: its owner is my address, my name or one of my aliases, or `"You"`
/// (any case). The JS `isMine` in `tasks-model.js` is the same rule.
pub(crate) fn is_mine(task: &Value, me: &MeAlias) -> bool {
    let owner = task["owner"].as_str().map(str::trim).unwrap_or("");
    if owner.is_empty() {
        return false;
    }
    if me
        .address
        .as_deref()
        .map(str::trim)
        .is_some_and(|a| !a.is_empty() && a.eq_ignore_ascii_case(owner))
    {
        return true;
    }
    let owner = owner.to_lowercase();
    let named = |n: &str| {
        let n = n.trim();
        !n.is_empty() && n.to_lowercase() == owner
    };
    named(&me.name) || me.aliases.iter().any(|a| named(a)) || owner == "you"
}

/// `v` as text of at most `max` characters, trimmed; `None` for null or blank.
fn text(v: &Value, field: &str, max: usize, message: &str) -> Result<Option<String>> {
    if v.is_null() {
        return Ok(None);
    }
    let s = v.as_str().ok_or_else(|| invalid(field, message))?.trim();
    if s.contains('\0') || s.chars().count() > max {
        return Err(invalid(field, message));
    }
    Ok(Some(s.to_string()).filter(|s| !s.is_empty()))
}

/// A `YYYY-MM-DD` day that exists, or `None` for null or blank.
fn due(v: &Value) -> Result<Option<String>> {
    const MESSAGE: &str = "Choose a due date.";
    let Some(day) = text(v, "due", 10, MESSAGE)? else {
        return Ok(None);
    };
    chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d")
        .ok()
        .filter(|d| d.format("%Y-%m-%d").to_string() == day && d.year() >= DUE_YEAR_MIN)
        .map(|_| Some(day))
        .ok_or_else(|| invalid("due", MESSAGE))
}

/// History given with a task being created (Undo of a delete puts the old one back).
fn given_history(v: &Value) -> Result<Vec<Value>> {
    const MESSAGE: &str = "The task’s history can’t be read.";
    if v.is_null() {
        return Ok(Vec::new());
    }
    let lines = v.as_array().ok_or_else(|| invalid("history", MESSAGE))?;
    lines
        .iter()
        .rev()
        .take(HISTORY_MAX)
        .rev()
        .map(|h| {
            let at = h["at"]
                .as_i64()
                .ok_or_else(|| invalid("history", MESSAGE))?;
            let line = text(&h["text"], "history", HISTORY_TEXT_MAX, MESSAGE)?
                .ok_or_else(|| invalid("history", MESSAGE))?;
            Ok(json!({"at": at, "text": line}))
        })
        .collect()
}

/// Where a task sits in its column; a body from before the board sorts by when it changed.
fn order_of(task: &Record) -> f64 {
    task.data["order"]
        .as_f64()
        .unwrap_or(task.updated_at as f64)
}

fn by_order(a: &Record, b: &Record) -> std::cmp::Ordering {
    order_of(a)
        .total_cmp(&order_of(b))
        .then_with(|| a.id.cmp(&b.id))
}

/// Saves a task of `workspace_id`: `data` is merged into the stored body (a field given as null
/// clears it, one left out stays), or makes a new task when `data.id` names none (`text` then
/// required; no id makes one). `status` (or, from older callers, `done`) moves it; `log` names a
/// move in the history (`"Accepted from review"`) instead of the built-in "Moved from … to …", or
/// a new task's first line instead of "Added by you". A new task may bring its `history`,
/// `createdAt` and `doneAt` (Undo of a delete). Rewrites `tasks.json` of the task's meeting (and of
/// the meeting it left). Callers hold [`Core::meeting_lock`].
pub(crate) fn task_save(
    r: &mut Repository,
    workspace_id: &str,
    data: &Value,
    now: i64,
) -> Result<Record> {
    if !data.is_object() {
        return Err(invalid("task", "Send the task as an object."));
    }
    let id = match &data["id"] {
        Value::Null => super::models::id(),
        v => text(v, "id", ID_MAX, "Choose a task.")?
            .ok_or_else(|| invalid("id", "Choose a task."))?,
    };
    let existing = match r.record(KIND, &id, None, Some(workspace_id)) {
        Ok(record) => Some(record),
        Err(e) if e.code == "not_found" => None,
        Err(e) => return Err(e),
    };
    let creating = existing.is_none();
    // Undo of a delete brings the task back with its history, as it was stored.
    let restoring = creating && data["history"].as_array().is_some_and(|h| !h.is_empty());
    let before = existing
        .as_ref()
        .map(|t| t.data.clone())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let mut body = before.clone();
    let has = |key: &str| data.get(key).is_some();

    if has("text") {
        let old = before["text"].as_str().map(str::trim);
        // A text kept from before the board (up to 20,000 characters) is never refused unchanged.
        let text = match data["text"].as_str().map(str::trim) {
            Some(same) if Some(same) == old && !same.is_empty() => Some(same.to_string()),
            _ if restoring => text(&data["text"], "text", LEGACY_TEXT_MAX, TEXT_MESSAGE)?,
            _ => text(&data["text"], "text", TEXT_MAX, TEXT_MESSAGE)?,
        };
        body["text"] = text.ok_or_else(|| invalid("text", TEXT_MESSAGE))?.into();
    } else if creating {
        return Err(invalid("text", TEXT_MESSAGE));
    }
    for (key, max, message) in [
        ("notes", NOTES_MAX, "Keep notes to 20,000 characters."),
        ("owner", OWNER_MAX, "Choose an owner."),
        ("ownerName", NAME_MAX, "Choose an owner."),
        ("meetingId", REF_MAX, "Choose a meeting."),
        (
            "quote",
            if restoring { usize::MAX } else { QUOTE_MAX },
            "The quote is too long.",
        ),
        ("speaker", NAME_MAX, "Choose a speaker."),
        ("sourceId", REF_MAX, "Choose a message."),
        ("sourceRevision", REF_MAX, "Choose a message."),
    ] {
        if has(key) {
            body[key] = text(&data[key], key, max, message)?.map_or(Value::Null, Value::from);
        }
    }
    if has("due") {
        body["due"] = due(&data["due"])?.map_or(Value::Null, Value::from);
    }
    if has("confidence") {
        body["confidence"] = match &data["confidence"] {
            Value::Null => Value::Null,
            v => v
                .as_str()
                .filter(|c| matches!(*c, "high" | "low"))
                .map(Value::from)
                .ok_or_else(|| invalid("confidence", "Say whether the owner is certain."))?,
        };
    }
    if has("kind") {
        body["kind"] = data["kind"]
            .as_str()
            .filter(|k| KINDS.contains(k))
            .map(Value::from)
            .ok_or_else(|| invalid("kind", "Choose a kind of task."))?;
    }
    if has("line") {
        body["line"] = match &data["line"] {
            Value::Null => Value::Null,
            v => v
                .as_u64()
                .map(Value::from)
                .ok_or_else(|| invalid("line", "Choose a line of the transcript."))?,
        };
    }
    if has("quoteAt") {
        body["quoteAt"] = match &data["quoteAt"] {
            Value::Null => Value::Null,
            v => v
                .as_f64()
                .filter(|t| t.is_finite() && *t >= 0.0)
                .map(Value::from)
                .ok_or_else(|| invalid("quoteAt", "Choose a moment of the meeting."))?,
        };
    }
    if has("order") {
        body["order"] = data["order"]
            .as_f64()
            .filter(|o| o.is_finite())
            .map(Value::from)
            .ok_or_else(|| invalid("order", "Place the task on the board."))?;
    } else if creating {
        // New tasks go to the end: after every task there is, and after older ones by time.
        let last = r
            .local_records(workspace_id, KIND)?
            .iter()
            .map(order_of)
            .fold(now as f64, f64::max);
        body["order"] = (last + 1.0).into();
    }
    let owner_changed = body["owner"] != before["owner"];
    if owner_changed && !has("ownerName") {
        // A name given before belongs to the owner before.
        body["ownerName"] = Value::Null;
    }
    if owner_changed && !creating && !has("confidence") && before["confidence"] == "low" {
        // The person chose the owner: there is no doubt about it any more.
        body["confidence"] = "high".into();
    }

    let previous = status_of(&before).to_string();
    let status = if has("status") {
        data["status"]
            .as_str()
            .filter(|s| STATUSES.contains(s))
            .ok_or_else(|| invalid("status", "Choose one of the board’s columns."))?
            .to_string()
    } else if has("done") {
        let done = data["done"]
            .as_bool()
            .ok_or_else(|| invalid("done", "Mark the task done or not."))?;
        match (done, previous.as_str()) {
            (true, _) => "done".to_string(),
            (false, "done") => "todo".to_string(),
            (false, other) => other.to_string(),
        }
    } else {
        previous.clone()
    };
    body["status"] = status.clone().into();
    body["done"] = (status == "done").into();
    if status != "done" {
        body["doneAt"] = Value::Null;
    } else if creating {
        body["doneAt"] = data["doneAt"].as_i64().unwrap_or(now).into();
    } else if previous != "done" {
        body["doneAt"] = now.into();
    }
    if creating {
        body["createdAt"] = data["createdAt"].as_i64().unwrap_or(now).into();
        // Set from the active provider unless the data names one (design §1); never written for
        // Local, so a Local task's body, and every fixture of one, stays exactly as it was.
        let provider = match text(
            &data["provider"],
            "provider",
            REF_MAX,
            "Choose a task provider.",
        )? {
            Some(given) => given,
            None => active_provider(&r.settings()?).to_string(),
        };
        if provider != "local" {
            body["provider"] = provider.into();
        }
    }
    // A task without a key gets one: every new task, and an older one saved for the first time
    // since this step (design §13 "Migration"). Never changed once set.
    if body["key"].as_str().filter(|k| !k.is_empty()).is_none() {
        let source = match (body["meetingId"].as_str(), body["line"].as_u64()) {
            (Some(meeting), Some(line)) => format!("meeting:{meeting}:{line}"),
            _ => match body["sourceId"].as_str() {
                Some(source_id) => format!("message:{source_id}"),
                None => format!("manual:{id}"),
            },
        };
        body["key"] = keys::task_key(&source, body["text"].as_str().unwrap_or("")).into();
    }

    let mut log = text(
        &data["log"],
        "log",
        LOG_MAX,
        "Describe the change in fewer words.",
    )?;
    let given = if creating {
        given_history(&data["history"])?
    } else {
        Vec::new()
    };
    let mut lines = Vec::new();
    if creating {
        if given.is_empty() {
            lines.push(log.take().unwrap_or_else(|| "Added by you".into()));
        }
    } else {
        let s = r.settings()?.meetings;
        if status != previous {
            lines.push(log.take().unwrap_or_else(|| {
                format!(
                    "Moved from {} to {}",
                    column_name(&previous, &s.columns),
                    column_name(&status, &s.columns)
                )
            }));
        }
        if owner_changed {
            lines.push(
                match body["ownerName"].as_str().or(body["owner"].as_str()) {
                    Some(name) => format!("Owner set to {name}"),
                    None => "Owner removed".into(),
                },
            );
        }
        if body["due"] != before["due"] {
            lines.push(match body["due"].as_str() {
                Some(day) => format!("Due date set to {day}"),
                None => "Due date removed".into(),
            });
        }
        lines.extend(log);
    }
    let mut history = if creating {
        given
    } else {
        before["history"].as_array().cloned().unwrap_or_default()
    };
    history.extend(
        lines
            .into_iter()
            .map(|line| json!({"at": now, "text": line})),
    );
    let excess = history.len().saturating_sub(HISTORY_MAX);
    history.drain(..excess);
    body["history"] = history.into();

    let mut record = Record {
        id,
        kind: KIND.into(),
        connection_id: None,
        workspace_id: Some(workspace_id.into()),
        source: "local".into(),
        revision: super::models::id(),
        updated_at: now,
        data: body,
    };
    // A provider's task is written with its outbox entries, in one transaction (design §4).
    let ops = provider_ops(&before, &record.data, creating);
    if ops.is_empty() {
        r.put_record(&record)?;
    } else {
        record.data["pending"] = true.into();
        outbox::enqueue_all(r, &record, &ops, now)?;
    }
    let mut meetings: Vec<&str> = [&before["meetingId"], &record.data["meetingId"]]
        .into_iter()
        .filter_map(Value::as_str)
        .collect();
    meetings.dedup();
    for meeting in meetings {
        write_tasks_json(r, workspace_id, meeting);
    }
    Ok(record)
}

/// What saving a provider's task from `before` to `after` sends (design §1, §4): nothing for
/// Local or for a task To review or Dismissed (Connect's drafts, never sent); a `create` the first
/// time it is open or done; then an `update` naming the fields that changed and a `complete` when
/// it was done or reopened. A move between To do, In progress and Waiting sends nothing unless
/// the kind it reads as changes.
fn provider_ops(before: &Value, after: &Value, creating: bool) -> Vec<(&'static str, Value)> {
    let sent = |b: &Value| !matches!(status_of(b), "review" | "dismissed");
    if provider_of(after) == "local" || !sent(after) {
        return Vec::new();
    }
    let in_provider = !creating && (before["remote"]["id"].is_string() || sent(before));
    let (b, a) = (wire::fields(before), wire::fields(after));
    if !in_provider {
        let mut ops = vec![("create", json!({}))];
        if a["done"] == true {
            ops.push(("complete", json!({"done": true})));
        }
        return ops;
    }
    let mut ops = Vec::new();
    let changed: serde_json::Map<String, Value> = ["text", "notes", "due", "kind", "owner"]
        .into_iter()
        .filter(|k| a[*k] != b[*k])
        .map(|k| (k.to_string(), Value::Bool(true)))
        .collect();
    if !changed.is_empty() {
        ops.push(("update", Value::Object(changed)));
    }
    if a["done"] != b["done"] {
        ops.push(("complete", json!({"done": a["done"]})));
    }
    ops
}

/// Deletes a task of `workspace_id` and returns its body, so Undo can save it back with
/// [`task_save`]. Rewrites its meeting's `tasks.json`; a task found on a transcript line has its
/// line remembered on the meeting, so notes made again don't add it back. Callers hold
/// [`Core::meeting_lock`].
pub(crate) fn task_delete(r: &mut Repository, workspace_id: &str, id: &str) -> Result<Value> {
    let task = r.record(KIND, id, None, Some(workspace_id)).map_err(|e| {
        if e.code == "not_found" {
            WorkspaceError::new("not_found", "This task is no longer there.")
        } else {
            e
        }
    })?;
    if provider_of(&task.data) == "local" {
        r.delete_local(KIND, id, workspace_id)?;
    } else {
        // Its unsent changes go with it; once it is in the provider, a `remove` is queued, in the
        // same transaction (design §10 "Delete with a provider").
        outbox::delete_task(r, &task, super::models::now())?;
    }
    if let Some(meeting) = task.data["meetingId"].as_str() {
        if let Some(line) = task.data["line"].as_u64() {
            // Notes made again must not bring a deleted task back.
            if let Err(e) = super::meetings::remember_removed_line(r, meeting, line) {
                log::warn!("tasks: cannot remember a deleted task's line: {}", e.code);
            }
        }
        write_tasks_json(r, workspace_id, meeting);
    }
    Ok(task.data)
}

/// Best effort: the task is saved whatever happens to the file, and a folder that is gone is
/// never made again.
fn write_tasks_json(r: &Repository, workspace_id: &str, meeting_id: &str) {
    if let Err(e) = try_write_tasks_json(r, workspace_id, meeting_id) {
        log::warn!("tasks: cannot update a meeting's tasks.json: {}", e.code);
    }
}

/// Writes `tasks.json` into the meeting's folder, when the meeting has one that is there:
/// `[{id, task, owner, due, confidence, quote, t, status}]`, in board order, with owners by name.
fn try_write_tasks_json(r: &Repository, workspace_id: &str, meeting_id: &str) -> Result<()> {
    let Some(me) = r
        .settings()?
        .active_connection
        .and_then(|id| r.connection(&id).ok())
    else {
        return Ok(());
    };
    let Ok(meeting) = r.record("meeting", meeting_id, Some(&me.id), None) else {
        return Ok(());
    };
    let Some(dir) = meeting.data["folder"]
        .as_str()
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
    else {
        return Ok(());
    };
    let names = people_names(&dir);
    let mut tasks: Vec<Record> = r
        .local_records(workspace_id, KIND)?
        .into_iter()
        .filter(|t| t.data["meetingId"] == meeting_id)
        .collect();
    tasks.sort_by(by_order);
    let list: Vec<Value> = tasks
        .iter()
        .map(|t| {
            let d = &t.data;
            json!({"id": t.id, "task": d["text"], "owner": owner_name(d, &names, &me),
                "due": d["due"], "confidence": d["confidence"], "quote": d["quote"], "t": d["quoteAt"],
                "status": status_of(d)})
        })
        .collect();
    let text = serde_json::to_string_pretty(&list)
        .map_err(|_| WorkspaceError::new("storage", "The meeting’s tasks could not be written."))?;
    folder::write_file(&dir.join("tasks.json"), format!("{text}\n").as_bytes())
        .map_err(|_| folder::meeting_unwritable(&dir))
}

/// The organizer's and attendees' names by lower-case address, from `meeting.json`.
fn people_names(dir: &Path) -> HashMap<String, String> {
    let path = dir.join("meeting.json");
    let meeting: Value = std::fs::metadata(&path)
        .ok()
        .filter(|m| m.len() <= MEETING_JSON_MAX)
        .and_then(|_| std::fs::read(&path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    std::iter::once(&meeting["organizer"])
        .chain(meeting["attendees"].as_array().into_iter().flatten())
        .filter_map(|p| {
            let address = p["address"].as_str()?.trim().to_lowercase();
            let name = p["name"].as_str()?.trim();
            (!address.is_empty() && !name.is_empty()).then(|| (address, name.to_string()))
        })
        .collect()
}

/// A task's owner by name for `tasks.json`: its own name, the account's name for me, an
/// attendee's name for their address, else what it says; null for nobody.
fn owner_name(task: &Value, names: &HashMap<String, String>, me: &Connection) -> Value {
    let Some(owner) = task["owner"]
        .as_str()
        .map(str::trim)
        .filter(|o| !o.is_empty())
    else {
        return Value::Null;
    };
    if let Some(name) = task["ownerName"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        return name.into();
    }
    let mine = owner.eq_ignore_ascii_case("you") || owner.eq_ignore_ascii_case(me.email.trim());
    if mine && !me.display_name.trim().is_empty() {
        return me.display_name.trim().into();
    }
    names
        .get(&owner.to_lowercase())
        .cloned()
        .unwrap_or_else(|| owner.to_string())
        .into()
}

/// The daily reminder (Settings › Meetings › Tasks, "Remind me about tasks due today"): the first
/// background round at or after 09:00 in the workspace time zone decides the day (remembered in
/// a bookkeeping record, so later rounds that day do nothing) and queues one notification about
/// my open tasks due that day (`payload.route` opens Tasks); nothing when none are due. While the
/// reminder or notifications are off, no day is decided, so turning them on later that day still
/// reminds once. The job's key is the day as well.
pub(crate) fn due_today_reminders(core: &Core, now: i64) -> Result<()> {
    if !workspace_id_active(PERSONAL) {
        return Ok(());
    }
    let mut r = core.repo()?;
    let s = r.settings()?;
    if !s.meetings.remind || !s.notifications {
        return Ok(());
    }
    let zone: chrono_tz::Tz = s.time_zone.parse().unwrap_or(chrono_tz::UTC);
    let Some(local) = chrono::DateTime::from_timestamp(now, 0).map(|t| t.with_timezone(&zone))
    else {
        return Ok(());
    };
    if local.hour() < REMIND_HOUR {
        return Ok(());
    }
    let day = local.date_naive();
    let today = day.format("%Y-%m-%d").to_string();
    // The first round at or after 09:00 decides the day, whether or not anything is due: a task
    // made due today later (at 15:00, say) brings no notification about itself.
    let decided = r
        .record(REMINDER_KIND, REMINDER_ID, None, Some(PERSONAL))
        .is_ok_and(|rec| rec.data["day"] == today.as_str());
    if decided {
        return Ok(());
    }
    r.put_record_unversioned(&Record {
        id: REMINDER_ID.into(),
        kind: REMINDER_KIND.into(),
        connection_id: None,
        workspace_id: Some(PERSONAL.into()),
        source: "local".into(),
        revision: super::models::id(),
        updated_at: now,
        data: json!({"day": today}),
    })?;
    let me = s
        .active_connection
        .as_deref()
        .and_then(|id| r.connection(id).ok())
        .map(|c| core.me_alias(&c, &s.meetings))
        .unwrap_or_default();
    let mut due: Vec<Record> = active(&r, PERSONAL)?
        .into_iter()
        .filter(|t| {
            OPEN.contains(&status_of(&t.data))
                && t.data["due"].as_str() == Some(today.as_str())
                && is_mine(&t.data, &me)
        })
        .collect();
    if due.is_empty() {
        return Ok(());
    }
    due.sort_by(by_order);
    let n = due.len();
    let title = if n == 1 {
        "1 task due today".to_string()
    } else {
        format!("{n} tasks due today")
    };
    let names: Vec<&str> = due.iter().filter_map(|t| t.data["text"].as_str()).collect();
    let body = if names.len() > 3 {
        format!("{} and {} more", names[..3].join(" · "), names.len() - 3)
    } else {
        names.join(" · ")
    };
    // Shown today or not at all.
    let expires = day
        .succ_opt()
        .and_then(|next| next.and_hms_opt(0, 0, 0))
        .and_then(|midnight| midnight.and_local_timezone(zone).earliest())
        .map_or(now + 86_400, |t| t.timestamp());
    let policy = r.policy(Some(PERSONAL), None)?;
    r.enqueue(&new_job(
        "notification",
        format!("tasks_due:{today}"),
        Some(PERSONAL.into()),
        None,
        now,
        policy,
        json!({"title": title, "body": body, "route": "tasks", "expiresAt": expires}),
    ))
}

impl Core {
    /// `task_save {id?, text, owner, …, log?}` and `task_delete {id}` (Tasks, Today, Inbox).
    pub(in crate::workspace) fn task_op(&self, req: &Request) -> Result<Value> {
        let (w, _) = self.active_workspace(req, false)?;
        // Same order as the other meeting-folder writers: their lock, then the repository.
        let _folders = self.meeting_lock();
        let mut r = self.repo()?;
        match req.op {
            Operation::TaskSave => {
                let mut data = req.data.clone();
                if let (Some(fields), Some(op)) = (data.as_object_mut(), &req.operation_id) {
                    // A new task takes the operation's id, so a retried request makes one task.
                    if fields.get("id").is_none_or(Value::is_null) {
                        fields.insert("id".into(), op.clone().into());
                    }
                }
                let task = task_save(&mut r, &w.id, &data, now())?;
                if task.data["pending"] == true {
                    // Pushed at once (design ruling 4), window open or closed.
                    sync::queue(&mut r, provider_of(&task.data), now())?;
                }
                Ok(json!({"id": task.id}))
            }
            Operation::TaskDelete => {
                let id = required(&req.data, "id", ID_MAX)?;
                let body = task_delete(&mut r, &w.id, id)?;
                if body["remote"]["id"].is_string() {
                    sync::queue(&mut r, provider_of(&body), now())?;
                }
                Ok(json!({"deleted": true, "id": id, "body": body}))
            }
            _ => Err(WorkspaceError::new("validation", "Unsupported operation.")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::ai::tests::{mutation, ready};
    use crate::workspace::test_core;
    use serde_json::json;
    use std::path::Path;
    use std::sync::Arc;

    const ACCT: &str = "7f1c2a4e-0000-4000-8000-000000000001";
    /// Wed 18 Nov 2026, 12:00 UTC.
    const NOW: i64 = 1_795_003_200;

    struct Env {
        dir: tempfile::TempDir,
        core: Arc<Core>,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        connect(&core);
        Env { dir, core }
    }

    /// Taylor Morgan, signed in and bound to `personal`, in Kyiv, with notifications on.
    fn connect(core: &Core) {
        let mut r = core.repo().unwrap();
        r.save_connection(&Connection {
            id: ACCT.into(),
            account_key: ACCT.into(),
            display_name: "Taylor Morgan".into(),
            email: "taylor@example.test".into(),
            user_id: "me-1".into(),
            generation: 1,
            policy_revision: 1,
            scopes: vec!["Calendars.Read".into()],
            enabled: vec!["calendar".into()],
            status: "connected".into(),
            ..Default::default()
        })
        .unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some(ACCT.into());
        s.time_zone = "Europe/Kyiv".into();
        s.notifications = true;
        r.settings_update(&s).unwrap();
        let mut w = r.workspace("personal").unwrap();
        w.connection_id = Some(ACCT.into());
        r.save_workspace(&w).unwrap();
    }

    /// A meeting record whose folder is `folder` (absolute), beside its event.
    fn meeting(core: &Core, id: &str, folder: &Path) {
        core.repo()
            .unwrap()
            .put_record(&Record {
                id: id.into(),
                kind: "meeting".into(),
                connection_id: Some(ACCT.into()),
                workspace_id: None,
                source: "calendar:cal-1".into(),
                revision: "r".into(),
                updated_at: NOW,
                data: json!({"eventId": id, "title": "Philips CodeMie conversations syncup",
                    "start": "2026-11-04T14:00:00Z", "end": "2026-11-04T14:30:00Z", "state": "downloaded",
                    "folder": folder.to_string_lossy()}),
            })
            .unwrap();
    }

    fn save(core: &Core, data: Value, at: i64) -> Result<Record> {
        task_save(&mut core.repo().unwrap(), "personal", &data, at)
    }

    fn body(core: &Core, id: &str) -> Value {
        core.repo()
            .unwrap()
            .record(KIND, id, None, Some("personal"))
            .unwrap()
            .data
    }

    fn history(core: &Core, id: &str) -> Vec<String> {
        body(core, id)["history"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["text"].as_str().unwrap().to_string())
            .collect()
    }

    async fn op(core: &Arc<Core>, op: Operation, data: Value) -> Result<Value> {
        core.request(mutation(core, op, data)).await
    }

    #[test]
    fn task_save_merges_and_keeps_meeting_fields() {
        let e = env();
        save(
            &e.core,
            json!({"id": "t1", "text": "Send the names of the 40 pilot users", "status": "review",
                "owner": "marek.novak@example.test", "ownerName": "Marek Novak", "due": "2026-11-20",
                "meetingId": "m1", "line": 4, "quote": "I'll send you the names by Friday.",
                "quoteAt": 173.0, "speaker": "Marek Novak", "confidence": "low",
                "sourceId": null, "sourceRevision": null}),
            NOW,
        )
        .unwrap();
        let saved = save(&e.core, json!({"id": "t1", "status": "doing"}), NOW + 60).unwrap();
        let b = &saved.data;
        assert_eq!(saved.kind, "commitment");
        assert_eq!(saved.workspace_id.as_deref(), Some("personal"));
        assert_eq!(saved.connection_id, None);
        assert_eq!(b["status"], "doing");
        assert_eq!(b["done"], false);
        assert_eq!(b["text"], "Send the names of the 40 pilot users");
        assert_eq!(b["meetingId"], "m1");
        assert_eq!(b["line"], 4);
        assert_eq!(b["quote"], "I'll send you the names by Friday.");
        assert_eq!(b["quoteAt"], 173.0);
        assert_eq!(b["speaker"], "Marek Novak");
        assert_eq!(b["confidence"], "low");
        assert_eq!(b["owner"], "marek.novak@example.test");
        assert_eq!(b["ownerName"], "Marek Novak");
        assert_eq!(b["due"], "2026-11-20");
        assert!(b["order"].is_f64(), "{b}");
        assert_eq!(
            body(&e.core, "t1"),
            *b,
            "the stored body is the one returned"
        );
        // Choosing the owner takes away the doubt about it.
        let owned = save(
            &e.core,
            json!({"id": "t1", "owner": "jeroen@example.test", "ownerName": "Jeroen de Vries"}),
            NOW + 120,
        )
        .unwrap();
        assert_eq!(owned.data["confidence"], "high");
        assert_eq!(owned.data["quote"], "I'll send you the names by Friday.");
    }

    #[test]
    fn task_save_keeps_done_in_step_with_status() {
        let e = env();
        let done = save(
            &e.core,
            json!({"id": "t1", "text": "Book a room for demo day", "status": "done"}),
            NOW,
        )
        .unwrap();
        assert_eq!(done.data["done"], true);
        assert_eq!(done.data["doneAt"], NOW);
        let open = save(&e.core, json!({"id": "t1", "status": "waiting"}), NOW + 5).unwrap();
        assert_eq!(open.data["done"], false);
        assert_eq!(open.data["doneAt"], Value::Null);
        // A commitment from before the board: no status, read from `done`.
        e.core
            .repo()
            .unwrap()
            .put_record(&Record {
                id: "legacy".into(),
                kind: KIND.into(),
                connection_id: None,
                workspace_id: Some("personal".into()),
                source: "local".into(),
                revision: "l".into(),
                updated_at: NOW - 86_400,
                data: json!({"text": "Share stand-up notes", "done": true, "owner": "You"}),
            })
            .unwrap();
        assert_eq!(status_of(&body(&e.core, "legacy")), "done");
        let renamed = save(
            &e.core,
            json!({"id": "legacy", "text": "Share the stand-up notes"}),
            NOW,
        )
        .unwrap();
        assert_eq!(renamed.data["status"], "done");
        assert_eq!(renamed.data["done"], true);
        // `done` alone (older callers) moves it too.
        let reopened = save(&e.core, json!({"id": "legacy", "done": false}), NOW).unwrap();
        assert_eq!(reopened.data["status"], "todo");
        assert_eq!(reopened.data["done"], false);
        assert_eq!(status_of(&json!({"text": "x"})), "todo");
        assert_eq!(status_of(&json!({"status": "later", "done": true})), "done");
    }

    #[test]
    fn task_history_records_status_owner_and_due_changes() {
        let e = env();
        save(
            &e.core,
            json!({"id": "t1", "text": "Warn admins at 80% of budget"}),
            NOW,
        )
        .unwrap();
        assert_eq!(history(&e.core, "t1"), vec!["Added by you"]);
        save(&e.core, json!({"id": "t1", "status": "doing"}), NOW + 1).unwrap();
        save(
            &e.core,
            json!({"id": "t1", "owner": "jeroen@example.test", "ownerName": "Jeroen de Vries"}),
            NOW + 2,
        )
        .unwrap();
        save(&e.core, json!({"id": "t1", "due": "2026-11-20"}), NOW + 3).unwrap();
        assert_eq!(
            history(&e.core, "t1"),
            vec![
                "Added by you",
                "Moved from To do to In progress",
                "Owner set to Jeroen de Vries",
                "Due date set to 2026-11-20"
            ]
        );
        let at: Vec<i64> = body(&e.core, "t1")["history"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["at"].as_i64().unwrap())
            .collect();
        assert_eq!(at, vec![NOW, NOW + 1, NOW + 2, NOW + 3]);
        // Saving the same values again adds nothing; clearing says so; the board's own words win.
        save(
            &e.core,
            json!({"id": "t1", "status": "doing", "due": "2026-11-20"}),
            NOW + 4,
        )
        .unwrap();
        assert_eq!(history(&e.core, "t1").len(), 4);
        save(
            &e.core,
            json!({"id": "t1", "due": null, "owner": null}),
            NOW + 5,
        )
        .unwrap();
        save(&e.core, json!({"id": "t1", "status": "review"}), NOW + 6).unwrap();
        save(
            &e.core,
            json!({"id": "t1", "status": "todo", "log": "Accepted from review"}),
            NOW + 7,
        )
        .unwrap();
        assert_eq!(
            history(&e.core, "t1")[4..],
            [
                "Owner removed",
                "Due date removed",
                "Moved from In progress to To review",
                "Accepted from review"
            ]
        );
        // Renamed columns name the move.
        let mut r = e.core.repo().unwrap();
        let mut s = r.settings().unwrap();
        s.meetings.columns.insert("todo".into(), "Next up".into());
        r.settings_update(&s).unwrap();
        task_save(
            &mut r,
            "personal",
            &json!({"id": "t1", "status": "done"}),
            NOW + 8,
        )
        .unwrap();
        drop(r);
        assert_eq!(
            history(&e.core, "t1").last().unwrap(),
            "Moved from Next up to Done"
        );
        // A task found in notes names where it came from.
        save(
            &e.core,
            json!({"id": "t2", "text": "Draft the pilot plan", "status": "review", "log": "Found in the notes (Meeting notes)"}),
            NOW,
        )
        .unwrap();
        assert_eq!(
            history(&e.core, "t2"),
            vec!["Found in the notes (Meeting notes)"]
        );
    }

    fn set_provider(core: &Core, provider: &str) {
        let mut r = core.repo().unwrap();
        let mut s = r.settings().unwrap();
        s.tasks.provider = provider.into();
        r.settings_update(&s).unwrap();
    }

    #[test]
    fn task_save_stamps_provider_key_and_kind() {
        let e = env();
        // Local: no "provider" field at all, a 16-hex key, and an absent "kind" (reads as "task").
        let local = save(
            &e.core,
            json!({"id": "t1", "text": "Send the pilot user list"}),
            NOW,
        )
        .unwrap();
        assert!(local.data.get("provider").is_none(), "{}", local.data);
        let key = local.data["key"].as_str().expect("a key");
        assert_eq!(key.len(), 16);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(local.data.get("kind").is_none(), "{}", local.data);
        // The key never changes on a later save.
        let resaved = save(&e.core, json!({"id": "t1", "status": "doing"}), NOW + 1).unwrap();
        assert_eq!(resaved.data["key"], key);

        // With a provider active, a new task is stamped with it.
        set_provider(&e.core, "plugin:todoist");
        let provided = save(
            &e.core,
            json!({"id": "t2", "text": "Check with Marek about the pilot list"}),
            NOW,
        )
        .unwrap();
        assert_eq!(provided.data["provider"], "plugin:todoist");

        // An unknown kind is refused; a known one is kept.
        let error = save(
            &e.core,
            json!({"id": "t3", "text": "x", "kind": "bogus"}),
            NOW,
        )
        .unwrap_err();
        assert_eq!(error.code, "validation");
        assert_eq!(error.field.as_deref(), Some("kind"));
        let waiting = save(
            &e.core,
            json!({"id": "t4", "text": "Ask Marek", "kind": "waiting"}),
            NOW,
        )
        .unwrap();
        assert_eq!(waiting.data["kind"], "waiting");
    }

    #[test]
    fn tasks_active_and_the_reminder_follow_the_provider() {
        let e = env();
        save(
            &e.core,
            json!({"id": "local-1", "text": "Task kept in Connect", "owner": "You", "due": "2026-11-18"}),
            NOW,
        )
        .unwrap();
        set_provider(&e.core, "plugin:todoist");
        save(
            &e.core,
            json!({"id": "todoist-1", "text": "Task kept in Todoist", "owner": "You", "due": "2026-11-18"}),
            NOW,
        )
        .unwrap();
        let active_tasks = active(&e.core.repo().unwrap(), "personal").unwrap();
        assert_eq!(
            active_tasks
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            vec!["todoist-1"]
        );
        // The 09:00 reminder names only the active provider's task.
        let nine = 1_794_985_200;
        due_today_reminders(&e.core, nine).unwrap();
        let job = e
            .core
            .repo()
            .unwrap()
            .jobs()
            .unwrap()
            .into_iter()
            .find(|j| j.key.starts_with("tasks_due:"))
            .expect("a reminder job");
        assert_eq!(job.payload["title"], "1 task due today");
        assert_eq!(job.payload["body"], "Task kept in Todoist");
    }

    #[tokio::test]
    async fn local_saves_queue_nothing() {
        let e = env();
        op(
            &e.core,
            Operation::TaskSave,
            json!({"text": "A Local task"}),
        )
        .await
        .unwrap();
        let jobs = e.core.repo().unwrap().jobs().unwrap();
        assert!(
            jobs.iter().all(|j| j.kind != "task_sync"),
            "no task_sync job is queued for Local: {jobs:?}"
        );
        let outbox = e
            .core
            .repo()
            .unwrap()
            .records_of_kind("task_outbox")
            .unwrap();
        assert!(outbox.is_empty(), "no outbox entry for Local: {outbox:?}");
    }

    #[tokio::test]
    async fn local_save_of_commitment_keeps_task_fields() {
        let e = env();
        save(
            &e.core,
            json!({"id": "t1", "text": "Prepare the export demo", "status": "doing", "meetingId": "m1", "owner": "You",
                "line": 2, "quote": "I'll prepare the demo.", "notes": "Use the staging tenant"}),
            NOW,
        )
        .unwrap();
        // Today's checkbox before the board: every field it knows, nothing else.
        op(
            &e.core,
            Operation::LocalSave,
            json!({"kind": "commitment", "id": "t1", "text": "Prepare the export demo", "done": false,
                "due": "2026-11-19", "owner": "You", "sourceId": null, "quote": "I'll prepare the demo."}),
        )
        .await
        .unwrap();
        let b = body(&e.core, "t1");
        assert_eq!(b["status"], "doing");
        assert_eq!(b["meetingId"], "m1");
        assert_eq!(b["line"], 2);
        assert_eq!(b["notes"], "Use the staging tenant");
        assert_eq!(b["due"], "2026-11-19");
        assert_eq!(
            history(&e.core, "t1"),
            vec!["Added by you", "Due date set to 2026-11-19"]
        );
        op(
            &e.core,
            Operation::LocalSave,
            json!({"kind": "commitment", "id": "t1", "text": "Prepare the export demo", "done": true,
                "due": "2026-11-19", "owner": "You"}),
        )
        .await
        .unwrap();
        let b = body(&e.core, "t1");
        assert_eq!(
            (b["status"].as_str(), b["done"].as_bool()),
            (Some("done"), Some(true))
        );
        assert_eq!(b["meetingId"], "m1");
        // A new one through local_save is a task in To do.
        let made = op(
            &e.core,
            Operation::LocalSave,
            json!({"kind": "commitment", "text": "Book the workshop room", "owner": "You", "due": null}),
        )
        .await
        .unwrap();
        let b = body(&e.core, made["id"].as_str().unwrap());
        assert_eq!(b["status"], "todo");
        assert_eq!(b["done"], false);
        // local_delete of a commitment removes it like task_delete.
        op(
            &e.core,
            Operation::LocalDelete,
            json!({"kind": "commitment", "id": "t1"}),
        )
        .await
        .unwrap();
        assert!(e
            .core
            .repo()
            .unwrap()
            .record(KIND, "t1", None, Some("personal"))
            .is_err());
    }

    #[tokio::test]
    async fn task_delete_returns_the_body_and_save_restores_it() {
        let e = env();
        let made = op(
            &e.core,
            Operation::TaskSave,
            json!({"text": "Send Legal the written legal-hold requirement", "owner": "You", "due": "2026-11-13"}),
        )
        .await
        .unwrap();
        let id = made["id"].as_str().unwrap().to_string();
        op(
            &e.core,
            Operation::TaskSave,
            json!({"id": id, "status": "waiting", "notes": "Asked on Teams"}),
        )
        .await
        .unwrap();
        let before = body(&e.core, &id);
        let deleted = op(&e.core, Operation::TaskDelete, json!({"id": id}))
            .await
            .unwrap();
        assert_eq!(deleted["deleted"], true);
        assert_eq!(deleted["body"], before);
        assert!(e
            .core
            .repo()
            .unwrap()
            .record(KIND, &id, None, Some("personal"))
            .is_err());
        let gone = op(&e.core, Operation::TaskDelete, json!({"id": id}))
            .await
            .unwrap_err();
        assert_eq!(gone.code, "not_found");
        // Undo: the body goes back as it was, history included.
        let mut restore = deleted["body"].clone();
        restore["id"] = id.clone().into();
        op(&e.core, Operation::TaskSave, restore).await.unwrap();
        assert_eq!(body(&e.core, &id), before);
        assert_eq!(
            history(&e.core, &id),
            vec!["Added by you", "Moved from To do to Waiting"]
        );
    }

    #[tokio::test]
    async fn undo_brings_back_a_commitment_from_before_the_board() {
        let e = env();
        // The old dialog kept a text up to 20,000 characters and the whole message as the quote.
        let text = "t".repeat(5000);
        let quote = "q".repeat(30_000);
        e.core
            .repo()
            .unwrap()
            .put_record(&Record {
                id: "old".into(),
                kind: KIND.into(),
                connection_id: None,
                workspace_id: Some("personal".into()),
                source: "local".into(),
                revision: "l".into(),
                updated_at: NOW,
                data: json!({"text": text, "done": false, "owner": "You", "quote": quote,
                    "sourceId": "m-1", "history": [{"at": NOW, "text": "Added by you"}]}),
            })
            .unwrap();
        let before = body(&e.core, "old");
        let deleted = op(&e.core, Operation::TaskDelete, json!({"id": "old"}))
            .await
            .unwrap();
        let mut restore = deleted["body"].clone();
        restore["id"] = "old".into();
        op(&e.core, Operation::TaskSave, restore).await.unwrap();
        let back = body(&e.core, "old");
        assert_eq!(back["text"], before["text"]);
        assert_eq!(back["quote"], before["quote"]);
        assert_eq!(back["history"], before["history"]);
        assert_eq!(back["status"], "todo");
        // A new task (no history to bring back) keeps the board's limits.
        let error = op(
            &e.core,
            Operation::TaskSave,
            json!({"id": "new", "text": "t".repeat(2001)}),
        )
        .await
        .unwrap_err();
        assert_eq!(error.field.as_deref(), Some("text"));
    }

    #[test]
    fn task_save_rewrites_the_meeting_tasks_json() {
        let e = env();
        let dir = e
            .dir
            .path()
            .join("2026-11-04_160426-philips-codemie-conversations-syncup");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(
            dir.join("meeting.json"),
            serde_json::to_string(&json!({"event_id": "m1", "subject": "Philips CodeMie conversations syncup",
                "organizer": {"name": "Jeroen de Vries", "address": "jeroen@example.test"},
                "attendees": [{"name": "Marek Novak", "address": "marek.novak@example.test", "type": "required"}]}))
            .unwrap(),
        )
        .unwrap();
        meeting(&e.core, "m1", &dir);
        save(
            &e.core,
            json!({"id": "t2", "text": "Add CSV import", "status": "todo", "order": 2.0, "meetingId": "m1",
                "owner": "jeroen@example.test", "line": 9, "quote": "We need CSV import.", "quoteAt": 412.5,
                "confidence": "high"}),
            NOW,
        )
        .unwrap();
        save(
            &e.core,
            json!({"id": "t1", "text": "Send the names of the 40 pilot users", "status": "review",
                "order": 1.0, "meetingId": "m1", "owner": "MAREK.NOVAK@example.test", "due": "2026-11-30",
                "line": 4, "quote": "I'll send you the names.", "quoteAt": 173.0, "confidence": "low"}),
            NOW,
        )
        .unwrap();
        // Not from this meeting: not in its file.
        save(
            &e.core,
            json!({"id": "t3", "text": "Renew the certificate", "owner": "You"}),
            NOW,
        )
        .unwrap();
        let read = || -> Value {
            serde_json::from_slice(&std::fs::read(dir.join("tasks.json")).unwrap()).unwrap()
        };
        assert_eq!(
            read(),
            json!([
                {"id": "t1", "task": "Send the names of the 40 pilot users", "owner": "Marek Novak",
                    "due": "2026-11-30", "confidence": "low", "quote": "I'll send you the names.", "t": 173.0,
                    "status": "review"},
                {"id": "t2", "task": "Add CSV import", "owner": "Jeroen de Vries", "due": null,
                    "confidence": "high", "quote": "We need CSV import.", "t": 412.5, "status": "todo"}
            ])
        );
        // The owner's own name wins; "You" is the account's name; a move updates the file.
        save(
            &e.core,
            json!({"id": "t2", "status": "done", "owner": "You"}),
            NOW + 1,
        )
        .unwrap();
        assert_eq!(read()[1]["owner"], "Taylor Morgan");
        assert_eq!(read()[1]["status"], "done");
        // Deleting a task takes it out of the file.
        task_delete(&mut e.core.repo().unwrap(), "personal", "t1").unwrap();
        assert_eq!(read().as_array().unwrap().len(), 1);
        // A meeting whose folder is gone: the save works, no folder appears.
        let gone = e.dir.path().join("moved-away");
        meeting(&e.core, "m2", &gone);
        save(
            &e.core,
            json!({"id": "t4", "text": "Ask IT for a test tenant", "meetingId": "m2"}),
            NOW,
        )
        .unwrap();
        assert!(!gone.exists());
        assert_eq!(body(&e.core, "t4")["meetingId"], "m2");
        // Moving a task to another meeting takes it out of the first one's file.
        save(&e.core, json!({"id": "t2", "meetingId": "m2"}), NOW + 2).unwrap();
        assert_eq!(read(), json!([]));
    }

    #[test]
    fn task_save_rejects_unknown_status_and_long_text() {
        let e = env();
        save(&e.core, json!({"id": "t1", "text": "Keep me"}), NOW).unwrap();
        let before = body(&e.core, "t1");
        for (data, field) in [
            (json!({"id": "t1", "status": "later"}), "status"),
            (json!({"id": "t1", "status": 3}), "status"),
            (json!({"id": "t1", "text": "x".repeat(2001)}), "text"),
            (json!({"id": "t1", "text": "   "}), "text"),
            (json!({"id": "t1", "notes": "x".repeat(20_001)}), "notes"),
            (json!({"id": "t1", "due": "tomorrow"}), "due"),
            (json!({"id": "t1", "due": "2026-02-30"}), "due"),
            (json!({"id": "t1", "due": "0002-11-20"}), "due"),
            (json!({"id": "t1", "confidence": "maybe"}), "confidence"),
            (json!({"id": "t1", "order": "first"}), "order"),
            (json!({"id": "t1", "line": -1}), "line"),
            (json!({"id": "t1", "owner": "x".repeat(321)}), "owner"),
            (json!({"id": "t2"}), "text"),
            (
                json!({"id": "x".repeat(201), "text": "Too long an id"}),
                "id",
            ),
        ] {
            let error = save(&e.core, data.clone(), NOW + 1).unwrap_err();
            assert_eq!(error.code, "validation", "{data}");
            assert_eq!(error.field.as_deref(), Some(field), "{data}");
        }
        assert_eq!(
            body(&e.core, "t1"),
            before,
            "a refused save changes nothing"
        );
        assert!(e
            .core
            .repo()
            .unwrap()
            .record(KIND, "t2", None, Some("personal"))
            .is_err());
        // A long text kept from before the board still saves while it stays the same.
        let long = "y".repeat(5000);
        e.core
            .repo()
            .unwrap()
            .put_record(&Record {
                id: "old".into(),
                kind: KIND.into(),
                connection_id: None,
                workspace_id: Some("personal".into()),
                source: "local".into(),
                revision: "l".into(),
                updated_at: NOW,
                data: json!({"text": long, "done": false}),
            })
            .unwrap();
        save(
            &e.core,
            json!({"id": "old", "text": long, "done": true}),
            NOW,
        )
        .unwrap();
        assert_eq!(body(&e.core, "old")["status"], "done");
    }

    #[test]
    fn is_mine_matches_my_address_names_and_you() {
        let me = MeAlias {
            name: "Taylor Morgan".into(),
            aliases: vec!["Tay".into()],
            address: Some("taylor@example.test".into()),
        };
        for owner in [
            "You",
            "you",
            "TAYLOR@example.test",
            "Taylor Morgan",
            " tay ",
        ] {
            assert!(is_mine(&json!({"owner": owner}), &me), "{owner}");
        }
        for task in [
            json!({"owner": "jeroen@example.test"}),
            json!({"owner": "Jeroen"}),
            json!({"owner": null}),
            json!({"owner": ""}),
            json!({}),
        ] {
            assert!(!is_mine(&task, &me), "{task}");
        }
        // Signed out: only "You".
        assert!(is_mine(&json!({"owner": "You"}), &MeAlias::default()));
        assert!(!is_mine(&json!({"owner": ""}), &MeAlias::default()));
    }

    #[tokio::test]
    async fn due_today_reminder_runs_once_a_day() {
        let e = env();
        // 18 Nov in Kyiv (UTC+2).
        let today = "2026-11-18";
        for (id, owner, status, due) in [
            ("mine", "You", "todo", today),
            ("by-address", "taylor@example.test", "doing", today),
            ("theirs", "jeroen@example.test", "todo", today),
            ("tomorrow", "You", "todo", "2026-11-19"),
            ("done", "You", "done", today),
            ("review", "You", "review", today),
            ("dismissed", "You", "dismissed", today),
        ] {
            save(
                &e.core,
                json!({"id": id, "text": format!("Task {id}"), "owner": owner, "status": status, "due": due}),
                NOW,
            )
            .unwrap();
        }
        let reminders = || -> Vec<Job> {
            e.core
                .repo()
                .unwrap()
                .jobs()
                .unwrap()
                .into_iter()
                .filter(|j| j.key.starts_with("tasks_due:"))
                .collect()
        };
        // 08:59 and 09:00 in Kyiv.
        let nine = 1_794_985_200;
        due_today_reminders(&e.core, nine - 60).unwrap();
        assert!(reminders().is_empty(), "too early");
        due_today_reminders(&e.core, nine).unwrap();
        let queued = reminders();
        assert_eq!(queued.len(), 1);
        let job = &queued[0];
        assert_eq!(job.kind, "notification");
        assert_eq!(job.key, format!("tasks_due:{today}"));
        assert_eq!(job.workspace_id.as_deref(), Some("personal"));
        assert_eq!(job.state, "queued");
        assert_eq!(job.payload["title"], "2 tasks due today");
        assert_eq!(job.payload["route"], "tasks");
        assert_eq!(job.payload["body"], "Task mine · Task by-address");
        // Shown by the end of the day or not at all.
        assert_eq!(job.payload["expiresAt"], nine + 15 * 3600);
        // Later rounds the same day add nothing.
        due_today_reminders(&e.core, nine + 1800).unwrap();
        due_today_reminders(&e.core, nine + 6 * 3600).unwrap();
        assert_eq!(reminders().len(), 1);
        let settings = |f: &dyn Fn(&mut Settings)| {
            let mut r = e.core.repo().unwrap();
            let mut s = r.settings().unwrap();
            f(&mut s);
            r.settings_update(&s).unwrap();
        };
        // 19 Nov: two of mine due. Off at 09:00, notifications off at 10:00: nothing, and the day
        // stays open, so turning them on at 11:00 still reminds, once.
        save(&e.core, json!({"id": "mine", "due": "2026-11-19"}), NOW).unwrap();
        let day2 = nine + 86_400;
        settings(&|s| s.meetings.remind = false);
        due_today_reminders(&e.core, day2).unwrap();
        settings(&|s| {
            s.meetings.remind = true;
            s.notifications = false;
        });
        due_today_reminders(&e.core, day2 + 3600).unwrap();
        assert_eq!(reminders().len(), 1);
        settings(&|s| s.notifications = true);
        due_today_reminders(&e.core, day2 + 2 * 3600).unwrap();
        due_today_reminders(&e.core, day2 + 3 * 3600).unwrap();
        let keys: Vec<String> = reminders().into_iter().map(|j| j.key).collect();
        assert_eq!(keys.len(), 2, "{keys:?}");
        assert!(
            keys.contains(&"tasks_due:2026-11-19".to_string()),
            "{keys:?}"
        );
        // 20 Nov: nothing due at 09:00. A task made due today at 15:00 brings no notification.
        let day3 = nine + 2 * 86_400;
        due_today_reminders(&e.core, day3).unwrap();
        save(
            &e.core,
            json!({"id": "mine", "due": "2026-11-20"}),
            day3 + 6 * 3600,
        )
        .unwrap();
        due_today_reminders(&e.core, day3 + 6 * 3600).unwrap();
        due_today_reminders(&e.core, day3 + 14 * 3600).unwrap();
        assert_eq!(reminders().len(), 2, "the day was decided at 09:00");
    }

    /// The task records and the `task_delete` answer the UI (board, drawer, Undo) builds on.
    /// Regenerate with `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
    #[tokio::test]
    async fn contract_fixtures_match_the_real_tasks() {
        let e = env();
        let at = 1_795_000_000;
        // Found in a meeting's notes, owner unsure.
        save(
            &e.core,
            json!({"id": "task-review", "text": "Move the recurring-meeting sync bug to 2.5",
                "status": "review", "owner": "priya.n@example.test", "ownerName": "Priya Natarajan",
                "due": "2026-11-20", "meetingId": "m-downloaded", "line": 3,
                "quote": "Priya, can you take the recurring sync bug into 2.5?", "quoteAt": 173.0,
                "speaker": "Jordan Lee", "confidence": "low", "order": 1.0,
                "log": "Found in the notes (Meeting notes)"}),
            at,
        )
        .unwrap();
        // Added by hand, moved along, owner and date changed.
        save(
            &e.core,
            json!({"id": "task-doing", "text": "Prepare the export demo for the Philips sync",
                "owner": "You", "order": 2.0}),
            at,
        )
        .unwrap();
        save(
            &e.core,
            json!({"id": "task-doing", "status": "doing"}),
            at + 60,
        )
        .unwrap();
        save(
            &e.core,
            json!({"id": "task-doing", "owner": "taylor@example.test", "ownerName": "Taylor Morgan",
                "due": "2026-11-18", "notes": "Use the staging tenant."}),
            at + 120,
        )
        .unwrap();
        // Done.
        save(
            &e.core,
            json!({"id": "task-done", "text": "Book a room for demo day", "owner": "You", "order": 3.0}),
            at,
        )
        .unwrap();
        save(
            &e.core,
            json!({"id": "task-done", "status": "done"}),
            at + 300,
        )
        .unwrap();
        let mut records = Vec::new();
        for (i, id) in ["task-review", "task-doing", "task-done"]
            .into_iter()
            .enumerate()
        {
            let record = e
                .core
                .repo()
                .unwrap()
                .record(KIND, id, None, Some("personal"))
                .unwrap();
            let mut v = serde_json::to_value(&record).unwrap();
            v["revision"] = format!("rev-{i}").into();
            records.push(v);
        }
        assert_eq!(records[0]["data"]["status"], "review");
        assert_eq!(records[2]["data"]["done"], true);
        let deleted = op(&e.core, Operation::TaskDelete, json!({"id": "task-done"}))
            .await
            .unwrap();
        crate::plugins::testkit::contract_fixture("task-records.json", &Value::Array(records));
        crate::plugins::testkit::contract_fixture("task-delete.json", &deleted);
    }
}
