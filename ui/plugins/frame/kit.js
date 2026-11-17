// The host's building blocks a plugin's client half draws with (PLUGIN-ENGINE.md §5.2): the same
// names and arguments as Echo's, written for Connect, styled by echo-compat.css. Titles, subs and
// controls are HTML the plugin built; every text a plugin puts in goes through `esc` first.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text as HTML. */
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c]);

/** One settings row: a bold title, an optional line under it, and its controls on the right. */
export const setRow = (title, sub, control = '', id = '', name = '') =>
  `<div class="set-row"${id ? ` id="set-${esc(id)}"` : ''}${name ? ` role="group" aria-label="${esc(name)}"` : ''}><div class="set-text"><b>${title ?? ''}</b>${sub ? `<div class="set-sub">${sub}</div>` : ''}</div><div class="set-ctl">${control ?? ''}</div></div>`;

/** A card of rows under an optional heading (plain text). */
export const setCard = (head, rows) =>
  `<section class="set-sec">${head ? `<h3>${esc(head)}</h3>` : ''}<div class="set-card">${(rows || []).join('')}</div></section>`;

/** A switch: `data-set` names the setting and `data-val` the value a click sets. */
export const sw = (key, on, label) =>
  `<button type="button" class="sw${on ? ' on' : ''}" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" data-set="${esc(key)}" data-val="${!on}"></button>`;

/** A 20px stroke icon from an SVG path's markup. */
export const ICON = d => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A day as people say it: today, yesterday, or "3 Nov" (with the year when it isn't this one). */
export function relDay(d, now = new Date()) {
  if (!d) return '';
  const at = String(d).length > 10 ? new Date(d) : null;
  const day = at && !Number.isNaN(at.getTime()) ? ymd(at) : String(d).slice(0, 10);
  const today = new Date(now);
  if (day === ymd(today)) return 'today';
  today.setDate(today.getDate() - 1);
  if (day === ymd(today)) return 'yesterday';
  const [y, m, dd] = day.split('-').map(Number);
  if (!y || !m || !dd) return day;
  return `${dd} ${MONTHS[m - 1]}${y !== new Date(now).getFullYear() ? ` ${y}` : ''}`;
}

/** How long ago a time was: "12 s ago", "5 min ago", "3 h ago", "2 d ago". */
export function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ---------------------------------------------------------------- patch

/** Replaces `el`'s content with `html`, keeping the elements that stay (and so the focus, the
 *  caret, scroll positions and a drawn graph). A box a graph is drawn in keeps its canvas. */
export function patch(el, html) {
  const doc = el.ownerDocument;
  const t = doc.createElement('template');
  t.innerHTML = String(html ?? '');
  morphChildren(el, t.content, doc);
}

const KEEP = 'data-cx-graph';

function sameNode(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a.nodeType !== 1) return true;
  return (a.getAttribute('id') || '') === (b.getAttribute('id') || '');
}

function morphChildren(from, to, doc) {
  const next = [...to.childNodes];
  let i = 0;
  for (; i < next.length; i++) {
    const want = next[i];
    const have = from.childNodes[i];
    if (!have) {
      from.appendChild(want);
    } else if (!sameNode(have, want)) {
      from.replaceChild(want, have);
    } else if (have.nodeType === 1) {
      morphElement(have, want, doc);
    } else if (have.nodeValue !== want.nodeValue) {
      have.nodeValue = want.nodeValue;
    }
  }
  while (from.childNodes.length > next.length) from.lastChild.remove();
}

function morphElement(have, want, doc) {
  const kept = have.hasAttribute(KEEP);
  for (const a of [...have.attributes]) if (!want.hasAttribute(a.name) && a.name !== KEEP) have.removeAttribute(a.name);
  for (const a of [...want.attributes]) if (have.getAttribute(a.name) !== a.value) have.setAttribute(a.name, a.value);
  if (kept) return;
  const tag = have.tagName;
  const focused = doc.activeElement === have;
  if (tag === 'TEXTAREA') {
    if (have.defaultValue !== want.defaultValue) have.defaultValue = want.defaultValue;
    if (!focused) have.value = want.value;
    return;
  }
  morphChildren(have, want, doc);
  if (tag === 'INPUT' && !focused) {
    have.value = want.getAttribute('value') ?? '';
    have.checked = want.hasAttribute('checked');
  }
  if (tag === 'SELECT' && !focused) {
    const chosen = [...want.options].find(o => o.hasAttribute('selected'));
    have.value = chosen ? chosen.value : (want.options[0]?.value ?? '');
  }
}

export const GRAPH_MARK = KEEP;
