// Pure helpers for answering `codemie setup` prompts from the native setup sheet.

// inquirer appends the default as " (value)" to an open input prompt.
const DEFAULT_HINT = /\s*\(([^()]*)\)\s*$/;

/** "Enter a name for this profile: (default)" → { text: 'Enter a name…:', defaultValue: 'default' }. */
export function stripHint(message) {
  const raw = String(message ?? '');
  const m = raw.match(DEFAULT_HINT);
  return { text: (m ? raw.slice(0, m.index) : raw).trim(), defaultValue: m ? m[1].trim() || null : null };
}

// The CLI wizard's option labels start with the provider's display name.
const PROVIDER_LABEL = {
  'ai-run-sso': /^CodeMie SSO/i,
  litellm: /^LiteLLM/i,
  bedrock: /^AWS Bedrock/i,
  ollama: /^Ollama/i,
  'anthropic-subscription': /^Anthropic/i,
  'moonshot-subscription': /^Moonshot/i,
};

/** Index of `provider` among the CLI's provider options, −1 when this CLI does not offer it. */
export function providerIndex(options, provider) {
  const re = PROVIDER_LABEL[provider];
  return re ? options.findIndex((o) => re.test(String(o).trim())) : -1;
}

/**
 * The answer to a provider's free-text question from the fields the person filled in, or null
 * for a question Connect does not know (the run stops rather than guess). Secret first: "AWS
 * Secret Access Key" also says "Access Key".
 */
export function credentialAnswer(message, fields = {}) {
  const { text, defaultValue } = stripHint(message);
  if (/Ollama cloud API key/i.test(text)) return '';
  if (/Secret Access Key/i.test(text)) return fields.awsSecret ?? null;
  if (/Access Key ID/i.test(text)) return fields.awsAccessKey ?? null;
  if (/AWS Region|Region:/i.test(text)) return fields.awsRegion || defaultValue || null;
  if (/Proxy URL|base URL|Base URL/i.test(text)) return fields.endpoint || defaultValue || null;
  if (/API Key/i.test(text)) return fields.key ?? '';
  return null;
}

/** The option the CLI recommends (marked ⭐), or null. */
export function recommendedIndex(options) {
  const i = options.findIndex((o) => String(o).includes('⭐'));
  return i === -1 ? null : i;
}
