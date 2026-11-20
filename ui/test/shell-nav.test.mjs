import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOnboardingNav } from '../shell-nav.js';
import { renderShell } from '../workspace/shell.js';
import { buildSnapshot, withTasks, withMeetings } from './fixtures/workspace-fixture.mjs';

// A root holding the four sidebar entries, queried the way the module does.
function makeRoot() {
  const entries = new Map();
  for (const id of ['sidebar-home', 'sidebar-agents', 'sidebar-connections', 'sidebar-health', 'sidebar-analytics']) {
    entries.set(id, {
      id,
      disabled: false,
      attrs: new Map(),
      classes: new Set(['sidebar-item']),
      classList: {
        toggle(name, on) {
          if (on) entries.get(id).classes.add(name);
          else entries.get(id).classes.delete(name);
        },
      },
      setAttribute(k, v) { entries.get(id).attrs.set(k, v); },
      removeAttribute(k) { entries.get(id).attrs.delete(k); },
    });
  }
  return {
    entries,
    querySelector: (sel) => entries.get(sel.slice(1)) || null,
  };
}

test('while the checklist is unfinished the other screens are locked', () => {
  const root = makeRoot();
  applyOnboardingNav(root, { done: false });
  for (const id of ['sidebar-agents', 'sidebar-connections', 'sidebar-health']) {
    const el = root.entries.get(id);
    assert.equal(el.disabled, true, `${id} must not be clickable`);
    assert.equal(el.classes.has('locked'), true);
    assert.equal(el.attrs.get('aria-disabled'), 'true');
  }
});

// CLI usage analytics is gone until it comes back as a native page.
test('there is no CLI usage analytics entry', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /sidebar-analytics|CLI usage analytics/);
  const root = makeRoot();
  applyOnboardingNav(root, { done: false });
  assert.equal(root.entries.get('sidebar-analytics').disabled, false, 'the nav no longer knows the entry');
});

// The checklist sends the user to Agents and Health itself. Locking Home too
// would leave them on the screen an item opened with no way back.
test('Home is never locked', () => {
  const root = makeRoot();
  applyOnboardingNav(root, { done: false });
  const home = root.entries.get('sidebar-home');
  assert.equal(home.disabled, false);
  assert.equal(home.classes.has('locked'), false);
});

test('finishing the checklist unlocks every entry', () => {
  const root = makeRoot();
  applyOnboardingNav(root, { done: false });
  applyOnboardingNav(root, { done: true });
  for (const [, el] of root.entries) {
    assert.equal(el.disabled, false);
    assert.equal(el.classes.has('locked'), false);
    assert.equal(el.attrs.has('aria-disabled'), false);
  }
});

test('a root missing an entry is not an error', () => {
  assert.doesNotThrow(() => applyOnboardingNav({ querySelector: () => null }, { done: false }));
  assert.doesNotThrow(() => applyOnboardingNav(undefined, { done: true }));
});

const NOW = Date.UTC(2026, 10, 19, 9);
const shell = (opts = {}) => renderShell({ snapshot: buildSnapshot(NOW, { photo: false }), route: 'today', resolvedDark: true, ...opts });
/** The main menu's routes in the order drawn. */
const routes = html => [...html.match(/<nav class="ws-nav ws-main-nav"[^]*?<\/nav>/)[0].matchAll(/data-route="([a-z]+)"/g)].map(m => m[1]);
/** Group `id`'s markup, from its wrapper to the next group or the end of the menu. */
const groupOf = (html, id) => html.match(new RegExp(`<div class="ws-nav-group[^"]*" role="group" data-group="${id}"[^]*?</div>(?=<div class="ws-nav-group|</nav>)`))?.[0] || '';
const headOf = (html, id) => html.match(new RegExp(`<button type="button" class="ws-nav-head" data-action="sidebar-fold" data-group="${id}"[^]*?</button>`))?.[0] || '';
const plugin = (plugin, id, label, extra = {}) => ({ plugin, pluginName: plugin[0].toUpperCase() + plugin.slice(1), id, label, ...extra });

test('the menu draws Today alone, then Work and AI as groups with small labels', () => {
  const html = shell();
  assert.deepEqual(routes(html), ['today', 'inbox', 'calendar', 'meetings', 'tasks', 'automations', 'analytics']);
  assert.match(headOf(html, 'work'), /aria-expanded="true"[^]*?<span class="ws-nav-head-label">Work<\/span>/);
  assert.match(headOf(html, 'ai'), /aria-expanded="true"[^]*?<span class="ws-nav-head-label">AI<\/span>/);
  assert.doesNotMatch(html, /data-group="plugins"/, 'no Plugins group without plugin pages');
  // Settings sits beside the account in one row, and the menu's own toggle is in the brand row.
  assert.match(html, /<div class="ws-sidebar-bottom">\s*<button type="button" class="ws-user"[^]*?<button type="button" class="ws-nav-gear" data-action="route" data-tip="Settings" data-route="settings"/);
  assert.match(html, /<div class="ws-brand"[^]*?data-action="sidebar-toggle" aria-expanded="true"[^>]*aria-label="Collapse menu"/);
  assert.doesNotMatch(html, /<span>Collapse menu<\/span>/, 'no Collapse menu row');
});

test('a folded group adds up what it hides beside its label and keeps the page you are on', () => {
  const s = withMeetings(withTasks(buildSnapshot(NOW, { photo: false }), NOW), NOW);
  const open = renderShell({ snapshot: s, route: 'tasks', resolvedDark: true, now: NOW });
  const count = id => Number(open.match(new RegExp(`data-route="${id}"[^>]*>[^]*?<small class="ws-count"[^>]*>(\\d+)</small>`))?.[1] || 0);
  const hidden = count('inbox') + count('meetings');
  assert.ok(hidden > 0, 'the fixture has inbox replies or meetings waiting');
  const html = renderShell({ snapshot: s, route: 'tasks', resolvedDark: true, now: NOW, sidebarFolded: { work: true } });
  const head = headOf(html, 'work');
  assert.match(head, /aria-expanded="false"/);
  assert.match(head, new RegExp(`<small class="ws-count">${hidden}</small>`), 'the hidden counts roll up');
  assert.match(head, /data-tip="Work: Inbox, Calendar, Meetings"/, 'the tooltip names what is folded away');
  assert.match(head, new RegExp(`aria-label="Work, ${hidden} new"`), 'its name holds what it adds up, also on the rail where the label is hidden');
  assert.deepEqual(routes(html), ['today', 'tasks', 'automations', 'analytics'], 'Tasks is current and stays');
  // Folded with nothing current, the group draws only its label.
  assert.deepEqual(routes(renderShell({ snapshot: s, route: 'today', resolvedDark: true, now: NOW, sidebarFolded: { work: true, ai: true } })), ['today']);
});

test('plugins: one row per plugin with its letter mark; a plugin’s pages nest only while one is open', () => {
  const activities = [plugin('knowledge', 'ask', 'Ask'), plugin('knowledge', 'health', 'Health', { badge: '5' }), plugin('focus', 'home', 'Focus'), plugin('standup', 'home', 'Stand-up notes', { badge: '1' })];
  const away = shell({ plugins: { activities } });
  const group = groupOf(away, 'plugins');
  assert.match(group, /class="ws-nav-group ws-plugin-nav"/, 'the Plugins group keeps its class');
  assert.match(headOf(away, 'plugins'), /aria-expanded="true"/, 'three plugins: open');
  assert.equal((group.match(/data-action="plugin-page"/g) || []).length, 3, 'one row per plugin');
  assert.match(group, /data-nav="plugin" data-action="plugin-page" data-plugin-id="knowledge" data-activity="ask"[^>]*><span class="ws-nav-mark" style="--h:\d+" aria-hidden="true">K<\/span><span>Knowledge<\/span><small class="ws-count">5<\/small>/, 'several pages: the plugin row, its badges added up');
  assert.match(group, /data-action="plugin-page" data-plugin-id="standup" data-activity="home"[^>]*><span class="ws-nav-mark"[^>]*>S<\/span><span>Stand-up notes<\/span><small class="ws-count">1<\/small>/, 'one page: the row is that page');
  assert.doesNotMatch(group, /icon-puzzle|data-activity="health"/);
  assert.match(shell({ plugins: { activities: [{ plugin: 'emo', pluginName: '🦊 Fox', id: 'home', label: 'Fox' }] } }), /class="ws-nav-mark"[^>]*>🦊<\/span>/, 'a mark is a whole character');
  const inside = groupOf(shell({ route: 'plugin', plugins: { activities, current: { plugin: 'knowledge', id: 'health' } } }), 'plugins');
  assert.match(inside, /<div class="ws-nav-subs">[^]*?data-activity="ask"[^>]*><span>Ask<\/span>[^]*?data-activity="health"[^>]*aria-current="page"[^>]*><span>Health<\/span><small class="ws-count">5<\/small>/);
  assert.match(inside, /data-nav="plugin"[^>]*class="ws-nav-in"[^>]*><span class="ws-nav-mark"[^]*?<span>Knowledge<\/span><\/button>/, 'the open plugin’s row drops its roll-up');
});

test('more than three plugins start folded, with their marks on the label line; a click decides after that', () => {
  const activities = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma'].map((p, i) => plugin(p, 'home', p, i === 1 ? { badge: '99+' } : i === 2 ? { badge: '3' } : i === 3 ? { badge: '!' } : {}));
  const html = shell({ plugins: { activities } });
  const head = headOf(html, 'plugins');
  assert.match(head, /aria-expanded="false"/);
  assert.equal((head.match(/class="ws-nav-mark"/g) || []).length, 4, 'four marks');
  assert.match(head, /<i>\+2<\/i>/);
  assert.match(head, /<small class="ws-count">99\+<\/small>/, 'numbers add up, shown as 99+ above 99');
  assert.equal((groupOf(html, 'plugins').match(/data-action="plugin-page"/g) || []).length, 0);
  assert.match(headOf(shell({ plugins: { activities: activities.slice(3) }, sidebarFolded: { plugins: true } }), 'plugins'), /<small class="ws-count">!<\/small>/, 'a mark with no number rolls up as itself');
  assert.match(headOf(shell({ plugins: { activities }, sidebarFolded: { plugins: false } }), 'plugins'), /aria-expanded="true"/);
  assert.match(headOf(shell({ plugins: { activities: activities.slice(0, 2) }, sidebarFolded: { plugins: true } }), 'plugins'), /aria-expanded="false"/);
  // The current plugin stays under the folded label.
  assert.deepEqual([...groupOf(shell({ route: 'plugin', plugins: { activities, current: { plugin: 'gamma', id: 'home' } } }), 'plugins').matchAll(/data-plugin-id="([a-z]+)"/g)].map(m => m[1]), ['gamma']);
});

test('the collapsed menu draws the rail: dots for counts, tooltips, a folded group as one icon', () => {
  const full = shell();
  assert.doesNotMatch(full, /ws-sidebar-rail|ws-count-dot/);
  const s = withTasks(buildSnapshot(NOW, { photo: false }), NOW);
  const rail = renderShell({ snapshot: s, route: 'today', resolvedDark: true, sidebarCollapsed: true, sidebarFolded: { work: true } });
  assert.match(rail, /<aside class="ws-sidebar ws-sidebar-rail"/);
  assert.match(rail, /data-action="route" data-tip="Analytics" data-route="analytics"/);
  assert.match(rail, /data-action="route" data-tip="Settings" data-route="settings"/);
  assert.match(headOf(rail, 'work'), /aria-expanded="false" data-tip="Work: Inbox, Calendar, Meetings, Tasks"[^>]*>[^]*?class="ws-count ws-count-dot"/, 'a folded group is one icon with a dot');
  assert.match(rail, /data-action="sidebar-toggle" aria-expanded="false"[^>]*data-tip="Expand menu"/);
  assert.match(rail, /<div class="ws-sidebar-edge"/);
  // The top bar has the same button at the left.
  assert.match(rail, /<header class="ws-topbar">\s*<button[^>]*data-action="sidebar-toggle"/);
});
