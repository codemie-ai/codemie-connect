// fixtures/agents/list.txt is real `codemie list` stdout from CLI 0.15.2 read
// through a pipe (no escape codes): the agents block, the frameworks block and
// the trailing Next Steps block, as the app's run_capture sees it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAgentList } from '../agents-parse.js';

const fixture = readFileSync(fileURLToPath(new URL('fixtures/agents/list.txt', import.meta.url)), 'utf8');

test('every agent in the first block is a record, and nothing from the other two blocks', () => {
  const agents = parseAgentList(fixture);
  assert.equal(agents.length, 11);
  assert.deepEqual(
    agents.map((a) => a.command),
    ['codemie-code', 'claude', 'claude-acp', 'gemini', 'opencode', 'codex', 'pi', 'kimi', 'kimi-acp', 'openwiki', 'copilot'],
  );
  assert.ok(!agents.some((a) => /CodeGraph|SpecKit|BMAD/.test(a.name)));
  assert.ok(!agents.some((a) => /Next Steps|Docs:/.test(`${a.name} ${a.description}`)));
});

test('an installed agent carries its version; one that is not has none', () => {
  const agents = parseAgentList(fixture);
  const claude = agents.find((a) => a.command === 'claude');
  assert.deepEqual(claude, {
    name: 'Claude Code',
    command: 'claude',
    installed: true,
    version: '2.1.269',
    description: 'Claude Code - official Anthropic CLI tool',
  });
  const gemini = agents.find((a) => a.command === 'gemini');
  assert.equal(gemini.name, 'Gemini CLI');
  assert.equal(gemini.installed, false);
  assert.equal(gemini.version, null);
  assert.equal(gemini.description, 'Google Gemini CLI - AI coding assistant');
});

test('"not installed" is matched on the words, not on a leading glyph', () => {
  const agents = parseAgentList(fixture);
  assert.deepEqual(
    agents.filter((a) => a.installed).map((a) => a.command),
    ['codemie-code', 'claude', 'opencode'],
  );
});

test('the count is whatever the CLI prints', () => {
  const two = `📦 Available Agents:\n\n  One (1.0)\n    Command: one\n    Status: ✓ installed\n    One - first\n\n  Two\n    Command: two\n    Status: not installed\n    Two - second\n\n🛠️  Available Frameworks:\n\n  Fw\n    Command: fw\n    Status: not installed\n    A framework\n    Docs: https://example.test\n`;
  assert.equal(parseAgentList(two).length, 2);
  assert.deepEqual(parseAgentList(''), []);
  assert.deepEqual(parseAgentList('nothing like the list'), []);
});
