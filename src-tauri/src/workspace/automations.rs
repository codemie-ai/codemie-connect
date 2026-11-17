//! Automations (DESIGN 6.6): the model, its validation, when a run is due and which new
//! messages or ended meetings start one. Runs themselves arrive with Task 15; here a due
//! run is queued as an `automation_run` job and the executor is a stub.
use super::models::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub const NAME_MAX: usize = 80;
pub const PROMPT_MAX: usize = 4000;
pub const COOLDOWN_SECS: i64 = 600;
pub const HOURLY_CAP: usize = 30;
pub const CATCH_UP_SECS: i64 = 12 * 3600;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub read: ReadSet,
    pub prompt: String,
    pub ai: Route,
    pub cap_usd: Option<f64>,
    pub deliver: Deliver,
    pub catch_up: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    /// ISO weekdays (1 = Monday ... 7 = Sunday) and a local `HH:MM` in the settings time zone.
    Schedule { days: Vec<u8>, time: String },
    Event {
        event: EventKind,
        #[serde(default)]
        senders: Vec<String>,
        #[serde(default)]
        keywords: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    MailFrom,
    ChatFrom,
    Critical,
    MeetingEnded,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReadSet {
    pub calendar_today: bool,
    pub needs_reply: bool,
    pub trigger_conversation: bool,
    pub mail_from_sender_days: u8,
    pub commitments_notes: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Deliver {
    pub today: bool,
    pub notify: bool,
    pub draft_reply: bool,
}

impl Default for Trigger {
    fn default() -> Self {
        Trigger::Schedule {
            days: Vec::new(),
            time: String::new(),
        }
    }
}
impl Default for Automation {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            trigger: Trigger::default(),
            read: ReadSet::default(),
            prompt: String::new(),
            ai: Route::default(),
            cap_usd: None,
            deliver: Deliver::default(),
            catch_up: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skip {
    pub automation_id: String,
    pub source_id: String,
    pub reason: String,
    pub at: i64,
}

/// Persisted as the `automation_state` record.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    /// False until the first sync round has been taken as the baseline.
    pub initialized: bool,
    pub seen_messages: Vec<String>,
    pub last_meeting_check: Option<i64>,
    /// The latest scheduled time each schedule automation has been handled for.
    pub last_slot: BTreeMap<String, i64>,
    pub fired: BTreeMap<String, i64>,
    pub fired_sources: Vec<String>,
    pub runs: Vec<i64>,
    pub skipped: Vec<Skip>,
    /// Automations with a queued or running run; filled from the job queue, never stored.
    #[serde(skip)]
    pub in_progress: BTreeSet<String>,
}

pub struct MessageIn {
    pub id: String,
    pub channel: String,
    pub from_address: String,
    pub from_name: String,
    pub title: String,
    pub text: String,
    pub is_mine: bool,
}
pub struct MeetingIn {
    pub id: String,
    pub title: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Due {
    Now,
    CatchUp,
    No,
}

fn invalid(message: impl Into<String>) -> WorkspaceError {
    WorkspaceError::new("validation", message)
}

impl Automation {
    /// Trims and de-duplicates what the editor sends so matching and validation see clean values.
    pub fn normalize(&mut self) {
        self.name = self.name.trim().to_string();
        self.prompt = self.prompt.trim().to_string();
        if let Trigger::Event {
            senders, keywords, ..
        } = &mut self.trigger
        {
            for list in [senders, keywords] {
                let mut seen = HashSet::new();
                *list = list
                    .iter()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty() && seen.insert(v.to_lowercase()))
                    .collect();
            }
        }
    }
    /// Reply drafts only make sense when a message started the run.
    pub fn replies_to_message(&self) -> bool {
        matches!(
            self.trigger,
            Trigger::Event {
                event: EventKind::MailFrom | EventKind::ChatFrom,
                ..
            }
        )
    }
}

fn valid_time(time: &str) -> bool {
    let b = time.as_bytes();
    b.len() == 5 && b[2] == b':' && chrono::NaiveTime::parse_from_str(time, "%H:%M").is_ok()
}

fn valid_domain(domain: &str) -> bool {
    domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

fn valid_sender(entry: &str, allow_name: bool) -> bool {
    if let Some(domain) = entry.strip_prefix('@') {
        return valid_domain(domain);
    }
    if let Some((local, domain)) = entry.split_once('@') {
        return !local.is_empty() && !local.contains(char::is_whitespace) && valid_domain(domain);
    }
    if valid_domain(entry) {
        return true;
    }
    // A Teams chat message carries a display name rather than an address.
    allow_name && entry.chars().count() <= 100
}

pub fn validate(a: &Automation) -> Result<()> {
    let name = a.name.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX || name.contains('\0') {
        return Err(invalid(format!(
            "Give the automation a name (up to {NAME_MAX} characters)."
        )));
    }
    let prompt = a.prompt.trim();
    if prompt.is_empty() {
        return Err(invalid("Write the instructions for the automation."));
    }
    if prompt.chars().count() > PROMPT_MAX || prompt.contains('\0') {
        return Err(invalid("Instructions can be up to 4,000 characters."));
    }
    match &a.trigger {
        Trigger::Schedule { days, time } => {
            if days.is_empty() {
                return Err(invalid("Choose at least one day for the schedule."));
            }
            if days.iter().any(|d| !(1..=7).contains(d)) {
                return Err(invalid("Days run from Monday (1) to Sunday (7)."));
            }
            if !valid_time(time) {
                return Err(invalid("Enter the time as HH:MM, for example 08:45."));
            }
        }
        Trigger::Event {
            event,
            senders,
            keywords,
        } => {
            let from_people = matches!(event, EventKind::MailFrom | EventKind::ChatFrom);
            if from_people && senders.is_empty() {
                return Err(invalid(
                    "Add at least one sender or domain for this trigger.",
                ));
            }
            if senders.len() > 50 {
                return Err(invalid("Use up to 50 senders."));
            }
            if *event != EventKind::MeetingEnded {
                for s in senders {
                    if !valid_sender(s, *event == EventKind::ChatFrom) {
                        return Err(invalid(format!(
                            "\"{s}\" is not an email address or a domain such as epam.com."
                        )));
                    }
                }
            }
            if keywords.len() > 20 || keywords.iter().any(|k| k.chars().count() > 60) {
                return Err(invalid("Use up to 20 keywords of at most 60 characters."));
            }
        }
    }
    if a.deliver.draft_reply && !a.replies_to_message() {
        return Err(invalid(
            "Reply drafts are only available when the trigger is an email or a chat message.",
        ));
    }
    if a.read.mail_from_sender_days > 30 {
        return Err(invalid(
            "Read the sender's mail from the last 1 to 30 days.",
        ));
    }
    if let Some(cap) = a.cap_usd {
        if !(0.01..=100.0).contains(&cap) {
            return Err(invalid(
                "The cost cap must be between 0.01 and 100 US dollars.",
            ));
        }
    }
    Ok(())
}

/// The next scheduled time after `after` (unix seconds) in the zone; `None` for event
/// automations or an unusable zone or time.
pub fn next_run(a: &Automation, after: i64, zone: &str) -> Option<i64> {
    let Trigger::Schedule { days, time } = &a.trigger else {
        return None;
    };
    super::schedules::next_occurrence_on(zone, time, days, after).ok()
}

/// The latest scheduled time in `(last_run, now]`; several missed times collapse into it.
/// Looks back at most three days.
pub fn latest_slot(a: &Automation, last_run: i64, now: i64, zone: &str) -> Option<i64> {
    let mut cursor = last_run.max(now - 3 * 86400);
    let mut latest = None;
    for _ in 0..16 {
        match next_run(a, cursor, zone) {
            Some(t) if t <= now => {
                latest = Some(t);
                cursor = t;
            }
            _ => break,
        }
    }
    latest
}

/// `last_run` is the latest scheduled time already handled (or when the automation was
/// enabled). A time that came while Connect was open is `Now`; one that came while it was
/// closed is `CatchUp` when allowed and at most 12 hours old. The caller records the slot it
/// acted on, so a second call can never ask for another catch-up.
pub fn due(a: &Automation, last_run: i64, now: i64, zone: &str, app_started_at: i64) -> Due {
    let Some(slot) = latest_slot(a, last_run, now, zone) else {
        return Due::No;
    };
    if slot >= app_started_at {
        Due::Now
    } else if a.catch_up && now - slot <= CATCH_UP_SECS {
        Due::CatchUp
    } else {
        Due::No
    }
}

impl State {
    /// Why a run must not start now, if it must not.
    pub fn refusal(&self, id: &str, event: bool, now: i64) -> Option<&'static str> {
        if self.in_progress.contains(id) {
            Some("An earlier run of this automation is still in progress.")
        } else if event && self.fired.get(id).is_some_and(|t| now - t < COOLDOWN_SECS) {
            Some("This automation already ran in the last 10 minutes.")
        } else if self.runs.iter().filter(|t| now - **t < 3600).count() >= HOURLY_CAP {
            Some("Connect already started 30 automation runs this hour.")
        } else {
            None
        }
    }
    pub fn started(&mut self, id: &str, now: i64) {
        self.runs.retain(|t| now - *t < 3600);
        self.runs.push(now);
        self.fired.insert(id.into(), now);
        self.in_progress.insert(id.into());
    }
    pub fn skip(&mut self, id: &str, source: &str, reason: &str, now: i64) {
        self.skipped.push(Skip {
            automation_id: id.into(),
            source_id: source.into(),
            reason: reason.into(),
            at: now,
        });
        if self.skipped.len() > 100 {
            self.skipped.remove(0);
        }
    }
    fn remember_source(&mut self, key: String) {
        self.fired_sources.push(key);
        if self.fired_sources.len() > 2000 {
            self.fired_sources.drain(..500);
        }
    }
}

fn words(text: &str) -> String {
    let mut out = String::from(" ");
    for w in text
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
    {
        out.push_str(w);
        out.push(' ');
    }
    out
}

/// Case-insensitive whole-word match of any keyword; no keywords matches everything.
fn keywords_match(keywords: &[String], text: &str) -> bool {
    if keywords.is_empty() {
        return true;
    }
    let hay = words(text);
    keywords.iter().any(|k| {
        let k = words(k);
        !k.trim().is_empty() && hay.contains(&k)
    })
}

fn sender_matches(senders: &[String], m: &MessageIn, chat: bool) -> bool {
    let address = m.from_address.trim().to_lowercase();
    let domain = address.rsplit_once('@').map(|(_, d)| d).unwrap_or("");
    senders.iter().any(|entry| {
        let entry = entry.trim().to_lowercase();
        if let Some(d) = entry.strip_prefix('@') {
            domain == d || domain.ends_with(&format!(".{d}"))
        } else if entry.contains('@') {
            address == entry
        } else if entry.contains('.') && !entry.contains(' ') {
            domain == entry || domain.ends_with(&format!(".{entry}"))
        } else {
            chat && !m.from_name.is_empty() && m.from_name.trim().to_lowercase() == entry
        }
    })
}

fn message_matches(
    event: EventKind,
    senders: &[String],
    keywords: &[String],
    m: &MessageIn,
    critical: &HashSet<String>,
) -> bool {
    if m.is_mine {
        return false;
    }
    let kind_ok = match event {
        EventKind::MailFrom => m.channel == "mail" && sender_matches(senders, m, false),
        EventKind::ChatFrom => m.channel == "chat" && sender_matches(senders, m, true),
        EventKind::Critical => {
            critical.contains(&m.id) && (senders.is_empty() || sender_matches(senders, m, true))
        }
        EventKind::MeetingEnded => false,
    };
    kind_ok && keywords_match(keywords, &format!("{} {}", m.title, m.text))
}

/// The (automation id, source id) pairs that start a run for the new messages and ended
/// meetings. Each pair fires once; an automation is held back while a run is in progress, for
/// ten minutes after its last event run, and when 30 runs started within the hour. A held-back
/// match is recorded in `state.skipped` and not queued.
pub fn match_events(
    automations: &[Automation],
    new_messages: &[MessageIn],
    ended_meetings: &[MeetingIn],
    critical_ids: &HashSet<String>,
    state: &mut State,
    now: i64,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for a in automations.iter().filter(|a| a.enabled) {
        let Trigger::Event {
            event,
            senders,
            keywords,
        } = &a.trigger
        else {
            continue;
        };
        let sources: Vec<&str> = if *event == EventKind::MeetingEnded {
            ended_meetings
                .iter()
                .filter(|m| keywords_match(keywords, &m.title))
                .map(|m| m.id.as_str())
                .collect()
        } else {
            new_messages
                .iter()
                .filter(|m| message_matches(*event, senders, keywords, m, critical_ids))
                .map(|m| m.id.as_str())
                .collect()
        };
        for source in sources {
            let key = format!("{}:{source}", a.id);
            if state.fired_sources.contains(&key) {
                continue;
            }
            state.remember_source(key);
            if let Some(reason) = state.refusal(&a.id, true, now) {
                state.skip(&a.id, source, reason, now);
                continue;
            }
            state.started(&a.id, now);
            out.push((a.id.clone(), source.to_string()));
        }
    }
    out
}

impl MessageIn {
    pub fn from_record(r: &Record) -> Self {
        let text = |k: &str| r.data[k].as_str().unwrap_or("").to_string();
        Self {
            id: r.id.clone(),
            channel: text("channel"),
            from_address: text("fromAddress"),
            from_name: text("from"),
            title: text("title"),
            text: text("text"),
            is_mine: r.data["isMine"] == true,
        }
    }
}

/// Calendar events whose end passed in `(last_check, now]`: not all-day, not cancelled and not
/// declined.
pub fn ended_meetings(events: &[Record], last_check: i64, now: i64) -> Vec<MeetingIn> {
    events
        .iter()
        .filter_map(|e| {
            let d = &e.data;
            let declined = d["response"]
                .as_str()
                .is_some_and(|r| r.eq_ignore_ascii_case("declined"));
            if d["allDay"] == true || d["cancelled"] == true || declined {
                return None;
            }
            let end = super::graph::timestamp(d["end"].as_str().unwrap_or(""));
            (end > last_check && end <= now).then(|| MeetingIn {
                id: e.id.clone(),
                title: d["title"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------------------
// Engine glue: persistence, the job queue and the operations. The decisions above are pure.
// ---------------------------------------------------------------------------------------

use super::{
    inbox, new_job, repository::record_selected, repository::source_available,
    repository::source_permitted, repository::Repository, workspace_id_active, Core,
};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};

const PERSONAL: &str = "personal";
const STATE_ID: &str = "state";
const MAX_AUTOMATIONS: usize = 50;
const MAX_SEEN: usize = 5000;
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
    pub(super) fn automations_round(&self) -> Result<()> {
        let now = now();
        let started = *STARTED_AT.get_or_init(|| now);
        self.automations_round_at(now, started)
    }

    fn automations_round_at(&self, now: i64, started: i64) -> Result<()> {
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
                if let Some(reason) = state.refusal(&a.id, false, now) {
                    state.skip(&a.id, &format!("schedule:{slot}"), reason, now);
                    continue;
                }
                enqueue_run(
                    &mut r,
                    a,
                    format!("automation:{}:{slot}", a.id),
                    json!({"kind": kind, "scheduledAt": slot}),
                )?;
                state.started(&a.id, now);
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
                // At most an hour back, so enabling the first such automation never replays old meetings.
                let since = state.last_meeting_check.unwrap_or(now).max(now - 3600);
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
            state.last_meeting_check = Some(now);
        }
        if serde_json::to_value(&state).unwrap_or(Value::Null) != before {
            save_state(&mut r, &state)?;
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
    pub(super) fn automations_after_sync(&self) -> Result<()> {
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
        let known: HashSet<String> = state.seen_messages.iter().cloned().collect();
        let new: Vec<&Record> = messages
            .iter()
            .copied()
            .filter(|m| !known.contains(&m.id))
            .collect();
        let present: HashSet<&str> = messages.iter().map(|m| m.id.as_str()).collect();
        state
            .seen_messages
            .retain(|id| present.contains(id.as_str()));
        state.seen_messages.extend(new.iter().map(|m| m.id.clone()));
        if state.seen_messages.len() > MAX_SEEN {
            let extra = state.seen_messages.len() - MAX_SEEN;
            state.seen_messages.drain(..extra);
        }
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
    pub(super) fn automation_op(&self, req: &Request) -> Result<Value> {
        let mut r = self.repo()?;
        match req.op {
            Operation::AutomationSave => {
                let mut a: Automation =
                    serde_json::from_value(req.data.clone()).map_err(|_| invalid_form())?;
                a.normalize();
                validate(&a)?;
                if a.id.is_empty() {
                    a.id = req.operation_id.clone().unwrap_or_else(id);
                } else if a.id.chars().count() > 200 {
                    return Err(invalid_form());
                }
                let exists = r.record("automation", &a.id, None, Some(PERSONAL)).is_ok();
                if !exists && r.local_records(PERSONAL, "automation")?.len() >= MAX_AUTOMATIONS {
                    return Err(invalid(
                        "You can keep up to 50 automations. Delete one first.",
                    ));
                }
                let record = automation_record(&a)?;
                r.put_record(&record)?;
                Ok(json!({"record": record}))
            }
            Operation::AutomationDelete => {
                let aid = required(&req.data, "id", 200)?;
                r.delete_local("automation", aid, PERSONAL)?;
                for mut job in r.jobs()? {
                    if job.kind == "automation_run"
                        && job.state == "queued"
                        && job.payload["automationId"] == aid
                    {
                        job.state = "cancelled".into();
                        job.result = Some("Automation deleted".into());
                        r.save_job(&job)?;
                    }
                }
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

fn stored(r: &Repository, id: &str) -> Result<Automation> {
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
mod tests {
    use super::*;
    use chrono::DateTime;

    fn ts(v: &str) -> i64 {
        DateTime::parse_from_rfc3339(v).unwrap().timestamp()
    }
    fn schedule(days: &[u8], time: &str) -> Automation {
        Automation {
            id: "a1".into(),
            name: "Morning brief".into(),
            prompt: "Summarise my day.".into(),
            trigger: Trigger::Schedule {
                days: days.to_vec(),
                time: time.into(),
            },
            deliver: Deliver {
                today: true,
                ..Deliver::default()
            },
            catch_up: true,
            ..Automation::default()
        }
    }
    fn event(id: &str, kind: EventKind, senders: &[&str], keywords: &[&str]) -> Automation {
        Automation {
            id: id.into(),
            name: format!("Event {id}"),
            prompt: "Prepare a reply.".into(),
            trigger: Trigger::Event {
                event: kind,
                senders: senders.iter().map(|s| s.to_string()).collect(),
                keywords: keywords.iter().map(|s| s.to_string()).collect(),
            },
            ..Automation::default()
        }
    }
    fn mail(id: &str, from: &str, title: &str, text: &str) -> MessageIn {
        MessageIn {
            id: id.into(),
            channel: "mail".into(),
            from_address: from.into(),
            from_name: String::new(),
            title: title.into(),
            text: text.into(),
            is_mine: false,
        }
    }
    fn message(error: Result<()>) -> String {
        error.unwrap_err().message
    }

    #[test]
    fn validate_rejects_bad_time_empty_days_long_prompt_and_draft_on_schedule() {
        assert!(validate(&schedule(&[1, 2, 3], "08:45")).is_ok());
        assert_eq!(
            message(validate(&schedule(&[1], "25:00"))),
            "Enter the time as HH:MM, for example 08:45."
        );
        assert_eq!(
            message(validate(&schedule(&[1], "8:45"))),
            "Enter the time as HH:MM, for example 08:45."
        );
        assert_eq!(
            message(validate(&schedule(&[], "08:45"))),
            "Choose at least one day for the schedule."
        );
        assert_eq!(
            message(validate(&schedule(&[0, 8], "08:45"))),
            "Days run from Monday (1) to Sunday (7)."
        );
        let mut long = schedule(&[1], "08:45");
        long.prompt = "x".repeat(4001);
        assert_eq!(
            message(validate(&long)),
            "Instructions can be up to 4,000 characters."
        );
        long.prompt = "x".repeat(4000);
        assert!(validate(&long).is_ok());
        let mut draft = schedule(&[1], "08:45");
        draft.deliver.draft_reply = true;
        assert_eq!(
            message(validate(&draft)),
            "Reply drafts are only available when the trigger is an email or a chat message."
        );
        let mut unnamed = schedule(&[1], "08:45");
        unnamed.name = " ".into();
        assert_eq!(
            message(validate(&unnamed)),
            "Give the automation a name (up to 80 characters)."
        );
        // Event rules.
        assert_eq!(
            message(validate(&event("e", EventKind::MailFrom, &[], &[]))),
            "Add at least one sender or domain for this trigger."
        );
        assert_eq!(
            message(validate(&event(
                "e",
                EventKind::MailFrom,
                &["not an address"],
                &[]
            ))),
            "\"not an address\" is not an email address or a domain such as epam.com."
        );
        assert!(validate(&event(
            "e",
            EventKind::MailFrom,
            &["@epam.com", "ann@x.org"],
            &[]
        ))
        .is_ok());
        let mut reply = event("e", EventKind::ChatFrom, &["Ann Lee"], &[]);
        reply.deliver.draft_reply = true;
        assert!(validate(&reply).is_ok());
        let mut capped = event("e", EventKind::Critical, &[], &[]);
        capped.cap_usd = Some(0.0);
        assert_eq!(
            message(validate(&capped)),
            "The cost cap must be between 0.01 and 100 US dollars."
        );
    }

    #[test]
    fn next_run_respects_zone_and_dst() {
        let weekdays = schedule(&[1, 2, 3, 4, 5], "08:45");
        // Friday evening in Berlin (CET): the next run is Monday 08:45 CEST, after the clocks change.
        let friday = ts("2026-03-27T20:00:00Z");
        assert_eq!(
            next_run(&weekdays, friday, "Europe/Berlin"),
            Some(ts("2026-03-30T06:45:00Z"))
        );
        // The same wall time in Kyiv and in UTC is a different instant.
        assert_eq!(
            next_run(&weekdays, friday, "Europe/Kyiv"),
            Some(ts("2026-03-30T05:45:00Z"))
        );
        assert_eq!(
            next_run(&weekdays, friday, "UTC"),
            Some(ts("2026-03-30T08:45:00Z"))
        );
        // Before the clocks change the offset is +1.
        assert_eq!(
            next_run(&weekdays, ts("2026-03-26T12:00:00Z"), "Europe/Berlin"),
            Some(ts("2026-03-27T07:45:00Z"))
        );
        // A single chosen day.
        let sunday = schedule(&[7], "16:00");
        assert_eq!(
            next_run(&sunday, ts("2026-03-26T12:00:00Z"), "UTC"),
            Some(ts("2026-03-29T16:00:00Z"))
        );
        // An event automation never has a next run; a bad zone has none either.
        assert_eq!(
            next_run(&event("e", EventKind::Critical, &[], &[]), 0, "UTC"),
            None
        );
        assert_eq!(next_run(&weekdays, friday, "Nowhere/Land"), None);
    }

    #[test]
    fn catch_up_runs_once_within_12h_and_never_twice() {
        let a = schedule(&[1, 2, 3, 4, 5], "08:45");
        let slot = ts("2026-03-24T08:45:00Z"); // Tuesday
        let yesterday = ts("2026-03-23T08:45:00Z");
        // Connect was closed at 08:45 and opened at 10:00: one catch-up.
        let started = ts("2026-03-24T10:00:00Z");
        let now = ts("2026-03-24T10:01:00Z");
        assert_eq!(due(&a, yesterday, now, "UTC", started), Due::CatchUp);
        assert_eq!(latest_slot(&a, yesterday, now, "UTC"), Some(slot));
        // The slot was handled: no second catch-up, now or later in the same launch.
        assert_eq!(due(&a, slot, now, "UTC", started), Due::No);
        assert_eq!(
            due(&a, slot, ts("2026-03-24T20:00:00Z"), "UTC", started),
            Due::No
        );
        // Several missed days collapse to the latest slot, once.
        let long_closed = ts("2026-03-20T08:45:00Z");
        assert_eq!(due(&a, long_closed, now, "UTC", started), Due::CatchUp);
        assert_eq!(latest_slot(&a, long_closed, now, "UTC"), Some(slot));
        // More than 12 hours late: skipped.
        let evening = ts("2026-03-24T22:00:00Z");
        assert_eq!(due(&a, yesterday, evening, "UTC", evening), Due::No);
        // Catch up switched off: skipped.
        let mut off = a.clone();
        off.catch_up = false;
        assert_eq!(due(&off, yesterday, now, "UTC", started), Due::No);
        // Connect was open when the time came: a normal run, even with catch up off.
        let open = ts("2026-03-24T07:00:00Z");
        assert_eq!(
            due(&off, yesterday, ts("2026-03-24T08:45:30Z"), "UTC", open),
            Due::Now
        );
        // Not due yet.
        assert_eq!(
            due(&a, yesterday, ts("2026-03-24T08:00:00Z"), "UTC", open),
            Due::No
        );
    }

    #[test]
    fn event_match_by_sender_domain_and_keyword() {
        let automations = vec![
            event("by-domain", EventKind::MailFrom, &["epam.com"], &[]),
            event(
                "by-at-domain",
                EventKind::MailFrom,
                &["@EPAM.com"],
                &["invoice"],
            ),
            event("by-address", EventKind::MailFrom, &["Ann@Example.org"], &[]),
            event(
                "chat",
                EventKind::ChatFrom,
                &["ann.lee@epam.com", "Bob Stone"],
                &[],
            ),
        ];
        let mut state = State::default();
        let mut mine = mail("m-own", "me@epam.com", "Invoice", "");
        mine.is_mine = true;
        let mut chat = mail("c1", "", "", "hello");
        chat.channel = "chat".into();
        chat.from_name = "bob stone".into();
        let messages = vec![
            mail(
                "m1",
                "Pat@Mail.EPAM.com",
                "Hello",
                "Please see the attached invoice-2026 today.",
            ),
            mail("m2", "ann@example.org", "Hi", "no keyword"),
            mail(
                "m3",
                "carol@epam.com",
                "Invoices",
                "plural is not the whole word",
            ),
            mail("m4", "dan@other.com", "Invoice", "from nobody we know"),
            mine,
            chat,
        ];
        let got = match_events(
            &automations,
            &messages,
            &[],
            &HashSet::new(),
            &mut state,
            1_000,
        );
        // by-domain also matches carol's and pat's mail, but its 10 minute cooldown keeps the second.
        assert!(got.contains(&("by-domain".into(), "m1".into())));
        assert!(got.contains(&("by-at-domain".into(), "m1".into())));
        assert!(got.contains(&("by-address".into(), "m2".into())));
        assert!(got.contains(&("chat".into(), "c1".into())));
        assert!(!got.iter().any(|(a, s)| a == "by-at-domain" && s != "m1"));
        assert!(!got.iter().any(|(_, s)| s == "m-own" || s == "m4"));
        // A chat automation never fires on mail, a mail automation never on chat.
        assert!(!got.iter().any(|(a, s)| a == "chat" && s != "c1"));
        assert!(!got.iter().any(|(a, s)| a != "chat" && s == "c1"));
    }

    #[test]
    fn critical_and_meeting_ended_triggers_fire_once() {
        let automations = vec![
            event("crit", EventKind::Critical, &[], &[]),
            event("meet", EventKind::MeetingEnded, &[], &[]),
        ];
        let mut state = State::default();
        let messages = vec![
            mail("m1", "boss@epam.com", "Outage", "prod is down"),
            mail("m2", "x@epam.com", "FYI", "nothing urgent"),
        ];
        let critical: HashSet<String> = ["m1".to_string()].into();
        let meetings = vec![MeetingIn {
            id: "ev1".into(),
            title: "Standup".into(),
        }];
        let first = match_events(
            &automations,
            &messages,
            &meetings,
            &critical,
            &mut state,
            1_000,
        );
        assert_eq!(
            first,
            vec![
                ("crit".to_string(), "m1".to_string()),
                ("meet".to_string(), "ev1".to_string())
            ]
        );
        // The same inputs again, well after the cooldown, start nothing.
        let again = match_events(
            &automations,
            &messages,
            &meetings,
            &critical,
            &mut state,
            5_000,
        );
        assert!(again.is_empty());
    }

    #[test]
    fn cooldown_and_hourly_cap_are_enforced() {
        let a = vec![event("e", EventKind::MailFrom, &["epam.com"], &[])];
        let mut state = State::default();
        let first = match_events(
            &a,
            &[mail("m1", "a@epam.com", "", "")],
            &[],
            &HashSet::new(),
            &mut state,
            1_000,
        );
        assert_eq!(first.len(), 1);
        state.in_progress.clear();
        // Within 10 minutes: skipped with a recorded reason.
        let second = match_events(
            &a,
            &[mail("m2", "a@epam.com", "", "")],
            &[],
            &HashSet::new(),
            &mut state,
            1_000 + 599,
        );
        assert!(second.is_empty());
        assert_eq!(
            state.skipped.last().unwrap().reason,
            "This automation already ran in the last 10 minutes."
        );
        assert_eq!(state.skipped.last().unwrap().source_id, "m2");
        // After the cooldown it runs again.
        let third = match_events(
            &a,
            &[mail("m3", "a@epam.com", "", "")],
            &[],
            &HashSet::new(),
            &mut state,
            1_000 + 600,
        );
        assert_eq!(third, vec![("e".to_string(), "m3".to_string())]);

        // 30 runs an hour over many automations; the 31st waits for the hour to pass.
        let many: Vec<Automation> = (0..40)
            .map(|i| event(&format!("x{i}"), EventKind::MailFrom, &["cap.com"], &[]))
            .collect();
        let mut state = State::default();
        let msg = [mail("c1", "a@cap.com", "", "")];
        let got = match_events(&many, &msg, &[], &HashSet::new(), &mut state, 10_000);
        assert_eq!(got.len(), HOURLY_CAP);
        assert!(state
            .skipped
            .iter()
            .any(|s| s.reason == "Connect already started 30 automation runs this hour."));
        state.in_progress.clear();
        let later = match_events(
            &many,
            &[mail("c2", "a@cap.com", "", "")],
            &[],
            &HashSet::new(),
            &mut state,
            10_000 + 3_601,
        );
        assert_eq!(later.len(), HOURLY_CAP);
    }

    #[test]
    fn no_overlap_while_run_in_progress() {
        let a = vec![event("e", EventKind::MailFrom, &["epam.com"], &[])];
        let mut state = State::default();
        state.in_progress.insert("e".into());
        let got = match_events(
            &a,
            &[mail("m1", "a@epam.com", "", "")],
            &[],
            &HashSet::new(),
            &mut state,
            1_000,
        );
        assert!(got.is_empty());
        assert_eq!(
            state.skipped.last().unwrap().reason,
            "An earlier run of this automation is still in progress."
        );
        // Once it finishes the next message runs; the skipped one is not queued behind it.
        state.in_progress.clear();
        let next = match_events(
            &a,
            &[mail("m2", "a@epam.com", "", "")],
            &[],
            &HashSet::new(),
            &mut state,
            5_000,
        );
        assert_eq!(next, vec![("e".to_string(), "m2".to_string())]);
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
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
            "prompt":"Summarise my day and what needs a reply.",
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
    async fn contract_fixtures() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let mut files = Vec::new();
        for (file, data) in [
            ("automation-schedule.json", schedule_json()),
            ("automation-event.json", event_json()),
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
        // One file holds both, as the brief asks: a saved schedule and a saved event automation.
        let value = json!({"schedule": files[0].1, "event": files[1].1});
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
}
