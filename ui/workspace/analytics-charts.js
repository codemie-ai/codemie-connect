// Hand-drawn SVG charts for the Analytics page, ported from the prototype's charts.js: columns,
// stacked columns and a cumulative area line. Pure: each takes the width it gets and its options
// and returns an SVG string. Bars are at most 24 px with a 4 px rounded data end, a 2 px gap
// between stacked parts, a hairline grid and one axis. Every mark carries its tooltip as escaped
// HTML in `data-an-tip` (the area line a series in `data-an-xtip`), which the page's tooltip layer
// shows (analytics-controller.js `attachAnalyticsTips`).
import { escapeHtml as e } from './store.js';

/** A tooltip's HTML: a title, rows of `{value, label, color}` and a note, or a sentence (`text`). */
export function tipHtml({ title, rows = [], note, text } = {}) {
  return `${title ? `<div class="ws-an-tt">${e(title)}</div>` : ''}${rows.map(r => `<div class="ws-an-tr">${r.color ? `<i class="ws-an-key" style="background:${e(r.color)}"></i>` : ''}<b>${e(r.value)}</b><span>${e(r.label)}</span></div>`).join('')}${note ? `<div class="ws-an-note">${e(note)}</div>` : ''}${text ? `<div class="ws-an-tx">${e(text)}</div>` : ''}`;
}

function niceStep(max, count, whole) {
  if (max <= 0) return 1;
  const raw = max / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  let step = 10 * p;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * p >= raw) {
      step = m * p;
      break;
    }
  }
  return whole ? Math.max(1, Math.round(step)) : step;
}

function ticks(max, whole, count = 3) {
  const step = niceStep(max, count, whole);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const out = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(v);
  return { top, out };
}

/** A bar with its top corners rounded and a square baseline. */
function barPath(x, y, w, h, r) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  const b = y + h;
  return `M${x},${b}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${b}Z`;
}

/** The frame both column charts share: grid, axis labels, the "not read yet" wash, one band per
 *  item (its bars from `marks`, a hit area and a tooltip) and the x labels. */
function frame(width, o, totals, marks) {
  const H = o.height || 190;
  const padL = 44;
  const padB = 22;
  const padT = 8;
  const n = o.items.length;
  const iw = Math.max(40, width - padL - 4);
  const ih = H - padB - padT;
  const { top, out } = ticks(Math.max(0, ...totals), o.whole);
  const band = iw / Math.max(1, n);
  const bw = Math.max(2, Math.min(24, band * 0.62));
  const y = v => padT + ih - (v / top) * ih;
  let s = `<svg class="ws-an-svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="${e(o.aria || 'Column chart')}">`;
  for (const v of out) s += `<line class="ws-an-gl" x1="${padL}" x2="${width}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 8}" y="${y(v) + 3.5}" text-anchor="end">${e(o.fmtAxis(v))}</text>`;
  if (o.pending) {
    // Days not read yet: a quiet wash, never drawn as zero.
    let first = -1;
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (o.pending(i)) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first >= 0) {
      const x0 = padL + band * first;
      const w = band * (last - first + 1);
      s += `<rect class="ws-an-wash" x="${x0}" y="${padT}" width="${w}" height="${ih}" rx="4"/>`;
      if (w > 110) s += `<text class="ws-an-wash-label" x="${x0 + w / 2}" y="${padT + ih / 2 + 4}" text-anchor="middle">Still reading…</text>`;
    }
  }
  s += '<g class="ws-an-cols">';
  const every = n <= 8 ? 1 : n <= 16 ? 2 : n <= 31 ? 5 : Math.ceil(n / 7);
  for (let i = 0; i < n; i++) {
    const cx = padL + band * i + band / 2;
    s += `<g class="ws-an-band" tabindex="0" data-an-tip="${e(tipHtml(o.tip(i)))}">${marks(i, cx - bw / 2, bw, y)}<rect class="ws-an-hit" x="${padL + band * i}" y="${padT}" width="${band}" height="${ih + padB}"/></g>`;
    if (i % every === 0 || (n > 8 && i === n - 1 && (n - 1) % every > every / 2)) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${e(o.label(i))}</text>`;
  }
  return `${s}</g><line class="ws-an-base" x1="${padL}" x2="${width}" y1="${y(0) + 0.5}" y2="${y(0) + 0.5}"/></svg>`;
}

/**
 * Columns: `{items, value(i), label(i), tip(i), fmtAxis, height, aria, color, pending(i), whole}`.
 * `pending` marks items not read yet; `whole` keeps the axis on whole numbers (counts).
 */
export function columns(width, o) {
  const totals = o.items.map((_, i) => o.value(i));
  return frame(width, o, totals, (i, x, bw, y) => (totals[i] > 0
    ? `<path class="ws-an-bar" fill="${e(o.color || 'var(--ws-an-bar)')}" d="${barPath(x, y(totals[i]), bw, Math.max(1.5, y(0) - y(totals[i])), 4)}"/>`
    : ''));
}

/** Stacked columns: as `columns`, with `keys`, `colors` ({key: css colour}) and `part(i, key)`. */
export function stackedColumns(width, o) {
  const totals = o.items.map((_, i) => o.keys.reduce((a, k) => a + o.part(i, k), 0));
  return frame(width, o, totals, (i, x, bw, y) => {
    let acc = 0;
    const keys = o.keys.filter(k => o.part(i, k) > 0);
    return keys.map((k, j) => {
      const v = o.part(i, k);
      const y0 = y(acc + v);
      const h = Math.max(0, y(acc) - y0 - (j ? 2 : 0)); // a 2 px surface gap above every lower part
      acc += v;
      const fill = e(o.colors[k]);
      return j === keys.length - 1 ? `<path class="ws-an-bar" fill="${fill}" d="${barPath(x, y0, bw, h, 4)}"/>` : `<rect class="ws-an-bar" fill="${fill}" x="${x}" y="${y0}" width="${bw}" height="${h}"/>`;
    }).join('');
  });
}

/**
 * A cumulative area line over a time span: `{points: [{t, v}], t0, t1, color, height, aria,
 * tipTitle(p), tipRows(p)}`. Its tooltip follows the pointer to the nearest point.
 */
export function area(width, o) {
  const H = o.height || 56;
  const pts = o.points || [];
  if (!pts.length) return '';
  const max = Math.max(...pts.map(p => p.v)) || 1;
  const X = t => ((t - o.t0) / Math.max(1, o.t1 - o.t0)) * width;
  const Y = v => H - 4 - (v / max) * (H - 10);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const fill = `M${X(pts[0].t).toFixed(1)},${H - 4}${pts.map(p => `L${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('')}L${X(pts.at(-1).t).toFixed(1)},${H - 4}Z`;
  const last = pts.at(-1);
  const series = pts.map(p => ({ x: Math.round(X(p.t) * 10) / 10, html: tipHtml({ title: o.tipTitle(p), rows: o.tipRows(p) }) }));
  const color = e(o.color || 'var(--ws-an-s1)');
  return `<svg class="ws-an-svg ws-an-area" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" data-an-xtip="${e(JSON.stringify(series))}" role="img" aria-label="${e(o.aria || 'Area chart')}">
    <line class="ws-an-base" x1="0" x2="${width}" y1="${H - 3.5}" y2="${H - 3.5}"/>
    <path d="${fill}" fill="${color}" opacity=".1"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${X(last.t).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="4" fill="${color}" class="ws-an-dot-end"/>
    <line class="ws-an-xh" x1="0" x2="0" y1="0" y2="${H - 4}" visibility="hidden"/>
    <rect x="0" y="0" width="${width}" height="${H}" fill="transparent"/>
  </svg>`;
}
