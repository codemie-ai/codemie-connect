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
