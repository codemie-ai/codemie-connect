//! Reads by revision: what changed after a snapshot the window holds (`changes_since`), from the
//! change log the repository's triggers keep (repository.rs `CHANGE_LOG`). The delta carries the
//! changed records as the snapshot would show them, the keys that went, the changed jobs, and the
//! small parts a snapshot always has; or `{"reset": true}` when it can't be trusted.

use super::{
    ai_jobs, inbox, meetings,
    models::*,
    prompts,
    repository::{job_shown, scope_hash_of, ChangeRow, RecordKey, Repository},
    Core,
};
use serde_json::{json, Value};
use std::collections::HashSet;

/// Kinds the Inbox projection reads across a conversation: a change to one sends its whole
/// conversation's messages and summaries again, projected.
const INBOX: [&str; 4] = ["message", "decision", "incident", "summary"];

/// The conversations (`conversationId`, "" for none, as `inbox::project` groups them) that
/// changed inbox rows touch, and the summary keys they name; `None` when one can't be told (an
/// incident gone): the window then reads the whole snapshot.
fn touched(
    repo: &Repository,
    all: &[Record],
    rows: &[&ChangeRow],
    cid: &str,
) -> Result<Option<(HashSet<String>, HashSet<String>)>> {
    let conversation_of = |id: &str| {
        all.iter()
            .find(|m| m.kind == "message" && m.id == id)
            .map(|m| m.data["conversationId"].as_str().unwrap_or("").to_string())
    };
    let mut convs = HashSet::new();
    let mut summaries = HashSet::new();
    for row in rows {
        match row.kind.as_str() {
            "message" => {
                convs.insert(row.conversation.clone().unwrap_or_default());
            }
            // A decision is named by its message.
            "decision" => convs.extend(conversation_of(&row.id)),
            "incident" => {
                if row.deleted {
                    return Ok(None);
                }
                let Ok(incident) = repo.record("incident", &row.id, Some(cid), None) else {
                    return Ok(None);
                };
                convs.extend(incident.data["itemId"].as_str().and_then(conversation_of));
            }
            "summary" => {
                if let Some(key) = all
                    .iter()
                    .find(|r| r.kind == "summary" && r.id == row.id)
                    .and_then(|r| r.data["conversationKey"].as_str())
                {
                    summaries.insert(key.to_string());
                    convs.extend(
                        all.iter()
                            .filter(|m| m.kind == "message" && prompts::conversation_key(m) == key)
                            .map(|m| m.data["conversationId"].as_str().unwrap_or("").to_string()),
                    );
                }
            }
            _ => {}
        }
    }
    Ok(Some((convs, summaries)))
}

/// More changed records than this: the window reads the whole snapshot instead.
const MAX_RECORDS: usize = 2000;
/// Kinds that re-project every message (the critical rules, the chat catalog): one changed
/// resets.
const RESETTING: [&str; 2] = ["rule", "catalog"];

fn key_of(c: &ChangeRow) -> RecordKey {
    RecordKey {
        kind: c.kind.clone(),
        id: c.id.clone(),
        connection_id: c.connection_id.clone(),
        workspace_id: c.workspace_id.clone(),
    }
}

pub(super) fn record_key(r: &Record) -> RecordKey {
    RecordKey {
        kind: r.kind.clone(),
        id: r.id.clone(),
        connection_id: r.connection_id.clone().unwrap_or_default(),
        workspace_id: r.workspace_id.clone().unwrap_or_default(),
    }
}

fn none_if_empty(s: &str) -> Value {
    if s.is_empty() {
        Value::Null
    } else {
        s.into()
    }
}

/// A transcript check that found nothing: the snapshot leaves it out of its jobs.
fn quiet_check(j: &Job) -> bool {
    j.state == "succeeded" && j.kind == "transcript_check"
}

impl Core {
    /// `changes_since {revision, scope}`: what changed after the snapshot at `revision`, read
    /// in `scope` (the snapshot answer's hash), or `{"reset": true}`: another scope, a revision
    /// the log no longer reaches (or newer than native's), a rule or the chat catalog changed,
    /// or more than [`MAX_RECORDS`] records changed. Changed records come as the snapshot
    /// shows them; keys that went (or aren't shown) in `removed`; the automation runs whole
    /// (`replace`); changed jobs, and the whole list (`jobsAll`) when one went, so the window
    /// keeps the newest 300 as native does.
    pub(super) async fn changes_since(&self, req: &Request) -> Result<Value> {
        let since = req.data["revision"].as_i64().ok_or_else(|| {
            WorkspaceError::new("validation", "Say which revision the window holds.")
        })?;
        let given = req.data["scope"].as_str().unwrap_or("");
        let mut delta = {
            let repo = self.repo()?;
            // The revision first, as the snapshot reads it: a write landing meanwhile comes again.
            let revision = repo.revision()?;
            let scope = repo.snapshot_scope()?;
            let hash = scope_hash_of(&scope);
            if given != hash || since < repo.changes_from()? || since > revision {
                return Ok(json!({"reset": true}));
            }
            let rows = repo.changes_since_rows(since)?;
            let (record_rows, job_rows): (Vec<&ChangeRow>, Vec<&ChangeRow>) =
                rows.iter().partition(|c| c.tbl == "record");
            if record_rows.len() > MAX_RECORDS
                || record_rows
                    .iter()
                    .any(|c| RESETTING.contains(&c.kind.as_str()))
            {
                return Ok(json!({"reset": true}));
            }
            let cid = scope
                .visible
                .as_ref()
                .map(|c| c.id.as_str())
                .unwrap_or("__unavailable__");
            let runs = record_rows.iter().any(|c| c.kind == "automation_run");
            let keys: Vec<RecordKey> = record_rows
                .iter()
                .filter(|c| c.kind != "automation_run")
                .map(|c| key_of(c))
                .collect();
            // Messages and summaries come projected with their conversations, below.
            let direct: Vec<RecordKey> = keys
                .iter()
                .filter(|k| k.kind != "message" && k.kind != "summary")
                .cloned()
                .collect();
            let mut records = if direct.is_empty() && !runs {
                Vec::new()
            } else {
                repo.visible_records_in(&scope, Some(&direct), runs)?
            };
            let inbox_rows: Vec<&ChangeRow> = record_rows
                .iter()
                .copied()
                .filter(|c| INBOX.contains(&c.kind.as_str()))
                .collect();
            if !inbox_rows.is_empty() {
                // Projected as the snapshot projects them: across every conversation's messages,
                // with the decisions and the chat catalog.
                let mut all = repo.visible_records_of_kinds(
                    &scope,
                    &["message", "summary", "decision", "catalog"],
                )?;
                inbox::project(&repo, &scope.active, scope.visible.as_ref(), &mut all)?;
                ai_jobs::mark_stale_summaries(&mut all);
                let Some((convs, mut summary_keys)) = touched(&repo, &all, &inbox_rows, cid)?
                else {
                    return Ok(json!({"reset": true}));
                };
                summary_keys.extend(
                    all.iter()
                        .filter(|m| {
                            m.kind == "message"
                                && convs.contains(m.data["conversationId"].as_str().unwrap_or(""))
                        })
                        .map(prompts::conversation_key),
                );
                records.extend(all.into_iter().filter(|r| {
                    match r.kind.as_str() {
                        "message" => {
                            convs.contains(r.data["conversationId"].as_str().unwrap_or(""))
                        }
                        "summary" => r.data["conversationKey"]
                            .as_str()
                            .is_some_and(|k| summary_keys.contains(k)),
                        _ => false,
                    }
                }));
            }
            let shown: HashSet<RecordKey> = records.iter().map(record_key).collect();
            let removed: Vec<Value> = keys
                .iter()
                .filter(|k| !shown.contains(k))
                .map(|k| {
                    json!({"kind": k.kind, "id": k.id, "connectionId": none_if_empty(&k.connection_id),
                        "workspaceId": none_if_empty(&k.workspace_id)})
                })
                .collect();
            let changed: Vec<&str> = job_rows.iter().map(|c| c.id.as_str()).collect();
            let found = repo.jobs_by_id(&changed)?;
            let mut jobs = Vec::new();
            let mut removed_jobs = Vec::new();
            for id in changed {
                match found.iter().find(|j| j.id == id) {
                    Some(j) if job_shown(j, &scope.active.id, cid) && !quiet_check(j) => {
                        jobs.push(j.clone())
                    }
                    _ => removed_jobs.push(id.to_string()),
                }
            }
            let all = !removed_jobs.is_empty();
            if all {
                jobs = repo.snapshot_jobs(&scope)?;
            }
            let templates = meetings::templates::all(
                &repo.local_records(&scope.active.id, meetings::templates::KIND)?,
            );
            json!({
                "reset": false, "revision": revision, "scope": hash,
                "records": records, "removed": removed,
                "replace": if runs { json!(["automation_run"]) } else { json!([]) },
                "jobs": jobs, "removedJobs": removed_jobs, "jobsAll": all,
                "settings": scope.settings, "workspaces": scope.workspaces,
                "connection": scope.connection, "available": scope.visible.is_some(),
                "noteTemplates": templates,
            })
        };
        let settings = self.repo()?.settings()?;
        delta["meetingsRoot"] = json!(self.shown_meetings_root(&settings.meetings));
        delta["authPending"] = self.auth_attempt.lock().await.is_some().into();
        delta["authError"] = json!(self.auth_error.lock().await.clone());
        Ok(delta)
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::ai::fake::FakeRunner;
    use serde_json::{json, Value};
    use std::sync::Arc;

    const ACCT: &str = "acct-1";

    fn core() -> (tempfile::TempDir, Arc<Core>) {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(
            dir.path(),
            Arc::new(FakeRunner::new(vec![])),
            ai::tests::ready(),
        );
        (dir, core)
    }

    /// Signs in with mail and chats, the mail and chat `chat-a` selected.
    fn connect(core: &Core) {
        let mut r = core.repo().unwrap();
        let c = Connection {
            id: ACCT.into(),
            account_key: ACCT.into(),
            display_name: "Taylor Morgan".into(),
            email: "taylor@example.test".into(),
            user_id: "me-1".into(),
            generation: 1,
            policy_revision: 1,
            scopes: vec![
                "Mail.Read".into(),
                "Chat.Read".into(),
                "Calendars.Read".into(),
            ],
            enabled: vec!["mail".into(), "chats".into(), "calendar".into()],
            status: "connected".into(),
            ..Default::default()
        };
        r.save_connection(&c).unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some(ACCT.into());
        r.settings_update(&s).unwrap();
        let mut w = r.workspace("personal").unwrap();
        w.connection_id = Some(ACCT.into());
        w.sources = json!({"mail": true, "chats": ["chat-a"], "calendars": ["cal-1"]});
        r.save_workspace(&w).unwrap();
    }

    fn read(op: Operation, data: Value) -> Request {
        Request {
            op,
            workspace_id: Some("personal".into()),
            expected_revision: None,
            operation_id: None,
            data,
        }
    }

    async fn write(core: &Arc<Core>, op: Operation, data: Value) -> Value {
        let revision = core.repo().unwrap().revision().unwrap();
        core.request(Request {
            op,
            workspace_id: Some("personal".into()),
            expected_revision: Some(revision),
            operation_id: Some(id()),
            data,
        })
        .await
        .unwrap()
    }

    async fn snapshot(core: &Arc<Core>) -> Value {
        core.request(read(Operation::Snapshot, json!({})))
            .await
            .unwrap()
    }

    async fn since(core: &Arc<Core>, from: &Value) -> Value {
        core.request(read(
            Operation::ChangesSince,
            json!({"revision": from["snapshot"]["revision"], "scope": from["scope"]}),
        ))
        .await
        .unwrap()
    }

    fn put(core: &Core, record: Record) {
        core.repo().unwrap().put_record(&record).unwrap();
    }

    fn provider(id: &str, kind: &str, source: &str, data: Value) -> Record {
        Record {
            id: id.into(),
            kind: kind.into(),
            connection_id: Some(ACCT.into()),
            workspace_id: None,
            source: source.into(),
            revision: "v1".into(),
            updated_at: now(),
            data,
        }
    }

    fn ids(delta: &Value, field: &str) -> Vec<String> {
        delta[field]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                r["id"]
                    .as_str()
                    .unwrap_or_else(|| r.as_str().unwrap())
                    .to_string()
            })
            .collect()
    }

    #[tokio::test]
    async fn a_delta_carries_the_changed_task_and_nothing_else() {
        let (_dir, core) = core();
        connect(&core);
        write(
            &core,
            Operation::LocalSave,
            json!({"kind": "commitment", "text": "Old task", "status": "todo"}),
        )
        .await;
        let before = snapshot(&core).await;
        let saved = write(
            &core,
            Operation::LocalSave,
            json!({"kind": "commitment", "text": "Ship it", "status": "todo"}),
        )
        .await;
        let delta = since(&core, &before).await;
        assert_eq!(delta["reset"], false, "{delta}");
        assert_eq!(ids(&delta, "records"), [saved["id"].as_str().unwrap()]);
        assert_eq!(delta["records"][0]["data"]["text"], "Ship it");
        assert!(delta["removed"].as_array().unwrap().is_empty());
        assert_eq!(delta["revision"], core.repo().unwrap().revision().unwrap());
        // The small parts every snapshot has come along.
        for field in [
            "settings",
            "workspaces",
            "connection",
            "available",
            "noteTemplates",
            "authPending",
            "scope",
        ] {
            assert!(delta.get(field).is_some(), "{field} missing");
        }
        // Nothing since: an empty delta at the same revision.
        let after = snapshot(&core).await;
        let none = since(&core, &after).await;
        assert!(none["records"].as_array().unwrap().is_empty());
        assert_eq!(none["revision"], after["snapshot"]["revision"]);
    }

    #[tokio::test]
    async fn a_deleted_task_comes_as_removed() {
        let (_dir, core) = core();
        connect(&core);
        let saved = write(
            &core,
            Operation::LocalSave,
            json!({"kind": "commitment", "text": "Gone soon", "status": "todo"}),
        )
        .await;
        let id = saved["id"].as_str().unwrap().to_string();
        let before = snapshot(&core).await;
        write(
            &core,
            Operation::LocalDelete,
            json!({"kind": "commitment", "id": id}),
        )
        .await;
        let delta = since(&core, &before).await;
        assert!(delta["records"].as_array().unwrap().is_empty(), "{delta}");
        assert_eq!(
            delta["removed"],
            json!([{"kind": "commitment", "id": id, "connectionId": null, "workspaceId": "personal"}])
        );
    }

    #[tokio::test]
    async fn a_record_outside_the_selected_sources_is_not_sent() {
        let (_dir, core) = core();
        connect(&core);
        let before = snapshot(&core).await;
        put(
            &core,
            provider(
                "m-b",
                "message",
                "chat:chat-b",
                json!({"text": "not selected", "conversationId": "chat-b", "at": 1}),
            ),
        );
        put(
            &core,
            provider(
                "m-a",
                "message",
                "chat:chat-a",
                json!({"text": "selected", "conversationId": "chat-a", "at": 2}),
            ),
        );
        let delta = since(&core, &before).await;
        assert_eq!(ids(&delta, "records"), ["m-a"]);
        // As the snapshot projects it.
        assert!(delta["records"][0]["data"]["lane"].is_string());
    }

    #[tokio::test]
    async fn another_scope_or_a_pruned_log_resets() {
        let (_dir, core) = core();
        connect(&core);
        let before = snapshot(&core).await;
        let mut other = before.clone();
        other["scope"] = json!("not-this-one");
        assert_eq!(since(&core, &other).await, json!({"reset": true}));
        // Signing out changes the scope too.
        let mut w = core.repo().unwrap().workspace("personal").unwrap();
        w.sources = json!({"all": true});
        core.repo().unwrap().save_workspace(&w).unwrap();
        assert_eq!(since(&core, &before).await, json!({"reset": true}));
        // A log pruned past the window's revision.
        let now_scope = snapshot(&core).await;
        for i in 0..3 {
            write(
                &core,
                Operation::LocalSave,
                json!({"kind": "commitment", "text": format!("t{i}"), "status": "todo"}),
            )
            .await;
        }
        core.repo().unwrap().prune_changes(0, 0, now() + 1).unwrap();
        assert_eq!(since(&core, &now_scope).await, json!({"reset": true}));
    }

    #[tokio::test]
    async fn a_rule_or_catalog_change_resets() {
        let (_dir, core) = core();
        connect(&core);
        let before = snapshot(&core).await;
        write(
            &core,
            Operation::LocalSave,
            json!({"kind": "rule", "text": "critical", "lane": "critical", "keyword": "outage"}),
        )
        .await;
        assert_eq!(since(&core, &before).await, json!({"reset": true}));
        let before = snapshot(&core).await;
        put(
            &core,
            provider("chats", "catalog", "catalog", json!({"values": []})),
        );
        assert_eq!(since(&core, &before).await, json!({"reset": true}));
    }

    /// A mail message of conversation `conv`, from Ann or from me, at `at`.
    fn mail(id: &str, conv: &str, at: i64, mine: bool, text: &str) -> Record {
        provider(
            id,
            "message",
            "mail:inbox",
            json!({
                "conversationId": conv, "at": at, "isMine": mine, "title": "Q3 budget", "text": text,
                "fromAddress": if mine { "taylor@example.test" } else { "ann@example.test" },
                "to": [{"emailAddress": {"address": "taylor@example.test"}}]
            }),
        )
    }

    fn decision(message: &str, data: Value) -> Record {
        Record {
            id: message.into(),
            kind: "decision".into(),
            connection_id: Some(ACCT.into()),
            workspace_id: Some("personal".into()),
            source: "mail:inbox".into(),
            revision: id(),
            updated_at: 1000,
            data,
        }
    }

    fn record<'a>(delta: &'a Value, kind: &str, id: &str) -> &'a Value {
        delta["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == kind && r["id"] == id)
            .unwrap_or_else(|| panic!("{kind} {id} not in {delta}"))
    }
    fn messages(delta: &Value) -> Vec<String> {
        let mut ids: Vec<String> = delta["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["kind"] == "message")
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect();
        ids.sort();
        ids
    }

    /// conv-1: Ann asks, I answer (marked Waiting since 350), Ann writes again at 300.
    fn waiting_thread(core: &Core) {
        put(
            core,
            mail("m1", "conv-1", 100, false, "Can you review the Q3 budget?"),
        );
        put(
            core,
            mail("m2", "conv-1", 200, true, "Sure, which version?"),
        );
        put(
            core,
            mail("m3", "conv-1", 300, false, "The one from Monday."),
        );
        put(
            core,
            decision("m2", json!({"lane": "waiting", "waitingSince": 350})),
        );
    }

    #[tokio::test]
    async fn a_new_reply_moves_the_waiting_conversation_in_the_delta() {
        let (_dir, core) = core();
        connect(&core);
        waiting_thread(&core);
        let before = snapshot(&core).await;
        put(&core, mail("m4", "conv-1", 400, false, "Any news?"));
        let delta = since(&core, &before).await;
        assert_eq!(
            messages(&delta),
            ["m1", "m2", "m3", "m4"],
            "the whole conversation"
        );
        assert_eq!(record(&delta, "message", "m2")["data"]["lane"], "waiting");
        assert_eq!(
            record(&delta, "message", "m2")["data"]["responseSourceId"],
            "m4"
        );
        // As the snapshot after it shows them.
        let after = snapshot(&core).await;
        let snap_m2 = after["snapshot"]["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "m2")
            .unwrap();
        assert_eq!(record(&delta, "message", "m2")["data"], snap_m2["data"]);
    }

    #[tokio::test]
    async fn a_summary_turns_stale_in_the_delta_when_its_conversation_moves() {
        let (_dir, core) = core();
        connect(&core);
        waiting_thread(&core);
        let m3 = core
            .repo()
            .unwrap()
            .record("message", "m3", Some(ACCT), None)
            .unwrap();
        put(
            &core,
            Record {
                id: "sum-1".into(),
                kind: "summary".into(),
                connection_id: Some(ACCT.into()),
                workspace_id: Some("personal".into()),
                source: "mail:inbox".into(),
                revision: id(),
                updated_at: now(),
                data: json!({"conversationKey": prompts::conversation_key(&m3), "latestMessageId": "m3",
                "latestFingerprint": prompts::fingerprint(&m3), "text": "Ann wants a review."}),
            },
        );
        let before = snapshot(&core).await;
        let sum = before["snapshot"]["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "sum-1")
            .unwrap();
        assert_eq!(sum["data"]["stale"], false);
        put(&core, mail("m4", "conv-1", 400, false, "Any news?"));
        let delta = since(&core, &before).await;
        assert_eq!(record(&delta, "summary", "sum-1")["data"]["stale"], true);
    }

    #[tokio::test]
    async fn a_decision_change_reprojects_its_conversation_only() {
        let (_dir, core) = core();
        connect(&core);
        waiting_thread(&core);
        put(&core, mail("m5", "conv-2", 500, false, "Lunch?"));
        let before = snapshot(&core).await;
        put(&core, decision("m1", json!({"lane": "fyi"})));
        let delta = since(&core, &before).await;
        assert_eq!(record(&delta, "message", "m1")["data"]["lane"], "fyi");
        assert_eq!(
            messages(&delta),
            ["m1", "m2", "m3"],
            "another conversation stays"
        );
        // A message gone: its conversation comes again, without it.
        let before = snapshot(&core).await;
        core.repo()
            .unwrap()
            .db_for_tests()
            .execute("DELETE FROM records WHERE kind='message' AND id='m3'", [])
            .unwrap();
        let delta = since(&core, &before).await;
        assert!(
            delta["removed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|k| k["id"] == "m3"),
            "{delta}"
        );
        assert_eq!(messages(&delta), ["m1", "m2"]);
    }

    #[tokio::test]
    async fn jobs_come_as_upserts_and_removals() {
        let (_dir, core) = core();
        connect(&core);
        let before = snapshot(&core).await;
        let mut job = Job {
            id: "job-1".into(),
            kind: "sync".into(),
            key: "job-1".into(),
            state: "queued".into(),
            workspace_id: Some("personal".into()),
            connection_id: Some(ACCT.into()),
            due_at: now(),
            lease_until: None,
            attempts: 0,
            policy: json!({}),
            payload: json!({}),
            result: None,
            error_class: None,
            error_code: None,
        };
        core.repo().unwrap().enqueue(&job).unwrap();
        let delta = since(&core, &before).await;
        assert_eq!(ids(&delta, "jobs"), ["job-1"]);
        assert!(delta["removedJobs"].as_array().unwrap().is_empty());
        assert_ne!(delta["jobsAll"], true);
        // Finished and pruned: removed, and the whole list comes so the window keeps the newest 300.
        let before = snapshot(&core).await;
        job.state = "succeeded".into();
        job.due_at = 1;
        core.repo().unwrap().save_job(&job).unwrap();
        core.repo()
            .unwrap()
            .prune_finished_jobs(&["sync"], now())
            .unwrap();
        let delta = since(&core, &before).await;
        assert_eq!(ids(&delta, "removedJobs"), ["job-1"]);
        assert_eq!(delta["jobsAll"], true);
        assert!(!ids(&delta, "jobs").contains(&"job-1".to_string()));
    }

    // ------------------------------------------------------------ parity with the snapshot

    use std::collections::{BTreeMap, HashSet as Set};

    fn value_key(r: &Value) -> String {
        format!(
            "{}|{}|{}|{}",
            r["kind"].as_str().unwrap(),
            r["id"].as_str().unwrap(),
            r["connectionId"].as_str().unwrap_or(""),
            r["workspaceId"].as_str().unwrap_or("")
        )
    }

    /// The window's `applyChanges` (ui/workspace/changes.js), mirrored: a snapshot answer and a
    /// delta give the next snapshot answer; None on a reset.
    fn apply(before: &Value, delta: &Value) -> Option<Value> {
        if delta["reset"] == true {
            return None;
        }
        let mut snap = before["snapshot"].clone();
        let replace: Vec<&str> = delta["replace"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap())
            .collect();
        let removed: Set<String> = delta["removed"]
            .as_array()
            .unwrap()
            .iter()
            .map(value_key)
            .collect();
        let mut records: BTreeMap<String, Value> = snap["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| {
                !replace.contains(&r["kind"].as_str().unwrap()) && !removed.contains(&value_key(r))
            })
            .map(|r| (value_key(r), r.clone()))
            .collect();
        for r in delta["records"].as_array().unwrap() {
            records.insert(value_key(r), r.clone());
        }
        snap["records"] = Value::Array(records.into_values().collect());
        let mut jobs: BTreeMap<String, Value> = if delta["jobsAll"] == true {
            BTreeMap::new()
        } else {
            snap["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|j| (j["id"].as_str().unwrap().to_string(), j.clone()))
                .collect()
        };
        for id in delta["removedJobs"].as_array().unwrap() {
            jobs.remove(id.as_str().unwrap());
        }
        for j in delta["jobs"].as_array().unwrap() {
            jobs.insert(j["id"].as_str().unwrap().to_string(), j.clone());
        }
        let mut jobs: Vec<Value> = jobs.into_values().collect();
        jobs.sort_by(|a, b| b["dueAt"].as_i64().cmp(&a["dueAt"].as_i64()));
        jobs.truncate(300);
        snap["jobs"] = Value::Array(jobs);
        for field in [
            "settings",
            "workspaces",
            "connection",
            "available",
            "meetingsRoot",
            "noteTemplates",
        ] {
            snap[field] = delta[field].clone();
        }
        snap["revision"] = delta["revision"].clone();
        Some(
            json!({"snapshot": snap, "scope": delta["scope"], "authPending": delta["authPending"], "authError": delta["authError"]}),
        )
    }

    /// Records and jobs in key order, so two answers compare whatever order they came in.
    fn sorted(answer: &Value) -> Value {
        let mut a = answer.clone();
        let mut records = a["snapshot"]["records"].as_array().unwrap().clone();
        records.sort_by_key(value_key);
        a["snapshot"]["records"] = Value::Array(records);
        let mut jobs = a["snapshot"]["jobs"].as_array().unwrap().clone();
        jobs.sort_by_key(|j| j["id"].as_str().unwrap().to_string());
        a["snapshot"]["jobs"] = Value::Array(jobs);
        a
    }

    struct Lcg(u64);
    impl Lcg {
        fn below(&mut self, n: u64) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) % n
        }
    }

    fn job(id: &str, kind: &str, due: i64) -> Job {
        Job {
            id: id.into(),
            kind: kind.into(),
            key: id.into(),
            state: "queued".into(),
            workspace_id: Some("personal".into()),
            connection_id: Some(ACCT.into()),
            due_at: due,
            lease_until: None,
            attempts: 0,
            policy: json!({}),
            payload: json!({"meetingId": "mtg-1"}),
            result: None,
            error_class: None,
            error_code: None,
        }
    }

    fn meeting(id: &str, data: Value) -> Record {
        provider(id, "meeting", "calendar:cal-1", data)
    }

    #[tokio::test]
    async fn a_delta_applied_to_a_snapshot_is_the_next_snapshot() {
        let (_dir, core) = core();
        connect(&core);
        waiting_thread(&core);
        let mut rng = Lcg(7);
        let mut tasks: Vec<String> = Vec::new();
        let mut gone: Vec<String> = Vec::new();
        let mut messages: Vec<String> = vec!["m1".into(), "m2".into(), "m3".into()];
        let mut jobs: Vec<String> = Vec::new();
        let mut base = snapshot(&core).await;
        for step in 0..60 {
            let n = step as i64;
            match rng.below(14) {
                0 | 1 => {
                    let saved = write(&core, Operation::LocalSave, json!({"kind": "commitment", "text": format!("Task {n}"), "status": "todo"})).await;
                    tasks.push(saved["id"].as_str().unwrap().into());
                }
                2 if !tasks.is_empty() => {
                    let id = tasks[rng.below(tasks.len() as u64) as usize].clone();
                    let status = ["doing", "waiting", "done", "todo"][rng.below(4) as usize];
                    write(
                        &core,
                        Operation::LocalSave,
                        json!({"kind": "commitment", "id": id, "status": status}),
                    )
                    .await;
                }
                3 if !tasks.is_empty() => {
                    let id = tasks.remove(rng.below(tasks.len() as u64) as usize);
                    write(
                        &core,
                        Operation::LocalDelete,
                        json!({"kind": "commitment", "id": id}),
                    )
                    .await;
                    gone.push(id);
                }
                4 if !gone.is_empty() => {
                    // Undo of a delete: the same key again.
                    let id = gone.remove(0);
                    write(&core, Operation::LocalSave, json!({"kind": "commitment", "id": id, "text": "Back again", "status": "todo"})).await;
                    tasks.push(id);
                }
                5 => {
                    let template = ["meeting-notes", "short-summary"][rng.below(2) as usize];
                    put(
                        &core,
                        meeting(
                            "mtg-1",
                            json!({"title": "Sync", "state": "downloaded", "template": template, "start": "2026-11-25T10:00:00Z", "end": "2026-11-25T10:30:00Z"}),
                        ),
                    );
                }
                6 => {
                    let id = format!("job-{n}");
                    core.repo()
                        .unwrap()
                        .enqueue(&job(
                            &id,
                            if n % 2 == 0 {
                                "meeting_notes"
                            } else {
                                "transcript_check"
                            },
                            1_795_000_000 + n,
                        ))
                        .unwrap();
                    jobs.push(id);
                }
                7 if !jobs.is_empty() => {
                    let id = jobs[rng.below(jobs.len() as u64) as usize].clone();
                    let mut j = core
                        .repo()
                        .unwrap()
                        .jobs_by_id(&[id.as_str()])
                        .unwrap()
                        .pop()
                        .unwrap();
                    j.state = ["running", "succeeded", "failed"][rng.below(3) as usize].into();
                    core.repo().unwrap().save_job(&j).unwrap();
                }
                8 => {
                    let id = format!("m{}", 10 + n);
                    let conv = format!("conv-{}", 1 + rng.below(3));
                    put(
                        &core,
                        mail(&id, &conv, 1000 + n, rng.below(3) == 0, "Any news?"),
                    );
                    messages.push(id);
                }
                9 => {
                    let id = messages[rng.below(messages.len() as u64) as usize].clone();
                    let lane = ["waiting", "fyi", "reply"][rng.below(3) as usize];
                    put(
                        &core,
                        decision(&id, json!({"lane": lane, "waitingSince": 1000 + n})),
                    );
                }
                10 => {
                    let mut run = Record {
                        id: format!("run-{n}"),
                        kind: "automation_run".into(),
                        connection_id: None,
                        workspace_id: Some("personal".into()),
                        source: "local".into(),
                        revision: id(),
                        updated_at: 1_795_000_000 + n,
                        data: json!({"automationId": format!("auto-{}", rng.below(2)), "startedAt": 1_795_000_000 + n, "delivered": ["today"]}),
                    };
                    if n % 3 == 0 {
                        run.data["delivered"] = json!([]);
                    }
                    put(&core, run);
                }
                11 => {
                    core.repo()
                        .unwrap()
                        .prune_finished_jobs(&["meeting_notes", "transcript_check"], i64::MAX)
                        .unwrap();
                }
                12 => {
                    let mut ai =
                        provider(&format!("ai-{n}"), "ai_run", "local", json!({"cost": 0.01}));
                    ai.connection_id = None;
                    core.repo().unwrap().put_ai_run(&ai).unwrap();
                }
                _ => {
                    let id = format!("c{n}");
                    let mut chat = provider(
                        &id,
                        "message",
                        "chat:chat-a",
                        json!({"channel": "chat", "conversationId": "19:chat-a", "at": 2000 + n, "isMine": false, "text": "ping"}),
                    );
                    chat.updated_at = 1_795_000_000 + n;
                    put(&core, chat);
                    messages.push(id);
                }
            }
            if step % 5 == 4 {
                let delta = since(&core, &base).await;
                let applied =
                    apply(&base, &delta).unwrap_or_else(|| panic!("reset at step {step}: {delta}"));
                let now = snapshot(&core).await;
                assert_eq!(sorted(&applied), sorted(&now), "step {step}");
                base = applied;
            }
        }
    }

    #[tokio::test]
    async fn contract_fixture_changes_since() {
        let (_dir, core) = core();
        connect(&core);
        let at = 1_795_000_000;
        {
            let mut r = core.repo().unwrap();
            tasks::task_save(&mut r, "personal", &json!({"id": "task-keep", "text": "Send the roadmap comments", "status": "todo", "order": 1.0}), at).unwrap();
            tasks::task_save(&mut r, "personal", &json!({"id": "task-gone", "text": "Book the room", "status": "todo", "order": 2.0}), at).unwrap();
        }
        let mut m = meeting(
            "mtg-1",
            json!({"title": "Vendor sync", "state": "downloaded", "start": "2026-11-25T10:00:00Z", "end": "2026-11-25T10:30:00Z"}),
        );
        m.updated_at = at;
        put(&core, m.clone());
        for mut rec in [
            mail("m1", "conv-1", 100, false, "Can you review the Q3 budget?"),
            mail("m2", "conv-1", 200, true, "Sure, which version?"),
            mail("m3", "conv-1", 300, false, "The one from Monday."),
        ] {
            rec.updated_at = at;
            put(&core, rec);
        }
        let mut d = decision("m2", json!({"lane": "waiting", "waitingSince": 350}));
        d.revision = "rev-d".into();
        put(&core, d);
        let before = snapshot(&core).await;
        {
            let mut r = core.repo().unwrap();
            tasks::task_save(
                &mut r,
                "personal",
                &json!({"id": "task-keep", "status": "doing"}),
                at + 60,
            )
            .unwrap();
            tasks::task_delete(&mut r, "personal", "task-gone").unwrap();
            r.enqueue(&job("job-notes", "meeting_notes", at + 120))
                .unwrap();
        }
        m.data["template"] = json!("short-summary");
        m.updated_at = at + 90;
        put(&core, m);
        let mut m4 = mail("m4", "conv-1", 400, false, "Any news?");
        m4.updated_at = at + 180;
        put(&core, m4);
        let delta = since(&core, &before).await;
        let after = snapshot(&core).await;
        assert_eq!(sorted(&apply(&before, &delta).unwrap()), sorted(&after));
        // What varies from run to run: the install's client id and the temp folder.
        fn steady_part(s: &mut Value) {
            // A task's revision is a fresh id at every save.
            if let Some(records) = s.get_mut("records").and_then(Value::as_array_mut) {
                for r in records.iter_mut().filter(|r| r["kind"] == "commitment") {
                    r["revision"] = json!(format!("rev-{}", r["id"].as_str().unwrap()));
                }
            }
            if s.get("settings").is_some() {
                s["settings"]["clientId"] = json!("client-id");
            }
            if s.get("meetingsRoot").is_some() {
                s["meetingsRoot"] =
                    json!({"path": "/Users/taylor/CodeMie Connect/Meetings", "isDefault": true});
            }
        }
        let steady = |mut v: Value| {
            if v.get("snapshot").is_some() {
                steady_part(&mut v["snapshot"]);
            }
            steady_part(&mut v);
            v
        };
        crate::plugins::testkit::contract_fixture(
            "changes-since.json",
            &json!({"before": steady(sorted(&before)), "delta": steady(delta), "after": steady(sorted(&after))}),
        );
    }
}
