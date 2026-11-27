// Every CodeMie CLI command Settings → CodeMie runs, as the exact string handed to
// `run_capture` / `run_stream` (a login shell: /bin/zsh -lc on macOS, cmd.exe /c on Windows).
// Neither command validates anything, so every interpolated value passes assertSafe first.
//
// Non-interactive commands close stdin (`< /dev/null`, `< NUL`) so a CLI question can never hang
// a call. install/update/uninstall, profile login and doctor keep the stream open: they are run
// through run_stream and report progress as they go.

export const SAFE = {
  name: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  agent: /^[a-z0-9][a-z0-9-]{0,40}$/,
  url: /^https?:\/\/(\[::1\]|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*)(:\d{1,5})?$/,
  flag: /^--[a-z][a-z-]{1,40}$/,
};

/** Returns `value` when it matches SAFE[kind]; throws otherwise. */
export function assertSafe(kind, value) {
  const re = SAFE[kind];
  if (!re || typeof value !== 'string' || !re.test(value)) throw new Error('Unsafe ' + kind);
  return value;
}

/** True when `value` can be put in a command as a `kind`. */
export const isSafe = (kind, value) => typeof value === 'string' && !!SAFE[kind]?.test(value);

export function cliCommands(platform) {
  const closed = platform === 'windows' ? ' < NUL' : ' < /dev/null';
  const name = (v) => assertSafe('name', v);
  const agent = (v) => assertSafe('agent', v);
  return {
    version: `codemie --version${closed}`,
    list: `codemie list${closed}`,
    updateCheck: `codemie update --check${closed}`,
    install: (n) => `codemie install ${agent(n)}`,
    update: (n) => `codemie update ${agent(n)}`,
    uninstall: (n) => `codemie uninstall ${agent(n)}`,
    commandPath: (cmd) => `${platform === 'windows' ? 'where' : 'command -v'} ${agent(cmd)}${closed}`,
    switchProfile: (n) => `codemie profile switch ${name(n)}${closed}`,
    renameProfile: (from, to) => `codemie profile rename ${name(from)} ${name(to)}${closed}`,
    deleteProfile: (n) => `codemie profile delete ${name(n)} -y${closed}`,
    login: (url) => `codemie profile login --url ${assertSafe('url', url)}`,
    proxyStatus: `codemie proxy status --json${closed}`,
    proxyConnect: (flags, profile) =>
      `codemie proxy connect ${flags.map((f) => assertSafe('flag', f)).join(' ')} --profile ${name(profile)} --silent${closed}`,
    proxyDisconnect: (flag) => `codemie proxy disconnect ${assertSafe('flag', flag)}${closed}`,
    proxyStart: (profile) => `codemie proxy start --profile ${name(profile)}${closed}`,
    proxyRestart: (profile) => `codemie proxy restart --profile ${name(profile)}${closed}`,
    doctor: 'codemie doctor',
    selfUpdateCheck: `codemie self-update --check${closed}`,
    selfUpdate: `codemie self-update${closed}`,
    // The real folder of the CodeMie package that runs: an `npm link` resolves to its checkout.
    activePackageDir: platform === 'windows' ? null
      : `cd "$(dirname "$(command -v codemie)")/../lib/node_modules/@codemieai/code" && pwd -P${closed}`,
  };
}
