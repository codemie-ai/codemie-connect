// Page sections, drawn (spec "Page sections" and "Accessibility"): the row of sections, each with
// its tab strip, ⋯ menu and body, or its rail when collapsed, and a divider between two
// sections. Pure: a layout in, HTML out, so node:test imports it. `dock-controller.js` handles
// the actions and the dragging. The ⋯ menus are `details.ws-menu[data-menu]`, which render()
// keeps open.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { RAIL, minOf, normalizeDock } from './dock-model.js';

const attrsOf = attrs => Object.entries(attrs).filter(([, v]) => v !== undefined && v !== false).map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${e(v)}"`)).join('');
const menuItem = (action, iconName, label, attrs = {}) => `<button type="button" class="ws-menu-item" role="menuitem" data-action="${action}"${attrsOf(attrs)}>${icon(iconName)}<span>${e(label)}</span></button>`;
const toolButton = (action, iconName, label, attrs = {}) => `<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon" data-action="${action}" title="${e(label)}" aria-label="${e(label)}"${attrsOf(attrs)}>${icon(iconName)}</button>`;

/**
 * Page `page` drawn from `layout` (checked against definition `def`): `renderTab(id)` gives the
 * body of each open section's active tab, and `before(pane, index)` HTML above an open
 * section's tab strip. `locked` layouts draw no grips on the tabs.
 */
export function renderDock(page, def, layout, renderTab, { locked = false, before = () => '' } = {}) {
  const changed = JSON.stringify(layout) !== JSON.stringify(normalizeDock(def, null));
  const ctx = { page, def, layout, locked, changed, renderTab, before };
  const row = layout.panes.map((p, i) => `${i ? divider(ctx, i - 1) : ''}${pane(ctx, p, i)}`).join('');
  return `<div class="ws-dock${locked ? ' ws-dock-locked' : ''}" data-page="${e(page)}">${row}</div>`;
}

function pane(ctx, p, i) {
  const { page, def, layout } = ctx;
  const T = def.tabs;
  const title = T[p.active].title;
  const last = i === layout.panes.length - 1 && i > 0;
  const ids = { 'data-page': page, 'data-pane': p.id };
  const open = `<section class="ws-pane${p.collapsed ? ' ws-pane-collapsed' : ''}" data-pane="${e(p.id)}" style="flex: ${Math.round(p.w)} 1 0px; min-width: ${minOf(def, p)}px" aria-label="${e(title)} section">`;
  if (p.collapsed) {
    const tabs = p.tabs.map(t => `<button type="button" class="ws-pane-rail-tab" data-action="dock-expand"${attrsOf({ ...ids, 'data-tab': t, title: T[t].title, 'aria-label': `Open ${T[t].title}` })}>${icon(T[t].icon)}</button>`).join('');
    return `${open}
      <div class="ws-pane-rail" data-action="dock-expand"${attrsOf(ids)}>${toolButton('dock-expand', last ? 'chevron-left' : 'chevron-right', `Expand ${title}`, ids)}${tabs}<span class="ws-pane-vlabel" aria-hidden="true">${e(title)}</span></div>
    </section>`;
  }
  const body = `dock-${page}-${p.id}-body`;
  const tabs = p.tabs.map(t => {
    const on = t === p.active;
    return `<button type="button" class="ws-dock-tab" role="tab" id="dock-${e(page)}-tab-${e(t)}" data-action="dock-tab" data-page="${e(page)}" data-tab="${e(t)}" aria-selected="${on}" tabindex="${on ? 0 : -1}"${on ? ` aria-controls="${e(body)}"` : ''} title="${e(ctx.locked ? T[t].title : `${T[t].title} — drag to move this tab`)}">${ctx.locked ? '' : `<span class="ws-dock-grip" aria-hidden="true">${icon('grip')}</span>`}${icon(T[t].icon)}<span>${e(T[t].title)}</span></button>`;
  }).join('');
  const collapse = layout.panes.length > 1 ? toolButton('dock-collapse', last ? 'chevron-right' : 'chevron-left', `Collapse ${title}`, ids) : '';
  return `${open}${ctx.before(p, i)}<div class="ws-pane-strip">
      <div class="ws-pane-tabs" role="tablist" aria-label="${e(title)} section tabs">${tabs}</div>
      <div class="ws-pane-tools">${collapse}${paneMenu(ctx, p, i)}</div>
    </div>
    <div class="ws-pane-body" role="tabpanel" id="${e(body)}" aria-labelledby="dock-${e(page)}-tab-${e(p.active)}">${ctx.renderTab(p.active)}</div>
  </section>`;
}

/** The section's ⋯ menu. Pin and Show are both drawn; the controller shows the one that fits
 *  when the menu opens, as only it knows what Today shows. */
function paneMenu(ctx, p, i) {
  const { page, def, layout } = ctx;
  const T = def.tabs;
  const title = T[p.active].title;
  const ids = { 'data-page': page, 'data-pane': p.id };
  const many = layout.panes.length > 1;
  const { pin, pinTitle } = T[p.active];
  const items = [
    many ? menuItem('dock-move', 'chevron-left', 'Move section left', { ...ids, 'data-dir': '-1', disabled: i === 0 }) : '',
    many ? menuItem('dock-move', 'chevron-right', 'Move section right', { ...ids, 'data-dir': '1', disabled: i === layout.panes.length - 1 }) : '',
    p.tabs.length > 1 ? menuItem('dock-beside', 'split', `Open “${title}” beside`, ids) : '',
    many ? menuItem('dock-max', layout.max ? 'min' : 'max', layout.max ? 'Restore sections' : 'Maximize this section', ids) : '',
    many ? menuItem('dock-collapse', 'sidebar-close', 'Collapse to a rail', ids) : '',
    '<hr>',
    pin ? menuItem('dock-pin', 'pin', `Pin “${pinTitle || title}” to Today`, { ...ids, 'data-widget': pin, 'data-pin': 'add' }) : '',
    pin ? menuItem('route', 'today', `Show “${pinTitle || title}” on Today`, { 'data-route': 'today', 'data-widget': pin, 'data-pin': 'show', hidden: true }) : '',
    menuItem('dock-reset', 'layout', 'Reset page layout', { 'data-page': page, disabled: !ctx.changed }),
  ];
  return `<details class="ws-menu ws-menu-right ws-dock-menu" data-menu="dock-${e(page)}-${e(p.id)}">
      <summary class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon" data-action="dock-menu"${attrsOf({ ...ids, title: 'Section options', 'aria-label': `Options for the ${title} section`, 'aria-haspopup': 'menu' })}>${icon('dots')}</summary>
      <div class="ws-menu-panel" role="menu">${items.join('')}</div>
    </details>`;
}

/** The divider between sections `i` and `i + 1`; its value is the left section's width. */
function divider(ctx, i) {
  const { page, def, layout } = ctx;
  const A = layout.panes[i];
  const B = layout.panes[i + 1];
  const now = A.collapsed ? RAIL : Math.round(A.w);
  const minA = minOf(def, A);
  const max = A.collapsed || B.collapsed ? now : Math.max(minA, Math.round(A.w + B.w - minOf(def, B)));
  return `<div class="ws-split" role="separator" aria-orientation="vertical" tabindex="0" data-page="${e(page)}" data-split="${i}" aria-valuenow="${now}" aria-valuemin="${A.collapsed ? RAIL : minA}" aria-valuemax="${max}" aria-label="Resize ${e(def.tabs[A.active].title)} and ${e(def.tabs[B.active].title)}" title="Drag to resize · double-click to reset · Enter collapses or expands"></div>`;
}
