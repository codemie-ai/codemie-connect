// The Settings menu: groups that fold, the menu shrunk to icons, Find a setting, and the Layout page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settings, SETTINGS_TABS } from '../workspace/view-settings.js';
import { layoutPanel } from '../workspace/settings-layout.js';
import { NAV } from '../workspace/shell.js';
import { PRESETS } from '../workspace/today-grid.js';
import { normalizeDock } from '../workspace/dock-model.js';
import { INBOX_DOCK } from '../workspace/view-inbox.js';
import { CALENDAR_DOCK } from '../workspace/view-calendar.js';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';

const NOW = Date.UTC(2026, 10, 19, 9);
const s = buildSnapshot(NOW, { photo: false, zone: 'UTC' });
const menu = (patch = {}) => ({ folded: [], collapsed: false, width: 272, query: '', ...patch });
const page = (tab, m = {}, extra = {}) => settings(s, { state: { settingsTab: tab }, auth: {}, now: NOW, menu: menu(m), ...extra });
const nav = html => html.match(/<nav class="ws-settings-nav"[^]*?<\/nav>/)[0];
const group = (html, name) => nav(html).match(new RegExp(`<button[^>]*data-group="${name}"[^>]*>[^]*?</button>`))?.[0] || '';
const drawn = (html, id) => new RegExp(`data-action="settings-tab" data-tab="${id}"`).test(nav(html));

test('a folded group hides its items but keeps the current one, with its count', () => {
  const html = page('meetings-templates', { folded: ['Meetings'] });
  assert.match(group(html, 'Meetings'), /aria-expanded="false"/);
  assert.match(group(html, 'Meetings'), /<small class="ws-count">5<\/small>/);
  assert.ok(drawn(html, 'meetings-templates'), 'the current page stays');
  assert.ok(!drawn(html, 'meetings-rules'), 'the others fold away');
  assert.ok(drawn(html, 'general'), 'other groups stay open');
});

test('an open group has aria-expanded true and controls its items', () => {
  const html = page('general');
  const g = group(html, 'Workspace');
  assert.match(g, /data-action="settings-group"/);
  assert.match(g, /aria-expanded="true"/);
  const id = g.match(/aria-controls="([^"]+)"/)[1];
  assert.match(nav(html), new RegExp(`id="${id}"`));
  assert.doesNotMatch(g, /ws-count/, 'an open group shows no count');
});

test('a folded group shows a dot when a hidden tab needs attention', () => {
  const tabDots = new Set(['cm-health']);
  const folded = page('general', { folded: ['CodeMie'] }, { codemie: { tabDots, panel: () => '', headerActions: () => '' } });
  assert.match(group(folded, 'CodeMie'), /ws-dot-alert/);
  assert.ok(!drawn(folded, 'cm-health'));
  const open = page('general', {}, { codemie: { tabDots, panel: () => '', headerActions: () => '' } });
  assert.doesNotMatch(group(open, 'CodeMie'), /ws-dot-alert/, 'open: the dot sits on the tab');
  assert.match(nav(open), /data-tab="cm-health"[^>]*>[^]*?ws-dot-alert/);
  // On the tab itself the group needs no second dot.
  assert.doesNotMatch(group(page('cm-health', { folded: ['CodeMie'] }, { codemie: { tabDots, panel: () => '', headerActions: () => '' } }), 'CodeMie'), /ws-dot-alert/);
});

test('search ignores folding and shows only matches', () => {
  const html = page('general', { folded: ['Meetings'], query: 'temp' });
  assert.ok(drawn(html, 'meetings-templates'));
  assert.equal((nav(html).match(/data-action="settings-tab"/g) || []).length, 1);
  assert.match(html, /placeholder="Find a setting"/);
  assert.match(html, /value="temp"/);
  // A group name matches all its items.
  const byGroup = page('general', { query: 'codemie' });
  assert.ok(drawn(byGroup, 'cm-health') && drawn(byGroup, 'cm-overview'));
  assert.match(page('general', { query: 'zzzz' }), /No setting matches/);
});

test('the shrunk menu draws icons with data-tip and no group names', () => {
  const html = page('general', { collapsed: true, folded: ['Meetings'] });
  assert.match(html, /ws-settings-sidebar ws-settings-rail/);
  assert.match(html, /--ws-settings-w:58px/);
  assert.doesNotMatch(nav(html), /ws-nav-group|>Workspace<|>CodeMie<|>Meetings</);
  for (const [, id, text] of SETTINGS_TABS) {
    assert.match(nav(html), new RegExp(`data-tab="${id}"[^>]*data-tip="${text.replace(/&/g, '&amp;')}"`), `${id} has a tip`);
  }
  assert.doesNotMatch(html, /data-action="settings-groups-all"/);
  assert.match(html, /data-action="settings-menu-toggle"[^>]*aria-expanded="false"/);
});

test('the menu edge is a separator with its width and a toggle button names the shortcut', () => {
  const html = page('general', { width: 320 });
  assert.match(html, /<div class="ws-settings-edge" role="separator" aria-orientation="vertical" tabindex="0"[^>]*aria-valuenow="320"[^>]*aria-valuemin="58"[^>]*aria-valuemax="400"/);
  assert.match(html, /--ws-settings-w:320px/);
  assert.doesNotMatch(page('general'), /--ws-settings-w/, 'the default width leaves the responsive CSS alone');
  assert.match(html, /data-action="settings-groups-all"[^>]*aria-label="Fold all groups"/);
  assert.match(page('general', { folded: SETTINGS_TABS.map(t => t[0]).filter(Boolean) }), /aria-label="Unfold all groups"/);
  assert.match(html, /data-action="settings-menu-toggle"[^>]*⌘⇧\\/);
});

test('Appearance shows the View card with Compact and Default', () => {
  const compact = { ...s, settings: { ...s.settings, view: 'compact' } };
  const html = settings(compact, { state: { settingsTab: 'appearance' }, auth: {}, now: NOW, menu: menu() });
  assert.match(html, /<h2 class="ws-card-title">[^]*?View<\/h2>/);
  assert.match(html, /data-action="view-set" data-view="compact" aria-selected="true">Compact/);
  assert.match(html, /data-action="view-set" data-view="default" aria-selected="false">Default/);
  assert.match(html, /Compact uses smaller text and opens messages in place\./);
});

test('Layout is the tab after Appearance', () => {
  const ids = SETTINGS_TABS.map(t => t[1]);
  assert.equal(ids[ids.indexOf('appearance') + 1], 'layout');
  assert.deepEqual(SETTINGS_TABS[ids.indexOf('layout')], ['', 'layout', 'Layout', 'layout']);
});

// ---------------------------------------------------------------- Settings → Layout

const defs = { inbox: INBOX_DOCK, calendar: CALENDAR_DOCK };
const grid = (active, layouts) => ({ active, items: PRESETS.Default.map(i => ({ ...i })), layouts, titles: {}, options: {}, hidden: [] });
const changedDefault = PRESETS.Default.map((i, n) => (n ? { ...i } : { ...i, w: 4 }));
const sample = (over = {}) => ({
  prefs: { locked: false, handles: 'hover', sidebarCollapsed: false, menuCollapsed: false },
  docks: { defs, layouts: { inbox: normalizeDock(INBOX_DOCK, null), calendar: normalizeDock(CALENDAR_DOCK, null) } },
  today: grid('Default', { Default: changedDefault, Mine: PRESETS.Focus.map(i => ({ ...i })) }),
  ...over,
});

test('Settings → Layout lists layouts with In use, Use, Reset and Delete, and each page with Reset', () => {
  const html = layoutPanel(s, sample());
  for (const title of ['Moving and resizing', 'Today layouts', 'Page layouts', 'Side menus', 'Keyboard']) assert.match(html, new RegExp(`>${title}<`));
  // The layout in use is marked; the others offer Use; changed built-ins offer Reset; own ones Delete.
  assert.match(html, /<strong>Default<\/strong>[^]*?In use/);
  assert.match(html, /data-action="today-layout-use" data-name="Mine"/);
  assert.match(html, /data-action="today-layout-use" data-name="Focus"/);
  assert.doesNotMatch(html, /data-action="today-layout-use" data-name="Default"/);
  assert.match(html, /data-action="today-layout-reset"[^>]*data-name="Default"/);
  assert.doesNotMatch(html, /data-action="today-layout-reset"[^>]*data-name="Focus"/);
  assert.match(html, /data-action="today-layout-delete"[^>]*data-name="Mine"/);
  assert.doesNotMatch(html, /data-action="today-layout-delete"[^>]*data-name="Default"/);
  // Each page: its sections, Open, Reset.
  assert.match(html, /Messages · Message/);
  for (const p of ['inbox', 'calendar']) {
    assert.match(html, new RegExp(`data-action="route" data-route="${p}"`));
    assert.match(html, new RegExp(`data-action="dock-reset"[^>]*data-page="${p}"`));
  }
});

test('Settings → Layout shows the preferences and the shortcuts', () => {
  const on = layoutPanel(s, sample({ prefs: { locked: true, handles: 'always', sidebarCollapsed: true, menuCollapsed: true } }));
  assert.match(on, /<input[^>]*checked[^>]*data-action="layout-lock"/);
  assert.match(on, /data-action="layout-handles" data-value="always" aria-pressed="true"/);
  assert.match(on, /data-action="layout-handles" data-value="hover" aria-pressed="false"/);
  assert.match(on, /On hover[^]*Always[^]*In Customize/);
  assert.match(on, /<input[^>]*checked[^>]*data-action="sidebar-toggle"/);
  assert.match(on, /<input[^>]*checked[^>]*data-action="settings-menu-toggle"/);
  const off = layoutPanel(s, sample());
  assert.doesNotMatch(off, /<input[^>]*checked[^>]*data-action="(layout-lock|sidebar-toggle|settings-menu-toggle)"/);
  assert.match(off, /⌘\\/);
  assert.match(off, /⌘⇧\\/);
});

test('Settings → Layout: the Menu card sits above Side menus with one switch per page; the last one is kept', () => {
  const hiddenPages = NAV.map(([id]) => id).filter(id => id !== 'inbox');
  const withHiddenPages = { ...s, settings: { ...s.settings, hiddenPages } };
  const html = layoutPanel(withHiddenPages, sample());
  assert.ok(html.indexOf('>Menu</h2>') < html.indexOf('>Side menus</h2>'));
  assert.equal([...html.matchAll(/data-action="menu-page"/g)].length, 7);
  assert.match(html, /Hidden pages leave the menu\. Links and notifications still open them\./);
  assert.match(html, /<span title="Keep one page in the menu\.">[^]*?data-page="inbox"[^>]*disabled/);
});

test('the Layout tab draws its panel in Settings', () => {
  const html = page('layout', {}, { layout: sample() });
  assert.match(html, /<h2>Layout<\/h2>/);
  assert.match(html, /Today layouts/);
});

test('Allow actions says a Teams reply goes on the click', () => {
  const html = page('microsoft');
  assert.match(html, /Connect reads only by default\. Turn on an action and Microsoft asks you to approve it once\. Nothing is sent without your click\./);
  assert.match(html, /Send Outlook replies from Connect\. You see To, Cc and the subject before each one goes\./);
  assert.match(html, /Send Teams replies from Connect when you click Send\. They go at once\./);
  assert.doesNotMatch(html, /Every action is shown for review before anything is sent/);
});
