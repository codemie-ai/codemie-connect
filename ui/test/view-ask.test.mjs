// The Ask page as a pure view (ask-capture design § 5, § 7, Copy "Page", "History", "Turn",
// "States", "Privacy line", Accessibility): the turns and their states, the meta line, the
// history and its groups, the empty page, Back, the follow-up box, the privacy line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askPage, turnBlock, metaLine, historyList, historyGroups, emptyPage, answeringLine, nextAskStatus } from '../workspace/view-ask.js';
import { askThread, buildSnapshot, withAsk, withVoice } from './fixtures/workspace-fixture.mjs';

// The fixtures' own clock: ask-states.json's newest thread was updated at 1795000400.
const NOW = 1795000410 * 1000;
const PROFILES = [{ id: 'claude', label: 'Claude Code' }, { id: 'codemie:prod', label: 'CodeMie · prod' }];

/** A snapshot holding the records ask-thread.json's cites point at (all but `drop`). */
function snapshot(askState = 'idle', { drop = [] } = {}) {
  const s = withAsk(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), askState);
  const rec = (id, kind, data = {}) => ({ id, kind, source: 'local', connectionId: null, workspaceId: null, revision: `r-${id}`, updatedAt: 1795000000, data });
  for (const [id, kind] of [['msg-17', 'message'], ['task-3', 'commitment'], ['ev-9', 'event'], ['msg-21', 'message'], ['ev-4', 'event']]) {
    if (!drop.includes(id)) s.records.push(rec(id, kind));
  }
  return s;
}
const thread = () => askThread();
const state = (over = {}) => ({ route: 'ask', ask: { from: '#/inbox', focusBack: null, threadId: 'ask-7f2c', pageText: '', pageError: '', ...over } });
const turnOf = (t, id) => t.turns.find(x => x.id === id);
const opts = (s, over = {}) => ({ snap: s, now: NOW, profiles: PROFILES, ...over });

test('a done turn: the question with its About chip, the answer through renderMarkdown, cite marks as superscript links named by the label, the meta line', () => {
  const s = snapshot();
  const t = thread();
  const html = turnBlock(turnOf(t, 'turn-1'), opts(s));
  assert.match(html, /<article class="ws-ask-turn[^"]*" data-ask-turn="turn-1" aria-labelledby="ask-q-turn-1">/);
  assert.match(html, /<h2 class="ws-ask-q" id="ask-q-turn-1" tabindex="-1">What did I promise Priya this week\?<\/h2>/);
  assert.match(html, /About: Priya N\. · mail · Tue 24 Nov/);
  // Markdown: bold and bullets; the marks are links named by the chip's label.
  assert.match(html, /<strong>Atlas budget<\/strong>/);
  assert.match(html, /<ul><li>The QBR/);
  // M1: a mark is a button (Enter and Space work), named by the chip's label.
  assert.match(html, /<sup><button type="button" class="ws-ask-mark" data-action="ask-mark" data-ask-mark="ask-cite-turn-1-a1" aria-label="Priya N\. · mail · Tue 24 Nov">1<\/button><\/sup>/);
  assert.doesNotMatch(html, /role="link"/);
  assert.doesNotMatch(html, /\[a1\]|\[t2\]/);
  // The chips, in cite order; a fact and a person are not links.
  assert.match(html, /id="ask-cite-turn-1-a1"[^>]*>Priya N\. · mail · Tue 24 Nov</);
  assert.match(html, /id="ask-cite-turn-1-f7"[^>]*>From Knowledge: Atlas rollout</);
  assert.match(html, /id="ask-cite-turn-1-p6"[^>]*>From Knowledge: Marek Novak</);
  // The meta line: profile, seconds, the counts searched with ▾, and the cut.
  assert.match(html, /class="ws-ask-meta"/);
  assert.match(html, /Claude Code · 14 s · from 12 tasks, 7 events, 9 messages, 2 meetings, 1 person, 1 fact · Shortened to fit\./);
  assert.match(html, /tasks 12 \(Todoist\) · events 7, Thu 19 Nov – Thu 3 Dec · messages 9/);
  assert.equal(metaLine({ ...turnOf(t, 'turn-1'), searched: 'tasks 12 (Todoist) · messages 9 · meetings 2', cut: false }, { profiles: PROFILES }), 'Claude Code · 14 s · from 12 tasks, 9 messages, 2 meetings');
  assert.match(metaLine({ ...turnOf(t, 'turn-1'), cut: true }), /Shortened to fit\.$/);
  // A fallback says which profile ran and why.
  // M4: the reason is the turn's stored class, never the profile's live state or message.
  const live = [{ ...PROFILES[0], state: 'not_installed', message: 'Something <b>live</b>.' }, PROFILES[1]];
  const fell = turnBlock({ ...turnOf(t, 'turn-1'), profile: 'codemie:prod', fellBackFrom: 'claude', fallbackReason: 'needs_login' }, opts(s, { profiles: live }));
  assert.match(fell, /Ran on CodeMie · prod because Claude Code wasn’t signed in\./);
  const unknown = turnBlock({ ...turnOf(t, 'turn-1'), profile: 'codemie:prod', fellBackFrom: 'claude', fallbackReason: null }, opts(s, { profiles: live }));
  assert.match(unknown, /Ran on CodeMie · prod because Claude Code couldn’t run\./);
  assert.doesNotMatch(unknown, /live|wasn’t installed/);
  // Nothing in the answer is a time button or a link anywhere.
  assert.doesNotMatch(html, /ws-md-ts|<a [^>]*href/);
});

test('an About marked gone shows "The item you asked about is no longer in Connect."', () => {
  const t = thread();
  const turn = { ...turnOf(t, 'turn-1'), about: { ...turnOf(t, 'turn-1').about, gone: true } };
  assert.match(turnBlock(turn, opts(snapshot())), /The item you asked about is no longer in Connect\./);
  assert.doesNotMatch(turnBlock(turnOf(t, 'turn-1'), opts(snapshot())), /no longer in Connect\./);
});

test('a cite whose record is gone is greyed "No longer in Connect", not a link; a fact chip says "From Knowledge: <title>"', () => {
  const html = turnBlock(turnOf(thread(), 'turn-1'), opts(snapshot('idle', { drop: ['task-3'] })));
  assert.match(html, /class="ws-ask-cite ws-ask-cite-gone"[^>]*id="ask-cite-turn-1-t2"[^>]*>Task · Send the Atlas budget · No longer in Connect</);
  // Its mark is plain text, not a link.
  assert.match(html, /<sup class="ws-ask-mark">2<\/sup>/);
  assert.doesNotMatch(html, /data-ask-mark="ask-cite-turn-1-t2"/);
  assert.match(html, />From Knowledge: Atlas rollout</);
});

test('answering: role="status" "Answering with Claude Code · 9 s" from the job\'s startedAt and Stop with aria-keyshortcuts "Meta+Period"', () => {
  const s = snapshot('running');
  s.jobs = [{ id: 'job-9', kind: 'ask', state: 'running', payload: { threadId: 'ask-7f2c', turnId: 'turn-2', profile: 'claude', startedAt: 1795000401 } }];
  const turn = { id: 'turn-2', at: 1795000390, question: 'When is the QBR?', about: null, state: 'running', answer: null, cites: [], actions: [], searched: null, cut: false, took: null, profile: null, model: null, fellBackFrom: null, error: null, jobId: 'job-9' };
  const html = turnBlock(turn, opts(s, { running: true }));
  // M3: the turn draws the visible line; the one live status node lives outside the page.
  assert.match(html, /<p class="ws-ask-status" data-ask-run="turn-2" data-ask-since="1795000401" data-ask-profile="Claude Code">/);
  assert.match(html, /<span data-ask-tick aria-hidden="true">Answering with Claude Code · 9 s<\/span>/);
  assert.doesNotMatch(html, /role="status"/);
  assert.match(html, /<button type="button" class="ws-btn ws-btn-secondary ws-ask-stop" data-action="ask-stop" data-job="job-9" aria-keyshortcuts="Meta\+Period">Stop/);
  assert.equal(answeringLine('Claude Code', 9), 'Answering with Claude Code · 9 s');
  // A queued turn shows the same, from its own time when no job is known.
  const queued = turnBlock({ ...turn, state: 'queued', jobId: 'job-x' }, opts(snapshot('idle')));
  assert.match(queued, /Answering · 20 s/);
});

test('stopped: "Stopped." and Ask again', () => {
  const html = turnBlock(turnOf(thread(), 'turn-3'), opts(snapshot()));
  assert.match(html, /<p class="ws-ask-stopped">Stopped\.<\/p>/);
  assert.match(html, /data-action="ask-again" data-ask-turn="turn-3">Ask again</);
});

test('failed: "Couldn\'t answer: <sentence>" and Try again; profile problems add "Check Settings › AI"; timeout does not', () => {
  const failed = turnOf(thread(), 'turn-2');
  const html = turnBlock(failed, opts(snapshot()));
  assert.match(html, /Couldn’t answer: CodeMie is not signed in\./);
  assert.match(html, /data-action="ask-retry" data-ask-turn="turn-2">Try again</);
  assert.match(html, /data-action="ask-settings"[^>]*>Check Settings › AI</);
  for (const code of ['needs_login', 'not_installed', 'too_old', 'not_configured', 'rate_limited']) {
    assert.match(turnBlock({ ...failed, error: { code, message: 'x.' } }, opts(snapshot())), /Check Settings › AI/, code);
  }
  for (const code of ['timeout', 'invalid_output', 'failed', 'cancelled']) {
    assert.doesNotMatch(turnBlock({ ...failed, error: { code, message: 'x.' } }, opts(snapshot())), /Check Settings › AI/, code);
  }
});

test('Microsoft not connected: the line above the answer', () => {
  const done = turnOf(thread(), 'turn-1');
  const line = 'Microsoft 365 isn’t connected, so this answer leaves out your mail, Teams and calendar.';
  const off = turnBlock({ ...done, searched: 'tasks 2 (Connect) · meetings 0 · Microsoft 365 isn\'t connected' }, opts(snapshot()));
  assert.ok(off.indexOf(line) > 0 && off.indexOf(line) < off.indexOf('ws-ask-answer'), 'the line sits above the answer');
  assert.doesNotMatch(turnBlock(done, opts(snapshot())), /isn’t connected/);
  assert.match(turnBlock(done, opts(snapshot(), { m365: false })), /Microsoft 365 isn’t connected/);
});

test('the follow-up box: "Ask a follow-up…"; disabled with its reason while a turn runs', () => {
  const idle = askPage(state(), snapshot(), thread(), { now: NOW, profiles: PROFILES });
  assert.match(idle, /<input id="ask-follow-up"[^>]*placeholder="Ask a follow-up…"/);
  assert.doesNotMatch(idle, /<input id="ask-follow-up"[^>]*disabled/);
  assert.match(idle, /data-action="ask-follow-up">Ask</);
  const busy = askPage(state(), snapshot('running'), thread(), { now: NOW, profiles: PROFILES });
  assert.match(busy, /<input id="ask-follow-up"[^>]*disabled[^>]*aria-describedby="ask-box-why"/);
  assert.match(busy, /<p class="ws-ask-why" id="ask-box-why">Connect is still answering\. Stop it or wait\.<\/p>/);
  // The words typed are kept in the box through a redraw.
  assert.match(askPage(state({ pageText: 'and <Jordan>?' }), snapshot(), thread(), { now: NOW }), /value="and &lt;Jordan&gt;\?"/);
});

test('history groups Today, Yesterday, This week, Earlier; the current is aria-current="page"; ⋯ says which thread it deletes', () => {
  const at = (d, h = 10) => Date.UTC(2026, 10, d, h) / 1000;
  const threads = [
    { id: 'a', title: 'Old one', updatedAt: at(2) },
    { id: 'b', title: 'Monday’s', updatedAt: at(23) },
    { id: 'c', title: 'Yesterday’s', updatedAt: at(25, 22) },
    { id: 'd', title: 'Earlier today', updatedAt: at(26, 1) },
    { id: 'e', title: 'Newest today', updatedAt: at(26, 8) },
  ];
  const groups = historyGroups(threads, Date.UTC(2026, 10, 26, 9), 'UTC');
  assert.deepEqual(groups.map(([g, list]) => [g, list.map(t => t.id)]), [['Today', ['e', 'd']], ['Yesterday', ['c']], ['This week', ['b']], ['Earlier', ['a']]]);
  const html = historyList(snapshot(), 'ask-7f2c', { now: NOW });
  assert.match(html, /<nav class="ws-ask-history" aria-label="History">/);
  assert.match(html, /<a class="ws-ask-hrow" href="#\/ask\/ask-7f2c" data-action="ask-history" data-ask-thread="ask-7f2c" aria-current="page"[^>]*>What did I promise Priya this week\?<\/a>/);
  assert.doesNotMatch(html, /data-ask-thread="ask-3a9e" aria-current/);
  assert.match(html, /<button type="button" class="ws-menu-item" data-action="ask-delete" data-ask-thread="ask-7f2c" aria-label="Delete “What did I promise Priya…”">/);
  assert.match(html, /data-action="ask-clear"[^>]*>Clear history</);
});

test('wide Default draws the history column; Compact and narrow Default draw "History ▾" and "New ask"', () => {
  const wide = askPage(state(), snapshot(), thread(), { wide: true, now: NOW });
  assert.match(wide, /class="ws-ask-cols"/);
  assert.match(wide, /<nav class="ws-ask-history"/);
  assert.doesNotMatch(wide, /History <span aria-hidden="true">▾/);
  const narrow = askPage(state(), snapshot(), thread(), { wide: false, now: NOW });
  assert.doesNotMatch(narrow, /class="ws-ask-cols"/);
  assert.match(narrow, /<details class="ws-menu ws-menu-right ws-ask-hmenu" data-menu="ask-history"><summary class="ws-btn ws-btn-secondary"[^>]*>History <span aria-hidden="true">▾<\/span>/);
  assert.match(narrow, /data-action="ask-new"[^>]*>New ask</);
});

test('the empty page shows the line and three examples that fill the box', () => {
  const html = askPage(state({ threadId: null }), snapshot('empty'), null, { now: NOW });
  assert.match(html, /Ask about your mail, meetings, calendar and tasks\./);
  const examples = [...html.matchAll(/data-action="ask-example" data-text="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(examples, ['What’s due this week?', 'What did I agree in my last meeting?', 'Who’s waiting on me?']);
  assert.equal(emptyPage().includes('Ask about your mail'), true);
  assert.match(html, /<input id="ask-follow-up"[^>]*aria-label="Ask Connect"/);
  assert.doesNotMatch(html, /ws-ask-history/);
});

test('Back names the page Ask was opened from', () => {
  assert.match(askPage(state(), snapshot(), thread(), { now: NOW }), /<button type="button" class="ws-ask-back" data-action="ask-back">← Back to Inbox<\/button>/);
  assert.match(askPage(state({ from: '#/meetings/ev-4/summary' }), snapshot(), thread(), { now: NOW }), /← Back to Meetings/);
  assert.match(askPage(state({ from: '#/settings/ai' }), snapshot(), thread(), { now: NOW }), /← Back to Settings/);
  assert.match(askPage(state({ from: null }), snapshot(), thread(), { now: NOW }), /← Back to Today/);
});

test('each turn is an article labelled by its question; the page region is labelled "Ask"', () => {
  const html = askPage(state(), snapshot(), thread(), { now: NOW });
  assert.match(html, /<section class="ws-ask-page" aria-label="Ask">/);
  assert.equal([...html.matchAll(/<article class="ws-ask-turn/g)].length, 3);
  assert.match(html, /<h1 class="ws-sr">Ask<\/h1>/);
  // A thread that is gone says so.
  assert.match(askPage(state(), snapshot(), { missing: true }, { now: NOW }), /That conversation is gone\. Ask again\./);
});

test('the privacy line is verbatim with the provider name, and without facts when the voice is off', () => {
  const on = withVoice(snapshot(), 'ready');
  assert.match(askPage(state(), on, thread(), { now: NOW }), /<p class="ws-ask-privacy">Answers use what Connect has on this Mac: your tasks, calendar, mail and Teams previews, meeting notes, and facts from Knowledge when your voice is on\. Only what fits each question goes to the AI profile Ask uses \(Settings › AI\)\. Ask never sends or changes anything; you choose each action\.<\/p>/);
  const off = askPage(state(), withVoice(snapshot(), 'off'), thread(), { now: NOW });
  assert.match(off, /<p class="ws-ask-privacy">Answers use what Connect has on this Mac: your tasks, calendar, mail and Teams previews, and meeting notes\. Only what fits each question goes to the AI profile Ask uses \(Settings › AI\)\. Ask never sends or changes anything; you choose each action\.<\/p>/);
});

test('answer, question, label and searched text are escaped; markdown links are not followed', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const done = turnOf(thread(), 'turn-1');
  const turn = { ...done, question: `Q ${evil}`, answer: `A ${evil} [click](javascript:alert(1)) [a1]`, about: { kind: 'message', recordId: 'msg-17', label: `L ${evil}` }, searched: `tasks 1 (${evil})`, cites: [{ ...done.cites[0], label: `C ${evil}` }] };
  const html = turnBlock(turn, opts(snapshot()));
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /\[click\]\(javascript:alert\(1\)\)/);
  const page = historyList({ ...snapshot(), ask: { threads: [{ id: 'x', title: evil, updatedAt: 1795000000 }] } }, null, { now: NOW });
  assert.doesNotMatch(page, /<img/);
});

test('Default and Compact draw the same turn markup', () => {
  const t = thread();
  const s = snapshot();
  const compact = { ...s, settings: { ...s.settings, view: 'compact' } };
  for (const turn of t.turns) assert.equal(turnBlock(turn, opts(s)), turnBlock(turn, opts(compact)));
});

test('M3: the live status changes only when the answer\'s state changes, its seconds every 5 s at most', () => {
  const run = { turnId: 'turn-2', profile: 'Claude Code', since: 100 };
  const a = nextAskStatus(null, run, 109);
  assert.deepEqual(a, { turnId: 'turn-2', secs: 9, text: 'Answering with Claude Code · 9 s' });
  assert.equal(nextAskStatus(a, run, 110), a, 'a redraw a second later changes nothing');
  assert.equal(nextAskStatus(a, run, 113), a);
  assert.equal(nextAskStatus(a, run, 114).text, 'Answering with Claude Code · 14 s');
  const other = nextAskStatus(a, { ...run, turnId: 'turn-3' }, 110);
  assert.equal(other.turnId, 'turn-3');
  const idle = nextAskStatus(a, null, 120);
  assert.deepEqual(idle, { turnId: null, secs: 0, text: '' });
  assert.equal(nextAskStatus(idle, null, 130), idle);
  assert.equal(nextAskStatus(null, null, 130), null);
});
