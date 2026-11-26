// Sidebar and topbar markup. Pure: takes a view state and returns HTML, so node:test can import it.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { avatar, button } from './ui.js';
import { active, attentionMessages, decisions, syncShown } from './selectors.js';
import { agoLabel } from './format.js';
import { taskStatus } from './tasks-model.js';
import { meetingCounts } from './meetings-model.js';
import { askField, askInMenu, askRailButton } from './ask-model.js';

export const NAV = [['today', 'Today'], ['inbox', 'Inbox'], ['calendar', 'Calendar'], ['meetings', 'Meetings'], ['tasks', 'Tasks'], ['automations', 'Automations'], ['analytics', 'Analytics']];
/** The main menu's groups under Today (spec docs/superpowers/specs/2026-11-20-grouped-menu-design.md);
 *  the plugins' pages make a third, last group. `icon` stands for a folded group on the rail. */
export const NAV_GROUPS = [
  { id: 'work', label: 'Work', icon: 'board', pages: ['inbox', 'calendar', 'meetings', 'tasks'] },
  { id: 'ai', label: 'AI', icon: 'sparkles', pages: ['automations', 'analytics'] },
];
const PLUGINS_GROUP = { id: 'plugins', label: 'Plugins', icon: 'puzzle' };
/** Plugins starts folded when more plugins than this add pages. */
export const PLUGINS_OPEN_UP_TO = 3;
const NAV_LABEL = Object.fromEntries(NAV);

/** NAV ids not hidden, in NAV order. */
export function visiblePages(hiddenPages = []) {
  return NAV.map(([id]) => id).filter(id => !hiddenPages.includes(id));
}

/** The first visible page in menu order, else 'today' (the fallback if every page were hidden,
 *  which Settings › Layout's last-visible guard never actually allows). */
export function firstVisiblePage(hiddenPages = []) {
  return visiblePages(hiddenPages)[0] || 'today';
}

/** `hiddenPages` with `id` hidden (`visible` false) or shown (`visible` true), in NAV order,
 *  never duplicated. */
export function toggleHiddenPage(hiddenPages, id, visible) {
  const set = new Set(hiddenPages);
  if (visible) set.delete(id); else set.add(id);
  return NAV.map(([pid]) => pid).filter(pid => set.has(pid));
}

/** Whether group `id` is folded: the person's click (`folded`, `codemie.sidebar.folded`), else
 *  open, but Plugins folded when more than three plugins add pages. */
export function groupFolded(id, folded = {}, plugins = 0) {
  if (typeof folded?.[id] === 'boolean') return folded[id];
  return id === 'plugins' && plugins > PLUGINS_OPEN_UP_TO;
}

/** Badges added up for a folded row or group: the numbers' sum (`99+` above 99), else the first
 *  mark (a plugin's `!`), else ''. A plugin badge is its text: 1–99, `99+` or a short mark. */
export function rollUp(badges) {
  let sum = 0;
  let mark = '';
  for (const b of badges) {
    const text = String(b ?? '').trim();
    if (!text) continue;
    const n = text === '99+' ? 100 : Number(text);
    if (Number.isInteger(n) && n > 0) sum += n;
    else mark ||= text;
  }
  return sum ? (sum > 99 ? '99+' : String(sum)) : mark;
}

// A plugin's letter mark: the first letter of its name on a hue from its id.
const hueOf = id => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const markOf = a => `<span class="ws-nav-mark" style="--h:${hueOf(a.plugin)}" aria-hidden="true">${e(([...String(a.pluginName || a.label || '').trim()][0] || '?').toUpperCase())}</span>`;

export function syncStatus(s) {
  const c = s.connection;
  if (!c || c.status === 'disconnected') return `<button type="button" class="ws-sync-pill" data-action="settings-tab" data-tab="microsoft">${icon('link')}<span>Connect Microsoft 365</span></button>`;
  if (c.status !== 'connected') return `<button type="button" class="ws-sync-pill ws-warn" data-action="settings-tab" data-tab="microsoft">${icon('alert')}<span>Sign in again</span></button>`;
  if (syncShown(s)) return `<span class="ws-sync-pill">${icon('refresh', 'ws-spin')}<span>Syncing…</span></span>`;
  if (c.syncError) return `<button type="button" class="ws-sync-pill ws-warn" data-action="settings-tab" data-tab="microsoft" title="${e(c.syncError)}">${icon('alert')}<span>Partly synced</span></button>`;
  return `<span class="ws-sync-pill" title="Microsoft 365">${icon('check-circle')}<span>${c.lastSync ? `Synced ${e(agoLabel(c.lastSync, s.settings.timeZone))}` : 'Connected'}</span></span>`;
}

/** One drawn row of a group: `key` what it opens, `current` whether it is open, `badge` what
 *  it adds to a folded label, `label` for the folded label's tooltip, `mark` a plugin's. */
const row = (key, label, html, { current = false, badge = '', mark = '' } = {}) => ({ key, label, html, current, badge, mark });

/** A group: its label (a fold button) and its rows. Folded, only the row that is open stays, and
 *  the label carries what the others add up to (on the rail, a dot), and for Plugins up to four
 *  marks. On the rail an open group's label is a hairline and a folded one its icon. */
function navGroup({ id, label, icon: glyph }, rows, { folded, rail, cls = '' }) {
  if (!rows.length) return '';
  const shown = folded ? rows.filter(r => r.current) : rows;
  const away = rows.filter(r => !shown.includes(r));
  const rolled = folded ? rollUp(away.map(r => r.badge)) : '';
  const marks = folded && away.some(r => r.mark)
    ? `<span class="ws-nav-marks">${away.slice(0, 4).map(r => r.mark).join('')}${away.length > 4 ? `<i>+${away.length - 4}</i>` : ''}</span>` : '';
  const tip = folded ? `${label}: ${away.map(r => r.label).join(', ')}` : `Fold ${label}`;
  const head = `<button type="button" class="ws-nav-head" data-action="sidebar-fold" data-group="${id}" aria-expanded="${!folded}" data-tip="${e(tip)}" title="${folded ? 'Show' : 'Fold'} ${label}" aria-label="${label}${rolled ? `, ${e(rolled)} new` : ''}">${icon(glyph, 'ws-nav-head-icon')}<span class="ws-nav-head-label">${label}</span>${icon('chevron-down', 'ws-nav-chev')}${marks}${rolled ? `<small class="${rail ? 'ws-count ws-count-dot' : 'ws-count'}">${e(rolled)}</small>` : ''}</button>`;
  return `<div class="ws-nav-group${cls}" role="group" data-group="${id}" aria-label="${label}">${head}${shown.map(r => r.html).join('')}</div>`;
}

/** The plugins' rows: each enabled plugin's pages (`activities`: [{plugin, pluginName, id, label,
 *  badge}]) under one row with the plugin's mark, `current` the page open ({plugin, id}). A plugin
 *  with one page: its row is that page. With several: the row is the plugin (it opens the first
 *  page), and its pages are listed under it while one is open. Labels and badges are the plugin's
 *  text; a badge is a dot on the rail. */
function pluginRows(activities = [], current = null, rail = false) {
  const cls = rail ? 'ws-count ws-count-dot' : 'ws-count';
  const badge = text => (text ? `<small class="${cls}">${e(text)}</small>` : '');
  const byPlugin = new Map();
  for (const a of activities) byPlugin.set(a.plugin, [...(byPlugin.get(a.plugin) || []), a]);
  const isOpen = a => !!current && current.plugin === a.plugin && current.id === a.id;
  const page = (a, glyph) => `<button type="button" data-action="plugin-page" data-plugin-id="${e(a.plugin)}" data-activity="${e(a.id)}" title="${e(a.label)}" data-tip="${e(a.label)}" ${isOpen(a) ? 'aria-current="page"' : ''}>${glyph}<span>${e(a.label)}</span>${badge(a.badge)}</button>`;
  return [...byPlugin.values()].map(pages => {
    const [first] = pages;
    const here = !!current && current.plugin === first.plugin;
    const mark = markOf(first);
    const total = rollUp(pages.map(a => a.badge));
    if (pages.length === 1) return row(`plugin:${first.plugin}`, first.label, page(first, mark), { current: here, badge: total, mark });
    const name = first.pluginName || first.label;
    const head = `<button type="button" data-nav="plugin" data-action="plugin-page" data-plugin-id="${e(first.plugin)}" data-activity="${e(first.id)}" title="${e(name)}" data-tip="${e(name)}"${here ? ' class="ws-nav-in"' : ''}>${mark}<span>${e(name)}</span>${here ? '' : badge(total)}</button>`;
    const subs = here ? `<div class="ws-nav-subs">${pages.map(a => page(a, '')).join('')}</div>` : '';
    return row(`plugin:${first.plugin}`, name, head + subs, { current: here, badge: total, mark });
  });
}

/** The menu's Plugins group ('' while no enabled plugin adds a page). */
export function pluginNav(activities = [], current = null, { rail = false, folded = {} } = {}) {
  const rows = pluginRows(activities, current, rail);
  if (!rows.length) return '';
  return navGroup(PLUGINS_GROUP, rows, { folded: groupFolded('plugins', folded, rows.length), rail, cls: ' ws-plugin-nav' });
}

// state: { snapshot, route, resolvedDark, plugins: {activities, current}, settingsDot, sidebarCollapsed, sidebarFolded, now } — settingsDot: CodeMie needs the person;
// sidebarCollapsed: the menu is the 64 px rail of icons (a count becomes a dot); sidebarFolded: the
// groups folded by hand ({work, ai, plugins}); askState: the window's view state the Ask field
// draws from (its words, its list, the About chip), see ask-model.js.
export function renderShell({ snapshot: s, route, resolvedDark, plugins = {}, settingsDot = false, sidebarCollapsed = false, sidebarFolded = {}, terminals = null, now = Date.now(), meetingsHidden = null, hiddenPages = [], askState = {} }) {
  const w = active(s);
  const c = s.connection;
  const replies = attentionMessages(s).length;
  const pendingDecisions = decisions(s).length;
  const toReview = s.records.filter(r => r.kind === 'commitment' && taskStatus(r) === 'review').length;
  // Meetings: transcripts to make notes from, and meetings that need the person.
  const meetingsWaiting = (({ process, attention }) => process + attention)(meetingCounts(s, now, undefined, meetingsHidden));
  const cls = sidebarCollapsed ? 'ws-count ws-count-dot' : 'ws-count';
  const counted = { inbox: replies, tasks: toReview, meetings: meetingsWaiting };
  const countTitle = { tasks: ' title="Tasks to review"', meetings: ' title="Transcripts waiting for you"' };
  const count = id => (counted[id] ? `<small class="${cls}"${countTitle[id] || ''}>${counted[id]}</small>` : '');
  // A hidden page leaves the menu, its count and its group's roll-up — unless it is the open
  // route, drawn greyed with no count so a notification or a link can still reach it.
  const pageRow = id => {
    const hidden = hiddenPages.includes(id);
    if (hidden && id !== route) return null;
    const label = NAV_LABEL[id];
    return row(id, label, `<button type="button"${hidden ? ' class="ws-nav-hidden"' : ''} data-action="route" data-tip="${label}" data-route="${id}"${hidden ? ' title="Hidden from the menu"' : ''} ${id === route ? 'aria-current="page"' : ''}>${icon(id)}<span>${label}</span>${hidden ? '' : count(id)}</button>`, { current: id === route, badge: hidden ? '' : (counted[id] || '') });
  };
  const todayRow = pageRow('today');
  const groups = NAV_GROUPS.map(g => navGroup(g, g.pages.map(pageRow).filter(Boolean), { folded: groupFolded(g.id, sidebarFolded), rail: sidebarCollapsed })).join('');
  const settingsAlert = (c && c.status !== 'connected' && c.status !== 'disconnected') || settingsDot;
  const shortcut = `⌘\\`;
  const toggleTitle = `${sidebarCollapsed ? 'Expand' : 'Collapse'} menu`;
  const connected = c && c.status !== 'disconnected';
  return `<aside class="ws-sidebar${sidebarCollapsed ? ' ws-sidebar-rail' : ''}">
      <div class="ws-brand"><span class="ws-brand-logo" role="img" aria-label="EPAM AI/Run CodeMie Connect"><img class="ws-logo-dark" src="workspace/assets/logo-full-dark.svg" alt=""><img class="ws-logo-light" src="workspace/assets/logo-full-light.svg" alt=""></span><button type="button" class="ws-brand-toggle" data-action="sidebar-toggle" aria-expanded="${!sidebarCollapsed}" aria-label="${toggleTitle}" title="${toggleTitle} (${shortcut})" data-tip="${toggleTitle}">${icon(sidebarCollapsed ? 'chevron-right' : 'chevron-left')}</button></div>
      ${askInMenu(s) ? `<div class="ws-ask-slot">${askField(askState, s)}${askRailButton()}</div>` : ''}
      <nav class="ws-nav ws-main-nav" aria-label="Main navigation">${todayRow ? `<div class="ws-nav-group ws-nav-home">${todayRow.html}</div>` : ''}${groups}${pluginNav(plugins.activities, plugins.current, { rail: sidebarCollapsed, folded: sidebarFolded })}</nav>
      <div class="ws-sidebar-bottom">
        <button type="button" class="ws-user" data-action="settings-tab" data-tab="microsoft" title="${connected ? 'Microsoft 365 account' : 'Connect Microsoft 365'}" data-tip="${e(connected ? c.displayName : 'Connect Microsoft 365')}">
          ${avatar({ name: c?.displayName || w.name, photo: c?.photo, size: 28 })}
          <span class="ws-user-copy"><strong>${e(connected ? c.displayName : 'Personal workspace')}</strong><span>${e(connected ? (c.jobTitle || c.email) : 'Connect Microsoft 365')}</span></span>
        </button>
        <nav class="ws-nav ws-sidebar-foot" aria-label="Application"><button type="button" class="ws-nav-gear" data-action="route" data-tip="Settings" data-route="settings" aria-label="Settings${settingsAlert ? ', needs attention' : ''}" title="Settings" ${route === 'settings' ? 'aria-current="page"' : ''}>${icon('settings')}${settingsAlert ? '<span class="ws-dot-alert" aria-hidden="true"></span>' : ''}</button></nav>
      </div>
      <div class="ws-sidebar-edge" title="Drag to collapse or expand the menu" aria-hidden="true"></div>
    </aside>
    <header class="ws-topbar">
      ${button('', { action: 'sidebar-toggle', iconName: sidebarCollapsed ? 'sidebar-open' : 'sidebar-close', variant: 'ghost', title: `${toggleTitle} (${shortcut})`, attrs: { 'aria-expanded': String(!sidebarCollapsed) } })}
      <div class="ws-topbar-right">
        ${syncStatus(s)}
        ${terminals?.count ? terminalButton(terminals) : ''}
        ${button('', { action: 'sync', iconName: 'refresh', variant: 'ghost', title: 'Sync now', disabled: !c || c.status !== 'connected' })}
        ${button('', { action: 'theme-toggle', iconName: resolvedDark ? 'sun' : 'moon', variant: 'ghost', title: resolvedDark ? 'Switch to light theme' : 'Switch to dark theme' })}
        <button type="button" class="ws-btn ws-btn-ghost ws-btn-icon ws-bell" data-action="route" data-route="inbox" data-lane="decisions" aria-label="Decisions${pendingDecisions ? `: ${pendingDecisions}` : ''}" title="Decisions and failed work">${icon('bell')}${pendingDecisions ? `<span class="ws-bell-dot">${pendingDecisions}</span>` : ''}</button>
      </div>
    </header>
    <main class="ws-main" id="workspace-main"><div class="ws-page" id="workspace-page"></div></main>`;
}

/** The topbar's Terminal button (once a session has opened): shows or hides the dock; while it is
 *  hidden, a green count says how many sessions still run. */
export function terminalButton({ count = 0, running = 0, shown = false } = {}) {
  const label = `Terminal: ${count} ${count === 1 ? 'session' : 'sessions'}${running ? `, ${running} running` : ''}`;
  return `<button type="button" class="ws-btn ws-btn-ghost ws-btn-icon ws-term-toggle" data-action="terminal-toggle" aria-pressed="${shown}" aria-label="${e(label)}" title="${shown ? 'Hide the terminal' : 'Show the terminal'} (⌃\`)">${icon('terminal')}${!shown && running ? `<span class="ws-term-count" aria-hidden="true">${running}</span>` : ''}</button>`;
}
