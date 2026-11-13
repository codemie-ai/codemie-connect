# Spec: EPMCDME-15231 — cmdlog bridge instrumentation

**Status**: draft  
**Task**: Wrap five JS command-execution paths with cmdlog store recording; add streaming PTY TextDecoder, ANSI stripping, and node:test coverage.  
**Rust backend**: fully complete (EPMCDME-15230). Zero Rust changes in scope.

---

## Background

The Rust `CmdLogStore` (cmdlog_open / cmdlog_append / cmdlog_close) is registered and tested.
No JS path records against it yet. This spec wires the five JS execution paths to the store,
adds ANSI-stripped PTY text accumulation, and adds test coverage for all new behaviour.

Files changed: `ui/runner-bridge.js`, `ui/renderer.js`, new `ui/ansi-strip.mjs`,
new `ui/test/cmdlog-bridge.test.mjs`.

---

## Behaviour

### 1. `runner.runStream(cmd, onLine)`

- Call `cmdlog_open(cmd)` before `invoke('run_stream', ...)`. Store the returned `logId`.
- For each `engine:cmd-line` event filtered to this run's `streamId`, call `cmdlog_append(logId, text)`.
- After the stream invoke resolves (or rejects), call `cmdlog_close(logId, code ?? -1)`.
- `cmdlog_close` fires in a `finally` so it always runs even if the stream errors.
- Failures in cmdlog calls (open/append/close) must not propagate to the caller — console.warn, swallow.

### 2. `runner.runCapture(cmd)` and `runner.runFreshEnv(cmd)`

- Call `cmdlog_open(cmd)` before `invoke(...)`. Store the returned `logId`.
- After the invoke resolves, call `cmdlog_append(logId, result)` where `result` is the string
  returned by the Rust command.
- Call `cmdlog_close(logId, 0)` on success, `cmdlog_close(logId, -1)` on rejection, both in a `finally`.
- These paths have no live call sites today; wrapping is forward-looking.

### 3. `pty.spawnPty(cmd, cols, rows, onData)`

- Call `cmdlog_open(cmd)` before `invoke('spawn_pty', ...)`. Store the returned `logId`.
- Allocate one `TextDecoder('utf-8', { fatal: false })` inside the async function body
  (not at module scope), bound to this invocation only.
- Inside the existing `engine:pty-data` filtered handler (CR-005: inside the try block):
  - If `onData` is provided, call it with `event.payload.data` exactly as the existing implementation
    does — this contract is unchanged.
  - Base64-decode `event.payload.data` to `Uint8Array` (separate from the onData call above).
  - Call `decoder.decode(chunk, { stream: true })` to get a decoded text string.
  - Pass the decoded text through `stripAnsi(text)` (see §ANSI strip utility).
  - Call `cmdlog_append(logId, stripped)` if `stripped` is non-empty.
- On PTY exit (existing `engine:pty-exit` handler, in the finally):
  - Flush the TextDecoder: `decoder.decode(new Uint8Array(0), { stream: false })`.
  - Strip and append the flush remainder if non-empty.
  - Call `cmdlog_close(logId, exitCode ?? -1)`.
- `cmdlog_close` fires in the same `finally` block as the existing `unlisten` calls.
- The cmdlog accumulation path runs even when `onData` is `undefined` (e.g., `runAction` callers).
- Failures in cmdlog calls must not propagate — console.warn, swallow.

### 4. `updater.runSelfUpdate()`

- Call `cmdlog_open('run_self_update')` before `invoke('run_self_update')`.
- Call `cmdlog_close(logId, 0)` on success, `cmdlog_close(logId, -1)` on rejection, in a `finally`.
- No streaming output to append for this path.
- `renderer.js:485` must be updated from `invoke('run_self_update')` to
  `bridge.updater.runSelfUpdate()` in the same change as adding the cmdlog wrapping.

---

## Intent classification convention

`CmdRecord` has no intent field; classification is a code comment at each call site, not stored data.
Format: `// cmdlog intent: user-initiated` or `// cmdlog intent: read-only probe`.

Active call sites and their classification:
- `startSignIn → runStream('codemie profile login', ...)` — user-initiated
- `runAction → spawnPty(cmd, ...)` — user-initiated
- `runUpdateCli → updater.runSelfUpdate()` — user-initiated

`runCapture`/`runFreshEnv` gain the comment when they acquire live call sites.

---

## ANSI strip utility — `ui/ansi-strip.mjs`

Pure ES module, default export `stripAnsi(text: string): string`.

Removes:
- Complete CSI sequences: `ESC [ … <final-byte>` where final byte is `[A-Za-z]`.
- Complete OSC sequences: `ESC ] … BEL` (BEL = `\x07`).
- Other complete two-byte escape sequences: `ESC <single-char>` that are not CSI/OSC openers.

Does **not** remove a partial escape sequence at end of string (i.e., a trailing `\x1b` or
`\x1b[0` without a final byte). This is boundary-safe: if a PTY chunk ends mid-sequence,
the partial appears in the stored text as a short artefact rather than corrupting the next
chunk's sequence. Stateful carry-buffer stripping is a non-goal (see §Non-goals).

The function must be pure — no side effects, no global state.

---

## `cmdlog` bridge export

`runner-bridge.js` adds a thin export that the five wrapped paths use internally:

```js
export const cmdlog = {
  open:   (cmd)       => invoke('cmdlog_open',   { command: cmd }),
  append: (id, chunk) => invoke('cmdlog_append', { id, chunk }),
  close:  (id, code)  => invoke('cmdlog_close',  { id, exitCode: code }),
};
```

This new export is the only new public surface added to the bridge. Tests stub it via the
same mutable-delegate pattern used in `pty-bridge.test.mjs`.

---

## Test coverage — `ui/test/cmdlog-bridge.test.mjs`

Extends the `pty-bridge.test.mjs` mutable-delegate pattern (`invokeImpl`, `listenImpl`).
Must cover:

1. `runStream` — `cmdlog_open` called before `run_stream`; `cmdlog_append` called per
   `engine:cmd-line` event; `cmdlog_close` called with exit code after resolve.
2. `runCapture` — `cmdlog_open` before invoke; `cmdlog_append` with captured result;
   `cmdlog_close(0)` on resolve.
3. `runFreshEnv` — same shape as `runCapture`.
4. `spawnPty` — `cmdlog_open` before `spawn_pty`; for each synthetic `engine:pty-data` payload,
   `cmdlog_append` receives decoded+stripped text; `cmdlog_close` called with exit code on PTY exit.
5. `spawnPty` with `onData = undefined` — cmdlog accumulation still runs.
6. `updater.runSelfUpdate` — `cmdlog_open` before invoke; `cmdlog_close(0)` on resolve;
   `cmdlog_close(-1)` on rejection.

`ui/test/ansi-strip.test.mjs` (separate file, matches glob):

7. Strips a complete CSI color sequence.
8. Strips a complete OSC sequence.
9. Leaves plain text unchanged.
10. Does NOT strip a partial escape at end of string (boundary-safety).
11. Two sequential calls simulate chunk boundary: first call on text ending mid-sequence
    leaves a partial artefact; second call on the remainder strips the rest. Verify that the
    combination does not corrupt surrounding plain text.
12. `TextDecoder` streaming — synthetic multi-byte UTF-8 sequence split across two
    `engine:pty-data` payloads decodes correctly across the boundary.

---

## Non-goals

- No changes to `src-tauri/` — Rust layer is complete.
- No UI to display the command log (separate scope).
- No `intent` field added to `CmdRecord` (no Rust changes in scope).
- No stateful ANSI carry-buffer — partial escapes at chunk boundaries leave a short artefact; acceptable.
- No cmdlog wrapping for `pty.kill`, `pty.input`, `pty.resize` — control channels, not commands.
- No cmdlog wrapping for smoke-mode calls beyond what the bridge wrapping provides automatically.
- No new Tauri permissions or capability changes.
- No changes to `ui/terminal.js` — the xterm.js display path is independent.
- No new npm dependencies.

---

## Acceptance criteria

- All five paths (`runStream`, `runCapture`, `runFreshEnv`, `spawnPty`, `runSelfUpdate`) call
  `cmdlog_open` before execution and `cmdlog_close` in a `finally`.
- `spawnPty` allocates one `TextDecoder` per invocation inside the function body, not at module scope.
- PTY output is UTF-8 decoded via `{ stream: true }` before ANSI stripping; `onData` callers
  receive the original base64 payload unchanged.
- `stripAnsi` does not corrupt plain text adjacent to a PTY sequence split across two chunks.
- `cmdlog_open`/`append`/`close` failures do not throw to callers.
- `runUpdateCli` in `renderer.js` calls `bridge.updater.runSelfUpdate()`, not `invoke('run_self_update')`.
- `runAction` (which passes no `onData`) records PTY output in the cmdlog store.
- Every active call site has a `// cmdlog intent:` comment.
- `npm test` passes with new tests covering all items in §Test coverage.
- No new npm dependencies introduced.
