//! Reading sessions from the CLI into the store, in the background and one fetch at a time. The
//! first open reads 90 days back, newest first, three days per call; once only yesterday and
//! today are left, a refresh reads those two in one call. A call that fails is made again day by
//! day, and a day that still fails waits for its own retry (`failed_days`). Days are UTC, because
//! the CLI reads a date-only `--from`/`--to` as UTC days.
use super::cli::{CliError, ExportOutcome};
use super::store::State;
use crate::workspace::models::Result;
use crate::workspace::{poisoned, Core};
use chrono::{Days, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::ops::ControlFlow;
use std::sync::Arc;
use tauri::Emitter;

/// How far back the first open reads.
const FIRST_OPEN_DAYS: u32 = 90;
/// Days per CLI call: three days peak near 4.2 GB, within the raised heap.
const WINDOW_DAYS: i64 = 3;
/// Where a call's export is written before it is merged.
const EXPORT: &str = "export.json";
/// Progress to the window: `{running, done, total, label, failedDays}`.
const EVENT: &str = "workspace:analytics";

type Window = (NaiveDate, NaiveDate);

/// How far the running fetch got, in days.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub label: String,
}

/// A day as [`State`] keeps it.
fn key(day: NaiveDate) -> String {
    day.format("%Y-%m-%d").to_string()
}

fn length(&(from, to): &Window) -> usize {
    (to - from).num_days() as usize + 1
}

/// The first open's calls: the last `days` days up to `today`, newest first, in windows of up
/// to three consecutive days that are not in `done`.
pub fn plan_first_open(today: NaiveDate, days: u32, done: &BTreeSet<String>) -> Vec<Window> {
    let mut windows = Vec::new();
    let mut current: Option<Window> = None;
    for back in 0..u64::from(days) {
        let day = today - Days::new(back);
        if done.contains(&key(day)) {
            windows.extend(current.take());
            continue;
        }
        current = match current {
            Some((_, to)) if (to - day).num_days() < WINDOW_DAYS => Some((day, to)),
            full => {
                windows.extend(full);
                Some((day, day))
            }
        };
    }
    windows.extend(current);
    windows
}

/// A refresh: from the start of yesterday to today, in one call.
pub fn plan_refresh(today: NaiveDate) -> Window {
    (today - Days::new(1), today)
}

/// What `analytics_refresh` reads, and its label: the first open's windows while a day before
/// yesterday is unread, then [`plan_refresh`]. Failed days wait for their own retry.
fn next_fetch(today: NaiveDate, state: &State) -> (Vec<Window>, &'static str) {
    let handled = state.days_done.union(&state.failed_days).cloned().collect();
    let backlog = plan_first_open(today, FIRST_OPEN_DAYS, &handled);
    let yesterday = today - Days::new(1);
    if backlog.iter().any(|&(from, _)| from < yesterday) {
        (backlog, "Reading your history, newest first")
    } else {
        (vec![plan_refresh(today)], "Reading yesterday and today")
    }
}

/// Marks `from..=to` read. Today isn't over, so it stays unread and the next fetch reads it again.
fn mark_read(state: &mut State, (from, to): Window, today: NaiveDate) {
    for day in from.iter_days().take_while(|d| *d <= to) {
        state.failed_days.remove(&key(day));
        if day < today {
            state.days_done.insert(key(day));
        }
    }
    state.stored_from = state.days_done.first().cloned();
}

/// Ends the fetch however its task ends, so a panic can't leave it running for good.
struct Running(Arc<Core>);
impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(mut run) = self.0.analytics_run.lock() {
            *run = None;
        }
    }
}

/// What one CLI call came to.
enum Read {
    Done,
    Failed,
    Stop,
}

impl Core {
    /// `analytics_refresh` (`retry: None`) and `analytics_retry`: starts the fetch in the
    /// background and answers at once. Nothing starts when the CLI can't answer `view`, or while
    /// a fetch runs.
    pub(super) async fn start_fetch(
        self: &Arc<Self>,
        today: NaiveDate,
        retry: Option<NaiveDate>,
    ) -> Result<Value> {
        if !self.analytics_cli.supports_view().await {
            return Ok(json!({"needsCli": true}));
        }
        let (windows, progress) = {
            let mut run = self.analytics_run.lock().map_err(|_| poisoned())?;
            if run.is_some() {
                return Ok(json!({"running": true}));
            }
            // Opened before planning: a store found unreadable is set aside with its state, so
            // the plan starts over. Opening also makes the folder the CLI exports into.
            self.analytics_store();
            // Planned under the guard, so no fetch is changing the state meanwhile.
            let (windows, label) = match retry {
                Some(day) => (vec![(day, day)], format!("Reading {}", key(day))),
                None => {
                    let (windows, label) =
                        next_fetch(today, &State::load(&self.paths.analytics_dir()));
                    (windows, label.to_string())
                }
            };
            let progress = Progress {
                done: 0,
                total: windows.iter().map(length).sum(),
                label,
            };
            *run = Some(progress.clone());
            (windows, progress)
        };
        tokio::spawn(self.clone().fetch(windows, today, progress));
        Ok(json!({"started": true}))
    }

    async fn fetch(self: Arc<Self>, windows: Vec<Window>, today: NaiveDate, mut p: Progress) {
        let running = Running(self.clone());
        self.emit_progress(true, &p);
        let mut finished = true;
        for window in windows {
            if self.read_window(window, today).await.is_break() {
                finished = false;
                break;
            }
            p.done += length(&window);
            if let Ok(mut run) = self.analytics_run.lock() {
                *run = Some(p.clone());
            }
            self.emit_progress(true, &p);
        }
        if finished {
            let at = Utc::now().timestamp_millis();
            self.note(|s| s.last_fetch_at = Some(at));
        }
        drop(running);
        self.emit_progress(false, &p);
    }

    /// One window; when its call fails, its days one by one, newest first.
    async fn read_window(
        self: &Arc<Self>,
        (from, to): Window,
        today: NaiveDate,
    ) -> ControlFlow<()> {
        match self.read_days((from, to), today).await {
            Read::Done => return ControlFlow::Continue(()),
            Read::Stop => return ControlFlow::Break(()),
            Read::Failed if from == to => {
                self.note(|s| {
                    s.failed_days.insert(key(from));
                });
                return ControlFlow::Continue(());
            }
            Read::Failed => {}
        }
        for back in 0..length(&(from, to)) as u64 {
            let day = to - Days::new(back);
            match self.read_days((day, day), today).await {
                Read::Done => {}
                Read::Failed => self.note(|s| {
                    s.failed_days.insert(key(day));
                }),
                Read::Stop => return ControlFlow::Break(()),
            }
        }
        ControlFlow::Continue(())
    }

    /// One CLI call, merged into the store; then its days are marked read. The fetch stops when
    /// the CLI is gone or the files can't be written.
    async fn read_days(self: &Arc<Self>, window: Window, today: NaiveDate) -> Read {
        let (from, to) = window;
        let out = self.paths.analytics_dir().join(EXPORT);
        let outcome = match self.analytics_cli.export(from, to, &out).await {
            Ok(outcome) => outcome,
            Err(CliError::NotFound) => {
                log::warn!("analytics: no CodeMie CLI; the fetch stops");
                return Read::Stop;
            }
            Err(e) => {
                log::warn!(
                    "analytics: reading {}..{} failed: {e:?}",
                    key(from),
                    key(to)
                );
                return Read::Failed;
            }
        };
        // The same fence plugin installs use: a data-folder change waits for this write and
        // refuses the next, which ends the fetch. Days not written are read again later.
        let Ok(_write) = self.begin_plugin_op() else {
            return Read::Stop;
        };
        let store = self.analytics_store();
        let stored = match outcome {
            ExportOutcome::Written => {
                let export = std::fs::read(&out)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
                let _ = std::fs::remove_file(&out);
                let Some(export) = export else {
                    log::warn!("analytics: the export of {} isn't JSON", key(from));
                    return Read::Failed;
                };
                store.merge(&export).map(|_| ())
            }
            ExportOutcome::Empty => store.extend_period(from),
        };
        // The state is read after the merge, which may have set an unreadable store aside
        // with it.
        if stored
            .and_then(|()| self.change_state(|s| mark_read(s, window, today)))
            .is_err()
        {
            return Read::Stop;
        }
        Read::Done
    }

    /// Loads the saved state, changes it and saves it. Not kept by the fetch between calls, so
    /// a state dropped with an unreadable store stays dropped.
    fn change_state(&self, change: impl FnOnce(&mut State)) -> Result<()> {
        let dir = self.paths.analytics_dir();
        let mut state = State::load(&dir);
        change(&mut state);
        state.save(&dir)
    }

    /// [`Self::change_state`] for a note the fetch goes on without when it can't be saved.
    fn note(&self, change: impl FnOnce(&mut State)) {
        if let Err(e) = self.change_state(change) {
            log::warn!("analytics: cannot save the fetch state: {e:?}");
        }
    }

    /// `workspace:analytics`: `{running, done, total, label, failedDays}`.
    fn emit_progress(&self, running: bool, p: &Progress) {
        let failed = State::load(&self.paths.analytics_dir()).failed_days;
        let payload = json!({"running": running, "done": p.done, "total": p.total, "label": p.label, "failedDays": failed});
        #[cfg(test)]
        if let Ok(mut sent) = self.analytics_events.lock() {
            sent.push(payload.clone());
        }
        if let Some(app) = &self.app {
            let _ = app.emit(EVENT, payload);
        }
    }
}
