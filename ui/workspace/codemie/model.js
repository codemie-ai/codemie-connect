// Pure derivations over the CodeMie state (`cm`, owned by service.js): how far setup got, what
// each agent and app is doing, what needs the person, and where the setup sheet starts.
import { APPS, BUILTIN_AGENT, launcherFor } from './catalog.js';

/** The CodeMie state before anything has been read. */
export function emptyCodemie() {
  return {
    loaded: false,
    // shadowed: an update went in, yet an older copy still runs first ({ version, message, output }).
    runtime: { state: 'unknown', fraction: 0, error: '', ownCli: null, version: null, latest: null, updating: false, shadowed: null },
    config: { state: 'no-configuration', active: null, account: null },
    profiles: [],
    auth: { state: 'unknown', detail: '' },
    agents: undefined, // undefined = not read yet, null = the read failed
    gateway: { state: 'unknown', port: null, profile: null },
    apps: [],
    health: null,
    org: null,
    busy: {},
    errors: {},
  };
}

/** One agent row (`codemie list` + `update --check`, plus `belowMinimum` from Health). */
export function agentStatus(agent, busy = false) {
  if (busy) return 'busy';
  if (!agent?.installed) return 'none';
  if (agent.belowMinimum) return 'too_old';
  if (agent.updateAvailable) return 'update';
  return 'ok';
}

/** Configured apps follow the gateway: they answer only while it runs. */
export function appState(cm, id) {
  const app = (cm.apps || []).find((a) => a.id === id);
  if (!app?.installed) return 'not_installed';
  if (!app.configured) return 'not_set';
  return cm.gateway?.state === 'running' ? 'connected' : 'disconnected';
}

const installedAgents = (cm) => (cm.agents || []).filter((a) => a.installed && a.command !== BUILTIN_AGENT);

export function setupProgress(cm, prefs = {}) {
  const account = cm.profiles.length > 0;
  const agent = installedAgents(cm).length > 0;
  const apps = APPS.some((a) => appState(cm, a.id) === 'connected') || !!prefs.appsSkipped;
  return { account, agent, apps, count: [account, agent, apps].filter(Boolean).length, complete: account && agent };
}

const unique = (list) => list.filter((v, i) => list.indexOf(v) === i);

/**
 * Everything that needs the person, most urgent first: Today banners, dots, Overview, Health.
 * An item with a `dismissKey` can be closed (an agent the person does not use, apps they left
 * stopped); `dismissed` holds the keys they closed. Sign-in and a broken config cannot be.
 */
export function attention(cm, dismissed = new Set()) {
  return allAttention(cm).filter((a) => !a.dismissKey || !dismissed.has(a.dismissKey));
}

function allAttention(cm) {
  const out = [];
  if (cm.runtime?.state === 'failed') {
    out.push({
      key: 'runtime-failed',
      title: 'CodeMie could not finish downloading',
      text: 'Connect needs about 60 MB once. Check your internet connection or VPN, then try again.',
      action: { label: 'Try again', action: 'cm-runtime-retry' },
    });
  }
  if (cm.config?.state === 'broken') {
    out.push({
      key: 'config-broken',
      title: 'Your CodeMie profile is no longer working',
      text: 'CodeMie can’t find the profile it was set to use, so coding agents and connected apps can’t start. Setting it up again takes a minute.',
      action: { label: 'Set up again', action: 'cm-setup-open' },
    });
  }
  const active = cm.config?.active;
  if (active && cm.auth?.state === 'not_signed_in' && cm.profiles.some((p) => p.name === active)) {
    out.push({
      key: 'signed-out',
      title: `CodeMie sign-in expired for “${active}”`,
      text: 'Coding agents and connected apps stop answering until you sign in again. It takes a few seconds in your browser.',
      action: { label: 'Sign in again', action: 'cm-profile-login', id: active },
    });
  }
  for (const a of (cm.agents || []).filter((x) => x.installed && x.belowMinimum)) {
    out.push({
      key: `agent-old:${a.command}`,
      // Closed for this version only: a later version that is still too old shows again.
      dismissKey: `agent-old:${a.command}@${a.version || ''}`,
      title: `${a.name} needs an update`,
      text: `${a.name}${a.version ? ` ${a.version}` : ''} is older than CodeMie supports, so ${launcherFor(a.command)} will not start.`,
      action: { label: 'Update', action: 'cm-agent-update', id: a.command },
    });
  }
  const configured = APPS.filter((a) => (cm.apps || []).some((x) => x.id === a.id && x.installed && x.configured));
  if (configured.length && cm.gateway?.state !== 'running' && cm.gateway?.state !== 'unknown') {
    const names = unique(configured.map((a) => a.name.split(' — ')[0])).join(' and ');
    out.push({
      key: 'gateway-stopped',
      dismissKey: 'gateway-stopped',
      title: `${names} can’t reach CodeMie`,
      text: 'The CodeMie gateway on this Mac is not running — usually after a restart. Starting it takes a second.',
      action: { label: 'Start gateway', action: 'cm-gateway-start' },
    });
  }
  return out;
}

/** Settings tabs that show a dot. Nothing before the first read, so a slow CLI never flashes dots. */
export function tabDots(cm, prefs = {}) {
  const dots = new Set();
  if (!cm.loaded) return dots;
  const keys = attention(cm, prefs.dismissed).map((a) => a.key);
  // Unfinished setup marks Overview until the person closes the Today card.
  if ((!setupProgress(cm, prefs).complete && !prefs.setupDismissed) || keys.length) dots.add('cm-overview');
  if (keys.includes('signed-out') || keys.includes('config-broken')) dots.add('cm-profiles');
  if (keys.some((k) => k.startsWith('agent-old:'))) dots.add('cm-agents');
  if (keys.includes('gateway-stopped')) dots.add('cm-apps');
  if (keys.includes('signed-out')) dots.add('ai');
  return dots;
}

/** Where the setup sheet opens, derived from CLI state so a reopened sheet resumes correctly. */
export function firstStep(cm, prefs = {}) {
  const p = setupProgress(cm, prefs);
  if (!p.account) return prefs.introduced ? 'signin' : 'welcome';
  if (!p.agent) return 'agents';
  if (!p.apps) return 'apps';
  return 'done';
}

/**
 * Open the sheet by itself once, and only on a Mac where nothing is set up: no CodeMie profile.
 * Someone who set CodeMie up themselves finds it in Settings → CodeMie instead.
 */
export function shouldAutoOpen(cm, prefs = {}) {
  return !prefs.introduced && !!cm.loaded && cm.profiles.length === 0;
}
