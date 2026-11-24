// Browser checks of the Menu bar card (Settings › Notifications, design docs/superpowers/specs/
// 2026-11-24-menu-bar-count-design.md §6, § Copy), its seen marks and its menu-row routing, run by
// workspace-e2e.mjs with its MOCKED native bridge. M1 the card across both views, both themes and
// three widths; M2 the Tasks switch's settings_update and a forced refusal putting it back off; M3
// the amber "Needs fixing" row and its Fix button; M4 "Nothing is counted."; M5 menu_bar_seen marks
// sent on open, never twice at the same revision, never while the page reports no focus; M6
// `workspace:notification-open` routing; M7 Default/Compact markup parity; M8 nothing written or
// sent by rendering alone. Plus two carried review findings: (a) a persistent `storage` refusal of
// menu_bar_seen, with two marks due at once, sends at most 2 in 1 s (Task 6 review I1 — the fix
// keeps a refused mark's key so it isn't resent until the snapshot revision moves); (b) the card
// lists every fix, with no cap, unlike the native tray's "and N more" (Task 5 review).
import { noClip, FIXED_NOW } from './compact-checks.mjs';
import { withMenuBar } from '../fixtures/workspace-fixture.mjs';

// reply-checks.mjs's `noOverflow` pattern.
const noOverflow = async (page, assert, what) => {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, document.getElementById('workspace-main').scrollWidth - document.getElementById('workspace-main').clientWidth));
  assert(overflow <= 0, `${what} overflows by ${overflow}px`);
};

// `data-source`, `data-fix`, `.ws-mb-fix(es)` and the card's own `[role="status"]` are unique to
// menu-bar.js, so a plain attribute/class selector is enough even in a page.evaluate — `CARD`
// (Playwright's `:has-text`, unusable inside page.evaluate) is only needed for M7's whole-card diff.
const CARD = '.ws-card:has(.ws-card-title:has-text("Menu bar"))';
const switchLabel = key => `label.ws-switch:has([data-source="${key}"])`;

export async function menuBarChecks({ open, check, assert, shot, settled, calls, OUT: _OUT }) {
  // ---------------------------------------------------------------- M1: the card, both views, both themes, three widths

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      for (const width of [1000, 1440, 1680]) {
        const { page, context, errors } = await open({ theme, width, height: 900, now: FIXED_NOW, hash: '#/settings/notifications', settings: view === 'compact' ? { view: 'compact' } : null });
        await check(`menu-bar M1: ${theme} ${view} ${width}`, async () => {
          await page.waitForSelector('[role="status"]');
          await settled(page);
          const sources = await page.locator('[data-source]').evaluateAll(els => els.map(el => [el.dataset.source, el.checked]));
          assert(JSON.stringify(sources) === JSON.stringify([['replies', true], ['tasks', false], ['meetings', false], ['automations', false]]), `the four switches, only replies on: ${JSON.stringify(sources)}`);
          const status = await page.locator('[role="status"]').innerText();
          assert(status === 'Now: 2 — 2 messages need a reply', status);
          await noOverflow(page, assert, `${theme} ${view} ${width}`);
          const clipped = await noClip(page);
          assert(clipped.length === 0, clipped.join(' | '));
          await page.evaluate(() => document.querySelector('[role="status"]')?.scrollIntoView({ block: 'center' }));
          await shot(page, `menu-bar-card-${theme}-${view}-${width}`);
          assert(errors.length === 0, errors.join(' | '));
        });
        await context.close().catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------- M2: the Tasks switch, its settings_update, and a forced refusal

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/settings/notifications' });
    await check('menu-bar M2: turning on "Tasks due today or late" sends one settings_update, the status line reads the several state, and a forced refusal puts the switch back off', async () => {
      await page.waitForSelector('[role="status"]');
      await settled(page);
      const before = (await calls(page, 'settings_update')).length;
      await page.evaluate(() => { window.__nextMenuBarState = 'several'; });
      await page.click(switchLabel('tasks'));
      await page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'settings_update').length > n, before);
      const sent = (await calls(page, 'settings_update')).slice(before);
      assert(sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ menuBar: { tasks: true } }), JSON.stringify(sent));
      await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === 'Now: 6 — 2 messages need a reply, 1 task due or late, 1 meeting with new notes, 2 automation results');
      assert(await page.locator('[data-source="tasks"]').isChecked(), 'the Tasks switch did not turn on');

      // Turn it back off (no refusal yet), then force one turning it back on.
      await page.click(switchLabel('tasks'));
      await page.waitForFunction(() => document.querySelector('[data-source="tasks"]').checked === false);
      await page.evaluate(() => { window.__menuBarRefuse = true; });
      await page.click(switchLabel('tasks'));
      await page.waitForFunction(() => document.querySelector('[data-source="tasks"]').checked === false);
      assert(!(await page.locator('[data-source="tasks"]').isChecked()), 'a forced refusal did not put the switch back off');
      await page.evaluate(() => { window.__menuBarRefuse = false; });
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- M3: the amber "Needs fixing" row and its Fix button

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      const { page, context, errors } = await open({ theme, width: 1440, height: 900, now: FIXED_NOW, hash: '#/settings/notifications', settings: view === 'compact' ? { view: 'compact' } : null, patch: s => withMenuBar(s, 'amberWithCount') });
      await check(`menu-bar M3: ${theme} ${view}: "Needs fixing" lists Todoist’s fix, and its Fix button opens Settings › Tasks`, async () => {
        await page.waitForSelector('.ws-mb-fixes');
        await settled(page);
        const fixes = await page.locator('.ws-mb-fix').allInnerTexts();
        assert(fixes.length === 1 && fixes[0].includes('Todoist needs your API token.'), JSON.stringify(fixes));
        await page.evaluate(() => document.querySelector('.ws-mb-fixes')?.scrollIntoView({ block: 'center' }));
        await shot(page, `menu-bar-amber-${theme}-${view}`);
        await page.click('[data-fix="tasks-token"]');
        await page.waitForFunction(() => location.hash === '#/settings/meetings-tasks');
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- M4: nothing chosen

  {
    const settings = { menuBar: { replies: false, tasks: false, meetings: false, automations: false } };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/settings/notifications', settings, patch: s => withMenuBar(s, 'nothingChosen') });
    await check('menu-bar M4: with all four off, the status line reads "Nothing is counted…"', async () => {
      await page.waitForSelector('[role="status"]');
      await settled(page);
      const status = await page.locator('[role="status"]').innerText();
      assert(status === 'Nothing is counted. The icon still turns amber when something needs fixing.', status);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- M5: seen marks

  {
    // Opening the new meeting sends one mark; nothing is sent while unfocused; a redraw after
    // sends none (the id has already left `newMeetings`, so there is nothing left to resend).
    const addNew = s => { s.menuBar = { ...s.menuBar, newMeetings: ['mtg-philips'] }; };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/meetings', meetings: true, patch: addNew });
    await check('menu-bar M5: opening the new meeting sends one menu_bar_seen mark, nothing is sent while the page reports no focus, and a redraw after sends none', async () => {
      await page.waitForSelector('.ws-mtg-row');
      await settled(page);
      assert((await calls(page, 'menu_bar_seen')).length === 0, 'something was sent before the meeting opened');

      await page.evaluate(() => { document.hasFocus = () => false; });
      await page.click('.ws-mtg-row[data-id="mtg-philips"]');
      await page.waitForFunction(() => location.hash.startsWith('#/meetings/mtg-philips/'));
      await settled(page);
      assert((await calls(page, 'menu_bar_seen')).length === 0, 'a mark was sent while the page reports no focus');

      await page.evaluate(() => { document.hasFocus = () => true; });
      await page.evaluate(() => window.__workspace.render());
      await page.waitForFunction(() => window.__bridgeCalls.filter(([op]) => op === 'menu_bar_seen').length === 1);
      const sent = await calls(page, 'menu_bar_seen');
      assert(sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ meetingId: 'mtg-philips' }), JSON.stringify(sent));

      await page.evaluate(async () => { for (let i = 0; i < 3; i++) window.__workspace.render(); });
      await settled(page);
      assert((await calls(page, 'menu_bar_seen')).length === 1, 'a redraw after sent another mark');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  {
    // Automations shown (with results) sends one {automations:true}.
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/automations', patch: s => withMenuBar(s, 'several') });
    await check('menu-bar M5: opening Automations with results sends one menu_bar_seen {automations:true}', async () => {
      await page.waitForSelector('.ws-auto-list, .ws-auto-empty, .ws-run-log');
      await settled(page);
      await page.waitForFunction(() => window.__bridgeCalls.filter(([op]) => op === 'menu_bar_seen').length === 1);
      const sent = await calls(page, 'menu_bar_seen');
      assert(sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ automations: true }), JSON.stringify(sent));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  {
    // A hidden meeting in `newMeetings` is marked seen from Inbox (any route, not just Meetings).
    const addNew = s => { s.menuBar = { ...s.menuBar, newMeetings: ['mtg-release'] }; };
    const hidden = { 'codemie.meetings.hidden': JSON.stringify({ ids: ['mtg-release'], series: [] }) };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/inbox', meetings: true, patch: addNew, localPrefs: hidden });
    await check('menu-bar M5: a hidden meeting in newMeetings is marked seen from Inbox', async () => {
      await page.waitForSelector('.ws-page-inbox');
      await settled(page);
      await page.waitForFunction(() => window.__bridgeCalls.filter(([op]) => op === 'menu_bar_seen').length === 1);
      const sent = await calls(page, 'menu_bar_seen');
      assert(sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ meetingId: 'mtg-release' }), JSON.stringify(sent));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- M6: menu rows and workspace:notification-open

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/today', meetings: true });
    await check('menu-bar M6: workspace:notification-open routes {route:inbox,lane:reply} to Inbox › Needs reply, {route:settings,tab:meetings-tasks} to Settings › Tasks, {route:automations} to the Run log, and {meetingId} to that meeting', async () => {
      await page.waitForSelector('.ws-page-today');
      await settled(page);

      await page.evaluate(() => window.__emitNative('workspace:notification-open', { workspaceId: 'personal', route: 'inbox', lane: 'reply' }));
      await page.waitForSelector('.ws-lane[data-lane="reply"][aria-selected="true"]');
      assert((await page.evaluate(() => location.hash)) === '#/inbox', 'did not land on Inbox');

      await page.evaluate(() => window.__emitNative('workspace:notification-open', { workspaceId: 'personal', route: 'settings', tab: 'meetings-tasks' }));
      await page.waitForFunction(() => location.hash === '#/settings/meetings-tasks');

      await page.evaluate(() => window.__emitNative('workspace:notification-open', { workspaceId: 'personal', route: 'automations' }));
      await page.waitForFunction(() => location.hash === '#/automations/runs');

      await page.evaluate(() => window.__emitNative('workspace:notification-open', { workspaceId: 'personal', meetingId: 'mtg-philips' }));
      await page.waitForFunction(() => location.hash.startsWith('#/meetings/mtg-philips/'));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- M7: Default/Compact parity

  {
    const normalize = html => html.replace(/\s(id|aria-controls|aria-describedby)="[^"]*"/g, '');
    const capture = async settings => {
      const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/settings/notifications', settings, patch: s => withMenuBar(s, 'amberWithCount') });
      await page.waitForSelector('.ws-mb-fixes');
      await settled(page);
      const html = await page.locator(CARD).evaluate(el => el.outerHTML);
      return { context, html: normalize(html) };
    };
    const def = await capture(null);
    await def.context.close().catch(() => {});
    const compact = await capture({ view: 'compact' });
    await check('menu-bar M7: the card draws the same markup in Default and Compact (ids stripped)', async () => {
      assert(def.html === compact.html, `card markup differs:\n${def.html}\n${compact.html}`);
    });
    await compact.context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- M8: nothing written or sent without a click

  {
    // The default fixture's own menuBar (Task 2's "replies" state) still carries
    // `sources.automations: 2` (results exist, just not counted) — visiting Automations would
    // rightly mark them seen. "Nothing new" means Task 2's "zero" state: every source and
    // `newMeetings` empty.
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/settings/notifications', patch: s => withMenuBar(s, 'zero') });
    await check('menu-bar M8: opening Settings › Notifications, Today, Inbox and Automations with nothing new, and rendering five times, sends and writes nothing', async () => {
      const counts = async () => Promise.all(['settings_update', 'menu_bar_seen'].map(op => calls(page, op).then(c => c.length)));
      await page.waitForSelector('[role="status"]');
      await settled(page);
      assert((await counts()).every(n => n === 0), 'something was sent on Settings › Notifications alone');
      for (const route of ['today', 'inbox', 'automations']) {
        await page.evaluate(route => window.__workspace.route(route), route);
        await settled(page);
      }
      await page.evaluate(async () => { for (let i = 0; i < 5; i++) window.__workspace.render(); });
      await settled(page);
      assert((await counts()).every(n => n === 0), `nothing was sent or written: ${JSON.stringify(await counts())}`);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- (a) a persistent `storage` refusal of menu_bar_seen
  // (carried from the Task 6 review, I1): with two marks due at once (the open meeting and a
  // hidden one), at most 2 menu_bar_seen sends land in 1 s — not the 429/s the review measured
  // before 491fcda kept a refused mark's key. The refusal switch is set before the window's own
  // scripts boot (an init script registered after `open()`, then a reload), so it is in force for
  // the very first render that finds both marks due, not only for a later one.

  {
    const addNew = s => { s.menuBar = { ...s.menuBar, newMeetings: ['mtg-philips', 'mtg-release'] }; };
    const hidden = { 'codemie.meetings.hidden': JSON.stringify({ ids: ['mtg-release'], series: [] }) };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/meetings/mtg-philips/summary', meetings: true, patch: addNew, localPrefs: hidden });
    await check('menu-bar (a): a persistent storage refusal of menu_bar_seen, with the open meeting and a hidden one both due, sends at most 2 in 1 s', async () => {
      await page.waitForFunction(() => location.hash.startsWith('#/meetings/mtg-philips/'));
      await page.addInitScript(() => { window.__menuBarSeenRefuse = true; });
      await page.reload();
      await page.waitForSelector('.ws-sidebar');
      await page.waitForFunction(() => location.hash.startsWith('#/meetings/mtg-philips/'));
      await page.waitForTimeout(1000);
      const sent = await calls(page, 'menu_bar_seen');
      assert(sent.length >= 1 && sent.length <= 2, `menu_bar_seen was sent ${sent.length} times in 1 s: ${JSON.stringify(sent)}`);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- (b) the card lists every fix, with no cap
  // (carried from the Task 5 review): unlike the native tray (at most 3 fix rows, then "and N
  // more"), the Settings page always lists every fix.

  {
    const twoFixes = s => {
      s.menuBar = {
        ...s.menuBar,
        amber: true,
        fixes: [
          { id: 'microsoft', open: { route: 'settings', tab: 'microsoft' }, text: 'Microsoft 365 needs you to sign in again.' },
          { id: 'tasks-token', open: { route: 'settings', tab: 'meetings-tasks' }, text: 'Todoist needs your API token.' },
        ],
      };
    };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/settings/notifications', patch: twoFixes });
    await check('menu-bar (b): with two fixes at once, the card lists both, with no "and N more" cap', async () => {
      await page.waitForSelector('.ws-mb-fixes');
      await settled(page);
      const fixes = await page.locator('.ws-mb-fix').allInnerTexts();
      assert(fixes.length === 2, `expected both fixes, found ${fixes.length}: ${JSON.stringify(fixes)}`);
      assert(fixes.some(t => t.includes('Microsoft 365 needs you to sign in again.')), JSON.stringify(fixes));
      assert(fixes.some(t => t.includes('Todoist needs your API token.')), JSON.stringify(fixes));
      assert(!fixes.some(t => /and \d+ more/i.test(t)), `the card truncated its fixes: ${JSON.stringify(fixes)}`);
      await page.evaluate(() => document.querySelector('.ws-mb-fixes')?.scrollIntoView({ block: 'center' }));
      await shot(page, 'menu-bar-two-fixes');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
}
