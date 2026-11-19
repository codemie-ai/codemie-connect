// Page sections (spec "Page sections"): a page is a row of sections, each holding one or more
// tabs. This is the pure model: it checks a stored layout against the page's definition, resizes
// two sections by their divider, moves a tab, collapses, maximizes and swaps sections, and reads
// and writes the layout as a preference of this device. Values in, values out; nothing here
// touches the DOM. `dock-view.js` draws a layout and `dock-controller.js` wires it.
//
// A page's definition: `{tabs: {[id]: {title, icon, min, w, pin?, pinTitle?}}, initial: [[id]]}`,
// with each tab's minimum and default width in px, and the Today widget it pins (`pin`, named
// `pinTitle`). A layout: `{panes: [{id, tabs, active, w, collapsed}], max}`. A section's `w` is a
// weight in px used as its flex-grow (a collapsed section keeps the width it comes back to), and
// `max` is what was collapsed before a section was maximized (null otherwise).

/** A collapsed section's width, in px. */
export const RAIL = 42;
/** A divider pulled past this share of a section's minimum width collapses the section. */
export const COLLAPSE_AT = 0.55;

const KEY = page => `codemie.layout.${page}.v1`;
const PANE_ID = /^p\d{1,6}$/;

const clone = v => JSON.parse(JSON.stringify(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** A section's minimum width: the largest minimum of its tabs. */
export const minOf = (def, pane) => Math.max(...pane.tabs.map(t => def.tabs[t].min));
/** A section's default width: the largest default of its tabs. */
export const widthOf = (def, pane) => Math.max(...pane.tabs.map(t => def.tabs[t].w));
/** The section with id `id`, or the one holding tab `id`. */
export const paneOf = (layout, id) => layout.panes.find(p => p.id === id) || layout.panes.find(p => p.tabs.includes(id));
const newId = panes => `p${1 + Math.max(0, ...panes.map(p => Number(String(p.id).slice(1)) || 0))}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The page's layout as designed. */
function initial(def) {
  return {
    panes: def.initial.map((tabs, i) => ({ id: `p${i + 1}`, tabs: [...tabs], active: tabs[0], w: widthOf(def, { tabs }), collapsed: false })),
    max: null,
  };
}

/**
 * Layout `saved` checked against definition `def`: unknown and repeated tabs are dropped, a
 * section left empty goes, tabs it lacks join the last section, and one section stays open.
 * Anything unreadable gives the layout as designed.
 */
export function normalizeDock(def, saved) {
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.panes)) return initial(def);
  const seen = new Set();
  const panes = [];
  for (const raw of saved.panes) {
    if (!raw || !Array.isArray(raw.tabs)) continue;
    const tabs = raw.tabs.filter(t => typeof t === 'string' && Object.hasOwn(def.tabs, t) && !seen.has(t));
    if (!tabs.length) continue;
    tabs.forEach(t => seen.add(t));
    const id = PANE_ID.test(raw.id) && !panes.some(p => p.id === raw.id) ? raw.id : null;
    const w = Number.isFinite(raw.w) && raw.w > 0 ? raw.w : widthOf(def, { tabs });
    panes.push({ id, tabs, active: tabs.includes(raw.active) ? raw.active : tabs[0], w, collapsed: raw.collapsed === true });
  }
  if (!panes.length) return initial(def);
  panes.at(-1).tabs.push(...Object.keys(def.tabs).filter(t => !seen.has(t)));
  for (const p of panes) if (!p.id) p.id = newId(panes);
  if (panes.every(p => p.collapsed)) panes.at(-1).collapsed = false;
  const max = saved.max && typeof saved.max === 'object' && !Array.isArray(saved.max)
    ? Object.fromEntries(panes.map(p => [p.id, saved.max[p.id] === true])) : null;
  return { panes, max };
}

/**
 * The divider between sections `i` and `i + 1` pulled `dx` px from where the drag began, when the
 * two were `startA` and `startB` px wide. Pulled past 55% of a section's minimum, that section
 * collapses and the other takes the room; otherwise neither goes below its minimum. One of the
 * two always stays open, so the last open section never collapses.
 */
export function resizePair(layout, def, i, startA, startB, dx) {
  const next = clone(layout);
  const A = next.panes[i];
  const B = next.panes[i + 1];
  if (!A || !B) return layout;
  const minA = minOf(def, A);
  const minB = minOf(def, B);
  const total = startA + startB;
  const a = startA + dx;
  A.collapsed = a < minA * COLLAPSE_AT;
  B.collapsed = !A.collapsed && total - a < minB * COLLAPSE_AT;
  if (A.collapsed) {
    A.w = Math.max(A.w, minA);
    B.w = total - RAIL;
  } else if (B.collapsed) {
    B.w = Math.max(B.w, minB);
    A.w = total - RAIL;
  } else {
    A.w = clamp(a, minA, total - minB);
    B.w = total - A.w;
  }
  next.max = null;
  return next;
}

/**
 * Tab `tab` moved to `target`: `{type: 'tab', pane, index}` puts it in a section's strip at
 * `index` (its own strip reorders it), `{type: 'merge', pane}` at the end of a section,
 * `{type: 'split', pane, side}` in a new section on that side of one, taking half its width, and
 * `{type: 'between', index}` in a new section where divider `index - 1` is. A section left
 * without tabs goes and its width goes to an open neighbour. `message` says what happened, or is
 * empty for a reorder or a drop that changes nothing.
 */
export function moveTab(layout, def, tab, target) {
  const unchanged = { layout, message: '' };
  const next = clone(layout);
  const T = def.tabs;
  const src = next.panes.find(p => p.tabs.includes(tab));
  const dest = target.pane && next.panes.find(p => p.id === target.pane);
  if (!src || (target.type !== 'between' && !dest)) return unchanged;
  const si = src.tabs.indexOf(tab);
  if (target.type === 'tab' && dest === src) {
    const at = clamp(target.index > si ? target.index - 1 : target.index, 0, src.tabs.length - 1);
    src.tabs.splice(si, 1);
    src.tabs.splice(at, 0, tab);
    src.active = tab;
    return same(next, layout) ? unchanged : { layout: next, message: '' };
  }
  const alone = src.tabs.length === 1;
  if (target.type === 'merge' && dest === src) return unchanged;
  if (target.type === 'split' && dest === src && alone) return unchanged;
  const left = target.type === 'between' ? next.panes[target.index - 1] : null;
  if (target.type === 'between' && (!left || (alone && [left, next.panes[target.index]].includes(src)))) return unchanged;

  src.tabs.splice(si, 1);
  if (src.active === tab) src.active = src.tabs[Math.max(0, si - 1)];
  let message;
  if (target.type === 'tab' || target.type === 'merge') {
    const joined = T[dest.active].title;
    dest.tabs.splice(target.type === 'tab' ? clamp(target.index, 0, dest.tabs.length) : dest.tabs.length, 0, tab);
    dest.active = tab;
    dest.collapsed = false;
    message = `${T[tab].title} joined the ${joined} section`;
  } else {
    const pane = { id: newId(next.panes), tabs: [tab], active: tab, w: T[tab].w, collapsed: false };
    if (target.type === 'split') {
      const half = Math.max(T[tab].min, dest.w / 2);
      pane.w = half;
      if (dest.tabs.length) dest.w = Math.max(minOf(def, dest), dest.w - half);
      next.panes.splice(next.panes.indexOf(dest) + (target.side === 'left' ? 0 : 1), 0, pane);
      message = `${T[tab].title} opened beside ${T[dest.active].title}`;
    } else {
      next.panes.splice(next.panes.indexOf(left) + 1, 0, pane);
      message = `${T[tab].title} opened beside ${T[left.active].title}`;
    }
  }
  if (!src.tabs.length) {
    const i = next.panes.indexOf(src);
    const near = [next.panes[i - 1], next.panes[i + 1]].find(p => p && !p.collapsed);
    if (near && !src.collapsed) near.w += src.w;
    next.panes.splice(i, 1);
  }
  next.max = null;
  return { layout: next, message };
}

/** Section `id` moved one place left (`dir` -1) or right (1); at the end it stays. */
export function swapPanes(layout, id, dir) {
  const i = layout.panes.findIndex(p => p.id === id);
  const j = i + Number(dir);
  if (i < 0 || j < 0 || j >= layout.panes.length || j === i) return layout;
  const next = clone(layout);
  [next.panes[i], next.panes[j]] = [next.panes[j], next.panes[i]];
  return next;
}

/**
 * Section `id` (or the one holding tab `id`) collapsed to a rail (`on`) or expanded, at no less
 * than its minimum width. `refused` when it would close the last open section.
 */
export function setCollapsed(layout, def, id, on) {
  const p = paneOf(layout, id);
  if (!p || p.collapsed === !!on) return { layout };
  if (on && !layout.panes.some(x => x !== p && !x.collapsed)) return { layout, refused: true };
  const next = clone(layout);
  const q = paneOf(next, p.id);
  q.collapsed = !!on;
  if (!on) q.w = Math.max(q.w, minOf(def, q));
  next.max = null;
  return { layout: next };
}

/** Section `id` maximized (the others collapse), or, when one is, the sections as they were. */
export function toggleMax(layout, id) {
  const next = clone(layout);
  if (next.max) {
    for (const p of next.panes) p.collapsed = next.max[p.id] === true;
    next.max = null;
    return next;
  }
  const p = paneOf(next, id);
  if (!p) return layout;
  next.max = Object.fromEntries(next.panes.map(x => [x.id, x.collapsed]));
  for (const x of next.panes) x.collapsed = x !== p;
  return next;
}

/** Tab `tab` shown in the section that holds it. */
export function activateTab(layout, tab) {
  const p = paneOf(layout, tab);
  if (!p || p.active === tab || !p.tabs.includes(tab)) return layout;
  const next = clone(layout);
  paneOf(next, tab).active = tab;
  return next;
}

/** The tabs shown now: the active tab of each open section. */
export function visibleTabs(layout) {
  return layout.panes.filter(p => !p.collapsed).map(p => p.active);
}

/**
 * Page `page`'s layout from `storage` (`{getItem}`, such as localStorage), checked against `def`.
 * Unreadable storage gives the layout as designed. When nothing is stored, `legacy`
 * (`{collapse: [tab]}`, an older build's preference) collapses those sections.
 */
export function loadDock(storage, page, def, legacy = null) {
  let raw;
  try {
    raw = storage.getItem(KEY(page));
  } catch {
    return initial(def);
  }
  if (raw === null || raw === undefined) {
    let layout = initial(def);
    for (const tab of legacy?.collapse || []) layout = setCollapsed(layout, def, tab, true).layout;
    return layout;
  }
  try {
    return normalizeDock(def, JSON.parse(raw));
  } catch {
    return initial(def);
  }
}

/** Keeps page `page`'s layout in `storage` (`{setItem}`); a storage that refuses is ignored. */
export function saveDock(storage, page, layout) {
  try {
    storage.setItem(KEY(page), JSON.stringify(layout));
  } catch { /* a preference only */ }
}
