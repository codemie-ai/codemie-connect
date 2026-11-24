//! Engine glue: persistence, the job queue and the operations. The decisions are in `rules`.
use super::rules::*;
use crate::workspace::meetings::{model::MeetingRecord, rules as meeting_rules, templates};
use crate::workspace::models::*;
use crate::workspace::{
    inbox, new_job,
    repository::{record_selected, source_available, source_permitted, Repository},
    workspace_id_active, Core, MAX_WIDGETS,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

const PERSONAL: &str = "personal";
const STATE_ID: &str = "state";
const MAX_AUTOMATIONS: usize = 50;
/// How often the background loop looks at schedules and ended meetings, in loop ticks (1 s).
pub const ROUND_TICKS: u64 = 15;

/// When this launch of Connect began; schedule times before it were missed while it was closed.
static STARTED_AT: OnceLock<i64> = OnceLock::new();
/// One writer of the `automation_state` record at a time (the loop and the sync job).
static STATE_LOCK: Mutex<()> = Mutex::new(());

fn load_automations(r: &Repository) -> Result<Vec<(Record, Automation)>> {
    Ok(r.local_records(PERSONAL, "automation")?
        .into_iter()
        .filter_map(|rec| {
            let mut a: Automation = serde_json::from_value(rec.data.clone()).ok()?;
            a.id = rec.id.clone();
            Some((rec, a))
        })
        .collect())
}

fn load_state(r: &Repository, jobs: &[Job]) -> State {
    let mut state = r
        .record("automation_state", STATE_ID, None, Some(PERSONAL))
        .ok()
        .and_then(|rec| serde_json::from_value::<State>(rec.data).ok())
        .unwrap_or_default();
    state.in_progress = jobs
        .iter()
        .filter(|j| j.kind == "automation_run" && matches!(j.state.as_str(), "queued" | "running"))
        .filter_map(|j| j.payload["automationId"].as_str().map(String::from))
        .collect();
    state
}

/// Writes the state without a revision bump: it is bookkeeping, not something a view shows.
fn save_state(r: &mut Repository, state: &State) -> Result<()> {
    r.put_record_unversioned(&Record {
        id: STATE_ID.into(),
        kind: "automation_state".into(),
        connection_id: None,
        workspace_id: Some(PERSONAL.into()),
        source: "local".into(),
        revision: id(),
        updated_at: now(),
        data: serde_json::to_value(state)
            .map_err(|_| WorkspaceError::new("storage", "Automation state could not be saved."))?,
    })
}

fn event_name(a: &Automation) -> Value {
    match &a.trigger {
        Trigger::Event { event, .. } => serde_json::to_value(event).unwrap_or(Value::Null),
        Trigger::Schedule { .. } => Value::Null,
    }
}

/// Queues one run. The execution key makes a second enqueue of the same run a no-op.
fn enqueue_run(r: &mut Repository, a: &Automation, key: String, trigger: Value) -> Result<String> {
    let policy = r.policy(Some(PERSONAL), None)?;
    let job = new_job(
        "automation_run",
        key,
        Some(PERSONAL.into()),
        None,
        now(),
        policy,
        json!({"automationId": a.id, "title": a.name, "trigger": trigger}),
    );
    r.enqueue(&job)?;
    Ok(job.id)
}

fn invalid_form() -> WorkspaceError {
    invalid(
        "Some automation fields are missing or have the wrong type. Check the form and try again.",
    )
}

impl Core {
    /// The background loop's look at schedules and ended meetings.
    pub(in crate::workspace) fn automations_round(&self) -> Result<()> {
        let now = now();
        let started = *STARTED_AT.get_or_init(|| now);
        self.automations_round_at(now, started)
    }

    pub(super) fn automations_round_at(&self, now: i64, started: i64) -> Result<()> {
        if !workspace_id_active(PERSONAL) {
            return Ok(());
        }
        let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut r = self.repo()?;
        let automations: Vec<_> = load_automations(&r)?
            .into_iter()
            .filter(|(_, a)| a.enabled)
            .collect();
        let jobs = r.jobs()?;
        let mut state = load_state(&r, &jobs);
        let before = serde_json::to_value(&state).unwrap_or(Value::Null);
        if automations.is_empty() {
            if state.last_meeting_check.is_some() {
                state.last_meeting_check = Some(now);
            }
        } else {
            let zone = r.settings()?.time_zone;
            for (rec, a) in automations
                .iter()
                .filter(|(_, a)| matches!(a.trigger, Trigger::Schedule { .. }))
            {
                let last = state
                    .last_slot
                    .get(&a.id)
                    .copied()
                    .unwrap_or(0)
                    .max(rec.updated_at);
                let kind = match due(a, last, now, &zone, started) {
                    Due::No => continue,
                    Due::Now => "schedule",
                    Due::CatchUp => "catch_up",
                };
                let Some(slot) = latest_slot(a, last, now, &zone) else {
                    continue;
                };
                // Handled either way, so a held-back or catch-up slot is never retried later.
                state.last_slot.insert(a.id.clone(), slot);
                if let Some(reason) = state.refusal(&a.id, None, now) {
                    state.skip(&a.id, &format!("schedule:{slot}"), reason, now);
                    continue;
                }
                enqueue_run(
                    &mut r,
                    a,
                    format!("automation:{}:{slot}", a.id),
                    json!({"kind": kind, "scheduledAt": slot}),
                )?;
                state.started(&a.id, None, now);
            }
            if automations.iter().any(|(_, a)| {
                matches!(
                    a.trigger,
                    Trigger::Event {
                        event: EventKind::MeetingEnded,
                        ..
                    }
                )
            }) {
                // At most the 12 h catch-up window back, so enabling the first such automation never replays old meetings.
                let since = state
                    .last_meeting_check
                    .unwrap_or(now)
                    .max(now - CATCH_UP_SECS);
                let ended = self.ended_meetings_since(&r, since, now)?;
                let list: Vec<Automation> = automations.iter().map(|(_, a)| a.clone()).collect();
                for (aid, source) in
                    match_events(&list, &[], &ended, &HashSet::new(), &mut state, now)
                {
                    if let Some(a) = list.iter().find(|a| a.id == aid) {
                        enqueue_run(
                            &mut r,
                            a,
                            format!("automation:{aid}:event:{source}"),
                            json!({"kind": "event", "event": event_name(a), "sourceId": source}),
                        )?;
                    }
                }
            }
            if automations.iter().any(|(_, a)| a.is_summary()) {
                self.match_summary_automations(&mut r, &jobs, &automations, &mut state, now)?;
            }
            state.last_meeting_check = Some(now);
        }
        if serde_json::to_value(&state).unwrap_or(Value::Null) != before {
            save_state(&mut r, &state)?;
        }
        Ok(())
    }

    /// Formal-summary-style automations (DESIGN step 5 §6): for each, the meetings ready for it
    /// (`ready_meetings`) whose title matches its keywords start a run, deduped by
    /// `fired_sources` like every event automation; `meeting_ready` has no cooldown.
    fn match_summary_automations(
        &self,
        r: &mut Repository,
        jobs: &[Job],
        automations: &[(Record, Automation)],
        state: &mut State,
        now: i64,
    ) -> Result<()> {
        let w = r.workspace(PERSONAL)?;
        let Some(c) = r
            .settings()?
            .active_connection
            .and_then(|id| r.connection(&id).ok())
            .filter(|c| c.status == "connected")
        else {
            return Ok(());
        };
        let visible = |rec: &Record| record_selected(rec, &w) && source_permitted(rec, &c);
        let meetings: Vec<MeetingRecord> = r
            .provider_records(&c.id, crate::workspace::meetings::model::KIND)?
            .into_iter()
            .filter(|rec| visible(rec))
            .filter_map(|rec| serde_json::from_value(rec.data).ok())
            .collect();
        let events: HashMap<String, Record> = r
            .provider_records(&c.id, "event")?
            .into_iter()
            .filter(|rec| visible(rec))
            .map(|rec| (rec.id.clone(), rec))
            .collect();
        let auto_rules: Vec<meeting_rules::Rule> = r
            .local_records(PERSONAL, meeting_rules::KIND)?
            .iter()
            .filter_map(meeting_rules::from_record)
            .collect();
        let meeting_settings = r.settings()?.meetings;
        let busy: HashSet<String> = jobs
            .iter()
            .filter(|j| {
                j.kind == "meeting_notes" && matches!(j.state.as_str(), "queued" | "running")
            })
            .filter_map(|j| j.payload["meetingId"].as_str().map(String::from))
            .collect();
        let wants_auto = |m: &MeetingRecord| {
            let data = events
                .get(&m.event_id)
                .map(|e| e.data.clone())
                .unwrap_or_else(|| json!({"title": m.title}));
            meeting_rules::auto_notes(m.auto, &data, &auto_rules, &meeting_settings).0
        };
        for (_, a) in automations.iter().filter(|(_, a)| a.is_summary()) {
            let Trigger::Event { keywords, .. } = &a.trigger else {
                continue;
            };
            let armed = state.armed_at.get(&a.id).copied().unwrap_or(0);
            let ready = ready_meetings(
                &meetings,
                wants_auto,
                &busy,
                armed,
                now,
                meeting_settings.skip_short,
            );
            for m in ready
                .into_iter()
                .filter(|m| keywords_match(keywords, &m.title))
            {
                let key = format!("{}:{}", a.id, m.id);
                if state.fired_sources.contains(&key) {
                    continue;
                }
                // Remembered only once the run is actually queued: a meeting held back by
                // `refusal` (an earlier run still in progress, or the hourly cap) stays
                // eligible for the next round, instead of being skipped forever.
                if let Some(reason) = state.refusal(&a.id, None, now) {
                    state.skip(&a.id, &m.id, reason, now);
                    continue;
                }
                state.remember_source(key);
                state.started(&a.id, None, now);
                enqueue_run(
                    r,
                    a,
                    format!("automation:{}:event:{}", a.id, m.id),
                    json!({"kind": "event", "event": event_name(a), "sourceId": m.id}),
                )?;
            }
        }
        Ok(())
    }

    fn ended_meetings_since(&self, r: &Repository, since: i64, now: i64) -> Result<Vec<MeetingIn>> {
        let Some(c) = r
            .settings()?
            .active_connection
            .and_then(|id| r.connection(&id).ok())
            .filter(|c| c.status == "connected")
        else {
            return Ok(Vec::new());
        };
        let w = r.workspace(PERSONAL)?;
        let events: Vec<Record> = r
            .provider_records(&c.id, "event")?
            .into_iter()
            .filter(|e| record_selected(e, &w) && source_permitted(e, &c))
            .collect();
        Ok(ended_meetings(&events, since, now))
    }

    /// After a sync round committed: the messages first seen in it may start event automations.
    /// The first round after install only records what is already there.
    pub(in crate::workspace) fn automations_after_sync(&self) -> Result<()> {
        if !workspace_id_active(PERSONAL) {
            return Ok(());
        }
        let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut r = self.repo()?;
        let Some(c) = r
            .settings()?
            .active_connection
            .and_then(|id| r.connection(&id).ok())
            .filter(|c| c.status == "connected")
        else {
            return Ok(());
        };
        let w = r.workspace(PERSONAL)?;
        if w.archived || w.connection_id.as_deref() != Some(&c.id) {
            return Ok(());
        }
        // The Inbox projection decides what is critical; nothing here classifies on its own.
        let mut records = r.account_workspace_records(&c.id, PERSONAL)?;
        inbox::project(&r, &w, Some(&c), &mut records)?;
        let messages: Vec<&Record> = records
            .iter()
            .filter(|m| {
                m.kind == "message"
                    && record_selected(m, &w)
                    && source_permitted(m, &c)
                    && source_available(m)
            })
            .collect();
        let jobs = r.jobs()?;
        let mut state = load_state(&r, &jobs);
        state.follow_account(&c.id);
        // "Seen" is every message in the cache, not what this view shows, so a message that leaves
        // the view (source change, outage) and returns is never new again. Ids are dropped only
        // when the record leaves the cache.
        let cached: HashSet<String> = r
            .provider_records(&c.id, "message")?
            .into_iter()
            .map(|m| m.id)
            .collect();
        let known: HashSet<String> = state.seen_messages.iter().cloned().collect();
        let first_seen: HashSet<&String> = cached.difference(&known).collect();
        let new: Vec<&Record> = messages
            .iter()
            .copied()
            .filter(|m| first_seen.contains(&m.id))
            .collect();
        let added: Vec<String> = first_seen.iter().map(|id| (*id).clone()).collect();
        state.seen_messages.retain(|id| cached.contains(id));
        state.seen_messages.extend(added);
        let first_round = !state.initialized;
        state.initialized = true;
        if !first_round && !new.is_empty() {
            let automations: Vec<Automation> = load_automations(&r)?
                .into_iter()
                .map(|(_, a)| a)
                .filter(|a| a.enabled)
                .collect();
            let inputs: Vec<MessageIn> = new.iter().map(|m| MessageIn::from_record(m)).collect();
            let critical: HashSet<String> = new
                .iter()
                .filter(|m| m.data["lane"] == "critical")
                .map(|m| m.id.clone())
                .collect();
            for (aid, source) in
                match_events(&automations, &inputs, &[], &critical, &mut state, now())
            {
                if let Some(a) = automations.iter().find(|a| a.id == aid) {
                    enqueue_run(
                        &mut r,
                        a,
                        format!("automation:{aid}:event:{source}"),
                        json!({"kind": "event", "event": event_name(a), "sourceId": source}),
                    )?;
                }
            }
        }
        save_state(&mut r, &state)
    }

    /// `automation_save`, `automation_delete`, `automation_toggle` and `automation_run_now`.
    pub(in crate::workspace) fn automation_op(&self, req: &Request) -> Result<Value> {
        // Same order as the background rounds (state lock, then the repository).
        let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut r = self.repo()?;
        match req.op {
            Operation::AutomationSave => {
                let mut a: Automation =
                    serde_json::from_value(req.data.clone()).map_err(|_| invalid_form())?;
                a.normalize();
                let note_templates = templates::all(&r.local_records(PERSONAL, templates::KIND)?);
                validate(&a, &note_templates)?;
                if a.id.is_empty() {
                    a.id = req.operation_id.clone().unwrap_or_else(id);
                } else if a.id.chars().count() > 200 {
                    return Err(invalid_form());
                }
                let previous = match r.record("automation", &a.id, None, Some(PERSONAL)) {
                    Ok(rec) => Some(rec),
                    Err(e) if e.code == "not_found" => None,
                    Err(e) => return Err(e),
                };
                if previous.is_none()
                    && r.local_records(PERSONAL, "automation")?.len() >= MAX_AUTOMATIONS
                {
                    return Err(invalid(
                        "You can keep up to 50 automations. Delete one first.",
                    ));
                }
                // Turning Today delivery on (or creating with it) puts the Automation results
                // card on Today, unless it is there or the layout is full. A card the user
                // removed stays removed while delivery stays on.
                // Only an automation that is on: a copy that stays off (Duplicate) never brings
                // back a card the user removed.
                let was_on = previous.as_ref().is_some_and(|p| {
                    p.data["deliver"]["today"] == true && p.data["enabled"] != false
                });
                let mut card = None;
                if a.enabled && a.deliver.today && !was_on {
                    let mut w = r.workspace(PERSONAL)?;
                    if !w.layout.iter().any(|id| id == "automations")
                        && w.layout.len() < MAX_WIDGETS
                    {
                        w.layout.push("automations".into());
                        if let Some(h) = w.today.get_mut("hidden").and_then(Value::as_array_mut) {
                            h.retain(|id| id != "automations");
                        }
                        w.revision += 1;
                        card = Some(w);
                    }
                }
                let record = automation_record(&a)?;
                r.save_automation(&record, card.as_ref())?;
                // Saving (new or edited) arms the automation: a `meeting_ready` match only counts
                // a meeting that ended after this moment.
                let jobs = r.jobs()?;
                let mut state = load_state(&r, &jobs);
                state.armed_at.insert(a.id.clone(), now());
                save_state(&mut r, &state)?;
                Ok(json!({"record": record, "todayCard": card.is_some()}))
            }
            Operation::AutomationDelete => {
                let aid = required(&req.data, "id", 200)?;
                r.delete_local("automation", aid, PERSONAL)?;
                r.delete_automation_runs(aid)?;
                // A queued run never starts; a running one is stopped, and as its claim is gone
                // its result is discarded.
                for mut job in r.jobs()? {
                    if job.kind == "automation_run"
                        && matches!(job.state.as_str(), "queued" | "running")
                        && job.payload["automationId"] == aid
                    {
                        job.state = "cancelled".into();
                        job.lease_until = None;
                        job.result = Some("Automation deleted".into());
                        r.save_job(&job)?;
                        self.cancel_ai_job(&job.id);
                    }
                }
                let jobs = r.jobs()?;
                let mut state = load_state(&r, &jobs);
                state.forget(aid);
                save_state(&mut r, &state)?;
                Ok(json!({"deleted": true}))
            }
            Operation::AutomationToggle => {
                let aid = required(&req.data, "id", 200)?;
                let Some(enabled) = req.data["enabled"].as_bool() else {
                    return Err(invalid("Choose whether the automation is on or off."));
                };
                let mut a = stored(&r, aid)?;
                a.enabled = enabled;
                let record = automation_record(&a)?;
                r.put_record(&record)?;
                if enabled {
                    // Turning it on arms it, same as a save; turning off leaves the armed time.
                    let jobs = r.jobs()?;
                    let mut state = load_state(&r, &jobs);
                    state.armed_at.insert(aid.to_string(), now());
                    save_state(&mut r, &state)?;
                }
                Ok(json!({"record": record}))
            }
            Operation::AutomationRunNow => {
                let aid = required(&req.data, "id", 200)?;
                let a = stored(&r, aid)?;
                let running = r.jobs()?.into_iter().any(|j| {
                    j.kind == "automation_run"
                        && matches!(j.state.as_str(), "queued" | "running")
                        && j.payload["automationId"] == aid
                });
                if running {
                    return Err(WorkspaceError::new(
                        "conflict",
                        "This automation is already running.",
                    ));
                }
                // A manual run counts toward the hourly cap but not the cooldown.
                let jobs = r.jobs()?;
                let mut state = load_state(&r, &jobs);
                if let Some(reason) = state.refusal(aid, None, now()) {
                    return Err(WorkspaceError::new("conflict", reason));
                }
                state.runs.push(now());
                save_state(&mut r, &state)?;
                let key = format!(
                    "automation:{aid}:manual:{}",
                    req.operation_id.as_deref().unwrap_or("")
                );
                let job = enqueue_run(&mut r, &a, key, json!({"kind": "manual"}))?;
                Ok(json!({"queued": true, "jobId": job}))
            }
            _ => Err(WorkspaceError::new("validation", "Unsupported operation.")),
        }
    }
}

/// Runs per Run log page unless asked otherwise, and the most one page holds.
const RUNS_PAGE: u64 = 20;
const RUNS_PAGE_MAX: u64 = 50;

/// The cursor after `run`: when it started and its id.
fn cursor(run: &Record) -> String {
    format!("{}:{}", run.data["startedAt"].as_i64().unwrap_or(0), run.id)
}
fn parse_cursor(text: &str) -> Option<(i64, String)> {
    let (at, id) = text.split_once(':')?;
    let at = at.parse().ok()?;
    (!id.is_empty() && id.chars().count() <= 200).then(|| (at, id.to_string()))
}

impl Core {
    /// `automation_runs {automationId?, limit?, before?}`: one page of the Run log, newest first,
    /// with `next`, the cursor of the page after it (null at the end). Read-only like `ai_status`:
    /// no operation id and no revision bump. Shows what the snapshot would show of each run.
    pub(in crate::workspace) fn automation_runs(&self, req: &Request) -> Result<Value> {
        let automation = match req.data.get("automationId") {
            None | Some(Value::Null) => None,
            Some(_) => Some(required(&req.data, "automationId", 200)?),
        };
        let limit = match req.data.get("limit") {
            None | Some(Value::Null) => RUNS_PAGE,
            Some(v) => v
                .as_u64()
                .filter(|n| (1..=RUNS_PAGE_MAX).contains(n))
                .ok_or_else(|| invalid("Ask for 1 to 50 runs."))?,
        } as usize;
        let before = match req.data.get("before") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.as_str().and_then(parse_cursor).ok_or_else(|| {
                invalid("This page of the run log is no longer available. Reload it.")
            })?),
        };
        let r = self.repo()?;
        let account = r.visible_account(&r.workspace(PERSONAL)?)?;
        let (runs, more) = r.automation_runs(
            PERSONAL,
            account.as_deref(),
            automation,
            limit,
            before.as_ref().map(|(at, id)| (*at, id.as_str())),
        )?;
        let next = more.then(|| runs.last().map(cursor)).flatten();
        Ok(json!({"runs": runs, "next": next}))
    }

    /// The address of the `n`-th link (in reading order) of a stored run's summary blocks, for
    /// Open: the renderer names a link, never an address (DESIGN 6.6, ruling R26). Only a run
    /// the snapshot would show, and only secure links.
    pub(in crate::workspace) fn automation_run_link(&self, run_id: &str, n: i64) -> Result<String> {
        let missing = || WorkspaceError::new("not_found", "This link is no longer available.");
        let r = self.repo()?;
        let run = match r.record("automation_run", run_id, None, Some(PERSONAL)) {
            Err(e) if e.code == "not_found" => return Err(missing()),
            other => other?,
        };
        if let Some(owner) = run.data["connectionId"].as_str() {
            if r.visible_account(&r.workspace(PERSONAL)?)?.as_deref() != Some(owner) {
                return Err(missing());
            }
        }
        let n = usize::try_from(n).map_err(|_| missing())?;
        let href = run.data["output"]["summaryBlocks"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|b| b["inlines"].as_array().into_iter().flatten())
            .filter_map(|i| i["href"].as_str())
            .nth(n)
            .ok_or_else(missing)?;
        if !href.starts_with("https://") {
            return Err(invalid("Connect opens only secure (https) links."));
        }
        Ok(href.into())
    }
}

/// The saved automation `id`.
pub(super) fn stored(r: &Repository, id: &str) -> Result<Automation> {
    let rec = r.record("automation", id, None, Some(PERSONAL))?;
    let mut a: Automation = serde_json::from_value(rec.data).map_err(|_| invalid_form())?;
    a.id = rec.id;
    Ok(a)
}

fn automation_record(a: &Automation) -> Result<Record> {
    Ok(Record {
        id: a.id.clone(),
        kind: "automation".into(),
        connection_id: None,
        workspace_id: Some(PERSONAL.into()),
        source: "local".into(),
        revision: id(),
        updated_at: now(),
        data: serde_json::to_value(a).map_err(|_| invalid_form())?,
    })
}

#[cfg(test)]
mod engine_tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::ai::stream::{RunOutcome, Usage};
    use crate::workspace::ai::tests::{mutation, ready};
    use crate::workspace::test_core;
    use std::sync::Arc;

    fn core(dir: &std::path::Path) -> Arc<Core> {
        test_core(dir, Arc::new(FakeRunner::new(vec![])), ready())
    }
    fn ts(v: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(v).unwrap().timestamp()
    }
    fn schedule_json() -> Value {
        json!({"id":"auto-schedule","name":"Morning brief","enabled":true,
            "trigger":{"kind":"schedule","days":[1,2,3,4,5],"time":"08:45"},
            "read":{"calendarToday":true,"needsReply":true,"commitmentsNotes":true},
            "prompt":"Summarize my day and what needs a reply.",
            "ai":{"profile":"claude","model":"claude-haiku-4-5"},"capUsd":0.5,
            "deliver":{"today":true,"notify":true},"catchUp":true})
    }
    fn event_json() -> Value {
        json!({"id":"auto-event","name":"Draft replies to Ann","enabled":true,
            "trigger":{"kind":"event","event":"mail_from","senders":["@epam.com","ann@example.org"],"keywords":["budget"]},
            "read":{"triggerConversation":true,"mailFromSenderDays":7},
            "prompt":"Draft a short reply to the message that started this run.",
            "ai":{},"deliver":{"today":true,"draftReply":true},"catchUp":false})
    }
    /// A summary automation: `meetingSummary` names an existing note template (`meeting-notes`,
    /// so this fixture stays unchanged by the Formal summary built-in) and reads nothing.
    fn summary_json() -> Value {
        json!({"id":"auto-summary","name":"Formal summary","enabled":true,
            "trigger":{"kind":"event","event":"meeting_ready"},
            "prompt":"",
            "deliver":{"meetingSummary":"meeting-notes"}})
    }
    fn jobs_of(core: &Core) -> Vec<Job> {
        core.repo()
            .unwrap()
            .jobs()
            .unwrap()
            .into_iter()
            .filter(|j| j.kind == "automation_run")
            .collect()
    }

    #[tokio::test]
    async fn operations_save_toggle_run_now_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let saved = core
            .request(mutation(&core, Operation::AutomationSave, schedule_json()))
            .await
            .unwrap();
        assert_eq!(saved["record"]["kind"], "automation");
        assert_eq!(saved["record"]["data"]["trigger"]["kind"], "schedule");
        // A mistake comes back as a sentence for the editor and saves nothing.
        let mut bad = event_json();
        bad["trigger"]["senders"] = json!([]);
        let err = core
            .request(mutation(&core, Operation::AutomationSave, bad))
            .await
            .unwrap_err();
        assert_eq!(err.code, "validation");
        assert_eq!(
            err.message,
            "Add at least one sender or domain for this trigger."
        );
        assert_eq!(
            core.repo()
                .unwrap()
                .local_records("personal", "automation")
                .unwrap()
                .len(),
            1
        );

        let off = core
            .request(mutation(
                &core,
                Operation::AutomationToggle,
                json!({"id":"auto-schedule","enabled":false}),
            ))
            .await
            .unwrap();
        assert_eq!(off["record"]["data"]["enabled"], false);

        let run = core
            .request(mutation(
                &core,
                Operation::AutomationRunNow,
                json!({"id":"auto-schedule"}),
            ))
            .await
            .unwrap();
        assert_eq!(run["queued"], true);
        let jobs = jobs_of(&core);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].payload["trigger"]["kind"], "manual");
        // A second run while one is queued is refused, not queued behind it.
        let again = core
            .request(mutation(
                &core,
                Operation::AutomationRunNow,
                json!({"id":"auto-schedule"}),
            ))
            .await
            .unwrap_err();
        assert_eq!(again.message, "This automation is already running.");

        core.request(mutation(
            &core,
            Operation::AutomationDelete,
            json!({"id":"auto-schedule"}),
        ))
        .await
        .unwrap();
        assert!(core
            .repo()
            .unwrap()
            .local_records("personal", "automation")
            .unwrap()
            .is_empty());
        assert_eq!(jobs_of(&core)[0].state, "cancelled");
    }

    #[tokio::test]
    async fn a_missed_schedule_is_caught_up_once_and_the_key_blocks_a_double_enqueue() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.request(mutation(&core, Operation::AutomationSave, schedule_json()))
            .await
            .unwrap();
        // Saved a day ago; Connect opened at 09:30 and the 08:45 run was missed.
        let mut record = core
            .repo()
            .unwrap()
            .record("automation", "auto-schedule", None, Some("personal"))
            .unwrap();
        record.updated_at = ts("2026-03-23T00:00:00Z");
        core.repo().unwrap().put_record(&record).unwrap();
        let (now, started) = (ts("2026-03-24T10:00:00Z"), ts("2026-03-24T09:30:00Z"));
        core.automations_round_at(now, started).unwrap();
        core.automations_round_at(now + 15, started).unwrap();
        let jobs = jobs_of(&core);
        assert_eq!(jobs.len(), 1);
        assert_eq!(
            jobs[0].key,
            format!("automation:auto-schedule:{}", ts("2026-03-24T08:45:00Z"))
        );
        assert_eq!(jobs[0].payload["trigger"]["kind"], "catch_up");
        // The same key can never be queued twice, even if the state were lost.
        let a = stored(&core.repo().unwrap(), "auto-schedule").unwrap();
        let key = jobs[0].key.clone();
        enqueue_run(&mut core.repo().unwrap(), &a, key, json!({})).unwrap();
        assert_eq!(jobs_of(&core).len(), 1);
    }

    fn seed(core: &Core) {
        let mut r = core.repo().unwrap();
        let c = Connection {
            id: "acct".into(),
            account_key: "acct".into(),
            display_name: "Taylor Reed".into(),
            email: "taylor@example.test".into(),
            user_id: "me-1".into(),
            generation: 1,
            policy_revision: 1,
            scopes: vec![
                "Calendars.Read".into(),
                "Mail.Read".into(),
                "Chat.Read".into(),
            ],
            enabled: vec!["calendar".into(), "mail".into(), "chats".into()],
            status: "connected".into(),
            ..Default::default()
        };
        r.save_connection(&c).unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some("acct".into());
        r.settings_update(&s).unwrap();
        let mut w = r.workspace("personal").unwrap();
        w.connection_id = Some("acct".into());
        w.sources = json!({"all": true});
        r.save_workspace(&w).unwrap();
    }
    fn mail(id: &str, from: &str, mine: bool) -> Record {
        Record {
            id: id.into(),
            kind: "message".into(),
            connection_id: Some("acct".into()),
            workspace_id: None,
            source: "mail:inbox".into(),
            revision: "v1".into(),
            updated_at: 1,
            data: json!({"channel":"mail","conversationId":format!("c-{id}"),"title":"Q3 budget",
                "from":"Ann","fromAddress":from,"to":[],"isMine":mine,"at":1,"text":"Budget numbers attached"}),
        }
    }

    #[tokio::test]
    async fn only_messages_first_seen_after_the_baseline_start_event_runs() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        seed(&core);
        core.request(mutation(&core, Operation::AutomationSave, event_json()))
            .await
            .unwrap();
        core.repo()
            .unwrap()
            .put_record(&mail("old", "ann@epam.com", false))
            .unwrap();
        // The first round is only the baseline: the old message starts nothing.
        core.automations_after_sync().unwrap();
        assert!(jobs_of(&core).is_empty());
        core.repo()
            .unwrap()
            .put_record(&mail("mine", "taylor@epam.com", true))
            .unwrap();
        core.repo()
            .unwrap()
            .put_record(&mail("stranger", "x@other.com", false))
            .unwrap();
        core.repo()
            .unwrap()
            .put_record(&mail("new", "pat@epam.com", false))
            .unwrap();
        core.automations_after_sync().unwrap();
        let jobs = jobs_of(&core);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].key, "automation:auto-event:event:new");
        assert_eq!(jobs[0].payload["trigger"]["sourceId"], "new");
        // An edit of a known message is not new.
        core.repo()
            .unwrap()
            .put_record(&mail("old", "ann@epam.com", false))
            .unwrap();
        core.automations_after_sync().unwrap();
        assert_eq!(jobs_of(&core).len(), 1);
        // The state is stored without bumping the revision a view fences on.
        let before = core.repo().unwrap().revision().unwrap();
        core.automations_after_sync().unwrap();
        assert_eq!(core.repo().unwrap().revision().unwrap(), before);
    }

    #[tokio::test]
    async fn a_new_account_is_a_baseline_not_a_backlog() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        seed(&core);
        core.request(mutation(&core, Operation::AutomationSave, event_json()))
            .await
            .unwrap();
        core.repo()
            .unwrap()
            .put_record(&mail("old", "ann@epam.com", false))
            .unwrap();
        core.automations_after_sync().unwrap();
        // Signing in to another account: its first sync fills the cache with mail Connect has
        // never seen, which must not start a run per matching message.
        {
            let mut r = core.repo().unwrap();
            let mut other = r.connection("acct").unwrap();
            other.id = "acct-2".into();
            other.account_key = "acct-2".into();
            r.save_connection(&other).unwrap();
            let mut s = r.settings().unwrap();
            s.active_connection = Some("acct-2".into());
            r.settings_update(&s).unwrap();
            let mut w = r.workspace("personal").unwrap();
            w.connection_id = Some("acct-2".into());
            r.save_workspace(&w).unwrap();
            for id in ["b1", "b2", "b3"] {
                let mut m = mail(id, "pat@epam.com", false);
                m.connection_id = Some("acct-2".into());
                r.put_record(&m).unwrap();
            }
        }
        core.automations_after_sync().unwrap();
        assert!(
            jobs_of(&core).is_empty(),
            "the new account's backlog must not fire"
        );
        // Mail that arrives after that baseline does.
        let mut fresh = mail("b4", "pat@epam.com", false);
        fresh.connection_id = Some("acct-2".into());
        core.repo().unwrap().put_record(&fresh).unwrap();
        core.automations_after_sync().unwrap();
        let keys: Vec<String> = jobs_of(&core).into_iter().map(|j| j.key).collect();
        assert_eq!(keys, vec!["automation:auto-event:event:b4"]);
    }

    #[tokio::test]
    async fn validation_sentences_name_their_field() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let mut cases = Vec::new();
        let mut no_senders = event_json();
        no_senders["trigger"]["senders"] = json!([]);
        cases.push((no_senders, "senders"));
        let mut no_days = schedule_json();
        no_days["trigger"]["days"] = json!([]);
        cases.push((no_days, "days"));
        let mut bad_time = schedule_json();
        bad_time["trigger"]["time"] = "8:45".into();
        cases.push((bad_time, "time"));
        let mut no_name = schedule_json();
        no_name["name"] = " ".into();
        cases.push((no_name, "name"));
        let mut cap = schedule_json();
        cap["capUsd"] = json!(500);
        cases.push((cap, "capUsd"));
        let mut draft = schedule_json();
        draft["deliver"]["draftReply"] = true.into();
        cases.push((draft, "deliver"));
        for (data, field) in cases {
            let err = core
                .request(mutation(&core, Operation::AutomationSave, data))
                .await
                .unwrap_err();
            assert_eq!(err.code, "validation");
            assert_eq!(err.field.as_deref(), Some(field), "{}", err.message);
        }
    }

    #[tokio::test]
    async fn turning_today_delivery_on_brings_back_a_hidden_automations_card() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        {
            let mut r = core.repo().unwrap();
            let mut w = r.workspace(PERSONAL).unwrap();
            w.layout = vec!["brief".into()];
            w.today = json!({"hidden": ["automations"]});
            r.save_workspace(&w).unwrap();
        }
        core.request(mutation(&core, Operation::AutomationSave, schedule_json()))
            .await
            .unwrap();
        let w = core.repo().unwrap().workspace(PERSONAL).unwrap();
        assert_eq!(w.layout, vec!["brief", "automations"]);
        assert_eq!(w.today["hidden"], json!([]));
    }

    #[tokio::test]
    async fn adding_the_automations_card_leaves_an_empty_today_object_empty() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        {
            let mut r = core.repo().unwrap();
            let mut w = r.workspace(PERSONAL).unwrap();
            w.layout = vec!["brief".into()];
            w.today = json!({});
            r.save_workspace(&w).unwrap();
        }
        core.request(mutation(&core, Operation::AutomationSave, schedule_json()))
            .await
            .unwrap();
        let w = core.repo().unwrap().workspace(PERSONAL).unwrap();
        assert_eq!(w.layout, vec!["brief", "automations"]);
        assert_eq!(w.today, json!({}));
    }

    #[tokio::test]
    async fn saving_an_automation_that_delivers_to_today_adds_the_card_once() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let layout = |core: &Core| core.repo().unwrap().workspace(PERSONAL).unwrap().layout;
        let set_layout = |core: &Core, ids: Vec<String>| {
            let mut r = core.repo().unwrap();
            let mut w = r.workspace(PERSONAL).unwrap();
            w.layout = ids;
            r.save_workspace(&w).unwrap();
        };
        set_layout(&core, vec!["brief".into(), "inbox".into()]);
        // A new automation that delivers to Today brings the card, in the same save.
        let saved = core
            .request(mutation(&core, Operation::AutomationSave, schedule_json()))
            .await
            .unwrap();
        assert_eq!(saved["todayCard"], true);
        assert_eq!(layout(&core), vec!["brief", "inbox", "automations"]);
        // Removed by the user, it stays removed while Today delivery stays on.
        set_layout(&core, vec!["brief".into()]);
        core.request(mutation(&core, Operation::AutomationSave, schedule_json()))
            .await
            .unwrap();
        assert_eq!(layout(&core), vec!["brief"]);
        // A copy that is off (Duplicate) never brings it back.
        let mut copy = schedule_json();
        copy["id"] = "auto-copy".into();
        copy["enabled"] = false.into();
        let saved = core
            .request(mutation(&core, Operation::AutomationSave, copy))
            .await
            .unwrap();
        assert_eq!(saved["todayCard"], false);
        assert_eq!(layout(&core), vec!["brief"]);
        // Turning Today delivery on again brings it back.
        let mut off = schedule_json();
        off["deliver"]["today"] = false.into();
        core.request(mutation(&core, Operation::AutomationSave, off))
            .await
            .unwrap();
        assert_eq!(layout(&core), vec!["brief"]);
        core.request(mutation(&core, Operation::AutomationSave, schedule_json()))
            .await
            .unwrap();
        assert_eq!(layout(&core), vec!["brief", "automations"]);
        // A full layout (16 cards) is left alone and the automation is still saved.
        let full: Vec<String> = (0..16).map(|n| format!("plugin:plugin-{n}:w")).collect();
        set_layout(&core, full.clone());
        let mut other = event_json();
        other["id"] = "auto-new".into();
        let saved = core
            .request(mutation(&core, Operation::AutomationSave, other))
            .await
            .unwrap();
        assert_eq!(saved["todayCard"], false);
        assert_eq!(layout(&core), full);
        assert!(core
            .repo()
            .unwrap()
            .record("automation", "auto-new", None, Some(PERSONAL))
            .is_ok());
    }

    /// A stored run of `automation` that started at `started`; `today` delivers it to Today.
    fn stored_run(id: &str, automation: &str, started: i64, today: bool, account: Value) -> Record {
        Record {
            id: id.into(),
            kind: "automation_run".into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "automation".into(),
            revision: "v1".into(),
            updated_at: started + 5,
            data: json!({"automationId": automation, "status": if today { "ok" } else { "failed" },
                "startedAt": started, "delivered": if today { json!(["today"]) } else { json!([]) },
                "connectionId": account}),
        }
    }
    fn read(op: Operation, data: Value) -> Request {
        Request {
            op,
            workspace_id: Some(PERSONAL.into()),
            expected_revision: None,
            operation_id: None,
            data,
        }
    }
    fn ids(runs: &Value) -> Vec<String> {
        runs.as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn automation_runs_page_newest_first_and_the_snapshot_keeps_the_latest() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        seed(&core);
        for data in [schedule_json(), event_json()] {
            core.request(mutation(&core, Operation::AutomationSave, data))
                .await
                .unwrap();
        }
        {
            let mut r = core.repo().unwrap();
            for run in [
                stored_run("s-today", "auto-schedule", 100, true, json!("acct")),
                stored_run("s-failed", "auto-schedule", 200, false, json!("acct")),
                stored_run("s-quiet", "auto-schedule", 150, false, Value::Null),
                // A run that read another account's mail never shows while this one is signed in.
                stored_run("e-other", "auto-event", 120, true, json!("acct-2")),
                stored_run("e-today", "auto-event", 110, true, json!("acct")),
            ] {
                r.put_automation_run(&run, None).unwrap();
            }
        }
        // The snapshot carries each automation's latest run and its latest run on Today.
        let snapshot = core.repo().unwrap().snapshot().unwrap();
        let mut in_snapshot: Vec<&str> = snapshot
            .records
            .iter()
            .filter(|r| r.kind == "automation_run")
            .map(|r| r.id.as_str())
            .collect();
        in_snapshot.sort();
        assert_eq!(in_snapshot, vec!["e-today", "s-failed", "s-today"]);

        // The Run log reads pages, newest first, without an operation id or a revision bump.
        let before = core.repo().unwrap().revision().unwrap();
        let first = core
            .request(read(Operation::AutomationRuns, json!({"limit": 2})))
            .await
            .unwrap();
        assert_eq!(ids(&first["runs"]), vec!["s-failed", "s-quiet"]);
        let next = first["next"].as_str().unwrap().to_string();
        let second = core
            .request(read(
                Operation::AutomationRuns,
                json!({"limit": 2, "before": next}),
            ))
            .await
            .unwrap();
        assert_eq!(ids(&second["runs"]), vec!["e-today", "s-today"]);
        assert!(second["next"].is_null());
        let one = core
            .request(read(
                Operation::AutomationRuns,
                json!({"automationId": "auto-event"}),
            ))
            .await
            .unwrap();
        assert_eq!(ids(&one["runs"]), vec!["e-today"]);
        assert_eq!(core.repo().unwrap().revision().unwrap(), before);

        for (bad, message) in [
            (json!({"limit": 51}), "Ask for 1 to 50 runs."),
            (json!({"limit": 0}), "Ask for 1 to 50 runs."),
            (
                json!({"before": "yesterday"}),
                "This page of the run log is no longer available. Reload it.",
            ),
        ] {
            let err = core
                .request(read(Operation::AutomationRuns, bad))
                .await
                .unwrap_err();
            assert_eq!(err.message, message);
        }
    }

    #[tokio::test]
    async fn run_links_resolve_only_from_the_stored_summary() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        seed(&core);
        let mut run = stored_run("run-1", "auto-schedule", 100, true, json!("acct"));
        run.data["output"] = json!({"summaryBlocks": [
            {"type": "paragraph", "inlines": [{"text": "See "}, {"text": "the plan", "href": "https://example.test/plan"}]},
            {"type": "item", "inlines": [{"text": "plain"}, {"text": "old", "href": "http://example.test/old"}]},
        ]});
        let mut hidden = run.clone();
        hidden.id = "run-2".into();
        hidden.data["connectionId"] = "acct-2".into();
        {
            let mut r = core.repo().unwrap();
            r.put_automation_run(&run, None).unwrap();
            r.put_automation_run(&hidden, None).unwrap();
        }
        let link = |id: &str, n: i64| core.automation_run_link(id, n);
        assert_eq!(link("run-1", 0).unwrap(), "https://example.test/plan");
        assert_eq!(
            link("run-1", 1).unwrap_err().message,
            "Connect opens only secure (https) links."
        );
        assert_eq!(link("run-1", 2).unwrap_err().code, "not_found");
        assert_eq!(link("run-1", -1).unwrap_err().code, "not_found");
        assert_eq!(link("run-2", 0).unwrap_err().code, "not_found");
        assert_eq!(link("missing", 0).unwrap_err().code, "not_found");
    }

    #[tokio::test]
    async fn contract_fixtures() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let mut files = Vec::new();
        for (file, data) in [
            ("automation-schedule.json", schedule_json()),
            ("automation-event.json", event_json()),
            ("automation-summary.json", summary_json()),
        ] {
            let saved = core
                .request(mutation(&core, Operation::AutomationSave, data))
                .await
                .unwrap();
            let mut record = saved["record"].clone();
            record["revision"] = "rev-1".into();
            record["updatedAt"] = 1_795_000_500.into();
            files.push((file, record));
        }
        // One file holds all three, as the brief asks: a saved schedule, event and summary automation.
        let value = json!({"schedule": files[0].1, "event": files[1].1, "summary": files[2].1});
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/test/fixtures/contract");
        let path = dir.join("automation.json");
        let text = serde_json::to_string_pretty(&value).unwrap() + "\n";
        if std::env::var("UPDATE_CONTRACT_FIXTURES").is_ok_and(|v| v == "1") {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(&path, &text).unwrap();
        } else {
            let saved = std::fs::read_to_string(&path).unwrap_or_default();
            assert_eq!(
                saved, text,
                "automation.json is stale: run UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures"
            );
        }
    }

    fn meeting(id: &str, end: i64) -> Record {
        let at = |t: i64| chrono::DateTime::from_timestamp(t, 0).unwrap().to_rfc3339();
        Record {
            id: id.into(),
            kind: "event".into(),
            connection_id: Some("acct".into()),
            workspace_id: None,
            source: "calendar:cal1".into(),
            revision: "v1".into(),
            updated_at: 1,
            data: json!({"title":"Planning","start":at(end - 1800),"end":at(end),"allDay":false,"cancelled":false,"response":"accepted"}),
        }
    }
    fn meeting_automation(id: &str) -> Value {
        json!({"id":id,"name":format!("After {id}"),"enabled":true,
            "trigger":{"kind":"event","event":"meeting_ended"},
            "prompt":"Write the follow-ups.","deliver":{"today":true}})
    }

    #[tokio::test]
    async fn meetings_that_ended_during_a_sleep_each_run_once() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        seed(&core);
        for id in ["m-a", "m-b"] {
            core.request(mutation(
                &core,
                Operation::AutomationSave,
                meeting_automation(id),
            ))
            .await
            .unwrap();
        }
        let t0 = ts("2026-03-24T09:00:00Z");
        let started = t0 - 600;
        core.automations_round_at(t0, started).unwrap();
        {
            let mut r = core.repo().unwrap();
            // One ended 1 h and one 2.5 h before waking; an all-day one and a declined one never count.
            r.put_record(&meeting("ev-1", t0 + 2 * 1800)).unwrap();
            r.put_record(&meeting("ev-2", t0 + 3 * 3600 - 1800))
                .unwrap();
            let mut all_day = meeting("ev-3", t0 + 3600);
            all_day.data["allDay"] = true.into();
            r.put_record(&all_day).unwrap();
            let mut declined = meeting("ev-4", t0 + 3600);
            declined.data["response"] = "declined".into();
            r.put_record(&declined).unwrap();
        }
        assert!(jobs_of(&core).is_empty());
        let woke = t0 + 3 * 3600;
        core.automations_round_at(woke, started).unwrap();
        let keys: Vec<String> = jobs_of(&core).into_iter().map(|j| j.key).collect();
        // The cooldown is per meeting now, so each automation runs for both ended meetings.
        assert_eq!(keys.len(), 4, "{keys:?}");
        for id in ["m-a", "m-b"] {
            assert!(
                keys.contains(&format!("automation:{id}:event:ev-1")),
                "{keys:?}"
            );
            assert!(
                keys.contains(&format!("automation:{id}:event:ev-2")),
                "{keys:?}"
            );
        }
        core.automations_round_at(woke + 15, started).unwrap();
        core.automations_round_at(woke + 7200, started).unwrap();
        assert_eq!(jobs_of(&core).len(), 4);
    }

    #[tokio::test]
    async fn messages_that_leave_and_return_to_the_view_are_not_new() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        seed(&core);
        core.request(mutation(&core, Operation::AutomationSave, event_json()))
            .await
            .unwrap();
        core.repo()
            .unwrap()
            .put_record(&mail("old", "ann@epam.com", false))
            .unwrap();
        core.automations_after_sync().unwrap();
        let set_sources = |sources: Value| {
            let mut r = core.repo().unwrap();
            let mut w = r.workspace("personal").unwrap();
            w.sources = sources;
            r.save_workspace(&w).unwrap();
        };
        // The user unticks mail, a sync runs, then mail is ticked again.
        set_sources(json!({"chats": []}));
        core.automations_after_sync().unwrap();
        set_sources(json!({"all": true}));
        core.automations_after_sync().unwrap();
        assert!(jobs_of(&core).is_empty(), "the backlog must not fire");
    }

    #[tokio::test]
    async fn a_critical_message_starts_a_critical_automation() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        seed(&core);
        let critical = json!({"id":"auto-crit","name":"Critical triage","enabled":true,
            "trigger":{"kind":"event","event":"critical"},"prompt":"Triage this.","deliver":{"notify":true}});
        core.request(mutation(&core, Operation::AutomationSave, critical))
            .await
            .unwrap();
        {
            let mut r = core.repo().unwrap();
            r.put_record(&Record {
                id: "rule-1".into(),
                kind: "rule".into(),
                connection_id: None,
                workspace_id: Some("personal".into()),
                source: "local".into(),
                revision: "v1".into(),
                updated_at: 1,
                data: json!({"enabled":true,"lane":"critical","keyword":"outage"}),
            })
            .unwrap();
        }
        core.automations_after_sync().unwrap();
        let mut outage = mail("outage-1", "ops@epam.com", false);
        outage.data["text"] = "Production outage in progress".into();
        let mut calm = mail("calm-1", "ops@epam.com", false);
        calm.data["text"] = "Nothing to do".into();
        core.repo().unwrap().put_record(&outage).unwrap();
        core.repo().unwrap().put_record(&calm).unwrap();
        core.automations_after_sync().unwrap();
        let keys: Vec<String> = jobs_of(&core).into_iter().map(|j| j.key).collect();
        assert_eq!(keys, vec!["automation:auto-crit:event:outage-1"]);
    }

    #[tokio::test]
    async fn manual_runs_count_toward_the_hourly_cap_and_delete_forgets_state() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.request(mutation(&core, Operation::AutomationSave, schedule_json()))
            .await
            .unwrap();
        {
            let mut r = core.repo().unwrap();
            let mut state = load_state(&r, &[]);
            state.runs = vec![now(); HOURLY_CAP];
            state.last_slot.insert("auto-schedule".into(), 5);
            save_state(&mut r, &state).unwrap();
        }
        let err = core
            .request(mutation(
                &core,
                Operation::AutomationRunNow,
                json!({"id":"auto-schedule"}),
            ))
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "Connect already started 30 automation runs this hour."
        );
        core.request(mutation(
            &core,
            Operation::AutomationDelete,
            json!({"id":"auto-schedule"}),
        ))
        .await
        .unwrap();
        let r = core.repo().unwrap();
        assert!(!load_state(&r, &[]).last_slot.contains_key("auto-schedule"));
    }

    #[tokio::test]
    async fn saving_or_turning_on_arms_the_automation() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let armed = |core: &Core| load_state(&core.repo().unwrap(), &[]).armed_at;

        core.request(mutation(&core, Operation::AutomationSave, schedule_json()))
            .await
            .unwrap();
        let at_save = *armed(&core).get("auto-schedule").expect("saving arms it");
        assert!((now() - at_save).abs() <= 5);

        core.request(mutation(
            &core,
            Operation::AutomationToggle,
            json!({"id":"auto-schedule","enabled":false}),
        ))
        .await
        .unwrap();
        assert_eq!(
            *armed(&core).get("auto-schedule").unwrap(),
            at_save,
            "turning off leaves the armed time"
        );

        core.request(mutation(
            &core,
            Operation::AutomationToggle,
            json!({"id":"auto-schedule","enabled":true}),
        ))
        .await
        .unwrap();
        let at_on = *armed(&core).get("auto-schedule").unwrap();
        assert!(at_on >= at_save, "turning on re-arms it");
        assert!((now() - at_on).abs() <= 5);
    }

    /// A meeting record (kind `meeting`) with a saved transcript, folder included.
    fn transcript_meeting(id: &str, end: i64, folder: &std::path::Path) -> Record {
        let at = |t: i64| chrono::DateTime::from_timestamp(t, 0).unwrap().to_rfc3339();
        Record {
            id: id.into(),
            kind: "meeting".into(),
            connection_id: Some("acct".into()),
            workspace_id: None,
            source: "calendar:cal1".into(),
            revision: "v1".into(),
            updated_at: 1,
            data: json!({"eventId": id, "title": "Weekly sync", "start": at(end - 1800),
                "end": at(end), "state": "downloaded", "docs": [],
                "folder": folder.to_string_lossy().to_string()}),
        }
    }

    #[tokio::test]
    async fn formal_summary_waits_for_automatic_notes() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeRunner::new(vec![Ok(RunOutcome {
            structured: Some(
                json!({"notesMarkdown": "# Weekly sync\n\nDiscussed the plan.", "tasks": []}),
            ),
            text: String::new(),
            usage: Usage::default(),
            cost_usd: Some(0.01),
            duration_ms: 500,
            model: Some("claude-sonnet-4-5".into()),
        })]));
        let core = test_core(dir.path(), fake.clone(), ready());
        seed(&core);
        {
            let mut r = core.repo().unwrap();
            let mut s = r.settings().unwrap();
            s.ai.default_profile = Some("claude".into());
            // Not the focus of this test: the fixture's one short segment would otherwise trip
            // "skip very short meetings" (by talk time), independently of the automatic-notes
            // rule this test is about.
            s.meetings.skip_short = false;
            r.settings_update(&s).unwrap();
            // The real meetings round (driven below) also needs transcripts permitted.
            let mut c = r.connection("acct").unwrap();
            c.enabled
                .extend(["meetings".to_string(), "transcripts".to_string()]);
            c.scopes.extend([
                "OnlineMeetings.Read".to_string(),
                "OnlineMeetingTranscript.Read.All".to_string(),
            ]);
            r.save_connection(&c).unwrap();
        }
        // A rule makes this meeting's notes automatic (field "title" is enough to match it).
        core.repo()
            .unwrap()
            .put_record(&Record {
                id: "r-weekly".into(),
                kind: "meeting_rule".into(),
                connection_id: None,
                workspace_id: Some(PERSONAL.into()),
                source: "local".into(),
                revision: "v1".into(),
                updated_at: 1,
                data: json!({"field": "title", "value": "weekly", "template": "meeting-notes",
                    "autoNotes": true, "on": true, "order": 0}),
            })
            .unwrap();
        core.request(mutation(
            &core,
            Operation::AutomationSave,
            json!({"id": "auto-summary", "name": "Formal summary", "enabled": true,
                "trigger": {"kind": "event", "event": "meeting_ready"}, "prompt": "",
                "deliver": {"meetingSummary": "formal-summary"}}),
        ))
        .await
        .unwrap();
        let armed = now();
        let end = armed + 1800;
        let folder = dir.path().join("m1");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("segments.json"),
            r#"[{"voice":"Jeroen","speaker":"remote","name":"Jeroen","address":null,"start":0.0,"end":5.0,"text":"Hello."}]"#,
        )
        .unwrap();
        core.repo()
            .unwrap()
            .put_record(&transcript_meeting("m1", end, &folder))
            .unwrap();

        // Round 1: the real meetings round queues the meeting's own automatic notes (the rule
        // wants them, and the transcript is saved); the summary waits for them, not racing
        // them, whichever of the two gates (`wants_auto` or `busy`) is the one holding it.
        crate::workspace::meetings::meetings_round_at(&core, armed + 3600).unwrap();
        let auto_notes_job = core
            .repo()
            .unwrap()
            .jobs()
            .unwrap()
            .into_iter()
            .find(|j| j.kind == "meeting_notes")
            .expect("the meetings round queued the meeting's own automatic notes");
        assert_eq!(auto_notes_job.key, "meeting_notes:auto:m1");
        core.automations_round_at(armed + 3600, armed).unwrap();
        assert!(
            jobs_of(&core).is_empty(),
            "the summary automation queues nothing while notes are still coming"
        );

        // Running the automatic notes job: the meeting becomes ready with a main document.
        let claimed = core.repo().unwrap().claim(armed + 3600).unwrap().unwrap();
        assert_eq!(claimed.kind, "meeting_notes");
        core.clone().run_claimed_job(claimed).await;
        let m = core
            .repo()
            .unwrap()
            .record("meeting", "m1", Some("acct"), None)
            .unwrap();
        assert_eq!(m.data["state"], "ready");
        assert!(m.data["main"].is_string(), "{}", m.data);

        // Round 2: one automation_run now queues, and running it queues the summary's own
        // notes job with findTasks false (the meeting already has a document). A "Notes
        // ready" notification from the automatic run is also due; drain it first.
        core.automations_round_at(armed + 7200, armed).unwrap();
        let runs = jobs_of(&core);
        assert_eq!(runs.len(), 1, "{runs:?}");
        let claimed = loop {
            let claimed = core
                .repo()
                .unwrap()
                .claim(armed + 7200)
                .unwrap()
                .expect("a due job");
            if claimed.kind == "automation_run" {
                break claimed;
            }
            core.clone().run_claimed_job(claimed).await;
        };
        core.clone().run_claimed_job(claimed).await;
        let summary_notes = core
            .repo()
            .unwrap()
            .jobs()
            .unwrap()
            .into_iter()
            .find(|j| j.key == "meeting_notes:auto:m1:formal-summary")
            .expect("the summary's own notes job was queued");
        assert_eq!(summary_notes.payload["findTasks"], false);
        assert_eq!(summary_notes.payload["auto"], true);
        assert_eq!(
            fake.calls().len(),
            1,
            "Claude ran once, for the notes; never for the automation itself"
        );
    }

    /// Review fix (Important 1): a meeting ready while an earlier run of the same summary
    /// automation is still queued must not be dropped forever. It is refused this round (one
    /// run at a time per automation), but stays eligible for the next one.
    #[tokio::test]
    async fn a_meeting_ready_while_another_run_is_queued_stays_eligible_next_round() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        seed(&core);
        core.request(mutation(
            &core,
            Operation::AutomationSave,
            json!({"id": "auto-summary", "name": "Formal summary", "enabled": true,
                "trigger": {"kind": "event", "event": "meeting_ready"}, "prompt": "",
                "deliver": {"meetingSummary": "formal-summary"}}),
        ))
        .await
        .unwrap();
        let armed = now();
        let end = armed + 1800;
        // `run_summary` never reads the folder; it only needs to exist for other summary tests
        // that actually run the queued `meeting_notes` job.
        let folder = dir.path().join("none");
        core.repo()
            .unwrap()
            .put_record(&transcript_meeting("m1", end, &folder))
            .unwrap();

        // Round 1: m1 is ready and queues a run, left queued (not run yet).
        core.automations_round_at(armed + 3600, armed).unwrap();
        let first = jobs_of(&core);
        assert_eq!(first.len(), 1, "{first:?}");

        // m2 becomes ready while m1's run is still queued ("one run at a time per automation"):
        // refused, but not remembered as fired.
        core.repo()
            .unwrap()
            .put_record(&transcript_meeting("m2", end, &folder))
            .unwrap();
        core.automations_round_at(armed + 3700, armed).unwrap();
        assert_eq!(
            jobs_of(&core).len(),
            1,
            "m2 is held back while m1's run is in progress, not queued"
        );

        // m1's run finishes: "in progress" clears.
        let claimed = core.repo().unwrap().claim(now()).unwrap().unwrap();
        assert_eq!(claimed.kind, "automation_run");
        core.clone().run_claimed_job(claimed).await;

        // The next round queues m2 too: it was never marked as fired while it was refused.
        core.automations_round_at(armed + 7200, armed).unwrap();
        let keys: Vec<String> = jobs_of(&core).into_iter().map(|j| j.key).collect();
        assert_eq!(keys.len(), 2, "{keys:?}");
        assert!(
            keys.contains(&"automation:auto-summary:event:m2".to_string()),
            "{keys:?}"
        );
    }
}
