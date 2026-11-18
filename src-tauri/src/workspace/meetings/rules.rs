//! Automatic rules (Settings › Meetings › Automatic rules): "title contains Philips → Meeting
//! notes, made automatically". The first matching rule that is on picks a meeting's template
//! when the meeting has none of its own, and may ask for notes as soon as the transcript is
//! saved. A rule is a local record of kind [`KIND`] in the active workspace.
use super::model::MeetingSettings;
use crate::workspace::models::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The local record kind of a rule.
pub const KIND: &str = "meeting_rule";
/// What a rule looks at: the title, the organizer, the company of anyone invited (their e-mail
/// domain), the number of people.
pub const FIELDS: [&str; 4] = ["title", "organizer", "org", "people"];
/// A rule's value is at most this many characters.
pub const VALUE_MAX: usize = 200;

/// One automatic rule, as its record body stores it (`{field, value, template, autoNotes, on,
/// order}`); `id` is the record's id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rule {
    #[serde(skip)]
    pub id: String,
    pub field: String,
    pub value: String,
    pub template: String,
    pub auto_notes: bool,
    pub on: bool,
    pub order: i64,
}

impl Default for Rule {
    fn default() -> Self {
        Self {
            id: String::new(),
            field: "title".into(),
            value: String::new(),
            template: String::new(),
            auto_notes: false,
            on: true,
            order: 0,
        }
    }
}

/// Whether `event` (an event record's data) is what `rule` looks for. A rule with no value
/// matches nothing.
pub fn matches(rule: &Rule, event: &Value) -> bool {
    let value = rule.value.trim().to_lowercase();
    if value.is_empty() {
        return false;
    }
    let text = |v: &Value| v.as_str().unwrap_or("").to_lowercase();
    match rule.field.as_str() {
        "title" => text(&event["title"]).contains(&value),
        "organizer" => {
            let o = &event["organizer"];
            text(&o["name"]).contains(&value) || text(&o["address"]).contains(&value)
        }
        "org" => people(event).iter().any(|(address, _)| {
            address
                .split_once('@')
                .is_some_and(|(_, domain)| domain.contains(&value))
        }),
        "people" => value
            .parse::<usize>()
            .is_ok_and(|n| n == people(event).len()),
        _ => false,
    }
}

/// The organizer and everyone invited (not rooms or equipment), each once: (lower-case
/// address, lower-case name); someone without an address counts by name.
fn people(event: &Value) -> Vec<(String, String)> {
    let mut seen = std::collections::HashSet::new();
    std::iter::once(&event["organizer"])
        .chain(event["attendees"].as_array().into_iter().flatten())
        .filter(|p| p.is_object() && p["type"] != "resource")
        .filter_map(|p| {
            let address = p["address"].as_str().unwrap_or("").trim().to_lowercase();
            let name = p["name"].as_str().unwrap_or("").trim().to_lowercase();
            let key = if address.is_empty() { &name } else { &address };
            (!key.is_empty() && seen.insert(key.clone())).then_some((address, name))
        })
        .collect()
}

/// The first rule that is on and matches, in the rules' order (then by id).
pub fn first<'a>(rules: &'a [Rule], event: &Value) -> Option<&'a Rule> {
    rules
        .iter()
        .filter(|r| r.on && matches(r, event))
        .min_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)))
}

/// Whether a meeting's notes are made by themselves, and whether the person asked for that on
/// the meeting itself. The meeting's own switch (`auto`) wins; otherwise Settings › Meetings ›
/// Make notes automatically decides: every meeting (`all`), the first matching rule's choice
/// (`rules`) or never (`off`).
pub fn auto_notes(
    auto: Option<bool>,
    event: &Value,
    rules: &[Rule],
    s: &MeetingSettings,
) -> (bool, bool) {
    if let Some(asked) = auto {
        return (asked, asked);
    }
    let wanted = match s.auto_notes.as_str() {
        "all" => true,
        "rules" => first(rules, event).is_some_and(|r| r.auto_notes),
        _ => false,
    };
    (wanted, false)
}

/// A rule from its record; `None` when the body can't be read.
pub fn from_record(record: &Record) -> Option<Rule> {
    let mut rule: Rule = serde_json::from_value(record.data.clone()).ok()?;
    rule.id = record.id.clone();
    Some(rule)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(id: &str, field: &str, value: &str, order: i64) -> Rule {
        Rule {
            id: id.into(),
            field: field.into(),
            value: value.into(),
            template: "short-summary".into(),
            order,
            ..Default::default()
        }
    }

    fn sync() -> Value {
        json!({"title": "Philips CodeMie conversations syncup",
        "organizer": {"name": "Jeroen de Vries", "address": "jeroen.devries@philips.com"},
        "attendees": [
            {"name": "Jeroen de Vries", "address": "JEROEN.DEVRIES@philips.com"},
            {"name": "Anouk Bakker", "address": "anouk.bakker@philips.com"},
            {"name": "Taylor Morgan", "address": "taylor_morgan@epam.com"},
            {"name": "Guest Lee", "address": ""},
            {"name": "Room 4", "address": "room4@northwind.test", "type": "resource"}
        ]})
    }

    #[test]
    fn rules_match_title_organizer_company_and_people_count() {
        let e = sync();
        assert!(matches(&rule("r", "title", "philips", 0), &e));
        assert!(matches(
            &rule("r", "title", " CodeMie Conversations ", 0),
            &e
        ));
        assert!(!matches(&rule("r", "title", "stand-up", 0), &e));
        // Organizer: by name or e-mail.
        assert!(matches(&rule("r", "organizer", "Jeroen", 0), &e));
        assert!(matches(&rule("r", "organizer", "devries@philips", 0), &e));
        assert!(!matches(&rule("r", "organizer", "Anouk", 0), &e));
        // Company: anyone's e-mail domain, the organizer's too.
        assert!(matches(&rule("r", "org", "Philips", 0), &e));
        assert!(matches(&rule("r", "org", "epam", 0), &e));
        assert!(
            !matches(&rule("r", "org", "northwind", 0), &e),
            "a room is not a company"
        );
        assert!(
            !matches(&rule("r", "org", "jeroen", 0), &e),
            "names are not companies"
        );
        // People: the organizer and everyone invited, each once (by address, else by name);
        // rooms and equipment are not people.
        assert!(matches(&rule("r", "people", "4", 0), &e));
        assert!(matches(&rule("r", "people", " 4 ", 0), &e));
        assert!(!matches(&rule("r", "people", "3", 0), &e));
        assert!(!matches(&rule("r", "people", "four", 0), &e));
        // An empty value or an unknown field matches nothing.
        assert!(!matches(&rule("r", "title", "  ", 0), &e));
        assert!(!matches(&rule("r", "subject", "philips", 0), &e));
        // An event without people still has a title.
        let bare = json!({"title": "Daily stand-up"});
        assert!(matches(&rule("r", "title", "stand-up", 0), &bare));
        assert!(!matches(&rule("r", "organizer", "a", 0), &bare));
        assert!(matches(&rule("r", "people", "0", 0), &bare));
    }

    #[test]
    fn first_matching_enabled_rule_wins() {
        let e = sync();
        let mut off = rule("off", "title", "Philips", 0);
        off.on = false;
        let rules = vec![
            rule("late", "org", "philips", 5),
            off,
            rule("other", "title", "Northwind", 1),
            rule("early", "organizer", "jeroen", 2),
        ];
        assert_eq!(first(&rules, &e).map(|r| r.id.as_str()), Some("early"));
        // Same order: by id, so the choice never depends on how records were listed.
        let tie = vec![
            rule("b", "title", "philips", 1),
            rule("a", "org", "philips", 1),
        ];
        assert_eq!(first(&tie, &e).map(|r| r.id.as_str()), Some("a"));
        assert_eq!(first(&rules, &json!({"title": "Lunch"})), None);
        assert_eq!(first(&[], &e), None);
    }

    #[test]
    fn auto_notes_follow_the_meeting_then_the_setting() {
        let e = sync();
        let mut auto = rule("auto", "org", "philips", 0);
        auto.auto_notes = true;
        let manual = rule("manual", "title", "philips", 1);
        let s = |mode: &str| MeetingSettings {
            auto_notes: mode.into(),
            ..Default::default()
        };
        // Rules: the first matching rule decides.
        assert_eq!(
            auto_notes(None, &e, &[auto.clone(), manual.clone()], &s("rules")),
            (true, false)
        );
        let mut later = auto.clone();
        later.order = 2;
        assert_eq!(
            auto_notes(None, &e, &[later, manual.clone()], &s("rules")),
            (false, false)
        );
        // Every meeting, or none.
        assert_eq!(
            auto_notes(None, &json!({"title": "x"}), &[], &s("all")),
            (true, false)
        );
        assert_eq!(
            auto_notes(None, &e, &[auto.clone()], &s("off")),
            (false, false)
        );
        // The meeting's own switch wins, and is the person's own request.
        assert_eq!(auto_notes(Some(true), &e, &[], &s("off")), (true, true));
        assert_eq!(
            auto_notes(Some(false), &e, &[auto], &s("all")),
            (false, false)
        );
    }

    #[test]
    fn rules_read_from_their_records() {
        let record = Record {
            id: "r1".into(),
            kind: KIND.into(),
            connection_id: None,
            workspace_id: Some("personal".into()),
            source: "local".into(),
            revision: "v".into(),
            updated_at: 0,
            data: json!({"field": "title", "value": "Philips", "template": "meeting-notes",
                "autoNotes": true, "on": true, "order": 3}),
        };
        let r = from_record(&record).unwrap();
        assert_eq!(r.id, "r1");
        assert!(r.auto_notes && r.on);
        assert_eq!(r.order, 3);
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"field": "title", "value": "Philips", "template": "meeting-notes",
                "autoNotes": true, "on": true, "order": 3})
        );
        // Missing fields read as defaults: on, at the top, title.
        let r = from_record(&Record {
            data: json!({"value": "x", "template": "t"}),
            ..record
        })
        .unwrap();
        assert!(r.on && !r.auto_notes);
        assert_eq!(r.field, "title");
    }
}
