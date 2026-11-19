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
import { GRID, autoCards, optionsOf, todayOf } from './today-grid.js';

const toggle = (key, label, def) => ({ key, type: 'toggle', label, def });
const choice = (key, label, choices, def) => ({ key, type: 'select', label, choices, def });
const checks = (key, label, choices, def) => ({ key, type: 'checks', label, choices, def });

/** Today's widgets: default size `width` × `h` in grid columns and rows, the smallest size, and the
 *  options each one offers (the saved value of `key`, or `def`). */
export const WIDGETS = {
  brief: {
    title: 'Up next', width: 8, h: 4, minW: 3, minH: 2, description: 'Your current or next meeting with a one-click join.',
    options: [toggle('later', 'Show “Later today”', true), toggle('people', 'Show who is invited', true)],
  },
  focus: {
    title: 'Day at a glance', width: 4, h: 4, minW: 2, minH: 2, description: 'Meetings, free time, replies and a focus timer.',
    options: [
      checks('stats', 'Numbers', [['left', 'Meetings left'], ['busy', 'In meetings'], ['free', 'Free time'], ['reply', 'Need reply'], ['tasks', 'Open tasks']], ['left', 'busy', 'free', 'reply']),
      toggle('focus', 'Focus session buttons', true),
    ],
  },
  calendar: {
    title: 'Schedule', width: 6, h: 7, minW: 2, minH: 3, description: "Today's timeline with free time between meetings.",
    options: [toggle('free', 'Show free time', true), choice('start', 'Day starts at', [['7', '07:00'], ['8', '08:00'], ['9', '09:00']], '8')],
  },
  inbox: {
    title: 'Needs your reply', width: 6, h: 7, minW: 2, minH: 3, description: 'Outlook and Teams messages waiting for you.',
    options: [choice('max', 'Messages shown', [['3', '3'], ['6', '6'], ['10', '10']], '6'), checks('sources', 'Sources', [['mail', 'Outlook'], ['chat', 'Teams']], ['mail', 'chat'])],
  },
  commitments: {
    title: 'Tasks', width: 8, h: 6, minW: 3, minH: 3, description: 'Your open tasks with a quick-add box.',
    options: [toggle('add', 'Quick add box', true), toggle('mine', 'Only my tasks', false), toggle('done', 'Show completed', true)],
  },
  notes: {
    title: 'Notes', width: 4, h: 6, minW: 2, minH: 2, description: 'A scratchpad for thoughts, plans and things to remember.',
    options: [choice('size', 'Text size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], 'small')],
  },
  meetings: {
    title: 'From your meetings', width: 6, h: 5, minW: 3, minH: 2, description: 'Meetings that need you and transcripts waiting for notes.',
    options: [toggle('needsMe', 'Only meetings that need me', false)],
  },
  automations: {
    title: 'Automation results', width: 6, h: 5, minW: 3, minH: 2, description: 'The latest result of each automation, with its sources.',
    options: [toggle('failures', 'Only failures', false)],
  },
  timer: {
    title: 'Focus timer', width: 4, h: 3, minW: 2, minH: 2, description: 'A focus session that quiets non-critical reminders.',
    options: [choice('minutes', 'Default length', [['25', '25 min'], ['50', '50 min']], '25')],
  },
  [PLUGINS_CARD]: { title: 'From plugins', width: 12, h: 3, minW: 4, minH: 2, description: 'Decisions, deliveries and held messages your plugins prepare.', options: [] },
};
export const WIDGET_IDS = Object.keys(WIDGETS);

/** What the grid knows of each widget, by id: Today's own and the ones the enabled plugins declare
 *  (`pluginCatalog`, from `pluginWidgetCatalog`), as {id, title, description, w, h, minW, minH,
 *  options, plugin?}. A plugin widget is its plugin's width × 4 rows, and at least 2 × 2. */
export function tileDefs(pluginCatalog = []) {
  const defs = {};
  for (const id of WIDGET_IDS) {
    const { width, ...def } = WIDGETS[id];
    defs[id] = { id, ...def, w: width };
  }
  for (const p of pluginCatalog) {
    defs[p.id] = { id: p.id, title: p.title, description: p.description, w: p.width, h: 4, minW: 2, minH: 2, options: [], plugin: p.plugin };
  }
  return defs;
}

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
  const catalog = ctx.plugins?.catalog || [];
  const defs = tileDefs(catalog);
  const t = todayOf(w, defs);
  const widgets = {
    brief: o => upNextCard(s, m, connected, o),
    focus: o => glanceCard(s, m, connected, o),
    calendar: o => scheduleCard(s, m, connected, o),
    inbox: o => attentionCard(s, m, connected, ctx.state?.ai, o),
    commitments: o => commitmentsCard(s, m, o),
    notes: o => notesCard(s, m, w, o),
    meetings: o => todayMeetingsCard(s, m.nowMs, { needsMe: o.needsMe }),
    automations: o => automationResultsCard(s, ctx.state?.ai, { failuresOnly: o.failures }),
    timer: o => timerCard(s, o),
    [PLUGINS_CARD]: () => pluginsCard(s, { zone: m.zone, routeOf: ctx.plugins?.routeOf }),
  };
  const draw = id => (Object.hasOwn(widgets, id)
    ? widgets[id](optionsOf(t, id, defs[id]))
    : pluginWidgetCard(s, id, { catalog, drawn: ctx.plugins?.drawn, zone: m.zone }));
  // A plugin widget counts as there until the plugin catalog is known; after that, only while its
  // plugin is on. One that isn't there is not drawn but keeps its place in the saved grid.
  const there = id => Object.hasOwn(widgets, id) || (!!parseLayoutId(id) && (!ctx.pluginsKnown || Object.hasOwn(defs, id)));
  const placed = t.items.filter(it => there(it.id));
  let rows = placed.reduce((bottom, it) => Math.max(bottom, it.y + it.h), 0);
  // Cards the grid doesn't place show themselves below it, full width: "From your meetings" while
  // a meeting waits, "From plugins" while a plugin has something, and ids native put in `layout`.
  const wanted = [showMeetingsCard(w, s, m.nowMs) && 'meetings', showPluginsCard(w, s) && PLUGINS_CARD].filter(Boolean);
  const below = autoCards(w, t, wanted).filter(there).map(id => {
    const it = { id, x: 0, y: rows, w: GRID.cols, h: defs[id]?.h || 4 };
    rows += it.h;
    return it;
  });
  const tiles = [...placed, ...below].sort((a, b) => a.y - b.y || a.x - b.x)
    .map((it, order) => tile(draw(it.id), it, order, t.titles[it.id])).join('');
  return `<div class="ws-today ws-today-page">
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
    ${tiles ? `<div class="ws-tiles" data-today-grid style="--rows:${rows}">${tiles}</div>` : emptyState({ iconName: 'today', title: 'Make Today your own', text: 'Choose the cards you want on Today.', actions: button('Choose cards', { action: 'today-customize', variant: 'primary' }) })}
  </div>`;
}

const CARD_TITLE = /<h2 class="ws-card-title">([^]*?)<\/h2>/;
const HANDLES = [['r', 'Drag to change the width'], ['b', 'Drag to change the height'], ['c', 'Drag to resize']]
  .map(([edge, title]) => `<span class="ws-rz" data-edge="${edge}" title="${title}" aria-hidden="true"></span>`).join('');
const tool = (action, iconName, title, label, id, extra = '') => `<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon" data-action="${action}" data-id="${e(id)}" title="${title}" aria-label="${label}"${extra}>${icon(iconName)}</button>`;

/**
 * A widget's card as a grid tile placed at `it`. Cards come from `card()`, whose markup is fixed:
 * the tile keeps the card's classes and attributes, its header gets the grip and the widget
 * buttons, its body becomes the part that scrolls and the resize handles go last. `title` is the
 * name the user gave the widget, shown instead of the card's own.
 */
function tile(html, it, order, title) {
  let name = '';
  const named = html.replace(CARD_TITLE, (_, inner) => {
    const text = inner.lastIndexOf('>') + 1;
    name = title ? e(title) : inner.slice(text);
    return `<h2 class="ws-card-title">${inner.slice(0, text)}${name}</h2>`;
  });
  const open = named.indexOf('>');
  const place = `--x:${e(it.x)};--y:${e(it.y)};--w:${e(it.w)};--h:${e(it.h)};--order:${order}`;
  const grip = `<button type="button" class="ws-tile-grip" aria-label="Move ${name}. Arrow keys move it, Shift and arrow keys resize it." title="Drag to move">${icon('grip')}</button>`;
  const tools = `<div class="ws-tile-tools">${tool('today-options', 'sliders', 'Customize this widget', `Customize ${name}`, it.id)}${tool('today-menu', 'dots', 'More', `More for ${name}`, it.id, ' aria-haspopup="menu"')}</div>`;
  return `${named.slice(0, open).replace('class="ws-card', () => `class="ws-card ws-tile${it.collapsed ? ' ws-tile-collapsed' : ''}`)} data-tile="${e(it.id)}" style="${place}"${named.slice(open)}`
    .replace('<header class="ws-card-header">', () => `<header class="ws-card-header ws-tile-head">${grip}`)
    .replace('<div class="ws-card-actions">', '<div class="ws-card-actions ws-tile-extra">')
    .replace('</header>', () => `${tools}</header>`)
    .replace('<div class="ws-card-body">', '<div class="ws-card-body ws-tile-body">')
    .replace(/<\/section>$/, () => `${HANDLES}</section>`);
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

function upNextCard(s, m, connected, o) {
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
        ${o.people ? people(ev) : ''}
        <div class="ws-actions ws-upnext-actions">
          ${d.joinUrl ? button('Join Teams meeting', { action: 'join', variant: 'primary', iconName: 'video', attrs: { 'data-id': ev.id } }) : ''}
          ${d.url ? button('Open in Outlook', { action: 'source', iconName: 'external', attrs: { 'data-kind': 'event', 'data-id': ev.id } }) : ''}
          ${!live ? button('Remind me', { action: 'event-reminder', iconName: 'bell', variant: 'ghost', attrs: { 'data-id': ev.id } }) : ''}
        </div>
      </div>
    </div>
    ${live ? `<div class="ws-progress" role="progressbar" aria-label="Meeting progress" aria-valuenow="${Math.round(progress)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${progress.toFixed(1)}%"></span></div>` : ''}`,
    footer: o.later && later.length ? `<span class="ws-later-label">Later today</span>${later.map(t => `<button type="button" class="ws-later" data-action="event" data-id="${e(t.record.id)}" style="--event-color:${e(colors.get(t.record.data.calendarId) || 'var(--ws-accent)')}"><span>${e(formatTime(t.record.data.start, m.zone))}</span>${e(t.record.data.title || 'Untitled')}</button>`).join('')}` : '',
  });
}

// ---------------------------------------------------------------- Glance

function glanceCard(s, m, connected, o) {
  const now = Date.now() / 1000;
  const focusUntil = s.settings.focusUntil > now ? s.settings.focusUntil : null;
  const openCommitments = m.commitments.filter(c => ['todo', 'doing', 'waiting'].includes(taskStatus(c))).length;
  const stat = (value, label, iconName, action, attrs = {}) => `<${action ? `button type="button" data-action="${action}"` : 'div'} class="ws-stat" ${Object.entries(attrs).map(([k, v]) => `${k}="${e(v)}"`).join(' ')}><span class="ws-stat-icon">${icon(iconName)}</span><strong>${e(value)}</strong><span>${e(label)}</span></${action ? 'button' : 'div'}>`;
  // The numbers the widget's options choose, always in this order.
  const numbers = {
    left: () => stat(`${m.remaining.length}/${m.timed.length}`, 'Meetings left', 'calendar', 'route', { 'data-route': 'calendar' }),
    busy: () => stat(durationLabel(m.busyMinutes), 'In meetings', 'users'),
    free: () => stat(m.nowMin >= WORKDAY_END ? '—' : durationLabel(m.freeMinutes), m.nowMin >= WORKDAY_END ? 'Workday over' : `Until ${formatTime(endOfWorkday(m), m.zone)}`, 'coffee'),
    reply: () => stat(String(m.attention.length), 'Need reply', 'reply', 'route', { 'data-route': 'inbox', 'data-lane': 'reply' }),
    tasks: () => stat(String(openCommitments), 'Open tasks', 'check-circle'),
  };
  const stats = connected
    ? Object.keys(numbers).filter(k => o.stats.includes(k)).map(k => numbers[k]())
    : [
      stat(String(openCommitments), 'Open tasks', 'check-circle'),
      stat(String(decisions(s).length), 'Decisions', 'shield'),
    ];
  const focus = !o.focus ? '' : focusUntil
    ? `<div class="ws-focus ws-focus-on"><div><strong data-countdown-end="${focusUntil * 1000}">${e(countdownLabel(focusUntil * 1000).replace('in ', ''))}</strong><span>Focus on · ordinary reminders are quiet</span></div>${button('End', { action: 'focus', attrs: { 'data-minutes': '0' } })}</div>`
    : `<div class="ws-focus"><div><strong>Focus session</strong><span>Quiet non-critical reminders</span></div><div class="ws-actions">${button('25 min', { action: 'focus', variant: 'primary', iconName: 'target', attrs: { 'data-minutes': '25' } })}${button('50 min', { action: 'focus', attrs: { 'data-minutes': '50' } })}</div></div>`;
  return card({ title: 'Day at a glance', iconName: 'activity', className: 'ws-glance', body: `${stats.length ? `<div class="ws-stats">${stats.join('')}</div>` : ''}${focus}` });
}

// ---------------------------------------------------------------- Focus timer

function timerCard(s, o) {
  const now = Date.now() / 1000;
  const focusUntil = s.settings.focusUntil > now ? s.settings.focusUntil : null;
  const body = focusUntil
    ? `<div class="ws-timer ws-timer-on"><strong data-countdown-end="${focusUntil * 1000}">${e(countdownLabel(focusUntil * 1000).replace('in ', ''))}</strong><span>Focus on · ordinary reminders are quiet</span>${button('End session', { action: 'focus', attrs: { 'data-minutes': '0' } })}</div>`
    : `<div class="ws-timer"><strong>${e(o.minutes)}:00</strong><span>Quiet non-critical reminders</span>${button('Start', { action: 'focus', variant: 'primary', iconName: 'target', attrs: { 'data-minutes': o.minutes } })}</div>`;
  return card({ title: 'Focus timer', iconName: 'target', className: 'ws-timer-card', body });
}

// ---------------------------------------------------------------- Schedule

function scheduleCard(s, m, connected, o) {
  if (!connected) {
    return card({ title: 'Schedule', iconName: 'calendar', className: 'ws-schedule-card', body: emptyState({ iconName: 'calendar', title: 'Your schedule lives here', text: 'Meetings, rooms and free time for today.' }) });
  }
  const colors = calendarColors(s);
  const all = m.timed;
  const allDay = m.today.allDay;
  const firstHour = Math.min(Number(o.start), ...all.map(t => Math.floor(t.startMin / 60)));
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
  const gaps = !o.free ? '' : freeSlots(all, Math.max(startHour * 60, WORKDAY_START, m.nowMin), Math.min(endHour * 60, WORKDAY_END), 60, allDay)
    .map(([a, b]) => `<div class="ws-tl-free" style="top:${top(a).toFixed(1)}px;height:${(top(b) - top(a)).toFixed(1)}px"><span>Free · ${e(durationLabel(b - a))}</span></div>`).join('');
  // What a narrow Schedule shows instead of the timeline (the CSS picks one by the tile's width).
  const agenda = all.map(t => {
    const d = t.record.data;
    const past = new Date(d.end).getTime() <= m.nowMs;
    return `<button type="button" class="ws-tl-agenda-item${past ? ' ws-past' : ''}" data-action="event" data-id="${e(t.record.id)}" style="--event-color:${e(colors.get(d.calendarId) || 'var(--ws-accent)')}"><b>${e(formatTime(d.start, m.zone))}</b><span>${e(d.title || 'Untitled')}</span></button>`;
  }).join('');
  const hours = Array.from({ length: endHour - startHour }, (_, i) => `<div class="ws-tl-hour" style="top:${i * hourHeight}px"><span>${e(hourLabel(startHour + i))}</span></div>`).join('');
  const nowLine = m.nowMin >= startHour * 60 && m.nowMin <= endHour * 60 ? `<div class="ws-now-line" data-now-line data-start-hour="${startHour}" data-hour-height="${hourHeight}" style="top:${top(m.nowMin).toFixed(1)}px"><span></span></div>` : '';
  const body = all.length || allDay.length
    ? `${allDay.length ? `<div class="ws-tl-allday">${allDay.map(r => `<button type="button" class="ws-chip-event" data-action="event" data-id="${e(r.id)}" style="--event-color:${e(colors.get(r.data.calendarId) || 'var(--ws-accent)')}">${e(r.data.title || 'All-day event')}</button>`).join('')}</div>` : ''}
      <div class="ws-timeline" data-scroll-now style="height:${(endHour - startHour) * hourHeight}px">${hours}<div class="ws-tl-lane">${gaps}${blocks}${nowLine}</div></div>${agenda ? `<div class="ws-tl-agenda">${agenda}</div>` : ''}`
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

function attentionCard(s, m, connected, ai, o) {
  if (!connected) {
    return card({ title: 'Needs your reply', iconName: 'reply', className: 'ws-attention', body: emptyState({ iconName: 'inbox', title: 'Replies you owe, in one list', text: 'Direct questions from Outlook and Teams, with the newest first.' }) });
  }
  const items = m.attention.filter(msg => o.sources.includes(msg.data.channel === 'chat' ? 'chat' : 'mail')).slice(0, Number(o.max));
  const canDraft = claudeAvailable(ai);
  return card({
    title: 'Needs your reply', iconName: 'reply', className: 'ws-attention',
    actions: button(m.attention.length ? `Inbox · ${m.attention.length}` : 'Inbox', { action: 'route', variant: 'ghost', iconRight: 'arrow', attrs: { 'data-route': 'inbox', 'data-lane': 'reply' } }),
    body: items.length ? `<div class="ws-msg-list">${items.map(msg => messageRow(s, msg, m.zone, canDraft)).join('')}</div>` : emptyState({ iconName: 'check-circle', title: "You're all caught up", text: 'Nothing in Outlook or Teams is waiting for your reply.' }),
  });
}

// ---------------------------------------------------------------- Tasks

function commitmentsCard(s, m, o) {
  const me = meOf(s);
  const shown = c => !o.mine || isMine(c, me);
  // Today lists what is on the board to do; To review and dismissed ones stay on the Tasks page.
  const open = m.commitments.filter(c => ['todo', 'doing', 'waiting'].includes(taskStatus(c)) && shown(c)).sort((a, b) => sortTasks(a, b, m.nowMs, m.zone));
  const done = !o.done ? [] : m.commitments.filter(c => taskStatus(c) === 'done' && shown(c)).sort((a, b) => (b.data.doneAt || b.updatedAt) - (a.data.doneAt || a.updatedAt)).slice(0, 5);
  const review = m.commitments.filter(c => taskStatus(c) === 'review').length;
  const row = c => {
    const isDone = taskStatus(c) === 'done';
    const owner = isMine(c, me) ? '' : ownerOf(c, me).name;
    const due = c.data.due ? `${icon('calendar')}${e(formatDate(`${c.data.due}T12:00:00`, undefined, { month: 'short', day: 'numeric' }))}` : '';
    return `<div class="ws-todo${isDone ? ' ws-done' : ''}">
    <label class="ws-check"><input type="checkbox" data-action="commitment-toggle" data-id="${e(c.id)}" ${isDone ? 'checked' : ''} aria-label="Mark “${e(c.data.text)}” ${isDone ? 'open' : 'done'}"><span class="ws-check-box" aria-hidden="true">${icon('check')}</span></label>
    <div class="ws-todo-text"><button type="button" class="ws-link-title" data-action="task-open-today" data-id="${e(c.id)}">${e(c.data.text)}</button>${due || owner ? `<small>${due}${owner ? `<span class="ws-todo-owner">${due ? ' · ' : ''}${e(owner)}</span>` : ''}</small>` : ''}</div>
    ${button('', { action: 'task-delete', iconName: 'trash', variant: 'ghost', title: 'Delete task', attrs: { 'data-id': c.id } })}
  </div>`;
  };
  return card({
    title: 'Tasks', iconName: 'tasks', className: 'ws-commitments',
    actions: button('Board', { action: 'route', variant: 'ghost', iconRight: 'arrow', attrs: { 'data-route': 'tasks' } }),
    body: `${o.add ? `<form class="ws-quick-add" data-form="commitment-add">
        <input class="ws-input" name="text" maxlength="2000" placeholder="Add a task… e.g. Send the roadmap to Anna" aria-label="New task" autocomplete="off">
        <input class="ws-input ws-date" name="due" type="date" aria-label="Due date">
        ${button('Add', { type: 'submit', variant: 'primary', iconName: 'plus' })}
      </form>` : ''}
      ${review ? `<button type="button" class="ws-today-review" data-action="route" data-route="tasks">${icon('sparkles')}<span><strong>${review} ${review === 1 ? 'task' : 'tasks'} from meeting notes to review</strong><small>Check owners and dates, then accept</small></span>${icon('chevron-right')}</button>` : ''}
      <div class="ws-todo-list">${open.map(row).join('') || `<p class="ws-muted ws-hint">${o.add ? 'No open tasks. Add one above or from any Inbox message.' : 'No open tasks.'}</p>`}</div>
      ${done.length ? `<details class="ws-done-list"><summary>Completed · ${done.length}</summary>${done.map(row).join('')}</details>` : ''}`,
  });
}

// ---------------------------------------------------------------- Notes

// The textarea keeps the id `today-note`: app.js autosaves it and keeps typed text through a render.
function notesCard(s, m, w, o) {
  const note = records(s, 'note')[0];
  return card({
    title: 'Notes', iconName: 'note', className: 'ws-notes-card',
    actions: `<span class="ws-note-state" id="note-state">${note ? `Saved ${e(relativeAge(note.updatedAt, m.zone))}` : 'Stored on this device'}</span>`,
    body: `<textarea id="today-note" class="ws-textarea ws-notes ws-notes-${e(o.size)}" data-workspace-id="${e(w.id)}" data-record-id="${e(note?.id || '')}" placeholder="A thought, a plan, something to remember…" aria-label="Workspace notes">${e(note?.data.text || '')}</textarea>`,
  });
}
