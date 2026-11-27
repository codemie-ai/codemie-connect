// Browser checks of the flexible layout (spec docs/superpowers/specs/2026-11-19-flexible-layout-design.md,
// plan Task 7, E1–E8), run by workspace-e2e.mjs with its MOCKED native bridge: Today's grid moved
// and resized by pen, mouse, touch and keys, Customize and its gallery, the widget menu and options,
// saved layouts and older layouts moving over, the lock, the page sections, the folding Settings
// menu, both menus shrunk to icons, and no horizontal overflow. `layout_save` calls are read from
// the mock (`calls`), and a reload keeps the workspaces (the mock holds them in sessionStorage). It
// proves the window's side, not native storage.
import { PRESETS, compact, todayOf } from '../../workspace/today-grid.js';
import { SETTINGS_GROUPS } from '../../workspace/view-settings.js';
import { askStates, askThread } from '../fixtures/workspace-fixture.mjs';

// The Default layout as todayOf builds it for a workspace never customized.
const DEFAULT_TODAY = todayOf({ widgetWidths: {} }, {});
const GAP = 16;
const ROW = 72;

export async function layoutChecks({ open, check, assert, shot, settled, calls, OUT }) {
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
      await page.click('.ws-today-actions details[data-menu="today-more"] [data-action="today-lock"]');
      await page.waitForSelector('.ws-today-actions [data-action="today-lock"][aria-pressed="true"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ws-today-actions details[data-menu="today-more"]:not([open])');
      // While locked, a lock to undo it shows beside the ⋯.
      await page.waitForSelector('.ws-today-actions > [data-action="today-lock"][aria-pressed="true"]');
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
      assert(await page.locator('.ws-today-actions > [data-action="today-lock"]').count() === 0, 'the unlock button stays after unlocking');
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
    await check('layout E7: page sections: the meeting’s Notes pane, the list resizes and collapses, the strip stays in view, kept and Reset; Calendar and Inbox', async () => {
      const dock = '.ws-dock[data-page="meetings"]';
      await page.waitForSelector(`${dock} .ws-mtg-detail[data-panel="notes"] .ws-md h3`);
      const panes = () => page.evaluate(sel => [...document.querySelectorAll(`${sel} > .ws-pane`)].map(p => ({ tabs: [...p.querySelectorAll('.ws-dock-tab, .ws-pane-rail-tab')].map(t => t.dataset.tab), width: Math.round(p.getBoundingClientRect().width), collapsed: p.classList.contains('ws-pane-collapsed') })), dock);
      let row = await panes();
      assert(row.length === 2 && row[0].tabs.join() === 'mtg-list' && row[1].tabs.join() === 'mtg-meeting', `sections ${JSON.stringify(row)}`);
      // The header and the strip sit at the top of the meeting's section, above its pane.
      const strip = () => page.evaluate(sel => {
        const section = document.querySelector(`${sel} .ws-mtg-meeting-section`);
        const pane = section.closest('.ws-pane').getBoundingClientRect();
        const head = section.querySelector('.ws-mtg-head').getBoundingClientRect();
        const bar = section.querySelector('.ws-mtg-strip').getBoundingClientRect();
        const body = section.querySelector('.ws-mtg-pane').getBoundingClientRect();
        return { top: Math.round(bar.top), inView: head.top >= pane.top && bar.bottom <= body.top + 1 && bar.bottom <= pane.bottom };
      }, dock);
      const before = await strip();
      assert(before.inView, `the strip: ${JSON.stringify(before)}`);
      await shot(page, 'layout-e7-notes-pane');
      // The divider pulled 120 px: the list wider, the meeting narrower.
      const split = async i => { const b = await box(page, `${dock} > .ws-split[data-split="${i}"]`); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
      let s = await split(0);
      await page.mouse.move(s.x, s.y);
      await page.mouse.down();
      await page.mouse.move(s.x + 120, s.y, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(([sel, w]) => Math.round(document.querySelector(`${sel} > .ws-pane`).getBoundingClientRect().width) > w, [dock, row[0].width]);
      const pulled = await panes();
      assert(pulled[0].width > row[0].width && pulled[1].width < row[1].width && Math.abs(pulled[0].width + pulled[1].width - row[0].width - row[1].width) <= 2, `widths ${JSON.stringify(row)} → ${JSON.stringify(pulled)}`);
      // The notes scrolled to their end: the strip stays where it was.
      await page.evaluate(sel => { const pane = document.querySelector(`${sel} .ws-mtg-pane`); pane.scrollTop = pane.scrollHeight; }, dock);
      const scrolled = await strip();
      assert(scrolled.inView && scrolled.top === before.top, `the strip after scrolling: ${JSON.stringify(scrolled)} (before ${JSON.stringify(before)})`);
      // The list's divider pulled far left: the list becomes a 42 px rail.
      s = await split(0);
      await page.mouse.move(s.x, s.y);
      await page.mouse.down();
      await page.mouse.move(s.x - 400, s.y, { steps: 12 });
      await page.mouse.up();
      await page.waitForSelector('.ws-toast:has-text("Meetings collapsed to a rail")');
      row = await panes();
      assert(row[0].collapsed && row[0].width === 42, `the list: ${JSON.stringify(row[0])}`);
      assert((await strip()).inView, 'the strip with the list folded');
      await shot(page, 'layout-e7-rail');
      const stored = await page.evaluate(() => localStorage.getItem('codemie.layout.meetings.v2'));
      assert(stored && await page.evaluate(() => localStorage.getItem('codemie.layout.meetings.v1')) === null, 'kept under v2 only');
      // Kept after a reload, then Reset brings the page back with a toast.
      await page.reload();
      await page.waitForSelector(`${dock} .ws-mtg-detail[data-panel="notes"] .ws-md h3`);
      const reloaded = await panes();
      assert(JSON.stringify(reloaded) === JSON.stringify(row), `after reload ${JSON.stringify(reloaded)} (before ${JSON.stringify(row)})`);
      assert(await page.evaluate(() => localStorage.getItem('codemie.layout.meetings.v2')) === stored, 'the stored layout changed on reload');
      const menu = `${dock} > .ws-pane:has(.ws-dock-tab[data-tab="mtg-meeting"]) .ws-dock-menu`;
      await page.click(`${menu} > summary`);
      await page.click(`${menu} [data-action="dock-reset"]`);
      await page.waitForSelector('.ws-toast:has-text("Meetings is back to its original layout")');
      row = await panes();
      assert(row.length === 2 && !row[0].collapsed && row[0].tabs.join() === 'mtg-list' && row[1].tabs.join() === 'mtg-meeting', `after Reset ${JSON.stringify(row)}`);
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
      // A group's header is one left-aligned line: chevron, name and (folded) count side by side.
      const heads = await page.evaluate(() => [...document.querySelectorAll('.ws-settings-nav button.ws-nav-group')].map(b => {
        const box = b.getBoundingClientRect();
        const parts = [...b.children].map(c => c.getBoundingClientRect());
        const mids = parts.map(p => p.top + p.height / 2);
        return { name: b.dataset.group, height: Math.round(box.height), indent: Math.round(parts[0].left - box.left), drift: Math.round(Math.max(...mids) - Math.min(...mids)) };
      }));
      const bad = heads.filter(h => h.drift > 2 || h.height > 40 || h.indent > 12);
      assert(!bad.length, `group headers not on one left-aligned line: ${JSON.stringify(bad)}`);
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

  // ---------------------------------------------------------------- E10: the Ask field (ask-capture § 2, § 11)
  const withRecent = s => { s.ask = askStates().idle; };
  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      const { page, context, errors } = await open({ theme, width: 1440, height: 900, hash: '#/today', patch: withRecent, settings: view === 'compact' ? { view: 'compact' } : null });
      await check(`layout E10 (${theme} ${view}): the Ask field first in the menu, Recent on focus, the rail’s ✦ collapsed and at 1000 px`, async () => {
        const place = await page.evaluate(() => {
          const r = sel => document.querySelector(sel)?.getBoundingClientRect();
          const field = r('.ws-ask-field');
          return { field: field && { h: Math.round(field.height), w: Math.round(field.width) }, belowBrand: field.top >= r('.ws-brand').bottom, aboveToday: field.bottom <= r('.ws-nav-home').top, rail: !!document.querySelector('.ws-ask-rail')?.getClientRects().length, placeholder: document.getElementById('ask-input').placeholder, hint: document.querySelector('.ws-ask-hint')?.textContent };
        });
        assert(place.field && place.belowBrand && place.aboveToday && !place.rail && place.placeholder === 'Ask…' && place.hint === '⌘K', `the field: ${JSON.stringify(place)}`);
        await shot(page, `layout-e10-${theme}-${view}-field`);
        // ⌘K: the field focused, Recent under it with the seeded questions, the foot.
        await page.keyboard.press('ControlOrMeta+KeyK');
        await page.waitForSelector('.ws-ask-recent li');
        assert(await page.evaluate(() => document.activeElement?.id) === 'ask-input', 'focus is not in the field');
        const recent = await page.locator('.ws-ask-recent li').allInnerTexts();
        assert(recent.join('|') === 'What did I promise Priya this week?|When is the QBR?|Who is Marek Novak?', `Recent: ${recent.join('|')}`);
        assert(await page.locator('.ws-ask-foot:text-is("Enter to ask · Esc to close")').count() === 1, 'no foot');
        await page.keyboard.press('ArrowDown');
        await page.waitForSelector('#ask-recent-0[aria-selected=true]');
        assert(await page.getAttribute('#ask-input', 'aria-activedescendant') === 'ask-recent-0', 'aria-activedescendant');
        await noOverflow(page, `${theme} ${view} with Recent open`);
        await shot(page, `layout-e10-${theme}-${view}-recent`);
        await page.keyboard.press('Escape');
        await page.waitForSelector('.ws-ask-recent', { state: 'detached' });
        // Collapsed by hand: the ✦ button in the field's place, "Ask (⌘K)".
        await page.keyboard.press('ControlOrMeta+Backslash');
        await page.waitForSelector('.ws-sidebar.ws-sidebar-rail');
        await page.waitForFunction(() => !!document.querySelector('.ws-ask-rail')?.getClientRects().length);
        assert(!(await page.locator('.ws-ask-field').isVisible()), 'the field shows on the rail');
        await page.hover('.ws-ask-rail');
        await page.waitForSelector('.ws-tooltip:text-is("Ask (⌘K)")');
        await shot(page, `layout-e10-${theme}-${view}-rail`);
        await page.keyboard.press('ControlOrMeta+Backslash');
        await page.waitForSelector('.ws-sidebar:not(.ws-sidebar-rail)');
        // 1000 px: the menu is a rail by its width; the ✦ button, nothing sideways.
        await page.setViewportSize({ width: 1000, height: 700 });
        await page.waitForFunction(() => Math.round(document.querySelector('.ws-sidebar').getBoundingClientRect().width) === 64);
        assert(await page.locator('.ws-ask-rail').isVisible(), 'no ✦ at 1000 px');
        await noOverflow(page, `${theme} ${view} at 1000 px`);
        await shot(page, `layout-e10-${theme}-${view}-1000`);
        // ⌘K with the rail: the Ask page with its box focused.
        await page.keyboard.press('ControlOrMeta+KeyK');
        await page.waitForSelector('#ask-follow-up');
        await page.waitForFunction(() => document.activeElement?.id === 'ask-follow-up');
        assert(new URL(page.url()).hash === '#/ask', `the hash: ${new URL(page.url()).hash}`);
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }
  // Asking from the Inbox: the chip follows the selection, Enter sends one ask_start with the
  // record chosen at Enter and the window's hidden calendars, and opens the thread. ⌘K does
  // nothing with a dialog open; × drops the chip; Esc clears, then gives focus back.
  {
    const { page, context, errors } = await open({ width: 1440, height: 900, hash: '#/inbox', localPrefs: { 'codemie.calendar.hidden': JSON.stringify(['cal-team']) } });
    await check('layout E10: the About chip follows the selection and is read at Enter; ask_start carries the hidden calendars', async () => {
      await page.click('.ws-inbox-row[data-id="m-reply-1"]');
      await page.waitForSelector('.ws-inbox-row.ws-selected[data-id="m-reply-1"]');
      await page.keyboard.press('ControlOrMeta+KeyK');
      await page.waitForSelector('.ws-ask-chip:has-text("About: Priya Natarajan · mail ·")');
      await page.keyboard.type('what did I promise?');
      // Another row, chosen while the question waits: the chip follows.
      await page.click('.ws-inbox-row[data-id="m-reply-2"]');
      await page.waitForSelector('.ws-ask-chip:has-text("About: Elena Varga · mail ·")');
      assert(await page.inputValue('#ask-input') === 'what did I promise?', 'the words went');
      await shot(page, 'layout-e10-chip');
      // A click back into the field selects its words, as ⌘K does (§ 2).
      await page.click('#ask-input');
      await page.waitForFunction(() => { const f = document.getElementById('ask-input'); return document.activeElement === f && f.selectionStart === 0 && f.selectionEnd === f.value.length; });
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.hash.startsWith('#/ask/ask-'));
      const starts = await calls(page, 'ask_start');
      assert(starts.length === 1, `${starts.length} ask_start`);
      assert(starts[0].question === 'what did I promise?' && starts[0].about?.kind === 'message' && starts[0].about.recordId === 'm-reply-2', JSON.stringify(starts[0]));
      assert(JSON.stringify(starts[0].hiddenCalendars) === '["cal-team"]', `hiddenCalendars: ${JSON.stringify(starts[0].hiddenCalendars)}`);
      assert(await page.inputValue('#ask-input') === '', 'the field kept the question');
      // Back on the Inbox: × drops the chip for this question; busy is said under the box.
      await page.click('.ws-sidebar [data-route="inbox"]');
      await page.waitForSelector('.ws-inbox-row.ws-selected');
      await page.keyboard.press('ControlOrMeta+KeyK');
      await page.waitForSelector('.ws-ask-chip');
      await page.keyboard.type('anything urgent?');
      await page.click('[data-action="ask-about-drop"]');
      await page.waitForSelector('.ws-ask-chip', { state: 'detached' });
      await page.evaluate(() => { window.__askRefuse = { op: 'ask_start', code: 'busy', message: 'Connect is still answering. Stop it or wait.' }; });
      await page.focus('#ask-input');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.ws-ask-error:text-is("Connect is still answering. Stop it or wait.")');
      const refused = (await calls(page, 'ask_start')).at(-1);
      assert(!('about' in refused), `× kept the About: ${JSON.stringify(refused)}`);
      assert(new URL(page.url()).hash === '#/inbox', 'a refusal navigated');
      await shot(page, 'layout-e10-busy');
      // Esc clears the words, then puts focus back on the row it came from.
      await page.keyboard.press('Escape');
      assert(await page.inputValue('#ask-input') === '', 'Esc kept the words');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.id !== 'ask-input');
      // ⌘K does nothing with a dialog open.
      const opened = await page.evaluate(() => {
        const d = document.createElement('dialog');
        d.className = 'ws-modal';
        document.body.append(d);
        d.showModal();
        return true;
      });
      assert(opened, 'no dialog');
      await page.keyboard.press('ControlOrMeta+KeyK');
      await page.waitForTimeout(200);
      assert(await page.evaluate(() => document.activeElement?.id) !== 'ask-input', '⌘K focused the field under a dialog');
      await page.evaluate(() => document.querySelector('dialog.ws-modal')?.remove());
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- E11: the Ask page (ask-capture § 5, § 7)
  // The thread ask-thread.json (done, failed, stopped), opened from the Inbox through Recent, in
  // both themes and views at 1440, 1000 and 1680 px; then an answer running (Stop and ⌘. send one
  // job_cancel), Back to the Inbox as it was; the empty page; Delete and Clear history.
  const sizes = async (page, name, view) => {
    for (const width of [1440, 1000, 1680]) {
      await page.setViewportSize({ width, height: 900 });
      const wide = view === 'default' && width >= 1440;
      await page.waitForSelector(wide ? '.ws-ask-cols .ws-ask-history' : '.ws-ask-hmenu');
      if (!wide) assert(await page.locator('[data-action="ask-new"]:text-is("New ask")').count() === 1, `${name} ${width}: no New ask`);
      await noOverflow(page, `${name} at ${width}`);
      await shot(page, `${name}-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      const name = `layout-e11-${theme}-${view}`;
      const { page, context, errors } = await open({ theme, width: 1440, height: 900, hash: '#/inbox', patch: withRecent, settings: view === 'compact' ? { view: 'compact' } : null });
      await check(`layout E11 (${theme} ${view}): the Ask page's turns, states, history and Back`, async () => {
        await page.click('.ws-inbox-row[data-id="m-reply-1"]');
        await page.waitForSelector('.ws-inbox-row.ws-selected[data-id="m-reply-1"]');
        // Priya's cite points at her seeded mail, so its mark and chip are live.
        await page.evaluate(thread => {
          const t = structuredClone(thread);
          t.turns[0].cites[0].recordId = 'm-reply-1';
          window.__askThreads = { 'ask-7f2c': t };
        }, askThread());
        const before = await page.evaluate(() => document.activeElement?.closest('[data-id]')?.dataset.id || document.activeElement?.tagName);
        await page.keyboard.press('ControlOrMeta+KeyK');
        await page.click('#ask-recent-0');
        await page.waitForSelector('[data-ask-turn="turn-3"]');
        assert(new URL(page.url()).hash === '#/ask/ask-7f2c', `hash ${new URL(page.url()).hash}`);
        // Opening the page focuses the newest turn's heading.
        await page.waitForFunction(() => document.activeElement?.matches('[data-ask-turn="turn-3"] .ws-ask-q'));
        const seen = await page.evaluate(() => ({
          back: document.querySelector('.ws-ask-back')?.textContent,
          region: document.querySelector('section.ws-ask-page')?.getAttribute('aria-label'),
          turns: document.querySelectorAll('article.ws-ask-turn').length,
          failed: document.querySelector('.ws-ask-failed')?.textContent.trim(),
          stopped: document.querySelector('.ws-ask-stopped')?.textContent,
          meta: document.querySelector('.ws-ask-meta summary')?.textContent.trim(),
          marks: document.querySelectorAll('[data-ask-turn="turn-1"] .ws-ask-mark').length,
          privacy: document.querySelector('.ws-ask-privacy')?.textContent,
          current: document.querySelector('.ws-ask-hrow[aria-current=page]')?.dataset.askThread,
          answerWidth: Math.round(document.querySelector('.ws-ask-main')?.getBoundingClientRect().width || 0),
        }));
        assert(seen.back === '← Back to Inbox' && seen.region === 'Ask' && seen.turns === 3, JSON.stringify(seen));
        assert(seen.failed === '✕ Couldn’t answer: CodeMie is not signed in.' && seen.stopped === 'Stopped.', JSON.stringify(seen));
        assert(/^Claude Code · 14 s · from 12 tasks, 7 events, 9 messages, 2 meetings, 1 person, 1 fact · Shortened to fit\./.test(seen.meta), seen.meta);
        assert(seen.marks === 7 && /^Answers use what Connect has on this Mac:/.test(seen.privacy) && seen.answerWidth <= 760, JSON.stringify(seen));
        assert(await page.locator('[data-action="ask-settings"]:text-is("Check Settings › AI")').count() === 1, 'no Check Settings › AI');
        // The history (the column, or History ▾'s list in Compact) marks the open thread.
        assert(seen.current === 'ask-7f2c', `aria-current: ${seen.current}`);
        assert((await calls(page, 'ask_read')).length >= 1 && (await calls(page, 'ask_start')).length === 0, 'opening sent a write');
        await sizes(page, `${name}-thread`, view);
        // M1: a mark is a button; Enter on it focuses its chip.
        await page.focus('[data-ask-mark="ask-cite-turn-1-a1"]');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.activeElement?.id === 'ask-cite-turn-1-a1');
        // The meta line's ▾ shows the whole searched line.
        await page.click('[data-ask-turn="turn-1"] .ws-ask-meta summary');
        await page.waitForSelector('.ws-ask-searched:has-text("events 7, Thu 19 Nov – Thu 3 Dec")');
        // An answer running: the turn says so with its seconds and Stop; the box waits.
        await page.evaluate(({ thread, running }) => {
          const t = structuredClone(thread);
          t.turns = [{ ...t.turns[0], searched: `${t.turns[0].searched} · Microsoft 365 isn't connected` }, { ...t.turns[2], id: 'turn-2', state: 'running', jobId: 'job-9' }];
          t.turns[0].cites[0].recordId = 'm-reply-1';
          window.__askThreads = { 'ask-7f2c': t };
          const startedAt = Math.floor(Date.now() / 1000) - 9;
          window.__lastAsk = { ...running, running: { ...running.running, startedAt } };
          window.__askSet(window.__lastAsk, [{ id: 'job-9', kind: 'ask', key: 'ask:ask-7f2c', state: 'running', dueAt: startedAt, attempts: 1, connectionId: null, policy: {}, payload: { threadId: 'ask-7f2c', turnId: 'turn-2', purpose: 'ask', profile: 'claude', startedAt }, result: null }]);
        }, { thread: askThread(), running: askStates().running });
        await page.waitForSelector('.ws-ask-stop[aria-keyshortcuts="Meta+Period"]');
        // M3: one live status outside the page; a redraw keeps the node and its words.
        await page.waitForFunction(() => /^Answering with Claude Code · \d+ s$/.test(document.getElementById('ask-live')?.textContent || ''));
        const said = await page.evaluate(() => { const n = document.getElementById('ask-live'); n.__kept = true; return { role: n.getAttribute('role'), text: n.textContent, inPage: !!n.closest('#workspace-app') }; });
        assert(said.role === 'status' && !said.inPage, JSON.stringify(said));
        assert(await page.locator('#workspace-app [role=status]:has-text("Answering")').count() === 0, 'a status inside the page');
        await page.evaluate(() => window.__askSet(window.__lastAsk));
        await page.waitForTimeout(150);
        const kept = await page.evaluate(() => { const n = document.getElementById('ask-live'); return { kept: n.__kept === true, text: n.textContent }; });
        assert(kept.kept && kept.text === said.text, `the status changed on a redraw: ${JSON.stringify(kept)} vs ${said.text}`);
        assert(await page.locator('#ask-follow-up').isDisabled(), 'the box asks while an answer runs');
        assert(await page.locator('#ask-box-why:text-is("Connect is still answering. Stop it or wait.")').count() === 1, 'no reason');
        assert(await page.locator('.ws-ask-note:has-text("Microsoft 365 isn’t connected, so this answer leaves out your mail, Teams and calendar.")').count() === 1, 'no Microsoft line');
        // The seconds tick on screen.
        const ticked = await page.locator('[data-ask-tick]').innerText();
        await page.waitForFunction(was => document.querySelector('[data-ask-tick]')?.textContent !== was, ticked, { timeout: 3000 });
        await page.setViewportSize({ width: 1000, height: 900 });
        await noOverflow(page, `${name} running at 1000`);
        await shot(page, `${name}-running-1000`);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.click('.ws-ask-stop');
        await page.waitForFunction(() => window.__bridgeCalls.filter(([op]) => op === 'job_cancel').length === 1);
        // ⌘. on a run started again (native had settled the first): one more job_cancel.
        await page.evaluate(() => {
          const job = { id: 'job-9', kind: 'ask', key: 'ask:ask-7f2c', state: 'running', dueAt: 0, attempts: 1, connectionId: null, policy: {}, payload: { threadId: 'ask-7f2c', turnId: 'turn-2', purpose: 'ask', profile: 'claude', startedAt: Math.floor(Date.now() / 1000) } };
          window.__askSet(JSON.parse(JSON.stringify(window.__lastAsk || {})), [job]);
        });
        await page.waitForSelector('.ws-ask-stop');
        await page.keyboard.press('Meta+Period');
        await page.waitForFunction(() => window.__bridgeCalls.filter(([op]) => op === 'job_cancel').length === 2);
        const cancels = await calls(page, 'job_cancel');
        assert(cancels.length === 2 && cancels.every(c => c.id === 'job-9'), JSON.stringify(cancels));
        // Back: the Inbox as it was, Priya's row still selected.
        await page.evaluate(ask => window.__askSet(ask), askStates().idle);
        await page.click('.ws-ask-back');
        await page.waitForSelector('.ws-inbox-row.ws-selected[data-id="m-reply-1"]');
        assert(new URL(page.url()).hash === '#/inbox', new URL(page.url()).hash);
        // I1: focus is back where it was before ⌘K.
        const after = await page.evaluate(() => document.activeElement?.closest('[data-id]')?.dataset.id || document.activeElement?.tagName);
        assert(before === 'm-reply-1' && after === before, `focus before ⌘K ${before}, after Back ${after}`);
        assert(await page.evaluate(() => document.getElementById('ask-live')?.textContent) === '', 'the status still says Answering');
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }
  // ---------------------------------------------------------------- E12: cites and actions (ask-capture § 8)
  // The done turn's cites pointing at seeded records: the chips are buttons that open their record
  // with "← Back to Ask" in a toast for 6 s; + Add as task opens quick capture filled in and saves
  // nothing; Open goes as its cite does; ✦ Draft a reply opens the message and sends one ai_draft
  // whose instructions are the hint. Both themes and views at 1000 px.
  const actionThread = () => {
    const t = structuredClone(askThread());
    const at = { a1: 'm-reply-1', t2: 'task-soon', e3: 'ev-standup', m4: 'c-reply-1', n5: 'ev-standup' };
    for (const c of t.turns[0].cites) if (at[c.id]) c.recordId = at[c.id];
    t.turns[0].about.recordId = 'm-reply-1';
    t.turns[0].actions[1].recordId = 'ev-standup';
    t.turns[0].actions[2].recordId = 'c-reply-1';
    return t;
  };
  // I1: a task due in 3 days sits in By date's closed "Next 7 days" fold; its cite opens it.
  const withSoonTask = (s, now) => {
    withRecent(s);
    const base = s.records.find(r => r.id === 'commit-1');
    const due = new Date(now + 3 * 86_400_000).toISOString().slice(0, 10);
    s.records.push({ ...structuredClone(base), id: 'task-soon', revision: 'r-task-soon', data: { ...structuredClone(base.data), text: 'Send the Atlas budget', due, status: 'todo', done: false } });
  };
  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      const name = `layout-e12-${theme}-${view}`;
      const { page, context, errors } = await open({ theme, width: 1000, height: 900, hash: '#/ask/ask-7f2c', patch: withSoonTask, localPrefs: { 'codemie.tasks.view': 'dates' }, settings: view === 'compact' ? { view: 'compact' } : null });
      await check(`layout E12 (${theme} ${view}): cite chips open their record with "← Back to Ask"; Add as task, Open and Draft a reply run only on a click`, async () => {
        // The thread's records are seeded ones: `ask_read` answers this copy once the page loads again.
        await page.addInitScript(t => { window.__askThreads = { 'ask-7f2c': t }; }, actionThread());
        await page.reload();
        await page.waitForSelector('[data-ask-turn="turn-1"] .ws-ask-actions');
        const seen = await page.evaluate(() => ({
          cites: [...document.querySelectorAll('[data-ask-turn="turn-1"] button.ws-ask-cite[data-action="ask-cite"]')].map(b => b.dataset.askCite).join(','),
          plain: [...document.querySelectorAll('[data-ask-turn="turn-1"] span.ws-ask-cite')].map(x => x.textContent).join('|'),
          actions: [...document.querySelectorAll('[data-ask-turn="turn-1"] .ws-ask-actions button')].map(b => `${b.dataset.action}:${b.textContent}`).join('|'),
        }));
        assert(seen.cites === 'a1,t2,e3,m4,n5', JSON.stringify(seen));
        assert(seen.plain === 'From Knowledge: Marek Novak|From Knowledge: Atlas rollout', JSON.stringify(seen));
        assert(seen.actions === 'ask-task:+ Add as task|ask-go:Open Event · Fri 27 Nov 10:00 · QBR|ask-reply:✦ Draft a reply to Jordan Lee', JSON.stringify(seen));
        await page.locator('[data-ask-turn="turn-1"] .ws-ask-actions').scrollIntoViewIfNeeded();
        await noOverflow(page, `${name} at 1000`);
        await shot(page, `${name}-actions-1000`);
        const writesBefore = await page.evaluate(() => window.__bridgeCalls.filter(([op]) => !['ask_read', 'capture_parse'].includes(op)).length);
        // A cite chip: Priya's mail selected (open in Compact), and the way back for 6 s.
        await page.click('[data-action="ask-cite"][data-ask-cite="a1"]');
        await page.waitForSelector(view === 'compact' ? '.ws-inbox-row[data-id="m-reply-1"][aria-expanded="true"]' : '.ws-inbox-row.ws-selected[data-id="m-reply-1"]');
        assert(new URL(page.url()).hash === '#/inbox', new URL(page.url()).hash);
        await page.waitForSelector('.ws-toast .ws-toast-action:text-is("← Back to Ask")');
        // `shot` drops toasts: this one is the point, so the window is taken as it is.
        await page.screenshot({ path: `${OUT.replace(/\/$/, '')}/${name}-cite-toast-1000.png` });
        await page.click('.ws-toast .ws-toast-action:text-is("← Back to Ask")');
        await page.waitForSelector('[data-ask-turn="turn-1"] .ws-ask-actions');
        assert(new URL(page.url()).hash === '#/ask/ask-7f2c', new URL(page.url()).hash);
        // I1: the task cite on By date opens the task's fold and unfolds its row, on screen.
        await page.click('[data-action="ask-cite"][data-ask-cite="t2"]');
        await page.waitForSelector('.ws-tdate-row.ws-tdate-open[data-task="task-soon"]', { state: 'visible' });
        assert(new URL(page.url()).hash.startsWith('#/tasks'), new URL(page.url()).hash);
        assert(await page.locator('[data-fold="next7"][aria-expanded="true"]').count() === 1, 'Next 7 days stayed closed');
        // Taken as it is: `shot` would drop the toast used next.
        await page.screenshot({ path: `${OUT.replace(/\/$/, '')}/${name}-task-1000.png` });
        await page.click('.ws-toast .ws-toast-action:text-is("← Back to Ask")');
        await page.waitForSelector('[data-ask-turn="turn-1"] .ws-ask-actions');
        // + Add as task: the bar filled in; nothing saved until Add.
        await page.click('[data-action="ask-task"]');
        await page.waitForSelector('.ws-capture');
        const bar = await page.evaluate(() => ({
          text: document.getElementById('capture-input')?.value,
          due: document.querySelector('[data-capture-due]')?.textContent.replace('×', '').trim(),
          source: document.querySelector('[data-capture-source]')?.textContent.replace('×', '').trim(),
        }));
        assert(bar.text === 'Send Priya the Atlas budget' && bar.due === 'Due Fri 27 Nov' && /^From: /.test(bar.source || ''), JSON.stringify(bar));
        await shot(page, `${name}-add-task-1000`);
        assert((await calls(page, 'task_save')).length === 0, 'Add as task saved a task');
        // Esc clears the words, then closes the bar.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.ws-capture'));
        // Open: the calendar on the event's day with the event open.
        await page.click('[data-action="ask-go"]');
        await page.waitForSelector('dialog.ws-event-modal[open][data-event-id="ev-standup"]');
        assert(new URL(page.url()).hash.startsWith('#/calendar'), new URL(page.url()).hash);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('dialog.ws-event-modal[open]'));
        await page.click('.ws-toast .ws-toast-action:text-is("← Back to Ask")');
        await page.waitForSelector('[data-ask-turn="turn-1"] .ws-ask-actions');
        // ✦ Draft a reply: Jordan's chat opened, then one ai_draft with the hint; nothing sent.
        await page.click('[data-action="ask-reply"]');
        await page.waitForFunction(() => window.__bridgeCalls.some(([op]) => op === 'ai_draft'));
        assert(new URL(page.url()).hash === '#/inbox', new URL(page.url()).hash);
        const drafts = await calls(page, 'ai_draft');
        assert(drafts.length === 1 && drafts[0].sourceId === 'c-reply-1' && drafts[0].instructions === 'Say the deck comes Thursday.', JSON.stringify(drafts));
        const sent = await page.evaluate(n => window.__bridgeCalls.slice(n).map(([op]) => op).filter(op => !['ask_read', 'capture_parse', 'ai_draft', 'ai_status'].includes(op)), writesBefore);
        assert(!sent.some(op => /send|task_save|reply|note_append|mail/.test(op)), `sent: ${sent.join(',')}`);
        await shot(page, `${name}-draft-1000`);
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }
  // I1 and M5: from an Inbox row, ⌘K and Enter open the page; Esc on the page (focus on the
  // newest heading, not in the box) goes Back, and focus returns to that row. With words in the
  // box, Esc there clears them first and stays.
  {
    const { page, context, errors } = await open({ width: 1440, height: 900, hash: '#/inbox' });
    await check('layout E11: ⌘K, Enter, then Esc on the page goes Back with focus on the row it came from', async () => {
      await page.click('.ws-inbox-row[data-id="m-reply-2"]');
      await page.waitForSelector('.ws-inbox-row.ws-selected[data-id="m-reply-2"]');
      const before = await page.evaluate(() => document.activeElement?.closest('[data-id]')?.dataset.id);
      await page.keyboard.press('ControlOrMeta+KeyK');
      await page.keyboard.type('what did Elena ask?');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.hash.startsWith('#/ask/ask-'));
      await page.waitForSelector('#ask-follow-up');
      // Esc in the box with words: cleared, still on the page.
      await page.fill('#ask-follow-up', 'and Jordan?');
      await page.keyboard.press('Escape');
      assert(await page.inputValue('#ask-follow-up') === '', 'Esc kept the words');
      assert(new URL(page.url()).hash.startsWith('#/ask/'), 'Esc with words left the page');
      // Esc outside the box: Back.
      await page.evaluate(() => { const h = document.querySelector('.ws-ask-page h1'); h.setAttribute('tabindex', '-1'); h.focus(); });
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ws-inbox-row.ws-selected[data-id="m-reply-2"]');
      assert(new URL(page.url()).hash === '#/inbox', new URL(page.url()).hash);
      const after = await page.evaluate(() => document.activeElement?.closest('[data-id]')?.dataset.id);
      assert(before === 'm-reply-2' && after === before, `focus before ⌘K ${before}, after Esc ${after}`);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
  // The empty page: the line and three examples that fill the box without asking.
  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      const { page, context, errors } = await open({ theme, width: 1000, height: 900, hash: '#/ask', settings: view === 'compact' ? { view: 'compact' } : null });
      await check(`layout E11 (${theme} ${view}): the empty Ask page`, async () => {
        await page.waitForSelector('.ws-ask-empty-line:text-is("Ask about your mail, meetings, calendar and tasks.")');
        const examples = await page.locator('[data-action="ask-example"]').allInnerTexts();
        assert(examples.join('|') === 'What’s due this week?|What did I agree in my last meeting?|Who’s waiting on me?', examples.join('|'));
        await page.click('[data-action="ask-example"] >> nth=1');
        await page.waitForFunction(() => document.getElementById('ask-follow-up')?.value === 'What did I agree in my last meeting?' && document.activeElement?.id === 'ask-follow-up');
        assert((await calls(page, 'ask_start')).length === 0, 'an example asked');
        await noOverflow(page, `${theme} ${view} empty at 1000`);
        await shot(page, `layout-e11-${theme}-${view}-empty-1000`);
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }
  // Delete is at once with no Undo; Clear history asks first, Return cancels.
  {
    const { page, context, errors } = await open({ width: 1440, height: 900, hash: '#/ask/ask-7f2c', patch: withRecent });
    await check('layout E11: ⋯ Delete sends one ask_delete at once; Clear history asks first and Return cancels', async () => {
      await page.waitForSelector('[data-ask-turn="turn-3"]');
      await page.click('[data-menu="ask-thread-ask-3a9e"] summary');
      const del = page.locator('[data-action="ask-delete"][data-ask-thread="ask-3a9e"]');
      assert(await del.getAttribute('aria-label') === 'Delete “When is the QBR?”', await del.getAttribute('aria-label'));
      await del.click();
      await page.waitForSelector('[data-ask-thread="ask-3a9e"]', { state: 'detached' });
      assert(JSON.stringify(await calls(page, 'ask_delete')) === '[{"threadId":"ask-3a9e"}]', 'one ask_delete');
      assert(await page.locator('dialog.ws-modal').count() === 0, 'Delete asked first');
      await page.click('[data-action="ask-clear"]');
      await page.waitForSelector('dialog.ws-modal h2:text-is("Clear Ask history?")');
      assert(await page.locator('dialog.ws-modal .ws-modal-text:text-is("Connect deletes every question and answer kept on this Mac. Your mail, tasks and notes are not touched.")').count() === 1, 'the dialog body');
      assert(await page.evaluate(() => document.activeElement?.textContent) === 'Cancel', 'Cancel is not focused');
      await page.waitForTimeout(300);
      await shot(page, 'layout-e11-clear-dialog');
      await page.waitForTimeout(600);
      await page.keyboard.press('Enter');
      await page.waitForSelector('dialog.ws-modal', { state: 'detached' });
      assert((await calls(page, 'ask_delete')).length === 1, 'Return cleared the history');
      await page.click('[data-action="ask-clear"]');
      await page.waitForSelector('dialog.ws-modal');
      await page.waitForTimeout(600);
      await page.click('dialog.ws-modal button[type=submit]:text-is("Clear history")');
      await page.waitForFunction(() => location.hash === '#/ask');
      assert(JSON.stringify((await calls(page, 'ask_delete')).at(-1)) === '{"all":true}', 'no ask_delete {all:true}');
      await page.waitForSelector('.ws-ask-empty-line');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- E13: Settings › Layout's "Ask in the menu" switch (ask-capture § 2, § 6, § 11, ruling 26)
  {
    const { page, context, errors } = await open({ width: 1440, height: 900, hash: '#/settings/layout' });
    await check('layout E13: "Ask in the menu" is on by default; turning it off sends one settings_update {askInMenu:false} and the field goes, leaving ⌘K', async () => {
      await page.waitForSelector('.ws-settings-layout');
      const input = page.locator('[data-setting="askInMenu"]');
      const switchEl = page.locator('.ws-switch:has([data-setting="askInMenu"])');
      assert(await input.isChecked(), 'the switch is not on by default');
      assert(await page.locator('.ws-ask-field').isVisible(), 'the field is not in the menu to begin with');
      await shot(page, 'layout-e13-on');
      await switchEl.click();
      await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'settings_update' && d.askInMenu === false));
      const updates = await calls(page, 'settings_update');
      assert(updates.filter(d => 'askInMenu' in d).length === 1, `one settings_update {askInMenu}: ${JSON.stringify(updates)}`);
      await page.waitForSelector('.ws-ask-field', { state: 'detached' });
      assert(!(await page.locator('.ws-ask-rail').count()), 'the rail stays once the field is off');
      await shot(page, 'layout-e13-off');
      // ⌘K still opens the Ask page with its box focused (Task 9 ruling 26).
      await page.keyboard.press('ControlOrMeta+KeyK');
      await page.waitForSelector('#ask-follow-up');
      await page.waitForFunction(() => document.activeElement?.id === 'ask-follow-up');
      assert(new URL(page.url()).hash === '#/ask', `the hash: ${new URL(page.url()).hash}`);
      assert((await page.locator('.ws-ask-back').innerText()) === '← Back to Settings', 'Back names the page it came from');
      await page.click('[data-action="ask-back"]');
      await page.waitForSelector('.ws-settings-layout');
      await switchEl.click();
      await page.waitForFunction(() => window.__bridgeCalls.filter(([op, d]) => op === 'settings_update' && 'askInMenu' in d).length > 1);
      await page.waitForSelector('.ws-ask-field');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
}
