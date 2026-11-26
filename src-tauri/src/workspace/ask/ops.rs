//! Ask's operations and its job (ask-capture design §§ 4–6, rulings 15–18 and 30).
//!
//! - `ask_start {threadId?, question, about?, hiddenCalendars?}` (under the mutation lock):
//!   refuses what it must before anything is stored, prunes, writes the turn `queued` and queues
//!   one `ask` job (key `ask:<threadId>`, one Ask app-wide at a time).
//! - The job: after its claim, never under the mutation lock, it reads the records Ask may use,
//!   asks the facts provider with the terms only (3 s, abandoned on Stop), gathers the context,
//!   runs once on the Ask route through `run_resolved` (tool-free, 120 s), checks the answer and
//!   writes the turn under the lock. The context is never stored; the ledger gets the run with no
//!   text.
//! - `ask_read {threadId}` answers the whole thread; `ask_delete {threadId} | {all: true}`
//!   cancels a running answer of what it deletes first.
//! - Stop is `job_cancel` (`stop_turn`); a turn whose job ended while Connect was closed is
//!   settled at start-up (`ask_startup`).
//!
//! Nothing here logs a question, an answer, a term or a context item: only codes and counts.
use super::answer::{self, Checked};
use super::context::{self, MeetingDigest, Records};
use super::store::{self, RefItem, Thread, Turn, TurnError, TurnState};
use crate::ai::command::RunSpec;
use crate::ai::stream::{AiError, ErrorClass};
use crate::workspace::ai::{chosen_profile, wire_name, RouteKey};
use crate::workspace::ai_jobs::stored_job;
use crate::workspace::meetings::{model::MeetingRecord, templates};
use crate::workspace::models::{
    id, now, required, Connection, Job, Purpose, Record, Request, Result, Settings, WorkspaceError,
};
use crate::workspace::repository::{record_selected, source_permitted, Repository};
use crate::workspace::voice::{
    copy, copy::Person, draft::ASK_LIMIT, facts, facts::Fact, ops::plugin_of,
};
use crate::workspace::{graph, inbox, new_job, prompts, tasks, Core};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// The job kind; its key is `ask:<threadId>`.
pub const KIND: &str = "ask";
/// A question: 1 to this many characters after trimming.
pub const QUESTION_MAX: usize = 2_000;
/// One Ask run may take this long (ruling 15).
pub const ASK_TIMEOUT: Duration = Duration::from_secs(120);
/// The facts ask carries at most this many terms (step 8 ruling 19).
const FACT_TERMS: usize = 10;
/// An About's label is kept to this many characters.
const ABOUT_LABEL_MAX: usize = 200;
/// Hidden calendars a request may name (Connect syncs at most 30).
const HIDDEN_MAX: usize = 30;
/// A meeting document larger than this is not read for its summary.
const SUMMARY_READ_MAX: u64 = 1_000_000;

const QUESTION_REFUSAL: &str = "Type a question, up to 2,000 characters.";
const BUSY: &str = "Connect is still answering. Stop it or wait.";
const GONE: &str = "That conversation is gone. Ask again.";
const LONG: &str = "This conversation is long. Start a new question.";
/// A turn whose job is gone with no sentence of its own (start-up).
const ENDED: &str = "Connect stopped before it answered.";

fn validation(message: &str) -> WorkspaceError {
    WorkspaceError::new("validation", message)
}

/// The job's thread or turn is no longer there, or no longer waits for this job: the job
/// writes nothing.
fn no_longer() -> WorkspaceError {
    WorkspaceError::new(
        "cancelled",
        "The conversation no longer waits for this answer.",
    )
}

/// `hiddenCalendars`: the calendar ids the window hides (its own preference); at most 30.
fn hidden_calendars(data: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in data["hiddenCalendars"].as_array().into_iter().flatten() {
        if let Some(id) = v.as_str().filter(|s| !s.is_empty() && s.len() <= 500) {
            if !out.iter().any(|o| o == id) && out.len() < HIDDEN_MAX {
                out.push(id.to_string());
            }
        }
    }
    out
}

/// Whether `r` sits on one of the `hidden` calendars: an event by its `calendarId`, a meeting
/// by its `calendar:<id>` source.
fn on_hidden(r: &Record, hidden: &[String]) -> bool {
    let calendar = r.data["calendarId"]
        .as_str()
        .or_else(|| r.source.strip_prefix("calendar:"));
    calendar.is_some_and(|c| hidden.iter().any(|h| h == c))
}

/// The About the request names, `gone` when its record isn't there at submit (ruling 34).
/// Anything but a message, meeting, task or event is no About (ruling 32).
fn about_of(r: &Repository, wid: &str, cid: Option<&str>, v: &Value) -> Option<RefItem> {
    let kind = v["kind"].as_str()?;
    if !matches!(kind, "message" | "meeting" | "task" | "event") {
        return None;
    }
    let record_id = v["recordId"].as_str().map(str::trim)?;
    if record_id.is_empty() || record_id.len() > 2_000 {
        return None;
    }
    let label: String = v["label"]
        .as_str()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(ABOUT_LABEL_MAX)
        .collect();
    let present = match kind {
        "task" => r.record(tasks::KIND, record_id, None, Some(wid)).is_ok(),
        _ => cid
            .and_then(|cid| r.record(kind, record_id, Some(cid), None).ok())
            .is_some_and(|rec| crate::workspace::repository::source_available(&rec)),
    };
    Some(RefItem {
        kind: kind.into(),
        record_id: record_id.into(),
        label,
        gone: !present,
    })
}

/// A new thread id: `ask-` and 12 hex characters.
fn thread_id() -> String {
    let hex: String = id()
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(12)
        .collect();
    format!("ask-{hex}")
}

fn turn_mut<'a>(t: &'a mut Thread, turn_id: &str) -> Option<&'a mut Turn> {
    t.turns.iter_mut().find(|turn| turn.id == turn_id)
}

fn waiting(turn: &Turn) -> bool {
    matches!(turn.state, TurnState::Queued | TurnState::Running)
}

/// Whether `job` was ended because Connect stopped while it ran ([`ENDED`]).
fn interrupted(job: &Job) -> bool {
    job.state == "cancelled" && job.result.as_deref() == Some(ENDED)
}

/// The turn of a job that is no longer queued or running (Stop and delete settle theirs
/// themselves): `stopped` when Connect stopped while it ran, else `failed` with the job's own
/// code and sentence (`cancelled` for a job Connect cancelled, such as after an access change),
/// so Try again is offered.
fn settle_gone(turn: &mut Turn, job: Option<&Job>) {
    turn.answer = None;
    if job.is_some_and(interrupted) {
        turn.state = TurnState::Stopped;
        return;
    }
    let code = match job {
        Some(j) if j.state == "cancelled" => "cancelled".to_string(),
        Some(j) => j.error_code.clone().unwrap_or_else(|| "failed".into()),
        None => "failed".into(),
    };
    turn.state = TurnState::Failed;
    turn.error = Some(TurnError {
        code,
        message: job
            .and_then(|j| j.result.clone())
            .unwrap_or_else(|| ENDED.into()),
    });
}

/// After an `ask` job ended other than `succeeded` (`run_claimed_job`'s last save): its turn,
/// if it still waits, is settled by [`settle_gone`], so no turn stays "Answering…" after a
/// job Connect cancelled or whose own write didn't land. Stop and delete settled theirs.
pub(crate) fn settle_ended(r: &mut Repository, job: &Job) -> Result<()> {
    let (Some(tid), Some(turn_id)) = (
        job.payload["threadId"].as_str(),
        job.payload["turnId"].as_str(),
    ) else {
        return Ok(());
    };
    let Some(mut thread) = store::read(r, tid)? else {
        return Ok(());
    };
    match turn_mut(&mut thread, turn_id) {
        Some(turn) if waiting(turn) => settle_gone(turn, Some(job)),
        _ => return Ok(()),
    }
    store::write(r, &thread)
}

/// `job_cancel` of an `ask` job: its turn reads `stopped` with no answer, unless it already
/// has its outcome. Called under the repository guard that cancels the job.
pub(crate) fn stop_turn(r: &mut Repository, job: &Job) -> Result<()> {
    let (Some(tid), Some(turn_id)) = (
        job.payload["threadId"].as_str(),
        job.payload["turnId"].as_str(),
    ) else {
        return Ok(());
    };
    let Some(mut thread) = store::read(r, tid)? else {
        return Ok(());
    };
    match turn_mut(&mut thread, turn_id) {
        Some(turn) if waiting(turn) => {
            turn.state = TurnState::Stopped;
            turn.answer = None;
        }
        _ => return Ok(()),
    }
    store::write(r, &thread)
}

/// What the job read for `gather`, owned.
struct Read {
    tasks: Vec<Record>,
    events: Vec<Record>,
    messages: Vec<Record>,
    meetings: Vec<MeetingDigest>,
    tasks_provider: String,
    m365: bool,
    zone: String,
}

/// How the facts are found this time.
enum FactsPlan {
    /// The voice is off, or facts are: no facts and nothing said.
    Off,
    /// The provider can't be asked (turned off or not listed): missed.
    Unreachable,
    /// Ask the plugin.
    Ask(String),
}

/// The voice's part: whether it is on (people and facts are read only then, fail closed), the
/// people of Connect's copy, the provider's name and how facts are found.
struct VoicePart {
    on: bool,
    people: Vec<Person>,
    name: String,
    facts: FactsPlan,
    provider: String,
    /// `Core::voice_epoch` when the copy was read: a delete since then drops the voice's part.
    epoch: usize,
}

/// What a failed answer still names: the profile and model that ran, the profile it fell back
/// from, and whether the About was gone.
#[derive(Default)]
struct Ran {
    profile: Option<String>,
    model: Option<String>,
    fell_back_from: Option<String>,
    about_gone: bool,
}

/// One meeting's summary: the first pinned summary template's document that can be read, else
/// Meeting notes'; empty when none can.
fn meeting_summary(m: &MeetingRecord, pinned: &[String]) -> String {
    let Some(folder) = m.folder.as_deref() else {
        return String::new();
    };
    let wanted = pinned
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(templates::DEFAULT_ID));
    for doc_id in wanted {
        let Some(doc) = m.docs.iter().find(|d| d.id == doc_id) else {
            continue;
        };
        if doc.file.is_empty() || doc.file.contains(['/', '\\']) || doc.file.starts_with('.') {
            continue;
        }
        let path = Path::new(folder).join(&doc.file);
        let small = std::fs::metadata(&path).is_ok_and(|md| md.len() <= SUMMARY_READ_MAX);
        if let (true, Ok(bytes)) = (small, std::fs::read(&path)) {
            return String::from_utf8_lossy(&bytes).into_owned();
        }
    }
    String::new()
}

impl Core {
    /// `ask_start` (design § 6). Under the mutation lock; nothing is stored when it refuses.
    pub(crate) fn ask_start(&self, req: &Request) -> Result<Value> {
        let (w, _) = self.active_workspace(req, false)?;
        let question = req.data["question"].as_str().map(str::trim).unwrap_or("");
        if question.is_empty() || question.chars().count() > QUESTION_MAX {
            let mut e = validation(QUESTION_REFUSAL);
            e.field = Some("question".into());
            return Err(e);
        }
        let hidden = hidden_calendars(&req.data);
        let mut r = self.repo()?;
        if r.jobs()?
            .iter()
            .any(|j| j.kind == KIND && matches!(j.state.as_str(), "queued" | "running"))
        {
            return Err(WorkspaceError::new("busy", BUSY));
        }
        let at = now();
        let mut thread = match req.data["threadId"].as_str() {
            Some(tid) => {
                let t = store::read(&r, tid)?.ok_or_else(|| validation(GONE))?;
                if t.turns.len() >= store::MAX_TURNS {
                    return Err(validation(LONG));
                }
                t
            }
            None => Thread {
                id: thread_id(),
                created_at: at,
                updated_at: at,
                next_ref: 1,
                turns: Vec::new(),
            },
        };
        let settings = r.settings()?;
        let Some(profile) = chosen_profile(&settings.ai, Purpose::Ask) else {
            return Err(AiError::new(ErrorClass::NeedsChoice).into());
        };
        let about = about_of(&r, &w.id, w.connection_id.as_deref(), &req.data["about"]);
        let turn_id = format!("turn-{}", thread.turns.len() + 1);
        let key = format!("{KIND}:{}", thread.id);
        let job = new_job(
            KIND,
            key.clone(),
            Some(w.id.clone()),
            None,
            at,
            r.policy(Some(&w.id), None)?,
            json!({
                "threadId": thread.id, "turnId": turn_id, "purpose": wire_name(Purpose::Ask),
                "profile": profile, "model": null, "runModel": null, "startedAt": at,
                "hiddenCalendars": hidden,
            }),
        );
        thread.turns.push(Turn {
            id: turn_id.clone(),
            at,
            question: question.into(),
            about,
            state: TurnState::Queued,
            answer: None,
            cites: Vec::new(),
            actions: Vec::new(),
            searched: None,
            cut: false,
            took: None,
            profile: None,
            model: None,
            fell_back_from: None,
            error: None,
            job_id: Some(job.id.clone()),
        });
        thread.updated_at = at;
        // The thread's earlier, finished job holds its key.
        r.delete_finished_jobs_keyed(&key)?;
        store::write(&mut r, &thread)?;
        r.enqueue(&job)?;
        // After the write, so the cap of 50 counts the new thread (it is the newest).
        let pruned = store::prune(&mut r, at)?;
        log::info!(
            "ask: queued turn {} of a thread ({} pruned)",
            thread.turns.len(),
            pruned
        );
        Ok(json!({"threadId": thread.id, "turnId": turn_id, "jobId": job.id}))
    }

    /// `ask_read {threadId}`: the whole thread (`ask-thread.json`). Read-only.
    pub(crate) fn ask_read(&self, req: &Request) -> Result<Value> {
        let tid = req.data["threadId"].as_str().unwrap_or("");
        let thread = store::read(&*self.repo()?, tid)?
            .ok_or_else(|| WorkspaceError::new("not_found", GONE))?;
        serde_json::to_value(thread)
            .map_err(|_| WorkspaceError::new("storage", "Workspace data needs recovery."))
    }

    /// `ask_delete {threadId} | {all: true}` (design § 5): a running answer of a deleted thread
    /// is cancelled first, so its job writes nothing. Answers `{deleted: n}`.
    pub(crate) fn ask_delete(&self, req: &Request) -> Result<Value> {
        let all = req.data["all"] == true;
        let mut r = self.repo()?;
        let ids: Vec<String> = if all {
            store::list(&r)?.into_iter().map(|t| t.id).collect()
        } else {
            vec![required(&req.data, "threadId", 200)?.to_string()]
        };
        let mut stopped = Vec::new();
        for mut j in r.jobs()?.into_iter().filter(|j| {
            j.kind == KIND
                && matches!(j.state.as_str(), "queued" | "running")
                && j.payload["threadId"]
                    .as_str()
                    .is_some_and(|t| ids.iter().any(|i| i == t))
        }) {
            j.state = "cancelled".into();
            r.save_job(&j)?;
            stopped.push(j.id);
        }
        let deleted = if all {
            store::delete_all(&mut r)?
        } else {
            store::delete(&mut r, &ids[0])?
        };
        drop(r);
        for job_id in &stopped {
            self.cancel_ai_job(job_id);
        }
        log::info!(
            "ask: deleted {deleted} thread(s), stopped {}",
            stopped.len()
        );
        Ok(json!({ "deleted": deleted }))
    }

    /// Start-up (design § 5, plan ruling): every turn left `queued` or `running` whose job is no
    /// longer queued or running is settled (`settle_gone`). Answers how many threads changed.
    /// Doesn't assume the prune ran.
    pub(crate) fn ask_startup(&self) -> Result<usize> {
        let mut r = self.repo()?;
        // A job claimed by the run before (its claim count says so; Repository::open put it back
        // to queued) is not run again: Connect stopped while it answered.
        for mut j in r.jobs()?.into_iter().filter(|j| {
            j.kind == KIND && j.attempts > 0 && matches!(j.state.as_str(), "queued" | "running")
        }) {
            j.state = "cancelled".into();
            j.result = Some(ENDED.into());
            j.lease_until = None;
            r.save_job(&j)?;
        }
        let jobs = r.jobs()?;
        let mut changed = 0;
        for mut thread in store::list(&r)? {
            let mut touched = false;
            for turn in thread.turns.iter_mut().filter(|t| waiting(t)) {
                let job = turn
                    .job_id
                    .as_deref()
                    .and_then(|jid| jobs.iter().find(|j| j.id == jid));
                if job.is_some_and(|j| matches!(j.state.as_str(), "queued" | "running")) {
                    continue;
                }
                settle_gone(turn, job);
                touched = true;
            }
            if touched {
                store::write(&mut r, &thread)?;
                changed += 1;
            }
        }
        if changed > 0 {
            log::info!("ask: settled {changed} thread(s) at start-up");
        }
        Ok(changed)
    }

    /// The `ask` job (design § 6). A failure other than a stop is written on the turn with
    /// its code and sentence; a stop (or a delete) writes nothing.
    pub(crate) async fn run_ask_job(&self, job: &Job) -> Result<String> {
        let tid = job.payload["threadId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let turn_id = job.payload["turnId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        // A claim whose lease ran out is never run a second time: the answer was already being
        // made once. The job ends cancelled and its turn reads stopped (`settle_ended`).
        if job.attempts > 1 {
            return Err(WorkspaceError::new("cancelled", ENDED));
        }
        let mut ran = Ran::default();
        match self.ask_answer(job, &tid, &turn_id, &mut ran).await {
            Ok(checked) => {
                log::info!(
                    "ask: answered with {} cites and {} actions ({} cites, {} actions dropped)",
                    checked.cites.len(),
                    checked.actions.len(),
                    checked.dropped_cites,
                    checked.dropped_actions
                );
                Ok("Answer ready".into())
            }
            Err(e) if e.code == "cancelled" => Err(e),
            Err(e) => {
                log::info!("ask: couldn't answer ({})", e.code);
                let error = TurnError {
                    code: e.code.clone(),
                    message: e.message.clone(),
                };
                // A claim lost meanwhile (Stop, delete) writes nothing: the job's own error stands.
                let _ = self
                    .ask_write(job, &tid, &turn_id, |t| {
                        if let Some(turn) = turn_mut(t, &turn_id) {
                            turn.state = TurnState::Failed;
                            turn.answer = None;
                            turn.error = Some(error);
                            turn.profile = ran.profile;
                            turn.model = ran.model;
                            turn.fell_back_from = ran.fell_back_from;
                            if let Some(about) = turn.about.as_mut() {
                                about.gone |= ran.about_gone;
                            }
                        }
                    })
                    .await;
                Err(e)
            }
        }
    }

    /// Writes `change` on the job's thread under the mutation lock, while the job still holds
    /// its claim and its turn still waits; the thread's `updatedAt` moves to now.
    async fn ask_write(
        &self,
        job: &Job,
        tid: &str,
        turn_id: &str,
        change: impl FnOnce(&mut Thread),
    ) -> Result<()> {
        let _lock = self.mutations.lock().await;
        let mut r = self.repo()?;
        r.check_claim(&job.id, job.attempts)?;
        r.check_policy(
            job.workspace_id.as_deref(),
            job.connection_id.as_deref(),
            &job.policy,
        )?;
        let mut thread = store::read(&r, tid)?.ok_or_else(no_longer)?;
        if !turn_mut(&mut thread, turn_id).is_some_and(|t| waiting(t)) {
            return Err(no_longer());
        }
        change(&mut thread);
        thread.updated_at = now();
        store::write(&mut r, &thread)?;
        drop(r);
        self.emit("workspace:changed");
        Ok(())
    }

    /// Marks the turn `running` under the mutation lock and keeps the job's `startedAt` at the
    /// turn's `at` (the snapshot's `running.startedAt`). Answers the thread as it was asked.
    async fn ask_running(&self, job: &Job, tid: &str, turn_id: &str) -> Result<Thread> {
        let _lock = self.mutations.lock().await;
        let mut r = self.repo()?;
        r.check_claim(&job.id, job.attempts)?;
        let mut thread = store::read(&r, tid)?.ok_or_else(no_longer)?;
        let turn = turn_mut(&mut thread, turn_id)
            .filter(|t| waiting(t))
            .ok_or_else(no_longer)?;
        turn.state = TurnState::Running;
        let at = turn.at;
        store::write(&mut r, &thread)?;
        let mut current = stored_job(&r, job)?;
        current.payload["startedAt"] = at.into();
        r.save_job(&current)?;
        drop(r);
        self.emit("workspace:changed");
        Ok(thread)
    }

    async fn ask_answer(
        &self,
        job: &Job,
        tid: &str,
        turn_id: &str,
        ran: &mut Ran,
    ) -> Result<Checked> {
        let resolved = self.resolve_key(&RouteKey::Purpose(Purpose::Ask)).await?;
        ran.profile = Some(resolved.profile.id.clone());
        ran.model = resolved.model.clone();
        ran.fell_back_from = resolved.fell_back_from.clone();
        let run = self.start_run(job, &resolved.profile, &resolved.model)?;
        let thread = self.ask_running(job, tid, turn_id).await?;
        let at = thread
            .turns
            .iter()
            .position(|t| t.id == turn_id)
            .ok_or_else(no_longer)?;
        let turn = thread.turns[at].clone();
        // A follow-up's earlier turns; a first question has none.
        let earlier = (at > 0).then(|| Thread {
            turns: thread.turns[..at].to_vec(),
            ..thread.clone()
        });

        let read = self.ask_records(job)?;
        let voice = self.ask_voice()?;
        let terms = context::query_terms(&turn.question, earlier.as_ref());
        let found: Option<Vec<Fact>> = match &voice.facts {
            FactsPlan::Off => None,
            // A question with no term asks nothing and misses nothing.
            _ if terms.is_empty() => Some(Vec::new()),
            FactsPlan::Unreachable => None,
            FactsPlan::Ask(plugin) => self.ask_facts(plugin, &terms, &run.cancel).await,
        };
        if run.cancel.is_cancelled() {
            return Err(AiError::new(ErrorClass::Cancelled).into());
        }
        // A voice Delete (or another provider) while the facts were asked: neither the copy's
        // people nor the facts reach this answer.
        let voice = if voice.on && !self.voice_unchanged(&voice)? {
            log::info!("ask: the voice changed during the run, leaving it out");
            VoicePart {
                on: false,
                people: Vec::new(),
                name: String::new(),
                facts: FactsPlan::Off,
                provider: voice.provider,
                epoch: voice.epoch,
            }
        } else {
            voice
        };
        let found = if voice.on { found } else { None };
        let records = Records {
            tasks: &read.tasks,
            events: &read.events,
            messages: &read.messages,
            meetings: &read.meetings,
            people: if voice.on { &voice.people } else { &[] },
            facts: found.as_deref(),
            facts_provider: match voice.facts {
                FactsPlan::Off => None,
                _ => Some(voice.name.as_str()),
            },
            tasks_provider: &read.tasks_provider,
            m365: read.m365,
            voice: voice.on,
        };
        let about = turn.about.as_ref().filter(|a| !a.gone);
        let now = now();
        let ctx = context::gather(
            &turn.question,
            earlier.as_ref(),
            about,
            &records,
            now,
            &read.zone,
        );
        ran.about_gone = ctx.about_gone;
        // The ids this turn hands out are the thread's from now on, however the turn ends
        // (ruling 33): done, failed or stopped.
        let next_ref = ctx.next_ref;
        self.ask_write(job, tid, turn_id, |t| t.next_ref = next_ref.max(t.next_ref))
            .await?;
        let today = prompts::local(now, prompts::time_zone(&read.zone), "%a %-d %b %Y");
        let spec = RunSpec {
            purpose: wire_name(Purpose::Ask),
            profile_id: resolved.profile.id.clone(),
            model: resolved.model.clone(),
            system: prompts::ASK_SYSTEM.into(),
            input: prompts::ask_input(
                &turn.question,
                &today,
                &ctx.searched,
                &ctx.text,
                ctx.conversation.as_deref(),
            ),
            schema: Some(prompts::schema(prompts::ASK_SCHEMA)),
            timeout: ASK_TIMEOUT,
            cap_usd: None,
            staging_root: self.paths.ensure_staging()?,
            folder: None,
        };
        let (outcome, checked, used, _) = self
            .run_claude_reported(&run, spec, &resolved, tid, |raw| {
                answer::check(raw, &ctx.refs, &ctx.facts).ok()
            })
            .await;
        let profile = resolved.profile_of(&used);
        ran.profile = Some(profile.id.clone());
        ran.model = outcome
            .as_ref()
            .and_then(|o| o.model.clone())
            .or_else(|| used.model.clone())
            .or_else(|| profile.default_model.clone());
        ran.fell_back_from = resolved.fallback_from(&used);
        let checked = checked.map_err(WorkspaceError::from)?;
        let done = checked.clone();
        let (profile, model, fell_back_from) = (
            ran.profile.clone(),
            ran.model.clone(),
            ran.fell_back_from.clone(),
        );
        self.ask_write(job, tid, turn_id, |t| {
            t.next_ref = ctx.next_ref.max(t.next_ref);
            if let Some(turn) = turn_mut(t, turn_id) {
                turn.state = TurnState::Done;
                turn.answer = Some(done.answer);
                turn.cites = done.cites;
                turn.actions = done.actions;
                turn.searched = Some(ctx.searched.clone());
                turn.cut = ctx.cut;
                turn.took = Some((crate::workspace::models::now() - turn.at).max(0));
                turn.profile = profile;
                turn.model = model;
                turn.fell_back_from = fell_back_from;
                turn.error = None;
                if let Some(about) = turn.about.as_mut() {
                    about.gone |= ctx.about_gone;
                }
            }
        })
        .await?;
        Ok(checked)
    }

    /// The facts the provider finds for `terms` (at most 10, never the question) within 3 s;
    /// `None` when it didn't answer in time, failed, or the job was stopped.
    async fn ask_facts(
        &self,
        plugin: &str,
        terms: &[String],
        cancel: &CancellationToken,
    ) -> Option<Vec<Fact>> {
        let providers = self.voice_providers.get().cloned()?;
        let terms: Vec<&String> = terms.iter().take(FACT_TERMS).collect();
        let args = json!({"terms": terms, "personId": null});
        let call =
            tokio::time::timeout(ASK_LIMIT, providers.call(plugin, "facts", args, ASK_LIMIT));
        let answer = tokio::select! {
            _ = cancel.cancelled() => return None,
            answer = call => answer.ok()?.ok()?,
        };
        let (kept, _) = facts::from_answer(&answer);
        Some(kept)
    }

    /// The voice's part, read under one repository guard (design § 3: people and facts only
    /// with the voice on; facts only when on and offered, as a reply draft decides).
    fn ask_voice(&self) -> Result<VoicePart> {
        let r = self.repo()?;
        // Read under the guard every copy delete holds while it bumps the epoch (as a reply
        // draft does).
        let epoch = self.voice_epoch.load(std::sync::atomic::Ordering::SeqCst);
        let settings = r.settings()?.voice;
        if settings.provider == "off" {
            return Ok(VoicePart {
                on: false,
                people: Vec::new(),
                name: String::new(),
                facts: FactsPlan::Off,
                provider: settings.provider,
                epoch,
            });
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
        let people = copy::read_copy(&r)?.map(|c| c.people).unwrap_or_default();
        let facts_on = settings.facts && listed.as_ref().is_none_or(|p| p.facts || !p.ready);
        let facts = if !facts_on {
            FactsPlan::Off
        } else if listed.as_ref().is_some_and(|p| p.on) {
            FactsPlan::Ask(plugin_of(&settings.provider).to_string())
        } else {
            FactsPlan::Unreachable
        };
        Ok(VoicePart {
            on: true,
            people,
            name,
            facts,
            provider: settings.provider,
            epoch,
        })
    }

    /// Whether the voice read by [`Self::ask_voice`] still stands: the same provider chosen and
    /// no copy delete since (`voice_epoch`).
    fn voice_unchanged(&self, voice: &VoicePart) -> Result<bool> {
        let r = self.repo()?;
        let moved = self.voice_epoch.load(std::sync::atomic::Ordering::SeqCst) != voice.epoch;
        Ok(!moved && r.settings()?.voice.provider == voice.provider)
    }

    /// The records Ask may read for the job's workspace (design § 3): the active provider's
    /// tasks; with Microsoft 365 connected to the workspace, the events, messages (with their
    /// Inbox lanes) and meetings the workspace selects and the account permits, none on a
    /// calendar the window hides. Files are read after the repository guard is released.
    fn ask_records(&self, job: &Job) -> Result<Read> {
        let hidden = hidden_calendars(&job.payload);
        let settings: Settings = self.repo()?.settings()?;
        let tasks_provider = self.task_provider_snapshot(&settings)["name"]
            .as_str()
            .unwrap_or("Connect")
            .to_string();
        let r = self.repo()?;
        let w = r.workspace(job.workspace_id.as_deref().unwrap_or("personal"))?;
        let tasks = tasks::active(&r, &w.id)?;
        let c: Option<Connection> = settings
            .active_connection
            .as_deref()
            .filter(|cid| w.connection_id.as_deref() == Some(*cid))
            .and_then(|cid| r.connection(cid).ok())
            .filter(|c| c.status == "connected");
        let (mut events, mut messages, mut meetings) = (Vec::new(), Vec::new(), Vec::new());
        if let Some(c) = &c {
            let shown = |rec: &Record| {
                record_selected(rec, &w) && source_permitted(rec, c) && !on_hidden(rec, &hidden)
            };
            events = r
                .provider_records(&c.id, "event")?
                .into_iter()
                .filter(|e| shown(e))
                .collect();
            let mut all = r.account_workspace_records(&c.id, &w.id)?;
            inbox::project(&r, &w, Some(c), &mut all)?;
            messages = all
                .into_iter()
                .filter(|m| m.kind == "message" && shown(m))
                .collect();
            meetings = r
                .provider_records(&c.id, "meeting")?
                .into_iter()
                .filter(|m| shown(m))
                .filter_map(|m| {
                    let parsed: MeetingRecord = serde_json::from_value(m.data).ok()?;
                    Some((m.id, parsed))
                })
                .collect::<Vec<_>>();
        }
        drop(r);
        let digests = meetings
            .into_iter()
            .map(|(meeting_id, m)| {
                let attendees = events
                    .iter()
                    .find(|e| e.id == meeting_id)
                    .and_then(|e| e.data["attendees"].as_array().cloned())
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|a| {
                        a["name"]
                            .as_str()
                            .filter(|n| !n.trim().is_empty())
                            .or_else(|| a["address"].as_str())
                            .map(String::from)
                    })
                    .collect();
                let action_items = tasks
                    .iter()
                    .filter(|t| t.data["meetingId"] == meeting_id.as_str())
                    .filter_map(|t| t.data["text"].as_str().map(String::from))
                    .collect();
                MeetingDigest {
                    at: graph::timestamp(&m.start),
                    title: m.title.clone(),
                    summary: meeting_summary(&m, &settings.meetings.summary_tabs),
                    id: meeting_id,
                    attendees,
                    action_items,
                }
            })
            .collect();
        Ok(Read {
            tasks,
            events,
            messages,
            meetings: digests,
            tasks_provider,
            m365: c.is_some(),
            zone: settings.time_zone,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::store::tests::{thread, turn};
    use super::super::store::{self, TurnState};
    use super::*;
    use crate::ai::command::build_command;
    use crate::ai::fake::{FakeRunner, Gate};
    use crate::ai::stream::{AiError, ErrorClass, RunOutcome, Usage};
    use crate::workspace::ai::tests::{mutation, ready};
    use crate::workspace::models::{now, Connection, Operation, Record};
    use crate::workspace::prompts::{self, ASK_SCHEMA, ASK_SYSTEM};
    use crate::workspace::test_core;
    use crate::workspace::voice::draft::tests::{calls_of, ready_voice};
    use serde_json::json;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const ACCT: &str = "acct";
    const SENTINEL: &str = "ASK_SENTINEL_5c1e";
    const DAY: i64 = 86_400;
    const GONE: &str = "That conversation is gone. Ask again.";

    struct Env {
        _dir: tempfile::TempDir,
        core: Arc<Core>,
        fake: Arc<FakeRunner>,
    }

    fn env(script: Vec<std::result::Result<RunOutcome, AiError>>) -> Env {
        env_with(Arc::new(FakeRunner::new(script)))
    }

    fn env_with(fake: Arc<FakeRunner>) -> Env {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), fake.clone(), ready());
        seed(&core);
        Env {
            _dir: dir,
            core,
            fake,
        }
    }

    /// A connected Microsoft account bound to `personal`, Claude Code as the default profile.
    fn seed(core: &Core) {
        let mut r = core.repo().unwrap();
        let c = Connection {
            id: ACCT.into(),
            account_key: ACCT.into(),
            display_name: "Taylor Reed".into(),
            email: "taylor@example.test".into(),
            user_id: "me-1".into(),
            generation: 1,
            policy_revision: 1,
            scopes: vec![
                "Calendars.Read".into(),
                "Mail.Read".into(),
                "Chat.Read".into(),
            ],
            enabled: vec!["calendar".into(), "mail".into(), "chats".into()],
            status: "connected".into(),
            given_name: Some("Taylor".into()),
            ..Default::default()
        };
        r.save_connection(&c).unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some(ACCT.into());
        s.time_zone = "Europe/Kyiv".into();
        s.ai.default_profile = Some("claude".into());
        r.settings_update(&s).unwrap();
        let mut w = r.workspace("personal").unwrap();
        w.connection_id = Some(ACCT.into());
        w.sources = json!({"all": true});
        r.save_workspace(&w).unwrap();
    }

    fn put(core: &Core, record: Record) {
        core.repo().unwrap().put_record(&record).unwrap();
    }

    fn mail(id: &str, at: i64, text: &str) -> Record {
        Record {
            id: id.into(),
            kind: "message".into(),
            connection_id: Some(ACCT.into()),
            workspace_id: None,
            source: "mail:inbox".into(),
            revision: "v1".into(),
            updated_at: at,
            data: json!({"channel": "mail", "conversationId": format!("conv-{id}"),
                "title": "Atlas budget", "from": "Priya N.", "fromAddress": "priya@example.test",
                "isMine": false, "isRead": false, "at": at, "text": text}),
        }
    }

    fn rfc(t: i64) -> String {
        use chrono::TimeZone;
        chrono::Utc
            .timestamp_opt(t, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    fn event(id: &str, calendar: &str, start: i64, title: &str) -> Record {
        Record {
            id: id.into(),
            kind: "event".into(),
            connection_id: Some(ACCT.into()),
            workspace_id: None,
            source: format!("calendar:{calendar}"),
            revision: "v1".into(),
            updated_at: start,
            data: json!({"title": title, "start": rfc(start), "end": rfc(start + 1800),
                "calendarId": calendar, "allDay": false, "cancelled": false, "attendees": []}),
        }
    }

    fn task(id: &str, text: &str) -> Record {
        Record {
            id: id.into(),
            kind: "commitment".into(),
            connection_id: None,
            workspace_id: Some("personal".into()),
            source: "local".into(),
            revision: "v1".into(),
            updated_at: now(),
            data: json!({"text": text, "status": "todo", "owner": "You"}),
        }
    }

    fn outcome(structured: Value) -> RunOutcome {
        RunOutcome {
            structured: Some(structured),
            text: String::new(),
            usage: Usage {
                input_tokens: 900,
                output_tokens: 120,
                ..Default::default()
            },
            cost_usd: Some(0.01),
            duration_ms: 3200,
            model: Some("claude-sonnet-4-5".into()),
        }
    }

    fn cited() -> RunOutcome {
        outcome(
            json!({"answer": "The Atlas budget is due Friday [m1].", "cites": ["m1"],
            "actions": [{"kind": "open", "ref": "m1"}]}),
        )
    }

    fn failure(class: ErrorClass, message: &str) -> std::result::Result<RunOutcome, AiError> {
        let mut e = AiError::new(class);
        e.message = message.into();
        Err(e)
    }

    async fn op(core: &Arc<Core>, op: Operation, data: Value) -> Result<Value> {
        core.request(mutation(core, op, data)).await
    }

    async fn ask(core: &Arc<Core>, data: Value) -> Result<Value> {
        op(core, Operation::AskStart, data).await
    }

    async fn read(core: &Arc<Core>, thread_id: &str) -> Result<Value> {
        core.request(Request {
            op: Operation::AskRead,
            workspace_id: Some("personal".into()),
            expected_revision: None,
            operation_id: None,
            data: json!({ "threadId": thread_id }),
        })
        .await
    }

    async fn run_jobs(core: &Arc<Core>) {
        loop {
            // Bound first: the repository guard must be gone before the job runs.
            let claimed = core.repo().unwrap().claim(now()).unwrap();
            let Some(job) = claimed else { break };
            core.clone().run_claimed_job(job).await;
        }
    }

    /// Claims the next job and runs it on a gated runner; `during` runs while Claude works.
    async fn run_next_with<F: std::future::Future<Output = ()>>(
        core: &Arc<Core>,
        gate: &Gate,
        during: impl FnOnce() -> F,
    ) {
        let claimed = core.repo().unwrap().claim(now()).unwrap().unwrap();
        let running = tokio::spawn(core.clone().run_claimed_job(claimed));
        gate.started.notified().await;
        during().await;
        gate.release.notify_one();
        running.await.unwrap();
    }

    fn thread_of(core: &Core, id: &str) -> Option<Thread> {
        store::read(&core.repo().unwrap(), id).unwrap()
    }

    fn jobs(core: &Core) -> Vec<Job> {
        core.repo()
            .unwrap()
            .jobs()
            .unwrap()
            .into_iter()
            .filter(|j| j.kind == KIND)
            .collect()
    }

    fn job(core: &Core, id: &Value) -> Job {
        jobs(core)
            .into_iter()
            .find(|j| Some(j.id.as_str()) == id.as_str())
            .unwrap()
    }

    fn ai_runs(core: &Core) -> Vec<Record> {
        core.repo().unwrap().records_of_kind("ai_run").unwrap()
    }

    fn context_of(spec: &crate::ai::command::RunSpec) -> String {
        spec.input["context"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn with_fallback(core: &Core, fallback: &str) {
        let mut r = core.repo().unwrap();
        let mut s = r.settings().unwrap();
        s.ai.default_fallback = Some(fallback.into());
        r.settings_update(&s).unwrap();
    }

    #[tokio::test]
    async fn ask_start_writes_a_queued_turn_and_queues_one_job() {
        let e = env(vec![]);
        let answer = ask(&e.core, json!({"question": "  When is the QBR?  "}))
            .await
            .unwrap();
        let tid = answer["threadId"].as_str().unwrap();
        assert!(tid.starts_with("ask-"), "{answer}");
        let t = thread_of(&e.core, tid).unwrap();
        assert_eq!(t.turns.len(), 1);
        let turn = &t.turns[0];
        assert_eq!(answer["turnId"], turn.id.as_str());
        assert_eq!(turn.question, "When is the QBR?");
        assert_eq!(turn.state, TurnState::Queued);
        assert_eq!(turn.job_id.as_deref(), answer["jobId"].as_str());
        assert_eq!(t.next_ref, 1);
        let queued = jobs(&e.core);
        assert_eq!(queued.len(), 1);
        let j = &queued[0];
        assert_eq!(j.state, "queued");
        assert_eq!(j.key, format!("ask:{tid}"));
        assert_eq!(answer["jobId"], j.id.as_str());
        assert_eq!(j.payload["purpose"], "ask");
        assert_eq!(j.payload["threadId"], tid);
        assert_eq!(j.payload["turnId"], turn.id.as_str());
        assert_eq!(j.payload["profile"], "claude");
        assert_eq!(j.payload["startedAt"], turn.at);
        assert!(!j.payload.to_string().contains("QBR"), "no question text");
    }

    #[tokio::test]
    async fn the_job_answers_with_cites_and_actions() {
        let e = env(vec![Ok(cited())]);
        put(
            &e.core,
            mail("msg-1", now() - 3_600, "The Atlas budget is due Friday."),
        );
        let answer = ask(
            &e.core,
            json!({"question": "When is the Atlas budget due?"}),
        )
        .await
        .unwrap();
        run_jobs(&e.core).await;
        let t = thread_of(&e.core, answer["threadId"].as_str().unwrap()).unwrap();
        let turn = &t.turns[0];
        assert_eq!(turn.state, TurnState::Done, "{turn:?}");
        // The meta line's "<n> s": the seconds from the question to the answer.
        assert!(
            turn.took.is_some_and(|s| (0..5).contains(&s)),
            "{:?}",
            turn.took
        );
        assert_eq!(
            turn.answer.as_deref(),
            Some("The Atlas budget is due Friday [m1].")
        );
        assert_eq!(turn.cites.len(), 1);
        assert_eq!(turn.cites[0].id, "m1");
        assert_eq!(turn.cites[0].kind, "message");
        assert_eq!(turn.cites[0].record_id.as_deref(), Some("msg-1"));
        assert!(turn.cites[0]
            .label
            .as_deref()
            .unwrap()
            .starts_with("Priya N. · mail"));
        assert_eq!(turn.actions.len(), 1);
        assert_eq!(turn.actions[0]["kind"], "open");
        assert_eq!(turn.actions[0]["recordId"], "msg-1");
        assert_eq!(turn.profile.as_deref(), Some("claude"));
        assert_eq!(turn.model.as_deref(), Some("claude-sonnet-4-5"));
        assert!(turn.searched.as_deref().unwrap().contains("messages 1"));
        assert_eq!(turn.error, None);
        assert_eq!(t.next_ref, 2, "the next turn's ids start after m1");
        assert_eq!(job(&e.core, &answer["jobId"]).state, "succeeded");
        let runs = ai_runs(&e.core);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].data["purpose"], "ask");
        assert_eq!(runs[0].data["status"], "ok");
    }

    #[tokio::test]
    async fn ask_runs_tool_free_on_the_ask_route() {
        let e = env(vec![Ok(cited())]);
        ask(
            &e.core,
            json!({"question": "When is the Atlas budget due?"}),
        )
        .await
        .unwrap();
        run_jobs(&e.core).await;
        let calls = e.fake.calls();
        assert_eq!(calls.len(), 1);
        let spec = &calls[0];
        assert_eq!(spec.purpose, "ask");
        assert_eq!(spec.profile_id, "claude");
        assert!(spec.folder.is_none());
        assert_eq!(spec.timeout, Duration::from_secs(120));
        assert_eq!(spec.cap_usd, None);
        assert_eq!(spec.system, ASK_SYSTEM);
        assert_eq!(spec.schema, Some(prompts::schema(ASK_SCHEMA)));
        assert_eq!(spec.input["question"], "When is the Atlas budget due?");
        let plan = build_command(
            spec,
            &ready()[0],
            std::path::Path::new("claude"),
            std::path::Path::new("/tmp"),
        );
        let tools = plan.args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(plan.args[tools + 1], "");
        assert!(plan.args.iter().any(|a| a == "--strict-mcp-config"));
        assert!(plan.args.iter().any(|a| a == "--no-session-persistence"));
    }

    #[tokio::test]
    async fn one_ask_at_a_time() {
        let e = env(vec![]);
        let first = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        let refused = ask(&e.core, json!({"question": "Who is Marek Novak?"}))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "busy");
        assert_eq!(
            refused.message,
            "Connect is still answering. Stop it or wait."
        );
        let follow = ask(
            &e.core,
            json!({"threadId": first["threadId"], "question": "And the agenda?"}),
        )
        .await
        .unwrap_err();
        assert_eq!(follow.code, "busy");
        assert_eq!(jobs(&e.core).len(), 1);
        assert_eq!(store::list(&e.core.repo().unwrap()).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn questions_are_validated() {
        let e = env(vec![]);
        for q in [
            json!(""),
            json!("   "),
            json!("x".repeat(2_001)),
            Value::Null,
        ] {
            let refused = ask(&e.core, json!({ "question": q })).await.unwrap_err();
            assert_eq!(refused.code, "validation");
            assert_eq!(refused.field.as_deref(), Some("question"));
            assert_eq!(refused.message, "Type a question, up to 2,000 characters.");
        }
        ask(&e.core, json!({"question": "é".repeat(2_000)}))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn needs_choice_stores_nothing() {
        let e = env(vec![]);
        {
            let mut r = e.core.repo().unwrap();
            let mut s = r.settings().unwrap();
            s.ai.default_profile = None;
            r.settings_update(&s).unwrap();
        }
        let refused = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "needs_choice");
        assert!(store::list(&e.core.repo().unwrap()).unwrap().is_empty());
        assert!(jobs(&e.core).is_empty());
    }

    #[tokio::test]
    async fn the_21st_turn_is_refused() {
        let e = env(vec![]);
        let at = now() - 60;
        let turns = (1..=20)
            .map(|n| turn(n, at, "When is the QBR?", TurnState::Done))
            .collect();
        store::write(&mut e.core.repo().unwrap(), &thread("ask-long", at, turns)).unwrap();
        let refused = ask(
            &e.core,
            json!({"threadId": "ask-long", "question": "And now?"}),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, "validation");
        assert_eq!(
            refused.message,
            "This conversation is long. Start a new question."
        );
        assert_eq!(thread_of(&e.core, "ask-long").unwrap().turns.len(), 20);
        assert!(jobs(&e.core).is_empty());
    }

    #[tokio::test]
    async fn an_unknown_thread_is_refused() {
        let e = env(vec![]);
        let refused = ask(&e.core, json!({"threadId": "ask-nope", "question": "And?"}))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "validation");
        assert_eq!(refused.message, GONE);
        let unknown = read(&e.core, "ask-nope").await.unwrap_err();
        assert_eq!(unknown.code, "not_found");
        assert_eq!(unknown.message, GONE);
    }

    #[tokio::test]
    async fn ask_read_answers_the_whole_thread() {
        let e = env(vec![Ok(cited())]);
        put(
            &e.core,
            mail("msg-1", now() - 3_600, "The Atlas budget is due Friday."),
        );
        let a = ask(
            &e.core,
            json!({"question": "When is the Atlas budget due?"}),
        )
        .await
        .unwrap();
        run_jobs(&e.core).await;
        let tid = a["threadId"].as_str().unwrap();
        let got = read(&e.core, tid).await.unwrap();
        let stored = serde_json::to_value(thread_of(&e.core, tid).unwrap()).unwrap();
        assert_eq!(got, stored);
        assert_eq!(got["turns"][0]["state"], "done");
    }

    #[tokio::test]
    async fn a_missing_about_is_dropped_and_said() {
        let e = env(vec![Ok(outcome(
            json!({"answer": "Not in Connect.", "cites": [], "actions": []}),
        ))]);
        put(
            &e.core,
            mail("msg-1", now() - 3_600, "The Atlas budget is due Friday."),
        );
        let label = "Priya N. · mail · Tue 25 Nov";
        let a = ask(
            &e.core,
            json!({"question": "What does this say?",
                "about": {"kind": "message", "recordId": "msg-1", "label": label}}),
        )
        .await
        .unwrap();
        let tid = a["threadId"].as_str().unwrap();
        let about = thread_of(&e.core, tid).unwrap().turns[0]
            .about
            .clone()
            .unwrap();
        assert!(!about.gone, "there at submit");
        // Sync deletes the record before the job runs.
        let mut gone = mail("msg-1", now() - 3_600, "The Atlas budget is due Friday.");
        gone.data["deleted"] = true.into();
        put(&e.core, gone);
        run_jobs(&e.core).await;
        let turn = thread_of(&e.core, tid).unwrap().turns[0].clone();
        assert_eq!(turn.state, TurnState::Done);
        let about = turn.about.unwrap();
        assert_eq!(
            (
                about.kind.as_str(),
                about.record_id.as_str(),
                about.label.as_str(),
                about.gone
            ),
            ("message", "msg-1", label, true)
        );
        assert!(!context_of(&e.fake.calls()[0]).contains("id=\"a1\""));

        // Gone already at submit: said at once, and never looked up again.
        let e = env(vec![]);
        let a = ask(
            &e.core,
            json!({"question": "What does this say?",
                "about": {"kind": "task", "recordId": "t-gone", "label": "Task · Send it"}}),
        )
        .await
        .unwrap();
        let about = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .about
            .clone()
            .unwrap();
        assert!(about.gone);
        assert_eq!(about.label, "Task · Send it");
    }

    #[tokio::test]
    async fn a_follow_up_replays_and_continues_ids() {
        let e = env(vec![
            Ok(cited()),
            Ok(outcome(
                json!({"answer": "Priya asked first [m2].", "cites": ["m2"], "actions": []}),
            )),
        ]);
        put(
            &e.core,
            mail("msg-1", now() - 3_600, "The Atlas budget is due Friday."),
        );
        let a = ask(
            &e.core,
            json!({"question": "When is the Atlas budget due?"}),
        )
        .await
        .unwrap();
        run_jobs(&e.core).await;
        let tid = a["threadId"].as_str().unwrap();
        let first_next = thread_of(&e.core, tid).unwrap().next_ref;
        let b = ask(
            &e.core,
            json!({"threadId": tid, "question": "Who asked about the Atlas budget?"}),
        )
        .await
        .unwrap();
        assert_eq!(b["threadId"], tid);
        run_jobs(&e.core).await;
        let calls = e.fake.calls();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].input.get("conversation").is_none());
        let conversation = calls[1].input["conversation"].as_str().unwrap();
        assert!(conversation.contains("When is the Atlas budget due?"));
        assert!(!conversation.contains("[m1]"), "replays carry labels");
        let context = context_of(&calls[1]);
        assert!(
            context.contains(&format!("id=\"m{first_next}\"")),
            "{context}"
        );
        assert!(!context.contains("id=\"m1\""));
        let t = thread_of(&e.core, tid).unwrap();
        assert_eq!(t.turns.len(), 2);
        assert_eq!(t.turns[1].state, TurnState::Done);
        assert_eq!(t.turns[1].cites[0].id, "m2");
        assert!(t.next_ref > first_next);
    }

    #[tokio::test]
    async fn the_facts_ask_carries_terms_only() {
        let e = env(vec![Ok(outcome(
            json!({"answer": "On track [f1].", "cites": ["f1"], "actions": []}),
        ))]);
        let voice = ready_voice(&e.core, "");
        voice.answer(
            "facts",
            json!({"facts": [{"id": "projects/atlas.md", "title": "Atlas rollout", "text": "Rollout starts 1 Dec."}]}),
        );
        let question = "How is the Atlas rollout going for EPM-1234?";
        ask(&e.core, json!({ "question": question })).await.unwrap();
        run_jobs(&e.core).await;
        let asked = calls_of(&voice, "facts");
        assert_eq!(asked.len(), 1);
        let args = &asked[0];
        assert_eq!(args.as_object().unwrap().len(), 2, "{args}");
        assert_eq!(args["personId"], Value::Null);
        let terms = args["terms"].as_array().unwrap();
        assert!(!terms.is_empty() && terms.len() <= 10, "{args}");
        assert!(terms.iter().any(|t| t == "EPM-1234"), "{args}");
        assert!(!args.to_string().contains(question));
        let spec = &e.fake.calls()[0];
        assert!(context_of(spec).contains("Rollout starts 1 Dec."));
        let searched = spec.input["searched"].as_str().unwrap();
        assert!(searched.contains("facts 1 (Knowledge)"), "{searched}");

        // A provider that doesn't answer in 3 s: the run goes on without facts and says so.
        let e = env(vec![Ok(outcome(
            json!({"answer": "Not in Connect.", "cites": [], "actions": []}),
        ))]);
        let voice = ready_voice(&e.core, "");
        voice.answer("facts", json!({"facts": []}));
        voice.delay("facts", Duration::from_secs(10));
        let a = ask(&e.core, json!({ "question": question })).await.unwrap();
        let started = Instant::now();
        run_jobs(&e.core).await;
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "{:?}",
            started.elapsed()
        );
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        assert_eq!(turn.state, TurnState::Done);
        assert!(
            turn.searched
                .unwrap()
                .contains("Knowledge found no facts in time"),
            "the miss is said"
        );
    }

    #[tokio::test]
    async fn a_question_without_terms_asks_no_facts_and_misses_none() {
        let e = env(vec![Ok(outcome(
            json!({"answer": "Nothing.", "cites": [], "actions": []}),
        ))]);
        let voice = ready_voice(&e.core, "");
        let a = ask(&e.core, json!({"question": "anything?"}))
            .await
            .unwrap();
        run_jobs(&e.core).await;
        assert!(calls_of(&voice, "facts").is_empty());
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        let searched = turn.searched.unwrap();
        assert!(!searched.contains("in time"), "{searched}");
        assert!(searched.contains("facts 0 (Knowledge)"), "{searched}");
    }

    #[tokio::test]
    async fn hidden_calendars_stay_out_of_the_context() {
        let e = env(vec![Ok(outcome(
            json!({"answer": "Two.", "cites": [], "actions": []}),
        ))]);
        put(&e.core, event("ev-1", "cal-work", now() + DAY, "Shown QBR"));
        put(
            &e.core,
            event("ev-2", "cal-home", now() + DAY, "Hidden dentist"),
        );
        ask(
            &e.core,
            json!({"question": "What's on this week?", "hiddenCalendars": ["cal-home"]}),
        )
        .await
        .unwrap();
        run_jobs(&e.core).await;
        let context = context_of(&e.fake.calls()[0]);
        assert!(context.contains("Shown QBR"), "{context}");
        assert!(!context.contains("Hidden dentist"), "{context}");
    }

    #[tokio::test]
    async fn failures_keep_the_code_and_sentence() {
        let e = env(vec![
            failure(ErrorClass::NeedsLogin, "Claude is not signed in."),
            failure(ErrorClass::NeedsLogin, "CodeMie is not signed in."),
        ]);
        with_fallback(&e.core, "codemie:prod");
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        run_jobs(&e.core).await;
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        assert_eq!(turn.state, TurnState::Failed);
        assert_eq!(turn.answer, None);
        let error = turn.error.unwrap();
        assert_eq!(error.code, "needs_login");
        assert_eq!(error.message, "CodeMie is not signed in.");
        assert_eq!(turn.profile.as_deref(), Some("codemie:prod"));
        assert_eq!(turn.fell_back_from.as_deref(), Some("claude"));
        assert_eq!(ai_runs(&e.core).len(), 2, "both attempts are in the ledger");
        let j = job(&e.core, &a["jobId"]);
        assert_eq!(j.error_class.as_deref(), Some("needs_login"));

        // An answer with no text is invalid output.
        let e = env(vec![Ok(outcome(
            json!({"answer": "  ", "cites": [], "actions": []}),
        ))]);
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        run_jobs(&e.core).await;
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        assert_eq!(turn.state, TurnState::Failed);
        assert_eq!(turn.error.unwrap().code, "invalid_output");
        assert_eq!(turn.profile.as_deref(), Some("claude"));
        assert_eq!(turn.fell_back_from, None);
    }

    #[tokio::test]
    async fn stop_marks_the_turn_stopped() {
        let (runner, gate) = FakeRunner::gated(vec![Ok(cited())]);
        let e = env_with(Arc::new(runner));
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        let tid = a["threadId"].as_str().unwrap().to_string();
        let core = e.core.clone();
        let jid = a["jobId"].clone();
        run_next_with(&e.core, &gate, || async move {
            let t = thread_of(&core, &tid).unwrap();
            assert_eq!(t.turns[0].state, TurnState::Running);
            op(&core, Operation::JobCancel, json!({ "id": jid }))
                .await
                .unwrap();
        })
        .await;
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        assert_eq!(turn.state, TurnState::Stopped);
        assert_eq!(turn.answer, None);
        assert_eq!(turn.error, None);
        assert_eq!(job(&e.core, &a["jobId"]).state, "cancelled");

        // A queued ask stopped before it ran.
        let e = env(vec![]);
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        op(&e.core, Operation::JobCancel, json!({ "id": a["jobId"] }))
            .await
            .unwrap();
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        assert_eq!(turn.state, TurnState::Stopped);
        run_jobs(&e.core).await;
        assert!(e.fake.calls().is_empty());
        // The thread takes a new question after a stop.
        ask(
            &e.core,
            json!({"threadId": a["threadId"], "question": "Ask again"}),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn delete_while_running_cancels_and_writes_nothing() {
        let (runner, gate) = FakeRunner::gated(vec![Ok(cited())]);
        let e = env_with(Arc::new(runner));
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        let tid = a["threadId"].as_str().unwrap().to_string();
        let core = e.core.clone();
        let t2 = tid.clone();
        run_next_with(&e.core, &gate, || async move {
            let deleted = op(&core, Operation::AskDelete, json!({ "threadId": t2 }))
                .await
                .unwrap();
            assert_eq!(deleted, json!({"deleted": 1}));
        })
        .await;
        assert_eq!(thread_of(&e.core, &tid), None, "nothing written back");
        assert_eq!(job(&e.core, &a["jobId"]).state, "cancelled");
        assert!(store::list(&e.core.repo().unwrap()).unwrap().is_empty());
    }

    #[tokio::test]
    async fn startup_fails_turns_whose_job_is_gone() {
        let e = env(vec![]);
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        let tid = a["threadId"].as_str().unwrap().to_string();
        // Still queued: left alone.
        assert_eq!(e.core.ask_startup().unwrap(), 0);
        assert_eq!(
            thread_of(&e.core, &tid).unwrap().turns[0].state,
            TurnState::Queued
        );
        {
            let mut r = e.core.repo().unwrap();
            let mut j = r
                .jobs()
                .unwrap()
                .into_iter()
                .find(|j| j.kind == KIND)
                .unwrap();
            j.state = "failed".into();
            j.result = Some("Interrupted".into());
            r.save_job(&j).unwrap();
        }
        assert_eq!(e.core.ask_startup().unwrap(), 1);
        let settled = thread_of(&e.core, &tid).unwrap().turns[0].clone();
        assert_eq!(settled.state, TurnState::Failed);
        let error = settled.error.unwrap();
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("failed", "Interrupted")
        );

        // A running turn whose job is no longer there at all.
        let mut orphan = turn(1, now() - 60, "Who is Marek Novak?", TurnState::Running);
        orphan.job_id = Some("job-gone".into());
        store::write(
            &mut e.core.repo().unwrap(),
            &thread("ask-orphan", now() - 60, vec![orphan]),
        )
        .unwrap();
        assert_eq!(e.core.ask_startup().unwrap(), 1);
        let settled = thread_of(&e.core, "ask-orphan").unwrap().turns[0].clone();
        assert_eq!(settled.state, TurnState::Failed);
        assert_eq!(settled.error.unwrap().code, "failed");
    }

    #[tokio::test]
    async fn delete_all_answers_the_count() {
        let e = env(vec![]);
        for n in 0..3 {
            let at = now() - n;
            store::write(
                &mut e.core.repo().unwrap(),
                &thread(
                    &format!("ask-{n}"),
                    at,
                    vec![turn(1, at, "Q?", TurnState::Done)],
                ),
            )
            .unwrap();
        }
        let one = op(&e.core, Operation::AskDelete, json!({"threadId": "ask-1"}))
            .await
            .unwrap();
        assert_eq!(one, json!({"deleted": 1}));
        let none = op(&e.core, Operation::AskDelete, json!({"threadId": "ask-1"}))
            .await
            .unwrap();
        assert_eq!(none, json!({"deleted": 0}));
        let all = op(&e.core, Operation::AskDelete, json!({"all": true}))
            .await
            .unwrap();
        assert_eq!(all, json!({"deleted": 2}));
        assert!(store::list(&e.core.repo().unwrap()).unwrap().is_empty());
    }

    #[tokio::test]
    async fn ask_start_prunes() {
        let e = env(vec![]);
        let old = now() - 31 * DAY;
        store::write(
            &mut e.core.repo().unwrap(),
            &thread("ask-old", old, vec![turn(1, old, "Q?", TurnState::Done)]),
        )
        .unwrap();
        ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        assert_eq!(thread_of(&e.core, "ask-old"), None);
    }

    #[tokio::test]
    async fn the_ledger_and_logs_hold_no_question_answer_or_context_text() {
        let e = env(vec![
            Ok(outcome(
                json!({"answer": format!("Atlas {SENTINEL} [m3]."), "cites": ["m3"], "actions": []}),
            )),
            Ok(outcome(json!({"answer": "", "cites": [], "actions": []}))),
        ]);
        let voice = ready_voice(&e.core, "");
        voice.answer_every(
            "facts",
            json!({"facts": [{"id": "projects/atlas.md", "title": "Atlas", "text": format!("Atlas fact {SENTINEL}")}]}),
        );
        put(
            &e.core,
            mail("msg-1", now() - 3_600, &format!("Atlas mail {SENTINEL}")),
        );
        put(&e.core, task("t-1", &format!("Atlas task {SENTINEL}")));
        let folder = e._dir.path().join("meeting");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("notes.md"), format!("Atlas summary {SENTINEL}")).unwrap();
        let start = now() - DAY;
        put(
            &e.core,
            Record {
                id: "ev-mtg".into(),
                kind: "meeting".into(),
                connection_id: Some(ACCT.into()),
                workspace_id: None,
                source: "calendar:cal-work".into(),
                revision: "v1".into(),
                updated_at: start,
                data: json!({"eventId": "ev-mtg", "title": "Atlas sync", "start": rfc(start),
                    "end": rfc(start + 1800), "state": "ready",
                    "folder": folder.to_string_lossy(),
                    "docs": [{"id": "meeting-notes", "template": "meeting-notes",
                        "name": "Meeting notes", "file": "notes.md", "version": 1}]}),
            },
        );
        let question = format!("What about Atlas {SENTINEL}?");
        ask(&e.core, json!({ "question": question })).await.unwrap();
        run_jobs(&e.core).await;
        let spec = &e.fake.calls()[0];
        let context = context_of(spec);
        for what in ["mail", "task", "summary", "fact"] {
            assert!(
                context.contains(&format!("Atlas {what} {SENTINEL}")),
                "{what} reaches the run: {context}"
            );
        }
        assert!(spec.input["question"].as_str().unwrap().contains(SENTINEL));
        // The failed second ask: its error message holds no text either.
        let b = ask(&e.core, json!({ "question": question })).await.unwrap();
        run_jobs(&e.core).await;
        let failed = job(&e.core, &b["jobId"]);
        assert_eq!(failed.error_code.as_deref(), Some("invalid_output"));

        let runs = ai_runs(&e.core);
        assert_eq!(runs.len(), 2);
        for run in runs {
            let text = serde_json::to_string(&run).unwrap();
            assert!(!text.contains(SENTINEL), "the ledger: {text}");
        }
        let jobs = serde_json::to_string(&jobs(&e.core)).unwrap();
        assert!(!jobs.contains(SENTINEL), "the jobs: {jobs}");
        for args in calls_of(&voice, "facts") {
            assert!(!args.to_string().contains("What about"), "{args}");
        }
        // Log lines carry codes and counts only: none of them formats a text.
        for line in include_str!("ops.rs").lines().map(str::trim) {
            if line.starts_with("log::") || line.starts_with("eprintln!") {
                for word in ["question", "answer.answer", "searched", "text", "context"] {
                    assert!(!line.contains(word), "{line}");
                }
            }
        }
    }

    fn bump_policy(core: &Core) {
        let mut r = core.repo().unwrap();
        let mut w = r.workspace("personal").unwrap();
        // A scope change moves the workspace's access revision (Repository::save_workspace).
        w.sources = json!({"all": false, "mail": true, "chats": [], "calendars": []});
        r.save_workspace(&w).unwrap();
    }

    #[tokio::test]
    async fn a_system_cancel_settles_the_turn() {
        // Queued: the access changes before the job runs.
        let e = env(vec![Ok(cited())]);
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        bump_policy(&e.core);
        run_jobs(&e.core).await;
        assert_eq!(job(&e.core, &a["jobId"]).state, "cancelled");
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        assert_eq!(turn.state, TurnState::Failed, "{turn:?}");
        let error = turn.error.unwrap();
        assert_eq!(error.code, "cancelled");
        assert!(!error.message.is_empty());
        assert!(e.fake.calls().is_empty());

        // Running: the access changes while Claude works; the answer is not kept.
        let (runner, gate) = FakeRunner::gated(vec![Ok(cited())]);
        let e = env_with(Arc::new(runner));
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        let core = e.core.clone();
        run_next_with(&e.core, &gate, || async move { bump_policy(&core) }).await;
        assert_eq!(job(&e.core, &a["jobId"]).state, "cancelled");
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        assert_eq!(turn.state, TurnState::Failed, "{turn:?}");
        assert_eq!(turn.answer, None);
        assert_eq!(turn.error.unwrap().code, "cancelled");
    }

    #[tokio::test]
    async fn stop_works_after_a_workspace_switch() {
        let e = env(vec![]);
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        {
            let mut r = e.core.repo().unwrap();
            let mut other = r.workspace("personal").unwrap();
            other.id = "w2".into();
            other.name = "Other".into();
            other.is_default = false;
            r.save_workspace(&other).unwrap();
        }
        let mut stop = mutation(&e.core, Operation::JobCancel, json!({ "id": a["jobId"] }));
        stop.workspace_id = Some("w2".into());
        e.core.request(stop).await.unwrap();
        assert_eq!(job(&e.core, &a["jobId"]).state, "cancelled");
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        assert_eq!(turn.state, TurnState::Stopped);
    }

    #[tokio::test]
    async fn ids_are_never_reused_after_a_failed_or_stopped_turn() {
        let e = env(vec![failure(
            ErrorClass::NeedsLogin,
            "Claude is not signed in.",
        )]);
        put(
            &e.core,
            mail("msg-1", now() - 3_600, "The Atlas budget is due Friday."),
        );
        let a = ask(
            &e.core,
            json!({"question": "When is the Atlas budget due?"}),
        )
        .await
        .unwrap();
        run_jobs(&e.core).await;
        let t = thread_of(&e.core, a["threadId"].as_str().unwrap()).unwrap();
        assert_eq!(t.turns[0].state, TurnState::Failed);
        assert_eq!(t.next_ref, 2, "m1 was handed out");

        let (runner, gate) = FakeRunner::gated(vec![Ok(cited())]);
        let e = env_with(Arc::new(runner));
        put(
            &e.core,
            mail("msg-1", now() - 3_600, "The Atlas budget is due Friday."),
        );
        let a = ask(
            &e.core,
            json!({"question": "When is the Atlas budget due?"}),
        )
        .await
        .unwrap();
        let core = e.core.clone();
        let jid = a["jobId"].clone();
        run_next_with(&e.core, &gate, || async move {
            op(&core, Operation::JobCancel, json!({ "id": jid }))
                .await
                .unwrap();
        })
        .await;
        let t = thread_of(&e.core, a["threadId"].as_str().unwrap()).unwrap();
        assert_eq!(t.turns[0].state, TurnState::Stopped);
        assert_eq!(t.next_ref, 2, "m1 was handed out");
    }

    #[tokio::test]
    async fn the_cap_of_50_holds_after_ask_start() {
        let e = env(vec![]);
        let at = now() - 60;
        for n in 0..store::MAX_THREADS {
            let at = at - n as i64;
            store::write(
                &mut e.core.repo().unwrap(),
                &thread(
                    &format!("ask-{n:02}"),
                    at,
                    vec![turn(1, at, "Q?", TurnState::Done)],
                ),
            )
            .unwrap();
        }
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        let left = store::list(&e.core.repo().unwrap()).unwrap();
        assert_eq!(left.len(), store::MAX_THREADS);
        assert_eq!(left[0].id, a["threadId"].as_str().unwrap());
        assert!(left.iter().all(|t| t.id != "ask-49"), "the oldest went");
    }

    #[tokio::test]
    async fn an_ask_left_running_by_a_previous_run_is_stopped_not_rerun() {
        // Start-up: a job claimed before Connect quit (Repository::open puts it back to queued).
        let e = env(vec![Ok(cited())]);
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        {
            let mut r = e.core.repo().unwrap();
            let mut j = r.claim(now()).unwrap().unwrap();
            j.state = "queued".into();
            j.lease_until = None;
            r.save_job(&j).unwrap();
        }
        assert_eq!(e.core.ask_startup().unwrap(), 1);
        let j = job(&e.core, &a["jobId"]);
        assert_eq!(j.state, "cancelled");
        assert_eq!(
            j.result.as_deref(),
            Some("Connect stopped before it answered.")
        );
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        assert_eq!(turn.state, TurnState::Stopped);
        run_jobs(&e.core).await;
        assert!(e.fake.calls().is_empty(), "never run again");

        // A claim whose lease ran out is not run a second time either.
        let e = env(vec![Ok(cited())]);
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        {
            let mut r = e.core.repo().unwrap();
            let mut j = r.claim(now()).unwrap().unwrap();
            j.lease_until = Some(now() - 1);
            r.save_job(&j).unwrap();
        }
        run_jobs(&e.core).await;
        assert!(e.fake.calls().is_empty(), "never run again");
        let j = job(&e.core, &a["jobId"]);
        assert_eq!(j.state, "cancelled");
        let turn = thread_of(&e.core, a["threadId"].as_str().unwrap())
            .unwrap()
            .turns[0]
            .clone();
        assert_eq!(turn.state, TurnState::Stopped);
    }

    #[tokio::test]
    async fn job_retry_is_refused_for_an_ask() {
        let e = env(vec![failure(
            ErrorClass::NeedsLogin,
            "Claude is not signed in.",
        )]);
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        run_jobs(&e.core).await;
        let refused = op(&e.core, Operation::JobRetry, json!({ "id": a["jobId"] }))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "validation");
        assert_ne!(job(&e.core, &a["jobId"]).state, "queued");
    }

    #[tokio::test]
    async fn a_voice_delete_during_the_run_leaks_no_people() {
        let e = env(vec![Ok(outcome(
            json!({"answer": "Not in Connect.", "cites": [], "actions": []}),
        ))]);
        let voice = ready_voice(&e.core, "");
        voice.answer("facts", json!({"facts": []}));
        voice.delay("facts", Duration::from_millis(400));
        ask(&e.core, json!({"question": "What does Marek Novak own?"}))
            .await
            .unwrap();
        let core = e.core.clone();
        let deleting = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            core.voice_epoch
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        run_jobs(&e.core).await;
        deleting.await.unwrap();
        let context = context_of(&e.fake.calls()[0]);
        assert!(!context.contains("kind=\"person\""), "{context}");

        // Without a delete, the same question reads Marek's page.
        let e = env(vec![Ok(outcome(
            json!({"answer": "Not in Connect.", "cites": [], "actions": []}),
        ))]);
        let voice = ready_voice(&e.core, "");
        voice.answer("facts", json!({"facts": []}));
        ask(&e.core, json!({"question": "What does Marek Novak own?"}))
            .await
            .unwrap();
        run_jobs(&e.core).await;
        let context = context_of(&e.fake.calls()[0]);
        assert!(context.contains("kind=\"person\""), "{context}");
    }

    /// `ask-thread.json` (an `ask_read` answer: a done turn with cites of every kind, three
    /// actions, `searched` and `cut`; a failed turn; a stopped turn), `job-ask-running.json` and
    /// `job-ask-failed.json`. Regenerate with `UPDATE_CONTRACT_FIXTURES=1 cargo test
    /// contract_fixtures`.
    #[tokio::test]
    async fn contract_fixtures_match_the_ask_thread_and_jobs() {
        use super::super::store::{Cite, RefItem, TurnError};
        const AT: i64 = 1_795_000_400;
        let cite = |id: &str, kind: &str, record: &str, label: &str| Cite {
            id: id.into(),
            kind: kind.into(),
            record_id: Some(record.into()),
            label: Some(label.into()),
            title: None,
        };
        let mut done = turn(
            1,
            AT - 120,
            "What did I promise Priya this week?",
            TurnState::Done,
        );
        done.about = Some(RefItem {
            kind: "message".into(),
            record_id: "msg-17".into(),
            label: "Priya N. · mail · Tue 24 Nov".into(),
            gone: false,
        });
        done.answer = Some("You promised Priya the **Atlas budget** by Fri 27 Nov [a1] [t2].\n\n- The QBR is on Fri 27 Nov at 10:00 [e3]; Jordan Lee asked for the deck [m4].\n- The rollout plan was agreed on Thu 20 Nov [n5]; Marek Novak owns it [p6].\n- Likely on track, from [f7].".into());
        done.cites = vec![
            cite("a1", "message", "msg-17", "Priya N. · mail · Tue 24 Nov"),
            cite("t2", "task", "task-3", "Task · Send the Atlas budget"),
            cite("e3", "event", "ev-9", "Event · Fri 27 Nov 10:00 · QBR"),
            cite("m4", "message", "msg-21", "Jordan Lee · Teams · Wed 25 Nov"),
            cite("n5", "meeting", "ev-4", "Meeting · Atlas sync · Thu 20 Nov"),
            cite(
                "p6",
                "person",
                "00000000-0000-4000-8000-00000000a003",
                "Person · Marek Novak",
            ),
            Cite {
                id: "f7".into(),
                kind: "fact".into(),
                record_id: None,
                label: None,
                title: Some("Atlas rollout".into()),
            },
        ];
        done.actions = vec![
            json!({"kind": "task", "text": "Send Priya the Atlas budget", "due": "2026-11-27"}),
            json!({"kind": "open", "ref": "e3", "recordId": "ev-9", "label": "Event · Fri 27 Nov 10:00 · QBR"}),
            json!({"kind": "draft", "ref": "m4", "recordId": "msg-21", "label": "Jordan Lee · Teams · Wed 25 Nov", "hint": "Say the deck comes Thursday."}),
        ];
        done.searched = Some("tasks 12 (Todoist) · events 7, Thu 19 Nov – Thu 3 Dec · messages 9 · meetings 2 · people 1 · facts 1 (Knowledge)".into());
        done.cut = true;
        done.took = Some(14);
        done.profile = Some("claude".into());
        done.model = Some("claude-sonnet-4-5".into());
        done.job_id = Some("job-1".into());
        let mut failed = turn(2, AT - 60, "And Jordan Lee?", TurnState::Failed);
        failed.error = Some(TurnError {
            code: "needs_login".into(),
            message: "CodeMie is not signed in.".into(),
        });
        failed.profile = Some("codemie:prod".into());
        failed.fell_back_from = Some("claude".into());
        failed.job_id = Some("job-2".into());
        let mut stopped = turn(3, AT, "Who is Marek Novak?", TurnState::Stopped);
        stopped.profile = Some("claude".into());
        stopped.job_id = Some("job-3".into());
        let mut t = thread("ask-7f2c", AT, vec![done, failed, stopped]);
        t.next_ref = 8;

        let e = env(vec![]);
        store::write(&mut e.core.repo().unwrap(), &t).unwrap();
        let answer = read(&e.core, "ask-7f2c").await.unwrap();
        assert_eq!(answer["turns"].as_array().unwrap().len(), 3);
        assert_eq!(answer["turns"][0]["cites"].as_array().unwrap().len(), 7);
        crate::plugins::testkit::contract_fixture("ask-thread.json", &answer);

        // The jobs, from real runs: one held while Claude works, one that failed.
        let pin_job = |j: Job, n: usize| {
            let mut v = serde_json::to_value(j).unwrap();
            v["id"] = format!("job-{n}").into();
            v["key"] = "ask:ask-7f2c".into();
            v["dueAt"] = AT.into();
            v["payload"]["threadId"] = "ask-7f2c".into();
            v["payload"]["startedAt"] = (AT + 1).into();
            if v["leaseUntil"].is_i64() {
                v["leaseUntil"] = (AT + 300).into();
            }
            v
        };
        let (runner, gate) = FakeRunner::gated(vec![Ok(cited())]);
        let e = env_with(Arc::new(runner));
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        let mut running = None;
        let core = e.core.clone();
        let jid = a["jobId"].clone();
        let slot = &mut running;
        run_next_with(&e.core, &gate, || async move {
            *slot = Some(job(&core, &jid));
        })
        .await;
        let running = running.unwrap();
        assert_eq!(running.state, "running");
        assert_eq!(running.payload["profile"], "claude");

        let e = env(vec![failure(
            ErrorClass::NeedsLogin,
            "Claude is not signed in.",
        )]);
        let a = ask(&e.core, json!({"question": "When is the QBR?"}))
            .await
            .unwrap();
        run_jobs(&e.core).await;
        let failed = job(&e.core, &a["jobId"]);
        assert_eq!(failed.error_code.as_deref(), Some("needs_login"));
        crate::plugins::testkit::contract_fixture("job-ask-running.json", &pin_job(running, 2));
        crate::plugins::testkit::contract_fixture("job-ask-failed.json", &pin_job(failed, 3));
    }
}
