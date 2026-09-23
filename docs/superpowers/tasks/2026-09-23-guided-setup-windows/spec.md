# Spec: Guided setup on Windows (EPMCDME-14982)

## Problem

Home's checklist item "Choose how CodeMie reaches a model" opens a graphical
guided-setup screen that drives `codemie setup` step-by-step via a headless
PTY + xterm.js reader. It already works on macOS. It must work correctly on
Windows too, with no change to macOS behavior.

The driver's timing-sensitive dedup/idle-timer logic
(`ui/setup-driver.js`, 969 lines) is validated only against macOS-recorded
byte sequences, and its own inline comments cite dated real PTY captures as
the evidence for every nontrivial branch. No Windows capture exists yet, so
the exact production fix (if any) cannot be specified now — this is a
recording-gated process, not a known code change.

## Approach

Four ordered phases. Only phase 2's contents are conditional on what phase 1
proves.

1. **Record.** Temporarily instrument `ui/setup-driver.js`'s
   `processChunk`/`handleDetectedPrompt` (or via the existing `onLog` hook)
   to dump raw chunk bytes, decoded screen lines, and detected-prompt output.
   Drive one real `codemie setup` run through the app on a real Windows
   machine, covering: initial gate → storage → provider → url → project →
   model list (with pagination) → custom model → profile name (submit an
   answer the CLI rejects, then correct it) → the "Switch to profile … as
   active?" confirm. Save the raw frame sequences as new fixture JSON
   (`ui/test/fixtures/setup/windows-*.json`), same 30-line-array shape as the
   existing macOS fixtures used by `ui/test/setup-driver.test.mjs`'s
   `replay`/`typedOut` helpers.

2. **Diagnose, fix only if proven.** Compare the capture against the
   macOS-derived assumptions in `ui/setup-driver.js`: chunk/echo/repaint
   ordering, ctrl-U line-clear, arrow-key list nav, `AUTO_LIST`/`AUTO_CONFIRM`
   regex matches, `VALIDATION_ERROR_MARKER=/^>>/` positioning, CRLF-vs-LF.
   Fix `ui/setup-driver.js` only where the recording proves a divergence.
   Touch `ui/setup-parse.js` or `ui/setup-view.js` only if the recording
   proves the parser or view — not the driver — is wrong. Prefer a fix that
   holds for both platforms over an `isWin` fork; no such branching exists
   in these three files today, and forking risks a macOS regression in the
   dense dedup/idle-timer state that today's tests don't re-exercise for a
   second platform. Add an `isWin` fork only if the recording proves the two
   PTYs genuinely need different logic.

3. **Test.** Add Windows real-stream tests to `ui/test/setup-driver.test.mjs`,
   mirroring the *shape* — not the literal count — of the four existing
   tests literally titled `'real stream: ...'`, using the same
   `replay`/`typedOut`/`ans` fakes and `makeFakePty`/`makeFakeTerminal` DI
   seam. Minimum coverage: the re-ask-once correction, and the
   activate-confirm scenario ending with the new profile active. Existing
   macOS tests and fixtures are untouched — they are the regression gate
   proving any shared-logic fix from phase 2 didn't break the macOS path.

4. **Clean up and verify.** Strip all temporary debug logging added in
   phase 1 before commit — none of it ships. Run all four gates: `npm test`
   (repo root), `cargo fmt --check`, `cargo clippy -- -D warnings`,
   `cargo test` (from `src-tauri/`). Do a full manual walkthrough on the real
   Windows machine confirming `%USERPROFILE%\.codemie\codemie-cli.config.json`
   shows the created profile active — this is DoD/manual verification, not
   an automated test.

## Acceptance criteria

- Same decisions, same order, as macOS.
- A rejected answer is re-asked once and the correction is accepted.
- The "Switch to profile … as active?" confirm is answered and the new
  profile ends up active in the config file.
- No question is ever shown that the CLI isn't actually waiting on.
- Windows recordings are added as tests in the shape of the existing
  `'real stream: ...'` tests in `ui/test/setup-driver.test.mjs` (exact count
  not required to match the ticket's "six").
- macOS behavior and its recorded test frames are untouched; existing suite
  stays green.
- Walked end-to-end on a real Windows machine against the real CLI.
- All four gates (`npm test`; `cargo fmt --check`; `cargo clippy -- -D
  warnings`; `cargo test`) pass after rebuild.

## Non-goals

- `ui/handlers.js` and `config/steps-windows.yaml` — unrelated legacy Wizard
  flow (confirmed out of scope via sibling tickets EPMCDME-14513/14589).
- Any `src-tauri` change — `spawn_pty` already branches on `cfg!(windows)`
  in `src-tauri/src/commands/pty.rs`.
- A new Rust test for the Windows `spawn_pty` branch.
- Changing macOS fixtures, macOS-titled tests, or macOS driver behavior.
- Matching the literal "six" real-stream-test count from the ticket text.
- Adding `isWin` branching to `ui/setup-driver.js`/`ui/setup-parse.js`/
  `ui/setup-view.js` preemptively, before a recording proves it's needed.
- Any change outside `ui/setup-driver.js` (conditionally), `ui/setup-parse.js`
  and `ui/setup-view.js` (conditionally, only if proven), new fixture files
  under `ui/test/fixtures/setup/`, and `ui/test/setup-driver.test.mjs`.
- A second MR — this ticket ships as one MR.

## Open risk

Whether `AUTO_LIST`/`AUTO_CONFIRM` regex matching or the idle/dedup timing
behaves differently under `powershell.exe` is unknown until the recording
happens. "No production fix needed" is a valid, in-scope outcome — in that
case phase 3's tests assert the existing macOS-derived logic already holds
on Windows.
