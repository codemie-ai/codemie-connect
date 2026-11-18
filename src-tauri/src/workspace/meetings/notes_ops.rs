//! The notes operations a person starts: Make notes (`meeting_notes`), the meeting's own
//! template and automatic notes (`meeting_set`), and the documents (`meeting_doc`).
use super::docs;
use super::folder;
use super::folder_files::meta_json;
use super::model::*;
use super::notes::WISHES_MAX;
use super::notes_job::{folder_name, steps_for};
use super::record::*;
use super::rules::{self, Rule};
use super::templates::{self, Template};
use crate::ai::stream::{AiError, ErrorClass};
use crate::workspace::{ai::chosen_profile, graph, models::*, new_job, Core};
use serde_json::{json, Value};
use std::path::PathBuf;

/// `true`/`false` from an optional field (missing is `default`).
fn flag(data: &Value, key: &str, default: bool, message: &str) -> Result<bool> {
    match data.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v.as_bool().ok_or_else(|| invalid(message)),
    }
}

impl Core {
    /// `meeting_notes`, `meeting_set`, `meeting_doc`. Like every writer of meeting records,
    /// they take the meeting lock before the repository.
    pub(in crate::workspace) fn notes_op(&self, req: &Request) -> Result<Value> {
        let _w = self.meeting_lock();
        match req.op {
            Operation::MeetingNotes => self.queue_notes(req),
            Operation::MeetingSet => self.meeting_set(req),
            Operation::MeetingDoc => self.meeting_doc(req),
            _ => Err(invalid("Unsupported operation.")),
        }
    }

    /// `meeting_notes {meetingId, templateId, wishes?, findTasks?, remember?}`: queues notes
    /// with one template; while a run of the same template for the meeting is waiting or
    /// running, that job is returned. A meeting whose transcript is still in Teams has it saved
    /// first. `remember` makes the meeting's title a rule (first in the list) for the template.
    fn queue_notes(&self, req: &Request) -> Result<Value> {
        let t = self.target(req)?;
        let template_id = required(&req.data, "templateId", 200)?;
        let wishes = match &req.data["wishes"] {
            Value::Null => String::new(),
            v => v
                .as_str()
                .map(str::trim)
                .filter(|w| w.chars().count() <= WISHES_MAX && !w.contains('\0'))
                .ok_or_else(|| invalid("Keep what to focus on to 1,000 characters."))?
                .to_string(),
        };
        let find_tasks = flag(
            &req.data,
            "findTasks",
            true,
            "Choose whether to find tasks.",
        )?;
        let remember = flag(
            &req.data,
            "remember",
            false,
            "Choose whether to remember it.",
        )?;
        // One of Make notes for all: claimed after the person's own Claude requests.
        let batch = flag(
            &req.data,
            "batch",
            false,
            "Choose whether it is one of many.",
        )?;
        let event = t.event.as_ref();
        let m = match t.meeting.clone() {
            Some(m) => m,
            None => from_event(event.ok_or_else(not_found)?),
        };
        let in_teams = m.state == MeetingState::Available
            && m.external.as_deref().is_some_and(|e| !e.is_empty())
            && !m.transcript_ids.is_empty();
        if !saved(m.state) && !in_teams {
            return Err(no_transcript());
        }
        if saved(m.state)
            && !m
                .folder
                .as_deref()
                .map(PathBuf::from)
                .is_some_and(|d| d.is_dir())
        {
            return Err(folder_missing());
        }
        if in_teams && !saved(m.state) && !graph::transcripts_permitted(&t.c) {
            return Err(transcripts_off());
        }
        let mut r = self.repo()?;
        let settings = r.settings()?;
        let all = templates::all(&r.local_records(&t.w.id, templates::KIND)?);
        let template = templates::find(&all, template_id)
            .cloned()
            .ok_or_else(|| invalid("Choose a note template."))?;
        if chosen_profile(&settings.ai, Purpose::Meeting).is_none() {
            return Err(AiError::new(ErrorClass::NeedsChoice).into());
        }
        let key = format!("{}:{}", t.id, template.id);
        if let Some(running) = r.jobs()?.into_iter().find(|j| {
            j.kind == "meeting_notes"
                && j.workspace_id.as_deref() == Some(&t.w.id)
                && j.payload["notesKey"] == key.as_str()
                && matches!(j.state.as_str(), "queued" | "running")
        }) {
            return Ok(json!({"queued": true, "jobId": running.id}));
        }
        if remember {
            let first = r
                .local_records(&t.w.id, rules::KIND)?
                .iter()
                .filter_map(rules::from_record)
                .map(|rule| rule.order)
                .min()
                .unwrap_or(1);
            let rule = Rule {
                id: format!("{}-rule", req.operation_id.clone().unwrap_or_else(id)),
                field: "title".into(),
                value: m.title.trim().chars().take(rules::VALUE_MAX).collect(),
                template: template.id.clone(),
                auto_notes: false,
                on: true,
                order: first - 1,
            };
            r.put_record(&local_rule(&t.w.id, &rule)?)?;
            if t.meeting.is_some() {
                let (mut current, _, source) = self.current(&r, &t.c, &t.id)?;
                current.template = None;
                store(&mut r, &t.c, &source, &current)?;
            }
        }
        let policy = r.policy(Some(&t.w.id), Some(&t.c.id))?;
        let extract = find_tasks && template.extract_tasks;
        let steps = steps_for(
            !saved(m.state),
            &template.name,
            extract,
            folder_name(&m).as_deref(),
        );
        let job = new_job(
            "meeting_notes",
            format!(
                "meeting_notes:{}",
                req.operation_id.as_deref().unwrap_or("")
            ),
            Some(t.w.id.clone()),
            Some(t.c.id.clone()),
            now(),
            policy,
            json!({"meetingId": t.id, "title": m.title, "templateId": template.id,
                "notesKey": key, "wishes": wishes, "findTasks": find_tasks, "auto": false,
                "batch": batch, "step": null, "steps": steps}),
        );
        r.enqueue(&job)?;
        Ok(json!({"queued": true, "jobId": job.id}))
    }

    /// `meeting_set {meetingId, template?: string|null, auto?: bool|null}`: the template chosen
    /// for this meeting and whether its notes are made as soon as the transcript is saved; a
    /// field left out stays, null takes the choice back.
    fn meeting_set(&self, req: &Request) -> Result<Value> {
        let t = self.target(req)?;
        let mut r = self.repo()?;
        let (mut m, _, source) = self.current(&r, &t.c, &t.id)?;
        if let Some(v) = req.data.get("template") {
            m.template = match v {
                Value::Null => None,
                v => {
                    let all = templates::all(&r.local_records(&t.w.id, templates::KIND)?);
                    let chosen = v
                        .as_str()
                        .and_then(|id| templates::find(&all, id))
                        .ok_or_else(|| invalid("Choose a note template."))?;
                    Some(chosen.id.clone())
                }
            };
        }
        if let Some(v) = req.data.get("auto") {
            m.auto = match v {
                Value::Null => None,
                v => Some(
                    v.as_bool()
                        .ok_or_else(|| invalid("Turn automatic notes on or off."))?,
                ),
            };
        }
        store(&mut r, &t.c, &source, &m)?;
        Ok(json!({"saved": true}))
    }

    /// `meeting_doc {meetingId, docId, action, version?, text?, baseVersion?, baseRev?}`: `main`
    /// makes a document `notes.md`, `delete` moves it to `notes-history/`, `version` uses an
    /// earlier version again, `edit` saves the person's text. Delete, version and edit send the
    /// document's `version` and `rev` as the person saw them (`baseVersion`, `baseRev`); when its
    /// text changed since (a run, an earlier version used again, another edit) they are refused
    /// with `conflict`. Making a document the main one only renames files, so it needs no fence.
    fn meeting_doc(&self, req: &Request) -> Result<Value> {
        let action = req.data["action"].as_str().unwrap_or("");
        if !matches!(action, "main" | "delete" | "version" | "edit") {
            return Err(invalid("Choose what to do with the document."));
        }
        let t = self.target(req)?;
        let doc_id = required(&req.data, "docId", 200)?;
        let (mut m, source, zone) = {
            let r = self.repo()?;
            let (m, _, source) = self.current(&r, &t.c, &t.id)?;
            (m, source, r.settings()?.time_zone)
        };
        if !m.docs.iter().any(|d| d.id == doc_id) {
            return Err(WorkspaceError::new(
                "not_found",
                "This document is no longer there.",
            ));
        }
        let dir = m
            .folder
            .as_deref()
            .map(PathBuf::from)
            .filter(|d| d.is_dir())
            .ok_or_else(folder_missing)?;
        let version = |key: &str| req.data[key].as_u64().and_then(|v| u32::try_from(v).ok());
        // What the person saw: delete, an earlier version and an edit are refused when the
        // document changed since.
        let base = docs::Base {
            version: version("baseVersion"),
            rev: version("baseRev"),
        };
        match action {
            "main" => docs::set_main(&dir, &mut m, doc_id, &zone)?,
            "delete" => docs::delete(&dir, &mut m, doc_id, base, &zone)?,
            "version" => {
                let v = version("version").ok_or_else(|| invalid("Choose a version."))?;
                docs::use_version(&dir, &mut m, doc_id, v, base, &zone)?
            }
            _ => {
                let text = req.data["text"]
                    .as_str()
                    .ok_or_else(|| invalid("Write the notes."))?;
                docs::edit(&dir, &mut m, doc_id, text, base, now())?
            }
        }
        if folder::write_file(&dir.join("meta.json"), meta_json(&m).as_bytes()).is_err() {
            log::warn!("meetings: cannot rewrite meta.json");
        }
        store(&mut *self.repo()?, &t.c, &source, &m)?;
        Ok(if action == "delete" {
            json!({"deleted": true})
        } else {
            json!({"saved": true})
        })
    }
}

/// The local record of a rule in workspace `wid`.
pub(super) fn local_rule(wid: &str, rule: &Rule) -> Result<Record> {
    Ok(Record {
        id: rule.id.clone(),
        kind: rules::KIND.into(),
        connection_id: None,
        workspace_id: Some(wid.into()),
        source: "local".into(),
        revision: id(),
        updated_at: now(),
        data: serde_json::to_value(rule).map_err(storage)?,
    })
}

/// The local record of a template in workspace `wid`.
pub(super) fn local_template(wid: &str, t: &Template) -> Record {
    Record {
        id: t.id.clone(),
        kind: templates::KIND.into(),
        connection_id: None,
        workspace_id: Some(wid.into()),
        source: "local".into(),
        revision: id(),
        updated_at: now(),
        data: t.body(),
    }
}
