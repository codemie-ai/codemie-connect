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
mod tests;

use crate::workspace::models::{required, Operation, Request, Result, WorkspaceError};
use crate::workspace::{poisoned, Core};
use chrono::{DateTime, NaiveDate, Utc};
use cli::CliError;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use store::{State, Store};

/// The CLI's HTML report, written beside the store.
const REPORT: &str = "report.html";
/// The longest filter value passed on: a project is a folder path.
const ARGUMENT_MAX: usize = 1000;

impl Core {
    /// The analytics operations: no operation id and no revision, answered before the mutation
    /// lock. A fetch runs in the background and reports on `workspace:analytics`.
    pub(super) async fn analytics_request(self: &Arc<Self>, req: &Request) -> Result<Value> {
        let today = Utc::now().date_naive();
        match req.op {
            Operation::AnalyticsStatus => self.analytics_status().await,
            Operation::AnalyticsRefresh => self.start_fetch(today, None).await,
            Operation::AnalyticsRetry => {
                let day = retry_day(&req.data, today)?;
                self.start_fetch(today, Some(day)).await
            }
            Operation::AnalyticsView => {
                let mut args = range_args(&req.data)?;
                if req.data["compare"].as_bool() == Some(true) {
                    args.push("--compare".into());
                }
                self.analytics_view(&args).await
            }
            Operation::AnalyticsSession => {
                let id = argument(required(&req.data, "id", 200)?)?;
                self.analytics_view(&["--session".into(), id.into()]).await
            }
            Operation::AnalyticsReport => self.analytics_report(&req.data, open_report).await,
            Operation::AnalyticsApp => self.analytics_app(&req.data).await,
            _ => Err(WorkspaceError::new("validation", "Unsupported operation.")),
        }
    }

    /// `{state, lastFetchAt, storedFrom, sessions, failedDays, progress}`. `needs_cli` comes
    /// first, as no fetch can start then; `empty` is a store with no sessions and no fetch.
    async fn analytics_status(&self) -> Result<Value> {
        let supported = self.analytics_cli.supports_view().await;
        let progress = self.analytics_run.lock().map_err(|_| poisoned())?.clone();
        let sessions = self.analytics_store().count()?;
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
            "failedDays": state.failed_days,
            "progress": progress,
        }))
    }

    /// `codemie analytics view --input <store> <args>`: its JSON as it is. An empty store goes to
    /// the CLI too, which answers its own empty summary.
    async fn analytics_view(&self, args: &[String]) -> Result<Value> {
        let input = self.analytics_store().path();
        self.analytics_cli
            .view(&input, args)
            .await
            .map_err(cli_error)
    }

    /// `analytics_report`: the CLI writes its HTML report into the data root, then `open` shows
    /// it (the default browser in the app).
    async fn analytics_report(
        &self,
        data: &Value,
        open: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<Value> {
        let args = range_args(data)?;
        let input = self.analytics_store().path();
        let out = self.paths.analytics_dir().join(REPORT);
        self.analytics_cli
            .report(&input, &args, &out)
            .await
            .map_err(cli_error)?;
        open(&out)?;
        Ok(json!({"opened": true}))
    }

    /// The store in this Core's data root, opened on first use. Opened once: opening clears
    /// leftovers of a crashed write, which must not race a fetch writing.
    fn analytics_store(&self) -> &Store {
        self.analytics_store
            .get_or_init(|| Store::open(&self.paths.analytics_dir()))
    }
}

/// The UTC day `analytics_retry` reads again: one that has begun.
fn retry_day(data: &Value, today: NaiveDate) -> Result<NaiveDate> {
    data["day"]
        .as_str()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .filter(|d| *d <= today)
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

fn cli_error(e: CliError) -> WorkspaceError {
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
            log::warn!("analytics: the CLI ended with {code}: {stderr_tail}");
            let last = stderr_tail.lines().map(str::trim).rfind(|l| !l.is_empty());
            let mut message = format!("The CodeMie CLI stopped with exit code {code}.");
            if let Some(last) = last {
                message = format!("{message} {last}");
            }
            WorkspaceError::new("cli_failed", message)
        }
    }
}

/// Opens the report in the default browser.
fn open_report(path: &Path) -> Result<()> {
    crate::commands::logger::spawn_open(&path.to_string_lossy())
        .map_err(|_| WorkspaceError::new("io", "Connect couldn't open the report."))
}
