// What Connect knows about the CLI's agents, apps and providers beyond what the CLI prints.
// Keys are CLI install names (`Command:` in `codemie list`); an agent a newer CLI adds and this
// file does not know still appears, with the CLI's own name and description.
// Providers per agent are the plugins' `supportedProviders` (@codemieai/code 0.16); ACP variants
// declare none, so they work with every provider.

const ALL = ['ai-run-sso', 'litellm', 'bedrock', 'ollama', 'anthropic-subscription', 'moonshot-subscription'];

export const BUILTIN_AGENT = 'codemie-code';

export const AGENT_INFO = {
  claude: {
    name: 'Claude Code', maker: 'Anthropic', mono: 'CC', color: '#C15F3C', featured: true, recommended: true,
    short: 'The most popular choice. Works in any project.',
    desc: 'Anthropic’s coding agent. Reads your project, edits files and runs commands — and asks before it changes anything.',
    providers: ['ai-run-sso', 'litellm', 'bedrock', 'ollama', 'anthropic-subscription'],
  },
  gemini: {
    name: 'Gemini CLI', maker: 'Google', mono: 'G', color: '#3B6FE0', featured: true,
    short: 'Google’s open-source agent with a very long memory for big codebases.',
    desc: 'Google’s open-source coding agent. Good with very large codebases.',
    providers: ['ai-run-sso', 'litellm'],
  },
  codex: {
    name: 'OpenAI Codex', maker: 'OpenAI', mono: 'Cx', color: '#0F8F6A', featured: true,
    short: 'OpenAI’s agent. Strong at reviews and refactoring.',
    desc: 'OpenAI’s coding agent for the terminal.',
    providers: ['ai-run-sso', 'litellm', 'ollama'],
  },
  copilot: {
    name: 'GitHub Copilot CLI', maker: 'GitHub', mono: 'GH', color: '#6E40C9', featured: true,
    short: 'Copilot’s agent, if your team already works in GitHub.',
    desc: 'GitHub Copilot’s coding agent in the terminal.',
    providers: ['ai-run-sso', 'litellm'],
  },
  opencode: {
    name: 'OpenCode', maker: 'Open source', mono: 'OC', color: '#3F4652', featured: true,
    short: 'Open-source agent that works with many models.',
    desc: 'An open-source coding agent that works with many models.',
    providers: ['ai-run-sso', 'litellm', 'bedrock', 'ollama'],
  },
  kimi: {
    name: 'Kimi Code', maker: 'Moonshot AI', mono: 'K', color: '#1F2A44',
    short: 'Moonshot’s agent.',
    desc: 'Moonshot’s coding agent. Works with CodeMie or a Kimi subscription.',
    providers: ['moonshot-subscription', 'ai-run-sso'],
  },
  pi: {
    name: 'Pi', maker: 'Open source', mono: 'Pi', color: '#0B7FA8',
    short: 'A small, fast agent.',
    desc: 'A small, fast open-source coding agent.',
    providers: ['ai-run-sso', 'litellm', 'ollama'],
  },
  openwiki: {
    name: 'OpenWiki', maker: 'Open source', mono: 'W', color: '#8A5A12',
    short: 'Writes and keeps a wiki of your codebase.',
    desc: 'Writes and keeps up to date a wiki of your codebase.',
    providers: ['ai-run-sso', 'litellm', 'ollama', 'moonshot-subscription'],
  },
  'claude-acp': {
    name: 'Claude Code for editors', maker: 'Anthropic · ACP', mono: 'CC', color: '#8C4A33', editor: true,
    short: 'Claude Code inside Zed, JetBrains and other ACP editors.',
    desc: 'Claude Code for editors that speak the Agent Client Protocol, such as Zed and JetBrains.',
    providers: ALL,
  },
  'codex-acp': {
    name: 'Codex for editors', maker: 'OpenAI · ACP', mono: 'Cx', color: '#0B6B50', editor: true,
    short: 'Codex inside ACP editors.',
    desc: 'OpenAI Codex for editors that speak the Agent Client Protocol.',
    providers: ALL,
  },
  'gemini-acp': {
    name: 'Gemini CLI for editors', maker: 'Google · ACP', mono: 'G', color: '#2C56B8', editor: true,
    short: 'Gemini CLI inside ACP editors.',
    desc: 'Gemini CLI for editors that speak the Agent Client Protocol.',
    providers: ALL,
  },
  'opencode-acp': {
    name: 'OpenCode for editors', maker: 'Open source · ACP', mono: 'OC', color: '#2E343D', editor: true,
    short: 'OpenCode inside ACP editors.',
    desc: 'OpenCode for editors that speak the Agent Client Protocol.',
    providers: ALL,
  },
  'kimi-acp': {
    name: 'Kimi Code for editors', maker: 'Moonshot AI · ACP', mono: 'K', color: '#141C30', editor: true,
    short: 'Kimi Code inside ACP editors.',
    desc: 'Kimi Code for editors that speak the Agent Client Protocol.',
    providers: ALL,
  },
};

/** CodeMie's own agent, shipped inside the CLI: shown, never installed or removed. */
export const BUILTIN_INFO = {
  name: 'CodeMie Code', maker: 'Built in', mono: 'CM', color: '#6A3BB5',
  desc: 'CodeMie’s own agent. Comes with CodeMie — nothing to install.',
  providers: ['ai-run-sso', 'litellm', 'bedrock', 'ollama'],
};

/** The launcher an agent runs as from Terminal. */
export const launcherFor = (command) => (command === BUILTIN_AGENT ? BUILTIN_AGENT : `codemie-${command}`);

/** Apps the CodeMie gateway can point at. `disconnectFlag` only where CLI 0.16.3 can undo it. */
export const APPS = [
  { id: 'claude-desktop', name: 'Claude Desktop', connectFlag: '--claude-desktop', disconnectFlag: null, icon: 'monitor',
    text: 'Chat and Cowork in Claude Desktop answer with your CodeMie models.' },
  { id: 'vscode-copilot', name: 'VS Code — GitHub Copilot Chat', connectFlag: '--vscode', disconnectFlag: null, icon: 'chat',
    text: 'CodeMie models appear in Copilot Chat’s model picker.' },
  { id: 'vscode-claude', name: 'VS Code — Claude Code extension', connectFlag: '--vscode-claude-code', disconnectFlag: null, icon: 'terminal',
    text: 'The Claude Code extension in VS Code uses CodeMie.' },
  { id: 'codex-desktop', name: 'Codex app', connectFlag: '--codex-desktop', disconnectFlag: '--codex-desktop', icon: 'monitor',
    text: 'The Codex desktop app uses your CodeMie models.' },
];

/** [id, label, short] in the CLI wizard's order. */
export const PROVIDERS = [
  ['ai-run-sso', 'EPAM AI/Run CodeMie', 'CodeMie SSO'],
  ['litellm', 'LiteLLM proxy', 'LiteLLM'],
  ['bedrock', 'AWS Bedrock', 'AWS Bedrock'],
  ['ollama', 'Ollama on this Mac', 'Ollama'],
  ['anthropic-subscription', 'Claude subscription (Pro or Max)', 'Claude subscription'],
  ['moonshot-subscription', 'Kimi subscription', 'Kimi subscription'],
];

export const providerShort = (id) => PROVIDERS.find((p) => p[0] === id)?.[2] || id || '—';

/** Offered when the CLI asks "No models found. Enter model name manually:". */
export const SUBSCRIPTION_MODELS = {
  'anthropic-subscription': ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  'moonshot-subscription': ['kimi-k2'],
};
