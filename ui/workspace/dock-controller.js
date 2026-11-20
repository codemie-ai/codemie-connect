// Page sections, wired (spec "Page sections"): the `dock-*` actions, dragging a divider or a
// tab, the keys on dividers and tabs, and double-clicks on dividers and tab strips. Layouts are
// device preferences: `layouts.get(page)` reads one and `layouts.set(page, layout)` keeps it;
// every change is then drawn again with `render()`. The pure moves live in `dock-model.js`.
import { icon } from './icons.js';
import { trackPress } from './press.js';
import { RAIL, activateTab, minOf, moveTab, normalizeDock, paneOf, resizePair, setCollapsed, swapPanes, toggleMax, widthOf } from './dock-model.js';

const cssEscape = value => String(value).replace(/["\\]/g, '\\$&');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const closeMenu = el => el?.closest?.('details')?.removeAttribute?.('open');
const pageTitle = (page, def) => def.title || `${page.charAt(0).toUpperCase()}${page.slice(1)}`;

/**
 * Wires the page sections on `doc` and returns `{handle(action, el), setCollapsed(page, id, on)}`.
 * `defs` are the pages' definitions by page; `toast(message, tone, {label, run})`;
 * `announce(text)` the live region; `dragging(on)` holds re-renders from a drag's start until its
 * drop is drawn; `locked()` says the layouts are locked and `nudge()` says so (with Unlock);
 * `pin(widget)` puts a widget on Today and `onToday(widget)` tells whether Today shows it.
 */
export function attachDock(doc, {
  defs, layouts, render, toast = () => {}, announce = () => {}, dragging = () => {}, locked = () => false,
  nudge = () => toast('Layouts are locked', 'info'), pin = async () => {}, onToday = () => false,
}) {
  const fail = err => toast(err?.message || String(err), 'error');
  const dockOf = page => doc.querySelector?.(`.ws-dock[data-page="${cssEscape(page)}"]`) || null;
  const paneEl = (dock, id) => dock?.querySelector(`:scope > [data-pane="${cssEscape(id)}"]`) || null;
  const titleOf = (def, pane) => def.tabs[pane.active].title;
  /** `layout` with the open sections as wide as the page shows them. */
  const synced = (layout, dock) => {
    const next = JSON.parse(JSON.stringify(layout));
    for (const p of next.panes) {
      const el = !p.collapsed && paneEl(dock, p.id);
      if (el) p.w = Math.round(el.getBoundingClientRect().width);
    }
    return next;
  };
  const focusTab = (page, tab) => dockOf(page)?.querySelector(`.ws-dock-tab[data-tab="${cssEscape(tab)}"]`)?.focus();
  /** What the live region says after divider `i` of `layout` moved. */
  const widthsSaid = (def, layout, i) => [layout.panes[i], layout.panes[i + 1]].map(p => `${titleOf(def, p)} ${p.collapsed ? 'collapsed' : `${Math.round(p.w)} pixels`}`).join(', ');

  /** Keeps `next` for `page` (made from `before`) and draws it; `message` shows in a toast whose
   *  Undo brings `before` back. False when nothing changed. */
  async function commit(page, before, next, message = '') {
    if (same(before, next)) return false;
    layouts.set(page, next);
    await render();
    if (message) toast(message, 'info', { label: 'Undo', run: () => commit(page, layouts.get(page), before) });
    return true;
  }

  /** Collapses section `id` of `page` (or the one holding tab `id`), or expands it. */
  async function collapse(page, id, on, base = layouts.get(page)) {
    const def = defs[page];
    const made = setCollapsed(base, def, id, on);
    if (made.refused) {
      toast('Keep at least one section open', 'info');
      return false;
    }
    const done = await commit(page, layouts.get(page), made.layout);
    if (done) announce(`${titleOf(def, paneOf(made.layout, id))} ${on ? 'collapsed to a rail' : 'expanded'}`);
    return done;
  }

  /** Maximizes section `id` of `page`, or, when one is, restores the sections. */
  async function maximize(page, id) {
    const def = defs[page];
    const cur = layouts.get(page);
    if (!def || !paneOf(cur, id)) return false;
    const next = toggleMax(cur, id);
    const done = await commit(page, cur, next);
    if (done) announce(next.max ? `${titleOf(def, paneOf(next, id))} maximized` : 'Sections restored');
    return done;
  }

  /** Runs a `dock-*` action from `el` (a tab, a section's button or menu item). */
  async function handle(action, el = { dataset: {} }) {
    const data = el.dataset || {};
    const page = data.page || el.closest?.('[data-page]')?.dataset.page;
    const def = defs[page];
    if (!def) throw new Error('This action is not available. Refresh the view and try again.');
    const cur = layouts.get(page);
    switch (action) {
      case 'dock-tab': return commit(page, cur, activateTab(cur, data.tab));
      case 'dock-collapse':
        closeMenu(el);
        return collapse(page, data.pane, true);
      case 'dock-expand': {
        const done = await collapse(page, data.pane, false, data.tab ? activateTab(cur, data.tab) : cur);
        const p = paneOf(layouts.get(page), data.pane);
        if (done && p) focusTab(page, p.active);
        return done;
      }
      case 'dock-menu': {
        const menu = el.closest?.('details');
        if (!menu) return false;
        if (!menu.open) showPins(menu);
        menu.open = !menu.open;
        return true;
      }
      case 'dock-move': {
        closeMenu(el);
        const done = await commit(page, cur, swapPanes(cur, data.pane, Number(data.dir)));
        if (done) announce(`${titleOf(def, paneOf(cur, data.pane))} moved ${Number(data.dir) < 0 ? 'left' : 'right'}`);
        return done;
      }
      case 'dock-max':
        closeMenu(el);
        return maximize(page, data.pane);
      case 'dock-beside': {
        closeMenu(el);
        const base = synced(cur, dockOf(page));
        const p = paneOf(base, data.pane);
        if (!p) return false;
        const made = moveTab(base, def, p.active, { type: 'split', pane: p.id, side: 'right' });
        return commit(page, cur, made.layout, made.message);
      }
      case 'dock-pin':
        closeMenu(el);
        return pin(data.widget);
      case 'dock-reset':
        closeMenu(el);
        return commit(page, cur, normalizeDock(def, null), `${pageTitle(page, def)} is back to its original layout`);
      default:
        throw new Error('This action is not available. Refresh the view and try again.');
    }
  }

  /** Shows Pin or Show on Today in a section menu, by what Today shows now. */
  function showPins(menu) {
    for (const item of menu.querySelectorAll('[data-pin]')) item.hidden = (item.dataset.pin === 'show') !== !!onToday(item.dataset.widget);
  }

  // ---------------------------------------------------------------- dragging

  // Drags from their start until their drop is drawn. Re-renders are held while there is one,
  // and a new press waits for none.
  let active = 0;
  const hold = on => {
    active = Math.max(0, active + (on ? 1 : -1));
    if (on && active === 1) dragging(true);
    if (!on && !active) dragging(false);
  };
  /** The drop's work; held re-renders show once it has finished. */
  const settle = work => Promise.resolve(work).catch(fail).finally(() => hold(false));
  /** A press on a locked layout: says so if it becomes a drag. */
  const refuse = (ev, options) => trackPress(ev, { ...options, onStart: () => { nudge(); return false; } });

  /** Pulls divider `i` of `page`: the two sections beside it resize, or one collapses. */
  function startSplit(ev, page, i) {
    const def = defs[page];
    if (!def) return;
    if (locked()) {
      refuse(ev, { threshold: 2 });
      return;
    }
    let dock;
    let split;
    let els;
    let base;
    let start;
    let next = null;
    let badge;
    const finish = () => {
      split?.classList.remove('ws-active', 'ws-collapse-hint');
      badge?.remove();
    };
    trackPress(ev, {
      threshold: 2,
      cursor: 'ew',
      onStart: () => {
        // A render may have replaced what was pressed while the press waited to become a drag.
        dock = dockOf(page);
        split = dock?.querySelector(`:scope > .ws-split[data-split="${i}"]`);
        base = synced(layouts.get(page), dock);
        const A = base.panes[i];
        const B = base.panes[i + 1];
        els = A && B && [paneEl(dock, A.id), paneEl(dock, B.id)];
        if (!split || !els?.[0] || !els[1]) return false;
        hold(true);
        start = els.map(el => Math.round(el.getBoundingClientRect().width));
        split.classList.add('ws-active');
        badge = doc.createElement('span');
        badge.className = 'ws-split-badge';
        split.append(badge);
        return true;
      },
      onMove: (at, { dx }) => {
        next = resizePair(base, def, i, start[0], start[1], dx);
        const pair = [next.panes[i], next.panes[i + 1]];
        pair.forEach((p, k) => {
          els[k].classList.toggle('ws-pane-collapsed', p.collapsed);
          els[k].style.flexGrow = String(Math.round(p.w));
        });
        const gone = pair.find(p => p.collapsed);
        split.classList.toggle('ws-collapse-hint', !!gone);
        split.setAttribute('aria-valuenow', String(pair[0].collapsed ? RAIL : Math.round(pair[0].w)));
        badge.textContent = gone ? `Collapse ${titleOf(def, gone)}` : `${Math.round(pair[0].w)} | ${Math.round(pair[1].w)} px`;
      },
      onEnd: () => {
        finish();
        const before = layouts.get(page);
        const gone = next && [next.panes[i], next.panes[i + 1]].find(p => p.collapsed && !paneOf(before, p.id)?.collapsed);
        // A collapse says so in its toast; a resize in the live region.
        const resized = done => { if (done && !gone) announce(widthsSaid(def, next, i)); };
        settle(next && commit(page, before, next, gone ? `${titleOf(def, gone)} collapsed to a rail` : '').then(resized));
      },
      onCancel: () => {
        finish();
        // The sections go back as they were drawn.
        settle(render());
      },
    });
  }

  /** Drags tab `tab` of `page`: onto a strip it joins that section, onto a section's side it
   *  opens beside it, onto a divider it is a new section there. A long press starts it on touch. */
  function startTab(ev, page, tab) {
    const def = defs[page];
    if (!def) return;
    const press = { threshold: 6, longPress: 300 };
    if (locked()) {
      refuse(ev, press);
      return;
    }
    let dock;
    let held;
    let base;
    let src;
    let ghost;
    let zone;
    let bar;
    let target = null;
    const T = def.tabs;
    /** Where the pointer would drop the tab, from what is under it. */
    const targetAt = at => {
      const el = doc.elementFromPoint(at.clientX, at.clientY);
      const split = el?.closest('.ws-split');
      if (split && split.parentElement === dock) {
        const k = Number(split.dataset.split);
        // A tab alone in its section is a section of its own already, next to its dividers.
        if (src.tabs.length === 1 && [k, k + 1].includes(base.panes.indexOf(src))) return null;
        const r = split.getBoundingClientRect();
        return { type: 'between', index: k + 1, zone: { left: r.left - 30, top: r.top, width: r.width + 60, height: r.height }, label: 'New section here' };
      }
      const paneNode = el?.closest('.ws-pane');
      if (!paneNode || paneNode.parentElement !== dock) return null;
      const p = base.panes.find(x => x.id === paneNode.dataset.pane);
      if (!p) return null;
      const r = paneNode.getBoundingClientRect();
      const name = T[p.active].title;
      if (p.collapsed) return p === src ? null : { type: 'merge', pane: p.id, zone: r, label: `Add to ${name}` };
      const strip = el.closest('.ws-pane-strip');
      if (strip) {
        const tabs = [...paneNode.querySelectorAll('.ws-dock-tab')];
        let index = tabs.findIndex(t => { const tr = t.getBoundingClientRect(); return at.clientX < tr.left + tr.width / 2; });
        if (index < 0) index = tabs.length;
        const ref = (tabs[index] || tabs.at(-1)).getBoundingClientRect();
        const sr = strip.getBoundingClientRect();
        return { type: 'tab', pane: p.id, index, bar: { x: tabs[index] ? ref.left - 2 : ref.right + 1, top: sr.top + 7, height: sr.height - 14 } };
      }
      const rel = (at.clientX - r.left) / r.width;
      const alone = p === src && src.tabs.length === 1;
      if (rel < 0.3 && !alone) return { type: 'split', pane: p.id, side: 'left', zone: { left: r.left, top: r.top, width: r.width * 0.45, height: r.height }, label: `Open left of ${name}` };
      if (rel > 0.7 && !alone) return { type: 'split', pane: p.id, side: 'right', zone: { left: r.left + r.width * 0.55, top: r.top, width: r.width * 0.45, height: r.height }, label: `Open beside ${name}` };
      return p === src ? null : { type: 'merge', pane: p.id, zone: r, label: `Add to ${name}` };
    };
    const show = at => {
      ghost.style.transform = `translate(${at.clientX + 12}px, ${at.clientY + 10}px)`;
      target = targetAt(at);
      // The zone and the bar sit in the section row, which may be scrolled sideways.
      const d = dock.getBoundingClientRect();
      const x = left => `${left - d.left + dock.scrollLeft}px`;
      zone.hidden = !target?.zone;
      bar.hidden = !target?.bar;
      if (target?.zone) {
        Object.assign(zone.style, { left: x(target.zone.left), top: `${target.zone.top - d.top}px`, width: `${target.zone.width}px`, height: `${target.zone.height}px` });
        zone.firstChild.textContent = target.label;
      }
      if (target?.bar) Object.assign(bar.style, { left: x(target.bar.x), top: `${target.bar.top - d.top}px`, height: `${target.bar.height}px` });
    };
    const finish = () => {
      ghost?.remove();
      zone?.remove();
      bar?.remove();
      held?.classList.remove('ws-dock-tab-held');
    };
    trackPress(ev, {
      ...press,
      cursor: 'move',
      onStart: () => {
        // The section row and the tab as the page shows them now (a render may have replaced the
        // ones pressed while the press waited for the long press or the threshold).
        dock = dockOf(page);
        held = dock?.querySelector(`.ws-dock-tab[data-tab="${cssEscape(tab)}"]`);
        if (!held) return false;
        base = synced(layouts.get(page), dock);
        src = paneOf(base, tab);
        if (!src) return false;
        hold(true);
        ghost = doc.createElement('div');
        ghost.className = 'ws-dock-ghost';
        ghost.innerHTML = icon(T[tab].icon);
        ghost.append(T[tab].title);
        zone = doc.createElement('div');
        zone.className = 'ws-dock-zone';
        zone.hidden = true;
        zone.append(doc.createElement('span'));
        bar = doc.createElement('div');
        bar.className = 'ws-dock-bar';
        bar.hidden = true;
        doc.body.append(ghost);
        dock.append(zone, bar);
        held.classList.add('ws-dock-tab-held');
        return true;
      },
      onMove: at => show(at),
      onEnd: () => {
        finish();
        const made = target && moveTab(base, def, tab, target);
        // A move says so in its toast; a reorder in the live region.
        const reordered = done => {
          const p = done && !made.message && paneOf(made.layout, tab);
          if (p) announce(`${T[tab].title} is tab ${p.tabs.indexOf(tab) + 1} of ${p.tabs.length}`);
        };
        settle(made && commit(page, layouts.get(page), made.layout, made.message).then(reordered));
      },
      onCancel: () => {
        finish();
        hold(false);
      },
    });
  }

  doc.addEventListener('pointerdown', ev => {
    if (active) return;
    const t = ev.target;
    const split = t.closest?.('.ws-dock > .ws-split');
    if (split) {
      startSplit(ev, split.dataset.page, Number(split.dataset.split));
      return;
    }
    const tab = t.closest?.('.ws-dock .ws-dock-tab');
    if (tab) startTab(ev, tab.dataset.page, tab.dataset.tab);
  });

  // ---------------------------------------------------------------- keys and double-clicks

  /** ←/→ move a divider by 24 px (80 with Shift); Enter collapses or expands the narrower side. */
  async function keySplit(ev, page, i) {
    const def = defs[page];
    if (!def || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const cur = layouts.get(page);
    const base = synced(cur, dockOf(page));
    const A = base.panes[i];
    const B = base.panes[i + 1];
    if (!A || !B) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const side = A.collapsed ? A : B.collapsed ? B : A.w <= B.w ? A : B;
      await collapse(page, side.id, !side.collapsed, base);
      return;
    }
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    if (locked()) return nudge();
    if (A.collapsed || B.collapsed) return;
    const step = (ev.key === 'ArrowLeft' ? -1 : 1) * (ev.shiftKey ? 80 : 24);
    const next = resizePair(base, def, i, A.w, B.w, step);
    if (await commit(page, cur, next)) announce(widthsSaid(def, next, i));
  }

  /** ←/→ show the tab beside in the strip; ⌥⇧←/→ move the tab to the next section, or split it
   *  out when there is none. */
  async function keyTab(ev, page, tab) {
    const def = defs[page];
    if (!def || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') || ev.metaKey || ev.ctrlKey) return;
    const cur = layouts.get(page);
    const p = paneOf(cur, tab);
    if (!p) return;
    const dir = ev.key === 'ArrowLeft' ? -1 : 1;
    if (ev.altKey && ev.shiftKey) {
      ev.preventDefault();
      if (locked()) return nudge();
      const base = synced(cur, dockOf(page));
      const from = paneOf(base, tab);
      const near = base.panes[base.panes.indexOf(from) + dir];
      const made = near ? moveTab(base, def, tab, { type: 'merge', pane: near.id })
        : from.tabs.length > 1 ? moveTab(base, def, tab, { type: 'split', pane: from.id, side: dir < 0 ? 'left' : 'right' }) : null;
      if (made && await commit(page, cur, made.layout, made.message)) focusTab(page, tab);
      return;
    }
    if (ev.altKey || ev.shiftKey) return;
    ev.preventDefault();
    const next = p.tabs[(p.tabs.indexOf(tab) + dir + p.tabs.length) % p.tabs.length];
    await commit(page, cur, activateTab(cur, next));
    focusTab(page, next);
  }

  doc.addEventListener('keydown', ev => {
    const t = ev.target;
    const split = t.closest?.('.ws-dock > .ws-split');
    if (split) keySplit(ev, split.dataset.page, Number(split.dataset.split)).catch(fail);
    const tab = !split && t.closest?.('.ws-dock .ws-dock-tab');
    if (tab) keyTab(ev, tab.dataset.page, tab.dataset.tab).catch(fail);
  });

  // A double-click on a divider gives the two sections their default widths; on a tab strip
  // (not on a tab or button) it maximizes the section, or restores the sections.
  doc.addEventListener('dblclick', ev => {
    const t = ev.target;
    const split = t.closest?.('.ws-dock > .ws-split');
    if (split) {
      resetPair(split.dataset.page, Number(split.dataset.split)).catch(fail);
      return;
    }
    const strip = t.closest?.('.ws-dock .ws-pane-strip');
    if (!strip || t.closest('button, summary, details')) return;
    maximize(strip.closest('.ws-dock').dataset.page, strip.closest('.ws-pane').dataset.pane).catch(fail);
  });

  async function resetPair(page, i) {
    const def = defs[page];
    if (!def) return;
    // Locked, the widths stay, as for ←/→ on the divider.
    if (locked()) return nudge();
    const cur = layouts.get(page);
    const base = synced(cur, dockOf(page));
    const A = base.panes[i];
    const B = base.panes[i + 1];
    if (!A || !B || A.collapsed || B.collapsed) return;
    // The narrower by default gets its default width, as far as the other's minimum allows.
    const total = A.w + B.w;
    const width = widthOf(def, A) <= widthOf(def, B) ? widthOf(def, A) : total - widthOf(def, B);
    const next = resizePair(base, def, i, A.w, B.w, Math.max(minOf(def, A), width) - A.w);
    if (await commit(page, cur, next)) announce(`${titleOf(def, A)} and ${titleOf(def, B)} are back to their default widths`);
  }

  // A section menu opened by the page's re-render shows Pin or Show as Today is now.
  doc.addEventListener('toggle', ev => {
    if (ev.target.matches?.('details.ws-dock-menu') && ev.target.open) showPins(ev.target);
  }, true);

  return { handle, setCollapsed: (page, id, on) => collapse(page, id, on) };
}
