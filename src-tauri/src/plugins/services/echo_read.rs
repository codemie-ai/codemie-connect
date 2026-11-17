//! `ctx.echo.read(kind, opts)` and `ctx.echo.dictionary.add(term)` (PLUGIN-ENGINE.md §4.5): the
//! user's data, for the kinds the sheet named (`uses.echo.read`; `source` and `sources` are the
//! same grant). Connect fills them from what the active workspace shows:
//! - `people`: who wrote the messages and who was in the meetings;
//! - `sources` (`{kind, since, thread, limit}`, newest first): mail (`mail`), Teams chats
//!   (`channel`) and meetings (`meeting`), ids `mail:<id>`, `chat:<id>`, `event:<id>`;
//! - `source(id)`: one of them with its text;
//! - `threads`: `[]` (Connect has none);
//! - `clients` and `dictionary`: kept by Connect for the plugin, in
//!   `<data>/plugins/data/<id>/echo/`; `dictionary.add` (with `uses.echo.write: ["dictionary"]`)
//!   adds to it.
use super::{at, bad, permission, read_json, text, write_json, Granted, Services};
use crate::plugins::host::{ErrorCode, HostError};
use crate::workspace::models::Record;
use crate::workspace::plugin_data::plugin_source_id;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const MAX_PEOPLE: usize = 2000;
const MAX_TERMS: usize = 5000;

fn echo_dir(s: &Services, id: &str) -> std::path::PathBuf {
    s.data_of(id).join("echo")
}

pub fn read(s: &Services, p: &Granted, args: &Value) -> Result<Value, HostError> {
    let kind = text(args, 0, "what to read")?;
    let asked = |k: &str| p.words("echo", "read").iter().any(|x| x == k);
    let granted = asked(kind)
        || (matches!(kind, "source" | "sources") && (asked("source") || asked("sources")));
    if !granted {
        return Err(permission(format!(
            "{} didn't ask to read your {kind} when it was installed (uses.echo.read)",
            p.id
        )));
    }
    match kind {
        "threads" => Ok(json!([])),
        "clients" => Ok(read_json(&echo_dir(s, &p.id).join("clients.json"), json!([]))),
        "dictionary" => Ok(json!({"terms": terms(s, &p.id)})),
        "people" => Ok(people(&sources(s)?)),
        "sources" => Ok(list(&sources(s)?, at(args, 1))),
        "source" => {
            let id = text(args, 1, "a source's id")?;
            sources(s)?
                .iter()
                .find(|r| plugin_source_id(r) == id)
                .map(one)
                .ok_or_else(|| HostError::new(ErrorCode::NotFound, format!("no source “{id}”")))
        }
        other => Err(HostError::new(
            ErrorCode::Unsupported,
            format!("Connect doesn't share “{other}” (people, sources, source, clients, dictionary, threads)"),
        )),
    }
}

fn sources(s: &Services) -> Result<Vec<Record>, HostError> {
    s.core()?
        .plugin_sources()
        .map_err(|e| HostError::new(ErrorCode::PluginError, e.message))
}

fn kind_of(r: &Record) -> &'static str {
    match (r.kind.as_str(), r.data["channel"].as_str()) {
        ("event", _) => "meeting",
        (_, Some("chat")) => "channel",
        _ => "mail",
    }
}

/// When it happened: a message's time, a meeting's start (unix seconds).
fn when(r: &Record) -> i64 {
    match r.kind.as_str() {
        "event" => r.data["start"]
            .as_str()
            .map(crate::workspace::graph::timestamp)
            .unwrap_or(0),
        _ => r.data["at"].as_i64().unwrap_or(r.updated_at),
    }
}

fn date(at: i64) -> String {
    chrono::DateTime::from_timestamp(at, 0)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn list(records: &[Record], opts: &Value) -> Value {
    let kind = opts["kind"].as_str().unwrap_or("");
    let since = opts["since"].as_str().unwrap_or("");
    let limit = opts["limit"].as_u64().unwrap_or(200).clamp(1, 1000) as usize;
    // Connect has no threads, so a thread's sources are none.
    if opts["thread"].as_str().is_some_and(|t| !t.is_empty()) {
        return json!([]);
    }
    let mut out: Vec<(i64, Value)> = records
        .iter()
        .filter(|r| kind.is_empty() || kind_of(r) == kind)
        .map(|r| (when(r), r))
        .filter(|(at, _)| date(*at).as_str() >= since)
        .map(|(at, r)| {
            (
                at,
                json!({"id": plugin_source_id(r), "kind": kind_of(r), "title": r.data["title"],
                       "date": date(at), "threads": []}),
            )
        })
        .collect();
    out.sort_by_key(|o| std::cmp::Reverse(o.0));
    json!(out
        .into_iter()
        .take(limit)
        .map(|(_, v)| v)
        .collect::<Vec<_>>())
}

fn one(r: &Record) -> Value {
    let text = match r.kind.as_str() {
        "event" => r.data["preview"].clone(),
        _ => r.data["text"].clone(),
    };
    json!({
        "id": plugin_source_id(r),
        "kind": kind_of(r),
        "title": r.data["title"],
        "date": date(when(r)),
        "from": r.data["from"],
        "text": text,
        "url": r.data["url"],
        "link": null,
        "threads": [],
        "profile": null,
    })
}

/// The people of the messages and meetings, once each (by address, else name), the user left
/// out.
fn people(records: &[Record]) -> Value {
    let mut by_key: BTreeMap<String, Value> = BTreeMap::new();
    let mut add = |name: &Value, address: &Value| {
        let name = name.as_str().map(str::trim).unwrap_or("");
        let address = address.as_str().map(str::trim).unwrap_or("");
        let key = if address.is_empty() { name } else { address }.to_lowercase();
        if key.is_empty() || by_key.len() >= MAX_PEOPLE {
            return;
        }
        by_key.entry(key.clone()).or_insert_with(|| {
            json!({"key": key, "name": if name.is_empty() { address } else { name },
                   "organisation": null, "title": null, "threads": [], "link": null})
        });
    };
    for r in records {
        if r.kind == "event" {
            add(
                &r.data["organizer"]["name"],
                &r.data["organizer"]["address"],
            );
            for a in r.data["attendees"].as_array().into_iter().flatten() {
                add(&a["name"], &a["address"]);
            }
        } else if r.data["isMine"] != true {
            let address = if r.data["fromAddress"].is_string() {
                &r.data["fromAddress"]
            } else {
                &Value::Null
            };
            add(&r.data["from"], address);
        }
    }
    json!(by_key.into_values().collect::<Vec<_>>())
}

fn terms(s: &Services, id: &str) -> Vec<Value> {
    read_json(&echo_dir(s, id).join("dictionary.json"), json!([]))
        .as_array()
        .cloned()
        .unwrap_or_default()
}

/// Adds `{name, synonyms?, spellings?, kind?}` to the plugin's dictionary, merged into the term
/// any of its names already is. Answers `{term, added, new}`.
pub fn dictionary_add(s: &Services, p: &Granted, v: &Value) -> Result<Value, HostError> {
    if !p.words("echo", "write").iter().any(|w| w == "dictionary") {
        return Err(permission(format!(
            "{} didn't ask to add to your dictionary when it was installed (uses.echo.write)",
            p.id
        )));
    }
    s.writable()?;
    let clean = |x: &str| {
        let t = x.trim();
        (!t.is_empty() && t.chars().count() <= 80).then(|| t.to_string())
    };
    let name = v["name"]
        .as_str()
        .and_then(clean)
        .ok_or_else(|| bad("a term needs a name (80 characters at most)"))?;
    let words = |k: &str| -> Vec<String> {
        v[k].as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(clean)
            .take(20)
            .collect()
    };
    let (synonyms, spellings) = (words("synonyms"), words("spellings"));
    let mut all = terms(s, &p.id);
    let names = |t: &Value| -> Vec<String> {
        std::iter::once(t["name"].clone())
            .chain(t["synonyms"].as_array().cloned().unwrap_or_default())
            .filter_map(|x| x.as_str().map(str::to_lowercase))
            .collect()
    };
    let ours: Vec<String> = std::iter::once(&name)
        .chain(&synonyms)
        .map(|n| n.to_lowercase())
        .collect();
    let found = all
        .iter()
        .position(|t| names(t).iter().any(|n| ours.contains(n)));
    let (term, added, new) = match found {
        Some(i) => {
            let t = &mut all[i];
            let mut added = Vec::new();
            for (field, list) in [("synonyms", &synonyms), ("spellings", &spellings)] {
                let mut have: Vec<String> = t[field]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect();
                for w in list.iter().chain((field == "synonyms").then_some(&name)) {
                    let known = have.iter().any(|h| h.eq_ignore_ascii_case(w))
                        || t["name"]
                            .as_str()
                            .is_some_and(|n| n.eq_ignore_ascii_case(w));
                    if !known {
                        have.push(w.clone());
                        added.push(w.clone());
                    }
                }
                t[field] = json!(have);
            }
            (t.clone(), added, false)
        }
        None => {
            if all.len() >= MAX_TERMS {
                return Err(HostError::new(
                    ErrorCode::Limit,
                    format!("a plugin's dictionary keeps {MAX_TERMS} terms at most"),
                ));
            }
            let t = json!({"name": name, "synonyms": synonyms, "spellings": spellings,
                           "kind": v["kind"].as_str().and_then(clean), "group": null, "client": null});
            let added: Vec<String> = std::iter::once(name.clone())
                .chain(synonyms.clone())
                .collect();
            all.push(t.clone());
            (t, added, true)
        }
    };
    write_json(&echo_dir(s, &p.id).join("dictionary.json"), &json!(all))?;
    Ok(json!({"term": term, "added": added, "new": new}))
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::plugin_data::tests::{seed, source};
    use crate::workspace::test_core;
    use std::sync::Arc;

    #[test]
    fn echo_read_people_and_sources_map_connect_records() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), vec![]);
        seed(&core);
        let base = 1_795_000_000;
        let mut r = core.repo().unwrap();
        r.put_record(&source("m1", "message", "mail:inbox", base, json!({
            "channel": "mail", "title": "Q3 budget", "text": "Can you send it?", "from": "Ann Lee",
            "fromAddress": "ann@example.test", "isMine": false, "at": base, "url": "https://outlook/m1"}))).unwrap();
        r.put_record(&source(
            "m2",
            "message",
            "mail:sentitems",
            base + 60,
            json!({
            "channel": "mail", "title": "Re: Q3 budget", "text": "Sent.", "from": "Taylor Reed",
            "fromAddress": "taylor@example.test", "isMine": true, "at": base + 60}),
        ))
        .unwrap();
        r.put_record(&source(
            "c1",
            "message",
            "chat:19:ops",
            base + 120,
            json!({
            "channel": "chat", "title": "Ops", "text": "Deploy at 5", "from": "Sam Ortiz",
            "fromId": "u-sam", "isMine": false, "at": base + 120}),
        ))
        .unwrap();
        r.put_record(&source("e1", "event", "calendar:cal-1", base, json!({
            "title": "Planning", "start": "2026-11-19T09:00:00Z", "end": "2026-11-19T10:00:00Z",
            "preview": "Agenda: Q3", "organizer": {"name": "Ann Lee", "address": "ann@example.test"},
            "attendees": [{"name": "Bo Chen", "address": "bo@example.test"}]}))).unwrap();
        drop(r);
        let env = Env::with(Some(core), super::super::http::Client::new());
        env.plugin(
            "obsidian",
            json!({"echo": {"read": ["people", "sources", "threads", "clients", "dictionary"], "write": ["dictionary"]}}),
            json!([]),
        );
        env.plugin("narrow", json!({"echo": {"read": ["threads"]}}), json!([]));
        let read = |args: Value| env.call("obsidian", "echo.read", args).unwrap();

        let people = read(json!(["people"]));
        let names: Vec<&str> = people
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Ann Lee", "Bo Chen", "Sam Ortiz"], "{people}");
        assert_eq!(people[0]["key"], "ann@example.test");
        assert_eq!(people[0]["threads"], json!([]));

        let all = read(json!(["sources"]));
        let ids: Vec<&str> = all
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        // Newest first: the meeting (Nov 19), then the chat and the mail (Nov 18).
        assert_eq!(ids, ["event:e1", "chat:c1", "mail:m2", "mail:m1"]);
        assert_eq!(all[0]["kind"], "meeting");
        assert_eq!(all[1]["kind"], "channel");
        assert_eq!(
            read(json!(["sources", {"kind": "mail", "limit": 1}]))
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            read(json!(["sources", {"since": "2026-11-19"}]))
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(read(json!(["sources", {"thread": "t-1"}])), json!([]));
        let one = read(json!(["source", "mail:m1"]));
        assert_eq!(one["text"], "Can you send it?");
        assert_eq!(one["from"], "Ann Lee");
        assert_eq!(read(json!(["source", "event:e1"]))["text"], "Agenda: Q3");
        // Threads are always empty; clients and the dictionary are the plugin's own.
        assert_eq!(read(json!(["threads"])), json!([]));
        assert_eq!(read(json!(["clients"])), json!([]));
        let added = env
            .call(
                "obsidian",
                "echo.dictionary.add",
                json!([{"name": "Signal Grid", "synonyms": ["SG"], "kind": "product"}]),
            )
            .unwrap();
        assert_eq!(added["new"], true);
        let again = env
            .call(
                "obsidian",
                "echo.dictionary.add",
                json!([{"name": "SG", "synonyms": ["SignalGrid"], "spellings": ["signal greed"]}]),
            )
            .unwrap();
        assert_eq!(again["new"], false);
        assert_eq!(again["term"]["synonyms"], json!(["SG", "SignalGrid"]));
        assert_eq!(again["term"]["spellings"], json!(["signal greed"]));
        assert_eq!(
            read(json!(["dictionary"]))["terms"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // Only what the sheet named.
        for kind in ["people", "sources", "source", "dictionary"] {
            let e = env
                .call("narrow", "echo.read", json!([kind, "x"]))
                .unwrap_err();
            assert_eq!(e.code, ErrorCode::Permission, "{kind}");
        }
        assert_eq!(
            env.call("narrow", "echo.read", json!(["threads"])).unwrap(),
            json!([])
        );
        let e = env
            .call("narrow", "echo.dictionary.add", json!([{"name": "x"}]))
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
    }
}
