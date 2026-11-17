// The Today card that keeps unfinished CodeMie setup in view until it is done or snoozed.
import { escapeHtml as e } from '../store.js';
import { icon } from '../icons.js';
import { button, spinner } from '../ui.js';
import { setupProgress } from './model.js';

export function todayCard(cm, prefs = {}, now = Date.now()) {
  if (!cm.loaded) return '';
  const p = setupProgress(cm, prefs);
  if (p.complete || now < (prefs.snoozedUntil || 0)) return '';
  const step = (done, label) => `<span class="${done ? 'cm-is-done' : ''}">${icon(done ? 'check-circle' : 'clock')}${e(label)}</span>`;
  const started = p.count > 0;
  const account = cm.org?.organizationName ? `your ${cm.org.organizationName} account` : 'your EPAM account';
  const runtime = cm.runtime.state === 'downloading'
    ? `<span>${spinner('Preparing')}<span>Getting CodeMie ready · ${Math.floor((cm.runtime.fraction || 0) * 100)}%</span></span>` : '';
  return `<section class="cm-today-setup" aria-label="CodeMie setup">
    <div class="cm-today-setup-copy">
      <span class="cm-ring" style="--p:${Math.round((p.count / 3) * 100)}"><span>${p.count}/3</span></span>
      <div>
        <h2>${started ? 'Finish setting up your AI coding tools' : 'Set up your AI coding tools'}</h2>
        <p>${e(started ? 'Pick up where you left off — everything you already did is saved. No Terminal needed.' : `Sign in with ${account} and get Claude Code and other coding agents working with CodeMie. About 3 minutes, no Terminal needed.`)}</p>
        <div class="cm-today-steps">${step(p.account, 'Sign in to CodeMie')}${step(p.agent, 'Install a coding agent')}${step(p.apps, 'Connect your apps (optional)')}${runtime}</div>
      </div>
    </div>
    <div class="cm-today-setup-cta">
      ${button(started ? 'Continue setup' : 'Set up CodeMie', { action: 'cm-setup-open', variant: 'primary', size: 'lg', iconRight: 'arrow' })}
      ${button('Remind me tomorrow', { action: 'cm-setup-snooze', variant: 'ghost', size: 'sm' })}
    </div>
  </section>`;
}
