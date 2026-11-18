//! The `meeting_notes` job: saves the transcript first while it is still in Teams, runs Claude
//! with the meeting's template (or a skill's `SKILL.md`, read for every run), and writes the
//! document, `meta.json`, `run.log` and the tasks it found. A run that fails never touches the
//! documents; `run.log` says why. Also decides which meetings get notes by themselves.
use super::docs;
use super::folder;
use super::folder_files::{meta_json, read_segments};
use super::glossary::{self, Text};
use super::model::*;
use super::notes::{self, NotesOutput, NotesRequest, RunInfo, TaskContext};
use super::record::*;
use super::rules::{self, Rule};
use super::save::save_transcript;
use super::templates::{self, Template};
use crate::ai::command::RunSpec;
use crate::ai::stream::AiError;
use crate::workspace::{
    ai::wire_name, ai_jobs::stored_job, graph, models::*, new_job, prompts, repository::Repository,
    tasks, Core,
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A notes run may take ten minutes (a two-hour workshop).
pub(super) const NOTES_TIMEOUT: Duration = Duration::from_secs(600);
/// Round jobs belong to the workspace Connect boots into.
const PERSONAL: &str = "personal";
/// Automatic notes are made for meetings that ended at most two days ago.
const AUTO_WINDOW: i64 = 2 * 24 * 3600;
/// "Skip very short meetings": under three minutes long, or under three minutes of talking.
const SHORT: f64 = 180.0;
/// `run.log` keeps its newest 256 KB.
const RUN_LOG_MAX: usize = 256 * 1024;

pub(super) const GETTING: &str = "Getting the transcript from Teams";
const FINDING: &str = "Finding tasks";

/// The steps a run shows (`payload.steps`), in order.
pub(super) fn steps_for(
    saving: bool,
    template: &str,
    find_tasks: bool,
    folder: Option<&str>,
) -> Vec<String> {
    let mut steps = Vec::new();
    if saving {
        steps.push(GETTING.to_string());
    }
    steps.push(format!("Writing notes with {template}"));
    if find_tasks {
        steps.push(FINDING.to_string());
    }
    steps.push(match folder {
        Some(name) => format!("Saving to {name}"),
        None => "Saving to the meeting folder".to_string(),
    });
    steps
}

/// A folder's own name.
pub(super) fn folder_name(m: &MeetingRecord) -> Option<String> {
    m.folder.as_deref().and_then(|f| {
        Path::new(f)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
    })
}

fn template_gone() -> WorkspaceError {
    WorkspaceError::new(
        "not_found",
        "This note template no longer exists. Choose another one.",
    )
}

fn skill_missing(t: &Template) -> WorkspaceError {
    WorkspaceError::new(
        "skill_missing",
        format!(
            "The skill “{}” is not at {} any more. Choose its SKILL.md again in Settings › Meetings › Note templates.",
            t.name,
            t.skill_path.as_deref().unwrap_or("its old place")
        ),
    )
}

/// A skill's `SKILL.md`, read now: `skill_missing` when it is gone, `too_large` over 50 000
/// characters.
fn read_skill(t: &Template) -> Result<String> {
    let path = t
        .skill_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| skill_missing(t))?;
    let len = std::fs::metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .ok_or_else(|| skill_missing(t))?
        .len();
    let too_large = || {
        WorkspaceError::new(
            "too_large",
            format!(
                "The skill “{}” is longer than 50 000 characters. Shorten its SKILL.md.",
                t.name
            ),
        )
    };
    if len > 4 * notes::SKILL_MAX as u64 {
        return Err(too_large());
    }
    let bytes = std::fs::read(path).map_err(|_| skill_missing(t))?;
    let text = String::from_utf8_lossy(&bytes).trim().to_string();
    if text.chars().count() > notes::SKILL_MAX {
        return Err(too_large());
    }
    if text.is_empty() {
        return Err(skill_missing(t));
    }
    Ok(text)
}

/// `n thing` or `n things`.
fn plural(n: usize, thing: &str) -> String {
    if n == 1 {
        format!("1 {thing}")
    } else {
        format!("{n} {thing}s")
    }
}

/// Appends one entry to the folder's `run.log` (its newest 256 KB are kept). Best effort.
fn append_run_log(dir: &Path, lines: &[String]) {
    let path = dir.join("run.log");
    let mut log = std::fs::read_to_string(&path).unwrap_or_default();
    if !log.is_empty() && !log.ends_with("\n\n") {
        log.push_str(if log.ends_with('\n') { "\n" } else { "\n\n" });
    }
    log.push_str(&lines.join("\n"));
    log.push('\n');
    if log.len() > RUN_LOG_MAX {
        let mut cut = log.len() - RUN_LOG_MAX;
        while !log.is_char_boundary(cut) {
            cut += 1;
        }
        log = log[cut..].to_string();
    }
    if folder::write_file(&path, log.as_bytes()).is_err() {
        log::warn!("meetings: cannot write run.log");
    }
}

fn stamp(zone: &str) -> String {
    local_time(&rfc3339(now()), zone)
        .format("%Y-%m-%d %H:%M")
        .to_string()
}

/// Why a notes run failed, and whether its document was already written (then the record
/// and `run.log` must not say the documents are unchanged).
struct Failure {
    error: Box<WorkspaceError>,
    /// The document file that already holds the new notes.
    written: Option<String>,
}

impl Failure {
    fn written(error: WorkspaceError, file: &str) -> Self {
        Self {
            error: Box::new(error),
            written: Some(file.to_string()),
        }
    }
}

impl From<WorkspaceError> for Failure {
    fn from(error: WorkspaceError) -> Self {
        Self {
            error: Box::new(error),
            written: None,
        }
    }
}

impl From<AiError> for Failure {
    fn from(error: AiError) -> Self {
        WorkspaceError::from(error).into()
    }
}

/// "2 new tasks to review" (or "on the board" when they skip review), as `run.log` and the
/// Notes ready notification say it.
fn new_tasks(n: usize, review: bool) -> String {
    format!(
        "{} {}",
        plural(n, "new task"),
        if review { "to review" } else { "on the board" }
    )
}

#[cfg(test)]
thread_local! {
    /// Test failpoint: the next notes run on this thread loses its database right after it
    /// writes the document.
    pub(super) static FAIL_AFTER_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// What Claude's run gave a notes job, ready to save.
struct Finished {
    out: NotesOutput,
    segments: Vec<super::vtt::Segment>,
    cut: bool,
    profile: String,
    model: Option<String>,
    /// `run.log` lines so far.
    log: Vec<String>,
}

/// What a run read from its job and the meeting before Claude runs.
struct Plan {
    template: Template,
    find_tasks: bool,
    wishes: String,
    auto: bool,
    workspace: String,
}

impl Core {
    /// `meeting_notes`: notes for a meeting with one template (see the module docs).
    pub(in crate::workspace) async fn run_meeting_notes(&self, job: &Job) -> Result<String> {
        let id = required(&job.payload, "meetingId", 2000)?.to_string();
        let c = self.notes_connection(job)?;
        let plan = match self.notes_plan(job) {
            Ok(plan) => plan,
            Err(e) => {
                // The template was deleted after the run was queued.
                let named = job.payload["templateId"].as_str().unwrap_or("A template");
                self.note_notes_failure(&c, &id, named, &e, None);
                return Err(e);
            }
        };
        let (state, folder) = {
            let r = self.repo()?;
            r.check_claim(&job.id, job.attempts)?;
            let (m, _, _) = self.current(&r, &c, &id)?;
            (m.state, folder_name(&m))
        };
        let saving = state == MeetingState::Available;
        let mut steps = steps_for(
            saving,
            &plan.template.name,
            plan.find_tasks,
            folder.as_deref(),
        );
        if saving {
            // Make notes on a transcript still in Teams saves it first; a failed save fails
            // the run with the save's reason, which the meeting keeps (`save_error`). When that
            // reason passes, the request is kept too: the next save that works makes these
            // notes ([`Core::queue_pending_notes`]).
            self.note_step(job, &steps, GETTING)?;
            let saved = match save_transcript(self, &self.job_connection(job)?, &id).await {
                Ok(saved) => saved,
                Err(e) => {
                    if !plan.auto && super::round::RETRYABLE.contains(&e.code.as_str()) {
                        self.keep_notes_request(&c, &id, job, &plan);
                    }
                    return Err(e);
                }
            };
            // An earlier request for another template follows this save too.
            self.queue_pending_notes(&c, &id);
            steps = steps_for(
                true,
                &plan.template.name,
                plan.find_tasks,
                folder_name(&saved).as_deref(),
            );
        }
        match self.write_notes(job, &c, &id, &plan, &steps).await {
            Ok(done) => Ok(done),
            Err(f) => {
                let name = &plan.template.name;
                self.note_notes_failure(&c, &id, name, &f.error, f.written.as_deref());
                Err(*f.error)
            }
        }
    }

    /// The job's account, fenced by its claim. Notes need no transcript permission: an imported
    /// transcript has notes too.
    fn notes_connection(&self, job: &Job) -> Result<Connection> {
        let cid = job
            .connection_id
            .as_deref()
            .ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?;
        let mut c = self.repo()?.connection(cid)?;
        c.job_fence = Some((job.id.clone(), job.attempts));
        Ok(c)
    }

    fn notes_plan(&self, job: &Job) -> Result<Plan> {
        let workspace = job.workspace_id.clone().unwrap_or_else(|| PERSONAL.into());
        let all = templates::all(&self.repo()?.local_records(&workspace, templates::KIND)?);
        let template = templates::find(&all, job.payload["templateId"].as_str().unwrap_or(""))
            .cloned()
            .ok_or_else(template_gone)?;
        Ok(Plan {
            find_tasks: job.payload["findTasks"] != false && template.extract_tasks,
            template,
            wishes: job.payload["wishes"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string(),
            auto: job.payload["auto"] == true,
            workspace,
        })
    }

    /// Notes `step` (one of `steps`) on the running job, for the progress line.
    fn note_step(&self, job: &Job, steps: &[String], step: &str) -> Result<()> {
        {
            let mut r = self.repo()?;
            r.check_claim(&job.id, job.attempts)?;
            let mut current = stored_job(&r, job)?;
            current.payload["steps"] = json!(steps);
            current.payload["step"] = step.into();
            r.save_job(&current)?;
        }
        self.emit("workspace:changed");
        Ok(())
    }

    async fn write_notes(
        &self,
        job: &Job,
        c: &Connection,
        id: &str,
        plan: &Plan,
        steps: &[String],
    ) -> std::result::Result<String, Failure> {
        let t = &plan.template;
        let (m, event, settings) = {
            let r = self.repo()?;
            r.check_claim(&job.id, job.attempts)?;
            let (m, event, _) = self.current(&r, c, id)?;
            (m, event, r.settings()?)
        };
        if !saved(m.state) {
            return Err(no_transcript().into());
        }
        let dir = m
            .folder
            .as_deref()
            .map(PathBuf::from)
            .filter(|d| d.is_dir())
            .ok_or_else(folder_missing)?;
        let segments = read_segments(&dir)?;
        if segments.is_empty() {
            return Err(no_transcript().into());
        }
        let skill = if t.kind == "skill" {
            Some(read_skill(t)?)
        } else {
            None
        };
        self.note_step(job, steps, &format!("Writing notes with {}", t.name))?;
        let (profile, model) = self.route(Purpose::Meeting).await?;
        let run = self.start_run(job, &profile, &model)?;
        let s = &settings.meetings;
        let me = self.me_alias(c, s);
        let people = with_me(people_of(event.as_ref()), c);
        let organizer = event
            .as_ref()
            .and_then(|e| e.data["organizer"]["address"].as_str())
            .map(String::from);
        // A text Connect can't read is left out of this run (and named in run.log).
        let mut unread = Vec::new();
        let texts = self.meetings_root(s).ok().map(|(root, _)| {
            let mut read = |which| {
                let path = glossary::text_path(&root, s, which).0;
                glossary::read_text(path.as_deref()).unwrap_or_else(|_| {
                    unread.extend(path.as_deref().map(glossary::file_label));
                    (String::new(), false)
                })
            };
            (read(Text::Glossary), read(Text::Tags))
        });
        let ((glossary_md, glossary_cut), (tags_md, tags_cut)) =
            texts.unwrap_or(((String::new(), false), (String::new(), false)));
        let (input, cut) = notes::notes_input(&NotesRequest {
            meeting: &m,
            segments: &segments,
            people: &people,
            organizer: organizer.as_deref(),
            me: &me,
            zone: &settings.time_zone,
            template_text: if skill.is_some() { "" } else { &t.prompt },
            glossary_md: &glossary_md,
            tags_md: &tags_md,
            wishes: &plan.wishes,
            settings: s,
            find_tasks: plan.find_tasks,
        });
        let spec = RunSpec {
            purpose: wire_name(Purpose::Meeting),
            profile_id: profile.id.clone(),
            model,
            system: skill
                .as_deref()
                .map_or_else(|| notes::NOTES_SYSTEM.to_string(), notes::skill_system),
            input,
            schema: Some(prompts::schema(notes::NOTES_SCHEMA)),
            timeout: NOTES_TIMEOUT,
            cap_usd: None,
            staging_root: self.paths.ensure_staging()?,
        };
        let requested = spec.model.clone();
        let lines = segments.len();
        let (reported, answer) = self
            .run_claude_reported(&run, spec, &profile, id, |v| notes::parse_notes(v, lines))
            .await;
        let out = answer?;
        if plan.find_tasks {
            self.note_step(job, steps, FINDING)?;
        }
        self.note_step(job, steps, steps.last().map_or("", String::as_str))?;
        let mut log = vec![
            format!(
                "{} · {}{}",
                stamp(&settings.time_zone),
                t.name,
                if plan.auto { " · automatic" } else { "" }
            ),
            format!(
                "Claude: {} · {} · {:.0} s{}",
                profile.id,
                reported
                    .as_ref()
                    .and_then(|o| o.model.clone())
                    .or(requested.clone())
                    .unwrap_or_else(|| "default model".into()),
                reported
                    .as_ref()
                    .map_or(0.0, |o| o.duration_ms as f64 / 1000.0),
                reported
                    .as_ref()
                    .and_then(|o| o.cost_usd)
                    .map(|c| format!(" · ${c:.2}"))
                    .unwrap_or_default()
            ),
            format!(
                "Transcript: {}{}",
                plural(lines, "line"),
                if cut {
                    format!(", {} (the notes say so)", notes::CUT_NOTE.to_lowercase())
                } else {
                    String::new()
                }
            ),
        ];
        if glossary_cut || tags_cut {
            log.push(
                "The glossary or the tag list is longer than 100 KB: Claude read its first 100 KB."
                    .into(),
            );
        }
        for file in &unread {
            log.push(format!(
                "Connect couldn’t read {file}, so Claude worked without it."
            ));
        }
        if !plan.wishes.is_empty() {
            log.push(format!("Wishes: {}", plan.wishes));
        }
        let model = reported
            .as_ref()
            .and_then(|o| o.model.clone())
            .or(requested)
            .or_else(|| profile.default_model.clone());
        self.save_notes(
            job,
            c,
            id,
            plan,
            Finished {
                out,
                segments,
                cut,
                profile: profile.id.clone(),
                model,
                log,
            },
        )
    }

    /// Writes a run's document, `meta.json` and tasks, stores the meeting with the job's success
    /// and adds the run to `run.log`, all under the meeting lock (taken here, before the
    /// repository). Everything that can fail is read before the document is written; once it
    /// is, a failure says so ([`Failure::written`]) instead of claiming nothing changed.
    fn save_notes(
        &self,
        job: &Job,
        c: &Connection,
        id: &str,
        plan: &Plan,
        done: Finished,
    ) -> std::result::Result<String, Failure> {
        let t = &plan.template;
        let Finished {
            out,
            segments,
            cut,
            profile,
            model,
            mut log,
        } = done;
        let _w = self.meeting_lock();
        let mut r = self.repo()?;
        r.validate_claim(c)?;
        let (mut m, event, source) = self.current(&r, c, id)?;
        let settings = r.settings()?;
        let dir = m
            .folder
            .as_deref()
            .map(PathBuf::from)
            .filter(|d| d.is_dir())
            .ok_or_else(folder_missing)?;
        let stored = stored_job(&r, job)?;
        // The tasks the meeting has, and the lines whose task the person deleted.
        let existing: Vec<Value> = if plan.find_tasks {
            r.local_records(&plan.workspace, tasks::KIND)?
                .into_iter()
                .filter(|task| task.data["meetingId"] == id)
                .map(|task| task.data)
                .collect()
        } else {
            Vec::new()
        };
        let on_board: HashSet<u64> = existing.iter().filter_map(|t| t["line"].as_u64()).collect();
        let removed: HashSet<u64> = m
            .removed_lines
            .iter()
            .copied()
            .filter(|l| !on_board.contains(l))
            .collect();
        let found = if plan.find_tasks {
            let me = self.me_alias(c, &settings.meetings);
            let people = with_me(people_of(event.as_ref()), c);
            let mut known = existing.clone();
            known.extend(removed.iter().map(|l| json!({"meetingId": id, "line": l})));
            notes::tasks_from(
                &out,
                &TaskContext {
                    meeting_id: id,
                    template_name: &t.name,
                    segments: &segments,
                    people: &people,
                    me: &me,
                    settings: &settings.meetings,
                },
                &known,
            )
        } else {
            Vec::new()
        };
        let history_taken = docs::history_taken(&dir, &m);
        let change = notes::apply(
            &mut m,
            t,
            &out,
            &RunInfo {
                now: now(),
                zone: &settings.time_zone,
                auto: plan.auto,
                cut,
                keep_versions: settings.meetings.keep_versions,
                profile: Some(profile),
                model,
                wishes: Some(plan.wishes.clone()).filter(|w| !w.is_empty()),
                history_taken,
            },
        );
        // Nothing has changed yet: a failure here leaves the documents as they were.
        let kept = docs::write_change(&dir, &m, &change, &settings.time_zone)?;
        #[cfg(test)]
        if FAIL_AFTER_WRITE.with(|f| f.replace(false)) {
            r.fail_writes();
        }
        let written = |e: WorkspaceError| Failure::written(e, &change.file);
        if folder::write_file(&dir.join("meta.json"), meta_json(&m).as_bytes()).is_err() {
            log::warn!("meetings: cannot rewrite meta.json");
        }
        if let Some(kept) = &kept {
            log.push(format!(
                "{} was already in the folder: kept as {kept}",
                change.file
            ));
        }
        log.extend(change.log.iter().cloned());
        let mut added = 0;
        for body in &found {
            match tasks::task_save(&mut r, &plan.workspace, body, now()) {
                Ok(_) => added += 1,
                Err(e) => {
                    log::warn!("meetings: a task from the notes was not saved: {}", e.code);
                    log.push(format!("A task could not be saved: {}", e.message));
                }
            }
        }
        r.commit_job_record(&stored, &record_of(c, &source, &m).map_err(written)?)
            .map_err(written)?;
        if plan.find_tasks {
            let asked: HashSet<u64> = out.tasks.iter().map(|t| t.line as u64).collect();
            let kept = asked.intersection(&on_board).count();
            let left_out = asked.intersection(&removed).count();
            let mut said = Vec::new();
            if added > 0 {
                said.push(new_tasks(added, settings.meetings.review));
            }
            if kept > 0 {
                said.push(format!("{} already on the board", plural(kept, "task")));
            }
            if left_out > 0 {
                said.push(format!(
                    "{} you deleted before, not added again",
                    plural(left_out, "task")
                ));
            }
            if said.is_empty() {
                said.push("none found".into());
            }
            log.push(format!("Tasks: {}", said.join(", ")));
        }
        append_run_log(&dir, &log);
        if plan.auto {
            // The notes are saved: a notification that can't be queued is only logged.
            let body = if added > 0 {
                format!(
                    "Made with {}. {}.",
                    t.name,
                    new_tasks(added, settings.meetings.review)
                )
            } else {
                format!("Made with {}.", t.name)
            };
            let queued = r
                .policy(job.workspace_id.as_deref(), job.connection_id.as_deref())
                .and_then(|policy| {
                    r.enqueue(&new_job(
                        "notification",
                        format!("meeting_notes_ready:{}", job.id),
                        job.workspace_id.clone(),
                        job.connection_id.clone(),
                        now(),
                        policy,
                        json!({"title": format!("Notes ready: {}", m.title), "body": body,
                            "meetingId": id, "route": "meetings", "expiresAt": now() + 2 * 3600}),
                    ))
                });
            if let Err(e) = queued {
                log::warn!(
                    "meetings: the Notes ready notification was not queued: {}",
                    e.code
                );
            }
        }
        drop(r);
        self.emit("workspace:changed");
        Ok("Notes ready".into())
    }

    /// A failed run: the meeting keeps why (`notes_error`) and is `failed` while it has no
    /// documents (one with documents stays `ready`); `run.log` says what happened, and that
    /// the documents are unchanged only when they are (`written` names a document file that
    /// already got the new notes). A run that was stopped changes nothing on the meeting.
    fn note_notes_failure(
        &self,
        c: &Connection,
        id: &str,
        template: &str,
        e: &WorkspaceError,
        written: Option<&str>,
    ) {
        let _w = self.meeting_lock();
        let Ok(mut r) = self.repo() else {
            return;
        };
        let Ok((mut m, _, source)) = self.current(&r, c, id) else {
            return;
        };
        let zone = r.settings().map(|s| s.time_zone).unwrap_or_default();
        let mut lines = vec![format!("{} · {template} · failed", stamp(&zone))];
        if e.code == "cancelled" && written.is_none() {
            lines.push("Stopped before the notes were written.".into());
        } else {
            lines.push(format!("{} ({})", e.message, e.code));
            if saved(m.state) {
                m.notes_error = Some(ErrorInfo::from(e));
                if m.docs.is_empty() {
                    m.state = MeetingState::Failed;
                }
                if let Err(stored) = store(&mut r, c, &source, &m) {
                    log::warn!("meetings: cannot note a failed notes run: {}", stored.code);
                }
            }
        }
        lines.push(match written {
            Some(file) => format!(
                "{file} has the new notes, but Connect couldn’t record them. Make notes again to see them in Connect."
            ),
            None if m.docs.is_empty() => "No notes were written.".into(),
            None => "Your documents were not changed.".into(),
        });
        drop(r);
        if let Some(dir) = m.folder.as_deref().map(Path::new).filter(|d| d.is_dir()) {
            append_run_log(dir, &lines);
        }
        self.emit("workspace:changed");
    }

    /// A person's Make notes whose save failed for a reason that passes: the meeting keeps what
    /// they asked for (`pending_notes`) while its transcript is still in Teams. Best effort.
    fn keep_notes_request(&self, c: &Connection, id: &str, job: &Job, plan: &Plan) {
        let _w = self.meeting_lock();
        let kept = self.repo().and_then(|mut r| {
            let (mut m, _, source) = self.current(&r, c, id)?;
            if m.state != MeetingState::Available {
                return Ok(());
            }
            m.pending_notes = Some(PendingNotes {
                template_id: plan.template.id.clone(),
                wishes: plan.wishes.clone(),
                find_tasks: job.payload["findTasks"] != false,
                workspace_id: plan.workspace.clone(),
                job_id: job.id.clone(),
            });
            store(&mut r, c, &source, &m)
        });
        if let Err(e) = kept {
            log::warn!("meetings: a notes request was not kept: {}", e.code);
        }
    }

    /// Right after a save that worked: the notes the person asked for while it failed
    /// (`pending_notes`) are queued, keyed by the job that asked so they are queued once, unless
    /// notes with that template are waiting or running already; the request is then cleared.
    /// True when the meeting had such a request. Best effort; takes the meeting lock.
    pub(super) fn queue_pending_notes(&self, c: &Connection, id: &str) -> bool {
        let _w = self.meeting_lock();
        let queued = self.repo().and_then(|mut r| {
            let (mut m, _, source) = self.current(&r, c, id)?;
            let Some(p) = m.pending_notes.take() else {
                return Ok(false);
            };
            let all = templates::all(&r.local_records(&p.workspace_id, templates::KIND)?);
            match templates::find(&all, &p.template_id).filter(|_| saved(m.state)) {
                Some(t) => {
                    let key = format!("{id}:{}", t.id);
                    let busy = r.jobs()?.iter().any(|j| {
                        j.kind == "meeting_notes"
                            && j.payload["notesKey"] == key.as_str()
                            && matches!(j.state.as_str(), "queued" | "running")
                    });
                    if !busy {
                        let policy = r.policy(Some(&p.workspace_id), Some(&c.id))?;
                        let extract = p.find_tasks && t.extract_tasks;
                        let steps = steps_for(false, &t.name, extract, folder_name(&m).as_deref());
                        r.enqueue(&new_job(
                            "meeting_notes",
                            format!("meeting_notes:after-save:{}", p.job_id),
                            Some(p.workspace_id.clone()),
                            Some(c.id.clone()),
                            now(),
                            policy,
                            json!({"meetingId": id, "title": m.title, "templateId": t.id,
                                "notesKey": key, "wishes": p.wishes, "findTasks": p.find_tasks,
                                "auto": false, "step": null, "steps": steps}),
                        ))?;
                    }
                }
                None => log::warn!("meetings: notes asked for are dropped: their template is gone"),
            }
            store(&mut r, c, &source, &m)?;
            Ok(true)
        });
        match queued {
            Ok(had) => had,
            Err(e) => {
                log::warn!("meetings: notes asked for were not queued: {}", e.code);
                false
            }
        }
    }

    /// Right after a save: notes for a meeting that asked for them as soon as its transcript
    /// arrived (or whose wait is over). Best effort; the round tries again.
    pub(super) fn auto_notes_after_save(&self, c: &Connection, id: &str) {
        let _w = self.meeting_lock();
        let queued = self.repo().and_then(|mut r| {
            let (m, event, _) = self.current(&r, c, id)?;
            let auto = AutoNotes::read(&r, c, &r.jobs()?)?;
            auto.queue(&mut r, &m, event.as_ref(), now())
        });
        if let Err(e) = queued {
            log::warn!("meetings: automatic notes not queued: {}", e.code);
        }
    }
}

/// What the round needs to decide on automatic notes, read once.
pub(super) struct AutoNotes {
    settings: MeetingSettings,
    rules: Vec<Rule>,
    templates: Vec<Template>,
    /// The meetings that had a notes job that didn't fail (a failed one made no notes, so it
    /// doesn't stand in for the automatic ones).
    noted: std::collections::HashSet<String>,
    connection: String,
    policy: Value,
}

impl AutoNotes {
    /// Reads the rules, templates and settings; `jobs` are the jobs there are now.
    pub(super) fn read(r: &Repository, c: &Connection, jobs: &[Job]) -> Result<Self> {
        let mut rules: Vec<Rule> = r
            .local_records(PERSONAL, rules::KIND)?
            .iter()
            .filter_map(rules::from_record)
            .collect();
        rules.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        Ok(Self {
            settings: r.settings()?.meetings,
            rules,
            templates: templates::all(&r.local_records(PERSONAL, templates::KIND)?),
            noted: jobs
                .iter()
                .filter(|j| {
                    j.kind == "meeting_notes" && !matches!(j.state.as_str(), "failed" | "blocked")
                })
                .filter_map(|j| j.payload["meetingId"].as_str().map(String::from))
                .collect(),
            connection: c.id.clone(),
            policy: r.policy(Some(PERSONAL), Some(&c.id))?,
        })
    }

    /// Whether `m` gets notes by themselves now (see [`auto_due`]); queues them with the fixed
    /// key `meeting_notes:auto:<meetingId>`, so a meeting gets one automatic attempt.
    pub(super) fn queue(
        &self,
        r: &mut Repository,
        m: &MeetingRecord,
        event: Option<&Record>,
        now: i64,
    ) -> Result<bool> {
        if self.noted.contains(&m.event_id) {
            return Ok(false);
        }
        let data = event
            .map(|e| e.data.clone())
            .unwrap_or_else(|| json!({"title": m.title}));
        let talk = || {
            m.folder
                .as_deref()
                .and_then(|d| read_segments(Path::new(d)).ok())
                .map(|segments| segments.iter().map(|s| (s.end - s.start).max(0.0)).sum())
        };
        if !auto_due(m, &data, &self.rules, &self.settings, now, talk) {
            return Ok(false);
        }
        let (t, why) = templates::resolve(m, &data, &self.rules, &self.settings, &self.templates);
        let steps = steps_for(false, &t.name, t.extract_tasks, folder_name(m).as_deref());
        r.enqueue(&new_job(
            "meeting_notes",
            format!("meeting_notes:auto:{}", m.event_id),
            Some(PERSONAL.into()),
            Some(self.connection.clone()),
            now,
            self.policy.clone(),
            json!({"meetingId": m.event_id, "title": m.title, "templateId": t.id,
                "notesKey": format!("{}:{}", m.event_id, t.id), "wishes": "",
                "findTasks": t.extract_tasks, "auto": true, "reason": why.to_json(),
                "step": null, "steps": steps}),
        ))?;
        Ok(true)
    }
}

/// Whether a meeting's notes are made by themselves now: its transcript is saved and it has no
/// documents yet; it asks for them (its own switch, else the first matching rule or Settings ›
/// Meetings › Make notes automatically). What the person asked for on the meeting follows the
/// save at once, however late it comes; a rule or the setting only for a meeting that ended
/// at most two days ago, `waitMin` after it, skipping very short ones (under 3 minutes, or
/// under 3 minutes of talking).
pub(super) fn auto_due(
    m: &MeetingRecord,
    event: &Value,
    rules: &[Rule],
    s: &MeetingSettings,
    now: i64,
    talk: impl FnOnce() -> Option<f64>,
) -> bool {
    let start = graph::timestamp(&m.start);
    let end = graph::timestamp(&m.end);
    if m.state != MeetingState::Downloaded || end <= 0 {
        return false;
    }
    let (wanted, asked) = rules::auto_notes(m.auto, event, rules, s);
    if !wanted {
        return false;
    }
    if asked {
        return true;
    }
    if now - end >= AUTO_WINDOW || now < end + s.wait_min * 60 {
        return false;
    }
    let length = (end - start) as f64;
    !(s.skip_short && (length < SHORT || talk().is_some_and(|t| t < SHORT)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const END: i64 = 1_795_000_000;

    fn downloaded(minutes: i64, auto: Option<bool>) -> MeetingRecord {
        MeetingRecord {
            title: "Philips sync".into(),
            start: rfc3339(END - minutes * 60),
            end: rfc3339(END),
            state: MeetingState::Downloaded,
            auto,
            ..Default::default()
        }
    }

    #[test]
    fn auto_notes_wait_skip_short_meetings_and_stop_after_two_days() {
        let event = json!({"title": "Philips sync"});
        let rule = Rule {
            id: "r".into(),
            value: "philips".into(),
            template: "meeting-notes".into(),
            auto_notes: true,
            ..Default::default()
        };
        let rules = vec![rule];
        let s = MeetingSettings::default();
        let long = || Some(600.0);
        let m = downloaded(30, None);
        // A rule waits 15 minutes after the meeting.
        assert!(!auto_due(&m, &event, &rules, &s, END + 14 * 60, long));
        assert!(auto_due(&m, &event, &rules, &s, END + 15 * 60, long));
        // Too short, or almost no talking.
        assert!(!auto_due(
            &downloaded(2, None),
            &event,
            &rules,
            &s,
            END + 3600,
            long
        ));
        assert!(!auto_due(&m, &event, &rules, &s, END + 3600, || Some(90.0)));
        let keep = MeetingSettings {
            skip_short: false,
            ..Default::default()
        };
        assert!(auto_due(
            &downloaded(2, None),
            &event,
            &rules,
            &keep,
            END + 3600,
            || Some(10.0)
        ));
        // An unreadable transcript is not taken for a short one.
        assert!(auto_due(&m, &event, &rules, &s, END + 3600, || None));
        // Not after two days, not with notes or a failed run, not without a rule.
        assert!(!auto_due(&m, &event, &rules, &s, END + AUTO_WINDOW, long));
        for state in [
            MeetingState::Ready,
            MeetingState::Failed,
            MeetingState::Available,
        ] {
            let other = MeetingRecord { state, ..m.clone() };
            assert!(!auto_due(&other, &event, &rules, &s, END + 3600, long));
        }
        assert!(!auto_due(&m, &event, &[], &s, END + 3600, long));
        // Asked for on the meeting: at once, whatever its length; and "no" wins over a rule.
        assert!(auto_due(
            &downloaded(2, Some(true)),
            &event,
            &[],
            &s,
            END + 60,
            || Some(5.0)
        ));
        assert!(!auto_due(
            &downloaded(30, Some(false)),
            &event,
            &rules,
            &s,
            END + 3600,
            long
        ));
        // Asked for on the meeting holds after two days too (a save that worked only later); a
        // rule or the setting doesn't.
        assert!(auto_due(
            &downloaded(30, Some(true)),
            &event,
            &[],
            &s,
            END + AUTO_WINDOW + 3600,
            long
        ));
        assert!(!auto_due(
            &m,
            &event,
            &rules,
            &s,
            END + AUTO_WINDOW + 3600,
            long
        ));
    }

    #[test]
    fn steps_name_each_phase() {
        assert_eq!(
            steps_for(true, "Short summary", false, None),
            vec![
                GETTING,
                "Writing notes with Short summary",
                "Saving to the meeting folder"
            ]
        );
        assert_eq!(
            steps_for(false, "Meeting notes", true, Some("2026-11-04_160426-sync")),
            vec![
                "Writing notes with Meeting notes",
                FINDING,
                "Saving to 2026-11-04_160426-sync"
            ]
        );
    }
}
