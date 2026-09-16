# Technical Research

**Task**: ui setup renderer home wizard
**Generated**: 2026-09-14
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14979 — Update CodeMie Desktop setup entry point and setup page copy.

Summary: Replace "Full installation" terminology with "Setup" and remove the separate
"Install only" action from the home/setup entry point. Update the setup steps page title
and header text accordingly.

Acceptance Criteria:
1. The "Install only" action button/section is removed from the UI.
2. The "Full installation" title is changed to "Setup".
3. The description under the renamed "Setup" title is changed to: "Run the setup wizard and Claude engine."
4. When the user clicks Setup, the next page title is "SETUP".
5. The next page title no longer displays "FULL INSTALLATION + SETUP".
6. The "INSTALLATION STEPS" header is changed to "SETUP STEPS".
7. Updated labels are applied consistently — no remaining "full installation" wording anywhere.

Known exact locations (from prior investigation, verify against current code):
- ui/index.html:97 tile-title "Full installation" -> "Setup"
- ui/index.html:98 tile-desc -> "Run the setup wizard and Claude engine." (keep trailing period)
- ui/index.html:100-104 remove entire `data-action="install-only"` button block
- ui/index.html:161 `<div id="step-header">INSTALLATION STEPS</div>` -> "SETUP STEPS"
- ui/renderer.js:207 `modeLabel.textContent = stepIds ? 'Install only' : 'Full installation + setup'` -> set string to 'Setup' (styles.css:394 uppercases it via CSS to display "SETUP")
- Dead code to remove: INSTALL_ONLY_IDS + comment at renderer.js:19-23; `case 'install-only'` at renderer.js:615-616; `stepIds` parameter of `enterWizard` (renderer.js:194, both remaining callers pass null) and its filter on line 195
- renderer.js:343 "Run the full installation / sign in first" and :344 `primaryLabel: 'Run full installation'` -> reword to Setup-consistent copy

Testing: renderer.js can't be imported by node:test (reads window.__TAURI__ at module scope).
Existing pattern to follow is ui/test/shim.test.mjs — read file content as text, assert on strings,
no DOM harness. Need to add ui/test/home-copy.test.mjs following that pattern.

---

## 2. Codebase Findings

### Existing Implementations

- `ui/index.html:91-110` — `#home-grid` > `#installation-group` contains three sub-tiles under `#installation-tiles`:
  - `data-action="full"` tile (lines 95-99): icon 🚀, title "Full installation" (line 97), description "Install Git, Node & the CodeMie CLI, then run the setup wizard and Claude engine." (line 98).
  - `data-action="install-only"` tile (lines 100-104): icon 📦, title "Install only", description "Install Git, Node & the CodeMie CLI — skip the setup wizard."
  - `data-action="update-cli"` tile (lines 105-109), unaffected by this task.
- `ui/index.html:136-164` — `#wizard-view`: `#wizard-topbar` holds `#wizard-mode-label` (line 139, empty at markup time, set from JS); `#step-panel` holds `#step-header` (line 161) with literal text `INSTALLATION STEPS`.
- `ui/renderer.js:19-23` — `INSTALL_ONLY_IDS = ['2.3.3', '2.3.5', '2.4']` with a comment noting acquisition steps (1.x) were already removed with the bundled runtime, so this constant "now equals the full step set" — i.e. the "Install only" tile today runs the *same* steps as "Full installation".
- `ui/renderer.js:89` — `const modeLabel = document.getElementById('wizard-mode-label');`
- `ui/renderer.js:193-209` — `enterWizard(stepIds)`: filters `allSteps` by `stepIds` when truthy (line 195), rebuilds `Engine`, resets wizard button/sprite state, and sets `modeLabel.textContent = stepIds ? 'Install only' : 'Full installation + setup'` (line 207) before `showView('wizard')`.
- `ui/renderer.js:329-350` — `ensureAuthenticated()`: on a blocked auth state, calls `showNotice` with `message` containing "Run the full installation / sign in first, then try again." (line 343), `primaryLabel: 'Run full installation'` (line 344), and `primaryAction: () => enterWizard(null)` (line 345).
- `ui/renderer.js:608-630` — `homeGrid` click delegation switch on `tile.dataset.action`: `'full'` → `enterWizard(null)` (line 613); `'install-only'` → `enterWizard(INSTALL_ONLY_IDS)` (lines 615-616); plus `'connect-desktop'`, `'analytics'`, `'update-cli'` branches, unaffected.
- `enterWizard` has exactly two call sites besides its definition: `renderer.js:345` (`enterWizard(null)`, from the auth-block notice) and `renderer.js:613`/`616` (home tile clicks). After removing the `install-only` case, both remaining callers pass `null` — confirms the ticket's note that the `stepIds` parameter and its filter (line 195) become dead.
- `ui/styles.css:394` — `#wizard-mode-label, .mode-label { ...; text-transform: uppercase; }` — confirms the CSS uppercases whatever text `renderer.js:207` assigns; setting `modeLabel.textContent = 'Setup'` will visually render as "SETUP" without further code changes.
- `ui/styles.css:296` — a second, unrelated `text-transform: uppercase` rule (different selector context; not verified as related to step-header).
- `README.md:19-20,29` — documents the **Full installation** and **Install only** tiles by name in a terminology table and in prose ("The **Full installation** and **Install only** tiles drive a guided wizard that…"). This file is *not* in the ticket's known-locations list but contains the same wording the ticket says must not remain "anywhere."

### Architecture and Layers Affected

- **Frontend view layer only** (per `.ai-run/guides/architecture/architecture.md`): `ui/index.html` (markup/copy) and `ui/renderer.js` (view routing / `enterWizard` / home click delegation). No Rust backend command, no `engine.js` step-orchestration logic, and no `config/steps.yaml` step definitions are implicated — `INSTALL_ONLY_IDS` is a renderer-local filter over steps already loaded elsewhere, not a step-config change.
- No `handlers.js`, `runner-bridge.js`, or Tauri IPC surface is touched; this is pure copy/DOM/JS-literal editing within the "frontend-brain" layer the architecture guide describes.

### Integration Points

- `enterWizard` is renderer-internal; its only external dependencies are `allSteps` (populated during boot from `steps::get_steps()` via Rust, unaffected here) and `Engine` construction (`engine.js`), also unaffected.
- `ensureAuthenticated()` (renderer.js:329-350) is called from the "Connect Claude Desktop" auth-gate flow; its notice copy references "the full installation" and must be kept consistent with whatever the tile is renamed to, since it is a user-facing message pointing back at the same action.
- No CI/CD, deployment manifest, or env-var surface references this wording (see Section 5).

### Patterns and Conventions

- Home tile markup: `<button class="home-tile sub-tile" data-action="...">` containing `.tile-icon`, `.tile-title`, `.tile-desc` children — a consistent per-tile structure repeated for `full`, `install-only`, `update-cli`.
- Click delegation via a single `switch (tile.dataset.action)` block in one listener (`renderer.js:608-630`) rather than per-button listeners — removing the `install-only` case is a straightforward `case` deletion, not a structural change.
- `showNotice({ title, message, primaryLabel, primaryAction })` is a shared modal helper (renderer.js:212-226) used both by `ensureAuthenticated()` and (per comments) other flows; its copy fields are plain string literals inline at the call site, not centralized in a labels/i18n module — there is no string-constants file to update instead of the call sites.
- No i18n/l10n layer exists — all UI strings are literal in `index.html` or JS string literals; this is a plain find-and-replace-style change, not a resource-bundle change.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — confirms `renderer.js` owns "View routing (home/wizard/connect), Engine construction" and lists the DO/DON'T of keeping business logic out of Rust; relevant as confirmation this task stays entirely in the frontend layer.
- `.ai-run/guides/testing/testing-patterns.md` — states JS tests use `node --test` / `node:assert/strict`, files live at `ui/test/<module>.test.mjs`, and lists `engine.test.mjs`/`models.test.mjs` as the reference examples for Engine/model tests specifically (not renderer/copy tests). It does not itself document the "read the file as text and regex/assert on strings" pattern used for markup-only assertions — that pattern is only demonstrated in `ui/test/shim.test.mjs`, which the ticket already points at.
- `.ai-run/guides/development/development-practices.md` — not read in detail for this task; general dev conventions, not consulted here since the change is copy/markup, not new logic.
- `.ai-run/guides/standards/git-workflow.md` — branch naming / commit conventions; relevant only at commit/MR time, not to the research itself.

### Architectural Decisions

- Inline comment at `renderer.js:19-22` records a prior decision (from the bundled-runtime removal, EPMCDME-14505 per `docs/superpowers/tasks/2026-09-02-EPMCDME-14505-.../lens-blind.md`) that `INSTALL_ONLY_IDS` was left equal to the full remaining step set rather than emptied, specifically so the "Install only" tile would "run something rather than an empty list." This is the direct reason the two tiles are functionally identical today, and is background for why removing "Install only" outright (rather than reworking it) is a reasonable simplification.
- `docs/superpowers/tasks/2026-06-11-home-launcher/spec.md` (a prior task's spec, not authoritative for this ticket) originally defined "Full installation + setup" vs. "Install only (no setup)" as the two home actions — the wording this ticket is now retiring.

### Derived Conventions

- String literals for user-facing copy live directly at the point of use (HTML text nodes or JS template/string literals); there is no separate strings/labels module to touch instead.
- CSS handles presentational transforms (e.g., uppercasing) separately from the JS-assigned text content — changing `modeLabel.textContent` to a mixed-case label is sufficient; no CSS change is implied by AC4/AC5.

---

## 4. Testing Landscape

### Existing Coverage

- No existing test currently asserts on the home-tile copy, the `install-only` action, `INSTALL_ONLY_IDS`, `modeLabel` text, or the `step-header` string — none of `ui/test/*.test.mjs` (engine, models, setup-driver, setup-parse, signin, steps-ui, version-utils, auth-gate, pty-bridge, terminal-suspend, shim) reference `index.html` or `renderer.js` markup/copy.
- `ui/test/shim.test.mjs` is the one existing file that reads a non-JS-module artifact as raw text (`assets/windows/bin/codemie.cmd`, `assets/macos/bin/codemie`, `runtime.json`, `src-tauri/tauri.macos.conf.json`, `src-tauri/tauri.conf.json`) and asserts against string content with `assert.match`/`assert.doesNotMatch` — this is the pattern the ticket names as precedent for the new `home-copy.test.mjs`.

### Testing Framework and Patterns

- `node --test ui/test/*.test.mjs` (from `package.json` scripts.test), `node:assert/strict`, no test framework dependency (per `testing-patterns.md`).
- The reason `renderer.js` itself can't be imported by `node:test`: it executes `window.__TAURI__.core` / `window.__TAURI__.event` destructuring at module scope (`renderer.js:16-17`), which throws outside a Tauri webview — confirmed present in the file as read. Any test of `renderer.js` content must therefore either read it as text (the ticket's chosen approach) or stub `window` before import (not attempted elsewhere in the suite for this file).
- `index.html` is plain markup with no build step (per architecture.md: "no bundler") — reading it as text via `readFileSync` and asserting on substrings is consistent with how the app is otherwise built and tested.

### Coverage Gaps

- No test exists today for the home-tile grid copy or structure (`#installation-tiles`, `data-action` values) at all — this is a net-new test file (`ui/test/home-copy.test.mjs`), not an extension of an existing one.
- No test exists for `enterWizard`'s `stepIds` filtering behavior or `modeLabel` text — since `renderer.js` cannot be imported, this logic has apparently never been unit-tested directly; only text-pattern assertions against the file are feasible with the current test setup.
- `README.md`'s terminology table (lines 19-20, 29) is documentation, not tested by any existing suite — a wording drift there would not be caught by `home-copy.test.mjs` unless that file is deliberately pointed at `README.md` too.

### TDD/BDD Conventions

- Test names are plain behavior-describing strings (e.g., `'shim resolves the bundle root relative to its own location'`) rather than `it`/`describe` nesting — `node:test`'s flat `test('description', fn)` form is used throughout.

---

## 5. Configuration and Environment

### Environment Variables

- No environment variable governs this wording or the install-only/full-installation distinction. `CODEMIE_SMOKE` / `CODEMIE_PROBE_SMOKE` (from `architecture.md`) control smoke-test modes unrelated to this copy change.

### Configuration Files

- `config/steps.yaml` defines the actual install steps (`steps::get_steps()`); `INSTALL_ONLY_IDS` in `renderer.js` is a renderer-side subset filter over IDs from that config, not itself config-driven. This task does not touch `config/steps.yaml`.
- No `.env.example`, `appsettings`, or feature-flag file references "install-only" or "full installation."

### Feature Flags and Deployment Concerns

- None found. This is a pure UI-copy/dead-code change with no deployment manifest, Dockerfile, or CI/CD step referencing the affected strings.

---

## 6. Risk Indicators

- `README.md:19-20,29` documents "Full installation" and "Install only" by name and is not in the ticket's known-locations list; AC7 ("no remaining full installation wording anywhere") is ambiguous about whether it covers documentation as well as UI — worth a decision at spec time about whether README.md is in scope.
- `enterWizard`'s `stepIds` parameter and its `.filter(...)` (renderer.js:195) become fully dead once the `install-only` case and `INSTALL_ONLY_IDS` are removed, since both remaining call sites already pass `null` — removing the parameter is a small refactor with two call sites to update; a partial removal (deleting `INSTALL_ONLY_IDS` but leaving the unused parameter) would pass tests but leave dead code the ticket explicitly calls out.
- `renderer.js` cannot be imported by `node:test` (module-scope `window.__TAURI__` access) — the only test strategy available for this file is text-pattern assertion (`shim.test.mjs`-style), which cannot verify runtime behavior (e.g., that `modeLabel.textContent` is actually set to `'Setup'` when the DOM updates) — only that the string literal is present in the source text. This is a structural test-coverage ceiling, not something this ticket can fix in scope.
- `ensureAuthenticated()`'s notice copy (renderer.js:343-344) references "the full installation" / "Run full installation" and is a second, separate user-facing surface tied to the same rename; missing it would leave inconsistent wording reachable from the Connect-Claude-Desktop auth-gate flow, satisfying AC1-AC6 literally but failing AC7's "consistently... anywhere" requirement.
- No existing test coverage exists for any of the touched strings today — the new `home-copy.test.mjs` is 100% net-new coverage, not a modification of an existing spec.

---

## 7. Summary for Complexity Assessment

This task is confined entirely to the frontend view layer described in the architecture guide: `ui/index.html` (markup/copy in the home tile grid and the wizard step-panel header) and `ui/renderer.js` (the `enterWizard` function, the home-tile click-delegation switch, the `ensureAuthenticated()` notice copy, and the module-level `INSTALL_ONLY_IDS` constant with its explanatory comment). No Rust backend command, IPC surface, step-config file, or database/model layer is involved — every change site the ticket names was independently confirmed present in the current code at the stated (or very close to stated) line numbers, and no additional in-scope code sites were found beyond what the ticket's investigation already surfaced, except that `README.md` also documents the retiring terminology and is not currently in the named location list.

Technical novelty is low: this is copy and dead-code removal, not new architecture. The one genuine subtlety is that `enterWizard`'s `stepIds` parameter, once `INSTALL_ONLY_IDS` and its call site are gone, is dead in both remaining callers — a clean implementation removes the parameter and its filter line, not just the constant, matching the ticket's explicit dead-code callout.

Test coverage posture is a real risk factor independent of the change's own simplicity: `renderer.js` cannot be imported under `node:test` because it reads `window.__TAURI__` at module scope, so the only available verification is `shim.test.mjs`-style text-pattern assertion against the raw file contents (confirmed as the sole precedent in the suite) — this proves the strings are present in source but cannot prove runtime behavior (e.g., that the mode label is actually assigned at the right moment). This is a pre-existing structural limitation, not something introduced by this task, but it caps how much confidence any new test (`ui/test/home-copy.test.mjs`) can provide.

---

## 8. External References

None named by the task. The task cites in-repo file:line locations (`ui/index.html`, `ui/renderer.js`, `ui/styles.css`, `ui/test/shim.test.mjs`) as prior investigation to verify against current code — these were re-verified directly against the current repository state in Section 2 and Section 4 rather than treated as an external source of truth.
