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
//!
//! The skill import (design §11, rulings 36–38): `voice_import_scan` and `voice_import_distil`
//! are read-style (no operation id, before the lock); `voice_import` asks the provider's
//! `save {kind: "rules"}` before the lock like `voice_save`, in one write.
use super::{copy, refresh, skills, VoiceError};
use crate::ai::command::RunSpec;
use crate::ai::stream::ErrorClass;
use crate::workspace::ai::RouteKey;
use crate::workspace::models::{now, Operation, Purpose, Request, Result, WorkspaceError};
use crate::workspace::repository::Repository;
use crate::workspace::{prompts, Core};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
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

/// The import (design §11): at most 50 instructions per save; Shorten with AI's limit.
const IMPORT_MAX: usize = 50;
const DISTIL_LIMIT: Duration = Duration::from_secs(120);
/// The ledger's purpose for a Shorten with AI run (on the Mail replies route).
const DISTIL_PURPOSE: &str = "voice_import";
const PATH_MAX: usize = 4_096;
const NOT_READY: &str =
    "The AI profile your Mail replies use isn't ready. Check it in Settings › AI.";

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
pub(super) fn applies(v: &Value) -> Result<Value> {
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
    /// `Core::voice_epoch` when the provider was asked: a delete of the copy since then makes the
    /// answer stale for the copy.
    epoch: usize,
    /// An import's items left out (already in the copy, or past the 200-instruction limit).
    skipped: usize,
}

/// What a voice edit's operation id keeps as its answer (design §6): an ack with the item's id,
/// never its text, so no voice text outlives Delete Connect's copy. `Core::voice_replayed`
/// rebuilds the answer from it.
pub(in crate::workspace) fn ack(req: &Request, response: &Value) -> Value {
    if req.op == Operation::VoiceDelete {
        json!({"voiceAck": true, "ok": true, "op": "delete", "id": response["removed"]["id"]})
    } else if req.op == Operation::VoiceImport {
        json!({"voiceAck": true, "ok": true, "op": "import", "added": response["added"],
               "skipped": response["skipped"]})
    } else {
        json!({"voiceAck": true, "ok": true, "op": "save", "kind": req.data["kind"],
               "id": response["item"]["id"]})
    }
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
    let mut s = r.settings()?;
    let switched = s.voice.provider != provider;
    // Keeping the chosen provider (a facts-only change) asks nothing of it, so it may be turned
    // off meanwhile; choosing one anew needs it listed and on.
    if provider != "off" && switched {
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
    s.voice.provider = provider.into();
    if let Some(on) = facts {
        s.voice.facts = on;
    }
    if provider != "off" && copy::read_copy(r)?.is_none_or(|c| c.provider != provider) {
        // The copy came from another provider (ruling 12): gone with the choice, in one write.
        core.voice_epoch.fetch_add(1, Ordering::SeqCst);
        let gone = copy::forget_with(r, &s)?;
        if gone > 0 {
            log::info!("voice: another provider chosen, copy deleted ({gone} records)");
        }
    } else {
        r.settings_update(&s)?;
    }
    if provider != "off" && switched {
        refresh::queue(r, provider, now)?;
    }
    Ok(json!({"provider": provider, "facts": s.voice.facts}))
}

/// Writes what the provider accepted into the copy and queues a refresh: the saved item
/// (`{item}`) or the removed rule (`{removed}`). A provider no longer chosen (switched while it
/// was asked) leaves the copy alone.
fn record(r: &mut Repository, asked: &Asked, epoch: usize, now: i64) -> Result<Value> {
    // Still the chosen provider, and its copy not deleted since the ask (Delete, then the same
    // provider chosen again within the ask, review N1).
    let chosen = r.settings()?.voice.provider == asked.provider && asked.epoch == epoch;
    if asked.kind == "rules" {
        // What the provider saved (its answer's rules), not what it was asked.
        let saved = copy::saved_rules(&asked.answer).len();
        if chosen && saved > 0 {
            copy::put_saved(r, &asked.provider, "rules", &asked.answer, now)?;
            refresh::queue(r, &asked.provider, now)?;
        }
        return Ok(json!({"added": saved, "skipped": asked.skipped}));
    }
    if let Some(rule) = &asked.removed {
        if chosen {
            copy::remove_rule(r, &rule.id)?;
            refresh::queue(r, &asked.provider, now)?;
        }
        return Ok(json!({"removed": rule}));
    }
    let item = if chosen {
        let item = copy::put_saved(r, &asked.provider, asked.kind, &asked.answer, now)?;
        refresh::queue(r, &asked.provider, now)?;
        item
    } else {
        Value::Null
    };
    Ok(json!({"item": item}))
}

/// `voice_forget {}` (design §6): sets Off and deletes every copy record in one transaction;
/// nothing in the provider's folder is touched.
fn forget(core: &Core, r: &mut Repository) -> Result<Value> {
    core.voice_epoch.fetch_add(1, Ordering::SeqCst);
    let mut s = r.settings()?;
    s.voice.provider = "off".into();
    let deleted = copy::forget_with(r, &s)?;
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
                let epoch = self.voice_epoch.load(Ordering::SeqCst);
                let (provider, answer) = through(self, "save", args).await?;
                Ok(Asked {
                    provider,
                    kind,
                    answer,
                    removed: None,
                    epoch,
                    skipped: 0,
                })
            }
            Operation::VoiceDelete => {
                let id = rule_id(&req.data)?;
                let rule = copy::read_copy(&*self.repo()?)?
                    .and_then(|c| c.rules.into_iter().find(|rule| rule.id == id))
                    .ok_or_else(|| {
                        WorkspaceError::new("not_found", "This instruction is no longer there.")
                    })?;
                let epoch = self.voice_epoch.load(Ordering::SeqCst);
                let (provider, _) =
                    through(self, "remove", json!({"kind": "rule", "id": id})).await?;
                Ok(Asked {
                    provider,
                    kind: "rule",
                    answer: Value::Null,
                    removed: Some(rule),
                    epoch,
                    skipped: 0,
                })
            }
            Operation::VoiceImport => self.voice_import_ask(&req.data).await,
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
            Operation::VoiceForget => forget(self, &mut r),
            Operation::VoiceSave | Operation::VoiceDelete | Operation::VoiceImport => {
                let asked = asked
                    .ok_or_else(|| WorkspaceError::new("validation", "Unsupported operation."))?;
                let epoch = self.voice_epoch.load(Ordering::SeqCst);
                let recorded = record(&mut r, &asked, epoch, now);
                drop(r);
                if recorded.is_err() {
                    self.voice_catch_up(&asked);
                }
                recorded
            }
            _ => Err(WorkspaceError::new("validation", "Unsupported operation.")),
        }
    }

    /// A provider accepted an edit but the locked part didn't record it (refused, or failed):
    /// the copy catches up with what the provider kept through a refresh.
    pub(in crate::workspace) fn voice_catch_up(&self, asked: &Asked) {
        let queued = self
            .repo()
            .and_then(|mut r| refresh::queue(&mut r, &asked.provider, now()));
        if let Err(e) = queued {
            log::warn!(
                "voice: no refresh queued after an unrecorded edit: {}",
                e.code
            );
        }
    }

    /// The answer to a replayed voice edit, rebuilt from its stored ack: a save's item as the
    /// copy keeps it now (`null` when it is gone), a delete's rule by id. Anything else stored
    /// (an older answer) is given as it is.
    pub(in crate::workspace) fn voice_replayed(&self, stored: Value) -> Result<Value> {
        if stored["voiceAck"] != true {
            return Ok(stored);
        }
        if stored["op"] == "delete" {
            return Ok(json!({"removed": {"id": stored["id"]}}));
        }
        if stored["op"] == "import" {
            return Ok(json!({"added": stored["added"], "skipped": stored["skipped"]}));
        }
        let c = copy::read_copy(&*self.repo()?)?;
        let item = match (stored["kind"].as_str(), c) {
            (Some("style"), Some(c)) => c.style.map(|s| json!(s)),
            (Some("rule"), Some(c)) => c
                .rules
                .into_iter()
                .find(|r| stored["id"] == r.id.as_str())
                .map(|r| json!(r)),
            _ => None,
        };
        Ok(json!({"item": item}))
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
        self.voice_epoch.fetch_add(1, Ordering::SeqCst);
        let deleted = if chosen {
            s.voice.provider = "off".into();
            copy::forget_with(&mut r, &s)?
        } else {
            copy::forget(&mut r)?
        };
        log::info!("voice: provider removed, copy deleted ({deleted} records)");
        drop(r);
        self.emit("workspace:changed");
        Ok(())
    }
}

/// The skills folder an import names: an absolute path the scan checks further.
fn import_path(data: &Value) -> Result<PathBuf> {
    data["path"]
        .as_str()
        .filter(|p| !p.is_empty() && p.len() <= PATH_MAX)
        .map(PathBuf::from)
        .ok_or_else(|| invalid("path", skills::CANT_READ))
}

/// The folder's name, as the preview's title shows it.
fn folder_name(path: &std::path::Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `voice_import`'s items checked (design §11): 1–50, each a known scope, a text of at most 600
/// characters and the skill it came from; answered as the provider gets them.
fn validate_import(data: &Value) -> Result<Vec<Value>> {
    let list = data["items"]
        .as_array()
        .filter(|l| !l.is_empty() && l.len() <= IMPORT_MAX)
        .ok_or_else(|| invalid("items", "Choose 1 to 50 instructions to add."))?;
    list.iter()
        .map(|item| {
            let applies = applies(&item["applies"])?;
            let text = item["text"]
                .as_str()
                .map(str::trim)
                .filter(|t| !t.is_empty() && t.chars().count() <= skills::ITEM_MAX)
                .ok_or_else(|| invalid("text", "Write what to do, up to 600 characters."))?;
            let from = item["from"]
                .as_str()
                .map(str::trim)
                .filter(|f| !f.is_empty() && f.chars().count() <= ID_MAX)
                .ok_or_else(|| invalid("from", "Say which skill it comes from."))?;
            Ok(json!({"applies": applies, "text": text, "from": from}))
        })
        .collect()
}

impl Core {
    /// The chosen provider, refused with Off (design §5's "Choose where your voice comes from
    /// first.").
    fn voice_chosen(&self) -> Result<String> {
        let provider = self.repo()?.settings()?.voice.provider;
        if provider == "off" {
            return Err(invalid("provider", OFF));
        }
        Ok(provider)
    }

    /// Scans `path` off the async threads (it reads files).
    async fn voice_skills(path: PathBuf) -> Result<Vec<skills::SkillDoc>> {
        tokio::task::spawn_blocking(move || skills::scan(&path))
            .await
            .map_err(|_| invalid("path", skills::CANT_READ))?
    }

    /// `voice_import_scan {path}` (read-style, design §11): the preview of a skills folder the
    /// user picked; nothing is stored.
    pub(in crate::workspace) async fn voice_import_scan(&self, req: &Request) -> Result<Value> {
        self.voice_chosen()?;
        let path = import_path(&req.data)?;
        let docs = Self::voice_skills(path.clone()).await?;
        let copy = copy::read_copy(&*self.repo()?)?;
        let preview = skills::preview(&docs, copy.as_ref(), &folder_name(&path));
        log::info!(
            "voice: import scan found {} skills, {} instructions, {} not imported",
            preview.found,
            preview.items.len(),
            preview.skipped.len()
        );
        Ok(json!(preview))
    }

    /// `voice_import_distil {path, skill}` (read-style, design §11, ruling 37): one tool-free run
    /// on the Mail replies route, outside the mutation lock, whose answer is checked before it
    /// reaches the preview. The ledger records the run with no text.
    pub(in crate::workspace) async fn voice_import_distil(&self, req: &Request) -> Result<Value> {
        self.voice_chosen()?;
        let path = import_path(&req.data)?;
        let skill = req.data["skill"]
            .as_str()
            .filter(|s| !s.is_empty() && s.chars().count() <= ID_MAX)
            .ok_or_else(|| invalid("skill", "Choose a skill."))?
            .to_string();
        let dir = req.data["dir"]
            .as_str()
            .filter(|d| d.len() <= PATH_MAX)
            .ok_or_else(|| invalid("dir", "That skill is no longer in the folder."))?
            .to_string();
        // Only that skill's folder is read again (the preview's `dir`), never the whole folder.
        let one = dir.clone();
        let doc = tokio::task::spawn_blocking(move || skills::read_one(&path, &one))
            .await
            .map_err(|_| invalid("path", skills::CANT_READ))??;
        if doc.name.is_none() || doc.problem.is_some() || doc.label != skill {
            return Err(invalid("skill", "That skill is no longer in the folder."));
        }
        let text = skills::distil_input(&doc);
        let not_ready = || WorkspaceError::new("not_ready", NOT_READY);
        let resolved = self
            .resolve_key(&RouteKey::Purpose(Purpose::MailDraft))
            .await
            .map_err(|_| not_ready())?;
        let spec = RunSpec {
            purpose: DISTIL_PURPOSE.into(),
            profile_id: resolved.profile.id.clone(),
            model: resolved.model.clone(),
            system: prompts::SKILL_DISTIL_SYSTEM.into(),
            input: json!({"skill": skill, "text": format!("<message>\n{text}\n</message>")}),
            schema: Some(prompts::schema(prompts::SKILL_DISTIL_SCHEMA)),
            timeout: DISTIL_LIMIT,
            cap_usd: None,
            staging_root: self.paths.ensure_staging()?,
            folder: None,
        };
        let started = std::time::Instant::now();
        let (result, spec, _) = self
            .run_resolved(
                &resolved,
                spec,
                self.ai_cancel.child_token(),
                Arc::new(|_| {}),
                None,
                &|_| {},
            )
            .await;
        let mut record = self.ai_run_record(
            &spec,
            result.as_ref().ok(),
            result.as_ref().err(),
            started.elapsed(),
            None,
        );
        record.data["fallbackFrom"] = json!(resolved.fallback_from(&spec));
        self.put_ai_run(&record);
        let didnt_fit = |message: String| WorkspaceError::new("invalid_output", message);
        let outcome = result.map_err(|e| match e.class {
            ErrorClass::NotInstalled
            | ErrorClass::TooOld
            | ErrorClass::NeedsLogin
            | ErrorClass::NotConfigured
            | ErrorClass::NeedsChoice => not_ready(),
            ErrorClass::InvalidOutput => {
                didnt_fit(format!("AI's answer didn't fit, so {skill} is unchanged."))
            }
            _ => e.into(),
        })?;
        let answer = outcome.structured.map_or(outcome.text, |v| v.to_string());
        match skills::parse_distilled(&skill, &answer) {
            Ok(mut items) => {
                for item in &mut items {
                    item.dir = dir.clone();
                }
                log::info!(
                    "voice: import shortened one skill into {} instructions",
                    items.len()
                );
                Ok(json!({"skill": skill, "items": items}))
            }
            Err(message) => {
                log::info!("voice: import refused an AI answer that didn't fit");
                Err(didnt_fit(message))
            }
        }
    }

    /// `voice_import`'s provider call, before the mutation lock (design §11): the items already
    /// in the copy (same scope, same text after folding) and those past the 200-instruction
    /// limit are left out, and the rest go to the provider's `save {kind: "rules"}` in one call.
    /// Nothing left to add asks nothing.
    async fn voice_import_ask(&self, data: &Value) -> Result<Asked> {
        let items = validate_import(data)?;
        let provider = self.voice_chosen()?;
        let copy = copy::read_copy(&*self.repo()?)?;
        let mut known = skills::copy_keys(copy.as_ref());
        let room = 200usize.saturating_sub(copy.map_or(0, |c| c.rules.len()));
        let fresh: Vec<Value> = items
            .iter()
            .filter(|i| {
                known.insert(skills::fold_key(
                    &i["applies"],
                    i["text"].as_str().unwrap_or_default(),
                ))
            })
            .take(room)
            .cloned()
            .collect();
        let skipped = items.len() - fresh.len();
        let epoch = self.voice_epoch.load(Ordering::SeqCst);
        log::info!(
            "voice: import of {} instructions, {} left out",
            fresh.len(),
            skipped
        );
        let (provider, answer) = if fresh.is_empty() {
            (provider, Value::Null)
        } else {
            through(self, "save", json!({"kind": "rules", "items": fresh})).await?
        };
        Ok(Asked {
            provider,
            kind: "rules",
            answer,
            removed: None,
            epoch,
            skipped,
        })
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
        pub(crate) runner: Arc<FakeRunner>,
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
        env_with(vec![])
    }

    /// [`env`] whose Claude runs play `script`.
    pub(crate) fn env_with(
        script: Vec<std::result::Result<crate::ai::stream::RunOutcome, crate::ai::stream::AiError>>,
    ) -> Env {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(FakeRunner::new(script));
        let core = test_core(dir.path(), runner.clone(), ready());
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
            runner,
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

    fn new_rule() -> Value {
        json!({"kind": "rule", "id": null, "applies": {"kind": "everyone"}, "text": "Be brief."})
    }

    fn saved_rule() -> Value {
        json!({"id": "everyone-2", "applies": {"kind": "everyone"}, "text": "Be brief.",
               "source": "Voice/rules.md", "editable": true})
    }

    /// Review I1: the revision moves while the provider is asked (another write lands in the
    /// 10 s window). The edit the provider kept is written into the copy, a refresh is queued,
    /// and nothing asks the provider a second time: the operation succeeds rather than going
    /// `stale_view` (which the store would resend, creating the instruction again).
    #[tokio::test]
    async fn the_revision_moving_during_the_ask_creates_once_and_refreshes() {
        let e = env();
        e.choose_with_copy().await;
        e.fake.delay("save", Duration::from_millis(200));
        e.fake.answer("save", saved_rule());
        let req = mutation(&e.core, Operation::VoiceSave, new_rule());
        let core = e.core.clone();
        let first = req.clone();
        let running = tokio::spawn(async move { core.request(first).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Another write moves the revision while the provider works.
        {
            let mut r = e.core.repo().unwrap();
            let s = r.settings().unwrap();
            r.settings_update(&s).unwrap();
        }
        let answer = running.await.unwrap().unwrap();
        assert_eq!(answer["item"]["id"], "everyone-2");
        assert_eq!(e.calls_of("save").len(), 1);
        assert!(e.copy().unwrap().rules.iter().any(|r| r.id == "everyone-2"));
        assert_eq!(e.refreshes_queued(), 1);
        // The store's resend of the same operation id answers the same, asking nothing.
        let again = e.core.request(req).await.unwrap();
        assert_eq!(again, answer);
        assert_eq!(e.calls_of("save").len(), 1, "no second create");
    }

    /// Review I1: when the locked part refuses an edit the provider already accepted (here a
    /// second send of the same operation id whose ask overlapped the first and ended after it was
    /// recorded), a refresh is still queued so the copy catches up, and the stored answer is
    /// given.
    #[tokio::test]
    async fn an_edit_the_lock_refuses_after_the_ask_still_refreshes() {
        let e = env();
        e.choose_with_copy().await;
        e.fake.delay("save", Duration::from_millis(200));
        e.fake.answer("save", saved_rule());
        e.fake.answer("save", saved_rule());
        let req = mutation(&e.core, Operation::VoiceSave, new_rule());
        let (core, first) = (e.core.clone(), req.clone());
        let a = tokio::spawn(async move { core.request(first).await });
        tokio::time::sleep(Duration::from_millis(150)).await;
        let (core, second) = (e.core.clone(), req.clone());
        let b = tokio::spawn(async move { core.request(second).await });
        let first = a.await.unwrap().unwrap();
        // The first send's refresh runs before the second send's ask ends; the provider's
        // export holds the saved rule.
        let mut export = export_answer("");
        export["rules"].as_array_mut().unwrap().push(saved_rule());
        e.fake.answer("export", export);
        e.run_jobs().await;
        assert_eq!(e.refreshes_queued(), 0);
        let second = b.await.unwrap().unwrap();
        assert_eq!(second, first);
        assert_eq!(e.refreshes_queued(), 1, "the copy catches up");
    }

    /// Review I1: a request that is already stale never reaches the provider.
    #[tokio::test]
    async fn a_stale_edit_asks_the_provider_nothing() {
        let e = env();
        e.choose_with_copy().await;
        let mut req = mutation(&e.core, Operation::VoiceSave, new_rule());
        req.expected_revision = Some(req.expected_revision.unwrap() - 1);
        let err = e.core.request(req).await.unwrap_err();
        assert_eq!(err.code, "stale_view");
        let mut req = mutation(&e.core, Operation::VoiceDelete, json!({"id": "everyone"}));
        req.expected_revision = Some(req.expected_revision.unwrap() - 1);
        assert_eq!(e.core.request(req).await.unwrap_err().code, "stale_view");
        assert!(e.calls_of("save").is_empty() && e.calls_of("remove").is_empty());
    }

    /// Review I1: replaying an operation id that already succeeded answers the stored answer —
    /// for a delete too, whose rule is no longer in the copy — with no second provider call.
    #[tokio::test]
    async fn a_replay_after_success_answers_the_same_and_asks_nothing() {
        let e = env();
        e.choose_with_copy().await;
        e.fake.answer("remove", json!({"removed": true}));
        let req = mutation(&e.core, Operation::VoiceDelete, json!({"id": "everyone"}));
        let answer = e.core.request(req.clone()).await.unwrap();
        assert_eq!(answer["removed"]["id"], "everyone");
        // The stored ack holds no rule text, so a replay names the removed rule by its id.
        let again = e.core.request(req).await.unwrap();
        assert_eq!(
            again,
            json!({"removed": {"id": "everyone"}}),
            "not not_found"
        );
        assert_eq!(e.calls_of("remove").len(), 1);

        // A save's replay is rebuilt from the copy: the same item.
        e.fake.answer("save", saved_rule());
        let req = mutation(&e.core, Operation::VoiceSave, new_rule());
        let answer = e.core.request(req.clone()).await.unwrap();
        assert_eq!(e.core.request(req).await.unwrap(), answer);
        assert_eq!(e.calls_of("save").len(), 1);
        e.fake.answer(
            "save",
            json!({"text": "Terse.", "source": "Voice/style.md"}),
        );
        let req = mutation(
            &e.core,
            Operation::VoiceSave,
            json!({"kind": "style", "text": "Terse."}),
        );
        let answer = e.core.request(req.clone()).await.unwrap();
        assert_eq!(e.core.request(req).await.unwrap(), answer);
        assert_eq!(e.calls_of("save").len(), 2);
    }

    /// Controller ruling (fix round 2), design §6: after Delete Connect's copy no style or rule
    /// text the user saved through Connect is left anywhere in the database — not in the copy,
    /// not in the stored answers of the edits (reservations), not in a job.
    #[tokio::test]
    async fn delete_leaves_no_saved_voice_text_in_the_database() {
        let e = env();
        e.choose_with_copy().await;
        let rule = format!("Be brief. {SENTINEL}");
        e.fake.answer(
            "save",
            json!({"id": "everyone-2", "applies": {"kind": "everyone"}, "text": rule,
                   "source": "Voice/rules.md", "editable": true}),
        );
        e.op(
            Operation::VoiceSave,
            json!({"kind": "rule", "id": null, "applies": {"kind": "everyone"}, "text": rule}),
        )
        .await
        .unwrap();
        let style = format!("Terse. {SENTINEL}");
        e.fake.answer("save", json!({"text": style}));
        e.op(
            Operation::VoiceSave,
            json!({"kind": "style", "text": style}),
        )
        .await
        .unwrap();
        e.fake.answer("remove", json!({"removed": true}));
        e.op(Operation::VoiceDelete, json!({"id": "everyone-2"}))
            .await
            .unwrap();
        assert!(
            e.core
                .repo()
                .unwrap()
                .all_text_for_tests()
                .contains(SENTINEL),
            "the scan sees the saved text while the copy holds it"
        );
        e.op(Operation::VoiceForget, json!({})).await.unwrap();
        let text = e.core.repo().unwrap().all_text_for_tests();
        assert!(
            !text.contains(SENTINEL),
            "voice text outlived Delete Connect's copy"
        );
        assert!(
            !text.contains("voiceAck"),
            "the edits' acks go with the copy"
        );
    }

    /// The edits' acks go when another provider is chosen or the plugin is removed, too.
    #[tokio::test]
    async fn a_provider_change_or_removal_drops_the_edits_acks() {
        let e = env();
        let acks = || {
            e.core
                .repo()
                .unwrap()
                .all_text_for_tests()
                .matches("voiceAck")
                .count()
        };
        e.choose_with_copy().await;
        e.fake.answer("save", saved_rule());
        e.op(Operation::VoiceSave, new_rule()).await.unwrap();
        assert_eq!(acks(), 1);
        e.op(Operation::VoiceSet, json!({"provider": "plugin:other"}))
            .await
            .unwrap();
        assert_eq!(acks(), 0, "a provider change");
        e.op(Operation::VoiceSet, json!({"provider": KNOWLEDGE}))
            .await
            .unwrap();
        e.fake.answer("export", export_answer(""));
        e.run_jobs().await;
        e.fake.answer("save", saved_rule());
        e.op(Operation::VoiceSave, new_rule()).await.unwrap();
        assert_eq!(acks(), 1);
        e.core.voice_plugin_removed("knowledge").unwrap();
        assert_eq!(acks(), 0, "the plugin removed");
    }

    /// Review N1: Delete Connect's copy and choosing the same provider again while an edit is
    /// asked: the late edit writes nothing into the new, empty copy.
    #[tokio::test]
    async fn an_edit_asked_before_a_delete_writes_nothing_after_it() {
        let e = env();
        e.choose_with_copy().await;
        e.fake.delay("save", Duration::from_millis(200));
        e.fake.answer("save", saved_rule());
        let req = mutation(&e.core, Operation::VoiceSave, new_rule());
        let core = e.core.clone();
        let running = tokio::spawn(async move { core.request(req).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        e.op(Operation::VoiceForget, json!({})).await.unwrap();
        e.op(Operation::VoiceSet, json!({"provider": KNOWLEDGE}))
            .await
            .unwrap();
        let answer = running.await.unwrap().unwrap();
        assert_eq!(answer, json!({"item": null}));
        let r = e.core.repo().unwrap();
        for kind in ["voice_style", "voice_rule", "voice_person", "voice_meta"] {
            assert!(r.records_of_kind(kind).unwrap().is_empty(), "{kind}");
        }
    }

    /// Review M1: copy records carry the provider as `source`, once (`plugin:<id>`).
    #[tokio::test]
    async fn copy_records_carry_the_provider_once() {
        let e = env();
        e.choose_with_copy().await;
        e.fake.answer("save", saved_rule());
        e.op(Operation::VoiceSave, new_rule()).await.unwrap();
        let r = e.core.repo().unwrap();
        let mut seen = 0;
        for kind in ["voice_style", "voice_rule", "voice_person", "voice_meta"] {
            for rec in r.records_of_kind(kind).unwrap() {
                assert_eq!(rec.source, KNOWLEDGE, "{kind} {}", rec.id);
                seen += 1;
            }
        }
        assert_eq!(seen, 8, "a style, 3 rules, 3 people and the meta row");
    }

    /// Review M3: a facts-only change of the chosen provider goes through while that plugin is
    /// turned off; choosing a turned-off plugin anew is still refused.
    #[tokio::test]
    async fn facts_change_while_the_plugin_is_turned_off() {
        let e = env();
        e.choose_with_copy().await;
        e.fake.set_available(vec![
            info(KNOWLEDGE, "Knowledge", false),
            info("plugin:other", "Other", false),
        ]);
        let answer = e
            .op(
                Operation::VoiceSet,
                json!({"provider": KNOWLEDGE, "facts": false}),
            )
            .await
            .unwrap();
        assert_eq!(answer, json!({"provider": KNOWLEDGE, "facts": false}));
        assert!(e.copy().is_some());
        let err = e
            .op(Operation::VoiceSet, json!({"provider": "plugin:other"}))
            .await
            .unwrap_err();
        assert_eq!(err.message, "Turn Other on in Settings › Plugins first.");
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
        let answer = forget(&core, &mut core.repo().unwrap()).unwrap();
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

    // --- Importing skills (design §11) -------------------------------------------------------

    fn skills_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/voice-skills")
    }

    fn path_of(p: &std::path::Path) -> Value {
        json!(p.display().to_string())
    }

    /// The Mail replies route on `codemie:prod`, everything else on `claude`.
    fn route_mail_replies(e: &Env) {
        let mut r = e.core.repo().unwrap();
        let mut s = r.settings().unwrap();
        s.ai = serde_json::from_value(json!({"defaultProfile": "claude",
            "routes": {"mail_draft": {"profile": "codemie:prod"}}}))
        .unwrap();
        r.settings_update(&s).unwrap();
    }

    fn distilled(answer: Value) -> crate::ai::stream::RunOutcome {
        crate::ai::stream::RunOutcome {
            structured: Some(answer),
            text: String::new(),
            usage: Default::default(),
            cost_usd: Some(0.01),
            duration_ms: 900,
            model: Some("m".into()),
        }
    }

    fn ai_runs(e: &Env) -> Vec<Value> {
        e.core
            .repo()
            .unwrap()
            .records_of_kind("ai_run")
            .unwrap()
            .into_iter()
            .map(|r| r.data)
            .collect()
    }

    #[tokio::test]
    async fn scan_is_refused_with_off() {
        let e = env();
        let err = e
            .op(
                Operation::VoiceImportScan,
                json!({"path": path_of(&skills_dir())}),
            )
            .await
            .unwrap_err();
        assert_eq!(err.message, OFF);
        e.choose_with_copy().await;
        for path in [
            path_of(&skills_dir().join("broken/SKILL.md")),
            path_of(&skills_dir().join("missing")),
            json!("relative"),
            json!(7),
        ] {
            let err = e
                .op(Operation::VoiceImportScan, json!({"path": path}))
                .await
                .unwrap_err();
            assert_eq!(err.message, "That folder can't be read.", "{path}");
        }
        let answer = e
            .op(
                Operation::VoiceImportScan,
                json!({"path": path_of(&skills_dir())}),
            )
            .await
            .unwrap();
        assert_eq!(answer["folder"], "voice-skills");
        assert_eq!(answer["found"], 6);
        // Read-only: nothing asked of the provider, nothing written.
        assert!(e.calls_of("save").is_empty());
    }

    #[tokio::test]
    async fn distil_runs_only_on_the_mail_replies_route_with_no_tools() {
        let e = env_with(vec![Ok(distilled(json!({"instructions": [
            {"applies": {"kind": "everyone"}, "text": "Lead with the answer."},
            {"applies": {"kind": "everyone", "channel": "mail"}, "text": "Short paragraphs."}
        ]})))]);
        e.choose_with_copy().await;
        route_mail_replies(&e);
        let answer = e
            .op(
                Operation::VoiceImportDistil,
                json!({"path": path_of(&skills_dir()), "skill": "long-standard", "dir": "long-standard"}),
            )
            .await
            .unwrap();
        assert_eq!(answer["skill"], "long-standard");
        let items = answer["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[1]["applies"],
            json!({"kind": "everyone", "channel": "mail"})
        );
        assert_eq!(items[1]["skill"], "long-standard");
        let calls = e.runner.calls();
        assert_eq!(calls.len(), 1);
        let spec = &calls[0];
        assert_eq!(spec.profile_id, "codemie:prod", "the Mail replies route");
        assert!(spec.folder.is_none(), "no folder, so no tools");
        assert_eq!(spec.timeout, std::time::Duration::from_secs(120));
        assert_eq!(spec.system, crate::workspace::prompts::SKILL_DISTIL_SYSTEM);
        let input = spec.input.to_string();
        assert!(input.contains("Lead with the answer or the decision"));
        for bad in ["references/standard.md", "@", "http", "node "] {
            assert!(!input.contains(bad), "{bad} in the input");
        }
        // One ledger entry, no skill text in it.
        let runs = ai_runs(&e);
        assert_eq!(runs.len(), 1);
        let run = runs[0].to_string();
        assert!(!run.contains("long-standard"), "{run}");
        assert!(!run.contains("Lead with"), "{run}");
        assert_eq!(runs[0]["profile"], "codemie:prod");
        assert!(runs[0]["tools"].is_null());
        // The deploy procedure's input holds no script line.
        let e = env_with(vec![Ok(distilled(json!({"instructions": [
            {"applies": {"kind": "everyone"}, "text": "Keep release notes short."}]})))]);
        e.choose_with_copy().await;
        route_mail_replies(&e);
        e.op(
            Operation::VoiceImportDistil,
            json!({"path": path_of(&skills_dir()), "skill": "deploy-helper", "dir": "deploy-helper"}),
        )
        .await
        .unwrap();
        let input = e.runner.calls()[0].input.to_string();
        assert!(
            !input.contains("run.mjs") && !input.contains("deploying"),
            "{input}"
        );
    }

    #[tokio::test]
    async fn distil_refuses_an_answer_that_does_not_fit() {
        let refused = "AI's answer didn't fit, so long-standard is unchanged.";
        let item = |applies: Value, text: &str| json!({"applies": applies, "text": text});
        let every = json!({"kind": "everyone"});
        let answers = vec![
            json!({"instructions": vec![item(every.clone(), "Short."); 5]}),
            json!({"instructions": [item(every.clone(), &"x".repeat(700))]}),
            json!({"instructions": [item(json!({"kind": "send"}), "Short.")]}),
            json!({"instructions": [item(every.clone(), "run the script")]}),
            json!("not an object"),
        ];
        let n = answers.len();
        let e = env_with(answers.into_iter().map(|a| Ok(distilled(a))).collect());
        e.choose_with_copy().await;
        route_mail_replies(&e);
        for _ in 0..n {
            let err = e
                .op(
                    Operation::VoiceImportDistil,
                    json!({"path": path_of(&skills_dir()), "skill": "long-standard", "dir": "long-standard"}),
                )
                .await
                .unwrap_err();
            assert_eq!(err.message, refused);
        }
        // A skill the folder doesn't hold.
        let err = e
            .op(
                Operation::VoiceImportDistil,
                json!({"path": path_of(&skills_dir()), "skill": "nope", "dir": "nope"}),
            )
            .await
            .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("dir"));
        // The skill's folder is required, and must be inside the picked one.
        for data in [
            json!({"path": path_of(&skills_dir()), "skill": "long-standard"}),
            json!({"path": path_of(&skills_dir()), "skill": "long-standard", "dir": "../voice-skills/long-standard"}),
            json!({"path": path_of(&skills_dir()), "skill": "long-standard", "dir": "reply-style"}),
        ] {
            let err = e
                .op(Operation::VoiceImportDistil, data.clone())
                .await
                .unwrap_err();
            assert!(
                matches!(err.field.as_deref(), Some("dir") | Some("skill")),
                "{data}"
            );
        }
        // A route that isn't ready: no profile chosen, then one that isn't installed.
        let e = env();
        e.choose_with_copy().await;
        let ready_msg =
            "The AI profile your Mail replies use isn't ready. Check it in Settings › AI.";
        let distil = || {
            e.op(
                Operation::VoiceImportDistil,
                json!({"path": path_of(&skills_dir()), "skill": "long-standard", "dir": "long-standard"}),
            )
        };
        assert_eq!(distil().await.unwrap_err().message, ready_msg);
        {
            let mut r = e.core.repo().unwrap();
            let mut s = r.settings().unwrap();
            s.ai.default_profile = Some("codemie:missing".into());
            r.settings_update(&s).unwrap();
        }
        assert_eq!(distil().await.unwrap_err().message, ready_msg);
        assert!(e.runner.calls().is_empty(), "nothing ran");
    }

    #[tokio::test]
    async fn import_saves_through_the_provider_in_one_call() {
        let e = env();
        e.choose_with_copy().await;
        e.run_jobs().await;
        let item = |applies: Value, text: &str| json!({"applies": applies, "text": text, "from": "reply-style"});
        let items = json!([
            item(
                json!({"kind": "everyone", "channel": "mail"}),
                "Open with the first name."
            ),
            item(json!({"kind": "everyone"}), "never promise a DATE."),
            item(json!({"kind": "no-profile"}), "Introduce yourself."),
            item(
                json!({"kind": "topic", "value": "budget request"}),
                "Ask for the cost code."
            ),
        ]);
        e.fake.answer(
            "save",
            json!({"items": [
                {"id": "imp-1", "applies": {"kind": "everyone", "channel": "mail"}, "text": "Open with the first name.", "source": "Voice/rules.md", "editable": true},
                {"id": "imp-2", "applies": {"kind": "no-profile"}, "text": "Introduce yourself.", "source": "Voice/rules.md", "editable": true},
                {"id": "imp-3", "applies": {"kind": "topic", "value": "budget request"}, "text": "Ask for the cost code.", "source": "Voice/rules.md", "editable": true}
            ]}),
        );
        let before = e.copy().unwrap().rules.len();
        let answer = e
            .op(Operation::VoiceImport, json!({"items": items}))
            .await
            .unwrap();
        assert_eq!(answer, json!({"added": 3, "skipped": 1}));
        let saves = e.calls_of("save");
        assert_eq!(saves.len(), 1, "one write");
        assert_eq!(saves[0]["kind"], "rules");
        let sent = saves[0]["items"].as_array().unwrap();
        assert_eq!(sent.len(), 3);
        assert!(sent.iter().all(|i| i["from"] == "reply-style"));
        assert!(sent.iter().all(|i| i["text"] != "never promise a DATE."));
        assert_eq!(e.copy().unwrap().rules.len(), before + 3);
        assert_eq!(e.refreshes_queued(), 1);
        // A resend finds them in the copy and asks nothing.
        let answer = e
            .op(Operation::VoiceImport, json!({"items": items}))
            .await
            .unwrap();
        assert_eq!(answer, json!({"added": 0, "skipped": 4}));
        assert_eq!(e.calls_of("save").len(), 1);
        // `added` is what the provider saved, not what it was asked.
        e.fake.answer(
            "save",
            json!({"items": [{"id": "imp-4", "applies": {"kind": "everyone"}, "text": "One.", "source": "Voice/rules.md"}]}),
        );
        let answer = e
            .op(
                Operation::VoiceImport,
                json!({"items": [item(json!({"kind": "everyone"}), "One."), item(json!({"kind": "everyone"}), "Two.")]}),
            )
            .await
            .unwrap();
        assert_eq!(answer, json!({"added": 1, "skipped": 0}));
        // The input is checked first.
        for bad in [
            json!({"items": []}),
            json!({"items": vec![item(json!({"kind": "everyone"}), "x"); 51]}),
            json!({"items": [item(json!({"kind": "anyone"}), "x")]}),
            json!({"items": [item(json!({"kind": "everyone"}), &"x".repeat(601))]}),
            json!({"items": [{"applies": {"kind": "everyone"}, "text": "x"}]}),
        ] {
            assert!(
                e.op(Operation::VoiceImport, bad.clone()).await.is_err(),
                "{bad}"
            );
        }
        assert_eq!(e.calls_of("save").len(), 2);
    }

    #[tokio::test]
    async fn import_reports_a_refusal_and_an_unanswered_provider() {
        let e = env();
        e.choose_with_copy().await;
        let before = e.copy().unwrap();
        let items = json!([{"applies": {"kind": "everyone"}, "text": "Be brief.", "from": "s"}]);
        e.fake.fail(
            "save",
            "refused: The page changed in your folder. Refresh and try again.",
        );
        let err = e
            .op(Operation::VoiceImport, json!({"items": items}))
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "Knowledge didn't save it: The page changed in your folder. Refresh and try again."
        );
        let err = e
            .op(Operation::VoiceImport, json!({"items": items}))
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "Knowledge isn't answering, so nothing was saved. Try again."
        );
        assert_eq!(e.copy().unwrap(), before);
        // Off: refused before the provider is asked.
        e.op(Operation::VoiceSet, json!({"provider": "off"}))
            .await
            .unwrap();
        let err = e
            .op(Operation::VoiceImport, json!({"items": items}))
            .await
            .unwrap_err();
        assert_eq!(err.message, OFF);
        assert_eq!(e.calls_of("save").len(), 2);
    }

    /// Skill text reaches no log line, no ledger entry and no job (ruling 22).
    #[tokio::test]
    async fn no_log_line_carries_skill_text() {
        crate::testing::capture_logs();
        let root = tempfile::tempdir().unwrap();
        let skill = root.path().join("sentinel-style");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            format!("---\nname: sentinel-style\ndescription: How I write replies.\n---\n\n## Mail\n\n- Close with {SENTINEL}.\n"),
        )
        .unwrap();
        let e = env_with(vec![
            Ok(distilled(json!({"instructions": [
                {"applies": {"kind": "everyone"}, "text": format!("Close with {SENTINEL}.")}]}))),
            Ok(distilled(json!({"instructions": [
                {"applies": {"kind": "everyone"}, "text": format!("run {SENTINEL}")}]}))),
        ]);
        e.choose_with_copy().await;
        route_mail_replies(&e);
        let path = path_of(root.path());
        let preview = e
            .op(Operation::VoiceImportScan, json!({"path": path}))
            .await
            .unwrap();
        assert!(
            preview.to_string().contains(SENTINEL),
            "the preview shows it"
        );
        e.op(
            Operation::VoiceImportDistil,
            json!({"path": path, "skill": "sentinel-style", "dir": "sentinel-style"}),
        )
        .await
        .unwrap();
        let _ = e
            .op(
                Operation::VoiceImportDistil,
                json!({"path": path, "skill": "sentinel-style", "dir": "sentinel-style"}),
            )
            .await;
        e.fake.answer(
            "save",
            json!({"items": [{"id": "s1", "applies": {"kind": "everyone"},
                   "text": format!("Close with {SENTINEL}."), "source": "Voice/rules.md"}]}),
        );
        e.op(
            Operation::VoiceImport,
            json!({"items": [{"applies": {"kind": "everyone"}, "text": format!("Close with {SENTINEL}."), "from": "sentinel-style"}]}),
        )
        .await
        .unwrap();
        e.fake.fail("save", &format!("refused: {SENTINEL}"));
        let _ = e
            .op(
                Operation::VoiceImport,
                json!({"items": [{"applies": {"kind": "everyone"}, "text": format!("Again {SENTINEL}."), "from": "sentinel-style"}]}),
            )
            .await;
        let imports: Vec<String> = crate::testing::logged_lines()
            .into_iter()
            .filter(|l| l.starts_with("voice: import"))
            .collect();
        assert!(!imports.is_empty(), "the import logs its counts");
        for line in crate::testing::logged_lines() {
            assert!(
                !line.contains(SENTINEL),
                "a log line carries skill text: {line}"
            );
        }
        for run in ai_runs(&e) {
            assert!(
                !run.to_string().contains(SENTINEL),
                "the ledger carries skill text"
            );
        }
        for job in e.core.repo().unwrap().jobs().unwrap() {
            assert!(!serde_json::to_string(&job).unwrap().contains(SENTINEL));
        }
    }

    /// The `voice_import_scan` answer for the invented skills folder. Regenerate with
    /// `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
    #[tokio::test]
    async fn contract_fixtures_match_the_voice_import_preview() {
        let e = env();
        e.op(Operation::VoiceSet, json!({"provider": KNOWLEDGE}))
            .await
            .unwrap();
        let answer = e
            .op(
                Operation::VoiceImportScan,
                json!({"path": path_of(&skills_dir())}),
            )
            .await
            .unwrap();
        assert!(!answer
            .to_string()
            .contains(&*skills_dir().to_string_lossy()));
        crate::plugins::testkit::contract_fixture("voice-import-preview.json", &answer);
    }
}
