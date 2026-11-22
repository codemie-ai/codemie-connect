# Compact view (step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings › Appearance › View (Compact | Default): Compact uses Naya's sizes everywhere and Naya's layout on Inbox and Today. Today's toolbar moves into one ⋯ menu in both views, and main-menu pages can be hidden.

**Architecture:** Two app-wide native settings (`view`, `hiddenPages`) travel in the snapshot. The window mirrors `view` onto `data-view` on `#workspace-app` and `<html>` and into localStorage for the first paint. `workspace.css` moves its sizes onto `--ws-*` size tokens whose Default values are today's pixels, so Default is pixel-identical, and Compact overrides the tokens. Compact Inbox renders the list section only, with rows that open in place (`state.openMessage`, separate from `state.selectedMessage`). Compact Today drops the avatar and greeting. Hidden pages are filtered in `renderShell` and stay reachable by route.

**Tech Stack:** Rust (Tauri v2), `cargo test`; vanilla JS ES modules, `node:test`; Playwright (`playwright-core` 1.63) browser run against the mocked bridge.

**Spec:** `docs/superpowers/specs/2026-11-22-compact-view-design.md`. Definition of done: `docs/superpowers/specs/2026-11-22-workspace-next-rollout-design.md` § "Definition of done for every step".

## Global Constraints

- Branch `feat/workspace-next` (already checked out). Do not switch branches and do not push. One commit per task, Conventional Commit subject, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Raw `cargo` runs from `src-tauri/` with `export PATH="$HOME/.cargo/bin:$PATH"`. `make`, `npm` and `node` run from the repo root, with macOS/zsh syntax.
- `ai::profiles::tests::detects_native_and_codemie_states_and_caches` already fails on this Mac before any change. Skip it by name: `cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`.
- Browser run: `PLAYWRIGHT_CORE=/Users/Nikita_Levyankov/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs`, outside the sandbox (it binds loopback). One set: prefix with `WORKSPACE_E2E_ONLY=compact` (or `layout`, `plugins`, …). The whole run takes more than 10 minutes, so use `timeout: 600000` with `run_in_background`.
- Values from the spec, verbatim:
  - Setting values: `view` is `"default"` or `"compact"`, default `"default"`. `hiddenPages` is a list of ids from `NAV`: `today, inbox, calendar, meetings, tasks, automations, analytics`.
  - Compact sizes: body 13, secondary 12, meta 11, small labels 10.5. Page title 20 (Today and Inbox 22). Spacing 4 / 8 / 12 / 16 / 24. Menu rows 28 px. Inputs and buttons 28 px. Control radius 6, row radius 8. The font stays Geist Mono (`--font-ui`).
  - Today's grid keeps `GRID.rowHeight` 56 and the 72 px row step in `.ws-tiles` in both views.
  - Compact text never goes below 10.5 px, and focus rings keep their size.
  - The open row's thread is at most 260 px tall and scrolls, with "Earlier" to show all of it.
- Copy, verbatim: card "View", segmented "Compact | Default", line "Compact uses smaller text and opens messages in place." Today ⋯ items: "Layouts", "Add widget", "Customize", "Lock layouts" / "Unlock layouts". Menu card "Menu", line "Hidden pages leave the menu. Links and notifications still open them.", tooltip on the last visible switch "Keep one page in the menu."
- Workspace data changes go through `mutate('settings_update', {...})` (`settings_update` is already in `REBASE_SAFE`, `ui/workspace/store.js:20`). Views stay pure (`view-*.js`, `shell.js`, `settings-layout.js`, `today-edit-view.js`, new `view-mode.js` and `inbox-open.js`); only `app.js` touches the DOM.
- Escape provider text with `escapeHtml` (imported as `e`). Plugin frames (`ui/plugins/frame/`) are not resized.
- Contract fixtures: after the settings shape changes, run `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures` and commit the JSON.

## Rulings on spec gaps (recorded for review)

1. **No fixture holds settings today.** Task 1 adds `settings-view.json`, written from the real `update_settings`. `workspace-fixture.mjs` takes its defaults from that file.
2. **The `hiddenPages` save rule.** A value that is not an array is refused (`validation`, "Choose pages from the menu."). Non-string items, unknown ids and duplicates are dropped, and the result is stored in `NAV` order. Native accepts all seven hidden (the spec covers that case); only the UI keeps one page visible.
3. **Token names and scope.** Text tokens cover the Default sizes 10.5–18 px and the page titles. Default sizes under 10.5 px (count dots, rail marks, badges at 8.5 / 9 / 10 px) and display numbers (KPI values, the timer, agenda day numbers at 19 / 22+ px) keep raw values in both views. "Never below 10.5" therefore means no token's Compact value is under 10.5. `--ws-topbar-h` and `--ws-sidebar-w` are unchanged.
4. **Where `data-view` lives.** It goes on `#workspace-app` (per the spec) and also on `<html>`, so dialogs, toasts and the setup sheet, which sit outside `#workspace-app`, use the same tokens. Token overrides use `html[data-view="compact"]`; layout rules use `#workspace-app[data-view="compact"] …`. `app.js` reads the mirror at import. `ui/theme-init.js` is not changed, because it runs in `<head>` before `#workspace-app` exists and the page is empty until the first render.
5. **Compact Inbox has no dock frame.** It renders the list section alone inside `div.ws-inbox-compact`, not through `renderDock`, so no `dock-*` action can write `codemie.layout.inbox.v1` (the Default layout stays untouched).
6. **Opening a specific message from elsewhere** (a Today row with `open-message`, or a notification) selects it and also opens it in Compact. "Loads with every row closed" applies to arriving at the Inbox without a target.
7. **Typed reply across a view switch.** The view is switched from Settings, so the reply box always leaves the screen. Unsaved reply text is kept in memory per draft key (`state.replyCarry`) and restored the next time that message's box is drawn with nothing newer in it. This is in both views, so leaving the Inbox no longer loses typing in Default either. List scroll survives opening and closing rows, but not a route change (as today).
8. **Next selection after Done, Snooze or a lane move** (the row after the removed one, else the one before) applies in Compact only. Default keeps `ensureSelection`'s first-row pick.
9. **The open row's order** follows the spec's text (actions, summary, thread, reply), not the ASCII mock that shows Snooze and ⋯ after the reply buttons. Its actions bar shows Done, Snooze ▾, Acknowledge (on an unacknowledged critical message only) and ⋯ (Open in Outlook/Teams, Summarize, Move to lane, Add a task).
10. **The Compact Today header** keeps a visually hidden `<h1>Today</h1>` (`.ws-sr`) so `route()` still focuses a heading. The summary keeps today's wording ("N messages need you"). Each part is a button: meetings and free time open Calendar, "need you" opens Inbox on the Needs reply lane. Default's summary stays plain text.
11. **Today hidden.** Only a launch with an empty hash opens the first visible page in `NAV` order. With all pages hidden it opens Today. An explicit `#/today` still opens Today.
12. **Settings › Layout copy.** "The lock button on Today does the same." becomes "Lock layouts in Today’s ⋯ menu does the same."
13. **Proving Default unchanged.** The test is a computed-size dump of every element on ten Default screens with a fixed clock, hashed per screen against a committed baseline. A screen that a later task changes on purpose in Default (Appearance, Layout, Today header) is re-recorded by that task, and the commit says why.

## Review Focus

1. A reply typed in Default, then Settings › Compact, then back to Inbox: the row is still selected and closed, and opening it shows the typed text. Switching back to Default shows the same text in the reading pane. (Task 7, C6.)
2. A Teams chat whose newest message arrives while its row is open in Compact: the row stays open on that conversation and the typed text survives. (Task 7, `followOpen` unit test.)
3. The user hides the page they are on, or hides Today and relaunches, or a notification points at a hidden page. They stay on the page with its row greyed, the app opens on the first visible page, and the notification still opens its page. (Task 6, C5.)
4. ↵ on a focused row button toggles the row once, not twice. Esc with a ⋯ menu open closes only the menu. j and k typed in the search box or the reply box stay letters. (Task 7, C6.)
5. The localStorage mirror disagrees with native (says `compact`, native says `default`) or holds garbage. The first paint follows the mirror (or Default for garbage), then the snapshot wins and the mirror is rewritten. (Task 3, unit test and C1.)

---

### Task 1: Native `view` and `hiddenPages` settings, contract fixture, fixture and mock

**Files:**
- Modify: `src-tauri/src/workspace/models.rs:212-262` (`Settings` and its `Default`)
- Modify: `src-tauri/src/workspace/mod.rs:1284-1415` (`update_settings`), add `MENU_PAGES` beside `SYNC_EVERY_MIN` (:2029), tests in `mod tests` (:2285, next to `settings_update_takes_a_supported_sync_interval_only` at :2308)
- Create: `ui/test/fixtures/contract/settings-view.json` (generated)
- Modify: `ui/test/fixtures/workspace-fixture.mjs:137-141` (`settings`)
- Modify: `ui/test/browser/workspace-e2e.mjs:251-263` (mock `settings_update`)
- Create: `ui/test/view-mode.test.mjs`

**Interfaces:**
- Produces: `Settings.view: String` and `Settings.hidden_pages: Vec<String>`, serialized as `view` and `hiddenPages` (the struct is already `camelCase` and `#[serde(default)]`). `const MENU_PAGES: [&str; 7] = ["today","inbox","calendar","meetings","tasks","automations","analytics"]` in `mod.rs`, documented as `ui/workspace/shell.js` `NAV` in menu order. Contract file `settings-view.json` = `{"default":{"view":"default","hiddenPages":[]},"updated":{"view":"compact","hiddenPages":["calendar","tasks"]}}`. The UI fixture's `settings` gains `view` and `hiddenPages` from that file's `default`.

- [ ] **Step 1: Write the failing Rust tests** in `mod.rs` `mod tests`:

```rust
#[tokio::test] async fn settings_update_takes_a_known_view_only()
// set {"view":"compact"} → settings().view == "compact"; {"view":"dense"} → Err code "validation", message "Unknown view.", view still "compact"
#[tokio::test] async fn settings_update_keeps_known_menu_pages_in_menu_order()
// {"hiddenPages":["tasks","nope","calendar","tasks",3]} → hidden_pages == ["calendar","tasks"]
// {"hiddenPages":"calendar"} → Err "validation" "Choose pages from the menu.", hidden_pages unchanged; {"hiddenPages":[]} → []
#[test] fn older_settings_read_as_the_default_view_with_no_hidden_pages()
// serde_json::from_str::<Settings>(r#"{"syncDays":7}"#) → view "default", hidden_pages empty
#[tokio::test] async fn contract_fixtures_match_the_real_settings()
// fresh core: default = {view, hiddenPages} from serde_json::to_value(settings());
// then settings_update {"view":"compact","hiddenPages":["tasks","nope","calendar"]}; updated = same fields;
// crate::plugins::testkit::contract_fixture("settings-view.json", &json!({"default":…, "updated":…}))
```

Build requests with `mutation(&core, Operation::SettingsUpdate, json!(…))` over `test_core(...)`, as the sync-interval test does.

- [ ] **Step 2: Run them and see them fail**

Run: `cd src-tauri && cargo test workspace::tests::settings_update_ workspace::tests::older_settings`
Expected: FAIL to compile (`no field view on Settings`).

- [ ] **Step 3: Implement.** Add the two fields (`/// Settings › Appearance › View: "default" or "compact" (app-wide, like theme).` and `/// Main-menu pages left out of the menu (ids from NAV, in menu order).`) with defaults `"default".into()` and `Vec::new()`. In `update_settings`, after the theme check, validate `data["view"]` the way `theme` is validated. For `data.get("hiddenPages")`: refuse a non-array, else `s.hidden_pages = MENU_PAGES.iter().filter(|p| given.contains(p)).map(|p| p.to_string()).collect()`.

- [ ] **Step 4: Write the fixture and run the Rust suite**

Run: `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures_match_the_real_settings && cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`
Expected: `settings-view.json` matches the shape in Interfaces, and every test passes.

- [ ] **Step 5: Write the failing UI test** `ui/test/view-mode.test.mjs`:

```js
test('the fixture settings carry native’s defaults for view and hiddenPages', () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/contract/settings-view.json', import.meta.url))).default;
  const { view, hiddenPages } = buildSnapshot(Date.now()).settings;
  assert.deepEqual({ view, hiddenPages }, native);
});
```

Run `node --test ui/test/view-mode.test.mjs`: it FAILS (`view` undefined).

- [ ] **Step 6: Implement the fixture and the mock.** In `workspace-fixture.mjs`, spread `contract('settings-view').default` into `settings`. In the mock `settings_update` (`workspace-e2e.mjs:251`), refuse a `view` outside `['default','compact']` the way the mock already refuses (`{code:'validation', message:'Unknown view.'}`), and store `hiddenPages` filtered to the NAV ids in NAV order (import `NAV` from `../../workspace/shell.js`).

- [ ] **Step 7: Run** `npm test`. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/workspace/models.rs src-tauri/src/workspace/mod.rs ui/test/fixtures ui/test/view-mode.test.mjs ui/test/browser/workspace-e2e.mjs
git commit -m "feat(settings): app-wide view and hidden menu pages in native settings"
```

### Task 2: Size tokens with Default pixel-identical, proven in the browser run

**Files:**
- Create: `ui/test/browser/compact-checks.mjs` (check C0 and the size dump)
- Create: `ui/test/fixtures/default-sizes.json` (baseline, written before the CSS changes)
- Modify: `ui/test/browser/workspace-e2e.mjs` (`open` at :1205-1240 gains `now`; `WORKSPACE_E2E_ONLY` list at :1249-1258 and the full run at :2995-3011 call `compactChecks`)
- Modify: `ui/workspace/workspace.css` (new size-token `:root{}` block after the colour blocks near :6-62; rules moved onto tokens)

**Interfaces:**
- Produces:
  - `open({ now })`: when given, `buildSnapshot(now, …)` uses it and `await context.clock.setFixedTime(now)` runs before `goto`. `FIXED_NOW = Date.parse('2026-11-18T09:30:00+02:00')` is exported from `compact-checks.mjs`.
  - `export async function compactChecks({ open, check, assert, shot, settled, calls, OUT })` in `compact-checks.mjs`, registered under `WORKSPACE_E2E_ONLY=compact` and called in the full run after `layoutChecks`.
  - `sizesOf(page) -> Array<[tag, className, fontSize, lineHeight, width, height, padding, margin, gap, borderRadius]>` covers every element under `#workspace-app` in document order, skipping `iframe` subtrees and `.ws-toasts`. Width and height are `getBoundingClientRect()` rounded to 0.01.
  - Baseline `default-sizes.json` = `{ "<screen>": { "count": n, "sha256": "<hex>" } }` for the screens `today, inbox, calendar, meetings, tasks, automations, analytics, settings-general, settings-appearance, settings-layout`. Each is opened with `{ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, meetings: true, automations: true }` and its hash, after `document.fonts.ready` and `settled`. `WORKSPACE_E2E_SIZES=write` rewrites every screen; `=write:today,settings-layout` rewrites the named ones. Each run also writes the full dumps to `OUT/sizes-<screen>.json`.
  - Size tokens on `:root` (Default = today's pixels; Task 4 sets the Compact column):

| Token | Default | Compact (Task 4) | Replaces |
|---|---|---|---|
| `--ws-fs-label` | 10.5px | 10.5px | `font-size:10.5px` |
| `--ws-fs-meta` | 11px | 11px | `11px` |
| `--ws-fs-meta-lg` | 11.5px | 11px | `11.5px` |
| `--ws-fs-secondary` | 12px | 12px | `12px` (also `12px!important`) |
| `--ws-fs-secondary-lg` | 12.5px | 12px | `12.5px` (also `!important`) |
| `--ws-fs-body-sm` | 13px | 13px | `13px` |
| `--ws-fs-body-lg` | 13.5px | 13px | `13.5px` |
| `--ws-fs-body` | 14px | 13px | `14px`, `#workspace-app` base (:139), `.ws-input` (:276) |
| `--ws-fs-heading-sm` | 15px | 14px | `15px` |
| `--ws-fs-heading` | 16px | 15px | `16px` |
| `--ws-fs-heading-md` | 17px | 15px | `17px` |
| `--ws-fs-heading-lg` | 18px | 15px | `18px` |
| `--ws-fs-title` | 24px | 20px | `.ws-page-heading h1,.ws-today-title h1` (:220) |
| `--ws-fs-title-md` | 22px | 20px | `.ws-mtg-list-title h1` (:2192) |
| `--ws-fs-title-sm` | 20px | 20px | `.ws-inbox-title h1` (:954), `.ws-settings-heading h1` (:1104) |
| `--ws-lh-body` | 20px | 18px | `#workspace-app` line-height (:139) |
| `--ws-page-pad` | 28px 32px 48px | 16px 24px 24px | `.ws-page` (:216) |
| `--ws-card-pad` | 16px 18px | 12px 16px | `.ws-card-body` (:355) |
| `--ws-card-head-h` / `--ws-card-head-pad` | 52px / 0 16px 0 18px | 40px / 0 12px 0 16px | `.ws-card-header` (:350) |
| `--ws-setting-pad` | 14px 0 | 12px 0 | `.ws-setting-row` (:1119) |
| `--ws-inbox-head-pad` / `--ws-inbox-head-gap` | 18px 16px 12px / 12px | 12px 16px 8px / 8px | `.ws-inbox-head` (:952) |
| `--ws-row-pad` | 11px 12px | 6px 8px | `.ws-inbox-row` (:968) |
| `--ws-bubble-pad` | 12px 14px | 8px 12px | `.ws-bubble` (:997) |
| `--ws-reply-pad` | 14px | 12px | `.ws-reply` (:1003) |
| `--ws-today-head-mb` | 24px | 16px | `.ws-today-head` margin-bottom (:433) |
| `--ws-nav-row-h` / `--ws-r-nav` | 30px / 7px | 28px / 6px | `.ws-nav button` (:159) |
| `--ws-input-h` | 32px | 28px | `.ws-input,.ws-textarea,.ws-select` height (:276), `.ws-search input` (:957) |
| `--ws-menu-item-h` | 32px | 28px | `.ws-menu-item` (:388) |
| `--ws-r-control` | 8px | 6px | `.ws-btn` (:242), `.ws-input…` (:276), `.ws-search input` (:957), `.ws-segmented` (:324) |
| `--ws-r-row` | 10px | 8px | `.ws-inbox-row` (:968), `.ws-bubble` (:997), `.ws-reply` (:1003) |

- [ ] **Step 1: Write check C0** in `compact-checks.mjs`: `check('compact C0: Default sizes match the baseline on every screen', …)`. For each screen, assert `count` and `sha256` equal the baseline entry. On a mismatch, name the screen and the first differing index, compared against `OUT/sizes-<screen>.baseline.json` when that file exists.

- [ ] **Step 2: Record the baseline before touching CSS**

Run: `WORKSPACE_E2E_SIZES=write WORKSPACE_E2E_ONLY=compact PLAYWRIGHT_CORE=… node ui/test/browser/workspace-e2e.mjs`, then the same without `WORKSPACE_E2E_SIZES`.
Expected: `default-sizes.json` lists all ten screens, and the second run prints `compact C0` PASS twice in a row (the fixed clock makes it stable). If it is not stable, fix the cause (time, animation, fonts) before going on.

- [ ] **Step 3: Move the rules onto the tokens.** Add the token block. Replace every `font-size:<v>px` whose value is in the table with its token, using exact-value replacement (BSD `sed -i ''` per value, anchored on `font-size:<v>px`, keeping `!important`). Change only the listed rules for spacing, heights and radii. Leave every other raw value alone.

- [ ] **Step 4: Prove Default is unchanged**

Run: `WORKSPACE_E2E_ONLY=compact … node ui/test/browser/workspace-e2e.mjs` and `WORKSPACE_E2E_ONLY=layout …`
Expected: C0 PASS on all ten screens, and E1–E8 PASS. `grep -c "font-size:var(--ws-fs-" ui/workspace/workspace.css` is about 600, and `grep -cE "font-size:(10\.5|11|11\.5|12|12\.5|13|13\.5|14|15|16|17|18)px" ui/workspace/workspace.css` is 0.

- [ ] **Step 5: Commit**

```bash
git add ui/workspace/workspace.css ui/test/browser/compact-checks.mjs ui/test/browser/workspace-e2e.mjs ui/test/fixtures/default-sizes.json
git commit -m "refactor(ui): size tokens in workspace.css, Default unchanged by computed sizes"
```

### Task 3: The View setting, `data-view` and the localStorage mirror

**Files:**
- Create: `ui/workspace/view-mode.js`
- Modify: `ui/workspace/view-settings.js:262-268` (`appearancePanel`)
- Modify: `ui/workspace/app.js` (after `const root` :58; `applyTheme` :229-240; `render` :413 and ctx :415-427; `handle` beside `case 'theme'` :2041; `store.subscribe` :2983)
- Modify: `ui/test/view-mode.test.mjs`, `ui/test/settings-menu.test.mjs`
- Modify: `ui/test/browser/workspace-e2e.mjs` (`open({ settings })`), `ui/test/browser/compact-checks.mjs` (C1), `ui/test/fixtures/default-sizes.json` (re-record `settings-appearance`)

**Interfaces:**
- Consumes: `Settings.view` from Task 1.
- Produces, in `view-mode.js`: `VIEW_KEY = 'codemie.view'`; `viewOf(settings) -> 'compact'|'default'` (anything else is `'default'`); `readViewMirror(storage) -> 'compact'|'default'` (a throw or a garbage value gives `'default'`); `writeViewMirror(storage, view) -> void` (swallows a throw).
- Produces, in `app.js`: `applyView(view)` sets `root.dataset.view` and `document.documentElement.dataset.view` and writes the mirror. `setView(view)` calls `applyView(view)` at once, then `mutate('settings_update', { view })`. The action is `view-set` with `data-view`. The render ctx gains `view: viewOf(s.settings)`.
- Produces, in e2e: `open({ settings })` merges into `snapshot.settings` before load.

- [ ] **Step 1: Write the failing unit tests**

```js
test('viewOf reads compact only', () => { assert.equal(viewOf({ view: 'compact' }), 'compact'); assert.equal(viewOf({ view: 'dense' }), 'default'); assert.equal(viewOf({}), 'default'); });
test('the mirror reads garbage and a throwing storage as default and writes without throwing', () => { /* fake {getItem,setItem}; getItem→'x' → 'default'; getItem throws → 'default'; setItem throws → no throw; write then read 'compact' */ });
// settings-menu.test.mjs:
test('Appearance shows the View card with Compact and Default', () => {
  // settings(s,…) on tab appearance, s.settings.view='compact'
  assert.match(html, /<h2 class="ws-card-title">[^]*?View<\/h2>/);
  assert.match(html, /data-action="view-set" data-view="compact" aria-selected="true">Compact/);
  assert.match(html, /data-action="view-set" data-view="default" aria-selected="false">Default/);
  assert.match(html, /Compact uses smaller text and opens messages in place\./);
});
```

- [ ] **Step 2: Run** `node --test ui/test/view-mode.test.mjs ui/test/settings-menu.test.mjs`. Expected: FAIL (module missing, no View card).

- [ ] **Step 3: Implement.** `appearancePanel` appends `card({ title: 'View', iconName: 'layout', body: segmented([['compact','Compact'],['default','Default']], viewOf(s.settings), 'view-set', 'view', 'View') + hint })` after the Theme card. In `app.js`: at import, `const firstView = readViewMirror(localStorage)` inside a try (default `'default'`), assigned to both `dataset.view`s. Call `applyView(viewOf(s.settings))` wherever `applyTheme(s.settings.theme)` runs (render and `store.subscribe`). Add `case 'view-set': return setView(el.dataset.view);`.

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Add check C1** to `compact-checks.mjs`, with a dark and a light run:
  - Settings › Appearance → click Compact. A `settings_update` `{view:'compact'}` is recorded (`calls`). `#workspace-app[data-view=compact]` and `html[data-view=compact]` are set with no reload. `localStorage['codemie.view'] === 'compact'`. The screenshot `compact-c1-appearance-<theme>` is saved.
  - Reload. An init script records `#workspace-app.dataset.view` when its first child appears, and it is `'compact'`.
  - Mirror disagreement (Review Focus 5): `open({ localPrefs: { 'codemie.view': 'compact' } })` with native `default` records first `'compact'`, then after the snapshot `data-view === 'default'` and the mirror is `'default'`. A mirror value of `'zzz'` records first `'default'`.

- [ ] **Step 6: Re-record `settings-appearance`** (`WORKSPACE_E2E_SIZES=write:settings-appearance`) after looking at its screenshot: only the View card was added. Then run `WORKSPACE_E2E_ONLY=compact …`. Expected: C0 and C1 PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/workspace/view-mode.js ui/workspace/view-settings.js ui/workspace/app.js ui/test
git commit -m "feat(ui): Settings › Appearance › View, applied at once with a first-paint mirror"
```

### Task 4: Compact token values and size overrides

**Files:**
- Modify: `ui/workspace/workspace.css` (an `html[data-view="compact"]{…}` block after the token block; page-title overrides beside :220, :954)
- Modify: `ui/test/browser/compact-checks.mjs` (C2 matrix, C3 sizes)

**Interfaces:**
- Consumes: the token table (Task 2), `data-view` on `<html>` and `#workspace-app` (Task 3), `open({ settings, now })`.
- Produces: `MATRIX_ROUTES = ['today','inbox','calendar','meetings','tasks','automations','analytics','settings/appearance','settings/layout']` and the helper `noClip(page) -> string[]` in `compact-checks.mjs`. `noClip` returns the selectors of `.ws-btn, .ws-nav button, .ws-menu-item, .ws-lane, .ws-segmented button, .ws-inbox-row, .ws-input` elements whose `scrollHeight > clientHeight + 1` or whose text is cut without an ellipsis (`scrollWidth > clientWidth + 1` and `text-overflow` is not `ellipsis`). Task 7 adds its own rows to that list.

- [ ] **Step 1: Write C2 and C3**
  - C2 `compact C2: <theme> <view> <width>: no horizontal overflow, nothing clipped`: for `theme` × `view` in {compact, default} × `width` in {1000, 1440, 1680}, open each `MATRIX_ROUTES` entry (hash `#/<route>`). Assert `main.scrollWidth - main.clientWidth <= 0` and `documentElement.scrollWidth - clientWidth <= 0` (the `noOverflow` of `layout-checks.mjs:49-56`), assert `noClip(page)` is empty, and save `compact-<theme>-<view>-<width>-<route with / as ->`.
  - C3 `compact C3: Compact uses Naya’s sizes`, at 1440 in Compact: computed `#workspace-app` font-size `13px` and line-height `18px`; `.ws-nav button[data-route=inbox]` height `28px`; `.ws-input` height `28px`; `.ws-btn` border-radius `6px`; `#inbox-search` height `28px`; `.ws-page-heading h1` (on Tasks) `20px`; `.ws-inbox-title h1` `22px`; every `--ws-fs-*` on `html` ≥ 10.5. `[data-tile=brief]` has the same `offsetHeight` in Compact and Default (grid rows unchanged). The `:focus-visible` outline on a focused `.ws-btn` is `2px`.

- [ ] **Step 2: Run** `WORKSPACE_E2E_ONLY=compact …`. Expected: C3 FAILS (no Compact values yet). C2 passes, or fails only where Compact needs work.

- [ ] **Step 3: Implement** the Compact column of the token table in `html[data-view="compact"]`. Add `#workspace-app[data-view="compact"] .ws-inbox-title h1{font-size:22px;line-height:28px}`. The Compact Today title is the visually hidden h1 from Task 5, so it needs no rule. Fix every C2 clip by adjusting a Compact-only rule next to the original. Never change a Default value (C0 guards this).

- [ ] **Step 4: Run** `WORKSPACE_E2E_ONLY=compact …` and `WORKSPACE_E2E_ONLY=layout …`. Expected: C0–C3 PASS, E1–E8 PASS. Look at the 1000 px Compact screenshots in both themes.

- [ ] **Step 5: Commit**

```bash
git add ui/workspace/workspace.css ui/test/browser/compact-checks.mjs
git commit -m "feat(ui): Compact sizes from Naya on every page, checked at three widths in both themes"
```

### Task 5: Today's ⋯ menu (both views) and Compact Today

**Files:**
- Modify: `ui/workspace/today-edit-view.js:19-34` (`layoutMenu` split, new `todayMenu`)
- Modify: `ui/workspace/view-today.js:134-197` (`today` header and actions), `:230-238` (`daySummary`)
- Modify: `ui/workspace/settings-layout.js:21-27` (`movingCard` copy, ruling 12)
- Modify: `ui/workspace/workspace.css` (`.ws-today-head-compact`, `.ws-today-sum-link`, near :433)
- Modify: `ui/test/today-controller.test.mjs:435-457`, `ui/test/workspace.test.mjs` (Compact Today test), `ui/test/settings-menu.test.mjs:123` (if it matches the old copy)
- Modify: `ui/test/browser/layout-checks.mjs` (:59-62, :304, :321, :351-356, :380-395), `ui/test/browser/plugins-checks.mjs:184`, `ui/test/browser/workspace-e2e.mjs:1359` (open ⋯ first), `ui/test/browser/compact-checks.mjs` (C4), `ui/test/fixtures/default-sizes.json` (re-record `today`)

**Interfaces:**
- Consumes: `ctx.view` (Task 3).
- Produces:
  - `layoutItems(t) -> string`: the rows, save form and Reset that `layoutMenu` draws today. `layoutMenu(t, {small})` keeps its markup (the edit bar uses it) and is built from `layoutItems`.
  - `todayMenu(t, { locked }) -> string` = `<details class="ws-menu ws-menu-right ws-today-more" data-menu="today-more">`. Its summary is a ghost icon button with `icon('dots')`, `aria-label="Today options"` and `aria-haspopup="menu"`. Its panel (`role="menu"`) holds `<div class="ws-menu-label">Layouts</div>` + `layoutItems(t)` + `<hr>` + menu items `today-customize` (`data-focus="gallery"`, "Add widget"), `today-customize` ("Customize"), and `today-lock` (`aria-pressed`, "Lock layouts" / "Unlock layouts").
  - `daySummaryParts(m) -> Array<{ text, route, lane? }>`: meetings and free time get `route: 'calendar'`, "need you" gets `route: 'inbox', lane: 'reply'`. `daySummary(m)` joins the texts with ` · `, unchanged.
  - Header actions are `editing ? '' : todayMenu(t, { locked })` in both views.

- [ ] **Step 1: Update and add the failing tests**
  - In `today-controller.test.mjs` 'Customize mode draws…', replace the three header assertions with: `/<details class="ws-menu ws-menu-right ws-today-more" data-menu="today-more">/`, `/<div class="ws-menu-label">Layouts<\/div>[^]*?data-action="today-layout-use"[^>]*>[^]*?<span>Default<\/span>/`, `/role="menuitem" data-action="today-customize" data-focus="gallery">[^]*?Add widget/`, `/data-action="today-lock" aria-pressed="true">[^]*?Unlock layouts/`, and `doesNotMatch(/ws-today-layout-pill/)`. Keep the `today-layout-save` assertion and the empty-actions assertion.
  - New test in `workspace.test.mjs`, 'Compact Today: date over the summary line, no avatar or greeting, each part opens its page', with `ctx.view = 'compact'`: `doesNotMatch(/ws-today-avatar|Good (morning|afternoon|evening)/)`; `/<h1 class="ws-sr">Today<\/h1>/`; `/class="ws-today-sum-link" data-action="route" data-route="calendar">\d+ meetings? left today</`; `/data-route="inbox" data-lane="reply">\d+ messages? needs? you</`. The existing Default greeting test (:362) stays.

- [ ] **Step 2: Run** `node --test ui/test/today-controller.test.mjs ui/test/workspace.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement.** In Compact the header is `<header class="ws-today-head ws-today-head-compact">`. It holds `.ws-today-title` with the hidden h1, `p.ws-eyebrow` (date) and `p.ws-description` (the parts as `button.ws-today-sum-link` joined with ` · `; plain text while not connected), then `.ws-today-actions`. Compact CSS: the date at `--ws-fs-meta`, the summary at `--ws-fs-body`, the links unstyled with an underline on hover. Change the copy in `movingCard`.

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Move the browser selectors into the ⋯ menu, keeping every assertion.** In `layout-checks.mjs`, add `openTodayMenu(page)`, which clicks `.ws-today-actions details[data-menu="today-more"] > summary` and waits for `[open]`. `layoutMenu(page, item)` opens it, then clicks `details[data-menu="today-more"] ${item}`. The two `.ws-today-layout-pill` reads become the `textContent` of `[data-menu="today-more"] [data-action="today-layout-use"][aria-checked="true"]` (open, read, Escape). `pill` at :351 becomes the `today-more` details. Each lock click opens the menu, clicks `[data-action="today-lock"]`, waits for `aria-pressed`, then presses Escape. The wait at :395 uses `{ state: 'attached' }`. The Customize clicks in `plugins-checks.mjs:184` and `workspace-e2e.mjs:1359` open the menu first.

- [ ] **Step 6: Add C4** `compact C4: Today’s toolbar lives in ⋯`, for Compact and Default at 1440 in both themes:
  - No visible `today-lock`, `today-customize` or layout pill in `.ws-today-head` until ⋯ is open. Open ⋯ shows "Layouts", "Default", "Add widget", "Customize" and "Lock layouts". Lock turns into "Unlock layouts" and records no `layout_save`. Customize shows `.ws-today-editbar` (unchanged).
  - In Compact: no `.ws-today-avatar`, the head text has no greeting, and clicking the "need you" part opens `#/inbox` with the Needs reply lane `aria-selected`.
  - Screenshots `compact-c4-<view>-<theme>-menu`.

- [ ] **Step 7: Re-record `today`** (`WORKSPACE_E2E_SIZES=write:today`) after checking its screenshot: only the header's right side changed. Then run `WORKSPACE_E2E_ONLY=compact …`, `=layout …` and `=plugins …`. Expected: all PASS, E1–E8 included.

- [ ] **Step 8: Commit**

```bash
git add ui/workspace ui/test
git commit -m "feat(today): toolbar in one ⋯ menu, and the Compact header with date and summary"
```

### Task 6: Hiding menu pages

**Files:**
- Modify: `ui/workspace/shell.js` (helpers beside `NAV` :10-20; `renderShell` :110-150)
- Modify: `ui/workspace/settings-layout.js` (new Menu card before `menusCard` :56-64; `layoutPanel` :74-77)
- Modify: `ui/workspace/app.js` (`shellMarkup` :244-251; `handle` new `case 'menu-page'`; boot after `store.refresh()` at :2930)
- Modify: `ui/workspace/workspace.css` (`.ws-nav button.ws-nav-hidden` beside :159)
- Modify: `ui/test/shell-nav.test.mjs`, `ui/test/settings-menu.test.mjs`, `ui/test/view-mode.test.mjs`
- Modify: `ui/test/browser/compact-checks.mjs` (C5), `ui/test/fixtures/default-sizes.json` (re-record `settings-layout`)

**Interfaces:**
- Consumes: `Settings.hiddenPages` (Task 1).
- Produces, in `shell.js`: `visiblePages(hiddenPages = []) -> string[]` (NAV ids not hidden, in NAV order); `firstVisiblePage(hiddenPages = []) -> string` (the first visible, else `'today'`); `toggleHiddenPage(hiddenPages, id, visible) -> string[]` (NAV order, never duplicates); `renderShell({ …, hiddenPages = [] })`.
  - A hidden page's row is left out unless it is the route. Then it is drawn with class `ws-nav-hidden`, `title="Hidden from the menu"` and no count.
  - Folded roll-ups count only rows that are drawn. A group, or the Today home group, with no row drawn renders `''`.
- Produces, in `settings-layout.js`: a card titled "Menu" (icon `list`) with the hint line, then one `settingRow` per NAV page. Each row's control is `toggle({ action: 'menu-page', checked: !hidden, attrs: { 'data-page': id, 'aria-label': 'Show <Label> in the menu', disabled: lastVisible } })`, wrapped in `<span title="Keep one page in the menu.">` when it is the last visible page.
- Produces, in `app.js`: `case 'menu-page': return mutate('settings_update', { hiddenPages: toggleHiddenPage(snap().settings.hiddenPages, el.dataset.page, el.checked) });`. At boot, when `parseHash(location.hash).route` is null and no plugin page is in the hash, `state.route = firstVisiblePage(snap().settings.hiddenPages)`.

- [ ] **Step 1: Write the failing unit tests**

```js
test('a hidden page leaves the menu, its count and its group’s roll-up', () => {
  // renderShell with hiddenPages ['inbox'], sidebarFolded {work:true}, route 'today'
  assert.doesNotMatch(html, /data-route="inbox"/);
  // the Work label's rolled count equals the tasks + meetings counts only
});
test('a hidden page that is open shows greyed with no count', () => { /* route 'calendar', hidden ['calendar'] → /class="ws-nav-hidden"[^>]*data-route="calendar"|data-route="calendar"[^>]*class="ws-nav-hidden"/ */ });
test('a group with every page hidden is not drawn, nor Today when hidden', () => { /* hidden ['automations','analytics','today'], route 'inbox' → no data-group="ai", no data-route="today" */ });
test('firstVisiblePage and toggleHiddenPage keep menu order', () => {
  assert.equal(firstVisiblePage([]), 'today'); assert.equal(firstVisiblePage(['today']), 'inbox');
  assert.equal(firstVisiblePage(NAV.map(([id]) => id)), 'today');
  assert.deepEqual(toggleHiddenPage(['tasks'], 'calendar', false), ['calendar', 'tasks']);
  assert.deepEqual(toggleHiddenPage(['calendar', 'tasks'], 'calendar', true), ['tasks']);
});
test('Settings → Layout: the Menu card sits above Side menus with one switch per page; the last one is kept', () => {
  // hiddenPages = all but inbox
  assert.ok(html.indexOf('>Menu</h2>') < html.indexOf('>Side menus</h2>'));
  assert.equal([...html.matchAll(/data-action="menu-page"/g)].length, 7);
  assert.match(html, /Hidden pages leave the menu\. Links and notifications still open them\./);
  assert.match(html, /<span title="Keep one page in the menu\.">[^]*?data-page="inbox"[^>]*disabled/);
});
```

- [ ] **Step 2: Run** `node --test ui/test/shell-nav.test.mjs ui/test/settings-menu.test.mjs ui/test/view-mode.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** as specified in Interfaces. `layoutPanel(s, …)` reads `s.settings.hiddenPages` and puts the Menu card right before `menusCard`. `.ws-nav-hidden` gets `opacity:.55`.

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Add C5** `compact C5: hidden pages leave the menu and still open by route`, in Compact and Default at 1440:
  - Turn Calendar off in Settings › Layout. `settings_update {hiddenPages:['calendar']}` is recorded, and `.ws-sidebar [data-route=calendar]` count is 0.
  - `page.goto(base + '#/calendar')` shows `.ws-page-calendar` with a greyed `[data-route=calendar].ws-nav-hidden`. The Today schedule's link still opens Calendar.
  - Hide everything but Inbox. The Inbox switch is disabled, and its wrapper's title is "Keep one page in the menu.". The AI group is not drawn.
  - Reopen with `hash: ''` and `settings: { hiddenPages: ['today'] }`. It lands on `.ws-page-inbox`.
  - Screenshots `compact-c5-<view>-menu`, `compact-c5-<view>-hidden-open`.

- [ ] **Step 6: Re-record `settings-layout`** (`WORKSPACE_E2E_SIZES=write:settings-layout`) after checking that only the Menu card was added. Run `WORKSPACE_E2E_ONLY=compact …` and `=layout …`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/workspace ui/test
git commit -m "feat(ui): hide main-menu pages in Settings › Layout, still reachable by route"
```

### Task 7: Compact Inbox, open in place

**Files:**
- Create: `ui/workspace/inbox-open.js` (pure state moves)
- Modify: `ui/workspace/view-inbox.js` (`inbox` :39-43 branch; `inboxSections` :46-86 list branch; new compact row and open row beside `listRow` :88-109; `reader` :128-163 split so its actions and thread are shared; `replyForm` :229-267 unchanged)
- Modify: `ui/workspace/app.js`
  - `state` :73-100
  - `ensureSelection` :581-587
  - `inboxMessage` :1051
  - `selectMessage` :1922-1927
  - `handle`: `route` :1957-1962, `lane`/`channel` :2092-2093, `select-message`/`open-message` :2094-2104, archive/snooze/lane :2109-2136, new `inbox-earlier`
  - search input :2433-2446
  - Inbox keys :2636-2654
  - render reply restore :465-466
  - `openNotification` :2690-2710
  - `setView` (Task 3)
- Modify: `ui/workspace/workspace.css` (Compact Inbox rules, after :1003)
- Create: `ui/test/compact-inbox.test.mjs`
- Modify: `ui/test/browser/compact-checks.mjs` (C6)

**Interfaces:**
- Consumes: `ctx.view`, `viewOf`, `setView` (Task 3); `listTitle`, `summarySection`, `replyForm`, `SNOOZE`, `LANES` (existing).
- Produces, in `inbox-open.js` (`sel` = `{ selected, open }` message ids or null):
  - `clickRow(sel, id) -> sel`: if `open === id` the result is `{selected: id, open: null}`, else `{selected: id, open: id}`.
  - `enterRow(sel) -> sel`: `open = selected`.
  - `escRow(sel) -> sel`: `open = null`.
  - `nextAfter(ids, goneId) -> string|null`: the id after `goneId`, else the one before, else null.
  - `followOpen(items, { open, openKey }, keyOf) -> { open, openKey }`: keeps the open row on its conversation when a chat's newest message replaces its id, and gives `open: null` once the conversation has left `items`.
- Produces, in state: `state.openMessage`, `state.openKey`, `state.selectAfter` (id or null), `state.replyCarry` (`{ [draftKey]: text }`), `state.threadAll` (`Set` of message ids).
- Produces, in `view-inbox.js`:
  - `inbox(s, ctx)` in Compact returns `<div class="ws-inbox-compact">${sections['inbox-list']}</div>` and never builds `inbox-reader` (ruling 5).
  - The Compact list is `div.ws-inbox-items` with `role="list"`. Each `div.ws-crow` (`role="listitem"`) holds `button.ws-inbox-row.ws-inbox-row-compact`, with `data-action="select-message"`, `data-id`, `aria-expanded`, `aria-controls="crow-<id>"`, `ws-selected` plus `aria-current="true"` when selected, and `ws-unread`. The button's one line holds the unread dot, the sender, the title with marks (`!` importance; icon-only drafting, snoozed, acknowledged, attachment and flagged, each with `title` and `aria-label`), the thread count, and the time. No avatar, preview or flags line.
  - When open, the button is followed by `div.ws-crow-body#crow-<id>`, which holds:
    - `div.ws-crow-actions`: Done (`message-archive`), Snooze ▾ (`message-snooze` items), Acknowledge (`message-ack`, visible on `lane==='critical' && !acknowledgedAt`), and a `details.ws-menu[data-menu="crow-more"]` ⋯ with Open in Outlook/Teams (`source`), Summarize (`ai-summarize`, when `summaryButton` offers it), Move to lane (the `message-lane` select) and Add a task (`commitment`).
    - `summarySection`.
    - `div.ws-thread.ws-thread-compact` with the last 12 messages, or all of them when `state.threadAll.has(id)`, preceded by a `button` `data-action="inbox-earlier" data-id` labelled "Earlier" when the thread is longer than 12 and not expanded.
    - `replyForm(s, m, zone, state)`.
- Behaviour in `app.js`, Compact only unless stated:
  - `select-message` applies `clickRow`.
  - The ↑/↓/j/k handler keeps moving the selection only.
  - ↵ applies `enterRow` when `ev.target` is not inside `button, a, summary, input, select, textarea, [contenteditable]`.
  - Esc applies `escRow` when a row is open (the capture-phase menu closer at :2568 already runs first and stops it while a menu is open). Both keys respect the existing guard (`modalOpen`, `editing()`, modifiers).
  - `lane`, `channel`, search and `route` with a lane reset `openMessage`/`openKey`.
  - `ensureSelection` applies `followOpen`, and when `state.selectAfter` is in `items` it picks that row and clears the field.
  - Before `decideRow` in `message-archive`, `message-snooze` and `message-lane`, set `state.selectAfter = nextAfter(<rendered row ids>, id)` and `state.openMessage = null`.
  - `open-message` and a notification's `itemId` also set `openMessage` (ruling 6).
  - `setView` sets `openMessage = null`.
  - `inboxMessage(s)` returns the open message in Compact and the selected one in Default.
  - Both views: after render, an `unsavedReply` whose key has no fresh box goes to `state.replyCarry[key]`. A fresh box whose `value === defaultValue` takes and deletes `state.replyCarry[key]`. `draft-save` and a sent reply delete the key.

- [ ] **Step 1: Write the failing unit tests** in `ui/test/compact-inbox.test.mjs`:

```js
test('selected and open are separate: click opens, click again closes and keeps it selected', () => {
  assert.deepEqual(clickRow({ selected: 'a', open: null }, 'b'), { selected: 'b', open: 'b' });
  assert.deepEqual(clickRow({ selected: 'b', open: 'b' }, 'b'), { selected: 'b', open: null });
  assert.deepEqual(clickRow({ selected: 'b', open: 'b' }, 'c'), { selected: 'c', open: 'c' });
  assert.deepEqual(enterRow({ selected: 'c', open: null }), { selected: 'c', open: 'c' });
  assert.deepEqual(escRow({ selected: 'c', open: 'c' }), { selected: 'c', open: null });
});
test('after a row leaves, the next one is selected', () => {
  assert.equal(nextAfter(['a','b','c'], 'b'), 'c'); assert.equal(nextAfter(['a','b','c'], 'c'), 'b'); assert.equal(nextAfter(['a'], 'a'), null);
});
test('the open row follows its chat when a newer message arrives, and closes when it leaves', () => { /* items with new id same key → open is the new id; key gone → open null */ });
test('Compact Inbox: one list, every row closed and one line, no reading pane', () => {
  // inbox(s, ctx({ view: 'compact' })) with state.openMessage null
  assert.match(html, /<div class="ws-inbox-compact">/); assert.doesNotMatch(html, /ws-reader|Reading pane|ws-dock/);
  assert.doesNotMatch(html, /aria-expanded="true"|ws-msg-preview|ws-msg-avatar/);
  assert.match(html, /role="list"/);
});
test('the open row: Done, Snooze, Acknowledge on an unacknowledged critical, ⋯, summary, thread, reply form', () => {
  // open the fixture's critical unacknowledged message
  assert.match(html, /aria-expanded="true" aria-controls="crow-[^"]+"/);
  assert.match(html, /ws-crow-actions[^]*?data-action="message-archive"[^]*?message-snooze[^]*?data-action="message-ack"[^]*?data-menu="crow-more"/);
  assert.match(html, /class="ws-thread ws-thread-compact"[^]*?<form class="ws-reply/);
  assert.equal([...html.matchAll(/id="reply-body"/g)].length, 1);
});
test('a thread longer than 12 shows Earlier until expanded', () => { /* 14-message chat → 12 bubbles + inbox-earlier; threadAll has id → 14 bubbles, no Earlier */ });
test('Default Inbox keeps the dock and the reading pane', () => { /* inbox(s, ctx({ view: 'default' })) → /ws-dock/ and /aria-label="Reading pane"/, rows keep ws-msg-preview */ });
```

- [ ] **Step 2: Run** `node --test ui/test/compact-inbox.test.mjs`. Expected: FAIL (module and markup missing).

- [ ] **Step 3: Implement** `inbox-open.js`, the `view-inbox.js` markup and the `app.js` behaviour listed under Interfaces. Compact CSS goes under `#workspace-app[data-view="compact"]`:
  - `.ws-inbox-compact` fills the page height as a column, and `.ws-inbox-items` scrolls.
  - `.ws-inbox-head` puts the lanes and the filters on one row from 1200 px and wraps below that.
  - The one-line row has a min-height of 32px, `var(--ws-row-pad)` and `var(--ws-r-row)`. The sender has a max width of 180px with an ellipsis, and the title has an ellipsis.
  - `.ws-crow-body` uses `padding: 8px 12px 12px 24px; display: grid; gap: 8px`.
  - `.ws-thread-compact` uses `max-height: 260px; overflow: auto`.

- [ ] **Step 4: Run** `npm test`. Expected: PASS, with the existing Inbox tests in `workspace.test.mjs:540-575` untouched.

- [ ] **Step 5: Add C6** `compact C6: Inbox rows open in place`, in Compact at 1440 in both themes (screenshots `compact-c6-<theme>-closed`, `-open`, `-critical`):
  - Load: zero `.ws-inbox-row[aria-expanded=true]`, one `.ws-inbox-row.ws-selected`, no `.ws-reader`.
  - Click row 2: it opens (`.ws-crow-body #reply-body` exists), and the computed `max-height` of `.ws-thread-compact` is `260px`. Click row 3: row 2 closes and row 3 opens. Click row 3 again: it closes and stays `.ws-selected`.
  - `j` then `k`: the selection moves and nothing opens. `Enter` on `body` opens the selected row. `Escape` closes it.
  - Focus the row button and press `Enter`: it is open exactly once (toggles once, Review Focus 4). Open the ⋯ and press Escape: the menu closes and the row stays open.
  - Type `jk` in `#inbox-search`: the value is `jk` and the selection is unchanged.
  - Open the critical message (Critical lane): `[data-action=message-ack]` is visible outside any menu.
  - Done on the open row 2: the row leaves, the row that followed it is `.ws-selected`, and nothing is open. Snooze › Later today does the same.
  - View switch (Review Focus 1): in Default, select a message, type `carry me`, then Settings › Appearance › Compact, then Inbox. The same row is selected and none is open. Open it: `#reply-body` value is `carry me`. Settings › Default, then Inbox: the reading pane shows that message with `carry me`.
  - Add the Compact row classes to `noClip`. C2 now covers the Compact Inbox at three widths.

- [ ] **Step 6: Run** `WORKSPACE_E2E_ONLY=compact …`, then the Inbox part of the main run by running it whole (Task 8 runs it again). Expected: C0–C6 PASS, and the existing Inbox checks PASS (Default unchanged).

- [ ] **Step 7: Commit**

```bash
git add ui/workspace ui/test
git commit -m "feat(inbox): Compact rows open in place with the thread and reply, selection kept apart"
```

### Task 8: Definition of done

**Files:** none changed unless a check fails. A fix goes in a `fix:` commit naming the check.

- [ ] **Step 1: Gates.** Run `make fmt-check lint test-js`, then `cd src-tauri && cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches` (PATH as in Global Constraints). `make check` is the same set without the skip. Expected: fmt and clippy clean, `npm test` with no failures, `cargo test` reporting `test result: ok` for every target, and `git status` clean (fixtures committed).

- [ ] **Step 2: Whole browser run**, in the background with `timeout: 600000`: `PLAYWRIGHT_CORE=/Users/Nikita_Levyankov/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs`, outside the sandbox. Expected: `N/N browser checks passed`, covering compact C0–C6, layout E1–E8, plugins, meetings, meetings-settings and analytics. Screenshots are in `output/playwright/workspace-e2e/`.

- [ ] **Step 3: The real app.** Ask the user to quit their Connect (the status smoke refuses to run beside it; do not quit it for them).
  - Build `cd src-tauri && cargo build`. Prepare `T=$(mktemp -d)/workspace` and copy the user's `~/Library/Application Support/com.epam.codemie.installer/workspace/workspace.sqlite` (with `-wal` and `-shm`) into it so Inbox and Today have real rows. Do not copy `credentials/`.
  - Launch `CODEMIE_WORKSPACE_TEST_DIR=$T ./target/debug/app`. Drive it with a CGEvent clicker (a small Swift or Python script posting mouse and key events) and capture each screen with `screencapture -l <windowid>`. Capture in Default and in Compact: Today (header, ⋯ menu open), Inbox (Default reader; Compact closed, open, and critical with Acknowledge), Settings › Appearance (View card), Settings › Layout (Menu card), a hidden page open by route (greyed row), Calendar and Tasks (Compact sizes).
  - Then quit and run `CODEMIE_WORKSPACE_TEST_DIR=$T CODEMIE_STATUS_SMOKE=status ./target/debug/app`. Expected: exit 0, and `$TMPDIR/connect-status-smoke.json` reports the workspace and settings.

- [ ] **Step 4: Naya side by side.** Open `/Users/Nikita_Levyankov/repos/personal/naya.ai/docs/superpowers/specs/mockups/inbox-v5.html` and `today-v11.html` (or a live Naya window if one is running) at the same window width, and capture them. Put each next to the Compact Inbox and Compact Today screenshots, and list every visible difference (sizes, spacing, header, row anatomy, open-row order, reply controls deferred to step 2) as kept-on-purpose or follow-up.

- [ ] **Step 5: Show the user** the browser-run summary, the real-app screenshots for both views, the status smoke result and the Naya comparison with its list of differences. Do not push.
