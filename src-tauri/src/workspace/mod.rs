//! Personal Workspace domain. Installer orchestration continues to belong to the existing JS Engine.
mod actions;
mod ai;
mod ai_jobs;
mod automations;
mod credentials;
#[cfg(target_os = "macos")]
mod curl;
pub mod geometry;
pub mod graph;
mod inbox;
pub(crate) mod markdown;
pub mod meetings;
pub mod models;
mod paths;
pub(crate) mod plugin_data;
mod prompts;
pub mod repository;
pub mod schedules;
mod slots;
pub(crate) mod tasks;
mod today;

use crate::ai::{
    profiles::{DetectEnv, ProfileCache},
    runner::{ClaudeRunner, CliRunner},
};
use crate::storage::location::Resolved;
use models::*;
use paths::{acquire_lock, Lock, LOCK_WAIT};
pub use paths::{startup, CorePaths};
pub use plugin_data::EventSink;
use repository::Repository;
use serde_json::{json, Value};
use std::{
    fs::File,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio_util::sync::CancellationToken;

pub struct WorkspaceState {
    pub core: Option<Arc<Core>>,
    /// Why a ready data folder did not open (another Connect owns it, a newer schema, a disk error).
    pub error: Option<String>,
    /// Where startup looked for the data and what it found (DESIGN 8).
    pub resolved: Resolved,
    /// Held by one restart, data-folder change or old-copy removal at a time.
    pub folder_guard: crate::storage::commands::FolderGuard,
}

pub struct Core {
    repository: Mutex<Repository>,
    pub paths: CorePaths,
    owner_lock: File,
    /// Held inside a custom data folder, so two Macs can't share one drive.
    connect_lock: Option<File>,
    /// `None` only in unit tests, which have no webview runtime.
    app: Option<tauri::AppHandle>,
    pub auth_attempt: tokio::sync::Mutex<Option<String>>,
    pub auth_error: tokio::sync::Mutex<Option<String>>,
    pub session: tokio::sync::Mutex<graph::Session>,
    pub sync_lock: tokio::sync::Mutex<()>,
    /// Runs Claude for every AI feature (the CLI runner in production).
    runner: Arc<dyn ClaudeRunner>,
    /// Detected Claude profiles, cached for 30 s.
    profiles: ProfileCache,
    /// Cancelled when the app quits, so no Claude process outlives it.
    ai_cancel: CancellationToken,
    /// Job id -> the token of its Claude run, so Stop (`job_cancel`) ends the run at once.
    ai_jobs: Mutex<std::collections::HashMap<String, CancellationToken>>,
    /// The Microsoft reads an AI run makes (full Outlook text); faked in tests.
    graph_reads: Arc<dyn ai_jobs::GraphReads>,
    graph_children: Mutex<std::collections::HashMap<String, tokio::process::Child>>,
    /// `{connectionId}:{calendarId}` -> last full calendarView refresh (unix seconds).
    calendar_refreshed: Mutex<std::collections::HashMap<String, i64>>,
    mutations: tokio::sync::Mutex<()>,
    pub stop: AtomicBool,
    pub installer_busy: AtomicBool,
    /// Set by `quiesce` while the data folder changes: the loop claims nothing and Microsoft
    /// reads stop. Unlike `stop`, `resume` lifts it.
    hold: AtomicBool,
    /// The database is closed for a data-folder change; requests are refused until `resume`.
    paused: AtomicBool,
    /// The background loop is in the middle of a round (claiming jobs, queueing a sync).
    loop_busy: AtomicBool,
    /// Claimed jobs whose executors have not finished.
    jobs_in_flight: AtomicUsize,
    /// `plugins_request` calls running (installs write into the data folder).
    plugin_ops: AtomicUsize,
    /// Where plugins hear what happened (`plugin_data`), once the plugin manager has started.
    events: std::sync::OnceLock<Arc<dyn EventSink>>,
    /// The meetings plugins were told of (`meeting_soon`), with their start.
    meetings_told: Mutex<std::collections::HashMap<String, i64>>,
    /// Held by one writer of meeting records and transcript files at a time
    /// (`Core::meeting_lock`).
    meeting_writes: Mutex<()>,
    /// The user's home folder, where the default meetings root lives. Tests use a folder inside
    /// their temp data folder, so they never write into the real home.
    home: Option<PathBuf>,
}

fn poisoned() -> WorkspaceError {
    WorkspaceError::new("storage", "Workspace storage needs an application restart.")
}

/// A data-folder change must not cut off a send on its way to Microsoft: its outcome would
/// be lost with the closed database.
fn refuse_while_sending(repo: &Repository) -> Result<()> {
    if repo.dispatching_actions()? > 0 {
        return Err(WorkspaceError::new(
            "busy",
            "A message is being sent. Wait for it to finish, then try again.",
        ));
    }
    Ok(())
}

/// Counts a claimed job as running until its executor is done.
struct InFlight(Arc<Core>);
impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.jobs_in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Counts a plugin request as running until it is dropped, so a data-folder change waits for it.
pub struct PluginOp(Arc<Core>);
impl Drop for PluginOp {
    fn drop(&mut self) {
        self.0.plugin_ops.fetch_sub(1, Ordering::SeqCst);
    }
}
impl Core {
    pub fn open(app: tauri::AppHandle, paths: &CorePaths) -> Result<Arc<Self>> {
        // The bundled `codemie-claude` shim is searched after the user's own install.
        let extra_dirs: Vec<PathBuf> = app
            .path()
            .resource_dir()
            .map(|d| vec![d.join("bin")])
            .unwrap_or_default();
        let env = DetectEnv::system(extra_dirs.clone());
        Self::open_with(
            Some(app),
            paths,
            Arc::new(CliRunner::new(env)),
            ProfileCache::system(extra_dirs),
            Arc::new(ai_jobs::LiveGraph),
        )
    }
    fn open_with(
        app: Option<tauri::AppHandle>,
        paths: &CorePaths,
        runner: Arc<dyn ClaudeRunner>,
        profiles: ProfileCache,
        graph_reads: Arc<dyn ai_jobs::GraphReads>,
    ) -> Result<Arc<Self>> {
        // Only the private folder is created and made owner-only. A custom data folder is the
        // user's: it is never created or chmodded here.
        std::fs::create_dir_all(&paths.private)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&paths.private, std::fs::Permissions::from_mode(0o700))?;
        }
        let owner_lock = acquire_lock(&paths.private.join("owner.lock"), Lock::Owner, LOCK_WAIT)?;
        let connect_lock = if paths.custom() {
            Some(acquire_lock(
                &paths.data.join("connect.lock"),
                Lock::DataFolder,
                LOCK_WAIT,
            )?)
        } else {
            None
        };
        // Earlier builds left `graph-read-*.headers` files in what is now the private folder.
        #[cfg(target_os = "macos")]
        curl::cleanup(&paths.private);
        #[cfg(not(any(test, feature = "test-support")))]
        let home = paths::home_dir();
        #[cfg(any(test, feature = "test-support"))]
        let home = Some(paths.data.join("home"));
        Ok(Arc::new(Self {
            repository: Mutex::new(Repository::open(&paths.database())?),
            paths: paths.clone(),
            owner_lock,
            connect_lock,
            app,
            auth_attempt: Default::default(),
            auth_error: Default::default(),
            session: Default::default(),
            sync_lock: Default::default(),
            runner,
            profiles,
            ai_cancel: CancellationToken::new(),
            ai_jobs: Default::default(),
            graph_reads,
            graph_children: Default::default(),
            calendar_refreshed: Default::default(),
            mutations: Default::default(),
            stop: AtomicBool::new(false),
            installer_busy: AtomicBool::new(false),
            hold: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            loop_busy: AtomicBool::new(false),
            jobs_in_flight: AtomicUsize::new(0),
            plugin_ops: AtomicUsize::new(0),
            events: std::sync::OnceLock::new(),
            meetings_told: Default::default(),
            meeting_writes: Default::default(),
            home,
        }))
    }
    /// Counts a plugin request as running, or refuses it while the workspace is held for a
    /// data-folder change. Counted before `hold` is read, and `quiesce` sets `hold` before it
    /// reads the count: one of the two always sees the other.
    pub fn begin_plugin_op(self: &Arc<Self>) -> Result<PluginOp> {
        self.plugin_ops.fetch_add(1, Ordering::SeqCst);
        let op = PluginOp(self.clone());
        if self.is_held() {
            return Err(WorkspaceError::new(
                "busy",
                "Connect is changing its data folder. Try again in a moment.",
            ));
        }
        Ok(op)
    }
    /// Holds the workspace still for a data-folder change: the loop stops claiming jobs,
    /// Microsoft reads and running AI jobs are cancelled (drafts and summaries can be asked for
    /// again), the remaining jobs finish, then the database is checkpointed and closed. Only a
    /// send on its way to Microsoft refuses it; `wait` is a safety net for work that ignores
    /// cancellation. A refusal leaves everything running. Blocking: call it off the async runtime.
    pub fn quiesce(&self, wait: Duration) -> Result<()> {
        // The decision comes first: nothing is stopped or cancelled while a send is under way.
        refuse_while_sending(&*self.repo()?)?;
        self.hold.store(true, Ordering::SeqCst);
        self.kill_graph_reads();
        let result = self.close_when_idle(Instant::now() + wait);
        if result.is_err() {
            self.hold.store(false, Ordering::SeqCst);
        }
        result
    }
    fn close_when_idle(&self, deadline: Instant) -> Result<()> {
        let still_working = || {
            WorkspaceError::new(
                "busy",
                "Connect couldn’t stop its background work. Try again in a minute.",
            )
        };
        // A plugin install writes into the data folder: it finishes first (new ones are refused
        // while `hold` is set).
        while self.plugin_ops.load(Ordering::SeqCst) > 0 {
            if Instant::now() >= deadline {
                return Err(WorkspaceError::new(
                    "busy",
                    "Plugins are being installed — try again in a moment.",
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        // `hold` is set before `loop_busy` is read, and the loop sets `loop_busy` before it reads
        // `hold`, so once both read idle no new round can claim a job.
        while self.loop_busy.load(Ordering::SeqCst)
            || self.jobs_in_flight.load(Ordering::SeqCst) > 0
        {
            // On every pass: a draft that registers its Claude run late is stopped too.
            self.cancel_ai_runs();
            if Instant::now() >= deadline {
                return Err(still_working());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        // An edit that is writing finishes first; one that starts later finds the database closed.
        let _edits = loop {
            match self.mutations.try_lock() {
                Ok(guard) => break guard,
                Err(_) if Instant::now() >= deadline => return Err(still_working()),
                Err(_) => std::thread::sleep(Duration::from_millis(25)),
            }
        };
        // Checked again under the database lock: a send marks itself `dispatching` under this
        // lock, so none can start between the check and the close.
        let mut repo = self.repo()?;
        refuse_while_sending(&repo)?;
        repo.close();
        self.paused.store(true, Ordering::SeqCst);
        Ok(())
    }
    /// Stops every running Claude run of a job; each job then ends as `cancelled`.
    fn cancel_ai_runs(&self) {
        if let Ok(runs) = self.ai_jobs.lock() {
            for cancel in runs.values() {
                cancel.cancel();
            }
        }
    }
    /// Undoes `quiesce` after a data-folder change failed: reopens the database and lets
    /// background work run again. A database that has gone away is never recreated empty: that
    /// reads as `storage_unavailable` and the workspace stays held.
    pub fn resume(&self) -> Result<()> {
        {
            let mut repo = self.repository.lock().map_err(|_| poisoned())?;
            if self.paused.load(Ordering::SeqCst) {
                *repo = Repository::open_existing(&self.paths.database())?;
                self.paused.store(false, Ordering::SeqCst);
            }
        }
        self.hold.store(false, Ordering::SeqCst);
        Ok(())
    }
    /// Whether a data-folder change holds the workspace (`quiesce` without `resume`).
    pub(crate) fn is_held(&self) -> bool {
        self.hold.load(Ordering::SeqCst) || self.paused.load(Ordering::SeqCst)
    }
    /// Microsoft reads stop when Connect quits or holds still for a data-folder change.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn stopping(&self) -> bool {
        self.stop.load(Ordering::Relaxed) || self.hold.load(Ordering::SeqCst)
    }
    /// Before a restart: stops background work, closes the database and lets go of both locks so
    /// the next process can take over at once. Best effort; the OS frees them on exit anyway.
    pub fn release_for_restart(&self) {
        self.stop_background();
        if let Ok(mut repo) = self.repository.lock() {
            repo.close();
        }
        let _ = fs2::FileExt::unlock(&self.owner_lock);
        if let Some(lock) = &self.connect_lock {
            let _ = fs2::FileExt::unlock(lock);
        }
    }
    pub fn stop_background(&self) {
        self.stop.store(true, Ordering::Relaxed);
        self.ai_cancel.cancel();
        self.kill_graph_reads();
        #[cfg(target_os = "macos")]
        curl::cleanup(&self.paths.private);
    }
    fn kill_graph_reads(&self) {
        if let Ok(mut children) = self.graph_children.lock() {
            for (_, mut child) in children.drain() {
                let _ = child.start_kill();
            }
        }
    }
    fn cancel_graph_job(&self, jid: &str) {
        if let Ok(mut children) = self.graph_children.lock() {
            let prefix = format!("{jid}:");
            let keys = children
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            for key in keys {
                if let Some(mut child) = children.remove(&key) {
                    let _ = child.start_kill();
                }
            }
        }
    }
    fn app(&self) -> Result<&tauri::AppHandle> {
        self.app
            .as_ref()
            .ok_or_else(|| WorkspaceError::new("io", "This action needs the application window."))
    }
    pub fn repo(&self) -> Result<MutexGuard<'_, Repository>> {
        let repo = self.repository.lock().map_err(|_| poisoned())?;
        // Read under the lock, so a request never sees the database `quiesce` just closed.
        if self.paused.load(Ordering::SeqCst) {
            return Err(WorkspaceError::new(
                "busy",
                "Connect is changing its data folder and will restart in a moment.",
            ));
        }
        Ok(repo)
    }
    pub fn emit(&self, event: &str) {
        if let Some(app) = &self.app {
            let _ = app.emit(event, json!({"changed":true}));
        }
    }
    pub fn start(self: &Arc<Self>) {
        let Some(app) = self.app.clone() else { return };
        geometry::restore(&app, &self.paths.private);
        let click_app = app.clone();
        let _ = app.notification().on_action(move |action| {
            if action.action_id() == "dismiss" {
                return;
            }
            if let Some(notification) = action.notification() {
                let extra = notification.extra();
                if let Some(state) = click_app.try_state::<WorkspaceState>() {
                    if state.core.is_some() {
                        let _ = click_app.emit(
                            "workspace:notification-open",
                            notification_open_payload(extra),
                        );
                    }
                }
            }
            if let Some(w) = click_app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        });
        let core = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut last_sync = 0;
            let mut ticks = 0;
            while !core.stop.load(Ordering::Relaxed) {
                // Busy before `hold` is read: `quiesce` waits for the round to end.
                core.loop_busy.store(true, Ordering::SeqCst);
                if !core.hold.load(Ordering::SeqCst) {
                    core.background_round(&mut last_sync, &mut ticks);
                }
                core.loop_busy.store(false, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });
    }
    /// One round of the background loop: due schedules, ready jobs, the periodic sync (see
    /// [`sync_interval`]).
    fn background_round(self: &Arc<Self>, last_sync: &mut i64, ticks: &mut u64) {
        let _ = self.materialize_schedules();
        if ticks.is_multiple_of(automations::ROUND_TICKS) {
            if let Err(e) = self.automations_round() {
                eprintln!("automations: schedule round failed: {}", e.message);
            }
            if let Err(e) = meetings::meetings_round_at(self, now()) {
                eprintln!("meetings: transcript round failed: {}", e.message);
            }
        }
        for _ in 0..8 {
            let job = {
                let Ok(mut repo) = self.repo() else { break };
                let jobs = repo.jobs().unwrap_or_default();
                if jobs
                    .iter()
                    .filter(|j| j.state == "running" && j.lease_until.unwrap_or(0) > now())
                    .count()
                    >= 8
                {
                    break;
                }
                let allow_sync = !jobs.iter().any(|j| {
                    j.kind == "sync" && j.state == "running" && j.lease_until.unwrap_or(0) > now()
                });
                repo.claim_ready(now(), allow_sync).ok().flatten()
            };
            let Some(job) = job else { break };
            self.spawn_claimed(job);
        }
        let visible = self
            .app
            .as_ref()
            .and_then(|a| a.get_webview_window("main"))
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
        if now() - *last_sync > sync_interval(self.repo().and_then(|r| r.settings()).ok(), visible)
        {
            *last_sync = now();
            let _ = self.queue_sync();
        }
        if ticks.is_multiple_of(30) {
            self.announce_meetings(now());
        }
        *ticks += 1;
        // Views keep their own clocks; this only nudges an idle window to pick up
        // background changes that did not emit an event of their own.
        if ticks.is_multiple_of(60) {
            self.emit("workspace:changed");
        }
    }
    /// Runs a claimed job in the background, counted until its executor is done so `quiesce`
    /// waits for it.
    fn spawn_claimed(self: &Arc<Self>, job: Job) {
        self.jobs_in_flight.fetch_add(1, Ordering::SeqCst);
        let running = InFlight(self.clone());
        let executor = self.clone();
        tauri::async_runtime::spawn(async move {
            executor.run_claimed_job(job).await;
            drop(running);
        });
    }
    async fn run_claimed_job(self: Arc<Self>, job: Job) {
        let result = {
            let execute = self.execute_job(&job);
            tokio::pin!(execute);
            let mut pulse = tokio::time::interval(std::time::Duration::from_secs(15));
            loop {
                tokio::select! {
                    result=&mut execute=>break result,
                    _=pulse.tick()=>{
                        let valid=if let Ok(mut repo)=self.repo(){
                            let current=repo.jobs().ok().and_then(|jobs|jobs.into_iter().find(|j|j.id==job.id));
                            if let Some(mut current)=current.filter(|j|j.state=="running"&&j.attempts==job.attempts){
                                if repo.check_policy(job.workspace_id.as_deref(),job.connection_id.as_deref(),&job.policy).is_ok(){current.lease_until=Some(now()+300);repo.save_job(&current).is_ok()}else{false}
                            }else{false}
                        }else{false};
                        if !valid {break Err(WorkspaceError::new("cancelled","Job was cancelled or its access changed."));}
                    }
                }
            }
        };
        if let Ok(mut repo) = self.repo() {
            // The stored copy, so progress the executor saved (AI run details) is kept.
            if let Some(mut job) = repo
                .jobs()
                .ok()
                .and_then(|jobs| jobs.into_iter().find(|j| j.id == job.id))
                .filter(|j| j.state == "running" && j.attempts == job.attempts)
            {
                match result {
                    Ok(message) => {
                        job.state = "succeeded".into();
                        job.result = Some(message);
                        job.error_class = None;
                        job.error_code = None;
                    }
                    Err(e) => {
                        job.state = if e.code == "cancelled" {
                            "cancelled"
                        } else if matches!(
                            e.code.as_str(),
                            "needs_login" | "permission_required" | "ai_unavailable"
                        ) {
                            "blocked"
                        } else {
                            "failed"
                        }
                        .into();
                        job.result = Some(e.message);
                        job.error_class = e.class;
                        job.error_code = Some(e.code);
                    }
                }
                job.lease_until = None;
                let _ = repo.save_job(&job);
            }
        }
        self.emit("workspace:changed");
    }
    pub fn queue_sync(&self) -> Result<()> {
        self.queue_sync_with(false)
    }
    /// `force` (user refresh, sources change, sign-in) bypasses the per-calendar refresh interval.
    pub fn queue_sync_with(&self, force: bool) -> Result<()> {
        let mut r = self.repo()?;
        let s = r.settings()?;
        if let Some(cid) = s.active_connection {
            let c = r.connection(&cid)?;
            if c.status != "connected" {
                return Ok(());
            }
            let current = r.policy(None, Some(&cid))?;
            let jobs = r.jobs()?;
            let pending = |state: &str| {
                jobs.iter().find(|j| {
                    j.kind == "sync"
                        && j.connection_id.as_deref() == Some(&cid)
                        && j.policy == current
                        && j.state == state
                })
            };
            if let Some(queued) = pending("queued") {
                if force && queued.payload["force"] != true {
                    let mut queued = queued.clone();
                    queued.payload["force"] = true.into();
                    r.save_job(&queued)?;
                }
                return Ok(());
            }
            // A running round may already be past its calendars; a forced request queues behind it.
            if pending("running").is_some() && !force {
                return Ok(());
            }
            let key = format!("sync:{cid}:{}", id());
            r.enqueue(&new_job(
                "sync",
                key,
                None,
                Some(cid),
                now(),
                current,
                json!({"force":force}),
            ))?;
        }
        Ok(())
    }
    async fn execute_job(self: &Arc<Self>, job: &Job) -> Result<String> {
        self.repo()?.check_policy(
            job.workspace_id.as_deref(),
            job.connection_id.as_deref(),
            &job.policy,
        )?;
        match job.kind.as_str() {
            "sync" => {
                let cid = job
                    .connection_id
                    .as_deref()
                    .ok_or_else(|| WorkspaceError::new("validation", "Missing connection."))?;
                let mut c = self.repo()?.connection(cid)?;
                c.job_fence = Some((job.id.clone(), job.attempts));
                let started = now();
                self.sync(c, job.payload["force"] == true).await?;
                self.refresh_incidents()?;
                // Plugins hear once per round which sources changed.
                self.after_sync_round(started);
                // New messages may start automations; a failure here must not fail the sync.
                if let Err(e) = self.automations_after_sync() {
                    eprintln!("automations: matching new messages failed: {}", e.message);
                }
                Ok("Sources refreshed".into())
            }
            "calendar_window" => {
                let wid = job.workspace_id.as_deref().ok_or_else(|| {
                    WorkspaceError::new("cancelled", "Calendar workspace is unavailable.")
                })?;
                let cid = job
                    .connection_id
                    .as_deref()
                    .ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?;
                let (calendars, mut c) = {
                    let r = self.repo()?;
                    let w = r.workspace(wid)?;
                    (r.workspace_calendars(&w, cid), r.connection(cid)?)
                };
                c.job_fence = Some((job.id.clone(), job.attempts));
                let start = job.payload["start"].as_i64().unwrap_or(0);
                let end = job.payload["end"].as_i64().unwrap_or(0);
                // One shared or removed calendar must not block the others: keep every window that
                // completed and fail only when none did.
                let mut failed = Vec::new();
                for cal in &calendars {
                    if let Err(error) = self.sync_calendar(&c, cal, Some((start, end))).await {
                        if error.code == "cancelled" {
                            return Err(error);
                        }
                        failed.push(error);
                    }
                }
                match failed.len() {
                    0 => Ok("Calendar window refreshed".into()),
                    n if n == calendars.len() => Err(failed.remove(0)),
                    n => Ok(format!(
                        "Calendar window refreshed; {n} calendar(s) unavailable"
                    )),
                }
            }
            "ai_draft" => self.run_ai_draft(job).await,
            "ai_summarize" => self.run_ai_summary(job).await,
            "reminder" | "notification" => self.deliver_notification(job),
            "automation_run" => self.run_automation(job).await,
            "transcript_check" => self.run_transcript_check(job).await,
            "transcript_download" => self.run_transcript_download(job).await,
            "meeting_notes" => self.run_meeting_notes(job).await,
            _ => Err(WorkspaceError::new("validation", "Unsupported job type.")),
        }
    }
    fn active_workspace(
        &self,
        request: &Request,
        provider: bool,
    ) -> Result<(Workspace, Option<Connection>)> {
        let r = self.repo()?;
        let wid = request
            .workspace_id
            .as_deref()
            .ok_or_else(|| WorkspaceError::new("validation", "Choose a workspace."))?;
        let w = r.workspace(wid)?;
        if w.archived {
            return Err(WorkspaceError::new(
                "archived",
                "Restore this workspace before changing it.",
            ));
        }
        let c = if provider {
            let cid = w.connection_id.as_deref().ok_or_else(|| {
                WorkspaceError::new(
                    "needs_login",
                    "Bind a Microsoft connection to this workspace in Settings.",
                )
            })?;
            let policy = r.policy(Some(wid), Some(cid))?;
            r.check_policy(Some(wid), Some(cid), &policy)?;
            Some(r.connection(cid)?)
        } else {
            None
        };
        Ok((w, c))
    }
    pub async fn request(self: &Arc<Self>, req: Request) -> Result<Value> {
        if req.op == Operation::Snapshot {
            let mut snapshot = self.repo()?.snapshot()?;
            // A setting, not account data: shown whatever the account may read.
            snapshot.meetings_root =
                self.meetings_root(&snapshot.settings.meetings)
                    .ok()
                    .map(|(path, is_default)| meetings::model::MeetingsRoot {
                        path: path.to_string_lossy().into_owned(),
                        is_default,
                    });
            snapshot.note_templates = meetings::templates::all(&snapshot.records);
            return Ok(
                json!({"snapshot":snapshot,"authPending":self.auth_attempt.lock().await.is_some(),"authError":self.auth_error.lock().await.clone()}),
            );
        }
        // Read-only: no operation id, no revision bump.
        if req.op == Operation::AiStatus {
            return self.ai_status(&req).await;
        }
        if req.op == Operation::AiUsage {
            return self.ai_usage(&req);
        }
        if req.op == Operation::AutomationRuns {
            return self.automation_runs(&req);
        }
        if req.op == Operation::MeetingRead {
            return self.meeting_read(&req);
        }
        if req.op == Operation::MeetingText {
            return self.meeting_text(&req);
        }
        if req.op == Operation::MeetingSkills {
            return self.meeting_skills();
        }
        // Shows a folder in Finder: nothing stored changes.
        if req.op == Operation::MeetingsReveal {
            return self.meetings_reveal(&req);
        }
        // Read-style: a Test can take a minute and must not queue other edits behind it. It
        // writes only its own `ai_run` record, so there is no operation id or revision fence.
        if req.op == Operation::AiTest {
            return self.ai_test(&req).await;
        }
        if req.op == Operation::GraphCancel {
            *self.auth_attempt.lock().await = None;
            return Ok(json!({"cancelled":true}));
        }
        if req.op == Operation::OpenSource {
            // A link in an automation's result: the address comes from the stored run.
            if req.data["kind"] == "automation_run" {
                let run = required(&req.data, "id", 200)?;
                let n = req.data["link"]
                    .as_i64()
                    .ok_or_else(|| WorkspaceError::new("validation", "Choose a link."))?;
                graph::open_url(&self.automation_run_link(run, n)?)?;
                return Ok(json!({"opened":true}));
            }
            let (w, c) = self.active_workspace(&req, true)?;
            let c = c.ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?;
            let kind = required(&req.data, "kind", 30)?;
            let rid = required(&req.data, "id", 2000)?;
            let record = self.repo()?.record(kind, rid, Some(&c.id), None)?;
            if !repository::record_selected(&record, &w) {
                return Err(WorkspaceError::new(
                    "permission_required",
                    "This source is not selected.",
                ));
            }
            let field = if req.data["join"].as_bool() == Some(true) {
                "joinUrl"
            } else {
                "url"
            };
            graph::open_url(required(&record.data, field, 8192)?)?;
            return Ok(json!({"opened":true}));
        }
        if req.op == Operation::Export {
            let snap = self.repo()?.snapshot()?;
            // User-owned content only. Provider bodies, account identity, tokens and AI-derived text are excluded.
            return Ok(
                json!({"version":1,"workspaces":snap.workspaces.iter().map(|w|json!({"id":w.id,"name":w.name,"layout":w.layout})).collect::<Vec<_>>(),"records":snap.records.into_iter().filter(|r|r.connection_id.is_none()&&matches!(r.kind.as_str(),"note"|"commitment"|"draft")).collect::<Vec<_>>()}),
            );
        }
        // Detection may probe the CLIs for many seconds; it must finish before the
        // mutation lock is taken so it never blocks other writes.
        let detected = if req.op == Operation::AiSettingsSave {
            self.profiles.profiles().await
        } else {
            Vec::new()
        };
        let synchronous = !matches!(
            req.op,
            Operation::GraphConnect
                | Operation::GraphDisconnect
                | Operation::SourcesMore
                | Operation::ActionPrepare
                | Operation::ActionConfirm
                | Operation::JobCancel
        );
        let _mutation_guard = if synchronous {
            Some(self.mutations.lock().await)
        } else {
            None
        };
        if !self.repo()?.check_request(&req)? {
            return self
                .repo()?
                .operation_result(req.operation_id.as_deref().unwrap_or(""));
        }
        let response = match req.op {
            Operation::WorkspaceCreate => {
                let name = required(&req.data, "name", 80)?;
                let mut r = self.repo()?;
                // New workspaces follow the signed-in account automatically.
                let connection_id = r
                    .settings()?
                    .active_connection
                    .filter(|cid| r.connection(cid).is_ok_and(|c| c.status == "connected"));
                let w = Workspace {
                    id: req.operation_id.clone().unwrap_or_else(id),
                    name: name.into(),
                    color: valid_color(req.data["color"].as_str().unwrap_or("#2297f6"))?,
                    archived: false,
                    is_default: false,
                    connection_id,
                    revision: 0,
                    access_revision: 0,
                    profile_revision: 0,
                    sources: json!({"all":true}),
                    layout: vec![
                        "brief".into(),
                        "calendar".into(),
                        "inbox".into(),
                        "commitments".into(),
                        "focus".into(),
                        "automations".into(),
                    ],
                    widget_widths: json!({}),
                    today: json!({}),
                };
                r.save_workspace(&w)?;
                let mut s = r.settings()?;
                s.active_workspace = w.id.clone();
                r.settings_update(&s)?;
                json!({"id":w.id})
            }
            Operation::WorkspaceUpdate | Operation::LayoutSave => {
                let wid = req
                    .workspace_id
                    .as_deref()
                    .ok_or_else(|| WorkspaceError::new("validation", "Choose a workspace."))?;
                let mut r = self.repo()?;
                let mut w = r.workspace(wid)?;
                if let Some(name) = req.data.get("name") {
                    w.name = required(&json!({"name":name}), "name", 80)?.into();
                }
                if let Some(archived) = req.data["archived"].as_bool() {
                    if w.is_default && archived {
                        return Err(WorkspaceError::new(
                            "validation",
                            "Personal is the default workspace and remains available.",
                        ));
                    }
                    w.archived = archived;
                }
                if let Some(color) = req.data["color"].as_str() {
                    w.color = valid_color(color)?;
                }
                if let Some(layout) = req.data["layout"].as_array() {
                    let values: Vec<_> = layout.iter().filter_map(Value::as_str).collect();
                    if values.len() != layout.len()
                        || values.len() > MAX_WIDGETS
                        || values.iter().any(|v| !valid_widget_id(v))
                    {
                        return Err(WorkspaceError::new("validation", "Invalid Today layout."));
                    }
                    let mut seen = std::collections::HashSet::new();
                    w.layout = values
                        .into_iter()
                        .filter(|s| seen.insert(*s))
                        .map(String::from)
                        .collect();
                }
                if let Some(t) = req.data.get("today") {
                    w.today = today::valid_today(t)?;
                }
                if let Some(widths) = req.data.get("widgetWidths") {
                    let widths = widths.as_object().ok_or_else(|| {
                        WorkspaceError::new("validation", "Invalid widget widths.")
                    })?;
                    if widths.len() > MAX_WIDGET_WIDTHS
                        || widths.iter().any(|(k, v)| {
                            !valid_widget_id(k) || !matches!(v.as_i64(), Some(4 | 6 | 8 | 12))
                        })
                    {
                        return Err(WorkspaceError::new(
                            "validation",
                            "Choose a supported widget width.",
                        ));
                    }
                    w.widget_widths = json!(widths);
                }
                w.revision += 1;
                r.save_workspace(&w)?;
                let mut s = r.settings()?;
                if w.archived && s.active_workspace == w.id {
                    s.active_workspace = "personal".into();
                    r.settings_update(&s)?;
                }
                json!({"saved":true})
            }
            Operation::WorkspaceSelect => {
                let wid = required(&req.data, "id", 100)?;
                let mut r = self.repo()?;
                if r.workspace(wid)?.archived {
                    return Err(WorkspaceError::new(
                        "archived",
                        "Restore the workspace before opening it.",
                    ));
                }
                let mut s = r.settings()?;
                s.active_workspace = wid.into();
                r.settings_update(&s)?;
                json!({"selected":true})
            }
            Operation::SettingsUpdate => {
                // A new meetings folder brings the glossary and the tag list along.
                let root = req.data["meetings"]
                    .get("root")
                    .and_then(|_| self.texts_root());
                self.update_settings(&req.data)?;
                match self.carry_texts(root) {
                    Some(texts) => json!({"saved": true, "texts": texts}),
                    None => json!({"saved":true}),
                }
            }
            Operation::LocalSave | Operation::DraftSave => {
                let (w, _) = self.active_workspace(&req, false)?;
                let kind = if req.op == Operation::DraftSave {
                    "draft"
                } else {
                    required(&req.data, "kind", 30)?
                };
                if !matches!(kind, "note" | "commitment" | "draft" | "rule") {
                    return Err(WorkspaceError::new("validation", "Unsupported local item."));
                }
                if kind == tasks::KIND {
                    // A commitment is a task: the change is merged into it, so its status,
                    // history and meeting fields stay, and its meeting's tasks.json follows.
                    let mut data = req.data.clone();
                    if let Some(fields) = data.as_object_mut() {
                        fields.remove("kind");
                        if fields.get("id").is_none_or(Value::is_null) {
                            let new = req.operation_id.clone().unwrap_or_else(id);
                            fields.insert("id".into(), new.into());
                        }
                    }
                    let _folders = self.meeting_lock();
                    let task = tasks::task_save(&mut *self.repo()?, &w.id, &data, now())?;
                    json!({"id": task.id})
                } else {
                    let text = required(&req.data, "text", 20000)?;
                    let record = Record {
                        id: if req.op == Operation::DraftSave {
                            format!("manual:{}", required(&req.data, "sourceId", 2000)?)
                        } else {
                            req.data["id"]
                                .as_str()
                                .map(String::from)
                                .unwrap_or_else(|| req.operation_id.clone().unwrap_or_else(id))
                        },
                        kind: kind.into(),
                        connection_id: None,
                        workspace_id: Some(w.id),
                        source: "local".into(),
                        revision: id(),
                        updated_at: now(),
                        data: json!({"text":text,"done":req.data["done"].as_bool().unwrap_or(false),"due":req.data["due"],"owner":req.data["owner"],"sourceId":req.data["sourceId"],"sourceRevision":req.data["sourceRevision"],"quote":req.data["quote"],"lane":req.data["lane"],"keyword":req.data["keyword"],"sender":req.data["sender"],"enabled":req.data["enabled"]}),
                    };
                    self.repo()?.put_record(&record)?;
                    json!({"id":record.id})
                }
            }
            Operation::LocalDelete => {
                let (w, _) = self.active_workspace(&req, false)?;
                let kind = required(&req.data, "kind", 30)?;
                if !matches!(kind, "note" | "commitment" | "draft" | "schedule" | "rule") {
                    return Err(WorkspaceError::new("validation", "Invalid local item."));
                }
                let rid = required(&req.data, "id", 200)?;
                if kind == tasks::KIND {
                    // Its meeting's tasks.json follows; one already gone is deleted all the same.
                    let _folders = self.meeting_lock();
                    match tasks::task_delete(&mut *self.repo()?, &w.id, rid) {
                        Err(e) if e.code != "not_found" => return Err(e),
                        _ => {}
                    }
                } else {
                    self.repo()?.delete_local(kind, rid, &w.id)?;
                }
                json!({"deleted":true})
            }
            Operation::GraphConnect => self.graph_connect(connect_capabilities(&req.data)?).await?,
            Operation::GraphDisconnect => {
                *self.auth_attempt.lock().await = None;
                let cid = self.repo()?.settings()?.active_connection.ok_or_else(|| {
                    WorkspaceError::new("needs_login", "No Microsoft connection is active.")
                })?;
                {
                    let mut r = self.repo()?;
                    let mut c = r.connection(&cid)?;
                    c.generation += 1;
                    c.status = "disconnected".into();
                    c.policy_revision += 1;
                    r.save_connection(&c)?;
                    r.purge_connection(&cid, req.data["retainCache"].as_bool().unwrap_or(false))?;
                    let mut s = r.settings()?;
                    s.active_connection = None;
                    r.settings_update(&s)?;
                }
                *self.session.lock().await = graph::Session::default();
                graph::delete_secret(&self.paths.private, &cid)?;
                json!({"disconnected":true})
            }
            Operation::GraphBind => {
                let (mut w, _) = self.active_workspace(&req, false)?;
                let mut r = self.repo()?;
                let cid = r.settings()?.active_connection.ok_or_else(|| {
                    WorkspaceError::new("needs_login", "Connect Microsoft first.")
                })?;
                if w.connection_id.is_some()
                    && w.connection_id.as_deref() != Some(&cid)
                    && req.data["confirmReassignment"].as_bool() != Some(true)
                {
                    return Err(WorkspaceError::new("review_required","Reassignment removes previous account source selections. Confirm to continue."));
                }
                let rebind = w.connection_id.as_deref() != Some(&cid);
                if rebind || repository::sources_empty(&w.sources) {
                    w.sources = json!({"all":true});
                    w.connection_id = Some(cid);
                    w.revision += 1;
                    r.save_workspace(&w)?;
                    drop(r);
                    // Binding bumps the account's source revision, fencing any in-flight round.
                    self.queue_sync()?;
                }
                json!({"bound":true})
            }
            Operation::SourcesSave => {
                let (mut w, c) = self.active_workspace(&req, true)?;
                let c =
                    c.ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?;
                let mut r = self.repo()?;
                let sources = req.data["sources"].clone();
                validate_sources(&r, &c, &sources)?;
                w.sources = sources;
                w.revision += 1;
                r.save_workspace(&w)?;
                drop(r);
                self.queue_sync_with(true)?;
                json!({"saved":true})
            }
            Operation::SourcesMore => {
                let (_, c) = self.active_workspace(&req, true)?;
                self.discover_chats(
                    &c.ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?,
                    true,
                )
                .await?;
                json!({"loaded":true})
            }
            Operation::SyncRequest => {
                self.queue_sync_with(true)?;
                json!({"queued":true})
            }
            Operation::CalendarWindow => {
                let (w, c) = self.active_workspace(&req, true)?;
                let c =
                    c.ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?;
                let start = req.data["start"].as_i64().unwrap_or(0);
                let end = req.data["end"].as_i64().unwrap_or(0);
                if start <= 0 || end <= start || end - start > 86400 * 124 {
                    return Err(WorkspaceError::new(
                        "validation",
                        "Choose a calendar window of at most 124 days.",
                    ));
                }
                let mut r = self.repo()?;
                let policy = r.policy(Some(&w.id), Some(&c.id))?;
                if let Some(job) = r.jobs()?.into_iter().find(|j| {
                    j.kind == "calendar_window"
                        && j.workspace_id.as_deref() == Some(&w.id)
                        && j.policy == policy
                        && j.payload["start"] == start
                        && j.payload["end"] == end
                        && matches!(j.state.as_str(), "queued" | "running")
                }) {
                    json!({"queued":true,"jobId":job.id})
                } else {
                    let job = new_job(
                        "calendar_window",
                        format!("calendar-window:{}", id()),
                        Some(w.id),
                        Some(c.id),
                        now(),
                        policy,
                        json!({"start":start,"end":end}),
                    );
                    r.enqueue(&job)?;
                    json!({"queued":true,"jobId":job.id})
                }
            }
            Operation::InboxDecision => self.inbox_decision(&req)?,
            Operation::ActionPrepare => self.prepare_action(&req).await?,
            Operation::ActionConfirm => self.confirm_action(&req).await?,
            Operation::ScheduleSave => self.save_schedule(&req)?,
            Operation::ScheduleDelete => {
                let (w, _) = self.active_workspace(&req, false)?;
                self.repo()?
                    .delete_local("schedule", required(&req.data, "id", 200)?, &w.id)?;
                json!({"deleted":true})
            }
            Operation::JobCancel | Operation::JobRetry => {
                let (w, _) = self.active_workspace(&req, false)?;
                let mut r = self.repo()?;
                let jid = required(&req.data, "id", 200)?;
                let mut job = r
                    .jobs()?
                    .into_iter()
                    .find(|j| {
                        j.id == jid
                            && (j.workspace_id.as_deref() == Some(&w.id) || j.kind == "sync")
                    })
                    .ok_or_else(|| WorkspaceError::new("not_found", "Job is unavailable."))?;
                if req.op == Operation::JobRetry {
                    if matches!(job.kind.as_str(), "notification" | "send" | "reminder") {
                        return Err(WorkspaceError::new(
                            "review_required",
                            "Check the previous dispatch outcome before creating a new action.",
                        ));
                    }
                    r.check_policy(
                        job.workspace_id.as_deref(),
                        job.connection_id.as_deref(),
                        &job.policy,
                    )?;
                    job.state = "queued".into();
                    job.due_at = now();
                    job.error_class = None;
                    job.error_code = None;
                } else {
                    if !matches!(job.state.as_str(), "queued" | "running" | "blocked")
                        || job.payload["dispatchStartedAt"].is_i64()
                    {
                        return Err(WorkspaceError::new("conflict", "This job already completed or began OS submission. Check Activity for its outcome."));
                    }
                    job.state = "cancelled".into();
                }
                r.save_job(&job)?;
                drop(r);
                if req.op == Operation::JobCancel {
                    self.cancel_graph_job(&job.id);
                    self.cancel_ai_job(&job.id);
                    if job.kind == "transcript_download" {
                        self.note_save_stopped(&job);
                    }
                }
                json!({"saved":true})
            }
            Operation::NotificationPermission => {
                let permission = self
                    .app()?
                    .notification()
                    .request_permission()
                    .map_err(|_| {
                        WorkspaceError::new(
                            "notification",
                            "Cannot request OS notifications. Open system notification settings.",
                        )
                    })?;
                let mut r = self.repo()?;
                let mut s = r.settings()?;
                s.notifications = permission == tauri_plugin_notification::PermissionState::Granted;
                s.notification_permission = if s.notifications {
                    "os_managed"
                } else {
                    "denied"
                }
                .into();
                r.settings_update(&s)?;
                json!({"permission":s.notification_permission})
            }
            Operation::NotificationTest => {
                let (w, _) = self.active_workspace(&req, false)?;
                let mut r = self.repo()?;
                if !r.settings()?.notifications {
                    return Err(WorkspaceError::new(
                        "permission_required",
                        "Enable app notifications first.",
                    ));
                }
                let policy = r.policy(Some(&w.id), None)?;
                r.enqueue(&new_job(
                    "reminder",
                    format!("test:{}", req.operation_id.as_deref().unwrap_or("")),
                    Some(w.id),
                    None,
                    now(),
                    policy,
                    json!({"title":"CodeMie Connect test reminder","expiresAt":now()+120}),
                ))?;
                json!({"queued":true})
            }
            Operation::AiSettingsSave => self.ai_settings_save(&req, &detected)?,
            Operation::AiDraft => self.queue_ai_draft(&req)?,
            Operation::AiSummarize => self.queue_ai_summary(&req)?,
            Operation::AutomationSave
            | Operation::AutomationDelete
            | Operation::AutomationToggle
            | Operation::AutomationRunNow => self.automation_op(&req)?,
            Operation::MeetingCheck
            | Operation::MeetingDownload
            | Operation::MeetingImport
            | Operation::MeetingSpeakers => self.meeting_op(&req)?,
            Operation::MeetingNotes | Operation::MeetingSet | Operation::MeetingDoc => {
                self.notes_op(&req)?
            }
            Operation::TemplateSave
            | Operation::TemplateDelete
            | Operation::MeetingRuleSave
            | Operation::MeetingRuleDelete
            | Operation::MeetingRuleOrder
            | Operation::MeetingTextSave => self.library_op(&req)?,
            Operation::TaskSave | Operation::TaskDelete => self.task_op(&req)?,
            _ => return Err(WorkspaceError::new("validation", "Unsupported operation.")),
        };
        self.repo()?
            .finish_operation(req.operation_id.as_deref().unwrap_or(""), &response)?;
        self.refresh_incidents()?;
        self.emit("workspace:changed");
        Ok(response)
    }
    fn update_settings(&self, data: &Value) -> Result<()> {
        let mut r = self.repo()?;
        let mut s = r.settings()?;
        // First: a refused meeting setting leaves everything else untouched too.
        if let Some(meetings) = data.get("meetings") {
            s.meetings.apply(meetings)?;
        }
        let old_registration = (s.client_id.clone(), s.tenant.clone());
        if let Some(theme) = data["theme"].as_str() {
            if !matches!(theme, "light" | "dark" | "system") {
                return Err(WorkspaceError::new("validation", "Unknown theme."));
            }
            s.theme = theme.into();
        }
        if let Some(zone) = data["timeZone"].as_str() {
            zone.parse::<chrono_tz::Tz>().map_err(|_| {
                WorkspaceError::new("validation", "Use an IANA time zone such as Europe/Kyiv.")
            })?;
            s.time_zone = zone.into();
        }
        if let Some(v) = data["background"].as_bool() {
            s.background = v;
        }
        if let Some(v) = data["launchAtLogin"].as_bool() {
            use tauri_plugin_autostart::ManagerExt;
            let launch = self.app()?.autolaunch();
            (if v { launch.enable() } else { launch.disable() }).map_err(|_| {
                WorkspaceError::new(
                    "io",
                    "Could not change launch-at-login. Check OS login-item settings.",
                )
            })?;
            s.launch_at_login = v;
        }
        if let Some(v) = data["criticalRepeat"].as_bool() {
            s.critical_repeat = v;
        }
        if let Some(days) = data["syncDays"].as_i64() {
            if ![1, 7, 30, 90].contains(&days) {
                return Err(WorkspaceError::new(
                    "validation",
                    "Choose a supported initial mail/chat window.",
                ));
            }
            s.sync_days = days;
            if let Some(cid) = &s.active_connection {
                let mut c = r.connection(cid)?;
                c.source_revision += 1;
                r.save_connection(&c)?;
                // Chat high-water marks were taken for the old window; re-read from the new start.
                r.clear_cursor_prefix(cid, "chat:")?;
            }
        }
        if let Some(min) = data["syncEveryMin"].as_i64() {
            if !SYNC_EVERY_MIN.contains(&min) {
                return Err(WorkspaceError::new(
                    "validation",
                    "Choose a supported sync interval.",
                ));
            }
            s.sync_every_min = min;
        }
        if let Some(v) = data["notifications"].as_bool() {
            if v && !matches!(s.notification_permission.as_str(), "granted" | "os_managed") {
                return Err(WorkspaceError::new(
                    "permission_required",
                    "Enable operating-system notification permission first.",
                ));
            }
            s.notifications = v;
        }
        if let Some(v) = data["notificationPreview"].as_bool() {
            s.notification_preview = v;
        }
        for (key, target) in [
            ("quietStart", &mut s.quiet_start),
            ("quietEnd", &mut s.quiet_end),
        ] {
            if let Some(v) = data[key].as_str() {
                chrono::NaiveTime::parse_from_str(v, "%H:%M")
                    .map_err(|_| WorkspaceError::new("validation", "Quiet times use HH:MM."))?;
                *target = v.into();
            }
        }
        if let Some(v) = data["clientId"].as_str() {
            s.client_id = v.into();
        }
        if let Some(v) = data["tenant"].as_str() {
            s.tenant = v.into();
        }
        graph::validate_registration(&s.client_id, &s.tenant)?;
        if old_registration != (s.client_id.clone(), s.tenant.clone()) {
            for mut c in r.connections()? {
                c.generation += 1;
                c.policy_revision += 1;
                c.status = "needs_login".into();
                c.sync_error = Some(
                    "Microsoft application registration changed. Sign in again in Settings.".into(),
                );
                r.save_connection(&c)?;
            }
        }
        if data.get("focusUntil").is_some() {
            s.focus_until = data["focusUntil"]
                .as_i64()
                .filter(|t| *t > now() && *t < now() + 86400);
        }
        if let Some(values) = data["capabilities"].as_array() {
            let enabled: Vec<String> = values
                .iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect();
            if enabled.len() != values.len()
                || enabled.iter().any(|s| graph::scope_for(s).is_none())
            {
                return Err(WorkspaceError::new(
                    "validation",
                    "Unknown Microsoft capability.",
                ));
            }
            let cid = s
                .active_connection
                .as_deref()
                .ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft first."))?;
            let mut c = r.connection(cid)?;
            c.enabled = enabled;
            c.policy_revision += 1;
            r.save_connection(&c)?;
        }
        r.settings_update(&s)
    }
    fn inbox_decision(&self, req: &Request) -> Result<Value> {
        let (w, c) = self.active_workspace(req, true)?;
        let c = c.ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?;
        let rid = required(&req.data, "id", 2000)?;
        let source = {
            let r = self.repo()?;
            let mut items = r.account_workspace_records(&c.id, &w.id)?;
            inbox::project(&r, &w, Some(&c), &mut items)?;
            items
                .into_iter()
                .find(|r| r.kind == "message" && r.id == rid)
                .ok_or_else(|| {
                    WorkspaceError::new("not_found", "Inbox item is no longer available.")
                })?
        };
        if !repository::source_permitted(&source, &c) || !repository::record_selected(&source, &w) {
            return Err(WorkspaceError::new(
                "permission_required",
                "This source is not selected.",
            ));
        }
        let action = required(&req.data, "action", 30)?;
        let existing = self
            .repo()?
            .record("decision", rid, Some(&c.id), Some(&w.id))
            .ok();
        let mut data=existing.map(|r|r.data).unwrap_or_else(||json!({"lane":null,"lifecycle":"open","snoozedUntil":null,"sourceRevision":source.revision}));
        match action {
            "lane" => {
                let lane = required(&req.data, "lane", 30)?;
                if !["critical", "reply", "waiting", "fyi", "low", "decisions"].contains(&lane) {
                    return Err(WorkspaceError::new("validation", "Unknown Inbox lane."));
                }
                if source.data["lane"] == "critical"
                    && lane != "critical"
                    && req.data["acknowledge"].as_bool() != Some(true)
                {
                    return Err(WorkspaceError::new(
                        "review_required",
                        "Acknowledge this critical incident before moving it.",
                    ));
                }
                data["lane"] = lane.into();
                data["waitingSince"] = if lane == "waiting" {
                    now().into()
                } else {
                    Value::Null
                };
            }
            "archive" => data["lifecycle"] = "archived".into(),
            "restore" => data["lifecycle"] = "open".into(),
            "snooze" => {
                let until = req.data["until"].as_i64().unwrap_or(0);
                if until < now() || until > now() + 86400 * 31 {
                    return Err(WorkspaceError::new(
                        "validation",
                        "Choose a snooze within the next 31 days.",
                    ));
                }
                data["snoozedUntil"] = until.into();
                if source.data["lane"] == "critical" {
                    if req.data["confirmGlobal"].as_bool() != Some(true) {
                        return Err(WorkspaceError::new("review_required","Critical snooze pauses this incident across workspaces. Confirm the global pause."));
                    }
                    let iid = required(&source.data, "incidentId", 100)?;
                    let mut repo = self.repo()?;
                    let mut incident = repo.record("incident", iid, Some(&c.id), None)?;
                    incident.data["snoozedUntil"] = until.into();
                    repo.put_record(&incident)?;
                    for mut job in repo.jobs()?.into_iter().filter(|j| {
                        j.state == "queued" && j.payload["incidentId"].as_str() == Some(iid)
                    }) {
                        job.due_at = until;
                        repo.save_job(&job)?;
                    }
                }
            }
            "acknowledge" => data["acknowledgedAt"] = now().into(),
            _ => {
                return Err(WorkspaceError::new(
                    "validation",
                    "Unsupported Inbox decision.",
                ))
            }
        }
        let r = Record {
            id: rid.into(),
            kind: "decision".into(),
            connection_id: Some(c.id.clone()),
            workspace_id: Some(w.id),
            source: source.source,
            revision: id(),
            updated_at: now(),
            data,
        };
        self.repo()?.put_record(&r)?;
        if action == "acknowledge" || req.data["acknowledge"].as_bool() == Some(true) {
            self.acknowledge_incident(&c.id, source.data["incidentId"].as_str().unwrap_or(rid))?;
        }
        Ok(json!({"saved":true}))
    }
    fn acknowledge_incident(&self, cid: &str, rid: &str) -> Result<()> {
        let mut r = self.repo()?;
        if let Ok(mut incident) = r.record("incident", rid, Some(cid), None) {
            incident.data["acknowledgedAt"] = now().into();
            incident.revision = id();
            r.put_record(&incident)?;
        }
        for mut job in r.jobs()?.into_iter().filter(|j| {
            j.connection_id.as_deref() == Some(cid)
                && j.payload["incidentId"].as_str() == Some(rid)
                && j.state == "queued"
        }) {
            job.state = "cancelled".into();
            job.result = Some("Acknowledged".into());
            r.save_job(&job)?;
        }
        Ok(())
    }
    fn save_schedule(&self, req: &Request) -> Result<Value> {
        let (w, _) = self.active_workspace(req, false)?;
        let kind = required(&req.data, "kind", 30)?;
        if kind == "event_reminder" {
            let (_, c) = self.active_workspace(req, true)?;
            let c = c.ok_or_else(|| WorkspaceError::new("needs_login", "Connect Microsoft."))?;
            let event_id = required(&req.data, "eventId", 2000)?;
            let mut r = self.repo()?;
            let event = r.record("event", event_id, Some(&c.id), None)?;
            if !repository::record_selected(&event, &w) || event.data["cancelled"] == true {
                return Err(WorkspaceError::new(
                    "permission_required",
                    "This calendar event is unavailable.",
                ));
            }
            let minutes = req.data["minutes"].as_i64().unwrap_or(10);
            if ![5, 10, 15, 30].contains(&minutes) {
                return Err(WorkspaceError::new(
                    "validation",
                    "Choose an available reminder interval.",
                ));
            }
            let start = graph::timestamp(event.data["start"].as_str().unwrap_or(""));
            if start <= now() {
                return Err(WorkspaceError::new(
                    "validation",
                    "This event has already started.",
                ));
            }
            let policy = r.policy(Some(&w.id), Some(&c.id))?;
            let job = new_job(
                "reminder",
                format!("event:{}:{}:{minutes}", event.id, event.revision),
                Some(w.id),
                Some(c.id),
                start - minutes * 60,
                policy,
                json!({"eventId":event.id,"eventRevision":event.revision,"title":event.data["title"],"expiresAt":start}),
            );
            r.enqueue(&job)?;
            return Ok(json!({"saved":true}));
        }
        // The morning brief is an automation now (DESIGN 6.6); schedules only remind.
        if kind != "reminder" {
            return Err(WorkspaceError::new("validation", "Unsupported schedule."));
        }
        let time = required(&req.data, "time", 5)?;
        let zone = required(&req.data, "timeZone", 100)?;
        let weekdays = req.data["weekdays"].as_bool().unwrap_or(false);
        let next = schedules::next_occurrence(zone, time, weekdays, now())?;
        let record = Record {
            id: req.data["id"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| req.operation_id.clone().unwrap_or_else(id)),
            kind: "schedule".into(),
            connection_id: None,
            workspace_id: Some(w.id),
            source: "local".into(),
            revision: id(),
            updated_at: now(),
            data: json!({"kind":kind,"time":time,"timeZone":zone,"weekdays":weekdays,"enabled":req.data["enabled"].as_bool().unwrap_or(true),"nextAt":next,"label":req.data["label"].as_str().unwrap_or("Workspace reminder")}),
        };
        self.repo()?.put_record(&record)?;
        Ok(json!({"nextAt":next}))
    }
    fn materialize_schedules(&self) -> Result<()> {
        materialize_due_schedules(&mut *self.repo()?)
    }
    fn deliver_notification(&self, job: &Job) -> Result<String> {
        let mut r = self.repo()?;
        r.check_claim(&job.id, job.attempts)?;
        if job_paused(job) {
            return Ok("Skipped: workspaces are hidden".into());
        }
        r.check_policy(
            job.workspace_id.as_deref(),
            job.connection_id.as_deref(),
            &job.policy,
        )?;
        let s = r.settings()?;
        if job.kind == "notification"
            && job.key.starts_with("critical:")
            && job.key.ends_with(":1")
            && !s.critical_repeat
        {
            return Ok("Critical repeat was disabled before submission".into());
        }
        if !s.notifications {
            let message = "Notifications are disabled. The reminder remains in Activity.";
            note_run_notification(&mut r, job, "disabled", message);
            return Err(WorkspaceError::new("permission_required", message));
        }
        if job.payload["expiresAt"].as_i64().is_some_and(|t| t < now()) {
            note_run_notification(&mut r, job, "expired", "It was too late to show it.");
            return Ok("Skipped expired reminder".into());
        }
        if let Some(eid) = job.payload["eventId"].as_str() {
            let event = r.record("event", eid, job.connection_id.as_deref(), None)?;
            if event.revision != job.payload["eventRevision"].as_str().unwrap_or("")
                || event.data["cancelled"] == true
            {
                return Err(WorkspaceError::new(
                    "cancelled",
                    "The calendar event changed. Set a new reminder after review.",
                ));
            }
        }
        if let Some(sid) = job.payload["scheduleId"].as_str() {
            let wid = job.workspace_id.as_deref().unwrap_or("personal");
            let schedule = r.record("schedule", sid, None, Some(wid))?;
            if schedule.data["enabled"].as_bool() != Some(true)
                || schedule.revision != job.payload["scheduleRevision"].as_str().unwrap_or("")
            {
                return Err(WorkspaceError::new("cancelled", "Schedule changed."));
            }
        }
        let critical = job.payload["critical"].as_bool().unwrap_or(false);
        if let Some(rule_id) = job.payload["ruleId"].as_str().filter(|id| *id != "manual") {
            let rule = r.record("rule", rule_id, None, job.workspace_id.as_deref())?;
            if rule.data["enabled"] == false
                || rule.revision != job.payload["ruleRevision"].as_str().unwrap_or("")
            {
                return Err(WorkspaceError::new(
                    "cancelled",
                    "The critical notification rule changed.",
                ));
            }
        }
        if let Some(rid) = job.payload["incidentId"].as_str() {
            if let Some(cid) = job.connection_id.as_deref() {
                let incident = r.record("incident", rid, Some(cid), None)?;
                if let Some(item_id) = job.payload["itemId"].as_str() {
                    let source = r.record("message", item_id, Some(cid), None).map_err(|_| {
                        WorkspaceError::new("cancelled", "Notification source is unavailable.")
                    })?;
                    let wid = job.workspace_id.as_deref().unwrap_or("personal");
                    let workspace = r.workspace(wid)?;
                    let connection = r.connection(cid)?;
                    if !repository::source_available(&source)
                        || !repository::record_selected(&source, &workspace)
                        || !repository::source_permitted(&source, &connection)
                    {
                        return Err(WorkspaceError::new(
                            "cancelled",
                            "Notification source moved or became unavailable.",
                        ));
                    }
                    if incident.data["sourceRevision"].as_str() != Some(source.revision.as_str()) {
                        let mut current = vec![source];
                        if let Ok(decision) = r.record("decision", item_id, Some(cid), Some(wid)) {
                            current.push(decision);
                        }
                        if let Ok(catalog) = r.record("catalog", "chats", Some(cid), None) {
                            current.push(catalog);
                        }
                        inbox::project(&r, &workspace, Some(&connection), &mut current)?;
                        if !current.iter().any(|item| {
                            item.id == item_id
                                && item.data["lane"] == "critical"
                                && item.data["incidentId"].as_str() == Some(rid)
                        }) {
                            return Err(WorkspaceError::new(
                                "cancelled",
                                "The source no longer matches this critical incident.",
                            ));
                        }
                    }
                }
                if incident.data["acknowledgedAt"].as_i64().is_some() {
                    return Ok("Acknowledged before submission".into());
                }
                if let Some(until) = incident.data["snoozedUntil"]
                    .as_i64()
                    .filter(|t| *t > now())
                {
                    r.defer_claim(job, until)?;
                    return Ok("Deferred by global incident snooze".into());
                }
            }
        }
        if !critical
            && (s.focus_until.is_some_and(|t| t > now())
                || schedules::quiet(&s.time_zone, &s.quiet_start, &s.quiet_end, now()))
        {
            note_run_notification(
                &mut r,
                job,
                "suppressed",
                "Quiet hours or focus were on, so it was not shown.",
            );
            return Ok("Suppressed by app quiet/focus settings; visible in Activity".into());
        }
        let (title, body) = notification_text(&s, &job.payload);
        // Notifications that share a `notificationKey` (an automation's failures) are one OS entry.
        let os_key = job.payload["notificationKey"].as_str().unwrap_or(&job.key);
        let nid = (u32::from_le_bytes(sha256_prefix(os_key)) & 0x7fffffff) as i32;
        let mut submitting = job.clone();
        submitting.payload["dispatchStartedAt"] = now().into();
        r.save_job(&submitting)?;
        // Keep the repository guard through submission so ack/policy writes cannot overtake dispatch.
        let mut builder = self.app()?.notification().builder().id(nid);
        for (key, value) in notification_extras(job) {
            builder = builder.extra(key, value);
        }
        let shown = builder.title(title).body(body).show();
        if shown.is_err() {
            let message = "OS notification submission failed. The reminder remains in Activity.";
            note_run_notification(&mut r, job, "failed", message);
            return Err(WorkspaceError::new("notification", message));
        }
        note_run_notification(
            &mut r,
            job,
            "submitted",
            "Sent to macOS; Focus and notification settings decide whether it shows.",
        );
        drop(r);
        Ok("OS submission requested; display depends on OS Focus and notification settings".into())
    }
    fn refresh_incidents(&self) -> Result<()> {
        let mut r = self.repo()?;
        let workspaces = r.workspaces()?;
        let Some(c) = r
            .settings()?
            .active_connection
            .and_then(|id| r.connection(&id).ok())
        else {
            return Ok(());
        };
        for w in workspaces.iter().filter(|w| {
            !w.archived && background_active(w) && w.connection_id.as_deref() == Some(&c.id)
        }) {
            let mut messages = r.account_workspace_records(&c.id, &w.id)?;
            inbox::project(&r, w, Some(&c), &mut messages)?;
            messages.sort_by_key(|m| std::cmp::Reverse(m.data["at"].as_i64().unwrap_or(0)));
            for message in messages.iter().filter(|m| {
                m.kind == "message"
                    && repository::record_selected(m, w)
                    && repository::source_permitted(m, &c)
                    && m.data["isMine"] != true
                    && repository::source_available(m)
                    && m.data["lane"] == "critical"
            }) {
                let incident_id = required(&message.data, "incidentId", 100)?;
                let previous = r.record("incident", incident_id, Some(&c.id), None).ok();
                let at = message.data["at"].as_i64().unwrap_or(0);
                if let Some(previous) = &previous {
                    let ack = previous.data["acknowledgedAt"].as_i64();
                    if ack.is_none()
                        || !ack.is_some_and(|ack| {
                            at > ack + 900 && at > previous.data["sourceAt"].as_i64().unwrap_or(0)
                        })
                    {
                        continue;
                    }
                }
                let episode = id();
                let incident = Record {
                    id: incident_id.into(),
                    kind: "incident".into(),
                    connection_id: Some(c.id.clone()),
                    workspace_id: None,
                    source: message.source.clone(),
                    revision: episode.clone(),
                    updated_at: now(),
                    data: json!({"title":message.data["title"],"acknowledgedAt":null,"detectedAt":now(),"sourceAt":at,"sourceRevision":message.revision,"itemId":message.id,"snoozedUntil":null}),
                };
                let policy = r.policy(Some(&w.id), Some(&c.id))?;
                let mut occurrences = Vec::new();
                for (index, delay) in [0, 120].into_iter().enumerate() {
                    if index == 1 && !r.settings()?.critical_repeat {
                        continue;
                    }
                    let rule_id = message.data["criticalRule"].as_str().unwrap_or("manual");
                    let rule_revision = r
                        .record("rule", rule_id, None, Some(&w.id))
                        .ok()
                        .map(|r| r.revision);
                    occurrences.push(new_job("notification",format!("critical:{incident_id}:{episode}:{index}"),Some(w.id.clone()),Some(c.id.clone()),now()+delay,policy.clone(),json!({"itemId":message.id,"incidentId":incident_id,"ruleId":rule_id,"ruleRevision":rule_revision,"critical":true,"title":message.data["title"],"expiresAt":now()+7200})));
                }
                r.commit_incident(&incident, &occurrences)?;
            }
        }
        Ok(())
    }
}
/// Workspaces are hidden until they are redesigned (DESIGN.md section 9). While hidden, their
/// reminders, schedules and critical alerts pause; the data and operations stay intact.
pub(crate) const WORKSPACES_HIDDEN: bool = true;

/// Whether a workspace may run background work (schedules, critical alerts).
fn background_active(w: &Workspace) -> bool {
    workspace_id_active(&w.id)
}

fn workspace_id_active(id: &str) -> bool {
    !WORKSPACES_HIDDEN || id == "personal"
}

/// Queued jobs of a hidden workspace are not delivered.
fn job_paused(job: &Job) -> bool {
    job.workspace_id
        .as_deref()
        .is_some_and(|id| !workspace_id_active(id))
}

fn materialize_due_schedules(r: &mut Repository) -> Result<()> {
    let workspaces = r.workspaces()?;
    // Each workspace is explicitly queried; scheduling is independent of which view is mounted.
    for w in workspaces
        .iter()
        .filter(|w| !w.archived && background_active(w))
    {
        let schedules = r.local_records(&w.id, "schedule")?;
        for mut schedule in schedules {
            if schedule.data["enabled"].as_bool() != Some(true) {
                continue;
            }
            let due = schedule.data["nextAt"].as_i64().unwrap_or(i64::MAX);
            if due > now() {
                continue;
            }
            let kind = schedule.data["kind"].as_str().unwrap_or("reminder");
            let policy = r.policy(Some(&w.id), None)?;
            let payload = json!({"scheduleId":schedule.id,"scheduleRevision":schedule.revision,"title":schedule.data["label"],"expiresAt":due+7200});
            let job = new_job(
                kind,
                format!("{}:{due}", schedule.id),
                Some(w.id.clone()),
                None,
                due,
                policy,
                payload,
            );
            r.enqueue(&job)?;
            schedule.data["nextAt"] = schedules::next_occurrence(
                schedule.data["timeZone"].as_str().unwrap_or("UTC"),
                schedule.data["time"].as_str().unwrap_or("09:00"),
                schedule.data["weekdays"].as_bool().unwrap_or(false),
                now(),
            )?
            .into();
            r.put_record(&schedule)?;
        }
    }
    Ok(())
}

/// Notes on the automation run a notification job belongs to (`payload.runId`) what became of
/// its notification, so a suppressed or failed one is not lost silently. Best effort: the
/// notification's own outcome stands either way.
fn note_run_notification(r: &mut Repository, job: &Job, state: &str, message: &str) {
    let Some(run_id) = job.payload["runId"].as_str() else {
        return;
    };
    let Ok(mut run) = r.record("automation_run", run_id, None, job.workspace_id.as_deref()) else {
        return;
    };
    run.data["notification"] = json!({"state": state, "message": message, "at": now()});
    run.revision = id();
    run.updated_at = now();
    if let Err(e) = r.put_record(&run) {
        log::warn!(
            "automations: cannot note a notification outcome: {}",
            e.code
        );
    }
}

/// What a shown notification carries, so a click opens what it is about: its message, its
/// calendar event, the automation run it reports, the meeting whose notes are ready
/// (`meetingId`) or the page it names (`route`, e.g. Tasks or Meetings).
fn notification_extras(job: &Job) -> Vec<(&'static str, Value)> {
    vec![
        ("workspaceId", json!(job.workspace_id)),
        ("itemId", job.payload["itemId"].clone()),
        ("eventId", job.payload["eventId"].clone()),
        ("runId", job.payload["runId"].clone()),
        ("automationId", job.payload["automationId"].clone()),
        ("meetingId", job.payload["meetingId"].clone()),
        ("route", job.payload["route"].clone()),
    ]
}
/// The `workspace:notification-open` payload for the extras of a clicked notification.
fn notification_open_payload(extra: &std::collections::HashMap<String, Value>) -> Value {
    let get = |key: &str| extra.get(key).cloned().unwrap_or(Value::Null);
    json!({"workspaceId": get("workspaceId"), "itemId": get("itemId"), "eventId": get("eventId"),
        "runId": get("runId"), "automationId": get("automationId"), "meetingId": get("meetingId"),
        "route": get("route")})
}

/// A notification's title and body: what the job names (an automation's name and result
/// title) when previews are on, otherwise words that say nothing about the content.
fn notification_text(s: &Settings, payload: &Value) -> (String, String) {
    const GENERIC: &str =
        "A workspace item needs your attention. Open CodeMie Connect to review it.";
    if !s.notification_preview {
        return ("CodeMie Connect".into(), GENERIC.into());
    }
    let title = payload["title"].as_str().unwrap_or("Workspace reminder");
    let body = payload["body"]
        .as_str()
        .filter(|b| !b.trim().is_empty())
        .unwrap_or(GENERIC);
    (title.into(), body.into())
}

fn new_job(
    kind: &str,
    key: String,
    wid: Option<String>,
    cid: Option<String>,
    due: i64,
    policy: Value,
    payload: Value,
) -> Job {
    Job {
        id: id(),
        workspace_id: wid,
        connection_id: cid,
        kind: kind.into(),
        key,
        state: "queued".into(),
        due_at: due,
        lease_until: None,
        attempts: 0,
        policy,
        payload,
        result: None,
        error_class: None,
        error_code: None,
    }
}
fn sha256_prefix(v: &str) -> [u8; 4] {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(v.as_bytes());
    [hash[0], hash[1], hash[2], hash[3]]
}
/// Today's built-in cards (`WIDGETS` in `ui/workspace/view-today.js`).
pub const WIDGET_IDS: &[&str] = &[
    "brief",
    "focus",
    "calendar",
    "inbox",
    "commitments",
    "automations",
    // "From plugins": plugin items and deliveries (DESIGN 7.2).
    "plugins",
    // "From your meetings": meetings that need the person, transcripts waiting for notes.
    "meetings",
    "notes",
    "timer",
];
/// The most cards a Today layout holds.
pub(in crate::workspace) const MAX_WIDGETS: usize = 16;
/// Remembered card widths, kept also for cards that are hidden.
const MAX_WIDGET_WIDTHS: usize = 64;

/// A built-in card id or a plugin card `plugin:<plugin id>:<widget id>` (DESIGN 7).
pub(super) fn valid_widget_id(v: &str) -> bool {
    if WIDGET_IDS.contains(&v) {
        return true;
    }
    let Some(rest) = v.strip_prefix("plugin:") else {
        return false;
    };
    let Some((plugin, widget)) = rest.split_once(':') else {
        return false;
    };
    // Plugin ids follow the manifest rule `^[a-z][a-z0-9-]{1,40}$`.
    let plugin_ok = (2..=41).contains(&plugin.len())
        && plugin.starts_with(|c: char| c.is_ascii_lowercase())
        && plugin
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let widget_ok = (1..=64).contains(&widget.len())
        && widget.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && widget
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    plugin_ok && widget_ok
}
fn valid_color(v: &str) -> Result<String> {
    if v.len() == 7 && v.starts_with('#') && v[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(v.into())
    } else {
        Err(WorkspaceError::new(
            "validation",
            "Choose a valid workspace color.",
        ))
    }
}
/// The background sync intervals Settings › Microsoft 365 offers, in minutes.
const SYNC_EVERY_MIN: [i64; 5] = [1, 2, 5, 15, 30];
/// Seconds between background syncs: the setting while the window is open, and never more often
/// than every five minutes while it is hidden.
fn sync_interval(settings: Option<Settings>, visible: bool) -> i64 {
    let every = settings.map_or(1, |s| s.sync_every_min).clamp(1, 30) * 60;
    if visible {
        every
    } else {
        every.max(300)
    }
}
/// Read capabilities requested when sign-in names none: everything a workspace shows.
const DEFAULT_CAPABILITIES: &[&str] = &["calendar", "mail", "chats"];
fn connect_capabilities(data: &Value) -> Result<Vec<String>> {
    let caps: Vec<String> = match data.get("capabilities") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|v| {
                v.as_str().map(String::from).ok_or_else(|| {
                    WorkspaceError::new("validation", "Choose Microsoft capabilities.")
                })
            })
            .collect::<Result<_>>()?,
        Some(_) => {
            return Err(WorkspaceError::new(
                "validation",
                "Choose Microsoft capabilities.",
            ))
        }
    };
    let caps = if caps.is_empty() {
        DEFAULT_CAPABILITIES.iter().map(|s| s.to_string()).collect()
    } else {
        caps
    };
    if caps.iter().any(|s| graph::scope_for(s).is_none()) {
        return Err(WorkspaceError::new(
            "validation",
            "Unknown Microsoft capability.",
        ));
    }
    Ok(caps)
}
fn validate_sources(r: &Repository, c: &Connection, sources: &Value) -> Result<()> {
    if let Some(all) = sources.get("all") {
        // Automatic form: `{"all":true}` and nothing else. `"all":false` falls through to legacy.
        if *all == true {
            if sources.as_object().is_some_and(|o| o.len() != 1) {
                return Err(WorkspaceError::new("validation", "Select valid sources."));
            }
            if c.status != "connected" {
                return Err(WorkspaceError::new(
                    "needs_login",
                    "Connect Microsoft 365 in Settings.",
                ));
            }
            return Ok(());
        }
        if *all != false {
            return Err(WorkspaceError::new("validation", "Select valid sources."));
        }
    }
    for (key, cap) in [("calendars", "calendar"), ("chats", "chats")] {
        let ids = sources[key]
            .as_array()
            .ok_or_else(|| WorkspaceError::new("validation", "Select valid sources."))?;
        if ids.len() > if key == "chats" { 50 } else { 30 } {
            return Err(WorkspaceError::new(
                "validation",
                "Too many selected sources.",
            ));
        }
        if !ids.is_empty() && !graph::permitted(c, cap) {
            return Err(WorkspaceError::new(
                "permission_required",
                "Enable and authorize this Microsoft capability first.",
            ));
        }
        let catalog = r.record("catalog", key, Some(&c.id), None).ok();
        for id in ids {
            let id = id
                .as_str()
                .ok_or_else(|| WorkspaceError::new("validation", "Invalid source ID."))?;
            if !catalog
                .as_ref()
                .and_then(|r| r.data["values"].as_array())
                .is_some_and(|values| values.iter().any(|v| v["id"].as_str() == Some(id)))
            {
                return Err(WorkspaceError::new(
                    "validation",
                    "Refresh Microsoft source lists before selecting this source.",
                ));
            }
        }
    }
    if sources["mail"].as_bool().unwrap_or(false) && !graph::permitted(c, "mail") {
        return Err(WorkspaceError::new(
            "permission_required",
            "Authorize Mail.Read before selecting Outlook.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_request(
    state: tauri::State<'_, WorkspaceState>,
    call: tauri::ipc::Request<'_>,
    request: Request,
) -> Result<Value> {
    crate::plugins::caller::require_main_frame(&call)?;
    if let Some(core) = &state.core {
        core.request(request).await
    } else {
        Err(WorkspaceError::new(
            "storage_unavailable",
            state.error.clone().unwrap_or_else(|| {
                "Workspace storage is unavailable; existing tools are still accessible.".into()
            }),
        ))
    }
}
#[tauri::command]
pub fn workspace_installer_busy(state: tauri::State<'_, WorkspaceState>, busy: bool) {
    if let Some(c) = &state.core {
        c.installer_busy.store(busy, Ordering::Relaxed);
        if !busy {
            c.emit("workspace:installer-settled");
        }
    }
}

pub fn setup_tray(app: &tauri::App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    let show = MenuItem::with_id(app, "show", "Open CodeMie Connect", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit CodeMie Connect", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let tray = TrayIconBuilder::new()
        .tooltip("CodeMie Connect")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<WorkspaceState>() {
                    if let Some(core) = &state.core {
                        if core.installer_busy.load(Ordering::Relaxed) {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            core.emit("workspace:quit-request");
                            return;
                        }
                        core.stop_background();
                    }
                }
                app.exit(0);
            }
            _ => {}
        });
    // The menu bar wants a monochrome template that AppKit tints for the light or dark
    // bar, like the system icons; the colour app icon stays for other platforms' trays.
    #[cfg(target_os = "macos")]
    let tray = tray
        .icon(tauri::include_image!("icons/tray-template.png"))
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let tray = match app.default_window_icon() {
        Some(icon) => tray.icon(icon.clone()),
        None => tray,
    };
    tray.build(app)?;
    Ok(())
}

#[cfg(any(test, feature = "test-support"))]
use std::path::Path;

/// The default layout: data and private files in one folder.
#[cfg(any(test, feature = "test-support"))]
fn test_paths(dir: &Path) -> CorePaths {
    CorePaths {
        data: dir.into(),
        private: dir.into(),
    }
}

/// A `Core` with no window, a scripted runner and a fixed profile list, for tests
/// (`crate::testing::core` for the tests outside the crate).
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn test_core(
    dir: &Path,
    runner: Arc<dyn ClaudeRunner>,
    profiles: Vec<crate::ai::profiles::AiProfile>,
) -> Arc<Core> {
    test_core_with_graph(
        dir,
        runner,
        profiles,
        Arc::new(ai_jobs::FakeGraph::default()),
    )
}

/// [`test_core`] whose Microsoft reads for AI runs are answered by `graph`.
#[cfg(any(test, feature = "test-support"))]
fn test_core_with_graph(
    dir: &Path,
    runner: Arc<dyn ClaudeRunner>,
    profiles: Vec<crate::ai::profiles::AiProfile>,
    graph: Arc<dyn ai_jobs::GraphReads>,
) -> Arc<Core> {
    Core::open_with(
        None,
        &test_paths(dir),
        runner,
        ProfileCache::fixed(profiles),
        graph,
    )
    .unwrap()
}

/// Opens a `Core` on `paths` with no window and a scripted runner, for tests outside this module.
#[cfg(test)]
pub(crate) fn open_for_tests(paths: &CorePaths) -> Result<Arc<Core>> {
    paths::tests::open_test(paths)
}

#[cfg(test)]
pub(crate) fn test_core_slow(
    dir: &Path,
    runner: Arc<dyn ClaudeRunner>,
    profiles: Vec<crate::ai::profiles::AiProfile>,
    delay: std::time::Duration,
) -> Arc<Core> {
    Core::open_with(
        None,
        &test_paths(dir),
        runner,
        ProfileCache::fixed_slow(profiles, delay),
        Arc::new(ai_jobs::FakeGraph::default()),
    )
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::paths::tests::{custom_root, open_test, synthetic_credential};
    use super::*;
    use crate::workspace::ai::tests::{mutation, ready};

    #[test]
    fn background_sync_follows_the_setting_and_slows_when_hidden() {
        let every = |min: i64| Settings {
            sync_every_min: min,
            ..Default::default()
        };
        assert_eq!(Settings::default().sync_every_min, 1);
        assert_eq!(sync_interval(None, true), 60);
        assert_eq!(sync_interval(Some(every(1)), true), 60);
        assert_eq!(sync_interval(Some(every(1)), false), 300);
        assert_eq!(sync_interval(Some(every(15)), true), 900);
        assert_eq!(sync_interval(Some(every(15)), false), 900);
        // Settings written before the field existed read as every minute.
        let old: Settings = serde_json::from_str(r#"{"syncDays":7}"#).unwrap();
        assert_eq!(sync_interval(Some(old), true), 60);
    }

    #[tokio::test]
    async fn settings_update_takes_a_supported_sync_interval_only() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(
            dir.path(),
            Arc::new(crate::ai::fake::FakeRunner::new(vec![])),
            ready(),
        );
        let set = |min: i64| {
            mutation(
                &core,
                Operation::SettingsUpdate,
                json!({ "syncEveryMin": min }),
            )
        };
        core.request(set(5)).await.unwrap();
        assert_eq!(core.repo().unwrap().settings().unwrap().sync_every_min, 5);
        assert_eq!(core.request(set(3)).await.unwrap_err().code, "validation");
        assert_eq!(core.repo().unwrap().settings().unwrap().sync_every_min, 5);
    }

    #[tokio::test]
    async fn credentials_stay_in_private_root_with_custom_data_root() {
        let dir = tempfile::tempdir().unwrap();
        let default = dir.path().join("workspace");
        let data = custom_root(&default, &dir.path().join("Drive"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let state = startup(&default, open_test);
        let core = state.core.expect("a ready custom folder opens");
        assert!(state.resolved.custom);
        assert_eq!(core.paths.data, data);
        assert_eq!(core.paths.private, default);
        // The database, its lock and AI staging move; sign-in data, owner.lock and window.json stay.
        assert!(data.join("workspace.sqlite").is_file());
        assert!(data.join("connect.lock").is_file());
        assert!(!default.join("workspace.sqlite").exists());
        assert!(default.join("owner.lock").is_file());
        assert!(!data.join("owner.lock").exists());
        assert_eq!(core.paths.staging(), data.join("ai-staging"));
        assert_eq!(
            geometry::path(&core.paths.private),
            default.join("window.json")
        );
        assert_eq!(
            core.paths.plugin_secrets(),
            default.join("credentials").join("plugins")
        );
        #[cfg(unix)]
        assert_eq!(
            super::paths::tests::mode(&data),
            0o755,
            "a custom root is never chmodded"
        );
        // Sign-in goes to the private folder, and disconnecting removes it from there.
        let cid = id();
        credentials::save(&core.paths.private, &cid, &synthetic_credential()).unwrap();
        let cache = default
            .join("credentials")
            .join(format!("graph-{cid}.json"));
        assert!(cache.is_file());
        assert!(!data.join("credentials").exists());
        {
            let mut r = core.repo().unwrap();
            r.save_connection(&connected(&cid)).unwrap();
            let mut s = r.settings().unwrap();
            s.active_connection = Some(cid.clone());
            r.settings_update(&s).unwrap();
        }
        let req = mutation(&core, Operation::GraphDisconnect, json!({}));
        core.request(req).await.unwrap();
        assert!(
            !cache.exists(),
            "disconnect removes the private session cache"
        );
    }

    #[tokio::test]
    async fn runtime_io_failure_reports_storage_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(
            dir.path(),
            Arc::new(crate::ai::fake::FakeRunner::new(vec![])),
            ready(),
        );
        core.repo().unwrap().fail_writes();
        let req = mutation(
            &core,
            Operation::LocalSave,
            json!({"kind":"commitment","text":"Send the report"}),
        );
        let err = core.request(req).await.unwrap_err();
        assert_eq!(err.code, "storage_unavailable");
        // No panic and no poisoned lock: the snapshot behind the recovery page still reads.
        let snapshot = core
            .request(Request {
                op: Operation::Snapshot,
                workspace_id: None,
                expected_revision: None,
                operation_id: None,
                data: json!({}),
            })
            .await;
        assert!(snapshot.is_ok());
    }

    #[tokio::test]
    async fn layout_accepts_the_meetings_card() {
        let dir = tempfile::tempdir().unwrap();
        let core = quiet_core(dir.path());
        core.request(mutation(
            &core,
            Operation::LayoutSave,
            json!({"layout": ["brief", "meetings"], "widgetWidths": {"meetings": 6}}),
        ))
        .await
        .unwrap();
        let w = core.repo().unwrap().workspace("personal").unwrap();
        assert_eq!(w.layout, vec!["brief".to_string(), "meetings".to_string()]);
        assert_eq!(w.widget_widths["meetings"], 6);
    }

    #[tokio::test]
    async fn layout_accepts_automations_and_plugin_widgets_rejects_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let core = quiet_core(dir.path());
        let save = |data: Value| {
            let core = core.clone();
            async move {
                core.request(mutation(&core, Operation::LayoutSave, data))
                    .await
            }
        };
        // Every built-in card, Automation results and a plugin card (Task 24), with widths.
        save(json!({
            "layout": ["brief", "focus", "calendar", "inbox", "commitments", "automations", "plugin:github:repos"],
            "widgetWidths": {"automations": 6, "plugin:github:repos": 4, "brief": 8},
        }))
        .await
        .unwrap();
        let w = core.repo().unwrap().workspace("personal").unwrap();
        assert_eq!(w.layout.len(), 7);
        assert_eq!(w.layout[5], "automations");
        assert_eq!(w.layout[6], "plugin:github:repos");
        assert_eq!(w.widget_widths["plugin:github:repos"], 4);
        // Sixteen cards are the most a layout holds; repeats collapse.
        let sixteen: Vec<String> = (0..16).map(|n| format!("plugin:plugin-{n}:w")).collect();
        save(json!({"layout": sixteen})).await.unwrap();
        save(json!({"layout": ["automations", "automations"]}))
            .await
            .unwrap();
        assert_eq!(
            core.repo().unwrap().workspace("personal").unwrap().layout,
            vec!["automations".to_string()]
        );

        let seventeen: Vec<String> = (0..17).map(|n| format!("plugin:plugin-{n}:w")).collect();
        for bad in [
            json!(["weather"]),
            json!(["Automations"]),
            json!(["plugin:github"]),
            json!(["plugin::repos"]),
            json!(["plugin:github:"]),
            json!(["plugin:GitHub:repos"]),
            json!(["plugin:1github:repos"]),
            json!(["plugin:github:repos:extra"]),
            json!(["plugin:github:re pos"]),
            json!([42]),
            json!(seventeen),
        ] {
            let err = save(json!({"layout": bad.clone()})).await.unwrap_err();
            assert_eq!(err.message, "Invalid Today layout.", "{bad}");
        }
        for bad in [
            json!({"weather": 6}),
            json!({"automations": 5}),
            json!({"plugin:github": 6}),
            json!({"plugin:github:repos": "wide"}),
        ] {
            let err = save(json!({"widgetWidths": bad.clone()}))
                .await
                .unwrap_err();
            assert_eq!(err.message, "Choose a supported widget width.", "{bad}");
        }
        save(json!({"widgetWidths": {"plugin:github:ci": 12, "automations": 8}}))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn an_ai_run_never_recreates_a_vanished_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        let default = dir.path().join("workspace");
        let drive = dir.path().join("Drive");
        let data = custom_root(&default, &drive);
        let core = startup(&default, open_test).core.unwrap();
        // The drive goes away while Connect runs.
        std::fs::remove_dir_all(&drive).unwrap();
        let err = core
            .request(Request {
                op: Operation::AiTest,
                workspace_id: Some("personal".into()),
                expected_revision: None,
                operation_id: None,
                data: json!({"profileId":"claude"}),
            })
            .await
            .unwrap_err();
        assert_eq!(err.code, "storage_unavailable");
        assert!(
            !data.exists() && !drive.exists(),
            "the data folder came back"
        );
    }

    #[test]
    fn release_for_restart_frees_both_locks() {
        let dir = tempfile::tempdir().unwrap();
        let default = dir.path().join("workspace");
        let data = custom_root(&default, &dir.path().join("Drive"));
        let core = startup(&default, open_test).core.unwrap();
        core.release_for_restart();
        assert!(core.stop.load(Ordering::Relaxed));
        for (lock, kind) in [
            (default.join("owner.lock"), Lock::Owner),
            (data.join("connect.lock"), Lock::DataFolder),
        ] {
            assert!(
                acquire_lock(&lock, kind, std::time::Duration::ZERO).is_ok(),
                "{lock:?}"
            );
        }
        // The database is closed: nothing reads the file any more.
        assert!(core.repo().unwrap().snapshot().is_err());
    }

    fn quiet_core(dir: &Path) -> Arc<Core> {
        test_core(
            dir,
            Arc::new(crate::ai::fake::FakeRunner::new(vec![])),
            ready(),
        )
    }
    fn local_note(id: &str) -> Record {
        Record {
            id: id.into(),
            kind: "note".into(),
            connection_id: None,
            workspace_id: Some("personal".into()),
            source: "local".into(),
            revision: "1".into(),
            updated_at: 1,
            data: json!({"text": id}),
        }
    }
    const SHORT: std::time::Duration = std::time::Duration::from_millis(200);

    #[test]
    fn quiesce_refuses_while_a_send_is_dispatching() {
        let dir = tempfile::tempdir().unwrap();
        let core = quiet_core(dir.path());
        let mut send = local_note("send-1");
        send.kind = "action".into();
        send.connection_id = Some("c1".into());
        send.data = json!({"state":"dispatching"});
        core.repo().unwrap().put_record(&send).unwrap();
        let err = core.quiesce(SHORT).unwrap_err();
        assert_eq!(err.code, "busy");
        assert!(err.message.contains("being sent"), "{}", err.message);
        // Nothing was held: background work, Microsoft reads and the database carry on.
        assert!(!core.hold.load(Ordering::SeqCst));
        assert!(!core.stopping());
        core.repo().unwrap().put_record(&local_note("n1")).unwrap();
    }

    #[test]
    fn quiesce_safety_net_gives_up_on_work_that_never_stops_and_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let core = quiet_core(dir.path());
        // A job that ignores cancellation, a loop round that never ends and an edit that never
        // finishes each keep the database open; past the deadline everything runs again.
        core.jobs_in_flight.fetch_add(1, Ordering::SeqCst);
        let started = std::time::Instant::now();
        let err = core.quiesce(SHORT).unwrap_err();
        assert!(started.elapsed() >= SHORT);
        assert_eq!(err.code, "busy");
        assert!(err.message.contains("background work"), "{}", err.message);
        assert!(
            !core.hold.load(Ordering::SeqCst),
            "background work runs again"
        );
        core.repo().unwrap().put_record(&local_note("n1")).unwrap();
        core.jobs_in_flight.fetch_sub(1, Ordering::SeqCst);

        core.loop_busy.store(true, Ordering::SeqCst);
        assert_eq!(core.quiesce(SHORT).unwrap_err().code, "busy");
        assert!(!core.is_held());
        core.loop_busy.store(false, Ordering::SeqCst);

        let edit = core.mutations.try_lock().unwrap();
        assert_eq!(core.quiesce(SHORT).unwrap_err().code, "busy");
        assert!(!core.is_held());
        drop(edit);

        // Once everything has finished, it goes ahead.
        core.quiesce(SHORT).unwrap();
        core.resume().unwrap();
    }

    #[test]
    fn quiesce_waits_for_plugin_requests_and_refuses_new_ones() {
        let dir = tempfile::tempdir().unwrap();
        let core = quiet_core(dir.path());
        // A request that doesn't finish in time: the change gives up and everything runs again.
        let op = core.begin_plugin_op().unwrap();
        let err = core.quiesce(SHORT).unwrap_err();
        assert_eq!(
            (err.code.as_str(), err.message.as_str()),
            (
                "busy",
                "Plugins are being installed — try again in a moment."
            )
        );
        assert!(!core.is_held());
        // One that finishes: the change waits for it.
        let finishing = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(op);
        });
        core.quiesce(std::time::Duration::from_secs(10)).unwrap();
        finishing.join().unwrap();
        assert_eq!(core.plugin_ops.load(Ordering::SeqCst), 0);
        // While held, new requests are refused and not counted.
        assert_eq!(core.begin_plugin_op().err().unwrap().code, "busy");
        assert_eq!(core.plugin_ops.load(Ordering::SeqCst), 0);
        core.resume().unwrap();
        let op = core.begin_plugin_op().unwrap();
        assert_eq!(core.plugin_ops.load(Ordering::SeqCst), 1);
        drop(op);
    }

    #[test]
    fn quiesce_closes_the_database_until_resume() {
        let dir = tempfile::tempdir().unwrap();
        let core = quiet_core(dir.path());
        core.repo().unwrap().put_record(&local_note("n1")).unwrap();
        core.quiesce(SHORT).unwrap();
        // Held: no new jobs, no Microsoft reads, and every request is told why.
        assert!(core.hold.load(Ordering::SeqCst));
        assert!(core.stopping());
        assert!(!core.stop.load(Ordering::Relaxed), "a hold is not a quit");
        let err = core.repo().err().unwrap();
        assert_eq!(err.code, "busy");
        // The database file is checkpointed and free for a copy.
        let wal = dir.path().join("workspace.sqlite-wal");
        assert!(!wal.exists() || std::fs::metadata(&wal).unwrap().len() == 0);
        assert_eq!(core.quiesce(SHORT).unwrap_err().code, "busy");

        core.resume().unwrap();
        assert!(!core.hold.load(Ordering::SeqCst));
        assert!(!core.stopping());
        let repo = core.repo().unwrap();
        assert_eq!(repo.local_records("personal", "note").unwrap().len(), 1);
        drop(repo);
        core.repo().unwrap().put_record(&local_note("n2")).unwrap();
    }

    #[test]
    fn resume_never_recreates_a_database_that_went_away() {
        let dir = tempfile::tempdir().unwrap();
        let core = quiet_core(dir.path());
        core.quiesce(SHORT).unwrap();
        let database = dir.path().join("workspace.sqlite");
        std::fs::remove_file(&database).unwrap();
        assert_eq!(core.resume().unwrap_err().code, "storage_unavailable");
        assert!(!database.exists(), "no empty workspace appears");
        assert!(core.is_held(), "nothing runs on a missing database");
        assert_eq!(core.repo().err().unwrap().code, "busy");
    }

    fn connected(cid: &str) -> Connection {
        Connection {
            id: cid.into(),
            account_key: cid.into(),
            display_name: "QA".into(),
            user_id: cid.into(),
            generation: 1,
            policy_revision: 1,
            scopes: vec![
                "Calendars.Read".into(),
                "Mail.Read".into(),
                "Chat.Read".into(),
            ],
            enabled: vec!["calendar".into(), "mail".into(), "chats".into()],
            status: "connected".into(),
            ..Default::default()
        }
    }
    #[test]
    fn automatic_sources_validate_only_as_the_sole_key_while_connected() {
        let d = tempfile::tempdir().unwrap();
        let r = Repository::open(&d.path().join("db")).unwrap();
        let c = connected("a");
        assert!(validate_sources(&r, &c, &json!({"all":true})).is_ok());
        assert_eq!(
            validate_sources(&r, &c, &json!({"all":true,"mail":true}))
                .unwrap_err()
                .code,
            "validation"
        );
        assert_eq!(
            validate_sources(&r, &c, &json!({"all":"yes"}))
                .unwrap_err()
                .code,
            "validation"
        );
        let mut signed_out = c.clone();
        signed_out.status = "needs_login".into();
        assert_eq!(
            validate_sources(&r, &signed_out, &json!({"all":true}))
                .unwrap_err()
                .code,
            "needs_login"
        );
        // The legacy explicit form keeps its catalog checks.
        assert!(validate_sources(
            &r,
            &c,
            &json!({"all":false,"calendars":[],"chats":[],"mail":true})
        )
        .is_ok());
        assert!(validate_sources(&r, &c, &json!({"calendars":["unknown"],"chats":[]})).is_err());
    }
    #[test]
    fn hidden_workspaces_schedules_and_incidents_pause() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let mut atlas = r.workspace("personal").unwrap();
        atlas.id = "atlas".into();
        atlas.name = "Project Atlas".into();
        atlas.is_default = false;
        r.save_workspace(&atlas).unwrap();
        for wid in ["personal", "atlas"] {
            r.put_record(&Record {
                id: format!("reminder-{wid}"),
                kind: "schedule".into(),
                connection_id: None,
                workspace_id: Some(wid.into()),
                source: "local".into(),
                revision: "1".into(),
                updated_at: 1,
                data: json!({"kind":"reminder","time":"09:00","timeZone":"UTC","weekdays":false,"enabled":true,"nextAt":1,"label":"Stand-up"}),
            })
            .unwrap();
        }
        materialize_due_schedules(&mut r).unwrap();
        let keys: Vec<_> = r
            .jobs()
            .unwrap()
            .into_iter()
            .map(|j| j.workspace_id.unwrap_or_default())
            .collect();
        assert_eq!(keys, vec!["personal".to_string()]);
        // The paused reminder is untouched and its data stays.
        let atlas_reminder = &r.local_records("atlas", "schedule").unwrap()[0];
        assert_eq!(atlas_reminder.data["nextAt"], 1);
        // Critical alerts follow the same rule.
        assert!(background_active(&r.workspace("personal").unwrap()));
        assert!(!background_active(&r.workspace("atlas").unwrap()));
        // Already-queued jobs of a hidden workspace are not delivered either.
        let queued = r.jobs().unwrap().remove(0);
        assert!(!job_paused(&queued));
        let mut atlas_job = queued.clone();
        atlas_job.workspace_id = Some("atlas".into());
        assert!(job_paused(&atlas_job));
    }
    #[test]
    fn notification_text_shows_content_only_with_previews() {
        let mut s = Settings::default();
        let automation = json!({"title": "Morning brief", "body": "3 meetings, 2 replies owed"});
        let generic = "A workspace item needs your attention. Open CodeMie Connect to review it.";
        assert_eq!(
            notification_text(&s, &automation),
            ("CodeMie Connect".to_string(), generic.to_string())
        );
        s.notification_preview = true;
        assert_eq!(
            notification_text(&s, &automation),
            (
                "Morning brief".to_string(),
                "3 meetings, 2 replies owed".to_string()
            )
        );
        // A reminder names only its title.
        assert_eq!(
            notification_text(&s, &json!({"title": "Stand-up"})),
            ("Stand-up".to_string(), generic.to_string())
        );
    }
    #[test]
    fn notifications_carry_their_run_and_a_click_forwards_it() {
        let job = new_job(
            "notification",
            "automation:run-1:notify".into(),
            Some("personal".into()),
            None,
            now(),
            json!({}),
            json!({"title": "Morning brief", "body": "2 replies owed", "automationId": "auto-brief", "runId": "run-1"}),
        );
        let extra: std::collections::HashMap<String, Value> = notification_extras(&job)
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        assert_eq!(extra["runId"], "run-1");
        assert_eq!(extra["automationId"], "auto-brief");
        assert_eq!(extra["workspaceId"], "personal");
        assert_eq!(
            notification_open_payload(&extra),
            json!({"workspaceId": "personal", "itemId": null, "eventId": null, "runId": "run-1", "automationId": "auto-brief", "meetingId": null, "route": null})
        );
        // A critical alert still opens its message.
        let mut critical = job.clone();
        critical.payload = json!({"itemId": "m-1", "critical": true});
        let extra: std::collections::HashMap<String, Value> = notification_extras(&critical)
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        assert_eq!(notification_open_payload(&extra)["itemId"], "m-1");
        assert_eq!(notification_open_payload(&extra)["runId"], Value::Null);
        // Tasks due today open the Tasks page.
        let mut due = job.clone();
        due.payload = json!({"title": "2 tasks due today", "route": "tasks"});
        let extra: std::collections::HashMap<String, Value> = notification_extras(&due)
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        assert_eq!(notification_open_payload(&extra)["route"], "tasks");
        // Notes made by themselves open their meeting on the Meetings page.
        let mut notes = job.clone();
        notes.payload = json!({"title": "Notes ready: Weekly sync", "body": "Made with Meeting notes.", "meetingId": "m-1", "route": "meetings"});
        let extra: std::collections::HashMap<String, Value> = notification_extras(&notes)
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let open = notification_open_payload(&extra);
        assert_eq!(
            (open["meetingId"].as_str(), open["route"].as_str()),
            (Some("m-1"), Some("meetings"))
        );
    }

    #[test]
    fn sign_in_defaults_to_read_capabilities_and_keeps_explicit_writes() {
        let defaults = vec!["calendar", "mail", "chats"];
        assert_eq!(connect_capabilities(&json!({})).unwrap(), defaults);
        assert_eq!(
            connect_capabilities(&json!({"capabilities":null})).unwrap(),
            defaults
        );
        assert_eq!(
            connect_capabilities(&json!({"capabilities":[]})).unwrap(),
            defaults
        );
        assert_eq!(
            connect_capabilities(
                &json!({"capabilities":["calendar","calendar_write","mail_send","chat_send"]})
            )
            .unwrap(),
            vec!["calendar", "calendar_write", "mail_send", "chat_send"]
        );
        assert!(connect_capabilities(&json!({"capabilities":["everything"]})).is_err());
        assert!(connect_capabilities(&json!({"capabilities":[1]})).is_err());
        assert!(connect_capabilities(&json!({"capabilities":"calendar"})).is_err());
    }
}
