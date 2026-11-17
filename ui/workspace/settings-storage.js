// Settings → General → Data location, and the dialog that changes it (DESIGN.md section 8).
// Pure: renders the `data_location_get` and `data_location_check` answers; app.js runs the
// native calls, the folder picker and the dialog's steps.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { badge, button, card, checkbox, spinner } from './ui.js';
import { formatDate } from './format.js';
import { USE_DEFAULT_WARNING } from './recovery.js';

export const ACK_LABEL = 'I understand others with access to this drive can read my workspace';
const DATA_DIR = 'CodeMie Connect Data';
const UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'];

/** A size in decimal units, as Finder shows it: "48.2 MB", "115 MB", "1.1 TB". */
export function formatBytes(n) {
  const bytes = Math.max(0, Number(n) || 0);
  if (!bytes) return 'Zero KB';
  if (bytes < 1000) return `${bytes} bytes`;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 999.5 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = value < 100 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown} ${UNITS[unit]}`;
}

const path = (p, attrs = '') => `<code class="ws-storage-path"${attrs}>${e(p || '')}</code>`;
const target = p => `<code class="ws-storage-path ws-dl-target">${e(p || '')}</code>`;
const reveal = (which, disabled) => button('Show in Finder', { action: 'data-reveal', variant: 'ghost', iconName: 'folder', disabled, attrs: { 'data-which': which } });
const note = (text, tone = '', iconName = 'info', role = '') => `<p class="ws-inline-note${tone ? ` ws-${tone}` : ''}"${role ? ` role="${role}"` : ''}>${icon(iconName)}<span>${text}</span></p>`;

// ---------------------------------------------------------------- Settings card

function placeRow({ iconName, title, place, text, which, extra = '', disabled }) {
  return `<div class="ws-storage-row" data-place="${e(which)}">
    <span class="ws-setting-icon">${icon(iconName)}</span>
    <div class="ws-storage-row-copy"><strong>${e(title)}</strong>${path(place)}<p>${e(text)}</p></div>
    <div class="ws-storage-row-actions">${reveal(which, disabled)}${extra}</div>
  </div>`;
}

/**
 * The folder Connect used before the last change. A copy a finished move left can be removed;
 * any other previous folder may hold newer data, so it is only named (ruling R20).
 */
function previousRow(info, disabled) {
  if (!info.previous || !info.previousExists) return '';
  if (info.previousCopied) {
    return placeRow({
      iconName: 'archive', title: `Old copy · ${formatBytes(info.previousSizeBytes)}`, place: info.previous, which: 'previous', disabled,
      text: 'Left by your last move. Remove it once you’ve checked your data is all here.',
      extra: button('Remove old copy…', { action: 'data-remove-old', variant: 'danger', iconName: 'trash', disabled }),
    });
  }
  return placeRow({
    iconName: 'info', title: 'Your previous data folder is still at', place: info.previous, which: 'previous', disabled,
    text: 'Connect didn’t copy your data from it, so it may hold changes you don’t have here. Connect leaves it as it is.',
  });
}

/** Settings → General → Data location. `info` is the `data_location_get` answer; null while it loads. */
export function storageCard(info, { error = '', restarting = false } = {}) {
  const base = { title: 'Data location', iconName: 'folder', className: 'ws-storage-card', attrs: { id: 'data-location' } };
  if (!info) {
    const body = error
      ? `${note(e(error), 'error', 'alert', 'alert')}<div class="ws-actions">${button('Try again', { action: 'data-refresh', iconName: 'refresh' })}</div>`
      : `<div class="ws-dl-wait">${spinner('Reading where your data is')}<span>Reading where your data is…</span></div>`;
    return card({ ...base, body });
  }
  const off = restarting;
  const kind = info.custom ? 'A folder you chose.' : 'Connect’s own folder on this Mac.';
  const body = `<div class="ws-storage-folder">
      <div class="ws-storage-folder-head"><span class="ws-storage-label">Data folder</span><span class="ws-storage-size">${e(formatBytes(info.sizeBytes))}</span></div>
      ${path(info.dataRoot, ' id="data-location-path"')}
      <p class="ws-storage-hint">Your workspace database, plugins and automations. ${e(kind)}</p>
      <div class="ws-storage-tools">${button('Copy path', { action: 'data-copy-path', variant: 'ghost', iconName: 'copy', disabled: off })}${reveal('data', off)}</div>
    </div>
    <div class="ws-storage-rows">
      ${placeRow({ iconName: 'lock', title: 'Private sign-in data', place: info.privateRoot, which: 'private', disabled: off, text: 'Your Microsoft sign-in and plugin secrets, kept in Connect’s own folder on this Mac. It never moves.' })}
      ${placeRow({ iconName: 'note', title: 'Logs', place: info.logs, which: 'logs', disabled: off, text: 'What Connect did, for troubleshooting.' })}
      ${previousRow(info, off)}
    </div>
    ${restarting ? `<div class="ws-dl-wait" role="status">${spinner('Restarting Connect')}<span>Restarting Connect…</span></div>` : ''}
    <div class="ws-storage-actions">
      ${button('Change…', { action: 'data-change', variant: 'primary', iconName: 'folder', disabled: off })}
      ${info.custom ? button('Use the default folder…', { action: 'data-default', disabled: off }) : ''}
      <span class="ws-storage-note">Moving copies your data and keeps the old copy until you remove it.</span>
    </div>`;
  return card({ ...base, actions: info.custom ? badge('Custom', 'info') : badge('Default', 'neutral'), body });
}

// ---------------------------------------------------------------- the check result

/** What to do about each issue `data_location_check` reports. The issue's own sentence says why. */
const NEXT = {
  not_absolute: 'Choose the folder again with Choose another folder.',
  not_a_directory: 'Reconnect its drive, or choose another folder.',
  not_writable: 'Choose a folder you own, for example one in your home folder.',
  inside_current: 'Choose a folder outside your current data folder.',
  inside_private: 'Choose a folder outside it.',
  inside_app: 'Choose a folder outside the app.',
  cloud_synced: 'Choose a folder that isn’t synced, for example one in your home folder or on an external drive.',
  network_volume: 'Choose a folder on this Mac or on a drive plugged into it.',
  unsupported_volume: 'Choose another drive, or format this one as APFS in Disk Utility.',
  current_folder: 'Nothing needs to change.',
};

function nextStep(issue, r) {
  if (issue.code === 'not_enough_space') {
    return `That disk has ${formatBytes(r.freeBytes)} free. Moving ${formatBytes(r.requiredBytes)} of data needs ${formatBytes(r.neededBytes)} free, so the copy fits with room to grow.`;
  }
  return NEXT[issue.code] || '';
}

const MODES = {
  move: ['Move my data', 'Copies your data there and uses the copy. Connect keeps the old copy until you remove it.'],
  adopt: ['Use the Connect data already there', 'Opens the workspace in that folder as it is. Nothing is copied or overwritten.'],
  fresh: ['Start empty there', 'Creates a new, empty workspace there. Your current data stays where it is.'],
};

/** The choice made for the user: Move when it's possible, the data already there when that's all. Never Start empty. */
export function defaultMode(report) {
  const modes = report?.modes || [];
  if (modes.includes('move')) return 'move';
  if (modes.includes('adopt')) return 'adopt';
  return null;
}

/** A choice the folder allows, and the exFAT/FAT acknowledgement when the drive needs it. */
export function canContinue(report, { mode, acknowledged } = {}) {
  return !!mode && (report?.modes || []).includes(mode) && (!report.needsAcknowledgement || !!acknowledged);
}

function modeCard(mode, { checked, off, detail = '' }) {
  const [title, text] = MODES[mode];
  return `<label class="ws-dl-mode${off ? ' ws-dl-mode-off' : ''}">
    <input type="radio" name="data-mode" value="${mode}"${checked ? ' checked' : ''}${off ? ' disabled' : ''}>
    <span class="ws-radio-dot" aria-hidden="true"></span>
    <span class="ws-dl-mode-copy"><strong>${e(title)}</strong><span>${e(text)}</span>${detail ? `<span>${e(detail)}</span>` : ''}${off ? `<em>${e(off)}</em>` : ''}</span>
  </label>`;
}

function modeCards(r, { recovery, mode }) {
  const modes = r.modes || [];
  if (!modes.length) return '';
  let cards;
  if (modes.includes('adopt')) {
    const m = r.existing || {};
    const made = m.createdAt ? `Created ${formatDate(m.createdAt, undefined, { day: 'numeric', month: 'short', year: 'numeric' })}${m.appVersion ? ` by Connect ${m.appVersion}` : ''}.` : '';
    cards = `${modeCard('adopt', { checked: mode === 'adopt', detail: made })}
      <p class="ws-dl-small">Connect never copies over or mixes with Connect data that is already there. To move your data or start empty, choose a folder without it.</p>`;
  } else {
    const why = recovery
      ? 'Not available here: your workspace isn’t open, so there’s nothing to copy.'
      : r.issues.some(i => i.code === 'not_enough_space') ? 'Not enough free space on that disk.' : 'Not available for this folder.';
    cards = ['move', 'fresh'].map(m => modeCard(m, { checked: mode === m && modes.includes(m), off: modes.includes(m) ? '' : why })).join('');
  }
  return `<fieldset class="ws-dl-modes"><legend>What should Connect do there?</legend>${cards}</fieldset>`;
}

/**
 * The checked folder: where the data would live, the disk, every reason it can't be used (each
 * with what to do), the exFAT/FAT acknowledgement, and the choices it allows (radio `data-mode`).
 */
export function changeLocationBody(report, { recovery = false, mode = null, acknowledged = false } = {}) {
  const r = report;
  const modes = r.modes || [];
  const blocked = !modes.length;
  const ack = !blocked && r.issues.find(i => i.code === 'no_permissions');
  const issues = r.issues.filter(i => blocked || i.code !== 'no_permissions');
  // The size of the data a move would copy; beside Connect data already there it would mislead.
  const yours = !recovery && !r.existing && r.requiredBytes ? `your data ${formatBytes(r.requiredBytes)}` : '';
  const facts = [r.fsName, r.freeBytes ? `${formatBytes(r.freeBytes)} free` : '', yours].filter(Boolean).join(' · ');
  const label = blocked ? 'You chose' : r.existing ? 'Connect data in that folder' : 'Your data would live in';
  const where = `<div class="ws-dl-folder">
      <div class="ws-dl-folder-head"><span class="ws-storage-label">${label}</span>${button('Choose another folder…', { action: 'data-choose', variant: 'ghost', iconName: 'folder' })}</div>
      ${path(r.target)}
      ${facts ? `<span class="ws-dl-facts">${icon('drive')}<span>${e(facts)}</span></span>` : ''}
    </div>`;
  const tone = blocked ? 'error' : 'warning';
  const list = issues.length
    ? `<ul class="ws-dl-issues" aria-label="${blocked ? 'Why Connect can’t use that folder' : 'Before you continue'}">${issues.map(i => {
      const next = nextStep(i, r);
      return `<li class="ws-dl-issue ws-dl-issue-${tone}">${icon('alert')}<div><strong>${e(i.message)}</strong>${next ? `<span>${e(next)}</span>` : ''}</div></li>`;
    }).join('')}</ul>`
    : '';
  const acknowledge = ack
    ? `<div class="ws-dl-issue ws-dl-issue-warning ws-dl-ack">${icon('alert')}<div><strong>${e(ack.message)}</strong>${checkbox({ name: 'data-ack', value: '1', checked: acknowledged, label: ACK_LABEL })}</div></div>`
    : '';
  return `${where}${list}${acknowledge}${modeCards(r, { recovery, mode })}`;
}

// ---------------------------------------------------------------- the dialog's steps

const STEPS = { pick: 'Step 1 of 3 · Choose a folder', check: 'Step 2 of 3 · Check the folder', confirm: 'Step 3 of 3 · Confirm' };
const SUBMIT = { move: 'Move and restart', adopt: 'Use it and restart', fresh: 'Start empty and restart' };
const CONFIRM_TITLE = { move: 'Move your data and restart?', adopt: 'Use the data there and restart?', fresh: 'Start empty there and restart?' };
const WORKING_TITLE = { move: 'Moving your data', adopt: 'Switching to the data there', fresh: 'Starting empty there' };
const WORKING = {
  move: ['Copying your data…', 'Connect is copying your data and checking the copy. Keep Connect open; a large workspace takes a few minutes.'],
  adopt: ['Checking the Connect data there…', 'Connect checks that data before it switches to it.'],
  fresh: ['Creating the new data folder…', 'This takes a moment.'],
};
const RESTART = `<p class="ws-dl-restart">${icon('refresh')}<span><strong>Connect will restart.</strong> Background work pauses first; AI drafts still running stop, and you can start them again.</span></p>`;

function errorNote(err) {
  if (!err) return '';
  const busy = err.code === 'busy';
  return note(e(err.message || String(err)), busy ? 'warning' : 'error', busy ? 'clock' : 'alert', 'alert');
}

const wait = (label, text) => `<div class="ws-dl-wait ws-dl-progress" role="status">${spinner(label)}<div><strong>${e(label)}</strong><span>${e(text)}</span></div></div>`;

function pickBody(f) {
  const lead = f.recovery
    ? `<p class="ws-modal-text">Choose the folder that holds your Connect data to use it again, or an empty folder to start a new workspace there.</p>
      ${note('Your workspace isn’t open, so Connect can’t copy your data from here. Nothing is moved or deleted.')}`
    : `<p class="ws-modal-text">Choose a folder on this Mac or on a drive connected to it. Connect keeps your data in a “${DATA_DIR}” folder inside it.</p>
      <div class="ws-dl-split">
        <div>${icon('arrow')}<strong>Moves</strong><span>Your workspace database, plugins and automations.</span></div>
        <div>${icon('lock')}<strong>Stays on this Mac</strong><span>Your sign-in data, kept private, and the logs.</span></div>
      </div>
      ${f.info?.dataRoot ? `<div class="ws-dl-folder"><span class="ws-storage-label">Your data is in</span>${path(f.info.dataRoot)}</div>` : ''}`;
  return `${errorNote(f.error)}${lead}
    <p class="ws-dl-small">Folders synced by iCloud Drive, Dropbox, OneDrive or Google Drive, and network drives, can’t hold your data.</p>
    <div class="ws-dl-choose">${button('Choose folder…', { action: 'data-choose', variant: 'primary', iconName: 'folder' })}</div>`;
}

function confirmBody(f) {
  const r = f.report;
  const current = f.info?.dataRoot;
  const size = f.info?.sizeBytes ? ` (${formatBytes(f.info.sizeBytes)})` : '';
  const where = target(r.target);
  const stays = current ? ` in ${path(current)}` : '';
  if (f.mode === 'move') {
    return `<p class="ws-modal-text">Connect will copy your data${e(size)} to:</p>${where}
      <ol class="ws-dl-steps"><li>Pause background work, then copy your workspace database, plugins and automations.</li><li>Check the copy against the original.</li><li>Restart and open your workspace from the new folder.</li></ol>
      ${note(`Your data also stays where it is now${stays}. Once you’ve checked everything is in the new folder, remove that old copy in Settings → General.`)}
      ${RESTART}`;
  }
  if (f.mode === 'adopt') {
    return `<p class="ws-modal-text">Connect will restart and open the workspace in:</p>${where}
      ${note(`Your current data stays${stays}. It isn’t copied or merged. To go back to it, use Change… and choose that folder.`)}
      ${RESTART}`;
  }
  return `<p class="ws-modal-text">Connect will create an empty workspace in:</p>${where}
    ${note(`Your notes, commitments, drafts and settings stay with your current data${stays}. Microsoft 365 stays signed in and syncs again.`)}
    ${RESTART}`;
}

/**
 * One step of the change dialog: `flow.step` is pick, checking, check, confirm, working or
 * restarting. Returns its title, subtitle, body and footer (no footer while Connect works), and
 * whether the dialog must stay open.
 */
export function changeDialogView(flow = {}) {
  const f = flow;
  const title = f.recovery ? 'Choose another data folder' : 'Change where Connect keeps its data';
  const cancel = '<button type="button" class="ws-btn ws-btn-secondary" data-action="data-cancel">Cancel</button>';
  const footer = (primary = '', back = false) => `${back ? button('Back', { action: 'data-back', variant: 'ghost', iconName: 'chevron-left' }) : ''}<span class="ws-spacer"></span>${cancel}${primary}`;
  const submit = (label, disabled) => `<button type="submit" class="ws-btn ws-btn-primary"${disabled ? ' disabled' : ''}>${e(label)}</button>`;
  const view = (subtitle, body, foot, extra = {}) => ({ title, subtitle, body, footer: foot, busy: false, ...extra });
  switch (f.step) {
    case 'checking':
      return view(STEPS.check, `<div class="ws-dl-wait" role="status">${spinner('Checking that folder')}<span>Checking that folder…</span></div>`, footer());
    case 'check':
      return view(STEPS.check, errorNote(f.error) + changeLocationBody(f.report, f), footer(submit('Continue', !canContinue(f.report, f))));
    case 'confirm':
      return view(STEPS.confirm, errorNote(f.error) + confirmBody(f), footer(submit(SUBMIT[f.mode] || 'Continue', !canContinue(f.report, f)), true), { title: CONFIRM_TITLE[f.mode] || title });
    case 'working':
      return view('', wait(...(WORKING[f.mode] || WORKING.fresh)), '', { title: WORKING_TITLE[f.mode] || title, busy: true });
    case 'restarting':
      return view('', wait('Restarting Connect…', 'Connect opens again in a moment, using the new folder.'), '', { title: 'Restarting Connect', busy: true });
    default:
      return view(STEPS.pick, pickBody(f), footer());
  }
}

// ---------------------------------------------------------------- confirmations

/** Remove old copy: what goes, from where, and that it is final. */
export function removeOldBody(info) {
  return `<p class="ws-modal-text">Connect will delete its own files from the old copy (${e(formatBytes(info.previousSizeBytes))}): the workspace database, plugins and automations.</p>
    ${target(info.previous)}
    <p class="ws-modal-text">Your sign-in data and any other files in that folder stay.</p>
    <p class="ws-dl-final">${icon('alert')}<strong>This can’t be undone.</strong></p>`;
}

/** Use the default folder: only the pointer changes, and what that means for the data. */
export function useDefaultBody(info) {
  return `<p class="ws-modal-text">Connect will restart using the data in its default folder:</p>
    ${target(info.privateRoot)}
    <p class="ws-modal-text">Nothing is moved or copied. ${e(USE_DEFAULT_WARNING)}</p>
    ${note(`Your current data stays in ${path(info.dataRoot)}. To go back to it, use Change… and choose that folder.`)}`;
}
