//! Reply in the user's voice (design `docs/superpowers/specs/2026-11-25-reply-voice-design.md`
//! §1, §2, §7): the `reply-context` plugin role gives Connect a copy of how the user writes (a
//! style card), what it knows about the people it writes to (profiles) and its instructions per
//! sender, domain, topic or everyone. This module gives `Core` its way into a provider plugin's
//! host half (`VoiceProviders`), Settings › Your voice's own setting (`VoiceSettings`) and the
//! snapshot's `replyVoice` (`Core::voice_snapshot`). The copy itself — what a `voice_refresh` job
//! replaces in one transaction, and a draft later assembles from (a later task) — lives in
//! `copy`. Tests use `fake::FakeVoice`.
use super::models::Settings;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub mod copy;
#[cfg(any(test, feature = "test-support"))]
#[cfg_attr(not(test), allow(dead_code))] // no test outside the crate drives a voice provider yet
pub mod fake;

/// Settings › Your voice (design §7): which provider is active, app-wide like `tasks`, and
/// whether facts are looked up for each draft. Old settings without `voice` read as Off with
/// facts on (`Settings`'s container-level `#[serde(default)]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceSettings {
    /// `"off"` or `"plugin:<id>"`.
    pub provider: String,
    pub facts: bool,
}
impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            provider: "off".into(),
            facts: true,
        }
    }
}

/// One provider a plugin registers (design §1's `available`): its id (`"plugin:<id>"`), display
/// name, whether the plugin is turned on, whether it last answered `status` without error, and
/// whether it registered the `facts` op.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub on: bool,
    pub ready: bool,
    pub facts: bool,
}

/// `replyVoice.state` (design §7): what Settings › Your voice and the composer show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceState {
    Off,
    Loading,
    Ready,
    NeedsSetup,
    Unavailable,
}
impl VoiceState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::NeedsSetup => "needs_setup",
            Self::Unavailable => "unavailable",
        }
    }
}
/// No stored state is a natural zero value; a copy with none yet (or one that can't be read)
/// falls back to `unavailable`, same as a failed refresh (`copy::Meta`).
impl Default for VoiceState {
    fn default() -> Self {
        Self::Unavailable
    }
}

/// Connect's way into a provider plugin's host half (design §1): `call` reaches one of its
/// registered `replyContext:<op>` functions within `limit`, `available` lists every installed
/// plugin that provides `reply-context`, and `loading` says whether the plugin manager still has
/// a reload under way (so a provider that isn't `ready` yet isn't called failed, as
/// `task_provider::TaskProviders` does). Implemented by the plugin manager; tests use
/// `fake::FakeVoice`.
pub trait VoiceProviders: Send + Sync {
    /// Asks plugin `plugin`'s `replyContext:<op>`.
    fn call(
        &self,
        plugin: &str,
        op: &str,
        args: Value,
        limit: Duration,
    ) -> BoxFuture<'static, std::result::Result<Value, VoiceError>>;
    fn available(&self) -> Vec<VoiceInfo>;
    fn loading(&self) -> bool;
}

/// The outcome of a provider call, mapped from the code a provider's thrown `Error` message
/// starts with (design §1 "Errors").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceError {
    NeedsSetup,
    Refused(String),
    Unavailable,
}
impl VoiceError {
    /// Maps a provider's thrown message to its code; anything unrecognised (or a host
    /// `timeout`, or no answer within the limit) is `Unavailable`, since the copy is used
    /// instead. The rest of a `refused:` message, cut to 200 characters, is kept for a save.
    pub fn parse(message: &str) -> Self {
        const MAX: usize = 200;
        if message.strip_prefix("needs_setup:").is_some() {
            return Self::NeedsSetup;
        }
        if let Some(rest) = message.strip_prefix("refused:") {
            return Self::Refused(rest.trim().chars().take(MAX).collect());
        }
        Self::Unavailable
    }
}

impl super::Core {
    /// Builds the snapshot's `replyVoice` (design §7): the active provider, every installed one
    /// that provides `reply-context`, its state, whether facts are on and offered, and the
    /// copy's style (with its head), rules and people index — never a person's profile or about
    /// text (`people[]` carries `chars` and `aboutChars`, read in full with `voice_read`, a
    /// later task).
    ///
    /// State rules: `off` when the provider is `"off"`; `loading` when the plugin manager is
    /// still reloading and the provider plugin isn't ready yet; `unavailable` when the provider
    /// plugin is missing, turned off, or not ready (not reloading); otherwise the copy's own
    /// stored state (`ready` or `needs_setup`, else `unavailable` after a failed refresh).
    pub(crate) fn voice_snapshot(&self, settings: &Settings) -> Value {
        let provider = settings.voice.provider.clone();
        let listed = self
            .voice_providers
            .get()
            .map(|p| p.available())
            .unwrap_or_default();
        let available: Vec<Value> = listed
            .iter()
            .map(|p| json!({"id": p.id, "name": p.name, "on": p.on, "ready": p.ready, "facts": p.facts}))
            .collect();
        let name = listed
            .iter()
            .find(|p| p.id == provider)
            .map(|p| p.name.clone());
        let facts_offered = listed
            .iter()
            .find(|p| p.id == provider)
            .is_some_and(|p| p.facts);
        let r = self.repo().ok();
        let c = r.as_deref().and_then(|r| copy::read_copy(r).ok()).flatten();
        let loading = self.voice_providers.get().is_some_and(|p| p.loading());
        let state = if provider == "off" {
            VoiceState::Off
        } else {
            match listed.iter().find(|p| p.id == provider) {
                None if loading => VoiceState::Loading,
                None => VoiceState::Unavailable,
                Some(p) if !p.on => VoiceState::Unavailable,
                Some(p) if !p.ready && loading => VoiceState::Loading,
                Some(p) if !p.ready => VoiceState::Unavailable,
                Some(_) => c.as_ref().map_or(VoiceState::Unavailable, |c| c.state),
            }
        };
        json!({
            "provider": provider,
            "name": name,
            "state": state.as_str(),
            "available": available,
            "facts": {"on": settings.voice.facts, "offered": facts_offered},
            "refreshedAt": c.as_ref().map(|c| c.refreshed_at),
            "copy": c.is_some(),
            "style": c.as_ref().and_then(|c| c.style.clone()),
            "rules": c.as_ref().map(|c| c.rules.clone()).unwrap_or_default(),
            "people": c.as_ref().map_or_else(Vec::new, |c| c.people.iter().map(copy::person_summary).collect::<Vec<_>>()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::ai::tests::ready;
    use std::sync::Arc;

    #[test]
    fn voice_error_parses_codes() {
        assert_eq!(VoiceError::parse("needs_setup: x"), VoiceError::NeedsSetup);
        assert_eq!(
            VoiceError::parse("refused: The page changed"),
            VoiceError::Refused("The page changed".into())
        );
        assert_eq!(VoiceError::parse("boom"), VoiceError::Unavailable);
    }

    #[test]
    fn old_settings_read_as_off_with_facts_on() {
        let s: Settings = serde_json::from_str(r#"{"syncDays":7}"#).unwrap();
        assert_eq!(s.voice.provider, "off");
        assert!(s.voice.facts, "no \"voice\" at all reads facts as on");

        let s: Settings = serde_json::from_str(r#"{"voice":{"provider":"plugin:x"}}"#).unwrap();
        assert_eq!(s.voice.provider, "plugin:x");
        assert!(
            s.voice.facts,
            "an old voice shape with no \"facts\" reads it as on"
        );

        let dir = tempfile::tempdir().unwrap();
        let core =
            crate::workspace::test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let snapshot = core.voice_snapshot(&Settings::default());
        assert_eq!(snapshot["state"], "off");
        assert_eq!(snapshot["copy"], false);
    }

    /// A profile holding a sentinel in its `text` or `about` never reaches the snapshot:
    /// `people[]` carries `chars` and `aboutChars`, not the text (design §7, global constraint
    /// "no voice text in a log, a smoke report ... or a real-data fixture").
    #[test]
    fn snapshot_never_carries_profile_or_about_text() {
        const SENTINEL: &str = "VOICE_SENTINEL_9f3a";
        let dir = tempfile::tempdir().unwrap();
        let core =
            crate::workspace::test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let person = copy::Person {
            id: "priya-n".into(),
            name: "Priya N.".into(),
            names: vec!["Priya".into()],
            addresses: vec!["priya.n@example.test".into()],
            ids: vec!["t-1".into()],
            text: format!("Product lead. {SENTINEL}"),
            about: format!("Prefers mornings. {SENTINEL}"),
            updated_at: "2026-11-24T09:00:00Z".into(),
            source: "People/priya-n.md".into(),
        };
        let chars = person.text.chars().count();
        let about_chars = person.about.chars().count();
        let c = copy::Copy {
            provider: "plugin:knowledge".into(),
            refreshed_at: 0,
            state: VoiceState::Ready,
            style: None,
            rules: Vec::new(),
            people: vec![person],
        };
        copy::replace(&mut core.repo().unwrap(), "plugin:knowledge", &c, 100).unwrap();

        let mut settings = Settings::default();
        settings.voice.provider = "plugin:knowledge".into();
        let fake = Arc::new(fake::FakeVoice::new());
        fake.set_available(vec![VoiceInfo {
            id: "plugin:knowledge".into(),
            name: "Knowledge".into(),
            on: true,
            ready: true,
            facts: true,
        }]);
        core.set_voice_providers(fake);

        let snapshot = core.voice_snapshot(&settings);
        assert_eq!(snapshot["people"][0]["chars"], chars);
        assert_eq!(snapshot["people"][0]["aboutChars"], about_chars);
        assert_eq!(snapshot["people"][0]["ids"], 1);
        assert!(snapshot["people"][0].get("text").is_none());
        assert!(snapshot["people"][0].get("about").is_none());
        let text = serde_json::to_string(&snapshot).unwrap();
        assert!(!text.contains(SENTINEL), "the sentinel leaked: {text}");
    }

    /// Settings › Your voice's facts checkbox (`facts.on`) and whether the chosen provider
    /// offers facts at all (`facts.offered`, its `available[].facts`), design §7.
    #[test]
    fn snapshot_says_whether_facts_are_on_and_offered() {
        let dir = tempfile::tempdir().unwrap();
        let core =
            crate::workspace::test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let fake = Arc::new(fake::FakeVoice::new());
        core.set_voice_providers(fake.clone());

        let mut settings = Settings::default();
        settings.voice.provider = "plugin:knowledge".into();
        settings.voice.facts = false;
        fake.set_available(vec![VoiceInfo {
            id: "plugin:knowledge".into(),
            name: "Knowledge".into(),
            on: true,
            ready: true,
            facts: true,
        }]);
        let snapshot = core.voice_snapshot(&settings);
        assert_eq!(snapshot["facts"]["on"], false, "the checkbox is off");
        assert_eq!(
            snapshot["facts"]["offered"], true,
            "the provider offers facts"
        );

        settings.voice.facts = true;
        fake.set_available(vec![VoiceInfo {
            id: "plugin:knowledge".into(),
            name: "Knowledge".into(),
            on: true,
            ready: true,
            facts: false,
        }]);
        let snapshot = core.voice_snapshot(&settings);
        assert_eq!(snapshot["facts"]["on"], true, "the checkbox is on");
        assert_eq!(
            snapshot["facts"]["offered"], false,
            "the provider's available[].facts is false"
        );
    }

    fn sample_copy() -> copy::Copy {
        copy::Copy {
            provider: "plugin:knowledge".into(),
            refreshed_at: 1_764_000_000,
            state: VoiceState::Ready,
            style: Some(copy::Style {
                text: "Short and direct.\n\n## Mail\nOpens with \"Hi\".\n\n## Teams\nNo greeting.\n\n## Teams · ru\nБез приветствия."
                    .into(),
                updated_at: "2026-11-24T09:00:00Z".into(),
                source: "Voice/style.md".into(),
                based_on: Some(copy::BasedOn {
                    mail: 12,
                    teams: 140,
                }),
                head: Some(copy::StyleHead {
                    text: "Prefers short replies and plain words.".into(),
                    source: "people/me.md".into(),
                }),
            }),
            rules: vec![
                copy::Rule {
                    id: "to-priya-n-example-test".into(),
                    applies: copy::Applies {
                        kind: copy::AppliesKind::To,
                        value: Some("priya.n@example.test".into()),
                        channel: None,
                    },
                    text: "Short, bullet points.".into(),
                    source: "Voice/rules.md".into(),
                    editable: true,
                },
                copy::Rule {
                    id: "chat-platform-review".into(),
                    applies: copy::Applies {
                        kind: copy::AppliesKind::Chat,
                        value: Some("Platform review".into()),
                        channel: None,
                    },
                    text: "Terse, lower case.".into(),
                    source: "Voice/rules.md".into(),
                    editable: true,
                },
                copy::Rule {
                    id: "domain-bank-example-test".into(),
                    applies: copy::Applies {
                        kind: copy::AppliesKind::Domain,
                        value: Some("bank.example.test".into()),
                        channel: Some(copy::RuleChannel::Mail),
                    },
                    text: "Formal, full sentences.".into(),
                    source: "Voice/rules.md".into(),
                    editable: true,
                },
                copy::Rule {
                    id: "topic-budget-request".into(),
                    applies: copy::Applies {
                        kind: copy::AppliesKind::Topic,
                        value: Some("budget request".into()),
                        channel: None,
                    },
                    text: "Ask for the project code.".into(),
                    source: "Voice/rules.md".into(),
                    editable: true,
                },
                copy::Rule {
                    id: "no-profile-teams".into(),
                    applies: copy::Applies {
                        kind: copy::AppliesKind::NoProfile,
                        value: None,
                        channel: Some(copy::RuleChannel::Teams),
                    },
                    text: "Polite, full sentences.".into(),
                    source: "Voice/rules.md".into(),
                    editable: true,
                },
                copy::Rule {
                    id: "everyone".into(),
                    applies: copy::Applies {
                        kind: copy::AppliesKind::Everyone,
                        value: None,
                        channel: None,
                    },
                    text: "Never promise a date.".into(),
                    source: "Voice/rules.md".into(),
                    editable: true,
                },
            ],
            people: vec![
                copy::Person {
                    id: "priya-n".into(),
                    name: "Priya N.".into(),
                    names: vec!["Priya".into(), "Priya Nair".into()],
                    addresses: vec!["priya.n@example.test".into()],
                    ids: Vec::new(),
                    text: "Product lead at the bank; prefers mornings.".into(),
                    about: "Product lead, platform team.".into(),
                    updated_at: "2026-11-24T09:00:00Z".into(),
                    source: "People/priya-n.md".into(),
                },
                copy::Person {
                    id: "jordan-lee".into(),
                    name: "Jordan Lee".into(),
                    names: Vec::new(),
                    addresses: vec!["jordan@example.test".into()],
                    ids: Vec::new(),
                    text: "Engineering manager.".into(),
                    about: String::new(),
                    updated_at: "2026-11-24T09:00:00Z".into(),
                    source: "People/jordan-lee.md".into(),
                },
                copy::Person {
                    id: "marek-novak".into(),
                    name: "Marek Novak".into(),
                    names: Vec::new(),
                    addresses: Vec::new(),
                    ids: vec!["00000000-0000-4000-8000-00000000a003".into()],
                    text: "Finance contact.".into(),
                    about: String::new(),
                    updated_at: "2026-11-24T09:00:00Z".into(),
                    source: "People/marek-novak.md".into(),
                },
            ],
        }
    }

    /// A finished `replyVoice` part of the real snapshot for each state (design §7). Regenerate
    /// with `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
    #[tokio::test]
    async fn contract_fixtures_match_the_voice_states() {
        let mut states = serde_json::Map::new();
        let dir = tempfile::tempdir().unwrap();
        let core =
            crate::workspace::test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let fake = Arc::new(fake::FakeVoice::new());
        core.set_voice_providers(fake.clone());

        // off: no provider chosen, no copy kept yet.
        let off = Settings::default();
        states.insert("off".into(), core.voice_snapshot(&off));

        // offWithCopy: still off, but a copy is kept from an earlier choice.
        copy::replace(
            &mut core.repo().unwrap(),
            "plugin:knowledge",
            &sample_copy(),
            1_764_000_000,
        )
        .unwrap();
        states.insert("offWithCopy".into(), core.voice_snapshot(&off));

        let mut chosen = Settings::default();
        chosen.voice.provider = "plugin:knowledge".into();
        fake.set_available(vec![VoiceInfo {
            id: "plugin:knowledge".into(),
            name: "Knowledge".into(),
            on: true,
            ready: true,
            facts: true,
        }]);

        // ready: the plugin is on and ready, and the copy's own state is Ready.
        states.insert("ready".into(), core.voice_snapshot(&chosen));

        // noFacts: same as ready, but the provider doesn't offer facts.
        fake.set_available(vec![VoiceInfo {
            id: "plugin:knowledge".into(),
            name: "Knowledge".into(),
            on: true,
            ready: true,
            facts: false,
        }]);
        states.insert("noFacts".into(), core.voice_snapshot(&chosen));
        fake.set_available(vec![VoiceInfo {
            id: "plugin:knowledge".into(),
            name: "Knowledge".into(),
            on: true,
            ready: true,
            facts: true,
        }]);

        // needsSetup: a failed refresh recorded `needs_setup` on the copy.
        copy::set_state(
            &mut core.repo().unwrap(),
            "plugin:knowledge",
            VoiceState::NeedsSetup,
            1_764_000_600,
        )
        .unwrap();
        states.insert("needsSetup".into(), core.voice_snapshot(&chosen));

        // unavailable: a failed refresh recorded `unavailable` on the copy.
        copy::set_state(
            &mut core.repo().unwrap(),
            "plugin:knowledge",
            VoiceState::Unavailable,
            1_764_001_200,
        )
        .unwrap();
        states.insert("unavailable".into(), core.voice_snapshot(&chosen));

        // pluginOff: the plugin is installed but turned off in Settings › Plugins.
        fake.set_available(vec![VoiceInfo {
            id: "plugin:knowledge".into(),
            name: "Knowledge".into(),
            on: false,
            ready: false,
            facts: false,
        }]);
        states.insert("pluginOff".into(), core.voice_snapshot(&chosen));

        // loading: the plugin manager hasn't finished loading it yet (not a failure, I1).
        fake.set_available(Vec::new());
        fake.set_loading(true);
        states.insert("loading".into(), core.voice_snapshot(&chosen));

        crate::plugins::testkit::contract_fixture("voice-states.json", &Value::Object(states));
    }
}
