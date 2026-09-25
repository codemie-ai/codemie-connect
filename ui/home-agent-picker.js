// The list Home's "Install an agent" checklist item opens, so the first
// install happens without leaving the screen the flow lives on.
//
// One action per row, the way the Agents screen works: each row carries its own
// Install button and its own progress, rather than a selection plus a separate
// submit — the checklist row already asks the question, so the list only has to
// answer it in one click. Install, and only install, is here; update and remove
// stay on the Agents screen, which the sidebar opens.
//
// Pure DOM: no Tauri, no window globals. The caller owns the install itself
// and hands back its result.
import { BUILTIN_AGENT_COMMAND } from './home-state.js';

// The CLI's own `codemie setup` ends by asking "Would you like to install
// Claude Code now?", so Claude Code is the CLI's suggestion rather than ours.
// See .ai-run/decisions/2026-09-22-EPMCDME-15189-recommended-agent.md.
const RECOMMENDED_COMMAND = 'claude';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// name + description on the left, whatever the row can do on the right. The
// badge is only on a row still waiting to be chosen: once an agent is being
// installed, or is installed, recommending it says nothing.
function agentRow(agent, right, { badge } = {}) {
  const row = el('div', 'home-agent-row');
  const main = el('div', 'home-agent-main');
  const title = el('div', 'home-agent-name', agent.name);
  if (badge) {
    title.appendChild(el('span', 'home-agent-badge', 'Recommended'));
  }
  main.append(title, el('div', 'home-agent-desc', agent.description || ''));
  row.append(main, right);
  return row;
}

// `busy` is the install in flight ({ command, name, line }): its row shows what
// the command is saying, and every other Install is disabled, because a second
// install started underneath the first only races it.
export function renderAgentPicker(host, { agents, busy, error } = {}, { onInstall } = {}) {
  const picker = el('div', 'home-picker');

  // `undefined` is "not read yet" and `null` is "the read failed" — neither is
  // an empty list, and neither means every agent is installed.
  if (!Array.isArray(agents)) {
    picker.appendChild(el('div', 'home-picker-line', agents === null ? 'The tool list could not be read.' : 'Reading the tool list…'));
    host.appendChild(picker);
    return picker;
  }

  if (error) picker.appendChild(el('div', 'home-picker-error', error));

  // What is already on the machine first, so the user sees where they stand
  // before choosing — including the built-in agent, which ships inside the CLI
  // package and so is always installed and never offered. Then the one the CLI
  // suggests, then the rest.
  const rank = (a) => (a.installed ? 0 : a.command === RECOMMENDED_COMMAND ? 1 : 2);
  const ordered = [...agents].sort((a, b) => rank(a) - rank(b));

  const list = el('div', 'home-agent-list');
  for (const agent of ordered) {
    if (busy && busy.command === agent.command) {
      list.appendChild(agentRow(agent, el('span', 'home-agent-progress', busy.line || 'Installing…')));
      continue;
    }
    if (agent.installed) {
      // The built-in agent comes with the CLI; "Installed" on the first row read
      // as the recommended agent being installed already.
      const have = agent.command === BUILTIN_AGENT_COMMAND ? 'Built into the CLI' : 'Installed';
      const row = agentRow(agent, el('span', 'home-agent-have', agent.version ? `${have} · ${agent.version}` : have));
      row.className = 'home-agent-row installed';
      list.appendChild(row);
      continue;
    }
    const btn = el('button', 'btn btn-accent home-agent-install', 'Install');
    btn.disabled = !!busy;
    // Returns the handler's promise so a caller -- and a test -- can wait for
    // the install to finish rather than letting it run detached.
    btn.onclick = (e) => {
      e?.stopPropagation?.();
      if (busy) return undefined;
      return onInstall?.(agent);
    };
    list.appendChild(agentRow(agent, btn, { badge: agent.command === RECOMMENDED_COMMAND }));
  }
  picker.appendChild(list);

  host.appendChild(picker);
  return picker;
}
