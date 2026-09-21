import { test, expect } from '@playwright/test';

// The sidebar offers Home, Agents, Connections and Health, and nothing else.
// Two entries are present in the DOM but hidden rather than deleted, so whoever
// owns them restores each by removing one class:
//   - CLI usage analytics — EPMCDME-14350 lists it under Out of Scope.
//   - About — no sub-task owns its content, so it would open a blank view.

test('the sidebar offers exactly the four reachable entries', async ({ page }) => {
  await page.addInitScript(() => {
    const r: Record<string, unknown> = {
      smoke_mode: { probe: false, smoke: false, dev: false },
      get_steps: [], get_logo_path: '',
      check_profile_status: { authenticated: true, detail: '' },
      get_platform_info: { arch: 'aarch64', platform: 'macos' }, temp_dir: '/tmp',
      check_codemie_version: '1.0.0', fetch_codemie_latest: '1.0.0',
      read_codemie_config: { state: 'valid', profile: 'p', model: 'm', project: 'j', account: null },
    };
    (window as any).__TAURI__ = {
      core: { invoke: async (c: string) => (c in r ? r[c] : null) },
      event: { listen: async () => () => {} },
    };
  });
  await page.goto('/index.html');

  const visible = await page.$$eval('#app-sidebar .sidebar-item', (els) =>
    els.filter((e) => getComputedStyle(e).display !== 'none')
       .map((e) => (e as HTMLElement).innerText.trim()));
  expect(visible).toEqual(['Home', 'Agents', 'Connections', 'Health']);

  // Both suppressed entries are present in the DOM, just unreachable — and so is
  // the divider, whose only job was separating the main group from About.
  for (const id of ['#sidebar-analytics', '#sidebar-about', '#sidebar-divider']) {
    await expect(page.locator(id), id).toHaveCount(1);
    await expect(page.locator(id), id).toBeHidden();
  }

  // about-view still exists and still routes, so restoring the entry is a
  // one-class change rather than a rebuild.
  await expect(page.locator('#about-view')).toHaveCount(1);
  expect(await page.evaluate(() =>
    document.getElementById('sidebar-about')!.dataset.view)).toBe('about');
});
