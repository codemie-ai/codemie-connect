import { test, expect, Page } from '@playwright/test';

// Guards the two regressions an independent review found: the home grid outlived
// the assumption that it would be deleted, so both surfaces that reach an action
// have to keep working, and the sidebar must not become a way out of a run.

const BASE: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false, dev: true },
  get_logo_path: '',
  check_profile_status: { authenticated: true, detail: '' },
  get_platform_info: { arch: 'aarch64', platform: 'macos' }, temp_dir: '/tmp',
  read_codemie_config: {
    state: 'valid', profile: 'default', model: 'sonnet', project: 'epm-cdme', account: 'a@b.com',
  },
  // 1.1 is the real "Check Git" step, whose handler calls check_git — stubbed
  // below to never resolve, so the run genuinely stays in flight.
  get_steps: [
    { id: '1.1', title: 'Check Git', description: '', status: 'PENDING', is_sub_step: false },
  ],
};

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await page.addInitScript(({ r }) => {
    (window as any).__calls = [] as string[];
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => {
          (window as any).__calls.push(cmd);
          // Never resolve, so "while running" is observable in both cases.
          if (cmd === 'run_self_update') return new Promise(() => {});
          if (cmd === 'check_git' && (window as any).__hangInstall) return new Promise(() => {});
          return cmd in (r as any) ? (r as any)[cmd] : null;
        },
      },
      event: { listen: async () => () => {} },
    };
  }, { r: { ...BASE, ...extra } });
  await page.goto('/index.html');
  await page.waitForTimeout(300);
}

const UP_TO_DATE = { check_codemie_version: '0.14.1', fetch_codemie_latest: '0.14.1' };

test('the grid Update CLI tile shows progress even when the banner is hidden', async ({ page }) => {
  // installed == latest, so #update-banner is display:none. Rendering progress
  // only on the banner button meant this click ran a real npm install -g with
  // no feedback at all.
  await boot(page, UP_TO_DATE);
  await expect(page.locator('#update-banner')).toBeHidden();

  await page.locator('#update-cli-tile').click();
  await page.waitForTimeout(200);

  expect(await page.evaluate(() => (window as any).__calls)).toContain('run_self_update');
  const tile = await page.evaluate(() => ({
    state: document.getElementById('update-cli-tile')!.dataset.state,
    title: document.getElementById('update-cli-title')!.textContent,
    icon: document.getElementById('update-cli-icon')!.textContent,
  }));
  expect(tile.state, 'the tile must show it is working').toBe('updating');
  expect(tile.title).toBe('Updating…');
  expect(tile.icon).toBe('⏳');
});

test('the re-entrancy guard, not CSS, stops a second Update CLI run', async ({ page }) => {
  await boot(page, UP_TO_DATE);
  // element.click() dispatches directly and ignores pointer-events, so the
  // pre-existing [data-state="updating"] CSS cannot be what passes this.
  await page.evaluate(() => {
    const t = document.getElementById('update-cli-tile') as HTMLElement;
    t.click(); t.click(); t.click();
  });
  await page.waitForTimeout(250);
  const n = await page.evaluate(() =>
    ((window as any).__calls as string[]).filter((c) => c === 'run_self_update').length);
  expect(n, 'runUpdateCli must refuse to start while already running').toBe(1);
});

test('sibling tiles go inert while an update runs', async ({ page }) => {
  await boot(page, UP_TO_DATE);
  await page.locator('#update-cli-tile').click();
  await page.waitForTimeout(200);
  const dimmed = await page.$$eval('#installation-tiles .sub-tile:not(#update-cli-tile)',
    (els) => els.map((e) => getComputedStyle(e).pointerEvents));
  expect(dimmed.length).toBeGreaterThan(0);
  expect(dimmed.every((p) => p === 'none')).toBe(true);
});

test('the update banner cannot start a self-update during an install', async ({ page }) => {
  // The banner is shell chrome now, so it stays visible over the wizard — on
  // origin/main it lived inside the home grid and showView('wizard') hid it.
  await boot(page, { check_codemie_version: '0.13.0', fetch_codemie_latest: '0.14.2' });
  await page.evaluate(() => { (window as any).__hangInstall = true; });
  await page.locator('.home-tile[data-action="full"]').click();
  await page.locator('#install-btn').click();
  await page.waitForTimeout(200);

  await expect(page.locator('#update-banner'), 'banner is still on screen').toBeVisible();
  await page.evaluate(() => {
    (document.getElementById('update-banner-run') as HTMLElement).click();
    (document.getElementById('update-banner-dismiss') as HTMLElement).click();
  });
  await page.waitForTimeout(200);

  expect(await page.evaluate(() => (window as any).__calls), 'no concurrent self-update')
    .not.toContain('run_self_update');
  await expect(page.locator('#update-banner'), 'dismiss is inert too').toBeVisible();
});

test('dismissing the banner clears the grid update cue, as origin/main does', async ({ page }) => {
  await boot(page, { check_codemie_version: '0.13.0', fetch_codemie_latest: '0.14.2' });
  await page.locator('#update-banner-dismiss').click();
  expect(await page.evaluate(() => ({
    group: document.getElementById('installation-group')!.classList.contains('update-available'),
    tile: document.getElementById('update-cli-tile')!.dataset.state,
  }))).toEqual({ group: false, tile: undefined });
  // The badge is what survives a dismissal — the update still exists.
  await expect(page.locator('#identity-version-badge')).toHaveText('0.14.2 available');
});

test('an update-available cue reaches the grid, not just the banner', async ({ page }) => {
  await boot(page, { check_codemie_version: '0.13.0', fetch_codemie_latest: '0.14.2' });
  expect(await page.evaluate(() => ({
    group: document.getElementById('installation-group')!.classList.contains('update-available'),
    tile: document.getElementById('update-cli-tile')!.dataset.state,
  }))).toEqual({ group: true, tile: 'highlight' });
});

test('the sidebar cannot navigate away from a running install', async ({ page }) => {
  await boot(page, UP_TO_DATE);
  await page.evaluate(() => { (window as any).__hangInstall = true; });
  await page.locator('.home-tile[data-action="full"]').click();
  await expect(page.locator('#wizard-view')).not.toHaveClass(/hidden/);

  // Back out is deliberately unavailable during a run on origin/main.
  await page.locator('#install-btn').click();
  await expect(page.locator('#wizard-back')).toBeHidden();

  // CSS blocks the pointer...
  expect(await page.evaluate(() =>
    getComputedStyle(document.getElementById('app-sidebar')!).pointerEvents),
    'sidebar must be pointer-inert during a run').toBe('none');

  // ...and the JS guard covers keyboard activation, which pointer-events cannot.
  // element.click() dispatches directly, bypassing pointer-events entirely.
  await page.evaluate(() => (document.getElementById('sidebar-home') as HTMLElement).click());
  await expect(page.locator('#wizard-view'), 'sidebar must not leave a running install')
    .not.toHaveClass(/hidden/);
  await expect(page.locator('#home-view')).toHaveClass(/hidden/);
});
