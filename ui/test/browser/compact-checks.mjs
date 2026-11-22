// Browser checks of the compact view (spec docs/superpowers/specs/2026-11-22-compact-view-design.md),
// run by workspace-e2e.mjs with its MOCKED native bridge. C0 proves the Default view keeps its
// sizes: every element under #workspace-app on ten Default screens, with a fixed clock, is dumped
// as its computed text and box sizes and hashed per screen against ui/test/fixtures/default-sizes.json.
//
//   WORKSPACE_E2E_SIZES=write                       rewrites every screen's baseline
//   WORKSPACE_E2E_SIZES=write:today,settings-layout rewrites the named screens only
//
// Each run writes the full dumps to OUT/sizes-<screen>.json; a write also keeps them as
// OUT/sizes-<screen>.baseline.json, which a later mismatch is compared against.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXED_NOW = Date.parse('2026-11-18T09:30:00+02:00');

const BASELINE = fileURLToPath(new URL('../fixtures/default-sizes.json', import.meta.url));
const SCREENS = {
  today: '#/today',
  inbox: '#/inbox',
  calendar: '#/calendar',
  meetings: '#/meetings',
  tasks: '#/tasks',
  automations: '#/automations',
  analytics: '#/analytics',
  'settings-general': '#/settings/general',
  'settings-appearance': '#/settings/appearance',
  'settings-layout': '#/settings/layout',
};

/** Every element under #workspace-app in document order, skipping iframe subtrees and the
 *  toasts: [tag, className, fontSize, lineHeight, width, height, padding, margin, gap, borderRadius]. */
export const sizesOf = page => page.evaluate(() => {
  const root = document.getElementById('workspace-app');
  const out = [];
  const round = v => Math.round(v * 100) / 100;
  const walk = parent => {
    for (const el of parent.children) {
      if (el.tagName === 'IFRAME' || el.classList.contains('ws-toasts')) continue;
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      out.push([el.tagName.toLowerCase(), typeof el.className === 'string' ? el.className : el.getAttribute('class') || '', cs.fontSize, cs.lineHeight, round(box.width), round(box.height), cs.padding, cs.margin, cs.gap, cs.borderRadius]);
      walk(el);
    }
  };
  if (root) walk(root);
  return out;
});

const sha256 = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

/** Which screens this run rewrites: none, all, or the names after `write:`. */
function screensToWrite() {
  const mode = process.env.WORKSPACE_E2E_SIZES || '';
  if (mode === 'write') return new Set(Object.keys(SCREENS));
  if (mode.startsWith('write:')) return new Set(mode.slice(6).split(',').map(s => s.trim()).filter(Boolean));
  return new Set();
}

/** The window's `data-view` on `#workspace-app` and on `<html>`. */
const viewAttrs = page => page.evaluate(() => ({ root: document.getElementById('workspace-app').dataset.view, html: document.documentElement.dataset.view }));

/** The view `#workspace-app`'s `data-view` held the moment it first got a child element — the
 *  loading spinner `boot()` draws before the native snapshot arrives — recorded by a watcher
 *  `installBridge` (workspace-e2e.mjs) always arms before the page's own scripts run, on every
 *  navigation of the page including a reload. Reads whatever it last recorded. */
const firstChildView = page => page.evaluate(() => window.__firstChildView);

const APPEARANCE = '#/settings/appearance';

/** C1: Settings › Appearance → View. Compact applies at once (attributes, mirror, no reload) and
 *  is recorded; it survives a reload. `page` is already on the Appearance screen. */
async function c1(theme, page, { assert, shot, settled, calls }) {
  await page.click('[data-action="view-set"][data-view="compact"]');
  await settled(page);
  const recorded = await calls(page, 'settings_update');
  assert(recorded.some(d => d.view === 'compact'), `no settings_update {view: compact} recorded: ${JSON.stringify(recorded)}`);
  const attrs = await viewAttrs(page);
  assert(attrs.root === 'compact', `#workspace-app data-view: ${attrs.root}`);
  assert(attrs.html === 'compact', `html data-view: ${attrs.html}`);
  const mirror = await page.evaluate(() => localStorage.getItem('codemie.view'));
  assert(mirror === 'compact', `localStorage mirror: ${mirror}`);
  await shot(page, `compact-c1-appearance-${theme}`);

  // Reload: the native setting now agrees with the mirror, so the first paint is already Compact.
  await page.reload();
  await page.waitForSelector('.ws-sidebar');
  await settled(page);
  const first = await firstChildView(page);
  assert(first === 'compact', `#workspace-app's data-view at its first child, after reload: ${first}`);
}

/** A mirror that disagrees with the native default: the first paint follows the mirror, the
 *  snapshot then corrects both the attributes and the mirror back to native's `'default'`. `page`
 *  is already open with that mirror value and the (default) native settings. */
async function c1Mismatch(page, assert, mirrorValue, wantFirst) {
  const first = await firstChildView(page);
  assert(first === wantFirst, `#workspace-app's data-view at its first child (mirror '${mirrorValue}'): ${first}`);
  const attrs = await viewAttrs(page);
  assert(attrs.root === 'default' && attrs.html === 'default', `data-view after the snapshot loaded: ${JSON.stringify(attrs)}`);
  const mirror = await page.evaluate(() => localStorage.getItem('codemie.view'));
  assert(mirror === 'default', `localStorage mirror after the snapshot loaded: ${mirror}`);
}

export async function compactChecks({ open, check, assert, shot, settled, calls, OUT }) {
  const write = screensToWrite();
  let baseline = {};
  try { baseline = await readJson(BASELINE); } catch { /* first write */ }

  const openScreen = hash => open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, meetings: true, automations: true, hash });
  // The first screen opens before `check`, which looks for open dialogs on the current page.
  let first = await openScreen(SCREENS.today);
  await check('compact C0: Default sizes match the baseline on every screen', async () => {
    const problems = [];
    for (const [screen, hash] of Object.entries(SCREENS)) {
      const { page, context } = first || await openScreen(hash);
      first = null;
      try {
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => document.querySelectorAll('.ws-toast').forEach(t => t.remove()));
        await settled(page);
        // Spinners turn forever, so their rotated boxes differ from run to run: every endless
        // animation is held at its start and any finite one jumped to its end before measuring.
        await page.evaluate(() => document.getAnimations().forEach(a => {
          if (a.effect?.getComputedTiming().iterations === Infinity) { a.pause(); a.currentTime = 0; } else a.finish();
        }));
        const rows = await sizesOf(page);
        const entry = { count: rows.length, sha256: sha256(rows) };
        await writeFile(join(OUT, `sizes-${screen}.json`), JSON.stringify(rows, null, 1));
        if (write.has(screen)) {
          baseline[screen] = entry;
          await writeFile(join(OUT, `sizes-${screen}.baseline.json`), JSON.stringify(rows, null, 1));
          continue;
        }
        const want = baseline[screen];
        if (!want) { problems.push(`${screen}: no baseline (run with WORKSPACE_E2E_SIZES=write:${screen})`); continue; }
        if (want.count === entry.count && want.sha256 === entry.sha256) continue;
        let detail = `count ${entry.count} vs ${want.count}`;
        try {
          const old = await readJson(join(OUT, `sizes-${screen}.baseline.json`));
          const i = rows.findIndex((row, n) => JSON.stringify(row) !== JSON.stringify(old[n]));
          const at = i === -1 ? Math.min(rows.length, old.length) : i;
          detail += `, first difference at ${at}: ${JSON.stringify(rows[at])} vs ${JSON.stringify(old[at])}`;
        } catch { /* no local baseline dump to compare with */ }
        problems.push(`${screen}: ${detail}`);
      } finally {
        await context.close().catch(() => {});
      }
    }
    if (write.size) {
      const ordered = Object.fromEntries(Object.keys(SCREENS).filter(s => baseline[s]).map(s => [s, baseline[s]]));
      await writeFile(BASELINE, `${JSON.stringify(ordered, null, 2)}\n`);
    }
    assert(problems.length === 0, problems.join(' | '));
  });
  await first?.context.close().catch(() => {});

  // Each check opens its own screen first (as the C0 check above does for its first screen), so
  // `check`'s own look for a stray open dialog finds a page that is still open.
  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, hash: APPEARANCE });
    await check(`compact C1 (${theme}): Settings › Appearance › View switches to Compact at once, mirrored, and survives reload`, () => c1(theme, page, { assert, shot, settled, calls }));
    await context.close().catch(() => {});
  }
  for (const [mirrorValue, wantFirst] of [['compact', 'compact'], ['zzz', 'default']]) {
    const { page, context } = await open({ hash: APPEARANCE, localPrefs: { 'codemie.view': mirrorValue } });
    await check(`compact C1: a mirror of '${mirrorValue}' decides the first paint ('${wantFirst}'), then native's 'default' corrects it`, () => c1Mismatch(page, assert, mirrorValue, wantFirst));
    await context.close().catch(() => {});
  }
}
