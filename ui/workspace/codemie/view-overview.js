// Settings → CodeMie → Overview: what needs the person, the setup checklist until setup is done
// (then four tiles, the profile switcher and "Start coding"), and the CodeMie CLI card.
import { escapeHtml as e } from '../store.js';
import { icon } from '../icons.js';
import { badge, button, card, select, settingRow, spinner } from '../ui.js';
import { APPS, BUILTIN_AGENT, agentDisplay, providerShort } from './catalog.js';
import { appState, attention, agentStatus, setupProgress } from './model.js';
import { banner, code, logBlock, markupRow, plural } from './view-common.js';

const activeProfile = (cm) => cm.profiles.find((p) => p.name === cm.config.active) || null;
const installed = (cm) => (cm.agents || []).filter((a) => a.installed && a.command !== BUILTIN_AGENT);
const connected = (cm) => APPS.filter((a) => appState(cm, a.id) === 'connected');
const configured = (cm) => APPS.filter((a) => (cm.apps || []).some((x) => x.id === a.id && x.configured));
const accountName = (cm) => cm.org?.organizationName ? `${cm.org.organizationName} CodeMie account` : 'EPAM account';
const percent = (cm) => Math.floor((cm.runtime.fraction || 0) * 100);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function overviewPanel(cm, prefs = {}, ui = {}) {
  const p = setupProgress(cm, prefs);
  return attention(cm, prefs.dismissed).map(banner).join('') + (p.complete ? ready(cm, ui, prefs) : checklist(cm, prefs)) + cliCard(cm);
}

function checklist(cm, prefs) {
  const p = setupProgress(cm, prefs);
  const done = [p.account, p.agent, p.apps];
  const next = done.indexOf(false);
  const st = (i) => (done[i] ? 'done' : i === next ? 'next' : 'todo');
  const row = (state, n, title, text, action, optional) => `<div class="cm-check-row" data-state="${state}"><span class="cm-check-num">${state === 'done' ? icon('check') : n}</span><div class="cm-check-copy"><strong>${e(title)}${optional ? '<span class="cm-optional">optional</span>' : ''}</strong><span>${e(text)}</span></div>${action}</div>`;
  const manage = (tab) => button('Manage', { action: 'cm-tab', variant: 'ghost', attrs: { 'data-tab': tab } });
  const profile = activeProfile(cm);
  const account = profile ? [cm.config.account, profile.codemieProject || providerShort(profile.provider), profile.model].filter(Boolean).join(' · ') : '';
  const apps = connected(cm);
  const downloading = cm.runtime.state === 'downloading'
    ? `<span class="cm-status">${spinner('Preparing')}<span>Getting CodeMie ready in the background · ${percent(cm)}%</span></span>` : '';
  return `<section class="cm-hero">
    <div class="cm-hero-top">
      <span class="cm-welcome-mark">${icon('spark')}</span>
      <div><h3>Set up CodeMie</h3><p>${e(`Sign in once and Connect gets your coding agents and apps working with your ${accountName(cm)}. About 3 minutes. No Terminal.`)}</p></div>
      <span class="cm-ring" style="--p:${Math.round((p.count / 3) * 100)}"><span>${p.count}/3</span></span>
    </div>
    <div class="cm-checklist">
      ${row(st(0), 1, 'Sign in to CodeMie', done[0] ? account : `Your ${accountName(cm)} in the browser, then a project and a model.`, done[0] ? manage('cm-profiles') : button('Sign in', { action: 'cm-setup-open', variant: 'primary' }))}
      ${row(st(1), 2, 'Install a coding agent', done[1] ? installed(cm).map((a) => agentDisplay(a).name).join(', ') : 'Claude Code is recommended. You can add others any time.', done[1] ? manage('cm-agents') : button('Choose agents', { action: 'cm-setup-open', variant: st(1) === 'next' ? 'primary' : 'secondary', disabled: !done[0] }))}
      ${row(st(2), 3, 'Connect your apps', apps.length ? `${apps.map((a) => a.name).join(', ')} use CodeMie models` : prefs.appsSkipped ? 'Skipped — connect any time' : 'Claude Desktop or VS Code answer with CodeMie models.', done[2] ? manage('cm-apps') : button('Connect', { action: 'cm-tab', attrs: { 'data-tab': 'cm-apps' }, disabled: !done[0] }), true)}
    </div>
    <div class="ws-actions">${button(p.count ? 'Continue guided setup' : 'Start guided setup', { action: 'cm-setup-open', variant: 'primary', iconRight: 'arrow' })}${downloading}</div>
  </section>`;
}

function ready(cm, ui, prefs = {}) {
  const p = activeProfile(cm);
  const att = attention(cm, prefs.dismissed);
  const agents = installed(cm);
  const updates = agents.filter((a) => ['update', 'too_old'].includes(agentStatus(a))).length;
  const apps = connected(cm);
  const gatewayDown = att.some((a) => a.key === 'gateway-stopped');
  const signedOut = cm.auth.state === 'not_signed_in';
  const tile = (tab, ico, title, chip, main, sub, warn) => `<button type="button" class="cm-tile${warn ? ' cm-tile-warn' : ''}" data-action="cm-tab" data-tab="${tab}"><span class="cm-tile-head">${icon(ico)}<strong>${e(title)}</strong>${chip}</span><span class="cm-tile-main">${e(main)}</span><span class="cm-tile-sub">${e(sub)}</span></button>`;
  const authChip = !p ? badge('None', 'neutral') : cm.auth.state === 'signed_in' ? badge('Signed in', 'success', 'check') : signedOut ? badge('Signed out', 'warning', 'alert') : '';
  const health = cm.health;
  const tiles = `<div class="cm-tiles">
    ${tile('cm-profiles', 'user', 'Active profile', authChip, p ? [p.name, p.model].filter(Boolean).join(' · ') : 'No profile', p ? [cm.config.account, p.codemieProject || providerShort(p.provider)].filter(Boolean).join(' · ') : 'Add a profile to start', signedOut)}
    ${tile('cm-agents', 'terminal', 'Coding agents', badge(`${agents.length} installed`, 'info'), agents.map((a) => agentDisplay(a).name).join(', '), updates ? `${plural(updates, 'update')} available` : 'All up to date', updates > 0)}
    ${tile('cm-apps', 'plug', 'Connected apps', gatewayDown ? badge('Not answering', 'warning') : apps.length ? badge(`${apps.length} connected`, 'success') : badge('None', 'neutral'), configured(cm).map((a) => a.name).join(', ') || 'No apps connected', gatewayDown ? 'Start the gateway to use CodeMie models again' : apps.length ? `Using profile ${cm.gateway.profile || cm.config.active}` : 'Optional — Claude Desktop, VS Code, Codex app', gatewayDown)}
    ${tile('cm-health', 'heart', 'Health', att.length ? badge(`${att.length} to fix`, 'warning') : badge('All good', 'success', 'check'), health ? `${health.summary.passing} of ${health.summary.total} checks fine` : att.length ? `${plural(att.length, 'thing')} need${att.length === 1 ? 's' : ''} you` : 'Everything works', health ? `Checked at ${clock(health.checkedAt)}` : 'Run a full check any time', att.length > 0)}
  </div>`;
  const switcher = cm.profiles.length > 1 ? card({
    body: settingRow({ iconName: 'swap', title: 'Active profile', text: 'Coding agents use this profile when they start. Connected apps keep the profile you chose for them.', control: select(cm.profiles.map((x) => [x.name, x.name]), cm.config.active, { 'data-action': 'cm-profile-switch', 'aria-label': 'Active profile', disabled: !!cm.busy.profile }) }),
    attrs: { style: 'margin-bottom:16px' },
  }) : '';
  return tiles + switcher + startCoding(cm, ui);
}

/** Agents a person can start: installed ones first, CodeMie's own last. */
export function startableAgents(cm) {
  const list = installed(cm);
  const builtin = (cm.agents || []).find((a) => a.command === BUILTIN_AGENT && a.installed);
  return builtin ? [...list, builtin] : list;
}

function startCoding(cm, ui) {
  const agents = startableAgents(cm);
  if (!agents.length || !cm.config.active) return '';
  const pick = agents.find((a) => a.command === ui.startAgent) || agents[0];
  const launcher = agentDisplay(pick).launcher;
  return card({
    title: 'Start coding', iconName: 'rocket',
    body: `<p class="ws-muted ws-hint" style="margin-bottom:12px">Coding agents run in a terminal, inside your project folder. Connect starts one for you with CodeMie already signed in: in its own terminal or in the Terminal app.</p>
      <div class="cm-agent-run">
        ${select(agents.map((a) => [a.command, agentDisplay(a).name]), pick.command, { 'data-action': 'cm-start-agent', 'aria-label': 'Agent to start' })}
        <span>runs ${code(launcher)} with profile <strong>${e(cm.config.active)}</strong></span>
        ${button('Copy', { action: 'cm-copy', iconName: 'copy', variant: 'ghost', attrs: { 'data-copy': `${launcher} --profile ${cm.config.active}` } })}
        ${button('Start coding…', { action: 'cm-open-terminal', iconName: 'terminal', variant: 'primary', attrs: { 'data-id': pick.command } })}
      </div>`,
  });
}

function cliCard(cm) {
  const r = cm.runtime;
  const own = !!r.ownCli;
  const isReady = r.state === 'ready';
  const version = r.version || r.ownCli?.version || '';
  let status = '';
  if (r.state === 'downloading') {
    status = `<div class="cm-agent-busy" style="padding-top:4px"><span>Downloading CodeMie for this Mac · ${percent(cm)}% — this happens once</span><div class="cm-progress"><span style="width:${percent(cm)}%"></span></div></div>`;
  }
  if (r.state === 'failed') {
    const text = r.network
      ? 'Check your internet connection or VPN, then try again. Nothing half-installed was kept.'
      : 'Setup stopped before it finished. The details are below and in the CodeMie log. Try again.';
    status = `<div class="cm-problem" style="margin-top:4px"><strong>${icon('alert')}CodeMie could not finish downloading</strong><p>${e(text)}</p><div class="ws-actions">${button('Try again', { action: 'cm-runtime-retry', variant: 'primary', iconName: 'refresh' })}</div>${logBlock('Prepare CodeMie', r.error, { always: true })}</div>`;
  }
  const latest = own && r.latest && r.latest !== version ? r.latest : null;
  const versionText = own
    ? 'Your own copy, installed with npm. Connect uses it and does not download another.'
    : 'Included with Connect. New versions install in the background when Connect starts. Profiles and agents are kept.';
  const busy = !!cm.busy.cli;
  // The new version went in behind an older copy that still runs first: installing again won't help.
  const shadowed = own ? r.shadowed : null;
  const doing = cm.busy.cli === 'install' && r.latest ? `Installing ${e(r.latest)}…` : 'Checking…';
  const control = !isReady ? '' : busy ? `<span class="cm-status">${spinner('Working')}<span>${doing}</span></span>`
    : shadowed ? button('Check again', { action: 'cm-cli-check', variant: 'ghost', iconName: 'refresh' })
      : latest ? button(`Install ${latest} now`, { action: 'cm-cli-update', variant: 'primary', iconName: 'download' })
        : button('Check for updates', { action: 'cm-cli-check', variant: 'ghost', iconName: 'refresh' });
  const problem = shadowed ? { title: `Connect still runs CodeMie ${shadowed.version}`, ...shadowed }
    : cm.errors.cli ? { title: 'CodeMie was not updated', ...cm.errors.cli } : null;
  const error = problem ? `<div class="cm-problem" style="margin-top:4px"><strong>${icon('alert')}${e(problem.title)}</strong><p>${e(problem.message)}</p>${logBlock('Update CodeMie', problem.output, { always: true })}</div>` : '';
  const terminal = own
    ? markupRow({ iconName: 'terminal', title: 'Terminal', html: `${code('codemie')} and agent commands like ${code('codemie-claude')} come from your npm copy. Agents Connect installs go to ${code('~/.codemie/agents')}.` })
    : markupRow({ iconName: 'terminal', title: 'Terminal can use CodeMie', html: `New Terminal windows have ${code('codemie')} and agent commands like ${code('codemie-claude')}.` });
  // data-menu: render() keeps it open once opened, so a click inside doesn't fold it.
  return `<details class="ws-advanced" data-menu="codemie-cli"${r.state !== 'ready' || latest ? ' open' : ''}><summary>${icon('chevron-right')}CodeMie CLI ${isReady && version ? `<span class="ws-muted" style="font-weight:400">· ${e(version)}</span>` : ''}${latest ? ` ${badge('Update ready', 'info')}` : ''}</summary>
    <div style="padding-bottom:12px">
      ${status}
      ${settingRow({ iconName: 'package', title: isReady && version ? `CodeMie ${version}` : 'CodeMie CLI', text: versionText, control })}
      ${error}
      ${terminal}
    </div>
  </details>`;
}
