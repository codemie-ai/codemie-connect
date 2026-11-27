//! The merge rule (design §4, ruling 3): three-way, per field, against `remote.base`, the
//! provider's last-seen fields.
//! - Only the provider changed a field: its value.
//! - Only Connect changed it: Connect's (an outbox entry carries it).
//! - Both changed it: the later change by time, Connect's edit time against the provider's
//!   `updatedAt`; when the provider's won, the history says so.
//! - Done or reopened in the provider wins over an edit (the edit's other fields stay).
//! - The `waiting` label removed in the provider moves the task out of Waiting: it becomes the
//!   user's own, with a history line.
//!
//! Deleted in the provider wins over everything; the sync job removes such a record before any
//! merge.
use super::wire;
use serde_json::Value;

/// How a history line names a field (design § Copy "History lines").
fn label(field: &str) -> Option<&'static str> {
    match field {
        "text" => Some("text"),
        "notes" => Some("notes"),
        "due" => Some("due date"),
        "owner" => Some("owner"),
        _ => None,
    }
}

/// When `updatedAt` (RFC 3339) was, in seconds; 0 when the provider didn't say.
fn updated_at(remote: &Value) -> i64 {
    remote["updatedAt"]
        .as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map_or(0, |t| t.timestamp())
}

/// Merges the provider's task `remote` (wire shape) into the task body `local`, edited in Connect
/// at `edited_at`. Returns the new body (its `remote` updated, `syncedAt` kept for the caller to
/// set) and the history lines to add.
pub(crate) fn merge(local: &Value, remote: &Value, edited_at: i64) -> (Value, Vec<String>) {
    let mine = wire::fields(local);
    let theirs = wire::remote_fields(remote);
    let base = match &local["remote"]["base"] {
        b @ Value::Object(_) => b.clone(),
        // Never seen from the provider: nothing it changed is known, so Connect's stands.
        _ => theirs.clone(),
    };
    let remote_at = updated_at(remote);
    let mut merged = mine.clone();
    let mut history = Vec::new();
    for field in wire::FIELDS {
        let (l, b, r) = (&mine[field], &base[field], &theirs[field]);
        if r == b || l == r {
            continue;
        }
        if field == "done" {
            // Done or reopened in the provider wins over an edit of the same task.
            merged[field] = r.clone();
            history.push(
                if r == true {
                    "Done in Todoist"
                } else {
                    "Reopened in Todoist"
                }
                .to_string(),
            );
            continue;
        }
        if l == b {
            merged[field] = r.clone();
        } else if remote_at > edited_at {
            merged[field] = r.clone();
            if let Some(name) = label(field) {
                history.push(format!("Todoist had a newer {name}; Connect kept it."));
            }
        }
    }
    // The `waiting` label removed in the provider: it says the task is no longer someone
    // else's, so it leaves Waiting and is the user's own again, whatever owner line remains.
    let unwaited = base["kind"] == "waiting" && theirs["kind"] != "waiting";
    if unwaited && mine["kind"] == "waiting" {
        merged["kind"] = theirs["kind"].clone();
        merged["owner"] = Value::Null;
        history.push("Waiting label removed in Todoist".to_string());
    }
    let mut body = local.clone();
    let done_at = if remote_at > 0 { remote_at } else { edited_at };
    wire::apply_fields(&mut body, &merged, done_at);
    if unwaited && body["status"] == "waiting" {
        body["status"] = "todo".into();
    }
    let synced_at = local["remote"]["syncedAt"].as_i64();
    body["remote"] = wire::remote_of(remote, synced_at);
    (body, history)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(t: i64) -> String {
        chrono::DateTime::from_timestamp(t, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    /// A Connect task synced at `base`, then changed here to `local_fields`.
    fn local(text: &str, due: &str, done: bool) -> Value {
        json!({"text": text, "due": due, "status": if done {"done"} else {"todo"}, "done": done,
            "provider": "plugin:todoist", "key": "k",
            "remote": {"id": "8124", "labels": ["connect"], "updatedAt": at(50),
                "base": {"text": "A", "notes": null, "due": "2026-11-20", "done": false,
                         "kind": "task", "owner": null}, "syncedAt": 60}})
    }

    fn remote(text: &str, due: &str, done: bool, t: i64) -> Value {
        json!({"id": "8124", "key": "k", "text": text, "due": due, "done": done,
            "labels": ["connect"], "updatedAt": at(t)})
    }

    #[test]
    fn merge_keeps_both_sides_and_the_later_edit_of_one_field() {
        // Connect moved the due date at t=200; Todoist changed the text at t=100.
        let (body, history) = merge(
            &local("A", "2026-11-21", false),
            &remote("B", "2026-11-20", false, 100),
            200,
        );
        assert_eq!(body["text"], "B");
        assert_eq!(body["due"], "2026-11-21");
        assert!(history.is_empty(), "{history:?}");
        assert_eq!(body["remote"]["base"]["text"], "B");
        assert_eq!(body["remote"]["syncedAt"], 60);

        // Both changed the due date: Todoist's is later, so it wins and the history says so.
        let (body, history) = merge(
            &local("A", "2026-11-21", false),
            &remote("A", "2026-11-25", false, 300),
            200,
        );
        assert_eq!(body["due"], "2026-11-25");
        assert_eq!(
            history,
            vec!["Todoist had a newer due date; Connect kept it."]
        );
        // Connect's is later: Connect's stays, nothing to say.
        let (body, history) = merge(
            &local("A", "2026-11-21", false),
            &remote("A", "2026-11-25", false, 150),
            200,
        );
        assert_eq!(body["due"], "2026-11-21");
        assert!(history.is_empty());
    }

    #[test]
    fn done_beats_an_edit_and_a_delete_beats_everything() {
        // Connect edited the text at t=200; Todoist closed the task earlier, at t=100.
        let (body, history) = merge(
            &local("A, edited", "2026-11-20", false),
            &remote("A", "2026-11-20", true, 100),
            200,
        );
        assert_eq!(body["status"], "done");
        assert_eq!(body["done"], true);
        assert_eq!(body["doneAt"], 100);
        assert_eq!(body["text"], "A, edited", "the edit's other fields stay");
        assert_eq!(history, vec!["Done in Todoist"]);
        // Reopened in Todoist after Connect saw it done.
        let mut done = local("A", "2026-11-20", true);
        done["remote"]["base"]["done"] = json!(true);
        let (body, history) = merge(&done, &remote("A", "2026-11-20", false, 300), 200);
        assert_eq!(body["status"], "todo");
        assert_eq!(body["doneAt"], Value::Null);
        assert_eq!(history, vec!["Reopened in Todoist"]);
        // Deleted in Todoist beats everything: the sync job removes the record before merging
        // (`sync::tests::pull_adds_updates_and_removes`).
    }
}
