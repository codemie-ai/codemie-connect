//! The voice operations (reply-voice design §6, §7, rulings 11–13): `voice_set` (choose Off or
//! a provider, and facts on or off), `voice_save` and `voice_delete` (edits go through the
//! provider, no outbox), `voice_forget` (Delete Connect's copy) and `voice_read` (one person's
//! profile from the copy). Removing the chosen provider plugin also deletes the copy
//! (`Core::voice_plugin_removed`).
//!
//! `voice_save` and `voice_delete` ask the provider **before** the mutation lock (`voice_ask`,
//! the `AiSettingsSave` detection pattern: never await a plugin call under the lock); the locked
//! part (`voice_op`) writes its answer into the copy and queues a refresh. Choosing Off keeps the
//! copy; Delete Connect's copy turns the voice off and deletes it; another provider, or removing
//! the plugin, deletes it (ruling 12).
use super::{copy, refresh, VoiceError};
use crate::workspace::models::{now, Operation, Request, Result, WorkspaceError};
use crate::workspace::repository::Repository;
use crate::workspace::Core;
use serde_json::{json, Value};
use std::time::Duration;

/// `save` and `remove`'s limit (design §1).
const SAVE_LIMIT: Duration = Duration::from_secs(10);
const STYLE_MAX: usize = 8_000;
const RULE_MAX: usize = 2_000;
const ID_MAX: usize = 200;

const UNKNOWN: &str = "Choose Off or an installed reply-context plugin.";
const OFF: &str = "Choose where your voice comes from first.";
const APPLIES: &str = "Say what the instruction applies to.";
const RULE_TEXT: &str = "Write what to do, up to 2,000 characters.";
const STYLE_TEXT: &str = "Keep the style card under 8,000 characters.";

fn invalid(field: &str, message: &str) -> WorkspaceError {
    let mut e = WorkspaceError::new("validation", message);
    e.field = Some(field.into());
    e
}

/// The bare plugin id `VoiceProviders::call` takes, from the setting's `"plugin:<id>"`.
pub(crate) fn plugin_of(provider: &str) -> &str {
    provider.strip_prefix("plugin:").unwrap_or(provider)
}

/// The provider's display name, or its plugin id when it isn't listed.
fn name_of(core: &Core, provider: &str) -> String {
    core.voice_providers
        .get()
        .map(|p| p.available())
        .unwrap_or_default()
        .into_iter()
        .find(|p| p.id == provider)
        .map_or_else(|| plugin_of(provider).to_string(), |p| p.name)
}

fn unanswered(name: &str) -> WorkspaceError {
    WorkspaceError::new(
        "unavailable",
        format!("{name} isn't answering, so nothing was saved. Try again."),
    )
}

/// `applies` as the provider gets it: a known kind, a value for the kinds that need one, and
/// an optional `mail` or `teams` channel.
fn applies(v: &Value) -> Result<Value> {
    let bad = || invalid("applies", APPLIES);
    let kind = v["kind"].as_str().ok_or_else(bad)?;
    let needs_value = match kind {
        "to" | "chat" | "domain" | "topic" => true,
        "no-profile" | "everyone" => false,
        _ => return Err(bad()),
    };
    let mut out = json!({"kind": kind});
    if needs_value {
        let value = v["value"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(bad)?;
        out["value"] = json!(value);
    }
    match &v["channel"] {
        Value::Null => {}
        Value::String(c) if c == "mail" || c == "teams" => out["channel"] = json!(c),
        _ => return Err(bad()),
    }
    Ok(out)
}

/// `voice_save`'s input checked (design §7's field errors): the `save` kind and the arguments the
/// provider gets.
fn validate_save(data: &Value) -> Result<(&'static str, Value)> {
    match data["kind"].as_str() {
        Some("style") => {
            let text = data["text"]
                .as_str()
                .filter(|t| t.chars().count() <= STYLE_MAX)
                .ok_or_else(|| invalid("text", STYLE_TEXT))?;
            Ok(("style", json!({"text": text})))
        }
        Some("rule") => {
            let id = match &data["id"] {
                Value::Null => Value::Null,
                Value::String(s) if !s.is_empty() && s.chars().count() <= ID_MAX => json!(s),
                _ => return Err(invalid("id", "Choose an instruction.")),
            };
            let applies = applies(&data["applies"])?;
            let text = data["text"]
                .as_str()
                .map(str::trim)
                .filter(|t| !t.is_empty() && t.chars().count() <= RULE_MAX)
                .ok_or_else(|| invalid("text", RULE_TEXT))?;
            Ok(("rule", json!({"id": id, "applies": applies, "text": text})))
        }
        _ => Err(invalid("kind", "Choose the style card or an instruction.")),
    }
}

/// Asks the chosen provider's `op` within 10 s; answers the provider and its answer. A refusal
/// reads "<name> didn't save it: <sentence>", no answer "<name> isn't answering, so nothing was
/// saved. Try again." (design §7).
async fn through(core: &Core, op: &str, args: Value) -> Result<(String, Value)> {
    let provider = core.repo()?.settings()?.voice.provider;
    if provider == "off" {
        return Err(invalid("provider", OFF));
    }
    let name = name_of(core, &provider);
    let Some(providers) = core.voice_providers.get() else {
        return Err(unanswered(&name));
    };
    let call = providers.call(plugin_of(&provider), op, args, SAVE_LIMIT);
    match tokio::time::timeout(SAVE_LIMIT, call).await {
        Ok(Ok(answer)) => Ok((provider, answer)),
        Ok(Err(VoiceError::Refused(sentence))) => Err(WorkspaceError::new(
            "refused",
            if sentence.is_empty() {
                format!("{name} didn't save it.")
            } else {
                format!("{name} didn't save it: {sentence}")
            },
        )),
        Ok(Err(VoiceError::NeedsSetup)) => Err(WorkspaceError::new(
            "needs_setup",
            format!("Choose its folder in {name} first."),
        )),
        Ok(Err(VoiceError::Unavailable)) | Err(_) => Err(unanswered(&name)),
    }
}

/// The before-the-lock `save` through the chosen provider (design §7): `kind` is `style`,
/// `rule` or `rules` (the import, a later task), `args` the rest of the provider's input.
/// Answers the provider's answer: the saved item.
pub(crate) async fn save_through(core: &Core, kind: &str, args: Value) -> Result<Value> {
    let mut args = args;
    args["kind"] = json!(kind);
    through(core, "save", args).await.map(|(_, answer)| answer)
}

/// What the provider answered before the lock, for the locked part to write into the copy.
pub(crate) struct Asked {
    provider: String,
    kind: &'static str,
    answer: Value,
    removed: Option<copy::Rule>,
}

fn rule_id(data: &Value) -> Result<&str> {
    data["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.chars().count() <= ID_MAX)
        .ok_or_else(|| invalid("id", "Choose an instruction."))
}

/// `voice_set {provider, facts?}`: chooses Off or a listed, turned-on plugin, and facts on or
/// off. A plugin whose copy isn't kept (another provider's copy, or none) starts from an empty
/// copy and a refresh is queued; a facts-only change queues nothing. Off keeps the copy.
fn set(core: &Core, r: &mut Repository, data: &Value, now: i64) -> Result<Value> {
    let provider = data["provider"]
        .as_str()
        .ok_or_else(|| invalid("provider", UNKNOWN))?;
    if provider != "off" {
        let listed = core
            .voice_providers
            .get()
            .map(|p| p.available())
            .unwrap_or_default();
        let info = listed
            .iter()
            .find(|p| p.id == provider)
            .ok_or_else(|| invalid("provider", UNKNOWN))?;
        if !info.on {
            return Err(invalid(
                "provider",
                &format!("Turn {} on in Settings › Plugins first.", info.name),
            ));
        }
    }
    let facts = match &data["facts"] {
        Value::Null => None,
        Value::Bool(on) => Some(*on),
        _ => return Err(invalid("facts", "Choose whether to add facts.")),
    };
    let mut s = r.settings()?;
    let switched = s.voice.provider != provider;
    if provider != "off" && copy::read_copy(r)?.is_none_or(|c| c.provider != provider) {
        // The copy came from another provider (ruling 12).
        let gone = copy::forget(r)?;
        if gone > 0 {
            log::info!("voice: another provider chosen, copy deleted ({gone} records)");
        }
    }
    s.voice.provider = provider.into();
    if let Some(on) = facts {
        s.voice.facts = on;
    }
    r.settings_update(&s)?;
    if provider != "off" && switched {
        refresh::queue(r, provider, now)?;
    }
    Ok(json!({"provider": provider, "facts": s.voice.facts}))
}

/// `voice_forget {}` (design §6): sets Off, then deletes every copy record; nothing in the
/// provider's folder is touched.
fn forget(r: &mut Repository) -> Result<Value> {
    let mut s = r.settings()?;
    s.voice.provider = "off".into();
    r.settings_update(&s)?;
    let deleted = copy::forget(r)?;
    log::info!("voice: copy deleted ({deleted} records)");
    Ok(json!({"deleted": deleted, "provider": "off"}))
}

impl Core {
    /// `voice_save` and `voice_delete`'s provider call, made before the mutation lock: the input
    /// is checked first, so a refused input asks the provider nothing.
    pub(in crate::workspace) async fn voice_ask(&self, req: &Request) -> Result<Asked> {
        match req.op {
            Operation::VoiceSave => {
                let (kind, args) = validate_save(&req.data)?;
                let mut args = args;
                args["kind"] = json!(kind);
                let (provider, answer) = through(self, "save", args).await?;
                Ok(Asked {
                    provider,
                    kind,
                    answer,
                    removed: None,
                })
            }
            Operation::VoiceDelete => {
                let id = rule_id(&req.data)?;
                let rule = copy::read_copy(&*self.repo()?)?
                    .and_then(|c| c.rules.into_iter().find(|rule| rule.id == id))
                    .ok_or_else(|| {
                        WorkspaceError::new("not_found", "This instruction is no longer there.")
                    })?;
                let (provider, _) =
                    through(self, "remove", json!({"kind": "rule", "id": id})).await?;
                Ok(Asked {
                    provider,
                    kind: "rule",
                    answer: Value::Null,
                    removed: Some(rule),
                })
            }
            _ => Err(WorkspaceError::new("validation", "Unsupported operation.")),
        }
    }

    /// The locked part of `voice_set`, `voice_save`, `voice_delete` and `voice_forget`. A save or
    /// delete whose provider is no longer the chosen one (switched while it was asked) leaves the
    /// copy alone.
    pub(in crate::workspace) fn voice_op(
        &self,
        req: &Request,
        asked: Option<Asked>,
    ) -> Result<Value> {
        let now = now();
        let mut r = self.repo()?;
        match req.op {
            Operation::VoiceSet => set(self, &mut r, &req.data, now),
            Operation::VoiceForget => forget(&mut r),
            Operation::VoiceSave | Operation::VoiceDelete => {
                let asked = asked
                    .ok_or_else(|| WorkspaceError::new("validation", "Unsupported operation."))?;
                let chosen = r.settings()?.voice.provider == asked.provider;
                if let Some(rule) = asked.removed {
                    if chosen {
                        copy::remove_rule(&mut r, &rule.id)?;
                        refresh::queue(&mut r, &asked.provider, now)?;
                    }
                    return Ok(json!({"removed": rule}));
                }
                let item = if chosen {
                    let item =
                        copy::put_saved(&mut r, &asked.provider, asked.kind, &asked.answer, now)?;
                    refresh::queue(&mut r, &asked.provider, now)?;
                    item
                } else {
                    Value::Null
                };
                Ok(json!({"item": item}))
            }
            _ => Err(WorkspaceError::new("validation", "Unsupported operation.")),
        }
    }

    /// `voice_read {id}` (read-only): one person's profile from the copy,
    /// `{id, name, text, about, source}`.
    pub(in crate::workspace) fn voice_read(&self, req: &Request) -> Result<Value> {
        let id = req.data["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.chars().count() <= ID_MAX)
            .ok_or_else(|| invalid("id", "Choose a person."))?;
        let person = copy::read_copy(&*self.repo()?)?
            .and_then(|c| c.people.into_iter().find(|p| p.id == id))
            .ok_or_else(|| {
                WorkspaceError::new("not_found", "This person is no longer in Connect's copy.")
            })?;
        Ok(json!({
            "id": person.id,
            "name": person.name,
            "text": person.text,
            "about": person.about,
            "source": person.source,
        }))
    }

    /// Plugin `plugin` was removed (Settings › Plugins): when it is the chosen provider the voice
    /// turns Off, and when it is (or its copy is kept) the copy is deleted (design §6).
    pub(crate) fn voice_plugin_removed(&self, plugin: &str) -> Result<()> {
        let provider = format!("plugin:{plugin}");
        let mut r = self.repo()?;
        let mut s = r.settings()?;
        let chosen = s.voice.provider == provider;
        let owned = copy::read_copy(&r)?.is_some_and(|c| c.provider == provider);
        if !chosen && !owned {
            return Ok(());
        }
        if chosen {
            s.voice.provider = "off".into();
            r.settings_update(&s)?;
        }
        let deleted = copy::forget(&mut r)?;
        log::info!("voice: provider removed, copy deleted ({deleted} records)");
        drop(r);
        self.emit("workspace:changed");
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::fake::FakeVoice;
    use super::super::{VoiceInfo, VoiceState};
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::ai::tests::{mutation, ready};
    use crate::workspace::test_core;
    use std::sync::Arc;

    pub(crate) const KNOWLEDGE: &str = "plugin:knowledge";
    const SENTINEL: &str = "VOICE_SENTINEL_9f3a";

    pub(crate) struct Env {
        _dir: tempfile::TempDir,
        pub(crate) core: Arc<Core>,
        pub(crate) fake: Arc<FakeVoice>,
    }

    fn info(id: &str, name: &str, on: bool) -> VoiceInfo {
        VoiceInfo {
            id: id.into(),
            name: name.into(),
            on,
            ready: on,
            facts: true,
        }
    }

    /// A core with Knowledge (and Other) installed and on, the voice Off.
    pub(crate) fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let fake = Arc::new(FakeVoice::new());
        fake.set_available(vec![
            info(KNOWLEDGE, "Knowledge", true),
            info("plugin:other", "Other", true),
        ]);
        core.set_voice_providers(fake.clone());
        Env {
            _dir: dir,
            core,
            fake,
        }
    }

    /// An `export` answer with a style card, two instructions and three people; `extra` is
    /// added to the style card, a profile and an about.
    pub(crate) fn export_answer(extra: &str) -> Value {
        json!({
            "style": {"text": format!("Short and direct. {extra}"), "updatedAt": "2026-11-24T09:00:00Z",
                      "source": "Voice/style.md", "basedOn": {"mail": 12, "teams": 140}},
            "rules": [
                {"id": "to-priya-n-example-test", "applies": {"kind": "to", "value": "priya.n@example.test"},
                 "text": "Short, bullet points.", "source": "Voice/rules.md", "editable": true},
                {"id": "everyone", "applies": {"kind": "everyone"},
                 "text": "Never promise a date.", "source": "Voice/rules.md", "editable": true}
            ],
            "people": [
                {"id": "priya-n", "name": "Priya N.", "names": ["Priya"], "addresses": ["priya.n@example.test"],
                 "ids": [], "text": format!("Short sentences; no small talk. {extra}"),
                 "about": format!("Product lead; prefers mornings. {extra}"),
                 "updatedAt": "2026-11-24T09:00:00Z", "source": "People/priya-n.md"},
                {"id": "jordan-lee", "name": "Jordan Lee", "addresses": ["jordan@example.test"],
                 "text": "Engineering manager.", "updatedAt": "", "source": "People/jordan-lee.md"},
                {"id": "marek-novak", "name": "Marek Novak", "ids": ["00000000-0000-4000-8000-00000000a003"],
                 "text": "Finance contact.", "updatedAt": "", "source": "People/marek-novak.md"}
            ]
        })
    }

    impl Env {
        pub(crate) async fn op(&self, op: Operation, data: Value) -> Result<Value> {
            self.core.request(mutation(&self.core, op, data)).await
        }

        /// Claims and runs every due job, as the background loop does.
        pub(crate) async fn run_jobs(&self) {
            loop {
                let job = self.core.repo().unwrap().claim_ready(now(), true).unwrap();
                match job {
                    Some(job) => self.core.clone().run_claimed_job(job).await,
                    None => break,
                }
            }
        }

        pub(crate) fn copy(&self) -> Option<copy::Copy> {
            copy::read_copy(&self.core.repo().unwrap()).unwrap()
        }

        pub(crate) fn snapshot(&self) -> Value {
            let settings = self.core.repo().unwrap().settings().unwrap();
            self.core.voice_snapshot(&settings)
        }

        fn settings(&self) -> super::super::VoiceSettings {
            self.core.repo().unwrap().settings().unwrap().voice
        }

        fn refreshes_queued(&self) -> usize {
            self.core
                .repo()
                .unwrap()
                .jobs()
                .unwrap()
                .iter()
                .filter(|j| j.kind == refresh::JOB_KIND && j.state == "queued")
                .count()
        }

        fn calls_of(&self, op: &str) -> Vec<Value> {
            self.fake
                .calls()
                .into_iter()
                .filter(|(_, o, _)| o == op)
                .map(|(_, _, a)| a)
                .collect()
        }

        /// Chooses Knowledge and runs its first refresh, which fills the copy.
        pub(crate) async fn choose_with_copy(&self) {
            self.fake.answer("export", export_answer(""));
            self.op(Operation::VoiceSet, json!({"provider": KNOWLEDGE}))
                .await
                .unwrap();
            self.run_jobs().await;
        }
    }

    #[tokio::test]
    async fn choosing_a_provider_queues_a_refresh_that_fills_the_copy() {
        let e = env();
        assert_eq!(e.snapshot()["state"], "off");
        e.fake.answer("export", export_answer(""));
        let answer = e
            .op(Operation::VoiceSet, json!({"provider": KNOWLEDGE}))
            .await
            .unwrap();
        assert_eq!(answer, json!({"provider": KNOWLEDGE, "facts": true}));
        assert_eq!(e.refreshes_queued(), 1);
        e.run_jobs().await;
        let snap = e.snapshot();
        assert_eq!(snap["state"], "ready");
        assert_eq!(snap["people"].as_array().unwrap().len(), 3);
        assert_eq!(snap["rules"].as_array().unwrap().len(), 2);
        // The bare plugin id reaches the provider, never "plugin:".
        let calls = e.fake.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            (calls[0].0.as_str(), calls[0].1.as_str()),
            ("knowledge", "export")
        );
        let job = e
            .core
            .repo()
            .unwrap()
            .jobs()
            .unwrap()
            .into_iter()
            .find(|j| j.kind == refresh::JOB_KIND)
            .unwrap();
        assert_eq!(job.state, "succeeded");
        assert_eq!(job.result.as_deref(), Some("ready"));
    }

    #[tokio::test]
    async fn set_refuses_unknown_and_turned_off_plugins() {
        let e = env();
        for data in [
            json!({"provider": "plugin:nope"}),
            json!({"provider": 7}),
            json!({}),
        ] {
            let err = e.op(Operation::VoiceSet, data.clone()).await.unwrap_err();
            assert_eq!(err.message, UNKNOWN, "{data}");
            assert_eq!(err.field.as_deref(), Some("provider"));
        }
        e.fake
            .set_available(vec![info(KNOWLEDGE, "Knowledge", false)]);
        let err = e
            .op(Operation::VoiceSet, json!({"provider": KNOWLEDGE}))
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "Turn Knowledge on in Settings › Plugins first."
        );
        assert_eq!(e.settings().provider, "off");
        assert_eq!(e.refreshes_queued(), 0);
        // Off is always a choice.
        e.op(Operation::VoiceSet, json!({"provider": "off"}))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn set_saves_facts_and_keeps_the_copy() {
        let e = env();
        e.choose_with_copy().await;
        let before = e.copy().unwrap();
        let answer = e
            .op(
                Operation::VoiceSet,
                json!({"provider": KNOWLEDGE, "facts": false}),
            )
            .await
            .unwrap();
        assert_eq!(answer, json!({"provider": KNOWLEDGE, "facts": false}));
        assert!(!e.settings().facts);
        assert_eq!(e.copy().unwrap(), before, "the copy is kept");
        assert_eq!(
            e.refreshes_queued(),
            0,
            "a facts-only change refreshes nothing"
        );
        // Facts stay as they are when the input leaves them out.
        e.op(Operation::VoiceSet, json!({"provider": "off"}))
            .await
            .unwrap();
        assert!(!e.settings().facts);
        let err = e
            .op(
                Operation::VoiceSet,
                json!({"provider": "off", "facts": "yes"}),
            )
            .await
            .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("facts"));
    }

    #[tokio::test]
    async fn changing_provider_deletes_the_copy_but_off_keeps_it() {
        let e = env();
        e.choose_with_copy().await;
        // Off keeps the copy, and queues nothing.
        e.op(Operation::VoiceSet, json!({"provider": "off"}))
            .await
            .unwrap();
        assert!(e.copy().is_some());
        assert_eq!(e.snapshot()["state"], "off");
        assert_eq!(e.snapshot()["copy"], true);
        assert_eq!(e.refreshes_queued(), 0);
        // Knowledge again: its copy is still its own, kept, and refreshed.
        e.op(Operation::VoiceSet, json!({"provider": KNOWLEDGE}))
            .await
            .unwrap();
        assert!(e.copy().is_some());
        assert_eq!(e.refreshes_queued(), 1);
        e.run_jobs().await;
        // Another provider: the copy is deleted.
        e.op(Operation::VoiceSet, json!({"provider": "plugin:other"}))
            .await
            .unwrap();
        assert!(e.copy().is_none());
        assert_eq!(e.snapshot()["copy"], false);
        // And Off, then a provider other than the copy's, deletes it too.
        e.fake.answer("export", export_answer(""));
        e.run_jobs().await;
        assert_eq!(e.copy().unwrap().provider, "plugin:other");
        e.op(Operation::VoiceSet, json!({"provider": "off"}))
            .await
            .unwrap();
        e.op(Operation::VoiceSet, json!({"provider": KNOWLEDGE}))
            .await
            .unwrap();
        assert!(e.copy().is_none());
    }

    #[tokio::test]
    async fn forget_turns_off_and_no_refresh_refills_it() {
        let e = env();
        e.choose_with_copy().await;
        // A refresh is still queued when the copy is deleted.
        e.core.voice_reloaded();
        assert_eq!(e.refreshes_queued(), 1);
        let answer = e.op(Operation::VoiceForget, json!({})).await.unwrap();
        assert_eq!(answer["provider"], "off");
        assert!(answer["deleted"].as_u64().unwrap() > 0);
        assert_eq!(e.settings().provider, "off");
        assert!(e.copy().is_none());
        let exports = e.calls_of("export").len();
        e.fake.answer("export", export_answer(""));
        // The queued one, the 30-minute schedule and a reload: none asks or writes.
        e.run_jobs().await;
        e.core
            .voice_refresh_round(now() + refresh::EVERY * 2)
            .unwrap();
        e.core.voice_reloaded();
        e.run_jobs().await;
        assert_eq!(e.calls_of("export").len(), exports, "no export call");
        assert!(e.copy().is_none());
        assert_eq!(e.snapshot()["state"], "off");
        assert_eq!(e.snapshot()["copy"], false);
    }

    #[tokio::test]
    async fn save_writes_through_the_provider_then_the_copy() {
        let e = env();
        e.choose_with_copy().await;
        e.fake.answer(
            "save",
            json!({"text": "Terse.", "updatedAt": "2026-11-25T10:00:00Z", "source": "Voice/style.md",
                   "basedOn": null}),
        );
        let answer = e
            .op(
                Operation::VoiceSave,
                json!({"kind": "style", "text": "Terse."}),
            )
            .await
            .unwrap();
        assert_eq!(
            e.calls_of("save"),
            [json!({"kind": "style", "text": "Terse."})]
        );
        assert_eq!(answer["item"]["text"], "Terse.");
        assert_eq!(answer["item"]["source"], "Voice/style.md");
        assert_eq!(e.copy().unwrap().style.unwrap().text, "Terse.");
        assert_eq!(e.refreshes_queued(), 1);

        // A new rule comes back with its id.
        e.fake.answer(
            "save",
            json!({"id": "topic-budget", "applies": {"kind": "topic", "value": "budget"},
                   "text": "Ask for the code.", "source": "Voice/rules.md", "editable": true}),
        );
        let answer = e
            .op(
                Operation::VoiceSave,
                json!({"kind": "rule", "id": null, "applies": {"kind": "topic", "value": " budget ", "channel": "mail"},
                       "text": "Ask for the code."}),
            )
            .await
            .unwrap();
        assert_eq!(
            e.calls_of("save")[1],
            json!({"kind": "rule", "id": null, "applies": {"kind": "topic", "value": "budget", "channel": "mail"},
                   "text": "Ask for the code."})
        );
        assert_eq!(answer["item"]["id"], "topic-budget");
        assert!(e
            .copy()
            .unwrap()
            .rules
            .iter()
            .any(|r| r.id == "topic-budget"));
        assert_eq!(e.refreshes_queued(), 1, "at most one queued");
    }

    #[tokio::test]
    async fn save_validates_with_fields() {
        let e = env();
        e.choose_with_copy().await;
        let cases = [
            (
                json!({"kind": "rule", "id": null, "text": "Be brief."}),
                "applies",
                APPLIES,
            ),
            (
                json!({"kind": "rule", "id": null, "applies": {"kind": "chat"}, "text": "Be brief."}),
                "applies",
                APPLIES,
            ),
            (
                json!({"kind": "rule", "id": null, "applies": {"kind": "chat", "value": "  "}, "text": "Be brief."}),
                "applies",
                APPLIES,
            ),
            (
                json!({"kind": "rule", "id": null, "applies": {"kind": "anyone"}, "text": "Be brief."}),
                "applies",
                APPLIES,
            ),
            (
                json!({"kind": "rule", "id": null, "applies": {"kind": "everyone", "channel": "sms"}, "text": "Be brief."}),
                "applies",
                APPLIES,
            ),
            (
                json!({"kind": "rule", "id": null, "applies": {"kind": "everyone"}, "text": "x".repeat(2_001)}),
                "text",
                RULE_TEXT,
            ),
            (
                json!({"kind": "rule", "id": null, "applies": {"kind": "everyone"}, "text": "  "}),
                "text",
                RULE_TEXT,
            ),
            (
                json!({"kind": "style", "text": "x".repeat(8_001)}),
                "text",
                STYLE_TEXT,
            ),
        ];
        for (data, field, message) in cases {
            let err = e.op(Operation::VoiceSave, data.clone()).await.unwrap_err();
            assert_eq!(err.field.as_deref(), Some(field), "{data}");
            assert_eq!(err.message, message, "{data}");
        }
        assert!(
            e.calls_of("save").is_empty(),
            "a refused input asks nothing"
        );
        // The limits themselves pass.
        e.fake.answer("save", json!({"text": "x"}));
        e.fake.answer("save", json!({}));
        e.op(
            Operation::VoiceSave,
            json!({"kind": "style", "text": "x".repeat(8_000)}),
        )
        .await
        .unwrap();
        e.op(
            Operation::VoiceSave,
            json!({"kind": "rule", "id": null, "applies": {"kind": "everyone"}, "text": "x".repeat(2_000)}),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn save_reports_a_refusal_and_an_unanswered_provider() {
        let e = env();
        e.choose_with_copy().await;
        let before = e.copy().unwrap();
        e.fake.fail(
            "save",
            "refused: The page changed in your folder. Refresh and try again.",
        );
        let err = e
            .op(
                Operation::VoiceSave,
                json!({"kind": "style", "text": "Terse."}),
            )
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "Knowledge didn't save it: The page changed in your folder. Refresh and try again."
        );
        assert_eq!(e.copy().unwrap(), before);

        // No answer within 10 s.
        tokio::time::pause();
        e.fake.delay("save", Duration::from_secs(11));
        e.fake.answer("save", json!({"text": "Terse."}));
        let err = e
            .op(
                Operation::VoiceSave,
                json!({"kind": "style", "text": "Terse."}),
            )
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "Knowledge isn't answering, so nothing was saved. Try again."
        );
        assert_eq!(e.copy().unwrap(), before, "the copy is unchanged");
        assert_eq!(e.refreshes_queued(), 0);

        // With Off chosen there is nothing to save through.
        e.op(Operation::VoiceSet, json!({"provider": "off"}))
            .await
            .unwrap();
        let err = e
            .op(
                Operation::VoiceSave,
                json!({"kind": "style", "text": "Terse."}),
            )
            .await
            .unwrap_err();
        assert_eq!(err.message, OFF);
    }

    #[tokio::test]
    async fn delete_answers_the_rule_for_undo() {
        let e = env();
        e.choose_with_copy().await;
        let rule = e
            .copy()
            .unwrap()
            .rules
            .into_iter()
            .find(|r| r.id == "everyone")
            .unwrap();
        e.fake.answer("remove", json!({"removed": true}));
        let answer = e
            .op(Operation::VoiceDelete, json!({"id": "everyone"}))
            .await
            .unwrap();
        assert_eq!(answer, json!({"removed": rule}));
        assert_eq!(
            e.calls_of("remove"),
            [json!({"kind": "rule", "id": "everyone"})]
        );
        assert!(!e.copy().unwrap().rules.iter().any(|r| r.id == "everyone"));
        assert_eq!(e.refreshes_queued(), 1);
        // Undo saves it back as it was.
        let undo = json!({"kind": "rule", "id": answer["removed"]["id"], "applies": answer["removed"]["applies"],
                          "text": answer["removed"]["text"]});
        e.fake.answer("save", serde_json::to_value(&rule).unwrap());
        e.op(Operation::VoiceSave, undo).await.unwrap();
        assert!(e.copy().unwrap().rules.contains(&rule));
        // A rule Connect no longer has asks nothing.
        let err = e
            .op(Operation::VoiceDelete, json!({"id": "nope"}))
            .await
            .unwrap_err();
        assert_eq!(err.code, "not_found");
        assert_eq!(e.calls_of("remove").len(), 1);
        // An unanswered remove leaves the rule.
        let err = e
            .op(Operation::VoiceDelete, json!({"id": "everyone"}))
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "Knowledge isn't answering, so nothing was saved. Try again."
        );
        assert!(e.copy().unwrap().rules.contains(&rule));
    }

    #[tokio::test]
    async fn read_answers_the_profile_and_the_about() {
        let e = env();
        e.choose_with_copy().await;
        let read = |id: &str| {
            e.core.voice_read(&Request {
                op: Operation::VoiceRead,
                workspace_id: None,
                expected_revision: None,
                operation_id: None,
                data: json!({"id": id}),
            })
        };
        assert_eq!(
            read("priya-n").unwrap(),
            json!({"id": "priya-n", "name": "Priya N.", "text": "Short sentences; no small talk. ",
                   "about": "Product lead; prefers mornings. ", "source": "People/priya-n.md"})
        );
        assert_eq!(read("nobody").unwrap_err().code, "not_found");
        assert_eq!(read("").unwrap_err().field.as_deref(), Some("id"));
        // Through `workspace_request`: read-only, no operation id.
        let answer = e
            .core
            .request(Request {
                op: Operation::VoiceRead,
                workspace_id: None,
                expected_revision: None,
                operation_id: None,
                data: json!({"id": "marek-novak"}),
            })
            .await
            .unwrap();
        assert_eq!(answer["name"], "Marek Novak");
        assert_eq!(answer["about"], "");
    }

    #[tokio::test]
    async fn removing_the_provider_plugin_deletes_the_copy() {
        let e = env();
        e.choose_with_copy().await;
        e.core.voice_plugin_removed("other").unwrap();
        assert!(e.copy().is_some(), "another plugin's removal keeps it");
        assert_eq!(e.settings().provider, KNOWLEDGE);
        e.core.voice_plugin_removed("knowledge").unwrap();
        assert!(e.copy().is_none());
        assert_eq!(e.settings().provider, "off");
        // A copy kept with Off goes with its plugin too.
        e.choose_with_copy().await;
        e.op(Operation::VoiceSet, json!({"provider": "off"}))
            .await
            .unwrap();
        e.core.voice_plugin_removed("knowledge").unwrap();
        assert!(e.copy().is_none());
    }

    /// Voice text reaches no log line, no job result and no job payload (ruling 22).
    #[tokio::test]
    async fn no_log_line_carries_voice_text() {
        crate::testing::capture_logs();
        let e = env();
        e.fake.answer("export", export_answer(SENTINEL));
        e.op(Operation::VoiceSet, json!({"provider": KNOWLEDGE}))
            .await
            .unwrap();
        e.run_jobs().await;
        assert_eq!(e.snapshot()["state"], "ready");
        e.fake
            .answer("save", json!({"text": format!("Terse. {SENTINEL}")}));
        e.op(
            Operation::VoiceSave,
            json!({"kind": "style", "text": format!("Terse. {SENTINEL}")}),
        )
        .await
        .unwrap();
        e.fake.fail("save", &format!("refused: {SENTINEL} changed"));
        let _ = e
            .op(
                Operation::VoiceSave,
                json!({"kind": "style", "text": format!("Again {SENTINEL}")}),
            )
            .await;
        e.fake.fail("export", &format!("boom {SENTINEL}"));
        e.core.voice_reloaded();
        e.run_jobs().await;
        e.op(Operation::VoiceForget, json!({})).await.unwrap();

        let voice_lines: Vec<String> = crate::testing::logged_lines()
            .into_iter()
            .filter(|l| l.starts_with("voice:"))
            .collect();
        assert!(!voice_lines.is_empty(), "the voice logs its codes");
        for line in crate::testing::logged_lines() {
            assert!(
                !line.contains(SENTINEL),
                "a log line carries voice text: {line}"
            );
        }
        for job in e.core.repo().unwrap().jobs().unwrap() {
            let text = serde_json::to_string(&job).unwrap();
            assert!(!text.contains(SENTINEL), "a job carries voice text: {text}");
        }
    }

    /// The `voice_forget` answer. Regenerate with `UPDATE_CONTRACT_FIXTURES=1 cargo test
    /// contract_fixtures`.
    #[test]
    fn contract_fixtures_match_the_voice_forget() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let c = copy::from_export(&export_answer(""));
        copy::replace(&mut core.repo().unwrap(), KNOWLEDGE, &c, 1_764_000_000).unwrap();
        let answer = forget(&mut core.repo().unwrap()).unwrap();
        assert_eq!(
            answer["deleted"], 7,
            "a style, 2 rules, 3 people and the meta row"
        );
        assert_eq!(
            copy::read_copy(&core.repo().unwrap())
                .unwrap()
                .map(|c| c.state),
            None::<VoiceState>
        );
        crate::plugins::testkit::contract_fixture("voice-forget.json", &answer);
    }
}
