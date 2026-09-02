import { test } from '@playwright/test';
import fs from 'node:fs';

// Geometry dump for the identity bar at HEAD 84b1f77 — writes the raw measured
// numbers that back the assertions in identity-bar-recheck.spec.ts, so the
// evidence file can quote real values rather than restating the assertions.

const RESPONSES: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false },
  get_steps: [],
  get_logo_path: '',
  check_profile_status: { authenticated: true, detail: '' },
  get_platform_info: { arch: 'aarch64', platform: 'macos' },
  temp_dir: '/tmp',
  check_codemie_version: '0.13.0',
  fetch_codemie_latest: '0.14.2',
};

test.use({ viewport: { width: 1280, height: 800 } });

test('dump identity bar geometry', async ({ page }) => {
  await page.addInitScript(({ r }) => {
    (window as any).__TAURI__ = {
      core: { invoke: async (cmd: string) => (cmd in r ? (r as any)[cmd] : null) },
      event: { listen: async () => () => {} },
    };
  }, { r: RESPONSES });

  await page.goto('/index.html');
  await page.waitForFunction(() => document.getElementById('sidebar-home') !== null);
  await page.waitForTimeout(300);

  const data = await page.evaluate(() => {
    const r = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: +b.left.toFixed(1), right: +b.right.toFixed(1), top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), width: +b.width.toFixed(1) };
    };
    const before = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el, '::before').content : null;
    };
    const badge = document.getElementById('identity-version-badge')!;
    const toggle = document.getElementById('theme-toggle')!;
    const bar = document.getElementById('identity-bar')!;
    const tr = toggle.getBoundingClientRect();
    const br = badge.getBoundingClientRect();
    const ix = Math.max(0, Math.min(tr.right, br.right) - Math.max(tr.left, br.left));
    const iy = Math.max(0, Math.min(tr.bottom, br.bottom) - Math.max(tr.top, br.top));

    return {
      rects: {
        bar: r('#identity-bar'),
        auth: r('#identity-auth-status'),
        profile: r('#identity-profile'),
        model: r('#identity-model'),
        project: r('#identity-project'),
        badge: r('#identity-version-badge'),
        toggle: r('#theme-toggle'),
      },
      pseudo_before: {
        auth: before('#identity-auth-status'),
        profile: before('#identity-profile'),
        model: before('#identity-model'),
        project: before('#identity-project'),
        badge: before('#identity-version-badge'),
      },
      badge_text: badge.textContent,
      badge_scrollWidth: badge.scrollWidth,
      badge_clientWidth: badge.clientWidth,
      toggle_position: getComputedStyle(toggle).position,
      toggle_parent_id: toggle.parentElement?.id ?? null,
      toggle_is_child_of_bar: toggle.parentElement === bar,
      toggle_badge_intersection_area: +(ix * iy).toFixed(2),
      bar_padding_right: getComputedStyle(bar).paddingRight,
      toggle_gap_to_bar_right_edge: +(bar.getBoundingClientRect().right - tr.right).toFixed(1),
    };
  });

  fs.writeFileSync('identity-geometry.json', JSON.stringify(data, null, 2));
});
