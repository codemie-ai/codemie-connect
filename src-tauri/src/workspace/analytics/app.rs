//! App analytics: what Connect itself spent on AI and what it got done, from Connect's own
//! records (`ai_run`, `meeting`, `commitment`, `action`, `decision`, `automation_run`) and the
//! launch log of the terminal dock. The one AI number taken from the CLI is the cost of the
//! sessions the dock started (spec, decision 5).
use super::range_args;
use crate::workspace::models::{Record, Result, WorkspaceError};
use crate::workspace::repository::Repository;
use crate::workspace::{graph, Core};
use chrono::{DateTime, Datelike, Days, FixedOffset, NaiveDate, TimeZone};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

/// The features, in the order the page lists them.
const FEATURES: [&str; 6] = [
    "meeting",
    "draft",
    "summary",
    "automation",
    "plugin",
    "terminal",
];
/// A CLI session counts as started in Connect when it began this close to a launch.
const MATCH_MS: i64 = 120_000;
const RECENT: usize = 50;
/// Windows longer than this many days are drawn by Monday weeks, as the CLI's own series are.
const WEEK_AFTER_DAYS: i64 = 35;
const LAUNCH_LOG: &str = "terminal-launches.jsonl";

/// The feature an `ai_run` purpose belongs to; a purpose that fits none (the Settings test run)
/// is counted in the totals only.
fn feature_of(purpose: &str) -> Option<&'static str> {
    match purpose {
        "meeting" => Some("meeting"),
        "mail_draft" | "chat_draft" => Some("draft"),
        "summary" => Some("summary"),
        "automation" => Some("automation"),
        "plugin" => Some("plugin"),
        _ => None,
    }
}

/// What Connect's records say about the window.
struct Ledger {
    runs: Vec<Record>,
    meetings: Vec<Record>,
    tasks: Vec<Record>,
    sent: usize,
    inbox: usize,
    auto_runs: usize,
    auto_ok: usize,
}

/// A CLI session that began in Connect's terminal.
struct Matched {
    start: i64,
    cost: f64,
    duration: f64,
}

fn at_of(r: &Record) -> i64 {
    r.data["at"].as_i64().unwrap_or(r.updated_at)
}

fn cost_of(r: &Record) -> f64 {
    r.data["costUsd"].as_f64().unwrap_or(0.0)
}

impl Core {
    /// `analytics_app {from, to}`. The CLI is asked for its totals and sessions of the same
    /// window; when it can't answer, the terminal fields are zero and `shareOfAll` (terminal
    /// sessions included) and `backgroundShareOfAll` (background runs only) are `null`. Each
    /// `recent` row carries the `feature` its purpose belongs to (`null` for none).
    pub(super) async fn analytics_app(&self, data: &Value) -> Result<Value> {
        self.analytics_app_in(&chrono::Local, data).await
    }

    /// [`Core::analytics_app`] with the zone the day buckets are cut in (the Mac's own).
    pub(super) async fn analytics_app_in<Tz: TimeZone>(
        &self,
        tz: &Tz,
        data: &Value,
    ) -> Result<Value> {
        // Only the window goes to the CLI: the page's agent and project filters are AI tab ones.
        let window = json!({"from": data["from"], "to": data["to"]});
        let args = range_args(&window)?;
        let (from, to) = parse_window(&args)?;
        let ledger = {
            let repo = self.repo()?;
            ledger(&repo, from.timestamp_millis(), to.timestamp_millis())?
        };
        let launches = self.launches();
        let cli = self.cli_summary(&args).await;
        let (cli_total, sessions) = match &cli {
            Some(summary) => (
                summary["totals"]["costUSD"].as_f64().unwrap_or(0.0),
                summary["sessions"].as_array().cloned().unwrap_or_default(),
            ),
            None => (0.0, Vec::new()),
        };
        let matched = match_sessions(&launches, &sessions);
        Ok(answer(
            tz,
            &ledger,
            &matched,
            cli.is_some().then_some(cli_total),
            from,
            to,
        ))
    }

    /// The CLI's summary of the window, `None` when it is too old or can't answer now.
    async fn cli_summary(&self, args: &[String]) -> Option<Value> {
        if !self.analytics_cli.supports_view().await {
            return None;
        }
        match self
            .analytics_cli
            .view(&self.analytics_store().path(), args)
            .await
        {
            Ok(summary) => Some(summary),
            Err(e) => {
                log::warn!("analytics: the CLI couldn't answer the app view: {e:?}");
                None
            }
        }
    }

    /// The terminal dock's launches, `(at ms, folder)`; a missing or damaged log is no launches.
    pub(super) fn launches(&self) -> Vec<(i64, String)> {
        let text = std::fs::read_to_string(self.paths.private.join(LAUNCH_LOG)).unwrap_or_default();
        text.lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter_map(|v| Some((v["at"].as_i64()?, v["folder"].as_str()?.to_string())))
            .collect()
    }
}

fn parse_window(args: &[String]) -> Result<(DateTime<FixedOffset>, DateTime<FixedOffset>)> {
    let parse = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
    };
    match (parse("--from"), parse("--to")) {
        (Some(from), Some(to)) if from <= to => Ok((from, to)),
        _ => Err(WorkspaceError::new("validation", "Choose a date range.")),
    }
}

fn ledger(repo: &Repository, from_ms: i64, to_ms: i64) -> Result<Ledger> {
    let (from, to) = (from_ms.div_euclid(1000), to_ms.div_euclid(1000));
    let runs = repo.records_updated_between("ai_run", from, to)?;
    let in_range = |ms: i64| (from_ms..=to_ms).contains(&ms);
    let meetings: Vec<Record> = repo
        .records_of_kind("meeting")?
        .into_iter()
        .filter(|m| in_range(graph::timestamp(m.data["start"].as_str().unwrap_or("")) * 1000))
        .collect();
    let ids: HashSet<&str> = meetings.iter().map(|m| m.id.as_str()).collect();
    let tasks = repo
        .records_of_kind("commitment")?
        .into_iter()
        .filter(|t| {
            t.data["meetingId"]
                .as_str()
                .is_some_and(|m| ids.contains(m))
        })
        .collect();
    let sent = repo
        .records_updated_between("action", from, to)?
        .iter()
        .filter(|a| a.data["kind"] == "mail_reply" && a.data["state"] == "accepted")
        .count();
    let inbox = repo
        .records_updated_between("decision", from, to)?
        .iter()
        .filter(|d| d.data["lifecycle"] == "archived" || !d.data["acknowledgedAt"].is_null())
        .count();
    let auto: Vec<Record> = repo
        .records_of_kind("automation_run")?
        .into_iter()
        .filter(|a| in_range(a.data["startedAt"].as_i64().unwrap_or(0) * 1000))
        .collect();
    Ok(Ledger {
        runs,
        meetings,
        tasks,
        sent,
        inbox,
        auto_ok: auto.iter().filter(|a| a.data["status"] == "ok").count(),
        auto_runs: auto.len(),
    })
}

/// Each launch takes at most one session and each session serves at most one launch: the closest
/// pairs first. A pair is a session in the launch's folder that began within [`MATCH_MS`].
fn match_sessions(launches: &[(i64, String)], sessions: &[Value]) -> Vec<Matched> {
    matched_indices(launches, sessions)
        .into_iter()
        .map(|s| Matched {
            start: sessions[s]["startTime"].as_i64().unwrap_or(0),
            cost: sessions[s]["costUSD"].as_f64().unwrap_or(0.0),
            duration: sessions[s]["durationMs"].as_f64().unwrap_or(0.0),
        })
        .collect()
}

/// The indices of the `sessions` that matched a launch.
pub(super) fn matched_indices(launches: &[(i64, String)], sessions: &[Value]) -> Vec<usize> {
    let mut pairs = Vec::new();
    for (l, (at, folder)) in launches.iter().enumerate() {
        for (s, session) in sessions.iter().enumerate() {
            let (Some(start), Some(project)) =
                (session["startTime"].as_i64(), session["project"].as_str())
            else {
                continue;
            };
            let gap = (start - at).abs();
            if gap <= MATCH_MS && project == folder {
                pairs.push((gap, l, s));
            }
        }
    }
    pairs.sort();
    let (mut used_l, mut used_s) = (HashSet::new(), HashSet::new());
    let mut matched = Vec::new();
    for (_, l, s) in pairs {
        if used_l.contains(&l) || used_s.contains(&s) {
            continue;
        }
        used_l.insert(l);
        used_s.insert(s);
        matched.push(s);
    }
    matched
}

fn answer<Tz: TimeZone>(
    tz: &Tz,
    ledger: &Ledger,
    matched: &[Matched],
    cli_total: Option<f64>,
    from: DateTime<FixedOffset>,
    to: DateTime<FixedOffset>,
) -> Value {
    let background: f64 = ledger.runs.iter().map(cost_of).sum();
    let terminal: f64 = matched.iter().map(|m| m.cost).sum();
    // All AI cost on this Mac: Connect's background runs plus every session the CLI counted (the
    // terminal ones among them). Unknown without the CLI, and no share of nothing.
    let all = cli_total
        .map(|cli| background + cli)
        .filter(|all| *all > 0.0);
    let share = all.map(|all| (background + terminal) / all);
    let background_share = all.map(|all| background / all);

    // Per feature: runs, cost, failures and total time.
    let mut by_feature: BTreeMap<&str, (u64, f64, u64, f64)> = BTreeMap::new();
    let mut by_profile: BTreeMap<(String, String), (u64, f64)> = BTreeMap::new();
    for r in &ledger.runs {
        let ok = r.data["status"] == "ok";
        if let Some(key) = feature_of(r.data["purpose"].as_str().unwrap_or("")) {
            let f = by_feature.entry(key).or_default();
            f.0 += 1;
            f.1 += cost_of(r);
            f.2 += u64::from(!ok);
            f.3 += r.data["durationMs"].as_f64().unwrap_or(0.0);
        }
        let name = |k: &str| r.data[k].as_str().unwrap_or("").to_string();
        let p = by_profile
            .entry((name("profile"), name("model")))
            .or_default();
        p.0 += 1;
        p.1 += cost_of(r);
    }
    by_feature.insert(
        "terminal",
        (
            matched.len() as u64,
            terminal,
            0,
            matched.iter().map(|m| m.duration).sum(),
        ),
    );
    let features: Vec<Value> = FEATURES
        .iter()
        .map(|key| {
            let (runs, cost, failed, time) = by_feature.get(key).copied().unwrap_or_default();
            json!({"key": key, "runs": runs, "costUsd": cost, "failed": failed,
                "avgMs": if runs == 0 { 0 } else { (time / runs as f64).round() as u64 }})
        })
        .collect();

    let mut profiles: Vec<_> = by_profile.into_iter().collect();
    profiles.sort_by(|a, b| b.1 .1.total_cmp(&a.1 .1).then_with(|| a.0.cmp(&b.0)));
    let profiles: Vec<Value> = profiles
        .into_iter()
        .map(|((profile, model), (runs, cost))| {
            json!({"profile": profile, "model": model, "runs": runs, "costUsd": cost})
        })
        .collect();

    let cost_of_feature = |key: &str| by_feature.get(key).map_or(0.0, |f| f.1);
    let per = |cost: f64, n: usize| (n > 0).then(|| cost / n as f64);
    let noted = ledger
        .meetings
        .iter()
        .filter(|m| m.data["main"].as_str().is_some_and(|d| !d.is_empty()))
        .count();
    let drafts = ledger
        .runs
        .iter()
        .filter(|r| {
            feature_of(r.data["purpose"].as_str().unwrap_or("")) == Some("draft")
                && r.data["status"] == "ok"
        })
        .count();
    let outcomes = json!({
        "meetings": ledger.meetings.len(),
        "transcribed": ledger.meetings.iter()
            .filter(|m| m.data["transcriptIds"].as_array().is_some_and(|t| !t.is_empty()))
            .count(),
        "noted": noted,
        "tasks": ledger.tasks.len(),
        "tasksDone": ledger.tasks.iter().filter(|t| crate::workspace::tasks::status_of(&t.data) == "done").count(),
        "drafts": drafts,
        "sent": ledger.sent,
        "inboxHandled": ledger.inbox,
        "autoRuns": ledger.auto_runs,
        "autoOk": ledger.auto_ok,
        "perNoteUsd": per(cost_of_feature("meeting"), noted),
        "perSentUsd": per(cost_of_feature("draft"), ledger.sent),
    });

    let mut recent: Vec<&Record> = ledger.runs.iter().collect();
    recent.sort_by(|a, b| at_of(b).cmp(&at_of(a)).then_with(|| b.id.cmp(&a.id)));
    let recent: Vec<Value> = recent
        .into_iter()
        .take(RECENT)
        .map(|r| {
            let mut row = r.data.clone();
            row["id"] = json!(r.id);
            row["at"] = json!(at_of(r));
            row["feature"] = json!(feature_of(r.data["purpose"].as_str().unwrap_or("")));
            row
        })
        .collect();

    json!({
        "totals": {
            "costUsd": background,
            "runs": ledger.runs.len(),
            "failed": ledger.runs.iter().filter(|r| r.data["status"] != "ok").count(),
            "terminalSessions": matched.len(),
            "terminalCostUsd": terminal,
            "shareOfAll": share,
            "backgroundShareOfAll": background_share,
        },
        "series": series_in(tz, ledger, matched, from.timestamp_millis(), to.timestamp_millis()),
        "features": features,
        "profiles": profiles,
        "outcomes": outcomes,
        "recent": recent,
    })
}

/// The window's buckets in the Mac's time zone, as the CLI's `view` makes them: local calendar
/// days, or Monday weeks when the window is longer than 35 days. The first and last are cut to
/// the window; a bucket's `to` is its last millisecond.
pub(super) fn buckets<Tz: TimeZone>(tz: &Tz, from: i64, to: i64) -> Vec<(i64, i64)> {
    let local = |ms: i64| {
        tz.timestamp_millis_opt(ms)
            .earliest()
            .map(|d| d.date_naive())
    };
    let (Some(first), Some(last)) = (local(from), local(to)) else {
        return vec![(from, to)];
    };
    // Midnight starting `date`; where a zone skips midnight, the first hour that exists.
    let midnight = |date: NaiveDate| {
        (0..4)
            .find_map(|h| {
                let t = date.and_hms_opt(h, 0, 0)?;
                tz.from_local_datetime(&t).earliest()
            })
            .map_or(i64::MAX, |d| d.timestamp_millis())
    };
    let weekly = (last - first).num_days() + 1 > WEEK_AFTER_DAYS;
    let mut out = Vec::new();
    let mut start = first;
    while start <= last {
        let end = if weekly {
            start + Days::new(6 - u64::from(start.weekday().num_days_from_monday()))
        } else {
            start
        }
        .min(last);
        out.push((
            midnight(start).max(from),
            (midnight(end + Days::new(1)) - 1).min(to),
        ));
        start = end + Days::new(1);
    }
    out
}

/// Cost per feature in each bucket of the window.
fn series_in<Tz: TimeZone>(
    tz: &Tz,
    ledger: &Ledger,
    matched: &[Matched],
    from: i64,
    to: i64,
) -> Vec<Value> {
    buckets(tz, from, to)
        .into_iter()
        .map(|(start, end)| {
            let mut by: BTreeMap<&str, f64> = FEATURES.iter().map(|k| (*k, 0.0)).collect();
            for r in &ledger.runs {
                let at = at_of(r) * 1000;
                if (start..=end).contains(&at) {
                    if let Some(key) = feature_of(r.data["purpose"].as_str().unwrap_or("")) {
                        *by.entry(key).or_default() += cost_of(r);
                    }
                }
            }
            for m in matched.iter().filter(|m| (start..=end).contains(&m.start)) {
                *by.entry("terminal").or_default() += m.cost;
            }
            json!({"from": start, "to": end, "by": by})
        })
        .collect()
}
