# CodeMie Theme + Light/Dark Toggle + Corner Gradient Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the whole installer onto CodeMie design-system tokens, add a remembered light/dark toggle (dark default), and add a bottom-left radial purple glow matching the real CodeMie app.

**Architecture:** A copied token file (`ui/codemie-tokens.css`) provides theme-aware CSS variables (dark via `:root`, light via `.light`). A render-blocking classic script (`ui/theme-init.js`) sets the `<html>` theme class before first paint and wires the toggle. `ui/styles.css` is rewritten to consume those tokens via a thin legacy-alias layer, so both themes work with minimal per-rule churn; it also adds the switch component, the `body::before` glow, and system fonts.

**Tech Stack:** Vanilla HTML/CSS/JS frontend (no framework), Tauri v2 shell, `localStorage` for persistence. Verification via the existing Rust `CODEMIE_SMOKE` renderer probe + manual screenshots; `node:test` for unchanged logic.

**Spec:** `docs/superpowers/specs/2026-06-11-codemie-theme-main-screen-design.md`

**Note on TDD for this plan:** The change is CSS + a DOM bootstrap with no jsdom in the toolchain, so unit-level red/green TDD does not apply to the styling itself. Per `.ai-run/guides/testing/testing-patterns.md`, the renderer is verified by the env-gated `CODEMIE_SMOKE` integration probe plus manual checks. Task 5 extends that probe to assert the theme class is applied, giving an automated signal; Task 6 covers visual verification.

---

## File Structure

| File | Responsibility |
|---|---|
| `ui/codemie-tokens.css` | **New.** Faithful copy of the style guide's design tokens (colors, gradients, spacing, radii, shadows) for dark + light. Google-Fonts `@import` removed (CSP-blocked). |
| `ui/theme-init.js` | **New.** Classic render-blocking script: read/normalize stored theme, set `<html>` class pre-paint, persist, wire `#theme-toggle`. No imports/exports. |
| `ui/index.html` | Add the head script + token stylesheet (correct order); add the `#theme-toggle` switch markup. |
| `ui/styles.css` | Rewritten to consume CodeMie tokens via an alias layer; adds switch styles, corner glow, system fonts; all stray hex literals mapped. |
| `ui/renderer.js` | Update the stale smoke comment; add `theme` to the SMOKE_PROBE object. |
| `src-tauri/tauri.conf.json` | Window `backgroundColor` `#0b0d14` → `#1A1A1A`. |

---

### Task 1: Token layer (`ui/codemie-tokens.css`)

**Files:**
- Create: `ui/codemie-tokens.css` (copied from `/Users/Vadym_Vlasenko/AI/projects/style-guide/css/tokens.css`)

- [ ] **Step 1: Copy the token file into the app**

Run:
```bash
cp "/Users/Vadym_Vlasenko/AI/projects/style-guide/css/tokens.css" ui/codemie-tokens.css
```

- [ ] **Step 2: Remove the CSP-blocked Google-Fonts import**

Edit `ui/codemie-tokens.css` — delete the entire FONT IMPORT block (the comment header and the `@import url('https://fonts.googleapis.com/...')` line) near the top. After editing, the file must start its real content at the GLOBAL SCALE section and contain no `@import` and no `fonts.googleapis.com` reference.

Replace this block:
```css
/* ============================================================
   FONT IMPORT
   ============================================================ */
@import url('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap');

/* ============================================================
   GLOBAL SCALE (theme-independent)
   ============================================================ */
```
with:
```css
/* ============================================================
   GLOBAL SCALE (theme-independent)
   ============================================================ */
```

- [ ] **Step 3: Verify no remote font reference remains**

Run:
```bash
grep -nc "googleapis\|@import" ui/codemie-tokens.css
```
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add ui/codemie-tokens.css
git commit -m "feat: add CodeMie design tokens (CSP-safe, no remote font import)"
```

---

### Task 2: Theme bootstrap script (`ui/theme-init.js`)

**Files:**
- Create: `ui/theme-init.js`

- [ ] **Step 1: Create the bootstrap script**

Create `ui/theme-init.js` with this exact content:
```js
// CodeMie theme bootstrap.
// Loaded as a CLASSIC, render-blocking <script src> in <head> (NOT type=module, NOT defer)
// so the <html> theme class is set before first paint — no flash of the wrong theme.
// CSP note: must be an external 'self' script; inline scripts are blocked by `script-src 'self'`.
(function () {
  var KEY = 'cm-theme';

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  function apply(theme) {
    var t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.className = t;
    try {
      localStorage.setItem(KEY, t);
    } catch (e) {
      /* storage unavailable — theme still applies for this session */
    }
    return t;
  }

  // Pre-paint: set the class immediately from storage (documentElement exists in <head>).
  apply(read());
  window.__cmTheme = { get: read, set: apply };

  // Wire the toggle once the DOM is ready. Convention: checked = dark.
  function wire() {
    var input = document.getElementById('theme-toggle-input');
    if (!input) return;
    input.checked = read() === 'dark';
    input.addEventListener('change', function () {
      apply(input.checked ? 'dark' : 'light');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
```

- [ ] **Step 2: Sanity-check it parses as classic JS (no import/export)**

Run:
```bash
node --check ui/theme-init.js && grep -nc "import \|export " ui/theme-init.js
```
Expected: `node --check` prints nothing and exits 0; grep prints `0`.

- [ ] **Step 3: Commit**

```bash
git add ui/theme-init.js
git commit -m "feat: theme bootstrap script (pre-paint html class + toggle wiring)"
```

---

### Task 3: Wire the script, token stylesheet, and toggle into `index.html`

**Files:**
- Modify: `ui/index.html`

- [ ] **Step 1: Add the bootstrap script and token stylesheet to `<head>` in the correct order**

Replace this block (lines 3–8):
```html
  <head>
    <meta charset="UTF-8" />
    <title>CodeMie Installation Wizard</title>
    <link rel="stylesheet" href="vendor/xterm.css" />
    <link rel="stylesheet" href="styles.css" />
  </head>
```
with:
```html
  <head>
    <meta charset="UTF-8" />
    <title>CodeMie Installation Wizard</title>
    <!-- Render-blocking: sets the <html> theme class before first paint (no flash). -->
    <script src="theme-init.js"></script>
    <link rel="stylesheet" href="vendor/xterm.css" />
    <link rel="stylesheet" href="codemie-tokens.css" />
    <link rel="stylesheet" href="styles.css" />
  </head>
```

- [ ] **Step 2: Add the theme toggle as the first child of `#app`**

Replace this line (line 10):
```html
    <div id="app">
```
with:
```html
    <div id="app">
      <!-- Theme toggle — fixed top-right, available on every view. checked = dark. -->
      <label id="theme-toggle" class="switch-wrapper" title="Toggle light / dark theme">
        <span class="theme-ico theme-ico-sun" aria-hidden="true">☀</span>
        <input type="checkbox" id="theme-toggle-input" />
        <span class="switch-track"><span class="switch-knob"></span></span>
        <span class="theme-ico theme-ico-moon" aria-hidden="true">☾</span>
      </label>
```

- [ ] **Step 3: Verify the wiring is present**

Run:
```bash
grep -n "theme-init.js\|codemie-tokens.css\|theme-toggle-input" ui/index.html
```
Expected: three matches — the script tag, the token `<link>`, and the toggle input.

- [ ] **Step 4: Commit**

```bash
git add ui/index.html
git commit -m "feat: load theme tokens + bootstrap, add theme toggle to index.html"
```

---

### Task 4: Rewrite `ui/styles.css` onto CodeMie tokens

**Files:**
- Modify: `ui/styles.css` (full replacement)

- [ ] **Step 1: Replace the entire file contents**

Overwrite `ui/styles.css` with this exact content:
```css
/* CodeMie Installer — styled with the CodeMie design-system tokens (codemie-tokens.css).
   Dark is the default theme; `.light` on <html> switches to light. App component styles
   consume CodeMie tokens through a thin legacy-alias layer so both themes work. */

/* Alias layer: legacy app variable names → CodeMie tokens (theme-aware via indirection,
   resolved at use site, so they pick up the .light overrides automatically). */
:root {
  --bg:           var(--color-bg-page);
  --panel:        var(--color-bg-card);
  --panel-dark:   var(--color-bg-sidebar);
  --surface:      var(--color-bg-card);
  --surface-2:    var(--color-bg-hover);
  --border:       var(--color-border-primary);
  --border-2:     var(--color-border-primary);
  --accent:       var(--color-purple);
  --accent-hover: var(--color-bg-btn-primary-h);
  --accent-blue:  var(--color-info-text);
  --violet:       var(--color-purple);
  --muted:        var(--color-text-muted);
  --dim:          var(--color-text-tertiary);
  --text:         var(--color-text-primary);
  --green:        var(--color-success-text);
  --green-btn:    var(--color-success);
  --amber:        var(--color-warning-text);
  --red:          var(--color-error-text);

  /* Corner-glow opacity — tuned per theme. */
  --cm-glow-opacity: 0.55;
}
:root.light { --cm-glow-opacity: 0.30; }

* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  background: var(--color-bg-page);
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  font-size: 13px;
  overflow: hidden;
  user-select: none;
}
.hidden { display: none !important; }

/* Bottom-left radial purple glow — fixed behind all content; opacity is tunable. */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  opacity: var(--cm-glow-opacity);
  background:
    radial-gradient(55% 50% at 0% 100%,
      rgba(158, 0, 255, 0.55) 0%,
      rgba(236, 86, 255, 0.16) 38%,
      transparent 70%),
    radial-gradient(34% 30% at 6% 96%,
      rgba(103, 45, 146, 0.45) 0%,
      transparent 64%);
  transition: opacity var(--transition-base);
}

#app { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100vh; }

/* ---- Theme toggle (fixed top-right, above content, below overlays) ---- */
#theme-toggle { position: fixed; top: 10px; right: 12px; z-index: 45; }
.theme-ico { font-size: 12px; line-height: 1; opacity: 0.55; transition: opacity var(--transition-base); }
:root.light .theme-ico-sun  { opacity: 1; }
:root.dark  .theme-ico-moon { opacity: 1; }

/* Switch component (ported from CodeMie forms.css). */
.switch-wrapper { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; user-select: none; }
.switch-wrapper input[type="checkbox"] { position: absolute; opacity: 0; width: 0; height: 0; }
.switch-track {
  position: relative;
  width: 32px;
  height: 16px;
  border-radius: var(--radius-full);
  background: var(--gradient-switch-off);
  border: 1px solid var(--color-border-primary);
  transition: background var(--transition-base), border-color var(--transition-base);
  flex-shrink: 0;
}
.switch-wrapper input[type="checkbox"]:checked + .switch-track {
  background: var(--gradient-switch-on);
  border-color: var(--color-border-accent);
}
.switch-knob {
  position: absolute;
  top: 1px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: var(--radius-full);
  background-color: #CCCCCC;
  transition: transform var(--transition-base), background-color var(--transition-base);
  pointer-events: none;
}
.switch-wrapper input[type="checkbox"]:checked ~ .switch-track .switch-knob {
  transform: translateX(16px);
  background-color: #FFFFFF;
}

/* Top-level views fill #app; only one is visible at a time. */
#home-view, #wizard-view, #connect-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }

#main-row { display: flex; flex: 1; min-height: 0; }

/* ---- Home / launcher ---- */
#home-view { padding: 26px 32px; animation: cm-fade-in 0.2s ease; }
#home-header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
#home-logo { width: 56px; height: 56px; flex: none; }
#home-title { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: 0.2px; }
#home-subtitle { color: var(--muted); font-size: 13px; margin-top: 2px; }

#home-grid {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-auto-rows: 1fr;
  gap: 16px;
  min-height: 0;
}
.home-tile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
  gap: 8px;
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-xl);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease;
}
.home-tile:hover {
  background: var(--surface-2);
  border-color: var(--accent);
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}
.home-tile:active { transform: translateY(0); box-shadow: none; }
.tile-icon { font-size: 30px; line-height: 1; }
.tile-title { font-size: 15px; font-weight: 700; color: var(--violet); }
.tile-desc { font-size: 12px; color: var(--muted); line-height: 1.45; }
#home-footer { color: var(--muted); font-size: 9px; text-align: center; padding-top: 18px; }

/* ---- Wizard top bar (back to home) ---- */
#wizard-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 34px;
  padding: 0 14px;
  background: var(--panel-dark);
  border-bottom: 1px solid var(--border);
}
.back-link {
  background: none;
  border: none;
  color: var(--accent-blue);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: var(--radius-md);
}
.back-link:hover { color: var(--text); background: var(--surface-2); }
#wizard-mode-label, .mode-label { color: var(--dim); font-size: 11px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; }

/* ---- Connect Claude Desktop (intermediate screen) ---- */
#connect-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 34px;
  padding: 0 14px;
  background: var(--panel-dark);
  border-bottom: 1px solid var(--border);
}
#connect-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 28px 32px; gap: 22px; }
#connect-header { display: flex; align-items: center; gap: 16px; }
.connect-icon { font-size: 34px; line-height: 1; flex: none; }
#connect-title { font-size: 20px; font-weight: 700; color: var(--text); }
#connect-subtitle { color: var(--muted); font-size: 13px; margin-top: 4px; line-height: 1.5; max-width: 620px; }
#connect-subtitle code { font-family: var(--font-mono); font-size: 12px; color: var(--accent-blue); }
#connect-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.connect-action {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
  gap: 8px;
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-xl);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease;
}
.connect-action:hover { background: var(--surface-2); border-color: var(--accent); transform: translateY(-2px); box-shadow: var(--shadow-lg); }
.connect-action:active { transform: translateY(0); box-shadow: none; }
.ca-title { font-size: 15px; font-weight: 700; color: var(--violet); }
.ca-desc { font-size: 12px; color: var(--muted); line-height: 1.45; }
.view-footer { background: var(--color-bg-nav); color: var(--muted); font-size: 9px; text-align: center; padding: 6px; }

/* ---- Sprite panel ---- */
#sprite-panel {
  width: 200px;
  background: var(--panel-dark);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 22px 12px;
}
#sprite-canvas { width: 168px; height: 168px; }
#sprite-label { color: var(--violet); font-weight: 700; margin-top: 6px; letter-spacing: 0.5px; }
#status-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 12px;
  padding: 5px 12px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
}
#status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); display: inline-block; }
#sprite-controls { margin-top: auto; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 12px; }

/* ---- Buttons ---- */
.btn {
  border: none;
  border-radius: var(--radius-lg);
  padding: 10px 22px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-inverse);
  cursor: pointer;
  width: 100%;
  transition: background 0.12s ease, filter 0.12s ease, transform 0.12s ease, box-shadow 0.12s ease;
}
.btn-accent { background: var(--gradient-primary-btn); }
.btn-accent:hover:not(:disabled) { filter: brightness(1.08); }
.btn-success { background: var(--color-success); }
.btn-success:hover:not(:disabled) { filter: brightness(1.08); }
.btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: var(--shadow-md); }
.btn:active:not(:disabled) { transform: translateY(0); box-shadow: none; }
.btn:disabled { opacity: 0.5; cursor: default; filter: none; }

#unattended-label { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; cursor: pointer; }

#v-divider { width: 1px; background: var(--border); }
#h-divider { height: 1px; background: var(--border); }

/* ---- Step panel ---- */
#step-panel { flex: 1; background: var(--panel); padding: 16px 18px; overflow-y: auto; min-width: 0; }
#step-header { color: var(--dim); font-size: 10px; font-weight: 700; letter-spacing: 1px; margin-bottom: 12px; }
#step-list { display: flex; flex-direction: column; gap: 4px; }

.step-row {
  position: relative;
  display: flex;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition: background 0.18s ease;
}
.step-row.active { background: var(--surface-2); }
.step-row.sub { margin-left: 26px; animation: cm-rise 0.2s ease; }
.step-progress {
  position: absolute;
  inset: 0;
  width: 0%;
  background: var(--color-info-bg);
  z-index: 0;
  transition: width 0.2s ease;
}
.step-main { position: relative; z-index: 1; flex: 1; min-width: 0; }
.step-icon { position: relative; z-index: 1; width: 20px; text-align: center; font-size: 15px; line-height: 1.3; transition: color 0.18s ease; }
.step-title { font-weight: 600; }
.step-row.active .step-title { color: var(--accent-blue); }
.step-sub { color: var(--muted); font-size: 12px; margin-top: 2px; min-height: 14px; transition: color 0.18s ease; }

.approval { margin-top: 8px; display: flex; gap: 8px; animation: cm-rise 0.16s ease; }
.approval button { border: none; border-radius: var(--radius-md); padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
.btn-approve { background: var(--color-success); color: var(--color-text-inverse); }
.btn-ignore { background: var(--border-2); color: var(--amber); }
.stamp { margin-top: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; animation: cm-fade-in 0.2s ease; }
.stamp.approved { color: var(--green); }
.stamp.ignored { color: var(--amber); }

/* ---- Log bar + panel ---- */
#log-bar {
  height: 36px;
  background: var(--panel-dark);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
}
#log-bar button { background: none; border: none; color: var(--muted); font-size: 12px; cursor: pointer; }
#log-bar button:hover { color: var(--text); }
#log-panel { height: 220px; background: var(--panel-dark); border-top: 1px solid var(--border); overflow: hidden; }
#log-content {
  height: 100%;
  overflow-y: auto;
  padding: 8px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  scroll-behavior: smooth;
}
.log-line { white-space: pre-wrap; word-break: break-word; }
.log-stdout { color: var(--text); }
.log-stderr { color: var(--color-error-text); }
.log-info { color: var(--violet); }
.log-success { color: var(--color-success-text); }
.log-dim { color: var(--muted); }
.log-prompt { color: var(--color-warning-text); }
.log-approved { color: var(--color-success-text); text-align: right; }

/* ---- Footer ---- */
#footer { background: var(--color-bg-nav); color: var(--muted); font-size: 9px; text-align: center; padding: 6px; }

/* ---- Overlays ---- */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.overlay:not(.hidden) { animation: cm-fade-in 0.18s ease; }
#terminal-card {
  width: 92%;
  height: 86%;
  background: var(--color-bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 14px;
  display: flex;
  flex-direction: column;
}
#terminal-title { color: var(--violet); font-weight: 700; margin-bottom: 8px; }
#terminal-host { flex: 1; min-height: 0; }
#terminal-hint { color: var(--muted); font-size: 11px; margin-top: 8px; text-align: center; }
#terminal-done { width: auto; align-self: center; margin-top: 10px; padding: 8px 18px; }

#fatal-card {
  width: 70%;
  max-width: 520px;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-xl);
  padding: 28px;
  text-align: center;
}
#fatal-title { color: var(--red); font-size: 20px; font-weight: 700; margin-bottom: 14px; }
#fatal-message { color: var(--text); margin-bottom: 12px; }
#fatal-reco { color: var(--amber); font-size: 12px; margin-bottom: 20px; }

/* ---- Notice modal (generic) ---- */
#notice-card {
  width: 70%;
  max-width: 480px;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-xl);
  padding: 26px;
  text-align: center;
}
#notice-title { color: var(--violet); font-size: 17px; font-weight: 700; margin-bottom: 12px; }
#notice-message { color: var(--text); font-size: 13px; line-height: 1.5; margin-bottom: 22px; }
#notice-actions { display: flex; gap: 10px; justify-content: center; }
#notice-actions .btn { width: auto; padding: 9px 18px; }
.btn-ghost { background: var(--surface-2); color: var(--text); }
.btn-ghost:hover { background: var(--border-2); }

/* ---- Animations ---- */
#status-dot { transition: background 0.25s ease; }
@keyframes cm-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes cm-rise {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 2: Verify no stray pre-theme literals survived the rewrite**

Run:
```bash
grep -nE "#0b0d14|#0d1117|#0a0c12|#161b22|#1c2128|#21242f|#21262d|#8b5cf6|#7c3aed|#58a6ff|#a78bfa|#6e7681|#484f58|#c9d1d9|#3fb950|#238636|#d29922|#ff6b6b|#080a10|#13151f|#1a3350|#2ea043|#ff7b72|#e3b341|#7ee787|rgba\(3, 5, 10" ui/styles.css | grep -v "rgba(158, 0, 255\|rgba(236, 86, 255\|rgba(103, 45, 146"
```
Expected: no output (all legacy literals are gone; only the glow's purple rgbas and `#CCCCCC`/`#FFFFFF` knob colors remain, which are intentional).

- [ ] **Step 3: Commit**

```bash
git add ui/styles.css
git commit -m "feat: re-skin installer onto CodeMie tokens + switch + corner glow"
```

---

### Task 5: Update Tauri window background + extend the smoke probe

**Files:**
- Modify: `src-tauri/tauri.conf.json:19`
- Modify: `ui/renderer.js` (smoke probe object + stale comment, around lines 356–363)

- [ ] **Step 1: Update the window background color**

In `src-tauri/tauri.conf.json`, replace:
```json
        "backgroundColor": "#0b0d14"
```
with:
```json
        "backgroundColor": "#1A1A1A"
```

- [ ] **Step 2: Add `theme` to the smoke probe and fix the stale `bg` comment**

In `ui/renderer.js`, replace this block:
```js
  const cs = getComputedStyle(document.body);
  const probe = {
    rows: document.querySelectorAll('.step-row').length,
    title: document.title,
    hasCanvas: !!document.getElementById('sprite-canvas'),
    bg: cs.backgroundColor, // proves styles.css loaded + applied (expect rgb(11, 13, 20))
    bootError: window.__bootError || null,
  };
```
with:
```js
  const cs = getComputedStyle(document.body);
  const probe = {
    rows: document.querySelectorAll('.step-row').length,
    title: document.title,
    hasCanvas: !!document.getElementById('sprite-canvas'),
    bg: cs.backgroundColor, // proves styles.css + tokens loaded (dark page = rgb(26, 26, 26))
    theme: document.documentElement.className, // proves theme bootstrap ran ('dark' by default)
    bootError: window.__bootError || null,
  };
```

- [ ] **Step 3: Verify the edits**

Run:
```bash
grep -n "1A1A1A" src-tauri/tauri.conf.json && grep -n "theme: document.documentElement.className\|rgb(26, 26, 26)" ui/renderer.js
```
Expected: one match in the conf, two matches in renderer.js.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tauri.conf.json ui/renderer.js
git commit -m "chore: match window bg to CodeMie dark + assert theme in smoke probe"
```

---

### Task 6: Verify (logic tests, build, smoke, visual) and tune the glow

**Files:** none (verification + possible follow-up tuning of `ui/styles.css` glow only)

- [ ] **Step 1: Run the JS logic tests (must stay green)**

Run:
```bash
npm test
```
Expected: all `node --test` suites pass (engine/models — unaffected by styling).

- [ ] **Step 2: Build the app**

Run:
```bash
cd src-tauri && CI=true cargo tauri build
```
Expected: build succeeds; app binary at `src-tauri/target/release/app` (and DMG under `target/release/bundle/dmg/`).

- [ ] **Step 3: Run the renderer smoke and confirm the theme applied**

Run:
```bash
CODEMIE_SMOKE=1 ./src-tauri/target/release/app
```
Expected stdout includes a `SMOKE_PROBE` line whose JSON has `"theme":"dark"`, `"bg":"rgb(26, 26, 26)"`, `rows` > 0, `hasCanvas":true`, `bootError":null`; then `SMOKE_OK`.

- [ ] **Step 4: Visual check both themes**

Run `cd src-tauri && cargo tauri dev`. With the app open:
1. Confirm the home screen uses CodeMie dark palette and the bottom-left purple glow is visible behind the tiles/header.
2. Click the top-right toggle → switches to light theme (tiles white, light page, glow softer); toggle back to dark.
3. Quit and relaunch → the last-selected theme is restored (no flash of the other theme on launch).
4. Enter each flow (Full installation → wizard view; Connect Claude Desktop → connect view) and confirm panels, buttons (gradient primary), step rows, log bar, and footers all read correctly in both themes.
5. Open an overlay (e.g. trigger the terminal/notice) and confirm the scrim + card are legible in both themes.

Capture a screenshot of home in **dark** and **light** for the review.

- [ ] **Step 5: Tune the glow with the user**

The glow position/spread/opacity in `body::before` (and `--cm-glow-opacity` per theme) is a reconstruction. Show the screenshots; if the user wants it stronger/weaker/repositioned, adjust only those values in `ui/styles.css`, rebuild the dev view, and re-confirm. Commit any tuning:
```bash
git add ui/styles.css
git commit -m "style: tune corner glow position/opacity per review"
```

- [ ] **Step 6: Run remaining quality gates**

Run:
```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
```
Expected: all pass (Rust is untouched except the JSON config; these confirm nothing regressed).

---

## Self-Review

**Spec coverage:**
- Whole-app re-skin → Task 4 (every view, panel, overlay, footer mapped). ✓
- Dark default, persisted toggle → Task 2 (`theme-init.js`) + Task 3 (markup). ✓
- Top-right switch (CodeMie switch + sun/moon) → Task 3 markup + Task 4 switch/`#theme-toggle` CSS. ✓
- Bottom-left radial glow, app-wide, behind content, tunable → Task 4 `body::before` + Task 6 Step 5. ✓
- System fonts (no bundle, no remote import) → Task 1 Step 2 (strip `@import`) + Task 4 `var(--font-sans)`/`var(--font-mono)`. ✓
- CSP-safe bootstrap (classic head script) → Task 2 + Task 3 Step 1. ✓
- Window bg `#1A1A1A` → Task 5. ✓
- Smoke stays green; stale comment fixed → Task 5 + Task 6 Step 3. ✓
- All stray hex literals mapped → Task 4 Step 2 guard grep enumerates every one. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full content; commands have expected output. ✓

**Type/name consistency:** `cm-theme` storage key, `#theme-toggle-input` id, `--cm-glow-opacity` var, and the `.switch-*` class names match across `theme-init.js`, `index.html`, and `styles.css`. `window.__cmTheme` is defined and only referenced where defined. ✓
