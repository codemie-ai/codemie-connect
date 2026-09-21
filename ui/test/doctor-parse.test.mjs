// Both fixtures are real `codemie doctor` stdout from CLI 0.15.2, captured
// through a pipe the way run_stream reads it (no ANSI, spinner on stderr):
//   signed-in.txt    a signed-in SSO profile, two agents the CLI has advice on
//   sso-expired.txt  the same profile under a fresh HOME with no stored
//                    credentials, which also prints the CLI's migration preamble
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDoctorOutput } from '../doctor-parse.js';

function fixture(id) {
  return readFileSync(fileURLToPath(new URL(`fixtures/doctor/${id}.txt`, import.meta.url)), 'utf8');
}

test('signed-in: every section the CLI prints becomes records under its own name', () => {
  const records = parseDoctorOutput(fixture('signed-in'));
  assert.equal(records.length, 25);
  assert.deepEqual(
    [...new Set(records.map((r) => r.name))],
    [
      'Node.js',
      'npm',
      'Python',
      'uv',
      'AWS CLI',
      'Active Profile',
      'CodeMie SSO Provider',
      'JWT Authentication',
      'Installed Agents',
      'Repository & Workflows',
      'Frameworks',
    ],
  );
  assert.ok(records.every((r) => r.status !== 'error'));
});

test('signed-in: the icon sets the status and the indented line under an item is its hint', () => {
  const records = parseDoctorOutput(fixture('signed-in'));
  const codemieCode = records.find((r) => r.message.startsWith('CodeMie Code'));
  assert.equal(codemieCode.status, 'warn');
  assert.equal(codemieCode.hint, 'codemie install codemie-code --supported');
  const claude = records.find((r) => r.message === 'Claude Code (2.1.269)');
  assert.equal(claude.status, 'ok');
  assert.equal(claude.hint, undefined);
  assert.equal(records.find((r) => r.name === 'JWT Authentication').status, 'info');
});

test('the title, the closing verdict and the tip under it are not checks', () => {
  for (const id of ['signed-in', 'sso-expired']) {
    const text = parseDoctorOutput(fixture(id))
      .map((r) => `${r.name} ${r.message}`)
      .join('\n');
    assert.doesNotMatch(text, /Health Check|All checks passed|Some issues detected|Reporting a bug/);
  }
});

test('sso-expired: the failing provider item carries the CLI hint, the warning beside it has none', () => {
  const provider = parseDoctorOutput(fixture('sso-expired')).filter((r) => r.name === 'CodeMie SSO Provider');
  const missing = provider.find((r) => r.message === 'SSO credentials not found');
  assert.equal(missing.status, 'error');
  assert.equal(missing.hint, 'Run: codemie profile login');
  const required = provider.find((r) => r.message === 'SSO Authentication required');
  assert.equal(required.status, 'warn');
  assert.equal(required.hint, undefined);
});

test('sso-expired: the migration preamble a first run prints produces no records', () => {
  const records = parseDoctorOutput(fixture('sso-expired'));
  assert.equal(records.length, 23);
  assert.equal(records[0].name, 'Node.js');
  assert.ok(!records.some((r) => /migration|Skipped|Applied/.test(`${r.name} ${r.message}`)));
});
