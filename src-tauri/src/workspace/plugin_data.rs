//! The workspace's side of the plugin host (DESIGN 7.2): what `plugins::services` asks of `Core`
//! (plugin records, Claude runs, the sources plugins may read, notifications), and the events
//! `Core` tells plugins through its `EventSink` (PLUGIN-ENGINE.md §7): `sources_changed` once
//! after each sync round that changed something, and `meeting_soon` ten minutes before a meeting.
//! `threads_changed` is never sent: Connect has no threads.
//!
//! Plugin records are global (no workspace, no account) and shown in every snapshot for Today:
//! `plugin_item` (inbox items, deliveries, held messages) and `plugin_widget` (widget data, work
//! rows). Each one's id starts with `<plugin>:` and its data names the `plugin`.
use super::ai::{resolve_route, unready_error, wire_name};
use super::{graph, models::*, Core};
use crate::ai::command::{FolderRun, RunSpec};
use crate::ai::stream::{AiError, ErrorClass};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri_plugin_notification::NotificationExt;

/// Where `Core` tells plugins what happened (the plugin manager).
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
    /// Whether any plugin listens for `event` (so `Core` can skip the work of telling).
    fn hears(&self, _event: &str) -> bool {
        true
    }
}

/// A meeting is told this long before it starts.
const MEETING_SOON: i64 = 10 * 60;

/// The system prompt of a plugin's Claude run (always tool-free, DESIGN 6.2).
const PLUGIN_SYSTEM: &str = "You answer a request from a plugin the user installed in their \
    work app. You have no tools: everything you need is in the request. Answer in Markdown, \
    useful part first. You send nothing and make no commitments the user didn't ask for, and \
    you never invent facts, dates or prices.";

/// The system prompt of a plugin's run in a folder of the user's (a vault): read tools, and
/// edit tools only in a copy or where the plugin may write.
const PLUGIN_FOLDER_SYSTEM: &str = "You answer a request from a plugin the user installed in \
    their work app. You work in a folder of the user's notes, the folder you were started in: \
    read and search it with your tools, follow its CLAUDE.md and skills, and change files only \
    when the request asks for it and your tools allow it. Never look outside this folder. Answer \
    in Markdown, useful part first. You send nothing and make no commitments the user didn't ask \
    for, and you never invent facts, dates or prices.";

/// A plugin's Claude run, as `ctx.claude.run` asked for it.
pub(crate) struct PluginRun {
    pub plugin: String,
    pub title: String,
    pub prompt: String,
    pub profile: Option<String>,
    pub model: Option<String>,
    /// What the plugin asked for (recorded; a run without a folder is tool-free).
    pub tools: String,
    pub timeout: Duration,
    /// A run in a folder of the user's (or a copy of it).
    pub folder: Option<FolderRun>,
    /// Stops the run (`ctx.claude.stop(key)`); a child of Connect's own, so quitting stops it.
    pub cancel: tokio_util::sync::CancellationToken,
}

/// How a plugin names one of the sources it may read: `mail:<id>`, `chat:<id>`, `event:<id>`.
pub(crate) fn plugin_source_id(r: &Record) -> String {
    let prefix = match (r.kind.as_str(), r.data["channel"].as_str()) {
        ("event", _) => "event",
        (_, Some("chat")) => "chat",
        _ => "mail",
    };
    format!("{prefix}:{}", r.id)
}

impl Core {
    /// A plugin's notification, shown only while the user lets Connect notify.
    pub(crate) fn plugin_notify(&self, title: &str, body: &str) {
        let allowed = self
            .repo()
            .and_then(|r| r.settings())
            .is_ok_and(|s| s.notifications);
        let Some(app) = self.app.as_ref().filter(|_| allowed) else {
            return;
        };
        if let Err(e) = app.notification().builder().title(title).body(body).show() {
            log::warn!("plugins: a notification wasn't shown: {e}");
        }
    }

    pub(crate) fn set_event_sink(&self, sink: Arc<dyn EventSink>) {
        if self.events.set(sink).is_err() {
            log::warn!("plugins: the event sink was set already");
        }
    }

    fn tell(&self, event: &str, payload: Value) {
        if let Some(sink) = self.events.get() {
            sink.emit(event, payload);
        }
    }

    fn heard(&self, event: &str) -> bool {
        self.events.get().is_some_and(|s| s.hears(event))
    }

    /// Writes a plugin record and nudges the open views.
    pub(crate) fn plugin_put(&self, record: &Record) -> Result<()> {
        self.repo()?.put_record(record)?;
        self.emit("workspace:changed");
        Ok(())
    }

    /// Deletes plugin records by id (or id prefix); see `Repository::delete_plugin_records`.
    pub(crate) fn plugin_delete(&self, kind: Option<&str>, id: &str, prefix: bool) -> Result<()> {
        if self.repo()?.delete_plugin_records(kind, id, prefix)? > 0 {
            self.emit("workspace:changed");
        }
        Ok(())
    }

    /// Deletes the records of every plugin but `keep` (they were turned off or removed).
    pub(crate) fn plugin_keep_only(&self, keep: &[String]) -> Result<()> {
        if self.repo()?.delete_plugin_records_except(keep)? > 0 {
            self.emit("workspace:changed");
        }
        Ok(())
    }

    pub(crate) fn plugin_records(&self, kind: &str) -> Result<Vec<Record>> {
        self.repo()?.plugin_records(kind)
    }

    /// The Microsoft account deliveries would reach the user at, while it is connected.
    pub(crate) fn plugin_account(&self) -> Option<String> {
        let r = self.repo().ok()?;
        let cid = r.settings().ok()?.active_connection?;
        let c = r.connection(&cid).ok()?;
        (c.status == "connected").then_some(c.email)
    }

    /// The Microsoft account's name and e-mail address (Echo's `me`), while one is signed in.
    pub(crate) fn plugin_me(&self) -> Option<(String, String)> {
        let r = self.repo().ok()?;
        let cid = r.settings().ok()?.active_connection?;
        let c = r.connection(&cid).ok()?;
        Some((c.display_name, c.email))
    }

    /// A token that stops one plugin run, stopped too when Connect stops its Claude work.
    pub(crate) fn plugin_stop_token(&self) -> tokio_util::sync::CancellationToken {
        self.ai_cancel.child_token()
    }

    /// The messages and meetings plugins may read: exactly what the active workspace shows
    /// (its selected sources of the account it is bound to).
    pub(crate) fn plugin_sources(&self) -> Result<Vec<Record>> {
        let snapshot = self.repo()?.snapshot()?;
        Ok(snapshot
            .records
            .into_iter()
            .filter(|r| r.connection_id.is_some() && matches!(r.kind.as_str(), "message" | "event"))
            .collect())
    }

    /// `ctx.profiles()`: Connect's AI profiles and the default.
    pub(crate) async fn plugin_profiles(&self) -> Value {
        let profiles = self.profiles.profiles().await;
        let default = self
            .repo()
            .and_then(|r| r.settings())
            .ok()
            .and_then(|s| s.ai.default_profile);
        json!({
            "default": default,
            "profiles": profiles.iter().map(|p| json!({"id": p.id, "name": p.label})).collect::<Vec<_>>(),
        })
    }

    /// A plugin's Claude run: tool-free (DESIGN 6.2) on the profile it named or the `plugin`
    /// route, recorded as an `ai_run` of purpose `plugin` with the plugin and the tools it asked
    /// for. Answers `{answer, model, usage, costUsd, actions: []}`.
    pub(crate) async fn plugin_claude(
        &self,
        run: PluginRun,
    ) -> std::result::Result<Value, AiError> {
        let profiles = self.profiles.profiles().await;
        let (profile, route_model) = match &run.profile {
            Some(id) => {
                let p = profiles.iter().find(|p| &p.id == id).ok_or_else(|| {
                    let mut e = AiError::new(ErrorClass::NotConfigured);
                    e.message = format!("Connect has no AI profile “{id}”.");
                    e
                })?;
                if let Some(e) = unready_error(p) {
                    return Err(e);
                }
                (p.clone(), None)
            }
            None => {
                let settings = self
                    .repo()
                    .and_then(|r| r.settings())
                    .map_err(|_| AiError::new(ErrorClass::Failed))?;
                resolve_route(&settings.ai, &profiles, Purpose::Plugin)?
            }
        };
        // A model the profile doesn't offer (another provider's name) falls back to the route's.
        let model = run
            .model
            .filter(|m| !m.is_empty() && profile.models.iter().any(|c| &c.id == m))
            .or(route_model);
        let spec = RunSpec {
            purpose: wire_name(Purpose::Plugin),
            profile_id: profile.id.clone(),
            model,
            system: if run.folder.is_some() {
                PLUGIN_FOLDER_SYSTEM
            } else {
                PLUGIN_SYSTEM
            }
            .into(),
            input: json!({"title": run.title, "request": run.prompt}),
            schema: None,
            timeout: run.timeout,
            cap_usd: None,
            staging_root: self
                .paths
                .ensure_staging()
                .map_err(|_| AiError::new(ErrorClass::Failed))?,
            folder: run.folder.clone(),
        };
        let started = Instant::now();
        let result = self
            .runner
            .run(spec.clone(), &profile, run.cancel.clone(), Box::new(|_| {}))
            .await;
        let ref_id = format!("plugin:{}", run.plugin);
        let mut record = self.ai_run_record(
            &spec,
            result.as_ref().ok(),
            result.as_ref().err(),
            started.elapsed(),
            Some(&ref_id),
        );
        record.data["plugin"] = json!(run.plugin);
        record.data["tools"] = json!(run.tools);
        self.put_ai_run(&record);
        let outcome = result?;
        let usage = &outcome.usage;
        Ok(json!({
            "answer": outcome.text,
            "model": outcome.model.clone().or(spec.model).unwrap_or_default(),
            "usage": {
                "input_tokens": usage.input_tokens,
                "cache_read_tokens": usage.cache_read_tokens,
                "cache_write_tokens": usage.cache_creation_tokens,
                "output_tokens": usage.output_tokens,
                "cost_usd": outcome.cost_usd.unwrap_or(0.0),
                "duration_ms": outcome.duration_ms,
                "turns": 1,
            },
            "costUsd": outcome.cost_usd,
            "actions": [],
        }))
    }

    /// After a sync round: tells plugins which sources it changed, once (`sources_changed`).
    /// `started` is when the round began; a record it wrote is newer.
    pub(crate) fn after_sync_round(&self, started: i64) {
        if !self.heard("sources_changed") {
            return;
        }
        let Ok(sources) = self.plugin_sources() else {
            return;
        };
        let changed: Vec<String> = sources
            .iter()
            .filter(|r| r.updated_at >= started)
            .map(plugin_source_id)
            .collect();
        if !changed.is_empty() {
            self.tell(
                "sources_changed",
                json!({"changed": changed, "removed": []}),
            );
        }
    }

    /// Tells plugins of each meeting starting within ten minutes of `now`, once
    /// (`meeting_soon`, `{id, subject, start, threads}`).
    pub(crate) fn announce_meetings(&self, now: i64) {
        if !self.heard("meeting_soon") {
            return;
        }
        let Ok(sources) = self.plugin_sources() else {
            return;
        };
        let mut told = self
            .meetings_told
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        told.retain(|_, start| *start > now - 3600);
        for r in sources.iter().filter(|r| r.kind == "event") {
            let start = r.data["start"].as_str().map(graph::timestamp).unwrap_or(0);
            let soon = start > now && start <= now + MEETING_SOON;
            if !soon || r.data["cancelled"] == true || told.contains_key(&r.id) {
                continue;
            }
            told.insert(r.id.clone(), start);
            self.tell(
                "meeting_soon",
                json!({
                    "id": plugin_source_id(r),
                    "subject": r.data["title"],
                    "start": r.data["start"],
                    "threads": [],
                }),
            );
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::test_core;
    use std::sync::Mutex;

    /// Remembers every event it was told.
    #[derive(Default)]
    pub struct Heard(pub Mutex<Vec<(String, Value)>>);

    impl EventSink for Heard {
        fn emit(&self, event: &str, payload: Value) {
            self.0.lock().unwrap().push((event.into(), payload));
        }
    }

    impl Heard {
        pub fn of(&self, event: &str) -> Vec<Value> {
            let heard = self.0.lock().unwrap();
            heard
                .iter()
                .filter(|(e, _)| e == event)
                .map(|(_, p)| p.clone())
                .collect()
        }
    }

    pub const ACCT: &str = "acct";

    /// A connected account bound to `personal`, every source shown.
    pub fn seed(core: &Core) {
        let mut r = core.repo().unwrap();
        let c = Connection {
            id: ACCT.into(),
            account_key: ACCT.into(),
            display_name: "Taylor Reed".into(),
            email: "taylor@example.test".into(),
            user_id: "me-1".into(),
            generation: 1,
            policy_revision: 1,
            scopes: vec![
                "Calendars.Read".into(),
                "Mail.Read".into(),
                "Chat.Read".into(),
            ],
            enabled: vec!["calendar".into(), "mail".into(), "chats".into()],
            status: "connected".into(),
            ..Default::default()
        };
        r.save_connection(&c).unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some(ACCT.into());
        s.ai.default_profile = Some("claude".into());
        r.settings_update(&s).unwrap();
        let mut w = r.workspace("personal").unwrap();
        w.connection_id = Some(ACCT.into());
        w.sources = json!({"all": true});
        r.save_workspace(&w).unwrap();
    }

    pub fn source(id: &str, kind: &str, source: &str, at: i64, data: Value) -> Record {
        Record {
            id: id.into(),
            kind: kind.into(),
            connection_id: Some(ACCT.into()),
            workspace_id: None,
            source: source.into(),
            revision: "v1".into(),
            updated_at: at,
            data,
        }
    }

    fn rfc3339(at: i64) -> String {
        chrono::DateTime::from_timestamp(at, 0)
            .unwrap()
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string()
    }

    #[test]
    fn sync_emits_sources_changed_once_per_round_and_never_threads_changed() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), vec![]);
        seed(&core);
        let heard = Arc::new(Heard::default());
        core.set_event_sink(heard.clone());
        let started = now();
        let mut r = core.repo().unwrap();
        r.put_record(&source(
            "old",
            "message",
            "mail:inbox",
            started - 600,
            json!({"channel": "mail", "title": "Old"}),
        ))
        .unwrap();
        r.put_record(&source(
            "m1",
            "message",
            "mail:inbox",
            started,
            json!({"channel": "mail", "title": "New"}),
        ))
        .unwrap();
        r.put_record(&source(
            "c1",
            "message",
            "chat:19:ops",
            started + 1,
            json!({"channel": "chat", "title": "Ops"}),
        ))
        .unwrap();
        drop(r);
        core.after_sync_round(started);
        let told = heard.of("sources_changed");
        assert_eq!(told.len(), 1, "{told:?}");
        let mut changed: Vec<String> = serde_json::from_value(told[0]["changed"].clone()).unwrap();
        changed.sort();
        assert_eq!(changed, ["chat:c1", "mail:m1"]);
        assert_eq!(told[0]["removed"], json!([]));
        // A round that changed nothing tells nothing; threads are never told.
        core.after_sync_round(now() + 10);
        assert_eq!(heard.of("sources_changed").len(), 1);
        assert!(heard.of("threads_changed").is_empty());
    }

    #[test]
    fn meeting_soon_is_told_once_ten_minutes_before() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), vec![]);
        seed(&core);
        let heard = Arc::new(Heard::default());
        core.set_event_sink(heard.clone());
        let t = now();
        let mut r = core.repo().unwrap();
        for (id, start, cancelled) in [
            ("soon", t + 300, false),
            ("later", t + 1800, false),
            ("off", t + 120, true),
        ] {
            r.put_record(&source(id, "event", "calendar:cal-1", t, json!({"title": id, "start": rfc3339(start), "end": rfc3339(start + 1800), "cancelled": cancelled}))).unwrap();
        }
        drop(r);
        core.announce_meetings(t);
        core.announce_meetings(t + 30);
        let told = heard.of("meeting_soon");
        assert_eq!(told.len(), 1, "{told:?}");
        assert_eq!(told[0]["id"], "event:soon");
        assert_eq!(told[0]["subject"], "soon");
        assert_eq!(told[0]["threads"], json!([]));
        // The later one, once its ten minutes have come.
        core.announce_meetings(t + 1800 - 500);
        assert_eq!(heard.of("meeting_soon").len(), 2);
    }
}
