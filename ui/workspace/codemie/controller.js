// Settings → CodeMie: every `cm-*` action, the setup sheet's state, the Today card and banners,
// and the navigation dots. app.js delegates to it the way it does to the Automations controller.
// Views stay pure; this file owns what the person is doing (open dialogs, test results, drafts).
import { escapeHtml as e } from '../store.js';
import { icon } from '../icons.js';
import { button, field, textInput } from '../ui.js';
import { testResultLabel } from '../settings-ai.js';
import { attention, tabDots as dotsOf } from './model.js';
import { agentDisplay } from './catalog.js';
import { isSafe } from './cli.js';
import { banner, code } from './view-common.js';
import { overviewPanel, startableAgents } from './view-overview.js';
import { healthPanel } from './view-health.js';
import { profilesPanel } from './view-profiles.js';
import { agentsPanel } from './view-agents.js';

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

  // ---------------------------------------------------------------- setup sheet (Task 4 replaces)

  function openSheet() {
    toast('Guided setup arrives in the next task');
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
    switch (action) {
      case 'cm-start-agent':
        ui.startAgent = el.value;
        await render();
        return true;
      case 'cm-profile-switch':
        await switchProfile(el.value);
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

  async function profileLogin(name) {
    const p = profileNamed(name || cm.config.active);
    if (!p?.codemieUrl) {
      toast('This profile does not sign in with a browser.');
      return;
    }
    toast('Your browser opens to sign in…');
    try {
      await service.signIn(p.codemieUrl);
      toast(`Signed in again to “${p.name}”`, 'success');
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
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

  function input() {
    return false;
  }

  // ---------------------------------------------------------------- views

  const panels = {
    'cm-overview': () => overviewPanel(cm, prefs(), ui),
    'cm-profiles': () => profilesPanel(cm, ui),
    'cm-agents': () => agentsPanel(cm, ui, runLog),
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
    todayCard: () => '',
    settingsDot: () => tabDots().size > 0,
    tabDots,
    sheet: () => '',
    boot,
    onFocus,
    onQuitRequest,
    prefs,
    service,
  };
}
