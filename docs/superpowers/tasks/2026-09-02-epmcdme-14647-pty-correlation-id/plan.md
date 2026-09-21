# PTY Correlation ID + pty_kill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every PTY run a correlation id carried on all events, fix the stale-clear race in the wait thread, and add a `pty_kill` command that terminates the child without blocking the main thread.

**Architecture:** The bridge generates a `runId` via `nextId('pty')`, registers per-id listeners before invoking, then passes the id to `spawn_pty`, which stores it alongside the handle and echoes it on all `engine:pty-data` / `engine:pty-exit` payloads. The wait thread calls a standalone `clear_if_owner` helper so the guard logic is unit-testable. `pty_kill` is `async`, extracts the killer and exit condvar from the Mutex in a brief lock, then does the blocking kill-and-wait inside `tokio::task::spawn_blocking` (same pattern as installer.rs:133) with a 5-second bounded wait; on timeout it returns an error.

**Tech Stack:** Rust / portable_pty 0.8.1 (ChildKiller already present), Tauri async commands, tokio::task::spawn_blocking, JavaScript ES modules, node:test.

**Spec:** Requirements provided inline (EPMCDME-14647).

Commit per task using the repository's existing convention.

## Acceptance criteria

- Every `engine:pty-data` and `engine:pty-exit` payload carries `id`; `pty.spawnPty()` returns `{ code, id }`.
- Two PTY runs (sequential or overlapping) each resolve on their own id; neither sees the other's exit or data.
- `pty_kill` terminates the child, resolves after it exits (bounded 5 s wait, error on timeout), and a subsequent respawn is not evicted by the prior wait thread.
- No concurrent-spawn guard is added.
- `runAction`, `runPty`, the terminal overlay, and the legacy install wizard behave identically to before (additive payload fields only; caller destructuring updated).
- `pty_kill` registered in `lib.rs` only; `pub mod pty;` in `mod.rs` already covers the module.

## Global Constraints

- No concurrent-spawn guard at any layer.
- Payload changes are additive only — `data` and `code` fields remain at the same keys; `id` is appended.
- `pty_kill` must not hold `state.pty` Mutex during any blocking call.
- `pty_kill` is `pub async fn` — same async style as `run_fresh_env` in runner.rs.
- Blocking work in `pty_kill` goes inside `tokio::task::spawn_blocking` (same pattern as installer.rs:133).
- On kill timeout (5 s condvar wait exceeded), return `Err(InstallerError::Pty("pty_kill timed out".into()))`. No SIGKILL escalation, no pid capture, no extra fields.
- Windows PTY behaviour is out of scope; `pty_kill` uses cross-platform portable_pty ChildKiller.
- `mod.rs` already has `pub mod pty;` — new functions in `pty.rs` require only `lib.rs` registration.

---

### Task 1: Rust — id propagation, clear_if_owner extraction

**Files:**
- Modify: `src-tauri/src/commands/pty.rs`
- Modify: `src-tauri/src/state.rs`

**Interfaces:**
- Produces: `spawn_pty(app, state, cmd, cols, rows, run_id: String) -> CmdResult<String>`; `AppState.pty: Mutex<Option<(String, PtyHandle)>>`; `fn clear_if_owner<T>(slot: &Mutex<Option<(String, T)>>, id: &str) -> bool`; `PtyHandle` gains `killer: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send>>>` and `exit_cv: Arc<(Mutex<bool>, Condvar)>` alongside the existing `writer` and `master`.

**Test-first: yes — `clear_if_owner_only_clears_matching_id` fails to compile until `clear_if_owner` is extracted and `state.rs` changes the slot type**

- [ ] **Step 1: Write the failing test**

  Add a `#[cfg(all(test, not(windows)))] mod tests` block at the bottom of `pty.rs`:

  ```rust
  #[cfg(all(test, not(windows)))]
  mod tests {
      use super::clear_if_owner;
      use std::sync::Mutex;

      #[test]
      fn clear_if_owner_only_clears_matching_id() {
          let slot: Mutex<Option<(String, ())>> = Mutex::new(Some(("run-2".into(), ())));
          assert!(!clear_if_owner(&slot, "run-1"), "must not clear when id differs");
          assert!(slot.lock().unwrap().is_some(), "run-2 must still be present");
          assert!(clear_if_owner(&slot, "run-2"), "must clear when id matches");
          assert!(slot.lock().unwrap().is_none(), "slot must now be empty");
      }
  }
  ```

  Run `cargo test` from `src-tauri/` — must fail (compile error: `clear_if_owner` not found).

- [ ] **Step 2: Change `state.rs:16`** — `Mutex<Option<PtyHandle>>` → `Mutex<Option<(String, PtyHandle)>>`.

- [ ] **Step 3: Add imports to `pty.rs`** — `use std::sync::{Arc, Condvar};` at top.

- [ ] **Step 4: Extend `PtyHandle` struct** — add two fields alongside the existing `writer` and `master` (no pid field):

  ```rust
  pub struct PtyHandle {
      writer: Box<dyn Write + Send>,
      master: Box<dyn portable_pty::MasterPty + Send>,
      pub killer: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send>>>,
      pub exit_cv: Arc<(Mutex<bool>, Condvar)>,
  }
  ```

- [ ] **Step 5: Extract `clear_if_owner`** — add this free function above `spawn_pty`:

  ```rust
  fn clear_if_owner<T>(slot: &Mutex<Option<(String, T)>>, id: &str) -> bool {
      let mut g = slot.lock().unwrap();
      if g.as_ref().map_or(false, |(sid, _)| sid == id) {
          *g = None;
          true
      } else {
          false
      }
  }
  ```

- [ ] **Step 6: Update `spawn_pty` signature** at `pty.rs:27-34` — add `run_id: String` after `rows: u16`; change return type to `CmdResult<String>`.

- [ ] **Step 7: In `spawn_pty`, before the state-store block** — create killer and exit condvar, then store the tuple (no pid capture):

  ```rust
  let killer = Arc::new(Mutex::new(
      child.clone_killer().map_err(|e| InstallerError::Pty(e.to_string()))?,
  ));
  let exit_cv = Arc::new((Mutex::new(false), Condvar::new()));
  *guard = Some((run_id.clone(), PtyHandle {
      writer,
      master: pair.master,
      killer: Arc::clone(&killer),
      exit_cv: Arc::clone(&exit_cv),
  }));
  ```

- [ ] **Step 8: Update reader thread emit at `pty.rs:109`** — capture `run_id_r = run_id.clone()` before spawning; change `json!({ "data": data })` to `json!({ "id": run_id_r, "data": data })`.

- [ ] **Step 9: Update wait thread at `pty.rs:117-123`** — capture `run_id_w = run_id.clone()` and `exit_cv_w = Arc::clone(&exit_cv)` before spawning. After `child.wait()`, signal the condvar, then call `clear_if_owner`:

  ```rust
  { let (lk, cv) = &*exit_cv_w; *lk.lock().unwrap() = true; cv.notify_all(); }
  let app_state = app_exit.try_state::<AppState>().unwrap();
  clear_if_owner(&app_state.pty, &run_id_w);
  ```

  Change the exit emit to `json!({ "id": run_id_w, "code": code })`.

- [ ] **Step 10: Update `spawn_pty` return** — `Ok(run_id)`.

- [ ] **Step 11: Update `pty_input` and `pty_resize`** — change `if let Some(h)` to `if let Some((_, h))` in both destructurings.

- [ ] **Step 12:** `cargo fmt && cargo clippy -- -D warnings && cargo test` from `src-tauri/`. All must pass.

- [ ] **Step 13:** Commit.

---

### Task 2: Rust — async pty_kill with bounded wait

**Files:**
- Modify: `src-tauri/src/commands/pty.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `PtyHandle.killer`, `PtyHandle.exit_cv`, `AppState.pty: Mutex<Option<(String, PtyHandle)>>` (from Task 1).
- Produces: `pub async fn pty_kill(state: State<'_, AppState>) -> CmdResult<()>` registered in `lib.rs`.

**Test-first: yes — `kill_terminates_real_child` fails to compile until `pty_kill` and its PtyHandle fields exist; the integration test spawns a real process and asserts it exits within 5 s (mutation check: no-op the kill call, the test must fail)**

- [ ] **Step 1: Write the failing integration test** — add to `mod tests` in `pty.rs`:

  ```rust
  #[test]
  fn kill_terminates_real_child() {
      use portable_pty::{CommandBuilder, PtySize, native_pty_system};
      use std::time::Duration;
      let sys = native_pty_system();
      let pair = sys.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
      let mut cmd = CommandBuilder::new("/bin/sh");
      cmd.args(["-c", "sleep 30"]);
      let mut child = pair.slave.spawn_command(cmd).unwrap();
      let mut killer = child.clone_killer().unwrap();
      killer.kill().unwrap();
      let (tx, rx) = std::sync::mpsc::channel();
      std::thread::spawn(move || { tx.send(child.wait()).ok(); });
      let status = rx.recv_timeout(Duration::from_secs(5))
          .expect("child did not exit within 5 s after kill").unwrap();
      // A killed process exits non-zero; reaching here proves the child exited
      let _ = status;
  }
  ```

  Run `cargo test` — must fail to compile until Task 1 changes are in place.

- [ ] **Step 2: Add `pty_kill` after `pty_resize` in `pty.rs`:**

  ```rust
  #[tauri::command]
  pub async fn pty_kill(state: State<'_, AppState>) -> CmdResult<()> {
      let (killer_arc, exit_cv) = {
          let guard = state.pty.lock().unwrap();
          match guard.as_ref() {
              Some((_, h)) => (Arc::clone(&h.killer), Arc::clone(&h.exit_cv)),
              None => return Ok(()), // nothing running — no-op
          }
      }; // Mutex released before any blocking work
      tokio::task::spawn_blocking(move || -> CmdResult<()> {
          killer_arc.lock().unwrap().kill()
              .map_err(|e| InstallerError::Pty(e.to_string()))?;
          let (lk, cv) = &*exit_cv;
          let guard = lk.lock().unwrap();
          let (timed_out_guard, timed_out) = cv
              .wait_timeout(guard, std::time::Duration::from_secs(5))
              .unwrap();
          if timed_out.timed_out() && !*timed_out_guard {
              return Err(InstallerError::Pty("pty_kill timed out".into()));
          }
          Ok(())
      })
      .await
      .map_err(|e| InstallerError::Other(e.to_string()))?
  }
  ```

- [ ] **Step 3: Register in `lib.rs`** — append `commands::pty::pty_kill,` after `commands::pty::pty_resize,` in the `invoke_handler!` macro. (`pub mod pty;` at `mod.rs:7` already covers all functions in `pty.rs` — no `mod.rs` change needed.)

- [ ] **Step 4:** `cargo fmt && cargo clippy -- -D warnings && cargo test` from `src-tauri/`. All must pass including the new integration test.

- [ ] **Step 5:** Commit.

---

### Task 3: JS — spawnPty(onData), per-id data routing, kill export, and dynamic-import test

**Files:**
- Modify: `ui/runner-bridge.js`
- Modify: `ui/renderer.js`
- Modify: `ui/handlers.js`
- Create: `ui/test/pty-bridge.test.mjs`

**Interfaces:**
- Consumes: `invoke('spawn_pty', { cmd, cols, rows, runId })` returns `String` (the echoed id); `engine:pty-exit` payload `{ id, code }`; `engine:pty-data` payload `{ id, data }`.
- Produces: `pty.spawnPty(cmd, cols, rows, onData?) => Promise<{ code, id }>`; `pty.kill() => Promise<void>`. No `listenData` export — `onData` on `spawnPty` is the sole per-run data surface.

**Test-first: yes — `spawnPty resolves only on its own id and onData filters by id` fails until `spawnPty` adds per-id routing on both data and exit (mutation check: remove the id filter in the data listener, the test must fail)**

- [ ] **Step 1: Create `ui/test/pty-bridge.test.mjs`:**

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';

  test('spawnPty resolves only on its own id and onData filters by id', async () => {
    const listeners = {};
    const invocations = [];
    const fakeListen = async (evt, cb) => {
      (listeners[evt] ??= []).push(cb);
      return () => {};
    };
    const fakeInvoke = async (cmd, args) => {
      invocations.push({ cmd, args });
      return args?.runId ?? null; // echo back the id the bridge generated
    };
    globalThis.window = {
      __TAURI__: { core: { invoke: fakeInvoke }, event: { listen: fakeListen } }
    };
    const { pty } = await import('../runner-bridge.js');

    const received = [];
    const p = pty.spawnPty('echo hi', 80, 24, d => received.push(d));
    // Yield so spawnPty can register its listeners before we fire events
    await new Promise(r => setTimeout(r, 0));

    const id = invocations.find(i => i.cmd === 'spawn_pty')?.args?.runId;
    assert.ok(id, 'spawn_pty must be invoked with a runId');

    // Wrong-id data must NOT reach onData
    listeners['engine:pty-data']?.forEach(cb => cb({ payload: { id: 'pty-other', data: 'noise' } }));
    // Correct-id data must reach onData
    listeners['engine:pty-data']?.forEach(cb => cb({ payload: { id, data: 'signal' } }));
    // Wrong-id exit must NOT resolve the promise
    listeners['engine:pty-exit']?.forEach(cb => cb({ payload: { id: 'pty-other', code: 99 } }));
    await new Promise(r => setTimeout(r, 10));
    // Correct-id exit resolves
    listeners['engine:pty-exit']?.forEach(cb => cb({ payload: { id, code: 0 } }));

    const result = await p;
    assert.deepEqual(received, ['signal'], 'onData must only deliver data for own id');
    assert.deepEqual(result, { code: 0, id }, 'spawnPty must resolve with { code, id }');
  });
  ```

  Run `node --test ui/test/pty-bridge.test.mjs` — must fail (import of runner-bridge.js fails or spawnPty has wrong behaviour).

- [ ] **Step 2: Replace `spawnPty` at `runner-bridge.js:113-125`** — mirror the `runStream(cmd, onLine)` pattern (listener registered before invoke, cleaned up in finally, per-id guard on every callback):

  ```js
  async spawnPty(cmd, cols = 100, rows = 30, onData) {
    const id = nextId('pty');
    let resolveExit, dataUnlisten;
    const exitP = new Promise(r => { resolveExit = r; });
    // Register data listener BEFORE invoke so no early events for this id are missed
    if (onData) {
      dataUnlisten = await listen('engine:pty-data', (e) => {
        if (e.payload.id === id) onData(e.payload.data);
      });
    }
    const exitUnlisten = await listen('engine:pty-exit', (e) => {
      if (e.payload.id === id) resolveExit(e.payload.code);
    });
    try {
      await invoke('spawn_pty', { cmd, cols, rows, runId: id });
      const code = await exitP;
      return { code, id };
    } finally {
      exitUnlisten();
      dataUnlisten?.();
    }
  },
  ```

- [ ] **Step 3: Add `kill` to the `pty` export** after `resize` (no `listenData` — `onData` on `spawnPty` is the only per-run data surface):

  ```js
  kill: () => invoke('pty_kill'),
  ```

- [ ] **Step 4: Fix the call sites that now receive `{ code, id }` instead of a plain number:**

  - `renderer.js runAction:~300` — `const code = await bridge.pty.spawnPty(cmd)` → `const { code } = await bridge.pty.spawnPty(cmd)`
  - `handlers.js runPty:~65` — `.then((code) => {` → `.then(({ code }) => {`

  The global `engine:pty-data` / `engine:pty-exit` listeners in `renderer.js` reference `e.payload.data` and `e.payload.code` — those fields are unchanged; no edit needed there.

- [ ] **Step 5:** Run `node --test ui/test/pty-bridge.test.mjs` — test must pass.

- [ ] **Step 6:** Run `npm test` from repo root. All tests must pass.

- [ ] **Step 7:** Commit.

---

## Negative-constraint pass

| Constraint | Verified by |
|---|---|
| No concurrent-spawn guard | `spawn_pty` (T1) contains no guard that rejects a second invoke while one is running; `pty_kill` (T2) contains no such guard either. |
| Mutex not held across blocking calls | T2 `pty_kill` extracts `killer_arc` and `exit_cv` in a brief lock block, then releases before `spawn_blocking`. |
| Additive payloads only | T1 reader/wait threads append `id` to existing `{ data }` / `{ code }` shapes; existing keys are not renamed or removed. |
| No SIGKILL escalation, no pid field | T1 `PtyHandle` has no `pid` field; T2 `pty_kill` has no `std::process::Command::new("kill")` call; timeout returns a plain error. |
| No `listenData` export | T3 `pty` object exports only `spawnPty`, `input`, `resize`, `kill`; per-run data is exclusively via the `onData` parameter on `spawnPty`. |
| No new Cargo dependencies | T2 `pty_kill` uses only `tokio::task::spawn_blocking` and `std::time::Duration` (both already present); no `libc` or other crate added. |
| `mod.rs` not forgotten | T2 Step 3 explicitly notes `pub mod pty;` at `mod.rs:7` already covers `pty_kill`; only `lib.rs` is changed. |

`negative-constraints`: all seven stated constraints are satisfied; no task violates any of them.
