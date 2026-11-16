// Inbox: Outlook + Teams in one list with a reading pane. Lanes are Connect-only decisions;
// nothing here changes the mailbox or chat.
import { escapeHtml as e } from './store.js';
import { icon, teamsGlyph, outlookGlyph } from './icons.js';
import { avatar, badge, button, emptyState, segmented, checkbox, select } from './ui.js';
import { LANES, laneLabel, visibleMessages, decisions, connectionState, messageTitle, conversation, can, records, active, collapseChats, messageKey } from './selectors.js';
import { formatDateTime, relativeAge } from './format.js';
import { listTitle } from './view-today.js';

const LANE_TONE = { critical: 'error', reply: 'info', waiting: 'warning', fyi: 'neutral', low: 'neutral', decisions: 'purple' };

/** Filtered messages for the list, newest first (Teams chats are collapsed by the caller). */
export function filteredMessages(s, state) {
  const all = visibleMessages(s, { archived: state.showArchived, snoozed: state.showSnoozed });
  const q = state.search.trim().toLowerCase();
  return all.filter(m => (state.channel === 'all' || (m.data.channel === 'chat' ? 'chat' : 'mail') === state.channel)
    && (!q || [m.data.title, m.data.text, m.data.from, m.data.fromAddress].some(v => String(v || '').toLowerCase().includes(q))));
}

export function inbox(s, ctx) {
  const { state, auth, banners } = ctx;
  const zone = s.settings.timeZone;
  const conn = connectionState(s, auth);
  const base = filteredMessages(s, state);
  const pending = decisions(s);
  const counts = Object.fromEntries(LANES.map(([key]) => [key, key === 'decisions' ? pending.length : collapseChats(base.filter(m => m.data.lane === key)).items.length]));
  const collapsed = collapseChats(state.lane === 'decisions' ? [] : base.filter(m => m.data.lane === state.lane));
  const items = collapsed.items;
  const selected = state.lane !== 'decisions' ? items.find(m => m.id === state.selectedMessage) || null : null;

  const list = state.lane === 'decisions'
    ? decisionList(pending, zone)
    : items.length
      ? `<div class="ws-inbox-items" role="listbox" aria-label="${e(laneLabel(state.lane))}">${items.slice(0, state.inboxLimit).map(m => listRow(s, m, zone, m.id === selected?.id, collapsed.counts.get(m.id))).join('')}${items.length > state.inboxLimit ? `<div class="ws-list-more">${button(`Show ${Math.min(200, items.length - state.inboxLimit)} more`, { action: 'inbox-more' })}</div>` : ''}</div>`
      : `<div class="ws-inbox-empty">${emptyState(conn === 'connected'
        ? { iconName: state.lane === 'reply' ? 'check-circle' : 'inbox', title: state.search ? 'No matches' : state.lane === 'reply' ? "You're all caught up" : 'Nothing here', text: state.search ? 'Try another search or filter.' : `No ${laneLabel(state.lane).toLowerCase()} items${state.channel !== 'all' ? ` in ${state.channel === 'chat' ? 'Teams' : 'Outlook'}` : ''}.` }
        : { iconName: 'inbox', title: 'Connect Outlook and Teams', text: 'Sign in with Microsoft 365 — every message that needs you lands here automatically.', actions: conn === 'authorizing' ? '' : button('Sign in with Microsoft', { action: 'graph-connect', variant: 'primary' }) })}</div>`;

  return `<div class="ws-inbox-page">
    <section class="ws-inbox-pane">
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
    </section>
    <section class="ws-reader" aria-label="Reading pane">${selected ? reader(s, selected, zone) : readerEmpty(state, items.length)}</section>
  </div>`;
}

function listRow(s, m, zone, isSelected, count = 0) {
  const d = m.data;
  const unread = d.channel === 'mail' && d.isRead === false;
  const snoozed = d.snoozedUntil > Date.now() / 1000;
  return `<button type="button" role="option" aria-selected="${isSelected}" class="ws-inbox-row${isSelected ? ' ws-selected' : ''}${unread ? ' ws-unread' : ''}" data-action="select-message" data-id="${e(m.id)}">
    <span class="ws-msg-avatar">${avatar({ name: d.from || '?', size: 36, seed: d.fromAddress || d.fromId || d.from })}<span class="ws-msg-glyph">${d.channel === 'chat' ? teamsGlyph : outlookGlyph}</span></span>
    <span class="ws-msg-main">
      <span class="ws-msg-top"><strong>${e(d.isMine ? 'You' : d.from || 'Unknown sender')}</strong>${count > 1 ? `<span class="ws-thread-count" title="${count} messages in this chat">${count}</span>` : ''}<time title="${e(formatDateTime(d.at, zone))}">${e(relativeAge(d.at, zone))}</time></span>
      <span class="ws-msg-title">${d.importance === 'high' ? `<span class="ws-imp" title="High importance">!</span>` : ''}${e(listTitle(m, s))}</span>
      <span class="ws-msg-preview">${e(d.text || '')}</span>
      ${snoozed || d.acknowledgedAt || d.hasAttachments || d.flagged ? `<span class="ws-msg-flags">${snoozed ? `<span>${icon('snooze')}Snoozed</span>` : ''}${d.acknowledgedAt ? `<span>${icon('check')}Acknowledged</span>` : ''}${d.hasAttachments ? `<span title="Attachment">${icon('attachment')}Attachment</span>` : ''}${d.flagged ? `<span>${icon('flag')}Flagged</span>` : ''}</span>` : ''}
    </span>
    ${unread ? '<span class="ws-unread-dot" aria-label="Unread"></span>' : ''}
  </button>`;
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

function reader(s, m, zone) {
  const d = m.data;
  const isChat = d.channel === 'chat';
  const fullThread = conversation(s, m);
  const thread = fullThread.slice(-12);
  const threadIds = new Set(fullThread.map(t => t.id));
  // A chat's newest message changes as people write; its draft stays with the conversation.
  const draft = records(s, 'draft').filter(r => threadIds.has(r.data.sourceId) && !r.data.aiSuggested).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const unavailable = d.unavailable || d.deleted;
  const canSend = can(s, isChat ? 'chat_send' : 'mail_send');
  const recipients = (d.to || []).map(r => r.emailAddress?.name || r.emailAddress?.address).filter(Boolean);
  const laneOptions = LANES.filter(([k]) => k !== 'decisions');
  const w = active(s);
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
        ${button(d.lifecycle === 'archived' ? 'Restore' : 'Done', { action: 'message-archive', iconName: d.lifecycle === 'archived' ? 'inbox' : 'check', attrs: { 'data-id': m.id }, title: d.lifecycle === 'archived' ? 'Move back to the Inbox' : 'Archive in Connect' })}
        <details class="ws-menu"><summary class="ws-btn ws-btn-secondary">${icon('snooze')}<span>Snooze</span></summary><div class="ws-menu-panel">${SNOOZE.map(([value, label]) => `<button type="button" class="ws-menu-item" data-action="message-snooze" data-id="${e(m.id)}" data-preset="${value}">${e(label)}</button>`).join('')}</div></details>
        <span class="ws-read-lane">${select(laneOptions, d.lane, { 'data-action': 'message-lane', 'data-id': m.id, 'aria-label': 'Move to lane' })}</span>
        ${button('', { action: 'commitment', iconName: 'check-circle', variant: 'ghost', title: 'Add a commitment from this message', attrs: { 'data-id': m.id } })}
        ${d.lane === 'critical' && !d.acknowledgedAt ? button('Acknowledge', { action: 'message-ack', variant: 'danger', iconName: 'bell', attrs: { 'data-id': m.id } }) : ''}
      </div>
    </header>
    ${unavailable ? `<p class="ws-inline-note ws-warning">${icon('alert')}This item moved or was deleted in Microsoft 365. The cached text stays for your decisions.</p>` : ''}
    ${d.reason ? `<p class="ws-inline-note">${icon('info')}<span><strong>Why it's here:</strong> ${e(d.reason)}</span></p>` : ''}
    <div class="ws-thread">${thread.map(t => `<div class="ws-bubble${t.id === m.id ? ' ws-current' : ''}${t.data.isMine ? ' ws-mine' : ''}">
      <div class="ws-bubble-head">${avatar({ name: t.data.isMine ? (s.connection?.displayName || 'You') : t.data.from || '?', photo: t.data.isMine ? s.connection?.photo : null, size: 24, seed: t.data.fromAddress || t.data.fromId || t.data.from })}<strong>${e(t.data.isMine ? 'You' : t.data.from || 'Unknown')}</strong><time>${e(formatDateTime(t.data.at, zone))}</time></div>
      <div class="ws-bubble-body">${e(t.data.text || '(No preview available — open the original for full content.)')}</div>
    </div>`).join('')}</div>
    <form class="ws-reply" data-form="reply" data-id="${e(m.id)}" data-key="${e(messageKey(m))}">
      <label class="ws-field-label" for="reply-body">${icon('reply')}Your reply</label>
      <textarea id="reply-body" class="ws-textarea" name="body" maxlength="20000" placeholder="${isChat ? 'Write a Teams reply…' : 'Write a reply…'}" ${unavailable ? 'disabled' : ''}>${e(draft?.data.text || '')}</textarea>
      <div class="ws-reply-actions">
        <span class="ws-muted ws-hint">${canSend ? 'You review every reply before it is sent.' : `Drafts stay on this device. Send from ${isChat ? 'Teams' : 'Outlook'}, or allow replies in Settings → Microsoft 365.`}</span>
        <span class="ws-actions">
          ${w.aiProfile ? button('Draft with AI', { action: 'ai-draft', variant: 'magic', iconName: 'spark', attrs: { 'data-id': m.id } }) + button('Load AI draft', { action: 'ai-load', variant: 'ghost', attrs: { 'data-id': m.id } }) : ''}
          ${button('Save draft', { action: 'draft-save', attrs: { 'data-id': m.id } })}
          ${canSend ? button('Review & send', { type: 'submit', variant: 'primary', iconName: 'reply', disabled: unavailable }) : d.url ? button(isChat ? 'Reply in Teams' : 'Reply in Outlook', { action: 'source', iconName: 'external', attrs: { 'data-kind': 'message', 'data-id': m.id } }) : ''}
        </span>
      </div>
    </form>
  </article>`;
}

function decisionList(pending, zone) {
  if (!pending.length) {
    return `<div class="ws-inbox-empty">${emptyState({ iconName: 'shield', title: 'No decisions waiting', text: 'Prepared replies, events and work that needs a retry show up here. Nothing is sent automatically.' })}</div>`;
  }
  const label = { sync: 'Refresh Microsoft sources', brief: 'Daily brief', reminder: 'Reminder', notification: 'Critical alert', ai_draft: 'AI reply draft', calendar_window: 'Calendar period' };
  return `<div class="ws-inbox-items">${pending.map(r => r.kind === 'action'
    ? `<div class="ws-decision">${badge(r.data.state.replace('_', ' '), r.data.state === 'prepared' ? 'info' : 'warning')}<div><strong>${e(r.data.review?.title || 'Prepared action')}</strong><p>${e(r.data.message || 'Review before it expires.')}</p></div>${button('Review', { action: 'action-detail', variant: 'primary', attrs: { 'data-id': r.id } })}</div>`
    : `<div class="ws-decision">${badge(r.state, r.state === 'failed' ? 'error' : 'warning')}<div><strong>${e(label[r.kind] || r.kind)}</strong><p>${e(r.result || '')}</p><small class="ws-muted">${e(formatDateTime(r.dueAt, zone))}</small></div>${['notification', 'send', 'reminder'].includes(r.kind) ? button('Activity', { action: 'settings-tab', attrs: { 'data-tab': 'activity' } }) : button('Retry', { action: 'job-retry', attrs: { 'data-id': r.id } })}</div>`).join('')}</div>`;
}
