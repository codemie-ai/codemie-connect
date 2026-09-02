# Code review — 2026-09-02-epmcdme-14647-pty-correlation-id (2026-09-02)

**request-changes** · confidence: low · 6 blocking · 0 deferred · 0 filtered as noise
Coverage: blind — n/a (compact profile) · edge-case ✓ · verification-gap — n/a (compact profile) · acceptance — n/a (no spec)  (1/1 lenses ran)

No acceptance spec present; confidence is low (no-spec mode).

## Look here first

- `ui/runner-bridge.js:131` — [infra] spawnPty awaits exitP with no timeout; UI freezes forever if Tauri emit fails post-spawn — CR-006
- `ui/runner-bridge.js:122` — [infra] pty-data listener leaks when exit-listen throws; stacks across repeated spawnPty calls — CR-005
- `src-tauri/src/commands/pty.rs:209` — [infra] wait_timeout not guarded against spurious wakeup; returns Ok() while child is still alive — CR-004
- `src-tauri/src/commands/pty.rs:207` — [infra] condvar wait skips pre-exit flag check; blocks full 5 s when child already gone — CR-003
- `src-tauri/src/commands/pty.rs:202` — [infra] kill() not tolerant of ESRCH; returns error when process already exited — CR-002

## Also flagged

- `src-tauri/src/commands/pty.rs:193` — [infra] pty_kill has no run_id guard; a new session can be killed instead of the intended one — CR-001

## Checked and clean

standards — n/a (not expected) · 0 deferred
