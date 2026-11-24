// Settings › Notifications: the "Menu bar" card (design `docs/superpowers/specs/2026-11-24-menu-
// bar-count-design.md` §6, § Copy). Pure: `app.js` owns the `menu-bar-toggle`/`menu-bar-fix`
// actions and sends writes through `mutate`; this file only draws what `snapshot.menuBar` and
// `settings.menuBar` say. Default and Compact draw the same markup (ruling 12) — only the step-1
// CSS tokens the card sits in change size.
import { escapeHtml as e } from './store.js';
import { card, settingRow, toggle, button } from './ui.js';
import { isHidden } from './meetings-model.js';

const hintId = key => `ws-mb-hint-${key}`;

/**
 * The four switches (design § Copy), in the order the status line and the tray's rows use:
 * `[source, title, hint(providerName)]`. The tasks row names the active task provider,
 * "Connect" with none (`s.taskProvider?.name`).
 */
export const ROWS = [
  ['replies', 'Messages that need a reply', () => 'Needs reply and unacknowledged critical messages, as Inbox counts them.'],
  ['tasks', 'Tasks due today or late', provider => `Your open tasks in ${provider}.`],
  ['meetings', 'Meetings with new notes', () => 'Notes made since you last opened the meeting.'],
  ['automations', 'Automation results', () => 'Results since you last looked at Today or Automations.'],
];

/** Design § Copy's "Menu rows", singular/plural, for the status line's own counted parts. */
const ROW_TEXT = {
  replies: n => `${n} ${n === 1 ? 'message needs' : 'messages need'} a reply`,
  tasks: n => `${n} task${n === 1 ? '' : 's'} due or late`,
  meetings: n => `${n} meeting${n === 1 ? '' : 's'} with new notes`,
  automations: n => `${n} automation result${n === 1 ? '' : 's'}`,
};

/**
 * The status line (design § Copy, `role="status"`): what the menu-bar number is made of.
 * `settings` is `s.settings.menuBar` (the four booleans); nothing chosen there always wins over
 * the counts, even if a source still carries a number from before it was turned off.
 */
export function statusLine(menuBar, settings) {
  if (!ROWS.some(([key]) => settings?.[key])) return 'Nothing is counted. The icon still turns amber when something needs fixing.';
  const counted = menuBar?.counted || [];
  const sources = menuBar?.sources || {};
  const parts = ROWS
    .map(([key]) => key)
    .filter(key => counted.includes(key) && sources[key] > 0)
    .map(key => ROW_TEXT[key](sources[key]));
  if (!parts.length) return 'Now: nothing to count.';
  return `Now: ${menuBar.count} — ${parts.join(', ')}`;
}

/** One fix row: its text, and a "Fix" button named "Fix: <text>" (design Accessibility). */
function fixRow(fix) {
  return `<li class="ws-mb-fix"><span>${e(fix.text)}</span>${button('Fix', { action: 'menu-bar-fix', size: 'sm', variant: 'ghost', attrs: { 'data-fix': fix.id, 'aria-label': `Fix: ${fix.text}` } })}</li>`;
}

function fixesSection(fixes) {
  if (!fixes?.length) return '';
  return `<div class="ws-mb-fixes"><strong>Needs fixing</strong><ul>${fixes.map(fixRow).join('')}</ul></div>`;
}

/** Settings › Notifications' "Menu bar" card (design §6, § Copy). */
export function menuBarCard(s) {
  const settings = s.settings?.menuBar || {};
  const menuBar = s.menuBar || { count: 0, label: '', amber: false, sources: {}, counted: [], fixes: [] };
  const provider = s.taskProvider?.name || 'Connect';
  const rows = ROWS.map(([key, title, hint]) => settingRow({
    title,
    text: hint(provider),
    hintId: hintId(key),
    control: toggle({ checked: !!settings[key], action: 'menu-bar-toggle', attrs: { 'data-source': key, 'aria-label': title, 'aria-describedby': hintId(key) } }),
  })).join('');
  return card({
    title: 'Menu bar', iconName: 'bell',
    body: `<p class="ws-muted ws-hint">The number beside CodeMie Connect in the menu bar. Choose what it counts.</p>
      ${rows}
      <p class="ws-muted ws-hint" role="status">${e(statusLine(menuBar, settings))}</p>
      ${fixesSection(menuBar.fixes)}`,
    footer: "Amber means something needs fixing, such as a sign-in or a plugin token. It can't be turned off.",
  });
}

// ---------------------------------------------------------------- seen marks and opening

/**
 * What `menu_bar_seen` marks `app.js` should send after this render (design §6, rulings 6-7):
 * pure — `app.js` computes `focused` (`document.visibilityState === 'visible' && document.
 * hasFocus()`), `editing` and `modal` from the DOM, sends each payload through
 * `mutate('menu_bar_seen', …)`, and ignores a failure (the next render tries again). `openMeeting`
 * is the meeting the Meetings page has open (`state.meetings.selected`); `todayCards` the widget
 * ids on Today's grid; `hidden` the meetings view's hidden ids and series (`state.meetings.hidden`);
 * `sent` the caller's set of `"<revision>|<key>"` marks already sent, so a mark goes out once per
 * revision even across renders.
 */
export function seenToSend({ snapshot, route, openMeeting, todayCards = [], hidden, focused, editing, modal, sent }) {
  if (!focused || editing || modal) return [];
  const menuBar = snapshot?.menuBar || {};
  const revision = snapshot?.revision;
  const alreadySent = key => !!sent?.has(`${revision}|${key}`);

  // A meeting record, by id, to tell a hidden series apart (`isHidden` wants `{ev, rec}`).
  const meetingRecords = new Map();
  for (const r of snapshot?.records || []) {
    if (r.kind !== 'meeting' && r.kind !== 'event') continue;
    const m = meetingRecords.get(r.id) || { id: r.id };
    m[r.kind === 'meeting' ? 'rec' : 'ev'] = r;
    meetingRecords.set(r.id, m);
  }

  const out = [];
  for (const id of menuBar.newMeetings || []) {
    const key = `meeting:${id}`;
    if (alreadySent(key)) continue;
    const inFront = route === 'meetings' && openMeeting === id;
    const hiddenNow = isHidden(meetingRecords.get(id) || { id }, hidden);
    if (inFront || hiddenNow) out.push({ meetingId: id });
  }

  if (!alreadySent('automations') && (menuBar.sources?.automations || 0) > 0) {
    const shown = route === 'automations' || (route === 'today' && todayCards.includes('automations'));
    if (shown) out.push({ automations: true });
  }

  return out;
}

/** The menu's and the fixes' routes a `workspace:notification-open` payload may open (design §6
 *  "Opening from the menu"). */
const OPEN_ROUTES = new Set(['inbox', 'meetings', 'automations', 'settings', 'tasks']);

/**
 * What a menu row's or a fix's `open` (or a clicked notification's payload) opens — `null` for a
 * route this window doesn't know. Pure: `app.js`'s `openNotification` acts on the result.
 */
export function openTarget(payload) {
  if (!OPEN_ROUTES.has(payload?.route)) return null;
  const target = { route: payload.route };
  for (const key of ['tab', 'lane', 'meetingId', 'runId', 'automationId']) {
    if (payload[key] != null) target[key] = payload[key];
  }
  return target;
}
