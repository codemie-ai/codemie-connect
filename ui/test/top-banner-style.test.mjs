import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('ui/styles.css', 'utf8');
const html = readFileSync('ui/index.html', 'utf8');

// EPMCDME-15189: .top-banner had no CSS definition at all, so both update
// banners rendered as plain unstyled text. This fails if that regresses.
test('top-banner: .top-banner has a CSS definition', () => {
  assert.match(css, /\.top-banner\s*\{/);
});

test('top-banner: disabled run/dismiss buttons get a visibly-disabled style', () => {
  assert.match(css, /\.top-banner-dismiss:disabled\s*\{/);
});

// EPMCDME-15189: the reassurance line came from the wireframe verbatim and is
// an acceptance criterion in its own right — a CSS check alone won't catch
// someone editing this sentence in the CLI banner's markup.
test('top-banner: CLI banner keeps the verbatim reassurance line', () => {
  const cliBanner = html.slice(
    html.indexOf('<div id="update-banner"'),
    html.indexOf('<div id="app-update-banner"')
  );
  assert.match(cliBanner, /Your profile, settings and agents are kept\./);
});

// EPMCDME-15189: each banner is a title + a line + an actions block, not one
// flat span. Fails if the card structure ever gets collapsed back down.
test('top-banner: each banner has a title, a line and an actions block', () => {
  const cliBanner = html.slice(
    html.indexOf('<div id="update-banner"'),
    html.indexOf('<div id="app-update-banner"')
  );
  const appBanner = html.slice(html.indexOf('<div id="app-update-banner"'));
  for (const banner of [cliBanner, appBanner]) {
    assert.match(banner, /class="top-banner-title"/);
    assert.match(banner, /class="top-banner-line"/);
    assert.match(banner, /class="top-banner-actions"/);
  }
});
