// Connect's terminal dock: a panel along the bottom of the content area, under any page, with a
// tab per Claude Code session (a plugin's `ctx.claude.session`, a coding agent from Settings →
// CodeMie). It lives outside the page the app redraws (like the plugin frames), so a redraw
// never takes the keyboard away from a session. Rust runs the sessions
// (src-tauri/src/commands/terminal.rs); this draws them with xterm.js. The parts without a DOM
// are in terminal-model.js.
import {
  createTerminalModel, clampHeight, endedText, keySequence, dockShortcut, linksIn, xtermTheme, bytesOf, DEFAULT_HEIGHT,
} from './terminal-model.js';
import { icon } from './icons.js';
import { escapeHtml as e } from './store.js';

const FONT = '"GeistMono", "SF Mono", Menlo, monospace';
const HEIGHT_PREF = 'ws-terminal-height';

/**
 * @param deps.invoke  Tauri's invoke
 * @param deps.listen  Tauri's event listen (resolves to an unlisten function)
 * @param deps.Terminal, deps.FitAddon  xterm.js
 * @param deps.confirmStop  (info) => Promise<boolean>: may a running session be stopped?
 * @param deps.toast  (text, tone) => void
 * @param deps.onLayout  () => void: the dock showed, hid or changed height (the window lays out
 *        the page and the plugin frames again, and redraws its Terminal button)
 */
export function createTerminalDock({
  doc = document, win = window, invoke, listen, Terminal, FitAddon,
  confirmStop = async () => true, toast = () => {}, onLayout = () => {}, prefs = localPrefs(win),
}) {
  const model = createTerminalModel();
  /** id → {term, fit, pane, ended, generation, theme} */
  const views = new Map();
  let root = null;
  let tabsEl = null;
  let bodyEl = null;
  let shown = false;
  let maximized = false;
  let height = Number(prefs.get(HEIGHT_PREF)) || DEFAULT_HEIGHT;
  let fitQueued = false;
  /** While the dock reads kept output (`terminal_list`), output events wait here, so each tab
   *  writes its bytes once and in order. */
  let syncing = 0;
  let held = [];

  // ------------------------------------------------------------ mounting

  async function mount(container) {
    root = doc.createElement('section');
    root.className = 'ws-term';
    root.hidden = true;
    root.setAttribute('aria-label', 'Terminal');
    root.innerHTML = `
      <div class="ws-term-grip" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal" tabindex="0" title="Drag to resize · double-click to maximize"></div>
      <header class="ws-term-bar">
        <span class="ws-term-brand">${icon('terminal')}<span>Terminal</span></span>
        <div class="ws-term-tabs" role="tablist" aria-label="Terminal sessions"></div>
        <div class="ws-term-actions">
          <button type="button" class="ws-term-btn" data-term="move" title="Go on with this session in the Terminal app">${icon('external')}<span>Open in Terminal</span></button>
          <button type="button" class="ws-term-icon" data-term="max" title="Maximize" aria-label="Maximize the terminal">${icon('maximize')}</button>
          <button type="button" class="ws-term-icon" data-term="hide" title="Hide (⌃\`)" aria-label="Hide the terminal">${icon('minus')}</button>
        </div>
      </header>
      <div class="ws-term-body"></div>`;
    tabsEl = root.querySelector('.ws-term-tabs');
    bodyEl = root.querySelector('.ws-term-body');
    container.appendChild(root);
    root.addEventListener('click', onClick);
    tabsEl.addEventListener('keydown', onTabKey);
    // Keys typed in a session are the session's: the window's own shortcuts never see them.
    root.addEventListener('keydown', ev => ev.stopPropagation());
    grip(root.querySelector('.ws-term-grip'));
    new win.ResizeObserver(() => fitSoon()).observe(bodyEl);
    win.addEventListener('resize', () => { if (shown) setHeight(height); });
    layout();
    // Events first, then the sessions that ran before this page loaded (the window was opened
    // again): output in between is held and written once.
    syncing += 1;
    try {
      await Promise.all([
        listen('terminal:opened', ev => opened(ev.payload?.info)),
        listen('terminal:data', ev => data(ev.payload)),
        listen('terminal:exit', ev => exited(ev.payload)),
      ]);
    } finally {
      syncing -= 1;
    }
    await load();
    return api;
  }

  async function load() {
    const list = await sync();
    for (const s of list) {
      const { data: kept, end, ...info } = s;
      if (model.has(info.id)) continue;
      model.upsert(info, 0);
      writeKept(view(info), s);
      if (!info.running) markEnded(info.id);
    }
    flush();
    if (model.size()) {
      drawTabs();
      showPane(model.active());
    }
  }

  /** The sessions with their kept output; output events wait until `flush`. */
  async function sync() {
    syncing += 1;
    try {
      return (await invoke('terminal_list')) || [];
    } catch {
      return [];
    } finally {
      syncing -= 1;
    }
  }

  /** Writes the part of a session's kept output (`s.data`, ending at byte `s.end`) the tab
   *  hasn't written. */
  function writeKept(v, s) {
    const kept = bytesOf(s.data);
    const r = model.accept(s.id, s.generation, 0, s.end);
    if (!r) return;
    const start = s.end - kept.length;
    v.term.write(kept.subarray(Math.max(0, r.from - start)));
  }

  function flush() {
    if (syncing) return;
    const waiting = held;
    held = [];
    for (const p of waiting) apply(p);
  }

  // ------------------------------------------------------------ sessions

  /** Rust opened, showed again or started again a session: show its tab. */
  async function opened(info) {
    if (!info?.id) return;
    const v = views.get(info.id);
    const fresh = !model.has(info.id) || (v && v.generation !== info.generation);
    if (fresh) {
      // New, or started again (a clean screen): what it printed so far is in the kept output.
      model.upsert(info, 0);
      const tab = view(info);
      if (v) {
        v.term.reset();
        v.generation = info.generation;
        setTheme(v, info.theme);
        clearEnded(info.id);
      }
      const s = (await sync()).find(x => x.id === info.id);
      if (s && s.generation === tab.generation) {
        writeKept(tab, s);
        // The list is newer than the event: a program that ended at once has ended here too.
        const { data: _kept, end: _end, ...now } = s;
        model.upsert(now);
        if (!now.running) markEnded(now.id);
      }
      flush();
    } else {
      model.upsert(info);
    }
    model.select(info.id);
    drawTabs();
    show();
    showPane(info.id, true);
  }

  function data(p) {
    if (!p?.id) return;
    if (syncing) held.push(p);
    else apply(p);
  }

  function apply(p) {
    const v = views.get(p.id);
    if (!v) return;
    const bytes = bytesOf(p.data);
    const r = model.accept(p.id, p.generation, p.at, bytes.length);
    if (r) v.term.write(r.from ? bytes.subarray(r.from) : bytes);
  }

  function exited(p) {
    if (!p?.id || !model.ended(p.id, p.generation, p.code)) return;
    markEnded(p.id);
    drawTabs();
  }

  /** The xterm.js view of a session, made once. */
  function view(info) {
    let v = views.get(info.id);
    if (v) return v;
    const pane = doc.createElement('div');
    pane.className = 'ws-term-pane';
    pane.hidden = true;
    pane.setAttribute('role', 'tabpanel');
    pane.id = `ws-term-pane-${info.id}`;
    pane.innerHTML = '<div class="ws-term-screen"></div><div class="ws-term-ended" hidden></div>';
    bodyEl.appendChild(pane);
    const term = new Terminal({
      fontFamily: FONT, fontSize: 13, lineHeight: 1.2, letterSpacing: 0,
      cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2, scrollback: 5000,
      allowProposedApi: false, macOptionIsMeta: false, macOptionClickForcesSelection: true,
      drawBoldTextInBrightColors: false, minimumContrastRatio: 1,
      theme: xtermTheme(info.theme),
      linkHandler: { activate: (ev, url) => openLink(ev, url), allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(pane.querySelector('.ws-term-screen'));
    term.onData(d => send(info.id, d));
    term.attachCustomKeyEventHandler(ev => keys(ev, info.id, term));
    term.registerLinkProvider({
      provideLinks(y, done) {
        const line = term.buffer.active.getLine(y - 1)?.translateToString(true) || '';
        done(linksIn(line).map(l => ({
          range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
          text: l.url,
          decorations: { pointerCursor: true, underline: true },
          activate: (ev, url) => openLink(ev, url),
          hover: () => { pane.title = '⌘-click to open in your browser'; },
          leave: () => { pane.title = ''; },
        })));
      },
    });
    pane.style.setProperty('--ws-term-screen', xtermTheme(info.theme).background);
    v = { term, fit, pane, generation: info.generation, theme: info.theme };
    views.set(info.id, v);
    return v;
  }

  /** Typed text, in the order typed: each tab's input waits for the one before it. */
  const typing = new Map();
  function send(id, d) {
    const info = model.get(id);
    if (!info?.running) return;
    const next = (typing.get(id) || Promise.resolve())
      .then(() => invoke('terminal_input', { id, data: d }))
      .catch(() => {});
    typing.set(id, next);
  }

  /** Mac keys, and the dock's own shortcuts. False: xterm.js leaves the key alone. */
  function keys(ev, id, term) {
    const own = dockShortcut(ev, term.hasSelection());
    if (own) {
      ev.preventDefault();
      if (own === 'copy') copy(term.getSelection());
      else if (own === 'clear') term.clear();
      else if (own === 'selectAll') term.selectAll();
      else if (own === 'toggle') toggle();
      return false;
    }
    const seq = keySequence(ev);
    if (seq) {
      ev.preventDefault();
      send(id, seq);
      return false;
    }
    return true;
  }

  async function copy(text) {
    try {
      await win.navigator.clipboard.writeText(text);
    } catch {
      doc.execCommand?.('copy');
    }
  }

  function openLink(ev, url) {
    if (!ev?.metaKey) return;
    invoke('terminal_open_link', { url }).catch(err => toast(err?.message || String(err), 'error'));
  }

  function setTheme(v, theme) {
    if (v.theme === theme) return;
    v.theme = theme;
    v.term.options.theme = xtermTheme(theme);
    v.pane.style.setProperty('--ws-term-screen', xtermTheme(theme).background);
  }

  // ------------------------------------------------------------ ended sessions

  function markEnded(id) {
    const v = views.get(id);
    const info = model.get(id);
    if (!v || !info) return;
    const t = endedText(info);
    const box = v.pane.querySelector('.ws-term-ended');
    box.dataset.tone = t.tone;
    box.innerHTML = `<span class="ws-term-ended-icon">${icon(t.tone === 'error' ? 'alert' : t.tone === 'warning' ? 'info' : 'check')}</span>
      <div class="ws-term-ended-copy"><strong>${e(t.title)}</strong><span>${e(t.detail)}</span></div>
      <div class="ws-term-ended-actions">
        <button type="button" class="ws-btn ws-btn-primary ws-btn-sm" data-term="restart" data-id="${e(id)}">${icon('refresh')}<span>${info.resumable ? 'Start again' : 'Run again'}</span></button>
        <button type="button" class="ws-btn ws-btn-secondary ws-btn-sm" data-term="close" data-id="${e(id)}">Close</button>
      </div>`;
    box.hidden = false;
    v.term.options.cursorBlink = false;
    v.term.options.disableStdin = true;
    // The bar takes rows from the screen: fit it again, so the last lines stay in view.
    fitSoon();
  }

  function clearEnded(id) {
    const v = views.get(id);
    if (!v) return;
    v.pane.querySelector('.ws-term-ended').hidden = true;
    v.term.options.cursorBlink = true;
    v.term.options.disableStdin = false;
    fitSoon();
  }

  // ------------------------------------------------------------ tabs

  function drawTabs() {
    const active = model.active();
    tabsEl.innerHTML = model.list().map(t => {
      const on = t.id === active;
      const state = t.running ? 'running' : t.code === 0 || t.code === null ? 'ended' : 'failed';
      return `<div class="ws-term-tab${on ? ' is-on' : ''}" data-state="${state}">
        <button type="button" role="tab" class="ws-term-tab-main" data-term="tab" data-id="${e(t.id)}" aria-selected="${on}" aria-controls="ws-term-pane-${e(t.id)}" tabindex="${on ? 0 : -1}" title="${e(`${t.program} · ${t.folder}`)}">
          <span class="ws-term-dot" aria-hidden="true"></span>
          <span class="ws-term-tab-title">${e(t.title)}</span>
          <span class="ws-term-tab-detail">${e(t.detail)}</span>
          <span class="ws-sr">${t.running ? 'running' : 'ended'}</span>
        </button>
        <button type="button" class="ws-term-tab-close" data-term="close" data-id="${e(t.id)}" aria-label="Close ${e(t.title)}" title="Close">${icon('close')}</button>
      </div>`;
    }).join('');
    const info = model.get(active);
    root.querySelector('[data-term="move"]').hidden = !info;
    onLayout();
  }

  function showPane(id, focus = false) {
    for (const [vid, v] of views) v.pane.hidden = vid !== id;
    const v = views.get(id);
    if (!v) return;
    fitNow();
    if (focus && shown) v.term.focus();
  }

  async function select(id, focus = true) {
    model.select(id);
    drawTabs();
    showPane(id, focus);
  }

  /** ←/→ move between tabs, Home/End to the first/last (the tablist pattern). */
  function onTabKey(ev) {
    const ids = model.list().map(t => t.id);
    const at = ids.indexOf(model.active());
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ids.length - 1 }[ev.key];
    if (to === undefined || !ids.length) return;
    ev.preventDefault();
    const id = ids[(to + ids.length) % ids.length];
    select(id, false).then(() => tabsEl.querySelector(`[data-term="tab"][data-id="${win.CSS.escape(id)}"]`)?.focus());
  }

  async function close(id) {
    const info = model.get(id);
    if (!info) return;
    if (info.running && !(await confirmStop(info))) return;
    try {
      await invoke('terminal_close', { id });
    } catch (err) {
      toast(err?.message || String(err), 'error');
      return;
    }
    const v = views.get(id);
    v?.term.dispose();
    v?.pane.remove();
    views.delete(id);
    const next = model.remove(id);
    drawTabs();
    if (next) showPane(next, true);
    else hide();
  }

  async function restart(id) {
    try {
      await invoke('terminal_restart', { id });
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  /** Ends the tab here and goes on in the Terminal app (same folder, same words, --continue). */
  async function moveOut() {
    const id = model.active();
    const info = model.get(id);
    if (!info) return;
    try {
      await invoke('terminal_move_out', { id });
    } catch (err) {
      toast(err?.message || String(err), 'error');
      return;
    }
    const v = views.get(id);
    v?.term.dispose();
    v?.pane.remove();
    views.delete(id);
    const next = model.remove(id);
    drawTabs();
    toast(`${info.program} goes on in the Terminal app, in ${info.title}.`, 'success');
    if (next) showPane(next, true);
    else hide();
  }

  function onClick(ev) {
    const el = ev.target.closest('[data-term]');
    if (!el) return;
    const id = el.dataset.id;
    switch (el.dataset.term) {
      case 'tab': select(id); break;
      case 'close': close(id); break;
      case 'restart': restart(id); break;
      case 'move': moveOut(); break;
      case 'max': setMaximized(!maximized); break;
      case 'hide': hide(); break;
      default:
    }
  }

  // ------------------------------------------------------------ showing and size

  function room() {
    const top = doc.querySelector('.ws-topbar')?.getBoundingClientRect().bottom || 56;
    return win.innerHeight - top;
  }

  function layout() {
    const css = doc.documentElement.style;
    if (!root) return;
    root.hidden = !shown;
    const h = !shown ? 0 : maximized ? room() : clampHeight(height, room());
    css.setProperty('--ws-term-h', `${h}px`);
    doc.documentElement.dataset.term = shown ? (maximized ? 'max' : 'open') : '';
    const max = root.querySelector('[data-term="max"]');
    max.innerHTML = icon(maximized ? 'restore' : 'maximize');
    max.title = maximized ? 'Restore' : 'Maximize';
    max.setAttribute('aria-label', maximized ? 'Restore the terminal' : 'Maximize the terminal');
    fitSoon();
    onLayout();
  }

  function setHeight(h) {
    height = clampHeight(h, room());
    layout();
  }

  function setMaximized(on) {
    maximized = on;
    layout();
    views.get(model.active())?.term.focus();
  }

  function show() {
    if (!model.size()) return;
    shown = true;
    layout();
    showPane(model.active(), true);
  }

  function hide() {
    shown = false;
    maximized = false;
    layout();
  }

  function toggle() {
    if (shown) hide();
    else show();
  }

  /** The grip: drag to resize (the page follows), double-click to maximize, ↑/↓ by keyboard. */
  function grip(el) {
    el.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      maximized = false;
      root.classList.add('is-resizing');
      const move = m => setHeight(win.innerHeight - m.clientY);
      const up = () => {
        el.removeEventListener('pointermove', move);
        root.classList.remove('is-resizing');
        prefs.set(HEIGHT_PREF, String(height));
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up, { once: true });
      el.addEventListener('pointercancel', up, { once: true });
    });
    el.addEventListener('dblclick', () => setMaximized(!maximized));
    el.addEventListener('keydown', ev => {
      const step = { ArrowUp: 24, ArrowDown: -24 }[ev.key];
      if (!step) return;
      ev.preventDefault();
      maximized = false;
      setHeight(height + step);
      prefs.set(HEIGHT_PREF, String(height));
    });
  }

  function fitSoon() {
    if (fitQueued) return;
    fitQueued = true;
    win.requestAnimationFrame(() => {
      fitQueued = false;
      fitNow();
    });
  }

  /** Fits the shown tab to its pane and tells its program the new size. */
  function fitNow() {
    const id = model.active();
    const v = views.get(id);
    if (!v || !shown || v.pane.hidden) return;
    try {
      v.fit.fit();
    } catch {
      return;
    }
    const { cols, rows } = v.term;
    if (cols !== v.cols || rows !== v.rows) {
      v.cols = cols;
      v.rows = rows;
      invoke('terminal_resize', { id, cols, rows }).catch(() => {});
    }
  }

  const api = {
    mount, show, hide, toggle,
    /** For the window's Terminal button: how many sessions, how many run, whether it shows. */
    state: () => ({ count: model.size(), running: model.running(), shown }),
  };
  return api;
}

function localPrefs(win) {
  return {
    get(k) {
      try { return win.localStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try { win.localStorage.setItem(k, v); } catch { /* per-viewer convenience only */ }
    },
  };
}
