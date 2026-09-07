# Code review — 2026-09-07-epmcdme-14515-signin-auth-state (2026-09-07)

**request-changes** · confidence: low · 7 blocking · 5 deferred · 1 filtered as noise

> Review may be incomplete: no story/spec was present (acceptance lens not dispatched).

Coverage: blind ✓ · edge-case ✓ · verification-gap ✓ · acceptance — n/a (no spec)  (3/4 lenses ran)

## Look here first

- `src-tauri/src/commands/inspector.rs:118` — [security] stdout/stderr merge silently drops stderr errors when stdout is non-empty; auth errors or no_profile state invisible to the parser — CR-001
- `src-tauri/src/commands/inspector.rs:145` — [security] Auth Status row containing "Not authenticated" matches lower.contains("authenticated"), returning signed_in instead of not_signed_in — CR-002
- `src-tauri/src/commands/inspector.rs:139` — [other] expired-state test uses a synthetic fixture with no real CLI capture; expired-token detection may silently return unknown in production — CR-003
- `ui/renderer.js:357` — [infra] startSignIn awaits runStream and checkProfileStatus with no try/catch; IPC errors leave the identity bar stale with no user feedback — CR-006
- `ui/signin-parse.js:3` — [other] findLoginError matches only ✗ and Error: prefixes; lowercase error, FAILED, timeout messages pass through as null, silently treating failures as success — CR-007

## Also flagged

- `ui/renderer.js:338` — [other] ensureAuthenticated no_profile blocking branch is untested; a future edit dropping it would let an unconfigured user bypass the auth gate undetected — CR-004
- `ui/renderer.js:338` — [other] ensureAuthenticated unknown-passes-gate is untested; the intentional permissive policy has no test, so a regression on the core bug this ticket fixes would ship undetected — CR-005

## Checked and clean

commit-format ✓ · code-quality — n/a (no guide) · security — n/a (no guide, manual review clean) · 5 deferred → code-review-deferred.md
