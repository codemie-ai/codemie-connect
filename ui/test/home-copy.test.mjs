import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('ui/index.html', 'utf8');
const renderer = readFileSync('ui/renderer.js', 'utf8');

test('home tile: Setup title and description replace Full installation', () => {
  assert.match(html, /<div class="tile-title">Setup<\/div>/);
  assert.match(html, /<div class="tile-desc">Run the setup wizard and Claude engine\.<\/div>/);
});

test('home tile: Install only action is removed', () => {
  assert.doesNotMatch(html, /data-action="install-only"/);
  assert.doesNotMatch(html, /Install only/);
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
  assert.match(renderer, /primaryLabel: 'Run setup'/);
});
