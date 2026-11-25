//! What a reply-context plugin reads of the user's own sent messages (`ctx.replyContext.sent`,
//! reply-voice design §3): Connect's synced records only (`voice::sent::own_sent`), never
//! Microsoft. An item carries no record id and no address. Signed out, it says "Microsoft 365
//! isn't connected", which plugins match.
use super::models::*;
use super::voice::sent::{own_sent, SentFilter};
use super::Core;
use serde_json::{json, Value};

fn iso(at: i64) -> String {
    chrono::DateTime::from_timestamp(at, 0)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

/// A plain id or address from the plugin's arguments: trimmed, at most 320 characters, else
/// none.
fn word(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 320)
        .map(str::to_string)
}

impl Core {
    /// `ctx.replyContext.sent({channel, days, limit, person: {address, fromId}, chatId})`:
    /// `{messages: [{channel, at, text, subject, to, chatType}]}`, newest first.
    pub(crate) fn plugin_sent(&self, args: &Value, now: i64) -> Result<Value> {
        self.plugin_connection()?;
        let channel = match args["channel"].as_str() {
            None => "all",
            Some(c @ ("mail" | "chat" | "all")) => c,
            Some(_) => {
                return Err(WorkspaceError::new(
                    "validation",
                    "channel is mail, chat or all",
                ))
            }
        };
        let defaults = SentFilter::default();
        let f = SentFilter {
            channel: channel.into(),
            days: args["days"].as_i64().unwrap_or(defaults.days),
            limit: args["limit"]
                .as_i64()
                .map_or(defaults.limit, |l| l.max(0) as usize),
            address: word(&args["person"]["address"]),
            from_id: word(&args["person"]["fromId"]),
            chat_id: word(&args["chatId"]),
        };
        let items = own_sent(&*self.repo()?, &f, now)?;
        let messages: Vec<Value> = items
            .into_iter()
            .map(|m| {
                json!({"channel": m.channel, "at": iso(m.at), "text": m.text,
                       "subject": m.subject, "to": m.to, "chatType": m.chat_type})
            })
            .collect();
        Ok(json!({ "messages": messages }))
    }

    /// The plugin manager loaded the chosen voice provider again: its copy is refreshed (Task 5
    /// queues the `voice_refresh` job here).
    pub(crate) fn voice_reloaded(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::ai_jobs::FakeGraph;
    use crate::workspace::plugin_data::tests::{seed, source, ACCT};
    use std::sync::Arc;

    const NOW: i64 = 1_795_000_000;
    const DAY: i64 = 86_400;

    fn mail(id: &str, at: i64, mine: bool, to: Value, extra: Value) -> Record {
        let mut data = json!({"channel": "mail", "title": "Budget", "text": "Preview of VOICE_SENTINEL_9f3a",
                              "from": "Taylor Reed", "fromAddress": "taylor@example.test",
                              "to": to, "isMine": mine, "at": at, "conversationId": "conv-1"});
        for (k, v) in extra.as_object().into_iter().flatten() {
            data[k] = v.clone();
        }
        source(id, "message", "mail:inbox", at, data)
    }

    fn chat(id: &str, chat: &str, at: i64, mine: bool, extra: Value) -> Record {
        let mut data = json!({"channel": "chat", "title": "Priya N.", "text": "Teams text",
                              "from": "Taylor Reed", "fromId": "me-1", "chatId": chat,
                              "isMine": mine, "at": at, "conversationId": format!("chat:{chat}")});
        for (k, v) in extra.as_object().into_iter().flatten() {
            data[k] = v.clone();
        }
        source(id, "message", &format!("chat:{chat}"), at, data)
    }

    fn rcpt(name: &str, address: &str) -> Value {
        json!({"emailAddress": {"name": name, "address": address}})
    }

    /// A signed-in core with the user's mail and chats, and the Graph double it reads through.
    fn fixture() -> (tempfile::TempDir, Arc<Core>, Arc<FakeGraph>) {
        let dir = tempfile::tempdir().unwrap();
        let graph = Arc::new(FakeGraph::default());
        let core = super::super::test_core_with_graph(
            dir.path(),
            Arc::new(FakeRunner::new(vec![])),
            vec![],
            graph.clone(),
        );
        seed(&core);
        let mut r = core.repo().unwrap();
        for rec in [
            mail(
                "m1",
                NOW - 100,
                true,
                json!([rcpt("Priya N.", "priya.n@example.test")]),
                json!({"cc": [rcpt("", "ops@example.test"), rcpt("ops@example.test", "ops@example.test")]}),
            ),
            mail(
                "m2",
                NOW - 50,
                false,
                json!([rcpt("Taylor Reed", "taylor@example.test")]),
                json!({}),
            ),
            mail(
                "m3",
                NOW - 2 * DAY,
                true,
                json!([rcpt("Alex Kim", "alex@example.test")]),
                json!({"title": "Atlas"}),
            ),
            mail(
                "m4",
                NOW - 100 * DAY,
                true,
                json!([rcpt("Alex Kim", "alex@example.test")]),
                json!({}),
            ),
            mail(
                "m5",
                NOW - 60,
                true,
                json!([rcpt("Alex Kim", "alex@example.test")]),
                json!({"deleted": true}),
            ),
            chat(
                "c1",
                "19:priya",
                NOW - 10,
                true,
                json!({"chatType": "oneOnOne"}),
            ),
            chat(
                "c2",
                "19:priya",
                NOW - 5,
                false,
                json!({"chatType": "oneOnOne", "fromId": "teams-priya"}),
            ),
            chat(
                "c3",
                "19:team",
                NOW - 300,
                true,
                json!({"title": "Atlas team"}),
            ),
        ] {
            r.put_record(&rec).unwrap();
        }
        let member = |id: &str, name: &str| json!({"userId": id, "displayName": name});
        r.put_record(&Record {
            id: "chats".into(),
            kind: "catalog".into(),
            connection_id: Some(ACCT.into()),
            workspace_id: None,
            source: "catalog".into(),
            revision: "v1".into(),
            updated_at: 0,
            data: json!({"values": [
                {"id": "19:priya", "chatType": "oneOnOne",
                 "members": [member("me-1", "Taylor Reed"), member("teams-priya", "Priya N.")]},
                {"id": "19:team", "chatType": "group",
                 "members": [member("me-1", "Taylor Reed"), member("teams-priya", "Priya N."), member("teams-alex", "Alex Kim")]},
            ]}),
        })
        .unwrap();
        drop(r);
        (dir, core, graph)
    }

    fn texts(out: &Value) -> Vec<(String, String)> {
        out["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                (
                    m["channel"].as_str().unwrap().to_string(),
                    m["at"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn sent_reads_only_my_synced_messages() {
        let (_dir, core, graph) = fixture();
        let out = core.plugin_sent(&json!({}), NOW).unwrap();
        let ms = out["messages"].as_array().unwrap();
        // Only mine, not deleted, within 90 days, newest first.
        assert_eq!(
            texts(&out),
            [
                ("chat".to_string(), iso(NOW - 10)),
                ("mail".to_string(), iso(NOW - 100)),
                ("chat".to_string(), iso(NOW - 300)),
                ("mail".to_string(), iso(NOW - 2 * DAY)),
            ]
        );
        assert_eq!(
            ms[0],
            json!({"channel": "chat", "at": iso(NOW - 10), "text": "Teams text", "subject": null,
                   "to": "Priya N.", "chatType": "oneOnOne"})
        );
        // Mail: the synced preview, the recipients' names only, no chat type.
        assert_eq!(
            ms[1],
            json!({"channel": "mail", "at": iso(NOW - 100), "text": "Preview of VOICE_SENTINEL_9f3a",
                   "subject": "Budget", "to": "Priya N.", "chatType": null})
        );
        // A chat type the message lacks comes from the chats catalog.
        assert_eq!(ms[2]["chatType"], "group");
        assert_eq!(ms[2]["to"], "Atlas team");
        for m in ms {
            assert!(!m.to_string().contains('@'), "no address in {m}");
            assert!(m.get("recordId").is_none() && m.get("record_id").is_none());
        }
        // days and limit are clamped.
        let n = |args: Value| {
            core.plugin_sent(&args, NOW).unwrap()["messages"]
                .as_array()
                .unwrap()
                .len()
        };
        assert_eq!(n(json!({"limit": 0})), 1);
        assert_eq!(
            n(json!({"limit": 999, "days": 999})),
            5,
            "180 days reach m4"
        );
        assert_eq!(n(json!({"days": 0})), 3, "one day leaves m3 out");
        assert_eq!(n(json!({"channel": "mail"})), 2);
        assert_eq!(n(json!({"channel": "chat"})), 2);
        assert_eq!(
            core.plugin_sent(&json!({"channel": "sms"}), NOW)
                .unwrap_err()
                .code,
            "validation"
        );
        assert!(graph.calls().is_empty(), "{:?}", graph.calls());
    }

    #[tokio::test]
    async fn sent_filters_by_person_and_chat() {
        let (_dir, core, graph) = fixture();
        let sent = |args: Value| texts(&core.plugin_sent(&args, NOW).unwrap());
        assert_eq!(
            sent(json!({"person": {"address": "PRIYA.N@example.test"}})),
            [("mail".to_string(), iso(NOW - 100))]
        );
        // A cc'd recipient counts.
        assert_eq!(
            sent(json!({"person": {"address": "ops@example.test"}})),
            [("mail".to_string(), iso(NOW - 100))]
        );
        // The 1:1 chat with that member only, never the group chat they are in.
        assert_eq!(
            sent(json!({"person": {"fromId": "teams-priya"}})),
            [("chat".to_string(), iso(NOW - 10))]
        );
        assert_eq!(
            sent(json!({"person": {"address": "alex@example.test", "fromId": "teams-priya"}})),
            [
                ("chat".to_string(), iso(NOW - 10)),
                ("mail".to_string(), iso(NOW - 2 * DAY)),
            ]
        );
        assert!(sent(json!({"person": {"fromId": "teams-alex"}})).is_empty());
        assert_eq!(
            sent(json!({"chatId": "19:team"})),
            [("chat".to_string(), iso(NOW - 300))]
        );
        assert!(sent(json!({"chatId": "19:team", "channel": "mail"})).is_empty());
        assert!(graph.calls().is_empty());
    }

    #[tokio::test]
    async fn sent_says_isnt_connected_when_signed_out() {
        let dir = tempfile::tempdir().unwrap();
        let core = super::super::test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), vec![]);
        let e = core.plugin_sent(&json!({}), NOW).unwrap_err();
        assert!(e.message.contains("isn't connected"), "{}", e.message);
    }
}
