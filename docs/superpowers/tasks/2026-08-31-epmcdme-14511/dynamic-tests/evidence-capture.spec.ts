import { test, expect, Page } from '@playwright/test';

// Regenerates ../evidence/screenshots/ at the shipped window size (1000x660).
// Each capture asserts the thing it depicts, so a screenshot cannot go stale
// while still claiming to be evidence.

const SHOT = '../evidence/screenshots';
const BASE: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false, dev: true },
  get_steps: [], get_logo_path: '',
  check_profile_status: { authenticated: true, detail: '' },
  get_platform_info: { arch: 'aarch64', platform: 'macos' }, temp_dir: '/tmp',
};
const SSO = {
  state: 'valid', profile: 'default', model: 'Sonnet 5',
  project: 'EPM-CDME', account: 'n_levyankov@epam.com',
};

test.use({ viewport: { width: 1000, height: 660 } });

async function boot(page: Page, extra: Record<string, unknown>) {
  const r = { ...BASE, ...extra };
  await page.addInitScript(({ r }) => {
    (window as any).__TAURI__ = {
      core: { invoke: async (c: string) => (c in (r as any) ? (r as any)[c] : null) },
      event: { listen: async () => () => {} },
    };
  }, { r });
  await page.goto('/index.html');
  await page.waitForTimeout(350);
}

const UP_TO_DATE = { check_codemie_version: '0.14.1', fetch_codemie_latest: '0.14.1' };
const PENDING = { check_codemie_version: '0.14.1', fetch_codemie_latest: '0.14.2' };

test('shell-two-column-layout', async ({ page }) => {
  await boot(page, { ...UP_TO_DATE, read_codemie_config: SSO });
  await expect(page.locator('#app-sidebar')).toBeVisible();
  await expect(page.locator('#identity-bar')).toBeVisible();
  await expect(page.locator('#command-log-footer')).toBeVisible();
  await page.screenshot({ path: `${SHOT}/shell-two-column-layout.png` });
});

test('identity-bar-verified', async ({ page }) => {
  await boot(page, { ...PENDING, read_codemie_config: SSO });
  await expect(page.locator('#identity-account')).toHaveText('n_levyankov@epam.com');
  await expect(page.locator('#identity-version-badge')).toHaveText('0.14.2 available');
  await page.screenshot({ path: `${SHOT}/identity-bar-verified.png`,
    clip: { x: 0, y: 0, width: 1000, height: 40 } });
});

test('sidebar-no-analytics-entry', async ({ page }) => {
  await boot(page, { ...UP_TO_DATE, read_codemie_config: SSO });
  await expect(page.locator('#sidebar-analytics')).toBeHidden();
  await expect(page.locator('#sidebar-home')).toHaveAttribute('aria-current', 'page');
  await page.locator('#app-sidebar').screenshot({ path: `${SHOT}/sidebar-no-analytics-entry.png` });
});

test('update-banner-in-shell', async ({ page }) => {
  await boot(page, { ...PENDING, read_codemie_config: SSO });
  await expect(page.locator('#update-banner')).toBeVisible();
  await expect(page.locator('#update-banner-run')).toBeVisible();
  await page.screenshot({ path: `${SHOT}/update-banner-in-shell.png` });
});

test('first-run-no-config', async ({ page }) => {
  await boot(page, {
    check_codemie_version: '', fetch_codemie_latest: '',
    check_profile_status: { authenticated: false, detail: '' },
    read_codemie_config: { state: 'no-configuration', profile: '', model: '', project: '', account: null },
  });
  await expect(page.locator('#identity-product')).toHaveText('CodeMie Desktop');
  await expect(page.locator('#identity-profile')).toBeHidden();
  await page.screenshot({ path: `${SHOT}/first-run-no-config.png` });
});

test('setup-view-routed', async ({ page }) => {
  await boot(page, { ...UP_TO_DATE, read_codemie_config: SSO });
  await page.evaluate(() => (window as any).__codemie.showView('setup'));
  await expect(page.locator('#setup-view')).not.toHaveClass(/hidden/);
  await expect(page.locator('#home-view')).toHaveClass(/hidden/);
  await page.screenshot({ path: `${SHOT}/setup-view-routed.png` });
});
