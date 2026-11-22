// Inbox: Outlook + Teams in one list with a reading pane, each a page section. Lanes are
// Connect-only decisions; nothing here changes the mailbox or chat.
import { escapeHtml as e } from './store.js';
import { normalizeDock } from './dock-model.js';
import { renderDock } from './dock-view.js';
import { icon, teamsGlyph, outlookGlyph } from './icons.js';
import { avatar, badge, button, emptyState, segmented, checkbox, select, textArea } from './ui.js';
import { LANES, laneLabel, visibleMessages, decisions, connectionState, messageTitle, conversation, can, collapseChats, draftKeyOf, draftJob, latestDraft, savedReply, summaryKeyOf, summaryFor, summaryJob, records, tasksDueJob } from './selectors.js';
import { formatDateTime, relativeAge } from './format.js';
import { listTitle } from './view-today.js';
import {
  INTENTS, TONES, LENGTHS, MAX_INSTRUCTIONS, replyBox, runningLabel, provenanceLabel, draftError, draftChoices, draftGaps, claudeAvailable, providerLabel,
} from './draft-state.js';

import { summaryOffered, askDue, addedAsks, askCommitmentId } from './summary-state.js';

const LANE_TONE = { critical: 'error', reply: 'info', waiting: 'warning', fyi: 'neutral', low: 'neutral', decisions: 'purple' };

/** Filtered messages for the list, newest first (Teams chats are collapsed by the caller). */
export function filteredMessages(s, state) {
  const all = visibleMessages(s, { archived: state.showArchived, snoozed: state.showSnoozed });
  const q = state.search.trim().toLowerCase();
  return all.filter(m => (state.channel === 'all' || (m.data.channel === 'chat' ? 'chat' : 'mail') === state.channel)
    && (!q || [m.data.title, m.data.text, m.data.from, m.data.fromAddress].some(v => String(v || '').toLowerCase().includes(q))));
}

/** Inbox's sections (spec "Page sections"): the messages, pinned to Today as "Needs your reply"
 *  (the `inbox` widget), and the message being read. */
export const INBOX_DOCK = {
  title: 'Inbox',
  tabs: {
    'inbox-list': { title: 'Messages', icon: 'mail', min: 320, w: 420, pin: 'inbox', pinTitle: 'Needs your reply' },
    'inbox-reader': { title: 'Message', icon: 'reply', min: 380, w: 720 },
  },
  initial: [['inbox-list'], ['inbox-reader']],
};

/** Inbox drawn in its sections as `ctx.dock` (`{layouts, locked}`) has them. */
export function inbox(s, ctx) {
  const sections = inboxSections(s, ctx);
  // Compact: the list alone, its rows open in place; no dock frame, so the Default layout stays.
  if (ctx.view === 'compact') return `<div class="ws-inbox-compact">${sections['inbox-list']}</div>`;
  const layout = ctx.dock?.layouts?.inbox || normalizeDock(INBOX_DOCK, null);
  return renderDock('inbox', INBOX_DOCK, layout, id => sections[id], { locked: !!ctx.dock?.locked });
}

/** The body of each Inbox section: the list with its search, lanes and filters, and the reader. */
export function inboxSections(s, ctx) {
  const { state, auth, banners } = ctx;
  const compact = ctx.view === 'compact';
  const zone = s.settings.timeZone;
  const conn = connectionState(s, auth);
  const base = filteredMessages(s, state);
  const pending = decisions(s);
  const counts = Object.fromEntries(LANES.map(([key]) => [key, key === 'decisions' ? pending.length : collapseChats(base.filter(m => m.data.lane === key)).items.length]));
  const collapsed = collapseChats(state.lane === 'decisions' ? [] : base.filter(m => m.data.lane === state.lane));
  const items = collapsed.items;
  const selected = state.lane !== 'decisions' ? items.find(m => m.id === state.selectedMessage) || null : null;

  const drafting = new Set(s.jobs.filter(j => j.kind === 'ai_draft' && ['queued', 'running'].includes(j.state)).map(j => j.payload?.draftKey));
  const more = items.length > state.inboxLimit ? button(`Show ${Math.min(200, items.length - state.inboxLimit)} more`, { action: 'inbox-more' }) : '';
  const list = state.lane === 'decisions'
    ? decisionList(pending, zone)
    : items.length && compact
      ? `<div class="ws-inbox-items" role="list" aria-label="${e(laneLabel(state.lane))}">${items.slice(0, state.inboxLimit).map(m => compactRow(s, m, zone, state, { isSelected: m.id === selected?.id, isOpen: m.id === state.openMessage, count: collapsed.counts.get(m.id), drafting: drafting.has(draftKeyOf(m)) })).join('')}${more ? `<div class="ws-list-more" role="listitem">${more}</div>` : ''}</div>`
    : items.length
      ? `<div class="ws-inbox-items" role="listbox" aria-label="${e(laneLabel(state.lane))}">${items.slice(0, state.inboxLimit).map(m => listRow(s, m, zone, m.id === selected?.id, collapsed.counts.get(m.id), drafting.has(draftKeyOf(m)))).join('')}${more ? `<div class="ws-list-more">${more}</div>` : ''}</div>`
      : `<div class="ws-inbox-empty">${emptyState(conn === 'connected'
        ? { iconName: state.lane === 'reply' ? 'check-circle' : 'inbox', title: state.search ? 'No matches' : state.lane === 'reply' ? "You're all caught up" : 'Nothing here', text: state.search ? 'Try another search or filter.' : `No ${laneLabel(state.lane).toLowerCase()} items${state.channel !== 'all' ? ` in ${state.channel === 'chat' ? 'Teams' : 'Outlook'}` : ''}.` }
        : { iconName: 'inbox', title: 'Connect Outlook and Teams', text: 'Sign in with Microsoft 365 — every message that needs you lands here automatically.', actions: conn === 'authorizing' ? '' : button('Sign in with Microsoft', { action: 'graph-connect', variant: 'primary' }) })}</div>`;

  return {
    'inbox-list': `<div class="ws-inbox-pane">
      <header class="ws-inbox-head">
        <div class="ws-inbox-title"><h1>Inbox</h1>${button('', { action: 'sync', iconName: 'refresh', variant: 'ghost', title: 'Refresh Outlook and Teams' })}</div>
        <label class="ws-search">${icon('search')}<input id="inbox-search" type="search" value="${e(state.search)}" placeholder="Search people, subjects, text" aria-label="Search Inbox" autocomplete="off"></label>
        <div class="ws-lanes" role="tablist" aria-label="Inbox lanes">${LANES.map(([key, label]) => `<button type="button" role="tab" data-action="lane" data-lane="${key}" aria-selected="${state.lane === key}" class="ws-lane ws-lane-${key}">${e(label)}${counts[key] ? `<span class="ws-count">${counts[key]}</span>` : ''}</button>`).join('')}</div>
        <div class="ws-inbox-filters">
          ${segmented([['all', 'All'], ['mail', 'Outlook'], ['chat', 'Teams']], state.channel, 'channel', 'channel', 'Source')}
          <details class="ws-menu ws-menu-right"><summary class="ws-btn ws-btn-ghost ws-btn-sm">${icon('sliders')}<span>View</span></summary><div class="ws-menu-panel">
            ${checkbox({ label: 'Show archived', action: 'show-archived', checked: state.showArchived })}
            ${checkbox({ label: 'Include snoozed', action: 'show-snoozed', checked: state.showSnoozed })}
            <hr>${button('Queue rules…', { action: 'settings-tab', variant: 'ghost', iconName: 'sliders', attrs: { 'data-tab': 'queues' } })}
          </div></details>
        </div>
      </header>
      ${banners}
      ${list}
    </div>`,
    // Compact never draws the reading pane.
    ...(compact ? {} : { 'inbox-reader': `<section class="ws-reader" aria-label="Reading pane">${selected ? reader(s, selected, zone, state) : readerEmpty(state, items.length)}</section>` }),
  };
}

function listRow(s, m, zone, isSelected, count = 0, drafting = false) {
  const d = m.data;
  const unread = d.channel === 'mail' && d.isRead === false;
  const snoozed = d.snoozedUntil > Date.now() / 1000;
  const flags = [
    drafting ? `<span class="ws-flag-ai">${icon('spark')}Drafting…</span>` : '',
    snoozed ? `<span>${icon('snooze')}Snoozed</span>` : '',
    d.acknowledgedAt ? `<span>${icon('check')}Acknowledged</span>` : '',
    d.hasAttachments ? `<span title="Attachment">${icon('attachment')}Attachment</span>` : '',
    d.flagged ? `<span>${icon('flag')}Flagged</span>` : '',
  ].join('');
  return `<button type="button" role="option" aria-selected="${isSelected}" class="ws-inbox-row${isSelected ? ' ws-selected' : ''}${unread ? ' ws-unread' : ''}" data-action="select-message" data-id="${e(m.id)}">
    <span class="ws-msg-avatar">${avatar({ name: d.from || '?', size: 36, seed: d.fromAddress || d.fromId || d.from })}<span class="ws-msg-glyph">${d.channel === 'chat' ? teamsGlyph : outlookGlyph}</span></span>
    <span class="ws-msg-main">
      <span class="ws-msg-top"><strong>${e(d.isMine ? 'You' : d.from || 'Unknown sender')}</strong>${count > 1 ? `<span class="ws-thread-count" title="${count} messages in this chat">${count}</span>` : ''}<time title="${e(formatDateTime(d.at, zone))}">${e(relativeAge(d.at, zone))}</time></span>
      <span class="ws-msg-title">${d.importance === 'high' ? `<span class="ws-imp" title="High importance">!</span>` : ''}<span class="ws-ellipsis">${e(listTitle(m, s))}</span></span>
      <span class="ws-msg-preview">${e(d.text || '')}</span>
      ${flags ? `<span class="ws-msg-flags">${flags}</span>` : ''}
    </span>
    ${unread ? '<span class="ws-unread-dot" aria-label="Unread"></span>' : ''}
  </button>`;
}

/** A Compact row: one line (unread dot, sender, title with marks, thread count, time), and under
 *  it, while it is the open one, the message's actions, summary, thread and reply. */
function compactRow(s, m, zone, state, { isSelected, isOpen, count = 0, drafting = false }) {
  const d = m.data;
  const unread = d.channel === 'mail' && d.isRead === false;
  const snoozed = d.snoozedUntil > Date.now() / 1000;
  const mark = (name, label) => `<span class="ws-crow-mark" role="img" title="${label}" aria-label="${label}">${icon(name)}</span>`;
  const marks = [
    drafting ? mark('spark', 'Drafting…') : '',
    snoozed ? mark('snooze', 'Snoozed') : '',
    d.acknowledgedAt ? mark('check', 'Acknowledged') : '',
    d.hasAttachments ? mark('attachment', 'Attachment') : '',
    d.flagged ? mark('flag', 'Flagged') : '',
  ].join('');
  const body = `crow-${m.id}`;
  return `<div class="ws-crow${isOpen ? ' ws-crow-open' : ''}" role="listitem"><button type="button" class="ws-inbox-row ws-inbox-row-compact${isSelected ? ' ws-selected' : ''}${unread ? ' ws-unread' : ''}" data-action="select-message" data-id="${e(m.id)}" aria-expanded="${isOpen}" aria-controls="${e(body)}"${isSelected ? ' aria-current="true"' : ''}>
    ${unread ? '<span class="ws-unread-dot" aria-label="Unread"></span>' : ''}
    <strong class="ws-crow-from">${e(d.isMine ? 'You' : d.from || 'Unknown sender')}</strong>
    <span class="ws-crow-title">${d.importance === 'high' ? `<span class="ws-imp" title="High importance">!</span>` : ''}<span class="ws-ellipsis">${e(listTitle(m, s))}</span>${marks}</span>
    ${count > 1 ? `<span class="ws-thread-count" title="${count} messages in this chat">${count}</span>` : ''}
    <time title="${e(formatDateTime(d.at, zone))}">${e(relativeAge(d.at, zone))}</time>
  </button>${isOpen ? openRow(s, m, zone, state, body) : ''}</div>`;
}

/** The open Compact row's body: Done, Snooze ▾, Acknowledge (an unacknowledged critical message
 *  only) and ⋯ with the rest of the reader's actions; the summary; the last messages; the reply. */
function openRow(s, m, zone, state, bodyId) {
  const d = m.data;
  const isChat = d.channel === 'chat';
  const fullThread = conversation(s, m);
  const all = state.threadAll?.has(m.id);
  const thread = all ? fullThread : fullThread.slice(-12);
  const unavailable = d.unavailable || d.deleted;
  const item = (action, iconName, label, attrs = {}) => `<button type="button" class="ws-menu-item" role="menuitem" data-action="${action}"${Object.entries(attrs).map(([k, v]) => ` ${k}="${e(v)}"`).join('')}>${icon(iconName)}<span>${e(label)}</span></button>`;
  const menu = [
    d.url ? item('source', 'external', isChat ? 'Open in Teams' : 'Open in Outlook', { 'data-kind': 'message', 'data-id': m.id }) : '',
    summaryOffer(s, m, state, { thread: fullThread, unavailable }) ? item('ai-summarize', 'spark', 'Summarize', { 'data-id': m.id }) : '',
    `<label class="ws-menu-field"><span>Move to lane</span>${laneSelect(m)}</label>`,
    item('commitment', 'check-circle', 'Add a task', { 'data-id': m.id }),
  ].join('');
  return `<div class="ws-crow-body" id="${e(bodyId)}">
    <div class="ws-crow-actions">
      ${doneButton(m)}
      ${snoozeMenu(m, { compact: true })}
      ${ackButton(m)}
      <details class="ws-menu" data-menu="crow-more"><summary class="ws-btn ws-btn-ghost ws-btn-icon" aria-label="More actions" aria-haspopup="menu">${icon('dots')}</summary><div class="ws-menu-panel" role="menu">${menu}</div></details>
    </div>
    ${unavailable ? `<p class="ws-inline-note ws-warning">${icon('alert')}This item moved or was deleted in Microsoft 365. The cached text stays for your decisions.</p>` : ''}
    ${summarySection(s, m, zone, state)}
    <div class="ws-thread ws-thread-compact">${!all && fullThread.length > 12 ? `<button type="button" class="ws-thread-earlier" data-action="inbox-earlier" data-id="${e(m.id)}">Earlier</button>` : ''}${bubbles(s, m, thread, zone)}</div>
    ${replyForm(s, m, zone, state)}
  </div>`;
}

function readerEmpty(state, count) {
  if (state.lane === 'decisions') return emptyState({ iconName: 'shield', title: 'Decisions', text: 'Review prepared replies and events, or retry work that could not finish.' });
  return `<div class="ws-reader-empty">${emptyState({ iconName: 'mail', title: count ? 'Select a message' : 'Nothing selected', text: count ? 'Pick a conversation on the left to read it, move it or draft a reply.' : 'Messages you select appear here.' })}</div>`;
}

const SNOOZE = [['3h', 'Later today'], ['tomorrow', 'Tomorrow, 09:00'], ['monday', 'Next Monday, 09:00'], ['week', 'In a week']];

export function snoozeUntil(preset, nowMs = Date.now()) {
  const d = new Date(nowMs);
  if (preset === '3h') return Math.floor(nowMs / 1000) + 3 * 3600;
  if (preset === 'week') return Math.floor(nowMs / 1000) + 7 * 86400;
  d.setHours(9, 0, 0, 0);
  if (preset === 'tomorrow') d.setDate(d.getDate() + 1);
  if (preset === 'monday') d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return Math.floor(d.getTime() / 1000);
}

// The reader's actions and thread, shared with the open Compact row.
const doneButton = m => button(m.data.lifecycle === 'archived' ? 'Restore' : 'Done', { action: 'message-archive', iconName: m.data.lifecycle === 'archived' ? 'inbox' : 'check', attrs: { 'data-id': m.id }, title: m.data.lifecycle === 'archived' ? 'Move back to the Inbox' : 'Archive in Connect' });
const snoozeMenu = (m, { compact = false } = {}) => `<details class="ws-menu"${compact ? ' data-menu="crow-snooze"' : ''}><summary class="ws-btn ws-btn-secondary">${icon('snooze')}<span>Snooze</span>${compact ? icon('chevron-down') : ''}</summary><div class="ws-menu-panel">${SNOOZE.map(([value, label]) => `<button type="button" class="ws-menu-item" data-action="message-snooze" data-id="${e(m.id)}" data-preset="${value}">${e(label)}</button>`).join('')}</div></details>`;
const ackButton = m => (m.data.lane === 'critical' && !m.data.acknowledgedAt ? button('Acknowledge', { action: 'message-ack', variant: 'danger', iconName: 'bell', attrs: { 'data-id': m.id } }) : '');
const laneSelect = m => select(LANES.filter(([k]) => k !== 'decisions'), m.data.lane, { 'data-action': 'message-lane', 'data-id': m.id, 'aria-label': 'Move to lane' });
const bubbles = (s, m, thread, zone) => thread.map(t => `<div class="ws-bubble${t.id === m.id ? ' ws-current' : ''}${t.data.isMine ? ' ws-mine' : ''}">
      <div class="ws-bubble-head">${avatar({ name: t.data.isMine ? (s.connection?.displayName || 'You') : t.data.from || '?', photo: t.data.isMine ? s.connection?.photo : null, size: 24, seed: t.data.fromAddress || t.data.fromId || t.data.from })}<strong>${e(t.data.isMine ? 'You' : t.data.from || 'Unknown')}</strong><time>${e(formatDateTime(t.data.at, zone))}</time></div>
      <div class="ws-bubble-body">${e(t.data.text || '(No preview available — open the original for full content.)')}</div>
    </div>`).join('');

function reader(s, m, zone, state = {}) {
  const d = m.data;
  const isChat = d.channel === 'chat';
  const fullThread = conversation(s, m);
  const thread = fullThread.slice(-12);
  const unavailable = d.unavailable || d.deleted;
  const recipients = (d.to || []).map(r => r.emailAddress?.name || r.emailAddress?.address).filter(Boolean);
  return `<article class="ws-read" data-message-id="${e(m.id)}">
    <header class="ws-read-head">
      <div class="ws-read-badges">${badge(laneLabel(d.lane), LANE_TONE[d.lane] || 'neutral')}${badge(isChat ? 'Teams' : 'Outlook', 'neutral')}${d.lifecycle === 'archived' ? badge('Archived', 'neutral', 'archive') : ''}${d.snoozedUntil > Date.now() / 1000 ? badge(`Snoozed until ${formatDateTime(d.snoozedUntil, zone)}`, 'warning', 'snooze') : ''}</div>
      <h2>${e(isChat && messageTitle(m, s) === d.from ? `Chat with ${d.from}` : messageTitle(m, s))}</h2>
      <div class="ws-read-from">
        ${avatar({ name: d.from || '?', size: 40, seed: d.fromAddress || d.fromId || d.from })}
        <div><strong>${e(d.isMine ? 'You' : d.from || 'Unknown sender')}</strong>${d.fromAddress ? `<span>${e(d.fromAddress)}</span>` : ''}${recipients.length ? `<span class="ws-muted">To ${e(recipients.slice(0, 4).join(', '))}${recipients.length > 4 ? ` +${recipients.length - 4}` : ''}</span>` : ''}</div>
        <time>${e(formatDateTime(d.at, zone))}</time>
      </div>
      <div class="ws-read-actions">
        ${d.url ? button(isChat ? 'Open in Teams' : 'Open in Outlook', { action: 'source', iconName: 'external', variant: 'primary', attrs: { 'data-kind': 'message', 'data-id': m.id } }) : ''}
        ${doneButton(m)}
        ${snoozeMenu(m)}
        ${summaryButton(s, m, state, { thread: fullThread, unavailable })}
        <span class="ws-read-lane">${laneSelect(m)}${button('', { action: 'commitment', iconName: 'check-circle', variant: 'ghost', title: 'Add a task from this message', attrs: { 'data-id': m.id } })}</span>
        ${ackButton(m)}
      </div>
    </header>
    ${unavailable ? `<p class="ws-inline-note ws-warning">${icon('alert')}This item moved or was deleted in Microsoft 365. The cached text stays for your decisions.</p>` : ''}
    ${d.reason ? `<p class="ws-inline-note">${icon('info')}<span><strong>Why it's here:</strong> ${e(d.reason)}</span></p>` : ''}
    ${summarySection(s, m, zone, state)}
    <div class="ws-thread">${bubbles(s, m, thread, zone)}</div>
    ${replyForm(s, m, zone, state)}
  </article>`;
}

// ---------------------------------------------------------------- thread summary (DESIGN 6.5)

/** What the summary area of a conversation shows: its record, running job and failure. */
function summaryParts(s, m, state) {
  const key = summaryKeyOf(m);
  const summary = summaryFor(s, m);
  const job = summaryJob(s, key);
  const running = !!job && ['queued', 'running'].includes(job.state);
  // A failure older than the summary that followed it is history; a dismissed one stays dismissed.
  const failure = !running && job && !(state.draftDismissed || []).includes(job.id) && !(summary && (summary.updatedAt || 0) > (job.dueAt || 0))
    ? draftError(job, { ...(state.ai || {}), kind: 'summary' }) : null;
  return { key, summary, job, running, failure };
}

/** Summarize: only on a long conversation with no summary yet (a summary shows its card instead). */
function summaryOffer(s, m, state, { thread, unavailable }) {
  if (unavailable || !claudeAvailable(state.ai) || !summaryOffered(thread)) return false;
  const { summary, running, failure } = summaryParts(s, m, state);
  return !(summary || running || failure);
}

function summaryButton(s, m, state, opts) {
  if (!summaryOffer(s, m, state, opts)) return '';
  return button('Summarize', { action: 'ai-summarize', variant: 'magic', iconName: 'spark', title: 'Summarize this conversation with Claude', attrs: { 'data-id': m.id } });
}

function summarySection(s, m, zone, state) {
  const { key, summary, job, running, failure } = summaryParts(s, m, state);
  if (!summary) {
    if (running) return `<section class="ws-summary ws-summary-pending" aria-label="Thread summary">${runningRow(job, { verb: 'Summarizing', hint: 'You can keep reading.' })}</section>`;
    return failure ? `<section class="ws-summary ws-summary-pending" aria-label="Thread summary">${errorRow(job, failure)}</section>` : '';
  }
  const d = summary.data;
  const open = !state.summaryUi?.[key]?.collapsed;
  const added = addedAsks(key, d.asks, records(s, 'commitment'));
  const asks = (d.asks || []).map((ask, i) => {
    const due = askDue(ask.due, zone);
    return `<li class="ws-summary-ask">
        <span class="ws-summary-ask-text">${e(ask.text)}${due ? `<span class="ws-summary-due">${icon('clock')}Due ${e(due)}</span>` : ''}</span>
        ${added[i]
    ? `<span class="ws-summary-added" role="status">${icon('check')}Added</span>`
    : button('Add to tasks', { action: 'summary-ask-commit', size: 'sm', iconName: 'check-circle', attrs: { 'data-index': i, 'data-key': key, 'data-ask': askCommitmentId(key, ask) } })}
      </li>`;
  }).join('');
  const p = d.provenance || {};
  const refresh = (variant) => button('Refresh', { action: 'ai-summarize', variant, size: 'sm', iconName: 'refresh', title: 'Summarize again with the newest messages', disabled: running, attrs: { 'data-id': m.id } });
  return `<section class="ws-summary${d.stale ? ' ws-summary-stale' : ''}" aria-label="Thread summary" data-key="${e(key)}">
    <header class="ws-summary-head">
      <h3>${icon('spark')}Summary</h3>
      <button type="button" class="ws-summary-toggle" data-action="summary-toggle" data-key="${e(key)}" aria-expanded="${open}" aria-controls="summary-body" aria-label="Summary" title="Collapse or expand the summary">${icon('chevron-down')}</button>
    </header>
    <div class="ws-summary-body" id="summary-body"${open ? '' : ' hidden'}>
      <p class="ws-summary-text">${e(d.text)}</p>
      ${d.asks?.length ? `<div class="ws-summary-asks"><span class="ws-field-label">Asked of you</span><ul>${asks}</ul></div>` : ''}
      ${running ? runningRow(job, { verb: 'Summarizing', hint: '' }) : ''}
      ${failure ? errorRow(job, failure) : ''}
      ${d.stale && !running && !failure ? `<p class="ws-summary-stale-note" role="status">${icon('info')}<span>New messages since this summary.</span>${refresh('secondary')}</p>` : ''}
      <div class="ws-draft-provenance-row ws-summary-foot">
        <span class="ws-draft-source">${icon('spark')}<span>${e(provenanceLabel(p, 'Summarized'))}</span></span>
        ${p.partialText ? `<span class="ws-draft-partial" title="Connect could read only the preview of some Outlook messages, so the summary may miss details.">${icon('info')}Preview text only</span>` : ''}
        ${(d.stale && !running) || failure ? '' : `<span class="ws-draft-provenance-actions">${refresh('ghost')}</span>`}
      </div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------- reply box and drafts (DESIGN 6.4)

function replyForm(s, m, zone, state) {
  const d = m.data;
  const isChat = d.channel === 'chat';
  const unavailable = d.unavailable || d.deleted;
  const canSend = can(s, isChat ? 'chat_send' : 'mail_send');
  const key = draftKeyOf(m);
  const ui = state.drafts?.[key] || {};
  const ai = latestDraft(s, key);
  const job = draftJob(s, key);
  const box = replyBox({ manual: savedReply(s, m), ai, ui });
  const running = !!job && ['queued', 'running'].includes(job.state);
  // A failure older than the draft that followed it is history; a dismissed one stays dismissed.
  const failure = !running && job && !(state.draftDismissed || []).includes(job.id) && !(ai && (ai.updatedAt || 0) > (job.dueAt || 0)) ? draftError(job, state.ai) : null;
  const showAi = !!ai && !box.confirm && (box.fromAi || ui.seen === ai.revision);
  // Own Outlook messages cannot be answered through Review & send, so there is nothing to draft.
  const draftable = isChat || !d.isMine;
  const popover = draftable && state.draftPopover?.key === key ? draftPopover(m, state) : '';
  return `<form class="ws-reply${showAi || running ? ' ws-reply-ai' : ''}" data-form="reply" data-id="${e(m.id)}" data-key="${e(key)}">
      <div class="ws-reply-head">
        <label class="ws-field-label" for="reply-body">${icon('reply')}Your reply</label>
        ${draftable ? draftTrigger(m, state, { running, unavailable, open: !!popover }) : ''}
      </div>
      ${running ? runningRow(job) : ''}
      ${failure ? errorRow(job, failure) : ''}
      ${box.confirm ? confirmRow(m, box.confirm) : ''}
      <textarea id="reply-body" class="ws-textarea" name="body" maxlength="20000" placeholder="${isChat ? 'Write a Teams reply…' : 'Write a reply…'}" ${unavailable ? 'disabled' : ''}>${e(box.text)}</textarea>
      ${showAi ? provenanceRow(s, m, ai, ui, zone, running) : ''}
      ${todoPanel(box.text, ai?.data.text, showAi ? ai.data.questions : [])}
      <div class="ws-reply-actions">
        <span class="ws-muted ws-hint">${canSend ? 'You review every reply before it is sent.' : `Drafts stay on this device. Send from ${isChat ? 'Teams' : 'Outlook'}, or allow replies in Settings → Microsoft 365.`}</span>
        <span class="ws-actions">
          ${button('Save draft', { action: 'draft-save', attrs: { 'data-id': m.id } })}
          ${canSend ? '' : button('Copy reply', { action: 'reply-copy', iconName: 'copy', title: `Copy the reply to paste it in ${isChat ? 'Teams' : 'Outlook'}`, attrs: { 'data-id': m.id } })}
          ${canSend ? button('Review & send', { type: 'submit', variant: 'primary', iconName: 'reply', disabled: unavailable }) : d.url ? button(isChat ? 'Reply in Teams' : 'Reply in Outlook', { action: 'source', iconName: 'external', attrs: { 'data-kind': 'message', 'data-id': m.id } }) : ''}
        </span>
      </div>
      ${popover}
    </form>`;
}

function draftTrigger(m, state, { running, unavailable, open }) {
  if (!claudeAvailable(state.ai)) {
    return button('Set up Claude', { action: 'ai-open-settings', variant: 'secondary', iconName: 'spark', title: 'No Claude is ready to draft on this Mac yet' });
  }
  return button('Draft with AI', {
    action: 'ai-draft-options', variant: 'magic', iconName: 'spark', iconRight: 'chevron-down', disabled: running || unavailable,
    title: running ? 'Claude is already drafting this reply' : 'Draft a reply with Claude',
    attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': String(open), 'aria-controls': 'draft-options', 'data-id': m.id },
  });
}

const chips = (field, choices, current) => `<div class="ws-draft-chips" role="group" aria-labelledby="draft-${field}-label">${choices.map(([value, label]) => `<button type="button" class="ws-draft-chip" data-action="ai-draft-pick" data-draft-${field}="${value}" aria-pressed="${value === current}">${e(label)}</button>`).join('')}</div>`;

/** The options popover, anchored to Draft with AI (placed by the controller). */
function draftPopover(m, state) {
  const pop = state.draftPopover;
  const o = pop.options;
  const profile = state.ai?.settings?.routes?.[m.data.channel === 'chat' ? 'chat_draft' : 'mail_draft']?.profile || state.ai?.settings?.defaultProfile;
  const provider = providerLabel(profile, state.ai?.profiles);
  const count = (pop.instructions || '').length;
  return `<div class="ws-draft-pop" id="draft-options" role="dialog" aria-labelledby="draft-options-title" data-id="${e(m.id)}">
    <div class="ws-draft-pop-head"><strong id="draft-options-title">${icon('spark')}Draft with AI</strong><span>${m.data.channel === 'chat' ? 'Teams reply' : 'Outlook reply'}</span></div>
    <div class="ws-draft-grid">
      <span class="ws-field-label" id="draft-intent-label">Intent</span>${chips('intent', INTENTS, o.intent)}
      <span class="ws-field-label" id="draft-tone-label">Tone</span>${chips('tone', TONES, o.tone)}
      <span class="ws-field-label" id="draft-length-label">Length</span>${chips('length', LENGTHS, o.length)}
    </div>
    ${checkbox({ name: 'includeFreeTimes', label: 'Suggest times from my calendar', hint: 'Free slots of 30 min or more in your next 3 working days, 09:00–18:00.', action: 'ai-draft-free-times', checked: o.includeFreeTimes, attrs: { id: 'draft-free-times' } })}
    <div class="ws-draft-field">
      <span class="ws-draft-label-row"><label class="ws-field-label" for="draft-instructions">Instructions</label><span class="ws-draft-count" data-draft-count>${count ? `${count.toLocaleString('en-US')} / 1,000` : 'Optional'}</span></span>
      ${textArea(pop.instructions || '', { id: 'draft-instructions', maxlength: MAX_INSTRUCTIONS, rows: 2, placeholder: 'e.g. Say I can join on Thursday', 'aria-describedby': 'draft-privacy' })}
    </div>
    <div class="ws-draft-pop-foot">
      <span class="ws-draft-privacy" id="draft-privacy">${icon('lock')}Sent only to ${e(provider)} to write this draft.</span>
      <span class="ws-actions">${button('Cancel', { action: 'ai-draft-cancel', variant: 'ghost' })}${button('Draft', { action: 'ai-draft', variant: 'magic', iconName: 'spark', title: 'Draft (⌘↵ or Ctrl+Enter)' })}</span>
    </div>
  </div>`;
}

function runningRow(job, { verb = 'Drafting', hint = 'You can keep writing.' } = {}) {
  const p = job.payload || {};
  const { label, seconds } = runningLabel(job, { verb });
  return `<div class="ws-draft-running" data-verb="${e(verb)}" data-started="${e(p.startedAt || '')}" data-profile="${e(p.profile || '')}" data-model="${e(p.runModel || p.model || '')}" data-state="${e(job.state)}">
      <span class="ws-draft-pulse" aria-hidden="true">${icon('spark')}</span>
      <span class="ws-draft-running-label" role="status"><span data-draft-label>${e(label)}</span> <span class="ws-draft-seconds" data-draft-seconds aria-hidden="true">${seconds ? `${seconds} s` : ''}</span></span>
      ${hint ? `<span class="ws-draft-running-hint">${e(hint)}</span>` : ''}
      ${button('Stop', { action: 'ai-draft-stop', variant: 'ghost', size: 'sm', iconName: 'stop', attrs: { 'data-id': job.id } })}
    </div>`;
}

// Rows that re-render while the user types are polite status messages, not alerts.
function errorRow(job, failure) {
  const { tone, sentence, action } = failure;
  return `<div class="ws-draft-error ws-draft-tone-${tone}" role="status">
      ${icon(tone === 'error' ? 'alert' : tone === 'info' ? 'spark' : 'info')}
      <p><strong>${e(sentence)}</strong></p>
      <div class="ws-draft-error-actions">${action ? button(action.label, { action: action.action, iconName: action.iconName, size: 'sm', attrs: action.attrs }) : ''}${button('', { action: 'ai-draft-dismiss', iconName: 'close', variant: 'ghost', size: 'sm', title: 'Dismiss', attrs: { 'data-id': job.id } })}</div>
    </div>`;
}

function confirmRow(m, draft) {
  const preview = draft.length > 180 ? `${draft.slice(0, 180).trimEnd()}…` : draft;
  return `<div class="ws-draft-confirm" role="status">
      <span class="ws-draft-pulse" aria-hidden="true">${icon('spark')}</span>
      <div class="ws-draft-confirm-copy"><strong>Replace your text with the draft?</strong><p>${e(preview)}</p></div>
      <div class="ws-draft-confirm-actions">${button('Keep mine', { action: 'ai-draft-keep', size: 'sm', attrs: { 'data-id': m.id } })}${button('Replace', { action: 'ai-draft-replace', variant: 'primary', size: 'sm', attrs: { 'data-id': m.id } })}</div>
    </div>`;
}

/** The automation that prepared a draft, by name; one deleted since is "an automation". */
function automationName(s, p) {
  if (!p.automationId) return '';
  const name = s.records.find(r => r.kind === 'automation' && r.id === p.automationId)?.data.name;
  return name ? `“${name}”` : 'an automation';
}

function provenanceRow(s, m, ai, ui, zone, running) {
  const p = ai.data.provenance || {};
  const used = (p.messageIds || []).map(id => s.records.find(r => r.kind === 'message' && r.id === id));
  const items = used.map(r => (r
    ? `<li>${avatar({ name: r.data.isMine ? (s.connection?.displayName || 'You') : r.data.from || '?', size: 20, seed: r.data.fromAddress || r.data.fromId || r.data.from })}<strong>${e(r.data.isMine ? 'You' : r.data.from || 'Unknown sender')}</strong><time>${e(formatDateTime(r.data.at, zone))}</time></li>`
    : `<li class="ws-muted">${icon('info')}A message no longer in Connect</li>`)).join('');
  const open = !!ui.contextOpen;
  return `<div class="ws-draft-provenance">
      <div class="ws-draft-provenance-row">
        <span class="ws-draft-source">${icon('spark')}<span>${e(provenanceLabel(p, 'Drafted', automationName(s, p)))}</span>
          <button type="button" class="ws-draft-context-toggle" data-action="ai-draft-context" data-key="${e(draftKeyOf(m))}" aria-expanded="${open}" aria-controls="draft-context">Context${icon('chevron-down')}</button></span>
        ${p.partialText ? `<span class="ws-draft-partial" title="Connect could read only the preview of some Outlook messages, so the draft may miss details.">${icon('info')}Preview text only</span>` : ''}
        <span class="ws-draft-provenance-actions">
          ${ui.restore ? `<span class="ws-draft-restore">${button('Restore my text', { action: 'ai-draft-restore', variant: 'ghost', size: 'sm', iconName: 'reply', title: 'Put back the text you had before the draft. Changes you made to the draft are discarded.', attrs: { 'data-id': m.id } })}${button('', { action: 'ai-draft-forget', variant: 'ghost', size: 'sm', iconName: 'close', title: 'Keep the draft and stop offering to restore your text', attrs: { 'data-id': m.id } })}</span>` : ''}
          ${button('Regenerate', { action: 'ai-draft-regenerate', variant: 'ghost', size: 'sm', iconName: 'refresh', title: 'Draft again with the same options', disabled: running, attrs: { 'data-id': m.id } })}
        </span>
      </div>
      <ul id="draft-context" class="ws-draft-context" aria-label="Messages the draft was written from"${open ? '' : ' hidden'}>${items}</ul>
    </div>`;
}

/**
 * The choices and gaps Claude left (`aiText` is its draft) that are still in the reply; the
 * controller refreshes this part as the user types. The user's own brackets never show here.
 */
export function draftChecks(text, aiText) {
  const choices = draftChoices(text, aiText);
  const gaps = draftGaps(text, aiText);
  if (!choices.length && !gaps.length) return '';
  return `${choices.length ? `<p class="ws-draft-todo-title">${icon('alert')}Choose an option in brackets before sending.</p>
    ${choices.map((c, i) => `<div class="ws-draft-choice" role="group" aria-label="Choice ${i + 1}">${c.options.map(option => button(option, { action: 'ai-draft-choice', size: 'sm', attrs: { 'data-index': i, 'data-option': option } })).join('<span class="ws-draft-or">or</span>')}</div>`).join('')}` : ''}
    ${gaps.length ? `<p class="ws-draft-gaps">${icon('edit')}<span>Fill in</span>${gaps.map((g, i) => `<button type="button" class="ws-draft-gap" data-action="ai-draft-gap" data-index="${i}" title="Select it in your reply">${e(g.raw)}</button>`).join('')}</p>` : ''}`;
}

function todoPanel(text, aiText, questions = []) {
  const checks = draftChecks(text, aiText);
  const asks = (questions || []).filter(Boolean);
  return `<section class="ws-draft-todo" aria-label="Before you send"${checks || asks.length ? '' : ' hidden'}>
      <div data-draft-checks>${checks}</div>
      ${asks.length ? `<div class="ws-draft-questions"><span class="ws-field-label">Claude needs from you</span><ul>${asks.map(q => `<li>${e(q)}</li>`).join('')}</ul></div>` : ''}
    </section>`;
}

function decisionList(pending, zone) {
  if (!pending.length) {
    return `<div class="ws-inbox-empty">${emptyState({ iconName: 'shield', title: 'No decisions waiting', text: 'Prepared replies, events and work that needs a retry show up here. Nothing is sent automatically.' })}</div>`;
  }
  const label = { sync: 'Refresh Microsoft sources', reminder: 'Reminder', notification: 'Critical alert', calendar_window: 'Calendar period' };
  return `<div class="ws-inbox-items">${pending.map(r => r.kind === 'action'
    ? `<div class="ws-decision">${badge(r.data.state.replace('_', ' '), r.data.state === 'prepared' ? 'info' : 'warning')}<div><strong>${e(r.data.review?.title || 'Prepared action')}</strong><p>${e(r.data.message || 'Review before it expires.')}</p></div>${button('Review', { action: 'action-detail', variant: 'primary', attrs: { 'data-id': r.id } })}</div>`
    : `<div class="ws-decision">${badge(r.state, r.state === 'failed' ? 'error' : 'warning')}<div><strong>${e(tasksDueJob(r) ? 'Tasks due today' : label[r.kind] || r.kind)}</strong><p>${e(r.result || '')}</p><small class="ws-muted">${e(formatDateTime(r.dueAt, zone))}</small></div>${['notification', 'send', 'reminder'].includes(r.kind) ? button('Activity', { action: 'settings-tab', attrs: { 'data-tab': 'activity' } }) : button('Retry', { action: 'job-retry', attrs: { 'data-id': r.id } })}</div>`).join('')}</div>`;
}
