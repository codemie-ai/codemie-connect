# Header shows selected project after setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `codemie setup` completes, the header identity bar shows the project the wizard just wrote to config, instead of the stale boot-time value.

**Architecture:** `emit()`'s `case 'complete':` in `ui/renderer.js` gains one fire-and-forget call to a new async helper that re-reads `bridge.codemieConfig.read()` and calls the existing `renderIdentity(cfg || {})` — the same re-read-then-render shape `updateIdentityAuthStatus` already uses after sign-in (`ui/renderer.js:376-384`). `emit` itself stays synchronous. The dev-only hook at `ui/renderer.js:482-485` (exposed under `CODEMIE_DEV=1`) gains an `emit` reference so a Playwright test can trigger `'complete'` without driving a real engine run.

**Tech Stack:** Vanilla JS renderer (`ui/renderer.js`), Tauri IPC bridge (`ui/runner-bridge.js`), Playwright (`docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests`), Node `node:test` (`ui/test/*.test.mjs`).

**Ticket:** EPMCDME-14987 (requirements supplied inline — no spec.md for this task)

## Global Constraints

- Touch only `ui/renderer.js` (production) and the existing Playwright spec file (test). No changes to `src-tauri/src/commands/codemie_config.rs`, `ui/engine.js`, `ui/runner-bridge.js`, or EPMCDME-14350 work.
- Do not make `emit` itself `async`; only the `'complete'` case becomes async-aware via a helper it calls without awaiting.
- Preserve the `cfg || {}` fallback `renderIdentity` already relies on.
- Do not add code to populate a missing account/email for SSO profiles (separate CLI-side ticket).
- Commit per task using the repository's existing convention.

## Acceptance criteria

- [ ] AC1: After setup completes, the header shows the project value from the freshly-written config.
- [ ] AC2: The project is rendered through `renderIdentity`'s existing `#identity-project` field — no new markup/styling.
- [ ] AC3: The project value survives an app restart against the same config (confirm only — no new code).
- [ ] AC4: Auth status, account, profile, and model segments render exactly as before (no regression); no code added to backfill a missing SSO account/email.
- [ ] AC5: Ticket carries a screenshot of the fixed header showing the project after setup.

---

### Task 1: Re-render identity bar on setup completion

**Files:**
- Modify: `ui/renderer.js:143-149` (the `'complete'` case), and `ui/renderer.js:482-485` (dev hook)
- Test: `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests/identity-bar-config.spec.ts`

**Interfaces:**
- Consumes: `bridge.codemieConfig.read()` (`ui/runner-bridge.js:52`, existing, unchanged), `renderIdentity(cfg)` (`ui/renderer.js:229-241`, existing, unchanged).
- Produces: `async function refreshIdentityOnComplete()` (new, module-scope in `ui/renderer.js`, no params, no return value used) — called once from `case 'complete':`, and referenced nowhere else.

Test-first: yes — a Playwright case that triggers the `'complete'` event with a changed config and asserts `#identity-project` updates from the stale boot value to the new one.

- [ ] **Step 1: Write the failing test**

  In `identity-bar-config.spec.ts`, change the `boot()` helper's `addInitScript` to also stash the responses object on `window` so a later step can mutate it:
  ```ts
  (window as any).__invokeResponses = r;
  ```
  (added next to the existing `(window as any).__TAURI__ = ...` assignment, same `addInitScript` callback). Then add a new test:
  ```ts
  test('setup completion re-renders the project from the refreshed config', async ({ page }) => {
    await boot(page, withConfig({ state: 'valid', profile: 'default', model: 'sonnet', project: '', account: null }));
    await expect(page.locator('#identity-project')).toBeHidden();
    await page.evaluate(() => {
      (window as any).__invokeResponses.read_codemie_config =
        { state: 'valid', profile: 'default', model: 'sonnet', project: 'epm-cdme', account: null };
      (window as any).__codemie.emit('complete', { ok: true });
    });
    await expect(page.locator('#identity-project')).toHaveText('epm-cdme');
  });
  ```
  This requires `flags.dev` to be true so `window.__codemie` exists — add `dev: true` to this one test's `smoke_mode` stub via a local override: `{ ...BASE_INVOKES, smoke_mode: { ...BASE_INVOKES.smoke_mode, dev: true } }`, or simplest, add `dev: true` directly to `BASE_INVOKES.smoke_mode` (harmless to the other tests, which don't touch `__codemie`).

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm run test:ui -- -g "setup completion re-renders"`
  Expected: FAIL — `window.__codemie.emit` is `undefined` (not yet exposed) and/or `#identity-project` never updates.

- [ ] **Step 3: Implement the minimal production change**

  In `ui/renderer.js`, add a module-scope helper near `updateIdentityAuthStatus` (mirrors its try/catch-then-render shape):
  ```js
  async function refreshIdentityOnComplete() {
    let cfg;
    try {
      cfg = await bridge.codemieConfig.read();
    } catch {
      cfg = {};
    }
    renderIdentity(cfg || {});
  }
  ```
  In the `'complete'` case (`renderer.js:143-149`), add one line before `break;`: `refreshIdentityOnComplete();` (called, not awaited — `emit` stays synchronous).
  In the `CODEMIE_DEV` block (`renderer.js:482-485`), add `emit` to the exposed object: `window.__codemie = { showView, startSetup, emit };`.

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm run test:ui -- -g "setup completion re-renders"` — expect PASS.
  Also run: `npm test` — expect PASS (this is the node:test suite covering `setup-driver.js` and other modules directly imported by `renderer.js`; it's fast and is the only run that would catch the new `emit` reference in the `CODEMIE_DEV` hook breaking a shared-module import elsewhere).

- [ ] **Step 5: Mutation-check the new test**

  Comment out the `refreshIdentityOnComplete();` call added in Step 3 (leave the helper and dev-hook change in place). Run: `npm run test:ui`. Expected: exactly one failure — the new test from Step 1. Restore the `refreshIdentityOnComplete();` call. Run `npm run test:ui` again and confirm the full suite (including the four pre-existing `identity-bar-config.spec.ts` tests) passes. Also run `npm test` and confirm it still passes.

- [ ] **Step 6: Commit**

  Commit per the repository's existing convention (see `.ai-run/guides/standards/git-workflow.md`).

---

### Task 2: Manual verification and restart confirmation (artifact only, no code)

**Files:** none (produces a screenshot artifact for the ticket; no source changes)

Test-first: no — this task is manual verification, not implementation.

- [ ] **Step 1: Confirm post-fix behavior and capture the screenshot**

  Build the app with the Task 1 fix already in. Using an isolated `HOME` whose `~/.codemie/codemie-cli.config.json` initially has no `codeMieProject`: launch the app and confirm the header shows "CodeMie Desktop". With the app still running against that `HOME`, write a config containing `activeProfile` and `profiles.<name>.codeMieProject`, then run the setup wizard and Ctrl-C out of each interactive step (each `runPty` step returns `false` rather than throwing, so the engine still reaches `'complete'`). Confirm the header now shows the project value. Capture that screen as the MR/ticket screenshot (AC5).

  (The Playwright test added in Task 1 already proves the pre-fix behavior — `#identity-project` stays stale until `refreshIdentityOnComplete()` exists — so there is no need to also build and run an unfixed binary here.)

  If at any point this requires a real interactive setup/sign-in run rather than the Ctrl-C simulation above, STOP and flag it — sign-in is the ticket owner's to perform.

- [ ] **Step 2: Confirm AC3 (survives restart)**

  Relaunch the same fixed build against the same `HOME` used in Step 1 and confirm the project value still shows in the header on boot (config file is the source of truth, read at boot — no code change expected or needed here).
