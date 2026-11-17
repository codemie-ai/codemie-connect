//! Automations (DESIGN 6.6): the model, its validation, when a run is due and which new
//! messages or ended meetings start one. Runs themselves arrive with Task 15; here a due
//! run is queued as an `automation_run` job and the executor is a stub.
use crate::workspace::models::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub const NAME_MAX: usize = 80;
pub const PROMPT_MAX: usize = 4000;
pub const COOLDOWN_SECS: i64 = 600;
pub const HOURLY_CAP: usize = 30;
pub const CATCH_UP_SECS: i64 = 12 * 3600;
/// A scheduled time this recent, while Connect was open, is an ordinary run; later is missed.
pub const ON_TIME_SECS: i64 = 15 * 60;

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

pub(super) fn invalid(message: impl Into<String>) -> WorkspaceError {
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
    /// Drops everything remembered about a deleted automation.
    pub fn forget(&mut self, id: &str) {
        self.last_slot.remove(id);
        self.fired.remove(id);
        self.in_progress.remove(id);
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
            let end = crate::workspace::graph::timestamp(d["end"].as_str().unwrap_or(""));
            (end > last_check && end <= now).then(|| MeetingIn {
                id: e.id.clone(),
                title: d["title"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect()
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
}
