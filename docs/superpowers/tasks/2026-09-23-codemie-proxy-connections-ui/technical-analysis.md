# Technical Research

**Task**: proxy connection management ui
**Generated**: 2026-09-23
**Research path**: filesystem

---

## 1. Original Context

CodeMie Desktop Stage 2 — Connections screen. Expose codemie proxy connection management in the app UI so users can connect supported AI client apps (Claude Desktop, VS Code, Codex) to their CodeMie profile without using the terminal. Scope: list currently connected client apps and connection status; add a new connection (select app type, run `codemie proxy connect [app]` in a PTY, parse output for success/failure); remove a connection (confirm, run `codemie proxy disconnect [app]`, reflect result); show connection health (proxy running/stopped/unreachable); start/stop the proxy from the UI. Depends on Stage 1 (app shell, runtime wiring, PTY infrastructure) being complete, and on the CLI team confirming the `codemie proxy` sub-command interface. Out of scope: Claude Desktop / VS Code installer download.

---

## 2. Codebase Findings

### Existing Implementations

- `ui/index.html:196-225` — `#connect-view`, a single-app "Connect Claude Desktop" screen (hardcoded title/copy). Two buttons: `#connect-btn` (Connect) and `#restart-btn` (Restart). No app picker, no list of connections, no status/health display.
- `ui/index.html:52-83` — `#app-sidebar` nav (Home / Agents / Connections / Health) exists in markup but carries the `hidden` class with an explicit comment: *"Agents, Connections and Health are Stage 2 screens, so shipping the nav now would advertise three entries that lead nowhere."* `#sidebar-connections` (`data-view="connect"`) and `#sidebar-health` (`data-view="health"`) are already wired to `showView()` in `ui/renderer.js:741-746`, just hidden.
- `ui/index.html:191` — `#health-view` exists as an empty placeholder div; `ui/renderer.js:73` maps it in the `views` object. No content or logic behind it yet.
- `ui/renderer.js:352-361` — `runAction(title, cmd, returnView, hint)`: generic one-shot "run a command in the PTY overlay, show pass/fail, return to a named view" helper. Currently the only call sites are Claude-Desktop-specific:
  - `ui/renderer.js:757` — `runAction('Connect Claude Desktop', 'codemie proxy connect desktop', 'connect', ...)`
  - `ui/renderer.js:764` — `runAction('Restart Claude Desktop proxy', 'codemie proxy stop; codemie proxy connect desktop', 'connect')`
- `ui/renderer.js:368-386` — `ensureAuthenticated()`: gates an action on `bridge.inspector.checkProfileStatus()`, shows a blocking notice ("Run setup") if `not_signed_in`/`no_profile`. Used before every existing proxy action.
- `ui/renderer.js:394-427` — `startSignIn()`: runs `codemie profile login` via `bridge.runner.runStream`, then re-reads profile status; does not trust exit code, scans stdout via `findLoginError` (`ui/signin-parse.js`) — the established pattern for CLI output parsing without relying on process exit codes.
- `ui/signin-parse.js` — pure parser (`findLoginError`), no browser globals, unit-testable in Node. The convention for "parse output for success/failure" the task calls for.
- `src-tauri/src/commands/inspector.rs:186-192` — `check_profile_status()` runs `codemie profile status < /dev/null` and calls `parse_profile_status(stdout, stderr)` (pure Rust fn, unit-tested at lines ~283-320+) to derive `{ state, detail }` (`signed_in` / `not_signed_in` / `unknown`). Model for turning raw CLI table output into a typed status.
- `src-tauri/src/commands/pty.rs` — `spawn_pty`/`pty_input`/`pty_resize`/`pty_kill` backed by `portable-pty`; reader pumped on a dedicated OS thread (not tokio) because the read is blocking. Emits `engine:pty-data` (base64-encoded chunks) / `engine:pty-exit`.
- `src-tauri/src/state.rs` — `AppState.pty: Mutex<Option<(String, PtyHandle)>>` — **a single active PTY slot**, keyed by run id. Only one interactive/streamed command can run at a time app-wide.
- `ui/runner-bridge.js` — `pty.spawnPty(cmd, cols, rows, onData)` returns `{ code, id }`; `runner.runStream(cmd, onLine)` returns `{ code }` (non-interactive, line-streamed, no keystroke forwarding) — the two existing options for running a `codemie proxy …` command and observing output.
- `ui/terminal.js` — hosts the PTY overlay (`openTerminal`/`writeLine`/`handlePtyExit`); `opts.keepOpen` (used by `runAction`) keeps the overlay open with a "Back" affordance instead of auto-closing, so the user can read command output before returning to the Connections view.

### Architecture and Layers Affected

- **Frontend view layer** (`ui/index.html`, `ui/renderer.js`, `ui/styles.css`) — the Connections screen itself: app list, status badges, add/remove flows, start/stop controls. Per the "frontend-brain" architecture (`.ai-run/guides/architecture/architecture.md`), all sequencing/branching logic belongs here, not in Rust.
- **Bridge layer** (`ui/runner-bridge.js`) — any new Rust command needs a JS wrapper added here before `renderer.js` can call it.
- **Backend command layer** (`src-tauri/src/commands/*.rs`, registered in `src-tauri/src/lib.rs`) — thin wrappers only; existing `runner.rs` (`run_capture`/`run_stream`/`run_fresh_env`) and `pty.rs` are the only mechanisms today for invoking a shell command. No `commands/proxy.rs` exists.
- **State layer** (`src-tauri/src/state.rs`) — the single-slot `pty` field is a structural constraint: "start/stop the proxy" and "connect an app" both going through the same PTY slot means only one such operation can be in flight at once, and the UI must serialize or queue rather than run them concurrently.

### Integration Points

- External process: the `codemie` CLI binary, invoked as a shell command string (`codemie proxy connect desktop`, `codemie proxy stop`, `codemie profile status`) via `run_capture`/`run_stream`/`spawn_pty` — never invoked as a linked library or HTTP client.
- No `codemie proxy list`, `codemie proxy status`, or `codemie proxy disconnect` sub-command is referenced anywhere in this codebase — only `connect desktop` and `stop` exist as call sites today. This lines up with the task's explicit dependency on "the CLI team confirming the `codemie proxy` sub-command interface."
- No references to VS Code or Codex client apps anywhere in `ui/*.js`, `ui/index.html`, or `src-tauri/src` — Claude Desktop (`desktop`) is the only app type wired end to end.

### Patterns and Conventions

- One Rust command per system concern, registered in `lib.rs`'s `invoke_handler!`, wrapped in `runner-bridge.js` under a named export group (`inspector`, `runner`, `pty`, `pathman`, …) — see "Adding New System Commands" in the architecture guide.
- `CmdResult<T>` / `InstallerError` (thiserror) for fallible commands (`src-tauri/src/error.rs`); infallible ones return `T` directly (e.g. `check_profile_status` returns `ProfileStatus` directly, no `Result`).
- CLI stdout is parsed, not the exit code trusted, for success/failure signal (`findLoginError`, `parse_profile_status`) — both `profile login` and (per the task) `proxy connect`/`disconnect` need this because the CLI can exit 0 on a failure path.
- Gate destructive/network actions behind `ensureAuthenticated()` before invoking `runAction`.
- View routing is a flat `showView(name)` over a `views` object keyed by view id (`ui/renderer.js:72-79`), toggling a `hidden` class — no router library or framework.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — authoritative for IPC pattern, state pattern, and the "Adding New System Commands" checklist (create/extend a `commands/` module → `#[tauri::command]` → `CmdResult<T>` or `T` → register in `lib.rs` → JS wrapper in `runner-bridge.js` → Rust unit test).
- `.ai-run/guides/testing/testing-patterns.md`, `.ai-run/guides/development/development-practices.md`, `.ai-run/guides/quality-gates.md` — general Rust/JS testing and dev conventions (not read in full for this pass; flagged for the planning stage).
- `docs/superpowers/tasks/2026-06-11-home-launcher/` (spec.md, plan.md, technical-analysis.md) — the task that built the *current*, Claude-Desktop-only Connect screen this task extends. Its technical-analysis.md records CLI facts sourced from a sibling CLI checkout (see Section 8) and the risk that "Connect"/"Restart" are one-shot PTY actions, not `engine.run()` wizard steps.
- `README.md:20` and `:227` — user-facing description of the current Connect Claude Desktop flow and a note that proxy-connect/analytics network actions are gated (never run unattended/under smoke).

### Architectural Decisions

- `ui/index.html:52-57` (inline comment) — explicit, in-repo record that Agents/Connections/Health are deliberately hidden pending their "Stage 2" implementation, and that removing the `hidden` class on `#app-sidebar` is the intended way to ship them once built.
- `src-tauri/src/commands/pty.rs` header comment — records the constraint that portable-pty's reader is blocking and must run on a dedicated thread, not a tokio task.

### Derived Conventions

- No guide covers the Connections screen specifically; conventions above (parse stdout not exit code, gate on `ensureAuthenticated`, one Rust command module per concern) are derived from the existing Connect/sign-in code.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/signin.test.mjs` — covers `findLoginError` (`ui/signin-parse.js`).
- `ui/test/pty-bridge.test.mjs`, `ui/test/terminal-suspend.test.mjs` — cover `runner-bridge.js` pty wrapper and `terminal.js` keystroke-suspend behavior.
- `ui/test/auth-gate.test.mjs` — likely covers `ensureAuthenticated`/blocked-state gating (not opened in full; name matches the pattern used in renderer.js).
- `src-tauri/src/commands/inspector.rs` `#[cfg(test)]` module — unit tests for `parse_profile_status` against real and documented-pattern CLI output fixtures.
- No test file currently exercises `runAction`, the `#connect-view` DOM, or any multi-app/list rendering — there is no list UI yet to test.

### Testing Framework and Patterns

- JS: Node's built-in `node:test` runner (`npm test` → `node --test ui/test/*.test.mjs`), no Jest/Mocha/Vitest dependency. Pure-logic modules (`*-parse.js`) are written to have no browser globals so they import cleanly in Node.
- Rust: inline `#[cfg(test)]` modules per command file, asserting on pure parsing functions with both real captured CLI output and documented-pattern fallbacks where a real fixture isn't reproducible (see the `profile_status_expired_no_real_fixture_pattern_only` test).
- A separate Playwright suite exists (`npm run test:ui`) but lives under a specific prior task's `dynamic-tests` directory, not a general end-to-end harness.

### Coverage Gaps

- No `codemie proxy` output-parsing function exists yet (unlike `findLoginError`/`parse_profile_status`), so success/failure detection for `proxy connect`/`proxy disconnect` has no test scaffold to extend — it will be new.
- No test coverage for any multi-item list rendering pattern in this codebase (no other screen renders a dynamic list of items with per-item actions) — this will be a novel UI pattern here.
- No health/status-polling logic or test exists for "proxy running/stopped/unreachable."

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` — smoke/probe mode flags read at boot (`lib.rs`, `commands/smoke.rs`); `README.md:227` and the home-launcher risk notes state that network actions (`proxy connect`, `analytics`) are never run under smoke/unattended flows. Any new Connections screen must keep the same exclusion.
- No `codemie`-proxy-specific env vars found in the codebase.

### Configuration Files

- `config/steps.yaml` (embedded via `include_str!`, served by `steps::get_steps()`) — drives the install/setup wizard step list; contains no proxy-related entries today (proxy actions are one-shot `runAction` calls, not wizard steps).
- No `.env.example`, `appsettings.json`, or equivalent app-level config file for this domain.

### Feature Flags and Deployment Concerns

- The `#app-sidebar` `hidden` class (`ui/index.html:52-83`) functions as the de facto feature flag gating Agents/Connections/Health — removing it is the documented "ship it" step once the screens exist.
- No Dockerfile/CI reference to `codemie proxy` found.

---

## 6. Risk Indicators

- **CLI interface not yet confirmed** (per task text): only `codemie proxy connect desktop` and `codemie proxy stop` are exercised anywhere in this repo. `codemie proxy connect vscode`, `codemie proxy connect codex`, `codemie proxy disconnect [app]`, and any "list connections" / "health" sub-command are unverified against the actual CLI — the task's own stated dependency on CLI-team confirmation is the top risk.
- **Single global PTY slot** (`src-tauri/src/state.rs` — `pty: Mutex<Option<(String, PtyHandle)>>`): the backend can run only one interactive/streamed command at a time. A Connections screen with independent per-app connect/disconnect actions plus a separate start/stop-proxy control must serialize these against each other; the existing UI has never had to coordinate more than one `runAction` at a time.
- **No existing "list of items" UI pattern** in this codebase to reuse — the current Connect screen is single-app, hardcoded copy, not data-driven. Building a list of connected apps with per-item status/actions is new UI, not an extension of an existing pattern.
- **No output-parsing function exists yet** for `proxy connect`/`proxy disconnect`/health output — `findLoginError` and `parse_profile_status` are the closest analogs but parse different CLI surfaces; new parsing logic (and its "no real fixture" test risk, as seen in `profile_status_expired_no_real_fixture_pattern_only`) is likely needed.
- **Sidebar currently `hidden`** with an explicit comment tying its reveal to Stage 2 completion — unhiding it prematurely (before Health, if out of this ticket's scope) would expose a view with no content, repeating the exact problem the comment warns about.
- Speculative: a "connection health" indicator (proxy running/stopped/unreachable) will likely need either a new Rust command (e.g., a `codemie proxy status` wrapper) or a polling loop in the frontend — neither exists today.

---

## 7. Summary for Complexity Assessment

This task extends an existing but narrow feature: today's `#connect-view` is a single, hardcoded "Connect Claude Desktop" screen wired through `runAction()` (a generic PTY-run-and-report helper) and gated by `ensureAuthenticated()`. The task requires generalizing this into a data-driven Connections screen — list of connected apps, add/remove per app type, connection health, and proxy start/stop — touching the frontend view layer (`ui/index.html`, `ui/renderer.js`, `ui/styles.css`), likely a new pure-JS output parser module (mirroring `ui/signin-parse.js`), and possibly a new Rust command module (mirroring `inspector.rs`'s `check_profile_status`/`parse_profile_status` pattern) if a proxy-status/list sub-command becomes available. The IPC and PTY plumbing (`runner-bridge.js`, `pty.rs`, `state.rs`) already exists and needs no structural rework beyond respecting the single active-PTY-slot constraint.

The main sources of complexity are architectural novelty rather than raw file count: there is no existing multi-item list UI, no existing multi-app CLI wiring (VS Code and Codex have zero references anywhere in the repo), and no output parser for proxy connect/disconnect/health. Combined with the task's own explicit dependency on the CLI team confirming the `codemie proxy` sub-command surface, the actual command set this screen must call (and the shape of its output) is not yet knowable from this codebase — the closest precedent (`codemie proxy connect desktop` / `codemie proxy stop`) covers only two of the several sub-commands this task implies (list/status, disconnect, per-app connect for three app types, start/stop). Test coverage for the new surface will start from zero and should follow the pure-parser-plus-node:test pattern already established for `findLoginError`.

---

## 8. External References

None named by the task. `task_context` states a dependency on "the CLI team confirming the `codemie proxy` sub-command interface" but does not point at a specific file, path, or URL as the source of truth for that interface.

For context only (not a task-named source, so not treated as authoritative here): `docs/superpowers/tasks/2026-06-11-home-launcher/technical-analysis.md:27-31` records CLI facts sourced from a sibling checkout at `/Users/Vadym_Vlasenko/AI/projects/codemie-code` (a different user's machine, not present on this one) — specifically that `codemie proxy connect desktop` has preconditions of `codemie setup` completed, an active SSO-backed profile with valid creds, and a configured `codeMieUrl` (cited to `src/cli/commands/proxy/index.ts:247-401` in that external checkout). That path was not re-verified in this pass since the current task named no such source.
