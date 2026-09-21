DONE

## Commit

SHA: `3b109df7fa440f57368212228eda289b2bd980dc`
Subject: `feat: setup-view transient spinner, installClaude via onLog, success/failure mapping`

Same commit as Tasks 5 and 7 — see the "How this task was run" note in `task-5-report.md`.

## What was done

1. Added the `installClaude` watch to `ui/setup-view.js`: `beginInstallWatch(rowId)`, `onLog(text)`, `finishInstall(status, subtitle)` and `settleInstallRow()`, plus the two anchors at module scope:

   ```js
   const INSTALL_OK = /Claude Code(?:\s+(v\S+))?\s+installed successfully/;
   const INSTALL_FAILED = /Failed to install Claude Code/;
   const INSTALL_LOG_KEEP = 4000;
   ```

   Both anchors are the CLI's own lines (`assets/codemie-cli/.../cli/commands/setup.js:728,737`). The version is capture group 1, so the plan's outer group became non-capturing.
2. Answering the confirm **no** collapses the row immediately to "Claude Code — Skipped"; no `onLog` involvement.
3. Answering **yes** leaves the row ACTIVE with its own spinner and subtitle "Installing…". It is the only row that ever reads `onLog`.
4. `onLog` appends to a per-row buffer, keeps the last `INSTALL_LOG_KEEP` characters and matches against the **accumulated** buffer, so a line split across chunks or wrapped in colour codes still matches. Success sets COMPLETE with the captured version as subtitle, or "Installed" when the CLI printed none; the failure line sets ERROR — the driver's promise resolves normally in that case, which is exactly why this row cannot be driven by the resolution.
5. Safety net: `settleInstallRow()` runs on both settle paths and forces ERROR ("Not confirmed") if the run finished while the row was still waiting for a line that never came, so the row never keeps spinning.
6. Log lines that arrive before the yes answer are ignored (`install` is null until then).

## Test commands + output

Seven dedicated tests, all mutation-checked:

- `confirm prompt: Yes is pre-selected, resolves true, and the row waits on the CLI install instead of completing`
- `confirm prompt: choosing No resolves false and collapses to "Claude Code — Skipped"`
- `installClaude: success line without a version collapses to "Claude Code — Installed"`
- `installClaude: the CLI's failure line marks the row ERROR even though the run resolves normally`
- `installClaude: safety net marks the row ERROR when the run settles with no install line seen`
- `installClaude: safety net also fires on rejection`
- `installClaude: log lines before the yes answer are ignored`

```
$ node --test ui/test/setup-view.test.mjs      # at 3b109df
ℹ tests 47
ℹ pass 47
ℹ fail 0
```

## Concerns

The row's behaviour rests on two literal CLI strings. They were read from the vendored CLI rather than assumed, but a reworded line in a future CLI release would leave the row on the safety net's ERROR instead of a success. Not yet walked on a machine without Claude Code (tracked as an open item on the MR).
