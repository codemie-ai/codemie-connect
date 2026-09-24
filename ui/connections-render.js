// Pure per-status action-table — no DOM dependency, safe for node:test.
// renderer.js's refreshConnectionsView() consumes this to paint #connect-rows;
// keep this module DOM-free so it stays unit-testable.
//
// CLI connect/disconnect flags per spec.md's "Per-row status model" table.
// Disconnect is enabled only for codex-desktop — the CLI's `proxy disconnect`
// only supports `--codex-desktop` today (EPMCDME-15246 tracks the other 3).
export const CONNECTION_APPS = [
  { app: 'claude-desktop', label: 'Claude Desktop', bundleName: 'Claude', connectFlag: '--claude-desktop', canDisconnect: false },
  { app: 'vscode-copilot', label: 'VS Code — Copilot Chat (BYOK)', bundleName: 'Visual Studio Code', connectFlag: '--vscode', canDisconnect: false },
  { app: 'vscode-claude-code', label: 'VS Code — Claude Code extension', bundleName: 'Visual Studio Code', connectFlag: '--vscode-claude-code', canDisconnect: false },
  { app: 'codex-desktop', label: 'Codex desktop app', bundleName: 'ChatGPT', connectFlag: '--codex-desktop', canDisconnect: true },
];

export function renderConnectionRows(statusesByApp) {
  return CONNECTION_APPS.map(({ app, label, connectFlag, canDisconnect }) => {
    const status = statusesByApp[app]?.status ?? 'not-installed';
    let actions = [];

    if (status === 'not-installed') {
      // Install flow is out of scope for this ticket (EPMCDME-14574) — the button
      // is shown per design but stays disabled until a future ticket wires it up.
      actions = [{ kind: 'install', label: 'Install and connect', disabled: true, note: 'Install flow coming soon' }];
    } else if (status === 'not-set') {
      actions = [{ kind: 'connect', label: 'Connect', disabled: false, note: null }];
    } else if (status === 'disconnected') {
      actions = [
        { kind: 'reconnect', label: 'Reconnect', disabled: false, note: null },
        { kind: 'disconnect', label: 'Remove setup', disabled: !canDisconnect, note: canDisconnect ? null : 'CLI support pending' },
      ];
    } else if (status === 'connected') {
      actions = [{ kind: 'disconnect', label: 'Disconnect', disabled: !canDisconnect, note: canDisconnect ? null : 'CLI support pending' }];
    }

    return { app, label, status, actions, connectFlag };
  });
}
