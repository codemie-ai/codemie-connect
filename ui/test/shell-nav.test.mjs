import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOnboardingNav } from '../shell-nav.js';

// A root holding the four sidebar entries, queried the way the module does.
function makeRoot() {
  const entries = new Map();
  for (const id of ['sidebar-home', 'sidebar-agents', 'sidebar-connections', 'sidebar-health']) {
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
