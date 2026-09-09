# Code review — 2026-09-08-epmcdme-14668-guided-setup-driver (2026-09-08)

**request-changes** · confidence: low · 5 blocking · 0 deferred · 3 filtered as noise
Coverage: blind — n/a (compact profile) · edge-case ✓ · acceptance — n/a (no spec) · verification-gap — n/a (compact profile)  (1/1 applicable lenses ran)

## Look here first

- `ui/setup-driver.js:178` — [other, concurrency] a paginated model-list redraw changes the dedup signature, letting a second collectModelOptions() walk fire while the first is still in flight, corrupting the model answer — CR-002
- `ui/setup-driver.js:231` — [other, hang] the idle timer never acts on an unclassified, non-(y/N) prompt, so an unrecognized screen hangs the run forever with no error surfaced — CR-004
- `ui/setup-driver.js:70` — [other] collectModelOptions()'s pagination walk has no step cap and can loop forever — CR-001
- `ui/setup-driver.js:185` — [other] an out-of-range model answer index silently misnavigates the cursor instead of erroring — CR-003
- `ui/setup-driver.js:293` — [other] if kill() rejects during exit cleanup, resumePtyInput() is skipped and terminal keystroke forwarding stays suspended — CR-005

## Also flagged

(none)

## Checked and clean

edge-case ✓ · 3 dismissed as noise (atob-fallback matches ui/terminal.js's existing pattern; generic-fallback String(answer) branch is confirmed dead code by its own comment; AUTO_LIST/AUTO_CONFIRM kind-mismatch scenario has no live path against the current fixed PROMPTS table)
