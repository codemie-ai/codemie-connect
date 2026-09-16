import { test, expect, Page } from '@playwright/test';

// The behaviour EPMCDME-14511 names most insistently — the grid actions that
// must not vanish, and the banner's session dismissal key — had no coverage at
// all. Every assertion here was written against a surviving mutation.

const STEPS = [
  { id: '1.1', title: 'Check Git', description: '', status: 'PENDING', is_sub_step: false },
  { id: '1.2', title: 'Check Node', description: '', status: 'PENDING', is_sub_step: false },
  { id: '1.3', title: 'Install CodeMie', description: '', status: 'PENDING', is_sub_step: false },
  { id: '2.1', title: 'Configure', description: '', status: 'PENDING', is_sub_step: false },
];

const BASE: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false, dev: true },
  get_logo_path: '', get_steps: STEPS,
  check_profile_status: { authenticated: true, detail: '' },
  get_platform_info: { arch: 'aarch64', platform: 'macos' }, temp_dir: '/tmp',
  read_codemie_config: {
    state: 'valid', profile: 'p', model: 'm', project: 'j', account: null,
  },
};

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await page.addInitScript(({ r }) => {
    (window as any).__calls = [] as string[];
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          (window as any).__calls.push(cmd);
          return cmd in (r as any) ? (r as any)[cmd] : null;
        },
      },
      event: { listen: async () => () => {} },
    };
  }, { r: { ...BASE, ...extra } });
  await page.goto('/index.html');
  await page.waitForTimeout(300);
}

const UP_TO_DATE = { check_codemie_version: '1.0.0', fetch_codemie_latest: '1.0.0' };
const PENDING = { check_codemie_version: '0.13.0', fetch_codemie_latest: '0.14.2' };

// The rendered step titles identify which subset of config/steps.yaml was used.
const titles = (page: Page) =>
  page.$$eval('#step-list .step-row .step-title', (e) => e.map((x) => x.textContent!.trim()));

test('"Setup" reaches the wizard with every step', async ({ page }) => {
  await boot(page, UP_TO_DATE);
  await page.locator('.home-tile[data-action="full"]').click();
  await expect(page.locator('#wizard-mode-label')).toHaveText('Setup');
  expect(await titles(page)).toContain('Configure');
});

test('the Connect Claude Desktop tile still routes to Connections', async ({ page }) => {
  // Carried-forward behaviour EPMCDME-14510 is closed on. Only the sidebar
  // entry was covered; the grid tile was not.
  await boot(page, UP_TO_DATE);
  await page.locator('.home-tile[data-action="connect-desktop"]').click();
  await expect(page.locator('#connect-view')).not.toHaveClass(/hidden/);
  await expect(page.locator('#home-view')).toHaveClass(/hidden/);
});

test('a dismissed banner stays dismissed across a reload, and the key is what does it', async ({ page }) => {
  // The ticket: "Keep the banner's show/dismiss behaviour and its sessionStorage
  // dismissal key." Every other banner test dismisses within one page load, so
  // neither the write nor the read on the next boot was observed.
  await boot(page, PENDING);
  await expect(page.locator('#update-banner')).toBeVisible();
  await page.locator('#update-banner-dismiss').click();
  await expect(page.locator('#update-banner')).toBeHidden();

  expect(await page.evaluate(() => sessionStorage.getItem('update-banner-dismissed')),
    'the dismissal must be recorded').toBe('1');

  await page.reload();
  await page.waitForTimeout(400);
  await expect(page.locator('#update-banner'), 'and honoured on the next boot').toBeHidden();
  // The badge still reports the update exists — only the asking is suppressed.
  await expect(page.locator('#identity-version-badge')).toHaveText('0.14.2 available');

  // Clearing the key brings it back, proving the key is the mechanism.
  await page.evaluate(() => sessionStorage.removeItem('update-banner-dismissed'));
  await page.reload();
  await page.waitForTimeout(400);
  await expect(page.locator('#update-banner')).toBeVisible();
});

test('a successful update hides the banner without marking it dismissed', async ({ page }) => {
  // hideUpdateBanner exists only to avoid setting the key. The branch is only
  // reached when the update actually lands, so the stub has to move the
  // installed version — otherwise updateAvailable stays true and it never runs.
  await page.addInitScript(() => {
    let installed = '0.13.0';
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          if (cmd === 'run_self_update') { installed = '0.14.2'; return 0; }
          if (cmd === 'check_codemie_version') return installed;
          if (cmd === 'fetch_codemie_latest') return '0.14.2';
          if (cmd === 'smoke_mode') return { probe: false, smoke: false, dev: true };
          if (cmd === 'get_steps') return [];
          if (cmd === 'check_profile_status') return { authenticated: true, detail: '' };
          if (cmd === 'get_platform_info') return { arch: 'aarch64', platform: 'macos' };
          if (cmd === 'read_codemie_config') {
            return { state: 'valid', profile: 'p', model: 'm', project: 'j', account: null };
          }
          return null;
        },
      },
      event: { listen: async () => () => {} },
    };
  });
  await page.goto('/index.html');
  await page.waitForTimeout(300);
  await expect(page.locator('#update-banner')).toBeVisible();

  await page.locator('#update-banner-run').click();
  await expect(page.locator('#update-banner'), 'nothing left to announce').toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem('update-banner-dismissed')),
    'a completed update is not a dismissal').toBeNull();
});
