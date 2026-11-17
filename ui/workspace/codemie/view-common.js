// Small markup pieces every Settings → CodeMie view uses. Pure; every value is escaped here.
import { escapeHtml as e } from '../store.js';
import { icon } from '../icons.js';
import { button } from '../ui.js';

export const code = (text) => `<code class="cm-code">${e(text)}</code>`;
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The host of an address, for display (`codemie.lab.epam.com`). */
export function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || '').replace(/^https?:\/\//, ''); }
}

/** CLI output with failures and successes tinted. Escapes first, then wraps whole lines. */
export const colorLog = (out) => e(out).split('\n').map((line) => (
  /^\s*(npm error|error|✗|×|❌)/i.test(line) ? `<span class="cm-err">${line}</span>`
    : /^\s*(✓|✔|added)/.test(line) ? `<span class="cm-ok">${line}</span>`
      : /^\s*\?/.test(line) ? `<span class="cm-dim">${line}</span>` : line
)).join('\n');

/**
 * "show output" under a plain-language sentence. With `always`, an empty output still gets the
 * block and says so, so a failure with nothing captured is never a dead end.
 */
export function logBlock(label, out, { open = false, always = false } = {}) {
  if (!out && !always) return '';
  const body = out ? colorLog(out) : '<span class="cm-dim">No output was captured.</span>';
  return `<details class="cm-log"${open ? ' open' : ''}><summary>${icon('chevron-right')}<span>${e(label)}</span><span class="cm-sep">·</span><span>show output</span></summary><pre>${body}</pre></details>`;
}

/** `settingRow` whose text is markup the caller already escaped (it holds `code()` pieces). */
export function markupRow({ title, html = '', control = '', iconName }) {
  return `<div class="ws-setting-row">${iconName ? `<span class="ws-setting-icon">${icon(iconName)}</span>` : ''}<div class="ws-setting-copy"><strong>${e(title)}</strong>${html ? `<p>${html}</p>` : ''}</div><div class="ws-setting-control">${control}</div></div>`;
}

/** One attention item as a banner (Today) — the same item Overview and the dots use. */
export const banner = (a) => `<div class="ws-banner ws-banner-warning">${icon('alert')}<div><strong>${e(a.title)}</strong><p>${e(a.text)}</p></div><div class="ws-actions">${button(a.action.label, { action: a.action.action, variant: 'primary', attrs: { 'data-id': a.action.id } })}</div></div>`;

/** The workspace ⋯ menu. items: [iconName, label, action, id, disabled?, danger?] or null for a rule. */
export function menu(id, label, items) {
  return `<details class="ws-menu ws-menu-right" data-menu="${e(id)}"><summary class="ws-btn ws-btn-ghost ws-btn-icon" aria-label="${e(label)}" title="More">${icon('dots')}</summary><div class="ws-menu-panel">${items.map((it) => (!it ? '<hr>'
    : `<button type="button" class="ws-menu-item${it[5] ? ' ws-menu-danger' : ''}" data-action="${e(it[2])}" data-id="${e(it[3])}"${it[4] ? ' disabled' : ''}>${icon(it[0])}<span>${e(it[1])}</span></button>`)).join('')}</div></details>`;
}

/** A plain-language failure: sentence, explanation, Try again / Dismiss, then the real output. */
export function problem({ title, text, retry, id, cmd, output, dismiss, warn = false }) {
  const actions = [
    retry ? button('Try again', { action: retry, variant: 'primary', iconName: 'refresh', attrs: { 'data-id': id } }) : '',
    dismiss ? button('Dismiss', { action: dismiss, variant: 'ghost', attrs: { 'data-id': id } }) : '',
  ].join('');
  return `<div class="cm-problem${warn ? ' cm-problem-warn' : ''} cm-fade-in"><strong>${icon('alert')}${e(title)}</strong>${text ? `<p>${e(text)}</p>` : ''}${actions ? `<div class="ws-actions">${actions}</div>` : ''}${cmd !== undefined ? logBlock(cmd || 'Output', output, { always: true }) : ''}</div>`;
}
