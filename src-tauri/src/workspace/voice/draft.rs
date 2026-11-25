//! The voice and the facts in every reply draft (reply voice design §4 "The asks", §10, rulings
//! 3, 5, 19, 20, 28, 33-35): `Core::voice_for_draft` gives a draft, manual or automatic, its
//! `<voice>` block, its `<facts>` block and the provenance that says what shaped them.
//!
//! Before a draft runs, when a provider is chosen, Connect asks it `context` and — when facts
//! are on, the provider offers them and the marked message yields a term — `facts`, both inside
//! one 3 s window, abandoned when the draft's job is stopped. The asks carry the person's name,
//! address and Teams id, the channel, the subject, the matched person's page id and the
//! extracted terms; never message text (ruling 19). A `context` answer is merged into Connect's
//! copy after the window (never under the mutation lock); no answer means the copy is used.
//! Facts are never kept (ruling 35): a missed ask leaves them out and says so (`factsMissed`).
//! Nothing here logs voice, fact or term text: only codes and counts.
use super::assemble::{self, Channel, DraftTarget, Example, From};
use super::copy::{self, Copy};
use super::sent::{own_sent, SentFilter};
use super::{facts, ops::plugin_of, terms, VoiceError, VoiceProviders, VoiceState};
use crate::workspace::models::{now, Connection, Record, Result, Workspace};
use crate::workspace::Core;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Both per-draft asks together (design §4, ruling 3).
pub const ASK_LIMIT: Duration = Duration::from_secs(3);
/// Examples come from the last 180 days (design §4 "the examples").
const EXAMPLE_DAYS: i64 = 180;
/// How many of the user's sent messages to the person are read before the ones already in the
/// draft's `<message>` context are left out (at most 12 of them, `prompts::draft_window`), so
/// four older ones are still found.
const EXAMPLE_READ: usize = 32;

/// What a draft gains from the reply voice: the `<voice>` and `<facts>` blocks for its input and
/// the `voice` part of its provenance (design §4 "Provenance"). All `None` when the voice is Off.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VoiceForDraft {
    pub voice: Option<String>,
    pub facts: Option<String>,
    pub provenance: Option<Value>,
}

/// What is read before the asks, under one repository guard released before any await.
struct Prepared {
    provider: String,
    name: String,
    /// The provider is listed and turned on, so it can be asked at all.
    reachable: bool,
    facts_on: bool,
    copy: Option<Copy>,
    target: DraftTarget,
    examples: Vec<Example>,
    person_id: Option<String>,
    terms: Vec<String>,
    /// `Core::voice_epoch` when the copy was read: a delete of the copy (or another provider)
    /// since then makes a `context` answer stale for the copy, even when the same provider is
    /// chosen again before it comes back.
    epoch: usize,
}

/// The `context` ask's input (design §1): never message text.
fn context_args(t: &DraftTarget) -> Value {
    json!({
        "person": {"name": t.name, "address": t.address, "id": t.from_id},
        "channel": match t.channel { Channel::Mail => "mail", Channel::Teams => "teams" },
        "subject": t.subject,
    })
}

/// The user's own earlier messages to the target's person (design §4 "the examples", ruling 28):
/// mail by the person's address, Teams by the 1:1 chat with the sender's id; newest first, never
/// one already in the draft's `<message>` context (or, for an automation, anywhere else the run
/// shows: `shown`), last 180 days, at most four (each is cut to
/// 400 characters by `assemble`). No person → no examples.
fn examples_for(
    r: &crate::workspace::repository::Repository,
    t: &DraftTarget,
    shown: &[String],
) -> Vec<Example> {
    let (channel, address, from_id) = match t.channel {
        Channel::Mail => match &t.address {
            Some(a) => ("mail", Some(a.clone()), None),
            None => return Vec::new(),
        },
        Channel::Teams => match &t.from_id {
            Some(id) => ("chat", None, Some(id.clone())),
            None => return Vec::new(),
        },
    };
    let filter = SentFilter {
        channel: channel.into(),
        days: EXAMPLE_DAYS,
        limit: EXAMPLE_READ,
        address,
        from_id,
        chat_id: None,
    };
    let shown: HashSet<&str> = t
        .in_context
        .iter()
        .chain(shown)
        .map(String::as_str)
        .collect();
    match own_sent(r, &filter, now()) {
        Ok(items) => items
            .into_iter()
            .filter(|m| !shown.contains(m.record_id.as_str()))
            .take(assemble::EXAMPLES_MAX)
            .map(|m| Example {
                at: m.at,
                text: m.text,
            })
            .collect(),
        Err(e) => {
            log::warn!("voice: examples unreadable: {}", e.code);
            Vec::new()
        }
    }
}

/// A `context` answer as a copy of its own, for a provider whose copy was never filled.
fn copy_of_answer(answer: &Value) -> Copy {
    let people: Vec<Value> = answer["person"]
        .is_object()
        .then(|| answer["person"].clone())
        .into_iter()
        .collect();
    copy::from_export(
        &json!({"style": answer["style"], "rules": answer["rules"], "people": people}),
    )
}

/// One provider call within the shared deadline: `None` when it didn't answer in time.
async fn ask(
    providers: Arc<dyn VoiceProviders>,
    plugin: String,
    op: &'static str,
    args: Value,
    deadline: tokio::time::Instant,
) -> Option<std::result::Result<Value, VoiceError>> {
    let call = providers.call(&plugin, op, args, ASK_LIMIT);
    tokio::time::timeout_at(deadline, call).await.ok()
}

impl Core {
    /// The voice and the facts for a draft answering `source` (design §4, §10). Off → all
    /// `None`, no provider call and no examples read. Otherwise the copy (merged with a `context`
    /// answer that came in time) is matched and fitted to its budget, the examples ride with it,
    /// and the facts the provider found in time get their own block; provenance records the parts,
    /// where the voice came from, the facts' `{id, title}` and whether facts were missed. Never
    /// fails a draft: anything unreadable means no voice.
    pub(crate) async fn voice_for_draft(
        &self,
        w: &Workspace,
        me: &Connection,
        source: &Record,
        cancel: &CancellationToken,
    ) -> VoiceForDraft {
        self.voice_for_draft_beside(w, me, source, &[], cancel)
            .await
    }

    /// [`Self::voice_for_draft`] for a draft whose input also shows the records `shown` (an
    /// automation's other blocks, such as `recentMessages`): none of them is repeated as an
    /// example (design §4 "never one already in the draft's context").
    pub(crate) async fn voice_for_draft_beside(
        &self,
        w: &Workspace,
        me: &Connection,
        source: &Record,
        shown: &[String],
        cancel: &CancellationToken,
    ) -> VoiceForDraft {
        let p = match self.voice_prepare(w, me, source, shown) {
            Ok(Some(p)) => p,
            Ok(None) => return VoiceForDraft::default(),
            Err(e) => {
                log::warn!("voice: draft voice unreadable: {}", e.code);
                return VoiceForDraft::default();
            }
        };
        let wants_facts = p.facts_on && !p.terms.is_empty();
        let providers = self.voice_providers.get().cloned();

        let (context, found) = match providers.filter(|_| p.reachable) {
            None => (None, None),
            Some(providers) => {
                let deadline = tokio::time::Instant::now() + ASK_LIMIT;
                let plugin = plugin_of(&p.provider).to_string();
                let context = ask(
                    providers.clone(),
                    plugin.clone(),
                    "context",
                    context_args(&p.target),
                    deadline,
                );
                let facts_args = json!({"terms": p.terms, "personId": p.person_id});
                let facts_ask = async {
                    if wants_facts {
                        ask(providers, plugin, "facts", facts_args, deadline).await
                    } else {
                        None
                    }
                };
                tokio::select! {
                    _ = cancel.cancelled() => (None, None),
                    both = async { tokio::join!(context, facts_ask) } => both,
                }
            }
        };
        let context = context.and_then(std::result::Result::ok);
        let (kept, facts_cut, facts_missed) = match found {
            Some(Ok(answer)) if wants_facts => {
                let (kept, cut) = facts::from_answer(&answer);
                (kept, cut, false)
            }
            _ => (Vec::new(), false, wants_facts),
        };

        // After the window, outside any lock but the repository's own: merge what `context`
        // answered, unless the voice was turned off or changed while it was asked (§6: a deleted
        // copy is never refilled by a draft).
        let (copy, from) = match &context {
            None => (p.copy, From::Copy),
            Some(answer) => {
                match self.voice_merge(&p.provider, p.epoch, p.copy.is_some(), answer) {
                    Ok(Some(merged)) => (Some(merged), From::Provider),
                    Ok(None) => (Some(copy_of_answer(answer)), From::Provider),
                    Err(e) if e.code == "voice_changed" => return VoiceForDraft::default(),
                    // Unmerged: the copy as it was, never the bare answer (it would drop the style
                    // card and the other instructions for this draft).
                    Err(e) => {
                        log::warn!("voice: context answer not merged: {}", e.code);
                        (p.copy, From::Copy)
                    }
                }
            }
        };
        let empty = Copy {
            provider: p.provider.clone(),
            refreshed_at: 0,
            state: VoiceState::Unavailable,
            style: None,
            rules: Vec::new(),
            people: Vec::new(),
        };
        let copy = copy.unwrap_or(empty);
        let assembled = assemble::assemble(&copy, &p.name, &p.target, &p.examples, from);
        let facts_block = facts::block(&p.name, &kept);
        let from_name = match from {
            From::Provider => "provider",
            From::Copy => "copy",
        };
        let mut provenance = match &assembled {
            Some(a) => a.provenance.clone(),
            None if facts_block.is_some() || facts_missed => json!({
                "provider": p.name, "style": false, "person": null, "rules": 0, "examples": 0,
                "cut": false, "from": from_name,
            }),
            None => return VoiceForDraft::default(),
        };
        provenance["facts"] = facts::sources(&kept);
        provenance["factsMissed"] = facts_missed.into();
        if facts_cut {
            provenance["cut"] = true.into();
        }
        log::info!(
            "voice: draft from {from_name}, {} examples, {} facts, facts missed {facts_missed}",
            provenance["examples"],
            kept.len()
        );
        VoiceForDraft {
            voice: assembled.map(|a| a.block),
            facts: facts_block,
            provenance: Some(provenance),
        }
    }

    /// Reads, under one repository guard, what the asks and the assembly need; `None` when the
    /// voice is Off.
    fn voice_prepare(
        &self,
        w: &Workspace,
        me: &Connection,
        source: &Record,
        shown: &[String],
    ) -> Result<Option<Prepared>> {
        let r = self.repo()?;
        // Read under the guard every copy delete holds while it bumps the epoch.
        let epoch = self.voice_epoch.load(std::sync::atomic::Ordering::SeqCst);
        let settings = r.settings()?.voice;
        if settings.provider == "off" {
            return Ok(None);
        }
        let listed = self
            .voice_providers
            .get()
            .map(|p| p.available())
            .unwrap_or_default()
            .into_iter()
            .find(|p| p.id == settings.provider);
        let name = listed.as_ref().map_or_else(
            || plugin_of(&settings.provider).to_string(),
            |p| p.name.clone(),
        );
        let copy = copy::read_copy(&r)?;
        let target = assemble::target_of(&r, w, me, source)?;
        let examples = examples_for(&r, &target, shown);
        drop(r);
        let person = copy
            .as_ref()
            .and_then(|c| assemble::match_person(&c.people, &target));
        let mut skip: Vec<&str> = vec![me.display_name.as_str()];
        skip.extend(me.given_name.as_deref());
        skip.extend(target.name.as_deref());
        if let Some(p) = person {
            skip.push(&p.name);
            skip.extend(p.names.iter().map(String::as_str));
        }
        let terms = terms::terms_of(&target.subject, &target.text, &skip);
        Ok(Some(Prepared {
            reachable: listed.as_ref().is_some_and(|p| p.on),
            facts_on: settings.facts && listed.as_ref().is_some_and(|p| p.facts),
            person_id: person.map(|p| p.id.clone()),
            provider: settings.provider,
            name,
            copy,
            target,
            examples,
            terms,
            epoch,
        }))
    }

    /// Merges a `context` answer into the copy (design §2) when the same provider is still
    /// chosen and the copy wasn't deleted or replaced since it was read (`epoch`, the guard
    /// `voice_save` uses); answers the merged copy, or `None` when there is no copy to merge
    /// into (a provider never refreshed yet: the answer stands alone for this draft). Refuses
    /// with `voice_changed` when the voice was turned off, changed, or its copy deleted while
    /// it was asked, so a late answer writes nothing.
    fn voice_merge(
        &self,
        provider: &str,
        epoch: usize,
        had_copy: bool,
        answer: &Value,
    ) -> Result<Option<Copy>> {
        let mut r = self.repo()?;
        let moved = self.voice_epoch.load(std::sync::atomic::Ordering::SeqCst) != epoch;
        if moved || r.settings()?.voice.provider != provider {
            return Err(crate::workspace::models::WorkspaceError::new(
                "voice_changed",
                "The voice changed while the draft asked for it.",
            ));
        }
        if !had_copy {
            return Ok(None);
        }
        copy::merge_context(&mut r, provider, answer, now())?;
        copy::read_copy(&r)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::workspace::ai::tests::ready;
    use crate::workspace::voice::fake::FakeVoice;
    use crate::workspace::voice::ops::tests::export_answer;
    use crate::workspace::voice::VoiceInfo;
    use crate::workspace::{test_core, Core};

    pub(crate) const KNOWLEDGE: &str = "plugin:knowledge";
    pub(crate) const SENTINEL: &str = "VOICE_SENTINEL_9f3a";
    pub(crate) const MAREK_ID: &str = "00000000-0000-4000-8000-00000000a003";

    pub(crate) fn knowledge(facts: bool) -> VoiceInfo {
        VoiceInfo {
            id: KNOWLEDGE.into(),
            name: "Knowledge".into(),
            on: true,
            ready: true,
            facts,
        }
    }

    /// Chooses Knowledge on `core`, with facts on and offered, and a ready copy holding
    /// `export_answer(extra)` (Priya by address, Marek by Teams id, a `to` and an `everyone`
    /// instruction).
    pub(crate) fn ready_voice(core: &Core, extra: &str) -> Arc<FakeVoice> {
        let fake = Arc::new(FakeVoice::new());
        fake.set_available(vec![knowledge(true)]);
        core.set_voice_providers(fake.clone());
        let mut r = core.repo().unwrap();
        let mut s = r.settings().unwrap();
        s.voice.provider = KNOWLEDGE.into();
        s.voice.facts = true;
        r.settings_update(&s).unwrap();
        let c = copy::from_export(&export_answer(extra));
        copy::replace(&mut r, KNOWLEDGE, &c, now()).unwrap();
        fake
    }

    /// Every call of `op` the provider got, its arguments.
    pub(crate) fn calls_of(fake: &FakeVoice, op: &str) -> Vec<Value> {
        fake.calls()
            .into_iter()
            .filter(|(_, o, _)| o == op)
            .map(|(_, _, a)| a)
            .collect()
    }

    /// A `context` answer for Priya, as Knowledge gives it today.
    pub(crate) fn priya_context(extra: &str) -> Value {
        json!({
            "style": null,
            "person": {"id": "priya-n", "name": "Priya N.", "names": ["Priya"],
                       "addresses": ["priya.n@example.test"], "ids": [],
                       "text": format!("From the provider: two lines at most. {extra}"),
                       "about": "Product lead.", "updatedAt": "", "source": "People/priya-n.md"},
            "rules": [{"id": "to-priya-n-example-test",
                       "applies": {"kind": "to", "value": "priya.n@example.test"},
                       "text": "Short, bullet points.", "source": "Voice/rules.md", "editable": true}]
        })
    }

    /// Two facts for the Atlas rollout; `extra` goes into the first one's text.
    pub(crate) fn atlas_facts(extra: &str) -> Value {
        json!({"facts": [
            {"id": "projects/atlas-rollout.md", "title": "Atlas rollout",
             "text": format!("Go-live moved to 2026-12-08. {extra}")},
            {"id": "tickets/epm-1234.md", "title": "EPM-1234",
             "text": "Blocked on the vendor's certificate."}
        ]})
    }

    pub(crate) const ACCT: &str = "acct";

    /// The signed-in account (Taylor Reed, user id `me-1`), the personal workspace reading
    /// everything.
    pub(crate) fn seed(core: &Core) -> (Workspace, Connection) {
        let mut r = core.repo().unwrap();
        let c = Connection {
            id: ACCT.into(),
            account_key: ACCT.into(),
            display_name: "Taylor Reed".into(),
            email: "taylor@example.test".into(),
            user_id: "me-1".into(),
            generation: 1,
            policy_revision: 1,
            scopes: vec!["Mail.Read".into(), "Chat.Read".into()],
            enabled: vec!["mail".into(), "chats".into()],
            status: "connected".into(),
            given_name: Some("Taylor".into()),
            ..Default::default()
        };
        r.save_connection(&c).unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some(ACCT.into());
        r.settings_update(&s).unwrap();
        let mut w = r.workspace("personal").unwrap();
        w.connection_id = Some(ACCT.into());
        w.sources = json!({"all": true});
        r.save_workspace(&w).unwrap();
        (w, c)
    }

    /// A mail in conversation `conv`: from Priya to Taylor, or (mine) from Taylor to Priya.
    pub(crate) fn priya_mail(
        id: &str,
        conv: &str,
        at: i64,
        mine: bool,
        title: &str,
        text: &str,
    ) -> Record {
        let (from, from_address, to) = if mine {
            (
                "Taylor Reed",
                "taylor@example.test",
                ("Priya N.", "priya.n@example.test"),
            )
        } else {
            (
                "Priya N.",
                "priya.n@example.test",
                ("Taylor Reed", "taylor@example.test"),
            )
        };
        Record {
            id: id.into(),
            kind: "message".into(),
            connection_id: Some(ACCT.into()),
            workspace_id: None,
            source: if mine { "mail:sentitems" } else { "mail:inbox" }.into(),
            revision: "v1".into(),
            updated_at: at,
            data: json!({"channel": "mail", "conversationId": conv, "title": title,
                "from": from, "fromAddress": from_address,
                "to": [{"emailAddress": {"name": to.0, "address": to.1}}],
                "replyTo": [], "isMine": mine, "isRead": false, "at": at, "text": text,
                "providerId": format!("p-{id}")}),
        }
    }

    /// A Teams message in the 1:1 chat with Marek: his (with his `fromId`) or mine.
    pub(crate) fn marek_chat(id: &str, at: i64, mine: bool, text: &str) -> Record {
        let mut data = json!({"channel": "chat", "conversationId": "chat:19:marek", "chatId": "19:marek",
            "title": "Marek Novak", "isMine": mine, "at": at, "text": text});
        if mine {
            data["from"] = "Taylor Reed".into();
            data["fromId"] = "me-1".into();
        } else {
            data["from"] = "Marek Novak".into();
            data["fromId"] = MAREK_ID.into();
        }
        Record {
            id: id.into(),
            kind: "message".into(),
            connection_id: Some(ACCT.into()),
            workspace_id: None,
            source: "chat:19:marek".into(),
            revision: "v1".into(),
            updated_at: at,
            data,
        }
    }

    /// The chats catalog: the 1:1 chat with Marek.
    pub(crate) fn marek_catalog(core: &Core) {
        core.repo()
            .unwrap()
            .put_record(&Record {
                id: "chats".into(),
                kind: "catalog".into(),
                connection_id: Some(ACCT.into()),
                workspace_id: None,
                source: "catalog".into(),
                revision: "v1".into(),
                updated_at: 1,
                data: json!({"values": [{"id": "19:marek", "chatType": "oneOnOne", "topic": null,
                    "members": [{"userId": "me-1", "displayName": "Taylor Reed"},
                                {"userId": MAREK_ID, "displayName": "Marek Novak"}]}]}),
            })
            .unwrap();
    }

    fn put(core: &Core, record: Record) {
        core.repo().unwrap().put_record(&record).unwrap();
    }

    fn core() -> (tempfile::TempDir, Arc<Core>) {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        (dir, core)
    }

    async fn voice_for(core: &Core, w: &Workspace, c: &Connection, id: &str) -> VoiceForDraft {
        let source = core
            .repo()
            .unwrap()
            .record("message", id, Some(ACCT), None)
            .unwrap();
        core.voice_for_draft(w, c, &source, &CancellationToken::new())
            .await
    }

    const DAY: i64 = 86_400;

    #[tokio::test]
    async fn examples_come_from_my_messages_to_this_person() {
        let (_dir, core) = core();
        let (w, c) = seed(&core);
        let _fake = ready_voice(&core, "");
        let t = now();
        // Mine to Priya in another thread (an example), mine to her in this thread (already in
        // the draft's context), and one older than 180 days.
        put(
            &core,
            priya_mail(
                "old",
                "conv-0",
                t - 200 * DAY,
                true,
                "Hello",
                "Ancient reply.",
            ),
        );
        put(
            &core,
            priya_mail(
                "e1",
                "conv-9",
                t - 3 * DAY,
                true,
                "Plan",
                "Two lines, done.",
            ),
        );
        put(
            &core,
            priya_mail(
                "in1",
                "conv-1",
                t - 2 * DAY,
                true,
                "Rollout",
                "In this thread.",
            ),
        );
        put(
            &core,
            priya_mail(
                "p1",
                "conv-1",
                t - DAY,
                false,
                "Rollout",
                "Thanks Priya here.",
            ),
        );
        let v = voice_for(&core, &w, &c, "p1").await;
        let voice = v.voice.expect("a voice block");
        assert!(voice.contains("<examples><example at=\""), "{voice}");
        assert!(voice.contains("Two lines, done."));
        assert!(
            !voice.contains("In this thread."),
            "already in <message> context"
        );
        assert!(!voice.contains("Ancient reply."), "older than 180 days");
        assert_eq!(v.provenance.unwrap()["examples"], 1);

        // Teams: my messages in the 1:1 chat with Marek, older than the context window.
        marek_catalog(&core);
        for i in 0..14 {
            put(
                &core,
                marek_chat(
                    &format!("k{i:02}"),
                    t - DAY + i * 60,
                    i % 2 == 0,
                    &format!("line {i}"),
                ),
            );
        }
        put(
            &core,
            marek_chat("k-old", t - 5 * DAY, true, "Earlier, mine."),
        );
        let v = voice_for(&core, &w, &c, "k13").await;
        let voice = v.voice.unwrap();
        assert!(voice.contains("Earlier, mine."), "{voice}");
        // The 12 newest (k02..k13) are the draft's context; of the older ones, k00 and the
        // earlier one are mine (k01 is Marek's), so they are the examples.
        assert!(voice.contains(">line 0<"), "{voice}");
        for i in (2..14).step_by(2) {
            assert!(
                !voice.contains(&format!(">line {i}<")),
                "line {i} is in context"
            );
        }
        assert_eq!(v.provenance.unwrap()["examples"], 2);
    }

    #[tokio::test]
    async fn a_teams_draft_sends_the_sender_id_and_matches_by_it() {
        let (_dir, core) = core();
        let (w, c) = seed(&core);
        let fake = ready_voice(&core, "");
        put(
            &core,
            marek_chat("k1", now() - 60, false, "Can you check the invoice?"),
        );
        let v = voice_for(&core, &w, &c, "k1").await;
        let ask = &calls_of(&fake, "context")[0];
        assert_eq!(ask["person"]["id"], MAREK_ID);
        assert_eq!(ask["person"]["name"], "Marek Novak");
        assert_eq!(ask["channel"], "teams");
        assert!(!ask.to_string().contains("invoice"), "no message text");
        let voice = v.voice.unwrap();
        assert!(
            voice.contains("<person name=\"Marek Novak\"><writing>Finance contact."),
            "{voice}"
        );
        assert_eq!(v.provenance.unwrap()["person"], "Marek Novak");
    }

    #[tokio::test]
    async fn no_terms_no_facts_ask() {
        let (_dir, core) = core();
        let (w, c) = seed(&core);
        let fake = ready_voice(&core, "");
        put(
            &core,
            priya_mail(
                "p1",
                "conv-1",
                now() - 60,
                false,
                "Re: hello",
                "Thanks Priya!",
            ),
        );
        let v = voice_for(&core, &w, &c, "p1").await;
        assert!(calls_of(&fake, "facts").is_empty());
        assert_eq!(calls_of(&fake, "context").len(), 1);
        assert!(v.facts.is_none());
        let p = v.provenance.unwrap();
        assert_eq!(p["facts"], json!([]));
        assert_eq!(p["factsMissed"], false);
    }

    #[tokio::test]
    async fn facts_off_or_not_offered_sends_no_facts_ask() {
        let (_dir, core) = core();
        let (w, c) = seed(&core);
        let fake = ready_voice(&core, "");
        let text = "Can we move EPM-1234 for Atlas Rollout?";
        put(
            &core,
            priya_mail("p1", "conv-1", now() - 60, false, "Atlas", text),
        );
        {
            let mut r = core.repo().unwrap();
            let mut s = r.settings().unwrap();
            s.voice.facts = false;
            r.settings_update(&s).unwrap();
        }
        let v = voice_for(&core, &w, &c, "p1").await;
        assert!(calls_of(&fake, "facts").is_empty(), "facts are off");
        assert_eq!(v.provenance.unwrap()["factsMissed"], false);

        {
            let mut r = core.repo().unwrap();
            let mut s = r.settings().unwrap();
            s.voice.facts = true;
            r.settings_update(&s).unwrap();
        }
        fake.set_available(vec![knowledge(false)]);
        let v = voice_for(&core, &w, &c, "p1").await;
        assert!(calls_of(&fake, "facts").is_empty(), "not offered");
        assert_eq!(v.provenance.unwrap()["factsMissed"], false);
        assert_eq!(calls_of(&fake, "context").len(), 2);
    }

    #[tokio::test]
    async fn off_reads_nothing_and_asks_nothing() {
        let (_dir, core) = core();
        let (w, c) = seed(&core);
        let fake = ready_voice(&core, "");
        put(
            &core,
            priya_mail(
                "e1",
                "conv-9",
                now() - DAY,
                true,
                "Plan",
                "Two lines, done.",
            ),
        );
        put(
            &core,
            priya_mail(
                "p1",
                "conv-1",
                now() - 60,
                false,
                "Atlas Rollout",
                "EPM-1234?",
            ),
        );
        {
            let mut r = core.repo().unwrap();
            let mut s = r.settings().unwrap();
            s.voice.provider = "off".into();
            r.settings_update(&s).unwrap();
        }
        assert_eq!(
            voice_for(&core, &w, &c, "p1").await,
            VoiceForDraft::default()
        );
        assert!(fake.calls().is_empty());
    }

    /// Deleting the copy (turning the voice off) while `context` is asked leaves this draft with
    /// no voice, and the late answer never refills the copy (design §6, review focus 3).
    #[tokio::test]
    async fn a_copy_deleted_during_the_ask_is_not_refilled() {
        let (_dir, core) = core();
        let (w, c) = seed(&core);
        let fake = ready_voice(&core, "");
        put(
            &core,
            priya_mail("p1", "conv-1", now() - 60, false, "Hello", "Thanks Priya!"),
        );
        fake.delay("context", Duration::from_millis(300));
        fake.answer("context", priya_context(""));
        let source = core
            .repo()
            .unwrap()
            .record("message", "p1", Some(ACCT), None)
            .unwrap();
        let cancel = CancellationToken::new();
        let asking = core.voice_for_draft(&w, &c, &source, &cancel);
        let forget = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let mut r = core.repo().unwrap();
            let mut s = r.settings().unwrap();
            s.voice.provider = "off".into();
            copy::forget_with(&mut r, &s).unwrap();
        };
        let (v, ()) = tokio::join!(asking, forget);
        assert_eq!(v, VoiceForDraft::default());
        assert!(copy::read_copy(&core.repo().unwrap()).unwrap().is_none());
    }

    /// Delete Connect's copy and choosing Knowledge again inside the 3 s window: the provider
    /// string matches again, but the copy was deleted since the ask (`voice_epoch` moved), so a
    /// late `context` answer writes nothing (review minor 1).
    #[tokio::test]
    async fn a_late_answer_after_delete_and_rechoose_writes_nothing() {
        use crate::workspace::ai::tests::mutation;
        use crate::workspace::models::Operation;
        let (_dir, core) = core();
        let (w, c) = seed(&core);
        let fake = ready_voice(&core, "");
        put(
            &core,
            priya_mail("p1", "conv-1", now() - 60, false, "Hello", "Thanks Priya!"),
        );
        fake.delay("context", Duration::from_millis(400));
        fake.answer("context", priya_context(""));
        let source = core
            .repo()
            .unwrap()
            .record("message", "p1", Some(ACCT), None)
            .unwrap();
        let cancel = CancellationToken::new();
        let asking = core.voice_for_draft(&w, &c, &source, &cancel);
        let rechoose = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            core.request(mutation(&core, Operation::VoiceForget, json!({})))
                .await
                .unwrap();
            core.request(mutation(
                &core,
                Operation::VoiceSet,
                json!({"provider": KNOWLEDGE}),
            ))
            .await
            .unwrap();
        };
        let (v, ()) = tokio::join!(asking, rechoose);
        assert_eq!(v, VoiceForDraft::default(), "this draft gets no voice");
        let r = core.repo().unwrap();
        assert_eq!(r.settings().unwrap().voice.provider, KNOWLEDGE);
        for kind in ["voice_style", "voice_rule", "voice_person", "voice_meta"] {
            assert!(
                r.records_of_kind(kind).unwrap().is_empty(),
                "{kind} was written"
            );
        }
    }

    /// A merge that fails for any other reason drafts from the copy as it was (style card and
    /// rules kept), never from the bare answer (review minor 2).
    #[tokio::test]
    async fn a_failed_merge_drafts_from_the_existing_copy() {
        use std::sync::atomic::Ordering;
        let (_dir, core) = core();
        let (w, c) = seed(&core);
        let fake = ready_voice(&core, "");
        put(
            &core,
            priya_mail("p1", "conv-1", now() - 60, false, "Hello", "Thanks Priya!"),
        );
        fake.delay("context", Duration::from_millis(300));
        fake.answer("context", priya_context(""));
        let source = core
            .repo()
            .unwrap()
            .record("message", "p1", Some(ACCT), None)
            .unwrap();
        let cancel = CancellationToken::new();
        let asking = core.voice_for_draft(&w, &c, &source, &cancel);
        // The repository refuses every read while the data folder moves (`busy`).
        let pause = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            core.paused.store(true, Ordering::SeqCst);
        };
        let (v, ()) = tokio::join!(asking, pause);
        core.paused.store(false, Ordering::SeqCst);
        let voice = v.voice.expect("a voice from the copy");
        assert!(voice.contains("<style>Short and direct."), "{voice}");
        assert!(voice.contains("Never promise a date."), "{voice}");
        assert!(voice.contains("Short sentences; no small talk."), "{voice}");
        assert!(!voice.contains("From the provider"), "{voice}");
        assert_eq!(v.provenance.unwrap()["from"], "copy");
    }

    /// A stopped draft abandons the asks at once and drafts from the copy.
    #[tokio::test]
    async fn a_stopped_draft_abandons_the_asks() {
        let (_dir, core) = core();
        let (w, c) = seed(&core);
        let fake = ready_voice(&core, "");
        put(
            &core,
            priya_mail("p1", "conv-1", now() - 60, false, "Hello", "Thanks Priya!"),
        );
        fake.delay("context", Duration::from_secs(10));
        let source = core
            .repo()
            .unwrap()
            .record("message", "p1", Some(ACCT), None)
            .unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let started = std::time::Instant::now();
        let v = core.voice_for_draft(&w, &c, &source, &cancel).await;
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(v.provenance.unwrap()["from"], "copy");
    }
}
