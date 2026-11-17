// The CodeMie state behind Settings → CodeMie and every native or CLI call that changes it.
// Views never call Tauri: they render `state` and the controller calls these methods.
//
// Every CLI call goes through run(): it is logged ("What CodeMie ran"), runs through run_capture
// or run_stream, and a non-zero exit becomes an Error carrying a plain sentence, the command and
// its output. While anything that changes the machine runs, Rust is told
// (workspace_installer_busy) so quitting asks first.
import { parseAgentList } from '../../agents-parse.js';
import { parseUpdateStatus } from '../../agents-update-parse.js';
import { joinUpdateStatus } from '../../agents-join.js';
import { parseDoctorOutput } from '../../doctor-parse.js';
import { groupDoctorResults } from '../../doctor-groups.js';
import { findLoginError } from '../../signin-parse.js';
import { cliCommands, assertSafe } from './cli.js';
import { APPS } from './catalog.js';
import { emptyCodemie } from './model.js';
import { parseProxyStatus, failureMessage } from './parse.js';

const RELOAD_MS = 5000;
const VERSION = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/;

export function createCodemieService({ invoke, listen, runLog, platform, now = Date.now, setupRunning = () => false }) {
  const cm = emptyCodemie();
  const cmd = cliCommands(platform);
  const listeners = new Set();
  const notes = new Map(); // agent command -> note kept across reloads
  let lastLoad = -Infinity;
  let loading = null;
  let ensuring = null;
  let guarded = 0;
  let streamSeq = 0;

  const notify = () => { for (const fn of [...listeners]) fn(); };

  /** Run one CLI command. `check: false` returns a failed run instead of throwing. */
  async function run(command, { stream = false, verb, check = true } = {}) {
    const entry = runLog.start(command);
    const lines = [];
    let code = 1;
    try {
      if (stream) {
        const streamId = `codemie-${++streamSeq}`;
        const un = await listen('engine:cmd-line', (e) => {
          const p = e?.payload;
          if (!p || p.id !== streamId) return;
          lines.push({ text: String(p.text ?? ''), tag: p.tag || 'stdout' });
          entry.append(`${p.text}\n`);
        });
        try {
          code = await invoke('run_stream', { cmd: command, streamId });
        } finally {
          un();
        }
      } else {
        const r = (await invoke('run_capture', { cmd: command })) || {};
        code = r.code ?? 1;
        for (const [text, tag] of [[r.stdout, 'stdout'], [r.stderr, 'stderr']]) {
          for (const line of String(text || '').split(/\r?\n/)) if (line) lines.push({ text: line, tag });
        }
        entry.append(lines.map((l) => l.text).join('\n'));
      }
    } catch (e) {
      const text = String(e?.message ?? e);
      lines.push({ text, tag: 'stderr' });
      entry.append(text);
      code = 1;
    }
    entry.finish(code);
    const output = lines.map((l) => l.text).join('\n');
    const result = { code, lines, output, stdout: lines.filter((l) => l.tag === 'stdout').map((l) => l.text).join('\n') };
    if (code !== 0 && check) {
      throw Object.assign(new Error(failureMessage(lines.map((l) => l.text), verb)), { cmd: command, output, code });
    }
    return result;
  }

  async function guard(on) {
    if (on ? guarded++ === 0 : --guarded === 0) {
      await invoke('workspace_installer_busy', { busy: on }).catch(() => {});
    }
  }

  /**
   * One operation under `key`: marks it busy, clears and records its error, and holds the quit
   * guard. `busy[key]` is set before the first await, so a second call sees it at once.
   */
  async function operation(key, fn, { blocksQuit = true } = {}) {
    cm.busy[key] = true;
    delete cm.errors[key];
    notify();
    if (blocksQuit) await guard(true);
    try {
      return await fn();
    } catch (e) {
      cm.errors[key] = { message: e?.message || String(e), output: e?.output ?? '' };
      throw e;
    } finally {
      delete cm.busy[key];
      if (blocksQuit) await guard(false);
      notify();
    }
  }

  const agentBusy = () => (cm.agents || []).some((a) => cm.busy[a.command]) || Object.keys(cm.busy).some((k) => k.startsWith('agent:'));

  function agentOperation(name, fn) {
    assertSafe('agent', name);
    if (agentBusy()) return Promise.reject(new Error('Another coding agent is still being worked on. Try again when it finishes.'));
    cm.busy[`agent:${name}`] = true;
    return operation(name, fn).finally(() => { delete cm.busy[`agent:${name}`]; });
  }

  async function readAgents() {
    const list = await run(cmd.list, { check: false });
    if (list.code !== 0) {
      cm.agents = null;
      return;
    }
    const check = await run(cmd.updateCheck, { check: false });
    const updates = check.code === 0 ? parseUpdateStatus(check.output) : [];
    const below = new Set((cm.agents || []).filter((a) => a.belowMinimum).map((a) => a.command));
    cm.agents = joinUpdateStatus(parseAgentList(list.stdout || list.output), updates).map((a) => ({
      ...a,
      ...(below.has(a.command) && a.installed ? { belowMinimum: true } : {}),
      ...(notes.has(a.command) ? { note: notes.get(a.command) } : {}),
    }));
  }

  async function refreshGateway() {
    const r = await run(cmd.proxyStatus, { check: false });
    cm.gateway = r.code === 0 ? parseProxyStatus(r.output) : { state: 'stopped', port: null, profile: null };
    notify();
    return cm.gateway;
  }

  async function refreshApps() {
    const apps = await invoke('codemie_app_states').catch(() => null);
    if (Array.isArray(apps)) cm.apps = apps;
    notify();
    return cm.apps;
  }

  async function readConfig() {
    const p = (await invoke('read_codemie_profiles').catch(() => null)) || { state: 'no-configuration', active: null, account: null, profiles: [] };
    cm.config = { state: p.state, active: p.active ?? null, account: p.account ?? null };
    cm.profiles = Array.isArray(p.profiles) ? p.profiles : [];
  }

  async function readAuth() {
    if (cm.runtime.state !== 'ready' || !cm.profiles.length) {
      cm.auth = { state: cm.profiles.length ? 'unknown' : 'no_profile', detail: '' };
      return;
    }
    const s = await invoke('check_profile_status').catch(() => null);
    cm.auth = { state: s?.state || 'unknown', detail: s?.detail || '' };
  }

  /** Read everything. Skipped while setup writes the config; throttled to once per 5 s. */
  function load({ force = false } = {}) {
    if (setupRunning()) return Promise.resolve();
    if (loading) return loading;
    if (!force && cm.loaded && now() - lastLoad < RELOAD_MS) return Promise.resolve();
    lastLoad = now();
    loading = (async () => {
      await readConfig();
      const reads = [readAuth(), refreshApps()];
      if (cm.runtime.state === 'ready') reads.push(readAgents(), refreshGateway());
      await Promise.all(reads);
      cm.loaded = true;
      notify();
    })().finally(() => { loading = null; });
    return loading;
  }

  async function readVersion() {
    const r = await run(cmd.version, { check: false });
    const v = r.output.match(VERSION)?.[1];
    if (v) { cm.runtime.version = v; notify(); }
  }

  function afterReady() {
    readVersion().catch(() => {});
    if (cm.runtime.ownCli) return;
    invoke('update_cli')
      .then((v) => {
        if (!v) return;
        cm.runtime.version = v;
        return load({ force: true });
      })
      .catch(() => {});
  }

  function ensureRuntime() {
    if (ensuring) return ensuring;
    ensuring = (async () => {
      Object.assign(cm.runtime, { state: 'downloading', fraction: 0, error: '', network: false, phase: null });
      notify();
      const un = await listen('runtime:progress', (e) => {
        const p = e?.payload || {};
        if (typeof p.fraction === 'number') cm.runtime.fraction = p.fraction;
        cm.runtime.phase = p.phase || cm.runtime.phase;
        notify();
      });
      try {
        await operation('runtime', () => invoke('ensure_runtime'));
        Object.assign(cm.runtime, { state: 'ready', fraction: 1 });
        notify();
      } catch (e) {
        const error = String(e?.message ?? e);
        Object.assign(cm.runtime, { state: 'failed', error, network: /^download failed:/.test(error) });
        notify();
        throw e;
      } finally {
        un();
        ensuring = null;
      }
      await load({ force: true });
      afterReady();
    })();
    return ensuring;
  }

  async function boot() {
    const ready = await invoke('runtime_ready').catch(() => false);
    const hs = await invoke('check_handshake_state').catch(() => null);
    if (hs?.global_found) cm.runtime.ownCli = { version: hs.global_version || null, bundledFirst: !!hs.bundled_takes_precedence };
    cm.org = (await invoke('codemie_org_defaults').catch(() => null)) || null;
    if (ready) {
      cm.runtime.state = 'ready';
      await load({ force: true });
      afterReady();
    } else {
      ensureRuntime().catch(() => {});
      await load({ force: true });
    }
  }

  async function checkUrl(url) {
    const entry = runLog.start(`Check ${url} answers as CodeMie`);
    const r = (await invoke('codemie_url_check', { url }).catch((e) => ({ verdict: 'unreachable', status: null, detail: String(e?.message ?? e) }))) || {};
    entry.append(r.detail || '');
    entry.finish(r.verdict === 'codemie' ? 0 : 1);
    return { verdict: r.verdict || 'unreachable', status: r.status ?? null, detail: r.detail || '' };
  }

  const profileOp = (command, verb) => operation('profile', async () => {
    await run(command, { verb });
    await load({ force: true });
  });

  function switchProfile(name) {
    return profileOp(cmd.switchProfile(name), 'Switching profiles');
  }

  function renameProfile(from, to) {
    let command;
    try { command = cmd.renameProfile(from, to); } catch (e) { return Promise.reject(e); }
    return profileOp(command, 'Renaming the profile');
  }

  function deleteProfile(name) {
    let command;
    try { command = cmd.deleteProfile(name); } catch (e) { return Promise.reject(e); }
    return profileOp(command, 'Deleting the profile');
  }

  function signIn(url) {
    let command;
    try { command = cmd.login(url); } catch (e) { return Promise.reject(e); }
    return operation('signin', async () => {
      const r = await run(command, { stream: true, verb: 'Signing in' });
      // `profile login` exits 0 when it refuses; its ❌ / ✗ line is the only signal.
      const error = findLoginError(r.lines.map((l) => l.text));
      if (error) throw Object.assign(new Error(error.replace(/^\s*(✗|❌)\s*/, '')), { cmd: command, output: r.output, code: r.code });
      await readAuth();
      notify();
    });
  }

  function installAgent(name) {
    return agentOperation(name, async () => {
      notes.delete(name);
      try {
        await run(cmd.install(name), { stream: true, verb: 'Installing' });
      } finally {
        await load({ force: true });
      }
    });
  }

  function updateAgent(name) {
    return agentOperation(name, async () => {
      notes.delete(name);
      try {
        await run(cmd.update(name), { stream: true, verb: 'Updating' });
        const agent = (cm.agents || []).find((a) => a.command === name);
        if (agent) delete agent.belowMinimum;
      } finally {
        await load({ force: true });
      }
    });
  }

  function removeAgent(name) {
    return agentOperation(name, async () => {
      notes.delete(name);
      try {
        await run(cmd.uninstall(name), { stream: true, verb: 'Removing' });
      } finally {
        await load({ force: true });
      }
      // Removed, yet still listed: another copy lives outside CodeMie. Say where.
      const agent = (cm.agents || []).find((a) => a.command === name);
      if (agent?.installed) {
        const where = await run(cmd.commandPath(name), { check: false });
        const path = where.code === 0 ? where.output.split('\n').map((l) => l.trim()).find(Boolean) : null;
        const note = `Removed CodeMie’s copy. ${agent.name} is still installed ${path ? `at ${path}` : 'elsewhere'}, outside CodeMie.`;
        notes.set(name, note);
        agent.note = note;
        notify();
      }
    });
  }

  function connectApps(ids, profile) {
    const flags = ids.map((id) => APPS.find((a) => a.id === id)?.connectFlag).filter(Boolean);
    if (!flags.length) return Promise.reject(new Error('Nothing to connect.'));
    let command;
    try { command = cmd.proxyConnect(flags, profile); } catch (e) { return Promise.reject(e); }
    return operation('apps', async () => {
      try {
        await run(command, { verb: 'Connecting' });
      } finally {
        await Promise.all([refreshGateway(), refreshApps()]);
      }
    });
  }

  function disconnectApp(id) {
    const flag = APPS.find((a) => a.id === id)?.disconnectFlag;
    if (!flag) return Promise.reject(new Error('This CodeMie version can’t disconnect that app.'));
    return operation(`app:${id}`, async () => {
      try {
        await run(cmd.proxyDisconnect(flag), { verb: 'Disconnecting' });
      } finally {
        await Promise.all([refreshGateway(), refreshApps()]);
      }
    });
  }

  const gatewayOp = (build, profile, verb) => {
    let command;
    try { command = build(profile); } catch (e) { return Promise.reject(e); }
    return operation('gateway', async () => {
      try {
        await run(command, { verb });
      } finally {
        await refreshGateway();
      }
    });
  };

  async function runDoctor() {
    return operation('doctor', async () => {
      const r = await run(cmd.doctor, { stream: true, check: false });
      const records = parseDoctorOutput(r.stdout);
      const { rows, summary } = groupDoctorResults(records);
      cm.health = { rows, summary, checkedAt: now(), code: r.code };
      const failing = rows.filter((row) => row.group === 'tools' && row.status === 'fail').map((row) => row.label);
      for (const a of cm.agents || []) {
        if (a.installed && failing.some((label) => label === a.name || label.startsWith(`${a.name} `))) a.belowMinimum = true;
      }
      notify();
      return cm.health;
    }, { blocksQuit: false });
  }

  function updateCli() {
    return operation('cli', async () => {
      if (!cm.runtime.ownCli) {
        const v = await invoke('update_cli');
        if (v) cm.runtime.version = v;
        cm.runtime.checkedAt = now();
      } else {
        await run(cmd.selfUpdate, { stream: true, verb: 'Updating CodeMie' });
        await readVersion();
      }
      await load({ force: true });
    });
  }

  function checkCli() {
    if (!cm.runtime.ownCli) return updateCli();
    return operation('cli', async () => {
      const r = await run(cmd.selfUpdateCheck, { check: false });
      const versions = r.output.match(new RegExp(VERSION.source, 'g')) || [];
      cm.runtime.latest = versions.at(-1) || null;
      cm.runtime.checkedAt = now();
    }, { blocksQuit: false });
  }

  return {
    state: cm,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    busy: () => guarded > 0 || Object.keys(cm.busy).length > 0,
    boot,
    load,
    ensureRuntime,
    checkUrl,
    switchProfile,
    renameProfile,
    deleteProfile,
    signIn,
    installAgent,
    updateAgent,
    removeAgent,
    refreshGateway,
    refreshApps,
    connectApps,
    disconnectApp,
    startGateway: (profile) => gatewayOp(cmd.proxyStart, profile, 'Starting the gateway'),
    restartGateway: (profile) => gatewayOp(cmd.proxyRestart, profile, 'Restarting the gateway'),
    openDownload: (id) => invoke('open_app_download', { appId: id }),
    runDoctor,
    updateCli,
    checkCli,
    openInTerminal: ({ folder, launcher, profile }) => invoke('open_agent_in_terminal', { folder, launcher, profile }),
    pickFolder: () => invoke('pick_project_folder'),
    clearError(key) { delete cm.errors[key]; notify(); },
  };
}
