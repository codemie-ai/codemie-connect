import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDoctorOutput } from '../doctor-parse.js';

function fixture(id) {
  return readFileSync(fileURLToPath(new URL(`fixtures/doctor/${id}.txt`, import.meta.url)), 'utf8');
}

test('all-passing: every check parses ok, no hints', () => {
  const records = parseDoctorOutput(fixture('all-passing'));
  assert.equal(records.length, 12);
  assert.ok(records.every((r) => r.status === 'ok'));
  assert.ok(records.some((r) => r.name === 'Provider'));
});

test('provider-failure: Provider fails with a hint', () => {
  const records = parseDoctorOutput(fixture('provider-failure'));
  const provider = records.find((r) => r.name === 'Provider');
  assert.equal(provider.status, 'error');
  assert.equal(provider.hint, 'Check your network connection and try again');
});

test('provider-absent: no Provider record, Active Profile warns', () => {
  const records = parseDoctorOutput(fixture('provider-absent'));
  assert.ok(!records.some((r) => r.name === 'Provider'));
  const profile = records.find((r) => r.name === 'Active Profile');
  assert.equal(profile.status, 'warn');
  assert.equal(profile.hint, 'Run: codemie setup');
});
