# Code review — 2026-09-09-epmcdme-14513-setup-view-ui (2026-09-09)

**request-changes** · confidence: high · 5 blocking · 0 deferred · 10 filtered as noise
Coverage: blind ✓ · edge-case ✓ · acceptance ✓ · verification-gap ✓ · standards ✓ (5/5 ran)

## Look here first

- `ui/setup-view.js:220` — [security] kind:`input` controls (incl. `credential`) render as plain text and the raw value is echoed permanently into the collapsed row's subtitle — no masking anywhere for secrets the CLI itself marks hidden — CR-004
- `ui/setup-driver.js:463` — [other] test-gap — the model-branch mirror of the new list-answered-echo fix (`answeredOnce.add` at line 463) has no dedicated regression test; every existing model test exits before reaching that path — CR-002
- `ui/setup-view.js:84` — [other] `PROMPT_COPY.profileName.heading` hardcodes "Profile name" instead of deriving the open-row title from the prompt's own message, contrary to the spec's stated rule for this row — CR-003
- `commits` — [other] 9 of 10 `EPMCDME-14513: ...` commit subjects use the ticket id as the leading token instead of a conventional type, violating git-workflow.md — CR-001
- `ui/setup-view.js:583` — [other] `start()` has no re-entrancy guard; a second concurrent call (dev-console-only path) clobbers the shared `occurrenceCounts`/`activeRowId`/container state of the first — CR-005

## Checked and clean

commit-format ✗ (see CR-001) · code-quality — n/a (no guide) · security ✗ (see CR-004) · 10 lens-reported candidates checked against real source and dismissed as unreachable or already-guarded (empty-model-list crash: the CLI diverts to a manual-entry prompt before the list ever renders with zero options; `storage`/`gate` are answered by the driver before `onPrompt` is ever called; the credential reopen-prefix collision and the DEFAULT_HINT nested-parens case do not occur against the actual CLI's prompt set; `renderControl`'s null-host hang is unreachable given the insert-then-lookup call order; the Continue-button double-submit race and blank-input submission are speculative with no live trigger).

The `ui/setup-driver.js` scope exception (commit 3ff82f8) was reviewed with the same rigor: the list-prompt `answeredOnce` fix is correct, minimal, and consistent with the confirm-prompt precedent it mirrors; it does not reopen any of the file's other invariants. Per the task's own directive, the file-touch itself is not counted as a finding.
