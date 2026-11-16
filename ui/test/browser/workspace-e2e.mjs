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
import { buildSnapshot } from '../fixtures/workspace-fixture.mjs';

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

function installBridge({ snapshot, connected }) {
  const s = snapshot;
  let authPending = false;
  const calls = [];
  const listeners = {};
  const clone = x => JSON.parse(JSON.stringify(x));
  const now = () => Math.floor(Date.now() / 1000);
  const emit = name => setTimeout(() => (listeners[name] || []).forEach(fn => fn({ payload: {} })), 10);
  const active = wid => s.workspaces.find(w => w.id === (wid || s.settings.activeWorkspace));
  const find = (kind, id) => s.records.find(r => r.kind === kind && r.id === id);
  const fail = (code, message) => { throw { code, message }; };
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
    job_cancel: () => ({ saved: true }),
    job_retry: () => ({ saved: true }),
    notification_permission: () => ({ permission: 'os_managed' }),
    notification_test: () => ({ queued: true }),
    export: () => ({ version: 1, workspaces: [], records: [] }),
    ai_probe: () => ({ ready: false, message: 'No isolated Claude API profile is configured.' }),
    action_prepare: () => fail('permission_required', 'Allow replies in Settings first.'),
  };
  window.__bridgeCalls = calls;
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        if (cmd === 'smoke_mode') return { smoke: false, probe: false, dev: true };
        if (cmd === 'runtime_ready') return false;
        if (cmd === 'get_app_version') return '2.2.0';
        if (cmd === 'check_for_update') return null;
        if (cmd === 'workspace_installer_busy') return null;
        if (cmd !== 'workspace_request') throw new Error(`Unexpected native command ${cmd}`);
        const r = args.request;
        // Fake background sync: bump the revision once so the next fenced write is stale.
        if (window.__syncBump && r.op !== 'snapshot') { window.__syncBump = false; s.revision++; }
        if (r.op !== 'snapshot' && r.expectedRevision !== undefined && r.expectedRevision !== s.revision) throw { code: 'stale_view', message: 'This view changed.' };
        const op = ops[r.op];
        if (!op) throw { code: 'validation', message: `Mock does not implement ${r.op}` };
        const result = op(r.data || {}, r.workspaceId);
        if (r.op !== 'snapshot') { s.revision++; emit('workspace:changed'); }
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
    console.log(`✖ ${name} — ${error.message.split('\n')[0]}`);
  }
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };

const browser = await chromium.launch();
async function open({ theme = 'dark', width = 1440, height = 900, start = 'connected', hash = '#/today' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  const now = Date.now();
  const connected = buildSnapshot(now, { theme, zone: 'Europe/Kyiv' });
  const snapshot = start === 'connected' ? connected : buildSnapshot(now, { connected: false, theme, zone: 'Europe/Kyiv' });
  await page.addInitScript(`(${installBridge})(${JSON.stringify({ snapshot, connected })})`);
  await page.goto(base + hash);
  await page.waitForSelector('.ws-sidebar');
  currentPage = page;
  return { page, context, errors };
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
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

  await check(`${theme}: Workspaces create and switch`, async () => {
    await page.click('.ws-nav button[data-route=workspaces]');
    await page.click('button:has-text("New workspace")');
    await page.fill('.ws-modal[open] [name=name]', 'Client X');
    await page.click('.ws-modal[open] button[type=submit]');
    await page.waitForSelector('.ws-workspace-card:has-text("Client X")');
    assert(await page.locator('#workspace-select').inputValue() !== 'personal', 'did not switch');
    await page.selectOption('#workspace-select', 'personal');
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
  });
  await context.close().catch(() => {});
}

await browser.close();
server.close();
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
