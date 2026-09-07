# Sign-in and Auth State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the boolean `ProfileStatus` with a four-state `{ state, detail }` shape, migrate both renderer.js callers through the IPC bridge, and add an SSO sign-in flow streamed through the existing `run_stream` command.

**Architecture:** The Rust `ProfileStatus` struct drops `authenticated: bool` and gains `state: String` (four values). A single new `checkProfileStatus` entry in the runner-bridge.js `inspector` export eliminates the two bare-invoke violations in renderer.js. A new JS `startSignIn` handler streams `codemie profile login` via the established `runner.runStream` path (which takes a command string, not an array), scans stdout through a pure `findLoginError` helper in its own browser-global-free module, and re-reads profile status on completion — never trusting the exit code.

**Tech Stack:** Rust/Tauri (`src-tauri/src/commands/inspector.rs`), JavaScript (`ui/runner-bridge.js`, `ui/renderer.js`, `ui/signin-parse.js`, `ui/test/`)

**Spec:** requirements inline (EPMCDME-14515)

## Global Constraints

- `state` must be exactly one of `'signed_in' | 'not_signed_in' | 'unknown' | 'no_profile'` — never a boolean
- `< /dev/null` stdin redirect in `check_profile_status` must be preserved on macOS
- No `tauri-plugin-opener`, `-shell`, or new Tauri capabilities added
- Do not build identity bar (14511), home screen (14589), broken-profile panel (14658), profile management (14576), non-SSO sign-in (14513)
- Every rewritten Rust test must pass a mutation check (revert the branch under test, confirm exactly one test fails, restore)
- Row 2 (expired) has no real-CLI-output fixture; test uses documented pattern only; note this explicitly in MR description
- Commit per task using the repository's existing convention

---

## Acceptance criteria

- A user who has never signed in can authenticate on the CodeMie SSO page in their browser; after completing auth the application reports `state: 'signed_in'`.
- An unreachable sign-in endpoint surfaces the CLI's own error line via `showNotice`, not a generic message.
- All five outcomes produce the correct `state` and `detail`. A profile whose provider omits an Auth Status row reports `state: 'unknown'`, never `'not_signed_in'`.
- The auth result is `{ state, detail }` at every call site — no boolean.
- Both renderer.js callers go through `bridge.inspector.checkProfileStatus()`.
- Connect Claude Desktop gates correctly when `state === 'unknown'` (must not block it).
- No import, repair, or migration step for profiles created or changed in the terminal.

---

### Task 1: Rewrite Rust auth-state struct, parser, command, and tests

**Test-first: yes — rewrite the five existing tests for the new return type before changing the parser; they will fail to compile until steps 3-4 are done.**

**Files:**
- Modify: `src-tauri/src/commands/inspector.rs:100-260`

**Interfaces:**
- Produces: `ProfileStatus { pub state: String, pub detail: String }` (serialized over IPC); `fn parse_profile_status(stdout: &str, stderr: &str) -> ProfileStatus` (private)

- [ ] **Step 1: Replace `ProfileStatus` struct (lines 100-103)**

  Remove `authenticated: bool`, add `pub state: String`. Keep `#[derive(Serialize, Clone)]`. Replace `#[derive(Default)]` with a manual impl so the default state is `"unknown"` rather than an empty string that matches no valid value:

  ```rust
  impl Default for ProfileStatus {
      fn default() -> Self {
          ProfileStatus { state: "unknown".into(), detail: String::new() }
      }
  }
  ```

- [ ] **Step 2: Rewrite all five existing tests (lines 234-260) for the new type**

  Replace every test function in the `#[cfg(test)]` module with the seven below. They will not compile until the parser is updated — that is intentional.

  ```rust
  // Row 1 — signed_in
  #[test]
  fn profile_status_authenticated() {
      let stdout = "│ Auth Status │ ✓ Authenticated (expires in 2h) │\n│ Provider │ ai-run-sso │\n";
      let r = parse_profile_status(stdout, "");
      assert_eq!(r.state, "signed_in");
      assert!(r.detail.contains("Authenticated"));
  }

  // Row 2 — not_signed_in, expired
  // NOTE: No real-CLI-output fixture exists for this row (the available SSO session is
  // fresh and cannot be aged; credentials are encrypted at rest). This test asserts
  // against the documented string pattern only. Documented in MR description.
  #[test]
  fn profile_status_expired_no_real_fixture_pattern_only() {
      let stdout = "│ Auth Status │ Expired │\n│ Provider │ ai-run-sso │\n";
      let r = parse_profile_status(stdout, "");
      assert_eq!(r.state, "not_signed_in");
      assert!(r.detail.to_lowercase().contains("expired"));
  }

  // Row 3 — unknown: profile rows present, no Auth Status row; detail must be ""
  #[test]
  fn profile_status_no_auth_status_row_is_unknown_not_not_signed_in() {
      let stdout = "│ Provider │ anthropic-subscription │\n│ Profile  │ MertPersonal           │\n";
      let r = parse_profile_status(stdout, "");
      assert_eq!(r.state, "unknown");
      assert_eq!(r.detail, "");
  }

  // Row 4 — not_signed_in: "✗ …" reason line + warning (verified fixture)
  #[test]
  fn profile_status_sso_credentials_missing_is_not_signed_in() {
      let stdout = "✗ No SSO credentials found for https://codemie.lab.epam.com. Please run: codemie profile login --url https://codemie.lab.epam.com\n⚠️  Authentication required to use this profile\n";
      let r = parse_profile_status(stdout, "");
      assert_eq!(r.state, "not_signed_in");
      assert!(r.detail.starts_with("✗ No SSO credentials found"));
  }

  // Row 5 — no_profile (verified fixture)
  #[test]
  fn profile_status_no_active_profile() {
      let stdout = "No active profile found. Run \"codemie setup\" to create one.\n";
      let r = parse_profile_status(stdout, "");
      assert_eq!(r.state, "no_profile");
      assert!(r.detail.contains("No active profile found"));
  }

  // Empty output fallback
  #[test]
  fn profile_status_empty_output_is_unknown() {
      let r = parse_profile_status("", "");
      assert_eq!(r.state, "unknown");
      assert_eq!(r.detail, "");
  }

  // "expires in" must not be mistaken for "expired"
  #[test]
  fn profile_status_expires_in_future_not_mistaken_for_expired() {
      let stdout = "│ Auth Status │ ✓ Authenticated (expires in 3d) │\n";
      let r = parse_profile_status(stdout, "");
      assert_eq!(r.state, "signed_in");
  }
  ```

- [ ] **Step 3: Rewrite `parse_profile_status` (lines 109-127) to return `ProfileStatus`**

  ```rust
  fn parse_profile_status(stdout: &str, stderr: &str) -> ProfileStatus {
      let combined = if stdout.is_empty() { stderr } else { stdout };
      if combined.contains("No active profile found") {
          return ProfileStatus { state: "no_profile".into(), detail: combined.trim().to_string() };
      }
      if combined.contains("Authentication required to use this profile") {
          let detail = combined.lines()
              .find(|l| l.trim_start().starts_with('✗'))
              .unwrap_or("")
              .to_string();
          return ProfileStatus { state: "not_signed_in".into(), detail };
      }
      // U+2502 (│) separators — look for the Auth Status row
      if let Some(auth_line) = combined.lines().find(|l| l.contains("Auth Status")) {
          let lower = auth_line.to_lowercase();
          if lower.contains("expired") {
              return ProfileStatus { state: "not_signed_in".into(), detail: auth_line.to_string() };
          }
          if lower.contains("authenticated") {
              return ProfileStatus { state: "signed_in".into(), detail: auth_line.to_string() };
          }
      }
      ProfileStatus { state: "unknown".into(), detail: String::new() }
  }
  ```

- [ ] **Step 4: Update `check_profile_status` (lines 134-145)**

  Change the `ProfileStatus` construction so it returns the parser's output directly instead of mapping from `(bool, String)`. Keep the `< /dev/null` redirect and all other command-building logic unchanged.

- [ ] **Step 5: Run tests and confirm all seven pass**

  From `src-tauri/`: `cargo test commands::inspector::tests`

- [ ] **Step 6: Mutation-check each new test**

  For each of the seven tests: comment out the specific parser branch it exercises, run `cargo test commands::inspector::tests`, confirm exactly one test fails, restore the branch before moving to the next.

- [ ] **Step 7: Quality gates and commit**

  From `src-tauri/`: `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test`

---

### Task 2: Bridge entry and atomic renderer caller migration

**Test-first: no — renderer.js has no test infra; both callers must be migrated in one commit to prevent the partial-migration silent-failure (reading `st.authenticated` on the new shape returns `undefined`, which is falsy, causing every profile to appear unauthenticated).**

**Files:**
- Modify: `ui/runner-bridge.js:34-43`
- Modify: `ui/renderer.js:312-330` (ensureAuthenticated + catch), `ui/renderer.js:473-477` (identity-bar caller)

**Interfaces:**
- Consumes: `ProfileStatus { state: String, detail: String }` from Task 1
- Produces: `bridge.inspector.checkProfileStatus()` for renderer callers; `updateIdentityAuthStatus(st)` named function (reused by Task 3)

- [ ] **Step 1: Add `checkProfileStatus` to the inspector export (`runner-bridge.js:34-43`)**

  After the last existing entry in the `inspector` export block, add one line matching the existing style:
  `checkProfileStatus: () => invoke('check_profile_status'),`

- [ ] **Step 2: Migrate `ensureAuthenticated` (renderer.js:312-330)**

  Replace the bare `invoke('check_profile_status')` at line 315 with `bridge.inspector.checkProfileStatus()`. The single gating rule: show the blocking notice when `st.state === 'not_signed_in' || st.state === 'no_profile'`; proceed (treat as authenticated) for every other state, including `'unknown'`. Do not use `=== 'signed_in'` as the pass condition — that would block `unknown` and recreate the exact bug this ticket fixes, one layer up. Update the catch fallback from `{ authenticated: false, detail: '' }` to `{ state: 'not_signed_in', detail: '' }`. Preserve `primaryAction: () => enterWizard(null)` exactly as-is.

- [ ] **Step 3: Migrate the identity-bar caller (renderer.js:473-477) and extract `updateIdentityAuthStatus`**

  Replace the bare `invoke('check_profile_status')` with `bridge.inspector.checkProfileStatus()`. Extract the `identity-auth-status` text update into a named function `updateIdentityAuthStatus(st)` so Task 3's sign-in handler can reuse it without duplication. Display text per state:
  - `'signed_in'` → show `st.detail` or `'Signed in'`
  - `'unknown'` → `'Auth status unknown'`
  - `'not_signed_in'` → `'Not signed in'`
  - `'no_profile'` → `'No profile'`

- [ ] **Step 4: Run `npm test` and commit**

---

### Task 3: Sign-in handler

**Test-first: yes — put the error-line scan in its own browser-global-free module (`ui/signin-parse.js`, same pattern as `ui/setup-parse.js`) and test it with `node:test` before writing the async orchestration around it.**

**Files:**
- Create: `ui/signin-parse.js`
- Create: `ui/test/signin.test.mjs`
- Modify: `ui/renderer.js` (import `findLoginError` from `./signin-parse.js`, add `startSignIn`, wire to sign-in trigger)

**Interfaces:**
- Consumes: `bridge.inspector.checkProfileStatus()` (Task 2), `runner.runStream(cmdString, onLine)` (runner-bridge.js:17-30 — takes a string, not an array), `showNotice`/`hideNotice` (renderer.js:210-225), `updateIdentityAuthStatus` (Task 2 step 3)
- Produces: `findLoginError(lines: string[]): string | null` in `ui/signin-parse.js` (pure, no browser globals, imported by both renderer.js and the test)

- [ ] **Step 1: Write the failing tests for `findLoginError` in `ui/test/signin.test.mjs`**

  ```js
  import { strict as assert } from 'node:assert';
  import { test } from 'node:test';
  import { findLoginError } from '../signin-parse.js';

  test('findLoginError returns the ✗ line on SSO failure', () => {
    const lines = [
      '✗ No SSO credentials found for https://codemie.lab.epam.com. Please run: codemie profile login --url https://codemie.lab.epam.com',
      'Opening browser...',
    ];
    const result = findLoginError(lines);
    assert.ok(result.startsWith('✗ No SSO credentials found'));
  });

  test('findLoginError returns the Error: line on generic failure', () => {
    const lines = ['Connecting...', 'Error: endpoint unreachable'];
    const result = findLoginError(lines);
    assert.equal(result, 'Error: endpoint unreachable');
  });

  test('findLoginError returns null on clean run with no error lines', () => {
    const lines = ['Opening browser...', 'Login successful.'];
    const result = findLoginError(lines);
    assert.equal(result, null);
  });
  ```

- [ ] **Step 2: Run `npm test` and confirm the three tests fail (module not yet defined)**

- [ ] **Step 3: Create `ui/signin-parse.js` with `findLoginError`**

  ```js
  // Pure parser — no browser globals, safe to import in Node tests.
  export function findLoginError(lines) {
    const found = lines.find(l => /^\s*(✗|Error:)/.test(l));
    return found ? found.trim() : null;
  }
  ```

- [ ] **Step 4: Run `npm test` and confirm all three tests pass**

- [ ] **Step 5: Verify the `--url` question before writing `startSignIn`**

  Before coding, run `codemie profile login` with no flags against a real SSO profile and observe whether the CLI picks up `codeMieUrl` from the active profile on its own. If it does, the command string is simply `'codemie profile login'` — no `--url` flag and no config read needed at all. If it does not infer the URL, STOP. Do not read the config file directly to work around this — that is 14511's reader's responsibility and this ticket is explicitly forbidden from writing a second reader. Instead, raise a scope question to extend 14511's reader before continuing.

- [ ] **Step 6: Add `startSignIn` to renderer.js (after confirming step 5)**

  Add `import { findLoginError } from './signin-parse.js';` near the other imports at the top of renderer.js. Then add the handler:

  ```js
  async function startSignIn() {
    hideNotice();
    const lines = [];
    // run_stream takes a command string, not an array — matches all existing callers
    await runner.runStream('codemie profile login', (line) => { lines.push(line); });
    // Exit code is ignored — profile login exits 0 on failure; scan stdout instead.
    const errorLine = findLoginError(lines);
    if (errorLine) {
      showNotice({
        title: 'Sign in failed',
        message: errorLine,
        primaryLabel: 'OK',
        primaryAction: hideNotice,
      });
    }
    // Always re-read profile status; never assume success from absence of an error line.
    const st = await bridge.inspector.checkProfileStatus();
    updateIdentityAuthStatus(st);
  }
  ```

  If step 5 determined that `--url` is required, replace the command string with a template literal using the URL obtained via whatever mechanism 14511 exposes — document the decision in the MR.

- [ ] **Step 7: Wire `startSignIn` to the sign-in trigger**

  Check `index.html` for an existing sign-in button element (look for `id` or `data-*` attributes related to sign-in in the identity-bar section). If present, attach `onclick = () => startSignIn()` at the same location as other button wires in renderer.js. If absent, leave `startSignIn` defined and note in the MR that the UI surface is provided by 14589.

- [ ] **Step 8: Smoke test**

  Rebuild: `cd src-tauri && CI=true cargo tauri build`. Launch the app. Trigger the sign-in action. Confirm the browser opens the SSO page. Complete auth and confirm the app refreshes to `signed_in`. Test the error path: point at an unreachable URL and confirm `showNotice` surfaces the CLI's own error line.

- [ ] **Step 9: Run `npm test` and commit**

---

## Negative-constraints audit

- "Do not treat missing Auth Status row as not-authenticated" — Task 1 parser returns `unknown` when no Auth Status row is found. Task 2 `ensureAuthenticated` proceeds for `unknown` (gates only on `not_signed_in`/`no_profile`). Both honored.
- "Do not return a boolean" — Task 1 removes `authenticated: bool`. Task 2 removes all `st.authenticated` reads. Honored.
- "Do not change return shape without updating BOTH callers atomically" — Task 2 migrates both callers in one commit. Honored.
- "Do not write row-3 fixture asserting non-empty detail" — Task 1 row-3 test asserts `detail == ""`. Honored.
- "Do not drop enterWizard(null)" — Task 2 preserves `primaryAction: () => enterWizard(null)` in `ensureAuthenticated`. Honored.
- "Do not judge sign-in success by exit code" — Task 3 ignores the return of `runStream` and scans stdout via `findLoginError`. Honored.
- "Do not remove `< /dev/null` redirect" — Task 1 preserves it in `check_profile_status`. Honored.
- "Do not add tauri-plugin-opener/-shell or new capability" — Task 3 uses only `run_stream` via `runner.runStream`. Honored.
- "Do not write a second config reader" — Task 3 does not read the config file at all; whether `--url` is required is resolved by verifying CLI behavior against a real profile (step 5), and if a config read becomes necessary the plan requires stopping and raising a scope question to extend 14511 rather than adding a reader here. Honored.
- "Do not build 14589/14658/14511/14576/14513 scope" — none appear in any task. Honored.
