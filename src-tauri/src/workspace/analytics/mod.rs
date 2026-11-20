//! Analytics: the CodeMie CLI run as a binary (`cli`), the sessions it exported, kept in the data
//! folder (`store`), and the background fetch that fills the store (`fetch`). The operations here
//! are read-only: every number comes from `codemie analytics view` over the store and goes to
//! the page unchanged.
pub(crate) mod app;
pub(crate) mod cli;
pub(crate) mod fetch;
pub(crate) mod store;

#[cfg(test)]
mod app_tests;
#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod tests;

use crate::workspace::models::{required, Operation, Request, Result, WorkspaceError};
use crate::workspace::{poisoned, Core};
use chrono::{DateTime, NaiveDate, Utc};
use cli::CliError;
use fetch::Fetch;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use store::{State, Store};

/// The CLI's HTML reports, `report-<unique>.html` in the private root: one per press, so the
/// browser never reads a file the next report is writing. The older ones go at the next report.
const REPORT_PREFIX: &str = "report-";
/// The longest filter value passed on: a project is a folder path.
const ARGUMENT_MAX: usize = 1000;
/// What the CLI's summary and session answers name themselves, up to their version.
pub(super) const SUMMARY_SCHEMA: &str = "codemie.analytics.summary/";
const SESSION_SCHEMA: &str = "codemie.analytics.session/";
/// Said when the CLI answers in a shape this Connect wasn't built for.
const INCOMPATIBLE: &str =
    "This CodeMie CLI answers in a format this Connect doesn't read yet. Update Connect.";
/// The longest stderr line the session log keeps of a failed call.
const LOG_LINE_MAX: usize = 300;

impl Core {
    /// The analytics operations: no operation id and no revision, answered before the mutation
    /// lock. A fetch runs in the background and reports on `workspace:analytics`.
    pub(super) async fn analytics_request(self: &Arc<Self>, req: &Request) -> Result<Value> {
        let today = Utc::now().date_naive();
        match req.op {
            Operation::AnalyticsStatus => self.analytics_status().await,
            Operation::AnalyticsRefresh => self.start_fetch(today, Fetch::Refresh).await,
            Operation::AnalyticsRetry => {
                let what = retry_day(&req.data, today)?.map_or(Fetch::Failed, Fetch::Day);
                self.start_fetch(today, what).await
            }
            Operation::AnalyticsView => {
                let mut args = range_args(&req.data)?;
                if req.data["compare"].as_bool() == Some(true) {
                    args.push("--compare".into());
                }
                self.analytics_summary(&args).await
            }
            Operation::AnalyticsSession => {
                let id = argument(required(&req.data, "id", 200)?)?;
                let args = ["--session".into(), id.into()];
                self.analytics_view("analytics_session", &args, SESSION_SCHEMA)
                    .await
            }
            Operation::AnalyticsReport => self.analytics_report(&req.data, open_report).await,
            Operation::AnalyticsApp => self.analytics_app(&req.data).await,
            _ => Err(WorkspaceError::new("validation", "Unsupported operation.")),
        }
    }

    /// `{state, lastFetchAt, storedFrom, sessions, failedDays, progress}`, the failed days as
    /// `[{day, reason}]`. `needs_cli` comes first, as no fetch can start then; `empty` is a store
    /// with no sessions and no fetch.
    async fn analytics_status(&self) -> Result<Value> {
        let supported = self.cli_supports_view().await;
        let progress = self.analytics_run.lock().map_err(|_| poisoned())?.clone();
        let store = self.analytics_store().clone();
        let sessions = tokio::task::spawn_blocking(move || store.count())
            .await
            .map_err(|_| store::unavailable())??;
        let state = State::load(&self.paths.analytics_dir());
        let name = if !supported {
            "needs_cli"
        } else if progress.is_some() {
            "running"
        } else if sessions == 0 {
            "empty"
        } else {
            "ready"
        };
        Ok(json!({
            "state": name,
            "lastFetchAt": state.last_fetch_at,
            "storedFrom": state.stored_from,
            "sessions": sessions,
            "failedDays": state.failed_list(),
            "progress": progress,
        }))
    }

    /// The CLI's summary plus `connect.startedInConnect`: the ids of its sessions that Connect's
    /// terminal started, by the same launch-log match the App tab uses.
    async fn analytics_summary(&self, args: &[String]) -> Result<Value> {
        let mut summary = self
            .analytics_view("analytics_view", args, SUMMARY_SCHEMA)
            .await?;
        let rows = summary["sessions"].as_array().cloned().unwrap_or_default();
        let started: Vec<Value> = app::matched_indices(&self.launches(), &rows)
            .into_iter()
            .filter_map(|i| rows[i]["sessionId"].as_str().map(|id| json!(id)))
            .collect();
        if let Some(object) = summary.as_object_mut() {
            object.insert("connect".into(), json!({"startedInConnect": started}));
        }
        Ok(summary)
    }

    /// `codemie analytics view --input <store> <args>` for the operation `op`: its JSON as it is,
    /// when its `schema` starts with `schema` (`cli_incompatible` otherwise). An empty store goes
    /// to the CLI too, which answers its own empty summary.
    pub(super) async fn analytics_view(
        &self,
        op: &str,
        args: &[String],
        schema: &str,
    ) -> Result<Value> {
        let input = self.analytics_store().path();
        let answer = self
            .analytics_cli
            .view(&input, args)
            .await
            .map_err(|e| self.cli_error(op, e))?;
        let named = answer["schema"].as_str();
        if !named.is_some_and(|s| s.starts_with(schema)) {
            let named: String = named.unwrap_or("none").chars().take(80).collect();
            self.cli_failed(op, &format!("exit 0, but its answer is schema {named:?}"));
            return Err(WorkspaceError::new("cli_incompatible", INCOMPATIBLE));
        }
        Ok(answer)
    }

    /// `analytics_report`: the CLI writes its HTML report to a new file in the private root (the
    /// ones before it are removed), then `open` shows it (the default browser in the app).
    async fn analytics_report(
        &self,
        data: &Value,
        open: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<Value> {
        let args = range_args(data)?;
        let input = self.analytics_store().path();
        sweep_reports(&self.paths.private);
        let out = self
            .paths
            .private
            .join(format!("{REPORT_PREFIX}{}.html", uuid::Uuid::new_v4()));
        self.analytics_cli
            .report(&input, &args, &out)
            .await
            .map_err(|e| self.cli_error("analytics_report", e))?;
        open(&out)?;
        Ok(json!({"opened": true}))
    }

    /// Whether the CLI answers `view`. A yes is kept until a CLI call fails (the CLI may have
    /// been removed or replaced), so `--help` isn't run for every status, refresh and App read.
    pub(super) async fn cli_supports_view(&self) -> bool {
        if self.analytics_supported.load(Ordering::Relaxed) {
            return true;
        }
        let yes = self.analytics_cli.supports_view().await;
        if yes {
            self.analytics_supported.store(true, Ordering::Relaxed);
        }
        yes
    }

    /// A CLI call failed: `view` support is asked again next time, and one line goes to the
    /// session log, which release builds keep. `what` is the operation or an export's UTC days,
    /// `how` its end ([`how`]): never session content or paths.
    pub(super) fn cli_failed(&self, what: &str, how: &str) {
        self.analytics_supported.store(false, Ordering::Relaxed);
        let line = format!("analytics: {what} failed: {how}");
        #[cfg(test)]
        if let Ok(mut lines) = self.analytics_log.lock() {
            lines.push(line);
        }
        #[cfg(not(test))]
        crate::commands::logger::write_line(&line, "stderr");
    }

    /// The error a failed CLI call of the operation `op` answers, noted by [`Self::cli_failed`]
    /// (unless Connect is quitting).
    fn cli_error(&self, op: &str, e: CliError) -> WorkspaceError {
        if e != CliError::Stopped {
            self.cli_failed(op, &how(&e));
        }
        error_of(e)
    }

    /// The store in this Core's data root, opened on first use. Opened once: opening clears
    /// leftovers of a crashed write, which must not race a fetch writing.
    fn analytics_store(&self) -> &Store {
        self.analytics_store
            .get_or_init(|| Store::open(&self.paths.analytics_dir()))
    }
}

/// The UTC day `analytics_retry {day}` reads again: one that has begun. `None` without a day:
/// every failed day is read again.
fn retry_day(data: &Value, today: NaiveDate) -> Result<Option<NaiveDate>> {
    if data["day"].is_null() {
        return Ok(None);
    }
    data["day"]
        .as_str()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .filter(|d| *d <= today)
        .map(Some)
        .ok_or_else(|| WorkspaceError::new("validation", "Choose a day as YYYY-MM-DD."))
}

/// `--from X --to Y` (times with an offset, made by the page from local days) and the agent and
/// project filters it set.
fn range_args(data: &Value) -> Result<Vec<String>> {
    let mut args = Vec::new();
    for key in ["from", "to"] {
        let value = required(data, key, 64)?;
        if DateTime::parse_from_rfc3339(value).is_err() {
            return Err(WorkspaceError::new("validation", "Choose a date range."));
        }
        args.extend([format!("--{key}"), value.to_string()]);
    }
    for key in ["agent", "project"] {
        if let Some(value) = data[key].as_str().map(str::trim).filter(|v| !v.is_empty()) {
            args.extend([format!("--{key}"), argument(value)?.to_string()]);
        }
    }
    Ok(args)
}

/// A value passed to the CLI as it is; one starting with `-` would read as a flag.
fn argument(value: &str) -> Result<&str> {
    if value.starts_with('-') || value.chars().count() > ARGUMENT_MAX || value.contains('\0') {
        return Err(WorkspaceError::new(
            "validation",
            "That filter can't be passed to the CodeMie CLI.",
        ));
    }
    Ok(value)
}

fn error_of(e: CliError) -> WorkspaceError {
    match e {
        CliError::NotFound => {
            WorkspaceError::new("needs_cli", "Analytics needs a newer CodeMie CLI.")
        }
        CliError::Timeout => WorkspaceError::new(
            "timeout",
            "The CodeMie CLI took too long to answer. Try again.",
        ),
        CliError::Stopped => WorkspaceError::new("busy", "Connect is quitting."),
        CliError::Failed { code, stderr_tail } => {
            let mut message = format!("The CodeMie CLI stopped with exit code {code}.");
            if let Some(last) = last_line(&stderr_tail) {
                message = format!("{message} {last}");
            }
            WorkspaceError::new("cli_failed", message)
        }
    }
}

/// The last line of a failed call's stderr with any text.
fn last_line(stderr_tail: &str) -> Option<&str> {
    stderr_tail.lines().map(str::trim).rfind(|l| !l.is_empty())
}

/// How a CLI call ended, for the session log: `timeout`, `not_found`, or `exit <n>` with the
/// last stderr line, cut at [`LOG_LINE_MAX`] characters.
pub(super) fn how(e: &CliError) -> String {
    match e {
        CliError::Failed { code, stderr_tail } => match last_line(stderr_tail) {
            Some(last) => format!(
                "exit {code}: {}",
                last.chars().take(LOG_LINE_MAX).collect::<String>()
            ),
            None => format!("exit {code}"),
        },
        other => other.reason(),
    }
}

/// Removes the reports earlier presses wrote; one the browser still shows has been read.
fn sweep_reports(private: &Path) {
    let Ok(entries) = std::fs::read_dir(private) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(REPORT_PREFIX) && name.ends_with(".html") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Opens the report in the default browser.
fn open_report(path: &Path) -> Result<()> {
    crate::commands::logger::spawn_open(&path.to_string_lossy())
        .map_err(|_| WorkspaceError::new("io", "Connect couldn't open the report."))
}
