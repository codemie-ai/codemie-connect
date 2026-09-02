# Spec: Application shell and navigation (EPMCDME-14511 / S8)

## Overview
Replace `showView`'s 3-way `hidden`-class toggle (`ui/renderer.js:146-150`, over `homeView`/`wizardView`/`connectView`) with a view-registry-driven shell: a sidebar, an identity bar, a collapsible footer log region, a named update-banner region, and routing across six views. The home grid is kept, so `runAnalytics()` stays on its existing tile and nothing is re-homed. Vanilla DOM, no framework, state-management library, build-step change or new dependency — but not frontend-only. The identity bar's four fields live in `~/.codemie/codemie-cli.config.json`, and no file-read API is reachable from JavaScript: the bridge exports none, `tauri-plugin-fs` is absent, and the capabilities file grants only `core:default`. Shelling out with `runCapture('cat …')` would have worked and is deliberately rejected — it spawns a login shell to read a small JSON file, and it would leave the three config states and the absent-account contract as untyped, untested JavaScript conventions that all three consuming tickets would re-derive. One Tauri command instead: no new crate, no `tauri-plugin-fs`, no widened permission surface. Any new module follows the existing `init<Widget>(domRefs)` factory convention (`initLog`/`initTerminal`/`initSprite`, `ui/renderer.js:317-332`) only if the team chooses to split the router/sidebar wiring out of `renderer.js` for size reasons — not a required new abstraction.

## View routing contract
Views: **Home, Setup, Agents, Connections, Health, About** — the six routed views — plus **Wizard** for the legacy install engine.
- The view registry is a plain object/map literal of name → container element, populated with `document.getElementById` the same way today's `homeView`/`wizardView`/`connectView` refs are captured (`ui/renderer.js:67-69`) — no new lookup/caching abstraction, just more entries in the same style.
- `showView(name)` keeps its existing name and external call contract — same callers (`enterWizard`, `boot()`'s routing branches, `CODEMIE_SMOKE`/`CODEMIE_PROBE_SMOKE` forcing `showView('wizard')`) keep working unmodified. Internals generalize to iterate the registry instead of three hardcoded refs; this is the minimal change that satisfies "six named views, no reload" — no plugin points, no lifecycle hooks, no extensibility beyond what's listed here.
- Switching sets `hidden` on the outgoing container and clears it on the incoming one — no reload, consistent with today's mechanism, just generalized.
- **Connections** = today's `connectView` markup/logic, re-pointed at the new router; not rebuilt.
- **Setup**, **Agents**, **Health** and **About** are net-new empty named containers — content is out of scope. Setup is deliberately separate from `wizard-view`, which the legacy engine renders `step-list` into; two flows sharing one container would clear each other's rows.
- `showView` also marks the matching sidebar entry with `aria-current="page"`, so the highlight and the accessible state cannot drift apart. Setup and About have no entry, so routing to them leaves every entry unmarked; `CODEMIE_DEV=1` exposes the router as `window.__codemie.showView` to reach them.
- **Wizard** is not a sidebar nav item; it is entered from the Home grid's "Full installation" tile or the notice modal (`enterWizard`, as today) and must still be one of the router's registered views so smoke/probe's direct `showView('wizard')` call and its `.step-row` assertions keep working.

## Sidebar
Two groups, visually divided:
- Main nav group (persistent, visible from first run): Home, Agents, Connections, Health.
- Bottom group: About sits here, but **ships hidden** — no sub-task owns its content, and an entry opening a blank view is worse than no entry. The divider is hidden with it, its only purpose having been to separate it from the main group. A sidebar analytics entry is likewise hidden: a sidebar entry is a *new* entry point, which the parent defers. Both keep their container, routing and wiring, so one class restores each.
- Nav items are plain elements with click listeners wired in `boot()`, following the same `addEventListener` + `showView(...)` wiring style already used for the current view switches — no new component system or event-delegation abstraction beyond what `homeGrid`'s existing delegated click handler already does.

## Identity bar
Persistent bar, always visible, independent of the active view. Fields:
- **Auth status** — live, from the existing `check_profile_status`. It misreports any provider that prints no Auth Status row; EPMCDME-14515 owns the fix and must update this caller and the Connections gate.
- **Account**, **active profile**, **model**, **project** — read at run time from `~/.codemie/codemie-cli.config.json` through a new command, `read_codemie_config`, in the order `01-home.png` draws them. None ships hard-coded or as an em-dash. The command returns `state`, `profile`, `model`, `project` and `account`; `profile` carries the file's `activeProfile` value, and `account` is `null` when the config records no `userEmail`, which paired with `state` distinguishes an absent account from an unread one. `state` is one of three named values: `no-configuration`, `valid`, `broken`. An empty segment is hidden by CSS along with its separator, which is how the absent-account and no-configuration cases render — the latter showing the product name instead.
- **Version badge** — the *latest* available version from `cliVersionState.latest`, never the installed one. Absent when no update is available, and it survives the banner being dismissed: the badge reports whether an update exists, the banner whether the user still wants to be told.
- **Theme toggle** — the existing control, moved in as the bar's last child.

## Footer log region and update-banner region
- New named, empty, collapsible container for "what CodeMie ran": id `command-log-footer`. Empty at handoff — no internal contents, behavior, or data model designed here; that's S9's job.
- Update banner: reuse the existing `#update-banner` element id, relocated into the new shell markup (not renamed), so `showUpdateBanner()`/`dismissUpdateBanner()` (`ui/renderer.js:191-207`) keep working unmodified. Their side effects on `#installation-group` and `#update-cli-tile` are **kept**, guarded so they no-op once EPMCDME-14589 removes the grid. The ticket's build order assumed the grid was going away; it was not, and the update-available cue is carried-forward behaviour. The **Update CLI** action gains a button on the banner, whose own copy points at it, but the grid tile still invokes the same function — so `runUpdateCli` renders progress on whichever surface exists, holds a re-entrancy guard, and makes the sibling tiles inert while it runs, as `origin/main` does.

## The home grid, and analytics
The grid is kept: no acceptance criterion requires its removal and Home's content belongs to EPMCDME-14589. So all five of its actions — `full`, `install-only`, `connect-desktop`, `update-cli`, `analytics` — retain an entry point and nothing is orphaned. `runAnalytics()` stays on its tile, unchanged, including its pre-0.4.1 version check. What the parent defers is an in-app usage and spend *surface*; this is a CLI passthrough Connect 2.0.1 ships today. EPMCDME-14589 inherits the grid's removal and the `install-only` and `analytics` decisions with it.

## Window size
1000x660. The sidebar takes 180px off the content column and the new chrome takes height; at the previous fixed 900x600 the home grid was squeezed below its content and its tiles rendered over the footer. Three places must agree — the Tauri config, `WIN_WIDTH` (which `set_window_height` rewrites on every log toggle), and the log panel's collapsed height.

## Acceptance criteria
- Sidebar shows Home, Agents, Connections and Health on first load, and no other entries.
- Identity bar renders account, profile, model and project read at run time from the config file — none hard-coded, none an em-dash, an absent account omitted rather than filled in. With no config file the bar shows the product name and the app starts normally.
- The reader reports three named, distinguishable states and an absent account distinguishably from an unread one.
- `setup-view` exists as an empty routed container, distinct from `wizard-view`.
- The version badge shows the latest available version and is absent when none is available; with an update pending the banner works in its shell region and Update CLI runs from it.
- Clicking through all six views causes no full page reload; each renders inside the same shell via the registry-based `showView`.
- `#command-log-footer` and `#update-banner` exist as named, empty/ready slots untouched by this ticket's follow-up work.
- Every grid action keeps an entry point and no behaviour that ships on `origin/main` is lost — analytics included, with zero changes to `runAnalytics`.
- No view reachable from the sidebar is empty, and no content overlaps another element at the shipped window size.
- `CODEMIE_SMOKE`/`CODEMIE_PROBE_SMOKE` boot paths still pass: `showView('wizard')` still works and still exposes `.step-row` elements as probed today.

## Non-goals
- No content for Agents, Health, or About beyond an empty named container (owned by other tickets).
- No redesign of the Connections/Connect-Desktop flow — only re-homing under new routing.
- No change to the analytics report or to `runAnalytics`/`runUpdateCli` internals.
- No Rust beyond the one config-read command and its registration; no `tauri-plugin-fs`, and no generic "identity data provider" abstraction.
- No fix for the `check_profile_status` parser (EPMCDME-14515), no `steps-ui` instance refactor (EPMCDME-14513), no `showNotice` extension (EPMCDME-14588).
- No new architectural style: no framework, no state-management library, no build-step change, no new runtime dependency. DOM lookup/caching, event wiring, and per-view init follow the exact patterns already in `renderer.js`.
- No router extensibility (plugin points, per-view lifecycle hooks, nested/child routes) beyond registering six named containers and toggling `hidden` — the current mechanism generalized, nothing more.
- No design of the footer log's or update banner's internal contents/behavior — both are empty named containers only, per ticket (owned by S9/S4).
- No renaming/rebranding (`productName`, window title in `src-tauri/tauri.conf.json`) — owned by S6/EPMCDME-14509.
- No test-framework introduction beyond what's needed to cover the new router if the team chooses to add coverage — not mandated by this spec.

## Residual risks
- The identity bar's auth segment misreports a valid profile on any provider printing no Auth Status row — reproduced live on `anthropic-subscription`. Deferred to EPMCDME-14515.
- The badge now survives banner dismissal, where it previously did not — grounded in the wireframe but a deliberate behaviour change, reversible in one line.
- About ships with no owner: container and routing exist, nothing fills it, entry hidden. EPMCDME-14509 is the nearest candidate, unagreed.
- There is no CI: the four gates and the browser suite run locally only, and the smoke modes print rather than assert.
- Dropping `#installation-group`/`#update-cli-tile` side effects from `showUpdateBanner`/`dismissUpdateBanner` is a deliberate behavior change (those visual side effects simply no longer apply); if a future ticket expects an equivalent affordance in the new shell, it isn't provided here.
- `.ai-run/guides/architecture/architecture.md` will be stale once this shell lands (still describes `renderer.js` as owning "View routing (home/wizard/connect)"); updating it is not this ticket's job but is a known follow-up gap.

