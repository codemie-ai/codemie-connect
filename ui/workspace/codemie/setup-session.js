// Guided setup: runs `codemie setup` through ui/setup-driver.js and answers it from a plan the
// setup sheet built (provider, address, fields, profile name). What only the person can pick —
// project, LiteLLM integration, model, AWS sign-in — goes to `ui.choose` as the CLI lists it.
// A run counts only when the profile it names is in the config file afterwards.
import { detectFailure } from '../../setup-parse.js';
import { SUBSCRIPTION_MODELS } from './catalog.js';
import { stripHint, providerIndex, credentialAnswer, recommendedIndex } from './setup-prompts.js';

const CHOICES = new Set(['codemieProject', 'integration', 'model', 'bedrockAuth', 'awsProfile']);
const BROWSER = /Opening browser for authentication/;

const fail = (step, message) => Object.assign(new Error(message), { step });

export function createSetupSession({ startSetup, cancelSetup, readProfiles }) {
  let active = false;

  async function answer(prompt, plan, ui) {
    const { id, options = [], message } = prompt;
    if (id === 'gate') {
      const i = options.findIndex((o) => (plan.mode === 'update' ? /Update an existing profile/i : /Add a new profile/i).test(o));
      if (i === -1) throw fail('gate', 'This CodeMie version asks something Connect does not expect.');
      return i;
    }
    if (id === 'updateProfile') {
      const i = options.indexOf(plan.profile);
      if (i === -1) throw fail('updateProfile', `CodeMie has no profile called “${plan.profile}”.`);
      return i;
    }
    if (id === 'provider') {
      const i = providerIndex(options, plan.provider);
      if (i === -1) throw fail('provider', `This CodeMie version does not offer ${plan.provider}.`);
      return i;
    }
    if (id === 'codemieUrl') return plan.url ?? stripHint(message).defaultValue ?? '';
    if (id === 'credential') {
      const value = credentialAnswer(message, plan.fields);
      if (value === null) throw fail('credential', `CodeMie asked something Connect does not know: ${message}`);
      return value;
    }
    if (CHOICES.has(id)) return ui.choose({ id, message, options, recommended: recommendedIndex(options) });
    if (id === 'modelManual' || id === 'customModel') {
      const models = SUBSCRIPTION_MODELS[plan.provider] ?? [];
      if (!models.length) throw fail('model', 'CodeMie found no models for this provider.');
      const i = await ui.choose({ id: 'model', message, options: models, recommended: 0 });
      return models[i] ?? models[0];
    }
    if (id === 'profileName') return plan.name ?? stripHint(message).defaultValue ?? 'default';
    if (id === 'installClaude') return false;
    throw fail(id, `CodeMie asked something Connect does not know: ${message}`);
  }

  async function run(plan, ui) {
    if (active) throw fail(null, 'Setup is already running.');
    active = true;
    let browserShown = false;
    const failuresShown = new Set();
    try {
      const result = await startSetup({
        answerManualModel: true,
        onPrompt: (prompt) => answer(prompt, plan, ui),
        onLog: (text) => {
          if (!browserShown && BROWSER.test(String(text))) {
            browserShown = true;
            ui.onBrowser?.();
          }
        },
        onScreen: (lines) => {
          const found = detectFailure(lines);
          if (found && !failuresShown.has(found.id)) {
            failuresShown.add(found.id);
            ui.onFailure?.(found);
          }
        },
      });
      const profileName = result?.profileName || plan.name || plan.profile;
      const saved = await readProfiles();
      if (!saved?.profiles?.some((p) => p.name === profileName)) throw fail('verify', 'Setup finished, but the profile was not saved.');
      return { profileName, updated: !!result?.updated };
    } catch (err) {
      // The driver rejects with plain objects; callers get an Error with the same fields.
      if (err instanceof Error) throw err;
      throw Object.assign(new Error(err?.message || 'Setup stopped.'), err);
    } finally {
      active = false;
    }
  }

  return {
    run,
    running: () => active,
    async cancel() {
      if (!active) return false;
      await cancelSetup();
      return true;
    },
  };
}
