//! The own-reply sweep (design §6, ruling 15): after a Microsoft sync round that changed
//! messages, an open `reply` task whose source conversation has a newer message from the user is
//! completed, with the history line "Closed: you replied in Teams at 17:32" ("in Outlook" for
//! mail). Every other evidence only flags a task (`task_handled`); Connect never decides a task
//! is done for the user otherwise.
use super::{active_provider, sync};
use crate::workspace::models::{Record, Result};
use crate::workspace::{tasks, Core};
use serde_json::json;
use sha1::{Digest, Sha1};
use std::collections::HashMap;

/// What `keptEvidence` holds for `evidence`: the first 16 hex characters of its sha1.
pub(crate) fn evidence_hash(evidence: &str) -> String {
    Sha1::digest(evidence.as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Whether the user said "Keep open" to `evidence` on `task`.
pub(crate) fn kept(task: &serde_json::Value, evidence: &str) -> bool {
    let hash = evidence_hash(evidence);
    task["keptEvidence"]
        .as_array()
        .is_some_and(|k| k.iter().any(|h| h == hash.as_str()))
}

/// Completes each open `reply` task of the active provider the user answered themselves; returns
/// how many it closed. A task already closed once by the same reply (and reopened by the user),
/// or kept open against it, is left alone.
pub(crate) fn sweep(core: &Core, now: i64) -> Result<usize> {
    // Same order as the other task writers: the meeting-folder lock, then the repository.
    let _folders = core.meeting_lock();
    let mut r = core.repo()?;
    let s = r.settings()?;
    let Some(cid) = s.active_connection.clone() else {
        return Ok(0);
    };
    let zone: chrono_tz::Tz = s.time_zone.parse().unwrap_or(chrono_tz::UTC);
    let provider = active_provider(&s).to_string();
    let messages: Vec<Record> = r
        .records_of_kind("message")?
        .into_iter()
        .filter(|m| m.connection_id.as_deref() == Some(cid.as_str()) && m.data["deleted"] != true)
        .collect();
    let by_id: HashMap<&str, &Record> = messages.iter().map(|m| (m.id.as_str(), m)).collect();
    let open: Vec<Record> = r
        .records_of_kind(tasks::KIND)?
        .into_iter()
        .filter(|t| {
            tasks::provider_of(&t.data) == provider
                && t.data["kind"] == "reply"
                && tasks::is_open(&t.data)
        })
        .collect();
    let mut closed = 0;
    for t in open {
        let Some(source) = t.data["sourceId"].as_str().and_then(|id| by_id.get(id)) else {
            continue;
        };
        let Some(conversation) = source.data["conversationId"].as_str() else {
            continue;
        };
        let after = source.data["at"].as_i64().unwrap_or(0);
        let Some((reply, at)) = messages
            .iter()
            .filter(|m| m.data["conversationId"] == conversation && m.data["isMine"] == true)
            .filter_map(|m| m.data["at"].as_i64().map(|at| (m, at)))
            .filter(|(_, at)| *at > after)
            .min_by_key(|(_, at)| *at)
        else {
            continue;
        };
        let place = if reply.data["channel"] == "mail" {
            "Outlook"
        } else {
            "Teams"
        };
        let Some(time) = chrono::DateTime::from_timestamp(at, 0)
            .map(|t| t.with_timezone(&zone).format("%H:%M").to_string())
        else {
            continue;
        };
        let evidence = format!("you replied in {place} at {time}");
        if t.data["handled"]["evidence"] == evidence.as_str() || kept(&t.data, &evidence) {
            continue;
        }
        let wid = t.workspace_id.clone().unwrap_or_default();
        let saved = tasks::task_save(
            &mut r,
            &wid,
            &json!({"id": t.id, "status": "done", "log": format!("Closed: {evidence}"),
                "handled": {"evidence": evidence, "auto": true}}),
            now,
        )?;
        if saved.data["pending"] == true {
            sync::queue(&mut r, &provider, now)?;
        }
        closed += 1;
    }
    Ok(closed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::ai::tests::ready;
    use crate::workspace::models::{Connection, Record};
    use crate::workspace::{tasks, test_core};
    use serde_json::{json, Value};
    use std::sync::Arc;

    const ACCT: &str = "7f1c2a4e-0000-4000-8000-000000000001";
    /// Wed 18 Nov 2026, 12:00 UTC (14:00 in Kyiv).
    const T0: i64 = 1_795_003_200;

    fn connect(core: &Core) {
        let mut r = core.repo().unwrap();
        r.save_connection(&Connection {
            id: ACCT.into(),
            account_key: ACCT.into(),
            display_name: "Taylor Morgan".into(),
            email: "taylor@example.test".into(),
            user_id: "me-1".into(),
            generation: 1,
            policy_revision: 1,
            scopes: vec!["Chat.Read".into()],
            enabled: vec!["chats".into(), "mail".into()],
            status: "connected".into(),
            ..Default::default()
        })
        .unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some(ACCT.into());
        s.time_zone = "Europe/Kyiv".into();
        r.settings_update(&s).unwrap();
    }

    fn message(core: &Core, id: &str, conversation: &str, at: i64, mine: bool) {
        let chat = conversation.starts_with("chat:");
        core.repo()
            .unwrap()
            .put_record(&Record {
                id: id.into(),
                kind: "message".into(),
                connection_id: Some(ACCT.into()),
                workspace_id: None,
                source: if chat {
                    conversation.into()
                } else {
                    "mail:inbox".into()
                },
                revision: "r".into(),
                updated_at: at,
                data: json!({"channel": if chat { "chat" } else { "mail" },
                    "conversationId": conversation, "isMine": mine, "at": at,
                    "from": if mine { "Taylor Morgan" } else { "Olga Petrenko" }, "text": "…"}),
            })
            .unwrap();
    }

    fn body(core: &Core, id: &str) -> Value {
        core.repo()
            .unwrap()
            .record(tasks::KIND, id, None, Some("personal"))
            .unwrap()
            .data
    }

    fn history(core: &Core, id: &str) -> Vec<String> {
        body(core, id)["history"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["text"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn the_sweep_closes_only_reply_tasks_the_user_answered() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        connect(&core);
        let save = |data: Value| {
            tasks::task_save(&mut core.repo().unwrap(), "personal", &data, T0).unwrap();
        };
        save(
            json!({"id": "a", "text": "Reply to Olga about SOW section 4", "kind": "reply", "sourceId": "m1"}),
        );
        save(
            json!({"id": "b", "text": "Reply to Olga about the budget", "kind": "reply", "sourceId": "m3"}),
        );
        save(json!({"id": "c", "text": "Read Olga's SOW", "sourceId": "m1"}));
        save(
            json!({"id": "d", "text": "Answer the invoice mail", "kind": "reply", "sourceId": "mail-1"}),
        );
        message(&core, "m0", "chat:c1", T0 - 3600, true);
        message(&core, "m1", "chat:c1", T0, false);
        message(&core, "m2", "chat:c1", T0 + 32 * 60, true);
        message(&core, "m3", "chat:c2", T0, false);
        message(&core, "m4", "chat:c2", T0 + 10 * 60, false);
        message(&core, "mail-1", "conv-9", T0, false);
        message(&core, "mail-2", "conv-9", T0 + 40 * 60, true);

        assert_eq!(sweep(&core, T0 + 3600).unwrap(), 2);
        let a = body(&core, "a");
        assert_eq!(a["status"], "done");
        assert_eq!(
            history(&core, "a").last().unwrap(),
            "Closed: you replied in Teams at 14:32"
        );
        assert_eq!(
            a["handled"],
            json!({"evidence": "you replied in Teams at 14:32", "at": T0 + 3600, "auto": true})
        );
        assert_eq!(
            history(&core, "d").last().unwrap(),
            "Closed: you replied in Outlook at 14:40"
        );
        for untouched in ["b", "c"] {
            let t = body(&core, untouched);
            assert_eq!(t["status"], "todo", "{untouched}");
            assert!(t["handled"].is_null(), "{untouched}");
        }

        // A second round changes nothing, and a task reopened by the user stays open.
        let lines = history(&core, "a").len();
        tasks::task_save(
            &mut core.repo().unwrap(),
            "personal",
            &json!({"id": "a", "status": "todo"}),
            T0 + 3700,
        )
        .unwrap();
        assert_eq!(sweep(&core, T0 + 7200).unwrap(), 0);
        assert_eq!(history(&core, "a").len(), lines + 1);
        assert_eq!(body(&core, "a")["status"], "todo");
    }
}
