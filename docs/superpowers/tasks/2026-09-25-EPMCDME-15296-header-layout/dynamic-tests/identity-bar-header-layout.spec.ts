import { test, expect, Page } from '@playwright/test';

// Verification for EPMCDME-15296: the identity bar must stay on one line at
// both a narrow and a default window width, its text segments must truncate
// with an ellipsis instead of wrapping, the version badge and theme toggle
// must stay full-size and pinned right, auth-status text must be the cleaned
// string (not the raw CLI row), and auth-status/product must give up space
// more slowly (flex-shrink: 1) than the other segments (flex-shrink: 3) when
// narrowing.

const BASE_INVOKES: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false },
  get_steps: [],
  get_logo_path: '',
  check_profile_status: {
    state: 'signed_in',
    // The raw CLI row EPMCDME-15296 must not surface verbatim.
    detail: 'Auth Status │ ✓ Authenticated (expires in 23h 51m)',
  },
  read_codemie_config: {
    state: 'valid',
    profile: 'default',
    model: 'Sonnet 5',
    project: 'EPM-CDME',
    account: 'n_levyankov@epam.com',
  },
  get_platform_info: { arch: 'aarch64', platform: 'macos' },
  temp_dir: '/tmp',
  check_codemie_version: '0.13.0',
  fetch_codemie_latest: '0.14.2',
};

const consoleErrors: string[] = [];

async function boot(page: Page) {
  await page.addInitScript(({ r }) => {
    (window as any).__TAURI__ = {
      core: { invoke: async (cmd: string) => (cmd in r ? (r as any)[cmd] : null) },
      event: { listen: async () => () => {} },
    };
  }, { r: BASE_INVOKES });

  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto('/index.html');
  await page.waitForFunction(() => document.getElementById('sidebar-home') !== null);
  await page.waitForTimeout(300);
}

async function probe(page: Page) {
  return page.evaluate(() => {
    const r = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, right: b.right, bottom: b.bottom, left: b.left };
    };
    const cs = (sel: string, prop: string) => {
      const el = document.querySelector(sel);
      return el ? (getComputedStyle(el) as any)[prop] : null;
    };
    const overflowGap = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? el.scrollWidth - el.clientWidth : null;
    };

    return {
      bar: r('#identity-bar'),
      auth: r('#identity-auth-status'),
      product: r('#identity-product'),
      account: r('#identity-account'),
      profile: r('#identity-profile'),
      model: r('#identity-model'),
      project: r('#identity-project'),
      badge: r('#identity-version-badge'),
      toggle: r('#theme-toggle'),

      authText: document.getElementById('identity-auth-status')?.textContent,
      badgeText: document.getElementById('identity-version-badge')?.textContent,

      whiteSpaceAuth: cs('#identity-auth-status', 'whiteSpace'),
      whiteSpaceAccount: cs('#identity-account', 'whiteSpace'),
      textOverflowAccount: cs('#identity-account', 'textOverflow'),
      flexShrinkAuth: cs('#identity-auth-status', 'flexShrink'),
      flexShrinkProduct: cs('#identity-product', 'flexShrink'),
      flexShrinkAccount: cs('#identity-account', 'flexShrink'),
      flexShrinkProfile: cs('#identity-profile', 'flexShrink'),
      flexShrinkModel: cs('#identity-model', 'flexShrink'),
      flexShrinkProject: cs('#identity-project', 'flexShrink'),
      flexWrapBar: cs('#identity-bar', 'flexWrap'),

      overflowGapAccount: overflowGap('#identity-account'),
      overflowGapProfile: overflowGap('#identity-profile'),
      badgeScrollWidth: (document.getElementById('identity-version-badge') as HTMLElement)?.scrollWidth,
      badgeClientWidth: (document.getElementById('identity-version-badge') as HTMLElement)?.clientWidth,
      toggleWidth: r('#theme-toggle')?.w,
    };
  });
}

// ------------------------------------------------------------------ DEFAULT WIDTH
test.describe('identity bar header layout — default width (1280px)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('one line, cleaned auth-status text, badge/toggle full-size and pinned right', async ({ page }) => {
    await boot(page);
    const p = await probe(page);

    // Cleaned auth-status text, not the raw CLI row.
    expect(p.authText).toBe('Authenticated (expires in 23h 51m)');
    expect(p.authText).not.toContain('Auth Status');
    expect(p.authText).not.toContain('│');
    expect(p.authText).not.toContain('✓');

    // Single line: all visible segments share the same vertical centre.
    const fields = [p.auth!, p.account!, p.profile!, p.model!, p.project!];
    const centres = fields.map((f) => f.top + f.h / 2);
    for (const c of centres) expect(Math.abs(c - centres[0])).toBeLessThanOrEqual(3);
    expect(p.flexWrapBar).toBe('nowrap');

    // Badge fully populated and not clipped.
    expect(p.badgeText).toBe('0.14.2 available');
    expect(p.badgeScrollWidth).toBeLessThanOrEqual(p.badgeClientWidth!);

    // Badge and toggle pinned right, right of the text fields.
    expect(p.badge!.left).toBeGreaterThan(p.project!.right);
    expect(p.toggle!.left).toBeGreaterThan(p.badge!.right - 1);
    expect(p.bar!.right - p.toggle!.right).toBeGreaterThanOrEqual(0);

    await page.locator('#identity-bar').screenshot({
      path: '../evidence/screenshots/identity-bar-default-width.png',
    });
  });
});

// ------------------------------------------------------------------ NARROW WIDTH
test.describe('identity bar header layout — narrow width (520px)', () => {
  test.use({ viewport: { width: 520, height: 800 } });

  test('still one line, text segments truncate with ellipsis, badge/toggle stay full-size', async ({ page }) => {
    await boot(page);
    const p = await probe(page);

    await page.locator('#identity-bar').screenshot({
      path: '../evidence/screenshots/identity-bar-narrow-width.png',
    });

    // Still a single line — no wrap.
    const fields = [p.auth!, p.account!, p.profile!, p.model!, p.project!];
    const centres = fields.map((f) => f.top + f.h / 2);
    for (const c of centres) expect(Math.abs(c - centres[0])).toBeLessThanOrEqual(3);
    expect(p.bar!.h).toBeLessThanOrEqual(40); // one row of text, not a stacked/wrapped block

    // Truncation CSS is applied to the shrinking text segments.
    expect(p.whiteSpaceAuth).toBe('nowrap');
    expect(p.whiteSpaceAccount).toBe('nowrap');
    expect(p.textOverflowAccount).toBe('ellipsis');

    // Badge and toggle are excluded from truncation and stay full-size / unclipped.
    expect(p.badgeText).toBe('0.14.2 available');
    expect(p.badgeScrollWidth).toBeLessThanOrEqual(p.badgeClientWidth!);
    expect(p.toggleWidth).toBeGreaterThan(20);

    // Badge and toggle remain right of the text segments and inside the bar.
    expect(p.badge!.right).toBeLessThanOrEqual(p.bar!.right + 1);
    expect(p.toggle!.right).toBeLessThanOrEqual(p.bar!.right + 1);
  });

  test('flex-shrink priority: auth-status/product shrink slower (1) than the other segments (3)', async ({ page }) => {
    await boot(page);
    const p = await probe(page);

    expect(p.flexShrinkAuth).toBe('1');
    expect(p.flexShrinkProduct).toBe('1');
    expect(p.flexShrinkAccount).toBe('3');
    expect(p.flexShrinkProfile).toBe('3');
    expect(p.flexShrinkModel).toBe('3');
    expect(p.flexShrinkProject).toBe('3');
  });
});

test.afterAll(() => {
  if (consoleErrors.length) {
    throw new Error(`console errors during identity-bar header-layout verification:\n${consoleErrors.join('\n')}`);
  }
});
