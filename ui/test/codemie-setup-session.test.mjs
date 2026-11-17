// The guided-setup session: answers `codemie setup` prompts from a plan, hands project/model
// choices to the UI, and accepts a run only when the profile was really saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSetupSession } from '../workspace/codemie/setup-session.js';
import { stripHint, providerIndex, credentialAnswer, recommendedIndex } from '../workspace/codemie/setup-prompts.js';

const PROVIDERS = ['CodeMie SSO - Enterprise SSO', 'LiteLLM - Universal gateway', 'AWS Bedrock - Amazon Bedrock - Access Claude', 'Anthropic Subscription - Native Claude Code', 'Moonshot Subscription - Native Kimi', 'Ollama - Popular open-source'];

/** A fake driver that asks `prompts` in order and records every answer. */
function fakeDriver(prompts, { result = { profileName: 'default', updated: false }, logs = [], screens = [] } = {}) {
  const answers = [];
  let options;
  const startSetup = async (opts) => {
    options = opts;
    for (const text of logs) opts.onLog?.(text);
    for (const lines of screens) opts.onScreen?.(lines);
    for (const p of prompts) answers.push(await opts.onPrompt(p));
    return result;
  };
  return { startSetup, answers, options: () => options };
}

const profilesWith = (...names) => async () => ({ state: 'valid', profiles: names.map((name) => ({ name })) });

test('prompt_helpers', () => {
  assert.deepEqual(stripHint('Enter a name for this profile: (anthropic-subscription)'), { text: 'Enter a name for this profile:', defaultValue: 'anthropic-subscription' });
  assert.deepEqual(stripHint('API Key:'), { text: 'API Key:', defaultValue: null });
  assert.equal(providerIndex(PROVIDERS, 'ai-run-sso'), 0);
  assert.equal(providerIndex(PROVIDERS, 'anthropic-subscription'), 3);
  assert.equal(providerIndex(PROVIDERS, 'bearer-auth'), -1);
  assert.equal(credentialAnswer('LiteLLM Proxy URL:', { endpoint: 'http://x:4000' }), 'http://x:4000');
  assert.equal(credentialAnswer('Ollama base URL: (http://localhost:11434)', {}), 'http://localhost:11434');
  assert.equal(credentialAnswer('API Key (optional):', {}), '');
  assert.equal(credentialAnswer('AWS Secret Access Key:', { awsSecret: 's3' }), 's3');
  assert.equal(credentialAnswer('AWS Access Key ID:', { awsAccessKey: 'AK' }), 'AK');
  assert.equal(credentialAnswer('Bedrock role ARN:', {}), null);
  assert.equal(recommendedIndex(['gpt-5', 'claude-sonnet-4-5 ⭐', 'x']), 1);
  assert.equal(recommendedIndex(['a', 'b']), null);
});

test('answers_sso_add_flow', async () => {
  const d = fakeDriver([
    { kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: PROVIDERS },
    { kind: 'input', id: 'codemieUrl', message: 'CodeMie organization URL: (https://codemie.lab.epam.com)' },
    { kind: 'list', id: 'codemieProject', message: 'Select your project:', options: ['DIGITAL-BANKING', 'taylor.morgan'] },
    { kind: 'list', id: 'integration', message: 'Select LiteLLM integration:', options: ['litellm-default (DIGITAL-BANKING)', 'litellm-eu (DIGITAL-BANKING)'] },
    { kind: 'list', id: 'model', message: 'Choose a model', options: ['gpt-5', 'claude-sonnet-4-5 ⭐'] },
    { kind: 'input', id: 'profileName', message: 'Enter a name for this profile: (default)' },
    { kind: 'confirm', id: 'installClaude', message: 'Would you like to install Claude Code now?' },
  ]);
  const asked = [];
  const ui = { choose: async (q) => { asked.push(q); return q.id === 'model' ? 1 : 0; } };
  const session = createSetupSession({ startSetup: d.startSetup, cancelSetup: async () => true, readProfiles: profilesWith('default') });
  const result = await session.run({ mode: 'add', provider: 'ai-run-sso', url: 'https://codemie.acme-bank.com' }, ui);
  assert.deepEqual(d.answers, [0, 'https://codemie.acme-bank.com', 0, 0, 1, 'default', false]);
  assert.deepEqual(asked.map((q) => q.id), ['codemieProject', 'integration', 'model']);
  assert.equal(asked[2].recommended, 1);
  assert.deepEqual(result, { profileName: 'default', updated: false });
  assert.equal(d.options().answerManualModel, true);
  assert.equal(session.running(), false);
});

test('update_mode_picks_profile', async () => {
  const d = fakeDriver([
    { kind: 'list', id: 'gate', message: 'What would you like to do?', options: ['Add a new profile', 'Update an existing profile'] },
    { kind: 'list', id: 'updateProfile', message: 'Select profile to update:', options: ['prod', 'staging'] },
  ], { result: { profileName: 'staging', updated: true } });
  const session = createSetupSession({ startSetup: d.startSetup, cancelSetup: async () => true, readProfiles: profilesWith('prod', 'staging') });
  await session.run({ mode: 'update', profile: 'staging', provider: 'ai-run-sso' }, { choose: async () => 0 });
  assert.deepEqual(d.answers, [1, 1]);
});

test('unknown_credential_rejects', async () => {
  const d = fakeDriver([{ kind: 'input', id: 'credential', message: 'Bedrock role ARN:' }]);
  const session = createSetupSession({ startSetup: d.startSetup, cancelSetup: async () => true, readProfiles: profilesWith('default') });
  await assert.rejects(() => session.run({ mode: 'add', provider: 'bedrock' }, { choose: async () => 0 }), (err) => {
    assert.equal(err.message, 'CodeMie asked something Connect does not know: Bedrock role ARN:');
    assert.equal(err.step, 'credential');
    return true;
  });
  assert.equal(session.running(), false);
});

test('missing_provider_rejects', async () => {
  const d = fakeDriver([{ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: PROVIDERS.slice(0, 2) }]);
  const session = createSetupSession({ startSetup: d.startSetup, cancelSetup: async () => true, readProfiles: profilesWith('default') });
  await assert.rejects(() => session.run({ mode: 'add', provider: 'ollama' }, { choose: async () => 0 }), /does not offer ollama/);
});

test('subscription_model_is_chosen_from_the_list', async () => {
  const d = fakeDriver([
    { kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: PROVIDERS },
    { kind: 'input', id: 'modelManual', message: 'No models found. Enter model name manually: (sonnet)' },
    { kind: 'input', id: 'profileName', message: 'Enter a name for this profile: (anthropic-subscription)' },
  ], { result: { profileName: 'anthropic-subscription', updated: false } });
  const asked = [];
  const session = createSetupSession({ startSetup: d.startSetup, cancelSetup: async () => true, readProfiles: profilesWith('anthropic-subscription') });
  await session.run({ mode: 'add', provider: 'anthropic-subscription' }, { choose: async (q) => { asked.push(q); return 2; } });
  assert.deepEqual(d.answers, [3, 'claude-haiku-4-5', 'anthropic-subscription']);
  assert.equal(asked[0].id, 'model');
});

test('browser_line_fires_once', async () => {
  const d = fakeDriver([], { logs: ['Opening browser for authentication...\r\n', 'still Opening browser for authentication'] });
  let opened = 0;
  const session = createSetupSession({ startSetup: d.startSetup, cancelSetup: async () => true, readProfiles: profilesWith('default') });
  await session.run({ mode: 'add', provider: 'ai-run-sso' }, { choose: async () => 0, onBrowser: () => { opened++; } });
  assert.equal(opened, 1);
});

test('unsaved_profile_is_not_a_success', async () => {
  const d = fakeDriver([]);
  const session = createSetupSession({ startSetup: d.startSetup, cancelSetup: async () => true, readProfiles: profilesWith('other') });
  await assert.rejects(() => session.run({ mode: 'add', provider: 'ai-run-sso' }, { choose: async () => 0 }), /Setup finished, but the profile was not saved\./);
});

test('cancel_ends_a_running_session', async () => {
  let release;
  const startSetup = () => new Promise((resolve, reject) => { release = () => reject(Object.assign(new Error('cancelled'), { cancelled: true })); });
  let cancelled = 0;
  const session = createSetupSession({ startSetup, cancelSetup: async () => { cancelled++; release(); return true; }, readProfiles: profilesWith() });
  const run = session.run({ mode: 'add', provider: 'ai-run-sso' }, { choose: async () => 0 }).catch((e) => e);
  assert.equal(session.running(), true);
  assert.equal(await session.cancel(), true);
  assert.equal((await run).cancelled, true);
  assert.equal(cancelled, 1);
  assert.equal(await session.cancel(), false);
});
