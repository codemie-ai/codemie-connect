// Browser checks of the flexible layout (spec docs/superpowers/specs/2026-11-19-flexible-layout-design.md,
// plan Task 7, E1–E8), run by workspace-e2e.mjs with its MOCKED native bridge: Today's grid moved
// and resized by pen, mouse, touch and keys, Customize and its gallery, the widget menu and options,
// saved layouts and older layouts moving over, the lock, the page sections, the folding Settings
// menu, both menus shrunk to icons, and no horizontal overflow. `layout_save` calls are read from
// the mock (`calls`), and a reload keeps the workspaces (the mock holds them in sessionStorage). It
// proves the window's side, not native storage.
import { PRESETS, compact, todayOf } from '../../workspace/today-grid.js';
import { SETTINGS_GROUPS } from '../../workspace/view-settings.js';

// The Default layout as todayOf builds it for a workspace never customized.
const DEFAULT_TODAY = todayOf({ widgetWidths: {} }, {});
const GAP = 16;
const ROW = 72;

export async function layoutChecks({ open, check, assert, shot, settled, calls }) {
  const saves = page => calls(page, 'layout_save');
  const lastSave = async page => (await saves(page)).at(-1);
  /** Waits until more than `n` layout saves have been recorded. */
  const savedAfter = (page, n) => page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'layout_save').length > n, n);
  const itemOf = (save, id) => save.today.items.find(i => i.id === id);
  const box = async (page, selector) => {
    const b = await page.locator(selector).first().boundingBox();
    if (!b) throw new Error(`${selector} is not on the page`);
    return b;
  };
  /** Where a tile is drawn: its --x --y --w --h. */
  const placeOf = (page, id) => page.evaluate(id => {
    const el = document.querySelector(`[data-today-grid] > [data-tile="${id}"]`);
    if (!el) return null;
    const v = k => Number(el.style.getPropertyValue(`--${k}`));
    return { x: v('x'), y: v('y'), w: v('w'), h: v('h') };
  }, id);
  /** One grid column plus its gap, in px. */
  const stepOf = page => page.evaluate(gap => (document.querySelector('[data-today-grid]').clientWidth - gap * 11) / 12 + gap, GAP);
  /** Scrolls the page so the top of `selector` is `at` px from the top of the window. */
  const intoView = (page, selector, at = 160) => page.evaluate(([sel, at]) => {
    const main = document.getElementById('workspace-main');
    main.scrollTop += document.querySelector(sel).getBoundingClientRect().top - at;
  }, [selector, at]);
  /** A pen or touch pointer event at `point`, sent to what is under it (a press there, or the
   *  window's move and release listeners). Synthetic, so no mouse events follow. */
  const pointer = (page, type, point, pointerType) => page.evaluate(([type, { x, y }, pointerType]) => {
    const target = document.elementFromPoint(x, y) || document.body;
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType, isPrimary: true,
      clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
  }, [type, point, pointerType]);
  const live = (page, text) => page.waitForFunction(text => document.getElementById('ws-live')?.textContent === text, text);
  const noOverflow = async (page, what) => {
    const over = await page.evaluate(() => {
      const main = document.getElementById('workspace-main');
      return { main: main.scrollWidth - main.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    assert(over.main <= 0 && over.page <= 0, `${what} overflows sideways: ${JSON.stringify(over)}`);
  };
  const overlaps = items => items.some((a, i) => items.some((b, j) => i < j && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y));
  const openTodayMenu = async page => {
    await page.click('.ws-today-actions details[data-menu="today-more"] > summary');
    await page.waitForSelector('.ws-today-actions details[data-menu="today-more"][open]');
  };
  const layoutMenu = async (page, item) => {
    await openTodayMenu(page);
    await page.click(`.ws-today-actions details[data-menu="today-more"] ${item}`);
  };
  /** The name of the layout in use, read from the ⋯ menu (opened, read, then closed again). */
  const activeLayoutName = async page => {
    await openTodayMenu(page);
    const name = await page.locator('[data-menu="today-more"] [data-action="today-layout-use"][aria-checked="true"]').innerText();
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ws-today-actions details[data-menu="today-more"]:not([open])');
    return name;
  };
  /** The tiles drawn, as {id: {x, y, w, h}}. */
  const tilesNow = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-today-grid] > [data-tile]')].map(el => {
    const v = k => Number(el.style.getPropertyValue(`--${k}`));
    return [el.dataset.tile, { x: v('x'), y: v('y'), w: v('w'), h: v('h') }];
  })));
  const sameAs = (tiles, items) => Object.keys(tiles).length === items.length && items.every(i => tiles[i.id] && ['x', 'y', 'w', 'h'].every(k => tiles[i.id][k] === i[k]));

  // ---------------------------------------------------------------- E1
  {
    const { page, context, errors } = await open({ width: 1440, height: 900, workspace: { today: DEFAULT_TODAY } });
    await check('layout E1: a pen swaps Day at a glance and Up next, and a sync mid-drag doesn’t redraw under it', async () => {
      // With nothing held, a sync's refresh draws Today again: its tiles are new elements.
      await page.evaluate(() => { window.__heldTile = document.querySelector('[data-tile="focus"]'); });
      await page.evaluate(() => window.__workspace.store.refresh());
      await page.waitForFunction(() => document.querySelector('[data-tile="focus"]') !== window.__heldTile);
      await page.evaluate(() => { document.getElementById('workspace-main').scrollTop = 0; });
      const head = await box(page, '[data-tile="focus"] .ws-tile-head h2');
      const brief = await box(page, '[data-tile="brief"]');
      const from = { x: head.x + 30, y: head.y + head.height / 2 };
      const to = { x: brief.x + 2, y: from.y };
      const half = { x: (from.x + to.x) / 2, y: from.y };
      await pointer(page, 'pointerdown', from, 'pen');
      // Outside Customize a pen lifts the widget after its long press (380 ms) held still.
      await page.waitForSelector('[data-tile="focus"].ws-tile-lifted');
      await pointer(page, 'pointermove', half, 'pen');
      await page.evaluate(() => { window.__heldTile = document.querySelector('[data-tile="focus"]'); });
      const stillHeld = () => page.evaluate(({ x, y }) => {
        const el = window.__heldTile;
        const r = el.getBoundingClientRect();
        return { same: document.querySelector('[data-tile="focus"]') === el, lifted: el.classList.contains('ws-tile-lifted'), under: el.contains(document.elementFromPoint(x, y)), left: Math.round(r.left), top: Math.round(r.top) };
      }, half);
      // A sync's snapshot arrives mid-drag: the store's refresh, which re-renders when nothing is held.
      await page.evaluate(() => window.__workspace.store.refresh());
      let held = await stillHeld();
      assert(held.same && held.lifted && held.under, `the tile left the pen after the refresh: ${JSON.stringify(held)}`);
      // A redraw called directly, as plugin widgets and the plugins page do: render() holds it too.
      await page.evaluate(() => window.__workspace.render());
      held = await stillHeld();
      assert(held.same && held.lifted && held.under, `the tile left the pen after a direct render: ${JSON.stringify(held)}`);
      await shot(page, 'layout-e1-held');
      await pointer(page, 'pointermove', to, 'pen');
      await pointer(page, 'pointerup', to, 'pen');
      await savedAfter(page, 0);
      await page.waitForSelector('[data-tile="focus"][style^="--x:0;--y:0;"]:not(.ws-tile-lifted)');
      await page.waitForSelector('[data-tile="brief"][style^="--x:4;--y:0;"]');
      await settled(page);
      const all = await saves(page);
      assert(all.length === 1, `layout_save sent ${all.length} times`);
      assert(all[0].layout.slice(0, 2).join() === 'focus,brief', `layout ${all[0].layout}`);
      const f = itemOf(all[0], 'focus');
      const b = itemOf(all[0], 'brief');
      assert(f.x === 0 && f.y === 0 && b.x === 4 && b.y === 0, `saved focus ${JSON.stringify(f)}, brief ${JSON.stringify(b)}`);
      await page.reload();
      await page.waitForSelector('[data-today-grid]');
      const order = await page.evaluate(() => [...document.querySelectorAll('[data-today-grid] > [data-tile]')].slice(0, 2).map(el => el.dataset.tile).join());
      assert(order === 'focus,brief', `after reload the order is ${order}`);
      const again = [await placeOf(page, 'focus'), await placeOf(page, 'brief')];
      assert(again[0].x === 0 && again[0].y === 0 && again[1].x === 4 && again[1].y === 0, `after reload ${JSON.stringify(again)}`);
      await shot(page, 'layout-e1-reloaded');
      assert(errors.length === 0, errors.join(' | '));
    });
    await check('layout E1: the lowest widget dropped into the empty rows below is drawn back where it packs, nothing saved', async () => {
      const was = await placeOf(page, 'automations');
      const n = (await saves(page)).length;
      await page.waitForSelector('[data-tile="automations"] .ws-tile-head h2');
      await intoView(page, '[data-tile="automations"]', 160);
      const head = await box(page, '[data-tile="automations"] .ws-tile-head h2');
      const from = { x: head.x + 30, y: head.y + head.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x, from.y + 3 * ROW, { steps: 12 });
      const held = await page.evaluate(() => Number(document.querySelector('.ws-tile-ph.ws-on')?.style.getPropertyValue('--y')));
      assert(held === was.y + 3, `the placeholder is at row ${held}, not ${was.y + 3}`);
      await page.mouse.up();
      // Drawn again from the grid right after the drop (a rendered tile's style has no spaces),
      // not left where it was let go until the next minute's render.
      await page.waitForSelector(`[data-tile="automations"][style^="--x:${was.x};--y:${was.y};"]:not(.ws-tile-lifted)`, { timeout: 2000 });
      await settled(page);
      assert((await saves(page)).length === n, 'a drop that changes nothing saved the layout');
      assert(JSON.stringify(await placeOf(page, 'automations')) === JSON.stringify(was), `Automation results drawn at ${JSON.stringify(await placeOf(page, 'automations'))}`);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- E2
  {
    const { page, context, errors } = await open({ width: 1440, height: 900, workspace: { today: DEFAULT_TODAY } });
    await check('layout E2: Schedule pulled by its right and bottom edges shows 3 × 7, 3 × 9 and its agenda', async () => {
      const step = await stepOf(page);
      await intoView(page, '[data-tile="calendar"]', 120);
      const right = await box(page, '[data-tile="calendar"] .ws-rz[data-edge="r"]');
      const at = { x: right.x + right.width / 2, y: right.y + right.height / 2 };
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x - 3 * step, at.y, { steps: 12 });
      const wide = await page.locator('[data-tile="calendar"] .ws-tile-badge').innerText();
      assert(/^3 × 7(?!\d)/.test(wide), `badge ${wide}`);
      await shot(page, 'layout-e2-width');
      await page.mouse.up();
      await savedAfter(page, 0);
      await page.waitForSelector('[data-tile="calendar"][style*="--w:3;--h:7"]');
      await settled(page);
      // The bottom edge, half way down the window.
      await intoView(page, '[data-tile="calendar"] .ws-rz[data-edge="b"]', 420);
      const edge = await box(page, '[data-tile="calendar"] .ws-rz[data-edge="b"]');
      const low = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
      await page.mouse.move(low.x, low.y);
      await page.mouse.down();
      await page.mouse.move(low.x, low.y + 2 * ROW, { steps: 12 });
      const tall = await page.locator('[data-tile="calendar"] .ws-tile-badge').innerText();
      assert(/^3 × 9(?!\d)/.test(tall), `badge ${tall}`);
      await page.mouse.up();
      await savedAfter(page, 1);
      const saved = itemOf(await lastSave(page), 'calendar');
      assert(saved.w === 3 && saved.h === 9, `saved Schedule ${JSON.stringify(saved)}`);
      // Narrower than 300 px, the timeline gives way to the agenda.
      await page.waitForSelector('[data-tile="calendar"][style*="--w:3;--h:9"] .ws-tl-agenda', { state: 'visible' });
      const width = (await box(page, '[data-tile="calendar"]')).width;
      assert(width < 300, `Schedule is ${width}px wide`);
      assert(!(await page.locator('[data-tile="calendar"] .ws-timeline').isVisible()), 'the timeline still shows');
      await shot(page, 'layout-e2-agenda');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- E3
  {
    const { page, context, errors } = await open({ width: 1440, height: 900, workspace: { today: DEFAULT_TODAY } });
    await check('layout E3: Customize: Focus timer dragged in from the gallery, a widget removed and back with Undo, Done', async () => {
      await openTodayMenu(page);
      await page.click('.ws-today-actions details[data-menu="today-more"] [data-action="today-customize"]:has-text("Customize")');
      await page.waitForSelector('.ws-today-editbar:has-text("Customizing Today")');
      assert(await page.locator(`.ws-gallery-group:text-is("On Today · ${PRESETS.Default.length}")`).count() === 1, 'the gallery counts the Default widgets');
      await page.evaluate(() => { document.getElementById('workspace-main').scrollTop = 0; });
      const step = await stepOf(page);
      const grid = await box(page, '[data-today-grid]');
      assert(await page.locator('.ws-gallery-group:text-is("Add to Today") ~ .ws-gallery-card[data-gid="timer"]:not(.ws-gallery-on)').count() === 1, 'Focus timer is not in Add to Today');
      const card = await box(page, '.ws-gallery-card[data-gid="timer"]:not(.ws-gallery-on) .ws-gallery-thumb');
      // Dropped where its top left lands on row 0, column 0 (the card is held by its middle).
      const target = { x: grid.x + (4 * step - GAP) / 2, y: grid.y + 24 };
      await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 12 });
      await page.waitForSelector('.ws-tile-ph.ws-on');
      await page.mouse.up();
      await savedAfter(page, 0);
      await page.waitForSelector('.ws-toast:has-text("Focus timer added to Today")');
      const saved = await lastSave(page);
      const timer = itemOf(saved, 'timer');
      assert(timer.x === 0 && timer.y === 0, `Focus timer at ${JSON.stringify(timer)}`);
      const brief = itemOf(saved, 'brief');
      assert(brief.x === 4 && brief.y === 0, `Up next slid aside to ${JSON.stringify(brief)}`);
      const others = saved.today.items.filter(i => i.id !== 'timer' && i.id !== 'brief');
      const was = Object.fromEntries(PRESETS.Default.map(i => [i.id, i]));
      assert(others.every(i => i.y >= was[i.id].y) && others.some(i => i.y > was[i.id].y), `the others: ${JSON.stringify(others)}`);
      assert(!overlaps(saved.today.items), `widgets overlap: ${JSON.stringify(saved.today.items)}`);
      await page.waitForSelector('[data-tile="timer"][style^="--x:0;--y:0;"]');
      // × on Automation results, then Undo in its toast.
      const before = (await saves(page)).length;
      await page.click('[data-tile="automations"] .ws-tile-remove');
      await page.waitForSelector('[data-tile="automations"]', { state: 'detached' });
      await page.click('.ws-toast:has-text("Automation results removed from Today") .ws-toast-action:has-text("Undo")');
      await page.waitForSelector('[data-tile="automations"]');
      await savedAfter(page, before + 1);
      assert(itemOf(await lastSave(page), 'automations'), 'Automation results is not saved back');
      const onToday = PRESETS.Default.length + 1;
      await page.waitForSelector(`.ws-gallery-group:text-is("On Today · ${onToday}")`);
      assert(await page.locator(`.ws-gallery-group:text-is("On Today · ${onToday}") ~ .ws-gallery-on[data-gid="timer"]`).count() === 1, 'Focus timer is not listed On Today');
      await shot(page, 'layout-e3-customize');
      await page.click('.ws-today-editbar [data-action="today-done"]');
      await page.waitForSelector('.ws-today-editing', { state: 'detached' });
      await page.waitForSelector('.ws-toast > span:text-is("Today is saved — every change is kept as you make it")');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- E4
  {
    const { page, context, errors } = await open({ width: 1440, height: 900, workspace: { today: DEFAULT_TODAY } });
    await check('layout E4: the widget menu sizes and collapses Tasks, options change Needs your reply, a title is renamed, all kept', async () => {
      const tasksMenu = '[data-tile="commitments"] .ws-tile-menu';
      await page.click(`${tasksMenu} > summary`);
      await page.click(`${tasksMenu} [data-action="today-width"][data-w="6"]`);
      await savedAfter(page, 0);
      assert(itemOf(await lastSave(page), 'commitments').w === 6, 'Tasks is not half wide');
      await page.waitForSelector('[data-tile="commitments"][style*="--w:6;"]');
      await page.click(`${tasksMenu} > summary`);
      await page.click(`${tasksMenu} [data-action="today-collapse"]`);
      await savedAfter(page, 1);
      const tasks = itemOf(await lastSave(page), 'commitments');
      assert(tasks.collapsed === true && tasks.h === 1 && tasks.w === 6, `Tasks saved ${JSON.stringify(tasks)}`);
      await page.waitForSelector('[data-tile="commitments"].ws-tile-collapsed');
      const folded = async () => page.evaluate(() => {
        const el = document.querySelector('[data-tile="commitments"]');
        const body = el.querySelector('.ws-tile-body');
        return { height: Math.round(el.getBoundingClientRect().height), body: !!body && getComputedStyle(body).display !== 'none', head: el.querySelector('.ws-tile-head').getBoundingClientRect().height > 0 };
      });
      let shape = await folded();
      assert(shape.height === 56 && !shape.body && shape.head, `Tasks collapsed: ${JSON.stringify(shape)}`);
      // The sliders: Messages shown 3, applied with the panel still open.
      assert(await page.locator('[data-tile="inbox"] .ws-msg-row').count() > 3, 'fewer than four replies to start with');
      await page.click('[data-tile="inbox"] [data-action="today-options"]');
      await page.waitForSelector('.ws-today-options select[name="opt-max"]');
      await page.selectOption('.ws-today-options select[name="opt-max"]', '3');
      await savedAfter(page, 2);
      assert((await lastSave(page)).today.options.inbox?.max === '3', 'Messages shown is not saved');
      await page.waitForFunction(() => document.querySelectorAll('[data-tile="inbox"] .ws-msg-row').length === 3);
      assert(await page.locator('.ws-today-options[aria-label="Customize Needs your reply"]').count() === 1, 'the panel closed');
      await shot(page, 'layout-e4-options');
      await page.click('.ws-today-options-foot [data-action="today-options"]');
      await page.waitForSelector('.ws-today-options', { state: 'detached' });
      // A double-click on the title renames it; Enter keeps the name.
      await page.dblclick('[data-tile="calendar"] .ws-tile-head h2');
      await page.waitForSelector('.ws-tile-rename');
      await page.keyboard.type('My day');
      await page.keyboard.press('Enter');
      await savedAfter(page, 3);
      assert((await lastSave(page)).today.titles.calendar === 'My day', 'the title is not saved');
      await page.waitForSelector('[data-tile="calendar"] .ws-tile-head h2:text-is("My day")');
      await page.reload();
      await page.waitForSelector('[data-tile="calendar"] .ws-tile-head h2:text-is("My day")');
      await page.waitForSelector('[data-tile="commitments"].ws-tile-collapsed[style*="--w:6;--h:1"]');
      shape = await folded();
      assert(shape.height === 56 && !shape.body, `after reload Tasks is ${JSON.stringify(shape)}`);
      assert(await page.locator('[data-tile="inbox"] .ws-msg-row').count() === 3, 'after reload the reply list is not 3 rows');
      await shot(page, 'layout-e4-reloaded');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- E5
  // (a) The fixture's workspace, never customized (`widgetWidths {}`, no `today`).
  const never = await open({ width: 1440, height: 900 });
  await check('layout E5: older layouts: never customized opens on Default, customized becomes “My layout”; Focus keeps its move until Reset', async () => {
    {
      const { page, context, errors } = never;
      await page.waitForSelector('[data-today-grid]');
      await settled(page);
      assert(sameAs(await tilesNow(page), PRESETS.Default), `tiles ${JSON.stringify(await tilesNow(page))}`);
      assert((await activeLayoutName(page)).includes('Default'), 'the layout in use is not Default');
      assert((await saves(page)).length === 0, 'opening Today saved the layout');
      await shot(page, 'layout-e5-default');
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
    }
    // (b) A customized layout from before the grid.
    const legacy = { layout: ['brief', 'commitments', 'inbox'], widgetWidths: { brief: 8, commitments: 8, inbox: 6, meetings: 6 }, today: {} };
    const { page, context, errors } = await open({ width: 1440, height: 900, meetings: true, workspace: legacy });
    {
      await page.waitForSelector('[data-today-grid]');
      await settled(page);
      // The old rows filled left to right at the old order and widths (Tasks 8 with Notes 4 after
      // it, then Needs your reply 6), then packed upward like every layout (Ruling R11).
      const mine = compact([{ id: 'brief', x: 0, y: 0, w: 8, h: 4 }, { id: 'commitments', x: 0, y: 4, w: 8, h: 6 }, { id: 'notes', x: 8, y: 4, w: 4, h: 6 }, { id: 'inbox', x: 0, y: 10, w: 6, h: 7 }]);
      const opened = await tilesNow(page);
      assert(sameAs(opened, mine), `My layout drawn as ${JSON.stringify(opened)}`);
      assert((await activeLayoutName(page)).includes('My layout'), 'the layout in use is not My layout');
      assert(await page.locator('[data-tile="meetings"]').count() === 0, 'From your meetings shows although it was hidden');
      assert((await saves(page)).length === 0, 'opening Today saved the layout');
      await shot(page, 'layout-e5-my-layout');
      // Focus: the switch's save keeps "My layout" exactly as it opened.
      await layoutMenu(page, '[data-action="today-layout-use"][data-name="Focus"]');
      await page.waitForSelector('.ws-toast:has-text("Switched to “Focus”")');
      await page.waitForSelector('[data-tile="timer"]');
      assert(sameAs(await tilesNow(page), PRESETS.Focus), `Focus drawn as ${JSON.stringify(await tilesNow(page))}`);
      const switched = await lastSave(page);
      assert(switched.today.active === 'Focus' && sameAs(opened, switched.today.layouts['My layout']), `the switch saved My layout as ${JSON.stringify(switched.today.layouts['My layout'])}`);
      // Focus timer moved onto Up next's place.
      const n = (await saves(page)).length;
      await page.evaluate(() => { document.getElementById('workspace-main').scrollTop = 0; });
      const head = await box(page, '[data-tile="timer"] .ws-tile-head h2');
      const brief = await box(page, '[data-tile="brief"]');
      const from = { x: head.x + 30, y: head.y + head.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(brief.x + 2, from.y, { steps: 12 });
      await page.mouse.up();
      await savedAfter(page, n);
      await page.waitForSelector('[data-tile="timer"][style^="--x:0;--y:0;"]');
      const moved = await tilesNow(page);
      // Back to My layout: as it opened, and Focus says it changed.
      await layoutMenu(page, '[data-action="today-layout-use"][data-name="My layout"]');
      await page.waitForSelector('.ws-toast:has-text("Switched to “My layout”")');
      await page.waitForSelector('[data-today-grid]:not(:has([data-tile="timer"]))');
      const back = await tilesNow(page);
      assert(JSON.stringify(back) === JSON.stringify(opened), `My layout came back as ${JSON.stringify(back)}, opened as ${JSON.stringify(opened)}`);
      const pill = '.ws-today-actions details[data-menu="today-more"]';
      await page.click(`${pill} > summary`);
      await page.waitForSelector(`${pill}[open]`);
      assert(await page.locator('[data-action="today-layout-use"][data-name="Focus"] .ws-today-changed').count() === 1, 'Focus is not marked changed');
      await page.click(`${pill} > summary`);
      await page.waitForSelector(`${pill}:not([open])`);
      // Focus again: the move is still there, until Reset “Focus”.
      await layoutMenu(page, '[data-action="today-layout-use"][data-name="Focus"]');
      await page.waitForSelector('[data-tile="timer"][style^="--x:0;--y:0;"]');
      const kept = await tilesNow(page);
      assert(JSON.stringify(kept) === JSON.stringify(moved), `Focus lost its move: ${JSON.stringify(kept)}`);
      await shot(page, 'layout-e5-focus-moved');
      await layoutMenu(page, '[data-action="today-layout-reset"]:has-text("Reset “Focus” to the original")');
      await page.waitForSelector('.ws-toast:has-text("“Focus” is back to the original")');
      await page.waitForSelector('[data-tile="timer"][style^="--x:8;--y:0;"]');
      assert(sameAs(await tilesNow(page), PRESETS.Focus), `Focus after Reset ${JSON.stringify(await tilesNow(page))}`);
      const reset = (await lastSave(page)).today;
      assert(reset.active === 'Focus' && sameAs(Object.fromEntries(reset.items.map(i => [i.id, i])), PRESETS.Focus), `saved after Reset ${JSON.stringify(reset.items)}`);
      await shot(page, 'layout-e5-focus-reset');
      assert(errors.length === 0, errors.join(' | '));
    }
    await context.close().catch(() => {});
  });

  // ---------------------------------------------------------------- E6
  {
    const { page, context, errors } = await open({ width: 1440, height: 900, workspace: { today: DEFAULT_TODAY } });
    await check('layout E6: locked nothing moves; keys move, resize, remove and undo, said aloud; a touch long press moves Notes', async () => {
      // Locked: dragging Up next by its header moves nothing and offers Unlock.
      await openTodayMenu(page);
      await page.click('.ws-today-actions [data-action="today-lock"]');
      await page.waitForSelector('.ws-today-actions [data-action="today-lock"][aria-pressed="true"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ws-today-actions details[data-menu="today-more"]:not([open])');
      await page.evaluate(() => { document.getElementById('workspace-main').scrollTop = 0; });
      const head = await box(page, '[data-tile="brief"] .ws-tile-head h2');
      const from = { x: head.x + 30, y: head.y + head.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 300, from.y + 200, { steps: 12 });
      const holding = { lifted: await page.locator('.ws-tile-lifted').count(), tiles: await tilesNow(page) };
      await page.mouse.up();
      await page.waitForSelector('.ws-toast:has-text("Layouts are locked") .ws-toast-action:text-is("Unlock")');
      assert(holding.lifted === 0 && sameAs(holding.tiles, PRESETS.Default), `a widget moved while locked: ${JSON.stringify(holding)}`);
      assert(sameAs(await tilesNow(page), PRESETS.Default), 'the grid changed while locked');
      assert((await saves(page)).length === 0, 'a locked drag saved the layout');
      await page.click('.ws-toast:has-text("Layouts are locked") .ws-toast-action');
      await page.waitForSelector('.ws-today-actions [data-action="today-lock"][aria-pressed="false"]', { state: 'attached' });
      await shot(page, 'layout-e6-unlocked');
      // Keyboard: Tab reaches Schedule's grip.
      await page.focus('[data-tile="focus"] .ws-tile-grip');
      for (let i = 0; i < 40 && !(await page.evaluate(() => document.activeElement?.matches('[data-grip="calendar"]'))); i++) await page.keyboard.press('Tab');
      assert(await page.evaluate(() => document.activeElement?.matches('[data-grip="calendar"]')), 'Tab never reached the Schedule grip');
      const start = await placeOf(page, 'calendar');
      await page.keyboard.press('ArrowRight');
      await savedAfter(page, 0);
      await live(page, `Schedule moved to column ${start.x + 2}, row ${start.y + 1}`);
      assert(itemOf(await lastSave(page), 'calendar').x === start.x + 1, 'x + 1 is not saved');
      await page.waitForFunction(() => document.activeElement?.matches('[data-grip="calendar"]'));
      await page.keyboard.press('Shift+ArrowDown');
      await savedAfter(page, 1);
      await live(page, `Schedule is ${start.w} columns by ${start.h + 1} rows`);
      const grown = itemOf(await lastSave(page), 'calendar');
      assert(grown.h === start.h + 1 && grown.x === start.x + 1, `h + 1 is not saved: ${JSON.stringify(grown)}`);
      await page.waitForFunction(() => document.activeElement?.matches('[data-grip="calendar"]'));
      await page.keyboard.press('Delete');
      await savedAfter(page, 2);
      assert(!itemOf(await lastSave(page), 'calendar'), 'Schedule is still saved');
      await page.waitForSelector('[data-tile="calendar"]', { state: 'detached' });
      await page.waitForSelector('.ws-toasts[aria-live="polite"] .ws-toast:has-text("Schedule removed from Today")');
      await page.keyboard.press('ControlOrMeta+z');
      await savedAfter(page, 3);
      await page.waitForSelector('[data-tile="calendar"]');
      const back = itemOf(await lastSave(page), 'calendar');
      assert(back && back.x === grown.x && back.h === grown.h, `Schedule restored as ${JSON.stringify(back)}`);
      await live(page, 'Layout change undone');
      await shot(page, 'layout-e6-keyboard');
      // A finger held 400 ms on Notes' header, then moved onto Tasks' left edge: Notes lands at
      // column 0 (Tasks slides aside), then floats up as the drop packs the grid.
      const was = await placeOf(page, 'notes');
      await intoView(page, '[data-tile="notes"]', 300);
      const notes = await box(page, '[data-tile="notes"] .ws-tile-head h2');
      const tasks = await box(page, '[data-tile="commitments"]');
      const press = { x: notes.x + 30, y: notes.y + notes.height / 2 };
      const drop = { x: tasks.x + 2, y: press.y };
      const n = (await saves(page)).length;
      await pointer(page, 'pointerdown', press, 'touch');
      await page.waitForTimeout(400);
      await pointer(page, 'pointermove', drop, 'touch');
      await pointer(page, 'pointerup', drop, 'touch');
      await savedAfter(page, n);
      const swapped = await lastSave(page);
      const [nt, ct] = [itemOf(swapped, 'notes'), itemOf(swapped, 'commitments')];
      assert(was.x === 8 && nt.x === 0 && ct.x === 4, `after the long press Notes ${JSON.stringify(was)} → ${JSON.stringify(nt)}, Tasks ${JSON.stringify(ct)}`);
      await page.waitForSelector('[data-tile="notes"][style^="--x:0;"]');
      await shot(page, 'layout-e6-touch');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- E7
  {
    const { page, context, errors } = await open({ width: 1440, height: 900, hash: '#/meetings/mtg-philips/notes', meetings: true, workspace: { today: DEFAULT_TODAY } });
    await check('layout E7: page sections: Transcript beside Notes, dividers, a rail, kept and Reset; Calendar and Inbox', async () => {
      const dock = '.ws-dock[data-page="meetings"]';
      await page.waitForSelector(`${dock} .ws-mtg-detail[data-panel="notes"] .ws-md h3`);
      // Transcript dragged onto the right 30% of the Notes section opens beside it.
      const tab = await box(page, '.ws-dock-tab[data-tab="mtg-transcript"]');
      const notes = await box(page, `${dock} > .ws-pane:has(.ws-dock-tab[data-tab="mtg-notes"]) > .ws-pane-body`);
      await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
      await page.mouse.down();
      await page.mouse.move(notes.x + notes.width * 0.85, notes.y + notes.height / 2, { steps: 12 });
      await page.waitForSelector(`${dock} .ws-dock-zone:not([hidden]):has-text("Open beside Notes")`);
      await page.mouse.up();
      await page.waitForSelector('.ws-toast:has-text("Transcript opened beside Notes")');
      await page.waitForSelector('.ws-mtg-detail[data-panel="notes"] .ws-md h3');
      await page.waitForSelector('.ws-mtg-detail[data-panel="transcript"] #meeting-line-3');
      const panes = () => page.evaluate(sel => [...document.querySelectorAll(`${sel} > .ws-pane`)].map(p => ({ tabs: [...p.querySelectorAll('.ws-dock-tab, .ws-pane-rail-tab')].map(t => t.dataset.tab), width: Math.round(p.getBoundingClientRect().width), collapsed: p.classList.contains('ws-pane-collapsed') })), dock);
      let row = await panes();
      assert(row.length === 3 && row[1].tabs.includes('mtg-notes') && row[2].tabs.join() === 'mtg-transcript', `sections ${JSON.stringify(row)}`);
      const header = await page.evaluate(sel => {
        const heads = [...document.querySelectorAll(`${sel} .ws-mtg-head`)];
        const pane = heads[0]?.closest('.ws-pane');
        return { count: heads.length, onNotes: !!pane?.querySelector('.ws-dock-tab[data-tab="mtg-notes"]'), above: !!pane && heads[0].getBoundingClientRect().bottom <= pane.querySelector(':scope > .ws-pane-strip').getBoundingClientRect().top + 1 };
      }, dock);
      assert(header.count === 1 && header.onNotes && header.above, `the meeting header: ${JSON.stringify(header)}`);
      await shot(page, 'layout-e7-beside');
      // The new divider pulled 120 px: Notes wider, Transcript narrower.
      const split = async i => { const b = await box(page, `${dock} > .ws-split[data-split="${i}"]`); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
      let s = await split(1);
      await page.mouse.move(s.x, s.y);
      await page.mouse.down();
      await page.mouse.move(s.x + 120, s.y, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(([sel, w]) => Math.round(document.querySelector(`${sel} > .ws-pane:nth-of-type(2)`).getBoundingClientRect().width) > w, [dock, row[1].width]);
      const pulled = await panes();
      assert(pulled[1].width > row[1].width && pulled[2].width < row[2].width && Math.abs(pulled[1].width + pulled[2].width - row[1].width - row[2].width) <= 2, `widths ${JSON.stringify(row)} → ${JSON.stringify(pulled)}`);
      // The list's divider pulled far left: the list becomes a 42 px rail.
      s = await split(0);
      await page.mouse.move(s.x, s.y);
      await page.mouse.down();
      await page.mouse.move(s.x - 400, s.y, { steps: 12 });
      await page.mouse.up();
      await page.waitForSelector('.ws-toast:has-text("Meetings collapsed to a rail")');
      row = await panes();
      assert(row[0].collapsed && row[0].width === 42, `the list: ${JSON.stringify(row[0])}`);
      // In the Transcript section, about 320 px now, the "speaker without a name" card keeps its
      // name and "Who is it?" control inside it.
      const speakers = await page.evaluate(sel => {
        const pane = document.querySelector(`${sel} > .ws-pane:has(.ws-dock-tab[data-tab="mtg-transcript"])`);
        const card = pane.querySelector('.ws-mtg-speakers-banner').getBoundingClientRect();
        const parts = [...pane.querySelectorAll('.ws-mtg-speakers-banner .ws-mtg-speaker-map :is(label, label > span, .ws-select-wrap)')];
        const out = parts.map(el => [el.tagName, el.getBoundingClientRect()]).filter(([, r]) => r.left < card.left + 1 || r.right > card.right - 1).map(([tag, r]) => `${tag} ${Math.round(r.left)}–${Math.round(r.right)}`);
        return { pane: Math.round(pane.getBoundingClientRect().width), card: `${Math.round(card.left)}–${Math.round(card.right)}`, parts: parts.length, out };
      }, dock);
      assert(speakers.pane <= 340 && speakers.parts > 0 && !speakers.out.length, `the speaker card in the Transcript section: ${JSON.stringify(speakers)}`);
      await shot(page, 'layout-e7-rail');
      const stored = await page.evaluate(() => localStorage.getItem('codemie.layout.meetings.v1'));
      // Kept after a reload, then Reset brings the page back with a toast.
      await page.reload();
      await page.waitForSelector(`${dock} .ws-mtg-detail[data-panel="transcript"] #meeting-line-3`);
      const reloaded = await panes();
      assert(JSON.stringify(reloaded) === JSON.stringify(row), `after reload ${JSON.stringify(reloaded)} (before ${JSON.stringify(row)})`);
      assert(await page.evaluate(() => localStorage.getItem('codemie.layout.meetings.v1')) === stored, 'the stored layout changed on reload');
      const menu = `${dock} > .ws-pane:has(.ws-dock-tab[data-tab="mtg-notes"]) .ws-dock-menu`;
      await page.click(`${menu} > summary`);
      await page.click(`${menu} [data-action="dock-reset"]`);
      await page.waitForSelector('.ws-toast:has-text("Meetings is back to its original layout")');
      row = await panes();
      assert(row.length === 2 && !row[0].collapsed && row[0].tabs.join() === 'mtg-list' && row[1].tabs.length === 4, `after Reset ${JSON.stringify(row)}`);
      // Calendar at 1000 px: the Calendars section is at its 220 px minimum, and its ⋯ menu stays
      // inside it (the section clips what sticks out).
      await page.click('.ws-nav button[data-route=calendar]');
      const calSplit = '.ws-dock[data-page="calendar"] > .ws-split[data-split="0"]';
      await page.waitForSelector(calSplit);
      await page.setViewportSize({ width: 1000, height: 900 });
      const sideMenu = '.ws-dock[data-page="calendar"] > .ws-pane:has(.ws-dock-tab[data-tab="cal-side"]) .ws-dock-menu';
      await page.click(`${sideMenu} > summary`);
      await page.waitForSelector(`${sideMenu}[open] .ws-menu-panel`);
      const fit = await page.evaluate(sel => {
        const menu = document.querySelector(`${sel} .ws-menu-panel`).getBoundingClientRect();
        const pane = document.querySelector(sel).closest('.ws-pane').getBoundingClientRect();
        const shown = [...document.querySelectorAll(`${sel} .ws-menu-item:not([hidden])`)];
        const items = shown.map(el => el.getBoundingClientRect());
        // A label too long for the section wraps; none is cut.
        const cut = shown.map(el => el.querySelector('span')).filter(s => s.scrollWidth > s.clientWidth + 1 || s.scrollHeight > s.clientHeight + 1).map(s => s.textContent);
        return { pane: [Math.round(pane.left), Math.round(pane.right)], menu: [Math.round(menu.left), Math.round(menu.right)], cut, inside: menu.left >= pane.left && menu.right <= pane.right && items.every(r => r.left >= menu.left && r.right <= menu.right) };
      }, sideMenu);
      assert(fit.pane[1] - fit.pane[0] <= 222 && fit.inside && !fit.cut.length, `the Calendars menu at 1000 px: ${JSON.stringify(fit)}`);
      await shot(page, 'layout-e7-calendar-menu-1000');
      await page.click(`${sideMenu} > summary`);
      await page.waitForSelector(`${sideMenu}:not([open])`);
      await page.setViewportSize({ width: 1440, height: 900 });
      const week = await page.locator('.ws-cal-title').innerText();
      const value = Number(await page.getAttribute(calSplit, 'aria-valuenow'));
      await page.focus(calSplit);
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(([sel, v]) => Number(document.querySelector(sel)?.getAttribute('aria-valuenow')) < v, [calSplit, value]);
      assert(await page.locator('.ws-cal-title').innerText() === week, 'the week changed');
      await shot(page, 'layout-e7-calendar');
      // Inbox: ⋯ → Move section left on Message.
      await page.click('.ws-nav button[data-route=inbox]');
      const reader = '.ws-dock[data-page="inbox"] > .ws-pane:has(.ws-dock-tab[data-tab="inbox-reader"]) .ws-dock-menu';
      await page.waitForSelector(reader);
      await page.click(`${reader} > summary`);
      await page.click(`${reader} [data-action="dock-move"][data-dir="-1"]`);
      await page.waitForFunction(() => document.querySelector('.ws-dock[data-page="inbox"] > .ws-pane')?.querySelector('.ws-dock-tab[data-tab="inbox-reader"]'));
      const order = await page.evaluate(() => [...document.querySelectorAll('.ws-dock[data-page="inbox"] > .ws-pane .ws-dock-tab')].map(t => `${t.dataset.tab}:${t.textContent.trim()}`));
      assert(order.join() === 'inbox-reader:Message,inbox-list:Messages', `Inbox sections ${order}`);
      await shot(page, 'layout-e7-inbox');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- E8
  const menus = await open({ width: 1440, height: 900, workspace: { today: DEFAULT_TODAY } });
  await check('layout E8: Settings groups fold, Find a setting, both menus shrink to rails, Today stacks at 600 px, nothing overflows', async () => {
    {
      const { page, context, errors } = menus;
      await page.click('.ws-nav button[data-route=settings]');
      await page.click('.ws-settings-nav button[data-tab="layout"]');
      await page.waitForSelector('.ws-settings-header h2:text-is("Layout")');
      const group = name => `.ws-settings-nav button.ws-nav-group[data-group="${name}"]`;
      const items = name => page.evaluate(sel => [...document.querySelector(sel).closest('.ws-nav-section').querySelectorAll('.ws-nav-items button[data-tab]')].map(b => b.dataset.tab), group(name));
      // Workspace folds: its count, and Layout (the page open) stays.
      await page.click(group('Workspace'));
      await page.waitForSelector(`${group('Workspace')}[aria-expanded="false"]`);
      const workspace = SETTINGS_GROUPS.find(g => g.name === 'Workspace').items.length;
      assert(await page.locator(`${group('Workspace')} .ws-count`).innerText() === String(workspace), `the Workspace count is not ${workspace}`);
      assert((await items('Workspace')).join() === 'layout', `folded Workspace shows ${await items('Workspace')}`);
      // ⌥-click CodeMie: only CodeMie stays open (and Layout, the page open).
      await page.click(group('CodeMie'), { modifiers: ['Alt'] });
      await page.waitForSelector(`${group('CodeMie')}[aria-expanded="true"]`);
      const groups = async () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.ws-settings-nav button.ws-nav-group')].map(b => [b.dataset.group, b.getAttribute('aria-expanded')])));
      const only = JSON.stringify(Object.fromEntries(SETTINGS_GROUPS.map(g => [g.name, String(g.name === 'CodeMie')])));
      assert(JSON.stringify(await groups()) === only, `groups ${JSON.stringify(await groups())}`);
      const codemie = SETTINGS_GROUPS.find(g => g.name === 'CodeMie').items.map(([id]) => id);
      assert((await items('CodeMie')).join() === codemie.join() && (await items('Workspace')).join() === 'layout' && !(await items('Meetings')).length && !(await items('Application')).length, 'the other groups are not folded');
      await shot(page, 'layout-e8-settings-folded');
      // Find a setting ignores folding while it holds text.
      await page.locator('[data-settings-find]').pressSequentially('temp');
      await page.waitForFunction(() => [...document.querySelectorAll('.ws-settings-nav button[data-tab]')].map(b => b.dataset.tab).join() === 'meetings-templates');
      assert(await page.locator('.ws-settings-nav button[data-tab="meetings-templates"]:has-text("Note templates")').isVisible(), 'Note templates is not shown');
      await shot(page, 'layout-e8-find');
      await page.fill('[data-settings-find]', '');
      await page.waitForFunction(() => document.querySelectorAll('.ws-settings-nav button.ws-nav-group:not([disabled])').length > 0);
      assert(JSON.stringify(await groups()) === only, `after clearing, groups ${JSON.stringify(await groups())}`);
      // The Settings menu shrinks to its 58 px rail, with tooltips.
      await page.click('.ws-settings-heading [data-action="settings-menu-toggle"]');
      await page.waitForSelector('.ws-settings-sidebar.ws-settings-rail');
      const rail = await page.evaluate(() => ({ width: Math.round(document.querySelector('.ws-settings-sidebar').getBoundingClientRect().width), tips: [...document.querySelectorAll('.ws-settings-nav button[data-tab]')].every(b => b.dataset.tip) }));
      assert(rail.width === 58 && rail.tips, `the Settings rail: ${JSON.stringify(rail)}`);
      await page.hover('.ws-settings-nav button[data-tab="layout"]');
      await page.waitForSelector('.ws-tooltip:text-is("Layout")');
      // ⌘\ collapses the main menu to its 64 px rail, with tooltips.
      await page.keyboard.press('ControlOrMeta+Backslash');
      await page.waitForSelector('.ws-sidebar.ws-sidebar-rail');
      assert(Math.round((await box(page, '.ws-sidebar')).width) === 64, 'the main menu is not a 64 px rail');
      await page.hover('.ws-sidebar .ws-nav button[data-route=meetings]');
      await page.waitForSelector('.ws-tooltip:text-is("Meetings")');
      await noOverflow(page, 'Settings with both rails');
      await shot(page, 'layout-e8-rails');
      // 600 px on Today: one column, no grips, nothing saved.
      await page.click('.ws-sidebar .ws-nav button[data-route=today]');
      await page.waitForSelector('[data-today-grid]');
      await page.setViewportSize({ width: 600, height: 900 });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-today-grid]')).display === 'flex');
      const stack = await page.evaluate(() => {
        const tiles = [...document.querySelectorAll('[data-today-grid] > [data-tile]')].map(el => el.getBoundingClientRect());
        return { lefts: new Set(tiles.map(r => Math.round(r.left))).size, widths: new Set(tiles.map(r => Math.round(r.width))).size, down: tiles.every((r, i) => !i || r.top >= tiles[i - 1].bottom), grips: [...document.querySelectorAll('.ws-tile-grip')].filter(g => getComputedStyle(g).display !== 'none').length };
      });
      assert(stack.lefts === 1 && stack.widths === 1 && stack.down, `Today at 600 px is not one column: ${JSON.stringify(stack)}`);
      assert(stack.grips === 0, `${stack.grips} grips show at 600 px`);
      await noOverflow(page, 'Today at 600 px');
      await shot(page, 'layout-e8-today-600');
      assert((await saves(page)).length === 0, 'the narrow page saved the layout');
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
    }
    // Today, Meetings and Settings at 1000, 1440 and 1680 px in both themes, with the menus as
    // they start: no sideways overflow (a section row scrolls inside itself).
    const ready = { today: '[data-today-grid]', meetings: '.ws-dock[data-page="meetings"] .ws-pane-body', settings: '.ws-settings-layout' };
    for (const theme of ['dark', 'light']) {
      const { page, context, errors } = await open({ theme, width: 1000, height: 900, meetings: true, workspace: { today: DEFAULT_TODAY } });
      for (const width of [1000, 1440, 1680]) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of ['today', 'meetings', 'settings']) {
          await page.click(`.ws-sidebar .ws-nav button[data-route=${route}]`);
          await page.waitForSelector(ready[route]);
          await settled(page);
          await noOverflow(page, `${theme} ${route} at ${width} px`);
          await shot(page, `layout-${theme}-${route}-${width}`);
        }
      }
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
    }
  });
  // ---------------------------------------------------------------- E9: the main menu's groups
  for (const theme of ['dark', 'light']) {
    const { page, context, errors } = await open({ theme, width: 1440, height: 900, meetings: true, tasks: true, hash: '#/tasks' });
    await check(`layout E9 (${theme}): the main menu folds Work and AI, adds up what a fold hides, keeps the page open and the fold, and draws the rail`, async () => {
      const head = id => `.ws-sidebar .ws-nav-head[data-group="${id}"]`;
      const routes = () => page.evaluate(() => [...document.querySelectorAll('.ws-main-nav [data-route]')].map(b => b.dataset.route).join());
      assert(await routes() === 'today,inbox,calendar,meetings,tasks,automations,analytics', `the menu: ${await routes()}`);
      // 30 px rows under 20 px labels, Settings beside the account, and nothing to scroll.
      const sizes = await page.evaluate(() => {
        const r = sel => document.querySelector(sel).getBoundingClientRect();
        const nav = document.querySelector('.ws-main-nav');
        return { row: Math.round(r('.ws-main-nav [data-route=today]').height), head: Math.round(r('.ws-nav-head[data-group=work]').height), scrolls: nav.scrollHeight > nav.clientHeight, oneRow: Math.abs((r('.ws-nav-gear').top + r('.ws-nav-gear').bottom) / 2 - (r('.ws-user').top + r('.ws-user').bottom) / 2) < 2 };
      });
      assert(sizes.row === 30 && sizes.head === 20 && !sizes.scrolls && sizes.oneRow, `the menu's sizes: ${JSON.stringify(sizes)}`);
      await shot(page, `layout-e9-${theme}-menu`);
      // Work folds while Tasks is open: Tasks stays, the label adds up Inbox's and Meetings' counts.
      const hidden = await page.evaluate(() => ['inbox', 'meetings'].reduce((n, id) => n + Number(document.querySelector(`.ws-main-nav [data-route=${id}] .ws-count`)?.textContent || 0), 0));
      assert(hidden > 0, 'the fixture has nothing to add up');
      await page.click(head('work'));
      await page.waitForSelector(`${head('work')}[aria-expanded="false"]`);
      await live(page, 'Work folded');
      assert(await routes() === 'today,tasks,automations,analytics', `folded Work shows ${await routes()}`);
      assert(await page.locator(`${head('work')} .ws-count`).innerText() === String(hidden), `the Work label doesn't say ${hidden}`);
      await shot(page, `layout-e9-${theme}-work-folded`);
      // The fold is kept: a reload draws it folded.
      await page.reload();
      await page.waitForSelector(`${head('work')}[aria-expanded="false"]`);
      // AI folds from the keyboard, and focus stays on its label.
      await page.focus(head('ai'));
      await page.keyboard.press('Enter');
      await page.waitForSelector(`${head('ai')}[aria-expanded="false"]`);
      assert(await page.evaluate(() => document.activeElement?.dataset.group) === 'ai', 'focus left the AI label');
      assert(await routes() === 'today,tasks', `with both folded the menu shows ${await routes()}`);
      // ⌘\ : the 64 px rail; a folded group is one 40 px icon with its tooltip, and opens on click.
      await page.keyboard.press('ControlOrMeta+Backslash');
      await page.waitForSelector('.ws-sidebar.ws-sidebar-rail');
      assert(Math.round((await box(page, '.ws-sidebar')).width) === 64, 'the main menu is not a 64 px rail');
      const icon = await box(page, head('ai'));
      assert(Math.round(icon.width) === 40, `the folded AI group is ${Math.round(icon.width)} px wide`);
      await page.hover(head('ai'));
      await page.waitForSelector('.ws-tooltip:text-is("AI: Automations, Analytics")');
      await page.hover('.ws-sidebar .ws-nav-gear');
      await page.waitForSelector('.ws-tooltip:text-is("Settings")');
      await shot(page, `layout-e9-${theme}-rail`);
      await page.click(head('ai'));
      await page.waitForSelector(`${head('ai')}[aria-expanded="true"]`);
      assert(await routes() === 'today,tasks,automations,analytics', `after AI opens on the rail: ${await routes()}`);
      // The brand row's toggle (shown over the logo on hover) expands the menu again.
      await page.hover('.ws-sidebar .ws-brand');
      await page.click('.ws-sidebar .ws-brand-toggle');
      await page.waitForSelector('.ws-sidebar:not(.ws-sidebar-rail)');
      await page.click(head('work'));
      await page.waitForSelector(`${head('work')}[aria-expanded="true"]`);
      // At 1000 px the menu is the rail by its width alone: no names, the gear over the avatar.
      await page.setViewportSize({ width: 1000, height: 640 });
      await page.waitForFunction(() => Math.round(document.querySelector('.ws-sidebar').getBoundingClientRect().width) === 64);
      const narrow = await page.evaluate(() => ({
        names: [...document.querySelectorAll('.ws-main-nav button > span:not([class])')].filter(el => el.getClientRects().length).length,
        gearAbove: document.querySelector('.ws-nav-gear').getBoundingClientRect().bottom <= document.querySelector('.ws-user').getBoundingClientRect().top,
      }));
      assert(narrow.names === 0 && narrow.gearAbove, `the menu at 1000 px: ${JSON.stringify(narrow)}`);
      await noOverflow(page, `${theme} Tasks at 1000 px`);
      await shot(page, `layout-e9-${theme}-1000`);
      // The gear opens Settings and is marked current.
      await page.click('.ws-sidebar .ws-nav button[data-route=settings]');
      await page.waitForSelector('.ws-settings-layout');
      assert(await page.locator('.ws-sidebar .ws-nav-gear[aria-current=page]').count() === 1, 'Settings is not current');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
}
