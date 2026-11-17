// The Settings → CodeMie controller with its service, session, dialogs and Tauri faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodemieController } from '../workspace/codemie/controller.js';
import { emptyCodemie } from '../workspace/codemie/model.js';
import { createRunLog } from '../workspace/codemie/run-log.js';
import { SETTINGS_TABS, LEGACY_TAB_REDIRECTS } from '../workspace/view-settings.js';

export function fakeService(over = {}) {
  const state = emptyCodemie();
  Object.assign(state, {
    loaded: true,
    runtime: { ...state.runtime, state: 'ready' },
    config: { state: 'valid', active: 'prod', account: 'a@b.c' },
    profiles: [
      { name: 'prod', provider: 'ai-run-sso', model: 'claude-sonnet-4-5', codemieUrl: 'https://codemie.lab.epam.com', codemieProject: 'EPM-CDME' },
      { name: 'staging', provider: 'ai-run-sso', model: 'claude-sonnet-4-5', codemieUrl: 'https://codemie.lab.epam.com' },
    ],
    auth: { state: 'signed_in', detail: '' },
    agents: [
      { name: 'CodeMie Code', command: 'codemie-code', installed: true, version: '0.0.47', description: '', updateAvailable: false },
      { name: 'Claude Code', command: 'claude', installed: true, version: '2.1.269', description: '', updateAvailable: false },
    ],
    gateway: { state: 'stopped', port: null, profile: null },
    apps: [{ id: 'claude-desktop', installed: true, configured: false }],
  });
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); };
  const svc = {
    state, calls,
    subscribe: () => () => {},
    busy: () => false,
    boot: record('boot'), load: record('load'), ensureRuntime: record('ensureRuntime'),
    switchProfile: record('switchProfile'), renameProfile: record('renameProfile'), deleteProfile: record('deleteProfile'),
    signIn: record('signIn'), installAgent: record('installAgent'), updateAgent: record('updateAgent'), removeAgent: record('removeAgent'),
    refreshGateway: record('refreshGateway'), refreshApps: record('refreshApps'), connectApps: record('connectApps'),
    disconnectApp: record('disconnectApp'), startGateway: record('startGateway'), restartGateway: record('restartGateway'),
    openDownload: record('openDownload'), runDoctor: record('runDoctor'), updateCli: record('updateCli'), checkCli: record('checkCli'),
    openInTerminal: record('openInTerminal'), pickFolder: async () => null, clearError: () => {},
    ...over,
  };
  return svc;
}

export function controllerHarness({ service = fakeService(), session, prefs = {} } = {}) {
  const invoked = [];
  const toasts = [];
  const modals = [];
  const store = new Map(Object.entries(prefs));
  const s = session || { running: () => false, cancel: async () => true };
  const c = createCodemieController({
    state: { route: 'settings', settingsTab: 'cm-overview' },
    service,
    session: s,
    runLog: createRunLog(),
    render: async () => {},
    route: async () => {},
    openModal: (m) => { modals.push(m); return { close() {} }; },
    confirmModal: (m) => { modals.push(m); return m.onConfirm?.(); },
    toast: (msg, tone) => toasts.push([msg, tone]),
    writeText: async () => {},
    localPref: (k, d) => (store.has(k) ? store.get(k) : d),
    setLocalPref: (k, v) => store.set(k, v),
    store: { query: async () => ({ ok: true }) },
    invoke: async (name, args) => { invoked.push([name, args]); return null; },
  });
  return { c, service, invoked, toasts, modals, prefs: store };
}

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
  assert.deepEqual(c.prefs(), { introduced: true, snoozedUntil: 42, appsSkipped: true });
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

test('profile_test_uses_the_claude_test', async () => {
  const { c } = controllerHarness();
  await c.handle('cm-profile-test', el({ id: 'prod' }));
  assert.match(c.panel('cm-profiles'), /cm-status[^>]*>.*OK/s);
});
