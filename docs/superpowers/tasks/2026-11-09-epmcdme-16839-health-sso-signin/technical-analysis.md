# Technical Research

**Task**: health doctor-groups remedyFor signin
**Generated**: 2026-11-09
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16839: CodeMie Connect macOS first-run Health check fails with "Cannot connect to provider", hint `Failed to fetch models from SSO API: Unexpected token '<', "<!-- Keycl"... is not valid JSON`. The CLI (other repo, leave alone) gets a 200 Keycloak sign-in HTML page and JSON.parse fails. In the app, remedyFor in ui/doctor-groups.js picks the remedy; it has a signin action ("Sign in again") only when a hint mentions `codemie profile login`; any "Cannot connect"/"unreachable" row falls to network/VPN text with plain "Check again". onSignIn in ui/health-controller.js runs signIn then re-runs the check. Required fix: recognise the HTML sign-in response in the hint ("Unexpected token '<'" / "is not valid JSON" shape) and give that row the signin action with sign-in wording instead of VPN text; keep the CLI hint as remedyDetail like other branches. Tests in ui/test/doctor-groups.test.mjs (node:test) with the real hint text. Don't touch Rust or guided setup. Acceptance: if SSO API returns HTML sign-in page the app reports an actionable authentication state instead of a JSON parse error as connectivity failure; retry after sign-in re-fetches models.
Also report: exact current shape of remedyFor, how existing signin branch/tests look, and any other place (e.g. health-controller, copy strings, docs/wireframes) that must change.

---

## 2. Codebase Findings

### Existing Implementations
- `/Users/mert_efe/codemie-installers/codemie-claude-installer-macos/ui/doctor-groups.js` (192 lines): `groupDoctorResults(records)` -> `sectionRow(name, items)` / `runtimeRow(items)` -> `remedyFor(items)` (lines 63-98). Pure function, no DOM.
- `ui/health-controller.js` (102 lines): `createHealthController`; `run()` streams `codemie doctor`, parses (`doctor-parse.js`), groups, `renderHealth(...)` with `onSignIn: async () => { await signIn?.(); run(); }` (lines 82-85).
- `ui/health-ui.js` `buildRow` (lines 53-76): renders `row.remedyText` / `row.remedyDetail` via `renderFailurePanel`; dispatches on `action.kind`: `navigate` -> onNavigate, `signin` -> onSignIn, else onRecheck. Generic over kind, so a new row with `kind: 'signin'` needs no change here.
- `ui/renderer.js`: `signIn: () => startSignIn()` (line 511); `startSignIn()` (~line 590) runs `codemie profile login`, scans output with `findLoginError`, re-reads profile status.

### Exact current shape of remedyFor
Input: the section's records `items`. Computes `problems` (status error|warn), `hints` (unique non-empty `hint`s of problems), `remedyDetail = hints.join('\n') || undefined`. Branch order, first match wins:
1. any hint matches `/\bcodemie setup\b/` -> `{ remedyText: 'Set up CodeMie to create your profile.', remedyDetail, action: { kind: 'navigate', view: 'setup', label: 'Set up CodeMie' } }`
2. any hint `.includes('codemie profile login')` -> `{ remedyText: 'Sign in again to restore your CodeMie session.', remedyDetail, action: { kind: 'signin', label: 'Sign in again' } }`
3. any problem MESSAGE matches `/unreachable|cannot connect/i` -> `{ remedyText: 'This is usually the network or the VPN. Check your connection, then check again.', remedyDetail, action: { kind: 'recheck', label: 'Check again' } }`
4. hints.length -> `{ remedyText: hints.join('\n'), remedyDetail: undefined, action: recheck 'Check again' }`
5. else all undefined.
Note branch 3 matches on `message` while 1, 2 match on `hint`. Also `runtimeRow` calls `remedyFor`, so any new branch applies there too (harmless).

Where the failing hint lives: per the existing test comment (sso.health.js shape), the section "CodeMie SSO Provider" yields item 1 `error 'Cannot connect to provider'` (no hint) and item 2 `error 'Provider unreachable'` with the raw error as `hint`. The ticket's hint text is assumed to be on that second item. The row label is `worstOf(items).message` (first error = "Cannot connect to provider"). I did not have a real doctor capture of this case; no fixture exists for it (fixtures: no-config, signed-in, sso-expired in `ui/test/fixtures/doctor/`). Whether the hint is on the second item should be confirmed against a real capture or the CLI source.

### Architecture and Layers Affected
Frontend-only: presentation/grouping layer (`doctor-groups.js`). Controller (`health-controller.js`) and view (`health-ui.js`) already support the signin action. Rust untouched.

### Integration Points
- CLI `codemie doctor` text output -> `doctor-parse.js` -> `doctor-groups.js` -> `health-ui.js`.
- `signIn` injected from `renderer.js` -> `startSignIn()` -> `codemie profile login`.
- Home also consumes `getLastResult()` / `onResult` from the controller (health rows), so the new row shape flows there too; nothing keyed on the VPN text found.

### Patterns and Conventions
- Remedy objects `{ remedyText, remedyDetail, action }`; CLI hint is kept as `remedyDetail` when the words are ours.
- Action kinds: `navigate`, `signin`, `recheck`.
- Tests construct records inline (`{ name, status, message, hint }`) or load real captures from fixtures.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (project.md, quality-gates.md, architecture/architecture.md, development/development-practices.md, standards/git-workflow.md, testing/testing-patterns.md). Nothing health-specific in architecture.md (grep for health/doctor returned no hits I relied on). `docs/wireframes/05-health.png` exists; it is a PNG, not inspected, and no text copy of the VPN/sign-in strings was found in docs outside old task logs.

### Architectural Decisions
Inline comment in `doctor-groups.js` lines 85-86: the CLI hint for unreachable is "the raw network error, which says what broke but not what to do" (rationale for branch 3).

### Derived Conventions
Branch on the CLI's hint text with a regex; fixtures from real output where available.

---

## 4. Testing Landscape

### Existing Coverage
- `ui/test/doctor-groups.test.mjs` (217 lines, node:test + node:assert/strict):
  - `sso-expired` fixture test (lines 99-108): asserts label 'SSO credentials not found', remedyText 'Sign in again to restore your CodeMie session.', remedyDetail 'Run: codemie profile login', action `{ kind: 'signin', label: 'Sign in again' }`.
  - Unreachable provider test (lines 120-132): records `Cannot connect to provider` (no hint) + `Provider unreachable` with hint `fetch failed`; asserts VPN remedyText, remedyDetail 'fetch failed', action recheck. This must stay passing.
  - Expiring-session test (134-145): warn with hint 'Consider refreshing session: codemie profile login' -> signin.
  - Non-signin hint test (110-118), no-config navigate test (210-217).
- `ui/test/health-controller.test.mjs`: line ~279 asserts a 'Sign in again' button; test at ~327 "'Sign in again' runs the app sign-in, then checks again" (signIn stub then second runStream call). This already covers the "retry after sign-in re-fetches" acceptance criterion at controller level.
- `ui/test/health-ui.test.mjs` line 161: signin action calls onSignIn, not onRecheck.
- `ui/test/failure-panel.test.mjs` line 51-59 uses 'This is usually the VPN.' as sample text only (independent of doctor-groups).

### Testing Framework and Patterns
`npm test` = `node --test ui/test/*.test.mjs`. No mocks needed for doctor-groups; pure input/output.

### Coverage Gaps
No test or fixture for HTML/JSON-parse-error hint. No real doctor capture of this failure in `fixtures/doctor/`.

---

## 5. Configuration and Environment

### Environment Variables
None relevant.

### Configuration Files
`package.json` test script only.

### Feature Flags and Deployment Concerns
None found. Working tree has unrelated uncommitted changes (`.ai-run/guides/project.md`, `.codemie/codemie-cli.config.json`, `AGENTS.md`); current branch `fix/EPMCDME-16839-health-sso-signin`.

---

## 6. Risk Indicators

- Speculative: the hint may arrive on the "Provider unreachable" item or elsewhere; a matcher run over `hints` (not `message`) must be placed before branch 3 (and the matcher must not also catch the `fetch failed` hint, or the existing test breaks).
- Speculative: matching "Unexpected token '<'" / "is not valid JSON" is a string match against Node's JSON.parse message, which can vary across Node versions (e.g. newer wording `Unexpected token '<', "<!-- Keycl"... is not valid JSON` vs older `Unexpected token < in JSON at position 0`); a looser regex covering both and `<!DOCTYPE`/`Keycloak` would be more robust.
- Speculative: a non-HTML JSON parse error (e.g. truncated JSON from a flaky proxy) matching only "is not valid JSON" would be misrouted to sign-in; requiring the `<` token narrows it.
- `startSignIn` ignores exit code and Home state; after sign-in the controller re-runs `codemie doctor`, which is the "re-fetch models" path; no change expected there.
- No real fixture of the failing output; tests would use inline records with the ticket's hint text.
- Home and Health share rows via `getLastResult`; verify the Home checklist does not key on remedyText (not found in my scan).

---

## 7. Summary for Complexity Assessment

The change surface found is one pure function, `remedyFor` in `ui/doctor-groups.js`, with a precedent for exactly this kind of branch (the `codemie profile login` hint branch returning a `signin` action). The controller (`onSignIn` = signIn then `run()`) and view (`health-ui.js` dispatches on `action.kind`) already support the action, so no other source file appeared to need changes. Tests live in `ui/test/doctor-groups.test.mjs`, which has near-identical tests (sso-expired, unreachable provider) to model new ones on.

Technical novelty is low; no Rust, config, or deployment surface. Coverage is good for the neighbouring branches and the controller's sign-in-then-recheck flow; the gap is only the new hint shape and the absence of a real captured fixture for this failure. Main risks are regex robustness against Node's JSON.parse wording and branch ordering relative to the existing unreachable branch. Wireframe 05-health.png was not inspected for copy.

---

## 8. External References

None named by the task
