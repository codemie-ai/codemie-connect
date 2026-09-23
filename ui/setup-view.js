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
import { detectFailure } from './setup-parse.js';
import { renderFailurePanel as renderPanel } from './failure-panel.js';
// The option-card control is shared with Home's checklist; see ui/option-cards.js.
import { makeCardGroup } from './option-cards.js';

// Ids the real driver answers itself (setup-driver.js's AUTO_CONFIRM table)
// and must never be rendered as rows, even if a misbehaving caller (a test
// fake, a future driver bug) calls onPrompt with one anyway. The answer
// mirrors the driver's own fixed policy (activate: yes) so a run that somehow
// reached here would still end up with the profile active. `gate`, the CLI's
// add-or-update question, used to be here too; the user answers it now.
const NEVER_RENDERED_PROMPT_IDS = new Set(['activate']);

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

// inquirer renders an open password prompt without a mask as
// "? AWS Secret Access Key: [input is hidden]" (vendored
// inquirer/lib/prompts/password.js:71-77); the marker is part of the message
// the driver hands over and must never become part of a title.
const HIDDEN_INPUT_MARKER = /\s*\[input is hidden\]\s*$/;

// The parser cannot tell a secret from any other catch-all input, but the
// question can: the CLI's own secret prompts all say key, secret, password or
// token (litellm.setup-steps.js:29, bedrock.setup-steps.js:163-169), or carry
// inquirer's hidden-input marker. Base URLs, regions and names do not match.
export function isSecretPrompt(message) {
  return HIDDEN_INPUT_MARKER.test(message || '') || /\b(?:api[ -]?key|key|secret|password|token|passphrase)\b/i.test(message || '');
}

// The collapsed line for a secret: the last four characters behind a mask
// ("••••4f2a"), the way the wireframe draws a key, so the user can tell which
// key went in while the value itself never reaches the page. Only the end is
// shown -- some secrets are random from the first character (AWS secret keys).
// A value shorter than eight characters shows none of itself.
export function maskSecret(value) {
  const text = String(value ?? '');
  if (text === '') return '';
  return text.length >= 8 ? `••••${text.slice(-4)}` : '••••';
}

// Derives a row title and pre-fill default from a driver prompt message.
// "CodeMie organization URL: (https://codemie.lab.epam.com)" ->
//   { title: "CodeMie organization URL", defaultValue: "https://codemie.lab.epam.com" }
// "API key:" -> { title: "API key", defaultValue: "" }
export function deriveRowTitle(message) {
  const raw = message || '';
  const hintMatch = raw.match(DEFAULT_HINT);
  const defaultValue = hintMatch ? hintMatch[0].replace(/^\s*\(/, '').replace(/\)\s*$/, '') : '';
  const withoutHint = stripHint(raw).replace(HIDDEN_INPUT_MARKER, '');
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
  gate: {
    heading: 'Add a new profile or update one?',
    helper: 'Updating changes one of your profiles in place. Adding one leaves the others as they are.',
    collapsedLabel: 'Profile',
  },
  updateProfile: { heading: 'Which profile should be updated?', collapsedLabel: 'Profile to update' },
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

// How long a finished setup shows "Setup complete" before going back to Home.
const DONE_DELAY_MS = 1800;

// More options than this and the list scrolls inside its own box.
const LONG_LIST = 6;

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
  // A long list (41 models on a CodeMie account) scrolls in its own box so
  // the page stays short and Continue stays under it, not at the bottom of a
  // long page.
  let cardHost = control;
  if (cards.length > LONG_LIST) {
    cardHost = document.createElement('div');
    cardHost.className = 'setup-option-scroll';
    control.appendChild(cardHost);
  }
  const group = makeCardGroup(cardHost, `${prompt.rowId}-choice`, cards);
  control.appendChild(makeContinueButton(() => {
    const index = group.selectedIndex();
    submit(index, cards[index].title);
  }));
  host.appendChild(control);
}

function renderInputControl(host, prompt, submit) {
  const control = document.createElement('div');
  control.className = 'prompt-control';
  const secret = isSecretPrompt(prompt.message);
  const input = document.createElement('input');
  // A secret is masked while typed and only its last four characters are
  // written back into the row (maskSecret): the CLI hides these itself, and the
  // collapsed line is permanent.
  input.type = secret ? 'password' : 'text';
  input.className = 'prompt-input';
  if (secret) input.autocomplete = 'off';
  const { defaultValue } = deriveRowTitle(prompt.message);
  if (defaultValue && !secret) input.value = defaultValue;
  control.appendChild(input);
  control.appendChild(makeContinueButton(() => {
    const typed = input.value ?? '';
    // An empty line is the CLI's default (inquirer input.js:69-71). Answer with
    // that default explicitly, so the value reported, shown and verified is the
    // one the CLI saves. Whitespace is a real answer the CLI validates.
    const value = typed === '' && defaultValue && !secret ? defaultValue : typed;
    submit(value, secret ? maskSecret(value) : value);
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
  // Most recently submitted value per prompt id -- a data-capture point for
  // EPMCDME-14656 (replay/step-revisit) to build on later. Nothing in this
  // file reads it; held in memory only, never replayed or persisted here.
  const answeredValues = new Map();
  // The first ask's full message per prompt id, default hint included. A
  // reopened row builds its control from this, not from the re-ask: the re-ask
  // carries the rejected value instead of the hint (inquirer base.js:157-160).
  const firstAskByPromptId = new Map();

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
  // The failure currently visible on screen, by id, or null. The anchor line
  // stays up after the CLI moves on, so acting on every screen that still shows
  // it would reopen the notice over a live prompt. Acting on the transition
  // instead -- absent, then present -- fires once per occurrence and fires
  // again for a genuinely new one, without depending on where the line sits: a
  // 30-row viewport with no scrollback renumbers every row each time the CLI
  // prints, so a row index is not an identity.
  let failureOnScreen = null;

  // A failure seen on screen that nothing has rendered yet. The CLI can print
  // more after it and scroll it out of the 30-row viewport before the process
  // exits -- Ollama prints its whole install guide -- so by the time the
  // rejection arrives, its `raw` screen no longer carries the anchor. Measured
  // 2026-09-15: without this, "Ollama is not running" came through as a bare
  // "setup exited with code 1". Recoverable failures are rendered as they are
  // seen and never wait here.
  let pendingFailure = null;

  // The CLI's own browser-sign-in line (sso.auth.js:98). The wait that follows
  // is the user's: the CLI sits on a local callback server until the browser
  // comes back, up to its own 120s timeout. Saying nothing for two minutes reads
  // as a hang, so the row says what it is waiting for. The CLI also prints the
  // URL to visit if the tab never opened; that line is in the transcript the
  // failure panel shows, so it is not repeated here.
  const BROWSER_OPENED = /Opening browser for authentication/;
  let waitingForSignIn = false;

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
  const cancelSetupFn = deps.cancelSetup ?? (async (...args) => {
    const mod = await import('./setup-driver.js');
    return mod.cancelSetup(...args);
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
    // A failed run leaves no live control behind: the promise this row's
    // Continue would resolve is already settled, so the button would look
    // clickable and do nothing. EPMCDME-14588 puts the retry affordance here.
    const row = findRow(container, rowId);
    const host = row ? row.querySelector('.step-main') : null;
    clearControls(host);
    removeHelperText(host);
    return true;
  }

  // ---- browser sign-in wait ------------------------------------------------
  function noteSignIn(lines) {
    if (!BROWSER_OPENED.test(lines.join('\n'))) return;
    waitingForSignIn = true;
    describeSignInWait();
  }

  function describeSignInWait() {
    if (!waitingForSignIn || !transient) return;
    const titleEl = findRow(container, transient.id)?.querySelector('.step-title');
    if (titleEl) titleEl.textContent = 'Waiting for you to finish signing in';
    stepsUi.setSubtitle(transient.id, 'A browser tab should have opened for CodeMie sign-in.');
  }

  function clearSignInWait() {
    waitingForSignIn = false;
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
    // The CLI can close and reopen the gap while the browser wait is still on.
    describeSignInWait();
  }

  function hideTransientSpinner() {
    clearSignInWait();
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
      answeredValues.set(prompt.id, value);
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
    // A question lower down the page (the provider list, the model list under
    // five answered rows) opened with its Continue below the window. Scroll
    // just far enough for it to show.
    host.querySelector('.prompt-submit')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
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
        // Heading comes from storedBase, never from this re-ask's message:
        // inquirer puts the rejected value back on the question line
        // (inquirer/lib/prompts/input.js:88 `this.rl.line += value`), so the
        // live message reads "CodeMie organization URL: not-a-url". The row
        // must keep asking the original question.
        if (titleEl) titleEl.textContent = headingFor({ ...prompt, message: storedBase });
      }
      stepsUi.setStatus(rowId, StepStatus.ACTIVE);
      activeRowId = rowId;
      clearControls(host);
      removeHelperText(host);
      appendHelperText(host, prompt.id);

      const firstAsk = firstAskByPromptId.get(prompt.id) ?? prompt.message;
      return new Promise((resolve) => renderControl(host, { ...prompt, message: firstAsk }, rowId, resolve));
    }

    // New occurrence: either the first time this id is seen, or a genuinely
    // different re-ask.
    baseMessageByPromptId.set(prompt.id, stripped);
    firstAskByPromptId.set(prompt.id, prompt.message);
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
  // The run succeeded, so the CLI was not waiting on a row still open here
  // (only a misread screen leaves one): drop its control rather than leave a
  // Continue under "Setup complete" that looks clickable and does nothing.
  function releaseOpenRow() {
    if (!activeRowId) return;
    const row = findRow(container, activeRowId);
    const host = row ? row.querySelector('.step-main') : null;
    clearControls(host);
    removeHelperText(host);
    stepsUi.setStatus(activeRowId, StepStatus.SKIPPED);
    activeRowId = null;
  }

  // Returns the verified profile name, or null when the config does not show
  // it as the active profile.
  async function handleResolve(result) {
    hideTransientSpinner();
    settleInstallRow();
    releaseOpenRow();
    // The driver reports the raw answer; the CLI saves it trimmed (setup.js:501).
    const profileName = result && typeof result.profileName === 'string' ? result.profileName.trim() : '';
    // An update changes a profile in place and does not switch to it
    // (setup.js skips "Switch to profile" when isUpdate), so the active profile
    // can be another one. The configuration still has to read back as valid.
    const updated = !!(result && result.updated);
    let cfg = null;
    try {
      cfg = await readConfig();
    } catch {
      cfg = null;
    }
    const ok = !!cfg && cfg.state === 'valid' && profileName !== '' && (updated || cfg.profile === profileName);
    if (!ok) {
      markError(lastRowId);
      return null;
    }
    // Not a step (the CLI asked nothing here): a closing line under the list,
    // so the finished flow says what it achieved instead of just going quiet.
    const status = document.createElement('div');
    status.className = 'setup-view-status';
    status.textContent = updated
      ? `Setup complete. ${profileName} is updated.`
      : `Setup complete. ${profileName} is now the active profile.`;
    container.appendChild(status);
    // Setup is opened from Home (its checklist, or the Profile card's "Set up
    // again"), and Home is where the next step is, so a verified run goes back
    // there by itself -- after a moment, so the line above is seen. A failed
    // run stays, with its Try again.
    if (deps.onDone) {
      const going = document.createElement('div');
      going.className = 'setup-view-redirect';
      const spin = document.createElement('span');
      spin.className = 'inline-spinner';
      spin.setAttribute?.('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = 'Taking you back to Home…';
      going.appendChild(spin);
      going.appendChild(text);
      container.appendChild(going);
      setTimeout(() => deps.onDone(), deps.doneDelayMs ?? DONE_DELAY_MS);
    }
    return profileName;
  }

  // The driver rejected { step, message, raw }. Mark the step; the failure
  // detail and the retry are EPMCDME-14588's.
  function handleReject(err) {
    // cancelSetup()'s own rejection ({ step: null, cancelled: true, ... }) is a
    // deliberate cancel-for-retry, not a failure -- classifying or rendering it
    // would misreport a "Try again" click as the run breaking.
    if (err?.cancelled === true) return;
    const step = err && typeof err === 'object' ? err.step ?? null : null;
    // An authTimeout on the exit screen is not why the run ended: the CLI
    // recovers from it and carries on, and handleScreen already reported it,
    // but its warning line stays visible. Taking it here would title a later,
    // unrelated failure with the timeout's words. Only a failure that actually
    // ends a run counts, and pendingFailure holds exactly those.
    const onExitScreen = err && typeof err.raw === 'string' ? detectFailure(err.raw.split('\n')) : null;
    const failure = (onExitScreen?.id === 'authTimeout' ? null : onExitScreen) ?? pendingFailure;
    let converted = false;
    let rowId;
    if (step && occurrenceCounts.has(step)) {
      rowId = latestOccurrenceRowId(step);
      markError(rowId);
    } else if (step === 'model' || step === 'updateProfile') {
      // Rejected from inside the driver's list walk, before the prompt ever
      // reached onPrompt: there is no row to mark yet, so add it.
      rowId = `${step}-${nextOccurrence(step)}`;
      stepsUi.insertSubStep(null, { id: rowId, title: PROMPT_COPY[step].collapsedLabel, description: '' });
      lastRowId = rowId;
      markError(rowId);
    } else if (activeRowId) {
      rowId = activeRowId;
      markError(rowId);
    } else if (transient) {
      // Failed between prompts: the "Working…" row is the only thing on
      // screen that describes where the run was, so it becomes the marker.
      rowId = transient.id;
      const row = findRow(container, rowId);
      const titleEl = row ? row.querySelector('.step-title') : null;
      if (titleEl) titleEl.textContent = 'Setup stopped';
      markError(rowId); // ERROR status also stops its spinner.
      transient = null;
      converted = true;
    } else {
      rowId = lastRowId;
      markError(rowId);
    }
    // A classified failure names its own step, so the row carries the CLI's own
    // words next to markError's terminal state.
    if (failure) stepsUi.setSubtitle(rowId, failure.message);
    // Every rejection also draws the panel: it carries the explanation, the
    // command's raw output and the way back into the flow. err is the driver's
    // { step, message, raw } on every path it raises, but an IPC-level throw can
    // reject with null or a bare string, and reading .message off that would
    // turn a handled failure into a crash.
    renderFailurePanel({
      id: failure?.id,
      cliMessage: failure?.message ?? err?.message ?? 'Setup failed',
      // A held failure carries the screen that showed it; the rejection's own
      // screen can have scrolled past it. Only pendingFailure has `screen`, so
      // this picks the held one when that is where the classification came from.
      raw: (failure?.screen ?? err?.raw) ?? '',
    });
    settleInstallRow();
    activeRowId = null;
    if (!converted) hideTransientSpinner();
  }

  // The flow-stopping notice: the CLI's own reason plus its raw screen,
  // appended inside the notice body itself (never a separate widget), with
  // "Try again" ending the current run via cancelSetup() -- fully awaited,
  // so two `codemie setup` processes are never alive at once -- before
  // starting a fresh one.
  //
  // `key` marks one occurrence (by failure id + the screen line its anchor sat
  // on) as already shown, so a later, unrelated failure in the same run still
  // gets its own notice instead of being swallowed by a run-wide latch. A
  // rejection passes none, since it can only land once per run and must never
  // be suppressed by an earlier notice.
  // Two shapes, because two kinds of failure reach here. A rejection has ended
  // the run, so its notice offers "Try again", which ends the run via
  // cancelSetup() -- fully awaited, so two `codemie setup` processes are never
  // alive at once -- before starting a fresh one. A `recoverable` failure has
  // not: the CLI warns and asks again by itself (an unreachable CodeMie re-asks
  // the organization URL) and the driver dispatches that re-ask, so the step
  // under the notice is live. Cancelling there would kill a run that was about
  // to work, so that notice only reports, and its button returns the user to
  // the step still waiting for them.
  // Copy is ours and names the failure and what to do about it -- "NAMED, NOT
  // GENERIC", as the wireframe puts it -- with the CLI's own sentence kept
  // underneath, and the transcript behind "Show details". The panel itself is
  // ui/failure-panel.js, shared with every other screen that reports a failure.
  const FAILURE_COPY = {
    authTimeout: {
      title: 'Could not reach CodeMie',
      explanation: "CodeMie's sign-in service did not answer. This is usually the VPN — connect to the EPAM VPN and try again. It is not a problem with your account or your password.",
    },
    ollamaDown: {
      title: 'Ollama is not running',
      explanation: 'Setup needs Ollama running on this computer. Start it, then try again. Nothing has been saved.',
    },
  };
  const FAILURE_FALLBACK = {
    title: 'Setup stopped',
    explanation: 'The setup command stopped before it finished. Nothing has been saved.',
  };

  // `recoverable` decides what "Try again" does, not what it says. When the CLI
  // has carried on and is asking again underneath, trying again means answering
  // that live step, so the panel only steps out of the way; cancelling there
  // would kill a run that was about to work. When the run has ended, it ends the
  // old one -- fully awaited -- and starts a fresh one.
  function renderFailurePanel({ id, cliMessage, raw, recoverable = false }) {
    const copy = FAILURE_COPY[id] ?? FAILURE_FALLBACK;
    renderPanel(container, {
      title: copy.title,
      explanation: copy.explanation,
      detail: cliMessage,
      raw,
      command: 'codemie setup',
      primaryLabel: 'Try again',
      onPrimary: recoverable
        ? (block) => { block.remove(); }
        : async (block) => { block.remove(); await cancelSetupFn(); start(); },
    });
  }

  // Proactive authTimeout detection off Task 3's onScreen(lines) callback --
  // the settled, ANSI-free screen, never onLog's raw text. The CLI's own flow
  // continues past this warning, so it never reaches onPrompt/handleReject;
  // this is the only path that ever sees it.
  function handleScreen(lines) {
    noteSignIn(lines);
    const failure = detectFailure(lines);
    if (!failure) {
      failureOnScreen = null;
      return;
    }
    const isNewOccurrence = failure.id !== failureOnScreen;
    failureOnScreen = failure.id;
    if (!isNewOccurrence) return;
    if (failure.id !== 'authTimeout') {
      // Not recoverable: the CLI is about to exit and its remediation text may
      // scroll this off the screen first, so hold it -- and the screen that
      // still showed it -- for handleReject.
      pendingFailure = { ...failure, screen: lines.join('\n') };
      return;
    }
    // Recoverable: the CLI carries on and re-asks the organization URL, and the
    // driver dispatches that re-ask, so the run is still live underneath.
    renderFailurePanel({
      id: failure.id,
      cliMessage: failure.message,
      raw: lines.join('\n'),
      recoverable: true,
    });
  }

  // Resolves { ok, profileName } on a verified profile, { ok: false, error }
  // otherwise. Never rejects: the rows already show the outcome, and
  // EPMCDME-14588 reads `error` (the driver's { step, message, raw }) from
  // here to build the failure UI.
  //
  // One run at a time per view: a second start() while one is in flight
  // (only reachable from the dev console today) returns that run's promise
  // instead of resetting the rows and state out from under it.
  let inFlight = null;
  function start() {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function run() {
    // Every start() is a fresh run (EPMCDME-14588 retries by calling it
    // again): forget the previous run's rows, ids and reopen bases, or the
    // next provider prompt would be taken for a reopen of a row that is gone.
    occurrenceCounts.clear();
    baseMessageByPromptId.clear();
    firstAskByPromptId.clear();
    activeRowId = null;
    lastRowId = null;
    transient = null;
    transientSeq = 0;
    install = null;
    failureOnScreen = null;
    pendingFailure = null;
    // A retry re-answers every prompt from the top, so last run's values must
    // not linger: EPMCDME-14656's replay would otherwise read a mix of two runs.
    answeredValues.clear();
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
      result = await startSetup({ onPrompt, onLog, onScreen: handleScreen });
    } catch (err) {
      handleReject(err);
      return { ok: false, error: err };
    }
    const verified = await handleResolve(result);
    if (verified === null) {
      return {
        ok: false,
        error: {
          step: null,
          message: result && result.updated ? 'the configuration did not read back after the update' : 'the created profile is not the active one',
          raw: '',
        },
      };
    }
    return { ok: true, profileName: verified };
  }

  return { start, getAnsweredValues: () => new Map(answeredValues) };
}
