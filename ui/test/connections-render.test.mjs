import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConnectionRows } from '../connections-render.js';

test('codex-desktop disconnect is enabled when connected', () => {
  const rows = renderConnectionRows({
    'codex-desktop': { status: 'connected' }, 'claude-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const codex = rows.find(r => r.app === 'codex-desktop');
  assert.equal(codex.actionLabel, 'Disconnect');
  assert.equal(codex.actionDisabled, false);
});

test('claude-desktop disconnect is disabled with CLI-support-pending note when connected', () => {
  const rows = renderConnectionRows({
    'claude-desktop': { status: 'connected' }, 'codex-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const row = rows.find(r => r.app === 'claude-desktop');
  assert.equal(row.actionDisabled, true);
  assert.match(row.note, /CLI support pending/);
});

test('not-installed rows show no action', () => {
  const rows = renderConnectionRows({
    'claude-desktop': { status: 'not-installed' }, 'codex-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const row = rows.find(r => r.app === 'claude-desktop');
  assert.equal(row.actionLabel, null);
});

test('disconnected rows offer Reconnect (Fix), not-set rows offer Connect', () => {
  const rows = renderConnectionRows({
    'claude-desktop': { status: 'disconnected' }, 'codex-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  assert.equal(rows.find(r => r.app === 'claude-desktop').actionLabel, 'Fix');
  assert.equal(rows.find(r => r.app === 'codex-desktop').actionLabel, 'Connect');
});
