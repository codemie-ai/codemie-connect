// CODEMIE_STATUS_SMOKE=status|live (ruling R14), smoke only: the window's side of the status smoke
// (src-tauri/src/commands/status_smoke.rs). Connect booted as the user's own launch does. This
// waits for the first sync and the plugin manager, then reports what Today, Inbox and Settings
// would show, counted: no message, draft or summary text, no names, no addresses. In `live` it
// then runs the checks the owner approved through the workspace ops the UI uses: one AI draft on
// the newest conversation that needs a reply (discarded afterwards, never sent), one summary of
// a mail thread (removed afterwards) and one Morning brief run (an automation it made from the
// template is deleted afterwards). Rust adds its own view, scrubs the report, decides and quits.
//
// Everything is injected, so node:test drives the choices and the counts without a window.
import {
  records, attentionMessages, visibleMessages, collapseChats, LANES, draftKeyOf, draftJob, latestDraft,
  savedReply, summaryKeyOf, summaryFor, summaryJob, conversation, syncRunning, decisions, active,
} from './selectors.js';
import { draftRequest, defaultOptions } from './draft-state.js';
import { summaryOffered } from './summary-state.js';
import { todayModel } from './view-today.js';
import { TEMPLATES, toAutomation, draftFromAutomation, automationResultsCard } from './view-automations.js';
import { shouldAutoOpen, attention } from './codemie/model.js';

/** Workspace ops that would send, post or write somewhere else; the smoke must never call one. */
export const SEND_OPS = new Set(['action_prepare', 'action_confirm']);
const FINISHED = state => !['queued', 'running'].includes(state);
const message = e => String((e && e.message) || e || 'failed');
const errorOf = e => ({ errorCode: String(e?.code || e?.class || 'error'), error: message(e) });
const length = text => String(text || '').trim().length;

/** Waits for `probe()` to give something, asking every `every` ms; null after `timeoutMs`. */
export async function until(probe, timeoutMs, wait, every = 1000) {
  const started = Date.now();
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() - started >= timeoutMs) return null;
    await wait(every);
  }
}

/** Connect's invoke, keeping the op of every `workspace_request` in `ops`. */
export function recordOps(invoke, ops) {
  return (cmd, args) => {
    if (cmd === 'workspace_request') ops.push(String(args?.request?.op || ''));
    return invoke(cmd, args);
  };
}

// ---------------------------------------------------------------- what the snapshot shows

/**
 * Whether the first sync after `since` (unix seconds) is over: `{state, at}` once it is, null while
 * it runs or hasn't started. With no Microsoft account connected there is nothing to wait for.
 */
export function firstSync(s, since) {
  const c = s.connection;
  if (!c || c.status !== 'connected') return { state: c ? c.status : 'no_account', lastSync: c?.lastSync ?? null };
  if (syncRunning(s)) return null;
  const ran = s.jobs.filter(j => j.kind === 'sync' && (j.dueAt || 0) >= since && FINISHED(j.state));
  if (!ran.length && !((c.lastSync || 0) >= since)) return null;
  const newest = ran.sort((a, b) => (b.dueAt || 0) - (a.dueAt || 0))[0];
  return { state: newest?.state || 'succeeded', lastSync: c.lastSync ?? null, error: !!c.syncError };
}

/** What Today, Inbox and Automations count. */
export function counts(s, { hidden = new Set(), nowMs = Date.now() } = {}) {
  const messages = visibleMessages(s);
  const byLane = {};
  for (const [lane] of LANES) {
    if (lane === 'decisions') continue;
    byLane[lane] = collapseChats(messages.filter(m => m.data.lane === lane)).items.length;
  }
  byLane.decisions = decisions(s).length;
  const attentionRows = attentionMessages(s);
  const m = todayModel(s, hidden, nowMs);
  const automations = records(s, 'automation');
  const c = s.connection;
  return {
    inbox: byLane,
    messages: { mail: messages.filter(x => x.data.channel === 'mail').length, chat: messages.filter(x => x.data.channel === 'chat').length },
    needsReply: attentionRows.filter(x => x.data.lane === 'reply').length,
    critical: attentionRows.filter(x => x.data.lane === 'critical').length,
    todayEvents: { timed: m.today.timed.length, allDay: m.today.allDay.length, remaining: m.remaining.length },
    automations: { total: automations.length, on: automations.filter(a => a.data.enabled !== false).length },
    commitments: records(s, 'commitment').length,
    notes: records(s, 'note').length,
    todayCards: active(s)?.layout?.length ?? 0,
    connection: c ? { status: c.status, capabilities: (c.enabled || []).slice().sort(), lastSync: c.lastSync ?? null, syncError: !!c.syncError } : null,
    revision: s.revision,
  };
}

/** The first-launch CodeMie sheet: whether it would open (prefs as they were before boot) and is. */
export function setupFacts(cm, prefsBefore = {}, prefsAfter = {}, sheetOpen = false) {
  return {
    cliLoaded: !!cm?.loaded,
    profiles: (cm?.profiles || []).length,
    signIn: cm?.auth?.state || null,
    introducedBefore: !!prefsBefore.introduced,
    wouldOpen: !!cm && shouldAutoOpen(cm, prefsBefore),
    sheetOpen: !!sheetOpen,
    attention: cm?.loaded ? attention(cm, prefsAfter.dismissed || new Set()).map(a => a.key) : [],
  };
}

// ---------------------------------------------------------------- what the live checks pick

/**
 * The conversation to draft a reply to: the newest that needs a reply (Outlook or Teams) and has
 * no AI draft, no saved reply and no draft on its way, so discarding the new draft leaves it as
 * it was. Not one of the user's own Outlook messages, which Review & send can't answer. When
 * every conversation that needs a reply has a draft already, the newest FYI or Waiting one
 * (never Low priority, which is automated mail) that has none.
 */
export function pickDraftTarget(s) {
  const usable = m => !m.data.unavailable && !m.data.deleted && !(m.data.channel === 'mail' && m.data.isMine);
  const empty = m => {
    const key = draftKeyOf(m);
    const job = draftJob(s, key);
    return !latestDraft(s, key) && !savedReply(s, m) && !(job && !FINISHED(job.state));
  };
  const newest = list => list.filter(usable).sort((a, b) => (b.data.at || 0) - (a.data.at || 0)).find(empty) || null;
  return newest(attentionMessages(s).filter(m => m.data.lane === 'reply'))
    || newest(collapseChats(visibleMessages(s).filter(m => ['fyi', 'waiting'].includes(m.data.lane))).items);
}

/** The mail thread to summarize: the newest long enough to offer Summarize, with no summary yet. */
export function pickSummaryThread(s) {
  const seen = new Set();
  for (const m of visibleMessages(s)) {
    if (m.data.channel !== 'mail' || m.data.unavailable || m.data.deleted) continue;
    const key = summaryKeyOf(m);
    if (seen.has(key)) continue;
    seen.add(key);
    const job = summaryJob(s, key);
    if (summaryFor(s, m) || (job && !FINISHED(job.state))) continue;
    if (summaryOffered(conversation(s, m))) return m;
  }
  return null;
}

/** An existing automation of this name is run as it is; else one is made from the template. */
export const BRIEF_NAME = TEMPLATES.find(t => t.id === 'morning-brief').name;

/** The Morning briefing automation, as the template makes it but off, so no schedule runs it. */
export function briefFromTemplate() {
  const template = TEMPLATES.find(t => t.id === 'morning-brief');
  return toAutomation(draftFromAutomation({ ...template.automation, enabled: false }));
}

// ---------------------------------------------------------------- the run

/**
 * Runs the smoke and returns the window's report. `invoke` is Connect's own; `store` a workspace
 * store over `recordOps(invoke, ops)`; `ops` what that store sent; `since` when the run started
 * (unix seconds); `setup()` the CodeMie facts once its boot is done; `ai()` the Claude state the
 * views use; `hidden()` the hidden calendars.
 */
export async function runStatusSmoke({
  invoke, store, ops = [], mode, runId, since, setup = async () => null, ai = () => ({}), hidden = () => new Set(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  syncTimeoutMs = 180000, pluginsTimeoutMs = 120000, jobTimeoutMs = 360000,
}) {
  const report = { runId: runId || null, mode, failed: [], waited: {}, sync: null, counts: null, setup: null, live: null };
  const snap = () => store.get()?.snapshot;
  try {
    let started = Date.now();
    const sync = await until(async () => firstSync((await store.refresh()).snapshot, since), syncTimeoutMs, wait);
    report.waited.syncMs = Date.now() - started;
    report.sync = sync || { state: 'still running' };
    if (!sync) report.failed.push(`the first sync didn't finish within ${syncTimeoutMs / 1000} s`);
    started = Date.now();
    const facts = await until(async () => {
      const f = await invoke('smoke_status_facts');
      return f?.plugins?.settled ? f : null;
    }, pluginsTimeoutMs, wait, 500);
    report.waited.pluginsMs = Date.now() - started;
    if (!facts) report.failed.push(`the plugin manager didn't settle within ${pluginsTimeoutMs / 1000} s`);
    await store.refresh();
    report.counts = counts(snap(), { hidden: hidden() });
    report.setup = await setup();
    if (mode === 'live') report.live = await live({ invoke, store, ops, snap, since, ai, wait, jobTimeoutMs, failed: report.failed });
  } catch (e) {
    report.failed.push(`the window: ${message(e)}`);
  }
  return report;
}

/** Waits for the job `id` to finish; its snapshot copy, or null after the timeout. */
async function finished(store, id, timeoutMs, wait) {
  return until(async () => {
    const job = (await store.refresh()).snapshot.jobs.find(j => j.id === id);
    return job && FINISHED(job.state) ? job : null;
  }, timeoutMs, wait);
}

const jobFacts = job => ({ jobState: job?.state || 'timeout', errorCode: job?.errorCode || null, errorClass: job?.errorClass || null });
const actions = async invoke => (await invoke('smoke_status_facts'))?.rows?.['records.action'] || 0;

async function live({ invoke, store, ops, snap, since, ai, wait, jobTimeoutMs, failed }) {
  const out = { actionsBefore: await actions(invoke) };
  out.draft = await draftCheck({ invoke, store, snap, wait, jobTimeoutMs }).catch(e => ({ status: 'failed', ...errorOf(e) }));
  out.summary = await summaryCheck({ invoke, store, snap, wait, jobTimeoutMs }).catch(e => ({ status: 'failed', ...errorOf(e) }));
  out.brief = await briefCheck({ store, snap, since, ai, wait, jobTimeoutMs }).catch(e => ({ status: 'failed', ...errorOf(e) }));
  out.actionsAfter = await actions(invoke);
  out.ops = [...new Set(ops)].sort();
  out.sendOps = ops.filter(op => SEND_OPS.has(op));
  if (out.sendOps.length) failed.push(`a send op was called: ${out.sendOps.join(', ')}`);
  if (out.actionsAfter !== out.actionsBefore) failed.push(`outgoing actions changed from ${out.actionsBefore} to ${out.actionsAfter}`);
  for (const step of ['draft', 'summary', 'brief']) {
    if (out[step].status === 'failed') failed.push(`${step}: ${out[step].why || out[step].error || out[step].jobState}`);
  }
  return out;
}

/** Removes what this run made (Rust checks it was made by this run), then confirms it is gone. */
async function discard(invoke, store, record, gone) {
  const { deleted } = await invoke('smoke_status_discard', {
    kind: record.kind, id: record.id, connectionId: record.connectionId || '', workspaceId: record.workspaceId || '',
  });
  const s = (await store.refresh()).snapshot;
  return { deleted: !!deleted, gone: gone(s) };
}

async function draftCheck({ invoke, store, snap, wait, jobTimeoutMs }) {
  const m = pickDraftTarget(snap());
  if (!m) return { status: 'skipped', why: 'no conversation needs a reply without a draft already' };
  const key = draftKeyOf(m);
  const out = { channel: m.data.channel, lane: m.data.lane };
  const started = Date.now();
  const queued = await store.mutate('ai_draft', draftRequest(m, defaultOptions(m.data.channel)));
  const job = await finished(store, queued.jobId, jobTimeoutMs, wait);
  Object.assign(out, jobFacts(job), { ms: Date.now() - started });
  const draft = latestDraft(snap(), key);
  if (draft) {
    const p = draft.data.provenance || {};
    Object.assign(out, {
      length: length(draft.data.text), questionsCount: (draft.data.questions || []).length,
      model: p.model || null, profile: p.profile || null, runMs: p.durationMs ?? null, partialText: !!p.partialText,
      readMessages: (p.messageIds || []).length,
    });
    // Discard: the conversation goes back to how it was, with no draft in its reply box.
    out.discarded = await discard(invoke, store, draft, s => !latestDraft(s, key));
  }
  const ok = job?.state === 'succeeded' && out.length > 0 && out.discarded?.gone;
  out.status = ok ? 'ok' : 'failed';
  if (!ok) out.why = !job ? 'the draft didn\'t finish in time' : job.state !== 'succeeded' ? `the draft ${job.state} (${job.errorCode || job.errorClass || 'no code'})` : !out.length ? 'the draft is empty' : 'the draft wasn\'t discarded';
  return out;
}

async function summaryCheck({ invoke, store, snap, wait, jobTimeoutMs }) {
  const m = pickSummaryThread(snap());
  if (!m) return { status: 'skipped', why: 'no mail thread is long enough to summarize without a summary already' };
  const out = { threadMessages: conversation(snap(), m).length };
  const started = Date.now();
  const queued = await store.mutate('ai_summarize', { sourceId: m.id });
  const job = await finished(store, queued.jobId, jobTimeoutMs, wait);
  Object.assign(out, jobFacts(job), { ms: Date.now() - started });
  const summary = summaryFor(snap(), m);
  if (summary) {
    const p = summary.data.provenance || {};
    const asks = summary.data.asks;
    Object.assign(out, {
      length: length(summary.data.text), paragraphs: String(summary.data.text || '').split(/\n\s*\n/).filter(x => x.trim()).length,
      asksCount: Array.isArray(asks) ? asks.length : null, asksWithDue: Array.isArray(asks) ? asks.filter(a => a?.due).length : null,
      model: p.model || null, profile: p.profile || null, runMs: p.durationMs ?? null, partialText: !!p.partialText,
      readMessages: (p.messageIds || []).length,
    });
    out.removed = await discard(invoke, store, summary, s => !summaryFor(s, m));
  }
  const ok = job?.state === 'succeeded' && out.length > 0 && out.asksCount !== null && out.removed?.gone;
  out.status = ok ? 'ok' : 'failed';
  if (!ok) out.why = !job ? 'the summary didn\'t finish in time' : job.state !== 'succeeded' ? `the summary ${job.state} (${job.errorCode || job.errorClass || 'no code'})` : !out.length ? 'the summary is empty' : out.asksCount === null ? 'the summary has no asks list' : 'the summary wasn\'t removed';
  return out;
}

async function briefCheck({ store, snap, since, ai, wait, jobTimeoutMs }) {
  const existing = records(snap(), 'automation').find(r => r.data.name === BRIEF_NAME);
  const layoutBefore = (active(snap())?.layout || []).slice();
  let id = existing?.id;
  const out = { created: !existing, existingOn: existing ? existing.data.enabled !== false : null };
  if (!existing) {
    const saved = await store.mutate('automation_save', briefFromTemplate());
    id = saved.record.id;
    out.todayCardAdded = !!saved.todayCard;
  }
  try {
    const started = Date.now();
    const queued = await store.mutate('automation_run_now', { id });
    const job = await finished(store, queued.jobId, jobTimeoutMs, wait);
    Object.assign(out, jobFacts(job), { ms: Date.now() - started });
    const page = await store.query('automation_runs', { automationId: id, limit: 5 });
    const run = (page.runs || []).find(r => (r.data.startedAt || 0) >= since);
    out.runLog = { found: !!run, runsListed: (page.runs || []).length };
    if (run) {
      const d = run.data;
      const o = d.output || {};
      Object.assign(out, {
        runId: run.id, runStatus: d.status, durationMs: d.durationMs ?? null, model: d.model || null, profile: d.profile || null,
        costUsd: d.costUsd ?? null, delivered: d.delivered || [], blocks: (o.summaryBlocks || []).length, itemsCount: (o.items || []).length,
        sourcesCount: (d.sources || []).length, trigger: d.trigger?.kind || null,
      });
      const s = snap();
      out.todayCard = {
        onLayout: (active(s)?.layout || []).includes('automations'),
        showsRun: automationResultsCard(s, ai()).includes(`data-id="${run.id}"`),
      };
    }
    const ok = job?.state === 'succeeded' && run?.data.status === 'ok' && out.todayCard?.showsRun;
    out.status = ok ? 'ok' : 'failed';
    if (!ok) out.why = !job ? 'the run didn\'t finish in time' : !run ? `no run in the Run log (job ${job.state}, ${job.errorCode || job.errorClass || 'no code'})` : run.data.status !== 'ok' ? `the run ${run.data.status}` : 'Today\'s card doesn\'t show the run';
  } finally {
    if (!existing && id) {
      await store.mutate('automation_delete', { id });
      const s = (await store.refresh()).snapshot;
      out.deleted = !records(s, 'automation').some(r => r.id === id);
      out.layoutUnchanged = JSON.stringify(active(s)?.layout || []) === JSON.stringify(layoutBefore);
    }
  }
  return out;
}
