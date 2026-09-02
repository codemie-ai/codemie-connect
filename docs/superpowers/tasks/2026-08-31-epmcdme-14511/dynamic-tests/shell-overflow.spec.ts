import { test, expect, Page } from '@playwright/test';

// The shell adds a 180px sidebar, so the old 900x600 window left the content
// column too narrow: #home-grid (flex: 1) was squeezed, its tiles overflowed the
// grid track, and they ran under #home-footer. The window is sized for the shell
// instead. Measured with the update banner shown — it costs the content column
// ~43px of height, which is the worst case.
// Shipped size, and 20px below it — the overlap first appears at 640 high,
// so this pins the margin rather than just the happy value.
const VIEWPORTS: [number, number][] = [[1000, 660], [1000, 645], [960, 660]];

async function boot(page: Page) {
  await page.addInitScript(() => {
    const r: Record<string, unknown> = {
      smoke_mode: { probe: false, smoke: false, dev: true },
      get_steps: [], get_logo_path: '',
      check_profile_status: { authenticated: false, detail: '' },
      get_platform_info: { arch: 'aarch64', platform: 'macos' }, temp_dir: '/tmp',
      check_codemie_version: '0.14.1', fetch_codemie_latest: '0.14.2',
      read_codemie_config: {
        state: 'valid', profile: 'MertPersonal', model: 'sonnet',
        project: 'epm-sdai', account: 'mert_efe@epam.com',
      },
    };
    (window as any).__TAURI__ = {
      core: { invoke: async (c: string) => (c in r ? r[c] : null) },
      event: { listen: async () => () => {} },
    };
  });
  await page.goto('/index.html');
  await page.waitForTimeout(300);
}

// Any pair of boxes that visually intersect but are siblings in flow.
const overlapProbe = () => {
  const foot = document.getElementById('home-footer')!;
  const f = foot.getBoundingClientRect();
  return [...document.querySelectorAll('#home-grid .home-tile')]
    .filter((t) => {
      const r = t.getBoundingClientRect();
      return f.top < r.bottom && f.bottom > r.top && f.left < r.right && f.right > r.left;
    })
    .map((t) => t.querySelector('.tile-title')?.textContent?.trim());
};

for (const [width, height] of VIEWPORTS) {
  test(`the footer never runs under a home tile at ${width}x${height}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    await boot(page);
    expect(await page.evaluate(overlapProbe)).toEqual([]);
    await ctx.close();
  });
}
