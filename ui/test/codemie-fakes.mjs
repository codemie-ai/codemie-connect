// Fakes shared by the Settings → CodeMie controller and sheet tests.
import { createCodemieController } from '../workspace/codemie/controller.js';
import { emptyCodemie } from '../workspace/codemie/model.js';
import { createRunLog } from '../workspace/codemie/run-log.js';

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
    checkUrl: async () => ({ verdict: 'codemie', status: 302, detail: '' }), hold: async (fn) => fn(),
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
