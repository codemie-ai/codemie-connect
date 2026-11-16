// Collapsible, color-tagged log panel. Mirrors ui/terminal_panel.py.
const { invoke } = window.__TAURI__.core;

let contentEl = null;
let panelEl = null;
let toggleBtn = null;
let shown = false;

export function initLog({ content, panel, toggle, openBtn }) {
  contentEl = content;
  panelEl = panel;
  toggleBtn = toggle;
  toggle.onclick = () => setShown(!shown);
  openBtn.onclick = () => invoke('open_log');
}

function setShown(next) {
  shown = next;
  panelEl.classList.toggle('hidden', !shown);
  toggleBtn.textContent = shown ? '▾ Hide log' : '▸ Show log';
  // The resizable workspace owns geometry. The log consumes space in the tools host.
}

export function appendLine(text, tag = 'stdout') {
  if (!contentEl) return;
  const line = document.createElement('div');
  line.className = 'log-line log-' + tag;
  line.textContent = text;
  contentEl.appendChild(line);
  contentEl.scrollTop = contentEl.scrollHeight;
}
