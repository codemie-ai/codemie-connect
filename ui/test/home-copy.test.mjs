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
// are on for v2; About and the analytics entry stay hidden until owned.
test('shell: the nav and the command-log footer are no longer hidden', () => {
  assert.match(html, /<nav id="app-sidebar">/);
  assert.match(html, /<details id="command-log-footer">/);
  assert.match(html, /id="sidebar-about" class="sidebar-item hidden"/);
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
