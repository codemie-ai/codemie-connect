import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stub, the shape the other view tests use, plus dataset and
// closest() for the row-click delegation.
function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    className: '',
    textContent: '',
    dataset: {},
    appendChild(c) {
      c._parent = el;
      el._children.push(c);
      return c;
    },
    append(...cs) {
      cs.forEach((c) => el.appendChild(c));
    },
    querySelector(sel) {
      return find(el, sel);
    },
    closest(sel) {
      let n = el;
      while (n) {
        if (matches(n, sel)) return n;
        n = n._parent;
      }
      return null;
    },
    // Bubbles like a DOM click: the handler up the tree sees the original target.
    _click(target = el) {
      if (el.onclick) el.onclick({ target, stopPropagation() {} });
      else if (el._parent) el._parent._click(target);
    },
    _text() {
      return el._children.length ? el._children.map((c) => c._text()).join(' ') : el.textContent;
    },
    _all(pred) {
      const out = [];
      (function walk(n) {
        if (pred(n)) out.push(n);
        n._children.forEach(walk);
      })(el);
      return out;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => '',
    set() {
      el._children = [];
    },
  });
  return el;
}
function matches(n, sel) {
  const m = sel.match(/^\.([\w-]+)(?:\[data-id="([^"]+)"\])?$/);
  if (!m) return false;
  return n.className.split(' ').includes(m[1]) && (!m[2] || n.dataset.id === m[2]);
}
function find(root, sel) {
  for (const c of root._children) {
    if (matches(c, sel)) return c;
    const f = find(c, sel);
    if (f) return f;
  }
  return null;
}
globalThis.document = { createElement: makeEl };

// Recording stand-in for the steps-ui instance: builds a .step-row per step so
// the view has rows to hang the sign-in control on, and records the calls.
function fakeStepsUi() {
  const calls = [];
  return {
    calls,
    renderSteps(container, list) {
      calls.push(['renderSteps', list.map((s) => s.id)]);
      for (const s of list) {
        const row = makeEl('div');
        row.className = 'step-row';
        row.dataset.id = s.id;
        container.appendChild(row);
      }
    },
    setStatus(id, status) {
      calls.push(['setStatus', id, status]);
    },
    setSubtitle(id, text) {
      calls.push(['setSubtitle', id, text]);
    },
  };
}

const { createHomeView } = await import('../home-view.js');

const item = (id, status, subtitle = '') => ({ id, title: id, status, subtitle });
const checklist = {
  done: false,
  items: [item('sign-in', 'PENDING', 'Opens your browser'), item('model', 'COMPLETE', 'demo7'), item('agent', 'PENDING'), item('health', 'PENDING')],
  cards: [],
};
const steady = {
  done: true,
  items: [],
  cards: [
    { id: 'profile', title: 'Profile', badge: { text: 'active', tone: 'good' }, line: 'demo7 · claude-sonnet-5', note: 'Project x' },
    { id: 'health', title: 'Health', badge: { text: '6 of 8', tone: 'warn' }, line: '2 things need attention', note: '' },
    { id: 'agents', title: 'Agents', badge: { text: '3 of 11', tone: 'good' }, line: 'Claude Code', note: '' },
  ],
};

test('the checklist renders the four items on the injected steps-ui instance, in order, with status and subtitle', () => {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  createHomeView(container, { stepsUi }).render(checklist);
  assert.deepEqual(stepsUi.calls[0], ['renderSteps', ['sign-in', 'model', 'agent', 'health']]);
  assert.ok(stepsUi.calls.some((c) => c[0] === 'setStatus' && c[1] === 'model' && c[2] === 'COMPLETE'));
  assert.ok(stepsUi.calls.some((c) => c[0] === 'setSubtitle' && c[1] === 'sign-in' && c[2] === 'Opens your browser'));
  assert.ok(container._text().includes("Welcome — let's get CodeMie working"));
  assert.equal(container.querySelector('.home-cards'), null);
});

test('item 1 gets an in-place Sign in control while it is open, and none once complete', () => {
  const container = makeEl('div');
  let signedIn = 0;
  const view = createHomeView(container, { stepsUi: fakeStepsUi(), onSignIn: () => (signedIn += 1) });
  view.render(checklist);
  const btn = container._all((n) => n._tag === 'button' && n.textContent === 'Sign in')[0];
  assert.ok(btn, 'a Sign in button under item 1');
  assert.equal(btn._parent._parent.dataset.id, 'sign-in');
  btn._click();
  assert.equal(signedIn, 1);

  const done = { ...checklist, items: [item('sign-in', 'COMPLETE', 'Signed in'), ...checklist.items.slice(1)] };
  view.render(done);
  assert.equal(container._all((n) => n._tag === 'button' && n.textContent === 'Sign in').length, 0);
});

// Items 2 and 4 navigate; items 1 and 3 complete in place (EPMCDME-15189,
// superseding EPMCDME-14589's "a screen for items 2, 3 and 4").
// Item 4 runs by itself, and clicking its row took the user off Home to a
// screen that looked like the row opening. Only item 2 navigates on a click.
test('clicking item 2 reports the item; items 1, 3 and 4 do not navigate', () => {
  const container = makeEl('div');
  const opened = [];
  createHomeView(container, { stepsUi: fakeStepsUi(), onItem: (id) => opened.push(id) }).render(checklist);
  for (const id of ['model', 'agent', 'health', 'sign-in']) {
    container.querySelector(`.step-row[data-id="${id}"]`)._click();
  }
  assert.deepEqual(opened, ['model']);
});

// A check that found problems keeps the checklist up, and the sidebar's Health
// is locked until it finishes: the row itself offers the way to the problems.
test('a health check with problems offers Open Health in its row; a running one shows a spinner', () => {
  const opened = [];
  const warned = { ...checklist, items: checklist.items.map((i) => (i.id === 'health' ? item('health', 'WARNING', '1 problem to fix') : i)) };
  const container = makeEl('div');
  createHomeView(container, { stepsUi: fakeStepsUi(), onItem: (id) => opened.push(id) }).render(warned);
  const btn = container._all((n) => n._tag === 'button' && n.textContent === 'Open Health')[0];
  assert.ok(btn, 'Open Health is offered');
  btn.onclick({ stopPropagation() {} });
  assert.deepEqual(opened, ['health']);

  const running = { ...checklist, items: checklist.items.map((i) => (i.id === 'health' ? item('health', 'ACTIVE', 'Checking…') : i)) };
  const c2 = makeEl('div');
  createHomeView(c2, { stepsUi: fakeStepsUi() }).render(running);
  assert.ok(c2.querySelector('.inline-spinner'), 'a small spinner beside Checking…');
  assert.equal(c2._all((n) => n._tag === 'button' && n.textContent === 'Open Health').length, 0);
});

// A ticked item 3 opens the same way: one agent installed does not mean there
// is nothing left to add, and the screen is still a click away from inside it.
test('a completed item 3 opens in place too, rather than navigating', () => {
  const container = makeEl('div');
  const opened = [];
  const done = { ...checklist, items: checklist.items.map((i) => (i.id === 'agent' ? item('agent', 'COMPLETE', 'Claude Code') : i)) };
  createHomeView(container, { stepsUi: fakeStepsUi(), onItem: (id) => opened.push(id) }).render(done);
  container.querySelector('.step-row[data-id="agent"]')._click();
  assert.deepEqual(opened, []);
});

test('when everything is done the three cards replace the checklist, on the same container', () => {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  const view = createHomeView(container, { stepsUi });
  view.render(checklist);
  view.render(steady);
  assert.equal(container.querySelector('.home-check'), null);
  const cards = container._all((n) => n.className.startsWith('home-card '));
  assert.deepEqual(cards.map((c) => c.dataset.card), ['profile', 'health', 'agents']);
  assert.ok(container._text().includes('6 of 8'));
  assert.ok(container._text().includes('demo7 · claude-sonnet-5'));
  assert.equal(stepsUi.calls.filter((c) => c[0] === 'renderSteps').length, 1, 'cards do not touch the step list');
});

test('the Profile card offers Set up again; the other cards open their screen', () => {
  const container = makeEl('div');
  const events = [];
  createHomeView(container, {
    stepsUi: fakeStepsUi(),
    onSetupAgain: () => events.push('setup-again'),
    onCard: (id) => events.push(`card:${id}`),
  }).render(steady);
  container._all((n) => n._tag === 'button' && n.textContent === 'Set up again')[0]._click();
  container.querySelector('.home-card-warn')._click();
  container._all((n) => n.dataset.card === 'agents')[0]._click();
  assert.deepEqual(events, ['setup-again', 'card:health', 'card:agents']);
});

// The welcome heading already titles the checklist; the header only earns its
// place once setup is done, where its line says something the cards do not.
test('Home\'s header hides while the checklist is up and shows once setup is done', async () => {
  const { applyHomeHeader } = await import('../home-view.js');
  const classes = new Set();
  const header = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  const sub = { textContent: 'stale' };
  const root = { getElementById: (id) => ({ 'home-header': header, 'home-subtitle': sub })[id] };

  applyHomeHeader(root, { done: false });
  assert.equal(classes.has('hidden'), true, 'hidden during onboarding');
  assert.equal(sub.textContent, '');

  applyHomeHeader(root, { done: true });
  assert.equal(classes.has('hidden'), false, 'shown once done');
  assert.equal(sub.textContent, 'Everything is set up. Here is how things stand.');
});

test('no Sign in button while the sign-in read is still out', () => {
  const container = makeEl('div');
  const reading = { ...checklist, items: checklist.items.map((i) => (i.id === 'sign-in' ? item('sign-in', 'ACTIVE', 'Checking…') : i)) };
  createHomeView(container, { stepsUi: fakeStepsUi() }).render(reading);
  assert.equal(container._all((n) => n._tag === 'button' && n.textContent === 'Sign in').length, 0);
});
