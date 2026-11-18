// Settings → CodeMie → Connected apps: the CodeMie gateway (one per Mac, `codemie proxy`) and
// the apps `codemie proxy connect` can point at it. Disconnect only where this CLI can undo it.
import { escapeHtml as e } from '../store.js';
import { icon } from '../icons.js';
import { badge, button, card, emptyState, select, settingRow, spinner } from '../ui.js';
import { APPS } from './catalog.js';
import { appState } from './model.js';
import { problem } from './view-common.js';

export function appsPanel(cm, ui = {}) {
  if (!cm.profiles.length) {
    return card({ body: emptyState({ iconName: 'plug', title: 'Sign in to CodeMie first', text: 'Connected apps use a CodeMie profile for model access.', actions: button('Sign in to CodeMie', { action: 'cm-setup-open', variant: 'primary' }) }) });
  }
  const anyConfigured = (cm.apps || []).some((a) => a.installed && a.configured);
  return `${anyConfigured ? gatewayCard(cm) : ''}${APPS.map((a) => appRow(cm, a, ui)).join('')}
    <p class="ws-muted ws-hint" style="margin-top:14px">Connect never edits these apps’ files itself — it asks the CodeMie CLI, and every command is listed in Health → What CodeMie ran.</p>`;
}

function gatewayCard(cm) {
  const g = cm.gateway;
  const running = g.state === 'running';
  const unhealthy = g.state === 'unhealthy';
  const busy = !!cm.busy.gateway;
  const profile = g.profile || cm.config.active;
  const options = cm.profiles.map((p) => [p.name, p.name === cm.config.active ? `${p.name} (active)` : p.name]);
  const control = busy ? `<span class="cm-status">${spinner('Working')}<span>Working…</span></span>`
    : running || unhealthy ? button('Restart', { action: 'cm-gateway-restart', iconName: 'refresh', title: 'Use if an app lost the connection' })
      : button('Start gateway', { action: 'cm-gateway-start', variant: 'primary', iconName: 'play' });
  const error = cm.errors.gateway ? problem({ title: 'The gateway did not start', text: cm.errors.gateway.message, retry: running ? 'cm-gateway-restart' : 'cm-gateway-start', cmd: 'codemie proxy', output: cm.errors.gateway.output }) : '';
  return card({
    title: 'CodeMie gateway', iconName: 'cpu', attrs: { style: 'margin-bottom:14px' },
    actions: running ? badge('Running', 'success', 'check') : unhealthy ? badge('Not answering', 'warning', 'alert') : badge('Stopped', 'warning', 'alert'),
    body: `${settingRow({ title: 'Profile for connected apps', text: 'Every connected app answers with this profile’s models and usage.', control: select(options, profile, { 'data-action': 'cm-gateway-profile', 'aria-label': 'Profile for connected apps', disabled: busy }) })}
      ${settingRow({ title: running ? `Running on this Mac${g.port ? ` · port ${g.port}` : ''}` : unhealthy ? 'Running, but not answering' : 'Not running', text: running ? 'Your connected apps reach CodeMie through it.' : 'Your apps cannot reach CodeMie until it runs. This usually happens after the Mac restarts.', control })}
      ${error}`,
  });
}

function appRow(cm, a, ui) {
  const state = appState(cm, a.id);
  const busy = ui.appBusy?.[a.id] || (cm.busy[`app:${a.id}`] ? 'Disconnecting…' : '');
  const err = ui.appErrors?.[a.id];
  const short = a.name.split(' — ')[0];
  const disconnect = a.disconnectFlag ? button('Disconnect', { action: 'cm-app-disconnect', variant: 'ghost', attrs: { 'data-id': a.id } }) : '';
  const states = {
    connected: ['cm-app-ok', badge('Connected', 'success', 'check'), a.text],
    disconnected: ['cm-app-warn', badge('Not answering', 'warning', 'alert'), 'Set up, but the CodeMie gateway is not running.'],
    not_set: ['', badge('Not connected', 'neutral'), `Found on this Mac. ${a.text}`],
    not_installed: ['', badge('Not on this Mac', 'neutral'), `Install it first, then connect it here. ${a.text}`],
  };
  const [cls, chip, text] = states[state];
  const actions = busy ? `<span class="cm-status">${spinner('Working')}<span>${e(busy)}</span></span>`
    : state === 'connected' ? disconnect
      : state === 'disconnected' ? `${button('Start gateway', { action: 'cm-gateway-start', variant: 'primary', iconName: 'play' })}${disconnect}`
        : state === 'not_set' ? button('Connect', { action: 'cm-app-connect', variant: 'primary', iconName: 'plug', attrs: { 'data-id': a.id } })
          : `${button('Get it', { action: 'cm-open-download', variant: 'ghost', iconName: 'external', attrs: { 'data-id': a.id } })}${button('Check again', { action: 'cm-apps-refresh', variant: 'ghost', iconName: 'refresh', attrs: { 'data-id': a.id } })}`;
  const manual = !a.disconnectFlag && (state === 'connected' || state === 'disconnected')
    ? `<p class="ws-muted ws-hint cm-app-note">To disconnect, remove CodeMie in ${e(short)}’s settings — this CodeMie version can’t do it yet.</p>` : '';
  const error = err ? problem({ title: err.title, text: err.text, retry: 'cm-app-connect', id: a.id, cmd: err.cmd, output: err.output, dismiss: 'cm-app-dismiss' }) : '';
  return `<div class="cm-app ${cls}" data-app="${e(a.id)}"><span class="cm-app-icon">${icon(a.icon)}</span><div class="cm-app-copy"><strong>${e(a.name)} ${chip}</strong><span>${e(text)}</span>${manual}</div><div class="ws-actions">${actions}</div>${error ? `<div class="cm-app-extra">${error}</div>` : ''}</div>`;
}
