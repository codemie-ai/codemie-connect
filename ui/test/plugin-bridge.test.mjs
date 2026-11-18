// The plugin frame's shim and the main window's bridge (DESIGN 7.3), wired together over a real
// MessageChannel with stand-ins for the two windows and the synthetic `hello` plugin
// (ui/test/fixtures/plugins/hello/). DOM drawing itself is covered by the browser E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShim, startFrame, createStorage } from '../plugins/frame/shim.js';
import { checkFromFrame, checkFromWindow, V } from '../plugins/frame/messages.js';
import { esc, setRow, setCard, sw, relDay, ago } from '../plugins/frame/kit.js';
import { createPluginHost, internalRoute, openableUrl } from '../plugins/host.js';

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
    tag, innerHTML: '', hidden: false, style: {}, removed: false, attrs, children: [], listeners: {},
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] ?? null; },
    remove() { this.removed = true; },
    appendChild(child) { this.children.push(child); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    focus() {},
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
  const htmlAttrs = {};
  doc.documentElement = { classList: { add: c => classes.add(c), remove: (...c) => c.forEach(x => classes.delete(x)), contains: c => classes.has(c) }, style: {}, attrs: htmlAttrs, setAttribute(k, v) { htmlAttrs[k] = String(v); } };
  doc.body = element('body');
  // The frame's own address: a new hash is a `hashchange`, as in a browser; `replaceState`
  // changes it quietly. A fragment navigation (`replace`) would make WebKit tell the window the
  // frame loaded again, so the shim never uses one.
  const replaced = [];
  const moveTo = hash => {
    if (location.hash === hash) return;
    location.hash = hash;
    setTimeout(() => win.dispatchEvent(new Event('hashchange')), 0);
  };
  const location = { hash: '', replace() { throw new Error('a navigation'); } };
  win.location = location;
  win.history = { replaceState(state, title, url) { replaced.push(url); location.hash = url; } };
  win.moveTo = moveTo;
  doc.head = { appendChild: el => head.push(el) };
  doc.getElementById = id => els[id] || null;
  doc.createElement = tag => element(tag);
  doc.execCommand = () => false;
  return { win, doc, parent, els, head, classes, replaced };
}

/** A shim connected straight to a test port, its client half `apply`; `got` is what it posts. */
async function connected(apply, { theme = 'light', id = 'obsidian' } = {}) {
  const fw = frameWindow();
  const shim = shimOf(fw, { importClient: async () => ({ apply }) });
  const { port1, port2 } = new MessageChannel();
  const got = [];
  port1.onmessage = event => got.push(event.data);
  shim.onWindowMessage({
    source: fw.parent, ports: [port2],
    data: { v: V, id: 0, kind: 'event', type: 'connect', plugin: { id, name: 'Knowledge', version: '1.0.1', client: 'client.js' }, host: { name: 'CodeMie Connect' }, theme, where: { view: '', section: '', route: '' }, storage: {} },
  });
  await settle(30);
  const send = m => port1.postMessage({ v: V, id: 0, ...m });
  const where = { view: `${id}:knowledge`, section: '', route: '' };
  const show = route => send({ kind: 'event', type: 'show', target: { view: 'activity', activity: 'knowledge', route }, where: { ...where, route } });
  return { fw, shim, got, send, show, ctx: shim.ctx, events: () => got.filter(m => m.kind === 'event').map(({ v, id: _, kind, ...rest }) => rest) };
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
  const events = { go: [], goOpts: [], notices: [], copies: [], opens: [], changes: 0 };
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
    onGo: (hash, id, opts) => { events.go.push(hash); events.goOpts.push(opts); },
    onNotice: text => events.notices.push(text),
    onCopy: text => events.copies.push(text),
    onOpen: (url, name, id) => events.opens.push([url, name, id]),
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
  assert.equal(ctx.openEchoPanel, undefined, 'members Connect lacks are left out');
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
  assert.deepEqual(w.host.activities(), [{ id: 'home', label: 'Hello', badge: '', plugin: 'hello', pluginName: 'Hello' }]);
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

test('page errors reach the window through the bridge, once each', async () => {
  const w = await helloLoaded();
  const win = w.fw.win;
  // An uncaught error and an unhandled rejection in the frame, and a CSP refusal.
  win.dispatchEvent(Object.assign(new Event('error'), {
    message: 'TypeError: undefined is not an object', filename: 'connect-plugin://hello/client.js?v=1.0.0', lineno: 12,
  }));
  win.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('boom') }));
  win.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('boom') }));
  w.fw.doc.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), {
    blockedURI: 'https://evil.example.com/x.css', violatedDirective: 'style-src',
  }));
  // A page whose render throws, drawn twice.
  w.shim.ctx.activities.add({ id: 'broken', label: 'Broken', render: () => { throw new Error('no data yet'); } });
  w.host.show({ id: 'hello', view: 'activity', activity: 'broken', route: '' });
  await settle(30);
  w.shim.ctx.render();
  await settle(30);
  assert.match(w.fw.els['cx-main'].innerHTML, /class="error">no data yet/);
  const status = w.host.status('hello');
  assert.deepEqual(status.errors, [
    'TypeError: undefined is not an object (client.js:12)',
    'Unhandled rejection: boom',
    'CSP blocked https://evil.example.com/x.css (style-src)',
    'Page “broken”: no data yet',
  ]);
  assert.equal(status.error, 'Page “broken”: no data yet');
  // A frame that keeps failing reports 20 at most.
  for (let i = 0; i < 40; i++) win.dispatchEvent(Object.assign(new Event('error'), { message: `error ${i}` }));
  await settle(30);
  assert.equal(w.host.status('hello').errors.length, 20);
});

test('errors before the channel opens are reported once it does', async () => {
  const fw = frameWindow();
  const shim = shimOf(fw);
  fw.win.dispatchEvent(Object.assign(new Event('error'), { message: 'SyntaxError: early' }));
  const { port1, port2 } = new MessageChannel();
  const got = [];
  port1.onmessage = event => got.push(event.data);
  const connect = { v: V, id: 0, kind: 'event', type: 'connect', plugin: { id: 'hello', client: 'client.js' }, host: { name: 'X' }, theme: 'light', where: { view: '', section: '', route: '' }, storage: {} };
  shim.onWindowMessage({ source: fw.parent, data: connect, ports: [port2] });
  await settle(60);
  assert.ok(got.some(m => m.kind === 'event' && m.type === 'error' && m.message === 'SyntaxError: early'), JSON.stringify(got));
  port1.close();
});

test('a plugin whose host half did not load gets no frame', () => {
  const w = wired();
  w.host.sync([{ ...HELLO_INSTALLED, loadError: 'CodeMie Connect doesn’t have ctx.sessions (only Echo has it)' }]);
  assert.equal(w.frames.length, 0);
  assert.equal(w.host.status('hello'), null);
});

// ---------------------------------------------------------------- links (ruling R41)

/** A click on `el` in the frame, as the browser dispatches it (bubbling up to the window). */
function clickIn(fw, el) {
  const event = new Event('click', { cancelable: true });
  Object.defineProperty(event, 'target', { value: el });
  fw.win.dispatchEvent(event);
  return event;
}
const anchor = (href, resolved = href) => ({ href: resolved, getAttribute: k => (k === 'href' ? href : null), closest: sel => (sel === 'a[href]' ? anchor(href, resolved) : null) });

test('a link clicked in a plugin frame, or window.open, asks the window to open it', async () => {
  const w = await helloLoaded();
  w.host.show({ id: 'hello', view: 'activity', activity: 'home', route: '' });
  await settle(30);
  // The frame can't navigate or open windows: the click is kept from navigating it, and the
  // window hears the address.
  const click = clickIn(w.fw, anchor('https://github.com/login/device'));
  assert.equal(click.defaultPrevented, true);
  // A link inside a button-like span: the anchor around the target counts.
  clickIn(w.fw, { closest: sel => (sel === 'a[href]' ? anchor('obsidian://open?path=%2FVault%2Fa.md') : null) });
  assert.equal(w.fw.win.open('https://example.com/x'), null, 'window.open opens nothing in the frame');
  await settle(30);
  assert.deepEqual(w.events.opens, [
    ['https://github.com/login/device', 'Hello', 'hello'],
    ['obsidian://open?path=%2FVault%2Fa.md', 'Hello', 'hello'],
    ['https://example.com/x', 'Hello', 'hello'],
  ]);
  // A place on the plugin's own page is followed in the frame without a navigation (WebKit would
  // tell the window the frame loaded again); a link the plugin handled itself and a javascript:
  // "button" are left alone; nothing reaches the window.
  const local = clickIn(w.fw, anchor('#top', 'connect-plugin://hello/__host/frame.html#top'));
  assert.equal(local.defaultPrevented, true);
  assert.equal(w.fw.win.location.hash, '#top');
  const handled = new Event('click', { cancelable: true });
  Object.defineProperty(handled, 'target', { value: anchor('https://example.com/y') });
  handled.preventDefault();
  w.fw.win.dispatchEvent(handled);
  const script = clickIn(w.fw, anchor('javascript:void 0'));
  assert.equal(script.defaultPrevented, true, 'never run as navigation');
  await settle(30);
  assert.equal(w.events.opens.length, 3);
});

test('the window opens plugin links only from the frame on screen, and only https and obsidian', async () => {
  const w = await helloLoaded();
  const port = w.shim.state.port;
  const open = url => port.postMessage({ v: V, id: 0, kind: 'event', type: 'open', url });
  // Not on screen: a frame can't ask (it could forge the click), so nothing happens at all.
  open('https://github.com/login/device');
  await settle(30);
  assert.deepEqual(w.events.opens, []);
  assert.deepEqual(w.events.notices, []);
  // On screen: an allowed address is passed on for the user to confirm; anything else is refused
  // with a notice, and never passed on.
  w.host.show({ id: 'hello', view: 'section', section: 'main' });
  await settle(30);
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>alert(1)</script>', 'http://github.com/login/device', 'https://user:pw@github.com/', 'connect-plugin://hello/x', 'tauri://localhost/']) open(bad);
  open('https://github.com/login/device');
  await settle(30);
  assert.deepEqual(w.events.opens, [['https://github.com/login/device', 'Hello', 'hello']]);
  assert.equal(w.events.notices.length, 7);
  assert.ok(w.events.notices.every(n => n === 'Connect opens only https:// and obsidian:// links.'), w.events.notices.join(' | '));
});

test('only https and obsidian addresses are openable', () => {
  assert.equal(openableUrl('https://github.com/login/device'), 'https://github.com/login/device');
  assert.equal(openableUrl('HTTPS://GitHub.com/a b'), 'https://github.com/a%20b');
  assert.equal(openableUrl('obsidian://open?path=%2FUsers%2Fme%2FVault%2Fa.md'), 'obsidian://open?path=%2FUsers%2Fme%2FVault%2Fa.md');
  for (const bad of [
    'javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'http://github.com/',
    'https://user:pw@github.com/', 'https://user@github.com/', 'blob:https://github.com/x', 'vbscript:x', 'tauri://localhost/', 'connect-plugin://hello/x',
    'github.com/login', '/relative', '', null, undefined, 42, `https://github.com/${'x'.repeat(2000)}`, 'https://github.com/\u0000x',
  ]) assert.equal(openableUrl(bad), null, String(bad));
});

test('an open message carries one address of at most 2000 characters', () => {
  const ok = { v: V, id: 0, kind: 'event', type: 'open', url: 'https://github.com/login/device' };
  assert.ok(checkFromFrame(ok));
  for (const bad of [{ ...ok, url: '' }, { ...ok, url: 42 }, { ...ok, url: 'x'.repeat(2001) }, { ...ok, plugin: 'other' }, { ...ok, target: '_blank' }]) {
    assert.equal(checkFromFrame(bad), null, JSON.stringify(bad).slice(0, 80));
  }
});

// ---------------------------------------------------------------- Echo 0.10's client members (Knowledge)

test('slots_take_echos_names_and_file_drops_register', async () => {
  const { ctx, shim } = await connected(() => {});
  ctx.slots.add('call.header', { id: 'chip', render: () => 'x' });
  for (const name of ['call.menu', 'call.minutes', 'thread.profile', 'client.profile']) ctx.slots.add(name, { id: 'a', render: () => '' });
  assert.throws(() => ctx.slots.add('nope', {}), /CodeMie Connect has no slot “nope”/);
  assert.deepEqual(ctx.slots.list(), [], 'no slot is drawn yet');
  const dropped = () => {};
  ctx.onFileDrop(dropped);
  assert.deepEqual(shim.state.drops, [dropped]);
  assert.throws(() => ctx.onFileDrop('x'), /needs a function/);
});

test('a_sheet_is_one_modal_whose_close_is_told_once', async () => {
  const { ctx, fw, shim } = await connected(() => {});
  let closed = 0;
  const box = ctx.ui.sheet('<p>Save the minutes</p>', { label: 'Save', onClose: () => { closed++; } });
  assert.equal(box.innerHTML, '<p>Save the minutes</p>');
  assert.equal(box.attrs.role, 'dialog');
  assert.equal(box.attrs['aria-modal'], 'true');
  assert.equal(box.attrs['aria-label'], 'Save');
  const scrim = fw.doc.body.children.at(-1);
  assert.equal(scrim.className, 'td-modal plug-scrim');
  assert.equal(scrim.children[0], box);
  // Opened again while open: the same box, drawn anew.
  assert.equal(ctx.ui.sheet('<p>Step 2</p>', { label: 'Save', onClose: () => { closed++; } }), box);
  assert.equal(box.innerHTML, '<p>Step 2</p>');
  // Esc closes it and tells onClose, once.
  fw.doc.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
  fw.doc.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
  assert.equal(closed, 1);
  assert.equal(scrim.removed, true);
  assert.equal(shim.state.sheet, null);
  // A click on the scrim closes it; one inside it doesn't.
  const again = ctx.ui.sheet('<p>x</p>', { onClose: () => { closed++; } });
  const scrim2 = fw.doc.body.children.at(-1);
  scrim2.listeners.click({ target: again });
  assert.equal(closed, 1);
  scrim2.listeners.click({ target: scrim2 });
  assert.equal(closed, 2);
  // closeSheet(), the plugin's own close, tells nobody.
  ctx.ui.sheet('<p>y</p>', { onClose: () => { closed++; } });
  ctx.ui.closeSheet();
  assert.equal(closed, 2);
  assert.equal(shim.state.sheet, null);
});

test('show_mirrors_the_route_into_the_frames_hash_before_drawing', async () => {
  const seen = [];
  const t = await connected(ctx => {
    ctx.activities.add({ id: 'knowledge', label: 'Knowledge', render: () => { seen.push(globalThis.__frameHash()); return `<b>${globalThis.__frameHash()}</b>`; } });
  });
  globalThis.__frameHash = () => t.fw.win.location.hash;
  t.show('v/pages/People%2FAnn.md');
  await settle(30);
  assert.equal(seen.at(-1), '#obsidian:knowledge/v/pages/People%2FAnn.md');
  assert.deepEqual(t.fw.replaced, ['#obsidian:knowledge/v/pages/People%2FAnn.md'], 'replaced: no history entry');
  assert.equal(t.fw.els['cx-main'].innerHTML, '<b>#obsidian:knowledge/v/pages/People%2FAnn.md</b>');
  // Its own mirroring isn't sent back as `go`.
  assert.deepEqual(t.events().filter(e => e.type === 'go'), []);
  // A page's hash the plugin moves the frame to itself goes to the window, and is drawn.
  t.fw.win.moveTo('#obsidian:knowledge/v/graph');
  await settle(30);
  assert.deepEqual(t.events().filter(e => e.type === 'go'), [{ type: 'go', hash: '#obsidian:knowledge/v/graph', replace: true }]);
  assert.equal(seen.at(-1), '#obsidian:knowledge/v/graph');
  // The same route shown again changes nothing.
  t.show('v/graph');
  await settle(30);
  assert.equal(t.fw.replaced.length, 1);
  // A `#<plugin>:…` link clicked in the page is followed without a navigation.
  const link = { getAttribute: () => '#obsidian:knowledge/v/pages/Atlas.md', href: 'x', closest: () => link };
  const click = Object.assign(new Event('click', { cancelable: true }), {});
  Object.defineProperty(click, 'target', { value: link });
  t.fw.win.dispatchEvent(click);
  await settle(30);
  assert.equal(click.defaultPrevented, true);
  assert.equal(t.fw.replaced.at(-1), '#obsidian:knowledge/v/pages/Atlas.md');
  assert.deepEqual(t.events().filter(e => e.type === 'go').at(-1), { type: 'go', hash: '#obsidian:knowledge/v/pages/Atlas.md', replace: true });
  assert.equal(seen.at(-1), '#obsidian:knowledge/v/pages/Atlas.md');
  // A place on the page isn't a route: nothing goes to the window.
  const before = t.events().filter(e => e.type === 'go').length;
  t.fw.win.moveTo('#notes');
  await settle(30);
  assert.equal(t.events().filter(e => e.type === 'go').length, before);
  delete globalThis.__frameHash;
});

test('a_new_channel_from_the_window_takes_over_without_a_reload', async () => {
  const t = await connected(ctx => { ctx.activities.add({ id: 'knowledge', label: 'K', render: () => '<p>k</p>' }); });
  const pending = t.ctx.call('kn', {});
  const { port1, port2 } = new MessageChannel();
  const got = [];
  port1.onmessage = event => got.push(event.data);
  // Only Connect's window may hand it one.
  const data = { v: V, id: 0, kind: 'event', type: 'connect', plugin: { id: 'obsidian', client: 'client.js' }, host: { name: 'CodeMie Connect' }, theme: 'dark', where: { view: '', section: '', route: '' }, storage: {} };
  t.shim.onWindowMessage({ source: { name: 'another frame' }, data, ports: [port2] });
  await settle(20);
  assert.deepEqual(got, []);
  t.shim.onWindowMessage({ source: t.fw.parent, data, ports: [port2] });
  await assert.rejects(pending, /try again/);
  await settle(30);
  assert.ok(got.some(m => m.kind === 'event' && m.type === 'ready'), 'told the window it is ready');
  assert.ok(got.some(m => m.kind === 'contribution' && m.activities[0].id === 'knowledge'), 'and what it adds');
  assert.equal(t.fw.doc.documentElement.attrs['data-theme'], 'dark');
  port1.close();
});

test('go_keeps_replace_and_theme_sets_data_theme', async () => {
  const t = await connected(ctx => { ctx.activities.add({ id: 'knowledge', label: 'K', render: () => '' }); }, { theme: 'dark' });
  assert.equal(t.fw.doc.documentElement.attrs['data-theme'], 'dark');
  t.send({ kind: 'event', type: 'theme', theme: 'light' });
  await settle(20);
  assert.equal(t.fw.doc.documentElement.attrs['data-theme'], 'light');
  t.ctx.go('#obsidian:knowledge/v/health', { replace: true });
  t.ctx.go('#obsidian:knowledge/v/home');
  await settle(20);
  assert.deepEqual(t.events().filter(e => e.type === 'go'), [
    { type: 'go', hash: '#obsidian:knowledge/v/health', replace: true },
    { type: 'go', hash: '#obsidian:knowledge/v/home', replace: false },
  ]);
  // The window's side passes `replace` on, for the frame on screen.
  const w = await helloLoaded();
  w.host.show({ id: 'hello', view: 'activity', activity: 'home', route: '' });
  await settle(20);
  w.shim.ctx.go('home/x', { replace: true });
  w.shim.ctx.go('home/y');
  await settle(30);
  assert.deepEqual(w.events.go, ['#/p/hello/home/x', '#/p/hello/home/y']);
  assert.deepEqual(w.events.goOpts, [{ replace: true }, { replace: false }]);
  assert.equal(checkFromFrame({ v: V, id: 0, kind: 'event', type: 'go', hash: 'x', replace: 'yes' }), null);
  assert.ok(checkFromFrame({ v: V, id: 0, kind: 'event', type: 'go', hash: 'x', replace: true }));
  assert.ok(checkFromFrame({ v: V, id: 0, kind: 'event', type: 'go', hash: 'x' }));
});

test('a_page_being_typed_in_is_left_alone_and_its_badge_reaches_the_window', async () => {
  let editing = true;
  let count = 3;
  const t = await connected(ctx => {
    ctx.activities.add({ id: 'knowledge', label: 'K', render: () => `<p>${count}</p>`, editing: () => editing, badge: () => count });
  });
  t.show('');
  await settle(30);
  assert.equal(t.fw.els['cx-main'].innerHTML, '', 'held while editing()');
  editing = false;
  t.ctx.render();
  await settle(30);
  assert.equal(t.fw.els['cx-main'].innerHTML, '<p>3</p>');
  const last = () => t.got.filter(m => m.kind === 'contribution').at(-1);
  assert.deepEqual(last().activities, [{ id: 'knowledge', label: 'K', badge: '3' }]);
  count = 150;
  t.ctx.render();
  await settle(30);
  assert.equal(last().activities[0].badge, '99+');
  assert.ok(checkFromFrame(last()), 'the window takes it');
});

test('reveal_and_dropped_files_reach_only_the_page_on_screen', async () => {
  const w = await helloLoaded();
  const dropped = [];
  w.shim.ctx.onFileDrop(files => dropped.push(files));
  // Not on screen: no reveal, no files.
  await assert.rejects(w.shim.ctx.system.reveal('/v', 'a.md'), /page on screen/);
  assert.equal(w.host.dropFiles('hello', [{ file: 'h1', name: 'a.pdf', size: 3 }]), false);
  w.host.show({ id: 'hello', view: 'activity', activity: 'home', route: '' });
  await settle(20);
  const answer = await w.shim.ctx.system.reveal('/Users/taylor/Vault', 'notes/a.md');
  assert.ok(answer);
  const asked = w.calls.filter(([cmd, a]) => cmd === 'plugins_request' && a.op === 'frame_reveal');
  assert.deepEqual(asked.at(-1)[1].data, { id: 'hello', root: '/Users/taylor/Vault', path: 'notes/a.md' }, 'the id is the frame’s own');
  // Only on the user's click.
  w.fw.win.navigator.userActivation.isActive = false;
  await assert.rejects(w.shim.ctx.system.reveal('/v', ''), /your click/);
  w.fw.win.navigator.userActivation.isActive = true;
  // Dropped while its page shows: the handles, nothing else.
  assert.equal(w.host.dropFiles('hello', [{ file: 'h1', name: 'Brief.pdf', size: 12, path: '/Users/taylor/Brief.pdf' }]), true);
  await settle(20);
  assert.deepEqual(dropped, [[{ file: 'h1', name: 'Brief.pdf', size: 12 }]]);
  // The schema keeps the window from sending anything else.
  assert.equal(checkFromWindow({ v: V, id: 0, kind: 'event', type: 'files', files: [{ file: 'h', name: 'x', size: 1, path: '/x' }] }), null);
  assert.equal(checkFromFrame({ v: V, id: 3, kind: 'call', method: 'reveal', root: '', path: 'x' }), null);
  // A Settings section of the same plugin isn't a page files are dropped on.
  w.host.show({ id: 'hello', view: 'section', section: 'main' });
  await settle(20);
  assert.equal(w.host.dropFiles('hello', [{ file: 'h2', name: 'b', size: 1 }]), false);
});

test('files_handed_to_the_page_go_with_a_call_by_their_ids', async () => {
  const w = await helloLoaded();
  await w.shim.ctx.call('source_add', { kind: 'files' }, { files: [{ file: 'h1', name: 'a.pdf', size: 1 }, 'h2'] });
  await w.shim.ctx.call('greet', {});
  const sent = w.calls.filter(([cmd]) => cmd === 'plugin_call').map(([, a]) => a);
  assert.deepEqual(sent.at(-2), { id: 'hello', command: 'source_add', args: { kind: 'files' }, files: ['h1', 'h2'] });
  assert.deepEqual(sent.at(-1), { id: 'hello', command: 'greet', args: {} }, 'no files: none sent');
  assert.equal(checkFromFrame({ v: V, id: 9, kind: 'call', method: 'command', command: 'x', args: {}, files: [{ file: 'h1' }] }), null);
});

test('a_claude_code_session_is_asked_for_only_by_the_page_on_screen_on_a_click', async () => {
  const w = await helloLoaded();
  const sessions = () => w.calls.filter(([cmd, a]) => cmd === 'plugins_request' && a.op === 'frame_session').map(([, a]) => a.data);
  // Not on screen: told as a notice, nothing reaches native.
  assert.equal(await w.shim.ctx.claude.session({ folder: '/Users/taylor/Vault' }), null);
  assert.deepEqual(sessions(), []);
  w.host.show({ id: 'hello', view: 'activity', activity: 'home', route: '' });
  await settle(20);
  await w.shim.ctx.claude.session({ folder: '/Users/taylor/Vault', profile: 'codemie:prod', mode: 'yolo' });
  assert.deepEqual(sessions(), [{ id: 'hello', folder: '/Users/taylor/Vault', path: '', mode: '', profile: 'codemie:prod' }]);
  w.fw.win.navigator.userActivation.isActive = false;
  assert.throws(() => w.shim.ctx.claude.session({ folder: '/v' }), /your click/);
  w.fw.win.navigator.userActivation.isActive = true;
  assert.equal(checkFromFrame({ v: V, id: 4, kind: 'call', method: 'session', folder: '/v', path: '', mode: 'admin', profile: '' }), null);
});
