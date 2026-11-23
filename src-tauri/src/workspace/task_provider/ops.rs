//! The task operations a provider brings (design §10–§12, rulings 8, 16, 17):
//! `task_provider_set` (switching, with the copy offered once), `task_withdraw` (the meeting
//! column's Undo), `task_bulk` (By date's moves, with what Undo sends back), `task_handled`
//! ("Looks handled"), `task_parked` (Try again / Discard change) and `task_provider_check`
//! (Settings › Tasks's Check, design §11).
//!
//! Nothing here deletes or closes a task in a provider on its own: a switch keeps the old
//! provider's cache and unsent changes, and only an explicit withdraw or delete queues a
//! `remove`.
use super::handled::{evidence_hash, kept};
use super::{active_provider, keys, outbox, sync, wire, ProviderError};
use crate::workspace::models::{id, now, Operation, Record, Request, Result, WorkspaceError};
use crate::workspace::repository::Repository;
use crate::workspace::tasks::{self, provider_of, status_of, Prepared, KIND};
use crate::workspace::Core;
use serde_json::{json, Value};
use std::collections::HashSet;

/// `task_bulk` and `task_withdraw` take at most this many tasks.
const BULK_MAX: usize = 200;
const BULK_MESSAGE: &str = "Choose up to 200 tasks.";

fn invalid(field: &str, message: &str) -> WorkspaceError {
    let mut e = WorkspaceError::new("validation", message);
    e.field = Some(field.into());
    e
}

fn task_id(data: &Value) -> Result<&str> {
    data["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .ok_or_else(|| invalid("id", "Choose a task."))
}

fn task_of(r: &Repository, wid: &str, id: &str) -> Result<Record> {
    r.record(KIND, id, None, Some(wid)).map_err(|e| {
        if e.code == "not_found" {
            WorkspaceError::new("not_found", "This task is no longer there.")
        } else {
            e
        }
    })
}

/// A refusal or a task that is gone counts as failed in a list; anything else stops it.
fn counted(e: WorkspaceError) -> Result<()> {
    if matches!(e.code.as_str(), "validation" | "not_found") {
        Ok(())
    } else {
        Err(e)
    }
}

/// The hosts "Open in Todoist ↗" opens (design §9): the task's own link, opened by Connect
/// itself rather than through a plugin's link confirmation.
const REMOTE_HOSTS: [&str; 2] = ["todoist.com", "app.todoist.com"];

/// A task's `remote.url` when it is a plain https link to one of `REMOTE_HOSTS` (no other port,
/// no user name); a refusal otherwise.
fn remote_link(task: &Value) -> Result<&str> {
    let link = task["remote"]["url"]
        .as_str()
        .ok_or_else(|| WorkspaceError::new("not_found", "This task has no link to open."))?;
    let secure = url::Url::parse(link).is_ok_and(|u| {
        u.scheme() == "https"
            && u.port().is_none()
            && u.username().is_empty()
            && u.password().is_none()
            && u.host_str().is_some_and(|h| REMOTE_HOSTS.contains(&h))
    });
    if !secure {
        return Err(WorkspaceError::new(
            "validation",
            "Connect opens only the task’s own Todoist link.",
        ));
    }
    Ok(link)
}

fn gone_of(entries: &[Record]) -> Vec<(&str, &str, &str)> {
    entries
        .iter()
        .map(|e| {
            (
                outbox::KIND,
                e.id.as_str(),
                e.workspace_id.as_deref().unwrap_or(""),
            )
        })
        .collect()
}

impl Core {
    /// `open_source {kind: "task", id}`: the link "Open in Todoist ↗" opens, read from the
    /// stored task of workspace `wid` (never an address the window sends).
    pub(in crate::workspace) fn task_remote_link(&self, wid: &str, id: &str) -> Result<String> {
        let task = task_of(&*self.repo()?, wid, id)?;
        remote_link(&task.data).map(str::to_string)
    }

    /// `task_provider_set`, `task_withdraw`, `task_bulk`, `task_handled` and `task_parked`.
    pub(in crate::workspace) fn task_provider_op(&self, req: &Request) -> Result<Value> {
        let (w, _) = self.active_workspace(req, false)?;
        // Same order as the other task writers: the meeting-folder lock, then the repository.
        let _folders = self.meeting_lock();
        let now = now();
        let mut r = self.repo()?;
        let answer = match req.op {
            Operation::TaskProviderSet => self.provider_set(&mut r, &w.id, &req.data, now)?,
            Operation::TaskWithdraw => withdraw(&mut r, &w.id, &req.data, now)?,
            Operation::TaskBulk => bulk(&mut r, &w.id, &req.data, now)?,
            Operation::TaskHandled => handled(&mut r, &w.id, &req.data, now)?,
            Operation::TaskParked => parked(&mut r, &w.id, &req.data, now)?,
            _ => return Err(WorkspaceError::new("validation", "Unsupported operation.")),
        };
        // What was queued for the active provider is pushed at once (design ruling 4).
        let provider = active_provider(&r.settings()?).to_string();
        if provider != "local" && outbox::counts(&r, &provider)?.0 > 0 {
            sync::queue(&mut r, &provider, now)?;
        }
        Ok(answer)
    }

    /// `task_provider_set {provider, copy?}` (design §11, ruling 16): validates the choice,
    /// re-stamps the To review tasks, remembers the copy was offered, copies the open Local
    /// tasks when asked, and asks a provider for everything again. Deletes and closes nothing.
    fn provider_set(&self, r: &mut Repository, wid: &str, data: &Value, now: i64) -> Result<Value> {
        const UNKNOWN: &str = "Choose Connect or an installed task plugin.";
        let provider = data["provider"]
            .as_str()
            .ok_or_else(|| invalid("provider", UNKNOWN))?;
        if provider != "local" {
            let listed = self
                .task_providers
                .get()
                .map(|p| p.available())
                .unwrap_or_default();
            let info = listed
                .iter()
                .find(|p| p.id == provider)
                .ok_or_else(|| invalid("provider", UNKNOWN))?;
            if !info.on {
                return Err(invalid(
                    "provider",
                    &format!("Turn {} on in Settings › Plugins first.", info.name),
                ));
            }
        }
        let mut s = r.settings()?;
        let switched = s.tasks.provider != provider;
        s.tasks.provider = provider.into();
        if provider != "local" && !s.tasks.copy_offered.iter().any(|p| p == provider) {
            s.tasks.copy_offered.push(provider.into());
        }
        r.settings_update(&s)?;
        restamp_review(r, provider, now)?;
        let copied = if provider != "local" && data["copy"] == true {
            copy_open(r, wid, provider, now)?
        } else {
            0
        };
        if provider != "local" {
            if switched {
                // A full pull (design §4 "Budget": on the first sync, a switch, and Check).
                let mut st = sync::load_state(r, provider)?;
                st["cursor"] = Value::Null;
                st["lastPull"] = Value::Null;
                sync::save_state(r, provider, &st, now)?;
            }
            sync::queue(r, provider, now)?;
        }
        Ok(json!({"provider": provider, "copied": copied}))
    }

    /// `task_provider_check {}` (read-only, design §11 "Check"): the active provider's `status`,
    /// kept to exactly `{ok, account, project}` (never the plugin's whole answer); Local has
    /// nothing to check. A refusal's `code` is the provider's state (`needs_token`,
    /// `rate_limited`, `offline`, `not_found`, `refused`) and its `message` a sentence naming the
    /// provider, e.g. "Todoist needs your API token."
    pub(in crate::workspace) async fn task_provider_check(&self) -> Result<Value> {
        let provider = active_provider(&self.repo()?.settings()?).to_string();
        if provider == "local" {
            return Ok(json!({"ok": true}));
        }
        let providers = self
            .task_providers
            .get()
            .ok_or_else(|| WorkspaceError::new("offline", "Can’t be reached right now."))?;
        let plugin = provider
            .strip_prefix("plugin:")
            .unwrap_or(provider.as_str());
        match providers.call(plugin, "status", json!({})).await {
            Ok(v) => Ok(json!({
                "ok": true,
                "account": v.get("account").cloned().unwrap_or(Value::Null),
                "project": v.get("project").cloned().unwrap_or(Value::Null),
            })),
            Err(e) => Err(self.check_error(plugin, e)),
        }
    }

    /// `task_provider_check`'s refusal: the provider's state as `code`, its sentence naming it as
    /// `message`. A `Refused`/`NotFound` sentence that would echo the provider's stored secret
    /// (design §5 "Errors", §8, the same check a parked entry's message gets, sync.rs) is dropped
    /// for a plain one instead.
    fn check_error(&self, plugin: &str, e: ProviderError) -> WorkspaceError {
        let id = format!("plugin:{plugin}");
        let name = self
            .task_providers
            .get()
            .map(|p| p.available())
            .unwrap_or_default()
            .into_iter()
            .find(|p| p.id == id)
            .map_or_else(|| "It".to_string(), |p| p.name);
        let safe = |t: String| -> String {
            if t.is_empty()
                || self
                    .task_providers
                    .get()
                    .is_some_and(|p| p.secret_matches(plugin, &t))
            {
                String::new()
            } else {
                t
            }
        };
        match e {
            ProviderError::NeedsToken => {
                WorkspaceError::new("needs_token", format!("{name} needs your API token."))
            }
            ProviderError::RateLimited { .. } => WorkspaceError::new(
                "rate_limited",
                format!("{name} asked Connect to slow down. Try again soon."),
            ),
            ProviderError::Offline => {
                WorkspaceError::new("offline", format!("{name} can’t be reached right now."))
            }
            ProviderError::NotFound(t) => {
                let t = safe(t);
                WorkspaceError::new(
                    "not_found",
                    if t.is_empty() {
                        format!("{name} doesn’t have this any more.")
                    } else {
                        t
                    },
                )
            }
            ProviderError::Refused(t) => {
                let t = safe(t);
                WorkspaceError::new(
                    "refused",
                    if t.is_empty() {
                        format!("{name} didn’t accept the request.")
                    } else {
                        t
                    },
                )
            }
        }
    }
}

/// To review tasks are Connect's drafts and follow the active provider (design §1).
fn restamp_review(r: &mut Repository, provider: &str, now: i64) -> Result<()> {
    let moved: Vec<Record> = r
        .records_of_kind(KIND)?
        .into_iter()
        .filter(|t| status_of(&t.data) == "review" && provider_of(&t.data) != provider)
        .map(|mut t| {
            match t.data.as_object_mut() {
                Some(body) if provider == "local" => {
                    body.remove("provider");
                }
                _ => t.data["provider"] = provider.into(),
            }
            t.revision = id();
            t.updated_at = now;
            t
        })
        .collect();
    if moved.is_empty() {
        return Ok(());
    }
    r.commit_local(&moved, &[], true)?;
    // Their meetings' tasks.json follow.
    let mut meetings: Vec<(String, String)> = moved
        .iter()
        .filter_map(|t| {
            let meeting = t.data["meetingId"].as_str()?;
            Some((
                t.workspace_id.clone().unwrap_or_default(),
                meeting.to_string(),
            ))
        })
        .collect();
    meetings.sort();
    meetings.dedup();
    for (wid, meeting) in meetings {
        tasks::write_tasks_json(r, &wid, &meeting);
    }
    Ok(())
}

/// Copies the open Local tasks of `wid` to `provider` (design §11 "Copy"): each copy keeps its
/// task's key, says `copiedFrom`, and has its create queued. A key the ledger already knows, or a
/// task of the provider already holds, makes nothing. Returns how many were copied.
fn copy_open(r: &mut Repository, wid: &str, provider: &str, now: i64) -> Result<usize> {
    let mut held: HashSet<String> = r
        .records_of_kind(KIND)?
        .iter()
        .filter(|t| provider_of(&t.data) == provider)
        .filter_map(|t| t.data["key"].as_str().map(str::to_string))
        .collect();
    // A Local task copied before is never copied again, whatever its key says now.
    let copied_from: HashSet<String> = r
        .records_of_kind(KIND)?
        .iter()
        .filter(|t| provider_of(&t.data) == provider)
        .filter_map(|t| t.data["copiedFrom"].as_str().map(str::to_string))
        .collect();
    let locals: Vec<Record> = r
        .local_records(wid, KIND)?
        .into_iter()
        .filter(|t| provider_of(&t.data) == "local" && tasks::is_open(&t.data))
        .filter(|t| !copied_from.contains(&t.id))
        .collect();
    let mut copied = 0;
    for mut t in locals {
        let key = match t.data["key"].as_str().filter(|k| tasks::valid_key(k)) {
            Some(key) => key.to_string(),
            None => {
                // A task from before keys gets its key now, kept, so it never changes with
                // its text (design §13).
                let key = tasks::key_of(&t.id, &t.data);
                t.data["key"] = key.clone().into();
                t.revision = id();
                r.put_record(&t)?;
                key
            }
        };
        if held.contains(&key) || keys::ledger_get(r, provider, &key)?.is_some() {
            continue;
        }
        let mut data = t.data.clone();
        if let Some(body) = data.as_object_mut() {
            for gone in ["pending", "remote", "syncError", "handled", "keptEvidence"] {
                body.remove(gone);
            }
        }
        let mut history = t.data["history"].as_array().cloned().unwrap_or_default();
        history.push(json!({"at": now, "text": "Copied from Connect"}));
        data["id"] = id().into();
        data["provider"] = provider.into();
        data["key"] = key.clone().into();
        data["copiedFrom"] = t.id.clone().into();
        data["history"] = history.into();
        tasks::task_save(r, wid, &data, now)?;
        held.insert(key);
        copied += 1;
    }
    Ok(copied)
}

/// `task_withdraw {ids}` (design §10, ruling 8): each task goes back To review. A create still
/// waiting is dropped, so nothing reaches the provider; a task already there gets a `remove`
/// (a delete, not a close) and its key is marked `withdrawn`, so a later add creates again.
fn withdraw(r: &mut Repository, wid: &str, data: &Value, now: i64) -> Result<Value> {
    let ids = data["ids"]
        .as_array()
        .ok_or_else(|| invalid("ids", "Choose the tasks."))?;
    if ids.len() > BULK_MAX {
        return Err(invalid("ids", BULK_MESSAGE));
    }
    let (mut done, mut failed) = (0, 0);
    for v in ids {
        match v.as_str().map(|tid| withdraw_one(r, wid, tid, now)) {
            Some(Ok(())) => done += 1,
            Some(Err(e)) => {
                counted(e)?;
                failed += 1;
            }
            None => failed += 1,
        }
    }
    Ok(json!({"done": done, "failed": failed}))
}

/// One task's withdraw, in one transaction with its outbox and ledger changes.
fn withdraw_one(r: &mut Repository, wid: &str, tid: &str, now: i64) -> Result<()> {
    let stored = task_of(r, wid, tid)?;
    if status_of(&stored.data) == "review" {
        return Ok(());
    }
    let Prepared {
        mut record, before, ..
    } = tasks::prepare(
        r,
        wid,
        &json!({"id": tid, "status": "review", "log": "Moved back to review"}),
        now,
    )?;
    let provider = provider_of(&record.data).to_string();
    let mut puts = Vec::new();
    let mut gone: Vec<Record> = Vec::new();
    if provider != "local" {
        let mine: Vec<Record> = r
            .records_of_kind(outbox::KIND)?
            .into_iter()
            .filter(|e| e.data["taskId"] == tid)
            .collect();
        let key = record.data["key"].as_str().map(str::to_string);
        let rid = record.data["remote"]["id"].as_str().map(str::to_string);
        let mut left = Vec::new();
        for e in mine {
            // Removes belong to an earlier life of the task; every other entry goes.
            if e.data["op"] == "remove" {
                left.push(e);
            } else {
                gone.push(e);
            }
        }
        if gone.iter().any(|e| e.data["op"] == "create") {
            // The create may be on its way, or have reached the provider with its answer lost:
            // a tombstone by key keeps a pull from bringing it back (it is removed there
            // instead), as `outbox::delete_task` does.
            if let Some(key) = &key {
                puts.push(keys::ledger_record(&provider, key, None, "withdrawn", now));
            }
        } else if let Some(rid) = rid {
            let seq = outbox::next_seq(r)?;
            // The remote as it was, for a Discard change of this remove to give it back.
            let remove = outbox::entry(
                &record,
                "remove",
                json!({"id": rid, "key": key, "ledger": "withdrawn",
                    "remote": record.data["remote"]}),
                seq,
                now,
            );
            left.push(remove.clone());
            puts.push(remove);
            if let Some(key) = &key {
                puts.push(keys::ledger_record(
                    &provider,
                    key,
                    Some(&rid),
                    "withdrawn",
                    now,
                ));
            }
            record.data["remote"] = Value::Null;
        }
        record.data["pending"] = (!left.is_empty()).into();
        if !left.iter().any(|e| e.data["parked"] == true) {
            record.data["syncError"] = Value::Null;
        }
    }
    let after = record.data.clone();
    puts.push(record);
    r.commit_local(&puts, &gone_of(&gone), true)?;
    tasks::meetings_follow(r, wid, &before, &after);
    Ok(())
}

/// `task_bulk {items: [{id, due?, status?}]}`: each item saved as `task_save` would; `before`
/// holds what each moved task had, for Undo to send back.
fn bulk(r: &mut Repository, wid: &str, data: &Value, now: i64) -> Result<Value> {
    let items = data["items"]
        .as_array()
        .ok_or_else(|| invalid("items", BULK_MESSAGE))?;
    if items.len() > BULK_MAX {
        return Err(invalid("items", BULK_MESSAGE));
    }
    // To review or Dismissed takes a task out of the provider: that is `task_withdraw`.
    if items.iter().any(|i| {
        i.get("status")
            .is_some_and(|s| !matches!(s.as_str(), Some("todo" | "doing" | "waiting" | "done")))
    }) {
        return Err(invalid(
            "items",
            "Move tasks to To do, In progress, Waiting or Done.",
        ));
    }
    let (mut done, mut failed, mut before) = (0, 0, Vec::new());
    for item in items {
        let Some(tid) = item["id"].as_str() else {
            failed += 1;
            continue;
        };
        let stored = match task_of(r, wid, tid) {
            Ok(t) => t,
            Err(e) => {
                counted(e)?;
                failed += 1;
                continue;
            }
        };
        let mut change = json!({"id": tid});
        for field in ["due", "status"] {
            if let Some(v) = item.get(field) {
                change[field] = v.clone();
            }
        }
        match tasks::task_save(r, wid, &change, now) {
            Ok(_) => {
                done += 1;
                before.push(json!({"id": tid, "due": stored.data["due"],
                    "status": status_of(&stored.data)}));
            }
            Err(e) => {
                counted(e)?;
                failed += 1;
            }
        }
    }
    Ok(json!({"done": done, "failed": failed, "before": before}))
}

/// `task_handled {id, action: "done" | "keep"}` or `{id, evidence}` (design §6): evidence flags
/// an open task (unless the user kept it open against the same evidence); Done completes it, as
/// any completion, and Keep open clears the flag and remembers the evidence.
fn handled(r: &mut Repository, wid: &str, data: &Value, now: i64) -> Result<Value> {
    let tid = task_id(data)?;
    let mut task = task_of(r, wid, tid)?;
    if let Some(evidence) = data.get("evidence").filter(|v| !v.is_null()) {
        const MESSAGE: &str = "Say what shows the task is handled.";
        let evidence = evidence
            .as_str()
            .map(str::trim)
            .filter(|e| !e.is_empty() && e.chars().count() <= 500)
            .ok_or_else(|| invalid("evidence", MESSAGE))?;
        let flagged = task.data["handled"]["evidence"] == evidence;
        if tasks::is_open(&task.data) && !flagged && !kept(&task.data, evidence) {
            tasks::task_save(
                r,
                wid,
                &json!({"id": tid, "handled": {"evidence": evidence}}),
                now,
            )?;
        }
        return Ok(json!({"id": tid}));
    }
    match data["action"].as_str() {
        Some("done") => {
            tasks::task_save(
                r,
                wid,
                &json!({"id": tid, "status": "done", "handled": null}),
                now,
            )?;
        }
        Some("keep") => {
            if let Some(evidence) = task.data["handled"]["evidence"].as_str() {
                let hash = evidence_hash(evidence);
                let mut kept = task.data["keptEvidence"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                if !kept.iter().any(|h| h == hash.as_str()) {
                    kept.push(hash.into());
                }
                task.data["keptEvidence"] = kept.into();
                task.data["handled"] = Value::Null;
                task.revision = id();
                task.updated_at = now;
                r.put_record(&task)?;
            }
        }
        _ => return Err(invalid("action", "Choose Done or Keep open.")),
    }
    Ok(json!({"id": tid}))
}

/// Writes a provider's last-seen fields (`remote.base`) back into `body` where they differ:
/// Discard change (design §12).
fn restore_base(body: &mut Value, base: &Value, now: i64) {
    let current = wire::fields(body);
    let mut fields = current.clone();
    for k in ["text", "notes", "due", "done", "kind", "owner"] {
        if base.get(k).is_some() {
            fields[k] = base[k].clone();
        }
    }
    let notes = body["notes"].clone();
    wire::apply_fields(body, &fields, now);
    if fields["notes"] == current["notes"] {
        // Unchanged: the notes as stored (not the quote they may read as).
        body["notes"] = notes;
    }
}

/// `task_parked {id, action: "retry" | "discard"}` (design §4, §12) for a task's parked entries
/// (or one entry by its id: a remove whose task is gone). Try again puts each back in line, but
/// a remove aimed at a task made again under its key is dropped instead (it would delete it).
/// Discard drops them: a change goes back to the provider's fields, a create back To review (it
/// was never sent), and a delete is undone (the key is live again, the pull brings it back).
fn parked(r: &mut Repository, wid: &str, data: &Value, now: i64) -> Result<Value> {
    let tid = task_id(data)?;
    let action = data["action"]
        .as_str()
        .filter(|a| matches!(*a, "retry" | "discard"))
        .ok_or_else(|| invalid("action", "Choose Try again or Discard change."))?;
    let all = r.records_of_kind(outbox::KIND)?;
    let entries: Vec<&Record> = all
        .iter()
        .filter(|e| e.data["parked"] == true && (e.data["taskId"] == tid || e.id == tid))
        .collect();
    let mut puts: Vec<Record> = Vec::new();
    let mut gone: Vec<Record> = Vec::new();
    let mut unsent = false;
    // A withdraw's remove discarded: the task's remote, to link it back.
    let mut relink: Option<Value> = None;
    for e in entries {
        if action == "retry" {
            if e.data["op"] == "remove" && outbox::remove_is_stale(r, &e.data)? {
                gone.push(e.clone());
                continue;
            }
            let mut back = e.clone();
            back.data["parked"] = false.into();
            back.data["lastError"] = Value::Null;
            back.data["message"] = Value::Null;
            back.revision = id();
            back.updated_at = now;
            puts.push(back);
            continue;
        }
        gone.push(e.clone());
        match e.data["op"].as_str() {
            Some("create") => unsent = true,
            Some("remove") => {
                let (provider, key, rid) = (
                    e.data["provider"].as_str(),
                    e.data["patch"]["key"].as_str(),
                    e.data["patch"]["id"].as_str(),
                );
                if let (Some(provider), Some(key), Some(rid)) = (provider, key, rid) {
                    puts.push(keys::ledger_record(
                        provider,
                        key,
                        Some(rid),
                        "created",
                        now,
                    ));
                    if e.data["patch"]["ledger"] == "withdrawn" {
                        let kept = &e.data["patch"]["remote"];
                        relink = Some(if kept["id"] == rid {
                            kept.clone()
                        } else {
                            json!({"id": rid})
                        });
                    }
                }
            }
            _ => {}
        }
    }
    if unsent {
        // Never sent: what waited behind the create goes with it.
        let behind: Vec<Record> = all
            .iter()
            .filter(|e| {
                e.data["taskId"] == tid
                    && e.data["op"] != "remove"
                    && !gone.iter().any(|g| g.id == e.id)
            })
            .cloned()
            .collect();
        gone.extend(behind);
    }
    let task_id = all
        .iter()
        .find(|e| e.id == tid)
        .and_then(|e| e.data["taskId"].as_str())
        .unwrap_or(tid);
    let mut before = Value::Null;
    let task = match r.record(KIND, task_id, None, Some(wid)) {
        Ok(_) if action == "discard" && unsent => {
            // Never sent: back To review, Connect's draft again.
            let p = tasks::prepare(
                r,
                wid,
                &json!({"id": task_id, "status": "review", "log": "Moved back to review"}),
                now,
            )?;
            before = p.before;
            Some(p.record)
        }
        Ok(stored) if relink.is_some() && stored.data["remote"]["id"].is_null() => {
            // The withdraw is undone: the task is in the provider again, one record for it.
            // Nothing is queued: it is there already.
            let p = tasks::prepare(r, wid, &json!({"id": task_id, "status": "todo"}), now)?;
            before = p.before;
            let mut task = p.record;
            task.data["remote"] = relink.take().unwrap_or_default();
            Some(task)
        }
        Ok(mut stored) => {
            if action == "discard" {
                let base = stored.data["remote"]["base"].clone();
                if base.is_object() {
                    restore_base(&mut stored.data, &base, now);
                }
            }
            stored.revision = id();
            stored.updated_at = now;
            Some(stored)
        }
        Err(e) if e.code == "not_found" => None,
        Err(e) => return Err(e),
    };
    if let Some(mut task) = task {
        let dropped: HashSet<&str> = gone.iter().map(|e| e.id.as_str()).collect();
        let back: HashSet<&str> = puts.iter().map(|e| e.id.as_str()).collect();
        let left: Vec<&Record> = all
            .iter()
            .filter(|e| e.data["taskId"] == task.id.as_str() && !dropped.contains(e.id.as_str()))
            .collect();
        task.data["pending"] = (!left.is_empty()).into();
        if !left
            .iter()
            .any(|e| e.data["parked"] == true && !back.contains(e.id.as_str()))
        {
            task.data["syncError"] = Value::Null;
        }
        let after = task.data.clone();
        puts.push(task);
        r.commit_local(&puts, &gone_of(&gone), true)?;
        if !before.is_null() {
            tasks::meetings_follow(r, wid, &before, &after);
        }
    } else {
        r.commit_local(&puts, &gone_of(&gone), true)?;
    }
    Ok(json!({"id": tid}))
}

#[cfg(test)]
mod tests {
    use super::super::fake::FakeProvider;
    use super::super::{keys, outbox, sync, ProviderError, ProviderInfo};
    use crate::ai::fake::FakeRunner;
    use crate::workspace::ai::tests::{mutation, ready};
    use crate::workspace::models::{now, Operation, Record, Result};
    use crate::workspace::{tasks, test_core, Core};
    use serde_json::{json, Value};
    use sha1::{Digest, Sha1};
    use std::sync::Arc;

    #[test]
    fn remote_link_opens_only_secure_todoist_addresses() {
        let task = |url: &str| json!({"remote": {"id": "1", "url": url}});
        for ok in [
            "https://app.todoist.com/app/task/123",
            "https://todoist.com/showTask?id=123",
        ] {
            assert_eq!(super::remote_link(&task(ok)).unwrap(), ok);
        }
        for bad in [
            "http://app.todoist.com/app/task/123",
            "https://evil.example/app/task/123",
            "https://app.todoist.com.evil.example/x",
            "https://user:pw@app.todoist.com/x",
            "https://app.todoist.com:8443/x",
            "javascript:alert(1)",
            "not a link",
        ] {
            assert_eq!(
                super::remote_link(&task(bad)).unwrap_err().code,
                "validation",
                "{bad}"
            );
        }
        assert_eq!(
            super::remote_link(&json!({})).unwrap_err().code,
            "not_found"
        );
    }

    const P: &str = "plugin:todoist";
    const SENTINEL: &str = "tk_SENTINEL_do_not_log_0123456789";

    struct Env {
        _dir: tempfile::TempDir,
        core: Arc<Core>,
        fake: Arc<FakeProvider>,
    }

    fn env(provider: &str) -> Env {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let fake = Arc::new(FakeProvider::new());
        core.set_task_providers(fake.clone());
        {
            let mut r = core.repo().unwrap();
            let mut s = r.settings().unwrap();
            s.tasks.provider = provider.into();
            r.settings_update(&s).unwrap();
        }
        Env {
            _dir: dir,
            core,
            fake,
        }
    }

    fn todoist(on: bool) -> Vec<ProviderInfo> {
        vec![ProviderInfo {
            id: P.into(),
            name: "Todoist".into(),
            on,
            ready: true,
        }]
    }

    impl Env {
        async fn op(&self, op: Operation, data: Value) -> Result<Value> {
            self.core.request(mutation(&self.core, op, data)).await
        }
        fn save(&self, data: Value) -> Record {
            tasks::task_save(&mut self.core.repo().unwrap(), "personal", &data, now()).unwrap()
        }
        fn task(&self, id: &str) -> Option<Value> {
            self.core
                .repo()
                .unwrap()
                .record(tasks::KIND, id, None, Some("personal"))
                .ok()
                .map(|t| t.data)
        }
        /// The task records stamped with `provider` (`"local"`: none).
        fn of(&self, provider: &str) -> Vec<Record> {
            let mut all: Vec<Record> = self
                .core
                .repo()
                .unwrap()
                .records_of_kind(tasks::KIND)
                .unwrap()
                .into_iter()
                .filter(|t| tasks::provider_of(&t.data) == provider)
                .collect();
            all.sort_by(|a, b| a.id.cmp(&b.id));
            all
        }
        /// Every outbox entry of Todoist, parked ones too.
        fn outbox(&self) -> Vec<Value> {
            self.core
                .repo()
                .unwrap()
                .records_of_kind(outbox::KIND)
                .unwrap()
                .into_iter()
                .filter(|e| e.data["provider"] == P)
                .map(|e| e.data)
                .collect()
        }
        fn counts(&self) -> (usize, usize) {
            outbox::counts(&self.core.repo().unwrap(), P).unwrap()
        }
        fn ledger(&self, key: &str) -> Option<Value> {
            keys::ledger_get(&self.core.repo().unwrap(), P, key).unwrap()
        }
        async fn sync(&self) -> sync::SyncOutcome {
            sync::run(&self.core, P, now()).await.unwrap()
        }
        fn history(&self, id: &str) -> Vec<String> {
            self.task(id).unwrap()["history"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| h["text"].as_str().unwrap().to_string())
                .collect()
        }
        fn calls_of(&self, op: &str) -> Vec<Value> {
            self.fake
                .calls()
                .into_iter()
                .filter(|(o, _)| o == op)
                .map(|(_, a)| a)
                .collect()
        }
        fn settings(&self) -> crate::workspace::models::Settings {
            self.core.repo().unwrap().settings().unwrap()
        }
    }

    /// Review Focus 5: Local → Todoist (copy) → Local → Todoist with three unsent changes.
    #[tokio::test]
    async fn switching_back_and_forth_deletes_nothing_and_copies_once() {
        let e = env("local");
        e.save(json!({"id": "l1", "text": "Send the pilot user list"}));
        e.save(json!({"id": "l2", "text": "Book a room for demo day", "status": "waiting"}));
        e.save(json!({"id": "l3", "text": "Draft the pilot plan", "status": "doing"}));
        e.save(json!({"id": "r1", "text": "Prepare the agenda", "status": "review"}));
        e.save(json!({"id": "d1", "text": "Old thing", "status": "done"}));
        let locals: Vec<Value> = ["l1", "l2", "l3", "d1"]
            .iter()
            .map(|id| e.task(id).unwrap())
            .collect();

        let a = e
            .op(
                Operation::TaskProviderSet,
                json!({"provider": P, "copy": true}),
            )
            .await
            .unwrap();
        assert_eq!(a, json!({"provider": P, "copied": 3}));
        assert_eq!(e.settings().tasks.provider, P);
        assert_eq!(e.settings().tasks.copy_offered, vec![P.to_string()]);
        let copies: Vec<Record> = e
            .of(P)
            .into_iter()
            .filter(|t| t.data["copiedFrom"].is_string())
            .collect();
        assert_eq!(copies.len(), 3, "the open Local tasks are copied");
        for c in &copies {
            let from = e.task(c.data["copiedFrom"].as_str().unwrap()).unwrap();
            assert_eq!(c.data["key"], from["key"], "a copy keeps its task's key");
            assert_eq!(c.data["text"], from["text"]);
            assert_eq!(c.data["pending"], true);
            let last = c.data["history"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()
                .clone();
            assert_eq!(last["text"], "Copied from Connect");
        }
        assert_eq!(e.task("r1").unwrap()["provider"], P, "review is re-stamped");
        let now_locals: Vec<Value> = ["l1", "l2", "l3", "d1"]
            .iter()
            .map(|id| e.task(id).unwrap())
            .collect();
        assert_eq!(now_locals, locals, "Local tasks are untouched");
        e.sync().await;
        assert_eq!(e.calls_of("create").len(), 3);
        assert_eq!(e.fake.tasks().len(), 3);

        // Todoist turned off: three edits wait.
        e.fake.set_available(todoist(false));
        for (i, c) in copies.iter().enumerate() {
            e.save(json!({"id": c.id, "due": format!("2026-12-0{}", i + 1)}));
        }
        assert_eq!(e.sync().await.state, "off");
        assert_eq!(e.counts(), (3, 0));

        // Back to Connect: nothing deleted, the review task comes back, the edits stay queued.
        let a = e
            .op(Operation::TaskProviderSet, json!({"provider": "local"}))
            .await
            .unwrap();
        assert_eq!(a, json!({"provider": "local", "copied": 0}));
        assert_eq!(e.of(P).len(), 3, "Todoist's records are kept, hidden");
        assert!(e.task("r1").unwrap().get("provider").is_none());
        let shown = tasks::active(&e.core.repo().unwrap(), "personal").unwrap();
        assert_eq!(shown.len(), 5, "Connect shows its own tasks only");
        let calls = e.fake.calls().len();
        e.fake.set_available(todoist(true));
        e.sync().await;
        assert_eq!(
            e.fake.calls().len(),
            calls,
            "no call while Connect is chosen"
        );
        assert_eq!(e.counts(), (3, 0));

        // Todoist again, with a second copy: nothing new; the three edits go once.
        let a = e
            .op(
                Operation::TaskProviderSet,
                json!({"provider": P, "copy": true}),
            )
            .await
            .unwrap();
        assert_eq!(a, json!({"provider": P, "copied": 0}));
        assert_eq!(e.settings().tasks.copy_offered, vec![P.to_string()]);
        assert_eq!(e.of(P).len(), 4, "the 3 copies and the review task");
        e.sync().await;
        e.sync().await;
        assert_eq!(
            e.calls_of("update").len(),
            3,
            "each queued edit is sent once"
        );
        assert_eq!(e.counts(), (0, 0));
        let ops = e.fake.ops();
        assert!(
            !ops.iter().any(|o| o == "remove" || o == "complete"),
            "{ops:?}"
        );
        assert_eq!(e.fake.tasks().len(), 3);
        // The switch asked for everything again.
        assert!(e
            .calls_of("changedSince")
            .iter()
            .skip(1)
            .any(|c| c["cursor"].is_null()));
    }

    #[tokio::test]
    async fn task_provider_set_refuses_unknown_and_off_plugins() {
        let e = env("local");
        let err = e
            .op(
                Operation::TaskProviderSet,
                json!({"provider": "plugin:nope"}),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("provider"));
        assert_eq!(err.message, "Choose Connect or an installed task plugin.");
        e.fake.set_available(todoist(false));
        let err = e
            .op(Operation::TaskProviderSet, json!({"provider": P}))
            .await
            .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("provider"));
        assert_eq!(err.message, "Turn Todoist on in Settings › Plugins first.");
        assert_eq!(e.settings().tasks.provider, "local");
        assert!(e.settings().tasks.copy_offered.is_empty());
    }

    /// `task_provider_check` (Settings › Tasks's Check, design §11): Local has nothing to check;
    /// a plugin answers its `status`, or refuses with its state as `code`.
    #[tokio::test]
    async fn task_provider_check_answers_status_or_the_state() {
        let l = env("local");
        assert_eq!(
            l.core.task_provider_check().await.unwrap(),
            json!({"ok": true})
        );

        let e = env(P);
        assert_eq!(
            e.core.task_provider_check().await.unwrap(),
            json!({"ok": true, "account": "Taylor Morgan", "project": "Connect"})
        );

        e.fake.answer("status", Err(ProviderError::NeedsToken));
        let err = e.core.task_provider_check().await.unwrap_err();
        assert_eq!(err.code, "needs_token");
        assert_eq!(err.message, "Todoist needs your API token.");

        e.fake.answer("status", Err(ProviderError::Offline));
        let err = e.core.task_provider_check().await.unwrap_err();
        assert_eq!(err.code, "offline");
        assert_eq!(err.message, "Todoist can’t be reached right now.");

        // A refusal that would echo the stored secret is dropped for a plain sentence instead.
        e.fake.set_secret(SENTINEL);
        e.fake.answer(
            "status",
            Err(ProviderError::Refused(format!("x {SENTINEL}"))),
        );
        let err = e.core.task_provider_check().await.unwrap_err();
        assert_eq!(err.code, "refused");
        assert_eq!(err.message, "Todoist didn’t accept the request.");
        assert!(!err.message.contains(SENTINEL));
    }

    #[tokio::test]
    async fn withdraw_drops_an_unsent_create_or_removes_a_sent_one() {
        let e = env(P);
        // Not sent yet: the create is dropped, nothing reaches Todoist, nothing is pending.
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}));
        let a = e
            .op(Operation::TaskWithdraw, json!({"ids": ["t1", "gone"]}))
            .await
            .unwrap();
        assert_eq!(a, json!({"done": 1, "failed": 1}));
        let t1 = e.task("t1").unwrap();
        assert_eq!(t1["status"], "review");
        assert_eq!(e.history("t1").last().unwrap(), "Moved back to review");
        assert_eq!(t1["pending"], false, "nothing waits for it any more");
        assert!(e.outbox().is_empty());
        e.sync().await;
        assert!(e.calls_of("create").is_empty());

        // Sent: a remove (not a close), the key withdrawn, and a later add creates again.
        e.save(json!({"id": "t2", "text": "Book a room for demo day"}));
        e.sync().await;
        let t2 = e.task("t2").unwrap();
        let (rid, key) = (t2["remote"]["id"].clone(), t2["key"].clone());
        let key = key.as_str().unwrap();
        e.op(Operation::TaskWithdraw, json!({"ids": ["t2"]}))
            .await
            .unwrap();
        let t2 = e.task("t2").unwrap();
        assert_eq!(t2["status"], "review");
        assert!(t2["remote"].is_null());
        assert_eq!(e.ledger(key).unwrap()["state"], "withdrawn");
        let waiting = e.outbox();
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0]["op"], "remove");
        e.sync().await;
        assert_eq!(e.calls_of("remove"), vec![json!({"id": rid})]);
        assert!(e.calls_of("complete").is_empty());
        assert!(e.fake.tasks().is_empty());
        assert_eq!(e.ledger(key).unwrap()["state"], "withdrawn");
        assert_eq!(e.task("t2").unwrap()["pending"], false);

        e.save(json!({"id": "t2", "status": "todo", "log": "Accepted from review"}));
        e.sync().await;
        assert_eq!(e.calls_of("create").len(), 2);
        let made: Vec<Value> = e.fake.tasks();
        assert_eq!(made.len(), 1);
        assert_eq!(made[0]["key"], key);
        assert_eq!(e.ledger(key).unwrap()["state"], "created");

        // Local: the move back to review only.
        let l = env("local");
        l.save(json!({"id": "x", "text": "Local thing"}));
        l.op(Operation::TaskWithdraw, json!({"ids": ["x"]}))
            .await
            .unwrap();
        assert_eq!(l.task("x").unwrap()["status"], "review");
        assert_eq!(l.history("x").last().unwrap(), "Moved back to review");
        assert!(l
            .core
            .repo()
            .unwrap()
            .records_of_kind(outbox::KIND)
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn bulk_moves_and_answers_before_for_undo() {
        let e = env(P);
        e.save(json!({"id": "t1", "text": "Send the follow-ups", "due": "2026-11-19"}));
        e.save(json!({"id": "t2", "text": "Check with Marek"}));
        let a = e
            .op(
                Operation::TaskBulk,
                json!({"items": [{"id": "t1", "due": "2026-11-24"}, {"id": "t2", "status": "done"},
                    {"id": "gone", "due": "2026-11-24"}]}),
            )
            .await
            .unwrap();
        assert_eq!(a["done"], 2);
        assert_eq!(a["failed"], 1);
        assert_eq!(
            a["before"],
            json!([{"id": "t1", "due": "2026-11-19", "status": "todo"},
                {"id": "t2", "due": null, "status": "todo"}])
        );
        assert_eq!(e.task("t1").unwrap()["due"], "2026-11-24");
        assert_eq!(e.task("t2").unwrap()["status"], "done");
        assert_eq!(e.task("t2").unwrap()["pending"], true);

        let undo = e
            .op(Operation::TaskBulk, json!({"items": a["before"]}))
            .await
            .unwrap();
        assert_eq!(undo["done"], 2);
        assert_eq!(e.task("t1").unwrap()["due"], "2026-11-19");
        assert_eq!(e.task("t2").unwrap()["status"], "todo");

        // A move To review or Dismissed is a withdraw, never a bulk move.
        for status in ["review", "dismissed"] {
            let err = e
                .op(
                    Operation::TaskBulk,
                    json!({"items": [{"id": "t1", "status": status}]}),
                )
                .await
                .unwrap_err();
            assert_eq!(err.field.as_deref(), Some("items"), "{status}");
        }
        assert_eq!(e.task("t1").unwrap()["status"], "todo");

        let many: Vec<Value> = (0..201).map(|i| json!({"id": format!("t{i}")})).collect();
        let err = e
            .op(Operation::TaskBulk, json!({"items": many}))
            .await
            .unwrap_err();
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("items"));
        assert_eq!(err.message, "Choose up to 200 tasks.");
    }

    fn hash(evidence: &str) -> String {
        Sha1::digest(evidence.as_bytes())
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[tokio::test]
    async fn handled_keep_and_done() {
        let e = env(P);
        e.save(json!({"id": "t1", "text": "Reply to Olga about SOW section 4", "kind": "reply"}));
        let said = "Olga said thanks in the thread";
        let a = e
            .op(
                Operation::TaskHandled,
                json!({"id": "t1", "evidence": said}),
            )
            .await
            .unwrap();
        assert_eq!(a, json!({"id": "t1"}));
        let h = e.task("t1").unwrap()["handled"].clone();
        assert_eq!(h["evidence"], said);
        assert_eq!(h["auto"], false);
        assert_eq!(
            e.task("t1").unwrap()["status"],
            "todo",
            "evidence only flags"
        );

        e.op(
            Operation::TaskHandled,
            json!({"id": "t1", "action": "keep"}),
        )
        .await
        .unwrap();
        let t = e.task("t1").unwrap();
        assert!(t["handled"].is_null());
        assert_eq!(t["keptEvidence"], json!([hash(said)]));
        e.op(
            Operation::TaskHandled,
            json!({"id": "t1", "evidence": said}),
        )
        .await
        .unwrap();
        assert!(
            e.task("t1").unwrap()["handled"].is_null(),
            "kept evidence never flags it again"
        );

        e.op(
            Operation::TaskHandled,
            json!({"id": "t1", "evidence": "The file arrived"}),
        )
        .await
        .unwrap();
        e.op(
            Operation::TaskHandled,
            json!({"id": "t1", "action": "done"}),
        )
        .await
        .unwrap();
        let t = e.task("t1").unwrap();
        assert_eq!(t["status"], "done");
        assert!(t["handled"].is_null());
        assert_eq!(t["pending"], true, "the completion goes to Todoist");

        let err = e
            .op(
                Operation::TaskHandled,
                json!({"id": "t1", "action": "maybe"}),
            )
            .await
            .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("action"));
        let err = e
            .op(
                Operation::TaskHandled,
                json!({"id": "gone", "action": "keep"}),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    #[tokio::test]
    async fn delete_with_a_provider_removes_and_undo_creates_again() {
        let e = env(P);
        e.save(json!({"id": "t1", "text": "Approve the hotfix"}));
        e.sync().await;
        let t = e.task("t1").unwrap();
        let (rid, key) = (
            t["remote"]["id"].clone(),
            t["key"].as_str().unwrap().to_string(),
        );
        let a = e
            .op(Operation::TaskDelete, json!({"id": "t1"}))
            .await
            .unwrap();
        assert!(e.task("t1").is_none());
        assert_eq!(e.ledger(&key).unwrap()["state"], "removed");
        let waiting = e.outbox();
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0]["op"], "remove");

        // Undo saves the body back: a create under the same key.
        let mut body = a["body"].clone();
        body["id"] = "t1".into();
        e.op(Operation::TaskSave, body).await.unwrap();
        assert_eq!(e.task("t1").unwrap()["key"], key.as_str());
        e.sync().await;
        assert_eq!(e.calls_of("remove"), vec![json!({"id": rid})]);
        assert_eq!(e.calls_of("create").len(), 2);
        let made = e.fake.tasks();
        assert_eq!(made.len(), 1);
        assert_eq!(made[0]["key"], key.as_str());
        assert_ne!(made[0]["id"], rid);
        let ledger = e.ledger(&key).unwrap();
        assert_eq!(ledger["state"], "created");
        assert_eq!(ledger["remoteId"], made[0]["id"]);
    }

    /// Carried MUST-fix: a remove parked before the same key was made again never deletes the
    /// new task's remote, whether the create drops it or Try again checks the ledger.
    #[tokio::test]
    async fn a_parked_remove_never_deletes_the_task_made_again_with_its_key() {
        let e = env(P);
        e.save(json!({"id": "t1", "text": "Approve the hotfix"}));
        e.sync().await;
        let rid = e.task("t1").unwrap()["remote"]["id"].clone();
        let a = e
            .op(Operation::TaskDelete, json!({"id": "t1"}))
            .await
            .unwrap();
        e.fake.answer(
            "remove",
            Err(ProviderError::Refused(
                "Todoist didn't accept the change (400)".into(),
            )),
        );
        e.sync().await;
        assert_eq!(e.counts(), (0, 1), "the remove is parked");
        let mut body = a["body"].clone();
        body["id"] = "t1".into();
        e.op(Operation::TaskSave, body).await.unwrap();
        e.sync().await;
        assert_eq!(
            e.task("t1").unwrap()["remote"]["id"],
            rid,
            "the open task is adopted"
        );
        assert_eq!(e.counts(), (0, 0), "the stale remove went with the create");
        e.op(
            Operation::TaskParked,
            json!({"id": "t1", "action": "retry"}),
        )
        .await
        .unwrap();
        e.sync().await;
        assert_eq!(e.calls_of("remove").len(), 1);
        assert_eq!(e.fake.tasks().len(), 1);

        // A stale parked remove still there: Try again checks the ledger and drops it.
        let key = e.task("t1").unwrap()["key"].as_str().unwrap().to_string();
        {
            let mut r = e.core.repo().unwrap();
            let seq = outbox::next_seq(&r).unwrap();
            let stale = outbox::entry_for(
                "t1",
                "personal",
                P,
                "remove",
                json!({"id": rid, "key": key}),
                seq,
                now(),
            );
            r.put_record_unversioned(&stale).unwrap();
            outbox::park(&mut r, &stale.data, None, "refused").unwrap();
        }
        assert_eq!(e.counts(), (0, 1));
        e.op(
            Operation::TaskParked,
            json!({"id": "t1", "action": "retry"}),
        )
        .await
        .unwrap();
        assert_eq!(e.counts(), (0, 0));
        e.sync().await;
        assert_eq!(e.calls_of("remove").len(), 1, "nothing else was removed");
        assert_eq!(e.fake.tasks().len(), 1);
        assert_eq!(e.task("t1").unwrap()["pending"], false);
    }

    #[tokio::test]
    async fn parked_changes_try_again_or_discard() {
        let e = env(P);
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}));
        e.sync().await;
        let refused = || {
            Err(ProviderError::Refused(
                "Todoist needs a date like 2026-11-20.".into(),
            ))
        };
        e.fake.answer("update", refused());
        e.save(json!({"id": "t1", "text": "Send the pilot user list today"}));
        e.sync().await;
        assert_eq!(e.counts(), (0, 1));
        assert_eq!(
            e.task("t1").unwrap()["syncError"],
            "Todoist needs a date like 2026-11-20."
        );
        let a = e
            .op(
                Operation::TaskParked,
                json!({"id": "t1", "action": "retry"}),
            )
            .await
            .unwrap();
        assert_eq!(a, json!({"id": "t1"}));
        assert_eq!(e.counts(), (1, 0));
        assert!(e.task("t1").unwrap()["syncError"].is_null());
        e.sync().await;
        assert_eq!(e.fake.tasks()[0]["text"], "Send the pilot user list today");

        // Discard: the entry goes and the task's fields are Todoist's again.
        e.fake.answer("update", refused());
        e.save(json!({"id": "t1", "text": "Something Todoist refuses", "due": "2026-11-30"}));
        e.sync().await;
        assert_eq!(e.counts(), (0, 1));
        e.op(
            Operation::TaskParked,
            json!({"id": "t1", "action": "discard"}),
        )
        .await
        .unwrap();
        let t = e.task("t1").unwrap();
        assert_eq!(t["text"], "Send the pilot user list today");
        assert!(t["due"].is_null());
        assert_eq!(t["pending"], false);
        assert!(t["syncError"].is_null());
        assert_eq!(e.counts(), (0, 0));

        let err = e
            .op(
                Operation::TaskParked,
                json!({"id": "t1", "action": "later"}),
            )
            .await
            .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("action"));
    }

    #[tokio::test]
    async fn create_by_key_is_idempotent() {
        let e = env(P);
        let key = keys::task_key("automation:a1:m1", "Reply to Olga");
        let body = json!({"text": "Reply to Olga", "kind": "reply"});
        let (id, created) = tasks::create_by_key(&e.core, "personal", &body, &key).unwrap();
        assert!(created);
        let t = e.task(&id).unwrap();
        assert_eq!(t["key"], key.as_str());
        assert_eq!(t["provider"], P);
        assert_eq!(t["pending"], true);
        assert_eq!(
            tasks::create_by_key(&e.core, "personal", &body, &key).unwrap(),
            (id.clone(), false)
        );
        e.sync().await;
        assert_eq!(
            tasks::create_by_key(&e.core, "personal", &body, &key).unwrap(),
            (id, false)
        );
        assert_eq!(e.calls_of("create").len(), 1);

        // A key the ledger knows makes nothing, live or removed in Todoist (design §3: a task
        // deleted there is not made again by a rerun); one withdrawn is made again.
        let live = keys::task_key("automation:a1:m2", "Send the deck");
        let gone = keys::task_key("automation:a1:m3", "Send the notes");
        let back = keys::task_key("automation:a1:m4", "Send the slides");
        {
            let mut r = e.core.repo().unwrap();
            keys::ledger_put(&mut r, P, &live, Some("9000"), "created", now()).unwrap();
            keys::ledger_put(&mut r, P, &gone, Some("9001"), "removed", now()).unwrap();
            keys::ledger_put(&mut r, P, &back, Some("9002"), "withdrawn", now()).unwrap();
        }
        let by_key = |text: &str, key: &str| {
            tasks::create_by_key(&e.core, "personal", &json!({"text": text}), key).unwrap()
        };
        assert_eq!(
            by_key("Send the deck", &live),
            ("todoist-9000".to_string(), false)
        );
        assert_eq!(
            by_key("Send the notes", &gone),
            ("todoist-9001".to_string(), false),
            "deleted in Todoist: not made again"
        );
        for key in [&live, &gone] {
            assert!(!e.of(P).iter().any(|t| t.data["key"] == key.as_str()));
        }
        assert!(by_key("Send the slides", &back).1, "withdrawn: made again");

        let err = tasks::create_by_key(&e.core, "personal", &json!({"text": "x"}), "NOT-A-KEY")
            .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("key"));
    }

    /// Review Important 1: Undo lands while the create is on its way. Todoist made the task, but
    /// the user withdrew it: it is removed there, and Connect's task stays To review.
    #[tokio::test]
    async fn a_withdraw_while_the_create_is_on_its_way_removes_it() {
        let e = env(P);
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}));
        let key = e.task("t1").unwrap()["key"].as_str().unwrap().to_string();
        let core = e.core.clone();
        e.fake.during("create", move || {
            super::withdraw_one(&mut core.repo().unwrap(), "personal", "t1", now()).unwrap();
        });
        e.sync().await;
        let t = e.task("t1").unwrap();
        assert_eq!(t["status"], "review");
        assert!(t["remote"]["id"].is_null(), "{t}");
        assert_eq!(e.ledger(&key).unwrap()["state"], "withdrawn");
        e.sync().await;
        assert_eq!(e.calls_of("remove").len(), 1);
        assert!(e.fake.tasks().is_empty(), "nothing stays in Todoist");
        assert_eq!(e.task("t1").unwrap()["pending"], false);
        assert_eq!(e.counts(), (0, 0));
    }

    /// Review Important 3: a keyless Local task (from before keys) copied once is never copied
    /// again, even after its text changed.
    #[tokio::test]
    async fn a_second_copy_of_a_keyless_task_makes_nothing() {
        let e = env("local");
        e.save(json!({"id": "l1", "text": "Send the pilot user list"}));
        {
            let mut r = e.core.repo().unwrap();
            let mut t = r.record(tasks::KIND, "l1", None, Some("personal")).unwrap();
            t.data.as_object_mut().unwrap().remove("key");
            r.put_record(&t).unwrap();
        }
        let a = e
            .op(
                Operation::TaskProviderSet,
                json!({"provider": P, "copy": true}),
            )
            .await
            .unwrap();
        assert_eq!(a["copied"], 1);
        let copy = e.of(P).remove(0);
        assert_eq!(
            e.task("l1").unwrap()["key"],
            copy.data["key"],
            "the key the copy got is kept on the Local task"
        );
        e.op(Operation::TaskProviderSet, json!({"provider": "local"}))
            .await
            .unwrap();
        e.save(json!({"id": "l1", "text": "Send the pilot user list today"}));
        let a = e
            .op(
                Operation::TaskProviderSet,
                json!({"provider": P, "copy": true}),
            )
            .await
            .unwrap();
        assert_eq!(a["copied"], 0);
        assert_eq!(e.of(P).len(), 1);
    }

    /// Review Minor 1: discarding a parked create drops what waited behind it.
    #[tokio::test]
    async fn discarding_a_parked_create_drops_its_later_entries() {
        let e = env(P);
        e.fake.answer(
            "create",
            Err(ProviderError::Refused(
                "Todoist needs a date like 2026-11-20.".into(),
            )),
        );
        e.save(json!({"id": "t1", "text": "Bad"}));
        e.sync().await;
        e.save(json!({"id": "t1", "status": "done"}));
        assert_eq!(e.counts(), (1, 1));
        e.op(
            Operation::TaskParked,
            json!({"id": "t1", "action": "discard"}),
        )
        .await
        .unwrap();
        let t = e.task("t1").unwrap();
        assert_eq!(t["status"], "review");
        assert_eq!(t["pending"], false);
        assert_eq!(e.counts(), (0, 0));
    }

    /// Review Minor 2: discarding a withdraw's parked remove gives the task its Todoist task
    /// back; the pull makes no second record for it.
    #[tokio::test]
    async fn discarding_a_withdraws_parked_remove_relinks_the_task() {
        let e = env(P);
        e.save(json!({"id": "t1", "text": "Book a room for demo day"}));
        e.sync().await;
        let rid = e.task("t1").unwrap()["remote"]["id"].clone();
        e.op(Operation::TaskWithdraw, json!({"ids": ["t1"]}))
            .await
            .unwrap();
        e.fake.answer(
            "remove",
            Err(ProviderError::Refused(
                "Todoist didn't accept the change (400)".into(),
            )),
        );
        e.sync().await;
        assert_eq!(e.counts(), (0, 1));
        e.op(
            Operation::TaskParked,
            json!({"id": "t1", "action": "discard"}),
        )
        .await
        .unwrap();
        let t = e.task("t1").unwrap();
        assert_eq!(t["remote"]["id"], rid);
        assert_eq!(t["status"], "todo");
        e.fake.put_remote(
            json!({"id": rid, "key": t["key"], "text": "Book a room for Friday",
            "done": false, "labels": ["connect"]}),
        );
        {
            // The next run pulls (a pull waits 60 s otherwise).
            let mut r = e.core.repo().unwrap();
            let mut st = sync::load_state(&r, P).unwrap();
            st["lastPull"] = Value::Null;
            sync::save_state(&mut r, P, &st, now()).unwrap();
        }
        e.sync().await;
        assert_eq!(e.of(P).len(), 1, "one Connect task for one Todoist task");
        assert_eq!(e.task("t1").unwrap()["text"], "Book a room for Friday");
        assert!(e.calls_of("create").len() == 1);
    }

    const ACCT: &str = "7f1c2a4e-0000-4000-8000-000000000001";

    /// Signed in, with meeting `m1` whose folder is `folder`.
    fn with_meeting(core: &Core, folder: &std::path::Path) {
        let mut r = core.repo().unwrap();
        r.save_connection(&crate::workspace::models::Connection {
            id: ACCT.into(),
            account_key: ACCT.into(),
            display_name: "Taylor Morgan".into(),
            email: "taylor@example.test".into(),
            user_id: "me-1".into(),
            generation: 1,
            policy_revision: 1,
            status: "connected".into(),
            ..Default::default()
        })
        .unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some(ACCT.into());
        r.settings_update(&s).unwrap();
        r.put_record(&Record {
            id: "m1".into(),
            kind: "meeting".into(),
            connection_id: Some(ACCT.into()),
            workspace_id: None,
            source: "calendar:cal-1".into(),
            revision: "r".into(),
            updated_at: now(),
            data: json!({"eventId": "m1", "title": "Philips sync", "start": "2026-11-04T14:00:00Z",
                "end": "2026-11-04T14:30:00Z", "state": "downloaded",
                "folder": folder.to_string_lossy()}),
        })
        .unwrap();
    }

    /// Review Important 2: a meeting's `tasks.json` (what `echo.read('calls')` and other tools
    /// read) keeps every action item through switches and copies, each once.
    #[tokio::test]
    async fn tasks_json_keeps_every_providers_items_once() {
        let e = env("local");
        let folder = e._dir.path().join("m1");
        std::fs::create_dir_all(&folder).unwrap();
        with_meeting(&e.core, &folder);
        let items = || -> Vec<String> {
            let v: Value =
                serde_json::from_slice(&std::fs::read(folder.join("tasks.json")).unwrap()).unwrap();
            let mut t: Vec<String> = v
                .as_array()
                .unwrap()
                .iter()
                .map(|i| i["task"].as_str().unwrap().to_string())
                .collect();
            t.sort();
            t
        };
        e.save(json!({"id": "a", "text": "Send the deck", "meetingId": "m1", "line": 1}));
        e.save(json!({"id": "b", "text": "Close the SOW", "meetingId": "m1", "line": 2, "status": "done"}));
        e.save(json!({"id": "c", "text": "Book a room", "meetingId": "m1", "line": 3, "status": "review"}));
        let all = vec!["Book a room", "Close the SOW", "Send the deck"];
        assert_eq!(items(), all);
        e.op(
            Operation::TaskProviderSet,
            json!({"provider": P, "copy": true}),
        )
        .await
        .unwrap();
        assert_eq!(
            items(),
            all,
            "a copy is not a second item, and nothing vanished"
        );
        e.op(Operation::TaskProviderSet, json!({"provider": "local"}))
            .await
            .unwrap();
        e.save(json!({"id": "b", "notes": "Signed"}));
        assert_eq!(items(), all);
        // The review task follows the switch, and the file follows it.
        let v: Value =
            serde_json::from_slice(&std::fs::read(folder.join("tasks.json")).unwrap()).unwrap();
        assert!(v.as_array().unwrap().iter().any(|i| i["id"] == "c"));
    }
}
