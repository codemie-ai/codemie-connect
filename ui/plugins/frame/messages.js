// The messages between Connect's window and one plugin's frame (DESIGN 7.3). They travel over the
// frame's own MessageChannel, which the window makes afresh on every load of the frame and hands
// to that frame's window only. Every message is `{v: 1, id, kind, …}` with exactly the fields
// below; anything else is dropped by both sides. The window never takes a plugin's id from a
// message: the channel it arrived on names the frame, and the frame names the plugin.
//
// Frame → window
//   call          {method: 'command', command, args, files?}  a host-half command → reply {value};
//                                       `files`: ids of handles the user gave it, for `fn(args, {files})`
//                 {method: 'storage', items}                   the localStorage stand-in, saved
//                 {method: 'reveal', root, path}               ctx.system.reveal, on the user's click
//                 {method: 'session', folder, path, mode, profile}   ctx.claude.session, on the user's click
//                 {method: 'skill', op, name, md}              ctx.claude.installSkill / removeSkill, on the
//                                       user's click; the window asks the user first
//                                       (the window answers only for the frame on screen)
//   event         {type: 'go', hash, replace} {type: 'notice', text} {type: 'copy', text}
//                 {type: 'open', url}   a link the user clicked (or window.open): the window asks
//                                       the user, and opens https: and obsidian: addresses only
//                 {type: 'height', px} {type: 'ready'} {type: 'error', message}
//                 {type: 'slots', call, header, menu, minutes}   the text of its `call.*` slots for the
//                                       meeting the window shows (`call`: its folder; '' when none)
//                 {type: 'sheet', open}   its sheet opened or closed (the window lays the frame over
//                                       itself while a page that isn't on screen shows one)
//   contribution  {activities: [{id, label, badge}], sections: [{id, label, badge}], card,
//                  panels: [{id, label}], palette: [{label, keywords}], widgets: [id]}
//   reply         {ok, value} | {ok: false, error: {code, message}}   to the window's call
// Window → frame
//   event         {type: 'connect', plugin, host, theme, where, storage}   (posted with the port)
//                 {type: 'theme', theme} {type: 'show', target, where} {type: 'palette', index}
//                 {type: 'files', files: [{file, name, size}]}   files dropped on its page, as handles
//                 {type: 'call', call, where}   the meeting the Meetings page shows, as Echo's call
//                                       (`{name, stamp, title, started_at, notes, profile, memo,
//                                       threads, client}`), or null
//                 {type: 'slot', slot: 'call.menu', index}   the user chose that ⋯ item
//                 {type: 'unload'}
//   call          {method: 'draw', widget, data, size, theme}    a page widget → reply {value: html}
//   reply         as above, to the frame's call
export const V = 1;

/** Text limits: a label, a sentence, a navigation hash, a command name. */
const LABEL = 80;
const TEXT = 2000;
const HASH = 600;
const NAME = 80;
/** A command's arguments and a draw's data, as JSON. */
const MAX_JSON = 1024 * 1024;
/** Each list in a contribution. */
const MAX_ITEMS = 40;
/** A folder's path or a path in it. */
const PATH = 4096;
/** A skill's Markdown. */
const SKILL_MAX = 256 * 1024;
/** Files one drop hands a page. */
const MAX_FILES = 50;
const fileHandle = f => isObject(f) && exactly(f, ['file', 'name', 'size']) && text(f.file, 80) && text(f.name, 1024) && Number.isFinite(f.size) && f.size >= 0;
/** A slot's text (a chip, a menu item, a line), and how many a plugin gives one slot. */
const SLOT_TEXT = 300;
const MAX_SLOT_ITEMS = 8;
/** Ids of activities, sections, panels and widgets. */
const ITEM_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const text = (v, max) => typeof v === 'string' && v.length <= max;
const exactly = (o, keys) => Object.keys(o).every(k => keys.includes(k));
const jsonSize = v => {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? 0 : s.length;
  } catch {
    return Infinity;
  }
};

function envelope(m) {
  return isObject(m) && m.v === V && Number.isInteger(m.id) && m.id >= 0 && m.id < 2 ** 31 && typeof m.kind === 'string';
}

function reply(m) {
  if (m.ok === true) return exactly(m, ['v', 'id', 'kind', 'ok', 'value']) && jsonSize(m.value) <= MAX_JSON;
  return m.ok === false && exactly(m, ['v', 'id', 'kind', 'ok', 'error']) && isObject(m.error)
    && exactly(m.error, ['code', 'message']) && text(m.error.code, NAME) && text(m.error.message, TEXT);
}

const list = (v, item) => Array.isArray(v) && v.length <= MAX_ITEMS && v.every(item);
const labelled = x => isObject(x) && text(x.label, LABEL) && x.label.trim() !== '';

/** A message from a plugin's frame, or null when it isn't one the window accepts. */
export function checkFromFrame(m) {
  if (!envelope(m)) return null;
  switch (m.kind) {
    case 'call':
      if (m.method === 'command') {
        return exactly(m, ['v', 'id', 'kind', 'method', 'command', 'args', 'files']) && text(m.command, NAME) && m.command !== ''
          && jsonSize(m.args) <= MAX_JSON
          && (m.files === undefined || (Array.isArray(m.files) && m.files.length <= MAX_FILES && m.files.every(f => text(f, 80) && f !== ''))) ? m : null;
      }
      if (m.method === 'storage') {
        return exactly(m, ['v', 'id', 'kind', 'method', 'items']) && isObject(m.items)
          && Object.values(m.items).every(x => typeof x === 'string') && jsonSize(m.items) <= MAX_JSON ? m : null;
      }
      if (m.method === 'session') {
        return exactly(m, ['v', 'id', 'kind', 'method', 'folder', 'path', 'mode', 'profile']) && text(m.folder, PATH) && m.folder !== ''
          && text(m.path, PATH) && ['', 'read', 'edit'].includes(m.mode) && text(m.profile, NAME) ? m : null;
      }
      if (m.method === 'skill') {
        return exactly(m, ['v', 'id', 'kind', 'method', 'op', 'name', 'md']) && ['install', 'remove'].includes(m.op)
          && text(m.name, 64) && /^[a-z0-9-]{1,64}$/.test(m.name) && text(m.md, SKILL_MAX) ? m : null;
      }
      if (m.method === 'reveal') {
        return exactly(m, ['v', 'id', 'kind', 'method', 'root', 'path']) && text(m.root, PATH) && m.root !== '' && text(m.path, PATH) ? m : null;
      }
      return null;
    case 'reply':
      return reply(m) ? m : null;
    case 'event':
      switch (m.type) {
        case 'go': return exactly(m, ['v', 'id', 'kind', 'type', 'hash', 'replace']) && text(m.hash, HASH) && (m.replace === undefined || typeof m.replace === 'boolean') ? m : null;
        case 'notice': case 'copy':
          return exactly(m, ['v', 'id', 'kind', 'type', 'text']) && text(m.text, m.type === 'copy' ? 10000 : TEXT) ? m : null;
        case 'open': return exactly(m, ['v', 'id', 'kind', 'type', 'url']) && text(m.url, TEXT) && m.url !== '' ? m : null;
        case 'height': return exactly(m, ['v', 'id', 'kind', 'type', 'px']) && Number.isFinite(m.px) && m.px >= 0 && m.px <= 100000 ? m : null;
        case 'ready': return exactly(m, ['v', 'id', 'kind', 'type']) ? m : null;
        case 'error': return exactly(m, ['v', 'id', 'kind', 'type', 'message']) && text(m.message, TEXT) ? m : null;
        case 'slots': {
          const texts = v => Array.isArray(v) && v.length <= MAX_SLOT_ITEMS && v.every(x => text(x, SLOT_TEXT) && x.trim() !== '');
          return exactly(m, ['v', 'id', 'kind', 'type', 'call', 'header', 'menu', 'minutes']) && text(m.call, HASH)
            && texts(m.header) && texts(m.menu) && texts(m.minutes) ? m : null;
        }
        case 'sheet': return exactly(m, ['v', 'id', 'kind', 'type', 'open']) && typeof m.open === 'boolean' ? m : null;
        default: return null;
      }
    case 'contribution': {
      const ok = exactly(m, ['v', 'id', 'kind', 'activities', 'sections', 'card', 'panels', 'palette', 'widgets'])
        && list(m.activities, x => labelled(x) && exactly(x, ['id', 'label', 'badge']) && text(x.id, 64) && ITEM_ID.test(x.id) && (x.badge === undefined || text(x.badge, 8)))
        && list(m.sections, x => labelled(x) && exactly(x, ['id', 'label', 'badge']) && text(x.id, 64) && ITEM_ID.test(x.id) && text(x.badge, 8))
        && typeof m.card === 'boolean'
        && list(m.panels, x => labelled(x) && exactly(x, ['id', 'label']) && text(x.id, 64) && ITEM_ID.test(x.id))
        && list(m.palette, x => labelled(x) && exactly(x, ['label', 'keywords']) && text(x.keywords, 200))
        && list(m.widgets, x => text(x, 64) && ITEM_ID.test(x));
      return ok ? m : null;
    }
    default:
      return null;
  }
}

const THEMES = ['light', 'dark'];
const VIEWS = ['activity', 'section', 'card', 'none'];

function where(w) {
  return isObject(w) && exactly(w, ['view', 'section', 'route']) && text(w.view, HASH) && text(w.section, HASH) && text(w.route, HASH);
}

const CALL_KEYS = ['name', 'stamp', 'title', 'started_at', 'notes', 'profile', 'memo', 'threads', 'client'];
const orNull = (v, max) => v === null || text(v, max);

/** Echo's call, as a call page's slots get it: a meeting with a saved folder. */
function call(c) {
  return isObject(c) && exactly(c, CALL_KEYS) && CALL_KEYS.every(k => k in c)
    && text(c.name, HASH) && c.name !== '' && !/[/\\]/.test(c.name) && text(c.stamp, HASH) && text(c.title, TEXT)
    && orNull(c.started_at, 64) && typeof c.notes === 'boolean' && orNull(c.profile, NAME) && typeof c.memo === 'boolean'
    && Array.isArray(c.threads) && c.threads.length <= MAX_ITEMS && c.threads.every(t => text(t, NAME)) && orNull(c.client, NAME);
}

/** A message from Connect's window, or null. */
export function checkFromWindow(m) {
  if (!envelope(m)) return null;
  switch (m.kind) {
    case 'event':
      switch (m.type) {
        case 'connect':
          return exactly(m, ['v', 'id', 'kind', 'type', 'plugin', 'host', 'theme', 'where', 'storage'])
            && isObject(m.plugin) && text(m.plugin.id, 64) && isObject(m.host) && THEMES.includes(m.theme) && where(m.where)
            && isObject(m.storage) ? m : null;
        case 'theme': return exactly(m, ['v', 'id', 'kind', 'type', 'theme']) && THEMES.includes(m.theme) ? m : null;
        case 'show':
          return exactly(m, ['v', 'id', 'kind', 'type', 'target', 'where']) && isObject(m.target) && VIEWS.includes(m.target.view)
            && where(m.where) ? m : null;
        case 'palette': return exactly(m, ['v', 'id', 'kind', 'type', 'index']) && Number.isInteger(m.index) && m.index >= 0 ? m : null;
        case 'files': return exactly(m, ['v', 'id', 'kind', 'type', 'files']) && Array.isArray(m.files) && m.files.length <= MAX_FILES && m.files.every(fileHandle) ? m : null;
        case 'call': return exactly(m, ['v', 'id', 'kind', 'type', 'call', 'where']) && (m.call === null || call(m.call)) && where(m.where) ? m : null;
        case 'slot': return exactly(m, ['v', 'id', 'kind', 'type', 'slot', 'index']) && m.slot === 'call.menu' && Number.isInteger(m.index) && m.index >= 0 && m.index < MAX_SLOT_ITEMS ? m : null;
        case 'unload': return exactly(m, ['v', 'id', 'kind', 'type']) ? m : null;
        default: return null;
      }
    case 'call':
      return m.method === 'draw' && exactly(m, ['v', 'id', 'kind', 'method', 'widget', 'data', 'size', 'theme'])
        && text(m.widget, 64) && text(m.size, 2) && THEMES.includes(m.theme) ? m : null;
    case 'reply':
      return reply(m) ? m : null;
    default:
      return null;
  }
}

/** An error as it may cross: its code and its words, nothing else of it. */
export function errorOf(e) {
  const code = typeof e?.code === 'string' ? e.code.slice(0, NAME) : 'error';
  const message = String(e?.message ?? e ?? 'Something went wrong').slice(0, TEXT);
  return { code, message };
}
