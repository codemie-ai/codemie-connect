//! The sessions Connect has read from the CLI, in the CLI's own export shape
//! (`{meta, sessions}`), and the fetch state beside them. Every write is atomic. The store is
//! read and written whole: callers run it off the async runtime.
use super::cli::VIEW_PREFIX;
use crate::storage::location::write_atomic;
use crate::workspace::models::{Result, WorkspaceError};
use chrono::{Days, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const SESSIONS: &str = "sessions.json";
const STATE: &str = "state.json";
/// Each CLI call writes its export to `export-<unique>.json` beside the store, so a CLI left
/// running by an earlier Connect can never write the file the current fetch reads.
pub(super) const EXPORT_PREFIX: &str = "export-";
/// Sessions that started longer ago than this are dropped at the next merge: the page shows at
/// most 90 days, and their comparison reaches 90 more.
const KEEP_DAYS: u64 = 180;

/// The analytics files can't be read or written. The Analytics page's own error: it never takes
/// the app to the recovery page, as `storage_unavailable` would.
pub fn unavailable() -> WorkspaceError {
    WorkspaceError::new(
        "analytics_unavailable",
        "Connect couldn't read or write its analytics files. Check the disk and try again.",
    )
}

fn io(e: std::io::Error) -> WorkspaceError {
    log::warn!("analytics: storage error: {e}");
    unavailable()
}

fn empty_export() -> Value {
    json!({"meta": {"periodStart": null}, "sessions": []})
}

#[derive(Clone)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    /// Opens the store in `dir`: leftovers of a crashed write or a killed export are removed,
    /// and a missing `sessions.json` is written empty, so `view` always has an input. Only the
    /// leaf folder is created; a data folder that went away is not recreated.
    pub fn open(dir: &Path) -> Store {
        let store = Store {
            path: dir.join(SESSIONS),
        };
        match std::fs::create_dir(dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => log::warn!("analytics: cannot create {}: {e}", dir.display()),
        }
        remove_leftovers(dir);
        if let Err(e) = store.load() {
            log::warn!("analytics: cannot prepare the store: {e:?}");
        }
        store
    }

    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }

    /// How many sessions are stored, read past their bodies without building them.
    pub fn count(&self) -> Result<usize> {
        #[derive(Deserialize)]
        struct Count {
            sessions: Vec<serde::de::IgnoredAny>,
        }
        if let Ok(bytes) = std::fs::read(&self.path) {
            if let Ok(count) = serde_json::from_slice::<Count>(&bytes) {
                return Ok(count.sessions.len());
            }
        }
        Ok(self.load()?["sessions"].as_array().map_or(0, Vec::len))
    }

    /// The stored export. A file that is missing is written empty; one that cannot be read as an
    /// export is renamed to `sessions.json.bad` and replaced by an empty one.
    fn load(&self) -> Result<Value> {
        match std::fs::read(&self.path) {
            Ok(bytes) => {
                if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                    if v["sessions"].is_array() {
                        return Ok(v);
                    }
                }
                let bad = self.path.with_extension("json.bad");
                log::warn!(
                    "analytics: {} is unreadable; moved to {}",
                    SESSIONS,
                    bad.display()
                );
                std::fs::rename(&self.path, &bad).map_err(io)?;
                // The days it held go with it: the state is dropped, so they are read again.
                let _ = std::fs::remove_file(self.path.with_file_name(STATE));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io(e)),
        }
        let fresh = empty_export();
        self.write(&fresh)?;
        Ok(fresh)
    }

    fn write(&self, export: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(export).map_err(|e| io(e.into()))?;
        write_atomic(&self.path, &bytes).map_err(io)
    }

    /// Upserts the sessions of `export` by `sessionId`; a stored row that ended later than the
    /// incoming one stays (a stale window never undoes a fresher read). Sessions that started
    /// more than [`KEEP_DAYS`] days before `today` (UTC) are dropped, stored or incoming.
    /// `meta.periodStart` becomes the earlier of the stored value and the export's own (a missing
    /// or unreadable one is ignored), so it is the earliest day fetched, as the CLI's `--compare`
    /// coverage check expects. Returns how many sessions were added or changed. There is no lock
    /// in here: callers must serialize merges (the single-fetch guard does).
    pub fn merge(&self, mut export: Value, today: NaiveDate) -> Result<usize> {
        let mut stored = self.load()?;
        let since = (today - Days::new(KEEP_DAYS))
            .and_hms_opt(0, 0, 0)
            .map_or(i64::MIN, |t| t.and_utc().timestamp_millis());
        // A row without a start can't be told old: it stays.
        let kept = |row: &Value| row["startTime"].as_i64().is_none_or(|t| t >= since);
        let mut rows: BTreeMap<String, Value> = BTreeMap::new();
        for row in rows_of(&mut stored) {
            if let Some(id) = row["sessionId"].as_str().map(str::to_string) {
                if kept(&row) {
                    rows.insert(id, row);
                }
            }
        }
        let mut changed = 0;
        let period = [period_day(&stored["meta"]), period_day(&export["meta"])]
            .into_iter()
            .flatten()
            .min();
        for row in rows_of(&mut export) {
            let Some(id) = row["sessionId"].as_str().map(str::to_string) else {
                continue;
            };
            if !kept(&row) {
                continue;
            }
            match rows.get(&id) {
                Some(old) if *old == row || ends(old) > ends(&row) => {}
                _ => {
                    rows.insert(id, row);
                    changed += 1;
                }
            }
        }
        let mut sessions: Vec<Value> = rows.into_values().collect();
        sessions.sort_by_key(|r| {
            (
                r["startTime"].as_i64().unwrap_or(0),
                r["sessionId"].to_string(),
            )
        });
        let mut meta = stored["meta"].take();
        if !meta.is_object() {
            meta = json!({});
        }
        meta["periodStart"] = period.map_or(Value::Null, period_json);
        self.write(&json!({"meta": meta, "sessions": sessions}))?;
        Ok(changed)
    }

    /// When each stored session started and was last active (its log's last line, or start plus
    /// duration), in ms, read past the rest of each row. Empty when the store can't be read.
    pub fn activity(&self) -> Vec<(i64, i64)> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Row {
            start_time: Option<f64>,
            observed_end: Option<f64>,
            duration_ms: Option<f64>,
        }
        #[derive(Deserialize)]
        struct Rows {
            sessions: Vec<Row>,
        }
        let Some(rows) = std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Rows>(&b).ok())
        else {
            return Vec::new();
        };
        rows.sessions
            .into_iter()
            .filter_map(|r| {
                let start = r.start_time?;
                let end = r
                    .observed_end
                    .unwrap_or(start + r.duration_ms.unwrap_or(0.0));
                Some((start as i64, end as i64))
            })
            .collect()
    }

    /// Moves `meta.periodStart` back to `from` when that is earlier than it (or it is null). For a
    /// window the CLI answered with no file: nothing to merge, but the days were read. Writes
    /// only when something changes.
    pub fn extend_period(&self, from: NaiveDate) -> Result<()> {
        let mut stored = self.load()?;
        if period_day(&stored["meta"]).is_some_and(|d| d <= from) {
            return Ok(());
        }
        if !stored["meta"].is_object() {
            stored["meta"] = json!({});
        }
        stored["meta"]["periodStart"] = period_json(from);
        self.write(&stored)
    }
}

/// The rows of an export, moved out of it.
fn rows_of(export: &mut Value) -> Vec<Value> {
    match export["sessions"].take() {
        Value::Array(rows) => rows,
        _ => Vec::new(),
    }
}

/// The day of an export's `meta.periodStart` (`YYYY-MM-DDT...`).
fn period_day(meta: &Value) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(meta["periodStart"].as_str()?.get(..10)?, "%Y-%m-%d").ok()
}

/// The CLI export's own format for a day start.
fn period_json(day: NaiveDate) -> Value {
    json!(format!("{}T00:00:00.000Z", day.format("%Y-%m-%d")))
}

/// When the session's record stops: the log's last line, or start plus duration.
fn ends(row: &Value) -> i64 {
    row["observedEnd"].as_i64().unwrap_or_else(|| {
        row["startTime"].as_i64().unwrap_or(0) + row["durationMs"].as_i64().unwrap_or(0)
    })
}

fn remove_leftovers(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let crashed_write =
            name.ends_with(".tmp") && (name.starts_with(SESSIONS) || name.starts_with(STATE));
        // What a killed export call left.
        let export = name.starts_with(EXPORT_PREFIX) && name.ends_with(".json");
        let view = name.starts_with(VIEW_PREFIX) && name.ends_with(".json");
        if crashed_write || export || view {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// What the fetcher knows between runs (`state.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub cli_version: Option<String>,
    /// The oldest day (YYYY-MM-DD) read so far; the first open reads back 91 UTC days.
    pub stored_from: Option<String>,
    pub days_done: BTreeSet<String>,
    /// Days that couldn't be read, with why (`CliError::reason`, or `bad_output`).
    pub failed_days: BTreeMap<String, String>,
    /// Unix milliseconds of the last successful fetch.
    pub last_fetch_at: Option<i64>,
}

impl State {
    /// The saved state, or an empty one when there is none or it can't be read: the days are
    /// then read again, which costs time and loses nothing.
    pub fn load(dir: &Path) -> State {
        std::fs::read(dir.join(STATE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| io(e.into()))?;
        write_atomic(&dir.join(STATE), &bytes).map_err(io)
    }

    /// The failed days as the page gets them: `[{day, reason}]`, oldest first.
    pub fn failed_list(&self) -> Value {
        self.failed_days
            .iter()
            .map(|(day, reason)| json!({"day": day, "reason": reason}))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn session(id: &str, start: i64, dur: i64, cost: f64) -> Value {
        json!({"sessionId": id, "startTime": start, "durationMs": dur, "costUSD": cost})
    }
    fn export(sessions: Vec<Value>) -> Value {
        json!({"meta": {"periodStart": null}, "sessions": sessions})
    }
    fn read(s: &Store) -> Value {
        serde_json::from_slice(&std::fs::read(s.path()).unwrap()).unwrap()
    }
    // 2026-11-18T10:00Z and 2026-11-10T10:00Z
    const NOV18: i64 = 1_794_996_000_000;
    const NOV10: i64 = 1_794_304_800_000;
    /// The UTC day the merges happen on.
    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, 19).unwrap()
    }

    #[test]
    fn a_new_store_starts_with_an_empty_export() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path());
        assert_eq!(
            read(&s),
            json!({"meta": {"periodStart": null}, "sessions": []})
        );
    }

    #[test]
    fn merge_upserts_by_session_id_and_keeps_the_newer_row() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path());
        assert_eq!(
            s.merge(
                export(vec![
                    session("a", NOV18, 1000, 1.0),
                    session("b", NOV18, 5, 2.0)
                ]),
                today()
            )
            .unwrap(),
            2
        );
        // "a" grew (the session was still running), "b" arrives stale, "c" is new.
        let n = s
            .merge(
                export(vec![
                    session("a", NOV18, 9000, 1.5),
                    session("b", NOV18, 1, 9.0),
                    session("c", NOV10, 1, 0.1),
                ]),
                today(),
            )
            .unwrap();
        assert_eq!(n, 2);
        let rows = read(&s)["sessions"].clone();
        let by = |id: &str| {
            rows.as_array()
                .unwrap()
                .iter()
                .find(|r| r["sessionId"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(by("a")["costUSD"], 1.5);
        assert_eq!(by("b")["costUSD"], 2.0);
        assert_eq!(rows.as_array().unwrap().len(), 3);
        // The same rows again change nothing.
        assert_eq!(
            s.merge(export(vec![session("a", NOV18, 9000, 1.5)]), today())
                .unwrap(),
            0
        );
    }

    #[test]
    fn merge_drops_sessions_that_started_more_than_180_days_ago() {
        let d = tempfile::tempdir().unwrap();
        let today = chrono::Utc::now().date_naive();
        // 10:00 UTC, `back` days before today.
        let start = |back: u64| {
            (today - chrono::Days::new(back))
                .and_hms_opt(10, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis()
        };
        // Stored long ago: one row is now 200 days old.
        let old = export(vec![
            session("old", start(200), 1, 1.0),
            session("kept", start(100), 1, 1.0),
            session("edge", start(180), 1, 1.0),
        ]);
        std::fs::write(d.path().join("sessions.json"), old.to_string()).unwrap();
        let s = Store::open(d.path());
        assert_eq!(s.count().unwrap(), 3);
        // The next export brings a new row and one as old as the first.
        let n = s
            .merge(
                export(vec![
                    session("new", start(1), 1, 1.0),
                    session("ancient", start(181), 1, 1.0),
                ]),
                today,
            )
            .unwrap();
        assert_eq!(n, 1, "only the new row counts as added");
        assert_eq!(s.count().unwrap(), 3);
        let ids: Vec<String> = read(&s)["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["sessionId"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, ["edge", "kept", "new"]);
    }

    fn with_period(period: Value, sessions: Vec<Value>) -> Value {
        json!({"meta": {"periodStart": period}, "sessions": sessions})
    }
    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn merge_keeps_the_earliest_fetched_day_as_period_start() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path());
        // The window began long before the only session in it.
        s.merge(
            with_period(
                json!("2026-08-21T00:00:00.000Z"),
                vec![session("a", NOV18, 1, 1.0)],
            ),
            today(),
        )
        .unwrap();
        assert_eq!(read(&s)["meta"]["periodStart"], "2026-08-21T00:00:00.000Z");
        // A later, newer window does not move it forward; a missing or odd one is ignored.
        for p in [
            json!("2026-11-17T00:00:00.000Z"),
            Value::Null,
            json!("soon"),
        ] {
            s.merge(with_period(p, vec![session("c", NOV10, 1, 1.0)]), today())
                .unwrap();
            assert_eq!(read(&s)["meta"]["periodStart"], "2026-08-21T00:00:00.000Z");
        }
        // An older window moves it back.
        s.merge(
            with_period(json!("2026-08-01T00:00:00.000Z"), vec![]),
            today(),
        )
        .unwrap();
        assert_eq!(read(&s)["meta"]["periodStart"], "2026-08-01T00:00:00.000Z");
    }

    #[test]
    fn extend_period_moves_back_only() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path());
        s.extend_period(day("2026-11-17")).unwrap();
        assert_eq!(read(&s)["meta"]["periodStart"], "2026-11-17T00:00:00.000Z");
        s.extend_period(day("2026-11-19")).unwrap();
        assert_eq!(read(&s)["meta"]["periodStart"], "2026-11-17T00:00:00.000Z");
        s.extend_period(day("2026-10-01")).unwrap();
        assert_eq!(read(&s)["meta"]["periodStart"], "2026-10-01T00:00:00.000Z");
        assert_eq!(read(&s)["sessions"], json!([]));
    }

    #[test]
    fn an_unreadable_store_is_moved_aside_and_starts_empty() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("sessions.json"), "{\"sessions\": [tru").unwrap();
        let s = Store::open(d.path());
        assert_eq!(
            std::fs::read_to_string(d.path().join("sessions.json.bad")).unwrap(),
            "{\"sessions\": [tru"
        );
        assert_eq!(read(&s)["sessions"], json!([]));
        // Damaged after it was opened: the next merge also moves it aside and carries on.
        std::fs::write(s.path(), "garbage").unwrap();
        assert_eq!(
            s.merge(export(vec![session("a", NOV18, 1, 1.0)]), today())
                .unwrap(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("sessions.json.bad")).unwrap(),
            "garbage"
        );
    }

    #[test]
    fn a_leftover_temp_file_is_removed_and_the_store_rewritten() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path());
        s.merge(export(vec![session("a", NOV18, 1, 1.0)]), today())
            .unwrap();
        // A crashed write left a half file behind; it is never read and is cleaned up.
        std::fs::write(d.path().join("sessions.json.tmp"), "{\"sessi").unwrap();
        let s = Store::open(d.path());
        assert_eq!(read(&s)["sessions"].as_array().unwrap().len(), 1);
        assert!(!d.path().join("sessions.json.tmp").exists());
        s.merge(export(vec![session("b", NOV10, 1, 1.0)]), today())
            .unwrap();
        let names: Vec<String> = std::fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["sessions.json"]);
    }

    #[test]
    fn state_round_trips_days_and_failures() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(State::load(d.path()), State::default());
        let st = State {
            cli_version: Some("0.18.0".into()),
            stored_from: Some("2026-08-21".into()),
            days_done: ["2026-11-18".to_string(), "2026-11-19".to_string()].into(),
            failed_days: [("2026-11-17".to_string(), "timeout".to_string())].into(),
            last_fetch_at: Some(1_795_000_000_000),
        };
        st.save(d.path()).unwrap();
        assert_eq!(State::load(d.path()), st);
        let raw: Value =
            serde_json::from_slice(&std::fs::read(d.path().join("state.json")).unwrap()).unwrap();
        assert_eq!(raw["failedDays"], json!({"2026-11-17": "timeout"}));
        assert_eq!(
            st.failed_list(),
            json!([{"day": "2026-11-17", "reason": "timeout"}])
        );
        assert_eq!(raw["lastFetchAt"], 1_795_000_000_000i64);
        std::fs::write(d.path().join("state.json"), "oops").unwrap();
        assert_eq!(State::load(d.path()), State::default());
    }

    #[test]
    fn the_real_shaped_export_merges_and_its_period_starts_on_its_first_day() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path());
        let export: Value = serde_json::from_str(include_str!("testdata/export-day.json")).unwrap();
        assert_eq!(s.merge(export.clone(), today()).unwrap(), 3);
        assert_eq!(s.merge(export.clone(), today()).unwrap(), 0);
        assert_eq!(read(&s)["meta"]["periodStart"], "2026-11-18T00:00:00.000Z");
    }
}
