// The Ask page (ask-capture design § 5, § 7, Copy "Page", "History", "Turn", "States", "Privacy
// line", Accessibility): Back, the history (a 240 px column in a wide Default window, "History ▾"
// otherwise), one article per turn with its state, the follow-up box and the privacy line. Pure:
// takes the window's view state, the snapshot and the thread `ask_read` answered, returns HTML.
// ask-controller.js owns the thread and the actions; app.js draws this for route `ask`. Every
// question, label and searched line goes through `escapeHtml`, the answer through `renderMarkdown`
// in its Ask mode. A cite chip whose record is in Connect is a button (`ask-cite`); the actions are
// `ask-task`, `ask-go` and `ask-reply` buttons that only propose (ask-controller.js runs them). The
// answering line is drawn here; the one live status a screen reader hears is app.js's, outside
// the page, so a redraw never says it again (`nextAskStatus`).
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { addDaysToKey, dayKey } from './format.js';
import { actionControl, BUSY } from './ask-model.js';

const NAV_NAMES = { today: 'Today', inbox: 'Inbox', calendar: 'Calendar', meetings: 'Meetings', tasks: 'Tasks', automations: 'Automations', analytics: 'Analytics', settings: 'Settings' };
/** The failures a profile's own state explains (Settings › AI fixes them). */
const PROFILE_PROBLEMS = new Set(['needs_login', 'not_installed', 'too_old', 'not_configured', 'rate_limited']);
/** "Ran on <fallback> because <profile> <reason>." from the turn's stored class (`fallbackReason`),
 *  a fixed code native keeps, never a message or the profile's state now. */
const FALLBACK_REASON = { needs_login: 'wasn’t signed in', not_installed: 'wasn’t installed', too_old: 'needed an update', not_configured: 'wasn’t fully set up', rate_limited: 'reached its usage limit' };
const NOT_CONNECTED = 'Microsoft 365 isn\'t connected';
const EXAMPLES = ['What’s due this week?', 'What did I agree in my last meeting?', 'Who’s waiting on me?'];
const GONE_THREAD = 'That conversation is gone. Ask again.';
/** The words of a count in the searched line, one and many. */
const NOUNS = { tasks: ['task', 'tasks'], events: ['event', 'events'], messages: ['message', 'messages'], meetings: ['meeting', 'meetings'], people: ['person', 'people'], facts: ['fact', 'facts'] };

/** "Claude Code", the CodeMie profile's own label ("CodeMie · prod"), another profile's label, or
 *  the id. */
export function profileLabel(id, profiles = []) {
  if (!id) return '';
  if (id === 'claude') return 'Claude Code';
  const p = (profiles || []).find(x => x.id === id);
  if (p?.label) return p.label;
  if (id.startsWith('codemie:')) return `CodeMie · ${id.slice(8)}`;
  return id;
}

/** "Answering with Claude Code · 9 s" (or "Answering · 9 s" with no profile known). */
export const answeringLine = (profile, seconds) => (profile ? `Answering with ${profile} · ${seconds} s` : `Answering · ${seconds} s`);

/**
 * What the window's one live status says next (ask-capture § Accessibility). `prev` is what it
 * says now (`{turnId, secs, text}` or null), `run` the answer drawn as running (`{turnId,
 * profile, since}`) or null, `nowSec` the time in seconds. The same object comes back while
 * nothing should be said: the words change when an answer starts, ends or is another one, and its
 * seconds at most every 5 s, never on a redraw.
 */
export function nextAskStatus(prev, run, nowSec) {
  if (!run) return prev?.text ? { turnId: null, secs: 0, text: '' } : prev;
  const secs = Math.max(0, Math.floor(nowSec - run.since));
  if (prev?.turnId === run.turnId && secs - prev.secs < 5) return prev;
  return { turnId: run.turnId, secs, text: answeringLine(run.profile, secs) };
}

/** The provider the facts came from, as the searched line names it ("facts 1 (Knowledge)"). */
function factsProvider(turn, snap) {
  const named = /(?:^| · )facts [^(·]*\(([^)]+)\)/.exec(turn?.searched || '')?.[1];
  return named || voiceProvider(snap) || 'Knowledge';
}

/** The reply-context provider's name while the voice is on, else ''. */
function voiceProvider(snap) {
  const rv = snap?.replyVoice;
  if (!rv?.provider || rv.provider === 'off') return '';
  return rv.name || (rv.available || []).find(a => a.id === rv.provider)?.name || 'Knowledge';
}

const findRecord = (snap, kinds, id) => !!id && (snap?.records || []).some(r => kinds.includes(r.kind) && r.id === id);
const RECORD_KINDS = { message: ['message'], task: ['commitment'], event: ['event'], meeting: ['meeting', 'event'] };

/** Whether a cite's record is no longer in the snapshot (people and facts never are). */
const citeGone = (cite, snap) => !!RECORD_KINDS[cite.kind] && !findRecord(snap, RECORD_KINDS[cite.kind], cite.recordId);

/** A chip's words: the record's label, or "From <provider>: <title>" for a person or a fact. */
function citeText(cite, turn, snap) {
  if (cite.kind === 'fact') return `From ${factsProvider(turn, snap)}: ${cite.title || ''}`;
  if (cite.kind === 'person') return `From ${factsProvider(turn, snap)}: ${String(cite.label || '').replace(/^Person · /, '')}`;
  return String(cite.label || '');
}

const citeId = (turn, cite) => `ask-cite-${turn.id}-${cite.id}`;

/** "12 tasks, 7 events, 9 messages, 2 meetings" from the searched line's counts. */
function shortSearched(searched) {
  return String(searched || '').split(' · ').map(part => {
    const m = /^(tasks|events|messages|meetings|people|facts) (\d+)/.exec(part.trim());
    if (!m) return '';
    const n = Number(m[2]);
    return `${n} ${NOUNS[m[1]][n === 1 ? 0 : 1]}`;
  }).filter(Boolean).join(', ');
}

/** The meta line: "<profile> · <n> s · from <counts>", and " · Shortened to fit." when cut. */
export function metaLine(turn, { profiles = [] } = {}) {
  const parts = [profileLabel(turn.profile, profiles) || 'Claude'];
  if (Number.isFinite(turn.took)) parts.push(`${turn.took} s`);
  const from = shortSearched(turn.searched);
  if (from) parts.push(`from ${from}`);
  if (turn.cut) parts.push('Shortened to fit.');
  return parts.join(' · ');
}

function fallbackLine(turn, profiles) {
  if (!turn.fellBackFrom) return '';
  const reason = (Object.hasOwn(FALLBACK_REASON, turn.fallbackReason || '') && FALLBACK_REASON[turn.fallbackReason]) || 'couldn’t run';
  return `<p class="ws-ask-fallback">${e(`Ran on ${profileLabel(turn.profile, profiles)} because ${profileLabel(turn.fellBackFrom, profiles)} ${reason}.`)}</p>`;
}

function aboutLine(turn) {
  const a = turn.about;
  if (!a) return '';
  return `<p class="ws-ask-about">About: ${e(a.label)}</p>${a.gone ? '<p class="ws-ask-about-gone">The item you asked about is no longer in Connect.</p>' : ''}`;
}

function answerBlock(turn, snap) {
  const cites = turn.cites || [];
  const index = new Map(cites.map((c, i) => [c.id, i + 1]));
  const mark = id => {
    const cite = cites.find(c => c.id === id);
    if (!cite) return '';
    const n = index.get(id);
    const linkable = RECORD_KINDS[cite.kind] && !citeGone(cite, snap);
    return linkable
      ? `<sup><button type="button" class="ws-ask-mark" data-action="ask-mark" data-ask-mark="${e(citeId(turn, cite))}" aria-label="${e(citeText(cite, turn, snap))}">${n}</button></sup>`
      : `<sup class="ws-ask-mark">${n}</sup>`;
  };
  const chips = cites.map(c => {
    const gone = citeGone(c, snap);
    if (RECORD_KINDS[c.kind] && !gone) {
      return `<li><button type="button" class="ws-ask-cite" id="${e(citeId(turn, c))}" data-action="ask-cite" data-ask-turn="${e(turn.id)}" data-ask-cite="${e(c.id)}">${e(citeText(c, turn, snap))}</button></li>`;
    }
    return `<li><span class="ws-ask-cite${gone ? ' ws-ask-cite-gone' : ''}" id="${e(citeId(turn, c))}" tabindex="-1">${e(citeText(c, turn, snap))}${gone ? ' · No longer in Connect' : ''}</span></li>`;
  }).join('');
  return `<div class="ws-ask-answer ws-md">${renderMarkdown(turn.answer || '', { mode: 'ask', cite: mark })}</div>${chips ? `<ul class="ws-ask-cites">${chips}</ul>` : ''}${actionsRow(turn, snap)}`;
}

/** The answer's actions (at most 3, each only a proposal): one button per action that can still
 *  run, keeping its index in the turn; an action whose record is gone is not drawn. */
function actionsRow(turn, snap) {
  const buttons = (turn.actions || []).slice(0, 3).map((a, i) => {
    const c = actionControl(a, turn, snap);
    if (!c) return '';
    const label = c.label.startsWith('✦ ') ? `<span aria-hidden="true">✦</span> ${e(c.label.slice(2))}` : e(c.label);
    return `<button type="button" class="ws-btn ws-btn-secondary ws-btn-sm" data-action="ask-${c.kind}" data-ask-turn="${e(turn.id)}" data-ask-index="${i}">${label}</button>`;
  }).join('');
  return buttons ? `<div class="ws-ask-actions">${buttons}</div>` : '';
}

function runningBlock(turn, { snap, now, profiles, ai }) {
  const job = (snap?.jobs || []).find(j => j.id === turn.jobId);
  const running = snap?.ask?.running?.turnId === turn.id ? snap.ask.running : null;
  const since = Number(job?.payload?.startedAt ?? running?.startedAt ?? turn.at) || 0;
  const id = job?.payload?.profile || turn.profile || ai?.chosen?.ask?.profile || '';
  const profile = profileLabel(id, profiles);
  const secs = Math.max(0, Math.floor(now / 1000 - since));
  const line = answeringLine(profile, secs);
  const jobId = turn.jobId || running?.jobId || '';
  return `<div class="ws-ask-running">
      <p class="ws-ask-status" data-ask-run="${e(turn.id)}" data-ask-since="${since}" data-ask-profile="${e(profile)}"><span class="ws-ask-spin" aria-hidden="true"></span><span data-ask-tick aria-hidden="true">${e(line)}</span></p>
      <button type="button" class="ws-btn ws-btn-secondary ws-ask-stop" data-action="ask-stop" data-job="${e(jobId)}" aria-keyshortcuts="Meta+Period">Stop <kbd aria-hidden="true">⌘.</kbd></button>
    </div>`;
}

/**
 * One turn: an article labelled by its question, the About chip, then by state: answering (with
 * the elapsed seconds and Stop), the answer with its cite chips and meta line, "Couldn’t answer"
 * with Try again, or "Stopped." with Ask again. `snap` finds gone records and the job; `m365`
 * false shows the Microsoft line on an answer whose searched line doesn't already say so.
 */
export function turnBlock(turn, { running = false, m365, snap = null, now = Date.now(), profiles = [], ai = null } = {}) {
  const head = `<h2 class="ws-ask-q" id="ask-q-${e(turn.id)}" tabindex="-1">${e(turn.question)}</h2>${aboutLine(turn)}`;
  let body = '';
  if (running || turn.state === 'queued' || turn.state === 'running') {
    body = runningBlock(turn, { snap, now, profiles, ai });
  } else if (turn.state === 'done') {
    const left = m365 === false || String(turn.searched || '').includes(NOT_CONNECTED);
    body = `${left ? '<p class="ws-inline-note ws-ask-note">Microsoft 365 isn’t connected, so this answer leaves out your mail, Teams and calendar.</p>' : ''}${answerBlock(turn, snap)}${fallbackLine(turn, profiles)}
      <details class="ws-ask-meta"><summary>${e(metaLine(turn, { profiles }))} <span aria-hidden="true">▾</span></summary><p class="ws-ask-searched">${e(turn.searched || '')}</p></details>`;
  } else if (turn.state === 'failed') {
    const code = turn.error?.code || 'failed';
    body = `<p class="ws-ask-failed"><span aria-hidden="true">✕</span> Couldn’t answer: ${e(turn.error?.message || 'Something went wrong.')}</p>${fallbackLine(turn, profiles)}
      <div class="ws-ask-acts"><button type="button" class="ws-btn ws-btn-secondary ws-btn-sm" data-action="ask-retry" data-ask-turn="${e(turn.id)}">Try again</button>${PROFILE_PROBLEMS.has(code) ? '<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm" data-action="ask-settings">Check Settings › AI</button>' : ''}</div>`;
  } else {
    body = `<div class="ws-ask-acts"><p class="ws-ask-stopped">Stopped.</p><button type="button" class="ws-btn ws-btn-secondary ws-btn-sm" data-action="ask-again" data-ask-turn="${e(turn.id)}">Ask again</button></div>`;
  }
  return `<article class="ws-ask-turn ws-ask-turn-${e(turn.state)}" data-ask-turn="${e(turn.id)}" aria-labelledby="ask-q-${e(turn.id)}">${head}${body}</article>`;
}

/** Threads newest first in the groups "Today", "Yesterday", "This week" (the five days before
 *  yesterday) and "Earlier", by the day of their last turn in `zone`; empty groups left out. */
export function historyGroups(threads, now = Date.now(), zone = 'UTC') {
  const today = dayKey(now, zone);
  const yesterday = addDaysToKey(today, -1);
  const week = addDaysToKey(today, -6);
  const groups = [['Today', []], ['Yesterday', []], ['This week', []], ['Earlier', []]];
  for (const t of [...(threads || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    const key = dayKey((t.updatedAt || 0) * 1000, zone);
    groups[key >= today ? 0 : key === yesterday ? 1 : key >= week ? 2 : 3][1].push(t);
  }
  return groups.filter(([, list]) => list.length);
}

/** A title as the ⋯ names it: "What did I promise Priya…". */
const shortTitle = title => {
  const chars = [...String(title || '').trim()];
  return chars.length <= 24 ? chars.join('') : `${chars.slice(0, 24).join('').trimEnd()}…`;
};

/** History: links grouped by day, the open one `aria-current="page"`, each with ⋯ › Delete, and
 *  Clear history. '' with no threads. */
export function historyList(snap, current, { now = Date.now() } = {}) {
  const threads = snap?.ask?.threads || [];
  if (!threads.length) return '';
  const groups = historyGroups(threads, now, snap?.settings?.timeZone || 'UTC').map(([name, list]) => `<h3 class="ws-ask-hgroup">${e(name)}</h3>
      <ul class="ws-ask-hlist">${list.map(t => {
        const short = shortTitle(t.title);
        return `<li class="ws-ask-hitem"><a class="ws-ask-hrow" href="#/ask/${e(encodeURIComponent(t.id))}" data-action="ask-history" data-ask-thread="${e(t.id)}"${t.id === current ? ' aria-current="page"' : ''} title="${e(t.title)}">${e(t.title)}</a>
          <details class="ws-menu ws-menu-right ws-ask-hmore" data-menu="ask-thread-${e(t.id)}"><summary class="ws-btn ws-btn-ghost ws-btn-icon ws-btn-sm" aria-label="More for “${e(short)}”" title="More">${icon('dots')}</summary><div class="ws-menu-panel">
            <button type="button" class="ws-menu-item" data-action="ask-delete" data-ask-thread="${e(t.id)}" aria-label="Delete “${e(short)}”">${icon('trash')}<span>Delete</span></button>
          </div></details></li>`;
      }).join('')}</ul>`).join('');
  return `<nav class="ws-ask-history" aria-label="History"><h2 class="ws-ask-htitle">History</h2>${groups}
      <button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-ask-clear" data-action="ask-clear">Clear history</button></nav>`;
}

/** The page with no thread and no history: what Ask is for, and three examples for the box. */
export function emptyPage() {
  return `<div class="ws-ask-empty"><p class="ws-ask-empty-line">Ask about your mail, meetings, calendar and tasks.</p>
      <div class="ws-ask-examples">${EXAMPLES.map(q => `<button type="button" class="ws-btn ws-btn-secondary ws-btn-sm" data-action="ask-example" data-text="${e(q)}">${e(q)}</button>`).join('')}</div></div>`;
}

function backLabel(from) {
  const head = String(from || '').replace(/^#\/?/, '').split('/')[0];
  return NAV_NAMES[head || 'today'] || 'Today';
}

function box(state, snap, followUp) {
  const busy = !!snap?.ask?.running;
  const label = followUp ? 'Ask a follow-up' : 'Ask Connect';
  const error = state?.ask?.pageError ? `<p class="ws-ask-error" role="alert">${e(state.ask.pageError)}</p>` : '';
  return `<form class="ws-ask-page-box" role="search" aria-label="${label}" novalidate>
      <input id="ask-follow-up" class="ws-input" type="text" value="${e(state?.ask?.pageText || '')}" placeholder="${followUp ? 'Ask a follow-up…' : 'Ask…'}" maxlength="2000" autocomplete="off" aria-label="${label}"${busy ? ' disabled aria-describedby="ask-box-why"' : ''}>
      <button type="button" class="ws-btn ws-btn-primary" data-action="ask-follow-up"${busy ? ' disabled' : ''}>Ask</button>
    </form>${busy ? `<p class="ws-ask-why" id="ask-box-why">${e(BUSY)}</p>` : ''}${error}`;
}

function privacyLine(snap) {
  const provider = voiceProvider(snap);
  const reads = provider
    ? `your tasks, calendar, mail and Teams previews, meeting notes, and facts from ${provider} when your voice is on`
    : 'your tasks, calendar, mail and Teams previews, and meeting notes';
  return `<p class="ws-ask-privacy">${e(`Answers use what Connect has on this Mac: ${reads}. Only what fits each question goes to the AI profile Ask uses (Settings › AI). Ask never sends or changes anything; you choose each action.`)}</p>`;
}

/**
 * The page. `thread` is the `ask_read` answer for `state.ask.threadId` (null while it loads, or
 * `{missing: true}` when it is gone). `wide`: a Default window whose main area is 1,100 px or
 * wider draws the history as a column; otherwise "History ▾" and "New ask" sit in the header.
 */
export function askPage(state, snap, thread, { wide = false, now = Date.now(), profiles = [], ai = null } = {}) {
  const ask = state?.ask || {};
  const current = ask.threadId || null;
  const threads = snap?.ask?.threads || [];
  const history = historyList(snap, current, { now });
  const running = snap?.ask?.running;
  let main;
  if (current && thread?.missing) {
    main = `<p class="ws-ask-gone">${GONE_THREAD}</p>${box(state, snap, false)}`;
  } else if (current && thread?.turns) {
    const turns = thread.turns.map(t => turnBlock(t, { running: running?.turnId === t.id && running?.threadId === thread.id, snap, now, profiles, ai })).join('');
    main = `<div class="ws-ask-thread">${turns}</div>${box(state, snap, true)}`;
  } else if (current) {
    main = '<div class="ws-ask-loading" aria-busy="true"></div>';
  } else {
    main = `${threads.length ? '' : emptyPage()}${box(state, snap, false)}`;
  }
  const menu = !wide && history
    ? `<details class="ws-menu ws-menu-right ws-ask-hmenu" data-menu="ask-history"><summary class="ws-btn ws-btn-secondary" aria-label="History">History <span aria-hidden="true">▾</span></summary><div class="ws-menu-panel">${history}</div></details>`
    : '';
  const head = `<div class="ws-ask-head"><button type="button" class="ws-ask-back" data-action="ask-back">← Back to ${e(backLabel(ask.from))}</button><span class="ws-spacer"></span>${menu}${!wide && current ? '<button type="button" class="ws-btn ws-btn-secondary" data-action="ask-new">New ask</button>' : ''}</div>`;
  const body = wide && history ? `<div class="ws-ask-cols">${history}<div class="ws-ask-main">${main}</div></div>` : `<div class="ws-ask-main">${main}</div>`;
  return `<section class="ws-ask-page" aria-label="Ask"><h1 class="ws-sr">Ask</h1>${head}${body}${privacyLine(snap)}</section>`;
}
