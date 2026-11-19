// The Today controller (spec "Interactions" and "Saved layouts"): moving and resizing widgets by
// pointer, touch and keyboard, Customize mode and its gallery, the widget ⋯ menu and options
// panel, rename, saved layouts, lock, undo and redo. app.js routes the `today-*` actions here and
// `attachTodayDrag` wires the pointer and keys. Every change is one `layout_save` of the whole
// grid and nothing is kept optimistically: the page is drawn again from what native stored. Only
// `attachTodayDrag` touches the DOM; the controller's dependencies are injected for node:test.
import { GRID, PRESETS, compact, moveItem, optionsOf, payloadOf, placeAtTop, removeItem, resizeItem, sizeName, todayOf } from './today-grid.js';
import { drawnGrid, tileDefs } from './view-today.js';
import { pluginWidgetCatalog } from './today-plugins.js';
import { active } from './selectors.js';
import { autoScroll, trackPress } from './press.js';

const LOCKED = 'codemie.layout.locked';
const HISTORY = 60;
const BUILT_IN = Object.keys(PRESETS);
// Cards that show themselves (while they have something, or when native puts them in `layout`):
// taken off Today they go into `hidden`, and stay away until added again.
const AUTO_CARDS = ['meetings', 'plugins', 'automations'];
const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace'];

/** Today's view state: Customize mode, undo and redo (grids before each change), the widget whose
 *  options panel is open, the gallery search, the widget being renamed, and whether the grid is
 *  stacked (narrower than 640 px; app.js measures it). */
export function newTodayView() {
  return { editing: false, history: [], future: [], options: null, gallery: '', renaming: null, stacked: false };
}

const clone = v => JSON.parse(JSON.stringify(v));
const bottom = items => items.reduce((b, i) => Math.max(b, i.y + i.h), 0);
const find = (items, id) => items.find(i => i.id === id);
// Two grids are the same whatever the order of their keys and lists.
const stable = v => (Array.isArray(v) ? `[${v.map(stable).sort().join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
    : JSON.stringify(v));
const closeMenu = el => el?.closest?.('details')?.removeAttribute?.('open');

/**
 * `state.today` is the view state (`newTodayView()`), and `state.pluginsKnown` and
 * `state.installedPlugins` say which plugin widgets exist; `snap()` is the current snapshot;
 * `mutate(op, data)` a fenced write that re-renders; `render()` a re-render; `toast(message,
 * tone, {label, run})`; `prefs` the device preferences `{get, json, set}`; `announce(text)` the
 * live region; `focus(selector)` moves focus after a render.
 */
export function createTodayController({
  state, snap, mutate, render, toast = () => {}, prefs, announce = () => {}, focus = () => {}, now = () => Date.now(),
}) {
  const ui = () => state.today;
  const defs = () => tileDefs(pluginWidgetCatalog(state.installedPlugins || []));
  const current = () => todayOf(active(snap()), defs());
  const drawn = t => drawnGrid(snap(), t, defs(), { pluginsKnown: !!state.pluginsKnown, nowMs: now() });
  /** What the page draws of `t` (the grid widgets and the cards under it) and what it keeps aside. */
  const laid = (t, orig) => {
    const d = drawn(t);
    return { items: orig ? clone(orig) : clone([...d.placed, ...d.below]), away: d.away };
  };
  const titleOf = (t, id) => t.titles?.[id] || defs()[id]?.title || 'This widget';
  const locked = () => prefs.get(LOCKED, '0') === '1';
  const stacked = () => !!ui().stacked;
  const setLocked = async on => {
    prefs.set(LOCKED, on ? '1' : '0');
    await render();
  };
  const nudge = () => toast('Layouts are locked', 'info', { label: 'Unlock', run: () => setLocked(false) });

  // One change at a time, so each starts from the grid the one before it saved.
  let chain = Promise.resolve();
  const serial = fn => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  /**
   * `next` as it is saved: the widgets the page draws packed up, then the cards it draws under
   * the grid (the auto cards, and ids native put in `layout`) placed below them full width, so a
   * save never drops one, unless `base` placed it (this change took it off), and last the widgets
   * that aren't there (a plugin's that is off) packed below everything.
   */
  function pack(next, base) {
    const t = clone(next);
    const { placed, away, below } = drawn(t);
    const before = new Set(base.items.map(i => i.id));
    const items = compact(clone(placed));
    let y = bottom(items);
    for (const it of below) {
      if (before.has(it.id) || items.length + away.length >= GRID.maxItems) continue;
      items.push({ id: it.id, x: 0, y, w: GRID.cols, h: it.h });
      y += it.h;
    }
    const rest = compact(clone(away));
    rest.forEach(i => { i.y += y; });
    t.items = [...items, ...rest];
    return t;
  }

  /** Saves `next` (made from `before`). `step` says what the history does: a new change, an undo
   *  or a redo. A refusal changes nothing: the page is drawn again and the message shown. */
  async function save(next, before, { message, say, step = 'change' } = {}) {
    const packed = pack(next, before);
    const was = pack(before, before);
    const view = ui();
    if (stable(payloadOf(packed).today) === stable(payloadOf(was).today)) {
      if (step === 'undo') view.history = view.history.slice(0, -1);
      if (step === 'redo') view.future = view.future.slice(0, -1);
      return false;
    }
    const kept = { history: view.history, future: view.future };
    if (step === 'change') Object.assign(view, { history: [...view.history, was].slice(-HISTORY), future: [] });
    if (step === 'undo') Object.assign(view, { history: view.history.slice(0, -1), future: [...view.future, was] });
    if (step === 'redo') Object.assign(view, { history: [...view.history, was], future: view.future.slice(0, -1) });
    try {
      await mutate('layout_save', payloadOf(packed));
    } catch (err) {
      Object.assign(view, kept);
      await render();
      toast(err?.message || String(err), 'error');
      return false;
    }
    const said = say?.(packed);
    if (said) announce(said);
    if (message) toast(message, 'info', { label: 'Undo', run: () => undo() });
    return true;
  }

  // The widget the last moveTo or resizeTo held, so a drop can say where it went.
  let lastHeld = null;

  /** Runs `build(current grid)` after the changes before it, and saves what it returns. */
  const change = build => serial(async () => {
    const cur = current();
    const made = build(cur);
    lastHeld = null;
    return made ? save(made.next, cur, made) : false;
  });

  // Said in the live region too: ⌘Z after a key's Delete has no toast or focus to show it.
  const undo = () => serial(async () => {
    const prev = ui().history.at(-1);
    return prev ? save(prev, current(), { step: 'undo', say: () => 'Layout change undone' }) : false;
  });
  const redo = () => serial(async () => {
    const next = ui().future.at(-1);
    return next ? save(next, current(), { step: 'redo', say: () => 'Layout change redone' }) : false;
  });

  /** The grid with widget `id` held at `x`, `y` while the others start from `orig` (by default
   *  what the page draws). An id that isn't on Today yet comes in at its default size, as a
   *  gallery card does. Locked or stacked, nothing moves. */
  function moveTo(id, x, y, orig) {
    const cur = current();
    if (locked() || stacked()) return cur;
    const { items, away } = laid(cur, orig);
    let list = items;
    if (!find(items, id)) {
      const def = defs()[id];
      if (!def || items.length + away.length >= GRID.maxItems) return cur;
      list = [...items, { id, x, y, w: def.w, h: def.h }];
    }
    // A widget coming in from the gallery is announced by its toast.
    lastHeld = list === items ? { id, kind: 'move' } : null;
    return { ...cur, items: [...moveItem(list, id, x, y, items), ...away], hidden: cur.hidden.filter(h => h !== id) };
  }

  /** The grid with widget `id` held at `w` × `h`. A collapsed widget whose height stays stays
   *  collapsed; any other height opens it. Locked or stacked, nothing changes. */
  function resizeTo(id, w, h, orig) {
    const cur = current();
    if (locked() || stacked()) return cur;
    const { items, away } = laid(cur, orig);
    const it = find(items, id);
    if (!it) return cur;
    const def = defs()[id] || {};
    const folded = !!it.collapsed && h === it.h;
    const next = resizeItem(items, id, w, h, items, folded ? { ...def, minH: 1 } : def);
    const held = find(next, id);
    if (!folded) {
      delete held.collapsed;
      delete held.prevH;
    }
    lastHeld = { id, kind: 'size' };
    return { ...cur, items: [...next, ...away] };
  }

  /** Saves `next` (a drop), made from `before` (the grid as the drag found it); the live region
   *  says where the held widget went, and `message` shows in a toast with Undo. */
  const commit = (next, before, message) => serial(() => {
    const held = lastHeld;
    lastHeld = null;
    if (!next) return false;
    const say = held && (t => (find(t.items, held.id) ? (held.kind === 'move' ? moved(t, held.id) : sized(t, held.id)) : ''));
    return save(next, before || current(), { message, say });
  });

  // ---------------------------------------------------------------- changes

  const moved = (t, id) => { const it = find(t.items, id); return `${titleOf(t, id)} moved to column ${it.x + 1}, row ${it.y + 1}`; };
  const sized = (t, id) => { const it = find(t.items, id); return `${titleOf(t, id)} is ${it.w} columns by ${it.h} rows`; };

  function removed(cur, id) {
    const { items, away } = laid(cur);
    const next = { ...cur, items: [...removeItem(items, id), ...away.filter(i => i.id !== id)] };
    if (AUTO_CARDS.includes(id) && !cur.hidden.includes(id)) next.hidden = [...cur.hidden, id];
    if (ui().options === id) ui().options = null;
    return { next, message: `${titleOf(cur, id)} removed from Today` };
  }

  function added(cur, id) {
    const def = defs()[id];
    const { items, away } = laid(cur);
    if (!def || find(items, id)) return null;
    if (items.length + away.length >= GRID.maxItems) throw new Error(`Today holds up to ${GRID.maxItems} widgets. Remove one first.`);
    return { next: { ...cur, items: [...placeAtTop(items, { id, w: def.w, h: def.h }), ...away], hidden: cur.hidden.filter(h => h !== id) }, message: `${def.title} added to Today` };
  }

  function keyed(cur, id, ev) {
    const { items } = laid(cur);
    const it = find(items, id);
    if (!it) return null;
    if (ev.key === 'Delete' || ev.key === 'Backspace') return removed(cur, id);
    const [dx, dy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (ev.shiftKey) return { next: resizeTo(id, it.w + dx, it.collapsed ? it.h : it.h + dy), say: t => sized(t, id) };
    // Up and down jump over the widget directly above or below, not one row at a time.
    const across = o => o !== it && o.x < it.x + it.w && o.x + o.w > it.x;
    let { y } = it;
    if (dy < 0) {
      const above = items.filter(o => across(o) && o.y + o.h <= it.y).sort((a, b) => b.y - a.y)[0];
      y = above ? above.y : Math.max(0, it.y - 1);
    } else if (dy > 0) {
      const below = items.filter(o => across(o) && o.y >= it.y + it.h).sort((a, b) => a.y - b.y)[0];
      y = below ? below.y + below.h : it.y + 1;
    }
    return { next: moveTo(id, it.x + dx, y), say: t => moved(t, id) };
  }

  function sizedTo(cur, id, w, h) {
    const { items } = laid(cur);
    const it = find(items, id);
    if (!it) return null;
    const def = defs()[id] || {};
    // A wider widget moves left as far as it needs to fit.
    const x = Math.max(0, Math.min(it.x, GRID.cols - Math.max(w, def.minW || 2)));
    return { next: resizeTo(id, w, h, items.map(i => (i.id === id ? { ...i, x } : i))), say: t => (w === it.w ? `${titleOf(t, id)} is ${find(t.items, id).h} rows tall` : `${titleOf(t, id)} is ${sizeName(find(t.items, id).w)}`) };
  }

  function collapsed(cur, id) {
    const { items, away } = laid(cur);
    const it = find(items, id);
    if (!it) return null;
    if (it.collapsed) {
      it.h = it.prevH || defs()[id]?.h || it.h;
      delete it.collapsed;
      delete it.prevH;
    } else {
      Object.assign(it, { prevH: it.h, h: 1, collapsed: true });
    }
    return { next: { ...cur, items: [...compact(items), ...away] }, say: t => `${titleOf(t, id)} ${find(t.items, id)?.collapsed ? 'collapsed' : 'expanded'}` };
  }

  function optionChanged(cur, el) {
    const { id, key } = el.dataset;
    const def = defs()[id];
    const o = def?.options?.find(x => x.key === key);
    if (!o) return null;
    let value;
    if (o.type === 'toggle') {
      value = !!el.checked;
    } else if (o.type === 'select') {
      value = String(el.value);
      if (!o.choices.some(([c]) => c === value)) return null;
    } else {
      const on = new Set(optionsOf(cur, id, def)[key]);
      if (el.checked) on.add(el.value); else on.delete(el.value);
      value = o.choices.map(([c]) => c).filter(c => on.has(c));
    }
    return { next: { ...cur, options: { ...cur.options, [id]: { ...(cur.options[id] || {}), [key]: value } } } };
  }

  function retitled(cur, el) {
    const { id } = el.dataset;
    const text = String(el.value || '').trim().slice(0, 40);
    const titles = { ...cur.titles };
    if (!text || text === defs()[id]?.title) delete titles[id]; else titles[id] = text;
    return { next: { ...cur, titles } };
  }

  // ---------------------------------------------------------------- saved layouts

  function switched(cur, name) {
    if (!name || name === cur.active) return null;
    const items = cur.layouts[name] || PRESETS[name];
    if (!items) throw new Error('This layout is no longer there.');
    // The layout left keeps what it shows now.
    const layouts = { ...cur.layouts, [cur.active]: pack(cur, cur).items };
    return { next: { ...cur, active: name, items: clone(items), layouts }, message: `Switched to “${name}”` };
  }

  function savedAs(cur, raw) {
    const name = String(raw || '').trim();
    if (!name || name.length > 40) throw new Error('Name the layout with 1 to 40 characters.');
    if (BUILT_IN.includes(name)) throw new Error('That name belongs to a built-in layout.');
    const own = Object.keys(cur.layouts).filter(n => !BUILT_IN.includes(n));
    if (!own.includes(name) && own.length >= GRID.maxOwnLayouts) throw new Error(`You can keep ${GRID.maxOwnLayouts} layouts of your own. Delete one first.`);
    const items = pack(cur, cur).items;
    return { next: { ...cur, active: name, layouts: { ...cur.layouts, [cur.active]: items, [name]: items } }, name };
  }

  function reset(cur, name) {
    if (!BUILT_IN.includes(name)) throw new Error('Only a built-in layout can be reset.');
    const layouts = { ...cur.layouts };
    delete layouts[name];
    const next = name === cur.active ? { ...cur, items: clone(PRESETS[name]), layouts } : { ...cur, layouts };
    return { next, message: `“${name}” is back to the original` };
  }

  function deleted(cur, name) {
    if (BUILT_IN.includes(name)) throw new Error('A built-in layout can’t be deleted. Reset brings back the original.');
    if (!Object.hasOwn(cur.layouts, name)) return null;
    const layouts = { ...cur.layouts };
    delete layouts[name];
    const next = name === cur.active ? { ...cur, active: 'Default', items: clone(layouts.Default || PRESETS.Default), layouts } : { ...cur, layouts };
    return { next, message: `“${name}” deleted` };
  }

  // ---------------------------------------------------------------- actions

  /** Runs a `today-*` action from `el` (a button, field or menu item); `ev` is the key event for
   *  `today-key` (a widget's grip). */
  async function handle(action, el = { dataset: {} }, ev = {}) {
    const data = el.dataset || {};
    const id = data.id;
    if (action === 'today-key') {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || !KEYS.includes(ev.key)) return false;
      ev.preventDefault?.();
      if (stacked()) return false;
      const deleting = ev.key === 'Delete' || ev.key === 'Backspace';
      if (locked()) return deleting ? false : nudge();
      return change(cur => keyed(cur, data.grip || id, ev));
    }
    switch (action) {
      case 'today-customize': {
        if (locked()) {
          prefs.set(LOCKED, '0');
          toast('Unlocked layouts to customize Today');
        }
        ui().editing = true;
        await render();
        if (data.focus === 'gallery') focus('#today-gallery-search');
        return true;
      }
      case 'today-done':
        Object.assign(ui(), { editing: false, options: null, gallery: '', renaming: null });
        await render();
        toast('Today is saved — every change is kept as you make it', 'success');
        return true;
      case 'today-undo': return undo();
      case 'today-redo': return redo();
      case 'today-lock': {
        const on = !locked();
        await setLocked(on);
        toast(on ? 'Layouts locked — nothing moves until you unlock' : 'Layouts unlocked');
        return true;
      }
      case 'today-locked': return nudge();
      case 'today-gallery-search':
        ui().gallery = String(el.value || '');
        await render();
        return true;
      case 'today-add': return change(cur => added(cur, id));
      case 'today-remove':
        closeMenu(el);
        return change(cur => removed(cur, id));
      case 'today-width': case 'today-height': case 'today-top':
        closeMenu(el);
        if (stacked()) return false;
        if (locked()) return nudge();
        return change(cur => {
          const it = find(laid(cur).items, id);
          if (!it) return null;
          if (action === 'today-top') return { next: moveTo(id, 0, 0), say: t => `${titleOf(t, id)} moved to the top` };
          return action === 'today-width' ? sizedTo(cur, id, Number(data.w), it.h) : sizedTo(cur, id, it.w, Number(data.h));
        });
      case 'today-collapse':
        closeMenu(el);
        return change(cur => collapsed(cur, id));
      case 'today-options': {
        closeMenu(el);
        const open = !!id && ui().options !== id;
        ui().options = open ? id : null;
        await render();
        if (open) focus('.ws-today-options [name="title"]');
        return true;
      }
      case 'today-option': return change(cur => optionChanged(cur, el));
      case 'today-reset':
        return change(cur => {
          const options = { ...cur.options };
          const titles = { ...cur.titles };
          delete options[id];
          delete titles[id];
          return { next: { ...cur, options, titles } };
        });
      case 'today-rename':
        closeMenu(el);
        Object.assign(ui(), { renaming: id, options: null });
        await render();
        focus('.ws-tile-rename');
        return true;
      case 'today-title': {
        // Leaving the options panel's Title unchanged draws nothing: the click that left it lands.
        const renaming = ui().renaming === id;
        if (renaming) ui().renaming = null;
        const saved = await change(cur => retitled(cur, el));
        if (!saved && renaming) await render();
        return saved;
      }
      case 'today-layout-use':
        closeMenu(el);
        return change(cur => switched(cur, data.name));
      case 'today-layout-save': {
        closeMenu(el);
        let name = '';
        const saved = await change(cur => {
          const made = savedAs(cur, data.name ?? el.value);
          name = made.name;
          return made;
        });
        if (saved) toast(`Saved as “${name}” — changes now go to this layout`, 'success');
        return saved;
      }
      case 'today-layout-reset':
        closeMenu(el);
        return change(cur => reset(cur, data.name || cur.active));
      case 'today-layout-delete':
        closeMenu(el);
        return change(cur => deleted(cur, data.name));
      default:
        throw new Error('This action is not available. Refresh the view and try again.');
    }
  }

  return { handle, moveTo, resizeTo, commit, undo, redo, locked, stacked };
}

// ---------------------------------------------------------------- pointer and keys

const STEP = GRID.rowHeight + GRID.gap;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cssEscape = value => String(value).replace(/["\\]/g, '\\$&');

/**
 * Wires Today's pointer and keyboard to controller `ui` on `doc`: a widget moves by its header
 * (not its buttons), resizes by its edges and corner (`.ws-rz`), a gallery card drags onto the
 * grid, a grip takes the arrow keys, and a double-click on a title renames it. When a drag starts,
 * `dragging(true)` holds re-renders; `dragging(false)` runs once no drag or drop's save is left.
 * The tiles move in the DOM as the pointer goes; the grid is saved once, on the drop.
 */
export function attachTodayDrag(doc, ui, { dragging = () => {}, fail = () => {} } = {}) {
  const gridOf = () => doc.querySelector('[data-today-grid]');
  // The stacked layout follows the page's width, as the CSS does.
  const isStacked = grid => (grid.closest('.ws-today-page') || grid).clientWidth < GRID.stackBelow || ui.stacked();
  const metrics = grid => {
    const col = (grid.clientWidth - GRID.gap * (GRID.cols - 1)) / GRID.cols;
    return { col, step: col + GRID.gap };
  };
  const tileOf = (grid, id) => grid.querySelector(`:scope > [data-tile="${cssEscape(id)}"]`);
  const setBox = (el, it) => {
    for (const k of ['x', 'y', 'w', 'h']) el.style.setProperty(`--${k}`, String(it[k]));
  };
  // Where the dragged widget would land.
  const placeholder = (grid, it) => {
    let ph = grid.querySelector(':scope > .ws-tile-ph');
    if (!ph) {
      ph = doc.createElement('div');
      ph.className = 'ws-tile-ph';
      ph.setAttribute('aria-hidden', 'true');
      grid.append(ph);
    }
    ph.classList.toggle('ws-on', !!it);
    if (it) setBox(ph, it);
  };
  /** Puts every drawn tile but `held` where `items` say, and makes room for them (and for `held`,
   *  which may be a gallery card with no tile yet). Widgets the page doesn't draw take no room. */
  const place = (grid, items, held, rows) => {
    let end = rows;
    for (const it of items) {
      const el = tileOf(grid, it.id);
      if (!el && it.id !== held) continue;
      end = Math.max(end, it.y + it.h);
      if (el && it.id !== held) setBox(el, it);
    }
    grid.style.setProperty('--rows', String(end));
  };
  /** What a drag changes in the DOM, to put back on Escape. */
  const remember = grid => {
    const styles = [grid, ...grid.children].map(el => [el, el.getAttribute('style')]);
    return () => {
      for (const [el, style] of styles) {
        if (style === null) el.removeAttribute('style'); else el.setAttribute('style', style);
      }
      placeholder(grid, null);
    };
  };
  const rowsOf = grid => Number(grid.style.getPropertyValue('--rows')) || 0;
  const scroller = onScroll => autoScroll(doc.getElementById('workspace-main'), onScroll);
  // The guides (and the tiles' transitions with them) stay until the dropped tile has glided in.
  const release = grid => setTimeout(() => grid.classList.remove('ws-guides'), 250);
  // Drags from their start until their save settles. Re-renders are held while there is one, and
  // a new press waits for none: it would start on tiles a held render is about to replace.
  let active = 0;
  const hold = on => {
    active = Math.max(0, active + (on ? 1 : -1));
    if (on && active === 1) dragging(true);
    if (!on && !active) dragging(false);
  };
  /** The drop's save; re-renders wait until it has settled. */
  const settle = (saving, grid) => Promise.resolve(saving).catch(fail).finally(() => {
    hold(false);
    release(grid);
  });
  /** The grid and widget `id`'s tile as the page shows them now: a render may have replaced the
   *  ones pressed while the press waited to become a drag. Null when the widget is gone. */
  const fresh = id => {
    const grid = gridOf();
    const tile = grid && tileOf(grid, id);
    return tile && !isStacked(grid) ? { grid, tile } : null;
  };

  function startMove(ev, grid, tile) {
    const id = tile.dataset.tile;
    if (isStacked(grid)) return;
    if (ui.locked()) {
      trackPress(ev, { onStart: () => { ui.handle('today-locked').catch(fail); } });
      return;
    }
    const editing = !!grid.closest('.ws-today-editing');
    let off;
    let m;
    let next = null;
    let last = null;
    let undoDom;
    let scroll;
    let rows;
    const update = at => {
      last = at;
      const g = grid.getBoundingClientRect();
      const left = at.clientX - g.left - off.x;
      const top = at.clientY - g.top - off.y;
      tile.style.left = `${left}px`;
      tile.style.top = `${top}px`;
      const w = Number(tile.style.getPropertyValue('--w'));
      const x = clamp(Math.round(left / m.step), 0, GRID.cols - w);
      const y = Math.max(0, Math.round(top / STEP));
      const held = next && find(next.items, id);
      if (!held || held.x !== x || held.y !== y) {
        next = ui.moveTo(id, x, y);
        place(grid, next.items, id, rows);
      }
      placeholder(grid, find(next.items, id));
      scroll.update(at.clientY);
    };
    const finish = () => {
      scroll?.stop();
      tile.classList.remove('ws-tile-lifted');
      placeholder(grid, null);
    };
    trackPress(ev, {
      threshold: 4,
      longPress: editing ? 0 : 380,
      cursor: 'move',
      onStart: (at, { sx, sy }) => {
        const now = fresh(id);
        if (!now) return false;
        ({ grid, tile } = now);
        hold(true);
        undoDom = remember(grid);
        rows = rowsOf(grid);
        const r = tile.getBoundingClientRect();
        off = { x: sx - r.left, y: sy - r.top };
        m = metrics(grid);
        tile.classList.add('ws-tile-lifted');
        grid.classList.add('ws-guides');
        scroll = scroller(() => last && update(last));
      },
      onMove: at => update(at),
      onEnd: () => {
        finish();
        const held = next && find(next.items, id);
        if (held) {
          tile.style.removeProperty('left');
          tile.style.removeProperty('top');
          setBox(tile, held);
        }
        settle(next ? ui.commit(next) : false, grid);
      },
      onCancel: () => {
        finish();
        undoDom();
        hold(false);
        release(grid);
      },
    });
  }

  function startResize(ev, grid, tile, edge) {
    if (isStacked(grid)) return;
    if (ui.locked()) {
      ui.handle('today-locked').catch(fail);
      return;
    }
    const id = tile.dataset.tile;
    let m;
    let start;
    let next = null;
    let undoDom;
    let badge;
    let rows;
    const finish = () => {
      tile.classList.remove('ws-tile-resizing');
      badge?.remove();
      placeholder(grid, null);
    };
    trackPress(ev, {
      threshold: 2,
      cursor: edge === 'r' ? 'ew' : edge === 'b' ? 'ns' : 'nwse',
      onStart: () => {
        const now = fresh(id);
        if (!now) return false;
        ({ grid, tile } = now);
        hold(true);
        undoDom = remember(grid);
        rows = rowsOf(grid);
        m = metrics(grid);
        const r = tile.getBoundingClientRect();
        start = { width: r.width, height: r.height, x: Number(tile.style.getPropertyValue('--x')) };
        tile.classList.add('ws-tile-resizing');
        grid.classList.add('ws-guides');
        badge = doc.createElement('span');
        badge.className = 'ws-tile-badge';
        tile.append(badge);
      },
      onMove: (at, { dx, dy }) => {
        const width = edge === 'b' ? start.width : clamp(start.width + dx, 2 * m.step - GRID.gap, (GRID.cols - start.x) * m.step - GRID.gap);
        const height = edge === 'r' ? start.height : Math.max(GRID.rowHeight, start.height + dy);
        tile.style.width = `${width}px`;
        tile.style.height = `${height}px`;
        const w = Math.round((width + GRID.gap) / m.step);
        const h = Math.round((height + GRID.gap) / STEP);
        const held = next && find(next.items, id);
        if (!held || held.w !== w || held.h !== h) {
          next = ui.resizeTo(id, w, h);
          place(grid, next.items, id, rows);
        }
        const now = find(next.items, id);
        badge.textContent = `${now.w} × ${now.h} `;
        const name = doc.createElement('span');
        name.textContent = sizeName(now.w);
        badge.append(name);
        placeholder(grid, now);
      },
      onEnd: () => {
        finish();
        const held = next && find(next.items, id);
        if (held) {
          tile.style.removeProperty('width');
          tile.style.removeProperty('height');
          setBox(tile, held);
        }
        settle(next ? ui.commit(next) : false, grid);
      },
      onCancel: () => {
        finish();
        undoDom();
        hold(false);
        release(grid);
      },
    });
  }

  function startGalleryDrag(ev, card) {
    let grid = gridOf();
    if (!grid || isStacked(grid)) return;
    const id = card.dataset.gid;
    const w = Number(card.dataset.w) || 4;
    const h = Number(card.dataset.h) || 4;
    const title = card.dataset.title || '';
    let m;
    let ghost;
    let next = null;
    let last = null;
    let undoDom;
    let scroll;
    let rows;
    const leave = () => {
      if (!next) return;
      next = null;
      undoDom();
      ghost.classList.remove('ws-over');
    };
    const update = at => {
      last = at;
      ghost.style.transform = `translate(${at.clientX - 20}px, ${at.clientY - 20}px)`;
      const g = grid.getBoundingClientRect();
      const inside = at.clientX >= g.left - 20 && at.clientX <= g.right + 20 && at.clientY >= g.top - 40 && at.clientY <= g.bottom + 160;
      if (inside) {
        const x = clamp(Math.round((at.clientX - g.left - (w * m.step - GRID.gap) / 2) / m.step), 0, GRID.cols - w);
        const y = Math.max(0, Math.round((at.clientY - g.top - 24) / STEP));
        const held = next && find(next.items, id);
        if (!held || held.x !== x || held.y !== y) {
          next = ui.moveTo(id, x, y);
          place(grid, next.items, id, rows);
        }
        const now = find(next.items, id);
        // Locked, or Today is full: the card isn't taken.
        if (!now) leave(); else placeholder(grid, now);
        ghost.classList.toggle('ws-over', !!now);
      } else {
        leave();
      }
      scroll.update(at.clientY);
    };
    const finish = () => {
      scroll?.stop();
      ghost?.remove();
      placeholder(grid, null);
    };
    trackPress(ev, {
      threshold: 4,
      longPress: 220,
      cursor: 'move',
      onStart: at => {
        // The grid as the page shows it now (a render may have replaced the one pressed over).
        grid = gridOf();
        if (!grid || isStacked(grid)) return false;
        hold(true);
        undoDom = remember(grid);
        rows = rowsOf(grid);
        m = metrics(grid);
        grid.classList.add('ws-guides');
        ghost = doc.createElement('div');
        ghost.className = 'ws-drag-ghost';
        const icon = doc.createElement('span');
        icon.className = 'ws-card-icon';
        icon.innerHTML = card.querySelector('.ws-gallery-thumb svg')?.outerHTML || '';
        const text = doc.createElement('span');
        text.textContent = title;
        const hint = doc.createElement('small');
        hint.textContent = `${w} × ${h} · drop on Today`;
        text.append(hint);
        ghost.append(icon, text);
        doc.body.append(ghost);
        scroll = scroller(() => last && update(last));
        update(at);
      },
      onMove: at => update(at),
      onEnd: () => {
        finish();
        settle(next ? ui.commit(next, undefined, `${title} added to Today`) : false, grid);
      },
      onCancel: () => {
        finish();
        leave();
        hold(false);
        release(grid);
      },
    });
  }

  doc.addEventListener('pointerdown', ev => {
    if (active) return;
    const target = ev.target;
    const card = target.closest?.('.ws-gallery-card:not(.ws-gallery-on)');
    if (card) {
      if (!target.closest('button, input, a')) startGalleryDrag(ev, card);
      return;
    }
    const tile = target.closest?.('[data-today-grid] > [data-tile]');
    if (!tile) return;
    const grid = tile.parentElement;
    const rz = target.closest('.ws-rz');
    if (rz) {
      ev.stopPropagation();
      startResize(ev, grid, tile, rz.dataset.edge);
      return;
    }
    if (!target.closest('.ws-tile-head') || target.closest('button:not(.ws-tile-grip), a, input, select, textarea, summary, .ws-menu-panel')) return;
    startMove(ev, grid, tile);
  });

  doc.addEventListener('keydown', ev => {
    const t = ev.target;
    if (t.matches?.('[data-today-grid] .ws-tile-grip')) {
      ui.handle('today-key', t, ev).catch(fail);
    } else if (t.matches?.('input[data-commit="today-title"]') && !ev.isComposing) {
      // A title saves when its field is left: Enter leaves it, Escape leaves it unchanged.
      if (ev.key === 'Enter') {
        ev.preventDefault();
        t.blur();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        t.value = t.defaultValue;
        t.blur();
      }
    } else if (ev.key === 'Escape' && doc.querySelector('.ws-today-options') && !doc.querySelector('details.ws-menu[open], .ws-modal[open]')) {
      ui.handle('today-options').catch(fail);
    }
  });

  // The options panel closes when something else is clicked (the click itself lands first).
  doc.addEventListener('click', ev => {
    if (!doc.querySelector('.ws-today-options') || ev.target.closest?.('.ws-today-options, [data-action="today-options"], .ws-tile-menu')) return;
    ui.handle('today-options').catch(fail);
  });

  doc.addEventListener('dblclick', ev => {
    const title = ev.target.closest?.('[data-today-grid] .ws-tile-head h2');
    if (!title || ev.target.closest('input')) return;
    ui.handle('today-rename', { dataset: { id: title.closest('[data-tile]').dataset.tile } }).catch(fail);
  });

  // Renaming starts with the whole title chosen, so typing replaces it.
  doc.addEventListener('focusin', ev => {
    if (ev.target.matches?.('.ws-tile-rename')) ev.target.select();
  });
}
