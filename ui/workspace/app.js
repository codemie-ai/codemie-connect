// Workspace controller: routing, native snapshot rendering, actions and the lazily mounted
// legacy CodeMie tools (installer, profiles, desktop proxy, health, analytics) under Settings.
import { createStore, escapeHtml as e } from './store.js';
import { shouldCheckForAppUpdate } from '../app-updater-utils.mjs';
import { icon } from './icons.js';
import { badge, button, toast, openModal, confirmModal, onModalClose, field, textInput, textArea, select, checkbox, toggle, controlSelector, soleMatch } from './ui.js';
import { calendarWindow, calendarCoverage, calendarIds, calendarCatalog, calendarColors } from './calendar-model.js';
import { active, decisions, connectionState, records, LANES, messageTitle, collapseChats, messageKey, conversation, draftKeyOf, draftJob, latestDraft, savedReply, summaryKeyOf, summaryJob, summaryFor } from './selectors.js';
import { askCommitment, askCommitmentId } from './summary-state.js';
import { dayKey, dateFromKey, zonedParts } from './format.js';
import { today, customizeEntries } from './view-today.js';
import { calendar, eventDetails, HOUR_HEIGHT } from './view-calendar.js';
import { inbox, filteredMessages, snoozeUntil, draftChecks } from './view-inbox.js';
import {
  optionsKey, readOptions, pickOption, draftRequest, reconcile, answer, replyBox, runningLabel, chooseOption, draftChoices, draftGaps, unfinishedParts, claudeAvailable, claudeCheck,
} from './draft-state.js';
import { settings, LEGACY_TABS, SETTINGS_TABS } from './view-settings.js';
import { automations, AUTOMATION_TABS } from './view-automations.js';
import { createAutomationsController, notificationTarget } from './automations-controller.js';
import { renderShell } from './shell.js';
import { nextAiSettings, LOGIN_STEPS } from './settings-ai.js';
import { chooserBody, CHOOSER_TITLE } from './ai-chooser.js';
import { bootWorkspace, notificationWorkspaceToSelect } from './boot.js';
import { recoveryPage, firstReport, USE_DEFAULT_WARNING } from './recovery.js';
import { formatBytes, removeOldBody, useDefaultBody } from './settings-storage.js';
import { createDataLocationFlow } from './data-location-flow.js';
import { withAppOrigin } from './app-invoke.js';
import { pluginUrl } from '../plugins/frame-url.js';
import { createPluginHost, internalRoute } from '../plugins/host.js';
import { createPluginsController } from './settings-plugins.js';
import { pluginWidgetCatalog, parseLayoutId, heldText, textOfHtml } from './today-plugins.js';

const ROUTES = ['today', 'calendar', 'inbox', 'automations', 'settings'];
const root = document.getElementById('workspace-app');
const legacy = document.getElementById('app');
const rawInvoke = window.__TAURI__?.core?.invoke;
const invoke = rawInvoke && withAppOrigin(rawInvoke, location.origin);
// Any workspace call that finds the data folder unusable switches to the recovery page.
const watched = invoke && (async (cmd, args) => {
  try {
    return await invoke(cmd, args);
  } catch (err) {
    if (err?.code === 'storage_unavailable') showRecovery(err);
    throw err;
  }
});
const store = invoke ? createStore(watched) : null;

const state = {
  route: 'today', settingsTab: 'general',
  calendarMode: localPref('codemie.calendar.mode', 'week'), calendarDate: new Date(), calendarSidebar: localPref('codemie.calendar.sidebar', 'true') !== 'false',
  lane: 'reply', channel: 'all', search: '', showArchived: false, showSnoozed: false, inboxLimit: 200, selectedMessage: null, selectedKey: null,
  appVersion: '', latestVersion: null, updateStatus: '', updateBusy: false,
  ai: { status: 'idle', profiles: [], settings: { defaultProfile: null, routes: {} }, usage: null, error: '', tests: {}, testModels: {} },
  // Settings → General → Data location: the `data_location_get` answer (null until read).
  storage: { info: null, error: '', restarting: false },
  // Reply drafts: this session's reply-box decisions per draft key (see `replyBox`), the open
  // options popover, and failed drafts the user dismissed.
  drafts: {}, summaryUi: {}, draftPopover: null, draftDismissed: localJson('codemie.draft.dismissed', []),
  // Automations: the open tab and the Run log pages read with `automation_runs` (null until read).
  automations: { tab: 'automations', highlight: null, runs: { items: null, next: null, error: '', filter: '', expanded: [], loadingMore: false } },
  // Plugins: the page open under #/p/<id>/<activity>/<route>, the Settings → Plugins path
  // ({id, section}), what is installed, and the text of page widgets their frames drew.
  pluginPage: null, pluginPath: null, installedPlugins: [], pluginsKnown: false, widgetText: {},
};
let pluginHost = null;
let lastPluginTheme = '';
const drawnWidgets = new Map();
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
const asksSaving = new Set();
const KEEP_FOCUS = new Set(['widget-up', 'widget-down', 'ai-draft-pick', 'ai-draft-context', 'summary-toggle', 'automation-kind', 'run-toggle']);
let lastDraftSignature = '';
// Updates that arrived while the draft options popover was open; shown once it closes.
let heldRender = false;

function localPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function localJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
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
const fail = err => (err?.code === 'storage_unavailable' ? showRecovery(err) : toast(err?.message || String(err), 'error'));

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
  if (pluginHost && resolved !== lastPluginTheme) {
    lastPluginTheme = resolved;
    pluginHost.setTheme(resolved);
  }
  const legacyToggle = document.getElementById('theme-toggle-input');
  if (legacyToggle) legacyToggle.checked = resolved === 'dark';
}

// ---------------------------------------------------------------- shell

const shellMarkup = () => renderShell({
  snapshot: snap(), route: state.route, resolvedDark: document.documentElement.classList.contains('dark'),
  plugins: { activities: pluginHost?.activities() || [], current: state.route === 'plugin' && state.pluginPage ? { plugin: state.pluginPage.id, id: state.pluginPage.activity } : null },
});

function shell() {
  root.dataset.route = state.route;
  root.innerHTML = shellMarkup();
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
  if (!store?.get() || recovering) return;
  if (legacyMounted && legacyModule?.legacyToolsBusy()) {
    applyTheme(snap().settings.theme);
    return;
  }
  const note = document.getElementById('today-note');
  const unsavedNote = note && note.value !== note.defaultValue ? { workspaceId: note.dataset.workspaceId, text: note.value } : null;
  const reply = document.getElementById('reply-body');
  const replyKey = reply?.closest('form')?.dataset.key;
  const unsavedReply = reply && reply.value !== reply.defaultValue ? { key: replyKey, text: reply.value } : null;
  // A reply box the user is in (or has typed in) is kept as it is, not recreated: its focus,
  // selection, undo history and IME composition survive the re-render around it.
  const keepReply = reply && (document.activeElement === reply || unsavedReply) ? reply : null;
  const focused = document.activeElement;
  const refocus = focused && focused !== document.body && root.contains(focused) ? controlSelector(focused) : null;
  const revision = ++rendering;
  heldRender = false;
  // A ⋯ menu the user opened stays open through an update (a minute tick, a new snapshot).
  const openMenus = [...root.querySelectorAll('details.ws-menu[open][data-menu]')].map(d => d.dataset.menu);
  if (legacyMounted) {
    legacy.classList.add('hidden');
    document.body.append(legacy);
    legacyMounted = false;
  }
  const saved = captureScroll();
  const s = snap();
  applyTheme(s.settings.theme);
  const ctx = { state, auth: auth(), hidden: hiddenCalendars(), banners: banners(s), plugins: pluginContext() };
  if (state.route === 'inbox') ensureSelection(s);
  if (['inbox', 'today', 'automations'].includes(state.route)) readClaude();
  const pageClass = `ws-page ws-page-${state.route}`;
  const html = state.route === 'today' ? today(s, ctx)
    : state.route === 'calendar' ? calendar(s, ctx)
      : state.route === 'inbox' ? inbox(s, ctx)
        : state.route === 'automations' ? automations(s, ctx)
          : state.route === 'plugin' ? pluginPageHtml()
            : settings(s, ctx);
  const next = keepReply && state.route === 'inbox' ? document.createElement('div') : null;
  if (next) {
    next.innerHTML = shellMarkup();
    Object.assign(next.querySelector('#workspace-page'), { className: pageClass, innerHTML: html });
  }
  if (next && renderAround(root, next, keepReply)) {
    root.dataset.route = state.route;
  } else {
    shell();
    const page = document.getElementById('workspace-page');
    page.className = pageClass;
    page.innerHTML = html;
  }
  if (unsavedNote?.workspaceId === current().id) {
    const fresh = document.getElementById('today-note');
    if (fresh) fresh.value = unsavedNote.text;
  }
  const freshReply = document.getElementById('reply-body');
  if (freshReply !== keepReply && unsavedReply && freshReply?.closest('form')?.dataset.key === unsavedReply.key) freshReply.value = unsavedReply.text;
  syncReplyBox(freshReply);
  for (const menu of openMenus) root.querySelector(`details.ws-menu[data-menu="${CSS.escape(menu)}"]`)?.setAttribute('open', '');
  if (state.route === 'inbox') rememberDraftBaseline(s);
  restoreScroll(saved);
  // A background update keeps keyboard focus on the same control, and only on that one: when
  // the control is gone or no longer told apart from a sibling, focus is left alone.
  if (refocus && !root.contains(document.activeElement)) soleMatch(root, refocus)?.focus({ preventScroll: true });
  placeDraftPopover();
  showPluginView();
  if (state.route === 'today') drawPageWidgets(s);
  lastDraftSignature = draftSignature(s);
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

async function route(name, tab, pluginPath = null) {
  if (legacyMounted && legacyModule && !(await legacyModule.leaveLegacyTools())) return;
  await savePendingNote();
  state.route = ROUTES.includes(name) ? name : 'today';
  if (tab && state.route === 'settings') state.settingsTab = SETTINGS_TABS.some(([, id]) => id === tab) ? tab : 'general';
  const onPluginsTab = state.route === 'settings' && state.settingsTab === 'plugins';
  state.pluginPath = onPluginsTab ? pluginPath : null;
  state.pluginPage = null;
  if (onPluginsTab && !pluginPath) pluginsUi.ui.offer = null;
  if (state.pluginPath) {
    const { id, section } = state.pluginPath;
    history.replaceState(null, '', `#/settings/plugins/${encodeURIComponent(id)}${section ? `/${encodeURIComponent(section)}` : ''}`);
    await render();
    if (!section) pluginsUi.load().catch(fail);
    return;
  }
  if (tab && state.route === 'automations') state.automations.tab = AUTOMATION_TABS.some(([id]) => id === tab) ? tab : 'automations';
  history.replaceState(null, '', `#/${state.route}${state.route === 'settings' ? `/${state.settingsTab}` : state.route === 'automations' && state.automations.tab !== 'automations' ? `/${state.automations.tab}` : ''}`);
  await render();
  const heading = root.querySelector('h1');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
  if (state.route === 'calendar') await ensureCalendarWindow();
  if (state.route === 'settings' && state.settingsTab === 'ai') loadAi().catch(fail);
  if (generalTabOpen()) loadStorage().catch(fail);
  if (runLogOpen()) automationsUi.loadRuns().catch(fail);
  if (onPluginsTab) pluginsUi.load().catch(fail);
}

// ---------------------------------------------------------------- plugins

const PLUGIN_ID = /^[a-z][a-z0-9-]{1,40}$/;
const PLUGIN_ITEM = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/** Opens a plugin's page: `#/p/<id>/<activity>[/<route>]`. */
async function routePlugin(id, activity, rest = '') {
  if (!PLUGIN_ID.test(id) || !PLUGIN_ITEM.test(activity)) return route('today');
  if (legacyMounted && legacyModule && !(await legacyModule.leaveLegacyTools())) return;
  await savePendingNote();
  state.route = 'plugin';
  state.pluginPage = { id, activity, route: rest };
  state.pluginPath = null;
  history.replaceState(null, '', `#/p/${id}/${activity}${rest ? `/${rest}` : ''}`);
  await render();
}

/** Opens a Connect hash: one of the app's routes, Settings → Plugins or a plugin's section, or a
 *  plugin's page. Anything else opens Today. */
function goHash(hash) {
  const [head, a, b, ...rest] = String(hash || '').replace(/^#\/?/, '').split('/');
  if (head === 'p') return routePlugin(a || '', b || '', rest.join('/'));
  if (head === 'settings' && a === 'plugins') {
    const id = b && PLUGIN_ID.test(decodeURIComponent(b)) ? decodeURIComponent(b) : null;
    const section = id && rest[0] && PLUGIN_ITEM.test(decodeURIComponent(rest[0])) ? decodeURIComponent(rest[0]) : null;
    return route('settings', 'plugins', id ? { id, section } : null);
  }
  if (head === 'settings') return route('settings', a);
  return route(ROUTES.includes(head) ? head : 'today', a);
}

const pluginsUi = createPluginsController({
  request: (op, data) => invoke('plugins_request', data === undefined ? { op } : { op, data }),
  render: () => { if (ready && !modalOpen()) render().catch(fail); },
  openModal,
  toast,
  installedChanged: list => {
    state.installedPlugins = list;
    state.pluginsKnown = true;
    pluginHost?.sync(list);
  },
  navigate: path => route('settings', 'plugins', path),
});

/** What the views need of the plugins: Settings' tab state and Today's widget catalog. */
function pluginContext() {
  return {
    ui: pluginsUi.ui,
    path: state.pluginPath,
    status: id => pluginHost?.status(id) || null,
    sections: pluginHost?.sections() || [],
    catalog: pluginWidgetCatalog(state.installedPlugins),
    drawn: state.widgetText,
    routeOf: internalRoute,
  };
}

/** A plugin's page: the slot its frame is laid over, or why there is none. */
function pluginPageHtml() {
  const p = state.pluginPage;
  // Until Connect knows what is installed (just after start), the page is on its way.
  if (!state.pluginsKnown) return '<div class="ws-loading" role="status"><span class="ws-spinner"></span>Opening the plugin…</div>';
  const status = pluginHost?.status(p.id);
  const page = (pluginHost?.activities() || []).find(a => a.plugin === p.id && a.id === p.activity);
  if (page || (status && status.loaded && !status.ready && !status.error)) return `<div class="ws-plugin-page" data-plugin-slot="${e(p.id)}"></div>`;
  const why = !status ? 'Its plugin is off or not installed.' : status.error ? `Its plugin didn’t start: ${status.error}` : 'Its plugin doesn’t have this page any more.';
  return `<div class="ws-plugin-missing"><div class="ws-empty"><span class="ws-empty-icon">${icon('puzzle')}</span><strong>This page isn’t available</strong><p>${e(why)}</p><div class="ws-actions">${button('Settings → Plugins', { action: 'settings-tab', variant: 'primary', attrs: { 'data-tab': 'plugins' } })}</div></div></div>`;
}

/** Shows the plugin frame the current route needs (a page, a section, a card), or none. */
function showPluginView() {
  if (!pluginHost) return;
  const path = state.pluginPath;
  const p = state.pluginPage;
  const onPluginsTab = state.route === 'settings' && state.settingsTab === 'plugins';
  if (state.route === 'plugin' && p) pluginHost.show({ id: p.id, view: 'activity', activity: p.activity, route: p.route });
  else if (onPluginsTab && path?.section) pluginHost.show({ id: path.id, view: 'section', section: path.section });
  else if (onPluginsTab && path?.id && pluginHost.status(path.id)?.card) pluginHost.show({ id: path.id, view: 'card' });
  else pluginHost.show(null);
}

/** Today's `page` widgets are drawn by their plugin's frame; their text is shown. */
function drawPageWidgets(s) {
  if (!pluginHost) return;
  for (const id of current().layout) {
    const at = parseLayoutId(id);
    const r = at && s.records.find(x => x.kind === 'plugin_widget' && x.id === `${at.plugin}:${at.widget}`);
    if (!r || r.data?.kind !== 'page') continue;
    // Drawn again when its data changes or its frame becomes able to draw it, never in a loop.
    const able = !!pluginHost.status(at.plugin)?.widgets?.includes(at.widget);
    const key = `${r.revision}:${able}`;
    if (drawnWidgets.get(id) === key) continue;
    drawnWidgets.set(id, key);
    const before = state.widgetText[id];
    pluginHost.draw(at.plugin, at.widget, r.data.data, 'M').then(html => {
      state.widgetText[id] = textOfHtml(html, text => new DOMParser().parseFromString(text, 'text/html'));
    }, err => {
      state.widgetText[id] = err.message;
    }).then(() => {
      if (state.widgetText[id] !== before && state.route === 'today' && !modalOpen() && !editing()) render().catch(fail);
    });
  }
}

let pluginRenderTimer = null;
/** A plugin's frame changed what it adds (a page, a section, a badge): drawn again soon. */
function pluginsChanged() {
  clearTimeout(pluginRenderTimer);
  pluginRenderTimer = setTimeout(() => {
    if (ready && !modalOpen() && !editing() && !legacyMounted) render().catch(fail);
  }, 60);
}

async function pluginAction(action, el) {
  const id = el.dataset.pluginId;
  switch (action) {
    case 'plugin-page': return routePlugin(id, el.dataset.activity);
    case 'plugin-go': return goHash(el.dataset.go);
    case 'plugin-palette': return pluginHost?.runPalette(id, Number(el.dataset.index));
    case 'plugin-copy': {
      const text = heldText(snap(), el.dataset.id);
      if (text === null) return;
      await navigator.clipboard.writeText(text);
      return toast('Copied. Paste it where you want to send it.', 'success');
    }
    case 'plugin-command': {
      let args = null;
      try { args = JSON.parse(el.dataset.args || 'null'); } catch { /* none */ }
      await invoke('plugin_call', { id, command: el.dataset.command, args });
      toast('Done.', 'success');
      return store.refresh();
    }
    default:
      if (await pluginsUi.handle(action, el)) return;
      throw new Error('This action is not available. Refresh the view and try again.');
  }
}

// ---------------------------------------------------------------- Claude (AI)

let aiLoads = 0;
const aiTabOpen = () => state.route === 'settings' && state.settingsTab === 'ai';

/** Detects the Claude profiles and reads this month's usage; the page shows a spinner on first load. */
async function loadAi() {
  const load = ++aiLoads;
  if (state.ai.status !== 'ready') state.ai.status = 'loading';
  if (aiTabOpen() && !modalOpen()) await render();
  try {
    const [status, usage] = await Promise.all([store.query('ai_status', { refresh: true }), store.query('ai_usage', {}).catch(() => null)]);
    if (load !== aiLoads) return;
    Object.assign(state.ai, { status: 'ready', profiles: status.profiles, settings: status.settings, usage, error: '' });
  } catch (err) {
    if (load !== aiLoads) return;
    Object.assign(state.ai, { status: 'error', error: err?.message || String(err) });
  }
  if (aiTabOpen() && !modalOpen()) await render();
}

async function saveAiSettings(next) {
  try {
    const result = await store.mutate('ai_settings_save', next);
    state.ai.settings = result.settings;
  } catch (err) {
    loadAi().catch(() => {});
    throw err;
  }
  if (!modalOpen()) await render();
}

async function testAiProfile(profileId) {
  state.ai.tests[profileId] = { busy: true };
  await render();
  try {
    const model = state.ai.testModels[profileId] || undefined;
    state.ai.tests[profileId] = await store.query('ai_test', { profileId, model });
    state.ai.usage = await store.query('ai_usage', {}).catch(() => state.ai.usage);
  } catch (err) {
    state.ai.tests[profileId] = { ok: false, message: err?.message || String(err) };
  }
  await render();
}

/**
 * Asks the owner which Claude writes for them (first use). Resolves to the chosen profile id,
 * or null when they cancel or nothing is ready. Call it when an AI op fails with `needs_choice`.
 */
let choiceInFlight = null;
export function ensureClaudeChoice() {
  if (!store) return Promise.resolve(null);
  choiceInFlight ||= askClaudeChoice().finally(() => { choiceInFlight = null; });
  return choiceInFlight;
}

async function askClaudeChoice() {
  let status;
  try {
    status = await store.query('ai_status', { refresh: true });
  } catch (err) {
    fail(err);
    return null;
  }
  Object.assign(state.ai, { status: 'ready', profiles: status.profiles, settings: status.settings });
  const anyReady = status.profiles.some(p => p.state === 'ready');
  return new Promise(resolve => {
    let chosen = null;
    openModal({
      title: CHOOSER_TITLE, subtitle: anyReady ? 'Connect asks once. You can change it in Settings → Claude.' : '',
      body: chooserBody(status.profiles), submit: anyReady ? 'Choose' : null, cancel: anyReady ? 'Cancel' : 'Close', size: 'md',
      onSubmit: async (_form, dialog) => {
        const id = dialog.dataset.choice;
        if (!id) throw new Error('Select a Claude to continue.');
        await saveAiSettings(nextAiSettings(state.ai.settings, state.ai.profiles, { field: 'default', value: id }));
        chosen = id;
      },
      onClose: () => resolve(chosen),
    });
  });
}

/** Runs an AI operation; when no Claude is chosen yet, asks once and retries. */
export async function withClaudeChoice(run) {
  try {
    return await run();
  } catch (err) {
    if (err?.code !== 'needs_choice' && err?.class !== 'needs_choice') throw err;
    if (!(await ensureClaudeChoice())) throw err;
    return run();
  }
}

let claudeRead = null;
let claudeReadAt = 0;
let claudeDetectAt = 0;
// Set by "Copy sign-in steps": the next time Connect gets focus it detects Claude again.
let claudeRecheck = false;

/**
 * Reads which Claude profiles are ready, so Inbox and Today offer drafts or "Set up Claude"
 * (when and whether to detect again: `claudeCheck`). True when it re-runs detection.
 */
function readClaude({ now = false, detect = false } = {}) {
  if (!store || claudeRead || state.ai.status === 'loading') return false;
  const nowMs = Date.now();
  const plan = claudeCheck({ status: state.ai.status, noneReady: state.ai.status === 'ready' && !claudeAvailable(state.ai), now, detect, nowMs, readAt: claudeReadAt, detectAt: claudeDetectAt });
  if (!plan.read) return false;
  claudeReadAt = nowMs;
  if (plan.detect) claudeDetectAt = nowMs;
  claudeRead = store.query('ai_status', { refresh: plan.detect }).then(status => {
    if (state.ai.status === 'loading') return;
    const changed = JSON.stringify([state.ai.profiles, state.ai.settings]) !== JSON.stringify([status.profiles, status.settings]);
    Object.assign(state.ai, { status: 'ready', profiles: status.profiles, settings: status.settings });
    if (changed && ['inbox', 'today', 'automations'].includes(state.route) && !modalOpen() && !editing() && !state.draftPopover && !legacyMounted) render();
  }).catch(() => { /* drafts stay offered; Settings → Claude explains problems */ }).finally(() => { claudeRead = null; });
  return plan.detect;
}

/**
 * Re-renders `container` to match `next` (a detached copy of what it should hold) around the
 * live `keep` element (the reply box): every node on the way down to it takes the new
 * attributes and every node beside it is replaced, so the list, the thread and the running,
 * confirm and provenance rows update while the box itself is never recreated. False (and
 * nothing changed) when `next` has no reply box for the same conversation.
 */
function renderAround(container, next, keep) {
  const twin = next.querySelector('#reply-body');
  if (!twin || !container.contains(keep) || twin.closest('form')?.dataset.key !== keep.closest('form')?.dataset.key) return false;
  const pathNew = [];
  for (let n = twin; n !== next; n = n.parentNode) pathNew.unshift(n);
  const pathLive = [];
  for (let n = keep; n !== container; n = n.parentNode) pathLive.unshift(n);
  if (pathNew.length !== pathLive.length || pathNew.some((n, i) => n.tagName !== pathLive[i].tagName)) return false;
  let live = container;
  let fresh = next;
  pathNew.forEach((freshChild, i) => {
    const liveChild = pathLive[i];
    for (const c of [...live.childNodes]) if (c !== liveChild) c.remove();
    let before = true;
    for (const c of [...fresh.childNodes]) {
      if (c === freshChild) before = false;
      else if (before) live.insertBefore(c, liveChild);
      else live.append(c);
    }
    for (const a of [...liveChild.attributes]) if (!freshChild.hasAttribute(a.name)) liveChild.removeAttribute(a.name);
    for (const a of [...freshChild.attributes]) if (liveChild.getAttribute(a.name) !== a.value) liveChild.setAttribute(a.name, a.value);
    live = liveChild;
    fresh = freshChild;
  });
  return true;
}

// ---------------------------------------------------------------- reply drafts (DESIGN 6.4)

const draftUi = key => (state.drafts[key] ||= {});
const rememberedOptions = channel => readOptions(localPref(optionsKey(channel), null), channel);
const inboxMessage = s => (state.route === 'inbox' && state.selectedMessage ? s.records.find(r => r.kind === 'message' && r.id === state.selectedMessage) : null);

/** What re-renders the open reply box even while the user types in it: its draft job and draft. */
function draftSignature(s) {
  const m = inboxMessage(s);
  if (!m) return '';
  const key = draftKeyOf(m);
  const job = draftJob(s, key);
  const summary = summaryFor(s, m);
  const sJob = summaryJob(s, summaryKeyOf(m));
  return [key, job?.id, job?.state, job?.payload?.startedAt, job?.payload?.runModel, latestDraft(s, key)?.revision,
    sJob?.id, sJob?.state, sJob?.payload?.startedAt, sJob?.payload?.runModel, summary?.revision, summary?.data.stale].join('|');
}

/**
 * A draft that arrived for the conversation whose reply box is open: fill the box or ask
 * (`reconcile`), and keep a saved reply in step after a fill. Runs on each new snapshot, before
 * any render. True when something changed.
 */
function applyArrivedDraft(s) {
  const m = inboxMessage(s);
  const field = document.getElementById('reply-body');
  if (!m || !field || field.closest('form')?.dataset.key !== draftKeyOf(m)) return false;
  const key = draftKeyOf(m);
  const next = reconcile({ ui: draftUi(key), ai: latestDraft(s, key), manual: savedReply(s, m), live: field.value });
  if (!next) return false;
  state.drafts[key] = next.ui;
  if (next.action === 'fill' && field.value !== next.text) {
    field.value = next.text;
    syncReplyBox(field);
  }
  if (next.save != null) saveReply(m, next.save).catch(fail);
  return true;
}

/** Remembers which text in the box came from Claude, so editing it later counts as the user's. */
function rememberDraftBaseline(s) {
  const m = inboxMessage(s);
  if (!m) return;
  const key = draftKeyOf(m);
  const ui = draftUi(key);
  const box = replyBox({ manual: savedReply(s, m), ai: latestDraft(s, key), ui });
  ui.baseline = box.fromAi ? box.text : null;
}

/** Queues a draft; the first draft without a chosen Claude opens the chooser, then retries once. */
async function startDraft(m, options, instructions = '') {
  if (!m) throw new Error('This conversation is no longer available. Refresh and try again.');
  try {
    await withClaudeChoice(() => mutate('ai_draft', draftRequest(m, options, instructions)));
  } catch (err) {
    // Closing the chooser is an answer, not an error.
    if (err?.code === 'needs_choice' || err?.class === 'needs_choice') return;
    throw err;
  }
}

/** Queues a summary of the conversation of `m`; like a draft, the first one may ask which Claude. */
async function startSummary(m) {
  if (!m) throw new Error('This conversation is no longer available. Refresh and try again.');
  try {
    await withClaudeChoice(() => mutate('ai_summarize', { sourceId: m.id }));
  } catch (err) {
    if (err?.code === 'needs_choice' || err?.class === 'needs_choice') return;
    throw err;
  }
}

/** Saves the reply box for a conversation: one saved reply per conversation, none when empty. */
async function saveReply(m, text) {
  const threadIds = new Set(conversation(snap(), m).map(t => t.id));
  const previous = records(snap(), 'draft').filter(r => threadIds.has(r.data.sourceId) && !r.data.aiSuggested && r.data.sourceId !== m.id);
  for (const r of previous) await store.mutate('local_delete', { kind: 'draft', id: r.id });
  if (text.trim()) {
    await mutate('draft_save', { text, sourceId: m.id, sourceRevision: m.revision });
  } else {
    const own = records(snap(), 'draft').find(r => r.data.sourceId === m.id && !r.data.aiSuggested);
    if (own) await mutate('local_delete', { kind: 'draft', id: own.id });
  }
}

/**
 * Keeps the reply box in step with its text: it grows to fit a draft, and Claude's bracketed
 * choices still in it are re-read as the user types.
 */
function syncReplyBox(field) {
  if (!field) return;
  field.style.height = 'auto';
  field.style.height = `${Math.min(Math.max(field.scrollHeight + 2, 88), 360)}px`;
  const form = field.closest('form');
  const checks = form?.querySelector('[data-draft-checks]');
  if (!checks || !store?.get()) return;
  checks.innerHTML = draftChecks(field.value, latestDraft(snap(), form.dataset.key)?.data.text);
  checks.closest('.ws-draft-todo').hidden = !checks.innerHTML.trim() && !form.querySelector('.ws-draft-questions');
}

/** Anchors the options popover to Draft with AI, below it when it fits, else above. */
function placeDraftPopover() {
  const pop = document.getElementById('draft-options');
  const trigger = root.querySelector('[data-action="ai-draft-options"]');
  if (!pop || !trigger) return;
  const t = trigger.getBoundingClientRect();
  const margin = 12;
  const gap = 6;
  const height = pop.offsetHeight;
  const below = innerHeight - t.bottom - gap - margin;
  const above = t.top - gap - margin;
  const top = below >= height || below >= above ? t.bottom + gap : t.top - gap - Math.min(height, above);
  pop.style.top = `${Math.max(margin, Math.min(top, innerHeight - margin - Math.min(height, innerHeight - 2 * margin)))}px`;
  pop.style.left = `${Math.max(margin, Math.min(t.right - pop.offsetWidth, innerWidth - margin - pop.offsetWidth))}px`;
  pop.style.maxHeight = `${innerHeight - 2 * margin}px`;
}

async function openDraftPopover(m) {
  state.draftPopover = { key: draftKeyOf(m), id: m.id, options: rememberedOptions(m.data.channel), instructions: '' };
  await render();
  document.querySelector('#draft-options [data-action="ai-draft"]')?.focus();
}

/**
 * Closes the popover in place, so a click elsewhere still lands on what was under the
 * pointer; updates held while it was open render after that click (or at once from the
 * keyboard), then focus returns to Draft with AI.
 */
async function closeDraftPopover(focusTrigger = true) {
  if (!state.draftPopover) return;
  state.draftPopover = null;
  document.getElementById('draft-options')?.remove();
  root.querySelector('[data-action="ai-draft-options"]')?.setAttribute('aria-expanded', 'false');
  if (!focusTrigger) {
    if (heldRender) document.addEventListener('mouseup', () => setTimeout(flushHeldRender, 0), { once: true, capture: true });
    return;
  }
  if (heldRender) await render();
  root.querySelector('[data-action="ai-draft-options"]')?.focus();
}

function flushHeldRender() {
  if (!heldRender || state.draftPopover || modalOpen() || legacyMounted) return;
  // Typing somewhere else (search, a note): the next update shows it instead.
  if (editing() && document.activeElement?.id !== 'reply-body') return;
  render().catch(fail);
}

function dismissDraftError(jobId) {
  state.draftDismissed = [...state.draftDismissed.filter(id => id !== jobId), jobId].slice(-50);
  setLocalPref('codemie.draft.dismissed', JSON.stringify(state.draftDismissed));
}

/** Review & send (or Copy) of a reply that still has a choice or gap Claude left asks first. */
function confirmUnfinished(parts, { submit, then }) {
  openModal({
    title: 'Finish your reply first?',
    subtitle: 'Claude left these for you to choose or fill in.',
    body: `<ul class="ws-draft-open-list">${parts.map(p => `<li><code>${e(p)}</code></li>`).join('')}</ul><p class="ws-muted ws-hint">Pick an option or fill in each one, or go on with the reply as it is.</p>`,
    submit,
    cancel: 'Edit reply',
    size: 'sm',
    onSubmit: async (_form, dialog) => {
      dialog.close();
      await then();
      return false;
    },
  });
}

/** Copies the reply, for when Connect may not send it (no Microsoft permission to reply). */
async function copyReply(m, text) {
  const where = m.data.channel === 'chat' ? 'Teams' : 'Outlook';
  try {
    await navigator.clipboard.writeText(text);
    toast(`Reply copied. Paste it in ${where}.`, 'success');
  } catch {
    toast('Could not copy. Select the text in the reply box and copy it.', 'error');
  }
}

/** Elapsed seconds of running drafts, updated in place (no re-render while the user types). */
function draftTick() {
  root.querySelectorAll('.ws-draft-running[data-started]').forEach(row => {
    const startedAt = Number(row.dataset.started);
    if (!startedAt) return;
    const { label, seconds } = runningLabel({ state: row.dataset.state, payload: { startedAt, profile: row.dataset.profile, model: row.dataset.model || null } }, { verb: row.dataset.verb || 'Drafting' });
    const text = row.querySelector('[data-draft-label]');
    const time = row.querySelector('[data-draft-seconds]');
    if (text && text.textContent !== label) text.textContent = label;
    if (time) time.textContent = seconds ? `${seconds} s` : '';
  });
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

// ---------------------------------------------------------------- automations (DESIGN 6.6)

const automationsUi = store && createAutomationsController({
  state, store, snap, mutate, route, render, openModal, confirmModal, toast, ensureClaudeChoice, modalOpen,
  writeText: text => navigator.clipboard.writeText(text),
});
const runLogOpen = () => !!automationsUi?.runLogOpen();

// ---------------------------------------------------------------- dialogs

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

function reviewAction(result, { onSent } = {}) {
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
      onSent?.();
      toast(r.message || 'Sent for delivery.', 'success');
    },
  });
}

function customizeDialog() {
  const w = current();
  const entries = customizeEntries(w, pluginWidgetCatalog(state.installedPlugins));
  // "From plugins" shows itself until a saved layout says otherwise (showPluginsCard).
  const shown = x => w.layout.includes(x.id) || (x.id === 'plugins' && !('plugins' in (w.widgetWidths || {})) && !!root.querySelector('.ws-plugins-card'));
  const dialog = openModal({
    title: 'Customize Today',
    subtitle: `Cards for ${w.name}. Drag the arrows to reorder.`,
    body: `<div class="ws-widget-list" id="widget-order">${entries.map(x => `<div class="ws-widget-row" data-widget="${e(x.id)}"${x.plugin ? ` data-plugin-id="${e(x.plugin)}"` : ''}>
      ${toggle({ name: 'widget', attrs: { value: x.id, 'aria-label': `Show ${x.title}` }, checked: shown(x) })}
      <div class="ws-widget-copy"><strong>${e(x.title)}${x.plugin ? ` ${badge('Plugin', 'neutral', 'puzzle')}` : ''}</strong><span>${e(x.description)}</span></div>
      ${select([[4, '⅓ width'], [6, '½ width'], [8, '⅔ width'], [12, 'Full width']], w.widgetWidths?.[x.id] || x.width, { name: `width-${x.id}`, 'aria-label': `${x.title} width` })}
      <span class="ws-reorder">${button('', { action: 'widget-up', iconName: 'chevron-up', variant: 'ghost', title: 'Move up' })}${button('', { action: 'widget-down', iconName: 'chevron-down', variant: 'ghost', title: 'Move down' })}</span>
    </div>`).join('')}</div>`,
    submit: 'Save layout',
    onSubmit: async f => {
      const layout = [...dialog.querySelectorAll('[data-widget]')].map(row => row.dataset.widget).filter(id => f.getAll('widget').includes(id));
      const widgetWidths = Object.fromEntries(entries.map(x => [x.id, Number(f.get(`width-${x.id}`))]));
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
  if (action.startsWith('recovery-')) return recoveryAction(action);
  // Data location works from the recovery page too, where there is no snapshot.
  if (action.startsWith('data-')) return storageAction(action, el);
  if (action.startsWith('automation') || action.startsWith('run-')) return automationsUi.handle(action, el);
  if (action.startsWith('plugin') || action.startsWith('market-')) return pluginAction(action, el);
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
    case 'ai-refresh': return loadAi();
    case 'ai-test': return testAiProfile(el.dataset.profile);
    case 'ai-test-model': state.ai.testModels[el.dataset.profile] = el.value; return;
    case 'ai-default': return saveAiSettings(nextAiSettings(state.ai.settings, state.ai.profiles, { field: 'default', value: el.value }));
    case 'ai-route': return saveAiSettings(nextAiSettings(state.ai.settings, state.ai.profiles, { field: el.dataset.field, purpose: el.dataset.route, value: el.value }));
    case 'ai-copy-login':
      claudeRecheck = true;
      try {
        await navigator.clipboard.writeText(LOGIN_STEPS);
        return toast('Sign-in steps copied.', 'success');
      } catch {
        return toast(`Could not copy. ${LOGIN_STEPS}.`, 'error');
      }
    case 'ai-choose': {
      const dialog = el.closest('.ws-modal');
      dialog.dataset.choice = el.dataset.profile;
      dialog.querySelector('.ws-modal-error').textContent = '';
      dialog.querySelectorAll('[data-action="ai-choose"]').forEach(b => b.setAttribute('aria-pressed', String(b === el)));
      return;
    }
    case 'ai-open-settings':
      document.querySelectorAll('.ws-modal[open]').forEach(d => d.close());
      return route('settings', 'ai');
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
        return confirmModal({ title: 'Pause critical reminders?', text: 'This pauses reminders for this incident until the chosen time. It does not acknowledge it.', confirm: 'Pause reminders', onConfirm: run });
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
        return confirmModal({ title: 'Acknowledge and move?', text: 'Acknowledging stops this incident’s pending reminders. The move applies to Connect.', confirm: 'Acknowledge and move', onConfirm: run });
      }
      await run();
      return toast(`Moved to ${LANES.find(([k]) => k === lane)?.[1] || lane}.`, 'success');
    }
    case 'message-ack': await decideRow(id, { action: 'acknowledge' }); return;
    case 'commitment': return commitmentDialog(id ? getRecord('message', id) : null);
    case 'draft-save': {
      const field = document.getElementById('reply-body');
      // One draft per conversation: replaces any draft kept against an older message of this chat.
      await saveReply(getRecord('message', id), field.value);
      field.defaultValue = field.value;
      return toast('Draft saved on this device.', 'success');
    }

    // Reply drafts with Claude
    case 'draft-reply': {
      const m = getRecord('message', id);
      if (!m) return toast('This message is no longer available. Refresh and try again.', 'error');
      Object.assign(state, { lane: m.data.lane || 'reply', channel: 'all', search: '', selectedMessage: id, selectedKey: messageKey(m) });
      await route('inbox');
      await startDraft(m, rememberedOptions(m.data.channel));
      document.getElementById('reply-body')?.focus({ preventScroll: true });
      return;
    }
    case 'ai-draft-options': {
      if (state.draftPopover) return closeDraftPopover();
      return openDraftPopover(getRecord('message', id));
    }
    case 'ai-draft-pick': {
      const pop = state.draftPopover;
      const [field, value] = ['intent', 'tone', 'length'].map(f => [f, el.dataset[`draft${f[0].toUpperCase()}${f.slice(1)}`]]).find(([, v]) => v) || [];
      if (!pop || !field) return;
      pop.options = pickOption(pop.options, field, value);
      el.closest('.ws-draft-chips').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === el)));
      const times = document.getElementById('draft-free-times');
      if (times) times.checked = pop.options.includeFreeTimes;
      return;
    }
    case 'ai-draft-free-times': if (state.draftPopover) state.draftPopover.options = { ...state.draftPopover.options, includeFreeTimes: el.checked }; return;
    case 'ai-draft-cancel': return closeDraftPopover();
    case 'ai-draft': {
      const pop = state.draftPopover;
      if (!pop) return;
      const m = getRecord('message', pop.id);
      setLocalPref(optionsKey(m?.data.channel), JSON.stringify(pop.options));
      closeDraftPopover(false);
      await startDraft(m, pop.options, pop.instructions);
      document.getElementById('reply-body')?.focus({ preventScroll: true });
      return;
    }
    case 'ai-draft-stop':
      try {
        await mutate('job_cancel', { id });
      } catch (err) {
        // Finished a moment ago: its result (or error) is already on its way.
        if (err?.code !== 'conflict') throw err;
      }
      return;
    case 'ai-draft-regenerate': {
      const m = getRecord('message', id);
      const options = latestDraft(s, draftKeyOf(m))?.data.options || rememberedOptions(m.data.channel);
      return startDraft(m, options, options.instructions);
    }
    case 'ai-draft-retry': case 'ai-draft-choose': {
      const request = s.jobs.find(j => j.id === id)?.payload?.request || {};
      if (action === 'ai-draft-choose' && !(await ensureClaudeChoice())) return;
      dismissDraftError(id);
      return startDraft(getRecord('message', request.sourceId) || getRecord('message', state.selectedMessage), request, request.instructions);
    }
    case 'ai-draft-dismiss': dismissDraftError(id); return render();
    case 'ai-summarize': return startSummary(getRecord('message', id));
    case 'ai-summarize-retry': case 'ai-summarize-choose': {
      const job = s.jobs.find(j => j.id === id);
      if (action === 'ai-summarize-choose' && !(await ensureClaudeChoice())) return;
      dismissDraftError(id);
      return startSummary(getRecord('message', job?.payload?.request?.sourceId) || getRecord('message', state.selectedMessage));
    }
    case 'summary-toggle': {
      const ui = (state.summaryUi[el.dataset.key] ||= {});
      ui.collapsed = !ui.collapsed;
      el.setAttribute('aria-expanded', String(!ui.collapsed));
      document.getElementById('summary-body')?.toggleAttribute('hidden', ui.collapsed);
      return;
    }
    case 'summary-ask-commit': {
      const key = el.dataset.key;
      const ask = getRecord('summary', key)?.data.asks?.find(x => askCommitmentId(key, x) === el.dataset.ask);
      if (!ask) return toast('This summary changed. Refresh and try again.', 'error');
      const id = askCommitmentId(key, ask);
      // An ask already added (or being added) is left alone: saving again would rewrite `done`.
      if (getRecord('commitment', id) || asksSaving.has(id)) return;
      asksSaving.add(id);
      try {
        await mutate('local_save', askCommitment(key, ask));
      } finally {
        asksSaving.delete(id);
      }
      toast('Added to your commitments.', 'success');
      return;
    }
    case 'ai-draft-keep': case 'ai-draft-replace': case 'ai-draft-restore': case 'ai-draft-forget': {
      const m = getRecord('message', id);
      const key = draftKeyOf(m);
      const field = document.getElementById('reply-body');
      const choice = action.slice('ai-draft-'.length);
      const next = answer(draftUi(key), latestDraft(s, key), choice, field?.value ?? '');
      state.drafts[key] = next.ui;
      if (field && field.value !== next.text) field.value = next.text;
      if (next.save != null) await saveReply(m, next.save);
      else await render();
      document.getElementById('reply-body')?.focus({ preventScroll: true });
      return;
    }
    case 'ai-draft-context': {
      const ui = draftUi(el.dataset.key);
      ui.contextOpen = !ui.contextOpen;
      el.setAttribute('aria-expanded', String(ui.contextOpen));
      document.getElementById('draft-context')?.toggleAttribute('hidden', !ui.contextOpen);
      return;
    }
    case 'ai-draft-choice': case 'ai-draft-gap': {
      const field = document.getElementById('reply-body');
      if (!field) return;
      const index = Number(el.dataset.index);
      const aiText = latestDraft(s, field.closest('form').dataset.key)?.data.text;
      if (action === 'ai-draft-gap') {
        const gap = draftGaps(field.value, aiText)[index];
        field.focus();
        if (gap) field.setSelectionRange(gap.start, gap.end);
        return;
      }
      const choice = draftChoices(field.value, aiText)[index];
      if (!choice) return;
      field.value = chooseOption(field.value, index, el.dataset.option, aiText);
      field.focus();
      field.setSelectionRange(choice.start + el.dataset.option.length, choice.start + el.dataset.option.length);
      syncReplyBox(field);
      return;
    }
    case 'reply-copy': {
      const m = getRecord('message', id);
      const text = document.getElementById('reply-body')?.value || '';
      if (!text.trim()) throw new Error('Write a reply first.');
      const open = unfinishedParts(text, latestDraft(s, draftKeyOf(m))?.data.text);
      if (open.length) return confirmUnfinished(open, { submit: 'Copy anyway', then: () => copyReply(m, text) });
      return copyReply(m, text);
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

    // Layout
    case 'customize': return customizeDialog();
    case 'widget-up': case 'widget-down': {
      const row = el.closest('[data-widget]');
      if (action === 'widget-up' && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
      if (action === 'widget-down' && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
      el.focus();
      return;
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
    case 'plugin-addresses': return pluginsUi.submit(form);
    case 'time-zone': await mutate('settings_update', { timeZone: String(f.get('timeZone')).trim() }); return toast('Time zone saved.', 'success');
    case 'quiet-hours': await mutate('settings_update', { quietStart: f.get('quietStart'), quietEnd: f.get('quietEnd') }); return toast('Quiet hours saved.', 'success');
    case 'registration':
      return confirmModal({ title: 'Change application registration?', text: 'You will need to sign in to Microsoft again.', confirm: 'Save and sign out', onConfirm: () => mutate('settings_update', { clientId: String(f.get('clientId')).trim(), tenant: String(f.get('tenant')).trim() }) });
    case 'reply': {
      const id = form.dataset.id;
      const key = form.dataset.key || id;
      // A re-render can replace the form mid-request; never prepare two sends for one reply.
      if (replyInFlight.has(key)) return undefined;
      const body = String(f.get('body') || '');
      const open = unfinishedParts(body, latestDraft(snap(), key)?.data.text);
      if (open.length) return confirmUnfinished(open, { submit: 'Review anyway', then: () => prepareReply(id, body) });
      replyInFlight.add(key);
      try {
        return await prepareReply(id, body);
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
  // Once the reply is sent there is nothing left to restore.
  return reviewAction(result, { onSent: () => { if (state.drafts[draftKeyOf(m)]) state.drafts[draftKeyOf(m)].restore = null; } });
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
  if (ev.target.id === 'reply-body') syncReplyBox(ev.target);
  if (ev.target.id === 'auto-prompt') {
    const count = ev.target.closest('form')?.querySelector('[data-auto-count]');
    if (count) count.textContent = `${ev.target.value.length.toLocaleString('en-US')} / 4,000`;
  }
  if (ev.target.id === 'draft-instructions' && state.draftPopover) {
    state.draftPopover.instructions = ev.target.value;
    const count = document.querySelector('[data-draft-count]');
    if (count) count.textContent = ev.target.value.length ? `${ev.target.value.length.toLocaleString('en-US')} / 1,000` : 'Optional';
  }
  if (ev.target.id === 'today-note') {
    clearTimeout(noteTimer);
    const label = document.getElementById('note-state');
    if (label) label.textContent = 'Editing…';
    const el = ev.target;
    noteTimer = setTimeout(() => saveNote(el), 900);
  }
});

// The draft options popover: Esc closes it, ⌘↵ drafts, Tab stays inside it.
document.addEventListener('keydown', ev => {
  const pop = state.draftPopover && document.getElementById('draft-options');
  if (!pop || modalOpen()) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    closeDraftPopover();
  } else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    pop.querySelector('[data-action="ai-draft"]')?.click();
  } else if (ev.key === 'Tab') {
    const focusable = [...pop.querySelectorAll('button:not(:disabled),textarea,input')].filter(x => x.offsetParent !== null);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!pop.contains(document.activeElement)) {
      ev.preventDefault();
      first?.focus();
    } else if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last?.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first?.focus();
    }
  }
}, true);

document.addEventListener('mousedown', ev => {
  if (state.draftPopover && !ev.target.closest('#draft-options, [data-action="ai-draft-options"]')) closeDraftPopover(false);
}, true);
window.addEventListener('resize', placeDraftPopover);
document.addEventListener('scroll', placeDraftPopover, true);

document.addEventListener('keydown', ev => {
  if (!ready || modalOpen() || editing() || state.draftPopover || ev.metaKey || ev.ctrlKey || ev.altKey) return;
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
    if (ready && ['today', 'calendar', 'automations'].includes(state.route) && !modalOpen() && !editing() && !legacyMounted) await render().catch(() => {});
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
  const select = notificationWorkspaceToSelect(payload, snap().settings.activeWorkspace);
  if (select) await mutate('workspace_select', { id: select });
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
  // An automation's result or failure: its run, open in the Run log.
  const run = notificationTarget(payload);
  if (run) return automationsUi.openRun(run.expanded[0], run.filter);
  return route('settings', 'activity');
}

// ---------------------------------------------------------------- recovery

let recovering = null;
// What the page shows: the `storage_status` result, the failing call's message (`cause`) and
// `restarting` once a restart was accepted.
let recoveryView = null;
let recoveryDeferred = false;
// The invoke watcher and the caller's catch both see the same failure: it is handled once.
const firstStorageReport = firstReport();

// The data folder can't be used (DESIGN 8): the workspace gives way to the recovery page until
// Connect restarts. A setup running in the CodeMie tools keeps its screen; one toast says why,
// and the page opens on the next failing call once the setup is done.
function showRecovery(err) {
  if (recovering) return recovering;
  if (!firstStorageReport(err)) return undefined;
  if (legacyMounted && legacyModule?.legacyToolsBusy()) {
    if (!recoveryDeferred) toast(err?.message || String(err), 'error');
    recoveryDeferred = true;
    return undefined;
  }
  ready = false;
  recovering = (async () => {
    document.querySelectorAll('.ws-modal[open]').forEach(d => d.close());
    if (legacyMounted) {
      legacy.classList.add('hidden');
      document.body.append(legacy);
      legacyMounted = false;
    }
    const status = await invoke('storage_status').catch(() => null);
    recoveryView = { ...status, cause: err?.message || '' };
    renderRecovery();
  })();
  return recovering;
}

function renderRecovery() {
  root.dataset.route = 'recovery';
  root.innerHTML = recoveryPage(recoveryView);
}

// Native accepted the restart and Connect is about to exit: the actions stay disabled.
async function restartWith(command) {
  await invoke(command);
  recoveryView = { ...recoveryView, restarting: true };
  renderRecovery();
}

async function recoveryAction(action) {
  if (recoveryView?.restarting) return;
  if (action === 'recovery-retry') return restartWith('app_relaunch');
  if (action === 'recovery-choose') return dataFlow.open({ recovery: true, info: { dataRoot: recoveryView?.dataRoot } });
  if (action === 'recovery-default') {
    const where = recoveryView?.defaultRoot ? `its default folder (${recoveryView.defaultRoot})` : 'its default folder';
    return confirmModal({
      title: 'Use the default folder?',
      text: `Connect will restart with the data in ${where}. Nothing is moved or deleted. ${USE_DEFAULT_WARNING}`,
      confirm: 'Use the default folder',
      initialFocus: 'cancel', guard: true,
      onConfirm: () => restartWith('data_location_use_default'),
    });
  }
  if (action === 'recovery-tools') {
    root.classList.add('hidden');
    legacy.classList.remove('hidden');
    legacyModule = await import('../renderer.js');
    await legacyModule.initLegacyTools();
  }
}

// ---------------------------------------------------------------- data location

let storageLoads = 0;
const generalTabOpen = () => state.route === 'settings' && state.settingsTab === 'general';

/** Reads where Connect keeps its data, for Settings → General. */
async function loadStorage() {
  const load = ++storageLoads;
  try {
    const info = await invoke('data_location_get');
    if (load !== storageLoads) return;
    Object.assign(state.storage, { info, error: '' });
  } catch (err) {
    if (load !== storageLoads) return;
    Object.assign(state.storage, { info: null, error: err?.message || String(err) });
  }
  if (generalTabOpen() && !modalOpen()) await render();
}

async function storageAction(action, el) {
  const info = state.storage.info;
  switch (action) {
    case 'data-refresh': return loadStorage();
    case 'data-copy-path':
      try {
        await navigator.clipboard.writeText(info.dataRoot);
        return toast('Folder path copied.', 'success');
      } catch {
        return toast(`Could not copy. The folder is ${info.dataRoot}`, 'error');
      }
    case 'data-reveal': return invoke('data_location_reveal', { which: el.dataset.which });
    case 'data-change': return dataFlow.open({ info });
    // Restarting or deleting is never the default button: Cancel has focus, and a click or Enter
    // in the first moments after the dialog opens does nothing.
    case 'data-default': return openModal({
      title: 'Use the default folder?', body: useDefaultBody(info), submit: 'Use the default folder and restart', size: 'md',
      initialFocus: 'cancel', guard: true,
      onSubmit: async () => {
        await invoke('data_location_use_default');
        state.storage.restarting = true;
      },
    });
    case 'data-remove-old': return openModal({
      title: 'Remove the old copy?', body: removeOldBody(info), submit: 'Remove old copy', variant: 'danger', size: 'md',
      initialFocus: 'cancel', guard: true,
      onSubmit: async () => {
        const { removedBytes } = await invoke('data_location_remove_old');
        toast(`Old copy removed. ${formatBytes(removedBytes)} freed.`, 'success');
        loadStorage().catch(fail);
      },
    });
    case 'data-choose': return dataFlow.choose();
    case 'data-back': return dataFlow.back();
    case 'data-cancel': return dataFlow.cancel();
    case 'data-restart': return dataFlow.restart();
    case 'data-quit': return dataFlow.quit();
    default: return undefined;
  }
}

// The change dialog (data-location-flow.js). Once the pointer names the new folder, the page
// behind it shows that Connect is restarting.
const dataFlow = createDataLocationFlow({
  invoke,
  onRestarting: flow => {
    if (flow.recovery) {
      recoveryView = { ...recoveryView, restarting: true };
      renderRecovery();
    } else {
      state.storage.restarting = true;
    }
  },
});

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
  if (flags.plugin === 'isolation') {
    const { runIsolationSmoke } = await import('../plugins/isolation-smoke.js');
    return runIsolationSmoke(invoke, { runId: flags.plugin_run_id });
  }
  if (flags.smoke || flags.probe) {
    root.classList.add('hidden');
    legacy.classList.remove('hidden');
    legacyModule = await import('../renderer.js');
    await legacyModule.initLegacyTools();
    return;
  }
  const hash = location.hash.split('/');
  if (hash[1] === 'p' && PLUGIN_ID.test(hash[2] || '') && PLUGIN_ITEM.test(hash[3] || '')) {
    state.route = 'plugin';
    state.pluginPage = { id: hash[2], activity: hash[3], route: hash.slice(4).join('/') };
  } else {
    if (hash[1]) state.route = ROUTES.includes(hash[1]) ? hash[1] : 'today';
    if (hash[2] && state.route === 'automations') state.automations.tab = AUTOMATION_TABS.some(([id]) => id === hash[2]) ? hash[2] : 'automations';
    else if (hash[2]) state.settingsTab = hash[2];
    if (state.route === 'settings' && hash[2] === 'plugins' && PLUGIN_ID.test(decodeURIComponent(hash[3] || ''))) {
      const section = decodeURIComponent(hash[4] || '');
      state.pluginPath = { id: decodeURIComponent(hash[3]), section: PLUGIN_ITEM.test(section) ? section : null };
    }
  }
  try {
    await store.refresh();
  } catch (err) {
    return showRecovery(err);
  }
  await bootWorkspace(store, snap());
  runtimeReady = await invoke('runtime_ready').catch(() => false);
  state.appVersion = await invoke('get_app_version').catch(() => '');
  // Plugin UIs: one sandboxed frame per enabled plugin with a client half, in a layer outside the
  // page the app redraws. A dev build may serve the frames from elsewhere (`pluginFrameBase`, the
  // browser E2E's stand-in for the connect-plugin scheme).
  const frameUrl = flags.dev && typeof flags.pluginFrameBase === 'string'
    ? (id, path) => `${flags.pluginFrameBase}${pluginUrl(id, path, { macos: true }).slice('connect-plugin://'.length)}`
    : pluginUrl;
  pluginHost = createPluginHost({
    invoke,
    frameUrl,
    about: () => ({ name: 'CodeMie Connect', version: state.appVersion, engine: '1.0' }),
    theme: () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    whereNow: () => ({ view: state.route, section: state.route === 'settings' ? state.settingsTab : '', route: '' }),
    onChange: pluginsChanged,
    onGo: hash => { goHash(hash).catch(fail); },
    onNotice: (text, name) => toast(`${name}: ${text}`),
    onCopy: text => navigator.clipboard.writeText(text).then(() => toast('Copied.', 'success'), fail),
  }).mount(document.body);
  lastPluginTheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  pluginsUi.loadInstalled().catch(() => {
    // Settings → Plugins says why; a plugin page opened at start says it isn't available.
    state.pluginsKnown = true;
    pluginsChanged();
  });
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
    if (!ready) return;
    // A run started, ended or was stored: the Run log reads its newest page again.
    automationsUi.snapshotChanged(result.snapshot)?.catch(() => {});
    // A draft that arrived for the open reply box is applied first, whatever is on screen.
    const arrived = !legacyMounted && applyArrivedDraft(result.snapshot);
    if (modalOpen() || legacyMounted) return;
    if (state.draftPopover) {
      heldRender = true;
      return;
    }
    // While the user types a reply, only their own draft (its progress or result) re-renders
    // around the box; typing anywhere else waits for the next update.
    if (editing() && !(document.activeElement?.id === 'reply-body' && (arrived || draftSignature(result.snapshot) !== lastDraftSignature))) return;
    render();
  });
  state.calendarDate = todayDate();
  ready = true;
  await render();
  if (aiTabOpen()) loadAi().catch(fail);
  if (generalTabOpen()) loadStorage().catch(fail);
  if (runLogOpen()) automationsUi.loadRuns().catch(fail);
  if (state.route === 'settings' && state.settingsTab === 'plugins') pluginsUi.load().catch(fail);
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
  // Focus that only moved into a plugin's frame and back never left Connect: refreshing then would
  // redraw the page between a click's mousedown and mouseup, and the click would be lost.
  let focusInPluginFrame = false;
  window.addEventListener('blur', () => setTimeout(() => {
    focusInPluginFrame = document.hasFocus() && !!document.activeElement?.matches?.('iframe[data-plugin-frame]');
  }));
  window.addEventListener('focus', () => {
    if (focusInPluginFrame) {
      focusInPluginFrame = false;
      return;
    }
    store.refresh().catch(() => {});
    // Back from Terminal or Settings: Claude may be signed in or set up now.
    if (readClaude({ now: true, detect: claudeRecheck })) claudeRecheck = false;
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (snap().settings.theme === 'system') {
      applyTheme('system');
      if (!modalOpen() && !editing()) render();
    }
  });
  window.addEventListener('cm-theme-change', event => mutate('settings_update', { theme: event.detail }).catch(fail));
  const authTimer = setInterval(() => { if (store.get()?.authPending) store.refresh().catch(() => {}); }, 1500);
  setInterval(tick, 30_000);
  setInterval(draftTick, 1000);
  scheduleMinuteRender();
  window.addEventListener('pagehide', () => clearInterval(authTimer), { once: true });
  if (state.route === 'calendar') await ensureCalendarWindow();
  if (flags.dev) window.__workspace = { store, state, route, render, ensureClaudeChoice, withClaudeChoice };
  if (shouldCheckForAppUpdate(localPref(`codemie.app.lastUpdateCheck.${state.appVersion}`, null))) checkAppUpdate().catch(() => {});
}

boot().catch(err => {
  window.__bootError = String(err?.stack || err);
  fail(err);
});
