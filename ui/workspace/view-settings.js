// Settings. Microsoft 365 is one sign-in: every source syncs automatically.
import { escapeHtml as e } from './store.js';
import { icon, microsoftLogo, teamsGlyph, outlookGlyph } from './icons.js';
import { avatar, badge, button, card, emptyState, field, select, settingRow, toggle, textInput, spinner } from './ui.js';
import { records, syncRunning, sourceCounts, chatCatalog, connectionState, tasksDueJob } from './selectors.js';
import { calendarCatalog } from './calendar-model.js';
import { formatDateTime, agoLabel } from './format.js';
import { aiPanel } from './settings-ai.js';
import { storageCard } from './settings-storage.js';
import { pluginsPage } from './settings-plugins.js';

export const SETTINGS_TABS = [
  ['Workspace', 'general', 'General', 'settings'],
  ['', 'ai', 'Claude', 'spark'],
  ['', 'microsoft', 'Microsoft 365', 'link'],
  ['', 'appearance', 'Appearance', 'palette'],
  ['', 'notifications', 'Notifications', 'bell'],
  ['', 'queues', 'Rules & schedules', 'sliders'],
  ['', 'privacy', 'Data & privacy', 'shield'],
  ['', 'plugins', 'Plugins', 'puzzle'],
  ['CodeMie', 'cm-overview', 'Overview', 'spark'],
  ['', 'cm-profiles', 'Profiles', 'user'],
  ['', 'cm-agents', 'Coding agents', 'terminal'],
  ['', 'cm-apps', 'Connected apps', 'plug'],
  ['', 'cm-health', 'Health', 'heart'],
  ['Application', 'activity', 'Activity', 'activity'],
  ['', 'updates', 'Updates & about', 'update'],
];
/** Tab ids from before the native CodeMie tabs (bookmarks, notifications, old hash links). */
export const LEGACY_TAB_REDIRECTS = { installation: 'cm-overview', tools: 'cm-agents', desktop: 'cm-apps', health: 'cm-health', usage: 'cm-overview' };

/** The tab a requested id resolves to: a current tab, a redirected old one, or General. */
export function settingsTabFor(tab) {
  const id = LEGACY_TAB_REDIRECTS[tab] || tab;
  return SETTINGS_TABS.some(([, t]) => t === id) ? id : 'general';
}

const TAB_DESCRIPTIONS = {
  'cm-overview': 'Your CodeMie account, coding agents and connected apps at a glance.',
  'cm-profiles': 'Saved sign-ins, each with the project and model it uses.',
  'cm-agents': 'Install, update and remove the coding agents CodeMie runs for you.',
  'cm-apps': 'Let the apps you already use answer with CodeMie models.',
  'cm-health': 'Checks in plain language with a fix for each problem — and every command CodeMie ran.',
  general: 'Time zone, background behaviour, optional AI and where your data is kept.',
  ai: 'Choose which Claude drafts and summarizes for you, and what it costs.',
  microsoft: 'Your calendar, Outlook and Teams — connected with one sign-in.',
  appearance: 'Choose how CodeMie Connect looks on your desktop.',
  notifications: 'Desktop reminders, critical alerts and quiet hours.',
  queues: 'Critical keywords and scheduled reminders.',
  privacy: 'What is stored on this device and how to remove it.',
  activity: 'Background work: synchronization, reminders and drafts.',
  updates: 'Version information and application updates.',
};

export function settings(s, ctx) {
  const { state, auth } = ctx;
  const tab = state.settingsTab;
  const panels = {
    general: () => generalPanel(s, state.storage),
    // A CodeMie profile's sign-in as Settings → CodeMie read it (one readiness per profile).
    ai: () => aiPanel(state.ai, { codemie: ctx.codemie?.signIn }),
    microsoft: () => microsoftPanel(s, auth),
    appearance: () => appearancePanel(s),
    notifications: () => notificationsPanel(s),
    queues: () => queuesPanel(s),
    privacy: () => privacyPanel(s),
    activity: () => activityPanel(s),
    updates: () => updatesPanel(state),
  };
  // Settings → Plugins, a plugin's page there, or one of its own sections (drawn in its frame).
  const plugins = tab === 'plugins' && ctx.plugins
    ? pluginsPage(ctx.plugins.ui, ctx.plugins.path, { status: ctx.plugins.status, sections: ctx.plugins.sections })
    : null;
  // Settings → CodeMie: panels, dots and header actions come from codemie/controller.js.
  const codemie = ctx.codemie;
  const content = plugins ? plugins.content : tab.startsWith('cm-') ? (codemie?.panel(tab) ?? '') : (panels[tab] || panels.general)();
  const label = plugins ? plugins.label : SETTINGS_TABS.find(([, id]) => id === tab)?.[2] || 'Settings';
  const description = plugins ? plugins.description : TAB_DESCRIPTIONS[tab];
  const path = ctx.plugins?.path;
  const sections = ctx.plugins?.sections || [];
  const subnav = id => (id === 'plugins' && sections.length
    ? `<div class="ws-settings-subnav" aria-label="Plugin sections">${sections.map(x => `<button type="button" data-action="plugin-section" data-plugin-id="${e(x.plugin)}" data-section="${e(x.id)}" ${tab === 'plugins' && path?.id === x.plugin && path?.section === x.id ? 'aria-current="page"' : ''}><span>${e(x.label)}</span>${x.badge ? `<small class="ws-count">${e(x.badge)}</small>` : ''}</button>`).join('')}</div>`
    : '');
  const microsoftDot = s.connection?.status && s.connection.status !== 'connected' && s.connection.status !== 'disconnected';
  const dot = id => (id === 'microsoft' && microsoftDot) || !!codemie?.tabDots?.has(id);
  // Header actions are markup from the CodeMie views, escaped there.
  const actions = tab.startsWith('cm-') || tab === 'ai' ? codemie?.headerActions?.(tab) || '' : '';
  return `<div class="ws-settings-layout">
    <aside class="ws-settings-sidebar">
      <div class="ws-settings-heading"><h1>Settings</h1><p>Preferences and connected services.</p></div>
      <nav class="ws-settings-nav" aria-label="Settings">${SETTINGS_TABS.map(([group, id, text, ico]) => `${group ? `<div class="ws-nav-label">${e(group)}</div>` : ''}<button type="button" data-action="settings-tab" data-tab="${id}" ${tab === id && !(id === 'plugins' && path?.section) ? 'aria-current="page"' : ''}>${icon(ico)}<span>${e(text)}</span>${dot(id) ? '<span class="ws-dot-alert" aria-label="Needs attention"></span>' : ''}</button>${subnav(id)}`).join('')}</nav>
    </aside>
    <section class="ws-settings-content">
      <header class="ws-settings-header${actions ? ' ws-settings-header-actions' : ''}"><div><h2>${e(label)}</h2>${description ? `<p>${e(description)}</p>` : ''}</div>${actions ? `<div class="ws-actions">${actions}</div>` : ''}</header>
      <div class="ws-settings-panels${plugins?.fill ? ' ws-settings-panels-fill' : ''}" data-plugin-clip>${content}</div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------- General

function generalPanel(s, storage = {}) {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [s.settings.timeZone];
  return card({
    title: 'Workspace preferences', iconName: 'settings',
    body: `<form class="ws-inline-form" data-form="time-zone">
        ${field('Time zone', `${textInput({ name: 'timeZone', value: s.settings.timeZone, list: 'ws-zones', required: true, autocomplete: 'off', spellcheck: 'false' })}<datalist id="ws-zones">${zones.map(z => `<option value="${e(z)}">`).join('')}</datalist>`, 'Calendar, reminders and schedules use this zone.')}
        ${button('Save', { type: 'submit', variant: 'primary' })}
        ${button('Use this Mac’s zone', { action: 'zone-detect', variant: 'ghost' })}
      </form>
      ${settingRow({ title: 'Keep running in the menu bar', text: 'Closing the window keeps Connect syncing and reminding. Quit from the menu bar stops it.', control: toggle({ action: 'setting-toggle', checked: s.settings.background, attrs: { 'data-key': 'background', 'aria-label': 'Keep running in the menu bar' } }) })}
      ${settingRow({ title: 'Launch at login', text: 'Start Connect when you sign in to your computer.', control: toggle({ action: 'setting-toggle', checked: s.settings.launchAtLogin, attrs: { 'data-key': 'launchAtLogin', 'aria-label': 'Launch at login' } }) })}
      ${settingRow({ title: 'AI reply drafts', text: 'Choose Claude Code or a CodeMie profile for drafts and summaries. Connect never sends without your review.', control: button('Claude settings', { action: 'settings-tab', iconName: 'spark', attrs: { 'data-tab': 'ai' } }) })}`,
  }) + storageCard(storage.info, storage);
}

// ---------------------------------------------------------------- Microsoft 365

const WRITE_CAPS = [
  ['calendar_write', 'Create calendar events', 'Schedule events from Connect. You review every event before it is created.', 'calendar'],
  ['mail_send', 'Reply in Outlook', 'Send Outlook replies you wrote and reviewed in Connect.', 'mail'],
  ['chat_send', 'Reply in Teams', 'Reply in existing Teams chats after review.', 'chat'],
];

function microsoftPanel(s, auth) {
  const c = s.connection;
  const state = connectionState(s, auth);
  const pending = auth.authPending;
  const error = auth.authError ? `<p class="ws-inline-note ws-error">${icon('alert')}<span>${e(auth.authError)}</span></p>` : '';
  if (!c || c.status === 'disconnected') {
    return `<section class="ws-ms-hero">
        <span class="ws-ms-hero-logo">${microsoftLogo}</span>
        <h3>Connect Microsoft 365</h3>
        <p>One sign-in brings your calendars, Outlook and Teams chats into Today, Calendar and Inbox. Nothing to pick — everything stays in sync automatically.</p>
        ${pending
    ? `<div class="ws-pending-box">${spinner('Waiting for Microsoft sign-in')}<div><strong>Finish signing in in your browser</strong><span>A Microsoft sign-in page opened. Come back here when it says you're signed in.</span></div>${button('Cancel', { action: 'graph-cancel' })}</div>`
    : button('Sign in with Microsoft', { action: 'graph-connect', variant: 'primary', size: 'lg' })}
        ${error}
      </section>
      ${whatWeRead(s)}
      ${advancedRegistration(s)}`;
  }
  const counts = sourceCounts(s);
  const calendars = calendarCatalog(s);
  const chats = chatCatalog(s);
  const running = syncRunning(s);
  const needsLogin = c.status !== 'connected';
  const subtitle = [c.jobTitle, c.department].filter(Boolean).join(' · ');
  const status = needsLogin ? badge('Sign in again', 'warning', 'alert') : running ? badge('Syncing', 'info', 'refresh') : badge('Connected', 'success', 'check');
  const account = `<section class="ws-account">
      ${avatar({ name: c.displayName, photo: c.photo, size: 64 })}
      <div class="ws-account-copy">
        <div class="ws-account-name"><strong>${e(c.displayName)}</strong>${status}</div>
        ${subtitle ? `<span>${e(subtitle)}</span>` : ''}
        <span class="ws-muted">${e(c.email)}${c.officeLocation ? ` · ${e(c.officeLocation)}` : ''}</span>
      </div>
      <div class="ws-account-actions">
        ${needsLogin
    ? (pending ? `${button('Waiting for browser…', { disabled: true, iconName: 'refresh' })}${button('Cancel', { action: 'graph-cancel', variant: 'ghost' })}` : button('Sign in again', { action: 'graph-connect', variant: 'primary', iconName: 'link' }))
    : button(running ? 'Syncing…' : 'Sync now', { action: 'sync', iconName: 'refresh', disabled: running })}
        ${button('Sign out', { action: 'graph-disconnect', variant: 'ghost', iconName: 'logout' })}
      </div>
    </section>
    ${error}
    ${c.syncError ? `<p class="ws-inline-note ws-warning">${icon('alert')}<span>${e(c.syncError)}</span></p>` : ''}`;
  const synced = card({
    title: 'Synced automatically', iconName: 'refresh',
    actions: `<span class="ws-muted ws-hint">${c.lastSync ? `Last sync ${e(agoLabel(c.lastSync, s.settings.timeZone))}` : running ? 'First sync in progress…' : 'Waiting for first sync'}</span>`,
    body: `<div class="ws-source-list">
      ${sourceRow(icon('calendar'), 'Calendar', calendars.length ? `${calendars.length} calendar${calendars.length === 1 ? '' : 's'} · ${counts.events} events` : 'Discovering calendars…', c.enabled.includes('calendar'))}
      ${sourceRow(outlookGlyph, 'Outlook', `Inbox and Sent · ${counts.mail} messages`, c.enabled.includes('mail'))}
      ${sourceRow(teamsGlyph, 'Teams', chats.length ? `${chats.length} recent chats · ${counts.chat} messages` : 'Discovering chats…', c.enabled.includes('chats'))}
    </div>
    ${settingRow({ title: 'Message history', text: 'How far back Outlook and Teams are read on first sync.', control: select([[1, '1 day'], [7, '7 days'], [30, '30 days'], [90, '90 days']], s.settings.syncDays, { 'data-action': 'sync-days', 'aria-label': 'Message history' }) })}`,
  });
  const permissions = card({
    title: 'Allow actions', iconName: 'shield',
    body: `<p class="ws-muted ws-hint">Connect reads only by default. Turn on an action and Microsoft asks you to approve it once. Every action is shown for review before anything is sent.</p>
      ${WRITE_CAPS.map(([cap, title, text, ico]) => settingRow({ iconName: ico, title, text, control: toggle({ action: 'graph-permission', checked: c.enabled.includes(cap), attrs: { 'data-cap': cap, 'aria-label': title, disabled: needsLogin || pending } }) })).join('')}`,
  });
  return account + synced + permissions + advancedRegistration(s);
}

function sourceRow(glyph, title, text, enabled) {
  return `<div class="ws-source-row"><span class="ws-source-glyph">${glyph}</span><div><strong>${e(title)}</strong><span>${e(text)}</span></div>${enabled ? badge('Read', 'success', 'check') : badge('Off', 'neutral')}</div>`;
}

function whatWeRead(s) {
  return card({
    title: 'What Connect reads', iconName: 'eye',
    body: `<div class="ws-source-list">
      ${sourceRow(icon('calendar'), 'Calendar', 'Every calendar you own or share, with Teams links', true)}
      ${sourceRow(outlookGlyph, 'Outlook', `Inbox and Sent, last ${s.settings.syncDays} days`, true)}
      ${sourceRow(teamsGlyph, 'Teams', 'Your recently active chats and mentions', true)}
    </div>
    <p class="ws-muted ws-hint">${icon('lock')} Sign-in uses the shared CodeMie Microsoft app with your own browser session. Tokens stay in Connect’s private files on this device and never reach the window or CodeMie servers.</p>`,
  });
}

function advancedRegistration(s) {
  return `<details class="ws-advanced"><summary>${icon('chevron-right')}Advanced: application registration</summary>
    <form class="ws-inline-form" data-form="registration">
      ${field('Public client ID', textInput({ name: 'clientId', value: s.settings.clientId, required: true, spellcheck: 'false' }))}
      ${field('Tenant', textInput({ name: 'tenant', value: s.settings.tenant, required: true, spellcheck: 'false' }), 'common, organizations, consumers or a tenant ID. Changing it requires signing in again.')}
      ${button('Save registration', { type: 'submit' })}
    </form>
  </details>`;
}

// ---------------------------------------------------------------- Appearance

function appearancePanel(s) {
  const choice = theme => `<button type="button" class="ws-theme-choice" data-action="theme" data-theme="${theme}" aria-pressed="${s.settings.theme === theme}">
    <span class="ws-theme-preview${theme === 'system' ? ' ws-theme-preview-system' : ''}">${theme === 'system' ? '<img src="workspace/assets/light-theme-card.svg" alt=""><img src="workspace/assets/dark-theme-card.svg" alt="">' : `<img src="workspace/assets/${theme}-theme-card.svg" alt="">`}</span>
    <span class="ws-theme-label"><span class="ws-radio-dot" aria-hidden="true"></span>${theme[0].toUpperCase() + theme.slice(1)}</span>
  </button>`;
  return card({ title: 'Theme', iconName: 'palette', body: `<div class="ws-theme-options">${['light', 'dark', 'system'].map(choice).join('')}</div><p class="ws-muted ws-hint">System follows your operating-system appearance.</p>` });
}

// ---------------------------------------------------------------- Notifications

function notificationsPanel(s) {
  const permission = { granted: ['Allowed', 'success'], os_managed: ['Managed by macOS', 'success'], denied: ['Blocked', 'error'], not_requested: ['Not requested', 'neutral'] }[s.settings.notificationPermission] || ['Unknown', 'neutral'];
  return card({
    title: 'Desktop notifications', iconName: 'bell',
    actions: badge(permission[0], permission[1]),
    body: `${settingRow({ title: 'System permission', text: 'macOS Focus and Do Not Disturb decide what appears on screen.', control: `${button('Allow notifications', { action: 'notification-permission', variant: 'primary' })}${button('Send test', { action: 'notification-test', variant: 'ghost' })}` })}
      ${settingRow({ title: 'Desktop reminders', text: 'Meeting reminders and scheduled reminders. Each one is also kept in Activity.', control: toggle({ action: 'setting-toggle', checked: s.settings.notifications, attrs: { 'data-key': 'notifications', 'aria-label': 'Desktop reminders' } }) })}
      ${settingRow({ title: 'Repeat critical alerts once', text: 'One more reminder two minutes later unless you acknowledge it.', control: toggle({ action: 'setting-toggle', checked: s.settings.criticalRepeat, attrs: { 'data-key': 'criticalRepeat', 'aria-label': 'Repeat critical alerts' } }) })}
      ${settingRow({ title: 'Show message previews', text: 'Off keeps titles private on the lock screen.', control: toggle({ action: 'setting-toggle', checked: s.settings.notificationPreview, attrs: { 'data-key': 'notificationPreview', 'aria-label': 'Show message previews' } }) })}
      <form class="ws-inline-form" data-form="quiet-hours">
        ${field('Quiet hours from', textInput({ type: 'time', name: 'quietStart', value: s.settings.quietStart, required: true }))}
        ${field('until', textInput({ type: 'time', name: 'quietEnd', value: s.settings.quietEnd, required: true }))}
        ${button('Save', { type: 'submit' })}
      </form>
      <p class="ws-muted ws-hint">Critical alerts can bypass Connect’s quiet hours, never macOS Focus.</p>`,
  });
}

// ---------------------------------------------------------------- Rules & schedules

function queuesPanel(s) {
  const zone = s.settings.timeZone;
  const rules = records(s, 'rule');
  const schedules = records(s, 'schedule');
  return card({
    title: 'Critical rules', iconName: 'alert',
    actions: button('Add rule', { action: 'rule-new', iconName: 'plus' }),
    body: `<p class="ws-muted ws-hint">Messages matching a rule land in Critical and can alert you. Automated senders are always excluded.</p>
      ${rules.length ? `<div class="ws-rows">${rules.map(r => `<div class="ws-row">${badge('Critical', 'error')}<div class="ws-row-main"><strong>“${e(r.data.keyword)}”</strong><span>${e(r.data.sender || 'From anyone')}</span></div>${button('', { action: 'local-delete', iconName: 'trash', variant: 'ghost', title: 'Remove rule', attrs: { 'data-kind': 'rule', 'data-id': r.id } })}</div>`).join('')}</div>` : emptyState({ iconName: 'alert', title: 'No critical rules', text: 'Add a keyword such as “production down” or a sender to watch.' })}`,
  }) + card({
    title: 'Schedules', iconName: 'clock',
    actions: button('Add schedule', { action: 'schedule-new', iconName: 'plus' }),
    body: schedules.length ? `<div class="ws-rows">${schedules.map(r => `<div class="ws-row"><span class="ws-row-icon">${icon('bell')}</span><div class="ws-row-main"><strong>${e(r.data.label || r.data.kind)}</strong><span>${e(r.data.time)} · ${r.data.weekdays ? 'Weekdays' : 'Every day'} · next ${e(formatDateTime(r.data.nextAt, zone))}</span></div>${button('', { action: 'schedule-delete', iconName: 'trash', variant: 'ghost', title: 'Remove schedule', attrs: { 'data-id': r.id } })}</div>`).join('')}</div>`
      : emptyState({ iconName: 'clock', title: 'No schedules', text: 'Schedule a daily reminder, for example to plan your day at 09:00.' }),
  });
}

// ---------------------------------------------------------------- Privacy

function privacyPanel(s) {
  return card({
    title: 'Your data stays on this device', iconName: 'shield',
    body: `<p class="ws-muted ws-hint">Workspace data lives in Connect’s own database. Microsoft sign-in is stored in Connect’s private files (macOS) or encrypted for your Windows account. CodeMie profiles and other apps are separate.</p>
      ${settingRow({ title: 'Export local data', text: 'Notes, drafts and commitments as JSON. Microsoft content and credentials are excluded.', control: button('Export', { action: 'export', iconName: 'download' }) })}
      ${settingRow({ title: 'Remove Microsoft data', text: 'Sign out and delete synchronized messages and events. Your own notes stay.', control: button('Sign out…', { action: 'graph-disconnect', variant: 'danger', disabled: !s.connection || s.connection.status === 'disconnected' }) })}`,
  });
}

// ---------------------------------------------------------------- Activity

const JOB_LABEL = {
  sync: 'Microsoft sync', reminder: 'Reminder', notification: 'Critical alert', ai_draft: 'AI reply draft', calendar_window: 'Calendar period', automation_run: 'Automation run',
  transcript_check: 'Transcript check', transcript_download: 'Transcript save', meeting_notes: 'Meeting notes',
};
/** What a job is called in Activity. */
export const jobLabel = job => (tasksDueJob(job) ? 'Tasks due today' : JOB_LABEL[job.kind] || job.kind);
const JOB_TONE = { succeeded: 'success', failed: 'error', blocked: 'warning', cancelled: 'neutral', queued: 'info', running: 'info' };

function activityPanel(s) {
  const zone = s.settings.timeZone;
  const jobs = s.jobs.slice(0, 80);
  return card({
    title: 'Background work', iconName: 'activity',
    body: jobs.length ? `<div class="ws-rows">${jobs.map(j => `<div class="ws-row">${badge(j.state, JOB_TONE[j.state] || 'neutral')}<div class="ws-row-main"><strong>${e(jobLabel(j))}</strong><span>${e(j.result || `Scheduled ${formatDateTime(j.dueAt, zone)}`)}</span></div><time class="ws-muted">${e(formatDateTime(j.dueAt, zone))}</time>${['queued', 'running'].includes(j.state) ? button('Cancel', { action: 'job-cancel', variant: 'ghost', attrs: { 'data-id': j.id } }) : ['failed', 'blocked'].includes(j.state) && !['notification', 'send', 'reminder'].includes(j.kind) ? button('Retry', { action: 'job-retry', attrs: { 'data-id': j.id } }) : ''}</div>`).join('')}</div>`
      : emptyState({ iconName: 'activity', title: 'No background work yet', text: 'Sync, reminders and drafts are recorded here.' }),
  });
}

// ---------------------------------------------------------------- Updates

function updatesPanel(state) {
  return card({
    title: 'CodeMie Connect', iconName: 'spark',
    body: `<p>Your personal workspace for Today, Calendar and Inbox — plus CodeMie AI tools.</p>
      <p class="ws-mono ws-muted">Version ${e(state.appVersion || '…')} · EPAM AI/Run CodeMie</p>
      ${settingRow({ title: 'Application updates', text: state.updateStatus || 'Connect checks for updates once a day.', control: `${button('Check now', { action: 'update-check', disabled: state.updateBusy })}${state.latestVersion ? button(`Install ${state.latestVersion}`, { action: 'update-install', variant: 'primary', disabled: state.updateBusy }) : ''}` })}`,
  });
}
