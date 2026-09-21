# Technical Research

**Task**: home screen analytics sidebar entry decision-doc
**Generated**: 2026-09-21
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14589 Home screen is fully built, tested and manually walked. Only the ticket's last
build-order bullet remains: settle the `analytics` grid action.

Required work:
1. In ui/index.html, remove the `hidden` class from `#sidebar-analytics` (currently hidden at
   around line 70). Its click handler already exists in ui/renderer.js around line 819
   (`runAnalytics`), wired to the sidebar nav — confirm this wiring is real and find the exact
   selector/wiring code so the fix is precise.
2. Add a test in ui/test/home-copy.test.mjs, next to the existing nav-visibility test (shell nav
   unhide), asserting: the `#sidebar-analytics` entry in ui/index.html does NOT carry the `hidden`
   class, and its click handler is wired (same pattern as the existing nav test uses for other
   sidebar entries).
3. Write a decision doc at .ai-run/decisions/2026-09-21-EPMCDME-14589-home-grid-actions.md,
   matching the shape of the existing decision doc for the home grid (look for a
   2026-*-EPMCDME-14511*.md or similar decision file about retaining the grid / install-only).
   Record the fate of each of the five original home-grid actions:
     - install-only: retired (already done by EPMCDME-14979 before this ticket; an existing test
       in ui/test/home-copy.test.mjs already asserts it stays gone — find and cite that test)
     - full: survives via the notice modal raised by ensureAuthenticated
     - connect-desktop: survives via the Connections sidebar entry
     - update-cli: survives via the Update CLI button on the update banner
     - analytics: now survives via the newly-unhidden #sidebar-analytics entry (this ticket's change)

Do NOT touch or rework: ui/agents-parse.js, ui/home-state.js, ui/home-view.js, ui/command-log.js,
ui/runner-bridge.js, ui/renderer.js grid removal, the nav/footer unhide — all already done and
tested (316 JS tests passing). This research is scoped ONLY to the analytics sidebar entry fix,
its test, and the decision doc.

---

## 2. Codebase Findings

### Existing Implementations

- `ui/index.html:52-79` — the sidebar (`<nav id="app-sidebar">`). Main group (`sidebar-home`,
  `sidebar-agents`, `sidebar-connections`, `sidebar-health`) is un-hidden. Bottom group holds two
  still-hidden entries: `#sidebar-analytics` (line 70, `class="sidebar-item hidden"`) and
  `#sidebar-about` (line 77, `class="sidebar-item hidden"`).
- `ui/index.html:66-70` — inline comment directly above `#sidebar-analytics` explicitly states:
  *"Hidden, not deleted. A SIDEBAR entry is a new entry point, which EPMCDME-14350 defers. The
  carried-forward grid tile below is a different thing and stays. runAnalytics and this button's
  wiring both still work if the class is removed."* This confirms the fix is class-removal only.
- `ui/renderer.js:819-822` — the click wiring already exists and is live code (not dead/unreached):
  ```js
  document.getElementById('sidebar-analytics').addEventListener('click', () => {
    if (installRunning) return; // hidden today, but restoring it must not restore the gap
    runAnalytics();
  });
  ```
  This sits inside the same top-level `boot()`-time wiring block as `connectBtn`, `restartBtn`,
  `wizardBack`, etc. (lines ~807-838), run unconditionally at startup — it is not gated behind the
  `hidden` class, so unhiding the button alone makes it live with no further JS change.
- `ui/renderer.js:530-549` — `runAnalytics()` itself: version-gates on `cliVersionState.installed`
  (semver `< 0.4.1` shows a notice pointing at Update CLI), otherwise runs
  `codemie analytics --report --open --report-output "$HOME/codemie-analytics.html"` via
  `runAction(...)`. Untouched by this task; only its entry point changes.
- `ui/renderer.js:469-487` — `ensureAuthenticated()`: on a blocked profile state, calls
  `showNotice({..., primaryAction: () => enterWizard()})`. This is the "full" grid action's
  surviving entry point (Setup/wizard flow), reused from the notice modal rather than a grid tile.
- `ui/renderer.js:826-830` — `connectBtn` click handler calls `ensureAuthenticated()` then runs
  `codemie proxy connect desktop`; `connectBtn` lives in the Connections view reached via
  `#sidebar-connections` (`ui/index.html:58`). This is "connect-desktop"'s surviving entry point.
- `ui/renderer.js:552-605` (approx) and `ui/index.html:37` — `#update-banner-run` button, labeled
  "Update CLI", wired to `runUpdateCli()` (`ui/renderer.js:679-682`). This is "update-cli"'s
  surviving entry point.
- `ui/test/home-copy.test.mjs:17-19` — existing test:
  ```js
  test('home: install-only stays gone', () => {
    assert.doesNotMatch(html, /Install only/);
  });
  ```
  This is the citation the decision doc needs for the "install-only: retired" line.
- `ui/test/home-copy.test.mjs:33-37` — companion test asserting `INSTALL_ONLY_IDS`, the
  `'install-only'` string, and "full installation" wording are all gone from `renderer.js`
  (retired by EPMCDME-14979, confirmed via `git log`: commits `45c415d` "Rename Full installation
  to Setup, remove Install only" and `8eb4eef` "drop install-only path and full-installation
  wording in renderer", both merged before this ticket started).

### Architecture and Layers Affected

- **View layer / static markup** — `ui/index.html`, a single class attribute on one `<button>`.
- **No renderer.js change required** — the click handler at `ui/renderer.js:819-822` is already
  present and already registered unconditionally at boot; it does not check `classList.contains
  ('hidden')` before wiring.
- **Test layer** — `ui/test/home-copy.test.mjs`, a new `test(...)` block using the file's existing
  pattern of `readFileSync` + regex assertions against the raw HTML/JS source (no DOM/jsdom used
  anywhere in this file).
- **Documentation layer** — `.ai-run/decisions/`, a new markdown decision doc.

### Integration Points

- `runAnalytics()` shells out to the `codemie` CLI (`codemie analytics --report --open
  --report-output "$HOME/codemie-analytics.html"`) via the `runAction` helper, which in turn uses
  the Tauri bridge (`bridge.runner`, per `ui/renderer.js` bridge wiring elsewhere in the file).
  No changes to this integration are in scope.
- `cliVersionState.installed` (populated during `boot()`, per the comment at `ui/renderer.js:38`)
  gates the version check inside `runAnalytics()` — untouched, but relevant context: the analytics
  entry point's behavior already depends on CLI version state populated elsewhere.

### Patterns and Conventions

- Sidebar entries use `class="sidebar-item"` (+ `hidden` when not yet owned) and, where they route
  to a view, `data-view="<name>"` (e.g. `sidebar-connections` → `data-view="connect"`). Note
  `#sidebar-analytics` has **no** `data-view` attribute — it is not part of the generic
  `#sidebar-main-group .sidebar-item, #sidebar-about` click-routing selector at
  `ui/renderer.js:812` (`showView(btn.dataset.view)`); it has its own dedicated listener instead,
  because clicking it runs an action (`runAnalytics()`) rather than switching views. This is
  intentional per the existing code, not something to change.
- `ui/test/home-copy.test.mjs` conventions: no test runner mocks/DOM — every test is a plain
  `readFileSync` of `ui/index.html` and `ui/renderer.js` into `html`/`renderer` string constants
  at module top, then `assert.match`/`assert.doesNotMatch` regex assertions against those strings.
  A "wiring is real" assertion in this file would follow the same shape: regex-match the
  `getElementById('sidebar-analytics')` + `addEventListener` + `runAnalytics()` sequence in the
  `renderer` string, plus regex-match the absence of `hidden` on the `#sidebar-analytics` button
  in the `html` string. No other test file in `ui/test/` currently asserts sidebar click-wiring
  via regex or DOM simulation — `home-copy.test.mjs`'s own class-visibility test (lines 23-27) is
  the closest existing precedent named in the task, and it also only string-matches raw source.
- `.ai-run/decisions/2026-09-03-EPMCDME-14505-packaging-approach.md` is the only existing file in
  `.ai-run/decisions/` (confirmed via `ls`) and establishes the doc shape used repo-wide: title +
  `**Decision**`/`**Ticket**`/`**Date**`/`**Status**` header block, then a `## Decision` section,
  followed by numbered/lettered `## Part N` sections with evidence tables, and a closing
  `## Follow-ups (out of scope here)` section. There is **no** existing `EPMCDME-14511` decision
  doc in `.ai-run/decisions/` — the task's suggested filename pattern does not exist on disk.

---

## 3. Documentation Findings

### Guides and Architecture Docs

No `.ai-run/guides/` content was read for this scoped task per the routing table in `AGENTS.md`
(architecture/development guides govern code structure, not this one-line visibility flip); the
existing code comments and prior spec/decision documents were sufficient and more directly on
point. `.ai-run/decisions/` contains exactly one prior file (see above), which does **not** cover
the home grid or install-only — despite its filename suggesting packaging, not UI.

The actual source of the "grid stays, five actions" design is
`docs/superpowers/tasks/2026-08-31-epmcdme-14511/spec.md` (the EPMCDME-14511 app-shell-and-
navigation ticket, not a `.ai-run/decisions/` file). Relevant passages:

- Line 4: *"The home grid is kept, so `runAnalytics()` stays on its existing tile and nothing is
  re-homed."*
- Line 19: *"A sidebar analytics entry is likewise hidden: a sidebar entry is a new entry point,
  which the parent defers. Both keep their container, routing and wiring, so one class restores
  each."* (This is the direct textual origin of "one class removal" being the correct, minimal fix
  for this ticket.)
- Line 33 (section heading `## The home grid, and analytics`) and line 34: *"The grid is kept: no
  acceptance criterion requires its removal and Home's content belongs to EPMCDME-14589. So all
  five of its actions — `full`, `install-only`, `connect-desktop`, `update-cli`, `analytics` —
  retain an entry point and nothing is orphaned... EPMCDME-14589 inherits the grid's removal and
  the `install-only` and `analytics` decisions with it."*

This spec.md is EPMCDME-14589's own direct ancestor for the "five actions" framing the task asks
the decision doc to resolve — it is the closest thing to the "EPMCDME-14511 decision file" the
task anticipated, just filed under `docs/superpowers/tasks/` rather than `.ai-run/decisions/`.

### Architectural Decisions

- EPMCDME-14979 (`git log`: `45c415d`, `8eb4eef`) retired `install-only` and "Full installation"
  wording before this ticket began; `home-copy.test.mjs:17-19` and `:33-37` are the tests that pin
  this down.
- EPMCDME-14511's spec (above) is the recorded decision to keep the grid and its five actions
  through the shell/navigation rework, with `analytics` and `about` sidebar entries deliberately
  shipped hidden pending ownership.
- This ticket (EPMCDME-14589) is where `analytics` gets its owner and its sidebar entry is
  restored — the last of the five actions to resolve, per the task's own framing.

### Derived Conventions

- Decision docs in this repo (`.ai-run/decisions/`) are prose-heavy engineering rationale documents
  with evidence tables, not short status logs — see structure notes in Section 2 above. A doc that
  simply lists five outcomes in a table plus short justification, each citing the responsible file/
  line/test, would be consistent in spirit though considerably shorter than the packaging example,
  matching the size of the decision actually being recorded here (a single class removal plus a
  record of who owns each of four other prior line items).

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/home-copy.test.mjs` (44 lines) covers: grid removal, install-only wording removal, shell
  nav/footer visibility (including `#sidebar-about` still hidden), wizard step header copy, dead
  renderer code removal, and mode-label/notice copy — all via `readFileSync` + regex assertion, no
  DOM. It does **not** currently assert anything about `#sidebar-analytics`.
- No test file in `ui/test/` currently exercises `runAnalytics()`'s click wiring or DOM behavior
  directly (confirmed via repo-wide grep for `sidebar-analytics`, `runAnalytics`, and generic
  sidebar `addEventListener` assertions — the only hits are the two `renderer.js` occurrences
  themselves).

### Testing Framework and Patterns

- Framework: Node's built-in `node:test` + `node:assert/strict` (see `package.json:8`:
  `"test": "node --test ui/test/*.test.mjs"`).
- `home-copy.test.mjs` pattern specifically: two module-level `readFileSync` calls building `html`
  and `renderer` string constants, then a flat list of `test('description', () => { assert...
  })` blocks using `assert.match`/`assert.doesNotMatch` with regex literals against those strings.
  No fixtures, mocks, or setup/teardown in this file.

### Coverage Gaps

- Before this task: no test protects `#sidebar-analytics` from staying hidden or from its wiring
  regressing — nothing would fail today if a future edit silently deleted the listener at
  `ui/renderer.js:819-822` or re-added the `hidden` class. This is exactly the gap task item 2
  closes.

---

## 5. Configuration and Environment

### Environment Variables

None specific to the analytics sidebar entry. `runAnalytics()` uses `"$HOME/codemie-analytics.html"`
as a report path (shell-expanded via the pty), unrelated to this task's scope.

### Configuration Files

None relevant — this is a static markup + test + doc change with no config surface.

### Feature Flags and Deployment Concerns

None found. The `hidden` class itself functions as the de facto feature gate for this entry (per
the EPMCDME-14511 spec language: "one class restores each"), not a config-driven flag.

---

## 6. Risk Indicators

- Speculative: the decision doc's suggested filename in the task
  (`2026-*-EPMCDME-14511*.md`) does not exist anywhere in the repo — the actual EPMCDME-14511
  source-of-truth is `docs/superpowers/tasks/2026-08-31-epmcdme-14511/spec.md`, not a
  `.ai-run/decisions/` file. Whoever writes the decision doc should cite that spec.md path rather
  than searching further for a nonexistent decisions file.
- Speculative: `#sidebar-analytics` has no `data-view` attribute and is wired by a bespoke listener
  outside the generic `#sidebar-main-group .sidebar-item, #sidebar-about` selector
  (`ui/renderer.js:812`) — a test asserting "wiring the same way as other sidebar entries" needs to
  account for this structural difference (it is an action button, not a view-router entry) rather
  than assume `data-view`/`showView` involvement.
- Speculative: no existing test in this file exercises DOM click behavior; a new test following the
  file's established convention would need to stay at the regex/string-match level (matching the
  file's own precedent) rather than introduce DOM simulation, to stay consistent with the rest of
  `home-copy.test.mjs`.

---

## 7. Summary for Complexity Assessment

This task touches three files: a one-attribute change in `ui/index.html` (remove `hidden` from
`#sidebar-analytics`, ui/index.html:70), zero changes to `ui/renderer.js` (the click handler at
lines 819-822 is already live and unconditional), a new test block in the existing
`ui/test/home-copy.test.mjs` following that file's established `readFileSync` + regex-assertion
pattern, and a new prose decision doc in `.ai-run/decisions/`. No architectural layers beyond
static markup, an existing test file, and documentation are touched; no service, API, or data layer
is involved.

Technical novelty is low: the fix is explicitly pre-documented as "one class restores each" in the
EPMCDME-14511 spec (`docs/superpowers/tasks/2026-08-31-epmcdme-14511/spec.md:19`), and the wiring,
version-gating, and CLI passthrough behavior of `runAnalytics()` are unchanged and unexercised by
this task. The main research risk was locating the "EPMCDME-14511 decision file" the task
anticipated — it does not exist under that name; the actual source is the spec.md above, and the
decision doc must be written fresh rather than copied from a prior `.ai-run/decisions/` grid/
install-only file, since none exists.

Test coverage posture: `home-copy.test.mjs` currently has zero assertions about
`#sidebar-analytics`, so this is a real, if small, coverage gap being closed rather than a
duplicate. No DOM-simulation test infrastructure exists in this file to extend, so the new test's
"wiring is real" assertion needs to be string/regex-based to match the file's own convention, not a
click-simulation test — worth flagging to whoever writes the plan/spec since it constrains the test
implementation to source-matching rather than behavioral simulation.

---

## 8. External References

None named by the task.
