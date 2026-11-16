// Workspace controller: routing, native snapshot rendering, actions and the lazily mounted
// legacy CodeMie tools (installer, profiles, desktop proxy, health, analytics) under Settings.
import { createStore, escapeHtml as e } from './store.js';
import { shouldCheckForAppUpdate } from '../app-updater-utils.mjs';
import { icon } from './icons.js';
import { avatar, badge, button, toast, openModal, confirmModal, onModalClose, field, textInput, textArea, select, checkbox, toggle } from './ui.js';
import { calendarWindow, calendarCoverage, calendarIds, calendarCatalog, calendarColors } from './calendar-model.js';
import { active, attentionMessages, decisions, syncRunning, connectionState, records, LANES, messageTitle, collapseChats, messageKey, conversation } from './selectors.js';
import { dayKey, dateFromKey, agoLabel, zonedParts } from './format.js';
import { today, WIDGETS, WIDGET_IDS } from './view-today.js';
import { calendar, eventDetails, HOUR_HEIGHT } from './view-calendar.js';
import { inbox, filteredMessages, snoozeUntil } from './view-inbox.js';
import { settings, workspaces, LEGACY_TABS, SETTINGS_TABS } from './view-settings.js';

const ROUTES = ['today', 'calendar', 'inbox', 'workspaces', 'settings'];
const root = document.getElementById('workspace-app');
const legacy = document.getElementById('app');
const invoke = window.__TAURI__?.core?.invoke;
const store = invoke ? createStore(invoke) : null;

const state = {
  route: 'today', settingsTab: 'general',
  calendarMode: localPref('codemie.calendar.mode', 'week'), calendarDate: new Date(), calendarSidebar: localPref('codemie.calendar.sidebar', 'true') !== 'false',
  lane: 'reply', channel: 'all', search: '', showArchived: false, showSnoozed: false, inboxLimit: 200, selectedMessage: null, selectedKey: null,
  appVersion: '', latestVersion: null, updateStatus: '', updateBusy: false,
};
let legacyModule;
let legacyMounted = false;
let rendering = 0;
let runtimeReady = false;
let ready = false;
let deferredNotification;
let calendarScrollKey = '';
let noteTimer;
let searchTimer;
const replyInFlight = new Set();
const KEEP_FOCUS = new Set(['widget-up', 'widget-down']);

function localPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function setLocalPref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* preference only */ }
}
function hiddenCalendars() {
  try { return new Set(JSON.parse(localStorage.getItem('codemie.calendar.hidden') || '[]')); } catch { return new Set(); }
}

const snap = () => store.get().snapshot;
const auth = () => ({ authPending: !!store.get()?.authPending, authError: store.get()?.authError || null });
const current = () => active(snap());
const getRecord = (kind, id) => snap().records.find(r => r.kind === kind && r.id === id);
const modalOpen = () => !!document.querySelector('.ws-modal[open]');
const editing = () => document.activeElement?.matches?.('input:not([type=checkbox]):not([type=radio]),textarea,select');
const fail = err => toast(err?.message || String(err), 'error');

async function mutate(op, data = {}, workspaceId) {
  const scope = workspaceId ?? [...document.querySelectorAll('.ws-modal[open]')].at(-1)?.dataset.workspaceId;
  try {
    return await store.mutate(op, data, scope);
  } catch (err) {
    // Surfaces through the shared error toast, including from modal submit handlers.
    if (err?.code === 'stale_view') err.message = 'Your inbox or calendar updated while this was open. Review the latest details and try again.';
    throw err;
  } finally {
    if (ready && !modalOpen() && !legacyMounted) await render();
    flushNotification();
  }
}

function applyTheme(theme) {
  window.__cmTheme?.set(theme);
  const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.classList.add(resolved);
  const legacyToggle = document.getElementById('theme-toggle-input');
  if (legacyToggle) legacyToggle.checked = resolved === 'dark';
}

// ---------------------------------------------------------------- shell

function syncStatus(s) {
  const c = s.connection;
  if (!c || c.status === 'disconnected') return `<button type="button" class="ws-sync-pill" data-action="settings-tab" data-tab="microsoft">${icon('link')}<span>Connect Microsoft 365</span></button>`;
  if (c.status !== 'connected') return `<button type="button" class="ws-sync-pill ws-warn" data-action="settings-tab" data-tab="microsoft">${icon('alert')}<span>Sign in again</span></button>`;
  if (syncRunning(s)) return `<span class="ws-sync-pill">${icon('refresh', 'ws-spin')}<span>Syncing…</span></span>`;
  if (c.syncError) return `<button type="button" class="ws-sync-pill ws-warn" data-action="settings-tab" data-tab="microsoft" title="${e(c.syncError)}">${icon('alert')}<span>Partly synced</span></button>`;
  return `<span class="ws-sync-pill" title="Microsoft 365">${icon('check-circle')}<span>${c.lastSync ? `Synced ${e(agoLabel(c.lastSync, s.settings.timeZone))}` : 'Connected'}</span></span>`;
}

function shell() {
  const s = snap();
  const w = current();
  const c = s.connection;
  const route = state.route;
  root.dataset.route = route;
  const replies = attentionMessages(s).length;
  const pendingDecisions = decisions(s).length;
  const nav = [['today', 'Today'], ['calendar', 'Calendar'], ['inbox', 'Inbox'], ['workspaces', 'Workspaces']];
  const connected = c && c.status !== 'disconnected';
  const resolvedDark = document.documentElement.classList.contains('dark');
  root.innerHTML = `<aside class="ws-sidebar">
      <div class="ws-brand" aria-label="EPAM AI/Run CodeMie Connect"><img class="ws-logo-dark" src="workspace/assets/logo-full-dark.svg" alt=""><img class="ws-logo-light" src="workspace/assets/logo-full-light.svg" alt=""></div>
      <nav class="ws-nav" aria-label="Main navigation">${nav.map(([id, label]) => `<button type="button" data-action="route" data-route="${id}" ${id === route ? 'aria-current="page"' : ''}>${icon(id)}<span>${label}</span>${id === 'inbox' && replies ? `<small class="ws-count">${replies}</small>` : ''}</button>`).join('')}</nav>
      <div class="ws-sidebar-bottom">
        <nav class="ws-nav" aria-label="Application"><button type="button" data-action="route" data-route="settings" ${route === 'settings' ? 'aria-current="page"' : ''}>${icon('settings')}<span>Settings</span>${c && c.status !== 'connected' && c.status !== 'disconnected' ? '<span class="ws-dot-alert" aria-label="Needs attention"></span>' : ''}</button></nav>
        <button type="button" class="ws-user" data-action="settings-tab" data-tab="microsoft" title="${connected ? 'Microsoft 365 account' : 'Connect Microsoft 365'}">
          ${avatar({ name: c?.displayName || w.name, photo: c?.photo, size: 32 })}
          <span class="ws-user-copy"><strong>${e(connected ? c.displayName : 'Personal workspace')}</strong><span>${e(connected ? (c.jobTitle || c.email) : 'Connect Microsoft 365')}</span></span>
        </button>
      </div>
    </aside>
    <header class="ws-topbar">
      <div class="ws-topbar-left">
        <span class="ws-ws-dot" style="--ws-color:${e(w.color)}"></span>
        <span class="ws-select-wrap ws-workspace-switch"><select id="workspace-select" class="ws-select" aria-label="Active workspace">${s.workspaces.filter(x => !x.archived).map(x => `<option value="${e(x.id)}" ${x.id === w.id ? 'selected' : ''}>${e(x.name)}</option>`).join('')}</select>${icon('chevron-down', 'ws-select-caret')}</span>
      </div>
      <div class="ws-topbar-right">
        ${syncStatus(s)}
        ${button('', { action: 'sync', iconName: 'refresh', variant: 'ghost', title: 'Sync now', disabled: !c || c.status !== 'connected' })}
        ${button('', { action: 'theme-toggle', iconName: resolvedDark ? 'sun' : 'moon', variant: 'ghost', title: resolvedDark ? 'Switch to light theme' : 'Switch to dark theme' })}
        <button type="button" class="ws-btn ws-btn-ghost ws-btn-icon ws-bell" data-action="route" data-route="inbox" data-lane="decisions" aria-label="Decisions${pendingDecisions ? `: ${pendingDecisions}` : ''}" title="Decisions and failed work">${icon('bell')}${pendingDecisions ? `<span class="ws-bell-dot">${pendingDecisions}</span>` : ''}</button>
      </div>
    </header>
    <main class="ws-main" id="workspace-main"><div class="ws-page" id="workspace-page"></div></main>`;
}

function banners(s) {
  const out = [];
  const conn = connectionState(s, auth());
  if (conn === 'needs_login' && state.route !== 'settings') {
    out.push(`<div class="ws-banner ws-banner-warning">${icon('alert')}<div><strong>Microsoft 365 needs you to sign in again</strong><p>Your calendar, Outlook and Teams come back as soon as you do. Notes and commitments are here meanwhile.</p></div><div class="ws-actions">${button('Sign in again', { action: 'graph-connect', variant: 'primary' })}</div></div>`);
  }
  if (conn === 'other_account') {
    out.push(`<div class="ws-banner">${icon('info')}<div><strong>This workspace belongs to another Microsoft account</strong><p>Its notes and commitments are available. Use it with the signed-in account instead?</p></div><div class="ws-actions">${button('Use current account', { action: 'graph-bind', variant: 'primary' })}</div></div>`);
  }
  if (state.route === 'today' && !runtimeReady && localPref('codemie.setupBanner.dismissed', '') !== '1') {
    out.push(`<div class="ws-banner">${icon('spark')}<div><strong>Bring your AI coding tools here too</strong><p>Set up CodeMie, Claude Code or Claude Desktop whenever you’re ready.</p></div><div class="ws-actions">${button('Set up AI tools', { action: 'setup-tools', variant: 'primary' })}${button('', { action: 'setup-dismiss', iconName: 'close', variant: 'ghost', title: 'Dismiss' })}</div></div>`);
  }
  if (state.latestVersion && sessionPref('app-update-banner-dismissed') !== '1' && !(state.route === 'settings' && state.settingsTab === 'updates')) {
    out.push(`<div class="ws-banner">${icon('update')}<div><strong>CodeMie Connect ${e(state.latestVersion)} is available</strong><p>Your workspace and tool configuration are kept.</p></div><div class="ws-actions">${button('Review update', { action: 'settings-tab', variant: 'primary', attrs: { 'data-tab': 'updates' } })}${button('', { action: 'update-dismiss', iconName: 'close', variant: 'ghost', title: 'Dismiss' })}</div></div>`);
  }
  return out.join('');
}
function sessionPref(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

// ---------------------------------------------------------------- render

function captureScroll() {
  const q = sel => root.querySelector(sel);
  return {
    main: q('.ws-main')?.scrollTop || 0,
    grid: q('.ws-tg-scroll')?.scrollTop,
    schedule: q('.ws-schedule-scroll')?.scrollTop,
    list: q('.ws-inbox-items')?.scrollTop || 0,
    reader: q('.ws-read')?.closest('.ws-reader')?.scrollTop || 0,
    readerId: q('.ws-read')?.dataset.messageId,
    nav: q('.ws-settings-sidebar')?.scrollTop || 0,
    panels: q('.ws-settings-panels')?.scrollTop || 0,
    tab: q('.ws-settings-nav [aria-current=page]')?.dataset.tab,
  };
}

function restoreScroll(saved) {
  const q = sel => root.querySelector(sel);
  if (q('.ws-main')) q('.ws-main').scrollTop = saved.main;
  const grid = q('.ws-tg-scroll');
  if (grid) {
    const key = `${state.calendarMode}|${dayKey(state.calendarDate, undefined)}`;
    if (key !== calendarScrollKey || saved.grid === undefined) {
      calendarScrollKey = key;
      grid.scrollTop = Number(grid.dataset.scrollHour || 8) * HOUR_HEIGHT;
    } else {
      grid.scrollTop = saved.grid;
    }
  }
  const schedule = q('.ws-schedule-scroll');
  if (schedule) schedule.scrollTop = saved.schedule !== undefined ? saved.schedule : Number(schedule.dataset.scrollTo || 0);
  if (q('.ws-inbox-items')) q('.ws-inbox-items').scrollTop = saved.list;
  const reader = q('.ws-reader');
  if (reader && saved.readerId && q('.ws-read')?.dataset.messageId === saved.readerId) reader.scrollTop = saved.reader;
  if (q('.ws-settings-sidebar')) q('.ws-settings-sidebar').scrollTop = saved.nav;
  if (q('.ws-settings-panels') && saved.tab === state.settingsTab) q('.ws-settings-panels').scrollTop = saved.panels;
}

async function render() {
  if (!store?.get()) return;
  if (legacyMounted && legacyModule?.legacyToolsBusy()) {
    applyTheme(snap().settings.theme);
    return;
  }
  const note = document.getElementById('today-note');
  const unsavedNote = note && note.value !== note.defaultValue ? { workspaceId: note.dataset.workspaceId, text: note.value } : null;
  const reply = document.getElementById('reply-body');
  const unsavedReply = reply && reply.value !== reply.defaultValue ? { key: reply.closest('form')?.dataset.key, text: reply.value } : null;
  const revision = ++rendering;
  if (legacyMounted) {
    legacy.classList.add('hidden');
    document.body.append(legacy);
    legacyMounted = false;
  }
  const saved = captureScroll();
  const s = snap();
  applyTheme(s.settings.theme);
  shell();
  const ctx = { state, auth: auth(), hidden: hiddenCalendars(), banners: banners(s) };
  const page = document.getElementById('workspace-page');
  page.className = `ws-page ws-page-${state.route}`;
  if (state.route === 'inbox') ensureSelection(s);
  page.innerHTML = state.route === 'today' ? today(s, ctx)
    : state.route === 'calendar' ? calendar(s, ctx)
      : state.route === 'inbox' ? inbox(s, ctx)
        : state.route === 'workspaces' ? `${ctx.banners}${workspaces(s)}`
          : settings(s, ctx);
  if (unsavedNote?.workspaceId === current().id) {
    const fresh = document.getElementById('today-note');
    if (fresh) fresh.value = unsavedNote.text;
  }
  if (unsavedReply) {
    const fresh = document.getElementById('reply-body');
    if (fresh && fresh.closest('form')?.dataset.key === unsavedReply.key) fresh.value = unsavedReply.text;
  }
  restoreScroll(saved);
  if (state.route === 'settings' && document.getElementById('legacy-host')) await mountLegacy(revision);
}

async function mountLegacy(revision) {
  const host = document.getElementById('legacy-host');
  if (!runtimeReady) {
    host.innerHTML = `<section class="ws-card"><div class="ws-card-body">${`<div class="ws-empty"><span class="ws-empty-icon">${icon('tools')}</span><strong>Your CodeMie tools live here</strong><p>Prepare the CodeMie CLI to install AI tools or connect Claude Desktop. Today, Calendar and Inbox work without it.</p><div class="ws-actions">${button('Prepare CodeMie tools', { action: 'prepare-tools', variant: 'primary' })}</div></div>`}</div></section>`;
    return;
  }
  try {
    legacyModule ||= await import('../renderer.js');
    if (revision !== rendering) return;
    host.append(legacy);
    legacy.classList.remove('hidden');
    legacyMounted = true;
    await legacyModule.openLegacyTools(LEGACY_TABS[state.settingsTab]);
  } catch (err) {
    fail(err);
  }
}

function ensureSelection(s) {
  if (state.lane === 'decisions') return;
  const items = collapseChats(filteredMessages(s, state).filter(m => m.data.lane === state.lane)).items;
  // Follow the conversation when a chat's newest message changes under the selection.
  const pick = items.find(m => m.id === state.selectedMessage) || items.find(m => messageKey(m) === state.selectedKey) || items[0];
  state.selectedMessage = pick?.id || null;
  state.selectedKey = pick ? messageKey(pick) : null;
}

// ---------------------------------------------------------------- navigation

async function savePendingNote() {
  clearTimeout(noteTimer);
  const el = document.getElementById('today-note');
  if (!el || el.value === el.defaultValue) return;
  await saveNote(el);
}

async function saveNote(el) {
  const wid = el.dataset.workspaceId;
  const id = el.dataset.recordId;
  const text = el.value;
  const label = document.getElementById('note-state');
  if (label) label.textContent = 'Saving…';
  try {
    if (!text.trim()) {
      if (id) await store.mutate('local_delete', { kind: 'note', id }, wid);
      el.dataset.recordId = '';
    } else {
      const result = await store.mutate('local_save', { kind: 'note', id: id || undefined, text }, wid);
      if (result?.id) el.dataset.recordId = result.id;
    }
    el.defaultValue = text;
    if (label) label.textContent = 'Saved just now';
  } catch (err) {
    if (label) label.textContent = 'Not saved';
    fail(err);
  }
}

async function route(name, tab) {
  if (legacyMounted && legacyModule && !(await legacyModule.leaveLegacyTools())) return;
  await savePendingNote();
  state.route = ROUTES.includes(name) ? name : 'today';
  if (tab) state.settingsTab = SETTINGS_TABS.some(([, id]) => id === tab) ? tab : 'general';
  history.replaceState(null, '', `#/${state.route}${state.route === 'settings' ? `/${state.settingsTab}` : ''}`);
  await render();
  const heading = root.querySelector('h1');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
  if (state.route === 'calendar') await ensureCalendarWindow();
}

async function ensureCalendarWindow(force = false) {
  const s = snap();
  if (!s.available || !calendarIds(s).length) return;
  const window = calendarWindow(state.calendarDate, state.calendarMode);
  if (!force && calendarCoverage(s, window)) return;
  await mutate('calendar_window', window).catch(fail);
}

function todayDate() {
  return dateFromKey(dayKey(Date.now(), snap().settings.timeZone));
}

async function setCalendar(date, mode) {
  state.calendarDate = date;
  if (mode) {
    state.calendarMode = mode;
    setLocalPref('codemie.calendar.mode', mode);
  }
  await render();
  await ensureCalendarWindow();
}

function stepCalendar(direction) {
  const d = new Date(state.calendarDate);
  if (state.calendarMode === 'month') d.setMonth(d.getMonth() + direction, 1);
  else d.setDate(d.getDate() + direction * ({ day: 1, week: 7, agenda: 14 }[state.calendarMode] || 7));
  return setCalendar(d);
}

// ---------------------------------------------------------------- dialogs

function workspaceDialog(w) {
  const colors = ['#2297F6', '#7B3FBF', '#259F4C', '#F5A534', '#E46AA8', '#06B6D4', '#FE3B4C', '#5C6BC0'];
  const currentColor = w?.color || colors[0];
  openModal({
    title: w ? 'Edit workspace' : 'New workspace',
    subtitle: w ? '' : 'Its own Today layout, notes and commitments. Your Microsoft account is shared automatically.',
    body: `${field('Name', textInput({ name: 'name', value: w?.name || '', required: true, maxlength: 80, placeholder: 'e.g. Project Atlas' }))}
      <div class="ws-field"><span class="ws-field-label">Color</span><div class="ws-swatches">${[...new Set([currentColor, ...colors])].map(c => `<label class="ws-swatch" style="--swatch:${e(c)}"><input type="radio" name="color" value="${e(c)}" ${c.toLowerCase() === currentColor.toLowerCase() ? 'checked' : ''} aria-label="${e(c)}"><span></span></label>`).join('')}</div></div>`,
    submit: w ? 'Save' : 'Create workspace',
    onSubmit: async f => {
      await mutate(w ? 'workspace_update' : 'workspace_create', { name: f.get('name'), color: f.get('color') || currentColor }, w?.id);
    },
  });
}

function commitmentDialog(source) {
  openModal({
    title: 'Add a commitment',
    subtitle: source ? `From ${source.data.from || 'a message'}` : '',
    body: `${field('What will you do?', textArea(source ? `Reply to ${source.data.from || 'sender'}: ${messageTitle(source, snap())}` : '', { name: 'text', required: true, maxlength: 20000, rows: 3 }))}
      <div class="ws-form-row">${field('Owner', textInput({ name: 'owner', value: 'You', required: true }))}${field('Due date', textInput({ name: 'due', type: 'date' }), 'Optional')}</div>
      ${source?.data.text ? `<blockquote class="ws-quote">${e(source.data.text.slice(0, 400))}</blockquote>` : ''}`,
    submit: 'Add commitment',
    onSubmit: async f => {
      await mutate('local_save', { kind: 'commitment', text: f.get('text'), owner: f.get('owner'), due: f.get('due'), sourceId: source?.id, sourceRevision: source?.revision, quote: source?.data.text });
      toast('Commitment added.', 'success');
    },
  });
}

function eventDialog(ev) {
  if (!ev) return toast('This event is no longer available. Refresh the calendar.', 'error');
  const d = ev.data;
  const live = new Date(d.end).getTime() > Date.now();
  const dialog = openModal({
    title: d.title || 'Untitled event',
    body: eventDetails(snap(), ev),
    submit: null,
    cancel: 'Close',
    size: 'md',
    footerExtra: `${d.joinUrl && live ? button('Join Teams meeting', { action: 'join', variant: 'primary', iconName: 'video', attrs: { 'data-id': ev.id } }) : ''}${d.url ? button('Open in Outlook', { action: 'source', iconName: 'external', attrs: { 'data-kind': 'event', 'data-id': ev.id } }) : ''}${live && new Date(d.start).getTime() > Date.now() ? button('Remind me', { action: 'event-reminder', variant: 'ghost', iconName: 'bell', attrs: { 'data-id': ev.id } }) : ''}`,
  });
  dialog.classList.add('ws-event-modal');
  dialog.style.setProperty('--event-color', calendarColors(snap()).get(d.calendarId) || 'var(--ws-accent)');
}

function newEventDialog() {
  const s = snap();
  const calendars = calendarCatalog(s).filter(c => c.canEdit !== false);
  if (!calendars.length) return toast('No editable calendar is available yet. Sync and try again.', 'error');
  const start = new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000);
  const end = new Date(start.getTime() + 1_800_000);
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  openModal({
    title: 'New event',
    subtitle: 'You review everything before it is created in Outlook.',
    body: `${field('Title', textInput({ name: 'title', required: true, maxlength: 250, placeholder: 'Add a title' }))}
      <div class="ws-form-row">${field('Starts', textInput({ name: 'start', type: 'datetime-local', value: local(start), required: true }))}${field('Ends', textInput({ name: 'end', type: 'datetime-local', value: local(end), required: true }))}</div>
      <div class="ws-form-row">${field('Calendar', select(calendars.map(c => [c.id, c.name]), calendars.find(c => c.isDefaultCalendar)?.id, { name: 'calendarId' }))}${field('Time zone', textInput({ name: 'timeZone', value: s.settings.timeZone, required: true }))}</div>
      ${field('Attendees', textInput({ name: 'attendees', placeholder: 'name@epam.com, …' }), 'Invitations are sent to everyone listed.')}
      ${field('Description', textArea('', { name: 'body', rows: 3 }))}`,
    submit: 'Review event',
    onSubmit: async (f, dialog) => {
      const data = Object.fromEntries(f);
      data.attendees = String(data.attendees || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
      data.kind = 'event';
      data.startOffset = null;
      data.endOffset = null;
      const result = await mutate('action_prepare', data);
      dialog.close();
      reviewAction(result);
      return false;
    },
  });
}

function reviewAction(result) {
  const review = result.review || {};
  const people = review.recipients || review.attendees || [];
  openModal({
    title: 'Review before sending',
    subtitle: `${result.account || 'Microsoft 365'} · expires in 5 minutes`,
    body: `<div class="ws-review">
      <strong>${e(review.title || 'Reply')}</strong>
      ${review.start ? `<p>${e(review.start)} – ${e(review.end)} · ${e(review.timeZone)} · ${e(review.calendar)}</p>` : ''}
      ${review.invitesAttendees ? `<p class="ws-inline-note ws-warning">${icon('alert')}<span>Invitations will be sent to every attendee below.</span></p>` : ''}
      ${people.length ? `<div class="ws-field"><span class="ws-field-label">${review.attendees ? 'Attendees' : 'Recipients'}</span><div class="ws-chips">${people.map(r => `<span class="ws-chip">${e(r.emailAddress?.address || r.email || r.displayName || 'Participant')}</span>`).join('')}</div></div>` : ''}
      ${review.body ? `<div class="ws-event-preview">${e(review.body)}</div>` : ''}
      <p class="ws-muted ws-hint">Microsoft accepts the action for delivery; check Outlook or Teams for the outcome. Interrupted sends are never retried automatically.</p>
    </div>`,
    submit: review.start ? 'Create event' : 'Send reply',
    workspaceId: result.workspaceId,
    onSubmit: async () => {
      const r = await mutate('action_confirm', { actionId: result.actionId, nonce: result.nonce });
      toast(r.message || 'Sent for delivery.', 'success');
    },
  });
}

function customizeDialog() {
  const w = current();
  const order = [...w.layout, ...WIDGET_IDS.filter(id => !w.layout.includes(id))];
  const dialog = openModal({
    title: 'Customize Today',
    subtitle: `Cards for ${w.name}. Drag the arrows to reorder.`,
    body: `<div class="ws-widget-list" id="widget-order">${order.map(id => `<div class="ws-widget-row" data-widget="${id}">
      ${toggle({ name: 'widget', attrs: { value: id, 'aria-label': `Show ${WIDGETS[id].title}` }, checked: w.layout.includes(id) })}
      <div class="ws-widget-copy"><strong>${e(WIDGETS[id].title)}</strong><span>${e(WIDGETS[id].description)}</span></div>
      ${select([[4, '⅓ width'], [6, '½ width'], [8, '⅔ width'], [12, 'Full width']], w.widgetWidths?.[id] || WIDGETS[id].width, { name: `width-${id}`, 'aria-label': `${WIDGETS[id].title} width` })}
      <span class="ws-reorder">${button('', { action: 'widget-up', iconName: 'chevron-up', variant: 'ghost', title: 'Move up' })}${button('', { action: 'widget-down', iconName: 'chevron-down', variant: 'ghost', title: 'Move down' })}</span>
    </div>`).join('')}</div>`,
    submit: 'Save layout',
    onSubmit: async f => {
      const layout = [...dialog.querySelectorAll('[data-widget]')].map(row => row.dataset.widget).filter(id => f.getAll('widget').includes(id));
      const widgetWidths = Object.fromEntries(WIDGET_IDS.map(id => [id, Number(f.get(`width-${id}`))]));
      await mutate('layout_save', { layout, widgetWidths });
    },
  });
}

function scheduleDialog() {
  const s = snap();
  openModal({
    title: 'Add a schedule',
    body: `<input type="hidden" name="kind" value="reminder">
      ${field('Label', textInput({ name: 'label', value: 'Plan my day', required: true, maxlength: 120 }))}
      <div class="ws-form-row">${field('Time', textInput({ name: 'time', type: 'time', value: '09:00', required: true }))}${field('Time zone', textInput({ name: 'timeZone', value: s.settings.timeZone, required: true }))}</div>
      ${checkbox({ name: 'weekdays', label: 'Weekdays only', checked: true })}
      <p class="ws-muted ws-hint">Runs while Connect is open or in the menu bar.</p>`,
    submit: 'Add schedule',
    onSubmit: async f => mutate('schedule_save', { kind: f.get('kind'), label: f.get('label'), time: f.get('time'), timeZone: f.get('timeZone'), weekdays: f.has('weekdays'), enabled: true }),
  });
}

function ruleDialog() {
  openModal({
    title: 'Add a critical rule',
    body: `${field('Keyword or phrase', textInput({ name: 'keyword', required: true, maxlength: 200, placeholder: 'e.g. production down' }))}
      ${field('From (optional)', textInput({ name: 'sender', type: 'email', placeholder: 'name@epam.com' }), 'Leave empty to match anyone.')}`,
    submit: 'Add rule',
    onSubmit: async f => mutate('local_save', { kind: 'rule', text: `Critical: ${f.get('keyword')}`, keyword: f.get('keyword'), sender: f.get('sender'), lane: 'critical', enabled: true }),
  });
}

function disconnectDialog() {
  const c = snap().connection;
  if (!c) return toast('No Microsoft account is connected.');
  openModal({
    title: 'Sign out of Microsoft 365?',
    body: `<p class="ws-modal-text">Connect removes its sign-in for <strong>${e(c.email || c.displayName)}</strong> and stops syncing. Synchronized events and messages are deleted from this device. Your notes and commitments stay.</p>
      ${checkbox({ name: 'retain', label: 'Keep cached events and messages (read-only)' })}`,
    submit: 'Sign out',
    variant: 'danger',
    size: 'sm',
    onSubmit: async f => {
      await mutate('graph_disconnect', { retainCache: f.has('retain') });
      toast('Signed out of Microsoft 365.', 'success');
    },
  });
}

function reminderDialog(ev) {
  openModal({
    title: 'Remind me',
    subtitle: ev.data.title || 'Calendar event',
    body: `${field('When', select([[5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before']], 10, { name: 'minutes' }))}<p class="ws-muted ws-hint">Desktop reminders must be on in Settings → Notifications.</p>`,
    submit: 'Set reminder',
    size: 'sm',
    onSubmit: async f => {
      await mutate('schedule_save', { kind: 'event_reminder', eventId: ev.id, eventRevision: ev.revision, minutes: Number(f.get('minutes')) });
      toast('Reminder set.', 'success');
    },
  });
}

// ---------------------------------------------------------------- actions

async function connectMicrosoft(extra) {
  const c = snap().connection;
  const enabled = c && c.status !== 'disconnected' ? c.enabled : [];
  const capabilities = [...new Set(['calendar', 'mail', 'chats', ...enabled, ...(extra ? [extra] : [])])];
  await mutate('graph_connect', { capabilities });
  toast('A Microsoft sign-in page opened in your browser.');
}

/** Messages one list row stands for: every listed message of a Teams chat in the same lane. */
function rowMessages(id) {
  const m = getRecord('message', id);
  if (!m) return [];
  if (m.data.channel !== 'chat') return [m];
  const key = messageKey(m);
  return filteredMessages(snap(), state).filter(x => messageKey(x) === key && x.data.lane === m.data.lane);
}

/** Applies one Inbox decision to every message a row stands for, then renders once. */
async function decideRow(id, data, perMessage = () => ({})) {
  const targets = rowMessages(id);
  try {
    for (const m of targets) await store.mutate('inbox_decision', { ...data, ...perMessage(m), id: m.id });
  } finally {
    if (!modalOpen()) await render();
  }
  return targets.length;
}

function selectMessage(id) {
  const m = getRecord('message', id);
  state.selectedKey = m ? messageKey(m) : null;
  state.selectedMessage = id;
  return render().then(() => root.querySelector('.ws-inbox-row.ws-selected')?.scrollIntoView({ block: 'nearest' }));
}

async function handle(action, el) {
  const id = el.dataset.id;
  const s = snap();
  switch (action) {
    case 'route':
      if (el.dataset.lane) {
        state.lane = el.dataset.lane;
        state.selectedMessage = null;
      }
      return route(el.dataset.route || 'today');
    case 'settings-tab': return route('settings', el.dataset.tab);
    case 'setup-tools': return route('settings', 'installation');
    case 'setup-dismiss': setLocalPref('codemie.setupBanner.dismissed', '1'); return render();
    case 'update-dismiss': try { sessionStorage.setItem('app-update-banner-dismissed', '1'); } catch { /* ignore */ } return render();
    case 'update-check': return checkAppUpdate();
    case 'update-install': return confirmModal({
      title: 'Install update?', text: `Install CodeMie Connect ${state.latestVersion} and restart. Your workspace and tool configuration are kept.`, confirm: 'Update and restart',
      onConfirm: async () => {
        state.updateBusy = true;
        await invoke('workspace_installer_busy', { busy: true });
        try {
          const bridge = await import('../runner-bridge.js');
          await bridge.updater.downloadAndInstall(crypto.randomUUID(), p => { state.updateStatus = p.message || 'Downloading update…'; });
          await invoke('workspace_installer_busy', { busy: false });
          await bridge.updater.restartApp();
        } finally {
          state.updateBusy = false;
          await invoke('workspace_installer_busy', { busy: false });
        }
      },
    });
    case 'prepare-tools':
      legacyModule ||= await import('../renderer.js');
      await legacyModule.initLegacyTools();
      runtimeReady = true;
      return render();

    // Microsoft
    case 'graph-connect': return connectMicrosoft();
    case 'graph-cancel': await store.query('graph_cancel'); await store.refresh(); return render();
    case 'graph-disconnect': return disconnectDialog();
    case 'graph-bind': return mutate('graph_bind', { confirmReassignment: true });
    case 'graph-permission': {
      const cap = el.dataset.cap;
      const c = s.connection;
      if (el.checked) {
        el.checked = false;
        return confirmModal({ title: 'Allow this action?', text: 'Microsoft will open in your browser and ask you to approve the extra permission. Connect still shows every reply or event for review before sending.', confirm: 'Continue to Microsoft', onConfirm: () => connectMicrosoft(cap) });
      }
      return mutate('settings_update', { capabilities: c.enabled.filter(x => x !== cap) });
    }
    case 'sync': await mutate('sync_request'); return;
    case 'sync-days': return mutate('settings_update', { syncDays: Number(el.value) });

    // Appearance & settings
    case 'theme': return mutate('settings_update', { theme: el.dataset.theme });
    case 'theme-toggle': return mutate('settings_update', { theme: document.documentElement.classList.contains('dark') ? 'light' : 'dark' });
    case 'setting-toggle': return mutate('settings_update', { [el.dataset.key]: el.checked }).catch(err => { el.checked = !el.checked; throw err; });
    case 'zone-detect': await mutate('settings_update', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }); return toast('Time zone updated.', 'success');
    case 'focus': {
      const minutes = Number(el.dataset.minutes || 0);
      return mutate('settings_update', { focusUntil: minutes ? Math.floor(Date.now() / 1000) + minutes * 60 : null });
    }

    // Calendar
    case 'calendar-mode': return setCalendar(state.calendarDate, el.dataset.mode);
    case 'calendar-today': return setCalendar(todayDate());
    case 'calendar-prev': return stepCalendar(-1);
    case 'calendar-next': return stepCalendar(1);
    case 'calendar-goto': return setCalendar(dateFromKey(el.dataset.date), el.dataset.mode || (state.calendarMode === 'agenda' ? 'day' : undefined));
    case 'calendar-mini': {
      const d = new Date(state.calendarDate);
      d.setMonth(d.getMonth() + Number(el.dataset.step), 1);
      return setCalendar(d);
    }
    case 'calendar-refresh': await ensureCalendarWindow(true); return;
    case 'calendar-sidebar':
      state.calendarSidebar = !state.calendarSidebar;
      setLocalPref('codemie.calendar.sidebar', String(state.calendarSidebar));
      return render();
    case 'calendar-visibility': {
      const hidden = hiddenCalendars();
      if (el.checked) hidden.delete(id); else hidden.add(id);
      setLocalPref('codemie.calendar.hidden', JSON.stringify([...hidden]));
      return render();
    }
    case 'event': return eventDialog(getRecord('event', id));
    case 'join': await store.query('open_source', { id, kind: 'event', join: true }); return;
    case 'source': await store.query('open_source', { id, kind: el.dataset.kind, join: false }); return;
    case 'event-reminder': {
      const ev = getRecord('event', id);
      el.closest('dialog')?.close();
      return reminderDialog(ev);
    }
    case 'new-event': return newEventDialog();

    // Inbox
    case 'lane': state.lane = el.dataset.lane; state.selectedMessage = null; return render();
    case 'channel': state.channel = el.dataset.channel; state.selectedMessage = null; return render();
    case 'select-message': return selectMessage(id);
    case 'open-message': {
      const m = getRecord('message', id);
      if (m) {
        state.lane = m.data.lane || 'reply';
        state.channel = 'all';
        state.search = '';
        state.selectedMessage = id;
        state.selectedKey = messageKey(m);
      }
      return route('inbox');
    }
    case 'inbox-more': state.inboxLimit += 200; return render();
    case 'show-archived': state.showArchived = el.checked; return render();
    case 'show-snoozed': state.showSnoozed = el.checked; return render();
    case 'message-archive': {
      const m = getRecord('message', id);
      const restore = m?.data.lifecycle === 'archived';
      await decideRow(id, { action: restore ? 'restore' : 'archive' });
      return toast(restore ? 'Moved back to the Inbox.' : 'Marked done.', 'success');
    }
    case 'message-snooze': {
      const until = snoozeUntil(el.dataset.preset);
      el.closest('details')?.removeAttribute('open');
      const critical = rowMessages(id).some(m => m.data.lane === 'critical');
      const run = () => decideRow(id, { action: 'snooze', until }, m => (m.data.lane === 'critical' ? { confirmGlobal: true } : {}));
      if (critical) {
        return confirmModal({ title: 'Pause critical reminders?', text: 'This pauses reminders for this incident in every workspace until the chosen time. It does not acknowledge it.', confirm: 'Pause reminders', onConfirm: run });
      }
      await run();
      return toast('Snoozed.', 'success');
    }
    case 'message-lane': {
      const m = getRecord('message', id);
      const lane = el.value;
      const run = () => decideRow(id, { action: 'lane', lane }, x => (x.data.lane === 'critical' && lane !== 'critical' ? { acknowledge: true } : {}));
      if (m?.data.lane === 'critical' && lane !== 'critical') {
        el.value = m.data.lane;
        return confirmModal({ title: 'Acknowledge and move?', text: 'Acknowledging stops this incident’s pending reminders. The move applies to this workspace.', confirm: 'Acknowledge and move', onConfirm: run });
      }
      await run();
      return toast(`Moved to ${LANES.find(([k]) => k === lane)?.[1] || lane}.`, 'success');
    }
    case 'message-ack': await decideRow(id, { action: 'acknowledge' }); return;
    case 'commitment': return commitmentDialog(id ? getRecord('message', id) : null);
    case 'draft-save': {
      const field = document.getElementById('reply-body');
      const m = getRecord('message', id);
      const threadIds = new Set(conversation(s, m).map(t => t.id));
      // One draft per conversation: replace any draft kept against an older message of this chat.
      const previous = records(s, 'draft').filter(r => threadIds.has(r.data.sourceId) && !r.data.aiSuggested && r.data.sourceId !== id);
      for (const r of previous) await store.mutate('local_delete', { kind: 'draft', id: r.id });
      if (field.value.trim()) await mutate('draft_save', { text: field.value, sourceId: id, sourceRevision: m?.revision });
      else {
        const own = records(snap(), 'draft').find(r => r.data.sourceId === id && !r.data.aiSuggested);
        if (own) await mutate('local_delete', { kind: 'draft', id: own.id });
      }
      field.defaultValue = field.value;
      return toast('Draft saved on this device.', 'success');
    }
    case 'ai-probe': { const r = await mutate('ai_probe'); return toast(r.message); }
    case 'ai-pin': {
      const r = await mutate('ai_probe');
      if (!r.ready) throw new Error(r.message);
      await mutate('workspace_update', { aiProfile: 'claude-api' });
      return toast('Claude API profile pinned to this workspace.', 'success');
    }
    case 'ai-draft': await mutate('ai_draft', { sourceId: id }); return toast('AI draft requested. Load it when Activity shows it is ready.');
    case 'ai-load': {
      await store.refresh();
      const threadIds = new Set(conversation(snap(), getRecord('message', id)).map(t => t.id));
      const candidate = records(snap(), 'draft').filter(r => threadIds.has(r.data.sourceId) && r.data.aiSuggested).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!candidate) return toast('No AI draft yet. Check Activity for its status.');
      const field = document.getElementById('reply-body');
      if (field.value.trim() && field.value !== candidate.data.text) {
        return confirmModal({ title: 'Replace your text?', text: 'Load the AI draft into the editor. Review it before sending.', confirm: 'Load draft', onConfirm: () => { field.value = candidate.data.text; } });
      }
      field.value = candidate.data.text;
      return;
    }
    case 'action-detail': {
      const r = getRecord('action', id);
      if (r.data.state === 'prepared') return reviewAction({ actionId: r.id, workspaceId: r.workspaceId, nonce: r.data.nonce, account: r.data.account, review: r.data.review });
      return openModal({ title: 'Action outcome', body: `${badge(r.data.state, 'warning')}<p class="ws-modal-text">${e(r.data.message || 'This action was interrupted. Check Outlook or Teams before trying again.')}</p>`, submit: null, cancel: 'Close', size: 'sm' });
    }

    // Commitments & notes
    case 'commitment-toggle': {
      const r = getRecord('commitment', id);
      return mutate('local_save', { kind: 'commitment', id, text: r.data.text, done: el.checked, due: r.data.due, owner: r.data.owner, sourceId: r.data.sourceId, quote: r.data.quote });
    }
    case 'local-delete': return mutate('local_delete', { kind: el.dataset.kind, id });

    // Workspaces & layout
    case 'customize': return customizeDialog();
    case 'widget-up': case 'widget-down': {
      const row = el.closest('[data-widget]');
      if (action === 'widget-up' && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
      if (action === 'widget-down' && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
      el.focus();
      return;
    }
    case 'workspace-new': return workspaceDialog();
    case 'workspace-edit': return workspaceDialog(s.workspaces.find(w => w.id === id));
    case 'workspace-open': await savePendingNote(); await mutate('workspace_select', { id }); return route('today');
    case 'workspace-archive': {
      const archive = el.dataset.archived === 'true';
      return confirmModal({ title: archive ? 'Archive workspace?' : 'Restore workspace?', text: archive ? 'Its schedules pause. Notes and commitments are kept.' : 'Bring this workspace back with its notes and layout.', confirm: archive ? 'Archive' : 'Restore', onConfirm: () => mutate('workspace_update', { archived: archive }, id) });
    }

    // Rules, schedules, jobs, notifications, data
    case 'rule-new': return ruleDialog();
    case 'schedule-new': return scheduleDialog();
    case 'schedule-delete': return mutate('schedule_delete', { id });
    case 'job-cancel': return mutate('job_cancel', { id });
    case 'job-retry': return mutate('job_retry', { id });
    case 'notification-permission': return mutate('notification_permission');
    case 'notification-test': await mutate('notification_test'); return toast('Test reminder queued. Check Notification Center.');
    case 'export': {
      const result = await store.query('export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'codemie-workspace-export.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    default:
      throw new Error('This action is not available. Refresh the view and try again.');
  }
}

async function submitForm(form) {
  const f = new FormData(form);
  switch (form.dataset.form) {
    case 'commitment-add': {
      const text = String(f.get('text') || '').trim();
      if (!text) return form.querySelector('[name=text]').focus();
      await mutate('local_save', { kind: 'commitment', text, owner: 'You', due: f.get('due') || null });
      root.querySelector('[data-form=commitment-add] [name=text]')?.focus();
      return;
    }
    case 'time-zone': await mutate('settings_update', { timeZone: String(f.get('timeZone')).trim() }); return toast('Time zone saved.', 'success');
    case 'quiet-hours': await mutate('settings_update', { quietStart: f.get('quietStart'), quietEnd: f.get('quietEnd') }); return toast('Quiet hours saved.', 'success');
    case 'registration':
      return confirmModal({ title: 'Change application registration?', text: 'You will need to sign in to Microsoft again.', confirm: 'Save and sign out', onConfirm: () => mutate('settings_update', { clientId: String(f.get('clientId')).trim(), tenant: String(f.get('tenant')).trim() }) });
    case 'reply': {
      const id = form.dataset.id;
      const key = form.dataset.key || id;
      // A re-render can replace the form mid-request; never prepare two sends for one reply.
      if (replyInFlight.has(key)) return undefined;
      replyInFlight.add(key);
      try {
        return await prepareReply(id, String(f.get('body') || ''));
      } finally {
        replyInFlight.delete(key);
      }
    }
    default: return undefined;
  }
}

async function prepareReply(id, body) {
  const m = getRecord('message', id);
  if (!body.trim()) throw new Error('Write a reply first.');
  await mutate('draft_save', { text: body, sourceId: id, sourceRevision: m.revision });
  const result = await mutate('action_prepare', { kind: m.data.channel === 'mail' ? 'mail_reply' : 'chat_reply', sourceId: id, body });
  return reviewAction(result);
}

// ---------------------------------------------------------------- events

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-action]');
  if (!el || !el.closest('#workspace-app,.ws-modal')) return;
  if (el.matches('input[type=checkbox],input[type=radio],select')) return;
  ev.preventDefault();
  if (el.disabled) return;
  const keepFocus = KEEP_FOCUS.has(el.dataset.action);
  if (!keepFocus) el.disabled = true;
  try {
    await handle(el.dataset.action, el);
  } catch (err) {
    fail(err);
  } finally {
    el.disabled = false;
  }
});

document.addEventListener('change', async ev => {
  const el = ev.target;
  try {
    if (el.id === 'workspace-select') {
      if (legacyMounted && legacyModule && !(await legacyModule.leaveLegacyTools())) {
        el.value = snap().settings.activeWorkspace;
        return;
      }
      await savePendingNote();
      await mutate('workspace_select', { id: el.value });
      return;
    }
    if (el.matches('[data-action]') && (el.type === 'checkbox' || el.tagName === 'SELECT') && el.closest('#workspace-app,.ws-modal')) {
      await handle(el.dataset.action, el);
    }
  } catch (err) {
    fail(err);
    await render();
  }
});

document.addEventListener('submit', async ev => {
  const form = ev.target.closest('form[data-form]');
  if (!form || !form.closest('#workspace-app')) return;
  ev.preventDefault();
  const buttons = [...form.querySelectorAll('button[type=submit]')];
  buttons.forEach(b => { b.disabled = true; });
  try {
    await submitForm(form);
  } catch (err) {
    fail(err);
  } finally {
    buttons.forEach(b => { b.disabled = false; });
  }
});

document.addEventListener('input', ev => {
  if (ev.target.id === 'inbox-search') {
    state.search = ev.target.value;
    clearTimeout(searchTimer);
    const pos = ev.target.selectionStart;
    searchTimer = setTimeout(async () => {
      state.selectedMessage = null;
      await render();
      const input = document.getElementById('inbox-search');
      input?.focus();
      input?.setSelectionRange(pos, pos);
    }, 220);
  }
  if (ev.target.id === 'today-note') {
    clearTimeout(noteTimer);
    const label = document.getElementById('note-state');
    if (label) label.textContent = 'Editing…';
    const el = ev.target;
    noteTimer = setTimeout(() => saveNote(el), 900);
  }
});

document.addEventListener('keydown', ev => {
  if (!ready || modalOpen() || editing() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (state.route === 'calendar') {
    const keys = { t: () => setCalendar(todayDate()), ArrowLeft: () => stepCalendar(-1), ArrowRight: () => stepCalendar(1), d: () => setCalendar(state.calendarDate, 'day'), w: () => setCalendar(state.calendarDate, 'week'), m: () => setCalendar(state.calendarDate, 'month'), a: () => setCalendar(state.calendarDate, 'agenda') };
    if (keys[ev.key]) {
      ev.preventDefault();
      keys[ev.key]().catch(fail);
    }
  } else if (state.route === 'inbox' && ['ArrowDown', 'ArrowUp', 'j', 'k'].includes(ev.key)) {
    const rows = [...root.querySelectorAll('.ws-inbox-row')];
    if (!rows.length) return;
    const index = rows.findIndex(r => r.dataset.id === state.selectedMessage);
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + (['ArrowDown', 'j'].includes(ev.key) ? 1 : -1)))];
    ev.preventDefault();
    selectMessage(next.dataset.id).catch(fail);
  }
});

// ---------------------------------------------------------------- live time

function tick() {
  if (!ready || !store.get()) return;
  const zone = snap().settings.timeZone;
  const p = zonedParts(Date.now(), zone);
  const nowMin = p.hour * 60 + p.minute;
  root.querySelectorAll('[data-now-line]').forEach(line => {
    const start = Number(line.dataset.startHour) * 60;
    line.style.top = `${(((nowMin - start) / 60) * Number(line.dataset.hourHeight)).toFixed(1)}px`;
  });
}

let minuteTimer;
function scheduleMinuteRender() {
  clearTimeout(minuteTimer);
  minuteTimer = setTimeout(async () => {
    if (ready && ['today', 'calendar'].includes(state.route) && !modalOpen() && !editing() && !legacyMounted) await render().catch(() => {});
    scheduleMinuteRender();
  }, 60_000 - (Date.now() % 60_000) + 50);
}

// ---------------------------------------------------------------- notifications

function flushNotification() {
  if (deferredNotification && !modalOpen() && !legacyModule?.legacyToolsBusy()) {
    const next = deferredNotification;
    deferredNotification = null;
    queueMicrotask(() => openNotification(next).catch(fail));
  }
}

async function openNotification(payload) {
  if (modalOpen() || legacyModule?.legacyToolsBusy()) {
    deferredNotification = payload;
    toast('Finish your current dialog to open this notification.');
    return;
  }
  await savePendingNote();
  if (payload.workspaceId && payload.workspaceId !== snap().settings.activeWorkspace) await mutate('workspace_select', { id: payload.workspaceId });
  await store.refresh();
  if (payload.itemId) {
    const m = getRecord('message', payload.itemId);
    if (m) {
      Object.assign(state, { lane: m.data.lane || 'critical', channel: 'all', search: '', showArchived: m.data.lifecycle === 'archived', showSnoozed: m.data.snoozedUntil > Date.now() / 1000 });
      state.selectedMessage = m.id;
      state.selectedKey = messageKey(m);
    }
    return route('inbox');
  }
  if (payload.eventId) {
    await route('calendar');
    return eventDialog(getRecord('event', payload.eventId));
  }
  return route('settings', 'activity');
}

// ---------------------------------------------------------------- boot

async function checkAppUpdate() {
  state.updateStatus = 'Checking for updates…';
  if (state.route === 'settings' && state.settingsTab === 'updates') await render();
  try {
    state.latestVersion = (await invoke('check_for_update')) || state.latestVersion;
    state.updateStatus = state.latestVersion ? `Version ${state.latestVersion} is available.` : 'You have the latest version.';
    setLocalPref(`codemie.app.lastUpdateCheck.${state.appVersion}`, new Date().toISOString());
  } catch (err) {
    state.updateStatus = err?.message || String(err);
  }
  if (state.route === 'settings' && state.settingsTab === 'updates' && !modalOpen()) await render();
}

async function boot() {
  if (!invoke) {
    root.innerHTML = '<div class="ws-error-page"><h1>Open CodeMie Connect</h1><p>This is the desktop application interface. Native storage and integrations are available in the app.</p></div>';
    return;
  }
  root.innerHTML = `<div class="ws-loading" role="status"><span class="ws-spinner"></span>Opening your workspace…</div>`;
  const flags = await invoke('smoke_mode');
  if (flags.smoke || flags.probe) {
    root.classList.add('hidden');
    legacy.classList.remove('hidden');
    legacyModule = await import('../renderer.js');
    await legacyModule.initLegacyTools();
    return;
  }
  const hash = location.hash.split('/');
  if (hash[1]) state.route = ROUTES.includes(hash[1]) ? hash[1] : 'today';
  if (hash[2]) state.settingsTab = hash[2];
  try {
    await store.refresh();
  } catch (err) {
    root.innerHTML = `<div class="ws-error-page"><h1>Workspace storage needs attention</h1><p>${e(err.message || err)}</p><p>The original database is kept. Your CodeMie tools are still available.</p><button id="recovery-tools" class="ws-btn ws-btn-primary">Open CodeMie tools</button></div>`;
    document.getElementById('recovery-tools').onclick = async () => {
      root.classList.add('hidden');
      legacy.classList.remove('hidden');
      legacyModule = await import('../renderer.js');
      await legacyModule.initLegacyTools();
    };
    return;
  }
  runtimeReady = await invoke('runtime_ready').catch(() => false);
  state.appVersion = await invoke('get_app_version').catch(() => '');
  if (snap().revision === 0) {
    const old = localPref('cm-theme', '');
    await store.mutate('settings_update', { theme: ['light', 'dark'].includes(old) ? old : 'system', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  }
  onModalClose(() => {
    if (modalOpen()) return;
    if (!legacyMounted && !editing()) render().catch(fail);
    flushNotification();
  });
  store.subscribe(result => {
    applyTheme(result.snapshot.settings.theme);
    if (!ready || modalOpen() || legacyMounted || editing()) return;
    render();
  });
  state.calendarDate = todayDate();
  ready = true;
  await render();
  const listen = window.__TAURI__.event.listen;
  // A sync round emits one change per Graph request; reload the snapshot at most ~once a second.
  let refreshTimer = null;
  let lastRefresh = 0;
  const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      lastRefresh = Date.now();
      store.refresh().catch(fail);
    }, Math.max(150, 1200 - (Date.now() - lastRefresh)));
  };
  for (const name of ['workspace:changed', 'connection:changed']) await listen(name, scheduleRefresh);
  await listen('workspace:quit-request', async () => {
    if (state.updateBusy) return toast('The update is in progress. Keep Connect open until it finishes.');
    if (legacyModule) await legacyModule.leaveLegacyTools();
  });
  await listen('workspace:notification-open', event => openNotification(event.payload || {}).catch(fail));
  await listen('workspace:installer-settled', flushNotification);
  window.addEventListener('focus', () => store.refresh().catch(() => {}));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (snap().settings.theme === 'system') {
      applyTheme('system');
      if (!modalOpen() && !editing()) render();
    }
  });
  window.addEventListener('cm-theme-change', event => mutate('settings_update', { theme: event.detail }).catch(fail));
  const authTimer = setInterval(() => { if (store.get()?.authPending) store.refresh().catch(() => {}); }, 1500);
  setInterval(tick, 30_000);
  scheduleMinuteRender();
  window.addEventListener('pagehide', () => clearInterval(authTimer), { once: true });
  if (state.route === 'calendar') await ensureCalendarWindow();
  if (flags.dev) window.__workspace = { store, state, route, render };
  if (shouldCheckForAppUpdate(localPref(`codemie.app.lastUpdateCheck.${state.appVersion}`, null))) checkAppUpdate().catch(() => {});
}

boot().catch(err => {
  window.__bootError = String(err?.stack || err);
  fail(err);
});
