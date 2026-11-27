// Settings → Plugins (DESIGN 7.1, 7.3): installed plugins, marketplaces and their catalogs, a
// plugin's permission sheet, and the dialogs that install, update, turn on and remove plugins.
// Renderers are pure (node:test imports them); `createPluginsController` holds the tab's state
// and runs its actions through `plugins_request`.
//
// Everything a manifest, a marketplace or a sheet says is untrusted text: it is escaped here and
// never inserted as HTML. A plugin's own Settings card and sections are drawn by the plugin, in
// its sandboxed frame, over a slot this page leaves for it (`data-plugin-slot`).
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { badge, button, card, emptyState, settingRow, toggle, spinner } from './ui.js';
import { agoLabel } from './format.js';
import { hostWords } from '../plugins/frame/host-words.js';

export const UNVERIFIED = 'Unverified package · installs run with the access you approve';
export const KNOWLEDGE_LATER = 'Coming later — needs Connect’s Knowledge engine';
export const PROXY_NOTE = 'Git marketplaces are cloned over HTTPS with the proxy set in Connect’s environment (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, NO_PROXY). The macOS system proxy settings aren’t used.';

/** How far Connect supports a sheet line: its marker's words, tone and icon, in sheet order. */
export const SUPPORT = {
  blocking: ['Blocking', 'error', 'alert'],
  unsupported: ['Unsupported', 'neutral', 'close'],
  partial: ['Partial', 'warning', 'info'],
  supported: ['Supported', 'success', 'check'],
};
const RANK = { blocking: 0, unsupported: 1, partial: 2, supported: 3 };
const statusOf = line => (SUPPORT[line?.support?.status] ? line.support.status : 'unsupported');

/** Sheet lines in the order they matter: what blocks, what won't work, what is limited, what works. */
export function orderSheet(lines = []) {
  return [...lines].sort((a, b) => RANK[statusOf(a)] - RANK[statusOf(b)] || String(a.key).localeCompare(String(b.key)));
}

const isKnowledgeLater = o => /Knowledge engine/i.test(String(o?.reason || ''));
const shortCommit = c => (typeof c === 'string' ? c.slice(0, 7) : '');

/** A permission sheet, every line with its support marker. With `consent`, each line has a box
 *  to tick; `fresh` names the lines that are new since the user last agreed. */
export function sheetList(lines, { consent = false, fresh = [], id = 'plugin-sheet' } = {}) {
  if (!lines?.length) return `<p class="ws-muted ws-hint" id="${e(id)}">It asks for no permissions.</p>`;
  return `<ol class="ws-sheet" id="${e(id)}">${orderSheet(lines).map(l => {
    const status = statusOf(l);
    const [label, tone, ico] = SUPPORT[status];
    const limit = typeof l.support?.limit === 'string' ? l.support.limit : '';
    const box = consent
      ? `<label class="ws-check ws-sheet-tick"><input type="checkbox" name="agree" value="${e(l.key)}" aria-label="Agree: ${e(l.text)}"><span class="ws-check-box" aria-hidden="true">${icon('check')}</span></label>`
      : '';
    return `<li class="ws-sheet-line ws-sheet-${status}" data-key="${e(l.key)}">${box}<div class="ws-sheet-copy"><span>${e(l.text)}</span>${limit ? `<small>${e(limit)}</small>` : ''}</div><span class="ws-sheet-marks">${fresh.includes(l.key) ? badge('New', 'info') : ''}${badge(label, tone, ico)}</span></li>`;
  }).join('')}</ol>`;
}

/** The keys to send when every line of `lines` is ticked; null while one isn't. */
export function agreement(lines, ticked) {
  const keys = (lines || []).map(l => l.key);
  const got = new Set(ticked || []);
  return keys.length === got.size && keys.every(k => got.has(k)) ? keys : null;
}

const unverified = () => `<p class="ws-inline-note ws-warning ws-unverified">${icon('shield')}<span>${e(UNVERIFIED)}</span></p>`;

/** The consent dialog's body: what agreeing means, and every line with a box to tick. */
export function consentBody(lines, { fresh = [], intro } = {}) {
  return `<p class="ws-modal-text">${e(intro || 'Tick each line to agree to it. Connect checks every call the plugin makes against what you agree to here.')}</p>
    ${unverified()}
    ${sheetList(lines, { consent: true, fresh, id: 'plugin-consent' })}`;
}

export function removeBody(name) {
  return `<p class="ws-modal-text">${e(name)} and its files are removed from Connect. Its settings, sign-ins and stored data stay, so installing it again picks up where it was.</p>
    <label class="ws-check"><input type="checkbox" name="deleteData" data-plugin-delete-data><span class="ws-check-box" aria-hidden="true">${icon('check')}</span><span class="ws-check-text"><span>Also delete its data</span><small>Its store, settings, sign-ins and secrets on this Mac.</small></span></label>`;
}

export function marketBody() {
  return `<label class="ws-field"><span class="ws-field-label">Marketplace</span>
      <span class="ws-market-source"><input class="ws-input" name="source" id="market-source" required autocomplete="off" spellcheck="false" placeholder="owner/repo, https://… or a folder" aria-label="Marketplace address or folder">${button('Choose folder…', { action: 'market-pick', iconName: 'folder' })}</span>
      <small class="ws-field-hint">A GitHub repository as owner/repo (optionally @branch or tag), an https:// git address, or a folder on this Mac with an echo-marketplace.json.</small></label>
    <p class="ws-muted ws-hint">${e(PROXY_NOTE)}</p>`;
}

// ---------------------------------------------------------------- the list

function marketRows(markets, busy) {
  return markets.map(m => {
    const kind = m.kind === 'local' ? 'Folder' : 'Git';
    const ref = m.ref ? ` @${m.ref}` : '';
    const fetched = m.kind === 'local' ? 'Read from the folder' : m.fetchedAt ? `Fetched ${agoLabel(m.fetchedAt)}${m.commit ? ` · ${shortCommit(m.commit)}` : ''}` : 'Not fetched yet';
    const working = busy[`market:${m.name}`];
    return `<div class="ws-row ws-market-row" data-market="${e(m.name)}">
      <span class="ws-row-icon">${icon(m.kind === 'local' ? 'folder' : 'link')}</span>
      <div class="ws-row-main"><strong>${e(m.name)} ${m.builtIn ? badge('Built-in', 'info') : ''}${badge(kind, 'neutral')}</strong><span class="ws-ellipsis" title="${e(m.source + ref)}">${e(m.source + ref)}</span><span class="ws-muted">${e(fetched)}</span></div>
      <div class="ws-actions">${button(working ? 'Fetching…' : m.ready ? 'Refresh' : 'Fetch', { action: 'market-refresh', iconName: 'refresh', variant: m.ready ? 'secondary' : 'primary', disabled: !!working, attrs: { 'data-market': m.name } })}${m.builtIn ? '' : button('', { action: 'market-remove', iconName: 'trash', variant: 'ghost', title: `Remove ${m.name}`, attrs: { 'data-market': m.name } })}</div>
    </div>`;
  }).join('');
}

function stateBadges(p, status) {
  const out = [];
  if (p.problem) out.push(badge('Problem', 'error', 'alert'));
  else if (!p.enabled) out.push(badge('Off', 'neutral'));
  if (p.enabled && p.loadError) out.push(badge('Didn’t load', 'error', 'alert'));
  if (p.update) out.push(badge(`Update ${p.update}`, 'info', 'update'));
  if (!p.market) out.push(badge('Taken back', 'warning'));
  if (p.enabled && status?.error) out.push(badge('Page failed', 'warning', 'alert'));
  return out.join('');
}

/** "Provides tasks · Settings › Tasks" appended to a task provider's summary (plain text in the
 *  list row, which is itself one button; a real link in its own detail page). */
const TASKS_NOTE = ' · Provides tasks · Settings › Tasks';

function installedRow(p, status, busy, providesTasks) {
  return `<div class="ws-row ws-plugin-row" data-plugin-id="${e(p.id)}">
    <span class="ws-plugin-icon" aria-hidden="true">${icon('puzzle')}</span>
    <button type="button" class="ws-row-main ws-plugin-open" data-action="plugin-open" data-plugin-id="${e(p.id)}"><strong>${e(p.name)} <span class="ws-muted">${e(p.version)}</span> ${stateBadges(p, status)}</strong><span class="ws-ellipsis">${e(p.problem || (p.enabled && p.loadError) || hostWords(p.summary || ''))}${providesTasks ? TASKS_NOTE : ''}</span></button>
    <div class="ws-actions">
      ${p.update ? button(busy[`update:${p.id}`] ? 'Updating…' : 'Update', { action: 'plugin-update', iconName: 'update', disabled: !!busy[`update:${p.id}`], attrs: { 'data-plugin-id': p.id } }) : ''}
      ${toggle({ action: 'plugin-enable', checked: p.enabled, attrs: { 'data-plugin-id': p.id, 'aria-label': `${p.name} on`, disabled: !!p.problem || !!busy[`enable:${p.id}`] } })}
      ${button('', { action: 'plugin-open', iconName: 'chevron-right', variant: 'ghost', title: `${p.name}: details`, attrs: { 'data-plugin-id': p.id } })}
    </div>
  </div>`;
}

function offerCard(o, market) {
  const later = !o.installable && isKnowledgeLater(o);
  const state = o.installed ? badge(o.update ? `Update ${o.version}` : `Installed ${o.installed}`, o.update ? 'info' : 'success', o.update ? 'update' : 'check')
    : later ? badge('Coming later', 'neutral', 'clock')
      : !o.installable ? badge('Not available', 'warning', 'alert') : '';
  return `<article class="ws-offer${o.installable ? '' : ' ws-offer-off'}" data-plugin-id="${e(o.id)}" data-market="${e(market)}">
    <button type="button" class="ws-offer-open" data-action="plugin-offer" data-plugin-id="${e(o.id)}" data-market="${e(market)}" aria-label="${e(`${o.name || o.id}: details`)}"></button>
    <header><span class="ws-plugin-icon" aria-hidden="true">${icon('puzzle')}</span><div class="ws-offer-name"><strong>${e(o.name || o.id)}</strong><span class="ws-muted">${e(o.version || '')}</span></div>${o.featured ? badge('Featured', 'info', 'spark') : ''}</header>
    <p class="ws-offer-summary">${e(hostWords(o.summary || ''))}</p>
    ${!o.installable ? `<p class="ws-offer-reason">${e(later ? KNOWLEDGE_LATER : o.reason || 'Connect can’t install it.')}</p>` : ''}
    <footer>${state}${(o.categories || []).slice(0, 3).map(c => `<span class="ws-chip">${e(c)}</span>`).join('')}</footer>
  </article>`;
}

function catalogSection(m, cat, busy) {
  if (!m.ready) {
    return `<div class="ws-catalog ws-catalog-unfetched" data-market="${e(m.name)}"><span class="ws-row-icon">${icon('download')}</span><div class="ws-row-main"><strong>${e(m.name)}</strong><span>Not fetched yet. Fetch it to see the plugins it offers.</span></div>${button(busy[`market:${m.name}`] ? 'Fetching…' : 'Fetch', { action: 'market-refresh', variant: 'primary', iconName: 'refresh', disabled: !!busy[`market:${m.name}`], attrs: { 'data-market': m.name } })}</div>`;
  }
  const plugins = cat?.plugins || [];
  const body = cat?.error ? `<p class="ws-inline-note ws-error">${icon('alert')}<span>${e(cat.error)}</span></p>`
    : !cat ? `<div class="ws-catalog-loading">${spinner('Reading the catalog')}<span class="ws-muted">Reading the catalog…</span></div>`
      : plugins.length ? `<div class="ws-offer-grid">${plugins.map(o => offerCard(o, m.name)).join('')}</div>`
        : `<p class="ws-muted ws-hint">This marketplace offers no plugins.</p>`;
  return `<div class="ws-catalog" data-market="${e(m.name)}"><div class="ws-catalog-head"><strong>${e(m.name)}</strong><span class="ws-muted">${e(plugins.length ? `${plugins.length} plugin${plugins.length === 1 ? '' : 's'}` : '')}</span></div>${body}</div>`;
}

function unreadableCard(ui) {
  return card({
    title: 'Your list of plugins can’t be read', iconName: 'alert', className: 'ws-registry-card',
    body: `<p class="ws-inline-note ws-error">${icon('alert')}<span>${e(ui.unreadable.message)}</span></p>
      <p class="ws-modal-text">Reset starts a new list. The file that can’t be read is kept next to it, the plugins installed on this Mac are taken back turned off, and each asks you to agree to its permissions again when you turn it on. Marketplaces you added need adding again.</p>
      <div class="ws-actions">${button(ui.busy.reset ? 'Resetting…' : 'Reset the list', { action: 'plugins-reset', variant: 'danger', iconName: 'refresh', disabled: !!ui.busy.reset })}</div>`,
  });
}

function resetCard(reset) {
  const list = (items, empty) => (items.length ? `<ul class="ws-reset-list">${items.map(x => `<li><code>${e(x)}</code></li>`).join('')}</ul>` : `<p class="ws-muted ws-hint">${e(empty)}</p>`);
  return card({
    title: 'The list of plugins was reset', iconName: 'check-circle', className: 'ws-registry-card',
    actions: button('', { action: 'plugins-reset-done', iconName: 'close', variant: 'ghost', title: 'Dismiss' }),
    body: `<p class="ws-modal-text">The old list is kept as <code>${e(reset.saved)}</code> in the plugins folder.</p>
      <span class="ws-field-label">Taken back, turned off</span>${list(reset.adopted, 'No installed plugin could be taken back.')}
      <span class="ws-field-label">Left as they were</span>${list(reset.leftovers, 'Nothing else was in the plugins folder.')}
      ${reset.leftovers.length ? '<p class="ws-muted ws-hint">Older versions or copies that no longer pass Connect’s checks. Connect leaves them alone; delete them yourself if you don’t need them.</p>' : ''}`,
  });
}

/** Settings → Plugins: what is installed, what the marketplaces offer, and the marketplaces.
 *  `providesTasks(id)` names a plugin that is a task provider (Settings › Tasks's radio group). */
export function pluginsPanel(ui, { status = () => null, providesTasks = () => false } = {}) {
  if (ui.unreadable) return unreadableCard(ui);
  if (ui.offer) return offerDetail(ui);
  const loading = ui.status !== 'ready';
  const error = ui.error ? `<p class="ws-inline-note ws-error">${icon('alert')}<span>${e(ui.error)}</span></p>` : '';
  const installed = card({
    title: 'Installed', iconName: 'puzzle',
    body: loading ? `<div class="ws-catalog-loading">${spinner('Loading plugins')}<span class="ws-muted">Loading plugins…</span></div>`
      : ui.installed.length ? `<div class="ws-rows">${ui.installed.map(p => installedRow(p, status(p.id), ui.busy, providesTasks(p.id))).join('')}</div>`
        : emptyState({ iconName: 'puzzle', title: 'No plugins yet', text: 'Plugins add pages, Today widgets and routines. Install one from a marketplace below.' }),
  });
  const available = ui.markets.length ? card({
    title: 'Available', iconName: 'download',
    body: ui.markets.map(m => catalogSection(m, ui.catalogs[m.name], ui.busy)).join(''),
  }) : '';
  const markets = card({
    title: 'Marketplaces', iconName: 'link',
    actions: button('Add marketplace', { action: 'market-add', iconName: 'plus' }),
    body: `${ui.markets.length ? `<div class="ws-rows">${marketRows(ui.markets, ui.busy)}</div>` : ''}<p class="ws-muted ws-hint ws-proxy-note">${icon('info')} ${e(PROXY_NOTE)}</p>`,
  });
  return `${ui.reset ? resetCard(ui.reset) : ''}${error}${installed}${available}${markets}`;
}

// ---------------------------------------------------------------- details

function backButton(label = 'All plugins') {
  return `<div class="ws-plugin-back">${button(label, { action: 'plugin-back', variant: 'ghost', iconName: 'chevron-left' })}</div>`;
}

/** A plugin a marketplace offers: its sheet, the unverified notice, and Install when it can be. */
export function offerDetail(ui) {
  const { market, id } = ui.offer;
  const d = ui.inspect[`${market}/${id}`];
  const o = d && !d.error ? d : (ui.catalogs[market]?.plugins || []).find(x => x.id === id) || { id };
  const later = !o.installable && isKnowledgeLater(o);
  const busy = ui.busy[`install:${id}`];
  const action = o.installed
    ? (o.update ? button('Update', { action: 'plugin-update', variant: 'primary', iconName: 'update', attrs: { 'data-plugin-id': id } }) : badge(`Installed ${o.installed}`, 'success', 'check'))
    : o.installable && d && !d.error ? button(busy ? 'Installing…' : 'Install', { action: 'plugin-install', variant: 'primary', iconName: 'download', disabled: !!busy, attrs: { 'data-plugin-id': id, 'data-market': market } }) : '';
  const sheet = !d ? `<div class="ws-catalog-loading">${spinner('Reading its permission sheet')}<span class="ws-muted">Reading its permission sheet…</span></div>`
    : d.error ? `<p class="ws-inline-note ws-error">${icon('alert')}<span>${e(d.error)}</span></p>`
      : sheetList(d.sheet);
  return `${backButton()}
    <section class="ws-card ws-plugin-detail" data-plugin-id="${e(id)}" data-market="${e(market)}">
      <header class="ws-plugin-head"><span class="ws-plugin-icon ws-plugin-icon-lg" aria-hidden="true">${icon('puzzle')}</span>
        <div class="ws-plugin-title"><h3>${e(o.name || id)} <span class="ws-muted">${e(o.version || '')}</span></h3><p class="ws-muted">From ${e(market)}${d?.source ? ` · ${e(d.source)}` : ''}${d?.commit ? ` · ${e(shortCommit(d.commit))}` : ''}</p></div>
        <div class="ws-actions">${action}</div></header>
      <div class="ws-card-body">
        ${o.summary ? `<p class="ws-plugin-summary">${e(hostWords(o.summary))}</p>` : ''}
        ${!o.installable && o.reason !== undefined ? `<p class="ws-inline-note ${later ? 'ws-info-note' : 'ws-warning'}">${icon(later ? 'clock' : 'alert')}<span>${e(later ? KNOWLEDGE_LATER : o.reason || 'Connect can’t install it.')}</span></p>` : ''}
        ${unverified()}
        <h4 class="ws-sheet-title">What it asks for</h4>
        ${sheet}
      </div>
    </section>`;
}

/** An installed plugin: turning it on or off, its update, sign-ins, the addresses only the user
 *  gives it, its own Settings card (drawn in its frame), its sections and palette actions, and
 *  Remove. `status` is what its frame reported (`host.status`); `providesTasks` names it as a
 *  task provider, with a real link to Settings › Tasks. */
export function installedDetail(ui, id, status, providesTasks = false) {
  const p = ui.installed.find(x => x.id === id);
  if (!p) {
    return `${backButton()}${emptyState({ iconName: 'puzzle', title: 'This plugin isn’t installed', text: 'It may have been removed. Find it again in a marketplace.' })}`;
  }
  const busy = ui.busy;
  const head = `<header class="ws-plugin-head"><span class="ws-plugin-icon ws-plugin-icon-lg" aria-hidden="true">${icon('puzzle')}</span>
      <div class="ws-plugin-title"><h3>${e(p.name)} <span class="ws-muted">${e(p.version)}</span> ${stateBadges(p, status)}</h3><p class="ws-muted">${p.market ? `From ${e(p.market)}` : 'Taken back after the list was reset'}${p.source ? ` · ${e(p.source)}` : ''}${p.commit ? ` · ${e(shortCommit(p.commit))}` : ''}</p></div>
      <div class="ws-actions">${p.update ? button(busy[`update:${p.id}`] ? 'Updating…' : `Update to ${p.update}`, { action: 'plugin-update', variant: 'primary', iconName: 'update', disabled: !!busy[`update:${p.id}`], attrs: { 'data-plugin-id': p.id } }) : ''}${toggle({ action: 'plugin-enable', checked: p.enabled, label: p.enabled ? 'On' : 'Off', attrs: { 'data-plugin-id': p.id, 'aria-label': `${p.name} on`, disabled: !!p.problem || !!busy[`enable:${p.id}`] } })}</div></header>`;
  const notes = [
    p.problem ? `<p class="ws-inline-note ws-error">${icon('alert')}<span>${e(p.problem)}</span></p>` : '',
    !p.market ? `<p class="ws-inline-note ws-warning">${icon('info')}<span>Taken back after its list was reset. Turning it on asks you to agree to its permissions again.</span></p>` : '',
    p.enabled && p.loadError ? `<p class="ws-inline-note ws-error">${icon('alert')}<span>Its host half didn’t load, so it isn’t running: ${e(p.loadError)}</span></p>` : '',
    p.enabled && status?.error ? `<p class="ws-inline-note ws-warning">${icon('alert')}<span>Its page failed: ${e(status.error)}</span></p>` : '',
  ].join('');
  const signins = (p.signin || []).map(s => {
    const github = String(s.host).toLowerCase() === 'github.com';
    const control = !github ? '<span class="ws-muted ws-hint">Connect signs in to GitHub only</span>'
      : s.signedIn ? button('Sign out', { action: 'plugin-signout', iconName: 'logout', disabled: !!busy[`signin:${p.id}`], attrs: { 'data-plugin-id': p.id, 'data-host': s.host } })
        : button(busy[`signin:${p.id}`] ? 'Signing in…' : 'Sign in with GitHub', { action: 'plugin-signin', variant: 'primary', iconName: 'user', disabled: !!busy[`signin:${p.id}`] || !p.enabled, attrs: { 'data-plugin-id': p.id, 'data-host': s.host } });
    return settingRow({
      iconName: 'user', title: `Sign-in to ${s.host}`,
      text: s.signedIn ? (s.from === 'gh' ? 'Signed in with the GitHub CLI’s sign-in on this Mac.' : 'Signed in with a sign-in the plugin keeps.') : `Uses the GitHub CLI’s sign-in on this Mac (gh auth login). ${p.name} can send it to the places it talks to.`,
      control,
    });
  }).join('');
  const addresses = (p.addresses || []).map(a => `<form class="ws-inline-form ws-address-form" data-form="plugin-addresses" data-plugin-id="${e(p.id)}" data-key="${e(a.key)}">
      <label class="ws-field"><span class="ws-field-label">${e(a.label)}</span><input class="ws-input" name="value" value="${e(a.value)}" autocomplete="off" spellcheck="false" placeholder="10.0.0.5, nas.local" aria-label="${e(a.label)}"><small class="ws-field-hint">${e(a.help || 'Addresses on your own network it may reach, separated by commas. Only you set these.')}</small></label>
      ${button('Save', { type: 'submit' })}
    </form>`).join('');
  const sections = (status?.sections || []).map(s => button(s.label, { action: 'plugin-section', iconName: 'settings', attrs: { 'data-plugin-id': p.id, 'data-section': s.id } })).join('');
  const actions = (status?.palette || []).map((a, i) => button(a.label, { action: 'plugin-palette', variant: 'ghost', iconName: 'play', attrs: { 'data-plugin-id': p.id, 'data-index': String(i) } })).join('');
  const own = p.enabled && status?.card ? `<div class="ws-plugin-card-slot" data-plugin-slot="${e(p.id)}"></div>` : '';
  const access = card({
    title: 'Access', iconName: 'shield',
    body: `${unverified()}${signins}${addresses}${p.agreed?.length ? `<p class="ws-muted ws-hint">You agreed to: ${p.agreed.map(k => `<code>${e(k)}</code>`).join(' ')}</p>` : '<p class="ws-muted ws-hint">It has no permissions agreed yet.</p>'}`,
  });
  const tasksNote = providesTasks ? `<p class="ws-plugin-summary ws-muted">Provides tasks · ${button('Settings › Tasks', { action: 'settings-tab', variant: 'ghost', size: 'sm', attrs: { 'data-tab': 'meetings-tasks' } })}</p>` : '';
  return `${backButton()}
    <section class="ws-card ws-plugin-detail" data-plugin-id="${e(p.id)}">${head}<div class="ws-card-body">
      ${p.summary ? `<p class="ws-plugin-summary">${e(hostWords(p.summary))}</p>` : ''}${tasksNote}${notes}
      ${own}
      ${sections || actions ? `<div class="ws-plugin-links">${sections}${actions}</div>` : ''}
    </div></section>
    ${access}
    <div class="ws-plugin-danger">${button('Remove…', { action: 'plugin-remove', variant: 'danger', iconName: 'trash', attrs: { 'data-plugin-id': p.id } })}</div>`;
}

/** A plugin's own Settings section: its frame fills the panel. */
export function sectionPage(id) {
  return `<div class="ws-plugin-slot-fill" data-plugin-slot="${e(id)}"></div>`;
}

/** The Settings page for a plugin path: {label, description, content}. `providesTasks(id)` names
 *  a plugin as a task provider (Settings › Tasks's radio group). */
export function pluginsPage(ui, path, { status = () => null, sections = [], providesTasks = () => false } = {}) {
  if (path?.id && path.section) {
    const s = sections.find(x => x.plugin === path.id && x.id === path.section);
    const p = ui.installed.find(x => x.id === path.id);
    if (!s) {
      return { label: 'Plugins', description: '', content: `${backButton()}${emptyState({ iconName: 'puzzle', title: 'This section isn’t available', text: 'Its plugin is off, or still starting.' })}` };
    }
    return { label: s.label, description: `From ${p?.name || s.pluginName}, drawn by the plugin`, content: sectionPage(path.id), fill: true };
  }
  if (path?.id) return { label: 'Plugins', description: '', content: installedDetail(ui, path.id, status(path.id), providesTasks(path.id)) };
  return { label: 'Plugins', description: 'Echo-compatible plugins: pages, Today widgets and routines from marketplaces you add.', content: pluginsPanel(ui, { status, providesTasks }) };
}

// ---------------------------------------------------------------- controller

/**
 * The tab's state and actions. `request(op, data)` is `plugins_request`; `render()` draws again;
 * `openModal`/`confirmModal`/`toast` are the app's; `installedChanged(list)` tells the app (the
 * frames, the sidebar, Today); `navigate(path)` opens a plugin path (`{id, section}` or null).
 */
export function createPluginsController({ request, render, openModal, toast, installedChanged = () => {}, navigate = () => {} }) {
  const ui = {
    status: 'idle', error: '', unreadable: null, reset: null,
    installed: [], markets: [], catalogs: {}, offer: null, inspect: {}, busy: {},
  };

  const sentence = err => err?.message || String(err);
  function failed(err) {
    if (err?.code === 'registry_unreadable') {
      ui.unreadable = { message: sentence(err) };
      return true;
    }
    return false;
  }

  async function withBusy(key, run) {
    ui.busy[key] = true;
    render();
    try {
      return await run();
    } finally {
      delete ui.busy[key];
      render();
    }
  }

  async function loadInstalled() {
    ui.installed = await request('installed');
    installedChanged(ui.installed);
  }

  async function loadCatalog(name) {
    try {
      ui.catalogs[name] = await request('catalog', { market: name });
    } catch (err) {
      if (failed(err)) return;
      ui.catalogs[name] = { plugins: [], error: sentence(err) };
    }
  }

  /** Reads everything the tab shows. */
  async function load() {
    if (ui.status !== 'ready') ui.status = 'loading';
    ui.error = '';
    try {
      const [installed, markets] = await Promise.all([request('installed'), request('markets')]);
      ui.unreadable = null;
      ui.installed = installed;
      ui.markets = markets;
      installedChanged(installed);
      ui.status = 'ready';
      render();
      await Promise.all(markets.filter(m => m.ready).map(m => loadCatalog(m.name)));
    } catch (err) {
      if (!failed(err)) ui.error = sentence(err);
      ui.status = 'ready';
    }
    render();
  }

  async function inspect(market, id) {
    const key = `${market}/${id}`;
    delete ui.inspect[key];
    render();
    try {
      ui.inspect[key] = await request('inspect', { market, id });
    } catch (err) {
      if (!failed(err)) ui.inspect[key] = { error: sentence(err) };
    }
    render();
  }

  /** Asks for agreement to `lines` (all of them ticked) and runs `agree(keys)`. */
  function consent({ title, subtitle, lines, fresh = [], submit, intro, agree }) {
    const dialog = openModal({
      title, subtitle, size: 'md', submit, guard: true, initialFocus: 'cancel',
      body: consentBody(lines, { fresh, intro }),
      onSubmit: async f => {
        const keys = agreement(lines, f.getAll('agree'));
        if (!keys) throw new Error('Tick every line to agree to it.');
        await agree(keys);
      },
    });
    const go = dialog.querySelector('.ws-modal-footer [type=submit]');
    const sync = () => { go.disabled = !agreement(lines, [...dialog.querySelectorAll('[name=agree]:checked')].map(b => b.value)); };
    dialog.addEventListener('change', sync);
    sync();
    return dialog;
  }

  async function afterChange(message) {
    await loadInstalled();
    await Promise.all(ui.markets.filter(m => m.ready).map(m => loadCatalog(m.name)));
    if (ui.offer) await inspect(ui.offer.market, ui.offer.id);
    if (message) toast(message, 'success');
    render();
  }

  async function install(market, id) {
    const d = ui.inspect[`${market}/${id}`];
    if (!d || d.error) return;
    consent({
      title: `Install ${d.name || id}?`, subtitle: `${d.version || ''} from ${market}`, lines: d.sheet, submit: 'Install',
      agree: keys => withBusy(`install:${id}`, async () => {
        await request('install', { market, id, agreed: keys, sheetHash: d.sheetHash });
        await afterChange(`${d.name || id} is installed and on.`);
      }),
    });
  }

  function needsConsent(answer, retry, verb) {
    const fresh = (answer.lines || []).map(l => l.key);
    consent({
      title: `${verb} ${answer.name}?`, subtitle: `${answer.version} asks for something new`, lines: answer.sheet, fresh,
      submit: verb, intro: 'Its permission sheet changed since you agreed to it. The new or changed lines are marked. Tick each line to agree to it.',
      agree: keys => retry(keys, answer.sheetHash),
    });
  }

  async function update(id) {
    const name = ui.installed.find(p => p.id === id)?.name || id;
    const run = (agreed, sheetHash) => withBusy(`update:${id}`, async () => {
      const answer = await request('update', agreed ? { id, agreed, sheetHash } : { id });
      if (answer?.status === 'needs_consent') return needsConsent(answer, run, 'Update');
      await afterChange(`${name} is updated to ${answer.plugin?.version || 'its new version'}.`);
    });
    return run();
  }

  async function setEnabled(id, enabled, el) {
    const name = ui.installed.find(p => p.id === id)?.name || id;
    const run = (agreed, sheetHash) => withBusy(`enable:${id}`, async () => {
      const answer = await request('set_enabled', agreed ? { id, enabled, agreed, sheetHash } : { id, enabled });
      if (answer?.status === 'needs_consent') return needsConsent(answer, run, 'Turn on');
      await afterChange(enabled ? `${name} is on.` : `${name} is off.`);
    });
    try {
      await run();
    } catch (err) {
      if (el) el.checked = !enabled;
      throw err;
    }
  }

  function remove(id) {
    const p = ui.installed.find(x => x.id === id);
    if (!p) return;
    openModal({
      title: `Remove ${p.name}?`, size: 'sm', submit: 'Remove', variant: 'danger', guard: true, initialFocus: 'cancel',
      body: removeBody(p.name),
      onSubmit: async f => {
        const deleteData = f.has('deleteData');
        await request('remove', { id, deleteData });
        navigate(null);
        await afterChange(deleteData ? `${p.name} and its data are removed.` : `${p.name} is removed. Its data is kept.`);
      },
    });
  }

  function addMarket() {
    openModal({
      title: 'Add a marketplace', size: 'md', submit: 'Add',
      body: marketBody(),
      onSubmit: async f => {
        const source = String(f.get('source') || '').trim();
        if (!source) throw new Error('Type an address or choose a folder.');
        const market = await withBusy('market-add', () => request('market_add', { source }));
        ui.markets = await request('markets');
        await loadCatalog(market.name);
        toast(`${market.name} is added.`, 'success');
        render();
      },
    });
  }

  async function pickFolder(el) {
    const answer = await request('pick_folder');
    const input = el.closest('.ws-modal')?.querySelector('#market-source');
    if (answer?.path && input) {
      input.value = answer.path;
      input.focus();
    }
  }

  async function refreshMarket(name) {
    await withBusy(`market:${name}`, async () => {
      await request('market_refresh', { market: name });
      ui.markets = await request('markets');
      await loadCatalog(name);
      await loadInstalled();
    });
  }

  function removeMarket(name) {
    openModal({
      title: `Remove the ${name} marketplace?`, size: 'sm', submit: 'Remove', variant: 'danger', guard: true, initialFocus: 'cancel',
      body: `<p class="ws-modal-text">Its catalog goes from Connect. Plugins you installed from it stay installed, but can’t be updated until you add it again.</p>`,
      onSubmit: async () => {
        ui.markets = await request('market_remove', { market: name });
        delete ui.catalogs[name];
        render();
      },
    });
  }

  async function resetRegistry() {
    await withBusy('reset', async () => {
      const reset = await request('registry_reset');
      ui.unreadable = null;
      ui.reset = { saved: reset.saved, adopted: reset.adopted || [], leftovers: reset.leftovers || [] };
      await load();
    });
  }

  async function signIn(id, host, on) {
    await withBusy(`signin:${id}`, async () => {
      await request(on ? 'signin' : 'signout', { id, host });
      await loadInstalled();
      toast(on ? `Signed in to ${host}.` : `Signed out of ${host}.`, 'success');
    });
  }

  /** Runs one of the tab's actions; false when it isn't one. */
  async function handle(action, el) {
    const id = el.dataset.pluginId;
    try {
      switch (action) {
        case 'plugin-offer':
          ui.offer = { market: el.dataset.market, id };
          await inspect(el.dataset.market, id);
          return true;
        case 'plugin-back':
          ui.offer = null;
          navigate(null);
          render();
          return true;
        case 'plugin-open': ui.offer = null; navigate({ id }); return true;
        case 'plugin-section': navigate({ id, section: el.dataset.section }); return true;
        case 'plugin-install': await install(el.dataset.market, id); return true;
        case 'plugin-update': await update(id); return true;
        case 'plugin-enable': await setEnabled(id, el.checked, el); return true;
        case 'plugin-remove': remove(id); return true;
        case 'plugin-signin': await signIn(id, el.dataset.host, true); return true;
        case 'plugin-signout': await signIn(id, el.dataset.host, false); return true;
        case 'market-add': addMarket(); return true;
        case 'market-pick': await pickFolder(el); return true;
        case 'market-refresh': await refreshMarket(el.dataset.market); return true;
        case 'market-remove': removeMarket(el.dataset.market); return true;
        case 'plugins-reset': await resetRegistry(); return true;
        case 'plugins-reset-done': ui.reset = null; render(); return true;
        default: return false;
      }
    } catch (err) {
      if (failed(err)) {
        render();
        return true;
      }
      throw err;
    }
  }

  /** The addresses form on a plugin's page. */
  async function submit(form) {
    const id = form.dataset.pluginId;
    const key = form.dataset.key;
    const value = String(new FormData(form).get('value') || '');
    await request('set_addresses', { id, key, value });
    await loadInstalled();
    toast(value.trim() ? 'Addresses saved.' : 'Addresses cleared.', 'success');
    render();
  }

  return { ui, load, loadInstalled, handle, submit };
}
