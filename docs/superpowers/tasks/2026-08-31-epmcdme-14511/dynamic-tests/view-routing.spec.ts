import { test, expect, Page } from '@playwright/test';

// Verifies the view registry: the six routed views plus the legacy install
// wizard all switch inside one shell, setup-view is its own container, and the
// router is reachable for verification only behind CODEMIE_DEV.

const ROUTED = ['home', 'setup', 'agents', 'connect', 'health', 'about'];
const CONTAINERS: Record<string, string> = {
  home: 'home-view', setup: 'setup-view', agents: 'agents-view',
  connect: 'connect-view', health: 'health-view', about: 'about-view',
  wizard: 'wizard-view',
};

const BASE: Record<string, unknown> = {
  get_steps: [], get_logo_path: '',
  check_profile_status: { authenticated: true, detail: '' },
  get_platform_info: { arch: 'aarch64', platform: 'macos' },
  temp_dir: '/tmp',
  check_codemie_version: '1.0.0', fetch_codemie_latest: '1.0.0',
  read_codemie_config: {
    state: 'valid', profile: 'default', model: 'sonnet', project: 'epm-cdme', account: 'a@b.com',
  },
};

const errors: string[] = [];

async function boot(page: Page, dev = true) {
  await page.addInitScript(({ base, dev }) => {
    const r = { ...(base as any), smoke_mode: { probe: false, smoke: false, dev } };
    (window as any).__TAURI__ = {
      core: { invoke: async (cmd: string) => (cmd in r ? (r as any)[cmd] : null) },
      event: { listen: async () => () => {} },
    };
  }, { base: BASE, dev });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto('/index.html');
  await page.waitForFunction(() => document.getElementById('home-view') !== null);
}

test.beforeEach(() => { errors.length = 0; });
test.afterEach(() => { expect(errors, 'no console or page errors').toEqual([]); });

test('setup-view is its own container, not wizard-view', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#setup-view')).toHaveCount(1);
  await expect(page.locator('#wizard-view')).toHaveCount(1);
  // The legacy engine renders into step-list; guided setup must not inherit it.
  expect(await page.locator('#setup-view #step-list').count()).toBe(0);
  expect(await page.locator('#setup-view').innerHTML()).toBe('');
});

test('every routed view switches inside the same shell, with no reload', async ({ page }) => {
  await boot(page);
  const marker = await page.evaluate(() => {
    (window as any).__stillHere = true;   // a reload would wipe this
    return true;
  });
  expect(marker).toBe(true);

  for (const name of [...ROUTED, 'wizard']) {
    await page.evaluate((n) => (window as any).__codemie.showView(n), name);
    // Exactly the target is displayed; every other container is display:none.
    const shown = await page.evaluate((ids) =>
      Object.fromEntries(Object.entries(ids).map(([route, id]) =>
        [route, getComputedStyle(document.getElementById(id as string)!).display !== 'none'])),
      CONTAINERS);
    expect(shown, `routing to ${name}`).toEqual(
      Object.fromEntries(Object.keys(CONTAINERS).map((r) => [r, r === name])));
    // The shell persists across every switch.
    await expect(page.locator('#app-sidebar')).toBeVisible();
    await expect(page.locator('#identity-bar')).toBeVisible();
    await expect(page.locator('#command-log-footer')).toBeVisible();
  }
  expect(await page.evaluate(() => (window as any).__stillHere)).toBe(true);
});

// About is hidden (no owner for its content), so only four entries are
// clickable. Its container still routes — covered by the six-view test above.
test('sidebar buttons route through their data-view', async ({ page }) => {
  await boot(page);
  for (const [btn, id] of [
    ['#sidebar-agents', 'agents-view'],
    ['#sidebar-connections', 'connect-view'],
    ['#sidebar-health', 'health-view'],
    ['#sidebar-home', 'home-view'],
  ]) {
    await page.locator(btn).click();
    expect(await page.evaluate((i) =>
      getComputedStyle(document.getElementById(i)!).display, id), btn).not.toBe('none');
  }
});

test('the dev hook is absent without the flag', async ({ page }) => {
  await boot(page, false);
  expect(await page.evaluate(() => (window as any).__codemie)).toBeUndefined();
});

test('the routed sidebar entry is marked current and styled as a pill', async ({ page }) => {
  await boot(page);
  // Home is current on landing, before any click.
  await expect(page.locator('#sidebar-home')).toHaveAttribute('aria-current', 'page');

  // .sidebar-item has a 120ms background transition, so a computed read right
  // after routing catches an interpolated alpha rather than the final colour.
  await page.waitForTimeout(250);
  const pill = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById('sidebar-home')!);
    return { bg: s.backgroundColor, color: s.color, weight: s.fontWeight, radius: s.borderRadius };
  });
  expect(pill.bg, 'the pill has a filled background').not.toBe('rgba(0, 0, 0, 0)');
  // `--radius` is not a token in codemie-tokens.css. Referencing it renders
  // square corners silently, which is what shipped until it was spotted by eye.
  expect(parseFloat(pill.radius), 'the pill is rounded').toBeGreaterThan(4);
  // Sampled from 01-home.png: periwinkle text on a flat indigo fill.
  expect(pill.color).toBe('rgb(196, 181, 253)');
  expect(pill.bg).toBe('rgb(43, 38, 62)');
  expect(pill.color).not.toBe(await page.evaluate(() =>
    getComputedStyle(document.getElementById('sidebar-agents')!).color));

  // Exactly one entry is ever current, and it follows the route.
  await page.locator('#sidebar-health').click();
  expect(await page.$$eval('#app-sidebar [aria-current="page"]', (e) => e.map((x) => x.id)))
    .toEqual(['sidebar-health']);

  // Setup has no sidebar entry, so nothing is current there.
  await page.evaluate(() => (window as any).__codemie.showView('setup'));
  expect(await page.$$eval('#app-sidebar [aria-current="page"]', (e) => e.length)).toBe(0);
});
