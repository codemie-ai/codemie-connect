// Browser end-to-end check of the workspace UI: the real ui/ modules in Chromium with an
// explicitly MOCKED native bridge (window.__TAURI__). It proves rendering, navigation and UI
// flows; it is not evidence of native Graph, storage or notification behaviour.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs
//
// Screenshots go to output/playwright/workspace-e2e/ (git-ignored). Exit code 1 on any failure.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSnapshot, aiStatus, aiUsage, contractFixtures, dataLocation, folderCheck, CHECKS, automationContract, withAutomations, pluginContract } from '../fixtures/workspace-fixture.mjs';
import { pluginChecks } from './plugins-checks.mjs';

const UI = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('../../../output/playwright/workspace-e2e/', import.meta.url));
const core = process.env.PLAYWRIGHT_CORE;
const playwright = await import(core ? pathToFileURL(join(core, 'index.js')).href : 'playwright-core');
const chromium = playwright.chromium || playwright.default.chromium;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' };
// Plugin frames: Chromium has no connect-plugin:// scheme, so the stand-in serves
// /plugin-frames/<id>/__host/* from ui/plugins/frame/ and /plugin-frames/<id>/* from the synthetic
// plugins in ui/test/fixtures/plugins/, with the frame headers native sends (CSP naming the origin,
// ACAO null for module loads from the opaque frame).
const FRAMES = 'plugin-frames/';
function framePath(path) {
  const [id, ...rest] = path.slice(FRAMES.length).split('/');
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(id) || rest.some(s => !s || s.startsWith('.'))) return null;
  return rest[0] === '__host' ? join('plugins/frame', ...rest.slice(1)) : join('test/fixtures/plugins', id, ...rest);
}
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  try {
    if (path.startsWith(FRAMES)) {
      const file = framePath(path);
      if (!file) throw new Error('not a plugin file');
      const body = await readFile(join(UI, file));
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] || 'application/octet-stream',
        'access-control-allow-origin': 'null',
        'content-security-policy': `default-src ${origin}; script-src ${origin}; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; connect-src 'none'`,
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
      return;
    }
    const body = await readFile(join(UI, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/index.html`;
await mkdir(OUT, { recursive: true });

// ---------------------------------------------------------------- mocked native bridge

function installBridge({ snapshot, connected, ai: aiInit, usage, testOk, testFail, draft: mailDraft, draftChat: chatDraft, jobFailed: jobTemplate, summary: summaryTemplate, storage, unavailable, location: locationInit, checks, automation: automationTemplates, plugins: pluginInit, frameBase }) {
  // Connect's window only: a plugin frame gets nothing of the native bridge.
  if (window.top !== window) return;
  const s = snapshot;
  // Automation runs live beside the snapshot, as in native: the snapshot shows each
  // automation's latest run and its latest run on Today; `automation_runs` pages through all.
  let allRuns = s.records.filter(r => r.kind === 'automation_run');
  s.records = s.records.filter(r => r.kind !== 'automation_run');
  const startedOf = r => r.data.startedAt || 0;
  const shownRuns = () => {
    const keep = new Map();
    for (const r of [...allRuns].sort((a, b) => startedOf(b) - startedOf(a))) {
      const id = r.data.automationId;
      if (!keep.has(`${id}:latest`)) keep.set(`${id}:latest`, r);
      if ((r.data.delivered || []).includes('today') && !keep.has(`${id}:today`)) keep.set(`${id}:today`, r);
    }
    return [...new Set(keep.values())];
  };
  const ai = aiInit;
  const location = locationInit;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let authPending = false;
  const calls = [];
  const listeners = {};
  const clone = x => JSON.parse(JSON.stringify(x));
  const now = () => Math.floor(Date.now() / 1000);
  const emit = name => setTimeout(() => (listeners[name] || []).forEach(fn => fn({ payload: {} })), 10);
  const active = wid => s.workspaces.find(w => w.id === (wid || s.settings.activeWorkspace));
  const find = (kind, id) => s.records.find(r => r.kind === kind && r.id === id);
  const fail = (code, message, cls) => { throw cls ? { code, message, class: cls } : { code, message }; };
  const ops = {
    snapshot: () => ({ snapshot: { ...clone(s), records: [...clone(s.records), ...clone(shownRuns())] }, authPending, authError: null }),
    settings_update: d => {
      if (d.capabilities) s.connection.enabled = d.capabilities;
      for (const [k, v] of Object.entries(d)) if (k !== 'capabilities') s.settings[k] = v;
      return { saved: true };
    },
    local_save: (d, wid) => {
      const id = d.id || crypto.randomUUID();
      const existing = s.records.find(r => r.id === id && r.kind === d.kind);
      const data = { ...d };
      if (existing) existing.data = data; else s.records.push({ id, kind: d.kind, source: 'local', data, connectionId: null, workspaceId: wid, revision: id, updatedAt: now() });
      if (existing) existing.updatedAt = now();
      return { id };
    },
    local_delete: d => { s.records = s.records.filter(r => !(r.kind === d.kind && r.id === d.id)); return { deleted: true }; },
    draft_save: (d, wid) => ops.local_save({ ...d, kind: 'draft', id: `manual:${d.sourceId}` }, wid),
    layout_save: (d, wid) => { const w = active(wid); w.layout = [...new Set(d.layout)]; w.widgetWidths = d.widgetWidths; return { saved: true }; },
    workspace_create: d => { const id = crypto.randomUUID(); s.workspaces.push({ id, name: d.name, color: d.color, archived: false, isDefault: false, connectionId: s.connection?.id || null, sources: { all: true }, layout: ['brief', 'calendar', 'inbox', 'commitments', 'focus'], widgetWidths: {} }); s.settings.activeWorkspace = id; return { id }; },
    workspace_update: (d, wid) => { Object.assign(active(wid), d); if (d.archived && s.settings.activeWorkspace === wid) s.settings.activeWorkspace = 'personal'; return { saved: true }; },
    workspace_select: d => { s.settings.activeWorkspace = d.id; return { selected: true }; },
    inbox_decision: d => {
      const m = find('message', d.id);
      if (d.action === 'lane') m.data.lane = d.lane;
      if (d.action === 'archive') m.data.lifecycle = 'archived';
      if (d.action === 'restore') m.data.lifecycle = 'open';
      if (d.action === 'snooze') m.data.snoozedUntil = d.until;
      if (d.action === 'acknowledge' || d.acknowledge) m.data.acknowledgedAt = now();
      return { saved: true };
    },
    graph_connect: d => {
      calls.push(['graph_connect', d]);
      authPending = true;
      setTimeout(() => {
        authPending = false;
        Object.assign(s, connected, { settings: { ...connected.settings, theme: s.settings.theme } });
        emit('connection:changed');
      }, 900);
      return { status: 'authorizing' };
    },
    graph_cancel: () => { authPending = false; return { cancelled: true }; },
    graph_disconnect: () => { s.connection = null; s.available = false; s.settings.activeConnection = null; s.records = s.records.filter(r => !r.connectionId); s.jobs = []; return { disconnected: true }; },
    graph_bind: () => { active().connectionId = s.connection.id; return { bound: true }; },
    sync_request: () => {
      const job = { id: crypto.randomUUID(), kind: 'sync', state: 'running', dueAt: now(), attempts: 1, connectionId: s.connection?.id, policy: {}, payload: { force: true }, result: 'Refreshing Calendar events…' };
      s.jobs.unshift(job);
      setTimeout(() => { job.state = 'succeeded'; job.result = 'Sources refreshed'; s.connection.lastSync = now(); s.revision++; emit('workspace:changed'); }, 700);
      return { queued: true };
    },
    calendar_window: () => ({ queued: true }),
    open_source: d => { calls.push(['open_source', d]); return { opened: true }; },
    schedule_save: (d, wid) => ops.local_save({ ...d, kind: 'schedule', nextAt: now() + 3600 }, wid),
    schedule_delete: d => ops.local_delete({ ...d, kind: 'schedule' }),
    job_cancel: d => {
      calls.push(['job_cancel', d]);
      const job = s.jobs.find(j => j.id === d.id);
      if (job && !['queued', 'running', 'blocked'].includes(job.state)) fail('conflict', 'This job already completed.');
      if (job) job.state = 'cancelled';
      return { saved: true };
    },
    job_retry: () => ({ saved: true }),
    notification_permission: () => ({ permission: 'os_managed' }),
    notification_test: () => ({ queued: true }),
    export: () => ({ version: 1, workspaces: [], records: [] }),
    ai_status: () => ({ profiles: clone(ai.profiles), settings: clone(ai.settings) }),
    ai_usage: () => clone(usage),
    ai_settings_save: d => {
      calls.push(['ai_settings_save', d]);
      const known = id => ai.profiles.some(p => p.id === id);
      if (d.defaultProfile && !known(d.defaultProfile)) fail('validation', 'Choose one of the listed Claude profiles.');
      ai.settings = { defaultProfile: d.defaultProfile || null, routes: d.routes || {} };
      return { settings: clone(ai.settings) };
    },
    ai_test: async d => {
      calls.push(['ai_test', d]);
      await sleep(700);
      const p = ai.profiles.find(x => x.id === d.profileId);
      if (!p) fail('validation', 'Choose one of the listed Claude profiles.');
      if (p.state !== 'ready') return { ...testFail, message: p.message || testFail.message };
      return clone(testOk);
    },
    action_prepare: d => {
      calls.push(['action_prepare', d]);
      const m = find('message', d.sourceId);
      if (!s.connection.enabled.includes(d.kind === 'chat_reply' ? 'chat_send' : 'mail_send')) fail('permission_required', 'Allow replies in Settings first.');
      return { actionId: 'action-1', nonce: 'nonce-1', workspaceId: 'personal', account: s.connection.email, review: { title: `Reply to ${m.data.from}`, recipients: [{ emailAddress: { name: m.data.from, address: m.data.fromAddress || m.data.fromId } }], body: d.body } };
    },
    action_confirm: d => { calls.push(['action_confirm', d]); return { message: 'Sent for delivery.' }; },
    // AI drafts: queued → running (profile, model, startedAt) → a draft record, or the failure
    // in `window.__draftPlan`; `hold` keeps it running until `window.__finishDraft(plan)`.
    ai_draft: d => {
      calls.push(['ai_draft', d]);
      const m = find('message', d.sourceId);
      const chat = m.data.channel === 'chat';
      const purpose = chat ? 'chat_draft' : 'mail_draft';
      const route = ai.settings.routes?.[purpose] || {};
      const profile = route.profile || ai.settings.defaultProfile;
      if (!profile) fail('needs_choice', 'Choose which Claude should write for you.', 'needs_choice');
      const key = chat ? `chat:${m.data.conversationId || m.source}` : m.id;
      const busy = s.jobs.find(j => j.kind === 'ai_draft' && j.payload.draftKey === key && ['queued', 'running'].includes(j.state));
      if (busy) return { queued: true, jobId: busy.id };
      const { errorClass, errorCode, ...base } = clone(jobTemplate);
      const job = { ...base, id: crypto.randomUUID(), key: `ai_draft:${crypto.randomUUID()}`, state: 'queued', dueAt: now(), connectionId: s.connection.id, result: null, payload: { request: { ...d }, channel: m.data.channel, conversationKey: key, draftKey: key, purpose } };
      s.jobs.unshift(job);
      const plan = window.__draftPlan || { outcome: 'ok', ms: 1200 };
      const update = () => { s.revision++; emit('workspace:changed'); };
      const start = () => {
        if (job.state !== 'queued') return;
        job.state = 'running';
        Object.assign(job.payload, { startedAt: now() - (plan.startedAgo || 0), profile, model: route.model || null });
        // Claude names its model a moment after it starts (`runModel`); CodeMie takes longer.
        setTimeout(() => {
          if (job.state !== 'running') return;
          job.payload.runModel = profile.startsWith('codemie:') ? 'claude-sonnet-4-5' : 'claude-sonnet-4-5-20250929';
          update();
        }, profile.startsWith('codemie:') ? 2500 : 400);
      };
      const finish = (result = plan) => {
        start();
        if (job.state !== 'running') return;
        if (result.outcome === 'ok') {
          const thread = s.records.filter(r => r.kind === 'message' && r.data.conversationId === m.data.conversationId).sort((a, b) => a.data.at - b.data.at).slice(-12);
          // A Teams draft is short with no greeting or sign-off; an Outlook draft is a letter.
          const t = clone(chat ? chatDraft : mailDraft);
          const record = { ...t, id: `ai:${key}`, connectionId: s.connection.id, workspaceId: 'personal', source: m.source, revision: crypto.randomUUID(), updatedAt: now(), data: { ...t.data, text: result.text || t.data.text, questions: result.questions || t.data.questions, channel: m.data.channel, sourceId: m.id, draftKey: key, conversationKey: key, options: { ...d }, provenance: { ...t.data.provenance, profile, model: job.payload.runModel || job.payload.model || t.data.provenance.model, messageIds: thread.map(x => x.id), partialText: !!result.partialText } } };
          s.records = s.records.filter(r => r.id !== record.id).concat(record);
          job.state = 'succeeded';
          job.result = 'AI draft ready for review';
        } else {
          Object.assign(job, { state: result.state || 'failed', errorClass: result.errorClass, errorCode: result.errorCode || result.errorClass, result: 'Claude could not draft.' });
        }
        update();
      };
      setTimeout(() => { if (job.state === 'queued') { start(); update(); } }, 150);
      window.__finishDraft = finish;
      if (plan.outcome !== 'hold') setTimeout(() => finish(plan), 150 + (plan.ms || 1200));
      return { queued: true, jobId: job.id };
    },
    // AI summaries: like drafts, `window.__summaryPlan` picks the outcome and `hold` keeps the job
    // running until `window.__finishSummary(plan)`; `window.__setSummaryStale(true)` is a new message.
    ai_summarize: d => {
      calls.push(['ai_summarize', d]);
      const m = find('message', d.sourceId);
      const route = ai.settings.routes?.summary || {};
      const profile = route.profile || ai.settings.defaultProfile;
      if (!profile) fail('needs_choice', 'Choose which Claude should write for you.', 'needs_choice');
      const key = m.data.channel === 'chat' ? `chat:${m.data.conversationId || m.source}` : m.data.conversationId ? `mail:${m.data.conversationId}` : m.id;
      const busy = s.jobs.find(j => j.kind === 'ai_summarize' && j.payload.conversationKey === key && ['queued', 'running'].includes(j.state));
      if (busy) return { queued: true, jobId: busy.id };
      const { errorClass, errorCode, ...base } = clone(jobTemplate);
      const job = { ...base, id: crypto.randomUUID(), key: `ai_summarize:${crypto.randomUUID()}`, kind: 'ai_summarize', state: 'queued', dueAt: now(), connectionId: s.connection.id, result: null, payload: { request: { ...d }, channel: m.data.channel, conversationKey: key, purpose: 'summary' } };
      s.jobs.unshift(job);
      const plan = window.__summaryPlan || { outcome: 'ok', ms: 1200 };
      const update = () => { s.revision++; emit('workspace:changed'); };
      const start = () => {
        if (job.state !== 'queued') return;
        job.state = 'running';
        Object.assign(job.payload, { startedAt: now() - (plan.startedAgo || 0), profile, model: route.model || null });
        setTimeout(() => { if (job.state === 'running') { job.payload.runModel = 'claude-haiku-4-5'; update(); } }, 400);
      };
      const finish = (result = plan) => {
        start();
        if (job.state !== 'running') return;
        if (result.outcome === 'ok') {
          const thread = s.records.filter(r => r.kind === 'message' && r.data.conversationId === m.data.conversationId).sort((a, b) => a.data.at - b.data.at);
          const t = clone(summaryTemplate);
          const record = { ...t, id: key, connectionId: s.connection.id, workspaceId: 'personal', source: m.source, revision: crypto.randomUUID(), updatedAt: now(), data: { ...t.data, conversationKey: key, channel: m.data.channel, sourceId: m.id, text: result.text || t.data.text, asks: result.asks || t.data.asks, stale: false, latestMessageId: thread.at(-1).id, provenance: { ...t.data.provenance, profile, model: 'claude-haiku-4-5', messageIds: thread.map(x => x.id), durationMs: 3200, partialText: !!result.partialText } } };
          s.records = s.records.filter(r => !(r.kind === 'summary' && r.id === key)).concat(record);
          job.state = 'succeeded';
          job.result = 'Summary ready';
        } else {
          Object.assign(job, { state: result.state || 'failed', errorClass: result.errorClass, errorCode: result.errorCode || result.errorClass, result: 'Claude could not summarize.' });
        }
        update();
      };
      setTimeout(() => { if (job.state === 'queued') { start(); update(); } }, 150);
      window.__finishSummary = finish;
      if (plan.outcome !== 'hold') setTimeout(() => finish(plan), 150 + (plan.ms || 1200));
      return { queued: true, jobId: job.id };
    },
  };
  // Automations (DESIGN 6.6): saved like native (backend sentences for mistakes); Run now queues
  // a job that runs and stores a run from the contract fixture, or the failure in
  // `window.__automationPlan` ({ outcome: 'fail' }).
  Object.assign(ops, {
    automation_save: d => {
      calls.push(['automation_save', d]);
      const invalid = (field, message) => { throw { code: 'validation', field, message }; };
      if (!String(d.name || '').trim()) invalid('name', 'Give the automation a name (up to 80 characters).');
      if (!String(d.prompt || '').trim()) invalid('prompt', 'Write the instructions for the automation.');
      if (d.trigger?.kind === 'schedule' && !(d.trigger.days || []).length) invalid('days', 'Choose at least one day for the schedule.');
      if (['mail_from', 'chat_from'].includes(d.trigger?.event) && !(d.trigger.senders || []).length) invalid('senders', 'Add at least one sender or domain for this trigger.');
      const id = d.id || crypto.randomUUID();
      const before = find('automation', id);
      const record = { id, kind: 'automation', source: 'local', connectionId: null, workspaceId: 'personal', revision: crypto.randomUUID(), updatedAt: now(), data: { ...d, id, name: d.name.trim() } };
      s.records = s.records.filter(r => !(r.kind === 'automation' && r.id === id)).concat(record);
      // As native: turning Today delivery on puts the card on Today in the same save.
      const w = active('personal');
      const wasOn = before?.data.deliver?.today === true && before?.data.enabled !== false;
      const todayCard = d.enabled !== false && !!d.deliver?.today && !wasOn && !w.layout.includes('automations') && w.layout.length < 16;
      if (todayCard) w.layout = [...w.layout, 'automations'];
      return { record, todayCard };
    },
    automation_toggle: d => {
      calls.push(['automation_toggle', d]);
      const r = find('automation', d.id);
      r.data.enabled = d.enabled;
      return { record: r };
    },
    automation_delete: d => {
      calls.push(['automation_delete', d]);
      s.records = s.records.filter(r => !(r.kind === 'automation' && r.id === d.id));
      allRuns = allRuns.filter(r => r.data.automationId !== d.id);
      return { deleted: true };
    },
    automation_run_now: d => {
      calls.push(['automation_run_now', d]);
      const a = find('automation', d.id);
      if (s.jobs.some(j => j.kind === 'automation_run' && j.payload.automationId === d.id && ['queued', 'running'].includes(j.state))) fail('conflict', 'This automation is already running.');
      const job = { id: crypto.randomUUID(), kind: 'automation_run', key: `automation:${d.id}:manual`, state: 'queued', dueAt: now(), workspaceId: 'personal', connectionId: null, attempts: 0, policy: {}, payload: { automationId: d.id, title: a.data.name, trigger: { kind: 'manual' } }, result: null };
      s.jobs.unshift(job);
      const plan = window.__automationPlan || { outcome: 'ok', ms: 1500 };
      const update = () => { s.revision++; emit('workspace:changed'); };
      setTimeout(() => { job.state = 'running'; job.payload.startedAt = now(); update(); }, 150);
      setTimeout(() => {
        if (job.state !== 'running') return;
        const ok = plan.outcome !== 'fail';
        const t = clone(ok ? automationTemplates.runOk : automationTemplates.runFailed);
        const delivered = ok ? [a.data.deliver?.today && 'today', a.data.deliver?.notify && 'notification_queued'].filter(Boolean) : [];
        allRuns.push({ ...t, id: job.id, updatedAt: now(), data: { ...t.data, automationId: a.id, automationName: a.data.name, connectionId: s.connection?.id || null, startedAt: now() - 2, trigger: { kind: 'manual' }, delivered } });
        Object.assign(job, { state: ok ? 'succeeded' : 'failed', result: ok ? 'Automation ran' : 'Claude Code is not signed in.' });
        update();
      }, 150 + (plan.ms || 1500));
      return { queued: true, jobId: job.id };
    },
    automation_runs: d => {
      const limit = d.limit || 20;
      const runs = allRuns.filter(r => !d.automationId || r.data.automationId === d.automationId)
        .sort((a, b) => startedOf(b) - startedOf(a) || (b.id < a.id ? -1 : 1));
      const from = d.before ? runs.findIndex(r => `${startedOf(r)}:${r.id}` === d.before) + 1 : 0;
      const page = runs.slice(from, from + limit);
      const next = runs.length > from + limit ? `${startedOf(page.at(-1))}:${page.at(-1).id}` : null;
      return { runs: page, next };
    },
  });
  // Plugins (`plugins_request`, `plugin_call`): an in-memory registry over the contract answers.
  // `__pluginCalls` records what reached native, with the plugin id it went out with.
  const pl = {
    markets: clone(pluginInit.markets), installed: [], storage: {}, addresses: {}, signedIn: {},
    calls: [], loadErrors: {},
  };
  window.__pluginCalls = pl.calls;
  // Why a plugin's host half didn't load, as the manager would say (`installed` answers it).
  window.__setPluginLoadError = (id, text) => { pl.loadErrors[id] = text; };
  const helloView = () => {
    const m = pluginInit.hello.manifest;
    const p = pl.installed.find(x => x.id === 'hello');
    return {
      id: m.id, name: m.name, version: m.version, summary: m.summary, market: p.market, source: p.source, commit: null,
      hash: '5eed5eed', enabled: p.enabled, agreed: p.agreed, installedAt: '2026-11-17T09:30:00Z', update: null, problem: null,
      client: m.client, widgets: m.widgets.map(w => ({ id: w.id, label: w.label, about: w.about || '', kind: w.kind, sizes: w.sizes || [] })),
      signin: [{ host: 'github.com', signedIn: !!pl.signedIn.hello, from: pl.signedIn.hello ? 'gh' : null }],
      addresses: m.settings.map(x => ({ key: x.key, label: x.label, help: x.help || null, value: pl.addresses[x.key] || '' })),
      ...(pl.loadErrors[m.id] && p.enabled ? { loadError: pl.loadErrors[m.id] } : {}),
    };
  };
  const offerOf = market => {
    const installed = pl.installed.find(x => x.id === 'hello');
    return [{ ...pluginInit.hello.offer, installed: installed && installed.market === market ? pluginInit.hello.offer.version : null }, ...clone(pluginInit.others)];
  };
  const marketOf = name => {
    const m = pl.markets.find(x => x.name === name);
    if (!m) fail('not_found', `There is no marketplace “${name}”.`);
    return m;
  };
  const pluginOps = {
    markets: () => pl.markets,
    pick_folder: () => ({ path: '/Users/qa/Plugins/acme-market' }),
    market_add: d => {
      if (!d.source.startsWith('/')) fail('invalid', 'The stand-in adds folders only.');
      const m = { builtIn: false, commit: null, fetchedAt: null, kind: 'local', name: 'acme', ready: true, ref: null, source: d.source };
      pl.markets.push(m);
      return m;
    },
    market_refresh: d => marketOf(d.market),
    market_remove: d => { pl.markets = pl.markets.filter(m => m.name !== d.market || m.builtIn); return pl.markets; },
    catalog: d => ({ market: marketOf(d.market), plugins: marketOf(d.market).ready ? offerOf(d.market) : [] }),
    inspect: d => {
      const o = offerOf(d.market).find(x => x.id === d.id);
      if (!o) fail('not_found', `The “${d.market}” marketplace has no plugin “${d.id}”.`);
      const sheet = d.id === 'hello' ? pluginInit.hello.sheet : [{ key: 'knowledge', support: { status: 'blocking', limit: "Needs Connect's Knowledge engine (coming later)" }, text: 'Read and change your notes vaults' }];
      return { ...o, market: d.market, source: marketOf(d.market).source, commit: null, sheet, sheetHash: d.id === 'hello' ? pluginInit.hello.sheetHash : 'k' };
    },
    install: d => {
      if (d.id !== 'hello') fail('blocked', 'It can’t be installed.');
      if (d.sheetHash !== pluginInit.hello.sheetHash) fail('changed', 'The permission sheet of “hello” changed.');
      if (d.agreed.length !== pluginInit.hello.sheet.length) fail('consent_required', 'Agree to every line of the permission sheet to install “hello”.');
      pl.installed.push({ id: 'hello', market: d.market, source: marketOf(d.market).source, enabled: true, agreed: [...d.agreed].sort() });
      return { status: 'installed', plugin: helloView() };
    },
    installed: () => (pl.installed.length ? [helloView()] : []),
    set_enabled: d => { pl.installed.find(x => x.id === d.id).enabled = d.enabled; return helloView(); },
    update: () => fail('up_to_date', '“hello” is up to date (1.0.0).'),
    remove: d => { pl.installed = pl.installed.filter(x => x.id !== d.id); return { removed: d.id, deletedData: !!d.deleteData }; },
    signin: d => { pl.signedIn[d.id] = true; return clone(pluginInit.signin.signin); },
    signout: d => { delete pl.signedIn[d.id]; return clone(pluginInit.signin.signout); },
    set_addresses: d => { pl.addresses[d.key] = d.value.trim(); return helloView(); },
    client_storage: d => {
      if (d.items) pl.storage[d.id] = clone(d.items);
      return { items: clone(pl.storage[d.id] || {}) };
    },
  };
  // A native event, as when the user clicks a notification.
  window.__emitNative = (name, payload) => (listeners[name] || []).forEach(fn => fn({ payload }));
  window.__setSummaryStale = value => { for (const r of s.records) if (r.kind === 'summary') r.data.stale = value; s.revision++; emit('workspace:changed'); };
  window.__bridgeCalls = calls;
  // What detection finds next time (Claude signed in or set up meanwhile).
  window.__setAiProfiles = profiles => { ai.profiles = profiles; };
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        if (cmd === 'smoke_mode') return { smoke: false, probe: false, dev: true, pluginFrameBase: frameBase };
        if (cmd === 'plugins_request') {
          const op = pluginOps[args.op];
          if (!op) throw { code: 'invalid', message: `Mock does not implement plugin request ${args.op}` };
          await sleep(40);
          return clone(op(args.data || {}));
        }
        if (cmd === 'plugin_call') {
          pl.calls.push(clone(args));
          const p = pl.installed.find(x => x.id === args.id);
          if (!p || !p.enabled) throw { code: 'not_found', message: `“${args.id}” isn't on in Connect` };
          if (args.command === 'greet') return { text: `Hello, ${args.args?.name || 'you'}`, from: 'CodeMie Connect' };
          throw { code: 'not_found', message: `${args.id} has no command “${args.command}”` };
        }
        if (cmd === 'runtime_ready') return false;
        if (cmd === 'get_app_version') return '2.2.0';
        if (cmd === 'check_for_update') return null;
        if (cmd === 'workspace_installer_busy') return null;
        // Data folder (DESIGN 8): `unavailable` is a workspace that never opened; `__storageFail`
        // makes every later workspace call fail as when the drive goes away while Connect runs.
        if (cmd === 'storage_status') return clone(storage);
        if (cmd === 'app_relaunch') { calls.push(['app_relaunch']); return null; }
        if (cmd === 'data_location_use_default') {
          calls.push(['data_location_use_default']);
          if (window.__useDefaultError) throw { code: 'io', message: window.__useDefaultError };
          return null;
        }
        // Settings → Data location, from the Rust contract fixtures. `__pick` is what the folder
        // picker returns ({ path, check }: the check fixture for that folder; null cancels);
        // `__changeHold` keeps a change running until `__finishChange()`; `__changeError` fails it.
        if (cmd === 'data_location_get') return clone(location);
        if (cmd === 'data_location_pick') { calls.push(['data_location_pick']); return window.__pick?.path ?? null; }
        if (cmd === 'data_location_check') {
          calls.push(['data_location_check', args]);
          await sleep(150);
          return clone(checks[window.__pick?.check || 'ok']);
        }
        if (cmd === 'data_location_reveal') { calls.push(['data_location_reveal', args]); return null; }
        if (cmd === 'close_app') { calls.push(['close_app']); return null; }
        if (cmd === 'data_location_change') {
          calls.push(['data_location_change', args]);
          if (window.__changeHold) await new Promise(resolve => { window.__finishChange = resolve; });
          else await sleep(300);
          if (window.__changeError) throw clone(window.__changeError);
          return { restarting: true };
        }
        if (cmd === 'data_location_remove_old') {
          calls.push(['data_location_remove_old']);
          await sleep(200);
          const removedBytes = location.previousSizeBytes;
          Object.assign(location, { previous: null, previousExists: false, previousCopied: false, previousSizeBytes: 0 });
          return { removedBytes };
        }
        if (cmd !== 'workspace_request') throw new Error(`Unexpected native command ${cmd}`);
        if (unavailable) throw { code: 'storage_unavailable', message: 'Workspace storage is unavailable; existing tools are still accessible.' };
        if (window.__storageFail) throw { code: 'storage_unavailable', message: 'Connect lost access to its data folder.' };
        const r = args.request;
        // Fake background sync: bump the revision once so the next fenced write is stale.
        if (window.__syncBump && r.op !== 'snapshot') { window.__syncBump = false; s.revision++; }
        if (r.op !== 'snapshot' && r.expectedRevision !== undefined && r.expectedRevision !== s.revision) throw { code: 'stale_view', message: 'This view changed.' };
        const op = ops[r.op];
        if (!op) throw { code: 'validation', message: `Mock does not implement ${r.op}` };
        const result = await op(r.data || {}, r.workspaceId);
        if (r.op !== 'snapshot' && !['ai_status', 'ai_usage', 'ai_test', 'automation_runs'].includes(r.op)) { s.revision++; emit('workspace:changed'); }
        return clone(result);
      },
    },
    event: { async listen(name, fn) { (listeners[name] ||= []).push(fn); return () => {}; } },
  };
}

// ---------------------------------------------------------------- checks

const results = [];
let currentPage;
const check = async (name, fn) => {
  try {
    if (currentPage) for (let i = 0; i < 3 && await currentPage.locator('.ws-modal[open]').count(); i++) await currentPage.keyboard.press('Escape');
    await fn();
    results.push(['PASS', name]);
    console.log(`✔ ${name}`);
  } catch (error) {
    results.push(['FAIL', name, error.message.split('\n')[0]]);
    const toasts = await currentPage?.locator('.ws-toast').allInnerTexts().catch(() => []) || [];
    console.log(`✖ ${name} — ${error.message.split('\n')[0]}${toasts.length ? ` (toasts: ${toasts.join(' | ')})` : ''}`);
    await currentPage?.screenshot({ path: join(OUT, `FAIL-${name.replace(/[^a-z0-9]+/gi, '-')}.png`) }).catch(() => {});
  }
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };

const browser = await chromium.launch();
const DEFAULT_ROOT = '/Users/qa/Library/Application Support/com.epam.codemie.connect/workspace';
const CUSTOM_ROOT = '/Volumes/Work Drive/Projects/CodeMie Connect Data';
const storageOf = (status, extra = {}) => ({ status, dataRoot: CUSTOM_ROOT, privateRoot: DEFAULT_ROOT, defaultRoot: DEFAULT_ROOT, custom: true, ...extra });
const STORAGE = {
  missing: storageOf('missing'),
  no_marker: storageOf('no_marker'),
  marker_mismatch: storageOf('marker_mismatch'),
  not_writable: storageOf('not_writable'),
  pointer_unreadable: storageOf('pointer_unreadable', { dataRoot: DEFAULT_ROOT, custom: false }),
  ready: storageOf('ready', { dataRoot: DEFAULT_ROOT, custom: false, issue: 'Another Connect process owns this workspace. Return to its window.' }),
  disk_full: storageOf('not_writable', { issue: 'The disk that holds your data folder is full.' }),
};

async function open({ theme = 'dark', width = 1440, height = 900, start = 'connected', hash = '#/today', ai = 'both', aiDefault, enable = [], longThread = false, storage = storageOf('ready', { dataRoot: DEFAULT_ROOT, custom: false }), unavailable = false, location = 'default', automations = false, pluginRecords = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  const now = Date.now();
  const connected = buildSnapshot(now, { theme, zone: 'Europe/Kyiv' });
  connected.connection.enabled.push(...enable);
  if (longThread) {
    // Priya's roadmap thread grows from two messages to five.
    const first = connected.records.find(r => r.id === 'm-reply-1');
    ['Thanks. Could you also send Jordan the draft?', 'Also, please book the review room for Thursday.', 'One more thing: the comments are due Friday 20 November.'].forEach((text, i) => connected.records.push({ ...first, id: `m-long-${i}`, revision: `r-long-${i}`, data: { ...first.data, text, at: first.data.at + 120 * (i + 1), lane: 'fyi', isRead: true } }));
  }
  if (automations) withAutomations(connected, now);
  if (pluginRecords) connected.records.push(...pluginRecords(now));
  const snapshot = start === 'connected' ? connected : buildSnapshot(now, { connected: false, theme, zone: 'Europe/Kyiv' });
  const { testOk, testFail, draft, draftChat, jobFailed, summary } = contractFixtures();
  const checks = Object.fromEntries(CHECKS.map(name => [name, folderCheck(name)]));
  await page.addInitScript(`(${installBridge})(${JSON.stringify({ snapshot, connected, ai: aiStatus(ai, aiDefault === undefined ? {} : { defaultProfile: aiDefault }), usage: aiUsage(), testOk, testFail, draft, draftChat, jobFailed, summary, storage, unavailable, location: dataLocation(location), checks, automation: automationContract(), plugins: pluginContract(), frameBase: `${base.replace(/index\.html$/, '')}plugin-frames/` })})`);
  await page.goto(base + hash);
  await page.waitForSelector(unavailable ? '.ws-recovery' : '.ws-sidebar');
  currentPage = page;
  return { page, context, errors };
}
const shot = async (page, name) => {
  await page.evaluate(() => document.querySelectorAll('.ws-toast').forEach(t => t.remove()));
  return page.screenshot({ path: join(OUT, `${name}.png`) });
};
const text = (page, selector) => page.locator(selector).first().innerText();

// `WORKSPACE_E2E_ONLY=plugins` runs the plugin checks alone (they run last otherwise).
if (process.env.WORKSPACE_E2E_ONLY === 'plugins') {
  await pluginChecks({ open, check, assert, shot, OUT });
  await browser.close();
  server.close();
  const failedOnly = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failedOnly}/${results.length} browser checks passed. Screenshots: ${OUT}`);
  process.exit(failedOnly ? 1 : 0);
}

for (const theme of ['dark', 'light']) {
  const { page, context, errors } = await open({ theme });

  await check(`${theme}: Today greets by name with photo and live meeting`, async () => {
    const head = await text(page, '.ws-today-head');
    assert(/Good (morning|afternoon|evening), Taylor/.test(head), `greeting: ${head}`);
    assert(await page.locator('.ws-today-avatar img').count() === 1, 'profile photo missing');
    assert(await page.locator('.ws-upnext').getByText('Happening now').count() === 1, 'no live meeting');
    assert(await page.locator('.ws-upnext button:has-text("Join Teams meeting")').count() === 1, 'no join');
    assert(await page.locator('.ws-timeline .ws-tl-event:has-text("Architecture review")').count() === 1, 'live meeting missing from timeline');
    assert(await page.locator('.ws-timeline [data-now-line]').count() === 1, 'now line');
    assert(await page.locator('.ws-msg-list .ws-msg-row').count() === 5, 'attention rows');
    assert(await page.locator('.ws-sidebar .ws-user img').count() === 1, 'sidebar photo');
    await shot(page, `${theme}-today`);
  });

  await check(`${theme}: Join opens only the meeting link through native`, async () => {
    await page.locator('.ws-upnext button:has-text("Join Teams meeting")').click();
    await page.waitForTimeout(150);
    const calls = await page.evaluate(() => window.__bridgeCalls);
    assert(calls.some(([op, d]) => op === 'open_source' && d.join === true && d.id === 'ev-current'), JSON.stringify(calls));
  });

  await check(`${theme}: commitments add inline and notes autosave`, async () => {
    await page.fill('[data-form=commitment-add] [name=text]', 'Prepare release notes');
    await page.click('[data-form=commitment-add] button[type=submit]');
    await page.waitForSelector('.ws-todo:has-text("Prepare release notes")');
    await page.fill('#today-note', 'Remember the demo at 16:00');
    await page.waitForTimeout(1300);
    assert(/Saved/.test(await text(page, '#note-state')), 'note not saved');
    await page.locator('.ws-todo:has-text("Prepare release notes") .ws-check').click();
    await page.waitForSelector('.ws-done-list');
  });

  await check(`${theme}: focus session starts and ends`, async () => {
    await page.locator('.ws-focus button:has-text("25 min")').click();
    await page.waitForSelector('.ws-focus-on');
    await page.locator('.ws-focus-on button:has-text("End")').click();
    await page.waitForSelector('.ws-focus:not(.ws-focus-on)');
  });

  await check(`${theme}: Customize dialog uses CodeMie switches and reorders`, async () => {
    await page.click('button:has-text("Customize")');
    await page.waitForSelector('.ws-modal[open] .ws-switch');
    await page.waitForTimeout(300);
    const box = await page.locator('.ws-modal[open] .ws-switch-track').first().boundingBox();
    assert(Math.round(box.width) === 32 && Math.round(box.height) === 16, `switch ${box.width}x${box.height}`);
    const overlay = await page.evaluate(() => getComputedStyle(document.querySelector('.ws-modal[open]'), '::backdrop').backgroundColor);
    assert(overlay === 'rgba(0, 0, 0, 0.5)', `scrim ${overlay}`);
    await shot(page, `${theme}-customize`);
    await page.locator('.ws-modal[open] [data-widget=focus] .ws-switch').click();
    const checked = await page.locator('.ws-modal[open] [data-widget=focus] input[name=widget]').isChecked();
    assert(!checked, 'focus switch did not turn off');
    await page.click('.ws-modal[open] button[type=submit]');
    await page.waitForTimeout(100);
    const layout = await page.evaluate(() => window.__workspace?.store.get().snapshot.workspaces[0].layout);
    assert(!layout.includes('focus'), `layout ${layout}`);
    await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
    assert(await page.locator('.ws-glance').count() === 0, 'focus card still visible');
  });

  await check(`${theme}: Calendar week grid shows hours, overlaps and now line`, async () => {
    await page.click('.ws-nav button[data-route=calendar]');
    await page.waitForSelector('.ws-tg');
    assert(await page.locator('.ws-tg-hour').count() === 24, 'hours');
    assert(await page.locator('.ws-tg-col').count() === 7, 'days');
    assert(await page.locator('.ws-tg-col .ws-now-line').count() === 1, 'now line');
    assert(await page.locator('.ws-cal-toggle').count() === 3, 'calendar list');
    // One evaluation: the live minute re-render may replace the grid between separate reads.
    const { widths, colWidth } = await page.evaluate(() => {
      const evs = [...document.querySelectorAll('.ws-ev')].filter(e => /Design critique|Hiring sync/.test(e.textContent));
      return { widths: evs.map(e => e.getBoundingClientRect().width), colWidth: document.querySelector('.ws-tg-col').getBoundingClientRect().width };
    });
    if (widths.length === 2) assert(widths.every(w => w < colWidth * 0.6), `overlap widths ${widths} of ${colWidth}`);
    await shot(page, `${theme}-calendar-week`);
  });

  await check(`${theme}: event details show time, Teams, attendees and actions`, async () => {
    await page.locator('.ws-ev:has-text("Architecture review")').first().click();
    await page.waitForSelector('.ws-modal[open] .ws-event-detail');
    await page.waitForTimeout(250);
    const body = await text(page, '.ws-modal[open]');
    assert(/Microsoft Teams meeting/.test(body) && /4 attendees/.test(body) && /Join Teams meeting/.test(body), body);
    await shot(page, `${theme}-event`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
  });

  await check(`${theme}: Calendar day, month and agenda views and navigation`, async () => {
    for (const mode of ['day', 'month', 'agenda']) {
      await page.click(`.ws-segmented button[data-mode=${mode}]`);
      await page.waitForSelector(`.ws-cal-${mode}`);
      await shot(page, `${theme}-calendar-${mode}`);
    }
    await page.click('.ws-segmented button[data-mode=week]');
    const before = await text(page, '.ws-cal-title');
    await page.click('button[data-action=calendar-next]');
    const after = await text(page, '.ws-cal-title');
    assert(before !== after, 'next period did not move');
    await page.click('button[data-action=calendar-today]');
    assert(await text(page, '.ws-cal-title') === before, 'today did not return');
    await page.locator('.ws-cal-toggle:has-text("Team events")').click();
    assert(await page.locator('.ws-ev:has-text("Hiring sync")').count() === 0, 'hidden calendar still shown');
    await page.locator('.ws-cal-toggle:has-text("Team events")').click();
  });

  await check(`${theme}: Inbox reader, lanes, snooze and done`, async () => {
    await page.click('.ws-nav button[data-route=inbox]');
    await page.waitForSelector('.ws-inbox-row');
    assert(await page.locator('.ws-lane[aria-selected=true]').innerText().then(t => t.startsWith('Needs reply')), 'default lane');
    assert(await page.locator('.ws-read').count() === 1, 'reader');
    await shot(page, `${theme}-inbox`);
    const first = await page.locator('.ws-inbox-row').first().getAttribute('data-id');
    assert(first === 'c-reply-1', `newest row ${first}`);
    assert(await page.locator('.ws-inbox-row[data-id="c-reply-1"] .ws-thread-count').innerText() === '2', 'chat count badge');
    await page.locator('.ws-read-actions summary:has-text("Snooze")').click();
    await page.locator('.ws-menu-item:has-text("Tomorrow")').click();
    await page.waitForTimeout(300);
    assert(await page.locator('.ws-inbox-row:has-text("Jordan Lee")').count() === 0, 'snooze left part of the Teams chat behind');
    await page.locator('.ws-read-actions button:has-text("Done")').click();
    await page.waitForTimeout(200);
    await page.click('.ws-lane[data-lane=critical]');
    await page.waitForSelector('.ws-read:has-text("Production alert")');
    await page.click('.ws-segmented button[data-channel=chat]');
    await page.click('.ws-lane[data-lane=reply]');
    assert(await page.locator('.ws-inbox-row .ws-msg-glyph').count() >= 1, 'teams rows');
  });

  await check(`${theme}: Inbox escapes hostile provider HTML`, async () => {
    await page.click('.ws-segmented button[data-channel=all]');
    await page.click('.ws-lane[data-lane=fyi]');
    await page.locator('.ws-inbox-row:has-text("onerror")').click();
    assert(await page.evaluate(() => window.__xss === undefined && !document.querySelector('.ws-read img[src=x]')), 'script ran');
  });

  await check(`${theme}: Settings shows profile, automatic sources and toggles`, async () => {
    await page.click('.ws-user');
    await page.waitForSelector('.ws-account');
    const account = await text(page, '.ws-account');
    assert(/Taylor Morgan/.test(account) && /Lead Software Engineer/.test(account), account);
    assert(await page.locator('.ws-source-row').count() === 3, 'sources');
    assert(await page.locator('input[name=chat], input[name=calendar]').count() === 0, 'source picker present');
    await shot(page, `${theme}-settings-microsoft`);
    await page.click('.ws-account button:has-text("Sync now")');
    await page.waitForSelector('.ws-sync-pill:has-text("Syncing")');
    await page.waitForSelector('.ws-sync-pill:has-text("Synced")', { timeout: 4000 });
    for (const tab of ['general', 'notifications', 'appearance', 'queues', 'privacy', 'activity', 'updates', 'installation']) {
      await page.click(`.ws-settings-nav button[data-tab=${tab}]`);
      await page.waitForSelector('.ws-settings-panels .ws-card');
      if (['general', 'notifications', 'appearance'].includes(tab)) await shot(page, `${theme}-settings-${tab}`);
    }
  });

  await check(`${theme}: checkbox and button geometry match CodeMie`, async () => {
    await page.click('.ws-settings-nav button[data-tab=notifications]');
    const btn = await page.locator('.ws-settings-panels .ws-btn-primary').first().evaluate(e => { const c = getComputedStyle(e); return [e.getBoundingClientRect().height, c.fontSize, c.fontWeight, c.borderRadius]; });
    assert(btn[0] === 28 && btn[1] === '12px' && btn[2] === '600' && btn[3] === '8px', `button ${btn}`);
    const font = await page.evaluate(() => getComputedStyle(document.querySelector('#workspace-app')).fontFamily);
    assert(/GeistMono/.test(font), font);
  });

  await check(`${theme}: settings save during sync succeeds`, async () => {
    await page.click('.ws-nav button[data-route=settings]');
    await page.click('.ws-settings-nav button[data-tab=notifications]');
    const toggle = page.locator('[data-key=criticalRepeat]');
    const before = await toggle.isChecked();
    await page.evaluate(() => { window.__syncBump = true; });
    await page.locator('.ws-switch:has([data-key=criticalRepeat])').click();
    await page.waitForTimeout(300);
    assert(await page.locator('.ws-toasts .ws-toast-error').count() === 0, `an error toast appeared: ${await page.locator('.ws-toasts .ws-toast-error').allInnerTexts()}`);
    assert(await page.locator('[data-key=criticalRepeat]').isChecked() !== before, 'setting did not persist after the sync');
  });

  await check(`${theme}: settings claude page`, async () => {
    await page.click('.ws-nav button[data-route=settings]');
    await page.click('.ws-settings-nav button[data-tab=ai]');
    await page.waitForSelector('[data-ai-profile="claude"]');
    assert(await page.locator('[data-ai-profile]').count() === 3, 'profile cards');
    const native = await text(page, '[data-ai-profile="claude"]');
    assert(/Ready/i.test(native) && /Max/.test(native) && /taylor@example\.com/.test(native) && /2\.1\.150/.test(native), native);
    assert(/Needs sign-in/i.test(await text(page, '[data-ai-profile="codemie:staging"]')), 'needs sign-in chip');
    assert(await page.locator('[data-ai-route-row]').count() === 5, 'route rows');
    assert(/runs/.test(await text(page, '#ai-usage')) && /estimate/i.test(await text(page, '#ai-usage')), 'usage');
    await shot(page, `${theme}-settings-claude-both`);
    await page.locator('.ws-settings-panels').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await shot(page, `${theme}-settings-claude-both-bottom`);
    await page.locator('.ws-settings-panels').evaluate(el => { el.scrollTop = 0; });
    await page.locator('[data-action="ai-test"][data-profile="claude"]').click();
    await page.waitForSelector('[data-ai-profile="claude"] .ws-spinner');
    await page.waitForSelector('[data-ai-profile="claude"] [data-ai-test-result]');
    assert(/OK · 2\.1 s · \$0\.0004/.test(await text(page, '[data-ai-profile="claude"] [data-ai-test-result]')), 'test result text');
    await shot(page, `${theme}-settings-claude-test`);
    await page.locator('select[name="ai-default"]').selectOption('codemie:prod');
    await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'ai_settings_save' && d.defaultProfile === 'codemie:prod'));
    await page.locator('select[data-route="plugin"][data-field="profile"]').selectOption('claude');
    await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'ai_settings_save' && d.routes.plugin?.profile === 'claude'));
    assert(await page.locator('select[name="ai-default"]').inputValue() === 'codemie:prod', 'default did not persist');
    assert(await page.locator('.ws-toasts .ws-toast-error').count() === 0, 'error toast');
    const failing = page.locator('[data-action="ai-test"][data-profile="codemie:staging"]');
    await failing.click();
    await page.waitForSelector('[data-ai-profile="codemie:staging"] [data-ai-test-result].ws-ai-bad');
    await page.click('.ws-settings-nav button[data-tab=general]');
    await page.click('.ws-settings-panels [data-action=settings-tab][data-tab=ai]');
    await page.waitForSelector('[data-ai-profile="claude"]');
  });

  await check(`${theme}: first-use chooser saves the default and explains an empty setup`, async () => {
    const chosen = await open({ theme, ai: 'both', aiDefault: null });
    const p = chosen.page;
    await p.evaluate(() => { window.__workspace.ensureClaudeChoice().then(v => { window.__chosen = v; }); });
    await p.waitForSelector('.ws-modal[open] [data-action="ai-choose"]');
    assert(await p.locator('.ws-modal[open] [data-action="ai-choose"]').count() === 2, 'only ready profiles');
    assert(/The message text you draft from is sent to this provider\./.test(await text(p, '.ws-modal[open]')), 'privacy note');
    await p.click('.ws-modal[open] button[type=submit]');
    assert(/Select a Claude/.test(await text(p, '.ws-modal[open] .ws-modal-error')), 'must choose first');
    await p.click('.ws-modal[open] [data-profile="codemie:prod"]');
    await p.waitForTimeout(150);
    await shot(p, `${theme}-claude-chooser`);
    await p.click('.ws-modal[open] button[type=submit]');
    await p.waitForSelector('.ws-modal[open]', { state: 'detached' });
    await p.waitForFunction(() => window.__chosen === 'codemie:prod');
    const calls = await p.evaluate(() => window.__bridgeCalls);
    assert(calls.some(([op, d]) => op === 'ai_settings_save' && d.defaultProfile === 'codemie:prod'), JSON.stringify(calls));
    await chosen.context.close().catch(() => {});

    const empty = await open({ theme, ai: 'none' });
    await empty.page.evaluate(() => { window.__workspace.ensureClaudeChoice().then(v => { window.__chosen = v; }); });
    await empty.page.waitForSelector('.ws-modal[open] [data-action="ai-open-settings"]');
    assert(await empty.page.locator('.ws-modal[open] [data-action="ai-choose"]').count() === 0, 'no choices');
    await empty.page.waitForTimeout(300);
    await shot(empty.page, `${theme}-claude-chooser-empty`);
    await empty.page.click('.ws-modal[open] [data-action="ai-open-settings"]');
    await empty.page.waitForSelector('[data-ai-profile="claude"]');
    assert(/Not installed/i.test(await text(empty.page, '[data-ai-profile="claude"]')), 'not installed chip');
    await empty.page.waitForFunction(() => window.__chosen === null);
    await shot(empty.page, `${theme}-settings-claude-none`);
    assert(empty.errors.length === 0 && chosen.errors.length === 0, [...empty.errors, ...chosen.errors].join(' | '));
    await empty.context.close().catch(() => {});
    currentPage = page;
  });

  await check(`${theme}: no workspaces UI`, async () => {
    await page.click('.ws-nav button[data-route=today]');
    await page.waitForSelector('.ws-page-today');
    assert(await page.locator('.ws-nav button[data-route=workspaces]').count() === 0, 'sidebar still has Workspaces');
    assert(await page.locator('#workspace-select, .ws-workspace-switch, .ws-ws-dot').count() === 0, 'topbar switcher still present');
    assert(await page.locator('.ws-nav button').allInnerTexts().then(t => t.join(' ').includes('Workspaces')) === false, 'Workspaces text in nav');
    await page.click('.ws-nav button[data-route=settings]');
    assert(await page.locator('.ws-settings-nav button:has-text("Workspaces")').count() === 0, 'Settings still has a Workspaces panel');
    await page.click('.ws-nav button[data-route=today]');
    await page.waitForSelector('.ws-topbar .ws-sync-pill');
    await shot(page, `${theme}-no-workspaces-ui`);
  });

  await check(`${theme}: sign out removes Microsoft data and keeps notes`, async () => {
    await page.click('.ws-nav button[data-route=settings]');
    await page.click('.ws-settings-nav button[data-tab=microsoft]');
    await page.click('.ws-account button:has-text("Sign out")');
    await page.waitForSelector('.ws-modal[open] .ws-check');
    await page.waitForTimeout(250);
    await shot(page, `${theme}-signout`);
    await page.click('.ws-modal[open] button[type=submit]');
    await page.waitForSelector('.ws-ms-hero');
    await page.click('.ws-nav button[data-route=today]');
    await page.waitForSelector('.ws-connect-hero');
    assert(await page.locator('.ws-todo').count() >= 1, 'local commitments lost');
  });

  await check(`${theme}: no page errors`, async () => assert(errors.length === 0, errors.join(' | ')));
  await context.close().catch(() => {});
}

// Reply drafts with Claude (DESIGN 6.4): composer, progress, result, replace, errors, Today.
const lastCall = async (page, name) => (await page.evaluate(() => window.__bridgeCalls)).filter(([op]) => op === name).at(-1)?.[1];
const plan = (page, value) => page.evaluate(v => { window.__draftPlan = v; }, value);
const openOptions = async page => {
  await page.click('[data-action="ai-draft-options"]');
  await page.waitForSelector('#draft-options');
  await page.waitForTimeout(150);
};
for (const theme of ['dark', 'light']) {
  const { page, context, errors } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });

  await check(`${theme}: ai draft flow`, async () => {
    await page.waitForSelector('.ws-read[data-message-id="c-reply-1"] [data-action="ai-draft-options"]');
    await openOptions(page);
    assert(await page.evaluate(() => document.activeElement?.dataset.action === 'ai-draft'), 'Draft is focused when the options open');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#draft-options', { state: 'detached' });
    assert(await page.evaluate(() => document.activeElement?.dataset.action === 'ai-draft-options'), 'Esc returns focus to Draft with AI');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#draft-options');
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.activeElement?.dataset.draftIntent === 'reply'), 'Tab stays inside the popover');
    const geometry = await page.evaluate(() => {
      const pop = document.getElementById('draft-options').getBoundingClientRect();
      const trigger = document.querySelector('[data-action="ai-draft-options"]').getBoundingClientRect();
      return { pop: [pop.left, pop.top, pop.right, pop.bottom], trigger: [trigger.left, trigger.top, trigger.right, trigger.bottom], vw: innerWidth, vh: innerHeight };
    });
    const [l, t, r, b] = geometry.pop;
    assert(l >= 0 && t >= 0 && r <= geometry.vw && b <= geometry.vh, `popover off screen ${JSON.stringify(geometry)}`);
    assert(Math.abs(r - geometry.trigger[2]) < 2 && (t >= geometry.trigger[3] || b <= geometry.trigger[1]), `popover not anchored ${JSON.stringify(geometry)}`);
    await page.click('[data-draft-intent="propose_times"]');
    assert(await page.locator('#draft-free-times').isChecked(), 'Propose times suggests free times');
    await page.click('[data-draft-tone="friendly"]');
    await page.fill('#draft-instructions', 'Offer Thursday or Friday afternoon');
    await shot(page, `${theme}-draft-options`);
    await plan(page, { outcome: 'hold' });
    await page.click('#draft-options [data-action="ai-draft"]');
    await page.waitForSelector('.ws-draft-running');
    const call = await lastCall(page, 'ai_draft');
    assert(call.sourceId === 'c-reply-1' && call.intent === 'propose_times' && call.tone === 'friendly' && call.includeFreeTimes === true && call.instructions === 'Offer Thursday or Friday afternoon', JSON.stringify(call));
    const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem('codemie.draft.options.chat')));
    assert(remembered.intent === 'propose_times' && remembered.tone === 'friendly' && !('instructions' in remembered), JSON.stringify(remembered));
    await page.waitForSelector('.ws-draft-running:has-text("Drafting with Claude Code · Sonnet 4.5")', { timeout: 4000 });
    await page.waitForTimeout(2100);
    assert(/\d+ s/.test(await text(page, '.ws-draft-running')), 'elapsed seconds');
    assert(!(await page.locator('#reply-body').isDisabled()), 'the reply stays editable');
    assert(await page.locator('.ws-draft-running [data-action="ai-draft-stop"]').count() === 1, 'Stop');
    assert(await page.locator('.ws-inbox-row[data-id="c-reply-1"] .ws-flag-ai').count() === 1, 'the list shows Drafting…');
    await shot(page, `${theme}-draft-running`);
    await page.evaluate(() => window.__finishDraft({ outcome: 'ok' }));
    await page.waitForFunction(() => document.getElementById('reply-body')?.value.startsWith('[Yes, 11:00 works for me / Sorry, I can'), null, { timeout: 4000 });
    await page.waitForSelector('.ws-draft-provenance:has-text("Drafted with Claude Code · Sonnet 4.5")');
    assert(/3 s · from 2 messages/.test(await text(page, '.ws-draft-provenance')), 'duration and message count');
    assert(/Choose an option in brackets before sending/.test(await text(page, '.ws-draft-todo')), 'bracket note');
    assert(/Can you join the call at 11:00\?/.test(await text(page, '.ws-draft-todo')), 'questions');
    await page.click('[data-action="ai-draft-context"]');
    assert(await page.locator('[data-action="ai-draft-context"]').getAttribute('aria-expanded') === 'true', 'Context is expanded');
    assert(/Jordan Lee/.test(await text(page, '#draft-context')), 'context lists senders');
    const widths = await page.evaluate(() => [document.getElementById('draft-context').getBoundingClientRect().width, document.querySelector('.ws-draft-provenance').getBoundingClientRect().width]);
    assert(Math.abs(widths[0] - widths[1]) < 1, `Context spans the panel ${widths}`);
    await page.waitForTimeout(250);
    await shot(page, `${theme}-draft-result`);
    // A re-render puts keyboard focus back on the exact control, never on its sibling.
    await page.focus(`[data-action="ai-draft-choice"][data-option="Sorry, I can't make 11:00"]`);
    await page.evaluate(() => window.__workspace.render());
    await page.evaluate(() => window.__workspace.render());
    const refocused = await page.evaluate(() => ({ option: document.activeElement?.dataset.option, fresh: document.activeElement?.isConnected }));
    assert(refocused.option === "Sorry, I can't make 11:00" && refocused.fresh, `focus moved to ${JSON.stringify(refocused)}`);
    await page.click('.ws-reply button[type=submit]');
    await page.waitForSelector('.ws-modal[open]:has-text("Finish your reply first?")');
    await page.waitForTimeout(250);
    await shot(page, `${theme}-draft-unfinished`);
    await page.click('.ws-modal[open] button:has-text("Edit reply")');
    await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
    await page.click('[data-action="ai-draft-choice"][data-option="Yes, 11:00 works for me"]');
    const value = await page.locator('#reply-body').inputValue();
    assert(value.startsWith('Yes, 11:00 works for me. If that changes') && !value.includes('['), value);
    await page.click('.ws-reply button[type=submit]');
    await page.waitForSelector('.ws-modal[open]:has-text("Review before sending")');
    assert((await lastCall(page, 'action_prepare')).body.startsWith('Yes, 11:00 works for me'), 'review shows the chosen option');
    await page.click('.ws-modal[open] button:has-text("Cancel")');
    await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
    assert(!(await page.evaluate(() => window.__bridgeCalls)).some(([op]) => op === 'action_confirm'), 'Cancel sent something');
  });

  await check(`${theme}: the user's own brackets send without a warning`, async () => {
    await page.fill('#reply-body', 'Merged in [EPMCDME-1234], the rest is [WIP]. [Yes / No] for the demo?');
    await page.click('.ws-reply button[type=submit]');
    await page.waitForSelector('.ws-modal[open]:has-text("Review before sending")');
    assert(await page.locator('.ws-modal[open]:has-text("Finish your reply first?")').count() === 0, 'warned about hand-written brackets');
    assert(await page.locator('.ws-draft-todo:not([hidden]) .ws-draft-choice').count() === 0, 'hand-written brackets listed as choices');
    await page.click('.ws-modal[open] button:has-text("Cancel")');
    await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
  });

  await check(`${theme}: a draft arriving while you type asks first, in the same box; Restore survives edits`, async () => {
    await plan(page, { outcome: 'hold' });
    await page.click('[data-action="ai-draft-regenerate"]');
    await page.waitForSelector('.ws-draft-running:has-text("Drafting with")', { timeout: 4000 });
    // Type in the reply box while Claude writes; the box must stay the same element, focused.
    await page.fill('#reply-body', '');
    await page.keyboard.type('My own reply to Jordan');
    await page.evaluate(() => { window.__replyNode = document.getElementById('reply-body'); });
    await page.evaluate(() => window.__finishDraft({ outcome: 'ok', text: 'Sure, the calendar layout notes are attached.', questions: [] }));
    await page.waitForSelector('.ws-draft-confirm', { timeout: 5000 });
    const kept = await page.evaluate(() => {
      const box = document.getElementById('reply-body');
      return { same: box === window.__replyNode, focused: document.activeElement === box, value: box.value, caret: box.selectionStart };
    });
    assert(kept.same && kept.focused && kept.value === 'My own reply to Jordan' && kept.caret === kept.value.length, `reply box recreated or changed ${JSON.stringify(kept)}`);
    await page.keyboard.type(' today');
    assert(await page.locator('#reply-body').inputValue() === 'My own reply to Jordan today', 'typing goes on in the same box');
    await page.waitForTimeout(200);
    await shot(page, `${theme}-draft-replace`);
    await page.click('[data-action="ai-draft-keep"]');
    await page.waitForSelector('.ws-draft-confirm', { state: 'detached' });
    assert(await page.locator('#reply-body').inputValue() === 'My own reply to Jordan today', 'Keep mine changed the text');
    await plan(page, { outcome: 'ok', ms: 500, text: 'Notes attached, see you at the 1:1.', questions: [] });
    await openOptions(page);
    await page.click('#draft-options [data-action="ai-draft"]');
    await page.waitForSelector('.ws-draft-confirm', { timeout: 5000 });
    await page.click('[data-action="ai-draft-replace"]');
    await page.waitForFunction(() => document.getElementById('reply-body')?.value === 'Notes attached, see you at the 1:1.');
    await page.waitForSelector('[data-action="ai-draft-restore"]');
    assert(/discarded/.test(await page.locator('[data-action="ai-draft-restore"]').getAttribute('title')), 'Restore says edits are discarded');
    // Editing the draft keeps the offer: the user's words are not lost on the first keystroke.
    await page.click('#reply-body');
    await page.keyboard.press('End');
    await page.keyboard.type(' Thanks!');
    await page.waitForTimeout(300);
    assert(await page.locator('[data-action="ai-draft-restore"]').count() === 1, 'Restore went away after an edit');
    await shot(page, `${theme}-draft-restore`);
    await page.click('[data-action="ai-draft-restore"]');
    await page.waitForFunction(() => document.getElementById('reply-body')?.value === 'My own reply to Jordan today');
    assert(await page.locator('[data-action="ai-draft-restore"]').count() === 0, 'Restore stays after restoring');
  });

  await check(`${theme}: Stop cancels a running draft`, async () => {
    await plan(page, { outcome: 'hold' });
    await openOptions(page);
    await page.click('#draft-options [data-action="ai-draft"]');
    await page.waitForSelector('.ws-draft-running:has-text("Drafting with") [data-action="ai-draft-stop"]', { timeout: 4000 });
    await page.click('.ws-draft-running [data-action="ai-draft-stop"]');
    await page.waitForSelector('.ws-draft-running', { state: 'detached', timeout: 4000 });
    assert(await lastCall(page, 'job_cancel'), 'no job_cancel');
    assert(await page.locator('.ws-draft-error').count() === 0, 'a stopped draft shows an error');
  });

  await check(`${theme}: a failed draft explains itself in the reply box, not in decisions`, async () => {
    const bell = await page.locator('.ws-bell-dot').count();
    await plan(page, { outcome: 'error', ms: 300, state: 'blocked', errorClass: 'needs_login', errorCode: 'needs_login' });
    await openOptions(page);
    await page.click('#draft-options [data-action="ai-draft"]');
    await page.waitForSelector('.ws-draft-error:has-text("Claude Code isn\'t signed in.")', { timeout: 5000 });
    assert(await page.locator('.ws-draft-error [data-action="ai-copy-login"]:has-text("Copy sign-in steps")').count() === 1, 'sign-in action');
    assert(await page.locator('.ws-bell-dot').count() === bell, 'the AI failure reached the decisions bell');
    await shot(page, `${theme}-draft-error`);
    await page.click('.ws-draft-error [data-action="ai-draft-dismiss"]');
    await page.waitForSelector('.ws-draft-error', { state: 'detached' });
  });

  await check(`${theme}: updates held while the options are open show when they close`, async () => {
    await openOptions(page);
    assert(await page.locator('.ws-inbox-row[data-id="m-reply-2"]').count() === 1, 'row missing before');
    await page.evaluate(() => window.__workspace.store.mutate('inbox_decision', { id: 'm-reply-2', action: 'archive' }));
    await page.waitForTimeout(400);
    assert(await page.locator('#draft-options').count() === 1, 'the popover closed on an update');
    assert(await page.locator('.ws-inbox-row[data-id="m-reply-2"]').count() === 1, 'rendered under the open popover');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ws-inbox-row[data-id="m-reply-2"]', { state: 'detached', timeout: 3000 });
    assert(await page.evaluate(() => document.activeElement?.dataset.action === 'ai-draft-options'), 'focus returns to Draft with AI');
  });

  await check(`${theme}: Today Draft reply opens the conversation and starts a draft`, async () => {
    await plan(page, { outcome: 'hold' });
    await page.click('.ws-nav button[data-route=today]');
    await page.waitForSelector('.ws-attention [data-action="draft-reply"]');
    assert(await page.locator('.ws-attention [data-action="draft-reply"]').count() === await page.locator('.ws-attention .ws-msg-row').count(), 'one action per row');
    const action = page.locator('.ws-attention [data-action="draft-reply"][data-id="c-reply-2"]');
    await action.hover();
    await page.waitForTimeout(300);
    assert(await action.evaluate(el => el.querySelector('span').getBoundingClientRect().width > 40), 'label shows on hover');
    const geo = await action.evaluate(el => {
      const item = el.closest('.ws-msg-item');
      const r = sel => item.querySelector(sel).getBoundingClientRect();
      return { pill: el.getBoundingClientRect().left, text: Math.max(r('.ws-msg-preview').right, r('.ws-msg-title').right), time: r('time').right, card: item.getBoundingClientRect().right };
    });
    assert(geo.pill >= geo.text, `the pill covers the preview ${JSON.stringify(geo)}`);
    assert(geo.card - geo.time <= 12, `the time left the card edge ${JSON.stringify(geo)}`);
    await shot(page, `${theme}-today-draft-reply`);
    await action.click();
    await page.waitForSelector('.ws-read[data-message-id="c-reply-2"] .ws-draft-running');
    const call = await lastCall(page, 'ai_draft');
    assert(call.sourceId === 'c-reply-2' && call.intent === 'propose_times' && call.tone === 'friendly', `remembered options not used ${JSON.stringify(call)}`);
    await page.evaluate(() => window.__finishDraft({ outcome: 'ok' }));
    await page.waitForSelector('.ws-read[data-message-id="c-reply-2"] .ws-draft-provenance', { timeout: 5000 });
  });

  await check(`${theme}: ai draft no page errors`, async () => assert(errors.length === 0, errors.join(' | ')));
  await context.close().catch(() => {});
  currentPage = null;

  await check(`${theme}: the first draft opens the chooser, then CodeMie starts`, async () => {
    const cm = await open({ theme, hash: '#/inbox', aiDefault: null });
    const p = cm.page;
    await plan(p, { outcome: 'hold' });
    await p.waitForSelector('[data-action="ai-draft-options"]');
    await openOptions(p);
    await p.click('#draft-options [data-action="ai-draft"]');
    await p.waitForSelector('.ws-modal[open] [data-action="ai-choose"]');
    await p.click('.ws-modal[open] [data-profile="codemie:prod"]');
    await p.click('.ws-modal[open] button[type=submit]');
    await p.waitForSelector('.ws-draft-running:has-text("Starting CodeMie")', { timeout: 5000 });
    await p.waitForTimeout(2100);
    await shot(p, `${theme}-draft-running-codemie`);
    // Without permission to reply from Connect, the draft is still usable: Copy reply.
    await p.evaluate(() => { navigator.clipboard.writeText = async t => { window.__copied = t; }; });
    await p.evaluate(() => window.__finishDraft({ outcome: 'ok' }));
    await p.waitForSelector('.ws-draft-provenance:has-text("Drafted with CodeMie")', { timeout: 5000 });
    assert(await p.locator('.ws-reply button[type=submit]').count() === 0, 'Review & send without permission');
    await p.click('[data-action="reply-copy"]');
    await p.waitForSelector('.ws-modal[open]:has-text("Finish your reply first?")');
    await p.click('.ws-modal[open] button:has-text("Copy anyway")');
    await p.waitForFunction(() => window.__copied?.startsWith('[Yes, 11:00 works for me'));
    await p.click('[data-action="ai-draft-choice"][data-option="Yes, 11:00 works for me"]');
    await p.click('[data-action="reply-copy"]');
    await p.waitForFunction(() => window.__copied?.startsWith('Yes, 11:00 works for me.'));
    assert(await p.locator('.ws-modal[open]').count() === 0, 'asked again with nothing left to choose');
    assert(cm.errors.length === 0, cm.errors.join(' | '));
    await cm.context.close().catch(() => {});
    currentPage = null;
  });

  for (const [width, height] of [[1000, 760], [1680, 900]]) await check(`${theme} ${width}px: the composer fits the window`, async () => {
    const narrow = await open({ theme, width, height, hash: '#/inbox', enable: ['chat_send'] });
    const p = narrow.page;
    await p.waitForSelector('[data-action="ai-draft-options"]');
    await openOptions(p);
    const box = await p.locator('#draft-options').boundingBox();
    assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `popover ${JSON.stringify(box)}`);
    await shot(p, `${theme}-draft-options-${width}`);
    await plan(p, { outcome: 'ok', ms: 400 });
    await p.click('#draft-options [data-action="ai-draft"]');
    await p.waitForSelector('.ws-draft-provenance', { timeout: 5000 });
    await p.click('[data-action="ai-draft-context"]');
    await p.waitForTimeout(250);
    const overflow = await p.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, ...[...document.querySelectorAll('.ws-reader, .ws-reply, .ws-draft-todo, .ws-draft-provenance')].map(el => el.scrollWidth - el.clientWidth)));
    assert(overflow <= 0, `overflow ${overflow}px`);
    await p.locator('.ws-reply').scrollIntoViewIfNeeded();
    await shot(p, `${theme}-draft-result-${width}`);
    assert(narrow.errors.length === 0, narrow.errors.join(' | '));
    await narrow.context.close().catch(() => {});
    currentPage = null;
  });
}

// Thread summaries (DESIGN 6.5): Summarize on long conversations, progress, the card with its asks,
// stale and failure.
const summaryPlan = (page, value) => page.evaluate(v => { window.__summaryPlan = v; }, value);
const ASKS = [{ text: 'Send Jordan the roadmap draft', due: '2026-11-20' }, { text: 'Book the review room for Thursday' }];
for (const theme of ['dark', 'light']) {
  const { page, context, errors } = await open({ theme, hash: '#/inbox', longThread: true });

  await check(`${theme}: summary flow`, async () => {
    await page.click('.ws-inbox-row[data-id="m-reply-2"]');
    await page.waitForSelector('.ws-read[data-message-id="m-reply-2"]');
    assert(await page.locator('[data-action="ai-summarize"]').count() === 0, 'Summarize on a one-message conversation');
    await page.click('.ws-inbox-row[data-id="m-reply-1"]');
    await page.waitForSelector('.ws-read[data-message-id="m-reply-1"] .ws-read-actions [data-action="ai-summarize"]');
    assert(/Summarize/.test(await text(page, '.ws-read-actions [data-action="ai-summarize"]')), 'label');
    await shot(page, `${theme}-summary-button`);
    await page.fill('#reply-body', 'Typing while Claude reads');
    // The route for summaries is CodeMie in this fixture; it started long enough ago to be named.
    await summaryPlan(page, { outcome: 'hold', startedAgo: 20 });
    await page.click('[data-action="ai-summarize"]');
    await page.waitForSelector('.ws-summary .ws-draft-running:has-text("Summarizing with CodeMie · Haiku 4.5")', { timeout: 4000 });
    assert((await lastCall(page, 'ai_summarize')).sourceId === 'm-reply-1', 'summarize request');
    assert(await page.locator('[data-action="ai-summarize"]').count() === 0, 'a second Summarize while running');
    await page.waitForTimeout(1100);
    assert(/\d+ s/.test(await text(page, '.ws-summary .ws-draft-running')), 'elapsed seconds');
    assert(await page.locator('.ws-summary .ws-draft-running [data-action="ai-draft-stop"]').count() === 1, 'Stop');
    await shot(page, `${theme}-summary-running`);
    await page.evaluate(() => { window.__replyNode = document.getElementById('reply-body'); });
    await page.evaluate(asks => window.__finishSummary({ outcome: 'ok', text: 'Priya asked for roadmap comments before Thursday. You said you would look today; she has since asked for the draft to go to Jordan and for the review room.', asks }), ASKS);
    await page.waitForSelector('.ws-summary .ws-summary-text');
    assert(await page.evaluate(() => document.getElementById('reply-body') === window.__replyNode && document.getElementById('reply-body').value === 'Typing while Claude reads'), 'the reply box was recreated');
    assert(await page.locator('.ws-summary [data-action="summary-ask-commit"]').count() === 2, 'asks');
    assert(/Due Fri, Nov 20/.test(await text(page, '.ws-summary')), 'formatted due date');
    assert(/Summarized with CodeMie · Haiku 4\.5 · 3 s · from 5 messages/.test(await text(page, '.ws-summary')), 'provenance');
    assert(await page.locator('.ws-read-actions [data-action="ai-summarize"]').count() === 0, 'the button stays after a summary');
    // The card sits above the thread.
    assert(await page.evaluate(() => document.querySelector('.ws-summary').compareDocumentPosition(document.querySelector('.ws-thread')) & Node.DOCUMENT_POSITION_FOLLOWING), 'card below the thread');
    await page.waitForTimeout(250);
    await shot(page, `${theme}-summary-card`);
    await page.click('[data-action="summary-ask-commit"][data-index="0"]');
    await page.waitForSelector('.ws-summary-added');
    const saved = await page.evaluate(() => window.__workspace.store.get().snapshot.records.find(r => r.kind === 'commitment' && r.id.startsWith('ask:')));
    assert(saved.data.text === 'Send Jordan the roadmap draft' && saved.data.due === '2026-11-20' && saved.data.owner === 'You', JSON.stringify(saved));
    assert(await page.locator('.ws-summary [data-action="summary-ask-commit"]').count() === 1, 'the added ask can be added again');
    await page.click('.ws-nav button[data-route=today]');
    await page.waitForSelector('.ws-todo:has-text("Send Jordan the roadmap draft")');
    await page.click('.ws-nav button[data-route=inbox]');
    await page.waitForSelector('.ws-summary .ws-summary-added');
    // Collapse and expand.
    await page.click('[data-action="summary-toggle"]');
    assert(await page.locator('#summary-body').isHidden(), 'collapsed');
    await page.click('[data-action="summary-toggle"]');
    assert(await page.locator('#summary-body').isVisible(), 'expanded');
  });

  await check(`${theme}: a new message makes the summary stale and Refresh runs again`, async () => {
    await page.evaluate(() => window.__setSummaryStale(true));
    await page.waitForSelector('.ws-summary-stale-note');
    assert(/New messages since this summary/.test(await text(page, '.ws-summary-stale-note')), 'note');
    await shot(page, `${theme}-summary-stale`);
    await summaryPlan(page, { outcome: 'hold' });
    await page.click('.ws-summary-stale-note [data-action="ai-summarize"]');
    await page.waitForSelector('.ws-summary .ws-draft-running');
    assert(await page.locator('.ws-summary-text').count() === 1, 'the old summary stays while refreshing');
    await page.evaluate(asks => window.__finishSummary({ outcome: 'ok', asks }), ASKS);
    await page.waitForSelector('.ws-summary-stale-note', { state: 'detached' });
    assert(await page.locator('.ws-summary [data-action="summary-ask-commit"]').count() === 1, 'the added ask is still marked after a refresh');
    await summaryPlan(page, { outcome: 'error', ms: 300, state: 'blocked', errorClass: 'needs_login', errorCode: 'needs_login' });
    await page.click('.ws-summary-foot [data-action="ai-summarize"]');
    await page.waitForSelector('.ws-summary .ws-draft-error:has-text("isn\'t signed in")', { timeout: 5000 });
    assert(await page.locator('.ws-summary-text').count() === 1, 'a failed refresh keeps the old summary');
    await shot(page, `${theme}-summary-refresh-failed`);
  });

  await check(`${theme}: summary no page errors`, async () => assert(errors.length === 0, errors.join(' | ')));
  await context.close().catch(() => {});
  currentPage = null;

  await check(`${theme}: a failed first summary says why in the card area, not in decisions`, async () => {
    const f = await open({ theme, hash: '#/inbox', longThread: true });
    const p = f.page;
    await p.click('.ws-inbox-row[data-id="m-reply-1"]');
    const bell = await p.locator('.ws-bell-dot').count();
    await summaryPlan(p, { outcome: 'error', ms: 300, state: 'failed', errorClass: 'timeout', errorCode: 'timeout' });
    await p.click('[data-action="ai-summarize"]');
    await p.waitForSelector('.ws-summary .ws-draft-error:has-text("Claude took too long to answer.")', { timeout: 5000 });
    assert(await p.locator('.ws-summary .ws-draft-error [data-action="ai-summarize-retry"]').count() === 1, 'Try again');
    assert(await p.locator('.ws-bell-dot').count() === bell, 'the failure reached the decisions bell');
    await shot(p, `${theme}-summary-error`);
    await summaryPlan(p, { outcome: 'ok', ms: 300 });
    await p.click('[data-action="ai-summarize-retry"]');
    await p.waitForSelector('.ws-summary .ws-summary-text', { timeout: 5000 });
    assert(await p.locator('.ws-draft-error').count() === 0, 'the error stays after the retry worked');
    assert(f.errors.length === 0, f.errors.join(' | '));
    await f.context.close().catch(() => {});
    currentPage = null;
  });

  await check(`${theme} 1000px: the summary card fits the window`, async () => {
    const n = await open({ theme, width: 1000, height: 760, hash: '#/inbox', longThread: true });
    const p = n.page;
    await p.click('.ws-inbox-row[data-id="m-reply-1"]');
    await summaryPlan(p, { outcome: 'ok', ms: 300, asks: ASKS, partialText: true });
    await p.click('[data-action="ai-summarize"]');
    await p.waitForSelector('.ws-summary .ws-summary-text', { timeout: 5000 });
    await p.evaluate(() => window.__setSummaryStale(true));
    await p.waitForSelector('.ws-summary-stale-note');
    assert(/Preview text only/.test(await text(p, '.ws-summary')), 'partial note');
    const overflow = await p.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, ...[...document.querySelectorAll('.ws-reader, .ws-summary, .ws-summary *')].map(el => el.scrollWidth - el.clientWidth)));
    assert(overflow <= 0, `overflow ${overflow}px`);
    await shot(p, `${theme}-summary-card-1000`);
    assert(n.errors.length === 0, n.errors.join(' | '));
    await n.context.close().catch(() => {});
    currentPage = null;
  });
}

// Recovery page (DESIGN 8): every data-folder status in both themes, its actions, and a drive
// that goes away while Connect runs.
for (const theme of ['dark', 'light']) {
  for (const [name, storage] of Object.entries(STORAGE)) {
    await check(`${theme}: recovery page for ${name}`, async () => {
      const { page, context, errors } = await open({ theme, storage, unavailable: true });
      const card = page.locator('.ws-recovery-card');
      assert(await card.getAttribute('data-status') === storage.status, `status ${await card.getAttribute('data-status')}`);
      const body = await card.innerText();
      assert(/Your data folder needs attention/.test(body), body);
      const shown = name === 'pointer_unreadable' ? `${DEFAULT_ROOT}/location.json` : storage.dataRoot;
      assert(body.includes(shown), `path ${shown} not shown: ${body}`);
      if (name === 'pointer_unreadable') assert(body.includes('Connect couldn’t read where your data is kept.'), body);
      if (storage.issue) assert(body.includes(storage.issue), 'the native issue is shown');
      assert(!/existing tools are still accessible/.test(body), 'generic native message leaked');
      assert(await page.locator('[data-action="recovery-retry"]').count() === 1, 'Retry');
      const offersDefault = storage.custom || name === 'pointer_unreadable';
      assert(await page.locator('[data-action="recovery-default"]').count() === (offersDefault ? 1 : 0), 'Use the default folder');
      assert(offersDefault === body.includes('Data there may be older or empty.'), 'warning');
      // A folder that is fine (`ready`) isn't the problem, so choosing another one isn't offered.
      assert(await page.locator('[data-action="recovery-choose"]').count() === (storage.status === 'ready' ? 0 : 1), 'Choose another folder');
      const box = await card.boundingBox();
      const view = page.viewportSize();
      assert(Math.abs(box.x + box.width / 2 - view.width / 2) <= 2, `card not centered: ${box.x}`);
      await shot(page, `${theme}-recovery-${name}`);
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
      currentPage = null;
    });
  }

  await check(`${theme}: recovery Retry relaunches once and stays disabled`, async () => {
    const { page, context, errors } = await open({ theme, storage: STORAGE.missing, unavailable: true });
    await page.click('[data-action="recovery-retry"]');
    await page.waitForSelector('[data-action="recovery-retry"][disabled]:has-text("Restarting…")');
    assert(await page.locator('[data-action="recovery-default"][disabled]').count() === 1, 'Use the default folder still enabled');
    await page.locator('[data-action="recovery-retry"]').click({ force: true });
    await page.waitForTimeout(200);
    const calls = await page.evaluate(() => window.__bridgeCalls.filter(([op]) => op === 'app_relaunch').length);
    assert(calls === 1, `app_relaunch calls ${calls}`);
    await shot(page, `${theme}-recovery-restarting`);
    assert(errors.length === 0, errors.join(' | '));
    await context.close().catch(() => {});
    currentPage = null;
  });

  await check(`${theme}: recovery Use the default folder confirms first and shows a failure`, async () => {
    const { page, context, errors } = await open({ theme, storage: STORAGE.missing, unavailable: true });
    await page.click('[data-action="recovery-default"]');
    await page.waitForSelector('.ws-modal[open]');
    await page.waitForTimeout(250);
    const text = await page.locator('.ws-modal[open]').innerText();
    assert(/Use the default folder\?/.test(text) && text.includes('Data there may be older or empty.') && text.includes(DEFAULT_ROOT), text);
    assert(!(await page.evaluate(() => window.__bridgeCalls.some(([op]) => op === 'data_location_use_default'))), 'switched before confirming');
    await shot(page, `${theme}-recovery-confirm-default`);
    await page.evaluate(() => { window.__useDefaultError = 'Connect couldn’t switch to the default folder: Is a directory (os error 21).'; });
    assert(await page.evaluate(() => document.activeElement?.matches('.ws-modal[open] [data-modal-close]') && document.activeElement.textContent === 'Cancel'), 'a restart is the default button');
    await page.waitForTimeout(450);
    await page.click('.ws-modal[open] button[type=submit]');
    await page.waitForSelector('.ws-modal[open] .ws-modal-error:has-text("Is a directory")');
    await shot(page, `${theme}-recovery-default-failed`);
    await page.evaluate(() => { window.__useDefaultError = null; });
    await page.click('.ws-modal[open] button[type=submit]');
    await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
    await page.waitForSelector('[data-action="recovery-retry"][disabled]:has-text("Restarting…")');
    const calls = await page.evaluate(() => window.__bridgeCalls.filter(([op]) => op === 'data_location_use_default').length);
    assert(calls === 2, `use-default calls ${calls}`);
    assert(errors.length === 0, errors.join(' | '));
    await context.close().catch(() => {});
    currentPage = null;
  });

  await check(`${theme}: a drive that goes away while Connect runs shows the recovery page`, async () => {
    const { page, context, errors } = await open({ theme, storage: STORAGE.missing });
    await page.evaluate(() => { window.__storageFail = true; });
    await page.fill('[data-form=commitment-add] [name=text]', 'Prepare release notes');
    await page.click('[data-form=commitment-add] button[type=submit]');
    await page.waitForSelector('.ws-recovery-card[data-status="missing"]');
    assert(await page.locator('.ws-sidebar').count() === 0, 'the workspace is still on screen');
    assert(await page.locator('.ws-toast:has-text("lost access")').count() === 0, 'a toast doubled the page');
    // Background refreshes do not bring the workspace back over the page.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(400);
    assert(await page.locator('.ws-recovery').count() === 1, 'the page was replaced');
    await shot(page, `${theme}-recovery-runtime`);
    assert(errors.length === 0, errors.join(' | '));
    await context.close().catch(() => {});
    currentPage = null;
  });

  for (const width of [1000, 1680]) {
    await check(`${theme} ${width}px: the recovery page fits`, async () => {
      const { page, context } = await open({ theme, width, height: 760, storage: STORAGE.missing, unavailable: true });
      const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, ...[...document.querySelectorAll('.ws-recovery-card, .ws-recovery-card *')].map(el => el.scrollWidth - el.clientWidth)));
      assert(overflow <= 0, `overflow ${overflow}px`);
      await shot(page, `${theme}-recovery-missing-${width}`);
      await context.close().catch(() => {});
      currentPage = null;
    });
  }
}

// Settings → General → Data location (DESIGN 8): the card in each state, the change dialog at
// every step, Remove old copy, Use the default folder, and Choose another folder on the
// recovery page. Native answers come from the Rust contract fixtures.
const L_DEFAULT = dataLocation('default');
const L_COPIED = dataLocation('custom-copied');
const L_ADOPTED = dataLocation('custom-adopted');
// What the picker returns for each check fixture: the folder that fixture was checked for.
const PICK = Object.fromEntries(['ok', 'cloud', 'network', 'tight', 'exfat', 'existing', 'recovery'].map(check => [check, { path: folderCheck(check).target.replace(/\/CodeMie Connect Data$/, ''), check }]));
const dialog = '.ws-modal[open]';
const continueButton = `${dialog} .ws-modal-footer button[type=submit]`;
const settle = page => page.waitForTimeout(220);
// A guarded dialog ignores a submit within 400 ms of opening or changing step: a deliberate
// press comes later.
const armed = page => page.waitForTimeout(450);
async function pickFolder(page, pick) {
  await page.evaluate(p => { window.__pick = p; }, pick);
  await page.click(`${dialog} [data-action="data-choose"]`);
  await page.waitForSelector(`${dialog} .ws-dl-folder-head`);
  await settle(page);
}
// A data folder on a drive that is gone, apart from the folders the pick fixtures name.
const GONE = storageOf('missing', { dataRoot: '/Volumes/Old Drive/CodeMie Connect Data' });
const overflowOf = (page, selector) => page.evaluate(sel => Math.max(document.documentElement.scrollWidth - innerWidth, ...[...document.querySelectorAll(`${sel}, ${sel} *`)].map(el => el.scrollWidth - el.clientWidth)), selector);

for (const theme of ['dark', 'light']) {
  for (const width of [1440, 1000, 1680]) {
    await check(`${theme} ${width}px: Data location shows the default folder, sign-in data and logs`, async () => {
      const { page, context, errors } = await open({ theme, width, hash: '#/settings/general' });
      await page.waitForSelector('#data-location-path');
      const card = page.locator('#data-location');
      assert((await text(page, '#data-location-path')) === L_DEFAULT.dataRoot, 'data folder path');
      const body = await card.innerText();
      for (const part of ['DEFAULT', '48.2 MB', 'Private sign-in data', 'never moves', L_DEFAULT.logs, 'Change…']) assert(body.includes(part), `${part} missing: ${body}`);
      assert(await card.locator('[data-action="data-default"]').count() === 0, 'Use the default folder on the default folder');
      assert(await card.locator('[data-action="data-remove-old"]').count() === 0, 'Remove old copy without a copy');
      assert(await overflowOf(page, '#data-location') <= 0, 'the card overflows');
      await card.scrollIntoViewIfNeeded();
      await shot(page, `${theme}-data-location-default-${width}`);
      await page.click('[data-action="data-reveal"][data-which="logs"]');
      assert((await lastCall(page, 'data_location_reveal'))?.which === 'logs', 'Show in Finder for the logs');
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
      currentPage = null;
    });

    await check(`${theme} ${width}px: the old copy a move left can be removed after a clear confirm`, async () => {
      const { page, context, errors } = await open({ theme, width, hash: '#/settings/general', location: 'custom-copied' });
      await page.waitForSelector('#data-location [data-action="data-remove-old"]');
      const card = page.locator('#data-location');
      const body = await card.innerText();
      assert(body.includes('CUSTOM') && body.includes('Old copy · 48.2 MB') && body.includes(L_COPIED.previous), body);
      assert(await card.locator('[data-action="data-default"]').count() === 1, 'Use the default folder');
      await card.scrollIntoViewIfNeeded();
      await shot(page, `${theme}-data-location-copied-${width}`);
      await page.click('[data-action="data-remove-old"]');
      await page.waitForSelector(dialog);
      await settle(page);
      const confirm = await page.locator(dialog).innerText();
      assert(/Remove the old copy\?/.test(confirm) && confirm.includes(L_COPIED.previous) && confirm.includes('48.2 MB') && confirm.includes('This can’t be undone.'), confirm);
      assert(!(await page.evaluate(() => window.__bridgeCalls.some(([c]) => c === 'data_location_remove_old'))), 'removed before confirming');
      await shot(page, `${theme}-data-remove-confirm-${width}`);
      await armed(page);
      await page.click(`${dialog} button[type=submit]`);
      await page.waitForSelector('.ws-toast:has-text("Old copy removed. 48.2 MB freed.")');
      await page.waitForFunction(() => !document.querySelector('#data-location [data-action="data-remove-old"]'));
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
      currentPage = null;
    });
  }

  for (const width of [1440, 1000]) {
    await check(`${theme} ${width}px: a previous folder that isn’t a copy is named, never offered for removal`, async () => {
      const { page, context, errors } = await open({ theme, width, hash: '#/settings/general', location: 'custom-adopted' });
      await page.waitForSelector('#data-location [data-place="previous"]');
      const card = page.locator('#data-location');
      const body = await card.innerText();
      assert(body.includes('Your previous data folder is still at') && body.includes(L_ADOPTED.previous), body);
      assert(await card.locator('[data-action="data-remove-old"]').count() === 0, 'Remove offered for a folder that may hold newer data');
      await card.scrollIntoViewIfNeeded();
      await shot(page, `${theme}-data-location-previous-${width}`);
      await page.click('[data-place="previous"] [data-action="data-reveal"]');
      assert((await lastCall(page, 'data_location_reveal'))?.which === 'previous', 'Show in Finder for the previous folder');
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
      currentPage = null;
    });

    await check(`${theme} ${width}px: data location flow`, async () => {
      const { page, context, errors } = await open({ theme, width, hash: '#/settings/general' });
      await page.click('[data-action="data-change"]');
      await page.waitForSelector(`${dialog} [data-action="data-choose"]`);
      await settle(page);
      const pick = await page.locator(dialog).innerText();
      assert(/Step 1 of 3/.test(pick) && /CodeMie Connect Data/.test(pick) && pick.includes(L_DEFAULT.dataRoot), pick);
      await shot(page, `${theme}-data-change-1-pick-${width}`);
      // Cancelling the system picker changes nothing.
      await page.evaluate(() => { window.__pick = null; });
      await page.click(`${dialog} [data-action="data-choose"]`);
      await settle(page);
      assert(await page.locator(`${dialog} .ws-dl-folder-head`).count() === 0, 'a cancelled pick moved on');
      await pickFolder(page, PICK.ok);
      assert((await lastCall(page, 'data_location_check'))?.path === PICK.ok.path, 'checked the picked folder');
      assert(await page.locator(`${dialog} input[name="data-mode"][value="move"]:checked`).count() === 1, 'Move my data is the default');
      assert(await page.locator(`${dialog} input[name="data-mode"][value="adopt"]`).count() === 0, 'adopt without Connect data there');
      await shot(page, `${theme}-data-change-2-check-${width}`);
      await armed(page);
      await page.click(continueButton);
      await page.waitForSelector(`${dialog} .ws-dl-restart`);
      await settle(page);
      const confirm = await page.locator(dialog).innerText();
      assert(/Move your data and restart\?/.test(confirm) && /Connect will restart\./.test(confirm) && confirm.includes(folderCheck('ok').target), confirm);
      await shot(page, `${theme}-data-change-3-confirm-${width}`);
      await page.evaluate(() => { window.__changeHold = true; });
      await armed(page);
      await page.click(`${continueButton}:has-text("Move and restart")`);
      await page.waitForSelector(`${dialog} .ws-dl-progress:has-text("Copying your data…")`);
      await page.keyboard.press('Escape');
      await settle(page);
      assert(await page.locator(dialog).count() === 1, 'Esc closed the dialog while copying');
      assert(!(await page.locator(`${dialog} [data-modal-close]`).isVisible()), 'close button while copying');
      await shot(page, `${theme}-data-change-4-working-${width}`);
      const call = await lastCall(page, 'data_location_change');
      assert(call?.mode === 'move' && call.path === PICK.ok.path && call.acceptNoPermissions === false, JSON.stringify(call));
      await page.evaluate(() => window.__finishChange());
      await page.waitForSelector(`${dialog} .ws-dl-progress:has-text("Restarting Connect…")`);
      await shot(page, `${theme}-data-change-5-restarting-${width}`);
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
      currentPage = null;
    });

    await check(`${theme} ${width}px: the check names every problem and keeps Continue off until a choice is possible`, async () => {
      const { page, context, errors } = await open({ theme, width, hash: '#/settings/general' });
      await page.click('[data-action="data-change"]');
      await page.waitForSelector(`${dialog} [data-action="data-choose"]`);
      await pickFolder(page, PICK.cloud);
      const cloud = await page.locator(dialog).innerText();
      assert(cloud.includes('iCloud Drive syncs that folder, and syncing can damage the workspace database.') && /isn’t synced/.test(cloud), cloud);
      assert(await page.locator(`${dialog} input[name="data-mode"]`).count() === 0, 'choices for an unusable folder');
      assert(await page.locator(`${continueButton}[disabled]`).count() === 1, 'Continue enabled');
      await shot(page, `${theme}-data-change-issue-cloud-${width}`);
      await pickFolder(page, PICK.network);
      assert(/network drive \(SMB\)/.test(await page.locator(dialog).innerText()), 'network sentence');
      await shot(page, `${theme}-data-change-issue-network-${width}`);
      await pickFolder(page, PICK.tight);
      const tight = await page.locator(dialog).innerText();
      assert(/72 MB free/.test(tight) && /115 MB/.test(tight), tight);
      assert(await page.locator(`${dialog} input[value="move"][disabled]`).count() === 1, 'Move offered without room');
      assert(await page.locator(`${continueButton}[disabled]`).count() === 1, 'Start empty chosen for the user');
      await shot(page, `${theme}-data-change-issue-space-${width}`);
      await page.click(`${dialog} .ws-dl-mode:has(input[value="fresh"])`);
      assert(await page.locator(`${continueButton}:not([disabled])`).count() === 1, 'Continue after choosing');
      await pickFolder(page, PICK.existing);
      assert(await page.locator(`${dialog} input[value="adopt"]:checked`).count() === 1, 'the Connect data there is offered');
      assert(await page.locator(`${dialog} input[value="move"], ${dialog} input[value="fresh"]`).count() === 0, 'move or fresh over Connect data');
      await shot(page, `${theme}-data-change-adopt-${width}`);
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
      currentPage = null;
    });

    await check(`${theme} ${width}px: an exFAT drive needs the acknowledgement, and a busy Connect says so inline`, async () => {
      const { page, context, errors } = await open({ theme, width, hash: '#/settings/general' });
      await page.click('[data-action="data-change"]');
      await page.waitForSelector(`${dialog} [data-action="data-choose"]`);
      await pickFolder(page, PICK.exfat);
      assert(await page.locator(`${continueButton}[disabled]`).count() === 1, 'Continue before the acknowledgement');
      assert((await page.locator(dialog).innerText()).includes('I understand others with access to this drive can read my workspace'), 'acknowledgement');
      await shot(page, `${theme}-data-change-exfat-${width}`);
      await page.click(`${dialog} .ws-dl-ack .ws-check`);
      await page.waitForSelector(`${continueButton}:not([disabled])`);
      await shot(page, `${theme}-data-change-exfat-ack-${width}`);
      await armed(page);
      await page.click(continueButton);
      await page.waitForSelector(`${dialog} .ws-dl-restart`);
      await page.evaluate(() => { window.__changeError = { code: 'busy', message: 'Connect is removing the old copy of your data. Try again in a moment.' }; });
      await armed(page);
      await page.click(continueButton);
      await page.waitForSelector(`${dialog} .ws-inline-note.ws-warning[role=alert]:has-text("removing the old copy")`);
      assert((await lastCall(page, 'data_location_change'))?.acceptNoPermissions === true, 'acknowledgement not sent');
      assert(await page.locator(`${dialog} [data-action="data-back"]`).count() === 1, 'Back after a refusal');
      await settle(page);
      await shot(page, `${theme}-data-change-busy-${width}`);
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
      currentPage = null;
    });

    await check(`${theme} ${width}px: Use the default folder confirms what it means, then restarts`, async () => {
      const { page, context, errors } = await open({ theme, width, hash: '#/settings/general', location: 'custom' });
      await page.click('[data-action="data-default"]');
      await page.waitForSelector(dialog);
      await settle(page);
      const text = await page.locator(dialog).innerText();
      assert(text.includes('Nothing is moved or copied. Data there may be older or empty.') && text.includes(L_DEFAULT.privateRoot) && text.includes(dataLocation('custom').dataRoot), text);
      await shot(page, `${theme}-data-use-default-${width}`);
      await armed(page);
      await page.click(`${dialog} button[type=submit]`);
      await page.waitForSelector(`${dialog}`, { state: 'detached' });
      await page.waitForSelector('#data-location .ws-dl-wait:has-text("Restarting Connect…")');
      assert(await page.locator('#data-location [data-action="data-change"][disabled]').count() === 1, 'Change… during a restart');
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
      currentPage = null;
    });

    await check(`${theme} ${width}px: Choose another folder on the recovery page uses the data there or starts empty`, async () => {
      const { page, context, errors } = await open({ theme, width, storage: GONE, unavailable: true });
      await page.click('[data-action="recovery-choose"]');
      await page.waitForSelector(`${dialog} [data-action="data-choose"]`);
      await settle(page);
      assert(/can’t copy your data from here/.test(await page.locator(dialog).innerText()), 'says why Move is missing');
      await shot(page, `${theme}-recovery-choose-1-pick-${width}`);
      await pickFolder(page, PICK.recovery);
      assert(await page.locator(`${dialog} input[value="move"][disabled]`).count() === 1, 'Move offered without a workspace');
      assert(await page.locator(`${dialog} input[name="data-mode"]:checked`).count() === 0, 'a choice made for the user');
      await shot(page, `${theme}-recovery-choose-2-check-${width}`);
      await page.click(`${dialog} .ws-dl-mode:has(input[value="fresh"])`);
      await armed(page);
      await page.click(continueButton);
      await page.waitForSelector(`${dialog} .ws-dl-restart`);
      const confirm = await page.locator(dialog).innerText();
      assert(/Nothing is deleted/.test(confirm) && !confirm.includes(GONE.dataRoot) && !/current data/.test(confirm), `recovery confirm: ${confirm.replace(/\n/g, ' ')}`);
      await shot(page, `${theme}-recovery-choose-3-confirm-${width}`);
      await armed(page);
      await page.click(`${continueButton}:has-text("Start empty and restart")`);
      await page.waitForSelector(`${dialog} .ws-dl-progress:has-text("Restarting Connect…")`);
      assert((await lastCall(page, 'data_location_change'))?.mode === 'fresh', 'fresh');
      await page.waitForSelector('[data-action="recovery-choose"][disabled]');
      assert(await page.locator('[data-action="recovery-retry"][disabled]').count() === 1, 'Retry after a change');
      assert(errors.length === 0, errors.join(' | '));
      await context.close().catch(() => {});
      currentPage = null;
    });
  }

  await check(`${theme}: Enter and double clicks never commit a move, a removal or a switch`, async () => {
    const { page, context, errors } = await open({ theme, hash: '#/settings/general', location: 'custom-copied' });
    const commits = () => page.evaluate(() => window.__bridgeCalls.filter(([c]) => ['data_location_change', 'data_location_remove_old', 'data_location_use_default'].includes(c)).length);
    await page.click('[data-action="data-change"]');
    await page.waitForSelector(`${dialog} [data-action="data-choose"]`);
    await pickFolder(page, PICK.ok);
    // Enter, Enter from the check step: the first continues, the second lands on Back.
    await armed(page);
    await page.focus(continueButton);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`${dialog} .ws-dl-restart`);
    assert(await page.evaluate(() => document.activeElement?.dataset.action === 'data-back'), 'step 3 starts on its commit button');
    await page.keyboard.press('Enter');
    await settle(page);
    assert(await commits() === 0, 'Enter, Enter moved the data');
    // A held-down Enter: its repeats don't act on the next step.
    await page.waitForSelector(`${dialog} input[name="data-mode"]:checked`);
    await armed(page);
    await page.focus(continueButton);
    await page.keyboard.down('Enter');
    await page.waitForSelector(`${dialog} .ws-dl-restart`);
    await page.waitForTimeout(500);
    for (let i = 0; i < 3; i++) await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await settle(page);
    assert(await page.locator(`${dialog} .ws-dl-restart`).count() === 1, 'a held Enter acted on step 3');
    assert(await commits() === 0, 'a held Enter moved the data');
    // A fast double click on Continue doesn't reach the commit button.
    await page.click(`${dialog} [data-action="data-back"]`);
    await page.waitForSelector(`${dialog} input[name="data-mode"]:checked`);
    await armed(page);
    await page.dblclick(continueButton);
    await settle(page);
    assert(await commits() === 0, 'a double click on Continue moved the data');
    await page.keyboard.press('Escape');
    await page.waitForSelector(dialog, { state: 'detached' });
    // Remove old copy: Cancel has focus, so Enter right away removes nothing.
    await page.click('[data-action="data-remove-old"]');
    await page.waitForSelector(dialog);
    assert(await page.evaluate(() => document.activeElement?.textContent === 'Cancel'), 'Remove old copy is the default button');
    await page.keyboard.press('Enter');
    await page.waitForSelector(dialog, { state: 'detached' });
    // Use the default folder: a click the moment it opens does nothing.
    await page.click('[data-action="data-default"]');
    await page.waitForSelector(dialog);
    assert(await page.evaluate(() => document.activeElement?.textContent === 'Cancel'), 'the switch is the default button');
    await page.click(`${dialog} button[type=submit]`);
    await settle(page);
    assert(await page.locator(dialog).count() === 1, 'a click right away switched folders');
    assert(await commits() === 0, 'a commit happened without a deliberate press');
    await page.keyboard.press('Escape');
    assert(errors.length === 0, errors.join(' | '));
    await context.close().catch(() => {});
    currentPage = null;
  });

  await check(`${theme}: a move that fails leaves the dialog and the card usable`, async () => {
    const { page, context, errors } = await open({ theme, hash: '#/settings/general' });
    await page.click('[data-action="data-change"]');
    await page.waitForSelector(`${dialog} [data-action="data-choose"]`);
    await pickFolder(page, PICK.ok);
    await armed(page);
    await page.click(continueButton);
    await page.waitForSelector(`${dialog} .ws-dl-restart`);
    await page.evaluate(() => { window.__changeHold = true; window.__changeError = { code: 'io', message: 'Connect couldn’t copy your plugins: No space left on device (os error 28).' }; });
    await armed(page);
    await page.click(`${continueButton}:has-text("Move and restart")`);
    await page.waitForSelector(`${dialog} .ws-dl-progress`);
    await page.evaluate(() => window.__finishChange());
    await page.waitForSelector(`${dialog} .ws-inline-note.ws-error:has-text("No space left on device")`);
    assert(await page.locator(`${dialog} [data-modal-close]`).isVisible(), 'the dialog can be closed again');
    await settle(page);
    await shot(page, `${theme}-data-change-failed`);
    await page.click(`${dialog} [data-action="data-back"]`);
    await page.waitForSelector(`${dialog} input[name="data-mode"]:checked`);
    await page.click(`${dialog} [data-action="data-cancel"]`);
    await page.waitForSelector(dialog, { state: 'detached' });
    assert(await page.locator('#data-location [data-action="data-change"]:not([disabled])').count() === 1, 'Change… after a failed move');
    await page.click('[data-action="data-change"]');
    await page.waitForSelector(`${dialog} [data-action="data-choose"]`);
    assert(errors.length === 0, errors.join(' | '));
    await context.close().catch(() => {});
    currentPage = null;
  });

  await check(`${theme}: a change whose restart failed says the folder changed and offers a restart`, async () => {
    const { page, context, errors } = await open({ theme, hash: '#/settings/general' });
    await page.click('[data-action="data-change"]');
    await page.waitForSelector(`${dialog} [data-action="data-choose"]`);
    await pickFolder(page, PICK.ok);
    await armed(page);
    await page.click(continueButton);
    await page.waitForSelector(`${dialog} .ws-dl-restart`);
    await page.evaluate(() => { window.__changeError = { code: 'restart_failed', message: 'Your data folder was changed. Connect couldn’t restart itself: quit Connect and open it again to finish.' }; });
    await armed(page);
    await page.click(`${continueButton}:has-text("Move and restart")`);
    await page.waitForSelector(`${dialog} h2:has-text("Restart Connect to finish")`);
    const text = await page.locator(dialog).innerText();
    assert(/Your data folder was changed\./.test(text) && !/Move and restart/.test(text), text);
    await page.keyboard.press('Escape');
    await settle(page);
    assert(await page.locator(dialog).count() === 1, 'the dialog closed with the folder changed');
    await shot(page, `${theme}-data-change-stuck`);
    await page.click(`${dialog} [data-action="data-restart"]`);
    await page.waitForSelector(`${dialog} .ws-dl-progress:has-text("Restarting Connect…")`);
    assert(await page.evaluate(() => window.__bridgeCalls.some(([c]) => c === 'app_relaunch')), 'Restart Connect');
    assert(errors.length === 0, errors.join(' | '));
    await context.close().catch(() => {});
    currentPage = null;
  });
}

// Claude set up while Connect is open: Inbox notices when the window gets focus again.
{
  const { page, context, errors } = await open({ theme: 'dark', hash: '#/inbox', ai: 'none' });
  await check('Set up Claude turns into Draft with AI once Claude is ready', async () => {
    await page.waitForSelector('.ws-reply-head [data-action="ai-open-settings"]:has-text("Set up Claude")');
    await page.evaluate(profiles => window.__setAiProfiles(profiles), aiStatus('native').profiles);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForSelector('.ws-reply-head [data-action="ai-draft-options"]', { timeout: 4000 });
    assert(errors.length === 0, errors.join(' | '));
  });
  await context.close().catch(() => {});
  currentPage = null;
}

// Onboarding: start signed out, sign in once, everything appears without choosing sources.
{
  const { page, context, errors } = await open({ theme: 'dark', start: 'signed-out', hash: '#/today' });
  await check('onboarding: signed-out Today invites a single sign-in', async () => {
    await page.waitForSelector('.ws-connect-hero');
    await shot(page, 'dark-onboarding');
    await page.click('.ws-connect-hero button:has-text("Sign in with Microsoft")');
    await page.waitForSelector('.ws-connect-hero:has-text("Finish signing in")');
    const calls = await page.evaluate(() => window.__bridgeCalls);
    const caps = calls.find(([op]) => op === 'graph_connect')[1].capabilities;
    assert(['calendar', 'mail', 'chats'].every(c => caps.includes(c)), JSON.stringify(caps));
    await page.waitForSelector('.ws-upnext:has-text("Happening now")', { timeout: 5000 });
    assert(await page.locator('.ws-msg-row').count() >= 1, 'inbox empty after sign-in');
  });
  await check('onboarding: no page errors', async () => assert(errors.length === 0, errors.join(' | ')));
  await context.close().catch(() => {});
}

// Automations (DESIGN 6.6): create from a template, run, see it on Today, turn off; the editor,
// its validation and the Run log; both themes at 1440, 1000 and 1680 px.
const noOverflow = async (page, what) => {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.ws-main, .ws-modal[open] .ws-modal-body')].map(el => el.scrollWidth - el.clientWidth)));
  assert(overflow <= 0, `${what} overflows by ${overflow}px`);
};
const noToasts = page => page.evaluate(() => document.querySelectorAll('.ws-toast').forEach(t => t.remove()));
/** A screenshot of one element; a background refresh may replace it mid-capture, so try again. */
const elementShot = async (page, selector, name) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await noToasts(page);
      return await page.locator(selector).screenshot({ path: join(OUT, name) });
    } catch (error) {
      if (attempt >= 3 || !/not attached|detached/i.test(error.message)) throw error;
      await page.waitForTimeout(400);
    }
  }
};
/** Wait until the page stops re-rendering (no DOM mutation for 200 ms), so a following query
 * isn't answered by an element a background refresh is about to replace. */
const renderSettled = (page, limit = 3000) => page.evaluate(limit => new Promise((resolve, reject) => {
  let timer;
  const finish = (fn, arg) => { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); fn(arg); };
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => finish(resolve), 200); });
  const cap = setTimeout(() => finish(reject, new Error(`the page was still re-rendering after ${limit} ms`)), limit);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  timer = setTimeout(() => finish(resolve), 200);
}), limit);
/** Open a row's actions menu and wait for it to show; a render between the click and the check
 * closes it, so try again with a fresh query. A menu that is already open is left alone (a second
 * click on its summary would close it). */
const openRowMenu = async (page, row, wanted) => {
  for (let attempt = 0; ; attempt++) {
    await renderSettled(page);
    if (await row.locator('.ws-menu[open]').count() === 0) await row.locator('summary').click();
    try { return await row.locator(wanted).waitFor({ state: 'visible', timeout: 3000 }); }
    catch (error) { if (attempt >= 3) throw error; }
  }
};
const editorOpen = async page => {
  await page.waitForSelector('.ws-modal[open] #automation-editor');
  await page.waitForTimeout(250);
};
for (const theme of ['dark', 'light']) {
  for (const [width, height] of [[1440, 900], [1000, 760], [1680, 960]]) {
    const tag = `${theme}-${width}`;
    const { page, context, errors } = await open({ theme, width, height, hash: '#/automations' });

    await check(`${tag}: automations create from Morning brief, run, show on Today and turn off`, async () => {
      await page.waitForSelector('.ws-page-automations .ws-auto-empty');
      assert(await page.locator('.ws-nav button[data-route=automations][aria-current=page]').count() === 1, 'sidebar entry not current');
      assert(await page.locator('[data-action="automation-new"]').count() === 1, 'New automation offered twice');
      await noOverflow(page, 'empty list');
      await shot(page, `${tag}-automations-empty`);
      await page.click('[data-action="automations-tab"][data-tab="templates"]');
      await page.waitForSelector('[data-action="automation-template"][data-id="morning-brief"]');
      assert(await page.locator('.ws-auto-template').count() === 4, 'four templates');
      await noOverflow(page, 'templates');
      await shot(page, `${tag}-automations-templates`);
      await page.click('[data-action="automation-template"][data-id="morning-brief"]');
      await editorOpen(page);
      assert(await page.inputValue('#auto-name') === 'Morning brief', 'name prefilled');
      assert(await page.inputValue('#auto-time') === '08:45', 'time prefilled');
      assert(await page.locator('[data-day]:checked').count() === 5, 'weekdays');
      assert(await page.locator('[data-deliver="draftReply"]').count() === 0, 'no reply draft for a schedule');
      assert((await text(page, '.ws-modal[open]')).includes('Europe/Kyiv'), 'zone shown');
      await noOverflow(page, 'schedule editor');
      await shot(page, `${tag}-automation-editor-schedule`);
      await page.evaluate(() => { const body = document.querySelector('.ws-modal[open] .ws-modal-body'); body.scrollTop = body.scrollHeight; });
      await shot(page, `${tag}-automation-editor-schedule-bottom`);
      await page.click('.ws-modal[open] button[type=submit]');
      await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
      // Created: back on the list with the new row picked out.
      await page.waitForSelector('[data-tab="automations"][aria-selected="true"]');
      await page.waitForSelector('.ws-auto-row.ws-auto-highlight');
      await shot(page, `${tag}-automations-created`);
      const row = await text(page, '.ws-auto-row');
      assert(row.includes('Weekdays at 08:45') && /Next: (Today|Tomorrow|Mon|Tue|Wed|Thu|Fri) 08:45/.test(row), row);
      await page.waitForSelector('.ws-auto-row:not(.ws-auto-highlight)', { timeout: 6000 });
      const saved = (await page.evaluate(() => window.__bridgeCalls)).filter(([op]) => op === 'automation_save').at(-1)[1];
      assert(saved.trigger.time === '08:45' && saved.deliver.today && saved.read.calendarToday && !saved.deliver.draftReply, JSON.stringify(saved));
      const layout = await page.evaluate(() => window.__workspace.store.get().snapshot.workspaces[0].layout);
      assert(layout.includes('automations'), `Today card added: ${layout}`);
      assert(!(await page.evaluate(() => window.__bridgeCalls)).some(([op]) => op === 'layout_save'), 'the card is added by the save itself');

      const id = saved.id || await page.locator('.ws-auto-row').getAttribute('data-automation');
      await page.click(`.ws-auto-row [data-action="automation-run"]`);
      await page.waitForSelector('.ws-auto-row .ws-badge-info');
      await page.waitForSelector('.ws-auto-row .ws-badge-success', { timeout: 6000 });
      await noOverflow(page, 'populated list');
      await shot(page, `${tag}-automations-list`);

      await page.click('.ws-nav button[data-route=today]');
      await page.waitForSelector('.ws-auto-card .ws-auto-result');
      assert((await text(page, '.ws-auto-card')).includes('2 replies owed'), 'run on Today');
      assert(await page.locator('.ws-auto-card [data-action="automation-open-run"]').count() === 1, 'Open run');
      await page.locator('.ws-auto-card').scrollIntoViewIfNeeded();
      await noOverflow(page, 'Today');
      await elementShot(page, '.ws-auto-card', `${tag}-today-automation-results.png`);
      await page.click('.ws-auto-card [data-action="automation-open-run"]');
      await page.waitForSelector('.ws-run.ws-open .ws-run-output');

      await page.click('.ws-nav button[data-route=automations]');
      await page.click('[data-action="automations-tab"][data-tab="automations"]');
      await renderSettled(page);
      await page.locator('.ws-auto-row .ws-switch').first().click();
      await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'automation_toggle' && d.enabled === false));
      await page.waitForSelector('.ws-auto-row.ws-off');
      assert(!(await page.locator('.ws-auto-row input[data-action="automation-toggle"]').isChecked()), 'switch still on');
      assert(id, 'saved automation id');
    });

    await check(`${tag}: the editor locks the conversation for reply drafts and shows backend sentences inline`, async () => {
      await page.click('[data-action="automations-tab"][data-tab="templates"]');
      await page.click('[data-action="automation-template"][data-id="draft-replies"]');
      await editorOpen(page);
      assert(await page.evaluate(() => document.activeElement?.id) === 'auto-senders', 'senders first');
      const conversation = page.locator('[data-read="triggerConversation"]');
      assert(await conversation.isChecked() && await conversation.isDisabled(), 'triggering conversation not locked');
      assert(await page.locator('select[name="auto-event"]').inputValue() === 'mail_from', 'event');
      await noOverflow(page, 'event editor');
      await shot(page, `${tag}-automation-editor-event`);
      await page.click('.ws-modal[open] button[type=submit]');
      await page.waitForSelector('#auto-senders[aria-invalid="true"]');
      assert((await text(page, '.ws-modal[open] .ws-field-error')).includes('Add at least one sender or domain'), 'inline sentence');
      assert(await page.evaluate(() => document.activeElement?.id) === 'auto-senders', 'focus on the field');
      await shot(page, `${tag}-automation-editor-error`);
      // Turning the reply draft off unlocks the conversation; a schedule has no reply draft.
      await page.locator('.ws-modal[open] [data-deliver="draftReply"]').locator('xpath=..').click();
      await page.waitForFunction(() => !document.querySelector('[data-read="triggerConversation"]').disabled);
      await page.click('[data-action="automation-kind"][data-kind="schedule"]');
      await page.waitForSelector('#auto-time:visible');
      assert(await page.locator('[data-deliver="draftReply"]').count() === 0, 'reply draft on a schedule');
      await page.click('[data-action="automation-kind"][data-kind="event"]');
      await page.fill('#auto-senders', 'ann@example.test');
      await page.click('.ws-modal[open] button[type=submit]');
      await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
      const saved = (await page.evaluate(() => window.__bridgeCalls)).filter(([op]) => op === 'automation_save').at(-1)[1];
      assert(saved.trigger.senders[0] === 'ann@example.test' && saved.deliver.draftReply === false && saved.read.triggerConversation === true, JSON.stringify(saved));
    });

    await check(`${tag}: automations no page errors`, async () => assert(errors.length === 0, errors.join(' | ')));
    await context.close().catch(() => {});

    const logged = await open({ theme, width, height, hash: '#/automations/runs', automations: true });
    await check(`${tag}: run log expands output, sources and the error`, async () => {
      const p = logged.page;
      await p.waitForSelector('.ws-run-log .ws-run');
      assert(await p.locator('.ws-run').count() === 3, 'three runs');
      await p.click('.ws-run-row:has-text("Morning brief"):has(.ws-badge-success)');
      await p.waitForSelector('.ws-run.ws-open .ws-run-output');
      const output = await text(p, '.ws-run.ws-open .ws-run-detail');
      assert(output.includes('2 replies owed') && output.includes('Answer Ann about the Q3 budget') && output.includes('Send the roadmap'), output);
      assert(await p.locator('.ws-run.ws-open .ws-run-summary-text strong').innerText() === 'Q3 budget', 'bold');
      assert(await p.locator('.ws-run-detail a[href]').count() === 0, 'a link the window could follow');
      await p.click('.ws-run.ws-open [data-action="run-link"]');
      await p.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'open_source' && d.kind === 'automation_run' && d.link === 0));
      await noOverflow(p, 'run log');
      await elementShot(p, '.ws-run.ws-open', `${tag}-automation-runlog-ok.png`);
      await p.click('.ws-run-row:has(.ws-badge-error)');
      await p.waitForSelector('.ws-run.ws-open .ws-run-error');
      assert((await text(p, '.ws-run.ws-open .ws-run-error')).includes('signed in'), 'failure sentence');
      await elementShot(p, '.ws-run.ws-open:has(.ws-run-error)', `${tag}-automation-runlog-failed.png`);
      await shot(p, `${tag}-automation-runlog`);
      // The filter shows one automation's runs.
      await p.selectOption('select[name="auto-runs-filter"]', 'auto-reply');
      await p.waitForFunction(() => document.querySelectorAll('.ws-run').length === 1);
      assert((await text(p, '.ws-run-log')).includes('Draft replies to Ann'), 'filtered run');
      await p.selectOption('select[name="auto-runs-filter"]', '');
      await p.waitForFunction(() => document.querySelectorAll('.ws-run').length === 3);
      await p.click('.ws-run-row:has-text("Morning brief"):has(.ws-badge-success)');
      await p.waitForSelector('.ws-run.ws-open .ws-run-items [data-action="open-message"]');
      // A cited message opens in the Inbox.
      await p.click('.ws-run.ws-open .ws-run-items [data-action="open-message"]');
      await p.waitForSelector('.ws-page-inbox .ws-read[data-message-id="m0"]');
      // Without automations' failures in the decisions bell.
      assert(await p.locator('.ws-bell-dot').count() === 0, 'failed runs became decisions');
      // A click on the run's notification opens that run in the Run log.
      await p.evaluate(() => window.__emitNative('workspace:notification-open', { workspaceId: 'personal', runId: 'run-2', automationId: 'auto-brief' }));
      await p.waitForSelector('.ws-page-automations .ws-run.ws-open .ws-run-error');
      assert(await p.locator('select[name="auto-runs-filter"]').inputValue() === 'auto-brief', 'filtered to its automation');
    });
    await check(`${tag}: the list and Today show both automations' latest results`, async () => {
      const p = logged.page;
      await p.click('.ws-nav button[data-route=automations]');
      await p.click('[data-action="automations-tab"][data-tab="automations"]');
      await p.waitForSelector('.ws-auto-row >> nth=1');
      assert((await text(p, '.ws-auto-list')).includes('When mail arrives from @epam.com or ann@example.org about “budget”'), 'event trigger summary');
      await noOverflow(p, 'populated list');
      await shot(p, `${tag}-automations-list-populated`);
      await openRowMenu(p, p.locator('.ws-auto-row[data-automation="auto-brief"]'), '.ws-menu[open] [data-action="automation-delete"]');
      // An update (the minute tick, a sync) doesn't close it.
      await p.evaluate(() => window.__workspace.render());
      assert(await p.locator('.ws-auto-row[data-automation="auto-brief"] .ws-menu[open]').count() === 1, 'menu closed by a render');
      await shot(p, `${tag}-automations-menu`);
      // Duplicate: a copy that is off.
      await p.click('.ws-auto-row[data-automation="auto-brief"] [data-action="automation-duplicate"]');
      await p.waitForSelector('.ws-auto-row.ws-off:has-text("Copy of Morning brief")');
      // Delete asks first, then removes it.
      const copy = p.locator('.ws-auto-row:has-text("Copy of Morning brief")');
      await openRowMenu(p, copy, '[data-action="automation-delete"]');
      await copy.locator('[data-action="automation-delete"]').click();
      await p.waitForSelector('.ws-modal[open]:has-text("Delete “Copy of Morning brief”?")');
      await p.waitForTimeout(450);
      await p.click('.ws-modal[open] button[type=submit]');
      await p.waitForSelector('.ws-auto-row:has-text("Copy of Morning brief")', { state: 'detached' });
      assert(await p.locator('.ws-auto-row').count() === 2, 'two automations left');
      // The fixture's automations were stored without a save; put their card on Today if it isn't yet.
      await p.evaluate(async () => {
        const w = window.__workspace.store.get().snapshot.workspaces[0];
        if (!w.layout.includes('automations')) await window.__workspace.store.mutate('layout_save', { layout: [...w.layout, 'automations'], widgetWidths: w.widgetWidths });
      });
      await p.click('.ws-nav button[data-route=today]');
      await p.waitForSelector('.ws-auto-card .ws-auto-result >> nth=1');
      const card = await text(p, '.ws-auto-card');
      assert(/Latest run failed 5 min ago: Claude Code isn.t signed in\./.test(card), card);
      // Newest first: Morning brief's failure 5 minutes ago (above its older result), then Ann's reply.
      assert(card.indexOf('Latest run failed') < card.indexOf('2 replies owed') && card.indexOf('2 replies owed') < card.indexOf('Reply drafted for Ann'), card);
      await p.locator('.ws-auto-card').scrollIntoViewIfNeeded();
      await noOverflow(p, 'Today');
      await elementShot(p, '.ws-auto-card', `${tag}-today-automation-results-two.png`);
      // The failure line opens the failed run; the result's Open run its own.
      await p.click('.ws-auto-card .ws-auto-problem [data-action="automation-open-run"]');
      await p.waitForSelector('.ws-page-automations .ws-run.ws-open .ws-run-error');
    });
    await check(`${tag}: run log no page errors`, async () => assert(logged.errors.length === 0, logged.errors.join(' | ')));
    await logged.context.close().catch(() => {});
  }
}

// Plugins (DESIGN 7.3, Tasks 23–24): add a marketplace, install the synthetic hello plugin, its
// page and Settings section in their sandboxed frame, Today's plugin widgets, turn it off.
if (process.env.WORKSPACE_E2E_ONLY !== 'plugins') await pluginChecks({ open, check, assert, shot, OUT });

// Narrow and wide windows keep layouts intact.
for (const width of [1000, 1680]) {
  const { page, context } = await open({ theme: 'light', width, height: 820 });
  await check(`layout ${width}px: no horizontal overflow on primary routes`, async () => {
    for (const route of ['today', 'calendar', 'inbox', 'settings']) {
      await page.click(`.ws-nav button[data-route=${route}]`);
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 0, `${route} overflows by ${overflow}px`);
      await shot(page, `light-${route}-${width}`);
    }
    await page.click('.ws-settings-nav button[data-tab=ai]');
    await page.waitForSelector('[data-ai-profile="claude"]');
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.ws-settings-panels, .ws-ai-table-wrap')].map(e => e.scrollWidth - e.clientWidth)));
    assert(overflow <= 0, `claude settings overflow by ${overflow}px`);
    await shot(page, `light-settings-claude-${width}`);
  });
  await context.close().catch(() => {});
}

await browser.close();
server.close();
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
