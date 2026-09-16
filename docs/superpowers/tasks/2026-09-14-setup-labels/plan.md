# Setup Labels (EPMCDME-14979) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the "Full installation" home entry point to "Setup", remove the redundant "Install only" action, and retitle the wizard's step-panel header — with no "full installation" wording left anywhere in the UI.

**Architecture:** Pure frontend-view-layer change confined to `ui/index.html` (markup/copy) and `ui/renderer.js` (mode-label string, dead-code removal, notice copy). No Rust, IPC, or step-config changes.

**Tech Stack:** Vanilla JS renderer, `node --test` / `node:assert/strict`, text-pattern assertions against raw file contents (no DOM harness — `renderer.js` reads `window.__TAURI__` at module scope and cannot be imported by node:test).

**Spec:** Inline requirements below (no spec.md for this task); see also `technical-analysis.md` in this task directory for verified file:line detail.

## Acceptance criteria

- [ ] AC1: The "Install only" action button/section is removed from the UI.
- [ ] AC2: The "Full installation" title is changed to "Setup".
- [ ] AC3: The description under "Setup" reads "Run the setup wizard and Claude engine." (trailing period kept).
- [ ] AC4: Clicking Setup shows the next page title as "SETUP".
- [ ] AC5: The next page title no longer shows "FULL INSTALLATION + SETUP".
- [ ] AC6: The "INSTALLATION STEPS" header reads "SETUP STEPS".
- [ ] AC7: No remaining "full installation" wording anywhere in the UI (README.md explicitly out of scope).

## Global Constraints

- Out of scope: `README.md`, any Rust/backend code, any IPC/step-config, `.codegraph/`, `docs/codemie/`, `.codemie/codemie-cli.config.json`.
- No DOM harness for `renderer.js` — text-pattern assertions only, following `ui/test/shim.test.mjs`.
- Commit per task using the repository's existing convention.

---

### Task 1: Add failing home-copy test coverage

**Files:**
- Create: `ui/test/home-copy.test.mjs`
- Read (unmodified in this task): `ui/index.html`, `ui/renderer.js`

**Interfaces:**
- Produces: a `node:test` file readable via `node --test ui/test/*.test.mjs` from repo root, asserting on raw text of `ui/index.html` and `ui/renderer.js` (both read with `readFileSync(..., 'utf8')`, paths relative to repo root — matches `shim.test.mjs`'s convention).

Test-first: yes — every assertion in this task targets current (pre-change) source and must fail before Task 2/3 land the changes.

- [ ] **Step 1: Write the test file**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('ui/index.html', 'utf8');
const renderer = readFileSync('ui/renderer.js', 'utf8');

test('home tile: Setup title and description replace Full installation', () => {
  assert.match(html, /<div class="tile-title">Setup<\/div>/);
  assert.match(html, /<div class="tile-desc">Run the setup wizard and Claude engine\.<\/div>/);
});

test('home tile: Install only action is removed', () => {
  assert.doesNotMatch(html, /data-action="install-only"/);
  assert.doesNotMatch(html, /Install only/);
});

test('wizard: step header reads SETUP STEPS', () => {
  assert.match(html, /<div id="step-header">SETUP STEPS<\/div>/);
});

test('renderer: install-only dead code and full-installation wording are gone', () => {
  assert.doesNotMatch(renderer, /INSTALL_ONLY_IDS/);
  assert.doesNotMatch(renderer, /'install-only'/);
  assert.doesNotMatch(renderer, /full installation/i);
});

test('renderer: mode label and auth notice use Setup-consistent copy', () => {
  assert.match(renderer, /modeLabel\.textContent = 'Setup'/);
  assert.match(renderer, /Run setup \/ sign in first/);
  assert.match(renderer, /primaryLabel: 'Run setup'/);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test ui/test/home-copy.test.mjs` (from repo root)
Expected: all 5 tests FAIL against current source (tile-title still "Full installation", `install-only` still present, header still "INSTALLATION STEPS", `INSTALL_ONLY_IDS`/`'install-only'`/"full installation" still present, mode-label/notice copy unchanged).

- [ ] **Step 3: Commit**

Commit the new (failing) test file using the repository's existing commit convention.

---

### Task 2: Update `ui/index.html` copy and remove the Install-only tile

**Files:**
- Modify: `ui/index.html:97-104`, `ui/index.html:161`
- Test: `ui/test/home-copy.test.mjs` (from Task 1, unmodified)

**Interfaces:**
- Consumes: nothing new.
- Produces: markup satisfying AC1, AC2, AC3, AC6 — the three home-copy/HTML tests from Task 1 turn GREEN.

Test-first: no — this task exists to satisfy assertions already written and RED in Task 1; there is no further test to write here.

- [ ] **Step 1: Edit the "full" tile (`ui/index.html:97-98`)**

Change line 97's text from `Full installation` to `Setup`. Change line 98's text to `Run the setup wizard and Claude engine.` (keep the surrounding `<div class="tile-desc">...</div>` wrapper).

- [ ] **Step 2: Remove the Install-only tile (`ui/index.html:100-104`)**

Delete the entire `<button class="home-tile sub-tile" data-action="install-only">...</button>` block (5 lines), leaving the `update-cli` tile as the next sibling of the renamed `full` tile.

- [ ] **Step 3: Update the step-panel header (`ui/index.html:161`)**

Change `<div id="step-header">INSTALLATION STEPS</div>` to `<div id="step-header">SETUP STEPS</div>`.

- [ ] **Step 4: Run the test and confirm the HTML assertions pass**

Run: `node --test ui/test/home-copy.test.mjs`
Expected: `home tile: Setup title...`, `home tile: Install only action is removed`, and `wizard: step header reads SETUP STEPS` PASS. The two `renderer:` tests still FAIL (expected — Task 3 covers them).

- [ ] **Step 5: Commit**

Commit `ui/index.html` using the repository's existing commit convention.

---

### Task 3: Update `ui/renderer.js` — mode label, dead code, and notice copy

**Files:**
- Modify: `ui/renderer.js:19-23` (delete), `ui/renderer.js:194-195`, `ui/renderer.js:207`, `ui/renderer.js:329-345`, `ui/renderer.js:611-617`
- Test: `ui/test/home-copy.test.mjs` (from Task 1, unmodified)

**Interfaces:**
- Consumes: `enterWizard` currently declared as `function enterWizard(stepIds)` (renderer.js:194); both call sites already pass `null` once `install-only` is removed.
- Produces: `function enterWizard()` (no parameter), `modeLabel.textContent = 'Setup'` (renderer.js:207 equivalent), `homeGrid` switch with no `'install-only'` case, `ensureAuthenticated()` notice copy using "Run setup / sign in first" and `primaryLabel: 'Run setup'`.

Test-first: no — same rationale as Task 2; this task turns the two remaining RED tests from Task 1 GREEN and is the last content change.

- [ ] **Step 1: Remove `INSTALL_ONLY_IDS` and its comment (`ui/renderer.js:19-23`)**

Delete the comment block and the `const INSTALL_ONLY_IDS = [...]` line entirely.

- [ ] **Step 2: Drop the `stepIds` parameter and its filter (`ui/renderer.js:194-195`)**

Change `function enterWizard(stepIds) {` to `function enterWizard() {`. Replace the `const steps = stepIds ? allSteps.filter(...) : allSteps;` line with `const steps = allSteps;`.

- [ ] **Step 3: Set the mode label to a plain "Setup" string (`ui/renderer.js:207`)**

Change `modeLabel.textContent = stepIds ? 'Install only' : 'Full installation + setup';` to `modeLabel.textContent = 'Setup';` (CSS at `ui/styles.css:394` already uppercases this element, rendering "SETUP" — satisfies AC4/AC5).

- [ ] **Step 4: Update the two remaining `enterWizard` call sites (`ui/renderer.js:613`, `ui/renderer.js:616` before deletion)**

`enterWizard(null)` at the `'full'` case becomes `enterWizard()`. Delete the `case 'install-only': enterWizard(INSTALL_ONLY_IDS); break;` branch entirely (2 lines) from the `homeGrid` click-delegation switch.

- [ ] **Step 5: Reword the auth-block notice copy (`ui/renderer.js:343-345`)**

Change the message fragment `Run the full installation / sign in first, then try again.` to `Run setup / sign in first, then try again.`. Change `primaryLabel: 'Run full installation',` to `primaryLabel: 'Run setup',`. Change `primaryAction: () => enterWizard(null),` to `primaryAction: () => enterWizard(),`.

- [ ] **Step 6: Run the full test file and confirm all 5 tests pass (GREEN)**

Run: `node --test ui/test/home-copy.test.mjs`
Expected: all 5 tests PASS.

- [ ] **Step 7: Mutation-verify**

Temporarily re-add the string `Install only` to `ui/index.html` (e.g. inside a comment or a tile-title). Re-run `node --test ui/test/home-copy.test.mjs` and confirm exactly the `home tile: Install only action is removed` test fails. Revert the temporary edit and re-run to confirm all 5 tests pass again.

- [ ] **Step 8: Commit**

Commit `ui/renderer.js` using the repository's existing commit convention.

---

## Negative-constraint pass

- "Install only" must be removed, not merely relabeled: Task 2 Step 2 deletes the entire button block (not a rename); Task 3 Steps 1, 4 remove `INSTALL_ONLY_IDS` and the `'install-only'` switch case. Task 1's test asserts absence of both `data-action="install-only"` and the text "Install only".
- No "full installation" wording anywhere in the UI (AC7): Task 3 Steps 3 and 5 cover both remaining occurrences (`renderer.js:207` mode label, `renderer.js:343-344` notice copy) in addition to the HTML occurrence removed in Task 2. Task 1's test asserts `/full installation/i` is absent from `renderer.js` (case-insensitive, catching "Full installation" and "full installation" both).
- Must not build a DOM harness for `renderer.js` (explicit constraint): Task 1 uses `readFileSync` + string assertions only, matching `ui/test/shim.test.mjs`; no `jsdom`/`happy-dom`/window stubbing is introduced anywhere in this plan.
- README.md, Rust/backend, IPC/step-config, `.codegraph/`, `docs/codemie/`, `.codemie/codemie-cli.config.json` are out of scope: no task in this plan touches any of them; `config/steps.yaml` and `allSteps` (Rust-sourced) are read but never modified.
- No task duplicates the calling flow's own quality-gate, review, or commit-artifact stages — every task above is implementation-only with its own `Test-first` line.
