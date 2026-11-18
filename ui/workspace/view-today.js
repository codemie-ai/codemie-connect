// Today: what is happening now, what is next, what needs a reply and what you promised.
import { escapeHtml as e } from './store.js';
import { icon, microsoftLogo, teamsGlyph, outlookGlyph } from './icons.js';
import { avatar, button, card, emptyState, badge } from './ui.js';
import { eventsOnDay, layoutColumns, freeSlots, visibleEvents, calendarColors } from './calendar-model.js';
import { attentionMessages, records, active, connectionState, messageTitle, decisions, draftKeyOf } from './selectors.js';
import { claudeAvailable } from './draft-state.js';
import { dayKey, addDaysToKey, formatDate, formatTime, durationLabel, countdownLabel, greeting, firstName, zonedParts, relativeAge, hourLabel } from './format.js';
import { automationResultsCard } from './view-automations.js';
import { PLUGINS_CARD, parseLayoutId, pluginWidgetCard, pluginsCard, showPluginsCard } from './today-plugins.js';
import { isMine, meOf, ownerOf, sortTasks, taskStatus } from './tasks-model.js';
import { showMeetingsCard, todayMeetingsCard } from './view-meetings.js';

export const WIDGETS = {
  brief: { title: 'Up next', width: 8, description: 'Your current or next meeting with a one-click join.' },
  focus: { title: 'Day at a glance', width: 4, description: 'Meetings, free time, replies and a focus timer.' },
  calendar: { title: 'Schedule', width: 6, description: "Today's timeline with free time between meetings." },
  inbox: { title: 'Needs your reply', width: 6, description: 'Outlook and Teams messages waiting for you.' },
  commitments: { title: 'Tasks', width: 12, description: 'Your open tasks and a scratchpad for Connect.' },
  meetings: { title: 'From your meetings', width: 6, description: 'Meetings that need you and transcripts waiting for notes.' },
  automations: { title: 'Automation results', width: 6, description: 'The latest result of each automation, with its sources.' },
  [PLUGINS_CARD]: { title: 'From plugins', width: 12, description: 'Decisions, deliveries and held messages your plugins prepare.' },
};
export const WIDGET_IDS = Object.keys(WIDGETS);

/** What Customize lists, in the layout's order then the rest: Today's cards and the widgets the
 *  enabled plugins declare (`pluginCatalog`, from `pluginWidgetCatalog`). */
export function customizeEntries(w, pluginCatalog = []) {
  const all = [
    ...WIDGET_IDS.map(id => ({ id, ...WIDGETS[id] })),
    ...pluginCatalog.map(p => ({ id: p.id, title: p.title, description: p.description, width: p.width, plugin: p.plugin })),
  ];
  const byId = new Map(all.map(x => [x.id, x]));
  const order = [...w.layout.filter(id => byId.has(id)), ...all.map(x => x.id).filter(id => !w.layout.includes(id))];
  return order.map(id => byId.get(id));
}

const WORKDAY_START = 9 * 60;
const WORKDAY_END = 18 * 60;

/** Everything Today needs, computed once per render. */
export function todayModel(s, hidden, nowMs = Date.now()) {
  const zone = s.settings.timeZone;
  const todayKey = dayKey(nowMs, zone);
  const tomorrowKey = addDaysToKey(todayKey, 1);
  const events = visibleEvents(s, hidden).filter(r => r.data.response !== 'declined');
  const today = eventsOnDay(events, todayKey, zone);
  const tomorrow = eventsOnDay(events, tomorrowKey, zone);
  const nowMin = zonedParts(nowMs, zone).hour * 60 + zonedParts(nowMs, zone).minute;
  const timed = today.timed.map(t => ({ ...t, startMs: new Date(t.record.data.start).getTime(), endMs: new Date(t.record.data.end).getTime() }));
  const current = timed.filter(t => t.startMs <= nowMs && t.endMs > nowMs && t.record.data.showAs !== 'free');
  const upcoming = timed.filter(t => t.startMs > nowMs);
  const remaining = timed.filter(t => t.endMs > nowMs);
  const busyMinutes = timed.filter(t => t.record.data.showAs !== 'free').reduce((sum, t) => sum + (t.endMin - t.startMin), 0);
  const free = freeSlots(timed, Math.max(nowMin, WORKDAY_START), WORKDAY_END, 15, today.allDay);
  const freeMinutes = free.reduce((sum, [a, b]) => sum + (b - a), 0);
  return {
    zone, nowMs, nowMin, todayKey, today, timed, current, upcoming, remaining, busyMinutes, freeMinutes,
    tomorrowFirst: tomorrow.timed[0] || null,
    attention: attentionMessages(s),
    commitments: records(s, 'commitment'),
  };
}

export function today(s, ctx) {
  const { auth, hidden, banners } = ctx;
  const w = active(s);
  const m = todayModel(s, hidden, ctx.now);
  const state = connectionState(s, auth);
  const connected = state === 'connected';
  const c = s.connection;
  const name = firstName(c);
  const hour = zonedParts(m.nowMs, m.zone).hour;
  const summary = connected ? daySummary(m) : 'Your personal workspace. Connect Microsoft 365 to bring in your calendar, Outlook and Teams.';
  const widgets = {
    brief: () => upNextCard(s, m, connected),
    focus: () => glanceCard(s, m, connected),
    calendar: () => scheduleCard(s, m, connected),
    inbox: () => attentionCard(s, m, connected, ctx.state?.ai),
    commitments: () => commitmentsCard(s, m, w),
    meetings: () => todayMeetingsCard(s, m.nowMs),
    automations: () => automationResultsCard(s, ctx.state?.ai),
    [PLUGINS_CARD]: () => pluginsCard(s, { zone: m.zone, routeOf: ctx.plugins?.routeOf }),
  };
  const catalog = ctx.plugins?.catalog || [];
  const layout = w.layout.filter(id => widgets[id] || parseLayoutId(id));
  // "From your meetings" shows itself while a meeting waits, until a saved layout hides it.
  if (!layout.includes('meetings') && showMeetingsCard(w, s, m.nowMs)) layout.push('meetings');
  if (!layout.includes(PLUGINS_CARD) && showPluginsCard(w, s)) layout.push(PLUGINS_CARD);
  const grid = layout.map(id => {
    const fallback = WIDGETS[id]?.width || catalog.find(x => x.id === id)?.width || 6;
    const width = [4, 6, 8, 12].includes(w.widgetWidths?.[id]) ? w.widgetWidths[id] : fallback;
    const html = widgets[id] ? widgets[id]() : pluginWidgetCard(s, id, { catalog, drawn: ctx.plugins?.drawn, zone: m.zone });
    return html.replace('class="ws-card', `class="ws-card ws-span-${width}`);
  }).join('');
  return `<div class="ws-today">
    <header class="ws-today-head">
      ${avatar({ name: c?.displayName || w.name, photo: c?.photo, size: 56, className: 'ws-today-avatar' })}
      <div class="ws-today-title">
        <p class="ws-eyebrow">${e(formatDate(m.nowMs, m.zone, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
        <h1>${e(greeting(hour))}${name ? `, ${e(name)}` : ''}</h1>
        <p class="ws-description">${e(summary)}</p>
      </div>
      <div class="ws-actions">${button('Customize', { action: 'customize', iconName: 'sliders' })}</div>
    </header>
    ${banners}
    ${ctx.codemieCard || ''}
    ${state === 'none' || state === 'authorizing' ? connectHero(state) : ''}
    ${layout.length ? `<div class="ws-grid">${grid}</div>` : emptyState({ iconName: 'today', title: 'Make Today your own', text: 'Choose the cards you want on Today.', actions: button('Choose cards', { action: 'customize', variant: 'primary' }) })}
  </div>`;
}

function daySummary(m) {
  const parts = [];
  const left = m.remaining.length;
  parts.push(left ? `${left} meeting${left === 1 ? '' : 's'} left today` : m.timed.length ? 'No more meetings today' : 'No meetings today');
  if (m.freeMinutes >= 15 && m.nowMin < WORKDAY_END) parts.push(`${durationLabel(m.freeMinutes)} free until ${formatTime(endOfWorkday(m), m.zone)}`);
  const replies = m.attention.length;
  if (replies) parts.push(`${replies} message${replies === 1 ? '' : 's'} need${replies === 1 ? 's' : ''} you`);
  return parts.join(' · ');
}

function endOfWorkday(m) {
  return m.nowMs + (WORKDAY_END - m.nowMin) * 60_000;
}

function connectHero(state) {
  const pending = state === 'authorizing';
  return `<section class="ws-connect-hero">
    <div class="ws-connect-copy">
      <span class="ws-connect-mark">${microsoftLogo}</span>
      <div>
        <h2>Bring your day together</h2>
        <p>Sign in once with Microsoft 365. Connect reads your calendars, Outlook and Teams chats automatically — nothing to configure, nothing is sent on your behalf.</p>
        <ul class="ws-connect-points">
          <li>${icon('calendar')} Every calendar with times, rooms and Teams links</li>
          <li>${outlookGlyph} Outlook messages that need a reply</li>
          <li>${teamsGlyph} Teams chats and mentions</li>
        </ul>
      </div>
    </div>
    <div class="ws-connect-cta">
      ${pending
    ? `<p class="ws-pending">${icon('refresh', 'ws-spin')} Finish signing in in your browser…</p>${button('Cancel', { action: 'graph-cancel' })}`
    : button('Sign in with Microsoft', { action: 'graph-connect', variant: 'primary', size: 'lg' })}
    </div>
  </section>`;
}

// ---------------------------------------------------------------- Up next

function eventMeta(ev, zone, withDate = false) {
  const d = ev.data;
  const minutes = (new Date(d.end) - new Date(d.start)) / 60000;
  const where = d.joinUrl ? `${teamsGlyph}<span>Microsoft Teams${d.location && !/teams/i.test(d.location) ? ` · ${e(d.location)}` : ''}</span>` : d.location ? `${icon('pin')}<span>${e(d.location)}</span>` : '';
  return `<p class="ws-meta"><span>${icon('clock')}<span>${withDate ? `${e(formatDate(d.start, zone, { weekday: 'short', month: 'short', day: 'numeric' }))}, ` : ''}${e(formatTime(d.start, zone))} – ${e(formatTime(d.end, zone))} · ${e(durationLabel(minutes))}</span></span>${where ? `<span>${where}</span>` : ''}</p>`;
}

function people(ev) {
  const d = ev.data;
  const attendees = (d.attendees || []).filter(a => a.type !== 'resource');
  const organizer = d.organizer?.name || d.organizer?.address;
  if (!organizer && !attendees.length) return '';
  const faces = attendees.slice(0, 4).map(a => avatar({ name: a.name || a.address, size: 24, seed: a.address })).join('');
  const label = [d.isOrganizer ? 'You organize' : organizer ? `Organized by ${organizer}` : '', attendees.length ? `${attendees.length} attendee${attendees.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  return `<div class="ws-people">${faces ? `<span class="ws-face-stack">${faces}</span>` : ''}<span>${e(label)}</span></div>`;
}

function eventActions(ev, { compact = false } = {}) {
  const d = ev.data;
  return `<div class="ws-actions">${d.joinUrl ? button('Join', { action: 'join', variant: 'primary', iconName: 'video', attrs: { 'data-id': ev.id } }) : ''}${button(compact ? '' : 'Details', { action: 'event', iconName: compact ? 'external' : undefined, title: 'Event details', attrs: { 'data-id': ev.id } })}</div>`;
}

function upNextCard(s, m, connected) {
  if (!connected) {
    return card({ title: 'Up next', iconName: 'calendar-clock', className: 'ws-upnext', body: emptyState({ iconName: 'calendar', title: 'Your next meeting appears here', text: 'With a countdown and a one-click Join for Teams meetings.' }) });
  }
  const colors = calendarColors(s);
  const live = m.current[0];
  const next = m.upcoming[0];
  const focus = live || next;
  if (!focus) {
    const t = m.tomorrowFirst;
    return card({
      title: 'Up next', iconName: 'calendar-clock', className: 'ws-upnext',
      body: `<div class="ws-upnext-free">${icon('coffee')}<div><h3>${m.timed.length ? "You're done with meetings today" : 'No meetings today'}</h3><p>${t ? `Tomorrow starts with <button type="button" class="ws-link" data-action="event" data-id="${e(t.record.id)}">${e(t.record.data.title || 'an event')}</button> at ${e(formatTime(t.record.data.start, m.zone))}.` : 'Nothing scheduled tomorrow morning either.'}</p></div></div>`,
    });
  }
  const ev = focus.record;
  const d = ev.data;
  const color = colors.get(d.calendarId) || 'var(--ws-accent)';
  const startMs = new Date(d.start).getTime();
  const endMs = new Date(d.end).getTime();
  const progress = live ? Math.min(100, Math.max(0, ((m.nowMs - startMs) / (endMs - startMs)) * 100)) : 0;
  const chip = live
    ? `<span class="ws-live-chip" data-countdown-end="${endMs}">${icon('activity')}<span>Now · ends ${e(countdownLabel(endMs, m.nowMs))}</span></span>`
    : `<span class="ws-soon-chip${startMs - m.nowMs < 15 * 60_000 ? ' ws-soon' : ''}" data-countdown-start="${startMs}">${icon('clock')}<span>Starts ${e(countdownLabel(startMs, m.nowMs))}</span></span>`;
  const later = m.upcoming.filter(t => t.record.id !== ev.id).slice(0, 3);
  return card({
    title: live ? 'Happening now' : 'Up next', iconName: 'calendar-clock', className: 'ws-upnext', actions: chip,
    body: `<div class="ws-upnext-main" style="--event-color:${e(color)}">
      <div class="ws-upnext-time"><strong>${e(formatTime(d.start, m.zone))}</strong><span>${e(formatTime(d.end, m.zone))}</span></div>
      <div class="ws-upnext-info">
        <h3><button type="button" class="ws-link-title" data-action="event" data-id="${e(ev.id)}">${e(d.title || 'Untitled event')}</button></h3>
        ${eventMeta(ev, m.zone)}
        ${people(ev)}
        <div class="ws-actions ws-upnext-actions">
          ${d.joinUrl ? button('Join Teams meeting', { action: 'join', variant: 'primary', iconName: 'video', attrs: { 'data-id': ev.id } }) : ''}
          ${d.url ? button('Open in Outlook', { action: 'source', iconName: 'external', attrs: { 'data-kind': 'event', 'data-id': ev.id } }) : ''}
          ${!live ? button('Remind me', { action: 'event-reminder', iconName: 'bell', variant: 'ghost', attrs: { 'data-id': ev.id } }) : ''}
        </div>
      </div>
    </div>
    ${live ? `<div class="ws-progress" role="progressbar" aria-label="Meeting progress" aria-valuenow="${Math.round(progress)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${progress.toFixed(1)}%"></span></div>` : ''}`,
    footer: later.length ? `<span class="ws-later-label">Later today</span>${later.map(t => `<button type="button" class="ws-later" data-action="event" data-id="${e(t.record.id)}" style="--event-color:${e(colors.get(t.record.data.calendarId) || 'var(--ws-accent)')}"><span>${e(formatTime(t.record.data.start, m.zone))}</span>${e(t.record.data.title || 'Untitled')}</button>`).join('')}` : '',
  });
}

// ---------------------------------------------------------------- Glance

function glanceCard(s, m, connected) {
  const now = Date.now() / 1000;
  const focusUntil = s.settings.focusUntil > now ? s.settings.focusUntil : null;
  const openCommitments = m.commitments.filter(c => ['todo', 'doing', 'waiting'].includes(taskStatus(c))).length;
  const stat = (value, label, iconName, action, attrs = {}) => `<${action ? `button type="button" data-action="${action}"` : 'div'} class="ws-stat" ${Object.entries(attrs).map(([k, v]) => `${k}="${e(v)}"`).join(' ')}><span class="ws-stat-icon">${icon(iconName)}</span><strong>${e(value)}</strong><span>${e(label)}</span></${action ? 'button' : 'div'}>`;
  const stats = connected
    ? [
      stat(`${m.remaining.length}/${m.timed.length}`, 'Meetings left', 'calendar', 'route', { 'data-route': 'calendar' }),
      stat(durationLabel(m.busyMinutes), 'In meetings', 'users'),
      stat(m.nowMin >= WORKDAY_END ? '—' : durationLabel(m.freeMinutes), m.nowMin >= WORKDAY_END ? 'Workday over' : `Until ${formatTime(endOfWorkday(m), m.zone)}`, 'coffee'),
      stat(String(m.attention.length), 'Need reply', 'reply', 'route', { 'data-route': 'inbox', 'data-lane': 'reply' }),
    ]
    : [
      stat(String(openCommitments), 'Open tasks', 'check-circle'),
      stat(String(decisions(s).length), 'Decisions', 'shield'),
    ];
  const focus = focusUntil
    ? `<div class="ws-focus ws-focus-on"><div><strong data-countdown-end="${focusUntil * 1000}">${e(countdownLabel(focusUntil * 1000).replace('in ', ''))}</strong><span>Focus on · ordinary reminders are quiet</span></div>${button('End', { action: 'focus', attrs: { 'data-minutes': '0' } })}</div>`
    : `<div class="ws-focus"><div><strong>Focus session</strong><span>Quiet non-critical reminders</span></div><div class="ws-actions">${button('25 min', { action: 'focus', variant: 'primary', iconName: 'target', attrs: { 'data-minutes': '25' } })}${button('50 min', { action: 'focus', attrs: { 'data-minutes': '50' } })}</div></div>`;
  return card({ title: 'Day at a glance', iconName: 'activity', className: 'ws-glance', body: `<div class="ws-stats">${stats.join('')}</div>${focus}` });
}

// ---------------------------------------------------------------- Schedule

function scheduleCard(s, m, connected) {
  if (!connected) {
    return card({ title: 'Schedule', iconName: 'calendar', className: 'ws-schedule-card', body: emptyState({ iconName: 'calendar', title: 'Your schedule lives here', text: 'Meetings, rooms and free time for today.' }) });
  }
  const colors = calendarColors(s);
  const all = m.timed;
  const allDay = m.today.allDay;
  const firstHour = Math.min(8, ...all.map(t => Math.floor(t.startMin / 60)));
  const lastHour = Math.max(19, ...all.map(t => Math.ceil(t.endMin / 60)));
  const startHour = Math.max(0, Math.min(firstHour, Math.floor(m.nowMin / 60)));
  const endHour = Math.min(24, Math.max(lastHour, Math.ceil(m.nowMin / 60) + 1));
  const hourHeight = 44;
  const top = minute => ((minute - startHour * 60) / 60) * hourHeight;
  const laid = layoutColumns(all, 25);
  const blocks = laid.map(t => {
    const d = t.record.data;
    const height = Math.max(20, top(t.endMin) - top(t.startMin) - 2);
    const past = new Date(d.end).getTime() <= m.nowMs;
    return `<button type="button" class="ws-tl-event${past ? ' ws-past' : ''}${height < 34 ? ' ws-compact' : ''}${d.showAs === 'tentative' || d.response === 'tentativelyAccepted' ? ' ws-tentative' : ''}" data-action="event" data-id="${e(t.record.id)}" style="--event-color:${e(colors.get(d.calendarId) || 'var(--ws-accent)')};top:${top(t.startMin).toFixed(1)}px;height:${height.toFixed(1)}px;left:calc(${(t.col / t.cols) * 100}% + 2px);width:calc(${100 / t.cols}% - 4px)"><strong>${e(d.title || 'Untitled')}</strong><span>${e(formatTime(d.start, m.zone))}${d.joinUrl ? ' · Teams' : d.location ? ` · ${e(d.location)}` : ''}</span></button>`;
  }).join('');
  const gaps = freeSlots(all, Math.max(startHour * 60, WORKDAY_START, m.nowMin), Math.min(endHour * 60, WORKDAY_END), 60, allDay)
    .map(([a, b]) => `<div class="ws-tl-free" style="top:${top(a).toFixed(1)}px;height:${(top(b) - top(a)).toFixed(1)}px"><span>Free · ${e(durationLabel(b - a))}</span></div>`).join('');
  const hours = Array.from({ length: endHour - startHour }, (_, i) => `<div class="ws-tl-hour" style="top:${i * hourHeight}px"><span>${e(hourLabel(startHour + i))}</span></div>`).join('');
  const nowLine = m.nowMin >= startHour * 60 && m.nowMin <= endHour * 60 ? `<div class="ws-now-line" data-now-line data-start-hour="${startHour}" data-hour-height="${hourHeight}" style="top:${top(m.nowMin).toFixed(1)}px"><span></span></div>` : '';
  const body = all.length || allDay.length
    ? `${allDay.length ? `<div class="ws-tl-allday">${allDay.map(r => `<button type="button" class="ws-chip-event" data-action="event" data-id="${e(r.id)}" style="--event-color:${e(colors.get(r.data.calendarId) || 'var(--ws-accent)')}">${e(r.data.title || 'All-day event')}</button>`).join('')}</div>` : ''}
      <div class="ws-timeline" data-scroll-now style="height:${(endHour - startHour) * hourHeight}px">${hours}<div class="ws-tl-lane">${gaps}${blocks}${nowLine}</div></div>`
    : emptyState({ iconName: 'coffee', title: 'A clear day', text: 'No meetings on your calendars today.' });
  return card({
    title: 'Schedule', iconName: 'calendar', className: 'ws-schedule-card',
    actions: button('Calendar', { action: 'route', variant: 'ghost', iconRight: 'arrow', attrs: { 'data-route': 'calendar' } }),
    body: `<div class="ws-schedule-scroll" data-scroll-to="${Math.max(0, top(Math.max(startHour * 60, m.nowMin - 60))).toFixed(0)}">${body}</div>`,
  });
}

// ---------------------------------------------------------------- Attention

function messageRow(s, msg, zone, canDraft) {
  const d = msg.data;
  const glyph = d.channel === 'chat' ? teamsGlyph : outlookGlyph;
  // Own Outlook messages cannot be answered through Review & send, so they get no draft.
  const draft = canDraft && (d.channel === 'chat' || !d.isMine)
    ? `<button type="button" class="ws-row-action" data-action="draft-reply" data-id="${e(msg.id)}" data-key="${e(draftKeyOf(msg))}" aria-label="Draft reply to ${e(d.from || 'this message')}" title="Draft a reply with Claude">${icon('spark')}<span>Draft reply</span></button>`
    : '';
  return `<div class="ws-msg-item${draft ? ' ws-has-action' : ''}"><button type="button" class="ws-msg-row" data-action="open-message" data-id="${e(msg.id)}">
    <span class="ws-msg-avatar">${avatar({ name: d.from || '?', size: 32, seed: d.fromAddress || d.fromId || d.from })}<span class="ws-msg-glyph">${glyph}</span></span>
    <span class="ws-msg-main"><span class="ws-msg-top"><strong>${e(d.from || 'Unknown sender')}</strong><time>${e(relativeAge(d.at, zone))}</time></span>
    <span class="ws-msg-title">${d.lane === 'critical' ? badge('Critical', 'error') : ''}<span class="ws-ellipsis">${e(listTitle(msg, s))}</span></span>
    <span class="ws-msg-preview">${e(d.text || '')}</span></span>
  </button>${draft}</div>`;
}

/** 1:1 Teams chats are titled with the other person, so show the channel instead of a repeat. */
export function listTitle(msg, s) {
  const title = messageTitle(msg, s);
  if (msg.data.channel === 'chat' && title === msg.data.from) return 'Teams · direct message';
  return title;
}

function attentionCard(s, m, connected, ai) {
  if (!connected) {
    return card({ title: 'Needs your reply', iconName: 'reply', className: 'ws-attention', body: emptyState({ iconName: 'inbox', title: 'Replies you owe, in one list', text: 'Direct questions from Outlook and Teams, with the newest first.' }) });
  }
  const items = m.attention.slice(0, 6);
  const canDraft = claudeAvailable(ai);
  return card({
    title: 'Needs your reply', iconName: 'reply', className: 'ws-attention',
    actions: button(m.attention.length ? `Inbox · ${m.attention.length}` : 'Inbox', { action: 'route', variant: 'ghost', iconRight: 'arrow', attrs: { 'data-route': 'inbox', 'data-lane': 'reply' } }),
    body: items.length ? `<div class="ws-msg-list">${items.map(msg => messageRow(s, msg, m.zone, canDraft)).join('')}</div>` : emptyState({ iconName: 'check-circle', title: "You're all caught up", text: 'Nothing in Outlook or Teams is waiting for your reply.' }),
  });
}

// ---------------------------------------------------------------- Tasks & notes

function commitmentsCard(s, m, w) {
  const me = meOf(s);
  // Today lists what is on the board to do; To review and dismissed ones stay on the Tasks page.
  const open = m.commitments.filter(c => ['todo', 'doing', 'waiting'].includes(taskStatus(c))).sort((a, b) => sortTasks(a, b, m.nowMs, m.zone));
  const done = m.commitments.filter(c => taskStatus(c) === 'done').sort((a, b) => (b.data.doneAt || b.updatedAt) - (a.data.doneAt || a.updatedAt)).slice(0, 5);
  const review = m.commitments.filter(c => taskStatus(c) === 'review').length;
  const note = records(s, 'note')[0];
  const row = c => {
    const isDone = taskStatus(c) === 'done';
    const owner = isMine(c, me) ? '' : ownerOf(c, me).name;
    const due = c.data.due ? `${icon('calendar')}${e(formatDate(`${c.data.due}T12:00:00`, undefined, { month: 'short', day: 'numeric' }))}` : '';
    return `<div class="ws-todo${isDone ? ' ws-done' : ''}">
    <label class="ws-check"><input type="checkbox" data-action="commitment-toggle" data-id="${e(c.id)}" ${isDone ? 'checked' : ''} aria-label="Mark “${e(c.data.text)}” ${isDone ? 'open' : 'done'}"><span class="ws-check-box" aria-hidden="true">${icon('check')}</span></label>
    <div class="ws-todo-text"><button type="button" class="ws-link-title" data-action="task-open-today" data-id="${e(c.id)}">${e(c.data.text)}</button>${due || owner ? `<small>${due}${due && owner ? ' · ' : ''}${e(owner)}</small>` : ''}</div>
    ${button('', { action: 'task-delete', iconName: 'trash', variant: 'ghost', title: 'Delete task', attrs: { 'data-id': c.id } })}
  </div>`;
  };
  return card({
    title: 'Tasks', iconName: 'tasks', className: 'ws-commitments',
    actions: button('Board', { action: 'route', variant: 'ghost', iconRight: 'arrow', attrs: { 'data-route': 'tasks' } }),
    body: `<div class="ws-two-col">
      <div class="ws-todo-col">
        <form class="ws-quick-add" data-form="commitment-add">
          <input class="ws-input" name="text" maxlength="2000" placeholder="Add a task… e.g. Send the roadmap to Anna" aria-label="New task" autocomplete="off">
          <input class="ws-input ws-date" name="due" type="date" aria-label="Due date">
          ${button('Add', { type: 'submit', variant: 'primary', iconName: 'plus' })}
        </form>
        ${review ? `<button type="button" class="ws-today-review" data-action="route" data-route="tasks">${icon('sparkles')}<span><strong>${review} ${review === 1 ? 'task' : 'tasks'} from meeting notes to review</strong><small>Check owners and dates, then accept</small></span>${icon('chevron-right')}</button>` : ''}
        <div class="ws-todo-list">${open.map(row).join('') || '<p class="ws-muted ws-hint">No open tasks. Add one above or from any Inbox message.</p>'}</div>
        ${done.length ? `<details class="ws-done-list"><summary>Completed · ${done.length}</summary>${done.map(row).join('')}</details>` : ''}
      </div>
      <div class="ws-note-col">
        <div class="ws-note-head"><span class="ws-field-label">${icon('note')}Notes</span><span class="ws-note-state" id="note-state">${note ? `Saved ${e(relativeAge(note.updatedAt, m.zone))}` : 'Stored on this device'}</span></div>
        <textarea id="today-note" class="ws-textarea ws-notes" data-workspace-id="${e(w.id)}" data-record-id="${e(note?.id || '')}" placeholder="A thought, a plan, something to remember…" aria-label="Workspace notes">${e(note?.data.text || '')}</textarea>
      </div>
    </div>`,
  });
}
