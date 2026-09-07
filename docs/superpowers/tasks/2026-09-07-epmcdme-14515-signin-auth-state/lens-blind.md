- `parse_profile_status` now takes `stdout` OR `stderr`, never both: `let combined = if stdout.is_empty() { stderr } else { stdout }`. The old code concatenated both. If the CLI emits an error only on stderr while stdout is non-empty (even a single blank line), the error is silently dropped and the function may return `signed_in` or `unknown` instead of `not_signed_in` — `inspector.rs` hunk @@ -58

- The expired-state test (`profile_status_expired_no_real_fixture_pattern_only`) is explicitly flagged as having no real CLI fixture and the fixture used (`"│ Auth Status │ Expired │\n"`) contains no `✗` prefix. The parser relies on `lower.contains("expired")` for this branch, but if the actual CLI emits `"✗ Token expired"` rather than the bare word "Expired," the match may miss or hit the wrong branch — `inspector.rs` hunk @@ -139

- `startSignIn`'s final `bridge.inspector.checkProfileStatus()` call has no `.catch()`. If that invocation throws after a login attempt, the rejection is unhandled, `updateIdentityAuthStatus` is never called, and the UI stays stale with no user feedback — `renderer.js` hunk @@ -287

- `startSignIn` returns `undefined` in all paths. When EPMCDME-14589 wires the sign-in button, the caller has no way to learn whether sign-in succeeded without re-invoking `checkProfileStatus` itself; the function should either return the resulting `ProfileStatus` or throw on failure — `renderer.js` hunk @@ -271

- `findLoginError` matches only `/^\s*(✗|Error:)/`. Failures surfaced as `"error: ..."` (lowercase), `"FAILED: ..."`, multi-line OAuth errors, or timeout messages are invisible. The comment explicitly states the CLI exits 0 on failure paths, making this regex the sole error signal — `signin-parse.js` lines 1–5

- `startSignIn` calls `hideNotice()` unconditionally at entry. If the function is called while an unrelated notice is showing (possible once EPMCDME-14589 adds a sign-in surface), that notice is silently dismissed before the login stream even starts — `renderer.js` hunk @@ -273

- `startSignIn` has no timeout and no cancellation path around `bridge.runner.runStream('codemie profile login', ...)`. Browser-based SSO that the user never completes causes the function to `await` indefinitely with no UI feedback and no escape — `renderer.js` hunk @@ -274–275

- The `ensureAuthenticated` catch branch maps a thrown invocation error to `{ state: 'not_signed_in', detail: '' }`, immediately blocking the user with the "CodeMie isn't signed in" notice on any transient IPC failure (not just a genuinely unauthenticated state). The behaviour change from the old `authenticated: false` path is identical in effect, but the choice is now more explicit and could warrant a distinct `state` value or at least a comment — `renderer.js` hunk @@ -244–246

- The `unknown`-passes-as-authenticated policy is documented only in a comment (`// Gates only on not_signed_in and no_profile; unknown is treated as authenticated`). There is no test asserting that `ensureAuthenticated` returns `true` when `state === 'unknown'`, so a future edit to the condition could silently regress the intentional permissive path — `renderer.js` hunk @@ -238, `inspector.rs` has no corresponding gate test
