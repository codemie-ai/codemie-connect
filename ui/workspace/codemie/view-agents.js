// Settings → CodeMie → Coding agents: every agent `codemie list` knows, installed first, then the
// built-in one, then the featured ones and the rest behind "Show more". Rows come from the CLI,
// so an agent a newer CLI adds appears with the CLI's own words.
import { escapeHtml as e } from '../store.js';
import { icon } from '../icons.js';
import { badge, button, card, emptyState, spinner } from '../ui.js';
import { BUILTIN_AGENT, agentDisplay, providerShort } from './catalog.js';
import { agentStatus } from './model.js';
import { code, menu, plural, problem } from './view-common.js';

const KIND = { install: ['Installing', 'was not installed', 'Nothing was installed and nothing was left behind.'], update: ['Updating', 'was not updated', ''], remove: ['Removing', 'was not removed', 'It is still installed.'] };
const activeProvider = (cm) => cm.profiles.find((p) => p.name === cm.config.active)?.provider || null;
const logo = (d, size = 40) => `<span class="cm-agent-logo" style="background:${e(d.color)};width:${size}px;height:${size}px">${e(d.mono)}</span>`;

export function agentsPanel(cm, ui = {}, runLog) {
  if (!cm.profiles.length) {
    return card({ body: emptyState({ iconName: 'terminal', title: 'Sign in to CodeMie first', text: 'Coding agents use your CodeMie profile for model access, so Connect asks for a sign-in before it installs one.', actions: button('Sign in to CodeMie', { action: 'cm-setup-open', variant: 'primary' }) }) });
  }
  if (cm.agents === undefined) {
    return card({ body: `<span class="cm-status">${spinner('Loading')}<span>${cm.runtime.state === 'ready' ? 'Reading your coding agents…' : 'Getting CodeMie ready first…'}</span></span>` });
  }
  if (cm.agents === null) {
    return card({ body: emptyState({ iconName: 'terminal', title: 'CodeMie could not list the agents', text: 'This usually clears up on its own. Try again, and check Health if it keeps happening.', actions: button('Try again', { action: 'cm-agents-refresh', variant: 'primary', iconName: 'refresh' }) }) });
  }
  const kinds = ui.agentKind || {};
  const rows = cm.agents.filter((a) => a.command !== BUILTIN_AGENT);
  const inst = rows.filter((a) => a.installed || kinds[a.command] === 'install');
  const avail = rows.filter((a) => !inst.includes(a));
  const updatable = inst.filter((a) => ['update', 'too_old'].includes(agentStatus(a)));
  const info = (a) => agentDisplay(a);
  // A row with a failure on it stays in view, whatever "Show more" says.
  const shown = (a) => ui.showAllAgents || !!ui.agentErrors?.[a.command];
  const main = avail.filter((a) => !info(a).editor && (info(a).featured || shown(a)));
  const editors = avail.filter((a) => info(a).editor && shown(a));
  const hidden = avail.length - main.length - editors.length;
  const builtin = cm.agents.find((a) => a.command === BUILTIN_AGENT);
  const provider = activeProvider(cm);
  const checking = !!ui.checkingAgents;
  const card_ = (a) => agentCard(cm, a, ui, runLog);
  return `<div class="cm-toolbar"><span class="cm-status"><strong>${inst.length} of ${rows.length}</strong> installed${updatable.length ? ` · ${plural(updatable.length, 'update')} available` : ' · all up to date'}</span>
      ${updatable.length > 1 ? button('Update all', { action: 'cm-agent-update-all', variant: 'primary', iconName: 'download' }) : ''}
      ${button(checking ? 'Checking…' : 'Check for updates', { action: 'cm-agent-check', variant: 'ghost', iconName: 'refresh', disabled: checking })}</div>
    <div class="cm-agents">${inst.map(card_).join('')}${builtin ? builtinCard(builtin) : ''}</div>
    ${main.length ? `<div class="cm-section-label">More agents</div><div class="cm-agents">${main.map(card_).join('')}</div>` : ''}
    ${editors.length ? `<div class="cm-section-label">For code editors · Zed, JetBrains (ACP)</div><div class="cm-agents">${editors.map(card_).join('')}</div>` : ''}
    ${hidden > 0 ? `<div class="cm-agents-more">${button(`Show ${hidden} more`, { action: 'cm-agents-more', variant: 'ghost', iconRight: 'chevron-down' })}</div>` : ''}
    <p class="ws-muted ws-hint" style="margin-top:16px">Agents install for your account only, into ${code('~/.codemie/agents')} — no administrator password.${provider ? ` Agents that don’t work with your active profile (${e(providerShort(provider))}) are marked.` : ''}</p>`;
}

function builtinCard(row) {
  const d = agentDisplay(row);
  return `<article class="cm-agent" data-agent="${e(row.command)}">${logo(d)}<div class="cm-agent-copy"><strong>${e(d.name)}${badge('Built in', 'neutral')}</strong><span>${e(d.desc)}</span><div class="cm-agent-meta"><span>Start with ${e(d.launcher)}</span></div></div><div class="cm-agent-actions">${button('', { action: 'cm-copy', iconName: 'copy', variant: 'ghost', title: `Copy ${d.launcher}`, attrs: { 'data-copy': d.launcher } })}</div></article>`;
}

/** The newest line the running command printed for this agent, for the progress row. */
function progressLine(runLog, command) {
  const entry = runLog?.list().slice().reverse().find((r) => r.code === null && r.cmd.split(' ')[2] === command);
  const line = entry?.output.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return line ? line.replace(/^-\s+/, '') : 'Starting…';
}

function agentCard(cm, row, ui, runLog) {
  const d = agentDisplay(row);
  const kind = ui.agentKind?.[row.command];
  const status = agentStatus(row, !!kind);
  const provider = activeProvider(cm);
  const fits = !provider || !d.providers || d.providers.includes(provider);
  const error = ui.agentErrors?.[row.command];
  const chip = {
    ok: badge(`Installed ${row.version || ''}`.trim(), 'success', 'check'),
    update: badge('Update available', 'info'),
    too_old: badge('Update needed', 'warning', 'alert'),
    busy: badge(KIND[kind]?.[0] || 'Working', 'info'),
    none: d.recommended && fits ? badge('Recommended', 'purple') : '',
  }[status] || '';
  let actions = '';
  if (status === 'none') {
    actions = fits
      ? button('Install', { action: 'cm-agent-install', variant: d.recommended ? 'primary' : 'secondary', iconName: 'download', attrs: { 'data-id': row.command } })
      : `<span class="ws-muted ws-hint" style="max-width:180px;text-align:right">Doesn’t work with ${e(providerShort(provider))} profiles</span>`;
  } else if (status !== 'busy') {
    actions = [
      ['update', 'too_old'].includes(status) ? button(row.latest ? `Update to ${row.latest}` : 'Update', { action: 'cm-agent-update', variant: 'primary', iconName: 'download', attrs: { 'data-id': row.command } }) : '',
      button('Open in Terminal…', { action: 'cm-open-terminal', variant: 'ghost', iconName: 'terminal', attrs: { 'data-id': row.command } }),
      menu(`cm-agent-${row.command}`, `More for ${d.name}`, [['copy', `Copy ${d.launcher}`, 'cm-agent-copy', row.command], ['refresh', 'Reinstall', 'cm-agent-update', row.command], null, ['trash', 'Remove…', 'cm-agent-remove', row.command, false, true]]),
    ].join('');
  }
  const meta = row.installed ? [`Start with ${d.launcher}`, d.maker] : [d.maker];
  let extra = '';
  if (status === 'busy') {
    extra = `<div class="cm-agent-busy cm-fade-in"><span class="cm-status">${spinner('Working')}<span>${e(progressLine(runLog, row.command))}</span></span></div>`;
  } else if (error) {
    const [, failed, note] = KIND[error.kind] || KIND.install;
    const kept = error.kind === 'update' && row.version ? `Your ${row.version} copy was kept.` : note;
    extra = problem({ title: `${d.name} ${failed}`, text: [error.message, kept].filter(Boolean).join(' '), retry: `cm-agent-${error.kind}`, id: row.command, cmd: error.cmd, output: error.output, dismiss: 'cm-agent-dismiss' });
  } else if (status === 'too_old') {
    extra = problem({ title: 'Update before using it', text: `${d.name}${row.version ? ` ${row.version}` : ''} is older than CodeMie supports, so ${d.launcher} will not start until it is updated.`, warn: true });
  } else if (row.note) {
    extra = `<p class="ws-inline-note" style="margin:0">${icon('info')}<span>${e(row.note)}</span></p>`;
  }
  return `<article class="cm-agent" data-agent="${e(row.command)}"${!fits && status === 'none' ? ' style="opacity:.7"' : ''}>
    ${logo(d)}
    <div class="cm-agent-copy"><strong>${e(d.name)}${chip}</strong><span>${e(d.desc)}</span><div class="cm-agent-meta">${meta.map((m) => `<span>${e(m)}</span>`).join('')}</div></div>
    <div class="cm-agent-actions">${actions}</div>
    ${extra ? `<div class="cm-agent-extra">${extra}</div>` : ''}
  </article>`;
}
