// Pure per-status action-label/disabled/note table — no DOM dependency, safe
// for node:test. renderer.js's refreshConnectionsView() consumes this to
// paint #connect-rows; keep this module DOM-free so it stays unit-testable.
//
// CLI connect/disconnect flags per spec.md's "Per-row status model" table.
// Disconnect is enabled only for codex-desktop — the CLI's `proxy disconnect`
// only supports `--codex-desktop` today (EPMCDME-15246 tracks the other 3).
export const CONNECTION_APPS = [
  { app: 'claude-desktop', label: 'Claude Desktop', bundleName: 'Claude', connectFlag: '--claude-desktop', canDisconnect: false },
  { app: 'vscode-copilot', label: 'VS Code — Copilot Chat (BYOK)', bundleName: 'Visual Studio Code', connectFlag: '--vscode', canDisconnect: false },
  { app: 'vscode-claude-code', label: 'VS Code — Claude Code extension', bundleName: 'Visual Studio Code', connectFlag: '--vscode-claude-code', canDisconnect: false },
  { app: 'codex-desktop', label: 'Codex desktop app', bundleName: 'Codex', connectFlag: '--codex-desktop', canDisconnect: true },
];

export function renderConnectionRows(statusesByApp) {
  return CONNECTION_APPS.map(({ app, label, connectFlag, canDisconnect }) => {
    const status = statusesByApp[app]?.status ?? 'not-installed';
    let actionLabel = null;
    let actionDisabled = true;
    let note = null;

    if (status === 'not-set') {
      actionLabel = 'Connect';
      actionDisabled = false;
    } else if (status === 'disconnected') {
      actionLabel = 'Fix';
      actionDisabled = false;
    } else if (status === 'connected') {
      actionLabel = 'Disconnect';
      actionDisabled = !canDisconnect;
      if (!canDisconnect) note = 'CLI support pending';
    }

    return { app, label, status, actionLabel, actionDisabled, note, connectFlag };
  });
}
