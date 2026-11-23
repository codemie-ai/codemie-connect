//! The task-provider contract (design `docs/superpowers/specs/2026-11-23-task-provider-design.md`
//! §5, §1): one provider is active at a time. The built-in **Local** provider (Connect's own
//! board) is the default; a plugin that declares `"provides": ["tasks"]` can become the active
//! provider instead. This module gives `Core` its way into a provider plugin's host half
//! (`TaskProviders`), the settings and snapshot plumbing (`active_provider`,
//! `Core::task_provider_snapshot`), and the keys that make a create idempotent (`keys`).
//!
//! This step (Task 1 of the plan) wires the trait and the snapshot for **Local only**: no plugin
//! implements `TaskProviders` yet (Task 2), and there is no outbox or sync job yet (Task 4).
use super::models::Settings;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) mod keys;

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
#[allow(dead_code)] // only Local and Off are built yet; Task 3 maps a real provider onto the rest
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
        }
    }
}

/// Connect's way into a provider plugin's host half (design §5): `call` reaches one of its
/// registered `tasks:<op>` functions, `available` lists every installed plugin that provides
/// tasks, and `secret_matches` keeps a plugin's token out of a log or error message. Implemented
/// by the plugin manager (Task 2); tests use a `FakeProvider`.
pub trait TaskProviders: Send + Sync {
    // Called from the outbox and sync job (Task 4), once a plugin manager implements this trait
    // (Task 2).
    #[allow(dead_code)]
    fn call(
        &self,
        plugin: &str,
        op: &str,
        args: Value,
    ) -> BoxFuture<'static, std::result::Result<Value, ProviderError>>;
    fn available(&self) -> Vec<ProviderInfo>;
    /// Whether `text` contains the plugin's stored secret.
    #[allow(dead_code)] // the log and error-message checks of design §8 call this (a later task)
    fn secret_matches(&self, plugin: &str, text: &str) -> bool;
}

/// The outcome of a provider call, mapped from the code a provider's thrown `Error` message
/// starts with (design §5 "Errors").
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // built by `parse`, read once the outbox and sync job (Task 4) call providers
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
    #[allow(dead_code)] // called once the outbox and sync job (Task 4) call providers
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
}

impl super::Core {
    /// Builds the snapshot's `taskProvider` (design §2): the active provider, every available
    /// one, its state, the outbox counts and whether a copy was already offered. This step
    /// (Task 1) answers for Local only; Task 3 fills in a real provider's `syncing` / `offline` /
    /// `rate_limited` / `needs_token` states and the outbox's `pending` / `parked` counts.
    pub(crate) fn task_provider_snapshot(&self, settings: &Settings) -> Value {
        let active = active_provider(settings).to_string();
        let mut available = vec![json!({"id": "local", "name": "Connect"})];
        if let Some(providers) = self.task_providers.get() {
            for p in providers.available() {
                available.push(json!({"id": p.id, "name": p.name, "on": p.on, "ready": p.ready}));
            }
        }
        let name = available
            .iter()
            .find(|p| p["id"] == active)
            .and_then(|p| p["name"].as_str())
            .unwrap_or("Connect")
            .to_string();
        // A plugin provider's real state (ready, syncing, offline, ...) is Task 3's; for now an
        // active provider that isn't Local (nothing can set one yet) reads as `off`.
        let state = if active == "local" {
            ProviderState::Local
        } else {
            ProviderState::Off
        };
        let copy_offered = settings.tasks.copy_offered.iter().any(|p| p == &active);
        json!({
            "active": active,
            "name": name,
            "available": available,
            "state": state.as_str(),
            "pending": 0,
            "parked": 0,
            "lastSync": Value::Null,
            "retryAt": Value::Null,
            "message": Value::Null,
            "copyOffered": copy_offered,
        })
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
}
