//! What a plugin reads of the user's Microsoft 365 mail and Teams chats (`ctx.m365`, Echo 0.10):
//! the messages the active workspace shows (its account's synced Outlook mail and Teams chats),
//! never sent anything. A mail thread's messages are read in full from Microsoft through Connect's
//! own sign-in, as an AI draft reads them, their synced preview standing in when a read fails.
//! Signed out, each read says "Microsoft 365 isn't connected", which plugins match.
use super::ai_jobs::{body_text, mail_body_url};
use super::models::*;
use super::Core;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const SEARCH_LIMIT_MAX: usize = 50;
const CHAT_MESSAGES_MAX: usize = 400;
const THREAD_MAX: usize = 100;

fn not_connected() -> WorkspaceError {
    WorkspaceError::new(
        "needs_login",
        "Microsoft 365 isn't connected: sign in to Microsoft in Connect's Settings → Microsoft 365",
    )
}

fn iso(at: i64) -> String {
    chrono::DateTime::from_timestamp(at, 0)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

/// The words of `q`, each found (any case) in `text`.
fn matches(q: &[String], text: &str) -> bool {
    let t = text.to_lowercase();
    q.iter().all(|w| t.contains(w.as_str()))
}

impl Core {
    /// The signed-in account plugins read through, or "isn't connected".
    fn plugin_connection(&self) -> Result<Connection> {
        let r = self.repo()?;
        let id = r.settings()?.active_connection.ok_or_else(not_connected)?;
        let c = r.connection(&id).map_err(|_| not_connected())?;
        if c.status != "connected" {
            return Err(not_connected());
        }
        Ok(c)
    }

    /// The synced messages of `channel` (`mail`, `chat`) the active workspace shows.
    fn plugin_messages(&self, channel: &str) -> Result<Vec<Record>> {
        Ok(self
            .plugin_sources()?
            .into_iter()
            .filter(|r| r.kind == "message" && r.data["channel"] == channel)
            .collect())
    }

    /// The user's local day of `at`, in the workspace's time zone.
    fn plugin_day(&self, at: i64) -> String {
        let zone: chrono_tz::Tz = self
            .repo()
            .ok()
            .and_then(|r| r.settings().ok())
            .and_then(|s| s.time_zone.parse().ok())
            .unwrap_or(chrono_tz::UTC);
        chrono::DateTime::from_timestamp(at, 0)
            .map(|d| d.with_timezone(&zone).format("%Y-%m-%d").to_string())
            .unwrap_or_default()
    }

    /// `m365.search(q, {kinds, days, limit})`: mail conversations and Teams chats whose messages
    /// hold every word of `q`, newest first, `limit` of each kind.
    pub(crate) fn plugin_m365_search(
        &self,
        q: &str,
        kinds: &[String],
        days: i64,
        limit: usize,
        now: i64,
    ) -> Result<Value> {
        self.plugin_connection()?;
        let words: Vec<String> = q.split_whitespace().map(str::to_lowercase).collect();
        let limit = limit.clamp(1, SEARCH_LIMIT_MAX);
        let since = now - days.clamp(1, 365) * 86_400;
        let mut results = Vec::new();
        if words.is_empty() {
            return Ok(json!({"query": q, "results": [], "errors": null}));
        }
        for (kind, channel, key) in [
            ("mail", "mail", "conversationId"),
            ("chats", "chat", "chatId"),
        ] {
            if !kinds.iter().any(|k| k == kind) {
                continue;
            }
            // The newest message of each conversation or chat that matches.
            let mut newest: BTreeMap<String, Record> = BTreeMap::new();
            for m in self.plugin_messages(channel)? {
                let at = m.data["at"].as_i64().unwrap_or(0);
                let text = format!(
                    "{} {} {} {}",
                    m.data["title"].as_str().unwrap_or(""),
                    m.data["text"].as_str().unwrap_or(""),
                    m.data["from"].as_str().unwrap_or(""),
                    m.data["fromAddress"].as_str().unwrap_or("")
                );
                if at < since || m.data["deleted"] == true || !matches(&words, &text) {
                    continue;
                }
                let group = m.data[key].as_str().unwrap_or(&m.id).to_string();
                let newer = newest
                    .get(&group)
                    .is_none_or(|n| n.data["at"].as_i64().unwrap_or(0) < at);
                if newer {
                    newest.insert(group, m);
                }
            }
            let mut found: Vec<Record> = newest.into_values().collect();
            found.sort_by_key(|m| std::cmp::Reverse(m.data["at"].as_i64().unwrap_or(0)));
            for m in found.into_iter().take(limit) {
                let from = json!({"name": m.data["from"], "email": m.data["fromAddress"]});
                let preview: String = m.data["text"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(200)
                    .collect();
                results.push(if kind == "mail" {
                    json!({"kind": "mail", "id": m.data["providerId"].as_str().unwrap_or(&m.id),
                           "subject": m.data["title"], "from": from, "at": iso(m.data["at"].as_i64().unwrap_or(0)),
                           "summary": preview, "url": m.data["url"], "conversation_id": m.data["conversationId"]})
                } else {
                    json!({"kind": "chats", "id": m.data["chatId"], "chat": m.data["chatId"], "channel": null,
                           "topic": m.data["title"], "from": from, "at": iso(m.data["at"].as_i64().unwrap_or(0)),
                           "summary": preview, "url": m.data["url"]})
                });
            }
        }
        Ok(json!({"query": q, "results": results, "errors": null}))
    }

    /// `m365.mailThread(message)`: the conversation of a mail (by its Graph id), oldest first,
    /// each message's text read in full from Microsoft (its preview when that fails).
    pub(crate) async fn plugin_mail_thread(&self, message: &str) -> Result<Value> {
        let c = self.plugin_connection()?;
        let mail = self.plugin_messages("mail")?;
        let picked = mail
            .iter()
            .find(|m| m.data["providerId"] == message || m.id == message)
            .ok_or_else(|| {
                WorkspaceError::new(
                    "not_found",
                    "Connect has no such mail: it may be older than what it keeps",
                )
            })?;
        let conversation = picked.data["conversationId"].clone();
        let mut thread: Vec<&Record> = mail
            .iter()
            .filter(|m| {
                !conversation.is_null() && m.data["conversationId"] == conversation
                    || m.id == picked.id
            })
            .collect();
        thread.sort_by_key(|m| m.data["at"].as_i64().unwrap_or(0));
        thread.truncate(THREAD_MAX);
        let mut messages = Vec::new();
        for m in thread {
            let provider = m.data["providerId"].as_str().unwrap_or("");
            let full = if provider.is_empty() {
                None
            } else {
                self.graph_reads
                    .get(self, &c, &mail_body_url(provider))
                    .await
                    .ok()
                    .and_then(|a| body_text(&a))
            };
            let to: Vec<Value> = m.data["to"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| json!({"name": r["emailAddress"]["name"], "email": r["emailAddress"]["address"]}))
                .collect();
            let mut out = json!({
                "id": if provider.is_empty() { m.id.as_str() } else { provider },
                "subject": m.data["title"],
                "from": {"name": m.data["from"], "email": m.data["fromAddress"]},
                "to": to,
                "at": iso(m.data["at"].as_i64().unwrap_or(0)),
                "text": full.clone().unwrap_or_else(|| m.data["text"].as_str().unwrap_or("").to_string()),
                "url": m.data["url"],
                "files": [],
            });
            if m.data["hasAttachments"] == true {
                out["files_error"] = json!("Connect doesn't list a mail's attachments yet");
            }
            if full.is_none() {
                out["partial"] = json!(true);
            }
            messages.push(out);
        }
        Ok(json!({
            "subject": picked.data["title"],
            "picked": picked.data["providerId"].as_str().unwrap_or(&picked.id),
            "messages": messages,
        }))
    }

    /// `m365.chat(chat, {since, until})`: what was written in a Teams chat on those local days
    /// (both in; `until` today and `since` six days before by default), oldest first.
    pub(crate) fn plugin_chat(
        &self,
        chat: &str,
        since: Option<&str>,
        until: Option<&str>,
        now: i64,
    ) -> Result<Value> {
        self.plugin_connection()?;
        let today = self.plugin_day(now);
        let until = until
            .filter(|d| d.len() == 10)
            .map_or(today, str::to_string);
        let since = since
            .filter(|d| d.len() == 10)
            .map(str::to_string)
            .unwrap_or_else(|| self.plugin_day(now - 6 * 86_400));
        let mut msgs: Vec<Record> = self
            .plugin_messages("chat")?
            .into_iter()
            .filter(|m| m.data["chatId"] == chat && m.data["deleted"] != true)
            .filter(|m| {
                let day = self.plugin_day(m.data["at"].as_i64().unwrap_or(0));
                day >= since && day <= until
            })
            .collect();
        msgs.sort_by_key(|m| m.data["at"].as_i64().unwrap_or(0));
        msgs.truncate(CHAT_MESSAGES_MAX);
        let mut members: Vec<String> = Vec::new();
        for m in &msgs {
            if let Some(n) = m.data["from"].as_str().filter(|n| !n.is_empty()) {
                if !members.iter().any(|x| x == n) {
                    members.push(n.to_string());
                }
            }
        }
        let first = msgs.first();
        Ok(json!({
            "id": chat,
            "topic": first.map_or(Value::Null, |m| m.data["title"].clone()),
            "members": members.iter().map(|n| json!({"name": n, "email": null})).collect::<Vec<_>>(),
            "url": first.map_or(Value::Null, |m| m.data["url"].clone()),
            "since": since,
            "until": until,
            "messages": msgs.iter().map(|m| json!({
                "id": m.id, "at": iso(m.data["at"].as_i64().unwrap_or(0)), "from": m.data["from"],
                "text": m.data["text"], "files": [],
            })).collect::<Vec<_>>(),
        }))
    }
}
