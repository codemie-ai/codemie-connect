# Command-log record store (Rust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-memory, concurrency-safe command-log record store as a new Rust module (`cmdlog.rs`) with `open`/`append`/`close`/`list`/`get` Tauri commands, wired into `AppState` and registration — no frontend wiring in this slice.

**Architecture:** One new sibling command module (`src-tauri/src/commands/cmdlog.rs`), following the exact shape of `runner.rs`/`pty.rs`/`logger.rs`: `#[tauri::command]` free functions returning `CmdResult<T>`, backed by one `Mutex<CmdLogStore>` field added to `AppState`. `CmdLogStore` owns a `HashMap<String, CmdRecord>` (overlapping open records must coexist) and a `u64` counter for `cmd-{n}` ids. Registration is two hand-maintained edits: a `pub mod cmdlog;` line in `commands/mod.rs` and five entries in `lib.rs`'s `generate_handler!`.

**Tech Stack:** Rust, `chrono::Utc` (already a dependency, mirrors `logger.rs`'s timestamp convention), `std::sync::Mutex`, `std::collections::HashMap`. No new crates.

**Spec:** docs/superpowers/tasks/2026-09-23-epmcdme-15230/spec.md

**Commit per task using the repository's existing convention** (Conventional Commits, type-only, no scope — see `.ai-run/guides/standards/git-workflow.md`).

## Global Constraints

- No frontend wiring — nothing in `ui/*.js`, `ui/*.html`, `ui/*.css` changes in this slice (EPMCDME-15231 owns that).
- No persistence to disk — the store is purely in-memory, cleared on app restart.
- No retention, eviction, or max-record-count policy — the store grows unbounded for the app session's lifetime.
- No filtering, search, sorting, or pagination on `cmdlog_list` — insertion (open) order only.
- No correlation with the frontend's `nextId(prefix)` scheme — this store's id (`cmd-{n}`) is independent and opaque to callers.
- No changes to `logger.rs` — the flat debug log is a separate, pre-existing system.
- All five commands are `#[tauri::command]` free functions returning `CmdResult<T>` (`crate::error::CmdResult`, the existing `InstallerError`-based alias) — matches `runner.rs`/`pty.rs` convention.

---

## Task 1: `CmdRecord` + `CmdLogStore` types and `cmdlog_open`

**Files:**
- Create: `src-tauri/src/commands/cmdlog.rs`
- Modify: `src-tauri/src/commands/mod.rs:7` — insert `pub mod cmdlog;` immediately after the `pub mod logger;` line (module-declaration order). Omitting this line is a compile error, not a silent no-op.
- Modify: `src-tauri/src/state.rs:39` — add one field after `last_update_check`: `pub cmdlog: Mutex<crate::commands::cmdlog::CmdLogStore>,`. `AppState` derives `Default`, so `CmdLogStore` must derive/implement `Default` too (Task 1 provides this).
- Test: inline `#[cfg(test)] mod tests` at the bottom of `src-tauri/src/commands/cmdlog.rs`

**Interfaces:**
- Produces (used by every later task in this plan):
  - `pub struct CmdRecord { pub id: String, pub command: String, pub start_time: chrono::DateTime<chrono::Utc>, pub exit_code: Option<i32>, pub duration_ms: Option<u64>, pub raw_output: String }` — `#[derive(Debug, Clone, serde::Serialize)]`
  - `pub struct CmdLogStore { records: std::collections::HashMap<String, CmdRecord>, next_id: u64 }` — `#[derive(Default)]`, fields private (store owns id assignment)
  - `impl CmdLogStore { fn open(&mut self, command: String) -> String }` — creates a record with `start_time = Utc::now()`, empty `raw_output`, `exit_code`/`duration_ms = None`, id `format!("cmd-{n}")`, inserts it, returns the id
  - `#[tauri::command] pub fn cmdlog_open(command: String, state: tauri::State<'_, crate::state::AppState>) -> crate::error::CmdResult<String>` — locks `state.cmdlog`, calls `CmdLogStore::open`, returns `Ok(id)`

**Test-first: yes — a freshly opened record (via `cmdlog_open` against a real `AppState` instance, or `CmdLogStore::open` directly) has `command` equal to the input, `start_time` within the last second of `Utc::now()`, `exit_code == None`, `duration_ms == None`, and empty `raw_output`; this fails to compile until `CmdRecord`/`CmdLogStore`/`cmdlog_open` exist.**

- [ ] Step 1: Write the failing test in a new `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/commands/cmdlog.rs` (file does not exist yet — create it with only `use` statements and this test module first):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn open_creates_record_with_expected_defaults() {
        let mut store = CmdLogStore::default();
        let id = store.open("echo hi".into());
        let record = store.records.get(&id).expect("record must exist after open");
        assert_eq!(record.command, "echo hi");
        assert!((Utc::now() - record.start_time).num_seconds() < 1);
        assert_eq!(record.exit_code, None);
        assert_eq!(record.duration_ms, None);
        assert_eq!(record.raw_output, "");
    }
}
```

- [ ] Step 2: Run `cd src-tauri && cargo test --lib commands::cmdlog`
  Expected: FAIL — `cmdlog` module does not exist / does not compile.

- [ ] Step 3: Add `pub mod cmdlog;` to `src-tauri/src/commands/mod.rs:7` (after `pub mod logger;`), then implement the struct, `CmdLogStore::open`, and `cmdlog_open` in `src-tauri/src/commands/cmdlog.rs` above the test module:

```rust
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
```

  Then add the `cmdlog: Mutex<crate::commands::cmdlog::CmdLogStore>,` field to `AppState` in `src-tauri/src/state.rs` (after `last_update_check`, matching the existing per-concern `Mutex<T>` field pattern).

- [ ] Step 4: Run `cd src-tauri && cargo test --lib commands::cmdlog`
  Expected: PASS.

- [ ] Step 5: Commit (type `feat`, e.g. `feat: add cmdlog record store with open command`).

---

## Task 2: `cmdlog_append` and `cmdlog_close`

**Files:**
- Modify: `src-tauri/src/commands/cmdlog.rs` — add `append`/`close` methods on `CmdLogStore`, two new `#[tauri::command]` functions, and new tests in the existing `mod tests` block.

**Interfaces:**
- Consumes: `CmdRecord`, `CmdLogStore` (private `records`/`next_id`), `CmdLogStore::open` from Task 1.
- Produces:
  - `impl CmdLogStore { fn append(&mut self, id: &str, chunk: &str) -> Result<(), String>; fn close(&mut self, id: &str, exit_code: i32) -> Result<(), String> }`
  - `#[tauri::command] pub fn cmdlog_append(id: String, chunk: String, state: tauri::State<'_, AppState>) -> CmdResult<()>`
  - `#[tauri::command] pub fn cmdlog_close(id: String, exit_code: i32, state: tauri::State<'_, AppState>) -> CmdResult<()>`

**Test-first: yes — lifecycle test: open → append (two chunks) → close asserts `exit_code`, non-negative `duration_ms`, and `raw_output` equal to the concatenation of both chunks; append-after-close test asserts `Err` and `raw_output` unchanged; double-close test asserts the second close is `Err`; not-found tests assert `append`/`close` on an unknown id are `Err`. All fail to compile until `append`/`close` exist.**

- [ ] Step 1: Add these tests to the `mod tests` block in `src-tauri/src/commands/cmdlog.rs`:

```rust
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
```

- [ ] Step 2: Run `cd src-tauri && cargo test --lib commands::cmdlog`
  Expected: FAIL — `append`/`close` not found.

- [ ] Step 3: Implement in `src-tauri/src/commands/cmdlog.rs`:

```rust
impl CmdLogStore {
    fn append(&mut self, id: &str, chunk: &str) -> Result<(), String> {
        let record = self
            .records
            .get_mut(id)
            .ok_or_else(|| format!("unknown command-log id: {id}"))?;
        if record.exit_code.is_some() {
            return Err(format!("command-log record {id} is already closed"));
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
pub fn cmdlog_append(id: String, chunk: String, state: tauri::State<'_, AppState>) -> CmdResult<()> {
    state
        .cmdlog
        .lock()
        .unwrap()
        .append(&id, &chunk)
        .map_err(crate::error::InstallerError::Other)
}

#[tauri::command]
pub fn cmdlog_close(id: String, exit_code: i32, state: tauri::State<'_, AppState>) -> CmdResult<()> {
    state
        .cmdlog
        .lock()
        .unwrap()
        .close(&id, exit_code)
        .map_err(crate::error::InstallerError::Other)
}
```

- [ ] Step 4: Run `cd src-tauri && cargo test --lib commands::cmdlog`
  Expected: PASS.

- [ ] Step 5: Commit (`feat: add cmdlog append and close commands`).

---

## Task 3: `cmdlog_list`, `cmdlog_get`, and registration in `generate_handler!`

**Files:**
- Modify: `src-tauri/src/commands/cmdlog.rs` — add `list`/`get` methods, two `#[tauri::command]` functions, and new tests.
- Modify: `src-tauri/src/lib.rs:120-121` — insert five `commands::cmdlog::*` entries in `generate_handler!` immediately after the `commands::logger::log_line,` / `commands::logger::open_log,` lines, mirroring `mod.rs`'s declaration order.

**Interfaces:**
- Consumes: `CmdLogStore`, `cmdlog_open`/`append`/`close` from Tasks 1–2.
- Produces:
  - `impl CmdLogStore { fn list(&self) -> Vec<CmdRecord>; fn get(&self, id: &str) -> Option<CmdRecord> }`
  - `#[tauri::command] pub fn cmdlog_list(state: tauri::State<'_, AppState>) -> CmdResult<Vec<CmdRecord>>`
  - `#[tauri::command] pub fn cmdlog_get(id: String, state: tauri::State<'_, AppState>) -> CmdResult<Option<CmdRecord>>`

**Test-first: yes — record-construction/list/get test: two overlapping `open`s before either closes produce two distinct ids, both present in `list()` (insertion order) and independently retrievable/mutable via `get()`; `get()` on an unknown id returns `Ok(None)`/`None`, not `Err`. Fails to compile until `list`/`get` exist.**

- [ ] Step 1: Add these tests to the `mod tests` block:

```rust
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
```

- [ ] Step 2: Run `cd src-tauri && cargo test --lib commands::cmdlog`
  Expected: FAIL — `list`/`get` not found.

- [ ] Step 3: Implement in `src-tauri/src/commands/cmdlog.rs`:

```rust
impl CmdLogStore {
    fn list(&self) -> Vec<CmdRecord> {
        self.records.values().cloned().collect()
    }

    fn get(&self, id: &str) -> Option<CmdRecord> {
        self.records.get(id).cloned()
    }
}

#[tauri::command]
pub fn cmdlog_list(state: tauri::State<'_, AppState>) -> CmdResult<Vec<CmdRecord>> {
    Ok(state.cmdlog.lock().unwrap().list())
}

#[tauri::command]
pub fn cmdlog_get(id: String, state: tauri::State<'_, AppState>) -> CmdResult<Option<CmdRecord>> {
    Ok(state.cmdlog.lock().unwrap().get(&id))
}
```

  Note: `list()`'s naive `values().cloned().collect()` does not guarantee `HashMap` iteration order matches insertion order in general — the `list_returns_records_in_insertion_order` test above will only pass incidentally. Replace the internal storage ordering to make this a real guarantee: track insertion order explicitly, e.g. add a `order: Vec<String>` field to `CmdLogStore` (pushed to in `open`, read by `list` to look up each id in `records`), keeping `records` as the `HashMap` for O(1) `get`/`append`/`close`. Update `open` to push onto `order` and `list` to map `order.iter()` through `records.get()`.

  Then add to `src-tauri/src/lib.rs`'s `generate_handler!` block, immediately after `commands::logger::open_log,` (line 121):

  ```rust
              commands::cmdlog::cmdlog_open,
              commands::cmdlog::cmdlog_append,
              commands::cmdlog::cmdlog_close,
              commands::cmdlog::cmdlog_list,
              commands::cmdlog::cmdlog_get,
  ```

- [ ] Step 4: Run `cd src-tauri && cargo test --lib commands::cmdlog` and `cd src-tauri && cargo build`
  Expected: tests PASS; build succeeds (confirms `generate_handler!` registration compiles).

- [ ] Step 5: Commit (`feat: add cmdlog list/get commands and register cmdlog module`).

---

## Self-Review

**1. Spec coverage:**
- Record model (`id`, `command`, `start_time`, `exit_code`, `duration_ms`, `raw_output`) — Task 1.
- Five commands (`open`/`append`/`close`/`list`/`get`), all `#[tauri::command]` returning `CmdResult<T>` — Tasks 1–3.
- `CmdLogStore { records: HashMap<String, CmdRecord>, next_id: u64 }` behind one `Mutex` on `AppState`, id scheme `cmd-{n}` — Task 1.
- Registration: `mod.rs` module line (Task 1) and `lib.rs` `generate_handler!` entries (Task 3), both called out explicitly as required, not optional.
- All six spec test categories — Lifecycle (Task 2), Record construction (Task 1), Not-found paths (Tasks 2–3), Append-after-close (Task 2), Double-close (Task 2), Concurrent/overlapping opens (Task 3).

**2. Placeholder scan:** No TBD/TODO; every step has real code or a real command to run.

**3. Type consistency:** `CmdLogStore`'s private fields (`records`, `next_id`) and public methods (`open`/`append`/`close`/`list`/`get`) are used identically across all three tasks; the `#[tauri::command]` function names match the spec's five names exactly and match the `generate_handler!` entries in Task 3.

**Negative-constraints pass** (spec Non-goals, verified against all three tasks — no task violates any of these):
- No frontend wiring — confirmed; no task touches any `ui/*` file.
- No persistence to disk — confirmed; `CmdLogStore` is an in-memory struct behind a `Mutex`, no file I/O anywhere in this module.
- No retention/eviction/max-record-count policy — confirmed; `list`/`open` never prune `records`.
- No filtering/search/sorting/pagination on `cmdlog_list` — confirmed; `cmdlog_list` returns the full set in insertion order only, no parameters.
- No correlation with the frontend's `nextId(prefix)` scheme — confirmed; ids are the store-internal `cmd-{n}` counter, opaque to any caller.
- No changes to `logger.rs` — confirmed; not read or modified by any task.
