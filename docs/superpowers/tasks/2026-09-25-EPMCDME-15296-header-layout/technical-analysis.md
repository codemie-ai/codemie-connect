# Technical Research

**Task**: header identity-bar renderer ui-layout
**Generated**: 2026-09-25T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15296 — header layout fix in CodeMie Connect desktop app.

Full ticket:
Summary: The header layout in the CodeMie Connect desktop application is broken.
Description: Header elements such as authentication status, user email, SSO/LLM labels,
version/update indicator, and theme controls appear visually cramped and misaligned.
Acceptance Criteria: header elements aligned per expected layout; content readable, no overlap;
auth status, email, SSO/LLM labels, version/update info, theme controls remain visible and usable;
verified against wireframe; no visual regression elsewhere.

Known findings from prior investigation (verify, don't re-derive from scratch):
- Header is #identity-bar. Markup in ui/index.html (identity-* spans, version badge, theme toggle).
  Styles in ui/styles.css around lines 84-122. Currently a flex row with no `flex-wrap: nowrap`, no
  min-width/overflow handling, no text-overflow ellipsis anywhere — causes spans to wrap/cramp at
  narrow widths.
- updateIdentityAuthStatus in ui/renderer.js writes st.detail as-is, which is the CLI's raw row
  e.g. "Auth Status │ ✓ Authenticated (expires in 23h 51m)".
- ui/home-state.js has a function called signedInDetail that already cleans this same kind of
  string for Home's checklist, but it is not currently exported.
- Wireframe reference: docs/wireframes/01-home.png, top-right panel "Steady state" — header shown
  as one line: email · profile · model · project on left, "0.14.2 available" badge on right.
- Expected smallest fix: keep the bar on one line (no wrap), truncate text segments with ellipsis
  instead of wrapping, keep the version badge and theme toggle at full size on the right, and reuse
  signedInDetail (export it) for the auth text instead of writing a second cleaner.

Please verify all of the above against actual code (exact line numbers, function signatures,
export syntax used in this file, existing test patterns for ui/renderer.js and ui/home-state.js),
and identify any existing tests covering #identity-bar or home-state.js's cleaning functions.

---

## 2. Codebase Findings

### Existing Implementations

- `ui/index.html:15-31` — `#identity-bar` markup. Contains, in order: `#identity-auth-status`
  (span, initial text "Checking sign-in…"), `#identity-product`, `#identity-account`,
  `#identity-profile`, `#identity-model`, `#identity-project`, `#identity-version-badge`, then a
  `#theme-toggle` `<label class="switch-wrapper">` with sun/moon icons and a checkbox input. A
  comment at `index.html:17-18` notes the spans are "filled from
  ~/.codemie/codemie-cli.config.json at run time" and that CSS hides an empty span.
- `ui/styles.css:83-122` — `#identity-bar` block. Confirmed as reported:
  - `#identity-bar` (84-93): `display: flex; align-items: center; gap: 6px; padding: 10px 16px;`
    plus background/border/color/font-size. **No `flex-wrap`, no `min-width: 0`/`overflow` handling
    on the bar or its children, no `text-overflow: ellipsis` anywhere in this block.**
  - `#identity-auth-status, #identity-product` (94-95): bold/full-text color.
  - `#identity-bar > span:empty { display: none; }` (98) — empty segment hiding.
  - `#identity-bar > span + span::before { content: "·"; margin-right: 6px; color: var(--dim); }`
    (99-103) — middot separator between adjacent non-empty spans.
  - `#identity-version-badge` (104-112): `margin-left: auto;` plus pill styling (amber border,
    rounded, padding, small bold font). This is what pushes the badge to the bar's right edge.
  - `#identity-bar > #identity-version-badge::before { content: none; }` (114-115) — badge must not
    carry a leading middot; needs two ids to outrank the general separator rule above it.
  - `#identity-version-badge:empty { display: none; }` (116).
  - `#identity-bar > #theme-toggle { margin-left: 12px; }` (120) and
    `#identity-version-badge:empty + #theme-toggle { margin-left: auto; }` (121) — when the badge
    is empty (no update available) the toggle inherits the "push right" job via `margin-left: auto`
    on itself instead.
- `ui/renderer.js:387-399` — `renderIdentity(cfg)`. Sets `identity-product` (shows "CodeMie
  Desktop" only when `cfg.state` is not `'valid'`/`'broken'`, otherwise empty), `identity-account`
  (`cfg.account`), `identity-profile` (`cfg.profile`), `identity-model` (`cfg.model`),
  `identity-project` (`cfg.project`) via a local `set(id, text)` helper that writes
  `textContent = text || ''`. Called from `renderIdentity` invocations at lines 415 and 868-869 (on
  boot and after config reads).
- `ui/renderer.js:427-441` — `function updateIdentityAuthStatus(st)`. Confirmed: not exported
  (plain top-level function declaration, module-private). Body:
  ```js
  function updateIdentityAuthStatus(st) {
    const el = document.getElementById('identity-auth-status');
    if (!el) return;
    if (st.state === 'signed_in') {
      el.textContent = st.detail || 'Signed in';
    } else if (st.state === 'unknown') {
      el.textContent = 'Auth status unknown';
    } else if (st.state === 'no_profile') {
      el.textContent = 'No profile';
    } else {
      el.textContent = 'Not signed in';
    }
    home.auth = st;
    renderHome();
  }
  ```
  Confirmed: on the `signed_in` branch it writes `st.detail` verbatim (e.g. the CLI's raw
  `"Auth Status │ ✓ Authenticated (expires in 23h 51m)"`), with no cleaning. Called at
  `renderer.js:422` (inside `refreshIdentityOnComplete`, doc comment at 403-407), `renderer.js:650`,
  and `renderer.js:861/863` (profile-status poll / not-signed-in fallback).
- `ui/home-state.js:26-29` — comment block plus:
  ```js
  const signedInDetail = (detail) => (detail || '').replace(/^Auth Status\s*[|│]\s*/, '').replace(/^✓\s*/, '').trim() || 'Signed in';
  ```
  Confirmed: declared with `const`, **no `export` keyword** — module-private, unlike the file's
  other public members (see below). Used once, at `home-state.js:37`, inside `signInItem` for the
  Home checklist's "signed in" subtitle.
- `ui/home-state.js` export surface (grep of `^export`): `HOME_ITEMS` (16), `BUILTIN_AGENT_COMMAND`
  (58), `autoHealthCheck` (139), `signInAction` (150), `deriveHome` (159). All use the
  `export const NAME = ...` / `export function NAME(...)` form directly on the declaration — no
  separate `export { ... }` block at the file's end. Adding `export` to the `signedInDetail`
  declaration on line 29 would match this convention exactly.
- `ui/renderer.js:21` — `import { deriveHome, signInAction, autoHealthCheck } from './home-state.js';`
  — confirms the named-import style `updateIdentityAuthStatus` would use to pull in
  `signedInDetail` once exported.

### Architecture and Layers Affected

Per `.ai-run/guides/architecture/architecture.md`, this project is "Frontend-brain + thin Rust
backend (Option B)": vanilla JS ESM, no bundler, no framework. This task is entirely inside the
`ui/` frontend layer — no Rust/`src-tauri` involvement:
- **View markup**: `ui/index.html` (`#identity-bar` and children).
- **Styling**: `ui/styles.css` (`#identity-bar` block, lines 83-122).
- **View logic / IPC consumer**: `ui/renderer.js` (`renderIdentity`, `updateIdentityAuthStatus`,
  `refreshIdentityOnComplete`, `setVersionBadge`).
- **Pure state/derivation layer**: `ui/home-state.js` (`signedInDetail`, `deriveHome`, etc.) —
  explicitly documented at the top of the file as "Pure: no DOM, no Tauri."

### Integration Points

- `renderIdentity` is fed by `bridge.codemieConfig.read()` (reads
  `~/.codemie/codemie-cli.config.json` via the Rust backend) — not part of this task's surface but
  the source of `cfg.account`/`profile`/`model`/`project`.
- `updateIdentityAuthStatus` is fed by `bridge.inspector.checkProfileStatus()`, which returns the
  `ProfileStatus` shape (`{ state, detail }`) also consumed by `home-state.js`'s `signInItem` — the
  two call sites are already reading the same upstream string, which is why the ticket's proposed
  fix (share `signedInDetail`) is a de-duplication rather than a new parser.
- `cliVersionState` / `setVersionBadge()` (`renderer.js:447-450`) populate
  `#identity-version-badge`; unrelated to layout logic but shares the same bar and its CSS rules
  (114-121) for spacing.

### Patterns and Conventions

- CSS visibility-by-emptiness pattern: `span:empty { display: none; }` combined with an adjacent
  `::before` separator (`span + span::before { content: "·" }`) is the established way this bar
  hides absent segments — any layout fix should preserve this pattern rather than replace it.
- `home-state.js` keeps all string-cleaning/derivation pure and exported for reuse across the
  checklist and (per this ticket) the identity bar; `renderer.js` keeps DOM-writing thin (`set`
  helper, `textContent` assignment) and imports pure helpers from `home-state.js` rather than
  duplicating logic — matches the existing `import { deriveHome, signInAction, autoHealthCheck }`
  line.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — describes the frontend-brain/thin-Rust split and
  component responsibilities; confirms this task is pure `ui/` work, no `src-tauri` changes and no
  new Tauri command needed.
- `.ai-run/guides/testing/testing-patterns.md` — JS tests use Node's built-in `node:test` +
  `node:assert/strict`, one `*.test.mjs` file per module under `ui/test/`, named with plain
  behavior-describing strings. No framework dependency (no jsdom/testing-library mentioned or
  observed in `package.json`).
- No guide specifically covers header/identity-bar layout; `.ai-run/guides/development/` and
  `.ai-run/guides/standards/git-workflow.md` were listed in `AGENTS.md` but not read in depth here
  since they are process/dev-practice guides not specific to this layout change.

### Architectural Decisions

- `.ai-run/decisions/` contains no entry for EPMCDME-15296. Adjacent decisions exist for other
  Home-area tickets (`2026-09-21-EPMCDME-14589-home-grid-actions.md`,
  `2026-09-22-EPMCDME-15189-*`, `2026-09-23-EPMCDME-14513-add-or-update.md`) but none address the
  identity bar's CSS layout or `signedInDetail`'s visibility.
- Inline comments at `home-state.js:26-28` record the reasoning for the existing cleaning regex
  (CLI emits `"Auth Status │ ✓ Authenticated (expires in 22h 9m)"`; the checklist keeps only
  `"Authenticated (expires in 22h 9m)"`) — this is the authoritative description of what
  `signedInDetail` does and why, useful context for the identity-bar reuse.
- Inline comments at `renderer.js:383-386` and `index.html:17-18` record that the identity bar's
  values come from the CLI config reader at runtime and that empty segments are intentional,
  real states (not bugs) — relevant so a layout fix does not "fix" the empty-hiding behavior by
  mistake.
- No inline `NOTE:`/`HACK:`/`ADR:`/`DECISION:` markers found in `ui/renderer.js`, `ui/styles.css`,
  or `ui/home-state.js` via grep.

### Derived Conventions

- CSS is organized in commented sections (`/* ---- Identity bar (full-width top bar) ---- */`,
  `/* ---- Sidebar nav ... ---- */`) — a layout fix should stay within the existing
  "Identity bar" section rather than scattering rules elsewhere in `styles.css` (927 lines total).
- Comments in this codebase consistently explain *why* a rule/line exists (see the badge/middot
  double-id comment at `styles.css:113-114`), not just what it does — matches the file's broader
  documentation style.

---

## 4. Testing Landscape

### Existing Coverage

- No test file references `#identity-bar`, `identity-auth-status`, `identity-version-badge`, or
  `signedInDetail` (confirmed via grep across `ui/test/*.mjs`).
- `ui/test/home-state.test.mjs:7,49-53` tests `deriveHome`'s Home-checklist subtitle for the
  signed-in case, asserting the "Auth Status │/|" prefix is stripped — this exercises
  `signedInDetail` indirectly (through `deriveHome` → `signInItem`), not directly, and does not
  touch the identity bar.
- `ui/test/top-banner-style.test.mjs` is the closest existing precedent for testing this task's
  surface: it `readFileSync`s `ui/styles.css`, `ui/index.html`, and `ui/renderer.js` as plain
  strings and asserts with `assert.match`/`assert.doesNotMatch` against regexes (e.g.
  `assert.match(css, /\.top-banner\s*\{/)`), with no DOM/jsdom involved. It also carries a header
  comment tying each test back to its ticket (`// EPMCDME-15189: ...`), a convention worth
  following for identity-bar tests.

### Testing Framework and Patterns

- Framework: Node's built-in `node:test` runner, `node:assert/strict`. Run via `npm test` →
  `node --test ui/test/*.test.mjs` (`package.json:8`).
- No jsdom or browser-DOM test harness present in `package.json` dependencies (project has no
  `dependencies`/`devDependencies` block visible in the first 60 lines — pure ESM, no bundler,
  consistent with the architecture guide). CSS/HTML/JS-source assertions (regex on file contents,
  as in `top-banner-style.test.mjs`) are therefore the established way to test styling/markup
  changes here, not rendered-DOM assertions.
- `home-state.test.mjs` tests the pure `home-state.js` functions directly by import and plain
  object arguments — no mocking framework needed since the module has no DOM/Tauri dependencies.

### Coverage Gaps

- No existing test asserts anything about `#identity-bar`'s CSS (flex-wrap, overflow, ellipsis,
  spacing) — this is a full gap the task will need to fill if tests are added.
- No existing test asserts that `updateIdentityAuthStatus` cleans/uses `signedInDetail` for the
  bar's auth text — only the Home-checklist path is covered.
- No existing test exercises `signedInDetail` as an exported, directly-imported function (it isn't
  exported yet).

---

## 5. Configuration and Environment

### Environment Variables

- No environment variables specific to the identity bar, header layout, or `home-state.js` were
  found. The architecture guide lists `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` as smoke-mode
  toggles for the app generally (`lib.rs` startup), unrelated to this task's UI-only scope.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` is the runtime data source for `renderIdentity`'s segments
  (per inline comments in `index.html` and `renderer.js`), read via the Rust backend and exposed as
  `bridge.codemieConfig.read()`. Not itself a layout concern.
- `ui/styles.css` and `ui/index.html` are the two files that define the bar's structure/appearance
  and are the primary edit surface for this ticket.

### Feature Flags and Deployment Concerns

- None found specific to the identity bar or this task. No feature flag gates the header's
  rendering.

---

## 6. Risk Indicators

- The identity bar's CSS (`styles.css:84-93`) has no `flex-wrap: nowrap`, no `min-width: 0`, no
  `overflow: hidden`/`text-overflow: ellipsis` on the text spans — confirmed absent, matching the
  ticket's stated root cause. Any fix must interact carefully with the existing `:empty` /
  `+ span::before` separator rules (98-103) and the badge's `margin-left: auto` push-right/its
  `:empty` fallback onto `#theme-toggle` (104-121) — these are three interlocking selectors, and a
  naive `overflow: hidden` on `#identity-bar` or its spans could clip the separators or the badge's
  border/pill shape if not scoped precisely to each span's text.
- Speculative: truncating each span individually with `text-overflow: ellipsis` requires each span
  to become a flex item with `min-width: 0` (flex items default to `min-width: auto`, which
  prevents shrinking/ellipsis from taking effect) — this is a common CSS pitfall the implementer
  should be aware of, not a confirmed finding from the code.
- `updateIdentityAuthStatus` (renderer.js:427) writes `st.detail` raw into `#identity-auth-status`
  in the `signed_in` branch; this is confirmed and is the only branch affected by reusing
  `signedInDetail` (the `unknown`/`no_profile`/default branches already write their own short
  strings and are unaffected).
- `signedInDetail` (home-state.js:29) is not exported; exporting it is a one-token change
  (`const` → `export const`) consistent with the file's existing export style, but the function is
  also used by `deriveHome`/`signInItem` for the Home checklist — any behavior change to
  `signedInDetail` itself (not just exporting it) would affect both call sites, so a shared-fix
  change needs to keep the regex's current behavior for the checklist untouched, or update the
  checklist test (`home-state.test.mjs:49-53`) to match.
- Zero existing tests target `#identity-bar` layout or the identity-bar auth text specifically;
  `top-banner-style.test.mjs` is the only structurally similar precedent (regex assertions over
  read file contents of `styles.css`/`index.html`/`renderer.js`), and following it means writing
  new tests rather than extending existing ones.
- No `.ai-run/decisions/` entry exists yet for this ticket; if the implementation makes a
  non-obvious layout call (e.g. which segments get ellipsis vs. which stay full-width), that would
  be a candidate for a new decision file, following the pattern of the other 2026-09 decision docs
  in that directory — this is process observation, not a requirement.
- The wireframe (`docs/wireframes/01-home.png`, steady-state top-right panel) shows the bar as a
  single line: `n_levyankov@epam.com · default · Sonnet 5 · EPM-CDME` on the left with a
  `0.14.2 available` amber pill badge on the right — confirmed visually, matching the ticket's
  description of the target layout (email/profile/model/project left, version badge right). It
  does not show a separate visible "auth status" segment distinct from the email in this state,
  which is worth reconciling against the ticket's acceptance criterion that "auth status" remain
  visible — the current DOM always renders `#identity-auth-status` as the first span, ahead of
  `#identity-product`/`#identity-account`, so the ordering in the wireframe (email first) differs
  from the current DOM order. This is an observation, not a resolved requirement.

---

## 7. Summary for Complexity Assessment

This task is confined entirely to the `ui/` frontend layer of a vanilla-JS, no-bundler Tauri app: three files are in scope — `ui/styles.css` (the `#identity-bar` rule block, lines 83-122), `ui/index.html` (the bar's markup, lines 15-31), and `ui/renderer.js` (`updateIdentityAuthStatus`, lines 427-441, plus its `import` line). A fourth file, `ui/home-state.js`, needs a one-token change (exporting `signedInDetail`, line 29) to let `renderer.js` reuse it instead of writing raw CLI text. No backend/Rust changes, no new IPC commands, and no config/env-var changes are implicated — this is a pure styling-plus-small-refactor change.

Technical novelty is low: the fix follows patterns already present in the codebase (CSS `:empty`-based visibility, `margin-left: auto` right-alignment, named exports from `home-state.js` reused by `renderer.js`). The main risk is CSS mechanics — the interlocking `:empty`/`::before`-separator/badge-push-right rules mean naive `overflow`/`ellipsis` additions could visually break the separator or badge if not scoped per-span, and flex items need explicit `min-width: 0` for ellipsis to take effect, a common but easy-to-miss CSS detail.

Test coverage for this exact surface is a full gap: no test currently touches `#identity-bar`, `identity-auth-status`, or `signedInDetail`. The closest precedent, `top-banner-style.test.mjs`, tests CSS/HTML/JS as plain file-content strings via `node:test`/`assert.match` with no DOM framework — the same pattern should be followed for new tests here. One existing test, `home-state.test.mjs:49-53`, indirectly covers `signedInDetail`'s stripping behavior through `deriveHome` and must stay green since the ticket's fix shares that same function with the identity bar.

---

## 8. External References

- `docs/wireframes/01-home.png` — named by the task as the layout reference. Resolved and read.
  The "STEADY STATE" panel (top-right) shows the header as one line:
  `n_levyankov@epam.com · default · Sonnet 5 · EPM-CDME` on the left, and an amber pill badge
  `0.14.2 available` pinned to the right edge, with no visible wrapping or overlap. The "FIRST RUN"
  panel (top-left) shows the unconfigured state as just `CodeMie Desktop` on the left and a plain
  version number (`0.14.1`, no pill, no badge) on the right — consistent with
  `renderIdentity`'s handling of the non-`valid`/`broken` config state
  (`renderer.js:392`) and `setVersionBadge`'s empty-string case when no update is available
  (`renderer.js:447-450`). No auth-status segment is visually distinguishable from the email/account
  segment in either panel — the wireframe does not show a separate "Checking sign-in…" or
  "Authenticated (expires in Nh Nm)" text distinct from the account email, which the implementer
  should reconcile against the DOM's current separate `#identity-auth-status` span (see Section 6).
