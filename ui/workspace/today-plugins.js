// What plugins put on Today (DESIGN 7.2, PLUGIN-ENGINE.md §4.3): their widgets, drawn by Connect
// from their data (`plugin_widget` records, layout ids `plugin:<plugin>:<widget>`), and the
// "From plugins" card with their Inbox items, deliveries, held mail and Teams messages and work
// rows (`plugin_item` and `<plugin>:work`). Everything a plugin gave is text here: escaped, cut to
// its limit, never HTML. Pure: node:test imports it.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { badge, button, card, emptyState } from './ui.js';
import { relativeAge } from './format.js';

export const PLUGINS_CARD = 'plugins';
const PLUGIN_LAYOUT_ID = /^plugin:([a-z][a-z0-9-]{1,40}):([a-z0-9][a-z0-9_.-]{0,63})$/;
const WIDTH_OF = { S: 4, M: 6, L: 12 };

const cut = (v, max) => {
  const t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const tone = t => (['good', 'warn', 'bad', 'muted'].includes(t) ? ` ws-pw-${t}` : '');

/** `plugin:<plugin>:<widget>` → {plugin, widget}, or null. */
export function parseLayoutId(id) {
  const m = PLUGIN_LAYOUT_ID.exec(String(id || ''));
  return m ? { plugin: m[1], widget: m[2] } : null;
}

/** The widgets the enabled plugins declare, as Customize lists them:
 *  [{id, title, description, width, plugin}]. */
export function pluginWidgetCatalog(installed = []) {
  return installed
    .filter(p => p.enabled && !p.problem)
    .flatMap(p => (p.widgets || []).map(w => ({
      id: `plugin:${p.id}:${w.id}`,
      title: cut(w.label || w.id, 40),
      description: cut(`${p.name} · ${w.about || `${w.kind} widget`}`, 160),
      width: WIDTH_OF[(w.sizes || [])[0]] || 6,
      plugin: p.id,
    })))
    .filter(w => parseLayoutId(w.id));
}

const records = (s, kind) => (s.records || []).filter(r => r.kind === kind);

function widgetRecord(s, plugin, widget) {
  return records(s, 'plugin_widget').find(r => r.id === `${plugin}:${widget}` && r.data?.type === 'widget');
}

// ---------------------------------------------------------------- widgets

function actionsOf(plugin, list) {
  return (Array.isArray(list) ? list : []).slice(0, 3).filter(a => a && typeof a.command === 'string' && a.command)
    .map((a, i) => button(cut(a.label || a.command, 40), {
      action: 'plugin-command', variant: i === 0 ? 'secondary' : 'ghost', size: 'sm',
      attrs: { 'data-plugin-id': plugin, 'data-command': a.command, 'data-args': JSON.stringify(a.args ?? null) },
    })).join('');
}

function statBody(d) {
  const p = d.progress && Number.isFinite(d.progress.used) && Number.isFinite(d.progress.of) && d.progress.of > 0
    ? `<div class="ws-pw-bar"><span style="width:${Math.min(100, Math.max(0, (d.progress.used / d.progress.of) * 100)).toFixed(1)}%"></span></div>` : '';
  return `<div class="ws-pw-stat${tone(d.tone)}"><strong>${e(cut(d.value, 24))}${d.unit ? `<small>${e(cut(d.unit, 12))}</small>` : ''}</strong>${d.label ? `<span>${e(cut(d.label, 80))}</span>` : ''}${p}${d.note ? `<p class="ws-muted">${e(cut(d.note, 200))}</p>` : ''}</div>`;
}

function statsBody(d) {
  const items = (Array.isArray(d.items) ? d.items : []).slice(0, 6);
  return `<div class="ws-pw-stats">${items.map(x => `<div class="ws-pw-cell${tone(x?.tone)}"><strong>${e(cut(x?.value, 24))}</strong><span>${e(cut(x?.label, 60))}</span></div>`).join('')}</div>`;
}

function listBody(d) {
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) return `<p class="ws-muted ws-hint">${e(cut(d.empty || 'Nothing here yet.', 200))}</p>`;
  const shown = items.slice(0, 8);
  return `<ul class="ws-pw-list">${shown.map(x => `<li><strong>${e(cut(x?.title, 200))}</strong>${x?.sub ? `<span>${e(cut(x.sub, 200))}</span>` : ''}</li>`).join('')}</ul>${items.length > shown.length ? `<p class="ws-muted ws-hint">+${items.length - shown.length} more</p>` : ''}`;
}

function statusBody(d) {
  const state = ['ok', 'warn', 'bad'].includes(d.state) ? d.state : 'warn';
  return `<div class="ws-pw-status ws-pw-${state}"><span class="ws-pw-dot" aria-hidden="true"></span><div><strong>${e(cut(d.title, 80))}</strong>${d.text ? `<p>${e(cut(d.text, 300))}</p>` : ''}</div></div>`;
}

function cardBody(d) {
  return `<div class="ws-pw-card">${d.title ? `<strong>${e(cut(d.title, 120))}</strong>` : ''}${d.text ? `<p>${e(cut(d.text, 2000))}</p>` : ''}</div>`;
}

function cellText(c) {
  if (c && typeof c === 'object') return [cut(c.text ?? (Array.isArray(c.values) ? c.values.at(-1) : ''), 200), c.tone];
  return [cut(c, 200), null];
}

function tableBody(d) {
  const cols = (Array.isArray(d.columns) ? d.columns : []).slice(0, 10).filter(c => c && typeof c.key === 'string');
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (!rows.length) return `<p class="ws-muted ws-hint">${e(cut(d.empty || 'Nothing here yet.', 200))}</p>`;
  const shown = rows.slice(0, 8);
  return `<div class="ws-pw-table-wrap"><table class="ws-pw-table"><thead><tr>${cols.map(c => `<th>${e(cut(c.label ?? c.key, 40))}</th>`).join('')}</tr></thead><tbody>${shown.map(r => `<tr>${cols.map(c => {
    const [text, t] = cellText(r?.cells?.[c.key]);
    return `<td class="${c.kind === 'number' ? 'ws-pw-num' : ''}${tone(t)}">${e(text)}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table></div>${rows.length > shown.length ? `<p class="ws-muted ws-hint">+${rows.length - shown.length} more</p>` : ''}`;
}

function chartBody(d) {
  const points = (Array.isArray(d.points) ? d.points : []).slice(-12);
  const valueOf = p => (Number.isFinite(p?.value) ? p.value : p?.values && typeof p.values === 'object' ? Object.values(p.values).filter(Number.isFinite).reduce((a, b) => a + b, 0) : 0);
  const max = Math.max(1, ...points.map(p => Math.abs(valueOf(p))));
  const unit = d.unit ? ` ${cut(d.unit, 12)}` : '';
  const head = d.headline ? `<div class="ws-pw-stat"><strong>${e(cut(d.headline.value, 24))}</strong>${d.headline.label ? `<span>${e(cut(d.headline.label, 60))}</span>` : ''}</div>` : '';
  if (!points.length) return `${head}<p class="ws-muted ws-hint">Nothing to show yet.</p>`;
  return `${head}<div class="ws-pw-bars">${points.map(p => {
    const v = valueOf(p);
    return `<div class="ws-pw-bar-row"><span>${e(cut(p?.label, 40))}</span><div class="ws-pw-bar"><span style="width:${((Math.abs(v) / max) * 100).toFixed(1)}%"></span></div><small>${e(cut(Number(v.toFixed(2)), 24))}${e(unit)}</small></div>`;
  }).join('')}</div>${d.note ? `<p class="ws-muted ws-hint">${e(cut(d.note, 200))}</p>` : ''}`;
}

const BODY = { stat: statBody, stats: statsBody, list: listBody, status: statusBody, card: cardBody, table: tableBody, chart: chartBody };

/**
 * A plugin widget's card. `drawn` is the text of `page` widgets their client half drew
 * (`plugin:<plugin>:<widget>` → text); `catalog` names widgets that have no data yet.
 */
export function pluginWidgetCard(s, layoutId, { catalog = [], drawn = {}, zone } = {}) {
  const at = parseLayoutId(layoutId);
  if (!at) return '';
  const r = widgetRecord(s, at.plugin, at.widget);
  const known = catalog.find(w => w.id === layoutId);
  const title = cut(r?.data?.label || known?.title || at.widget, 40);
  const from = cut(r?.data?.pluginName || at.plugin, 60);
  const attrs = { 'data-plugin-id': at.plugin, 'data-widget': layoutId };
  if (!r) {
    return card({
      title, iconName: 'puzzle', className: 'ws-plugin-widget', attrs,
      body: emptyState({ iconName: 'puzzle', title: known ? 'Waiting for its first data' : 'Its plugin is off', text: known ? `${from} sends it when it runs.` : 'Turn it on in Settings → Plugins, or take this card off Today.' }),
    });
  }
  const d = r.data.data && typeof r.data.data === 'object' ? r.data.data : {};
  const kind = r.data.kind;
  const body = kind === 'page'
    ? (drawn[layoutId] !== undefined ? `<p class="ws-pw-page">${e(cut(drawn[layoutId], 2000))}</p>` : `<p class="ws-muted ws-hint">${e(from)} draws this widget.</p>`)
    : (BODY[kind] || cardBody)(d);
  const stale = r.data.stale ? badge('Not updated', 'warning', 'alert') : '';
  const when = r.data.at ? ` · ${e(relativeAge(r.data.at, zone))}` : '';
  return card({
    title, iconName: 'puzzle', className: 'ws-plugin-widget', attrs,
    actions: stale,
    body: `${body}${r.data.stale && r.data.error ? `<p class="ws-inline-note ws-warning">${icon('alert')}<span>${e(cut(r.data.error, 300))}</span></p>` : ''}`,
    footer: `<span class="ws-pw-from">${e(from)}${when}</span>${kind !== 'page' ? actionsOf(at.plugin, d.actions) : ''}`,
  });
}

// ---------------------------------------------------------------- From plugins

/** Inbox items, deliveries and held messages, newest first, and each plugin's work rows. */
export function pluginItems(s) {
  const items = records(s, 'plugin_item').filter(r => r.data && typeof r.data.plugin === 'string')
    .sort((a, b) => (b.data.at || 0) - (a.data.at || 0));
  const held = new Map(items.filter(r => r.data.type === 'held_message').map(r => [r.id, r]));
  const work = records(s, 'plugin_widget').filter(r => r.data?.type === 'work' && Array.isArray(r.data.rows) && r.data.rows.length);
  return { items: items.filter(r => r.data.type !== 'held_message'), held, work };
}

/** Whether Today shows the "From plugins" card below its grid: never when a saved grid places it
 *  or the user removed it; otherwise when it is in the layout, or, until the old layout was saved
 *  with it known (its width remembered), whenever a plugin has something there. */
export function showPluginsCard(w, s) {
  const grid = Array.isArray(w.today?.items) ? w.today : null;
  if (grid && (grid.items.some(i => i.id === PLUGINS_CARD) || (grid.hidden || []).includes(PLUGINS_CARD))) return false;
  if ((w.layout || []).includes(PLUGINS_CARD)) return true;
  if (!grid && w.widgetWidths && PLUGINS_CARD in w.widgetWidths) return false;
  const { items, work } = pluginItems(s);
  return items.length > 0 || work.length > 0;
}

function heldBlock(h, title) {
  const to = h.data.channel === 'teams' ? 'Teams' : 'mail';
  const text = cut(h.data.markdown, 20000);
  return `<div class="ws-held" data-held-id="${e(h.id)}">
    <div class="ws-held-head">${badge(`Held · ${to}`, 'warning', h.data.channel === 'teams' ? 'chat' : 'mail')}<span class="ws-muted">To you${h.data.to?.address ? ` · ${e(cut(h.data.to.address, 120))}` : ''}</span></div>
    ${h.data.subject && h.data.subject !== title ? `<strong class="ws-held-subject">${e(cut(h.data.subject, 200))}</strong>` : ''}
    <pre class="ws-held-text">${e(text)}</pre>
    <div class="ws-held-foot"><span class="ws-muted ws-hint">${icon('lock')} Not sent — Connect never sends for plugins. Copy it to send it yourself.</span>${button('Copy', { action: 'plugin-copy', iconName: 'copy', size: 'sm', attrs: { 'data-id': h.id } })}</div>
  </div>`;
}

function itemRow(r, held, zone, routeOf) {
  const d = r.data;
  const from = `${e(cut(d.pluginName || d.plugin, 60))} · ${e(relativeAge(d.at, zone))}`;
  if (d.type === 'inbox') {
    const go = d.go && routeOf ? routeOf(d.plugin, d.go) : null;
    return `<div class="ws-pi-row" data-plugin-id="${e(d.plugin)}">
      <span class="ws-pi-icon${d.urgent ? ' ws-pi-urgent' : ''}">${icon(d.urgent ? 'alert' : 'bell')}</span>
      <div class="ws-pi-main"><strong>${e(cut(d.title, 200))}</strong>${d.why ? `<p>${e(cut(d.why, 500))}</p>` : ''}<span class="ws-pi-from">${from}</span></div>
      <div class="ws-pi-actions">${actionsOf(d.plugin, d.actions)}${go ? button('Open', { action: 'plugin-go', variant: 'ghost', size: 'sm', attrs: { 'data-plugin-id': d.plugin, 'data-go': go } }) : ''}</div>
    </div>`;
  }
  const h = d.held ? held.get(d.held) : null;
  const to = d.to === 'today' ? 'Today' : d.to === 'teams' ? 'Teams' : d.to === 'mail' ? 'Mail' : cut(d.to, 20);
  return `<div class="ws-pi-row ws-pi-delivery" data-plugin-id="${e(d.plugin)}">
    <span class="ws-pi-icon">${icon(d.to === 'teams' ? 'chat' : d.to === 'mail' ? 'mail' : 'spark')}</span>
    <div class="ws-pi-main"><strong>${e(cut(d.title || 'A message', 200))}</strong>
      ${!h && d.markdown ? `<pre class="ws-pi-text">${e(cut(d.markdown, 4000))}</pre>` : ''}
      ${h ? heldBlock(h, d.title) : ''}
      <span class="ws-pi-from">${from} · for ${e(to)}</span></div>
  </div>`;
}

function workBlock(r) {
  const rows = r.data.rows.slice(0, 8);
  return `<div class="ws-pi-work" data-plugin-id="${e(r.data.plugin)}"><span class="ws-field-label">${icon('list')}${e(cut(r.data.pluginName || r.data.plugin, 60))} · work</span>
    <ul>${rows.map(w => `<li><strong>${e(cut(w.title, 300))}</strong><span>${e(cut([w.kind, w.where, w.due].filter(Boolean).join(' · '), 200))}</span>${w.late ? badge('Late', 'error') : ''}</li>`).join('')}</ul>
    ${r.data.rows.length > rows.length ? `<p class="ws-muted ws-hint">+${r.data.rows.length - rows.length} more</p>` : ''}</div>`;
}

/** The "From plugins" card. `routeOf(plugin, go)` turns an item's `go` into a Connect hash. */
export function pluginsCard(s, { zone, routeOf } = {}) {
  const { items, held, work } = pluginItems(s);
  const shown = items.slice(0, 12);
  const body = shown.length || work.length
    ? `<div class="ws-pi-list">${shown.map(r => itemRow(r, held, zone, routeOf)).join('')}</div>${work.map(workBlock).join('')}`
    : emptyState({ iconName: 'puzzle', title: 'Nothing from plugins', text: 'Decisions, deliveries and messages your plugins prepare land here.' });
  return card({
    title: 'From plugins', iconName: 'puzzle', className: 'ws-plugins-card',
    actions: button('Plugins', { action: 'settings-tab', variant: 'ghost', iconRight: 'arrow', attrs: { 'data-tab': 'plugins' } }),
    body,
  });
}

/** The text of a held message, for Copy. */
export function heldText(s, id) {
  const r = records(s, 'plugin_item').find(x => x.id === id && x.data?.type === 'held_message');
  if (!r) return null;
  return [r.data.subject, r.data.markdown].filter(x => typeof x === 'string' && x).join('\n\n');
}

/** The text of HTML a plugin's client half drew (a `page` widget), via an inert document. */
export function textOfHtml(html, parse) {
  try {
    const doc = parse(String(html ?? ''));
    return (doc?.body?.textContent || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}
