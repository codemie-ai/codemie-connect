//! The `task_sync` job (design §4, rulings 4, 10, 11): it pushes the outbox to the active
//! provider, oldest first, then pulls what changed there and merges it into the cache.
//!
//! - **Push**, at most 50 entries a pass. A task's entries wait for its `create` to have a remote
//!   id. A `create` stores the remote id in the task and the ledger, in one transaction, before
//!   its entry goes, so a create replayed after a crash is caught by the provider's key lookup.
//!   A content refusal (`refused`, `not_found`) parks only that entry; `offline`, `rate_limited`
//!   and `needs_token` stop the pass and keep the order.
//! - **Pull** `changedSince` with the cursor kept in the bookkeeping record `task_state`
//!   `sync:<provider>`; at once after a push, else at most every 60 s. While an `update` waits the
//!   pull comes first, so the merge decides a field changed on both sides, and the update then
//!   sends only what still differs from the provider's last-seen fields. After [`reread`] (a
//!   switch, Check, a changed setting) it pulls since the cursor, then the full list, and retires
//!   cached open tasks the full list no longer holds (deleted nowhere).
//! - **Backoff**: `offline` retries after 30 s, doubling to 15 minutes, reset on success;
//!   `rate_limited` waits for its `retryAt`; `needs_token` makes no call until the token is saved
//!   again (`Core::task_secret_saved`).
//! - **Budget**: at most 4 requests a second and 300 in any 15 minutes, kept by waiting (a short
//!   wait in the pass, a later job for a long one).
//!
//! The state record holds `{cursor, lastSync, lastPull, lastRun, backoffUntil, backoff, state,
//! message, requests, reread?}`; `requests` are the times (ms) of the calls of the last 15
//! minutes. No provider text reaches it, a job record or a log unless it passed `secret_matches`.
use super::{merge, outbox, wire, ProviderError, TaskProviders};
use crate::workspace::meetings::model::MeAlias;
use crate::workspace::models::{id, Job, Record, Result, WorkspaceError};
use crate::workspace::repository::Repository;
use crate::workspace::{new_job, tasks, Core};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// The record kind of the sync state (shared with the due-today reminder's bookkeeping).
pub(crate) const STATE_KIND: &str = "task_state";
/// The job kind.
pub(crate) const JOB_KIND: &str = "task_sync";
/// Where tasks pulled from a provider live, with the state record.
const WORKSPACE: &str = "personal";
/// The most outbox entries one pass sends.
const PASS_MAX: usize = 50;
/// A pass sends nothing more after this long, well inside the job's 300 s lease (which the
/// background loop also renews every 15 s), so one pass never runs twice at once.
const PASS_TIME: std::time::Duration = std::time::Duration::from_secs(120);
/// The fields an `update` can carry.
const UPDATABLE: [&str; 5] = ["text", "notes", "due", "kind", "owner"];
/// A pull at most this often (s), unless something was pushed.
const PULL_EVERY: i64 = 60;
const BACKOFF_MIN: i64 = 30;
const BACKOFF_MAX: i64 = 900;
/// `rate_limited` without a `Retry-After`.
const RATE_LIMITED_DEFAULT: u64 = 60;
const PER_SECOND: usize = 4;
const PER_WINDOW: usize = 300;
const WINDOW_MS: i64 = 15 * 60 * 1000;

/// What one run did; its `summary` is the job's result (codes and counts, never provider text).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    /// `ready`, `offline`, `rate_limited`, `needs_token`, `off` or `failed`.
    pub state: String,
    pub pushed: usize,
    pub parked: usize,
    pub pulled: usize,
    pub removed: usize,
}
impl SyncOutcome {
    fn of(state: &str) -> Self {
        Self {
            state: state.into(),
            ..Default::default()
        }
    }
    pub(crate) fn summary(&self) -> String {
        format!(
            "Tasks {}: {} sent, {} parked, {} changed, {} removed",
            self.state, self.pushed, self.parked, self.pulled, self.removed
        )
    }
}

fn state_id(provider: &str) -> String {
    format!("sync:{provider}")
}

/// The sync state of `provider` (`{}` before its first run).
pub(crate) fn load_state(r: &Repository, provider: &str) -> Result<Value> {
    match r.record(STATE_KIND, &state_id(provider), None, Some(WORKSPACE)) {
        Ok(rec) => Ok(rec.data),
        Err(e) if e.code == "not_found" => Ok(json!({})),
        Err(e) => Err(e),
    }
}

pub(crate) fn save_state(r: &mut Repository, provider: &str, st: &Value, now: i64) -> Result<()> {
    r.put_record_unversioned(&Record {
        id: state_id(provider),
        kind: STATE_KIND.into(),
        connection_id: None,
        workspace_id: Some(WORKSPACE.into()),
        source: "local".into(),
        revision: id(),
        updated_at: now,
        data: st.clone(),
    })
}

/// Asks `provider` for everything again (design §4 "Budget": a switch, Check, or a changed
/// provider setting such as its project): the next run pulls what changed since its cursor, then
/// the full list, and retires cached tasks the full list no longer holds. Queues that run now.
/// Each request is a new token, so a run that started before it keeps it (`Run::finish`).
pub(crate) fn reread(r: &mut Repository, provider: &str, now: i64) -> Result<()> {
    let mut st = load_state(r, provider)?;
    st["reread"] = id().into();
    st["lastPull"] = Value::Null;
    save_state(r, provider, &st, now)?;
    queue(r, provider, now)
}

fn of_provider(job: &Job, provider: &str) -> bool {
    job.kind == JOB_KIND && job.payload["provider"] == provider
}

/// Whether a `task_sync` job of `provider` runs now.
pub(crate) fn running(r: &Repository, provider: &str, now: i64) -> Result<bool> {
    Ok(r.jobs()?.iter().any(|j| {
        of_provider(j, provider) && j.state == "running" && j.lease_until.unwrap_or(0) >= now
    }))
}

/// Queues a `task_sync` job for `provider`, due at `due`, unless one is queued already (which is
/// brought forward to `due` when it was later).
pub(crate) fn queue(r: &mut Repository, provider: &str, due: i64) -> Result<()> {
    if let Some(mut queued) = r
        .jobs()?
        .into_iter()
        .find(|j| of_provider(j, provider) && j.state == "queued")
    {
        if queued.due_at > due {
            queued.due_at = due;
            r.save_job(&queued)?;
        }
        return Ok(());
    }
    let policy = r.policy(None, None)?;
    r.enqueue(&new_job(
        JOB_KIND,
        format!("{JOB_KIND}:{provider}:{}", id()),
        None,
        None,
        due,
        policy,
        json!({"provider": provider}),
    ))
}

/// Why a pass stopped before its end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Offline,
    RateLimited(u64),
    NeedsToken,
    /// The 15-minute budget is spent until this time (s).
    Budget(i64),
}

/// Seconds and milliseconds from the run's `now`, advanced by tokio's clock.
struct Clock {
    start_ms: i64,
    started: tokio::time::Instant,
}
impl Clock {
    fn ms(&self) -> i64 {
        self.start_ms + self.started.elapsed().as_millis() as i64
    }
    fn secs(&self) -> i64 {
        self.ms().div_euclid(1000)
    }
}

struct Run<'a> {
    core: &'a Arc<Core>,
    providers: Arc<dyn TaskProviders>,
    plugin: String,
    provider: String,
    st: Value,
    requests: Vec<i64>,
    clock: Clock,
    me: MeAlias,
    outcome: SyncOutcome,
    /// More entries wait than one pass sends.
    more: bool,
    /// A refusal's sentence this run (already checked against the secret).
    message: Option<String>,
    /// A pull ran this run.
    pulled: bool,
    /// The re-read token the run started with (`null`: none asked for).
    reread: Value,
}

/// The `task_sync` job's executor: one push and pull with `provider` (`plugin:<id>`), at `now`.
pub(crate) async fn run(core: &Arc<Core>, provider: &str, now: i64) -> Result<SyncOutcome> {
    let plugin = provider
        .strip_prefix("plugin:")
        .ok_or_else(|| WorkspaceError::new("validation", "Choose an installed task plugin."))?;
    let (mut st, me) = {
        let r = core.repo()?;
        let s = r.settings()?;
        // Switched away: its cache and unsent changes wait, untouched, for it to be chosen
        // again (design §11, ruling 16).
        if super::active_provider(&s) != provider {
            return Ok(SyncOutcome::of("inactive"));
        }
        let me = s
            .active_connection
            .as_deref()
            .and_then(|cid| r.connection(cid).ok())
            .map(|c| core.me_alias(&c, &s.meetings))
            .unwrap_or_default();
        (load_state(&r, provider)?, me)
    };
    // Every run counts for the cadence, one that makes no call too.
    st["lastRun"] = now.into();
    // Off or not loaded: no call; changes keep queueing.
    let available = core
        .task_providers
        .get()
        .cloned()
        .map(|p| (p.available().into_iter().find(|i| i.id == provider), p));
    let idle = match &available {
        None | Some((None, _)) => Some("failed"),
        Some((Some(p), _)) if !p.on => Some("off"),
        Some((Some(p), _)) if !p.ready => Some("failed"),
        Some(_) => None,
    };
    let (Some((_, providers)), None) = (available, idle) else {
        save_state(&mut *core.repo()?, provider, &st, now)?;
        return Ok(SyncOutcome::of(idle.unwrap_or("failed")));
    };
    let waiting_state = st["state"].as_str().unwrap_or("ready").to_string();
    let backoff_until = st["backoffUntil"].as_i64().unwrap_or(0);
    if waiting_state == "needs_token" || backoff_until > now {
        save_state(&mut *core.repo()?, provider, &st, now)?;
        return Ok(SyncOutcome::of(&waiting_state));
    }
    let requests: Vec<i64> = st["requests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_i64)
        .collect();
    // Never earlier than the last call made: the budget counts from it.
    let start_ms = (now * 1000).max(requests.last().copied().unwrap_or(0));
    let mut run = Run {
        core,
        providers,
        plugin: plugin.to_string(),
        provider: provider.to_string(),
        st,
        requests,
        clock: Clock {
            start_ms,
            started: tokio::time::Instant::now(),
        },
        me,
        outcome: SyncOutcome::of("ready"),
        more: false,
        message: None,
        pulled: false,
        reread: Value::Null,
    };
    run.reread = run.st["reread"].clone();
    let mut stop = None;
    if run.updates_wait()? {
        // Pulled first, so the merge decides a field changed on both sides (ruling 3): an older
        // offline edit never overwrites a newer one made in the provider.
        stop = run.pull(true).await?;
    }
    if stop.is_none() {
        stop = run.push().await?;
    }
    if stop.is_none() && !run.pulled {
        stop = run.pull(false).await?;
    }
    run.finish(stop)
}

impl Run<'_> {
    fn repo(&self) -> Result<std::sync::MutexGuard<'_, Repository>> {
        self.core.repo()
    }

    /// Waits for the budget, then asks the provider. `Err` when the 15-minute budget is spent.
    async fn ask(
        &mut self,
        op: &str,
        args: Value,
    ) -> std::result::Result<std::result::Result<Value, ProviderError>, Stop> {
        loop {
            let now = self.clock.ms();
            self.requests.retain(|t| *t > now - WINDOW_MS);
            if self.requests.len() >= PER_WINDOW {
                let free_ms = self.requests[self.requests.len() - PER_WINDOW] + WINDOW_MS;
                return Err(Stop::Budget((free_ms + 999).div_euclid(1000)));
            }
            let recent: Vec<i64> = self
                .requests
                .iter()
                .copied()
                .filter(|t| *t > now - 1000)
                .collect();
            if recent.len() >= PER_SECOND {
                let wait = (recent[recent.len() - PER_SECOND] + 1000 - now).max(1);
                tokio::time::sleep(std::time::Duration::from_millis(wait as u64)).await;
                continue;
            }
            self.requests.push(now);
            break;
        }
        Ok(self.providers.call(&self.plugin, op, args).await)
    }

    /// Whether an `update` waits to be sent.
    fn updates_wait(&self) -> Result<bool> {
        Ok(outbox::waiting(&*self.repo()?, &self.provider)?
            .iter()
            .any(|e| e["op"] == "update"))
    }

    /// The task as the provider takes it; my own task carries no owner, and someone else's plain
    /// task goes as `waiting` (design ruling 5: its label, prefix and owner line).
    fn wire_of(&self, task: &Record) -> Value {
        let mut w = wire::to_wire(task);
        if tasks::is_mine(&task.data, &self.me) {
            w["owner"] = Value::Null;
        }
        if !w["owner"].is_null() && w["kind"] == "task" {
            w["kind"] = "waiting".into();
        }
        w
    }

    /// A provider's failure: a stop, or `None` once a content refusal parked `entry`.
    fn failed(&mut self, entry: &Value, error: ProviderError) -> Result<Option<Stop>> {
        let code = match &error {
            ProviderError::Offline => return Ok(Some(Stop::Offline)),
            ProviderError::RateLimited { retry_after } => {
                return Ok(Some(Stop::RateLimited(*retry_after)))
            }
            ProviderError::NeedsToken => return Ok(Some(Stop::NeedsToken)),
            ProviderError::NotFound(_) => "not_found",
            ProviderError::Refused(_) => "refused",
        };
        // The host dropped a sentence holding a secret before cutting it; checked again here.
        let message = error
            .text()
            .filter(|t| !self.providers.secret_matches(&self.plugin, t))
            .map(str::to_string);
        outbox::park(&mut *self.repo()?, entry, message.as_deref(), code)?;
        self.outcome.parked += 1;
        self.message = message;
        Ok(None)
    }

    /// The task of `entry` as stored now.
    fn task_of(r: &Repository, entry: &Value) -> Result<Option<Record>> {
        let (Some(tid), Some(wid)) = (entry["taskId"].as_str(), entry["workspaceId"].as_str())
        else {
            return Ok(None);
        };
        match r.record(tasks::KIND, tid, None, Some(wid)) {
            Ok(t) => Ok(Some(t)),
            Err(e) if e.code == "not_found" => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Removes `entry` (it is done with or has nothing left to do); its task's `pending`
    /// follows.
    fn drop_entry(&self, entry: &Record) -> Result<()> {
        let mut r = self.repo()?;
        let wid = entry.workspace_id.as_deref().unwrap_or("");
        let tid = entry.data["taskId"].as_str().unwrap_or_default();
        let task = outbox::pending_put(&r, tid, wid, &[entry.id.as_str()], false)?;
        r.commit_local(
            task.as_slice(),
            &[(outbox::KIND, &entry.id, wid)],
            task.is_some(),
        )
    }

    /// The fields of `task` (as Connect would send them) that differ from the provider's task
    /// `theirs`, named for an `update`.
    fn differing(&self, task: &Record, theirs: &Value) -> serde_json::Map<String, Value> {
        let (mine, theirs) = (self.wire_of(task), wire::remote_fields(theirs));
        UPDATABLE
            .into_iter()
            .filter(|k| mine[*k] != theirs[*k])
            .map(|k| (k.to_string(), Value::Bool(true)))
            .collect()
    }

    async fn push(&mut self) -> Result<Option<Stop>> {
        let entries = outbox::waiting(&*self.repo()?, &self.provider)?;
        // Tasks whose earlier entry still waits: their later ones wait too.
        let mut blocked: HashSet<String> = HashSet::new();
        let mut sent = 0;
        for entry in entries {
            let tid = entry["taskId"].as_str().unwrap_or_default().to_string();
            if blocked.contains(&tid) {
                continue;
            }
            if sent >= PASS_MAX || self.clock.started.elapsed() >= PASS_TIME {
                self.more = true;
                break;
            }
            let (task, current) = {
                let r = self.repo()?;
                (Self::task_of(&r, &entry)?, outbox::current(&r, &entry)?)
            };
            let Some(current) = current.filter(|e| e.data["parked"] != true) else {
                continue;
            };
            let e = current.data.clone();
            let op = e["op"].as_str().unwrap_or_default().to_string();
            let remote_id = task
                .as_ref()
                .and_then(|t| t.data["remote"]["id"].as_str().map(str::to_string));
            let args = if op == "remove" {
                // A remove aimed at a task made again under its key is stale: never sent.
                let stale = outbox::remove_is_stale(&*self.repo()?, &e)?;
                match e["patch"]["id"].as_str().filter(|_| !stale) {
                    Some(rid) => json!({"id": rid}),
                    None => {
                        self.drop_entry(&current)?;
                        continue;
                    }
                }
            } else {
                // Its task is gone: deleted before the entry was sent.
                let Some(t) = &task else {
                    self.drop_entry(&current)?;
                    continue;
                };
                if op == "create" {
                    if remote_id.is_some() {
                        self.drop_entry(&current)?;
                        continue;
                    }
                    if self.adopt_from_ledger(t, &current)? {
                        self.more = true;
                        blocked.insert(tid);
                        continue;
                    }
                    json!({"key": t.data["key"], "task": self.wire_of(t), "requestId": e["id"]})
                } else {
                    let Some(rid) = &remote_id else {
                        // Waits for its create.
                        blocked.insert(tid);
                        continue;
                    };
                    if op == "complete" {
                        json!({"id": rid, "done": e["patch"]["done"] == true, "requestId": e["id"]})
                    } else {
                        let w = self.wire_of(t);
                        let mut patch = json!({});
                        for k in e["patch"].as_object().into_iter().flatten().map(|(k, _)| k) {
                            patch[k] = w[k].clone();
                        }
                        // Whose task it is decides `waiting` (`wire_of`): the kind goes with it.
                        if patch.get("owner").is_some() {
                            patch["kind"] = w["kind"].clone();
                        }
                        // Only what still differs from the provider's last-seen fields: a field
                        // whose newer provider value the merge kept is not sent back.
                        let base = &t.data["remote"]["base"];
                        if let (Some(p), true) = (patch.as_object_mut(), base.is_object()) {
                            p.retain(|k, v| base[k] != *v);
                        }
                        if patch.as_object().is_some_and(serde_json::Map::is_empty) {
                            self.drop_entry(&current)?;
                            continue;
                        }
                        json!({"id": rid, "patch": patch, "requestId": e["id"]})
                    }
                }
            };
            sent += 1;
            let answer = match self.ask(&op, args.clone()).await {
                Ok(answer) => answer,
                Err(stop) => return Ok(Some(stop)),
            };
            match answer {
                // A create answered without an id made nothing Connect can address: parked, so
                // it shows, and the task's later entries keep waiting behind it.
                Ok(answer) if op == "create" && wire::remote_of(&answer, None)["id"].is_null() => {
                    self.failed(&e, ProviderError::Refused(String::new()))?;
                }
                Ok(answer) => {
                    self.outcome.pushed += 1;
                    match op.as_str() {
                        "create" => {
                            if self.created(&current, &answer)? {
                                self.more = true;
                            }
                        }
                        "remove" => self.removed_sent(&current)?,
                        _ => self.answered(&current, &answer)?,
                    }
                }
                Err(error) => {
                    if let Some(stop) = self.failed(&e, error)? {
                        self.note_attempt(&current, stop)?;
                        return Ok(Some(stop));
                    }
                }
            }
        }
        Ok(None)
    }

    /// Counts a temporary failure on the entry that met it (its code only).
    fn note_attempt(&self, entry: &Record, stop: Stop) -> Result<()> {
        let mut r = self.repo()?;
        let Some(mut e) = outbox::current(&r, &entry.data)? else {
            return Ok(());
        };
        e.data["attempts"] = (e.data["attempts"].as_i64().unwrap_or(0) + 1).into();
        e.data["lastError"] = match stop {
            Stop::Offline => "offline",
            Stop::RateLimited(_) => "rate_limited",
            Stop::NeedsToken => "needs_token",
            Stop::Budget(_) => "budget",
        }
        .into();
        r.commit_local(&[e], &[], false)
    }

    /// A create whose key the ledger already holds with a live remote id makes nothing new: the
    /// task takes that id and its create becomes an update of every field.
    fn adopt_from_ledger(&self, task: &Record, entry: &Record) -> Result<bool> {
        let mut r = self.repo()?;
        let Some(key) = task.data["key"].as_str() else {
            return Ok(false);
        };
        let Some(ledger) = super::keys::ledger_get(&r, &self.provider, key)? else {
            return Ok(false);
        };
        let live = matches!(ledger["state"].as_str(), Some("created" | "done"));
        let Some(rid) = ledger["remoteId"].as_str().filter(|_| live) else {
            return Ok(false);
        };
        let mut t = task.clone();
        t.data["remote"] = json!({"id": rid});
        t.revision = id();
        let mut e = entry.clone();
        e.data["op"] = "update".into();
        e.data["patch"] =
            json!({"text": true, "notes": true, "due": true, "kind": true, "owner": true});
        let stale = outbox::stale_removes(&r, &self.provider, key, Some(rid))?;
        let gone: Vec<(&str, &str, &str)> = stale
            .iter()
            .map(|s| {
                (
                    outbox::KIND,
                    s.id.as_str(),
                    s.workspace_id.as_deref().unwrap_or(""),
                )
            })
            .collect();
        r.commit_local(&[t, e], &gone, true)?;
        Ok(true)
    }

    /// The task after an entry of it is done: the provider's answer merged in (it may carry a
    /// change made there meanwhile), still `pending` while another entry waits, its `syncError`
    /// gone once none is parked.
    fn settled(
        r: &Repository,
        task: &mut Record,
        answer: &Value,
        now: i64,
        except: &[&str],
    ) -> Result<()> {
        let (mut body, lines) = merge::merge(&task.data, answer, task.updated_at);
        body["remote"]["syncedAt"] = now.into();
        let mut history = body["history"].as_array().cloned().unwrap_or_default();
        history.extend(lines.into_iter().map(|l| json!({"at": now, "text": l})));
        body["history"] = history.into();
        task.data = body;
        let others: Vec<Value> = r
            .records_of_kind(outbox::KIND)?
            .into_iter()
            .filter(|e| e.data["taskId"] == task.id.as_str() && !except.contains(&e.id.as_str()))
            .map(|e| e.data)
            .collect();
        task.data["pending"] = (!others.is_empty()).into();
        if !others.iter().any(|e| e["parked"] == true) {
            task.data["syncError"] = Value::Null;
        }
        task.revision = id();
        Ok(())
    }

    /// A create answered: the remote id goes into the task and the ledger, and the entry goes, in
    /// one transaction. Where the task now differs from the provider's answer (an edit made while
    /// the create was on its way, or a task adopted by its key that holds older words), an update
    /// is queued (design §4 "an update if fields differ").
    /// Answers whether something new was queued (a remove), for another pass.
    fn created(&self, entry: &Record, answer: &Value) -> Result<bool> {
        let now = self.clock.secs();
        let mut r = self.repo()?;
        let rid = wire::remote_of(answer, None)["id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let current = outbox::current(&r, &entry.data)?;
        let task = Self::task_of(&r, &entry.data)?;
        let wanted = current
            .as_ref()
            .is_some_and(|c| c.revision == entry.revision)
            && task
                .as_ref()
                .is_some_and(|t| !matches!(tasks::status_of(&t.data), "review" | "dismissed"));
        if !wanted {
            // Withdrawn (Undo) or deleted while the create was on its way: the provider made
            // the task, so it is removed there, and the key keeps its tombstone (ruling 8).
            let state = if task.is_some() {
                "withdrawn"
            } else {
                "removed"
            };
            let key = task
                .as_ref()
                .and_then(|t| t.data["key"].as_str())
                .or(answer["key"].as_str())
                .map(str::to_string);
            let wid = entry.workspace_id.clone().unwrap_or_default();
            let tid = entry.data["taskId"].as_str().unwrap_or_default();
            let mut puts = vec![outbox::entry_for(
                tid,
                &wid,
                &self.provider,
                "remove",
                json!({"id": rid, "key": key, "ledger": state}),
                outbox::next_seq(&r)?,
                now,
            )];
            if let Some(key) = &key {
                puts.push(super::keys::ledger_record(
                    &self.provider,
                    key,
                    Some(&rid),
                    state,
                    now,
                ));
            }
            puts.extend(outbox::pending_put(
                &r,
                tid,
                &wid,
                &[entry.id.as_str()],
                true,
            )?);
            let gone: Vec<(&str, &str, &str)> = current
                .iter()
                .map(|c| (outbox::KIND, c.id.as_str(), wid.as_str()))
                .collect();
            r.commit_local(&puts, &gone, true)?;
            return Ok(true);
        }
        let Some(mut task) = task else {
            return Ok(false);
        };
        let edited = self.differing(&task, answer);
        let mut puts = Vec::new();
        // The key lives again at `rid`: a remove parked or aimed there from an earlier life of
        // it would delete this task, so it goes with the create (carried MUST-fix).
        let stale = match task.data["key"].as_str() {
            Some(key) => outbox::stale_removes(&r, &self.provider, key, Some(&rid))?,
            None => Vec::new(),
        };
        let mut except: Vec<&str> = stale.iter().map(|s| s.id.as_str()).collect();
        except.push(&entry.id);
        Self::settled(&r, &mut task, answer, now, &except)?;
        if !edited.is_empty() {
            let seq = outbox::next_seq(&r)?;
            puts.push(outbox::entry(
                &task,
                "update",
                Value::Object(edited),
                seq,
                now,
            ));
            task.data["pending"] = true.into();
        }
        if let Some(key) = task.data["key"].as_str() {
            puts.push(super::keys::ledger_record(
                &self.provider,
                key,
                Some(&rid),
                "created",
                now,
            ));
        }
        task.updated_at = now;
        puts.push(task);
        let wid = entry.workspace_id.clone().unwrap_or_default();
        let mut gone = vec![(outbox::KIND, entry.id.as_str(), wid.as_str())];
        gone.extend(stale.iter().map(|s| {
            (
                outbox::KIND,
                s.id.as_str(),
                s.workspace_id.as_deref().unwrap_or(""),
            )
        }));
        r.commit_local(&puts, &gone, true)?;
        Ok(false)
    }

    /// An update or complete answered: the task's `remote` follows the answer; the entry goes
    /// unless it was changed (an edit coalesced into it, which gives it a new revision) while it
    /// was on its way.
    fn answered(&self, entry: &Record, answer: &Value) -> Result<()> {
        let now = self.clock.secs();
        let mut r = self.repo()?;
        let stored = outbox::current(&r, &entry.data)?;
        let unchanged = stored
            .as_ref()
            .is_some_and(|s| s.revision == entry.revision);
        let mut puts = Vec::new();
        let mut gone = Vec::new();
        let wid = entry.workspace_id.clone().unwrap_or_default();
        if unchanged {
            gone.push((outbox::KIND, entry.id.as_str(), wid.as_str()));
        }
        if let Some(mut task) = Self::task_of(&r, &entry.data)? {
            let except: &[&str] = if unchanged { &[entry.id.as_str()] } else { &[] };
            Self::settled(&r, &mut task, answer, now, except)?;
            if entry.data["op"] == "complete" {
                if let Some(key) = task.data["key"].as_str() {
                    let state = if answer["done"] == true {
                        "done"
                    } else {
                        "created"
                    };
                    let rid = task.data["remote"]["id"].as_str().map(str::to_string);
                    puts.push(super::keys::ledger_record(
                        &self.provider,
                        key,
                        rid.as_deref(),
                        state,
                        now,
                    ));
                }
            }
            puts.push(task);
        }
        r.commit_local(&puts, &gone, true)
    }

    /// A remove answered: the ledger marks the key `removed` (or `withdrawn`, as the entry says).
    fn removed_sent(&self, entry: &Record) -> Result<()> {
        let now = self.clock.secs();
        let mut r = self.repo()?;
        let mut puts = Vec::new();
        if let Some(key) = entry.data["patch"]["key"].as_str() {
            let state = entry.data["patch"]["ledger"].as_str().unwrap_or("removed");
            let rid = entry.data["patch"]["id"].as_str();
            puts.push(super::keys::ledger_record(
                &self.provider,
                key,
                rid,
                state,
                now,
            ));
        }
        let wid = entry.workspace_id.clone().unwrap_or_default();
        // A withdrawn task stays (To review): nothing waits for it any more.
        let tid = entry.data["taskId"].as_str().unwrap_or_default();
        let task = outbox::pending_put(&r, tid, &wid, &[entry.id.as_str()], false)?;
        let bump = task.is_some();
        puts.extend(task);
        r.commit_local(&puts, &[(outbox::KIND, &entry.id, &wid)], bump)
    }

    /// Pulls what changed; `force` pulls whatever the cadence says (before a push).
    async fn pull(&mut self, force: bool) -> Result<Option<Stop>> {
        let now = self.clock.secs();
        let last = self.st["lastPull"].as_i64();
        if !force && self.outcome.pushed == 0 && last.is_some_and(|t| now - t < PULL_EVERY) {
            return Ok(None);
        }
        self.pulled = true;
        let mut cursor = self.st["cursor"].clone();
        if !self.st["reread"].is_null() && !cursor.is_null() {
            // Asked to read everything again: first what changed since the cursor, so what was
            // done or deleted there meanwhile follows the usual rules (I1). A cursor the provider
            // no longer takes is skipped for the full list.
            match self.changed_since(cursor.clone()).await {
                Ok(changes) => self.apply(&changes, false)?,
                Err(None) => {}
                Err(Some(stop)) => return Ok(Some(stop)),
            }
            cursor = Value::Null;
        }
        let full = cursor.is_null();
        match self.changed_since(cursor).await {
            Ok(changes) => {
                self.apply(&changes, full)?;
                self.st["cursor"] = changes["cursor"].clone();
                self.st["lastPull"] = self.clock.secs().into();
                if let Some(st) = self.st.as_object_mut() {
                    st.remove("reread");
                }
                Ok(None)
            }
            Err(stop) => Ok(Some(stop.unwrap_or(Stop::Offline))),
        }
    }

    /// `changedSince {cursor}`; a refusal is `Err(None)`, any other failure its stop.
    async fn changed_since(&mut self, cursor: Value) -> std::result::Result<Value, Option<Stop>> {
        match self.ask("changedSince", json!({"cursor": cursor})).await {
            Err(stop) => Err(Some(stop)),
            Ok(Ok(changes)) => Ok(changes),
            Ok(Err(ProviderError::Refused(_) | ProviderError::NotFound(_))) => Err(None),
            Ok(Err(ProviderError::Offline)) => Err(Some(Stop::Offline)),
            Ok(Err(ProviderError::RateLimited { retry_after })) => {
                Err(Some(Stop::RateLimited(retry_after)))
            }
            Ok(Err(ProviderError::NeedsToken)) => Err(Some(Stop::NeedsToken)),
        }
    }

    /// Merges what changed in the provider into the cache, in one transaction. `full`: the
    /// answer lists every open task, so a cached open task it doesn't list (done or deleted
    /// there, or in a project no longer chosen) leaves the cache, deleted nowhere; one with a
    /// change still waiting stays for the push to settle.
    fn apply(&mut self, changes: &Value, full: bool) -> Result<()> {
        let now = self.clock.secs();
        let core = self.core;
        let mut r = core.repo()?;
        let mine: Vec<Record> = r
            .records_of_kind(tasks::KIND)?
            .into_iter()
            .filter(|t| t.data["provider"] == self.provider.as_str())
            .collect();
        let by_remote: HashMap<String, &Record> = mine
            .iter()
            .filter_map(|t| {
                t.data["remote"]["id"]
                    .as_str()
                    .map(|rid| (rid.to_string(), t))
            })
            .collect();
        let entries: Vec<Record> = r.records_of_kind(outbox::KIND)?;
        // When Connect last edited each task (its newest waiting entry), for the merge.
        let mut edited: HashMap<String, i64> = HashMap::new();
        for e in entries
            .iter()
            .filter(|e| e.data["provider"] == self.provider.as_str())
        {
            let tid = e.data["taskId"].as_str().unwrap_or_default().to_string();
            let at = e.data["editedAt"].as_i64().unwrap_or(0);
            let slot = edited.entry(tid).or_insert(at);
            *slot = (*slot).max(at);
        }
        let mut puts: Vec<Record> = Vec::new();
        let mut gone: Vec<(String, String, String)> = Vec::new();
        let mut seq = outbox::next_seq(&r)?;
        for v in changes["tasks"].as_array().into_iter().flatten() {
            let Some(rid) = wire::remote_of(v, None)["id"].as_str().map(str::to_string) else {
                continue;
            };
            if let Some(t) = by_remote.get(&rid) {
                let edited_at = edited.get(&t.id).copied().unwrap_or(t.updated_at);
                let (mut body, lines) = merge::merge(&t.data, v, edited_at);
                if body == t.data {
                    continue;
                }
                body["remote"]["syncedAt"] = now.into();
                let mut history = body["history"].as_array().cloned().unwrap_or_default();
                history.extend(lines.into_iter().map(|l| json!({"at": now, "text": l})));
                body["history"] = history.into();
                if body["done"] != t.data["done"] {
                    if let Some(key) = body["key"].as_str() {
                        let state = if body["done"] == true {
                            "done"
                        } else {
                            "created"
                        };
                        puts.push(super::keys::ledger_record(
                            &self.provider,
                            key,
                            Some(&rid),
                            state,
                            now,
                        ));
                    }
                }
                let mut updated = (*t).clone();
                updated.data = body;
                updated.revision = id();
                updated.updated_at = now;
                puts.push(updated);
                self.outcome.pulled += 1;
                continue;
            }
            // A task whose create got lost on the way back: the key finds it.
            let key = v["key"].as_str().filter(|k| !k.is_empty());
            // Only a task Connect sent: one To review or Dismissed (withdrawn, say) has no
            // create in flight, and its key's tombstone below keeps it out of the provider.
            if let Some(t) = key.and_then(|k| {
                mine.iter().find(|t| {
                    t.data["key"] == k
                        && t.data["remote"]["id"].is_null()
                        && !matches!(tasks::status_of(&t.data), "review" | "dismissed")
                })
            }) {
                let mut adopted = t.clone();
                adopted.data["remote"] = wire::remote_of(v, Some(now));
                adopted.revision = id();
                adopted.updated_at = now;
                let creates: Vec<&Record> = entries
                    .iter()
                    .filter(|e| e.data["taskId"] == t.id.as_str() && e.data["op"] == "create")
                    .collect();
                for e in &creates {
                    gone.push((
                        outbox::KIND.into(),
                        e.id.clone(),
                        e.workspace_id.clone().unwrap_or_default(),
                    ));
                }
                // Removes made stale by the key living again at `rid` go too.
                let stale =
                    outbox::stale_removes(&r, &self.provider, key.unwrap_or_default(), Some(&rid))?;
                for e in &stale {
                    gone.push((
                        outbox::KIND.into(),
                        e.id.clone(),
                        e.workspace_id.clone().unwrap_or_default(),
                    ));
                }
                // An edit made after the lost create still has to reach the provider.
                let edited = self.differing(t, v);
                let any_edit = !edited.is_empty();
                let left: Vec<&Record> = entries
                    .iter()
                    .filter(|e| {
                        e.data["taskId"] == t.id.as_str()
                            && e.data["op"] != "create"
                            && !stale.iter().any(|s| s.id == e.id)
                    })
                    .collect();
                if any_edit {
                    puts.push(outbox::entry(
                        &adopted,
                        "update",
                        Value::Object(edited),
                        seq,
                        now,
                    ));
                    seq += 1;
                }
                adopted.data["pending"] = (any_edit || !left.is_empty()).into();
                if !left.iter().any(|e| e.data["parked"] == true) {
                    adopted.data["syncError"] = Value::Null;
                }
                puts.push(super::keys::ledger_record(
                    &self.provider,
                    key.unwrap_or_default(),
                    Some(&rid),
                    "created",
                    now,
                ));
                puts.push(adopted);
                self.outcome.pulled += 1;
                continue;
            }
            // Deleted in Connect (a tombstone by key): removed there too, never brought back.
            if let Some(k) = key {
                let ledger = super::keys::ledger_get(&r, &self.provider, k)?;
                let tombstone = ledger.as_ref().filter(|l| {
                    matches!(l["state"].as_str(), Some("removed" | "withdrawn"))
                        && (l["remoteId"].is_null() || l["remoteId"] == rid.as_str())
                });
                if let Some(l) = tombstone {
                    let queued = entries
                        .iter()
                        .any(|e| e.data["op"] == "remove" && e.data["patch"]["id"] == rid.as_str());
                    if !queued {
                        let state = l["state"].as_str().unwrap_or("removed");
                        puts.push(outbox::entry_for(
                            &format!("{}-{rid}", self.plugin),
                            WORKSPACE,
                            &self.provider,
                            "remove",
                            json!({"id": rid, "key": k, "ledger": state}),
                            seq,
                            now,
                        ));
                        seq += 1;
                        self.more = true;
                    }
                    let state = l["state"].as_str().unwrap_or("removed");
                    puts.push(super::keys::ledger_record(
                        &self.provider,
                        k,
                        Some(&rid),
                        state,
                        now,
                    ));
                    continue;
                }
            }
            if v["done"] == true {
                continue;
            }
            let mut body = wire::from_wire(v, &self.provider);
            body["remote"]["syncedAt"] = now.into();
            body["createdAt"] = now.into();
            body["order"] = (now as f64).into();
            puts.push(Record {
                id: format!("{}-{rid}", self.plugin),
                kind: tasks::KIND.into(),
                connection_id: None,
                workspace_id: Some(WORKSPACE.into()),
                source: "local".into(),
                revision: id(),
                updated_at: now,
                data: body,
            });
            self.outcome.pulled += 1;
        }
        // Deleted in the provider beats everything: the record goes, with its entries.
        for rid in changes["removed"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let Some(t) = by_remote.get(rid) else {
                continue;
            };
            let wid = t.workspace_id.clone().unwrap_or_default();
            gone.push((tasks::KIND.into(), t.id.clone(), wid));
            for e in entries.iter().filter(|e| e.data["taskId"] == t.id.as_str()) {
                gone.push((
                    outbox::KIND.into(),
                    e.id.clone(),
                    e.workspace_id.clone().unwrap_or_default(),
                ));
            }
            if let Some(key) = t.data["key"].as_str() {
                puts.push(super::keys::ledger_record(
                    &self.provider,
                    key,
                    Some(rid),
                    "removed",
                    now,
                ));
            }
            self.outcome.removed += 1;
        }
        if full {
            let listed: HashSet<String> = changes["tasks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| wire::remote_of(v, None)["id"].as_str().map(str::to_string))
                .collect();
            for t in &mine {
                let Some(rid) = t.data["remote"]["id"].as_str() else {
                    continue;
                };
                let open = !matches!(tasks::status_of(&t.data), "done" | "review" | "dismissed");
                let waits = entries.iter().any(|e| e.data["taskId"] == t.id.as_str());
                let gone_already = gone.iter().any(|(k, i, _)| k == tasks::KIND && i == &t.id);
                if !open || waits || listed.contains(rid) || gone_already {
                    continue;
                }
                gone.push((
                    tasks::KIND.into(),
                    t.id.clone(),
                    t.workspace_id.clone().unwrap_or_default(),
                ));
                self.outcome.removed += 1;
            }
        }
        if puts.is_empty() && gone.is_empty() {
            return Ok(());
        }
        let gone: Vec<(&str, &str, &str)> = gone
            .iter()
            .map(|(k, i, w)| (k.as_str(), i.as_str(), w.as_str()))
            .collect();
        r.commit_local(&puts, &gone, true)
    }

    /// Writes the state the run ends in and queues the next job it needs.
    fn finish(mut self, stop: Option<Stop>) -> Result<SyncOutcome> {
        let now = self.clock.secs();
        let mut next: Option<i64> = None;
        match stop {
            None | Some(Stop::Budget(_)) => {
                self.st["state"] = "ready".into();
                self.st["backoff"] = 0.into();
                self.st["backoffUntil"] = Value::Null;
                self.st["lastSync"] = now.into();
                if let Some(Stop::Budget(free)) = stop {
                    next = Some(free);
                } else if self.more {
                    next = Some(now);
                }
            }
            Some(Stop::Offline) => {
                let backoff =
                    (self.st["backoff"].as_i64().unwrap_or(0) * 2).clamp(BACKOFF_MIN, BACKOFF_MAX);
                self.st["state"] = "offline".into();
                self.st["backoff"] = backoff.into();
                self.st["backoffUntil"] = (now + backoff).into();
                next = Some(now + backoff);
            }
            Some(Stop::RateLimited(seconds)) => {
                let wait = if seconds == 0 {
                    RATE_LIMITED_DEFAULT
                } else {
                    seconds
                } as i64;
                self.st["state"] = "rate_limited".into();
                self.st["backoffUntil"] = (now + wait).into();
                next = Some(now + wait);
            }
            Some(Stop::NeedsToken) => {
                self.st["state"] = "needs_token".into();
                self.st["backoffUntil"] = Value::Null;
            }
        }
        self.st["message"] = self.message.clone().map_or(Value::Null, Value::from);
        let cutoff = self.clock.ms() - WINDOW_MS;
        self.requests.retain(|t| *t > cutoff);
        self.st["requests"] = json!(self.requests);
        self.outcome.state = self.st["state"].as_str().unwrap_or("ready").to_string();
        let mut r = self.core.repo()?;
        // A re-read asked for while this run was on its way (a new project, Check, a switch)
        // is kept, with its full pull still due, rather than overwritten by this run's copy.
        let stored = load_state(&r, &self.provider)?;
        if !stored["reread"].is_null() && stored["reread"] != self.reread {
            self.st["reread"] = stored["reread"].clone();
            self.st["lastPull"] = Value::Null;
            // A run that ended ready runs it at once; a backoff keeps its own retry time.
            if next.is_none() && self.st["state"] == "ready" {
                next = Some(now);
            }
        }
        save_state(&mut r, &self.provider, &self.st, now)?;
        if let Some(due) = next {
            queue(&mut r, &self.provider, due)?;
        }
        Ok(self.outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::super::fake::FakeProvider;
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::ai::tests::ready;
    use crate::workspace::test_core;

    const P: &str = "plugin:todoist";
    /// Wed 18 Nov 2026, 12:00 UTC.
    const NOW: i64 = 1_795_003_200;
    const SENTINEL: &str = "tk_SENTINEL_do_not_log_0123456789";

    struct Env {
        _dir: tempfile::TempDir,
        core: Arc<Core>,
        fake: Arc<FakeProvider>,
    }

    fn env_with(provider: &str) -> Env {
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

    fn env() -> Env {
        env_with(P)
    }

    impl Env {
        fn save(&self, data: Value, at: i64) -> Record {
            tasks::task_save(&mut self.core.repo().unwrap(), "personal", &data, at).unwrap()
        }
        fn task(&self, id: &str) -> Option<Value> {
            self.core
                .repo()
                .unwrap()
                .record(tasks::KIND, id, None, Some("personal"))
                .ok()
                .map(|t| t.data)
        }
        fn outbox(&self) -> Vec<Value> {
            outbox::waiting(&self.core.repo().unwrap(), P).unwrap()
        }
        fn state(&self) -> Value {
            load_state(&self.core.repo().unwrap(), P).unwrap()
        }
        async fn sync(&self, at: i64) -> SyncOutcome {
            run(&self.core, P, at).await.unwrap()
        }
        fn snapshot(&self) -> Value {
            let settings = self.core.repo().unwrap().settings().unwrap();
            self.core.task_provider_snapshot(&settings)
        }
        fn calls_of(&self, op: &str) -> Vec<Value> {
            self.fake
                .calls()
                .into_iter()
                .filter(|(o, _)| o == op)
                .map(|(_, a)| a)
                .collect()
        }
    }

    #[tokio::test]
    async fn a_save_while_offline_waits_and_replays_in_order() {
        let e = env();
        e.fake.fail_all(Some(ProviderError::Offline));
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.save(json!({"id": "t1", "due": "2026-11-20"}), NOW + 1);
        e.save(
            json!({"id": "t2", "text": "Book a room for demo day"}),
            NOW + 2,
        );
        let waiting = e.outbox();
        assert_eq!(
            waiting.len(),
            2,
            "t1's edit coalesced into its create: {waiting:?}"
        );
        assert_eq!(waiting[0]["taskId"], "t1");
        assert_eq!(waiting[1]["taskId"], "t2");
        let o = e.sync(NOW + 3).await;
        assert_eq!(o.state, "offline");
        assert_eq!(e.state()["backoff"], 30);
        assert_eq!(e.state()["backoffUntil"], NOW + 33);
        let snap = e.snapshot();
        assert_eq!(snap["state"], "offline");
        assert_eq!(snap["pending"], 2);
        assert_eq!(snap["retryAt"], NOW + 33);
        assert_eq!(e.task("t1").unwrap()["pending"], true);

        e.fake.fail_all(None);
        let o = e.sync(NOW + 33).await;
        assert_eq!(o.state, "ready");
        assert_eq!(e.fake.ops()[1..], ["create", "create", "changedSince"]);
        let creates = e.calls_of("create");
        assert_eq!(creates[1]["task"]["text"], "Send the pilot user list");
        assert_eq!(
            creates[1]["task"]["due"], "2026-11-20",
            "the edit went with it"
        );
        assert_eq!(creates[2]["task"]["text"], "Book a room for demo day");
        assert!(e.outbox().is_empty());
        for id in ["t1", "t2"] {
            let t = e.task(id).unwrap();
            assert!(t["remote"]["id"].is_string(), "{t}");
            assert_eq!(t["pending"], false);
        }
        assert_eq!(e.state()["backoff"], 0);
    }

    #[tokio::test]
    async fn a_task_waits_for_its_create_and_updates_coalesce() {
        let e = env();
        e.fake.fail_all(Some(ProviderError::Offline));
        e.save(json!({"id": "t1", "text": "Draft the pilot plan"}), NOW);
        e.save(
            json!({"id": "t1", "text": "Draft the pilot plan v2"}),
            NOW + 1,
        );
        e.save(json!({"id": "t1", "status": "done"}), NOW + 2);
        let ops: Vec<Value> = e.outbox().iter().map(|w| w["op"].clone()).collect();
        assert_eq!(ops, ["create", "complete"]);
        e.sync(NOW + 3).await;
        e.fake.fail_all(None);
        e.sync(NOW + 33).await;
        assert_eq!(e.fake.ops()[1..], ["create", "complete", "changedSince"]);
        assert_eq!(
            e.calls_of("create")[1]["task"]["text"],
            "Draft the pilot plan v2"
        );
        let rid = e.task("t1").unwrap()["remote"]["id"].clone();
        assert_eq!(e.calls_of("complete")[0]["id"], rid);

        // Two edits, one update with both fields as they are now.
        e.save(
            json!({"id": "t1", "text": "Draft the pilot plan v3"}),
            NOW + 40,
        );
        e.save(json!({"id": "t1", "due": "2026-11-21"}), NOW + 41);
        assert_eq!(e.outbox().len(), 1);
        e.sync(NOW + 100).await;
        let updates = e.calls_of("update");
        assert_eq!(updates.len(), 1);
        assert_eq!(
            updates[0]["patch"],
            json!({"text": "Draft the pilot plan v3", "due": "2026-11-21"})
        );

        // A task whose create is parked: its update waits behind it.
        e.fake.answer(
            "create",
            Err(ProviderError::Refused(
                "Todoist needs a date like 2026-11-20.".into(),
            )),
        );
        e.save(json!({"id": "t2", "text": "Bad"}), NOW + 200);
        e.sync(NOW + 300).await;
        e.save(json!({"id": "t2", "text": "Still bad"}), NOW + 301);
        let before = e.fake.calls().len();
        e.sync(NOW + 400).await;
        assert!(
            e.fake.calls()[before..]
                .iter()
                .all(|(op, _)| op != "update"),
            "{:?}",
            e.fake.ops()
        );
    }

    #[tokio::test]
    async fn a_create_lost_after_todoist_answered_is_adopted_not_repeated() {
        let e = env();
        e.fake.lose_answer("create");
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        assert_eq!(e.sync(NOW).await.state, "offline");
        assert_eq!(e.fake.tasks().len(), 1, "Todoist made it");
        assert!(e.task("t1").unwrap()["remote"]["id"].is_null());

        e.sync(NOW + 30).await;
        let creates = e.calls_of("create");
        assert_eq!(creates.len(), 2);
        assert_eq!(
            creates[0]["requestId"], creates[1]["requestId"],
            "the same request again"
        );
        assert_eq!(creates[0]["key"], creates[1]["key"]);
        assert_eq!(e.fake.tasks().len(), 1, "Todoist still holds one task");
        let t = e.task("t1").unwrap();
        assert_eq!(t["remote"]["id"], e.fake.tasks()[0]["id"]);
        let ledger =
            super::super::keys::ledger_get(&e.core.repo().unwrap(), P, t["key"].as_str().unwrap())
                .unwrap()
                .unwrap();
        assert_eq!(ledger["state"], "created");
        assert_eq!(ledger["remoteId"], t["remote"]["id"]);
        assert!(e.outbox().is_empty());
    }

    #[tokio::test]
    async fn a_refused_entry_parks_and_blocks_nothing() {
        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.sync(NOW).await;
        e.save(
            json!({"id": "t1", "text": "Send the pilot user list today"}),
            NOW + 10,
        );
        e.save(json!({"id": "t2", "text": "Book a room"}), NOW + 11);
        const SENTENCE: &str = "Todoist didn't accept the change (400)";
        e.fake
            .answer("update", Err(ProviderError::Refused(SENTENCE.into())));
        let o = e.sync(NOW + 20).await;
        assert_eq!(o.state, "ready");
        assert_eq!(o.parked, 1);
        let t1 = e.task("t1").unwrap();
        assert_eq!(t1["syncError"], SENTENCE);
        assert_eq!(t1["pending"], true);
        assert!(
            e.task("t2").unwrap()["remote"]["id"].is_string(),
            "t2 went through"
        );
        let snap = e.snapshot();
        assert_eq!(snap["parked"], 1);
        assert_eq!(snap["pending"], 0);
        assert_eq!(snap["message"], SENTENCE);
        assert_eq!(snap["state"], "ready");
        // Parked: not sent again on the next pass.
        let before = e.calls_of("update").len();
        e.sync(NOW + 100).await;
        assert_eq!(e.calls_of("update").len(), before);
    }

    #[tokio::test]
    async fn rate_limited_waits_until_retry_at_and_needs_token_stops() {
        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.fake.answer(
            "create",
            Err(ProviderError::RateLimited { retry_after: 120 }),
        );
        assert_eq!(e.sync(NOW).await.state, "rate_limited");
        let snap = e.snapshot();
        assert_eq!(snap["state"], "rate_limited");
        assert_eq!(snap["retryAt"], NOW + 120);
        assert_eq!(e.fake.calls().len(), 1);
        e.sync(NOW + 60).await;
        e.sync(NOW + 119).await;
        assert_eq!(e.fake.calls().len(), 1, "no call before retryAt");
        assert_eq!(e.sync(NOW + 120).await.state, "ready");
        assert!(e.task("t1").unwrap()["remote"]["id"].is_string());

        e.save(json!({"id": "t2", "text": "Book a room"}), NOW + 200);
        e.fake.fail_all(Some(ProviderError::NeedsToken));
        assert_eq!(e.sync(NOW + 200).await.state, "needs_token");
        e.fake.fail_all(None);
        let calls = e.fake.calls().len();
        e.sync(NOW + 300).await;
        e.sync(NOW + 5000).await;
        assert_eq!(
            e.fake.calls().len(),
            calls,
            "no call until the token is saved"
        );
        assert_eq!(e.snapshot()["state"], "needs_token");

        // Saving the token queues a sync, which calls again.
        e.core.task_secret_saved("todoist").unwrap();
        let jobs = e.core.repo().unwrap().jobs().unwrap();
        assert!(jobs
            .iter()
            .any(|j| j.kind == JOB_KIND && j.state == "queued"));
        assert_eq!(e.sync(NOW + 5001).await.state, "ready");
        assert!(e.task("t2").unwrap()["remote"]["id"].is_string());
    }

    #[tokio::test]
    async fn offline_backoff_doubles_to_fifteen_minutes() {
        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.fake.fail_all(Some(ProviderError::Offline));
        let mut t = NOW;
        for backoff in [30, 60, 120, 240, 480, 900, 900] {
            assert_eq!(e.sync(t).await.state, "offline");
            assert_eq!(e.state()["backoff"], backoff);
            assert_eq!(e.state()["backoffUntil"], t + backoff);
            let calls = e.fake.calls().len();
            e.sync(t + backoff - 1).await;
            assert_eq!(
                e.fake.calls().len(),
                calls,
                "nothing before the backoff ends"
            );
            t += backoff;
        }
        // A job waits for the retry.
        let jobs = e.core.repo().unwrap().jobs().unwrap();
        assert!(jobs
            .iter()
            .any(|j| j.kind == JOB_KIND && j.state == "queued"));
        e.fake.fail_all(None);
        assert_eq!(e.sync(t).await.state, "ready");
        assert_eq!(e.state()["backoff"], 0);
        assert_eq!(e.state()["backoffUntil"], Value::Null);
    }

    #[tokio::test(start_paused = true)]
    async fn the_request_budget_is_kept() {
        let e = env();
        for i in 0..400 {
            e.save(
                json!({"id": format!("t{i}"), "text": format!("Task {i}")}),
                NOW,
            );
        }
        assert_eq!(e.outbox().len(), 400);
        let origin = tokio::time::Instant::now();
        for _ in 0..2000 {
            if e.outbox().is_empty() {
                break;
            }
            e.sync(NOW + origin.elapsed().as_secs() as i64).await;
            tokio::time::advance(std::time::Duration::from_secs(10)).await;
        }
        assert!(e.outbox().is_empty(), "every entry went in the end");
        let times: Vec<i64> = e
            .fake
            .call_times()
            .iter()
            .map(|t| t.duration_since(origin).as_millis() as i64)
            .collect();
        assert!(times.len() > 400);
        for (i, t) in times.iter().enumerate() {
            let in_window = times[i..]
                .iter()
                .take_while(|u| **u < t + WINDOW_MS)
                .count();
            assert!(
                in_window <= PER_WINDOW,
                "{in_window} calls in 15 minutes from {t} ms"
            );
            let in_second = times[i..].iter().take_while(|u| **u < t + 1000).count();
            assert!(
                in_second <= PER_SECOND,
                "{in_second} calls in a second from {t} ms"
            );
        }
        // It waited for the window rather than giving up: the last calls came after 15 minutes.
        assert!(*times.last().unwrap() >= WINDOW_MS);
    }

    #[tokio::test]
    async fn pull_adds_updates_and_removes() {
        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.sync(NOW).await;
        let rid = e.task("t1").unwrap()["remote"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        // Added in Todoist, and t1 closed there.
        e.fake.set_time(NOW + 50);
        e.fake
            .put_remote(json!({"id": "9001", "text": "Check the pilot list",
            "labels": ["waiting"], "done": false,
            "owner": {"name": "Marek Novak", "address": "marek.novak@example.test"}}));
        let mut t1 = e
            .fake
            .tasks()
            .into_iter()
            .find(|t| t["id"] == rid.as_str())
            .unwrap();
        t1["done"] = true.into();
        e.fake.put_remote(t1);
        // Within 60 s of the last pull and nothing pushed: no pull yet.
        e.sync(NOW + 30).await;
        assert!(e.task("todoist-9001").is_none());
        let o = e.sync(NOW + 100).await;
        assert_eq!(o.pulled, 2);
        let added = e.task("todoist-9001").unwrap();
        assert_eq!(added["provider"], P);
        assert_eq!(added["kind"], "waiting");
        assert_eq!(added["status"], "waiting");
        assert_eq!(added["owner"], "marek.novak@example.test");
        assert_eq!(added["key"].as_str().unwrap().len(), 16);
        let t1 = e.task("t1").unwrap();
        assert_eq!(t1["status"], "done");
        assert_eq!(
            t1["history"].as_array().unwrap().last().unwrap()["text"],
            "Done in Todoist"
        );
        let key = t1["key"].as_str().unwrap().to_string();

        // Deleted in Todoist: the record goes, and the ledger says so.
        e.fake.remove_remote(&rid);
        let o = e.sync(NOW + 200).await;
        assert_eq!(o.removed, 1);
        assert!(e.task("t1").is_none());
        let ledger = super::super::keys::ledger_get(&e.core.repo().unwrap(), P, &key)
            .unwrap()
            .unwrap();
        assert_eq!(ledger["state"], "removed");
    }

    #[tokio::test]
    async fn a_provider_message_with_the_token_is_dropped() {
        let e = env();
        e.fake.set_secret(SENTINEL);
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.fake.answer(
            "create",
            Err(ProviderError::Refused(format!("Todoist echoed {SENTINEL}"))),
        );
        let o = e.sync(NOW).await;
        assert_eq!(o.parked, 1);
        assert!(!o.summary().contains(SENTINEL));
        let snap = e.snapshot();
        assert_eq!(snap["message"], Value::Null);
        assert_eq!(snap["parked"], 1);
        let r = e.core.repo().unwrap();
        let parked = r.records_of_kind(outbox::KIND).unwrap();
        assert_eq!(parked[0].data["lastError"], "refused", "the code is kept");
        assert_eq!(parked[0].data["message"], Value::Null);
        // The task still reads as parked, with no sentence: the window says "Todoist refused
        // this change." instead.
        let task = r.record(tasks::KIND, "t1", None, Some("personal")).unwrap();
        assert_eq!(task.data["syncError"], "");
        // Nowhere in the store: tasks, outbox, state, ledger, jobs.
        for kind in [
            tasks::KIND,
            outbox::KIND,
            STATE_KIND,
            super::super::keys::LEDGER_KIND,
        ] {
            let text = serde_json::to_string(&r.records_of_kind(kind).unwrap()).unwrap();
            assert!(!text.contains(SENTINEL), "{kind}: {text}");
        }
        let jobs = serde_json::to_string(&r.jobs().unwrap()).unwrap();
        assert!(!jobs.contains(SENTINEL));
        drop(r);
        // A stored message holding the token (written before this check existed) is not shown.
        let mut st = e.state();
        st["message"] = format!("x {SENTINEL}").into();
        save_state(&mut e.core.repo().unwrap(), P, &st, NOW).unwrap();
        assert_eq!(e.snapshot()["message"], Value::Null);
    }

    #[tokio::test]
    async fn the_window_closed_core_syncs_on_the_background_round() {
        let e = env();
        // Saved with no window and no request: nothing has queued a job yet.
        e.save(json!({"id": "t1", "text": "Made by an automation"}), NOW);
        assert!(e.core.repo().unwrap().jobs().unwrap().is_empty());
        let mut last_sync = crate::workspace::models::now();
        let mut ticks = 1;
        e.core.background_round(&mut last_sync, &mut ticks);
        e.core.background_round(&mut last_sync, &mut ticks);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while e.task("t1").unwrap()["remote"]["id"].is_null() {
            assert!(
                std::time::Instant::now() < deadline,
                "the background round never synced"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            e.core.background_round(&mut last_sync, &mut ticks);
        }
        assert_eq!(e.fake.ops()[..2], ["create", "changedSince"]);

        // The next background sync comes 300 s after the last run, not before.
        let run_at = e.state()["lastRun"].as_i64().unwrap();
        let queued = |e: &Env| {
            e.core
                .repo()
                .unwrap()
                .jobs()
                .unwrap()
                .iter()
                .any(|j| j.kind == JOB_KIND && j.state == "queued")
        };
        while e
            .core
            .repo()
            .unwrap()
            .jobs()
            .unwrap()
            .iter()
            .any(|j| j.kind == JOB_KIND && j.state == "running")
        {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        e.core.task_sync_round(run_at + 299).unwrap();
        assert!(!queued(&e));
        e.core.task_sync_round(run_at + 300).unwrap();
        assert!(queued(&e));
    }

    #[tokio::test]
    async fn task_sync_now_runs_at_most_once_in_30_seconds_and_local_queues_nothing() {
        let local = env_with("local");
        assert_eq!(
            local.core.task_sync_now().unwrap(),
            json!({"queued": false})
        );
        local.core.task_sync_round(NOW).unwrap();
        assert!(local.core.repo().unwrap().jobs().unwrap().is_empty());

        let e = env();
        let req = || crate::workspace::models::Request {
            op: crate::workspace::models::Operation::TaskSyncNow,
            workspace_id: None,
            expected_revision: None,
            operation_id: None,
            data: json!({}),
        };
        assert_eq!(
            e.core.request(req()).await.unwrap(),
            json!({"queued": true})
        );
        let now = crate::workspace::models::now();
        e.sync(now).await;
        assert_eq!(
            e.core.request(req()).await.unwrap(),
            json!({"queued": false})
        );
    }

    /// Review fix 1: a create replayed after its answer was lost is adopted by key; an edit made
    /// meanwhile must still reach Todoist (spec §4 "an update if fields differ").
    #[tokio::test]
    async fn an_edit_after_a_lost_create_reaches_todoist() {
        let e = env();
        e.fake.lose_answer("create");
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.sync(NOW).await;
        e.save(
            json!({"id": "t1", "text": "Send the pilot user list to Marek"}),
            NOW + 1,
        );
        e.sync(NOW + 30).await;
        e.sync(NOW + 31).await;
        assert_eq!(e.fake.tasks().len(), 1);
        assert_eq!(
            e.fake.tasks()[0]["text"],
            "Send the pilot user list to Marek"
        );
        assert!(e.outbox().is_empty());
        assert_eq!(e.task("t1").unwrap()["pending"], false);
    }

    /// The same through the pull: the create stays parked, the pull finds the task by its key.
    #[tokio::test]
    async fn a_task_adopted_by_the_pull_sends_its_edit_and_settles_pending() {
        let e = env();
        e.fake.lose_answer("create");
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.sync(NOW).await;
        e.save(
            json!({"id": "t1", "text": "Send the pilot user list to Marek"}),
            NOW + 1,
        );
        e.fake.answer(
            "create",
            Err(ProviderError::Refused(
                "Todoist didn't accept the change (400)".into(),
            )),
        );
        e.sync(NOW + 30).await;
        let t = e.task("t1").unwrap();
        assert!(t["remote"]["id"].is_string(), "adopted by the pull: {t}");
        assert_eq!(e.outbox().len(), 1, "an update for the edit");
        e.sync(NOW + 31).await;
        assert_eq!(
            e.fake.tasks()[0]["text"],
            "Send the pilot user list to Marek"
        );
        let t = e.task("t1").unwrap();
        assert_eq!(t["pending"], false);
        assert_eq!(t["syncError"], Value::Null);
        assert_eq!(outbox::counts(&e.core.repo().unwrap(), P).unwrap(), (0, 0));

        // Nothing differs: the adopted task is not pending.
        let e = env();
        e.fake.lose_answer("create");
        e.save(json!({"id": "t1", "text": "Book a room"}), NOW);
        e.sync(NOW).await;
        e.fake
            .answer("create", Err(ProviderError::Refused("x".into())));
        e.sync(NOW + 30).await;
        assert_eq!(e.task("t1").unwrap()["pending"], false);
        assert!(e.outbox().is_empty());
    }

    /// Review fix 2: an edit that joins an update while it is on its way, in the same second,
    /// is sent, not dropped.
    #[tokio::test]
    async fn an_edit_joining_an_update_in_flight_is_sent() {
        let e = Arc::new(env());
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.sync(NOW).await;
        e.save(json!({"id": "t1", "text": "Send the list"}), NOW + 10);
        let core = e.core.clone();
        e.fake.during("update", move || {
            tasks::task_save(
                &mut core.repo().unwrap(),
                "personal",
                &json!({"id": "t1", "due": "2026-11-21"}),
                NOW + 10,
            )
            .unwrap();
        });
        e.sync(NOW + 10).await;
        assert_eq!(e.outbox().len(), 1, "the joined edit still waits");
        e.sync(NOW + 11).await;
        assert_eq!(e.fake.tasks()[0]["due"], "2026-11-21");
        assert_eq!(e.fake.tasks()[0]["text"], "Send the list");
    }

    /// Review fix 3: a task deleted in Connect whose create reached Todoist (answer lost) is
    /// removed there, not brought back by the pull; nor while its remove is parked.
    #[tokio::test]
    async fn a_deleted_task_never_comes_back_from_the_pull() {
        let e = env();
        e.fake.lose_answer("create");
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.sync(NOW).await;
        tasks::task_delete(&mut e.core.repo().unwrap(), "personal", "t1").unwrap();
        e.sync(NOW + 30).await;
        e.sync(NOW + 31).await;
        assert!(e.task("todoist-8124").is_none(), "not brought back");
        assert!(e.fake.tasks().is_empty(), "removed in Todoist too");

        // Its remove is parked; Todoist changes it; the pull still doesn't bring it back.
        e.save(json!({"id": "t2", "text": "Book a room"}), NOW + 100);
        e.sync(NOW + 100).await;
        let rid = e.task("t2").unwrap()["remote"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        e.fake
            .answer("remove", Err(ProviderError::Refused("x".into())));
        tasks::task_delete(&mut e.core.repo().unwrap(), "personal", "t2").unwrap();
        e.sync(NOW + 200).await;
        let mut changed = e
            .fake
            .tasks()
            .into_iter()
            .find(|t| t["id"] == rid.as_str())
            .unwrap();
        changed["text"] = "Book a bigger room".into();
        e.fake.put_remote(changed);
        e.sync(NOW + 300).await;
        assert!(e.task(&format!("todoist-{rid}")).is_none());
        assert_eq!(
            e.calls_of("remove").len(),
            2,
            "no second remove queued: {:?}",
            e.fake.ops()
        );
    }

    /// Review fix 4: a pass ends well inside the job's lease, so it never runs twice at once.
    #[tokio::test(start_paused = true)]
    async fn a_pass_ends_well_inside_the_job_lease() {
        let e = env();
        for i in 0..30 {
            e.save(
                json!({"id": format!("t{i}"), "text": format!("Task {i}")}),
                NOW,
            );
        }
        e.fake.set_delay(std::time::Duration::from_secs(20));
        let started = tokio::time::Instant::now();
        e.sync(NOW).await;
        assert!(
            started.elapsed() < std::time::Duration::from_secs(150),
            "{:?}",
            started.elapsed()
        );
        assert!(!e.outbox().is_empty(), "the rest waits for the next pass");
        let jobs = e.core.repo().unwrap().jobs().unwrap();
        assert!(jobs
            .iter()
            .any(|j| j.kind == JOB_KIND && j.state == "queued"));
    }

    /// Review fix 5: a create answered without an id parks; it is not dropped.
    #[tokio::test]
    async fn a_create_answered_without_an_id_parks() {
        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.fake
            .answer("create", Ok(json!({"text": "Send the pilot user list"})));
        let o = e.sync(NOW).await;
        assert_eq!(o.parked, 1);
        assert_eq!(outbox::counts(&e.core.repo().unwrap(), P).unwrap(), (0, 1));
        let t = e.task("t1").unwrap();
        assert!(t["remote"]["id"].is_null());
        assert_eq!(t["pending"], true);
        let key = t["key"].as_str().unwrap().to_string();
        assert!(
            super::super::keys::ledger_get(&e.core.repo().unwrap(), P, &key)
                .unwrap()
                .is_none()
        );
    }

    /// Review fix 7: a run that failed before its end doesn't make the background round queue
    /// a job every second.
    #[tokio::test]
    async fn a_failed_run_is_not_queued_again_every_round() {
        let e = env();
        let t = crate::workspace::models::now();
        {
            let mut r = e.core.repo().unwrap();
            queue(&mut r, P, t).unwrap();
            let mut job = r.claim(t).unwrap().unwrap();
            job.state = "failed".into();
            job.lease_until = None;
            r.save_job(&job).unwrap();
        }
        let queued = |e: &Env| {
            e.core
                .repo()
                .unwrap()
                .jobs()
                .unwrap()
                .iter()
                .filter(|j| j.state == "queued")
                .count()
        };
        e.core.task_sync_round(t + 10).unwrap();
        assert_eq!(queued(&e), 0);
        e.core.task_sync_round(t + 300).unwrap();
        assert_eq!(queued(&e), 1);
    }

    /// Review Focus 2, same field, through the job: an offline due date edit made before a newer
    /// Todoist edit of the same field never overwrites it; the history says Todoist's won. A
    /// Connect edit later than Todoist's still wins and is sent.
    #[tokio::test]
    async fn an_older_offline_edit_never_overwrites_a_newer_todoist_edit() {
        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot list"}), NOW);
        e.sync(NOW).await;
        // Offline at NOW + 100, moved to Friday in Connect.
        e.fake.fail_all(Some(ProviderError::Offline));
        e.save(json!({"id": "t1", "due": "2026-11-20"}), NOW + 100);
        assert_eq!(e.sync(NOW + 100).await.state, "offline");
        // At NOW + 200, moved to Monday in Todoist.
        let mut remote = e.fake.tasks()[0].clone();
        remote["due"] = "2026-11-23".into();
        e.fake.set_time(NOW + 200);
        e.fake.put_remote(remote);
        // Back at NOW + 300.
        e.fake.fail_all(None);
        assert_eq!(e.sync(NOW + 300).await.state, "ready");
        assert_eq!(
            e.fake.tasks()[0]["due"],
            "2026-11-23",
            "Todoist's newer date stays"
        );
        assert!(
            !e.calls_of("update")
                .iter()
                .any(|u| u["patch"]["due"] == "2026-11-20"),
            "{:?}",
            e.calls_of("update")
        );
        let t1 = e.task("t1").unwrap();
        assert_eq!(t1["due"], "2026-11-23");
        assert_eq!(t1["pending"], false);
        assert_eq!(
            t1["history"].as_array().unwrap().last().unwrap()["text"],
            "Todoist had a newer due date; Connect kept it."
        );
        assert!(e.outbox().is_empty());

        // Connect's edit is the later one: it wins and reaches Todoist.
        e.fake.set_time(NOW + 400);
        let mut remote = e.fake.tasks()[0].clone();
        remote["due"] = "2026-11-24".into();
        e.fake.put_remote(remote);
        e.fake.fail_all(Some(ProviderError::Offline));
        e.save(json!({"id": "t1", "due": "2026-11-25"}), NOW + 500);
        e.sync(NOW + 500).await;
        e.fake.fail_all(None);
        e.sync(NOW + 600).await;
        assert_eq!(e.fake.tasks()[0]["due"], "2026-11-25");
        assert_eq!(e.task("t1").unwrap()["due"], "2026-11-25");
        assert!(e.outbox().is_empty());
    }

    /// Ruling 5: someone else's To do task goes to the provider as `waiting` (its label, the
    /// "<First>: " prefix and the owner line are the plugin's); completing a Waiting task sends
    /// only the completion, so Todoist keeps its label; a change of owner to me sends the kind.
    #[tokio::test]
    async fn someone_elses_task_goes_as_waiting_and_completing_keeps_the_label() {
        let e = env();
        e.save(
            json!({"id": "t1", "text": "Send the pilot user list", "status": "todo",
                "owner": "marek.novak@example.test", "ownerName": "Marek Novak"}),
            NOW,
        );
        e.save(
            json!({"id": "t2", "text": "Book a room", "status": "waiting",
                "owner": "marek.novak@example.test", "ownerName": "Marek Novak"}),
            NOW,
        );
        e.save(
            json!({"id": "t3", "text": "Draft the plan", "owner": "You"}),
            NOW,
        );
        e.sync(NOW).await;
        let creates = e.calls_of("create");
        assert_eq!(creates[0]["task"]["kind"], "waiting", "{:?}", creates[0]);
        assert_eq!(creates[0]["task"]["owner"]["name"], "Marek Novak");
        assert_eq!(creates[1]["task"]["kind"], "waiting");
        assert_eq!(creates[2]["task"]["kind"], "task");
        assert_eq!(creates[2]["task"]["owner"], Value::Null);
        assert!(
            e.outbox().is_empty(),
            "nothing left to send: {:?}",
            e.outbox()
        );

        // Done from the Waiting column: only the completion goes.
        e.save(json!({"id": "t2", "status": "done"}), NOW + 100);
        let waiting: Vec<Value> = e.outbox().iter().map(|w| w["op"].clone()).collect();
        assert_eq!(waiting, ["complete"]);
        e.sync(NOW + 100).await;
        assert!(
            e.calls_of("update").is_empty(),
            "{:?}",
            e.calls_of("update")
        );
        // Undo: reopened to Waiting, again only the completion.
        e.save(json!({"id": "t2", "status": "waiting"}), NOW + 110);
        let waiting: Vec<Value> = e.outbox().iter().map(|w| w["op"].clone()).collect();
        assert_eq!(waiting, ["complete"]);

        // Mine now: the kind goes with the owner, so the plugin drops the label and prefix.
        e.save(json!({"id": "t1", "owner": "You"}), NOW + 200);
        e.sync(NOW + 200).await;
        let updates = e.calls_of("update");
        let last = updates.last().unwrap();
        assert_eq!(last["patch"]["owner"], Value::Null);
        assert_eq!(last["patch"]["kind"], "task", "{last}");
    }

    /// Re-review N1: a re-read asked for while a run is on its way (the project changed during
    /// a push) is kept by that run's end, so the next run reads the new project.
    #[tokio::test]
    async fn a_reread_asked_for_during_a_run_is_kept() {
        let e = env();
        e.save(json!({"id": "t1", "text": "In the old project"}), NOW);
        e.save(json!({"id": "t2", "text": "Also old"}), NOW);
        e.sync(NOW).await;
        e.save(json!({"id": "t2", "due": "2026-12-01"}), NOW + 10);
        let core = e.core.clone();
        let fake = e.fake.clone();
        let old = e.task("t1").unwrap()["remote"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        // While t2's update is on its way, the project setting changes.
        e.fake.during("update", move || {
            fake.forget_remote(&old);
            fake.put_remote_unchanged(json!({"id": "9001", "text": "Already in Work",
                "labels": [], "done": false}));
            reread(&mut core.repo().unwrap(), P, NOW + 10).unwrap();
        });
        e.sync(NOW + 10).await;
        e.sync(NOW + 11).await;
        assert!(
            e.task("todoist-9001").is_some(),
            "the new project's task comes in"
        );
        assert!(e.task("t1").is_none(), "the old project's task leaves");
        assert!(e.state().get("reread").is_none(), "{}", e.state());
    }

    /// A finished `taskProvider` part of the real snapshot for each state (design §2), and the
    /// records the real job leaves for its main cases. Regenerate with
    /// `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
    #[tokio::test]
    async fn contract_fixtures_match_the_task_sync_cases() {
        let mut states = serde_json::Map::new();
        // No task plugin installed: the part every Local user's snapshot carries.
        let local = env_with("local");
        local.fake.set_available(Vec::new());
        states.insert("local".into(), local.snapshot());

        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.sync(NOW).await;
        states.insert("ready".into(), e.snapshot());
        e.save(json!({"id": "t2", "text": "Book a room"}), NOW + 10);
        queue(&mut e.core.repo().unwrap(), P, 0).unwrap();
        e.core
            .repo()
            .unwrap()
            .claim(crate::workspace::models::now())
            .unwrap()
            .unwrap();
        states.insert("syncing".into(), e.snapshot());

        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.fake.fail_all(Some(ProviderError::Offline));
        e.sync(NOW).await;
        states.insert("offline".into(), e.snapshot());

        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.fake.answer(
            "create",
            Err(ProviderError::RateLimited { retry_after: 120 }),
        );
        e.sync(NOW).await;
        states.insert("rate_limited".into(), e.snapshot());

        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.fake.fail_all(Some(ProviderError::NeedsToken));
        e.sync(NOW).await;
        states.insert("needs_token".into(), e.snapshot());

        for (state, on, ready) in [("off", false, false), ("failed", true, false)] {
            let e = env();
            e.fake.set_available(vec![super::super::ProviderInfo {
                id: P.into(),
                name: "Todoist".into(),
                on,
                ready,
            }]);
            e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
            assert_eq!(e.sync(NOW).await.state, state);
            assert!(e.fake.calls().is_empty(), "no call while {state}");
            // It still counts as a run: the background loop doesn't queue it again every second.
            assert_eq!(e.state()["lastRun"], NOW);
            e.core.task_sync_round(NOW + 1).unwrap();
            assert!(e.core.repo().unwrap().jobs().unwrap().is_empty());
            states.insert(state.into(), e.snapshot());
        }
        for (state, part) in &states {
            assert_eq!(part["state"], state.as_str(), "{part}");
        }

        let records = |e: &Env, ids: &[&str]| -> Value {
            let r = e.core.repo().unwrap();
            ids.iter()
                .map(|id| {
                    let rec = r.record(tasks::KIND, id, None, Some("personal")).unwrap();
                    let mut v = serde_json::to_value(&rec).unwrap();
                    v["revision"] = "rev".into();
                    v
                })
                .collect()
        };
        let mut cases = serde_json::Map::new();
        // Saved while offline, then replayed.
        let e = env();
        e.fake.fail_all(Some(ProviderError::Offline));
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.save(json!({"id": "t1", "due": "2026-11-20"}), NOW + 1);
        e.save(
            json!({"id": "t2", "text": "Book a room for demo day"}),
            NOW + 2,
        );
        e.sync(NOW + 3).await;
        e.fake.fail_all(None);
        e.sync(NOW + 33).await;
        cases.insert("offlineReplay".into(), records(&e, &["t1", "t2"]));
        // A lost create adopted by its key.
        let e = env();
        e.fake.lose_answer("create");
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.sync(NOW).await;
        e.sync(NOW + 30).await;
        cases.insert("adopted".into(), records(&e, &["t1"]));
        // A refused change, parked with its entry.
        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.sync(NOW).await;
        e.save(json!({"id": "t1", "due": "2026-11-20"}), NOW + 10);
        e.fake.answer(
            "update",
            Err(ProviderError::Refused(
                "Todoist needs a date like 2026-11-20.".into(),
            )),
        );
        e.sync(NOW + 20).await;
        let mut parked = records(&e, &["t1"]);
        let entries = e
            .core
            .repo()
            .unwrap()
            .records_of_kind(outbox::KIND)
            .unwrap();
        for entry in entries {
            let mut v = serde_json::to_value(&entry).unwrap();
            v["id"] = "entry-1".into();
            v["revision"] = "rev".into();
            v["data"]["id"] = "entry-1".into();
            parked.as_array_mut().unwrap().push(v);
        }
        cases.insert("parked".into(), parked);
        // Edited on both sides: Connect's due date and Todoist's text both stay.
        let e = env();
        e.save(json!({"id": "t1", "text": "Send the pilot user list"}), NOW);
        e.sync(NOW).await;
        e.fake.fail_all(Some(ProviderError::Offline));
        e.save(json!({"id": "t1", "due": "2026-11-21"}), NOW + 200);
        e.sync(NOW + 200).await;
        e.fake.fail_all(None);
        let mut remote = e.fake.tasks()[0].clone();
        remote["text"] = "Send the pilot user list to Marek".into();
        e.fake.set_time(NOW + 100);
        e.fake.put_remote(remote);
        e.sync(NOW + 230).await;
        let merged = records(&e, &["t1"]);
        assert_eq!(
            merged[0]["data"]["text"],
            "Send the pilot user list to Marek"
        );
        assert_eq!(merged[0]["data"]["due"], "2026-11-21");
        cases.insert("merged".into(), merged);

        crate::plugins::testkit::contract_fixture(
            "task-provider-states.json",
            &Value::Object(states),
        );
        crate::plugins::testkit::contract_fixture("task-sync-cases.json", &Value::Object(cases));
    }
}
