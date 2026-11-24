//! Menu-bar count (design `docs/superpowers/specs/2026-11-24-menu-bar-count-design.md`): the
//! settings that choose what is counted (§1), the seen marks that decide what is "new" (§2) and
//! the four counted sources (§3). Later steps add the fixes, `compute` and the tray.
use super::meetings::model::{MeAlias, MeetingRecord};
use super::models::*;
use super::repository::Repository;
use super::task_provider::active_provider;
use super::tasks;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Tasks and the seen record live in the workspace Connect boots into.
const PERSONAL: &str = "personal";
/// The bookkeeping record kind and id (design §2): unversioned, never in `snapshot.records`.
const SEEN_KIND: &str = "menu_bar_seen";
const SEEN_ID: &str = "personal";
/// How long a meeting's new notes or an automation result count as new (design §3, §5).
pub(crate) const NEW_FOR: i64 = 7 * 86_400;

fn invalid(message: &str) -> WorkspaceError {
    let mut e = WorkspaceError::new("validation", message);
    e.field = Some("menuBar".into());
    e
}

/// Settings › Notifications › "Menu bar" (design §1): which of the four sources are added up.
/// `#[serde(default)]` so settings written before this step read as the default.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuBarSettings {
    pub replies: bool,
    pub tasks: bool,
    pub meetings: bool,
    pub automations: bool,
}
impl Default for MenuBarSettings {
    fn default() -> Self {
        Self {
            replies: true,
            tasks: false,
            meetings: false,
            automations: false,
        }
    }
}
impl MenuBarSettings {
    /// Applies `settings_update {menuBar: {...}}`: only the fields given change, each one a
    /// boolean; nothing changes when one of them is refused.
    pub fn apply(&mut self, v: &Value) -> Result<()> {
        let fields = v.as_object().ok_or_else(|| invalid("Choose on or off."))?;
        let mut next = self.clone();
        for (key, value) in fields {
            let on = value
                .as_bool()
                .ok_or_else(|| invalid("Choose on or off."))?;
            match key.as_str() {
                "replies" => next.replies = on,
                "tasks" => next.tasks = on,
                "meetings" => next.meetings = on,
                "automations" => next.automations = on,
                _ => return Err(invalid("Choose on or off.")),
            }
        }
        *self = next;
        Ok(())
    }
}

/// The `menu_bar_seen` bookkeeping record (design §2): when the user last saw automation results
/// and each new meeting, and `since`, written once so nothing made before this step is new.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Seen {
    pub since: i64,
    pub automations: i64,
    pub meetings: BTreeMap<String, i64>,
}

fn save(r: &mut Repository, seen: &Seen, now: i64) -> Result<()> {
    r.put_record_unversioned(&Record {
        id: SEEN_ID.into(),
        kind: SEEN_KIND.into(),
        connection_id: None,
        workspace_id: Some(PERSONAL.into()),
        source: "local".into(),
        revision: id(),
        updated_at: now,
        data: serde_json::to_value(seen).map_err(|_| {
            WorkspaceError::new("storage", "Menu-bar seen marks could not be saved.")
        })?,
    })
}

/// The seen marks as stored; missing reads as `since: 0` (nothing has been marked seen yet).
pub(crate) fn seen(r: &Repository) -> Seen {
    r.record(SEEN_KIND, SEEN_ID, None, Some(PERSONAL))
        .ok()
        .and_then(|rec| serde_json::from_value(rec.data).ok())
        .unwrap_or_default()
}

/// Writes `since` the first time Core opens with this step, so an upgrade never counts meetings
/// and automation results made before it (design §2, anti-goal "a flood on upgrade"). A no-op
/// once the record exists.
pub(crate) fn ensure_since(r: &mut Repository, now: i64) -> Result<()> {
    if r.record(SEEN_KIND, SEEN_ID, None, Some(PERSONAL)).is_ok() {
        return Ok(());
    }
    save(
        r,
        &Seen {
            since: now,
            automations: 0,
            meetings: BTreeMap::new(),
        },
        now,
    )
}

/// The four counted sources (design §5's `sources`), serde camelCase like the rest of the
/// snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    pub replies: u32,
    pub tasks: u32,
    pub meetings: u32,
    pub automations: u32,
}

/// Stable identity of a message row, matching `messageKey` in `selectors.js`: a Teams chat is one
/// row whatever its newest message is; mail stays one row per message.
fn message_key(r: &Record) -> String {
    if r.data["channel"].as_str() == Some("chat") {
        let conversation = r.data["conversationId"].as_str().filter(|s| !s.is_empty());
        format!("chat:{}", conversation.unwrap_or(r.source.as_str()))
    } else {
        r.id.clone()
    }
}

/// Whether a message is in Inbox at all (`visibleMessages` in `selectors.js`): not deleted, not
/// archived, not snoozed past `now`.
fn message_visible(r: &Record, now: i64) -> bool {
    r.kind == "message"
        && r.data["deleted"].as_bool() != Some(true)
        && r.data["lifecycle"].as_str() != Some("archived")
        && !r.data["snoozedUntil"].as_i64().is_some_and(|t| t > now)
}

/// Needs-reply rows, exactly as Inbox counts them (`selectors.js::attentionMessages`):
/// unacknowledged critical messages, then Needs-reply messages, one row per Teams chat, a chat
/// with a critical message represented by it.
pub(crate) fn attention_rows(records: &[Record], now: i64) -> u32 {
    let visible: Vec<&Record> = records.iter().filter(|r| message_visible(r, now)).collect();
    let mut taken = std::collections::HashSet::new();
    let mut count = 0u32;
    for r in visible.iter().filter(|r| {
        r.data["lane"].as_str() == Some("critical") && r.data["acknowledgedAt"].is_null()
    }) {
        if taken.insert(message_key(r)) {
            count += 1;
        }
    }
    let mut reply_keys = std::collections::HashSet::new();
    for r in visible
        .iter()
        .filter(|r| r.data["lane"].as_str() == Some("reply"))
    {
        let key = message_key(r);
        if taken.contains(&key) {
            continue;
        }
        if reply_keys.insert(key) {
            count += 1;
        }
    }
    count
}

/// The workspace time zone's day key (`YYYY-MM-DD`), as `tasks::due_today_reminders` computes it.
fn day_key(zone: &str, now: i64) -> String {
    let tz: chrono_tz::Tz = zone.parse().unwrap_or(chrono_tz::UTC);
    chrono::DateTime::from_timestamp(now, 0)
        .map(|t| t.with_timezone(&tz).format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// The four sources (design §3), computed over the snapshot's own records, and the ids of the
/// meetings counted (design §5's `newMeetings`).
pub(crate) fn sources(s: &Snapshot, me: &MeAlias, seen: &Seen, now: i64) -> (Sources, Vec<String>) {
    let replies = attention_rows(&s.records, now);

    let active = active_provider(&s.settings);
    let today = day_key(&s.settings.time_zone, now);
    let tasks = s
        .records
        .iter()
        .filter(|r| r.kind == tasks::KIND)
        .filter(|r| tasks::provider_of(&r.data) == active)
        .filter(|r| tasks::is_open(&r.data))
        .filter(|r| tasks::is_mine(&r.data, me))
        .filter(|r| {
            r.data["due"]
                .as_str()
                .is_some_and(|due| due <= today.as_str())
        })
        .filter(|r| !(s.settings.menu_bar.replies && r.data["kind"].as_str() == Some("reply")))
        .count() as u32;

    let mut new_meetings = Vec::new();
    for r in s
        .records
        .iter()
        .filter(|r| r.kind == super::meetings::model::KIND)
    {
        let Ok(meeting) = serde_json::from_value::<MeetingRecord>(r.data.clone()) else {
            continue;
        };
        let mark = seen
            .meetings
            .get(&r.id)
            .copied()
            .unwrap_or(0)
            .max(seen.since);
        let has_new_doc = meeting
            .docs
            .iter()
            .any(|d| d.updated_at > mark && now - d.updated_at <= NEW_FOR);
        if has_new_doc {
            new_meetings.push(r.id.clone());
        }
    }
    let meetings_count = new_meetings.len() as u32;

    let automations_mark = seen.automations.max(seen.since);
    let automations = s
        .records
        .iter()
        .filter(|r| r.kind == "automation_run")
        .filter(|r| r.data["status"].as_str() == Some("ok"))
        .filter(|r| {
            r.data["delivered"].as_array().is_some_and(|delivered| {
                !delivered.is_empty()
                    && !(delivered.len() == 1 && delivered[0].as_str() == Some("meeting_summary"))
            })
        })
        .filter(|r| r.updated_at > automations_mark && now - r.updated_at <= NEW_FOR)
        .count() as u32;

    (
        Sources {
            replies,
            tasks,
            meetings: meetings_count,
            automations,
        },
        new_meetings,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(id: &str, lane: &str, data: Value) -> Record {
        let mut body = json!({"lane": lane});
        for (k, v) in data.as_object().unwrap() {
            body[k] = v.clone();
        }
        Record {
            id: id.into(),
            kind: "message".into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "mail:inbox".into(),
            revision: "r1".into(),
            updated_at: 0,
            data: body,
        }
    }

    fn snapshot(settings: Settings, records: Vec<Record>) -> Snapshot {
        Snapshot {
            revision: 0,
            workspaces: Vec::new(),
            settings,
            connection: None,
            records,
            jobs: Vec::new(),
            available: true,
            meetings_root: None,
            note_templates: Vec::new(),
            task_provider: Value::Null,
        }
    }

    fn task(id: &str, data: Value) -> Record {
        let mut body = json!({"status": "todo"});
        for (k, v) in data.as_object().unwrap() {
            body[k] = v.clone();
        }
        Record {
            id: id.into(),
            kind: tasks::KIND.into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "local".into(),
            revision: "r1".into(),
            updated_at: 0,
            data: body,
        }
    }

    fn meeting(id: &str, docs: Vec<Value>) -> Record {
        Record {
            id: id.into(),
            kind: super::super::meetings::model::KIND.into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "local".into(),
            revision: "r1".into(),
            updated_at: 0,
            data: json!({"eventId": id, "title": "", "start": "", "end": "", "docs": docs}),
        }
    }

    fn automation_run(id: &str, status: &str, delivered: Vec<&str>, updated_at: i64) -> Record {
        Record {
            id: id.into(),
            kind: "automation_run".into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "automation".into(),
            revision: "r1".into(),
            updated_at,
            data: json!({"status": status, "delivered": delivered}),
        }
    }

    #[test]
    fn settings_default_to_replies_only() {
        let s = Settings::default();
        assert_eq!(
            s.menu_bar,
            MenuBarSettings {
                replies: true,
                tasks: false,
                meetings: false,
                automations: false,
            }
        );
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(
            v["menuBar"],
            json!({"replies": true, "tasks": false, "meetings": false, "automations": false})
        );

        let old: Settings = serde_json::from_str(r#"{"syncDays":7}"#).unwrap();
        assert_eq!(old.menu_bar, MenuBarSettings::default());

        let mut m = MenuBarSettings::default();
        m.apply(&json!({"tasks": true})).unwrap();
        assert!(m.replies);
        assert!(m.tasks);

        let err = m.apply(&json!({"tasks": "yes"})).unwrap_err();
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("menuBar"));
        assert_eq!(err.message, "Choose on or off.");
    }

    #[test]
    fn replies_match_inbox_one_per_chat() {
        let now = 1_000_000;
        let records = vec![
            // mail reply
            message("m1", "reply", json!({"channel": "mail"})),
            // chat c1: five reply messages + one critical unacknowledged -> one row
            message(
                "c1-1",
                "reply",
                json!({"channel": "chat", "conversationId": "c1"}),
            ),
            message(
                "c1-2",
                "reply",
                json!({"channel": "chat", "conversationId": "c1"}),
            ),
            message(
                "c1-3",
                "reply",
                json!({"channel": "chat", "conversationId": "c1"}),
            ),
            message(
                "c1-4",
                "reply",
                json!({"channel": "chat", "conversationId": "c1"}),
            ),
            message(
                "c1-5",
                "reply",
                json!({"channel": "chat", "conversationId": "c1"}),
            ),
            message(
                "c1-critical",
                "critical",
                json!({"channel": "chat", "conversationId": "c1", "acknowledgedAt": null}),
            ),
            // chat c2: critical acknowledged + reply -> the reply only
            message(
                "c2-critical",
                "critical",
                json!({"channel": "chat", "conversationId": "c2", "acknowledgedAt": 5}),
            ),
            message(
                "c2-reply",
                "reply",
                json!({"channel": "chat", "conversationId": "c2"}),
            ),
            // archived, deleted, snoozed -> none of these count
            message(
                "archived",
                "reply",
                json!({"channel": "mail", "lifecycle": "archived"}),
            ),
            message(
                "deleted",
                "reply",
                json!({"channel": "mail", "deleted": true}),
            ),
            message(
                "snoozed",
                "reply",
                json!({"channel": "mail", "snoozedUntil": now + 100}),
            ),
        ];
        assert_eq!(attention_rows(&records, now), 3);
    }

    #[test]
    fn tasks_are_my_open_tasks_due_today_or_late() {
        let now = 1_000_000; // 1970-01-12 13:46:40 UTC
        let mut settings = Settings::default();
        settings.time_zone = "Europe/Vilnius".into();
        let today = day_key("Europe/Vilnius", now);
        let yesterday = day_key("Europe/Vilnius", now - 86_400);
        let tomorrow = day_key("Europe/Vilnius", now + 86_400);
        let me = MeAlias {
            name: "Me".into(),
            aliases: Vec::new(),
            address: Some("me@example.test".into()),
        };
        let records = vec![
            task(
                "due-today",
                json!({"owner": "me@example.test", "due": today}),
            ),
            task(
                "due-yesterday",
                json!({"owner": "me@example.test", "due": yesterday}),
            ),
            task(
                "due-tomorrow",
                json!({"owner": "me@example.test", "due": tomorrow}),
            ),
            task(
                "done",
                json!({"owner": "me@example.test", "due": today, "status": "done"}),
            ),
            task(
                "dismissed",
                json!({"owner": "me@example.test", "due": today, "status": "dismissed"}),
            ),
            task(
                "review",
                json!({"owner": "me@example.test", "due": today, "status": "review"}),
            ),
            task("not-mine", json!({"owner": "Ann", "due": today})),
            task(
                "reply-kind",
                json!({"owner": "me@example.test", "due": today, "kind": "reply"}),
            ),
        ];
        let seen = Seen::default();

        let mut off = settings.clone();
        off.menu_bar.replies = false;
        let snap = snapshot(off, records.clone());
        let (counted, _) = sources(&snap, &me, &seen, now);
        assert_eq!(counted.tasks, 3); // due-today, due-yesterday, reply-kind (replies not counted)

        let mut on = settings;
        on.menu_bar.replies = true;
        let snap = snapshot(on, records);
        let (counted, _) = sources(&snap, &me, &seen, now);
        assert_eq!(counted.tasks, 2); // reply-kind dropped while replies are counted
    }

    #[test]
    fn meetings_with_new_notes_since_seen_within_seven_days() {
        let now = 1_000_000;
        let settings = Settings::default();
        let me = MeAlias::default();
        let mut seen = Seen {
            since: now - 10 * NEW_FOR,
            automations: 0,
            meetings: BTreeMap::new(),
        };

        let records = vec![
            meeting("new", vec![json!({"updatedAt": now - 10})]),
            meeting("marked-after", vec![json!({"updatedAt": now - 10})]),
            meeting("stale", vec![json!({"updatedAt": now - NEW_FOR - 10})]),
        ];
        seen.meetings.insert("marked-after".into(), now - 5);

        let snap = snapshot(settings, records);
        let (counted, new_meetings) = sources(&snap, &me, &seen, now);
        assert_eq!(counted.meetings, 1);
        assert_eq!(new_meetings, vec!["new".to_string()]);
    }

    #[test]
    fn automation_results_are_ok_runs_after_the_mark() {
        let now = 1_000_000;
        let settings = Settings::default();
        let me = MeAlias::default();
        let seen = Seen {
            since: now - 10 * NEW_FOR,
            automations: now - 100,
            meetings: BTreeMap::new(),
        };
        let records = vec![
            automation_run("ok", "ok", vec!["today"], now - 10),
            automation_run("failed", "failed", vec!["today"], now - 10),
            automation_run("skipped", "skipped", vec!["today"], now - 10),
            automation_run("summary-only", "ok", vec!["meeting_summary"], now - 10),
            automation_run("empty", "ok", vec![], now - 10),
        ];
        let snap = snapshot(settings, records);
        let (counted, _) = sources(&snap, &me, &seen, now);
        assert_eq!(counted.automations, 1);
    }

    #[test]
    fn nothing_before_since_is_new() {
        let now = 1_000_000;
        let since = now - 10;
        let settings = Settings::default();
        let me = MeAlias::default();
        let seen = Seen {
            since,
            automations: 0,
            meetings: BTreeMap::new(),
        };
        let mut records = Vec::new();
        for i in 0..100 {
            records.push(meeting(
                &format!("m{i}"),
                vec![json!({"updatedAt": since - 1})],
            ));
        }
        for i in 0..50 {
            records.push(automation_run(
                &format!("a{i}"),
                "ok",
                vec!["today"],
                since - 1,
            ));
        }
        let snap = snapshot(settings, records);
        let (counted, new_meetings) = sources(&snap, &me, &seen, now);
        assert_eq!(counted.meetings, 0);
        assert_eq!(counted.automations, 0);
        assert!(new_meetings.is_empty());
    }

    #[tokio::test]
    async fn settings_update_saves_menu_bar_and_open_sets_since() {
        use crate::ai::fake::FakeRunner;
        use crate::workspace::ai::tests::{mutation, ready};
        use crate::workspace::test_core;
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        assert!(seen(&core.repo().unwrap()).since > 0);

        let req = mutation(
            &core,
            Operation::SettingsUpdate,
            json!({"menuBar": {"meetings": true}}),
        );
        core.request(req).await.unwrap();
        let snapshot = core.repo().unwrap().snapshot().unwrap();
        assert!(snapshot.settings.menu_bar.meetings);
    }
}
