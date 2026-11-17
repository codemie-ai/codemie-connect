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
import { buildSnapshot, aiStatus, aiUsage, contractFixtures } from '../fixtures/workspace-fixture.mjs';

const UI = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('../../../output/playwright/workspace-e2e/', import.meta.url));
const core = process.env.PLAYWRIGHT_CORE;
const playwright = await import(core ? pathToFileURL(join(core, 'index.js')).href : 'playwright-core');
const chromium = playwright.chromium || playwright.default.chromium;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  try {
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

function installBridge({ snapshot, connected, ai: aiInit, usage, testOk, testFail, draft: mailDraft, draftChat: chatDraft, jobFailed: jobTemplate, summary: summaryTemplate, storage, unavailable }) {
  const s = snapshot;
  const ai = aiInit;
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
    snapshot: () => ({ snapshot: clone(s), authPending, authError: null }),
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
    layout_save: (d, wid) => { const w = active(wid); w.layout = d.layout; w.widgetWidths = d.widgetWidths; return { saved: true }; },
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
  window.__setSummaryStale = value => { for (const r of s.records) if (r.kind === 'summary') r.data.stale = value; s.revision++; emit('workspace:changed'); };
  window.__bridgeCalls = calls;
  // What detection finds next time (Claude signed in or set up meanwhile).
  window.__setAiProfiles = profiles => { ai.profiles = profiles; };
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        if (cmd === 'smoke_mode') return { smoke: false, probe: false, dev: true };
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
        if (r.op !== 'snapshot' && !['ai_status', 'ai_usage', 'ai_test'].includes(r.op)) { s.revision++; emit('workspace:changed'); }
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

async function open({ theme = 'dark', width = 1440, height = 900, start = 'connected', hash = '#/today', ai = 'both', aiDefault, enable = [], longThread = false, storage = storageOf('ready', { dataRoot: DEFAULT_ROOT, custom: false }), unavailable = false } = {}) {
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
  const snapshot = start === 'connected' ? connected : buildSnapshot(now, { connected: false, theme, zone: 'Europe/Kyiv' });
  const { testOk, testFail, draft, draftChat, jobFailed, summary } = contractFixtures();
  await page.addInitScript(`(${installBridge})(${JSON.stringify({ snapshot, connected, ai: aiStatus(ai, aiDefault === undefined ? {} : { defaultProfile: aiDefault }), usage: aiUsage(), testOk, testFail, draft, draftChat, jobFailed, summary, storage, unavailable })})`);
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
      assert(!/Choose another folder/.test(body), 'dead Choose button');
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
