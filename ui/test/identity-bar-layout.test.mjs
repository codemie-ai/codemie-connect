import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('ui/styles.css', 'utf8');

// EPMCDME-15296: #identity-bar had no flex-wrap, so its spans wrapped inside
// themselves at narrow widths instead of staying on one line.
test('identity-bar: the bar stays on one line instead of wrapping', () => {
  const rule = css.match(/#identity-bar\s*\{[^}]*\}/)[0];
  assert.match(rule, /flex-wrap:\s*nowrap/);
});

// Flex items default to min-width: auto, which blocks shrinking/ellipsis.
// The text segments need min-width: 0 plus overflow/ellipsis to truncate.
test('identity-bar: text segments can shrink and truncate with an ellipsis', () => {
  const rule = css.match(/#identity-bar > span#identity-auth-status,\s*\n?#identity-bar > span#identity-product[\s\S]*?\{[^}]*\}/);
  assert.ok(rule, 'a shared or per-selector rule targets the bar\'s text segments');
});

test('identity-bar: a truncation rule sets min-width, overflow and ellipsis together', () => {
  assert.match(css, /overflow:\s*hidden;\s*\n?\s*text-overflow:\s*ellipsis/);
  assert.match(css, /min-width:\s*0/);
});

// EPMCDME-15296 CR-001: a uniform flex-shrink let the short, high-value
// auth-status text truncate before longer, lower-priority segments gave up
// any room. auth-status/product must shrink slower than the shared rule.
test('identity-bar: auth-status/product shrink slower than the other text segments', () => {
  const sharedRule = css.match(/#identity-bar > span\s*\{[^}]*\}/)[0];
  const priorityRule = css.match(/#identity-bar > span#identity-auth-status,\s*\n?#identity-bar > span#identity-product\s*\{[^}]*\}/)[0];

  const sharedShrink = Number(sharedRule.match(/flex-shrink:\s*(\d+(?:\.\d+)?)/)[1]);
  const priorityShrink = Number(priorityRule.match(/flex-shrink:\s*(\d+(?:\.\d+)?)/)[1]);

  assert.ok(priorityShrink < sharedShrink,
    `auth-status/product flex-shrink (${priorityShrink}) should be lower than the shared segments' (${sharedShrink})`);
});

// EPMCDME-15296: a bare `#identity-auth-status` selector lost to the shared
// rule and its flex-shrink: 1 never applied. The qualified selector carries
// two ids, the shared `#identity-bar > span` one, so it wins.
test('identity-bar: auth-status/product selector outranks the shared rule', () => {
  const ids = (sel) => (sel.match(/#[\w-]+/g) || []).length;
  assert.ok(css.includes('#identity-bar > span {'), 'the shared rule is present');
  assert.ok(ids('#identity-bar > span#identity-auth-status') > ids('#identity-bar > span'));
});

test('identity-bar: existing :empty hiding and separator rules are unchanged', () => {
  assert.match(css, /#identity-bar > span:empty\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /#identity-bar > span \+ span::before\s*\{/);
  assert.match(css, /#identity-bar > #theme-toggle\s*\{\s*margin-left:\s*auto;\s*\}/);
});

const rendererJs = readFileSync('ui/renderer.js', 'utf8');

// EPMCDME-15296: the signed_in branch wrote st.detail verbatim, so the bar
// showed the CLI's raw "Auth Status │ ✓ ..." row instead of clean text.
test('identity-bar: updateIdentityAuthStatus cleans st.detail via signedInDetail', () => {
  const fn = rendererJs.slice(
    rendererJs.indexOf('function updateIdentityAuthStatus'),
    rendererJs.indexOf('\n}', rendererJs.indexOf('function updateIdentityAuthStatus'))
  );
  assert.match(fn, /signedInDetail\(st\.detail\)/);
  assert.doesNotMatch(fn, /el\.textContent = st\.detail \|\| 'Signed in';/);
});

test('identity-bar: renderer.js imports signedInDetail from home-state.js', () => {
  assert.match(rendererJs, /import \{[^}]*signedInDetail[^}]*\} from '\.\/home-state\.js'/);
});
