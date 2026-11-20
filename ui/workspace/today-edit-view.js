// Customize Today, drawn: the edit bar, the saved layouts menu, the widget gallery, each widget's
// ⋯ menu and options panel, and the "Add a widget here" tile. Pure: state in, HTML out, so
// node:test imports it. Menus are `details.ws-menu[data-menu]`, which render() keeps open.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { badge, button, checkbox, field, select, toggle } from './ui.js';
import { PRESETS, layoutChanged, optionsOf, sizeName } from './today-grid.js';

const WIDTHS = [[3, '1/4'], [4, '1/3'], [6, '1/2'], [8, '2/3'], [12, 'Full']];
const HEIGHTS = [['S', 3], ['M', 5], ['L', 7], ['XL', 9]];
const BUILT_IN = Object.keys(PRESETS);

const attrsOf = attrs => Object.entries(attrs).map(([k, v]) => ` ${k}="${e(v)}"`).join('');
const menuItem = (action, iconName, label, attrs = {}, danger = false) => `<button type="button" class="ws-menu-item${danger ? ' ws-menu-danger' : ''}" role="menuitem" data-action="${action}"${attrsOf(attrs)}>${icon(iconName)}<span>${e(label)}</span></button>`;
const place = (it, order) => `--x:${e(it.x)};--y:${e(it.y)};--w:${e(it.w)};--h:${e(it.h)};--order:${e(order)}`;

/** The saved layouts of grid `t`: the built-in ones, then the user's own (each can be deleted),
 *  Save as a new layout, and Reset while the layout in use is a changed built-in one. In the
 *  edit bar the menu is a pill naming the layout in use; on the page header (`more`) it is a ⋯
 *  that also holds Add widget and Lock (`more.locked`: the layouts are locked). */
export function layoutMenu(t, { small = false, more = null } = {}) {
  const names = [...new Set([...BUILT_IN, ...Object.keys(t.layouts || {}), t.active])];
  const changed = layoutChanged(t, t.active);
  const row = name => {
    const use = `<button type="button" class="ws-menu-item" role="menuitemradio" aria-checked="${name === t.active}" data-action="today-layout-use" data-name="${e(name)}">${icon('layout')}<span>${e(name)}</span>${layoutChanged(t, name) ? '<em class="ws-today-changed">· changed</em>' : ''}</button>`;
    if (BUILT_IN.includes(name)) return use;
    return `<div class="ws-today-layout-row">${use}<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon" data-action="today-layout-delete" data-name="${e(name)}" title="Delete this layout" aria-label="Delete “${e(name)}”">${icon('trash')}</button></div>`;
  };
  const summary = more
    ? `<summary class="ws-btn ws-btn-secondary ws-btn-icon ws-today-more" title="Layouts, Add widget, Lock" aria-label="Layouts and more" aria-haspopup="menu">${icon('dots')}</summary>`
    : `<summary class="ws-btn ws-btn-secondary${small ? ' ws-btn-sm' : ''} ws-today-layout-pill" title="Saved layouts" aria-haspopup="menu">${icon('layout')}<span>${e(t.active)}</span>${changed ? '<em class="ws-today-changed">· changed</em>' : ''}${icon('chevron-down')}</summary>`;
  const extra = more
    ? `<hr>${menuItem('today-customize', 'plus', 'Add widget', { 'data-focus': 'gallery' })}<button type="button" class="ws-menu-item" role="menuitemcheckbox" aria-checked="${!!more.locked}" aria-pressed="${!!more.locked}" data-action="today-lock">${icon('lock')}<span>${more.locked ? 'Unlock layout' : 'Lock layout'}</span></button>`
    : '';
  return `<details class="ws-menu ws-menu-right ws-today-layouts" data-menu="today-layouts">
    ${summary}
    <div class="ws-menu-panel" role="menu"><div class="ws-menu-label">Layouts</div>${names.map(row).join('')}<hr>
      <form class="ws-today-layout-save" data-form="today-layout-save"><input class="ws-input" name="name" maxlength="40" required placeholder="Save as a new layout…" aria-label="Save as a new layout" autocomplete="off">${button('Save', { type: 'submit', variant: 'primary', size: 'sm' })}</form>
      ${changed ? `<hr>${menuItem('today-layout-reset', 'undo', `Reset “${t.active}” to the original`, { 'data-name': t.active })}` : ''}${extra}
    </div></details>`;
}

/** The toolbar Customize mode shows under the header. */
export function editBar(t, { canUndo = false, canRedo = false } = {}) {
  return `<div class="ws-today-editbar" role="toolbar" aria-label="Customize Today">
    <span class="ws-today-hint">${icon('hand')}<span><strong>Customizing Today</strong><span>Drag a header to move · pull an edge or corner to resize · drag cards in from the right</span></span></span>
    ${button('Undo', { action: 'today-undo', iconName: 'undo', size: 'sm', disabled: !canUndo, title: 'Undo (⌘Z)' })}
    ${button('Redo', { action: 'today-redo', iconName: 'redo', size: 'sm', disabled: !canRedo, title: 'Redo (⇧⌘Z)' })}
    <span class="ws-today-sep" aria-hidden="true"></span>${layoutMenu(t, { small: true })}
    <span class="ws-today-sep" aria-hidden="true"></span>${button('Done', { action: 'today-done', iconName: 'check', variant: 'primary', size: 'sm' })}
  </div>`;
}

/**
 * The widget gallery: "Add to Today" (cards to drag onto the grid or Add) and "On Today · N"
 * (each with Remove). `defs` are `tileDefs`, `onToday` the ids Today draws, `query` what the
 * search holds and `titles` the names the user gave.
 */
export function gallery(defs, onToday, query = '', titles = {}) {
  const q = query.trim().toLowerCase();
  const all = Object.values(defs).filter(d => !q || `${d.title} ${d.description || ''}`.toLowerCase().includes(q));
  const free = all.filter(d => !onToday.has(d.id));
  const placed = all.filter(d => onToday.has(d.id));
  const nameOf = d => titles[d.id] || d.title;
  const add = d => `<div class="ws-gallery-card" data-gid="${e(d.id)}" data-w="${e(d.w)}" data-h="${e(d.h)}" data-title="${e(d.title)}" title="Drag onto Today, or press Add">
      <span class="ws-gallery-thumb">${icon(d.icon || 'puzzle')}<small>${e(d.w)}×${e(d.h)}</small></span>
      <div class="ws-gallery-copy"><strong>${e(d.title)}${d.plugin ? ` ${badge('Plugin', 'purple')}` : ''}</strong><p>${e(d.description || '')}</p>
        <div class="ws-gallery-row">${button('Add', { action: 'today-add', iconName: 'plus', size: 'sm', attrs: { 'data-id': d.id, 'aria-label': `Add ${d.title} to Today` } })}<span>or drag it onto Today</span></div></div>
    </div>`;
  const on = d => `<div class="ws-gallery-card ws-gallery-on" data-gid="${e(d.id)}"><span class="ws-gallery-thumb">${icon(d.icon || 'puzzle')}</span><strong>${e(nameOf(d))}</strong>${button('Remove', { action: 'today-remove', variant: 'ghost', size: 'sm', attrs: { 'data-id': d.id, 'aria-label': `Remove ${nameOf(d)} from Today` } })}</div>`;
  const list = `${free.length ? `<div class="ws-gallery-group">Add to Today</div>${free.map(add).join('')}` : q ? '' : '<p class="ws-muted ws-hint">Every widget is on Today.</p>'}
    ${placed.length ? `<div class="ws-gallery-group">On Today · ${placed.length}</div>${placed.map(on).join('')}` : ''}
    ${!free.length && !placed.length ? '<p class="ws-muted ws-hint">No widgets match.</p>' : ''}`;
  return `<aside class="ws-gallery" aria-label="Widget gallery">
    <div class="ws-gallery-head"><h2>${icon('plus')}Widgets</h2><p>Drag a card onto Today, or press Add. Plugin widgets work the same way.</p>
      <input id="today-gallery-search" class="ws-input" type="search" placeholder="Search widgets" aria-label="Search widgets" value="${e(query)}" autocomplete="off"></div>
    <div class="ws-gallery-list">${list}</div>
  </aside>`;
}

/** Widget `it`'s ⋯ menu. `name` is its title, already escaped. */
export function widgetMenu(it, name) {
  const a = { 'data-id': it.id };
  const seg = (action, key, label, list) => `<div class="ws-tile-seg" role="group" aria-label="${label}">${list.map(([value, text, pressed, tip]) => `<button type="button" data-action="${action}" data-id="${e(it.id)}" data-${key}="${value}" aria-pressed="${pressed}" title="${tip}">${text}</button>`).join('')}</div>`;
  return `<details class="ws-menu ws-menu-right ws-tile-menu" data-menu="today-w-${e(it.id)}">
    <summary class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon" aria-label="More for ${name}" title="More" aria-haspopup="menu">${icon('dots')}</summary>
    <div class="ws-menu-panel" role="menu">
      ${menuItem('today-options', 'sliders', 'Customize widget…', a)}
      ${menuItem('today-rename', 'edit', 'Rename', a)}
      <div class="ws-tile-sizes"><div class="ws-menu-label">Width</div>${seg('today-width', 'w', 'Width', WIDTHS.map(([w, text]) => [w, text, it.w === w, sizeName(w)]))}
      <div class="ws-menu-label">Height</div>${seg('today-height', 'h', 'Height', HEIGHTS.map(([text, h]) => [h, text, !it.collapsed && it.h === h, `${h} rows`]))}</div>
      <hr>
      ${menuItem('today-collapse', it.collapsed ? 'expand' : 'collapse', it.collapsed ? 'Expand' : 'Collapse to its header', a)}
      ${menuItem('today-top', 'chevron-up', 'Move to the top', a)}
      <hr>${menuItem('today-remove', 'trash', 'Remove from Today', a, true)}
    </div></details>`;
}

/**
 * The options panel of widget `it` (its def `def`) on grid `t`, drawn next to the widget: on its
 * right when there is room, else on its left, else over its right side. Title saves when the
 * field is left (or on Enter); the options save as they change. `order` is the tile's, for the
 * stacked layout.
 */
export function optionsPanel(it, def, t, order) {
  const id = it.id;
  const title = t.titles?.[id] || def.title;
  const values = optionsOf(t, id, def);
  const side = it.x + it.w <= 8 ? 'right' : it.x >= 4 ? 'left' : 'inside';
  const control = o => {
    const attrs = { 'data-id': id, 'data-key': o.key };
    if (o.type === 'toggle') return `<div class="ws-today-opt">${toggle({ name: `opt-${o.key}`, action: 'today-option', checked: !!values[o.key], label: o.label, attrs })}</div>`;
    if (o.type === 'select') return field(o.label, select(o.choices, values[o.key], { name: `opt-${o.key}`, 'data-action': 'today-option', ...attrs }));
    return `<fieldset class="ws-today-checks"><legend class="ws-field-label">${e(o.label)}</legend>${o.choices.map(([v, text]) => checkbox({ name: `opt-${o.key}-${v}`, value: v, checked: values[o.key].includes(v), label: text, action: 'today-option', attrs })).join('')}</fieldset>`;
  };
  return `<div class="ws-today-options ws-today-options-${side}" role="dialog" aria-label="Customize ${e(title)}" style="${place(it, order)}">
    <header class="ws-today-options-head"><strong>${icon(def.icon || 'sliders')}Customize</strong>${button('', { action: 'today-options', iconName: 'close', variant: 'ghost', size: 'sm', title: 'Close' })}</header>
    ${field('Title', `<input class="ws-input" name="title" data-commit="today-title" data-id="${e(id)}" value="${e(title)}" maxlength="40" autocomplete="off">`)}
    ${(def.options || []).map(control).join('') || '<p class="ws-muted ws-hint">This widget has no options of its own.</p>'}
    <p class="ws-hint ws-today-options-note">Changes show on the widget as you make them. Size and place are changed on the widget itself.</p>
    <footer class="ws-today-options-foot">${button('Reset widget', { action: 'today-reset', iconName: 'undo', variant: 'ghost', size: 'sm', attrs: { 'data-id': id } })}${button('Done', { action: 'today-options', variant: 'primary', size: 'sm' })}</footer>
  </div>`;
}

/** The tile below the grid in Customize mode, at row `rows`. */
export const addTile = rows => `<button type="button" class="ws-tile-add" data-action="today-customize" data-focus="gallery" style="--y:${e(rows)}">${icon('plus')}<span>Add a widget here — or drag one in</span></button>`;
