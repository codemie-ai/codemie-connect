// Presentational render module for the About screen (#about-view). Pure DOM
// building from a model assembled by renderer.js — no invoke() here. Reuses
// the Health screen's classes so both screens look the same.
export const GITHUB_URL = 'https://github.com/codemie-ai/codemie-code#native-bootstrap-installers';
export const SUPPORT_MAILTO = 'mailto:AskCodeMie@epam.com';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function versionRow(label, version, note, button, error) {
  const row = el('div', 'health-row');
  const main = el('div', 'health-row-main');
  const detail = version || 'Not available';
  main.append(el('span', 'health-label', label), el('span', 'health-detail', note ? `${detail} · ${note}` : detail));
  if (button) main.appendChild(button);
  row.appendChild(main);
  if (error) row.appendChild(el('div', 'update-error', error));
  return row;
}

function updateButton(id, label, running, onClick) {
  const btn = el('button', 'btn btn-accent', running ? 'Updating…' : label);
  btn.id = id;
  btn.disabled = !!running;
  btn.onclick = () => onClick?.();
  return btn;
}

function linkSection(container, heading, label, url, onOpenLink) {
  container.appendChild(el('div', 'health-group-heading', heading));
  const actions = el('div', 'health-actions');
  const btn = el('button', 'btn btn-ghost', label);
  btn.onclick = () => onOpenLink?.(url);
  actions.appendChild(btn);
  container.appendChild(actions);
}

export function renderAbout(container, model, handlers = {}) {
  const { onUpdateApp, onUpdateCli, onOpenLink } = handlers;
  container.innerHTML = '';

  const head = el('div', 'health-head');
  head.appendChild(el('h1', 'health-title', 'About CodeMie Connect'));
  container.appendChild(head);

  container.appendChild(el('div', 'health-group-heading', 'Version information'));
  const appBtn = model.appUpdateAvailable
    ? updateButton('about-app-update', `Update to ${model.appLatest}`, model.appRunning, onUpdateApp)
    : null;
  container.appendChild(versionRow('CodeMie Connect', model.appVersion, '', appBtn, model.appError));
  const cliLabel = model.cliLatest ? `Update to ${model.cliLatest}` : 'Update';
  const cliBtn =
    model.cliUpdateAvailable && !model.cliBundled
      ? updateButton('about-cli-update', cliLabel, model.cliRunning, onUpdateCli)
      : null;
  container.appendChild(
    versionRow('CodeMie CLI', model.cliVersion, model.cliBundled ? 'Updates with the app' : '', cliBtn, model.cliError),
  );

  linkSection(container, 'Resources', 'GitHub Repository', GITHUB_URL, onOpenLink);
  linkSection(container, 'Support', 'Request Help', SUPPORT_MAILTO, onOpenLink);
}
