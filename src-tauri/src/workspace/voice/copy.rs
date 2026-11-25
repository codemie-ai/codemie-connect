//! Connect's copy of the user's voice (design `docs/superpowers/specs/2026-11-25-reply-voice-design.md`
//! §1, §2): the shapes a `reply-context` provider answers in (`Style`, `Rule`, `Person`,
//! `Copy`), the limits every item is cut or dropped to on the way in (`from_export`, never
//! refusing), and the repository operations the copy lives by: `replace` (one transaction, a
//! full `export`), `merge_context` (a `context` answer's parts, upserted without disturbing the
//! rest), `forget` (every copy record gone) and `read_copy`.
//!
//! The copy is bookkeeping records — `workspace_id` and `connection_id` both `None`, `source`
//! `plugin:<id>` — of four kinds (`voice_style`, `voice_rule`, `voice_person`, `voice_meta`),
//! never shown in `Snapshot.records`: `Repository::snapshot`'s record queries only ever admit a
//! workspace-less, connection-less row whose kind is `plugin_item` or `plugin_widget` (design
//! §2's "Connect keeps a copy ... the snapshot keeps out of `records`").
use super::VoiceState;
use crate::workspace::models::{id, Record, Result};
use crate::workspace::repository::Repository;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const KIND_STYLE: &str = "voice_style";
const KIND_RULE: &str = "voice_rule";
const KIND_PERSON: &str = "voice_person";
const KIND_META: &str = "voice_meta";
const KINDS: [&str; 4] = [KIND_STYLE, KIND_RULE, KIND_PERSON, KIND_META];

const STYLE_MAX: usize = 8_000;
const RULES_MAX: usize = 200;
const RULE_TEXT_MAX: usize = 2_000;
const PEOPLE_MAX: usize = 2_000;
const PROFILE_MAX: usize = 8_000;
const NAMES_MAX: usize = 10;
const ADDRESSES_MAX: usize = 10;
const ID_MAX: usize = 200;

/// The style card (design §1): how the user writes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Style {
    pub text: String,
    pub updated_at: String,
    pub source: String,
    /// How many sent messages it was built from; `None` when the user wrote it.
    pub based_on: Option<i64>,
}

/// What an instruction `applies` to (design §1): `to` an address, `domain` a domain, `topic`
/// one or more words, or `everyone` (no value).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppliesKind {
    To,
    Domain,
    Topic,
    Everyone,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Applies {
    pub kind: AppliesKind,
    pub value: Option<String>,
}

/// One instruction (design §1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub applies: Applies,
    pub text: String,
    pub source: String,
    pub editable: bool,
}

/// One person's profile (design §1); `text` never reaches the snapshot (`person_summary`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub addresses: Vec<String>,
    pub text: String,
    pub updated_at: String,
    pub source: String,
}

/// Connect's whole copy of one provider's voice (design §2): the last `export`, merged with
/// each `context` answer since.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Copy {
    pub provider: String,
    pub refreshed_at: i64,
    pub state: VoiceState,
    pub style: Option<Style>,
    pub rules: Vec<Rule>,
    pub people: Vec<Person>,
}

/// The snapshot's shape for one person (design §7): an index entry, never the profile text.
pub(crate) fn person_summary(p: &Person) -> Value {
    json!({
        "id": p.id,
        "name": p.name,
        "addresses": p.addresses,
        "chars": p.text.chars().count(),
        "source": p.source,
    })
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

fn strings(v: &Value, max: usize) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .take(max)
        .collect()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= ID_MAX
}

/// Parses one style object, applying its limit; `None` when there is no usable text (design §1,
/// §2: an item over a limit is cut, never refused).
fn parse_style(v: &Value) -> Option<Style> {
    let text = v["text"].as_str()?;
    Some(Style {
        text: truncate_chars(text, STYLE_MAX),
        updated_at: v["updatedAt"].as_str().unwrap_or_default().to_string(),
        source: v["source"].as_str().unwrap_or_default().to_string(),
        based_on: v["basedOn"].as_i64(),
    })
}

/// Parses one rule object; `None` when it has no usable id or an unrecognised `applies.kind` —
/// dropped, never refused (design §2's id limit: over 200 characters is dropped).
fn parse_rule(v: &Value) -> Option<Rule> {
    let id = v["id"].as_str()?;
    if !valid_id(id) {
        return None;
    }
    let kind = match v["applies"]["kind"].as_str()? {
        "to" => AppliesKind::To,
        "domain" => AppliesKind::Domain,
        "topic" => AppliesKind::Topic,
        "everyone" => AppliesKind::Everyone,
        _ => return None,
    };
    Some(Rule {
        id: id.to_string(),
        applies: Applies {
            kind,
            value: v["applies"]["value"].as_str().map(str::to_string),
        },
        text: truncate_chars(v["text"].as_str().unwrap_or_default(), RULE_TEXT_MAX),
        source: v["source"].as_str().unwrap_or_default().to_string(),
        editable: v["editable"].as_bool().unwrap_or(true),
    })
}

/// Parses one person object; `None` when it has no usable id (dropped, design §2).
fn parse_person(v: &Value) -> Option<Person> {
    let id = v["id"].as_str()?;
    if !valid_id(id) {
        return None;
    }
    Some(Person {
        id: id.to_string(),
        name: v["name"].as_str().unwrap_or_default().to_string(),
        names: strings(&v["names"], NAMES_MAX),
        addresses: strings(&v["addresses"], ADDRESSES_MAX),
        text: truncate_chars(v["text"].as_str().unwrap_or_default(), PROFILE_MAX),
        updated_at: v["updatedAt"].as_str().unwrap_or_default().to_string(),
        source: v["source"].as_str().unwrap_or_default().to_string(),
    })
}

/// Turns a provider's `export` answer (design §1's `{style, rules, people}`) into a `Copy`,
/// applying every limit by cutting or dropping, never refusing (design §2). `provider`,
/// `refreshedAt` and `state` are left at their defaults: `replace` fills them in.
pub fn from_export(v: &Value) -> Copy {
    let style = parse_style(&v["style"]);
    let rules: Vec<Rule> = v["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(parse_rule)
        .take(RULES_MAX)
        .collect();
    let people: Vec<Person> = v["people"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(parse_person)
        .take(PEOPLE_MAX)
        .collect();
    Copy {
        provider: String::new(),
        refreshed_at: 0,
        state: VoiceState::Unavailable,
        style,
        rules,
        people,
    }
}

/// The copy's bookkeeping metadata record (`voice_meta`): the provider it belongs to, when it
/// was last fully replaced, and its state after the last refresh attempt. `VoiceState` has no
/// natural zero value, so an unreadable or missing one falls back to `unavailable` here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Meta {
    provider: String,
    refreshed_at: i64,
    state: VoiceState,
}

fn item_record<T: Serialize>(kind: &str, rid: &str, body: &T, provider: &str, at: i64) -> Record {
    Record {
        id: rid.to_string(),
        kind: kind.to_string(),
        connection_id: None,
        workspace_id: None,
        source: format!("plugin:{provider}"),
        revision: id(),
        updated_at: at,
        data: serde_json::to_value(body).unwrap_or(Value::Null),
    }
}

/// Replaces the whole copy with `c`'s style, rules and people, in one transaction (design §2): a
/// successful `export` always leaves the copy `ready`, stamped `at`.
pub fn replace(r: &mut Repository, provider: &str, c: &Copy, at: i64) -> Result<()> {
    let mut upserts = Vec::new();
    if let Some(style) = &c.style {
        upserts.push(item_record(KIND_STYLE, "style", style, provider, at));
    }
    for rule in &c.rules {
        upserts.push(item_record(KIND_RULE, &rule.id, rule, provider, at));
    }
    for person in &c.people {
        upserts.push(item_record(KIND_PERSON, &person.id, person, provider, at));
    }
    let meta = Meta {
        provider: provider.to_string(),
        refreshed_at: at,
        state: VoiceState::Ready,
    };
    upserts.push(item_record(KIND_META, "meta", &meta, provider, at));
    r.replace_global_records(&KINDS, &upserts)
}

/// Merges a `context` answer's parts (design §1's `{style, person, rules}`) into the copy: each
/// part present upserts its own record, by id, without touching the rest of the copy or its
/// `refreshedAt` (only a full `replace` moves that).
pub fn merge_context(r: &mut Repository, provider: &str, answer: &Value, at: i64) -> Result<()> {
    let mut upserts = Vec::new();
    if let Some(style) = parse_style(&answer["style"]) {
        upserts.push(item_record(KIND_STYLE, "style", &style, provider, at));
    }
    if let Some(person) = parse_person(&answer["person"]) {
        upserts.push(item_record(KIND_PERSON, &person.id, &person, provider, at));
    }
    for rule in answer["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(parse_rule)
    {
        upserts.push(item_record(KIND_RULE, &rule.id, &rule, provider, at));
    }
    if upserts.is_empty() {
        return Ok(());
    }
    r.put_global_records(&upserts)
}

/// Records the copy's state after a refresh attempt that didn't replace it (design §2: "A
/// refresh that fails keeps the copy and records the state ... and the time"). A no-op when no
/// copy has ever been written (there is nothing to mark, and no provider to remember).
pub fn set_state(r: &mut Repository, state: VoiceState, at: i64) -> Result<()> {
    let Some(existing) = r.records_of_kind(KIND_META)?.into_iter().next() else {
        return Ok(());
    };
    let provider = existing.data["provider"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let refreshed_at = existing.data["refreshedAt"].as_i64().unwrap_or(0);
    let meta = Meta {
        provider: provider.clone(),
        refreshed_at,
        state,
    };
    r.put_global_records(&[item_record(KIND_META, "meta", &meta, &provider, at)])
}

/// Deletes every copy record, whatever provider it belongs to (design §6's "Delete Connect's
/// copy"), in one transaction. Answers how many records were removed.
pub fn forget(r: &mut Repository) -> Result<usize> {
    r.delete_global_records(&KINDS)
}

/// Reads the stored copy, or `None` when nothing has ever been replaced into it.
pub fn read_copy(r: &Repository) -> Result<Option<Copy>> {
    let Some(meta_record) = r.records_of_kind(KIND_META)?.into_iter().next() else {
        return Ok(None);
    };
    let meta: Meta = serde_json::from_value(meta_record.data).unwrap_or_default();
    let style = r
        .records_of_kind(KIND_STYLE)?
        .into_iter()
        .next()
        .and_then(|rec| serde_json::from_value::<Style>(rec.data).ok());
    let mut rules: Vec<Rule> = r
        .records_of_kind(KIND_RULE)?
        .into_iter()
        .filter_map(|rec| serde_json::from_value::<Rule>(rec.data).ok())
        .collect();
    rules.sort_by(|a, b| a.id.cmp(&b.id));
    let mut people: Vec<Person> = r
        .records_of_kind(KIND_PERSON)?
        .into_iter()
        .filter_map(|rec| serde_json::from_value::<Person>(rec.data).ok())
        .collect();
    people.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Some(Copy {
        provider: meta.provider,
        refreshed_at: meta.refreshed_at,
        state: meta.state,
        style,
        rules,
        people,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn repo() -> Repository {
        let dir = tempfile::tempdir().unwrap();
        Repository::open(&dir.path().join("w.sqlite")).unwrap()
    }

    /// design §2's limits: style cut to 8,000, rules capped at 200, a person's addresses cut to
    /// 10, and an id over 200 characters dropped — all cut or dropped, never refused.
    #[test]
    fn from_export_applies_every_limit() {
        let rules: Vec<Value> = (0..250)
            .map(|n| json!({"id": format!("r{n}"), "applies": {"kind": "everyone"}, "text": "x"}))
            .collect();
        let long_id = "x".repeat(300);
        let v = json!({
            "style": {"text": "a".repeat(9_000), "updatedAt": "t", "source": "s"},
            "rules": rules,
            "people": [
                {"id": "many-addresses", "name": "Many", "addresses": (0..12).map(|n| format!("a{n}@example.test")).collect::<Vec<_>>(), "text": "t"},
                {"id": long_id, "name": "Too long", "text": "t"},
            ],
        });
        let c = from_export(&v);
        assert_eq!(c.style.unwrap().text.chars().count(), 8_000);
        assert_eq!(c.rules.len(), 200);
        assert_eq!(c.people.len(), 1, "the 300-char id is dropped");
        assert_eq!(c.people[0].id, "many-addresses");
        assert_eq!(c.people[0].addresses.len(), 10);
    }

    /// `replace` writes style, rules and people in one transaction; `merge_context` upserts one
    /// person without disturbing the other or the stored `refreshedAt`.
    #[test]
    fn replace_is_one_transaction_and_merge_upserts() {
        let mut r = repo();
        let c = Copy {
            provider: String::new(),
            refreshed_at: 0,
            state: VoiceState::Unavailable,
            style: Some(Style {
                text: "Short and direct.".into(),
                updated_at: "t".into(),
                source: "Voice/style.md".into(),
                based_on: Some(10),
            }),
            rules: Vec::new(),
            people: vec![
                Person {
                    id: "priya-n".into(),
                    name: "Priya N.".into(),
                    names: Vec::new(),
                    addresses: vec!["priya.n@example.test".into()],
                    text: "Old text.".into(),
                    updated_at: "t0".into(),
                    source: "People/priya-n.md".into(),
                },
                Person {
                    id: "jordan-lee".into(),
                    name: "Jordan Lee".into(),
                    names: Vec::new(),
                    addresses: vec!["jordan@example.test".into()],
                    text: "Unchanged.".into(),
                    updated_at: "t0".into(),
                    source: "People/jordan-lee.md".into(),
                },
            ],
        };
        replace(&mut r, "plugin:knowledge", &c, 1_000).unwrap();
        let stored = read_copy(&r).unwrap().unwrap();
        assert_eq!(stored.people.len(), 2);
        assert_eq!(stored.refreshed_at, 1_000);
        assert_eq!(stored.state, VoiceState::Ready);

        merge_context(
            &mut r,
            "plugin:knowledge",
            &json!({"person": {"id": "priya-n", "name": "Priya N.", "addresses": ["priya.n@example.test"], "text": "New text.", "updatedAt": "t1", "source": "People/priya-n.md"}}),
            2_000,
        )
        .unwrap();

        let stored = read_copy(&r).unwrap().unwrap();
        let priya = stored.people.iter().find(|p| p.id == "priya-n").unwrap();
        let jordan = stored.people.iter().find(|p| p.id == "jordan-lee").unwrap();
        assert_eq!(priya.text, "New text.");
        assert_eq!(jordan.text, "Unchanged.", "the other person is kept");
        assert_eq!(
            stored.refreshed_at, 1_000,
            "a merge never moves the full-refresh time"
        );
    }

    #[test]
    fn forget_deletes_every_copy_record() {
        let mut r = repo();
        let c = from_export(&json!({
            "style": {"text": "Short.", "updatedAt": "t", "source": "s"},
            "rules": [{"id": "everyone", "applies": {"kind": "everyone"}, "text": "t"}],
            "people": [{"id": "priya-n", "name": "Priya N.", "text": "t"}],
        }));
        replace(&mut r, "plugin:knowledge", &c, 1_000).unwrap();
        assert!(read_copy(&r).unwrap().is_some());

        let removed = forget(&mut r).unwrap();
        assert!(removed > 0);
        assert!(read_copy(&r).unwrap().is_none());
    }

    /// design §2: the copy's records are never part of `Snapshot.records` (that query only
    /// admits a workspace-less, connection-less row of kind `plugin_item` or `plugin_widget`).
    #[test]
    fn copy_records_stay_out_of_records() {
        let mut r = repo();
        let c = from_export(&json!({
            "style": {"text": "Short.", "updatedAt": "t", "source": "s"},
            "rules": [{"id": "everyone", "applies": {"kind": "everyone"}, "text": "t"}],
            "people": [{"id": "priya-n", "name": "Priya N.", "text": "t"}],
        }));
        replace(&mut r, "plugin:knowledge", &c, 1_000).unwrap();
        let snapshot = r.snapshot().unwrap();
        assert!(
            snapshot
                .records
                .iter()
                .all(|rec| !rec.kind.starts_with("voice_")),
            "a copy record leaked into records: {:?}",
            snapshot.records
        );
    }
}
