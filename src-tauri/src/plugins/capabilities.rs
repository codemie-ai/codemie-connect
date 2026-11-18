//! The capability catalog (DESIGN 7.1, 7.2): every `uses` key Echo defines, how far Connect
//! supports it, and the permission sheet's line for it. The sheet's words are written here, never
//! taken from the plugin, so a plugin can't describe itself kindly.
//!
//! The words a manifest supplies (hosts, kinds, commands, folder descriptions) are untrusted:
//! each is checked to a plain charset and length before it enters a line, else the sheet is
//! refused (`BadValue`). The UI must still render a line with `textContent`/escaping, never as HTML.
use super::manifest::{Manifest, ManifestError};
use serde::Serialize;
use serde_json::Value;

/// How far Connect supports a capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", content = "limit", rename_all = "snake_case")]
pub enum Support {
    Supported,
    /// Works, with the limit stated.
    Partial(&'static str),
    /// Installable with a warning; its calls fail with "unsupported" (DESIGN 7.2).
    Unsupported,
    /// The plugin can't be installed; the reason is shown on its sheet.
    Blocking(&'static str),
}

/// One line of the permission sheet.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SheetLine {
    pub key: String,
    pub text: String,
    pub support: Support,
}

/// Every key Echo defines for `uses`, with Connect's status for it.
pub const CATALOG: &[(&str, Support)] = &[
    ("knowledge", Support::Blocking("Needs Connect's Knowledge engine (coming later)")),
    ("claude", Support::Partial("Claude runs without tools in Connect")),
    ("schedule", Support::Supported),
    (
        "deliver",
        Support::Partial("Teams and mail messages wait for your review in Connect; nothing is sent on its own"),
    ),
    ("deliver_provider", Support::Supported),
    ("network", Support::Supported),
    ("channel", Support::Unsupported),
    ("brain_source", Support::Unsupported),
    ("export", Support::Unsupported),
    ("sessions", Support::Unsupported),
    ("folders", Support::Supported),
    (
        "echo",
        Support::Partial("Connect fills this from your mail, chat and calendar; thread stages, tasks and Echo's background jobs aren't provided"),
    ),
    (
        "events",
        Support::Partial("Only meeting_soon, sources_changed and shared_changed are sent"),
    ),
    ("files", Support::Unsupported),
    ("work", Support::Supported),
    ("signin", Support::Partial("Only GitHub sign-in is available")),
    ("scripts", Support::Unsupported),
    ("ai", Support::Unsupported),
    ("skills", Support::Supported),
    (
        "m365",
        Support::Partial("Connect doesn't share your mail and chats with plugins yet"),
    ),
];

pub fn support_of(key: &str) -> Option<Support> {
    CATALOG.iter().find(|(k, _)| *k == key).map(|(_, s)| *s)
}

/// The sheet for a manifest, one line per `uses` key: Blocking, Unsupported, Partial, then
/// Supported, each alphabetical. An unknown key, or a value that can't be read, refuses it all.
pub fn sheet(m: &Manifest) -> Result<Vec<SheetLine>, ManifestError> {
    let mut lines = m
        .uses
        .iter()
        .map(|(key, value)| {
            let support = support_of(key).ok_or_else(|| ManifestError::UnknownKey(key.clone()))?;
            let bad = |why: String| ManifestError::BadValue {
                key: key.clone(),
                why,
            };
            // `skills` is a plain `true` in Echo's manifests; every other key is an object.
            let plain_true = key == "skills" && value == &Value::Bool(true);
            if !(value.is_object() || plain_true) {
                return Err(bad("it must be an object".into()));
            }
            let text = describe(key, value).map_err(bad)?;
            Ok(SheetLine {
                key: key.clone(),
                text,
                support,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    // What stops an install first, then what won't work, what works with limits, what works.
    let rank = |s: &Support| match s {
        Support::Blocking(_) => 0,
        Support::Unsupported => 1,
        Support::Partial(_) => 2,
        Support::Supported => 3,
    };
    lines.sort_by(|a, b| (rank(&a.support), &a.key).cmp(&(rank(&b.support), &b.key)));
    Ok(lines)
}

/// A list of plain words from the manifest: at most `max` of them, each `ok` and not longer than
/// 40 characters unless `ok` says otherwise.
fn words(v: &Value, key: &str, max: usize, ok: fn(&str) -> bool) -> Result<Vec<String>, String> {
    let list = match v.get(key) {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(format!("\"{key}\" must be a list")),
    };
    if list.len() > max {
        return Err(format!("\"{key}\" lists more than {max}"));
    }
    list.iter()
        .map(|x| {
            x.as_str()
                .filter(|w| ok(w))
                .map(str::to_string)
                .ok_or(format!("\"{key}\" holds a value that isn't a plain word"))
        })
        .collect()
}

fn is_name(w: &str) -> bool {
    (1..=40).contains(&w.len())
        && w.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn is_kind(w: &str) -> bool {
    (1..=24).contains(&w.len())
        && w.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn is_host(w: &str) -> bool {
    w.len() <= 253
        && w.contains('.')
        && w.split('.')
            .all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-'))
        && w.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}
fn is_program(w: &str) -> bool {
    (1..=64).contains(&w.len())
        && w.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
/// Free text (a folder description, a file path): one line, no control or direction-changing
/// characters, bounded.
fn is_text(w: &str, max: usize) -> bool {
    !w.trim().is_empty()
        && w.chars().count() <= max
        && !w.chars().any(|c| {
            c.is_control()
                || matches!(c, '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
        })
}
fn is_path(w: &str) -> bool {
    is_text(w, 200)
}

fn flag(v: &Value, key: &str) -> Result<bool, String> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("\"{key}\" is true or false")),
    }
}

fn join_words(w: &[String]) -> String {
    match w {
        [] => String::new(),
        [a] => a.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn quoted(w: &[String]) -> Vec<String> {
    w.iter().map(|x| format!("\"{x}\"")).collect()
}

fn title_case(k: &str) -> String {
    let mut c = k.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

/// What Echo's `echo.read` and `echo.write` names mean, in the sheet's words.
const ECHO_READS: &[(&str, &str)] = &[
    ("clients", "the names of your clients"),
    ("threads", "your threads' names and stages"),
    ("people", "who the people in your threads are"),
    ("dictionary", "your dictionary"),
    ("sources", "your calls, mail and chat"),
    ("source", "your calls, mail and chat"),
    ("calls", "your calls' minutes and transcripts"),
    ("me", "your name and email address"),
    ("recording", "whether a call is being recorded"),
];
const ECHO_WRITES: &[(&str, &str)] = &[
    ("dictionary", "Add names to your dictionary"),
    (
        "thread_stage",
        "Change your threads' stage (not provided in Connect)",
    ),
    (
        "tasks",
        "Add and update tasks in your threads (not provided in Connect)",
    ),
];
const EVENTS: &[(&str, &str)] = &[
    ("meeting_soon", "a meeting is about to start"),
    ("call_started", "a call starts"),
    ("call_ended", "a call ends"),
    ("recording_started", "a recording starts"),
    ("recording_stopped", "a recording stops"),
    ("transcribed", "a call's transcript is ready"),
    ("minutes_written", "a call's minutes are written"),
    ("thread_synced", "a thread's work is updated"),
    ("sources_changed", "your mail, chat or calendar change"),
    ("threads_changed", "a thread is renamed, merged or deleted"),
    ("shared_changed", "a value its plugins share changes"),
];
/** Events Echo defines that Connect never sends: it doesn't record calls. */
const NOT_SENT: &[&str] = &["recording_started", "recording_stopped", "transcribed"];
/** What `m365.read` names mean. */
const M365_READS: &[(&str, &str)] = &[("mail", "your Outlook mail"), ("chats", "Teams chats")];

fn describe(key: &str, v: &Value) -> Result<String, String> {
    match key {
        "knowledge" => Ok("Read and edit your Knowledge vaults".into()),
        "claude" => Ok("Ask Claude questions on your behalf".into()),
        "schedule" => Ok("Work on its own on a schedule while Connect is open".into()),
        "deliver" => {
            let to = words(v, "to", 8, is_kind)?;
            if to.is_empty() {
                return Err(
                    "it names no way to send (teams, mail, today, or one a plugin adds)".into(),
                );
            }
            let words: Vec<String> = to
                .iter()
                .map(|t| match t.as_str() {
                    "teams" => "Teams (a message to yourself)".to_string(),
                    "today" => "your Today page".to_string(),
                    "mail" => "mail (to yourself)".to_string(),
                    k => format!("{} (through the plugin that adds it)", title_case(k)),
                })
                .collect();
            Ok(format!("Send you messages through {}", join_words(&words)))
        }
        "deliver_provider" => {
            let kinds = words(v, "kinds", 8, is_kind)?;
            if kinds.is_empty() {
                return Err("it names no way to send".into());
            }
            let words: Vec<String> = kinds.iter().map(|k| title_case(k)).collect();
            Ok(format!(
                "Add a way to send you things: {}",
                join_words(&words)
            ))
        }
        "network" => {
            let hosts = words(v, "hosts", 20, is_host)?;
            let from = words(v, "hosts_from", 8, is_name)?;
            if hosts.is_empty() && from.is_empty() {
                return Err("it names no host (hosts, hosts_from)".into());
            }
            let mut parts = vec![];
            if !hosts.is_empty() {
                parts.push(join_words(&hosts));
            }
            if !from.is_empty() {
                let s = if from.len() == 1 {
                    "setting"
                } else {
                    "settings"
                };
                parts.push(format!(
                    "the addresses you enter in its {s} {}",
                    join_words(&quoted(&from))
                ));
            }
            let mut text = format!("Connect to {}", parts.join(" and to "));
            if flag(v, "ask")? {
                text.push_str(" and fetch one web page from an address you type in Connect's box");
            }
            Ok(text)
        }
        "channel" => {
            let p = v.get("plugin").and_then(Value::as_str).unwrap_or("");
            let name = p
                .strip_suffix("@claude-plugins-official")
                .filter(|n| !n.is_empty() && n.split('-').all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase())))
                .ok_or("it must name a channel plugin of claude-plugins-official, like telegram@claude-plugins-official")?;
            let shown = name
                .split('-')
                .map(title_case)
                .collect::<Vec<_>>()
                .join(" ");
            Ok(format!("Let you reach your Claude session through {shown}"))
        }
        "brain_source" => Ok("Add a folder you pick as a source for search".into()),
        "export" => {
            let what = words(v, "what", 4, is_name)?;
            if what.is_empty() {
                return Err("it names nothing to write (minutes, people)".into());
            }
            Ok(format!(
                "Write copies of your {} into a folder you pick",
                join_words(&what)
            ))
        }
        "sessions" => {
            let mut parts = vec![];
            if flag(v, "skills")? {
                parts.push("give Claude skills of its own".to_string());
            }
            if flag(v, "read")? {
                parts.push("let Claude read the folders you give it".to_string());
            }
            if flag(v, "hints")? {
                parts.push(
                    "tell Claude what it knows about the client or thread you have open"
                        .to_string(),
                );
            }
            let commands = words(v, "commands", 20, is_name)?;
            if !commands.is_empty() {
                parts.push(format!(
                    "let Claude run its commands {} without asking",
                    join_words(&quoted(&commands))
                ));
            }
            if parts.is_empty() {
                return Err("it adds nothing (skills, read, hints, commands)".into());
            }
            let mut text = parts.join("; ");
            text[..1].make_ascii_uppercase();
            Ok(text)
        }
        "folders" => {
            let what = match v.get("what") {
                None | Some(Value::Null) => "folders",
                Some(Value::String(w)) if is_text(w, 60) => w.trim(),
                Some(_) => return Err("\"what\" is a few plain words".into()),
            };
            Ok(if flag(v, "write")? {
                format!("Read, and may write, move and delete files in the {what} you choose")
            } else {
                format!("Read files in the {what} you choose")
            })
        }
        "echo" => {
            let read = words(v, "read", 20, is_name)?;
            let write = words(v, "write", 20, is_name)?;
            let jobs = flag(v, "jobs")?;
            if read.is_empty() && write.is_empty() && !jobs {
                return Err("it asks for nothing (read, write, jobs)".into());
            }
            let mut lines = vec![];
            let mut said: Vec<String> = vec![];
            for k in &read {
                if let Some((_, w)) = ECHO_READS.iter().find(|(x, _)| x == k) {
                    if !said.iter().any(|s| s == w) {
                        said.push((*w).to_string());
                    }
                }
            }
            if !said.is_empty() {
                lines.push(format!("Read {} in Connect", join_words(&said)));
            }
            for (k, w) in ECHO_WRITES {
                if write.iter().any(|x| x == k) {
                    lines.push((*w).to_string());
                }
            }
            if jobs {
                lines.push("Show and tune background jobs (not provided in Connect)".to_string());
            }
            let unknown: Vec<String> = read
                .iter()
                .filter(|k| !ECHO_READS.iter().any(|(x, _)| x == k))
                .chain(
                    write
                        .iter()
                        .filter(|k| !ECHO_WRITES.iter().any(|(x, _)| x == k)),
                )
                .cloned()
                .collect();
            if !unknown.is_empty() {
                lines.push(format!(
                    "Ask for things Connect doesn't have: {}",
                    unknown.join(", ")
                ));
            }
            Ok(lines.join(". "))
        }
        "events" => {
            let on = words(v, "on", 20, is_name)?;
            if on.is_empty() {
                return Err("it hears nothing".into());
            }
            let sent = |k: &str| !NOT_SENT.contains(&k);
            let known: Vec<String> = EVENTS
                .iter()
                .filter(|(k, _)| sent(k) && on.iter().any(|o| o == k))
                .map(|(_, w)| (*w).to_string())
                .collect();
            let unknown: Vec<String> = on
                .iter()
                .filter(|o| !sent(o) || !EVENTS.iter().any(|(k, _)| k == o))
                .cloned()
                .collect();
            let mut lines = vec![];
            if !known.is_empty() {
                lines.push(format!("Know when {}", join_words(&known)));
            }
            if !unknown.is_empty() {
                lines.push(format!(
                    "Ask to hear about things Connect doesn't have: {}",
                    unknown.join(", ")
                ));
            }
            Ok(lines.join(". "))
        }
        "files" => {
            let files = words(v, "read", 5, is_path)?;
            if files.is_empty() {
                return Err("it names no file".into());
            }
            Ok(format!(
                "Read these files of other apps on this computer: {}",
                join_words(&quoted(&files))
            ))
        }
        "work" => Ok("Add its items to your Today page's My work".into()),
        "skills" => {
            Ok("Add a skill to your own Claude Code, only when you click and confirm".into())
        }
        "m365" => {
            let read = words(v, "read", 8, is_name)?;
            if read.is_empty() {
                return Err("it asks to read nothing (mail, chats)".into());
            }
            let known: Vec<String> = M365_READS
                .iter()
                .filter(|(k, _)| read.iter().any(|r| r == k))
                .map(|(_, w)| (*w).to_string())
                .collect();
            let unknown: Vec<String> = read
                .iter()
                .filter(|r| !M365_READS.iter().any(|(k, _)| k == r))
                .cloned()
                .collect();
            let mut lines = vec![];
            if !known.is_empty() {
                lines.push(format!("Read {}, never send", join_words(&known)));
            }
            if !unknown.is_empty() {
                lines.push(format!(
                    "Ask for things Connect doesn't have: {}",
                    unknown.join(", ")
                ));
            }
            Ok(lines.join(". "))
        }
        "signin" => {
            let hosts = words(v, "hosts", 4, is_host)?;
            if hosts.is_empty() {
                return Err("it names no host".into());
            }
            let mut text = format!(
                "Use the sign-in saved on this computer for {0} (GitHub CLI or git): it can act as you on {0} and send that access to the places it talks to",
                join_words(&hosts)
            );
            if flag(v, "keep")? {
                text.push_str("; it may sign you in itself and keep that sign-in");
            }
            Ok(text)
        }
        "scripts" => Ok("Run programs from its package on this computer with your rights".into()),
        "ai" => {
            let command = v
                .pointer("/wrapper/command")
                .and_then(Value::as_str)
                .filter(|c| is_program(c))
                .ok_or("it offers no wrapper command that is one plain program name")?;
            Ok(format!(
                "Offer an AI profile that starts {command}, a program you install yourself: it sees and can change everything sent to Claude"
            ))
        }
        _ => unreachable!("support_of vets the key"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::{parse_manifest, MANIFEST_FILE};
    use serde_json::json;

    fn manifest_with(uses: Value) -> Manifest {
        let d = tempfile::tempdir().unwrap();
        let j = json!({"id": "hello", "name": "Hello", "version": "1.0.0", "uses": uses});
        std::fs::write(d.path().join(MANIFEST_FILE), j.to_string()).unwrap();
        parse_manifest(d.path()).unwrap()
    }

    #[test]
    fn sheet_marks_partial_unsupported_and_blocking() {
        let m = manifest_with(json!({
            "network": {"hosts": ["api.github.com", "github.com"]},
            "claude": {},
            "sessions": {"hints": true},
            "knowledge": {},
            "folders": {"write": true},
        }));
        let lines = sheet(&m).unwrap();
        let by = |k: &str| lines.iter().find(|l| l.key == k).unwrap().clone();
        assert_eq!(by("network").support, Support::Supported);
        assert_eq!(
            by("network").text,
            "Connect to api.github.com and github.com"
        );
        assert_eq!(
            by("claude").support,
            Support::Partial("Claude runs without tools in Connect")
        );
        assert_eq!(by("sessions").support, Support::Unsupported);
        assert_eq!(
            by("knowledge").support,
            Support::Blocking("Needs Connect's Knowledge engine (coming later)")
        );
        assert_eq!(
            by("folders").text,
            "Read, and may write, move and delete files in the folders you choose"
        );
        // Blocking, Unsupported, Partial, Supported.
        let keys: Vec<&str> = lines.iter().map(|l| l.key.as_str()).collect();
        assert_eq!(
            keys,
            ["knowledge", "sessions", "claude", "folders", "network"]
        );

        let e = sheet(&manifest_with(
            json!({"network": {"hosts": ["a.example.com"]}, "teleport": {}}),
        ))
        .unwrap_err();
        assert_eq!(e.to_string(), "needs teleport, which Connect doesn't know");
        assert!(matches!(
            sheet(&manifest_with(json!({"network": {}}))),
            Err(ManifestError::BadValue { .. })
        ));
    }

    #[test]
    fn every_key_echo_defines_has_a_status_and_a_line() {
        let samples = json!({
            "knowledge": {}, "claude": {"skip": true}, "schedule": {},
            "deliver": {"to": ["teams", "mail", "today", "telegram"]},
            "deliver_provider": {"kinds": ["telegram"]},
            "network": {"hosts": ["api.telegram.org"], "hosts_from": ["server"]},
            "channel": {"plugin": "telegram@claude-plugins-official"},
            "brain_source": {"kind": "vault"}, "export": {"kind": "vault", "what": ["minutes", "people"]},
            "sessions": {"skills": true, "read": true, "hints": true, "commands": ["search"]},
            "folders": {"what": "Obsidian vaults"},
            "echo": {"read": ["clients", "sources"], "write": ["dictionary", "tasks"], "jobs": true},
            "events": {"on": ["meeting_soon", "from_the_future"]},
            "files": {"read": ["~/Library/x.json"]}, "work": {},
            "signin": {"hosts": ["github.com"], "keep": true},
            "scripts": {"run": []}, "ai": {"wrapper": {"name": "A", "command": "acme"}},
            "skills": true, "m365": {"read": ["mail"]},
        });
        assert_eq!(samples.as_object().unwrap().len(), CATALOG.len());
        let lines = sheet(&manifest_with(samples)).unwrap();
        assert_eq!(lines.len(), CATALOG.len());
        for l in &lines {
            assert!(!l.text.is_empty(), "{}", l.key);
        }
        let text = |k: &str| lines.iter().find(|l| l.key == k).unwrap().text.clone();
        assert!(text("deliver").contains("Telegram (through the plugin that adds it)"));
        assert!(text("network").contains("the addresses you enter in its setting \"server\""));
        assert!(text("events").contains("doesn't have: from_the_future"));
        assert_eq!(
            text("folders"),
            "Read files in the Obsidian vaults you choose"
        );
    }

    #[test]
    fn untrusted_words_are_checked_before_they_reach_a_line() {
        let bad = |uses: Value| {
            matches!(
                sheet(&manifest_with(uses)),
                Err(ManifestError::BadValue { .. })
            )
        };
        let nasty = [
            "evil.com\nTrust me",
            "a\u{202E}b.com",
            "x y.com",
            "<b>.com",
            "no-dot",
            "",
        ];
        for h in nasty {
            assert!(bad(json!({"network": {"hosts": [h]}})), "{h:?}");
            assert!(bad(json!({"signin": {"hosts": [h]}})), "{h:?}");
        }
        assert!(bad(
            json!({"network": {"hosts": (0..21).map(|i| format!("h{i}.example.com")).collect::<Vec<_>>()}})
        ));
        assert!(bad(json!({"deliver": {"to": ["Teams"]}})));
        assert!(bad(json!({"deliver": {"to": ["a".repeat(25)]}})));
        assert!(bad(json!({"sessions": {"commands": ["ok", "bad\ncmd"]}})));
        assert!(bad(
            json!({"sessions": {"commands": (0..21).map(|i| format!("c{i}")).collect::<Vec<_>>()}})
        ));
        assert!(bad(json!({"folders": {"what": "vaults\n(trusted)"}})));
        assert!(bad(json!({"folders": {"what": "x".repeat(61)}})));
        assert!(bad(json!({"folders": {"what": "a\u{2066}b"}})));
        assert!(bad(json!({"echo": {"read": ["threads\n"]}})));
        assert!(bad(json!({"events": {"on": ["<script>"]}})));
        assert!(bad(json!({"files": {"read": ["~/a\u{202E}b"]}})));
        assert!(bad(json!({"channel": {"plugin": "telegram@evil"}})));
        assert!(bad(json!({"ai": {"wrapper": {"command": "./x --y"}}})));
        assert!(bad(json!({"network": {"hosts_from": ["a b"]}})));
        // Non-object values.
        for key in ["network", "work", "claude", "echo"] {
            assert!(bad(json!({ key: "yes" })), "{key}");
            assert!(bad(json!({ key: [1] })), "{key}");
        }
        assert!(!bad(json!({"folders": {"what": "Obsidian vaults"}})));
    }

    /// Knowledge 1.0.1's `uses`, as published.
    fn knowledge_uses() -> Value {
        json!({
            "folders": {"what": "folders of notes (Knowledge vaults)", "write": true},
            "claude": {},
            "echo": {"read": ["clients", "threads", "source", "sources", "calls", "me", "recording", "dictionary"]},
            "network": {"hosts_from": ["web_sites"], "ask": true},
            "skills": true,
            "sessions": {"skills": true, "read": true, "hints": true, "commands": ["search", "info"]},
            "events": {"on": ["minutes_written", "sources_changed", "recording_started", "recording_stopped", "transcribed"]},
            "m365": {"read": ["mail", "chats"]},
        })
    }

    #[test]
    fn knowledge_sheet_is_honest() {
        let lines = sheet(&manifest_with(knowledge_uses())).unwrap();
        let by = |k: &str| lines.iter().find(|l| l.key == k).unwrap().clone();
        assert!(lines
            .iter()
            .all(|l| !matches!(l.support, Support::Blocking(_))));
        assert_eq!(by("skills").support, Support::Supported);
        assert_eq!(
            by("skills").text,
            "Add a skill to your own Claude Code, only when you click and confirm"
        );
        assert!(matches!(by("m365").support, Support::Partial(_)));
        assert_eq!(
            by("m365").text,
            "Read your Outlook mail and Teams chats, never send"
        );
        assert_eq!(
            by("network").text,
            "Connect to the addresses you enter in its setting \"web_sites\" and fetch one web \
             page from an address you type in Connect's box"
        );
        let echo = by("echo").text;
        assert!(echo.contains("your name and email address"), "{echo}");
        assert!(
            echo.contains("your calls' minutes and transcripts"),
            "{echo}"
        );
        assert!(!echo.contains("doesn't have"), "{echo}");
        assert_eq!(
            by("events").text,
            "Know when a call's minutes are written and your mail, chat or calendar change. Ask \
             to hear about things Connect doesn't have: recording_started, recording_stopped, \
             transcribed"
        );
        assert_eq!(by("sessions").support, Support::Unsupported);
        // `skills` is `true` or an object; anything else can't be read.
        for bad in [json!("yes"), json!(1), json!(false)] {
            assert!(
                matches!(
                    sheet(&manifest_with(json!({ "skills": bad }))),
                    Err(ManifestError::BadValue { .. })
                ),
                "{bad}"
            );
        }
        assert!(sheet(&manifest_with(json!({"skills": {}}))).is_ok());
        // An m365 kind Connect doesn't read is named.
        let lines = sheet(&manifest_with(json!({"m365": {"read": ["mail", "files"]}}))).unwrap();
        assert_eq!(
            lines[0].text,
            "Read your Outlook mail, never send. Ask for things Connect doesn't have: files"
        );
    }

    #[test]
    fn the_sheet_states_what_a_capability_can_do_and_what_connect_lacks() {
        let m = manifest_with(json!({
            "signin": {"hosts": ["github.com"]},
            "folders": {"write": true},
            "ai": {"wrapper": {"name": "A", "command": "acme"}},
            "echo": {"write": ["dictionary", "thread_stage", "tasks"]},
        }));
        let lines = sheet(&m).unwrap();
        let text = |k: &str| lines.iter().find(|l| l.key == k).unwrap().text.clone();
        assert!(text("signin")
            .contains("act as you on github.com and send that access to the places it talks to"));
        assert!(text("folders").contains("write, move and delete files"));
        assert!(text("ai").contains("sees and can change everything sent to Claude"));
        let echo = text("echo");
        assert!(echo.contains("Add names to your dictionary."));
        assert!(
            echo.contains("stage (not provided in Connect)")
                && echo.contains("threads (not provided in Connect)")
        );
        assert!(matches!(support_of("echo"), Some(Support::Partial(l)) if l.contains("tasks")));
    }
}
