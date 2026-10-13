// Draws the rows of the Profiles screen (opened by Home's "Manage profiles"). Pure DOM from
// the controller's state; the actions are the caller's handlers. Which row is
// being renamed or is asking for a delete confirmation is the view's own state,
// kept per container so a redraw from the controller keeps it.
import { renderFailurePanel } from './failure-panel.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onclick, { disabled = false, ghost = true } = {}) {
  const b = el('button', ghost ? 'btn btn-ghost' : 'btn btn-accent', label);
  b.disabled = disabled;
  b.onclick = onclick;
  return b;
}

const local = new WeakMap();

export function renderProfileList(container, state, handlers = {}) {
  const { onSwitch, onRename, onDelete } = handlers;
  const ui = local.get(container) ?? { renaming: null, draft: null, confirming: null };
  local.set(container, ui);
  const redraw = () => renderProfileList(container, state, handlers);
  container.innerHTML = '';

  const list = el('div', 'profile-list');
  // The active profile first, the rest in the config's order (alphabetical).
  const rows = [...state.profiles].sort((a, b) => Number(b.active) - Number(a.active));
  for (const p of rows) {
    const row = el('div', 'profile-row');
    const info = el('div', 'profile-info');
    const busy = state.busy;

    if (ui.renaming === p.name) {
      const input = el('input', 'prompt-input profile-rename-input');
      // The typed name is kept with the row, so a re-read (the window coming
      // back to the front) does not wipe it.
      // macOS capitalises "work" to "Work" in a plain field, and the CLI then
      // saves that name (EPMCDME-15385, fixed the same way in setup-view.js).
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('autocorrect', 'off');
      input.spellcheck = false;
      input.value = ui.draft ?? p.name;
      input.oninput = () => { ui.draft = input.value; };
      info.append(input);
      row.append(info, button('Save', () => {
        ui.renaming = null;
        ui.draft = null;
        onRename?.(p.name, input.value.trim());
        redraw();
      }, { disabled: busy, ghost: false }), button('Cancel', () => { ui.renaming = null; ui.draft = null; redraw(); }));
    } else if (ui.confirming === p.name) {
      const warning = p.active
        ? `Delete ${p.name}? It is the active profile. Another profile becomes active, or setup starts again if none is left.`
        : `Delete ${p.name}? This cannot be undone.`;
      info.append(el('div', 'profile-confirm', warning));
      row.append(info, button('Confirm', () => {
        ui.confirming = null;
        onDelete?.(p.name);
        redraw();
      }, { disabled: busy, ghost: false }), button('Cancel', () => { ui.confirming = null; redraw(); }));
    } else {
      info.append(el('div', 'profile-name', p.name), el('div', 'profile-sub', `${p.provider} · ${p.model}`));
      row.append(info);
      if (p.active) row.append(el('span', 'profile-badge', 'Active'));
      else row.append(button('Switch', () => onSwitch?.(p.name), { disabled: busy }));
      row.append(
        button('Rename', () => { ui.renaming = p.name; ui.draft = null; ui.confirming = null; redraw(); }, { disabled: busy }),
        button('Delete', () => { ui.confirming = p.name; ui.renaming = null; redraw(); }, { disabled: busy }),
      );
    }
    list.append(row);
  }
  if (state.profiles.length) container.append(list);

  if (state.notice) container.append(el('div', 'profile-notice', state.notice));
  if (state.failure) {
    const slot = el('div', 'profile-failure');
    renderFailurePanel(slot, {
      variant: 'error',
      title: 'Could not change the profile',
      explanation: state.failure.message,
      raw: state.failure.raw,
      command: state.failure.command,
    });
    container.append(slot);
  }
}
