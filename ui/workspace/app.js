// Workspace controller: routing, native snapshot rendering and actions. Settings → CodeMie is
// codemie/controller.js; the legacy installer UI (ui/renderer.js) only serves smoke/probe mode
// and the storage-recovery page.
import { createStore, escapeHtml as e } from './store.js';
import { shouldCheckForAppUpdate } from '../app-updater-utils.mjs';
import { icon } from './icons.js';
import { badge, button, toast, openModal, confirmModal, onModalClose, field, textInput, textArea, select, checkbox, controlSelector, soleMatch } from './ui.js';
import { calendarWindow, calendarCoverage, calendarIds, calendarCatalog, calendarColors } from './calendar-model.js';
import { active, decisions, connectionState, records, LANES, messageTitle, collapseChats, messageKey, conversation, draftKeyOf, draftJob, latestDraft, savedReply, summaryKeyOf, summaryJob, summaryFor } from './selectors.js';
import { askCommitment, askCommitmentId } from './summary-state.js';
import { dayKey, dateFromKey, zonedParts } from './format.js';
import { today, drawnGrid, tileDefs } from './view-today.js';
import { createTodayController, attachTodayDrag, newTodayView } from './today-controller.js';
import { GRID, todayOf } from './today-grid.js';
import { activateTab, loadDock, saveDock, setCollapsed, visibleTabs } from './dock-model.js';
import { attachDock } from './dock-controller.js';
import { calendar, eventDetails, eventActions, HOUR_HEIGHT, CALENDAR_DOCK } from './view-calendar.js';
import { inbox, filteredMessages, snoozeUntil, draftChecks, changeLine, replyStatusHtml, INBOX_DOCK } from './view-inbox.js';
import { sendTarget, primaryAction, confirmLines, sendKeyAllowed } from './reply-model.js';
import {
  optionsKey, readOptions, pickOption, draftRequest, reconcile, answer, replyBox, runningLabel, chooseOption, draftChoices, draftGaps, unfinishedParts, claudeAvailable, claudeCheck,
  startChange, changeRequest,
} from './draft-state.js';
import { settings, settingsTabFor, SETTINGS_GROUPS, SETTINGS_MENU } from './view-settings.js';
import { trackPress } from './press.js';
import { createCodemieService } from './codemie/service.js';
import { createCodemieController } from './codemie/controller.js';
import { createRunLog } from './codemie/run-log.js';
import { createSetupSession } from './codemie/setup-session.js';
import { startSetup, cancelSetup } from '../setup-driver.js';
import { automations, AUTOMATION_TABS, AUTOMATIONS_DOCK } from './view-automations.js';
import { createAutomationsController, notificationTarget } from './automations-controller.js';
import { analyticsView, analyticsCharts } from './view-analytics.js';
import { createAnalyticsController, attachAnalyticsTips } from './analytics-controller.js';
import { SESSIONS_PAGE } from './analytics-model.js';
import { tasksPage } from './view-tasks.js';
import { createTasksController, attachBoardDrag } from './tasks-controller.js';
import { activeProvider, newTasksView, tasksOf } from './tasks-model.js';
import { shownView } from './tasks-dates-model.js';
import { legacyMeetingsLayout, meetings, shownCall, MEETINGS_DOCK } from './view-meetings.js';
import { createMeetingsController } from './meetings-controller.js';
import { activeTaskTarget, addedLine } from './task-target.js';
import { createMeetingsSettingsController, newMeetingsSettingsView } from './meetings-settings-controller.js';
import { createVoiceController, newVoiceView } from './voice-controller.js';
import { HASH_ROUTES, meetingHash, newMeetingsView, parseHash } from './meetings-model.js';
import { seenToSend, openTarget, sendSeen } from './menu-bar.js';
import { renderShell, terminalButton, groupFolded, NAV_GROUPS, firstVisiblePage, toggleHiddenPage } from './shell.js';
import { createTerminalDock } from './terminal-dock.js';
import { Terminal } from '../vendor/xterm.mjs';
import { FitAddon } from '../vendor/addon-fit.mjs';
import { nextAiSettings, withCodemieSignIn, LOGIN_STEPS } from './settings-ai.js';
import { chooserBody, CHOOSER_TITLE } from './ai-chooser.js';
import { bootWorkspace, notificationWorkspaceToSelect } from './boot.js';
import { recoveryPage, firstReport, USE_DEFAULT_WARNING } from './recovery.js';
import { formatBytes, removeOldBody, useDefaultBody } from './settings-storage.js';
import { createDataLocationFlow } from './data-location-flow.js';
import { withAppOrigin } from './app-invoke.js';
import { pluginUrl } from '../plugins/frame-url.js';
import { createPluginHost, internalRoute } from '../plugins/host.js';
import { createPluginsController } from './settings-plugins.js';
import { createRemovalSwitch } from './task-provider-watch.js';
import { pluginWidgetCatalog, parseLayoutId, heldText, textOfHtml } from './today-plugins.js';
import { viewOf, readViewMirror, writeViewMirror } from './view-mode.js';
import { clickRow, enterRow, escRow, nextAfter, followOpen, retrySource } from './inbox-open.js';
import { captureBar, isCaptureKey, newCaptureView } from './capture-model.js';
import { createCaptureController } from './capture-controller.js';
import { isAskKey, isStopKey, newAskView } from './ask-model.js';
import { askPage, answeringLine, nextAskStatus } from './view-ask.js';
import { createAskController } from './ask-controller.js';

const ROUTES = HASH_ROUTES;
const root = document.getElementById('workspace-app');
const legacy = document.getElementById('app');
// First paint, before the native snapshot loads: the mirrored view, so Compact's size tokens
// apply at once instead of flashing Default.
let firstView = 'default';
try { firstView = readViewMirror(localStorage); } catch { /* default */ }
root.dataset.view = firstView;
document.documentElement.dataset.view = firstView;
const rawInvoke = window.__TAURI__?.core?.invoke;
const appInvoke = rawInvoke && withAppOrigin(rawInvoke, location.origin);
// A tour build (CODEMIE_TOUR) puts the tour's gate in front of every call the window makes to
// native: each workspace op is recorded, and one the tour's deny-list names (a send, a fetch, an
// install, anything that opens Finder, Terminal, a browser or a picker) is refused before it is
// sent (tour/runner.js).
let tourGated = null;
const invoke = appInvoke && ((cmd, args, options) => (tourGated || appInvoke)(cmd, args, options));
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
  route: 'today', settingsTab: 'general', settingsQuery: '',
  calendarMode: localPref('codemie.calendar.mode', 'week'), calendarDate: new Date(),
  lane: 'reply', channel: 'all', search: '', showArchived: false, showSnoozed: false, inboxLimit: 200, selectedMessage: null, selectedKey: null,
  // Compact Inbox: the row shown open (apart from the selected one) and its conversation, the row
  // to select after a decision takes the open one away, threads shown whole ("Earlier"), and
  // reply text typed in a box that left the screen, per draft key (both views).
  openMessage: null, openKey: null, selectAfter: null, threadAll: new Set(), replyCarry: {},
  appVersion: '', latestVersion: null, updateStatus: '', updateBusy: false,
  ai: { status: 'idle', profiles: [], settings: { defaultProfile: null, routes: {} }, chosen: {}, usage: null, error: '', tests: {}, testModels: {} },
  // Settings → General → Data location: the `data_location_get` answer (null until read).
  storage: { info: null, error: '', restarting: false },
  // Reply drafts: this session's reply-box decisions per draft key (see `replyBox`), the open
  // options popover, and failed drafts the user dismissed.
  drafts: {}, summaryUi: {}, draftPopover: null, draftDismissed: localJson('codemie.draft.dismissed', []),
  // The reply box the user clicked or typed in (its draft key; the ⌘↩ gate), and each
  // conversation's status line ("Saved on this device").
  replyTouched: null, replyStatus: {},
  // Automations: the open tab and the Run log pages read with `automation_runs` (null until read).
  automations: { tab: 'automations', highlight: null, runs: { items: null, next: null, error: '', filter: '', expanded: [], loadingMore: false } },
  // Tasks: board or list, filters, the open drawer and quick add (view state only; tasks are native's).
  tasks: newTasksView(localPref('codemie.tasks.view', 'board')),
  // Meetings: the list's filter and search, the selected meeting and tab, the hidden list, the
  // document editor (view state only; meetings are native's). The calendar's "Only meetings with
  // transcripts" and the legend groups turned off.
  meetings: newMeetingsView({ hidden: localJson('codemie.meetings.hidden', null) }),
  calendarTranscripts: localPref('codemie.calendar.transcripts', 'false') === 'true', calendarLegend: {},
  // Settings › Meetings: the template being edited, refusals by field, the glossary and tags as
  // typed, the rule tester (view state only; settings, templates and rules are native's).
  meetingsSettings: newMeetingsSettingsView(),
  // Settings › Your voice: the open style card or instruction editor (with what was typed), the
  // skill import preview, busy flags (view state only; the voice is native's).
  voice: newVoiceView(),
  // Today: Customize mode, undo and redo, the open options panel, the gallery search, renaming.
  today: newTodayView(),
  // Plugins: the page open under #/p/<id>/<activity>/<route>, the Settings → Plugins path
  // ({id, section}), what is installed, and the text of page widgets their frames drew.
  pluginPage: null, pluginPath: null, installedPlugins: [], pluginsKnown: false, widgetText: {},
  // Quick capture (⌘N): the bar's view state, its Task / Note choice kept for the session.
  capture: newCaptureView(),
  // Ask (⌘K): the menu field's words, list and About chip, the page it was opened from, the
  // thread `#/ask/<id>` shows. The calendar event whose card is open (the About chip's event).
  ask: newAskView(), openEvent: null,
};
let pluginHost = null;
// Connect's terminal dock (terminal-dock.js), made with the plugin host.
let terminalDock = null;
/** The meeting the Meetings page shows, as plugins' call slots get it (Echo's call), or null. */
let pluginCall = null;
let lastPluginTheme = '';
const drawnWidgets = new Map();
// Settings → CodeMie: the CLI state behind it, "What CodeMie ran", the guided-setup session
// (`codemie setup` in a headless PTY) and the controller that owns actions, sheet and banners.
const codemieRunLog = createRunLog();
const codemieSetup = createSetupSession({
  // The PTY bridge and xterm load on first use: neither is needed until someone sets up CodeMie.
  startSetup: async opts => {
    const [{ pty }, { Terminal }] = await Promise.all([import('../runner-bridge.js'), import('../vendor/xterm.mjs')]);
    return startSetup(opts, { spawnPty: pty.spawnPty, input: pty.input, kill: pty.kill, Terminal, suspendPtyInput: () => {}, resumePtyInput: () => {} });
  },
  cancelSetup,
  readProfiles: () => invoke('read_codemie_profiles'),
});
const codemieService = createCodemieService({
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, fn) => window.__TAURI__.event.listen(event, fn),
  runLog: codemieRunLog,
  platform: /^Win/i.test(navigator.platform || '') ? 'windows' : 'macos',
  setupRunning: () => codemieSetup.running(),
});
const codemie = createCodemieController({
  state, service: codemieService, session: codemieSetup, runLog: codemieRunLog,
  render: () => render(), route: (name, tab) => route(name, tab),
  openModal, confirmModal, toast,
  writeText: text => navigator.clipboard.writeText(text),
  localPref, setLocalPref, store, invoke: (cmd, args) => invoke(cmd, args),
  canRender: () => ready && !recovering && !modalOpen(),
  editing: () => editing() && !!document.activeElement?.closest('.ws-settings-content,#cm-sheet-host'),
  claudeReady: () => claudeProfileReady(),
});
codemie.busy = () => codemieSetup.running() || codemieService.busy();
// Settings → Claude detects CodeMie profiles natively (cached for 30 s): a profile added, renamed,
// removed or made active in Settings → CodeMie is detected again at once, so both tabs agree.
let codemieProfilesSeen = null;
codemieService.subscribe(() => {
  const cm = codemieService.state;
  if (!cm.loaded) return;
  const seen = JSON.stringify([cm.profiles.map(p => p.name), cm.config.active]);
  if (codemieProfilesSeen !== null && seen !== codemieProfilesSeen && ready && !recovering) {
    if (aiTabOpen()) loadAi().catch(() => {});
    else readClaude({ now: true, detect: true });
  }
  codemieProfilesSeen = seen;
});

/** A Claude profile that can be used already brings AI tools to this Mac (see the Today setup card). */
function claudeProfileReady() {
  return state.ai.status === 'ready' && Array.isArray(state.ai.profiles) && state.ai.profiles.some(p => p.state === 'ready');
}
let legacyModule;
let ready = false;
let deferredNotification;
let calendarScrollKey = '';
let noteTimer;
// The reply box's autosave: the pending timer and the saves in order (one at a time).
let replySaveTimer;
let replySaving = Promise.resolve();
let searchTimer;
let taskSearchTimer;
let meetingSearchTimer;
let gallerySearchTimer;
let analyticsSearchTimer;
// A card is being dragged on the Tasks board: updates wait until it is dropped.
let taskDrag = false;
// A Today widget is being moved, resized or dragged in, a section's divider or tab is held, or a
// menu edge is: every render waits until its drop has been saved (or refused) and drawn, so what
// was moved by hand is not redrawn under the pointer. Set by holdLayout, which counts the holds.
let layoutDrag = false;
let layoutHolds = 0;
// The mouse button is down: an update redrawn between a click's mousedown and mouseup would
// replace the control under the pointer and lose the click, so it waits for the mouseup.
let pressing = false;
// The Ask field opened or closed while the button was down (a click into it, or elsewhere): drawn
// once the button is up, so the press isn't redrawn away (the field keeps its focus and caret).
let askHeld = false;
// What the Ask page's one live status says now (`nextAskStatus`), outside the page.
let askStatus = null;
// A focus the Ask field asked for while the button was down (a click into it selects its words):
// applied after that render, once the click has placed its caret.
let askFocusHeld = null;
const replyInFlight = new Set();
const asksSaving = new Set();
const KEEP_FOCUS = new Set(['capture-mode', 'ai-draft-pick', 'ai-draft-context', 'summary-toggle', 'automation-kind', 'run-toggle', 'dock-tab', 'sidebar-toggle', 'sidebar-fold', 'settings-group', 'settings-groups-all', 'settings-menu-toggle', 'layout-handles', 'analytics-step', 'analytics-step-toggle', 'analytics-session-tab']);
let lastDraftSignature = '';
// Updates that arrived while held (the draft options popover open, a card or widget dragged, the
// mouse button down); shown once that ends.
let heldRender = false;

/** Holds renders while a layout drag is on (`on`) and lets one go (`!on`). Holds are counted
 *  across Today, the page sections and the menu edges, so letting one go doesn't let renders
 *  through under another; when the last is let go, the render held meanwhile runs. */
function holdLayout(on) {
  layoutHolds = Math.max(0, layoutHolds + (on ? 1 : -1));
  layoutDrag = layoutHolds > 0;
  if (!layoutDrag && heldRender && !modalOpen()) render().catch(fail);
}

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
    // A save that ran while the mouse button is down (the reply box's blur on a press) renders
    // after the click, like the updates held then: a redraw mid-press would swallow the click.
    if (ready && !modalOpen() && pressing) heldRender = true;
    else if (ready && !modalOpen()) await render();
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

function applyView(view) {
  root.dataset.view = view;
  document.documentElement.dataset.view = view;
  writeViewMirror(localStorage, view);
}

function setView(view) {
  flushReplySave();
  state.replyTouched = null;
  applyView(view);
  closeRow();
  return mutate('settings_update', { view });
}

// ---------------------------------------------------------------- shell

const shellMarkup = () => renderShell({
  snapshot: snap(), route: state.route, resolvedDark: document.documentElement.classList.contains('dark'),
  terminals: terminalDock?.state(),
  plugins: { activities: pluginHost?.activities() || [], current: state.route === 'plugin' && state.pluginPage ? { plugin: state.pluginPage.id, id: state.pluginPage.activity } : null },
  settingsDot: codemie.settingsDot(), sidebarCollapsed: sidebarCollapsed(), sidebarFolded: sidebarFolded(),
  meetingsHidden: state.meetings.hidden, hiddenPages: snap().settings.hiddenPages || [], askState: state,
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
  // CodeMie: what needs the person (signed out, an agent too old, the gateway stopped).
  out.push(codemie.banners(state.route));
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
    // The open Compact row's thread box keeps its place while the same row stays open.
    thread: q('.ws-thread-compact')?.scrollTop || 0,
    threadId: q('.ws-thread-compact')?.dataset.id,
    reader: q('.ws-read')?.closest('.ws-reader')?.scrollTop || 0,
    readerId: q('.ws-read')?.dataset.messageId,
    nav: q('.ws-settings-sidebar')?.scrollTop || 0,
    menu: q('.ws-main-nav')?.scrollTop || 0,
    panels: q('.ws-settings-panels')?.scrollTop || 0,
    tab: q('.ws-settings-nav [aria-current=page]')?.dataset.tab,
    board: q('.ws-task-board')?.scrollLeft || 0,
    drawer: q('.ws-task-drawer-body')?.scrollTop || 0,
    drawerId: state.tasks.drawer,
    // The Analytics session drawer and its side panel keep their place while the same session shows.
    anDrawer: q('.ws-an-db')?.scrollTop || 0,
    anSide: q('.ws-an-side')?.scrollTop || 0,
    anSession: q('.ws-an-drawer') ? analyticsUi?.data.session?.id : null,
    meetingList: q('.ws-mtg-list-body')?.scrollTop || 0,
    // Meetings: each meeting tab in view scrolls on its own, kept by meeting and tab.
    meetingTabs: Object.fromEntries([...root.querySelectorAll('.ws-mtg-detail[data-panel]')].map(el => [`${el.dataset.meeting}|${el.dataset.panel}`, el.scrollTop])),
    // Today: each tile's body scrolls on its own, kept by the tile's widget id.
    tiles: Object.fromEntries([...root.querySelectorAll('[data-tile] > .ws-tile-body')].map(body => [body.parentElement.dataset.tile, body.scrollTop])),
    // A row of page sections wider than the page scrolls sideways, kept by page; a section's body
    // scrolls on its own, kept by the page and tab it shows (the tab that labels it).
    dockRows: Object.fromEntries([...root.querySelectorAll('.ws-dock[data-page]')].map(row => [row.dataset.page, row.scrollLeft])),
    sections: Object.fromEntries([...root.querySelectorAll('.ws-dock .ws-pane-body')].map(body => [body.getAttribute('aria-labelledby'), body.scrollTop])),
  };
}

function restoreScroll(saved) {
  const q = sel => root.querySelector(sel);
  if (q('.ws-main')) q('.ws-main').scrollTop = saved.main;
  if (q('.ws-main-nav')) q('.ws-main-nav').scrollTop = saved.menu;
  if (q('.ws-task-board')) q('.ws-task-board').scrollLeft = saved.board;
  if (q('.ws-task-drawer-body') && saved.drawerId === state.tasks.drawer) q('.ws-task-drawer-body').scrollTop = saved.drawer;
  if (saved.anSession && saved.anSession === analyticsUi?.data.session?.id) {
    if (q('.ws-an-db')) q('.ws-an-db').scrollTop = saved.anDrawer;
    if (q('.ws-an-side')) q('.ws-an-side').scrollTop = saved.anSide;
  }
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
  for (const body of root.querySelectorAll('[data-tile] > .ws-tile-body')) {
    const top = saved.tiles[body.parentElement.dataset.tile];
    if (top) body.scrollTop = top;
  }
  if (q('.ws-inbox-items')) q('.ws-inbox-items').scrollTop = saved.list;
  const thread = q('.ws-thread-compact');
  if (thread && thread.dataset.id === saved.threadId) thread.scrollTop = saved.thread;
  else if (thread) showLatest(thread);
  const reader = q('.ws-reader');
  if (reader && saved.readerId && q('.ws-read')?.dataset.messageId === saved.readerId) reader.scrollTop = saved.reader;
  if (q('.ws-settings-sidebar')) q('.ws-settings-sidebar').scrollTop = saved.nav;
  // Meetings: the list keeps its place; a meeting tab keeps its place unless another meeting opened.
  if (q('.ws-mtg-list-body')) q('.ws-mtg-list-body').scrollTop = saved.meetingList;
  for (const el of root.querySelectorAll('.ws-mtg-detail[data-panel]')) {
    const top = saved.meetingTabs[`${el.dataset.meeting}|${el.dataset.panel}`];
    if (top) el.scrollTop = top;
  }
  for (const row of root.querySelectorAll('.ws-dock[data-page]')) {
    const left = saved.dockRows[row.dataset.page];
    if (left) row.scrollLeft = left;
  }
  for (const body of root.querySelectorAll('.ws-dock .ws-pane-body')) {
    const top = saved.sections[body.getAttribute('aria-labelledby')];
    if (top) body.scrollTop = top;
  }
  if (q('.ws-settings-panels') && saved.tab === state.settingsTab) q('.ws-settings-panels').scrollTop = saved.panels;
}

/** A Compact row's thread box, just opened: scrolled to its newest messages, but never past the
 *  message the row stands for (`.ws-current`), which stays in view. */
function showLatest(box) {
  box.scrollTop = box.scrollHeight;
  const current = box.querySelector('.ws-current');
  if (!current) return;
  const top = current.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  if (top < box.scrollTop) box.scrollTop = Math.max(0, top - 4);
}

// Layout preferences of this Mac: locked layouts hide the grips and handles; the handles show on
// hover (the default), always, or only in Customize.
function applyLayoutPrefs(locked) {
  const handles = localPref('codemie.layout.handles', 'hover');
  root.classList.toggle('ws-locked', locked);
  root.classList.toggle('ws-handles-always', handles === 'always');
  root.classList.toggle('ws-handles-customize', handles === 'customize');
  root.classList.toggle('ws-sidebar-collapsed', sidebarCollapsed());
}

// Narrower than 640 px, Today's widgets stack in one column (its CSS asks the page's width): no
// moves or resizes there.
function measureToday() {
  const page = root.querySelector('.ws-today-page');
  state.today.stacked = !!page && page.clientWidth < GRID.stackBelow;
}

/** Says `text` in a polite live region (a widget moved or resized). */
function announce(text) {
  let live = document.getElementById('ws-live');
  if (!live) {
    live = document.createElement('div');
    live.id = 'ws-live';
    live.className = 'ws-sr';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 30);
}

/** The day (workspace zone) the Tasks page was last drawn on; the minute timer draws it again
 *  once that day has passed. */
let tasksDrawnDay = null;

async function render() {
  if (layoutDrag) {
    heldRender = true;
    return;
  }
  if (!store?.get() || recovering) return;
  const note = document.getElementById('today-note');
  const unsavedNote = note && note.value !== note.defaultValue ? { workspaceId: note.dataset.workspaceId, text: note.value } : null;
  const reply = document.getElementById('reply-body');
  const replyKey = reply?.closest('form')?.dataset.key;
  const unsavedReply = reply && reply.value !== reply.defaultValue ? { key: replyKey, text: reply.value } : null;
  // Words typed in the change line stay through the render (the line itself is redrawn).
  const changeWords = document.getElementById('reply-change')?.value || '';
  // A reply box the user is in (or has typed in) is kept as it is, not recreated: its focus,
  // selection, undo history and IME composition survive the re-render around it.
  const keepReply = reply && (document.activeElement === reply || unsavedReply) ? reply : null;
  const focused = document.activeElement;
  const refocus = focused && focused !== document.body && root.contains(focused) ? controlSelector(focused) : null;
  // A field typed in keeps its caret (and selection) when the render puts focus back on it.
  const caret = refocus && typeof focused.selectionStart === 'number' ? { value: focused.value, range: [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] } : null;
  heldRender = false;
  // A ⋯ menu the user opened stays open through an update (a minute tick, a new snapshot).
  const openMenus = [...root.querySelectorAll('details.ws-menu[open][data-menu]')].map(d => d.dataset.menu);
  const saved = captureScroll();
  const s = snap();
  applyTheme(s.settings.theme);
  applyView(viewOf(s.settings));
  const locked = !!todayUi?.locked();
  applyLayoutPrefs(locked);
  // Find a setting starts empty each time Settings opens.
  if (state.route !== 'settings') state.settingsQuery = '';
  const ctx = {
    state, auth: auth(), hidden: hiddenCalendars(), banners: banners(s), plugins: pluginContext(), pluginsKnown: state.pluginsKnown,
    meetingsHidden: state.meetings.hidden, view: viewOf(s.settings),
    today: { ...state.today, locked },
    dock: { layouts: Object.fromEntries(Object.keys(DOCKS).map(page => [page, docks.get(page)])), locked },
    codemie: { panel: codemie.panel, headerActions: codemie.headerActions, tabDots: codemie.tabDots(), signIn: codemie.signIn() },
    menu: { ...settingsMenu(), folded: foldedGroups(), query: state.settingsQuery },
    layout: layoutContext(),
    codemieCard: codemie.todayCard(),
    // Settings › Meetings › Note templates: the summary plugins "Pin a summary" may offer.
    minutesPlugins: pluginHost?.minutesPlugins?.() || [],
  };
  if (state.route === 'inbox') ensureSelection(s);
  // The hash names the meeting shown, also when the list picked it, and its pane
  // (`#/meetings/<id>/<pane>`), or the tab chosen last, one in view (`#/automations/<tab>`).
  if (state.route === 'meetings') meetingsUi.ensureSelection();
  if (state.route === 'automations') automationsUi.follow();
  if (['meetings', 'automations'].includes(state.route) && location.hash !== routeHash()) history.replaceState(null, '', routeHash());
  if (['inbox', 'today', 'automations', 'ask'].includes(state.route)) readClaude();
  // The open Ask thread is read again when the snapshot moved for it (drawn when it lands).
  if (state.route === 'ask') askUi?.refresh().catch(fail);
  if (state.route === 'tasks') tasksDrawnDay = dayKey(Date.now(), s.settings.timeZone);
  const pageClass = `ws-page ws-page-${state.route}`;
  const html = state.route === 'today' ? today(s, ctx)
    : state.route === 'calendar' ? calendar(s, ctx)
      : state.route === 'inbox' ? inbox(s, ctx)
        : state.route === 'automations' ? automations(s, ctx)
          : state.route === 'analytics' ? analyticsView(state.analytics, { ...analyticsUi.viewData(), banners: ctx.banners, profileNames: state.ai.profiles })
          : state.route === 'tasks' ? tasksPage(s, ctx)
          : state.route === 'meetings' ? meetings(s, { ...ctx, reads: meetingsUi.data, glossary: meetingsUi.glossary(), callSlots: pluginHost?.callSlots() || [], taskLabel: meetingsUi.taskLabel() })
          : state.route === 'plugin' ? pluginPageHtml()
          : state.route === 'ask' ? askPage(state, s, askUi?.thread(), { wide: (state.ask.wide = askWide(s)), now: Date.now(), profiles: state.ai.profiles, ai: state.ai })
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
  // The quick-capture bar lives outside #workspace-app (not redrawn): laid over the new main area.
  drawCapture();
  syncAskStatus();
  if (unsavedNote?.workspaceId === current().id) {
    const fresh = document.getElementById('today-note');
    if (fresh) fresh.value = unsavedNote.text;
  }
  const freshReply = document.getElementById('reply-body');
  const freshKey = freshReply?.closest('form')?.dataset.key;
  if (freshReply !== keepReply && unsavedReply && freshKey === unsavedReply.key) freshReply.value = unsavedReply.text;
  // Text typed in a box that left the screen (another row, another page, a view switch) is kept
  // for that conversation and put back the next time its box is drawn with nothing newer in it.
  if (unsavedReply && freshKey !== unsavedReply.key) state.replyCarry[unsavedReply.key] = unsavedReply.text;
  if (freshReply && freshReply !== keepReply && freshReply.value === freshReply.defaultValue && Object.hasOwn(state.replyCarry, freshKey)) {
    freshReply.value = state.replyCarry[freshKey];
    delete state.replyCarry[freshKey];
  }
  // A box drawn for another conversation (or none) is not the one the user touched.
  if (state.replyTouched !== freshKey) state.replyTouched = null;
  syncReplyBox(freshReply);
  const freshChange = document.getElementById('reply-change');
  if (changeWords && freshChange && freshKey === replyKey) freshChange.value = changeWords;
  for (const menu of openMenus) root.querySelector(`details.ws-menu[data-menu="${CSS.escape(menu)}"]`)?.setAttribute('open', '');
  root.querySelectorAll('.ws-mtg-strip > .ws-menu[open]').forEach(fitSectionMenu);
  if (state.route === 'inbox') rememberDraftBaseline(s);
  restoreScroll(saved);
  measureToday();
  // A background update keeps keyboard focus on the same control, and only on that one: when
  // the control is gone or no longer told apart from a sibling, focus is left alone.
  if (refocus && !root.contains(document.activeElement)) {
    const again = soleMatch(root, refocus);
    again?.focus({ preventScroll: true });
    if (again && caret && again.value === caret.value) {
      try { again.setSelectionRange(...caret.range); } catch { /* a field without a caret (number) */ }
    }
  }
  placeDraftPopover();
  // Plugins' call slots follow the meeting the Meetings page shows (Echo's call page), told when
  // it changes.
  const call = state.route === 'meetings' ? shownCall(s, ctx) : null;
  if (JSON.stringify(call) !== JSON.stringify(pluginCall)) {
    pluginCall = call;
    pluginHost?.setCall(call);
  }
  showPluginView();
  if (state.route === 'today') drawPageWidgets(s);
  if (state.route === 'analytics') drawAnalyticsCharts();
  if (state.route === 'meetings') {
    showFocusLine();
    if (state.meetings.focusColumn) {
      state.meetings.focusColumn = false;
      focusFirst(['.ws-mtg-items [data-action="meeting-item-add-open"]']);
    }
    meetingsUi.load().catch(fail);
  }
  if (state.route === 'settings' && state.settingsTab.startsWith('meetings-')) meetingsSettingsUi.load().catch(fail);
  lastDraftSignature = draftSignature(s);
  renderSheet();
  hideTip();
  sendSeenMarks(s);
}

// ---------------------------------------------------------------- menu-bar seen marks

// Marks already sent (or refused) this run, keyed `"<revision>|<key>"` (design §6): a mark goes
// out at most once per snapshot revision, even across renders and focus changes. A refusal keeps
// its key (review I1): the mark is due again only once the revision moves, not on the next render
// at the same one — see `sendSeen`'s doc in menu-bar.js for why.
const menuBarSeenSent = new Set();

/** Whether the Automation results widget is in Today's own grid now (`drawn.placed`, not
 *  `drawn.below`'s auto-appended cards — "automations" is never one of those: `drawnGrid`'s
 *  `wanted` list is `['meetings', PLUGINS_CARD]` only). Checked apart from the general `onToday`
 *  on purpose (review M4): design §6 ties the seen mark to "Today with its card", and ruling 7's
 *  "If wrong" warns against clearing results a below-the-grid card left the user scrolling past;
 *  `drawn.placed` is unambiguously "the grid" by `drawnGrid`'s own naming. */
function automationsCardOnToday() {
  const defs = tileDefs(pluginWidgetCatalog(state.installedPlugins || []));
  const drawn = drawnGrid(snap(), todayOf(current(), defs), defs, { pluginsKnown: !!state.pluginsKnown, meetingsHidden: state.meetings.hidden });
  return drawn.placed.some(it => it.id === 'automations');
}

/** After a render, while the window is in front, focused and nothing is being typed in or in a
 *  dialog, sends the `menu_bar_seen` marks `seenToSend` decides on through `sendSeen`; a failure
 *  is ignored (the next render, at a later revision, tries again). */
function sendSeenMarks(s) {
  // Keys from an earlier revision are dead weight (review M1): a mark only ever retries at a new
  // one, so nothing later ever looks an old key up again.
  for (const key of menuBarSeenSent) if (!key.startsWith(`${s.revision}|`)) menuBarSeenSent.delete(key);
  const marks = seenToSend({
    snapshot: s,
    route: state.route,
    openMeeting: state.meetings.selected,
    todayCards: state.route === 'today' && automationsCardOnToday() ? ['automations'] : [],
    hidden: state.meetings.hidden,
    focused: document.visibilityState === 'visible' && document.hasFocus(),
    editing: editing(),
    modal: modalOpen(),
    sent: menuBarSeenSent,
  });
  sendSeen(marks, s.revision, menuBarSeenSent, payload => mutate('menu_bar_seen', payload));
}

/** A transcript line a task quote or a note's time opened: scrolled to and highlighted a moment. */
let focusLineTimer = null;
function showFocusLine() {
  const line = state.meetings.focusLine;
  if (line === null || line === undefined || state.meetings.pane !== 'transcript') return;
  const el = document.getElementById(`meeting-line-${line}`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  clearTimeout(focusLineTimer);
  focusLineTimer = setTimeout(() => {
    if (state.meetings.focusLine === line) state.meetings.focusLine = null;
    document.getElementById(`meeting-line-${line}`)?.classList.remove('ws-mtg-focus');
  }, 2600);
}

// The CodeMie setup sheet lives outside #workspace-app so a page re-render never replays its
// fade-in or loses what is typed in it: the element is created when the sheet opens, only its
// content is replaced while it stays open, and it is removed when it closes.
function renderSheet() {
  let host = document.getElementById('cm-sheet-host');
  const html = codemie.sheet();
  // Plugin frames lie in their own layer over the page: the sheet keeps them out of reach too.
  const pluginLayer = document.querySelector('.ws-plugin-layer');
  if (!html) {
    host?.querySelector('.cm-sheet')?.remove();
    root.inert = false;
    // The quick-capture bar keeps the frames out of reach while it is open (drawCapture).
    if (pluginLayer) pluginLayer.inert = state.capture.open;
    return;
  }
  // The sheet is a dialog over everything: the capture bar closes under it.
  if (state.capture.open) captureUi?.close({ refocus: false });
  if (!host) {
    host = document.createElement('div');
    host.id = 'cm-sheet-host';
    document.body.append(host);
  }
  let sheetEl = host.querySelector('.cm-sheet');
  const opening = !sheetEl;
  if (opening) {
    sheetEl = document.createElement('div');
    sheetEl.className = 'cm-sheet';
    host.append(sheetEl);
  }
  // A dialog: the page behind takes no focus, clicks or keys while it is open.
  root.inert = true;
  if (pluginLayer) pluginLayer.inert = true;
  const body = sheetEl.querySelector('.cm-stage-body');
  const scroll = body?.scrollTop || 0;
  const stepKey = sheetEl.querySelector('[data-step-key]')?.dataset.stepKey;
  const refocus = document.activeElement && sheetEl.contains(document.activeElement) ? controlSelector(document.activeElement) : null;
  sheetEl.innerHTML = html;
  const nextBody = sheetEl.querySelector('.cm-stage-body');
  if (nextBody && sheetEl.querySelector('[data-step-key]')?.dataset.stepKey === stepKey) nextBody.scrollTop = scroll;
  if (refocus) soleMatch(sheetEl, refocus)?.focus({ preventScroll: true });
  // Opening (or a focus left behind on a control that is gone): the panel takes focus.
  if (opening || !sheetEl.contains(document.activeElement)) sheetEl.querySelector('.cm-sheet-panel')?.focus({ preventScroll: true });
}

const sheetOpen = () => !!document.querySelector('#cm-sheet-host .cm-sheet');

// ⌃` shows or hides the terminal (VS Code's key), from anywhere in the window.
document.addEventListener('keydown', ev => {
  if (!ev.ctrlKey || ev.metaKey || ev.altKey || (ev.code !== 'Backquote' && ev.key !== '`') || modalOpen()) return;
  if (!terminalDock?.state().count) return;
  ev.preventDefault();
  terminalDock.toggle();
});

// A click anywhere outside an open CodeMie ⋯ menu closes it.
document.addEventListener('click', ev => {
  for (const menu of document.querySelectorAll('details.cm-menu[open]')) if (!menu.contains(ev.target)) menu.removeAttribute('open');
}, true);

// The setup sheet: Escape closes it (as its close button does), unless a dialog is open over it.
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape' || !sheetOpen() || modalOpen()) return;
  ev.preventDefault();
  ev.stopPropagation();
  codemie.handle('cm-sheet-close', { dataset: {} }).catch(fail);
});

function ensureSelection(s) {
  if (state.lane === 'decisions') return;
  const items = collapseChats(filteredMessages(s, state).filter(m => m.data.lane === state.lane)).items;
  // After Done, Snooze or a lane move in Compact: the row that followed the one that left.
  const after = state.selectAfter && items.find(m => m.id === state.selectAfter);
  state.selectAfter = null;
  // Follow the conversation when a chat's newest message changes under the selection (and the
  // open row the same way).
  const pick = after || items.find(m => m.id === state.selectedMessage) || items.find(m => messageKey(m) === state.selectedKey) || items[0];
  state.selectedMessage = pick?.id || null;
  state.selectedKey = pick ? messageKey(pick) : null;
  const { open, openKey } = followOpen(items, { open: state.openMessage, openKey: state.openKey }, messageKey);
  state.openMessage = open;
  state.openKey = openKey;
}

const compactView = () => viewOf(snap().settings) === 'compact';

/** The message a Retry in the reply box or summary of `el`'s row is for (inbox-open.js). */
const retrySourceOf = (sourceId, el) => retrySource({
  sourceId: sourceId && getRecord('message', sourceId) ? sourceId : null,
  rowId: el?.closest?.('form[data-form="reply"]')?.dataset.id || el?.closest?.('[data-message-id]')?.dataset.messageId || null,
  compact: compactView(), selected: state.selectedMessage, open: state.openMessage,
});

/** Closes the open Compact row. */
function closeRow() {
  state.openMessage = null;
  state.openKey = null;
}

/** Applies a Compact `{selected, open}` move (inbox-open.js) and draws it. */
function moveRows({ selected, open }) {
  flushReplySave();
  const keyOf = id => { const m = id && getRecord('message', id); return m ? messageKey(m) : null; };
  Object.assign(state, { selectedMessage: selected, selectedKey: keyOf(selected), openMessage: open, openKey: keyOf(open) });
  return render().then(() => root.querySelector('.ws-inbox-row.ws-selected')?.scrollIntoView({ block: 'nearest' }));
}

/** Before Done, Snooze or a lane move takes row `id` away in Compact: nothing stays open and the
 *  row after it (else before it) is selected next. */
function leaveRow(id) {
  if (!compactView()) return;
  state.selectAfter = nextAfter([...root.querySelectorAll('.ws-inbox-row[data-id]')].map(r => r.dataset.id), id);
  closeRow();
}

// ---------------------------------------------------------------- navigation

export async function savePendingNote() {
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
  await savePendingNote();
  flushReplySave();
  state.meetings.rowMenu = null;
  // Arriving at the Inbox without a target finds every row closed.
  if (state.route === 'inbox' && name !== 'inbox') closeRow();
  state.route = ROUTES.includes(name) ? name : 'today';
  if (tab && state.route === 'settings') state.settingsTab = settingsTabFor(tab);
  if (state.route === 'ask') state.ask.threadId = askThreadOf(tab);
  // Leaving for another page forgets where ⌘K came from (the Ask page keeps it for its Back,
  // which reads it before it leaves).
  else Object.assign(state.ask, { focusBack: null, backFocus: null });
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
  if (tab && state.route === 'automations') showAutomationsTab(tab);
  if (state.route === 'meetings') meetingsUi.ensureSelection();
  history.replaceState(null, '', routeHash());
  await render();
  const heading = root.querySelector('h1');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
  if (state.route === 'calendar') await ensureCalendarWindow();
  if (state.route === 'settings' && state.settingsTab === 'ai') loadAi().catch(fail);
  if (generalTabOpen()) loadStorage().catch(fail);
  if (runLogOpen()) automationsUi.loadRuns().catch(fail);
  if (onPluginsTab) pluginsUi.load().catch(fail);
  if (state.route === 'analytics') analyticsUi.open().catch(fail);
  if (state.route === 'tasks') syncTasks();
  // An Ask thread: read, then focus its newest turn's heading.
  if (state.route === 'ask') askUi?.openThread()?.catch(fail);
}

/** Asks the active task provider for a pull (Tasks open, the window back in front); native
 *  runs it at most once in 30 s. Local has nothing to pull. */
function syncTasks() {
  const s = store?.get().snapshot;
  if (s && activeProvider(s) !== 'local') store.query('task_sync_now', {}).catch(() => {});
}

/** A thread id from an `#/ask/<id>` hash, or null. */
function askThreadOf(part) {
  try {
    const id = part ? decodeURIComponent(part) : '';
    return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The hash of the page open now: `#/route/tab`, `#/meetings/<id>/<pane>` for a meeting,
 *  `#/ask/<id>` for an Ask thread. */
function routeHash() {
  if (state.route === 'meetings') return meetingHash(state.meetings.selected, state.meetings.pane);
  if (state.route === 'ask') return `#/ask${state.ask.threadId ? `/${encodeURIComponent(state.ask.threadId)}` : ''}`;
  return `#/${state.route}${state.route === 'settings' ? `/${state.settingsTab}` : state.route === 'automations' && state.automations.tab !== 'automations' ? `/${state.automations.tab}` : ''}`;
}

// ---------------------------------------------------------------- plugins

const PLUGIN_ID = /^[a-z][a-z0-9-]{1,40}$/;
const PLUGIN_ITEM = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/** Opens a plugin's page: `#/p/<id>/<activity>[/<route>]`. */
async function routePlugin(id, activity, rest = '') {
  if (!PLUGIN_ID.test(id) || !PLUGIN_ITEM.test(activity)) return route('today');
  await savePendingNote();
  if (state.route === 'inbox') closeRow();
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
  if (head === 'meetings') {
    const target = parseHash(`#/${[head, a, b].filter(x => x !== undefined).join('/')}`);
    // An old link's tab is the same pane (/notes, /transcript, /files, /tasks); none is the setting's.
    if (target.meetingId) return meetingsUi.open(target.meetingId, target.pane);
  }
  return route(ROUTES.includes(head) ? head : 'today', a);
}

// Removing the active task provider's plugin switches Connect to Local, once (design §11, ruling
// 16): nothing is deleted, the cache and the outbox stay, and come back if it is installed again.
// `installedChanged` below is told of the same removal more than once (its own direct read, the
// Plugins tab reopening, the native `plugins:reloaded` event), so the actual switch runs through
// this guard, which drops a telling that is already in flight for the same provider.
const switchRemovedProviderToLocal = createRemovalSwitch(() => mutate('task_provider_set', { provider: 'local' }));

const pluginsUi = createPluginsController({
  request: (op, data) => invoke('plugins_request', data === undefined ? { op } : { op, data }),
  render: () => { if (ready && !modalOpen()) render().catch(fail); },
  openModal,
  toast,
  installedChanged: list => {
    // Checked on every list this gives, not only a change while the window is open, so a plugin
    // removed while Connect was closed is caught at boot too (the first `loadInstalled` also calls
    // this). The name comes from the list this replaces (Settings → Plugins' own, "Todoist"),
    // never `taskProvider.name`, which already reads "Connect" once the plugin is gone from
    // `available` too.
    const active = snap().taskProvider?.active;
    const removedName = state.installedPlugins.find(p => `plugin:${p.id}` === active)?.name;
    const stillIs = list.some(p => `plugin:${p.id}` === active);
    state.installedPlugins = list;
    state.pluginsKnown = true;
    pluginHost?.sync(list);
    switchRemovedProviderToLocal(active, stillIs)
      ?.then(() => toast(`${removedName || 'That plugin'} was removed, so tasks are back in Connect.`, 'info'))
      .catch(fail);
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
    if (ready && !modalOpen() && !editing()) render().catch(fail);
  }, 60);
}

/** A plugin's page asked to open a link (ruling R41). The frame could forge the click, so Connect
 *  asks in its own dialog with the whole address as text; only Open there opens it, natively
 *  checked again. One at a time: a link asked for while a dialog is open is dropped. */
function confirmPluginLink(url, name, id) {
  if (modalOpen() || recovering) return;
  const where = url.startsWith('obsidian:') ? 'It opens in Obsidian.' : 'It opens in your browser.';
  openModal({
    title: 'Open this link?', size: 'sm', submit: 'Open', initialFocus: 'cancel', guard: true,
    body: `<p class="ws-modal-text">${e(name)} wants to open this address. ${where}</p>
      <p class="ws-link-confirm"><code class="ws-storage-path">${e(url)}</code></p>`,
    onSubmit: () => invoke('plugins_request', { op: 'open_link', data: { id, url } }),
  });
}

/** Closing a tab whose program still runs ends it: Connect asks first. Resolves to the answer. */
function confirmTerminalStop(info) {
  return new Promise(resolve => {
    let answered = false;
    openModal({
      title: `Stop ${info.program}?`, size: 'sm', submit: 'Stop and close', variant: 'danger', initialFocus: 'cancel',
      body: `<p class="ws-modal-text">${e(info.program)} is still running in ${e(info.title)}. Closing the tab stops it${info.resumable ? '; its conversation stays in Claude Code’s history' : ''}.</p>`,
      onSubmit: () => { answered = true; resolve(true); },
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

/** The dock showed, hid, resized or changed its tabs: the plugin frames follow the page, and the
 *  topbar's Terminal button says how many sessions run (the shell is drawn again only when the
 *  button comes or goes). */
let terminalHadTabs = false;
function terminalLayout() {
  pluginHost?.placeSoon();
  const t = terminalDock?.state();
  if (!t) return;
  const has = t.count > 0;
  if (has !== terminalHadTabs) {
    terminalHadTabs = has;
    if (ready) render().catch(fail);
    return;
  }
  const btn = root.querySelector('.ws-term-toggle');
  if (btn) btn.outerHTML = terminalButton(t);
}

/** A plugin's page asks to add a skill to the user's own Claude Code (or take out one it added):
 *  Connect asks first, showing the skill's name, description and place. Resolves to the answer. */
function confirmPluginSkill({ op, plugin, name, description = '', path = '', replaces = false }) {
  return new Promise(resolve => {
    if (recovering) return resolve(false);
    let answered = false;
    const done = yes => { if (!answered) { answered = true; resolve(yes); } };
    const adding = op === 'install';
    openModal({
      title: adding ? `Add /${name} to Claude Code?` : `Remove /${name} from Claude Code?`,
      size: 'sm', submit: adding ? (replaces ? 'Update skill' : 'Add skill') : 'Remove skill', variant: adding ? 'primary' : 'danger',
      initialFocus: 'cancel', guard: true,
      body: `<p class="ws-modal-text">${e(plugin)} ${adding ? 'wants to add a skill to your own Claude Code, for every session.' : 'wants to take out the skill it added to your Claude Code.'}</p>
        ${description ? `<p class="ws-modal-text"><strong>/${e(name)}</strong>: ${e(description)}</p>` : ''}
        <p class="ws-link-confirm"><code class="ws-storage-path">${e(path)}</code></p>`,
      onSubmit: () => done(true),
      onClose: () => done(false),
    });
  });
}

/** A plugin asks for the address of one web page to read (`http.askAddress`): Connect's own box,
 *  never the plugin's page. The answer goes to Rust, which lets that one read through. */
function askPluginAddress({ ask, plugin }) {
  let answered = false;
  const answer = url => {
    if (answered) return;
    answered = true;
    invoke('plugins_request', { op: 'address_answer', data: { ask, url } }).catch(() => {});
  };
  if (recovering) return answer(null);
  openModal({
    title: 'Read a web page', size: 'sm', submit: 'Read it', guard: true,
    body: `<p class="ws-modal-text">${e(plugin)} asks for the address of a web page to fetch once. Type or paste it:</p>
      <label class="ws-field"><span class="ws-field-label">Address</span><input class="ws-input" name="url" type="url" required maxlength="2000" autocomplete="off" spellcheck="false" placeholder="https://"></label>`,
    onSubmit: form => {
      const url = String(form.get('url') || '').trim();
      if (!/^https?:\/\/[^\s@]+$/i.test(url)) throw new Error('Type an address that starts with https:// or http://.');
      answer(url);
    },
    onClose: () => answer(null),
  });
}

async function pluginAction(action, el) {
  const id = el.dataset.pluginId;
  switch (action) {
    case 'plugin-page': return routePlugin(id, el.dataset.activity);
    case 'plugin-go': return goHash(el.dataset.go);
    case 'plugin-palette': return pluginHost?.runPalette(id, Number(el.dataset.index));
    case 'plugin-call-menu':
      // The ⋯ menu closes as the plugin's item runs in its page.
      el.closest('details.ws-menu')?.removeAttribute('open');
      return pluginHost?.runSlot(id, Number(el.dataset.index));
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
    // Settings › AI draws a row per enabled plugin that asks for AI: the installed list is read
    // again beside it (drawn when it lands), never holding up the profiles.
    pluginsUi.loadInstalled().catch(() => {});
    const [status, usage] = await Promise.all([store.query('ai_status', { refresh: true }), store.query('ai_usage', {}).catch(() => null)]);
    if (load !== aiLoads) return;
    Object.assign(state.ai, { status: 'ready', profiles: status.profiles, settings: status.settings, chosen: status.chosen || {}, usage, error: '' });
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
    state.ai.chosen = result.chosen || {};
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
  Object.assign(state.ai, { status: 'ready', profiles: status.profiles, settings: status.settings, chosen: status.chosen || {} });
  // A CodeMie profile Settings → CodeMie found signed out is not offered as ready.
  const offered = withCodemieSignIn(status.profiles, codemie.signIn());
  const anyReady = offered.some(p => p.state === 'ready');
  return new Promise(resolve => {
    let chosen = null;
    openModal({
      title: CHOOSER_TITLE, subtitle: anyReady ? 'Connect asks once. You can change it in Settings → AI.' : '',
      body: chooserBody(offered), submit: anyReady ? 'Choose' : null, cancel: anyReady ? 'Cancel' : 'Close', size: 'md',
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
    Object.assign(state.ai, { status: 'ready', profiles: status.profiles, settings: status.settings, chosen: status.chosen || {} });
    if (changed && ['inbox', 'today', 'automations', 'ask'].includes(state.route) && !modalOpen() && !editing() && !state.draftPopover) render();
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
/** The message whose reply box is on screen: the open row in Compact, the selected one in Default. */
const inboxMessage = s => {
  const id = state.route !== 'inbox' ? null : viewOf(s.settings) === 'compact' ? state.openMessage : state.selectedMessage;
  return id ? s.records.find(r => r.kind === 'message' && r.id === id) : null;
};

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
    // Text the app put in the box is not the user's: ⌘↩ waits for their next click or keystroke.
    disarmSendKey(key);
    syncReplyBox(field);
  }
  if (next.save != null) queueReplySave(m, next.save).catch(fail);
  return true;
}

/** ⌘↩ no longer sends this conversation's reply until the user clicks or types in its box again. */
function disarmSendKey(key) {
  if (state.replyTouched === key) state.replyTouched = null;
}

/** Remembers which text in the box came from Claude, so editing it later counts as the user's. */
function rememberDraftBaseline(s) {
  const m = inboxMessage(s);
  if (!m) return;
  const key = draftKeyOf(m);
  const ui = draftUi(key);
  // A change request in flight compares its result with the text it started from (`startChange`).
  if (ui.changeFrom != null) return;
  const box = replyBox({ manual: savedReply(s, m), ai: latestDraft(s, key), ui });
  ui.baseline = box.fromAi ? box.text : null;
}

/** A change request ended without filling the box (stopped, failed and dismissed, the chooser
 *  closed, another draft asked for): its result can no longer offer a Restore. */
function endChange(key) {
  if (key && state.drafts[key]) state.drafts[key].changeFrom = null;
}

/**
 * Queues a draft (or, with `request`, a change of the current text); the first draft without a
 * chosen Claude opens the chooser, then retries once.
 */
async function startDraft(m, options, instructions = '', request = null) {
  if (!m) throw new Error('This conversation is no longer available. Refresh and try again.');
  const key = draftKeyOf(m);
  // A fresh draft is not a change: its fill offers no Restore of an earlier change's text.
  if (request?.revise == null) endChange(key);
  try {
    await withClaudeChoice(() => mutate('ai_draft', request || draftRequest(m, options, instructions)));
  } catch (err) {
    endChange(key);
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
 * Saves the reply box on this device now when its text changed since the last save: the autosave
 * 1.5 s after typing stops, and at once before the box leaves the screen (another row, a route
 * or view change, the window hidden). The text is read now, so a render right after loses nothing.
 */
function flushReplySave(field = document.getElementById('reply-body')) {
  const form = field?.closest?.('form[data-form="reply"]');
  const m = form && store?.get() && getRecord('message', form.dataset.id);
  if (!m || field.value === field.defaultValue) {
    clearTimeout(replySaveTimer);
    replySaveTimer = null;
    return replySaving;
  }
  const { key } = form.dataset;
  const text = field.value;
  return queueReplySave(m, text).then(() => {
    field.defaultValue = text;
    delete state.replyCarry[key];
    showReplyStatus(key, 'Saved on this device');
  }).catch(fail);
}

/**
 * Every save of a reply goes through here, one at a time and in order: the autosave, Send's save
 * before the review, a draft filling the box, Keep/Replace/Restore. A pending autosave is
 * dropped (the caller's save is newer), and text already saved is not saved again. The returned
 * promise fails with the save; the queue goes on.
 */
function queueReplySave(m, text) {
  clearTimeout(replySaveTimer);
  replySaveTimer = null;
  const run = replySaving.then(() => ((savedReply(snap(), m)?.data.text || '') === text ? undefined : saveReply(m, text)));
  replySaving = run.catch(() => {});
  return run;
}

/** Writes a conversation's status line (text, or `{ text, tone, url }`), on screen at once and in
 *  the next render. */
function showReplyStatus(key, status) {
  state.replyStatus[key] = status;
  const line = root.querySelector(`form[data-form="reply"][data-key="${CSS.escape(key)}"] .ws-reply-status`);
  const m = line && getRecord('message', line.closest('form').dataset.id);
  if (m) line.outerHTML = replyStatusHtml(status, m);
}

/**
 * Keeps the reply box in step with its text: it grows to fit a draft, the ✦ hint shows only while
 * it is empty, the change line only while it has text, the send or copy button waits for text,
 * and Claude's bracketed choices still in it are re-read as the user types.
 */
function syncReplyBox(field) {
  if (!field) return;
  field.style.height = 'auto';
  field.style.height = `${Math.min(Math.max(field.scrollHeight + 2, 88), 360)}px`;
  const form = field.closest('form');
  const hasText = !!field.value;
  const hint = form?.querySelector('#reply-hint');
  if (hint) {
    // A running draft or a gone item keeps the hint hidden (the render decided).
    const show = !hasText && !field.disabled && !form.querySelector('.ws-draft-running');
    hint.hidden = !show;
    if (show) field.setAttribute('aria-describedby', 'reply-hint');
    else field.removeAttribute('aria-describedby');
  }
  const change = form?.querySelector('.ws-reply-change');
  if (hasText && !change) form?.querySelector('.ws-reply-bar')?.insertAdjacentHTML('beforebegin', changeLine({ disabled: field.disabled || !!form.querySelector('.ws-draft-running') }));
  else if (!hasText && change && !change.contains(document.activeElement)) change.remove();
  const primary = form?.querySelector('[data-needs-text]');
  // A send in flight keeps Send disabled through any re-render: one click, one message.
  if (primary && !primary.hasAttribute('data-locked')) primary.disabled = !field.value.trim() || replyInFlight.has(form.dataset.key);
  const checks = form?.querySelector('[data-draft-checks]');
  if (!checks || !store?.get()) return;
  checks.innerHTML = draftChecks(field.value, latestDraft(snap(), form.dataset.key)?.data.text);
  checks.closest('.ws-draft-todo').hidden = !checks.innerHTML.trim() && !form.querySelector('.ws-draft-questions');
}

/** The ⋯ of the reply's action line: the options popover's anchor, and where focus returns. */
const draftAnchor = () => root.querySelector('form[data-form="reply"] [data-menu="reply-more"] > summary');

/** Anchors the options popover to the action line's ⋯, below it when it fits, else above. */
function placeDraftPopover() {
  const pop = document.getElementById('draft-options');
  const trigger = draftAnchor();
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
 * keyboard), then focus returns to the action line's ⋯.
 */
async function closeDraftPopover(focusTrigger = true) {
  if (!state.draftPopover) return;
  state.draftPopover = null;
  document.getElementById('draft-options')?.remove();
  if (!focusTrigger) {
    if (heldRender) document.addEventListener('mouseup', () => setTimeout(flushHeldRender, 0), { once: true, capture: true });
    return;
  }
  if (heldRender) await render();
  draftAnchor()?.focus();
}

function flushHeldRender() {
  if (!heldRender || state.draftPopover || modalOpen()) return;
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
    returnCancels: true,
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
  dock: dockFor('automations'),
});

/** Automations' tab `tab` (`runs` …), as a hash names it: the tab chosen last, shown in whichever
 *  section holds it. */
function showAutomationsTab(tab) {
  const [name, id] = AUTOMATION_TABS.find(([x]) => x === tab) || AUTOMATION_TABS[0];
  state.automations.tab = name;
  showDockTab('automations', id);
}
const runLogOpen = () => !!automationsUi?.runLogOpen();

// ---------------------------------------------------------------- analytics (spec 2026-11-19 analytics)

const analyticsUi = store && createAnalyticsController({
  state, query: (op, data) => store.query(op, data), render, toast,
  listen: (event, fn) => window.__TAURI__.event.listen(event, fn),
  writeText: text => navigator.clipboard.writeText(text),
  focus: focusFirst,
});
if (analyticsUi) attachAnalyticsTips(document);

/** The Analytics page's charts, drawn at the width their boxes got. */
function drawAnalyticsCharts() {
  const charts = analyticsCharts(state.analytics, analyticsUi.viewData());
  for (const box of root.querySelectorAll('.ws-an-chart[data-chart]')) {
    const draw = charts[box.dataset.chart];
    if (draw) box.innerHTML = draw(box.clientWidth);
  }
}
let analyticsResize = null;
window.addEventListener('resize', () => {
  clearTimeout(analyticsResize);
  analyticsResize = setTimeout(() => { if (state.route === 'analytics') drawAnalyticsCharts(); }, 120);
});

// ---------------------------------------------------------------- tasks (spec "Tasks page")

/** The first of the selectors that finds a control takes focus. The page scrolls to it only for
 *  keyboard focus: a click (Accept, Delete) doesn't make the board jump. */
function focusFirst(selectors, { scroll = false } = {}) {
  for (const selector of [].concat(selectors)) {
    const el = root.querySelector(selector);
    el?.focus({ preventScroll: true });
    if (el && document.activeElement === el) {
      // `scroll`: the place itself is the point (e.g. "Who is this?" → the speaker list).
      if (scroll) el.scrollIntoView({ block: 'center' });
      else if (el.matches(':focus-visible')) el.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
}

const tasksUi = store && createTasksController({
  state, snap, mutate, render, openModal, toast,
  openMeeting: (id, pane, line) => openMeeting(id, pane, line),
  openMessage: id => handle('open-message', { dataset: { id } }),
  focus: focusFirst,
  setPref: setLocalPref,
  // Nudge (By date): the conversation opens with its reply box holding the line, not saved and
  // not sent (⌘↩ waits for a touch, Send for its review). A box with words already keeps them.
  openReply: async (id, text) => {
    const m = getRecord('message', id);
    if (!m) throw new Error('This conversation is no longer in your Inbox.');
    const key = draftKeyOf(m);
    const s = snap();
    const box = replyBox({ manual: savedReply(s, m), ai: latestDraft(s, key), ui: draftUi(key) });
    if (!box.text.trim() && !Object.hasOwn(state.replyCarry, key)) state.replyCarry[key] = text;
    await handle('open-message', { dataset: { id } });
    document.getElementById('reply-body')?.focus({ preventScroll: true });
  },
  // Settings › Tasks's "Get your token in Todoist ↗" opens through Connect's own link
  // confirmation (Open in Todoist ↗ is the task's own link: `open_source`).
  openLink: (url, name, id) => confirmPluginLink(url, name, id),
  query: (op, data) => store.query(op, data),
  // Settings › Tasks: the token and the project/label settings are a plugin's own (`set_setting`,
  // `set_enabled` for Turn on), read back through the same installed list Settings → Plugins uses.
  pluginRequest: (op, data) => invoke('plugins_request', data === undefined ? { op } : { op, data }),
  refreshInstalled: () => pluginsUi.loadInstalled(),
  installed: () => pluginsUi.ui.installed,
});
if (tasksUi) {
  attachBoardDrag(document, tasksUi, {
    dragging: on => {
      taskDrag = on;
      if (!on && heldRender && !modalOpen()) render().catch(fail);
    },
    fail,
  });
}

// ---------------------------------------------------------------- Settings › Your voice

const voiceUi = store && createVoiceController({
  state, snap, mutate, render, openModal, toast,
  query: (op, data) => store.query(op, data),
  pluginsRequest: (op, data) => invoke('plugins_request', data === undefined ? { op } : { op, data }),
  go: hash => goHash(hash),
  focus: focusFirst,
});

// ---------------------------------------------------------------- Today layout (spec "Interactions")

const todayUi = store && createTodayController({
  state, snap, mutate, render, toast, announce,
  prefs: { get: localPref, json: localJson, set: setLocalPref },
  focus: focusFirst,
});
if (todayUi) {
  // `dragging(false)` comes once the drop's save has settled; the updates held meanwhile show then.
  attachTodayDrag(document, todayUi, { dragging: holdLayout, fail });
}

// ---------------------------------------------------------------- page sections (spec "Page sections")

// Each page's sections are a preference of this Mac (`codemie.layout.<page>.v<version>`), read
// once and kept here. With nothing stored yet, Calendar takes the old calendar list choice
// (`codemie.calendar.sidebar`), and Meetings the list's width and fold from its version 1 layout
// (`codemie.layout.meetings.v1`) or the old hidden list (`codemie.meetings.wide`), none of which
// are written again.
const DOCKS = { inbox: INBOX_DOCK, calendar: CALENDAR_DOCK, meetings: MEETINGS_DOCK, automations: AUTOMATIONS_DOCK };
const DOCK_LEGACY = {
  calendar: () => (localPref('codemie.calendar.sidebar', 'true') === 'false' ? { collapse: ['cal-side'] } : null),
  meetings: () => legacyMeetingsLayout(localPref('codemie.layout.meetings.v1', null), localPref('codemie.meetings.wide', 'false') === 'true'),
};
const dockStorage = { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };
const dockLayouts = {};
const docks = {
  get: page => (dockLayouts[page] ||= loadDock(dockStorage, page, DOCKS[page], DOCK_LEGACY[page]?.() || null)),
  set: (page, layout) => {
    dockLayouts[page] = layout;
    saveDock(dockStorage, page, layout, DOCKS[page]);
  },
};

/** Brings tab `tab` of `page` into view in the section that holds it, expanding that section;
 *  the caller draws the page. */
function showDockTab(page, tab) {
  const layout = docks.get(page);
  const shown = setCollapsed(activateTab(layout, tab), DOCKS[page], tab, false).layout;
  if (shown !== layout) docks.set(page, shown);
}

/** The sections of `page` as its controller uses them (see createMeetingsController). */
function dockFor(page) {
  return {
    layout: () => docks.get(page),
    collapse: (id, on) => dockUi.setCollapsed(page, id, on),
    visible: () => visibleTabs(docks.get(page)),
    show: id => showDockTab(page, id),
  };
}

/** Whether Today shows widget `id` now: in its grid, or as a card under it. */
function onToday(id) {
  const defs = tileDefs(pluginWidgetCatalog(state.installedPlugins || []));
  const drawn = drawnGrid(snap(), todayOf(current(), defs), defs, { pluginsKnown: !!state.pluginsKnown, meetingsHidden: state.meetings.hidden });
  return [...drawn.placed, ...drawn.below].some(it => it.id === id);
}

const dockUi = store && attachDock(document, {
  defs: DOCKS, render, toast, announce,
  // A tab a change brings into view (chosen, moved or expanded) is the page's tab chosen last,
  // which the hash names; the Run log reads its runs then.
  layouts: {
    get: docks.get,
    set: (page, layout) => {
      const was = visibleTabs(docks.get(page));
      docks.set(page, layout);
      const fresh = visibleTabs(layout).filter(tab => !was.includes(tab));
      if (page === 'automations') automationsUi.follow(fresh)?.catch(fail);
    },
  },
  // A divider or tab held: updates wait, as for Today's widgets, until the drop is drawn.
  dragging: holdLayout,
  locked: () => !!todayUi?.locked(),
  nudge: () => todayUi.handle('today-locked'),
  pin: id => todayUi.handle('today-add', { dataset: { id } }),
  onToday,
});

// ---------------------------------------------------------------- menus (spec "Menus")

// The main menu folds its groups and collapses to its 64 px icon rail, the Settings menu folds its
// groups and shrinks to a 58 px rail, and all are preferences of this Mac: `codemie.sidebar.collapsed`
// ("1"/"0"), `codemie.sidebar.folded` ({work, ai, plugins}: the folds clicked), `codemie.settings.folded`
// (the folded group names) and `codemie.settings.menu` ({collapsed, width}). The pages only read
// them (the views are pure); the changes below store and draw them.
const SIDEBAR_KEY = 'codemie.sidebar.collapsed';
const SIDEBAR_FOLDED_KEY = 'codemie.sidebar.folded';
const SIDEBAR_GROUPS = [...NAV_GROUPS.map(g => [g.id, g.label]), ['plugins', 'Plugins']];
const FOLDED_KEY = 'codemie.settings.folded';
const MENU_KEY = 'codemie.settings.menu';
/** The main menu edge is dragged this far (px) to collapse or expand it. */
const SIDEBAR_DRAG = 60;
/** The Settings menu edge dragged under this width (px) shrinks the menu to its rail. */
const SETTINGS_RAIL_AT = 150;

const sidebarCollapsed = () => localPref(SIDEBAR_KEY, '0') === '1';
/** The main menu's folds clicked so far: {work, ai, plugins} booleans (a missing one is the default). */
function sidebarFolded() {
  const saved = localJson(SIDEBAR_FOLDED_KEY, {});
  return Object.fromEntries(SIDEBAR_GROUPS.filter(([id]) => typeof saved?.[id] === 'boolean').map(([id]) => [id, saved[id]]));
}
const clampWidth = w => Math.min(SETTINGS_MENU.max, Math.max(SETTINGS_MENU.min, Math.round(Number(w)) || SETTINGS_MENU.def));
function settingsMenu() {
  const saved = localJson(MENU_KEY, null);
  return { collapsed: saved?.collapsed === true, width: clampWidth(saved?.width) };
}
function foldedGroups() {
  const saved = localJson(FOLDED_KEY, []);
  return Array.isArray(saved) ? saved.filter(name => SETTINGS_GROUPS.some(g => g.name === name)) : [];
}
const saveMenu = patch => setLocalPref(MENU_KEY, JSON.stringify({ ...settingsMenu(), ...patch }));
const saveFolded = names => setLocalPref(FOLDED_KEY, JSON.stringify(names));

/** What Settings → Layout shows: the preferences, the page layouts and the Today grid. */
function layoutContext() {
  if (state.route !== 'settings' || state.settingsTab !== 'layout') return undefined;
  const defs = tileDefs(pluginWidgetCatalog(state.installedPlugins || []));
  return {
    prefs: { locked: !!todayUi?.locked(), handles: localPref('codemie.layout.handles', 'hover'), sidebarCollapsed: sidebarCollapsed(), menuCollapsed: settingsMenu().collapsed },
    docks: { defs: DOCKS, layouts: Object.fromEntries(Object.keys(DOCKS).map(page => [page, docks.get(page)])) },
    today: todayOf(current(), defs),
  };
}

/** Folds or unfolds main menu group `id`, from how it is drawn now (Plugins folds by default with
 *  more than three plugins), and keeps the choice. */
async function foldSidebarGroup(id) {
  const label = SIDEBAR_GROUPS.find(([g]) => g === id)?.[1];
  if (!label) return;
  const saved = sidebarFolded();
  const plugins = new Set((pluginHost?.activities() || []).map(a => a.plugin)).size;
  const fold = !groupFolded(id, saved, plugins);
  setLocalPref(SIDEBAR_FOLDED_KEY, JSON.stringify({ ...saved, [id]: fold }));
  announce(`${label} ${fold ? 'folded' : 'unfolded'}`);
  await render();
}

async function toggleSidebar(on = !sidebarCollapsed()) {
  setLocalPref(SIDEBAR_KEY, on ? '1' : '0');
  announce(on ? 'Main menu collapsed to icons' : 'Main menu expanded');
  await render();
}

async function setSettingsMenu(patch, say) {
  saveMenu(patch);
  if (say) announce(say);
  await render();
}
const shrinkSettingsMenu = (on = !settingsMenu().collapsed) => setSettingsMenu({ collapsed: on }, on ? 'Settings menu shrunk to icons' : 'Settings menu expanded');
const focusEdge = () => document.querySelector('.ws-settings-edge')?.focus();

/** Folds or unfolds Settings group `name`; with `only` (⌥-click) every other group folds. */
async function foldGroup(name, only) {
  const all = SETTINGS_GROUPS.map(g => g.name);
  if (!all.includes(name)) return;
  const folded = foldedGroups();
  const next = only ? all.filter(n => n !== name) : folded.includes(name) ? folded.filter(n => n !== name) : [...folded, name];
  saveFolded(next);
  announce(only ? `${name} is the only open group` : `${name} ${next.includes(name) ? 'folded' : 'unfolded'}`);
  await render();
}

/** Folds every group, or, when all are folded, unfolds them. */
async function foldAll() {
  const folded = foldedGroups();
  const fold = SETTINGS_GROUPS.some(g => !folded.includes(g.name));
  saveFolded(fold ? SETTINGS_GROUPS.map(g => g.name) : []);
  announce(fold ? 'All groups folded' : 'All groups unfolded');
  await render();
}

// A menu edge held: updates wait (as for a Today widget) until the drop is drawn. The drop asks
// for its render while the edge is still held, so it is drawn once, when the last hold lets go.
function dragSidebarEdge(ev, edge) {
  const was = sidebarCollapsed();
  const done = () => {
    edge.classList.remove('ws-active');
    holdLayout(false);
  };
  trackPress(ev, {
    cursor: 'ew',
    onStart: () => {
      holdLayout(true);
      edge.classList.add('ws-active');
    },
    onEnd: (_, { dx }) => {
      if (was ? dx >= SIDEBAR_DRAG : dx <= -SIDEBAR_DRAG) toggleSidebar(!was).catch(fail);
      else render().catch(fail);
      done();
    },
    onCancel: () => {
      render().catch(fail);
      done();
    },
  });
}

// The Settings menu follows the pointer between 200 and 400 px and turns into the rail under 150.
function dragSettingsEdge(ev, edge) {
  const layout = edge.closest('.ws-settings-layout');
  const aside = layout?.querySelector('.ws-settings-sidebar');
  if (!layout || !aside) return;
  const before = settingsMenu();
  const start = before.collapsed ? SETTINGS_MENU.rail : before.width;
  let width = start;
  let rail = before.collapsed;
  trackPress(ev, {
    threshold: 1, cursor: 'ew',
    onStart: () => {
      holdLayout(true);
      layout.classList.add('ws-resizing');
    },
    onMove: (_, { dx }) => {
      width = start + dx;
      rail = width < SETTINGS_RAIL_AT;
      aside.classList.toggle('ws-settings-rail', rail);
      layout.style.setProperty('--ws-settings-w', `${rail ? SETTINGS_MENU.rail : clampWidth(width)}px`);
    },
    onEnd: () => {
      if (rail !== before.collapsed) announce(rail ? 'Settings menu shrunk to icons' : 'Settings menu expanded');
      saveMenu({ collapsed: rail, width: rail ? before.width : clampWidth(width) });
      render().catch(fail);
      holdLayout(false);
    },
    onCancel: () => {
      render().catch(fail);
      holdLayout(false);
    },
  });
}

document.addEventListener('pointerdown', ev => {
  const edge = ready && ev.target.closest?.('.ws-sidebar-edge, .ws-settings-edge');
  if (!edge) return;
  if (edge.classList.contains('ws-sidebar-edge')) dragSidebarEdge(ev, edge);
  else dragSettingsEdge(ev, edge);
});

document.addEventListener('dblclick', ev => {
  if (!ready || !ev.target.closest?.('.ws-settings-edge')) return;
  setSettingsMenu({ collapsed: false, width: SETTINGS_MENU.def }, 'Settings menu width reset').then(focusEdge).catch(fail);
});

// ---------------------------------------------------------------- quick capture (ask-capture § 9)

// The bar sits under the top bar, over the page, so the page never moves. Like the setup sheet it
// lives outside #workspace-app (`#ws-capture-host` in <body>, which a redraw never touches) and
// above the plugin layer, whose frames it makes inert while open: a click where a frame is lands
// on the page and closes the bar. `drawCapture` draws it from `state.capture`, laid over the main
// area, swapping its parts in place around the box and the line (a live region), which stay.
let captureReturn = null;
const captureUi = store && createCaptureController({
  state, snap, mutate, query: (op, data) => store.query(op, data),
  render: () => drawCapture(), toast, go: hash => goHash(hash), savePendingNote, fail,
  focusBack: () => {
    const back = captureReturn;
    captureReturn = null;
    const el = back?.el?.isConnected ? back.el : soleMatch(root, back?.sel);
    el?.focus({ preventScroll: true });
  },
});

/** Opens quick capture (⌘N, or Ask's Add as task), remembering where focus was for Esc. With the
 *  bar open already, only its box takes focus. */
function openCapture(options) {
  if (state.capture.open) return document.getElementById('capture-input')?.focus();
  const el = document.activeElement;
  captureReturn = el && root.contains(el) ? { el, sel: controlSelector(el) } : null;
  return captureUi?.open(options);
}

// ---------------------------------------------------------------- Ask (ask-capture § 2, § 11)

// The menu's field and the Ask page's box. The field is part of the menu (shell.js draws it from
// `state.ask` on every render; its words are kept there, so a redraw keeps them, and the render's
// own refocus keeps its focus and caret). The About chip is read from the page's selection.
const askUi = store && createAskController({
  state, snap, mutate, query: (op, data) => store.query(op, data),
  render: () => {
    if (!ready || modalOpen()) return;
    if (pressing) askHeld = true;
    else return render().catch(fail);
    return undefined;
  },
  go: hash => goHash(hash), toast, withClaudeChoice, fail, announce,
  confirm: options => confirmModal(options),
  hash: () => location.hash,
  hiddenCalendars: () => [...hiddenCalendars()],
  openCapture: options => openCapture(options),
  openRecord: target => openAskTarget(target),
  draftOptions: channel => rememberedOptions(channel),
  // The composer's own ✦ draft path (the chooser on first use, a change's Restore ended).
  startDraft: async (m, request) => {
    await startDraft(m, request, request.instructions || '', request);
    document.getElementById('reply-body')?.focus({ preventScroll: true });
  },
  fieldShown: () => !!document.getElementById('ask-input')?.getClientRects().length,
  focus: (selector, { select = false } = {}) => {
    if (pressing) {
      askFocusHeld = { selector, select };
      return;
    }
    const el = document.querySelector(selector);
    el?.focus({ preventScroll: true });
    if (select) el?.select?.();
  },
  focusBack: selector => {
    const el = soleMatch(root, selector) || root.querySelector('#workspace-page h1') || document.getElementById('workspace-main');
    if (!el) return;
    if (!el.matches('a,button,input,select,textarea,[tabindex]')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  },
});

/** Opens an Ask cite's record in the window (`citeTarget`, § 8): a message on its lane, selected
 *  (Default) or open (Compact); a task's drawer (By date: its row unfolded); a calendar day with
 *  its event open; a meeting by its hash. Sends nothing. */
async function openAskTarget({ hash, select } = {}) {
  if (select?.kind === 'message') {
    const m = getRecord('message', select.id);
    if (!m) return undefined;
    Object.assign(state, { lane: m.data.lane || 'reply', channel: 'all', search: '', selectedMessage: m.id, selectedKey: messageKey(m) });
    if (compactView()) Object.assign(state, { openMessage: m.id, openKey: messageKey(m) });
    return route('inbox');
  }
  if (select?.kind === 'task') {
    await route('tasks');
    if (!tasksOf(snap()).some(r => r.id === select.id)) return undefined;
    if (shownView(state.tasks, snap()) !== 'dates') return tasksUi.openDrawer(select.id);
    state.tasks.rowOpen = select.id;
    return render();
  }
  if (select?.kind === 'event') {
    if (select.day) state.calendarDate = dateFromKey(select.day);
    await route('calendar');
    const ev = getRecord('event', select.id);
    return ev ? eventDialog(ev) : undefined;
  }
  return hash ? goHash(hash) : undefined;
}

// The field's and the page box's own keys, first (capture phase): Enter asks, Esc clears then
// leaves, ↑ ↓ move through Recent; a key handled there goes no further (the Inbox's Enter and ⌘↩).
document.addEventListener('keydown', ev => {
  if (askUi && ev.target.closest?.('.ws-ask-field,.ws-ask-page-box') && !modalOpen()) askUi.key(ev);
}, true);
document.addEventListener('input', ev => {
  if (ev.target.id === 'ask-input') askUi?.input(ev.target.value);
  else if (ev.target.id === 'ask-follow-up') askUi?.pageInput(ev.target.value);
}, true);

/** Whether the Ask page draws its history as a column: Default, a main area 1,100 px or wider. */
function askWide(s) {
  const main = document.getElementById('workspace-main');
  return viewOf(s.settings) === 'default' && (main?.clientWidth || 0) >= 1100;
}
window.addEventListener('resize', () => {
  if (ready && state.route === 'ask' && askWide(snap()) !== state.ask.wide && !modalOpen()) render().catch(fail);
});
// The answering line's seconds tick on screen every second. What a screen reader hears is one
// status node outside the page (a redraw never recreates it), changed only when an answer starts,
// ends or moves on, and its seconds at most every 5 s (ask-capture § Accessibility).
function syncAskStatus() {
  const el = ready && state.route === 'ask' ? root.querySelector('[data-ask-run]') : null;
  const run = el ? { turnId: el.dataset.askRun, profile: el.dataset.askProfile, since: Number(el.dataset.askSince) } : null;
  const next = nextAskStatus(askStatus, run, Date.now() / 1000);
  if (next === askStatus) return;
  askStatus = next;
  let live = document.getElementById('ask-live');
  if (!live) {
    live = document.createElement('div');
    live.id = 'ask-live';
    live.className = 'ws-sr';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  live.textContent = next?.text || '';
}
setInterval(() => {
  if (!ready) return;
  if (state.route === 'ask') {
    const now = Date.now() / 1000;
    for (const el of root.querySelectorAll('[data-ask-since]')) {
      const line = answeringLine(el.dataset.askProfile, Math.max(0, Math.floor(now - Number(el.dataset.askSince))));
      const tick = el.querySelector('[data-ask-tick]');
      if (tick && tick.textContent !== line) tick.textContent = line;
    }
  }
  syncAskStatus();
}, 1000);
// Focus into the field opens its list; focus or a press anywhere else closes it.
document.addEventListener('focusin', ev => {
  if (!askUi || !ready) return;
  if (ev.target.closest?.('.ws-ask-field')) askUi.opened();
  else if (state.ask.open) askUi.closed();
});
// A press elsewhere is drawn after the button is up (a redraw now would swallow its click).
document.addEventListener('pointerdown', ev => {
  if (!askUi || !state.ask.open || ev.target.closest?.('.ws-ask-field')) return;
  // A press elsewhere: focus goes where it lands, so Back has nowhere older to return to.
  Object.assign(state.ask, { open: false, active: -1, focusBack: null, backFocus: null });
  askHeld = true;
}, true);

/** Lays the bar over the main area, under the top bar (the menu may be a rail, collapsed or
 *  dragged; the terminal dock may be open). */
function placeCapture(host) {
  const main = document.getElementById('workspace-main');
  if (!main) return;
  const r = main.getBoundingClientRect();
  Object.assign(host.style, { left: `${Math.round(r.left)}px`, top: `${Math.round(r.top)}px`, width: `${Math.round(r.width)}px` });
}

function drawCapture() {
  let host = document.getElementById('ws-capture-host');
  const pluginLayer = document.querySelector('.ws-plugin-layer');
  if (!state.capture.open || recovering || !store?.get()) {
    host?.remove();
    if (pluginLayer) pluginLayer.inert = sheetOpen();
    return;
  }
  if (pluginLayer) pluginLayer.inert = true;
  const html = captureBar(state, snap());
  if (!host) {
    host = document.createElement('div');
    host.id = 'ws-capture-host';
    host.className = 'ws-capture-host';
    host.innerHTML = html;
    document.body.append(host);
    placeCapture(host);
    host.querySelector('#capture-input')?.focus({ preventScroll: true });
    return;
  }
  placeCapture(host);
  const live = host.firstElementChild;
  const t = document.createElement('template');
  t.innerHTML = html;
  const fresh = t.content.firstElementChild;
  const focused = host.contains(document.activeElement) ? controlSelector(document.activeElement) : null;
  const sync = (to, from) => {
    for (const a of [...to.attributes]) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
    for (const a of [...from.attributes]) if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
  };
  sync(live, fresh);
  for (const part of [...fresh.querySelectorAll('[data-capture-part]')]) {
    const old = live.querySelector(`[data-capture-part="${part.dataset.capturePart}"]`);
    if (!old) continue;
    if (part.dataset.capturePart !== 'line') {
      old.replaceWith(part);
      continue;
    }
    // The line is a polite live region: the same node, its content changed only when it differs,
    // so the read date is said once, when its answer settles.
    sync(old, part);
    if (old.innerHTML !== part.innerHTML) old.innerHTML = part.innerHTML;
  }
  const input = live.querySelector('#capture-input');
  const twin = fresh.querySelector('#capture-input');
  for (const name of ['aria-label', 'aria-invalid']) {
    if (twin.hasAttribute(name)) input.setAttribute(name, twin.getAttribute(name));
    else input.removeAttribute(name);
  }
  if (input.value !== state.capture.text) input.value = state.capture.text;
  // A control swapped out under focus (Task / Note, a × that went) leaves focus in the bar.
  if (focused && !host.contains(document.activeElement)) (soleMatch(host, focused) || input).focus({ preventScroll: true });
}

// The bar's own keys, first (capture phase): Enter and ⌘↩ add, Esc clears then closes. A key it
// handles goes no further, so the Inbox's ⌘↩ never sends a reply from under the bar.
document.addEventListener('keydown', ev => {
  if (captureUi && ev.target.closest?.('.ws-capture')) captureUi.key(ev);
}, true);
document.addEventListener('input', ev => {
  if (ev.target.id === 'capture-input') captureUi?.input(ev.target.value);
}, true);
// A click on the page closes the bar (focus stays where the click put it).
document.addEventListener('pointerdown', ev => {
  if (state.capture.open && !ev.target.closest?.('.ws-capture-host,.ws-toasts,.ws-modal')) captureUi?.close({ refocus: false });
}, true);
window.addEventListener('resize', () => { if (state.capture.open) drawCapture(); });

// ⌘N opens quick capture, ⌘\ collapses the main menu, ⌘⇧\ shrinks the Settings menu; on the
// Settings menu's edge, Enter toggles it and ← → resize it.
document.addEventListener('keydown', ev => {
  if (!ready || modalOpen() || sheetOpen() || ev.isComposing) return;
  if (isCaptureKey(ev, { modal: modalOpen(), sheet: sheetOpen() })) {
    ev.preventDefault();
    openCapture();
    return;
  }
  // ⌘K: the Ask field (or the Ask page's box). The terminal dock keeps its own ⌘K (its keys
  // never reach here; `isAskKey` checks too), as does a plugin frame (another document).
  if (isAskKey(ev, { modal: modalOpen(), sheet: sheetOpen() })) {
    ev.preventDefault();
    if (state.capture.open) captureUi?.close({ refocus: false });
    const el = document.activeElement;
    const from = el && root.contains(el) && !el.closest('.ws-ask-field') ? controlSelector(el) : null;
    askUi?.focusField({ from }).catch(fail);
    return;
  }
  // ⌘.: Stop the running answer, on the Ask page or in the field.
  if (isStopKey(ev, { modal: modalOpen(), sheet: sheetOpen() }) && (state.route === 'ask' || ev.target.closest?.('.ws-ask-field')) && snap().ask?.running) {
    ev.preventDefault();
    askUi?.stop().catch(fail);
    return;
  }
  if (ev.code === 'Backslash' && (ev.metaKey || ev.ctrlKey) && !ev.altKey) {
    if (!ev.shiftKey) {
      ev.preventDefault();
      toggleSidebar().catch(fail);
    } else if (state.route === 'settings') {
      ev.preventDefault();
      shrinkSettingsMenu().catch(fail);
    }
    return;
  }
  if (!ev.target.closest?.('.ws-settings-edge') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const menu = settingsMenu();
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    shrinkSettingsMenu().then(focusEdge).catch(fail);
  } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    ev.preventDefault();
    const step = ev.key === 'ArrowLeft' ? -24 : 24;
    const next = menu.collapsed ? (step > 0 ? { collapsed: false } : null)
      : menu.width + step < SETTINGS_MENU.min ? { collapsed: true } : { width: clampWidth(menu.width + step) };
    if (next) setSettingsMenu(next, next.collapsed === undefined ? '' : next.collapsed ? 'Settings menu shrunk to icons' : 'Settings menu expanded').then(focusEdge).catch(fail);
  }
});

// A rail has no labels: a tooltip names the icon under the pointer (or the one focused by key).
let tipEl = null;
function hideTip() {
  tipEl?.remove();
  tipEl = null;
}
function showTip(target) {
  const inRail = target.closest('.ws-sidebar-rail, .ws-settings-rail') || (target.closest('.ws-sidebar') && matchMedia('(max-width:1050px)').matches);
  if (!inRail || !target.dataset.tip) return hideTip();
  const box = target.getBoundingClientRect();
  hideTip();
  tipEl = document.createElement('div');
  tipEl.className = 'ws-tooltip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.textContent = target.dataset.tip;
  tipEl.style.left = `${Math.round(box.right + 8)}px`;
  tipEl.style.top = `${Math.round(box.top + box.height / 2)}px`;
  document.body.append(tipEl);
}
document.addEventListener('pointerover', ev => {
  if (ev.pointerType === 'touch') return;
  const target = ev.target.closest?.('[data-tip]');
  if (target) showTip(target);
  else hideTip();
});
document.addEventListener('focusin', ev => {
  const target = ev.target.closest?.('[data-tip]');
  if (target?.matches(':focus-visible')) showTip(target);
});
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip, true);
document.documentElement.addEventListener('mouseleave', hideTip);

// ---------------------------------------------------------------- meetings (spec "Meetings page")

/** Saves `text` as a file in Downloads (the browser's download). */
function downloadText(name, text, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const meetingsUi = store && createMeetingsController({
  state, store, snap, mutate, render, route, openModal, confirmModal, toast,
  writeText: text => navigator.clipboard.writeText(text),
  downloadText,
  focus: focusFirst,
  setPref: setLocalPref,
  syncHash: () => { if (state.route === 'meetings') history.replaceState(null, '', routeHash()); },
  ensureClaudeChoice,
  moveTask: (id, status, options) => tasksUi.move(id, status, options),
  // "Add N to …" goes to the active provider; Undo is one `task_withdraw` (design §10).
  taskTarget: activeTaskTarget({ snap, moveTask: (id, status, o) => tasksUi.move(id, status, o), withdraw: ids => mutate('task_withdraw', { ids }) }),
  connect: capabilities => connectMicrosoft(capabilities),
  showEvent: async id => {
    const ev = getRecord('event', id);
    if (!ev) return toast('This meeting is no longer in your calendar.', 'error');
    state.calendarDate = dateFromKey(dayKey(ev.data.start, snap().settings.timeZone));
    await route('calendar');
    return eventDialog(getRecord('event', id));
  },
  canRender: () => ready && !modalOpen() && !editing() && !taskDrag,
  summaryInputs: () => ({ slots: pluginHost?.callSlots() || [], plugins: pluginHost?.minutesPlugins?.() || [] }),
  dock: dockFor('meetings'),
});

// ---------------------------------------------------------------- Settings › Meetings

const meetingsSettingsUi = store && createMeetingsSettingsController({
  state, store, snap, mutate, render, route, openModal, confirmModal, toast,
  // The glossary saved as it is typed: no re-render under the caret (the store's update waits too).
  save: (op, data) => store.mutate(op, data),
  patch: (selector, html) => {
    const el = root.querySelector(selector);
    if (el) el.outerHTML = html;
  },
  focus: focusFirst,
  writeText: text => navigator.clipboard.writeText(text),
  insertText: (selector, text) => {
    const field = root.querySelector(selector);
    if (!field) return null;
    field.focus({ preventScroll: true });
    field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
    return field.value;
  },
  pickRoot: () => invoke('meetings_root_pick'),
  transcriptsOn: () => meetingsUi.transcriptsOn(),
  makeNotes: (id, options) => meetingsUi.makeNotes(id, options),
  guarded: (id, run) => meetingsUi.guarded(id, run),
  glossaryChanged: () => meetingsUi.forgetGlossary(),
  plugins: () => pluginHost?.minutesPlugins?.() || [],
  openMeeting: async (id, tab, ref) => {
    await meetingsUi.open(id, tab);
    if (ref) await meetingsUi.handle('meeting-goto-line', { dataset: { id, t: ref } });
  },
});

/** Opens the meeting saved in folder `folder` (a plugin's `echo://call/<folder>` link), or says
 *  Connect has no such meeting. */
function openMeetingFolder(folder) {
  const m = (snap().records || []).find(r => r.kind === 'meeting' && typeof r.data?.folder === 'string'
    && r.data.folder.split('/').filter(Boolean).pop() === folder);
  if (!m) return toast('Connect has no meeting saved in that folder.', 'error');
  return openMeeting(m.id).catch(fail);
}

/** Opens a meeting on the Meetings page (`#/meetings/<id>/<pane>`; with no pane, the "Open a
 *  meeting on" setting's; `line`: a transcript line). */
function openMeeting(id, pane = null, line = null) {
  return meetingsUi.open(id, pane, line);
}

// ---------------------------------------------------------------- dialogs

/** Add a task from an Inbox message: it lands in To do, with the message it came from. */
function commitmentDialog(source) {
  openModal({
    title: 'Add a task',
    subtitle: source ? `From ${source.data.from || 'a message'}` : '',
    body: `${field('What needs doing?', textArea(source ? `Reply to ${source.data.from || 'sender'}: ${messageTitle(source, snap())}` : '', { name: 'text', required: true, maxlength: 2000, rows: 3 }))}
      <div class="ws-form-row">${field('Owner', textInput({ name: 'owner', value: 'You', required: true, maxlength: 320 }))}${field('Due date', textInput({ name: 'due', type: 'date' }), 'Optional')}</div>
      ${source?.data.text ? `<blockquote class="ws-quote">${e(source.data.text.slice(0, 400))}</blockquote>` : ''}`,
    submit: 'Add task',
    onSubmit: async f => {
      await mutate('task_save', { text: f.get('text'), owner: f.get('owner'), due: f.get('due') || null, status: 'todo', sourceId: source?.id || null, sourceRevision: source?.revision || null, quote: source?.data.text ? String(source.data.text).slice(0, 2000) : null });
      toast(addedLine(snap(), 'Task added to To do.'), 'success', { label: 'Open', run: () => route('tasks') });
    },
  });
}

function eventDialog(ev) {
  if (!ev) return toast('This event is no longer available. Refresh the calendar.', 'error');
  const d = ev.data;
  const dialog = openModal({
    title: d.title || 'Untitled event',
    body: eventDetails(snap(), ev),
    submit: null,
    cancel: 'Close',
    size: 'md',
    footerExtra: eventActions(snap(), ev),
    onClose: () => { if (state.openEvent === ev.id) state.openEvent = null; },
  });
  state.openEvent = ev.id;
  dialog.classList.add('ws-event-modal');
  dialog.dataset.eventId = ev.id;
  dialog.style.setProperty('--event-color', calendarColors(snap()).get(d.calendarId) || 'var(--ws-accent)');
}

/** An open event card follows the snapshot (its Transcript & notes section: a run's step, a
 *  switch turned on) while the page behind it waits for the dialog to close. */
function refreshEventDialog() {
  const dialog = document.querySelector('.ws-event-modal[open][data-event-id]');
  const body = dialog?.querySelector('.ws-modal-body');
  if (!body) return;
  const ev = getRecord('event', dialog.dataset.eventId);
  if (!ev) return;
  const html = eventDetails(snap(), ev);
  if (body.dataset.html === html) return;
  const focused = body.contains(document.activeElement) ? controlSelector(document.activeElement) : null;
  const open = [...body.querySelectorAll('details[open][data-menu]')].map(x => x.dataset.menu);
  body.innerHTML = html;
  body.dataset.html = html;
  for (const menu of open) body.querySelector(`details[data-menu="${CSS.escape(menu)}"]`)?.setAttribute('open', '');
  if (focused) soleMatch(body, focused)?.focus({ preventScroll: true });
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
    returnCancels: true,
    onSubmit: async () => {
      const r = await mutate('action_confirm', { actionId: result.actionId, nonce: result.nonce });
      toast(r.message || 'Sent for delivery.', 'success');
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
  const capabilities = [...new Set(['calendar', 'mail', 'chats', ...enabled, ...[].concat(extra || [])])];
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
  // Done, Snooze, Acknowledge or a lane move can take the box away: its text is saved first.
  await flushReplySave();
  const targets = rowMessages(id);
  try {
    for (const m of targets) await store.mutate('inbox_decision', { ...data, ...perMessage(m), id: m.id });
  } finally {
    if (!modalOpen()) await render();
  }
  return targets.length;
}

function selectMessage(id) {
  flushReplySave();
  const m = getRecord('message', id);
  state.selectedKey = m ? messageKey(m) : null;
  state.selectedMessage = id;
  return render().then(() => root.querySelector('.ws-inbox-row.ws-selected')?.scrollIntoView({ block: 'nearest' }));
}

async function handle(action, el, ev) {
  if (action.startsWith('recovery-')) return recoveryAction(action);
  if (action.startsWith('capture-')) return captureUi.handle(action, el);
  if (action.startsWith('ask-')) return askUi.handle(action, el);
  if (action.startsWith('today-')) return todayUi.handle(action, el, ev);
  if (action.startsWith('dock-')) return dockUi.handle(action, el, ev);
  // Data location works from the recovery page too, where there is no snapshot.
  if (action.startsWith('data-')) return storageAction(action, el);
  if (action.startsWith('automation') || action.startsWith('run-')) return automationsUi.handle(action, el);
  if (action.startsWith('analytics-')) return analyticsUi.handle(action, el);
  // Today's task rows, and the tasks a run made, open the task on the Tasks page; one no longer
  // there (deleted, or not pulled from the provider yet) opens the page alone.
  if (action === 'task-open-today') {
    await route('tasks');
    return tasksOf(snap()).some(r => r.id === el.dataset.id) ? tasksUi.openDrawer(el.dataset.id) : undefined;
  }
  if (action.startsWith('meetings-settings-')) return meetingsSettingsUi.handle(action, el);
  if (action.startsWith('voice-')) return voiceUi.handle(action, el);
  if (action.startsWith('meeting-') || action.startsWith('doc-')) {
    // From the calendar's event card, a step that opens a dialog or the page closes the card first.
    const card = el.closest?.('.ws-event-modal');
    if (card && ['meeting-make-notes', 'meeting-import', 'meeting-open', 'meeting-retry', 'meeting-calendar'].includes(action)) card.close();
    // ⌥-click on a day of the Meetings list keeps only that day open.
    await meetingsUi.handle(action, el, { alt: !!ev?.altKey });
    if (card?.open) refreshEventDialog();
    return undefined;
  }
  if (action.startsWith('task')) return tasksUi.handle(action, el);
  if (action.startsWith('plugin') || action.startsWith('market-')) return pluginAction(action, el);
  if (action.startsWith('cm-') && await codemie.handle(action, el)) return undefined;
  const id = el.dataset.id;
  const s = snap();
  switch (action) {
    case 'route':
      if (el.dataset.lane) {
        state.lane = el.dataset.lane;
        state.selectedMessage = null;
        closeRow();
      }
      return route(el.dataset.route || 'today');
    case 'sidebar-toggle': return toggleSidebar();
    case 'sidebar-fold': return foldSidebarGroup(el.dataset.group);
    case 'settings-group': return foldGroup(el.dataset.group, !!ev?.altKey);
    case 'settings-groups-all': return foldAll();
    case 'settings-menu-toggle': return shrinkSettingsMenu();
    case 'layout-lock': return todayUi.handle('today-lock');
    case 'layout-handles':
      if (['hover', 'always', 'customize'].includes(el.dataset.value)) setLocalPref('codemie.layout.handles', el.dataset.value);
      return render();
    case 'settings-tab':
      // A document's “Edit the template” opens that template; Note templates again leaves a clean editor.
      // From a dialog (Make notes) or the event card, the dialog closes first.
      document.querySelectorAll('.ws-modal[open]').forEach(d => d.close());
      if (el.dataset.template && meetingsSettingsUi) return meetingsSettingsUi.editTemplate(el.dataset.template);
      meetingsSettingsUi?.leaveEditor(el.dataset.tab);
      return route('settings', el.dataset.tab);
    case 'setup-tools': return route('settings', 'cm-overview');
    case 'ai-refresh': return loadAi();
    case 'ai-test': return testAiProfile(el.dataset.profile);
    case 'ai-test-model': state.ai.testModels[el.dataset.profile] = el.value; return;
    // The Default row: its profile (`field` unset), model (`defaultModel`) or fallback (`defaultFallback`).
    case 'ai-default': return saveAiSettings(nextAiSettings(state.ai.settings, state.ai.profiles, { field: el.dataset.field || 'default', value: el.value }));
    // A job's row (a purpose or `plugin:<id>`): its profile, model or fallback.
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
    case 'sync-every': return mutate('settings_update', { syncEveryMin: Number(el.value) });

    // Appearance & settings
    case 'theme': return mutate('settings_update', { theme: el.dataset.theme });
    case 'theme-toggle': return mutate('settings_update', { theme: document.documentElement.classList.contains('dark') ? 'light' : 'dark' });
    case 'view-set': return setView(el.dataset.view);
    case 'menu-page': return mutate('settings_update', { hiddenPages: toggleHiddenPage(snap().settings.hiddenPages, el.dataset.page, el.checked) });
    case 'terminal-toggle': return terminalDock?.toggle();
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
    case 'calendar-sidebar': {
      // The calendar list is the Calendars section: the button collapses or expands it.
      const side = docks.get('calendar').panes.find(p => p.tabs.includes('cal-side'));
      return dockUi.setCollapsed('calendar', 'cal-side', !side.collapsed);
    }
    case 'calendar-visibility': {
      const hidden = hiddenCalendars();
      if (el.checked) hidden.delete(id); else hidden.add(id);
      setLocalPref('codemie.calendar.hidden', JSON.stringify([...hidden]));
      return render();
    }
    case 'event': return eventDialog(getRecord('event', id));
    case 'calendar-transcripts':
      state.calendarTranscripts = el.checked;
      setLocalPref('codemie.calendar.transcripts', String(el.checked));
      return render();
    case 'calendar-legend':
      state.calendarLegend = { ...state.calendarLegend, [el.dataset.key]: !el.checked };
      return render();
    case 'join': await store.query('open_source', { id, kind: 'event', join: true }); return;
    case 'source': await store.query('open_source', { id, kind: el.dataset.kind, join: false }); return;
    case 'event-reminder': {
      const ev = getRecord('event', id);
      el.closest('dialog')?.close();
      return reminderDialog(ev);
    }
    case 'new-event': return newEventDialog();

    // Inbox
    case 'lane': state.lane = el.dataset.lane; state.selectedMessage = null; closeRow(); return render();
    case 'channel': state.channel = el.dataset.channel; state.selectedMessage = null; closeRow(); return render();
    case 'select-message':
      if (compactView()) return moveRows(clickRow({ selected: state.selectedMessage, open: state.openMessage }, id));
      return selectMessage(id);
    case 'open-message': {
      const m = getRecord('message', id);
      if (m) {
        state.lane = m.data.lane || 'reply';
        state.channel = 'all';
        state.search = '';
        state.selectedMessage = id;
        state.selectedKey = messageKey(m);
        // A message opened from elsewhere opens in place in Compact too.
        if (compactView()) Object.assign(state, { openMessage: id, openKey: messageKey(m) });
      }
      return route('inbox');
    }
    case 'inbox-more': state.inboxLimit += 200; return render();
    case 'inbox-earlier': state.threadAll.add(id); return render();
    case 'show-archived': state.showArchived = el.checked; return render();
    case 'show-snoozed': state.showSnoozed = el.checked; return render();
    case 'message-archive': {
      const m = getRecord('message', id);
      const restore = m?.data.lifecycle === 'archived';
      if (!restore) leaveRow(id);
      await decideRow(id, { action: restore ? 'restore' : 'archive' });
      return toast(restore ? 'Moved back to the Inbox.' : 'Marked done.', 'success');
    }
    case 'message-snooze': {
      const until = snoozeUntil(el.dataset.preset);
      el.closest('details')?.removeAttribute('open');
      const critical = rowMessages(id).some(m => m.data.lane === 'critical');
      const run = () => {
        leaveRow(id);
        return decideRow(id, { action: 'snooze', until }, m => (m.data.lane === 'critical' ? { confirmGlobal: true } : {}));
      };
      if (critical) {
        return confirmModal({ title: 'Pause critical reminders?', text: 'This pauses reminders for this incident until the chosen time. It does not acknowledge it.', confirm: 'Pause reminders', onConfirm: run });
      }
      await run();
      return toast('Snoozed.', 'success');
    }
    case 'message-lane': {
      const m = getRecord('message', id);
      const lane = el.value;
      const run = () => {
        leaveRow(id);
        return decideRow(id, { action: 'lane', lane }, x => (x.data.lane === 'critical' && lane !== 'critical' ? { acknowledge: true } : {}));
      };
      if (m?.data.lane === 'critical' && lane !== 'critical') {
        el.value = m.data.lane;
        return confirmModal({ title: 'Acknowledge and move?', text: 'Acknowledging stops this incident’s pending reminders. The move applies to Connect.', confirm: 'Acknowledge and move', onConfirm: run });
      }
      await run();
      return toast(`Moved to ${LANES.find(([k]) => k === lane)?.[1] || lane}.`, 'success');
    }
    case 'message-ack': await decideRow(id, { action: 'acknowledge' }); return;
    case 'commitment': return commitmentDialog(id ? getRecord('message', id) : null);
    // Reply drafts with Claude
    case 'draft-reply': {
      const m = getRecord('message', id);
      if (!m) return toast('This message is no longer available. Refresh and try again.', 'error');
      Object.assign(state, { lane: m.data.lane || 'reply', channel: 'all', search: '', selectedMessage: id, selectedKey: messageKey(m) });
      if (compactView()) Object.assign(state, { openMessage: id, openKey: messageKey(m) });
      await route('inbox');
      await startDraft(m, rememberedOptions(m.data.channel));
      document.getElementById('reply-body')?.focus({ preventScroll: true });
      return;
    }
    case 'ai-draft-options': {
      el.closest('details')?.removeAttribute('open');
      if (state.draftPopover) return closeDraftPopover();
      return openDraftPopover(getRecord('message', id));
    }
    // ✦ draft with AI: at once, with the options last used for this channel.
    case 'ai-draft-quick': {
      const m = getRecord('message', el.closest('form')?.dataset.id);
      await startDraft(m, rememberedOptions(m?.data.channel));
      document.getElementById('reply-body')?.focus({ preventScroll: true });
      return;
    }
    // ✦ Tell AI what to change: the words with the current text; the result replaces the text the
    // change started from, which Restore my text brings back.
    case 'ai-draft-change': {
      const input = document.getElementById('reply-change');
      const box = document.getElementById('reply-body');
      const form = box?.closest('form');
      const words = input?.value.trim() || '';
      if (!words || !form) return;
      const m = getRecord('message', form.dataset.id);
      if (!m) throw new Error('This conversation is no longer available. Refresh and try again.');
      const key = form.dataset.key;
      const options = rememberedOptions(m.data.channel);
      state.drafts[key] = startChange(draftUi(key), box.value);
      await startDraft(m, options, words, changeRequest(m, options, words, box.value));
      const field = document.getElementById('reply-change');
      if (field) field.value = '';
      return;
    }
    // The primary Send: today's review (`submitForm('reply')`).
    case 'reply-send': {
      const form = el.closest('form[data-form="reply"]');
      return form ? submitForm(form) : undefined;
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
      endChange(s.jobs.find(j => j.id === id)?.payload?.draftKey);
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
      const m = getRecord('message', retrySourceOf(request.sourceId, el));
      // Try again repeats a change with the text it was asked about.
      if (m && request.revise != null) {
        state.drafts[draftKeyOf(m)] = startChange(draftUi(draftKeyOf(m)), request.revise);
        return startDraft(m, request, request.instructions, changeRequest(m, request, request.instructions, request.revise));
      }
      return startDraft(m, request, request.instructions);
    }
    case 'ai-draft-dismiss':
      endChange(s.jobs.find(j => j.id === id && j.kind === 'ai_draft')?.payload?.draftKey);
      dismissDraftError(id);
      return render();
    case 'ai-summarize': return startSummary(getRecord('message', id));
    case 'ai-summarize-retry': case 'ai-summarize-choose': {
      const job = s.jobs.find(j => j.id === id);
      if (action === 'ai-summarize-choose' && !(await ensureClaudeChoice())) return;
      dismissDraftError(id);
      return startSummary(getRecord('message', retrySourceOf(job?.payload?.request?.sourceId, el)));
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
        await mutate('task_save', askCommitment(key, ask));
      } finally {
        asksSaving.delete(id);
      }
      toast(addedLine(snap(), 'Added to your tasks, in To do.'), 'success');
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
      // The box now holds what the app chose: ⌘↩ waits for the user's next touch.
      if (choice !== 'forget') disarmSendKey(key);
      if (next.save != null) await queueReplySave(m, next.save);
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
    // Today's checkbox: done, or back to To do.
    case 'commitment-toggle': return mutate('task_save', { id, status: el.checked ? 'done' : 'todo' });
    case 'local-delete': return mutate('local_delete', { kind: el.dataset.kind, id });

    // Rules, schedules, jobs, notifications, data
    case 'rule-new': return ruleDialog();
    case 'schedule-new': return scheduleDialog();
    case 'schedule-delete': return mutate('schedule_delete', { id });
    case 'job-cancel': return mutate('job_cancel', { id });
    case 'job-retry': return mutate('job_retry', { id });
    case 'notification-permission': return mutate('notification_permission');
    case 'notification-test': await mutate('notification_test'); return toast('Test reminder queued. Check Notification Center.');
    case 'menu-bar-toggle': return mutate('settings_update', { menuBar: { [el.dataset.source]: el.checked } }).catch(err => { el.checked = !el.checked; throw err; });
    case 'menu-bar-fix': {
      // A fix opens its place through the same router as a clicked menu row or notification.
      const fix = (s.menuBar?.fixes || []).find(f => f.id === el.dataset.fix);
      return fix ? openNotification(fix.open) : undefined;
    }
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
      await mutate('task_save', { text, owner: 'You', due: f.get('due') || null, status: 'todo' });
      root.querySelector('[data-form=commitment-add] [name=text]')?.focus();
      return;
    }
    case 'task-quick': return tasksUi.quickAdd(form.dataset.col, Object.fromEntries(f));
    case 'today-layout-save':
      form.closest('details')?.removeAttribute('open');
      return todayUi.handle('today-layout-save', { dataset: { name: String(f.get('name') || '') } });
    case 'meeting-notes': case 'meeting-task': return meetingsUi.submit(form, f);
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
      const chat = getRecord('message', id)?.data.channel === 'chat';
      const open = unfinishedParts(body, latestDraft(snap(), key)?.data.text);
      if (open.length) return confirmUnfinished(open, { submit: chat ? 'Send anyway' : 'Review anyway', then: () => guardedSend(key, id, body) });
      return guardedSend(key, id, body);
    }
    default: return undefined;
  }
}

/** One send per reply at a time: a second click, ⌘↩ or a re-rendered form mid-send sends nothing. */
async function guardedSend(key, id, body) {
  if (replyInFlight.has(key)) return undefined;
  replyInFlight.add(key);
  syncReplyBox(document.getElementById('reply-body'));
  try {
    return await sendReply(id, body);
  } finally {
    replyInFlight.delete(key);
    syncReplyBox(document.getElementById('reply-body'));
  }
}

/**
 * Sends the reply in the box (DESIGN 6.4 Sending), on the user's click or armed ⌘↩: saves it, has
 * native prepare it, then a Teams reply is confirmed in the same click and an Outlook reply asks
 * "Send this reply?" first. A failure keeps the text and puts native's sentence in the status line.
 */
async function sendReply(id, body) {
  const m = getRecord('message', id);
  if (!m) throw new Error('This conversation is no longer available. Refresh and try again.');
  if (!body.trim()) throw new Error('Write a reply first.');
  const key = draftKeyOf(m);
  const chat = m.data.channel === 'chat';
  let result;
  try {
    await queueReplySave(m, body);
    if (chat) showReplyStatus(key, 'Sending…');
    result = await mutate('action_prepare', { kind: chat ? 'chat_reply' : 'mail_reply', sourceId: id, body });
    if (!chat) return mailConfirm(result, m, body);
    await mutate('action_confirm', { actionId: result.actionId, nonce: result.nonce });
  } catch (err) {
    showReplyStatus(key, { text: err?.message || String(err), tone: 'error' });
    return undefined;
  }
  return afterSent(m, body);
}

/**
 * The short Outlook confirm (DESIGN 6.4): where the mail goes — To (a Reply-To the thread never
 * showed tagged "(new)"), Cc, the subject and the signature — not the body, which is on screen.
 * Cancel is focused and Return cancels; Send takes a click or Space.
 */
function mailConfirm(result, m, body) {
  return openModal({
    title: 'Send this reply?',
    subtitle: `${result.account || 'Microsoft 365'} · expires in 5 minutes`,
    body: `<div class="ws-review">${confirmLines(result.review || {}).map(line => `<p>${e(line)}</p>`).join('')}</div>`,
    submit: 'Send',
    cancel: 'Cancel',
    size: 'sm',
    returnCancels: true,
    workspaceId: result.workspaceId,
    onSubmit: async () => {
      try {
        await mutate('action_confirm', { actionId: result.actionId, nonce: result.nonce });
      } catch (err) {
        if (err?.code === 'review_expired') throw new Error('This confirm expired. Click Send again.');
        throw err;
      }
      await afterSent(m, body);
    },
  });
}

/**
 * A sent reply (`body`, the text that went): the box empties, its saved reply and Claude's draft
 * are deleted through the save queue (so no pending autosave, and no reload, brings the text
 * back), the carried text, Restore and the ⌘↩ arming go, and the status line says where it went.
 * Text typed while the send was in flight is not the sent text: it stays in the box and is saved
 * instead. The row stays where it is; no toast.
 */
async function afterSent(m, body) {
  const key = draftKeyOf(m);
  const field = document.getElementById('reply-body');
  const here = field?.closest('form')?.dataset.key === key;
  const live = here ? field.value : Object.hasOwn(state.replyCarry, key) ? state.replyCarry[key] : savedReply(snap(), m)?.data.text || '';
  // Compared without line-break style (the form sends CRLF, the box holds LF) or edge whitespace
  // (a re-drawn <textarea> drops a leading line break): only new words keep the box.
  const same = (a, b) => a.replace(/\r\n?/g, '\n').trim() === b.replace(/\r\n?/g, '\n').trim();
  const kept = same(live, body) ? '' : live;
  if (here && !kept) {
    field.value = '';
    field.defaultValue = '';
    syncReplyBox(field);
  }
  if (!kept) delete state.replyCarry[key];
  // Claude's draft that was sent is done with: the emptied box does not offer it again.
  const ai = latestDraft(snap(), key);
  state.drafts[key] = { ...draftUi(key), restore: null, confirm: null, baseline: null, changeFrom: null, ...(ai ? { kept: ai.revision } : {}) };
  state.replyTouched = null;
  showReplyStatus(key, { text: `Sent to ${sendTarget(snap(), m) || 'the chat'}.`, url: m.data.url });
  try {
    await queueReplySave(m, kept);
    if (kept && here && field.value === kept) field.defaultValue = kept;
    await queueDraftDelete(key);
  } catch (err) {
    fail(err);
  }
  if (!modalOpen()) await render();
}

/** Deletes Claude's stored draft for a conversation, in turn with the reply saves (`queueReplySave`). */
function queueDraftDelete(key) {
  const run = replySaving.then(async () => {
    for (const r of records(snap(), 'draft').filter(d => d.data.aiSuggested && (d.data.draftKey === key || d.id === `ai:${key}`))) {
      await store.mutate('local_delete', { kind: 'draft', id: r.id });
    }
  });
  replySaving = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- events

// The Meetings list: right-click a row for its menu (Open, Hide, Show in calendar), kept inside
// the window; a click anywhere but an action closes it (an action closes it by itself).
document.addEventListener('contextmenu', ev => {
  const row = ev.target.closest?.('#workspace-app .ws-mtg-row[data-id]');
  if (!row || !meetingsUi) return;
  ev.preventDefault();
  const x = Math.max(8, Math.min(ev.clientX, window.innerWidth - 280));
  const y = Math.max(8, Math.min(ev.clientY, window.innerHeight - 180));
  meetingsUi.contextMenu(row.dataset.id, x, y).catch(fail);
});
document.addEventListener('click', ev => {
  if (!state.meetings.rowMenu || ev.target.closest?.('.ws-mtg-rowmenu')) return;
  state.meetings.rowMenu = null;
  // After the click's own action and default (a menu opening, a switch) have run.
  setTimeout(() => render().catch(fail), 0);
});

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-action]');
  if (!el || !el.closest('#workspace-app,.ws-modal,#cm-sheet-host,#ws-capture-host')) return;
  if (el.matches('input[type=checkbox],input[type=radio],select')) return;
  ev.preventDefault();
  if (el.disabled) return;
  const keepFocus = KEEP_FOCUS.has(el.dataset.action);
  if (!keepFocus) el.disabled = true;
  try {
    await handle(el.dataset.action, el, ev);
  } catch (err) {
    fail(err);
  } finally {
    el.disabled = false;
    // The reply's Send and Copy follow their box (text, a send in flight), not the click.
    if (el.hasAttribute('data-needs-text')) syncReplyBox(document.getElementById('reply-body'));
  }
});

document.addEventListener('change', async ev => {
  const el = ev.target;
  // Where the control is, read now: a field that changes as its panel closes (the task drawer on
  // Escape or Close) is gone from the page by the time the CodeMie check below answers.
  const inApp = !!el.closest?.('#workspace-app');
  try {
    if (el.closest?.('#workspace-app,.ws-modal,#cm-sheet-host') && await codemie.change(el)) return;
    if (el.matches('[data-action]') && (el.type === 'checkbox' || el.tagName === 'SELECT') && el.closest('#workspace-app,.ws-modal')) {
      await handle(el.dataset.action, el);
    } else if (el.dataset?.change && inApp) {
      // Fields that save when they change (the task drawer's title, due date and notes).
      await handle(el.dataset.change, el);
    }
  } catch (err) {
    fail(err);
    await render();
  }
});

document.addEventListener('submit', async ev => {
  // The capture bar adds on its keys and its Add button, never by a form submission.
  if (ev.target.closest?.('.ws-capture')) return ev.preventDefault();
  // The Ask boxes ask on their own Enter and button, never by a form submission.
  if (ev.target.closest?.('.ws-ask-field,.ws-ask-page-box')) return ev.preventDefault();
  const form = ev.target.closest('form[data-form]');
  if (!form || !form.closest('#workspace-app')) return;
  ev.preventDefault();
  // The reply form never sends on submit (implicit submission from Enter in a field); its Send
  // is a plain button handled by the click handler and ⌘↩.
  if (form.dataset.form === 'reply') return;
  const buttons = [...form.querySelectorAll('button[type=submit]')];
  buttons.forEach(b => { b.disabled = true; });
  try {
    await submitForm(form);
  } catch (err) {
    fail(err);
  } finally {
    buttons.forEach(b => { b.disabled = false; });
    if (form.dataset.form === 'reply') syncReplyBox(document.getElementById('reply-body'));
  }
});

document.addEventListener('input', ev => {
  if (codemie.input(ev.target)) return;
  // Settings › Your voice: what is typed in its editors is kept in its view state (no render).
  if (ev.target.matches?.('[data-voice-input]')) {
    voiceUi?.input(ev.target);
    return;
  }
  if (ev.target.matches?.('[data-settings-find]') && !ev.isComposing) {
    state.settingsQuery = ev.target.value;
    render().catch(fail);
    return;
  }
  if (ev.target.id === 'inbox-search') {
    state.search = ev.target.value;
    clearTimeout(searchTimer);
    const pos = ev.target.selectionStart;
    searchTimer = setTimeout(async () => {
      state.selectedMessage = null;
      closeRow();
      await render();
      const input = document.getElementById('inbox-search');
      input?.focus();
      input?.setSelectionRange(pos, pos);
    }, 220);
  }
  if (ev.target.id === 'tasks-search') {
    state.tasks.filters.q = ev.target.value;
    clearTimeout(taskSearchTimer);
    const pos = ev.target.selectionStart;
    taskSearchTimer = setTimeout(async () => {
      await render();
      const input = document.getElementById('tasks-search');
      input?.focus();
      input?.setSelectionRange(pos, pos);
    }, 220);
  }
  if (ev.target.id === 'analytics-search') {
    state.analytics.q = ev.target.value;
    clearTimeout(analyticsSearchTimer);
    const pos = ev.target.selectionStart;
    analyticsSearchTimer = setTimeout(async () => {
      state.analytics.shown = SESSIONS_PAGE;
      await render();
      const input = document.getElementById('analytics-search');
      input?.focus();
      input?.setSelectionRange(pos, pos);
    }, 220);
  }
  if (ev.target.id === 'meetings-search' || ev.target.id === 'meeting-transcript-search') {
    const which = ev.target.id;
    if (which === 'meetings-search') state.meetings.q = ev.target.value;
    else state.meetings.tq = ev.target.value;
    clearTimeout(meetingSearchTimer);
    const pos = ev.target.selectionStart;
    meetingSearchTimer = setTimeout(async () => {
      await render();
      const input = document.getElementById(which);
      input?.focus();
      input?.setSelectionRange(pos, pos);
    }, 220);
  }
  if (ev.target.id === 'today-gallery-search') {
    const value = ev.target.value;
    clearTimeout(gallerySearchTimer);
    gallerySearchTimer = setTimeout(() => todayUi.handle('today-gallery-search', { dataset: {}, value }).catch(fail), 150);
  }
  if (meetingsUi?.input(ev.target)) return;
  if (meetingsSettingsUi?.input(ev.target)) return;
  if (ev.target.id === 'reply-body') {
    syncReplyBox(ev.target);
    // "Saved on this device" holds only until the text changes again.
    const key = ev.target.closest('form')?.dataset.key;
    if (key && state.replyStatus[key]) showReplyStatus(key, '');
    // Autosave on this device 1.5 s after the last keystroke.
    clearTimeout(replySaveTimer);
    replySaveTimer = setTimeout(flushReplySave, 1500);
  }
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

// The reply box counts as the user's once they click or type in it (the ⌘↩ gate); a box the app
// focused (Today's Draft reply, a draft arriving) does not.
const touchReply = target => {
  const key = target?.id === 'reply-body' ? target.closest('form')?.dataset.key : null;
  if (key) state.replyTouched = key;
};
document.addEventListener('pointerdown', ev => touchReply(ev.target), true);
document.addEventListener('keydown', ev => {
  if (ev.metaKey || ev.ctrlKey || !(ev.key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(ev.key))) return;
  touchReply(ev.target);
}, true);

// ⌘↩ in the Inbox runs the visible Send as a click would (DESIGN 6.4), only once the user has
// clicked or typed in this reply box, never on a held key, and never with a confirm, popover,
// sheet or menu open. Otherwise it does nothing. The change line and the draft popover keep
// their own ⌘↩ (they handle it first, in capture).
document.addEventListener('keydown', ev => {
  if (!ready || state.route !== 'inbox' || ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey) || ev.isComposing) return;
  if (ev.defaultPrevented) return;
  ev.preventDefault();
  const form = root.querySelector('form[data-form="reply"]');
  const m = form && getRecord('message', form.dataset.id);
  const send = form?.querySelector('[data-action="reply-send"]');
  if (!m || !send || send.disabled) return;
  const blocked = modalOpen() || sheetOpen() || !!state.draftPopover || !!document.querySelector('details.ws-menu[open]');
  if (!sendKeyAllowed({ touchedKey: state.replyTouched, key: form.dataset.key, repeat: ev.repeat, blocked, primaryKind: primaryAction(snap(), m).kind })) return;
  handle('reply-send', send).catch(fail).finally(() => syncReplyBox(document.getElementById('reply-body')));
});

// The change line: Return sends the words (never the reply form), Esc empties a field with words
// in it and goes no further; an empty field lets Esc through to the row.
document.addEventListener('keydown', ev => {
  if (ev.target?.id !== 'reply-change' || ev.isComposing || ev.keyCode === 229) return;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (!ev.target.disabled) handle('ai-draft-change', ev.target).catch(fail);
  } else if (ev.key === 'Escape' && ev.target.value) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    ev.target.value = '';
  }
}, true);

// Settings › Your voice: Esc in its style card or instruction editor cancels it and puts focus
// back on Edit or Add (design § Accessibility).
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape' || ev.isComposing || modalOpen() || !ev.target?.closest?.('.ws-voice-editor,.ws-voice-rule-editor')) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  voiceUi?.cancel().catch(fail);
}, true);

// A box the user leaves saves its text at once.
document.addEventListener('focusout', ev => {
  if (ev.target?.id === 'reply-body') flushReplySave(ev.target);
});

// A hidden window saves the reply typed in it at once.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushReplySave();
});

// The draft options popover: Esc closes it, ⌘↵ drafts, Tab stays inside it.
document.addEventListener('keydown', ev => {
  const pop = state.draftPopover && document.getElementById('draft-options');
  if (!pop || modalOpen() || sheetOpen()) return;
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
  if (ev.button === 0) pressing = true;
  if (state.draftPopover && !ev.target.closest('#draft-options, [data-action="ai-draft-options"]')) closeDraftPopover(false);
}, true);
// The click lands first; the updates held while the button was down render after it.
const released = () => {
  if (!pressing) return;
  pressing = false;
  setTimeout(() => {
    if (askHeld) {
      askHeld = false;
      if (ready && !modalOpen()) {
        const held = askFocusHeld;
        askFocusHeld = null;
        return render().then(() => {
          const el = held && document.querySelector(held.selector);
          el?.focus({ preventScroll: true });
          if (held?.select) el?.select?.();
        }).catch(fail);
      }
    }
    askFocusHeld = null;
    if (heldRender && !taskDrag) flushHeldRender();
    return undefined;
  }, 0);
};
document.addEventListener('mouseup', released, true);
window.addEventListener('blur', released);
document.addEventListener('dragstart', released, true);
window.addEventListener('resize', placeDraftPopover);
window.addEventListener('resize', measureToday);
document.addEventListener('scroll', placeDraftPopover, true);

// A `<summary>` marked `aria-disabled` (e.g. "Pin a summary" at four pins) has no native
// `disabled`: Enter/Space would otherwise still toggle it open. Block the key before it can.
document.addEventListener('keydown', ev => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target?.matches?.('summary[aria-disabled="true"]')) ev.preventDefault();
});

// ⋯ and the other ws-menu menus: one open at a time; a click anywhere else closes it, and so
// does Escape, which puts focus back on its button.
document.addEventListener('toggle', ev => {
  const menu = ev.target;
  if (!menu.matches?.('details.ws-menu') || !menu.open) return;
  // A disabled opener (same reason as above: assistive tech can still activate it) closes again
  // at once rather than showing a menu nothing should have been able to open.
  if (menu.querySelector(':scope > summary[aria-disabled="true"]')) {
    menu.removeAttribute('open');
    return;
  }
  for (const other of document.querySelectorAll('details.ws-menu[open]')) if (other !== menu) other.removeAttribute('open');
  if (menu.closest('.ws-reply-bar')) placeReplyMenu(menu);
  if (menu.matches('.ws-mtg-strip > .ws-menu')) fitSectionMenu(menu);
}, true);

/** The meeting's ⋯ is long: it scrolls inside its section rather than run past the section's
 *  bottom, which clips it. */
function fitSectionMenu(menu) {
  const panel = menu.querySelector('.ws-menu-panel');
  const pane = menu.closest('.ws-pane')?.getBoundingClientRect();
  const summary = menu.querySelector('summary')?.getBoundingClientRect();
  if (!panel || !pane || !summary) return;
  panel.style.maxHeight = `${Math.max(160, Math.floor(Math.min(pane.bottom, innerHeight) - summary.bottom - 14))}px`;
}

/** The reply's action line sits at the bottom of a scrolling pane: its menus open downwards, or
 *  upwards when only that way they fit in the pane. */
function placeReplyMenu(menu) {
  menu.classList.remove('ws-menu-up');
  const panel = menu.querySelector('.ws-menu-panel');
  const summary = menu.querySelector('summary')?.getBoundingClientRect();
  if (!panel || !summary) return;
  const pane = menu.closest('.ws-reader, .ws-inbox-items')?.getBoundingClientRect() || { top: 0, bottom: innerHeight };
  const below = Math.min(pane.bottom, innerHeight) - summary.bottom;
  const above = summary.top - Math.max(pane.top, 0);
  const need = panel.offsetHeight + 6;
  if (below < need && above > below) menu.classList.add('ws-menu-up');
}
document.addEventListener('click', ev => {
  for (const menu of document.querySelectorAll('details.ws-menu[open]')) if (!menu.contains(ev.target)) menu.removeAttribute('open');
}, true);
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape' || ev.isComposing || ev.target?.closest?.('.ws-term')) return;
  const menu = document.querySelector('details.ws-menu[open]');
  if (!menu || (modalOpen() && !menu.closest('.ws-modal'))) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  menu.removeAttribute('open');
  menu.querySelector('summary')?.focus();
}, true);

// Tasks: Escape closes quick add, then the drawer; Enter adds a quick task or leaves the drawer's
// title or typed due date (which then saves).
document.addEventListener('keydown', ev => {
  if (!ready || !['tasks', 'meetings'].includes(state.route) || modalOpen() || sheetOpen() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const field = document.activeElement?.closest?.('#workspace-app') ? document.activeElement : null;
  if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229 && field?.dataset?.commit) {
    ev.preventDefault();
    field.blur();
    return;
  }
  if (state.route === 'meetings') {
    // Escape leaves the document editor (asking first when the edit isn't saved).
    if (ev.key === 'Escape' && !ev.isComposing && field?.id === 'meeting-doc-editor' && state.meetings.editing) {
      ev.preventDefault();
      meetingsUi.handle('doc-edit-cancel', { dataset: { id: state.meetings.editing.meetingId, doc: state.meetings.editing.docId } }).catch(fail);
    }
    return;
  }
  // A drawer field being edited saves (on its change or when it is left) before the drawer closes.
  if (ev.key === 'Escape' && (field?.dataset?.change || field?.dataset?.commit)) field.blur();
  tasksUi.key(ev).catch(fail);
});

// Analytics: Escape closes the session drawer (an open menu has closed first, above).
document.addEventListener('keydown', ev => {
  if (!ready || state.route !== 'analytics' || modalOpen() || sheetOpen()) return;
  analyticsUi.key(ev).catch(fail);
});

// Settings › Meetings: Enter saves a typed field (a rule's text, a column name, a file path) by
// leaving it, as on the Tasks page. A Markdown editor keeps Enter for new lines.
document.addEventListener('keydown', ev => {
  if (!ready || state.route !== 'settings' || modalOpen() || sheetOpen() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const field = document.activeElement?.closest?.('#workspace-app') ? document.activeElement : null;
  if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229 && field?.tagName === 'INPUT' && field.dataset.commit) {
    ev.preventDefault();
    field.blur();
  }
});

// Today: ⌘Z undoes the last layout change and ⇧⌘Z redoes it, outside text fields, as the edit
// bar's Undo and Redo do (locked, they say so instead).
document.addEventListener('keydown', ev => {
  if (!ready || state.route !== 'today' || modalOpen() || sheetOpen() || editing() || ev.altKey || !(ev.metaKey || ev.ctrlKey) || ev.key.toLowerCase() !== 'z') return;
  ev.preventDefault();
  todayUi.handle(ev.shiftKey ? 'today-redo' : 'today-undo').catch(fail);
});

// A field that saves when it is left (the drawer's typed due date): one save, with what it holds.
document.addEventListener('focusout', ev => {
  const el = ev.target;
  if (!el.dataset?.commit || !el.closest?.('#workspace-app')) return;
  handle(el.dataset.commit, el).catch(err => {
    fail(err);
    render().catch(() => {});
  });
});

document.addEventListener('keydown', ev => {
  if (!ready || modalOpen() || sheetOpen() || editing() || state.draftPopover || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  // Esc on the Ask page (not in a box with words, an open ⋯ having taken it already): Back.
  if (state.route === 'ask' && ev.key === 'Escape' && !ev.isComposing && !state.capture.open
    && !ev.target.closest?.('.ws-ask-field,.ws-ask-page-box,.ws-term') && !(ev.target.matches?.('input,textarea') && ev.target.value)) {
    ev.preventDefault();
    askUi?.back().catch(fail);
    return;
  }
  if (state.route === 'calendar') {
    const keys = { t: () => setCalendar(todayDate()), ArrowLeft: () => stepCalendar(-1), ArrowRight: () => stepCalendar(1), d: () => setCalendar(state.calendarDate, 'day'), w: () => setCalendar(state.calendarDate, 'week'), m: () => setCalendar(state.calendarDate, 'month'), a: () => setCalendar(state.calendarDate, 'agenda') };
    // ←/→ on a divider, a section tab or a widget grip move that, not the week.
    if (ev.key.startsWith('Arrow') && ev.target.closest?.('.ws-split, [role=tab], .ws-tile-grip')) return;
    if (keys[ev.key]) {
      ev.preventDefault();
      keys[ev.key]().catch(fail);
    }
  } else if (state.route === 'meetings') {
    meetingsUi.key(ev).catch(fail);
  } else if (state.route === 'inbox' && ['ArrowDown', 'ArrowUp', 'j', 'k'].includes(ev.key)) {
    const rows = [...root.querySelectorAll('.ws-inbox-row')];
    if (!rows.length) return;
    const index = rows.findIndex(r => r.dataset.id === state.selectedMessage);
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + (['ArrowDown', 'j'].includes(ev.key) ? 1 : -1)))];
    ev.preventDefault();
    // In Compact the focus follows the selection to its row's line, so ↵ next acts on that row
    // and not on the control that had the focus (Default keeps its focus where it was).
    const moved = selectMessage(next.dataset.id);
    (compactView() ? moved.then(() => root.querySelector(`.ws-inbox-row[data-id="${CSS.escape(next.dataset.id)}"]`)?.focus({ preventScroll: true })) : moved).catch(fail);
  } else if (state.route === 'inbox' && compactView() && ev.key === 'Enter' && state.selectedMessage
    && !ev.target.closest?.('button, a, summary, input, select, textarea, [contenteditable]')) {
    // ↵ opens the selected row (a focused control keeps its own Enter: a row button toggles once).
    ev.preventDefault();
    moveRows(enterRow({ selected: state.selectedMessage, open: state.openMessage })).catch(fail);
  } else if (state.route === 'inbox' && compactView() && ev.key === 'Escape' && state.openMessage) {
    // Esc closes the open row (an open ⋯ menu has already taken Escape for itself).
    ev.preventDefault();
    // Focus inside the closing row goes back to its line, not to the page.
    const openId = state.openMessage;
    const inside = root.querySelector('.ws-crow-body')?.contains(document.activeElement);
    moveRows(escRow({ selected: state.selectedMessage, open: openId }))
      .then(() => { if (inside) root.querySelector(`.ws-inbox-row[data-id="${CSS.escape(openId)}"]`)?.focus({ preventScroll: true }); })
      .catch(fail);
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
// Tasks is drawn again once the day it was drawn on has passed (By date's Late, Today and the
// dates its menus offer), when nothing is open or being typed in.
function scheduleMinuteRender() {
  clearTimeout(minuteTimer);
  minuteTimer = setTimeout(async () => {
    const tasksDue = state.route === 'tasks' && tasksDrawnDay && store?.get() && dayKey(Date.now(), snap().settings.timeZone) !== tasksDrawnDay;
    if (ready && (['today', 'calendar', 'automations', 'meetings', 'analytics'].includes(state.route) || tasksDue) && !modalOpen() && !editing()) await render().catch(() => {});
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
      if (compactView()) Object.assign(state, { openMessage: m.id, openKey: messageKey(m) });
    }
    return route('inbox');
  }
  if (payload.eventId) {
    await route('calendar');
    return eventDialog(getRecord('event', payload.eventId));
  }
  // Notes made by themselves (and anything else about a meeting): the meeting.
  if (payload.meetingId) return meetingsUi.open(payload.meetingId);
  // A menu row, a fix, or a notification naming the page it opens (design §6 "Opening from the
  // menu"): tasks due today, the chat lane in Inbox, more than one new meeting, a settings tab,
  // or Automations (that run, when named, else the Run log).
  const target = openTarget(payload);
  if (target) {
    switch (target.route) {
      case 'inbox':
        if (target.lane) state.lane = target.lane;
        return route('inbox');
      case 'tasks': return route('tasks');
      case 'meetings': return route('meetings');
      case 'settings': return route('settings', target.tab);
      case 'automations':
        return target.runId ? automationsUi.openRun(target.runId, target.automationId || '') : route('automations', 'runs');
    }
  }
  // An automation's result or failure named by `runId` alone (an older notification shape).
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
  if (codemie.busy()) {
    if (!recoveryDeferred) toast(err?.message || String(err), 'error');
    recoveryDeferred = true;
    return undefined;
  }
  ready = false;
  recovering = (async () => {
    document.querySelectorAll('.ws-modal[open]').forEach(d => d.close());
    const status = await invoke('storage_status').catch(() => null);
    recoveryView = { ...status, cause: err?.message || '' };
    renderRecovery();
  })();
  return recovering;
}

function renderRecovery() {
  // Plugin frames lie in their own layer above the page: none may stay over the recovery card.
  pluginHost?.show(null);
  // Nor may the CodeMie setup sheet: it closes (stopping a setup that waits on the person).
  codemie.closeSheet().catch(() => {});
  document.querySelector('#cm-sheet-host .cm-sheet')?.remove();
  document.querySelector('.ws-plugin-layer')?.removeAttribute('inert');
  root.inert = false;
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
  // CODEMIE_TOUR (a tour build only): the app boots on the tour's seeded folder, without the
  // CodeMie CLI, the setup sheet or the update check, then walks the tour's stops and reports.
  const tour = flags.tour ? await import('./tour/runner.js') : null;
  const tourOps = [];
  const tourRefused = [];
  const tourAllow = new Set();
  if (tour) tourGated = tour.gate(appInvoke, { ops: tourOps, refused: tourRefused, allow: tourAllow });
  if (flags.plugin === 'isolation') {
    const { runIsolationSmoke } = await import('../plugins/isolation-smoke.js');
    return runIsolationSmoke(invoke, { runId: flags.plugin_run_id });
  }
  // CODEMIE_PLUGIN_SMOKE=<marketplace folder>: the app boots as usual on the smoke's own data root,
  // then runs the marketplace smoke (ui/plugins/market-smoke.js) and quits.
  const marketSmoke = flags.plugin && flags.plugin !== 'isolation' ? flags.plugin : null;
  // CODEMIE_STATUS_SMOKE=status|live: the app boots as usual, then reports (status-smoke.js) and quits.
  const statusSmoke = ['status', 'live'].includes(flags.status) ? flags.status : null;
  if (flags.smoke || flags.probe) {
    root.classList.add('hidden');
    legacy.classList.remove('hidden');
    legacyModule = await import('../renderer.js');
    await legacyModule.initLegacyTools();
    return;
  }
  const hash = location.hash.split('/');
  let useFirstVisible = false;
  if (hash[1] === 'p' && PLUGIN_ID.test(hash[2] || '') && PLUGIN_ITEM.test(hash[3] || '')) {
    state.route = 'plugin';
    state.pluginPage = { id: hash[2], activity: hash[3], route: hash.slice(4).join('/') };
  } else {
    const target = parseHash(location.hash);
    if (target.route) state.route = target.route;
    else useFirstVisible = true;
    // The hash's pane is the meeting's; with none, the setting decides once the snapshot is in.
    if (target.route === 'meetings') {
      if (target.meetingId) state.meetings.selected = target.meetingId;
      state.meetings.pane = target.pane;
      // A boot hash is always a link arrival; `ensureSelection`'s first render reads this to
      // decide whether an old `/tasks` link may move focus to the column (it can't check the
      // column setting yet here, before the snapshot is in).
      state.meetings.tasksLink = target.pane === 'tasks';
    } else if (state.route === 'ask') state.ask.threadId = askThreadOf(hash[2]);
    else if (hash[2] && state.route === 'automations') showAutomationsTab(hash[2]);
    else if (hash[2]) state.settingsTab = settingsTabFor(hash[2]);
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
  // No route in the hash (an empty one, or home): land on the first page the menu shows, not
  // necessarily Today, now that a page can be hidden.
  if (useFirstVisible) state.route = firstVisiblePage(snap().settings.hiddenPages);
  await bootWorkspace(store, snap());
  state.appVersion = await invoke('get_app_version').catch(() => '');
  // Plugin UIs: one sandboxed frame per enabled plugin with a client half, in a layer outside the
  // page the app redraws. A dev build may serve the frames from elsewhere (`pluginFrameBase`, the
  // browser E2E's stand-in for the connect-plugin scheme).
  const frameUrl = flags.dev && typeof flags.pluginFrameBase === 'string'
    ? (id, path) => `${flags.pluginFrameBase}${pluginUrl(id, path, { macos: true }).slice('connect-plugin://'.length)}`
    : pluginUrl;
  // The marketplace smoke keeps what the frames ask their host halves, and how it went.
  const smokeCalls = [];
  const smoke = marketSmoke ? await import('../plugins/market-smoke.js') : null;
  pluginHost = createPluginHost({
    invoke: smoke ? smoke.recordCalls(invoke, smokeCalls) : invoke,
    frameUrl,
    about: () => ({ name: 'CodeMie Connect', version: state.appVersion, engine: '1.0' }),
    theme: () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    // A meeting's page is Echo's call page (`calls`) for plugins.
    whereNow: () => ({ view: state.route === 'meetings' && pluginCall ? 'calls' : state.route, section: state.route === 'settings' ? state.settingsTab : '', route: '' }),
    onChange: pluginsChanged,
    onGo: hash => { goHash(hash).catch(fail); },
    onNotice: (text, name) => toast(`${name}: ${text}`),
    onCopy: text => navigator.clipboard.writeText(text).then(() => toast('Copied.', 'success'), fail),
    onOpen: confirmPluginLink,
    confirmSkill: confirmPluginSkill,
    onSlots: () => { if (state.route === 'meetings') pluginsChanged(); },
    onCall: folder => openMeetingFolder(folder),
  }).mount(document.body);
  // Connect's terminal: Claude Code sessions (a plugin's "Ask the vault", a coding agent) in a
  // dock under the page, outside what the app redraws.
  terminalDock = createTerminalDock({
    invoke, listen: (name, fn) => window.__TAURI__.event.listen(name, fn), Terminal, FitAddon,
    confirmStop: confirmTerminalStop, toast, onLayout: terminalLayout,
  });
  terminalDock.mount(document.body).catch(() => {});
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
    if (!editing()) render().catch(fail);
    flushNotification();
  });
  store.subscribe(result => {
    applyTheme(result.snapshot.settings.theme);
    applyView(viewOf(result.snapshot.settings));
    if (!ready) return;
    // A run started, ended or was stored: the Run log reads its newest page again.
    automationsUi.snapshotChanged(result.snapshot)?.catch(() => {});
    // A draft that arrived for the open reply box is applied first, whatever is on screen.
    const arrived = applyArrivedDraft(result.snapshot);
    refreshEventDialog();
    if (modalOpen()) return;
    if (state.draftPopover || taskDrag || layoutDrag || pressing) {
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
  // CodeMie reads the CLI in the background; the workspace does not wait for it. The marketplace
  // smoke runs on its own data root and tests plugins only: it runs no CodeMie CLI command.
  // The status smoke says whether the first-launch sheet would open: the prefs before boot decide.
  const setupBefore = statusSmoke ? codemie.prefs() : null;
  const codemieBooted = marketSmoke || tour ? null : codemie.boot().catch(fail);
  await render();
  if (aiTabOpen()) loadAi().catch(fail);
  if (generalTabOpen()) loadStorage().catch(fail);
  if (runLogOpen()) automationsUi.loadRuns().catch(fail);
  if (state.route === 'settings' && state.settingsTab === 'plugins') pluginsUi.load().catch(fail);
  if (state.route === 'analytics') analyticsUi.open().catch(fail);
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
  // The plugin manager finished a reload: what loaded and what didn't (and why) is read again, so
  // frames, sidebar pages and "Didn’t load" follow without reopening Settings.
  await listen('plugins:reloaded', () => { if (!recovering) pluginsUi.loadInstalled().catch(() => {}); });
  await listen('workspace:quit-request', async () => {
    if (state.updateBusy) return toast('The update is in progress. Keep Connect open until it finishes.');
    if (legacyModule) await legacyModule.leaveLegacyTools();
    return codemie.onQuitRequest();
  });
  await listen('workspace:notification-open', event => openNotification(event.payload || {}).catch(fail));
  await listen('workspace:installer-settled', flushNotification);
  await listen('plugins:ask-address', event => askPluginAddress(event.payload || {}));
  // Files dropped on a plugin's page (its `ctx.onFileDrop`): Rust makes handles of that plugin's,
  // and the page gets those, never the paths.
  await listen('tauri://drag-drop', event => {
    const shown = pluginHost?.shown();
    const paths = Array.isArray(event.payload?.paths) ? event.payload.paths.filter(p => typeof p === 'string').slice(0, 50) : [];
    if (state.route !== 'plugin' || shown?.view !== 'activity' || !paths.length) return;
    invoke('plugins_request', { op: 'frame_files', data: { id: shown.id, paths } })
      .then(files => { if (pluginHost?.shown()?.id === shown.id) pluginHost.dropFiles(shown.id, files); })
      .catch(fail);
  });
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
    syncTasks();
    // Back from Terminal or another app: an agent or app may have changed.
    if (!marketSmoke && !tour) codemie.onFocus();
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
  if (flags.dev) window.__workspace = { store, state, route, render, ensureClaudeChoice, withClaudeChoice, codemie, meetingsUi };
  if (tour) {
    const report = await tour.runTour({
      invoke, goHash, store, mutate, voice: voiceUi, doc: document, raf: fn => requestAnimationFrame(fn),
      only: flags.tour, runId: flags.tour_run_id, ops: tourOps, refused: tourRefused, allow: tourAllow,
    });
    // Rust adds its view, writes the verdict and quits.
    return invoke('tour_report', { report });
  }
  if (smoke) {
    const report = await smoke.runMarketSmoke({
      invoke, market: marketSmoke, runId: flags.plugin_run_id, host: pluginHost, calls: smokeCalls,
      refreshInstalled: async () => { await pluginsUi.loadInstalled(); return state.installedPlugins; },
      go: hash => goHash(hash),
      frameOf: id => document.querySelector(`iframe[data-plugin-frame="${CSS.escape(id)}"]`),
    });
    // Rust writes the verdict and quits.
    return invoke('smoke_plugins_report', { report });
  }
  if (statusSmoke) {
    const { runStatusSmoke, recordOps, setupFacts } = await import('./status-smoke.js');
    const ops = [];
    const report = await runStatusSmoke({
      invoke, store: createStore(recordOps(watched, ops)), ops, mode: statusSmoke,
      runId: flags.status_run_id, since: flags.status_started_at, ai: () => state.ai, hidden: hiddenCalendars,
      setup: async () => {
        const started = Date.now();
        const booted = await Promise.race([codemieBooted.then(() => true), new Promise(resolve => setTimeout(resolve, 120_000, false))]);
        const facts = setupFacts(codemie.service.state, setupBefore, codemie.prefs(), !!codemie.sheet());
        return { ...facts, booted, bootWaitMs: Date.now() - started };
      },
    });
    // Rust adds its view, writes the verdict and quits.
    return invoke('smoke_status_report', { report });
  }
  if (!tour && shouldCheckForAppUpdate(localPref(`codemie.app.lastUpdateCheck.${state.appVersion}`, null))) checkAppUpdate().catch(() => {});
}

boot().catch(err => {
  window.__bootError = String(err?.stack || err);
  fail(err);
});
