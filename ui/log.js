// Collapsible, color-tagged log panel. Mirrors ui/terminal_panel.py.

let contentEl = null;
let panelEl = null;
let toggleBtn = null;
let shown = false;
const COLLAPSED_H = 600;
const EXPANDED_H = 600 + 220 + 36 + 18; // window grows when the log opens

export function initLog({ content, panel, toggle, openBtn }) {
  contentEl = content;
  panelEl = panel;
  toggleBtn = toggle;
  toggle.onclick = () => setShown(!shown);
  openBtn.onclick = () => window.codemie.openLog();
}

function setShown(next) {
  shown = next;
  panelEl.classList.toggle('hidden', !shown);
  toggleBtn.textContent = shown ? '▾ Hide log' : '▸ Show log';
  window.codemie.setWindowHeight(shown ? EXPANDED_H : COLLAPSED_H);
}

export function appendLine(text, tag = 'stdout') {
  if (!contentEl) return;
  const line = document.createElement('div');
  line.className = 'log-line log-' + tag;
  line.textContent = text;
  contentEl.appendChild(line);
  contentEl.scrollTop = contentEl.scrollHeight;
}
