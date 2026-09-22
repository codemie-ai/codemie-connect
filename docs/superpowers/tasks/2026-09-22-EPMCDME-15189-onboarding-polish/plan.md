# EPMCDME-15189 Update Banners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Style `#update-banner` and `#app-update-banner` as `.top-banner` cards matching `docs/wireframes/01-home.png`, add a test that fails if `.top-banner` loses its CSS definition, and keep every existing show/hide/dismiss/busy behavior byte-identical.

**Architecture:** Pure frontend-layer change (`ui/index.html`, `ui/styles.css`, minimal `ui/renderer.js` text-setting edits). No Rust/`src-tauri` change. Card visuals follow the existing `.home-card` token-based pattern (`ui/styles.css:328-355`). Disabled-looking buttons are achieved by relying on the native `:disabled` pseudo-class, since both `setInstallRunning` and `setUpdateProgress` ultimately toggle the real `disabled` DOM property on the same buttons — no `[data-busy]` attribute-selector override is needed to avoid conflicts.

**Tech Stack:** Vanilla HTML/CSS/JS, `node:test` + `node:assert/strict` for JS tests, CSS custom properties from `ui/codemie-tokens.css`.

**Spec:** No separate spec doc — requirements are the ticket text (EPMCDME-15189), reproduced in full in the Stage 1 technical analysis: `docs/superpowers/tasks/2026-09-22-epmcdme-15189-onboarding-polish/technical-analysis.md`.

## Global Constraints

- CLI banner's reassurance line must read verbatim: "Your profile, settings and agents are kept."
- `.top-banner` heading format per wireframe: "CodeMie <version> is available".
- Do not touch `ui/renderer.js` banner show/hide/dismiss/busy logic or sessionStorage keys (`update-banner-dismissed`, `app-update-banner-dismissed`) — only the minimal text-setting edits unavoidable from markup restructuring.
- Do not move the banner divs out of their current shell position (`ui/index.html`, between `#identity-bar` and `#shell-body`).
- Out of scope: update-check logic, button actions, Home's checklist/agent list, the Agents screen.
- Commit per task using the repository's existing convention (`EPMCDME-15189 : subject`). Do not push, do not touch the MR description.

## Acceptance criteria

- [ ] `.top-banner` is defined in `ui/styles.css` as a card (padding, background, border, radius via `ui/codemie-tokens.css` tokens), and a test fails if that definition is removed.
- [ ] Each banner shows: a heading ("CodeMie <version> is available"), a reassurance line, an action button, and a dismiss control.
- [ ] The CLI banner's reassurance line is exactly "Your profile, settings and agents are kept." — and a test fails if that wording drifts or is removed.
- [ ] Both banners can show independently, stack visually when both are visible, and each dismisses only itself for the session (sessionStorage keys unchanged).
- [ ] `#update-banner-run` and `#update-banner-dismiss` look visibly disabled while `setInstallRunning(true)` is active, and `#update-banner-run` looks visibly disabled while `setUpdateProgress('updating', ...)` is active — both via the same `:disabled` styling, with no conflict between the two mechanisms.
- [ ] The `.update-error` span injected by `runUpdateApp()`'s error path renders with a sensible inline style, not as broken unstyled text.
- [ ] `npm test` passes and includes the new CSS-presence and markup-structure tests.

---

### Task 1: Restructure banner markup and the renderer.js text it drives

**Files:**
- Modify: `ui/index.html:35-46`
- Modify: `ui/renderer.js:393-400` (`showUpdateBanner`), `ui/renderer.js:651-652` (`runUpdateApp` error-reset label)

**Interfaces:**
- Produces: banner child elements consumed by CSS in Task 2 — `.top-banner-body`, `.top-banner-title`, `.top-banner-line`, `.top-banner-actions`, `.top-banner-action` (on the run buttons), `.top-banner-dismiss` (on the dismiss buttons). IDs `#update-to`, `#app-update-to`, `#update-banner-run`, `#update-banner-dismiss`, `#app-update-banner-run`, `#app-update-banner-dismiss` are unchanged. `#update-from` is removed (no longer displayed — the CLI card's heading only needs the target version).

- [ ] **Step 1: Replace the two banner divs in `ui/index.html:35-46`**

Replace the current two `<div id="update-banner" ...>` / `<div id="app-update-banner" ...>` blocks (`ui/index.html:35-46`) with:

```html
<!-- ============ UPDATE BANNER ============ -->
<div id="update-banner" class="top-banner hidden">
  <div class="top-banner-body">
    <div class="top-banner-title">CodeMie CLI <span id="update-to"></span> is available</div>
    <div class="top-banner-line">Your profile, settings and agents are kept.</div>
  </div>
  <div class="top-banner-actions">
    <button id="update-banner-run" class="btn btn-accent top-banner-action">Update CLI</button>
    <button id="update-banner-dismiss" class="top-banner-dismiss" aria-label="Dismiss">✕</button>
  </div>
</div>

<!-- ============ APP UPDATE BANNER ============ -->
<div id="app-update-banner" class="top-banner hidden">
  <div class="top-banner-body">
    <div class="top-banner-title">CodeMie <span id="app-update-to"></span> is available</div>
    <div class="top-banner-line">Your profile, settings and agents are kept.</div>
  </div>
  <div class="top-banner-actions">
    <button id="app-update-banner-run" class="btn btn-accent top-banner-action">Update and restart</button>
    <button id="app-update-banner-dismiss" class="top-banner-dismiss" aria-label="Dismiss">✕</button>
  </div>
</div>
```

- [ ] **Step 2: Drop the `#update-from` write in `showUpdateBanner` (`ui/renderer.js:393-400`)**

Delete the line `document.getElementById('update-from').textContent = cliVersionState.installed;` (the element no longer exists in the markup). Leave the `#update-to` line and every other line in `showUpdateBanner`, and all of `hideUpdateBanner`/`dismissUpdateBanner`/`showAppUpdateBanner`/`hideAppUpdateBanner`, untouched.

- [ ] **Step 3: Keep the app banner's error-reset label consistent with its new initial text (`ui/renderer.js:651-652`)**

In `runUpdateApp`'s `catch` block, change `bannerRunBtn.textContent = 'Update app';` to `bannerRunBtn.textContent = 'Update and restart';` so the button's label returns to the same text it starts with (Step 1's new initial button text), not the old pre-restructure wording.

- [ ] **Step 4: Run the JS test suite to confirm nothing broke**

Run: `npm test`
Expected: PASS, same count as before this task (no new tests yet — this task is markup/wiring only).

- [ ] **Step 5: Commit**

```bash
git add ui/index.html ui/renderer.js
git commit -m "EPMCDME-15189 : restructure update banner markup into heading/line/actions"
```

---

### Task 2: Add the CSS-presence and markup-structure tests, then the `.top-banner` card styling

**Files:**
- Create: `ui/test/top-banner-style.test.mjs`
- Modify: `ui/styles.css` (new rules, appended after the `.home-card-*` block, `ui/styles.css:355-360`)

**Interfaces:**
- Consumes: the class names produced by Task 1 (`.top-banner`, `.top-banner-body`, `.top-banner-title`, `.top-banner-line`, `.top-banner-actions`, `.top-banner-action`, `.top-banner-dismiss`), and the existing `.btn`/`.btn-accent`/`.btn:disabled` rules at `ui/styles.css:458-475`.
- Test-first: yes — one test is the literal CSS-presence acceptance criterion from the ticket ("A test fails if `.top-banner` loses its definition again"); the other two read `ui/index.html` the way `ui/test/home-copy.test.mjs` already does, so a regression in the CLI banner's verbatim wording or a future flattening of a banner's title/line/actions back into a single span also fails the suite, not just a CSS deletion.

- [ ] **Step 1: Write the failing tests**

Create `ui/test/top-banner-style.test.mjs`, following the file-reading pattern already used in `ui/test/home-copy.test.mjs` (`readFileSync(...)` from the repo root, since `npm test` runs `node --test` from there):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('ui/styles.css', 'utf8');
const html = readFileSync('ui/index.html', 'utf8');

// EPMCDME-15189: .top-banner had no CSS definition at all, so both update
// banners rendered as plain unstyled text. This fails if that regresses.
test('top-banner: .top-banner has a CSS definition', () => {
  assert.match(css, /\.top-banner\s*\{/);
});

test('top-banner: disabled run/dismiss buttons get a visibly-disabled style', () => {
  assert.match(css, /\.top-banner-dismiss:disabled\s*\{/);
});

// EPMCDME-15189: the reassurance line came from the wireframe verbatim and is
// an acceptance criterion in its own right — a CSS check alone won't catch
// someone editing this sentence in the CLI banner's markup.
test('top-banner: CLI banner keeps the verbatim reassurance line', () => {
  const cliBanner = html.slice(
    html.indexOf('<div id="update-banner"'),
    html.indexOf('<div id="app-update-banner"')
  );
  assert.match(cliBanner, /Your profile, settings and agents are kept\./);
});

// EPMCDME-15189: each banner is a title + a line + an actions block, not one
// flat span. Fails if the card structure ever gets collapsed back down.
test('top-banner: each banner has a title, a line and an actions block', () => {
  const cliBanner = html.slice(
    html.indexOf('<div id="update-banner"'),
    html.indexOf('<div id="app-update-banner"')
  );
  const appBanner = html.slice(html.indexOf('<div id="app-update-banner"'));
  for (const banner of [cliBanner, appBanner]) {
    assert.match(banner, /class="top-banner-title"/);
    assert.match(banner, /class="top-banner-line"/);
    assert.match(banner, /class="top-banner-actions"/);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test ui/test/top-banner-style.test.mjs`
Expected: FAIL on all four — no `.top-banner {` / `.top-banner-dismiss:disabled {` in `ui/styles.css` yet, and (before Task 1's markup lands) neither banner has `top-banner-title`/`top-banner-line`/`top-banner-actions` classes. If Task 1 already landed first, the two CSS tests still fail and the two markup tests already pass — either order is fine, this step just confirms the CSS tests are genuinely red.

- [ ] **Step 3: Add the `.top-banner` card rules to `ui/styles.css`**

Append after the `.home-card` block (`ui/styles.css:355-360`), modeling the card look on `.home-card` (`ui/styles.css:328-336`) and the disabled look on `.btn:disabled` (`ui/styles.css:475`):

```css
/* ---- Update banners (EPMCDME-15189) ---- */
.top-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  margin-bottom: 10px;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-xl);
}
.top-banner-title { font-size: 15px; font-weight: 700; color: var(--text); }
.top-banner-line { font-size: 13px; color: var(--muted); margin-top: 4px; }
.top-banner-actions { display: flex; align-items: center; gap: 10px; flex: none; }
.top-banner .btn.top-banner-action { width: auto; padding: 8px 18px; }
.top-banner-dismiss {
  background: none;
  border: none;
  color: var(--dim);
  font-size: 14px;
  cursor: pointer;
  padding: 4px;
}
.top-banner-dismiss:disabled { opacity: 0.5; cursor: default; }
.top-banner .update-error {
  display: block;
  width: 100%;
  margin-top: 8px;
  font-size: 12px;
  color: var(--red);
}
```

This relies on the existing `.btn:disabled` rule (`ui/styles.css:475`) for `.top-banner-action`'s disabled look — both `setInstallRunning` and `setUpdateProgress` set the real `disabled` property on these buttons (`ui/renderer.js:184`, `ui/renderer.js:593`), so one `:disabled` rule covers both mechanisms without conflict. `.top-banner-dismiss` isn't a `.btn`, so it needs its own `:disabled` rule, added above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test ui/test/top-banner-style.test.mjs`
Expected: PASS (all four — the two CSS tests now, the two markup/wording tests once Task 1's markup is in place).

- [ ] **Step 5: Run the full JS suite**

Run: `npm test`
Expected: PASS, count grown by the 4 new tests from this task (377 → 381).

- [ ] **Step 6: Commit**

```bash
git add ui/styles.css ui/test/top-banner-style.test.mjs
git commit -m "EPMCDME-15189 : style .top-banner as a card, cover it with CSS and markup tests"
```

---

## Self-Review

**Spec coverage:**
- Card visuals (heading/line/button/dismiss) matching the wireframe → Task 1 (markup) + Task 2 (CSS).
- CLI reassurance line verbatim → Task 1, Step 1; enforced by Task 2's markup-structure test.
- Banners stack, stay at top of shell, markup position unchanged → Task 1 (position untouched), Task 2 `.top-banner { margin-bottom: 10px }` (stacking gap; flex-column shell context already stacks block-level siblings vertically — no extra positioning rule needed since neither div is taken out of normal flow).
- Independent per-session dismissal, sessionStorage keys — untouched, verified not modified by either task.
- `setInstallRunning`/`setUpdateProgress` disabled-look, no conflict → Task 2 Step 3, relying on the shared `:disabled` pseudo-class.
- `.update-error` styling → Task 2 Step 3.
- CSS-presence test → Task 2 Steps 1-2 (test-first).
- Card structure (title/line/actions, not a flattened span) and CLI wording → Task 2 Steps 1-2, via the two markup-reading tests added on review feedback.
- Out-of-scope items (update-check logic, button actions, Home, Agents) → no task touches them; confirmed by file list (`ui/index.html`, `ui/renderer.js` two surgical lines, `ui/styles.css`, one new test file).

**Negative-constraint pass:**
- "Do not touch ui/renderer.js banner logic beyond what's unavoidable" → Task 1 touches exactly two lines (`#update-from` removal, error-reset label), both forced by the markup change; no show/hide/dismiss/busy function body or sessionStorage key is altered.
- "Do not move markup out of its current shell position" → Task 1 replaces the divs in place at `ui/index.html:35-46`; no task relocates them.
- "Don't let data-busy and setUpdateProgress-disabled conflict" → Task 2 uses one `:disabled` rule fed by both mechanisms rather than two competing attribute-selector rules — nothing can conflict because both write to the same DOM property.
- Non-goals (update-check logic, button behavior, Home's checklist/agent list, Agents screen, moving the banner into Home) → no task's file list touches `ui/home-view.js`, `ui/agents*`, or any Rust/backend file; no task changes what `run_self_update` / `downloadAndInstall` do.
- No whole-suite quality-gate task, no manual/visual-verification task, no commit-format invention beyond the stated `EPMCDME-15189 : subject` convention — confirmed both tasks end at `npm test`/targeted test runs, not `cargo`/build commands.

**Placeholder scan:** none — every step has literal code or an exact command.

**Type/name consistency:** `.top-banner-action` used on both run buttons in Task 1 and referenced in Task 2's CSS; `.top-banner-dismiss` likewise; `#update-to`/`#app-update-to` IDs match between Task 1's markup and the untouched renderer.js reads; `.top-banner-title`/`.top-banner-line`/`.top-banner-actions` classes checked by Task 2's markup-structure test are exactly the classes Task 1's markup produces.
