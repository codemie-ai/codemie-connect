// Guided setup view. Glues ui/setup-driver.js's headless prompt/answer
// contract to ui/steps-ui.js's step-list row renderer: every prompt the
// driver surfaces via onPrompt becomes a row with a control matching the
// prompt's kind, and answering the control resolves the prompt.
//
// This module must never statically top-level-import anything that touches
// window/Tauri globals (./setup-driver.js, ./runner-bridge.js) -- both are
// injected `deps` fields, lazily defaulted via dynamic import() inside
// function bodies, so importing this module never touches `window` and it
// stays testable headlessly. ./steps-ui.js and ./models.js are pure
// data/DOM-builder modules with no Tauri/window dependency, so those are
// safe to import statically.
import { createStepsUi } from './steps-ui.js';
import { StepStatus } from './models.js';

// Ids the real driver answers itself (setup-driver.js's AUTO_LIST/
// AUTO_CONFIRM tables) and must never be rendered as rows, even if a
// misbehaving caller (a test fake, a future driver bug) calls onPrompt with
// one of them anyway.
const NEVER_RENDERED_PROMPT_IDS = new Set(['gate', 'activate']);

function findRow(container, id) {
  const kids = container.children ?? [];
  for (const child of kids) {
    if (child && child.dataset && child.dataset.id === id) return child;
  }
  return null;
}

function findControlHost(container, rowId) {
  const row = findRow(container, rowId);
  if (!row) return null;
  return row.querySelector('.step-main');
}

function renderListControl(host, prompt, submit) {
  const control = document.createElement('div');
  control.className = 'prompt-control';
  const radios = [];
  prompt.options.forEach((label, index) => {
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `${prompt.rowId}-choice`;
    radio.value = String(index);
    radios.push(radio);
    const text = document.createElement('span');
    text.className = 'prompt-option-label';
    text.textContent = label;
    control.appendChild(radio);
    control.appendChild(text);
  });
  const btn = document.createElement('button');
  btn.className = 'prompt-submit';
  btn.textContent = 'Continue';
  btn.onclick = () => {
    const chosen = radios.findIndex((r) => r.checked);
    const index = chosen === -1 ? 0 : chosen;
    submit(index, prompt.options[index]);
  };
  control.appendChild(btn);
  host.appendChild(control);
}

function renderInputControl(host, prompt, submit) {
  const control = document.createElement('div');
  control.className = 'prompt-control';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'prompt-input';
  control.appendChild(input);
  const btn = document.createElement('button');
  btn.className = 'prompt-submit';
  btn.textContent = 'Continue';
  btn.onclick = () => {
    const value = input.value ?? '';
    submit(value, value);
  };
  control.appendChild(btn);
  host.appendChild(control);
}

function renderConfirmControl(host, prompt, submit) {
  const control = document.createElement('div');
  control.className = 'prompt-control';

  const yesLabel = document.createElement('span');
  yesLabel.className = 'prompt-option-label';
  yesLabel.textContent = 'Yes';
  const yes = document.createElement('input');
  yes.type = 'radio';
  yes.name = `${prompt.rowId}-confirm`;
  yes.value = 'yes';
  yes.checked = true; // CLI default is Yes ("(Y/n)"); pre-select it.

  const noLabel = document.createElement('span');
  noLabel.className = 'prompt-option-label';
  noLabel.textContent = 'No';
  const no = document.createElement('input');
  no.type = 'radio';
  no.name = `${prompt.rowId}-confirm`;
  no.value = 'no';

  control.appendChild(yes);
  control.appendChild(yesLabel);
  control.appendChild(no);
  control.appendChild(noLabel);

  const btn = document.createElement('button');
  btn.className = 'prompt-submit';
  btn.textContent = 'Continue';
  btn.onclick = () => {
    const answer = !no.checked; // Yes wins unless No was explicitly picked.
    submit(answer, answer ? 'Yes' : 'No');
  };
  control.appendChild(btn);
  host.appendChild(control);
}

export function createSetupView(container, deps = {}) {
  const stepsUi = createStepsUi();
  const occurrenceCounts = new Map();

  // Lazy-default wiring per this file's own header comment: never resolved
  // (and never imports the underlying module) until actually invoked.
  const startSetup = deps.startSetup ?? (async (...args) => {
    const mod = await import('./setup-driver.js');
    return mod.startSetup(...args);
  });
  // Not called anywhere in this task (Task 7 wires it up); present here only
  // to establish the same lazy-default shape as startSetup above.
  const readConfig = deps.readConfig ?? (async (...args) => {
    const mod = await import('./runner-bridge.js');
    return mod.codemieConfig.read(...args);
  });
  void readConfig;

  function nextOccurrence(promptId) {
    const n = (occurrenceCounts.get(promptId) || 0) + 1;
    occurrenceCounts.set(promptId, n);
    return n;
  }

  function onPrompt(prompt) {
    if (NEVER_RENDERED_PROMPT_IDS.has(prompt.id)) {
      // The real driver already answers these itself and never calls the
      // real onPrompt for them; this guard only matters for a misbehaving
      // fake driver in a test. Resolve immediately with a harmless default
      // so nothing hangs waiting on a row that must never render.
      if (prompt.kind === 'confirm') return Promise.resolve(false);
      if (prompt.kind === 'list') return Promise.resolve(0);
      return Promise.resolve('');
    }

    const occurrence = nextOccurrence(prompt.id);
    const rowId = `${prompt.id}-${occurrence}`;

    stepsUi.insertSubStep(null, { id: rowId, title: prompt.message || prompt.id, description: '' });
    stepsUi.setStatus(rowId, StepStatus.ACTIVE);

    const host = findControlHost(container, rowId);

    return new Promise((resolve) => {
      function submit(value, humanText) {
        stepsUi.setStatus(rowId, StepStatus.COMPLETE);
        stepsUi.setSubtitle(rowId, humanText);
        resolve(value);
      }

      const promptWithRowId = { ...prompt, rowId };
      if (!host) {
        // Should never happen (insertSubStep above always creates the row);
        // guard against a silent hang rather than an uncontrolled render.
        return;
      }
      if (prompt.kind === 'list') renderListControl(host, promptWithRowId, submit);
      else if (prompt.kind === 'input') renderInputControl(host, promptWithRowId, submit);
      else if (prompt.kind === 'confirm') renderConfirmControl(host, promptWithRowId, submit);
    });
  }

  async function start() {
    stepsUi.renderSteps(container, []);

    // Storage is a fixed-policy choice (setup-driver.js's AUTO_LIST always
    // picks "global") -- render it as an already-decided, collapsed row
    // before the driver ever runs, never through onPrompt.
    stepsUi.insertSubStep(null, { id: 'storage', title: 'Where to store it', description: '' });
    stepsUi.setStatus('storage', StepStatus.COMPLETE);
    stepsUi.setSubtitle('storage', 'This computer');

    try {
      await startSetup({ onPrompt, onLog: () => {} });
    } catch {
      // Resolution/rejection UI is Task 7's job; Task 1 just avoids an
      // unhandled rejection escaping start().
    }
  }

  return { start };
}
