// Settings → Layout: the layout preferences of this Mac in one place, and the way back to the
// original arrangement of Today and of each page. Pure: state in, HTML out. The actions it
// names are the ones Today (`today-layout-*`), the page sections (`dock-reset`) and the menus
// (`layout-lock`, `layout-handles`, `sidebar-toggle`, `settings-menu-toggle`, `setting-toggle`)
// already handle.
import { escapeHtml as e } from './store.js';
import { badge, button, card, settingRow, toggle } from './ui.js';
import { PRESETS, layoutChanged } from './today-grid.js';
import { NAV } from './shell.js';

const BUILT_IN = Object.keys(PRESETS);
const HANDLES = [['hover', 'On hover'], ['always', 'Always'], ['customize', 'In Customize']];

const SHORTCUTS = [
  ['⌘\\', 'Collapse or expand the main menu'],
  ['⌘⇧\\', 'Shrink or expand the Settings menu'],
  ['⌘Z · ⇧⌘Z', 'Undo or redo a change to Today while customizing'],
  ['Arrow keys', 'Move a focused widget or section header'],
  ['Shift + arrow keys', 'Resize it'],
  ['⌥-click a Settings group', 'Keep only that group open'],
  ['⌘K', 'Ask'],
  ['⌘N', 'Quick capture'],
  ['⌘.', 'Stop an answer'],
];

function movingCard({ locked, handles }) {
  return card({
    title: 'Moving and resizing', iconName: 'sliders',
    body: `${settingRow({ title: 'Lock layouts', text: 'Nothing on Today or on a page moves or resizes until you unlock. Lock layouts in Today’s ⋯ menu does the same.', control: toggle({ action: 'layout-lock', checked: locked, attrs: { 'aria-label': 'Lock layouts' } }) })}
      ${settingRow({ title: 'Show handles', text: 'When the grips and resize edges appear.', control: `<div class="ws-segmented" role="group" aria-label="Show handles">${HANDLES.map(([value, text]) => `<button type="button" data-action="layout-handles" data-value="${value}" aria-pressed="${handles === value}">${e(text)}</button>`).join('')}</div>` })}`,
  });
}

function todayCard(today) {
  const names = [...new Set([...BUILT_IN, ...Object.keys(today.layouts || {}), today.active])];
  const row = name => {
    const used = name === today.active;
    const own = !BUILT_IN.includes(name);
    const note = layoutChanged(today, name) ? 'Changed from the original' : own ? 'Yours' : 'Built in';
    const controls = [
      used ? badge('In use', 'success') : button('Use', { action: 'today-layout-use', size: 'sm', attrs: { 'data-name': name } }),
      layoutChanged(today, name) ? button('Reset', { action: 'today-layout-reset', size: 'sm', variant: 'ghost', attrs: { 'data-name': name } }) : '',
      own ? button('Delete', { action: 'today-layout-delete', size: 'sm', variant: 'ghost', attrs: { 'data-name': name, 'aria-label': `Delete “${name}”` } }) : '',
    ].join('');
    return settingRow({ title: name, text: note, control: `<div class="ws-actions">${controls}</div>` });
  };
  return card({ title: 'Today layouts', iconName: 'layout', body: names.map(row).join('') });
}

function pagesCard({ defs = {}, layouts = {} }) {
  const row = page => {
    const def = defs[page];
    const layout = layouts[page];
    const sections = layout
      ? layout.panes.map(p => `${p.tabs.map(t => def.tabs[t]?.title || t).join(' + ')}${p.collapsed ? ' (collapsed)' : ''}`).join(' · ')
      : '';
    const title = def.title || `${page.charAt(0).toUpperCase()}${page.slice(1)}`;
    const controls = `${button('Open', { action: 'route', size: 'sm', attrs: { 'data-route': page } })}${button('Reset', { action: 'dock-reset', size: 'sm', variant: 'ghost', attrs: { 'data-page': page, 'aria-label': `Reset ${title}` } })}`;
    return settingRow({ title, text: sections, control: `<div class="ws-actions">${controls}</div>` });
  };
  return card({ title: 'Page layouts', iconName: 'layout', body: Object.keys(defs).map(row).join('') });
}

/** One switch per NAV page, plus "Ask in the menu" (ask-capture design §11); the last visible
 *  page is disabled so the menu always keeps a page. */
function menuCard(hiddenPages = [], askInMenu = true) {
  const visible = NAV.filter(([id]) => !hiddenPages.includes(id)).length;
  const rows = NAV.map(([id, label]) => {
    const hidden = hiddenPages.includes(id);
    const lastVisible = !hidden && visible === 1;
    const control = toggle({ action: 'menu-page', checked: !hidden, attrs: { 'data-page': id, 'aria-label': `Show ${label} in the menu`, disabled: lastVisible } });
    return settingRow({ title: label, control: lastVisible ? `<span title="Keep one page in the menu.">${control}</span>` : control });
  });
  const askRow = settingRow({
    title: 'Ask in the menu', text: '⌘K works either way.',
    control: toggle({ action: 'setting-toggle', checked: askInMenu, attrs: { 'data-key': 'askInMenu', 'data-setting': 'askInMenu', 'aria-label': 'Ask in the menu' } }),
  });
  return card({
    title: 'Menu', iconName: 'list',
    body: `${askRow}<p class="ws-muted ws-hint">Hidden pages leave the menu. Links and notifications still open them.</p>${rows.join('')}`,
  });
}

function menusCard({ sidebarCollapsed, menuCollapsed }) {
  return card({
    title: 'Side menus', iconName: 'sidebar-close',
    body: `${settingRow({ title: 'Collapse the main menu', text: 'Shows icons only, with a dot where a count was.', control: toggle({ action: 'sidebar-toggle', checked: sidebarCollapsed, attrs: { 'aria-label': 'Collapse the main menu' } }) })}
      ${settingRow({ title: 'Settings menu groups', text: 'Click a group name in the Settings menu to fold it. A folded group shows how many items it holds, keeps the page you are on and shows a dot when something inside needs you.' })}
      ${settingRow({ title: 'Shrink the Settings menu to icons', text: 'Drag its edge to resize it, or double-click the edge to reset its width.', control: toggle({ action: 'settings-menu-toggle', checked: menuCollapsed, attrs: { 'aria-label': 'Shrink the Settings menu to icons' } }) })}`,
  });
}

const keyboardCard = () => card({
  title: 'Keyboard', iconName: 'terminal',
  body: SHORTCUTS.map(([keys, text]) => settingRow({ title: text, control: `<kbd class="ws-kbd">${e(keys)}</kbd>` })).join(''),
});

/** The Layout tab. `prefs`: {locked, handles, sidebarCollapsed, menuCollapsed}; `docks`: {defs,
 *  layouts} by page; `today`: the Today grid ({active, layouts}). */
export function layoutPanel(s, { prefs, docks, today }) {
  return `${movingCard(prefs)}${todayCard(today)}${pagesCard(docks)}${menuCard(s.settings.hiddenPages, s.settings.askInMenu !== false)}${menusCard(prefs)}${keyboardCard()}`;
}
