import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

// Verifies the renderer.js changes for EPMCDME-14505:
//   1. INSTALL_ONLY_IDS now contains ['2.3.3','2.3.5','2.4'] — the current step set.
//      Clicking the install-only tile must open the wizard with those 3 steps, not an
//      empty wizard (which the old deleted IDs would have produced).
//   2. runProbe has a zero-step guard: when the probe filter matches no steps,
//      smoke_emit must be called with PROBE_ERR and then PROBE_DONE.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.join(__dirname, '..', 'evidence', 'screenshots');

// Steps matching the current config/steps.yaml
const CURRENT_STEPS = [
  { id: '2.3.3', title: 'Configure CodeMie', description: 'Run the interactive CodeMie setup wizard.', status: 'PENDING' },
  { id: '2.3.5', title: 'Install Claude Code engine', description: 'Install the Claude Code engine through CodeMie.', status: 'PENDING' },
  { id: '2.4',   title: 'Validate installation',     description: 'Run codemie doctor to validate the installation.', status: 'PENDING' },
];

// Steps that existed before the bundled runtime (now deleted); simulate a stale binary
// where get_steps would return old IDs that no longer match INSTALL_ONLY_IDS or runProbe.
const STALE_STEPS = [
  { id: '1.1',   title: 'Install Git',  description: 'Old step — removed.', status: 'PENDING' },
  { id: '1.3',   title: 'Install Node', description: 'Old step — removed.', status: 'PENDING' },
];

const BASE_INVOKE = {
  get_logo_path: '',
  check_profile_status: { authenticated: true, detail: '' },
  get_platform_info: { arch: 'x86_64', platform: 'windows' },
  temp_dir: 'C:\\Temp',
  check_codemie_version: '1.0.0',
  fetch_codemie_latest: '1.0.0',
  read_codemie_config: { state: 'valid', profile: 'default', model: 'sonnet', project: 'epm-cdme', account: 'a@b.com' },
  log_line: null,
  smoke_mode: { probe: false, smoke: false, dev: false },
};

const errors: string[] = [];

async function bootWithSteps(page: Page, steps: typeof CURRENT_STEPS, overrides: Record<string, unknown> = {}) {
  await page.addInitScript(({ base, steps, overrides }) => {
    const r = { ...(base as any), get_steps: steps, ...overrides };
    const emitted: string[] = [];
    (window as any).__smokeEmitted = emitted;
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          if (cmd === 'smoke_emit') { emitted.push((args as any).line || ''); return null; }
          if (cmd === 'close_app') return null;
          return cmd in r ? (r as any)[cmd] : null;
        },
      },
      event: { listen: async () => () => {} },
    };
  }, { base: BASE_INVOKE, steps, overrides });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto('/index.html');
  // Wait for the home grid (normal boot) or wizard (probe boot)
  await page.waitForFunction(() =>
    document.getElementById('home-view') !== null ||
    document.getElementById('wizard-view') !== null,
    { timeout: 10000 }
  );
}

test.beforeEach(() => { errors.length = 0; });
test.afterEach(async ({ page }, testInfo) => {
  expect(errors, 'no console or page errors during test').toEqual([]);
  // Always capture a screenshot as evidence
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
  await page.screenshot({ path: path.join(screenshotsDir, `${slug}.png`), fullPage: false });
});

// ---- Test 1: INSTALL_ONLY_IDS points at current step IDs ----
// When the user clicks "Install only", the wizard must open and show the 3
// current steps. Before this fix it would have shown 0 steps (empty wizard)
// because it referenced IDs that were removed with the bundled runtime.
test('install-only tile enters wizard with the three current steps', async ({ page }) => {
  await bootWithSteps(page, CURRENT_STEPS);

  // Home view should be visible after normal boot
  await expect(page.locator('#home-view')).toBeVisible({ timeout: 8000 });

  // Simulate clicking the install-only tile (data-action="install-only")
  const installOnlyTile = page.locator('[data-action="install-only"]');
  await expect(installOnlyTile).toBeVisible({ timeout: 5000 });
  await installOnlyTile.click();

  // Wizard view must become visible
  await expect(page.locator('#wizard-view')).toBeVisible({ timeout: 5000 });

  // Mode label must read "Install only"
  await expect(page.locator('#wizard-mode-label')).toHaveText('Install only', { timeout: 3000 });

  // All three current steps must be rendered as step-rows
  const stepRows = page.locator('.step-row');
  await expect(stepRows).toHaveCount(3, { timeout: 3000 });

  // Each current step ID must appear in the DOM
  for (const step of CURRENT_STEPS) {
    await expect(page.locator(`[data-id="${step.id}"]`)).toBeVisible({ timeout: 3000 });
  }
});

// ---- Test 2: INSTALL_ONLY_IDS does NOT include stale/deleted step IDs ----
// If the app somehow had stale steps returned from get_steps, the wizard
// should show 0 rows (nothing matches INSTALL_ONLY_IDS = ['2.3.3','2.3.5','2.4']).
// This confirms the IDs are deliberately scoped to current steps only.
test('install-only with stale steps renders an empty wizard — confirms IDs are tightly scoped', async ({ page }) => {
  await bootWithSteps(page, STALE_STEPS);

  await expect(page.locator('#home-view')).toBeVisible({ timeout: 8000 });
  const installOnlyTile = page.locator('[data-action="install-only"]');
  await expect(installOnlyTile).toBeVisible({ timeout: 5000 });
  await installOnlyTile.click();

  await expect(page.locator('#wizard-view')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#wizard-mode-label')).toHaveText('Install only', { timeout: 3000 });

  // Zero rows: stale IDs (1.1, 1.3) are not in INSTALL_ONLY_IDS
  await expect(page.locator('.step-row')).toHaveCount(0, { timeout: 3000 });
});

// ---- Test 3: runProbe zero-step guard ----
// When probe mode is active and get_steps returns steps whose IDs do NOT
// appear in the safe set (['2.3.3','2.3.5','2.4']), runProbe must:
//   a) emit PROBE_ERR with "no steps matched the probe filter"
//   b) emit PROBE_DONE
// Before this guard was added, the engine.run() call would proceed on an
// empty step list and the result would be silent/misleading.
test('runProbe zero-step guard emits PROBE_ERR when no steps match the safe set', async ({ page }) => {
  await bootWithSteps(page, STALE_STEPS, {
    smoke_mode: { probe: true, smoke: false, dev: false },
    get_steps: STALE_STEPS,
  });

  // In probe mode, boot() calls runProbe() and returns; wizard-view is shown
  await expect(page.locator('#wizard-view')).toBeVisible({ timeout: 10000 });

  // Wait for runProbe to finish (it calls close_app which is a no-op in tests)
  await page.waitForFunction(
    () => {
      const emitted = (window as any).__smokeEmitted as string[];
      return emitted && emitted.some((l: string) => l === 'PROBE_DONE');
    },
    { timeout: 10000 }
  );

  const emitted: string[] = await page.evaluate(() => (window as any).__smokeEmitted);
  const errLine = emitted.find((l) => l.startsWith('PROBE_ERR'));
  expect(errLine, 'PROBE_ERR was emitted when no steps matched').toBeTruthy();
  expect(errLine).toContain('no steps matched the probe filter');
  expect(emitted).toContain('PROBE_DONE');
});

// ---- Test 4: runProbe normal path with matching steps ----
// When probe mode is active and get_steps returns the current steps, runProbe
// must NOT emit the zero-step guard PROBE_ERR. Engine.run() may block waiting
// for interactive handlers in this mock environment, so we assert the guard
// did not fire within a short observation window rather than waiting for PROBE_DONE.
test('runProbe does not fire the zero-step guard when steps match the safe set', async ({ page }) => {
  await bootWithSteps(page, CURRENT_STEPS, {
    smoke_mode: { probe: true, smoke: false, dev: false },
    get_steps: CURRENT_STEPS,
  });

  // In probe mode, boot() calls runProbe() and shows wizard-view
  await expect(page.locator('#wizard-view')).toBeVisible({ timeout: 10000 });

  // The wizard should contain exactly 3 step rows (probe filter did not wipe them)
  await expect(page.locator('.step-row')).toHaveCount(3, { timeout: 5000 });

  // Give the guard 2 s to fire if it was going to (it fires synchronously before engine.run())
  await page.waitForTimeout(2000);

  const emitted: string[] = await page.evaluate(() => (window as any).__smokeEmitted);
  const guardErrorLine = emitted.find(
    (l) => l.startsWith('PROBE_ERR') && l.includes('no steps matched the probe filter')
  );

  // The zero-step guard must NOT have fired — CURRENT_STEPS all match the safe set
  expect(guardErrorLine, 'zero-step guard must not fire for current step IDs').toBeUndefined();
});
