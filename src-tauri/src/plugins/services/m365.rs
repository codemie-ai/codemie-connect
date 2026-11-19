//! `ctx.m365.search(q, {kinds, days, limit})`, `mailThread(message)` and `chat(chat, {since,
//! until})` (Echo 0.10, `uses.m365.read: [mail, chats]`): the user's Outlook mail and Teams chats
//! as the active workspace shows them, read-only (`workspace::plugin_m365`). A kind the sheet
//! didn't name is refused; signed out, each says "Microsoft 365 isn't connected: …".
use super::{at, permission, text, Granted, Services};
use crate::plugins::host::{ErrorCode, HostError};
use crate::workspace::models::WorkspaceError;
use serde_json::Value;

fn asked(p: &Granted, kind: &str) -> Result<(), HostError> {
    if p.words("m365", "read").iter().any(|k| k == kind) {
        return Ok(());
    }
    Err(permission(format!(
        "{} didn't ask to read your Microsoft 365 {kind} when it was installed (uses.m365.read)",
        p.id
    )))
}

fn failed(e: WorkspaceError) -> HostError {
    let code = match e.code.as_str() {
        "not_found" => ErrorCode::NotFound,
        _ => ErrorCode::PluginError,
    };
    HostError::new(code, e.message)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub async fn call(s: &Services, p: &Granted, name: &str, args: &Value) -> Result<Value, HostError> {
    let core = s.core()?.clone();
    match name {
        "m365.search" => {
            let o = at(args, 1);
            let kinds: Vec<String> = match o["kinds"].as_array() {
                Some(k) => k
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
                None => p.words("m365", "read"),
            };
            for k in &kinds {
                asked(p, k)?;
            }
            let q = at(args, 0).as_str().unwrap_or("").to_string();
            let days = o["days"].as_i64().unwrap_or(90);
            let limit = o["limit"].as_u64().map_or(25, |l| l as usize);
            core.plugin_m365_search(&q, &kinds, days, limit, now())
                .map_err(failed)
        }
        "m365.mailThread" => {
            asked(p, "mail")?;
            let message = text(args, 0, "a mail's id")?.to_string();
            core.plugin_mail_thread(&message).await.map_err(failed)
        }
        "m365.chat" => {
            asked(p, "chats")?;
            let chat = text(args, 0, "a chat's id")?.to_string();
            let o = at(args, 1);
            core.plugin_chat(&chat, o["since"].as_str(), o["until"].as_str(), now())
                .map_err(failed)
        }
        _ => Err(super::unsupported(name)),
    }
}
