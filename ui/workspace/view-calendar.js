// Calendar: Outlook-grade day/week time grid, month grid and agenda, all in the workspace zone.
import { escapeHtml as e } from './store.js';
import { icon, teamsGlyph } from './icons.js';
import { button, segmented, emptyState, avatar, badge, toggle } from './ui.js';
import {
  calendarDays, calendarWindow, calendarCoverage, calendarCatalog, calendarColor, calendarIds,
  eventsOnDay, layoutColumns, visibleEvents, eventSpan,
} from './calendar-model.js';
import { connectionState, can } from './selectors.js';
import { dayKey, localDayKey, formatDate, formatTime, durationLabel, hourLabel, zonedParts, dateFromKey } from './format.js';
import { LEGEND } from './meetings-model.js';
import { calendarMeetings, meetingCard, tBadge } from './view-meetings.js';

export const HOUR_HEIGHT = 48;
export const MODES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['agenda', 'Agenda']];

export function periodTitle(date, mode) {
  const days = calendarDays(date, mode);
  const first = days[0];
  const last = days.at(-1);
  if (mode === 'day') return first.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (mode === 'month') return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (mode === 'agenda') return `${first.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${last.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const sameMonth = first.getMonth() === last.getMonth();
  const start = first.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const end = last.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${start} – ${end}, ${last.getFullYear()}`;
}

export function calendar(s, ctx) {
  const { state, auth, hidden, banners } = ctx;
  const zone = s.settings.timeZone;
  const conn = connectionState(s, auth);
  const catalog = calendarCatalog(s);
  const synced = new Set(calendarIds(s));
  const colors = new Map(catalog.map((c, i) => [c.id, calendarColor(c, i)]));
  const mode = state.calendarMode;
  const days = calendarDays(state.calendarDate, mode);
  const window = calendarWindow(state.calendarDate, mode);
  const covered = calendarCoverage(s, window);
  const loadingJob = s.jobs.find(j => (j.kind === 'calendar_window' || j.kind === 'sync') && ['queued', 'running'].includes(j.state));
  const events = visibleEvents(s, hidden);
  const todayKey = dayKey(Date.now(), zone);
  const mtg = meetingsOnCalendar(s, state, days, zone);

  let content;
  if (conn === 'none' || conn === 'authorizing' || conn === 'needs_login') {
    content = `<div class="ws-cal-empty">${emptyState({
      iconName: 'calendar',
      title: conn === 'needs_login' ? 'Sign in again to refresh your calendar' : 'Connect your calendar',
      text: conn === 'needs_login' ? 'Microsoft asked Connect to sign in again. Your calendar comes back as soon as you do.' : 'Sign in with Microsoft 365 and every calendar you have appears here automatically.',
      actions: conn === 'authorizing' ? button('Waiting for browser…', { disabled: true, iconName: 'refresh' }) : button(conn === 'needs_login' ? 'Sign in again' : 'Sign in with Microsoft', { action: 'graph-connect', variant: 'primary' }),
    })}</div>`;
    if (conn === 'needs_login' && events.length) content = '';
  }
  if (content === undefined || content === '') {
    const view = mode === 'month' ? monthView(days, events, zone, todayKey, colors, state, mtg)
      : mode === 'agenda' ? agendaView(days, events, zone, todayKey, colors, covered, mtg)
        : timeGrid(days, events, zone, todayKey, colors, mtg);
    content = (content || '') + view;
  }

  const status = !covered && loadingJob ? `<span class="ws-cal-status">${icon('refresh', 'ws-spin')}Loading…</span>`
    : !covered && conn === 'connected' && synced.size ? `<span class="ws-cal-status">${button('Load this period', { action: 'calendar-refresh', variant: 'ghost', iconName: 'refresh' })}</span>` : '';

  return `<div class="ws-calendar-page${state.calendarSidebar === false ? ' ws-cal-collapsed' : ''}">
    <aside class="ws-cal-side" aria-label="Calendar navigation">
      ${miniMonth(state.calendarDate, mode === 'month' ? [] : days, events, zone, todayKey)}
      ${legendPanel(mtg, mode)}
      <div class="ws-cal-list">
        <div class="ws-cal-list-head"><span class="ws-field-label">My calendars</span>${catalog.length ? `<span class="ws-muted">${catalog.length}</span>` : ''}</div>
        ${catalog.length ? catalog.map(cal => `<label class="ws-cal-toggle" style="--event-color:${e(colors.get(cal.id))}"><input type="checkbox" data-action="calendar-visibility" data-id="${e(cal.id)}" ${hidden.has(cal.id) ? '' : 'checked'}><span class="ws-cal-swatch" aria-hidden="true">${icon('check')}</span><span class="ws-cal-name">${e(cal.name || 'Calendar')}</span>${cal.isDefaultCalendar ? '<small>Default</small>' : ''}</label>`).join('')
    : `<p class="ws-muted ws-hint">${conn === 'connected' ? 'Discovering your calendars…' : 'Calendars appear after you sign in.'}</p>`}
      </div>
    </aside>
    <section class="ws-cal-main">
      <header class="ws-cal-toolbar">
        <div class="ws-cal-nav">
          ${button('', { action: 'calendar-sidebar', iconName: 'list', variant: 'ghost', title: 'Toggle calendar list' })}
          ${button('Today', { action: 'calendar-today' })}
          ${button('', { action: 'calendar-prev', iconName: 'chevron-left', variant: 'ghost', title: 'Previous period' })}
          ${button('', { action: 'calendar-next', iconName: 'chevron-right', variant: 'ghost', title: 'Next period' })}
          <h1 class="ws-cal-title">${e(periodTitle(state.calendarDate, mode))}</h1>
          ${status}
        </div>
        <div class="ws-cal-tools">
          ${segmented(MODES, mode, 'calendar-mode', 'mode', 'Calendar view')}
          ${can(s, 'calendar_write') ? button('New event', { action: 'new-event', variant: 'primary', iconName: 'plus' }) : ''}
        </div>
      </header>
      ${banners}
      <div class="ws-cal-view ws-cal-${mode}">${content}</div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------- transcripts on the calendar

/** The calendar's meetings with their transcript badges, the switch that shows only meetings
 *  with transcripts (`state.calendarTranscripts`, the legend groups turned off in
 *  `state.calendarLegend`), and how many of each group the shown days hold. */
function meetingsOnCalendar(s, state, days, zone) {
  const items = calendarMeetings(s);
  const only = !!state.calendarTranscripts;
  const off = state.calendarLegend || {};
  const keys = new Set(days.map(localDayKey));
  const counts = Object.fromEntries(LEGEND.map(([id]) => [id, 0]));
  for (const m of items.values()) if (m.legend && keys.has(dayKey(m.start, zone))) counts[m.legend]++;
  const shown = id => {
    if (!only) return true;
    const m = items.get(id);
    return !!m?.legend && off[m.legend] !== true;
  };
  return { s, items, only, off, counts, shown, badge: (id, opts) => tBadge(s, items.get(id), opts) };
}

function legendPanel(mtg, mode) {
  const scope = { day: 'this day', week: 'this week', month: 'this month', agenda: 'these two weeks' }[mode] || 'this view';
  const rows = LEGEND.map(([id, label, ico]) => `<label class="ws-mtg-legend-row${mtg.only && mtg.off[id] ? ' ws-mtg-off' : ''}">${mtg.only ? `<input type="checkbox" data-action="calendar-legend" data-key="${id}"${mtg.off[id] ? '' : ' checked'} aria-label="Show ${e(label.toLowerCase())}">` : ''}<span class="ws-tb ws-tb-${id}">${icon(ico)}</span><span>${e(label)}</span><small>${mtg.counts[id] || ''}</small></label>`).join('');
  return `<div class="ws-mtg-legend">
    <div class="ws-cal-list-head"><span class="ws-field-label">Meeting notes</span><span class="ws-muted">${scope}</span></div>
    ${toggle({ action: 'calendar-transcripts', checked: mtg.only, label: 'Only meetings with transcripts' })}
    <div class="ws-mtg-legend-rows">${rows}</div>
    <p class="ws-hint ws-muted">Badges appear on Teams meetings. Transcripts are saved on their own; click a meeting to make notes.</p>
  </div>`;
}

// ---------------------------------------------------------------- mini month

function miniMonth(selected, viewDays, events, zone, todayKey) {
  const month = calendarDays(selected, 'month');
  const current = selected.getMonth();
  const inView = new Set(viewDays.map(localDayKey));
  const busy = new Set();
  for (const r of events) {
    const span = eventSpan(r, zone);
    busy.add(span.startKey);
  }
  return `<div class="ws-mini">
    <div class="ws-mini-head"><strong>${e(selected.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</strong>
      <span>${button('', { action: 'calendar-mini', iconName: 'chevron-left', variant: 'ghost', size: 'sm', title: 'Previous month', attrs: { 'data-step': '-1' } })}${button('', { action: 'calendar-mini', iconName: 'chevron-right', variant: 'ghost', size: 'sm', title: 'Next month', attrs: { 'data-step': '1' } })}</span></div>
    <div class="ws-mini-grid">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<span class="ws-mini-dow">${d}</span>`).join('')}
    ${month.map(day => {
    const key = localDayKey(day);
    const cls = ['ws-mini-day', day.getMonth() !== current ? 'ws-out' : '', key === todayKey ? 'ws-today' : '', inView.has(key) ? 'ws-in-view' : '', busy.has(key) ? 'ws-busy' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-action="calendar-goto" data-date="${key}" aria-label="${e(day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}">${day.getDate()}</button>`;
  }).join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------- day / week grid

function eventClasses(d, nowMs, extra = '') {
  return [
    'ws-ev', extra,
    new Date(d.end).getTime() <= nowMs ? 'ws-past' : '',
    d.response === 'tentativelyAccepted' || d.showAs === 'tentative' ? 'ws-tentative' : '',
    d.response === 'notResponded' || d.response === 'none' && !d.isOrganizer ? 'ws-unanswered' : '',
    d.showAs === 'free' ? 'ws-free' : '',
  ].filter(Boolean).join(' ');
}

function timeGrid(days, events, zone, todayKey, colors, mtg) {
  const nowMs = Date.now();
  const nowParts = zonedParts(nowMs, zone);
  const nowMin = nowParts.hour * 60 + nowParts.minute;
  const columns = days.map(day => ({ key: localDayKey(day), day, ...eventsOnDay(events, localDayKey(day), zone) }));
  const hasAllDay = columns.some(c => c.allDay.length);
  const showsToday = columns.some(c => c.key === todayKey);
  const firstEvent = Math.min(...columns.flatMap(c => c.timed.map(t => Math.floor(t.startMin / 60))), 24);
  const scrollHour = showsToday ? Math.max(0, nowParts.hour - 2) : Math.max(0, Math.min(8, firstEvent) - 1);
  const head = columns.map(c => `<button type="button" class="ws-tg-dayhead${c.key === todayKey ? ' ws-today' : ''}" data-action="calendar-goto" data-date="${c.key}" data-mode="day"><span>${e(c.day.toLocaleDateString(undefined, { weekday: 'short' }))}</span><strong>${c.day.getDate()}</strong></button>`).join('');
  const allDay = columns.map(c => `<div class="ws-tg-allday-cell">${c.allDay.map(r => `<button type="button" class="ws-chip-event" data-action="event" data-id="${e(r.id)}" style="--event-color:${e(colors.get(r.data.calendarId) || 'var(--ws-accent)')}" title="${e(r.data.title || '')}">${e(r.data.title || 'All-day event')}</button>`).join('')}</div>`).join('');
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="ws-tg-hour" style="top:${h * HOUR_HEIGHT}px"><span>${h ? e(hourLabel(h)) : ''}</span></div>`).join('');
  const cols = columns.map(c => {
    const blocks = layoutColumns(c.timed, 22).map(t => {
      const d = t.record.data;
      const top = (t.startMin / 60) * HOUR_HEIGHT;
      const height = Math.max(18, ((t.visualEnd - t.startMin) / 60) * HOUR_HEIGHT - 2);
      const compact = height < 38;
      const where = d.joinUrl ? 'Microsoft Teams' : d.location || '';
      const badge = mtg.badge(t.record.id);
      const extra = [compact ? 'ws-compact' : height < 62 ? 'ws-short' : '', badge ? 'ws-mtg-has-badge' : '', mtg.shown(t.record.id) ? '' : 'ws-mtg-dim'].filter(Boolean).join(' ');
      return `<button type="button" class="${eventClasses(d, nowMs, extra)}" data-action="event" data-id="${e(t.record.id)}" style="--event-color:${e(colors.get(d.calendarId) || 'var(--ws-accent)')};top:${top.toFixed(1)}px;height:${height.toFixed(1)}px;left:calc(${((t.col / t.cols) * 100).toFixed(3)}% + 1px);width:calc(${(100 / t.cols).toFixed(3)}% - 3px)" title="${e(`${formatTime(d.start, zone)}–${formatTime(d.end, zone)} ${d.title || ''}`)}">
        <strong>${e(d.title || 'Untitled event')}</strong>
        <span class="ws-ev-time">${compact ? '' : `${e(formatTime(d.start, zone))} – ${e(formatTime(d.end, zone))}`}${compact ? e(formatTime(d.start, zone)) : ''}</span>
        ${!compact && height > 56 && where ? `<span class="ws-ev-where">${d.joinUrl ? teamsGlyph : icon('pin')}${e(where)}</span>` : ''}
        ${badge}
      </button>`;
    }).join('');
    const now = c.key === todayKey ? `<div class="ws-now-line" data-now-line data-start-hour="0" data-hour-height="${HOUR_HEIGHT}" style="top:${((nowMin / 60) * HOUR_HEIGHT).toFixed(1)}px"><span></span></div>` : '';
    return `<div class="ws-tg-col${c.key === todayKey ? ' ws-today' : ''}${[0, 6].includes(c.day.getDay()) ? ' ws-weekend' : ''}">${blocks}${now}</div>`;
  }).join('');
  return `<div class="ws-tg" style="--days:${days.length};--hour:${HOUR_HEIGHT}px">
    <div class="ws-tg-scroll" data-scroll-hour="${scrollHour}">
      <div class="ws-tg-sticky">
        <div class="ws-tg-head"><span class="ws-tg-zone" title="${e(zone)}">${e(shortZone(zone))}</span>${head}</div>
        ${hasAllDay ? `<div class="ws-tg-allday"><span class="ws-tg-gutter-label">All day</span>${allDay}</div>` : ''}
      </div>
      <div class="ws-tg-body" style="height:${24 * HOUR_HEIGHT}px"><div class="ws-tg-gutter">${hours}</div><div class="ws-tg-cols">${cols}</div></div>
    </div>
  </div>`;
}

function shortZone(zone) {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || zone;
  } catch {
    return zone;
  }
}

// ---------------------------------------------------------------- month

function monthView(days, events, zone, todayKey, colors, state, mtg) {
  const current = state.calendarDate.getMonth();
  const nowMs = Date.now();
  const cells = days.map(day => {
    const key = localDayKey(day);
    const { allDay, timed } = eventsOnDay(events, key, zone);
    const items = [
      ...allDay.filter(() => !mtg.only).map(r => `<button type="button" class="ws-chip-event" data-action="event" data-id="${e(r.id)}" style="--event-color:${e(colors.get(r.data.calendarId) || 'var(--ws-accent)')}">${e(r.data.title || 'All-day event')}</button>`),
      ...timed.filter(t => mtg.shown(t.record.id)).map(t => `<button type="button" class="ws-month-ev${new Date(t.record.data.end).getTime() <= nowMs ? ' ws-past' : ''}" data-action="event" data-id="${e(t.record.id)}" style="--event-color:${e(colors.get(t.record.data.calendarId) || 'var(--ws-accent)')}"><span class="ws-dot"></span><time>${e(formatTime(t.record.data.start, zone))}</time><span class="ws-month-ev-title">${e(t.record.data.title || 'Untitled')}</span>${mtg.badge(t.record.id)}</button>`),
    ];
    const max = 3;
    const more = items.length - max;
    return `<div class="ws-month-cell${day.getMonth() !== current ? ' ws-out' : ''}${key === todayKey ? ' ws-today' : ''}">
      <button type="button" class="ws-month-date" data-action="calendar-goto" data-date="${key}" data-mode="day" aria-label="Open ${e(day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}">${day.getDate() === 1 ? e(day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) : day.getDate()}</button>
      <div class="ws-month-items">${items.slice(0, more > 0 ? max - 1 : max).join('')}${more > 0 ? `<button type="button" class="ws-more" data-action="calendar-goto" data-date="${key}" data-mode="day">+${more + 1} more</button>` : ''}</div>
    </div>`;
  }).join('');
  return `<div class="ws-month"><div class="ws-month-dows">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<span>${d}</span>`).join('')}</div><div class="ws-month-grid">${cells}</div></div>`;
}

// ---------------------------------------------------------------- agenda

function agendaView(days, events, zone, todayKey, colors, covered, mtg) {
  const nowMs = Date.now();
  const groups = days.map(day => {
    const key = localDayKey(day);
    const { allDay, timed } = eventsOnDay(events, key, zone);
    return { key, day, allDay: mtg.only ? [] : allDay, timed: timed.filter(t => mtg.shown(t.record.id)) };
  }).filter(g => g.allDay.length || g.timed.length);
  if (!groups.length) {
    return emptyState({ iconName: 'coffee', title: covered ? 'Nothing scheduled' : 'Loading this period', text: covered ? 'No events in the next two weeks.' : 'Events appear as soon as this period is synchronized.' });
  }
  return `<div class="ws-agenda">${groups.map(g => `<section class="ws-agenda-day${g.key === todayKey ? ' ws-today' : ''}">
    <header><strong>${g.day.getDate()}</strong><div><span>${e(g.day.toLocaleDateString(undefined, { weekday: 'long' }))}</span><small>${e(g.day.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}${g.key === todayKey ? ' · Today' : ''}</small></div></header>
    <div class="ws-agenda-items">
      ${g.allDay.map(r => agendaRow(r, zone, colors, nowMs, true, mtg)).join('')}
      ${g.timed.map(t => agendaRow(t.record, zone, colors, nowMs, false, mtg)).join('')}
    </div>
  </section>`).join('')}</div>`;
}

function agendaRow(r, zone, colors, nowMs, allDay, mtg) {
  const d = r.data;
  const minutes = (new Date(d.end) - new Date(d.start)) / 60000;
  const badge = allDay ? '' : mtg.badge(r.id, { label: true });
  return `<div class="ws-agenda-row${badge ? ' ws-mtg-agenda-row' : ''}${new Date(d.end).getTime() <= nowMs ? ' ws-past' : ''}" style="--event-color:${e(colors.get(d.calendarId) || 'var(--ws-accent)')}">
    <span class="ws-agenda-time">${allDay ? 'All day' : `${e(formatTime(d.start, zone))}<small>${e(durationLabel(minutes))}</small>`}</span>
    <span class="ws-agenda-bar"></span>
    <button type="button" class="ws-agenda-main" data-action="event" data-id="${e(r.id)}"><strong>${e(d.title || 'Untitled event')}</strong><span>${d.joinUrl ? `${teamsGlyph}Microsoft Teams` : d.location ? `${icon('pin')}${e(d.location)}` : e(d.organizer?.name || '')}</span></button>
    ${badge || (d.joinUrl && new Date(d.end).getTime() > nowMs) ? `<span class="ws-mtg-agenda-state">${badge}${d.joinUrl && new Date(d.end).getTime() > nowMs ? button('Join', { action: 'join', variant: 'primary', iconName: 'video', size: 'sm', attrs: { 'data-id': r.id } }) : ''}</span>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- event details

const RESPONSE = {
  accepted: ['Accepted', 'success'], tentativelyAccepted: ['Tentative', 'warning'], declined: ['Declined', 'error'],
  organizer: ['Organizer', 'info'], notResponded: ['No response', 'neutral'], none: ['No response', 'neutral'],
};

export function eventDetails(s, ev) {
  const zone = s.settings.timeZone;
  const d = ev.data;
  const catalog = calendarCatalog(s);
  const index = catalog.findIndex(c => c.id === d.calendarId);
  const cal = catalog[index];
  const color = calendarColor(cal, Math.max(0, index));
  const minutes = (new Date(d.end) - new Date(d.start)) / 60000;
  const when = d.allDay
    ? `${formatDate(dateFromKey(d.startDate || d.start.slice(0, 10)), undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · All day`
    : `${formatDate(d.start, zone, { weekday: 'long', month: 'long', day: 'numeric' })} · ${formatTime(d.start, zone)} – ${formatTime(d.end, zone)} (${durationLabel(minutes)})`;
  const attendees = (d.attendees || []).filter(a => a.type !== 'resource');
  const myResponse = d.isOrganizer ? 'organizer' : d.response;
  const [respLabel, respTone] = RESPONSE[myResponse] || [];
  return `<div class="ws-event-detail" style="--event-color:${e(color)}">
    <div class="ws-event-rows">
      <div class="ws-event-row">${icon('clock')}<div><strong>${e(when)}</strong>${d.originalTimeZone && d.originalTimeZone !== zone && !d.allDay ? `<small>Shown in ${e(zone)}</small>` : ''}</div></div>
      ${d.joinUrl ? `<div class="ws-event-row">${teamsGlyph}<div><strong>Microsoft Teams meeting</strong>${d.location && !/teams/i.test(d.location) ? `<small>${e(d.location)}</small>` : ''}</div></div>` : d.location ? `<div class="ws-event-row">${icon('pin')}<div><strong>${e(d.location)}</strong></div></div>` : ''}
      <div class="ws-event-row">${icon('calendar')}<div><strong>${e(cal?.name || 'Calendar')}</strong>${respLabel ? `<small>${badge(respLabel, respTone)}</small>` : ''}</div></div>
      ${d.organizer?.name || d.organizer?.address ? `<div class="ws-event-row">${icon('user')}<div><strong>${e(d.organizer.name || d.organizer.address)}</strong><small>Organizer</small></div></div>` : ''}
    </div>
    ${attendees.length ? `<details class="ws-attendees"${attendees.length <= 8 ? ' open' : ''}><summary>${icon('users')}${attendees.length} attendee${attendees.length === 1 ? '' : 's'}</summary><ul>${attendees.slice(0, 60).map(a => `<li>${avatar({ name: a.name || a.address, size: 24, seed: a.address })}<span>${e(a.name || a.address)}</span>${RESPONSE[a.response] && a.response !== 'none' && a.response !== 'notResponded' ? badge(RESPONSE[a.response][0], RESPONSE[a.response][1]) : ''}</li>`).join('')}</ul></details>` : ''}
    ${d.preview ? `<div class="ws-event-preview">${e(d.preview)}</div>` : ''}
    ${d.private ? `<p class="ws-muted ws-hint">${icon('lock')} Private event</p>` : ''}
    ${meetingCard(s, ev)}
  </div>`;
}

/** The event card's footer: Join, Open in Outlook, Remind me, and Show in Meetings for a Teams
 *  meeting. */
export function eventActions(s, ev, nowMs = Date.now()) {
  const d = ev.data;
  const live = new Date(d.end).getTime() > nowMs;
  const meeting = !d.cancelled && !d.allDay && (d.joinUrl || d.isOnlineMeeting === true);
  return `${d.joinUrl && live ? button('Join Teams meeting', { action: 'join', variant: 'primary', iconName: 'video', attrs: { 'data-id': ev.id } }) : ''}${d.url ? button('Open in Outlook', { action: 'source', iconName: 'external', attrs: { 'data-kind': 'event', 'data-id': ev.id } }) : ''}${live && new Date(d.start).getTime() > nowMs ? button('Remind me', { action: 'event-reminder', variant: 'ghost', iconName: 'bell', attrs: { 'data-id': ev.id } }) : ''}${meeting ? button('Show in Meetings', { action: 'meeting-open', attrs: { 'data-id': ev.id } }) : ''}`;
}
