import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupDoctorResults } from '../doctor-groups.js';

const ok = (name) => ({ name, status: 'ok', message: 'fine' });

test('runtime checks collapse into one CodeMie-itself row', () => {
  const { rows } = groupDoctorResults([ok('Node Version'), ok('Npm'), ok('Python'), ok('Uv')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, 'codemie');
  assert.equal(rows[0].status, 'pass');
});

test('Agents failure gets a Go to Agents deep-link action', () => {
  const { rows } = groupDoctorResults([
    { name: 'Agents', status: 'error', message: 'No agents installed', hint: 'Run: codemie install agent' },
  ]);
  const agents = rows.find((r) => r.label === 'Agents');
  assert.equal(agents.group, 'tools');
  assert.deepEqual(agents.action, { kind: 'navigate', view: 'agents', label: 'Go to Agents' });
});

test('a failing check with a hint but no deep-link gets a Check again action', () => {
  const { rows } = groupDoctorResults([
    { name: 'JWT Auth', status: 'error', message: 'Not authenticated', hint: 'Set TOKEN or run: codemie setup' },
  ]);
  const row = rows.find((r) => r.label === 'JWT Auth');
  assert.equal(row.group, 'account');
  assert.deepEqual(row.action, { kind: 'recheck', label: 'Check again' });
  assert.equal(row.remedyText, 'Set TOKEN or run: codemie setup');
});

test('a failing check with no hint and no deep-link gets no action', () => {
  const { rows } = groupDoctorResults([{ name: 'Workflows', status: 'error', message: 'unreachable' }]);
  assert.equal(rows.find((r) => r.label === 'Workflows').action, undefined);
});

test('summary reflects only what ran, no hardcoded total', () => {
  const withProvider = groupDoctorResults([ok('Node Version'), ok('Provider')]).summary;
  const withoutProvider = groupDoctorResults([ok('Node Version')]).summary;
  assert.deepEqual(withProvider, { passing: 2, total: 2 });
  assert.deepEqual(withoutProvider, { passing: 1, total: 1 });
});
