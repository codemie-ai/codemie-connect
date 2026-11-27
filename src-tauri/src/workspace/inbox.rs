//! Deterministic Inbox projection; human decisions are separate from provider revisions.
use super::{
    models::*,
    repository::{record_selected, Repository},
};
use serde_json::Value;
use std::collections::HashMap;
pub fn project(
    repo: &Repository,
    w: &Workspace,
    c: Option<&Connection>,
    records: &mut [Record],
) -> Result<()> {
    let Some(c) = c else { return Ok(()) };
    let messages = repo.provider_records(&c.id, "message")?;
    project_with(repo, w, c, records, &messages)
}

/// [`project`] reading the conversations from `messages`: every message of each conversation
/// `records` holds messages of (a delta passes just those conversations' messages).
pub fn project_with(
    repo: &Repository,
    w: &Workspace,
    c: &Connection,
    records: &mut [Record],
    messages: &[Record],
) -> Result<()> {
    let decisions: HashMap<_, _> = records
        .iter()
        .filter(|r| r.kind == "decision")
        .map(|r| {
            let mut data = r.data.clone();
            data["decisionAt"] = r.updated_at.into();
            (r.id.clone(), data)
        })
        .collect();
    let mut latest_mine: HashMap<String, i64> = HashMap::new();
    let mut latest_inbound: HashMap<String, (i64, String)> = HashMap::new();
    let mut waiting: HashMap<String, i64> = HashMap::new();
    for m in messages
        .iter()
        .filter(|m| record_selected(m, w) && super::repository::source_permitted(m, c))
    {
        let key = m.data["conversationId"].as_str().unwrap_or("").to_string();
        let at = m.data["at"].as_i64().unwrap_or(0);
        if let Some(decision) = decisions.get(&m.id).filter(|d| d["lane"] == "waiting") {
            let since = decision["waitingSince"]
                .as_i64()
                .or(decision["decisionAt"].as_i64())
                .unwrap_or(at);
            waiting
                .entry(key.clone())
                .and_modify(|v| *v = (*v).max(since))
                .or_insert(since);
        }
        if m.data["isMine"] != true {
            let value = latest_inbound
                .entry(key.clone())
                .or_insert((at, m.id.clone()));
            if at > value.0 {
                *value = (at, m.id.clone());
            }
        }

        if m.data["isMine"] == true {
            let key = m.data["conversationId"].as_str().unwrap_or("").to_string();
            let at = m.data["at"].as_i64().unwrap_or(0);
            latest_mine
                .entry(key)
                .and_modify(|v| *v = (*v).max(at))
                .or_insert(at);
        }
    }
    let chat_catalog = records
        .iter()
        .find(|r| r.kind == "catalog" && r.id == "chats")
        .map(|r| r.data.clone())
        .unwrap_or(Value::Null);
    let rules = repo.local_records(&w.id, "rule")?;
    for r in records.iter_mut().filter(|r| r.kind == "message") {
        if !record_selected(r, w) {
            continue;
        }
        let decision = decisions.get(&r.id);
        let sender = r.data["fromAddress"].as_str().unwrap_or("").to_lowercase();
        let automated = ["noreply", "no-reply", "donotreply", "notifications@"]
            .iter()
            .any(|s| sender.contains(s));
        let text = r.data["text"].as_str().unwrap_or("");
        let combined = format!("{} {text}", r.data["title"].as_str().unwrap_or("")).to_lowercase();
        let matched_rule = rules.iter().find(|rule| {
            rule.data["enabled"] != false
                && rule.data["lane"] == "critical"
                && rule.data["keyword"]
                    .as_str()
                    .is_some_and(|k| !k.is_empty() && combined.contains(&k.to_lowercase()))
                && rule.data["sender"]
                    .as_str()
                    .is_none_or(|s| s.is_empty() || s.eq_ignore_ascii_case(&sender))
        });
        let replied = latest_mine
            .get(r.data["conversationId"].as_str().unwrap_or(""))
            .is_some_and(|at| *at > r.data["at"].as_i64().unwrap_or(0));
        let chat_id = r.source.strip_prefix("chat:").unwrap_or("");
        let one_to_one = chat_catalog["values"].as_array().is_some_and(|a| {
            a.iter()
                .any(|chat| chat["id"].as_str() == Some(chat_id) && chat["chatType"] == "oneOnOne")
        });
        let direct = r.data["mentionsMe"] == true
            || one_to_one
            || r.data["to"].as_array().is_some_and(|a| {
                a.iter().any(|v| {
                    v["emailAddress"]["address"]
                        .as_str()
                        .is_some_and(|a| a.eq_ignore_ascii_case(&c.email))
                })
            });
        let actionable = combined.split_whitespace().any(|word| word.ends_with('?'))
            || [
                "can you ",
                "could you ",
                "would you ",
                "please review",
                "please confirm",
                "please approve",
                "please send",
                "please provide",
                "please check",
                "let me know",
                "your feedback",
                "your approval",
                "action required",
                "можеш ",
                "підтверд",
                "переглянь",
            ]
            .iter()
            .any(|phrase| combined.contains(phrase));
        let (lane, reason) = if automated {
            ("low", "Automated sender exclusion")
        } else if decision.is_some_and(|d| d["lane"] == "waiting")
            && latest_inbound
                .get(r.data["conversationId"].as_str().unwrap_or(""))
                .is_some_and(|(at, _)| {
                    *at > decision
                        .and_then(|d| d["waitingSince"].as_i64().or(d["decisionAt"].as_i64()))
                        .unwrap_or(i64::MAX)
                })
        {
            (
                "waiting",
                "A new response is available; review it before resolving Waiting",
            )
        } else if let Some(lane) = decision.and_then(|d| d["lane"].as_str()) {
            (lane, "Your manual lane override")
        } else if matched_rule.is_some() {
            ("critical", "Your critical keyword and sender rule")
        } else if r.data["isMine"] != true
            && !replied
            && waiting
                .get(r.data["conversationId"].as_str().unwrap_or(""))
                .is_some_and(|since| r.data["at"].as_i64().unwrap_or(0) > *since)
        {
            (
                "reply",
                "A new response in a conversation you marked Waiting",
            )
        } else if r.data["isMine"] == true {
            (
                "fyi",
                "Sent by you; move to Waiting when you choose to follow up",
            )
        } else if direct && actionable && !replied {
            (
                "reply",
                "Direct source with a request or question; no later reply found",
            )
        } else {
            (
                "fyi",
                if replied {
                    "A later reply from you was found"
                } else {
                    "Selected source; no direct request rule matched"
                },
            )
        };
        let rule_id = if decision.and_then(|d| d["lane"].as_str()) == Some("critical") {
            "manual"
        } else {
            matched_rule.map(|r| r.id.as_str()).unwrap_or("manual")
        };
        let incident = super::graph::canonical_id(
            &format!("incident:{}:{rule_id}", c.id),
            "incident",
            r.data["conversationId"].as_str().unwrap_or(&r.id),
        );
        r.data["incidentId"] = incident.clone().into();
        r.data["criticalRule"] = rule_id.into();
        r.data["lane"] = lane.into();
        r.data["reason"] = reason.into();
        r.data["responseSourceId"] = if lane == "waiting" && reason.starts_with("A new response") {
            latest_inbound
                .get(r.data["conversationId"].as_str().unwrap_or(""))
                .map(|(_, id)| Value::String(id.clone()))
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        r.data["lifecycle"] = decision
            .map(|d| d["lifecycle"].clone())
            .unwrap_or("open".into());
        r.data["snoozedUntil"] = decision
            .map(|d| d["snoozedUntil"].clone())
            .unwrap_or(Value::Null);
        r.data["acknowledgedAt"] = records_incident(repo, &c.id, &incident)?;
        if lane == "critical" {
            if let Ok(incident) = repo.record("incident", &incident, Some(&c.id), None) {
                if incident.data["snoozedUntil"]
                    .as_i64()
                    .is_some_and(|t| t > now())
                {
                    r.data["snoozedUntil"] = incident.data["snoozedUntil"].clone();
                }
            }
        }
    }
    Ok(())
}
fn records_incident(repo: &Repository, cid: &str, id: &str) -> Result<Value> {
    Ok(repo
        .record("incident", id, Some(cid), None)
        .ok()
        .map(|r| r.data["acknowledgedAt"].clone())
        .unwrap_or(Value::Null))
}
