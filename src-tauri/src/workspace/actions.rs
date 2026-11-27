//! Outward actions require a short-lived, content-bound native review record.
use super::{graph, models::*, repository, schedules, Core};
use serde_json::{json, Value};
use std::sync::Arc;
fn segment(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
fn address(s: &str) -> Result<&str> {
    if s.len() > 254
        || s.contains(['\r', '\n', '<', '>', ' '])
        || !s
            .split_once('@')
            .is_some_and(|(a, b)| !a.is_empty() && b.contains('.') && !b.ends_with('.'))
    {
        return Err(WorkspaceError::new(
            "validation",
            "Enter complete recipient email addresses.",
        ));
    }
    Ok(s)
}

/// Who an Outlook reply goes to: the message's `replyTo`, else its sender, exactly as
/// Microsoft returns them for the source message. Never taken from a draft or from Claude.
pub(super) fn reply_recipients(message: &Value) -> Vec<Value> {
    message["replyTo"]
        .as_array()
        .filter(|a| !a.is_empty())
        .cloned()
        .unwrap_or_else(|| vec![message["from"].clone()])
}

/// The addresses in `recipients` that the thread never showed: lower-cased, they differ
/// from the message's sender, lower-cased. Flags a Reply-To that redirects the reply.
pub(super) fn new_recipients(message: &Value, recipients: &[Value]) -> Vec<String> {
    let sender = message["from"]["emailAddress"]["address"]
        .as_str()
        .unwrap_or("")
        .to_lowercase();
    recipients
        .iter()
        .filter_map(|r| r["emailAddress"]["address"].as_str())
        .filter(|a| a.to_lowercase() != sender)
        .map(str::to_string)
        .collect()
}

/// The mail review `prepare_action` returns for `mail_reply`.
pub(super) fn mail_review(message: &Value, text: &str, source_id: &str) -> Value {
    let recipients = reply_recipients(message);
    let new_recipients = new_recipients(message, &recipients);
    json!({
        "title": message["subject"],
        "recipients": recipients,
        "newRecipients": new_recipients,
        "body": text,
        "sourceId": source_id,
        "providerRevision": message["changeKey"],
    })
}

/// The chat review `prepare_action` returns for `chat_reply`.
pub(super) fn chat_review(details: &Value, text: &str, source_id: &str, chat: &str) -> Value {
    json!({
        "title": details["topic"],
        "recipients": details["members"],
        "body": text,
        "sourceId": source_id,
        "chatId": chat,
    })
}

impl Core {
    pub(super) async fn prepare_action(&self, req: &Request) -> Result<Value> {
        let (w, c) = self.active_workspace(req, true)?;
        let c = c.ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft first."))?;
        let policy = self.repo()?.policy(Some(&w.id), Some(&c.id))?;
        let kind = required(&req.data, "kind", 30)?;
        let action_id = req.operation_id.clone().unwrap_or_else(id);
        let mut source_id = None;
        let mut source_revision = None;
        let (cap, url, body, review) = match kind {
            "event" => {
                let cal = required(&req.data, "calendarId", 2000)?;
                if !self.repo()?.calendar_selected(&w, &c.id, cal) {
                    return Err(WorkspaceError::new(
                        "permission_required",
                        "Select this calendar in workspace sources first.",
                    ));
                }
                let calendar = self
                    .graph_get(
                        &c,
                        &graph::endpoint(&format!(
                            "/me/calendars/{}?$select=id,name,canEdit",
                            segment(cal)
                        )),
                    )
                    .await?;
                if calendar["canEdit"] != true {
                    return Err(WorkspaceError::new(
                        "permission_required",
                        "This calendar is read only. Open Outlook to make changes.",
                    ));
                }
                let title = required(&req.data, "title", 250)?;
                let zone = required(&req.data, "timeZone", 100)?;
                let start = schedules::event_time(
                    required(&req.data, "start", 30)?,
                    zone,
                    req.data["startOffset"].as_i64(),
                )?;
                let end = schedules::event_time(
                    required(&req.data, "end", 30)?,
                    zone,
                    req.data["endOffset"].as_i64(),
                )?;
                if graph::timestamp(&end) <= graph::timestamp(&start) {
                    return Err(WorkspaceError::new(
                        "validation",
                        "Event end must be after its start.",
                    ));
                }
                let mut attendees = Vec::new();
                if let Some(values) = req.data["attendees"].as_array() {
                    if values.len() > 50 {
                        return Err(WorkspaceError::new(
                            "validation",
                            "Use at most 50 attendees.",
                        ));
                    }
                    for v in values {
                        let email = address(v.as_str().unwrap_or(""))?;
                        attendees.push(json!({"emailAddress":{"address":email},"type":"required"}));
                    }
                }
                let text = req.data["body"].as_str().unwrap_or("");
                if text.len() > 20000 {
                    return Err(WorkspaceError::new(
                        "validation",
                        "Event description is too long.",
                    ));
                }
                let body = json!({"subject":title,"start":{"dateTime":start.trim_end_matches("+00:00"),"timeZone":"UTC"},"end":{"dateTime":end.trim_end_matches("+00:00"),"timeZone":"UTC"},"body":{"contentType":"text","content":text},"attendees":attendees,"transactionId":action_id});
                (
                    "calendar_write",
                    graph::endpoint(&format!("/me/calendars/{}/events", segment(cal))),
                    body,
                    json!({"title":title,"start":start,"end":end,"timeZone":zone,"calendar":calendar["name"],"attendees":attendees,"body":text,"invitesAttendees":!attendees.is_empty()}),
                )
            }
            "mail_reply" | "chat_reply" => {
                let rid = required(&req.data, "sourceId", 2000)?;
                let source = self.repo()?.record("message", rid, Some(&c.id), None)?;
                if !repository::source_available(&source)
                    || !repository::source_permitted(&source, &c)
                    || !repository::record_selected(&source, &w)
                {
                    return Err(WorkspaceError::new(
                        "permission_required",
                        "This conversation is not selected for this workspace.",
                    ));
                }
                let text = required(&req.data, "body", 20000)?;
                let provider_id = required(&source.data, "providerId", 2000)?;
                source_id = Some(rid.to_string());
                source_revision = Some(source.revision.clone());
                if kind == "mail_reply" {
                    if source.data["channel"] != "mail" || source.data["isMine"] == true {
                        return Err(WorkspaceError::new(
                            "validation",
                            "Choose an inbound Outlook message.",
                        ));
                    }
                    let message = self
                        .graph_get(
                            &c,
                            &graph::endpoint(&format!(
                                "/me/messages/{}?$select=id,subject,from,replyTo,changeKey",
                                segment(provider_id)
                            )),
                        )
                        .await?;
                    let recipients = reply_recipients(&message);
                    for to in &recipients {
                        address(to["emailAddress"]["address"].as_str().unwrap_or(""))?;
                    }
                    (
                        "mail_send",
                        graph::endpoint(&format!("/me/messages/{}/reply", segment(provider_id))),
                        json!({"comment":text}),
                        mail_review(&message, text, rid),
                    )
                } else {
                    if source.data["channel"] != "chat" {
                        return Err(WorkspaceError::new(
                            "validation",
                            "Choose an existing Teams chat.",
                        ));
                    }
                    let chat = source
                        .source
                        .strip_prefix("chat:")
                        .ok_or_else(|| WorkspaceError::new("validation", "Missing Teams chat."))?;
                    let details = self
                        .graph_get(
                            &c,
                            &graph::endpoint(&format!("/chats/{}?$expand=members", segment(chat))),
                        )
                        .await?;
                    (
                        "chat_send",
                        graph::endpoint(&format!("/chats/{}/messages", segment(chat))),
                        json!({"body":{"contentType":"text","content":text}}),
                        chat_review(&details, text, rid, chat),
                    )
                }
            }
            _ => {
                return Err(WorkspaceError::new(
                    "validation",
                    "Unsupported outward action.",
                ))
            }
        };
        if !graph::permitted(&c, cap) {
            return Err(WorkspaceError::new(
                "permission_required",
                format!(
                    "Authorize {} in Microsoft settings, then review again.",
                    graph::scope_for(cap).unwrap_or(cap)
                ),
            ));
        }
        let mut r = self.repo()?;
        r.check_policy(Some(&w.id), Some(&c.id), &policy)?;
        let nonce = id();
        let action = Record {
            id: action_id.clone(),
            kind: "action".into(),
            connection_id: Some(c.id.clone()),
            workspace_id: Some(w.id.clone()),
            source: "action".into(),
            revision: id(),
            updated_at: now(),
            data: json!({"kind":kind,"state":"prepared","capability":cap,"url":url,"body":body,"review":review,"account":c.email,"nonce":nonce,"expiresAt":now()+300,"policy":policy,"sourceId":source_id,"sourceRevision":source_revision}),
        };
        r.put_record(&action)?;
        Ok(
            json!({"actionId":action_id,"workspaceId":w.id,"nonce":nonce,"review":review,"account":c.email,"expiresAt":now()+300}),
        )
    }
    pub(super) async fn confirm_action(self: &Arc<Self>, req: &Request) -> Result<Value> {
        let (w, c) = self.active_workspace(req, true)?;
        let c = c.ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?;
        let action_id = required(&req.data, "actionId", 100)?;
        let nonce = required(&req.data, "nonce", 100)?;
        let mut action = self
            .repo()?
            .record("action", action_id, Some(&c.id), Some(&w.id))?;
        if action.data["state"] != "prepared" {
            return Err(WorkspaceError::new(
                "conflict",
                "This review has already been used. Check Activity for the outcome.",
            ));
        }
        if action.data["nonce"].as_str() != Some(nonce)
            || action.data["expiresAt"].as_i64().unwrap_or(0) < now()
        {
            return Err(WorkspaceError::new(
                "review_expired",
                "Review expired. Prepare the action again.",
            ));
        }
        let cap = required(&action.data, "capability", 30)?;
        if !graph::permitted(&c, cap) {
            return Err(WorkspaceError::new(
                "permission_required",
                "The required Microsoft permission is no longer enabled.",
            ));
        }
        let policy = action.data["policy"].clone();
        if let Some(rid) = action.data["sourceId"].as_str() {
            let source = self.repo()?.record("message", rid, Some(&c.id), None)?;
            if source.revision != action.data["sourceRevision"].as_str().unwrap_or("")
                || !repository::source_permitted(&source, &c)
                || !repository::record_selected(&source, &w)
            {
                return Err(WorkspaceError::new(
                    "conflict",
                    "The source changed. Review the latest message before sending.",
                ));
            }
        }
        // Re-read review metadata from Microsoft; a cached message version is not enough to validate recipients.
        if let Some(rid) = action.data["sourceId"].as_str() {
            let source = self.repo()?.record("message", rid, Some(&c.id), None)?;
            if !repository::source_available(&source) {
                return Err(WorkspaceError::new("cancelled","This item moved or is unavailable in selected sources. Review it in the provider."));
            }
            if action.data["kind"] == "mail_reply" {
                let provider = required(&source.data, "providerId", 2000)?;
                let fresh = self
                    .graph_get(
                        &c,
                        &graph::endpoint(&format!(
                            "/me/messages/{}?$select=id,subject,from,replyTo,changeKey",
                            segment(provider)
                        )),
                    )
                    .await?;
                let recipients = reply_recipients(&fresh);
                if fresh["changeKey"] != action.data["review"]["providerRevision"]
                    || json!(recipients) != action.data["review"]["recipients"]
                {
                    return Err(WorkspaceError::new(
                        "conflict",
                        "The Outlook message or reply destination changed. Review a new reply.",
                    ));
                }
            } else {
                let chat = required(&action.data["review"], "chatId", 2000)?;
                let fresh = self
                    .graph_get(
                        &c,
                        &graph::endpoint(&format!("/chats/{}?$expand=members", segment(chat))),
                    )
                    .await?;
                if fresh["members"] != action.data["review"]["recipients"] {
                    return Err(WorkspaceError::new(
                        "conflict",
                        "The Teams participants changed. Review a new reply.",
                    ));
                }
            }
        }
        // Serialize authorization and marking the durable action as consumed. A second click cannot dispatch it.
        {
            let mut r = self.repo()?;
            r.check_policy(Some(&w.id), Some(&c.id), &policy)?;
            let current = r.record("action", action_id, Some(&c.id), Some(&w.id))?;
            if current.data["state"] != "prepared" {
                return Err(WorkspaceError::new(
                    "conflict",
                    "Action is already being processed.",
                ));
            }
            action.data["state"] = "dispatching".into();
            action.data["nonce"] = Value::Null;
            action.data["dispatchedAt"] = now().into();
            r.put_record(&action)?;
        }
        self.emit("workspace:changed");
        let result = self
            .graph_post(
                &c,
                required(&action.data, "url", 8192)?,
                &action.data["body"],
                action_id,
                &w.id,
                &policy,
            )
            .await;
        let mut r = self.repo()?;
        // Even a successful late response cannot restore data to a revoked/disconnected account.
        r.check_policy(Some(&w.id), Some(&c.id), &policy)?;
        match result {
            Ok(response) => {
                action.data["state"] = if action.data["kind"] == "mail_reply" {
                    "accepted"
                } else {
                    "succeeded"
                }
                .into();
                action.data["providerId"] = response["id"].clone();
                action.data["message"]="Microsoft accepted the action. Mail acceptance does not confirm recipient delivery.".into();
            }
            Err(e) => {
                action.data["state"] = if matches!(
                    e.code.as_str(),
                    "permission_required" | "needs_login" | "throttled"
                ) {
                    "rejected"
                } else {
                    "unknown_outcome"
                }
                .into();
                action.data["message"] = if action.data["state"] == "unknown_outcome" {
                    "The request may have reached Microsoft. Check Outlook or Teams before preparing another action; this action will not retry automatically.".into()
                } else {
                    e.message.into()
                };
            }
        }
        action.updated_at = now();
        r.put_record(&action)?;
        Ok(json!({"state":action.data["state"],"message":action.data["message"]}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_recipients_are_reply_to_addresses_that_are_not_the_sender() {
        let from_priya =
            json!({"emailAddress": {"name": "Priya Nair", "address": "priya.n@example.test"}});

        let no_reply_to = json!({"from": from_priya});
        let recipients = reply_recipients(&no_reply_to);
        assert_eq!(
            new_recipients(&no_reply_to, &recipients),
            Vec::<String>::new()
        );

        let redirected = json!({
            "from": from_priya,
            "replyTo": [{"emailAddress": {"name": "Assistant", "address": "a@other.test"}}],
        });
        let recipients = reply_recipients(&redirected);
        assert_eq!(
            new_recipients(&redirected, &recipients),
            vec!["a@other.test".to_string()]
        );

        let same_case_insensitive = json!({
            "from": from_priya,
            "replyTo": [{"emailAddress": {"address": "PRIYA.N@example.test"}}],
        });
        let recipients = reply_recipients(&same_case_insensitive);
        assert_eq!(
            new_recipients(&same_case_insensitive, &recipients),
            Vec::<String>::new()
        );
    }

    #[test]
    fn mail_review_lists_recipients_from_microsoft_never_from_the_text() {
        let message = json!({
            "subject": "Project update",
            "from": {"emailAddress": {"name": "Priya Nair", "address": "priya.n@example.test"}},
            "replyTo": [{"emailAddress": {"name": "Assistant", "address": "a@other.test"}}],
            "changeKey": "ck-1",
        });
        let review = mail_review(&message, "send to evil@x.test", "msg-1");
        assert_eq!(review["title"], json!("Project update"));
        assert_eq!(
            review["recipients"],
            json!([{"emailAddress": {"name": "Assistant", "address": "a@other.test"}}])
        );
        assert_eq!(review["newRecipients"], json!(["a@other.test"]));
        assert_eq!(review["body"], json!("send to evil@x.test"));
        assert_eq!(review["sourceId"], json!("msg-1"));
        assert_eq!(review["providerRevision"], json!("ck-1"));
    }

    #[test]
    fn contract_fixtures_match_the_real_prepare_answers() {
        fn answer(review: Value) -> Value {
            json!({
                "actionId": "action-1",
                "workspaceId": "personal",
                "nonce": "nonce-1",
                "review": review,
                "account": "taylor@example.test",
                "expiresAt": 0,
            })
        }

        let normal_message = json!({
            "subject": "Project update",
            "from": {"emailAddress": {"name": "Priya Nair", "address": "priya.n@example.test"}},
            "changeKey": "ck-1",
        });
        let normal = answer(mail_review(&normal_message, "Sounds good.", "msg-1"));

        let redirected_message = json!({
            "subject": "Project update",
            "from": {"emailAddress": {"name": "Priya Nair", "address": "priya.n@example.test"}},
            "replyTo": [{"emailAddress": {"name": "Priya's Assistant", "address": "assistant@example.test"}}],
            "changeKey": "ck-2",
        });
        let redirected = answer(mail_review(&redirected_message, "Sounds good.", "msg-2"));

        crate::plugins::testkit::contract_fixture(
            "action-prepare-mail.json",
            &json!({"normal": normal, "redirected": redirected}),
        );

        let chat_details = json!({
            "topic": "Design sync",
            "members": [
                {"id": "m-1", "displayName": "Priya Nair"},
                {"id": "m-2", "displayName": "Taylor Morgan"}
            ],
        });
        let one_on_one = answer(chat_review(
            &chat_details,
            "Sounds good.",
            "msg-3",
            "chat-1",
        ));

        crate::plugins::testkit::contract_fixture(
            "action-prepare-chat.json",
            &json!({"oneOnOne": one_on_one}),
        );
    }
}
