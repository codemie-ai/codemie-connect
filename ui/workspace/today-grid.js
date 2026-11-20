// The Today grid: 12 columns of 56 px rows. Items are {id, x, y, w, h, collapsed?, prevH?}. Widgets
// float up as far as they can; while one is held, a widget it overlaps first slides sideways in
// its row (so two widgets swap places) and otherwise drops below it. Also the built-in layouts,
// and how a workspace with no saved grid gets one from its old `layout`. Pure: node:test imports
// it. The packing is the prototype's (prototypes/today-customize/proto-today.js).
import { PLUGINS_CARD, parseLayoutId } from './today-plugins.js';

export const GRID = { cols: 12, rowHeight: 56, gap: 16, stackBelow: 640, maxItems: 16, maxLayouts: 15, maxOwnLayouts: 12 };
const MIN_W = 2;
const MAX_H = 24;
const MY_LAYOUT = 'My layout';
// Cards that show themselves while they have something, until the user takes them off Today.
const AUTO_CARDS = ['meetings', PLUGINS_CARD];

const item = (id, x, y, w, h) => ({ id, x, y, w, h });
export const PRESETS = {
  Default: [
    item('brief', 0, 0, 8, 4), item('focus', 8, 0, 4, 4), item('calendar', 0, 4, 6, 7), item('inbox', 6, 4, 6, 7),
    item('commitments', 0, 11, 8, 6), item('notes', 8, 11, 4, 6), item('meetings', 0, 17, 6, 5), item('automations', 6, 17, 6, 5),
  ],
  Focus: [
    item('brief', 0, 0, 8, 3), item('timer', 8, 0, 4, 3), item('commitments', 0, 3, 8, 7), item('notes', 8, 3, 4, 7),
    item('inbox', 0, 10, 6, 5), item('calendar', 6, 10, 6, 5),
  ],
  'Meeting day': [
    item('brief', 0, 0, 6, 4), item('calendar', 6, 0, 6, 9), item('meetings', 0, 4, 6, 5), item('inbox', 0, 9, 6, 6),
    item('commitments', 6, 9, 6, 6),
  ],
};

const clone = v => JSON.parse(JSON.stringify(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const own = (obj, key) => !!obj && Object.hasOwn(obj, key);
const collides = (a, b) => a !== b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const byPlace = (a, b) => a.y - b.y || a.x - b.x;

/** Floats every item up as far as it goes. `held` (one of `items`, or a widget being dragged in)
 *  stays where it is: an item it overlaps first slides to the nearest free x in its row, and
 *  otherwise drops below. Changes `items` in place and returns it. */
export function compact(items, held = null) {
  const placed = held ? [held] : [];
  items.slice().sort(byPlace).forEach(it => {
    if (it === held) return;
    it.x = clamp(it.x, 0, GRID.cols - it.w);
    it.y = Math.max(0, it.y);
    while (it.y > 0 && !placed.some(p => collides({ ...it, y: it.y - 1 }, p))) it.y--;
    if (held && collides(it, held)) {
      const xs = [...Array(GRID.cols - it.w + 1).keys()].sort((a, b) => Math.abs(a - it.x) - Math.abs(b - it.x));
      const free = xs.find(x => !placed.some(p => collides({ ...it, x }, p)));
      if (free !== undefined) it.x = free;
    }
    let hit;
    while ((hit = placed.find(p => collides(it, p)))) it.y = hit.y + hit.h;
    placed.push(it);
  });
  return items;
}

// `held` in place of its own entry in a copy of `orig`, then packed around it.
function hold(orig, held) {
  const next = orig.map(i => (i.id === held.id ? held : { ...i }));
  if (!next.includes(held)) next.push(held);
  return compact(next, held);
}

const find = (items, orig, id) => items.find(i => i.id === id) || orig.find(i => i.id === id);

/** `id` held at x, y while the others start from `orig` (the grid before the drag began).
 *  Returns a new array; x keeps the widget inside the right edge. */
export function moveItem(items, id, x, y, orig = items) {
  const cur = find(items, orig, id);
  if (!cur) return clone(items);
  return hold(orig, { ...cur, x: clamp(x, 0, GRID.cols - cur.w), y: Math.max(0, y) });
}

/** `id` held at w × h, no smaller than its widget allows (`def.minW`, `def.minH`) and never past
 *  the right edge, while the others start from `orig`. Returns a new array. */
export function resizeItem(items, id, w, h, orig = items, def = {}) {
  const cur = find(items, orig, id);
  if (!cur) return clone(items);
  const minW = Math.max(MIN_W, def.minW || MIN_W);
  const minH = Math.max(1, def.minH || 1);
  return hold(orig, { ...cur, w: clamp(w, minW, GRID.cols - cur.x), h: clamp(h, minH, MAX_H) });
}

/** Adds `item` (its w and h) at the top left and pushes the others down. Returns a new array. */
export function placeAtTop(items, item) {
  const top = { ...item, x: 0, y: 0 };
  return compact([...items.filter(i => i.id !== item.id).map(i => ({ ...i, y: i.y + top.h })), top]);
}

/** The grid without `id`, packed up. Returns a new array. */
export function removeItem(items, id) {
  return compact(items.filter(i => i.id !== id).map(i => ({ ...i })));
}

/** The grid an old `layout` (ordered ids) and `widgetWidths` (columns per id) stand for: the same
 *  order and widths, filling each row left to right at the widgets' default heights, then packed
 *  upward like every layout, so the first save keeps what opened. Tasks is 8 wide with Notes after
 *  it, since Notes used to be part of it. `defs` are `tileDefs`. */
export function fromLegacy(layout, widgetWidths, defs) {
  const width = (id, fallback) => {
    const v = own(widgetWidths, id) ? widgetWidths[id] : undefined;
    return Number.isInteger(v) && v >= MIN_W && v <= GRID.cols ? v : fallback;
  };
  const list = [];
  for (const id of layout) {
    if (list.some(x => x.id === id)) continue;
    if (id === 'commitments') {
      list.push({ id, w: 8, h: defs.commitments.h });
      if (!layout.includes('notes')) list.push({ id: 'notes', w: 4, h: defs.notes.h });
    } else if (own(defs, id)) {
      list.push({ id, w: width(id, defs[id].w), h: defs[id].h });
    } else if (parseLayoutId(id)) {
      // A plugin widget whose plugin isn't listed (yet): its saved width, 4 rows.
      list.push({ id, w: width(id, 6), h: 4 });
    }
  }
  const items = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const { id, w, h } of list.slice(0, GRID.maxItems)) {
    if (x + w > GRID.cols) {
      y += rowH;
      x = 0;
      rowH = 0;
    }
    items.push(item(id, x, y, w, h));
    x += w;
    rowH = Math.max(rowH, h);
  }
  return compact(items);
}

/** The Today grid of workspace `w`: its saved `today`, or, before the first save, the one its old
 *  layout stands for. Never customized (no widths saved) gives Default; a customized layout
 *  becomes "My layout", and an auto card the old layout left out stays hidden. Derives only. */
export function todayOf(w, defs) {
  const t = w.today;
  if (t && Array.isArray(t.items)) {
    return clone({
      active: typeof t.active === 'string' && t.active ? t.active : 'Default',
      items: t.items,
      layouts: t.layouts || {},
      titles: t.titles || {},
      options: t.options || {},
      hidden: t.hidden || [],
    });
  }
  const widths = w.widgetWidths || {};
  if (!Object.keys(widths).length) return { active: 'Default', items: clone(PRESETS.Default), layouts: {}, titles: {}, options: {}, hidden: [] };
  const items = fromLegacy(w.layout || [], widths, defs);
  const layout = w.layout || [];
  return {
    active: MY_LAYOUT,
    items,
    layouts: { [MY_LAYOUT]: clone(items) },
    titles: {},
    options: {},
    hidden: AUTO_CARDS.filter(id => own(widths, id) && !layout.includes(id)),
  };
}

/** Cards drawn below the grid: ids in `w.layout` (native adds `automations` there when an
 *  automation delivers to Today) or `wanted` (auto cards that have something) that the grid
 *  doesn't place and the user didn't remove. */
export function autoCards(w, today, wanted = []) {
  const placed = new Set(today.items.map(i => i.id));
  const hidden = new Set(today.hidden || []);
  return [...new Set([...(w.layout || []), ...wanted])].filter(id => !placed.has(id) && !hidden.has(id));
}

const shape = items => JSON.stringify(items.map(i => [i.id, i.x, i.y, i.w, i.h, !!i.collapsed]).sort((a, b) => a[0].localeCompare(b[0])));

/** Whether built-in layout `name` has a changed copy in `today.layouts` that differs from the preset. */
export function layoutChanged(today, name) {
  if (!own(PRESETS, name) || !own(today?.layouts, name)) return false;
  return shape(today.layouts[name]) !== shape(PRESETS[name]);
}

/** What `layout_save` gets: the grid, with `layouts[active]` the same as `items`, and `layout`, the
 *  ids by row then column, for code that still reads it. */
export function payloadOf(today) {
  const t = clone(today);
  t.layouts = { ...t.layouts, [t.active]: clone(t.items) };
  return { today: t, layout: [...t.items].sort(byPlace).map(i => i.id) };
}

const SIZE_NAMES = { 3: 'quarter', 4: 'third', 6: 'half', 8: 'two thirds', 12: 'full width' };
export const sizeName = w => SIZE_NAMES[w] || `${w} columns`;

// A saved value counts when it has the default's type and is one of the choices.
function valid(def, v) {
  if (v === undefined || typeof v !== typeof def.def || Array.isArray(v) !== Array.isArray(def.def)) return false;
  const known = c => !def.choices || def.choices.some(([k]) => k === c);
  return Array.isArray(v) ? v.every(known) : known(v);
}

/** Widget `id`'s options: what the user saved over the defaults in `def.options`. */
export function optionsOf(today, id, def) {
  const saved = own(today?.options, id) ? today.options[id] : {};
  return Object.fromEntries((def?.options || []).map(o => [o.key, valid(o, saved?.[o.key]) ? saved[o.key] : o.def]));
}
