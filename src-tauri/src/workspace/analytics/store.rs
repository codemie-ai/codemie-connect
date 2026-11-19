//! The sessions Connect has read from the CLI, in the CLI's own export shape
//! (`{meta, sessions}`), and the fetch state beside them. Every write is atomic.
use crate::storage::location::write_atomic;
use crate::workspace::models::{Result, WorkspaceError};
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const SESSIONS: &str = "sessions.json";
const STATE: &str = "state.json";

fn io(e: std::io::Error) -> WorkspaceError {
    log::warn!("analytics: storage error: {e}");
    WorkspaceError::storage_unavailable()
}

fn empty_export() -> Value {
    json!({"meta": {"periodStart": null}, "sessions": []})
}

pub struct Store {
    path: PathBuf,
}

#[allow(dead_code)] // used from Task 2
impl Store {
    /// Opens the store in `dir`: leftovers of a crashed write are removed, and a missing
    /// `sessions.json` is written empty, so `view` always has an input. Only the leaf folder is
    /// created; a data folder that went away is not recreated.
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
    /// incoming one stays (a stale window never undoes a fresher read). Sets `meta.periodStart` to
    /// the oldest stored day. Returns how many sessions were added or changed.
    pub fn merge(&self, export: &Value) -> Result<usize> {
        let stored = self.load()?;
        let mut rows: BTreeMap<String, Value> = BTreeMap::new();
        for row in stored["sessions"].as_array().into_iter().flatten() {
            if let Some(id) = row["sessionId"].as_str() {
                rows.insert(id.to_string(), row.clone());
            }
        }
        let mut changed = 0;
        for row in export["sessions"].as_array().into_iter().flatten() {
            let Some(id) = row["sessionId"].as_str() else {
                continue;
            };
            match rows.get(id) {
                Some(old) if old == row || ends(old) > ends(row) => {}
                _ => {
                    rows.insert(id.to_string(), row.clone());
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
        let mut meta = stored["meta"].clone();
        if !meta.is_object() {
            meta = json!({});
        }
        meta["periodStart"] = sessions
            .iter()
            .filter_map(|r| r["startTime"].as_i64())
            .min()
            .and_then(|ms| Utc.timestamp_millis_opt(ms).single())
            .map(|t| json!(format!("{}T00:00:00.000Z", t.format("%Y-%m-%d"))))
            .unwrap_or(Value::Null);
        self.write(&json!({"meta": meta, "sessions": sessions}))?;
        Ok(changed)
    }
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
        if name.ends_with(".tmp") && (name.starts_with(SESSIONS) || name.starts_with(STATE)) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// What the fetcher knows between runs (`state.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[allow(dead_code)] // used from Task 2
pub struct State {
    pub cli_version: Option<String>,
    /// The oldest day (YYYY-MM-DD) the first open reads back to.
    pub stored_from: Option<String>,
    pub days_done: BTreeSet<String>,
    pub failed_days: BTreeSet<String>,
    /// Unix milliseconds of the last successful fetch.
    pub last_fetch_at: Option<i64>,
}

#[allow(dead_code)] // used from Task 2
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
            s.merge(&export(vec![
                session("a", NOV18, 1000, 1.0),
                session("b", NOV18, 5, 2.0)
            ]))
            .unwrap(),
            2
        );
        // "a" grew (the session was still running), "b" arrives stale, "c" is new.
        let n = s
            .merge(&export(vec![
                session("a", NOV18, 9000, 1.5),
                session("b", NOV18, 1, 9.0),
                session("c", NOV10, 1, 0.1),
            ]))
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
            s.merge(&export(vec![session("a", NOV18, 9000, 1.5)]))
                .unwrap(),
            0
        );
    }

    #[test]
    fn merge_sets_period_start_to_the_oldest_stored_day() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path());
        s.merge(&export(vec![session("a", NOV18, 1, 1.0)])).unwrap();
        assert_eq!(read(&s)["meta"]["periodStart"], "2026-11-18T00:00:00.000Z");
        s.merge(&export(vec![session("c", NOV10, 1, 1.0)])).unwrap();
        assert_eq!(read(&s)["meta"]["periodStart"], "2026-11-10T00:00:00.000Z");
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
            s.merge(&export(vec![session("a", NOV18, 1, 1.0)])).unwrap(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("sessions.json.bad")).unwrap(),
            "garbage"
        );
    }

    #[test]
    fn writes_are_atomic() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path());
        s.merge(&export(vec![session("a", NOV18, 1, 1.0)])).unwrap();
        // A crashed write left a half file behind; it is never read and is cleaned up.
        std::fs::write(d.path().join("sessions.json.tmp"), "{\"sessi").unwrap();
        let s = Store::open(d.path());
        assert_eq!(read(&s)["sessions"].as_array().unwrap().len(), 1);
        assert!(!d.path().join("sessions.json.tmp").exists());
        s.merge(&export(vec![session("b", NOV10, 1, 1.0)])).unwrap();
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
            failed_days: ["2026-11-17".to_string()].into(),
            last_fetch_at: Some(1_795_000_000_000),
        };
        st.save(d.path()).unwrap();
        assert_eq!(State::load(d.path()), st);
        let raw: Value =
            serde_json::from_slice(&std::fs::read(d.path().join("state.json")).unwrap()).unwrap();
        assert_eq!(raw["failedDays"], json!(["2026-11-17"]));
        assert_eq!(raw["lastFetchAt"], 1_795_000_000_000i64);
        std::fs::write(d.path().join("state.json"), "oops").unwrap();
        assert_eq!(State::load(d.path()), State::default());
    }

    #[test]
    fn the_real_shaped_export_merges_and_its_period_starts_on_its_first_day() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path());
        let export: Value = serde_json::from_str(include_str!("testdata/export-day.json")).unwrap();
        assert_eq!(s.merge(&export).unwrap(), 3);
        assert_eq!(s.merge(&export).unwrap(), 0);
        assert_eq!(read(&s)["meta"]["periodStart"], "2026-11-18T00:00:00.000Z");
    }
}
