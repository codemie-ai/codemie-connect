// First-use chooser body (DESIGN 6.1): which Claude writes for you. Pure.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { button } from './ui.js';
import { PRIVACY_NOTE, isNative } from './settings-ai.js';

export const CHOOSER_TITLE = 'Choose which Claude writes for you';

function option(p) {
  const a = p.account || {};
  const detail = isNative(p) ? [a.plan && `${a.plan} plan`, a.email].filter(Boolean).join(' · ') || 'Your Claude Code subscription' : `CodeMie profile${p.defaultModel ? ` · ${p.defaultModel}` : ''}`;
  return `<button type="button" class="ws-ai-choice" data-action="ai-choose" data-profile="${e(p.id)}" aria-pressed="false">
    <span class="ws-radio-dot" aria-hidden="true"></span>
    <span class="ws-ai-choice-copy"><strong>${e(p.label)}</strong><span>${e(detail)}</span></span>
  </button>`;
}

export function chooserBody(profiles = []) {
  const ready = profiles.filter(p => p.state === 'ready');
  if (!ready.length) {
    return `<p class="ws-modal-text">No Claude is ready on this Mac yet. Connect needs either Claude Code with your subscription or a CodeMie profile.</p>
      <ol class="ws-ai-setup"><li>Install and sign in to Claude Code (open Terminal, run <code>claude</code>, then type <code>/login</code>), or set up a CodeMie profile in Settings → CodeMie.</li><li>Open <strong>Settings → Claude</strong> and check again.</li></ol>
      <div class="ws-actions">${button('Open Claude settings', { action: 'ai-open-settings', variant: 'primary', iconName: 'settings' })}</div>`;
  }
  return `<div class="ws-ai-choices" role="group" aria-label="Claude profiles">${ready.map(option).join('')}</div>
    <p class="ws-inline-note">${icon('lock')}<span>${e(PRIVACY_NOTE)}</span></p>`;
}
