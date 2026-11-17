//! `ctx.deliver` (PLUGIN-ENGINE.md §4.5, DESIGN 7.2). `send(kind, {title, markdown, about, ai})`
//! goes only to a way the sheet named (`uses.deliver.to`):
//! - `today`: a card on Today (one per `about`, replaced when sent again);
//! - `mail`, `teams`: the card, plus a message to the user themself, held for their review and
//!   Confirm, never sent on its own (recipients a plugin names are ignored);
//! - any other kind: the plugin that provides it (`deliver.provide`), asked through the host.
//!
//! `provide(kind, {label})` adds a way a plugin's sheet named (`uses.deliver_provider.kinds`),
//! never `today`, `mail` or `teams`; `ready(kind, ok, why)` says whether it can send now.
use super::{at, bad, lock, permission, text, Granted, Services};
use crate::plugins::host::{ErrorCode, HostError};
use crate::workspace::markdown::normalise;
use crate::workspace::models::{now, Record};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Connect's own ways: no plugin provides these.
const BUILT_IN: [&str; 3] = ["today", "mail", "teams"];

/// A way to send a plugin adds.
#[derive(Debug, Clone)]
pub struct Provider {
    pub plugin: String,
    pub label: String,
    pub ready: bool,
    pub why: String,
}

fn capped(v: &Value, max: usize) -> String {
    v.as_str().unwrap_or("").chars().take(max).collect()
}

pub fn call(s: &Services, p: &Granted, name: &str, args: &Value) -> Result<Value, HostError> {
    match name {
        "deliver.provide" => {
            let kind = text(args, 0, "a way to send")?;
            if BUILT_IN.contains(&kind)
                || !p
                    .words("deliver_provider", "kinds")
                    .iter()
                    .any(|k| k == kind)
            {
                return Err(permission(format!(
                    "{} may add only the ways its sheet named (uses.deliver_provider.kinds)",
                    p.id
                )));
            }
            let label = capped(&at(args, 1)["label"], 40);
            let mut providers = lock(&s.providers);
            let kept = providers
                .get(kind)
                .filter(|x| x.plugin == p.id)
                .map(|x| (x.ready, x.why.clone()));
            let (ready, why) = kept.unwrap_or((false, String::new()));
            providers.insert(
                kind.to_string(),
                Provider {
                    plugin: p.id.clone(),
                    label: if label.is_empty() {
                        kind.to_string()
                    } else {
                        label
                    },
                    ready,
                    why,
                },
            );
            Ok(Value::Null)
        }
        "deliver.ready" => {
            let kind = text(args, 0, "a way to send")?;
            let mut providers = lock(&s.providers);
            let x = providers
                .get_mut(kind)
                .filter(|x| x.plugin == p.id)
                .ok_or_else(|| bad(format!("{} doesn't add “{kind}”", p.id)))?;
            x.ready = at(args, 1) == &Value::Bool(true);
            x.why = capped(at(args, 2), 200);
            Ok(Value::Null)
        }
        "deliver.status" => Ok(status(s)),
        _ => Err(super::unsupported(name)),
    }
}

/// Where Connect can send now: Today always; mail and Teams (held for review) with a connected
/// account; and the ways plugins add.
pub fn status(s: &Services) -> Value {
    let account = s.core().ok().and_then(|c| c.plugin_account());
    let provided: Vec<Value> = lock(&s.providers)
        .iter()
        .map(|(kind, x)| {
            json!({"kind": kind, "label": x.label, "plugin": x.plugin, "ready": x.ready, "why": x.why})
        })
        .collect();
    json!({
        "today": true,
        "mail": account.is_some(),
        "teams": account.is_some(),
        "account": account,
        "provided": provided,
    })
}

pub async fn send(s: &Services, p: &Granted, kind: &str, msg: &Value) -> Result<Value, HostError> {
    p.needs("deliver", "send you messages")?;
    if !p.words("deliver", "to").iter().any(|k| k == kind) {
        return Err(permission(format!(
            "{} may send only the ways its sheet named (uses.deliver.to), not “{kind}”",
            p.id
        )));
    }
    let message = json!({
        "title": capped(&msg["title"], 200),
        "markdown": capped(&msg["markdown"], 20_000),
        "about": capped(&msg["about"], 200),
        "ai": capped(&msg["ai"], 80),
    });
    if BUILT_IN.contains(&kind) {
        s.writable()?;
        return to_today(s, p, kind, &message);
    }
    let provider = lock(&s.providers).get(kind).cloned().ok_or_else(|| {
        HostError::new(
            ErrorCode::NotFound,
            format!("nothing sends to “{kind}” now: the plugin that adds it isn't on"),
        )
    })?;
    if !provider.ready {
        let why = if provider.why.is_empty() {
            "it isn't set up yet".to_string()
        } else {
            provider.why.clone()
        };
        return Err(bad(format!("{} can't send yet: {why}", provider.label)));
    }
    s.host()?
        .ask(&provider.plugin, &format!("deliver:{kind}"), message)
        .await?;
    Ok(Value::Bool(true))
}

/// A Today card (one per `about`), and for mail or Teams a message to the user themself, held.
fn to_today(s: &Services, p: &Granted, kind: &str, m: &Value) -> Result<Value, HostError> {
    let core = s.core()?;
    let about = m["about"].as_str().filter(|a| !a.is_empty());
    let key = about.or(m["title"].as_str()).unwrap_or("");
    let hash: String = Sha256::digest(format!("{kind}\n{key}"))
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect();
    let body = normalise(m["markdown"].as_str().unwrap_or(""));
    let at = now();
    let held = if kind == "today" {
        None
    } else {
        let id = format!("{}:held:{}", p.id, uuid::Uuid::new_v4());
        let record = item(
            &id,
            p,
            at,
            json!({
                "type": "held_message",
                "channel": kind,
                "to": {"self": true, "address": core.plugin_account()},
                "subject": m["title"],
                "markdown": body.markdown,
                "blocks": body.blocks,
                "state": "held",
                "sent": false,
            }),
        );
        core.plugin_put(&record).map_err(stored)?;
        Some(id)
    };
    let card = item(
        &format!("{}:card:{hash}", p.id),
        p,
        at,
        json!({
            "type": "delivery",
            "to": kind,
            "title": m["title"],
            "about": m["about"],
            "ai": m["ai"],
            "markdown": body.markdown,
            "blocks": body.blocks,
            "held": held,
        }),
    );
    core.plugin_put(&card).map_err(stored)?;
    Ok(Value::Bool(true))
}

/// A `plugin_item` record of plugin `p`.
pub(crate) fn item(id: &str, p: &Granted, at: i64, mut data: Value) -> Record {
    data["plugin"] = json!(p.id);
    data["pluginName"] = json!(p.name);
    data["at"] = json!(at);
    Record {
        id: id.to_string(),
        kind: "plugin_item".into(),
        connection_id: None,
        workspace_id: None,
        source: format!("plugin:{}", p.id),
        revision: crate::workspace::models::id(),
        updated_at: at,
        data,
    }
}

pub(crate) fn stored(e: crate::workspace::models::WorkspaceError) -> HostError {
    HostError::new(
        ErrorCode::PluginError,
        format!("Connect couldn't keep it: {}", e.message),
    )
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::plugins::host::{Grants, PluginHost};
    use crate::workspace::test_core;
    use std::sync::Arc;

    fn env() -> (Env, Arc<crate::workspace::Core>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), vec![]);
        crate::workspace::plugin_data::tests::seed(&core);
        (
            Env::with(Some(core.clone()), super::super::http::Client::new()),
            core,
            dir,
        )
    }

    #[tokio::test]
    async fn deliver_mail_creates_held_message_to_self_never_confirmed() {
        let (env, core, _dir) = env();
        env.plugin(
            "routines",
            json!({"deliver": {"to": ["today", "mail", "teams"]}}),
            json!([]),
        );
        let msg = json!({"title": "Weekly", "markdown": "**Done** <script>x</script>",
                         "about": "Routine · Weekly", "ai": "sonnet",
                         "mail_to": ["someone@else.example"]});
        let sent = env
            .call_async("routines", "deliver.send", json!(["mail", msg]))
            .await
            .unwrap();
        assert_eq!(sent, json!(true));
        let items = core.plugin_records("plugin_item").unwrap();
        let held: Vec<_> = items
            .iter()
            .filter(|r| r.data["type"] == "held_message")
            .collect();
        let cards: Vec<_> = items
            .iter()
            .filter(|r| r.data["type"] == "delivery")
            .collect();
        assert_eq!((held.len(), cards.len()), (1, 1), "{items:?}");
        let h = &held[0].data;
        assert_eq!(h["channel"], "mail");
        assert_eq!(h["state"], "held");
        assert_eq!(h["sent"], false);
        assert_eq!(
            h["to"],
            json!({"self": true, "address": "taylor@example.test"})
        );
        assert!(!h.to_string().contains("someone@else.example"));
        assert!(h["markdown"].as_str().unwrap().contains("\\<script\\>"));
        assert_eq!(cards[0].data["held"], json!(held[0].id));
        // Nothing went out: no action, no job, no send of any kind.
        {
            let r = core.repo().unwrap();
            assert!(r.records_of_kind("action").unwrap().is_empty());
            assert!(r.jobs().unwrap().is_empty());
        }
        // The same `about` to Today replaces its card; both are in the snapshot for Today.
        for _ in 0..2 {
            env.call_async(
                "routines",
                "deliver.send",
                json!(["today", {"title": "Weekly", "markdown": "x", "about": "Routine · Weekly"}]),
            )
            .await
            .unwrap();
        }
        let snapshot = core.repo().unwrap().snapshot().unwrap();
        let today: Vec<_> = snapshot
            .records
            .iter()
            .filter(|r| r.kind == "plugin_item" && r.data["to"] == "today")
            .collect();
        assert_eq!(today.len(), 1);
        // Only the ways its sheet named.
        let e = env
            .call_async(
                "routines",
                "deliver.send",
                json!(["telegram", {"title": "x"}]),
            )
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
    }

    #[tokio::test]
    async fn deliver_telegram_routes_to_provider_plugin() {
        let (env, _core, dir) = env();
        let host = Arc::new(PluginHost::new(env.services.clone()));
        env.services.set_host(&host);
        env.plugin(
            "routines",
            json!({"deliver": {"to": ["telegram"]}}),
            json!([]),
        );
        env.plugin(
            "telegram",
            json!({"deliver_provider": {"kinds": ["telegram"]}}),
            json!([]),
        );
        let main = dir.path().join("telegram.js");
        std::fs::write(
            &main,
            r#"
            export function apply(ctx) {
              let sent = []
              ctx.deliver.provide('telegram', { label: 'Telegram', send: (m) => { sent.push(m); return true } })
              ctx.command('pair', () => ctx.deliver.ready('telegram', true, ''))
              ctx.command('sent', () => sent)
            }
            "#,
        )
        .unwrap();
        host.load("telegram", &main, Grants::default())
            .await
            .unwrap();
        // Added, but not ready yet.
        let status = env.call("routines", "deliver.status", json!([])).unwrap();
        assert_eq!(status["provided"][0]["kind"], "telegram");
        assert_eq!(status["provided"][0]["ready"], false);
        let e = env
            .call_async(
                "routines",
                "deliver.send",
                json!(["telegram", {"title": "Hi"}]),
            )
            .await
            .unwrap_err();
        assert!(e.message.contains("can't send yet"), "{e}");
        host.call("telegram", "pair", Value::Null).await.unwrap();
        let sent = env
            .call_async(
                "routines",
                "deliver.send",
                json!(["telegram", {"title": "Hi", "markdown": "**x**", "mail_to": ["a@b.c"]}]),
            )
            .await
            .unwrap();
        assert_eq!(sent, json!(true));
        let got = host.call("telegram", "sent", Value::Null).await.unwrap();
        assert_eq!(got.as_array().unwrap().len(), 1);
        assert_eq!(got[0]["title"], "Hi");
        assert_eq!(got[0]["markdown"], "**x**");
        assert!(got[0].get("mail_to").is_none());
        // A plugin can't add a way its sheet didn't name, nor a built-in one.
        let e = env
            .call(
                "routines",
                "deliver.provide",
                json!(["telegram", {"label": "x"}]),
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        env.plugin(
            "sneaky",
            json!({"deliver_provider": {"kinds": ["mail"]}}),
            json!([]),
        );
        assert!(env
            .call("sneaky", "deliver.provide", json!(["mail", {}]))
            .is_err());
        // Its provider goes with it.
        env.services.forget("telegram");
        let e = env
            .call_async(
                "routines",
                "deliver.send",
                json!(["telegram", {"title": "Hi"}]),
            )
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
    }
}
