# Deferred from code review — 2026-09-07-epmcdme-14515-signin-auth-state (2026-09-07)

- **ensureAuthenticated catch maps to not_signed_in** — `ui/renderer.js:335` — On any IPC error thrown by checkProfileStatus, the catch block returns `{ state: 'not_signed_in' }`, blocking the user with a sign-in modal even on a transient error. Pre-existing: the previous boolean implementation returned `false` (blocked) on any thrown error; this change carries the same behaviour forward under the new shape.

- **startSignIn returns undefined** — `ui/renderer.js:357` — The function never returns the resulting ProfileStatus or throws on failure, so callers must re-invoke checkProfileStatus themselves to learn the outcome. Pre-existing: the function is defined here as a stub for EPMCDME-14589, which owns the sign-in button surface and will determine the return contract.

- **startSignIn dismisses any open notice unconditionally** — `ui/renderer.js:358` — hideNotice() is called at entry regardless of what notice is currently visible; an unrelated notice showing at call time is silently dismissed. Pre-existing: the function has no live UI trigger until EPMCDME-14589 wires the sign-in button; that ticket must decide whether to guard the dismiss or gate on notice identity.

- **startSignIn has no timeout or cancellation** — `ui/renderer.js:361` — bridge.runner.runStream awaits indefinitely; a browser-based SSO flow the user never completes hangs the function with no UI feedback and no escape. Pre-existing: the function is not yet reachable from any UI surface; EPMCDME-14589 must add the timeout/cancel mechanism when wiring the button.

- **startSignIn has no concurrent-invocation guard** — `ui/renderer.js:357` — Two concurrent calls race: both runStream instances interleave output, findLoginError may see garbled lines, and checkProfileStatus is re-read twice. Pre-existing: no UI surface can trigger startSignIn today; EPMCDME-14589 must add the guard when wiring the button.
