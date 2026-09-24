import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConnectionRows } from '../connections-render.js';

test('codex-desktop disconnect is enabled when connected', () => {
  const rows = renderConnectionRows({
    'codex-desktop': { status: 'connected' }, 'claude-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const codex = rows.find(r => r.app === 'codex-desktop');
  assert.equal(codex.actions.length, 1);
  assert.equal(codex.actions[0].label, 'Disconnect');
  assert.equal(codex.actions[0].disabled, false);
});

test('claude-desktop disconnect is disabled with CLI-support-pending note when connected', () => {
  const rows = renderConnectionRows({
    'claude-desktop': { status: 'connected' }, 'codex-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const row = rows.find(r => r.app === 'claude-desktop');
  assert.equal(row.actions[0].disabled, true);
  assert.match(row.actions[0].note, /CLI support pending/);
});

test('not-installed rows show a disabled Install and connect action', () => {
  const rows = renderConnectionRows({
    'claude-desktop': { status: 'not-installed' }, 'codex-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const row = rows.find(r => r.app === 'claude-desktop');
  assert.equal(row.actions[0].label, 'Install and connect');
  assert.equal(row.actions[0].disabled, true);
  assert.match(row.actions[0].note, /coming soon/);
});

test('disconnected rows offer Reconnect + Remove setup, not-set rows offer Connect', () => {
  const rows = renderConnectionRows({
    'claude-desktop': { status: 'disconnected' }, 'codex-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const claude = rows.find(r => r.app === 'claude-desktop');
  assert.deepEqual(claude.actions.map(a => a.label), ['Reconnect', 'Remove setup']);
  assert.equal(claude.actions[0].disabled, false);
  assert.equal(claude.actions[1].disabled, true); // claude-desktop can't disconnect yet
  assert.equal(rows.find(r => r.app === 'codex-desktop').actions[0].label, 'Connect');
});

test('disconnected codex-desktop row can Remove setup (CLI supports its disconnect)', () => {
  const rows = renderConnectionRows({
    'codex-desktop': { status: 'disconnected' }, 'claude-desktop': { status: 'not-set' },
    'vscode-copilot': { status: 'not-set' }, 'vscode-claude-code': { status: 'not-set' },
  });
  const row = rows.find(r => r.app === 'codex-desktop');
  assert.equal(row.actions[1].label, 'Remove setup');
  assert.equal(row.actions[1].disabled, false);
});
