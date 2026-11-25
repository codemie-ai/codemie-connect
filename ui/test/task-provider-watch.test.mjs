// `createRemovalSwitch` (task-provider design §11, ruling 16): removing the active provider's
// plugin switches Connect to Local once. The real-app tour (T61) found three: `installedChanged`
// is told of the same removal several times (the controller's own read, the Plugins tab
// reopening, the native `plugins:reloaded` event), and before this guard each telling raced its
// own `switchToLocal` call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemovalSwitch } from '../workspace/task-provider-watch.js';

test('three tellings of the same removal switch to Local exactly once', async () => {
  let calls = 0;
  const switchToLocal = () => { calls += 1; return Promise.resolve({ provider: 'local', copied: 0 }); };
  const switchRemoved = createRemovalSwitch(switchToLocal);
  // The controller's own `afterChange`, the Plugins tab reopening and the native
  // `plugins:reloaded` listener: three calls, all before the first's mutate has settled.
  const results = [
    switchRemoved('plugin:todoist', false),
    switchRemoved('plugin:todoist', false),
    switchRemoved('plugin:todoist', false),
  ];
  await Promise.all(results.filter(Boolean));
  assert.equal(calls, 1, `expected exactly one switch, got ${calls}`);
});

test('does nothing while the provider is still installed, or already Local', () => {
  let calls = 0;
  const switchRemoved = createRemovalSwitch(() => { calls += 1; return Promise.resolve(); });
  assert.equal(switchRemoved('plugin:todoist', true), null);
  assert.equal(switchRemoved('local', false), null);
  assert.equal(calls, 0);
});

test('a later, separate removal switches again once the first has settled', async () => {
  let calls = 0;
  const switchRemoved = createRemovalSwitch(() => { calls += 1; return Promise.resolve(); });
  await switchRemoved('plugin:todoist', false);
  assert.equal(calls, 1);
  // Reinstalled, then removed again later: a fresh removal, not the same one.
  switchRemoved('plugin:todoist', true);
  await switchRemoved('plugin:todoist', false);
  assert.equal(calls, 2);
});

test('a rejected switch still clears the guard, so the next telling can try again', async () => {
  let calls = 0;
  const switchRemoved = createRemovalSwitch(() => { calls += 1; return Promise.reject(new Error('offline')); });
  await assert.rejects(() => switchRemoved('plugin:todoist', false));
  await assert.rejects(() => switchRemoved('plugin:todoist', false));
  assert.equal(calls, 2);
});
