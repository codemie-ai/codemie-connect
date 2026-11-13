# EPMCDME-16925 Claude Desktop disconnect action — Plan

**Goal:** Connect view offers Disconnect for Claude Desktop; confirms, runs `codemie proxy disconnect --claude-desktop`, shows result, and a persisted local "disconnected" flag drives the "not connected" state.

**Architecture:** JS frontend only. Pure helpers in new `ui/disconnect.js` (parse + flag storage) and `ui/home-state.js` (flag overrides daemon state), wired in `ui/renderer.js`. Command runs via `bridge.runner.runCapture` (not the PTY `runAction`, which exposes no stdout) so the result can be parsed and shown in the notice modal. Commit per task using the repository's existing convention. Run gates from `.ai-run/guides/quality-gates.md`.

**Notes:** Installer pins CLI 0.16.3 (`runtime.json`); that release may lack `--claude-desktop` disconnect (older CLIs print a target list and exit 0). Do not bump; the parser treats unrecognised exit-0 output as "unknown result", not success. The proxy daemon is NOT stopped by the CLI and the UI must never say it was.

---

### Task 1 — Disconnect output parser
**Files:** create `ui/disconnect.js`, `ui/test/disconnect.test.mjs`.
Export `parseDisconnect({code, stdout, stderr})` returning `{kind: 'disconnected'|'nothing'|'failed'|'unknown', message}`. Strip ANSI first. Exit 0 + `Claude Desktop disconnected` -> `disconnected`; exit 0 + `nothing to disconnect` -> `nothing`; non-zero -> `failed` with message from the `✗ Claude Desktop — <msg>` line (fall back to trimmed stderr/stdout); exit 0 with neither phrase -> `unknown` (old CLI no-op).
Test-first: yes — table test over the CLI strings (success, already disconnected, failure, ANSI-wrapped, old-CLI target list exit 0 -> unknown).

### Task 2 — Local disconnected flag and state override
**Files:** `ui/disconnect.js`, `ui/home-state.js:143-150`, `ui/test/disconnect.test.mjs`, `ui/test/home-state.test.mjs:254-275`.
In `disconnect.js` add `readDisconnected(storage)`, `markDisconnected(storage)`, `clearDisconnected(storage)` over localStorage key `codemie.claudeDesktop.disconnected`, guarded against a missing or throwing storage like `homeStorage` (`renderer.js:192-199`). In `home-state.js`, `connectionsCard(connection)` treats `connection.disconnected === true` as the existing "not connected" card regardless of `running`.
Test-first: yes — `connectionsCard` with `{running:true, healthy:true, disconnected:true}` yields badge "not connected"; flag read/mark/clear round-trips on a fake storage and survives a throwing storage.

### Task 3 — Connect view Disconnect button and confirm
**Files:** `ui/index.html:155-178`, `ui/renderer.js:915-926` (confirm via `showNotice`, `:363`).
Add `#disconnect-btn` (`.connect-action`, title "Disconnect Claude Desktop", desc "Remove the CodeMie connection from Claude Desktop"), hidden while the local flag is set. Click handler calls `showNotice` with one primary "Disconnect" button (the notice close button is the cancel) and message: "This removes the CodeMie-managed Claude Desktop connection configuration. The CodeMie proxy keeps running. You can reconnect any time with Connect." No auth gate (disconnect needs no sign-in).
Test-first: no — renderer wiring has no unit harness; branching logic lives in Tasks 1-2.

### Task 4 — Run, report result, set flag, refresh
**Files:** `ui/renderer.js` (new `runDisconnect()` called from the notice primary action; `refreshConnection` at `:246-258`).
Run `bridge.runner.runCapture('codemie proxy disconnect --claude-desktop')`, parse with `parseDisconnect`. `disconnected` / `nothing` -> `markDisconnected(homeStorage)`, then `refreshConnection()` (which must merge `disconnected: readDisconnected(homeStorage)` into `home.connection`, also when status read fails or returns null), then `showNotice` "Claude Desktop disconnected" (or neutral "Already disconnected — nothing to remove"). `failed` -> notice with the CLI message plus "Nothing was changed; fix the issue and try again.", flag untouched. `unknown` -> notice "The installed CodeMie CLI did not confirm the disconnect. Update the CLI and try again.", flag untouched. A thrown runner error is treated as `failed`. The Connect handler (`:915-919`) additionally calls `clearDisconnected(homeStorage)` and refreshes before `runAction`. Never display text claiming the proxy stopped.
Test-first: no — renderer glue only; branching logic is covered by Tasks 1-2.

### Task 5 — README
**Files:** `README.md` (~lines 7, 22-24, 71, 79).
In the "Basic usage" Connections row and Claude Desktop text, document Disconnect (what it removes, proxy keeps running, confirm step) and reconnect via Connect; name CLI equivalents consistently as `codemie proxy connect --claude-desktop` and `codemie proxy disconnect --claude-desktop`. No separate in-repo Claude Desktop guide exists.
Test-first: no — documentation only.

---

negative-constraints (honored): no daemon stop and no "stop proxy but keep config" option (Tasks 3-4: copy says proxy keeps running, command has no `proxy stop`); failure never shows a disconnected state (Task 4 `failed`/`unknown` leave flag untouched); already-disconnected is not a failure (Task 1 `nothing`, Task 4 neutral notice); no CLI change, version bump or Rust change (Notes).
