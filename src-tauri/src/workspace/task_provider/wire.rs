//! A task between the core and a provider (design §5 "The wire shape"): `to_wire` turns a task
//! record into what a provider's `create` / `update` take, `from_wire` turns a provider's task
//! into a new record's body, and `fields` is the part both sides own and the merge compares
//! (`{text, notes, due, done, kind, owner}`, the shape of `remote.base`).
use super::keys;
use crate::workspace::models::Record;
use serde_json::{json, Value};

/// The kinds a task can be (design §1); `task` is the default.
const KINDS: [&str; 4] = ["task", "reply", "waiting", "budget"];
/// The fields of [`fields`], in the order the merge walks them.
pub(crate) const FIELDS: [&str; 6] = ["text", "notes", "due", "done", "kind", "owner"];

fn text_of(v: &Value) -> Value {
    v.as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map_or(Value::Null, Value::from)
}

/// A task's kind as a provider sees it: its own kind, `waiting` for a task in the Waiting column
/// (design ruling 5), else `task`. A done task keeps the kind the provider last had, so
/// completing a Waiting task never sends a kind change that would drop its label.
fn kind_of(body: &Value) -> &str {
    let last_seen = || {
        body["remote"]["base"]["kind"]
            .as_str()
            .filter(|k| KINDS.contains(k))
    };
    match body["kind"].as_str().filter(|k| KINDS.contains(k)) {
        Some(k) if k != "task" => k,
        _ if body["status"] == "waiting" => "waiting",
        _ if body["status"] == "done" => last_seen().unwrap_or("task"),
        _ => "task",
    }
}

/// A task's owner on the wire: `null` for nobody or "You", else `{name, address}`.
fn owner_of(body: &Value) -> Value {
    let Some(owner) = body["owner"]
        .as_str()
        .map(str::trim)
        .filter(|o| !o.is_empty() && !o.eq_ignore_ascii_case("you"))
    else {
        return Value::Null;
    };
    let address = owner.contains('@').then_some(owner);
    let name = text_of(&body["ownerName"])
        .as_str()
        .map(str::to_string)
        .or_else(|| address.is_none().then(|| owner.to_string()));
    json!({"name": name, "address": address})
}

/// The notes a provider holds: the task's notes, or for a task found in notes with none, the
/// quote and who said it (design ruling 5 "quote → the description text").
fn notes_of(body: &Value) -> Value {
    if let notes @ Value::String(_) = text_of(&body["notes"]) {
        return notes;
    }
    match (
        text_of(&body["quote"]).as_str(),
        text_of(&body["speaker"]).as_str(),
    ) {
        (Some(quote), Some(speaker)) => format!("“{quote}” — {speaker}").into(),
        (Some(quote), None) => format!("“{quote}”").into(),
        _ => Value::Null,
    }
}

/// The fields a task's body holds that a provider holds too (`remote.base`'s shape).
pub(crate) fn fields(body: &Value) -> Value {
    json!({
        "text": text_of(&body["text"]),
        "notes": notes_of(body),
        "due": text_of(&body["due"]),
        "done": crate::workspace::tasks::status_of(body) == "done",
        "kind": kind_of(body),
        "owner": owner_of(body),
    })
}

/// The same fields of a provider's task.
pub(crate) fn remote_fields(v: &Value) -> Value {
    let owner = match &v["owner"] {
        Value::Object(o) if o.values().any(|x| !x.is_null()) => json!({
            "name": text_of(&o.get("name").cloned().unwrap_or_default()),
            "address": text_of(&o.get("address").cloned().unwrap_or_default()),
        }),
        _ => Value::Null,
    };
    json!({
        "text": text_of(&v["text"]),
        "notes": text_of(&v["notes"]),
        "due": text_of(&v["due"]),
        "done": v["done"] == true,
        "kind": remote_kind(v),
        "owner": owner,
    })
}

/// A provider task's kind: from its labels first (`budget`, `reply`, `waiting`), else the kind
/// it says, else `task`.
fn remote_kind(v: &Value) -> &str {
    let labels: Vec<&str> = v["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    ["budget", "reply", "waiting"]
        .into_iter()
        .find(|k| labels.contains(k))
        .or_else(|| v["kind"].as_str().filter(|k| KINDS.contains(k)))
        .unwrap_or("task")
}

/// The task as a provider takes it (design §5).
pub(crate) fn to_wire(task: &Record) -> Value {
    let d = &task.data;
    let mut wire = fields(d);
    let remote = &d["remote"];
    wire["id"] = remote["id"].clone();
    wire["key"] = d["key"].clone();
    wire["source"] = text_of(&d["sourceUrl"]);
    wire["meetingId"] = text_of(&d["meetingId"]);
    wire["url"] = remote["url"].clone();
    wire["labels"] = remote["labels"]
        .as_array()
        .cloned()
        .map_or_else(|| json!([]), Value::Array);
    wire["updatedAt"] = remote["updatedAt"].clone();
    wire
}

/// `remote` as a record keeps it: `{id, url, labels, updatedAt, base, syncedAt}`.
pub(crate) fn remote_of(v: &Value, synced_at: Option<i64>) -> Value {
    json!({
        "id": v["id"].as_str().map(str::to_string).or_else(|| v["id"].as_i64().map(|n| n.to_string())),
        "url": text_of(&v["url"]),
        "labels": v["labels"].as_array().cloned().unwrap_or_default(),
        "updatedAt": text_of(&v["updatedAt"]),
        "base": remote_fields(v),
        "syncedAt": synced_at,
    })
}

/// Writes `fields` (as [`fields`] shapes them) into a task's `body`; `at` is when a task done
/// here was done.
pub(crate) fn apply_fields(body: &mut Value, f: &Value, at: i64) {
    body["text"] = f["text"].clone();
    body["notes"] = f["notes"].clone();
    body["due"] = f["due"].clone();
    let kind = f["kind"].as_str().unwrap_or("task");
    if kind != kind_of(body) {
        body["kind"] = kind.into();
    }
    if f["owner"] != owner_of(body) {
        let o = &f["owner"];
        body["owner"] = o["address"].clone();
        if body["owner"].is_null() {
            body["owner"] = o["name"].clone();
        }
        body["ownerName"] = o["name"].clone();
    }
    let done = f["done"] == true;
    if done != (crate::workspace::tasks::status_of(body) == "done") {
        body["status"] = if done {
            "done"
        } else if kind == "waiting" {
            "waiting"
        } else {
            "todo"
        }
        .into();
        body["done"] = done.into();
        body["doneAt"] = if done { at.into() } else { Value::Null };
    }
}

/// A new record's body for a provider's task Connect didn't know (design §4 "Pull"): stamped
/// with `provider`, its key from the key line or `remote:<id>` hashed.
pub(crate) fn from_wire(v: &Value, provider: &str) -> Value {
    let remote = remote_of(v, None);
    let f = &remote["base"];
    let id = remote["id"].as_str().unwrap_or_default().to_string();
    let key = v["key"]
        .as_str()
        .filter(|k| !k.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            keys::task_key(&format!("remote:{id}"), f["text"].as_str().unwrap_or(""))
        });
    let mut body = json!({
        "text": Value::Null, "owner": Value::Null, "ownerName": Value::Null, "status": "todo",
        "done": false, "doneAt": Value::Null, "meetingId": text_of(&v["meetingId"]),
        "sourceUrl": text_of(&v["source"]), "provider": provider, "key": key, "history": [],
    });
    apply_fields(&mut body, f, 0);
    if f["kind"] == "waiting" && body["status"] == "todo" {
        body["status"] = "waiting".into();
    }
    body["remote"] = remote;
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(data: Value) -> Record {
        Record {
            id: "t1".into(),
            kind: "commitment".into(),
            connection_id: None,
            workspace_id: Some("personal".into()),
            source: "local".into(),
            revision: "r".into(),
            updated_at: 0,
            data,
        }
    }

    #[test]
    fn a_task_and_its_wire_shape_go_both_ways() {
        let task = record(
            json!({"text": "Send the pilot user list", "status": "waiting",
            "owner": "marek.novak@example.test", "ownerName": "Marek Novak", "due": "2026-11-20",
            "quote": "I'll send you the names by Friday.", "speaker": "Marek Novak",
            "meetingId": "mtg-philips", "key": "3f2a9c01d4e5b6a7",
            "remote": {"id": "8124", "labels": ["waiting", "connect", "q4"]}}),
        );
        let wire = to_wire(&task);
        assert_eq!(wire["id"], "8124");
        assert_eq!(wire["kind"], "waiting");
        assert_eq!(
            wire["owner"],
            json!({"name": "Marek Novak", "address": "marek.novak@example.test"})
        );
        assert_eq!(
            wire["notes"],
            "“I'll send you the names by Friday.” — Marek Novak"
        );
        assert_eq!(wire["labels"], json!(["waiting", "connect", "q4"]));
        assert_eq!(wire["done"], false);
        // My own task carries no owner.
        let mine = to_wire(&record(json!({"text": "x", "owner": "You"})));
        assert_eq!(mine["owner"], Value::Null);
        assert_eq!(mine["kind"], "task");

        let body = from_wire(&wire, "plugin:todoist");
        assert_eq!(body["provider"], "plugin:todoist");
        assert_eq!(body["key"], "3f2a9c01d4e5b6a7");
        assert_eq!(body["status"], "waiting");
        assert_eq!(body["kind"], "waiting");
        assert_eq!(body["owner"], "marek.novak@example.test");
        assert_eq!(body["remote"]["id"], "8124");
        assert_eq!(fields(&body), body["remote"]["base"]);
        // No key line: the remote id, hashed.
        let unkeyed = from_wire(
            &json!({"id": "9", "text": "Added in Todoist", "labels": ["reply"]}),
            "plugin:todoist",
        );
        assert_eq!(
            unkeyed["key"],
            keys::task_key("remote:9", "Added in Todoist")
        );
        assert_eq!(unkeyed["kind"], "reply");
    }
}
