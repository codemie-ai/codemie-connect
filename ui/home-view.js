// The Home body (#home-body): the onboarding checklist until nothing is left
// to tick, then the three status cards. One screen, two states, no "finish".
//
// The checklist is the app's step list on its own steps-ui instance (the
// module-level default belongs to the legacy install engine, guided setup and
// Health have their own). Pure DOM apart from that instance, which is injected,
// so node:test drives it with a recording stand-in.
import { StepStatus, makeStep } from './models.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createHomeView(container, { stepsUi, onItem, onSignIn, onCard, onSetupAgain } = {}) {
  let listEl = null;

  function renderChecklist({ items }) {
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
    if (signIn && signIn.status !== StepStatus.COMPLETE && signInRow) {
      const control = el('div', 'home-signin');
      const btn = el('button', 'btn btn-accent', 'Sign in');
      btn.onclick = (e) => {
        e?.stopPropagation?.();
        onSignIn?.();
      };
      control.append(btn, el('span', 'home-signin-hint', 'opens your browser'));
      signInRow.appendChild(control);
    }

    listEl.onclick = (e) => {
      const row = e?.target?.closest?.('.step-row');
      if (!row || row.dataset.id === 'sign-in') return;
      onItem?.(row.dataset.id);
    };
  }

  function renderCards({ cards }) {
    const grid = el('section', 'home-cards');
    for (const card of cards) {
      const node = el('div', `home-card home-card-${card.badge.tone}`);
      node.dataset.card = card.id;
      const head = el('div', 'home-card-head');
      head.append(el('span', 'home-card-title', card.title), el('span', `home-card-badge tone-${card.badge.tone}`, card.badge.text));
      node.appendChild(head);
      if (card.line) node.appendChild(el('div', 'home-card-line', card.line));
      if (card.note) node.appendChild(el('div', 'home-card-note', card.note));
      if (card.id === 'profile') {
        const again = el('button', 'btn btn-ghost home-card-action', 'Run setup again');
        again.onclick = (e) => {
          e?.stopPropagation?.();
          onSetupAgain?.();
        };
        node.appendChild(again);
      } else {
        node.onclick = () => onCard?.(card.id);
      }
      grid.appendChild(node);
    }
    container.appendChild(grid);
  }

  function render(state) {
    container.innerHTML = '';
    listEl = null;
    if (state.done) renderCards(state);
    else renderChecklist(state);
  }

  return { render };
}
