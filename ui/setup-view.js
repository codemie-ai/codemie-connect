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
// one of them anyway. The answers mirror the driver's own fixed policy
// (storage: first "global" option; activate: yes) so a run that somehow
// reached here would still end up with the profile active.
const NEVER_RENDERED_PROMPT_IDS = new Set(['gate', 'activate']);

// Independently re-declared from ui/setup-driver.js:108's DEFAULT_HINT --
// this file must not import setup-driver.js at module scope (see header
// comment above), so the pattern is duplicated here on purpose.
const DEFAULT_HINT = /\s*\([^()]*\)\s*$/;

// The bundled CLI's own install lines (cli/commands/setup.js:728 and :737).
// The version suffix is conditional there, so it is optional here too. onLog
// hands over the raw PTY chunk text; chalk and ora wrap each line in colour
// codes as a whole, so the codes sit around these phrases, never inside them,
// and a plain match on the raw text is enough.
const INSTALL_OK = /Claude Code(?:\s+(v\S+))?\s+installed successfully/;
const INSTALL_FAILED = /Failed to install Claude Code/;
// Keep only this much of the accumulated log; every phrase above is far
// shorter, so a chunk boundary inside one can never fall off the buffer.
const INSTALL_LOG_KEEP = 4000;

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

// Wireframe-named-step copy overrides. Checked BEFORE falling back to
// deriveRowTitle/raw-message title derivation -- an override, never a
// takeover: any prompt id absent from this table (codemieUrl, credential,
// any other) keeps the general rowTitleFor()-derived title untouched.
//
// - `heading`/`helper` describe the OPEN (ACTIVE) row: heading replaces the
//   row's title, helper is new copy shown only while the row is open.
// - `collapsedLabel` replaces the row's title the moment it reaches
//   COMPLETE (the wireframe's "label -- value" collapsed shape); ids with no
//   collapsedLabel keep whatever heading/derived title they already show.
export const PROMPT_COPY = {
  provider: {
    heading: 'How should CodeMie reach a model?',
    helper: 'You can change this later.',
    collapsedLabel: 'How to reach a model',
  },
  codemieProject: { collapsedLabel: 'CodeMie project' },
  model: {
    heading: 'Which model?',
    helper: 'These are the models your account can use.',
    collapsedLabel: 'Model',
  },
  profileName: { heading: 'Profile name', collapsedLabel: 'Profile name' },
  installClaude: { collapsedLabel: 'Claude Code' },
};

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

// Splits a single already-parsed option string (setup-parse.js's parseOptions
// has already stripped the cursor marker and trimmed whitespace -- this
// module never sees raw terminal lines) into a { title, description,
// recommended } card descriptor.
//
// - A leading "⭐ " star marker is stripped from the string before the
//   " - " split, and remembered as `starred`.
// - The remainder is split at the FIRST literal " - " (indexOf, not a
//   regex, to keep "first occurrence" unambiguous): everything before is
//   the title, everything after is the description. No " - " means the
//   whole remainder is the title and description is ''.
// - `recommended` is index-based (`index === badgeIndex`) when `badgeIndex`
//   is a defined number -- the `provider` list's fixed-position badge,
//   ignoring the star entirely -- and star-based (`starred`) otherwise --
//   every other list, including `model`, whose recommended entry is
//   whichever one the CLI starred, not a fixed index.
export function renderOptionCards(options, { badgeIndex } = {}) {
  const useIndexBadge = typeof badgeIndex === 'number';
  return options.map((option, index) => {
    const starMatch = option.match(/^⭐\s*/);
    const starred = !!starMatch;
    const remainder = starred ? option.slice(starMatch[0].length) : option;
    const idx = remainder.indexOf(' - ');
    const title = idx === -1 ? remainder : remainder.slice(0, idx);
    const description = idx === -1 ? '' : remainder.slice(idx + 3);
    const recommended = useIndexBadge ? index === badgeIndex : starred;
    return { title, description, recommended };
  });
}

// One selectable card, the wireframe's option shape: the radio stays in the DOM as
// the single source of truth for what is chosen (and for assistive tech), the
// card itself is what the user sees and clicks.
function makeCard({ title, description, recommended, name, value }) {
  const card = document.createElement('div');
  card.className = 'setup-option-card' + (recommended ? ' recommended' : '');

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = name;
  radio.value = value;
  card.appendChild(radio);

  // title/description come straight from the CLI's own driver-supplied
  // option strings -- always rendered via .textContent, never innerHTML.
  const titleEl = document.createElement('div');
  titleEl.className = 'setup-option-title';
  titleEl.textContent = title;
  card.appendChild(titleEl);

  if (description) {
    const descEl = document.createElement('div');
    descEl.className = 'setup-option-description';
    descEl.textContent = description;
    card.appendChild(descEl);
  }

  if (recommended) {
    const badge = document.createElement('span');
    badge.className = 'setup-option-badge';
    badge.textContent = 'Recommended'; // static UI copy, not driver-supplied text.
    card.appendChild(badge);
  }
  return { card, radio };
}

// A group of cards where exactly one is selected; select(i) keeps the radios
// and the visual state in step, and the first card starts selected.
function makeCardGroup(control, name, items) {
  const radios = [];
  const cardEls = [];
  function select(index) {
    radios.forEach((r, i) => { r.checked = i === index; });
    cardEls.forEach((c, i) => c.classList.toggle('selected', i === index));
  }
  items.forEach((item, index) => {
    const { card, radio } = makeCard({ ...item, name, value: String(index) });
    // Clicking anywhere on the card selects it -- the radio input remains
    // the single source of truth Continue reads from on submit.
    card.onclick = () => select(index);
    radios.push(radio);
    cardEls.push(card);
    control.appendChild(card);
  });
  if (radios.length) select(0);
  return {
    selectedIndex: () => {
      const chosen = radios.findIndex((r) => r.checked);
      return chosen === -1 ? 0 : chosen;
    },
  };
}

function makeContinueButton(onClick) {
  const btn = document.createElement('button');
  btn.className = 'prompt-submit';
  btn.classList.toggle('setup-continue-btn', true);
  btn.textContent = 'Continue';
  btn.onclick = onClick;
  return btn;
}

function renderListControl(host, prompt, submit) {
  const control = document.createElement('div');
  control.className = 'prompt-control';
  const badgeIndex = prompt.id === 'provider' ? 0 : undefined;
  const cards = renderOptionCards(prompt.options, { badgeIndex });
  // The CLI's cursor starts on the first entry (the recommended provider,
  // the starred model), so that is what Continue submits untouched. Showing
  // the selection up front keeps what is submitted equal to what is seen.
  const group = makeCardGroup(control, `${prompt.rowId}-choice`, cards);
  control.appendChild(makeContinueButton(() => {
    const index = group.selectedIndex();
    submit(index, cards[index].title);
  }));
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
  control.appendChild(makeContinueButton(() => {
    const value = input.value ?? '';
    submit(value, value);
  }));
  host.appendChild(control);
}

function renderConfirmControl(host, prompt, submit) {
  const control = document.createElement('div');
  control.className = 'prompt-control';
  // CLI default is Yes ("(Y/n)"); the first card starts selected.
  const group = makeCardGroup(control, `${prompt.rowId}-confirm`, [
    { title: 'Yes', description: '', recommended: false },
    { title: 'No', description: '', recommended: false },
  ]);
  control.appendChild(makeContinueButton(() => {
    const answer = group.selectedIndex() === 0;
    submit(answer, answer ? 'Yes' : 'No');
  }));
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

  // The row currently waiting on the user (or, for installClaude answered
  // yes, on the CLI's install). null between prompts.
  let activeRowId = null;
  // The most recently inserted row of any kind except the transient one;
  // the fallback target when a failure names nothing better.
  let lastRowId = null;
  // The generic "Working…" row shown while the CLI is between prompts.
  let transient = null;
  let transientSeq = 0;
  // installClaude answered yes: { rowId, buffer, done }. The only row that
  // reads onLog -- the CLI reports the install outcome as plain output and
  // exits normally either way, so resolution alone cannot tell success from
  // failure (cli/commands/setup.js:737-742).
  let install = null;

  // Lazy-default wiring per this file's own header comment: never resolved
  // (and never imports the underlying module) until actually invoked.
  const startSetup = deps.startSetup ?? (async (...args) => {
    const mod = await import('./setup-driver.js');
    return mod.startSetup(...args);
  });
  const readConfig = deps.readConfig ?? (async (...args) => {
    const mod = await import('./runner-bridge.js');
    return mod.codemieConfig.read(...args);
  });

  function nextOccurrence(promptId) {
    const n = (occurrenceCounts.get(promptId) || 0) + 1;
    occurrenceCounts.set(promptId, n);
    return n;
  }

  function latestOccurrenceRowId(promptId) {
    const n = occurrenceCounts.get(promptId);
    return n ? `${promptId}-${n}` : null;
  }

  // Every kind goes through deriveRowTitle: the default hint only ever
  // appears on input prompts, but list/confirm questions end in a colon
  // too ("Select your project:"), which a heading must not carry.
  function rowTitleFor(prompt) {
    return deriveRowTitle(prompt.message).title || prompt.id;
  }

  // PROMPT_COPY-aware heading for the OPEN row: an override on top of
  // rowTitleFor's general derivation, never a replacement of it -- ids with
  // no `heading` entry (or no table entry at all) keep rowTitleFor's result.
  // Shared by both the new-occurrence and reopen code paths in onPrompt.
  function headingFor(prompt) {
    const copy = PROMPT_COPY[prompt.id];
    if (copy && copy.heading) return copy.heading;
    return rowTitleFor(prompt);
  }

  function helperFor(promptId) {
    const copy = PROMPT_COPY[promptId];
    return (copy && copy.helper) || '';
  }

  function collapsedLabelFor(promptId) {
    const copy = PROMPT_COPY[promptId];
    return copy ? copy.collapsedLabel : undefined;
  }

  // Helper text describes the row while it's open (ACTIVE); it is distinct
  // from steps-ui.js's `.step-sub`, which only ever holds the answered
  // subtitle once a row is COMPLETE. A new `.step-helper` element is the
  // only way to show both without conflating them.
  function appendHelperText(host, promptId) {
    const text = helperFor(promptId);
    if (!text || !host) return;
    const helperEl = document.createElement('div');
    helperEl.className = 'step-helper';
    helperEl.textContent = text;
    host.appendChild(helperEl);
  }

  function removeHelperText(host) {
    if (!host) return;
    host.querySelector('.step-helper')?.remove();
  }

  // Collapses a row's visible title to its PROMPT_COPY collapsedLabel (if
  // any) and toggles the `collapsed` class -- shared by every control's
  // submit path and by the initial storage row, so every collapsed row
  // gets the same "label -- value" shape (styled in ui/styles.css).
  function collapseRow(rowId, promptId) {
    const row = findRow(container, rowId);
    if (!row) return;
    row.classList.toggle('collapsed', true);
    const label = collapsedLabelFor(promptId);
    if (label) {
      const titleEl = row.querySelector('.step-title');
      if (titleEl) titleEl.textContent = label;
    }
  }

  function clearControls(host) {
    if (!host) return;
    for (const child of [...host.children]) {
      if (child && child.className === 'prompt-control') child.remove();
    }
  }

  function markError(rowId) {
    if (!rowId) return false;
    stepsUi.setStatus(rowId, StepStatus.ERROR);
    return true;
  }

  // ---- transient "Working…" row -------------------------------------------
  // The CLI has no prompt on screen while it fetches models, waits for the
  // browser sign-in, saves the profile. steps-ui has no remove primitive and
  // insertSubStep dedupes on id, so every gap gets a fresh id and the old
  // element is dropped from the DOM directly.
  function showTransientSpinner() {
    if (transient) return;
    transientSeq += 1;
    const id = `working-${transientSeq}`;
    stepsUi.insertSubStep(null, { id, title: 'Working…', description: '' });
    stepsUi.setStatus(id, StepStatus.ACTIVE);
    stepsUi.startSpinner(id);
    transient = { id };
  }

  function hideTransientSpinner() {
    if (!transient) return;
    stepsUi.stopSpinner(transient.id);
    findRow(container, transient.id)?.remove();
    transient = null;
  }

  // ---- installClaude: driven by onLog, not by resolution ------------------
  function beginInstallWatch(rowId) {
    stepsUi.setSubtitle(rowId, 'Installing…');
    stepsUi.startSpinner(rowId);
    install = { rowId, buffer: '', done: false };
  }

  function finishInstall(status, subtitle) {
    if (!install || install.done) return;
    install.done = true;
    stepsUi.setStatus(install.rowId, status);
    stepsUi.setSubtitle(install.rowId, subtitle);
    collapseRow(install.rowId, 'installClaude');
    if (activeRowId === install.rowId) activeRowId = null;
  }

  function onLog(text) {
    if (!install || install.done) return;
    install.buffer = (install.buffer + String(text ?? '')).slice(-INSTALL_LOG_KEEP);
    const ok = install.buffer.match(INSTALL_OK);
    if (ok) {
      finishInstall(StepStatus.COMPLETE, ok[1] || 'Installed');
      return;
    }
    if (INSTALL_FAILED.test(install.buffer)) finishInstall(StepStatus.ERROR, 'Install failed');
  }

  // Safety net: the run settled while the install row was still waiting on
  // a line that never came. Never leave it spinning with no terminal state.
  function settleInstallRow() {
    if (install && !install.done) finishInstall(StepStatus.ERROR, 'Not confirmed');
  }

  function renderControl(host, prompt, rowId, resolve) {
    function submit(value, humanText) {
      clearControls(host);
      removeHelperText(host);
      activeRowId = null;
      if (prompt.id === 'installClaude' && value === true) {
        // The install that follows arrives as ordinary CLI output with no
        // further prompt; this row's own spinner covers that gap, so no
        // transient row here.
        activeRowId = rowId;
        beginInstallWatch(rowId);
      } else {
        const text = prompt.id === 'installClaude' && value === false ? 'Skipped' : humanText;
        stepsUi.setStatus(rowId, StepStatus.COMPLETE);
        stepsUi.setSubtitle(rowId, text);
        collapseRow(rowId, prompt.id);
        showTransientSpinner();
      }
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
      // fake driver in a test. Answer with the driver's own policy so
      // nothing hangs waiting on a row that must never render.
      if (prompt.kind === 'confirm') return Promise.resolve(true);
      if (prompt.kind === 'list') return Promise.resolve(0);
      return Promise.resolve('');
    }

    hideTransientSpinner();

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
      if (row) {
        // Reopening (a validation-rejected re-ask) un-collapses the row and
        // restores the OPEN-row heading -- a prior submit may have swapped
        // the title to a collapsedLabel via collapseRow().
        row.classList.toggle('collapsed', false);
        const titleEl = row.querySelector('.step-title');
        if (titleEl) titleEl.textContent = headingFor(prompt);
      }
      stepsUi.setStatus(rowId, StepStatus.ACTIVE);
      activeRowId = rowId;
      clearControls(host);
      removeHelperText(host);
      appendHelperText(host, prompt.id);

      return new Promise((resolve) => renderControl(host, prompt, rowId, resolve));
    }

    // New occurrence: either the first time this id is seen, or a genuinely
    // different re-ask.
    baseMessageByPromptId.set(prompt.id, stripped);
    const occurrence = nextOccurrence(prompt.id);
    const rowId = `${prompt.id}-${occurrence}`;

    stepsUi.insertSubStep(null, { id: rowId, title: headingFor(prompt), description: '' });
    stepsUi.setStatus(rowId, StepStatus.ACTIVE);
    activeRowId = rowId;
    lastRowId = rowId;

    const host = findControlHost(container, rowId);
    appendHelperText(host, prompt.id);

    return new Promise((resolve) => renderControl(host, prompt, rowId, resolve));
  }

  // ---- settle ---------------------------------------------------------------
  // The driver resolved { profileName }. The CLI printing success is not the
  // proof; the configuration file is: the new profile must be the active one.
  async function handleResolve(result) {
    hideTransientSpinner();
    settleInstallRow();
    const profileName = result && typeof result.profileName === 'string' ? result.profileName : '';
    let cfg = null;
    try {
      cfg = await readConfig();
    } catch {
      cfg = null;
    }
    const ok = !!cfg && cfg.state === 'valid' && profileName !== '' && cfg.profile === profileName;
    if (!ok) {
      markError(lastRowId);
      return ok;
    }
    // Not a step (the CLI asked nothing here): a closing line under the list,
    // so the finished flow says what it achieved instead of just going quiet.
    const status = document.createElement('div');
    status.className = 'setup-view-status';
    status.textContent = `Setup complete. ${profileName} is now the active profile.`;
    container.appendChild(status);
    return ok;
  }

  // The driver rejected { step, message, raw }. Mark the step; the failure
  // detail and the retry are EPMCDME-14588's.
  function handleReject(err) {
    const step = err && typeof err === 'object' ? err.step ?? null : null;
    let converted = false;
    if (step && occurrenceCounts.has(step)) {
      markError(latestOccurrenceRowId(step));
    } else if (step === 'model') {
      // Rejected from inside collectModelOptions, before the model prompt
      // ever reached onPrompt: there is no row to mark yet, so add it.
      const rowId = `model-${nextOccurrence('model')}`;
      stepsUi.insertSubStep(null, { id: rowId, title: PROMPT_COPY.model.collapsedLabel, description: '' });
      lastRowId = rowId;
      markError(rowId);
    } else if (activeRowId) {
      markError(activeRowId);
    } else if (transient) {
      // Failed between prompts: the "Working…" row is the only thing on
      // screen that describes where the run was, so it becomes the marker.
      const row = findRow(container, transient.id);
      const titleEl = row ? row.querySelector('.step-title') : null;
      if (titleEl) titleEl.textContent = 'Setup stopped';
      markError(transient.id); // ERROR status also stops its spinner.
      transient = null;
      converted = true;
    } else {
      markError(lastRowId);
    }
    settleInstallRow();
    activeRowId = null;
    if (!converted) hideTransientSpinner();
  }

  // Resolves { ok, profileName } on a verified profile, { ok: false, error }
  // otherwise. Never rejects: the rows already show the outcome, and
  // EPMCDME-14588 reads `error` (the driver's { step, message, raw }) from
  // here to build the failure UI.
  async function start() {
    // Every start() is a fresh run (EPMCDME-14588 retries by calling it
    // again): forget the previous run's rows, ids and reopen bases, or the
    // next provider prompt would be taken for a reopen of a row that is gone.
    occurrenceCounts.clear();
    baseMessageByPromptId.clear();
    activeRowId = null;
    lastRowId = null;
    transient = null;
    transientSeq = 0;
    install = null;
    stepsUi.renderSteps(container, []);

    // renderSteps just cleared `container` via innerHTML = '' -- the header
    // must be appended AFTER that call (never before it) so it survives as
    // the list's first child, ahead of every row inserted below.
    const heading = document.createElement('h1');
    heading.className = 'setup-view-heading';
    heading.textContent = 'Set up CodeMie';
    container.appendChild(heading);

    // Storage is a fixed-policy choice (setup-driver.js's AUTO_LIST always
    // picks "global") -- render it as an already-decided, collapsed row
    // before the driver ever runs, never through onPrompt.
    stepsUi.insertSubStep(null, { id: 'storage', title: 'Where to store it', description: '' });
    stepsUi.setStatus('storage', StepStatus.COMPLETE);
    stepsUi.setSubtitle('storage', 'This computer');
    collapseRow('storage', 'storage');
    lastRowId = 'storage';

    // The CLI takes a moment to reach its first prompt; never leave the
    // screen sitting on one collapsed row with nothing moving.
    showTransientSpinner();

    let result;
    try {
      result = await startSetup({ onPrompt, onLog });
    } catch (err) {
      handleReject(err);
      return { ok: false, error: err };
    }
    const ok = await handleResolve(result);
    if (!ok) {
      return {
        ok: false,
        error: { step: null, message: 'the created profile is not the active one', raw: '' },
      };
    }
    return { ok: true, profileName: result.profileName };
  }

  return { start };
}
