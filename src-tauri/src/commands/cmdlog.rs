use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::error::CmdResult;
use crate::state::AppState;

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
        id
    }
}

#[tauri::command]
pub fn cmdlog_open(command: String, state: tauri::State<'_, AppState>) -> CmdResult<String> {
    Ok(state.cmdlog.lock().unwrap().open(command))
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
}
