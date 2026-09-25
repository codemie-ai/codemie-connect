# EPMCDME-15296 — Identity Bar Layout Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `#identity-bar` on one line at narrow widths — text segments truncate with ellipsis instead of wrapping, the version badge and theme toggle stay full-size and pinned right — and show the auth status as clean text instead of the CLI's raw row.

**Architecture:** Pure `ui/` frontend change, no backend/IPC involved. Three edits: a CSS-only truncation fix inside the existing `#identity-bar` rule block (`ui/styles.css`), exporting an existing pure helper (`ui/home-state.js`), and wiring that helper into the one renderer branch that currently writes raw CLI text (`ui/renderer.js`). Tests are plain file-content string assertions (`node:test` + `assert.match`), matching `ui/test/top-banner-style.test.mjs` — there is no DOM harness in this project.

**Tech Stack:** Vanilla ESM JS, plain CSS, Node's built-in `node:test` runner (no bundler, no jsdom).

**Spec:** Requirements are inline (ticket text passed to this plan; no `spec.md` for this task). Technical analysis: `docs/superpowers/tasks/2026-09-25-EPMCDME-15296-header-layout/technical-analysis.md`.

## Global Constraints

- Scope-locked to `ui/styles.css` (`#identity-bar` block, lines 84-122), `ui/home-state.js` (line 29), `ui/renderer.js` (`updateIdentityAuthStatus`, lines 427-441, plus its import line 21). `ui/index.html` only if a hook turns out to be needed.
- Do not restructure the bar's markup or change what data it displays.
- Preserve exactly: the `:empty { display: none; }` hiding rule (line 98), the `span + span::before` middot separator (99-103), the badge's `::before { content: none; }` suppression (114-115), the badge's own `:empty { display: none; }` (116), and the `margin-left: auto` right-alignment handoff between the badge and `#theme-toggle` (104-112, 120-121).
- No Rust/backend change, no new IPC command, no new env vars or config.
- `home-state.test.mjs:49-53` (covers `signedInDetail` indirectly via `deriveHome`) must stay green — its behavior must not change, only its export visibility.
- Commit per task using the repository's existing convention.

---

## Acceptance criteria

- [ ] `#identity-bar` stays on one line at narrow window widths (no wrapping of its spans).
- [ ] The bar's text segments (auth status, product, account, profile, model, project) truncate with an ellipsis when the bar is too narrow to show them in full, instead of overlapping or wrapping.
- [ ] The version badge (`#identity-version-badge`) and the theme toggle (`#theme-toggle`) always render at full size, never truncated, and stay pinned to the bar's right edge.
- [ ] The existing `:empty`-hiding, middot-separator, and badge/theme-toggle `margin-left: auto` handoff rules are unchanged in behavior.
- [ ] The identity bar's auth-status text reads as a clean sentence (e.g. "Authenticated (expires in 23h 51m)") instead of the raw CLI row (e.g. "Auth Status │ ✓ Authenticated (expires in 23h 51m)") when signed in.
- [ ] The `unknown` / `no_profile` / not-signed-in branches of the auth status text are unchanged.
- [ ] `home-state.test.mjs`'s existing coverage of `signedInDetail` (via `deriveHome`) still passes unmodified.

---

### Task 1: Truncate identity-bar text segments with ellipsis, keep badge/toggle full-size

**Files:**
- Modify: `ui/styles.css:84-122` (`#identity-bar` rule block)
- Test: `ui/test/identity-bar-layout.test.mjs` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by later tasks (CSS is independent of Task 2/3's JS change).

**Test-first: yes — new test asserting the CSS rules for nowrap + per-span ellipsis truncation exist, and that the badge/theme-toggle keep no `text-overflow` truncation, fails before the CSS is added.**

- [ ] **Step 1: Write the failing test**

Create `ui/test/identity-bar-layout.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('ui/styles.css', 'utf8');

// EPMCDME-15296: #identity-bar had no flex-wrap, so its spans wrapped inside
// themselves at narrow widths instead of staying on one line.
test('identity-bar: the bar stays on one line instead of wrapping', () => {
  const rule = css.match(/#identity-bar\s*\{[^}]*\}/)[0];
  assert.match(rule, /flex-wrap:\s*nowrap/);
});

// Flex items default to min-width: auto, which blocks shrinking/ellipsis.
// The text segments need min-width: 0 plus overflow/ellipsis to truncate.
test('identity-bar: text segments can shrink and truncate with an ellipsis', () => {
  const rule = css.match(/#identity-auth-status,\s*\n?#identity-product[\s\S]*?\{[^}]*\}/);
  assert.ok(rule, 'a shared or per-selector rule targets the bar\'s text segments');
});

test('identity-bar: a truncation rule sets min-width, overflow and ellipsis together', () => {
  assert.match(css, /overflow:\s*hidden;\s*\n?\s*text-overflow:\s*ellipsis/);
  assert.match(css, /min-width:\s*0/);
});

// The version badge and theme toggle must stay full-size and pinned right —
// they are not part of the truncating text segments.
test('identity-bar: the version badge keeps its own untouched rule, no ellipsis', () => {
  const rule = css.match(/#identity-version-badge\s*\{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /text-overflow/);
  assert.match(rule, /margin-left:\s*auto/);
});

test('identity-bar: existing :empty hiding and separator rules are unchanged', () => {
  assert.match(css, /#identity-bar > span:empty\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /#identity-bar > span \+ span::before\s*\{/);
  assert.match(css, /#identity-bar > #identity-version-badge::before\s*\{\s*content:\s*none;\s*\}/);
  assert.match(css, /#identity-version-badge:empty\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /#identity-bar > #theme-toggle\s*\{\s*margin-left:\s*12px;\s*\}/);
  assert.match(css, /#identity-version-badge:empty \+ #theme-toggle\s*\{\s*margin-left:\s*auto;\s*\}/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/identity-bar-layout.test.mjs`
Expected: FAIL on the `flex-wrap: nowrap` and ellipsis/min-width assertions (the other assertions, which pin pre-existing rules, already pass).

- [ ] **Step 3: Add the truncation CSS**

In `ui/styles.css`, inside the existing `/* ---- Identity bar ---- */` section:
- Add `flex-wrap: nowrap;` to the `#identity-bar` rule (line 84-93).
- Add a rule that gives every direct `span` text segment `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` so each one shrinks and truncates independently instead of wrapping. Scope it to `#identity-bar > span` but exclude `#identity-version-badge` (already selected specifically elsewhere) by placing the version-badge rule after it (CSS cascade) or by using `#identity-bar > span:not(#identity-version-badge)` — either is acceptable as long as the badge test in Step 1 still passes.
- Leave `#identity-version-badge` (104-112), its `::before` suppression (114-115), its `:empty` rule (116), and the `#theme-toggle` margin rules (120-121) exactly as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test ui/test/identity-bar-layout.test.mjs`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

Commit `ui/styles.css` and `ui/test/identity-bar-layout.test.mjs` per the repository's existing commit convention.

---

### Task 2: Export `signedInDetail` from `home-state.js`

**Files:**
- Modify: `ui/home-state.js:29`
- Test: `ui/test/home-state.test.mjs` (existing file — add one assertion, do not touch the existing signed-in-detail coverage at lines 49-53)

**Interfaces:**
- Consumes: nothing.
- Produces: `export const signedInDetail: (detail: string | undefined) => string` — a named export other modules can import, e.g. `import { signedInDetail } from './home-state.js'`. Consumed by Task 3.

**Test-first: yes — a new assertion that imports `signedInDetail` directly from `home-state.js` fails while the symbol is still module-private.**

- [ ] **Step 1: Write the failing test**

Add to `ui/test/home-state.test.mjs` (alongside its existing imports/tests):

```js
import { signedInDetail } from '../home-state.js';

// EPMCDME-15296: the identity bar needs this same cleaning function the
// checklist already uses, so it must be importable directly.
test('signedInDetail is exported for reuse outside deriveHome', () => {
  assert.equal(signedInDetail('Auth Status │ ✓ Authenticated (expires in 23h 51m)'), 'Authenticated (expires in 23h 51m)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/home-state.test.mjs`
Expected: FAIL — `signedInDetail` is `undefined` (not exported), so the import binds nothing and the assertion throws.

- [ ] **Step 3: Export the function**

In `ui/home-state.js:29`, change:
`const signedInDetail = (detail) => ...`
to:
`export const signedInDetail = (detail) => ...`

No other change — the function body, its two call sites (`signInItem` at line 37, and `deriveHome`'s indirect coverage) are untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test ui/test/home-state.test.mjs`
Expected: PASS, including the pre-existing assertions at lines 49-53 (unchanged behavior).

- [ ] **Step 5: Commit**

Commit `ui/home-state.js` and `ui/test/home-state.test.mjs` per the repository's existing commit convention.

---

### Task 3: Use `signedInDetail` in `updateIdentityAuthStatus`'s signed-in branch

**Files:**
- Modify: `ui/renderer.js:21` (import line), `ui/renderer.js:427-441` (`updateIdentityAuthStatus`)
- Test: `ui/test/identity-bar-layout.test.mjs` (append to the file created in Task 1)

**Interfaces:**
- Consumes: `signedInDetail` from `ui/home-state.js` (Task 2's export).
- Produces: nothing consumed by later tasks.

**Test-first: yes — a source-assertion test that `updateIdentityAuthStatus`'s signed_in branch calls `signedInDetail(...)` rather than writing raw `st.detail` fails before the renderer change.**

- [ ] **Step 1: Write the failing test**

Append to `ui/test/identity-bar-layout.test.mjs`:

```js
const rendererJs = readFileSync('ui/renderer.js', 'utf8');

// EPMCDME-15296: the signed_in branch wrote st.detail verbatim, so the bar
// showed the CLI's raw "Auth Status │ ✓ ..." row instead of clean text.
test('identity-bar: updateIdentityAuthStatus cleans st.detail via signedInDetail', () => {
  const fn = rendererJs.slice(
    rendererJs.indexOf('function updateIdentityAuthStatus'),
    rendererJs.indexOf('\n}', rendererJs.indexOf('function updateIdentityAuthStatus'))
  );
  assert.match(fn, /signedInDetail\(st\.detail\)/);
  assert.doesNotMatch(fn, /el\.textContent = st\.detail \|\| 'Signed in';/);
});

test('identity-bar: renderer.js imports signedInDetail from home-state.js', () => {
  assert.match(rendererJs, /import \{[^}]*signedInDetail[^}]*\} from '\.\/home-state\.js'/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/test/identity-bar-layout.test.mjs`
Expected: FAIL on both new assertions — `signedInDetail` is not yet imported or called in `renderer.js`.

- [ ] **Step 3: Wire in `signedInDetail`**

In `ui/renderer.js:21`, add `signedInDetail` to the existing import:
`import { deriveHome, signInAction, autoHealthCheck, signedInDetail } from './home-state.js';`

In `ui/renderer.js:431` (inside `updateIdentityAuthStatus`'s `signed_in` branch), change:
`el.textContent = st.detail || 'Signed in';`
to:
`el.textContent = signedInDetail(st.detail);`

(`signedInDetail` already falls back to `'Signed in'` when `detail` is falsy, so behavior for an empty/missing detail is unchanged.) Leave the `unknown` / `no_profile` / default branches (432-438) exactly as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test ui/test/identity-bar-layout.test.mjs ui/test/home-state.test.mjs`
Expected: PASS, all tests across both files.

- [ ] **Step 5: Commit**

Commit `ui/renderer.js` and `ui/test/identity-bar-layout.test.mjs` per the repository's existing commit convention.

---

## Notes on TDD depth

Task 1 is pure CSS: the failing assertions pin the presence of specific declarations (`flex-wrap: nowrap`, `overflow: hidden`, `text-overflow: ellipsis`, `min-width: 0`) rather than exercising real layout behavior — there is no DOM harness in this project to measure actual rendered truncation. TDD here is nominal (it drives *which lines* get written, not a behavioral proof), which is why acceptance criteria 1-3 also route through the wireframe comparison the calling flow's verification stage performs separately, outside this plan. Tasks 2 and 3 are genuine behavioral TDD: both assert on real function behavior (`signedInDetail`'s output string, `updateIdentityAuthStatus`'s call site) that a wrong implementation would visibly fail.

## Negative-constraint pass

- "do not restructure the bar or change what it shows" — Task 1 only adds `flex-wrap`/`min-width`/`overflow`/`text-overflow` declarations to the existing `#identity-bar` block; no selector is removed, no markup changes. Tasks 2-3 change only how the auth-status *text* is derived, not what data source feeds it.
- "Do not break the existing :empty hiding rules, the middot separator, or the badge's margin-left:auto / :empty handoff" — Task 1's Step 5 test explicitly re-asserts all six of these rules are still present verbatim; Task 1's new truncation rule is scoped to exclude `#identity-version-badge`.
- "Do not change its [signedInDetail's] behavior" — Task 2 changes only the `const` → `export const` keyword; the function body is untouched, and the pre-existing `home-state.test.mjs:49-53` coverage runs unmodified in Task 2's Step 4 to confirm this.
- "Other branches (unknown/no_profile/default) already write clean literal strings — leave them unchanged" — Task 3's Step 3 touches only line 431 (the `signed_in` branch); lines 432-438 are untouched, and Task 3's test only inspects the `signed_in` line, not the other branches.
- "any Rust/backend change, any new IPC command" — no task touches `src-tauri/` or adds an `invoke`/bridge call; all three tasks are confined to `ui/styles.css`, `ui/home-state.js`, `ui/renderer.js`, and their tests.
- "no markup restructuring expected" (index.html) — no task modifies `ui/index.html`; the CSS truncation in Task 1 targets existing selectors only.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/tasks/2026-09-25-EPMCDME-15296-header-layout/plan.md`. Execution mode (subagent-driven vs. inline) is the calling flow's decision, not this plan's.
