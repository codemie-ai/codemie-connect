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

export async function pluginChecks({ open, check, assert, shot, quiet }) {
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

      // A link in its page (ruling R41): Connect asks first in its own dialog, with the whole
      // address; Cancel opens nothing, Open asks native to open it (recorded by the stand-in).
      const LINK = 'https://example.com/hello?from=connect&x=1';
      await frame.locator('[data-hello-link]').click();
      await page.waitForSelector(`${dialog} .ws-link-confirm`);
      const asked = await page.locator(dialog).innerText();
      assert(asked.includes('Open this link?') && asked.includes(LINK) && asked.includes('Hello wants to open this address. It opens in your browser.'), asked);
      assert(await page.evaluate(() => document.activeElement?.matches('.ws-modal[open] [data-modal-close]') && document.activeElement.textContent === 'Cancel'), 'Cancel has the focus');
      await page.waitForTimeout(450);
      await shot(page, `plugins-${tag}-link`);
      await page.click(`${dialog} .ws-modal-footer [data-modal-close]`);
      await page.waitForSelector(dialog, { state: 'detached' });
      assert((await page.evaluate(() => window.__pluginOpened.length)) === 0, 'opened without the user’s Open');
      await frame.locator('[data-hello-link]').click();
      await page.waitForSelector(`${dialog} .ws-link-confirm`);
      await page.waitForTimeout(450);
      await page.click(submit);
      await page.waitForSelector(dialog, { state: 'detached' });
      const opened = await page.evaluate(() => window.__pluginOpened);
      assert(opened.length === 1 && opened[0].url === LINK && opened[0].id === 'hello', JSON.stringify(opened));
      // An address Connect doesn't open is refused in words; no dialog.
      await frame.locator('[data-hello-http]').click();
      await page.waitForSelector('.ws-toast:has-text("Connect opens only https:// and obsidian:// links.")');
      assert(await page.locator(dialog).count() === 0, 'a dialog for a refused address');
      assert(await page.evaluate(() => location.hash) === '#/p/hello/home', 'the window moved');
      await framed(page);

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
      await page.click('.ws-today-actions [data-action="today-customize"]:has-text("Customize")');
      await page.click('.ws-gallery [data-action="today-add"][data-id="plugin:hello:greeting"]');
      await page.waitForSelector('[data-tile="plugin:hello:greeting"]');
      await page.click('.ws-gallery [data-action="today-add"][data-id="plugin:hello:board"]');
      await page.waitForSelector('[data-tile="plugin:hello:board"]');
      await page.click('.ws-today-editbar [data-action="today-done"]');
      await page.waitForSelector('[data-widget="plugin:hello:greeting"]');
      assert((await page.locator('[data-widget="plugin:hello:greeting"]').innerText()).includes('A card from the host half'), 'widget data');
      // A page widget is drawn by its client half in its frame; Today shows the text of it.
      await page.waitForSelector('[data-widget="plugin:hello:board"] .ws-pw-page:has-text("Drawn in its frame")');
      assert(await page.locator('[data-widget="plugin:hello:board"] img').count() === 0, 'the drawn HTML is shown as text');
      assert(await page.evaluate(() => !window.__pwned), 'nothing a plugin gave ran');
      // The frames' widget text arrives in more than one render.
      await quiet(page);
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
        await quiet(page);
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

      // Turned on again, its host half doesn't load (as Telegram's doesn't, PLUGIN-ENGINE §10):
      // Settings says why, it can still be turned off, and it gets no frame.
      await page.evaluate(() => window.__setPluginLoadError('hello', 'CodeMie Connect doesn’t have ctx.sessions (only Echo has it), so this plugin needs a change to run here: cannot read property ‘clearChannel’ of undefined'));
      await page.locator('.ws-plugin-row[data-plugin-id="hello"] .ws-switch').click();
      await page.waitForSelector('.ws-plugin-row[data-plugin-id="hello"] .ws-badge:text("Didn’t load")');
      const row = await page.locator('.ws-plugin-row[data-plugin-id="hello"]').innerText();
      assert(row.includes('needs a change to run here'), `row: ${row}`);
      assert(!(await page.locator('.ws-plugin-row[data-plugin-id="hello"] .ws-switch').isDisabled()), 'it can still be turned off');
      await page.waitForTimeout(300);
      assert(await page.locator(FRAME).count() === 0, 'no frame for a plugin whose host half didn’t load');
      assert(await page.locator('.ws-plugin-nav').count() === 0, 'no page in the sidebar');
      await noOverflow(page, 'Plugins with a load error');
      await settle(page);
      await shot(page, `plugins-${tag}-didnt-load`);
      await page.click('[data-action="plugin-open"][data-plugin-id="hello"]');
      await page.waitForSelector('.ws-plugin-detail .ws-inline-note.ws-error');
      const note = await page.locator('.ws-plugin-detail .ws-inline-note.ws-error').innerText();
      assert(note.includes('Its host half didn’t load, so it isn’t running') && note.includes('ctx.sessions'), `note: ${note}`);
      await noOverflow(page, 'plugin detail with a load error');
      await settle(page);
      await shot(page, `plugins-${tag}-didnt-load-detail`);
    });

    await check(`${theme}: plugin frames have no page errors`, async () => assert(errors.length === 0, errors.join(' | ')));

    // The plugin manager says a reload finished (native `plugins:reloaded`): the window reads the
    // installed list again, so a host half that didn't load shows without reopening Settings, and
    // one that loaded gets its frame back.
    let p = null;
    let c = null;
    let errs = [];
    await check(`${theme}: a finished plugin reload is shown without reopening Settings`, async () => {
      ({ page: p, context: c, errors: errs } = await open({ theme, width: 1440, height: 900, hash: '#/settings/plugins' }));
      await installHello(p);
      await p.click('.ws-settings-nav button[data-tab=plugins]');
      await p.waitForSelector('.ws-plugin-row[data-plugin-id="hello"]');
      await p.waitForSelector(FRAME, { state: 'attached' });
      await p.evaluate(() => {
        window.__setPluginLoadError('hello', 'cannot read property ‘clearChannel’ of undefined');
        window.__emitNative('plugins:reloaded', { changed: true });
      });
      await p.waitForSelector('.ws-plugin-row[data-plugin-id="hello"] .ws-badge:text("Didn’t load")');
      await p.waitForSelector(FRAME, { state: 'detached' });
      await p.evaluate(() => {
        window.__setPluginLoadError('hello', '');
        window.__emitNative('plugins:reloaded', { changed: true });
      });
      await p.waitForSelector(FRAME, { state: 'attached' });
      await p.waitForSelector('.ws-plugin-row[data-plugin-id="hello"] .ws-badge:text("Didn’t load")', { state: 'detached' });
    });

    // The drive goes away while a plugin page is open: the recovery page is drawn over everything,
    // with no plugin frame left on top of its card.
    await check(`${theme}: the recovery page covers an open plugin page`, async () => {
      assert(p, 'no page from the check before');
      await p.click('.ws-plugin-nav [data-action="plugin-page"][data-plugin-id="hello"]');
      await p.frameLocator(FRAME).locator('h1:text("Hello page")').waitFor();
      await framed(p);
      await p.evaluate(() => { window.__storageFail = true; window.dispatchEvent(new Event('focus')); });
      await p.waitForSelector('.ws-recovery-card[data-status="ready"]');
      await p.waitForTimeout(300);
      const onTop = await p.evaluate(() => {
        const r = document.querySelector('[data-action="recovery-retry"]').getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { inCard: !!el?.closest('.ws-recovery-card'), at: el?.tagName, frameHidden: !!document.querySelector('iframe[data-plugin-frame="hello"]')?.hidden };
      });
      assert(onTop.inCard && onTop.frameHidden, `a plugin frame covers the recovery page: ${JSON.stringify(onTop)}`);
      await shot(p, `plugins-${tag}-recovery`);
      assert(errs.length === 0, errs.join(' | '));
    });
    await c?.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/** Adds the folder marketplace and installs hello, agreeing to every line of its sheet. */
async function installHello(page) {
  await page.waitForSelector('[data-action="market-add"]');
  await page.click('[data-action="market-add"]');
  await page.waitForSelector(`${dialog} #market-source`);
  await page.click(`${dialog} [data-action="market-pick"]`);
  await page.waitForFunction(() => document.querySelector('#market-source')?.value === '/Users/qa/Plugins/acme-market');
  await page.click(submit);
  await page.waitForSelector('.ws-offer[data-plugin-id="hello"]');
  await page.click('.ws-offer[data-plugin-id="hello"] .ws-offer-open');
  await page.waitForSelector('#plugin-sheet');
  await page.click('[data-action="plugin-install"]');
  await page.waitForSelector(`${dialog} #plugin-consent`);
  const boxes = page.locator(`${dialog} [name=agree]`);
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check({ force: true });
  await page.waitForTimeout(450);
  await page.click(submit);
  await page.waitForSelector(dialog, { state: 'detached' });
  await page.waitForSelector('.ws-plugin-nav [data-action="plugin-page"][data-plugin-id="hello"]', { timeout: 8000 });
}
