// Thread summaries (DESIGN 6.5): when Summarize is offered, the summary card, its asks and
// its stale, running and failed states. Records and jobs come from the Rust contract fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summaryOffered, askDue, askDueDate, askCommitment, askCommitmentId, addedAsks } from '../workspace/summary-state.js';
import { summaryFor, summaryJob, summaryKeyOf, decisions } from '../workspace/selectors.js';
import { runningLabel, provenanceLabel, draftError } from '../workspace/draft-state.js';
import { inbox } from '../workspace/view-inbox.js';
import { buildSnapshot, aiStatus } from './fixtures/workspace-fixture.mjs';

const contract = name => JSON.parse(readFileSync(new URL(`./fixtures/contract/${name}.json`, import.meta.url), 'utf8'));
const NOW = Date.now();
const nowSec = Math.floor(NOW / 1000);
const message = (s, id) => s.records.find(r => r.kind === 'message' && r.id === id);

/** The fixture's Priya thread (`conv-m-reply-1`: two messages), grown to `extra` more mails. */
function snapshot(extra = 0, text = 'Sure, I will look.') {
  const s = buildSnapshot(NOW, { photo: false });
  const base = message(s, 'm-reply-1');
  for (let i = 0; i < extra; i++) {
    s.records.push({ ...base, id: `m-more-${i}`, revision: `r-more-${i}`, data: { ...base.data, text, at: base.data.at + 60 * (i + 1), lane: 'fyi' } });
  }
  return s;
}

/** The contract summary, rebound to the conversation of a message of the snapshot. */
function summaryOf(s, id, data = {}, extra = {}) {
  const tpl = contract('summary');
  const m = message(s, id);
  const key = summaryKeyOf(m);
  const latest = s.records.filter(r => r.kind === 'message' && r.data.conversationId === m.data.conversationId).sort((a, b) => a.data.at - b.data.at).at(-1);
  return { ...tpl, id: key, connectionId: s.connection.id, source: m.source, updatedAt: nowSec - 30, ...extra, data: { ...tpl.data, conversationKey: key, sourceId: m.id, latestMessageId: latest.id, ...data } };
}

function jobOf(s, id, name, fields = {}, payload = {}) {
  const tpl = contract(name);
  const m = message(s, id);
  return { ...tpl, connectionId: s.connection.id, dueAt: nowSec - 10, ...fields, payload: { ...tpl.payload, conversationKey: summaryKeyOf(m), request: { sourceId: m.id }, ...payload } };
}

const view = (s, state = {}) => inbox(s, {
  state: {
    lane: 'reply', channel: 'all', search: '', showArchived: false, showSnoozed: false, inboxLimit: 200, selectedMessage: 'm-reply-1',
    ai: { status: 'ready', ...aiStatus('both') }, drafts: {}, summaryUi: {}, draftPopover: null, draftDismissed: [], ...state,
  },
  auth: {}, hidden: new Set(), banners: '',
});
const count = (html, pattern) => (html.match(pattern) || []).length;

// ---------------------------------------------------------------- the button

test('summarize_button_only_for_long_threads', () => {
  // Two short messages: nothing to catch up on.
  const short = view(snapshot());
  assert.doesNotMatch(short, /data-action="ai-summarize"/);
  assert.doesNotMatch(short, /class="ws-summary/);
  // Four messages, or more than 2,000 characters of text, is long.
  const four = view(snapshot(2));
  assert.equal(count(four, /data-action="ai-summarize"/g), 1);
  assert.match(four, /data-action="ai-summarize"[^>]*data-id="m-reply-1"/);
  assert.match(four, /data-action="ai-summarize"[^>]*>(?:(?!<\/button>).)*Summarize/);
  const wordy = view(snapshot(1, 'word '.repeat(450)));
  assert.equal(count(wordy, /data-action="ai-summarize"/g), 1, 'more than 2,000 characters');
  assert.equal(summaryOffered([{ data: { text: 'x'.repeat(2000) } }]), false, 'exactly 2,000 is not more');
  assert.equal(summaryOffered([{ data: { text: 'x'.repeat(2001) } }]), true);
  assert.equal(summaryOffered(Array.from({ length: 3 }, () => ({ data: { text: 'hi' } }))), false);
  assert.equal(summaryOffered(Array.from({ length: 4 }, () => ({ data: { text: 'hi' } }))), true);
  // Not offered while no Claude is ready, and not for a message that is gone.
  assert.doesNotMatch(view(snapshot(2), { ai: { status: 'ready', ...aiStatus('none') } }), /data-action="ai-summarize"/);
  const gone = snapshot(2);
  message(gone, 'm-reply-1').data.unavailable = true;
  assert.doesNotMatch(view(gone), /data-action="ai-summarize"/);
  // Once there is a summary the card replaces the button (its Refresh is inside the card).
  const s = snapshot(2);
  s.records.push(summaryOf(s, 'm-reply-1'));
  const card = view(s);
  assert.equal(count(card, /class="ws-btn ws-btn-magic[^"]*"[^>]*data-action="ai-summarize"/g), 0);
  assert.match(card, /class="ws-summary/);
  // A Teams chat is summarized too, by its whole conversation.
  const chat = snapshot();
  const first = message(chat, 'c-reply-1');
  for (let i = 0; i < 3; i++) chat.records.push({ ...first, id: `c-more-${i}`, revision: `r-c-${i}`, data: { ...first.data, at: first.data.at - 60 * (i + 1) } });
  assert.match(view(chat, { lane: 'reply', selectedMessage: 'c-reply-1' }), /data-action="ai-summarize"[^>]*data-id="c-reply-1"/);
});

// ---------------------------------------------------------------- the card

test('summary_card_lists_asks_and_adds_commitment', () => {
  const s = snapshot(2);
  s.records.push(summaryOf(s, 'm-reply-1', { asks: [{ text: 'Send Priya the roadmap comments', due: '2026-11-20' }, { text: 'Book the review room', due: 'next week' }, { text: 'Reply to Sam' }], provenance: { ...contract('summary').data.provenance, messageIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], durationMs: 3200, model: 'claude-haiku-4-5', partialText: false } }));
  const html = view(s);
  assert.match(html, /<section class="ws-summary"[^>]*aria-label="Thread summary"/);
  assert.match(html, /<h3>[^]*?Summary<\/h3>/);
  assert.match(html, /Ann asked for the Q3 budget\./);
  assert.equal(count(html, /data-action="summary-ask-commit"/g), 3);
  assert.match(html, /data-action="summary-ask-commit"[^>]*data-index="0"/);
  assert.match(html, /data-action="summary-ask-commit"[^>]*data-ask="ask:[^"]+"/, 'asks are told apart by identity');
  assert.match(html, /Send Priya the roadmap comments/);
  assert.match(html, /Due Fri, Nov 20/, 'a date the model fixed is formatted');
  assert.match(html, /Due next week/, 'anything else is shown as written');
  assert.match(html, /Summarized with Claude Code · Haiku 4\.5 · 3 s · from 7 messages/);
  assert.doesNotMatch(html, /Preview text only/);
  assert.doesNotMatch(html, /New messages since this summary/);
  assert.match(html, /data-action="summary-toggle"[^>]*aria-expanded="true"/);
  assert.match(html, /data-action="ai-summarize"[^>]*>(?:(?!<\/button>).)*Refresh/);

  // The task holds the ask, in To do; the same ask is the same task, so it is added once.
  assert.match(html, /data-action="summary-ask-commit"[^>]*>(?:(?!<\/button>).)*Add to tasks/);
  const key = summaryKeyOf(message(s, 'm-reply-1'));
  const ask = summaryFor(s, message(s, 'm-reply-1')).data.asks[0];
  const request = askCommitment(key, ask);
  assert.deepEqual({ ...request, id: undefined }, { id: undefined, text: 'Send Priya the roadmap comments', owner: 'You', due: '2026-11-20', status: 'todo' });
  assert.equal(request.id, askCommitmentId(key, { text: ' send priya the roadmap comments ' }));
  assert.notEqual(request.id, askCommitmentId(key, { text: 'Book the review room' }));
  assert.equal(askCommitment(key, { text: 'x', due: 'next week' }).due, null, 'only a real date becomes the due date');
  // Added asks say so and cannot be added again, also after a reload.
  s.records.push({ id: request.id, kind: 'commitment', source: 'local', data: { text: ask.text, done: false }, connectionId: null, workspaceId: 'personal', revision: 'x', updatedAt: nowSec });
  const after = view(s);
  assert.equal(count(after, /data-action="summary-ask-commit"/g), 2);
  assert.match(after, /ws-summary-added[^>]*>(?:(?!<\/span>).)*Added/);
  assert.deepEqual(addedAsks(key, summaryFor(s, message(s, 'm-reply-1')).data.asks, s.records.filter(r => r.kind === 'commitment')), [true, false, false]);

  // Collapsed: the text is out of sight, the header and its toggle stay.
  const collapsed = view(s, { summaryUi: { [key]: { collapsed: true } } });
  assert.match(collapsed, /data-action="summary-toggle"[^>]*aria-expanded="false"/);
  assert.match(collapsed, /id="summary-body" hidden/);
  // Escapes what Claude wrote; a partial reading says so.
  const hostile = snapshot(2);
  hostile.records.push(summaryOf(hostile, 'm-reply-1', { text: '<img src=x onerror=alert(1)>', asks: [{ text: '<b>Send</b>' }], provenance: { ...contract('summary').data.provenance, partialText: true } }));
  const escaped = view(hostile);
  assert.doesNotMatch(escaped, /<img src=x|<b>Send/);
  assert.match(escaped, /Preview text only/);
});

test('due_dates_are_formatted_only_when_parseable', () => {
  assert.equal(askDue('2026-11-20', 'Europe/Kyiv'), 'Fri, Nov 20');
  assert.equal(askDue('2026-02-31', 'UTC'), '2026-02-31', 'not a real day: as written');
  assert.equal(askDue('by Friday', 'UTC'), 'by Friday');
  assert.equal(askDue('', 'UTC'), '');
  assert.match(askDue('2026-11-20T09:30:00Z', 'UTC'), /Nov 20/);
  // A timestamp without a zone is wall-clock time in the workspace zone, not the viewer's.
  assert.equal(askDue('2026-11-20T09:30:00', 'UTC'), askDue('2026-11-20T09:30:00Z', 'UTC'));
  assert.match(askDue('2026-11-20T09:30:00', 'Europe/Kyiv'), /09:30/);
  assert.match(askDue('2026-11-20T09:30:00', 'America/New_York'), /09:30/);
  assert.match(askDue('2026-11-20T09:30:00Z', 'Asia/Tokyo'), /06:30 PM/);
  assert.equal(askDueDate('2026-11-20'), '2026-11-20');
  assert.equal(askDueDate('next week'), null);
});

// ---------------------------------------------------------------- stale, running, failed

test('commitment_ids_stay_short_for_long_conversation_ids', () => {
  const long = `mail:${'AAQkAGI2'.repeat(19)}`;
  assert.ok(long.length >= 150);
  const id = askCommitmentId(long, { text: 'Send Jordan the roadmap draft' });
  assert.ok(id.length < 60, id);
  assert.equal(id, askCommitmentId(long, { text: ' send jordan the ROADMAP draft ' }));
  assert.notEqual(id, askCommitmentId(`${long}x`, { text: 'Send Jordan the roadmap draft' }));
});

test('stale_summary_offers_refresh', () => {
  const s = snapshot(2);
  s.records.push(summaryOf(s, 'm-reply-1', { stale: true }));
  const html = view(s);
  assert.match(html, /class="ws-summary ws-summary-stale"/);
  assert.match(html, /New messages since this summary\./);
  assert.equal(count(html, /data-action="ai-summarize"/g), 1, 'one Refresh, in the note');
  assert.match(html, /ws-summary-stale-note[^]*data-action="ai-summarize"[^>]*>(?:(?!<\/button>).)*Refresh/);
  // A failed refresh shows its own action only: no Refresh beside it.
  const failedStale = snapshot(2);
  failedStale.records.push(summaryOf(failedStale, 'm-reply-1', { stale: true }, { updatedAt: nowSec - 100 }));
  failedStale.jobs.unshift(jobOf(failedStale, 'm-reply-1', 'job-ai-summarize-failed'));
  const failed = view(failedStale);
  assert.match(failed, /ws-draft-error/);
  assert.equal(count(failed, /data-action="ai-summarize"/g), 0);
  assert.doesNotMatch(failed, /ws-summary-stale-note/);
  // The summary still shows what it said.
  assert.match(html, /Ann asked for the Q3 budget\./);
});

test('running_summary_shows_progress_and_stop', () => {
  const s = snapshot(2);
  s.jobs.unshift(jobOf(s, 'm-reply-1', 'job-ai-summarize-running', { id: 'sum-job' }, { startedAt: nowSec - 4 }));
  const html = view(s);
  assert.match(html, /class="ws-draft-running"[^>]*data-verb="Summarizing"[^>]*data-state="running"/);
  assert.match(html, /Summarizing with Claude Code · Haiku 4\.5…/);
  assert.match(html, /data-action="ai-draft-stop"[^>]*data-id="sum-job"/);
  assert.doesNotMatch(html, /data-action="ai-summarize"/, 'no second summary while one runs');
  assert.deepEqual(runningLabel(jobOf(s, 'm-reply-1', 'job-ai-summarize-running', {}, { startedAt: nowSec - 6 }), { verb: 'Summarizing', nowMs: NOW }).label, 'Summarizing with Claude Code · Haiku 4.5…');
  // A refresh keeps the card and shows the progress inside it.
  s.records.push(summaryOf(s, 'm-reply-1'));
  const refreshing = view(s);
  assert.match(refreshing, /class="ws-summary"/);
  assert.match(refreshing, /Summarizing with Claude Code/);
  assert.match(refreshing, /data-action="ai-summarize"[^>]*disabled/, 'Refresh waits for the run');
  assert.equal(summaryJob(s, summaryKeyOf(message(s, 'm-reply-1'))).id, 'sum-job');
});

test('failed_summary_shows_one_sentence_and_one_action_not_a_decision', () => {
  const s = snapshot(2);
  const failed = jobOf(s, 'm-reply-1', 'job-ai-summarize-failed', { id: 'sum-fail' });
  s.jobs.unshift(failed);
  assert.equal(decisions(s).some(j => j.id === 'sum-fail'), false, 'inline, not in the decisions list');
  const html = view(s);
  assert.match(html, /Claude Code isn(?:'|&#39;)t signed in\./);
  assert.match(html, /data-action="ai-copy-login"/);
  assert.match(html, /data-action="ai-draft-dismiss"[^>]*data-id="sum-fail"/);
  assert.doesNotMatch(html, /data-action="ai-summarize"/, 'the error row carries the action');
  // Dismissed: the button comes back.
  assert.match(view(s, { draftDismissed: ['sum-fail'] }), /data-action="ai-summarize"[^>]*data-id="m-reply-1"/);
  // Other classes, worded for summaries and retried as summaries.
  const retryable = draftError({ ...failed, errorClass: 'timeout', errorCode: 'timeout' }, { kind: 'summary' });
  assert.deepEqual([retryable.sentence, retryable.action.action, retryable.action.attrs['data-id']], ['Claude took too long to answer.', 'ai-summarize-retry', 'sum-fail']);
  assert.equal(draftError({ ...failed, errorClass: 'invalid_output' }, { kind: 'summary' }).action.action, 'ai-summarize-retry');
  assert.equal(draftError({ ...failed, errorClass: 'unknown', errorCode: 'x' }, { kind: 'summary' }).sentence, "Claude couldn't summarize this conversation.");
  assert.equal(draftError({ ...failed, errorClass: 'needs_choice' }, { kind: 'summary' }).action.action, 'ai-summarize-choose');
  assert.equal(draftError({ ...failed, errorClass: 'too_old' }, { kind: 'summary' }).sentence, 'This Claude Code is too old to summarize conversations.');
  assert.equal(draftError({ ...failed, state: 'cancelled' }, { kind: 'summary' }), null, 'Stop is not a failure');
  // A failed refresh sits above the old summary, which stays; a failure older than it is history.
  s.records.push(summaryOf(s, 'm-reply-1', {}, { updatedAt: nowSec - 100 }));
  const both = view(s);
  assert.match(both, /class="ws-summary"/);
  assert.match(both, /isn(?:'|&#39;)t signed in/);
  const newer = snapshot(2);
  newer.jobs.unshift(jobOf(newer, 'm-reply-1', 'job-ai-summarize-failed', { dueAt: nowSec - 200 }));
  newer.records.push(summaryOf(newer, 'm-reply-1'));
  assert.doesNotMatch(view(newer), /isn(?:'|&#39;)t signed in/);
});

test('summary_labels', () => {
  const p = contract('summary').data.provenance;
  assert.equal(provenanceLabel(p, 'Summarized'), 'Summarized with Claude Code · Haiku 4.5 · 3 s · from 3 messages');
  assert.equal(provenanceLabel(p), 'Drafted with Claude Code · Haiku 4.5 · 3 s · from 3 messages');
});
