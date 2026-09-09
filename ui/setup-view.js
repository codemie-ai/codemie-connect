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

// Independently re-declared from ui/setup-driver.js:108's DEFAULT_HINT --
// this file must not import setup-driver.js at module scope (see header
// comment above), so the pattern is duplicated here on purpose.
const DEFAULT_HINT = /\s*\([^()]*\)\s*$/;

// Strips a trailing " (default hint)" suffix, if present. Used both by
// deriveRowTitle (further stripped of a trailing colon there) and by the
// reopen-vs-new-row comparison in onPrompt, which needs the hint gone but
// the colon intact to recognize a re-ask that appends rejected input after
// the original question.
export function stripHint(message) {
  return (message || '').replace(DEFAULT_HINT, '');
}

// Derives a row title and pre-fill default from a driver prompt message.
// "CodeMie organization URL: (https://codemie.lab.epam.com)" ->
//   { title: "CodeMie organization URL", defaultValue: "https://codemie.lab.epam.com" }
// "API key:" -> { title: "API key", defaultValue: "" }
export function deriveRowTitle(message) {
  const raw = message || '';
  const hintMatch = raw.match(DEFAULT_HINT);
  const defaultValue = hintMatch ? hintMatch[0].replace(/^\s*\(/, '').replace(/\)\s*$/, '') : '';
  const withoutHint = stripHint(raw);
  const title = withoutHint.replace(/\s*:\s*$/, '');
  return { title, defaultValue };
}

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
  const { defaultValue } = deriveRowTitle(prompt.message);
  if (defaultValue) input.value = defaultValue;
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
  // Holds the hint-stripped, original-ask message for each prompt id, used
  // to recognize a reopen (a re-ask after validation rejected the previous
  // answer) vs. a genuinely new occurrence. Never overwritten by a
  // recognized reopen -- only set the first time an id is seen, or when a
  // genuinely different message arrives for that id.
  const baseMessageByPromptId = new Map();

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

  function latestOccurrenceRowId(promptId) {
    const n = occurrenceCounts.get(promptId);
    return n ? `${promptId}-${n}` : null;
  }

  function rowTitleFor(prompt) {
    if (prompt.kind === 'input') return deriveRowTitle(prompt.message).title;
    return prompt.message || prompt.id;
  }

  function clearControls(host) {
    if (!host) return;
    for (const child of [...host.children]) {
      if (child && child.className === 'prompt-control') child.remove();
    }
  }

  function renderControl(host, prompt, rowId, resolve) {
    function submit(value, humanText) {
      stepsUi.setStatus(rowId, StepStatus.COMPLETE);
      stepsUi.setSubtitle(rowId, humanText);
      resolve(value);
    }

    const promptWithRowId = { ...prompt, rowId };
    if (!host) {
      // Should never happen (the row always exists by the time this runs);
      // guard against a silent hang rather than an uncontrolled render.
      return;
    }
    if (prompt.kind === 'list') renderListControl(host, promptWithRowId, submit);
    else if (prompt.kind === 'input') renderInputControl(host, promptWithRowId, submit);
    else if (prompt.kind === 'confirm') renderConfirmControl(host, promptWithRowId, submit);
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

    const stripped = stripHint(prompt.message);
    const storedBase = baseMessageByPromptId.get(prompt.id);
    const isReopen = storedBase !== undefined && (stripped === storedBase || stripped.startsWith(storedBase));

    if (isReopen) {
      // Same question being re-asked (e.g. after a validation failure):
      // reopen the existing row for this id instead of inserting a new one.
      // storedBase is intentionally left unchanged so a third, fourth, etc.
      // rejection still compares against the original first-ask question.
      const rowId = latestOccurrenceRowId(prompt.id);
      const row = findRow(container, rowId);
      const host = row ? row.querySelector('.step-main') : null;
      const subEl = row ? row.querySelector('.step-sub') : null;
      if (subEl) subEl.textContent = ''; // bypass setSubtitle, which ignores empty strings.
      stepsUi.setStatus(rowId, StepStatus.ACTIVE);
      clearControls(host);

      return new Promise((resolve) => renderControl(host, prompt, rowId, resolve));
    }

    // New occurrence: either the first time this id is seen, or a genuinely
    // different re-ask.
    baseMessageByPromptId.set(prompt.id, stripped);
    const occurrence = nextOccurrence(prompt.id);
    const rowId = `${prompt.id}-${occurrence}`;

    stepsUi.insertSubStep(null, { id: rowId, title: rowTitleFor(prompt), description: '' });
    stepsUi.setStatus(rowId, StepStatus.ACTIVE);

    const host = findControlHost(container, rowId);

    return new Promise((resolve) => renderControl(host, prompt, rowId, resolve));
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
