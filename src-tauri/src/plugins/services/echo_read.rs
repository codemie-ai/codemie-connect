//! `ctx.echo.read(kind, opts)` and `ctx.echo.dictionary.add(term)` (PLUGIN-ENGINE.md §4.5): the
//! user's data, for the kinds the sheet named (`uses.echo.read`; `source` and `sources` are the
//! same grant). Connect fills them from what the active workspace shows:
//! - `people`: who wrote the messages and who was in the meetings;
//! - `sources` (`{kind, since, thread, limit}`, newest first): mail (`mail`), Teams chats
//!   (`channel`) and meetings (`meeting`), ids `mail:<id>`, `chat:<id>`, `event:<id>`;
//! - `source(id)`: one of them with its text;
//! - `threads`: `[]` (Connect has none);
//! - `calls` (`{q, since, until, limit}`): the meetings with a saved folder, as Echo's calls, and
//!   `source('call:<folder or stamp>', {transcript, chat})` one with its minutes
//!   (`workspace::plugin_calls`);
//! - `me`: the signed-in Microsoft account's `{name, email}` (`null`s when no one is);
//! - `recording`: always `{state: 'idle'}` (Connect doesn't record calls);
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
        "calls" => s
            .core()?
            .plugin_calls(at(args, 1))
            .map_err(|e| HostError::new(ErrorCode::PluginError, e.message)),
        "me" => {
            let me = s.core().ok().and_then(|c| c.plugin_me());
            Ok(match me {
                Some((name, email)) => json!({"name": name, "email": email}),
                None => json!({"name": null, "email": null}),
            })
        }
        "recording" => Ok(json!({"state": "idle", "call": null, "stamp": null})),
        "clients" => Ok(read_json(&echo_dir(s, &p.id).join("clients.json"), json!([]))),
        "dictionary" => {
            // The meetings glossary's names, then those the plugin added (`dictionary.add`).
            let mut all = s.core().map(|c| c.plugin_glossary_terms()).unwrap_or_default();
            for t in terms(s, &p.id) {
                if !all.iter().any(|x| x["name"] == t["name"]) {
                    all.push(t);
                }
            }
            Ok(json!({"terms": all}))
        }
        "people" => Ok(people(&sources(s)?)),
        "sources" => Ok(list(&sources(s)?, at(args, 1))),
        "source" if text(args, 1, "a source's id")?.starts_with("call:") => {
            let id = text(args, 1, "a source's id")?;
            s.core()?.plugin_call_source(id, at(args, 2)).map_err(|e| {
                let code = if e.code == "not_found" { ErrorCode::NotFound } else { ErrorCode::PluginError };
                HostError::new(code, e.message)
            })
        }
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
            format!("Connect doesn't share “{other}” (people, sources, source, clients, dictionary, threads, calls, me, recording)"),
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
        // Echo 0.10's calls (none until meetings are shared), me and recording (never).
        env.plugin(
            "knowledge",
            json!({"echo": {"read": ["calls", "me", "recording"]}}),
            json!([]),
        );
        let k = |kind: &str| env.call("knowledge", "echo.read", json!([kind])).unwrap();
        assert_eq!(k("calls"), json!([]));
        assert_eq!(
            k("me"),
            json!({"name": "Taylor Reed", "email": "taylor@example.test"})
        );
        assert_eq!(
            k("recording"),
            json!({"state": "idle", "call": null, "stamp": null})
        );
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

#[cfg(test)]
mod meetings_tests {
    use super::super::testing::Env;
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::plugin_data::tests::{seed, source};
    use crate::workspace::test_core;
    use std::sync::Arc;

    /// A core with a meeting saved into a folder (notes, transcript, tasks), its calendar event,
    /// a mail thread and a Teams chat; Knowledge's grants on it.
    fn world() -> (tempfile::TempDir, Env) {
        let dir = tempfile::Builder::new()
            .prefix("connect-")
            .tempdir()
            .unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), vec![]);
        seed(&core);
        let folder = dir.path().join("Meetings/2026-11-18_093000-atlas-sync");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("notes.md"), "# Atlas sync\n\n## Summary\n\nThe beta ships in May.\n\n## Decisions\n\n- Ship in May\n").unwrap();
        std::fs::write(folder.join("transcript.md"), "**Ann:** We ship in May.\n").unwrap();
        std::fs::write(folder.join("tasks.json"), r#"[{"id":"t1","task":"Draft the plan","owner":"Ann Lee","due":"2026-11-25","status":"open"}]"#).unwrap();
        let empty = dir.path().join("Meetings/2026-11-19_100000-pricing");
        std::fs::create_dir_all(&empty).unwrap();
        let base = 1_795_000_000;
        let mut r = core.repo().unwrap();
        r.put_record(&source("ev1", "event", "calendar:cal-1", base, json!({
            "title": "Atlas sync", "start": "2026-11-18T09:30:00Z", "end": "2026-11-18T10:15:00Z",
            "organizer": {"name": "Ann Lee", "address": "ann@example.test"},
            "attendees": [{"name": "Bo Chen", "address": "bo@example.test"}, {"name": "Ann Lee", "address": "ann@example.test"}]}))).unwrap();
        r.put_record(&source(
            "ev1",
            "meeting",
            "calendar:cal-1",
            base,
            json!({
            "title": "Atlas sync", "start": "2026-11-18T09:30:00Z", "end": "2026-11-18T10:15:00Z",
            "folder": folder.display().to_string(), "state": "ready", "main": "meeting-notes"}),
        ))
        .unwrap();
        r.put_record(&source(
            "ev2",
            "meeting",
            "calendar:cal-1",
            base + 90_000,
            json!({
            "title": "Pricing", "start": "2026-11-19T10:00:00Z", "end": "2026-11-19T10:30:00Z",
            "folder": empty.display().to_string(), "state": "downloaded"}),
        ))
        .unwrap();
        for (id, at, text, from, mine) in [
            ("m1", base, "Can you send the Atlas plan?", "Ann Lee", false),
            (
                "m2",
                base + 60,
                "Here is the Atlas plan.",
                "Taylor Reed",
                true,
            ),
        ] {
            r.put_record(&source(id, "message", "mail:inbox", at, json!({
                "channel": "mail", "title": "Atlas plan", "text": text, "from": from,
                "fromAddress": format!("{}@example.test", from.split(' ').next().unwrap().to_lowercase()),
                "to": [{"emailAddress": {"name": "Bo Chen", "address": "bo@example.test"}}],
                "isMine": mine, "at": at, "conversationId": "conv-1", "providerId": format!("g-{id}"),
                "url": format!("https://outlook/{id}")}))).unwrap();
        }
        r.put_record(&source(
            "c1",
            "message",
            "chat:19:ops",
            base + 120,
            json!({
            "channel": "chat", "title": "Ops", "chatId": "19:ops", "text": "Atlas deploy at 5",
            "from": "Sam Ortiz", "isMine": false, "at": base + 120, "url": "https://teams/c1"}),
        ))
        .unwrap();
        drop(r);
        let env = Env::with(Some(core), super::super::http::Client::new());
        env.plugin(
            "obsidian",
            json!({"echo": {"read": ["calls", "source", "dictionary"]}, "m365": {"read": ["mail", "chats"]}}),
            json!([]),
        );
        (dir, env)
    }

    #[test]
    fn meetings_with_a_folder_are_echos_calls() {
        let (_d, env) = world();
        let read = |args: Value| env.call("obsidian", "echo.read", args);
        let calls = read(json!(["calls", {}])).unwrap();
        let ids: Vec<&str> = calls
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            [
                "call:2026-11-19_100000-pricing",
                "call:2026-11-18_093000-atlas-sync"
            ]
        );
        let atlas = &calls[1];
        assert_eq!(atlas["stamp"], "2026-11-18_093000");
        assert_eq!(atlas["title"], "Atlas sync");
        assert_eq!(atlas["started_at"], "2026-11-18T09:30:00Z");
        assert_eq!(atlas["duration_min"], 45);
        assert_eq!(atlas["app"], "teams");
        assert_eq!(atlas["minutes"], true);
        assert_eq!(atlas["transcript"], true);
        assert_eq!(atlas["people"], json!(["Ann Lee", "Bo Chen"]));
        assert_eq!(atlas["threads"], json!([]));
        assert_eq!(calls[0]["minutes"], false);
        assert_eq!(
            read(json!(["calls", {"q": "atlas bo"}]))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            read(json!(["calls", {"since": "2026-11-19"}]))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            read(json!(["calls", {"until": "2026-11-18", "limit": 1}])).unwrap()[0]["title"],
            "Atlas sync"
        );

        // A call's source: its minutes from the main notes and tasks.json, its transcript.
        let src = read(json!(["source", "call:2026-11-18_093000", {"chat": false}])).unwrap();
        assert_eq!(
            src["id"], "call:2026-11-18_093000-atlas-sync",
            "read by its stamp"
        );
        assert_eq!(src["link"], "echo://call/2026-11-18_093000-atlas-sync");
        assert!(src["text"].as_str().unwrap().starts_with("# Atlas sync"));
        assert_eq!(src["minutes"]["summary"], "The beta ships in May.");
        assert_eq!(src["minutes"]["decisions"], json!(["Ship in May"]));
        assert_eq!(
            src["minutes"]["actions"],
            json!([{"id": "t1", "text": "Draft the plan", "owner": "Ann Lee", "due": "2026-11-25", "done": false}])
        );
        assert_eq!(src["minutes"]["revision"].as_str().unwrap().len(), 16);
        assert_eq!(src["transcript"], "**Ann:** We ship in May.\n");
        assert!(src.get("chat").is_none());
        let none = read(json!(["source", "call:2026-11-19_100000-pricing"])).unwrap_err();
        assert_eq!(none.message, "Pricing: no minutes yet");
        assert_eq!(
            read(json!(["source", "call:nope"])).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn the_glossary_is_the_dictionary() {
        let (d, env) = world();
        // The meetings root's glossary (`~/CodeMie Connect/Meetings` by default): its own here.
        let core = env.services.core().unwrap().clone();
        let mut r = core.repo().unwrap();
        let mut s = r.settings().unwrap();
        s.meetings.root = Some(d.path().join("Meetings").display().to_string());
        r.settings_update(&s).unwrap();
        drop(r);
        std::fs::write(
            d.path().join("Meetings/glossary.md"),
            "# Glossary\n\n## Products and tools\n- **LiteLLM** — the gateway; heard as “light LLM”\n\n## People\n- **Ann Lee** — design lead\n",
        )
        .unwrap();
        let terms = env
            .call("obsidian", "echo.read", json!(["dictionary"]))
            .unwrap()["terms"]
            .clone();
        let names: Vec<&str> = terms
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(
            names.contains(&"LiteLLM") && names.contains(&"Ann Lee"),
            "{terms}"
        );
        let ann = terms
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "Ann Lee")
            .unwrap();
        assert_eq!(ann["kind"], "person");
        let lite = terms
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "LiteLLM")
            .unwrap();
        assert_eq!(lite["kind"], "term");
        assert!(
            lite["spellings"].to_string().contains("light LLM"),
            "{lite}"
        );
    }

    #[tokio::test]
    async fn mail_and_chats_are_read_from_what_connect_synced() {
        let (_d, env) = world();
        async fn call(env: &Env, name: &str, args: Value) -> Result<Value, HostError> {
            env.call_async("obsidian", name, args).await
        }
        let found = call(&env, "m365.search", json!(["atlas", {"days": 3650}]))
            .await
            .unwrap();
        let results = found["results"].as_array().unwrap();
        assert_eq!(results.len(), 2, "{found}");
        assert_eq!(
            results.iter().filter(|r| r["kind"] == "mail").count(),
            1,
            "one per conversation"
        );
        let mail = results.iter().find(|r| r["kind"] == "mail").unwrap();
        assert_eq!(mail["id"], "g-m2", "the newest message's Graph id");
        let chat = results.iter().find(|r| r["kind"] == "chats").unwrap();
        assert_eq!(chat["chat"], "19:ops");
        assert_eq!(chat["channel"], Value::Null);
        assert_eq!(
            call(&env, "m365.search", json!(["", {}])).await.unwrap()["results"],
            json!([])
        );
        // The thread, oldest first; offline here, so each message's synced preview stands in.
        let thread = call(&env, "m365.mailThread", json!(["g-m2"]))
            .await
            .unwrap();
        assert_eq!(thread["picked"], "g-m2");
        let texts: Vec<&str> = thread["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["text"].as_str().unwrap())
            .collect();
        assert_eq!(
            texts,
            ["Can you send the Atlas plan?", "Here is the Atlas plan."]
        );
        assert_eq!(thread["messages"][0]["from"]["name"], "Ann Lee");
        let teams = call(
            &env,
            "m365.chat",
            json!(["19:ops", {"since": "2026-11-01", "until": "2026-11-30"}]),
        )
        .await
        .unwrap();
        assert_eq!(teams["messages"][0]["text"], "Atlas deploy at 5");
        assert_eq!(teams["topic"], "Ops");
        // Signed out: Echo's words.
        let core = env.services.core().unwrap().clone();
        {
            let mut r = core.repo().unwrap();
            let mut c = r
                .connection(crate::workspace::plugin_data::tests::ACCT)
                .unwrap();
            c.status = "needs_login".into();
            r.save_connection(&c).unwrap();
        }
        let e = call(&env, "m365.search", json!(["atlas"]))
            .await
            .unwrap_err();
        assert!(e.message.contains("Microsoft 365 isn't connected"), "{e}");
        // A kind the sheet didn't name.
        env.plugin("mailonly", json!({"m365": {"read": ["mail"]}}), json!([]));
        let e = env
            .call_async("mailonly", "m365.chat", json!(["19:ops"]))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
    }
}
