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
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    remove() {
      if (el._parent) el._parent._children = el._parent._children.filter((c) => c !== el);
    },
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

test('while the browser sign-in is open, Sign in is disabled and says so', () => {
  const container = makeEl('div');
  const view = createHomeView(container, { stepsUi: fakeStepsUi(), onSignIn: () => {} });
  view.render({ ...checklist, signingIn: true });
  const btn = container._all((n) => n._tag === 'button' && n.textContent === 'Waiting for the browser…')[0];
  assert.ok(btn, 'the button says what it waits for');
  assert.equal(btn.disabled, true);
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

test('the Profile card offers only Manage profiles; the other cards open their screen', () => {
  const container = makeEl('div');
  const events = [];
  createHomeView(container, {
    stepsUi: fakeStepsUi(),
    onManageProfiles: () => events.push('profiles'),
    onCard: (id) => events.push(`card:${id}`),
  }).render(steady);
  assert.equal(container._all((n) => n._tag === 'button' && n.textContent === 'Set up again').length, 0);
  container._all((n) => n._tag === 'button' && n.textContent === 'Manage profiles')[0]._click();
  container.querySelector('.home-card-warn')._click();
  container._all((n) => n.dataset.card === 'agents')[0]._click();
  assert.deepEqual(events, ['profiles', 'card:health', 'card:agents']);
});

// The welcome heading already titles the checklist; the header only earns its
// place once setup is done, where its line says something the cards do not.
test('Home\'s header hides while the checklist is up and shows once setup is done', async () => {
  const { applyHomeHeader } = await import('../home-view.js');
  const classes = new Set();
  const updateClasses = new Set();
  const header = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  const updates = { classList: { toggle: (c, on) => (on ? updateClasses.add(c) : updateClasses.delete(c)) } };
  const sub = { textContent: 'stale' };
  const root = { getElementById: (id) => ({ 'home-header': header, 'home-subtitle': sub, 'home-updates': updates })[id] };

  applyHomeHeader(root, { done: false });
  assert.equal(classes.has('hidden'), true, 'hidden during onboarding');
  assert.equal(updateClasses.has('hidden'), true, 'no update cards on the checklist');
  assert.equal(sub.textContent, '');

  applyHomeHeader(root, { done: true });
  assert.equal(classes.has('hidden'), false, 'shown once done');
  assert.equal(updateClasses.has('hidden'), false, 'update cards come back under the status cards');
  assert.equal(sub.textContent, 'Everything is set up. Here is how things stand.');
});

test('no Sign in button while the sign-in read is still out', () => {
  const container = makeEl('div');
  const reading = { ...checklist, items: checklist.items.map((i) => (i.id === 'sign-in' ? item('sign-in', 'ACTIVE', 'Checking…') : i)) };
  createHomeView(container, { stepsUi: fakeStepsUi() }).render(reading);
  assert.equal(container._all((n) => n._tag === 'button' && n.textContent === 'Sign in').length, 0);
});

const expired = {
  done: false,
  broken: 'expired',
  brokenCopy: { title: 'Your profile is no longer working', body: 'CodeMie signed you out - the sign-in for demo7 expired.', actions: ['signin', 'delete'] },
  items: checklist.items,
  cards: [],
};
const dangling = {
  ...expired,
  broken: 'dangling',
  brokenCopy: { title: 'Your profile is no longer working', body: 'ghost is set as your profile but it no longer exists.', actions: ['setup'] },
};
const buttons = (container) => container._all((n) => n._tag === 'button');
const labels = (container) => buttons(container).map((b) => b.textContent);
const tick = () => new Promise((r) => setImmediate(r));

test('an expired sign-in shows the panel with two actions, and no checklist or cards', () => {
  const container = makeEl('div');
  createHomeView(container, { stepsUi: fakeStepsUi() }).render(expired);
  const text = container._text();
  assert.ok(text.includes('Your profile is no longer working'));
  assert.ok(text.includes('demo7'));
  assert.deepEqual(labels(container), ['Sign in again', 'Delete this profile']);
  assert.equal(container.querySelector('.home-check'), null);
  assert.equal(container.querySelector('.home-cards'), null);
});

test('a dangling profile shows one Set up again button and never a Delete', () => {
  const container = makeEl('div');
  let deleted = 0;
  createHomeView(container, { stepsUi: fakeStepsUi(), onDeleteProfile: async () => { deleted += 1; return { ok: true }; } }).render(dangling);
  assert.deepEqual(labels(container), ['Set up again']);
  assert.equal(deleted, 0);
});

test('each primary action calls onSignIn', () => {
  for (const state of [expired, dangling]) {
    const container = makeEl('div');
    let signedIn = 0;
    createHomeView(container, { stepsUi: fakeStepsUi(), onSignIn: () => (signedIn += 1) }).render(state);
    buttons(container)[0].onclick();
    assert.equal(signedIn, 1, state.broken);
  }
});

test('Delete runs once however often it is clicked, and a re-render mid-flight still says Deleting', async () => {
  const container = makeEl('div');
  let calls = 0;
  let finish;
  const view = createHomeView(container, {
    stepsUi: fakeStepsUi(),
    onDeleteProfile: () => { calls += 1; return new Promise((r) => { finish = r; }); },
  });
  view.render(expired);
  const del = () => buttons(container).find((b) => b.textContent === 'Delete this profile' || b.textContent === 'Deleting…');
  del().onclick();
  del().onclick();
  assert.equal(calls, 1);
  assert.equal(del().textContent, 'Deleting…');
  assert.equal(del().disabled, true);
  view.render(expired);
  assert.equal(del().textContent, 'Deleting…', 'a focus-triggered re-render keeps the busy state');
  del().onclick();
  assert.equal(calls, 1);
  finish({ ok: true });
  await tick();
});

test('a failed delete shows the CLI sentence inline and the button works again', async () => {
  const container = makeEl('div');
  let calls = 0;
  const view = createHomeView(container, {
    stepsUi: fakeStepsUi(),
    onDeleteProfile: async () => { calls += 1; return { ok: false, message: 'permission denied', raw: 'full output' }; },
  });
  view.render(expired);
  buttons(container).find((b) => b.textContent === 'Delete this profile').onclick();
  await tick();
  assert.ok(container._text().includes('permission denied'));
  const del = buttons(container).find((b) => b.textContent === 'Delete this profile');
  assert.ok(del, 'label is back');
  assert.ok(!del.disabled);
  del.onclick();
  assert.equal(calls, 2);
  await tick();
});

test('Manage profiles opens the profiles screen and draws nothing inside the Profile card', () => {
  const container = makeEl('div');
  let opened = 0;
  const view = createHomeView(container, { stepsUi: fakeStepsUi(), onManageProfiles: () => { opened += 1; } });
  view.render(steady);
  const manage = container._all((n) => n._tag === 'button' && n.textContent === 'Manage profiles')[0];
  manage.onclick({ stopPropagation() {} });
  assert.equal(opened, 1);
  const profileCard = container._all((n) => n.dataset && n.dataset.card === 'profile')[0];
  assert.equal(profileCard._all((n) => n._tag === 'button').length, 1, 'only Manage profiles');
});
