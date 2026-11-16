// Time-zone aware formatting helpers. Every provider time is shown in the workspace time zone
// (Settings → General), never the WebView's own zone, so Calendar and Today always agree.

const formatters = new Map();
function formatter(zone, options) {
  const key = `${zone}|${JSON.stringify(options)}`;
  let value = formatters.get(key);
  if (!value) {
    try {
      value = new Intl.DateTimeFormat(undefined, { timeZone: zone || undefined, ...options });
    } catch {
      value = new Intl.DateTimeFormat(undefined, options);
    }
    formatters.set(key, value);
  }
  return value;
}

export function toDate(value) {
  if (value instanceof Date) return value;
  // Native records use epoch seconds; UI arithmetic uses milliseconds. Real dates differ by 1000×.
  if (typeof value === 'number') return new Date(Math.abs(value) < 1e11 ? value * 1000 : value);
  return new Date(value);
}

export function isValidDate(value) {
  return !Number.isNaN(toDate(value).getTime());
}

const partFormatters = new Map();
function partsFormatter(zone) {
  let value = partFormatters.get(zone);
  if (!value) {
    // Fixed locale, Gregorian calendar and Latin digits: day keys must parse in every user locale
    // (th-TH would give Buddhist years, ar-EG/fa-IR non-Latin digits).
    const options = { calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    try {
      value = new Intl.DateTimeFormat('en-US', { timeZone: zone || undefined, ...options });
    } catch {
      value = new Intl.DateTimeFormat('en-US', options);
    }
    partFormatters.set(zone, value);
  }
  return value;
}

/** Calendar parts of an instant as seen in `zone`. */
export function zonedParts(value, zone) {
  const date = toDate(value);
  const parts = partsFormatter(zone).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

const pad = n => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of an instant in `zone`. */
export function dayKey(value, zone) {
  const p = zonedParts(value, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `YYYY-MM-DD` of a local calendar Date (grid days are plain local dates). */
export function localDayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local noon Date for a `YYYY-MM-DD` key; safe across DST. */
export function dateFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** Calendar-day arithmetic on keys (never ±24 h, which is wrong on DST change days). */
export function addDaysToKey(key, days) {
  const date = dateFromKey(key);
  date.setDate(date.getDate() + days);
  return localDayKey(date);
}

export function minutesOfDay(value, zone) {
  const p = zonedParts(value, zone);
  return p.hour * 60 + p.minute;
}

export function formatTime(value, zone) {
  if (!isValidDate(value)) return '—';
  return formatter(zone, { hour: '2-digit', minute: '2-digit' }).format(toDate(value));
}

export function formatDate(value, zone, options = { month: 'short', day: 'numeric' }) {
  if (!isValidDate(value)) return '—';
  return formatter(zone, options).format(toDate(value));
}

export function formatDateTime(value, zone) {
  return formatDate(value, zone, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatRange(start, end, zone) {
  if (dayKey(start, zone) === dayKey(end, zone)) return `${formatTime(start, zone)} – ${formatTime(end, zone)}`;
  return `${formatDateTime(start, zone)} – ${formatDateTime(end, zone)}`;
}

const TWELVE_HOUR = (() => {
  try {
    return /h1[12]/.test(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle || '');
  } catch {
    return false;
  }
})();

/** Compact gutter label: "9 AM" in 12-hour locales, "09:00" otherwise. */
export function hourLabel(hour) {
  if (TWELVE_HOUR) return `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
  return `${pad(hour)}:00`;
}

export function durationLabel(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** "in 25 min", "in 2 h 5 min", "now". */
export function countdownLabel(targetMs, nowMs = Date.now()) {
  const minutes = Math.round((targetMs - nowMs) / 60000);
  if (minutes <= 0) return 'now';
  return `in ${durationLabel(minutes)}`;
}

/** Compact age for lists: "now", "5m", "3h", "Yesterday", "Mon", "Nov 3". */
export function relativeAge(value, zone, nowMs = Date.now()) {
  if (!isValidDate(value)) return '';
  const ms = toDate(value).getTime();
  const diff = Math.max(0, nowMs - ms);
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  const today = dayKey(nowMs, zone);
  if (dayKey(ms, zone) === today) return `${Math.floor(diff / 3_600_000)}h`;
  const yesterday = addDaysToKey(today, -1);
  if (dayKey(ms, zone) === yesterday) return 'Yesterday';
  if (diff < 6 * 86_400_000) return formatDate(ms, zone, { weekday: 'short' });
  return formatDate(ms, zone, { month: 'short', day: 'numeric' });
}

/** Sentence-style age for status text: "just now", "5 min ago", "2 h ago", "yesterday", "on Nov 3". */
export function agoLabel(value, zone, nowMs = Date.now()) {
  if (!isValidDate(value)) return '';
  const ms = toDate(value).getTime();
  const diff = Math.max(0, nowMs - ms);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (dayKey(ms, zone) === dayKey(nowMs, zone)) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (dayKey(ms, zone) === addDaysToKey(dayKey(nowMs, zone), -1)) return 'yesterday';
  return `on ${formatDate(ms, zone, { month: 'short', day: 'numeric' })}`;
}

export function greeting(hour) {
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function firstName(connection) {
  const given = connection?.givenName?.trim();
  if (given) return given;
  const name = connection?.displayName?.trim() || '';
  // "Surname, Given" (common in corporate directories) or "Given Surname".
  if (name.includes(',')) return name.split(',')[1].trim().split(/\s+/)[0] || '';
  return name.split(/\s+/)[0] || '';
}

export function initials(name) {
  const clean = String(name || '').replace(/[^\p{L}\p{N}\s,]/gu, ' ').trim();
  if (!clean) return '?';
  let words = clean.split(/[\s,]+/).filter(Boolean);
  if (clean.includes(',')) words = [words[1] || '', words[0]].filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2);
  return letters.toUpperCase();
}

// CodeMie avatar palette (assistant/user avatars on the platform).
const AVATAR_COLORS = ['#7B3FBF', '#C2185B', '#00796B', '#1565C0', '#5C6BC0', '#E65100', '#2E7D32', '#AD1457', '#0277BD', '#6A1B9A'];
export function colorFor(seed) {
  let hash = 0;
  for (const ch of String(seed || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
