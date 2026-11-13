import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinUpdateStatus } from '../agents-join.js';

const agents = [
  { name: 'CodeMie Code', command: 'codemie-code', installed: true, version: '0.0.47', description: 'CodeMie Code' },
  { name: 'Claude Code', command: 'claude', installed: true, version: '2.1.269', description: 'Claude Code' },
  { name: 'Gemini CLI', command: 'gemini', installed: false, version: null, description: 'Gemini CLI' },
];

test('a matching update record sets updateAvailable per agent', () => {
  const joined = joinUpdateStatus(agents, [
    { displayName: 'CodeMie Code', updateAvailable: false },
    { displayName: 'Claude Code', updateAvailable: true },
  ]);
  assert.deepEqual(
    joined.map((a) => [a.name, a.updateAvailable]),
    [
      ['CodeMie Code', false],
      ['Claude Code', true],
      ['Gemini CLI', false],
    ],
  );
});

test('an agent missing from updateRecords is not flagged and does not throw', () => {
  assert.doesNotThrow(() => joinUpdateStatus(agents, []));
  const joined = joinUpdateStatus(agents, []);
  assert.deepEqual(
    joined.map((a) => a.updateAvailable),
    [false, false, false],
  );
});

test('join never touches version, description or installed', () => {
  const joined = joinUpdateStatus(agents, [{ displayName: 'Claude Code', updateAvailable: true }]);
  const claude = joined.find((a) => a.name === 'Claude Code');
  assert.equal(claude.version, '2.1.269');
  assert.equal(claude.description, 'Claude Code');
  assert.equal(claude.installed, true);
});

test('an agent with an update carries the version on offer; one without does not', () => {
  const joined = joinUpdateStatus(agents, [
    { displayName: 'CodeMie Code', updateAvailable: false, latest: '0.0.47' },
    { displayName: 'Claude Code', updateAvailable: true, latest: '2.2.0' },
  ]);
  assert.equal(joined.find((a) => a.name === 'Claude Code').latest, '2.2.0');
  assert.equal(joined.find((a) => a.name === 'CodeMie Code').latest, '0.0.47');
});

test('an installed version above the supported one is newerThanSupported', () => {
  const joined = joinUpdateStatus(agents, [
    { displayName: 'Claude Code', updateAvailable: false, current: '2.1.290', latest: '2.1.281' },
  ]);
  const claude = joined.find((a) => a.name === 'Claude Code');
  assert.equal(claude.newerThanSupported, true);
  assert.equal(claude.current, '2.1.290');
  assert.equal(claude.latest, '2.1.281');
});

test('equal versions, a missing record and a prerelease are not newerThanSupported', () => {
  const equal = joinUpdateStatus(agents, [{ displayName: 'Claude Code', updateAvailable: false, current: '2.1.281', latest: '2.1.281' }]);
  assert.equal(equal.find((a) => a.name === 'Claude Code').newerThanSupported, false);
  const none = joinUpdateStatus(agents, []);
  assert.deepEqual(none.map((a) => a.newerThanSupported), [false, false, false]);
  const pre = joinUpdateStatus(agents, [{ displayName: 'Claude Code', updateAvailable: false, current: '1.0.0-beta', latest: '0.9.0' }]);
  assert.equal(pre.find((a) => a.name === 'Claude Code').newerThanSupported, false);
  const pre2 = joinUpdateStatus(agents, [{ displayName: 'Claude Code', updateAvailable: false, current: '2.0.0', latest: '1.0.0-beta' }]);
  assert.equal(pre2.find((a) => a.name === 'Claude Code').newerThanSupported, false);
});

test('the built-in agent is never newerThanSupported, whatever its Current says', () => {
  const joined = joinUpdateStatus(agents, [
    { displayName: 'CodeMie Code', updateAvailable: false, current: '0.16.0', latest: '0.15.2' },
  ]);
  assert.equal(joined.find((a) => a.name === 'CodeMie Code').newerThanSupported, false);
});
