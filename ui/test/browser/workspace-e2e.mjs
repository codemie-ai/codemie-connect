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
import { buildSnapshot, aiStatus, aiUsage, contractFixtures, dataLocation, folderCheck, CHECKS, automationContract, withAutomations, pluginContract, withTasks, withMeetings, meetingFolders, meetingContract } from '../fixtures/workspace-fixture.mjs';
import { pluginChecks } from './plugins-checks.mjs';
import { meetingChecks } from './meetings-checks.mjs';
import { meetingsViewChecks } from './meetings-view-checks.mjs';
import { meetingSettingsChecks } from './meetings-settings-checks.mjs';
import { layoutChecks } from './layout-checks.mjs';
import { analyticsChecks } from './analytics-checks.mjs';
import { compactChecks } from './compact-checks.mjs';
import { replyChecks } from './reply-checks.mjs';
import { NAV } from '../../workspace/shell.js';

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
    // meetings-view-checks.mjs V9: a mock plugin frame hook, beside the existing plugin mocks
    // above. No synthetic frame actually declares `call.minutes` for this check, so the served
    // copy of the real host.js is wrapped to answer `callSlots()`/`minutesPlugins()` from a plain
    // page global, `window.__minutes = {pluginId, name, minutes}`, as if a plugin's frame had
    // declared that slot. The real module on disk (and every other import of it, including the
    // node:test suite) is untouched; only what this server hands the browser for this one path is.
    if (path === 'plugins/host.js') {
      const real = await readFile(join(UI, path), 'utf8');
      const marker = 'export function createPluginHost(';
      const at = real.indexOf(marker);
      if (at < 0) throw new Error('createPluginHost not found in plugins/host.js');
      const patched = `${real.slice(0, at)}function __realCreatePluginHost(${real.slice(at + marker.length)}
export function createPluginHost(opts) {
  const api = __realCreatePluginHost(opts);
  const realCallSlots = api.callSlots;
  const realMinutesPlugins = api.minutesPlugins;
  const realSetCall = api.setCall;
  // callSlots() only answers slots whose \`call\` names the meeting shown (view-meetings.js
  // \`slotsOf\`): remember the latest one setCall() was given, so the injected slot can match it.
  let lastCall = null;
  api.setCall = next => { lastCall = next; return realSetCall ? realSetCall(next) : undefined; };
  api.callSlots = () => {
    const base = realCallSlots ? realCallSlots() : [];
    const extra = typeof window === 'undefined' ? null : window.__minutes;
    return extra && lastCall ? [...base, { plugin: extra.pluginId, pluginName: extra.name, call: lastCall.name, header: [], menu: [], minutes: extra.minutes || [] }] : base;
  };
  api.minutesPlugins = () => {
    const base = realMinutesPlugins ? realMinutesPlugins() : [];
    const extra = typeof window === 'undefined' ? null : window.__minutes;
    return extra ? [...base, { id: extra.pluginId, name: extra.name }] : base;
  };
  return api;
}
`;
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(patched);
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

function installBridge({ snapshot, connected, ai: aiInit, usage, testOk, testFail, draft: mailDraft, draftChat: chatDraft, jobFailed: jobTemplate, summary: summaryTemplate, storage, unavailable, location: locationInit, checks, automation: automationTemplates, plugins: pluginInit, frameBase, codemie = 'ready', folders: folderInit = {}, notesJob = null, glossaryText = '', analytics = null, navIds = [] }) {
  // Connect's window only: a plugin frame gets nothing of the native bridge.
  if (window.top !== window) return;
  // compact-checks.mjs C1: records #workspace-app's data-view the moment it gets its first element
  // child (the loading spinner boot() draws before the native snapshot arrives) — the view the
  // import-time localStorage mirror picked, before a mismatched one is corrected against it.
  window.__firstChildView = undefined;
  new MutationObserver((_, obs) => {
    const root = document.getElementById('workspace-app');
    if (root?.firstElementChild && window.__firstChildView === undefined) {
      window.__firstChildView = root.dataset.view ?? null;
      obs.disconnect();
    }
  }).observe(document, { childList: true, subtree: true });
  // ---- CodeMie CLI, mocked by scenario: 'fresh' (nothing set up), 'ready', 'expired' (signed out).
  const NOT_CODEMIE = Symbol('not codemie');
  const cm = {
    profiles: codemie === 'fresh' ? [] : [{ name: 'prod', provider: 'ai-run-sso', model: 'claude-sonnet-4-5', codemieUrl: 'https://codemie.lab.epam.com', codemieProject: 'EPM-CDME' }],
    signedIn: codemie !== 'expired',
    agents: codemie === 'fresh' ? [] : ['claude'],
    apps: { 'claude-desktop': codemie !== 'fresh' },
  };
  const agentList = () => `📦 Available Agents:\n\n  CodeMie Code (0.0.47)\n    Command: codemie-code\n    Status: ✓ installed\n    CodeMie Code - AI coding assistant\n\n${[['Claude Code', 'claude', '2.1.281', 'Claude Code - official Anthropic CLI tool'], ['Gemini CLI', 'gemini', '0.59.0', 'Google Gemini CLI - AI coding assistant'], ['OpenAI Codex CLI', 'codex', '0.154.0', 'OpenAI Codex CLI - AI coding agent by OpenAI'], ['Kimi Code ACP', 'kimi-acp', '0.42.0', 'Kimi Code CLI ACP mode for IDE integration']].map(([name, command, version, desc]) => `  ${name}${cm.agents.includes(command) ? ` (${version})` : ''}\n    Command: ${command}\n    Status: ${cm.agents.includes(command) ? '✓ installed' : 'not installed'}\n    ${desc}\n`).join('\n')}\n🛠️  Available Frameworks:\n`;
  const doctorLines = ['Active Profile:', '  ✓ Active Profile: prod', '  ✓ Model: claude-sonnet-4-5', '', 'Installed Agents:', '  ✓ Claude Code (2.1.281)', '', 'Node.js:', '  ✓ Version 22.23.2', ''];
  const stream = async (id, lines) => {
    for (const text of lines) window.__emitNative('engine:cmd-line', { id, text, tag: 'stdout' });
    return 0;
  };
  async function codemieNative(cmd, args) {
    switch (cmd) {
      case 'runtime_ready': return true;
      case 'ensure_runtime': window.__emitNative('runtime:progress', { phase: 'cli', fraction: 1 }); return null;
      case 'update_cli': return null;
      case 'check_handshake_state': return { global_found: false, global_version: null, bundled_takes_precedence: false };
      case 'codemie_org_defaults': return null;
      case 'read_codemie_profiles': return { state: cm.profiles.length ? 'valid' : 'no-configuration', active: cm.profiles[0]?.name ?? null, account: cm.profiles.length ? 'taylor.morgan@epam.com' : null, profiles: JSON.parse(JSON.stringify(cm.profiles)) };
      case 'check_profile_status': return { state: cm.signedIn ? 'signed_in' : 'not_signed_in', detail: '', code: 0 };
      case 'codemie_app_states': return ['claude-desktop', 'vscode-copilot', 'vscode-claude', 'codex-desktop'].map(id => ({ id, installed: id === 'claude-desktop', configured: !!cm.apps[id] }));
      case 'codemie_url_check': return /example\.com/.test(args.url) ? { verdict: 'not_codemie', status: 404, detail: `GET ${args.url}/code-assistant-api/v1/auth/login/53117 → 404` } : { verdict: 'codemie', status: 302, detail: 'GET … → 302' };
      case 'open_agent_in_terminal': case 'open_app_download': case 'pick_project_folder': return null;
      case 'run_capture': {
        const c = args.cmd;
        if (c.startsWith('codemie list')) return { code: 0, stdout: agentList(), stderr: '' };
        if (c.startsWith('codemie --version')) return { code: 0, stdout: '0.16.3\n', stderr: '' };
        if (c.startsWith('codemie proxy status')) return { code: 0, stdout: JSON.stringify(cm.apps['claude-desktop'] ? { status: 'healthy', apiKey: 'gk-mock', port: 4001, profile: 'prod' } : { status: 'stopped' }), stderr: '' };
        if (c.startsWith('codemie proxy connect')) { cm.apps['claude-desktop'] = true; return { code: 0, stdout: '✓ Claude Desktop connected', stderr: '' }; }
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'run_stream': {
        const c = args.cmd;
        await new Promise(r => setTimeout(r, 200));
        if (c.startsWith('codemie install ')) { cm.agents.push(c.split(' ')[2]); return stream(args.streamId, ['- Installing', '✓ Installed']); }
        if (c.startsWith('codemie doctor')) return stream(args.streamId, doctorLines);
        if (c.startsWith('codemie profile login')) { cm.signedIn = true; return stream(args.streamId, ['Opening browser for authentication...', '✓ Authentication successful!']); }
        return stream(args.streamId, []);
      }
      default: return NOT_CODEMIE;
    }
  }
  // Analytics (analytics-checks.mjs hands over the contract answers as `analytics`). A fetch is
  // acted out: the status says `running`, three `workspace:analytics` events follow, and the end
  // stores `lastFetchAt` and the days read again.
  function analyticsOps() {
    const an = clone(analytics);
    const fetchRun = (label, total, failedAfter) => {
      an.status.state = 'running';
      an.status.progress = { done: 0, total, label };
      const emitStep = done => {
        const last = done >= total;
        if (last) {
          Object.assign(an.status, { state: 'ready', progress: null, lastFetchAt: Date.now(), failedDays: failedAfter });
          window.__emitNative('workspace:analytics', { running: false, done, total, label, failedDays: failedAfter });
        } else {
          an.status.progress = { done, total, label };
          window.__emitNative('workspace:analytics', { running: true, done, total, label, failedDays: an.status.failedDays });
        }
      };
      for (let i = 1; i <= total; i++) setTimeout(() => emitStep(i), 350 * i);
    };
    return {
      analytics_status: () => { calls.push(['analytics_status', {}]); return clone(an.status); },
      analytics_view: d => {
        calls.push(['analytics_view', clone(d)]);
        if (an.status.state === 'needs_cli') fail('needs_cli', 'Analytics needs a newer CodeMie CLI.');
        return clone(an.summary);
      },
      analytics_session: d => { calls.push(['analytics_session', clone(d)]); return clone(an.session); },
      analytics_app: d => { calls.push(['analytics_app', clone(d)]); return clone(an.app); },
      analytics_report: d => { calls.push(['analytics_report', clone(d)]); return { opened: true }; },
      analytics_refresh: () => {
        calls.push(['analytics_refresh', {}]);
        if (an.status.state === 'needs_cli') return clone(an.refreshNeedsCli);
        if (an.status.state === 'running') return clone(an.refreshRunning);
        fetchRun('Checking for new sessions', 3, an.status.failedDays || []);
        return { started: true };
      },
      // `{day}` reads that day again, `{}` every failed day (`failedDays` is `[{day, reason}]`).
      analytics_retry: d => {
        calls.push(['analytics_retry', clone(d)]);
        const failed = an.status.failedDays || [];
        fetchRun(d.day ? `Reading ${d.day}` : 'Reading the failed days again', Math.max(1, d.day ? 1 : failed.length), d.day ? failed.filter(x => x.day !== d.day) : []);
        return { started: true };
      },
    };
  }
  const s = snapshot;
  // Saved layouts survive page.reload(): the workspaces live in sessionStorage too.
  try { const kept = sessionStorage.getItem('e2e.workspaces'); if (kept) s.workspaces = JSON.parse(kept); } catch {}
  // A check that reloads after a send keeps the stored drafts, as native does (read once).
  try {
    const drafts = sessionStorage.getItem('e2e.drafts');
    if (drafts) {
      sessionStorage.removeItem('e2e.drafts');
      s.records = s.records.filter(r => r.kind !== 'draft').concat(JSON.parse(drafts));
    }
  } catch {}
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
  // A refused field, as WorkspaceError carries it (`field`), so the UI can show it there.
  const refuse = (field, message) => { throw { code: 'validation', message, field }; };
  // Settings › Meetings: the built-in templates as native has them, the glossary and tag texts in
  // the meetings folder, and whether Microsoft's last sign-in was refused.
  const BUILT_INS = clone((s.noteTemplates || []).filter(t => t.kind === 'builtin'));
  const texts = { glossary: glossaryText, tags: '' };
  // glossary.rs `read_text`: `window.__textRead[name]` is `unreadable` (no permission) or `cut`
  // (longer than 100 KB) for a check of those states.
  const textRead = name => {
    if (window.__textRead?.[name] === 'unreadable') fail('unreadable', `Connect can’t read ${name}.md (it isn’t allowed to open it), so it won’t change it. Check the file in Finder, then try again.`);
  };
  let authError = null;
  /** model.rs `MeetingSettings::apply`: only the fields given change, each checked; nothing
   *  changes when one is refused. */
  function applyMeetings(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) refuse('meetings', 'Send the meeting settings as an object.');
    const next = clone(s.settings.meetings);
    const one = (k, v, allowed, message) => { if (!allowed.includes(v)) refuse(k, message); next[k] = v; };
    const int = (k, v, lo, hi, message) => { if (!Number.isInteger(v) || v < lo || v > hi) refuse(k, message); next[k] = v; };
    const path = (k, v, message) => { if (v === null || v === '') return null; if (typeof v !== 'string' || !v.trim().startsWith('/')) refuse(k, message); return v.trim(); };
    for (const [k, v] of Object.entries(d)) {
      switch (k) {
        case 'root': {
          const root = path(k, v, 'Choose a folder for your meetings.');
          if (root && root !== s.settings.meetings.root && !(window.__dirs || []).includes(root)) refuse(k, 'That folder doesn’t exist. Choose another one.');
          next.root = root;
          break;
        }
        case 'folderPattern': one(k, v, ['echo', 'date-title', 'title-date'], 'Choose a folder name pattern.'); break;
        case 'checkEveryMin': one(k, v, [5, 10, 30], 'Look for transcripts every 5, 10 or 30 minutes.'); break;
        case 'autoNotes': one(k, v, ['off', 'rules', 'all'], 'Choose when notes are made automatically.'); break;
        case 'waitMin': int(k, v, 0, 240, 'Wait between 0 and 240 minutes after the meeting.'); break;
        case 'doneDays': int(k, v, 1, 365, 'Hide done tasks after 1 to 365 days.'); break;
        case 'openOn': one(k, v, ['summary', 'transcript', 'notes'], 'Choose Summary, Transcript or Notes.'); break;
        case 'actionItems':
          if (typeof v !== 'boolean') refuse(k, 'Turn this setting on or off.');
          next[k] = v;
          break;
        case 'summaryTabs': {
          const message = 'Choose a template or a plugin to pin.';
          if (!Array.isArray(v)) refuse(k, message);
          const tabs = [];
          for (const item of v) {
            if (typeof item !== 'string' || item.length < 1 || item.length > 100 || !/^[A-Za-z0-9\-_.:]+$/.test(item)) refuse(k, message);
            if (!tabs.includes(item)) tabs.push(item);
          }
          if (tabs.length > 4) refuse(k, 'Pin up to 4 summaries.');
          next.summaryTabs = tabs;
          break;
        }
        case 'skipShort': case 'keepVtt': case 'keepVersions': case 'review': case 'onlyAttendees': case 'weMe': case 'askSpeakers': case 'remind': case 'dueOnlySaid':
          if (typeof v !== 'boolean') refuse(k, 'Turn this setting on or off.');
          next[k] = v;
          break;
        case 'glossarySource': one(k, v, ['connect', 'file'], 'Choose where the glossary and tags live.'); break;
        case 'glossaryFile': next[k] = path(k, v, 'Choose the glossary file by its full path.'); break;
        case 'tagsFile': next[k] = path(k, v, 'Choose the tags file by its full path.'); break;
        case 'defaultTemplate': if (typeof v !== 'string' || !v.trim() || v.length > 100) refuse(k, 'Choose a default template.'); next[k] = v.trim(); break;
        case 'columns':
          if (!v || typeof v !== 'object') refuse(k, 'Name the board columns.');
          next.columns = { ...next.columns };
          for (const [status, name] of Object.entries(v)) {
            if (!['review', 'todo', 'doing', 'waiting', 'done'].includes(status)) refuse(k, 'Name only the board’s own columns.');
            const n = name === null ? '' : String(name).trim();
            if ([...n].length > 40) refuse(k, 'Keep column names to 40 characters.');
            if (n) next.columns[status] = n; else delete next.columns[status];
          }
          break;
        default: refuse(k, 'Unknown meeting setting.');
      }
    }
    s.settings.meetings = next;
    s.meetingsRoot = { path: next.root || DEFAULT_MEETINGS_ROOT, isDefault: !next.root };
  }
  const DEFAULT_MEETINGS_ROOT = s.meetingsRoot?.path || '/Users/taylor/CodeMie Connect/Meetings';
  const SCOPES = { calendar: 'Calendars.Read', mail: 'Mail.Read', chats: 'Chat.Read', meetings: 'OnlineMeetings.Read', transcripts: 'OnlineMeetingTranscript.Read.All' };
  const ops = {
    snapshot: () => ({ snapshot: { ...clone(s), records: [...clone(s.records), ...clone(shownRuns())] }, authPending, authError }),
    settings_update: d => {
      calls.push(['settings_update', clone(d)]);
      if ('view' in d && !['default', 'compact'].includes(d.view)) refuse('view', 'Unknown view.');
      const rootBefore = s.settings.meetings?.root ?? null;
      if (d.meetings) applyMeetings(d.meetings);
      if (d.capabilities) s.connection.enabled = d.capabilities;
      for (const [k, v] of Object.entries(d)) {
        if (k === 'capabilities' || k === 'meetings') continue;
        if (k === 'hiddenPages') { s.settings.hiddenPages = navIds.filter(id => v.includes(id)); continue; }
        s.settings[k] = v;
      }
      // library_ops.rs `carry_texts`: a new meetings folder gets the glossary and the tag list
      // (the mock keeps one copy of each, so nothing is ever kept apart or fails).
      if (d.meetings && 'root' in d.meetings && (s.settings.meetings.root ?? null) !== rootBefore) {
        return { saved: true, texts: { copied: ['glossary', 'tags'].filter(n => texts[n]).map(n => `${n}.md`), kept: [], failed: [] } };
      }
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
    draft_save: (d, wid) => {
      calls.push(['draft_save', clone(d)]);
      return ops.local_save({ ...d, kind: 'draft', id: `manual:${d.sourceId}` }, wid);
    },
    layout_save: (d, wid) => {
      calls.push(['layout_save', clone(d)]);
      const w = active(wid);
      if (d.layout) w.layout = [...new Set(d.layout)];
      if (d.today) w.today = clone(d.today);
      if (d.widgetWidths) w.widgetWidths = d.widgetWidths;
      try { sessionStorage.setItem('e2e.workspaces', JSON.stringify(s.workspaces)); } catch {}
      return { saved: true };
    },
    workspace_create: d => { const id = crypto.randomUUID(); s.workspaces.push({ id, name: d.name, color: d.color, archived: false, isDefault: false, connectionId: s.connection?.id || null, sources: { all: true }, layout: ['brief', 'calendar', 'inbox', 'commitments', 'focus'], widgetWidths: {} }); s.settings.activeWorkspace = id; return { id }; },
    workspace_update: (d, wid) => { Object.assign(active(wid), d); if (d.archived && s.settings.activeWorkspace === wid) s.settings.activeWorkspace = 'personal'; return { saved: true }; },
    workspace_select: d => { s.settings.activeWorkspace = d.id; return { selected: true }; },
    inbox_decision: d => {
      calls.push(['inbox_decision', clone(d)]);
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
      authError = null;
      setTimeout(() => {
        authPending = false;
        // `__consentDeclined`: Microsoft's page said no; nothing changes and the sign-in says why.
        if (window.__consentDeclined) authError = 'Microsoft didn’t give Connect access: the permission request was declined.';
        else {
          const before = s.connection && s.connection.status !== 'disconnected' ? s.connection : null;
          Object.assign(s, connected, { settings: { ...connected.settings, theme: s.settings.theme } });
          // The capabilities asked for, with their scopes (graph.rs finish_auth).
          const caps = [...new Set([...(before ? before.enabled : connected.connection.enabled), ...(d.capabilities || [])])];
          s.connection = { ...s.connection, enabled: caps, scopes: [...new Set([...(s.connection.scopes || []), ...caps.map(c => SCOPES[c]).filter(Boolean)])] };
        }
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
      // save.rs `note_save_stopped`: a stopped save of a meeting still in Teams is not started again by itself.
      const stopped = job?.kind === 'transcript_download' && s.records.find(r => r.kind === 'meeting' && r.id === job.payload?.meetingId);
      if (stopped && stopped.data.state === 'available') {
        stopped.data.saveError = { code: 'cancelled', message: 'You stopped saving the transcript, so Connect won’t try again by itself.' };
        stopped.revision = crypto.randomUUID();
      }
      return { saved: true };
    },
    job_retry: () => ({ saved: true }),
    notification_permission: () => ({ permission: 'os_managed' }),
    notification_test: () => ({ queued: true }),
    export: () => ({ version: 1, workspaces: [], records: [] }),
    ai_status: () => ({ profiles: clone(ai.profiles), settings: clone(ai.settings) }),
    ai_usage: () => clone(usage),
    // ---- Analytics (contract fixtures from the checks): the CLI's answers as the page's operations return them.
    ...(analytics ? analyticsOps() : {}),
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
      const address = m.data.fromAddress || m.data.fromId;
      // actions.rs `new_recipients`: the Reply-To addresses the thread never showed, lower-case
      // compared with the sender. `window.__replyTo` names the address the next mail prepare uses.
      const replyTo = window.__replyTo;
      const redirected = replyTo && String(replyTo).toLowerCase() !== String(address).toLowerCase();
      const newRecipients = redirected ? [replyTo] : [];
      // actions.rs builds `review.title` from the message's own subject (`Project update` in the
      // contract fixture), not a "Reply to …" line.
      return { actionId: 'action-1', nonce: 'nonce-1', workspaceId: 'personal', account: s.connection.email, review: { title: m.data.title, recipients: [{ emailAddress: { name: m.data.from, address: redirected ? replyTo : address } }], newRecipients, body: d.body } };
    },
    // `window.__confirmHold` keeps the confirm in flight until `window.__finishConfirm()`.
    action_confirm: async d => {
      calls.push(['action_confirm', d]);
      if (window.__confirmHold) await new Promise(resolve => { window.__finishConfirm = resolve; });
      if (window.__replyToChanged) fail('conflict', 'The Outlook message or reply destination changed. Review a new reply.');
      return { state: 'accepted', message: 'Sent for delivery.' };
    },
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
          // "Tell AI what to change": the changed text says so, so checks can tell it from a
          // fresh draft; the job's "revise" never ends up on the stored draft's own options.
          const { revise, ...options } = { ...d };
          const text = revise ? `${revise} (changed: ${d.instructions})` : (result.text || t.data.text);
          const record = { ...t, id: `ai:${key}`, connectionId: s.connection.id, workspaceId: 'personal', source: m.source, revision: crypto.randomUUID(), updatedAt: now(), data: { ...t.data, text, questions: result.questions || t.data.questions, channel: m.data.channel, sourceId: m.id, draftKey: key, conversationKey: key, options, provenance: { ...t.data.provenance, profile, model: job.payload.runModel || job.payload.model || t.data.provenance.model, messageIds: thread.map(x => x.id), partialText: !!result.partialText } } };
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
  // Meetings (Tasks 1, 3, 4): the operations answer as native does (contract fixtures), and the
  // background work they start runs here: a check finds the transcript, a save writes the folder
  // (`folders`, what `meeting_read` answers), a notes job steps through `steps` and writes a
  // document and tasks. `window.__checkPlan` ({found, ms}), `window.__downloadPlan` ({outcome:
  // 'fail'}) and `window.__notesPlan` ({outcome: 'ok'|'fail'|'hold', stepMs}) pick what happens;
  // `window.__finishNotes()` ends a held run. `window.__folderMissing(id)` deletes a folder.
  const folders = folderInit;
  const MEETINGS_ROOT = '/Users/taylor/CodeMie Connect/Meetings';
  const update = () => { s.revision++; emit('workspace:changed'); };
  const meetingRec = id => s.records.find(r => r.kind === 'meeting' && r.id === id);
  const touch = m => { m.revision = crypto.randomUUID(); m.updatedAt = now(); };
  const ensureMeeting = id => {
    let m = meetingRec(id);
    if (m) return m;
    const ev = find('event', id);
    if (!ev) fail('not_found', 'This meeting is no longer in your calendar.');
    const ended = Date.parse(ev.data.end) <= Date.now();
    m = { id, kind: 'meeting', source: ev.source, connectionId: s.connection.id, workspaceId: null, revision: crypto.randomUUID(), updatedAt: now(), data: { eventId: id, title: ev.data.title, start: ev.data.start, end: ev.data.end, state: !ev.data.joinUrl ? 'offline' : ended ? 'pending' : 'upcoming', transcriptIds: [], transcriptStart: null, folder: null, checkedAt: null, error: null, external: null, imported: null, speakers: {}, template: null, auto: null, docs: [], main: null, saveError: null, notesError: null, pendingNotes: null, removedLines: [] } };
    s.records.push(m);
    return m;
  };
  const people = id => { const ev = find('event', id); return ev ? [ev.data.organizer, ...(ev.data.attendees || [])].filter(p => p?.address) : []; };
  const saved = st => ['downloaded', 'ready', 'failed'].includes(st);
  const folderName = m => `${String(m.data.start).slice(0, 10)}_${m.id}`;
  const writeFolder = (m, segments) => {
    const f = folders[m.id] || (folders[m.id] = { folder: `${MEETINGS_ROOT}/${folderName(m)}`, segments: [], files: [], texts: {}, docs: {} });
    f.missing = false;
    if (segments) f.segments = segments;
    f.texts['segments.json'] = JSON.stringify(f.segments, null, 2);
    f.texts['transcript.md'] = `# ${m.data.title}\n\n${f.segments.map(x => `**${x.name}**\n${x.text}`).join('\n\n')}\n`;
    f.texts['meeting.json'] = JSON.stringify({ event_id: m.id, subject: m.data.title }, null, 2);
    if (m.data.imported) f.texts[`imported.${m.data.imported.split('.').pop().toLowerCase()}`] = f.raw || '';
    else f.texts['transcript.vtt'] = `WEBVTT\n\n${f.segments.map(x => `<v ${x.voice}>${x.text}</v>`).join('\n\n')}\n`;
    // The documents' files as they are named now (a new main document takes notes.md).
    for (const name of Object.keys(f.texts)) if (/^notes(\..+)?\.md$/.test(name)) delete f.texts[name];
    for (const doc of m.data.docs) f.texts[doc.file] = f.docs[doc.id] || '';
    f.files = Object.keys(f.texts).sort().map(name => ({ name, size: new TextEncoder().encode(f.texts[name]).length, modified: now() }));
    m.data.folder = f.folder;
    return f;
  };
  const SAMPLE_LINES = [['Welcome, everyone.', 0], ['The release looks good from QA.', 1], ['I’ll send the go/no-go summary today.', 2], ['Then we ship on Thursday.', 0]];
  const sampleSegments = id => {
    const p = people(id);
    return SAMPLE_LINES.map(([text, who], i) => { const x = p[who % Math.max(1, p.length)] || { name: 'Speaker 1', address: null }; return { address: x.address || null, end: i * 30 + 25, name: x.name, speaker: x.address === s.connection.email ? 'me' : 'remote', start: i * 30, text, voice: x.name }; });
  };
  const job = (kind, key, payload) => {
    const j = { id: crypto.randomUUID(), workspaceId: 'personal', connectionId: s.connection.id, kind, key, state: 'queued', dueAt: now(), leaseUntil: null, attempts: 0, policy: {}, payload, result: null };
    s.jobs.unshift(j);
    return j;
  };
  const resolved = m => m.data.template || (s.records.filter(r => r.kind === 'meeting_rule' && r.data.on !== false).find(r => r.data.field === 'title' && m.data.title.toLowerCase().includes(String(r.data.value).toLowerCase()))?.data.template) || s.settings.meetings?.defaultTemplate || 'meeting-notes';
  function startSave(m, auto) {
    const j = job('transcript_download', auto ? `transcript_download:auto:${m.id}:1` : `transcript_download:${crypto.randomUUID()}`, { meetingId: m.id, title: m.data.title, auto });
    setTimeout(() => { if (j.state === 'queued') { j.state = 'running'; update(); } }, 150);
    setTimeout(() => {
      // A stopped save changes nothing (native drops its future).
      if (j.state === 'cancelled') return;
      if (window.__downloadPlan?.outcome === 'fail') {
        window.__downloadPlan = null;
        m.data.saveError = { code: 'provider', message: 'Teams didn’t answer in time.' };
        Object.assign(j, { state: 'failed', result: 'Teams didn’t answer in time.', errorCode: 'provider' });
      } else {
        writeFolder(m, folders[m.id]?.segments?.length ? folders[m.id].segments : sampleSegments(m.id));
        if (!saved(m.data.state)) m.data.state = 'downloaded';
        m.data.saveError = null;
        Object.assign(j, { state: 'succeeded', result: 'Transcript saved' });
        // save.rs: notes asked for while the save failed come first, else the meeting's own.
        const pending = m.data.pendingNotes;
        m.data.pendingNotes = null;
        if (pending) startNotes(m, { templateId: pending.templateId, wishes: pending.wishes, findTasks: pending.findTasks });
        else if (m.data.auto && !m.data.docs.length) startNotes(m, { templateId: resolved(m), wishes: '', findTasks: true, auto: true });
      }
      touch(m);
      update();
    }, 150 + (window.__downloadPlan?.ms || 700));
    return j;
  }
  function startNotes(m, d) {
    const tpl = s.noteTemplates.find(t => t.id === d.templateId);
    const inTeams = m.data.state === 'available';
    const steps = [...(inTeams ? ['Getting the transcript from Teams'] : []), `Writing notes with ${tpl.name}`, ...(d.findTasks !== false && tpl.extractTasks ? ['Finding tasks'] : []), `Saving to ${folderName(m)}`];
    const j = { ...JSON.parse(JSON.stringify(notesJob)), id: crypto.randomUUID(), key: d.auto ? `meeting_notes:auto:${m.id}` : `meeting_notes:${crypto.randomUUID()}`, state: 'queued', dueAt: now(), connectionId: s.connection.id, result: null, payload: { meetingId: m.id, title: m.data.title, templateId: tpl.id, notesKey: `${m.id}:${tpl.id}`, wishes: d.wishes || '', findTasks: d.findTasks !== false, auto: !!d.auto, batch: !!d.batch, step: null, steps } };
    s.jobs.unshift(j);
    const plan = window.__notesPlan || { outcome: 'ok', stepMs: 500 };
    let at = 0;
    const finish = (result = plan) => {
      if (!['queued', 'running'].includes(j.state)) return;
      if (result.outcome === 'fail') {
        m.data.notesError = { code: 'needs_login', message: 'Claude is not signed in.' };
        if (!m.data.docs.length) m.data.state = 'failed';
        Object.assign(j, { state: 'failed', result: 'Claude is not signed in.', errorClass: 'needs_login', errorCode: 'needs_login' });
      } else {
        const f = writeFolder(m);
        const text = `# ${tpl.name}\n\n## Summary\n${m.data.title}: the team agreed the plan [00:00].\n\n## Action items\n- [ ] Send the go/no-go summary [00:01]\n`;
        let doc = m.data.docs.find(x => x.id === tpl.id);
        if (doc) {
          doc.versions = [...doc.versions, { version: doc.version, at: doc.updatedAt, file: `notes-history/${tpl.id}.md`, profile: doc.profile, model: doc.model, auto: doc.auto, edited: doc.edited, wishes: doc.wishes }];
          f.docs[`${doc.id}@${doc.version}`] = f.docs[doc.id];
          Object.assign(doc, { version: doc.version + 1, rev: doc.rev + 1, updatedAt: now(), auto: !!d.auto, edited: false, wishes: d.wishes || null });
        } else {
          doc = { auto: !!d.auto, createdAt: now(), edited: false, file: m.data.docs.length ? `notes.${tpl.id}.md` : 'notes.md', id: tpl.id, model: 'claude-sonnet-4-5', name: tpl.name, profile: 'claude', rev: 1, template: tpl.id, updatedAt: now(), version: 1, versions: [], wishes: d.wishes || null };
          m.data.docs.push(doc);
          if (!m.data.main) m.data.main = doc.id;
        }
        f.docs[doc.id] = text;
        writeFolder(m);
        Object.assign(m.data, { state: 'ready', notesError: null });
        if (d.findTasks !== false && !s.records.some(r => r.kind === 'commitment' && r.data.meetingId === m.id && r.data.line === 2)) {
          const seg = f.segments[Math.min(2, f.segments.length - 1)];
          s.records.push({ id: `task-${m.id}-2`, kind: 'commitment', source: 'local', connectionId: null, workspaceId: 'personal', revision: crypto.randomUUID(), updatedAt: now(), data: { text: 'Send the go/no-go summary', owner: seg?.address || null, ownerName: seg?.name || null, due: null, notes: null, meetingId: m.id, line: 2, quote: seg?.text || null, quoteAt: seg?.start ?? null, speaker: seg?.name || null, confidence: 'high', status: 'review', done: false, order: 500, createdAt: now(), history: [{ at: now(), text: `Found in the notes (${tpl.name})` }] } });
        }
        Object.assign(j, { state: 'succeeded', result: 'Notes ready' });
      }
      touch(m);
      update();
    };
    const step = () => {
      if (!['queued', 'running'].includes(j.state)) return;
      j.state = 'running';
      j.payload.step = steps[at];
      if (steps[at] === 'Getting the transcript from Teams') {
        writeFolder(m, folders[m.id]?.segments?.length ? folders[m.id].segments : sampleSegments(m.id));
        m.data.state = 'downloaded';
        touch(m);
      }
      update();
      at++;
      if (at < steps.length) setTimeout(step, plan.stepMs || 500);
      else if (plan.outcome !== 'hold') setTimeout(() => finish(plan), plan.stepMs || 500);
    };
    window.__finishNotes = finish;
    setTimeout(step, 150);
    return j;
  }
  window.__folderMissing = id => { if (folders[id]) folders[id].missing = true; };
  // Another window (or a run) changes a document while the person edits it.
  window.__docChanged = (id, docId) => {
    const m = meetingRec(id);
    const doc = m.data.docs.find(x => x.id === docId);
    folders[id].docs[docId] = `${folders[id].docs[docId]}\n\nAdded in another window.`;
    doc.rev += 1;
    touch(m);
    update();
  };
  const readable = id => {
    const m = meetingRec(id);
    if (!m || !m.data.folder) fail('not_found', 'This meeting has no transcript yet.');
    if (folders[id]?.missing) fail('folder_missing', 'The meeting folder was moved or deleted. Download the transcript again.');
    return [m, folders[id]];
  };
  const parseVtt = (text, id) => {
    const p = people(id);
    const out = [];
    for (const [, voice, said] of String(text).matchAll(/<v\s+([^>]+)>([\s\S]*?)(?:<\/v>|\n\n|$)/g)) {
      const who = p.find(x => x.name.toLowerCase() === voice.trim().toLowerCase());
      out.push({ address: who?.address || null, end: out.length * 20 + 15, name: who?.name || voice.trim(), speaker: who?.address === s.connection.email ? 'me' : 'remote', start: out.length * 20, text: said.replace(/<[^>]+>/g, '').trim(), voice: voice.trim() });
    }
    return out;
  };
  Object.assign(ops, {
    meeting_check: d => {
      calls.push(['meeting_check', d]);
      const m = ensureMeeting(d.meetingId);
      if (saved(m.data.state) || m.data.state === 'available') fail('validation', 'Connect already has this meeting’s transcript.');
      const busy = s.jobs.find(j => j.kind === 'transcript_check' && j.payload.meetingId === m.id && ['queued', 'running'].includes(j.state));
      if (busy) return { queued: true, jobId: busy.id };
      const plan = window.__checkPlan || { found: true, ms: 700 };
      const j = job('transcript_check', `transcript_check:${crypto.randomUUID()}`, { meetingId: m.id, title: m.data.title, auto: false });
      setTimeout(() => { j.state = 'running'; update(); }, 150);
      setTimeout(() => {
        m.data.checkedAt = now();
        if (plan.found) {
          Object.assign(m.data, { state: 'available', transcriptIds: ['t-1'], external: `ONLINE-${m.id}`, transcriptStart: m.data.start, error: null });
          Object.assign(j, { state: 'succeeded', result: 'Transcript found' });
          startSave(m, true);
        } else Object.assign(j, { state: 'succeeded', result: 'No transcript yet' });
        touch(m);
        update();
      }, 150 + plan.ms);
      return { queued: true, jobId: j.id };
    },
    meeting_download: d => {
      calls.push(['meeting_download', d]);
      const m = meetingRec(d.meetingId);
      if (!m?.data.transcriptIds?.length || !m.data.external) fail('transcript_missing', 'Teams has no transcript of this meeting for Connect to save. Check again later.');
      const busy = s.jobs.find(j => j.kind === 'transcript_download' && j.payload.meetingId === m.id && ['queued', 'running'].includes(j.state));
      return { queued: true, jobId: (busy || startSave(m, false)).id };
    },
    meeting_import: d => {
      calls.push(['meeting_import', { meetingId: d.meetingId, fileName: d.fileName }]);
      if (!/\.(vtt|txt)$/i.test(d.fileName || '')) fail('validation', 'Import a Teams .vtt or a .txt transcript.');
      const m = ensureMeeting(d.meetingId);
      const segments = parseVtt(d.text, m.id);
      if (!segments.length) fail('validation', 'Connect found no one speaking in this file. Use a Teams .vtt, or lines like “Name: what they said”.');
      Object.assign(m.data, { imported: d.fileName.split(/[\\/]/).pop(), transcriptStart: null, state: m.data.docs.length ? 'ready' : 'downloaded', error: null, saveError: null, pendingNotes: null });
      (folders[m.id] ||= { folder: `${MEETINGS_ROOT}/${folderName(m)}`, segments: [], files: [], texts: {}, docs: {} }).raw = d.text;
      writeFolder(m, segments);
      touch(m);
      return { saved: true };
    },
    meeting_speakers: d => {
      calls.push(['meeting_speakers', d]);
      const [m, f] = readable(d.meetingId);
      const who = people(m.id).find(p => p.address.toLowerCase() === String(d.address).toLowerCase());
      if (d.address && !who) fail('validation', 'Choose someone who was at the meeting.');
      if (d.address) m.data.speakers[d.voice] = who.address; else delete m.data.speakers[d.voice];
      writeFolder(m, f.segments.map(x => (x.voice === d.voice ? { ...x, address: who?.address || null, name: who?.name || x.voice } : x)));
      touch(m);
      return { saved: true };
    },
    meetings_reveal: d => {
      calls.push(['meetings_reveal', d]);
      if (d.meetingId && folders[d.meetingId]?.missing) fail('folder_missing', 'The meeting folder was moved or deleted. Download the transcript again.');
      return { opened: true };
    },
    meeting_read: d => {
      if (!['transcript', 'files', 'file', 'doc'].includes(d.part)) fail('validation', 'Choose the transcript, the files, one file or a document.');
      const [, f] = readable(d.meetingId);
      calls.push(['meeting_read', { meetingId: d.meetingId, part: d.part, name: d.name, docId: d.docId, version: d.version }]);
      if (d.part === 'transcript') return { segments: f.segments };
      if (d.part === 'files') return { files: f.files };
      if (d.part === 'file') return f.texts[d.name] !== undefined ? { text: f.texts[d.name] } : fail('not_found', 'That file isn’t in the meeting folder.');
      const text = f.docs[d.version ? `${d.docId}@${d.version}` : d.docId];
      return text !== undefined ? { text } : fail('not_found', 'This document is no longer there.');
    },
  });
  // Notes (Task 3): the operations answer as native does; nothing runs Claude or writes a folder.
  // Templates, rules and texts are recorded so later checks can read what the UI sent.
  Object.assign(ops, {
    meeting_notes: d => {
      calls.push(['meeting_notes', clone(d)]);
      const m = ensureMeeting(d.meetingId);
      if (!saved(m.data.state) && !(m.data.state === 'available' && m.data.transcriptIds?.length)) fail('not_found', 'This meeting has no transcript yet.');
      if (saved(m.data.state) && folders[m.id]?.missing) fail('folder_missing', 'The meeting folder was moved or deleted. Download the transcript again.');
      const tpl = s.noteTemplates.find(t => t.id === d.templateId);
      if (!tpl) fail('validation', 'Choose a note template.');
      const profile = ai.settings.routes?.meeting?.profile || ai.settings.defaultProfile;
      if (!profile) fail('needs_choice', 'Choose which Claude should write for you.', 'needs_choice');
      const busy = s.jobs.find(j => j.kind === 'meeting_notes' && j.payload.notesKey === `${m.id}:${tpl.id}` && ['queued', 'running'].includes(j.state));
      if (busy) return { queued: true, jobId: busy.id };
      if (d.remember) {
        s.records.push({ id: `${crypto.randomUUID()}-rule`, kind: 'meeting_rule', source: 'local', connectionId: null, workspaceId: 'personal', revision: crypto.randomUUID(), updatedAt: now(), data: { field: 'title', value: m.data.title, template: tpl.id, autoNotes: false, on: true, order: -1 } });
        m.data.template = null;
      }
      return { queued: true, jobId: startNotes(m, { templateId: tpl.id, wishes: d.wishes, findTasks: d.findTasks, batch: d.batch }).id };
    },
    meeting_set: d => {
      calls.push(['meeting_set', clone(d)]);
      const m = ensureMeeting(d.meetingId);
      if ('template' in d) {
        if (d.template !== null && !s.noteTemplates.some(t => t.id === d.template)) fail('validation', 'Choose a note template.');
        m.data.template = d.template;
      }
      if ('auto' in d) m.data.auto = d.auto;
      touch(m);
      return { saved: true };
    },
    meeting_doc: d => {
      calls.push(['meeting_doc', clone(d)]);
      const [m, f] = readable(d.meetingId);
      const doc = m.data.docs.find(x => x.id === d.docId);
      if (!doc) fail('not_found', 'This document is no longer there.');
      // docs.rs `Base::check`: edit, delete and version name the version the person saw.
      const stale = message => { if (d.baseVersion !== doc.version || d.baseRev !== doc.rev) fail('conflict', message); };
      if (d.action === 'edit') {
        stale('This document changed while you were editing it. Copy your text, then open the document again.');
        f.docs[doc.id] = d.text;
        Object.assign(doc, { rev: doc.rev + 1, edited: true, updatedAt: now() });
      } else if (d.action === 'main') {
        const old = m.data.docs.find(x => x.id === m.data.main);
        if (old && old !== doc) old.file = `notes.${old.id}.md`;
        doc.file = 'notes.md';
        m.data.main = doc.id;
      } else if (d.action === 'delete') {
        stale('A new version of this document was just made, so it wasn’t deleted. Look at it, then delete it if you still want to.');
        m.data.docs = m.data.docs.filter(x => x !== doc);
        if (m.data.main === doc.id) { m.data.main = m.data.docs[0]?.id || null; if (m.data.docs[0]) m.data.docs[0].file = 'notes.md'; }
        if (!m.data.docs.length) m.data.state = 'downloaded';
      } else if (d.action === 'version') {
        if (!Number.isInteger(d.version)) fail('validation', 'Choose a version.');
        stale('This document changed since you chose that version, so nothing was replaced. Look at it again, then choose.');
        if (d.version === doc.version) return { saved: true };
        const kept = doc.versions.find(v => v.version === d.version);
        if (!kept) fail('not_found', 'That version of the document wasn’t kept.');
        const text = f.docs[`${doc.id}@${d.version}`];
        f.docs[`${doc.id}@${doc.version}`] = f.docs[doc.id];
        f.docs[doc.id] = text;
        doc.versions = doc.versions.filter(v => v !== kept).concat({ version: doc.version, at: doc.updatedAt, file: null, profile: doc.profile, model: doc.model, auto: doc.auto, edited: doc.edited, wishes: doc.wishes }).sort((a, b) => a.version - b.version);
        Object.assign(doc, { version: kept.version, rev: doc.rev + 1, updatedAt: kept.at });
      } else fail('validation', 'Choose what to do with the document.');
      writeFolder(m);
      touch(m);
      return d.action === 'delete' ? { deleted: true } : { saved: true };
    },
    // Settings › Meetings (library_ops.rs): templates over the built-ins as native merges them
    // (an override says `edited`, deleting it is Reset to built-in), rules with their order, and
    // the glossary and tag list (linked files are only read). Refusals carry `field`.
    template_save: d => {
      calls.push(['template_save', clone(d)]);
      const has = k => Object.prototype.hasOwnProperty.call(d, k);
      if (has('id') && d.id !== null && !/^[A-Za-z0-9._:-]{1,100}$/.test(String(d.id))) refuse('id', 'Choose a template.');
      const id = d.id || crypto.randomUUID();
      const stored = s.noteTemplates.find(t => t.id === id);
      const kind = stored?.kind || d.kind || 'custom';
      if (!stored && !['custom', 'skill'].includes(kind)) refuse('kind', 'Choose your own template or a skill.');
      const t = stored ? clone(stored) : { id, kind, name: '', blurb: '', prompt: '', sections: [], extractTasks: true, color: kind === 'skill' ? '#7B3FBF' : '#2297F6', icon: kind === 'skill' ? 'shield' : 'note', skillPath: null, edited: false };
      const text = (k, max, message) => {
        if (!has(k)) return undefined;
        const v = d[k] === null ? '' : d[k];
        if (typeof v !== 'string' || [...v.trim()].length > max) refuse(k, message);
        return v.trim();
      };
      const name = text('name', 80, 'Name the template (up to 80 characters).');
      if (name !== undefined) t.name = name;
      if (!t.name) refuse('name', 'Name the template (up to 80 characters).');
      const blurb = text('blurb', 300, 'Keep the description to 300 characters.');
      if (blurb !== undefined) t.blurb = blurb;
      const prompt = text('prompt', 50000, 'Keep the instructions to 50,000 characters.');
      if (prompt !== undefined) t.prompt = prompt;
      if (has('sections')) {
        if (!Array.isArray(d.sections) || d.sections.length > 20 || d.sections.some(x => !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(x))) refuse('sections', 'Choose the template’s sections.');
        t.sections = [...new Set(d.sections)];
      }
      if (has('extractTasks')) t.extractTasks = !!d.extractTasks;
      const color = text('color', 7, 'Choose a colour.');
      if (color !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(color)) refuse('color', 'Choose a colour.'); t.color = color; }
      const icon = text('icon', 30, 'Choose an icon.');
      if (icon !== undefined) t.icon = icon;
      if (kind === 'skill') {
        const path = text('skillPath', 1024, 'Choose the skill’s SKILL.md by its full path.');
        if (path !== undefined) {
          const known = (window.__skills || []).some(x => x.path === path) || path === t.skillPath || window.__files?.[path] !== undefined;
          if (!path.startsWith('/') || !/\.md$/i.test(path) || !known) refuse('skillPath', 'Choose the skill’s SKILL.md by its full path.');
          t.skillPath = path;
        }
        if (!t.skillPath) refuse('skillPath', 'Choose the skill’s SKILL.md by its full path.');
      } else if (!t.prompt) refuse('prompt', 'Write the template’s instructions.');
      if (t.kind === 'builtin') t.edited = true;
      s.noteTemplates = stored ? s.noteTemplates.map(x => (x.id === id ? t : x)) : [...s.noteTemplates, t];
      return { id };
    },
    template_delete: d => {
      calls.push(['template_delete', clone(d)]);
      const original = BUILT_INS.find(t => t.id === d.id);
      if (original) { s.noteTemplates = s.noteTemplates.map(t => (t.id === d.id ? clone(original) : t)); return { reset: true, id: d.id }; }
      if (!s.noteTemplates.some(t => t.id === d.id)) fail('not_found', 'This template is no longer there.');
      if (s.settings.meetings.defaultTemplate === d.id) s.settings.meetings.defaultTemplate = 'meeting-notes';
      // model.rs / library_ops.rs: deleting a template unpins it from the meeting view's summary tabs.
      if ((s.settings.meetings.summaryTabs || []).includes(d.id)) s.settings.meetings.summaryTabs = s.settings.meetings.summaryTabs.filter(t => t !== d.id);
      for (const r of s.records) if (r.kind === 'meeting_rule' && r.data.template === d.id) r.data.template = s.settings.meetings.defaultTemplate;
      s.noteTemplates = s.noteTemplates.filter(t => t.id !== d.id);
      return { deleted: true, id: d.id };
    },
    meeting_rule_save: d => {
      calls.push(['meeting_rule_save', clone(d)]);
      const has = k => Object.prototype.hasOwnProperty.call(d, k);
      const id = d.id || crypto.randomUUID();
      const rules = s.records.filter(r => r.kind === 'meeting_rule');
      const stored = rules.find(r => r.id === id);
      const rule = stored ? clone(stored.data) : { field: 'title', value: '', template: '', autoNotes: false, on: true, order: Math.max(-1, ...rules.map(r => r.data.order + 1 || 0)) };
      if (!stored && !has('order')) rule.order = rules.length ? Math.max(...rules.map(r => Number(r.data.order) || 0)) + 1 : 0;
      if (has('field')) { if (!['title', 'organizer', 'org', 'people'].includes(d.field)) refuse('field', 'Choose what the rule looks at.'); rule.field = d.field; }
      if (has('value')) { const v = String(d.value ?? '').trim(); if ([...v].length > 200) refuse('value', 'Keep the rule’s text to 200 characters.'); rule.value = v; }
      if (has('template')) rule.template = String(d.template ?? '').trim();
      if ((!stored || has('template')) && !s.noteTemplates.some(t => t.id === rule.template)) refuse('template', 'Choose a note template.');
      if (has('autoNotes')) rule.autoNotes = !!d.autoNotes;
      if (has('on')) rule.on = !!d.on;
      if (has('order')) rule.order = Number(d.order);
      s.records = s.records.filter(r => !(r.kind === 'meeting_rule' && r.id === id)).concat({ id, kind: 'meeting_rule', source: 'local', connectionId: null, workspaceId: 'personal', revision: crypto.randomUUID(), updatedAt: now(), data: rule });
      return { id };
    },
    meeting_rule_delete: d => {
      calls.push(['meeting_rule_delete', clone(d)]);
      const rec = s.records.find(r => r.kind === 'meeting_rule' && r.id === d.id);
      if (!rec) fail('not_found', 'This rule is no longer there.');
      s.records = s.records.filter(r => r !== rec);
      return { deleted: true, id: d.id, body: rec.data };
    },
    meeting_rule_order: d => {
      calls.push(['meeting_rule_order', clone(d)]);
      const rules = s.records.filter(r => r.kind === 'meeting_rule');
      if (!Array.isArray(d.ids) || d.ids.some(id => !rules.some(r => r.id === id))) fail('not_found', 'A rule is no longer there.');
      const rank = r => { const i = d.ids.indexOf(r.id); return i < 0 ? d.ids.length : i; };
      rules.sort((a, b) => a.data.order - b.data.order || (a.id < b.id ? -1 : 1)).sort((a, b) => rank(a) - rank(b)).forEach((r, i) => { r.data.order = i; });
      return { saved: true };
    },
    meeting_text_save: d => {
      calls.push(['meeting_text_save', clone(d)]);
      if (!['glossary', 'tags'].includes(d.name)) refuse('name', 'Choose the glossary or the tag list.');
      if (typeof d.text !== 'string') refuse('text', 'Write the text.');
      if (new TextEncoder().encode(d.text).length > 100 * 1024) fail('too_large', 'Keep the glossary and the tag list to 100 KB each.');
      if (s.settings.meetings.glossarySource === 'file') refuse('name', 'This is a file you keep elsewhere. Edit it there, or keep the glossary and tags here in Connect.');
      // library_ops.rs: never over a file Connect could not read whole.
      textRead(d.name);
      if (window.__textRead?.[d.name] === 'cut') fail('too_large', `${d.name}.md is longer than 100 KB, so Connect shows it read-only and won’t change it. Shorten it in your editor, then read it again.`);
      texts[d.name] = d.text;
      return { saved: true, path: `${s.meetingsRoot.path}/${d.name}.md` };
    },
    meeting_text: d => {
      const m = s.settings.meetings;
      if (m.glossarySource === 'file') {
        const path = d.name === 'glossary' ? m.glossaryFile : m.tagsFile;
        return { text: (path && window.__files?.[path]) || '', path: path || null, linked: true, cut: false };
      }
      textRead(d.name);
      const cut = window.__textRead?.[d.name] === 'cut';
      const text = cut ? `- \`meeting\` — every meeting note\n${'- `pilot` — pilots and rollouts\n'.repeat(4)}` : texts[d.name] ?? '';
      return { text, path: `${s.meetingsRoot.path}/${d.name}.md`, linked: false, cut };
    },
    meeting_skills: () => clone(window.__skills || []),
  });
  // Tasks: `task_save` merges into the stored body and writes history lines as native does
  // (src-tauri/src/workspace/tasks.rs); `task_delete` answers with the body (task-delete.json).
  const TASK_NAMES = { review: 'To review', todo: 'To do', doing: 'In progress', waiting: 'Waiting', done: 'Done', dismissed: 'Dismissed' };
  const taskStatus = b => (TASK_NAMES[b.status] ? b.status : b.done ? 'done' : 'todo');
  Object.assign(ops, {
    task_save: (d, wid) => {
      calls.push(['task_save', clone(d)]);
      const at = now();
      const { id: given, log, history, ...fields } = d;
      const id = given || crypto.randomUUID();
      const stored = s.records.find(r => r.kind === 'commitment' && r.id === id);
      if ('text' in fields || !stored) {
        const text = String(fields.text ?? '').trim();
        if (!text || text.length > 2000) fail('validation', 'Write what needs doing (up to 2,000 characters).');
        fields.text = text;
      }
      if (!stored) {
        const orders = s.records.filter(r => r.kind === 'commitment').map(r => r.data.order ?? r.updatedAt);
        const status = fields.status || (fields.done ? 'done' : 'todo');
        s.records.push({ id, kind: 'commitment', source: 'local', connectionId: null, workspaceId: wid || 'personal', revision: crypto.randomUUID(), updatedAt: at,
          data: { ...fields, status, done: status === 'done', doneAt: status === 'done' ? fields.doneAt || at : null, createdAt: fields.createdAt || at, order: fields.order ?? Math.max(at, ...orders) + 1, history: history?.length ? history : [{ at, text: log || 'Added by you' }] } });
        return { id };
      }
      const before = stored.data;
      const body = { ...before, ...fields };
      const from = taskStatus(before);
      const to = fields.status || ('done' in fields ? (fields.done ? 'done' : from === 'done' ? 'todo' : from) : from);
      Object.assign(body, { status: to, done: to === 'done', doneAt: to === 'done' ? (from === 'done' ? before.doneAt : at) : null });
      const lines = [];
      if (to !== from) lines.push(log || `Moved from ${TASK_NAMES[from]} to ${TASK_NAMES[to]}`);
      if ('owner' in fields && (fields.owner || null) !== (before.owner || null)) {
        if (!('ownerName' in fields)) body.ownerName = null;
        if (before.confidence === 'low' && !('confidence' in fields)) body.confidence = 'high';
        lines.push(body.owner ? `Owner set to ${body.ownerName || body.owner}` : 'Owner removed');
      }
      if ('due' in fields && (fields.due || null) !== (before.due || null)) lines.push(body.due ? `Due date set to ${body.due}` : 'Due date removed');
      if (log && to === from) lines.push(log);
      body.history = [...(before.history || []), ...lines.map(text => ({ at, text }))];
      Object.assign(stored, { data: body, revision: crypto.randomUUID(), updatedAt: at });
      return { id };
    },
    task_delete: d => {
      calls.push(['task_delete', clone(d)]);
      const stored = s.records.find(r => r.kind === 'commitment' && r.id === d.id);
      if (!stored) fail('not_found', 'This task is no longer there.');
      s.records = s.records.filter(r => r !== stored);
      return { deleted: true, id: d.id, body: clone(stored.data) };
    },
  });
  // Task providers (task_provider/ops.rs): the snapshot keeps `taskProvider` (Local's shape from
  // task-provider-states.json unless a check sets another); the ops answer in native's shapes,
  // with its refusals (`field`). The mock has no outbox: nothing is ever sent anywhere.
  s.taskProvider ||= { active: 'local', name: 'Connect', available: [{ id: 'local', name: 'Connect' }], state: 'local', pending: 0, parked: 0, lastSync: null, retryAt: null, message: null, copyOffered: false };
  s.settings.tasks ||= { provider: 'local', copyOffered: [] };
  const providerOf = b => b.provider || 'local';
  const taskRecord = (id, wid) => s.records.find(r => r.kind === 'commitment' && r.id === id && (!wid || (r.workspaceId || 'personal') === wid));
  const OPEN = ['todo', 'doing', 'waiting'];
  Object.assign(ops, {
    task_sync_now: () => { calls.push(['task_sync_now', {}]); return { queued: s.taskProvider.active !== 'local' }; },
    task_provider_set: d => {
      calls.push(['task_provider_set', clone(d)]);
      const tp = s.taskProvider;
      const listed = tp.available.find(p => p.id === d.provider);
      if (!listed) refuse('provider', 'Choose Connect or an installed task plugin.');
      if (d.provider !== 'local' && listed.on === false) refuse('provider', `Turn ${listed.name} on in Settings › Plugins first.`);
      const offered = s.settings.tasks.copyOffered;
      if (d.provider !== 'local' && !offered.includes(d.provider)) offered.push(d.provider);
      s.settings.tasks.provider = d.provider;
      Object.assign(tp, { active: d.provider, name: listed.name, copyOffered: offered.includes(d.provider), state: d.provider === 'local' ? 'local' : 'ready' });
      // To review tasks follow the provider; nothing is deleted or closed.
      for (const r of s.records.filter(r => r.kind === 'commitment' && taskStatus(r.data) === 'review')) {
        if (d.provider === 'local') delete r.data.provider; else r.data.provider = d.provider;
      }
      let copied = 0;
      if (d.copy && d.provider !== 'local') {
        const held = new Set(s.records.filter(r => r.kind === 'commitment' && providerOf(r.data) === d.provider).map(r => r.data.key));
        for (const r of s.records.filter(r => r.kind === 'commitment' && providerOf(r.data) === 'local' && OPEN.includes(taskStatus(r.data)))) {
          if (r.data.key && held.has(r.data.key)) continue;
          held.add(r.data.key);
          s.records.push({ ...clone(r), id: crypto.randomUUID(), revision: crypto.randomUUID(), updatedAt: now(),
            data: { ...clone(r.data), provider: d.provider, copiedFrom: r.id, pending: true, history: [...(r.data.history || []), { at: now(), text: 'Copied from Connect' }] } });
          copied++;
        }
      }
      return { provider: d.provider, copied };
    },
    task_withdraw: (d, wid) => {
      calls.push(['task_withdraw', clone(d)]);
      if (!Array.isArray(d.ids)) refuse('ids', 'Choose the tasks.');
      if (d.ids.length > 200) refuse('ids', 'Choose up to 200 tasks.');
      let done = 0, failed = 0;
      for (const id of d.ids) {
        const stored = taskRecord(id, wid);
        if (!stored) { failed++; continue; }
        if (taskStatus(stored.data) !== 'review') {
          Object.assign(stored.data, { status: 'review', done: false, doneAt: null, history: [...(stored.data.history || []), { at: now(), text: 'Moved back to review' }] });
          if (stored.data.provider) Object.assign(stored.data, { remote: null, pending: false });
        }
        done++;
      }
      return { done, failed };
    },
    task_bulk: (d, wid) => {
      calls.push(['task_bulk', clone(d)]);
      if (!Array.isArray(d.items) || d.items.length > 200) refuse('items', 'Choose up to 200 tasks.');
      if (d.items.some(i => 'status' in i && !['todo', 'doing', 'waiting', 'done'].includes(i.status))) refuse('items', 'Move tasks to To do, In progress, Waiting or Done.');
      let done = 0, failed = 0;
      const before = [];
      for (const item of d.items) {
        const stored = taskRecord(item.id, wid);
        if (!stored) { failed++; continue; }
        const was = { id: item.id, due: stored.data.due ?? null, status: taskStatus(stored.data) };
        const change = { id: item.id };
        if ('due' in item) change.due = item.due;
        if ('status' in item) change.status = item.status;
        ops.task_save(change, wid);
        before.push(was);
        done++;
      }
      return { done, failed, before };
    },
    task_handled: (d, wid) => {
      calls.push(['task_handled', clone(d)]);
      const stored = taskRecord(d.id, wid);
      if (!stored) fail('not_found', 'This task is no longer there.');
      const kept = stored.data.keptEvidence || [];
      if (d.evidence !== undefined && d.evidence !== null) {
        const evidence = String(d.evidence).trim();
        if (!evidence || evidence.length > 500) refuse('evidence', 'Say what shows the task is handled.');
        // The mock keeps evidence as given; native keeps sha1(evidence)[..16].
        if (OPEN.includes(taskStatus(stored.data)) && !kept.includes(evidence)) stored.data.handled = { evidence, at: now(), auto: false };
      } else if (d.action === 'done') {
        ops.task_save({ id: d.id, status: 'done' }, wid);
        stored.data.handled = null;
      } else if (d.action === 'keep') {
        if (stored.data.handled) stored.data.keptEvidence = [...new Set([...kept, stored.data.handled.evidence])];
        stored.data.handled = null;
      } else refuse('action', 'Choose Done or Keep open.');
      return { id: d.id };
    },
    task_parked: (d, wid) => {
      calls.push(['task_parked', clone(d)]);
      if (!['retry', 'discard'].includes(d.action)) refuse('action', 'Choose Try again or Discard change.');
      const stored = taskRecord(d.id, wid);
      if (stored) {
        stored.data.syncError = null;
        if (d.action === 'discard') stored.data.pending = false;
      }
      return { id: d.id };
    },
  });
  // Plugins (`plugins_request`, `plugin_call`): an in-memory registry over the contract answers.
  // `__pluginCalls` records what reached native, with the plugin id it went out with.
  const pl = {
    markets: clone(pluginInit.markets), installed: [], storage: {}, addresses: {}, signedIn: {},
    calls: [], loadErrors: {}, opened: [], settings: {},
  };
  window.__pluginCalls = pl.calls;
  // Links the user agreed to open (`open_link`): recorded, never opened in a browser.
  window.__pluginOpened = pl.opened;
  // Why a plugin's host half didn't load, as the manager would say (`installed` answers it).
  window.__setPluginLoadError = (id, text) => { pl.loadErrors[id] = text; };
  const isAddress = x => (pluginInit.hello.manifest.uses?.network?.hosts_from || []).includes(x.key);
  const helloView = () => {
    const m = pluginInit.hello.manifest;
    const p = pl.installed.find(x => x.id === 'hello');
    return {
      id: m.id, name: m.name, version: m.version, summary: m.summary, market: p.market, source: p.source, commit: null,
      hash: '5eed5eed', enabled: p.enabled, agreed: p.agreed, installedAt: '2026-11-17T09:30:00Z', update: null, problem: null,
      client: m.client, widgets: m.widgets.map(w => ({ id: w.id, label: w.label, about: w.about || '', kind: w.kind, sizes: w.sizes || [] })),
      signin: [{ host: 'github.com', signedIn: !!pl.signedIn.hello, from: pl.signedIn.hello ? 'gh' : null }],
      addresses: m.settings.filter(isAddress).map(x => ({ key: x.key, label: x.label, help: x.help || null, value: pl.addresses[x.key] || '' })),
      // Every other declared setting (`set_setting`); a secret says only whether it is set.
      settings: m.settings.filter(x => !isAddress(x)).map(x => (x.type === 'secret'
        ? { key: x.key, label: x.label, type: 'secret', help: x.help || null, set: !!pl.settings[x.key] }
        : { key: x.key, label: x.label, type: x.type || 'string', help: x.help || null, value: pl.settings[x.key] ?? x.default ?? null })),
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
    set_setting: d => {
      const def = pluginInit.hello.manifest.settings.find(x => x.key === d.key);
      if (!def) fail('invalid', `${d.id} has no setting “${d.key}” in its manifest`);
      if (isAddress(def)) fail('invalid', `“${d.key}” lists the addresses ${d.id} may reach: set it under its addresses`);
      if (d.value === '' || d.value === null || d.value === undefined) delete pl.settings[d.key];
      else pl.settings[d.key] = def.type === 'secret' ? true : d.value; // a secret is never kept, as in Connect
      return helloView();
    },
    open_link: d => {
      if (!/^(https|obsidian):/.test(d.url)) fail('validation', 'Connect opens only https:// and obsidian:// links.');
      pl.opened.push(clone(d));
      return { opened: true };
    },
    client_storage: d => {
      if (d.items) pl.storage[d.id] = clone(d.items);
      return { items: clone(pl.storage[d.id] || {}) };
    },
  };
  // A native event, as when the user clicks a notification.
  window.__emitNative = (name, payload) => (listeners[name] || []).forEach(fn => fn({ payload }));
  // A background refresh, as the loop or a sync sends one (nothing in the snapshot changes).
  window.__refresh = () => { s.revision++; emit('workspace:changed'); };
  // A sync changes an event (e.g. Graph names its series): the window reads the new snapshot.
  window.__eventData = (id, data) => { const ev = s.records.find(r => r.kind === 'event' && r.id === id); Object.assign(ev.data, data); s.revision++; emit('workspace:changed'); };
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
        const codemieResult = await codemieNative(cmd, args);
        if (codemieResult !== NOT_CODEMIE) return codemieResult;
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
        // Settings › Meetings › Change…: `__meetingsPick` is the folder chosen (null cancels).
        if (cmd === 'meetings_root_pick') { calls.push(['meetings_root_pick']); return window.__meetingsPick ?? null; }
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
        if (r.op !== 'snapshot' && !['ai_status', 'ai_usage', 'ai_test', 'analytics_status', 'analytics_view', 'analytics_session', 'analytics_app', 'analytics_report', 'analytics_refresh', 'analytics_retry', 'automation_runs', 'meeting_read', 'meeting_text', 'meeting_skills', 'meetings_reveal', 'task_sync_now'].includes(r.op)) { s.revision++; emit('workspace:changed'); }
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

/** Waits until the page stops re-rendering: no element added or removed for 150 ms, for at most
 *  `limit` ms. Boot and a route change render more than once (the snapshot, then what the page
 *  reads, such as Settings' data location), so a check that grabs an element at once can hold one
 *  the next render replaces. Unlike `renderSettled` it never fails (a live clock keeps changing). */
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

/** [renderSettled] as the meetings checks wait for it (4 s). */
const settled = (page, limit = 4000) => renderSettled(page, limit);
const quiet = (page, limit = 2000) => page.evaluate(limit => new Promise(resolve => {
  let timer;
  const done = () => { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(); };
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 150); });
  const cap = setTimeout(done, limit);
  observer.observe(document.body, { childList: true, subtree: true });
  timer = setTimeout(done, 150);
}), limit).catch(() => {});

async function open({ theme = 'dark', width = 1440, height = 900, start = 'connected', hash = '#/today', ai = 'both', aiDefault, enable = [], longThread = false, storage = storageOf('ready', { dataRoot: DEFAULT_ROOT, custom: false }), unavailable = false, location = 'default', automations = false, tasks = false, meetings = false, transcriptsOff = false, pluginRecords = null, codemie = 'ready', localPrefs = null, workspace = null, analytics = null, settings = null, now: fixedNow = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  const now = fixedNow ?? Date.now();
  const connected = buildSnapshot(now, { theme, zone: 'Europe/Kyiv' });
  connected.connection.enabled.push(...enable);
  if (longThread) {
    // Priya's roadmap thread grows from two messages to five.
    const first = connected.records.find(r => r.id === 'm-reply-1');
    ['Thanks. Could you also send Jordan the draft?', 'Also, please book the review room for Thursday.', 'One more thing: the comments are due Friday 20 November.'].forEach((text, i) => connected.records.push({ ...first, id: `m-long-${i}`, revision: `r-long-${i}`, data: { ...first.data, text, at: first.data.at + 120 * (i + 1), lane: 'fyi', isRead: true } }));
  }
  if (automations) withAutomations(connected, now);
  if (tasks) withTasks(connected, now);
  if (meetings) withMeetings(connected, now);
  if (transcriptsOff) {
    connected.connection.enabled = connected.connection.enabled.filter(c => c !== 'meetings' && c !== 'transcripts');
    connected.connection.scopes = connected.connection.scopes.filter(x => !/^OnlineMeeting/.test(x));
  }
  if (pluginRecords) connected.records.push(...pluginRecords(now));
  if (workspace) Object.assign(connected.workspaces.find(w => w.id === connected.settings.activeWorkspace), workspace);
  const snapshot = start === 'connected' ? connected : buildSnapshot(now, { connected: false, theme, zone: 'Europe/Kyiv' });
  if (settings) Object.assign(snapshot.settings, settings);
  const { testOk, testFail, draft, draftChat, jobFailed, summary } = contractFixtures();
  const checks = Object.fromEntries(CHECKS.map(name => [name, folderCheck(name)]));
  await page.addInitScript(`(${installBridge})(${JSON.stringify({ snapshot, connected, ai: aiStatus(ai, aiDefault === undefined ? {} : { defaultProfile: aiDefault }), usage: aiUsage(), testOk, testFail, draft, draftChat, jobFailed, summary, storage, unavailable, location: dataLocation(location), checks, automation: automationContract(), plugins: pluginContract(), codemie, frameBase: `${base.replace(/index\.html$/, '')}plugin-frames/`, folders: meetings ? meetingFolders(now) : {}, notesJob: meetingContract().job, glossaryText: '## Products\n- **CodeMie** — heard as “code me”\n', analytics, navIds: NAV.map(([id]) => id) })})`);
  // Preferences Connect keeps in the window's localStorage (e.g. CodeMie setup already introduced).
  if (localPrefs) await page.addInitScript(prefs => { if (window.top === window) for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v); }, localPrefs);
  if (fixedNow != null) await context.clock.setFixedTime(fixedNow);
  await page.goto(base + hash);
  await page.waitForSelector(unavailable ? '.ws-recovery' : '.ws-sidebar');
  await quiet(page);
  currentPage = page;
  return { page, context, errors };
}
const shot = async (page, name) => {
  await page.evaluate(() => document.querySelectorAll('.ws-toast').forEach(t => t.remove()));
  return page.screenshot({ path: join(OUT, `${name}.png`) });
};
const text = (page, selector) => page.locator(selector).first().innerText();
/** What the mock recorded for native operation `op` (e.g. `layout_save`), oldest first. */
const bridgeCalls = async (page, op) => (await page.evaluate(() => window.__bridgeCalls)).filter(([o]) => o === op).map(([, d]) => d);

// `WORKSPACE_E2E_ONLY=plugins` (or `meetings`, `meetings-view`, `meetings-settings`, `layout`, `compact`, `analytics`, `reply`) runs those checks alone (they run last otherwise).
if (['plugins', 'meetings', 'meetings-view', 'meetings-settings', 'layout', 'compact', 'analytics', 'reply'].includes(process.env.WORKSPACE_E2E_ONLY)) {
  if (process.env.WORKSPACE_E2E_ONLY === 'compact') await compactChecks({ open, check, assert, shot, settled, calls: bridgeCalls, OUT });
  else if (process.env.WORKSPACE_E2E_ONLY === 'reply') await replyChecks({ open, check, assert, shot, settled, calls: bridgeCalls, OUT });
  else if (process.env.WORKSPACE_E2E_ONLY === 'analytics') await analyticsChecks({ open, check, assert, shot, settled, OUT });
  else if (process.env.WORKSPACE_E2E_ONLY === 'meetings') await meetingChecks({ open, check, assert, shot, settled, OUT });
  else if (process.env.WORKSPACE_E2E_ONLY === 'meetings-view') await meetingsViewChecks({ open, check, assert, shot, settled, calls: bridgeCalls, OUT });
  else if (process.env.WORKSPACE_E2E_ONLY === 'meetings-settings') await meetingSettingsChecks({ open, check, assert, shot, quiet, settled, OUT });
  else if (process.env.WORKSPACE_E2E_ONLY === 'layout') await layoutChecks({ open, check, assert, shot, settled, OUT, calls: bridgeCalls });
  else await pluginChecks({ open, check, assert, shot, quiet, OUT });
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

  // Polish checks (Today and Inbox), both widths: the now line stays under event text, the Day at a
  // glance labels fit, the AI tools prompt (now the CodeMie setup card) hides when a Claude is ready
  // and CodeMie setup has not started, the reader's action bar keeps its commitment button beside
  // the lane picker.
  const introduced = { 'codemie.setup.introduced': '1' };
  for (const [width, height] of [[1000, 760], [1440, 900]]) await check(`${theme} ${width}px: Today and Inbox polish`, async () => {
    const n = await open({ theme, width, height, codemie: 'fresh', localPrefs: introduced });
    const p = n.page;
    await p.waitForTimeout(500);
    assert(await p.locator('.ws-banner:has-text("Bring your AI coding tools")').count() === 0, 'the old setup banner is back');
    assert(await p.locator('.cm-today-setup').count() === 0, 'setup card shows although a Claude is ready');
    // Measured in the page's own font (the fallback is narrower) and to the subpixel: the whole
    // text's width against its box. The ellipsis is off while measuring, since Chromium lays out
    // only the part it shows, and what it hides can be less than one whole pixel.
    const cut = await p.evaluate(async () => {
      await document.fonts.ready;
      return [...document.querySelectorAll('.ws-stat strong, .ws-stat > span:last-child')].filter(el => {
        el.style.textOverflow = 'clip';
        const text = document.createRange();
        text.selectNodeContents(el);
        const over = text.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.01;
        el.style.textOverflow = '';
        return over;
      }).map(el => el.textContent);
    });
    assert(!cut.length, `Day at a glance text is cut: ${cut}`);
    const z = await p.evaluate(() => {
      const line = document.querySelector('.ws-timeline .ws-now-line');
      const event = document.querySelector('.ws-timeline .ws-tl-event');
      return { line: getComputedStyle(line, '::before').zIndex, dot: getComputedStyle(line.querySelector('span')).zIndex, event: getComputedStyle(event).zIndex };
    });
    assert(Number(z.line) < Number(z.event) && Number(z.dot) > Number(z.event), `now line is not under event text: ${JSON.stringify(z)}`);
    await shot(p, `${theme}-today-polish-${width}`);
    await p.click('.ws-nav button[data-route=inbox]');
    await p.waitForSelector('.ws-reply-bar');
    const rows = await p.evaluate(() => {
      const bar = document.querySelector('.ws-reply-bar');
      const controls = [...bar.querySelectorAll(':scope > button, :scope > details > summary')].map(el => el.getBoundingClientRect());
      return { count: controls.length, sameRow: controls.every(r => Math.abs(r.top - controls[0].top) < 2), tops: controls.map(r => Math.round(r.top)) };
    });
    assert(rows.count === 3 && rows.sameRow, `the reply's three controls are not one row: ${JSON.stringify(rows)}`);
    await shot(p, `${theme}-inbox-actions-${width}`);
    await n.context.close().catch(() => {});
    const none = await open({ theme, width, height, ai: 'none', codemie: 'fresh', localPrefs: introduced });
    await none.page.waitForSelector('.cm-today-setup :text("Set up your AI coding tools")');
    assert(await none.page.locator('.ws-banner:has-text("Bring your AI coding tools")').count() === 0, 'the old setup banner is back');
    await none.context.close().catch(() => {});
    currentPage = null;
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

  await check(`${theme}: Customize moves a widget by its header, undoes it, and removes and adds through the gallery`, async () => {
    const saves = () => page.evaluate(() => window.__bridgeCalls.filter(([op]) => op === 'layout_save').map(([, d]) => d));
    const before = (await saves()).length;
    await page.click('.ws-today-actions details[data-menu="today-more"] > summary');
    await page.waitForSelector('.ws-today-actions details[data-menu="today-more"][open]');
    await page.click('.ws-today-actions details[data-menu="today-more"] [data-action="today-customize"]:has-text("Customize")');
    await page.waitForSelector('.ws-today-editbar:has-text("Customizing Today")');
    await page.waitForSelector('.ws-gallery .ws-gallery-group:has-text("On Today")');
    await shot(page, `${theme}-customize`);
    // Day at a glance dragged by its title to the top left lands there, saved once on the drop.
    await page.evaluate(() => { document.querySelector('.ws-main').scrollTop = 0; });
    const title = await page.locator('[data-tile="focus"] .ws-tile-head h2').boundingBox();
    const tile = await page.locator('[data-tile="focus"]').boundingBox();
    const grid = await page.locator('[data-today-grid]').boundingBox();
    const from = { x: title.x + 30, y: title.y + title.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 10, from.y + 4, { steps: 2 });
    await page.mouse.move(grid.x + (from.x - tile.x), grid.y + (from.y - tile.y), { steps: 12 });
    await page.waitForSelector('.ws-tile-ph.ws-on');
    await page.mouse.up();
    await page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'layout_save').length === n + 1, before);
    let saved = (await saves()).at(-1);
    assert(saved.layout[0] === 'focus' && saved.today.items.some(i => i.id === 'focus' && i.x === 0 && i.y === 0), `layout ${saved.layout}`);
    assert(saved.widgetWidths === undefined, 'widths are no longer sent');
    await page.waitForSelector('[data-tile="focus"][style^="--x:0;--y:0;"]');
    // Undo, clicked right after the drop, saves it back where it was.
    await page.click('.ws-today-editbar [data-action="today-undo"]');
    await page.waitForSelector('[data-tile="focus"][style^="--x:8;--y:0;"]');
    // Its × takes it off Today with Undo in the toast; the gallery's Add puts it at the top left.
    await page.click('[data-tile="focus"] .ws-tile-remove');
    await page.waitForSelector('[data-tile="focus"]', { state: 'detached' });
    await page.waitForSelector('.ws-toast:has-text("Day at a glance removed from Today") .ws-toast-action:has-text("Undo")');
    saved = (await saves()).at(-1);
    assert(!saved.layout.includes('focus'), `layout ${saved.layout}`);
    await page.click('.ws-gallery [data-action="today-add"][data-id="focus"]');
    await page.waitForSelector('[data-tile="focus"][style^="--x:0;--y:0;"]');
    await page.click('.ws-today-editbar [data-action="today-done"]');
    await page.waitForSelector('.ws-today-editing', { state: 'detached' });
    await page.waitForSelector('.ws-toast:has-text("Today is saved")');
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
    await page.click('.ws-reply-bar details[data-menu="reply-snooze"] > summary');
    await page.locator('.ws-menu-item:has-text("Tomorrow")').click();
    await page.waitForTimeout(300);
    assert(await page.locator('.ws-inbox-row:has-text("Jordan Lee")').count() === 0, 'snooze left part of the Teams chat behind');
    await page.click('.ws-reply-bar details[data-menu="reply-more"] > summary');
    await page.click('.ws-reply-bar details[data-menu="reply-more"] [data-action="message-archive"]');
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
    for (const tab of ['general', 'notifications', 'appearance', 'queues', 'privacy', 'activity', 'updates', 'cm-health']) {
      await page.click(`.ws-settings-nav button[data-tab=${tab}]`);
      await page.waitForSelector('.ws-settings-panels .ws-card');
      if (['general', 'notifications', 'appearance'].includes(tab)) await shot(page, `${theme}-settings-${tab}`);
    }
  });

  await check(`${theme}: checkbox and button geometry match CodeMie`, async () => {
    await page.click('.ws-settings-nav button[data-tab=notifications]');
    await quiet(page);
    // Measured on the button as it is once it is drawn: a follow-up render may replace the first one.
    const btn = await (await page.waitForFunction(() => {
      const e = document.querySelector('.ws-settings-panels .ws-btn-primary');
      const height = e?.getBoundingClientRect().height;
      if (!height) return null;
      const c = getComputedStyle(e);
      return [height, c.fontSize, c.fontWeight, c.borderRadius];
    })).jsonValue();
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

  await check(`${theme}: Microsoft 365 › how often to check, every minute by default`, async () => {
    await page.click('.ws-nav button[data-route=settings]');
    await page.click('.ws-settings-nav button[data-tab=microsoft]');
    const every = page.locator('select[data-action="sync-every"]');
    assert(await every.inputValue() === '1', `default ${await every.inputValue()}`);
    assert(/Every minute \(default\)/.test(await every.locator('option:checked').innerText()), 'the default is named');
    await every.selectOption('5');
    await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'settings_update' && d.syncEveryMin === 5));
    await page.waitForFunction(() => document.querySelector('select[data-action="sync-every"]')?.value === '5');
    await page.locator('select[data-action="sync-every"]').selectOption('1');
    await page.waitForFunction(() => document.querySelector('select[data-action="sync-every"]')?.value === '1');
  });

  await check(`${theme}: settings claude page`, async () => {
    await page.click('.ws-nav button[data-route=settings]');
    await page.click('.ws-settings-nav button[data-tab=ai]');
    await page.waitForSelector('[data-ai-profile="claude"]');
    assert(await page.locator('[data-ai-profile]').count() === 3, 'profile cards');
    const native = await text(page, '[data-ai-profile="claude"]');
    assert(/Ready/i.test(native) && /Max/.test(native) && /taylor@example\.com/.test(native) && /2\.1\.150/.test(native), native);
    assert(/Needs sign-in/i.test(await text(page, '[data-ai-profile="codemie:staging"]')), 'needs sign-in chip');
    assert(await page.locator('[data-ai-route-row]').count() === 6, 'route rows');
    assert(/Meeting notes/.test(await text(page, '[data-ai-route-row="meeting"]')), 'meeting notes route row');
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
const MORE = '.ws-reply-bar details[data-menu="reply-more"]';
const onMore = () => document.activeElement?.matches('.ws-reply-bar details[data-menu="reply-more"] > summary');
const openOptions = async page => {
  await page.click(`${MORE} > summary`);
  await page.click(`${MORE} [data-action="ai-draft-options"]`);
  await page.waitForSelector('#draft-options');
  await page.waitForTimeout(150);
};
for (const theme of ['dark', 'light']) {
  const { page, context, errors } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });

  await check(`${theme}: ai draft flow`, async () => {
    await page.waitForSelector('.ws-read[data-message-id="c-reply-1"] [data-action="ai-draft-options"]', { state: 'attached' });
    // The empty box: the ✦ hint over it, no change line.
    assert(await page.locator('.ws-reply-hint:visible [data-action="ai-draft-quick"]').count() === 1, 'the empty box has no ✦ draft with AI');
    assert(await page.locator('#reply-change').count() === 0, 'a change line under the empty box');
    await openOptions(page);
    assert(await page.evaluate(() => document.activeElement?.dataset.action === 'ai-draft'), 'Draft is focused when the options open');
    assert(await page.locator(`${MORE}[open]`).count() === 0, 'the ⋯ menu stays open under the options');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#draft-options', { state: 'detached' });
    assert(await page.evaluate(onMore), 'Esc returns focus to ⋯');
    await openOptions(page);
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.activeElement?.dataset.draftIntent === 'reply'), 'Tab stays inside the popover');
    const geometry = await page.evaluate(() => {
      const pop = document.getElementById('draft-options').getBoundingClientRect();
      const trigger = document.querySelector('.ws-reply-bar details[data-menu="reply-more"] > summary').getBoundingClientRect();
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
    assert(await page.locator('.ws-reply-hint:visible').count() === 0 && await page.locator('#reply-change').count() === 1, 'the filled box keeps the hint or has no change line');
    assert(/Choose an option in brackets before sending/.test(await text(page, '.ws-draft-todo')), 'bracket note');
    assert(/Can you join the call at 11:00\?/.test(await text(page, '.ws-draft-todo')), 'questions');
    await page.click('[data-action="ai-draft-context"]');
    assert(await page.locator('[data-action="ai-draft-context"]').getAttribute('aria-expanded') === 'true', 'Context is expanded');
    assert(/Jordan Lee/.test(await text(page, '#draft-context')), 'context lists senders');
    const widths = await page.evaluate(() => [document.getElementById('draft-context').getBoundingClientRect().width, document.querySelector('.ws-draft-provenance').getBoundingClientRect().width]);
    assert(Math.abs(widths[0] - widths[1]) < 1, `Context spans the panel ${widths}`);
    // A Teams draft is chat text: no greeting, no sign-off (the Outlook fixture is the letter).
    assert(!/^\s*(Hi|Hello|Dear) |Best regards|Kind regards/i.test(await page.locator('#reply-body').inputValue()), 'a Teams draft reads like a letter');
    await page.waitForTimeout(250);
    await shot(page, `${theme}-draft-result`);
    // A re-render puts keyboard focus back on the exact control, never on its sibling.
    await page.focus(`[data-action="ai-draft-choice"][data-option="Sorry, I can't make 11:00"]`);
    await page.evaluate(() => window.__workspace.render());
    await page.evaluate(() => window.__workspace.render());
    const refocused = await page.evaluate(() => ({ option: document.activeElement?.dataset.option, fresh: document.activeElement?.isConnected }));
    assert(refocused.option === "Sorry, I can't make 11:00" && refocused.fresh, `focus moved to ${JSON.stringify(refocused)}`);
    await page.click('[data-action="reply-send"]');
    await page.waitForSelector('.ws-modal[open]:has-text("Finish your reply first?")');
    await page.waitForTimeout(250);
    await shot(page, `${theme}-draft-unfinished`);
    await page.click('.ws-modal[open] button:has-text("Edit reply")');
    await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
    await page.click('[data-action="ai-draft-choice"][data-option="Yes, 11:00 works for me"]');
    const value = await page.locator('#reply-body').inputValue();
    assert(value.startsWith('Yes, 11:00 works for me. If that changes') && !value.includes('['), value);
    // Teams sends on the click: no dialog, action_prepare then action_confirm with its nonce.
    const before = (await page.evaluate(() => window.__bridgeCalls)).length;
    assert(await text(page, '[data-action="reply-send"]') === 'Send to Jordan', `primary reads ${await text(page, '[data-action="reply-send"]')}`);
    // A double click sends one message.
    await page.dblclick('[data-action="reply-send"]');
    await page.waitForSelector('.ws-reply-status:has-text("Sent to Jordan.")', { timeout: 4000 });
    assert(await page.locator('.ws-modal[open]').count() === 0, 'a Teams send opened a dialog');
    const sent = (await page.evaluate(() => window.__bridgeCalls)).slice(before).filter(([op]) => op.startsWith('action_'));
    assert(sent.length === 2 && sent[0][0] === 'action_prepare' && sent[0][1].kind === 'chat_reply' && sent[0][1].body.startsWith('Yes, 11:00 works for me')
      && sent[1][0] === 'action_confirm' && sent[1][1].actionId === 'action-1' && sent[1][1].nonce === 'nonce-1', JSON.stringify(sent));
    assert(await page.locator('.ws-reply-status [data-action="source"]:has-text("Open in Teams ↗")').count() === 1, 'no Open in Teams ↗ after the send');
    assert(await page.locator('#reply-body').inputValue() === '', 'the box keeps the sent text');
    assert(await page.locator('.ws-toasts .ws-toast').count() === 0, 'a Teams send toasts');
    // No pending autosave brings the sent text back as a saved reply.
    await page.waitForTimeout(1800);
    const left = await page.evaluate(() => window.__workspace.store.get().snapshot.records.find(r => r.kind === 'draft' && r.id === 'manual:c-reply-1')?.data.text);
    assert(left === undefined, `the sent text is still saved: ${JSON.stringify(left)}`);
    assert(await page.locator('#reply-body').inputValue() === '', 'the sent text came back');
    await page.waitForTimeout(250);
    await shot(page, `${theme}-reply-sent-teams`);
  });

  await check(`${theme}: the user's own brackets send without a warning`, async () => {
    await page.click('.ws-inbox-row[data-id="m-reply-1"]');
    await page.waitForSelector('.ws-read[data-message-id="m-reply-1"] #reply-body');
    await page.fill('#reply-body', 'Merged in [EPMCDME-1234], the rest is [WIP]. [Yes / No] for the demo?');
    assert(await text(page, '[data-action="reply-send"]') === 'Send to Priya…', `primary reads ${await text(page, '[data-action="reply-send"]')}`);
    const before = (await page.evaluate(() => window.__bridgeCalls)).length;
    await page.click('[data-action="reply-send"]');
    await page.waitForSelector('.ws-modal[open]:has-text("Send this reply?")');
    assert(await page.locator('.ws-modal[open]:has-text("Finish your reply first?")').count() === 0, 'warned about hand-written brackets');
    assert(await page.locator('.ws-draft-todo:not([hidden]) .ws-draft-choice').count() === 0, 'hand-written brackets listed as choices');
    const dialog = await text(page, '.ws-modal[open] .ws-modal-body');
    assert(dialog.includes('To: priya.n@example.test') && dialog.includes('Signature: none — Connect sends your text as written') && !dialog.includes('(new)'), dialog);
    assert(/expires in 5 minutes/.test(await text(page, '.ws-modal[open] .ws-modal-header p')), 'no expiry in the subtitle');
    assert(await page.evaluate(() => document.activeElement?.textContent.trim() === 'Cancel'), 'Cancel is not focused');
    await page.waitForTimeout(250);
    await shot(page, `${theme}-reply-mail-confirm`);
    await page.click('.ws-modal[open] button:has-text("Cancel")');
    await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
    const after = (await page.evaluate(() => window.__bridgeCalls)).slice(before).map(([op]) => op);
    assert(after.includes('action_prepare') && !after.includes('action_confirm'), `Cancel sent something: ${after}`);
    assert(await page.locator('#reply-body').inputValue().then(v => v.startsWith('Merged in')), 'Cancel emptied the box');
  });

  await check(`${theme}: a background sync while replying never blocks Review or Send`, async () => {
    await page.fill('#reply-body', 'Thanks, see you at 11.');
    await page.evaluate(() => { window.__syncBump = true; });
    await page.click('[data-action="reply-send"]');
    await page.waitForSelector('.ws-modal[open]:has-text("Send this reply?")');
    await page.evaluate(() => { window.__syncBump = true; });
    // The commit guard ignores a Send right after the dialog opens.
    await page.waitForTimeout(500);
    await page.click('.ws-modal[open] button[type=submit]');
    await page.waitForSelector('.ws-reply-status:has-text("Sent to Priya.")', { timeout: 4000 });
    await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
    assert(await page.locator('.ws-reply-status [data-action="source"]:has-text("Open in Outlook ↗")').count() === 1, 'no Open in Outlook ↗ after the send');
    assert(await page.locator('.ws-toasts .ws-toast-error').count() === 0, `an error toast appeared: ${await page.locator('.ws-toasts .ws-toast-error').allInnerTexts()}`);
    assert((await lastCall(page, 'action_confirm'))?.nonce === 'nonce-1', 'the mock bridge got the confirm');
    assert(await page.locator('#reply-body').inputValue() === '', 'the box keeps the sent text');
  });

  // The ⌘↩ gate (untouched draft disarmed, a click arms it once, re-armed only by typing, never
  // after a send) moved to reply-checks.mjs R7 — the single home for reply behaviour.

  await check(`${theme}: a sent reply stays sent after a reload: the box is empty and Send waits for new text`, async () => {
    // Native keeps the drafts on disk: the mock carries the stored ones over the reload.
    await page.waitForTimeout(400);
    await page.evaluate(() => sessionStorage.setItem('e2e.drafts', JSON.stringify(window.__workspace.store.get().snapshot.records.filter(r => r.kind === 'draft'))));
    await page.reload();
    await page.waitForSelector('.ws-inbox-row[data-id="c-reply-1"]');
    await page.click('.ws-inbox-row[data-id="c-reply-1"]');
    await page.waitForSelector('.ws-read[data-message-id="c-reply-1"] #reply-body');
    await page.waitForTimeout(300);
    const value = await page.locator('#reply-body').inputValue();
    assert(value === '', `the sent text is back after a reload: ${JSON.stringify(value)}`);
    assert(await page.locator('.ws-draft-provenance').count() === 0, 'the sent draft still shows Drafted with Claude');
    assert(await page.locator('[data-action="reply-send"]').isDisabled(), 'Send is enabled on an empty box');
  });

  await check(`${theme}: a draft arriving while you type asks first, in the same box; Restore survives edits`, async () => {
    await plan(page, { outcome: 'hold' });
    await page.click('.ws-reply-hint [data-action="ai-draft-quick"]');
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

  await check(`${theme}: Tell AI what to change sends the words with the current text, and autosaves`, async () => {
    await page.fill('#reply-body', 'Sure, sending it at 14:30.');
    await page.waitForSelector('.ws-reply-status:has-text("Saved on this device")', { timeout: 4000 });
    const saved = await page.evaluate(() => window.__workspace.store.get().snapshot.records.find(r => r.kind === 'draft' && r.id === 'manual:c-reply-1')?.data.text);
    assert(saved === 'Sure, sending it at 14:30.', `autosave kept ${JSON.stringify(saved)}`);
    await plan(page, { outcome: 'hold' });
    await page.fill('#reply-change', 'make it 15:00');
    await page.press('#reply-change', 'Enter');
    await page.waitForSelector('.ws-draft-running', { timeout: 4000 });
    const call = await lastCall(page, 'ai_draft');
    assert(call.instructions === 'make it 15:00' && call.revise === 'Sure, sending it at 14:30.', JSON.stringify(call));
    assert(await page.locator('.ws-modal[open]').count() === 0, 'Return in the change line submitted the reply');
    assert(await page.inputValue('#reply-change') === '', 'the change line keeps its words');
    await page.click('.ws-draft-running [data-action="ai-draft-stop"]');
    await page.waitForSelector('.ws-draft-running', { state: 'detached', timeout: 4000 });
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
    assert(await page.evaluate(onMore), 'focus returns to ⋯');
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
    await p.waitForSelector('[data-action="ai-draft-options"]', { state: 'attached' });
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
    assert(await p.locator('[data-action="reply-send"]').count() === 0, 'Send without permission');
    assert(await p.locator('.ws-reply-bar > .ws-btn-primary[data-action="reply-copy"]').count() === 1, 'Copy reply is not the primary');
    await p.click('[data-action="reply-copy"]');
    await p.waitForSelector('.ws-modal[open]:has-text("Finish your reply first?")');
    // Return cancels this dialog, and its commit guard ignores a click right after it opens.
    await p.waitForTimeout(450);
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
    await p.waitForSelector('[data-action="ai-draft-options"]', { state: 'attached' });
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
/** Summarize is under the action line's ⋯. */
const summarize = async page => {
  if (!(await page.locator(`${MORE}[open]`).count())) await page.click(`${MORE} > summary`);
  await page.click(`${MORE} [data-action="ai-summarize"]`);
};
const ASKS = [{ text: 'Send Jordan the roadmap draft', due: '2026-11-20' }, { text: 'Book the review room for Thursday' }];
for (const theme of ['dark', 'light']) {
  const { page, context, errors } = await open({ theme, hash: '#/inbox', longThread: true });

  await check(`${theme}: summary flow`, async () => {
    await page.click('.ws-inbox-row[data-id="m-reply-2"]');
    await page.waitForSelector('.ws-read[data-message-id="m-reply-2"]');
    assert(await page.locator('[data-action="ai-summarize"]').count() === 0, 'Summarize on a one-message conversation');
    await page.click('.ws-inbox-row[data-id="m-reply-1"]');
    await page.waitForSelector(`.ws-read[data-message-id="m-reply-1"] ${MORE} [data-action="ai-summarize"]`, { state: 'attached' });
    await page.click(`${MORE} > summary`);
    assert(/Summarize/.test(await text(page, `${MORE} [data-action="ai-summarize"]`)), 'label');
    await shot(page, `${theme}-summary-button`);
    await page.fill('#reply-body', 'Typing while Claude reads');
    // The route for summaries is CodeMie in this fixture; it started long enough ago to be named.
    await summaryPlan(page, { outcome: 'hold', startedAgo: 20 });
    await summarize(page);
    await page.waitForSelector('.ws-summary .ws-draft-running:has-text("Summarizing with CodeMie · Haiku 4.5")', { timeout: 4000 });
    assert((await lastCall(page, 'ai_summarize')).sourceId === 'm-reply-1', 'summarize request');
    assert(await page.locator('[data-action="ai-summarize"]').count() === 0, 'a second Summarize while running');
    await page.waitForTimeout(1100);
    assert(/\d+ s/.test(await text(page, '.ws-summary .ws-draft-running')), 'elapsed seconds');
    assert(await page.locator('.ws-summary .ws-draft-running [data-action="ai-draft-stop"]').count() === 1, 'Stop');
    await shot(page, `${theme}-summary-running`);
    await page.evaluate(asks => window.__finishSummary({ outcome: 'ok', text: 'Priya asked for roadmap comments before Thursday. You said you would look today; she has since asked for the draft to go to Jordan and for the review room.', asks }), ASKS);
    await page.waitForSelector('.ws-summary .ws-summary-text');
    // Summarize is under ⋯, so the box was left (and saved on blur) before the summary came: it may
    // be drawn again, but with the text typed in it.
    assert(await page.evaluate(() => document.getElementById('reply-body').value === 'Typing while Claude reads'), 'the reply lost its text');
    assert(await page.locator('.ws-summary [data-action="summary-ask-commit"]').count() === 2, 'asks');
    assert(/Due Fri, Nov 20/.test(await text(page, '.ws-summary')), 'formatted due date');
    assert(/Summarized with CodeMie · Haiku 4\.5 · 3 s · from 5 messages/.test(await text(page, '.ws-summary')), 'provenance');
    assert(await page.locator(`${MORE} [data-action="ai-summarize"]`).count() === 0, 'Summarize stays after a summary');
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
    await summarize(p);
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
    await summarize(p);
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
  await check('✦ set up AI turns into ✦ draft with AI once Claude is ready', async () => {
    await page.waitForSelector('.ws-reply-hint [data-action="ai-open-settings"]:has-text("✦ set up AI")');
    await page.evaluate(profiles => window.__setAiProfiles(profiles), aiStatus('native').profiles);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForSelector('.ws-reply-hint [data-action="ai-draft-quick"]:has-text("✦ draft with AI")', { timeout: 4000 });
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
      await page.click('[data-action="dock-tab"][data-tab="auto-templates"]');
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
      await page.waitForSelector('[data-tab="auto-list"][aria-selected="true"]');
      await page.waitForSelector('.ws-auto-row.ws-auto-highlight');
      await shot(page, `${tag}-automations-created`);
      const row = await text(page, '.ws-auto-row');
      assert(row.includes('Weekdays at 08:45') && /Next: (Today|Tomorrow|Mon|Tue|Wed|Thu|Fri) 08:45/.test(row), row);
      await page.waitForSelector('.ws-auto-row:not(.ws-auto-highlight)', { timeout: 10000 });
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
      await quiet(page);
      await page.locator('.ws-auto-card').scrollIntoViewIfNeeded();
      await noOverflow(page, 'Today');
      await elementShot(page, '.ws-auto-card', `${tag}-today-automation-results.png`);
      await page.click('.ws-auto-card [data-action="automation-open-run"]');
      await page.waitForSelector('.ws-run.ws-open .ws-run-output');

      await page.click('.ws-nav button[data-route=automations]');
      await page.click('[data-action="dock-tab"][data-tab="auto-list"]');
      await renderSettled(page);
      await page.locator('.ws-auto-row .ws-switch').first().click();
      await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'automation_toggle' && d.enabled === false));
      await page.waitForSelector('.ws-auto-row.ws-off');
      assert(!(await page.locator('.ws-auto-row input[data-action="automation-toggle"]').isChecked()), 'switch still on');
      assert(id, 'saved automation id');
    });

    await check(`${tag}: the editor locks the conversation for reply drafts and shows backend sentences inline`, async () => {
      await page.click('[data-action="dock-tab"][data-tab="auto-templates"]');
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

    // A Teams message carries the sender's name and no address: its From asks for names only, and
    // the critical trigger's "Only from" takes addresses, domains or Teams names.
    await check(`${tag}: the Teams and critical sender fields say what they match`, async () => {
      await page.click('[data-action="dock-tab"][data-tab="auto-templates"]');
      await page.click('[data-action="automation-template"][data-id="draft-replies"]');
      await editorOpen(page);
      const hintOf = () => page.evaluate(() => document.querySelector('.ws-modal[open] #auto-senders')?.closest('.ws-field')?.querySelector('.ws-field-hint')?.textContent || '');
      for (const [event, hint, name] of [
        ['chat_from', 'Names as Teams shows them, separated by commas. For example Ann Lee, Bob Stone', 'chat'],
        ['critical', 'Addresses, domains or Teams names. Leave it empty for every critical item.', 'critical'],
      ]) {
        await page.selectOption('.ws-modal[open] select[name="auto-event"]', event);
        await page.waitForFunction(h => document.querySelector('.ws-modal[open] #auto-senders')?.closest('.ws-field')?.textContent.includes(h), hint);
        assert(await hintOf() === hint, `${event} hint: ${await hintOf()}`);
        await noOverflow(page, `${event} editor`);
        await shot(page, `${tag}-automation-editor-${name}`);
      }
      await page.click('.ws-modal[open] .ws-modal-footer [data-modal-close]');
      await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
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
      await p.click('[data-action="dock-tab"][data-tab="auto-list"]');
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
      assert(/Latest run failed \d+ min ago: Claude Code isn.t signed in\./.test(card), card);
      // Newest first: Morning brief's failure 5 minutes ago (above its older result), then Ann's reply.
      assert(card.indexOf('Latest run failed') < card.indexOf('2 replies owed') && card.indexOf('2 replies owed') < card.indexOf('Reply drafted for Ann'), card);
      await quiet(p);
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
// Page sections (spec "Page sections"), once: the Run log beside the list reads its runs whenever
// it comes into view, and the hash names the tab chosen last.
{
  const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, hash: '#/automations/runs', automations: true });
  await check('automations sections: the Run log beside the list loads whenever it comes into view', async () => {
    await page.waitForSelector('.ws-page-automations .ws-automations > .ws-dock .ws-run-log .ws-run');
    assert(await page.locator('.ws-auto-list').count() === 0, 'the list is behind the Run log');
    const menu = '.ws-pane:has(.ws-dock-tab[data-tab="auto-runs"]) .ws-dock-menu';
    await page.click(`${menu} > summary`);
    await page.click(`${menu} [data-action="dock-beside"]`);
    await page.waitForSelector('.ws-auto-list .ws-auto-row');
    assert(await page.locator('.ws-run-log .ws-run').count() === 3, 'the Run log beside it');
    await page.waitForFunction(() => location.hash === '#/automations');
    await noOverflow(page, 'Run log beside the list');
    await shot(page, 'dark-1440-automations-sections');
    // Collapsed, then opened again from its rail: it reads its newest page again (the runs read
    // before are dropped meanwhile, so only a new read shows them).
    await page.click('.ws-pane:has(.ws-dock-tab[data-tab="auto-runs"]) .ws-pane-tools [data-action="dock-collapse"]');
    await page.waitForSelector('.ws-run-log', { state: 'detached' });
    await page.evaluate(() => { window.__workspace.state.automations.runs.items = null; });
    await page.click('.ws-pane-rail-tab[data-tab="auto-runs"]');
    await page.waitForSelector('.ws-run-log .ws-run');
    await page.waitForFunction(() => location.hash === '#/automations/runs');
    // Kept: after a reload both are there, and the Run log is read at once.
    await page.reload();
    await page.waitForSelector('.ws-auto-list .ws-auto-row');
    await page.waitForSelector('.ws-run-log .ws-run');
    // A section scrolls on its own and keeps its place through a render (the minute tick, a run
    // opened): every run open in a short window.
    await page.setViewportSize({ width: 1440, height: 600 });
    for (const row of await page.locator('.ws-run-row').all()) await row.click();
    await page.waitForFunction(() => document.querySelectorAll('.ws-run.ws-open').length === 3);
    const runs = '.ws-pane:has(.ws-dock-tab[data-tab="auto-runs"]) > .ws-pane-body';
    const top = await page.evaluate(sel => { const body = document.querySelector(sel); body.scrollTop = body.scrollHeight; return body.scrollTop; }, runs);
    assert(top > 0, `the Run log scrolls: ${top}`);
    await page.evaluate(() => window.__workspace.render());
    assert(await page.evaluate(sel => document.querySelector(sel).scrollTop, runs) === top, 'a render keeps the Run log’s place');
    await page.locator('.ws-run-row').first().dispatchEvent('click');
    await page.waitForFunction(() => document.querySelectorAll('.ws-run.ws-open').length === 2);
    assert(await page.evaluate(sel => document.querySelector(sel).scrollTop, runs) > 0, 'a run closed keeps the Run log scrolled');
    assert(errors.length === 0, errors.join(' | '));
  });
  await context.close().catch(() => {});
}

// Tasks (spec "Tasks page"): the board with the fixture's tasks (withTasks); accept, drag with the
// drop line, the keyboard Move to menu, the drawer, delete and Undo, filters, the list, dismissed
// tasks and quick add; both themes at 1440, 1000 and 1680 px.
const lastSave = async (page, op = 'task_save') => (await page.evaluate(() => window.__bridgeCalls)).filter(([o]) => o === op).at(-1)?.[1];
const taskIn = (col, id) => `.ws-task-col[data-col="${col}"] [data-task="${id}"]`;
for (const theme of ['dark', 'light']) {
  for (const [width, height] of [[1440, 900], [1000, 760], [1680, 960]]) {
    const tag = `${theme}-${width}`;
    const { page, context, errors } = await open({ theme, width, height, hash: '#/tasks', tasks: true });
    await check(`${tag}: tasks board: review, drag, edit, delete and undo`, async () => {
      await page.waitForSelector('.ws-task-board');
      assert(await page.locator('.ws-nav button[data-route=tasks][aria-current=page]').count() === 1, 'Tasks is not current');
      assert((await text(page, '.ws-nav button[data-route=tasks] .ws-count')) === '2', 'two tasks to review in the sidebar');
      const columns = await page.locator('.ws-task-col').evaluateAll(cols => cols.map(c => `${c.dataset.col}:${c.querySelector('.ws-task-col-count').textContent}`));
      assert(columns.join() === 'review:2,todo:5,doing:1,waiting:1,done:2', columns.join());
      // Review cards: the quote, Check the owner for the unsure one, Accept and Dismiss.
      assert(await page.locator('[data-task="task-bug"] .ws-task-low:has-text("Check the owner")').count() === 1, 'Check the owner');
      assert(await page.locator('[data-task="task-share"] .ws-task-said').count() === 1, 'quote snippet');
      // Overdue first in To do, red.
      assert(await page.locator('.ws-task-col[data-col="todo"] [data-task]').first().getAttribute('data-task') === 'task-legal', 'overdue first');
      const red = await page.locator('[data-task="task-legal"] .ws-due-overdue').evaluate(el => getComputedStyle(el).color);
      assert(/rgb\((254, 59, 76|229, 41, 58)\)/.test(red), `overdue chip colour ${red}`);
      await noOverflow(page, 'board');
      await renderSettled(page);
      await shot(page, `${tag}-tasks-board`);

      // Owed to me + Overdue: only others' overdue tasks, and the counts say so.
      await page.click('[data-action="tasks-who"][data-who="others"]');
      await page.selectOption('select[data-filter="due"]', 'overdue');
      await page.waitForSelector('[data-action="tasks-clear"]');
      const owed = await page.locator('.ws-task-board [data-task]').evaluateAll(cards => cards.map(c => c.dataset.task));
      assert(owed.join() === 'task-legal', `owed to me, overdue: ${owed}`);
      const filtered = await page.locator('.ws-task-col-count').evaluateAll(counts => counts.map(c => c.textContent).join());
      assert(filtered === '0,1,0,0,0', `column counts ${filtered}`);
      await noOverflow(page, 'filtered board');
      await page.click('[data-action="tasks-clear"]');
      await page.waitForSelector('[data-action="tasks-clear"]', { state: 'detached' });

      // Accept: to To do with the history line.
      await page.click('[data-task="task-share"] [data-action="task-accept"]');
      await page.waitForSelector(taskIn('todo', 'task-share'));
      assert((await lastSave(page)).log === 'Accepted from review', 'accept log');

      // Drag task-names onto Waiting: the column lights up and a line shows where it lands.
      const card = page.locator('[data-task="task-names"]');
      await renderSettled(page);
      await card.scrollIntoViewIfNeeded();
      const from = await card.boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + 12);
      await page.mouse.down();
      const zone = page.locator('.ws-task-col[data-col="waiting"] [data-drop]');
      const to = await zone.boundingBox();
      await page.mouse.move(to.x + to.width / 2, to.y + 8, { steps: 8 });
      await page.mouse.move(to.x + to.width / 2, to.y + 10, { steps: 2 });
      await page.waitForSelector('.ws-task-col[data-col="waiting"].ws-drop-on .ws-task-insert', { timeout: 3000 });
      await shot(page, `${tag}-tasks-drag`);
      await page.mouse.up();
      await page.waitForSelector(taskIn('waiting', 'task-names'));
      const dropped = await lastSave(page);
      assert(dropped.id === 'task-names' && dropped.status === 'waiting', JSON.stringify(dropped));
      const order = await page.locator('.ws-task-col[data-col="waiting"] [data-task]').evaluateAll(cards => cards.map(c => c.dataset.task));
      assert(order[0] === 'task-names' && order.includes('task-hr'), `dropped above task-hr: ${order}`);
      assert(await page.locator('.ws-task-insert').count() === 0, 'the drop line stays');

      // Keyboard: the card's ⋯ › Move to › Done (an update meanwhile keeps the focus where it is).
      await renderSettled(page);
      await page.focus('[data-task="task-legal"] .ws-task-menu summary');
      await page.evaluate(() => window.__workspace.render());
      assert(await page.evaluate(() => document.activeElement?.dataset.menuTrigger) === 'task-legal', 'focus kept on ⋯ through a render');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-task="task-legal"] .ws-menu[open] [data-action="task-move"][data-col="done"]');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      assert(await page.evaluate(() => document.activeElement?.dataset.col) === 'done', 'Tab reaches Done');
      await page.keyboard.press('Enter');
      await page.waitForSelector(taskIn('done', 'task-legal'));
      // Focus follows the card: its ⋯ in Done, ready for the next move.
      await page.waitForFunction(() => document.activeElement?.dataset.menuTrigger === 'task-legal' && document.activeElement.closest('.ws-task-col')?.dataset.col === 'done');

      // Menus: one open at a time, a click elsewhere closes it, Escape closes it onto its ⋯.
      await renderSettled(page);
      await page.click('[data-task="task-hr"] .ws-task-menu summary');
      await page.click('[data-task="task-demo"] .ws-task-menu summary');
      await page.waitForSelector('[data-task="task-demo"] .ws-menu[open]');
      assert(await page.locator('.ws-menu[open]').count() === 1, 'two menus open');
      await page.click('.ws-tasks-heading h1');
      assert(await page.locator('.ws-menu[open]').count() === 0, 'a click elsewhere leaves it open');
      await page.click('[data-task="task-demo"] .ws-task-menu summary');
      await page.keyboard.press('Escape');
      assert(await page.locator('.ws-menu[open]').count() === 0, 'Escape leaves it open');
      assert(await page.evaluate(() => document.activeElement?.dataset.menuTrigger) === 'task-demo', 'focus back on ⋯');

      // The drawer: the quote with its transcript link, owner from the meeting first, due, notes.
      await page.click('[data-task="task-bug"] .ws-task-title');
      await page.waitForSelector('.ws-task-drawer');
      await page.waitForFunction(() => document.activeElement?.classList.contains('ws-task-drawer-title'), null, { timeout: 3000 });
      const link = page.locator('.ws-task-drawer a[data-action="task-quote"]');
      assert(await link.getAttribute('href') === '#/meetings/ev-sync/transcript', 'transcript link');
      assert(/6:52 into the meeting — show in transcript/.test(await link.innerText()), 'quote time');
      assert(await page.locator('.ws-task-drawer optgroup[label="In this meeting"] option').count() === 5, 'meeting people first');
      await noOverflow(page, 'drawer');
      await renderSettled(page);
      await shot(page, `${tag}-task-drawer`);
      await page.selectOption('.ws-task-drawer select[data-action="task-owner"]', 'sam.okafor@example.test');
      await page.waitForSelector('.ws-task-history li:has-text("Owner set to Sam Okafor")');
      await page.click('.ws-task-drawer [data-action="task-due-pick"]:has-text("Tomorrow")');
      await page.waitForSelector('.ws-task-history li:has-text("Due date set to")');
      // A typed date saves when it is left, once: nothing while typing, then Enter.
      const typedFrom = await page.evaluate(() => window.__bridgeCalls.length);
      await page.fill('.ws-task-drawer [data-commit="task-due"]', '2026-12-01');
      await page.waitForTimeout(300);
      assert(!(await page.evaluate(n => window.__bridgeCalls.slice(n).some(([op]) => op === 'task_save'), typedFrom)), 'saved while typing');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.ws-task-history li:has-text("Due date set to 2026-12-01")');
      assert((await page.evaluate(n => window.__bridgeCalls.slice(n).filter(([op]) => op === 'task_save').length, typedFrom)) === 1, 'one save');
      await page.fill('.ws-task-drawer [data-change="task-notes"]', 'Check with QA first.');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ws-task-drawer', { state: 'detached' });
      await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'task_save' && d.notes === 'Check with QA first.'));
      await renderSettled(page);
      assert(await page.evaluate(() => document.activeElement?.closest('[data-task]')?.dataset.task) === 'task-bug', 'focus back on the card');

      // Delete from the card menu, then Undo: the card is back with its history.
      const tenant = page.locator('[data-task="task-tenant"]');
      await openRowMenu(page, tenant, '[data-action="task-delete"]');
      await tenant.locator('[data-action="task-delete"]').click();
      await page.waitForSelector('[data-task="task-tenant"]', { state: 'detached' });
      // Focus goes to the next card of the column.
      await page.waitForFunction(() => document.activeElement?.matches('.ws-task-title') && document.activeElement.closest('.ws-task-col')?.dataset.col === 'todo');
      await page.click('.ws-toast:has-text("Deleted “Ask IT for a throttling test tenant”") .ws-toast-action');
      await page.waitForSelector(taskIn('todo', 'task-tenant'));
      const restored = await page.evaluate(() => window.__workspace.store.get().snapshot.records.find(r => r.id === 'task-tenant').data);
      assert(restored.history.length === 1 && restored.status === 'todo', JSON.stringify(restored));

      // Dismiss a review card; it is listed below the board and Restore brings it back.
      await page.click('[data-task="task-bug"] [data-action="task-dismiss"]');
      await page.waitForSelector('[data-task="task-bug"]', { state: 'detached' });
      await page.click('[data-action="tasks-dismissed"]');
      await page.waitForSelector('.ws-task-dismissed-list [data-action="task-restore"][data-id="task-bug"]');
      await renderSettled(page);
      await shot(page, `${tag}-tasks-dismissed`);
      await page.click('.ws-task-dismissed-list [data-action="task-restore"][data-id="task-bug"]');
      await page.waitForSelector(taskIn('review', 'task-bug'));

      // Owed to me without a date: what others owe, open and done lately.
      await page.click('[data-action="tasks-who"][data-who="others"]');
      await page.selectOption('select[data-filter="due"]', 'none');
      await page.waitForSelector('[data-action="tasks-clear"]');
      const undated = await page.locator('.ws-task-board [data-task]').evaluateAll(cards => cards.map(c => c.dataset.task).sort());
      assert(undated.join() === 'task-hr,task-pilot', `owed to me, no date: ${undated}`);
      await page.click('[data-action="tasks-clear"]');
      await page.waitForSelector('[data-action="tasks-clear"]', { state: 'detached' });

      // Quick add in In progress: Enter adds, the form stays for the next one.
      await page.click('.ws-task-col[data-col="doing"] .ws-task-col-add');
      await page.fill('[data-form="task-quick"] textarea', 'Write the release notes');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.ws-task-col[data-col="doing"] .ws-task:has-text("Write the release notes")');
      await page.waitForFunction(() => document.activeElement?.matches('[data-form="task-quick"] textarea'));
      const added = await lastSave(page);
      assert(added.status === 'doing' && added.owner === 'taylor.morgan@example.test' && added.ownerName === 'Taylor Morgan', JSON.stringify(added));
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-form="task-quick"]', { state: 'detached' });

      // The list: I owe, Owed to me, Nobody named.
      await page.click('[data-action="tasks-view"][data-view="list"]');
      await page.waitForSelector('.ws-task-list');
      const groups = await page.locator('.ws-task-group .ws-card-title').evaluateAll(hs => hs.map(h => h.firstChild.textContent));
      assert(groups.join() === 'I owe,Owed to me,Nobody named', groups.join());
      await noOverflow(page, 'list');
      await renderSettled(page);
      await shot(page, `${tag}-tasks-list`);
      await page.click('[data-action="tasks-view"][data-view="board"]');
      await page.waitForSelector('.ws-task-board');

      // New task: the dialog adds it to the chosen column for the chosen person.
      await page.click('[data-action="task-new"]');
      await page.waitForSelector('.ws-modal[open] textarea[name="text"]');
      await page.waitForTimeout(250);
      await noOverflow(page, 'new task dialog');
      await shot(page, `${tag}-task-new`);
      await page.fill('.ws-modal[open] textarea[name="text"]', 'Book the review room');
      await page.selectOption('.ws-modal[open] select[name="owner"]', 'jordan.lee@example.test');
      await page.selectOption('.ws-modal[open] select[name="status"]', 'waiting');
      await page.click('.ws-modal[open] button[type=submit]');
      await page.waitForSelector('.ws-task-col[data-col="waiting"] .ws-task:has-text("Book the review room")');
      const made = await lastSave(page);
      assert(made.ownerName === 'Jordan Lee' && made.status === 'waiting' && !made.id, JSON.stringify(made));

      // A click on the due-today notification opens Tasks.
      await page.click('.ws-nav button[data-route=today]');
      await page.waitForSelector('.ws-commitments .ws-card-title:has-text("Tasks")');
      assert(await page.locator('.ws-commitments .ws-today-review:has-text("1 task from meeting notes to review")').count() === 1, 'review row on Today');
      await renderSettled(page);
      await page.evaluate(() => document.querySelector('.ws-commitments')?.scrollIntoView({ block: 'nearest' }));
      await noOverflow(page, 'Today');
      await elementShot(page, '.ws-commitments', `${tag}-today-tasks.png`);
      await page.evaluate(() => window.__emitNative('workspace:notification-open', { workspaceId: 'personal', route: 'tasks' }));
      await page.waitForSelector('.ws-page-tasks .ws-task-board');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
    currentPage = null;
  }
}

// Meetings (Task 4): the list and the meeting, the calendar's badges and event card, Today's card,
// import, speakers, Make notes as soon as it arrives, Try again, a task's quote, ↑/↓.
await meetingChecks({ open, check, assert, shot, settled, OUT });

// Meetings view (Task 7, spec 2026-11-23-meetings-view-design.md), V1–V11: the one meeting
// section in both views, both themes and three widths, panes and old links, the action items
// column, pins that vanish, the stored v1 layout, a plugin's minutes rendered safely, Default/
// Compact markup parity, and nothing sent or written without a click.
await meetingsViewChecks({ open, check, assert, shot, settled, calls: bridgeCalls, OUT });

// Flexible layout (spec docs/superpowers/specs/2026-11-19-flexible-layout-design.md, E1–E8): Today
// arranged by pen, mouse, touch and keys, saved layouts, page sections, the folding menus.
await layoutChecks({ open, check, assert, shot, settled, OUT, calls: bridgeCalls });

// Compact view (spec docs/superpowers/specs/2026-11-22-compact-view-design.md): C0, Default's
// computed sizes on ten screens match the committed baseline.
await compactChecks({ open, check, assert, shot, settled, calls: bridgeCalls, OUT });

// Reply (spec docs/superpowers/specs/2026-11-22-reply-design.md): R1–R12 — the three-control
// action line in both views/themes/widths, the ✦ link and change line, Draft options, Teams
// sends on the click (and once on a double click or a re-render), sending not allowed, the mail
// confirm with Return never confirming it, the ⌘↩ gate, nothing sent without a click, autosave,
// Today, a critical item's bar and Default/Compact parity.
await replyChecks({ open, check, assert, shot, settled, calls: bridgeCalls, OUT });

// Settings › Meetings (Task 5): transcripts and folders, note templates and skills, rules and the
// tester, the glossary typed and linked, tasks.
await meetingSettingsChecks({ open, check, assert, shot, quiet, settled, OUT });

// Analytics: Overview, filters, the notice, Refresh and its progress, first open, failed days, an
// old CLI and an empty Mac, sessions and the drawer, the App tab, and the looks in both themes.
await analyticsChecks({ open, check, assert, shot, settled, OUT });

// Plugins (DESIGN 7.3, Tasks 23–24): add a marketplace, install the synthetic hello plugin, its
// page and Settings section in their sandboxed frame, Today's plugin widgets, turn it off.
if (process.env.WORKSPACE_E2E_ONLY !== 'plugins') await pluginChecks({ open, check, assert, shot, quiet, OUT });

// Narrow and wide windows keep layouts intact.
for (const width of [1000, 1680]) {
  const { page, context } = await open({ theme: 'light', width, height: 820, tasks: true });
  await check(`layout ${width}px: no horizontal overflow on primary routes`, async () => {
    for (const route of ['today', 'calendar', 'tasks', 'inbox', 'settings']) {
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

// ---------------------------------------------------------------- Settings → CodeMie

const SHEET = '#cm-sheet-host .cm-sheet-panel';
for (const theme of ['dark', 'light']) {
  // First launch on a Mac with nothing set up: no CodeMie profile and no Claude.
  const fresh = await open({ theme, codemie: 'fresh', ai: 'none' });
  await check(`${theme} codemie: first launch opens setup`, async () => {
    await fresh.page.waitForSelector(`${SHEET} :text("Let’s get your AI coding tools working")`);
    await fresh.page.waitForTimeout(300); // the sheet fades in over 0.2 s
    await shot(fresh.page, `${theme}-codemie-welcome`);
    await fresh.page.click(`${SHEET} button:has-text("Not now")`);
    await fresh.page.waitForSelector(SHEET, { state: 'detached' });
    await fresh.page.waitForSelector('.cm-today-setup :text("Set up your AI coding tools")');
    await shot(fresh.page, `${theme}-codemie-today-card`);
  });
  await check(`${theme} codemie: org address errors`, async () => {
    const { page } = fresh;
    await page.click('.cm-today-setup button:has-text("Set up CodeMie")');
    await page.waitForSelector(`${SHEET} :text("How should CodeMie reach a model?")`);
    await page.click(`${SHEET} label.cm-choice:has(input[value=org])`);
    await page.fill(`${SHEET} input[data-draft=orgUrl]`, 'http://codemie.acme.com');
    await page.click(`${SHEET} button:has-text("Sign in with browser")`);
    await page.waitForSelector(`${SHEET} :text("The address must start with https://")`);
    await page.fill(`${SHEET} input[data-draft=orgUrl]`, 'www.example.com');
    await page.click(`${SHEET} button:has-text("Try again")`);
    await page.waitForSelector(`${SHEET} :text("www.example.com is not a CodeMie address")`);
    await shot(page, `${theme}-codemie-org-address-error`);
    await page.click(`${SHEET} button[title^="Close"]`);
    await page.waitForSelector(SHEET, { state: 'detached' });
  });
  // Review finding 6: the sheet is a dialog — focus goes into it, Escape closes it, and the page
  // behind it does not take keys meanwhile.
  await check(`${theme} codemie: the setup sheet keeps the keyboard`, async () => {
    const { page } = fresh;
    await page.click('.ws-nav button[data-route=calendar]');
    await page.waitForSelector('.ws-page-calendar');
    const before = await page.locator('.ws-page-calendar h1').first().innerText();
    await page.evaluate(() => window.__workspace.codemie.handle('cm-setup-open', { dataset: {} }));
    await page.waitForSelector(SHEET);
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => !!document.activeElement?.closest('#cm-sheet-host')), 'focus is not in the sheet');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('m');
    assert((await page.locator('.ws-page-calendar h1').first().innerText()) === before, 'the calendar behind the sheet moved');
    await page.keyboard.press('Escape');
    await page.waitForSelector(SHEET, { state: 'detached' });
  });
  await check(`${theme} codemie: first launch no page errors`, async () => assert(fresh.errors.length === 0, fresh.errors.join(' | ')));
  await fresh.context.close().catch(() => {});

  const expired = await open({ theme, codemie: 'expired' });
  await check(`${theme} codemie: expired sign-in banner and sign in again`, async () => {
    const { page } = expired;
    const banner = page.locator('.ws-banner:has-text("CodeMie sign-in expired for “prod”")');
    await banner.waitFor();
    await shot(page, `${theme}-codemie-expired-banner`);
    await banner.locator('button:has-text("Sign in again")').click();
    await page.waitForSelector('.ws-toast:has-text("Signed in again to “prod”")', { timeout: 6000 });
    await page.waitForSelector(SHEET, { state: 'detached' });
  });
  await check(`${theme} codemie: expired no page errors`, async () => assert(expired.errors.length === 0, expired.errors.join(' | ')));
  await expired.context.close().catch(() => {});

  for (const width of [1000, 1440, 1680]) {
    const ready = await open({ theme, width, codemie: 'ready', hash: '#/settings/cm-overview' });
    await check(`${theme} ${width}px codemie: settings tabs render`, async () => {
      const { page } = ready;
      for (const tab of ['cm-overview', 'cm-profiles', 'cm-agents', 'cm-apps', 'cm-health']) {
        await page.click(`.ws-settings-nav button[data-tab=${tab}]`);
        await page.waitForSelector('.ws-settings-panels > *');
        if (tab === 'cm-overview') await page.waitForSelector('.cm-tile');
        if (tab === 'cm-agents') await page.waitForSelector('[data-agent="claude"]');
        if (tab === 'cm-health') await page.waitForSelector('.cm-health-group, .ws-empty');
        await page.waitForTimeout(300);
        const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.ws-settings-panels')].map(e => e.scrollWidth - e.clientWidth)));
        assert(overflow <= 0, `${tab} overflows by ${overflow}px`);
        await shot(page, `${theme}-settings-${tab}-${width}`);
      }
    });
    await check(`${theme} ${width}px codemie: no legacy chrome in settings`, async () => {
      const { page } = ready;
      assert(!(await page.locator('#identity-bar:visible').count()), 'legacy identity bar is visible');
      assert(!(await page.locator('#sidebar-analytics').count()), 'analytics entry exists');
      assert(!(await page.locator('#legacy-host').count()), 'legacy host exists');
      assert(!(await page.locator('.ws-settings-nav :text("CLI usage analytics")').count()), 'analytics tab exists');
    });
    await check(`${theme} ${width}px codemie: settings no page errors`, async () => assert(ready.errors.length === 0, ready.errors.join(' | ')));
    await ready.context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- merge: native CodeMie settings + Milestone 2

// What the merge has to keep working together: one Claude tab whose CodeMie profiles agree with
// Settings → CodeMie, setup that never opens over the recovery page, the Today card rule, and the
// screens of both sides at 1000 and 1440 px in both themes.
const fits = page => page.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, ...[...document.querySelectorAll('.ws-settings-panels, .ws-ai-table-wrap, .cm-sheet-panel')].map(e => e.scrollWidth - e.clientWidth)));
const aiCard = id => `[data-ai-profile="${id}"]`;
for (const theme of ['dark', 'light']) {
  for (const width of [1000, 1440]) {
    const height = width === 1000 ? 760 : 900;
    const expired = await open({ theme, width, height, codemie: 'expired', hash: '#/settings/ai' });
    await check(`${theme} ${width}px merge: the Claude tab signs in a CodeMie profile Settings → CodeMie found signed out`, async () => {
      const { page } = expired;
      await page.waitForSelector(`${aiCard('codemie:prod')} :text("Needs sign-in")`);
      // One profile list: each detected profile once, no second list from the CodeMie tabs.
      assert(await page.locator('[data-ai-profile]').count() === 3, 'the Claude tab lists profiles twice');
      assert(await page.locator('.cm-profile').count() === 0, 'a CodeMie profile list is on the Claude tab');
      assert(await page.locator('.ws-settings-nav button[data-tab=ai] .ws-dot-alert').count() === 1, 'the Claude tab has no dot');
      assert(await page.locator(`${aiCard('codemie:prod')} .ws-badge-success`).count() === 0, 'the signed-out profile also says Ready');
      assert(await page.locator('select[name=ai-default] option[value="codemie:prod"]').count() === 0, 'routing offers the signed-out profile');
      assert(await fits(page) <= 0, 'the Claude tab overflows');
      await shot(page, `${theme}-merge-claude-expired-${width}`);
      await page.click(`${aiCard('codemie:prod')} button[data-action=cm-profile-login][data-id=prod]`);
      await page.waitForSelector('.ws-toast:has-text("Signed in again to “prod”")', { timeout: 6000 });
      await page.waitForSelector(`${aiCard('codemie:prod')} .ws-badge-success`);
      assert(await page.locator('.ws-settings-nav button[data-tab=ai] .ws-dot-alert').count() === 0, 'the Claude tab dot stays after sign-in');
      await shot(page, `${theme}-merge-claude-signed-in-${width}`);
    });
    await check(`${theme} ${width}px merge: Claude sign-in no page errors`, async () => assert(expired.errors.length === 0, expired.errors.join(' | ')));
    await expired.context.close().catch(() => {});

    const both = await open({ theme, width, height, hash: '#/settings/ai' });
    await check(`${theme} ${width}px merge: Claude, Data & privacy, data location, Plugins and Today render together`, async () => {
      const { page } = both;
      await page.waitForSelector(aiCard('claude'));
      await page.waitForTimeout(300);
      assert(await fits(page) <= 0, 'Claude overflows');
      await shot(page, `${theme}-merge-settings-claude-${width}`);
      for (const [tab, ready, name] of [['privacy', '.ws-settings-panels .ws-card', 'privacy'], ['general', '#data-location', 'data-location'], ['plugins', '.ws-settings-panels > *', 'plugins']]) {
        await page.click(`.ws-settings-nav button[data-tab=${tab}]`);
        await page.waitForSelector(ready);
        await page.waitForTimeout(300);
        assert(await fits(page) <= 0, `${tab} overflows`);
        await shot(page, `${theme}-merge-settings-${name}-${width}`);
      }
      // The Settings nav holds both sides: Plugins and the CodeMie group, and no legacy CodeMie tools.
      const tabs = await page.$$eval('.ws-settings-nav button[data-tab]', bs => bs.map(b => b.dataset.tab));
      for (const tab of ['ai', 'privacy', 'plugins', 'cm-overview', 'cm-profiles', 'cm-agents', 'cm-apps', 'cm-health']) assert(tabs.includes(tab), `no ${tab} tab`);
      for (const tab of ['installation', 'tools', 'desktop', 'health', 'usage']) assert(!tabs.includes(tab), `legacy ${tab} tab`);
      await page.click('.ws-nav button[data-route=today]');
      await page.waitForSelector('.ws-page-today .ws-tiles');
      await page.waitForTimeout(400);
      assert(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'Today overflows');
      await shot(page, `${theme}-merge-today-${width}`);
    });
    await check(`${theme} ${width}px merge: screens no page errors`, async () => assert(both.errors.length === 0, both.errors.join(' | ')));
    await both.context.close().catch(() => {});

    const first = await open({ theme, width, height, codemie: 'fresh', ai: 'none' });
    await check(`${theme} ${width}px merge: first-launch setup fits`, async () => {
      const { page } = first;
      await page.waitForSelector(`${SHEET} :text("Let’s get your AI coding tools working")`);
      await page.waitForTimeout(300);
      const box = await page.locator(SHEET).boundingBox();
      assert(box && box.y >= 0 && box.y + box.height <= height + 1 && box.x >= 0 && box.x + box.width <= width + 1, `the sheet leaves the window: ${JSON.stringify(box)}`);
      assert(await page.evaluate(() => document.querySelector('.ws-plugin-layer')?.inert !== false), 'plugin frames stay reachable under the sheet');
      await shot(page, `${theme}-merge-setup-welcome-${width}`);
      await page.click(`${SHEET} button:has-text("Get started")`);
      await page.waitForSelector(`${SHEET} :text("How should CodeMie reach a model?")`);
      await page.waitForTimeout(250);
      assert(await fits(page) <= 0, 'the sign-in step overflows');
      await shot(page, `${theme}-merge-setup-signin-${width}`);
    });
    await check(`${theme} ${width}px merge: first-launch no page errors`, async () => assert(first.errors.length === 0, first.errors.join(' | ')));
    await first.context.close().catch(() => {});
  }

  // A Claude is ready but CodeMie is not set up: setup still opens once (CodeMie's first-launch
  // rule), and after "Not now" Today stays without the card (Milestone 2's rule) and says where to go.
  const claudeOnly = await open({ theme, codemie: 'fresh' });
  await check(`${theme} merge: Not now with a Claude ready points to Settings → CodeMie`, async () => {
    const { page } = claudeOnly;
    await page.waitForSelector(`${SHEET} :text("Let’s get your AI coding tools working")`);
    await page.click(`${SHEET} button:has-text("Not now")`);
    await page.waitForSelector(SHEET, { state: 'detached' });
    await page.waitForSelector('.ws-toast:has-text("Settings → CodeMie")');
    assert(!/Today/.test(await page.locator('.ws-toast').last().innerText()), 'the toast points to a Today card that is not there');
    await page.waitForTimeout(400);
    assert(await page.locator('.cm-today-setup').count() === 0, 'the setup card shows although a Claude is ready');
    assert(await page.locator('.ws-settings-nav, .ws-sidebar').count() > 0, 'the workspace is gone');
  });
  await claudeOnly.context.close().catch(() => {});
  currentPage = null;

  // The recovery page wins: setup never opens over it, and an open sheet gives way to it.
  await check(`${theme} merge: no setup over a data folder that is missing at start`, async () => {
    const { page, context, errors } = await open({ theme, codemie: 'fresh', ai: 'none', storage: STORAGE.missing, unavailable: true });
    await page.waitForTimeout(1200);
    assert(await page.locator('#cm-sheet-host .cm-sheet').count() === 0, 'setup opened over the recovery page');
    assert(await page.locator('.ws-recovery-card').count() === 1, 'no recovery page');
    assert(errors.length === 0, errors.join(' | '));
    await context.close().catch(() => {});
    currentPage = null;
  });
  await check(`${theme} merge: the recovery page closes an open setup sheet`, async () => {
    const { page, context, errors } = await open({ theme, codemie: 'fresh', ai: 'none', storage: STORAGE.missing });
    await page.waitForSelector(SHEET);
    await page.evaluate(() => { window.__storageFail = true; window.dispatchEvent(new Event('focus')); });
    await page.waitForSelector('.ws-recovery-card[data-status="missing"]');
    await page.waitForSelector('#cm-sheet-host .cm-sheet', { state: 'detached' });
    assert(await page.evaluate(() => !document.getElementById('workspace-app').inert), 'the recovery page stays inert');
    const hit = await page.evaluate(() => {
      const b = document.querySelector('[data-action="recovery-retry"]').getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('[data-action="recovery-retry"]') != null;
    });
    assert(hit, 'something covers the recovery buttons');
    await shot(page, `${theme}-merge-recovery-over-setup`);
    assert(errors.length === 0, errors.join(' | '));
    await context.close().catch(() => {});
    currentPage = null;
  });
}

await browser.close();
server.close();
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
