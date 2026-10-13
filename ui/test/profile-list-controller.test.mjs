import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfileListController } from '../profile-list-controller.js';

const P = (name, active = false) => ({ name, provider: 'p', model: 'm', active });

function fakeBridge({ lists, replies = {} }) {
  const calls = [];
  let reads = 0;
  const reply = (k) => async (...a) => {
    calls.push([k, ...a]);
    return replies[k] ?? { code: 0, stdout: 'ok', stderr: '' };
  };
  return {
    calls,
    codemieConfig: { listProfiles: async () => { calls.push(['list']); return lists[Math.min(reads++, lists.length - 1)]; } },
    profile: { switch: reply('switch'), rename: reply('rename'), delete: reply('delete') },
  };
}

test('switch calls the bridge once, re-reads, and takes state from the re-read, not the reply', async () => {
  const bridge = fakeBridge({
    lists: [[P('a', true), P('b')], [P('a'), P('b', true)]],
    replies: { switch: { code: 0, stdout: 'x', stderr: '' } },
  });
  let changed = 0;
  const c = createProfileListController({ bridge, onChanged: () => { changed++; } });
  await c.load();
  await c.switchTo('b');
  assert.deepEqual(bridge.calls.map((x) => x[0]), ['list', 'switch', 'list']);
  assert.equal(c.state.profiles.find((p) => p.active).name, 'b');
  assert.equal(changed, 1);
  assert.equal(c.state.busy, false);
});

test('a failed rename keeps the list and shows the last non-empty line of the CLI message', async () => {
  const list = [P('a', true), P('b')];
  const bridge = fakeBridge({
    lists: [list, list],
    replies: { rename: { code: 1, stdout: '', stderr: 'starting\nProfile "b" already exists\n\n' } },
  });
  const c = createProfileListController({ bridge });
  await c.load();
  await c.rename('a', 'b');
  assert.deepEqual(c.state.profiles, list);
  assert.equal(c.state.failure.message, 'Profile "b" already exists');
  assert.deepEqual(bridge.calls.filter((x) => x[0] === 'rename')[0], ['rename', 'a', 'b']);
});

test('remove calls bridge.profile.delete exactly once and names the new active profile', async () => {
  const bridge = fakeBridge({ lists: [[P('a', true), P('b')], [P('b', true)]] });
  const c = createProfileListController({ bridge });
  await c.load();
  await c.remove('a');
  assert.equal(bridge.calls.filter((x) => x[0] === 'delete').length, 1);
  assert.equal(c.state.notice, 'Active profile now: b');
  assert.equal(c.state.failure, null);
});

test('deleting the last profile leaves no notice', async () => {
  const bridge = fakeBridge({ lists: [[P('a', true)], []] });
  const c = createProfileListController({ bridge });
  await c.load();
  await c.remove('a');
  assert.deepEqual(c.state.profiles, []);
  assert.equal(c.state.notice, null);
});

test('a second action while busy is ignored', async () => {
  const bridge = fakeBridge({ lists: [[P('a', true), P('b')]] });
  const c = createProfileListController({ bridge });
  await c.load();
  const first = c.switchTo('b');
  const second = c.remove('a');
  await Promise.all([first, second]);
  assert.equal(bridge.calls.filter((x) => x[0] === 'delete').length, 0);
  assert.equal(bridge.calls.filter((x) => x[0] === 'switch').length, 1);
});

test('subscribers hear about busy and idle states', async () => {
  const bridge = fakeBridge({ lists: [[P('a', true)]] });
  const c = createProfileListController({ bridge });
  const seen = [];
  c.subscribe((s) => seen.push(s.busy));
  await c.switchTo('a');
  assert.deepEqual(seen, [true, false]);
});
