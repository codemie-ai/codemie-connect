// The marketplace smoke's window side (CODEMIE_PLUGIN_SMOKE=<marketplace folder>, Task 25): it
// installs what the marketplace offers, waits for the plugin manager, opens every page, section and
// card each plugin's frame adds, and reports what the frames said. The verdict is Rust's
// (commands/plugin_smoke.rs); the native run is recorded in prototypes/milestone-2/VALIDATION.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMarketSmoke, recordCalls, SMOKE_CALL } from '../plugins/market-smoke.js';

/** Connect as the smoke sees it: plugins_request, the manager's state, the frames' host. */
function fakeConnect({ refuse = {}, problems = {}, frames = {}, loadsAfter = 2 } = {}) {
  const calls = [];
  let polls = 0;
  const installed = [];
  const shownLog = [];
  let shown = null;
  const errorsLater = {};
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'smoke_plugins_state') {
      polls++;
      const ids = installed.map(p => p.id);
      if (polls < loadsAfter) return { loaded: [], problems: {} };
      return { loaded: ids.filter(id => !problems[id]), problems };
    }
    if (cmd !== 'plugins_request') throw new Error(`unexpected ${cmd}`);
    const { op, data } = args;
    if (op === 'market_add') return { name: 'onetest-2', source: data.source };
    if (op === 'catalog') {
      return { plugins: ['scheduler', 'github', 'obsidian', 'telegram', 'knowledge'].map(id => ({ id, version: '1.0.0', refusal: id === 'knowledge' ? 'Needs Connect’s Knowledge engine (coming later)' : null })) };
    }
    if (op === 'inspect') return { sheet: [{ key: 'claude' }, { key: 'network' }], sheetHash: `hash-${data.id}` };
    if (op === 'install') {
      if (refuse[data.id]) throw Object.assign(new Error(refuse[data.id]), { code: 'changed' });
      installed.push({ id: data.id, client: 'client.js', enabled: true });
      return { status: 'installed' };
    }
    throw new Error(`unexpected op ${op}`);
  };
  const host = {
    status(id) {
      const f = frames[id];
      if (!f) return null;
      return { ready: f.ready !== false, error: f.error || '', errors: [...(f.errors || [])], height: 300, activities: f.activities || [], sections: f.sections || [], card: !!f.card };
    },
    shown: () => shown,
  };
  const go = async hash => {
    shownLog.push(hash);
    const m = /^#\/(?:p|settings\/plugins)\/([a-z-]+)(?:\/([a-z0-9_.-]+))?/.exec(hash);
    shown = m ? { id: m[1] } : null;
    const later = errorsLater[hash];
    if (later) frames[m[1]].errors.push(later);
  };
  return {
    invoke, host, go, calls, shownLog, errorsLater,
    refreshInstalled: async () => installed.map(p => (problems[p.id] ? { ...p, loadError: problems[p.id] } : p)),
    frameOf: id => (frames[id] && shown?.id === id ? { hidden: false, getBoundingClientRect: () => ({ width: 800, height: 600 }) } : null),
  };
}

const quick = { wait: () => new Promise(resolve => setTimeout(resolve, 1)), settleMs: 1, loadTimeoutMs: 2000, frameTimeoutMs: 200 };

test('installs every offered plugin by its sheet hash and opens each page, section and card', async () => {
  const sessions = 'CodeMie Connect doesn’t have ctx.sessions (only Echo has it)';
  const c = fakeConnect({
    problems: { telegram: `unsupported: ${sessions}` },
    frames: {
      scheduler: { sections: [{ id: 'main' }], card: true },
      github: { sections: [{ id: 'main' }], errors: [] },
      obsidian: { activities: [{ id: 'kb' }], sections: [{ id: 'main' }], errors: [] },
    },
  });
  c.errorsLater['#/settings/plugins/github/main'] = 'Unhandled rejection: boom';
  const report = await runMarketSmoke({ ...c, market: '/plugins/market', runId: 'run-1', ...quick });

  // Each sheet was agreed to whole, by its own hash; a refused plugin isn't tried.
  const installs = c.calls.filter(([cmd, a]) => cmd === 'plugins_request' && a.op === 'install').map(([, a]) => a.data);
  assert.deepEqual(installs.map(d => d.id), ['scheduler', 'github', 'obsidian', 'telegram']);
  assert.deepEqual(installs[0], { market: 'onetest-2', id: 'scheduler', agreed: ['claude', 'network'], sheetHash: 'hash-scheduler' });
  assert.equal(report.runId, 'run-1');
  assert.deepEqual(report.market, { name: 'onetest-2', source: '/plugins/market' });
  assert.equal(report.error, null);
  const by = Object.fromEntries(report.plugins.map(p => [p.id, p]));
  assert.equal(by.knowledge.install, 'refused: Needs Connect’s Knowledge engine (coming later)');
  assert.equal(by.telegram.install, 'installed');
  assert.equal(by.telegram.frame, null, 'a plugin whose host half didn’t load gets no frame');
  assert.equal(by.telegram.loadError, `unsupported: ${sessions}`);

  // Every page, section and card was opened, in its frame on screen.
  assert.deepEqual(c.shownLog, [
    '#/settings/plugins/scheduler/main', '#/settings/plugins/scheduler',
    '#/settings/plugins/github/main',
    '#/p/obsidian/kb', '#/settings/plugins/obsidian/main',
  ]);
  assert.deepEqual(by.scheduler.views.map(v => [v.view, v.id, v.shown, v.errors.length]), [['section', 'main', true, 0], ['card', '', true, 0]]);
  assert.deepEqual(by.obsidian.frame, { ready: true, error: '', errors: [], calls: [] });
  // An error a page reported is the page's.
  assert.deepEqual(by.github.views[0].errors, ['Unhandled rejection: boom']);
});

test('a marketplace that can’t be added, or a manager that never answers, is the report’s error', async () => {
  const c = fakeConnect();
  const failing = { ...c, invoke: async () => { throw new Error('There is no folder /nope.'); } };
  const report = await runMarketSmoke({ ...failing, market: '/nope', runId: 'run-2', ...quick });
  assert.equal(report.error, 'There is no folder /nope.');
  assert.deepEqual(report.plugins, []);

  const slow = fakeConnect({ loadsAfter: Infinity });
  const late = await runMarketSmoke({ ...slow, market: '/m', runId: 'run-3', ...quick, loadTimeoutMs: 20 });
  assert.match(late.error, /plugin manager didn’t load them/);
});

test('an install that fails is recorded and the rest go on', async () => {
  const c = fakeConnect({ refuse: { github: 'The permission sheet changed.' }, frames: { scheduler: { sections: [{ id: 'main' }] } } });
  const report = await runMarketSmoke({ ...c, market: '/m', runId: 'run-4', ...quick });
  const by = Object.fromEntries(report.plugins.map(p => [p.id, p]));
  assert.equal(by.github.install, 'failed: The permission sheet changed.');
  assert.equal(by.scheduler.install, 'installed');
  assert.equal(by.scheduler.views.length, 1);
});

test('each page’s commands are recorded with how they went, and kept with the page that made them', async () => {
  const calls = [];
  const invoke = recordCalls(async (cmd, args) => {
    if (cmd === 'plugin_call' && args.command === 'status') throw Object.assign(new Error('“github” isn’t on in Connect'), { code: 'not_found' });
    return { cmd };
  }, calls);
  assert.deepEqual(await invoke('plugins_request', { op: 'installed' }), { cmd: 'plugins_request' });
  await invoke('plugin_call', { id: 'scheduler', command: 'view', args: {} });
  await assert.rejects(invoke('plugin_call', { id: 'github', command: 'status', args: null }), /isn’t on/);
  assert.deepEqual(calls, [
    { plugin: 'scheduler', command: 'view', ok: true, error: '' },
    { plugin: 'github', command: 'status', ok: false, error: '“github” isn’t on in Connect' },
  ]);

  const c = fakeConnect({ frames: { scheduler: { sections: [{ id: 'main' }] } } });
  const go = async hash => {
    await c.go(hash);
    calls.push({ plugin: 'scheduler', command: 'view', ok: true, error: '' });
  };
  const report = await runMarketSmoke({ ...c, go, calls, market: '/m', runId: 'run-5', ...quick });
  const scheduler = report.plugins.find(p => p.id === 'scheduler');
  assert.deepEqual(scheduler.frame.calls, [{ command: 'view', ok: true, error: '' }], 'what it asked before a page was open');
  assert.deepEqual(scheduler.views[0].calls, [{ command: 'view', ok: true, error: '' }]);
});

test('each plugin’s frame is made right after its install, before the manager has loaded it (review C-I1)', async () => {
  const c = fakeConnect({ loadsAfter: 4, frames: { scheduler: { sections: [{ id: 'main' }] }, github: { sections: [{ id: 'main' }] } } });
  let refreshes = 0;
  const refreshInstalled = async () => { refreshes++; c.calls.push(['refresh']); return c.refreshInstalled(); };
  const report = await runMarketSmoke({ ...c, refreshInstalled, market: '/m', runId: 'run-6', ...quick });
  // Install, then at once the installed list (the host makes the frame), then what the manager has.
  const steps = c.calls.filter(([cmd, a]) => cmd === 'refresh' || cmd === 'smoke_plugins_state' || a?.op === 'install')
    .map(([cmd, a]) => (a?.op === 'install' ? `install ${a.data.id}` : cmd));
  assert.deepEqual(steps.slice(0, 6), ['install scheduler', 'refresh', 'smoke_plugins_state', 'install github', 'refresh', 'smoke_plugins_state']);
  assert.ok(refreshes >= 5, `refreshed ${refreshes} times`);
  const by = Object.fromEntries(report.plugins.map(p => [p.id, p]));
  assert.equal(by.scheduler.framedBeforeLoad, true);
  assert.equal(by.github.framedBeforeLoad, true);
  assert.equal(by.obsidian.framedBeforeLoad, false, 'no frame was made for it');
  assert.equal(by.knowledge.framedBeforeLoad, false, 'never installed');
  assert.equal(report.error, null);
});

test('last, every ready frame is told a meeting shows, and what its call slots did is reported', async () => {
  const c = fakeConnect({ frames: { obsidian: { activities: [{ id: 'kb' }], errors: [] }, github: { sections: [{ id: 'main' }], errors: [] } } });
  const told = [];
  const smokeCalls = [];
  c.host.setCall = call => {
    told.push(call);
    if (!call) return;
    // As a frame does: Knowledge asks its host half, then reports an error; GitHub has no slots.
    smokeCalls.push({ plugin: 'obsidian', command: 'call_knowledge', ok: true, error: '' });
    c.host.status('obsidian');
  };
  c.host.callSlots = () => [{ plugin: 'obsidian', pluginName: 'Knowledge', call: SMOKE_CALL.name, header: ['Knowledge'], menu: ['Save to Knowledge…'], minutes: [] }];
  const report = await runMarketSmoke({ ...c, calls: smokeCalls, market: '/m', runId: 'run-9', ...quick });
  assert.deepEqual(told, [SMOKE_CALL, null], 'shown, then taken away');
  const by = Object.fromEntries(report.plugins.map(p => [p.id, p]));
  assert.deepEqual(by.obsidian.call, { errors: [], calls: [{ command: 'call_knowledge', ok: true, error: '' }], header: ['Knowledge'], menu: ['Save to Knowledge…'], minutes: [] });
  assert.deepEqual(by.github.call, { errors: [], calls: [], header: [], menu: [], minutes: [] });
  assert.equal(by.telegram.call, undefined, 'no frame, no meeting page');
});
