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

// The bundled CLI sits inside the app: `self-update` would install the new
// version into the user's own npm and the app would keep running the old one
// ("Updated! → 0.15.2" when 0.15.3 was out). So no CLI update is offered for it.
test('renderer: no CLI update banner or badge while the app runs its bundled CLI', () => {
  assert.match(renderer, /invoke\('cli_is_bundled'\),\s*bridge\.inspector\.checkCodemieVersion\(\),\s*invoke\('fetch_codemie_latest'\),\s*\]\)\.then\(\(\[bundled, installed, latest\]\) => \{\s*if \(bundled\) return;/);
});

// The footer must be listening before boot() runs its startup checks, or
// `codemie --version` and `codemie profile status` never show (seen on Windows).
test('renderer: the command-log footer is wired before the startup checks run', () => {
  const boot = renderer.slice(renderer.indexOf('async function boot('));
  const wired = boot.indexOf('bridge.setCommandListener(');
  assert.ok(wired > 0, 'boot() wires the footer');
  assert.ok(wired < boot.indexOf('bridge.inspector.checkCodemieVersion()'), 'before the version check');
  assert.ok(wired < boot.indexOf('bridge.inspector.checkProfileStatus()'), 'before the profile status check');
});

// On Windows, Home's reads ran `codemie` while `codemie self-update` replaced
// it: they failed, Tools and Connections stayed "Could not read", and npm could
// find its files in use. The reads wait for the update and run after it.
test('renderer: Home does not run codemie while the CLI update replaces it', () => {
  const fn = (name) => renderer.slice(renderer.indexOf(`async function ${name}(`)).slice(0, 200);
  assert.match(fn('refreshAgents'), /if \(cliReplacing \|\|/);
  assert.match(fn('refreshConnection'), /if \(cliReplacing \|\|/);
  assert.match(renderer, /window\.addEventListener\('focus'[\s\S]{0,120}cliReplacing/);
  const update = renderer.slice(renderer.indexOf('async function runUpdateCli('));
  const body = update.slice(0, update.indexOf('checkCodemieVersion()'));
  assert.match(body, /cliReplacing = true;[\s\S]*runSelfUpdate\(\);[\s\S]*finally \{[\s\S]*cliReplacing = false;[\s\S]*refreshAgents\(\);[\s\S]*refreshConnection\(\);/);
});
