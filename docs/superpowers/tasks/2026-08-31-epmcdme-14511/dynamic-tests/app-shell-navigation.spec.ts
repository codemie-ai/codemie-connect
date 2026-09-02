import { test, expect, Page } from '@playwright/test';

// Dynamic verification test for EPMCDME-14511 (app shell + navigation).
// The renderer talks to Tauri's `invoke`/`listen` at module scope; there is no
// dev server / browser story for this desktop app, so this test injects a
// minimal `window.__TAURI__` stub before the page scripts run and drives the
// real `ui/index.html` + `ui/renderer.js` (served over http by static-server.mjs
// — ES module imports are blocked under file://) against it.
//
// ROUND 2: assertions are on COMPUTED GEOMETRY (getBoundingClientRect / computed
// style), not element presence. Round 1 passed on presence checks and missed
// that the shell was stacked vertically instead of a two-column layout.

const INVOKE_RESPONSES: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false },
  get_steps: [],
  get_logo_path: '',
  check_codemie_version: '1.0.0',
  fetch_codemie_latest: '1.0.0',
  check_profile_status: { authenticated: true, detail: '' },
  read_codemie_config: {
    state: 'valid', profile: 'default', model: 'Sonnet 5', project: 'EPM-CDME',
    account: 'n_levyankov@epam.com',
  },
  get_platform_info: { arch: 'aarch64', platform: 'macos' },
  temp_dir: '/tmp',
};

const consoleErrors: string[] = [];

async function rect(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
  }, selector);
}

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ responses }) => {
    // Record every invoke from inside the stub: renderer.js destructures
    // `invoke` at module scope, so patching it after load would not intercept.
    (window as any).__invokes = [];
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          (window as any).__invokes.push(cmd);
          return cmd in responses ? responses[cmd] : null;
        },
      },
      event: { listen: async () => () => {} },
    };
  }, { responses: INVOKE_RESPONSES });

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto('/index.html');
  await page.waitForFunction(() => document.getElementById('sidebar-home') !== null);
  await page.waitForTimeout(200);
});

// ---------------------------------------------------------------- 1. LAYOUT
test('shell is a TWO-COLUMN layout: identity bar spans the top, sidebar is a left column beside the view container', async ({ page }) => {
  const identity = (await rect(page, '#identity-bar'))!;
  const shellBody = (await rect(page, '#shell-body'))!;
  const sidebar = (await rect(page, '#app-sidebar'))!;
  const viewC = (await rect(page, '#view-container'))!;
  const viewport = page.viewportSize()!;

  // Identity bar: full window width, at the very top.
  expect(identity.width).toBeGreaterThanOrEqual(viewport.width - 2);
  expect(identity.top).toBeLessThanOrEqual(2);

  // Shell body sits BELOW the identity bar.
  expect(shellBody.top).toBeGreaterThanOrEqual(identity.bottom - 1);

  // --- THE CORE ASSERTION: side by side, NOT stacked. ---
  // Sidebar's right edge is at or left of the view container's left edge.
  expect(sidebar.right).toBeLessThanOrEqual(viewC.left + 1);
  // And they overlap vertically (a stacked layout would have zero overlap).
  const vOverlap = Math.min(sidebar.bottom, viewC.bottom) - Math.max(sidebar.top, viewC.top);
  expect(vOverlap).toBeGreaterThan(200);

  // Sidebar is a ~180px left column at the left edge of the shell body.
  expect(sidebar.width).toBeGreaterThan(150);
  expect(sidebar.width).toBeLessThan(220);
  expect(sidebar.left).toBeLessThanOrEqual(shellBody.left + 1);
  // Full height of the shell body.
  expect(sidebar.height).toBeGreaterThanOrEqual(shellBody.height - 2);

  // View container takes the remaining width to the RIGHT.
  expect(viewC.width).toBeGreaterThan(viewport.width - sidebar.width - 40);
  expect(viewC.right).toBeGreaterThanOrEqual(shellBody.right - 1);

  // Sidebar has a right border separating the columns.
  const borderRight = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('app-sidebar')!);
    return { width: cs.borderRightWidth, style: cs.borderRightStyle };
  });
  expect(parseFloat(borderRight.width)).toBeGreaterThan(0);
  expect(borderRight.style).not.toBe('none');

  await page.screenshot({ path: 'shell-two-column-layout.png', fullPage: false });
});

// ------------------------------------------------------- 2. SIDEBAR GROUPING
test('the sidebar offers Home, Agents, Connections and Health, in order', async ({ page }) => {
  await expect(page.locator('#sidebar-home')).toHaveText('Home');
  await expect(page.locator('#sidebar-agents')).toHaveText('Agents');
  await expect(page.locator('#sidebar-connections')).toHaveText('Connections');
  await expect(page.locator('#sidebar-health')).toHaveText('Health');

  const home = (await rect(page, '#sidebar-home'))!;
  const agents = (await rect(page, '#sidebar-agents'))!;
  const connections = (await rect(page, '#sidebar-connections'))!;
  const health = (await rect(page, '#sidebar-health'))!;

  // Main group renders top-to-bottom in order.
  expect(home.top).toBeLessThan(agents.top);
  expect(agents.top).toBeLessThan(connections.top);
  expect(connections.top).toBeLessThan(health.top);

  // Nothing is offered below Health. About and the analytics entry are present
  // but hidden — neither has an owner for its content — and the divider goes
  // with them, since its only job was separating them from the main group.
  for (const id of ['#sidebar-about', '#sidebar-analytics', '#sidebar-divider']) {
    await expect(page.locator(id), id).toHaveCount(1);
    await expect(page.locator(id), id).toBeHidden();
  }
  const visible = await page.$$eval('#app-sidebar .sidebar-item', (els) =>
    els.filter((e) => getComputedStyle(e).display !== 'none')
       .map((e) => (e as HTMLElement).innerText.trim()));
  expect(visible).toEqual(['Home', 'Agents', 'Connections', 'Health']);
});

// ---------------------------------------------------------- 3. IDENTITY BAR
test('identity bar renders one row left-to-right with middot separators and a right-aligned version badge', async ({ page }) => {
  // Read from the config file at run time. The em-dash placeholders this once
  // asserted are exactly what the identity acceptance criterion forbids.
  await expect(page.locator('#identity-auth-status')).toHaveText('Signed in');
  await expect(page.locator('#identity-account')).toHaveText('n_levyankov@epam.com');
  await expect(page.locator('#identity-profile')).toHaveText('default');
  await expect(page.locator('#identity-model')).toHaveText('Sonnet 5');
  await expect(page.locator('#identity-project')).toHaveText('EPM-CDME');

  const bar = (await rect(page, '#identity-bar'))!;
  const auth = (await rect(page, '#identity-auth-status'))!;
  const account = (await rect(page, '#identity-account'))!;
  const profile = (await rect(page, '#identity-profile'))!;
  const model = (await rect(page, '#identity-model'))!;
  const project = (await rect(page, '#identity-project'))!;

  // ONE row: all four share (almost) the same vertical centre.
  const centres = [auth, account, profile, model, project].map((r) => r.top + r.h / 2);
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(3);

  // Left to right in order.
  expect(auth.left).toBeLessThan(account.left);
  expect(account.left).toBeLessThan(profile.left);
  expect(profile.left).toBeLessThan(model.left);
  expect(model.left).toBeLessThan(project.left);

  // "·" separators come from ::before on every span after the first.
  const separators = await page.evaluate(() =>
    ['#identity-account', '#identity-model', '#identity-project', '#identity-version-badge'].map(
      (sel) => getComputedStyle(document.querySelector(sel)!, '::before').content,
    ),
  );
  expect(separators[0]).toContain('·');
  expect(separators[1]).toContain('·');
  expect(separators[2]).toContain('·');
  // The badge is pushed to the far right and must NOT carry a leading middot.
  // `#identity-bar > #identity-version-badge::before` (2,0,1) outranks
  // `#identity-bar > span + span::before` (1,0,3), so content resolves to none.
  expect(separators[3], 'version badge must not render a leading middot').toBe('none');

  // Empty badge is not rendered at all (installed == latest in the stub).
  await expect(page.locator('#identity-version-badge')).toHaveCount(1);
  await expect(page.locator('#identity-version-badge')).toHaveText('');
  await expect(page.locator('#identity-version-badge')).toBeHidden();

  // When populated, the badge is right-aligned in the identity bar.
  await page.evaluate(() => {
    document.getElementById('identity-version-badge')!.textContent = '0.14.2 available';
  });
  const badge = (await rect(page, '#identity-version-badge'))!;
  expect(badge.width).toBeGreaterThan(0);
  // The theme toggle moved INTO the bar as its last child, so the toggle — not
  // the badge — is the element flush against the bar's content edge. The badge
  // is pushed right by margin-left:auto and sits immediately left of it.
  const barContentRight = await page.evaluate(() => {
    const el = document.getElementById('identity-bar')!;
    const cs = getComputedStyle(el);
    return el.getBoundingClientRect().right
      - parseFloat(cs.paddingRight)
      - parseFloat(cs.borderRightWidth);
  });
  const toggle = (await rect(page, '#theme-toggle'))!;
  expect(Math.abs(barContentRight - toggle.right)).toBeLessThan(2);
  expect(badge.right).toBeLessThan(toggle.left);
  expect(badge.right).toBeLessThan(bar.right);
  // Clearly to the right of the last identity field, not adjacent to it.
  expect(badge.left).toBeGreaterThan(project.right + 100);

  // The full badge text must be laid out, not clipped by the reserved padding.
  const clipping = await page.evaluate(() => {
    const el = document.getElementById('identity-version-badge')!;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: el.textContent };
  });
  expect(clipping.text).toBe('0.14.2 available');
  expect(clipping.scrollWidth).toBeLessThanOrEqual(clipping.clientWidth);

  // The badge must actually be readable — nothing may paint over it. The fixed
  // #theme-toggle (position:fixed; top:10px; right:12px; z-index:45) sits in the
  // same corner as the right-aligned badge.
  const occlusion = await page.evaluate(() => {
    const b = document.getElementById('identity-version-badge')!.getBoundingClientRect();
    const t = document.getElementById('theme-toggle')!.getBoundingClientRect();
    const overlapX = Math.min(b.right, t.right) - Math.max(b.left, t.left);
    const overlapY = Math.min(b.bottom, t.bottom) - Math.max(b.top, t.top);
    // What is actually painted at the badge's own centre point?
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      overlapPx: overlapX > 0 && overlapY > 0 ? overlapX * overlapY : 0,
      topElementAtBadgeCentre: hit ? (hit.id || hit.className || hit.tagName) : null,
    };
  });
  expect(occlusion.overlapPx, 'theme toggle must not overlap the version badge').toBe(0);
  expect(
    occlusion.topElementAtBadgeCentre,
    'the badge itself must be the topmost element at its own centre',
  ).toBe('identity-version-badge');

  await page.screenshot({ path: 'identity-bar-with-badge.png', clip: { x: 0, y: 0, width: 1280, height: 44 } });

  // Restore empty state.
  await page.evaluate(() => {
    document.getElementById('identity-version-badge')!.textContent = '';
  });
  await expect(page.locator('#identity-version-badge')).toBeHidden();
});

// ------------------------------------------------------- 4. SIX-VIEW ROUTING
test('all six views resolve, exactly one is visible at a time, and switching never reloads the page', async ({ page }) => {
  // Tag the document so a reload would be detectable.
  await page.evaluate(() => { (window as any).__noReload = true; });

  const allViews = ['#home-view', '#agents-view', '#connect-view', '#health-view', '#about-view', '#wizard-view'];
  for (const sel of allViews) {
    await expect(page.locator(sel)).toHaveCount(1);
  }

  async function visibleViews() {
    // agents/health/about are intentionally empty placeholder divs in this
    // ticket, so height is 0 even when active — key off rendered display state.
    return page.evaluate((sels) => sels.filter((s) => {
      const el = document.querySelector(s) as HTMLElement;
      if (!el) return false;
      return getComputedStyle(el).display !== 'none' && el.offsetParent !== null;
    }), allViews);
  }

  const navClicks: Array<[string, string]> = [
    ['#sidebar-agents', '#agents-view'],
    ['#sidebar-connections', '#connect-view'],
    ['#sidebar-health', '#health-view'],
    ['#sidebar-home', '#home-view'],
  ];
  for (const [navSel, viewSel] of navClicks) {
    await page.locator(navSel).click();
    await expect(page.locator(viewSel)).not.toHaveClass(/hidden/);
    // Exactly one view visible.
    const vis = await visibleViews();
    expect(vis).toEqual([viewSel]);
    // Shell chrome stays mounted; no reload.
    expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
    await expect(page.locator('#app-sidebar')).toBeVisible();
    await expect(page.locator('#identity-bar')).toBeVisible();
  }

  // about-view still routes even though its sidebar entry is hidden — the
  // container and its wiring are intact, so restoring the entry is a one-class
  // change. Reached the same way Setup is, since neither has a visible entry.
  await page.evaluate(() => {
    document.getElementById('about-view')!.classList.remove('hidden');
    ['home', 'agents', 'connect', 'health', 'wizard', 'setup'].forEach((v) =>
      document.getElementById(`${v}-view`)!.classList.add('hidden'));
  });
  expect(await visibleViews()).toEqual(['#about-view']);
  await page.locator('#sidebar-home').click();

  // Sixth view (wizard) is entered contextually from Home, not from the sidebar.
  await expect(page.locator('#app-sidebar [data-view="wizard"]')).toHaveCount(0);
  await page.locator('.home-tile[data-action="full"]').click();
  await expect(page.locator('#wizard-view')).not.toHaveClass(/hidden/);
  expect(await visibleViews()).toEqual(['#wizard-view']);
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
  await expect(page.locator('#app-sidebar')).toBeVisible();

  await page.locator('#wizard-back').click();
  await expect(page.locator('#home-view')).not.toHaveClass(/hidden/);
  expect(await visibleViews()).toEqual(['#home-view']);
});

// --------------------------------------------------- 5. COLLAPSIBLE FOOTER
test('command-log footer is a visible, collapsed-by-default <details> that toggles on click', async ({ page }) => {
  const footer = page.locator('#command-log-footer');
  await expect(footer).toHaveCount(1);

  const tag = await page.evaluate(() => document.getElementById('command-log-footer')!.tagName);
  expect(tag).toBe('DETAILS');

  // VISIBLE and COLLAPSED by default.
  await expect(footer).toBeVisible();
  expect(await page.evaluate(() => (document.getElementById('command-log-footer') as HTMLDetailsElement).open)).toBe(false);

  const summary = page.locator('#command-log-footer > summary');
  await expect(summary).toHaveText('what CodeMie ran');
  await expect(summary).toBeVisible();

  // Collapsed: the footer is no taller than its summary row.
  const summaryH = (await rect(page, '#command-log-footer > summary'))!.height;
  const closedH = (await rect(page, '#command-log-footer'))!.height;
  expect(closedH).toBeLessThanOrEqual(summaryH + 4);
  await expect(page.locator('#command-log-body')).toBeHidden();

  // Toggles open on click.
  await summary.click();
  expect(await page.evaluate(() => (document.getElementById('command-log-footer') as HTMLDetailsElement).open)).toBe(true);
  await expect(page.locator('#command-log-body')).toHaveCount(1);
  // Body exists and is empty (populated by a later ticket).
  expect(await page.evaluate(() => document.getElementById('command-log-body')!.textContent!.trim())).toBe('');

  // Toggles closed again.
  await summary.click();
  expect(await page.evaluate(() => (document.getElementById('command-log-footer') as HTMLDetailsElement).open)).toBe(false);
});

// ------------------------------------------- 6. UPDATE BANNER / FOOTER PLACEMENT
test('update banner sits directly under the identity bar outside any view; footer sits at shell bottom outside shell-body', async ({ page }) => {
  const placement = await page.evaluate(() => {
    const banner = document.getElementById('update-banner')!;
    const footer = document.getElementById('command-log-footer')!;
    const shellBody = document.getElementById('shell-body')!;
    const identity = document.getElementById('identity-bar')!;
    const viewC = document.getElementById('view-container')!;
    return {
      bannerExists: !!banner,
      bannerInsideAnyView: !!banner.closest('#view-container'),
      bannerInsideShellBody: shellBody.contains(banner),
      bannerPrevIsIdentity: banner.previousElementSibling === identity,
      bannerParentIsShellRoot: banner.parentElement === identity.parentElement,
      footerInsideShellBody: shellBody.contains(footer),
      footerInsideViewContainer: viewC.contains(footer),
      footerIsAfterShellBody: !!(shellBody.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING),
      footerIsLastShellChild: footer.parentElement!.lastElementChild === footer,
    };
  });

  expect(placement.bannerExists).toBe(true);
  // Named region directly under the identity bar, OUTSIDE any view.
  expect(placement.bannerInsideAnyView).toBe(false);
  expect(placement.bannerInsideShellBody).toBe(false);
  expect(placement.bannerPrevIsIdentity).toBe(true);
  expect(placement.bannerParentIsShellRoot).toBe(true);

  // Footer at the bottom of the shell, OUTSIDE #shell-body.
  expect(placement.footerInsideShellBody).toBe(false);
  expect(placement.footerInsideViewContainer).toBe(false);
  expect(placement.footerIsAfterShellBody).toBe(true);
  expect(placement.footerIsLastShellChild).toBe(true);

  // Geometrically below the shell body too.
  const shellBody = (await rect(page, '#shell-body'))!;
  const footer = (await rect(page, '#command-log-footer'))!;
  expect(footer.top).toBeGreaterThanOrEqual(shellBody.bottom - 1);
});

// ------------------------------------------------- 7. ANALYTICS ENTRY POINT
test('analytics keeps its carried-forward grid tile, and no sidebar entry', async ({ page }) => {
  // EPMCDME-14350 defers an in-app usage/spend/history SURFACE. This is a CLI
  // passthrough Connect 2.0.1 ships today, and the parent's own design comment
  // calls dropping it "a regression for current users" with the decision still
  // open — so the tile stays until someone decides. What must NOT ship is the
  // sidebar entry an earlier round invented; that is a new entry point.
  const tile = page.locator('.home-tile[data-action="analytics"]');
  await expect(tile).toHaveCount(1);
  await expect(tile).toBeVisible();

  await expect(page.locator('#sidebar-analytics')).toHaveCount(1);
  await expect(page.locator('#sidebar-analytics')).toBeHidden();
  const visible = await page.$$eval('#app-sidebar .sidebar-item', (els) =>
    els.filter((e) => getComputedStyle(e).display !== 'none')
       .map((e) => (e as HTMLElement).innerText.trim()));
  expect(visible).not.toContain('CLI usage analytics');

  // The tile reaches runAnalytics: it invokes rather than switching view.
  await page.evaluate(() => { (window as any).__invokes.length = 0; });
  await tile.click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => ((window as any).__invokes as string[]).length))
    .toBeGreaterThan(0);
  await expect(page.locator('#home-view')).not.toHaveClass(/hidden/);
});
