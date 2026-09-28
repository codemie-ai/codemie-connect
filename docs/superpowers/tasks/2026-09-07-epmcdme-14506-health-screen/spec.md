# Spec: Health Screen (EPMCDME-14506)

## Problem

`codemie doctor` output is unparsed and only reduced to an exit code
(`ui/handlers.js:89-96`). Users get no plain-language, groupable, actionable
view of their setup's health, and the debug log (`src-tauri/src/commands/logger.rs`)
can only be opened on macOS. This spec covers a standalone Health screen that
parses `doctor`'s text output into three grouped, remedied results, plus a
working cross-platform "open my log" action.

## Decisions (settled, not open for this round)

1. Parsing/grouping/remedy logic lives in JS (frontend-brain, per
   `.ai-run/guides/architecture/architecture.md`). Rust keeps running
   `codemie doctor` via the existing `run_stream` path unchanged; JS
   accumulates streamed lines into one string once the process exits, then
   parses it. No new Rust command for the invocation itself.
2. Wizard step `2.4` (`ui/handlers.js:89-96`) is untouched. The Health
   screen's `doctor` run is a new, independent invocation path.
3. The screen auto-runs the full check set on first navigation (loading
   state), then again only via "Check everything again" or a per-row
   "Check again".
4. `doctor` cannot re-run a single check, so per-row "Check again" triggers
   the same full re-run as "Check everything again" — an entry point, not a
   narrower operation. All rows and the summary refresh together.
5. The AC's "13 of 14 fine" is illustrative. The summary always reads
   `"<passing> of <total> fine"` computed from whatever ran, including the
   dynamic Provider check when present. No hardcoded total.
6. Node/Npm/Python/uv collapse into one line under **CodeMie itself** (the
   AC's own phrasing, "everything CodeMie needs to run is included," frames
   it as CodeMie's bundle, not the user's).
7. Remaining checks map by principle: identity/credentials/profile →
   **your account** (`AIConfigCheck`/Active Profile, `JWTAuthCheck`);
   something the user personally installed beyond CodeMie's bundle →
   **your tools** (`AwsCliCheck`, `AgentsCheck`); CodeMie's own bundled
   capability, connectivity, or built-in feature → **CodeMie itself**
   (collapsed runtime line, `WorkflowsCheck`, `FrameworksCheck`, dynamic
   Provider check). Confirm each mapping against the vendored check's actual
   message text while building — this is a starting point, not a table to
   defend line-by-line.
8. Remedy = the doctor-provided hint text (verbatim or lightly rephrased).
   Deep-link button when the hint names an existing screen (confirmed:
   `AgentsCheck` failure → "Go to Agents", `ui/renderer.js:73`); otherwise a
   "Check again" button; no button when there's no actionable next step.
9. The existing global footer "Open Log" button
   (`ui/index.html:163-166`, `#open-log`) is untouched. The Health screen
   adds its own separate "Open today's log" action calling the same
   underlying capability — both entry points coexist.
10. Windows log directory follows this repo's existing app-data convention
    (`pathman.rs:40-41`, `%USERPROFILE%\AppData\Local\CodeMie\...`), not a
    literal `HOME` path — a `Logs` subfolder under that root, mirroring
    macOS's `~/Library/Logs/CodeMie/` idiomatically.
11. `open_log` checks the file exists and is readable before opening
    (`codemie_config.rs:93-116`'s "never fails, becomes a state" pattern)
    and returns a typed not-found/unreadable result the UI renders as "can't
    read your log" — never a silent no-op, never an empty result.
12. The parser ships with fixture-based tests from the start (mirroring
    `ui/test/setup-parse.test.mjs` + fixtures), covering: all-passing,
    forced provider-connectivity failure, and Provider-check-absent. No such
    fixtures exist yet; they must be captured fresh.

## Design

**Backend (`src-tauri/src/commands/logger.rs`)**: add
`#[cfg(windows)]`/`#[cfg(not(windows))]` pairs for `log_dir()` (decision 10)
and for the file-open mechanism (decision 9's macOS `open`, a Windows
default-handler equivalent). `open_log` gains an existence/readability check
(decision 11) ahead of the platform-specific spawn, returning a `CmdResult`
whose error variant the frontend maps to the "can't read your log" message.
Register any changed signature in `lib.rs`'s `invoke_handler!` if needed (no
new command name expected).

**Frontend parser (new `ui/doctor-parse.js`, modeled on `ui/setup-parse.js`)**:
a pure function taking `doctor`'s accumulated stdout string and returning an
array of `{ name, status, message, hint }` records, keyed off the formatter's
fixed grammar (bold `"Name:"` header; `"  <icon> <message>"` detail lines;
optional `"      <hint>"` line; blank line between checks) as described in
the technical analysis. Item-wise checks (`AgentsCheck`) parse to the same
shape. This is the module decision 12's fixtures exercise directly.

**Frontend grouping/remedy module**: consumes the parsed records, applies
decision 6/7's grouping, collapses the runtime checks into one line, and
attaches a remedy shape per decision 8:

```
{ group: 'account'|'tools'|'codemie', label, status: 'pass'|'fail',
  remedyText?, action?: { kind: 'recheck' } | { kind: 'navigate', view: string, label } }
```

**Frontend view (`#health-view`, new render module analogous to
`ui/steps-ui.js`)**: renders three headed groups, a summary line
(`"<passing> of <total> fine"`), a "Check everything again" control, and an
"Open today's log" action wired to the same `open_log` invoke used by the
footer button — surfacing its error result as an inline "can't read your
log" message rather than swallowing it (unlike today's `ui/log.js:11-17`).
Auto-runs on first navigation into the view (decision 3); wires into
`ui/renderer.js`'s existing `views`/`showView` plumbing.

## Testing

- Rust: extend `logger.rs`'s existing `#[cfg(test)]` block with Windows-path
  and existence-check unit tests (pattern: `inspector.rs:199-302`).
- JS: new `ui/test/doctor-parse.test.mjs` + `ui/test/fixtures/doctor/*.txt`
  fixtures for the three cases in decision 12, following
  `ui/test/setup-parse.test.mjs`'s shape. Grouping/remedy-mapping module
  gets its own unit tests independent of the parser.
- Manual (from the ticket's Definition of Done): full pass, forced
  provider-connectivity failure, open-log on macOS and Windows, and
  open-log against a missing/renamed log file.

## Non-goals

- Modifying wizard step `2.4` or its exit-code-only behavior.
- A machine-readable/JSON output mode for `codemie doctor` — none exists
  (confirmed by reading the vendored source); this task parses text only.
- Guaranteeing parser stability across future `@codemieai/code` version
  bumps — the fixture tests catch drift, they don't prevent it (accepted
  standing risk).
- Consolidating, removing, or relabeling the existing footer "Open Log"
  button.
- The command/"what CodeMie ran" log — sub-task S9, a different log.
- An exhaustive, line-by-line defended table of every check's group
  assignment beyond the stated principle (decision 7).
- Building a reusable generic "remedy action button" component beyond what
  this screen needs; `showNotice`'s modal pattern is not reused as-is.

## Open risks

- Vendored `@codemieai/code`'s exact wording/icons can change on a version
  bump with no compile-time signal; mitigated, not eliminated, by fixture
  tests (decision 12, Non-goals).
- Piped/non-TTY output is expected to be ANSI-free (chalk's TTY detection),
  but this is inferred, not yet verified against a real captured sample —
  verify early during implementation before finalizing the parser grammar.
- Per-check group assignment (decision 7) is a starting principle; a few
  checks' exact wording may argue for a different group once read directly
  from `doctor/*Check.js` during implementation.
