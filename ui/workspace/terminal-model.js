// Connect's terminal dock without the DOM: its tabs, the output each tab still has to write, the
// keys a Mac user expects, the links in a line, the colours and what an ended session says.
// terminal-dock.js draws it with xterm.js; Rust runs the sessions (src-tauri/src/commands/terminal.rs).

/** The dock's height: at least this, and it leaves this much of the page above it. */
export const MIN_HEIGHT = 160;
export const PAGE_LEFT = 140;
export const DEFAULT_HEIGHT = 340;

/** A height the person dragged to, kept within the window (`room`: the content area's height). */
export function clampHeight(h, room) {
  const max = Math.max(MIN_HEIGHT, room - PAGE_LEFT);
  const n = Number.isFinite(h) ? Math.round(h) : DEFAULT_HEIGHT;
  return Math.min(max, Math.max(MIN_HEIGHT, n));
}

/** The tabs: what Rust said about each session, in the order they opened, and the one shown. */
export function createTerminalModel() {
  /** id → {info, end}: `end` is the byte offset the tab has written up to, for its generation. */
  const tabs = new Map();
  let active = null;

  const api = {
    /** A session Rust told about (opened, started again or listed). True when it is new. */
    upsert(info, end = null) {
      const had = tabs.get(info.id);
      const tab = had || { info, end: 0 };
      if (!had || had.info.generation !== info.generation) tab.end = 0;
      tab.info = { ...info };
      if (end !== null) tab.end = end;
      tabs.set(info.id, tab);
      if (!active) active = info.id;
      return !had;
    },
    /** A session's program ended (`terminal:exit`); an older start's end is ignored. */
    ended(id, generation, code) {
      const tab = tabs.get(id);
      if (!tab || tab.info.generation !== generation) return false;
      tab.info = { ...tab.info, running: false, code };
      return true;
    },
    /** Takes a tab away; the one shown next is its neighbour. */
    remove(id) {
      const ids = [...tabs.keys()];
      const at = ids.indexOf(id);
      tabs.delete(id);
      if (active === id) active = ids[at + 1] ?? ids[at - 1] ?? null;
      return active;
    },
    select(id) {
      if (tabs.has(id)) active = id;
      return active;
    },
    /** What of an output event (`at`: where its `length` bytes start) the tab still has to
     *  write: `{from}` (skip that many bytes), or null when it has them all or the event belongs
     *  to another start. */
    accept(id, generation, at, length) {
      const tab = tabs.get(id);
      if (!tab || tab.info.generation !== generation) return null;
      const stop = at + length;
      if (stop <= tab.end) return null;
      const from = Math.max(0, tab.end - at);
      tab.end = stop;
      return { from };
    },
    get: id => tabs.get(id)?.info || null,
    has: id => tabs.has(id),
    active: () => active,
    list: () => [...tabs.values()].map(t => t.info),
    running: () => [...tabs.values()].filter(t => t.info.running).length,
    size: () => tabs.size,
  };
  return api;
}

/** What a tab says when its program has ended. */
export function endedText(info) {
  const program = info.program || 'The program';
  if (info.code === 127) {
    return {
      title: `Connect couldn’t find ${program} on this Mac`,
      detail: program === 'Claude Code' ? 'Install it in Settings → Claude, then start again.' : 'Install it in Settings → CodeMie, then start again.',
      tone: 'error',
    };
  }
  const again = info.resumable ? 'Start again to go on with the conversation.' : 'Start it again when you need it.';
  if (info.code === 0 || info.code === null || info.code === undefined) return { title: `${program} ended`, detail: again, tone: 'quiet' };
  return { title: `${program} stopped (exit ${info.code})`, detail: again, tone: 'warning' };
}

/** The bytes a Mac terminal sends for keys a Mac user expects (iTerm2's "Natural text editing"),
 *  or null when xterm.js handles the key itself. Shift+Enter or ⌥Enter is a new line in Claude
 *  Code's prompt (ESC CR). */
export function keySequence(ev) {
  if (ev.type !== 'keydown' || ev.isComposing || ev.ctrlKey) return null;
  const { key, metaKey: cmd, altKey: alt, shiftKey: shift } = ev;
  if (key === 'Enter' && !cmd && (shift || alt)) return '\x1b\r';
  if (alt && !cmd) {
    if (key === 'ArrowLeft') return '\x1bb';
    if (key === 'ArrowRight') return '\x1bf';
    if (key === 'Backspace') return '\x17';
  }
  if (cmd && !alt && !shift) {
    if (key === 'ArrowLeft') return '\x01';
    if (key === 'ArrowRight') return '\x05';
    if (key === 'Backspace') return '\x15';
  }
  return null;
}

/** A shortcut the dock handles itself: copy (⌘C with a selection), clear (⌘K), select all (⌘A),
 *  hide or show the dock (⌃`). Null for the rest. */
export function dockShortcut(ev, hasSelection) {
  if (ev.type !== 'keydown') return null;
  if (ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.code === 'Backquote' || ev.key === '`')) return 'toggle';
  if (!ev.metaKey || ev.ctrlKey || ev.altKey) return null;
  const k = String(ev.key).toLowerCase();
  if (k === 'c' && hasSelection) return 'copy';
  if (k === 'k') return 'clear';
  if (k === 'a') return 'selectAll';
  return null;
}

const LINK = /https:\/\/[^\s<>"'`]+/g;
const OPENS = { ')': '(', ']': '[', '}': '{' };
const count = (s, c) => s.split(c).length - 1;
/** The https addresses in one line of the terminal: [{start, end, url}] (columns, end excluded),
 *  without the punctuation that usually follows an address in a sentence. */
export function linksIn(text) {
  const out = [];
  for (const m of String(text).matchAll(LINK)) {
    let url = m[0];
    while (/[.,;:!?)\]}]$/.test(url)) {
      // A closing bracket stays when the address opened it (a Wikipedia page).
      const close = url.at(-1);
      if (OPENS[close] && count(url, OPENS[close]) >= count(url, close)) break;
      url = url.slice(0, -1);
    }
    if (url.length > 'https://'.length) out.push({ start: m.index, end: m.index + url.length, url });
  }
  return out;
}

/** xterm.js colours for the colours Claude Code draws with (`theme`: its own theme, dark or
 *  light), in Connect's palette. */
export function xtermTheme(theme) {
  return theme === 'light' ? {
    background: '#FFFFFF', foreground: '#2B2B2B', cursor: '#2B2B2B', cursorAccent: '#FFFFFF',
    selectionBackground: 'rgba(0, 122, 255, 0.18)', selectionInactiveBackground: 'rgba(0, 0, 0, 0.08)',
    scrollbarSliderBackground: 'rgba(0, 0, 0, 0.16)', scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.28)', scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.36)',
    black: '#2B2B2B', red: '#D7263D', green: '#1E8E41', yellow: '#9A5B00', blue: '#0062CC', magenta: '#7C3AED', cyan: '#0D7C74', white: '#6A6A6A',
    brightBlack: '#8A8A8A', brightRed: '#E5293A', brightGreen: '#259F4C', brightYellow: '#B26B00', brightBlue: '#007AFF', brightMagenta: '#8B5CF6', brightCyan: '#0D9488', brightWhite: '#1A1A1A',
  } : {
    background: '#161718', foreground: '#ECEAE8', cursor: '#F2F0EF', cursorAccent: '#161718',
    selectionBackground: 'rgba(127, 182, 255, 0.32)', selectionInactiveBackground: 'rgba(255, 255, 255, 0.12)',
    scrollbarSliderBackground: 'rgba(255, 255, 255, 0.14)', scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.24)', scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.32)',
    black: '#2E3033', red: '#FE3B4C', green: '#3CB86A', yellow: '#F5A534', blue: '#4F9CF9', magenta: '#C084FC', cyan: '#2DD4BF', white: '#BBBBBB',
    brightBlack: '#6A6B6E', brightRed: '#FF6B78', brightGreen: '#5DD68A', brightYellow: '#FFC266', brightBlue: '#7FB6FF', brightMagenta: '#D8B4FE', brightCyan: '#5EEAD4', brightWhite: '#FFFFFF',
  };
}

/** Base64 (as Rust sends output) to bytes. */
export function bytesOf(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
