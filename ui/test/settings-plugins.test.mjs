// Settings → Plugins, the sidebar's Plugins group and plugins on Today (DESIGN 7.1–7.3), from the
// real `plugins_request` answers (ui/test/fixtures/contract/plugins-*.json, written by Rust).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sheetList, orderSheet, agreement, consentBody, pluginsPanel, offerDetail, installedDetail, pluginsPage,
  createPluginsController, UNVERIFIED, KNOWLEDGE_LATER, PROXY_NOTE,
} from '../workspace/settings-plugins.js';
import { pluginNav, renderShell } from '../workspace/shell.js';
import { tileDefs, today } from '../workspace/view-today.js';
import { gallery } from '../workspace/today-edit-view.js';
import { pluginWidgetCatalog, pluginWidgetCard, pluginsCard, showPluginsCard, heldText, parseLayoutId } from '../workspace/today-plugins.js';
import { settings } from '../workspace/view-settings.js';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';

const contract = name => JSON.parse(readFileSync(new URL(`./fixtures/contract/${name}.json`, import.meta.url), 'utf8'));
const HOSTILE = '<img src=x onerror="alert(1)">';
const escaped = html => !html.includes('<img src=x') && !html.includes('onerror="alert');

const readyUi = (extra = {}) => ({
  status: 'ready', error: '', unreadable: null, reset: null,
  installed: contract('plugins-installed'), markets: contract('plugins-markets'),
  catalogs: { acme: contract('plugins-catalog') }, offer: null, inspect: {}, busy: {}, ...extra,
});

test('detail_shows_sheet_markers_and_unverified_notice', () => {
  const inspect = contract('plugins-inspect');
  const lines = [
    ...inspect.sheet,
    { key: 'knowledge', text: 'Read and change your notes', support: { status: 'blocking', limit: "Needs Connect's Knowledge engine (coming later)" } },
    { key: 'sessions', text: 'Help Claude in your sessions', support: { status: 'unsupported' } },
  ];
  assert.deepEqual(orderSheet(lines).map(l => l.support.status), ['blocking', 'unsupported', 'partial', 'partial', 'supported', 'supported']);
  const ui = readyUi({ offer: { market: 'acme', id: 'standup' }, inspect: { 'acme/standup': inspect } });
  const html = offerDetail(ui);
  assert.match(html, /id="plugin-sheet"/);
  assert.ok(html.includes(UNVERIFIED.replace('·', '·')), 'the unverified notice');
  for (const marker of ['Partial', 'Supported']) assert.match(html, new RegExp(`>${marker}<`));
  assert.match(html, /Claude runs without tools in Connect/, 'a partial line says its limit');
  assert.match(html, /data-action="plugin-install" data-plugin-id="standup" data-market="acme"/);
  assert.match(html, /9f3c2a1/, 'the commit it would install from');
  const all = sheetList(lines);
  for (const marker of ['Blocking', 'Unsupported', 'Partial', 'Supported']) assert.match(all, new RegExp(`>${marker}<`));
  assert.ok(all.indexOf('Blocking') < all.indexOf('Unsupported') && all.indexOf('Unsupported') < all.indexOf('Partial'));

  // Hostile words from a manifest or a marketplace stay text.
  const hostile = { ...inspect, name: HOSTILE, summary: HOSTILE, source: HOSTILE, sheet: [{ key: 'x"><b', text: HOSTILE, support: { status: 'partial', limit: HOSTILE } }] };
  const bad = offerDetail({ ...ui, inspect: { 'acme/standup': hostile } });
  assert.ok(escaped(bad), bad);
  assert.ok(bad.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
});

test('knowledge_shows_coming_later_and_no_install', () => {
  const ui = readyUi();
  const list = pluginsPanel(ui);
  const card = list.slice(list.indexOf('data-plugin-id="vault-notes"'));
  assert.ok(card.includes(KNOWLEDGE_LATER), 'Knowledge says it comes later');
  assert.match(card.slice(0, 1200), /Coming later/);
  assert.match(list, /It needs plugin engine &gt;=1\.1\.0, and Connect provides engine 1\.0\./, 'a newer engine says why');
  const vault = contract('plugins-catalog').plugins.find(p => p.id === 'vault-notes');
  const detail = offerDetail({ ...ui, offer: { market: 'acme', id: 'vault-notes' }, inspect: { 'acme/vault-notes': { ...vault, market: 'acme', sheet: [], sheetHash: 'h' } } });
  assert.ok(detail.includes(KNOWLEDGE_LATER));
  assert.doesNotMatch(detail, /data-action="plugin-install"/, 'no Install for Knowledge');
});

test('install_dialog_requires_ticking_every_line', async () => {
  const inspect = contract('plugins-inspect');
  const keys = inspect.sheet.map(l => l.key);
  assert.equal(agreement(inspect.sheet, keys.slice(1)), null);
  assert.equal(agreement(inspect.sheet, [...keys.slice(1), 'other']), null);
  assert.deepEqual(agreement(inspect.sheet, [...keys].reverse()), keys);
  const body = consentBody(inspect.sheet);
  assert.equal((body.match(/name="agree"/g) || []).length, inspect.sheet.length, 'a box per line');
  assert.match(body, /id="plugin-consent"/);

  // Through the controller: Install opens the dialog, a partial agreement is refused, and the
  // whole agreement goes out with the sheet's hash.
  const sent = [];
  let modal;
  const answers = {
    installed: () => contract('plugins-installed'), markets: () => contract('plugins-markets'),
    catalog: () => contract('plugins-catalog'), inspect: () => inspect,
    install: d => { sent.push(d); return { status: 'installed', plugin: contract('plugins-installed')[0] }; },
  };
  const c = createPluginsController({
    request: async (op, data) => answers[op](data),
    render: () => {}, toast: () => {},
    openModal: opts => {
      modal = opts;
      return { querySelector: () => ({ disabled: false }), querySelectorAll: () => [], addEventListener() {} };
    },
  });
  await c.load();
  const el = { dataset: { pluginId: 'standup', market: 'acme' } };
  await c.handle('plugin-offer', el);
  await c.handle('plugin-install', el);
  assert.equal(modal.submit, 'Install');
  const form = ticked => ({ getAll: () => ticked });
  await assert.rejects(modal.onSubmit(form(keys.slice(0, 2))), /Tick every line/);
  assert.equal(sent.length, 0);
  await modal.onSubmit(form(keys));
  assert.deepEqual(sent, [{ market: 'acme', id: 'standup', agreed: keys, sheetHash: inspect.sheetHash }]);
});

test('update and turning on ask again when the sheet changed', async () => {
  const needs = contract('plugins-update-needs-consent');
  const enable = contract('plugins-enable-needs-consent');
  const calls = [];
  let modal;
  const c = createPluginsController({
    request: async (op, data) => {
      calls.push([op, data]);
      if (op === 'update') return data.agreed ? { status: 'installed', plugin: { version: '1.1.0' } } : needs;
      if (op === 'set_enabled') return data.agreed ? { id: data.id, enabled: true } : enable;
      if (op === 'installed') return contract('plugins-installed');
      if (op === 'catalog') return contract('plugins-catalog');
      return [];
    },
    render: () => {}, toast: () => {},
    openModal: opts => { modal = opts; return { querySelector: () => ({}), querySelectorAll: () => [], addEventListener() {} }; },
  });
  await c.handle('plugin-update', { dataset: { pluginId: 'standup' } });
  assert.match(modal.body, /New/, 'the new line is marked');
  await modal.onSubmit({ getAll: () => needs.sheet.map(l => l.key) });
  assert.deepEqual(calls.find(([op, d]) => op === 'update' && d.agreed)[1], { id: 'standup', agreed: needs.sheet.map(l => l.key), sheetHash: needs.sheetHash });

  await c.handle('plugin-enable', { dataset: { pluginId: 'standup' }, checked: true });
  assert.equal(modal.submit, 'Turn on');
  await modal.onSubmit({ getAll: () => enable.sheet.map(l => l.key) });
  assert.deepEqual(calls.find(([op, d]) => op === 'set_enabled' && d.agreed)[1], { id: 'standup', enabled: true, agreed: enable.sheet.map(l => l.key), sheetHash: enable.sheetHash });
});

test('an unreadable list offers Reset, explains it, and lists what was taken back and left', async () => {
  const unreadable = contract('plugins-registry-unreadable');
  let broken = true;
  const c = createPluginsController({
    request: async op => {
      if (broken && op !== 'registry_reset') throw unreadable;
      if (op === 'registry_reset') { broken = false; return { ...contract('plugins-registry-reset'), leftovers: ['installed/standup/0.9.0'] }; }
      if (op === 'installed') return contract('plugins-installed-adopted');
      if (op === 'markets') return contract('plugins-markets').slice(0, 1);
      return { plugins: [] };
    },
    render: () => {}, toast: () => {}, openModal: () => ({}),
  });
  await c.load();
  const before = pluginsPanel(c.ui);
  assert.match(before, /Your list of plugins can’t be read/);
  assert.ok(before.includes('Connect couldn’t read its list of plugins'));
  assert.match(before, /data-action="plugins-reset"/);
  assert.match(before, /taken back turned off/);
  await c.handle('plugins-reset', { dataset: {} });
  const after = pluginsPanel(c.ui);
  assert.match(after, /registry\.json\.bad-20261117T093000\.000Z/);
  assert.match(after, /<code>standup<\/code>/);
  assert.match(after, /installed\/standup\/0\.9\.0/);
  assert.match(after, /Taken back/, 'the adopted plugin is marked');
});

test('a plugin’s page has Sign in, its addresses, its card slot and Remove with its data', () => {
  const p = {
    ...contract('plugins-installed')[0], id: 'hello', name: `Hello ${HOSTILE}`, enabled: true,
    signin: [{ host: 'github.com', signedIn: false, from: null }, { host: 'gitlab.com', signedIn: false, from: null }],
    addresses: [{ key: 'servers', label: `Servers ${HOSTILE}`, help: null, value: '10.0.0.5' }],
  };
  const ui = readyUi({ installed: [p] });
  const html = installedDetail(ui, 'hello', { card: true, sections: [{ id: 'main', label: 'Hello' }], palette: [{ label: 'Hello: open', keywords: '' }], error: '' });
  assert.ok(escaped(html), html);
  assert.match(html, /data-action="plugin-signin" data-plugin-id="hello" data-host="github.com"/);
  assert.match(html, /Connect signs in to GitHub only/);
  assert.match(html, /data-form="plugin-addresses" data-plugin-id="hello" data-key="servers"/);
  assert.match(html, /value="10\.0\.0\.5"/);
  assert.match(html, /data-plugin-slot="hello"/, 'its own card is drawn in its frame over this slot');
  assert.match(html, /data-action="plugin-section" data-plugin-id="hello" data-section="main"/);
  assert.match(html, /data-action="plugin-palette"/);
  assert.match(html, /data-action="plugin-remove"/);
  assert.ok(html.includes(UNVERIFIED));
  const signedIn = installedDetail(readyUi({ installed: [{ ...p, signin: [{ host: 'github.com', signedIn: true, from: 'gh' }] }] }), 'hello', null);
  assert.match(signedIn, /data-action="plugin-signout"/);
  assert.doesNotMatch(signedIn, /data-plugin-slot/, 'no card slot until its frame has a card');

  const list = pluginsPanel(readyUi());
  assert.ok(list.includes(PROXY_NOTE.replace(/’/g, '’')), 'the proxy note for git marketplaces');
  assert.match(list, /data-action="market-add"/);
  assert.match(list, /data-action="market-remove" .*data-market="acme"/);
  assert.doesNotMatch(list, /data-action="market-remove"[^>]*data-market="onetest"/, 'the built-in marketplace stays');
  assert.match(list, /Update 1\.1\.0/);
  const hostile = pluginsPanel(readyUi({ installed: [{ ...p, summary: HOSTILE }], markets: [{ ...contract('plugins-markets')[1], name: HOSTILE, source: HOSTILE }], catalogs: {} }));
  assert.ok(escaped(hostile), hostile);
});

test('Remove asks first and sends whether to delete its data', async () => {
  const sent = [];
  let modal;
  const c = createPluginsController({
    request: async (op, data) => { if (op === 'remove') sent.push(data); return op === 'installed' ? [] : { plugins: [] }; },
    render: () => {}, toast: () => {},
    openModal: opts => { modal = opts; return {}; },
  });
  c.ui.installed = contract('plugins-installed');
  await c.handle('plugin-remove', { dataset: { pluginId: 'standup' } });
  assert.match(modal.body, /Also delete its data/);
  await modal.onSubmit({ has: k => k === 'deleteData' });
  assert.deepEqual(sent, [{ id: 'standup', deleteData: true }]);
});

test('disabled_plugin_activity_leaves_sidebar_and_frame_unloads', () => {
  const s = buildSnapshot(Date.now(), { zone: 'Europe/Kyiv' });
  const on = renderShell({ snapshot: s, route: 'plugin', resolvedDark: true, plugins: { activities: [{ plugin: 'hello', id: 'home', label: `Hello ${HOSTILE}` }], current: { plugin: 'hello', id: 'home' } } });
  assert.match(on, /<div class="ws-nav-label">Plugins<\/div>/);
  assert.match(on, /data-action="plugin-page" data-plugin-id="hello" data-activity="home"[^>]*aria-current="page"/);
  assert.ok(escaped(on));
  const off = renderShell({ snapshot: s, route: 'today', resolvedDark: true, plugins: { activities: [] } });
  assert.doesNotMatch(off, /data-action="plugin-page"/);
  assert.doesNotMatch(off, /ws-plugin-nav/);
  assert.equal(pluginNav([]), '');
  // (The frame's unload on disable is covered in plugin-bridge.test.mjs.)
});

test('Settings lists Plugins with each plugin’s sections, and a section fills the panel', () => {
  const s = buildSnapshot(Date.now(), { zone: 'Europe/Kyiv' });
  const ctx = path => ({
    state: { settingsTab: 'plugins', storage: {}, ai: { status: 'idle', profiles: [], settings: {} } }, auth: {},
    plugins: { ui: readyUi(), path, status: () => null, sections: [{ plugin: 'hello', pluginName: 'Hello', id: 'main', label: 'Hello', badge: '!' }] },
  });
  const list = settings(s, ctx(null));
  assert.match(list, /data-action="settings-tab" data-tab="plugins" aria-current="page"/);
  assert.match(list, /data-action="plugin-section" data-plugin-id="hello" data-section="main"/);
  assert.match(list, /<small class="ws-count">!<\/small>/);
  const section = settings(s, ctx({ id: 'hello', section: 'main' }));
  assert.match(section, /class="ws-settings-panels ws-settings-panels-fill" data-plugin-clip><div class="ws-plugin-slot-fill" data-plugin-slot="hello">/);
  assert.match(section, /From Hello, drawn by the plugin/);
  assert.equal(pluginsPage(readyUi(), { id: 'hello', section: 'gone' }, { sections: [] }).content.includes('isn’t available'), true);
});

test('today_customize_lists_plugin_widgets', () => {
  const installed = [
    { id: 'github', name: 'GitHub', enabled: true, problem: null, widgets: [{ id: 'ci', label: 'GitHub CI', about: '', kind: 'status', sizes: ['S', 'M'] }, { id: 'repos', label: `Repos ${HOSTILE}`, about: 'Your repos', kind: 'list', sizes: ['L'] }] },
    { id: 'offline', name: 'Off', enabled: false, problem: null, widgets: [{ id: 'x', label: 'X', kind: 'stat', sizes: [] }] },
  ];
  const catalog = pluginWidgetCatalog(installed);
  assert.deepEqual(catalog.map(w => [w.id, w.width]), [['plugin:github:ci', 4], ['plugin:github:repos', 12]]);
  // The gallery offers what isn't on Today, plugin widgets marked, and lists what is.
  const html = gallery(tileDefs(catalog), new Set(['brief', 'plugin:github:repos']));
  const offered = html.slice(html.indexOf('Add to Today'), html.indexOf('On Today'));
  assert.match(offered, /data-gid="plugin:github:ci" data-w="4" data-h="4"[^]*?GitHub CI <span class="ws-badge ws-badge-purple">Plugin<\/span>/);
  assert.match(offered, /data-gid="plugins"/, 'the From plugins card is offered');
  assert.doesNotMatch(offered, /data-gid="brief"/);
  assert.match(html, /On Today · 2<\/div>[^]*?data-gid="brief"[^]*?data-gid="plugin:github:repos"/);
  assert.ok(escaped(html), 'a plugin widget title is text');
  assert.deepEqual(parseLayoutId('plugin:github:ci'), { plugin: 'github', widget: 'ci' });
  assert.equal(parseLayoutId('plugin:../x:y'), null);
});

test('Today draws plugin widgets from their data, escaped, and the From plugins card with held messages', () => {
  const now = Date.now();
  const s = buildSnapshot(now, { zone: 'Europe/Kyiv' });
  const at = Math.floor(now / 1000) - 120;
  s.records.push(
    { id: 'github:ci', kind: 'plugin_widget', revision: 'r1', updatedAt: at, data: { type: 'widget', plugin: 'github', pluginName: 'GitHub', widget: 'ci', kind: 'status', label: 'GitHub CI', at, data: { state: 'bad', title: HOSTILE, text: 'main is red', actions: [{ label: 'Re-run', command: 'rerun', args: { repo: 'a/b' } }] } } },
    { id: 'github:repos', kind: 'plugin_widget', revision: 'r2', updatedAt: at, data: { type: 'widget', plugin: 'github', pluginName: 'GitHub', widget: 'repos', kind: 'table', label: 'Repos', at, stale: true, error: 'it didn’t answer within 5 s', data: { columns: [{ key: 'name', label: 'Repo' }, { key: 'prs', label: 'PRs', kind: 'number' }], rows: [{ id: '1', cells: { name: HOSTILE, prs: 3 } }] } } },
    { id: 'scheduler:held:1', kind: 'plugin_item', revision: 'r3', updatedAt: at, data: { type: 'held_message', plugin: 'scheduler', pluginName: 'Scheduler', at, channel: 'mail', to: { self: true, address: 'taylor@example.com' }, subject: 'Monday plan', markdown: `Plan ${HOSTILE}`, state: 'held', sent: false } },
    { id: 'scheduler:card:aa', kind: 'plugin_item', revision: 'r4', updatedAt: at, data: { type: 'delivery', plugin: 'scheduler', pluginName: 'Scheduler', at, to: 'mail', title: 'Monday plan', markdown: 'Plan', held: 'scheduler:held:1' } },
    { id: 'github:inbox:review:1', kind: 'plugin_item', revision: 'r5', updatedAt: at, data: { type: 'inbox', plugin: 'github', pluginName: 'GitHub', at, key: 'review:1', title: `Review ${HOSTILE}`, why: 'You were asked', urgent: true, go: 'github:repos', actions: [{ label: 'Approve', command: 'approve', args: { pr: 1 }, primary: true }] } },
  );
  const ci = pluginWidgetCard(s, 'plugin:github:ci', {});
  assert.ok(escaped(ci), ci);
  assert.match(ci, /ws-pw-bad/);
  assert.match(ci, /data-action="plugin-command" data-plugin-id="github" data-command="rerun"/);
  const repos = pluginWidgetCard(s, 'plugin:github:repos', {});
  assert.ok(escaped(repos));
  assert.match(repos, /Not updated/);
  assert.match(repos, /didn’t answer within 5 s/);
  assert.match(pluginWidgetCard(s, 'plugin:github:missing', { catalog: [] }), /Its plugin is off/);
  // Every kind draws its text escaped.
  const kinds = {
    stat: { value: HOSTILE, unit: HOSTILE, label: HOSTILE, note: HOSTILE },
    stats: { items: [{ label: HOSTILE, value: HOSTILE }] },
    list: { items: [{ title: HOSTILE, sub: HOSTILE }] },
    card: { title: HOSTILE, text: HOSTILE },
    chart: { type: 'bar', points: [{ label: HOSTILE, value: 2 }], note: HOSTILE },
  };
  for (const [kind, data] of Object.entries(kinds)) {
    s.records.push({ id: `github:${kind}`, kind: 'plugin_widget', revision: kind, updatedAt: at, data: { type: 'widget', plugin: 'github', pluginName: HOSTILE, widget: kind, kind, label: HOSTILE, at, data } });
    const html = pluginWidgetCard(s, `plugin:github:${kind}`, {});
    assert.ok(escaped(html), `${kind}: ${html}`);
    assert.ok(html.includes('&lt;img'), kind);
  }
  s.records.push({ id: 'hello:board', kind: 'plugin_widget', revision: 'b', updatedAt: at, data: { type: 'widget', plugin: 'hello', pluginName: 'Hello', widget: 'board', kind: 'page', label: 'Board', at, data: {} } });
  assert.ok(escaped(pluginWidgetCard(s, 'plugin:hello:board', { drawn: { 'plugin:hello:board': HOSTILE } })), 'a page widget’s drawn text stays text');

  const card = pluginsCard(s, { routeOf: (plugin, go) => (go === 'github:repos' ? '#/p/github/repos' : null) });
  assert.ok(escaped(card), card);
  assert.match(card, /Not sent — Connect never sends for plugins/);
  assert.match(card, /data-action="plugin-copy"[^>]*data-id="scheduler:held:1"/);
  assert.match(card, /data-action="plugin-command" data-plugin-id="github" data-command="approve"/);
  assert.match(card, /data-go="#\/p\/github\/repos"/);
  assert.equal(heldText(s, 'scheduler:held:1'), `Monday plan\n\nPlan ${HOSTILE}`);
  const w = s.workspaces.find(x => x.id === s.settings.activeWorkspace);
  assert.equal(showPluginsCard({ ...w, layout: [], widgetWidths: {}, today: {} }, s), true, 'shown until a saved layout says otherwise');
  assert.equal(showPluginsCard({ ...w, layout: [], widgetWidths: { plugins: 12 }, today: {} }, s), false);
  // With a saved grid: shown unless the grid places it (it is drawn there) or it was removed.
  const grid = items => ({ active: 'Mine', items, layouts: {}, titles: {}, options: {}, hidden: [] });
  assert.equal(showPluginsCard({ ...w, layout: [], widgetWidths: { plugins: 12 }, today: grid([]) }, s), true, 'the old widths no longer count');
  assert.equal(showPluginsCard({ ...w, layout: ['plugins'], today: grid([{ id: 'plugins', x: 0, y: 0, w: 12, h: 3 }]) }, s), false);
  assert.equal(showPluginsCard({ ...w, layout: [], today: { ...grid([]), hidden: ['plugins'] } }, s), false);

  // On Today: a plugin widget on the grid, and the From plugins card on its own at the bottom.
  w.layout = ['brief', 'plugin:github:ci'];
  w.widgetWidths = {};
  w.today = grid([{ id: 'brief', x: 0, y: 0, w: 8, h: 4 }, { id: 'plugin:github:ci', x: 8, y: 0, w: 4, h: 4 }]);
  const page = today(s, { auth: {}, hidden: new Set(), banners: '', state: {}, plugins: { catalog: [], drawn: {}, routeOf: () => null } });
  assert.match(page, /data-widget="plugin:github:ci" data-tile="plugin:github:ci"/);
  assert.match(page, /class="ws-card ws-tile ws-plugins-card" data-tile="plugins" style="--x:0;--y:4;--w:12;--h:3;--order:2"/);
  assert.ok(escaped(page));
});

test('a plugin whose host half did not load says why, and can still be turned off', () => {
  const why = `CodeMie Connect doesn't have ctx.sessions (only Echo has it), so this plugin needs a change to run here: ${HOSTILE}`;
  const p = { ...contract('plugins-installed')[0], id: 'telegram', name: 'Telegram', update: null, loadError: why };
  const ui = readyUi({ installed: [p] });
  const list = pluginsPanel(ui);
  assert.ok(escaped(list), list);
  assert.match(list, /Didn’t load/);
  assert.ok(list.includes('doesn&#39;t have ctx.sessions') || list.includes("doesn't have ctx.sessions"), list);
  assert.doesNotMatch(list, /data-action="plugin-enable"[^>]*disabled/, 'it can still be turned off');
  const detail = installedDetail(ui, 'telegram', null);
  assert.ok(escaped(detail), detail);
  assert.match(detail, /Its host half didn’t load/);
  assert.match(detail, /needs a change to run here/);
  // Turned off, it isn't a problem any more.
  const off = pluginsPanel(readyUi({ installed: [{ ...p, enabled: false }] }));
  assert.doesNotMatch(off, /Didn’t load/);
  // A page that failed after it started says so in those words.
  const failed = installedDetail(readyUi({ installed: [{ ...p, loadError: null }] }), 'telegram', { error: 'Page “main”: boom', errors: ['Page “main”: boom'] });
  assert.match(failed, /Its page failed: Page “main”: boom/);
});
