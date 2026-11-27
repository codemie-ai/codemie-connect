//! The task-provider contract (design `docs/superpowers/specs/2026-11-23-task-provider-design.md`
//! §5, §1): one provider is active at a time. The built-in **Local** provider (Connect's own
//! board) is the default; a plugin that declares `"provides": ["tasks"]` can become the active
//! provider instead. This module gives `Core` its way into a provider plugin's host half
//! (`TaskProviders`), the settings and snapshot plumbing (`active_provider`,
//! `Core::task_provider_snapshot`), and the keys that make a create idempotent (`keys`).
//!
//! A provider's changes go through the outbox (`outbox`) and the `task_sync` job (`sync`), which
//! pushes them in order, pulls what changed in the provider and merges it (`merge`), over the
//! wire shape (`wire`). Tests use `fake::FakeProvider`.
use super::models::{Result, Settings};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(any(test, feature = "test-support"))]
#[cfg_attr(not(test), allow(dead_code))] // no test outside the crate drives a provider yet
pub mod fake;
pub(crate) mod handled;
pub(crate) mod keys;
pub(crate) mod merge;
pub(crate) mod ops;
pub(crate) mod outbox;
pub(crate) mod sync;
pub(crate) mod wire;

/// Settings › Tasks (design §2): which provider is active, app-wide like `meetings`. Old
/// settings without `tasks` read as Local (`Settings`'s container-level `#[serde(default)]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskSettings {
    /// `"local"` or `"plugin:<id>"`.
    pub provider: String,
    /// Providers a copy of the open Local tasks has already been offered for (design §11).
    pub copy_offered: Vec<String>,
}
impl Default for TaskSettings {
    fn default() -> Self {
        Self {
            provider: "local".into(),
            copy_offered: Vec::new(),
        }
    }
}

/// The settings' active provider: `"local"` or `"plugin:<id>"`.
pub(crate) fn active_provider(s: &Settings) -> &str {
    &s.tasks.provider
}

/// One provider a plugin registers (design §5's `available`): its id (`"plugin:<id>"`), display
/// name, whether the plugin is turned on, and whether it last answered `status` without error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub on: bool,
    pub ready: bool,
}

/// `taskProvider.state` (design §2): what the Tasks header and Settings › Tasks show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderState {
    Local,
    Ready,
    Syncing,
    Offline,
    RateLimited,
    NeedsToken,
    /// The plugin is installed and turned off.
    Off,
    /// The plugin didn't load.
    Failed,
    /// The plugin manager hasn't finished loading it yet (I1: not a failure, so not a fix).
    Loading,
}
impl ProviderState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Ready => "ready",
            Self::Syncing => "syncing",
            Self::Offline => "offline",
            Self::RateLimited => "rate_limited",
            Self::NeedsToken => "needs_token",
            Self::Off => "off",
            Self::Failed => "failed",
            Self::Loading => "loading",
        }
    }
}

/// Connect's way into a provider plugin's host half (design §5): `call` reaches one of its
/// registered `tasks:<op>` functions, `available` lists every installed plugin that provides
/// tasks, and `secret_matches` keeps a plugin's token out of a log or error message. Implemented
/// by the plugin manager; tests use a `FakeProvider`.
pub trait TaskProviders: Send + Sync {
    /// Asks plugin `plugin`'s `tasks:<op>`.
    fn call(
        &self,
        plugin: &str,
        op: &str,
        args: Value,
    ) -> BoxFuture<'static, std::result::Result<Value, ProviderError>>;
    fn available(&self) -> Vec<ProviderInfo>;
    /// Whether the manager still has a reload under way: a provider that isn't `ready` yet
    /// might simply not have finished loading, not have failed (I1).
    fn loading(&self) -> bool;
    /// Whether `text` contains the plugin's stored secret (design §8's message check).
    fn secret_matches(&self, plugin: &str, text: &str) -> bool;
    /// Plugin `plugin`'s id, version and plain (never secret) settings as one text (design §4,
    /// amended 2026-11-27): when it differs from the one kept beside the cursor, the next sync
    /// drops the cursor and reads everything. `None`: nothing to compare (not installed).
    fn fingerprint(&self, _plugin: &str) -> Option<String> {
        None
    }
}

/// The outcome of a provider call, mapped from the code a provider's thrown `Error` message
/// starts with (design §5 "Errors").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    NeedsToken,
    RateLimited { retry_after: u64 },
    Offline,
    NotFound(String),
    Refused(String),
}
impl ProviderError {
    /// Maps a provider's thrown message to its code; anything unrecognised (or a host
    /// `timeout`) is `Offline`, since it is temporary. The rest of the message, cut to 200
    /// characters, is kept for `NotFound` and `Refused`.
    pub fn parse(message: &str) -> Self {
        const MAX: usize = 200;
        let rest_of = |prefix: &str| message.strip_prefix(prefix).map(str::trim);
        if rest_of("needs_token:").is_some() {
            return Self::NeedsToken;
        }
        if let Some(rest) = rest_of("rate_limited:") {
            let retry_after = rest
                .split_once(':')
                .and_then(|(secs, _)| secs.trim().parse().ok())
                .unwrap_or(60);
            return Self::RateLimited { retry_after };
        }
        if message.starts_with("offline:") {
            return Self::Offline;
        }
        if let Some(rest) = rest_of("not_found:") {
            return Self::NotFound(rest.chars().take(MAX).collect());
        }
        if let Some(rest) = rest_of("refused:") {
            return Self::Refused(rest.chars().take(MAX).collect());
        }
        Self::Offline
    }

    /// The same code without the provider's sentence: what is kept of a message that contained a
    /// stored secret (design §5 "Errors", §8).
    pub fn without_text(self) -> Self {
        match self {
            Self::NotFound(_) => Self::NotFound(String::new()),
            Self::Refused(_) => Self::Refused(String::new()),
            other => other,
        }
    }

    /// The provider's sentence for a parked entry, if it gave one.
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::NotFound(t) | Self::Refused(t) => Some(t.as_str()).filter(|t| !t.is_empty()),
            _ => None,
        }
    }
}

impl ProviderState {
    fn of(state: &str) -> Self {
        match state {
            "offline" => Self::Offline,
            "rate_limited" => Self::RateLimited,
            "needs_token" => Self::NeedsToken,
            _ => Self::Ready,
        }
    }
}

/// `task_sync_now` runs at most once in this many seconds (design §4 "Cadence").
const SYNC_NOW_EVERY: i64 = 30;
/// The background loop syncs this often, window open or closed (design ruling 4).
const BACKGROUND_EVERY: i64 = 300;

impl super::Core {
    /// `task_sync_now {full?}` (read-only): queues a sync with the active provider unless one ran
    /// in the last 30 s. `full` (the Sync now buttons, amended 2026-11-27) asks for everything
    /// again (`sync::reread`), the 30 s too: it is the user's own, rare request. Answers
    /// `{queued}`.
    pub(crate) fn task_sync_now(self: &std::sync::Arc<Self>, data: &Value) -> Result<Value> {
        let now = super::models::now();
        let mut r = self.repo()?;
        let provider = active_provider(&r.settings()?).to_string();
        if provider == "local" {
            return Ok(json!({"queued": false}));
        }
        if data["full"] == true {
            sync::reread(&mut r, &provider, now)?;
            return Ok(json!({"queued": true}));
        }
        let st = sync::load_state(&r, &provider)?;
        if st["lastRun"]
            .as_i64()
            .is_some_and(|t| now - t < SYNC_NOW_EVERY)
        {
            return Ok(json!({"queued": false}));
        }
        sync::queue(&mut r, &provider, now)?;
        Ok(json!({"queued": true}))
    }

    /// Plugin `plugin`'s secret was saved or cleared (Settings › Tasks): when it is the active
    /// provider, a rejected token no longer stops its calls, and a sync is queued now.
    pub(crate) fn task_secret_saved(&self, plugin: &str) -> Result<()> {
        let now = super::models::now();
        let mut r = self.repo()?;
        let provider = active_provider(&r.settings()?).to_string();
        if provider != format!("plugin:{plugin}") {
            return Ok(());
        }
        let mut st = sync::load_state(&r, &provider)?;
        if st["state"] == "needs_token" {
            st["state"] = "ready".into();
            sync::save_state(&mut r, &provider, &st, now)?;
        }
        sync::queue(&mut r, &provider, now)
    }

    /// Another setting of plugin `plugin` was saved (its project, say): when it is the active
    /// provider, it is read again in full (`sync::reread`), so the new project's tasks come in
    /// and the old one's leave the cache.
    pub(crate) fn task_setting_saved(&self, plugin: &str) -> Result<()> {
        let mut r = self.repo()?;
        let provider = active_provider(&r.settings()?).to_string();
        if provider != format!("plugin:{plugin}") {
            return Ok(());
        }
        sync::reread(&mut r, &provider, super::models::now())
    }

    /// The background loop's part (window open or closed): every 5 minutes, a sync with the
    /// active provider, and finished sync jobs older than a day go.
    pub(crate) fn task_sync_round(&self, now: i64) -> Result<()> {
        let mut r = self.repo()?;
        let provider = active_provider(&r.settings()?).to_string();
        if provider == "local" {
            return Ok(());
        }
        // Queued, running, or due in the last 5 minutes whatever became of it: a run that failed
        // before writing its state is not queued again every round.
        let busy = r.jobs()?.iter().any(|j| {
            j.kind == sync::JOB_KIND
                && j.payload["provider"] == provider.as_str()
                && (matches!(j.state.as_str(), "queued" | "running")
                    || j.due_at > now - BACKGROUND_EVERY)
        });
        let st = sync::load_state(&r, &provider)?;
        if !busy
            && st["lastRun"]
                .as_i64()
                .is_none_or(|t| now - t >= BACKGROUND_EVERY)
        {
            r.prune_finished_jobs(&[sync::JOB_KIND], now - 86_400)?;
            sync::queue(&mut r, &provider, now)?;
        }
        Ok(())
    }

    /// Builds the snapshot's `taskProvider` (design §2): the active provider, every available
    /// one (each with its own `pending` count, ruling 16: "<n> changes wait for Todoist" while
    /// Local is chosen reads an inactive provider's own entry), its state, the outbox counts and
    /// whether a copy was already offered. Never a secret: a refusal sentence holding one reads
    /// as `null`.
    pub(crate) fn task_provider_snapshot(&self, settings: &Settings) -> Value {
        let active = active_provider(settings).to_string();
        let r = self.repo().ok();
        let mut available = vec![json!({"id": "local", "name": "Connect"})];
        let listed = self
            .task_providers
            .get()
            .map(|p| p.available())
            .unwrap_or_default();
        for p in &listed {
            let pending = r
                .as_deref()
                .and_then(|r| outbox::counts(r, &p.id).ok())
                .map_or(0, |(pending, _)| pending);
            available.push(json!({"id": p.id, "name": p.name, "on": p.on, "ready": p.ready, "pending": pending}));
        }
        let name = available
            .iter()
            .find(|p| p["id"] == active)
            .and_then(|p| p["name"].as_str())
            .unwrap_or("Connect")
            .to_string();
        let copy_offered = settings.tasks.copy_offered.iter().any(|p| p == &active);
        let mut part = json!({
            "active": active,
            "name": name,
            "available": available,
            "state": ProviderState::Local.as_str(),
            "pending": 0,
            "parked": 0,
            "lastSync": Value::Null,
            "retryAt": Value::Null,
            "message": Value::Null,
            "copyOffered": copy_offered,
        });
        if active == "local" {
            return part;
        }
        let (st, (pending, parked), syncing) = match r.as_deref() {
            Some(r) => (
                sync::load_state(r, &active).unwrap_or_default(),
                outbox::counts(r, &active).unwrap_or_default(),
                sync::running(r, &active, super::models::now()).unwrap_or(false),
            ),
            None => (Value::Null, (0, 0), false),
        };
        let loading = self.task_providers.get().is_some_and(|p| p.loading());
        let state = match listed.iter().find(|p| p.id == active) {
            None if loading => ProviderState::Loading,
            None => ProviderState::Failed,
            Some(p) if !p.on => ProviderState::Off,
            Some(p) if !p.ready && loading => ProviderState::Loading,
            Some(p) if !p.ready => ProviderState::Failed,
            Some(_) if syncing => ProviderState::Syncing,
            Some(_) => ProviderState::of(st["state"].as_str().unwrap_or("ready")),
        };
        let retry_at = match state {
            ProviderState::Offline | ProviderState::RateLimited => st["backoffUntil"].clone(),
            _ => Value::Null,
        };
        let plugin = active.strip_prefix("plugin:").unwrap_or_default();
        let message = st["message"].as_str().filter(|m| {
            self.task_providers
                .get()
                .is_some_and(|p| !p.secret_matches(plugin, m))
        });
        part["state"] = state.as_str().into();
        part["pending"] = pending.into();
        part["parked"] = parked.into();
        part["lastSync"] = st["lastSync"].clone();
        part["retryAt"] = retry_at;
        part["message"] = message.map_or(Value::Null, Value::from);
        part
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_error_parses_the_prefixes() {
        assert_eq!(
            ProviderError::parse("needs_token: x"),
            ProviderError::NeedsToken
        );
        assert_eq!(
            ProviderError::parse("rate_limited:120: slow"),
            ProviderError::RateLimited { retry_after: 120 }
        );
        assert_eq!(ProviderError::parse("offline: x"), ProviderError::Offline);
        assert_eq!(
            ProviderError::parse("not_found: gone"),
            ProviderError::NotFound("gone".into())
        );
        assert_eq!(
            ProviderError::parse("refused: Todoist didn't accept the change (400)"),
            ProviderError::Refused("Todoist didn't accept the change (400)".into())
        );
        assert_eq!(ProviderError::parse("boom"), ProviderError::Offline);
    }

    /// I1: at start, or right after a reload is asked for, the plugin hasn't finished loading
    /// yet. That is not the same as a load that ran and failed.
    #[test]
    fn a_still_loading_plugin_is_not_called_failed() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::workspace::test_core(
            dir.path(),
            std::sync::Arc::new(crate::ai::fake::FakeRunner::new(vec![])),
            crate::workspace::ai::tests::ready(),
        );
        let provider = std::sync::Arc::new(fake::FakeProvider::new());
        provider.set_available(vec![ProviderInfo {
            id: "plugin:todoist".into(),
            name: "Todoist".into(),
            on: true,
            ready: false,
        }]);
        provider.set_loading(true);
        core.set_task_providers(provider.clone());

        let mut settings = Settings::default();
        settings.tasks.provider = "plugin:todoist".into();

        assert_eq!(
            core.task_provider_snapshot(&settings)["state"],
            "loading",
            "still loading is not failed"
        );

        // Once the manager has settled and the plugin is still not ready, it genuinely failed.
        provider.set_loading(false);
        assert_eq!(core.task_provider_snapshot(&settings)["state"], "failed");
    }

    /// I1: a provider not even listed yet (the registry hasn't been read, or the reload hasn't
    /// made it on, so `available()` is still empty) is the same "not failed while loading" case.
    #[test]
    fn an_unlisted_plugin_is_not_called_failed_while_loading() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::workspace::test_core(
            dir.path(),
            std::sync::Arc::new(crate::ai::fake::FakeRunner::new(vec![])),
            crate::workspace::ai::tests::ready(),
        );
        let provider = std::sync::Arc::new(fake::FakeProvider::new());
        provider.set_available(vec![]);
        provider.set_loading(true);
        core.set_task_providers(provider.clone());

        let mut settings = Settings::default();
        settings.tasks.provider = "plugin:todoist".into();

        assert_eq!(core.task_provider_snapshot(&settings)["state"], "loading");

        provider.set_loading(false);
        assert_eq!(core.task_provider_snapshot(&settings)["state"], "failed");
    }
}
