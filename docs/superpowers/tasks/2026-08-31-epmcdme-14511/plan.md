# Application Shell and Navigation (EPMCDME-14511 / S8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `showView`'s 3-way hidden-class toggle with a view-registry-driven shell (sidebar, identity bar, footer log slot, update-banner slot) routing six views plus the legacy wizard, and give the identity bar real values from the CodeMie CLI configuration. The home grid is kept, so the analytics entry point stays on its tile; the Update CLI action moves onto the update banner.

**Architecture:** Vanilla DOM, no new dependency or framework — but not frontend-only. `ui/index.html` gains sidebar/identity-bar/footer-log markup and four new empty view containers (Setup/Agents/Health/About); `ui/renderer.js` generalizes `showView` to iterate a plain `{name: element}` registry and marks the routed sidebar entry with `aria-current`; and `src-tauri/src/commands/codemie_config.rs` adds the one command the identity bar needs, since no JavaScript can read `~/.codemie/codemie-cli.config.json`. Registration touches `mod.rs` and `lib.rs`; `smoke.rs` gains a `CODEMIE_DEV` flag, `window.rs` and `tauri.conf.json` the new 1000x660 window size.

**Tech Stack:** Vanilla ESM JS, HTML, `node:test` (existing `ui/test/*.test.mjs` convention, not extended by this plan — see rationale per task).

**Spec:** `docs/superpowers/tasks/2026-08-31-epmcdme-14511/spec.md`

## Global Constraints

- Files touched: `ui/renderer.js`, `ui/index.html` only. No `src-tauri/` changes, no new dependency, no framework/build-step change.
- `showView(name)` keeps its name and external call contract; only its internals generalize.
- View registry is a plain object literal — no router class, no plugin points, no lifecycle hooks.
- Identity bar: only account/auth status is live (via existing `check_profile_status`); profile/model/project are static placeholder text nodes — no backend plumbing, no data-provider abstraction.
- `#update-banner` id is reused unmodified, just relocated in markup; `showUpdateBanner`/`dismissUpdateBanner` only drop their `#installation-group`/`#update-cli-tile` references, no other logic change.
- `#command-log-footer` and the relocated `#update-banner` are empty containers — no internal content/behavior designed here.
- `runAnalytics`/`runUpdateCli` internals are not touched.
- `src-tauri/tauri.conf.json` (productName/window title) is not touched.
- `CODEMIE_SMOKE`/`CODEMIE_PROBE_SMOKE` boot paths must keep working: `showView('wizard')` still exposes `.step-row` elements.
- Commit per task using the repo's existing convention: `<type>: <short description>` (Conventional Commits, type-only, e.g. `feat: generalize showView to a six-view registry`).

---

### Task 1: Generalize `showView` into a six-view registry

**Files:**
- Modify: `ui/index.html:74` region (add three new hidden view containers after `wizard-view`, before `connect-view`, or adjacent — exact placement is cosmetic)
- Modify: `ui/renderer.js:67-69` (view refs), `ui/renderer.js:145-150` (`showView`)

**Interfaces:**
- Produces: `views` object literal (`{ home, agents, connect, health, about, wizard }` → element), `showView(name)` — unchanged signature, now iterates `views`.
- Consumes: nothing new; existing callers (`enterWizard` at `renderer.js:167`, `boot()`'s routing at `renderer.js:394-452`) keep calling `showView('home' | 'wizard' | 'connect')` unmodified.

- [ ] **Step 1: Add empty containers to `ui/index.html`**

Add three new top-level view containers, each `class="hidden"`, structurally matching the minimal shape of `connect-view` (a bare `<div>` with an id, no inner markup required — content is other tickets' scope):

```html
<div id="agents-view" class="hidden"></div>
<div id="health-view" class="hidden"></div>
<div id="about-view" class="hidden"></div>
```

Place them alongside the existing `wizard-view`/`connect-view` siblings inside `#app`.

- [ ] **Step 2: Generalize the registry and `showView` in `ui/renderer.js`**

Replace the three separate `const homeView = ...` / `wizardView` / `connectView` refs (`renderer.js:67-69`) and `showView` (`renderer.js:146-150`) with:

```js
const views = {
  home: document.getElementById('home-view'),
  agents: document.getElementById('agents-view'),
  connect: document.getElementById('connect-view'),
  health: document.getElementById('health-view'),
  about: document.getElementById('about-view'),
  wizard: document.getElementById('wizard-view'),
};

function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}
```

Keep `homeView`, `wizardView`, `connectView` as local aliases (`const homeView = views.home;` etc.) wherever the rest of the file already dereferences them directly (e.g. no other code needs to change), or update those few call sites to `views.home` — whichever keeps the diff smaller; either is acceptable, no new abstraction either way.

- [ ] **Step 3: Manual verification of smoke/probe compatibility**

Run `CODEMIE_SMOKE=1` (or the project's existing smoke-launch command) and confirm `boot()`'s existing `showView('wizard')` call at `renderer.js:443/448` still un-hides `wizard-view` and `.step-row` elements render as before. This is a check of this task's own deliverable, not a whole-suite gate.

- [ ] **Step 4: Commit**

```bash
git add ui/index.html ui/renderer.js
git commit -m "feat: generalize showView to a six-view registry"
```

**Test-first: no** — `renderer.js` has top-level side effects (`window.__TAURI__` access, `boot()` invoked at module load) that make it unimportable in the `node:test` environment used by `ui/test/*.test.mjs` without a browser/Tauri shim; no such harness exists today (confirmed by technical-analysis's Testing Landscape — zero coverage on `showView`). Manual click-through plus the existing smoke/probe boot checks were the intended verification path. In the event a Playwright harness was built for this ticket under `dynamic-tests/`, which drives the real `ui/` against a stubbed `window.__TAURI__`; it is not wired into `npm test` and must be run from that directory.

---

### Task 2: Sidebar shell — main nav group and bottom group

**Files:**
- Modify: `ui/index.html` (new `#app-sidebar` element, sibling of the view containers, inside `#app`)
- Modify: `ui/renderer.js` (new DOM refs + click wiring in `boot()`, near the existing `homeGrid.addEventListener` block at `renderer.js:401-423`)

**Interfaces:**
- Consumes: `showView(name)` from Task 1, `runAnalytics()` (existing, `renderer.js:244-263`).
- Produces: none consumed by later tasks beyond the DOM ids named below (`sidebar-analytics`, `sidebar-about`, `sidebar-home`, `sidebar-agents`, `sidebar-connections`, `sidebar-health`).

- [ ] **Step 1: Add sidebar markup to `ui/index.html`**

```html
<nav id="app-sidebar">
  <div id="sidebar-main-group">
    <button id="sidebar-home" class="sidebar-item" data-view="home">Home</button>
    <button id="sidebar-agents" class="sidebar-item" data-view="agents">Agents</button>
    <button id="sidebar-connections" class="sidebar-item" data-view="connect">Connections</button>
    <button id="sidebar-health" class="sidebar-item" data-view="health">Health</button>
  </div>
  <div id="sidebar-divider"></div>
  <div id="sidebar-bottom-group">
    <button id="sidebar-analytics" class="sidebar-item">CLI usage analytics</button>
    <button id="sidebar-about" class="sidebar-item" data-view="about">About</button>
  </div>
</nav>
```

- [ ] **Step 2: Wire clicks in `boot()`**

Add, near the existing `homeGrid` wiring in `boot()` (`renderer.js:401-423`), following the same `addEventListener` style as `wizardBack`/`connectBack` (`renderer.js:424-425`):

```js
document.querySelectorAll('#sidebar-main-group .sidebar-item, #sidebar-about').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});
document.getElementById('sidebar-analytics').addEventListener('click', () => runAnalytics());
```

(This step only wires the click; the sidebar's Analytics behavior itself — removing the old home-grid tile — is Task 5's job, so `runAnalytics()` now has two working entry points until Task 5 lands. That's an acceptable intermediate state within this plan's own task sequence.)

Note for whoever implements: if this wiring plus Task 3/4's additions push `renderer.js` past a comfortable size, extracting a `initSidebar(domRefs)` module (mirroring `initLog`/`initTerminal` at `renderer.js:320-332`) is a reasonable judgment call — it is not required by this plan.

- [ ] **Step 3: Commit**

```bash
git add ui/index.html ui/renderer.js
git commit -m "feat: add sidebar shell with main and bottom nav groups"
```

**Test-first: no** — same rationale as Task 1: pure DOM wiring in a file with no test harness; verified by manual click-through per view.

---

### Task 3: Identity bar

**Files:**
- Modify: `ui/index.html` (new `#identity-bar` element, sibling of `#app-sidebar`)
- Modify: `ui/renderer.js` (`boot()` — populate live auth status; existing `showUpdateBanner`, `renderer.js:191-199`, already has the version data to reuse)

**Interfaces:**
- Consumes: `invoke('check_profile_status')` (existing Rust command, same shape used at `renderer.js:227`), `cliVersionState` (existing module-level object, `renderer.js:36`).
- Produces: none consumed by later tasks.

- [ ] **Step 1: Add identity bar markup to `ui/index.html`**

```html
<div id="identity-bar">
  <span id="identity-auth-status">Checking sign-in…</span>
  <span id="identity-profile">—</span>
  <span id="identity-model">—</span>
  <span id="identity-project">—</span>
  <span id="identity-version-badge"></span>
</div>
```

- [ ] **Step 2: Populate live auth status and version badge in `boot()`**

Add, in `boot()` after the existing CLI-version `Promise.all(...)` block (`renderer.js:338-349`), a call reusing `check_profile_status` the same way `ensureAuthenticated()` does (`renderer.js:224-230`):

```js
invoke('check_profile_status').then((st) => {
  document.getElementById('identity-auth-status').textContent = st.authenticated ? 'Signed in' : 'Not signed in';
}).catch(() => {
  document.getElementById('identity-auth-status').textContent = 'Not signed in';
});
```

For the version badge, extend the existing `showUpdateBanner()` (`renderer.js:191-199`) — or the `Promise.all(...).then(...)` callback right above it — to also set:

```js
if (cliVersionState.updateAvailable) {
  document.getElementById('identity-version-badge').textContent = `${cliVersionState.latest} available`;
}
```

Profile/model/project stay as the static `—` placeholders already in the markup — no JS needed for them.

- [ ] **Step 3: Commit**

```bash
git add ui/index.html ui/renderer.js
git commit -m "feat: add identity bar with live auth status and version badge"
```

**Test-first: no** — same rationale as Task 1; DOM/`invoke`-dependent, no harness exists for `renderer.js`'s async boot wiring.

---

### Task 4: Footer log region and update-banner relocation

**Files:**
- Modify: `ui/index.html` (add `#command-log-footer`; move `#update-banner`'s existing markup, `index.html:35-38`, out of `#installation-group` into the new shell, unchanged internals; delete `#installation-group`/`#update-cli-tile` only if Task 5 doesn't already need them — see Task 5)
- Modify: `ui/renderer.js:191-207` (`showUpdateBanner`/`dismissUpdateBanner`)

**Interfaces:**
- Consumes: `cliVersionState` (existing).
- Produces: `#command-log-footer` (empty container, no JS controller — S9's job).

- [ ] **Step 1: Add footer log region to `ui/index.html`**

```html
<div id="command-log-footer" class="hidden"></div>
```

Place as a sibling of `#app-sidebar`/`#identity-bar`, at the bottom of the shell. It stays empty and `hidden` — S9 populates and un-hides it.

- [ ] **Step 2: Relocate `#update-banner` markup**

Move the existing `#update-banner` div (`index.html:35-38`, including its `#update-from`, `#update-to`, `#update-banner-dismiss` children) verbatim out of `#installation-group` to a top-level position in the new shell (e.g. sibling of `#identity-bar`). No attribute or id changes.

- [ ] **Step 3: Drop stale references in `showUpdateBanner`/`dismissUpdateBanner`**

In `renderer.js:191-207`, remove only the two lines in each function that reference `#installation-group` and `#update-cli-tile` (lines 197-198 in `showUpdateBanner`, lines 204-206 in `dismissUpdateBanner`). Leave every other line — the `#update-banner`, `#update-from`, `#update-to`, `sessionStorage` logic — unchanged:

```js
function showUpdateBanner() {
  if (!cliVersionState.updateAvailable) return;
  if (sessionStorage.getItem('update-banner-dismissed') === '1') return;
  document.getElementById('update-from').textContent = cliVersionState.installed;
  document.getElementById('update-to').textContent = cliVersionState.latest;
  document.getElementById('update-banner').classList.remove('hidden');
}

function dismissUpdateBanner() {
  sessionStorage.setItem('update-banner-dismissed', '1');
  document.getElementById('update-banner').classList.add('hidden');
}
```

- [ ] **Step 4: Commit**

```bash
git add ui/index.html ui/renderer.js
git commit -m "feat: relocate update-banner into shell and add footer log slot"
```

**Test-first: no** — same rationale as Task 1; verified by manual check that the update banner still shows/dismisses correctly when an update is available (no regression in `cliVersionState`-driven logic, which is untouched).

---

### Task 5: ~~Re-home analytics entry point; remove old home-grid tile~~ — NOT DONE, reversed

**This task was executed and then reverted. Do not follow it.**

It instructed deleting the analytics tile from `ui/index.html` and the `analytics`
case from the grid handler, making `#sidebar-analytics` "the sole entry point".
That is precisely what the ticket's "Do not do these" forbids: a sidebar entry is
a *new* entry point, which EPMCDME-14350 defers. Following it removed a feature
that ships on `origin/main` — the sidebar entry was then suppressed, leaving
`runAnalytics` with no route at all.

What shipped instead: the grid tile and its handler case are untouched and
byte-identical to `origin/main`; the sidebar entry exists but is hidden. See the
ticket's Out of scope section and the comment on EPMCDME-14516.


---

## Negative-constraint pass

- No Rust/backend changes anywhere: every task above touches only `ui/index.html`/`ui/renderer.js`; profile/model/project stay static text nodes with zero `invoke` calls added for them (Task 3).
- No new router/abstraction/plugin system: `views` is a plain object literal, `showView` keeps its exact prior shape/signature (Task 1); no class, no lifecycle hooks, no per-view init contract introduced.
- No renaming/rebranding: no task touches `src-tauri/tauri.conf.json`.
- No change to `runAnalytics`/`runUpdateCli` internals or the analytics report: Task 5 only moves the caller; `runAnalytics`'s body (`renderer.js:244-263`) is never edited by any task.
- No redesign of Connections/Connect-Desktop: `connect-view` markup and `connectBtn`/`restartBtn`/`ensureAuthenticated` logic are untouched by every task; only its registry key (`views.connect`) generalizes in Task 1, unchanged in behavior.
- No design of footer-log/update-banner internal contents: Task 4 adds `#command-log-footer` as an empty, hidden container and relocates `#update-banner`'s existing markup verbatim — no new inner markup, no new JS controller for either.
- No "identity data provider" abstraction: Task 3 wires `check_profile_status` directly inline in `boot()`, with no intermediate data layer; profile/model/project are static markup, not sourced from any function.

