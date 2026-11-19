// trackPress over a fake window (node's EventTarget): when a press becomes a drag, which click
// after the drop is swallowed, and a press dropped by onStart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackPress } from '../workspace/press.js';

function page() {
  const win = Object.assign(new EventTarget(), { navigator: {} });
  const doc = { defaultView: win, body: { classList: { add() {}, remove() {} } } };
  const fire = (type, clientX, clientY) => {
    const ev = Object.assign(new Event(type, { cancelable: true }), { clientX, clientY });
    win.dispatchEvent(ev);
    return ev;
  };
  const press = (clientX, clientY, options) => trackPress({ pointerType: 'mouse', button: 0, clientX, clientY, target: { ownerDocument: doc } }, options);
  return { fire, press };
}

test('a click right after a drop lands, unless it is the drop\'s own click', () => {
  const { fire, press } = page();
  const calls = [];
  const drag = () => press(10, 10, { onStart: () => { calls.push('start'); }, onMove: (ev, d) => calls.push(['move', d.dx]), onEnd: (ev, d) => calls.push(['end', d.dx]) });
  drag();
  fire('pointermove', 12, 10);
  assert.deepEqual(calls, [], 'not a drag below the threshold');
  fire('pointermove', 40, 10);
  fire('pointerup', 40, 10);
  assert.deepEqual(calls, ['start', ['move', 30], ['end', 30]]);
  // Chromium sends no click when the release ended on another element; Undo clicked at once lands.
  assert.equal(fire('click', 300, 200).defaultPrevented, false, 'the next click is not swallowed');
  // The click the browser does send for the release itself is swallowed, once.
  drag();
  fire('pointermove', 60, 30);
  fire('pointerup', 60, 30);
  assert.equal(fire('click', 60, 30).defaultPrevented, true);
  assert.equal(fire('click', 60, 30).defaultPrevented, false, 'only once');
});

test('onStart returning false drops the press', () => {
  const { fire, press } = page();
  const calls = [];
  press(10, 10, { onStart: () => false, onMove: () => calls.push('move'), onEnd: () => calls.push('end'), onCancel: () => calls.push('cancel') });
  fire('pointermove', 40, 10);
  fire('pointermove', 80, 10);
  fire('pointerup', 80, 10);
  assert.deepEqual(calls, []);
  assert.equal(fire('click', 80, 10).defaultPrevented, false, 'a dropped press swallows nothing');
});
