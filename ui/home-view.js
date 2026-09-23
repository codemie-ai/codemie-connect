// The Home body (#home-body): the onboarding checklist until nothing is left
// to tick, then the three status cards. One screen, two states, no "finish".
//
// The checklist is the app's step list on its own steps-ui instance (the
// module-level default belongs to the legacy install engine, guided setup and
// Health have their own). Pure DOM apart from that instance, which is injected,
// so node:test drives it with a recording stand-in.
import { StepStatus, makeStep } from './models.js';
import { renderAgentPicker } from './home-agent-picker.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The items above `id` in the checklist -- what has to be done before it.
function itemsBefore(items, id) {
  const at = items.findIndex((i) => i.id === id);
  return at === -1 ? [] : items.slice(0, at);
}

export function createHomeView(container, { stepsUi, onItem, onSignIn, onCard, onSetupAgain, onInstallAgent } = {}) {
  let listEl = null;
  // render() rebuilds the whole body, and a refresh can arrive at any moment
  // (an agent read, a health result). These three live outside it so an
  // expanded row, an install in flight and the message a failure left behind
  // all survive a re-render instead of vanishing under the user.
  let expanded = null;
  let busy = null;
  let failure = null;
  let lastState = null;
  // Item 3 opens by itself once, when it becomes the step the user is on;
  // after that only the user opens or closes it.
  let agentAutoOpened = false;

  function renderChecklist({ items, agents }) {
    const block = el('section', 'home-check');
    block.append(
      el('h2', 'home-check-title', "Welcome — let's get CodeMie working"),
      el('div', 'home-check-sub', 'Four steps. Nothing to install first.'),
    );
    listEl = el('div', 'home-check-list');
    block.appendChild(listEl);
    container.appendChild(block);

    stepsUi.renderSteps(listEl, items.map((i) => makeStep({ id: i.id, title: i.title })));
    for (const i of items) {
      stepsUi.setStatus(i.id, i.status);
      stepsUi.setSubtitle(i.id, i.subtitle);
    }

    // Item 1 completes in place: there is no sign-in screen to go to.
    const signIn = items.find((i) => i.id === 'sign-in');
    const signInRow = listEl.querySelector('.step-row[data-id="sign-in"]');
    if (signIn && signIn.status === StepStatus.PENDING && signInRow) {
      const control = el('div', 'home-signin');
      const btn = el('button', 'btn btn-accent', 'Sign in');
      btn.onclick = (e) => {
        e?.stopPropagation?.();
        onSignIn?.();
      };
      control.append(btn, el('span', 'home-signin-hint', 'opens your browser'));
      signInRow.appendChild(control);
    }

    // Item 4 runs by itself (the renderer starts the check once the steps
    // before it are done), so its row is not a link: clicking it took the user
    // off Home to a screen that looked like the row opening. While it runs it
    // shows a spinner; if it found problems, the row offers the way to them,
    // since the sidebar's Health stays locked until the checklist finishes.
    const health = items.find((i) => i.id === 'health');
    const healthRow = listEl.querySelector('.step-row[data-id="health"]');
    if (health && healthRow) {
      if (health.status === StepStatus.ACTIVE) {
        const spin = el('span', 'inline-spinner');
        spin.setAttribute?.('aria-hidden', 'true');
        const sub = healthRow.querySelector('.step-sub');
        if (sub && sub.prepend) sub.prepend(spin);
        else healthRow.appendChild(spin);
      } else if (health.status === StepStatus.WARNING || health.status === StepStatus.ERROR) {
        const control = el('div', 'home-signin');
        const btn = el('button', 'btn btn-ghost', 'Open Health');
        btn.onclick = (e) => {
          e?.stopPropagation?.();
          onItem?.('health');
        };
        control.appendChild(btn);
        healthRow.appendChild(control);
      }
    }

    // Item 3 completes in place too, the same way: the agents that are not
    // installed, as option cards. Update and remove stay on the Agents screen,
    // which "See all agents" opens.
    const agentRow = listEl.querySelector('.step-row[data-id="agent"]');
    // Installing an agent before signing in and choosing a model gets the user
    // nowhere, so the row only opens once its turn comes: no chevron before
    // that, and a click does nothing.
    const agentReady = itemsBefore(items, 'agent').every((i) => i.status === StepStatus.COMPLETE);
    // Its turn and nothing installed yet: open the list rather than leave the
    // checklist waiting for a click nothing points at.
    const agentItem = items.find((i) => i.id === 'agent');
    // Only once the list has been read: before that the step is pending too.
    if (agentReady && !agentAutoOpened && Array.isArray(agents) && agentItem && agentItem.status === StepStatus.PENDING && expanded === null) {
      expanded = 'agent';
      agentAutoOpened = true;
    }
    if (agentRow && agentReady) {
      // The chevron goes on before the list does, so it stays on the title line
      // while the list wraps under it.
      const chevron = el('span', 'home-row-toggle', expanded === 'agent' ? '⌃' : '⌄');
      chevron.setAttribute?.('aria-hidden', 'true');
      agentRow.appendChild(chevron);
    }
    if (expanded === 'agent' && agentRow && agentReady) {
      const picker = renderAgentPicker(
        agentRow,
        { agents, busy, error: failure },
        { onInstall: install },
      );
      // Item 3 is near the bottom of the list, so what it opens starts below
      // the fold: without this the user sees half a card and nothing else.
      picker?.scrollIntoView?.({ block: 'nearest' });
    }

    listEl.onclick = (e) => {
      const row = e?.target?.closest?.('.step-row');
      if (!row || row.dataset.id === 'sign-in' || row.dataset.id === 'health') return;
      const id = row.dataset.id;
      // Item 3 opens in place whether it is ticked or not: ticked means one
      // agent is installed, not that there is nothing left to add. The list
      // shows every agent, so the screen is only needed to update or remove
      // one -- which is what the sidebar's Agents entry is for.
      if (id === 'agent') {
        if (!agentReady) return;
        expanded = expanded === 'agent' ? null : 'agent';
        failure = null;
        rerender();
        return;
      }
      onItem?.(id);
    };
  }

  // Runs the install the caller owns, keeping the row's own progress line in
  // step. The line is written straight into the DOM rather than through
  // render(), so streamed output does not rebuild the list on every chunk.
  async function install(agent) {
    if (busy) return;
    busy = { name: agent.name, command: agent.command, line: 'Starting…' };
    failure = null;
    rerender();
    const onLine = (text) => {
      if (!text || !busy) return;
      busy.line = text;
      const line = container.querySelector('.home-agent-progress');
      if (line) line.textContent = text;
    };
    let result;
    try {
      result = await onInstallAgent?.(agent, onLine);
    } catch (e) {
      result = { ok: false, message: String((e && e.message) || e) };
    }
    busy = null;
    failure = result && result.ok === false ? result.message : null;
    // A successful install closes the list: the thing the row was opened for
    // is done, and leaving it open under a ticked item reads as unfinished.
    // A failure keeps it open, with the reason, so the user can try again.
    if (!failure) expanded = null;
    rerender();
  }

  function rerender() {
    if (lastState) render(lastState);
  }

  function renderCards({ cards }) {
    const grid = el('section', 'home-cards');
    for (const card of cards) {
      const node = el('div', `home-card home-card-${card.badge.tone}`);
      node.dataset.card = card.id;
      const head = el('div', 'home-card-head');
      head.append(el('span', 'home-card-title', card.title), el('span', `home-card-badge tone-${card.badge.tone}`, card.badge.text));
      // The Profile card's action sits in the title row: under the card it
      // made this card taller than the one beside it.
      if (card.id === 'profile') {
        const again = el('button', 'btn btn-ghost home-card-action', 'Set up again');
        again.title = 'Add a new profile, or update one you already have.';
        again.onclick = (e) => {
          e?.stopPropagation?.();
          onSetupAgain?.();
        };
        head.appendChild(again);
      }
      node.appendChild(head);
      if (card.line) node.appendChild(el('div', 'home-card-line', card.line));
      if (card.note) node.appendChild(el('div', 'home-card-note', card.note));
      if (card.id !== 'profile') node.onclick = () => onCard?.(card.id);
      grid.appendChild(node);
    }
    container.appendChild(grid);
  }

  function render(state) {
    lastState = state;
    container.innerHTML = '';
    listEl = null;
    // Nothing left to expand once the item is ticked, and a failure from an
    // earlier attempt has been answered by the install that succeeded.
    // A finished checklist takes the whole list with it, so nothing stays open
    // behind the status cards.
    if (state.done) {
      expanded = null;
      failure = null;
    }
    if (state.done) renderCards(state);
    else renderChecklist(state);
  }

  return { render };
}

// Home's own header (logo, name and a status line) sits above the body this
// view renders. While the checklist is on screen its welcome heading already
// does that job, and two titles stacked read as one too many, so the header
// only shows once setup is done — where its line, "Everything is set up",
// says something the cards do not.
export function applyHomeHeader(root, { done } = {}) {
  const header = root?.getElementById?.('home-header');
  if (header) header.classList.toggle('hidden', !done);
  const sub = root?.getElementById?.('home-subtitle');
  if (sub) sub.textContent = done ? 'Everything is set up. Here is how things stand.' : '';
}
