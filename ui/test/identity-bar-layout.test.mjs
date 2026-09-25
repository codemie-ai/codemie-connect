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
  const sharedRule = css.match(/#identity-bar > span:not\(#identity-version-badge\)\s*\{[^}]*\}/)[0];
  const priorityRule = css.match(/#identity-bar > span#identity-auth-status,\s*\n?#identity-bar > span#identity-product\s*\{[^}]*\}/)[0];

  const sharedShrink = Number(sharedRule.match(/flex-shrink:\s*(\d+(?:\.\d+)?)/)[1]);
  const priorityShrink = Number(priorityRule.match(/flex-shrink:\s*(\d+(?:\.\d+)?)/)[1]);

  assert.ok(priorityShrink < sharedShrink,
    `auth-status/product flex-shrink (${priorityShrink}) should be lower than the shared segments' (${sharedShrink})`);
});

// EPMCDME-15296: the shared rule's #identity-bar > span:not(#identity-version-badge)
// selector counts two ids (the :not() argument still contributes), so a bare
// `#identity-auth-status` id selector (one id) was weaker and its flex-shrink: 1
// never actually applied. The fix qualifies the selector to tie the shared
// rule's specificity (2 ids + 1 type each) so cascade order — this rule is
// declared after the shared one — decides it in auth-status/product's favor.
test('identity-bar: auth-status/product selector specificity ties (not loses to) the shared rule', () => {
  const sharedSelector = '#identity-bar > span:not(#identity-version-badge)';
  const prioritySelector = '#identity-bar > span#identity-auth-status';

  // The shared rule's :not() argument is itself an id selector and counts
  // toward specificity, giving the shared selector 2 ids total.
  const sharedIds = (sharedSelector.match(/#[\w-]+/g) || []).length;
  const priorityIds = (prioritySelector.match(/#[\w-]+/g) || []).length;

  assert.equal(sharedIds, 2, 'sanity check: the :not() argument id still counts');
  assert.ok(priorityIds >= sharedIds,
    `auth-status/product selector (${priorityIds} ids) must have at least as many ids as the shared rule (${sharedIds} ids)`);

  // On equal specificity the later rule in source order wins — assert the
  // qualified auth-status/product rule is declared after the shared rule.
  const sharedIndex = css.indexOf(sharedSelector);
  const priorityIndex = css.indexOf(prioritySelector);
  assert.ok(sharedIndex >= 0 && priorityIndex > sharedIndex,
    'auth-status/product rule must be declared after the shared rule to win the specificity tie');
});

// The version badge and theme toggle must stay full-size and pinned right —
// they are not part of the truncating text segments.
test('identity-bar: the version badge keeps its own untouched rule, no ellipsis', () => {
  const rule = css.match(/#identity-version-badge\s*\{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /text-overflow/);
  assert.match(rule, /margin-left:\s*auto/);
});

// EPMCDME-15296: the badge is excluded from the shared truncation rule's
// :not(), so without its own white-space/flex-shrink its text wrapped to two
// lines at narrow widths and grew the bar's height. It must stay single-line
// and never shrink.
test('identity-bar: the version badge stays single-line and never shrinks', () => {
  const rule = css.match(/#identity-version-badge\s*\{[^}]*\}/)[0];
  assert.match(rule, /white-space:\s*nowrap/);
  assert.match(rule, /flex-shrink:\s*0/);
});

test('identity-bar: existing :empty hiding and separator rules are unchanged', () => {
  assert.match(css, /#identity-bar > span:empty\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /#identity-bar > span \+ span::before\s*\{/);
  assert.match(css, /#identity-bar > #identity-version-badge::before\s*\{\s*content:\s*none;\s*\}/);
  assert.match(css, /#identity-version-badge:empty\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /#identity-bar > #theme-toggle\s*\{\s*margin-left:\s*12px;\s*\}/);
  assert.match(css, /#identity-version-badge:empty \+ #theme-toggle\s*\{\s*margin-left:\s*auto;\s*\}/);
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
