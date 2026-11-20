//! Reading sessions from the CLI into the store, in the background and one fetch at a time. The
//! first open reads 91 UTC days back (90 local days in any zone), newest first, three days per
//! call; once only yesterday and today are left, a refresh reads those two and the start days of
//! sessions that were still active at the last fetch, grouped into calls of up to three days, as
//! few as it can (each call reads every log written since its first day). A call that fails
//! is made again day by day, and a day that still fails waits for a retry (`failed_days`, with
//! why). Two calls in a row that run out of time end the run; its other days are read next time.
//! Days are UTC, because the CLI reads a date-only `--from`/`--to` as UTC days.
use super::cli::{CliError, ExportOutcome};
use super::store::{unavailable, State, EXPORT_PREFIX, KEEP_DAYS};
use crate::workspace::models::{id, Result, WorkspaceError};
use crate::workspace::{poisoned, Core};
use chrono::{DateTime, Days, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::ops::ControlFlow;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::Emitter;

/// How far back the first open reads: 91 UTC days hold the last 90 local days in any zone.
pub(super) const FIRST_OPEN_DAYS: u32 = 91;
/// Days per CLI call: three days peak near 4.2 GB, within the raised heap.
const WINDOW_DAYS: i64 = 3;
/// A refresh reads again the start day of a session active this close before the last fetch…
const ACTIVE_MS: i64 = 48 * 3_600_000;
/// …when that day is at most this many days back.
const ACTIVE_DAYS_BACK: u64 = 7;
/// A run ends after this many calls in a row ran out of time.
const TIMEOUTS_IN_A_ROW: u32 = 2;
/// Why a day failed whose export, written with exit 0, has no `sessions` array.
const BAD_OUTPUT: &str = "bad_output";
/// Progress to the window: `{running, done, total, label, failedDays}`.
const EVENT: &str = "workspace:analytics";

/// What a fetch reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Fetch {
    /// The days not read yet, or yesterday and today (`analytics_refresh`).
    Refresh,
    /// One day again (`analytics_retry {day}`).
    Day(NaiveDate),
    /// Every day that failed (`analytics_retry {}`).
    Failed,
}

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

/// The UTC start days, at most [`ACTIVE_DAYS_BACK`] days back, of the stored sessions active
/// within 48 h before the last fetch: still running then, they may have grown since. `activity`
/// is each session's `(start, last activity)` in ms.
pub fn active_days(
    today: NaiveDate,
    last_fetch_at: Option<i64>,
    activity: &[(i64, i64)],
) -> BTreeSet<NaiveDate> {
    let Some(last) = last_fetch_at else {
        return BTreeSet::new();
    };
    let oldest = today - Days::new(ACTIVE_DAYS_BACK);
    activity
        .iter()
        .filter(|&&(_, end)| end >= last - ACTIVE_MS)
        .filter_map(|&(start, _)| DateTime::from_timestamp_millis(start))
        .map(|start| start.date_naive())
        .filter(|day| (oldest..=today).contains(day))
        .collect()
}

/// What `analytics_refresh` reads, and its label: the first open's windows while a day before
/// yesterday is unread, else yesterday and today ([`plan_refresh`]); with either, the
/// [`active_days`] no window holds. Those days are [`group`]ed, all windows newest first. Failed
/// days wait for a retry.
fn next_fetch(
    today: NaiveDate,
    state: &State,
    activity: &[(i64, i64)],
) -> (Vec<Window>, &'static str) {
    let handled = state
        .days_done
        .iter()
        .chain(state.failed_days.keys())
        .cloned()
        .collect();
    let backlog = plan_first_open(today, FIRST_OPEN_DAYS, &handled);
    let yesterday = today - Days::new(1);
    let (mut windows, label) = if backlog.iter().any(|&(from, _)| from < yesterday) {
        (backlog, "Reading your history, newest first")
    } else {
        (Vec::new(), "Reading yesterday and today")
    };
    let mut again: BTreeSet<NaiveDate> = active_days(today, state.last_fetch_at, activity)
        .into_iter()
        .filter(|day| !state.failed_days.contains_key(&key(*day)))
        .filter(|day| !windows.iter().any(|&(from, to)| from <= *day && *day <= to))
        .collect();
    if windows.is_empty() {
        let (from, to) = plan_refresh(today);
        again.extend([from, to]);
    }
    windows.extend(group(&again, |day| state.days_done.contains(&key(day))));
    // The windows don't overlap: newest first is by their last day.
    windows.sort_by_key(|w| std::cmp::Reverse(w.1));
    (windows, label)
}

/// `days` newest first, in windows of up to [`WINDOW_DAYS`] days. A window takes in the days
/// between two of them only when all of those were `read` already (they are read again, which
/// loses nothing), so it never holds a failed day or one another window reads.
fn group(days: &BTreeSet<NaiveDate>, read: impl Fn(NaiveDate) -> bool) -> Vec<Window> {
    let mut windows: Vec<Window> = Vec::new();
    for &day in days.iter().rev() {
        match windows.last_mut() {
            Some((from, to))
                if (*to - day).num_days() < WINDOW_DAYS
                    && day
                        .iter_days()
                        .skip(1)
                        .take_while(|d| *d < *from)
                        .all(&read) =>
            {
                *from = day;
            }
            _ => windows.push((day, day)),
        }
    }
    windows
}

/// Every failed day, each a window of its own, newest first.
fn failed_windows(state: &State) -> Vec<Window> {
    state
        .failed_days
        .keys()
        .rev()
        .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .map(|day| (day, day))
        .collect()
}

/// Marks `from..=to` read. Today isn't over, so it stays unread and the next fetch reads it again.
/// Days older than the store keeps are forgotten, read or failed: their sessions are gone.
fn mark_read(state: &mut State, (from, to): Window, today: NaiveDate) {
    for day in from.iter_days().take_while(|d| *d <= to) {
        state.failed_days.remove(&key(day));
        if day < today {
            state.days_done.insert(key(day));
        }
    }
    let oldest = key(today - Days::new(KEEP_DAYS));
    state.days_done.retain(|day| *day >= oldest);
    state.failed_days.retain(|day, _| *day >= oldest);
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
    /// With why, as the day keeps it.
    Failed(String),
    Stop,
}

impl Core {
    /// `analytics_refresh` and `analytics_retry`: starts the fetch in the background and answers
    /// at once. Nothing starts when the CLI can't answer `view`, or while a fetch runs.
    pub(super) async fn start_fetch(
        self: &Arc<Self>,
        today: NaiveDate,
        what: Fetch,
    ) -> Result<Value> {
        let running = || Ok::<_, WorkspaceError>(json!({"running": true}));
        // First: `--help` is a CLI process too, and none starts while a fetch runs.
        if self.analytics_run.lock().map_err(|_| poisoned())?.is_some() {
            return running();
        }
        if !self.cli_supports_view().await {
            return Ok(json!({"needsCli": true}));
        }
        // Opened before planning: a store found unreadable is set aside with its state, so the
        // plan starts over. Opening also makes the folder the CLI exports into. A store is
        // opened once, before any fetch, so a fetch running by now finds it open.
        let store = self.analytics_store().clone();
        let dir = self.paths.analytics_dir();
        // What the stored sessions last did, for a refresh after an earlier one: the whole store
        // is read, off the async runtime.
        let activity = if what == Fetch::Refresh && State::load(&dir).last_fetch_at.is_some() {
            tokio::task::spawn_blocking(move || store.activity())
                .await
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let (windows, progress) = {
            let mut run = self.analytics_run.lock().map_err(|_| poisoned())?;
            // Again: one may have started while `--help` or the store was read.
            if run.is_some() {
                return running();
            }
            // Planned under the guard, so no fetch is changing the state meanwhile.
            let state = State::load(&dir);
            let (windows, label) = match what {
                Fetch::Refresh => {
                    let (windows, label) = next_fetch(today, &state, &activity);
                    (windows, label.to_string())
                }
                Fetch::Day(day) => (vec![(day, day)], format!("Reading {}", key(day))),
                Fetch::Failed => (
                    failed_windows(&state),
                    "Reading the failed days again".to_string(),
                ),
            };
            let progress = Progress {
                done: 0,
                total: windows.iter().map(length).sum(),
                label,
            };
            *run = Some(progress.clone());
            (windows, progress)
        };
        tokio::spawn(self.clone().fetch(windows, today, progress, what));
        Ok(json!({"started": true}))
    }

    /// Reads `windows`. Only a refresh that read them all moves `last_fetch_at`: a retry reads no
    /// new day.
    async fn fetch(
        self: Arc<Self>,
        windows: Vec<Window>,
        today: NaiveDate,
        mut p: Progress,
        what: Fetch,
    ) {
        let running = Running(self.clone());
        self.emit_progress(true, &p);
        let mut finished = true;
        let mut timeouts = 0;
        for window in windows {
            if self.stop.load(Ordering::Relaxed)
                || self
                    .read_window(window, today, &mut timeouts)
                    .await
                    .is_break()
            {
                finished = false;
                break;
            }
            p.done += length(&window);
            if let Ok(mut run) = self.analytics_run.lock() {
                *run = Some(p.clone());
            }
            self.emit_progress(true, &p);
        }
        if finished && what == Fetch::Refresh {
            let at = Utc::now().timestamp_millis();
            self.note(|s| s.last_fetch_at = Some(at));
        }
        drop(running);
        self.emit_progress(false, &p);
    }

    /// One window; when its call fails, its days one by one, newest first. `timeouts` counts the
    /// calls in a row that ran out of time.
    async fn read_window(
        self: &Arc<Self>,
        (from, to): Window,
        today: NaiveDate,
        timeouts: &mut u32,
    ) -> ControlFlow<()> {
        match self.read_days((from, to), today, timeouts).await {
            Read::Done => return ControlFlow::Continue(()),
            Read::Stop => return ControlFlow::Break(()),
            Read::Failed(reason) if from == to => {
                self.note(|s| {
                    s.failed_days.insert(key(from), reason);
                });
                return ControlFlow::Continue(());
            }
            Read::Failed(_) => {}
        }
        for back in 0..length(&(from, to)) as u64 {
            let day = to - Days::new(back);
            match self.read_days((day, day), today, timeouts).await {
                Read::Done => {}
                Read::Failed(reason) => self.note(|s| {
                    s.failed_days.insert(key(day), reason);
                }),
                Read::Stop => return ControlFlow::Break(()),
            }
        }
        ControlFlow::Continue(())
    }

    /// One CLI call, merged into the store; then its days are marked read. The fetch stops when
    /// Connect quits, the CLI is gone, the files can't be written, or this is the second call in
    /// a row that ran out of time (its days stay unread, not failed).
    async fn read_days(
        self: &Arc<Self>,
        window: Window,
        today: NaiveDate,
        timeouts: &mut u32,
    ) -> Read {
        let (from, to) = window;
        let out = self
            .paths
            .analytics_dir()
            .join(format!("{EXPORT_PREFIX}{}.json", id()));
        let outcome = self.analytics_cli.export(from, to, &out).await;
        let export = std::fs::read(&out);
        let _ = std::fs::remove_file(&out);
        // A call Connect stopped as it quits: nothing of it is read, failed or marked.
        if self.stop.load(Ordering::Relaxed) {
            return Read::Stop;
        }
        let what = format!("export {}..{}", key(from), key(to));
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(CliError::Stopped) => return Read::Stop,
            Err(e) => {
                self.cli_failed(&what, &super::how(&e));
                return match e {
                    CliError::NotFound => Read::Stop,
                    CliError::Timeout => {
                        *timeouts += 1;
                        if *timeouts >= TIMEOUTS_IN_A_ROW {
                            Read::Stop
                        } else {
                            Read::Failed(e.reason())
                        }
                    }
                    _ => {
                        *timeouts = 0;
                        Read::Failed(e.reason())
                    }
                };
            }
        };
        *timeouts = 0;
        // An export written with exit 0 still has to be one: without a `sessions` array its
        // days aren't read.
        let export = match outcome {
            ExportOutcome::Written => {
                let export = export
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                    .filter(|v| v["sessions"].is_array());
                let Some(export) = export else {
                    self.cli_failed(&what, "exit 0, but no sessions array in its file");
                    return Read::Failed(BAD_OUTPUT.into());
                };
                Some(export)
            }
            ExportOutcome::Empty => None,
        };
        // The same fence plugin installs use: a data-folder change waits for this write and
        // refuses the next, which ends the fetch. Days not written are read again later.
        let Ok(_write) = self.begin_plugin_op() else {
            return Read::Stop;
        };
        // The whole store is read and written: off the async runtime.
        let store = self.analytics_store().clone();
        let stored = tokio::task::spawn_blocking(move || match export {
            Some(export) => store.merge(export, today).map(|_| ()),
            None => store.extend_period(from, today),
        })
        .await
        .unwrap_or_else(|_| Err(unavailable()));
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

    /// `workspace:analytics`: `{running, done, total, label, failedDays}`, the failed days as
    /// `[{day, reason}]`.
    fn emit_progress(&self, running: bool, p: &Progress) {
        let failed = State::load(&self.paths.analytics_dir()).failed_list();
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
