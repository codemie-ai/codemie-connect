// Browser checks of the compact view (spec docs/superpowers/specs/2026-11-22-compact-view-design.md),
// run by workspace-e2e.mjs with its MOCKED native bridge. C0 proves the Default view keeps its
// sizes: every element under #workspace-app on ten Default screens, with a fixed clock, is dumped
// as its computed text and box sizes and hashed per screen against ui/test/fixtures/default-sizes.json.
//
//   WORKSPACE_E2E_SIZES=write                       rewrites every screen's baseline
//   WORKSPACE_E2E_SIZES=write:today,settings-layout rewrites the named screens only
//
// Each run writes the full dumps to OUT/sizes-<screen>.json; a write also keeps them as
// OUT/sizes-<screen>.baseline.json, which a later mismatch is compared against.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXED_NOW = Date.parse('2026-11-18T09:30:00+02:00');

const BASELINE = fileURLToPath(new URL('../fixtures/default-sizes.json', import.meta.url));
const SCREENS = {
  today: '#/today',
  inbox: '#/inbox',
  calendar: '#/calendar',
  meetings: '#/meetings',
  tasks: '#/tasks',
  automations: '#/automations',
  analytics: '#/analytics',
  'settings-general': '#/settings/general',
  'settings-appearance': '#/settings/appearance',
  'settings-layout': '#/settings/layout',
};

/** Every element under #workspace-app in document order, skipping iframe subtrees and the
 *  toasts: [tag, className, fontSize, lineHeight, width, height, padding, margin, gap, borderRadius]. */
export const sizesOf = page => page.evaluate(() => {
  const root = document.getElementById('workspace-app');
  const out = [];
  const round = v => Math.round(v * 100) / 100;
  const walk = parent => {
    for (const el of parent.children) {
      if (el.tagName === 'IFRAME' || el.classList.contains('ws-toasts')) continue;
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      out.push([el.tagName.toLowerCase(), typeof el.className === 'string' ? el.className : el.getAttribute('class') || '', cs.fontSize, cs.lineHeight, round(box.width), round(box.height), cs.padding, cs.margin, cs.gap, cs.borderRadius]);
      walk(el);
    }
  };
  if (root) walk(root);
  return out;
});

const sha256 = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

/** Which screens this run rewrites: none, all, or the names after `write:`. */
function screensToWrite() {
  const mode = process.env.WORKSPACE_E2E_SIZES || '';
  if (mode === 'write') return new Set(Object.keys(SCREENS));
  if (mode.startsWith('write:')) return new Set(mode.slice(6).split(',').map(s => s.trim()).filter(Boolean));
  return new Set();
}

/** The window's `data-view` on `#workspace-app` and on `<html>`. */
const viewAttrs = page => page.evaluate(() => ({ root: document.getElementById('workspace-app').dataset.view, html: document.documentElement.dataset.view }));

/** The view `#workspace-app`'s `data-view` held the moment it first got a child element — the
 *  loading spinner `boot()` draws before the native snapshot arrives — recorded by a watcher
 *  `installBridge` (workspace-e2e.mjs) always arms before the page's own scripts run, on every
 *  navigation of the page including a reload. Reads whatever it last recorded. */
const firstChildView = page => page.evaluate(() => window.__firstChildView);

const APPEARANCE = '#/settings/appearance';

/** The pages C2 and C3 walk, as `window.__workspace.route` arguments (`name/tab`). */
export const MATRIX_ROUTES = ['today', 'inbox', 'calendar', 'meetings', 'tasks', 'automations', 'analytics', 'settings/appearance', 'settings/layout'];

/** Navigates the already-open page to `route` (one of MATRIX_ROUTES) the way a nav click does,
 *  through the dev-only `window.__workspace.route` hook `app.js` exposes. */
const gotoRoute = (page, route) => page.evaluate(route => {
  const [name, tab] = route.split('/');
  return window.__workspace.route(name, tab);
}, route);

/** Elements whose overflow or clipped text would be invisible to the user in Compact, with the
 *  Compact Inbox's one-line rows and the parts of an open row. */
export const CLIP_SELECTORS = ['.ws-btn', '.ws-nav button', '.ws-menu-item', '.ws-lane', '.ws-segmented button', '.ws-inbox-row', '.ws-input',
  '.ws-inbox-row-compact', '.ws-crow-from', '.ws-crow-title', '.ws-reply-bar', '.ws-thread-earlier', '.ws-menu-field'];

/** Selectors (with a short description) of elements matching CLIP_SELECTORS whose content
 *  overflows vertically, or is cut off horizontally without an ellipsis. Elements the user
 *  cannot currently see (closed `<details>` menus among them: Chromium lays out their content
 *  with `content-visibility:hidden` rather than `display:none`, so it still has real box sizes)
 *  are skipped via `checkVisibility`. */
export const noClip = page => page.evaluate(selectors => {
  const out = [];
  document.querySelectorAll(selectors.join(',')).forEach(el => {
    if (!el.checkVisibility({ checkOpacityCSS: true, checkVisibilityCSS: true })) return;
    const cs = getComputedStyle(el);
    const heightClip = el.scrollHeight > el.clientHeight + 1;
    const widthClip = el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis';
    if (!heightClip && !widthClip) return;
    const sel = selectors.find(s => el.matches(s)) || el.tagName.toLowerCase();
    const label = `${sel}${el.id ? `#${el.id}` : ''}${el.className ? `.${String(el.className).trim().replace(/\s+/g, '.')}` : ''}`;
    out.push(`${label} "${(el.textContent || '').trim().slice(0, 40)}" (${heightClip ? 'height' : 'width'})`);
  });
  return out;
}, CLIP_SELECTORS);

/** C2: at `width`, in `view`, every MATRIX_ROUTES page stays inside the viewport and nothing
 *  matching CLIP_SELECTORS clips. `page` is already open at `view`/`width`/`theme`. */
async function c2(page, theme, view, width, { assert, shot, settled }) {
  const problems = [];
  for (const route of MATRIX_ROUTES) {
    await gotoRoute(page, route);
    await settled(page);
    const over = await page.evaluate(() => {
      const main = document.getElementById('workspace-main');
      return { main: main.scrollWidth - main.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    if (over.main > 0 || over.page > 0) problems.push(`${route} overflows sideways: ${JSON.stringify(over)}`);
    const clipped = await noClip(page);
    if (clipped.length) problems.push(`${route} clipped: ${clipped.join(' | ')}`);
    await shot(page, `compact-${theme}-${view}-${width}-${route.replace(/\//g, '-')}`);
  }
  assert(problems.length === 0, problems.join(' || '));
}

/** Every --ws-fs-* size token Task 2 defined. */
const FS_TOKENS = ['--ws-fs-label', '--ws-fs-meta', '--ws-fs-meta-lg', '--ws-fs-secondary', '--ws-fs-secondary-lg', '--ws-fs-body-sm', '--ws-fs-body-lg', '--ws-fs-body', '--ws-fs-heading-sm', '--ws-fs-heading', '--ws-fs-heading-md', '--ws-fs-heading-lg', '--ws-fs-title', '--ws-fs-title-md', '--ws-fs-title-sm'];

/** C3: Compact uses Naya's sizes, at 1440 (brief's exact spots), and the grid row height Today
 *  gives `[data-tile=brief]` is unchanged from Default. `page` is already open in Compact at 1440. */
async function c3(page, { open, assert, settled }) {
  await gotoRoute(page, 'today');
  await settled(page);
  const compactBrief = await page.evaluate(() => document.querySelector('[data-tile="brief"]')?.offsetHeight);
  assert(compactBrief != null, 'no [data-tile=brief] on Today');
  const { page: defPage, context: defContext } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, meetings: true, automations: true, hash: '#/today' });
  try {
    await settled(defPage);
    const defaultBrief = await defPage.evaluate(() => document.querySelector('[data-tile="brief"]')?.offsetHeight);
    assert(defaultBrief === compactBrief, `[data-tile=brief] offsetHeight: compact ${compactBrief} vs default ${defaultBrief}`);
  } finally {
    await defContext.close().catch(() => {});
  }

  const appFont = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById('workspace-app')); return { fontSize: cs.fontSize, lineHeight: cs.lineHeight }; });
  assert(appFont.fontSize === '13px', `#workspace-app font-size: ${appFont.fontSize}`);
  assert(appFont.lineHeight === '18px', `#workspace-app line-height: ${appFont.lineHeight}`);

  await gotoRoute(page, 'tasks');
  await settled(page);
  const h1 = await page.evaluate(() => getComputedStyle(document.querySelector('.ws-page-heading h1')).fontSize);
  assert(h1 === '20px', `.ws-page-heading h1 (Tasks) font-size: ${h1}`);
  const radius = await page.evaluate(() => getComputedStyle(document.querySelector('.ws-btn')).borderRadius);
  assert(radius === '6px', `.ws-btn border-radius: ${radius}`);
  await page.evaluate(() => document.activeElement?.blur());
  let focused = false;
  for (let i = 0; i < 40 && !focused; i++) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => document.activeElement?.classList?.contains('ws-btn'));
  }
  assert(focused, 'could not Tab to a .ws-btn on Tasks');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineWidth);
  assert(outline === '2px', `:focus-visible outline on a focused .ws-btn: ${outline}`);

  await gotoRoute(page, 'inbox');
  await settled(page);
  const navH = await page.evaluate(() => getComputedStyle(document.querySelector('.ws-nav button[data-route="inbox"]')).height);
  assert(navH === '28px', `.ws-nav button[data-route=inbox] height: ${navH}`);
  const searchH = await page.evaluate(() => getComputedStyle(document.getElementById('inbox-search')).height);
  assert(searchH === '28px', `#inbox-search height: ${searchH}`);
  const titleFs = await page.evaluate(() => getComputedStyle(document.querySelector('.ws-inbox-title h1')).fontSize);
  assert(titleFs === '22px', `.ws-inbox-title h1 font-size: ${titleFs}`);

  // A plain form field's .ws-input (Settings › General's Time zone), not the settings nav's own
  // "Find a setting" box (`.ws-settings-find .ws-input`), which keeps its own fixed 30px height.
  await gotoRoute(page, 'settings/general');
  await settled(page);
  const inputH = await page.evaluate(() => { const el = document.querySelector('.ws-field .ws-input'); return el && getComputedStyle(el).height; });
  assert(inputH === '28px', `.ws-field .ws-input height: ${inputH}`);

  const sizes = await page.evaluate(tokens => tokens.map(t => [t, parseFloat(getComputedStyle(document.documentElement).getPropertyValue(t))]), FS_TOKENS);
  for (const [name, px] of sizes) assert(px >= 10.5, `${name} computes to ${px}px (< 10.5)`);
}

/** C4: Today's toolbar (the saved layouts, Add widget, Customize and Lock/Unlock) lives in one ⋯
 *  menu in both views, with every control hidden until it opens; in Compact the head has no
 *  avatar or greeting and its "need you" part opens Inbox on the Needs reply lane. `page` is
 *  already open on Today at 1440, with messages needing a reply. */
async function c4(theme, view, page, { assert, shot, calls, settled }) {
  const menu = '.ws-today-actions details[data-menu="today-more"]';
  const hiddenBefore = await page.evaluate(() => {
    const head = document.querySelector('.ws-today-head');
    const shown = sel => { const el = head.querySelector(sel); return !!el && el.checkVisibility({ checkOpacityCSS: true, checkVisibilityCSS: true }); };
    return { lock: shown('[data-action="today-lock"]'), customize: shown('[data-action="today-customize"]'), pill: shown('.ws-today-layout-pill') };
  });
  assert(!hiddenBefore.lock && !hiddenBefore.customize && !hiddenBefore.pill, `the toolbar shows before ⋯ opens: ${JSON.stringify(hiddenBefore)}`);

  if (view === 'compact') {
    assert(await page.locator('.ws-today-avatar').count() === 0, 'Compact Today still shows the avatar');
    const headText = await page.locator('.ws-today-head').innerText();
    assert(!/Good (morning|afternoon|evening)/.test(headText), `the Compact head greets: ${headText}`);
    assert(await page.locator('.ws-today-sum-link[data-route="inbox"][data-lane="reply"]').count() === 1, 'no "need you" part to click');
    await page.click('.ws-today-sum-link[data-route="inbox"][data-lane="reply"]');
    await page.waitForSelector('.ws-lane[data-lane="reply"][aria-selected="true"]');
    assert((await page.evaluate(() => location.hash)) === '#/inbox', 'the "need you" part did not open Inbox');
    await gotoRoute(page, 'today');
    await settled(page);
  }

  await page.click(`${menu} > summary`);
  await page.waitForSelector(`${menu}[open]`);
  // .ws-menu-label (“Layouts”) renders upper-case via CSS text-transform, so compare case-folded.
  const menuText = (await page.locator(`${menu} .ws-menu-panel`).innerText()).toLowerCase();
  for (const word of ['Layouts', 'Default', 'Add widget', 'Customize', 'Lock layouts']) {
    assert(menuText.includes(word.toLowerCase()), `the ⋯ menu is missing "${word}": ${menuText}`);
  }
  const checkMark = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    return el && getComputedStyle(el, '::after').content;
  }, `${menu} [data-action="today-layout-use"][aria-checked="true"]`);
  assert(checkMark === '"✓"', `the active layout's row draws no ✓ in the ⋯ menu: ${checkMark}`);
  await shot(page, `compact-c4-${view}-${theme}-menu`);

  const savesBefore = (await calls(page, 'layout_save')).length;
  await page.click(`${menu} [data-action="today-lock"]`);
  await page.waitForSelector(`${menu} [data-action="today-lock"][aria-pressed="true"]`);
  const lockText = await page.locator(`${menu} [data-action="today-lock"]`).innerText();
  assert(/Unlock layouts/.test(lockText), `the lock item does not say Unlock layouts: ${lockText}`);
  assert((await calls(page, 'layout_save')).length === savesBefore, 'locking recorded a layout_save');
  await page.keyboard.press('Escape');
  await page.waitForSelector(`${menu}:not([open])`);

  await page.click(`${menu} > summary`);
  await page.waitForSelector(`${menu}[open]`);
  await page.click(`${menu} [data-action="today-customize"]:has-text("Customize")`);
  await page.waitForSelector('.ws-today-editbar');
  assert(await page.locator('.ws-today-editbar').count() === 1, 'Customize did not show the edit bar');
}

/** C5: hidden pages leave the menu, stay reachable by route (greyed in the menu while open, a
 *  Today link still opens one), the last visible page's switch is disabled, and an empty hash at
 *  boot lands on the first visible page. `page` is already on Settings › Layout at 1440, in
 *  `view`. */
async function c5(view, page, { open, assert, shot, calls, settled }) {
  const switchOf = id => page.locator(`label.ws-switch:has([data-page="${id}"])`);

  await switchOf('calendar').click();
  await settled(page);
  const recorded = await calls(page, 'settings_update');
  assert(recorded.some(d => Array.isArray(d.hiddenPages) && d.hiddenPages.includes('calendar')), `no settings_update {hiddenPages} recorded: ${JSON.stringify(recorded)}`);
  assert(await page.locator('.ws-sidebar [data-route="calendar"]').count() === 0, 'Calendar is still in the menu');
  await shot(page, `compact-c5-${view}-menu`);

  // A hidden page still opens by its hash route, greyed in the menu, and a link elsewhere (the
  // Today schedule's Calendar button) still reaches it too. A fresh session, since a real reload
  // (not a hash the app's own router reads) would otherwise lose the mock bridge's one-time setup.
  const routeSettings = view === 'compact' ? { view: 'compact', hiddenPages: ['calendar'] } : { hiddenPages: ['calendar'] };
  const { page: byRoute, context: byRouteContext } = await open({ theme: 'dark', width: 1440, height: 900, settings: routeSettings, hash: '#/calendar' });
  try {
    await settled(byRoute);
    assert(await byRoute.locator('.ws-page-calendar').count() === 1, 'Calendar did not open from #/calendar');
    assert(await byRoute.locator('[data-route="calendar"].ws-nav-hidden').count() === 1, 'the open hidden page is not greyed in the menu');
    await shot(byRoute, `compact-c5-${view}-hidden-open`);

    await gotoRoute(byRoute, 'today');
    await settled(byRoute);
    await byRoute.click('.ws-schedule-card [data-action="route"][data-route="calendar"]');
    await byRoute.waitForSelector('.ws-page-calendar');
    assert((await byRoute.evaluate(() => location.hash)) === '#/calendar', 'the Today schedule’s Calendar link did not open Calendar');
  } finally {
    await byRouteContext.close().catch(() => {});
  }

  // A notification still opens its page when that page is hidden, greyed in the menu while open.
  const notifySettings = view === 'compact' ? { view: 'compact', hiddenPages: ['inbox'] } : { hiddenPages: ['inbox'] };
  const { page: notified, context: notifiedContext } = await open({ theme: 'dark', width: 1440, height: 900, settings: notifySettings, hash: '#/today' });
  try {
    await settled(notified);
    assert(await notified.locator('.ws-sidebar [data-route="inbox"]').count() === 0, 'Inbox is still in the menu');
    await notified.evaluate(() => window.__emitNative('workspace:notification-open', { workspaceId: 'personal', itemId: 'm-reply-1' }));
    await notified.waitForSelector('.ws-page-inbox');
    await settled(notified);
    assert((await notified.evaluate(() => location.hash)) === '#/inbox', 'the notification did not route to the Inbox');
    assert(await notified.locator('.ws-inbox-row.ws-selected[data-id="m-reply-1"]').count() === 1, 'the notification’s message is not selected');
    assert(await notified.locator('[data-route="inbox"].ws-nav-hidden').count() === 1, 'the Inbox opened by a notification is not greyed in the menu');
  } finally {
    await notifiedContext.close().catch(() => {});
  }

  // Hide everything but Inbox (the page is still on Settings › Layout, with Calendar off).
  for (const id of ['today', 'meetings', 'tasks', 'automations', 'analytics']) {
    await switchOf(id).click();
    await settled(page);
  }
  assert(await page.locator('.ws-switch [data-page="inbox"]').isDisabled(), 'the Inbox switch is not disabled once it is the last visible page');
  const wrapperTitle = await page.evaluate(() => document.querySelector('.ws-switch [data-page="inbox"]')?.closest('span[title]')?.getAttribute('title'));
  assert(wrapperTitle === 'Keep one page in the menu.', `the last-visible wrapper’s title: ${wrapperTitle}`);
  assert(await page.locator('.ws-sidebar [data-group="ai"]').count() === 0, 'the AI group is still drawn with every page hidden');

  // Reopen with an empty hash and Today hidden: the app lands on the first visible page.
  const settings = view === 'compact' ? { view: 'compact', hiddenPages: ['today'] } : { hiddenPages: ['today'] };
  const { page: reopened, context } = await open({ theme: 'dark', width: 1440, height: 900, settings, hash: '' });
  try {
    await settled(reopened);
    assert(await reopened.locator('.ws-page-inbox').count() === 1, 'an empty hash with Today hidden did not land on Inbox');
  } finally {
    await context.close().catch(() => {});
  }
}

/** C6: the Compact Inbox's rows open in place, selected and open kept apart (spec "Compact
 *  Inbox", Review Focus 1 and 4). `page` is already on the Inbox in Compact at 1440. */
async function c6(theme, page, { open, assert, shot, calls, settled }) {
  const rows = () => page.evaluate(() => [...document.querySelectorAll('.ws-inbox-row')].map(r => ({ id: r.dataset.id, open: r.getAttribute('aria-expanded') === 'true', selected: r.classList.contains('ws-selected') })));
  const openIds = async () => (await rows()).filter(r => r.open).map(r => r.id);
  const selectedIds = async () => (await rows()).filter(r => r.selected).map(r => r.id);
  const row = i => page.locator('.ws-inbox-row').nth(i);
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const press = async key => { await page.keyboard.press(key); await settled(page); };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Loads with every row closed, one selected, no reading pane.
  await settled(page);
  let r = await rows();
  assert(r.length >= 4, `the Needs reply lane has ${r.length} rows`);
  assert(r.every(x => !x.open), `a row is open on load: ${JSON.stringify(r)}`);
  assert(r.filter(x => x.selected).length === 1, `selected rows on load: ${JSON.stringify(r)}`);
  assert(await page.locator('.ws-reader').count() === 0, 'Compact draws the reading pane');
  await shot(page, `compact-c6-${theme}-closed`);
  const ids = r.map(x => x.id);

  // A click opens the row; another row's click moves the open row; a second click closes it.
  await row(1).click();
  await settled(page);
  assert(eq(await openIds(), [ids[1]]), `row 2 did not open: ${JSON.stringify(await rows())}`);
  assert(await page.locator('.ws-crow-body #reply-body').count() === 1, 'the open row has no reply box');
  const maxH = await page.evaluate(() => getComputedStyle(document.querySelector('.ws-thread-compact')).maxHeight);
  assert(maxH === '260px', `.ws-thread-compact max-height: ${maxH}`);
  const clipped = await noClip(page);
  assert(clipped.length === 0, `the open row clips: ${clipped.join(' | ')}`);
  await shot(page, `compact-c6-${theme}-open`);
  await row(2).click();
  await settled(page);
  assert(eq(await openIds(), [ids[2]]), `row 3 did not take over: ${JSON.stringify(await rows())}`);
  await row(2).click();
  await settled(page);
  assert(eq(await openIds(), []), 'a second click did not close row 3');
  assert(eq(await selectedIds(), [ids[2]]), `row 3 is not selected after closing: ${JSON.stringify(await rows())}`);

  // j/k move the selection only; ↵ opens the selected row, Esc closes it.
  await blur();
  await press('j');
  assert(eq(await selectedIds(), [ids[3]]) && eq(await openIds(), []), `j: ${JSON.stringify(await rows())}`);
  await press('k');
  assert(eq(await selectedIds(), [ids[2]]) && eq(await openIds(), []), `k: ${JSON.stringify(await rows())}`);
  await blur();
  await press('Enter');
  assert(eq(await openIds(), [ids[2]]), `Enter on the page did not open the selected row: ${JSON.stringify(await rows())}`);
  await press('Escape');
  assert(eq(await openIds(), []), 'Escape did not close the row');

  // ↵ after j/k acts on the selected row even with keyboard focus on a control (no blur): j/k
  // carry the focus to the selected row's line. Row 1 is selected and holds the focus first.
  await press('k');
  await press('k');
  assert(eq(await selectedIds(), [ids[0]]), `k k: ${JSON.stringify(await rows())}`);
  await row(0).focus();
  await press('j');
  await press('Enter');
  assert(eq(await openIds(), [ids[1]]), `focus on row 1, j, Enter: ${JSON.stringify(await rows())}`);
  const decisionsBefore = (await calls(page, 'inbox_decision')).length;
  // Done is under ⋯ now; Snooze ▾ is the action line's control that decides a row.
  await page.focus('.ws-crow-body .ws-reply-bar details[data-menu="reply-snooze"] > summary');
  await press('j');
  await press('Enter');
  assert((await calls(page, 'inbox_decision')).length === decisionsBefore, `j then Enter from Snooze decided a row: ${JSON.stringify(await calls(page, 'inbox_decision'))}`);
  assert((await rows()).some(x => x.id === ids[1]), 'j then Enter from Snooze moved row 2 away');
  assert(eq(await openIds(), [ids[2]]), `focus on Snooze, j, Enter: ${JSON.stringify(await rows())}`);
  await press('Escape');
  assert(eq(await openIds(), []), `Escape did not close row 3: ${JSON.stringify(await rows())}`);
  await press('j');
  await press('Enter');
  assert(eq(await openIds(), [ids[3]]), `Escape, j, Enter: ${JSON.stringify(await rows())}`);
  await press('Escape');

  // ↵ on a focused row button toggles it once; Escape with ⋯ open closes only the menu.
  await row(1).focus();
  await press('Enter');
  assert(eq(await openIds(), [ids[1]]), `Enter on the row button: ${JSON.stringify(await rows())}`);
  const more = '.ws-crow-body details[data-menu="reply-more"]';
  await page.click(`${more} > summary`);
  await page.waitForSelector(`${more}[open]`);
  const menuClip = await page.evaluate(sel => {
    const panel = document.querySelector(`${sel} .ws-menu-panel`).getBoundingClientRect();
    const list = document.querySelector('.ws-inbox-items').getBoundingClientRect();
    return { panel: [panel.top, panel.bottom], list: [list.top, list.bottom] };
  }, more);
  assert(menuClip.panel[0] >= menuClip.list[0] - 1 && menuClip.panel[1] <= menuClip.list[1] + 1, `the ⋯ menu leaves the list: ${JSON.stringify(menuClip)}`);
  await shot(page, `compact-c6-${theme}-more`);
  await press('Escape');
  assert(await page.locator(`${more}[open]`).count() === 0, 'Escape left the ⋯ menu open');
  assert(eq(await openIds(), [ids[1]]), 'Escape with the ⋯ menu open closed the row');

  // j and k typed in the search box are letters.
  const before = await selectedIds();
  await page.click('#inbox-search');
  await page.keyboard.type('jk');
  const during = await selectedIds();
  assert((await page.inputValue('#inbox-search')) === 'jk', 'the search box did not take j and k');
  assert(eq(during, before), `typing jk moved the selection: ${JSON.stringify(before)} → ${JSON.stringify(during)}`);
  await page.fill('#inbox-search', '');
  await settled(page);

  // Acknowledge stays a visible button on the action line of an unacknowledged critical message.
  await page.click('.ws-lane[data-lane="critical"]');
  await settled(page);
  await row(0).click();
  await settled(page);
  const ack = await page.evaluate(() => {
    const b = document.querySelector('.ws-crow-body .ws-reply-bar [data-action="message-ack"]');
    return !!b && !b.closest('details') && b.checkVisibility();
  });
  assert(ack, 'Acknowledge is not a visible button on the open critical message');
  await shot(page, `compact-c6-${theme}-critical`);

  // Done, then Snooze › Later today: the row leaves, the one after it is selected, none opens.
  await page.click('.ws-lane[data-lane="reply"]');
  await settled(page);
  r = await rows();
  const reply = r.map(x => x.id);
  await row(1).click();
  await settled(page);
  await page.click('.ws-crow-body details[data-menu="reply-more"] > summary');
  await page.click('.ws-crow-body details[data-menu="reply-more"] [data-action="message-archive"]');
  await settled(page);
  r = await rows();
  assert(!r.some(x => x.id === reply[1]), 'Done left the row in the list');
  assert(eq(await selectedIds(), [reply[2]]), `after Done: ${JSON.stringify(r)}`);
  assert(eq(await openIds(), []), 'a row opened after Done');
  await row(1).click();
  await settled(page);
  await page.click('.ws-crow-body details[data-menu="reply-snooze"] > summary');
  await page.click('.ws-crow-body [data-action="message-snooze"][data-preset="3h"]');
  await settled(page);
  r = await rows();
  assert(!r.some(x => x.id === reply[2]), 'Snooze left the row in the list');
  assert(eq(await selectedIds(), [reply[3]]), `after Snooze: ${JSON.stringify(r)}`);
  assert(eq(await openIds(), []), 'a row opened after Snooze');

  // A thread taller than its 260 px box opens scrolled to the newest messages with the current one
  // in view, and keeps the place the user scrolled to through a snapshot re-render.
  const { page: t, context: tContext } = await open({ theme, width: 1440, height: 900, now: FIXED_NOW, settings: { view: 'compact' }, hash: '#/inbox', longThread: true });
  try {
    await settled(t);
    await t.click('.ws-inbox-row[data-id="m-reply-1"]');
    await settled(t);
    const box = () => t.evaluate(() => {
      const el = document.querySelector('.ws-thread-compact');
      const cur = el.querySelector('.ws-current').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight, current: cur.top >= r.top - 1 && cur.bottom <= r.bottom + 1 };
    });
    const opened = await box();
    assert(opened.max > 0, `the thread does not overflow its box: ${JSON.stringify(opened)}`);
    assert(opened.top > 0 && opened.current, `the open thread starts at its oldest message or hides the current one: ${JSON.stringify(opened)}`);
    await t.evaluate(() => { document.querySelector('.ws-thread-compact').scrollTop = 5; });
    await t.fill('.ws-crow-body #reply-body', 'typing while it syncs');
    await t.evaluate(() => window.__workspace.store.refresh());
    await settled(t);
    await t.evaluate(() => window.__workspace.render());
    await settled(t);
    const kept = await box();
    assert(kept.top === 5, `a re-render moved the thread box: ${JSON.stringify(kept)}`);
    await shot(t, `compact-c6-${theme}-long-thread`);
  } finally {
    await tContext.close().catch(() => {});
  }

  // A reply typed in Default survives Compact and back (Review Focus 1).
  const { page: d, context } = await open({ theme, width: 1440, height: 900, now: FIXED_NOW, hash: '#/inbox' });
  try {
    await settled(d);
    await d.click('.ws-inbox-row[data-id="m-reply-2"]');
    await settled(d);
    await d.fill('#reply-body', 'carry me');
    await gotoRoute(d, 'settings/appearance');
    await settled(d);
    await d.click('[data-action="view-set"][data-view="compact"]');
    await settled(d);
    await gotoRoute(d, 'inbox');
    await settled(d);
    const sel = await d.evaluate(() => [...document.querySelectorAll('.ws-inbox-row.ws-selected')].map(x => x.dataset.id));
    assert(eq(sel, ['m-reply-2']), `in Compact the selected row is ${JSON.stringify(sel)}`);
    assert(await d.locator('.ws-inbox-row[aria-expanded="true"]').count() === 0, 'a row is open after switching to Compact');
    await d.click('.ws-inbox-row[data-id="m-reply-2"]');
    await settled(d);
    const carried = await d.inputValue('.ws-crow-body #reply-body');
    assert(carried === 'carry me', `the open row's reply: ${JSON.stringify(carried)}`);
    await gotoRoute(d, 'settings/appearance');
    await settled(d);
    await d.click('[data-action="view-set"][data-view="default"]');
    await settled(d);
    await gotoRoute(d, 'inbox');
    await settled(d);
    assert(await d.locator('.ws-reader [data-message-id="m-reply-2"]').count() === 1, 'the reading pane does not show the selected message');
    const back = await d.inputValue('.ws-reader #reply-body');
    assert(back === 'carry me', `the reading pane's reply: ${JSON.stringify(back)}`);
  } finally {
    await context.close().catch(() => {});
  }
}

/** C7: the composer in the open row (spec 2026-11-22-reply-design.md, rulings 2 and 15). Each
 *  step opens its own page (`open`), so one failing step leaves the others meaningful. */
const plan = (page, value) => page.evaluate(v => { window.__draftPlan = v; }, value);
/** Opens row `id` (or, with none, keeps the open row, else opens the first). */
const openReplyRow = async (page, settled, id) => {
  await settled(page);
  if (!id && await page.locator('.ws-crow-body #reply-body').count()) return;
  await page.click(id ? `.ws-inbox-row[data-id="${id}"]` : '.ws-inbox-row >> nth=0');
  await settled(page);
  await page.waitForSelector('.ws-crow-body #reply-body');
};
const boxValue = page => page.inputValue('.ws-crow-body #reply-body');

/** A change result that arrives on the user's own text replaces it, with Restore my text. */
async function c7Change(page, { assert, settled, shot, theme }) {
  await openReplyRow(page, settled, 'c-reply-1');
  await page.fill('.ws-crow-body #reply-body', 'Sure, sending it at 14:30.');
  // The mock answers a change with the text it was given plus "(changed: <words>)".
  await plan(page, { outcome: 'ok', ms: 400, questions: [] });
  await page.fill('#reply-change', 'make it 15:00');
  await page.press('#reply-change', 'Enter');
  await page.waitForFunction(() => document.getElementById('reply-body')?.value === 'Sure, sending it at 14:30. (changed: make it 15:00)', null, { timeout: 5000 });
  await settled(page);
  assert(await page.locator('.ws-draft-confirm').count() === 0, 'a change result asked "Replace your text?" instead of replacing it');
  assert(await page.locator('[data-action="ai-draft-restore"]').count() === 1, 'no Restore my text after a change');
  await shot(page, `compact-c7-${theme}-change`);
  await page.click('[data-action="ai-draft-restore"]');
  await page.waitForFunction(() => document.getElementById('reply-body')?.value === 'Sure, sending it at 14:30.', null, { timeout: 4000 });
}

/** A change that ended without a result (Stop) leaves no Restore for a later, unrelated draft. */
async function c7Stale(page, { assert, settled }) {
  await openReplyRow(page, settled, 'c-reply-1');
  await page.fill('.ws-crow-body #reply-body', 'Sure, sending it at 14:30.');
  await plan(page, { outcome: 'hold' });
  await page.fill('#reply-change', 'shorter');
  await page.press('#reply-change', 'Enter');
  await page.click('.ws-draft-running [data-action="ai-draft-stop"]', { timeout: 5000 });
  await page.waitForSelector('.ws-draft-running', { state: 'detached', timeout: 4000 });
  await page.fill('.ws-crow-body #reply-body', '');
  await plan(page, { outcome: 'ok', ms: 300, text: 'A fresh draft.', questions: [] });
  await page.click('.ws-reply-hint [data-action="ai-draft-quick"]');
  await page.waitForFunction(() => document.getElementById('reply-body')?.value === 'A fresh draft.', null, { timeout: 5000 });
  await settled(page);
  assert(await page.locator('[data-action="ai-draft-restore"]').count() === 0, 'a stopped change left a Restore on an unrelated draft');
}

/** Leaving the box (blur), Done, Snooze and a lane move save the typed text at once. */
async function c7Flush(page, { assert, settled, calls }) {
  const savedSoon = async (text, what) => {
    await page.waitForTimeout(500);
    const saves = await calls(page, 'draft_save');
    assert(saves.some(d => d.text === text), `${what} did not save the typed text at once: ${JSON.stringify(saves.map(d => d.text))}`);
  };
  await openReplyRow(page, settled);
  await page.fill('.ws-crow-body #reply-body', 'typed then left');
  await page.click('.ws-crow-body .ws-thread-compact');
  await savedSoon('typed then left', 'blur');
  // The decisions run with the focus still in the box (an element click does not move it).
  const decide = [
    ['Done', () => document.querySelector('.ws-crow-body [data-menu="reply-more"] [data-action="message-archive"]').click()],
    ['Snooze', () => document.querySelector('.ws-crow-body [data-menu="reply-snooze"] [data-action="message-snooze"][data-preset="3h"]').click()],
    ['a lane move', () => {
      const lane = document.querySelector('.ws-crow-body select[data-action="message-lane"]');
      lane.value = 'waiting';
      lane.dispatchEvent(new Event('change', { bubbles: true }));
    }],
  ];
  for (const [what, act] of decide) {
    await openReplyRow(page, settled);
    const text = `typed before ${what}`;
    await page.fill('.ws-crow-body #reply-body', text);
    assert(await page.evaluate(() => document.activeElement?.id === 'reply-body'), `the box lost focus before ${what}`);
    await page.evaluate(act);
    await savedSoon(text, what);
    // Saved before the decision, not only when the closing row takes the focused box away.
    const order = await page.evaluate(t => {
      const ops = window.__bridgeCalls;
      return { saved: ops.findIndex(([op, d]) => op === 'draft_save' && d.text === t), decided: ops.map(([op]) => op).lastIndexOf('inbox_decision') };
    }, text);
    assert(order.saved !== -1 && order.saved < order.decided, `${what}: the reply was saved after the decision ${JSON.stringify(order)}`);
  }
}

/** Send's save drops the pending autosave: one save of the text, none 1.5 s later. */
async function c7Send(page, { assert, settled, calls }) {
  await openReplyRow(page, settled, 'c-reply-1');
  const before = (await calls(page, 'draft_save')).length;
  await page.fill('.ws-crow-body #reply-body', 'send me');
  await page.click('.ws-crow-body [data-action="reply-send"]');
  await page.waitForSelector('.ws-modal[open]:has-text("Review before sending")');
  await page.waitForTimeout(1900);
  const saves = (await calls(page, 'draft_save')).slice(before);
  assert(saves.length === 1 && saves[0].text === 'send me', `saves around a send: ${JSON.stringify(saves.map(d => d.text))}`);
  await page.click('.ws-modal[open] button:has-text("Cancel")');
}

/** C1: Settings › Appearance → View. Compact applies at once (attributes, mirror, no reload) and
 *  is recorded; it survives a reload. `page` is already on the Appearance screen. */
async function c1(theme, page, { assert, shot, settled, calls }) {
  await page.click('[data-action="view-set"][data-view="compact"]');
  await settled(page);
  const recorded = await calls(page, 'settings_update');
  assert(recorded.some(d => d.view === 'compact'), `no settings_update {view: compact} recorded: ${JSON.stringify(recorded)}`);
  const attrs = await viewAttrs(page);
  assert(attrs.root === 'compact', `#workspace-app data-view: ${attrs.root}`);
  assert(attrs.html === 'compact', `html data-view: ${attrs.html}`);
  const mirror = await page.evaluate(() => localStorage.getItem('codemie.view'));
  assert(mirror === 'compact', `localStorage mirror: ${mirror}`);
  await shot(page, `compact-c1-appearance-${theme}`);

  // Reload: the native setting now agrees with the mirror, so the first paint is already Compact.
  await page.reload();
  await page.waitForSelector('.ws-sidebar');
  await settled(page);
  const first = await firstChildView(page);
  assert(first === 'compact', `#workspace-app's data-view at its first child, after reload: ${first}`);
}

/** A mirror that disagrees with the native default: the first paint follows the mirror, the
 *  snapshot then corrects both the attributes and the mirror back to native's `'default'`. `page`
 *  is already open with that mirror value and the (default) native settings. */
async function c1Mismatch(page, assert, mirrorValue, wantFirst) {
  const first = await firstChildView(page);
  assert(first === wantFirst, `#workspace-app's data-view at its first child (mirror '${mirrorValue}'): ${first}`);
  const attrs = await viewAttrs(page);
  assert(attrs.root === 'default' && attrs.html === 'default', `data-view after the snapshot loaded: ${JSON.stringify(attrs)}`);
  const mirror = await page.evaluate(() => localStorage.getItem('codemie.view'));
  assert(mirror === 'default', `localStorage mirror after the snapshot loaded: ${mirror}`);
}

export async function compactChecks({ open, check, assert, shot, settled, calls, OUT }) {
  const write = screensToWrite();
  let baseline = {};
  try { baseline = await readJson(BASELINE); } catch { /* first write */ }

  const openScreen = hash => open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, meetings: true, automations: true, hash });
  // The first screen opens before `check`, which looks for open dialogs on the current page.
  let first = await openScreen(SCREENS.today);
  await check('compact C0: Default sizes match the baseline on every screen', async () => {
    const problems = [];
    for (const [screen, hash] of Object.entries(SCREENS)) {
      const { page, context } = first || await openScreen(hash);
      first = null;
      try {
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => document.querySelectorAll('.ws-toast').forEach(t => t.remove()));
        await settled(page);
        // Spinners turn forever, so their rotated boxes differ from run to run: every endless
        // animation is held at its start and any finite one jumped to its end before measuring.
        await page.evaluate(() => document.getAnimations().forEach(a => {
          if (a.effect?.getComputedTiming().iterations === Infinity) { a.pause(); a.currentTime = 0; } else a.finish();
        }));
        const rows = await sizesOf(page);
        const entry = { count: rows.length, sha256: sha256(rows) };
        await writeFile(join(OUT, `sizes-${screen}.json`), JSON.stringify(rows, null, 1));
        if (write.has(screen)) {
          baseline[screen] = entry;
          await writeFile(join(OUT, `sizes-${screen}.baseline.json`), JSON.stringify(rows, null, 1));
          continue;
        }
        const want = baseline[screen];
        if (!want) { problems.push(`${screen}: no baseline (run with WORKSPACE_E2E_SIZES=write:${screen})`); continue; }
        if (want.count === entry.count && want.sha256 === entry.sha256) continue;
        let detail = `count ${entry.count} vs ${want.count}`;
        try {
          const old = await readJson(join(OUT, `sizes-${screen}.baseline.json`));
          const i = rows.findIndex((row, n) => JSON.stringify(row) !== JSON.stringify(old[n]));
          const at = i === -1 ? Math.min(rows.length, old.length) : i;
          detail += `, first difference at ${at}: ${JSON.stringify(rows[at])} vs ${JSON.stringify(old[at])}`;
        } catch { /* no local baseline dump to compare with */ }
        problems.push(`${screen}: ${detail}`);
      } finally {
        await context.close().catch(() => {});
      }
    }
    if (write.size) {
      const ordered = Object.fromEntries(Object.keys(SCREENS).filter(s => baseline[s]).map(s => [s, baseline[s]]));
      await writeFile(BASELINE, `${JSON.stringify(ordered, null, 2)}\n`);
    }
    assert(problems.length === 0, problems.join(' | '));
  });
  await first?.context.close().catch(() => {});

  // Each check opens its own screen first (as the C0 check above does for its first screen), so
  // `check`'s own look for a stray open dialog finds a page that is still open.
  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, hash: APPEARANCE });
    await check(`compact C1 (${theme}): Settings › Appearance › View switches to Compact at once, mirrored, and survives reload`, () => c1(theme, page, { assert, shot, settled, calls }));
    await context.close().catch(() => {});
  }
  for (const [mirrorValue, wantFirst] of [['compact', 'compact'], ['zzz', 'default']]) {
    const { page, context } = await open({ hash: APPEARANCE, localPrefs: { 'codemie.view': mirrorValue } });
    await check(`compact C1: a mirror of '${mirrorValue}' decides the first paint ('${wantFirst}'), then native's 'default' corrects it`, () => c1Mismatch(page, assert, mirrorValue, wantFirst));
    await context.close().catch(() => {});
  }

  for (const theme of ['dark', 'light']) {
    for (const view of ['compact', 'default']) {
      for (const width of [1000, 1440, 1680]) {
        const settings = view === 'compact' ? { view: 'compact' } : null;
        const { page, context } = await open({ theme, width, height: 900, now: FIXED_NOW, tasks: true, meetings: true, automations: true, settings });
        await check(`compact C2: ${theme} ${view} ${width}: no horizontal overflow, nothing clipped`, () => c2(page, theme, view, width, { assert, shot, settled }));
        await context.close().catch(() => {});
      }
    }
  }

  {
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, meetings: true, automations: true, settings: { view: 'compact' } });
    await check('compact C3: Compact uses Naya’s sizes', () => c3(page, { open, assert, settled }));
    await context.close().catch(() => {});
  }

  for (const theme of ['dark', 'light']) {
    for (const view of ['compact', 'default']) {
      const settings = view === 'compact' ? { view: 'compact' } : null;
      const { page, context } = await open({ theme, width: 1440, height: 900, now: FIXED_NOW, tasks: true, meetings: true, automations: true, settings, hash: '#/today' });
      await check(`compact C4 (${theme} ${view}): Today’s toolbar lives in ⋯`, () => c4(theme, view, page, { assert, shot, calls, settled }));
      await context.close().catch(() => {});
    }
  }

  for (const view of ['compact', 'default']) {
    const settings = view === 'compact' ? { view: 'compact' } : null;
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, meetings: true, automations: true, settings, hash: '#/settings/layout' });
    await check(`compact C5 (${view}): hidden pages leave the menu and still open by route`, () => c5(view, page, { open, assert, shot, calls, settled }));
    await context.close().catch(() => {});
  }

  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, width: 1440, height: 900, now: FIXED_NOW, settings: { view: 'compact' }, hash: '#/inbox' });
    await check(`compact C6 (${theme}): Inbox rows open in place`, () => c6(theme, page, { open, assert, shot, calls, settled }));
    await context.close().catch(() => {});
  }

  const c7 = [
    ['a change result replaces your text, with Restore my text', c7Change],
    ['a stopped change leaves no Restore on a later draft', c7Stale],
    ['blur, Done, Snooze and a lane move save the typed text at once', c7Flush],
    ['a send drops the pending autosave', c7Send],
  ];
  for (const [name, run] of c7) {
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, settings: { view: 'compact' }, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
    await check(`compact C7: ${name}`, () => run(page, { assert, shot, calls, settled, theme: 'dark' }));
    await context.close().catch(() => {});
  }
}
