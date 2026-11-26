// The real-app tour's runner (design docs/superpowers/specs/2026-11-24-real-app-tour-design.md § 5):
// walks the stops of `script.js` inside the tour build's own window and asks Rust to capture each
// one. Per stop: the view and theme (`settings_update`), the window size (`tour_window`), the
// route, a settle (no `.ws-loading` or `.ws-spinner`, two frames, at most 8 s), the action, the
// checks plus `noOverflow`, the focus probe (`tour_focus`) and the capture (`tour_capture`).
// A stop that throws fails with the error as its detail, and the tour goes on. After each stop
// the runner asks Rust what it refused (`tour_refused`): every refusal, the gate's and Rust's, is
// that stop's, and fails it unless the stop's `expectRefused` names it.
//
// Everything is passed in (`invoke`, `goHash`, `store`, `mutate`, `voice`, `doc`, `raf`, `wait`), so
// node:test drives it over fakes. It sends and opens nothing: every action is checked against
// `denied` before it clicks or mutates, and `gate` puts the same check in front of every call
// the window itself makes to native.
import { STOPS, HEIGHT } from './script.js';

/** What sends, writes elsewhere or installs (design § 5's deny-list, with `refresh`: a
 *  marketplace's Fetch button is `market-refresh`; `distil`: the import's Shorten with AI is
 *  an AI run; and `clear`: Ask's Clear history deletes every thread). */
const SENDS = /send|confirm|prepare|fetch|install(?!ed)|update|remove|delete|sign|login|test|refresh|distil|clear/i;
/** What opens something on the user's desktop: Finder, Terminal, a browser, a picker, a download. */
const OPENS = /open|reveal|pick|link|terminal|download/i;
/** The same for the window's own commands; its terminal dock's list and resize stay in the window. */
const OPENS_WINDOW = /open|reveal|pick|link|download|relaunch|restart/i;
/** Ops the deny-list's words would catch that only change the window's own settings. */
const SAFE_OPS = new Set(['settings_update']);
/** `data-action`s the open words would catch that only fold or switch something in the window. */
const IN_WINDOW = new Set(['task-row-open']);
/** Names refused whatever their kind: a login item would point at the tour binary (Task 1). */
const ALWAYS_DENIED = new Set(['launchAtLogin']);
/** What a stop's `allow` can never lift: a send, or the login item. */
const NEVER = /send|confirm|prepare/i;
/** The commands the runner may invoke: `plugins_request` only to read. */
const INVOKE_OK = new Set(['workspace_request', 'plugins_request:markets', 'plugins_request:installed', 'smoke_mode', 'get_app_version']);

/** The keys the `key` action presses: ⌘K and ⌘N open Ask and quick capture, Esc closes them.
 *  No other key: ⌘↩ runs the Inbox's visible Send. */
const KEYS = new Set(['k', 'n', 'Escape']);

const SETTLE_MS = 8000;
const SEND_REFUSAL = 'The tour sends nothing.';
const OPEN_REFUSAL = 'The tour opens nothing.';

/**
 * Whether the tour refuses this name: an op (`op`), a control's `data-action` or setting key
 * (`action`), a command the runner invokes (`invoke`, an allow-list), or a command the window
 * invokes (`window`; `<cmd>` or `plugins_request:<op>`).
 */
export function denied(kind, name) {
  const n = String(name || '');
  if (ALWAYS_DENIED.has(n)) return true;
  if (kind === 'invoke') return !(INVOKE_OK.has(n) || n.startsWith('tour_'));
  if (kind === 'op' && SAFE_OPS.has(n)) return false;
  if (kind === 'window') return n !== 'workspace_request' && (SENDS.test(n) || OPENS_WINDOW.test(n));
  if (kind === 'action' && IN_WINDOW.has(n)) return false;
  return SENDS.test(n) || OPENS.test(n);
}

/** Whether a stop's `allow` lifts the refusal of `name` (never a send or the login item). */
function lifted(allow, name) {
  return !!allow?.has(name) && !NEVER.test(name) && !ALWAYS_DENIED.has(name);
}

/** The names a workspace op is judged by: the op, and each setting a `settings_update` changes. */
function opNames(op, data) {
  return op === 'settings_update' && data && typeof data === 'object' ? [op, ...Object.keys(data)] : [op];
}

/** Error of a refused dispatch: what was refused, and that the tour sends (or opens) nothing. */
function refusal(kind, name) {
  const why = !SENDS.test(name) && OPENS.test(name) ? OPEN_REFUSAL : SEND_REFUSAL;
  const err = new Error(`${why} Refused ${kind} ${name}.`);
  err.code = 'tour';
  err.refused = { kind, name };
  return err;
}

/**
 * The window's own invoke, for every call it makes to native: records every `workspace_request`
 * op in `ops`, and refuses (records in `refused`, never sends) an op or a command the deny-list
 * names, unless the running stop's `allow` lifts it.
 */
export function gate(invoke, { ops, refused, allow = new Set() }) {
  return (cmd, args, options) => {
    let bad = null;
    let kind = 'window';
    if (cmd === 'workspace_request') {
      const op = String(args?.request?.op || '');
      ops.push(op);
      kind = 'op';
      bad = opNames(op, args?.request?.data).find(n => denied('op', n) && !lifted(allow, n));
    } else {
      const name = cmd === 'plugins_request' ? `${cmd}:${args?.op}` : String(cmd);
      if (denied('window', name) && !lifted(allow, name)) bad = name;
    }
    if (bad) {
      refused.push({ kind, name: bad });
      return Promise.reject(refusal(kind, bad));
    }
    return invoke(cmd, args, options);
  };
}

/** The stops `CODEMIE_TOUR` asks for: `all`, rollout steps (`0,3`) or stop ids (`T05,T21`). */
export function selectStops(stops, only = 'all') {
  const value = String(only ?? 'all').trim();
  if (!value || value === 'all') return stops.slice();
  const items = value.split(',').map(x => x.trim()).filter(Boolean);
  if (items.every(x => /^\d+$/.test(x))) {
    const steps = new Set(items.map(Number));
    return stops.filter(s => s.step.some(n => steps.has(n)));
  }
  const ids = new Set(items);
  return stops.filter(s => ids.has(s.id));
}

// ---------------------------------------------------------------- what a check sees

const fold = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const visible = el => (typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkOpacityCSS: true, checkVisibilityCSS: true }) : true);
const all = (doc, selector) => [...doc.querySelectorAll(selector)];
const shown = (doc, selector) => all(doc, selector).filter(visible);
const rectOf = el => el.getBoundingClientRect();
const short = text => (text.length > 160 ? `${text.slice(0, 160)}…` : text);
const valueAt = (obj, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), obj);

/** One check against the page: `{pass, detail}`. */
function judge(doc, c) {
  const els = c.any ? all(doc, c.selector) : shown(doc, c.selector);
  const text = fold(els.map(el => el.textContent).join(' '));
  if (c.absent) return { pass: els.length === 0, detail: els.length ? `${els.length} shown: ${short(text)}` : '' };
  if (c.count !== undefined && els.length !== c.count) return { pass: false, detail: `${els.length} shown, expected ${c.count}` };
  if (c.min !== undefined && els.length < c.min) return { pass: false, detail: `${els.length} shown, expected at least ${c.min}` };
  if (!els.length) return { pass: false, detail: 'nothing shown' };
  if (c.exact !== undefined && fold(els[0].textContent) !== c.exact) return { pass: false, detail: `reads "${short(fold(els[0].textContent))}"` };
  if (c.text !== undefined) {
    const wanted = [].concat(c.text);
    let from = 0;
    for (const w of wanted) {
      const at = c.order ? text.indexOf(w, from) : text.indexOf(w);
      if (at < 0) return { pass: false, detail: `"${w}" ${c.order && text.includes(w) ? 'out of order' : 'missing'} in "${short(text)}"` };
      if (c.order) from = at + w.length;
    }
  }
  if (c.notText !== undefined) {
    const found = [].concat(c.notText).find(w => text.includes(w));
    if (found) return { pass: false, detail: `says "${found}"` };
  }
  if (c.ids !== undefined) {
    const got = els.map(el => el.getAttribute('data-id'));
    if (JSON.stringify(got.slice(0, c.ids.length)) !== JSON.stringify(c.ids)) return { pass: false, detail: `ids ${got.join(', ')}` };
  }
  if (c.before !== undefined) {
    const other = shown(doc, c.before)[0];
    // DOCUMENT_POSITION_FOLLOWING: `other` comes after the first match.
    if (!other || !(els[0].compareDocumentPosition(other) & 4)) return { pass: false, detail: other ? `not before ${c.before}` : `${c.before} not shown` };
  }
  if (c.value !== undefined && els[0].value !== c.value) return { pass: false, detail: `holds "${short(String(els[0].value ?? ''))}"` };
  if (c.valueStarts !== undefined && !String(els[0].value ?? '').startsWith(c.valueStarts)) return { pass: false, detail: `holds "${short(String(els[0].value ?? ''))}"` };
  if (c.disabled !== undefined && !!els[0].disabled !== c.disabled) return { pass: false, detail: `disabled is ${!!els[0].disabled}` };
  if (c.focused !== undefined && (doc.activeElement === els[0]) !== c.focused) return { pass: false, detail: `focused is ${doc.activeElement === els[0]}` };
  if (c.attr !== undefined && els[0].getAttribute(c.attr[0]) !== c.attr[1]) return { pass: false, detail: `${c.attr[0]} is ${JSON.stringify(els[0].getAttribute(c.attr[0]))}` };
  if (c.below !== undefined || c.over !== undefined) {
    const other = all(doc, c.below ?? c.over)[0];
    if (!other) return { pass: false, detail: `${c.below ?? c.over} not on the page` };
    const [a, b] = [rectOf(els[0]), rectOf(other)];
    if (c.below !== undefined && !(a.top >= b.bottom - 2)) return { pass: false, detail: `top ${Math.round(a.top)} is above ${Math.round(b.bottom)}` };
    if (c.over !== undefined && !['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= 1)) return { pass: false, detail: `at ${JSON.stringify([a.x, a.y, a.width, a.height].map(Math.round))}, not over ${JSON.stringify([b.x, b.y, b.width, b.height].map(Math.round))}` };
  }
  if (c.stacked !== undefined) {
    const [upper, lower] = c.stacked.map(sel => els[0].querySelector(sel));
    if (!upper || !lower) return { pass: false, detail: `${c.stacked.join(' / ')} not in the first match` };
    if (!(rectOf(upper).bottom <= rectOf(lower).top + 1)) return { pass: false, detail: `${c.stacked[1]} is beside ${c.stacked[0]}, not under it` };
  }
  if (c.css !== undefined) {
    const [property, value] = c.css;
    const got = doc.defaultView.getComputedStyle(els[0]).getPropertyValue(property);
    if (got !== value) return { pass: false, detail: `${property} is ${got || '(none)'}, expected ${value}` };
  }
  return { pass: true, detail: '' };
}

/** A menu-bar check over `tour_menu_bar`'s answer. */
function judgeFact(facts, c) {
  const got = valueAt(facts, c.fact);
  if (c.equals !== undefined && got !== c.equals) return { pass: false, detail: `${c.fact} is ${JSON.stringify(got)}` };
  if (c.min !== undefined && !(Number(got) >= c.min)) return { pass: false, detail: `${c.fact} is ${JSON.stringify(got)}` };
  return { pass: true, detail: '' };
}

/** How many times `c.op` was sent to native during this stop (`sent`, the ops recorded since it
 *  started): `c.count` (exact). Catches a listener or event (re)triggering the same mutate more
 *  than once, e.g. task-provider design §11 ruling 16's "switches once". */
function judgeOps(sent, c) {
  const got = sent.filter(op => op === c.op).length;
  if (c.count !== undefined && got !== c.count) return { pass: false, detail: `${c.op} sent ${got} time${got === 1 ? '' : 's'}, expected ${c.count}` };
  return { pass: true, detail: '' };
}

/** Closes the menus a stop before left open: the app keeps an open ⋯ across its redraws. */
function closeMenus(doc) {
  for (const menu of all(doc, 'details[data-menu][open], details.ws-menu[open]')) menu.open = false;
}

/** Takes away the toasts a stop before left, so a stop's picture and its toast checks are its
 *  own (the browser run's checks remove them too). */
function clearToasts(doc) {
  for (const t of all(doc, '.ws-toast')) t.remove?.();
}

/** What the browser run's `noClip` looks at (compact-checks.mjs `CLIP_SELECTORS`, with the reply
 *  bar's hint and change line, reply-checks.mjs `noClipPlus`). */
export const CLIP_SELECTORS = ['.ws-btn', '.ws-nav button', '.ws-menu-item', '.ws-lane', '.ws-segmented button', '.ws-inbox-row', '.ws-input',
  '.ws-inbox-row-compact', '.ws-crow-from', '.ws-crow-title', '.ws-reply-bar', '.ws-thread-earlier', '.ws-menu-field', '.ws-reply-hint', '.ws-reply-change'];

/** Nothing the user can see overflows its box vertically, or is cut off sideways without an
 *  ellipsis (the browser run's `noClip`). */
function noClip(doc) {
  const out = [];
  for (const el of all(doc, CLIP_SELECTORS.join(','))) {
    // An open menu's panel overflows its control on purpose: it lies over the page.
    if (!visible(el) || el.querySelector?.('details[open]')) continue;
    const heightClip = el.scrollHeight > el.clientHeight + 1;
    const widthClip = el.scrollWidth > el.clientWidth + 1 && doc.defaultView.getComputedStyle(el).textOverflow !== 'ellipsis';
    if (!heightClip && !widthClip) continue;
    const sel = CLIP_SELECTORS.find(x => el.matches?.(x)) || 'element';
    out.push(`${sel} "${fold(el.textContent).slice(0, 40)}" (${heightClip ? 'height' : 'width'})`);
  }
  return { pass: out.length === 0, detail: out.slice(0, 6).join(' | ') + (out.length > 6 ? ` | and ${out.length - 6} more` : '') };
}

/** The page and the main column are no wider than the window. */
function overflow(doc) {
  const page = doc.documentElement;
  const main = doc.getElementById?.('workspace-main');
  const over = Math.max((page?.scrollWidth || 0) - (page?.clientWidth || 0), main ? (main.scrollWidth || 0) - (main.clientWidth || 0) : 0);
  return { pass: over <= 0, detail: over > 0 ? `overflows sideways by ${over}px` : '' };
}

// ---------------------------------------------------------------- the actions

/** Which lane shows each seeded conversation (reply-checks.mjs `LANE_OF`). */
const LANE_OF = { 'c-reply-1': 'reply', 'c-reply-2': 'reply', 'm-reply-1': 'reply', 'm-reply-2': 'reply', 'm-critical': 'critical' };

/**
 * The in-app steps a stop can take: DOM clicks on the app's own controls, an `input` event on a
 * text box, a `keydown` DOM event, a `mutate` of a settings or task op, or a read (`query`). Each gets `ctx` (`click`,
 * `mutate`, `query`, `find`, `settle`, `invoke`, `wait`, `doc`, `store`, `voice`) and the stop's
 * argument; `ctx.click`, `ctx.mutate` and `ctx.query` refuse what the deny-list names before
 * anything is dispatched.
 */
export const ACTIONS = {
  /** A click on the app's own control (`selector`). */
  click: (ctx, selector) => ctx.click(selector),
  /** A store action: `{op, data}` through the window's `mutate`. */
  mutate: (ctx, { op, data }) => ctx.mutate(op, data),
  /** Another of the app's own routes. */
  go: async (ctx, hash) => {
    await ctx.goHash(hash);
    await ctx.settle();
  },
  /** Opens a menu (`details` at `selector`) as its summary's click does. */
  menu: (ctx, selector) => openMenu(ctx, selector),
  /** Types `{selector, text}` into a text box (an `input` event, as typing gives). */
  type: async (ctx, { selector, text }) => {
    const box = ctx.find(selector);
    box.focus?.();
    box.value = text;
    box.dispatchEvent(new (ctx.doc.defaultView?.Event || Event)('input', { bubbles: true }));
    await ctx.settle();
  },
  /** A key pressed in the window: one `keydown` DOM event (never an OS one) on the document, as
   *  a shortcut reaches it, or on the control `on` names (Esc in a text box). Only `KEYS`. */
  key: async (ctx, { key, meta = false, ctrl = false, on = null }) => {
    if (!KEYS.has(key)) throw new Error(`"${key}" is not a key the tour presses`);
    const target = on ? ctx.find(on) : ctx.doc;
    const KeyboardEventOf = ctx.doc.defaultView?.KeyboardEvent || KeyboardEvent;
    target.dispatchEvent(new KeyboardEventOf('keydown', { key, metaKey: !!meta, ctrlKey: !!ctrl, bubbles: true, cancelable: true }));
    await ctx.settle();
  },
  /** Waits until `selector` shows (at most 8 s). */
  until: (ctx, selector) => ctx.until(() => ctx.doc.querySelector(selector)).catch(() => {
    throw new Error(`${selector} did not show within 8 s`);
  }),
  /** Waits until `{selector}`'s text holds `{text}` (at most 8 s). */
  untilText: (ctx, { selector, text }) => ctx.until(() => all(ctx.doc, selector).some(el => fold(el.textContent).includes(text))).catch(() => {
    throw new Error(`"${text}" did not show in ${selector} within 8 s`);
  }),
  /** Waits `ms` (an animation, an autosave). */
  wait: (ctx, ms) => ctx.wait(ms),
  /** Compact: opens a conversation's row in place (on its lane first). */
  openRow: (ctx, id) => openConversation(ctx, id),
  /** Default: selects a conversation into the reading pane (on its lane first). */
  selectRow: (ctx, id) => openConversation(ctx, id),
  /** Opens a ⋯ menu: `reply:<id>` (the open conversation's reply bar) or `meeting` (the strip). */
  openMore: async (ctx, scope) => {
    const [kind, id] = String(scope).split(':');
    if (kind === 'reply') {
      await openConversation(ctx, id);
      return openMenu(ctx, `.ws-crow-body[data-message-id="${id}"] details[data-menu="reply-more"], .ws-read[data-message-id="${id}"] details[data-menu="reply-more"]`);
    }
    return openMenu(ctx, '.ws-mtg-strip > .ws-menu');
  },
  /** Types `<id>:<text>` into that conversation's reply box, then waits out the autosave. */
  typeReply: async (ctx, arg) => {
    const at = String(arg).indexOf(':');
    const [id, text] = [arg.slice(0, at), arg.slice(at + 1)];
    await openConversation(ctx, id);
    const box = ctx.find('#reply-body');
    box.focus?.();
    box.value = text;
    box.dispatchEvent(new (ctx.doc.defaultView?.Event || Event)('input', { bubbles: true }));
    await ctx.settle();
    // Autosave runs 1.5 s after typing stops (reply-checks.mjs R9).
    await ctx.wait(2000);
    box.blur?.();
  },
  openTodayMore: ctx => openMenu(ctx, '.ws-today-actions details[data-menu="today-more"]'),
  hidePage: (ctx, id) => setPage(ctx, id, false),
  showPage: (ctx, id) => setPage(ctx, id, true),
  /** Unfolds a By date row (a row left open stays open). */
  unfoldTask: async (ctx, id) => {
    if (ctx.doc.querySelector(`.ws-tdate-row[data-task="${id}"].ws-tdate-open`)) return;
    await ctx.click(`.ws-tdate-row[data-task="${id}"] .ws-tdate-main`);
  },
  setProvider: (ctx, provider) => ctx.mutate('task_provider_set', { provider }),
  useTemplate: async (ctx, id) => {
    await ctx.click(`[data-action="automation-template"][data-id="${id}"]`);
    await ctx.until(() => ctx.doc.querySelector('.ws-modal[open] #automation-editor'));
    // The dialog fades in (automations-checks.mjs `editorOpen` waits 250 ms too).
    await ctx.wait(400);
  },
  cancelModal: ctx => ctx.click('.ws-modal[open] .ws-modal-footer [data-modal-close]'),
  /** A meeting's other pane back to its summary ("← Back to summary"). */
  backToSummary: ctx => ctx.click('.ws-mtg-strip [data-action="meeting-back"]'),
  unfoldRun: async (ctx, id) => {
    await ctx.click(`.ws-run-row[data-id="${id}"]`);
    await ctx.until(() => ctx.doc.querySelector(`#run-${id}`));
  },
  /** Settings › Your voice: the import preview of the seed's skills folder `name`, which seed.mjs
   *  puts in the test folder beside the meetings root. The tour opens no picker, so the scan's
   *  answer is handed to the voice controller as the picker's path would be. */
  voiceImport: async (ctx, name) => {
    const root = ctx.store.get()?.snapshot?.settings?.meetings?.root;
    if (!root) throw new Error('the seed’s meetings root is not in the snapshot');
    const path = `${root.replace(/\/[^/]+\/?$/, '')}/${name}`;
    const preview = await ctx.query('voice_import_scan', { path });
    await ctx.voice.openImport(preview, path);
    await ctx.until(() => ctx.doc.querySelector('.ws-voice-import'));
  },
  /** The menu bar's computed state: there is no tray in a tour to photograph. */
  menuBar: async ctx => {
    const facts = await ctx.invoke('tour_menu_bar');
    const applied = facts?.applied;
    const computed = facts?.computed;
    return {
      ...facts,
      appliedEqualsComputed: !!applied && !!computed && applied.title === computed.label && applied.amber === computed.amber,
    };
  },
};

async function openConversation(ctx, id) {
  const open = `.ws-crow-body[data-message-id="${id}"] .ws-reply-bar, .ws-read[data-message-id="${id}"] .ws-reply-bar`;
  if (ctx.doc.querySelector(open)) return;
  const rowSel = `.ws-inbox-row[data-id="${id}"]`;
  // Its lane first (reply-checks.mjs `LANE_OF`), then the others: the lane is native's call.
  const expected = LANE_OF[id] || 'reply';
  const lanes = [expected, ...all(ctx.doc, '.ws-lane[data-lane]').map(el => el.getAttribute('data-lane')).filter(l => l !== expected)];
  const tried = [];
  for (const lane of lanes) {
    if (ctx.doc.querySelector(rowSel)) break;
    const tab = ctx.doc.querySelector(`.ws-lane[data-lane="${lane}"]`);
    if (!tab) continue;
    tried.push(lane);
    if (tab.getAttribute('aria-selected') !== 'true') await ctx.click(tab);
  }
  const row = ctx.doc.querySelector(rowSel);
  if (!row) throw new Error(`${rowSel} is in no lane (tried ${tried.join(', ') || 'none'})`);
  await ctx.click(row);
  await ctx.until(() => ctx.doc.querySelector(open));
}

async function openMenu(ctx, selector) {
  const menu = ctx.find(selector);
  if (menu.open) return;
  const summary = menu.querySelector?.(':scope > summary');
  if (summary) await ctx.click(summary);
  // A synthetic click may not toggle a <details> in every engine; open it as the click would.
  if (!menu.open) {
    menu.open = true;
    menu.dispatchEvent(new (ctx.doc.defaultView?.Event || Event)('toggle'));
  }
  await ctx.settle();
}

async function setPage(ctx, id, on) {
  const sw = ctx.find(`input[data-action="menu-page"][data-page="${id}"]`);
  if (!!sw.checked !== on) await ctx.click(sw);
}

// ---------------------------------------------------------------- the run

/** One refusal as the report names it: `<kind> <name> (<message>)`. */
const describeRefusal = r => `${r.kind} ${r.name}${r.message ? ` (${r.message})` : ''}`;

/**
 * Marks the refusals since `from` as stop `s`'s (and `expected` when `s.expectRefused` names
 * them), and adds its `refused` check: it fails on a refusal the stop didn't expect, or an
 * expected one that never came (design § 8, final review I2). No check when there is neither.
 */
function judgeRefused(s, refused, from, result) {
  const expect = new Set(s.expectRefused || []);
  const mine = [];
  for (let i = from; i < refused.length; i++) {
    const r = { stop: s.id, ...refused[i] };
    if (expect.has(r.name)) r.expected = true;
    refused[i] = r;
    mine.push(r);
  }
  if (!mine.length && !expect.size) return;
  const wrong = [
    ...mine.filter(r => !r.expected).map(describeRefusal),
    ...[...expect].filter(n => !mine.some(r => r.name === n)).map(n => `${n} was expected but not refused`),
  ];
  result.checks.push({ name: 'refused', pass: !wrong.length, detail: wrong.join(' | ') });
}

/**
 * Runs the stops `only` names and returns the window's report: `{runId, stops, ops, refused}`.
 * `ops` and `refused` may be shared with `gate`, so they hold the window's own calls too.
 */
export async function runTour({
  invoke, goHash, store, mutate, voice = null, doc, raf, only = 'all', runId = null,
  stops = STOPS, ops = [], refused = [], allow = new Set(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const call = (cmd, args) => {
    const name = cmd === 'plugins_request' ? `${cmd}:${args?.op}` : cmd;
    if (denied('invoke', name)) throw refusal('invoke', name);
    return invoke(cmd, args);
  };
  const frame = () => new Promise(resolve => raf(() => resolve()));
  const settle = async () => {
    const started = Date.now();
    while (doc.querySelector('.ws-loading, .ws-spinner') && Date.now() - started < SETTLE_MS) await wait(50);
    await frame();
    await frame();
  };
  const until = async probe => {
    const started = Date.now();
    while (!probe()) {
      if (Date.now() - started >= SETTLE_MS) throw new Error('it did not show within 8 s');
      await wait(50);
    }
    await settle();
  };
  const hashes = [];
  const results = [];

  for (const s of selectStops(stops, only)) {
    const result = {
      id: s.id, step: s.step, title: s.title, route: s.route, view: s.view, theme: s.theme, width: s.width,
      checks: [], capture: null, viewport: null, error: null, pass: false,
    };
    const started = Date.now();
    // Every refusal from here to the stop's end is this stop's: the runner's own, the window
    // gate's (pushed into the shared `refused`) and Rust's (asked for below).
    const refusedBefore = refused.length;
    for (const name of s.allow || []) allow.add(name);
    const ctx = {
      doc, invoke: call, wait, settle, until, goHash, store, voice,
      find: selector => {
        const el = doc.querySelector(selector);
        if (!el) throw new Error(`${selector} is not on the page`);
        return el;
      },
      click: async target => {
        const el = typeof target === 'string' ? ctx.find(target) : target;
        for (const name of [el.getAttribute?.('data-action'), el.getAttribute?.('data-key')].filter(Boolean)) {
          if (denied('action', name) && !lifted(allow, name)) {
            refused.push({ kind: 'action', name });
            throw refusal('action', name);
          }
        }
        el.click();
        await settle();
      },
      mutate: async (op, data) => {
        const bad = opNames(op, data).find(n => denied('op', n) && !lifted(allow, n));
        if (bad) {
          refused.push({ kind: 'op', name: bad });
          throw refusal('op', bad);
        }
        const out = await mutate(op, data);
        await settle();
        return out;
      },
      /** A read through the window's own store (its call is gated and recorded like a mutate). */
      query: async (op, data) => {
        if (denied('op', op) && !lifted(allow, op)) {
          refused.push({ kind: 'op', name: op });
          throw refusal('op', op);
        }
        return store.query(op, data);
      },
    };
    // One action, or a list of them run in order; the last one's answer is kept.
    const step = async (action, where) => {
      let out = null;
      for (const a of [].concat(action)) {
        const fn = ACTIONS[a.name];
        if (!fn) throw new Error(`${where} "${a.name}" is not a tour action`);
        out = await fn(ctx, a.arg);
      }
      return out;
    };
    try {
      const capture = s.capture !== false;
      if (capture) {
        const settings = store.get()?.snapshot?.settings || {};
        const change = {};
        if (s.view && (settings.view || 'default') !== s.view) change.view = s.view;
        if (s.theme && settings.theme !== s.theme) change.theme = s.theme;
        if (Object.keys(change).length) await ctx.mutate('settings_update', change);
        await call('tour_window', { width: s.width, height: HEIGHT });
        closeMenus(doc);
        clearToasts(doc);
        await goHash(s.route);
        await settle();
      }
      const opsBefore = ops.length;
      const acted = s.action ? await step(s.action, 'action') : null;
      if ([].concat(s.action || []).some(a => a.name === 'menuBar')) result.menuBar = acted;
      const sentThisStop = ops.slice(opsBefore);
      for (const c of s.checks) {
        let verdict;
        try {
          verdict = c.fact !== undefined ? judgeFact(result.menuBar, c)
            : c.op !== undefined ? judgeOps(sentThisStop, c)
              : judge(doc, c);
        } catch (e) {
          verdict = { pass: false, detail: String(e?.message || e) };
        }
        result.checks.push({ name: c.name, ...verdict });
      }
      if (capture) {
        result.checks.push({ name: 'noOverflow', ...overflow(doc) });
        result.checks.push({ name: 'noClip', ...noClip(doc) });
        const view = doc.defaultView || {};
        result.viewport = { innerWidth: view.innerWidth ?? null, innerHeight: view.innerHeight ?? null, window: { width: s.width, height: HEIGHT } };
      }
      const focus = await call('tour_focus');
      result.focus = focus;
      result.checks.push({ name: 'focus', pass: !focus?.appActive && !focus?.windowKey, detail: focus?.appActive || focus?.windowKey ? `appActive ${!!focus?.appActive}, windowKey ${!!focus?.windowKey}` : '' });
      if (capture && s.scroll) {
        // The part the checks are about, in view for the picture (the browser run's shots do too).
        ctx.find(s.scroll).scrollIntoView?.({ block: 'start' });
        await settle();
      }
      if (capture) {
        // A plugin frame's own box is judged on its own: a frame that drew nothing is blank there.
        const frameEl = s.frame ? ctx.find(s.frame) : null;
        const r = frameEl?.getBoundingClientRect();
        const region = r ? { x: r.x, y: r.y, width: r.width, height: r.height, viewWidth: doc.defaultView?.innerWidth ?? s.width } : undefined;
        const shot = await call('tour_capture', region ? { id: s.id, region } : { id: s.id });
        result.capture = shot;
        const scene = [s.route, s.view, s.theme, s.width, JSON.stringify(s.action || null)].join('|');
        const twin = hashes.find(h => h.sha256 === shot?.sha256 && h.scene !== scene);
        const detail = shot?.blank ? 'the capture is blank' : twin ? `the capture is identical to ${twin.id}'s (stale?)` : '';
        result.checks.push({ name: 'capture', pass: !detail, detail });
        if (region) result.checks.push({ name: 'frame area', pass: shot?.regionBlank === false, detail: shot?.regionBlank === false ? '' : 'the frame’s area of the capture is blank' });
        hashes.push({ id: s.id, scene, sha256: shot?.sha256 });
      }
      if (s.next) {
        // A second picture of the same stop: its own action, checks and capture (`<id>-next`).
        const opsBeforeNext = ops.length;
        await step(s.next.action, 'next');
        const sentInNext = ops.slice(opsBeforeNext);
        for (const c of s.next.checks) {
          let verdict;
          try {
            verdict = c.op !== undefined ? judgeOps(sentInNext, c) : judge(doc, c);
          } catch (e) {
            verdict = { pass: false, detail: String(e?.message || e) };
          }
          result.checks.push({ name: `next: ${c.name}`, ...verdict });
        }
        result.checks.push({ name: 'next: noClip', ...noClip(doc) });
        const shot = await call('tour_capture', { id: `${s.id}-next` });
        result.next = { title: s.next.title, capture: shot };
        result.checks.push({ name: 'next: capture', pass: !shot?.blank, detail: shot?.blank ? 'the capture is blank' : '' });
      }
      if (s.after) await step(s.after, 'after');
    } catch (e) {
      result.error = String(e?.message || e);
    }
    for (const name of s.allow || []) allow.delete(name);
    try {
      for (const r of (await call('tour_refused')) || []) refused.push({ kind: 'native', ...r });
    } catch (e) {
      result.error = result.error || `Rust's refusals could not be read: ${String(e?.message || e)}`;
    }
    judgeRefused(s, refused, refusedBefore, result);
    result.ms = Date.now() - started;
    result.pass = !result.error && result.checks.length > 0 && result.checks.every(c => c.pass);
    results.push(result);
  }
  return { runId, stops: results, ops: [...ops], refused: [...refused] };
}
