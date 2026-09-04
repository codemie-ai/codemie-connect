import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectPrompt } from '../setup-parse.js';

function fixture(id) {
  const p = fileURLToPath(new URL(`fixtures/setup/${id}.json`, import.meta.url));
  return JSON.parse(readFileSync(p, 'utf8'));
}

const CASES = [
  ['gate',          'list',    'What would you like to do?'],
  ['storage',       'list',    'Where would you like to store this configuration?'],
  ['provider',      'list',    'Choose your LLM provider:'],
  ['codemieUrl',    'input',   'CodeMie organization URL:'],
  ['codemieProject','list',    'Select your project:'],
  ['credential',    'input',   null],          // message is provider-specific
  ['model',         'list',    'Choose a model'],
  ['customModel',   'input',   'Enter model name:'],
  ['modelManual',   'input',   'No models found. Enter model name manually:'],
  ['profileName',   'input',   'Enter a name for this profile:'],
  ['activate',      'confirm', 'Switch to profile'],
  ['installClaude', 'confirm', 'Would you like to install Claude Code now?'],
];

for (const [id, kind, msgSnippet] of CASES) {
  test(`detectPrompt identifies "${id}"`, () => {
    const r = detectPrompt(fixture(id));
    assert.ok(r !== null, 'expected non-null');
    assert.equal(r.id, id);
    assert.equal(r.kind, kind);
    if (msgSnippet) assert.ok(r.message.includes(msgSnippet), `message="${r.message}"`);
  });
}

// Exact options and selectedIndex for list-kind prompts (real recordings: gate, storage, provider,
// codemieProject; format-accurate constructed: model).
test('gate options and selectedIndex', () => {
  const r = detectPrompt(fixture('gate'));
  assert.deepEqual(r.options, ['Add a new profile', 'Update an existing profile', 'Cancel']);
  assert.equal(r.selectedIndex, 0);
});

test('storage options and selectedIndex', () => {
  const r = detectPrompt(fixture('storage'));
  assert.deepEqual(r.options, [
    'Global (~/.codemie/) - Available across all repositories',
    'Local (.codemie/) - Only for this repository',
  ]);
  assert.equal(r.selectedIndex, 0);
});

test('provider options and selectedIndex', () => {
  const r = detectPrompt(fixture('provider'));
  // provider.json is a real recording; the 30-row viewport shows the first 3 options.
  // The trailing options are scrolled off (100-col terminal, fixture rows 0-29).
  assert.deepEqual(r.options, [
    'CodeMie SSO - Enterprise SSO Authentication with centralized model management',
    'LiteLLM - Universal gateway to 100+ LLM providers',
    'AWS Bedrock - Amazon Bedrock - Access Claude,',
  ]);
  assert.equal(r.selectedIndex, 0);
});

test('codemieProject options and selectedIndex', () => {
  const r = detectPrompt(fixture('codemieProject'));
  assert.deepEqual(r.options, ['epm-sdai']);
  assert.equal(r.selectedIndex, 0);
});

test('model options and selectedIndex — Custom row excluded', () => {
  const r = detectPrompt(fixture('model'));
  assert.deepEqual(r.options, ['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
  assert.equal(r.selectedIndex, 0);
});

// Real-recording discriminator test: provider.json is a real terminal capture where the answered
// storage prompt (with '?' prefix — NOT '✔') sits above the open provider prompt.
// The parser must find the LAST '?' line (provider) and not the first (answered storage).
test('real recording — answered storage (? prefix) above open provider is resolved correctly', () => {
  const r = detectPrompt(fixture('provider'));
  assert.equal(r.id, 'provider', 'answered storage ? line must not shadow open provider');
  assert.equal(r.kind, 'list');
  assert.ok(r.options.length > 0, 'provider must have visible options');
});

// Fixture captures a screen where the provider prompt is answered (? prefix — real recording format)
// and the next prompt (codemieUrl or credential) is already open below it.
// The parser must return the NEXT prompt's id — never 'provider' again.
test('answered provider prompt is not re-detected when next prompt is open', () => {
  const r = detectPrompt(fixture('provider-answered-then-next-open'));
  assert.ok(r !== null, 'expected non-null — next open prompt should be detected');
  assert.notEqual(r.id, 'provider', 'answered provider must not be re-detected');
  assert.ok(
    r.id === 'codemieUrl' || r.id === 'credential',
    `expected codemieUrl or credential, got: ${r.id}`
  );
});

test('windowed model list excludes trailing Custom row from options', () => {
  const r = detectPrompt(fixture('model'));
  assert.ok(r !== null && r.kind === 'list');
  assert.ok(
    !r.options?.some(o => /custom/i.test(o) && /manual/i.test(o)),
    'Custom row must be excluded from options'
  );
});

// Regression test for credential catch-all bug: an unrecognized consent/confirm prompt
// (analytics sync, not in PROMPTS) must return null, not be misclassified as 'credential'.
test('detectPrompt returns null for unrecognized prompt (analyticsSync)', () => {
  const r = detectPrompt(fixture('analyticsSync'));
  assert.equal(r, null, 'unrecognized prompt must return null, not credential');
});
