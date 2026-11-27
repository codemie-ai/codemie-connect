// Settings › Tasks (task-provider design §11, rulings 1, 2, 12, 13, 16): the "Where your tasks
// live" radio group (Local plus every installed plugin that provides tasks), the chosen plugin's
// declared settings drawn by Connect itself (never the plugin's own frame), and the copy dialog's
// body. Pure: tasks-controller.js owns the actions and the view state (Check's answer, a busy
// "Turn on"); view-settings.js assembles the plain objects these take from the snapshot and
// `installed[].settings` (Task 2) and draws this before the rest of the Tasks tab's content.
//
// The token is Connect's own write-only secret (ruling 2): the field is a password input, never
// prefilled with what is stored, and cleared again as soon as it is saved. Nothing here ever
// holds, logs or echoes its value.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { button, card, field, textInput } from './ui.js';
import { agoLabel, formatTime } from './format.js';

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const slug = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');

/** Where a plugin's own token page lives, by its bare id (Connect's own list, never the plugin's
 *  manifest: the token field is Connect's, not a plugin frame). */
const TOKEN_HELP_LINKS = { todoist: 'https://app.todoist.com/app/settings/integrations/developer' };

/** The sync status line a provider's row and its settings card both show (design "Copy" ·
 *  status): what "Check" can't tell on its own (off, didn't load) is decided by the caller first. */
function statusLine(tp, now, zone) {
  if (!tp) return '';
  const name = tp.name || 'It';
  const retry = tp.retryAt ? ` · trying again at ${formatTime(tp.retryAt, zone)}` : '';
  switch (tp.state) {
    case 'syncing': return 'Syncing…';
    case 'needs_token': return `${name} needs your API token.`;
    case 'offline': return `${name} can’t be reached${tp.pending ? ` · ${plural(tp.pending, 'change')} wait` : ''}${retry}.`;
    case 'rate_limited': return `${name} asked Connect to slow down${retry}.`;
    default:
      if (tp.pending) return `${plural(tp.pending, 'change')} wait for ${name}.`;
      if (tp.parked) return `${plural(tp.parked, 'change')} couldn’t reach ${name}.`;
      if (tp.lastSync) return `Synced ${agoLabel(tp.lastSync, zone, now)}.`;
      return 'Synced.';
  }
}

/** Local's own state line (ruling 16): while Local is chosen, a provider with unsent changes
 *  still queued from before names itself here ("<n> changes wait for Todoist."), since its own
 *  row shows no status while it isn't active; otherwise a line that doesn't repeat Local's own
 *  label. `p.available` is every entry `whereTasksLive` was given. */
function localStateLine(p) {
  if (p.active !== 'local') return 'Nothing leaves this Mac.';
  const waiting = (p.available || [])
    .filter(a => a.id !== 'local' && Number(a.pending) > 0)
    .map(a => `${plural(a.pending, 'change')} wait for ${a.name}.`);
  return waiting.length ? waiting.join(' ') : 'Nothing leaves this Mac.';
}

/** One radio row: Local, or an installed plugin that provides tasks. `a` is one entry of
 *  `taskProvider.available` (`{id, name}` for Local, `{id, name, on, ready, pending}` for a
 *  plugin). `p`: `{active, available, tp, now, zone, busy}` (`busy`: `{[providerId]: true}` while
 *  Turn on runs). */
function optionRow(a, p) {
  const local = a.id === 'local';
  const label = local ? 'Connect: kept on this Mac' : a.name;
  const off = !local && a.on === false;
  const notReady = !local && a.on !== false && a.ready === false;
  const active = a.id === p.active;
  const state = local ? localStateLine(p)
    : off ? 'Turned off in Settings › Plugins'
      : notReady ? `The ${a.name} plugin didn’t load.`
        : active ? (statusLine(p.tp, p.now, p.zone) || 'Synced.') : 'Installed and on.';
  const descId = `ws-tp-state-${slug(a.id)}`;
  const input = `<input type="radio" name="tasks-provider" value="${e(a.id)}" data-change="tasks-provider-choose" data-provider="${e(a.id)}"${active ? ' checked' : ''}${off ? ' disabled' : ''} aria-describedby="${descId}">`;
  const turnOn = off ? button(p.busy?.[a.id] ? 'Turning on…' : 'Turn on', { action: 'tasks-provider-turn-on', size: 'sm', disabled: !!p.busy?.[a.id], attrs: { 'data-provider': a.id } }) : '';
  return `<div class="ws-tasks-provider-row">
    <label class="ws-ms-radio-card">${input}<span><strong>${e(label)}</strong><small id="${descId}">${e(state)}</small></span></label>
    ${turnOn}
  </div>`;
}

/** The "Where your tasks live" card (design §11, ruling 1): Local plus each installed plugin that
 *  provides tasks, as a `role="radiogroup"`, each option a real radio with its state line as
 *  `aria-describedby`. `p`: `{active, available, tp, now, zone, busy}`. */
export function whereTasksLive(p) {
  const available = p.available?.length ? p.available : [{ id: 'local', name: 'Connect' }];
  return card({
    title: 'Where your tasks live', iconName: 'tasks',
    body: `<div class="ws-tasks-provider-list" role="radiogroup" aria-label="Where your tasks live">${available.map(a => optionRow(a, p)).join('')}</div>`,
  });
}

function checkLine(check, name) {
  if (!check) return '';
  if (check.ok) return `<p class="ws-inline-note ws-success" role="status">${icon('check')}<span>Connected to ${e(name)} as ${e(check.account || '—')}, project “${e(check.project || '—')}”.${check.message ? ` ${e(check.message)}` : ''}</span></p>`;
  return `<p class="ws-inline-note ws-error" role="alert">${icon('alert')}<span>${e(check.message || `${name} can’t be reached.`)}</span></p>`;
}

/** The secret field: a password input, never prefilled, "Save" (or "Replace" once set) and
 *  "Remove"; "Saved on this Mac. Connect never shows it again." once set (ruling 2). */
function secretField(def, p, helpUrl) {
  const label = def.label || 'API token';
  return `<div class="ws-field" data-provider-secret="${e(def.key)}">
    <span class="ws-field-label">${e(label)}</span>
    ${textInput({ type: 'password', name: def.key, autocomplete: 'off', spellcheck: 'false', 'aria-label': `${p.name} ${label}` })}
    ${def.set ? `<p class="ws-inline-note" role="status">${icon('check')}<span>Saved on this Mac. Connect never shows it again.</span></p>` : ''}
    <div class="ws-actions">
      ${button(p.savingSecret ? `${def.set ? 'Replacing' : 'Saving'}…` : (def.set ? 'Replace' : 'Save'), { action: 'tasks-provider-secret-save', size: 'sm', disabled: !!p.savingSecret, attrs: { 'data-key': def.key } })}
      ${def.set ? button('Remove', { action: 'tasks-provider-secret-remove', size: 'sm', variant: 'ghost', disabled: !!p.savingSecret, attrs: { 'data-key': def.key } }) : ''}
    </div>
    ${def.help ? `<small class="ws-field-hint">${e(def.help)}</small>` : ''}
    ${helpUrl ? `<button type="button" class="ws-link" data-action="tasks-provider-token-link" data-url="${e(helpUrl)}" data-name="${e(p.name)}" data-plugin-id="${e(p.pluginId)}">Get your token in ${e(p.name)} ↗</button>` : ''}
  </div>`;
}

function stringField(def) {
  return field(def.label || def.key, textInput({
    'data-change': 'tasks-provider-setting', 'data-key': def.key, value: def.value ?? '', autocomplete: 'off', spellcheck: 'false', 'aria-label': def.label || def.key,
  }), def.help || '');
}

/**
 * The chosen plugin's settings, drawn by Connect (ruling 1): its secret as a password field, its
 * string settings as text fields, Check, Sync now and the pending/parked/last-sync status line,
 * and the quiet "Copy open tasks from Connect…" link once the copy was offered (ruling 16). `p`:
 * `{providerId, pluginId, name, settings, tp, now, zone, check, copyOffered, savingSecret, syncing}`.
 * `''` for Local (ruling 1: nothing is drawn under it).
 */
export function providerSettings(p) {
  if (!p || !p.providerId || p.providerId === 'local') return '';
  const settings = p.settings || [];
  const secret = settings.find(s => s.type === 'secret');
  const strings = settings.filter(s => s.type === 'string');
  const helpUrl = TOKEN_HELP_LINKS[p.pluginId];
  const status = statusLine(p.tp, p.now, p.zone);
  const body = `${secret ? secretField(secret, p, helpUrl) : ''}${strings.map(stringField).join('')}
    <div class="ws-tasks-check">
      ${button(p.checking ? 'Checking…' : 'Check', { action: 'tasks-provider-check', size: 'sm', disabled: !!p.checking })}
      ${checkLine(p.check, p.name)}
    </div>
    <div class="ws-tasks-sync">
      ${button(p.tp?.state === 'syncing' ? 'Syncing…' : 'Sync now', { action: 'tasks-provider-sync', size: 'sm', variant: 'secondary', disabled: p.tp?.state === 'syncing' })}
      ${status ? `<span class="ws-muted ws-hint" role="status">${e(status)}</span>` : ''}
    </div>
    ${p.copyOffered ? button('Copy open tasks from Connect…', { action: 'tasks-provider-copy', variant: 'ghost', size: 'sm' }) : ''}`;
  return card({ title: `${p.name} settings`, iconName: 'puzzle', body });
}

/** The copy dialog's body (design §11, ruling 16): "Connect has N open tasks. Copies go to the
 *  project "<project>". Your tasks in Connect stay as they are." The title and its two buttons
 *  (`Copy <n> tasks` sending `copy: true`, `Not now` sending `copy: false`) are the caller's. */
export function copyDialog(p) {
  const n = Number(p?.count) || 0;
  return `<p class="ws-modal-text">Connect has ${plural(n, 'open task')}. Copies go to the project “${e(p?.project || 'Connect')}”. Your tasks in Connect stay as they are.</p>`;
}
