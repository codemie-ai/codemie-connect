import { cmdlog } from './runner-bridge.js';
import mapFailure from './cmdlog-failure-map.mjs';

let _records = [];

async function _renderRecords() {
  _records = [...(await cmdlog.list())].reverse(); // newest-first
  const body = document.getElementById('command-log-body');
  body.innerHTML = '';
  for (const r of _records) {
    const block = document.createElement('div');
    block.dataset.id = r.id;

    const cmd = document.createElement('span');
    cmd.className = 'log-line log-prompt';
    cmd.textContent = r.command;

    const meta = document.createElement('span');
    meta.className = 'log-line log-dim';
    meta.textContent = r.exit_code != null
      ? `exit ${r.exit_code} · ${(r.duration_ms / 1000).toFixed(1)}s`
      : 'running…';

    block.appendChild(cmd);
    block.appendChild(meta);

    const msg = mapFailure(r);
    if (msg) {
      const info = document.createElement('span');
      info.className = 'log-line log-info';
      info.textContent = msg;
      block.appendChild(info);
    }
    body.appendChild(block);
  }
}

export function initCmdLog() {
  const footer = document.getElementById('command-log-footer');
  footer.classList.remove('hidden');

  if (!document.getElementById('cmdlog-copy-all')) {
    const btn = document.createElement('button');
    btn.id = 'cmdlog-copy-all';
    btn.textContent = 'Copy all';
    // No await before writeText — user-activation context must be preserved
    btn.addEventListener('click', () => {
      const text = _records.map(r =>
        [r.command, `exit ${r.exit_code}`, mapFailure(r)].filter(Boolean).join('\n')
      ).join('\n\n');
      if (window.isSecureContext && navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(console.warn);
      } else {
        window.__TAURI__['clipboard-manager'].writeText(text).catch(console.warn);
      }
    });
    footer.querySelector('summary').appendChild(btn);
  }

  footer.addEventListener('toggle', (e) => { if (e.target.open) _renderRecords(); });
  _renderRecords();
}

export async function openCmdLogRecord(id) {
  document.getElementById('command-log-footer').open = true;
  await _renderRecords();
  document.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}
