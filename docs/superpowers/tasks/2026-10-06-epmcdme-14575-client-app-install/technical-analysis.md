# Technical Research

**Task**: connections install-client runConnectionRowAction proxy-parse
**Generated**: 2026-10-06
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14575. Take end to end: code through tests, gates, MR. Spec = ticket below.

Findings from the user:
- Branch feat/EPMCDME-14575-client-app-install off codemie-desktop-stage-2. MR targets codemie-desktop-stage-2, not main. Never commit .codemie/codemie-cli.config.json.
- CLI side is EPMCDME-15626 (codemie-code PR #613, unreleased). The app only runs `codemie proxy connect <flag> --install-client` and reads its output. It prints one ✓ line per step. A "no" prints "Install cancelled" and exits 0. Any failure prints a line starting with ✗, then a plain "Download page: <url>" line, and exits non-zero.
- runConnectionRowAction in ui/renderer.js builds connect, reconnect and disconnect; the install action in ui/connections-render.js:22 is disabled with "Install flow coming soon". Test ui/test/connections-render.test.mjs:26 asserts that disabled state and will flip.
- runAction collects PTY output and calls parseError but returns nothing, so exit code and error line never reach the row. refreshConnectionsView clears every row (renderer.js:651, connectRowsEl.innerHTML = ''), so a row error must survive that rebuild.
- findProxyConnectError in ui/proxy-parse.js matches ^\s*(✗|error:|failed:). PTY runs TERM=xterm-256color and the CLI prints ✗ in red, so the raw line starts with an escape code and doesn't match. Strip ANSI codes before matching ✗ and "Download page:".
- Download page URL comes from CLI output and shell commands run through a login shell (bridge.runner.runCapture). Only open it if it parses as an https URL, and quote safely, e.g. open '<url>' with single quotes escaped. No new Rust.
- On this branch nothing reads the CLI version (checkCodemieVersion, cliVersionState are gone). For "older CLI": run `codemie proxy connect --help` once and check it lists --install-client. If not, show the "needs a newer CodeMie CLI" note on the row and run nothing.
- End states already right: app_bundle_exists checks /Applications and ~/Applications, so after failed install row reads Not installed; after install whose connect failed it reads Not set.
- docs/wireframes/04-connections.png is reference only; terminal panel stands in for the confirmation card and step list, don't build those.
- Keep small. No Windows (EPMCDME-15609). Never run real codemie in tests. node:test with fakes like existing ui/test files; if driving the app, use a fake codemie script.

Ticket scope: enable Install and connect on macOS; run the command in the terminal panel like other row actions (user answers CLI's size question there); on failure show CLI's ✗ line on the row (ANSI stripped) plus "Open the download page" when a Download page: line printed; refresh the row when command finishes; older CLI => row says newer CodeMie CLI needed, don't run.
Acceptance: yes→app in ~/Applications, row Connected; no→Not installed, no error; install failure→reason + Open the download page, Not installed; install ok but connect failed→reason shown, Not set; older CLI→note, nothing runs.
Out of scope: Windows, Intel, later updates, outdated state, VS Code Insiders.

Load .ai-run/guides/architecture/architecture.md, testing/testing-patterns.md and development/development-practices.md as relevant. Focus on ui/renderer.js, ui/connections-render.js, ui/proxy-parse.js, ui/test/*, and how openUrl/runner.runCapture patterns exist today.

---

## 2. Codebase Findings

### Existing Implementations
- `ui/connections-render.js` (37 lines, DOM-free) — `CONNECTION_APPS` (claude-desktop, vscode-copilot, vscode-claude-code, codex-desktop, each with `connectFlag`) and `renderConnectionRows(statusesByApp)`. Line 22: status `not-installed` yields `[{kind:'install', label:'Install and connect', disabled:true, note:'Install flow coming soon'}]`. Other statuses: not-set gives connect; disconnected gives reconnect plus disconnect ("Remove setup"); connected gives disconnect.
- `ui/proxy-parse.js` — `findProxyConnectError(lines)`: `lines.find(l => /^\s*(✗|error:|failed:)/i.test(l))`, returns the trimmed line or null. No ANSI handling. Also `parseProxyStatusDeep`. No "Download page:" parser exists.
- `ui/ansi-strip.mjs` — default export `stripAnsi(text)` (CSI, OSC and other escapes; `\r\n` to `\n`). Already used by `ui/runner-bridge.js:4`. proxy-parse.js does not import it.
- `ui/renderer.js`:
  - `refreshConnectionsView()` (627-695): reads `bridge.connectors.checkStatus()`, `runCapture('codemie proxy status --json --deep')`, `bridge.connectors.appBundleExists(bundleName)`; computes status via `computeRowStatus`; line 651 `connectRowsEl.innerHTML = ''` then rebuilds each `.connection-row` (`.row-main` with `.row-title`, `.row-dot`, `.row-name`, `.row-subtitle` set from `ROW_STATUS_LABEL`; `.row-actions` buttons `.row-action`; disabled buttons get `title = note`). No per-row error or note element exists. No state survives a rebuild.
  - `runConnectionRowAction(row, action)` (701-713): `ensureAuthenticated(row.label)`, disables all `.row-action`, builds cmd: disconnect gives `codemie proxy disconnect <flag>`, otherwise `codemie proxy connect <flag>` plus ` --force` for reconnect. There is no `install` branch (an install action would fall into the connect command without `--install-client`). Calls `runAction(title, cmd, 'connections', undefined, { onClose: () => { refreshConnectionsView(); }, parseError: findProxyConnectError })`.
  - `runAction(title, cmd, returnView, hint, extra)` (474-514): refuses while `setupRunning` (shows notice and offers to stop setup, then re-calls itself). Opens terminal (`keepOpen: true`, `onClose`), registers a `engine:pty-data` listener when `parseError` is given that does `buf += atob(e.payload.data)`, awaits `bridge.pty.spawnPty(cmd)` giving `{code}`, calls `parseError(buf.split(/\r?\n/))`, writes the terminal line, returns nothing (exit code and error line are not exposed). `onClose` fires when the user closes the terminal, which is when the row refresh happens.
  - `runAnalytics()` (762-769): the existing precedent for probing `--help`: `runCapture('codemie analytics --help').catch(() => null)` then branch on `help?.stdout` (`ui/analytics-command.js`, regex `/--report\b/`).
- `ui/runner-bridge.js`: `runner.runCapture(cmd)` invokes Rust `run_capture`, which returns `CaptureResult { code, stdout, stderr }` (`src-tauri/src/commands/runner.rs:15`, `:99`), executed via the login shell (`/bin/zsh -lc`). Every call opens/closes a cmdlog record. `pty.spawnPty(cmd, cols, rows, onData)` returns `{ code, id }` and supports a per-run `onData(base64)` callback (an alternative to the global listener runAction uses).
- Opening a URL: no `openUrl`/`open_url`/`openExternal` helper exists in `ui/` or `src-tauri/src` (greps empty); `src-tauri/tauri.conf.json` and capabilities show no shell/opener plugin match. Rust has `open_log` and `open_cli_debug_log` (logger.rs) only. The only way to open a URL today is a shell command via `runCapture` (for example `open '<url>'`), as the task states.
- `ui/failure-panel.js` — `renderFailurePanel(container, {variant, title, explanation, detail, ...})`, the app-wide inline failure block (pure DOM). A candidate to reuse or not for the row error; the task only asks for the line plus a button.
- App bundle detection: `bridge.connectors.appBundleExists(bundleName)`, bundles `Claude`, `Visual Studio Code`, `ChatGPT`.

### Architecture and Layers Affected
- Frontend only (Vanilla JS ESM, no bundler): pure table layer (`connections-render.js`), pure parser layer (`proxy-parse.js`), view/controller layer (`renderer.js`: `refreshConnectionsView`, `runConnectionRowAction`, `runAction`), CSS (`ui/styles.css` around 498-543 for `#connect-rows`, `.row-action`), tests under `ui/test/`. The task states no new Rust; the architecture guide's "new Rust command" rules therefore do not apply.

### Integration Points
- CLI `codemie proxy connect <flag> --install-client` (EPMCDME-15626, codemie-code PR #613, unreleased; output contract per task text only, not verifiable in this repo).
- `codemie proxy connect --help` probe via `runCapture`.
- Terminal panel through `openTerminal` / `spawnPty`; `ensureAuthenticated`; `refreshConnectionsView` on terminal close.
- Opening the download URL through `bridge.runner.runCapture` and the login shell.

### Patterns and Conventions
- Pure modules take plain data, unit-tested with node:test; renderer.js is not imported by tests (it uses `document` and Tauri globals).
- Controllers (agents-controller.js, health-controller.js) take injected `runCapture`/`runStream` fakes so they can be tested; renderer.js wires the real bridge (`runCapture: (cmd) => bridge.runner.runCapture(cmd)` at renderer.js:571).
- Help-text probing pattern: analytics-command.js plus `runAnalytics`.
- Inline row text uses `.row-subtitle` / `title` attributes; there is no existing inline row error styling.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md` — frontend-brain plus thin Rust (Option B); system ops via `invoke()` in runner-bridge.js, no business logic in Rust.
- `.ai-run/guides/testing/testing-patterns.md` — JS tests are `ui/test/<module>.test.mjs`, node:test plus `assert/strict`; `proxy connect` and other network actions are never run automatically, verified by hand.
- `.ai-run/guides/development/development-practices.md` — naming (kebab-case JS files, camelCase functions); async/await.
- `.ai-run/guides/quality-gates.md` — `cd src-tauri && cargo fmt --check`, `cargo clippy -- -D warnings`, `npm test`, `cargo test`; build needs `scripts/stage-runtime.sh` first. For a JS-only change, `npm test` is the relevant gate; Rust gates are unaffected but are listed gates.
- `.ai-run/guides/standards/git-workflow.md` and `project.md` exist (not read in depth here).
- `docs/wireframes/04-connections.png` — reference only per the task.

### Architectural Decisions
- Option B (JS brain). Task-recorded decisions: terminal panel stands in for confirmation card and step list; no new Rust; older-CLI detection by `--help` probe.

### Derived Conventions
- Fakes injected as functions; DOM-free logic split into its own module so it is testable.

---

## 4. Testing Landscape

### Existing Coverage
- `ui/test/connections-render.test.mjs` — five tests; line 26 `'not-installed rows show a disabled Install and connect action'` asserts `disabled === true` and `note` matching `/coming soon/` (will fail once enabled and must be flipped).
- `ui/test/proxy-parse.test.mjs` — tests `findProxyConnectError` (✗ line, null, `Failed:` prefix) and `parseProxyStatusDeep`. Fixtures use plain text without ANSI.
- `ui/test/ansi-strip.test.mjs`, `connect-marker.test.mjs`, `connections-status.test.mjs`, `connectors-bridge.test.mjs`, `agents-controller.test.mjs`, `health-controller.test.mjs`, `analytics-command.test.mjs` (the nearest precedent for help-text probing), `failure-panel.test.mjs`, `pty-bridge.test.mjs` — adjacent.
- Runner: `npm test` = `node --test ui/test/*.test.mjs`.

### Testing Framework and Patterns
- node:test plus `node:assert/strict`, no dependencies; injected fake `runCapture`/`runStream` for controllers; `ui/test/fixtures` and `ui/test/tools` directories exist; there is a Playwright suite under a task dir (`npm run test:ui`) that is not part of `npm test`.

### Coverage Gaps
- `renderer.js` (`runConnectionRowAction`, `runAction`, `refreshConnectionsView`) has no unit tests and cannot be imported under node. Any new logic placed in it is untested unless extracted into a pure/controller module.
- No test for ANSI-prefixed ✗ lines, "Download page:" extraction, https URL validation, or shell quoting.
- Nothing tests the row error surviving `refreshConnectionsView` (no persistent row state exists).

---

## 5. Configuration and Environment

### Environment Variables
- None used by this feature area. PTY runs with `TERM=xterm-256color` (per task). Smoke env vars `CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE` are unrelated.

### Configuration Files
- `.codemie/codemie-cli.config.json` — modified in the working tree before work started (git status `M`); the task forbids committing it.
- No config/ or flag entries for connections found.

### Feature Flags and Deployment Concerns
- No feature flags. Checked branch: `feat/EPMCDME-14575-client-app-install`, HEAD at `0cd1d76` (merge of EPMCDME-14512 into codemie-desktop-stage-2). Task dir `docs/superpowers/tasks/2026-10-06-epmcdme-14575-client-app-install` exists.

---

## 6. Risk Indicators

- Byte decoding in `runAction`: the pty-data listener does `buf += atob(payload.data)`. `atob` returns a Latin-1 binary string, not UTF-8, so the 3-byte `✗` (E2 9C 97) arrives as three Latin-1 characters, not `✗`. runner-bridge.js decodes the same payload with `TextDecoder('utf-8')` for the cmdlog, which suggests the existing match on `✗` in `runAction` could already be failing for real output (the existing tests use hand-written strings, so they would not show it). A fix needs UTF-8 decoding before ANSI stripping and matching. Worth verifying against a fake CLI that prints `✗`. Also, chunk boundaries can split a multi-byte character, so a streaming decoder is needed.
- Speculative: the `findProxyConnectError` change needs ANSI strip before the regex. Stripping a whole buffer is safer than per-line since an escape can span a chunk boundary; `stripAnsi` converts `\x1b[nB` to newlines, so a split afterwards may differ from the raw split.
- Speculative: `runAction` returns nothing, so the row cannot receive exit code or error line without changing its return value or an `onResult`-style callback; `runAction` is shared by analytics and other callers.
- Speculative: the row error has to live outside the DOM that `refreshConnectionsView` clears (module-level map keyed by app) and be cleared on the next attempt or success; there is no existing row error element or CSS.
- Exit code and `parseError` interplay: the CLI "no" exits 0 with "Install cancelled" and no ✗, so no error shows; failure paths must not match the benign lines. `findProxyConnectError` also matches `error:` and `failed:` lines, which could pick up non-install lines.
- Download page URL is untrusted CLI output run through `zsh -lc` in `runCapture`: https parse plus single-quote escaping is required, and no existing helper exists to reuse (no shell quote helper found). Note `run_capture` goes through the login shell and `open` is the only way, since no opener plugin is present.
- Older-CLI probe: `runCapture('codemie proxy connect --help')` result shape is `{code, stdout, stderr}`; help output may go to stderr, and the probe may fail when codemie is missing (precedent uses `.catch(() => null)`). A wrong default when the probe fails decides whether anything runs.
- `runAction` blocks while guided setup holds the PTY (`setupRunning`), and `runConnectionRowAction` disables all buttons before `runAction` may return early with a notice; buttons stay disabled until a refresh (existing behavior).
- Actual CLI output contract is unverifiable here (PR #613 unreleased, no local `../codemie-code` read performed); "never run real codemie in tests" means verification depends on fakes.
- The dirty `.codemie/codemie-cli.config.json` is a commit hazard (must be excluded from staging).

---

## 7. Summary for Complexity Assessment

The change is frontend-only across three small layers: the pure action table (`ui/connections-render.js`, one entry), the pure parser (`ui/proxy-parse.js`, ANSI strip plus a "Download page:" extractor), and the view code in `ui/renderer.js` (`runConnectionRowAction` gains an install branch with a `--help` probe, `runAction` must surface its result, and `refreshConnectionsView` must render a row error or note that survives its `innerHTML = ''` rebuild). CSS in `ui/styles.css` plus tests in two existing test files and likely one new module are the remainder. No Rust, no config, no migrations. The file surface is roughly 4 source files and 2 to 3 test files.

Technical novelty is low: precedents exist for help-text probing (`runAnalytics`), injected-fake controllers, and the strip utility. The one non-obvious spot is the PTY data decoding in `runAction` (`atob` without UTF-8 decoding), which may mean the existing ✗ matching does not work on real output, and URL opening, for which no helper exists today and must go through `runCapture` with careful quoting.

Test posture: parser and table logic are well covered by pure tests and easy to extend, but renderer.js has no tests, so anything that matters (error persistence, result plumbing, URL quoting, older-CLI gate) is only verifiable if extracted into a testable module or driven manually with a fake codemie script. Main risks are the UTF-8 decode issue, row state surviving rebuilds, shell injection through the URL, and an unverifiable CLI output contract.

---

## 8. External References

None named by the task as a path to read outside the repo. In-repo references named were read: `ui/renderer.js`, `ui/connections-render.js`, `ui/proxy-parse.js`, `ui/test/connections-render.test.mjs`, `ui/test/proxy-parse.test.mjs`, the architecture, testing and development guides. Not read: `docs/wireframes/04-connections.png` (reference only), codemie-code PR #613 and EPMCDME-15626 (CLI side, unreleased; its output contract is taken from the task text only).
