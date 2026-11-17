// Reply drafts with Claude (DESIGN 6.4): the Inbox composer, the Today "Draft reply" action and
// the pure decisions behind them. Draft records and AI jobs come from the Rust contract fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyDraftResult, restoreText, claudeCheck, replyBox, runningLabel, provenanceLabel, modelLabel, providerLabel, reconcile, answer,
  draftError, choicesIn, gapsIn, chooseOption, unfinishedParts, draftChoices, readOptions, pickOption, draftRequest, defaultOptions,
} from '../workspace/draft-state.js';
import { draftJob, latestDraft, draftKeyOf, decisions, conversation } from '../workspace/selectors.js';
import { REBASE_SAFE } from '../workspace/store.js';
import { inbox } from '../workspace/view-inbox.js';
import { today } from '../workspace/view-today.js';
import { buildSnapshot, aiStatus } from './fixtures/workspace-fixture.mjs';

const contract = name => JSON.parse(readFileSync(new URL(`./fixtures/contract/${name}.json`, import.meta.url), 'utf8'));
const NOW = Date.now();
const nowSec = Math.floor(NOW / 1000);

function snapshot() {
  return buildSnapshot(NOW, { photo: false });
}
const message = (s, id) => s.records.find(r => r.kind === 'message' && r.id === id);

/** The contract draft record (a Teams draft for chats, an Outlook one for mail), rebound to a message of the snapshot. */
function aiDraftFor(s, id, data = {}, extra = {}) {
  const tpl = contract(message(s, id).data.channel === 'chat' ? 'draft-ai-chat' : 'draft-ai');
  const m = message(s, id);
  const key = draftKeyOf(m);
  const ids = conversation(s, m).map(x => x.id);
  return {
    ...tpl, id: `ai:${key}`, connectionId: s.connection.id, source: m.source, updatedAt: nowSec - 30, ...extra,
    data: { ...tpl.data, channel: m.data.channel, draftKey: key, conversationKey: key, sourceId: m.id, provenance: { ...tpl.data.provenance, messageIds: ids }, ...data },
  };
}

/** A contract `ai_draft` job (failed on sign-in by default), rebound to a message of the snapshot. */
function jobFor(s, id, fields = {}, payload = {}, name = 'job-ai-draft-failed') {
  const tpl = contract(name);
  const m = message(s, id);
  const key = draftKeyOf(m);
  return {
    ...tpl, connectionId: s.connection.id, dueAt: nowSec - 10, ...fields,
    payload: { ...tpl.payload, channel: m.data.channel, draftKey: key, conversationKey: key, request: { ...tpl.payload.request, sourceId: m.id }, ...payload },
  };
}

const view = (s, state = {}) => inbox(s, {
  state: {
    lane: 'reply', channel: 'all', search: '', showArchived: false, showSnoozed: false, inboxLimit: 200, selectedMessage: 'c-reply-1',
    ai: { status: 'ready', ...aiStatus('both') }, drafts: {}, draftPopover: null, draftDismissed: [], ...state,
  },
  auth: {}, hidden: new Set(), banners: '',
});
const textarea = html => html.match(/<textarea id="reply-body"[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
const unescape = text => text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---------------------------------------------------------------- composer

test('reply_box_offers_draft_with_ai_or_set_up_claude', () => {
  const s = snapshot();
  const ready = view(s);
  assert.match(ready, /data-action="ai-draft-options"[^>]*aria-haspopup="dialog"/);
  assert.match(ready, />Draft with AI</);
  assert.doesNotMatch(ready, /id="draft-options"/, 'the popover is closed until asked for');

  const none = view(s, { ai: { status: 'ready', ...aiStatus('none') } });
  assert.doesNotMatch(none, /data-action="ai-draft-options"/);
  assert.match(none, /data-action="ai-open-settings"[^>]*>(?:(?!<\/button>).)*Set up Claude/);

  const unknown = view(s, { ai: { status: 'idle', profiles: [], settings: {} } });
  assert.match(unknown, /data-action="ai-draft-options"/, 'offered until detection says nothing is ready');

  const own = view(s, { lane: 'fyi', selectedMessage: 'm-thread-mine' });
  assert.match(own, /data-message-id="m-thread-mine"/);
  assert.doesNotMatch(own, /data-action="ai-draft-options"/, 'own mail cannot be replied to through Review & send');

  const opts = { ...defaultOptions('chat'), intent: 'propose_times', tone: 'friendly', includeFreeTimes: true };
  const open = view(s, { draftPopover: { key: 'chat:chat:chat-jordan', id: 'c-reply-1', options: opts, instructions: 'Keep it short' } });
  assert.match(open, /id="draft-options"[^>]*role="dialog"/);
  assert.match(open, /data-action="ai-draft-options"[^>]*aria-expanded="true"/);
  for (const v of ['reply', 'acknowledge', 'decline', 'ask', 'propose_times']) assert.match(open, new RegExp(`data-draft-intent="${v}"`));
  for (const v of ['neutral', 'friendly', 'formal']) assert.match(open, new RegExp(`data-draft-tone="${v}"`));
  for (const v of ['short', 'medium', 'detailed']) assert.match(open, new RegExp(`data-draft-length="${v}"`));
  assert.match(open, /data-draft-intent="propose_times"[^>]*aria-pressed="true"/);
  assert.match(open, /data-draft-tone="friendly"[^>]*aria-pressed="true"/);
  assert.match(open, /<input(?=[^>]*id="draft-free-times")(?=[^>]*\bchecked\b)[^>]*>/);
  assert.match(open, /<textarea[^>]*id="draft-instructions"[^>]*maxlength="1000"[^>]*>Keep it short<\/textarea>/);
  assert.match(open, /data-action="ai-draft"/);
  assert.match(open, /Sent only to Claude Code \(Anthropic\) to write this draft\./);
  const codemie = view(s, { draftPopover: { key: 'chat:chat:chat-jordan', id: 'c-reply-1', options: opts, instructions: '' }, ai: { status: 'ready', ...aiStatus('both', { defaultProfile: 'codemie:prod' }) } });
  assert.match(codemie, /Sent only to CodeMie · prod to write this draft\./);
  assert.equal(providerLabel('codemie:other', []), 'CodeMie · other');
});

test('remembered_options_are_validated_per_channel', () => {
  assert.deepEqual(readOptions(null, 'mail'), defaultOptions('mail'));
  assert.deepEqual(readOptions('not json', 'chat'), defaultOptions('chat'));
  assert.deepEqual(readOptions('{"intent":"propose_times","tone":"friendly","length":"short","includeFreeTimes":true}', 'chat'),
    { intent: 'propose_times', tone: 'friendly', length: 'short', includeFreeTimes: true });
  assert.deepEqual(readOptions('{"intent":"rewrite","tone":"rude","length":"short"}', 'mail'), { ...defaultOptions('mail'), length: 'short' }, 'unknown choices fall back');
  const times = pickOption(defaultOptions('mail'), 'intent', 'propose_times');
  assert.equal(times.includeFreeTimes, true, 'Propose times suggests free times by default');
  assert.equal(pickOption(times, 'intent', 'reply').includeFreeTimes, false);
  assert.equal(pickOption(times, 'tone', 'formal').includeFreeTimes, true, 'other choices keep the calendar choice');
});

test('running_draft_shows_profile_model_and_stop', () => {
  const s = snapshot();
  // The contract job while Claude runs: the route left the model to the profile, and Claude
  // reported it at start (`runModel`).
  const job = jobFor(s, 'c-reply-1', { leaseUntil: null }, { startedAt: nowSec - 6 }, 'job-ai-draft-running');
  assert.equal(job.state, 'running');
  assert.equal(job.payload.model, null);
  s.jobs.unshift(job);
  assert.equal(draftJob(s, 'chat:chat:chat-jordan').id, job.id);
  const html = view(s);
  const row = html.match(/<div class="ws-draft-running"[\s\S]*?<\/button>\s*<\/div>/)?.[0] || '';
  assert.match(row, /Drafting with Claude Code · Sonnet 4\.5…/);
  assert.match(row, /data-started="\d+"/);
  assert.match(row, /data-model="claude-sonnet-4-5"/);
  assert.match(row, new RegExp(`data-action="ai-draft-stop"[^>]*data-id="${job.id}"`));
  assert.match(html, /<textarea id="reply-body"(?![^>]*disabled)/, 'the reply stays editable');
  assert.match(html, /data-action="ai-draft-options"[^>]*disabled/, 'one draft per conversation at a time');

  const unknown = { ...job, payload: { ...job.payload, runModel: undefined } };
  assert.equal(runningLabel(unknown, { nowMs: NOW }).text, 'Drafting with Claude Code… 6 s', 'no model until Claude names it');
  assert.equal(runningLabel({ ...unknown, payload: { ...unknown.payload, model: 'sonnet' } }, { nowMs: NOW }).text, 'Drafting with Claude Code · Sonnet… 6 s', 'the model the route asked for');
  const codemie = { ...job, payload: { ...job.payload, profile: 'codemie:prod', runModel: undefined, startedAt: nowSec - 3 } };
  assert.equal(runningLabel(codemie, { nowMs: NOW }).text, 'Starting CodeMie… 3 s');
  const later = { ...codemie, payload: { ...codemie.payload, startedAt: nowSec - 20 } };
  assert.equal(runningLabel(later, { nowMs: NOW }).text, 'Drafting with CodeMie… 20 s');
  assert.equal(runningLabel({ ...later, payload: { ...later.payload, runModel: 'claude-sonnet-4-5' } }, { nowMs: NOW }).text, 'Drafting with CodeMie · Sonnet 4.5… 20 s');
  assert.equal(runningLabel({ ...job, state: 'queued', payload: { ...job.payload, startedAt: undefined } }, { nowMs: NOW }).text, 'Waiting to start…');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('opus'), 'Opus');
  assert.equal(modelLabel(''), '');
});

test('draft_result_fills_empty_box_and_shows_provenance', () => {
  assert.deepEqual(applyDraftResult({ current: '', dirty: false, result: { text: 'Hi' } }), { action: 'fill', text: 'Hi' });
  assert.deepEqual(applyDraftResult({ current: 'Old draft', dirty: false, result: { text: 'New' } }), { action: 'fill', text: 'New' }, 'an untouched draft is replaced without asking');

  const s = snapshot();
  const draft = aiDraftFor(s, 'c-reply-1');
  s.records.push(draft);
  assert.equal(latestDraft(s, 'chat:chat:chat-jordan').id, draft.id);
  const html = view(s);
  assert.equal(unescape(textarea(html)), draft.data.text);
  assert.doesNotMatch(draft.data.text, /^Hi |Best regards/, 'a Teams draft has no greeting or sign-off');
  const provenance = html.match(/<div class="ws-draft-provenance"[\s\S]*?<\/ul>/)?.[0] || '';
  assert.match(provenance, /Drafted with Claude Code · Sonnet 4\.5 · 3 s · from 2 messages/);
  assert.match(provenance, /data-action="ai-draft-context"[^>]*aria-expanded="false"[^>]*aria-controls="draft-context"/);
  assert.match(provenance, /<ul id="draft-context"[^>]*hidden/, 'Context is closed until asked for');
  assert.match(provenance, /Jordan Lee/, 'Context lists the sender of each message used');
  assert.match(view(s, { drafts: { 'chat:chat:chat-jordan': { contextOpen: true } } }), /<ul id="draft-context"(?![^>]*hidden)/);
  assert.match(html, /data-action="ai-draft-regenerate"/);
  assert.match(html, /Can you join the call at 11:00\?/, 'questions are shown under the box');
  assert.match(html, /Choose an option in brackets before sending/);
  assert.match(html, /data-action="ai-draft-choice"[^>]*data-option="Yes, 11:00 works for me"/);
  assert.equal(provenanceLabel({ profile: 'codemie:prod', model: 'claude-haiku-4-5', durationMs: 900, messageIds: ['a'] }), 'Drafted with CodeMie · Haiku 4.5 · 1 s · from 1 message');

  const partial = snapshot();
  partial.records.push(aiDraftFor(partial, 'c-reply-1', { provenance: { ...draft.data.provenance, partialText: true } }));
  assert.match(view(partial), /Preview text only/);
});

test('draft_result_asks_before_replacing_typed_text', () => {
  const result = { text: 'Hi Jordan, the notes are attached.' };
  const decision = applyDraftResult({ current: 'My own words', dirty: true, result });
  assert.deepEqual(decision, { action: 'confirm', text: result.text });
  const ai = { revision: 'r2', data: result };
  const kept = answer({ confirm: 'r2' }, ai, 'keep', 'My own words');
  assert.equal(kept.text, 'My own words', 'Keep mine leaves the text unchanged');
  assert.equal(kept.save, 'My own words');
  assert.equal(kept.ui.kept, 'r2');
  assert.equal(kept.ui.restore, null);
  const replaced = answer({ confirm: 'r2' }, ai, 'replace', 'My own words');
  assert.equal(replaced.text, result.text, 'Replace swaps it');
  assert.equal(replaced.save, result.text);
  assert.equal(restoreText(replaced.ui.restore), 'My own words');
  const restored = answer(replaced.ui, ai, 'restore', `${result.text} Edited after replacing.`);
  assert.equal(restored.text, 'My own words', 'Restore brings it back, also after the draft was edited');
  assert.equal(restored.save, 'My own words');
  assert.equal(restored.ui.restore, null);
  assert.equal(answer(replaced.ui, ai, 'forget', 'x').ui.restore, null, 'Restore can be dismissed');
  const stale = answer({ seen: 'r2' }, ai, 'restore', 'Words in the box');
  assert.deepEqual([stale.text, stale.save, stale.ui], ['Words in the box', null, { seen: 'r2' }], 'no offer, no change and nothing saved (the saved reply stays)');
  // The offer lasts until the next draft arrives.
  const next = reconcile({ ui: replaced.ui, ai: { revision: 'r3', data: { text: 'Newer draft' } }, manual: null, live: result.text });
  assert.equal(next.action, 'fill');
  assert.equal(next.ui.restore, null);

  // A newer draft over the saved words of the user waits for a decision, also after a reload.
  const s = snapshot();
  const draft = aiDraftFor(s, 'c-reply-1');
  const manual = { id: 'manual', kind: 'draft', source: 'local', connectionId: null, workspaceId: 'personal', revision: 'm1', updatedAt: nowSec - 120, data: { text: 'My own words', sourceId: 'c-reply-1' } };
  s.records.push(draft, manual);
  assert.deepEqual(replyBox({ manual, ai: draft }), { text: 'My own words', fromAi: false, confirm: draft.data.text });
  assert.deepEqual(replyBox({ manual: { ...manual, updatedAt: nowSec }, ai: draft }), { text: 'My own words', fromAi: false }, 'a newer saved reply wins');
  assert.deepEqual(replyBox({ manual: { ...manual, updatedAt: draft.updatedAt }, ai: draft }), { text: 'My own words', fromAi: false }, 'a reply saved in the same second as the draft wins');
  assert.deepEqual(replyBox({ manual, ai: draft, ui: { kept: draft.revision } }), { text: 'My own words', fromAi: false }, 'Keep mine and Restore answer the question');
  assert.deepEqual(replyBox({ manual: { ...manual, data: { ...manual.data, text: draft.data.text } }, ai: draft }), { text: draft.data.text, fromAi: true });
  const html = view(s);
  assert.equal(unescape(textarea(html)), 'My own words');
  assert.match(html, /Replace your text with the draft\?/);
  assert.match(html, /data-action="ai-draft-keep"[^>]*>(?:(?!<\/button>).)*Keep mine/);
  assert.match(html, /data-action="ai-draft-replace"[^>]*>(?:(?!<\/button>).)*Replace/);

  const after = snapshot();
  after.records.push(draft);
  const restorable = view(after, { drafts: { 'chat:chat:chat-jordan': { restore: { previous: 'My own words' }, baseline: draft.data.text, seen: draft.revision } } });
  assert.match(restorable, /data-action="ai-draft-restore"[^>]*title="[^"]*changes you made to the draft are discarded[^"]*"[^>]*>(?:(?!<\/button>).)*Restore my text/i);
  assert.match(restorable, /data-action="ai-draft-forget"/);
});

test('each_error_class_shows_its_sentence_and_action', () => {
  const cases = [
    [{ errorClass: 'needs_login', errorCode: 'needs_login', state: 'blocked' }, 'claude', "Claude Code isn't signed in.", 'ai-copy-login', 'Copy sign-in steps'],
    [{ errorClass: 'needs_login', errorCode: 'needs_login', state: 'blocked' }, 'codemie:staging', "CodeMie · staging isn't signed in.", 'cm-profile-login', 'Sign in'],
    [{ errorClass: 'not_installed', errorCode: 'not_installed', state: 'failed' }, 'claude', "Claude Code isn't installed on this Mac.", 'ai-open-settings', 'Open Claude settings'],
    [{ errorClass: 'too_old', errorCode: 'too_old', state: 'failed' }, 'claude', 'This Claude Code is too old to draft replies.', 'ai-open-settings', 'Open Claude settings'],
    [{ errorClass: 'not_configured', errorCode: 'not_configured', state: 'failed' }, 'codemie:prod', "This CodeMie profile isn't fully set up.", 'cm-setup-open', 'Set up CodeMie'],
    [{ errorClass: 'rate_limited', errorCode: 'rate_limited', state: 'failed' }, 'claude', "Claude's usage limit was reached. Try again later.", null, null],
    [{ errorClass: 'timeout', errorCode: 'timeout', state: 'failed' }, 'claude', 'Claude took too long to answer.', 'ai-draft-retry', 'Try again'],
    [{ errorClass: 'invalid_output', errorCode: 'invalid_output', state: 'failed' }, 'claude', "Claude's answer couldn't be used.", 'ai-draft-retry', 'Try again'],
    [{ errorClass: 'failed', errorCode: 'failed', state: 'failed' }, 'claude', "Claude couldn't write this draft.", 'ai-draft-retry', 'Try again'],
    [{ errorClass: 'needs_choice', errorCode: 'needs_choice', state: 'failed' }, null, 'Choose which Claude writes for you.', 'ai-draft-choose', 'Choose Claude'],
  ];
  for (const [fields, profile, sentence, action, label] of cases) {
    const s = snapshot();
    const job = jobFor(s, 'c-reply-1', fields, { profile });
    s.jobs.unshift(job);
    const html = view(s);
    const row = html.match(/<div class="ws-draft-error[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
    assert.match(unescape(row), new RegExp(sentence.replace(/[.?]/g, '\\$&')), `${fields.errorClass} ${profile}`);
    if (action) assert.match(row, new RegExp(`data-action="${action}"[^>]*>(?:(?!</button>).)*${label}`), `${fields.errorClass} action`);
    else assert.equal((row.match(/data-action="/g) || []).length, 1, 'only Dismiss when there is nothing to do now');
    assert.match(row, new RegExp(`data-action="ai-draft-dismiss"[^>]*data-id="${job.id}"`));
    assert.match(row, /^<div class="ws-draft-error[^"]*" role="status"/, 'announced politely; it re-renders');
    assert.equal(unescape(row.match(/<p>([\s\S]*?)<\/p>/)[1].replace(/<[^>]+>/g, '')).trim(), sentence, 'one sentence, no extra steps');
  }

  // The conversation changed while drafting (errorCode, no class) is answered by drafting again.
  const s = snapshot();
  const conflict = contract('job-ai-draft-conflict');
  s.jobs.unshift({ ...jobFor(s, 'c-reply-1'), errorClass: undefined, errorCode: conflict.errorCode, state: conflict.state, result: conflict.result });
  const html = view(s);
  assert.match(html, /The conversation changed while drafting\./);
  assert.match(html, /data-action="ai-draft-retry"[^>]*>(?:(?!<\/button>).)*Draft again/);

  // A stopped draft says nothing; a dismissed error stays dismissed; an older failure under a newer draft is history.
  const stopped = snapshot();
  stopped.jobs.unshift(jobFor(stopped, 'c-reply-1', { state: 'cancelled', errorClass: undefined, errorCode: 'cancelled' }));
  assert.doesNotMatch(view(stopped), /ws-draft-error/);
  const dismissed = snapshot();
  const failed = jobFor(dismissed, 'c-reply-1');
  dismissed.jobs.unshift(failed);
  assert.doesNotMatch(view(dismissed, { draftDismissed: [failed.id] }), /ws-draft-error/);
  assert.equal(draftError({ ...failed, state: 'succeeded', errorClass: undefined, errorCode: undefined }, {}), null);
});

test('claude_detection_runs_at_most_every_15_s', () => {
  const at = 1_000_000;
  const base = { status: 'ready', noneReady: true, nowMs: at, readAt: at - 20_000, detectAt: at - 20_000 };
  assert.deepEqual(claudeCheck({ ...base }), { read: true, detect: true }, 'nothing ready: read and detect again');
  assert.deepEqual(claudeCheck({ ...base, readAt: at - 5_000 }), { read: false, detect: false }, 'not on every render');
  assert.deepEqual(claudeCheck({ ...base, now: true, detectAt: at - 5_000 }), { read: true, detect: false }, 'window focus reads, but detection keeps its 15 s pace');
  assert.deepEqual(claudeCheck({ ...base, now: true, detect: true, detectAt: at - 5_000 }), { read: true, detect: false }, 'also after Copy sign-in steps');
  assert.deepEqual(claudeCheck({ ...base, now: true, detect: true }), { read: true, detect: true });
  assert.deepEqual(claudeCheck({ ...base, status: 'idle', noneReady: false, readAt: 0, detectAt: 0 }), { read: true, detect: false }, 'first use reads the cached status');
  assert.deepEqual(claudeCheck({ ...base, noneReady: false }), { read: false, detect: false }, 'a ready Claude is not re-read on render');
  assert.deepEqual(claudeCheck({ ...base, noneReady: false, now: true }), { read: true, detect: false });
});

test('drafting_and_stop_survive_a_background_sync', () => {
  // ai_draft reads the conversation when it runs and job_cancel stops whatever runs, so a sync
  // that moved the revision must not turn either into "your inbox updated" errors.
  assert.ok(REBASE_SAFE.has('ai_draft'));
  assert.ok(REBASE_SAFE.has('job_cancel'));
  assert.ok(!REBASE_SAFE.has('action_prepare'));
});

test('failed_ai_jobs_stay_out_of_decisions', () => {
  const s = snapshot();
  s.jobs.unshift(jobFor(s, 'c-reply-1'), { ...jobFor(s, 'm-reply-1', { errorClass: 'timeout', errorCode: 'timeout', state: 'failed' }), kind: 'ai_summarize' });
  s.jobs.unshift({ id: 'window-1', workspaceId: 'personal', connectionId: s.connection.id, kind: 'calendar_window', state: 'failed', dueAt: nowSec, attempts: 1, policy: null, payload: {}, result: 'Calendar unavailable' });
  assert.deepEqual(decisions(s).map(j => j.id), ['window-1'], 'AI failures show inline in the reply box instead');
});

// ---------------------------------------------------------------- bracketed choices

test('bracketed_choices_are_listed_resolved_and_block_a_silent_send', () => {
  const text = "Hi Ann,\n\n[Yes, I can / Unfortunately, I can't] send you the Monday version by [date].\nSee [the notes](https://example.test/a/b) and [https://example.test/x/y].";
  const choices = choicesIn(text);
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0].options, ['Yes, I can', "Unfortunately, I can't"]);
  assert.deepEqual(gapsIn(text).map(g => g.raw), ['[date]']);
  // Claude's draft is the reference: only what it left in brackets counts.
  assert.equal(chooseOption(text, 0, 'Yes, I can', text).split('\n')[2], 'Yes, I can send you the Monday version by [date].');
  assert.deepEqual(unfinishedParts(text, text), ["[Yes, I can / Unfortunately, I can't]", '[date]']);
  assert.deepEqual(unfinishedParts('All done. [1]', 'All done. [1]'), [], 'numbers in brackets are not gaps');
});

test('only_claudes_brackets_are_flagged_never_the_users_own', () => {
  const own = 'Fixed in [EPMCDME-1234], still [WIP] / [Draft]. [Yes / No]?';
  assert.deepEqual(unfinishedParts(own, undefined), [], 'no draft, nothing to finish');
  assert.deepEqual(unfinishedParts(own, ''), []);
  const ai = contract('draft-ai-chat').data.text;
  assert.deepEqual(unfinishedParts(own, ai), [], "the user's brackets are not Claude's");
  const mixed = `${ai} See [EPMCDME-1234].`;
  assert.deepEqual(unfinishedParts(mixed, ai), ["[Yes, 11:00 works for me / Sorry, I can't make 11:00]"]);
  assert.equal(draftChoices(mixed, ai).length, 1);

  // A hand-written reply with Jira keys: no panel; an AI draft with an open choice: the panel.
  const s = snapshot();
  s.records.push({ id: 'manual', kind: 'draft', source: 'local', connectionId: null, workspaceId: 'personal', revision: 'm1', updatedAt: nowSec, data: { text: own, sourceId: 'c-reply-1' } });
  const html = view(s);
  assert.match(html, /<section class="ws-draft-todo"[^>]*hidden/);
  assert.doesNotMatch(html, /Choose an option in brackets/);
  const drafted = snapshot();
  drafted.records.push(aiDraftFor(drafted, 'c-reply-1'));
  assert.match(view(drafted), /Choose an option in brackets before sending/);
});

test('a_draft_that_arrives_while_the_user_types_asks_instead_of_replacing', () => {
  const s = snapshot();
  const ai = aiDraftFor(s, 'c-reply-1');
  // Focus and typed (unsaved) text in #reply-body; no saved reply yet.
  const typed = reconcile({ ui: {}, ai, manual: null, live: 'Sure, give me a minute' });
  assert.deepEqual([typed.action, typed.text, typed.save, typed.ui.confirm], ['confirm', 'Sure, give me a minute', null, ai.revision]);
  assert.equal(reconcile({ ui: typed.ui, ai, manual: null, live: 'Sure, give me a minute' }), null, 'asked once');
  // An empty box is filled; nothing to save when there is no saved reply.
  const empty = reconcile({ ui: {}, ai, manual: null, live: '' });
  assert.deepEqual([empty.action, empty.text, empty.save], ['fill', ai.data.text, null]);
  // An untouched earlier draft is replaced, and the saved reply follows it.
  const manual = { kind: 'draft', updatedAt: nowSec - 60, data: { text: 'Earlier draft' } };
  const again = reconcile({ ui: { baseline: 'Earlier draft', seen: 'old' }, ai, manual, live: 'Earlier draft' });
  assert.deepEqual([again.action, again.save, again.ui.seen], ['fill', ai.data.text, ai.revision]);
  assert.equal(reconcile({ ui: {}, ai: null, manual, live: 'x' }), null);
  assert.equal(reconcile({ ui: {}, ai, manual, live: null }), null, 'nothing to do without an open reply box');
});

test('without_send_permission_the_reply_can_be_copied', () => {
  const s = snapshot();
  const html = view(s);
  assert.match(html, /data-action="reply-copy"[^>]*>(?:(?!<\/button>).)*Copy reply/);
  s.connection.enabled.push('chat_send');
  const allowed = view(s);
  assert.doesNotMatch(allowed, /data-action="reply-copy"/);
  assert.match(allowed, /Review &amp; send/);
});

// ---------------------------------------------------------------- Today

test('today_draft_reply_opens_inbox_and_starts_draft', () => {
  const s = snapshot();
  const ctx = ai => ({ state: { ai }, auth: {}, hidden: new Set(), banners: '' });
  const html = today(s, ctx({ status: 'ready', ...aiStatus('both') }));
  const actions = [...html.matchAll(/data-action="draft-reply"[^>]*>/g)].map(m => m[0]);
  assert.equal(actions.length, 5, 'one Draft reply per attention row');
  assert.ok(actions.some(a => /data-id="c-reply-1"/.test(a) && /data-key="chat:chat:chat-jordan"/.test(a)), actions.join('\n'));
  assert.ok(actions.some(a => /data-id="m-reply-1"/.test(a) && /data-key="m-reply-1"/.test(a)));
  assert.match(html, /data-action="draft-reply"[^>]*aria-label="Draft reply to Jordan Lee"/, 'the accessible name contains the visible label');
  assert.equal((today(s, ctx({ status: 'ready', ...aiStatus('none') })).match(/data-action="draft-reply"/g) || []).length, 0, 'not offered when no Claude is ready');

  const remembered = readOptions('{"intent":"propose_times","tone":"friendly","length":"short","includeFreeTimes":true}', 'chat');
  assert.deepEqual(draftRequest(message(s, 'c-reply-1'), remembered), { sourceId: 'c-reply-1', intent: 'propose_times', tone: 'friendly', length: 'short', includeFreeTimes: true });
  assert.deepEqual(draftRequest(message(s, 'm-reply-1'), defaultOptions('mail'), '  Mention Friday '), { sourceId: 'm-reply-1', intent: 'reply', tone: 'neutral', length: 'medium', includeFreeTimes: false, instructions: 'Mention Friday' });
});
