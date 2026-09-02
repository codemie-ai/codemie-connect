import { test, expect, Page } from '@playwright/test';

// Verifies the CLI update banner in its new shell region: it no longer touches
// any home-grid id, the Update CLI action is reachable from the banner itself,
// and the badge tracks whether an update exists rather than whether the banner
// is showing. A pending update is forced by stubbing installed < latest, since
// on an up-to-date machine none of this code runs.

const BASE: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false },
  get_steps: [],
  get_logo_path: '',
  check_profile_status: { authenticated: true, detail: '' },
  get_platform_info: { arch: 'aarch64', platform: 'macos' },
  temp_dir: '/tmp',
  read_codemie_config: {
    state: 'valid', profile: 'default', model: 'sonnet', project: 'epm-cdme', account: 'a@b.com',
  },
};

const errors: string[] = [];

// `updateTo` makes the stub stateful: run_self_update flips the installed
// version, so the post-update re-probe sees the new one, as the real CLI would.
async function boot(
  page: Page, installed: string, latest: string, updateTo?: string, failUpdate = false,
) {
  await page.addInitScript(({ base, installed, latest, updateTo, failUpdate }) => {
    let current = installed;
    (window as any).__calls = [] as string[];
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          (window as any).__calls.push(cmd);
          if (cmd === 'check_codemie_version') return current;
          if (cmd === 'fetch_codemie_latest') return latest;
          if (cmd === 'run_self_update') {
            if (failUpdate) throw new Error('npm exploded');
            if (updateTo) current = updateTo;
            return 0;
          }
          return cmd in (base as any) ? (base as any)[cmd] : null;
        },
      },
      event: { listen: async () => () => {} },
    };
  }, { base: BASE, installed, latest, updateTo, failUpdate });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto('/index.html');
  await page.waitForFunction(() => (window as any).__calls?.includes('fetch_codemie_latest'));
}

test.beforeEach(() => { errors.length = 0; });
// A surviving grid lookup would throw here — the old banner read four grid ids.
test.afterEach(() => { expect(errors, 'no console or page errors').toEqual([]); });

test('a pending update shows the banner, the badge, and a reachable action', async ({ page }) => {
  await boot(page, '0.13.0', '0.14.2');
  await expect(page.locator('#update-banner')).toBeVisible();
  await expect(page.locator('#update-from')).toHaveText('0.13.0');
  await expect(page.locator('#update-to')).toHaveText('0.14.2');
  await expect(page.locator('#identity-version-badge')).toHaveText('0.14.2 available');
  await expect(page.locator('#update-banner-run')).toBeVisible();
  await expect(page.locator('#update-banner-run')).toBeEnabled();
});

test('the banner lives in the shell, not inside the Home view', async ({ page }) => {
  await boot(page, '0.13.0', '0.14.2');
  // EPMCDME-14507 must be able to place its component without editing Home.
  expect(await page.locator('#home-view #update-banner').count()).toBe(0);
  expect(await page.evaluate(() =>
    document.getElementById('update-banner')!.parentElement!.id)).toBe('app');
});

test('Update CLI runs from the banner and retires it on success', async ({ page }) => {
  await boot(page, '0.13.0', '0.14.2', '0.14.2');
  await page.locator('#update-banner-run').click();
  await expect(page.locator('#update-banner')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__calls)).toContain('run_self_update');
  // Nothing left to announce, so the badge goes with it.
  await expect(page.locator('#identity-version-badge')).toHaveText('');
});

test('a failed update reports on the banner button and leaves the banner up', async ({ page }) => {
  await boot(page, '0.13.0', '0.14.2', undefined, true);
  await page.locator('#update-banner-run').click();
  await expect(page.locator('#update-banner-run')).toHaveText('Failed — retry?');
  await expect(page.locator('#update-banner')).toBeVisible();
});

test('dismissing hides the banner but leaves the badge standing', async ({ page }) => {
  await boot(page, '0.13.0', '0.14.2');
  await page.locator('#update-banner-dismiss').click();
  await expect(page.locator('#update-banner')).toBeHidden();
  // The update is still pending, so the steady-state badge must survive.
  await expect(page.locator('#identity-version-badge')).toHaveText('0.14.2 available');
});

test('an up-to-date CLI shows neither banner nor badge', async ({ page }) => {
  await boot(page, '0.14.2', '0.14.2');
  await expect(page.locator('#update-banner')).toBeHidden();
  await expect(page.locator('#identity-version-badge')).toHaveText('');
  await expect(page.locator('#identity-version-badge')).toBeHidden();
});
