// Pure calendar geometry: which days a view shows, which events fall on a day, and how
// overlapping timed events share columns. No DOM access, so it is unit tested directly.
import { dayKey, localDayKey, minutesOfDay } from './format.js';

export const VIEW_DAYS = { day: 1, week: 7, month: 42, agenda: 14 };

/** Local-noon Dates shown by a view. Weeks start on Monday. */
export function calendarDays(date, mode) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  if (mode === 'month') {
    d.setDate(1);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  } else if (mode === 'week') {
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  }
  const count = VIEW_DAYS[mode] || 7;
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(d);
    day.setDate(d.getDate() + i);
    return day;
  });
}

/** Epoch-second range requested from the native calendar window, padded by two days for time zones. */
export function calendarWindow(date, mode) {
  const days = calendarDays(date, mode);
  const start = new Date(days[0]);
  const end = new Date(days.at(-1));
  start.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);
  return { start: Math.floor(start / 1000) - 172800, end: Math.floor(end / 1000) + 172800 };
}

export function activeWorkspace(snapshot) {
  return snapshot.workspaces.find(w => w.id === snapshot.settings.activeWorkspace) || snapshot.workspaces[0];
}

export function calendarCatalog(snapshot) {
  return snapshot.records.find(r => r.kind === 'catalog' && r.id === 'calendars')?.data?.values || [];
}

/** Calendars synchronized for the active workspace: every calendar when sources are automatic. */
export function calendarIds(snapshot) {
  const sources = activeWorkspace(snapshot)?.sources || {};
  if (sources.all) return calendarCatalog(snapshot).map(c => c.id).filter(Boolean);
  return sources.calendars || [];
}

/** Native sync reads at most this many calendars per account. */
export const MAX_SYNCED_CALENDARS = 30;

/**
 * True when every readable synchronized calendar has a completed native window covering the
 * period. Calendars that never completed any window (shared calendars Microsoft refuses, or
 * beyond the native cap) are ignored so one of them cannot keep a period "loading" forever.
 */
export function calendarCoverage(snapshot, window) {
  const windows = snapshot.records.filter(r => r.kind === 'calendar_window');
  const readable = calendarIds(snapshot).slice(0, MAX_SYNCED_CALENDARS).filter(id => windows.some(r => r.source === `calendar:${id}`));
  return readable.length > 0 && readable.every(id => windows.some(r => r.source === `calendar:${id}` && r.data.start <= window.start && r.data.end >= window.end));
}

// Outlook calendar colour names → the swatches Outlook shows for them.
const NAMED = {
  lightBlue: '#4F9CF9', lightGreen: '#3FB27F', lightOrange: '#F59E4B', lightGray: '#9AA0A6',
  lightYellow: '#E8B92E', lightTeal: '#2BB3B1', lightPink: '#E46AA8', lightBrown: '#B58463',
  lightRed: '#EF5B5B', maxColor: '#8E7CF2',
};
const FALLBACK = ['#4F9CF9', '#A35BEB', '#3FB27F', '#F59E4B', '#E46AA8', '#2BB3B1', '#EF5B5B', '#8E7CF2'];

export function calendarColor(calendar, index = 0) {
  const hex = calendar?.hexColor;
  if (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return NAMED[calendar?.color] || FALLBACK[index % FALLBACK.length];
}

export function calendarColors(snapshot) {
  return new Map(calendarCatalog(snapshot).map((c, i) => [c.id, calendarColor(c, i)]));
}

/** Day span of an event in `zone`. All-day ends are exclusive dates from the provider. */
export function eventSpan(record, zone) {
  const d = record.data || {};
  if (d.allDay) {
    const startKey = d.startDate || String(d.start || '').slice(0, 10);
    const endExclusive = d.endDate || String(d.end || '').slice(0, 10);
    return { allDay: true, startKey, endKey: previousKey(endExclusive, startKey) };
  }
  const startMs = new Date(d.start).getTime();
  const endMs = Math.max(new Date(d.end).getTime(), startMs);
  // An event ending exactly at midnight does not occupy the next day.
  const endKey = endMs > startMs ? dayKey(endMs - 1, zone) : dayKey(startMs, zone);
  return { allDay: false, startKey: dayKey(startMs, zone), endKey, startMs, endMs };
}

function previousKey(exclusiveKey, startKey) {
  if (!exclusiveKey) return startKey;
  const [y, m, d] = exclusiveKey.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12);
  date.setDate(date.getDate() - 1);
  const key = localDayKey(date);
  return key < startKey ? startKey : key;
}

/** Events touching one calendar day, split into all-day items and timed items clipped to the day. */
export function eventsOnDay(events, key, zone) {
  const allDay = [];
  const timed = [];
  for (const record of events) {
    const span = eventSpan(record, zone);
    if (span.startKey > key || span.endKey < key) continue;
    if (span.allDay) {
      allDay.push(record);
      continue;
    }
    const startMin = span.startKey < key ? 0 : minutesOfDay(span.startMs, zone);
    // Midnight ends map to 1440, but a zero-length event stays a point in time.
    const endMin = span.endKey > key ? 1440 : span.endMs > span.startMs ? minutesOfDay(span.endMs, zone) || 1440 : startMin;
    timed.push({ record, startMin, endMin: Math.max(endMin, startMin), multiDay: span.startKey !== span.endKey });
  }
  timed.sort((a, b) => a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin));
  return { allDay, timed };
}

/**
 * Assigns side-by-side columns to overlapping events (Outlook-style). Each item gets `col` and
 * `cols`; events in one overlap cluster share the same `cols`. Very short events are treated as
 * at least `minMinutes` long so their labels never collide.
 */
export function layoutColumns(items, minMinutes = 20) {
  const placed = items.map(item => ({ ...item, visualEnd: Math.max(item.endMin, item.startMin + minMinutes) }));
  let cluster = [];
  let clusterEnd = -1;
  const finish = () => {
    const columns = [];
    for (const item of cluster) {
      let col = columns.findIndex(end => end <= item.startMin);
      if (col === -1) {
        col = columns.length;
        columns.push(item.visualEnd);
      } else {
        columns[col] = item.visualEnd;
      }
      item.col = col;
    }
    for (const item of cluster) item.cols = columns.length;
  };
  for (const item of placed) {
    if (cluster.length && item.startMin >= clusterEnd) {
      finish();
      cluster = [];
      clusterEnd = -1;
    }
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.visualEnd);
  }
  if (cluster.length) finish();
  return placed;
}

/** An all-day event shown as out of office or busy takes the whole working day (as `slots.rs` does for drafts). */
export const blocksWorkday = r => {
  const d = r?.data || {};
  return d.allDay === true && ['oof', 'busy'].includes(d.showAs) && d.response !== 'declined' && !d.cancelled;
};

/**
 * Free gaps between `fromMin` and `toMin` not covered by busy timed items (minutes of day).
 * Declined meetings and items shown as free do not count; `allDay` items of the same day can
 * take the whole day. The same rule offers free times to "Propose times" drafts.
 */
export function freeSlots(timed, fromMin, toMin, minLength = 30, allDay = []) {
  if (allDay.some(blocksWorkday)) return [];
  const busy = timed
    .filter(t => t.record?.data?.showAs !== 'free' && t.record?.data?.response !== 'declined')
    .map(t => [Math.max(t.startMin, fromMin), Math.min(t.endMin, toMin)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const slots = [];
  let cursor = fromMin;
  for (const [s, e] of busy) {
    if (s - cursor >= minLength) slots.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (toMin - cursor >= minLength) slots.push([cursor, toMin]);
  return slots;
}

/** Backwards-compatible grouping used by agenda/month views. */
export function groupCalendarEvents(events, days, zone) {
  return days.map(day => {
    const { allDay, timed } = eventsOnDay(events, localDayKey(day), zone);
    return { day, events: [...allDay, ...timed.map(t => t.record)] };
  });
}

export function visibleEvents(snapshot, hidden = new Set()) {
  return snapshot.records.filter(r => r.kind === 'event' && !r.data.cancelled && !hidden.has(r.data.calendarId));
}
