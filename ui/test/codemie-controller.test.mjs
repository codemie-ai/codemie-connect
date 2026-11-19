// The Settings → CodeMie controller with its service, session, dialogs and Tauri faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeService, controllerHarness } from './codemie-fakes.mjs';
import { SETTINGS_TABS, LEGACY_TAB_REDIRECTS } from '../workspace/view-settings.js';

const el = (data = {}, extra = {}) => ({ dataset: data, value: extra.value, closest: () => null, ...extra });

test('unknown_action_is_not_handled', async () => {
  const { c } = controllerHarness();
  assert.equal(await c.handle('ai-test', el()), false);
  assert.equal(await c.handle('cm-tab', el({ tab: 'cm-agents' })), true);
});

test('legacy_tab_ids_redirect', () => {
  assert.equal(LEGACY_TAB_REDIRECTS.usage, 'cm-overview');
  assert.equal(LEGACY_TAB_REDIRECTS.desktop, 'cm-apps');
  const ids = SETTINGS_TABS.map(([, id]) => id);
  for (const gone of ['usage', 'installation', 'tools', 'desktop', 'health']) assert.ok(!ids.includes(gone), gone);
  for (const tab of ['cm-overview', 'cm-profiles', 'cm-agents', 'cm-apps', 'cm-health']) assert.ok(ids.includes(tab), tab);
});

test('settings_dot_when_setup_unfinished', () => {
  const service = fakeService();
  service.state.agents = service.state.agents.slice(0, 1);
  const { c } = controllerHarness({ service });
  assert.equal(c.settingsDot(), true);
  assert.ok(c.tabDots().has('cm-overview'));
  service.state.agents.push({ name: 'Claude Code', command: 'claude', installed: true, version: '2.1.269' });
  assert.equal(c.settingsDot(), false);
});

test('quit_request_cancels_setup_and_clears_busy', async () => {
  let cancelled = 0;
  const session = { running: () => true, cancel: async () => { cancelled++; return true; } };
  const { c, invoked, modals } = controllerHarness({ session });
  await c.onQuitRequest();
  assert.equal(modals.length, 1, 'asks before stopping work');
  assert.equal(cancelled, 1);
  assert.deepEqual(invoked.find(([n]) => n === 'workspace_installer_busy'), ['workspace_installer_busy', { busy: false }]);
  assert.ok(invoked.some(([n]) => n === 'close_app'));
});

test('quit_request_with_nothing_running_does_nothing', async () => {
  const { c, invoked, modals } = controllerHarness();
  await c.onQuitRequest();
  assert.equal(modals.length, 0);
  assert.deepEqual(invoked, []);
});

test('prefs_read_setup_keys', () => {
  const { c } = controllerHarness({ prefs: { 'codemie.setup.introduced': '1', 'codemie.setup.snoozedUntil': '42', 'codemie.setup.appsSkipped': '1' } });
  const p = c.prefs();
  assert.deepEqual([p.introduced, p.snoozedUntil, p.appsSkipped, p.setupDismissed, [...p.dismissed]], [true, 42, true, false, []]);
});

test('banners_show_attention_on_today_only', () => {
  const service = fakeService();
  service.state.auth = { state: 'not_signed_in', detail: '' };
  const { c } = controllerHarness({ service });
  assert.match(c.banners('today'), /CodeMie sign-in expired for “prod”/);
  assert.match(c.banners('today'), /data-action="cm-profile-login"/);
  assert.equal(c.banners('settings'), '');
});

test('delete_active_switches_to_next', async () => {
  const { c, service } = controllerHarness();
  await c.handle('cm-profile-delete', el({ id: 'prod' }));
  assert.deepEqual(service.calls.map((x) => x.slice(0, 2)), [['deleteProfile', 'prod'], ['switchProfile', 'staging']]);
});

test('delete_profile_used_by_gateway_restarts_it_on_the_next', async () => {
  const service = fakeService();
  service.state.gateway = { state: 'running', port: 4001, profile: 'staging' };
  service.state.apps = [{ id: 'claude-desktop', installed: true, configured: true }];
  const { c } = controllerHarness({ service });
  await c.handle('cm-profile-delete', el({ id: 'staging' }));
  assert.deepEqual(service.calls.map((x) => x.slice(0, 2)), [['deleteProfile', 'staging'], ['restartGateway', 'prod']]);
});

test('rename_checks_name_and_duplicates', async () => {
  const { c, modals, service } = controllerHarness();
  await c.handle('cm-profile-rename', el({ id: 'prod' }));
  const form = (name) => ({ get: () => name });
  await assert.rejects(() => modals[0].onSubmit(form('staging')), /already exists/);
  await assert.rejects(() => modals[0].onSubmit(form('a b')), /Letters, numbers/);
  await modals[0].onSubmit(form('main'));
  assert.deepEqual(service.calls.at(-1), ['renameProfile', 'prod', 'main']);
});

test('install_failure_without_output_keeps_state', async () => {
  const service = fakeService({
    installAgent: async () => { throw Object.assign(new Error('The command stopped without saying why.'), { cmd: 'codemie install gemini', output: '', code: 1 }); },
  });
  service.state.agents.push({ name: 'Gemini CLI', command: 'gemini', installed: false, version: null, description: '', updateAvailable: false });
  const { c, toasts } = controllerHarness({ service });
  await c.handle('cm-agent-install', el({ id: 'gemini' }));
  const html = c.panel('cm-agents');
  const card = html.split('data-agent=').find((x) => x.startsWith('"gemini"'));
  assert.match(card, /Gemini CLI was not installed/);
  assert.match(card, /No output was captured\./);
  assert.match(card, /data-action="cm-agent-install"/, 'Install and Try again stay available');
  assert.deepEqual(toasts, []);
  await c.handle('cm-agent-dismiss', el({ id: 'gemini' }));
  assert.doesNotMatch(c.panel('cm-agents'), /was not installed/);
});

test('remove_asks_first', async () => {
  const { c, modals, service } = controllerHarness();
  await c.handle('cm-agent-remove', el({ id: 'claude' }));
  assert.match(modals[0].title, /Remove Claude Code\?/);
  assert.deepEqual(service.calls.at(-1), ['removeAgent', 'claude']);
});

test('profile_test_uses_the_claude_test', async () => {
  const { c } = controllerHarness();
  await c.handle('cm-profile-test', el({ id: 'prod' }));
  assert.match(c.panel('cm-profiles'), /cm-status[^>]*>.*OK/s);
});

// Merge with Milestone 2: Today holds hover states, a draft about to start and plugin cards, so a
// CodeMie read that changes nothing Today shows (the setup card, the notices) does not redraw it.
test('today_redraws_only_when_codemie_changes_what_today_shows', async () => {
  const listeners = [];
  const service = fakeService({ subscribe: (fn) => { listeners.push(fn); return () => {}; } });
  let renders = 0;
  let c;
  // As app.js does: every render of Today asks for the card and the notices.
  ({ c } = controllerHarness({ service, state: { route: 'today' }, render: async () => { renders++; c.todayCard(); c.banners('today'); } }));
  c.todayCard();
  c.banners('today');
  await c.boot();
  const notify = async () => { listeners.forEach((fn) => fn()); await new Promise((r) => setTimeout(r, 300)); };
  await notify();
  assert.equal(renders, 0, 'an unchanged read redrew Today');
  const first = renders;
  service.state.auth = { state: 'not_signed_in', detail: '' };
  await notify();
  assert.equal(renders, first + 1, 'a sign-in that expired did not reach Today');
});

// Start coding: a coding agent opens in a tab of Connect's terminal (macOS), or the Terminal app.
const formOf = (values) => ({ get: (k) => values[k] ?? null });

test('start_coding_opens_in_connects_terminal_and_remembers_the_choice', async () => {
  const { c, service, modals, toasts, prefs } = controllerHarness({ ownTerminal: true, prefs: { 'codemie.start.folders': JSON.stringify(['/Users/taylor/atlas']) } });
  assert.equal(await c.handle('cm-open-terminal', el({ id: 'claude' })), true);
  const m = modals.at(-1);
  assert.equal(m.submit, 'Start');
  assert.match(m.body, /name="where" value="connect" checked/);
  assert.match(m.body, /A tab in Connect’s terminal/);
  await m.onSubmit(formOf({ folder: '/Users/taylor/atlas', where: 'connect' }));
  assert.deepEqual(service.calls.at(-1), ['openInConnect', { folder: '/Users/taylor/atlas', launcher: 'codemie-claude', profile: 'prod', agent: 'Claude Code' }]);
  assert.deepEqual(toasts, [], 'the dock shows the new tab');
  // The Terminal app, once chosen, is the next default.
  await m.onSubmit(formOf({ folder: '/Users/taylor/atlas', where: 'app' }));
  assert.deepEqual(service.calls.at(-1), ['openInTerminal', { folder: '/Users/taylor/atlas', launcher: 'codemie-claude', profile: 'prod' }]);
  assert.equal(prefs.get('codemie.start.where'), 'app');
  await c.handle('cm-open-terminal', el({ id: 'claude' }));
  assert.match(modals.at(-1).body, /name="where" value="app" checked/);
});

test('start_coding_off_a_mac_opens_the_system_terminal_without_asking_where', async () => {
  const { c, service, modals } = controllerHarness({ ownTerminal: false, prefs: { 'codemie.start.folders': JSON.stringify(['C:\\work\\atlas']) } });
  await c.handle('cm-open-terminal', el({ id: 'claude' }));
  assert.doesNotMatch(modals.at(-1).body, /name="where"/);
  await modals.at(-1).onSubmit(formOf({ folder: 'C:\\work\\atlas' }));
  assert.equal(service.calls.at(-1)[0], 'openInTerminal');
});
