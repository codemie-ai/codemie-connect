//! The outbox (design §4): every change to a provider's task is saved locally first and queued
//! here, so a write in Connect never fails because the provider is unreachable.
//!
//! An entry is a bookkeeping record (kind [`KIND`], unversioned, in the task's workspace):
//! `{id, taskId, workspaceId, provider, op, patch, seq, enqueuedAt, editedAt, attempts, lastError,
//! message, parked}`. `op` is `create`, `update`, `complete` or `remove`; `patch` names the fields
//! an `update` changes (the sync job sends their values as they are when it pushes), `{done}` for
//! a `complete` and `{id}` (the provider's id) for a `remove`. `seq` orders the entries.
//!
//! An entry and its task are written in one repository transaction.
use crate::workspace::models::{id, Record, Result};
use crate::workspace::repository::Repository;
use serde_json::{json, Value};

/// The record kind of an outbox entry.
pub(crate) const KIND: &str = "task_outbox";

fn entries(r: &Repository) -> Result<Vec<Record>> {
    let mut all = r.records_of_kind(KIND)?;
    all.sort_by_key(|e| e.data["seq"].as_i64().unwrap_or(0));
    Ok(all)
}

/// The entries of `provider` not parked, oldest first.
pub(crate) fn waiting(r: &Repository, provider: &str) -> Result<Vec<Value>> {
    Ok(entries(r)?
        .into_iter()
        .filter(|e| e.data["provider"] == provider && e.data["parked"] != true)
        .map(|e| e.data)
        .collect())
}

/// How many entries of `provider` wait and how many are parked.
pub(crate) fn counts(r: &Repository, provider: &str) -> Result<(usize, usize)> {
    let mine: Vec<Record> = r
        .records_of_kind(KIND)?
        .into_iter()
        .filter(|e| e.data["provider"] == provider)
        .collect();
    let parked = mine.iter().filter(|e| e.data["parked"] == true).count();
    Ok((mine.len() - parked, parked))
}

/// The record of entry `entry` (a body `waiting` returned) as it is stored now, if it still is.
pub(crate) fn current(r: &Repository, entry: &Value) -> Result<Option<Record>> {
    let (Some(eid), Some(wid)) = (entry["id"].as_str(), entry["workspaceId"].as_str()) else {
        return Ok(None);
    };
    match r.record(KIND, eid, None, Some(wid)) {
        Ok(rec) => Ok(Some(rec)),
        Err(e) if e.code == "not_found" => Ok(None),
        Err(e) => Err(e),
    }
}

/// The waiting entries of task `task_id`, oldest first.
fn of_task(r: &Repository, task_id: &str) -> Result<Vec<Record>> {
    Ok(entries(r)?
        .into_iter()
        .filter(|e| e.data["taskId"] == task_id && e.data["parked"] != true)
        .collect())
}

/// A new entry for `task`, ordered by `seq`.
pub(crate) fn entry(task: &Record, op: &str, patch: Value, seq: i64, now: i64) -> Record {
    let wid = task.workspace_id.clone().unwrap_or_default();
    let provider = task.data["provider"].as_str().unwrap_or_default();
    entry_for(&task.id, &wid, provider, op, patch, seq, now)
}

/// A new entry for task `task_id` of workspace `wid` (the task record may be gone: a `remove`).
pub(crate) fn entry_for(
    task_id: &str,
    wid: &str,
    provider: &str,
    op: &str,
    patch: Value,
    seq: i64,
    now: i64,
) -> Record {
    let eid = id();
    Record {
        id: eid.clone(),
        kind: KIND.into(),
        connection_id: None,
        workspace_id: Some(wid.into()),
        source: "local".into(),
        revision: id(),
        updated_at: now,
        data: json!({"id": eid, "taskId": task_id, "workspaceId": wid,
            "provider": provider, "op": op, "patch": patch, "seq": seq,
            "enqueuedAt": now, "editedAt": now, "attempts": 0, "lastError": null,
            "message": null, "parked": false}),
    }
}

/// Task `task_id` (of workspace `wid`) with `pending` set to whether an entry still waits for
/// it once `removed` are gone (or `added` is true); `None` when there is no such task or its
/// `pending` is already that. Its `syncError` goes when no parked entry is left.
pub(crate) fn pending_put(
    r: &Repository,
    task_id: &str,
    wid: &str,
    removed: &[&str],
    added: bool,
) -> Result<Option<Record>> {
    let Ok(mut task) = r.record(crate::workspace::tasks::KIND, task_id, None, Some(wid)) else {
        return Ok(None);
    };
    let left: Vec<Record> = r
        .records_of_kind(KIND)?
        .into_iter()
        .filter(|e| e.data["taskId"] == task_id && !removed.contains(&e.id.as_str()))
        .collect();
    let pending = added || !left.is_empty();
    let parked = left.iter().any(|e| e.data["parked"] == true);
    if task.data["pending"] == pending && (parked || task.data["syncError"].is_null()) {
        return Ok(None);
    }
    task.data["pending"] = pending.into();
    if !parked {
        task.data["syncError"] = Value::Null;
    }
    task.revision = id();
    Ok(Some(task))
}

/// The next free `seq`.
pub(crate) fn next_seq(r: &Repository) -> Result<i64> {
    Ok(r.records_of_kind(KIND)?
        .iter()
        .filter_map(|e| e.data["seq"].as_i64())
        .max()
        .unwrap_or(0)
        + 1)
}

/// Queues `op` with `patch` onto `queued` (the task's waiting entries, oldest first), changing
/// or adding entries; returns the index of the entry it changed or added, if any. Consecutive
/// `update`s coalesce into one; an `update` while its `create` waits needs nothing (the create
/// sends the task as it is then); a second `create` adds nothing; consecutive `complete`s keep
/// the last.
fn plan(
    queued: &mut Vec<Record>,
    task: &Record,
    op: &str,
    patch: Value,
    seq: &mut i64,
    now: i64,
) -> Option<usize> {
    let last_op = queued.last().and_then(|e| e.data["op"].as_str());
    match (op, last_op) {
        ("create", _) if queued.iter().any(|e| e.data["op"] == "create") => None,
        ("update", Some("create")) => None,
        ("update", Some("update")) | ("complete", Some("complete")) => {
            let i = queued.len() - 1;
            let e = &mut queued[i];
            if op == "update" {
                for (k, v) in patch.as_object().into_iter().flatten() {
                    e.data["patch"][k] = v.clone();
                }
            } else {
                e.data["patch"] = patch;
            }
            e.data["editedAt"] = now.into();
            e.updated_at = now;
            e.revision = id();
            Some(i)
        }
        _ => {
            queued.push(entry(task, op, patch, *seq, now));
            *seq += 1;
            Some(queued.len() - 1)
        }
    }
}

/// Queues each `(op, patch)` of `ops` for `task` and writes the task, marked `pending`, in the
/// same transaction.
pub(crate) fn enqueue_all(
    r: &mut Repository,
    task: &Record,
    ops: &[(&str, Value)],
    now: i64,
) -> Result<()> {
    let mut queued = of_task(r, &task.id)?;
    let mut seq = next_seq(r)?;
    let mut touched = std::collections::BTreeSet::new();
    for (op, patch) in ops {
        touched.extend(plan(&mut queued, task, op, patch.clone(), &mut seq, now));
    }
    let mut puts: Vec<Record> = touched.into_iter().map(|i| queued[i].clone()).collect();
    let mut task = task.clone();
    task.data["pending"] = true.into();
    puts.push(task);
    r.commit_local(&puts, &[], true)
}

/// Deletes provider task `task` with its entries (sent or parked) in one transaction; once it
/// is in the provider, a `remove` (`{id, key}`) is queued in the same transaction.
pub(crate) fn delete_task(r: &mut Repository, task: &Record, now: i64) -> Result<()> {
    let wid = task.workspace_id.clone().unwrap_or_default();
    let mine: Vec<Record> = r
        .records_of_kind(KIND)?
        .into_iter()
        .filter(|e| e.data["taskId"] == task.id.as_str())
        .collect();
    let mut gone: Vec<(&str, &str, &str)> = vec![(crate::workspace::tasks::KIND, &task.id, &wid)];
    gone.extend(
        mine.iter()
            .map(|e| (KIND, e.id.as_str(), e.workspace_id.as_deref().unwrap_or(""))),
    );
    let rid = task.data["remote"]["id"].as_str();
    let mut puts = match rid {
        Some(rid) => vec![entry(
            task,
            "remove",
            json!({"id": rid, "key": task.data["key"]}),
            next_seq(r)?,
            now,
        )],
        None => Vec::new(),
    };
    // A tombstone by key: a create that reached the provider with its answer lost, or a remove
    // still parked, must not bring the task back on a pull (the pull removes it there instead).
    let sent = rid.is_some() || mine.iter().any(|e| e.data["op"] == "create");
    if let (true, Some(key), Some(provider)) = (
        sent,
        task.data["key"].as_str(),
        task.data["provider"].as_str(),
    ) {
        puts.push(super::keys::ledger_record(
            provider, key, rid, "removed", now,
        ));
    }
    r.commit_local(&puts, &gone, true)
}

/// Queues `op` with `patch` for `task` (design §4) and writes the task, marked `pending`, in the
/// same transaction.
#[cfg_attr(not(test), allow(dead_code))] // `task_save` queues several at once (`enqueue_all`)
pub(crate) fn enqueue(
    r: &mut Repository,
    task: &Record,
    op: &str,
    patch: Value,
    now: i64,
) -> Result<()> {
    enqueue_all(r, task, &[(op, patch)], now)
}

/// Parks entry `eid` with the provider's sentence (none when it was dropped for carrying a
/// secret): it waits for "Try again" or "Discard change" and blocks nothing else. Its task shows
/// the sentence as `syncError`.
pub(crate) fn park(
    r: &mut Repository,
    entry: &Value,
    message: Option<&str>,
    code: &str,
) -> Result<()> {
    let Some(mut e) = current(r, entry)? else {
        return Ok(());
    };
    e.data["parked"] = true.into();
    e.data["lastError"] = code.into();
    e.data["message"] = message.map_or(Value::Null, Value::from);
    e.data["attempts"] = (e.data["attempts"].as_i64().unwrap_or(0) + 1).into();
    let mut puts = vec![e.clone()];
    let wid = e.workspace_id.clone().unwrap_or_default();
    if let Some(task_id) = e.data["taskId"].as_str() {
        if let Ok(mut task) = r.record(crate::workspace::tasks::KIND, task_id, None, Some(&wid)) {
            task.data["syncError"] = message.map_or(Value::Null, Value::from);
            task.revision = id();
            puts.push(task);
        }
    }
    r.commit_local(&puts, &[], true)
}

/// The `remove` entries of `provider` for `key` that a create (or an adopt) of that key made
/// stale: every parked one, and any aimed at `rid`, the remote the key now lives at. Sent, they
/// would delete the task just made again (design §10 Undo, §3 "Withdrawn lets a later add
/// create again").
pub(crate) fn stale_removes(
    r: &Repository,
    provider: &str,
    key: &str,
    rid: Option<&str>,
) -> Result<Vec<Record>> {
    Ok(r.records_of_kind(KIND)?
        .into_iter()
        .filter(|e| {
            e.data["provider"] == provider
                && e.data["op"] == "remove"
                && e.data["patch"]["key"] == key
                && (e.data["parked"] == true || rid.is_some_and(|rid| e.data["patch"]["id"] == rid))
        })
        .collect())
}

/// Whether `remove` entry `entry` aims at a task that lives again: its key's ledger entry is live
/// (`created` or `done`) at the same remote id, or a task of the provider holds that id. Such a
/// remove is never sent.
pub(crate) fn remove_is_stale(r: &Repository, entry: &Value) -> Result<bool> {
    let (Some(rid), Some(provider)) = (entry["patch"]["id"].as_str(), entry["provider"].as_str())
    else {
        return Ok(false);
    };
    if let Some(key) = entry["patch"]["key"].as_str() {
        let ledger = super::keys::ledger_get(r, provider, key)?;
        if ledger.is_some_and(|l| {
            matches!(l["state"].as_str(), Some("created" | "done")) && l["remoteId"] == rid
        }) {
            return Ok(true);
        }
    }
    Ok(r.records_of_kind(crate::workspace::tasks::KIND)?
        .iter()
        .any(|t| t.data["provider"] == provider && t.data["remote"]["id"] == rid))
}

/// Drops the waiting entries of task `task_id` whose op is `op` (a withdrawn create, design §10),
/// and returns how many went.
#[cfg_attr(not(test), allow(dead_code))] // `task_withdraw` drops in its own transaction (ops.rs)
pub(crate) fn drop_for(r: &mut Repository, task_id: &str, op: &str) -> Result<usize> {
    let gone: Vec<Record> = of_task(r, task_id)?
        .into_iter()
        .filter(|e| e.data["op"] == op)
        .collect();
    let keys: Vec<(&str, &str, &str)> = gone
        .iter()
        .map(|e| (KIND, e.id.as_str(), e.workspace_id.as_deref().unwrap_or("")))
        .collect();
    let ids: Vec<&str> = gone.iter().map(|e| e.id.as_str()).collect();
    let task = match gone.first().and_then(|e| e.workspace_id.as_deref()) {
        Some(wid) => pending_put(r, task_id, wid, &ids, false)?,
        None => None,
    };
    r.commit_local(task.as_slice(), &keys, task.is_some())?;
    Ok(gone.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::ai::tests::ready;
    use crate::workspace::test_core;
    use std::sync::Arc;

    fn task(id: &str) -> Record {
        Record {
            id: id.into(),
            kind: "commitment".into(),
            connection_id: None,
            workspace_id: Some("personal".into()),
            source: "local".into(),
            revision: "r".into(),
            updated_at: 1,
            data: json!({"text": "x", "provider": "plugin:todoist", "status": "todo"}),
        }
    }

    #[test]
    fn updates_coalesce_a_complete_waits_behind_and_drop_for_removes() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let mut r = core.repo().unwrap();
        let mut t = task("t1");
        t.data["remote"] = json!({"id": "8124"});
        enqueue(&mut r, &t, "update", json!({"text": true}), 10).unwrap();
        enqueue(&mut r, &t, "update", json!({"due": true}), 20).unwrap();
        enqueue(&mut r, &t, "complete", json!({"done": true}), 30).unwrap();
        enqueue(&mut r, &t, "update", json!({"notes": true}), 40).unwrap();
        let w = waiting(&r, "plugin:todoist").unwrap();
        let ops: Vec<&str> = w.iter().map(|e| e["op"].as_str().unwrap()).collect();
        assert_eq!(ops, ["update", "complete", "update"]);
        assert_eq!(w[0]["patch"], json!({"text": true, "due": true}));
        assert_eq!(w[0]["editedAt"], 20);
        let stored = r
            .record("commitment", "t1", None, Some("personal"))
            .unwrap();
        assert_eq!(stored.data["pending"], true);
        assert_eq!(drop_for(&mut r, "t1", "update").unwrap(), 2);
        assert_eq!(waiting(&r, "plugin:todoist").unwrap().len(), 1);
        assert_eq!(drop_for(&mut r, "t1", "complete").unwrap(), 1);
        let stored = r
            .record("commitment", "t1", None, Some("personal"))
            .unwrap();
        assert_eq!(
            stored.data["pending"], false,
            "nothing waits for it any more"
        );
    }
}
