# Spec: EPMCDME-15230 — Command log record store (Rust)

Slice 1 of 3 for EPMCDME-14512. New module `src-tauri/src/commands/cmdlog.rs`: an in-memory,
concurrency-safe record store for "what CodeMie ran", with no frontend wiring (that's EPMCDME-15231).

## Record model

```rust
pub struct CmdRecord {
    pub id: String,
    pub command: String,
    pub start_time: DateTime<Utc>,   // chrono, matches logger.rs's existing convention
    pub exit_code: Option<i32>,      // None while open
    pub duration_ms: Option<u64>,    // None while open; set at close
    pub raw_output: String,
}
```

`chrono::Utc` is already a dependency (used by `logger.rs`); no new crate for timestamps.

## Commands (five, per task scope — no more)

- `cmdlog_open(command: String, state) -> CmdResult<String>` — creates a record with
  `start_time = Utc::now()`, empty `raw_output`, `exit_code`/`duration_ms = None`; returns the new id.
- `cmdlog_append(id: String, chunk: String, state) -> CmdResult<()>` — appends `chunk` to
  `raw_output` of the record `id`. Errors if `id` is unknown or the record is already closed
  (`exit_code.is_some()`) — an append after close indicates a caller bug, not a valid state
  transition, so it's rejected rather than silently accepted or ignored.
- `cmdlog_close(id: String, exit_code: i32, state) -> CmdResult<()>` — sets `exit_code`, computes
  `duration_ms = (Utc::now() - start_time)` in whole milliseconds (saturating at 0 to guard clock
  skew). Errors if `id` is unknown or already closed (no double-close).
- `cmdlog_list(state) -> CmdResult<Vec<CmdRecord>>` — all records, insertion (open) order. No
  filtering/sorting options in this slice.
- `cmdlog_get(id: String, state) -> CmdResult<Option<CmdRecord>>` — `Ok(None)` when `id` is
  unknown (a lookup miss is a normal outcome, not an error); `Ok(Some(record))` otherwise.

All five are `#[tauri::command]` free functions returning `CmdResult<T>` (the existing
`InstallerError`-based alias from `src-tauri/src/error.rs`), matching `runner.rs`/`pty.rs` convention.

## Storage and concurrency

One new field on `AppState` (`src-tauri/src/state.rs`), following its existing
one-`Mutex`-field-per-concern pattern:

```rust
cmdlog: Mutex<CmdLogStore>,
```

where `CmdLogStore { records: HashMap<String, CmdRecord>, next_id: u64 }` lives in `cmdlog.rs`.
A `HashMap` (not a single slot like `pty`'s `Mutex<Option<(String, PtyHandle)>>`) is required because
overlapping open records must be supported — two commands can be in flight at once (needed by
EPMCDME-15231 for overlapping PTY commands). Both fields sit behind one `Mutex` so id-assignment and
insertion stay atomic together; no separate locks to order.

**Id generation**: an incrementing `u64` counter on `CmdLogStore`, formatted as `format!("cmd-{n}")`.
No `uuid` crate is a dependency today and none is needed — the counter is process-local, monotonic,
and sufficient for a stable key over an in-memory, single-process store. This is an internal
implementation detail; the frontend (deferred to EPMCDME-15231) treats the returned id as an opaque
string, so it isn't required to match the `nextId(prefix)` scheme already used client-side for
pty/runner correlation ids.

## Registration

- `pub mod cmdlog;` added to `src-tauri/src/commands/mod.rs`, in module-declaration order (after
  `logger`).
- `cmdlog::cmdlog_open, cmdlog::cmdlog_append, cmdlog::cmdlog_close, cmdlog::cmdlog_list,
  cmdlog::cmdlog_get` added to `generate_handler!` in `src-tauri/src/lib.rs`, placed immediately
  after the `logger::*` entries to mirror `mod.rs`'s order. Missing the `mod.rs` line is a compile
  error, not a silent no-op — call this out explicitly in the plan.

## Tests (inline `#[cfg(test)] mod tests`, mirroring `runner.rs`/`pty.rs` placement)

- **Lifecycle**: open → append (one or more chunks, assert concatenation) → close; assert final
  `exit_code`, non-negative `duration_ms`, accumulated `raw_output`.
- **Record construction**: a freshly opened record has the expected `command`, a recent
  `start_time`, `exit_code == None`, `duration_ms == None`, empty `raw_output`.
- **Not-found paths**: `cmdlog_get` on an unknown id returns `Ok(None)`; `cmdlog_append` /
  `cmdlog_close` on an unknown id return `Err`.
- **Append-after-close**: append on an already-closed record returns `Err`; the record's
  `raw_output` is unchanged.
- **Double-close**: closing an already-closed record returns `Err`.
- **Concurrent/overlapping opens**: two `cmdlog_open` calls before either closes produce two
  distinct ids, both present and independently mutable via `cmdlog_list`/`cmdlog_get`.

## Non-goals

- No frontend wiring (`ui/runner-bridge.js` instrumentation is EPMCDME-15231).
- No persistence to disk — purely in-memory, cleared on app restart.
- No retention, eviction, or max-record-count policy — the store grows unbounded for the app
  session's lifetime in this slice; a limit is a future decision if it proves necessary.
- No filtering, search, sorting, or pagination on `cmdlog_list`.
- No correlation with the existing `nextId(prefix)` scheme used for pty/runner event ids — this
  store's id is independent and opaque to callers.
- No changes to `logger.rs`'s flat debug log — a separate, pre-existing system.
