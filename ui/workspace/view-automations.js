// Automations (DESIGN 6.6): the list, the editor, the Run log, the templates and Today's
// Automation results card. Pure HTML renderers and form logic, so node:test can import them.
//
// Run output is rendered only from `output.summaryBlocks` (ruling R26): every text is escaped,
// a link gets an address only from a block's `href` and opens through native by its index;
// `summaryMarkdown` is never parsed here (only copied).
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { badge, button, card, checkbox, emptyState, field, select, textArea, textInput, toggle } from './ui.js';
import { records } from './selectors.js';
import { agoLabel, dateFromKey, dayKey, formatDateTime, formatTime, zonedParts } from './format.js';
import { draftError, modelLabel, profileName, providerLabel } from './draft-state.js';
import { activateTab, normalizeDock, visibleTabs } from './dock-model.js';
import { renderDock } from './dock-view.js';

/** The page's tabs as the hash names them (`#/automations/<tab>`), with their section tab. */
export const AUTOMATION_TABS = [['automations', 'auto-list'], ['runs', 'auto-runs'], ['templates', 'auto-templates']];
/** Automations' sections (spec "Page sections"): the list, pinned to Today as "Automation
 *  results" (the `automations` widget), the Run log and the templates, in one section at first. */
export const AUTOMATIONS_DOCK = {
  title: 'Automations',
  tabs: {
    'auto-list': { title: 'Automations', icon: 'automations', min: 420, w: 900, pin: 'automations', pinTitle: 'Automation results' },
    'auto-runs': { title: 'Run log', icon: 'history', min: 380, w: 600 },
    'auto-templates': { title: 'Templates', icon: 'spark', min: 380, w: 600 },
  },
  initial: [['auto-list', 'auto-runs', 'auto-templates']],
};
export const NAME_MAX = 80;
export const PROMPT_MAX = 4000;
export const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const PLURAL_DAYS = { 1: 'Mondays', 2: 'Tuesdays', 3: 'Wednesdays', 4: 'Thursdays', 5: 'Fridays', 6: 'Saturdays', 7: 'Sundays' };
export const EVENTS = [
  ['mail_from', 'Mail arrives from…'],
  ['chat_from', 'A Teams message arrives from…'],
  ['critical', 'A critical item arrives'],
  ['meeting_ended', 'A meeting ends'],
  ['meeting_ready', 'A meeting’s transcript is ready'],
];
/** Events a message starts (it has a sender and a conversation). */
const MESSAGE_EVENTS = new Set(['mail_from', 'chat_from', 'critical']);
/** The event of a summary automation: it makes a note template's document, no Claude run of its own. */
const SUMMARY_EVENT = 'meeting_ready';
/** Events that name meetings, not people: no senders, keywords match the title. */
const MEETING_EVENTS = new Set(['meeting_ended', SUMMARY_EVENT]);
/** Events whose message can get a prepared reply draft (the backend allows only these). */
const REPLY_EVENTS = new Set(['mail_from', 'chat_from']);

// ---------------------------------------------------------------- templates (DESIGN 6.6)

const WEEKDAYS = [1, 2, 3, 4, 5];
export const TEMPLATES = [
  {
    id: 'morning-brief', name: 'Morning briefing', iconName: 'coffee',
    description: 'Before work: budget requests, the replies you owe, what is late or due today and the meetings to prepare for.',
    automation: {
      name: 'Morning briefing', trigger: { kind: 'schedule', days: WEEKDAYS, time: '08:07' },
      read: { calendarToday: true, needsReply: true, commitmentsNotes: true },
      prompt: 'Write my morning briefing. First the budget requests that wait for me. Then the replies I owe: those that look handled first, then 1:1 chats, group chats, mail. Then what is late or due today. Then the meetings today that need preparation and why. End with what can wait and any FYI worth a line. Skip anything that needs nothing from me.',
      deliver: { today: true, notify: true }, catchUp: true,
    },
  },
  {
    id: 'inbox-triage', name: 'Inbox triage', iconName: 'inbox',
    description: 'Every message that needs your answer becomes a reply task. Messages that only inform are left alone.',
    automation: {
      name: 'Inbox triage', trigger: { kind: 'schedule', days: WEEKDAYS, time: '08:00' },
      read: { needsReply: true, commitmentsNotes: true },
      prompt: 'Go through the messages waiting for my reply. Make a reply task for each one that needs an answer or a decision from me; skip newsletters, notifications and messages that only inform. If an open reply task already looks answered by someone else in its thread, say so under handled. Summarise what came in, in two lines.',
      deliver: { today: true, createTasks: true }, catchUp: true,
    },
  },
  {
    id: 'commitments', name: 'Commitments', iconName: 'hand',
    description: 'Your promises become your tasks; other people’s promises become waiting tasks with their date.',
    automation: {
      name: 'Commitments', trigger: { kind: 'schedule', days: WEEKDAYS, time: '08:03' },
      read: { recentMessages: true, commitmentsNotes: true },
      prompt: 'Find the promises in these messages. When I promised something, make a task for me with the date I gave. When someone promised me something, make a waiting task for that person with the date they gave. Ignore vague talk such as "let’s catch up sometime". If something I was waiting for arrived, say so under handled.',
      deliver: { today: true, createTasks: true }, catchUp: true,
    },
  },
  {
    id: 'budget-reply', name: 'Budget request reply', iconName: 'chart',
    description: 'A budget request becomes a budget task and a reply draft for you to check and send.',
    automation: {
      name: 'Budget request reply', trigger: { kind: 'event', event: 'mail_from', senders: [], keywords: ['budget'] },
      read: { triggerConversation: true },
      prompt: 'This message is a budget request. Make one budget task named after the project and the amount asked. Draft my reply: confirm what I approve, or ask for what is missing, with my choices in square brackets. Don’t judge whether the project exists; I check that myself.',
      deliver: { today: true, notify: true, draftReply: true, createTasks: true }, catchUp: false,
    },
  },
  {
    id: 'formal-summary', name: 'Formal meeting summary', iconName: 'transcript',
    description: 'Each meeting with a transcript gets a Formal summary you can share. Built from the transcript with your note templates.',
    automation: {
      name: 'Formal meeting summary', trigger: { kind: 'event', event: SUMMARY_EVENT, senders: [], keywords: [] },
      read: {}, prompt: '', deliver: { meetingSummary: 'formal-summary' }, catchUp: false,
    },
  },
  {
    id: 'draft-replies', name: 'Draft replies to someone', iconName: 'reply',
    description: 'When mail arrives from the people you name, Claude prepares a reply on that conversation. You review and send it yourself.',
    automation: {
      name: 'Draft replies', trigger: { kind: 'event', event: 'mail_from', senders: [], keywords: [] },
      read: { triggerConversation: true, mailFromSenderDays: 7 },
      prompt: 'Draft a reply to the message that started this run. Answer each question it asks. Where you need a fact you don’t have, leave a gap in square brackets instead of guessing. Match the tone of the conversation.',
      deliver: { today: true, draftReply: true }, catchUp: false,
    },
  },
  {
    id: 'end-of-day', name: 'End-of-day wrap-up', iconName: 'check-circle',
    description: 'At the end of the workday: what is still waiting for you, what you promised and what to pick up first tomorrow.',
    automation: {
      name: 'End-of-day wrap-up', trigger: { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '17:30' },
      read: { calendarToday: true, needsReply: true, commitmentsNotes: true },
      prompt: 'Wrap up my day. List the replies still waiting for me and the commitments that are due or overdue. Then suggest the three things to pick up first tomorrow morning.',
      deliver: { today: true }, catchUp: false,
    },
  },
  {
    id: 'weekly-reflection', name: 'Weekly reflection', iconName: 'activity',
    description: 'On Friday afternoon: what moved this week, what is still open and what to carry into next week.',
    automation: {
      name: 'Weekly reflection', trigger: { kind: 'schedule', days: [5], time: '16:00' },
      read: { needsReply: true, commitmentsNotes: true },
      prompt: 'Help me close the week. From my commitments and notes, say what got done and what is still open. Name the replies I still owe. End with up to three priorities for next week.',
      deliver: { today: true }, catchUp: true,
    },
  },
];

// ---------------------------------------------------------------- words

const listOf = (values, joiner = 'or') => {
  if (values.length <= 2) return values.join(` ${joiner} `);
  return `${values.slice(0, 2).join(', ')} ${joiner} ${values.length - 2} more`;
};
const quoted = values => values.map(v => `“${v}”`).join(' or ');

/** "Weekdays", "Fridays", "Every day", "Mon, Wed and Fri". */
export function daysLabel(days = []) {
  const set = [...new Set(days.map(Number))].filter(d => d >= 1 && d <= 7).sort((a, b) => a - b);
  const key = set.join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '1,2,3,4,5,6,7') return 'Every day';
  if (key === '6,7') return 'Weekends';
  if (set.length === 1) return PLURAL_DAYS[set[0]];
  const short = set.map(d => DAYS[d - 1][1]);
  return short.length > 1 ? `${short.slice(0, -1).join(', ')} and ${short.at(-1)}` : 'No days';
}

/** The trigger as a sentence: "Weekdays at 08:45", "When mail arrives from @epam.com". */
export function triggerSummary(a) {
  const t = a?.trigger || {};
  if (t.kind !== 'event') return `${daysLabel(t.days)} at ${t.time || '--:--'}`;
  const senders = listOf(t.senders || []);
  const about = (t.keywords || []).length ? ` about ${quoted(t.keywords)}` : '';
  switch (t.event) {
    case 'chat_from': return `When a Teams message arrives from ${senders || 'the people you name'}${about}`;
    case 'critical': return `When a critical item arrives${senders ? ` from ${senders}` : ''}${about}`;
    case 'meeting_ended': return `When a meeting${about} ends`;
    case SUMMARY_EVENT: return about ? `When the transcript of a meeting${about} is ready` : 'When a meeting’s transcript is ready';
    default: return `When mail arrives from ${senders || 'the people you name'}${about}`;
  }
}

const DELIVER_LABELS = [['today', 'Today'], ['notify', 'Notification'], ['draftReply', 'Reply draft'], ['createTasks', 'Tasks']];
const DELIVER_WORDS = { today: () => 'Today', notify: () => 'a notification', draftReply: () => 'a reply draft', createTasks: provider => `tasks in ${provider}` };

/** The name of the note template a summary automation makes ("Formal summary"). */
const templateName = (id, templates = []) => templates.find(t => t.id === id)?.name || 'meeting summary';

/** The active task provider's name ("Todoist"); Connect's own without one. */
export const providerNameOf = s => s?.taskProvider?.name || 'Connect';

/** "Delivers to Today and tasks in Todoist." / "Makes a Formal summary for each meeting." */
export function deliveriesSentence(deliver = {}, providerName = 'Connect', templates = []) {
  if (deliver.meetingSummary) return `Makes a ${templateName(deliver.meetingSummary, templates)} for each meeting.`;
  const words = Object.keys(DELIVER_WORDS).filter(key => deliver[key]).map(key => DELIVER_WORDS[key](providerName));
  if (!words.length) return 'Kept in the Run log only.';
  return `Delivers to ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]}.`;
}

/** When a schedule runs next, in the workspace zone: "Today 17:30", "Tomorrow 08:45", "Fri 16:00". */
export function nextRunLabel(a, zone, nowMs = Date.now()) {
  const t = a?.trigger || {};
  if (t.kind === 'event' || !/^\d{2}:\d{2}$/.test(t.time || '') || !(t.days || []).length) return '';
  const [hh, mm] = t.time.split(':').map(Number);
  const p = zonedParts(nowMs, zone);
  const today = dateFromKey(dayKey(nowMs, zone));
  for (let i = 0; i < 8; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const weekday = ((d.getDay() + 6) % 7) + 1;
    if (!t.days.map(Number).includes(weekday) || (i === 0 && hh * 60 + mm <= p.hour * 60 + p.minute)) continue;
    return `${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DAYS[weekday - 1][1]} ${t.time}`;
  }
  return '';
}

/** "$0.02" for CodeMie; "≈ $0.02" for a subscription, whose figure is Claude Code's estimate. */
export function costLabel(cost, profile) {
  if (cost == null || !Number.isFinite(Number(cost))) return '';
  const n = Number(cost);
  const text = `$${n > 0 && n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`;
  return String(profile || '').startsWith('codemie:') ? text : `≈ ${text}`;
}
const costTitle = profile => (String(profile || '').startsWith('codemie:') ? 'Cost reported by CodeMie' : 'Claude Code’s estimate. Your subscription covers it.');

/** "900 ms", "3.1 s", "1 min 5 s". */
export function durationText(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

// ---------------------------------------------------------------- snapshot projections

/** The saved automations, by name. */
export const automationList = s => records(s, 'automation').slice().sort((a, b) => String(a.data.name).localeCompare(String(b.data.name)));
const started = run => Number(run?.data?.startedAt) || 0;
const newest = runs => runs.sort((a, b) => started(b) - started(a) || (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
/** The latest run of an automation the snapshot carries (any status). */
export const latestRun = (s, id) => newest(records(s, 'automation_run').filter(r => r.data.automationId === id));
/** The latest run of an automation that went to Today. */
export const latestTodayRun = (s, id) => newest(records(s, 'automation_run').filter(r => r.data.automationId === id && (r.data.delivered || []).includes('today')));
/** The queued or running run of an automation. */
export const activeRun = (s, id) => s.jobs.find(j => j.kind === 'automation_run' && j.payload?.automationId === id && ['queued', 'running'].includes(j.state)) || null;

const STATUS = { ok: ['Done', 'success'], failed: ['Failed', 'error'], skipped: ['Skipped', 'neutral'], cancelled: ['Stopped', 'neutral'] };
const statusBadge = run => badge(...(STATUS[run.data.status] || [run.data.status || 'Unknown', 'neutral']));

const EVENT_RUN = { mail_from: 'Mail', chat_from: 'Teams message', critical: 'Critical item', meeting_ended: 'Meeting ended', meeting_ready: 'Transcript ready' };
/** What started a run: "Run now", "Schedule · 08:45", "Mail from Ann Lee", "Meeting ended · Planning". */
export function runTrigger(run, s) {
  const t = run.data.trigger || {};
  const zone = s?.settings?.timeZone;
  if (t.kind === 'manual') return 'Run now';
  if (t.kind === 'schedule') return `Schedule · ${formatTime(t.scheduledAt || run.data.startedAt, zone)}`;
  if (t.kind === 'catch_up') return `Catch-up for ${formatTime(t.scheduledAt || run.data.startedAt, zone)}`;
  const label = EVENT_RUN[t.event] || 'Event';
  const source = t.sourceId && s?.records.find(r => r.id === t.sourceId && ['message', 'event', 'meeting'].includes(r.kind));
  if (source?.kind === 'message' && source.data.from) return `${label} from ${source.data.from}`;
  const title = source?.data.title || (run.data.sources || []).find(x => x.id === t.sourceId)?.title;
  return title ? `${label} · ${title}` : label;
}

// ---------------------------------------------------------------- output (summary blocks, items, sources)

const WEB = /^https?:\/\//i;

function inlinesHtml(inlines, runId, nextLink) {
  return (inlines || []).map(inline => {
    let html = e(inline.text).replace(/\n/g, '<br>');
    if (inline.italic) html = `<em>${html}</em>`;
    if (inline.bold) html = `<strong>${html}</strong>`;
    if (inline.href == null) return html;
    // Native counts every link in the same order, so the index always names this one. A button,
    // never an <a href>: nothing can navigate the app window to an address Claude wrote.
    const n = nextLink();
    if (!WEB.test(String(inline.href))) return html;
    return `<button type="button" class="ws-run-link" data-action="run-link" data-id="${e(runId)}" data-link="${n}" title="${e(inline.href)}">${html}</button>`;
  }).join('');
}

/** The run's summary from its blocks: headings, paragraphs and bullet lists. `limit` blocks at most. */
export function summaryHtml(run, limit = Infinity) {
  const blocks = run.data.output?.summaryBlocks || [];
  let links = 0;
  const nextLink = () => links++;
  const out = [];
  let list = [];
  const flush = () => { if (list.length) out.push(`<ul class="ws-run-bullets">${list.join('')}</ul>`); list = []; };
  blocks.forEach((b, i) => {
    const html = inlinesHtml(b.inlines, run.id, nextLink);
    if (i >= limit) return;
    if (b.type === 'item') return list.push(`<li>${html}</li>`);
    flush();
    out.push(b.type === 'heading' ? `<h4 class="ws-run-heading">${html}</h4>` : `<p>${html}</p>`);
  });
  flush();
  return out.length ? `<div class="ws-run-summary-text">${out.join('')}</div>` : '';
}

const SOURCE_ICON = { message: 'mail', event: 'calendar', commitment: 'check-circle', note: 'note' };
const SOURCE_KIND = { message: 'Message', event: 'Meeting', commitment: 'Commitment', note: 'Note' };

/** A source as a chip: a message or meeting still in Connect opens there; others are plain. */
export function sourceChip(source, s) {
  const kind = source.kind || 'message';
  const iconName = kind === 'message' && source.channel === 'chat' ? 'chat' : SOURCE_ICON[kind] || 'info';
  const title = source.title || SOURCE_KIND[kind] || 'Source';
  const label = `${icon(iconName)}<span>${e(title)}</span>`;
  const present = s?.records.some(r => r.id === source.id && r.kind === kind);
  if (present && kind === 'message') return `<button type="button" class="ws-source-chip" data-action="open-message" data-id="${e(source.id)}" title="Open in the Inbox">${label}</button>`;
  if (present && kind === 'event') return `<button type="button" class="ws-source-chip" data-action="event" data-id="${e(source.id)}" title="Open the meeting">${label}</button>`;
  if (present) return `<span class="ws-source-chip ws-source-local" title="${e(SOURCE_KIND[kind] || 'Source')} on Today">${label}</span>`;
  return `<span class="ws-source-chip ws-source-gone" title="No longer in Connect">${label}</span>`;
}

/** The run's items, each with the source Claude cited (when it is one Connect gave it). */
export function itemsHtml(run, s, limit = Infinity) {
  const sources = run.data.sources || [];
  const items = (run.data.output?.items || []).slice(0, limit);
  if (!items.length) return '';
  return `<ul class="ws-run-items">${items.map(item => {
    const source = item.sourceId && sources.find(x => x.id === item.sourceId);
    return `<li><span class="ws-run-item-text">${e(item.text).replace(/\n/g, '<br>')}</span>${source ? sourceChip(source, s) : ''}</li>`;
  }).join('')}</ul>`;
}

/** Title, summary Markdown and items as plain text, for Copy. */
export function outputText(run) {
  const o = run?.data?.output;
  if (!o) return '';
  const items = (o.items || []).map(i => `- ${i.text}`).join('\n');
  return [o.title, o.summaryMarkdown, items].filter(Boolean).join('\n\n');
}

/** One sentence and one action for a run that failed (DESIGN 6.2, shared with drafts). */
export function runError(run, ai = {}) {
  const err = run.data.error;
  if (!err) return null;
  if (err.class) {
    const job = { id: run.id, state: 'failed', errorClass: err.class, errorCode: err.code, payload: { profile: run.data.profile, purpose: 'automation', automationId: run.data.automationId } };
    return draftError(job, { profiles: ai.profiles, settings: ai.settings, kind: 'automation' });
  }
  // Not Claude: the run could not read Microsoft 365, or storage failed. The stored sentence says what.
  if (err.code === 'needs_login') return { tone: 'warning', sentence: err.message, action: { label: 'Open Microsoft 365 settings', action: 'settings-tab', iconName: 'settings', attrs: { 'data-tab': 'microsoft' } } };
  return { tone: 'error', sentence: err.message || 'The automation could not run.', action: { label: 'Run again', action: 'automation-run', iconName: 'refresh', attrs: { 'data-id': run.data.automationId } } };
}

function errorBox(failure) {
  const { tone, sentence, action } = failure;
  return `<div class="ws-run-error ws-draft-error ws-draft-tone-${tone}" role="status">
      ${icon(tone === 'error' ? 'alert' : tone === 'info' ? 'spark' : 'info')}
      <p><strong>${e(sentence)}</strong></p>
      ${action ? `<div class="ws-draft-error-actions">${button(action.label, { action: action.action, iconName: action.iconName, size: 'sm', attrs: action.attrs })}</div>` : ''}
    </div>`;
}

const DELIVERED = { today: 'Today', notification_queued: 'Notification', draft: 'Reply draft', tasks: 'Tasks', meeting_summary: 'the meeting' };

/** "Tasks: 2 made in Todoist, 1 already there", "Tasks: none needed"; '' for a run that made no tasks. */
export function tasksLine(run, providerName = 'Connect') {
  const t = run?.data?.tasks;
  if (!t) return '';
  const made = (t.made || []).length;
  const existing = Number(t.existing) || 0;
  if (!made && !existing) return 'Tasks: none needed';
  return `Tasks: ${made} made in ${providerName}${existing ? `, ${existing} already there` : ''}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a run made: its tasks (each a link to Tasks), what was left out and flagged; for a
 *  summary run, the meeting. */
function madeHtml(run, s) {
  const d = run.data;
  const parts = [];
  const line = tasksLine(run, providerNameOf(s));
  if (line) {
    const t = d.tasks;
    // "already there" counts every key that had a task, including one deleted or finished.
    parts.push(`<p class="ws-run-tasks-line"${t.existing ? ' title="Made by an earlier run. A task you deleted or finished counts here too, and is never made again."' : ''}>${e(line)}</p>`);
    const made = t.made || [];
    if (made.length) {
      parts.push(`<ul class="ws-run-made">${made.map(x => `<li><a class="ws-run-task" href="#/tasks" data-action="task-open-today" data-id="${e(x.id)}">${e(x.text)}<span aria-hidden="true"> ›</span></a></li>`).join('')}</ul>`);
    }
    if (t.dropped) parts.push(`<p class="ws-muted ws-hint">${e(`${t.dropped} left out (no message given)`)}</p>`);
  }
  if (d.handled > 0) parts.push(`<p class="ws-run-tasks-line">${e(`Looks handled: ${plural(d.handled, 'task')} flagged`)}</p>`);
  const meeting = d.meetingId && s?.records.find(r => r.id === d.meetingId && (r.kind === 'meeting' || r.kind === 'event'));
  if (meeting) parts.push(`<p><a class="ws-run-task" href="#/meetings/${e(encodeURIComponent(d.meetingId))}/summary" data-action="meeting-open" data-id="${e(d.meetingId)}">Open meeting<span aria-hidden="true"> ›</span></a></p>`);
  return parts.length ? `<div class="ws-run-made-block">${parts.join('')}</div>` : '';
}

function runDetail(run, s, ai) {
  const d = run.data;
  const parts = [];
  const failure = d.status === 'failed' ? runError(run, ai) : null;
  if (failure) parts.push(errorBox(failure));
  if (d.status === 'skipped') parts.push(`<p class="ws-inline-note">${icon('info')}<span>${e(d.reason || 'This run was skipped.')}</span></p>`);
  if (d.output) {
    parts.push(`<div class="ws-run-output">
      <h3 class="ws-run-title">${e(d.output.title || 'Result')}</h3>
      ${summaryHtml(run)}
      ${itemsHtml(run, s)}
    </div>`);
  }
  const sources = d.sources || [];
  if (sources.length) parts.push(`<div class="ws-run-sources"><span class="ws-field-label">Read · ${sources.length} source${sources.length === 1 ? '' : 's'}</span><div class="ws-chips">${sources.map(x => sourceChip(x, s)).join('')}</div></div>`);
  parts.push(madeHtml(run, s));
  const delivered = (d.delivered || []).map(x => DELIVERED[x] || x);
  const meta = [
    d.profile ? `${profileName(d.profile)}${d.model ? ` · ${modelLabel(d.model)}` : ''}` : '',
    delivered.length ? `Delivered to ${delivered.join(', ')}` : d.status === 'ok' ? 'Kept in the Run log only' : '',
  ].filter(Boolean);
  const draftSource = d.draftId && d.trigger?.sourceId && s?.records.some(r => r.kind === 'message' && r.id === d.trigger.sourceId);
  const exists = s?.records.some(r => r.kind === 'automation' && r.id === d.automationId);
  parts.push(`<footer class="ws-run-foot">
      <span class="ws-muted ws-hint">${meta.map(e).join(' · ')}</span>
      <span class="ws-actions">
        ${draftSource ? button('Open reply draft', { action: 'open-message', size: 'sm', iconName: 'reply', attrs: { 'data-id': d.trigger.sourceId } }) : ''}
        ${d.output ? button('Copy output', { action: 'run-copy', size: 'sm', iconName: 'copy', attrs: { 'data-id': run.id } }) : ''}
        ${exists ? button('Edit automation', { action: 'automation-edit', size: 'sm', variant: 'ghost', iconName: 'edit', attrs: { 'data-id': d.automationId } }) : ''}
      </span>
    </footer>`);
  return parts.join('');
}

function runRow(run, { s, open, ai }) {
  const d = run.data;
  const zone = s?.settings?.timeZone;
  const name = s?.records.find(r => r.kind === 'automation' && r.id === d.automationId)?.data.name || d.automationName || 'Automation';
  const cost = costLabel(d.costUsd, d.profile);
  return `<article class="ws-run${open ? ' ws-open' : ''}">
    <button type="button" class="ws-run-row" data-action="run-toggle" data-id="${e(run.id)}" aria-expanded="${open}"${open ? ` aria-controls="run-${e(run.id)}"` : ''}>
      <time class="ws-run-time" title="${e(formatDateTime(d.startedAt, zone))}">${e(formatDateTime(d.startedAt, zone))}</time>
      <span class="ws-run-what"><strong>${e(name)}</strong><span>${e(runTrigger(run, s))}</span></span>
      <span class="ws-run-status">${statusBadge(run)}</span>
      <span class="ws-run-num">${e(durationText(d.durationMs))}</span>
      <span class="ws-run-num"${cost ? ` title="${e(costTitle(d.profile))}"` : ''}>${e(cost || '—')}</span>
      ${icon('chevron-down', 'ws-run-caret')}
    </button>
    ${open ? `<div class="ws-run-detail" id="run-${e(run.id)}">${runDetail(run, s, ai)}</div>` : ''}
  </article>`;
}

/** Runs as rows; the ids in `expanded` show their output, sources and error. */
export function runLog(runs, { s, expanded = [], ai = {}, next = null, loading = false } = {}) {
  return `<div class="ws-card ws-run-log">
    <div class="ws-run-head" aria-hidden="true"><span>When</span><span>Automation · trigger</span><span>Status</span><span>Duration</span><span>Cost</span><span></span></div>
    ${runs.map(run => runRow(run, { s, open: expanded.includes(run.id), ai })).join('')}
    ${next ? `<div class="ws-run-more">${button(loading ? 'Loading…' : 'Load older runs', { action: 'automation-runs-more', disabled: loading })}</div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- the page

/** The Automations page: its heading, then its sections as `ctx.dock` (`{layouts, locked}`) has
 *  them; without a stored layout, the designed one showing the tab chosen last. */
export function automations(s, ctx = {}) {
  const ui = ctx.state?.automations || {};
  const tab = AUTOMATION_TABS.find(([id]) => id === ui.tab)?.[1] || 'auto-list';
  const layout = ctx.dock?.layouts?.automations || activateTab(normalizeDock(AUTOMATIONS_DOCK, null), tab);
  const list = automationList(s);
  const panels = {
    'auto-list': () => listPanel(s, list, ui.highlight),
    'auto-runs': () => runsPanel(s, list, ui.runs || {}, ctx.state?.ai),
    'auto-templates': () => templatesPanel(s),
  };
  // The empty list offers its own two buttons; the heading doesn't repeat one of them.
  const heading = visibleTabs(layout).includes('auto-list') && !list.length ? '' : button('New automation', { action: 'automation-new', variant: 'primary', iconName: 'plus' });
  return `<div class="ws-automations">
    <header class="ws-page-heading">
      <div>
        <h1>Automations</h1>
        <p class="ws-description">Claude reads only what you tick, on a schedule or when something arrives, and leaves the result on Today, in a notification or as a reply draft. Automations never send anything.</p>
      </div>
      <div class="ws-actions">${heading}</div>
    </header>
    ${ctx.banners || ''}
    ${renderDock('automations', AUTOMATIONS_DOCK, layout, id => `<div class="ws-auto-panel">${panels[id]()}</div>`, { locked: !!ctx.dock?.locked, count: id => (id === 'auto-list' ? list.length : null) })}
  </div>`;
}

function listPanel(s, list, highlight) {
  if (!list.length) {
    return card({
      className: 'ws-auto-empty',
      body: emptyState({
        iconName: 'automations', title: 'No automations yet',
        text: 'Start from a template such as Morning briefing, or build your own. Each run reads only what you tick and never sends anything.',
        actions: `${button('Start from a template', { action: 'automations-tab', variant: 'primary', iconName: 'spark', attrs: { 'data-tab': 'templates' } })}${button('New automation', { action: 'automation-new', variant: 'secondary', iconName: 'plus' })}`,
      }),
    });
  }
  return `<div class="ws-card ws-auto-list" role="list">${list.map(a => automationRow(s, a, a.id === highlight)).join('')}</div>`;
}

function automationRow(s, rec, highlight = false) {
  const a = { ...rec.data, id: rec.id };
  const zone = s.settings.timeZone;
  const job = activeRun(s, a.id);
  const run = latestRun(s, a.id);
  const delivers = a.deliver?.meetingSummary
    ? [['meetingSummary', templateName(a.deliver.meetingSummary, s.noteTemplates)]]
    : DELIVER_LABELS.filter(([key]) => a.deliver?.[key] && (key !== 'draftReply' || REPLY_EVENTS.has(a.trigger?.event)));
  let last = '<span class="ws-muted">Not run yet</span>';
  if (job) {
    last = `${badge(job.state === 'running' ? 'Running' : 'Queued', 'info')}<span class="ws-muted">${job.state === 'running' ? 'Claude is working…' : 'Starts shortly'}</span>`;
  } else if (run) {
    const cost = costLabel(run.data.costUsd, run.data.profile);
    const why = run.data.error?.message || run.data.reason || '';
    last = `<button type="button" class="ws-auto-last-run" data-action="automation-runs-of" data-id="${e(a.id)}" title="${e(why || 'Open in the Run log')}">${statusBadge(run)}<span>${e(agoLabel(run.data.startedAt, zone))}</span>${cost ? `<span class="ws-muted" title="${e(costTitle(run.data.profile))}">${e(cost)}</span>` : ''}</button>`;
  }
  const menuItem = (action, iconName, label, extra = '') => `<button type="button" class="ws-menu-item${extra}" data-action="${action}" data-id="${e(a.id)}">${icon(iconName)}<span>${label}</span></button>`;
  const next = a.enabled ? nextRunLabel(a, zone) : '';
  return `<div class="ws-auto-row${a.enabled ? '' : ' ws-off'}${highlight ? ' ws-auto-highlight' : ''}" role="listitem" data-automation="${e(a.id)}">
    ${toggle({ action: 'automation-toggle', checked: !!a.enabled, attrs: { 'data-id': a.id, 'aria-label': `${a.name}: ${a.enabled ? 'on' : 'off'}` } })}
    <div class="ws-auto-main">
      <button type="button" class="ws-link-title ws-auto-name" data-action="automation-edit" data-id="${e(a.id)}">${e(a.name || 'Untitled automation')}</button>
      <span class="ws-auto-meta"><span class="ws-auto-trigger">${icon(a.trigger?.kind === 'event' ? 'bell' : 'clock')}<span>${e(triggerSummary(a))}</span></span>${delivers.length ? `<span class="ws-auto-deliver">${icon('arrow')}<span>${e(delivers.map(([, label]) => label).join(' · '))}</span></span>` : ''}${next ? `<span class="ws-auto-next">Next: ${e(next)}</span>` : ''}</span>
    </div>
    <div class="ws-auto-last" aria-label="Last run">${last}</div>
    <div class="ws-auto-actions">
      ${button('Run now', { action: 'automation-run', iconName: 'play', disabled: !!job, title: job ? 'This automation is running' : 'Run it once now', attrs: { 'data-id': a.id } })}
      <details class="ws-menu ws-menu-right" data-menu="automation-${e(a.id)}"><summary class="ws-btn ws-btn-ghost ws-btn-icon" aria-label="More for ${e(a.name)}" title="More">${icon('dots')}</summary><div class="ws-menu-panel">
        ${menuItem('automation-edit', 'edit', 'Edit')}
        ${menuItem('automation-duplicate', 'copy', 'Duplicate')}
        ${menuItem('automation-runs-of', 'list', 'Run log')}
        <hr>
        ${menuItem('automation-delete', 'trash', 'Delete', ' ws-menu-danger')}
      </div></details>
    </div>
  </div>`;
}

function runsPanel(s, list, ui, ai) {
  const filter = select([['', 'All automations'], ...list.map(r => [r.id, r.data.name])], ui.filter || '', { name: 'auto-runs-filter', 'data-action': 'automation-runs-filter', 'aria-label': 'Show the runs of' });
  const toolbar = `<div class="ws-auto-toolbar">${filter}<span class="ws-muted ws-hint">Runs are kept for 90 days, up to 200 per automation.</span><span class="ws-spacer"></span>${button('Refresh', { action: 'automation-runs-refresh', variant: 'ghost', iconName: 'refresh' })}</div>`;
  let body;
  if (ui.error) body = card({ body: `<p class="ws-inline-note ws-error">${icon('alert')}<span>${e(ui.error)}</span></p>${button('Try again', { action: 'automation-runs-refresh', iconName: 'refresh' })}` });
  else if (!ui.items) body = card({ body: `<div class="ws-auto-loading"><span class="ws-spinner" role="status" aria-label="Loading runs"></span>Loading runs…</div>` });
  else if (!ui.items.length) {
    body = card({ body: emptyState({ iconName: 'list', title: 'No runs yet', text: ui.filter ? 'This automation hasn’t run yet. Use Run now to try it.' : 'Every run appears here with what it read, what it produced and what it cost.' }) });
  } else body = runLog(ui.items, { s, expanded: ui.expanded || [], ai, next: ui.next, loading: !!ui.loadingMore });
  return `${toolbar}${body}`;
}

function templatesPanel(s) {
  const provider = providerNameOf(s);
  return `<div class="ws-auto-templates">${TEMPLATES.map(t => {
    const a = t.automation;
    return `<article class="ws-card ws-auto-template">
      <div class="ws-auto-template-head"><span class="ws-card-icon">${icon(t.iconName)}</span><div><h2>${e(t.name)}</h2><p class="ws-auto-trigger">${icon(a.trigger.kind === 'event' ? 'bell' : 'clock')}<span>${e(triggerSummary(a))}</span></p></div></div>
      <p class="ws-auto-template-text">${e(t.description)}</p>
      <p class="ws-muted ws-hint">${e(deliveriesSentence(a.deliver, provider, s?.noteTemplates))}</p>
      <div class="ws-actions">${button('Use template', { action: 'automation-template', variant: 'primary', attrs: { 'data-id': t.id } })}</div>
    </article>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------- Today: Automation results

/**
 * Today's card: the latest result on Today of each automation, newest first. When a newer run
 * failed or was skipped, a line above the result says so; an automation whose only runs failed
 * shows that line alone. `ai` is the `ai_status` answer, for the failure's action.
 */
export function automationResultsCard(s, ai = {}, { failuresOnly = false } = {}) {
  const zone = s.settings.timeZone;
  const results = automationList(s)
    .map(a => {
      const run = latestTodayRun(s, a.id);
      const latest = latestRun(s, a.id);
      const problem = latest && latest.id !== run?.id && ['failed', 'skipped'].includes(latest.data.status) && started(latest) >= started(run) ? latest : null;
      return { a, run, problem };
    })
    .filter(x => (x.run || x.problem) && (!failuresOnly || [x.run, x.problem].some(r => r?.data.status === 'failed')))
    .sort((x, y) => started(y.problem || y.run) - started(x.problem || x.run))
    .slice(0, 4);
  const body = results.length
    ? `<div class="ws-auto-results">${results.map(x => resultItem(x, s, zone, ai)).join('')}</div>`
    : emptyState({ iconName: 'automations', title: 'Automation results land here', text: 'Morning briefing and your other automations leave their latest result on Today.', actions: button('Open Automations', { action: 'route', variant: 'primary', attrs: { 'data-route': 'automations' } }) });
  return card({
    title: 'Automation results', iconName: 'automations', className: 'ws-auto-card',
    actions: results.length ? button('Automations', { action: 'route', variant: 'ghost', iconRight: 'arrow', attrs: { 'data-route': 'automations' } }) : '',
    body,
  });
}

/** "Latest run failed 5 min ago: Claude Code isn't signed in." with its action and its own Open run. */
function problemLine(a, problem, zone, ai) {
  const when = agoLabel(problem.data.startedAt, zone);
  const failed = problem.data.status === 'failed';
  const failure = failed ? runError(problem, ai) : null;
  const sentence = failed ? failure?.sentence || 'The automation could not run.' : problem.data.reason || 'Nothing needed this run.';
  const tone = failed ? failure?.tone || 'error' : 'info';
  const action = failure?.action;
  return `<div class="ws-auto-problem ws-draft-error ws-draft-tone-${tone}" role="status">
      ${icon(failed ? 'alert' : 'info')}
      <p><strong>Latest run ${failed ? 'failed' : 'was skipped'} ${e(when)}:</strong> ${e(sentence)}</p>
      <div class="ws-draft-error-actions">${action ? button(action.label, { action: action.action, iconName: action.iconName, size: 'sm', attrs: action.attrs }) : ''}${button('Open run', { action: 'automation-open-run', variant: 'ghost', size: 'sm', iconRight: 'arrow', title: 'Open this run in the Run log', attrs: { 'data-id': problem.id, 'data-automation': a.id } })}</div>
    </div>`;
}

function resultItem({ a, run, problem }, s, zone, ai) {
  const out = run?.data.output || {};
  const items = out.items || [];
  const shown = !run ? '' : items.length ? itemsHtml(run, s, 3) : summaryHtml(run, 3);
  const more = items.length > 3 ? `<span class="ws-muted ws-hint">${items.length - 3} more in the run</span>` : '';
  const made = (run?.data.tasks?.made || []).length;
  const tasks = made ? `<a class="ws-run-task ws-auto-made" href="#/tasks" data-action="route" data-route="tasks">${e(`Made ${plural(made, 'task')} in ${providerNameOf(s)} ›`)}</a>` : '';
  return `<article class="ws-auto-result">
    <header class="ws-auto-result-head"><span class="ws-auto-result-name">${e(a.data.name)}</span>${run ? `<time title="${e(formatDateTime(run.data.startedAt, zone))}">${e(agoLabel(run.data.startedAt, zone))}</time>` : ''}</header>
    ${problem ? problemLine(a, problem, zone, ai) : ''}
    ${run ? `<h3>${e(out.title || 'Result')}</h3>${shown}${tasks}
    <footer class="ws-auto-result-foot">${more}<span class="ws-spacer"></span>${button('Open run', { action: 'automation-open-run', variant: 'ghost', size: 'sm', iconRight: 'arrow', attrs: { 'data-id': run.id, 'data-automation': a.id } })}</footer>` : ''}
  </article>`;
}

// ---------------------------------------------------------------- the editor

/**
 * The editor's state: every field of the form, including those of the trigger kind that is not
 * shown, so switching back and forth keeps what was typed. `toAutomation` makes the saved shape.
 */
export function draftFromAutomation(a = {}) {
  const t = a.trigger || {};
  const schedule = t.kind !== 'event';
  const r = a.read || {};
  const d = a.deliver || {};
  return {
    id: a.id || '', enabled: a.enabled !== false, name: a.name || '', kind: schedule ? 'schedule' : 'event',
    days: schedule && Array.isArray(t.days) ? t.days.map(Number) : [1, 2, 3, 4, 5],
    time: schedule && t.time ? t.time : '09:00',
    event: !schedule && EVENTS.some(([v]) => v === t.event) ? t.event : 'mail_from',
    senders: (t.senders || []).join(', '), keywords: (t.keywords || []).join(', '),
    read: { calendarToday: !!r.calendarToday, needsReply: !!r.needsReply, triggerConversation: !!r.triggerConversation, senderMail: (r.mailFromSenderDays || 0) > 0, commitmentsNotes: !!r.commitmentsNotes, recentMessages: !!r.recentMessages },
    prompt: a.prompt || '', profile: a.ai?.profile || '', model: a.ai?.model || '', cap: a.capUsd != null ? String(a.capUsd) : '',
    deliver: { today: !!d.today, notify: !!d.notify, draftReply: !!d.draftReply, createTasks: !!d.createTasks }, meetingSummary: d.meetingSummary || '', catchUp: !!a.catchUp,
  };
}

/** A blank automation: weekdays at 09:00, delivered to Today. */
export const newAutomationDraft = () => draftFromAutomation({ trigger: { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '09:00' }, deliver: { today: true } });

/** A copy of a saved automation that stays off until it is turned on. */
export function duplicateDraft(rec) {
  const draft = draftFromAutomation({ ...rec.data, id: '' });
  return { ...draft, id: '', enabled: false, name: `Copy of ${draft.name}`.slice(0, NAME_MAX) };
}

/** The editor's state from its form (a FormData). */
export function editorDraft(form) {
  const str = name => String(form.get(name) ?? '');
  const read = new Set(form.getAll('auto-read').map(String));
  const deliver = new Set(form.getAll('auto-deliver').map(String));
  const event = str('auto-event');
  return {
    id: str('auto-id'), enabled: str('auto-enabled') !== 'false', name: str('auto-name'),
    kind: str('auto-kind') === 'event' ? 'event' : 'schedule',
    days: form.getAll('auto-day').map(Number).filter(d => d >= 1 && d <= 7),
    time: str('auto-time'), event: EVENTS.some(([v]) => v === event) ? event : 'mail_from',
    senders: str('auto-senders'), keywords: str('auto-keywords'),
    read: { calendarToday: read.has('calendarToday'), needsReply: read.has('needsReply'), triggerConversation: read.has('triggerConversation'), senderMail: read.has('senderMail'), commitmentsNotes: read.has('commitmentsNotes'), recentMessages: read.has('recentMessages') },
    prompt: str('auto-prompt'), profile: str('auto-profile'), model: str('auto-model'), cap: str('auto-cap').trim(),
    deliver: { today: deliver.has('today'), notify: deliver.has('notify'), draftReply: deliver.has('draftReply'), createTasks: deliver.has('createTasks') },
    meetingSummary: str('auto-summary'), catchUp: form.has('auto-catchup'),
  };
}

const splitList = text => String(text || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);

/** A summary automation (event "A meeting's transcript is ready"): no Read, Claude or Claude deliveries. */
const isSummary = d => d.kind === 'event' && d.event === SUMMARY_EVENT;
/** The draft gives Claude messages to make tasks from (as the backend checks it). */
const readsMessages = d => !isSummary(d) && (!!d.read.needsReply || !!d.read.recentMessages
  || (d.kind === 'event' && MESSAGE_EVENTS.has(d.event) && (!!d.read.triggerConversation || (REPLY_EVENTS.has(d.event) && !!d.deliver.draftReply))));

/**
 * What `automation_save` gets: only what the trigger uses. A reply draft only for mail or Teams
 * messages, and then the triggering conversation is always read (the draft answers it).
 * Throws a sentence for a cost cap that is not a number; everything else the backend checks.
 */
export function toAutomation(d) {
  const event = d.kind === 'event';
  const summary = isSummary(d);
  if (summary) {
    // Reads nothing and runs no Claude of its own: only the template, the keywords and the wishes.
    return {
      id: d.id, name: d.name, enabled: d.enabled,
      trigger: { kind: 'event', event: SUMMARY_EVENT, senders: [], keywords: splitList(d.keywords) },
      read: { calendarToday: false, needsReply: false, triggerConversation: false, mailFromSenderDays: 0, commitmentsNotes: false, recentMessages: false },
      prompt: d.prompt, ai: { profile: null, model: null }, capUsd: null,
      deliver: { today: false, notify: false, draftReply: false, createTasks: false, meetingSummary: d.meetingSummary || null }, catchUp: false,
    };
  }
  const message = event && MESSAGE_EVENTS.has(d.event);
  const draftReply = event && REPLY_EVENTS.has(d.event) && !!d.deliver.draftReply;
  let capUsd = null;
  if (d.cap) {
    capUsd = Number(String(d.cap).replace(/^\$\s*/, '').replace(',', '.'));
    if (!Number.isFinite(capUsd)) throw Object.assign(new Error('Enter the cost cap in US dollars, for example 0.50.'), { code: 'validation', field: 'capUsd' });
  }
  return {
    id: d.id, name: d.name, enabled: d.enabled,
    trigger: event
      ? { kind: 'event', event: d.event, senders: MEETING_EVENTS.has(d.event) ? [] : splitList(d.senders), keywords: splitList(d.keywords) }
      : { kind: 'schedule', days: [...new Set(d.days)].sort((a, b) => a - b), time: d.time },
    read: {
      calendarToday: !!d.read.calendarToday, needsReply: !!d.read.needsReply,
      triggerConversation: event && (!!d.read.triggerConversation || draftReply),
      mailFromSenderDays: message && d.read.senderMail ? 7 : 0, commitmentsNotes: !!d.read.commitmentsNotes, recentMessages: !!d.read.recentMessages,
    },
    prompt: d.prompt, ai: { profile: d.profile || null, model: d.profile && d.model ? d.model : null }, capUsd,
    // Tasks only while the switch shows: a hidden one (nothing read gives messages) is kept in the form, not saved.
    deliver: { today: !!d.deliver.today, notify: !!d.deliver.notify, draftReply, createTasks: readsMessages(d) && !!d.deliver.createTasks, meetingSummary: null },
    catchUp: !event && !!d.catchUp,
  };
}

// Sentences of `automation_save` validation, by the field they are about. The backend names the
// field (`err.field`); these anchored patterns are for an answer without one.
const ERROR_FIELDS = [
  [/^Add at least one sender|^".*" is not an email address|^".*" is longer than a name|^Teams messages carry names|^Use up to 50 senders/, 'auto-senders'],
  [/^Give the automation a name/, 'auto-name'],
  [/^Write the instructions|^Instructions can be up to/, 'auto-prompt'],
  [/^Choose at least one day|^Days run from/, 'auto-days'],
  [/^Enter the time as/, 'auto-time'],
  [/^Use up to 20 keywords/, 'auto-keywords'],
  [/^Reply drafts are only available|^Tasks are made from messages|^A meeting summary|^Choose the template to make|^Choose a note template/, 'auto-deliver'],
  [/^Read the sender/, 'auto-read'],
  [/^The cost cap|^Enter the cost cap/, 'auto-cap'],
];
/** The editor field a validation sentence is about, or null for the form as a whole. */
export function fieldForError(message) {
  const text = String(message || '');
  return ERROR_FIELDS.find(([pattern]) => pattern.test(text))?.[1] || null;
}

/** Field names native puts on validation errors, as editor ids. */
const FIELD_IDS = { name: 'auto-name', prompt: 'auto-prompt', days: 'auto-days', time: 'auto-time', senders: 'auto-senders', keywords: 'auto-keywords', deliver: 'auto-deliver', read: 'auto-read', capUsd: 'auto-cap' };

/** Whether the editor shows the field `id` for this draft (a hidden or disabled one can't hold an error). */
export function fieldShown(draft, id, ai = {}) {
  const event = draft.kind === 'event';
  switch (id) {
    case 'auto-days': case 'auto-time': return !event;
    case 'auto-senders': return event && MESSAGE_EVENTS.has(draft.event);
    case 'auto-keywords': return event;
    case 'auto-read': return !isSummary(draft);
    case 'auto-cap': return !isSummary(draft) && !capOff(draft, ai);
    default: return true;
  }
}

/** Where to show a save error: `{field, message}` at a visible field, or null for the dialog's own error line. */
export function errorTarget(err, draft, ai = {}) {
  if (err?.code && err.code !== 'validation') return null;
  const field = FIELD_IDS[err?.field] || fieldForError(err?.message);
  return field && fieldShown(draft, field, ai) ? { field, message: err.message } : null;
}

/** A mail or Teams trigger still without senders (the Draft replies template starts so). */
export const needsSenders = draft => draft.kind === 'event' && REPLY_EVENTS.has(draft.event) && !String(draft.senders || '').trim();

const PROFILE_STATE = { not_installed: 'not installed', too_old: 'update needed', needs_login: 'sign in needed', not_configured: 'not set up', error: 'unavailable', checking: 'checking' };

/** The profile a run would use: the automation's own, else the Automations route, else the default. */
function effectiveProfile(draft, ai) {
  return draft.profile || ai?.settings?.routes?.automation?.profile || ai?.settings?.defaultProfile || '';
}
/** The cost cap only applies to CodeMie: off when the run is known to use Claude Code. */
function capOff(draft, ai) {
  const profile = effectiveProfile(draft, ai);
  return !!profile && !profile.startsWith('codemie:');
}

function aiSection(draft, ai, errorAt, hidden = false) {
  const profiles = ai?.profiles || [];
  const routeProfile = ai?.settings?.routes?.automation?.profile || ai?.settings?.defaultProfile || '';
  // Short enough for the half-width select: "Claude Code" or the CodeMie profile, "CodeMie · prod".
  const routeLabel = !routeProfile ? 'chosen on first use' : routeProfile.startsWith('codemie:') ? providerLabel(routeProfile, profiles) : profileName(routeProfile);
  const options = [['', `Default · ${routeLabel}`], ...profiles.map(p => [p.id, p.state === 'ready' || !PROFILE_STATE[p.state] ? p.label : `${p.label} (${PROFILE_STATE[p.state]})`])];
  if (draft.profile && !profiles.some(p => p.id === draft.profile)) options.push([draft.profile, `${draft.profile} (not found)`]);
  const chosen = profiles.find(p => p.id === draft.profile);
  let models = [['', 'Model of the default route']];
  if (draft.profile) {
    const native = chosen?.kind?.type === 'native' || draft.profile === 'claude';
    models = [['', native ? 'Account default' : `Profile default${chosen?.defaultModel ? ` (${chosen.defaultModel})` : ''}`], ...(chosen?.models || []).filter(m => m.id).map(m => [m.id, m.label])];
    if (draft.model && !models.some(([id]) => id === draft.model)) models.push([draft.model, draft.model]);
  }
  const effective = effectiveProfile(draft, ai);
  const off = capOff(draft, ai);
  const capHint = effective.startsWith('codemie:')
    ? 'Stops a run that would cost more, in US dollars. CodeMie passes it to Claude as --max-budget-usd.'
    : off ? 'Applies to CodeMie profiles only; Claude Code ignores it, so it is off. A cap you set is kept.' : 'Applies to CodeMie profiles only.';
  return `<fieldset class="ws-auto-section"${hidden ? ' hidden' : ''}><legend>Claude</legend>
    <div class="ws-form-row">
      ${field('Profile', select(options, draft.profile, { id: 'auto-profile', name: 'auto-profile', 'data-action': 'automation-form' }))}
      ${field('Model', select(models, draft.profile ? draft.model : '', { id: 'auto-model', name: 'auto-model', disabled: !draft.profile }))}
    </div>
    ${off ? `<input type="hidden" name="auto-cap" value="${e(draft.cap)}">` : ''}
    ${errorField('Cost cap per run (optional)', textInput({ id: 'auto-cap', name: off ? undefined : 'auto-cap', value: draft.cap, inputmode: 'decimal', placeholder: off ? 'Not used' : 'No cap', autocomplete: 'off', disabled: off, ...invalid('auto-cap', errorAt) }), capHint, 'auto-cap', errorAt)}
  </fieldset>`;
}

const invalid = (id, errorAt) => (errorAt?.field === id ? { 'aria-invalid': 'true', 'aria-describedby': `${id}-error` } : {});
const errorText = (id, errorAt) => (errorAt?.field === id ? `<p class="ws-field-error" id="${id}-error" role="alert">${e(errorAt.message)}</p>` : '');
function errorField(label, control, hint, id, errorAt) {
  return `<div class="ws-field-wrap">${field(label, control, hint)}${errorText(id, errorAt)}</div>`;
}

/** A switch with a one-line explanation under it (named by `hintId` as its description). */
function switchRow({ name, value, data, checked, label, hint, action, id, hintId }) {
  const attrs = { value };
  if (data) attrs[data[0]] = data[1];
  if (hintId) attrs['aria-describedby'] = hintId;
  return `<div class="ws-auto-switch">${toggle({ name, id, checked, action, label, attrs })}${hint ? `<small${hintId ? ` id="${hintId}"` : ''}>${e(hint)}</small>` : ''}</div>`;
}

const READS = {
  triggerConversation: ['The message that started it', 'And the conversation it belongs to, up to the newest 12 messages.'],
  meeting: ['The meeting that ended', 'Its title, time, place and attendees.'],
  senderMail: ['The sender’s mail from the last 7 days', 'Other Outlook messages from the same person.'],
  calendarToday: ['Today’s calendar', 'Your meetings today with times and places. Private events show only as busy.'],
  needsReply: ['Needs your reply', 'Outlook and Teams messages waiting for your answer.'],
  recentMessages: ['Messages since the last run', 'Mail and Teams messages, yours too, since this automation last ran (at most 3 days).'],
  commitmentsNotes: ['My commitments and notes', 'Open commitments and your notes from Today.'],
};

/**
 * The editor form. `ctx.zone` is the workspace time zone, `ctx.ai` the `ai_status` answer and
 * `ctx.error` `{field, message}` a sentence from the backend to show at its field.
 */
/** Reads that can give messages to make tasks from: ticking one redraws the Deliver switches. */
const TASK_READS = new Set(['needsReply', 'recentMessages', 'triggerConversation']);

/** The note templates a summary automation can make: Formal summary first, then the rest as in
 *  Settings › Meetings; a chosen one no longer there is named so. */
function summaryOptions(templates = [], chosen = '') {
  const formal = templates.filter(t => t.id === 'formal-summary');
  const options = [...formal, ...templates.filter(t => t.id !== 'formal-summary')].map(t => [t.id, t.name]);
  if (chosen && !options.some(([id]) => id === chosen)) options.push([chosen, `${chosen} (not found)`]);
  return options;
}

export function automationEditor(draft, { zone = 'UTC', ai = {}, error = null, providerName = 'Connect', templates = [] } = {}) {
  const event = draft.kind === 'event';
  const summary = isSummary(draft);
  const message = event && MESSAGE_EVENTS.has(draft.event);
  const replies = event && REPLY_EVENTS.has(draft.event);
  const lockConversation = replies && draft.deliver.draftReply;
  const provider = providerLabel(effectiveProfile(draft, ai), ai?.profiles || []);
  const readBox = (key, readKey = key, shown = true) => {
    const [label, hint] = READS[key];
    // Boxes that don't apply to this trigger stay in the form, hidden, so switching back keeps them.
    if (!shown) return `<div hidden>${checkbox({ name: 'auto-read', value: readKey, label, checked: !!draft.read[readKey], attrs: { 'data-read': readKey } })}</div>`;
    // A reply draft answers the triggering message, so that box is ticked and locked.
    if (readKey === 'triggerConversation' && lockConversation) {
      return `${checkbox({ name: 'auto-read', value: readKey, label, hint: 'A reply draft needs the message it answers, so it is always read.', checked: true, attrs: { 'data-read': readKey, disabled: true } })}<input type="hidden" name="auto-read" value="triggerConversation">`;
    }
    return checkbox({ name: 'auto-read', value: readKey, label, hint, checked: !!draft.read[readKey], action: TASK_READS.has(readKey) ? 'automation-form' : undefined, attrs: { 'data-read': readKey } });
  };
  const tasks = switchRow({ name: 'auto-deliver', value: 'createTasks', data: ['data-deliver', 'createTasks'], checked: draft.deliver.createTasks, label: `Tasks in ${providerName}`, hint: 'One task per message that needs it. A rerun, or a task you deleted or finished, never makes it again.', hintId: 'auto-tasks-hint' });
  const summaryChoice = draft.meetingSummary || 'formal-summary';
  const senderHint = {
    mail_from: ['From', 'Addresses or domains, separated by commas. For example ann@epam.com, @epam.com', 'name@epam.com, @epam.com'],
    chat_from: ['From', 'Names as Teams shows them, separated by commas. For example Ann Lee, Bob Stone', 'Ann Lee'],
    critical: ['Only from (optional)', 'Addresses, domains or Teams names. Leave it empty for every critical item.', 'name@epam.com, Ann Lee'],
  }[draft.event] || ['From', '', ''];
  const count = draft.prompt.length;
  return `<input type="hidden" name="auto-id" value="${e(draft.id)}">
    <input type="hidden" name="auto-enabled" value="${draft.enabled ? 'true' : 'false'}">
    <input type="hidden" name="auto-kind" value="${event ? 'event' : 'schedule'}">
    ${errorField('Name', textInput({ id: 'auto-name', name: 'auto-name', value: draft.name, maxlength: NAME_MAX, placeholder: 'e.g. Morning brief', autocomplete: 'off', ...invalid('auto-name', error) }), '', 'auto-name', error)}

    <fieldset class="ws-auto-section"><legend>When</legend>
      <div class="ws-segmented ws-auto-kind" role="group" aria-label="When it runs">
        <button type="button" data-action="automation-kind" data-kind="schedule" aria-pressed="${!event}">${icon('clock')}On a schedule</button>
        <button type="button" data-action="automation-kind" data-kind="event" aria-pressed="${event}">${icon('bell')}When something happens</button>
      </div>
      <div class="ws-auto-when" ${event ? 'hidden' : ''}>
        <div class="ws-field-wrap"><span class="ws-field-label" id="auto-days-label">Days</span>
          <div class="ws-auto-days" role="group" aria-labelledby="auto-days-label" id="auto-days"${error?.field === 'auto-days' ? ' aria-invalid="true" aria-describedby="auto-days-error"' : ''}>${DAYS.map(([n, label]) => `<label class="ws-day"><input type="checkbox" name="auto-day" value="${n}" data-day="${n}"${draft.days.includes(n) ? ' checked' : ''}><span>${label}</span></label>`).join('')}</div>
          ${errorText('auto-days', error)}
        </div>
        <div class="ws-auto-time-row">
          ${errorField('Time', textInput({ id: 'auto-time', name: 'auto-time', type: 'time', value: draft.time, ...invalid('auto-time', error) }), '', 'auto-time', error)}
          <p class="ws-muted ws-hint ws-auto-zone">${icon('clock')}<span>In ${e(zone)}, your workspace time zone (Settings → General).</span></p>
        </div>
        ${switchRow({ name: 'auto-catchup', id: 'auto-catchup', checked: draft.catchUp, label: 'Catch up on a missed run', hint: 'If Connect was closed or asleep at that time, it runs once when Connect is back, within 12 hours.' })}
      </div>
      <div class="ws-auto-when" ${event ? '' : 'hidden'}>
        ${field('Event', select(EVENTS, draft.event, { id: 'auto-event', name: 'auto-event', 'data-action': 'automation-form' }))}
        <div ${message ? '' : 'hidden'}>${errorField(senderHint[0], textInput({ id: 'auto-senders', name: 'auto-senders', value: draft.senders, placeholder: senderHint[2], autocomplete: 'off', ...invalid('auto-senders', error) }), senderHint[1], 'auto-senders', error)}</div>
        ${errorField(MEETING_EVENTS.has(draft.event) ? 'Only meetings whose title mentions (optional)' : 'Only when it mentions (optional)', textInput({ id: 'auto-keywords', name: 'auto-keywords', value: draft.keywords, placeholder: 'budget, Q3', autocomplete: 'off', ...invalid('auto-keywords', error) }), 'Words or phrases, separated by commas. Leave it empty to match everything.', 'auto-keywords', error)}
      </div>
    </fieldset>

    ${summary ? `<div class="ws-field-wrap" id="auto-deliver">
      ${field('Make', select(summaryOptions(templates, summaryChoice), summaryChoice, { id: 'auto-summary', name: 'auto-summary', ...invalid('auto-deliver', error) }))}
      ${errorText('auto-deliver', error)}
    </div>` : ''}

    <fieldset class="ws-auto-section" id="auto-read"${summary ? ' hidden' : ''}><legend>Read</legend>
      <p class="ws-muted ws-hint ws-auto-privacy">${icon('lock')}<span>Claude reads only what you tick. Each run sends it to ${e(provider)}.</span></p>
      <div class="ws-auto-reads">
        ${readBox(event && draft.event === 'meeting_ended' ? 'meeting' : 'triggerConversation', 'triggerConversation', event)}
        ${readBox('senderMail', 'senderMail', message)}
        ${readBox('calendarToday')}
        ${readBox('needsReply')}
        ${readBox('recentMessages')}
        ${readBox('commitmentsNotes')}
      </div>
      ${errorText('auto-read', error)}
    </fieldset>

    <div class="ws-field-wrap">
      <span class="ws-auto-label-row"><label class="ws-field-label" for="auto-prompt">${summary ? 'Wishes (optional)' : 'Instructions'}</label><span class="ws-draft-count" data-auto-count>${count.toLocaleString('en-US')} / 4,000</span></span>
      ${textArea(draft.prompt, { id: 'auto-prompt', name: 'auto-prompt', rows: summary ? 3 : 5, maxlength: PROMPT_MAX, placeholder: summary ? 'e.g. Keep it to one page' : 'What should Claude do with what it reads? e.g. List what needs my attention today, most urgent first.', ...invalid('auto-prompt', error) })}
      ${errorText('auto-prompt', error)}
    </div>
    ${summary ? `<p class="ws-muted ws-hint ws-auto-privacy">${icon('info')}<span>Runs with the Claude route for meeting notes (Settings › Claude). Pin it as a summary tab in Settings › Meetings to open meetings on it.</span></p>` : ''}

    ${aiSection(draft, ai, error, summary)}

    <fieldset class="ws-auto-section"${summary ? ' hidden' : ` id="auto-deliver"${error?.field === 'auto-deliver' ? ' aria-invalid="true" aria-describedby="auto-deliver-error"' : ''}`}><legend>Deliver</legend>
      ${switchRow({ name: 'auto-deliver', value: 'today', data: ['data-deliver', 'today'], checked: draft.deliver.today, label: 'A card on Today', hint: 'The latest result shows in Automation results on Today.' })}
      ${switchRow({ name: 'auto-deliver', value: 'notify', data: ['data-deliver', 'notify'], checked: draft.deliver.notify, label: 'A notification', hint: 'Quiet hours and focus sessions hold it back.' })}
      ${replies ? switchRow({ name: 'auto-deliver', value: 'draftReply', data: ['data-deliver', 'draftReply'], checked: draft.deliver.draftReply, action: 'automation-form', label: 'A reply draft on the conversation', hint: 'Prepared in the Inbox for you to review and send. Automations never send.' }) : ''}
      ${readsMessages(draft) ? tasks : `<div hidden>${tasks}</div>`}
      ${summary ? '' : errorText('auto-deliver', error)}
    </fieldset>`;
}
