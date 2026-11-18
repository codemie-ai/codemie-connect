// Sidebar and topbar markup. Pure: takes a view state and returns HTML, so node:test can import it.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { avatar, button } from './ui.js';
import { active, attentionMessages, decisions, syncShown } from './selectors.js';
import { agoLabel } from './format.js';
import { taskStatus } from './tasks-model.js';
import { meetingCounts } from './meetings-model.js';

export const NAV = [['today', 'Today'], ['calendar', 'Calendar'], ['meetings', 'Meetings'], ['tasks', 'Tasks'], ['inbox', 'Inbox'], ['automations', 'Automations']];

export function syncStatus(s) {
  const c = s.connection;
  if (!c || c.status === 'disconnected') return `<button type="button" class="ws-sync-pill" data-action="settings-tab" data-tab="microsoft">${icon('link')}<span>Connect Microsoft 365</span></button>`;
  if (c.status !== 'connected') return `<button type="button" class="ws-sync-pill ws-warn" data-action="settings-tab" data-tab="microsoft">${icon('alert')}<span>Sign in again</span></button>`;
  if (syncShown(s)) return `<span class="ws-sync-pill">${icon('refresh', 'ws-spin')}<span>Syncing…</span></span>`;
  if (c.syncError) return `<button type="button" class="ws-sync-pill ws-warn" data-action="settings-tab" data-tab="microsoft" title="${e(c.syncError)}">${icon('alert')}<span>Partly synced</span></button>`;
  return `<span class="ws-sync-pill" title="Microsoft 365">${icon('check-circle')}<span>${c.lastSync ? `Synced ${e(agoLabel(c.lastSync, s.settings.timeZone))}` : 'Connected'}</span></span>`;
}

/** The sidebar's Plugins group: each page an enabled plugin adds (`activities`:
 *  [{plugin, id, label}]), `current` the one open ({plugin, id}). Labels are the plugin's text. */
export function pluginNav(activities = [], current = null) {
  if (!activities.length) return '';
  return `<div class="ws-nav-group ws-plugin-nav"><div class="ws-nav-label">Plugins</div><nav class="ws-nav" aria-label="Plugins">${activities.map(a => `<button type="button" data-action="plugin-page" data-plugin-id="${e(a.plugin)}" data-activity="${e(a.id)}" title="${e(a.label)}" ${current && current.plugin === a.plugin && current.id === a.id ? 'aria-current="page"' : ''}>${icon('puzzle')}<span>${e(a.label)}</span></button>`).join('')}</nav></div>`;
}

// state: { snapshot, route, resolvedDark, plugins: {activities, current}, settingsDot, now } — settingsDot: CodeMie needs the person.
export function renderShell({ snapshot: s, route, resolvedDark, plugins = {}, settingsDot = false, now = Date.now() }) {
  const w = active(s);
  const c = s.connection;
  const replies = attentionMessages(s).length;
  const pendingDecisions = decisions(s).length;
  const toReview = s.records.filter(r => r.kind === 'commitment' && taskStatus(r) === 'review').length;
  // Meetings: transcripts to make notes from, and meetings that need the person.
  const meetingsWaiting = (({ process, attention }) => process + attention)(meetingCounts(s, now));
  const count = id => (id === 'inbox' && replies ? `<small class="ws-count">${replies}</small>`
    : id === 'tasks' && toReview ? `<small class="ws-count" title="Tasks to review">${toReview}</small>`
      : id === 'meetings' && meetingsWaiting ? `<small class="ws-count" title="Transcripts waiting for you">${meetingsWaiting}</small>` : '');
  const connected = c && c.status !== 'disconnected';
  return `<aside class="ws-sidebar">
      <div class="ws-brand" aria-label="EPAM AI/Run CodeMie Connect"><img class="ws-logo-dark" src="workspace/assets/logo-full-dark.svg" alt=""><img class="ws-logo-light" src="workspace/assets/logo-full-light.svg" alt=""></div>
      <nav class="ws-nav" aria-label="Main navigation">${NAV.map(([id, label]) => `<button type="button" data-action="route" data-route="${id}" ${id === route ? 'aria-current="page"' : ''}>${icon(id)}<span>${label}</span>${count(id)}</button>`).join('')}</nav>
      ${pluginNav(plugins.activities, plugins.current)}
      <div class="ws-sidebar-bottom">
        <nav class="ws-nav" aria-label="Application"><button type="button" data-action="route" data-route="settings" ${route === 'settings' ? 'aria-current="page"' : ''}>${icon('settings')}<span>Settings</span>${(c && c.status !== 'connected' && c.status !== 'disconnected') || settingsDot ? '<span class="ws-dot-alert" aria-label="Needs attention"></span>' : ''}</button></nav>
        <button type="button" class="ws-user" data-action="settings-tab" data-tab="microsoft" title="${connected ? 'Microsoft 365 account' : 'Connect Microsoft 365'}">
          ${avatar({ name: c?.displayName || w.name, photo: c?.photo, size: 32 })}
          <span class="ws-user-copy"><strong>${e(connected ? c.displayName : 'Personal workspace')}</strong><span>${e(connected ? (c.jobTitle || c.email) : 'Connect Microsoft 365')}</span></span>
        </button>
      </div>
    </aside>
    <header class="ws-topbar">
      <div class="ws-topbar-right">
        ${syncStatus(s)}
        ${button('', { action: 'sync', iconName: 'refresh', variant: 'ghost', title: 'Sync now', disabled: !c || c.status !== 'connected' })}
        ${button('', { action: 'theme-toggle', iconName: resolvedDark ? 'sun' : 'moon', variant: 'ghost', title: resolvedDark ? 'Switch to light theme' : 'Switch to dark theme' })}
        <button type="button" class="ws-btn ws-btn-ghost ws-btn-icon ws-bell" data-action="route" data-route="inbox" data-lane="decisions" aria-label="Decisions${pendingDecisions ? `: ${pendingDecisions}` : ''}" title="Decisions and failed work">${icon('bell')}${pendingDecisions ? `<span class="ws-bell-dot">${pendingDecisions}</span>` : ''}</button>
      </div>
    </header>
    <main class="ws-main" id="workspace-main"><div class="ws-page" id="workspace-page"></div></main>`;
}
