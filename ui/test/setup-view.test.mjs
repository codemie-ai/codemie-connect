// ui/test/setup-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM stub ─────────────────────────────────────────────────────────
// Adapted from ui/test/steps-ui.test.mjs's hand-rolled stub (makeEl/
// findByClass), extended with a `children` getter (setup-view.js locates a
// row by walking container.children and matching dataset.id -- the real
// DOM's `.children` name, so setup-view.js's lookup works unmodified against
// a real browser DOM too) and a readable `onclick` (real DOM element.onclick
// is both a setter and a getter; this stub only had the setter, which is
// enough for steps-ui.js's own tests since none of them ever click anything,
// but this file's tests need to invoke the handler setup-view.js installs).
function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    _listeners: {},
    className: '',
    dataset: {},
    textContent: '',
    style: {},
    type: '',
    value: '',
    checked: false,
    name: '',
    get children() { return el._children; },
    get nextSibling() {
      const p = el._parent;
      if (!p) return null;
      const i = p._children.indexOf(el);
      return i >= 0 ? (p._children[i + 1] ?? null) : null;
    },
    get parentNode() { return el._parent ?? null; },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      return findByClass(el, cls);
    },
    appendChild(child) {
      child._parent = el;
      el._children.push(child);
      return child;
    },
    insertBefore(newEl, ref) {
      newEl._parent = el;
      const i = el._children.indexOf(ref);
      if (i >= 0) el._children.splice(i, 0, newEl);
      else el._children.push(newEl);
      return newEl;
    },
    classList: {
      _set: new Set(),
      toggle(cls, force) {
        if (force === true) el.classList._set.add(cls);
        else if (force === false) el.classList._set.delete(cls);
        else if (el.classList._set.has(cls)) el.classList._set.delete(cls);
        else el.classList._set.add(cls);
      },
    },
    remove() {
      const p = el._parent;
      if (p) p._children = p._children.filter((c) => c !== el);
    },
    set onclick(fn) { el._listeners.click = fn; },
    get onclick() { return el._listeners.click; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML ?? ''; },
    set(html) {
      el._innerHTML = html;
      el._children = [];
      const re = /<(?:div|button)[^>]+class="([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        for (const cls of m[1].split(/\s+/)) {
          const child = makeEl('div');
          child._cls = cls;
          child._parent = el;
          el._children.push(child);
        }
      }
    },
  });
  return el;
}

function findByClass(root, cls) {
  for (const c of root._children) {
    if (c._cls === cls || c.className === cls || (c.className ?? '').split(' ').includes(cls)) return c;
    const found = findByClass(c, cls);
    if (found) return found;
  }
  return null;
}

// Recursively collects every descendant (not just direct children) matching
// predicate. Needed because Task 4's option-card markup nests each radio one
// level deeper than the old flat `.prompt-control > input[radio]` shape that
// earlier tests' `._children.filter(...)` relied on.
function collectAll(el, predicate) {
  const out = [];
  for (const c of el._children) {
    if (predicate(c)) out.push(c);
    out.push(...collectAll(c, predicate));
  }
  return out;
}

globalThis.document = { createElement: (tag) => makeEl(tag) };

// ── Import module under test (after stub is in place) ───────────────────────
const { createSetupView, deriveRowTitle, stripHint, renderOptionCards } = await import('../setup-view.js');

function findRowById(container, id) {
  for (const child of container.children) {
    if (child.dataset.id === id) return child;
  }
  return null;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('start() inserts a collapsed/COMPLETE storage row before startSetup runs', async () => {
  const container = makeEl('div');
  let sawStorageRowBeforeStart = false;

  const fakeStartSetup = async ({ onPrompt: _onPrompt, onLog: _onLog } = {}) => {
    const row = findRowById(container, 'storage');
    sawStorageRowBeforeStart = !!row && row.querySelector('.step-icon').textContent === '✓';
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  await view.start();

  assert.ok(sawStorageRowBeforeStart, 'storage row exists and is COMPLETE before startSetup is invoked');
  const storageRow = findRowById(container, 'storage');
  assert.ok(storageRow, 'storage row is present');
  assert.equal(storageRow.querySelector('.step-sub').textContent, 'This computer');
});

test('gate and confirm-kind activate prompts never render a row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'list', id: 'gate', message: 'Add a new profile?', options: ['create', 'update'] });
    await onPrompt({ kind: 'confirm', id: 'activate', message: 'Activate this profile now?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  await view.start();

  assert.equal(findRowById(container, 'gate-1'), null, 'no gate row ever appears');
  assert.equal(findRowById(container, 'activate-1'), null, 'no activate row ever appears');
});

test('list prompt: renders radio options, resolves with selected index, marks row COMPLETE', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({
      kind: 'list',
      id: 'provider',
      message: 'Pick a provider',
      options: ['OpenAI', 'Bedrock', 'Anthropic'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  // Give onPrompt's synchronous body a tick to run and insert the row.
  await Promise.resolve();
  const row = findRowById(container, 'provider-1');
  assert.ok(row, 'provider-1 row was inserted');
  assert.ok(row.classList._set.has('active'), 'row is ACTIVE while awaiting an answer');

  const control = row.querySelector('.prompt-control');
  assert.ok(control, 'a control was rendered');
  // Task 4 nests each radio one level deeper inside a `.setup-option-card`,
  // so this must search descendants, not just direct children.
  const radios = collectAll(control, (c) => c.type === 'radio');
  assert.equal(radios.length, 3, 'one radio per option');

  radios[1].checked = true; // select "Bedrock" (index 1)
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  assert.ok(submitBtn, 'submit control present');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 1, 'resolved with the selected index');
  assert.ok(!row.classList._set.has('active'), 'row is no longer ACTIVE');
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'row is COMPLETE');
  assert.equal(row.querySelector('.step-sub').textContent, 'Bedrock', 'subtitle is the human-readable choice');
});

test('input prompt: renders a text field, resolves with the typed string, marks row COMPLETE', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile:' });
    return { profileName: resolvedAnswer };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'profileName-1');
  assert.ok(row, 'profileName-1 row was inserted');

  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  assert.ok(input, 'text input present');
  input.value = 'my-workspace';
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 'my-workspace', 'resolved with the typed string');
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'row is COMPLETE');
  assert.equal(row.querySelector('.step-sub').textContent, 'my-workspace', 'subtitle echoes the typed value');
});

test('confirm prompt: Yes is pre-selected, resolves with a boolean, marks row COMPLETE', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'confirm', id: 'installClaude', message: 'Install Claude Code?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'installClaude-1');
  assert.ok(row, 'installClaude-1 row was inserted');

  const control = row.querySelector('.prompt-control');
  const radios = control._children.filter((c) => c.type === 'radio');
  assert.equal(radios.length, 2, 'Yes/No radios present');
  const yesRadio = radios.find((r) => r.value === 'yes');
  assert.ok(yesRadio.checked, 'Yes is pre-selected');

  // Accept the default (Yes) without touching anything.
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, true, 'resolved with boolean true for the pre-selected Yes');
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'row is COMPLETE');
  assert.equal(row.querySelector('.step-sub').textContent, 'Yes', 'subtitle is the human-readable choice');
});

test('confirm prompt: choosing No resolves with false', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'confirm', id: 'installClaude', message: 'Install Claude Code?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'installClaude-1');
  const control = row.querySelector('.prompt-control');
  const radios = control._children.filter((c) => c.type === 'radio');
  const yesRadio = radios.find((r) => r.value === 'yes');
  const noRadio = radios.find((r) => r.value === 'no');
  yesRadio.checked = false;
  noRadio.checked = true;

  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, false, 'resolved with boolean false when No is chosen');
  assert.equal(row.querySelector('.step-sub').textContent, 'No');
});

// ── deriveRowTitle / stripHint unit tests ────────────────────────────────────

test('deriveRowTitle: strips the default hint and trailing colon, hint becomes defaultValue', () => {
  const result = deriveRowTitle('CodeMie organization URL: (https://codemie.lab.epam.com)');
  assert.deepEqual(result, { title: 'CodeMie organization URL', defaultValue: 'https://codemie.lab.epam.com' });
});

test('deriveRowTitle: a hint-less message strips only the trailing colon, empty defaultValue', () => {
  const result = deriveRowTitle('credential:');
  assert.deepEqual(result, { title: 'credential', defaultValue: '' });
});

test('stripHint: removes the default-hint suffix but leaves the colon intact', () => {
  assert.equal(stripHint('Enter a name for this profile: (sso)'), 'Enter a name for this profile:');
  assert.equal(stripHint('Enter a name for this profile: taken'), 'Enter a name for this profile: taken');
});

// ── Reopen-vs-new-row behavior ───────────────────────────────────────────────

test('reopen: a re-ask whose stripped message starts-with the stored base reopens the same row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    const first = onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: (sso)' });
    await Promise.resolve();
    // Reopen before the first prompt resolves is unrealistic for a real driver
    // (it awaits one prompt at a time), but here we just want to inspect state
    // between the two onPrompt invocations, so resolve the first immediately.
    const row1 = findRowById(container, 'profileName-1');
    const control1 = row1.querySelector('.prompt-control');
    const submitBtn1 = control1._children.find((c) => c.className === 'prompt-submit');
    submitBtn1.onclick();
    await first;

    // Re-ask: inquirer dropped the hint and appended the rejected input.
    const second = onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: taken' });
    await Promise.resolve();
    return { first, second };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();
  await Promise.resolve();
  await Promise.resolve();

  // Exactly one row for this prompt id -- no profileName-2.
  assert.ok(findRowById(container, 'profileName-1'), 'profileName-1 row exists');
  assert.equal(findRowById(container, 'profileName-2'), null, 'no second occurrence row was created');

  const row = findRowById(container, 'profileName-1');
  assert.ok(row.classList._set.has('active'), 'reopened row is ACTIVE again');
  assert.equal(row.querySelector('.step-sub').textContent, '', 'old subtitle was cleared on reopen');

  // Answer the reopened row so start() can finish.
  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  input.value = 'my-profile';
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

test('reopen: a byte-identical hint-stripped message (masked-password re-ask) reopens the same row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'password', message: 'Enter password:' });
    // Second ask is identical after stripHint (no hint to begin with).
    return onPrompt({ kind: 'input', id: 'password', message: 'Enter password:' });
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  let row = findRowById(container, 'password-1');
  assert.ok(row, 'password-1 row inserted');
  let control = row.querySelector('.prompt-control');
  let submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(findRowById(container, 'password-2'), null, 'identical re-ask reopens, does not create a new row');
  row = findRowById(container, 'password-1');
  assert.ok(row.classList._set.has('active'), 'row is ACTIVE again after reopen');

  control = row.querySelector('.prompt-control');
  submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

test('new occurrence: same id but a different (non-prefix) hint-stripped message inserts a new row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'freeform', message: 'First question: (default)' });
    return onPrompt({ kind: 'input', id: 'freeform', message: 'Totally different question: (other)' });
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  let row = findRowById(container, 'freeform-1');
  let control = row.querySelector('.prompt-control');
  let submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await Promise.resolve();
  await Promise.resolve();

  const row2 = findRowById(container, 'freeform-2');
  assert.ok(row2, 'a genuinely different message creates a new occurrence row instead of reopening');

  control = row2.querySelector('.prompt-control');
  submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

test('double-rejection: the stored comparison base never advances past the original ask; exactly one row survives', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: (sso)' });
    await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: taken' });
    return onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: taken2' });
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  // First ask.
  await Promise.resolve();
  let row = findRowById(container, 'profileName-1');
  let control = row.querySelector('.prompt-control');
  let submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  // First rejection re-ask ("taken") -- reopens profileName-1.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(findRowById(container, 'profileName-2'), null, 'first rejection does not create a second row');
  row = findRowById(container, 'profileName-1');
  control = row.querySelector('.prompt-control');
  submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  // Second rejection re-ask ("taken2") -- must still compare against the
  // original stored base ("Enter a name for this profile:"), not against
  // "Enter a name for this profile: taken", and must still reopen the same
  // single row rather than creating a third occurrence.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(findRowById(container, 'profileName-2'), null, 'second rejection still does not create a new row');
  assert.equal(findRowById(container, 'profileName-3'), null, 'second rejection does not create a third row');
  row = findRowById(container, 'profileName-1');
  assert.ok(row.classList._set.has('active'), 'row is ACTIVE again after the second reopen');

  control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  input.value = 'final-name';
  submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

// ── renderOptionCards ─────────────────────────────────────────────────────────

test('renderOptionCards: splits an option string at the FIRST " - " into title/description', () => {
  const [card] = renderOptionCards([
    'CodeMie SSO - Enterprise SSO Authentication with centralized model management',
  ]);
  assert.deepEqual(card, {
    title: 'CodeMie SSO',
    description: 'Enterprise SSO Authentication with centralized model management',
    recommended: false,
  });
});

test('renderOptionCards: model fixture -- starred entry strips "⭐ " to title, recommended true', () => {
  // Real parsed strings this module receives, per ui/setup-parse.js's parseOptions
  // applied to ui/test/fixtures/setup/model.json lines 16-17:
  //   "❯ ⭐ claude-sonnet-5 "  -> "⭐ claude-sonnet-5"
  //   "  claude-4-5-sonnet "  -> "claude-4-5-sonnet"
  const [starred, plain] = renderOptionCards(['⭐ claude-sonnet-5', 'claude-4-5-sonnet']);
  assert.deepEqual(starred, { title: 'claude-sonnet-5', description: '', recommended: true });
  assert.deepEqual(plain, { title: 'claude-4-5-sonnet', description: '', recommended: false });
});

test('renderOptionCards: provider prompt badges index 0 regardless of star', () => {
  const cards = renderOptionCards(['⭐ OpenAI', 'Bedrock', 'Anthropic'], { badgeIndex: 0 });
  assert.equal(cards[0].recommended, true, 'index 0 is recommended even without/with a star');
  assert.equal(cards[1].recommended, false);
  assert.equal(cards[2].recommended, false);
  assert.equal(cards[0].title, 'OpenAI', 'star is still stripped from the title');
});

test('renderOptionCards: model list (no badgeIndex) badges by star only, never by index', () => {
  const cards = renderOptionCards(['claude-4-5-sonnet', '⭐ claude-sonnet-5', 'claude-opus-4-5-20251101']);
  assert.equal(cards[0].recommended, false, 'index 0 is not starred, not recommended');
  assert.equal(cards[1].recommended, true, 'starred entry is recommended regardless of index');
  assert.equal(cards[2].recommended, false);
});

test('renderOptionCards: no " - " separator yields the whole string as title, empty description', () => {
  const [card] = renderOptionCards(['claude-sonnet-5']);
  assert.deepEqual(card, { title: 'claude-sonnet-5', description: '', recommended: false });
});

// ── renderOptionCards wired into the list control ────────────────────────────

test('list prompt: provider options render parsed titles and badge the recommended (index 0) entry', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({
      kind: 'list',
      id: 'provider',
      message: 'Pick a provider',
      options: ['CodeMie SSO - Enterprise SSO Authentication with centralized model management', 'Bedrock - AWS'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'provider-1');
  const control = row.querySelector('.prompt-control');
  // Task 4 replaces the flat `.prompt-option-label` span with real
  // `.setup-option-card` markup (title/description/badge elements); the
  // title now lives in a nested `.setup-option-title` element.
  const titles = collectAll(control, (c) => c.className === 'setup-option-title');
  assert.equal(titles[0].textContent, 'CodeMie SSO', 'card title reflects the parsed title, not the raw option string');

  const radios = collectAll(control, (c) => c.type === 'radio');
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  radios[0].checked = true;
  submitBtn.onclick();

  await startPromise;
});

// ── deriveRowTitle wired into the input control ──────────────────────────────

test('input prompt: row title uses deriveRowTitle, input is pre-filled with the parsed default', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({
      kind: 'input',
      id: 'orgUrl',
      message: 'CodeMie organization URL: (https://codemie.lab.epam.com)',
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'orgUrl-1');
  assert.ok(row, 'orgUrl-1 row was inserted');
  assert.equal(row.querySelector('.step-title').textContent, 'CodeMie organization URL', 'title strips hint + colon');

  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  assert.equal(input.value, 'https://codemie.lab.epam.com', 'input is pre-filled with the parsed default');

  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

// ── Task 4: header, PROMPT_COPY, collapsed rows, option cards, Continue ─────

test('header: "Set up CodeMie" heading renders once at mount, before the storage row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async () => ({ profileName: 'default' });

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  await view.start();

  const headers = container._children.filter((c) => c.className === 'setup-view-heading');
  assert.equal(headers.length, 1, 'exactly one header rendered');
  assert.equal(headers[0].textContent, 'Set up CodeMie');
  assert.equal(container._children[0], headers[0], 'header is the first child of the container');

  const storageIndex = container._children.findIndex((c) => c.dataset && c.dataset.id === 'storage');
  assert.ok(storageIndex > 0, 'storage row is inserted after the header');
});

test('PROMPT_COPY: provider row renders its heading/helper while active, collapses to "How to reach a model"', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({
      kind: 'list',
      id: 'provider',
      message: 'Choose your LLM provider:',
      options: ['OpenAI', 'Bedrock'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'provider-1');
  assert.equal(row.querySelector('.step-title').textContent, 'How should CodeMie reach a model?');
  const helperEl = row.querySelector('.step-helper');
  assert.ok(helperEl, 'helper element rendered for the open row');
  assert.equal(helperEl.textContent, 'You can change this later.');

  const control = row.querySelector('.prompt-control');
  const radios = collectAll(control, (c) => c.type === 'radio');
  radios[0].checked = true;
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 0);
  assert.equal(row.querySelector('.step-title').textContent, 'How to reach a model', 'collapsed label overrides the open heading');
  assert.ok(row.classList._set.has('collapsed'), 'row carries the collapsed class once COMPLETE');
});

test('PROMPT_COPY: model row renders its own heading/helper and collapses to "Model", never the provider label', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({
      kind: 'list',
      id: 'model',
      message: 'Choose a model',
      options: ['⭐ claude-sonnet-5', 'claude-4-5-sonnet'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'model-1');
  assert.equal(row.querySelector('.step-title').textContent, 'Which model?');
  assert.equal(row.querySelector('.step-helper').textContent, 'These are the models your account can use.');

  const control = row.querySelector('.prompt-control');
  const radios = collectAll(control, (c) => c.type === 'radio');
  radios[0].checked = true;
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(row.querySelector('.step-title').textContent, 'Model');
  assert.notEqual(row.querySelector('.step-title').textContent, 'How to reach a model', 'never swapped with the provider label');
});

test('PROMPT_COPY: a prompt id outside the table (credential) falls back to deriveRowTitle, proving an override not a takeover', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'credential', message: 'API key:' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'credential-1');
  assert.equal(row.querySelector('.step-title').textContent, 'API key', 'deriveRowTitle fallback used, no table entry for this id');
  assert.equal(row.querySelector('.step-helper'), null, 'no helper text rendered when the table has no entry');

  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  input.value = 'sk-test';
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

test('collapsed class is added only once a row reaches COMPLETE, never while PENDING/ACTIVE', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile:' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'profileName-1');
  assert.ok(row.classList._set.has('active'), 'row is ACTIVE');
  assert.ok(!row.classList._set.has('collapsed'), 'ACTIVE row does not carry the collapsed class');

  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  input.value = 'my-profile';
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.ok(row.classList._set.has('collapsed'), 'COMPLETE row carries the collapsed class');
});

test('option cards: recommended card gets a badge element and the "recommended" class; markup uses real elements, not dataset text', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({
      kind: 'list',
      id: 'model',
      message: 'Choose a model',
      options: ['⭐ claude-sonnet-5 - Balanced default', 'claude-4-5-sonnet'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'model-1');
  const control = row.querySelector('.prompt-control');
  const cards = control._children.filter((c) => (c.className || '').split(' ').includes('setup-option-card'));
  assert.equal(cards.length, 2, 'one card per option');

  const [recommendedCard, plainCard] = cards;
  assert.ok((recommendedCard.className || '').split(' ').includes('recommended'), 'starred option carries the recommended class');
  const titleEl = recommendedCard._children.find((c) => c.className === 'setup-option-title');
  assert.equal(titleEl.textContent, 'claude-sonnet-5');
  const descEl = recommendedCard._children.find((c) => c.className === 'setup-option-description');
  assert.equal(descEl.textContent, 'Balanced default');
  const badge = recommendedCard._children.find((c) => c.className === 'setup-option-badge');
  assert.ok(badge, 'recommended badge element present');
  assert.equal(badge.textContent, 'Recommended');

  assert.ok(!(plainCard.className || '').split(' ').includes('recommended'), 'non-starred option has no recommended class');
  assert.equal(
    plainCard._children.find((c) => c.className === 'setup-option-description'),
    undefined,
    'no description element when the option has an empty description',
  );

  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();
  await startPromise;
});

test('Continue button (list): clicking Continue with a card selected resolves the prompt with that card\'s index', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({
      kind: 'list',
      id: 'model',
      message: 'Choose a model',
      options: ['claude-sonnet-5', 'claude-opus'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'model-1');
  const control = row.querySelector('.prompt-control');
  const cards = control._children.filter((c) => (c.className || '').split(' ').includes('setup-option-card'));
  assert.equal(cards.length, 2, 'one card per option');

  cards[1].onclick(); // select "claude-opus" (index 1) via the card itself

  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 1, 'Continue resolves with the selected card\'s index');
});

test('Continue button (input): clicking Continue with a typed value resolves the prompt with that string', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile:' });
    return { profileName: resolvedAnswer };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'profileName-1');
  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  input.value = 'my-workspace-2';

  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  assert.ok(submitBtn.classList && submitBtn.classList._set.has('setup-continue-btn'), 'Continue button carries the dedicated styling class');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 'my-workspace-2', 'Continue resolves with the typed string');
});
