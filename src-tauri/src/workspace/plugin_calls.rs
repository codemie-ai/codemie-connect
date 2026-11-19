//! Connect's meetings as Echo's calls, for plugins (`echo.read('calls' | 'source' | 'dictionary')`
//! and the `minutes_written` / `transcribed` events, Echo 0.10's plugin API). Read-only, over the
//! meetings the active workspace shows: a meeting with a saved folder is a call, named by its
//! folder (`call:<folder>`), its stamp the `YYYY-MM-DD_HHMMSS` its folder's name starts with (Echo's
//! folder pattern), else the folder's name. Its minutes are the main notes document (`notes.md`),
//! its action items the folder's `tasks.json`, its transcript `transcript.md`. Nothing in
//! `meetings/` changes for it; the notes run and the transcript save only tell plugins.
use super::meetings::glossary;
use super::models::*;
use super::Core;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const LIST_DEFAULT: usize = 50;
const LIST_MAX: usize = 500;
const PARTICIPANTS_MAX: usize = 50;
const MINUTES_ITEMS: usize = 50;
const MINUTES_ITEM_CHARS: usize = 500;
const TRANSCRIPT_MAX: u64 = 4 << 20;

/// One meeting that is a call.
struct Call {
    /// Its folder.
    dir: PathBuf,
    /// The folder's name: the call's id after `call:`.
    folder: String,
    stamp: String,
    title: String,
    start: Option<chrono::DateTime<chrono::Utc>>,
    end: Option<chrono::DateTime<chrono::Utc>>,
    people: Vec<(String, String)>,
}

/// Echo's stamp of a call: the `YYYY-MM-DD_HHMMSS` its folder's name starts with, else the name.
fn stamp_of(folder: &str) -> String {
    let b = folder.as_bytes();
    let stamped = b.len() >= 17
        && b[..17].iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'_',
            _ => c.is_ascii_digit(),
        });
    if stamped {
        folder[..17].to_string()
    } else {
        folder.to_string()
    }
}

fn time(v: &Value) -> Option<chrono::DateTime<chrono::Utc>> {
    v.as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&chrono::Utc))
}

fn iso(t: Option<chrono::DateTime<chrono::Utc>>) -> Value {
    t.map_or(Value::Null, |t| {
        json!(t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    })
}

/// The minutes Echo's readers take from a call's notes: the summary, the decisions and the open
/// questions by their headings (English, Ukrainian, Russian), the body from the first `## `.
fn minutes_of(text: &str) -> (String, Vec<String>, Vec<String>, String) {
    const SUMMARY: [&str; 5] = ["summary", "підсум", "резюм", "итог", "сводк"];
    const DECISIONS: [&str; 4] = ["decision", "рішен", "решени", "решено"];
    const QUESTIONS: [&str; 3] = ["question", "питан", "вопрос"];
    let mut summary = String::new();
    let (mut decisions, mut questions) = (Vec::new(), Vec::new());
    let mut under: Option<&str> = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(h) = t.strip_prefix('#') {
            let h = h.trim_start_matches('#').trim().to_lowercase();
            under = if SUMMARY.iter().any(|w| h.contains(w)) {
                Some("summary")
            } else if DECISIONS.iter().any(|w| h.contains(w)) {
                Some("decisions")
            } else if QUESTIONS.iter().any(|w| h.contains(w)) {
                Some("questions")
            } else {
                None
            };
            continue;
        }
        let bullet = t
            .strip_prefix("- ")
            .or_else(|| t.strip_prefix("* "))
            .map(|b| {
                b.trim_start_matches("[ ] ")
                    .trim_start_matches("[x] ")
                    .trim()
            });
        match (under, bullet) {
            (Some("summary"), _) if !t.is_empty() => {
                if !summary.is_empty() {
                    summary.push('\n');
                }
                summary.push_str(t);
            }
            (Some("decisions"), Some(b)) if decisions.len() < MINUTES_ITEMS => {
                decisions.push(b.chars().take(MINUTES_ITEM_CHARS).collect())
            }
            (Some("questions"), Some(b)) if questions.len() < MINUTES_ITEMS => {
                questions.push(b.chars().take(MINUTES_ITEM_CHARS).collect())
            }
            _ => {}
        }
    }
    let body = text
        .find("\n## ")
        .map(|i| text[i + 1..].to_string())
        .or_else(|| text.starts_with("## ").then(|| text.to_string()))
        .unwrap_or_else(|| text.to_string());
    (summary, decisions, questions, body)
}

/// The action items of a call as Echo keeps them (`tasks.json`, Echo's `actions.json` shape).
fn actions_of(dir: &Path) -> Vec<Value> {
    let tasks = std::fs::read(dir.join("tasks.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    tasks
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|t| {
            json!({"id": t["id"], "text": t["task"], "owner": t["owner"], "due": t["due"],
                   "done": t["status"] == "done"})
        })
        .collect()
}

/// The first 16 hex characters of the sha256 of the notes: what `minutes_written` names them by.
fn revision(text: &str) -> String {
    crate::plugins::services::cas::sha_hex(text.as_bytes())[..16].to_string()
}

impl Core {
    /// The meetings the active workspace shows that have a saved folder, newest first.
    fn plugin_call_list(&self) -> Result<Vec<Call>> {
        let records = self.repo()?.snapshot()?.records;
        let event_of = |id: &str| records.iter().find(|r| r.kind == "event" && r.id == id);
        let mut calls: Vec<Call> = records
            .iter()
            .filter(|r| r.kind == "meeting")
            .filter_map(|r| {
                let dir = PathBuf::from(r.data["folder"].as_str()?);
                if !dir.is_dir() {
                    return None;
                }
                let folder = dir.file_name()?.to_string_lossy().into_owned();
                let event = event_of(&r.id);
                let mut people: Vec<(String, String)> = Vec::new();
                if let Some(e) = event {
                    let organizer = &e.data["organizer"];
                    for p in std::iter::once(organizer)
                        .chain(e.data["attendees"].as_array().into_iter().flatten())
                    {
                        let name = p["name"].as_str().unwrap_or("").to_string();
                        let email = p["address"].as_str().unwrap_or("").to_string();
                        if (name.is_empty() && email.is_empty())
                            || people.iter().any(|(n, m)| {
                                (!email.is_empty() && m.eq_ignore_ascii_case(&email))
                                    || (email.is_empty() && *n == name)
                            })
                        {
                            continue;
                        }
                        people.push((name, email));
                    }
                }
                people.truncate(PARTICIPANTS_MAX);
                Some(Call {
                    stamp: stamp_of(&folder),
                    folder,
                    dir,
                    title: r.data["title"].as_str().unwrap_or("Meeting").to_string(),
                    start: time(&r.data["start"]),
                    end: time(&r.data["end"]),
                    people,
                })
            })
            .collect();
        calls.sort_by_key(|c| std::cmp::Reverse(c.start));
        Ok(calls)
    }

    /// The user's day of a time, in the workspace's time zone.
    fn call_day(&self, t: Option<chrono::DateTime<chrono::Utc>>) -> String {
        let zone: chrono_tz::Tz = self
            .repo()
            .ok()
            .and_then(|r| r.settings().ok())
            .and_then(|s| s.time_zone.parse().ok())
            .unwrap_or(chrono_tz::UTC);
        t.map(|t| t.with_timezone(&zone).format("%Y-%m-%d").to_string())
            .unwrap_or_default()
    }

    /// What every reader of a call gets.
    fn call_facts(&self, c: &Call) -> Value {
        let duration = match (c.start, c.end) {
            (Some(s), Some(e)) if e > s => (e - s).num_minutes(),
            _ => 0,
        };
        let participants: Vec<Value> = c
            .people
            .iter()
            .map(|(n, e)| json!({"name": n, "email": if e.is_empty() { Value::Null } else { json!(e) }, "person": null}))
            .collect();
        json!({
            "id": format!("call:{}", c.folder),
            "stamp": c.stamp,
            "title": c.title,
            "date": self.call_day(c.start),
            "started_at": iso(c.start),
            "ended_at": iso(c.end),
            "duration_min": duration,
            "app": "teams",
            "platform": "teams",
            "memo": false,
            "participants": participants,
            "threads": [],
            "client": null,
            "profile": null,
        })
    }

    /// `echo.read('calls', {q, since, until, thread, client, limit})`: newest first, with or
    /// without minutes. Connect has no threads or clients, so asking for one's calls finds none.
    pub(crate) fn plugin_calls(&self, opts: &Value) -> Result<Value> {
        let named = |k: &str| opts[k].as_str().is_some_and(|v| !v.trim().is_empty());
        if named("thread") || named("client") {
            return Ok(json!([]));
        }
        let words: Vec<String> = opts["q"]
            .as_str()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_lowercase)
            .collect();
        let since = opts["since"].as_str().unwrap_or("");
        let until = opts["until"].as_str().unwrap_or("");
        let limit = opts["limit"]
            .as_u64()
            .map_or(LIST_DEFAULT, |l| (l as usize).clamp(1, LIST_MAX));
        let mut out = Vec::new();
        for c in self.plugin_call_list()? {
            let day = self.call_day(c.start);
            if (!since.is_empty() && day.as_str() < since)
                || (!until.is_empty() && day.as_str() > until)
            {
                continue;
            }
            let hay = format!(
                "{} {} {}",
                c.title,
                c.folder,
                c.people
                    .iter()
                    .map(|(n, e)| format!("{n} {e}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
            .to_lowercase();
            if !words.iter().all(|w| hay.contains(w)) {
                continue;
            }
            let mut v = self.call_facts(&c);
            v["minutes"] = json!(c.dir.join("notes.md").is_file());
            v["transcript"] = json!(c.dir.join("transcript.md").is_file());
            v["chat"] = json!(false);
            v["people"] = json!(c
                .people
                .iter()
                .map(|(n, e)| if n.is_empty() { e.clone() } else { n.clone() })
                .collect::<Vec<_>>());
            out.push(v);
            if out.len() >= limit {
                break;
            }
        }
        Ok(json!(out))
    }

    /// `echo.read('source', 'call:<folder or stamp>', {transcript, chat})`: the call with its
    /// minutes; a call without them is `<title>: no minutes yet`.
    pub(crate) fn plugin_call_source(&self, id: &str, opts: &Value) -> Result<Value> {
        let name = id.strip_prefix("call:").unwrap_or(id);
        let calls = self.plugin_call_list()?;
        let c = calls
            .iter()
            .find(|c| c.folder == name)
            .or_else(|| calls.iter().find(|c| c.stamp == name))
            .ok_or_else(|| WorkspaceError::new("not_found", format!("no call {name}")))?;
        let text = std::fs::read_to_string(c.dir.join("notes.md")).map_err(|_| {
            WorkspaceError::new("not_found", format!("{}: no minutes yet", c.title))
        })?;
        let (summary, decisions, questions, body) = minutes_of(&text);
        let mut v = self.call_facts(c);
        v["kind"] = json!("call");
        v["text"] = json!(text);
        v["link"] = json!(format!("echo://call/{}", c.folder));
        v["attendees"] = json!(c
            .people
            .iter()
            .map(|(n, e)| json!({"name": n, "email": e}))
            .collect::<Vec<_>>());
        v["minutes"] = json!({
            "summary": summary, "decisions": decisions, "actions": actions_of(&c.dir),
            "questions": questions, "revision": revision(&text), "body": body,
        });
        if opts["transcript"] != false {
            let transcript = std::fs::File::open(c.dir.join("transcript.md"))
                .ok()
                .and_then(|f| {
                    use std::io::Read;
                    let mut s = String::new();
                    f.take(TRANSCRIPT_MAX)
                        .read_to_string(&mut s)
                        .ok()
                        .map(|_| s)
                });
            v["transcript"] = json!(transcript);
        }
        if opts["chat"] != false {
            v["chat"] = json!([]);
        }
        Ok(v)
    }

    /// `echo.read('dictionary')`: the meetings glossary's names, as Echo's dictionary terms.
    pub(crate) fn plugin_glossary_terms(&self) -> Vec<Value> {
        let Ok(settings) = self.repo().and_then(|r| r.settings()) else {
            return Vec::new();
        };
        let Ok((root, _)) = self.meetings_root(&settings.meetings) else {
            return Vec::new();
        };
        let (path, _) = glossary::text_path(&root, &settings.meetings, glossary::Text::Glossary);
        let Ok((text, _)) = glossary::read_text(path.as_deref()) else {
            return Vec::new();
        };
        let g = glossary::parse_glossary(&text);
        let spellings = |name: &str| -> Vec<String> {
            g.pairs
                .iter()
                .filter(|(_, written)| written == name)
                .map(|(heard, _)| heard.clone())
                .collect()
        };
        let mut terms: Vec<Value> = Vec::new();
        let mut add = |name: &str, kind: &str| {
            if !terms.iter().any(|t| t["name"] == name) {
                terms.push(
                    json!({"name": name, "synonyms": [], "spellings": spellings(name),
                                  "kind": kind, "group": null, "client": null}),
                );
            }
        };
        for p in &g.people {
            add(p, "person");
        }
        for t in &g.terms {
            add(t, "term");
        }
        for (_, written) in &g.pairs {
            add(written, "term");
        }
        terms
    }

    /// A notes run wrote the main document of meeting `id`: plugins hear `minutes_written`.
    pub(crate) fn tell_minutes_written(&self, id: &str, rewritten: bool) {
        if !self.heard("minutes_written") {
            return;
        }
        let Some(c) = self.call_of_meeting(id) else {
            return;
        };
        let Ok(source) = self.plugin_call_source(
            &format!("call:{}", c.folder),
            &json!({"transcript": false, "chat": false}),
        ) else {
            return;
        };
        let mut payload = self.call_facts(&c);
        payload["call"] = json!(c.folder);
        payload["link"] = json!(format!("echo://call/{}", c.folder));
        payload["revision"] = source["minutes"]["revision"].clone();
        payload["rewritten"] = json!(rewritten);
        payload["minutes"] = source["minutes"].clone();
        self.tell("minutes_written", payload);
    }

    /// Meeting `id`'s transcript was saved: plugins hear `transcribed`.
    pub(crate) fn tell_transcribed(&self, id: &str) {
        if !self.heard("transcribed") {
            return;
        }
        if let Some(c) = self.call_of_meeting(id) {
            self.tell(
                "transcribed",
                json!({"call": c.folder, "stamp": c.stamp, "ok": true}),
            );
        }
    }

    fn call_of_meeting(&self, id: &str) -> Option<Call> {
        let records = self.repo().ok()?.snapshot().ok()?.records;
        let folder = records
            .iter()
            .find(|r| r.kind == "meeting" && r.id == id)?
            .data["folder"]
            .as_str()?
            .to_string();
        self.plugin_call_list()
            .ok()?
            .into_iter()
            .find(|c| c.dir == Path::new(&folder))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_and_minutes_as_echo_reads_them() {
        assert_eq!(
            stamp_of("2026-11-18_093000-atlas-sync"),
            "2026-11-18_093000"
        );
        assert_eq!(stamp_of("Atlas sync 2026-11-18"), "Atlas sync 2026-11-18");
        let notes = "# Atlas sync\n\n18 Nov · Ann, Bo\n\n## Summary\n\nThe beta ships in May.\nPricing waits.\n\n## Decisions\n\n- Ship the beta in May\n- Keep the price\n\n## Open questions\n\n* Who writes the docs?\n\n## Next steps\n\n- [ ] Ann: draft the plan\n";
        let (summary, decisions, questions, body) = minutes_of(notes);
        assert_eq!(summary, "The beta ships in May.\nPricing waits.");
        assert_eq!(decisions, ["Ship the beta in May", "Keep the price"]);
        assert_eq!(questions, ["Who writes the docs?"]);
        assert!(body.starts_with("## Summary"), "{body}");
        let (s, d, _, _) = minutes_of("## Підсумок\n\nВсе добре.\n\n## Рішення\n\n- Так\n");
        assert_eq!((s.as_str(), d), ("Все добре.", vec!["Так".to_string()]));
        assert_eq!(revision("x").len(), 16);
    }
}
