// The real-app tour's runner (design docs/superpowers/specs/2026-11-24-real-app-tour-design.md § 5):
// walks the stops of `script.js` inside the tour build's own window and asks Rust to capture each
// one. Per stop: the view and theme (`settings_update`), the window size (`tour_window`), the
// route, a settle (no `.ws-loading` or `.ws-spinner`, two frames, at most 8 s), the action, the
// checks plus `noOverflow`, the focus probe (`tour_focus`) and the capture (`tour_capture`).
// A stop that throws fails with the error as its detail, and the tour goes on.
//
// Everything is passed in (`invoke`, `goHash`, `store`, `mutate`, `doc`, `raf`, `wait`), so
// node:test drives it over fakes. It sends nothing: every action is checked against `denied`
// before it clicks or mutates, and `gate` puts the same check in front of the window's own
// workspace calls.
import { STOPS, HEIGHT } from './script.js';

/** What an op, a `data-action` or a setting key may not name (design § 5's deny-list, with
 *  `refresh`: a marketplace's Fetch button is `market-refresh`). */
const DENY = /send|confirm|prepare|fetch|install|update|remove|delete|sign|login|test|refresh/i;
/** Ops the deny-list's words would catch that only change the window's own settings. */
const SAFE_OPS = new Set(['settings_update']);
/** Names refused whatever their kind: a login item would point at the tour binary (Task 1). */
const ALWAYS_DENIED = new Set(['launchAtLogin']);
/** The commands the runner may invoke: `plugins_request` only to read. */
const INVOKE_OK = new Set(['workspace_request', 'plugins_request:markets', 'plugins_request:installed', 'smoke_mode', 'get_app_version']);

const SETTLE_MS = 8000;
const SEND_REFUSAL = 'The tour sends nothing.';

/** Whether the tour refuses this op, `data-action` or command (`<cmd>` or `<cmd>:<op>`). */
export function denied(kind, name) {
  const n = String(name || '');
  if (ALWAYS_DENIED.has(n)) return true;
  if (kind === 'invoke') return !(INVOKE_OK.has(n) || n.startsWith('tour_'));
  if (kind === 'op' && SAFE_OPS.has(n)) return false;
  return DENY.test(n);
}

/** The names a workspace op is judged by: the op, and each setting a `settings_update` changes. */
function opNames(op, data) {
  return op === 'settings_update' && data && typeof data === 'object' ? [op, ...Object.keys(data)] : [op];
}

/** Error of a refused dispatch: what was refused, and that the tour sends nothing. */
function refusal(kind, name) {
  const err = new Error(`${SEND_REFUSAL} Refused ${kind} ${name}.`);
  err.code = 'tour';
  err.refused = { kind, name };
  return err;
}

/**
 * The window's invoke in front of its workspace store: records every `workspace_request` op in
 * `ops` and refuses (records in `refused`, never sends) one the deny-list names.
 */
export function gate(invoke, { ops, refused }) {
  return (cmd, args) => {
    if (cmd === 'workspace_request') {
      const op = String(args?.request?.op || '');
      ops.push(op);
      const bad = opNames(op, args?.request?.data).find(n => denied('op', n));
      if (bad) {
        refused.push({ kind: 'op', name: bad });
        return Promise.reject(refusal('op', bad));
      }
    }
    return invoke(cmd, args);
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
const short = text => (text.length > 160 ? `${text.slice(0, 160)}…` : text);
const valueAt = (obj, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), obj);

/** One check against the page: `{pass, detail}`. */
function judge(doc, c) {
  const els = shown(doc, c.selector);
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

/** Closes the menus a stop before left open: the app keeps an open ⋯ across its redraws. */
function closeMenus(doc) {
  for (const menu of all(doc, 'details[data-menu][open], details.ws-menu[open]')) menu.open = false;
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
 * text box, or a `mutate` of a settings or task op. Each gets `ctx` (`click`, `mutate`, `find`,
 * `settle`, `invoke`, `wait`, `doc`) and the stop's argument; `ctx.click` and `ctx.mutate`
 * refuse what the deny-list names before anything is dispatched.
 */
export const ACTIONS = {
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
  unfoldTask: (ctx, id) => ctx.click(`.ws-tdate-row[data-task="${id}"] .ws-tdate-main`),
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

/**
 * Runs the stops `only` names and returns the window's report: `{runId, stops, ops, refused}`.
 * `ops` and `refused` may be shared with `gate`, so they hold the window's own calls too.
 */
export async function runTour({
  invoke, goHash, store, mutate, doc, raf, only = 'all', runId = null,
  stops = STOPS, ops = [], refused = [],
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
    const blocked = [];
    const ctx = {
      doc, invoke: call, wait, settle, until,
      find: selector => {
        const el = doc.querySelector(selector);
        if (!el) throw new Error(`${selector} is not on the page`);
        return el;
      },
      click: async target => {
        const el = typeof target === 'string' ? ctx.find(target) : target;
        for (const name of [el.getAttribute?.('data-action'), el.getAttribute?.('data-key')].filter(Boolean)) {
          if (denied('action', name)) {
            blocked.push({ kind: 'action', name });
            throw refusal('action', name);
          }
        }
        el.click();
        await settle();
      },
      mutate: async (op, data) => {
        const bad = opNames(op, data).find(n => denied('op', n));
        if (bad) {
          blocked.push({ kind: 'op', name: bad });
          throw refusal('op', bad);
        }
        const out = await mutate(op, data);
        await settle();
        return out;
      },
    };
    const step = async (action, where) => {
      const fn = ACTIONS[action.name];
      if (!fn) throw new Error(`${where} "${action.name}" is not a tour action`);
      return fn(ctx, action.arg);
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
        await goHash(s.route);
        await settle();
      }
      const acted = s.action ? await step(s.action, 'action') : null;
      if (s.action?.name === 'menuBar') result.menuBar = acted;
      for (const c of s.checks) {
        let verdict;
        try {
          verdict = c.fact !== undefined ? judgeFact(result.menuBar, c) : judge(doc, c);
        } catch (e) {
          verdict = { pass: false, detail: String(e?.message || e) };
        }
        result.checks.push({ name: c.name, ...verdict });
      }
      if (capture) {
        result.checks.push({ name: 'noOverflow', ...overflow(doc) });
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
        const shot = await call('tour_capture', { id: s.id });
        result.capture = shot;
        const scene = [s.route, s.view, s.theme, s.width, s.action?.name || '', s.action?.arg || ''].join('|');
        const twin = hashes.find(h => h.sha256 === shot?.sha256 && h.scene !== scene);
        const detail = shot?.blank ? 'the capture is blank' : twin ? `the capture is identical to ${twin.id}'s (stale?)` : '';
        result.checks.push({ name: 'capture', pass: !detail, detail });
        hashes.push({ id: s.id, scene, sha256: shot?.sha256 });
      }
      if (s.after) await step(s.after, 'after');
    } catch (e) {
      result.error = String(e?.message || e);
    }
    for (const r of blocked) refused.push({ stop: s.id, ...r });
    result.ms = Date.now() - started;
    result.pass = !result.error && result.checks.length > 0 && result.checks.every(c => c.pass);
    results.push(result);
  }
  return { runId, stops: results, ops: [...ops], refused: [...refused] };
}
