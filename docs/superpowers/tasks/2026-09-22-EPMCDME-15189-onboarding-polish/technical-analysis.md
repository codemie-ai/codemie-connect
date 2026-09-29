# Technical Research

**Task**: onboarding update-banner css ui shell
**Generated**: 2026-09-22
**Research path**: filesystem

---

## 1. Original Context

Update banners: style .top-banner as a card matching docs/wireframes/01-home.png for CLI
(#update-banner) and app (#app-update-banner) update notifications in ui/index.html; add
heading, reassurance line, action button, dismiss control; support both banners stacking and
independent per-session dismissal via sessionStorage; keep disabled-button styling during
wizard run (data-busy on #update-banner while setInstallRunning is active); add a test
asserting .top-banner is defined in CSS. Ticket EPMCDME-15189.

Known findings (already confirmed by the user, do not re-derive, just verify current line
numbers/content and build on them):
- .top-banner is not defined in ui/styles.css or ui/codemie-tokens.css.
- Markup is in ui/index.html around lines 35-46: two divs, #update-banner (CLI update) and
  #app-update-banner (app update), both start with a hidden state.
- The two checks are independent; both can show at once, each dismissible on its own via
  sessionStorage keys update-banner-dismissed and app-update-banner-dismissed — logic in
  ui/renderer.js around lines 390-425.
- setInstallRunning in ui/renderer.js around lines 179-186 disables the CLI banner's buttons
  while the old wizard runs and sets data-busy on #update-banner.
- docs/wireframes/01-home.png shows the target: a wide card, heading, the line "Your profile,
  settings and agents are kept.", and an "Update and restart" button.
- No tests currently exist for either banner.
- Home's checklist and agent list (separate feature) must not be touched.
- Frontend is bundled at build time from ui/ into the Rust/Tauri app — note the exact build
  command so it can be rerun before manual checks.

---

## 2. Codebase Findings

### Existing Implementations

- `ui/index.html:34-46` — the two banner divs, both `class="top-banner hidden"`:
  - `#update-banner` (CLI update): inline `<span>` text ("Update available: X → Y"),
    `#update-banner-run` button ("Update CLI"), `#update-banner-dismiss` button ("✕").
  - `#app-update-banner` (app update): inline `<span>` text, `#app-update-banner-run` button
    ("Update app"), `#app-update-banner-dismiss` button ("✕").
  - Both sit between `#identity-bar` (line 15) and `#shell-body` (line 49) — i.e. shell-level
    chrome, not inside any view.
- `ui/renderer.js` — banner behavior, confirmed at these lines:
  - `setInstallRunning(on)` (176-186): sets `#app-sidebar[data-busy]`, sets
    `#update-banner.dataset.busy`, and disables `update-banner-run` /
    `update-banner-dismiss` while `on` is true. Comment at 179-181 explains the banner is
    "shell chrome" that stays visible during a run, so its controls need a visible-disabled
    guard rather than being hidden.
  - `setVersionBadge()` (388-391), `showUpdateBanner()` (393-400),
    `hideUpdateBanner()` (404-407), `dismissUpdateBanner()` (409-416) — CLI banner state
    machine. `showUpdateBanner` early-returns if `sessionStorage['update-banner-dismissed']
    === '1'`. `dismissUpdateBanner` sets that key then hides.
  - `showAppUpdateBanner(latestVersion)` (418-424), `hideAppUpdateBanner()` (426-428),
    `dismissAppUpdateBanner()` (430-433) — app banner state machine, same
    session-scoped-dismiss shape with key `app-update-banner-dismissed`.
  - `setUpdateProgress(state, label, icon)` (588-595) and `runUpdateCli()` (597-626) —
    drives `#update-banner-run`'s `dataset.state`/text/disabled during the actual CLI
    self-update (`invoke('run_self_update')`), independent of `setInstallRunning`.
  - `runUpdateApp()` (630-664) — drives `#app-update-banner-run` text/disabled through
    download/install/restart (`bridge.updater.downloadAndInstall`, `.restartApp()`), and on
    error appends a `.update-error` span into the banner (line 653-660) — this is dynamically
    created markup with no existing CSS class defined for it either.
  - `boot()` (666+) wires all four click handlers (710-725), each guarded with
    `if (installRunning) return;` before calling the banner's own action/dismiss function.
- `ui/styles.css` — no `.top-banner`, `.update-error`, or any banner-specific rule exists
  (confirmed via grep for `banner` across both CSS files: no matches). The file does not
  reference `#update-banner` or `#app-update-banner` by ID either.
- Nearby CSS patterns to model a card on (`ui/styles.css`):
  - `.home-cards` (327): `display: grid; grid-template-columns: 1fr 1fr; gap: 14px; max-width:
    760px;`
  - `.home-card` (328-336): the closest existing "card" — border, radius, padding, background
    via tokens; has state variants `.home-card-good/-warn/-bad` (338-340) and a
    `.home-card-head`/`.home-card-title`/`.home-card-badge`/`.home-card-line`/
    `.home-card-note` sub-structure (341-355).
  - `.btn` (458), `.btn-accent` (469), `.btn-success` (471), `.btn-ghost` (762) — button
    variants already defined; `.btn:disabled` (475) sets `opacity: 0.5; cursor: default;
    filter: none;`.
  - `#app-sidebar[data-busy="1"]` (180): `{ pointer-events: none; opacity: 0.4; }` — the only
    existing `[data-busy]` attribute-selector rule in the file; nothing currently selects
    `#update-banner[data-busy]`.
  - `.hidden { display: none !important; }` (44) — the class both banners start with.
- `ui/codemie-tokens.css` — design-token source (colors, radii, spacing, shadows) all
  `--*` custom properties; `.home-card` and `.btn` above already consume these tokens, so a
  `.top-banner` card would follow the same token references rather than hardcoded values.

### Architecture and Layers Affected

- **Frontend-brain, thin Rust backend (Option B)** per `.ai-run/guides/architecture/architecture.md`.
  This task is entirely in the frontend layer:
  - **Markup**: `ui/index.html` (banner divs — heading/reassurance line/button/dismiss
    structure needs to be added inside the existing divs).
  - **Styling**: `ui/styles.css` (new `.top-banner` rules) and possibly `ui/codemie-tokens.css`
    if new tokens are needed (existing tokens likely suffice given `.home-card` precedent).
  - **Behavior**: `ui/renderer.js` (banner show/hide/dismiss/busy functions already exist and
    are unlikely to need logic changes — the task is styling plus a test, not new state
    machine behavior. `data-busy` is already set; it just has no CSS rule consuming it yet).
  - No Rust/`src-tauri` changes are implicated — this is a pure UI-layer task in the "frontend
    reused from Electron app" sense described in the architecture guide.

### Integration Points

- `runUpdateCli()` → `invoke('run_self_update')` (Tauri IPC, via `runner-bridge.js` pattern
  described in the architecture guide) — CLI self-update, unaffected by this task.
- `runUpdateApp()` → `bridge.updater.downloadAndInstall(...)` / `.restartApp()` — app
  self-update via `ui/app-updater-utils.mjs` (present in `ui/`, has its own test
  `app-updater-utils.test.mjs`) — unaffected by this task.
- `sessionStorage` — browser Web Storage API, used directly in `renderer.js` (no wrapper
  module) for both dismiss keys.
- `setInstallRunning` is called from the old wizard's engine event handling (`fatal`/`complete`
  cases around lines 143/151) and from line 822 — confirms the CLI banner's busy state is tied
  to the legacy wizard run, separate from Home's own checklist (which the task says must not be
  touched).

### Patterns and Conventions

- Card components follow a head/title/badge/line/note sub-structure (see `.home-card-*` above)
  — a reasonable model to mirror for `.top-banner`'s heading/reassurance-line/button shape,
  though the task does not mandate reusing these exact class names.
- Buttons use shared `.btn` + a variant modifier class (`.btn-accent`, `.btn-success`,
  `.btn-ghost`) rather than one-off button styles.
- Disabled/busy states are expressed via `[data-busy="1"]` attribute selectors (`#app-sidebar`)
  and via `.btn:disabled` for buttons — both attribute-driven, no `!important` overrides seen
  except on `.hidden`.
- CSS values are pulled from `ui/codemie-tokens.css` custom properties (`var(--radius-md)`,
  `var(--muted)`, `var(--accent)`, etc.) throughout `styles.css`, not hardcoded.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — confirms Option B (frontend-brain, thin Rust
  backend), component responsibility table, and that `ui/` is bundled by the Tauri build (see
  Section 5 build command).
- `.ai-run/guides/testing/testing-patterns.md` — JS tests: `node --test` runner,
  `ui/test/<module>.test.mjs` naming, `node:assert/strict`, no test framework dependency. No
  existing pattern for CSS-file assertions (see Section 4).
- `.ai-run/guides/quality-gates.md` — gate order: `cargo fmt --check` → `cargo clippy -- -D
  warnings` → `npm test` (JS, skip if no UI logic changed — this task changes UI, so it
  applies) → `cargo test` → build. Confirms `npm test` runs from repo root; Rust commands run
  from `src-tauri/`.
- `docs/wireframes/01-home.png` — steady-state Home panel (top right quadrant of the image)
  shows the target banner shape: a full-width card with heading "CodeMie 0.14.2 is available",
  a body line "Your profile, settings and agents are kept.", and a right-aligned accent button
  "Update and restart". No dismiss control is visible in this particular wireframe crop, and no
  second/stacked banner state is depicted — the wireframe documents one banner's steady-state
  card only; stacking, dismiss-icon placement and the app-update banner's copy are not covered
  by it and are left to implementation judgment per the ticket text.

### Architectural Decisions

- Inline comments in `renderer.js` function as informal ADRs:
  - Lines 179-181: the banner is deliberately kept visible (not hidden) during a wizard run,
    with disabled controls, "because a guard the user cannot see reads as a broken button."
  - Lines 385-387: the version badge and the banner are deliberately decoupled — dismissing the
    banner must not clear the badge.
  - Lines 402-403, 413-416: hiding on success is explicitly not the same code path as
    dismissing (the dismissed-sessionStorage key must only be set by an explicit dismiss).
  - Lines 419-421: app-update banner sessionStorage is per-app-session (cleared on restart) by
    design, distinct from the backend's own 24h throttle on the check itself
    (`codemie.app.lastUpdateCheck` in localStorage).

### Derived Conventions

- No guide covers CSS/styling conventions directly; conventions were derived from
  `ui/styles.css` itself (token-based values, `.btn` + variant modifier pattern, card
  sub-structure classes) as described in Section 2.

---

## 4. Testing Landscape

### Existing Coverage

- No test file references `#update-banner`, `#app-update-banner`, `top-banner`, or
  `styles.css` anywhere under `ui/test/` (confirmed via grep — zero matches, and zero test
  files reference `.css` at all).
- Closest adjacent coverage: `ui/test/app-updater-utils.test.mjs` tests the update-download
  helper module (`ui/app-updater-utils.mjs`) that `runUpdateApp()` calls into, but not the
  banner DOM/CSS itself.
- `renderer.js` itself (where all banner show/hide/dismiss logic lives) has no dedicated
  `renderer.test.mjs` in the `ui/test/` listing — its logic is presumably exercised indirectly
  or not unit-tested at this granularity.

### Testing Framework and Patterns

- `node:test` + `node:assert/strict`, no external framework (per testing-patterns.md and
  confirmed by `ui/test/*.test.mjs` file list: 30 files, e.g. `engine.test.mjs`,
  `home-view.test.mjs`, `shell-nav.test.mjs`, `models.test.mjs`).
- Run via `npm test` (repo root) → `node --test ui/test/*.test.mjs` (from `package.json`
  scripts), or a single file via `node --test ui/test/<file>.test.mjs`.
- No existing test reads a CSS file's raw contents; a test asserting `.top-banner is defined in
  CSS` has no precedent in this codebase to follow for file-reading style, only the general
  `node:test`/`node:assert` convention to follow (e.g. `fs.readFileSync` + a regex/substring
  check would fit the file's ES-module, no-framework style, but this is left to spec/plan, not
  asserted as fact here).

### Coverage Gaps

- Zero tests currently touch either banner's markup, CSS, or `renderer.js` show/hide/dismiss
  functions — this is a full coverage gap the task's new test will partially close (styling
  assertion only, per the ticket's stated scope).

---

## 5. Configuration and Environment

### Environment Variables

- No banner- or CSS-specific environment variables found. `CODEMIE_SMOKE` / `CODEMIE_DEV`
  (referenced in `renderer.js` `boot()`) gate dev-only exposure of `window.__codemie` and are
  unrelated to the banners.

### Configuration Files

- No dedicated config file governs banner content or styling; text and version numbers are
  set at runtime in `renderer.js` from `invoke('check_codemie_version')` and the app updater
  bridge, not from a config file.

### Feature Flags and Deployment Concerns

- No feature flag gates the banners.
- **Build/bundling**: the frontend in `ui/` is bundled into the Tauri app at build time. Exact
  commands (from `README.md` and `.ai-run/guides/quality-gates.md`):
  - One-time per checkout/worktree: `scripts/stage-runtime.sh` (macOS) — stages the bundled
    Node runtime; without it, `cargo tauri build` aborts with `resource path ... doesn't
    exist`.
  - Full verified build: `./build-installer.sh` (macOS) — stages, asserts every artifact,
    builds, then asserts the produced bundle; prints the app and DMG paths. This is the command
    to rerun before manual checks of the banner's visual appearance in the packaged app.
  - Lighter option for UI-only changes (verifies nothing extra): `cd src-tauri && CI=true
    cargo tauri build`.

---

## 6. Risk Indicators

- No precedent for a "CSS-defined" test in this codebase — Speculative: the new test will need
  to read `ui/styles.css` as text (e.g. via `fs.readFileSync` + a selector regex) since no
  DOM/CSSOM test harness exists in `ui/test/`; this is a small but genuinely new test pattern,
  not a copy of an existing one.
- The wireframe (`01-home.png`) shows only one banner's steady-state card, not the two-banner
  stacked state, not a visible dismiss control on that card, and not the CLI-banner's specific
  copy ("Update available: X → Y") in card form — matching it will require interpretation
  beyond what the image directly shows.
- `runUpdateApp()`'s error path (renderer.js:653-660) dynamically injects a `.update-error`
  span into `#app-update-banner` with no existing CSS rule — restyling the banner as a card
  risks this error text appearing unstyled/misplaced if not accounted for.
- `setUpdateProgress()` (588-595) toggles `#update-banner-run`'s `dataset.state` and label
  independently of `setInstallRunning`'s `data-busy` — two separate busy/disabled mechanisms
  touch the same button; new CSS must not silently conflict between `[data-busy]` and
  `[data-state]` styling.
- Zero existing tests touch `renderer.js` banner functions directly, so a regression in
  show/hide/dismiss/stacking behavior while restyling would not be caught by anything except
  the one new CSS-presence test the ticket asks for.

---

## 7. Summary for Complexity Assessment

This task is confined to the frontend layer of a Tauri app with a frontend-brain architecture:
markup in `ui/index.html` (two existing banner `<div>`s needing internal structure), new CSS
rules in `ui/styles.css` (a `.top-banner` card style with no current definition, verified absent
from both `ui/styles.css` and `ui/codemie-tokens.css`), and very likely no change to
`ui/renderer.js`'s existing show/hide/dismiss/busy logic, which already implements independent
per-session sessionStorage dismissal (`update-banner-dismissed`, `app-update-banner-dismissed`)
and the `data-busy` flag on `#update-banner` during `setInstallRunning`. The main design work is
translating the `01-home.png` wireframe card (heading, reassurance line, accent button) into CSS
that fits both banners and their independent/stacked visibility, consistent with the existing
`.home-card` token-based styling pattern already in the file.

Technical novelty is low for markup/CSS (a clear existing card pattern to model from) but
non-trivial for the requested test: no test in `ui/test/` currently reads or asserts against
`ui/styles.css` content, so the "assert .top-banner is defined in CSS" test establishes a new,
small testing pattern rather than extending one. Test coverage for the banners overall is
currently zero — no test touches `#update-banner`, `#app-update-banner`, or any of
`renderer.js`'s six banner-related functions — so this task adds the first coverage in the area
without a regression safety net for the JS logic itself (only the CSS-presence assertion is in
scope).

Key risks: the wireframe only depicts one banner's steady-state, not stacking or dismiss-icon
placement, leaving some visual decisions to implementation judgment; the dynamically-injected
`.update-error` span in the app-update banner has no current styling and could look broken
inside a restyled card if not handled; and two independent per-button disabled mechanisms
(`data-busy` from `setInstallRunning`, `data-state`/`disabled` from `setUpdateProgress`) both
target `#update-banner-run`, so new CSS needs to account for both without conflict. Manual
verification requires a full `./build-installer.sh` run (or the lighter `cargo tauri build` for
UI-only checks) since the frontend is bundled into the packaged app.

---

## 8. External References

- `docs/wireframes/01-home.png` (named directly by the task as the visual target) — resolved,
  read in full. The steady-state panel (top-right quadrant) shows the target banner shape: a
  full-width card with heading "CodeMie 0.14.2 is available", body line "Your profile, settings
  and agents are kept.", and a right-aligned accent-styled button "Update and restart" — this
  matches the task's required heading/reassurance-line/action-button structure verbatim. The
  image does not show a dismiss control on this card, does not show two banners stacked, and
  does not show the CLI-banner's own copy ("Update available: X → Y") rendered as a card — those
  aspects are not sourceable from this wireframe.
- `AGENTS.md` named `.ai-run/guides/architecture/architecture.md`,
  `.ai-run/guides/testing/testing-patterns.md`, and `.ai-run/guides/quality-gates.md` as P0/P1
  guides for this task category (Development) — all three resolved and read; their relevant
  content is folded into Sections 2, 3, 4 and 5 above.
