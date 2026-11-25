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
use crate::workspace::models::{id, Record, Result, Settings};
use crate::workspace::repository::Repository;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

const KIND_STYLE: &str = "voice_style";
const KIND_RULE: &str = "voice_rule";
const KIND_PERSON: &str = "voice_person";
const KIND_META: &str = "voice_meta";
const KINDS: [&str; 4] = [KIND_STYLE, KIND_RULE, KIND_PERSON, KIND_META];

const STYLE_MAX: usize = 8_000;
const STYLE_HEAD_MAX: usize = 2_500;
const RULES_MAX: usize = 200;
const RULE_TEXT_MAX: usize = 2_000;
const PEOPLE_MAX: usize = 2_000;
const PROFILE_MAX: usize = 8_000;
const ABOUT_MAX: usize = 2_000;
const NAMES_MAX: usize = 10;
const ADDRESSES_MAX: usize = 10;
const IDS_MAX: usize = 10;
const ID_MAX: usize = 200;

/// How many of the user's sent messages a style card was built from (design §1's `basedOn`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BasedOn {
    pub mail: i64,
    pub teams: i64,
}

/// The user's own page's writing preferences (design §1, §4): read-only in Connect, headed
/// above the editable style card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StyleHead {
    pub text: String,
    pub source: String,
}

/// The style card (design §1): how the user writes.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Style {
    pub text: String,
    pub updated_at: String,
    pub source: String,
    /// How many sent messages it was built from, by channel; `None` when the user wrote it, the
    /// provider sent a bare number (an older shape), or a record `replace` stored before this
    /// field existed (Task 1's `Style.basedOn` was itself a bare number).
    #[serde(default, deserialize_with = "de_based_on")]
    pub based_on: Option<BasedOn>,
    /// The user's own page's writing preferences (design §1's `style.head`), `None` when the
    /// provider has none.
    pub head: Option<StyleHead>,
}

/// What an instruction `applies` to (design §1, amended): `to` an address, `chat` a Teams chat
/// title, `domain` a domain, `topic` one or more words, `no-profile` (the draft's person has no
/// profile) or `everyone` (no value).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppliesKind {
    To,
    Chat,
    Domain,
    Topic,
    #[serde(rename = "no-profile")]
    NoProfile,
    Everyone,
}

/// Which channel a rule is scoped to (design §4's `applies.channel`), or both when `None`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RuleChannel {
    Mail,
    Teams,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Applies {
    pub kind: AppliesKind,
    pub value: Option<String>,
    #[serde(default)]
    pub channel: Option<RuleChannel>,
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

/// One person's profile (design §1, amended); `text` and `about` never reach the snapshot
/// (`person_summary` carries only their lengths).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub addresses: Vec<String>,
    /// Teams user ids (`fromId`), design §1, §4's Teams matching.
    #[serde(default)]
    pub ids: Vec<String>,
    pub text: String,
    /// A few facts about them (role, background); never the profile (design §1, §7).
    #[serde(default)]
    pub about: String,
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

/// The snapshot's shape for one person (design §7, amended): an index entry, never the profile
/// or about text.
pub(crate) fn person_summary(p: &Person) -> Value {
    json!({
        "id": p.id,
        "name": p.name,
        "addresses": p.addresses,
        "ids": p.ids.len(),
        "chars": p.text.chars().count(),
        "aboutChars": p.about.chars().count(),
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

/// Like `strings`, but each item also passes `valid_id` (non-empty, ≤ `ID_MAX` characters):
/// design §2's `ids ≤ 200`.
fn ids_list(v: &Value, max: usize) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| valid_id(s))
        .map(str::to_string)
        .take(max)
        .collect()
}

/// Parses `basedOn`: an object `{mail, teams}`, or `None` for anything else — including a bare
/// number, an older shape (design §1's "A bare number ... reads as `null`").
fn parse_based_on(v: &Value) -> Option<BasedOn> {
    v.as_object().map(|_| BasedOn {
        mail: v["mail"].as_i64().unwrap_or(0),
        teams: v["teams"].as_i64().unwrap_or(0),
    })
}

/// `Style.based_on`'s own `Deserialize`, so a stored record with the field absent, a bare
/// number (Task 1's own shape) or `null` all read back as `None`, same as `parse_based_on`.
fn de_based_on<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<BasedOn>, D::Error> {
    Ok(parse_based_on(&Value::deserialize(d)?))
}

/// Parses `style.head`, applying its limit; `None` when there is no usable text (design §1's
/// `style.head`).
fn parse_head(v: &Value) -> Option<StyleHead> {
    let text = v["text"].as_str()?;
    Some(StyleHead {
        text: truncate_chars(text, STYLE_HEAD_MAX),
        source: v["source"].as_str().unwrap_or_default().to_string(),
    })
}

/// Parses one style object, applying its limits; `None` when there is no usable text (design
/// §1, §2: an item over a limit is cut, never refused).
fn parse_style(v: &Value) -> Option<Style> {
    let text = v["text"].as_str()?;
    Some(Style {
        text: truncate_chars(text, STYLE_MAX),
        updated_at: v["updatedAt"].as_str().unwrap_or_default().to_string(),
        source: v["source"].as_str().unwrap_or_default().to_string(),
        based_on: parse_based_on(&v["basedOn"]),
        head: parse_head(&v["head"]),
    })
}

/// Parses one rule object; `None` when it has no usable id, an unrecognised `applies.kind`, or
/// an unrecognised `applies.channel` — dropped, never widened to `everyone` (design §2's id
/// limit: over 200 characters is dropped).
fn parse_rule(v: &Value) -> Option<Rule> {
    let id = v["id"].as_str()?;
    if !valid_id(id) {
        return None;
    }
    let kind = match v["applies"]["kind"].as_str()? {
        "to" => AppliesKind::To,
        "chat" => AppliesKind::Chat,
        "domain" => AppliesKind::Domain,
        "topic" => AppliesKind::Topic,
        "no-profile" => AppliesKind::NoProfile,
        "everyone" => AppliesKind::Everyone,
        _ => return None,
    };
    let channel = match v["applies"]["channel"].as_str() {
        Some("mail") => Some(RuleChannel::Mail),
        Some("teams") => Some(RuleChannel::Teams),
        Some(_) => return None,
        None => None,
    };
    Some(Rule {
        id: id.to_string(),
        applies: Applies {
            kind,
            value: v["applies"]["value"].as_str().map(str::to_string),
            channel,
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
        ids: ids_list(&v["ids"], IDS_MAX),
        text: truncate_chars(v["text"].as_str().unwrap_or_default(), PROFILE_MAX),
        about: truncate_chars(v["about"].as_str().unwrap_or_default(), ABOUT_MAX),
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
        source: provider.to_string(),
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

/// Writes what a provider's `save` answered (design §7's `voice_save`: "writes the answer into
/// the copy") — a `style` or one `rule`, cut to the copy's limits like an `export` — and answers
/// the item as the copy keeps it, or `null` when the answer holds no usable item (the queued
/// refresh brings it then).
pub fn put_saved(
    r: &mut Repository,
    provider: &str,
    kind: &str,
    answer: &Value,
    at: i64,
) -> Result<Value> {
    let record = match kind {
        "style" => parse_style(answer).map(|s| item_record(KIND_STYLE, "style", &s, provider, at)),
        "rule" => {
            parse_rule(answer).map(|rule| item_record(KIND_RULE, &rule.id, &rule, provider, at))
        }
        _ => None,
    };
    let Some(record) = record else {
        return Ok(Value::Null);
    };
    let item = record.data.clone();
    r.put_global_records(&[record])?;
    Ok(item)
}

/// Removes one instruction from the copy (design §7's `voice_delete`, after the provider's
/// `remove` answered); answers whether it was there.
pub fn remove_rule(r: &mut Repository, id: &str) -> Result<bool> {
    r.delete_record(KIND_RULE, id, "", "")
}

/// Records the copy's state after a refresh attempt that didn't replace it (design §2: "A
/// refresh that fails keeps the copy and records the state ... and the time"), unconditionally
/// — including a provider's first failed refresh, before any `export` has ever succeeded, when
/// there is no meta row yet to find a provider on: `provider` is given directly so `needs_setup`
/// is still reachable then. An existing `refreshedAt` (the last successful full refresh) is kept;
/// with no meta row yet it starts at 0.
pub fn set_state(r: &mut Repository, provider: &str, state: VoiceState, at: i64) -> Result<()> {
    let refreshed_at = r
        .records_of_kind(KIND_META)?
        .into_iter()
        .next()
        .map(|existing| existing.data["refreshedAt"].as_i64().unwrap_or(0))
        .unwrap_or(0);
    let meta = Meta {
        provider: provider.to_string(),
        refreshed_at,
        state,
    };
    r.put_global_records(&[item_record(KIND_META, "meta", &meta, provider, at)])
}

/// Deletes every copy record, whatever provider it belongs to (design §6's "Delete Connect's
/// copy"), in one transaction. Answers how many records were removed.
pub fn forget(r: &mut Repository) -> Result<usize> {
    r.delete_global_records(&KINDS)
}

/// `forget` together with writing `settings` (the voice turned Off), in one transaction (design
/// §6's "sets Off and deletes every copy record in one transaction").
pub fn forget_with(r: &mut Repository, settings: &Settings) -> Result<usize> {
    r.settings_update_deleting_global(settings, &KINDS)
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
                based_on: Some(BasedOn { mail: 10, teams: 0 }),
                head: None,
            }),
            rules: Vec::new(),
            people: vec![
                Person {
                    id: "priya-n".into(),
                    name: "Priya N.".into(),
                    names: Vec::new(),
                    addresses: vec!["priya.n@example.test".into()],
                    ids: Vec::new(),
                    text: "Old text.".into(),
                    about: String::new(),
                    updated_at: "t0".into(),
                    source: "People/priya-n.md".into(),
                },
                Person {
                    id: "jordan-lee".into(),
                    name: "Jordan Lee".into(),
                    names: Vec::new(),
                    addresses: vec!["jordan@example.test".into()],
                    ids: Vec::new(),
                    text: "Unchanged.".into(),
                    about: String::new(),
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

    /// A person's `about` and Teams `ids`; a style card with `head` and an object `basedOn`;
    /// rules of kind `chat` and `no-profile`, one scoped to a channel (design §1, §4).
    #[test]
    fn from_export_reads_about_ids_head_and_scopes() {
        let v = json!({
            "style": {
                "text": "Short and direct.",
                "updatedAt": "t",
                "source": "Voice/style.md",
                "basedOn": {"mail": 12, "teams": 140},
                "head": {"text": "Head text.", "source": "people/me.md"},
            },
            "rules": [
                {"id": "chat-platform-review", "applies": {"kind": "chat", "value": "Platform review"}, "text": "Terse."},
                {"id": "no-profile-teams", "applies": {"kind": "no-profile", "channel": "teams"}, "text": "Polite."},
            ],
            "people": [
                {"id": "priya-n", "name": "Priya N.", "ids": ["t-1"], "about": "Product lead.", "text": "Writing notes."},
            ],
        });
        let c = from_export(&v);

        let style = c.style.unwrap();
        assert_eq!(
            style.based_on,
            Some(BasedOn {
                mail: 12,
                teams: 140
            })
        );
        assert_eq!(style.head.unwrap().text, "Head text.");

        let chat = c
            .rules
            .iter()
            .find(|r| r.id == "chat-platform-review")
            .unwrap();
        assert_eq!(chat.applies.kind, AppliesKind::Chat);
        assert_eq!(chat.applies.value, Some("Platform review".into()));
        assert_eq!(chat.applies.channel, None);

        let scoped = c.rules.iter().find(|r| r.id == "no-profile-teams").unwrap();
        assert_eq!(scoped.applies.kind, AppliesKind::NoProfile);
        assert_eq!(scoped.applies.channel, Some(RuleChannel::Teams));

        let priya = &c.people[0];
        assert_eq!(priya.about, "Product lead.");
        assert_eq!(priya.ids, vec!["t-1".to_string()]);
    }

    /// design §2's new limits: a style head cut to 2,500, a person's `about` cut to 2,000 and
    /// their `ids` capped at 10 — cut or dropped, never refused.
    #[test]
    fn from_export_applies_the_new_limits() {
        let v = json!({
            "style": {
                "text": "Short.", "updatedAt": "t", "source": "s",
                "head": {"text": "h".repeat(3_000), "source": "people/me.md"},
            },
            "people": [
                {
                    "id": "many-ids", "name": "Many",
                    "ids": (0..12).map(|n| format!("id-{n}")).collect::<Vec<_>>(),
                    "about": "a".repeat(2_500),
                    "text": "t",
                },
            ],
        });
        let c = from_export(&v);
        assert_eq!(c.style.unwrap().head.unwrap().text.chars().count(), 2_500);
        assert_eq!(c.people[0].ids.len(), 10);
        assert_eq!(c.people[0].about.chars().count(), 2_000);
    }

    /// design §1: "A bare number (an older shape) reads as `null`."
    #[test]
    fn a_bare_based_on_number_reads_as_null() {
        let v =
            json!({"style": {"text": "Short.", "updatedAt": "t", "source": "s", "basedOn": 40}});
        let c = from_export(&v);
        assert_eq!(c.style.unwrap().based_on, None);
    }

    /// An unrecognised `applies.kind` or `applies.channel` drops the rule outright — it is
    /// never widened to `everyone` (design §2).
    #[test]
    fn a_rule_with_an_unknown_kind_or_channel_is_dropped() {
        let v = json!({
            "rules": [
                {"id": "nobody", "applies": {"kind": "nobody"}, "text": "t"},
                {"id": "bad-channel", "applies": {"kind": "everyone", "channel": "fax"}, "text": "t"},
                {"id": "everyone", "applies": {"kind": "everyone"}, "text": "t"},
            ],
        });
        let c = from_export(&v);
        assert_eq!(
            c.rules.len(),
            1,
            "only the valid rule survives: {:?}",
            c.rules
        );
        assert_eq!(c.rules[0].id, "everyone");
    }

    /// A `context` answer carrying `facts` leaves no fact in the stored copy: `merge_context`
    /// has no `facts` field to read in the first place (design §2: "Facts are never part of
    /// it").
    #[test]
    fn merge_context_ignores_facts() {
        const SENTINEL: &str = "VOICE_SENTINEL_9f3a";
        let mut r = repo();
        let c = from_export(&json!({"style": {"text": "Short.", "updatedAt": "t", "source": "s"}}));
        replace(&mut r, "plugin:knowledge", &c, 1_000).unwrap();

        merge_context(
            &mut r,
            "plugin:knowledge",
            &json!({"facts": [{"id": "f1", "title": "Budget", "text": SENTINEL}]}),
            2_000,
        )
        .unwrap();

        let stored = read_copy(&r).unwrap().unwrap();
        let text = serde_json::to_string(&stored).unwrap();
        assert!(
            !text.contains(SENTINEL),
            "a fact leaked into the copy: {text}"
        );
    }

    /// A `voice_style` record written by Task 1 — before `head` existed and `basedOn` was a
    /// bare number — still reads under the amended `Style`: every new field carries a serde
    /// default, and `based_on`'s own deserializer treats a bare number the same as
    /// `parse_based_on` does.
    #[test]
    fn a_style_record_from_before_this_task_still_reads() {
        let mut r = repo();
        let old_style = json!({
            "text": "Short and direct.",
            "updatedAt": "t",
            "source": "Voice/style.md",
            "basedOn": 40,
        });
        let meta = json!({"provider": "plugin:knowledge", "refreshedAt": 1_000, "state": "ready"});
        r.put_global_records(&[
            item_record(KIND_STYLE, "style", &old_style, "plugin:knowledge", 1_000),
            item_record(KIND_META, "meta", &meta, "plugin:knowledge", 1_000),
        ])
        .unwrap();

        let stored = read_copy(&r).unwrap().unwrap();
        let style = stored.style.expect("the old record still parses");
        assert_eq!(style.text, "Short and direct.");
        assert_eq!(
            style.based_on, None,
            "a bare number reads as null, not an error"
        );
        assert_eq!(style.head, None);
    }

    /// Carried from Task 1's review: a provider's first failed refresh, before any `export` has
    /// ever succeeded, has no meta row to find a provider on. `set_state` is given the provider
    /// directly and creates the row, so `needs_setup` is reachable then, not silently dropped.
    #[test]
    fn set_state_records_the_state_when_there_is_no_copy_yet() {
        let mut r = repo();
        assert!(read_copy(&r).unwrap().is_none());

        set_state(&mut r, "plugin:knowledge", VoiceState::NeedsSetup, 1_000).unwrap();

        let stored = read_copy(&r).unwrap().unwrap();
        assert_eq!(stored.provider, "plugin:knowledge");
        assert_eq!(stored.state, VoiceState::NeedsSetup);
        assert_eq!(stored.refreshed_at, 0, "no export has ever succeeded");
    }
}
