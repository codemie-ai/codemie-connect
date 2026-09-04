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

// Fixture captures a screen where the provider prompt is answered (✔ prefix) and the
// next prompt (codemieUrl or credential) is already open below it.
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
