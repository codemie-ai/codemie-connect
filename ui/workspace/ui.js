// CodeMie-styled building blocks. Templates return escaped HTML strings; modal/toast own DOM.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { colorFor, initials } from './format.js';

const attrsOf = (attrs = {}) => Object.entries(attrs)
  .filter(([, v]) => v !== undefined && v !== null && v !== false)
  .map(([k, v]) => (v === true ? k : `${k}="${e(v)}"`))
  .join(' ');

/**
 * Button. Variants follow the platform: primary (gradient outline / blue tint), secondary
 * (outlined), ghost (text), magic (AI gradient fill), danger.
 */
export function button(label, { action, variant = 'secondary', iconName, iconRight, size, attrs = {}, title, disabled, type = 'button' } = {}) {
  const classes = ['ws-btn', `ws-btn-${variant}`, size ? `ws-btn-${size}` : '', !label ? 'ws-btn-icon' : ''].filter(Boolean).join(' ');
  const content = `${iconName ? icon(iconName) : ''}${label ? `<span>${e(label)}</span>` : ''}${iconRight ? icon(iconRight) : ''}`;
  return `<button ${attrsOf({ type, class: classes, 'data-action': action, title, 'aria-label': !label ? title : undefined, disabled, ...attrs })}>${content}</button>`;
}

export const iconButton = (iconName, title, action, attrs = {}) => button('', { iconName, title, action, variant: 'ghost', attrs });

/** Switch (role=switch) — 32×16 track, white thumb, CodeMie gradient when on. */
export function toggle({ name, id, checked, action, label, attrs = {} }) {
  return `<label class="ws-switch"${label ? '' : ` aria-label="${e(attrs['aria-label'] || name || '')}"`}><input ${attrsOf({ type: 'checkbox', role: 'switch', name, id, checked, 'data-action': action, ...attrs })}><span class="ws-switch-track" aria-hidden="true"><span class="ws-switch-thumb"></span></span>${label ? `<span class="ws-switch-label">${e(label)}</span>` : ''}</label>`;
}

export function checkbox({ name, value, checked, label, hint, action, attrs = {} }) {
  return `<label class="ws-check"><input ${attrsOf({ type: 'checkbox', name, value, checked, 'data-action': action, ...attrs })}><span class="ws-check-box" aria-hidden="true">${icon('check')}</span>${label ? `<span class="ws-check-text"><span>${e(label)}</span>${hint ? `<small>${e(hint)}</small>` : ''}</span>` : ''}</label>`;
}

export function radio({ name, value, checked, label, hint, attrs = {} }) {
  return `<label class="ws-check ws-radio"><input ${attrsOf({ type: 'radio', name, value, checked, ...attrs })}><span class="ws-check-box" aria-hidden="true"></span><span class="ws-check-text"><span>${e(label)}</span>${hint ? `<small>${e(hint)}</small>` : ''}</span></label>`;
}

export function avatar({ name, photo, size = 32, seed, className = '' }) {
  const style = `--size:${size}px;${photo ? '' : `--avatar-bg:${colorFor(seed || name)}`}`;
  if (photo && /^data:image\/(jpeg|png);base64,/.test(photo)) {
    return `<span class="ws-avatar ws-avatar-photo ${className}" style="${style}"><img src="${e(photo)}" alt=""></span>`;
  }
  return `<span class="ws-avatar ${className}" style="${style}" aria-hidden="true">${e(initials(name))}</span>`;
}

export const badge = (text, tone = 'neutral', iconName) => `<span class="ws-badge ws-badge-${tone}">${iconName ? icon(iconName) : ''}${e(text)}</span>`;

export function emptyState({ iconName = 'spark', title, text, actions = '' }) {
  return `<div class="ws-empty"><span class="ws-empty-icon">${icon(iconName)}</span><strong>${e(title)}</strong>${text ? `<p>${e(text)}</p>` : ''}${actions ? `<div class="ws-actions">${actions}</div>` : ''}</div>`;
}

/** Segmented control (CodeMie TabsMenu). `items`: [[value, label, count?]]. */
export function segmented(items, current, action, key = 'value', label = 'Options') {
  return `<div class="ws-segmented" role="tablist" aria-label="${e(label)}">${items.map(([value, text, count]) => `<button type="button" role="tab" data-action="${e(action)}" data-${key}="${e(value)}" aria-selected="${value === current}">${e(text)}${count !== undefined ? `<span class="ws-segmented-count">${e(count)}</span>` : ''}</button>`).join('')}</div>`;
}

export function card({ title, iconName, actions = '', body = '', span, className = '', footer = '', attrs = {} }) {
  const head = title ? `<header class="ws-card-header"><h2 class="ws-card-title">${iconName ? `<span class="ws-card-icon">${icon(iconName)}</span>` : ''}${e(title)}</h2>${actions ? `<div class="ws-card-actions">${actions}</div>` : ''}</header>` : '';
  return `<section ${attrsOf({ class: ['ws-card', span ? `ws-span-${span}` : '', className].filter(Boolean).join(' '), ...attrs })}>${head}<div class="ws-card-body">${body}</div>${footer ? `<footer class="ws-card-footer">${footer}</footer>` : ''}</section>`;
}

export function field(label, control, hint = '', attrs = {}) {
  return `<label ${attrsOf({ class: 'ws-field', ...attrs })}><span class="ws-field-label">${e(label)}</span>${control}${hint ? `<small class="ws-field-hint">${e(hint)}</small>` : ''}</label>`;
}

export const textInput = (attrs = {}) => `<input ${attrsOf({ class: 'ws-input', type: 'text', ...attrs })}>`;
export const textArea = (value = '', attrs = {}) => `<textarea ${attrsOf({ class: 'ws-textarea', ...attrs })}>${e(value)}</textarea>`;
export function select(options, value, attrs = {}) {
  return `<span class="ws-select-wrap"><select ${attrsOf({ class: 'ws-select', ...attrs })}>${options.map(([v, label]) => `<option value="${e(v)}" ${String(v) === String(value) ? 'selected' : ''}>${e(label)}</option>`).join('')}</select>${icon('chevron-down', 'ws-select-caret')}</span>`;
}

export function settingRow({ title, text = '', control = '', iconName }) {
  return `<div class="ws-setting-row">${iconName ? `<span class="ws-setting-icon">${icon(iconName)}</span>` : ''}<div class="ws-setting-copy"><strong>${e(title)}</strong>${text ? `<p>${e(text)}</p>` : ''}</div><div class="ws-setting-control">${control}</div></div>`;
}

export const spinner = (label = 'Loading') => `<span class="ws-spinner" role="status" aria-label="${e(label)}"></span>`;

// ---------------------------------------------------------------- focus after a re-render

const quoted = value => `"${String(value).replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')}"`;

/**
 * A selector that finds the same control after a re-render: its tag with every data-*
 * attribute, id, name and type (not state such as aria-pressed or class). Null when nothing
 * tells the control apart. Pure: takes anything with `tagName` and `attributes`.
 */
export function controlSelector(el) {
  if (!el?.tagName) return null;
  const attrs = [...(el.attributes || [])];
  const identity = attrs.filter(a => a.name === 'id' || a.name === 'name' || a.name.startsWith('data-'));
  // `type` alone ("button") tells nothing apart; with an identity it keeps inputs exact.
  if (!identity.length) return null;
  const parts = attrs.filter(a => identity.includes(a) || a.name === 'type').map(a => `[${a.name}=${quoted(a.value)}]`);
  return `${el.tagName.toLowerCase()}${parts.join('')}`;
}

/** The one element `selector` finds under `root`; null when there are none or several. */
export function soleMatch(root, selector) {
  if (!selector) return null;
  const found = root.querySelectorAll(selector);
  return found.length === 1 ? found[0] : null;
}

// ---------------------------------------------------------------- toast

/**
 * A toast. `action` (`{label, run}`) adds one button, such as Undo: it runs once and the toast
 * goes; a failure shows as an error toast. Such a toast stays 10 s instead of 6 s.
 */
export function toast(message, tone = 'info', action = null) {
  let host = document.querySelector('.ws-toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'ws-toasts';
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `ws-toast ws-toast-${tone}`;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(tone === 'error' ? 'alert' : tone === 'success' ? 'check-circle' : 'info')}<span></span>${action ? '<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-toast-action"></button>' : ''}<button type="button" class="ws-toast-close" aria-label="Dismiss">${icon('close')}</button>`;
  el.querySelector('span').textContent = message;
  el.querySelector('.ws-toast-close').onclick = () => el.remove();
  if (action) {
    const run = el.querySelector('.ws-toast-action');
    run.textContent = action.label;
    run.onclick = () => {
      el.remove();
      Promise.resolve().then(action.run).catch(err => toast(err?.message || String(err), 'error'));
    };
  }
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  // A toast with an action (Undo) stays longer, so there is time to use it.
  const life = action ? 10000 : 6000;
  setTimeout(() => el.classList.add('ws-toast-leave'), life);
  setTimeout(() => el.remove(), life + 400);
  return el;
}

// ---------------------------------------------------------------- modal

let closeHook = null;
/** Called after any dialog closes, so the controller can re-render deferred state. */
export function onModalClose(fn) {
  closeHook = fn;
}

/** A guarded dialog ignores a submit this soon after it opened or changed step. */
export const COMMIT_GUARD_MS = 400;

/**
 * CodeMie dialog: 50% scrim, 8px panel, 16px semibold title, close button, right-aligned
 * footer. `onSubmit(formData, dialog)` may return false to keep the dialog open; thrown errors
 * render inline. `beforeClose()` may veto closing (unsaved edits).
 *
 * For a dialog that commits something hard to undo (a restart, a deletion): `initialFocus:
 * 'cancel'` focuses Cancel, so Enter never commits by default, and `guard` ignores a submit within
 * `COMMIT_GUARD_MS` of opening or of `dialog.arm()` (a step change) and a held-down Enter, so a
 * double click or a repeated key can't commit.
 */
export function openModal({ title, subtitle = '', body = '', submit = 'Save', cancel = 'Cancel', onSubmit, size = 'md', variant = 'primary', workspaceId, onClose, footerExtra = '', initialFocus = 'auto', guard = false }) {
  const restore = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = `ws-modal ws-modal-${size}`;
  if (workspaceId) dialog.dataset.workspaceId = workspaceId;
  dialog.innerHTML = `<form class="ws-modal-form" novalidate>
    <header class="ws-modal-header"><div><h2>${e(title)}</h2>${subtitle ? `<p>${e(subtitle)}</p>` : ''}</div><button type="button" class="ws-btn ws-btn-ghost ws-btn-icon" data-modal-close aria-label="Close dialog">${icon('close')}</button></header>
    <div class="ws-modal-body">${body}</div>
    <div class="ws-modal-error" role="alert"></div>
    ${submit || cancel ? `<footer class="ws-modal-footer">${footerExtra}<span class="ws-spacer"></span>${cancel ? `<button type="button" class="ws-btn ws-btn-secondary" data-modal-close>${e(cancel)}</button>` : ''}${submit ? `<button type="submit" class="ws-btn ws-btn-${variant}">${e(submit)}</button>` : ''}</footer>` : ''}
  </form>`;
  const requestClose = async () => {
    if (!dialog.beforeClose || (await dialog.beforeClose()) !== false) dialog.close();
  };
  dialog.querySelectorAll('[data-modal-close]').forEach(b => { b.onclick = () => requestClose().catch(err => toast(err.message || String(err), 'error')); });
  dialog.addEventListener('cancel', ev => {
    ev.preventDefault();
    requestClose().catch(err => toast(err.message || String(err), 'error'));
  });
  dialog.addEventListener('mousedown', ev => {
    if (ev.target === dialog) requestClose().catch(() => {});
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    restore?.focus?.({ preventScroll: true });
    onClose?.();
    closeHook?.();
  }, { once: true });
  const form = dialog.querySelector('form');
  dialog.arm = () => { dialog.armedAt = performance.now(); };
  dialog.arm();
  if (guard) {
    dialog.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && ev.repeat) ev.preventDefault();
    }, true);
  }
  form.onsubmit = async ev => {
    ev.preventDefault();
    if (guard && performance.now() - dialog.armedAt < COMMIT_GUARD_MS) return;
    if (!onSubmit) return dialog.close();
    const invalid = [...form.elements].find(el => el.willValidate && !el.checkValidity());
    const error = dialog.querySelector('.ws-modal-error');
    if (invalid) {
      error.textContent = invalid.validationMessage;
      invalid.focus();
      return;
    }
    const submitter = ev.submitter || form.querySelector('[type=submit]');
    if (submitter) submitter.disabled = true;
    error.textContent = '';
    try {
      const result = await onSubmit(new FormData(form), dialog);
      if (result !== false && dialog.open) dialog.close();
    } catch (err) {
      error.textContent = err?.message || String(err);
    } finally {
      if (submitter) submitter.disabled = false;
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  const first = dialog.querySelector('.ws-modal-body input:not([type=hidden]):not([type=checkbox]), .ws-modal-body textarea, .ws-modal-body select');
  const cancelButton = initialFocus === 'cancel' && dialog.querySelector('.ws-modal-footer [data-modal-close]');
  (cancelButton || first || dialog.querySelector('[type=submit]') || dialog.querySelector('[data-modal-close]'))?.focus({ preventScroll: true });
  return dialog;
}

export function confirmModal({ title, text, confirm = 'Confirm', variant = 'primary', onConfirm, workspaceId, initialFocus, guard }) {
  return openModal({ title, body: `<p class="ws-modal-text">${e(text)}</p>`, submit: confirm, variant, onSubmit: onConfirm, size: 'sm', workspaceId, initialFocus, guard });
}
