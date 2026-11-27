//! Automations (DESIGN 6.6): the model, its validation, when a run is due and which new
//! messages or ended meetings start one. A due run is queued as an `automation_run` job.
use crate::workspace::meetings::model::{MeetingRecord, MeetingState};
use crate::workspace::meetings::templates::Template;
use crate::workspace::models::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub const NAME_MAX: usize = 80;
pub const PROMPT_MAX: usize = 4000;
pub const COOLDOWN_SECS: i64 = 600;
pub const HOURLY_CAP: usize = 30;
/// Why a meeting-summary automation has no Run now: it needs a meeting to run for.
pub const SUMMARY_RUN_NOW: &str =
    "Run now isn't available for a meeting summary. It runs when a meeting's notes are ready.";
pub const CATCH_UP_SECS: i64 = 12 * 3600;
/// A scheduled time this recent, while Connect was open, is an ordinary run; later is missed.
pub const ON_TIME_SECS: i64 = 15 * 60;
/// A Formal-summary-style automation still considers a meeting that ended this recently (DESIGN
/// step 5 §6), the same window automatic notes use.
pub const AUTO_WINDOW: i64 = 2 * 24 * 3600;
/// "Skip short meetings": under three minutes long, the same threshold automatic notes use.
pub const SHORT: f64 = 180.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub read: ReadSet,
    pub prompt: String,
    pub ai: Pin,
    pub cap_usd: Option<f64>,
    pub deliver: Deliver,
    pub catch_up: bool,
    /// The gallery template this automation was made from ("morning-brief", …), set by Use
    /// template and kept through edits (DESIGN §3 "Automations"). `None` for an automation
    /// built from scratch, or saved before this step (DESIGN ruling 12): it keeps the
    /// Automations row.
    pub template: Option<String>,
}

/// The editor's own Claude choice for an automation (DESIGN §3 "Automations"): only a profile
/// and a model, kept on save. Its fallback is always its row's; a pin never sets its own.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Pin {
    pub profile: Option<String>,
    pub model: Option<String>,
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
    /// A meeting's transcript is ready; starts the Formal summary run (DESIGN step 5 §6).
    MeetingReady,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReadSet {
    pub calendar_today: bool,
    pub needs_reply: bool,
    pub trigger_conversation: bool,
    pub mail_from_sender_days: u8,
    pub commitments_notes: bool,
    /// "Messages since the last run" (DESIGN step 5 §3).
    pub recent_messages: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Deliver {
    pub today: bool,
    pub notify: bool,
    pub draft_reply: bool,
    /// Create tasks in the active provider (DESIGN step 5 §2).
    pub create_tasks: bool,
    /// A note template id: this automation makes that template's document for a meeting
    /// (DESIGN step 5 §6). Only meaningful with the `meeting_ready` event.
    pub meeting_summary: Option<String>,
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
            ai: Pin::default(),
            cap_usd: None,
            deliver: Deliver::default(),
            catch_up: false,
            template: None,
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
    /// The account whose cache `seen_messages` describes; another account starts a new baseline.
    pub connection_id: Option<String>,
    pub seen_messages: Vec<String>,
    pub last_meeting_check: Option<i64>,
    /// The latest scheduled time each schedule automation has been handled for.
    pub last_slot: BTreeMap<String, i64>,
    /// When each automation was last saved or turned on; a `meeting_ready` match only counts a
    /// meeting that ended after this (DESIGN step 5 §6).
    pub armed_at: BTreeMap<String, i64>,
    /// The last event-run time, keyed `"<automation id>|<sender key>"` (`sender_key`, or the
    /// meeting id for `meeting_ended`); the cooldown is per automation and sender.
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
    /// The Teams chat id (`chatId`); empty for mail.
    pub chat_id: String,
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

pub(super) fn invalid(message: impl Into<String>) -> WorkspaceError {
    WorkspaceError::new("validation", message)
}
/// A validation sentence about one field of the editor (`name`, `days`, `senders`, ...).
pub(super) fn invalid_at(field: &str, message: impl Into<String>) -> WorkspaceError {
    let mut e = invalid(message);
    e.field = Some(field.into());
    e
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
    /// Create tasks needs something to make tasks from: a read of messages, or a message that
    /// started the run (DESIGN step 5 §1).
    pub fn makes_tasks_from_messages(&self) -> bool {
        if self.read.needs_reply || self.read.recent_messages {
            return true;
        }
        self.read.trigger_conversation
            && matches!(
                self.trigger,
                Trigger::Event {
                    event: EventKind::MailFrom | EventKind::ChatFrom | EventKind::Critical,
                    ..
                }
            )
    }
    /// A Formal-summary-style automation: it queues a note template for a meeting instead of
    /// reading anything or running Claude itself (DESIGN step 5 §6).
    pub fn is_summary(&self) -> bool {
        self.deliver.meeting_summary.is_some()
    }
}

/// The row this automation runs on, `RouteKey::Purpose` of this (DESIGN §3 "Automations", spec
/// Values): the template it was made from names its row; anything else, including none, is the
/// Automations row (an automation saved before this step has no `template` and keeps that row,
/// DESIGN ruling 12).
pub fn purpose_of(a: &Automation) -> Purpose {
    match a.template.as_deref() {
        Some("morning-brief") => Purpose::Briefing,
        Some("inbox-triage") => Purpose::Triage,
        Some("commitments") => Purpose::Commitments,
        _ => Purpose::Automation,
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

pub fn validate(a: &Automation, templates: &[Template]) -> Result<()> {
    let name = a.name.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX || name.contains('\0') {
        return Err(invalid_at(
            "name",
            format!("Give the automation a name (up to {NAME_MAX} characters)."),
        ));
    }
    let prompt = a.prompt.trim();
    let is_meeting_ready = matches!(
        a.trigger,
        Trigger::Event {
            event: EventKind::MeetingReady,
            ..
        }
    );
    // A summary automation's prompt becomes the run's wishes and may be empty; a `meeting_ready`
    // one with no template yet is asked for the template first.
    if prompt.is_empty() && !a.is_summary() && !is_meeting_ready {
        return Err(invalid_at(
            "prompt",
            "Write the instructions for the automation.",
        ));
    }
    if prompt.chars().count() > PROMPT_MAX || prompt.contains('\0') {
        return Err(invalid_at(
            "prompt",
            "Instructions can be up to 4,000 characters.",
        ));
    }
    match &a.trigger {
        Trigger::Schedule { days, time } => {
            if days.is_empty() {
                return Err(invalid_at(
                    "days",
                    "Choose at least one day for the schedule.",
                ));
            }
            if days.iter().any(|d| !(1..=7).contains(d)) {
                return Err(invalid_at(
                    "days",
                    "Days run from Monday (1) to Sunday (7).",
                ));
            }
            if !valid_time(time) {
                return Err(invalid_at(
                    "time",
                    "Enter the time as HH:MM, for example 08:45.",
                ));
            }
        }
        Trigger::Event {
            event,
            senders,
            keywords,
        } => {
            let from_people = matches!(event, EventKind::MailFrom | EventKind::ChatFrom);
            if from_people && senders.is_empty() {
                return Err(invalid_at(
                    "senders",
                    "Add at least one sender or domain for this trigger.",
                ));
            }
            if senders.len() > 50 {
                return Err(invalid_at("senders", "Use up to 50 senders."));
            }
            for s in senders {
                match event {
                    // Teams records carry the sender's display name and no address, so only a
                    // name can ever match a Teams message.
                    EventKind::ChatFrom if s.contains('@') || valid_domain(s) => {
                        return Err(invalid_at(
                            "senders",
                            "Teams messages carry names, not addresses. Enter the name as Teams shows it, for example Ann Lee.",
                        ));
                    }
                    EventKind::ChatFrom if s.chars().count() > 100 => {
                        return Err(invalid_at(
                            "senders",
                            format!("\"{s}\" is longer than a name as Teams shows it."),
                        ));
                    }
                    EventKind::MailFrom if !valid_sender(s, false) => {
                        return Err(invalid_at(
                            "senders",
                            format!(
                                "\"{s}\" is not an email address or a domain such as epam.com."
                            ),
                        ));
                    }
                    EventKind::Critical if !valid_sender(s, true) => {
                        return Err(invalid_at(
                            "senders",
                            format!(
                                "\"{s}\" is not an email address, a domain such as epam.com or a name as Teams shows it."
                            ),
                        ));
                    }
                    _ => {}
                }
            }
            if keywords.len() > 20 || keywords.iter().any(|k| k.chars().count() > 60) {
                return Err(invalid_at(
                    "keywords",
                    "Use up to 20 keywords of at most 60 characters.",
                ));
            }
        }
    }
    if a.deliver.meeting_summary.is_some() && !is_meeting_ready {
        return Err(invalid_at(
            "deliver",
            "A meeting summary starts when a meeting's transcript is ready.",
        ));
    }
    if is_meeting_ready {
        let Some(template_id) = a.deliver.meeting_summary.as_deref() else {
            return Err(invalid_at("deliver", "Choose the template to make."));
        };
        if !templates.iter().any(|t| t.id == template_id) {
            return Err(invalid_at("deliver", "Choose a note template."));
        }
        if a.read != ReadSet::default() || a.deliver.create_tasks {
            return Err(invalid_at(
                "deliver",
                "A meeting summary automation reads nothing and makes no tasks.",
            ));
        }
    }
    if a.deliver.draft_reply && !a.replies_to_message() {
        return Err(invalid_at(
            "deliver",
            "Reply drafts are only available when the trigger is an email or a chat message.",
        ));
    }
    if a.deliver.create_tasks && !a.makes_tasks_from_messages() {
        return Err(invalid_at(
            "deliver",
            "Tasks are made from messages. Tick Needs your reply or Messages since the last run, or start it from a message.",
        ));
    }
    if a.read.mail_from_sender_days > 30 {
        return Err(invalid_at(
            "read",
            "Read the sender's mail from the last 1 to 30 days.",
        ));
    }
    if let Some(cap) = a.cap_usd {
        if !(0.01..=100.0).contains(&cap) {
            return Err(invalid_at(
                "capUsd",
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
    crate::workspace::schedules::next_occurrence_on(zone, time, days, after).ok()
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
/// closed (or the computer slept through it) is `CatchUp` when allowed and at most 12 hours old. The caller records the slot it
/// acted on, so a second call can never ask for another catch-up.
pub fn due(a: &Automation, last_run: i64, now: i64, zone: &str, app_started_at: i64) -> Due {
    let Some(slot) = latest_slot(a, last_run, now, zone) else {
        return Due::No;
    };
    if slot >= app_started_at && now - slot <= ON_TIME_SECS {
        Due::Now
    } else if a.catch_up && now - slot <= CATCH_UP_SECS {
        Due::CatchUp
    } else {
        Due::No
    }
}

impl State {
    /// Takes `connection_id` as the account the cache belongs to. A different account's cache
    /// is all new to Connect, so it becomes the baseline again instead of a backlog of runs.
    pub fn follow_account(&mut self, connection_id: &str) {
        if self.connection_id.as_deref() != Some(connection_id) {
            self.initialized = false;
            self.seen_messages.clear();
            self.connection_id = Some(connection_id.into());
        }
    }
    /// Why a run must not start now, if it must not. `sender` is the event's cooldown key
    /// (`sender_key`, or the meeting id for `meeting_ended`); `None` for a schedule, a manual
    /// run or `meeting_ready`, which have no cooldown.
    pub fn refusal(&self, id: &str, sender: Option<&str>, now: i64) -> Option<&'static str> {
        if self.in_progress.contains(id) {
            return Some("An earlier run of this automation is still in progress.");
        }
        self.limit(id, sender, now)
    }
    /// `refusal` without the run in progress: a message or meeting event is seen only once, so
    /// it queues behind an earlier run instead (runs are claimed one at a time, so it still
    /// never overlaps); only the sender's cooldown and the hourly cap hold it back.
    pub fn limit(&self, id: &str, sender: Option<&str>, now: i64) -> Option<&'static str> {
        if let Some(sender) = sender {
            if self
                .fired
                .get(&format!("{id}|{sender}"))
                .is_some_and(|t| now - t < COOLDOWN_SECS)
            {
                return Some("This automation already ran in the last 10 minutes.");
            }
        }
        if self.runs.iter().filter(|t| now - **t < 3600).count() >= HOURLY_CAP {
            return Some("Connect already started 30 automation runs this hour.");
        }
        None
    }
    /// `sender` is recorded for the cooldown only when given (see `refusal`). Several sources
    /// for the same automation (different senders) may each start a run, in the same round or
    /// while an earlier run is still queued; the runs queue behind each other, since background
    /// runs are claimed one at a time (`claim_ready`).
    pub fn started(&mut self, id: &str, sender: Option<&str>, now: i64) {
        self.runs.retain(|t| now - *t < 3600);
        self.runs.push(now);
        // An expired cooldown (legacy bare-id keys too) holds nothing back any more.
        self.fired.retain(|_, t| now - *t < COOLDOWN_SECS);
        if let Some(sender) = sender {
            self.fired.insert(format!("{id}|{sender}"), now);
        }
    }
    /// Drops everything remembered about a deleted automation.
    pub fn forget(&mut self, id: &str) {
        self.last_slot.remove(id);
        self.armed_at.remove(id);
        self.in_progress.remove(id);
        let fired_prefix = format!("{id}|");
        self.fired.retain(|k, _| !k.starts_with(&fired_prefix));
        let prefix = format!("{id}:");
        self.fired_sources.retain(|k| !k.starts_with(&prefix));
        self.skipped.retain(|s| s.automation_id != id);
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
    pub(super) fn remember_source(&mut self, key: String) {
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
pub(super) fn keywords_match(keywords: &[String], text: &str) -> bool {
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
        // A name in "Only from" matches Teams items by display name; mail is matched by address.
        EventKind::Critical => {
            critical.contains(&m.id)
                && (senders.is_empty() || sender_matches(senders, m, m.channel == "chat"))
        }
        EventKind::MeetingEnded => false,
        // `meeting_ready` is matched by the automations round from meeting records, not here
        // (DESIGN step 5 §6).
        EventKind::MeetingReady => false,
    };
    kind_ok && keywords_match(keywords, &format!("{} {}", m.title, m.text))
}

/// The (automation id, source id) pairs that start a run for the new messages and ended
/// meetings. Each pair fires once; a run in progress does not hold it back (it is queued behind
/// it), but ten minutes after its last event run for that sender (the mail address, the Teams
/// chat id, or the meeting for `meeting_ended`) and 30 runs started within the hour do. A
/// held-back match is recorded in `state.skipped` and not queued.
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
        // The cooldown's sender key: the meeting id for `meeting_ended`, else the message's.
        let sources: Vec<(&str, String)> = if *event == EventKind::MeetingEnded {
            ended_meetings
                .iter()
                .filter(|m| keywords_match(keywords, &m.title))
                .map(|m| (m.id.as_str(), m.id.clone()))
                .collect()
        } else {
            new_messages
                .iter()
                .filter(|m| message_matches(*event, senders, keywords, m, critical_ids))
                .map(|m| (m.id.as_str(), sender_key(m)))
                .collect()
        };
        for (source, sender) in sources {
            let key = format!("{}:{source}", a.id);
            if state.fired_sources.contains(&key) {
                continue;
            }
            state.remember_source(key);
            if let Some(reason) = state.limit(&a.id, Some(&sender), now) {
                state.skip(&a.id, source, reason, now);
                continue;
            }
            state.started(&a.id, Some(&sender), now);
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
            chat_id: text("chatId"),
            title: text("title"),
            text: text("text"),
            is_mine: r.data["isMine"] == true,
        }
    }
}

/// The event cooldown's per-sender key: the Teams chat id for a chat message, else the
/// lower-case mail address.
pub fn sender_key(m: &MessageIn) -> String {
    if m.channel == "chat" {
        format!("chat:{}", m.chat_id)
    } else {
        m.from_address.trim().to_lowercase()
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
            let end = crate::workspace::graph::timestamp(d["end"].as_str().unwrap_or(""));
            (end > last_check && end <= now).then(|| MeetingIn {
                id: e.id.clone(),
                title: d["title"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// Meetings a Formal-summary-style automation should run for now (DESIGN step 5 §6): the
/// transcript is saved (`Downloaded` or `Ready`), the meeting ended within [`AUTO_WINDOW`] and
/// after `armed_at`, it is not short when `skip_short` is on (under [`SHORT`] seconds of
/// start-to-end), it is not waiting for its own automatic notes (`wants_auto` and no document
/// yet), and no `meeting_notes` job for it is queued or running (`busy`, keyed by meeting id).
pub fn ready_meetings(
    meetings: &[MeetingRecord],
    wants_auto: impl Fn(&MeetingRecord) -> bool,
    busy: &HashSet<String>,
    armed_at: i64,
    now: i64,
    skip_short: bool,
) -> Vec<MeetingIn> {
    meetings
        .iter()
        .filter(|m| matches!(m.state, MeetingState::Downloaded | MeetingState::Ready))
        .filter(|m| {
            let end = crate::workspace::graph::timestamp(&m.end);
            end > armed_at && now - end < AUTO_WINDOW
        })
        .filter(|m| {
            if !skip_short {
                return true;
            }
            let start = crate::workspace::graph::timestamp(&m.start);
            let end = crate::workspace::graph::timestamp(&m.end);
            (end - start) as f64 >= SHORT
        })
        .filter(|m| !(wants_auto(m) && m.docs.is_empty()))
        .filter(|m| !busy.contains(&m.event_id))
        .map(|m| MeetingIn {
            id: m.event_id.clone(),
            title: m.title.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;
    use serde_json::json;

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
            chat_id: String::new(),
            title: title.into(),
            text: text.into(),
            is_mine: false,
        }
    }
    fn message(error: Result<()>) -> String {
        error.unwrap_err().message
    }
    /// `validate` with no note templates, for cases that don't touch `meetingSummary`.
    fn validate0(a: &Automation) -> Result<()> {
        validate(a, &[])
    }

    #[test]
    fn validate_rejects_bad_time_empty_days_long_prompt_and_draft_on_schedule() {
        assert!(validate0(&schedule(&[1, 2, 3], "08:45")).is_ok());
        assert_eq!(
            message(validate0(&schedule(&[1], "25:00"))),
            "Enter the time as HH:MM, for example 08:45."
        );
        assert_eq!(
            message(validate0(&schedule(&[1], "8:45"))),
            "Enter the time as HH:MM, for example 08:45."
        );
        assert_eq!(
            message(validate0(&schedule(&[], "08:45"))),
            "Choose at least one day for the schedule."
        );
        assert_eq!(
            message(validate0(&schedule(&[0, 8], "08:45"))),
            "Days run from Monday (1) to Sunday (7)."
        );
        let mut long = schedule(&[1], "08:45");
        long.prompt = "x".repeat(4001);
        assert_eq!(
            message(validate0(&long)),
            "Instructions can be up to 4,000 characters."
        );
        long.prompt = "x".repeat(4000);
        assert!(validate0(&long).is_ok());
        let mut draft = schedule(&[1], "08:45");
        draft.deliver.draft_reply = true;
        assert_eq!(
            message(validate0(&draft)),
            "Reply drafts are only available when the trigger is an email or a chat message."
        );
        let mut unnamed = schedule(&[1], "08:45");
        unnamed.name = " ".into();
        assert_eq!(
            message(validate0(&unnamed)),
            "Give the automation a name (up to 80 characters)."
        );
        // Event rules.
        assert_eq!(
            message(validate0(&event("e", EventKind::MailFrom, &[], &[]))),
            "Add at least one sender or domain for this trigger."
        );
        assert_eq!(
            message(validate0(&event(
                "e",
                EventKind::MailFrom,
                &["not an address"],
                &[]
            ))),
            "\"not an address\" is not an email address or a domain such as epam.com."
        );
        assert!(validate0(&event(
            "e",
            EventKind::MailFrom,
            &["@epam.com", "ann@x.org"],
            &[]
        ))
        .is_ok());
        let mut reply = event("e", EventKind::ChatFrom, &["Ann Lee"], &[]);
        reply.deliver.draft_reply = true;
        assert!(validate0(&reply).is_ok());
        let mut capped = event("e", EventKind::Critical, &[], &[]);
        capped.cap_usd = Some(0.0);
        assert_eq!(
            message(validate0(&capped)),
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
        // by-domain matches both carol's and pat's mail: the cooldown is per sender, and they differ.
        assert!(got.contains(&("by-domain".into(), "m1".into())));
        assert!(got.contains(&("by-domain".into(), "m3".into())));
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
    fn teams_sender_rules_take_names_because_teams_messages_carry_no_address() {
        let teams_only =
            "Teams messages carry names, not addresses. Enter the name as Teams shows it, for example Ann Lee.";
        for entry in ["ann@epam.com", "@epam.com", "epam.com"] {
            assert_eq!(
                message(validate0(&event("e", EventKind::ChatFrom, &[entry], &[]))),
                teams_only,
                "{entry}"
            );
        }
        assert!(validate0(&event("e", EventKind::ChatFrom, &["Ann Lee"], &[])).is_ok());
        // "Only from" on the critical trigger takes addresses, domains and Teams names.
        assert!(validate0(&event(
            "e",
            EventKind::Critical,
            &["Ann Lee", "ann@epam.com", "@epam.com"],
            &[]
        ))
        .is_ok());
        assert_eq!(
            message(validate0(&event(
                "e",
                EventKind::Critical,
                &[&"x".repeat(101)],
                &[]
            ))),
            format!(
                "\"{}\" is not an email address, a domain such as epam.com or a name as Teams shows it.",
                "x".repeat(101)
            )
        );

        // A Teams record has a display name and no address (graph.rs stores `from` and `fromId`).
        let teams = MessageIn::from_record(&Record {
            id: "c1".into(),
            kind: "message".into(),
            connection_id: None,
            workspace_id: None,
            source: "graph".into(),
            revision: "1".into(),
            updated_at: 0,
            data: serde_json::json!({ "channel": "chat", "from": "Ann Lee", "fromId": "u-1", "text": "prod is down" }),
        });
        assert_eq!(teams.from_address, "");
        // Anyone can put "Ann Lee" on an email, so a name never matches mail.
        let mut boss_mail = mail("m1", "boss@epam.com", "Outage", "prod is down");
        boss_mail.from_name = "Ann Lee".into();
        let automations = vec![
            event("chat", EventKind::ChatFrom, &["ann lee"], &[]),
            event("crit-name", EventKind::Critical, &["Ann Lee"], &[]),
            event("crit-address", EventKind::Critical, &["boss@epam.com"], &[]),
        ];
        let critical: HashSet<String> = ["c1".to_string(), "m1".to_string()].into();
        let mut state = State::default();
        let got = match_events(
            &automations,
            &[teams, boss_mail],
            &[],
            &critical,
            &mut state,
            1_000,
        );
        assert!(got.contains(&("chat".into(), "c1".into())));
        assert!(got.contains(&("crit-name".into(), "c1".into())));
        assert!(got.contains(&("crit-address".into(), "m1".into())));
        // A name matches Teams items only; an address never matches a Teams item.
        assert!(!got.contains(&("crit-name".into(), "m1".into())));
        assert!(!got.contains(&("crit-address".into(), "c1".into())));
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
    fn a_meeting_ready_automation_with_no_template_asks_for_one_before_instructions() {
        let mut no_template = event("e", EventKind::MeetingReady, &[], &[]);
        no_template.prompt = String::new();
        let err = validate(&no_template, &[template("formal-summary")]).unwrap_err();
        assert_eq!(err.message, "Choose the template to make.");
        assert_eq!(err.field.as_deref(), Some("deliver"));
    }

    #[test]
    fn the_sender_key_is_the_chat_or_the_address_in_any_case() {
        let mut chat = mail("m1", "", "", "");
        chat.channel = "chat".into();
        chat.chat_id = "19:abc@thread.v2".into();
        chat.from_name = "Ann Lee".into();
        assert_eq!(sender_key(&chat), "chat:19:abc@thread.v2");
        assert_eq!(
            sender_key(&mail("m2", " Ann.Lee@EPAM.com ", "", "")),
            "ann.lee@epam.com"
        );
    }

    #[test]
    fn forget_drops_when_the_automation_was_armed() {
        let mut state = State::default();
        state.armed_at.insert("e".into(), 1_000);
        state.armed_at.insert("other".into(), 1_000);
        state.forget("e");
        assert_eq!(state.armed_at.keys().collect::<Vec<_>>(), ["other"]);
    }

    #[test]
    fn cooldown_entries_are_dropped_once_they_expire() {
        let mut state = State::default();
        state.fired.insert("e|old@epam.com".into(), 1_000);
        state.fired.insert("e".into(), 1_000); // a legacy bare-id key
        state.fired.insert("e|recent@epam.com".into(), 9_700);
        state.started("e", Some("new@epam.com"), 10_000);
        let keys: Vec<&str> = state.fired.keys().map(String::as_str).collect();
        assert_eq!(keys, ["e|new@epam.com", "e|recent@epam.com"]);
    }

    #[test]
    fn a_second_sender_while_an_earlier_run_is_queued_still_runs() {
        // Ann's run is still queued when Bob's mail arrives in the next sync round: Bob's run is
        // queued behind it (runs are claimed one at a time), never dropped.
        let a = vec![event("e", EventKind::MailFrom, &["epam.com"], &[])];
        let mut state = State::default();
        let first = match_events(
            &a,
            &[mail("m1", "ann@epam.com", "", "")],
            &[],
            &HashSet::new(),
            &mut state,
            1_000,
        );
        assert_eq!(first, vec![("e".to_string(), "m1".to_string())]);
        state.in_progress.insert("e".into());
        let got = match_events(
            &a,
            &[mail("m2", "bob@epam.com", "", "")],
            &[],
            &HashSet::new(),
            &mut state,
            1_180,
        );
        assert_eq!(got, vec![("e".to_string(), "m2".to_string())]);
        assert!(state.skipped.is_empty(), "{:?}", state.skipped);
        // The sender's own cooldown still holds while the run is queued.
        let again = match_events(
            &a,
            &[mail("m3", "bob@epam.com", "", "")],
            &[],
            &HashSet::new(),
            &mut state,
            1_200,
        );
        assert!(again.is_empty());
        // A schedule (no sender) still waits for the run in progress.
        assert_eq!(
            state.refusal("e", None, 1_200),
            Some("An earlier run of this automation is still in progress.")
        );
    }

    #[test]
    fn a_long_sleep_with_the_app_open_is_a_missed_slot_not_an_on_time_run() {
        let mut a = schedule(&[1, 2, 3, 4, 5], "08:45");
        let slot = ts("2026-03-24T08:45:00Z");
        let yesterday = ts("2026-03-23T08:45:00Z");
        let started = ts("2026-03-24T07:00:00Z"); // open before the slot
        let woke = ts("2026-03-24T19:45:00Z"); // the computer slept for 11 h
        a.catch_up = false;
        assert_eq!(due(&a, yesterday, woke, "UTC", started), Due::No);
        a.catch_up = true;
        assert_eq!(due(&a, yesterday, woke, "UTC", started), Due::CatchUp);
        assert_eq!(due(&a, slot, woke, "UTC", started), Due::No);
        // Over 12 h late is skipped even with catch up on.
        assert_eq!(
            due(&a, yesterday, ts("2026-03-24T21:00:00Z"), "UTC", started),
            Due::No
        );
        // Within 15 minutes it is still on time.
        assert_eq!(
            due(&a, yesterday, ts("2026-03-24T08:59:00Z"), "UTC", started),
            Due::Now
        );
    }

    #[test]
    fn dst_gap_runs_after_the_gap_and_a_fold_runs_once() {
        let daily = schedule(&[1, 2, 3, 4, 5, 6, 7], "02:30");
        // 2026-03-29 02:30 does not exist in Berlin: the run moves to 03:00 CEST.
        let gap = next_run(&daily, ts("2026-03-28T12:00:00Z"), "Europe/Berlin").unwrap();
        assert_eq!(gap, ts("2026-03-29T01:00:00Z"));
        // 2026-10-25 02:30 happens twice: the first one counts, and the next run is a day later.
        let fold = next_run(&daily, ts("2026-10-24T12:00:00Z"), "Europe/Berlin").unwrap();
        assert_eq!(fold, ts("2026-10-25T00:30:00Z"));
        assert_eq!(
            next_run(&daily, fold, "Europe/Berlin"),
            Some(ts("2026-10-26T01:30:00Z"))
        );
    }

    fn template(id: &str) -> Template {
        Template {
            id: id.into(),
            name: id.into(),
            ..Template::default()
        }
    }

    #[test]
    fn stored_automations_without_new_fields_still_read() {
        // `automation.json`'s "schedule" data as of main, before `recentMessages`, `createTasks`
        // and `meetingSummary` existed.
        let old = json!({
            "ai": {"model": "claude-haiku-4-5", "profile": "claude"},
            "capUsd": 0.5,
            "catchUp": true,
            "deliver": {"draftReply": false, "notify": true, "today": true},
            "enabled": true,
            "id": "auto-schedule",
            "name": "Morning brief",
            "prompt": "Summarize my day and what needs a reply.",
            "read": {"calendarToday": true, "commitmentsNotes": true, "mailFromSenderDays": 0,
                "needsReply": true, "triggerConversation": false},
            "trigger": {"days": [1, 2, 3, 4, 5], "kind": "schedule", "time": "08:45"}
        });
        let a: Automation = serde_json::from_value(old).unwrap();
        assert!(!a.read.recent_messages);
        assert!(!a.deliver.create_tasks);
        assert_eq!(a.deliver.meeting_summary, None);
    }

    #[test]
    fn template_is_kept_and_old_automations_read_without_it() {
        // An automation saved before this step has no "template" key: it reads as `None`.
        let old = json!({
            "ai": {"profile": "claude"}, "deliver": {}, "enabled": true, "id": "a1",
            "name": "Old", "prompt": "Do it.",
            "trigger": {"days": [1], "kind": "schedule", "time": "08:45"}
        });
        let a: Automation = serde_json::from_value(old).unwrap();
        assert_eq!(a.template, None);

        // Use template, then an edit: the template is kept through the round trip.
        let mut triage = schedule(&[1], "08:00");
        triage.template = Some("inbox-triage".into());
        let value = serde_json::to_value(&triage).unwrap();
        assert_eq!(value["template"], "inbox-triage");
        let back: Automation = serde_json::from_value(value).unwrap();
        assert_eq!(back.template.as_deref(), Some("inbox-triage"));
    }

    #[test]
    fn purpose_of_maps_templates() {
        let with = |t: Option<&str>| Automation {
            template: t.map(String::from),
            ..schedule(&[1], "08:45")
        };
        assert_eq!(purpose_of(&with(Some("morning-brief"))), Purpose::Briefing);
        assert_eq!(purpose_of(&with(Some("inbox-triage"))), Purpose::Triage);
        assert_eq!(purpose_of(&with(Some("commitments"))), Purpose::Commitments);
        // Any other template, or none, is the Automations row.
        assert_eq!(
            purpose_of(&with(Some("draft-replies"))),
            Purpose::Automation
        );
        assert_eq!(purpose_of(&with(None)), Purpose::Automation);
    }

    #[test]
    fn create_tasks_needs_a_message_read() {
        let no_message = "Tasks are made from messages. Tick Needs your reply or Messages since the last run, or start it from a message.";
        let mut calendar_only = schedule(&[1], "08:45");
        calendar_only.read.calendar_today = true;
        calendar_only.deliver.create_tasks = true;
        let err = validate0(&calendar_only).unwrap_err();
        assert_eq!(err.message, no_message);
        assert_eq!(err.field.as_deref(), Some("deliver"));

        let mut needs_reply = calendar_only.clone();
        needs_reply.read.needs_reply = true;
        assert!(validate0(&needs_reply).is_ok());

        let mut recent = calendar_only.clone();
        recent.read.recent_messages = true;
        assert!(validate0(&recent).is_ok());

        let mut mail_from = event("e", EventKind::MailFrom, &["epam.com"], &[]);
        mail_from.read.trigger_conversation = true;
        mail_from.deliver.create_tasks = true;
        assert!(validate0(&mail_from).is_ok());

        let mut meeting_ended = event("e", EventKind::MeetingEnded, &[], &[]);
        meeting_ended.read.trigger_conversation = true;
        meeting_ended.deliver.create_tasks = true;
        assert_eq!(message(validate0(&meeting_ended)), no_message);
    }

    #[test]
    fn a_summary_automation_is_meeting_ready_with_an_existing_template() {
        let templates = vec![template("formal-summary")];

        let no_template = event("e", EventKind::MeetingReady, &[], &[]);
        assert_eq!(
            validate(&no_template, &templates).unwrap_err().message,
            "Choose the template to make."
        );

        let mut on_schedule = schedule(&[1], "08:45");
        on_schedule.deliver.meeting_summary = Some("formal-summary".into());
        assert_eq!(
            validate(&on_schedule, &templates).unwrap_err().message,
            "A meeting summary starts when a meeting's transcript is ready."
        );

        let mut missing = no_template.clone();
        missing.deliver.meeting_summary = Some("nope".into());
        assert_eq!(
            validate(&missing, &templates).unwrap_err().message,
            "Choose a note template."
        );

        let mut summary = no_template.clone();
        summary.deliver.meeting_summary = Some("formal-summary".into());
        summary.prompt = String::new();
        assert!(validate(&summary, &templates).is_ok());

        let mut with_tasks = summary.clone();
        with_tasks.deliver.create_tasks = true;
        assert_eq!(
            validate(&with_tasks, &templates)
                .unwrap_err()
                .field
                .as_deref(),
            Some("deliver")
        );

        let mut with_draft = summary.clone();
        with_draft.deliver.draft_reply = true;
        assert_eq!(
            validate(&with_draft, &templates)
                .unwrap_err()
                .field
                .as_deref(),
            Some("deliver")
        );

        let mut with_read = summary.clone();
        with_read.read.needs_reply = true;
        assert_eq!(
            validate(&with_read, &templates)
                .unwrap_err()
                .field
                .as_deref(),
            Some("deliver")
        );
    }

    #[test]
    fn cooldown_is_per_sender_and_meeting_ready_has_none() {
        let a = vec![event("e", EventKind::MailFrom, &["ann@x", "bob@y"], &[])];
        let mut state = State::default();
        let got = match_events(
            &a,
            &[
                mail("m1", "ann@x", "", ""),
                mail("m2", "bob@y", "", ""),
                mail("m3", "ann@x", "", ""),
            ],
            &[],
            &HashSet::new(),
            &mut state,
            1_000,
        );
        // Different senders of the same automation each start, in the same round; the repeat
        // sender is skipped and the reason recorded.
        assert_eq!(
            got,
            vec![
                ("e".to_string(), "m1".to_string()),
                ("e".to_string(), "m2".to_string())
            ]
        );
        assert_eq!(state.skipped.last().unwrap().source_id, "m3");
        assert_eq!(
            state.skipped.last().unwrap().reason,
            "This automation already ran in the last 10 minutes."
        );
    }

    #[test]
    fn ready_meetings_follow_the_rules() {
        use crate::workspace::meetings::model::Doc;
        const END: i64 = 1_795_000_000;
        fn at(t: i64) -> String {
            chrono::DateTime::from_timestamp(t, 0).unwrap().to_rfc3339()
        }
        fn meeting(id: &str, minutes: i64, state: MeetingState, docs: &[&str]) -> MeetingRecord {
            MeetingRecord {
                event_id: id.into(),
                title: "Weekly sync".into(),
                start: at(END - minutes * 60),
                end: at(END),
                state,
                docs: docs
                    .iter()
                    .map(|t| Doc {
                        id: (*t).into(),
                        ..Doc::default()
                    })
                    .collect(),
                ..Default::default()
            }
        }
        let armed = END - 3600;
        let no_auto = |_: &MeetingRecord| false;
        let wants_auto = |_: &MeetingRecord| true;
        let empty: HashSet<String> = HashSet::new();

        // Downloaded, ended 1h ago, after armed_at: in.
        let m1 = meeting("m1", 30, MeetingState::Downloaded, &[]);
        let one = std::slice::from_ref(&m1);
        assert_eq!(
            ready_meetings(one, no_auto, &empty, armed, END, true).len(),
            1
        );
        // Ended 3 days ago: out.
        assert!(ready_meetings(one, no_auto, &empty, armed, END + 3 * 24 * 3600, true).is_empty());
        // Ended before armed_at: out.
        assert!(ready_meetings(one, no_auto, &empty, END + 1, END, true).is_empty());
        // A 2-minute meeting with skip_short on: out; with it off: in.
        let short = meeting("m-short", 2, MeetingState::Downloaded, &[]);
        assert!(ready_meetings(
            std::slice::from_ref(&short),
            no_auto,
            &empty,
            armed,
            END,
            true
        )
        .is_empty());
        assert_eq!(
            ready_meetings(&[short], no_auto, &empty, armed, END, false).len(),
            1
        );
        // Wants its own automatic notes and has no document yet: out.
        assert!(ready_meetings(one, wants_auto, &empty, armed, END, true).is_empty());
        // Same, but a document already exists (the automatic notes came through): in.
        let has_doc = meeting("m1", 30, MeetingState::Ready, &["meeting-notes"]);
        assert_eq!(
            ready_meetings(&[has_doc], wants_auto, &empty, armed, END, true).len(),
            1
        );
        // A meeting_notes job already queued or running for it: out.
        let busy: HashSet<String> = ["m1".to_string()].into();
        assert!(ready_meetings(&[m1], no_auto, &busy, armed, END, true).is_empty());
    }
}
