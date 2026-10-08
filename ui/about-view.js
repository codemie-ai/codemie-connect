// Presentational render module for the About screen (#about-view). Pure DOM
// building from a model assembled by renderer.js — no invoke() here. Each
// entry is a card, the way CodeMie web's Learning Resources lists its links.
export const GITHUB_URL = 'https://github.com/codemie-ai/codemie-code#native-bootstrap-installers';
export const SUPPORT_MAILTO = 'mailto:AskCodeMie@epam.com';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Static icon markup (no user data), drawn in the card's icon circle.
const ICONS = {
  app: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8"/>',
  cli: '<path d="M5 8l4 4-4 4M12 17h7"/>',
  github:
    '<path d="M9 19c-4 1.5-4-2-6-2.5M15 22v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V22"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
};

function icon(name, className) {
  const node = el('span', className);
  node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[name]}</svg>`;
  return node;
}

// One card: icon, title (with an optional version), one line of description,
// an optional action on the right, and an optional error under it.
function card({ iconName, title, version, desc, action, error }) {
  const node = el('div', 'about-card');
  node.appendChild(icon(iconName, 'about-card-icon'));
  const text = el('div', 'about-card-text');
  const head = el('div', 'about-card-title', title);
  if (version !== undefined) {
    head.textContent = '';
    head.append(el('span', '', title), el('span', 'about-card-version', version || 'Not available'));
  }
  text.append(head, el('div', 'about-card-desc', desc));
  if (error) text.appendChild(el('div', 'update-error', error));
  node.appendChild(text);
  if (action) node.appendChild(action);
  return node;
}

function updateButton(id, label, running, onClick) {
  const btn = el('button', 'btn btn-accent about-card-action', running ? 'Updating…' : label);
  btn.id = id;
  btn.disabled = !!running;
  btn.onclick = () => onClick?.();
  return btn;
}

function linkButton(label, url, onOpenLink) {
  const btn = el('button', 'about-link');
  btn.append(icon('external', 'about-link-icon'), el('span', '', label));
  btn.onclick = () => onOpenLink?.(url);
  return btn;
}

function section(container, heading, cards) {
  container.appendChild(el('div', 'health-group-heading', heading));
  const list = el('div', 'about-list');
  cards.forEach((c) => list.appendChild(c));
  container.appendChild(list);
}

export function renderAbout(container, model, handlers = {}) {
  const { onUpdateApp, onOpenLink } = handlers;
  container.innerHTML = '';

  const head = el('div', 'health-head');
  head.appendChild(el('h1', 'health-title', 'About CodeMie Connect'));
  container.appendChild(head);
  container.appendChild(el('div', 'about-sub', 'Your versions, where to learn more, and how to get help.'));

  const appUpdate = model.appUpdateAvailable;
  section(container, 'Version information', [
    card({
      iconName: 'app',
      title: 'CodeMie Connect',
      version: model.appVersion,
      desc: appUpdate
        ? `Version ${model.appLatest} is available. Takes about a minute, everything you set up stays.`
        : 'The desktop app for the CodeMie CLI.',
      action: appUpdate
        ? updateButton('about-app-update', `Update to ${model.appLatest}`, model.appRunning, onUpdateApp)
        : null,
      error: model.appError,
    }),
    // No update of its own: the CLI comes with the app update (EPMCDME-15407).
    card({
      iconName: 'cli',
      title: 'CodeMie CLI',
      version: model.cliVersion,
      desc: 'Comes with the app and stays up to date with it.',
    }),
  ]);
  section(container, 'Resources', [
    card({
      iconName: 'github',
      title: 'GitHub Repository',
      desc: 'Installers, release notes and the CodeMie CLI source.',
      action: linkButton('Explore', GITHUB_URL, onOpenLink),
    }),
  ]);
  section(container, 'Support', [
    card({
      iconName: 'mail',
      title: 'Request Help',
      desc: 'Questions, problems or ideas? Write to the CodeMie team.',
      action: linkButton('Email us', SUPPORT_MAILTO, onOpenLink),
    }),
  ]);
}
