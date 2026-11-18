// The status smoke's window side (CODEMIE_STATUS_SMOKE=status|live, ruling R14): what it waits
// for, what it counts, which conversation and thread the live checks pick, and the live run
// against a stand-in Connect. The verdict, the scrubbing and the native run are Rust's
// (commands/status_smoke.rs); the runs are recorded in prototypes/milestone-2/VALIDATION.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';
import { createStore } from '../workspace/store.js';
import {
  firstSync, counts, setupFacts, pickDraftTarget, pickSummaryThread, briefFromTemplate, recordOps, runStatusSmoke, SEND_OPS,
} from '../workspace/status-smoke.js';

const NOW = Date.UTC(2026, 10, 18, 10, 0);
const now = Math.floor(NOW / 1000);
const snapshot = () => buildSnapshot(NOW);
const message = (s, id) => s.records.find(r => r.kind === 'message' && r.id === id);

/** A mail thread of `n` messages in `conv`, the newest `ageMin` minutes old. */
function thread(s, conv, n, ageMin = 50) {
  const base = message(s, 'm-fyi-1');
  for (let i = 0; i < n; i++) {
    s.records.push({ ...base, id: `${conv}-${i}`, revision: `r-${conv}-${i}`, data: { ...base.data, conversationId: conv, at: now - (ageMin + i * 10) * 60, text: `Thread message ${i}` } });
  }
  return `${conv}-0`;
}

test('the first sync is over once a sync that started with the run finished', () => {
  const s = snapshot();
  assert.deepEqual(firstSync(s, now - 100), { state: 'succeeded', lastSync: now - 90, error: false });
  // The sync before the run doesn't count; nothing newer ran yet.
  assert.equal(firstSync(s, now), null);
  s.jobs.push({ id: 'job-sync-2', kind: 'sync', state: 'running', dueAt: now + 1 });
  assert.equal(firstSync(s, now), null, 'still running');
  s.jobs[1].state = 'failed';
  s.connection.syncError = 'throttled';
  assert.deepEqual(firstSync(s, now), { state: 'failed', lastSync: now - 90, error: true });
  // Nothing to wait for without a Microsoft account, or with one that needs signing in.
  assert.deepEqual(firstSync(buildSnapshot(NOW, { connected: false }), now), { state: 'no_account', lastSync: null });
  const signedOut = snapshot();
  signedOut.connection.status = 'needs_login';
  assert.equal(firstSync(signedOut, now).state, 'needs_login');
});

test('the counts are what Today and Inbox show, and carry no message text', () => {
  const s = snapshot();
  const c = counts(s, { nowMs: NOW });
  // One row per Teams chat: Jordan's two messages are one reply.
  assert.deepEqual(c.inbox, { reply: 4, critical: 1, waiting: 0, fyi: 4, low: 1, decisions: 0 });
  assert.equal(c.needsReply, 4);
  assert.equal(c.critical, 1);
  assert.deepEqual(c.messages, { mail: 8, chat: 3 });
  assert.equal(c.todayEvents.allDay, 1);
  assert.ok(c.todayEvents.timed >= 4);
  assert.deepEqual(c.automations, { total: 0, on: 0 });
  assert.equal(c.commitments, 3);
  assert.deepEqual(c.connection, { status: 'connected', capabilities: ['calendar', 'chats', 'mail'], lastSync: now - 90, syncError: false });
  const text = JSON.stringify(c);
  for (const secret of ['Priya', 'roadmap', 'Production alert', '@example.test', 'Taylor']) assert.ok(!text.includes(secret), secret);
});

test('the setup sheet would open on a Mac with no CodeMie profile, once', () => {
  const none = { loaded: true, profiles: [], auth: { state: 'unknown' }, config: {} };
  assert.equal(setupFacts(none, { introduced: false }, {}, true).wouldOpen, true);
  assert.equal(setupFacts(none, { introduced: true }).wouldOpen, false, 'already introduced');
  const one = { loaded: true, profiles: [{ name: 'prod' }], auth: { state: 'signed_in' }, config: { active: 'prod' } };
  assert.deepEqual(setupFacts(one, {}, {}, false), {
    cliLoaded: true, profiles: 1, signIn: 'signed_in', introducedBefore: false, wouldOpen: false, sheetOpen: false, attention: [],
  });
  const expired = { ...one, auth: { state: 'not_signed_in' } };
  assert.deepEqual(setupFacts(expired).attention, ['signed-out']);
  assert.equal(setupFacts(null).wouldOpen, false);
});

test('the draft goes to the newest conversation that needs a reply and has nothing in its reply box', () => {
  const s = snapshot();
  // Jordan's chat is the newest reply (8 minutes).
  assert.equal(pickDraftTarget(s).id, 'c-reply-1');
  // A Claude draft there already: the next one, Priya's mail.
  s.records.push({ id: 'ai:chat:chat:chat-jordan', kind: 'draft', connectionId: 'acct', workspaceId: 'personal', data: { aiSuggested: true, draftKey: 'chat:chat:chat-jordan', text: 'x' } });
  assert.equal(pickDraftTarget(s).id, 'm-reply-1');
  // A reply the user saved there: the next one.
  s.records.push({ id: 'manual:m-reply-1', kind: 'draft', source: 'local', connectionId: null, workspaceId: 'personal', updatedAt: now, data: { text: 'mine', sourceId: 'm-reply-1' } });
  assert.equal(pickDraftTarget(s).id, 'm-reply-2');
  // A draft on its way: the next one.
  s.jobs.push({ id: 'j', kind: 'ai_draft', state: 'queued', payload: { draftKey: 'm-reply-2' }, dueAt: now });
  assert.equal(pickDraftTarget(s).id, 'c-reply-2');
  // The user's own Outlook message is never picked: with no other reply left, the newest FYI or
  // Waiting conversation with an empty reply box is.
  message(s, 'c-reply-2').data.lane = 'fyi';
  message(s, 'm-thread-mine').data.lane = 'reply';
  assert.equal(pickDraftTarget(s).id, 'c-reply-2');
  s.records.push({ id: 'ai:chat:chat:chat-group', kind: 'draft', connectionId: 'acct', workspaceId: 'personal', data: { aiSuggested: true, draftKey: 'chat:chat:chat-group', text: 'x' } });
  assert.equal(pickDraftTarget(s).id, 'm-fyi-1');
  // Never Low priority (automated mail), never the user's own mail.
  for (const id of ['m-fyi-1', 'm-fyi-2', 'm-xss']) message(s, id).data.lane = 'low';
  assert.equal(pickDraftTarget(s), null);
});

test('the summary goes to the newest mail thread long enough to summarize, without a summary', () => {
  const s = snapshot();
  assert.equal(pickSummaryThread(s), null, 'every fixture thread is short');
  thread(s, 'conv-old', 5, 300);
  const newest = thread(s, 'conv-new', 4, 100);
  assert.equal(pickSummaryThread(s).id, newest);
  s.records.push({ id: 'mail:conv-new', kind: 'summary', connectionId: 'acct', workspaceId: 'personal', data: { conversationKey: 'mail:conv-new', text: 'x', asks: [] } });
  assert.equal(pickSummaryThread(s).id, 'conv-old-0');
});

test('the Morning brief is made from the template, off so no schedule runs it', () => {
  const a = briefFromTemplate();
  assert.equal(a.name, 'Morning brief');
  assert.equal(a.enabled, false);
  assert.deepEqual(a.trigger, { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:45' });
  assert.deepEqual(a.deliver, { today: true, notify: true, draftReply: false });
  assert.equal(a.read.needsReply, true);
});

/** Connect as the live checks see it: the workspace ops, the facts and the discard. */
function fakeConnect(s, { draftText = 'Hi Jordan, here are the notes.', runStatus = 'ok' } = {}) {
  const pending = [];
  let n = 0;
  const finish = () => {
    for (const job of s.jobs.filter(j => j.state === 'running')) {
      job.state = 'succeeded';
      pending.shift()?.();
    }
  };
  const invoke = async (cmd, args) => {
    if (cmd === 'smoke_status_facts') return { plugins: { settled: true }, rows: { 'records.action': 2 } };
    if (cmd === 'smoke_status_discard') {
      const before = s.records.length;
      s.records = s.records.filter(r => !(r.kind === args.kind && r.id === args.id && r.connectionId === (args.connectionId || null) && r.workspaceId === (args.workspaceId || null)));
      return { deleted: s.records.length < before };
    }
    assert.equal(cmd, 'workspace_request');
    const { op, data } = args.request;
    if (op === 'snapshot') {
      finish();
      return { snapshot: structuredClone(s) };
    }
    const job = (kind, payload, record) => {
      const id = `job-${++n}`;
      s.jobs.unshift({ id, kind, state: 'running', dueAt: now + n, payload });
      pending.push(() => record && s.records.push(record()));
      return { queued: true, jobId: id };
    };
    if (op === 'ai_draft') {
      const m = message(s, data.sourceId);
      const key = m.data.channel === 'chat' ? `chat:${m.data.conversationId}` : m.id;
      return job('ai_draft', { draftKey: key }, () => ({
        id: `ai:${key}`, kind: 'draft', connectionId: 'acct', workspaceId: 'personal', updatedAt: now + 5,
        data: { aiSuggested: true, draftKey: key, text: draftText, questions: ['Which notes?'], provenance: { model: 'sonnet', profile: 'claude', durationMs: 4200, messageIds: ['a', 'b'] } },
      }));
    }
    if (op === 'ai_summarize') {
      const key = `mail:${message(s, data.sourceId).data.conversationId}`;
      return job('ai_summarize', { conversationKey: key }, () => ({
        id: key, kind: 'summary', connectionId: 'acct', workspaceId: 'personal', updatedAt: now + 5,
        data: { conversationKey: key, text: 'They agreed on the plan.\n\nOne question is open.', asks: [{ text: 'Send the plan', due: '2026-11-20' }], provenance: { model: 'haiku', durationMs: 2500 } },
      }));
    }
    if (op === 'automation_save') {
      const record = { id: 'auto-new', kind: 'automation', source: 'local', connectionId: null, workspaceId: 'personal', updatedAt: now, data: { ...data, id: 'auto-new' } };
      s.records.push(record);
      return { record, todayCard: false };
    }
    if (op === 'automation_run_now') {
      return job('automation_run', { automationId: data.id }, () => ({
        id: 'run-new', kind: 'automation_run', source: 'automation', connectionId: null, workspaceId: 'personal', updatedAt: now + 9,
        data: { automationId: data.id, status: runStatus, startedAt: now + 3, durationMs: 3100, model: 'haiku', delivered: ['today', 'notification_queued'], trigger: { kind: 'manual' }, sources: [{ id: 'm0' }], output: { title: '2 replies owed', summaryBlocks: [{ type: 'item', inlines: [{ text: 'Reply to Jordan' }] }], items: [] } },
      }));
    }
    if (op === 'automation_runs') return { runs: s.records.filter(r => r.kind === 'automation_run' && r.data.automationId === data.automationId), next: null };
    if (op === 'automation_delete') {
      s.records = s.records.filter(r => !(r.kind === 'automation' && r.id === data.id) && !(r.kind === 'automation_run' && r.data.automationId === data.id));
      return { deleted: true };
    }
    throw new Error(`unexpected op ${op}`);
  };
  return { invoke, state: () => s };
}

async function liveRun(s, options) {
  const connect = fakeConnect(s, options);
  const ops = [];
  const store = createStore(recordOps(connect.invoke, ops));
  const report = await runStatusSmoke({
    invoke: connect.invoke, store, ops, mode: 'live', runId: 'run-1', since: now - 100,
    setup: async () => setupFacts({ loaded: true, profiles: [{ name: 'prod' }], auth: { state: 'signed_in' }, config: { active: 'prod' } }),
    wait: async () => {},
  });
  return { report, ops, s: connect.state() };
}

test('a live run drafts, summarizes and runs the Morning brief, sends nothing and leaves nothing behind', async () => {
  const s = snapshot();
  thread(s, 'conv-long', 4);
  const layout = s.workspaces[0].layout.slice();
  const { report, ops, s: after } = await liveRun(s);
  assert.deepEqual(report.failed, [], JSON.stringify(report, null, 2));
  assert.equal(report.runId, 'run-1');
  assert.equal(report.sync.state, 'succeeded');
  assert.equal(report.counts.needsReply, 4);
  const { draft, summary, brief } = report.live;
  assert.equal(draft.status, 'ok');
  assert.equal(draft.channel, 'chat');
  assert.equal(draft.length, 'Hi Jordan, here are the notes.'.length);
  assert.equal(draft.questionsCount, 1);
  assert.deepEqual(draft.discarded, { deleted: true, gone: true });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.threadMessages, 4);
  assert.equal(summary.paragraphs, 2);
  assert.equal(summary.asksCount, 1);
  assert.equal(summary.asksWithDue, 1);
  assert.deepEqual(summary.removed, { deleted: true, gone: true });
  assert.equal(brief.status, 'ok');
  assert.equal(brief.created, true);
  assert.equal(brief.runId, 'run-new');
  assert.deepEqual(brief.runLog, { found: true, runsListed: 1 });
  assert.deepEqual(brief.todayCard, { onLayout: false, showsRun: true });
  assert.equal(brief.blocks, 1);
  assert.equal(brief.deleted, true);
  assert.equal(brief.layoutUnchanged, true);
  // Nothing was sent, and what the run made is gone.
  assert.deepEqual(report.live.sendOps, []);
  assert.ok(!ops.some(op => SEND_OPS.has(op)));
  assert.deepEqual(report.live.ops, ['ai_draft', 'ai_summarize', 'automation_delete', 'automation_run_now', 'automation_runs', 'automation_save', 'snapshot']);
  assert.equal(report.live.actionsBefore, report.live.actionsAfter);
  assert.ok(!after.records.some(r => r.kind === 'draft' || r.kind === 'summary' || r.kind === 'automation' || r.kind === 'automation_run'));
  assert.deepEqual(after.workspaces[0].layout, layout);
  // No message, draft or summary text in the report.
  const text = JSON.stringify(report);
  for (const secret of ['Hi Jordan', 'They agreed', 'Send the plan', 'Reply to Jordan', 'Which notes?', 'Thread message']) assert.ok(!text.includes(secret), secret);
});

test('a live run fails when a check fails, and still deletes the automation it made', async () => {
  const s = snapshot();
  const { report, s: after } = await liveRun(s, { draftText: '  ', runStatus: 'failed' });
  assert.equal(report.live.draft.status, 'failed');
  assert.equal(report.live.draft.why, 'the draft is empty');
  assert.equal(report.live.summary.status, 'skipped');
  assert.equal(report.live.brief.status, 'failed');
  assert.equal(report.live.brief.why, 'the run failed');
  assert.equal(report.live.brief.deleted, true);
  assert.deepEqual(report.failed, ['draft: the draft is empty', 'brief: the run failed']);
  assert.ok(!after.records.some(r => r.kind === 'automation'));
});

test('an existing Morning brief is run and left as it was', async () => {
  const s = snapshot();
  s.records.push({ id: 'auto-brief', kind: 'automation', source: 'local', connectionId: null, workspaceId: 'personal', updatedAt: now - 9999, data: { ...briefFromTemplate(), id: 'auto-brief', enabled: true } });
  const { report, s: after } = await liveRun(s);
  assert.equal(report.live.brief.created, false);
  assert.equal(report.live.brief.existingOn, true);
  assert.equal(report.live.brief.status, 'ok');
  assert.equal(report.live.brief.deleted, undefined);
  assert.ok(after.records.some(r => r.kind === 'automation' && r.id === 'auto-brief'));
});

test('a status run waits for the sync and the plugins and reports without the live checks', async () => {
  const s = snapshot();
  let polls = 0;
  const connect = fakeConnect(s);
  const invoke = async (cmd, args) => {
    if (cmd === 'smoke_status_facts') return { plugins: { settled: ++polls > 2 } };
    return connect.invoke(cmd, args);
  };
  const ops = [];
  const report = await runStatusSmoke({ invoke, store: createStore(recordOps(invoke, ops)), ops, mode: 'status', runId: 'run-2', since: now - 100, wait: async () => {} });
  assert.deepEqual(report.failed, []);
  assert.equal(report.live, null);
  assert.equal(polls, 3);
  assert.deepEqual(ops.filter(op => op !== 'snapshot'), [], 'a status run changes nothing');
  // A plugin manager that never settles fails the run.
  const stuck = await runStatusSmoke({
    invoke: async (cmd, args) => (cmd === 'smoke_status_facts' ? { plugins: { settled: false } } : connect.invoke(cmd, args)),
    store: createStore(connect.invoke), mode: 'status', runId: 'run-3', since: now - 100, wait: async () => {}, pluginsTimeoutMs: 0,
  });
  assert.deepEqual(stuck.failed, ["the plugin manager didn't settle within 0 s"]);
});
