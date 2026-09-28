# Health Controller getLastResult Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ui/health-controller.js` tracks the last successfully rendered `{ rows, summary, checkedAt }` result, exposes it via `getLastResult()`, and offers an optional `onResult(result)` callback — nulled out on either failure path.

**Architecture:** Add one closure variable (`lastResult`) alongside the existing `running` flag, bind it in `run()`'s success branch (currently an inline object literal passed straight to `renderHealth`), null it in both existing failure branches (CR-005 early return, CR-006 catch), and return it via a new `getLastResult` method. No new files, no change to parsing/grouping/rendering/styles.

**Tech Stack:** Vanilla ES modules, `node:test` + `node:assert/strict`.

**Requirements source:** inline (no spec.md) — see Acceptance criteria below.
**Technical analysis:** `docs/superpowers/tasks/2026-09-21-epmcdme-14506-health-getlastresult/technical-analysis.md`

## Global Constraints

- Do not modify `doctor-parse.js`, `doctor-groups.js`, `health-ui.js`, `failure-panel.js`, `renderer.js`, or any styling — out of scope, already verified/mutation-tested.
- Nothing for EPMCDME-14589 (Home) is in scope — no consumer code, no reference to Home.
- Commit per task using the repository's existing convention.

## Acceptance criteria

- [ ] A closure variable holds the exact `{ rows, summary, checkedAt }` object passed to `renderHealth` on a successful run.
- [ ] `createHealthController(...)` returns `getLastResult()`, returning that variable (or `null`).
- [ ] An optional `onResult(result)` option is invoked with the same object after each successful render, only when provided.
- [ ] `getLastResult()` returns `null` before any run has completed.
- [ ] `getLastResult()` returns `null` after a run that ends via the CR-005 zero-records path.
- [ ] `getLastResult()` returns `null` after a run that ends via the CR-006 catch-block path.
- [ ] Parser, grouping, screen rendering, styles, and failure-panel usage are untouched.
- [ ] No reference to EPMCDME-14589/Home exists in the diff.

---

### Task 1: Track and expose the last health result

**Files:**
- Modify: `ui/health-controller.js:21-29` (options destructuring), `:34` (closure state), `:58-64` (CR-005 branch), `:65-77` (success branch), `:78-83` (CR-006 branch), `:89` (return statement)
- Test: `ui/test/health-controller.test.mjs` (add new tests next to the existing 9; extend the existing CR-005 and CR-006 test bodies)

**Interfaces:**
- Produces: `createHealthController(...)` return value gains `getLastResult(): { rows, summary, checkedAt } | null`. Options gain `onResult?: (result: { rows, summary, checkedAt }) => void`.

**Test-first: yes — new/extended tests in `ui/test/health-controller.test.mjs` calling `getLastResult()`/passing `onResult` will fail against current `health-controller.js`, which has neither.**

- [ ] **Step 1: Write the failing tests**

  In `ui/test/health-controller.test.mjs`, add these test cases near the existing 9 (same file, same `makeEl` harness, same `createHealthController({...})` construction style as neighboring tests):

  1. `getLastResult() is null before any run` — construct a controller (any stub collaborators), call `getLastResult()` before calling `run()`, assert it is `null`.
  2. `getLastResult() returns the rendered result after a successful run` — use a `runStream` stub that supplies stdout lines producing at least one record (reuse the fixture/stub pattern from the file's existing successful-run test), call `run()`, then assert `getLastResult()` deep-equals an object with `rows`, `summary`, and the `checkedAt` value from the injected `now()` stub.
  3. `onResult is invoked with the rendered result after a successful run` — same successful-run setup, pass `onResult: (r) => { seen = r; }` in the options, assert `seen` matches what `getLastResult()` returns after `run()` resolves.
  4. Extend the existing CR-005 (zero-records) test body: after the existing assertions on `container._innerText()`, add `assert.equal(controller.getLastResult(), null)`.
  5. Extend the existing CR-006 (rejected `runStream`) test body: after the existing assertions, add `assert.equal(controller.getLastResult(), null)`.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `npm test` (or `node --test ui/test/health-controller.test.mjs`)
  Expected: the 5 new/extended assertions fail (`getLastResult is not a function` / `onResult` unused / assertion on `null` failing because the field doesn't exist yet). The original 9 tests still pass.

- [ ] **Step 3: Implement in `ui/health-controller.js`**

  - Add `onResult` to the destructured options at line 21-29, alongside `onFailure`.
  - Add `let lastResult = null;` next to `let running = false;` (line 34).
  - In the CR-005 branch (line 58-64), before the existing `return;` at line 63, add `lastResult = null;`.
  - In the success branch (lines 65-77), bind the object currently passed inline to `renderHealth` to a variable first, e.g.:
    ```js
    const result = { ...groupDoctorResults(records), checkedAt: now() };
    lastResult = result;
    renderHealth(container, result, { /* existing handlers unchanged */ });
    onResult?.(result);
    ```
  - In the CR-006 catch block (lines 78-83), before or alongside the existing `onFailure?.();` at line 83, add `lastResult = null;`.
  - Change the return statement at line 89 from `return { run };` to `return { run, getLastResult: () => lastResult };`.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `npm test`
  Expected: all 14 tests in `ui/test/health-controller.test.mjs` pass (9 original + 5 new/extended).

- [ ] **Step 5: Manual mutation-check**

  Temporarily delete the `lastResult = result;` assignment added in Step 3, re-run `npm test`, and confirm exactly the new/extended tests from Step 1 fail while the original 9 keep passing. Restore the assignment, re-run `npm test`, confirm all 14 pass again.

- [ ] **Step 6: Commit**

  Commit `ui/health-controller.js` and `ui/test/health-controller.test.mjs` together, using the repository's existing commit convention.

---

## Self-review

**Coverage:** every numbered requirement (1-9 in the task inputs) maps to an acceptance-criteria line and is implemented/tested in Task 1's steps: (1)(2) closure var + `getLastResult` — Step 3; (3) `onResult` — Step 3; (4) initial null — Step 1.1; (5) both null-out paths — Step 1.4/1.5 + Step 3; (6)(9) negative constraints — see below; (7) tests — Step 1; (8) mutation-check — Step 5.

**Negative constraints:**
- Requirement 6 (no parser/grouping/rendering/styles/failure-panel changes): Task 1's file list touches only `ui/health-controller.js` and its own test file; no task references `doctor-parse.js`, `doctor-groups.js`, `health-ui.js`, or `failure-panel.js`. Confirmed no violation.
- Requirement 9 (nothing for Home/EPMCDME-14589): no task references `renderer.js` or any Home-side consumer. Confirmed no violation.

**Placeholder scan:** no TBD/TODO, no "add appropriate handling" phrasing; all steps show concrete code or exact assertions.

**Type consistency:** `getLastResult()` return type (`{ rows, summary, checkedAt } | null`) and `onResult(result)` signature are consistent across the Interfaces block, acceptance criteria, and Step 3's implementation.
