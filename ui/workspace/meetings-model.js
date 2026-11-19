// The Meetings page's pure model (spec "Meetings page", "Transcript states"): which calendar
// events are meetings, where each one's transcript stands (`meetingState`), the list's lanes and
// counts, the job running for a meeting (`runOf`), the badges' legend, and the JS mirrors of
// native's template choice (`resolveTemplate`, src-tauri/src/workspace/meetings/templates.rs) and
// glossary reading (`parseGlossary`, `parseTags`, meetings/glossary.rs), which must give the same
// answers as the contract fixtures native writes. Also the page's hash, `#/meetings/<id>/<tab>`.
import { can } from './selectors.js';

export const TABS = ['notes', 'transcript', 'tasks', 'files', 'people'];

/** Every state a meeting shows, with the label and tone of its status text. `downloading` and
 *  `processing` are never stored: they are a meeting whose save or notes job is running. */
export const STATES = {
  upcoming: { label: 'Upcoming', tone: 'muted' },
  pending: { label: 'Waiting for Teams', tone: 'info' },
  available: { label: 'Saving the transcript', tone: 'info' },
  downloading: { label: 'Saving the transcript…', tone: 'info' },
  downloaded: { label: 'No notes yet', tone: 'purple' },
  processing: { label: 'Making notes…', tone: 'purple' },
  ready: { label: 'Notes ready', tone: 'success' },
  failed: { label: 'Notes failed', tone: 'error' },
  blocked: { label: 'Teams blocked access', tone: 'warning' },
  none: { label: 'No transcript', tone: 'muted' },
  offline: { label: 'Not a Teams meeting', tone: 'muted' },
};

/** The list's filters: [id, label]. */
export const LANES = [['all', 'All'], ['process', 'To do'], ['ready', 'Ready'], ['attention', 'Needs you'], ['upcoming', 'Upcoming']];

/** The transcript badge the calendar and Today show: [id, label, icon]. */
export const LEGEND = [
  ['ready', 'Notes ready', 'sparkles'],
  ['process', 'Transcript to process', 'transcript'],
  ['busy', 'Working on it', 'refresh'],
  ['attention', 'Needs you', 'alert'],
  ['auto', 'Notes after the meeting', 'automations'],
];

/** Which legend group a state belongs to: a running job is always "Working on it"; a meeting
 *  waiting while transcripts are off (`paused`) needs the person. */
export function legendOf(state, { busy = false, auto = false, paused = false } = {}) {
  if (busy) return 'busy';
  if (paused) return 'attention';
  if (state === 'pending') return 'busy';
  if (state === 'ready') return 'ready';
  if (state === 'available' || state === 'downloaded') return 'process';
  if (state === 'failed' || state === 'blocked') return 'attention';
  if (state === 'upcoming' && auto) return 'auto';
  return null;
}

/** The Meetings page's view state (only view state lives in the window: meetings are native's). */
export const newMeetingsView = () => ({
  filter: 'all', q: '', selected: null, tab: 'notes', showNone: false, compare: false, focusLine: null,
  // The document editor ({meetingId, docId, version, rev, draft, conflict, mine}), the document
  // shown per meeting, the second one in Side by side, an earlier version being read, the
  // transcript's search and speaker filter, and the meeting whose whole guest list is shown.
  editing: null, docView: {}, compareWith: {}, version: {}, tq: '', speaker: '', peopleAll: null,
  // The Notes tab's Make notes form by meeting id ({templateId, wishes, findTasks, remember}, each
  // only once changed), so a background render shows what was chosen and typed.
  makeForm: {},
});

const dataOf = x => (x && typeof x === 'object' && 'data' in x ? x.data : x) || null;
const timeOf = v => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
};
const lower = v => (typeof v === 'string' ? v : '').trim().toLowerCase();
const hasLink = d => typeof d?.joinUrl === 'string' && d.joinUrl.trim() !== '';

/** A Teams (online) meeting: Graph says so, or it has a join link. */
export const isOnline = d => hasLink(d) || d?.isOnlineMeeting === true;

/** Native stops waiting for a transcript two hours after the meeting ended (transcripts.rs `STOP_AFTER`). */
export const STOP_AFTER_MS = 2 * 3_600_000;

/**
 * Where a meeting's transcript stands. A record says (`event`, `record`: records or their data);
 * a record still marked upcoming after the meeting ended, or none at all, is derived: `upcoming`
 * until it ends, `offline` without a Teams meeting, `none` for meetings the background round never
 * checks (declined, cancelled, all-day, no Teams link, transcripts off), `pending` until a day
 * after the end, then `none`.
 */
export function meetingState(event, record, now = Date.now(), transcriptsOn = true) {
  const r = dataOf(record);
  const d = dataOf(event) || r || {};
  const end = timeOf(d.end ?? r?.end);
  const ended = Number.isFinite(end) && end <= now;
  // A stored `pending` past the day of waiting is `none`, as the round makes it when it runs.
  if (r?.state === 'pending' && ended && now - end >= STOP_AFTER_MS) return 'none';
  if (r?.state && STATES[r.state] && !(r.state === 'upcoming' && ended)) return r.state;
  if (!ended) return 'upcoming';
  if (!isOnline(d)) return 'offline';
  if (lower(d.response) === 'declined' || d.cancelled === true || d.allDay === true || !hasLink(d) || !transcriptsOn) return 'none';
  return now - end < STOP_AFTER_MS ? 'pending' : 'none';
}

/** Transcripts are read when the account allows both Graph scopes (graph.rs `transcripts_permitted`). */
export const transcriptsAllowed = s => can(s, 'meetings') && can(s, 'transcripts');

/**
 * A meeting record's two errors: `save` (why the last save from Teams failed, `cancelled` when
 * the person stopped it) and `notes` (why the last notes run failed). An older record has one
 * `lastError`, read as native's `split_legacy_error` reads it: a `ready` or `failed` meeting's
 * as the notes run's, any other as the save's.
 */
export function meetingErrors(record) {
  const r = dataOf(record) || {};
  if ('saveError' in r || 'notesError' in r) return { save: r.saveError || null, notes: r.notesError || null };
  const old = r.lastError || null;
  return ['ready', 'failed'].includes(r.state) ? { save: null, notes: old } : { save: old, notes: null };
}

/** The organizer and everyone invited (not rooms), each once, as `{name, address}`. */
export function attendeesOf(d) {
  const seen = new Set();
  const out = [];
  for (const p of [d?.organizer, ...(Array.isArray(d?.attendees) ? d.attendees : [])]) {
    if (!p || typeof p !== 'object' || p.type === 'resource') continue;
    const address = String(p.address || '').trim();
    const name = String(p.name || '').trim();
    const key = (address || name).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name || address, address });
  }
  return out;
}

/** "Philips" for jeroen@philips.com: a guest's company, from the part of the domain before its
 *  ending; nothing for people at `myDomain`. */
export function companyOf(address, myDomain = '') {
  const domain = lower(String(address || '').split('@')[1]);
  if (!domain || domain === lower(myDomain)) return '';
  const labels = domain.split('.').filter(Boolean);
  const name = labels.length > 1 ? labels[labels.length - 2] : labels[0];
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : '';
}

/** Who was invited, by name: `{name, address, organizer, me, company}`, the organizer first. */
export function peopleOf(s, d) {
  const myAddress = lower(s?.connection?.email);
  const myName = lower(s?.connection?.displayName);
  const myDomain = myAddress.split('@')[1] || '';
  const organizer = lower(d?.organizer?.address) || lower(d?.organizer?.name);
  return attendeesOf(d).map(p => {
    const me = (!!myAddress && lower(p.address) === myAddress) || (!p.address && !!myName && lower(p.name) === myName);
    return { ...p, organizer: (lower(p.address) || lower(p.name)) === organizer, me, company: me ? '' : companyOf(p.address, myDomain) };
  });
}

/** A calendar event that is a meeting: a Teams meeting, or one with other people in it. */
const meetingLike = d => !d.cancelled && !d.allDay && (isOnline(d) || (Array.isArray(d.attendees) && d.attendees.some(a => a && a.type !== 'resource')));

// ---------------------------------------------------------------- runs

const RUN_KINDS = ['meeting_notes', 'transcript_download', 'transcript_check'];

function runInfo(job) {
  const p = job.payload || {};
  const steps = Array.isArray(p.steps) ? p.steps.map(String) : [];
  const step = typeof p.step === 'string' && p.step ? p.step : null;
  return {
    id: job.id, kind: job.kind, state: job.state, step, steps, index: Math.max(0, steps.indexOf(step)), total: steps.length,
    templateId: p.templateId || null, auto: p.auto === true,
  };
}

/** Each meeting's queued or running job (notes first, then a save, then a check). */
export function runsOf(s) {
  const out = new Map();
  for (const j of s.jobs || []) {
    if (!RUN_KINDS.includes(j.kind) || !['queued', 'running'].includes(j.state)) continue;
    const id = j.payload?.meetingId;
    if (!id) continue;
    const prev = out.get(id);
    if (prev && RUN_KINDS.indexOf(prev.kind) <= RUN_KINDS.indexOf(j.kind)) continue;
    out.set(id, runInfo(j));
  }
  return out;
}

/** The job running (or waiting to run) for a meeting with its `step` among `steps`; null when
 *  nothing runs. */
export const runOf = (s, meetingId) => runsOf(s).get(meetingId) || null;

/** The newest failed notes job of a meeting (its template is what Try again runs again). */
export function failedNotesJob(s, meetingId) {
  return (s.jobs || []).filter(j => j.kind === 'meeting_notes' && j.payload?.meetingId === meetingId && ['failed', 'blocked'].includes(j.state))
    .sort((a, b) => (b.dueAt || 0) - (a.dueAt || 0))[0] || null;
}

// ---------------------------------------------------------------- the list

/** Every meeting the snapshot knows: the calendar's meetings and the meeting records (one whose
 *  event left the calendar too), each `{id, ev, rec, title, start, end, ended, online, state, run}`. */
export function meetingItems(s, now = Date.now()) {
  const on = transcriptsAllowed(s);
  const waiting = s.connection && s.connection.status !== 'connected' ? 'signin' : 'off';
  const runs = runsOf(s);
  const records = new Map();
  const events = new Map();
  for (const r of s.records || []) {
    if (r.kind === 'meeting') records.set(r.id, r);
    else if (r.kind === 'event') events.set(r.id, r);
  }
  const item = (ev, rec) => {
    const d = ev?.data || {};
    const r = rec?.data || {};
    const start = timeOf(d.start ?? r.start);
    const end = timeOf(d.end ?? r.end);
    const id = ev?.id || rec.id;
    const state = meetingState(ev, rec, now, on);
    const run = runs.get(id) || null;
    return {
      id, ev, rec, title: d.title || r.title || 'Untitled meeting', start, end, ended: Number.isFinite(end) && end <= now,
      online: ev ? isOnline(d) : r.state !== 'offline', state, run,
      // Found or waiting for Teams, but nothing can get it now: why (`signin` while Microsoft
      // needs the person to sign in again, `off` while reading transcripts is off), else null.
      paused: !on && !run && (state === 'available' || state === 'pending') ? waiting : null,
    };
  };
  const out = [];
  for (const ev of events.values()) {
    const rec = records.get(ev.id) || null;
    if (!rec && !meetingLike(ev.data || {})) continue;
    out.push(item(ev, rec));
  }
  for (const rec of records.values()) if (!events.has(rec.id)) out.push(item(null, rec));
  return out.filter(m => Number.isFinite(m.start));
}

const IN_LANE = {
  // By state, not by `online`: an in-person meeting whose transcript was imported has one too.
  // A meeting still waiting for Teams has no transcript yet: it shows with the switch, as `none`.
  all: (m, showNone) => m.ended && (showNone || !['none', 'offline', 'upcoming', 'pending'].includes(m.state)),
  process: m => (m.state === 'available' || m.state === 'downloaded') && !m.paused,
  ready: m => m.state === 'ready',
  attention: m => m.state === 'failed' || m.state === 'blocked' || !!m.paused,
  upcoming: m => m.state === 'upcoming',
};

/** Whether a meeting shows in a lane. */
export const inLane = (m, filter, showNone = false) => (IN_LANE[filter] || IN_LANE.all)(m, showNone);

/** Whether a meeting matches the search: its title or anyone invited (name or address). */
export function matches(m, q) {
  const needle = lower(q);
  if (!needle) return true;
  const d = m.ev?.data || m.rec?.data || {};
  return lower(m.title).includes(needle) || attendeesOf(d).some(p => lower(p.name).includes(needle) || lower(p.address).includes(needle));
}

/** The list for a lane and a search: upcoming soonest first, the rest newest first. `items` may
 *  be given when they were computed already. */
export function meetingRows(s, filter = 'all', q = '', showNone = false, now = Date.now(), items = meetingItems(s, now)) {
  const lane = IN_LANE[filter] ? filter : 'all';
  return items.filter(m => inLane(m, lane, showNone) && matches(m, q))
    .sort((a, b) => (lane === 'upcoming' ? a.start - b.start : b.start - a.start) || String(a.id).localeCompare(String(b.id)));
}

/** What the filters and the switch count: to do, needs you, and past meetings without a transcript. */
export function meetingCounts(s, now = Date.now(), items = meetingItems(s, now)) {
  return {
    process: items.filter(m => IN_LANE.process(m)).length,
    attention: items.filter(m => IN_LANE.attention(m)).length,
    none: items.filter(m => m.ended && !IN_LANE.all(m, false)).length,
  };
}

/** The lane that shows a meeting, keeping `current` when it already does. */
export function laneFor(m, current = 'all', showNone = false) {
  if (inLane(m, current, showNone)) return { filter: current, showNone };
  if (m.state === 'upcoming') return { filter: 'upcoming', showNone };
  return { filter: 'all', showNone: showNone || !IN_LANE.all(m, false) };
}

/** A meeting's tasks (not the dismissed ones). */
export const meetingTasks = (s, id) => (s.records || []).filter(r => r.kind === 'commitment' && r.data?.meetingId === id && r.data?.status !== 'dismissed');

/** Every meeting's tasks (not the dismissed ones), by meeting id. */
export function tasksByMeeting(s) {
  const out = new Map();
  for (const r of s.records || []) {
    const id = r.kind === 'commitment' && r.data?.status !== 'dismissed' ? r.data?.meetingId : null;
    if (id) out.set(id, [...(out.get(id) || []), r]);
  }
  return out;
}

// ---------------------------------------------------------------- templates and rules

const RULE_DEFAULTS = { field: 'title', value: '', template: '', autoNotes: false, on: true, order: 0 };
export const RULE_FIELDS = { title: 'title contains', organizer: 'organizer is', org: 'an attendee works at', people: 'number of people is' };

export const templatesOf = s => (Array.isArray(s?.noteTemplates) ? s.noteTemplates : []);
export const rulesOf = s => (s?.records || []).filter(r => r.kind === 'meeting_rule').map(r => ({ ...RULE_DEFAULTS, ...r.data, id: r.id }));

/** rules.rs `people`: the organizer and everyone invited (not rooms), each once by address (else
 *  by name), lower case. */
function rulePeople(d) {
  const seen = new Set();
  const out = [];
  for (const p of [d?.organizer, ...(Array.isArray(d?.attendees) ? d.attendees : [])]) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || p.type === 'resource') continue;
    const address = lower(p.address);
    const name = lower(p.name);
    const key = address || name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push([address, name]);
  }
  return out;
}

/** rules.rs `matches`: whether an event (its data) is what a rule looks for. */
export function ruleMatches(rule, d) {
  const value = lower(String(rule?.value ?? ''));
  if (!value) return false;
  switch (rule.field) {
    case 'title': return lower(d?.title).includes(value);
    case 'organizer': return lower(d?.organizer?.name).includes(value) || lower(d?.organizer?.address).includes(value);
    case 'org': return rulePeople(d).some(([address]) => address.includes('@') && address.slice(address.indexOf('@') + 1).includes(value));
    case 'people': return /^\+?\d+$/.test(value) && Number(value) === rulePeople(d).length;
    default: return false;
  }
}

/** rules.rs `first`: the first rule that is on and matches, by order then id. */
export function firstRule(rules, d) {
  return rules.filter(r => r.on !== false && ruleMatches(r, d))
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] || null;
}

export const ruleText = r => `${RULE_FIELDS[r.field] || RULE_FIELDS.title} “${r.value}”`;

const FALLBACK = { id: 'meeting-notes', name: 'Meeting notes', kind: 'builtin', blurb: '', color: '#5677C8', icon: 'note', extractTasks: true, sections: [] };

/**
 * templates.rs `resolve` and rules.rs `auto_notes`: the template a meeting's notes use and why
 * (`meeting`: chosen for it; `rule`: the first matching rule, `rule` its id; `default`), and
 * whether they are made by themselves (`auto`; `asked`: the meeting's own switch decided).
 * `event` and `record` are records or their data; `s` the snapshot (`rules`, when its rules were
 * read already).
 */
export function resolveTemplate(event, record, s, rules = rulesOf(s)) {
  const d = dataOf(event) || dataOf(record) || {};
  const r = dataOf(record) || {};
  const all = templatesOf(s);
  const find = id => (id ? all.find(t => t.id === id) : null);
  const settings = s?.settings?.meetings || {};
  const rule = firstRule(rules, d);
  let template;
  let why;
  if (find(r.template)) {
    template = find(r.template);
    why = 'meeting';
  } else if (rule && find(rule.template)) {
    template = find(rule.template);
    why = 'rule';
  } else {
    template = find(settings.defaultTemplate) || find('meeting-notes') || FALLBACK;
    why = 'default';
  }
  const mode = settings.autoNotes ?? 'rules';
  const asked = typeof r.auto === 'boolean';
  const auto = asked ? r.auto : mode === 'all' || (mode === 'rules' && !!rule?.autoNotes);
  const reason = why === 'meeting' ? 'Chosen for this meeting' : why === 'rule' ? `Rule: ${ruleText(rule)}` : 'Your default template';
  return { template, id: template.id, why, rule: why === 'rule' ? rule.id : null, ruleRecord: why === 'rule' ? rule : null, auto, asked, reason };
}

// ---------------------------------------------------------------- glossary and tags (glossary.rs)

/** The text between each opener and the next closer on a line (at least one character), left
 *  to right; `**` closes with two stars. As glossary.rs `delimited`. */
function delimited(line, open, close) {
  const found = [];
  let at = 0;
  while (at < line.length) {
    const rest = line.slice(at);
    const opener = open.find(o => rest.startsWith(o));
    if (!opener) { at += 1; continue; }
    const inside = rest.slice(opener.length);
    let end = inside.length;
    for (let i = 0; i < inside.length; i++) if (close.includes(inside[i])) { end = i; break; }
    const closed = end < inside.length && end > 0;
    const tail = inside.slice(end);
    if (closed && (opener !== '**' || tail.startsWith('**'))) {
      found.push(inside.slice(0, end));
      at += opener.length + end + (opener === '**' ? 2 : 1);
    } else {
      at += 1;
    }
  }
  return found;
}

const bold = line => delimited(line, ['**'], ['*']).map(b => b.trim());
const quoted = line => delimited(line, ['“', '"'], ['”', '"']);
function heardAs(line) {
  const at = line.search(/heard as/i);
  if (at < 0) return null;
  const after = line.slice(at + 'heard as'.length);
  const again = after.search(/heard as/i);
  return again < 0 ? after : after.slice(0, again);
}

/** glossary.rs `parse_glossary`: `{me: {name, aliases, address: null} | null, pairs: [[heard,
 *  written]], terms, people}`. */
export function parseGlossary(md = '') {
  const g = { me: null, pairs: [], terms: [], people: [] };
  let section = '';
  for (const line of String(md ?? '').split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      section = line.slice(2).trim().toLowerCase();
      continue;
    }
    const b = bold(line);
    if (!b.length || !section) continue;
    if (section === 'me' && !g.me) {
      g.me = { name: b[0], aliases: quoted(line).filter(q => !/we will/i.test(q)), address: null };
      continue;
    }
    if (section.includes('people')) g.people.push(...b);
    else g.terms.push(b[0]);
    const heard = heardAs(line);
    if (heard !== null) for (const h of quoted(heard)) g.pairs.push([h, b[0]]);
  }
  return g;
}

/** glossary.rs `parse_tags`: every `` `tag` `` that starts a list item. */
/** glossary.rs `blank`: Unicode white space and a byte order mark. `\s` has the mark but not
 *  U+0085 (next line), which Rust's `is_whitespace` has: both read the same set. */
const trimBlank = s => s.replace(/^[\s\u0085]+/, '');

export function parseTags(md = '') {
  const out = [];
  for (const line of String(md ?? '').split(/\r?\n/)) {
    const start = trimBlank(line);
    if (!['-', '*'].includes(start[0])) continue;
    const item = start.slice(1);
    const rest = trimBlank(item);
    if (rest.length === item.length || rest[0] !== '`') continue;
    const end = rest.indexOf('`', 1);
    if (end > 1) out.push(rest.slice(1, end));
  }
  return out;
}

// ---------------------------------------------------------------- transcript references

const lastAtOrBefore = (segments, t) => {
  let found = 0;
  segments.forEach((seg, i) => { if (Number(seg.start) <= t) found = i; });
  return found;
};

/** The transcript line a note's `[hh:mm]` (as the notes input numbers the transcript: the first
 *  line said in that minute) or `[hh:mm:ss]` reference points at; -1 when there is none. */
export function lineAt(segments, ref) {
  const parts = String(ref ?? '').split(':').map(Number);
  if (!segments?.length || parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isInteger(n) || n < 0)) return -1;
  if (parts.length === 2) {
    const from = parts[0] * 3600 + parts[1] * 60;
    const i = segments.findIndex(seg => Number(seg.start) >= from && Number(seg.start) < from + 60);
    return i >= 0 ? i : lastAtOrBefore(segments, from);
  }
  return lastAtOrBefore(segments, parts[0] * 3600 + parts[1] * 60 + parts[2]);
}

// ---------------------------------------------------------------- hash (R6)

/** The app's routes, as hashes name them. */
export const HASH_ROUTES = ['today', 'calendar', 'meetings', 'tasks', 'inbox', 'automations', 'settings'];

/** `#/route/tab`, and `#/meetings/<encoded id>/<tab>` for a meeting: `{route, meetingId, tab}`;
 *  an unknown route is Today, an empty hash `route: null`. */
export function parseHash(hash) {
  const raw = String(hash ?? '').replace(/^#\/?/, '');
  if (!raw) return { route: null, meetingId: null, tab: null };
  const [head, a, b] = raw.split('/');
  const route = HASH_ROUTES.includes(head) ? head : 'today';
  if (route !== 'meetings') return { route, meetingId: null, tab: a || null };
  let meetingId = null;
  try {
    meetingId = a ? decodeURIComponent(a) : null;
  } catch {
    meetingId = null;
  }
  return { route, meetingId, tab: TABS.includes(b) ? b : null };
}

export const meetingHash = (id, tab) => (id ? `#/meetings/${encodeURIComponent(id)}/${TABS.includes(tab) ? tab : 'notes'}` : '#/meetings');
