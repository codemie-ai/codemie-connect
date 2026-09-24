use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::error::CmdResult;
use crate::state::AppState;

const MAX_OUTPUT: usize = 1_048_576; // 1 MB per record

#[derive(Debug, Clone, Serialize)]
pub struct CmdRecord {
    pub id: String,
    pub command: String,
    pub start_time: DateTime<Utc>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub raw_output: String,
}

#[derive(Default)]
pub struct CmdLogStore {
    records: HashMap<String, CmdRecord>,
    order: Vec<String>,
    next_id: u64,
}

impl CmdLogStore {
    fn open(&mut self, command: String) -> String {
        let id = format!("cmd-{}", self.next_id);
        self.next_id += 1;
        self.records.insert(
            id.clone(),
            CmdRecord {
                id: id.clone(),
                command,
                start_time: Utc::now(),
                exit_code: None,
                duration_ms: None,
                raw_output: String::new(),
            },
        );
        self.order.push(id.clone());
        id
    }

    fn list(&self) -> Vec<CmdRecord> {
        self.order
            .iter()
            .filter_map(|id| self.records.get(id).cloned())
            .collect()
    }

    fn get(&self, id: &str) -> Option<CmdRecord> {
        self.records.get(id).cloned()
    }
}

impl CmdLogStore {
    fn append(&mut self, id: &str, chunk: &str) -> Result<(), String> {
        let record = self
            .records
            .get_mut(id)
            .ok_or_else(|| format!("unknown command-log id: {id}"))?;
        if record.exit_code.is_some() {
            return Err(format!("command-log record {id} is already closed"));
        }
        let combined = record.raw_output.len() + chunk.len();
        if combined > MAX_OUTPUT {
            let excess = combined - MAX_OUTPUT;
            record.raw_output.drain(..excess.min(record.raw_output.len()));
        }
        record.raw_output.push_str(chunk);
        Ok(())
    }

    fn close(&mut self, id: &str, exit_code: i32) -> Result<(), String> {
        let record = self
            .records
            .get_mut(id)
            .ok_or_else(|| format!("unknown command-log id: {id}"))?;
        if record.exit_code.is_some() {
            return Err(format!("command-log record {id} is already closed"));
        }
        let elapsed = Utc::now() - record.start_time;
        record.duration_ms = Some(elapsed.num_milliseconds().max(0) as u64);
        record.exit_code = Some(exit_code);
        Ok(())
    }
}

#[tauri::command]
pub fn cmdlog_open(command: String, state: tauri::State<'_, AppState>) -> CmdResult<String> {
    Ok(state.cmdlog.lock().unwrap_or_else(|e| e.into_inner()).open(command))
}

#[tauri::command]
pub fn cmdlog_append(
    id: String,
    chunk: String,
    state: tauri::State<'_, AppState>,
) -> CmdResult<()> {
    state
        .cmdlog
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .append(&id, &chunk)
        .map_err(crate::error::InstallerError::Other)
}

#[tauri::command]
pub fn cmdlog_close(
    id: String,
    exit_code: i32,
    state: tauri::State<'_, AppState>,
) -> CmdResult<()> {
    state
        .cmdlog
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .close(&id, exit_code)
        .map_err(crate::error::InstallerError::Other)
}

#[tauri::command]
pub fn cmdlog_list(state: tauri::State<'_, AppState>) -> CmdResult<Vec<CmdRecord>> {
    Ok(state.cmdlog.lock().unwrap_or_else(|e| e.into_inner()).list())
}

#[tauri::command]
pub fn cmdlog_get(id: String, state: tauri::State<'_, AppState>) -> CmdResult<Option<CmdRecord>> {
    Ok(state.cmdlog.lock().unwrap_or_else(|e| e.into_inner()).get(&id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_record_with_expected_defaults() {
        let mut store = CmdLogStore::default();
        let id = store.open("echo hi".into());
        let record = store
            .records
            .get(&id)
            .expect("record must exist after open");
        assert_eq!(record.command, "echo hi");
        assert!((Utc::now() - record.start_time).num_seconds() < 1);
        assert_eq!(record.exit_code, None);
        assert_eq!(record.duration_ms, None);
        assert_eq!(record.raw_output, "");
    }

    #[test]
    fn lifecycle_open_append_close_accumulates_output_and_sets_exit_code() {
        let mut store = CmdLogStore::default();
        let id = store.open("echo hi".into());
        store.append(&id, "hi").unwrap();
        store.append(&id, "\n").unwrap();
        store.close(&id, 0).unwrap();
        let record = store.records.get(&id).unwrap();
        assert_eq!(record.exit_code, Some(0));
        assert!(record.duration_ms.unwrap() < 5000);
        assert_eq!(record.raw_output, "hi\n");
    }

    #[test]
    fn append_after_close_errors_and_leaves_output_unchanged() {
        let mut store = CmdLogStore::default();
        let id = store.open("echo hi".into());
        store.close(&id, 0).unwrap();
        assert!(store.append(&id, "late").is_err());
        assert_eq!(store.records.get(&id).unwrap().raw_output, "");
    }

    #[test]
    fn double_close_errors() {
        let mut store = CmdLogStore::default();
        let id = store.open("echo hi".into());
        store.close(&id, 0).unwrap();
        assert!(store.close(&id, 1).is_err());
    }

    #[test]
    fn append_and_close_on_unknown_id_error() {
        let mut store = CmdLogStore::default();
        assert!(store.append("cmd-999", "x").is_err());
        assert!(store.close("cmd-999", 0).is_err());
    }

    #[test]
    fn list_returns_records_in_insertion_order() {
        let mut store = CmdLogStore::default();
        let first = store.open("echo one".into());
        let second = store.open("echo two".into());
        let ids: Vec<String> = store.list().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![first, second]);
    }

    #[test]
    fn get_returns_none_for_unknown_id_and_some_for_known_id() {
        let mut store = CmdLogStore::default();
        let id = store.open("echo hi".into());
        assert!(store.get("cmd-999").is_none());
        assert_eq!(store.get(&id).unwrap().command, "echo hi");
    }

    #[test]
    fn append_trims_oldest_output_when_max_exceeded() {
        let mut store = CmdLogStore::default();
        let id = store.open("big-cmd".into());
        // Fill to MAX_OUTPUT - 10
        let filler = "x".repeat(MAX_OUTPUT - 10);
        store.append(&id, &filler).unwrap();
        // Push 20 more bytes, which would exceed MAX_OUTPUT by 10
        store.append(&id, &"y".repeat(20)).unwrap();
        let len = store.records.get(&id).unwrap().raw_output.len();
        assert!(len <= MAX_OUTPUT, "raw_output must not exceed MAX_OUTPUT, got {len}");
    }

    #[test]
    fn overlapping_opens_produce_two_distinct_independently_mutable_records() {
        let mut store = CmdLogStore::default();
        let first = store.open("echo one".into());
        let second = store.open("echo two".into());
        assert_ne!(first, second);
        store.append(&first, "one-output").unwrap();
        store.close(&second, 1).unwrap();
        assert_eq!(store.get(&first).unwrap().raw_output, "one-output");
        assert_eq!(store.get(&first).unwrap().exit_code, None);
        assert_eq!(store.get(&second).unwrap().exit_code, Some(1));
    }
}
