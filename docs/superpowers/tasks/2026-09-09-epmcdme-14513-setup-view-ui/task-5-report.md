DONE

## Commit

SHA: `3b109df7fa440f57368212228eda289b2bd980dc`
Subject: `feat: setup-view transient spinner, installClaude via onLog, success/failure mapping`

```
$ git show --stat 3b109df
 ui/setup-view.js            | 267 +++++++++++++++++++----
 ui/styles.css               |   1 +
 ui/test/setup-view.test.mjs | 500 ++++++++++++++++++++++++++++++++++++++++----
 3 files changed, 680 insertions(+), 88 deletions(-)
```

**How this task was run.** The factory run stopped at its budget after Task 4, so Tasks 5, 6 and 7 were implemented by hand in a separate session and landed in this one commit (they share the spinner/settle ordering the plan makes explicit, and splitting them would have left the tree red in between). This report was written from the commit and the plan afterwards; there was no per-task implementer run behind it. See the status note at the end of `plan.md`. Tasks 6 and 7 report the same SHA.

## What was done

1. Added `showTransientSpinner()` / `hideTransientSpinner()` to `ui/setup-view.js`. The spinner is a real `steps-ui` row (`working-<n>`, title "Working…", ACTIVE + spinner), inserted at most one at a time, removed from the DOM on hide.
2. Insert points: right after `start()` invokes `deps.startSetup(...)`, so the screen never sits on the collapsed `storage` row with nothing moving; and after each answered row, unless that row was `installClaude` answered yes (that row carries its own spinner, Task 6).
3. `onPrompt` hides it first thing, so a prompt arriving always replaces it.
4. Settle ordering, exactly as the plan requires: on resolution `handleResolve` hides it unconditionally; on rejection `handleReject` (Task 7) runs first and only hides it afterwards when it did not convert that same row into the ERROR marker (`converted` flag).
5. `ui/styles.css` picked up one line for the transient row.

## Test commands + output

Two dedicated tests, both mutation-checked:

- `transient spinner: shown right after start, hidden by the first prompt, shown again after an answer, gone on resolve`
- `transient spinner: not inserted after installClaude yes, inserted after installClaude no`

The `step: null` between-prompts case is asserted from the other side by Task 7's test (exactly one ERROR row on screen, no orphan spinner).

```
$ node --test ui/test/setup-view.test.mjs      # at 3b109df
ℹ tests 47
ℹ pass 47
ℹ fail 0

$ node --test ui/test/*.test.mjs               # at 3b109df
ℹ tests 174
ℹ pass 174
ℹ fail 0
```

## Concerns

The spinner keeps a `setInterval` alive, so a test that fails mid-flow used to hang the runner. `ui/test/setup-view.test.mjs` wraps `globalThis.setInterval` to `unref()` its timers for that reason.
