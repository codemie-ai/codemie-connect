//! Ask (ask-capture design `docs/superpowers/specs/2026-11-26-ask-capture-design.md`): a
//! question about what Connect holds on this Mac, answered by the `ask` route's profile. This
//! module gives the snapshot its `ask` part (`Core::ask_snapshot`, § 6): thread titles, counts and
//! states, what runs now and whether the field shows in the menu — never a question beyond its
//! title, an answer or a context item. The threads themselves live in `store`.
use super::ai::{wire_name, RouteKey};
use super::models::{Purpose, Settings};
use super::Core;
use serde_json::{json, Value};

pub mod answer;
pub mod context;
pub mod ops;
pub mod store;

use store::{Thread, TurnState};

/// The snapshot's `ask` (design § 6) for `threads` (newest first, as `store::list` gives them):
/// `{threads: [{id, title, updatedAt, turns, last}], running, inMenu}`. `running` names the
/// newest turn still `queued` or `running`, `null` when none is.
pub(crate) fn snapshot(threads: &[Thread], settings: &Settings) -> Value {
    let items: Vec<Value> = threads
        .iter()
        .map(|t| {
            json!({
                "id": t.id,
                "title": t.title(),
                "updatedAt": t.updated_at,
                "turns": t.turns.len(),
                "last": t.turns.last().map(|turn| turn.state),
            })
        })
        .collect();
    let running = threads
        .iter()
        .flat_map(|t| t.turns.iter().map(move |turn| (t, turn)))
        .filter(|(_, turn)| matches!(turn.state, TurnState::Queued | TurnState::Running))
        .max_by_key(|(_, turn)| turn.at)
        .map(|(t, turn)| {
            json!({
                "threadId": t.id,
                "turnId": turn.id,
                "jobId": turn.job_id,
                "startedAt": turn.at,
            })
        });
    json!({ "threads": items, "running": running, "inMenu": settings.ask_in_menu })
}

impl Core {
    /// The snapshot's `ask` (design § 6). A thread store that can't be read shows no threads
    /// rather than failing the whole snapshot.
    pub(crate) fn ask_snapshot(&self, settings: &Settings) -> Value {
        let threads = self
            .repo()
            .ok()
            .and_then(|r| store::list(&r).ok())
            .unwrap_or_default();
        snapshot(&threads, settings)
    }

    /// The Ask route's state for the status smoke (task 8): `"ready"` when the route's resolved
    /// profile can run now, else the error's class (`needs_login`, `not_installed`,
    /// `not_configured`, `too_old`, `rate_limited`, `needs_choice`, `failed`) — never a profile
    /// id or message (step 7's `resolve_key`).
    pub(crate) async fn ask_route_state(&self) -> String {
        match self.resolve_key(&RouteKey::Purpose(Purpose::Ask)).await {
            Ok(_) => "ready".into(),
            Err(e) => wire_name(e.class),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::store::tests::{thread, turn};
    use super::store::{self, Cite, RefItem, TurnError, TurnState};
    use super::*;
    use crate::workspace::ai::tests::ready;
    use crate::workspace::models::{Operation, Request};
    use crate::workspace::test_core;
    use std::sync::Arc;

    const SENTINEL: &str = "ASK_SENTINEL_5c1e";
    const AT: i64 = 1_795_000_400;

    fn core(dir: &std::path::Path) -> Arc<Core> {
        test_core(
            dir,
            Arc::new(crate::ai::fake::FakeRunner::new(vec![])),
            ready(),
        )
    }

    async fn full_snapshot(core: &Arc<Core>) -> Value {
        core.request(Request {
            op: Operation::Snapshot,
            workspace_id: Some("personal".into()),
            expected_revision: None,
            operation_id: None,
            data: json!({}),
        })
        .await
        .unwrap()["snapshot"]
            .clone()
    }

    fn done(n: usize, at: i64, question: &str, answer: &str) -> store::Turn {
        let mut t = turn(n, at, question, TurnState::Done);
        t.answer = Some(answer.into());
        t.job_id = Some(format!("job-{n}"));
        t.profile = Some("Claude".into());
        t
    }

    #[test]
    fn old_settings_read_ask_in_menu_true() {
        let old: Settings = serde_json::from_str(r#"{"syncDays":7,"view":"compact"}"#).unwrap();
        assert!(old.ask_in_menu);
        assert!(Settings::default().ask_in_menu);
        assert_eq!(snapshot(&[], &old)["inMenu"], true);
        let off: Settings = serde_json::from_str(r#"{"askInMenu":false}"#).unwrap();
        assert_eq!(snapshot(&[], &off)["inMenu"], false);
        assert_eq!(serde_json::to_value(&off).unwrap()["askInMenu"], false);
    }

    #[tokio::test]
    async fn ask_in_menu_changes_with_settings_update() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.request(crate::workspace::ai::tests::mutation(
            &core,
            Operation::SettingsUpdate,
            json!({ "askInMenu": false }),
        ))
        .await
        .unwrap();
        assert!(!core.repo().unwrap().settings().unwrap().ask_in_menu);
        assert_eq!(full_snapshot(&core).await["ask"]["inMenu"], false);
    }

    #[tokio::test]
    async fn threads_stay_out_of_records() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let t = thread(
            "ask-7f2c",
            AT,
            vec![done(1, AT, "When is the QBR?", "On Friday.")],
        );
        store::write(&mut core.repo().unwrap(), &t).unwrap();
        let snap = full_snapshot(&core).await;
        let records = snap["records"].as_array().unwrap();
        assert!(
            records.iter().all(|r| r["kind"] != store::KIND),
            "{records:?}"
        );
        assert_eq!(snap["ask"]["threads"][0]["id"], "ask-7f2c");
        assert_eq!(snap["ask"]["threads"][0]["title"], "When is the QBR?");
    }

    #[tokio::test]
    async fn snapshot_never_carries_answer_text() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        let mut first = done(1, AT, "When is the QBR?", &format!("Friday. {SENTINEL}"));
        first.searched = Some(format!("Searched {SENTINEL}"));
        first.cites = vec![Cite {
            id: "m1".into(),
            kind: "message".into(),
            record_id: Some("msg-1".into()),
            label: Some(SENTINEL.into()),
            title: Some(SENTINEL.into()),
        }];
        first.about = Some(RefItem {
            kind: "message".into(),
            record_id: "msg-1".into(),
            label: SENTINEL.into(),
            gone: false,
        });
        let mut second = turn(2, AT + 5, &format!("And {SENTINEL}?"), TurnState::Failed);
        second.error = Some(TurnError {
            code: "ai".into(),
            message: SENTINEL.into(),
        });
        let t = thread("ask-7f2c", AT + 5, vec![first, second]);
        store::write(&mut core.repo().unwrap(), &t).unwrap();
        let text = serde_json::to_string(&full_snapshot(&core).await).unwrap();
        assert!(!text.contains(SENTINEL), "{text}");
        assert!(text.contains("When is the QBR?"));
    }

    #[test]
    fn running_names_the_queued_or_running_turn() {
        let settings = Settings::default();
        let idle = vec![thread(
            "ask-1",
            AT,
            vec![done(1, AT, "When is the QBR?", "Friday.")],
        )];
        assert_eq!(snapshot(&idle, &settings)["running"], Value::Null);

        for state in [TurnState::Queued, TurnState::Running] {
            let mut second = turn(2, AT + 10, "And the agenda?", state);
            second.job_id = Some("job-9".into());
            let threads = vec![
                thread(
                    "ask-2",
                    AT + 10,
                    vec![done(1, AT + 1, "Who is Marek Novak?", "A client."), second],
                ),
                idle[0].clone(),
            ];
            let ask = snapshot(&threads, &settings);
            assert_eq!(
                ask["running"],
                json!({"threadId": "ask-2", "turnId": "turn-2", "jobId": "job-9", "startedAt": AT + 10})
            );
            assert_eq!(ask["threads"][0]["last"], json!(state));
            assert_eq!(ask["threads"][0]["turns"], 2);
        }
    }

    /// The snapshot's `ask` in each state the window draws. Regenerate with
    /// `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
    #[test]
    fn contract_fixtures_match_the_ask_states() {
        let settings = Settings::default();
        let priya = |turns| thread("ask-7f2c", AT, turns);
        let idle = vec![
            priya(vec![
                done(1, AT - 60, "What did I promise Priya this week?", "x"),
                done(2, AT, "And Jordan Lee?", "x"),
            ]),
            thread(
                "ask-3a9e",
                AT - 3_600,
                vec![done(1, AT - 3_600, "When is the QBR?", "x")],
            ),
            thread(
                "ask-51bd",
                AT - 86_400,
                vec![done(1, AT - 86_400, "Who is Marek Novak?", "x")],
            ),
        ];
        let mut running_turn = turn(2, AT + 1, "And Jordan Lee?", TurnState::Running);
        running_turn.job_id = Some("job-9".into());
        running_turn.profile = Some("Claude".into());
        let mut running = idle.clone();
        running[0] = thread(
            "ask-7f2c",
            AT + 1,
            vec![
                done(1, AT - 60, "What did I promise Priya this week?", "x"),
                running_turn,
            ],
        );
        let mut failed_turn = turn(2, AT, "And Jordan Lee?", TurnState::Failed);
        failed_turn.job_id = Some("job-9".into());
        failed_turn.error = Some(TurnError {
            code: "ai_failed".into(),
            message: "x".into(),
        });
        let mut failed_last = idle.clone();
        failed_last[0] = priya(vec![
            done(1, AT - 60, "What did I promise Priya this week?", "x"),
            failed_turn,
        ]);
        let mut stopped_turn = turn(2, AT, "And Jordan Lee?", TurnState::Stopped);
        stopped_turn.job_id = Some("job-9".into());
        let mut stopped_last = idle.clone();
        stopped_last[0] = priya(vec![
            done(1, AT - 60, "What did I promise Priya this week?", "x"),
            stopped_turn,
        ]);
        let states = json!({
            "empty": snapshot(&[], &settings),
            "idle": snapshot(&idle, &settings),
            "running": snapshot(&running, &settings),
            "failedLast": snapshot(&failed_last, &settings),
            "stoppedLast": snapshot(&stopped_last, &settings),
        });
        assert_eq!(states["idle"]["threads"].as_array().unwrap().len(), 3);
        assert_eq!(states["running"]["running"]["jobId"], "job-9");
        assert_eq!(states["failedLast"]["threads"][0]["last"], "failed");
        assert_eq!(states["stoppedLast"]["threads"][0]["last"], "stopped");
        crate::plugins::testkit::contract_fixture("ask-states.json", &states);
    }
}
