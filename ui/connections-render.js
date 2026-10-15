// Pure per-status action-table — no DOM dependency, safe for node:test.
// renderer.js's refreshConnectionsView() consumes this to paint #connect-rows;
// keep this module DOM-free so it stays unit-testable.
//
// CLI connect/disconnect flags per spec.md's "Per-row status model" table.
// The CLI's `proxy disconnect` supports all 4 apps (EPMCDME-15246).
export const CONNECTION_APPS = [
  { app: 'claude-desktop', label: 'Claude Desktop', bundleName: 'Claude', connectFlag: '--claude-desktop' },
  { app: 'vscode-copilot', label: 'VS Code — Copilot Chat (BYOK)', bundleName: 'Visual Studio Code', connectFlag: '--vscode' },
  { app: 'vscode-claude-code', label: 'VS Code — Claude Code extension', bundleName: 'Visual Studio Code', connectFlag: '--vscode-claude-code' },
  { app: 'codex-desktop', label: 'Codex desktop app', bundleName: 'ChatGPT', connectFlag: '--codex-desktop' },
];

export function renderConnectionRows(statusesByApp) {
  return CONNECTION_APPS.map(({ app, label, connectFlag }) => {
    const status = statusesByApp[app]?.status ?? 'not-installed';
    let actions = [];

    if (status === 'not-installed') {
      actions = [{ kind: 'install', label: 'Install and connect', disabled: false, note: null }];
    } else if (status === 'not-set') {
      actions = [{ kind: 'connect', label: 'Connect', disabled: false, note: null }];
    } else if (status === 'disconnected') {
      actions = [
        { kind: 'reconnect', label: 'Reconnect', disabled: false, note: null },
        { kind: 'disconnect', label: 'Remove setup', disabled: false, note: null },
      ];
    } else if (status === 'connected') {
      actions = [{ kind: 'disconnect', label: 'Disconnect', disabled: false, note: null }];
    }

    return { app, label, status, actions, connectFlag };
  });
}
