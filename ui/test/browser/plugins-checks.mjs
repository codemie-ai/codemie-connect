// Browser checks of plugins (DESIGN 7.3, Tasks 23–24), run by workspace-e2e.mjs with its MOCKED
// native bridge: add a marketplace, install the synthetic `hello` plugin
// (ui/test/fixtures/plugins/hello/), open its page and Settings section in its sandboxed frame,
// see plugin widgets and held messages on Today, and turn it off. Both themes; 1440, 1000 and
// 1680 px. It proves the window's side and the shim in a real browser, not native isolation (the
// native smoke `CODEMIE_PLUGIN_SMOKE=isolation` does that).
const dialog = '.ws-modal[open]';
const submit = `${dialog} .ws-modal-footer button[type=submit]`;
const FRAME = 'iframe[data-plugin-frame="hello"]';
const HOSTILE = '<img src=x onerror="window.__pwned=1">';

/** Records a plugin has put on Today before: a widget, an Inbox item, a delivery held as mail. */
export function pluginRecords(nowMs) {
  const at = Math.floor(nowMs / 1000) - 600;
  const item = (id, data) => ({ id, kind: 'plugin_item', source: `plugin:${data.plugin}`, revision: `r-${id}`, updatedAt: at, connectionId: null, workspaceId: null, data: { at, ...data } });
  return [
    { id: 'hello:greeting', kind: 'plugin_widget', source: 'plugin:hello', revision: 'r-greeting', updatedAt: at, connectionId: null, workspaceId: null, data: { type: 'widget', plugin: 'hello', pluginName: 'Hello', widget: 'greeting', kind: 'card', label: 'Hello greeting', at, data: { title: 'Hello', text: `A card from the host half ${HOSTILE}` } } },
    { id: 'hello:board', kind: 'plugin_widget', source: 'plugin:hello', revision: 'r-board', updatedAt: at, connectionId: null, workspaceId: null, data: { type: 'widget', plugin: 'hello', pluginName: 'Hello', widget: 'board', kind: 'page', label: 'Hello board', at, data: { text: `Drawn in its frame ${HOSTILE}` } } },
    item('github:inbox:review:7', { type: 'inbox', plugin: 'github', pluginName: 'GitHub', key: 'review:7', title: `Review “Fix the sync retry” ${HOSTILE}`, why: 'Priya asked you to review it this morning.', urgent: true, go: '', actions: [{ label: 'Approve', command: 'approve', args: { pr: 7 }, primary: true }] }),
    item('scheduler:held:1', { type: 'held_message', plugin: 'scheduler', pluginName: 'Scheduler', channel: 'mail', to: { self: true, address: 'taylor@example.com' }, subject: 'Monday plan', markdown: `Three things for this week:\n- Ship the plugin host\n- Review the sync retry\n- Book the review room ${HOSTILE}`, state: 'held', sent: false }),
    item('scheduler:card:3b1f', { type: 'delivery', plugin: 'scheduler', pluginName: 'Scheduler', to: 'mail', title: 'Monday plan', about: 'monday', markdown: 'Three things for this week', held: 'scheduler:held:1' }),
  ];
}

export async function pluginChecks({ open, check, assert, shot }) {
  const settle = page => page.waitForTimeout(250);
  const noOverflow = async (page, what) => {
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.ws-main, .ws-settings-panels')].map(el => el.scrollWidth - el.clientWidth)));
    assert(overflow <= 0, `${what} overflows by ${overflow}px`);
  };
  /** The frame lies over its slot, and is shown. */
  const framed = async page => {
    const [frame, slot] = await page.evaluate(sel => [document.querySelector(sel), document.querySelector('[data-plugin-slot="hello"]')].map(el => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), hidden: el.hidden };
    }), FRAME);
    assert(frame && slot && !frame.hidden, `frame ${JSON.stringify(frame)} slot ${JSON.stringify(slot)}`);
    assert(Math.abs(frame.x - slot.x) <= 1 && Math.abs(frame.y - slot.y) <= 1 && Math.abs(frame.w - slot.w) <= 1 && Math.abs(frame.h - slot.h) <= 1, `frame ${JSON.stringify(frame)} isn't over its slot ${JSON.stringify(slot)}`);
  };

  for (const theme of ['dark', 'light']) {
    const tag = `${theme}-1440`;
    const { page, context, errors } = await open({ theme, width: 1440, height: 900, hash: '#/settings/plugins', pluginRecords });
    // A plugin frame's own errors reach the console, which `open` collects.
    await page.addInitScript(() => {
      if (window.top !== window) window.addEventListener('error', e => console.error(`plugin frame error: ${e.message}`));
    });
    const frame = page.frameLocator(FRAME);

    await check(`${theme}: plugins: add a marketplace, install hello, open its page, turn it off`, async () => {
      await page.waitForSelector('[data-action="market-add"]');
      assert(await page.locator('.ws-settings-nav button[data-tab=plugins][aria-current=page]').count() === 1, 'Plugins tab current');
      await noOverflow(page, 'Plugins');
      await shot(page, `plugins-${tag}-empty`);

      // A marketplace in a folder, chosen with the native picker (mocked).
      await page.click('[data-action="market-add"]');
      await page.waitForSelector(`${dialog} #market-source`);
      await page.click(`${dialog} [data-action="market-pick"]`);
      await page.waitForFunction(() => document.querySelector('#market-source')?.value === '/Users/qa/Plugins/acme-market');
      await page.click(submit);
      await page.waitForSelector('.ws-offer[data-plugin-id="hello"]');
      const knowledge = await page.locator('.ws-offer[data-plugin-id="vault-notes"]').innerText();
      assert(knowledge.includes('Coming later — needs Connect’s Knowledge engine'), `Knowledge: ${knowledge}`);
      const newer = await page.locator('.ws-offer[data-plugin-id="next-gen"]').innerText();
      assert(newer.includes('needs plugin engine >=1.1.0'), `newer engine: ${newer}`);
      await settle(page);
      await shot(page, `plugins-${tag}-catalog`);

      // Its detail: the sheet with markers and the unverified notice.
      await page.click('.ws-offer[data-plugin-id="hello"] .ws-offer-open');
      await page.waitForSelector('#plugin-sheet');
      const detail = await page.locator('.ws-plugin-detail').innerText();
      assert(detail.includes('Unverified package · installs run with the access you approve'), 'unverified notice');
      assert(/Partial/i.test(detail) && /Supported/i.test(detail), "support markers");
      await settle(page);
      await shot(page, `plugins-${tag}-detail`);

      // Install asks for every line, then sends the agreement.
      await page.click('[data-action="plugin-install"]');
      await page.waitForSelector(`${dialog} #plugin-consent`);
      assert(await page.locator(submit).isDisabled(), 'Install waits for every line');
      const boxes = page.locator(`${dialog} [name=agree]`);
      await boxes.nth(0).check({ force: true });
      assert(await page.locator(submit).isDisabled(), 'one line is not all of them');
      await page.waitForTimeout(350);
      await shot(page, `plugins-${tag}-consent`);
      await boxes.nth(1).check({ force: true });
      assert(!(await page.locator(submit).isDisabled()), 'every line ticked');
      await page.waitForTimeout(450);
      await page.click(submit);
      await page.waitForSelector(dialog, { state: 'detached' });

      // Its frame: sandboxed, from its own address; its page joins the sidebar.
      await page.waitForSelector('.ws-plugin-nav [data-action="plugin-page"][data-plugin-id="hello"]', { timeout: 8000 });
      const attrs = await page.locator(FRAME).evaluate(el => ({ sandbox: el.getAttribute('sandbox'), srcdoc: el.hasAttribute('srcdoc'), src: el.getAttribute('src') }));
      assert(attrs.sandbox === 'allow-scripts' && !attrs.srcdoc && /\/plugin-frames\/hello\/__host\/frame\.html\?v=/.test(attrs.src), JSON.stringify(attrs));

      // Its page over the content area; Say hello runs its host half through the window.
      await page.click('.ws-plugin-nav [data-action="plugin-page"][data-plugin-id="hello"]');
      await page.waitForFunction(() => location.hash === '#/p/hello/home');
      await frame.locator('h1:text("Hello page")').waitFor();
      await framed(page);
      assert((await frame.locator('html').getAttribute('class')).includes(theme), 'the frame follows the theme');
      await frame.locator('[data-hello-greet]').click();
      await frame.locator('#hello-out .set-ok').waitFor();
      const greeting = await frame.locator('#hello-out').innerText();
      assert(greeting.trim() === 'Hello, Taylor <b>', `greeting shown as text: ${greeting}`);
      const calls = await page.evaluate(() => window.__pluginCalls);
      assert(calls.some(c => c.id === 'hello' && c.command === 'greet' && c.args?.name === 'Taylor <b>'), JSON.stringify(calls));
      assert(await page.locator('.ws-plugin-nav [aria-current=page][data-plugin-id="hello"]').count() === 1, 'its sidebar entry is current');
      await settle(page);
      await shot(page, `plugins-${tag}-page`);

      // Its own Settings section, reached by ctx.go from its page.
      await frame.locator('[data-hello-settings]').click();
      await page.waitForFunction(() => location.hash === '#/settings/plugins/hello/main');
      await frame.locator('h2:text("Hello settings")').waitFor();
      await framed(page);
      assert(await page.locator('.ws-settings-subnav [data-plugin-id="hello"][aria-current=page]').count() === 1, 'its section is current under Plugins');
      await frame.locator('.sw[data-set=loud]').click();
      await page.waitForSelector('.ws-settings-subnav [data-plugin-id="hello"] .ws-count');
      await settle(page);
      await shot(page, `plugins-${tag}-section`);

      // Its page in Settings → Plugins: its card in the frame, Sign in, its addresses.
      await page.click('.ws-settings-nav button[data-tab=plugins]');
      await page.click('[data-action="plugin-open"][data-plugin-id="hello"]');
      await page.waitForSelector('.ws-plugin-card-slot[data-plugin-slot="hello"]');
      await frame.locator('[data-hello-open]').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-plugin-slot="hello"]').getBoundingClientRect().height > 20);
      await framed(page);
      await page.click('[data-action="plugin-signin"]');
      await page.waitForSelector('[data-action="plugin-signout"]');
      await page.fill('[data-form="plugin-addresses"] input[name=value]', '10.0.0.5, nas.local');
      await page.click('[data-form="plugin-addresses"] button[type=submit]');
      await page.waitForFunction(() => document.querySelector('[data-form="plugin-addresses"] input[name=value]')?.value === '10.0.0.5, nas.local');
      await settle(page);
      await shot(page, `plugins-${tag}-installed`);

      // Today: a plugin widget added in Customize, its data as text; From plugins with the
      // held message, never sent.
      await page.click('.ws-nav button[data-route=today]');
      await page.waitForSelector('.ws-plugins-card');
      const card = await page.locator('.ws-plugins-card').innerText();
      assert(card.includes('Not sent — Connect never sends for plugins'), 'held message note');
      assert(card.includes('<img src=x'), 'plugin text shown as text');
      await page.click('[data-action="customize"]');
      await page.waitForSelector(`${dialog} [data-widget="plugin:hello:greeting"]`);
      await page.locator(`${dialog} [data-widget="plugin:hello:greeting"] .ws-switch`).click();
      await page.locator(`${dialog} [data-widget="plugin:hello:board"] .ws-switch`).click();
      await page.waitForTimeout(450);
      await page.click(submit);
      await page.waitForSelector('[data-widget="plugin:hello:greeting"]');
      assert((await page.locator('[data-widget="plugin:hello:greeting"]').innerText()).includes('A card from the host half'), 'widget data');
      // A page widget is drawn by its client half in its frame; Today shows the text of it.
      await page.waitForSelector('[data-widget="plugin:hello:board"] .ws-pw-page:has-text("Drawn in its frame")');
      assert(await page.locator('[data-widget="plugin:hello:board"] img').count() === 0, 'the drawn HTML is shown as text');
      assert(await page.evaluate(() => !window.__pwned), 'nothing a plugin gave ran');
      await page.locator('.ws-plugins-card').scrollIntoViewIfNeeded();
      await settle(page);
      await shot(page, `plugins-${tag}-today`);

      // Wider and narrower windows: the page, the section and Today fit.
      for (const [width, height] of [[1000, 760], [1680, 960]]) {
        await page.setViewportSize({ width, height });
        await page.click('.ws-plugin-nav [data-action="plugin-page"][data-plugin-id="hello"]');
        await frame.locator('h1:text("Hello page")').waitFor();
        await page.waitForTimeout(200);
        await framed(page);
        await noOverflow(page, `plugin page ${width}`);
        await shot(page, `plugins-${theme}-${width}-page`);
        await page.click('.ws-nav button[data-route=settings]');
        await page.click('.ws-settings-nav button[data-tab=plugins]');
        await page.click('.ws-settings-subnav [data-plugin-id="hello"]');
        await frame.locator('h2:text("Hello settings")').waitFor();
        await page.waitForTimeout(200);
        await framed(page);
        await shot(page, `plugins-${theme}-${width}-section`);
        await page.click('.ws-settings-nav button[data-tab=plugins]');
        await page.waitForSelector('.ws-offer[data-plugin-id="hello"]');
        await noOverflow(page, `Plugins ${width}`);
        await settle(page);
        await shot(page, `plugins-${theme}-${width}-list`);
        await page.click('.ws-nav button[data-route=today]');
        await page.waitForSelector('.ws-plugins-card');
        await noOverflow(page, `Today ${width}`);
        await page.locator('.ws-plugins-card').scrollIntoViewIfNeeded();
        await settle(page);
        await shot(page, `plugins-${theme}-${width}-today`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      // Turned off: its sidebar entry and its frame go.
      await page.click('.ws-nav button[data-route=settings]');
      await page.click('.ws-settings-nav button[data-tab=plugins]');
      await page.waitForSelector('.ws-plugin-row[data-plugin-id="hello"]');
      await page.locator('.ws-plugin-row[data-plugin-id="hello"] .ws-switch').click();
      await page.waitForSelector('.ws-plugin-nav', { state: 'detached' });
      await page.waitForSelector(FRAME, { state: 'detached' });
      assert(await page.locator('.ws-plugin-row[data-plugin-id="hello"] .ws-badge:text("Off")').count() === 1, 'shown as off');
      await settle(page);
      await shot(page, `plugins-${tag}-off`);
    });

    await check(`${theme}: plugin frames have no page errors`, async () => assert(errors.length === 0, errors.join(' | ')));
    await context.close().catch(() => {});
  }
}
