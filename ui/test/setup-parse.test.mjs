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
  assert.deepEqual(r.options, [
    'CodeMie SSO - Enterprise SSO Authentication with centralized model management',
    'LiteLLM - Universal gateway to 100+ LLM providers',
    'AWS Bedrock - Amazon Bedrock - Access Claude, Llama, Mistral & more via AWS',
    'Anthropic Subscription - Native Claude Code authentication using your Claude subscription',
    'Moonshot Subscription - Native Kimi Code CLI authentication using your Moonshot subscription',
    'Ollama - Popular open-source local LLM runner - optimized for coding with 16GB RAM',
  ]);
  assert.equal(r.selectedIndex, 0);
});

test('codemieProject options and selectedIndex', () => {
  const r = detectPrompt(fixture('codemieProject'));
  assert.deepEqual(r.options, ['epm-sdai', 'mert_efe@epam.com']);
  assert.equal(r.selectedIndex, 0);
});

// model.json is a real capture of a windowed list: the CLI sets pageSize 15
// (dist/cli/commands/setup.js), so the screen carries exactly 15 rows out of a longer
// list. Asserting all fifteen is what makes the windowing requirement testable.
test('model options and selectedIndex — windowed at 15, Custom row excluded', () => {
  const r = detectPrompt(fixture('model'));
  assert.deepEqual(r.options, [
    '⭐ claude-sonnet-5',
    'claude-4-5-sonnet',
    'claude-4-5-sonnet-vertex',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-5-20251101',
    'claude-opus-4-6-20260205',
    'claude-opus-4-6-vertex',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-6',
    'claude-sonnet-4-6-vertex',
    'deepseek-v4-pro',
    'gemini-3-flash',
  ]);
  assert.equal(r.options.length, 15, 'inquirer pageSize is 15');
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

// This fixture captures a partial-render transition state: the provider question has been answered
// and the next codemieUrl prompt has started rendering — but only "? CodeMie organization" has
// appeared (the line is cut off before "URL:", a transient state at 256-byte chunk boundaries).
//
// Two properties must hold simultaneously:
//   (a) answered-prompt-not-redetected: the parser must not re-identify 'provider'
//   (b) partial-render-not-misclassified: the incomplete line must NOT fall through to 'credential'
//       (which would cause a future driver to type an API key into an unfinished URL prompt)
//
// The correct outcome is null: the visible prompt is genuinely incomplete and cannot be safely identified.
test('partial-render incomplete prompt line returns null, not credential', () => {
  // A prompt line torn mid-word by a partial render carries no ':' and matches no anchor.
  // Claiming it as a credential input would make a driver type an API key into it.
  const screen = Array(30).fill('');
  screen[0] = '? Choose your LLM provider: AI/Run CodeMie SSO';
  screen[1] = '? CodeMie organization';
  assert.equal(detectPrompt(screen), null);
});

test('answered provider above an open prompt resolves to the open one', () => {
  const r = detectPrompt(fixture('provider-answered-then-next-open'));
  assert.equal(r.id, 'codemieUrl', 'the open prompt wins, not the answered provider above it');
  assert.notEqual(r.id, 'provider');
});

test('windowed model list excludes trailing Custom row from options', () => {
  const r = detectPrompt(fixture('model'));
  assert.ok(r !== null && r.kind === 'list');
  assert.ok(
    !r.options?.some(o => /custom/i.test(o) && /manual/i.test(o)),
    'Custom row must be excluded from options'
  );
});

// CR-003: confirm-kind messages must have yes/no hint text stripped, but input-kind messages
// must preserve parenthesized DEFAULT VALUES (e.g. "(sonnet)", "(anthropic-subscription)").
test('confirm message strips trailing (Y/n) hint — activate', () => {
  const r = detectPrompt(fixture('activate'));
  assert.equal(r.kind, 'confirm');
  assert.ok(!r.message.includes('(Y/n)'), `message must not contain (Y/n), got: "${r.message}"`);
  assert.ok(!r.message.includes('(y/N)'), `message must not contain (y/N), got: "${r.message}"`);
  assert.ok(r.message.includes('Switch to profile'), `message must retain prompt text, got: "${r.message}"`);
});

test('confirm message strips trailing (Y/n) hint — installClaude', () => {
  const r = detectPrompt(fixture('installClaude'));
  assert.equal(r.kind, 'confirm');
  assert.ok(!r.message.includes('(Y/n)') && !r.message.includes('(y/N)'), `message must not contain yes/no hint, got: "${r.message}"`);
  assert.ok(r.message.includes('Would you like to install Claude Code now?'), `message must retain prompt text, got: "${r.message}"`);
});

test('input message preserves parenthesized default value — modelManual (sonnet)', () => {
  const r = detectPrompt(fixture('modelManual'));
  assert.equal(r.kind, 'input');
  assert.ok(r.message.includes('(sonnet)'), `default "(sonnet)" must be preserved, got: "${r.message}"`);
});

test('input message preserves parenthesized default value — profileName (anthropic-subscription)', () => {
  const r = detectPrompt(fixture('profileName'));
  assert.equal(r.kind, 'input');
  assert.ok(r.message.includes('(anthropic-subscription)'), `default "(anthropic-subscription)" must be preserved, got: "${r.message}"`);
});

test('input message preserves parenthesized default value — codemieUrl (https://...)', () => {
  const r = detectPrompt(fixture('codemieUrl'));
  assert.equal(r.kind, 'input');
  assert.ok(r.message.includes('(https://codemie.lab.epam.com)'), `default URL must be preserved, got: "${r.message}"`);
});

// Regression test for credential catch-all bug: an unrecognized consent/confirm prompt
// (analytics sync, not in PROMPTS) must return null, not be misclassified as 'credential'.
test('detectPrompt returns null for unrecognized prompt (analyticsSync)', () => {
  const r = detectPrompt(fixture('analyticsSync'));
  assert.equal(r, null, 'unrecognized prompt must return null, not credential');
});

// The three guards below had no coverage: deleting any of them left the suite green.
// Each is load-bearing, so each gets a test that fails when it is removed.

test('an unrecognized yes/no prompt returns null, never credential', () => {
  // Without this guard a driver would type an API key into a consent question.
  const screen = Array(30).fill('');
  screen[0] = '? Overwrite the existing configuration: are you sure? (y/N)';
  assert.equal(detectPrompt(screen), null);
});

test('the first selection marker wins when a partial render leaves two', () => {
  const screen = Array(30).fill('');
  screen[0] = '? Choose your LLM provider:';
  screen[1] = '❯ CodeMie SSO';
  screen[2] = '  LiteLLM';
  screen[3] = '❯ AWS Bedrock';
  const r = detectPrompt(screen);
  assert.equal(r.selectedIndex, 0, 'a stale marker lower down must not win');
});

// A list question sitting on the last visible row has no room for its options. The parser
// reports no prompt rather than a list with an empty choice set. Documented here as the
// contract: EPMCDME-14668 must not treat this as "nothing is waiting for input".
test('a list question with no visible options returns null', () => {
  const screen = Array(30).fill('');
  screen[29] = '? Choose your LLM provider: (Use arrow keys)';
  assert.equal(detectPrompt(screen), null);
});
