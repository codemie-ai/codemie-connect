import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('ui/index.html', 'utf8');
const renderer = readFileSync('ui/renderer.js', 'utf8');

// EPMCDME-14589: the launcher grid is gone; Home's body is ui/home-view.js.
test('home: the tile grid is gone and the body slot is there', () => {
  assert.doesNotMatch(html, /id="home-grid"/);
  assert.doesNotMatch(html, /class="home-tile/);
  assert.doesNotMatch(html, /data-action="/);
  assert.match(html, /<div id="home-body"><\/div>/);
  assert.doesNotMatch(renderer, /home-grid|homeGrid|update-cli-tile/);
});

test('home: install-only stays gone', () => {
  assert.doesNotMatch(html, /Install only/);
});

// EPMCDME-14589, at the PM's request: the shell nav and the command-log footer
// are on for v2. EPMCDME-15342: About now has a screen, so it and its divider show.
test('shell: the nav, the command-log footer and About are no longer hidden', () => {
  assert.match(html, /<nav id="app-sidebar">/);
  assert.match(html, /<details id="command-log-footer">/);
  assert.match(html, /id="sidebar-about" class="sidebar-item" data-view="about"/);
  assert.match(html, /<div id="sidebar-divider"><\/div>/);
});

// EPMCDME-15342: analytics sits in the main group, directly below Health.
test('shell: the analytics entry sits directly below Health', () => {
  const main = html.slice(html.indexOf('<div id="sidebar-main-group">'));
  const group = main.slice(0, main.indexOf('</div>'));
  assert.match(group, /id="sidebar-health"[^>]*>Health<\/button>\s*(<!--[\s\S]*?-->\s*)?<button id="sidebar-analytics"/);
});

test('shell: the analytics sidebar entry is unhidden and wired', () => {
  assert.match(html, /<button id="sidebar-analytics" class="sidebar-item">/);
  assert.match(
    renderer,
    /document\.getElementById\('sidebar-analytics'\)\.addEventListener\('click', \(\) => \{[\s\S]*?runAnalytics\(\);/
  );
});

test('wizard: step header reads SETUP STEPS', () => {
  assert.match(html, /<div id="step-header">SETUP STEPS<\/div>/);
});

test('renderer: install-only dead code and full-installation wording are gone', () => {
  assert.doesNotMatch(renderer, /INSTALL_ONLY_IDS/);
  assert.doesNotMatch(renderer, /'install-only'/);
  assert.doesNotMatch(renderer, /full installation/i);
});

test('renderer: mode label and auth notice use Setup-consistent copy', () => {
  assert.match(renderer, /modeLabel\.textContent = 'Setup'/);
  assert.match(renderer, /Run setup \/ sign in first/);
  assert.match(renderer, /primaryLabel: 'Run setup',\r?\n\s*primaryAction: \(\) => openGuidedSetup\(\)/);
});

// One update: the app updates itself, and the CLI inside it comes with it.
// A separate CLI update would install into npm while the app kept running the
// copy it ships with (EPMCDME-15407).
test('renderer: the app offers no CLI update of its own', () => {
  for (const gone of ['runSelfUpdate', 'fetch_codemie_latest', 'cli_is_bundled', "'update-banner", 'identity-version-badge']) {
    assert.ok(!renderer.includes(gone), `renderer.js still has ${gone}`);
  }
  assert.ok(!html.includes('id="update-banner"'), 'index.html still has the CLI update banner');
  assert.ok(!html.includes('identity-version-badge'), 'index.html still has the CLI version badge');
  assert.ok(html.includes('id="app-update-banner"'), 'the app update banner stays');
});

// EPMCDME-15342: the About screen.
const fnBody = (name) => {
  const start = renderer.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  const rest = renderer.slice(start);
  return rest.slice(0, rest.search(/\r?\n}\r?\n/));
};

test('renderer: visiting About refreshes it', () => {
  assert.match(fnBody('showView'), /if \(name === 'about'\) \{?\s*about\.refresh\(\);/);
});

// About's state transitions are tested in about-controller.test.mjs; renderer.js
// cannot be imported, so these check that the app update run reports to it.
test('renderer: About buttons guard installRunning and reuse the banner update run', () => {
  assert.match(renderer, /onUpdateApp: \(\) => \{\s*if \(installRunning\) return;\s*runUpdateApp\(\);/);
  assert.match(renderer, /onOpenLink: \(url\) => \{\s*if \(installRunning\) return;\s*invoke\('open_external', \{ url \}\)/);
  assert.ok(!renderer.includes('onUpdateCli'), 'About offers no CLI update of its own');
});

test('renderer: the app update run reports progress, results and errors to About', () => {
  const app = fnBody('runUpdateApp');
  assert.match(app, /about\.startUpdate\(\)/);
  assert.match(app, /about\.progress\(text, true\)/);
  assert.match(app, /catch \(err\) \{[\s\S]*about\.fail\(String\(err\)\);[\s\S]*finally \{\s*updateAppRunning = false;\s*about\.renderIfShown\(\);/);
});

test('Home holds its health check while guided setup is open, and only the latest setup run ends setup', () => {
  assert.ok(renderer.includes("autoHealthCheck(state, { setupOpen: setupRunning || !views.setup.classList.contains('hidden') })"));
  assert.ok(renderer.includes('if (setupRun !== run) return;'));
});
