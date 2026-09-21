import { test, Page } from '@playwright/test';

// Renders the real ui/ with a FORCED pending update, so the banner and badge
// can be seen on a machine already running the latest CLI (installed == latest
// means neither ever appears). Produces screenshots only — no assertions.

const BASE: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false, dev: true },
  get_steps: [], get_logo_path: '',
  check_profile_status: { authenticated: true, detail: '' },
  get_platform_info: { arch: 'aarch64', platform: 'macos' },
  temp_dir: '/tmp',
};

async function boot(page: Page, extra: Record<string, unknown>) {
  const r = { ...BASE, ...extra };
  await page.addInitScript(({ r }) => {
    (window as any).__TAURI__ = {
      core: { invoke: async (c: string) => (c in (r as any) ? (r as any)[c] : null) },
      event: { listen: async () => () => {} },
    };
  }, { r });
  await page.goto('/index.html');
  await page.waitForTimeout(400);
}

const SSO = {
  state: 'valid', profile: 'default', model: 'Sonnet 5', project: 'EPM-CDME',
  account: 'n_levyankov@epam.com',
};

test('forced pending update — banner and badge', async ({ page }) => {
  await boot(page, {
    check_codemie_version: '0.14.1', fetch_codemie_latest: '0.14.2',
    read_codemie_config: SSO,
  });
  await page.screenshot({ path: 'shot-update-pending.png', fullPage: false });
});

test('up to date — neither banner nor badge (this machine today)', async ({ page }) => {
  await boot(page, {
    check_codemie_version: '0.14.1', fetch_codemie_latest: '0.14.1',
    read_codemie_config: SSO,
  });
  await page.screenshot({ path: 'shot-up-to-date.png', fullPage: false });
});

test('first run — no config file at all', async ({ page }) => {
  await boot(page, {
    check_codemie_version: '', fetch_codemie_latest: '',
    check_profile_status: { authenticated: false, detail: '' },
    read_codemie_config: {
      state: 'no-configuration', profile: '', model: '', project: '', account: null,
    },
  });
  await page.screenshot({ path: 'shot-first-run.png', fullPage: false });
});
