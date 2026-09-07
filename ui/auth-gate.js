// Pure auth-gate helpers. No browser globals — safe to import in Node tests.

// Returns true when the given profile state should block the user from proceeding.
// Intentionally permissive: 'unknown' is treated as authenticated so a provider
// whose CLI omits an Auth Status row never blocks the user (matches the gate logic in
// renderer.js:ensureAuthenticated).
export function isBlockedState(state) {
  return state === 'not_signed_in' || state === 'no_profile';
}
