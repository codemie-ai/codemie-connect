// Settings → CodeMie → Profiles: one card per CodeMie profile — what it signs in to, its project
// and model — with the actions the CLI offers for it. Only the active profile has a known
// sign-in state (`codemie profile status` reports the active profile only).
import { escapeHtml as e } from '../store.js';
import { icon } from '../icons.js';
import { badge, button, card, emptyState, spinner } from '../ui.js';
import { PROVIDERS, providerShort } from './catalog.js';
import { isSafe } from './cli.js';
import { hostOf, menu } from './view-common.js';

const PROVIDER_ICON = { 'ai-run-sso': 'spark', 'anthropic-subscription': 'spark', 'moonshot-subscription': 'spark', litellm: 'globe', bedrock: 'globe', ollama: 'cpu' };
const providerName = (id) => PROVIDERS.find((p) => p[0] === id)?.[1] || id || 'Unknown provider';
const isSso = (p) => p.provider === 'ai-run-sso';

export function profilesPanel(cm, ui = {}) {
  if (!cm.profiles.length) {
    return card({
      body: emptyState({
        iconName: 'user', title: 'No CodeMie profile yet',
        text: 'A profile is a saved sign-in plus the project and model to use. Sign in with your CodeMie account to create the first one.',
        actions: button('Sign in to CodeMie', { action: 'cm-setup-open', variant: 'primary', iconName: 'link' }),
      }),
    });
  }
  const note = `<p class="ws-inline-note">${icon('info')}<span>The <strong>active</strong> profile is what coding agents use when they start. Switching takes effect the next time an agent starts.</span></p>`;
  return note + cm.profiles.map((p) => profileCard(cm, p, ui)).join('');
}

function testLine(test) {
  if (!test) return '';
  if (test.busy) return `<span class="cm-status">${spinner('Testing')}<span>Asking the model to reply…</span></span>`;
  return `<span class="cm-status" style="color:var(--ws-${test.ok ? 'green' : 'red'})">${icon(test.ok ? 'check-circle' : 'alert')}<span>${e(test.text)}</span></span>`;
}

function profileCard(cm, p, ui) {
  const active = p.name === cm.config.active;
  const safe = isSafe('name', p.name);
  const signedOut = active && cm.auth.state === 'not_signed_in';
  const chips = [
    active ? badge('Active', 'purple', 'check') : '',
    active && cm.auth.state === 'signed_in' ? badge('Signed in', 'success') : '',
    signedOut ? badge('Signed out', 'warning', 'alert') : '',
  ].join('');
  const address = p.codemieUrl || p.baseUrl;
  const facts = [
    ['Account', isSso(p) && active ? cm.config.account || '—' : '—'],
    ['Provider', providerShort(p.provider)],
    ['Project', p.codemieProject || '—'],
    ['Model', p.model || '—'],
    [isSso(p) ? 'Server' : 'Address', address ? hostOf(address) : '—'],
  ];
  const test = ui.tests?.[p.name];
  const busy = !!cm.busy.profile || !!cm.busy.signin;
  const expired = signedOut
    ? `<div class="cm-problem cm-problem-warn"><strong>${icon('alert')}Signed out</strong><p>The sign-in for <strong>${e(p.name)}</strong> expired. Sign in again in your browser to keep this profile — agents and apps using it stop answering until you do. Its project, model and agents stay as they are.</p></div>`
    : '';
  const actions = safe ? [
    signedOut && isSso(p) && p.codemieUrl ? button('Sign in again', { action: 'cm-profile-login', variant: 'primary', iconName: 'link', disabled: busy, attrs: { 'data-id': p.name } }) : '',
    !active ? button('Make active', { action: 'cm-profile-activate', iconName: 'swap', disabled: busy, attrs: { 'data-id': p.name } }) : '',
    !signedOut ? button('Test', { action: 'cm-profile-test', variant: 'ghost', iconName: 'play', disabled: test?.busy, attrs: { 'data-id': p.name } }) : '',
    testLine(test),
    '<span class="ws-spacer"></span>',
    button('Change model…', { action: 'cm-profile-edit', variant: 'ghost', iconName: 'edit', disabled: signedOut || busy, attrs: { 'data-id': p.name } }),
    menu(`cm-profile-${p.name}`, `More for ${p.name}`, [
      ['edit', 'Change project and model…', 'cm-profile-edit', p.name, signedOut || busy],
      ['note', 'Rename…', 'cm-profile-rename', p.name, busy],
      ['link', 'Sign in again', 'cm-profile-login', p.name, !isSso(p) || !p.codemieUrl || busy],
      ['folder', 'Show configuration file', 'cm-profile-file', p.name],
      null,
      ['trash', 'Delete profile…', 'cm-profile-delete', p.name, busy, true],
    ]),
  ].join('') : `<span class="ws-muted ws-hint">Rename this profile in Terminal to manage it here.</span><span class="ws-spacer"></span>${button('Show configuration file', { action: 'cm-profile-file', variant: 'ghost', iconName: 'folder', attrs: { 'data-id': p.name } })}`;
  return `<section class="ws-card${active ? ' cm-active-card' : ''}" style="margin-top:12px" data-profile="${e(p.name)}"><div class="ws-card-body cm-profile">
    <div class="cm-profile-head"><span class="cm-profile-mark${active ? ' cm-profile-mark-active' : ''}">${icon(PROVIDER_ICON[p.provider] || 'user')}</span><div class="cm-profile-name"><strong>${e(p.name)}${chips}</strong><span>${e(providerName(p.provider))}</span></div></div>
    ${expired}
    <dl class="cm-facts">${facts.map(([k, v]) => `<div><dt>${e(k)}</dt><dd title="${e(v)}">${e(v)}</dd></div>`).join('')}</dl>
    <div class="cm-profile-actions">${actions}</div>
  </div></section>`;
}
