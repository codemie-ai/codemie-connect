//! `ctx.replyContext` (reply-voice design §1, §3): `provide({status, export, context, facts, save,
//! remove})` registers the plugin as a reply-context provider, and `sent({channel, days, limit,
//! person, chatId})` reads the user's own sent messages from Connect's synced records (never
//! Microsoft). Only a plugin whose manifest `provides: ["reply-context"]` (agreed to on its sheet)
//! may use either; each function it gives becomes the provider `replyContext:<op>` in its
//! prelude, and Connect records which ops it has here (`facts` is optional). The record goes when
//! the plugin unloads (`Services::forget`). The core reaches the ops through the plugin manager's
//! `VoiceProviders`.
use super::{at, lock, permission, Granted, Services};
use crate::plugins::host::{ErrorCode, HostError};
use serde_json::Value;
use std::sync::Arc;

/// The ops a reply-context provider can give.
pub const OPS: [&str; 6] = ["status", "export", "context", "facts", "save", "remove"];

const ROLE: &str = "reply-context";

fn needs_role(p: &Granted) -> Result<(), HostError> {
    if p.provides(ROLE) {
        return Ok(());
    }
    Err(permission(format!(
        "{} doesn't provide {ROLE} (provides in its manifest)",
        p.id
    )))
}

/// `replyContext.provide`, a sync call.
pub fn call(s: &Services, p: &Granted, name: &str, args: &Value) -> Result<Value, HostError> {
    match name {
        "replyContext.provide" => {
            needs_role(p)?;
            let given: Vec<&str> = at(args, 0)
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let ops = OPS
                .iter()
                .filter(|op| given.contains(op))
                .map(|op| op.to_string())
                .collect();
            lock(&s.voice_plugins).insert(p.id.clone(), ops);
            Ok(Value::Null)
        }
        _ => Err(super::unsupported(name)),
    }
}

/// `replyContext.sent(filter)`: `{messages: [{channel, at, text, subject, to, chatType}]}`; signed
/// out, "Microsoft 365 isn't connected: …". The read runs off the async runtime: it goes through
/// every synced message of the account.
pub async fn sent(s: Arc<Services>, p: Arc<Granted>, args: Value) -> Result<Value, HostError> {
    needs_role(&p)?;
    let core = s.core()?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.plugin_sent(at(&args, 0), chrono::Utc::now().timestamp())
    })
    .await
    .map_err(|e| super::bad(e.to_string()))?
    .map_err(|e| HostError::new(ErrorCode::PluginError, e.message))
}

/// The ops plugin `id` registered, `None` when it hasn't (or isn't loaded).
pub fn ops_of(s: &Services, id: &str) -> Option<Vec<String>> {
    lock(&s.voice_plugins).get(id).cloned()
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use serde_json::json;

    #[test]
    fn provide_records_the_known_ops_and_unloading_drops_them() {
        let env = Env::new();
        env.provider("knowledge", &["reply-context"], json!([]));
        let out = env.call(
            "knowledge",
            "replyContext.provide",
            json!([["status", "export", "facts", "teleport"]]),
        );
        assert_eq!(out, Ok(Value::Null));
        assert_eq!(
            ops_of(&env.services, "knowledge"),
            Some(vec![
                "status".to_string(),
                "export".to_string(),
                "facts".to_string()
            ])
        );
        env.services.forget("knowledge");
        assert_eq!(ops_of(&env.services, "knowledge"), None);
    }

    #[tokio::test]
    async fn provide_and_sent_are_refused_without_the_role() {
        let env = Env::new();
        // A task provider isn't a reply-context provider.
        env.provider("todoist", &["tasks"], json!([]));
        let e = env
            .call("todoist", "replyContext.provide", json!([["status"]]))
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        assert_eq!(
            e.message,
            "todoist doesn't provide reply-context (provides in its manifest)"
        );
        assert_eq!(ops_of(&env.services, "todoist"), None);
        let e = env
            .call_async("todoist", "replyContext.sent", json!([{}]))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        assert_eq!(
            e.message,
            "todoist doesn't provide reply-context (provides in its manifest)"
        );
    }

    /// A reply-context plugin can't hand what it read to a sibling plugin that has the network:
    /// it can read its marketplace's shared values, never set them.
    #[test]
    fn a_reply_context_plugin_cannot_set_shared_values() {
        let env = Env::new();
        env.provider("knowledge", &["reply-context"], json!([]));
        env.plugin("sibling", json!({}), json!([]));
        let e = env
            .call(
                "knowledge",
                "shared.set",
                json!(["acme.style", "VOICE_SENTINEL_9f3a"]),
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        assert_eq!(
            e.message,
            "knowledge provides reply-context, so it can't set shared values"
        );
        assert!(!e.message.contains("VOICE_SENTINEL_9f3a"));
        assert_eq!(
            env.call("knowledge", "shared.get", json!(["acme.style"])),
            Ok(Value::Null)
        );
        // Another plugin of the marketplace still can.
        env.call("sibling", "shared.set", json!(["acme.mode", "on"]))
            .unwrap();
        assert_eq!(
            env.call("knowledge", "shared.get", json!(["acme.mode"])),
            Ok(json!("on"))
        );
    }
}
