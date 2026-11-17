// Recovery page (DESIGN.md section 8): shown when the workspace can't open its data folder at
// startup, or when an operation returns `storage_unavailable` while Connect runs. Pure: it
// renders the `storage_status` result (`issue` is native and always precise), plus `cause`, the
// failing operation's message, and `restarting` once a restart was accepted; app.js wires the
// actions.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { button } from './ui.js';

export const USE_DEFAULT_WARNING = 'Data there may be older or empty.';

const SENTENCES = {
  missing: 'Connect can’t find your data folder: its drive may be disconnected, or the folder was moved or renamed.',
  no_marker: 'The folder is there, but Connect’s data isn’t in it.',
  marker_mismatch: 'The folder holds a different Connect workspace from the one this Mac was using.',
  not_writable: 'Connect can’t save to your data folder; it may be read-only or on a locked drive.',
  pointer_unreadable: 'Connect couldn’t read where your data is kept.',
  ready: 'Connect can’t use your workspace right now.',
};

/** What happened, in one sentence. An unknown status reads like `ready`. */
export function recoverySentence(status) {
  return SENTENCES[status?.status] || SENTENCES.ready;
}

/** Switching back is offered only when Connect is not already on its default folder. */
const offersDefault = s => !!s && (s.custom || s.status === 'pointer_unreadable');

/**
 * One failure can reach the page twice: from the invoke watcher and from the caller's catch.
 * Returns a check that is true only the first time it sees a given error object.
 */
export function firstReport() {
  const seen = new WeakSet();
  return err => {
    if (!err || typeof err !== 'object') return true;
    if (seen.has(err)) return false;
    seen.add(err);
    return true;
  };
}

export function recoveryPage(status) {
  const s = status || {};
  const known = s.status in SENTENCES && s.status !== 'ready';
  // Native issues are always more precise than the status (a full disk, why it didn't open).
  // The failing operation's own message helps only when no folder-level sentence explains it.
  const detail = s.issue || (!known && s.cause) || '';
  const issue = detail ? `<p class="ws-recovery-issue">${e(detail)}</p>` : '';
  const sep = String(s.defaultRoot || '').includes('\\') ? '\\' : '/';
  const where = s.status === 'pointer_unreadable'
    ? { label: 'Location file', path: s.defaultRoot ? `${s.defaultRoot}${sep}location.json` : '' }
    : { label: s.custom ? 'Data folder' : 'Data folder (default)', path: s.dataRoot || '' };
  const path = where.path ? `<div class="ws-recovery-path"><span class="ws-recovery-label">${e(where.label)}</span><code>${e(where.path)}</code></div>` : '';
  const useDefault = offersDefault(s);
  const busy = !!s.restarting;
  const actions = [
    button(busy ? 'Restarting…' : 'Retry', { action: 'recovery-retry', variant: 'primary', iconName: 'refresh', disabled: busy }),
    useDefault ? button('Use the default folder', { action: 'recovery-default', disabled: busy }) : '',
    // Task 13 adds "Choose another folder…" here.
  ].join('');
  const note = useDefault
    ? `<p class="ws-recovery-note">The default folder is <code>${e(s.defaultRoot || '')}</code>. ${e(USE_DEFAULT_WARNING)}</p>`
    : '';
  return `<div class="ws-recovery">
    <section class="ws-card ws-recovery-card" aria-labelledby="recovery-title" data-status="${e(s.status || 'ready')}">
      <span class="ws-recovery-icon">${icon('alert')}</span>
      <h1 id="recovery-title">Your data folder needs attention</h1>
      <p class="ws-recovery-lead">${e(recoverySentence(s))}</p>
      ${issue}
      ${path}
      <div class="ws-actions ws-recovery-actions">${actions}</div>
      ${note}
      <div class="ws-recovery-foot"><span>Your CodeMie tools still work.</span>${button('Open CodeMie tools', { action: 'recovery-tools', variant: 'ghost', iconName: 'tools' })}</div>
    </section>
  </div>`;
}
