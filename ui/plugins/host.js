// The main window's side of plugin UIs (DESIGN 7.3): one sandboxed frame per enabled plugin with a
// client half, laid over the part of the page its route shows, and the channel each frame talks
// through.
//
// What keeps a frame's code away from Connect (the Task 17 gate conditions):
// - Each frame is `<iframe sandbox="allow-scripts">` with a `src` on the plugin's own
//   connect-plugin:// origin: never `srcdoc`, never `allow-same-origin`, `allow-top-navigation*`,
//   `allow-popups` or `allow-forms`. Its origin is opaque.
// - The window listens to no `message` event from frames. On every `load` of a frame it makes a
//   new MessageChannel and hands one port to that frame's window only (the old one is closed), so
//   a message on a frame's port can only come from the document loaded in that frame.
// - Every message is checked against the schema (frame/messages.js); others are dropped.
// - The plugin id is the frame's: it is bound to the port when the frame is made and never read
//   from a message. `plugin_call` and `plugins_request` go out with that id.
// - Nothing derived from the invoke key or `__TAURI_INTERNALS__` is sent to a frame: only the
//   plugin's own facts, Connect's name and version, the theme, where the window is, its stored
//   values, and command answers.
// - `go` reaches internal routes only (`internalRoute`), and only from the frame on screen.
import { V, checkFromFrame, errorOf } from './frame/messages.js';

const SANDBOX = 'allow-scripts';
const DRAW_TIMEOUT_MS = 5000;
/** A frame not on screen may still navigate this long after the window ran its palette entry. */
const PALETTE_GRACE_MS = 3000;
const EMPTY = Object.freeze({ activities: [], sections: [], card: false, panels: [], palette: [], widgets: [] });
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,40}$/;
const ITEM_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
/** The most page errors kept for one frame. */
const MAX_ERRORS = 20;
const TOP_ROUTES = ['today', 'calendar', 'inbox', 'automations'];

/**
 * Where a plugin's `ctx.go(hash)` leads, as a Connect hash, or null when it isn't an internal
 * route: Connect's own pages, Settings → Plugins, a plugin's Settings section
 * (`settings/<plugin>:<section>`), a plugin's page (`<plugin>:<activity>[/<route>]`), or a route
 * of the plugin's own pages (`<activity>[/<route>]`).
 */
export function internalRoute(plugin, hash) {
  const h = String(hash ?? '').trim().replace(/^#\/?/, '');
  if (!h || h.length > 600 || /[\u0000-\u001f\u007f\\]/.test(h) || /^[a-z][a-z0-9+.-]*:\/\//i.test(h)) return null;
  if (TOP_ROUTES.includes(h)) return `#/${h}`;
  if (h === 'settings' || h === 'settings/plugins') return '#/settings/plugins';
  const section = /^settings\/([a-z][a-z0-9-]{1,40}):([a-z0-9][a-z0-9_.-]{0,63})$/i.exec(h);
  if (section && PLUGIN_ID.test(section[1])) return `#/settings/plugins/${section[1]}/${section[2]}`;
  if (h.startsWith('settings')) return null;
  const page = /^([a-z][a-z0-9-]{1,40}):([a-z0-9][a-z0-9_.-]{0,63})(?:\/(.*))?$/i.exec(h);
  if (page && PLUGIN_ID.test(page[1])) return `#/p/${page[1]}/${page[2]}${page[3] ? `/${page[3]}` : ''}`;
  const own = /^([a-z0-9][a-z0-9_.-]{0,63})(?:\/(.*))?$/i.exec(h);
  if (own && PLUGIN_ID.test(plugin)) return `#/p/${plugin}/${own[1]}${own[2] ? `/${own[2]}` : ''}`;
  return null;
}

/**
 * What a plugin's link may open (ruling R41): an `https:` address without a user name or password,
 * or an `obsidian:` one, as its normalized text; null for anything else (`javascript:`, `file:`,
 * `data:`, `http:`, Connect's own schemes…). Native checks it again before opening it.
 */
export function openableUrl(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.length > 2000 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.hostname && !url.username && !url.password ? url.href : null;
  if (url.protocol === 'obsidian:') return url.href;
  return null;
}

/**
 * The host. `invoke` is Connect's own invoke; `frameUrl(id, path)` the frame's address
 * (`pluginUrl`); `about()` → {name, version, engine}; `theme()` → 'light' | 'dark'; `whereNow()`
 * → where the window is when no plugin is shown. `on*` are the window's reactions.
 */
export function createPluginHost({
  invoke, frameUrl, doc = document, win = window, about = () => ({ name: 'CodeMie Connect', version: '', engine: '1.0' }),
  theme = () => 'light', whereNow = () => ({ view: 'today', section: '', route: '' }),
  onChange = () => {}, onGo = () => {}, onNotice = () => {}, onCopy = () => {}, onOpen = () => {}, now = () => Date.now(),
  confirmSkill = async () => false,
}) {
  /** plugin id → {id, name, version, client, key, el, port, contrib, calls, nextId, height, error, errors, ready, shown, paletteAt} */
  const frames = new Map();
  let target = null;
  let layer = null;
  let placing = false;

  function mount(container) {
    layer = doc.createElement('div');
    layer.className = 'ws-plugin-layer';
    container.appendChild(layer);
    win.addEventListener('resize', placeSoon);
    doc.addEventListener('scroll', placeSoon, true);
    return api;
  }

  // ------------------------------------------------------------ frames

  /** Makes one frame per enabled plugin with a client half whose host half loaded, and takes away
   *  the rest. */
  function sync(installed) {
    const want = new Map((installed || [])
      .filter(p => p && p.enabled && p.client && !p.problem && !p.loadError && PLUGIN_ID.test(p.id))
      .map(p => [p.id, p]));
    for (const [id, rec] of frames) {
      const p = want.get(id);
      if (!p || keyOf(p) !== rec.key) unload(id);
    }
    for (const [id, p] of want) if (!frames.has(id)) create(p);
    onChange();
  }

  const keyOf = p => `${p.version}:${String(p.hash || '').slice(0, 12)}`;

  function create(p) {
    const rec = {
      id: p.id, name: String(p.name || p.id), version: String(p.version || ''), client: String(p.client), key: keyOf(p),
      el: null, port: null, contrib: EMPTY, calls: new Map(), nextId: 1, height: 0, error: '', errors: [], ready: false, shown: false,
      paletteAt: 0, generation: 0,
      storage: Promise.resolve(invoke('plugins_request', { op: 'client_storage', data: { id: p.id } }))
        .then(r => (r && r.items && typeof r.items === 'object' ? r.items : {}), () => ({})),
    };
    frames.set(p.id, rec);
    let src;
    try {
      src = frameUrl(p.id, `__host/frame.html?v=${encodeURIComponent(rec.key)}`);
    } catch (e) {
      rec.error = errorOf(e).message;
      return;
    }
    const el = doc.createElement('iframe');
    el.setAttribute('sandbox', SANDBOX);
    el.setAttribute('title', rec.name);
    el.setAttribute('data-plugin-frame', p.id);
    el.className = 'ws-plugin-frame';
    el.hidden = true;
    el.addEventListener('load', () => connect(rec));
    el.src = src;
    rec.el = el;
    layer?.appendChild(el);
  }

  /** A new channel for each load of the frame; the previous one is closed and forgotten. */
  async function connect(rec) {
    const generation = ++rec.generation;
    closePort(rec);
    rec.contrib = EMPTY;
    rec.ready = false;
    rec.error = '';
    const storage = await rec.storage;
    if (generation !== rec.generation || frames.get(rec.id) !== rec || !rec.el?.contentWindow) return;
    const channel = new MessageChannel();
    const port = channel.port1;
    rec.port = port;
    port.onmessage = event => receive(rec, port, event.data);
    rec.el.contentWindow.postMessage({
      v: V, id: 0, kind: 'event', type: 'connect',
      plugin: { id: rec.id, name: rec.name, version: rec.version, client: rec.client },
      host: about(), theme: theme(), where: whereFor(rec.shown ? target : null), storage,
    }, '*', [channel.port2]);
    if (rec.shown) send(rec, { kind: 'event', type: 'show', target: frameTarget(target), where: whereFor(target) });
    onChange();
  }

  function closePort(rec) {
    if (rec.port) {
      rec.port.onmessage = null;
      rec.port.close();
      rec.port = null;
    }
    for (const call of rec.calls.values()) call.reject(new Error(`${rec.name} restarted.`));
    rec.calls.clear();
  }

  function send(rec, m) {
    if (rec.port) rec.port.postMessage({ v: V, id: 0, ...m });
  }

  /** Takes a plugin's frame away (turned off, updated, removed): it is told to unload first. */
  function unload(id) {
    const rec = frames.get(id);
    if (!rec) return;
    send(rec, { kind: 'event', type: 'unload' });
    rec.generation++;
    frames.delete(id);
    const el = rec.el;
    // The unload message is delivered before the frame's document goes.
    win.setTimeout(() => {
      closePort(rec);
      el?.remove();
    }, 50);
    if (target?.id === id) target = null;
  }

  // ------------------------------------------------------------ messages from a frame

  async function receive(rec, port, data) {
    if (rec.port !== port || frames.get(rec.id) !== rec) return;
    const m = checkFromFrame(data);
    if (!m) return;
    switch (m.kind) {
      case 'call': return answer(rec, port, m);
      case 'reply': {
        const call = rec.calls.get(m.id);
        if (!call) return;
        rec.calls.delete(m.id);
        return m.ok ? call.resolve(m.value) : call.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      }
      case 'contribution':
        rec.contrib = {
          activities: m.activities, sections: m.sections, card: m.card, panels: m.panels, palette: m.palette, widgets: m.widgets,
        };
        return onChange();
      case 'event': return event(rec, m);
      default:
    }
  }

  /** What a frame asks of the window: its commands, its stored values, and (the frame on screen
   *  only, after the user's click there) a reveal in Finder or a Claude Code session. */
  function ask(rec, m) {
    if (m.method === 'command') return invoke('plugin_call', { id: rec.id, command: m.command, args: m.args ?? null, ...(m.files ? { files: m.files } : {}) });
    if (m.method === 'storage') return invoke('plugins_request', { op: 'client_storage', data: { id: rec.id, items: m.items } }).then(() => null);
    if (!rec.shown) return Promise.reject(Object.assign(new Error('Only the page on screen can do that.'), { code: 'permission' }));
    if (m.method === 'skill') return skill(rec, m);
    if (m.method === 'session') {
      return invoke('plugins_request', { op: 'frame_session', data: { id: rec.id, folder: m.folder, path: m.path, mode: m.mode, profile: m.profile } });
    }
    return invoke('plugins_request', { op: 'frame_reveal', data: { id: rec.id, root: m.root, path: m.path } });
  }

  /** A skill in the user's own Claude Code, after Connect's own confirmation: what it adds (its
   *  name, description and place, checked in Rust), or what it takes out. */
  async function skill(rec, m) {
    const data = { id: rec.id, name: m.name, md: m.md };
    const shown = m.op === 'install'
      ? await invoke('plugins_request', { op: 'frame_skill_check', data })
      : { name: m.name, path: `~/.claude/skills/${m.name}/SKILL.md` };
    const yes = await confirmSkill({ op: m.op, plugin: rec.name, ...shown });
    if (!yes) throw Object.assign(new Error(m.op === 'install' ? `You chose not to add /${m.name}.` : `You chose to keep /${m.name}.`), { code: 'cancelled' });
    return invoke('plugins_request', { op: m.op === 'install' ? 'frame_skill_install' : 'frame_skill_remove', data });
  }

  async function answer(rec, port, m) {
    let reply;
    try {
      const value = await ask(rec, m);
      reply = { ok: true, value: value === undefined ? null : value };
    } catch (e) {
      reply = { ok: false, error: errorOf(e) };
    }
    if (rec.port === port) port.postMessage({ v: V, id: m.id, kind: 'reply', ...reply });
  }

  /** The frame on screen, or one whose palette entry the window ran just now, may lead the window. */
  const mayLead = rec => rec.shown || now() - rec.paletteAt < PALETTE_GRACE_MS;

  function event(rec, m) {
    switch (m.type) {
      case 'ready': rec.ready = true; rec.error = ''; return onChange();
      case 'error':
        rec.error = m.message;
        if (rec.errors.length < MAX_ERRORS && !rec.errors.includes(m.message)) rec.errors.push(m.message);
        return onChange();
      case 'height':
        rec.height = m.px;
        return placeSoon();
      case 'go': {
        const hash = mayLead(rec) ? internalRoute(rec.id, m.hash) : null;
        if (hash) onGo(hash, rec.id, { replace: m.replace === true });
        return;
      }
      case 'notice': if (mayLead(rec)) onNotice(m.text, rec.name); return;
      case 'copy': if (rec.shown) onCopy(m.text, rec.name); return;
      case 'open': {
        // Only the frame on screen, where the user clicked; the window asks before opening.
        if (!rec.shown) return;
        const url = openableUrl(m.url);
        if (url) onOpen(url, rec.name, rec.id);
        else onNotice('Connect opens only https:// and obsidian:// links.', rec.name);
        return;
      }
      default:
    }
  }

  // ------------------------------------------------------------ what the window shows

  function frameTarget(t) {
    if (!t) return { view: 'none' };
    if (t.view === 'activity') return { view: 'activity', activity: String(t.activity), route: String(t.route || '') };
    if (t.view === 'section') return { view: 'section', section: String(t.section) };
    if (t.view === 'card') return { view: 'card' };
    return { view: 'none' };
  }

  function whereFor(t) {
    if (t?.view === 'activity') return { view: `${t.id}:${t.activity}`, section: '', route: String(t.route || '') };
    if (t?.view === 'section') return { view: 'settings', section: `${t.id}:${t.section}`, route: '' };
    if (t?.view === 'card') return { view: 'settings', section: 'plugins', route: '' };
    const w = whereNow() || {};
    return { view: String(w.view || ''), section: String(w.section || ''), route: String(w.route || '') };
  }

  /** Shows one plugin's page, Settings section or card (`{id, view, activity, route, section}`), or
   *  none (null); the others are told where the window is. */
  function show(next) {
    const t = next && frames.has(next.id) && ['activity', 'section', 'card'].includes(next.view)
      && (next.view === 'card' || ITEM_ID.test(String(next.activity ?? next.section ?? ''))) ? next : null;
    const same = JSON.stringify(t) === JSON.stringify(target);
    target = t;
    for (const rec of frames.values()) {
      const mine = !!t && t.id === rec.id;
      if (mine && !same) {
        // The frame reports the height of what it draws next.
        rec.height = 0;
        send(rec, { kind: 'event', type: 'show', target: frameTarget(t), where: whereFor(t) });
      }
      else if (!mine && rec.shown) send(rec, { kind: 'event', type: 'show', target: { view: 'none' }, where: whereFor(null) });
      rec.shown = mine;
    }
    place();
  }

  let placeQueued = false;
  function placeSoon() {
    if (placeQueued) return;
    placeQueued = true;
    win.requestAnimationFrame(() => {
      placeQueued = false;
      place();
    });
  }

  /** Lays the shown frame over its slot (`[data-plugin-slot=<id>]`), clipped to the area that
   *  scrolls it (`[data-plugin-clip]`); a card's slot takes the frame's height. */
  function place() {
    if (placing) return;
    placing = true;
    try {
      for (const rec of frames.values()) {
        const el = rec.el;
        if (!el) continue;
        const slot = rec.shown ? doc.querySelector(`[data-plugin-slot="${rec.id}"]`) : null;
        if (!slot) {
          if (!el.hidden) el.hidden = true;
          continue;
        }
        // A card takes the height its frame reports; until then the frame is laid out a pixel high,
        // so it can measure what it drew (a hidden frame has no layout to measure).
        const card = target?.view === 'card';
        if (card) slot.style.height = `${Math.max(rec.height, 1)}px`;
        const r = slot.getBoundingClientRect();
        const clip = (slot.closest('[data-plugin-clip]') || slot).getBoundingClientRect();
        const inset = [clip.top - r.top, r.right - clip.right, r.bottom - clip.bottom, clip.left - r.left].map(n => Math.max(0, Math.round(n)));
        Object.assign(el.style, {
          left: `${Math.round(r.left)}px`, top: `${Math.round(r.top)}px`, width: `${Math.round(r.width)}px`, height: `${Math.max(1, Math.round(r.height))}px`,
          clipPath: inset.some(Boolean) ? `inset(${inset.map(n => `${n}px`).join(' ')})` : '',
        });
        el.hidden = r.width < 1 || (!card && r.height < 1) || (inset[0] + inset[2] >= r.height && r.height >= 1);
      }
    } finally {
      placing = false;
    }
  }

  function setTheme(t) {
    for (const rec of frames.values()) send(rec, { kind: 'event', type: 'theme', theme: t });
  }

  /** Runs a plugin's palette entry (in its frame). */
  function runPalette(id, index) {
    const rec = frames.get(id);
    if (!rec || !Number.isInteger(index) || index < 0 || index >= rec.contrib.palette.length) return;
    rec.paletteAt = now();
    send(rec, { kind: 'event', type: 'palette', index });
  }

  /** A `page` widget drawn by its plugin's client half: the HTML it gave (the window shows its
   *  text only). */
  function draw(id, widget, data, size = 'M') {
    const rec = frames.get(id);
    if (!rec?.port || !rec.contrib.widgets.includes(widget)) return Promise.reject(new Error('Its plugin draws it when its page is open.'));
    const callId = rec.nextId++;
    return new Promise((resolve, reject) => {
      const timer = win.setTimeout(() => {
        rec.calls.delete(callId);
        reject(new Error('The plugin didn’t draw it in time.'));
      }, DRAW_TIMEOUT_MS);
      rec.calls.set(callId, {
        resolve: v => { win.clearTimeout(timer); resolve(String(v ?? '')); },
        reject: e => { win.clearTimeout(timer); reject(e); },
      });
      rec.port.postMessage({ v: V, id: callId, kind: 'call', method: 'draw', widget, data: data ?? null, size, theme: theme() });
    });
  }

  /** Files dropped on the window while plugin `id`'s page is on screen, as its handles, for its
   *  `onFileDrop`. Any other frame gets none. */
  function dropFiles(id, files) {
    const rec = frames.get(id);
    if (!rec?.shown || target?.view !== 'activity' || !Array.isArray(files) || !files.length) return false;
    send(rec, { kind: 'event', type: 'files', files: files.map(f => ({ file: String(f.file), name: String(f.name), size: Number(f.size) || 0 })) });
    return true;
  }

  const list = key => [...frames.values()].flatMap(rec => rec.contrib[key].map(x => ({ ...x, plugin: rec.id, pluginName: rec.name })));

  const api = {
    mount, sync, show, place, placeSoon, setTheme, runPalette, draw, unload, dropFiles,
    /** The pages plugins add, for the sidebar: [{plugin, pluginName, id, label}]. */
    activities: () => list('activities'),
    /** Their Settings sections: [{plugin, pluginName, id, label, badge}]. */
    sections: () => list('sections'),
    /** What one plugin's frame has: {loaded, ready, error (the last), errors (each page error it
     *  reported), height, card, sections, palette, widgets, activities}. */
    status(id) {
      const rec = frames.get(id);
      if (!rec) return null;
      return { loaded: !!rec.el, ready: rec.ready, error: rec.error, errors: [...rec.errors], height: rec.height, ...rec.contrib };
    },
    shown: () => target,
  };
  return api;
}

// ---------------------------------------------------------------- the app's one host

let mounted = null;

/** Mounts the plugin frames' layer in `container` (outside the page the app redraws). `bridge`
 *  is `{invoke}`; `options` as `createPluginHost`'s. */
export function mountPlugins(bridge, container, options = {}) {
  mounted = createPluginHost({ ...options, invoke: bridge.invoke }).mount(container);
  return mounted;
}

/** Shows plugin `id`'s page `route` (`<activity>[/<rest>]`) over the content area. */
export function showPluginRoute(id, route) {
  if (!mounted) return;
  const [activity, ...rest] = String(route || '').split('/');
  mounted.show({ id, view: 'activity', activity, route: rest.join('/') });
}
