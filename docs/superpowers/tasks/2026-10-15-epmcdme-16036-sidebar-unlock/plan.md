# EPMCDME-16036 Sidebar unlock Implementation Plan

**Goal:** Unlock the sidebar once the sign-in and model items are COMPLETE, instead of waiting for `done`.

**Architecture:** One expression in the pure `deriveHome()` changes. `done` stays untouched. No Rust change. `renderer.js` and `shell-nav.js` need comment edits only.

**Conventions:** Commit per task using the repository's existing convention (`EPMCDME-16036 : Subject`, short body, no Co-Authored-By). Stage by explicit file name only. Never stage `AGENTS.md`, `.ai-run/guides/project.md` or `.codemie/codemie-cli.config.json`. Gate: `npm test`. Do not rename the `applyOnboardingNav` parameter.

## Acceptance criteria

- [ ] Signed in with a model set: Tools, Connections, Health and CLI usage analytics are unlocked, whatever Install a tool and Verify health show.
- [ ] Health problems do not lock the sidebar. The Verify health step still shows its warning and the Open Health action.
- [ ] Not signed in, or no model: the sidebar stays locked and Home stays clickable.
- [ ] An onboarded returning user stays unlocked, including with a broken profile.
- [ ] Unit tests cover the rule; `npm test` passes.

negative-constraints: `done` stays unchanged (Task 1 edits only the `unlocked` line); no `applyOnboardingNav` rename (not planned); no Rust change; no `AGENTS.md`, `.ai-run/guides/project.md` or `.codemie/codemie-cli.config.json` staged; no Co-Authored-By.

## Task 1: Unlock rule and tests

**Files:** `ui/home-state.js:252-254`, `ui/test/home-state.test.mjs:137-140`

**Test-first:** yes - signed in with a valid model and `health: null` expects `unlocked === true`. It fails against the old `done || onboarded` rule.

- [ ] Step 1: Replace the test at `home-state.test.mjs:137-140`. Reuse the existing fixtures `valid`, `signedIn`, `agents`, `healthy`. Each case below is a `deriveHome` call with `onboarded` unset unless stated, asserting `.unlocked`:
  - Signed in plus model, with health `null`, `healthy`, a health failure (`{ rows: [{ status: 'fail' }], summary: { passing: 0, total: 1 } }`), `healthFailed: true`, and agents `[]`: all `true`. `done` stays `false` for the health-null case.
  - `auth: { state: 'unknown' }` plus valid config: `true`.
  - Valid config with `auth: null` (read in flight): `false`.
  - `auth: { state: 'not_signed_in' }` plus valid config: `false`.
  - Signed in with `config: { state: 'no-configuration' }`: `false`.
  - First-run broken config, with a profile but no `onboarded` (see `modelItem` at `home-state.js:43` for the shape): `false`.
  - `onboarded: true` with a broken profile or lapsed sign-in: `true`. Lines 134 and 312 already cover this, so keep them.
  - Keep the `done` assertions that already exist elsewhere unchanged.
- [ ] Step 2: Run `npm test` and confirm the new cases fail for the right reason.
- [ ] Step 3: In `home-state.js:254`, replace the expression with `unlocked: onboarded || (items[0].status === StepStatus.COMPLETE && items[1].status === StepStatus.COMPLETE)`. Use the item statuses, not raw `auth` or `config`. Check that `StepStatus` is already imported in that file. Also rewrite the comment at 252-253 to say the sidebar opens once sign-in and model are set, or after setup has finished once, and does not wait for Health.
- [ ] Step 4: Run `npm test` and confirm everything passes.
- [ ] Step 5: Mutation check. Revert only line 254 to `unlocked: done || onboarded` and run `npm test`. Confirm that exactly the new or changed unlock tests fail and that no other test fails. Restore the new rule and re-run `npm test` to confirm it is green. Confirm with `git diff` that no mutation is left in the tree.
- [ ] Step 6: Commit `ui/home-state.js` and `ui/test/home-state.test.mjs`.

## Task 2: Stale comment wording

**Files:** `ui/home-state.js:77`, `ui/home-view.js:79`, `ui/renderer.js:280-281`, `ui/shell-nav.js:1-10`, `ui/test/home-state.test.mjs:114-115` and `:208`, `ui/test/home-view.test.mjs:173-174`

**Test-first:** no - comment-only change. `npm test` must still pass.

- [ ] Step 1: Reword each comment so it no longer says the sidebar or Health stays locked until the checklist is done. The new wording:
  - The sidebar opens once sign-in and model are set.
  - The Open Health action on a failed or unfinished check is still the way to reach the error and its retry.
  - The `shell-nav.js` header says the nav stays locked until sign-in and model are set, or setup has finished once.
  - The `home-state.test.mjs:114-115` comment states that a returning user does not see a locked sidebar.
  - Make no code change in these files. Then run `npm test` and `git diff` to confirm that only comment lines changed.
- [ ] Step 2: Commit those files by explicit name.
