// Settings → CodeMie: every `cm-*` action, the setup sheet's state, the Today card and banners,
// and the navigation dots. app.js delegates to it the way it does to the Automations controller.
// Views stay pure; this file owns what the person is doing (open dialogs, test results, drafts).
import { escapeHtml as e } from '../store.js';
import { icon } from '../icons.js';
import { button, field, textInput } from '../ui.js';
import { testResultLabel } from '../settings-ai.js';
import { appState, attention, firstStep, setupProgress, shouldAutoOpen, tabDots as dotsOf } from './model.js';
import { APPS, agentDisplay, providerShort } from './catalog.js';
import { isSafe } from './cli.js';
import { DEFAULT_CODEMIE_URL, normalizeCodemieUrl } from './url.js';
import { banner, code, hostOf } from './view-common.js';
import { sheetMarkup, draftProvider } from './view-sheet.js';
import { todayCard as todayCardView } from './view-today.js';
import { overviewPanel, startableAgents } from './view-overview.js';
import { healthPanel } from './view-health.js';
import { profilesPanel } from './view-profiles.js';
import { agentsPanel } from './view-agents.js';
import { appsPanel } from './view-apps.js';

const PREF = {
  introduced: 'codemie.setup.introduced',
  snoozedUntil: 'codemie.setup.snoozedUntil',
  appsSkipped: 'codemie.setup.appsSkipped',
  folders: 'codemie.start.folders',
};
const RENDER_EVERY_MS = 250;

export function createCodemieController(deps) {
  const {
    state, service, session, runLog, render, route, openModal, confirmModal, toast, writeText,
    localPref, setLocalPref, store, invoke, canRender = () => true, editing = () => false, now = Date.now,
  } = deps;
  const cm = service.state;
  // What the person is doing in these tabs; never derived from the CLI.
  const ui = {
    tests: {}, showAllAgents: false, expandedRan: null, startAgent: null, healthAutoRan: false,
    agentKind: {}, agentErrors: {}, checkingAgents: false, appBusy: {}, appErrors: {},
  };

  function prefs() {
    return {
      introduced: localPref(PREF.introduced, '') === '1',
      snoozedUntil: Number(localPref(PREF.snoozedUntil, '0')) || 0,
      appsSkipped: localPref(PREF.appsSkipped, '') === '1',
    };
  }

  // ---------------------------------------------------------------- rendering

  let renderTimer = null;
  let lastRender = 0;
  const visible = () => state.route === 'settings' || state.route === 'today';
  /** Service and run-log updates re-render at most every 250 ms, never under a field being typed in. */
  function scheduleRender() {
    if (renderTimer || !visible()) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      lastRender = now();
      if (!canRender() || editing()) return;
      Promise.resolve(render()).catch(() => {});
    }, Math.max(0, RENDER_EVERY_MS - (now() - lastRender)));
  }

  // ---------------------------------------------------------------- setup sheet

  let sh = null; // the open sheet: { mode, step, profile, saved, pending, d: draft }
  const URL_ERRORS = {
    empty: { title: 'Enter your CodeMie address', text: 'It is the address you open CodeMie at in the browser, for example https://codemie.your-company.com.' },
    invalid: { title: 'That is not a web address', text: 'Check for typos. It looks like https://codemie.your-company.com.' },
    insecure: { title: 'The address must start with https://', text: 'CodeMie sign-in only works over a secure connection. Ask your administrator for the https:// address.' },
  };

  function freeName() {
    const used = new Set(cm.profiles.map((p) => p.name));
    let name = 'default';
    for (let i = 2; used.has(name); i++) name = `codemie-${i}`;
    return name;
  }

  function newSheet(mode, step, extra = {}) {
    const apps = {};
    for (const a of APPS) apps[a.id] = a.id === 'claude-desktop' && appState(cm, a.id) === 'not_set';
    const hasAgent = (cm.agents || []).some((a) => a.installed && a.command !== 'codemie-code');
    return {
      mode, step, profile: null, saved: null, pending: null,
      d: {
        choice: 'codemie', sub: 'anthropic-subscription', provider: 'litellm', orgUrl: '', url: cm.org?.codemieUrl || DEFAULT_CODEMIE_URL,
        endpoint: '', key: '', awsRegion: '', awsAccessKey: '', awsSecret: '',
        signin: 'idle', browser: false, notice: null, error: null, signedInAs: null,
        name: freeName(), makeActive: mode === 'setup' || !cm.profiles.length, more: false, pick: null,
        agents: hasAgent ? [] : ['claude'], showAll: false, install: null, apps, appsRun: null,
        ...extra,
      },
    };
  }

  const afterAccountStep = () => {
    const p = setupProgress(cm, prefs());
    return !p.agent ? 'agents' : !p.apps ? 'apps' : 'done';
  };

  function openSheet({ mode = 'setup', profile } = {}) {
    if (sh && session.running()) {
      render();
      return;
    }
    if (mode === 'add') sh = newSheet('add', 'signin');
    else if (mode === 'edit') {
      const p = profileNamed(profile);
      if (!p) return;
      if (p.provider !== 'ai-run-sso' || !p.codemieUrl) {
        toast(`Change ${providerShort(p.provider)} profiles in Terminal with codemie setup.`);
        return;
      }
      sh = newSheet('edit', 'project');
      sh.profile = p.name;
      runSetup(sh, { mode: 'update', profile: p.name, provider: p.provider, url: p.codemieUrl });
    } else {
      sh = newSheet('setup', firstStep(cm, prefs()));
      if (!prefs().introduced) setLocalPref(PREF.introduced, '1');
    }
    render();
  }

  function waitForRuntime() {
    return new Promise((resolve) => {
      let off = () => {};
      const check = () => {
        if (cm.runtime.state === 'ready' || cm.runtime.state === 'failed') {
          off();
          resolve();
          return true;
        }
        return false;
      };
      if (!check()) off = service.subscribe(check);
    });
  }

  /** A failure the CLI shows on screen (`detectFailure`: `{ id, message, line }`), in our words. */
  function failureNotice(f) {
    if (f.id === 'ollamaDown') return `${(f.message || 'Ollama is not running').replace(/\.\s*$/, '')}. Open the Ollama app (it sits in the menu bar), then try again.`;
    return `CodeMie could not check your project’s settings${f.message ? ` (${f.message})` : ''}. Setup carries on.`;
  }

  /** Run `codemie setup` for the open sheet. Lists the CLI sends become the sheet's choice step. */
  async function runSetup(s, plan) {
    const d = s.d;
    const before = cm.config.active;
    d.signin = 'waiting';
    d.browser = false;
    d.notice = null;
    const ui = {
      onBrowser: () => { if (sh === s) { d.browser = true; render(); } },
      onFailure: (f) => { if (sh === s) { d.notice = failureNotice(f); render(); } },
      choose: (q) => new Promise((resolve) => {
        if (sh !== s) { resolve(q.recommended ?? 0); return; }
        if (d.signin === 'waiting') { d.signin = 'idle'; d.signedInAs ||= 'Signed in'; }
        s.step = 'project';
        s.pending = { ...q, resolve };
        d.pick = null;
        render();
      }),
    };
    // Logged without the screen: a provider's key can be echoed on it.
    const entry = runLog.start(plan.mode === 'update' ? `codemie setup (update ${plan.profile})` : 'codemie setup');
    try {
      const result = await service.hold(() => session.run(plan, ui));
      entry.append(`Saved profile ${result.profileName}`);
      entry.finish(0);
      // Read what the CLI wrote whether or not the sheet is still open.
      await service.load({ force: true });
      if (sh !== s) return;
      s.pending = null;
      d.signin = 'idle';
      if (s.mode === 'add' && !d.makeActive && before && before !== result.profileName) await service.switchProfile(before);
      s.saved = result.profileName;
      s.step = s.mode === 'setup' ? afterAccountStep() : 'done';
      if (s.mode === 'edit') toast(`Saved “${result.profileName}”`, 'success');
    } catch (err) {
      entry.append(err?.cancelled ? 'Stopped' : err?.message || String(err));
      entry.finish(err?.cancelled ? 130 : 1);
      // A cancelled or failed run may still have written to the config: read it, sheet open or not.
      service.load({ force: true }).catch(() => {});
      if (sh !== s) return;
      s.pending = null;
      d.signin = 'idle';
      if (s.mode === 'edit') {
        sh = null;
        if (!err?.cancelled) toast(err?.message || String(err), 'error');
      } else {
        s.step = 'signin';
        // The sentence only, never the driver's screen: it can hold a key typed into a prompt.
        d.error = err?.cancelled ? null : { title: 'Setup did not finish', text: `${err?.message || String(err)} Nothing was saved. Health → What CodeMie ran lists what Connect asked CodeMie.` };
      }
    } finally {
      render();
    }
  }

  async function startSignin() {
    const s = sh;
    if (!s) return;
    const d = s.d;
    d.error = null;
    if (s.mode === 'relogin') return relogin(s);
    if (d.choice === 'codemie') d.url = cm.org?.codemieUrl || DEFAULT_CODEMIE_URL;
    if (d.choice === 'org') {
      const checked = normalizeCodemieUrl(d.orgUrl);
      if (!checked.ok) {
        d.error = URL_ERRORS[checked.reason];
        return render();
      }
      d.url = checked.url;
      d.orgUrl = checked.url;
    }
    if (cm.runtime.state === 'failed') {
      d.error = { title: 'CodeMie is not downloaded yet', text: 'Sign-in needs the CodeMie CLI, and its download stopped. Check your connection, then use “Try again” at the bottom left.' };
      return render();
    }
    if (cm.runtime.state !== 'ready') {
      d.signin = 'queued';
      await render();
      await waitForRuntime();
      if (sh !== s || d.signin !== 'queued') return undefined;
      if (cm.runtime.state !== 'ready') {
        d.signin = 'idle';
        d.error = { title: 'CodeMie is not downloaded yet', text: 'Its download stopped. Check your connection, then use “Try again” at the bottom left.' };
        return render();
      }
    }
    const provider = draftProvider(d);
    if (d.choice === 'subscription') {
      const agent = d.sub === 'moonshot-subscription' ? 'kimi' : 'claude';
      if (!(cm.agents || []).some((a) => a.command === agent && a.installed)) {
        d.signin = 'installing';
        await render();
        try {
          await service.installAgent(agent);
        } catch (err) {
          if (sh !== s || d.signin !== 'installing') return undefined;
          d.signin = 'idle';
          d.error = { title: `${agent === 'kimi' ? 'Kimi Code' : 'Claude Code'} was not installed`, text: err?.message || String(err), cmd: err?.cmd, output: err?.output };
          return render();
        }
        // Cancel while it installed: the install stays, setup does not start.
        if (sh !== s || d.signin !== 'installing') return undefined;
      }
    }
    if (d.choice === 'org') {
      d.signin = 'checking';
      await render();
      const r = await service.checkUrl(d.url);
      if (sh !== s || d.signin !== 'checking') return undefined;
      if (r.verdict !== 'codemie') {
        d.signin = 'idle';
        const host = hostOf(d.url);
        d.error = r.verdict === 'not_codemie'
          ? { title: `${host} is not a CodeMie address`, text: 'It answered, but not like CodeMie. Check the address with your administrator — it is the one you open CodeMie at in the browser. Nothing was saved.', cmd: `Check ${d.url}`, output: r.detail }
          : r.verdict === 'invalid' ? URL_ERRORS.invalid
            : { title: `Could not reach ${host}`, text: 'Nothing answered at this address. If CodeMie runs inside your company or client network, connect to their VPN first, then try again. Nothing was saved.', cmd: `Check ${d.url}`, output: r.detail };
        return render();
      }
    }
    const fields = { endpoint: d.endpoint.trim(), key: d.key, awsRegion: d.awsRegion.trim(), awsAccessKey: d.awsAccessKey.trim(), awsSecret: d.awsSecret };
    const plan = { mode: 'add', provider, url: provider === 'ai-run-sso' ? d.url : undefined, fields, get name() { return s.d.name.trim(); } };
    // The run lasts as long as the person takes in the browser and the sheet: never awaited by
    // the click that started it (that would hold the button disabled for the whole setup).
    runSetup(s, plan).catch(() => {});
    return render();
  }

  async function relogin(s) {
    const d = s.d;
    d.signin = 'waiting';
    d.error = null;
    await render();
    try {
      await service.signIn(d.url);
      if (sh !== s) return;
      d.signin = 'done';
      await render();
      setTimeout(() => {
        if (sh !== s) return;
        sh = null;
        toast(`Signed in again to “${s.profile}”. Agents and apps using it work again.`, 'success');
        render();
      }, 900);
    } catch (err) {
      if (sh !== s) return;
      d.signin = 'idle';
      d.error = { title: `Could not reach CodeMie at ${hostOf(d.url)}`, text: `${err?.message || String(err)} This is usually the VPN — connect to it and try again. Nothing was changed.`, cmd: err?.cmd, output: err?.output };
      await render();
    }
  }

  async function continuePick() {
    const s = sh;
    const pending = s?.pending;
    if (!pending) return;
    const d = s.d;
    if (pending.id === 'model' && s.mode !== 'edit') {
      const name = d.name.trim();
      const problem = !isSafe('name', name) ? 'Use letters, numbers, dots or dashes for the profile name.'
        : cm.profiles.some((p) => p.name === name) ? `A profile called “${name}” already exists. Pick another name.` : '';
      if (problem) {
        d.more = true;
        d.error = { title: 'Choose another profile name', text: problem };
        return render();
      }
    }
    d.error = null;
    const index = Number.isInteger(d.pick) ? d.pick : pending.recommended ?? 0;
    s.pending = null;
    pending.resolve(index);
    return render();
  }

  async function cancelSignin() {
    const s = sh;
    if (!s) return;
    if (s.mode === 'relogin') {
      sh = null;
      return render();
    }
    if (session.running()) await session.cancel();
    if (sh !== s) return;
    s.pending = null;
    s.d.signin = 'idle';
    if (s.mode === 'edit') sh = null;
    else s.step = 'signin';
    return render();
  }

  async function closeSheet({ quiet = false } = {}) {
    const s = sh;
    if (!s) return;
    sh = null;
    if (session.running()) await session.cancel();
    if (!quiet) {
      const complete = setupProgress(cm, prefs()).complete;
      if (s.mode === 'setup' && s.step === 'done') toast('CodeMie is ready.', 'success');
      else if (s.mode === 'setup' && !complete) toast('Setup paused. Everything so far is saved — continue from Today or Settings → CodeMie.');
    }
    await render();
  }

  async function setupInstall() {
    const s = sh;
    const d = s.d;
    const todo = d.agents.filter((c) => !(cm.agents || []).some((a) => a.command === c && a.installed));
    if (!todo.length) return;
    const run = { state: 'running', failed: null, tasks: todo.map((command) => ({ command, label: agentDisplay(agentRow(command) || { command, name: command }).name, state: 'todo', detail: '' })) };
    d.install = run;
    await render();
    for (const t of run.tasks) {
      t.state = 'running';
      t.detail = 'installing';
      await render();
      try {
        await service.installAgent(t.command);
        t.state = 'done';
        t.detail = `start with ${agentDisplay(agentRow(t.command) || { command: t.command }).launcher}`;
      } catch (err) {
        t.state = 'failed';
        t.detail = 'not installed — nothing left behind';
        run.failed = { title: `${t.label} was not installed`, text: `${err?.message || String(err)} Try again now, or later from Settings → CodeMie.`, cmd: err?.cmd, output: err?.output };
      }
      await render();
    }
    d.agents = run.tasks.filter((t) => t.state === 'failed').map((t) => t.command);
    run.state = run.failed ? 'partial' : 'done';
    await render();
  }

  async function setupApps() {
    const s = sh;
    const d = s.d;
    const picked = APPS.filter((a) => d.apps[a.id] && appState(cm, a.id) === 'not_set');
    if (!picked.length) return;
    const run = { state: 'running', failed: null, tasks: [{ label: 'Start the CodeMie gateway on this Mac', state: 'running' }, ...picked.map((a) => ({ label: `Point ${a.name} at CodeMie`, state: 'running' }))] };
    d.appsRun = run;
    await render();
    try {
      await service.connectApps(picked.map((a) => a.id), gatewayProfile());
      run.tasks.forEach((t) => { t.state = 'done'; });
      run.state = 'done';
    } catch (err) {
      run.tasks.forEach((t) => { t.state = 'failed'; });
      run.state = 'failed';
      run.failed = { title: 'Your apps were not connected', text: `${err?.message || String(err)} Nothing in the apps was changed. You can connect them later from Settings → CodeMie.`, cmd: err?.cmd, output: err?.output };
    }
    await render();
  }

  function sheetNext() {
    if (!sh) return;
    sh.d.install = null;
    sh.d.appsRun = null;
    sh.step = sh.step === 'agents' && !setupProgress(cm, prefs()).apps ? 'apps' : 'done';
    render();
  }

  /** Sheet clicks; false when the action is not the sheet's. */
  async function sheetAction(action, el) {
    const d = sh?.d;
    switch (action) {
      case 'cm-sheet-close': await closeSheet(); return true;
      case 'cm-sheet-later': await closeSheet({ quiet: true }); toast('You can finish setting up CodeMie from Today or Settings → CodeMie.'); return true;
      case 'cm-sheet-settings': await closeSheet({ quiet: true }); await route('settings', 'cm-overview'); return true;
      case 'cm-setup-snooze':
        setLocalPref(PREF.snoozedUntil, String(now() + 24 * 3600 * 1000));
        await render();
        return true;
      default: break;
    }
    if (!sh) return false;
    switch (action) {
      case 'cm-sheet-go':
        if (el.dataset.mode) Object.assign(sh, newSheet(el.dataset.mode, el.dataset.step));
        else sh.step = el.dataset.step;
        await render();
        return true;
      case 'cm-found-use':
        sh.step = afterAccountStep();
        await render();
        return true;
      case 'cm-signin-start': await startSignin(); return true;
      case 'cm-signin-cancel': await cancelSignin(); return true;
      case 'cm-pick-continue': await continuePick(); return true;
      case 'cm-org-pick':
        d.orgUrl = el.dataset.url || '';
        d.error = null;
        await render();
        return true;
      case 'cm-draft-toggle':
        d[el.dataset.key] = !d[el.dataset.key];
        await render();
        return true;
      case 'cm-setup-install': await setupInstall(); return true;
      case 'cm-setup-apps': await setupApps(); return true;
      case 'cm-apps-skip':
        setLocalPref(PREF.appsSkipped, '1');
        sh.step = 'done';
        await render();
        return true;
      case 'cm-sheet-next': sheetNext(); return true;
      default: return false;
    }
  }

  /** Sheet radios, selects and checkboxes; false when the control is not the sheet's. */
  async function sheetChange(el) {
    const d = sh?.d;
    const action = el?.dataset?.action;
    if (!d || !action) return false;
    switch (action) {
      case 'cm-draft-radio':
      case 'cm-draft-select':
        d[el.dataset.key] = el.value;
        d.error = null;
        break;
      case 'cm-draft-check':
        d[el.dataset.key] = !!el.checked;
        break;
      case 'cm-pick':
        d.pick = Number(el.value);
        break;
      case 'cm-agent-pick':
        d.agents = el.checked ? [...new Set([...d.agents, el.value])] : d.agents.filter((c) => c !== el.value);
        break;
      case 'cm-app-pick':
        d.apps[el.dataset.id] = !!el.checked;
        break;
      default:
        return false;
    }
    await render();
    return true;
  }

  // ---------------------------------------------------------------- Overview: Start coding

  function recentFolders() {
    try {
      const list = JSON.parse(localPref(PREF.folders, '[]'));
      return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p) : [];
    } catch {
      return [];
    }
  }

  function rememberFolder(folder) {
    setLocalPref(PREF.folders, JSON.stringify([folder, ...recentFolders().filter((p) => p !== folder)].slice(0, 5)));
  }

  async function launch(command, folder) {
    const row = startableAgents(cm).find((a) => a.command === command);
    if (!row) return;
    const d = agentDisplay(row);
    await service.openInTerminal({ folder, launcher: d.launcher, profile: cm.config.active });
    rememberFolder(folder);
    toast(`Terminal opened in ${folder} with ${d.name}`, 'success');
  }

  function openTerminal(command) {
    const agents = startableAgents(cm);
    const row = agents.find((a) => a.command === command) || agents[0];
    if (!row || !cm.config.active) {
      toast('Install a coding agent and sign in first.');
      return;
    }
    const d = agentDisplay(row);
    const folders = recentFolders();
    const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
    const list = folders.length
      ? `<div class="cm-choices">${folders.map((p, i) => `<label class="cm-choice"><input type="radio" name="folder" value="${e(p)}" ${i === 0 ? 'checked' : ''}><span class="cm-choice-mark"></span>${icon('folder')}<span class="cm-choice-copy"><strong>${e(base(p))}</strong><span>${e(p)}</span></span></label>`).join('')}</div>`
      : '<p class="ws-muted ws-hint">Pick the folder of the project you want to work on.</p>';
    openModal({
      title: `Start ${d.name}`, subtitle: 'Choose the project folder to work in.', size: 'md',
      submit: folders.length ? 'Open in Terminal' : '',
      body: `${list}
        <p style="margin-top:10px">${button('Choose another folder…', { action: 'cm-folder-pick', variant: folders.length ? 'ghost' : 'primary', iconName: 'folder', attrs: { 'data-id': row.command } })}</p>
        <p class="ws-muted ws-hint" style="margin-top:8px">Terminal opens in that folder and runs ${code(`${d.launcher} --profile ${cm.config.active}`)}. Type what you want done when it starts.</p>`,
      onSubmit: (form) => launch(row.command, String(form.get('folder') || '')),
    });
  }

  async function pickAndLaunch(el) {
    const folder = await service.pickFolder();
    if (!folder) return;
    el?.closest?.('.ws-modal')?.close();
    await launch(el?.dataset?.id, folder);
  }

  // ---------------------------------------------------------------- Coding agents

  const agentRow = (command) => (cm.agents || []).find((a) => a.command === command);
  const JOBS = { install: 'installAgent', update: 'updateAgent', remove: 'removeAgent' };

  /** Install, update or remove one agent. A failure stays on the agent's row, not in a toast. */
  async function agentJob(command, kind) {
    const row = agentRow(command);
    if (!row || ui.agentKind[command]) return;
    const d = agentDisplay(row);
    delete ui.agentErrors[command];
    ui.agentKind[command] = kind;
    await render();
    try {
      await service[JOBS[kind]](command);
      if (kind === 'remove') toast(`Removed ${d.name}`, 'success');
      else toast(`${d.name} is ready — start it with ${d.launcher}`, 'success');
    } catch (err) {
      // Refused before anything ran (another agent is busy): nothing to show on the row.
      if (err?.cmd === undefined) toast(err?.message || String(err));
      else ui.agentErrors[command] = { kind, message: err.message, cmd: err.cmd, output: err.output ?? '' };
    } finally {
      delete ui.agentKind[command];
      await render();
    }
  }

  function removeAgent(command) {
    const row = agentRow(command);
    if (!row) return undefined;
    const d = agentDisplay(row);
    return confirmModal({
      title: `Remove ${d.name}?`, text: `${d.launcher} stops working on this Mac. Your projects and CodeMie profiles are not touched. You can install it again any time.`,
      confirm: 'Remove', variant: 'danger', initialFocus: 'cancel', guard: true,
      onConfirm: () => { agentJob(command, 'remove'); },
    });
  }

  async function updateAll() {
    const rows = (cm.agents || []).filter((a) => a.installed && (a.updateAvailable || a.belowMinimum));
    for (const row of rows) await agentJob(row.command, 'update');
  }

  async function checkAgents() {
    ui.checkingAgents = true;
    await render();
    try {
      await service.load({ force: true });
    } finally {
      ui.checkingAgents = false;
      await render();
    }
  }

  // ---------------------------------------------------------------- Connected apps

  const appInfo = (id) => APPS.find((a) => a.id === id);
  const gatewayProfile = () => cm.gateway.profile || cm.config.active;

  async function appConnect(id) {
    const a = appInfo(id);
    if (!a || ui.appBusy[id]) return;
    delete ui.appErrors[id];
    ui.appBusy[id] = 'Connecting…';
    await render();
    try {
      await service.connectApps([id], gatewayProfile());
      toast(`${a.name} now answers with CodeMie models. Restart it if it was open.`, 'success');
    } catch (err) {
      ui.appErrors[id] = { title: `${a.name} was not connected`, text: `${err?.message || String(err)} Nothing in the app was changed.`, cmd: err?.cmd, output: err?.output ?? '' };
    } finally {
      delete ui.appBusy[id];
      await render();
    }
  }

  function appDisconnect(id) {
    const a = appInfo(id);
    if (!a?.disconnectFlag) return undefined;
    return confirmModal({
      title: `Disconnect ${a.name}?`, text: `${a.name} goes back to its own sign-in. Your chats and settings there are not affected. You can connect it again any time.`,
      confirm: 'Disconnect', variant: 'danger', initialFocus: 'cancel',
      onConfirm: async () => {
        await service.disconnectApp(id);
        toast(`${a.name} is disconnected from CodeMie`, 'success');
      },
    });
  }

  async function gateway(restart, profile = gatewayProfile()) {
    try {
      await (restart ? service.restartGateway(profile) : service.startGateway(profile));
    } catch {
      // the gateway card shows what went wrong
    }
  }

  // ---------------------------------------------------------------- Overview: CLI, Health

  async function cliCheck(update) {
    const before = cm.runtime.version;
    try {
      await (update ? service.updateCli() : service.checkCli());
    } catch {
      return; // the CLI card shows what went wrong
    }
    if (cm.runtime.version && cm.runtime.version !== before) toast(`CodeMie ${cm.runtime.version} is installed. Profiles and agents are kept.`, 'success');
    else if (!cm.runtime.ownCli || !cm.runtime.latest || cm.runtime.latest === cm.runtime.version) toast('CodeMie is up to date.');
  }

  function runDoctor() {
    service.runDoctor().catch(() => {}); // Health shows the failure
  }

  // ---------------------------------------------------------------- actions

  async function handle(action, el) {
    if (!action.startsWith('cm-')) return false;
    if (await sheetAction(action, el)) return true;
    const id = el?.dataset?.id;
    switch (action) {
      case 'cm-tab': await route('settings', el.dataset.tab); return true;
      case 'cm-setup-open': openSheet(); return true;
      case 'cm-runtime-retry': await service.ensureRuntime().catch(() => {}); return true;
      case 'cm-copy':
        await writeText(el.dataset.copy || '');
        toast('Copied', 'success');
        return true;
      case 'cm-copy-all':
        await writeText(runLog.text());
        toast('Copied what CodeMie ran', 'success');
        return true;
      case 'cm-ran-toggle':
        ui.expandedRan = ui.expandedRan === Number(id) ? null : Number(id);
        await render();
        return true;
      case 'cm-doctor': runDoctor(); return true;
      case 'cm-cli-update': await cliCheck(true); return true;
      case 'cm-cli-check': await cliCheck(false); return true;
      case 'cm-open-terminal': openTerminal(id); return true;
      case 'cm-folder-pick': await pickAndLaunch(el); return true;
      case 'cm-profile-activate': await switchProfile(id); return true;
      case 'cm-profile-login': await profileLogin(id); return true;
      case 'cm-profile-test': await testProfile(id); return true;
      case 'cm-profile-rename': renameProfile(id); return true;
      case 'cm-profile-delete': await deleteProfile(id); return true;
      case 'cm-profile-edit': openSheet({ mode: 'edit', profile: id }); return true;
      case 'cm-profile-add': openSheet({ mode: 'add' }); return true;
      case 'cm-agent-install': await agentJob(id, 'install'); return true;
      case 'cm-agent-update': await agentJob(id, 'update'); return true;
      case 'cm-agent-remove': await removeAgent(id); return true;
      case 'cm-agent-update-all': await updateAll(); return true;
      case 'cm-agent-check': await checkAgents(); return true;
      case 'cm-agents-refresh': await checkAgents(); return true;
      case 'cm-agents-more': ui.showAllAgents = true; await render(); return true;
      case 'cm-agent-dismiss': delete ui.agentErrors[id]; await render(); return true;
      case 'cm-app-connect': await appConnect(id); return true;
      case 'cm-app-disconnect': await appDisconnect(id); return true;
      case 'cm-app-dismiss': delete ui.appErrors[id]; await render(); return true;
      case 'cm-apps-refresh': await service.refreshApps(); return true;
      case 'cm-open-download': await service.openDownload(id); return true;
      case 'cm-gateway-start': await gateway(false); return true;
      case 'cm-gateway-restart': await gateway(true); return true;
      case 'cm-agent-copy': {
        const row = agentRow(id);
        if (row) {
          await writeText(agentDisplay(row).launcher);
          toast('Copied', 'success');
        }
        return true;
      }
      case 'cm-profile-file':
        await writeText('~/.codemie/codemie-cli.config.json');
        toast('Copied the configuration file path', 'success');
        return true;
      default:
        return false;
    }
  }

  async function change(el) {
    const action = el?.dataset?.action;
    if (!action?.startsWith('cm-')) return false;
    if (await sheetChange(el)) return true;
    switch (action) {
      case 'cm-start-agent':
        ui.startAgent = el.value;
        await render();
        return true;
      case 'cm-profile-switch':
        await switchProfile(el.value);
        return true;
      case 'cm-gateway-profile':
        if (el.value && el.value !== cm.gateway.profile) await gateway(true, el.value);
        return true;
      default:
        return false;
    }
  }

  async function switchProfile(name) {
    if (!name || name === cm.config.active) return;
    await service.switchProfile(name);
    toast(`“${name}” is now the active profile`, 'success');
  }

  // ---------------------------------------------------------------- Profiles

  const profileNamed = (name) => cm.profiles.find((p) => p.name === name);
  const configuredApps = () => (cm.apps || []).filter((a) => a.installed && a.configured);

  /** Sign in again: a compact dialog that starts the browser sign-in at once and closes on success. */
  async function profileLogin(name) {
    const p = profileNamed(name || cm.config.active);
    if (!p?.codemieUrl) {
      toast('This profile does not sign in with a browser.');
      return;
    }
    if (session.running()) {
      toast('Finish or close the setup that is running first.');
      return;
    }
    sh = newSheet('relogin', 'signin', { url: p.codemieUrl });
    sh.profile = p.name;
    await relogin(sh);
  }

  async function testProfile(name) {
    ui.tests[name] = { busy: true };
    await render();
    try {
      const result = await store.query('ai_test', { profileId: `codemie:${name}` });
      ui.tests[name] = { ok: !!result?.ok, text: testResultLabel(result || {}) };
    } catch (err) {
      ui.tests[name] = { ok: false, text: err?.message || String(err) };
    }
    await render();
  }

  function renameProfile(name) {
    const p = profileNamed(name);
    if (!p) return;
    openModal({
      title: 'Rename profile', size: 'sm', submit: 'Rename',
      body: field('New name', textInput({ name: 'name', value: p.name, required: true, maxlength: 64, spellcheck: 'false', autocomplete: 'off' }), 'Letters, numbers, dots and dashes.'),
      onSubmit: async (form) => {
        const next = String(form.get('name') || '').trim();
        if (next === p.name) return;
        if (cm.profiles.some((x) => x.name === next)) throw new Error(`A profile called “${next}” already exists.`);
        if (!isSafe('name', next)) throw new Error('Letters, numbers, dots and dashes only, starting with a letter or a number.');
        const gatewayUsed = cm.gateway.profile === p.name && cm.gateway.state === 'running';
        await service.renameProfile(p.name, next);
        if (gatewayUsed) await service.restartGateway(next);
        toast(`Renamed to “${next}”`, 'success');
      },
    });
  }

  function deleteProfile(name) {
    const p = profileNamed(name);
    if (!p) return undefined;
    const active = p.name === cm.config.active;
    const others = cm.profiles.filter((x) => x.name !== p.name);
    const next = active ? others[0] : profileNamed(cm.config.active) || others[0];
    const usedByApps = cm.gateway.profile === p.name && configuredApps().length > 0;
    const text = (active
      ? next ? `“${p.name}” is the active profile. After deleting it, “${next.name}” becomes active.` : 'This is your only profile. Coding agents stop working until you sign in again.'
      : 'Your CodeMie account and project are not affected.')
      + (usedByApps && next ? ` Connected apps switch to “${next.name}”.` : '')
      + ' Its sign-in is removed from this Mac. This cannot be undone.';
    return confirmModal({
      title: `Delete profile “${p.name}”?`, text, confirm: 'Delete profile', variant: 'danger', initialFocus: 'cancel', guard: true,
      onConfirm: async () => {
        await service.deleteProfile(p.name);
        if (active && next) await service.switchProfile(next.name);
        if (usedByApps && next) await service.restartGateway(next.name);
        toast(`Deleted “${p.name}”`, 'success');
      },
    });
  }

  /** Typing in the sheet goes into its draft without a render, so the field keeps focus. */
  function input(el) {
    const key = el?.dataset?.draft;
    if (!key || !sh || !el.closest?.('#cm-sheet-host')) return false;
    sh.d[key] = el.value;
    return true;
  }

  // ---------------------------------------------------------------- views

  const panels = {
    'cm-overview': () => overviewPanel(cm, prefs(), ui),
    'cm-profiles': () => profilesPanel(cm, ui),
    'cm-agents': () => agentsPanel(cm, ui, runLog),
    'cm-apps': () => appsPanel(cm, ui),
    'cm-health': () => {
      // Opening Health checks once per session, as the legacy screen did.
      if (!ui.healthAutoRan && cm.loaded && cm.profiles.length && cm.runtime.state === 'ready' && !cm.health) {
        ui.healthAutoRan = true;
        setTimeout(runDoctor, 0);
      }
      return healthPanel(cm, runLog, ui);
    },
  };

  function panel(tab) {
    return panels[tab]?.() ?? '';
  }

  function headerActions(tab) {
    if (tab === 'cm-profiles' && cm.profiles.length) {
      return button('Add profile', { action: 'cm-profile-add', iconName: 'plus', variant: 'primary' });
    }
    if (tab === 'cm-health' && cm.health) {
      return button(cm.busy.doctor ? 'Checking…' : 'Check everything again', { action: 'cm-doctor', iconName: 'refresh', disabled: !!cm.busy.doctor });
    }
    return '';
  }

  function banners(currentRoute) {
    if (currentRoute !== 'today') return '';
    return attention(cm).map(banner).join('');
  }

  const tabDots = () => dotsOf(cm, prefs());

  // ---------------------------------------------------------------- lifecycle

  async function boot() {
    service.subscribe(scheduleRender);
    runLog.subscribe(scheduleRender);
    await service.boot();
    // First launch: the sheet opens by itself once, at the step CLI state says comes first.
    if (!sh && shouldAutoOpen(cm, prefs())) {
      sh = newSheet('setup', firstStep(cm, prefs()));
      setLocalPref(PREF.introduced, '1');
      await render();
    }
  }

  function onFocus() {
    service.load().catch(() => {});
  }

  /** Quit while something runs: ask, then stop setup, release the quit guard and quit. */
  async function onQuitRequest() {
    if (!session.running() && !service.busy()) return undefined;
    return confirmModal({
      title: 'Quit while CodeMie is working?',
      text: 'Setup or an install is still running. Quitting stops it. Everything finished so far is kept, and setup continues where it left off next time.',
      confirm: 'Quit', variant: 'danger', initialFocus: 'cancel', guard: true,
      onConfirm: async () => {
        if (session.running()) await session.cancel();
        await invoke('workspace_installer_busy', { busy: false });
        await invoke('close_app');
      },
    });
  }

  return {
    handle,
    change,
    input,
    panel,
    headerActions,
    banners,
    todayCard: (at = now()) => todayCardView(cm, prefs(), at),
    settingsDot: () => tabDots().size > 0,
    tabDots,
    sheet: () => (sh ? sheetMarkup(sh, cm, prefs()) : ''),
    boot,
    onFocus,
    onQuitRequest,
    prefs,
    service,
  };
}
