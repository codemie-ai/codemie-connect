# CodeMie Theme + Light/Dark Toggle + Corner Gradient — Design

**Date:** 2026-06-11
**Status:** Draft for review
**Area:** Frontend (`ui/`) styling + theme system; one Tauri config touch

## Goal

Re-skin the installer onto the **CodeMie design-system tokens** (from
`/Users/Vadym_Vlasenko/AI/projects/style-guide`), add a **light/dark theme toggle**
(dark default, remembered across launches), and add a **bottom-left radial purple
glow** matching the real CodeMie app. Applies to the whole app — every view and overlay
shares one consistent palette.

## Decisions (confirmed)

| Decision | Choice |
|---|---|
| Scope | **Whole app** — home, wizard, connect, log panel, terminal/notice/fatal overlays |
| Theme behavior | **Dark default, persisted** via `localStorage['cm-theme']` |
| Toggle UI | **Top-right** floating switch (CodeMie `switch` component + sun/moon icons) |
| Gradient | **Bottom-left radial purple glow**, app-wide, fixed to the window, behind content |
| Fonts | **System font stack** (Inter-if-installed → `-apple-system`). No bundled fonts, no remote `@import` |

## Architecture

Three layers, smallest-possible surface:

1. **Token layer — `ui/codemie-tokens.css`** (new): a faithful copy of the style guide's
   `tokens.css`, with the Google-Fonts `@import` line **removed** (CSP blocks it; see
   Constraints). Provides all `--color-*`, `--gradient-*`, `--font-*`, `--radius-*`,
   `--space-*`, `--shadow-*` tokens. Dark via `:root` / `:root.dark`; light via `.light`.

2. **Theme bootstrap — `ui/theme-init.js`** (new): a tiny **classic, render-blocking**
   script (`<script src>` in `<head>`, *not* `type=module`, *not* `defer`) that runs before
   the body paints. Reads `localStorage['cm-theme']` (default `'dark'`) and sets
   `document.documentElement.className` to `dark` or `light`. This prevents a flash for
   light-mode users. It also exposes `window.__cmSetTheme(next)` to apply + persist a theme.

3. **Toggle wiring — in `theme-init.js` (DOM-ready handler)**: finds `#theme-toggle`,
   reflects current state, and on change calls the apply+persist path. Kept out of
   `renderer.js` so it works regardless of which view is active and has no coupling to the
   wizard/engine lifecycle.

`ui/styles.css` is **rewritten to consume CodeMie tokens** instead of its current custom
palette. Class names and layout are preserved — this is a re-skin, not a re-layout.

### Load order in `index.html` `<head>`
```html
<script src="theme-init.js"></script>   <!-- classic, render-blocking: sets <html> class -->
<link rel="stylesheet" href="vendor/xterm.css" />
<link rel="stylesheet" href="codemie-tokens.css" />
<link rel="stylesheet" href="styles.css" />
```

## Components

### Theme toggle (markup, fixed top-right)
Reuses the CodeMie `switch` pattern, with sun (☀) and moon (☾) glyphs flanking the track.
A single floating control, `position: fixed; top/right`, `z-index: 45` (below overlays at
100, so modals cover it). One instance serves all views.

```html
<label id="theme-toggle" class="switch-wrapper" title="Toggle light / dark">
  <span class="theme-ico theme-ico-sun">☀</span>
  <input type="checkbox" id="theme-toggle-input" />
  <span class="switch-track"><span class="switch-knob"></span></span>
  <span class="theme-ico theme-ico-moon">☾</span>
</label>
```
Switch CSS is ported from the style guide's `forms.css` (`.switch-wrapper / .switch-track /
.switch-knob`), driven by `--gradient-switch-off` / `--gradient-switch-on` tokens.
Convention: **checked = dark**, unchecked = light (knob/icon emphasis follows state).

### Bottom-left gradient glow
A `body::before` pseudo-element: `position: fixed; inset: 0; pointer-events: none; z-index: 0`,
painted with a radial gradient anchored at the bottom-left corner using CodeMie purple/magenta
hues (`#9E00FF` / `#EC56FF` / `#672D92` family, low alpha). `#app` gets `position: relative;
z-index: 1` so all content sits above the glow. Opacity is a **CSS variable
(`--cm-glow-opacity`)** set per theme — softer in light mode — so it is tunable after first
render. This glow is a reconstruction (the style guide defines `--gradient-purple-radial`
as "radial purple for hero sections" but never applies a page glow; the real value lives in
the inaccessible `codemie-ui-next`), so exact position/spread/opacity will be **verified by
screenshotting both themes and iterated with the user**, not frozen in this spec.

## Token mapping (custom palette → CodeMie tokens)

The current `:root` block (lines 3–20) is deleted; every reference resolves to a CodeMie
token. Complete map including stray literals found by audit:

| Current | CodeMie token | Used by |
|---|---|---|
| `--bg #0b0d14` | `--color-bg-page` | body |
| `--panel #0d1117` | `--color-bg-card` | step panel |
| `--panel-dark #0a0c12` | `--color-bg-sidebar` | sprite panel, top bars, log bar/panel |
| `--surface #161b22` | `--color-bg-card` | tiles, connect actions, modals |
| `--surface-2 #1c2128` | `--color-bg-hover` | hover/active states |
| `--border #21242f` | `--color-border-primary` | dividers, borders |
| `--border-2 #21262d` | `--color-border-primary` | tile/modal borders |
| `--accent #8b5cf6` | `--color-purple` / `--gradient-primary-btn` | primary buttons, accents |
| `--accent-hover #7c3aed` | (gradient hover / `--color-bg-btn-primary-h`) | button hover |
| `--accent-blue #58a6ff` | `--color-info-text` / `--color-text-link` | back links, active step title |
| `--violet #a78bfa` | `--color-purple` | tile titles, sprite label, headings |
| `--muted #6e7681` | `--color-text-muted` | secondary text |
| `--dim #484f58` | `--color-text-tertiary` / `--color-icon-tertiary` | labels, status dot idle |
| `--text #c9d1d9` | `--color-text-primary` | body text |
| `--green #3fb950` | `--color-success-text` | success stamps |
| `--green-btn #238636` | `--color-success` | success/approve buttons |
| `#2ea043` (L186) | (success hover; `--color-success` + filter or `--status-success-border`) | success btn hover |
| `--amber #d29922` | `--color-warning-text` | warnings, ignore button |
| `--red #ff6b6b` | `--color-error-text` | fatal title |
| `#080a10` (L145, L261) | `--color-bg-nav` | footers |
| `#13151f` (L164) | `--color-bg-secondary` | status pill bg |
| `#1a3350` (L213) | `--color-info-bg` | step-progress fill |
| `#0a0c12` (L276) | `--color-bg-elevated` (dark) / card | terminal card bg |
| `#ff7b72` (L253) | `--color-error-text` | log-stderr |
| `#e3b341` (L257) | `--color-warning-text` | log-prompt |
| `#7ee787` (L258) | `--color-success-text` | log-approved / log-success |
| `#fff` (L178, L225) | `--color-text-inverse` | button label text |
| `rgba(3,5,10,0.82)` (L267) | overlay backdrop — `rgba(0,0,0,.7)` (theme-stable scrim) | `.overlay` |
| `rgba(0,0,0,0.38/0.35)` | `--shadow-lg` / `--shadow-md` | hover shadows |

Primary action buttons (`.btn-accent`) adopt the CodeMie **gradient fill**
(`--gradient-primary-btn`, purple→blue) to match the real "primary CTA / magical" treatment.

## Data flow

- **Startup:** `theme-init.js` (head, blocking) → reads localStorage → sets `<html>` class →
  CSS resolves correct token set → first paint is already correct.
- **Toggle:** user clicks `#theme-toggle` → handler flips `<html>` class, writes
  `localStorage['cm-theme']`, updates the input's checked state. Pure CSS variable swap;
  no re-render, no IPC.
- **Persistence:** `localStorage` (reliable in macOS WKWebView; no Tauri store needed).

## Constraints / Tauri specifics

- **CSP `script-src 'self'`** → no inline scripts. Bootstrap is an external classic script.
- **CSP `default-src 'self'` (no `font-src`)** → remote Google Fonts blocked. The `@import`
  line is stripped from the copied tokens; font stacks fall back to system fonts.
- **`tauri.conf.json` window `backgroundColor`** changes `#0b0d14` → `#1A1A1A` (CodeMie dark
  page) so the native pre-paint background matches the new dark default.
- **Known minor limitation (not in scope):** the native macOS title-bar appearance does not
  follow the in-app toggle (would require Tauri `set_theme`). Noted, not addressed.

## Error handling / edge cases

- `localStorage` read/write wrapped in try/catch — any failure falls back to dark, toggle
  still works for the session.
- Unknown/missing stored value → treated as `'dark'`.
- Glow uses `pointer-events: none` so it never intercepts clicks.

## Testing & verification

- **Existing smoke (`CODEMIE_SMOKE`)** still passes: it checks `.step-row` count, canvas,
  title, and that styles loaded via `bg`. The stale comment `expect rgb(11, 13, 20)` is
  updated to the new dark page value; **nothing asserts the exact value**, so no test breaks.
- **JS unit tests** (`ui/test/*.mjs`, `node:test`) cover engine/models — untouched by styling.
- **Manual visual verification (required):** run the app, screenshot **home / wizard / connect
  in both light and dark**, confirm: palette alignment, toggle flips + persists across relaunch,
  glow sits bottom-left behind content in both themes, no flash for light-mode users, overlays
  still legible. Iterate the glow tuning with the user from these screenshots.
- Run quality gates (`cargo fmt`/`clippy` unaffected; `npm test`; build) per
  `.ai-run/guides/quality-gates.md`.

## Files touched

| File | Change |
|---|---|
| `ui/codemie-tokens.css` | **New** — copied tokens, Google-Fonts `@import` removed |
| `ui/theme-init.js` | **New** — render-blocking bootstrap + toggle wiring |
| `ui/index.html` | Add head script + token link; add `#theme-toggle` markup |
| `ui/styles.css` | Rewrite to consume CodeMie tokens; add `.switch-*`, `#theme-toggle`, `body::before` glow; map all stray literals |
| `ui/renderer.js` | Update stale smoke comment only (no logic change) |
| `src-tauri/tauri.conf.json` | Window `backgroundColor` `#0b0d14` → `#1A1A1A` |

## Out of scope (YAGNI)

- Bundling Inter / JetBrains Mono font files.
- Native title-bar theme sync (Tauri `set_theme`).
- Importing the full style-guide component CSS (buttons/forms/cards) — only the tokens and the
  switch pattern are adopted; the app keeps its own focused component styles.
- Any layout/structure changes to existing views.
