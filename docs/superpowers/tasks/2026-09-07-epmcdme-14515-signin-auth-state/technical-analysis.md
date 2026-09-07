# Technical Research

**Task**: auth profile-status sign-in inspector runner-bridge ensureAuthenticated identity-bar
**Generated**: 2026-09-07T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-14515 — CodeMie Desktop: Sign-in and auth state.

Build SSO sign-in via the system browser, and fix the auth-state parser. Today
`parse_profile_status` (src-tauri/src/commands/inspector.rs) returns a boolean and
misreports valid profiles that print no "Auth Status" row. It must be extended to
return a four-state shape: { state: 'signed_in' | 'not_signed_in' | 'unknown' |
'no_profile', detail: string }.

Five outcomes from `codemie profile status` to distinguish:
1. Auth Status row says authenticated -> signed_in, detail = that row
2. Auth Status row says expired -> not_signed_in, detail = that row
3. Profile rows present, no Auth Status row at all -> unknown, detail = "" (never not_signed_in)
4. A "✗ …" reason line then "⚠️  Authentication required to use this profile", no profile rows -> not_signed_in, detail = the "✗ …" reason line
5. "No active profile found. Run \"codemie setup\" to create one." -> no_profile, detail = that message

Two existing callers read the old `{ authenticated: bool, detail }` shape via
`st.authenticated` and must both be updated: `ensureAuthenticated` in ui/renderer.js
(currently ~line 312, bare `invoke('check_profile_status')` at ~line 315) and the
identity-bar caller (bare `invoke('check_profile_status')` at ~line 473). Both need
to route through `ui/runner-bridge.js`'s `inspector` export instead of a bare invoke
(currently that export, at ~lines 34-43, has no `checkProfileStatus` entry).

New sign-in flow needed: run `codemie profile login [--url <url>]` through the existing
`run_stream` Tauri command (drives streaming stdout, used elsewhere in this codebase),
capture its stdout, and read the `✗ …` / `Error: …` line to report a specific failure
via `showNotice`/`hideNotice` (ui/renderer.js, ~lines 210/225) — never trust the exit
code (`profile login` exits 0 on failure). Re-read profile status after login.

---

## 2. Codebase Findings

### Existing Implementations

- `src-tauri/src/commands/inspector.rs:100–103` — `ProfileStatus` struct: current shape is `{ authenticated: bool, detail: String }` serialized to IPC JSON
- `src-tauri/src/commands/inspector.rs:109–127` — `parse_profile_status(stdout, stderr) -> (bool, String)`: private pure function; boolean logic looks for "authenticated" without "not authenticated"/"expired"; completely replaced by the new 4-state version
- `src-tauri/src/commands/inspector.rs:134–145` — `check_profile_status()`: public `#[tauri::command]`; runs `codemie profile status < /dev/null` (macOS), constructs `ProfileStatus` from the parser result
- `src-tauri/src/lib.rs:83` — `commands::inspector::check_profile_status` registered in `invoke_handler!` block; no change needed here
- `ui/runner-bridge.js:34–43` — `inspector` export; contains `checkGit`, `checkNode`, `checkNpm`, `checkCodemie`, `checkCodemieVersion`, `checkHandshakeState`, `gitBinaryPath`, `nodeBinaryPath`; **`checkProfileStatus` is absent**
- `ui/runner-bridge.js:17–30` — `runner.runStream(cmd, onLine)`: wraps `run_stream` Tauri command, streams `engine:cmd-line` events, returns `{ code }` — the established mechanism for streaming CLI output
- `src-tauri/src/commands/runner.rs:84–120` — `run_stream`: spawns command, pumps stdout/stderr lines as `engine:cmd-line` events, returns exit code as `i32`
- `ui/renderer.js:312–330` — `ensureAuthenticated()`: calls bare `invoke('check_profile_status')` at line 315, reads `st.authenticated`, shows blocking notice on false
- `ui/renderer.js:473–477` — identity-bar caller: bare `invoke('check_profile_status')`, reads `st.authenticated` to set `identity-auth-status` text content
- `ui/renderer.js:210–227` — `showNotice({ title, message, primaryLabel, primaryAction })` and `hideNotice()`: modal overlay controls used for error reporting
- `ui/renderer.js:12` — `import * as bridge from './runner-bridge.js'` — bridge already imported; both callers can reach `bridge.inspector` once `checkProfileStatus` is added there

### Architecture and Layers Affected

- **Rust command layer** (`src-tauri/src/commands/inspector.rs`): `ProfileStatus` struct and `parse_profile_status` private function — the shape change is the highest-impact Rust edit; `check_profile_status` Tauri command also updated to construct the new struct
- **IPC bridge layer** (`ui/runner-bridge.js`): `inspector` export gains one entry; `runner.runStream` already present and available for the login flow
- **UI/renderer layer** (`ui/renderer.js`): two `invoke` call sites migrated to `bridge.inspector.checkProfileStatus()`; new sign-in handler added; `showNotice`/`hideNotice` used for login failure reporting

### Integration Points

- `check_profile_status` Tauri command → IPC → `bridge.inspector.checkProfileStatus()` (once added) → two call sites in `renderer.js`
- `run_stream` Tauri command → `runner.runStream()` in `runner-bridge.js` → new sign-in handler in `renderer.js`; exit code ignored per spec; stdout scanned for `✗ …` / `Error: …` lines
- `showNotice`/`hideNotice` in `renderer.js` — used by the sign-in flow to surface failure messages; same API used by `ensureAuthenticated` and `runAnalytics`

### Patterns and Conventions

- All Rust commands annotated `#[tauri::command]`, registered in `lib.rs` `invoke_handler!`, wrapped in `runner-bridge.js`; renderer.js uses `bridge.*` rather than bare `invoke` — both `check_profile_status` callers currently violate this convention and are in scope for correction
- Infallible Rust commands return `T` directly; fallible ones return `CmdResult<T>` — `check_profile_status` is infallible, returns `ProfileStatus` directly
- New struct fields are `pub` and annotated with `#[derive(Serialize, Default, Clone)]`
- `Default` impl on `ProfileStatus` will need to be reconsidered: `state` field changes from `bool` to `String`; a manual `Default` returning `state: "unknown"` may be more appropriate than the derived one

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — defines the Option B frontend-brain pattern; explicitly lists `check_profile_status` under `commands/inspector.rs`; section "Adding New System Commands" prescribes the five-step pattern (add function, annotate, register in lib.rs, add JS wrapper in runner-bridge.js, add unit test)
- `.ai-run/guides/testing/testing-patterns.md` — specifies inline `#[cfg(test)]` for Rust, `node:test` + `node:assert/strict` for JS; Rust tests run against real shell (no mocks); parser functions are pure and therefore tested with literal strings

### Architectural Decisions

- Architecture guide explicitly calls out: "Add a JS wrapper in runner-bridge.js" as required for every command. The two bare `invoke('check_profile_status')` calls in renderer.js are a pre-existing deviation from this rule; this ticket corrects them.
- Exit code from `run_stream` returns an `i32` to JS; the task explicitly states the exit code must not be trusted for `profile login` — the stream output scan pattern is consistent with how errors are already surfaced in `_handleFatal` and step-level error detection elsewhere.

### Derived Conventions

- `ProfileStatus.detail` captures the most relevant display line from CLI output; the new `state` discriminant replaces the boolean with a string union — consistent with how `codemieConfig.state` (`'no-configuration' | 'valid' | 'broken'`) already uses a string discriminant in `codemie_config.rs` / `runner-bridge.js:46–52`
- `runner.runStream` callback `onLine(text, tag)` receives all lines with their `stdout`/`stderr` tag; failure line scanning scans `text` for prefix patterns

---

## 4. Testing Landscape

### Existing Coverage

- `src-tauri/src/commands/inspector.rs:233–260` (inline `#[cfg(test)]` module) — 5 tests for `parse_profile_status`:
  1. `profile_status_authenticated_is_true_and_keeps_detail` — Auth Status row, authenticated
  2. `profile_status_expired_is_not_authenticated` — Expired row
  3. `profile_status_not_authenticated_is_false` — Not authenticated row
  4. `profile_status_expires_in_future_not_mistaken_for_expired` — "expires in" vs "expired" disambiguation
  5. `profile_status_empty_output_is_false` — empty stdout/stderr
- `ui/test/engine.test.mjs` — Engine orchestration; not related to auth
- `ui/test/models.test.mjs` — StepStatus/makeStep; not related to auth

### Testing Framework and Patterns

- Rust: `#[cfg(test)]` inline, `#[test]` for sync, `#[tokio::test]` for async; tests use literal CLI output strings; pure parser functions like `parse_profile_status` are ideal for this pattern
- JS: `node:test` + `node:assert/strict`; no coverage of `renderer.js` functions (`ensureAuthenticated`, identity-bar caller, `showNotice`/`hideNotice`) — these are untested

### Coverage Gaps

- All 5 new `parse_profile_status` outcomes (outcomes 3, 4, 5 are entirely unrepresented; outcomes 1 and 2 tests will need updating when the return type changes from `(bool, String)` to a struct/enum)
- `ensureAuthenticated` and the identity-bar caller have no JS tests — the task spec requires updating them but no test infra exists for renderer.js functions
- New sign-in handler (to be added) will also be untested at the JS level unless a test file for renderer functions is introduced

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` — smoke test modes; do not affect auth commands directly
- No auth-specific env vars found in the codebase

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — read by `read_codemie_config` (separate from profile status); the `identity-bar` reads both this config and `check_profile_status`
- `src-tauri/tauri.conf.json` / `tauri.macos.conf.json` — Tauri app config; no auth-specific entries
- `config/steps.yaml` (embedded via `include_str!`) — install step definitions; not relevant to auth

### Feature Flags and Deployment Concerns

- No feature flags govern the auth flow
- `check_profile_status` uses `< /dev/null` redirect on macOS to prevent the CLI's interactive re-auth prompt from hanging; the same care applies to `profile login` — the task routes it through `run_stream` which spawns the child process with piped stdout/stderr, so there is no interactive stdin issue in that path

---

## 6. Risk Indicators

- **IPC shape break**: Changing `ProfileStatus.authenticated: bool` to `state: String` is a breaking IPC change. Both JS callers read `st.authenticated`; until both are updated atomically with the Rust change, the UI will silently fail (JavaScript property access on an absent key returns `undefined`, which is falsy — `ensureAuthenticated` would treat every call as unauthenticated and block). The three files (inspector.rs, runner-bridge.js, renderer.js) must change together.
- **`Default` derive on new `ProfileStatus`**: The derived `Default` for a `String` field produces an empty string `""`, which does not match any of the four valid `state` values. The catch-branch in `ensureAuthenticated` constructs `{ authenticated: false, detail: '' }` inline today; after the change, the Rust `Default` is only used in Rust (not exposed to JS directly), but any Rust code calling `ProfileStatus::default()` implicitly will get an empty `state`. Worth auditing.
- **Exit code ignored for `profile login`**: `run_stream` returns the exit code as `i32` to JS; the JS sign-in handler must not branch on it. This is an unusual pattern — all other `runStream` usages elsewhere in the codebase are not confirmed to ignore the code. The handler must explicitly discard the returned `{ code }`.
- **Five existing tests become invalid**: `parse_profile_status` currently returns `(bool, String)`. After the change it returns a struct or tuple with a `state: &str` discriminant. All five existing test assertions (`assert!(ok)`, `assert!(!..., false)`) break at compile time and must be rewritten.
- **`identity-auth-status` DOM element**: The identity-bar caller at renderer.js:474 sets `identity-auth-status` text content. The element's existence in `index.html` was not confirmed in this research. If it was added as part of a wireframe-tracked deliverable, it may not yet exist in the DOM.
- **`checkProfileStatus` missing from `inspector` bridge**: Both renderer.js callers currently bypass `runner-bridge.js` entirely with bare `invoke`. The architecture guide explicitly prohibits this. Adding `checkProfileStatus` to the bridge and migrating both callers corrects the violation, but the two-step migration must not leave one caller on bare invoke while the other uses the bridge — that would produce divergent behavior if the bridge wrapper is ever augmented.
- **No JS test coverage for renderer.js auth functions**: `ensureAuthenticated`, the identity-bar update, and the sign-in handler are all untested. Regression risk for the caller logic is unmitigated by automated tests.

---

## 7. Summary for Complexity Assessment

The task touches three architectural layers: the Rust command layer (`inspector.rs` — struct and pure parser), the IPC bridge layer (`runner-bridge.js` — one new export entry), and the UI/renderer layer (`renderer.js` — two migrated callers, one new sign-in handler). The Rust change is a breaking IPC shape change: `ProfileStatus.authenticated: bool` becomes `state: String` with a four-value discriminant. All three files must be updated atomically. The core parser logic (`parse_profile_status`) is a pure function with well-isolated tests, making the Rust work tractable; the five existing tests all become compile errors when the return type changes and must be replaced with seven or more new test cases covering all five CLI output outcomes plus the empty-output fallback. The `run_stream` / `runner.runStream` path is already established and working for the sign-in flow; no new Rust command is needed for login.

The JS side carries the higher risk. Neither renderer.js caller has any automated test coverage, and the pattern violation (bare `invoke` instead of `bridge.inspector.*`) must be corrected as part of this ticket. The sign-in handler adds new async state in the renderer: it must collect streamed lines, scan for failure patterns, and re-call `checkProfileStatus` after completion — all without relying on the exit code, which is an unusual constraint not present in other `runStream` usages. The identity-bar `identity-auth-status` DOM element was observed as a property-set target in renderer.js but its presence in `index.html` was not confirmed by this research.

Overall the task is moderate in scope: four files changed (inspector.rs, lib.rs is read-only, runner-bridge.js, renderer.js), five existing Rust tests replaced, new tests written for all five CLI output outcomes, and one new UI interaction path (sign-in with browser + streaming feedback) introduced with no existing test infra. The atomic IPC shape change and the no-exit-code constraint on the login flow are the two points requiring the most care during implementation.

---

## 8. External References

None named by the task.
