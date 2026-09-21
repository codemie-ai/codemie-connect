import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDoctorOutput } from '../doctor-parse.js';
import { groupDoctorResults } from '../doctor-groups.js';

// Real CLI 0.15.2 output; see doctor-parse.test.mjs for how it was captured.
function grouped(id) {
  const raw = readFileSync(fileURLToPath(new URL(`fixtures/doctor/${id}.txt`, import.meta.url)), 'utf8');
  return groupDoctorResults(parseDoctorOutput(raw));
}
const ok = (name, message = 'Version 1.0.0') => ({ name, status: 'ok', message });

test('signed-in: the real output groups into account, tools and CodeMie itself', () => {
  const { rows, summary } = grouped('signed-in');
  assert.deepEqual(
    rows.map((r) => `${r.group} | ${r.status} | ${r.label}`),
    [
      'codemie | pass | Everything CodeMie needs to run is included',
      'tools | pass | AWS CLI',
      'account | pass | Your profile is set up',
      'account | pass | CodeMie can reach the model service',
      'tools | warn | CodeMie Code 0.0.47',
      'tools | pass | Claude Code 2.1.269',
      'tools | warn | OpenCode CLI 1.18.31',
      'tools | pass | Frameworks',
    ],
  );
  assert.deepEqual(summary, { passing: 6, total: 8 });
});

test('signed-in: the four bundled-runtime checks collapse into one row that names their versions', () => {
  const { rows } = grouped('signed-in');
  const runtime = rows.filter((r) => r.group === 'codemie');
  assert.equal(runtime.length, 1);
  assert.equal(runtime[0].detail, 'Node.js v22.23.2 · npm 11.5.1 · Python 3.9.6 · uv 0.12.0');
  assert.ok(!rows.some((r) => ['Node.js', 'npm', 'Python', 'uv'].includes(r.label)));
});

test('signed-in: a passing row says what the CLI found, in a line of detail', () => {
  const { rows } = grouped('signed-in');
  const detail = (label) => rows.find((r) => r.label === label).detail;
  assert.equal(detail('Your profile is set up'), 'demo7 · claude-sonnet-5');
  assert.equal(detail('CodeMie can reach the model service'), 'Session expires in 24 hour(s)');
  assert.equal(detail('AWS CLI'), 'aws-cli/2.36.46');
  assert.equal(detail('Frameworks'), 'CodeGraph 1.5.0');
});

test('signed-in: each installed agent is its own row, and one the CLI has advice on links to Agents', () => {
  const { rows } = grouped('signed-in');
  const openCode = rows.find((r) => r.label === 'OpenCode CLI 1.18.31');
  assert.equal(openCode.detail, 'CodeMie recommends vlatest');
  assert.equal(openCode.remedyText, 'Open the Agents screen to update or reinstall it.');
  assert.deepEqual(openCode.action, { kind: 'navigate', view: 'agents', label: 'Go to Agents' });
  const claude = rows.find((r) => r.label === 'Claude Code 2.1.269');
  assert.equal(claude.action, undefined);
  assert.equal(claude.remedyText, undefined);
});

test('signed-in: a section the CLI only reports on is not a check that passed', () => {
  const labels = grouped('signed-in').rows.map((r) => r.label);
  assert.ok(!labels.some((l) => /JWT|Repository/.test(l)));
});

test('sso-expired: the row is named after the error and offers to sign in again', () => {
  const { rows, summary } = grouped('sso-expired');
  const row = rows.find((r) => r.group === 'account' && r.status === 'fail');
  assert.equal(row.label, 'SSO credentials not found');
  assert.equal(row.detail, undefined);
  assert.equal(row.remedyText, 'Sign in again to restore your CodeMie session.');
  assert.equal(row.remedyDetail, 'Run: codemie profile login');
  assert.deepEqual(row.action, { kind: 'signin', label: 'Sign in again' });
  assert.deepEqual(summary, { passing: 5, total: 8 });
});

test('a problem whose hint is not about signing in keeps the CLI hint and offers a recheck', () => {
  const { rows } = groupDoctorResults([
    { name: 'Active Profile', status: 'warn', message: 'No active profile', hint: 'Run: codemie setup' },
  ]);
  assert.equal(rows[0].group, 'account');
  assert.equal(rows[0].label, 'No active profile');
  assert.equal(rows[0].remedyText, 'Run: codemie setup');
  assert.deepEqual(rows[0].action, { kind: 'recheck', label: 'Check again' });
});

// The shape sso.health.js reports when the service cannot be reached: the
// main message first, then the raw network error as the second item's hint.
test('an unreachable provider says what to do in our words and keeps the CLI error underneath', () => {
  const { rows } = groupDoctorResults([
    { name: 'CodeMie SSO Provider', status: 'error', message: 'Cannot connect to provider' },
    { name: 'CodeMie SSO Provider', status: 'error', message: 'Provider unreachable', hint: 'fetch failed' },
  ]);
  assert.equal(rows[0].group, 'account');
  assert.equal(rows[0].label, 'Cannot connect to provider');
  assert.equal(rows[0].remedyText, 'This is usually the network or the VPN. Check your connection, then check again.');
  assert.equal(rows[0].remedyDetail, 'fetch failed');
  assert.deepEqual(rows[0].action, { kind: 'recheck', label: 'Check again' });
});

test('a session about to expire also offers to sign in again', () => {
  const { rows } = groupDoctorResults([
    {
      name: 'CodeMie SSO Provider',
      status: 'warn',
      message: 'Session expires in 0 hour(s)',
      hint: 'Consider refreshing session: codemie profile login',
    },
  ]);
  assert.equal(rows[0].status, 'warn');
  assert.deepEqual(rows[0].action, { kind: 'signin', label: 'Sign in again' });
});

// AgentsCheck.js prints this single info line when nothing is installed.
test('the CLI note for no installed agents is not a passing agent row', () => {
  const { rows, summary } = groupDoctorResults([
    { name: 'Installed Agents', status: 'info', message: 'No agents installed (CodeMie Code is built-in)' },
  ]);
  assert.deepEqual(rows, []);
  assert.deepEqual(summary, { passing: 0, total: 0 });
});

test('a problem with no hint gets no remedy and no action', () => {
  const { rows } = groupDoctorResults([{ name: 'AWS CLI', status: 'error', message: 'Not found' }]);
  assert.equal(rows[0].status, 'fail');
  assert.equal(rows[0].remedyText, undefined);
  assert.equal(rows[0].action, undefined);
});

test('two distinct hints in one section are both shown', () => {
  const { rows } = groupDoctorResults([
    { name: 'Frameworks', status: 'error', message: 'SpecKit is broken', hint: 'Reinstall SpecKit' },
    { name: 'Frameworks', status: 'warn', message: 'BMAD is outdated', hint: 'Update BMAD' },
  ]);
  assert.equal(rows[0].label, 'SpecKit is broken');
  assert.equal(rows[0].remedyText, 'Reinstall SpecKit\nUpdate BMAD');
});

test('a failing runtime check names itself on the collapsed row and keeps its remedy', () => {
  const { rows } = groupDoctorResults([
    { name: 'Node.js', status: 'error', message: 'Not found', hint: 'Reinstall CodeMie' },
    ok('npm'),
    ok('Python'),
    ok('uv'),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'fail');
  assert.equal(rows[0].label, 'Node.js: Not found');
  assert.equal(rows[0].remedyText, 'Reinstall CodeMie');
  assert.deepEqual(rows[0].action, { kind: 'recheck', label: 'Check again' });
});

test('a provider check that threw is an account problem in the CLI wording', () => {
  const { rows } = groupDoctorResults([
    { name: 'Provider Check Error', status: 'error', message: 'Check failed: Provider check timed out after 15s' },
  ]);
  assert.equal(rows[0].group, 'account');
  assert.equal(rows[0].label, 'Check failed: Provider check timed out after 15s');
});

test('a section this screen has never heard of still renders, under CodeMie itself', () => {
  const { rows } = groupDoctorResults([{ name: 'Disk Space', status: 'ok', message: '120 GB free' }]);
  assert.equal(rows[0].group, 'codemie');
  assert.equal(rows[0].label, 'Disk Space');
  assert.equal(rows[0].status, 'pass');
});

test('the summary counts the rows that ran, with no total written down anywhere', () => {
  assert.deepEqual(groupDoctorResults([ok('Node.js'), ok('AWS CLI')]).summary, { passing: 2, total: 2 });
  assert.deepEqual(groupDoctorResults([ok('Node.js')]).summary, { passing: 1, total: 1 });
});
