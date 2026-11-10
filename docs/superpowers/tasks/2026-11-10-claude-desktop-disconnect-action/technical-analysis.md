# Technical Research

**Task**: claude desktop disconnect proxy
**Generated**: 2026-11-10
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16925, "CodeMie Connect: Add a Claude Desktop disconnect action"

Summary: Let users disconnect Claude Desktop from the CodeMie gateway directly in CodeMie Connect, without manually editing Claude Desktop configuration files or leaving the app with a broken connection.

Description: When a user connects Claude Desktop to the CodeMie gateway, CodeMie Connect should provide a clear way to disconnect it later. The action should use the CLI disconnect capability delivered by EPMCDME-15246, present the result, and update the connection state. Users should also be able to find documented guidance for disconnecting and reconnecting.

Preconditions: CodeMie Connect can invoke the CodeMie CLI and display its output. EPMCDME-15246 provides a working `codemie proxy disconnect --claude-desktop` command.

Scenarios: user connected Claude Desktop and wants to return to another Claude profile; selects Disconnect in CodeMie Connect and confirms; app runs CLI disconnect, displays success or actionable failure, refreshes connection state; user consults Claude Desktop guide / CodeMie Connect help for disconnect and reconnect instructions.

Affected areas: CodeMie Connect Claude Desktop connection UI and status; CLI invocation, output and error presentation; Claude Desktop connection and troubleshooting documentation.

Acceptance Criteria:
1. When Claude Desktop is connected, CodeMie Connect offers a clearly labeled *Disconnect* action.
2. Before disconnecting, the UI explains that the action removes the CodeMie-managed Claude Desktop connection configuration.
3. On confirmation, CodeMie Connect invokes `codemie proxy disconnect --claude-desktop` and shows the command's result.
4. On success, the UI refreshes the connection state and no longer reports Claude Desktop as connected to the CodeMie gateway.
5. If the command fails, CodeMie Connect displays an actionable error and does not show a successful disconnection state.
6. The UI handles the case where Claude Desktop is already disconnected without presenting it as a failure.
7. The Claude Desktop guide and CodeMie Connect documentation explain how to disconnect and reconnect.
8. The UI does not claim that the proxy daemon was stopped or offer a "stop proxy but keep configuration" option unless the CLI supports that behavior.
Dependency: EPMCDME-15246 (CLI disconnect; blocked-by, status Ready for Review). Related closed: EPMCDME-14574 (Desktop Connections screen).

Extra from requester: CLI source at `C:\Users\RatiGigauri\source\codemie-code` (read-only; precondition PRs merged on its main but unreleased; user will build locally).

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A: connect Claude Desktop (the thing to reverse)**
- `ui/index.html:155-178` — `#connect-view` with two buttons `#connect-btn`, `#restart-btn` (`.connect-action`, `.ca-title`/`.ca-desc`). No Disconnect button.
- `ui/renderer.js:915-926` — click handlers. Both gate on `ensureAuthenticated()` (`:562`), then `runAction(title, cmd, 'connect', hint)`. Connect runs `codemie proxy connect desktop` (the CLI's *deprecated alias* of `connect --claude-desktop`; prints a deprecation warning, `codemie-code .../proxy/index.ts:364-381`). Restart runs `codemie proxy stop; codemie proxy connect desktop` (`;` so a no-op stop still proceeds).
- `ui/renderer.js:465-488` — `runAction`: opens the terminal overlay (`openTerminal`, `ui/terminal.js`), `bridge.pty.spawnPty(cmd)` (PTY, one slot), writes `✓/✗ Finished (exit N)`, return to `returnView` on close. Refuses while guided setup holds the PTY slot (notice "Setup is still running").
- Other command styles in the app: `bridge.runner.runCapture(cmd)` -> `{code, stdout, ...}` (used by `refreshConnection`, `:250`); `runStream(cmd, onLine)` (used by `startSignIn`, `:597`, which scans stdout because "the CLI exits 0 on some failure paths").
- Shell: `src-tauri/src/commands/runner.rs:2-3,33-64` — macOS `/bin/zsh -lc`, Windows `cmd.exe /c` (hidden window). Same command string works on both; `;` chaining is already used with cmd.exe.

**Purpose B: show whether Claude Desktop is connected**
- `ui/renderer.js:246-258` `refreshConnection()` — runs `codemie proxy status --json`, sets `home.connection = connectionFromStatus(stdout)`, `renderHome()`. Called from `:340` (showView), `:833` (window focus, skipped during install/setup), `:894` (boot).
- `ui/home-state.js:132-150` — `connectionFromStatus` (`running = status in {healthy, unhealthy}`) and `connectionsCard`: badge "1 connected" / "not responding" / "not connected" / "unknown" / "checking", line "Claude Desktop".
- Rule: **"connected" == the CLI proxy daemon is running.** It reads no Claude Desktop config. Tests: `ui/test/home-state.test.mjs:254-275`.
- Consumers of this state: only the Home Connections card (`home-state.js`) and `home-view.js` rendering. The Connect screen shows no state.

**Purpose C: what the CLI disconnect does** (`C:\Users\RatiGigauri\source\codemie-code`)
- The local checkout is branch `EPMCDME-15952-investigation`, local `main` at `b124a091` and `origin/main` at last-fetched state; **both have `proxy disconnect` WITHOUT `--claude-desktop`** (`src/cli/commands/proxy/index.ts:341-361`, only `--codex-desktop` and `--claude-code-otlp`; with no target it prints the target list and exits 0). Not fetched, per instructions. The 15246 work is on `erithiel/EPMCDME-15246-resolve-pr580-conflicts` (tip `b9ccc8dc`); read via `git show`, not checked out. Behaviour below is from that branch and is unverified against the real merged main.
- Flag: `--claude-desktop` ("Remove the CodeMie MCP entries and gateway config from Claude Desktop"), branch `index.ts:343`; also `--vscode`, `--vscode-claude-code`, `--codex-desktop`, `--claude-code-otlp`.
- `disconnect-orchestrator.ts` (branch) `runClaudeDesktop`/`disconnectTargets`:
  - Success, config cleaned: stdout `✓ Claude Desktop disconnected (<configPath>)`, then `\nTargets disconnected:` and `  ✓ Claude Desktop`. Exit 0.
  - **Already disconnected**: stdout `Claude Desktop: nothing to disconnect.` then summary `  ✓ Claude Desktop`. Exit 0 (`ok: true`). Same summary line as real success; the two are distinguishable only by the first line's text.
  - Failure: stderr `✗ Claude Desktop — <message>`, stdout summary `  ✗ Claude Desktop  — <message>`, `process.exitCode = 1`. Known message from `connectors/desktop.ts:955-`: `Claude Desktop config at <path> is not valid JSON and was not changed: ...` (config left untouched).
  - Output is chalk-coloured; non-TTY capture normally strips ANSI (chalk detects no colour support), PTY output keeps it.
  - Not-installed / no config file -> `removed:false` -> "nothing to disconnect" (exit 0).
  - **The daemon is not stopped** (header comment of the orchestrator: "deliberately left running ... stopping it is `codemie proxy stop`'s job"). Disconnect strips gateway keys, `managedMcpServers` entries and the managed-MCP state marker from the Claude Desktop config.
- The pinned/bundled CLI is `@codemieai/code` 0.16.3 (`runtime.json`); the repo's `home-state.js:131` cites 0.15.2. Which release first carries `--claude-desktop` disconnect is **unverified** (unreleased per requester). Against a CLI without the flag, the command prints the target list and exits 0 (no error).

### Decisions Already in the Code

- Connection state = proxy daemon running (`home-state.js:132-150`); alternative (reading Claude Desktop config) not used; reason none recorded in code. Stored -> read: from `proxy status --json` only.
- Home actions that mutate go through the terminal-overlay `runAction` (`renderer.js:465`); read-only/parsed probes go through `runCapture`. Both exist as conventions.
- Confirmation/notice UI: `showNotice({title,message,primaryLabel,primaryAction})` (`renderer.js:363`) with a single primary button plus the close button (`noticeClose`); no existing two-button confirm other than this pattern (e.g. "Stop setup and continue" at `:467-478`).
- Auth gate: `ensureAuthenticated()` is applied to connect and restart; its notice text is connect-specific ("Connecting Claude Desktop needs a signed-in CodeMie profile", `:573`).
- Architecture convention (`.ai-run/guides/architecture/architecture.md`): orchestration in JS, no new Rust needed for a plain CLI command; new Rust commands only for system ops. Home-grid decision record `.ai-run/decisions/2026-09-21-EPMCDME-14589-home-grid-actions.md` places `connect-desktop` under the Connections sidebar entry (`#sidebar-connections`, `data-view="connect"`).

### Task Statements Checked Against the Code

- "CodeMie Connect can invoke the CodeMie CLI and display its output" — holds (`runAction`, `runCapture`, `runStream`).
- "EPMCDME-15246 provides a working `codemie proxy disconnect --claude-desktop`" — unverified on the local `main`/`origin/main` (flag absent there); present on `erithiel/EPMCDME-15246-resolve-pr580-conflicts`. The requester states it is merged but the local clone is behind; settle by building the fetched main and running `codemie proxy disconnect --claude-desktop --help`.
- AC1 "When Claude Desktop is connected, offers Disconnect" — "connected" today means proxy running (`home-state.js`); config-only connection (proxy stopped) is not detected.
- AC4 "no longer reports Claude Desktop as connected" — **contradicted by current state derivation combined with AC8/CLI behaviour**: the CLI leaves the daemon running, and `connectionFromStatus` reports "1 connected" whenever the daemon runs. After a successful disconnect the Home card (`home-state.js:144-149`) would still read "1 connected" and `refreshConnection` re-reads exactly that. This keeps `connectionsCard`/`connectionFromStatus` in place; consumers: Home Connections card and `ui/test/home-state.test.mjs:254-275`.
- AC6 "already disconnected not a failure" — holds in the CLI (exit 0, "nothing to disconnect"); the UI can only tell it from success by stdout text.
- AC8 "UI does not claim the proxy was stopped" — holds: CLI does not stop it (see above). The existing Restart action does stop it (`codemie proxy stop`).
- AC7 "Claude Desktop guide and CodeMie Connect documentation" — the only in-repo user docs mentioning Claude Desktop are `README.md` (lines ~7, 22-24, 71, 79); no separate "Claude Desktop guide" or help screen found in this repo (`docs/codemie/` holds only an analytics JSON; `#about-view` is empty and its sidebar entry hidden). A separate guide, if any, lives outside this repo (unverified).

### Consumers of Changed Contracts

- `connectionFromStatus` / `connectionsCard` (if the meaning of "connected" changes): `ui/home-state.js`, `ui/renderer.js:251`, `ui/test/home-state.test.mjs:256-275`, `ui/home-view.js` (card render). None found elsewhere (searched `connection`, `proxy status`).
- `#connect-actions` markup/CSS: `ui/index.html:166`, `ui/styles.css` `.connect-action`; Connect view hooks `connectBtn`/`restartBtn` in `renderer.js`. Tests touching the connect view: `ui/test/connect-marker.test.mjs` (about install-script marker, unrelated); Playwright tests under `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests` (referenced by `package.json test:ui`).
- `runAction`, `showNotice`: shared by analytics, restart, setup notices; no change required to call them.

### Architecture and Layers Affected

Frontend only is evident: `ui/index.html` (Connect view), `ui/renderer.js` (handlers, `runAction`/`runCapture`, `showNotice`), `ui/home-state.js` (state). Rust runner (`runner.rs`) is already generic.

### Integration Points

- CLI `codemie proxy disconnect --claude-desktop`, `codemie proxy status --json`, `codemie profile status` (via inspector).
- Claude Desktop config JSON (owned/edited by the CLI, not the app).

### Patterns and Conventions

- Vanilla ES modules, pure helpers split into separately unit-tested files (`home-state.js`, `signin-parse.js`, `analytics-command.js`); parse CLI stdout rather than trust exit code (`startSignIn` comment `renderer.js:582-584`).
- Windows and macOS share the same command strings; per-OS differences are in `runner.rs`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` present (architecture, testing, development, quality-gates, project, git-workflow). `README.md` "Basic usage" table (line ~71) describes Connections as "Connect ... or Restart"; step 3 of first run (line ~79).

### Architectural Decisions
`.ai-run/decisions/2026-09-21-EPMCDME-14589-home-grid-actions.md` (Connections entry point). CLI side: `codemie-code/docs/COMMANDS.md` (local main) documents only `--codex-desktop` disconnect (~line 304-310); `docs/ARCHITECTURE-PROXY.md` mentions disconnect.

### Derived Conventions
Copy is plain-language, sentence case, em dashes; `home-copy.test.mjs` pins wording.

---

## 4. Testing Landscape

### Existing Coverage
`ui/test/home-state.test.mjs` (connection card + status parsing), `home-copy.test.mjs` (copy/shell wiring, pins sidebar wiring), `ui/test/handlers.test.mjs`, `setup-leave.test.mjs`; Rust inline tests in `runner.rs:170-240` (zsh and cmd.exe capture).

### Testing Framework and Patterns
`node --test ui/test/*.test.mjs` (`package.json`); node:test + assert; Rust `#[cfg(test)]`. Pure-helper-plus-test pattern. Playwright dynamic tests under docs/superpowers task dir.

### Coverage Gaps
No test covers `renderer.js` handlers (`connectBtn`/`restartBtn`), `runAction`, or the Connect view markup. No parser for `proxy disconnect` output exists.

---

## 5. Configuration and Environment

### Environment Variables
None relevant (`CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE` unrelated).

### Configuration Files
`runtime.json` pins CLI `0.16.3` and Node 22.23.2 (bundled/downloaded runtime); `src-tauri/capabilities/default.json` (no change evident); `config/steps.yaml` unrelated.

### Feature Flags and Deployment Concerns
None found. CLI delivery: app updates the CLI in the background from npm (`update_cli`, `renderer.js:897`; `runtime.rs`), so the new flag reaches users when a CLI release containing it exists.

---

## 6. Risk Indicators

- Local `codemie-code` main and origin/main lack `--claude-desktop` on `disconnect` (`proxy/index.ts:341-361`); the feature is on branch `erithiel/EPMCDME-15246-resolve-pr580-conflicts`. Output strings above are from that branch and must be re-confirmed on the user's built main. Older CLI -> command prints a usage list and exits 0 (silent no-op; exit code alone cannot signal success).
- Connection state definition keeps "connected = daemon running" in place (`home-state.js:132-150`); CLI disconnect leaves the daemon running, so AC4 cannot be met by re-reading `proxy status` alone. See "Task Statements". Speculative: needs a different or additional signal, or a stop step, which then conflicts with AC8 wording.
- Success vs "nothing to disconnect" share exit 0 and the same summary line; distinguishing requires stdout text matching (ANSI possible in PTY).
- Failure is exit 1 with the `✗ Claude Desktop — msg` line; invalid-JSON config is the one named failure.
- `runAction` returns to the Connect view and shows only a terminal log; no existing confirm dialog with cancel, and `ensureAuthenticated` copy is connect-specific.
- Existing Connect uses the deprecated `connect desktop` alias; pairing text for reconnect docs may need consistent flag names.
- No in-repo Claude Desktop guide beyond `README.md`; AC7 target documents may be elsewhere (unverified).
- Untested renderer wiring; changes in `renderer.js` have no unit coverage.

---

## 7. Summary for Complexity Assessment

The change sits in the JS frontend: the Connect view (`ui/index.html`, `ui/renderer.js`) plus the connection-state derivation (`ui/home-state.js`) and README. No Rust change is evident: the runner already runs arbitrary command strings on both macOS (zsh) and Windows (cmd.exe). Reusable pieces exist (`runAction`, `runCapture`, `showNotice`, parse-and-test helper pattern). Surface is small (about 3-4 source files, README, 1-2 test files).

The main complexity is semantic, not mechanical: the app defines "connected" as "proxy daemon running", whereas the CLI disconnect strips Claude Desktop config and deliberately leaves the daemon running. AC4 and AC8 pull against that definition. Also, the CLI side is not yet in the local clone's main; behaviour was read from the 15246 branch (exit 0 for success and for "nothing to disconnect", exit 1 plus `✗ Claude Desktop — ...` on failure), and must be confirmed against the user's local build.

Test posture: pure helpers and state logic are well covered by node:test; renderer handlers and the Connect view have no unit tests, so new output-parsing logic should be a separate pure module. Documentation is thin: only `README.md` mentions Connections; no separate Claude Desktop guide or help screen found.

---

## 8. External References

Named by the task: `C:\Users\RatiGigauri\source\codemie-code` (resolved, read-only).
- Local checkout branch `EPMCDME-15952-investigation`; `main` and `origin/main` have `proxy disconnect` with only `--codex-desktop` and `--claude-code-otlp` (`src/cli/commands/proxy/index.ts:341-361`, `disconnect-orchestrator.ts`). Not fetched.
- `erithiel/EPMCDME-15246-resolve-pr580-conflicts` (tip `b9ccc8dc`, read via `git show`) adds `--claude-desktop`. Facts: `removeDesktopConfig()` in `src/cli/commands/proxy/connectors/desktop.ts:955`; outputs `✓ Claude Desktop disconnected (<path>)` / `Claude Desktop: nothing to disconnect.` / stderr `✗ Claude Desktop — <message>`; summary block `Targets disconnected:` with `  ✓|✗ Claude Desktop`; exit 1 only on failure; daemon not stopped; no-target call prints the target list, exit 0.
- Connect side of the CLI: `connect --claude-desktop` ("writes MCP servers config"); `connect desktop` is a deprecated alias that prints a deprecation notice.
