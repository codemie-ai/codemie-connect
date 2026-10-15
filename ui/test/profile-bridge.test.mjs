import test from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let reply = { code: 1, stdout: '', stderr: 'name exists' };
globalThis.window = { __TAURI__: {
  core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'cmdlog_open') return 'log1';
    if (cmd === 'cmdlog_append' || cmd === 'cmdlog_close') return null;
    if (cmd === 'list_codemie_profiles') return [{ name: 'a', provider: 'p', model: 'm', active: true }];
    return reply;
  } },
  event: { listen: async () => () => {} },
} };
const { profile, codemieConfig } = await import('../runner-bridge.js');
const named = (cmd) => calls.filter(([c]) => c === cmd).map(([, a]) => a);

test('listProfiles invokes list_codemie_profiles', async () => {
  const list = await codemieConfig.listProfiles();
  assert.equal(list[0].name, 'a');
});

test('rename logs the real command with both names, its output and exit code', async () => {
  calls.length = 0;
  const res = await profile.rename('old', 'taken');
  assert.equal(res.code, 1);
  assert.deepEqual(calls.find(([c]) => c === 'rename_profile')[1], { old: 'old', new: 'taken' });
  assert.match(named('cmdlog_open')[0].command, /codemie profile rename old taken/);
  assert.equal(named('cmdlog_append')[0].chunk, 'name exists');
  assert.equal(named('cmdlog_close')[0].exitCode, 1);
});

test('delete and switch labels carry the profile name', async () => {
  calls.length = 0;
  reply = { code: 0, stdout: 'done', stderr: '' };
  await profile.delete('gone');
  await profile.switch('other');
  const cmds = named('cmdlog_open').map((a) => a.command);
  assert.match(cmds[0], /codemie profile delete gone --yes/);
  assert.match(cmds[1], /codemie profile switch other/);
});
