// The plugin frame's shim (DESIGN 7.3, PLUGIN-ENGINE.md §5): it runs first in a plugin's sandboxed
// frame, waits for Connect's window to hand it the frame's channel, builds the client half's
// `ctx`, imports `client.js` and calls `apply(ctx)`. What the plugin adds (pages, Settings
// sections, its card, panels, palette entries, page widgets) stays in the frame: the plugin draws
// its own HTML here, and the window learns only ids and labels (`contribution`). Echo 0.10's
// client members are here too: `slots` (Echo's names; none drawn yet), `onFileDrop`, `ui.sheet`,
// and the page's route mirrored into the frame's own `location.hash` (`#<plugin>:<page>/<route>`),
// which a plugin reads as it does in Echo. The hash is changed with `history.replaceState`, never
// by navigating: WebKit tells the window a frame loaded again after each fragment navigation.
// `openEchoPanel` is left out (the spec's rule 3).
import { V, checkFromWindow, errorOf } from './messages.js';
import { esc, setRow, setCard, sw, ICON, relDay, ago, patch as domPatch } from './kit.js';

/** The most a client half keeps in its `localStorage` stand-in (as JSON). */
export const STORAGE_MAX = 1024 * 1024;
/** Writes to the stand-in are saved together, this long after the last one. */
const FLUSH_MS = 250;
const ITEM_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
const CLIENT_PATH = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]*\.m?js$/;
const STYLESHEET = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_/.-]*\.css$/;
const MAX_LIST = 40;
/** The most different page errors a frame reports in one load. */
const MAX_ERRORS = 20;
/** The slots Echo has (`ctx.slots.add`); another name throws, as in Echo. */
export const ECHO_SLOTS = ['call.header', 'call.menu', 'call.minutes', 'thread.profile', 'client.profile'];
/** A hash that names a plugin's page (`#<plugin>:<page>…`), as opposed to a place on this page. */
const PAGE_HASH = /^#[a-z][a-z0-9-]{1,40}:[a-z0-9]/i;
/** What a sheet's Tab key moves between. */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** A `localStorage` stand-in: the Storage interface over `initial`, calling `onChange(all)` after
 *  each change. Over `max` (as JSON) a write throws, as a full browser storage does. */
export function createStorage(initial = {}, onChange = () => {}, max = STORAGE_MAX) {
  const map = new Map(Object.entries(initial).filter(([, v]) => typeof v === 'string'));
  const all = () => Object.fromEntries(map);
  return {
    get length() { return map.size; },
    key: i => [...map.keys()][i] ?? null,
    getItem: k => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem(k, v) {
      const key = String(k);
      const before = map.get(key);
      map.set(key, String(v));
      if (JSON.stringify(all()).length > max) {
        if (before === undefined) map.delete(key); else map.set(key, before);
        const e = new Error('This plugin keeps 1 MB at most.');
        e.name = 'QuotaExceededError';
        throw e;
      }
      if (before !== map.get(key)) onChange(all());
    },
    removeItem(k) { if (map.delete(String(k))) onChange(all()); },
    clear() { if (map.size) { map.clear(); onChange(all()); } },
  };
}

/** Starts the shim in a plugin's frame, and only there: plugin code never runs in a window that
 *  isn't a frame (where it would be Connect's own page). */
export function startFrame(env) {
  if (!env.win || env.win.parent === env.win) return null;
  const shim = createShim(env);
  env.win.addEventListener('message', shim.onWindowMessage);
  return shim;
}

/**
 * The shim over a window and document: `importClient(path)` loads the client half,
 * `graphs(win, doc)` makes `ctx.ui.graph` (vendored Sigma; none in tests), `patch(el, html)`
 * draws. `timers` schedule the storage writes.
 */
export function createShim({ win, doc, importClient, patch = domPatch, graphs = null, timers = { set: setTimeout, clear: clearTimeout } }) {
  const s = {
    port: null, plugin: null, host: null,
    target: { view: 'none' }, where: { view: '', section: '', route: '' },
    activities: new Map(), sections: new Map(), card: null, panels: new Map(), palette: [], draws: new Map(),
    shownPanel: null, drawing: false, applied: false, failed: '', unloaded: false,
    owned: { listeners: [], windowListeners: [], styles: [], cleanups: [] },
    calls: new Map(), nextId: 1, sent: '', renderQueued: false, height: -1,
    pendingItems: null, flushTimer: null, reported: new Set(), early: [],
    slots: new Map(), drops: [], sheet: null,
  };
  let ctx = null;
  let graph = null;

  const post = m => {
    if (s.port && !s.unloaded) s.port.postMessage({ v: V, id: 0, ...m });
  };

  /** A page error, told to the window once (each different one, 20 at most); one from before the
   *  channel opened is told when it does. */
  function pageError(message) {
    const text = String(message || 'Something went wrong').slice(0, 2000);
    if (s.reported.has(text) || s.reported.size >= MAX_ERRORS) return;
    s.reported.add(text);
    if (s.port) post({ kind: 'event', type: 'error', message: text });
    else s.early.push(text);
  }

  // What goes wrong in the frame outside the shim's own calls: the plugin's uncaught errors and
  // rejections, and what the frame's CSP refused.
  const scriptPath = file => String(file || '').replace(/^[a-z-]+:\/\/[^/]*\//i, '').replace(/[?#].*$/, '');
  win.addEventListener?.('error', event => {
    const at = event.filename ? ` (${scriptPath(event.filename)}${event.lineno ? `:${event.lineno}` : ''})` : '';
    pageError(`${event.message || errorOf(event.error).message}${at}`);
  });
  win.addEventListener?.('unhandledrejection', event => pageError(`Unhandled rejection: ${errorOf(event.reason).message}`));
  doc.addEventListener?.('securitypolicyviolation', event => {
    pageError(`CSP blocked ${event.blockedURI || 'inline'} (${event.violatedDirective || event.effectiveDirective || '?'})`);
  });

  // Links (ruling R41). The frame can't navigate or open windows (no `allow-popups`, no
  // `allow-top-navigation`), so a link the user clicks, and `window.open`, become an `open`
  // message; Connect's window shows the address and opens it only when the user says so. Heard on
  // the window after the plugin's own listeners: a link the plugin handled itself is left alone,
  // and so is a place on its own page.
  const openLink = url => post({ kind: 'event', type: 'open', url: String(url ?? '').slice(0, 2000) });
  win.addEventListener?.('click', event => {
    if (event.defaultPrevented) return;
    const link = event.target?.closest?.('a[href]');
    const href = String(link?.getAttribute('href') ?? '');
    if (!link) return;
    if (href.startsWith('#')) {
      // A place in the frame: followed here, without a navigation (see mirrorHash).
      event.preventDefault();
      followHash(href);
      return;
    }
    event.preventDefault();
    const url = String(link.href || href);
    // `javascript:` is a "button" the CSP refuses to run anyway, never an address to open.
    if (!/^\s*javascript:/i.test(url)) openLink(url);
  });
  try {
    Object.defineProperty(win, 'open', { value: url => { openLink(url); return null; }, configurable: true, writable: true });
  } catch { /* the browser's stays, and opens nothing from this frame */ }

  // The page's route lives in the frame's own hash, as a plugin reads it in Echo. The window's
  // route is mirrored in on `show`; a page's hash the frame moves to itself (a `#…` link, or the
  // plugin setting `location.hash`) is told to the window as `go`, so Connect's address follows,
  // and drawn at once; any other hash is a place on the page, scrolled to.
  function hashMoved(hash) {
    if (s.sheet) closeSheet(true);
    if (PAGE_HASH.test(hash)) {
      if (s.target.view === 'activity') post({ kind: 'event', type: 'go', hash: hash.slice(0, 600), replace: true });
      renderSoon();
    } else if (hash.length > 1) {
      let id = hash.slice(1);
      try { id = decodeURIComponent(id); } catch { /* as written */ }
      doc.getElementById?.(id)?.scrollIntoView?.();
    }
  }
  function followHash(hash) {
    if (String(win.location?.hash || '') === hash) return;
    try {
      win.history.replaceState(null, '', hash);
    } catch {
      return;
    }
    hashMoved(hash);
  }
  win.addEventListener?.('hashchange', () => hashMoved(String(win.location?.hash || '')));

  // A sheet (`ctx.ui.sheet`) is one modal over the page: Esc and a click on the scrim close it
  // and tell its `onClose` once; Tab stays inside it.
  doc.addEventListener?.('keydown', event => {
    if (!s.sheet) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSheet(true);
    } else if (event.key === 'Tab') {
      const items = [...s.sheet.box.querySelectorAll(FOCUSABLE)];
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = s.sheet.box.contains(doc.activeElement);
      if (event.shiftKey && (doc.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (doc.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    }
  }, true);

  function request(body) {
    if (!s.port || s.unloaded) return Promise.reject(new Error('This plugin is off.'));
    const id = s.nextId++;
    return new Promise((resolve, reject) => {
      s.calls.set(id, { resolve, reject });
      s.port.postMessage({ v: V, id, kind: 'call', ...body });
    });
  }

  // ------------------------------------------------------------ the window's messages

  function onWindowMessage(event) {
    // A channel from Connect's window only.
    if (event.source !== win.parent) return;
    const m = checkFromWindow(event.data);
    const port = event.ports && event.ports[0];
    if (!m || m.kind !== 'event' || m.type !== 'connect' || !port) return;
    if (s.port) return reconnect(m, port);
    s.port = port;
    port.onmessage = onPortMessage;
    s.plugin = m.plugin;
    s.host = m.host;
    s.where = m.where;
    setTheme(m.theme);
    installStorage(m.storage);
    for (const text of s.early.splice(0)) post({ kind: 'event', type: 'error', message: text });
    ctx = makeCtx();
    boot();
  }

  /** The window handed this page a new channel without loading it again (WebKit tells the window
   *  a frame loaded after a fragment navigation): the page goes on over the new one. What the old
   *  channel still owed is lost, so those calls fail; the window hears the page as it is. */
  function reconnect(m, port) {
    if (s.unloaded || m.plugin.id !== s.plugin?.id) return;
    s.port.onmessage = null;
    s.port = port;
    port.onmessage = onPortMessage;
    for (const call of s.calls.values()) call.reject(new Error('Connect lost this answer; try again.'));
    s.calls.clear();
    s.where = m.where;
    setTheme(m.theme);
    s.sent = '';
    s.height = -1;
    if (s.applied) post({ kind: 'event', type: 'ready' });
    for (const text of s.reported) post({ kind: 'event', type: 'error', message: text });
    contribute();
    renderSoon();
  }

  function onPortMessage(event) {
    const m = checkFromWindow(event.data);
    if (!m || s.unloaded) return;
    if (m.kind === 'reply') {
      const call = s.calls.get(m.id);
      if (!call) return;
      s.calls.delete(m.id);
      if (m.ok) call.resolve(m.value);
      else call.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      return;
    }
    if (m.kind === 'call') return answerDraw(m);
    switch (m.type) {
      case 'theme': setTheme(m.theme); graph?.retheme(); renderSoon(); return;
      case 'show': s.target = m.target; s.where = m.where; mirrorHash(m.target); renderSoon(); return;
      case 'palette': return runPalette(m.index);
      case 'unload': return unload();
      default:
    }
  }

  async function boot() {
    try {
      const path = String(s.plugin.client || '');
      if (!CLIENT_PATH.test(path)) throw new Error(`“${path}” isn't a client half inside the plugin`);
      const mod = await importClient(path);
      if (typeof mod?.apply !== 'function') throw new Error(`${path} exports no apply(ctx)`);
      await mod.apply(ctx);
      s.applied = true;
      post({ kind: 'event', type: 'ready' });
    } catch (e) {
      s.failed = errorOf(e).message;
      pageError(s.failed);
    }
    contribute();
    renderSoon();
  }

  // ------------------------------------------------------------ ctx

  function register(map, item, what) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ITEM_ID.test(item.id)) {
      throw new Error(`${what} needs an id of letters, digits, “-”, “_” or “.”`);
    }
    if (typeof item.render !== 'function') throw new Error(`${what} “${item.id}” needs render()`);
    map.set(item.id, item);
    changed();
  }

  function changed() {
    contribute();
    renderSoon();
  }

  function makeCtx() {
    const own = s.owned;
    if (graphs && !graph) graph = graphs(win, doc);
    const ui = {
      esc, patch, setRow, setCard, sw, ICON, relDay, ago,
      notice: text => post({ kind: 'event', type: 'notice', text: String(text ?? '').slice(0, 2000) }),
      copy,
      stylesheet,
      sheet: openSheet,
      closeSheet: () => closeSheet(false),
      style: css => {
        const el = doc.createElement('style');
        el.setAttribute('data-plugin', s.plugin.id);
        el.textContent = String(css ?? '');
        doc.head.appendChild(el);
        own.styles.push(el);
        return el;
      },
    };
    if (graph) Object.assign(ui, { graph: graph.api, newGraph: graph.newGraph });
    return {
      id: s.plugin.id,
      host: { name: String(s.host.name || ''), version: String(s.host.version || ''), engine: String(s.host.engine || '') },
      call: (command, args = {}) => request({ method: 'command', command: String(command), args: args === undefined ? null : args }),
      render: () => { if (!s.drawing) renderSoon(); },
      listen: (type, fn, opts) => { doc.addEventListener(type, fn, opts); own.listeners.push([type, fn, opts]); },
      listenWindow: (type, fn, opts) => { win.addEventListener(type, fn, opts); own.windowListeners.push([type, fn, opts]); },
      onUnload: fn => { if (typeof fn === 'function') own.cleanups.push(fn); },
      activities: { add: a => register(s.activities, a, 'An activity') },
      slots: {
        add: (slot, item) => {
          const name = String(slot);
          if (!ECHO_SLOTS.includes(name)) throw new Error(`${s.host.name || 'Connect'} has no slot “${name}”`);
          if (!item || typeof item !== 'object') throw new Error(`slots.add(“${name}”) needs an item`);
          if (!s.slots.has(name)) s.slots.set(name, []);
          s.slots.get(name).push(item);
        },
        // The slots Connect draws: none yet.
        list: () => [],
      },
      onFileDrop: fn => {
        if (typeof fn !== 'function') throw new Error('ctx.onFileDrop needs a function');
        s.drops.push(fn);
      },
      settings: {
        add: card => {
          if (!card || typeof card.render !== 'function') throw new Error('A settings card needs render()');
          s.card = card;
          changed();
        },
        section: section => register(s.sections, { ...section, id: section?.id || 'main' }, 'A settings section'),
      },
      panels: { add: p => register(s.panels, p, 'A panel') },
      showPanel: view => { s.shownPanel = String(view); renderSoon(); },
      palette: {
        add: item => {
          if (!item || typeof item.run !== 'function' || !String(item.label || '').trim()) throw new Error('A palette entry needs a label and run()');
          if (s.palette.length < MAX_LIST) s.palette.push(item);
          contribute();
        },
      },
      widgets: {
        draw: (widget, fn) => {
          if (!ITEM_ID.test(String(widget)) || typeof fn !== 'function') throw new Error('widgets.draw(widget, fn) draws a declared page widget');
          s.draws.set(String(widget), fn);
          contribute();
        },
      },
      where: () => ({ ...s.where }),
      go: (hash, opts) => post({ kind: 'event', type: 'go', hash: String(hash ?? '').slice(0, 600), replace: !!(opts && opts.replace) }),
      ui,
    };
  }

  /** The clipboard, on the user's click or key only (a guard against copies nobody asked for). */
  function copy(text) {
    const activation = win.navigator && win.navigator.userActivation;
    if (!activation || activation.isActive !== true) throw new Error('the clipboard is filled only on your click');
    const value = String(text ?? '').slice(0, 10000);
    // In the frame first, within the click; the window copies it when the frame can't.
    let copied = false;
    try {
      const area = doc.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      doc.body.appendChild(area);
      area.select();
      copied = doc.execCommand('copy') === true;
      area.remove();
    } catch { /* the window copies it */ }
    if (!copied) post({ kind: 'event', type: 'copy', text: value });
  }

  /** A stylesheet in the plugin's package, removed with it. */
  function stylesheet(path) {
    return new Promise((resolve, reject) => {
      if (!STYLESHEET.test(String(path))) return reject(new Error('Not a stylesheet in this plugin'));
      const el = doc.createElement('link');
      el.rel = 'stylesheet';
      el.setAttribute('data-plugin', s.plugin.id);
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Could not load ${path}`));
      el.href = `../${path}`;
      doc.head.appendChild(el);
      s.owned.styles.push(el);
    });
  }

  /** Opens the sheet with `html` (or, when one is open, draws `html` in it): the box returned is
   *  where the plugin patches it again. */
  function openSheet(html, opts) {
    const label = String(opts?.label ?? '').slice(0, 120);
    const onClose = typeof opts?.onClose === 'function' ? opts.onClose : null;
    if (s.sheet) {
      s.sheet.onClose = onClose;
      s.sheet.box.setAttribute('aria-label', label);
      patch(s.sheet.box, String(html ?? ''));
      return s.sheet.box;
    }
    const scrim = doc.createElement('div');
    scrim.className = 'td-modal plug-scrim';
    const box = doc.createElement('div');
    box.className = 'td-dialog plug-sheet';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', label);
    box.setAttribute('tabindex', '-1');
    scrim.addEventListener?.('click', event => { if (event.target === scrim) closeSheet(true); });
    scrim.appendChild(box);
    doc.body.appendChild(scrim);
    s.sheet = { scrim, box, onClose, back: doc.activeElement };
    patch(box, String(html ?? ''));
    (box.querySelector?.(FOCUSABLE) || box).focus?.();
    return box;
  }

  /** Closes the sheet; `tell`: the user closed it (Esc, the scrim, a new address), so `onClose`
   *  hears it, once. */
  function closeSheet(tell) {
    const sheet = s.sheet;
    if (!sheet) return;
    s.sheet = null;
    sheet.scrim.remove();
    try { sheet.back?.focus?.(); } catch { /* it is gone */ }
    if (tell && sheet.onClose) {
      try {
        sheet.onClose();
      } catch (e) {
        pageError(`Sheet: ${errorOf(e).message}`);
      }
    }
  }

  /** The window's route of the page shown, in the frame's own hash: replaced in the frame's
   *  history, so it adds no entry, fires no `hashchange` and isn't a navigation. */
  function mirrorHash(t) {
    if (t.view !== 'activity' || !s.plugin || !win.location) return;
    const hash = `#${s.plugin.id}:${t.activity}${t.route ? `/${t.route}` : ''}`;
    if (win.location.hash === hash) return;
    try {
      win.history.replaceState(null, '', hash);
    } catch { /* the page reads the hash it had */ }
  }

  // ------------------------------------------------------------ what the window shows

  const label = (v, fallback) => String(v ?? '').trim().slice(0, 80) || fallback;

  /** A page's or section's badge: a count (1–99, `99+`) or a short mark like `!`. */
  function badgeOf(item) {
    if (typeof item.badge !== 'function') return '';
    try {
      const b = item.badge();
      if (typeof b === 'number') return b > 0 ? (b > 99 ? '99+' : String(Math.floor(b))) : '';
      return String(b ?? '').slice(0, 8);
    } catch {
      return '';
    }
  }

  function contribute() {
    if (s.unloaded) return;
    const c = {
      activities: [...s.activities.values()].slice(0, MAX_LIST).map(a => ({ id: a.id, label: label(a.label, a.id), badge: badgeOf(a) })),
      sections: [...s.sections.values()].slice(0, MAX_LIST).map(x => ({ id: x.id, label: label(x.label, x.id), badge: badgeOf(x) })),
      card: !!s.card,
      panels: [...s.panels.values()].slice(0, MAX_LIST).map(p => ({ id: p.id, label: label(p.label, p.id) })),
      palette: s.palette.map(p => ({ label: label(p.label, 'Run'), keywords: String(p.keywords ?? '').slice(0, 200) })),
      widgets: [...s.draws.keys()].slice(0, MAX_LIST),
    };
    const json = JSON.stringify(c);
    if (json === s.sent) return;
    s.sent = json;
    post({ kind: 'contribution', ...c });
  }

  function renderSoon() {
    if (s.renderQueued || s.unloaded) return;
    s.renderQueued = true;
    Promise.resolve().then(() => {
      s.renderQueued = false;
      renderNow();
    });
  }

  function viewName(t) {
    if (t.view === 'activity') return `Page “${t.activity}”`;
    if (t.view === 'section') return `Section “${t.section}”`;
    return 'Card';
  }

  function viewOf(t) {
    if (t.view === 'activity') return s.activities.get(t.activity);
    if (t.view === 'section') return s.sections.get(t.section);
    if (t.view === 'card') return s.card;
    return null;
  }

  function pickPanel() {
    const fits = p => {
      try {
        return typeof p.when !== 'function' || !!p.when();
      } catch {
        return false;
      }
    };
    const shown = s.shownPanel && s.panels.get(s.shownPanel);
    if (shown && fits(shown)) return shown;
    return [...s.panels.values()].find(p => typeof p.when === 'function' && fits(p)) || null;
  }

  function renderNow() {
    if (s.unloaded) return;
    const main = doc.getElementById('cx-main');
    const aside = doc.getElementById('cx-panel');
    if (!main) return;
    const t = s.target;
    doc.body.setAttribute('data-view', t.view);
    const view = viewOf(t);
    // A page being typed in is left as it is (`editing()`, as in Echo): it asks to be drawn when
    // it is ready.
    if (t.view === 'activity' && view && typeof view.editing === 'function') {
      let held = false;
      try { held = !!view.editing(); } catch { /* drawn */ }
      if (held) {
        contribute();
        return;
      }
    }
    let html = '';
    let panel = null;
    s.drawing = true;
    try {
      if (view) html = String(view.render() ?? '');
      else if (t.view !== 'none') {
        html = s.failed ? `<p class="error">${esc(s.failed)}</p>`
          : s.applied ? '<p class="cx-missing">This page isn’t available any more.</p>'
            : '<div class="skeleton"><i></i><i></i><i></i></div>';
      }
      if (view && t.view !== 'card') panel = pickPanel();
    } catch (e) {
      html = `<p class="error">${esc(errorOf(e).message)}</p>`;
      pageError(`${viewName(t)}: ${errorOf(e).message}`);
    } finally {
      s.drawing = false;
    }
    patch(main, html);
    if (aside) {
      let side = '';
      if (panel) {
        s.drawing = true;
        try {
          side = String(panel.render() ?? '');
        } catch (e) {
          side = `<p class="error">${esc(errorOf(e).message)}</p>`;
          pageError(`Panel “${panel.id}”: ${errorOf(e).message}`);
        } finally {
          s.drawing = false;
        }
      }
      patch(aside, side);
      aside.hidden = !panel;
    }
    if (view && typeof view.after === 'function') {
      try {
        view.after(main);
      } catch (e) {
        pageError(`${viewName(t)}: ${errorOf(e).message}`);
      }
    }
    contribute();
    reportHeight();
  }

  /** The height of what is drawn, for the window to fit the frame to (its Settings card). */
  function reportHeight() {
    const root = doc.getElementById('cx-root');
    if (!root || typeof root.getBoundingClientRect !== 'function') return;
    const px = Math.ceil(root.getBoundingClientRect().height);
    if (px === s.height) return;
    s.height = px;
    post({ kind: 'event', type: 'height', px });
  }

  function answerDraw(m) {
    const fn = s.draws.get(m.widget);
    let answer;
    if (typeof fn !== 'function') {
      answer = { ok: false, error: { code: 'not_found', message: `This plugin draws no widget “${m.widget}”.` } };
    } else {
      s.drawing = true;
      try {
        answer = { ok: true, value: String(fn({ data: m.data, size: m.size, height: 1, fits: {}, theme: m.theme }) ?? '') };
      } catch (e) {
        answer = { ok: false, error: errorOf(e) };
      } finally {
        s.drawing = false;
      }
    }
    s.port.postMessage({ v: V, id: m.id, kind: 'reply', ...answer });
  }

  function runPalette(index) {
    const item = s.palette[index];
    if (!item) return;
    try {
      item.run();
    } catch (e) {
      post({ kind: 'event', type: 'notice', text: errorOf(e).message });
    }
  }

  // ------------------------------------------------------------ theme and storage

  function setTheme(theme) {
    const html = doc.documentElement;
    html.classList.remove('light', 'dark');
    html.classList.add(theme);
    // Echo's pages watch `data-theme` (a canvas reads its colours again).
    html.setAttribute?.('data-theme', theme);
    if (html.style) html.style.colorScheme = theme;
  }

  function flush() {
    s.flushTimer = null;
    const items = s.pendingItems;
    s.pendingItems = null;
    if (items) request({ method: 'storage', items }).catch(() => { /* kept in the frame until the next write */ });
  }

  function installStorage(items) {
    const local = createStorage(items, all => {
      s.pendingItems = all;
      if (!s.flushTimer) s.flushTimer = timers.set(flush, FLUSH_MS);
    });
    const session = createStorage({}, () => {});
    for (const [name, value] of [['localStorage', local], ['sessionStorage', session]]) {
      try {
        Object.defineProperty(win, name, { value, configurable: true, enumerable: true });
      } catch { /* the browser's stays, and throws in an opaque frame */ }
    }
    s.storage = local;
  }

  // ------------------------------------------------------------ unload

  /** The plugin was turned off, updated or removed: everything it added goes. */
  function unload() {
    if (s.unloaded) return;
    if (s.flushTimer) {
      timers.clear(s.flushTimer);
      flush();
    }
    const own = s.owned;
    for (const fn of own.cleanups) {
      try { fn(); } catch { /* the rest still go */ }
    }
    for (const [type, fn, opts] of own.windowListeners) win.removeEventListener(type, fn, opts);
    for (const [type, fn, opts] of own.listeners) doc.removeEventListener(type, fn, opts);
    for (const el of own.styles) el.remove();
    graph?.killAll();
    own.cleanups = [];
    own.windowListeners = [];
    own.listeners = [];
    own.styles = [];
    s.activities.clear();
    s.sections.clear();
    s.panels.clear();
    s.draws.clear();
    s.palette = [];
    s.card = null;
    s.slots.clear();
    s.drops = [];
    closeSheet(false);
    s.unloaded = true;
    for (const call of s.calls.values()) call.reject(new Error('This plugin is off.'));
    s.calls.clear();
    const main = doc.getElementById('cx-main');
    if (main) main.innerHTML = '';
  }

  return {
    onWindowMessage,
    reportHeight,
    resized: () => { graph?.api.resize(); reportHeight(); },
    get ctx() { return ctx; },
    state: s,
  };
}
