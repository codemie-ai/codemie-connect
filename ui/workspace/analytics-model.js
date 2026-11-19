// The Analytics page's pure model (docs/superpowers/specs/2026-11-19-analytics-design.md): the
// page's view state and the preferences it keeps, the local-day ranges sent to `analytics_view`,
// and the formatters. Every AI number comes from the CLI's `codemie.analytics.summary/1` as it is:
// nothing here adds, divides or compares the CLI's numbers, it only formats them.
// Units are the CLI's (view/types.ts): a `…Rate` or `…Pct` is a percent (0–100), a `share…` or
// `…Share` a fraction (0–1); money in USD, times in epoch ms.
import { dayKey, zonedParts } from './format.js';

export const PREFS_KEY = 'codemie.analytics';
/** Opening the page refreshes on its own when the last fetch is older than this. */
export const STALE_MS = 15 * 60_000;
/** Sessions shown at first, and added by Show more. */
export const SESSIONS_PAGE = 40;
export const MODES = ['ai', 'app'];
export const VIEWS = [['overview', 'Overview'], ['efficiency', 'Efficiency'], ['sessions', 'Sessions']];
export const PRESETS = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '90d', label: 'Last 90 days', days: 90 },
  { id: 'month', label: 'This month' },
];
const DEFAULT_PREFS = { mode: 'ai', view: 'overview', range: '30d', noticeHidden: false, tables: {} };

// ---------------------------------------------------------------- view state and preferences

/** `{mode, view, range, noticeHidden, tables}` from localStorage; anything unreadable or not ours
 *  is the default. */
export function loadPrefs(storage) {
  let saved = null;
  try {
    saved = JSON.parse(storage?.getItem(PREFS_KEY) || 'null');
  } catch {
    saved = null;
  }
  const p = saved && typeof saved === 'object' ? saved : {};
  const tables = {};
  if (p.tables && typeof p.tables === 'object') {
    for (const [id, on] of Object.entries(p.tables)) if (on === true) tables[id] = true;
  }
  return {
    mode: MODES.includes(p.mode) ? p.mode : DEFAULT_PREFS.mode,
    view: VIEWS.some(([id]) => id === p.view) ? p.view : DEFAULT_PREFS.view,
    range: PRESETS.some(x => x.id === p.range) ? p.range : DEFAULT_PREFS.range,
    noticeHidden: p.noticeHidden === true,
    tables,
  };
}

/** Keeps the five preferences; a storage that refuses is ignored (a preference only). */
export function savePrefs(storage, ui) {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify({ mode: ui.mode, view: ui.view, range: ui.range, noticeHidden: !!ui.noticeHidden, tables: ui.tables || {} }));
  } catch { /* a preference only */ }
}

/** The page's view state: the kept preferences, the filters and the per-card choices. */
export function newAnalyticsView(prefs = DEFAULT_PREFS) {
  return {
    ...DEFAULT_PREFS, ...prefs, tables: { ...(prefs.tables || {}) },
    agent: '', project: '', metric: 'cost', inv: 'tools', list: 'dead', sort: 'newest', q: '', shown: SESSIONS_PAGE, all: {},
  };
}

/** A fetch is going: one this page started, one the progress event reports, or the status says so. */
export const isBusy = data => !!(data?.refreshing || data?.progress?.running || data?.status?.state === 'running');

/** The data is older than 15 minutes, or nothing was ever fetched. */
export const isStale = (status, now) => !status?.lastFetchAt || now - status.lastFetchAt > STALE_MS;

// ---------------------------------------------------------------- ranges

const pad = n => String(n).padStart(2, '0');
const DAY = 86_400_000;

/** `YYYY-MM-DD` of an instant (ms) in `zone`. */
export const dayKeyIn = (ms, zone) => dayKey(ms, zone);

/** Calendar arithmetic on a `YYYY-MM-DD` key. */
function addDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
const keyMs = key => Date.parse(`${key}T00:00:00Z`);

/** Minutes `zone` is ahead of UTC at an instant. */
function offsetMinutes(ms, zone) {
  const p = zonedParts(ms, zone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** The instant a local calendar day begins in `zone`. */
function dayStart(key, zone) {
  const wall = keyMs(key);
  let t = wall;
  for (let i = 0; i < 3; i++) t = wall - offsetMinutes(t, zone) * 60_000;
  return t;
}

/** An instant as local wall time in `zone` with its offset: `2026-10-21T00:00:00+03:00`. */
function isoIn(ms, zone, millis) {
  const p = zonedParts(ms, zone);
  const off = offsetMinutes(ms, zone);
  const abs = Math.abs(off);
  const sec = Math.floor((((ms % 60_000) + 60_000) % 60_000) / 1000);
  const frac = millis ? `.${String(((ms % 1000) + 1000) % 1000).padStart(3, '0')}` : '';
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(sec)}${frac}${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** A preset as the local days it covers, ending today: `{from, to, label, days}`, `from` the
 *  first day's start and `to` the last millisecond of today, both with the zone's offset. */
export function presetRange(id, now, zone) {
  const preset = PRESETS.find(p => p.id === id) || PRESETS.find(p => p.id === DEFAULT_PREFS.range);
  const today = dayKeyIn(now, zone);
  const month = preset.id === 'month';
  const first = month ? `${today.slice(0, 8)}01` : addDays(today, -(preset.days - 1));
  return {
    from: isoIn(dayStart(first, zone), zone, false),
    to: isoIn(dayStart(addDays(today, 1), zone) - 1, zone, true),
    label: preset.label,
    days: month ? Number(today.slice(8)) : preset.days,
  };
}

/** `analytics_report`'s data: the range and the filters that are set. */
export function reportRequest(ui, now, zone) {
  const { from, to } = presetRange(ui.range, now, zone);
  return { from, to, ...(ui.agent ? { agent: ui.agent } : {}), ...(ui.project ? { project: ui.project } : {}) };
}

/** `analytics_view`'s data: as the report, with the CLI's comparison to the period before. */
export const viewRequest = (ui, now, zone) => ({ ...reportRequest(ui, now, zone), compare: true });

/** While history is still read, how many of the range's days are stored: `{done, total}`, or
 *  null when the whole range is in (or nothing is being read). `storedFrom` is a UTC day. */
export function readSoFar(rangeId, status, busy, now, zone) {
  if (!busy) return null;
  const { days } = presetRange(rangeId, now, zone);
  const today = dayKeyIn(now, zone);
  const stored = status?.storedFrom;
  if (stored && stored <= addDays(today, -(days - 1))) return null;
  const done = stored ? Math.round((keyMs(today) - keyMs(stored)) / DAY) + 1 : 0;
  return { done: Math.max(0, Math.min(days, done)), total: days };
}

/** The first instant that is stored while a fetch runs: series buckets ending before it aren't
 *  read yet. Null when nothing is being read. */
export function pendingBefore(data) {
  if (!isBusy(data)) return null;
  const stored = data.status?.storedFrom;
  return stored ? keyMs(stored) : Infinity;
}

// ---------------------------------------------------------------- deltas

/** `{up, text}` for a field of the CLI's `change`, only when it also sent `previous`. */
export function delta(summary, key) {
  const change = summary?.previous && summary.change ? summary.change[key] : null;
  if (typeof change !== 'number' || !Number.isFinite(change)) return null;
  const points = Math.abs(change * 100);
  return { up: change >= 0, text: `${change >= 0 ? '↑' : '↓'} ${points < 1 ? '<1' : Math.round(points)}%` };
}

// ---------------------------------------------------------------- formatters

const finite = v => typeof v === 'number' && Number.isFinite(v);

/** Dollars: `<$0.01` under a cent; `exact` gives cents with thousands separators. */
export function usd(v, exact = false) {
  if (!finite(v)) return '—';
  if (v > 0 && v < 0.01) return '<$0.01';
  if (exact) return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  if (v >= 100) return `$${v.toFixed(0)}`;
  return `$${v.toFixed(2)}`;
}

/** A dollar axis tick. */
export const usdAxis = v => (v >= 1000 ? `$${v / 1000}K` : v >= 1 || v === 0 ? `$${Math.round(v * 10) / 10}` : `$${v.toFixed(2)}`);

/** Tokens in K, M or B. */
export function tok(v) {
  if (!finite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}

/** A duration: seconds under a minute, minutes under an hour, then hours (and minutes when
 *  `long`, or under ten hours). */
export function dur(ms, long = false) {
  if (!finite(ms)) return '—';
  if (ms <= 0) return '0 min';
  if (ms < 60_000) return `${Math.min(59, Math.max(1, Math.round(ms / 1000)))} s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h >= 10 && !long) return `${h} h`;
  return `${h} h${r ? ` ${r} m` : ''}`;
}

/** A fraction (0–1) as a percent; one decimal under 10% unless `digits` is 0. */
export function pct(v, digits) {
  if (!finite(v)) return '—';
  if (v > 0 && v < 0.001) return '<0.1%';
  return `${v * 100 < 10 && v > 0 && digits !== 0 ? (v * 100).toFixed(1) : Math.round(v * 100)}%`;
}

/** A percent the CLI already gives as 0–100 (`toolSuccessRate`, `successRate`, `bloatPct`). */
export function pctPoints(v) {
  if (!finite(v)) return '—';
  const r = Math.round(v * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)}%`;
}

export const n0 = v => (finite(v) ? Math.round(v).toLocaleString('en-US') : '—');
export const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekdayOf = p => WD[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];

/** `21 Oct` in `zone`. */
export const dShort = (ms, zone) => { const p = zonedParts(ms, zone); return `${p.day} ${MON[p.month - 1]}`; };
/** `Wed 21 Oct` in `zone`. */
export const dLong = (ms, zone) => { const p = zonedParts(ms, zone); return `${weekdayOf(p)} ${p.day} ${MON[p.month - 1]}`; };
/** `Wed` in `zone`. */
export const weekday = (ms, zone) => weekdayOf(zonedParts(ms, zone));
/** `16:40` in `zone`. */
export const hm = (ms, zone) => { const p = zonedParts(ms, zone); return `${pad(p.hour)}:${pad(p.minute)}`; };
/** Today, Yesterday or `Wed 21 Oct`. */
export function dayName(ms, now, zone) {
  const key = dayKeyIn(ms, zone);
  const today = dayKeyIn(now, zone);
  if (key === today) return 'Today';
  if (key === addDays(today, -1)) return 'Yesterday';
  return dLong(ms, zone);
}
/** A `YYYY-MM-DD` day as `Sun 15 Nov` (failed days, the first stored day). */
export function dayKeyLabel(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  if (!y || !m || !d) return String(key);
  return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MON[m - 1]}`;
}

// The product names of the CLI's agent ids (report/client/app.js AGENT_LABELS); others as they are.
const AGENT_LABELS = {
  claude: 'Claude Code', 'claude-acp': 'Claude Code ACP', 'claude-desktop': 'Claude Desktop',
  'codemie-code': 'CodeMie Code', codex: 'Codex CLI', 'codex-acp': 'Codex CLI ACP', 'codemie-codex': 'CodeMie Codex',
  gemini: 'Gemini CLI', 'gemini-acp': 'Gemini CLI ACP', opencode: 'OpenCode', 'opencode-acp': 'OpenCode ACP',
  kimi: 'Kimi Code', 'kimi-acp': 'Kimi Code ACP', openwiki: 'OpenWiki', 'copilot-cli': 'GitHub Copilot CLI', 'copilot-desktop': 'GitHub Copilot Desktop', pi: 'Pi', omp: 'Oh My Pi',
};
export const agentLabel = name => AGENT_LABELS[name] || String(name ?? '');

/** `claude-opus-5-5` → `Opus 5.5`; other model ids as they are. */
export function modelLabel(id) {
  const m = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(id ?? ''));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : String(id ?? '');
}

/** The last folder of a project path. */
export const projectName = path => String(path ?? '').split('/').filter(Boolean).pop() || String(path ?? '');

// ---------------------------------------------------------------- the sessions list

const SORTS = {
  newest: (a, b) => b.startTime - a.startTime,
  cost: (a, b) => b.costUSD - a.costUSD,
  time: (a, b) => b.durationMs - a.durationMs,
  turns: (a, b) => b.turns - a.turns,
};
export const SORT_LABELS = [['newest', 'Newest first'], ['cost', 'Most expensive'], ['time', 'Longest'], ['turns', 'Most turns']];

/** The CLI's session rows matching a search (title, project, branch, models), in the chosen order. */
export function listSessions(rows = [], q = '', sort = 'newest') {
  const words = q.trim().toLowerCase();
  const found = words ? rows.filter(r => [r.title, r.project, r.branch, ...(r.models || [])].join(' ').toLowerCase().includes(words)) : rows;
  return found.slice().sort(SORTS[sort] || SORTS.newest);
}
