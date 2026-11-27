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

/// An optional id or address from the plugin's arguments: missing or `null` is none; anything
/// else must be 1–320 characters of text, or the call is refused (a filter never silently
/// widens to every message).
fn filter(v: &Value, what: &str) -> Result<Option<String>> {
    if v.is_null() {
        return Ok(None);
    }
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 320)
        .map(|s| Some(s.to_string()))
        .ok_or_else(|| {
            WorkspaceError::new("validation", format!("{what} is 1-320 characters of text"))
        })
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
        let person = &args["person"];
        if !(person.is_null() || person.is_object()) {
            return Err(WorkspaceError::new(
                "validation",
                "person is {address, fromId}",
            ));
        }
        let defaults = SentFilter::default();
        let f = SentFilter {
            channel: channel.into(),
            days: args["days"].as_i64().unwrap_or(defaults.days),
            limit: args["limit"]
                .as_i64()
                .map_or(defaults.limit, |l| l.max(0) as usize),
            address: filter(&person["address"], "person.address")?,
            from_id: filter(&person["fromId"], "person.fromId")?,
            chat_id: filter(&args["chatId"], "chatId")?,
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

    /// The plugin manager (re)loaded the chosen voice provider, including its first load at
    /// startup: a `voice_refresh` is queued (reply-voice design §2). Nothing is queued with Off.
    pub(crate) fn voice_reloaded(&self) {
        #[cfg(test)]
        self.voice_reloads
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let queued = self.repo().and_then(|mut r| {
            let provider = r.settings()?.voice.provider;
            if provider == "off" {
                return Ok(false);
            }
            super::voice::refresh::queue(&mut r, &provider, now())
        });
        match queued {
            Ok(true) => self.emit("workspace:changed"),
            Ok(false) => {}
            Err(e) => log::warn!("voice: no refresh queued after a reload: {}", e.code),
        }
    }
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

    /// A short reply's preview runs on into the quoted original: other people's words and their
    /// addresses never come back as the user's.
    #[tokio::test]
    async fn sent_cuts_quoted_originals_and_addresses() {
        let (_dir, core, _graph) = fixture();
        let rcpts = json!([rcpt("Priya N.", "priya.n@example.test")]);
        let cases = [
            ("q1", "Thanks, will do.\r\nFrom: Priya N. <priya.n@example.test>\r\nSent: Monday\r\nSubject: Budget\r\nCan you send the SOW?", "Thanks, will do."),
            ("q2", "Sounds good. From: Priya N. <priya.n@example.test> Sent: Monday, 24 November To: Taylor Can you send it?", "Sounds good."),
            ("q3", "Done.\n-----Original Message-----\nPlease confirm.", "Done."),
            ("q4", "Ok, sending now.\n________________________________\nОт: Прія <priya.n@example.test>\nОтправлено: понедельник", "Ok, sending now."),
            ("q5", "Yes, Friday works. On Mon, 24 Nov 2026, Priya N. <priya.n@example.test> wrote: can we meet?", "Yes, Friday works."),
            ("q6", "Добре.\nВід: Прія\nНадіслано: понеділок\nЧи можна?", "Добре."),
            ("q7", "Write to ops@example.test or call me.", "Write to or call me."),
            ("q8", "From: Priya N. <priya.n@example.test>\nSent: Monday\nOnly the quote", ""),
        ];
        let mut r = core.repo().unwrap();
        for (i, (id, text, _)) in cases.iter().enumerate() {
            r.put_record(&mail(
                id,
                NOW - 1_000 - i as i64,
                true,
                rcpts.clone(),
                json!({"text": text}),
            ))
            .unwrap();
        }
        drop(r);
        let out = core
            .plugin_sent(&json!({"channel": "mail", "days": 1}), NOW)
            .unwrap();
        let got: Vec<&str> = out["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["at"].as_str().unwrap() <= iso(NOW - 1_000).as_str())
            .map(|m| m["text"].as_str().unwrap())
            .collect();
        let want: Vec<&str> = cases
            .iter()
            .map(|c| c.2)
            .filter(|t| !t.is_empty())
            .collect();
        assert_eq!(got, want, "the quote-only message is skipped");
        assert!(!out.to_string().contains('@'), "{out}");
    }

    #[tokio::test]
    async fn sent_filters_fail_closed() {
        let (_dir, core, _graph) = fixture();
        for args in [
            json!({"person": {"address": ""}}),
            json!({"person": {"address": 7}}),
            json!({"person": {"fromId": "  "}}),
            json!({"person": {"fromId": "x".repeat(400)}}),
            json!({"person": "priya"}),
            json!({"chatId": ""}),
            json!({"chatId": ["19:team"]}),
        ] {
            let e = core.plugin_sent(&args, NOW).unwrap_err();
            assert_eq!(e.code, "validation", "{args}");
        }
        // Null or missing reads as no filter.
        let all = core.plugin_sent(&json!({}), NOW).unwrap();
        assert_eq!(
            core.plugin_sent(&json!({"person": null, "chatId": null}), NOW)
                .unwrap(),
            all
        );
        assert_eq!(
            core.plugin_sent(
                &json!({"person": {"address": null, "fromId": "teams-priya"}}),
                NOW
            )
            .unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn sent_items_are_bounded() {
        let (_dir, core, _graph) = fixture();
        let many: Vec<Value> = (0..15)
            .map(|i| {
                rcpt(
                    &format!("Person {i} {}", "y".repeat(100)),
                    &format!("p{i}@example.test"),
                )
            })
            .collect();
        let mut r = core.repo().unwrap();
        r.put_record(&mail(
            "big",
            NOW - 1,
            true,
            json!(many),
            json!({"title": format!("Re:\u{202e} {}", "s".repeat(500))}),
        ))
        .unwrap();
        r.put_record(&chat(
            "long",
            "19:long",
            NOW,
            true,
            json!({"title": format!("Team\n{}", "t".repeat(500)), "chatType": "group"}),
        ))
        .unwrap();
        drop(r);
        let out = core.plugin_sent(&json!({"limit": 2}), NOW).unwrap();
        let (chat, mail) = (&out["messages"][0], &out["messages"][1]);
        let to = mail["to"].as_str().unwrap();
        assert_eq!(to.matches("Person ").count(), 10, "{to}");
        assert!(
            to.chars().count() <= 10 * 80 + 9 * 2,
            "{}",
            to.chars().count()
        );
        let subject = mail["subject"].as_str().unwrap();
        assert!(subject.chars().count() <= 200 && !subject.contains('\u{202e}'));
        let title = chat["to"].as_str().unwrap();
        assert!(
            title.chars().count() <= 200 && !title.contains('\n'),
            "{title}"
        );
    }
}
