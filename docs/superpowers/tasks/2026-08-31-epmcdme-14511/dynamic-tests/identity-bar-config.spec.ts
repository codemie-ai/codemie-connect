import { test, expect, Page } from '@playwright/test';

// Verifies the identity bar renders from read_codemie_config — the four cases
// 01-home.png draws, plus the API-key profile that legitimately has no account.
//
// Every assertion is on rendered text or computed visibility, never on element
// presence: an empty segment stays in the DOM and is hidden by CSS, so
// `toBeHidden()` is what proves the segment was actually omitted.

const BASE_INVOKES: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false },
  get_steps: [],
  get_logo_path: '',
  check_profile_status: { authenticated: true, detail: '' },
  get_platform_info: { arch: 'aarch64', platform: 'macos' },
  temp_dir: '/tmp',
  check_codemie_version: '1.0.0',
  fetch_codemie_latest: '1.0.0',
};

const withConfig = (read_codemie_config: unknown) => ({ ...BASE_INVOKES, read_codemie_config });

const SSO = withConfig({
  state: 'valid',
  profile: 'default',
  model: 'sonnet',
  project: 'epm-cdme',
  account: 'n_levyankov@epam.com',
});
// The .codemie/ file in this repository: a valid config with no userEmail.
const API_KEY = withConfig({
  state: 'valid', profile: 'epm-cdme', model: 'claude-sonnet-4-6', project: 'epm-cdme', account: null,
});
const NO_CONFIG = withConfig({
  state: 'no-configuration', profile: '', model: '', project: '', account: null,
});
const BROKEN = withConfig({
  state: 'broken', profile: 'gone', model: '', project: '', account: 'n_levyankov@epam.com',
});

const errors: string[] = [];

async function boot(page: Page, responses: Record<string, unknown>) {
  await page.addInitScript(({ r }) => {
    (window as any).__TAURI__ = {
      core: { invoke: async (cmd: string) => (cmd in r ? (r as any)[cmd] : null) },
      event: { listen: async () => () => {} },
    };
  }, { r: responses });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto('/index.html');
  await page.waitForFunction(() =>
    document.getElementById('identity-auth-status')?.textContent !== 'Checking sign-in…');
}

test.beforeEach(() => { errors.length = 0; });
test.afterEach(() => { expect(errors, 'no console or page errors').toEqual([]); });

test('SSO profile renders account, profile, model and project', async ({ page }) => {
  await boot(page, SSO);
  await expect(page.locator('#identity-account')).toHaveText('n_levyankov@epam.com');
  await expect(page.locator('#identity-profile')).toHaveText('default');
  await expect(page.locator('#identity-model')).toHaveText('sonnet');
  await expect(page.locator('#identity-project')).toHaveText('epm-cdme');
  await expect(page.locator('#identity-product')).toBeHidden();
  // The criterion forbids em-dash placeholders anywhere in the bar.
  expect(await page.locator('#identity-bar').innerText()).not.toContain('—');
});

test('API-key profile omits the account segment rather than filling it in', async ({ page }) => {
  await boot(page, API_KEY);
  await expect(page.locator('#identity-account')).toBeHidden();
  await expect(page.locator('#identity-profile')).toHaveText('epm-cdme');
  await expect(page.locator('#identity-model')).toHaveText('claude-sonnet-4-6');
  await expect(page.locator('#identity-project')).toHaveText('epm-cdme');
  expect(await page.locator('#identity-bar').innerText()).not.toContain('—');
});

test('no configuration shows the product name and no identity fields', async ({ page }) => {
  await boot(page, NO_CONFIG);
  await expect(page.locator('#identity-product')).toHaveText('CodeMie Desktop');
  for (const id of ['account', 'profile', 'model', 'project']) {
    await expect(page.locator(`#identity-${id}`)).toBeHidden();
  }
});

test('broken config shows what is readable and hides the rest', async ({ page }) => {
  await boot(page, BROKEN);
  await expect(page.locator('#identity-account')).toHaveText('n_levyankov@epam.com');
  await expect(page.locator('#identity-profile')).toHaveText('gone');
  await expect(page.locator('#identity-model')).toBeHidden();
  await expect(page.locator('#identity-project')).toBeHidden();
  await expect(page.locator('#identity-product')).toBeHidden();
});

test('a hidden segment does not leave a dangling separator', async ({ page }) => {
  await boot(page, API_KEY);
  // Separators are ::before pseudo-elements, so innerText cannot see them.
  // Read the computed content of every VISIBLE span: the first must carry no
  // separator and every following one exactly one, with nothing trailing.
  const run = await page.$$eval('#identity-bar > span', (spans) =>
    spans
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => ({
        id: el.id,
        sep: getComputedStyle(el, '::before').content,
        text: (el as HTMLElement).innerText,
      })));

  expect(run.map((r) => r.id)).toEqual([
    'identity-auth-status', 'identity-profile', 'identity-model', 'identity-project',
  ]);
  expect(run[0].sep, 'the leading segment carries no separator').toBe('none');
  for (const r of run.slice(1)) {
    expect(r.sep, `${r.id} separator`).toBe('"\u00b7"');
  }
  expect(run.map((r) => r.text).join(' | '))
    .toBe('Signed in | epm-cdme | claude-sonnet-4-6 | epm-cdme');
});
