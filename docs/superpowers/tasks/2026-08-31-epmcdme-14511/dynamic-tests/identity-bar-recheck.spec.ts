import { test, expect, Page } from '@playwright/test';

// TARGETED RE-VERIFICATION of the identity bar for EPMCDME-14511 at HEAD 84b1f77.
//
// Round 2 (f4994c5) failed this area on two defects:
//   (1) the version badge carried a leading middot, because
//       `#identity-bar > span + span::before` (1,0,3) outranked the
//       `#identity-version-badge::before { content: none }` override; and
//   (2) `#theme-toggle` was `position: fixed` and floated over the badge,
//       clipping the word "available".
//
// Both are claimed fixed: the override is now `#identity-bar >
// #identity-version-badge::before` (2,0,1) and the toggle has MOVED IN THE
// MARKUP to be the last child of #identity-bar with `flex: 0 0 auto`.
//
// Every assertion below is on COMPUTED GEOMETRY (getBoundingClientRect) or
// computed style / pseudo-element content — never element presence.

const BASE_INVOKES: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false },
  get_steps: [],
  get_logo_path: '',
  check_profile_status: { authenticated: true, detail: '' },
  read_codemie_config: {
    state: 'valid', profile: 'default', model: 'Sonnet 5', project: 'EPM-CDME',
    account: 'n_levyankov@epam.com',
  },
  get_platform_info: { arch: 'aarch64', platform: 'macos' },
  temp_dir: '/tmp',
};

// Badge POPULATED: installed < latest, so renderer sets "<latest> available".
const UPDATE_AVAILABLE = {
  ...BASE_INVOKES,
  check_codemie_version: '0.13.0',
  fetch_codemie_latest: '0.14.2',
};

// Badge EMPTY: installed == latest, so the renderer never writes text.
const UP_TO_DATE = {
  ...BASE_INVOKES,
  check_codemie_version: '1.0.0',
  fetch_codemie_latest: '1.0.0',
};

const consoleErrors: string[] = [];

async function boot(page: Page, responses: Record<string, unknown>) {
  await page.addInitScript(({ r }) => {
    (window as any).__TAURI__ = {
      core: { invoke: async (cmd: string) => (cmd in r ? (r as any)[cmd] : null) },
      event: { listen: async () => () => {} },
    };
  }, { r: responses });

  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto('/index.html');
  await page.waitForFunction(() => document.getElementById('sidebar-home') !== null);
  await page.waitForTimeout(300);
}

/** Everything the assertions need, measured in one page evaluation. */
async function probe(page: Page) {
  return page.evaluate(() => {
    const r = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, right: b.right, bottom: b.bottom, left: b.left };
    };
    const before = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el, '::before').content : null;
    };
    const badge = document.getElementById('identity-version-badge')!;
    const toggle = document.getElementById('theme-toggle')!;
    const bar = document.getElementById('identity-bar')!;
    const barCS = getComputedStyle(bar);

    return {
      bar: r('#identity-bar'),
      barPaddingRight: parseFloat(barCS.paddingRight),
      auth: r('#identity-auth-status'),
      profile: r('#identity-profile'),
      model: r('#identity-model'),
      project: r('#identity-project'),
      badge: r('#identity-version-badge'),
      toggle: r('#theme-toggle'),

      // Pseudo-element content for the four text spans and the badge.
      beforeAuth: before('#identity-auth-status'),
      beforeProfile: before('#identity-profile'),
      beforeModel: before('#identity-model'),
      beforeProject: before('#identity-project'),
      beforeBadge: before('#identity-version-badge'),

      badgeText: badge.textContent,
      badgeDisplay: getComputedStyle(badge).display,
      badgeScrollWidth: badge.scrollWidth,
      badgeClientWidth: badge.clientWidth,

      togglePosition: getComputedStyle(toggle).position,
      toggleParentId: toggle.parentElement ? toggle.parentElement.id : null,
      toggleIsChildOfBar: toggle.parentElement === bar,

      htmlClass: document.documentElement.className,
    };
  });
}

/** Area of the rectangle intersection; 0 when they do not overlap. */
function intersectionArea(a: any, b: any) {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}

test.use({ viewport: { width: 1280, height: 800 } });

// ------------------------------------------------------------------ BADGE POPULATED
test('identity bar with a populated badge: one row, middots between the four fields only, toggle inside the bar and not overlapping the badge', async ({ page }) => {
  await boot(page, UPDATE_AVAILABLE);
  const p = await probe(page);

  // Sanity: the badge really is populated for this case.
  expect(p.badgeText).toBe('0.14.2 available');
  expect(p.badgeDisplay).not.toBe('none');

  // --- 1. ONE ROW, left-to-right, with middots BETWEEN the four text spans ---
  const fields = [p.auth!, p.profile!, p.model!, p.project!];
  const centres = fields.map((f) => f.top + f.h / 2);
  for (const c of centres) expect(Math.abs(c - centres[0])).toBeLessThanOrEqual(3);
  expect(p.auth!.left).toBeLessThan(p.profile!.left);
  expect(p.profile!.left).toBeLessThan(p.model!.left);
  expect(p.model!.left).toBeLessThan(p.project!.left);

  // The first span has no separator; the following three each carry one.
  // (Regression guard: the specificity fix must NOT have stripped these.)
  expect(p.beforeAuth).toBe('none');
  expect(p.beforeProfile).toBe('"·"');
  expect(p.beforeModel).toBe('"·"');
  expect(p.beforeProject).toBe('"·"');

  // --- 2. The badge carries NO leading middot ---
  expect(p.beforeBadge).toBe('none');

  // --- 3. The toggle is INSIDE the bar, by DOM parentage AND by geometry ---
  expect(p.toggleIsChildOfBar).toBe(true);
  expect(p.toggleParentId).toBe('identity-bar');
  expect(p.togglePosition).not.toBe('fixed');
  expect(p.toggle!.left).toBeGreaterThanOrEqual(p.bar!.left - 0.5);
  expect(p.toggle!.right).toBeLessThanOrEqual(p.bar!.right + 0.5);
  expect(p.toggle!.top).toBeGreaterThanOrEqual(p.bar!.top - 0.5);
  expect(p.toggle!.bottom).toBeLessThanOrEqual(p.bar!.bottom + 0.5);

  // --- 4. ZERO intersection area between the toggle and the badge ---
  expect(intersectionArea(p.toggle!, p.badge!)).toBe(0);

  // --- 5. Badge text is not clipped; badge sits LEFT of the toggle ---
  expect(p.badgeScrollWidth).toBeLessThanOrEqual(p.badgeClientWidth);
  expect(p.badge!.right).toBeLessThanOrEqual(p.toggle!.left);

  // --- 6. Full left-to-right order: account · profile · model · project … badge, toggle ---
  const order = [p.auth!, p.profile!, p.model!, p.project!, p.badge!, p.toggle!];
  for (let i = 1; i < order.length; i++) {
    expect(order[i].left).toBeGreaterThan(order[i - 1].left);
  }
  // Badge and toggle are both right-aligned: a wide gap separates the static
  // fields from the badge, and the toggle hugs the bar's right padding edge.
  expect(p.badge!.left - p.project!.right).toBeGreaterThan(100);
  expect(p.bar!.right - p.toggle!.right).toBeLessThanOrEqual(p.barPaddingRight + 1);

  await page.locator('#identity-bar').screenshot({
    path: 'identity-bar-recheck.png',
  });
});

// ------------------------------------------------------------------ BADGE EMPTY
test('identity bar with an EMPTY badge: badge is not visible and the toggle stays right-aligned', async ({ page }) => {
  await boot(page, UP_TO_DATE);
  const p = await probe(page);

  // Badge is empty and hidden via :empty.
  expect(p.badgeText).toBe('');
  expect(p.badgeDisplay).toBe('none');
  expect(p.badge!.w).toBe(0);

  // The toggle still right-aligns (its `margin-left: auto` takes over).
  expect(p.toggleIsChildOfBar).toBe(true);
  expect(p.togglePosition).not.toBe('fixed');
  expect(p.bar!.right - p.toggle!.right).toBeLessThanOrEqual(p.barPaddingRight + 1);
  // And it is still clearly to the right of the last text field.
  expect(p.toggle!.left - p.project!.right).toBeGreaterThan(100);
});

// ------------------------------------------------------------------ TOGGLE STILL WORKS
test('theme toggle still flips the <html> theme class after being re-homed into the identity bar', async ({ page }) => {
  await boot(page, UPDATE_AVAILABLE);

  const before = await page.evaluate(() => document.documentElement.className);
  expect(['dark', 'light']).toContain(before);

  // Click the visible track (the real <input> is visually hidden by .switch-wrapper).
  await page.locator('#theme-toggle .switch-track').click();
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.documentElement.className);
  expect(after).not.toBe(before);
  expect(['dark', 'light']).toContain(after);

  // And back again — proves it is a real toggle, not a one-way set.
  await page.locator('#theme-toggle .switch-track').click();
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => document.documentElement.className)).toBe(before);
});

test.afterAll(() => {
  if (consoleErrors.length) {
    throw new Error(`console errors during identity-bar re-verification:\n${consoleErrors.join('\n')}`);
  }
});
