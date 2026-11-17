// The plugin frame's shim and the main window's bridge (DESIGN 7.3), wired together over a real
// MessageChannel with stand-ins for the two windows and the synthetic `hello` plugin
// (ui/test/fixtures/plugins/hello/). DOM drawing itself is covered by the browser E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShim, startFrame, createStorage } from '../plugins/frame/shim.js';
import { checkFromFrame, checkFromWindow, V } from '../plugins/frame/messages.js';
import { esc, setRow, setCard, sw, relDay, ago } from '../plugins/frame/kit.js';
import { createPluginHost, internalRoute } from '../plugins/host.js';

const HELLO = new URL('./fixtures/plugins/hello/', import.meta.url);
const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

// Every channel a test opens is closed after it, so the open ports don't keep node running.
const opened = [];
const RealChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends RealChannel {
  constructor() {
    super();
    opened.push(this.port1, this.port2);
  }
};
test.afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

function element(tag = 'div') {
  const attrs = {};
  return {
    tag, innerHTML: '', hidden: false, style: {}, removed: false, attrs,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] ?? null; },
    remove() { this.removed = true; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 120, width: 600, height: 120 }),
  };
}

/** A plugin frame's window and document, enough for the shim. */
function frameWindow() {
  const parent = { name: 'connect-window' };
  const win = new EventTarget();
  win.parent = parent;
  win.navigator = { userActivation: { isActive: true } };
  const els = { 'cx-main': element('main'), 'cx-panel': element('aside'), 'cx-root': element() };
  const head = [];
  const doc = new EventTarget();
  const classes = new Set();
  doc.documentElement = { classList: { add: c => classes.add(c), remove: (...c) => c.forEach(x => classes.delete(x)), contains: c => classes.has(c) }, style: {} };
  doc.body = element('body');
  doc.body.appendChild = () => {};
  doc.head = { appendChild: el => head.push(el) };
  doc.getElementById = id => els[id] || null;
  doc.createElement = tag => element(tag);
  doc.execCommand = () => false;
  return { win, doc, parent, els, head, classes };
}

function shimOf(fw, extra = {}) {
  return createShim({
    win: fw.win, doc: fw.doc,
    importClient: path => import(new URL(path, HELLO).href),
    patch: (el, html) => { el.innerHTML = html; },
    timers: { set: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clear: clearTimeout },
    ...extra,
  });
}

/** The window's bridge over a stand-in document whose iframes hand their messages to a shim. */
function wired({ invoke } = {}) {
  const calls = [];
  const fw = frameWindow();
  let shim = null;
  const frames = [];
  const doc = {
    createElement(tag) {
      if (tag !== 'iframe') return { ...element(tag), appendChild() {} };
      const el = element('iframe');
      const listeners = {};
      el.addEventListener = (type, fn) => { listeners[type] = fn; };
      el.load = () => {
        shim = shimOf(fw);
        el.shim = shim;
        listeners.load?.();
      };
      el.contentWindow = {
        postMessage: (data, origin, ports) => {
          assert.equal(origin, '*', 'an opaque frame is reached with "*" and its own port');
          shim.onWindowMessage({ source: fw.parent, data, ports });
        },
      };
      frames.push(el);
      return el;
    },
    querySelector: () => null,
    addEventListener() {},
  };
  const events = { go: [], notices: [], copies: [], changes: 0 };
  const host = createPluginHost({
    invoke: invoke || (async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'plugin_call') return { text: `Hello, ${args.args?.name || 'you'}` };
      if (cmd === 'plugins_request' && args.data.items) return { items: args.data.items };
      if (cmd === 'plugins_request') return { items: { remembered: 'yes' } };
      throw new Error(`unexpected ${cmd}`);
    }),
    frameUrl: (id, path) => `connect-plugin://${id}/${path}`,
    doc,
    win: { addEventListener() {}, setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0) },
    about: () => ({ name: 'CodeMie Connect', version: '2.2.0', engine: '1.0' }),
    theme: () => 'dark',
    onChange: () => { events.changes++; },
    onGo: hash => events.go.push(hash),
    onNotice: text => events.notices.push(text),
    onCopy: text => events.copies.push(text),
  });
  host.mount({ appendChild() {} });
  return { host, calls, fw, frames, events, get shim() { return shim; } };
}

const HELLO_INSTALLED = { id: 'hello', name: 'Hello', version: '1.0.0', hash: 'abc', enabled: true, client: 'client.js', problem: null };

async function helloLoaded() {
  const w = wired();
  w.host.sync([HELLO_INSTALLED, { ...HELLO_INSTALLED, id: 'no-client', client: null }, { ...HELLO_INSTALLED, id: 'off', enabled: false }]);
  assert.equal(w.frames.length, 1, 'one frame, for the enabled plugin with a client half');
  const el = w.frames[0];
  assert.equal(el.attrs.sandbox, 'allow-scripts');
  assert.match(el.src, /^connect-plugin:\/\/hello\/__host\/frame\.html\?v=/);
  el.load();
  await settle(60);
  return Object.assign(w, { el });
}

test('frame_ctx_call_round_trips_and_rejects_unknown_source', async () => {
  // A connect from anything but Connect's window is ignored; so is one without a port.
  const fw = frameWindow();
  const shim = shimOf(fw);
  const { port1, port2 } = new MessageChannel();
  const connect = { v: V, id: 0, kind: 'event', type: 'connect', plugin: { id: 'hello', client: 'client.js' }, host: { name: 'X' }, theme: 'light', where: { view: '', section: '', route: '' }, storage: {} };
  shim.onWindowMessage({ source: { name: 'another frame' }, data: connect, ports: [port2] });
  shim.onWindowMessage({ source: fw.parent, data: connect, ports: [] });
  shim.onWindowMessage({ source: fw.parent, data: { ...connect, extra: 1 }, ports: [port2] });
  assert.equal(shim.ctx, null, 'no ctx: the client half never ran');
  port1.close();

  // Through the bridge: ctx.call reaches plugin_call with the frame's own id, and answers.
  const w = await helloLoaded();
  const ctx = w.shim.ctx;
  assert.equal(ctx.id, 'hello');
  assert.deepEqual(ctx.host, { name: 'CodeMie Connect', version: '2.2.0', engine: '1.0' });
  assert.equal(ctx.slots, undefined, 'members Connect lacks are left out');
  assert.equal(ctx.openEchoPanel, undefined);
  const answer = await ctx.call('greet', { name: 'Ana' });
  assert.deepEqual(answer, { text: 'Hello, Ana' });
  const sent = w.calls.find(([cmd]) => cmd === 'plugin_call');
  assert.deepEqual(sent[1], { id: 'hello', command: 'greet', args: { name: 'Ana' } });

  // A message naming another plugin, or out of schema, is dropped; nothing more reaches native.
  const before = w.calls.length;
  const port = w.shim.state.port;
  port.postMessage({ v: V, id: 77, kind: 'call', method: 'command', command: 'greet', args: {}, plugin: 'other' });
  port.postMessage({ v: 2, id: 78, kind: 'call', method: 'command', command: 'greet', args: {} });
  port.postMessage({ v: V, id: 79, kind: 'call', method: 'invoke', command: 'storage_status', args: {} });
  port.postMessage({ v: V, id: 80, kind: 'event', type: 'go', hash: 'https://example.com' });
  await settle(30);
  assert.equal(w.calls.length, before, 'no native call for a dropped message');
  assert.deepEqual(w.events.go, []);

  // The connect message carried only the plugin's own facts, the theme and where the window is.
  assert.equal(w.fw.classes.has('dark'), true);
  const failing = wired({ invoke: async () => { throw Object.assign(new Error('“hello” isn’t on in Connect'), { code: 'not_found', secret: 'x' }); } });
  failing.host.sync([HELLO_INSTALLED]);
  failing.frames[0].load();
  await settle(60);
  await assert.rejects(failing.shim.ctx.call('greet'), e => e.code === 'not_found' && e.message === '“hello” isn’t on in Connect' && !('secret' in e));
});

test('settings_section_and_palette_contributions_reach_main', async () => {
  const w = await helloLoaded();
  assert.deepEqual(w.host.activities(), [{ id: 'home', label: 'Hello', plugin: 'hello', pluginName: 'Hello' }]);
  assert.deepEqual(w.host.sections(), [{ id: 'main', label: 'Hello', badge: '', plugin: 'hello', pluginName: 'Hello' }]);
  const status = w.host.status('hello');
  assert.equal(status.ready, true);
  assert.equal(status.card, true);
  assert.deepEqual(status.palette, [{ label: 'Hello: open', keywords: 'hello greet' }]);
  assert.deepEqual(status.widgets, ['board']);

  // Shown as a Settings section: the frame draws it and says where it is.
  w.host.show({ id: 'hello', view: 'section', section: 'main' });
  await settle(30);
  assert.match(w.fw.els['cx-main'].innerHTML, /Hello settings/);
  assert.deepEqual(w.shim.ctx.where(), { view: 'settings', section: 'hello:main', route: '' });

  // A frame not on screen can't lead the window.
  w.host.show(null);
  w.shim.ctx.go('today');
  await settle(30);
  assert.deepEqual(w.events.go, []);

  // A palette entry runs in the frame; its go reaches the window as an internal route.
  w.host.runPalette('hello', 0);
  await settle(30);
  assert.deepEqual(w.events.go, ['#/p/hello/home']);

  // A page widget is drawn in the frame; the window gets its HTML to show as text.
  const html = await w.host.draw('hello', 'board', { text: '<img src=x onerror=alert(1)>' });
  assert.equal(html, '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
});

test('local_storage_shim_persists_through_plugin_store', async () => {
  const w = await helloLoaded();
  const storage = w.fw.win.localStorage;
  assert.equal(storage.getItem('remembered'), 'yes', 'preloaded from the plugin store');
  storage.setItem('tab', 3);
  storage.setItem('view', 'graph');
  storage.removeItem('remembered');
  assert.equal(storage.length, 2);
  assert.equal(storage.getItem('tab'), '3');
  await settle(60);
  const writes = w.calls.filter(([cmd, a]) => cmd === 'plugins_request' && a.data.items);
  assert.equal(writes.length, 1, 'writes are saved together');
  assert.deepEqual(writes[0][1], { op: 'client_storage', data: { id: 'hello', items: { tab: '3', view: 'graph' } } });
  assert.equal(w.fw.win.sessionStorage.getItem('x'), null, 'sessionStorage works too, in memory');

  const changes = [];
  const small = createStorage({ a: '1', n: 2 }, all => changes.push(all), 40);
  assert.equal(small.getItem('n'), null, 'only text is kept');
  assert.throws(() => small.setItem('big', 'x'.repeat(50)), e => e.name === 'QuotaExceededError');
  assert.equal(small.getItem('big'), null);
  small.setItem('a', '1');
  assert.deepEqual(changes, [], 'an unchanged value saves nothing');
  small.clear();
  assert.deepEqual(changes, [{}]);
});

test('listenWindow_and_onUnload_cleanup_on_disable', async () => {
  const w = await helloLoaded();
  const ctx = w.shim.ctx;
  let clicks = 0;
  let resizes = 0;
  let cleaned = 0;
  ctx.listen('ping', () => { clicks++; });
  ctx.listenWindow('resize', () => { resizes++; });
  ctx.onUnload(() => { cleaned++; });
  const style = w.fw.head.find(el => el.tag === 'style');
  assert.ok(style, 'ctx.ui.style added a <style>');
  w.fw.doc.dispatchEvent(new Event('ping'));
  w.fw.win.dispatchEvent(new Event('resize'));
  assert.deepEqual([clicks, resizes], [1, 1]);

  w.host.show({ id: 'hello', view: 'activity', activity: 'home', route: 'x' });
  await settle(30);
  assert.match(w.fw.els['cx-main'].innerHTML, /Hello page/);

  // Turned off: the frame is told to unload, then taken away; its page leaves the sidebar.
  w.host.sync([{ ...HELLO_INSTALLED, enabled: false }]);
  await settle(80);
  assert.equal(cleaned, 1, 'onUnload ran');
  w.fw.doc.dispatchEvent(new Event('ping'));
  w.fw.win.dispatchEvent(new Event('resize'));
  assert.deepEqual([clicks, resizes], [1, 1], 'its listeners are gone');
  assert.equal(style.removed, true, 'its styles are gone');
  assert.equal(w.el.removed, true, 'its frame is gone');
  assert.deepEqual(w.host.activities(), []);
  assert.equal(w.host.status('hello'), null);
  assert.equal(w.host.shown(), null);
  await assert.rejects(ctx.call('greet'), /off/);
});

test('ui_helpers_escape_text', () => {
  const hostile = '<img src=x onerror="alert(1)">&\'';
  assert.equal(esc(hostile), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
  assert.equal(esc(null), '');
  assert.equal(setCard(hostile, ['<div>row</div>']), '<section class="set-sec"><h3>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;</h3><div class="set-card"><div>row</div></div></section>');
  assert.match(setRow('<b>Title</b>', 'Sub', '<button>x</button>', 'id"x', 'Na"me'), /id="set-id&quot;x" role="group" aria-label="Na&quot;me"/);
  assert.equal(sw('k"x', true, 'L<b>'), '<button type="button" class="sw on" role="switch" aria-checked="true" aria-label="L&lt;b&gt;" data-set="k&quot;x" data-val="false"></button>');
  const now = new Date('2026-11-17T12:00:00');
  assert.equal(relDay('2026-11-17', now), 'today');
  assert.equal(relDay('2026-11-16', now), 'yesterday');
  assert.equal(relDay('2026-11-03', now), '3 Nov');
  assert.equal(relDay('2025-11-03', now), '3 Nov 2025');
  assert.equal(ago(new Date(now.getTime() - 30_000).toISOString(), now.getTime()), '30 s ago');
  assert.equal(ago(new Date(now.getTime() - 5 * 60_000).toISOString(), now.getTime()), '5 min ago');
  assert.equal(ago(new Date(now.getTime() - 3 * 3600_000).toISOString(), now.getTime()), '3 h ago');
});

test('the shim refuses to run plugin code outside a frame', () => {
  const fw = frameWindow();
  fw.win.parent = fw.win;
  assert.equal(startFrame({ win: fw.win, doc: fw.doc, importClient: () => { throw new Error('never'); } }), null);
  const framed = frameWindow();
  assert.ok(startFrame({ win: framed.win, doc: framed.doc, importClient: () => ({}) }));
});

test('a frame that loads again gets a new channel, and the old one goes deaf', async () => {
  const w = await helloLoaded();
  const oldPort = w.shim.state.port;
  w.el.load();
  await settle(60);
  const before = w.calls.length;
  oldPort.postMessage({ v: V, id: 9, kind: 'call', method: 'command', command: 'greet', args: {} });
  await settle(30);
  assert.equal(w.calls.length, before, 'the previous load’s port is closed');
  assert.deepEqual(await w.shim.ctx.call('greet', {}), { text: 'Hello, you' });
});

test('go leads only to internal routes', () => {
  assert.equal(internalRoute('hello', 'hello:home'), '#/p/hello/home');
  assert.equal(internalRoute('hello', 'obsidian:vaults/v1/a%2Fb.md'), '#/p/obsidian/vaults/v1/a%2Fb.md');
  assert.equal(internalRoute('hello', 'home/sub'), '#/p/hello/home/sub');
  assert.equal(internalRoute('hello', 'settings/telegram:main'), '#/settings/plugins/telegram/main');
  assert.equal(internalRoute('hello', '#settings/plugins'), '#/settings/plugins');
  assert.equal(internalRoute('hello', 'today'), '#/today');
  for (const bad of ['https://evil.example', 'javascript:alert(1)', 'settings/../x', 'settings/Evil:main', '', 'a\nb', 'x'.repeat(700), 'file:///etc/passwd']) {
    assert.equal(internalRoute('hello', bad), null, bad);
  }
});

test('the schema takes only the messages it names', () => {
  const ok = { v: V, id: 1, kind: 'call', method: 'command', command: 'greet', args: { a: 1 } };
  assert.ok(checkFromFrame(ok));
  for (const bad of [
    null, 'x', [], { ...ok, v: 0 }, { ...ok, id: -1 }, { ...ok, id: 1.5 }, { ...ok, kind: 'invoke' }, { ...ok, command: '' },
    { ...ok, extra: true }, { ...ok, method: 'eval' }, { v: V, id: 1, kind: 'event', type: 'go', hash: 1 },
    { v: V, id: 1, kind: 'event', type: 'height', px: -4 },
    { v: V, id: 1, kind: 'contribution', activities: [{ id: '../x', label: 'x' }], sections: [], card: false, panels: [], palette: [], widgets: [] },
    { v: V, id: 1, kind: 'contribution', activities: [{ id: 'x', label: '' }], sections: [], card: false, panels: [], palette: [], widgets: [] },
    { v: V, id: 1, kind: 'call', method: 'storage', items: { a: 1 } },
  ]) assert.equal(checkFromFrame(bad), null, JSON.stringify(bad));
  assert.equal(checkFromWindow({ v: V, id: 0, kind: 'event', type: 'theme', theme: 'neon' }), null);
  assert.ok(checkFromWindow({ v: V, id: 0, kind: 'event', type: 'theme', theme: 'dark' }));
});
