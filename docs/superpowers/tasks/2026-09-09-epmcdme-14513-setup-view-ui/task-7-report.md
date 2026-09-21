DONE

## Commit

SHA: `3b109df7fa440f57368212228eda289b2bd980dc`
Subject: `feat: setup-view transient spinner, installClaude via onLog, success/failure mapping`

Same commit as Tasks 5 and 6 — see the "How this task was run" note in `task-5-report.md`.

## What was done

1. `handleResolve(result)` — the CLI printing success is not the proof; the configuration file is. It hides the transient spinner, settles the install row, then reads EPMCDME-14511's config reader and treats the run as successful only when `cfg.state === 'valid'` **and** `cfg.profile === profileName`. Anything else (mismatch, broken config, a throwing reader) marks the last rendered row ERROR.
2. `handleReject(err)` — four branches, in order: a `step` that names a rendered prompt marks that id's **latest occurrence** row (not a bare-id lookup, since `credential` legitimately repeats); `step === 'model'` with no model row yet inserts `model-<n>` directly in ERROR, because the driver can reject from inside the option collection before the prompt is ever dispatched; otherwise the currently open row is marked; and with nothing open, the "Working…" row is retitled "Setup stopped" and becomes the ERROR marker in place (`converted = true`, so Task 5's hide does not then remove it). It also calls `settleInstallRow()`.
3. Wired both into `start()`'s `deps.startSetup(...)`. `start()` resolves `{ ok, profileName }` or `{ ok: false, error }` and never rejects: the rows already carry the outcome, and EPMCDME-14588 reads `error` (the driver's `{ step, message, raw }`) from here to build the failure UI.

## Test commands + output

Eight dedicated tests, all mutation-checked:

- `success: readConfig reports the new profile active; every row stays COMPLETE and start() says ok`
- `mismatch: a different active profile marks the last row ERROR and start() says not ok`
- `broken config or a throwing reader is a mismatch too`
- `rejection naming an answered step marks that row ERROR and start() hands the driver error back`
- `rejection with step "model" before any model row inserts the model row in ERROR`
- `rejection with step null while a prompt is open marks the open row ERROR`
- `rejection with step null between prompts turns the Working row into the one ERROR row on screen`
- `rejection naming a repeated catch-all id marks its latest occurrence, not the first`

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

None. The one place Tasks 5 and 7 could contradict each other — the between-prompts rejection — is asserted from both sides: exactly one ERROR row on screen afterwards, never zero and never two.
