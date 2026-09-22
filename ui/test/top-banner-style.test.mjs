import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('ui/styles.css', 'utf8');
const html = readFileSync('ui/index.html', 'utf8');
const rendererJs = readFileSync('ui/renderer.js', 'utf8');

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

// The app banner says its own thing. With both on screen the same sentence
// twice reads like a template rather than something written for the user.
test('top-banner: the app banner does not repeat the CLI banner\'s line', () => {
  const appBanner = html.slice(html.indexOf('<div id="app-update-banner"'));
  assert.doesNotMatch(appBanner, /Your profile, settings and agents are kept\./);
  assert.match(appBanner, /Everything you set up stays\./);
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

// EPMCDME-15189 code review CR-002: a nowrap row has no defined shrink/wrap
// behavior, so a long version string or a narrow window overflows or clips
// the card instead of wrapping within it.
test('top-banner: the card row wraps instead of forcing a single nowrap line', () => {
  const rule = css.match(/\.top-banner\s*\{[^}]*\}/)[0];
  assert.match(rule, /flex-wrap:\s*wrap/);
});

test('top-banner: the text column can shrink below its content width', () => {
  const rule = css.match(/\.top-banner-body\s*\{[^}]*\}/)[0];
  assert.match(rule, /min-width:\s*0/);
});

// EPMCDME-15189 code review CR-001: runUpdateApp()'s catch block used to
// append .update-error as a raw flex sibling of the title/actions row, where
// it could overlap them instead of dropping to its own line. It must land
// inside the text column so the card's wrapped layout carries it too.
test('top-banner: the app-update error text is appended inside the text column', () => {
  const catchBlock = rendererJs.slice(
    rendererJs.indexOf('async function runUpdateApp'),
    rendererJs.indexOf('\n}', rendererJs.indexOf('async function runUpdateApp'))
  );
  assert.match(catchBlock, /top-banner-body/);
  assert.doesNotMatch(catchBlock, /\bbanner\.appendChild\(errorEl\)/);
});
