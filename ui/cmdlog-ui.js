import { cmdlog } from './runner-bridge.js';
import mapFailure from './cmdlog-failure-map.mjs';

let _records = [];
let _pollTimer = null;
const POLL_MS = 1000;

function _formatTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function _recordText(r) {
  const state = r.exit_code == null ? 'running…' : `exit ${r.exit_code}`;
  const duration = r.exit_code != null && r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : '';
  const lines = [`[${_formatTime(r.start_time)}] ${r.command} — ${state}${duration}`];
  if (r.raw_output && r.raw_output.trim() !== '') lines.push(r.raw_output.trim());
  return lines.join('\n');
}

function _renderErrorBox(body) {
  const box = document.createElement('div');
  box.className = 'log-box log-box-error';

  const title = document.createElement('div');
  title.className = 'log-prompt';
  title.textContent = 'CodeMie cannot read the command log';

  const desc = document.createElement('div');
  desc.className = 'log-dim';
  desc.textContent = 'The command log could not be loaded. Try reopening this panel.';

  box.appendChild(title);
  box.appendChild(desc);
  body.appendChild(box);
}

async function _renderRecords() {
  const body = document.getElementById('command-log-body');
  let list;
  try {
    list = await cmdlog.list();
  } catch (err) {
    console.warn(err);
    _records = [];
    body.innerHTML = '';
    _renderErrorBox(body);
    return;
  }

  _records = [...list].reverse(); // newest-first
  // Poll ticks rebuild the whole list — remember which rows were expanded so
  // a mid-read row doesn't snap shut under the user.
  const expanded = new Set(Array.from(body.children).filter((el) => el.open).map((el) => el.dataset.id));
  body.innerHTML = '';
  for (const r of _records) {
    const row = document.createElement('details');
    row.className = 'log-row';
    row.dataset.id = r.id;
    row.open = expanded.has(r.id);

    const summary = document.createElement('summary');
    summary.className = 'log-row-summary';

    const time = document.createElement('span');
    time.className = 'log-dim log-time';
    time.textContent = _formatTime(r.start_time);
    summary.appendChild(time);

    const cmd = document.createElement('span');
    cmd.className = 'log-line log-prompt';
    cmd.textContent = r.command;
    summary.appendChild(cmd);

    const status = document.createElement('span');
    if (r.exit_code == null) {
      status.className = 'log-dim';
      status.textContent = 'running…';
    } else {
      status.className = r.exit_code === 0 ? 'pill log-badge-ok' : 'pill log-badge-failed';
      status.textContent = r.exit_code === 0 ? 'ok' : 'failed';
    }
    summary.appendChild(status);
    row.appendChild(summary);

    const detail = document.createElement('div');
    detail.className = 'log-row-detail';

    if (r.raw_output && r.raw_output.trim() !== '') {
      const raw = document.createElement('pre');
      raw.className = 'log-line log-box';
      raw.textContent = r.raw_output.trim();
      detail.appendChild(raw);
    }

    const msg = mapFailure(r);
    if (msg) {
      const shownAs = document.createElement('div');
      shownAs.className = 'log-line log-info log-box';
      shownAs.textContent = `Shown to the user as — "${msg}"`;
      detail.appendChild(shownAs);
    }

    row.appendChild(detail);
    body.appendChild(row);
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
      const text = _records.map(_recordText).join('\n\n');
      if (window.isSecureContext && navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(console.warn);
      } else {
        window.__TAURI__['clipboard-manager'].writeText(text).catch(console.warn);
      }
    });
    footer.querySelector('summary').appendChild(btn);
  }

  if (!document.getElementById('cmdlog-expand')) {
    const expandBtn = document.createElement('button');
    expandBtn.id = 'cmdlog-expand';
    expandBtn.textContent = '⤢ Expand';
    expandBtn.addEventListener('click', (e) => {
      e.preventDefault(); // don't toggle the <details> open state
      const on = footer.classList.toggle('expanded');
      expandBtn.textContent = on ? '⤡ Collapse' : '⤢ Expand';
    });
    footer.querySelector('summary').appendChild(expandBtn);
  }

  const summaryEl = footer.querySelector('summary');
  if (!summaryEl.dataset.expandGuard) {
    summaryEl.dataset.expandGuard = '1';
    // While in fullscreen mode, clicking the summary bar (outside the action
    // buttons) must not collapse the <details> out from under the user.
    summaryEl.addEventListener('click', (e) => {
      if (footer.classList.contains('expanded') && !e.target.closest('button')) {
        e.preventDefault();
      }
    });
  }

  footer.addEventListener('toggle', (e) => {
    if (e.target.open) {
      _renderRecords();
      if (!_pollTimer) _pollTimer = setInterval(_renderRecords, POLL_MS);
    } else {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  });
  _renderRecords();
}

export async function openCmdLogRecord(id) {
  document.getElementById('command-log-footer').open = true;
  await _renderRecords();
  document.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}
