// Settings → CodeMie foundation: a typed CodeMie address, the CLI command vocabulary with its
// shell-safety check, the "What CodeMie ran" log and the static catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodemieUrl, DEFAULT_CODEMIE_URL, isEpamUrl } from '../workspace/codemie/url.js';
import { assertSafe, cliCommands, SAFE } from '../workspace/codemie/cli.js';
import { createRunLog, redact } from '../workspace/codemie/run-log.js';
import { AGENT_INFO, APPS, PROVIDERS, BUILTIN_AGENT, SUBSCRIPTION_MODELS } from '../workspace/codemie/catalog.js';

test('normalize_accepts_pasted_forms', () => {
  for (const s of ['codemie.acme.com', ' https://CodeMie.Acme.com/ ', 'https://codemie.acme.com/#/assistants'])
    assert.deepEqual(normalizeCodemieUrl(s), { ok: true, url: 'https://codemie.acme.com' });
  assert.deepEqual(normalizeCodemieUrl('http://localhost:8080'), { ok: true, url: 'http://localhost:8080' });
  assert.equal(normalizeCodemieUrl('http://codemie.acme.com').reason, 'insecure');
  assert.equal(normalizeCodemieUrl('').reason, 'empty');
  assert.equal(normalizeCodemieUrl('not a url').reason, 'invalid');
});

test('epam_default_is_recognised', () => {
  assert.equal(DEFAULT_CODEMIE_URL, 'https://codemie.lab.epam.com');
  assert.equal(isEpamUrl(DEFAULT_CODEMIE_URL), true);
  assert.equal(isEpamUrl('https://codemie.acme-bank.com'), false);
  assert.equal(isEpamUrl('https://epam.com.evil.io'), false);
});

test('assert_safe_refuses_shell_text', () => {
  assert.throws(() => assertSafe('name', 'prod;rm -rf ~'));
  assert.throws(() => assertSafe('name', "a'b"));
  assert.throws(() => assertSafe('url', 'https://x.com/$(id)'));
  assert.equal(assertSafe('agent', 'claude-acp'), 'claude-acp');
  assert.equal(assertSafe('url', 'https://codemie.acme.com'), 'https://codemie.acme.com');
  assert.ok(SAFE.flag.test('--codex-desktop'));
});

test('commands_close_stdin_per_platform', () => {
  assert.equal(cliCommands('macos').switchProfile('prod'), 'codemie profile switch prod < /dev/null');
  assert.equal(cliCommands('windows').proxyStatus, 'codemie proxy status --json < NUL');
  assert.equal(cliCommands('macos').proxyConnect(['--claude-desktop', '--vscode'], 'prod'), 'codemie proxy connect --claude-desktop --vscode --profile prod --silent < /dev/null');
  assert.equal(cliCommands('macos').install('claude'), 'codemie install claude');
  assert.equal(cliCommands('macos').login('https://codemie.acme.com'), 'codemie profile login --url https://codemie.acme.com');
  assert.equal(cliCommands('macos').deleteProfile('old'), 'codemie profile delete old -y < /dev/null');
  assert.equal(cliCommands('windows').commandPath('claude'), 'where claude < NUL');
  assert.throws(() => cliCommands('macos').renameProfile('prod', 'a b'));
});

test('run_log_redacts_and_caps', () => {
  const log = createRunLog({ limit: 2 });
  const r = log.start('codemie proxy status --json');
  r.append('{"status":"healthy","apiKey":"gk-123","port":4001}'); r.finish(0);
  assert.doesNotMatch(log.text(), /gk-123/);
  log.start('a').finish(0); log.start('b').finish(1);
  assert.equal(log.list().length, 2);
  assert.match(log.text(), /FAILED {2}\$ b/);
});

test('redact_masks_tokens_in_every_form', () => {
  const out = redact('Authorization: Bearer abc.def\nTOKEN=xyz\n"gatewayKey": "k1"\npassword: hunter2');
  for (const secret of ['abc.def', 'xyz', 'k1', 'hunter2']) assert.doesNotMatch(out, new RegExp(secret));
  assert.match(out, /Bearer \*\*\*/);
});

test('run_log_notifies_subscribers', () => {
  const log = createRunLog();
  let calls = 0;
  const off = log.subscribe(() => { calls++; });
  const r = log.start('codemie list');
  r.append('x');
  r.finish(0);
  off();
  log.start('codemie doctor');
  assert.equal(calls, 3);
});

test('catalog_matches_cli_vocabulary', () => {
  assert.equal(BUILTIN_AGENT, 'codemie-code');
  assert.deepEqual(APPS.filter(a => a.disconnectFlag).map(a => a.id), ['codex-desktop']);
  assert.deepEqual(PROVIDERS.map(p => p[0]), ['ai-run-sso', 'litellm', 'bedrock', 'ollama', 'anthropic-subscription', 'moonshot-subscription']);
  assert.ok(AGENT_INFO.claude.recommended && AGENT_INFO.claude.featured);
  assert.ok(AGENT_INFO['kimi-acp'].editor);
  assert.ok(!AGENT_INFO.gemini.providers.includes('bedrock'));
  assert.deepEqual(SUBSCRIPTION_MODELS['moonshot-subscription'], ['kimi-k2']);
});
