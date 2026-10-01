// Headless driver for `codemie setup`. Drives the CLI through a real
// (headless) xterm.js Terminal fed with the PTY's byte stream, re-parses the
// screen via ./setup-parse.js's detectPrompt after every chunk, and answers
// prompts either automatically (fixed policy) or by calling the caller's
// onPrompt. See EPMCDME-14668 plan for the full contract.
//
// setup-driver.js must never statically top-level-import anything that
// touches window/Tauri globals at module scope (./terminal.js,
// ./runner-bridge.js, ./vendor/xterm.mjs) -- all such dependencies are
// injected `deps` fields, lazily defaulted via dynamic import() inside the
// function body, so importing this module never touches `window`.

import { detectPrompt, isQ } from './setup-parse.js';

const COLS = 100;
const ROWS = 30;

// No --force: that flag skips the CLI's "add a new profile or update one"
// question, and the user answers it now. Run from /, not the home directory
// the PTY starts in: from ~ the CLI finds ~/.codemie/codemie-cli.config.json
// again as a repository-local config (config.js hasProjectConfig), announces
// "Local configuration detected", and an update saves the profile in the
// local format over the global file. / has no .codemie. `;` rather than `&&`
// so the same line runs in zsh and in Windows PowerShell 5.1, which has no
// `&&`; `cd /` goes to the root of the current drive there.
const SETUP_COMMAND = 'cd /; codemie setup';

// Unrecognized (y/N)-style prompt (e.g. the analytics-sync consent screen):
// setup-parse.js deliberately returns null for these (its own defect-fix
// guard) since answering them as 'credential' would type an API key into a
// consent question. We wait for the screen to go idle for IDLE_MS (a burst
// of CLI redraw frames lands well under 100ms apart in practice, so this
// never fires mid-redraw; it also never stalls a real run long enough to
// look hung), then accept the CLI's own displayed default -- (y/N)
// capitalizes N -- rather than rejecting the whole run over a non-essential
// question. This must only fire when detectPrompt returned null for a
// screen the idle timer has confirmed settled, and must never be used for
// credential/model/any classified prompt.
const IDLE_MS = 200;
const YN_HINT = /\([yY]\/[nN]\)\s*$/;

// Bound on how long a single arrow-key pagination step may wait for the CLI's
// redrawn PTY chunk to actually arrive and be parsed (round-3 review fix #2).
// A real xterm.js Terminal parses `write()` asynchronously, so the redraw the
// CLI sends back after an arrow-key press lands as a LATER, separate onData
// chunk -- if the CLI never redraws (a genuinely broken interaction) this
// must time out instead of hanging forever with the single-flight lock held.
// A small multiple of IDLE_MS keeps this on the same scale as the existing
// settle debounce rather than introducing an unrelated magic number.
const MODEL_STEP_REDRAW_TIMEOUT_MS = IDLE_MS * 5;

// Bound on the model-list pagination walk (CR-001). A real model catalog is
// rendered a handful of entries per screen (ROWS=30, minus a couple of
// chrome lines) -- 20x the terminal height is far beyond any realistic
// model list but still small enough that a genuine infinite loop (a
// rendering glitch that always looks "new") fails fast with a rejection
// instead of hanging the run with the module-level single-flight lock held.
const MAX_MODEL_PAGINATION_STEPS = ROWS * 20;

function translateListAnswer(fromIndex, toIndex) {
  if (toIndex === fromIndex) return '\r';
  return toIndex > fromIndex
    ? '\x1b[B'.repeat(toIndex - fromIndex) + '\r'
    : '\x1b[A'.repeat(fromIndex - toIndex) + '\r';
}

function translateConfirmAnswer(v) {
  return v ? 'y\r' : 'n\r';
}

// Fixed-policy answers, applied before ever calling onPrompt. `storage`
// always picks the global option (never "local"); `activate` is a
// confirm-kind prompt answered yes.
//
// `gate` ("What would you like to do?": add a new profile or update one) was
// fixed policy too, always "add", and the app ran `codemie setup --force`,
// which skips the question entirely. It is the user's decision now, like
// installClaude below: the question goes to onPrompt without the CLI's
// Cancel, since the setup screen has its own way out.
//
// `installClaude` was fixed-policy here too (answered no) until the story
// author ratified the open question EPMCDME-14513 carries: guided setup
// presents the same `codemie setup` decisions, and installing Claude Code is
// one of them. So it is the user's decision now and goes to onPrompt like any
// other prompt -- EPMCDME-14513 renders it. Note the CLI's own default is Yes
// ("(Y/n)"), so the rendered control should default to yes as well.
const AUTO_LIST = {
  storage: /global/i,
};

// The gate's own way out; the setup screen has a Cancel of its own.
const GATE_CANCEL = /^cancel$/i;
const AUTO_CONFIRM = { activate: true };

// inquirer renders a failed `validate` as the question line with the rejected
// input still on it, plus the error on the line directly below, prefixed '>> '
// -- see the vendored CLI's own copy at
// assets/codemie-cli/node_modules/inquirer/lib/prompts/input.js:50 (the question
// line always carries rl.line) and :59 (`colors.red('>> ') + error`), with :88
// onError putting the rejected value back into rl.line. That makes a validation
// failure indistinguishable from an answered echo on the question line alone,
// and `codemie setup` really does validate: setup.js:491 rejects an empty
// profile name and one that already exists. This marker is the only thing that
// separates them, so the echo guard consults it. If a future inquirer changes
// the marker the guard stops suppressing (a prompt answered twice) rather than
// suppressing a live prompt (a hung run), which is the safer way to be wrong.
const VALIDATION_ERROR_MARKER = /^>>/;

// inquirer appends the default hint "(value) " to an OPEN input prompt only
// (base.js:157-166 in the vendored copy) and drops it the moment the prompt is
// answered. So the open message the driver answers ("Enter a name for this
// profile: (default)") is NOT a prefix of its own echo ("Enter a name for this
// profile: myprofile"); the stable part is the question without the hint. The
// real recording shows the hint on the CodeMie URL prompt, and setup.js:490
// gives profileName a default too.
//
// "[hidden]" is deliberately NOT stripped. On a password prompt it is the
// ANSWERED echo when no mask is configured (password.js:71-74) -- bedrock's
// secret prompt is exactly that (bedrock.setup-steps.js:168, no mask), so its
// echo reads "AWS Secret Access Key: [hidden]" and must extend the question.
// base.js also uses "[hidden]" as the open-prompt hint for a password that has
// a default, where stripping would be right, but no password prompt in the
// vendored CLI carries a default, so treating it as the answer marker is the
// reading that matches every reachable screen.
const DEFAULT_HINT = /\s*\([^()]*\)\s*$/;

function stableQuestion(message) {
  return message.replace(DEFAULT_HINT, '');
}

// The error is not always on the row directly under the question. screen-
// manager.js:91 lays the screen out as question + '\n' + bottomContent, and the
// password prompt's bottomContent starts with its own '\n' (password.js:64), so
// there it lands two rows down with an empty row between. A question line that
// wraps at COLS pushes it down by the wrapped rows as well. So look through a
// small window below the question, skipping empty rows, rather than one row.
const VALIDATION_ERROR_WINDOW = 3;

// The ">>" error under the last question on screen, or null when there is none.
function validationErrorText(lines) {
  let idx = -1;
  for (let i = 0; i < lines.length; i += 1) if (isQ(lines[i])) idx = i;
  if (idx === -1) return null;
  for (let r = idx + 1; r <= idx + VALIDATION_ERROR_WINDOW && r < lines.length; r += 1) {
    const t = lines[r].trim();
    if (!t) continue;
    if (VALIDATION_ERROR_MARKER.test(t)) return t;
  }
  return null;
}

function pickAutoListIndex(options, wantRe) {
  const i = options.findIndex((o) => wantRe.test(o));
  if (i === -1) throw { step: null, message: 'expected auto-answer option not found', raw: options.join('\n') };
  return i;
}

// The `model` list can be paginated: the CLI only renders the options visible
// in the current viewport, revealing more as the cursor moves down. Walks
// arrow-down (one keystroke at a time, no trailing \r) until a step reveals
// no option this walk hasn't already seen, then walks back up the same
// number of steps to return the cursor to its starting position. Returns the
// deduplicated raw option list (Custom included) and the same list with any
// `/^custom/i` entry filtered out, for presenting to onPrompt.
// The label on the row that really carries the cursor marker under the open
// question, or undefined when no row does yet. detectPrompt cannot say: its
// selectedIndex falls back to the first row when it finds no marker, and the
// CLI repaints a list in more than one chunk, so a chunk can arrive before the
// marker row has been redrawn (measured 2026-09-23, a 41-model list read as 15).
function markedLabel(lines) {
  let q = -1;
  for (let i = 0; i < lines.length; i += 1) if (isQ(lines[i])) q = i;
  if (q === -1) return undefined;
  for (let r = q + 1; r < lines.length; r += 1) {
    const raw = lines[r];
    if (!raw.trim() || isQ(raw)) break;
    const m = raw.trimStart().match(/^[>❯]\s*(.*)$/);
    if (m) return m[1].trim() || undefined;
  }
  return undefined;
}

// Walks a paged inquirer list to its end and back, returning every option in
// the CLI's order. Used for the model list and for the profile list an update
// picks from; both show a page at a time. `step` names the prompt in errors.
async function collectListOptions(initialOptions, initialSelectedIndex, { step, initialLines = [], currentChunkSeq, waitForChunkAfter, writeArrowDown, writeArrowUp }) {
  const raw = [...initialOptions];
  let steps = 0;
  let settledPagination = false;
  let lastLines = initialLines;
  // Each press is read by where the cursor marker ends up, not by the first
  // chunk that follows it. Measured against the real CLI on 2026-09-23: the
  // chunk after an arrow key can be the tail of the list's first drawing, with
  // the marker still where it was, and reading that as the answer to the press
  // ended a 41-model walk after one step with 15 models. So a press is waited
  // on until the marker has moved to another row, or until the screen has gone
  // quiet with it unmoved.
  //
  // inquirer's lists loop by default (incrementListIndex.js: down from the last
  // entry goes to the first), so every press moves the marker: within a page,
  // or with the page scrolling under it (paginator.js keeps it mid-page), or
  // round to the top. Coming back to an entry already highlighted means the
  // walk has been all the way round. A marker that does not move at all means
  // a list that does not loop has reached its end. Either way nothing is left.
  let current = markedLabel(initialLines) ?? initialOptions[initialSelectedIndex];
  const highlighted = new Set([current]);
  while (steps < MAX_MODEL_PAGINATION_STEPS) {
    // Capture the sequence number BEFORE writing the arrow key, so a redraw
    // chunk that lands while writeArrowDown() itself is still in flight (an
    // async PTY-input round trip) is never missed by the wait below.
    let seq = currentChunkSeq();
    await writeArrowDown();
    steps += 1;
    const deadline = Date.now() + MODEL_STEP_REDRAW_TIMEOUT_MS;
    let sawChunk = false;
    let moved;
    while (moved === undefined) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      let chunk;
      try {
        // Round-3 review fix #2: the redraw arrives as a NEW PTY chunk some
        // time after the key, never read the screen synchronously.
        chunk = await waitForChunkAfter(seq, left);
      } catch {
        break;
      }
      sawChunk = true;
      // Wait for the chunk after THIS one, not after the latest: a chunk that
      // landed while this one was being handed over is still to be read.
      seq = chunk.seq ?? currentChunkSeq();
      lastLines = chunk.lines;
      // Only a screen showing this list's own question is read. Mid-redraw
      // the list can be half erased with an earlier, answered question the
      // last one on screen, and detectPrompt then reads that question's
      // trailing lines as options (measured: "✓ Selected project" and
      // "✔ Found 41 available models" in the model list, which shifted every
      // later model by two and would have picked the wrong one).
      if (chunk.prompt?.id !== step) continue;
      for (const o of chunk.prompt.options ?? []) if (!raw.includes(o)) raw.push(o);
      const now = markedLabel(chunk.lines);
      if (now !== undefined && now !== current) moved = now;
    }
    if (!sawChunk) {
      throw {
        step,
        message: `${step} list did not redraw within ${MODEL_STEP_REDRAW_TIMEOUT_MS}ms after an arrow-key step`,
        raw: lastLines.join('\n'),
      };
    }
    if (moved === undefined || highlighted.has(moved)) { settledPagination = true; break; }
    highlighted.add(moved);
    current = moved;
  }
  if (!settledPagination) {
    throw {
      step,
      message: `${step} list pagination did not settle after ${MAX_MODEL_PAGINATION_STEPS} steps`,
      raw: raw.join('\n'),
    };
  }
  for (let i = 0; i < steps; i += 1) await writeArrowUp();
  return raw;
}

async function collectModelOptions(initialOptions, initialSelectedIndex, deps) {
  const raw = await collectListOptions(initialOptions, initialSelectedIndex, { ...deps, step: 'model' });
  const filtered = raw.filter((o) => !/^custom/i.test(o));
  return { raw, filtered };
}

// Single-flight guard: only one startSetup() run may be in progress at a time
// (there is only one PTY slot in Rust-managed state).
let active = false;

// EPMCDME-14588. Handles on the run in flight, so it can be ended from outside.
// `requestCancel` only exists once runSetup has built its settle pair, which is
// several awaits in (the lazy dep imports), so a cancel that arrives before then
// is remembered and applied there instead of being dropped.
let activeDone = null;
let requestCancel = null;
let cancelPending = false;

// How long cancelSetup() waits for the run to unwind before returning anyway.
// The unwind kills the child and waits for its exit to be reported; the Rust
// side gives that 5s, so this sits just past it.
const CANCEL_UNWIND_TIMEOUT_MS = 6000;

/**
 * Run `codemie setup`, answering its prompts through onPrompt.
 *
 * `replay` (EPMCDME-14656) is a list of answers from an earlier run, in the
 * order they were given: [{ id, answer, label? }]. The CLI cannot be rewound,
 * so going back to an answered step, or retrying at the step that failed,
 * means a new run that is walked to that point without asking the user again.
 * Each prompt whose id matches the next entry is answered from it and onPrompt
 * is not called; `onReplayed(prompt, answer)` is told instead, so the screen
 * can show the step as answered. A list entry with a `label` is answered by
 * that label, since a list can come back in a different order; a label the
 * list no longer has ends the replay there. The first prompt that does not
 * match ends the replay too: the rest of the entries are dropped and that
 * prompt, and every later one, goes to onPrompt. Replaying a rejected answer
 * makes the CLI ask again, and the correction after it in the list answers
 * that.
 *
 * `onAnswer({ id, kind, answer, label })` is told every answer given in the
 * run, from the user or from `replay`, in order -- the list a later replay is
 * built from. `label` is the chosen option for a list.
 */
export async function startSetup({ onPrompt, onLog, replay, onScreen, onReplayed, onAnswer } = {}, deps = {}) {
  if (active) {
    throw { step: null, message: 'startSetup already in progress', raw: '' };
  }
  active = true;
  cancelPending = false;
  try {
    activeDone = runSetup({ onPrompt, onLog, replay, onScreen, onReplayed, onAnswer }, deps);
    return await activeDone;
  } finally {
    active = false;
    activeDone = null;
    requestCancel = null;
    cancelPending = false;
  }
}

/**
 * End the run in flight, if there is one. Resolves once it has fully unwound:
 * the child killed and the single-flight lock released, so the caller can start
 * a fresh run immediately. Returns whether there was a run to cancel.
 *
 * Try again needs this because the failures that matter are ones the CLI does
 * NOT exit on -- an unreachable CodeMie service re-asks the organization URL
 * and keeps waiting (setup.js:60). Starting over without ending that run first
 * would hit the single-flight guard above, and on the Rust side would leave a
 * second `codemie setup` racing the first over the configuration file.
 *
 * The rejection it causes carries `cancelled: true`, so a caller can tell a
 * deliberate cancel from a genuine failure.
 */
export async function cancelSetup() {
  if (!active) return false;
  cancelPending = true;
  requestCancel?.();
  // Bounded: the unwind waits on the child reporting its exit, and a child that
  // never does would leave this pending forever. The caller is a "Try again"
  // click whose notice has already closed, so hanging here strands the user on
  // an empty screen. Returning lets the next startSetup decide -- it raises its
  // own single-flight rejection, which the UI can report.
  await Promise.race([
    activeDone?.catch(() => {}) ?? Promise.resolve(),
    new Promise((resolve) => { setTimeout(resolve, CANCEL_UNWIND_TIMEOUT_MS); }),
  ]);
  return true;
}

// The answer a replay entry gives this prompt, or undefined when it gives none
// (the replay ends there). A list entry with a label is matched by the label.
function replayedAnswer(entry, prompt) {
  if (!entry || entry.id !== prompt.id) return undefined;
  if (prompt.kind === 'list' && entry.label !== undefined) {
    const i = prompt.options.indexOf(entry.label);
    return i === -1 ? undefined : i;
  }
  return entry.answer;
}

async function runSetup({ onPrompt, onLog, replay, onScreen, onReplayed, onAnswer }, deps) {
  const spawnPty = deps.spawnPty ?? (await import('./runner-bridge.js')).pty.spawnPty;
  const input = deps.input ?? (await import('./runner-bridge.js')).pty.input;
  const kill = deps.kill ?? (await import('./runner-bridge.js')).pty.kill;
  const TerminalCtor = deps.Terminal ?? (await import('./vendor/xterm.mjs')).Terminal;
  const suspendPtyInput = deps.suspendPtyInput ?? (await import('./terminal.js')).suspendPtyInput;
  const resumePtyInput = deps.resumePtyInput ?? (await import('./terminal.js')).resumePtyInput;

  // Test fakes are often passed as arrow functions (not constructible); real
  // Terminal is a class. `.prototype` distinguishes constructible callables
  // (functions/classes) from arrow functions, so both call shapes work.
  const term = TerminalCtor.prototype
    ? new TerminalCtor({ cols: COLS, rows: ROWS, scrollback: 0 })
    : TerminalCtor({ cols: COLS, rows: ROWS, scrollback: 0 });

  // The run settles either from the spawned process's own exit code, or from
  // a prompt handler rejecting early (e.g. customModel/modelManual, Task 8).
  // Prompt handling runs detached from the exit-code await below (onData is
  // a synchronous PTY-data callback, not awaited by anything), so both paths
  // resolve/reject through this single settle pair -- whichever gets there
  // first wins, and the other becomes a no-op.
  let settled = false;
  let resolveRun;
  let rejectRun;
  const runPromise = new Promise((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  function settleResolve(value) {
    if (settled) return;
    settled = true;
    resolveRun(value);
  }
  function settleReject(error) {
    if (settled) return;
    settled = true;
    rejectRun(error);
  }

  // EPMCDME-14588: the settle pair now exists, so cancelSetup() has something to
  // call. A cancel that arrived while the lazy dep imports above were still
  // running is applied here rather than lost. The unwind is the ordinary one --
  // the finally below kills the child and frees the lock.
  requestCancel = () => settleReject({
    step: null,
    cancelled: true,
    message: 'setup cancelled',
    raw: readScreen().join('\n'),
  });
  if (cancelPending) requestCancel();

  // EPMCDME-14656. Every prompt the caller would answer goes through ask(): the
  // next replay entry answers it while the entries still match, onPrompt once
  // they stop. Prompts the driver answers itself (AUTO_LIST, AUTO_CONFIRM) are
  // not in the list and never reach here, so a replay skips them the same way
  // the user never saw them.
  const pending = Array.isArray(replay) ? [...replay] : [];
  async function ask(prompt) {
    let answer = replayedAnswer(pending[0], prompt);
    if (answer !== undefined) {
      pending.shift();
      onReplayed?.(prompt, answer);
    } else {
      pending.length = 0;
      answer = await onPrompt(prompt);
    }
    const label = prompt.kind === 'list' ? prompt.options?.[answer] : undefined;
    onAnswer?.({ id: prompt.id, kind: prompt.kind, answer, ...(label !== undefined && { label }) });
    return answer;
  }

  // Captured from the profileName input prompt's own answer (Task 9's
  // uniform input branch); resolved into the final result on zero exit.
  let profileName = null;
  // True once the user picked "Update an existing profile" and a profile to
  // update. The CLI then asks no profile name and does not switch profiles.
  let updated = false;

  // Per-run (closure-scoped) dedup guard: a single startSetup() call is a
  // single PTY, so there is no concurrency beyond the module-level single-
  // flight lock. Tracks the last prompt occurrence dispatched so a redraw of
  // the SAME occurrence (still in-flight, or already answered) is ignored.
  //
  // Round-3 review fix #3: this signature's job is purely "was THIS exact
  // occurrence already answered", never "was this id+message combination
  // ever seen". lastPromptScreenText records the screen the signature was
  // captured against; once the signature is confirmed STALE (see
  // signatureEligibleToClear below), a later chunk whose screen differs from
  // it clears the signature -- so a CLI that later re-asks an outwardly-
  // identical prompt (e.g. a rejected credential redraws the SAME "Enter
  // your API key:" text) is answered again instead of being ignored
  // forever. promptInFlight (below) remains the separate guard against
  // re-entering the SAME still-settling redraw.
  let lastPromptSignature = null;
  let lastPromptScreenText = null;

  // Round-4 review fix (R4-1): raw screen TEXT is the wrong signal for "is
  // this a cosmetic redraw of the still-open prompt, or has the CLI
  // genuinely re-asked this question after moving away and back" -- an
  // unrelated cosmetic change anywhere on screen (a status line, a spinner
  // frame) also makes the text differ, which used to clear the signature and
  // cause the SAME still-open prompt to be answered a second time. The real
  // distinguishing signal is timing: a cosmetic redraw is followed by more
  // chunks arriving almost immediately (the CLI is still actively
  // rendering); a genuine re-ask means the CLI has gone idle again. Reusing
  // the same IDLE_MS/debounce pattern as scheduleIdleCheck below: every
  // chunk resets this timer, so signatureEligibleToClear only flips true
  // once IDLE_MS has passed with no further chunk arriving -- only THEN is
  // the signature allowed to be cleared by a differing screen.
  let signatureEligibleToClear = false;
  let signatureStaleTimer = null;
  function noteChunkArrivedForSignatureStaleness() {
    if (signatureStaleTimer) clearTimeout(signatureStaleTimer);
    signatureEligibleToClear = false;
    signatureStaleTimer = setTimeout(() => {
      signatureEligibleToClear = true;
    }, IDLE_MS);
  }

  // In-flight guard (CR-002): true from the moment a detected prompt begins
  // real handling until that handling finishes (resolved, threw, or its
  // returned promise rejected). During a paginated 'model' walk, the CLI
  // redraws the SAME open prompt with a different visible options slice on
  // every arrow-key step -- each redraw is a distinct prompt-signature hit
  // that would otherwise defeat the signature-based dedup guard and let a
  // second collectModelOptions() walk start while the first is still
  // in-flight, racing arrow-key writes against each other on the same PTY.
  // onData checks this flag before ever calling detectPrompt again, so ALL
  // redraws while a prompt is being handled are no-ops for dispatch purposes
  // -- including the redraws collectModelOptions()'s own arrow-key writes
  // themselves provoke.
  let promptInFlight = false;

  // The kind:'input' prompt answered last, until the CLI moves on to another
  // prompt: { id, message, shownKey, progressed }. `message` is the stable
  // question (default hint stripped, never the rejected value), `shownKey` the
  // question-plus-error of the screen we answered, and `progressed` whether a
  // screen without an error has shown up since (repaint, typing, echo). Input
  // prompts cannot join answeredOnce below; see the note in handleDetectedPrompt.
  let lastAnsweredInput = null;
  // Every input question answered in this run, { id, message }. Its answered
  // line stays on screen after the CLI has moved on, and can be the last
  // question line again for a chunk (see handleDetectedPrompt).
  const answeredInputs = [];

  // Ids already answered in THIS run that the CLI asks at most once, so a
  // second answer is always wrong. See the round-5 note in
  // handleDetectedPrompt for why membership is deliberately narrow.
  const answeredOnce = new Set();

  function promptSignature(prompt) {
    return JSON.stringify({ id: prompt.id, message: prompt.message, options: prompt.options ?? null });
  }

  async function handleDetectedPrompt(prompt, { onPrompt: onPromptCb, deps: innerDeps, lines }) {
    // Round-5 fix: an inquirer prompt we have already answered keeps its '?'
    // prefix and stays on screen with the answer appended, so between our write
    // and the NEXT prompt rendering it is still the last question line --
    // detectPrompt legitimately classifies it again (that is all its contract
    // promises). Its message and options both differ from the open form (the
    // answer is appended, and at COLS the answered line can wrap so parseOptions
    // reads the wrapped tail as the option list), so promptSignature does not
    // suppress it. Measured against the real CLI: the answered storage line
    // "? Where would you like to store this configuration? Global (~/.codemie/)
    // - Available across all repositories" is 108 chars, wraps at COLS=100, and
    // re-dispatched as storage with options ["repositories"] -- pickAutoListIndex
    // then found no /global/i match and rejected the whole run before onPrompt
    // was ever called once.
    //
    // Membership is deliberately narrow: the three fixed-policy ids (AUTO_LIST /
    // AUTO_CONFIRM), every kind:'confirm' prompt, and every kind:'list' prompt
    // once the caller has answered it. All of them are named anchors the CLI
    // asks exactly once and never re-asks -- a confirm accepts any input and a
    // list cannot fail validation, so there is no loop that could legitimately
    // re-open one, and detectPrompt returns null for an unrecognized (y/N)
    // line, so a confirm reaching here is always a named anchor and never the
    // catch-all.
    //
    // The list case was measured in the app on 2026-09-09, on EPMCDME-14513's
    // first real walk: the CLI's provider question ends in a newline
    // (cli/commands/setup.js:243), so its answered line is "? Choose your LLM
    // provider:" with the chosen label on the NEXT row (rows 24-25 of the real
    // recording provider-answered-then-next-open.json). parseOptions reads that
    // row as a one-entry option list, so the echo came back as a fresh provider
    // prompt with a different signature, the caller answered it again, and the
    // stray Enter accepted the organization URL's default before the caller
    // ever saw that prompt. Any other answered list is exposed the same way
    // whenever a non-blank row follows it before the next question renders.
    //
    // A blanket per-id guard would be WRONG: 'credential' is the parser's
    // catch-all, so a single run legitimately carries several distinct prompts
    // under that one id. The bundled CLI's bedrock plugin asks three in a row --
    // "AWS Access Key ID:", "AWS Secret Access Key:" and "AWS Region:" -- none of
    // which match a named anchor, so suppressing repeats there would answer the
    // first and then hang the run waiting on the second. The input-kind prompts
    // rely instead on the R4-1 idle gate, which is what lets a genuine re-ask
    // (a rejected credential's error + re-ask) reach onPrompt again.
    if (answeredOnce.has(prompt.id)) return;

    // kind:'input' prompts cannot join answeredOnce for the two reasons just
    // given, yet the question we just answered stays on screen for a while. The
    // driver reads the screen after every chunk, and measured against the real
    // CLI in the app (2026-09-14, recorded chunk by chunk) the stream after one
    // of our answers is, in order: the screen we answered, not yet redrawn; for a
    // re-answer, the bare question our ctrl-U repaints; the answer typed out one
    // character at a time; and only then the verdict -- the accepted echo and the
    // next question, or a fresh ">>" error. Every one of those screens carries
    // the same question, and treating one as a new ask left a control open that
    // nothing was waiting on, while promptInFlight made the driver ignore the
    // CLI's real next prompt (the "Switch to profile" confirm was never answered).
    //
    // So after an input answer, the same question comes back as a question only
    // with a ">>" error under it -- the one way inquirer re-asks
    // (input.js:88-91). A screen without one is progress (repaint, typing, echo:
    // "Enter a name for this profile: myprofile", "API key: ****"). A screen with
    // the very error we answered is that screen again, unless progress was seen
    // in between: then it is a new rejection -- the same wrong name entered twice
    // -- and it is asked again even though it looks identical, so the signature
    // dedupe below must not swallow it. A different question under the
    // 'credential' catch-all does not start with the stored one, so bedrock's
    // three-in-a-row is untouched. Compared with the default hint stripped: the
    // echo and the re-ask never carry it once the line was touched (base.js:157-160).
    const redetected = stableQuestion(prompt.message);
    if (
      lastAnsweredInput !== null
      && prompt.id === lastAnsweredInput.id
      && redetected.startsWith(lastAnsweredInput.message)
    ) {
      // EPMCDME-14588: the CLI can ask the same question again with no '>>' error
      // at all. An unreachable CodeMie service times the SSO callback out after
      // 120s, the gate prints a yellow warning (setup.js:60) and the flow
      // continues, re-asking the organization URL. Swallowing that hangs the run
      // with the CLI still waiting for input.
      //
      // A fresh prompt instance is told apart from a redraw by inquirer's default
      // hint: it renders one, while a line that has been touched never does
      // (base.js:157-160) -- neither the answered echo nor the bare repaint our
      // own ctrl-U causes. The equality is what makes the hint safe to trust:
      // an answer that itself ends in parentheses leaves the line longer than the
      // question, so it stays an echo.
      //
      // The screen must also have moved on since the answer was written, and the
      // CLI must have gone quiet for IDLE_MS first: a cosmetic line rendered
      // above a still-open question changes the raw text within milliseconds
      // while the question itself, hint included, is untouched (round-4 review
      // fix #1). The real re-ask arrives 120s after the write.
      //
      // Residual limit: a prompt the CLI gives no default is re-asked as a bare
      // line and still cannot be told from the repaint. Every prompt on the
      // measured failure paths carries one.
      if (
        redetected === lastAnsweredInput.message
        && DEFAULT_HINT.test(prompt.message)
        && lines.join('\n') !== lastAnsweredInput.screenText
        && Date.now() - lastAnsweredInput.writtenAt >= IDLE_MS
      ) {
        lastAnsweredInput = null;
        lastPromptSignature = null;
      } else {
        const error = validationErrorText(lines);
        if (error === null) {
          lastAnsweredInput.progressed = true;
          return;
        }
        if (!lastAnsweredInput.progressed && `${redetected}\n${error}` === lastAnsweredInput.shownKey) return;
        lastPromptSignature = null;
      }
    }
    // An input answered earlier, after the CLI moved on: its answered line is
    // still on screen, and when a later prompt is erased (the project list, as
    // its answer is written) it is the last question line again for a chunk --
    // "CodeMie organization URL: https://codemie.lab.epam.com", recorded
    // 2026-09-14. That line carries its answer, so it is strictly longer than the
    // question. A bare question is not an answered line and is left alone.
    else if (
      validationErrorText(lines) === null
      && answeredInputs.some((a) => a.id === prompt.id
        && redetected.length > a.message.length
        && redetected.startsWith(a.message))
    ) return;

    const sig = promptSignature(prompt);
    if (sig === lastPromptSignature) return; // same occurrence already in-flight or answered: ignore
    lastPromptSignature = sig; // mark before awaiting, so mid-await redraws are caught too
    lastPromptScreenText = lines.join('\n');
    // The CLI moved on to another prompt: the input answered before it is done.
    if (lastAnsweredInput !== null && prompt.id !== lastAnsweredInput.id) lastAnsweredInput = null;
    promptInFlight = true;
    try {
      if (prompt.id === 'customModel' || prompt.id === 'modelManual') {
        throw {
          step: 'model',
          message: `model step requires a fetched list; got free-text fallback prompt "${prompt.id}"`,
          raw: lines.join('\n'),
        };
      }

      if (prompt.id in AUTO_LIST) {
        const chosenIndex = pickAutoListIndex(prompt.options, AUTO_LIST[prompt.id]);
        await innerDeps.input(translateListAnswer(prompt.selectedIndex, chosenIndex));
        answeredOnce.add(prompt.id);
        return;
      }

      if (prompt.id in AUTO_CONFIRM) {
        await innerDeps.input(translateConfirmAnswer(AUTO_CONFIRM[prompt.id]));
        answeredOnce.add(prompt.id);
        return;
      }

      if (prompt.id === 'gate') {
        const shown = prompt.options.filter((o) => !GATE_CANCEL.test(o));
        const answer = await onPromptCb({ kind: 'list', id: prompt.id, message: prompt.message, options: shown });
        const rawIndex = Number.isInteger(answer) ? prompt.options.indexOf(shown[answer]) : -1;
        if (rawIndex === -1) {
          throw { step: 'gate', message: `invalid gate selection index: ${JSON.stringify(answer)}`, raw: lines.join('\n') };
        }
        await innerDeps.input(translateListAnswer(prompt.selectedIndex, rawIndex));
        answeredOnce.add(prompt.id);
        return;
      }

      // Only reached after the user chose to update. The list is paged like the
      // model list, so it is walked to the end first; the profile picked is
      // the one the CLI then updates in place.
      if (prompt.id === 'updateProfile') {
        const raw = await collectListOptions(prompt.options, prompt.selectedIndex, {
          step: 'updateProfile',
          initialLines: lines,
          currentChunkSeq,
          waitForChunkAfter,
          writeArrowDown: () => innerDeps.input('\x1b[B'),
          writeArrowUp: () => innerDeps.input('\x1b[A'),
        });
        const answer = await onPromptCb({ kind: 'list', id: prompt.id, message: prompt.message, options: raw });
        if (!Number.isInteger(answer) || answer < 0 || answer >= raw.length) {
          throw { step: 'updateProfile', message: `invalid updateProfile selection index: ${JSON.stringify(answer)}`, raw: lines.join('\n') };
        }
        await innerDeps.input(translateListAnswer(prompt.selectedIndex, answer));
        profileName = raw[answer];
        updated = true;
        answeredOnce.add(prompt.id);
        return;
      }

      if (prompt.id === 'model') {
        const { raw, filtered } = await collectModelOptions(prompt.options, prompt.selectedIndex, {
          initialLines: lines,
          currentChunkSeq,
          waitForChunkAfter,
          writeArrowDown: () => innerDeps.input('\x1b[B'),
          writeArrowUp: () => innerDeps.input('\x1b[A'),
        });
        const answer = await onPromptCb({ kind: 'list', id: prompt.id, message: prompt.message, options: filtered });
        // CR-003: an out-of-range answer index must be a clear rejection, never
        // a silent misnavigation -- filtered[answer] is undefined for an
        // out-of-range index, which raw.indexOf() can only ever resolve to -1
        // (raw never contains an undefined entry), so this one check covers
        // both a non-numeric and an out-of-bounds answer.
        const rawIndex = raw.indexOf(filtered[answer]);
        if (rawIndex === -1) {
          throw {
            step: 'model',
            message: `invalid model selection index: ${JSON.stringify(answer)}`,
            raw: lines.join('\n'),
          };
        }
        await innerDeps.input(translateListAnswer(prompt.selectedIndex, rawIndex));
        answeredOnce.add(prompt.id); // see the list note above answeredOnce's check
        return;
      }

      if (prompt.kind === 'list') {
        const answer = await onPromptCb({ kind: prompt.kind, id: prompt.id, message: prompt.message, options: prompt.options });
        // Round-3 review fix #4: mirror the model branch's bounds check (CR-003)
        // here too. Without it, an out-of-range or non-numeric answer index
        // silently confirms whatever option happens to be highlighted (a bare
        // '\r') instead of failing -- the run then "succeeds" having picked
        // the wrong provider/project with no error surfaced anywhere.
        if (!Number.isInteger(answer) || answer < 0 || answer >= prompt.options.length) {
          throw {
            step: prompt.id,
            message: `invalid ${prompt.id} selection index: ${JSON.stringify(answer)}`,
            raw: lines.join('\n'),
          };
        }
        await innerDeps.input(translateListAnswer(prompt.selectedIndex, answer));
        answeredOnce.add(prompt.id); // see the list note above answeredOnce's check
        return;
      }

      // kind: 'confirm' prompts the caller answers -- today only installClaude,
      // since 'activate' is still fixed policy. Until installClaude became a
      // user decision BOTH confirms were auto-answered above, so nothing ever
      // reached here and the generic fallback at the bottom would have written
      // String(answer) -- the literal word "false", with no '\r'. That types a
      // corrupted answer and then hangs the run waiting for an Enter that never
      // comes. Bounds-check the answer the same way the list branches do
      // (CR-003): a wrong-typed answer must be a clear rejection, not a silent
      // misanswer on a prompt that installs software.
      if (prompt.kind === 'confirm') {
        const answer = await onPromptCb({ kind: 'confirm', id: prompt.id, message: prompt.message });
        if (typeof answer !== 'boolean') {
          throw {
            step: prompt.id,
            message: `invalid ${prompt.id} confirm answer: ${JSON.stringify(answer)}`,
            raw: lines.join('\n'),
          };
        }
        await innerDeps.input(translateConfirmAnswer(answer));
        // Same reason the fixed-policy ids are marked: inquirer keeps the '?'
        // prefix on the answered line, so until the next screen renders this is
        // still the last question line and detectPrompt classifies it again --
        // with "Yes"/"No" now appended, so the signature guard does not suppress
        // it either. Without this the answer is written twice, into a CLI that
        // has already moved on to installing.
        answeredOnce.add(prompt.id);
        return;
      }

      // Every kind: 'input' prompt (codemieUrl, credential, profileName, and any
      // future input-kind id) goes through this one branch -- no per-id special
      // casing beyond the reject/auto-answer checks already handled above.
      if (prompt.kind === 'input') {
        const answer = await onPromptCb({ kind: 'input', id: prompt.id, message: prompt.message });
        if (prompt.id === 'profileName') profileName = String(answer);
        const question = stableQuestion(prompt.message);
        // A re-answer is an answer to the input prompt just answered, which the
        // CLI rejected: its ">>" error is on screen. Not "the question carries
        // the rejected value" -- a whitespace-only rejection leaves nothing
        // visible after the question, yet inquirer still put the spaces back.
        const error = validationErrorText(lines);
        const reAnswer = lastAnsweredInput !== null
          && lastAnsweredInput.id === prompt.id
          && error !== null;
        // A re-answer is written behind \x15 (ctrl-U, "delete to start of
        // line"). On a failed validate inquirer pushes the rejected value BACK
        // into readline's buffer so a human can edit it in place
        // (inquirer/lib/prompts/input.js:88-89); we send a whole new answer
        // instead, so without the line kill the CLI receives
        // "not-a-urlhttps://codemie.lab.epam.com" and rejects it forever.
        // Measured against the vendored CLI: without it the corrected answer
        // never lands, with it the same answer is accepted. A first ask does not
        // need it: that buffer is already empty.
        await innerDeps.input(`${reAnswer ? '\x15' : ''}${answer}\r`);
        // Recorded after the write, so a throwing input() records nothing. The
        // stored question is the stable one: default hint stripped, and on a
        // re-answer the one already stored, since the message just answered
        // carries the rejected value ("Enter a name for this profile: taken").
        // Any other message under the same id (bedrock's next credential prompt)
        // replaces it, so each of those prompts is matched against its own
        // question. "Shortest wins" would be wrong there: it would pin the
        // catch-all to the shortest AWS prompt and miss the other two.
        lastAnsweredInput = {
          id: prompt.id,
          message: reAnswer ? lastAnsweredInput.message : question,
          shownKey: `${question}\n${error ?? ''}`,
          progressed: false,
          writtenAt: Date.now(),
          // The screen this answer was written against. A chunk that redraws it
          // unchanged is the CLI not having caught up yet, never a new ask
          // (EPMCDME-14588's re-ask check below).
          screenText: lines.join('\n'),
        };
        const { id, message } = lastAnsweredInput;
        if (!answeredInputs.some((a) => a.id === id && a.message === message)) answeredInputs.push({ id, message });
        return;
      }

      // Generic fallback for any other kind; nothing currently reaches this.
      const answer = await onPromptCb(prompt);
      await innerDeps.input(String(answer));
    } finally {
      promptInFlight = false;
    }
  }

  function readScreen() {
    const lines = [];
    for (let r = 0; r < ROWS; r += 1) {
      lines.push(term.buffer.active.getLine(r)?.translateToString(true) ?? '');
    }
    return lines;
  }

  function decode(b64) {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return { bytes, text: bin };
    } catch {
      return { bytes: b64, text: String(b64) };
    }
  }

  let idleTimer = null;
  function scheduleIdleCheck() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      if (settled) return;
      const lines = readScreen();
      if (detectPrompt(lines) !== null) return; // a real prompt is on screen: never fires here
      // detectPrompt() returning null on a settled screen is ambiguous between two
      // very different states, which must not be conflated (round-2 regression fix):
      //   1. No question line at all -- the CLI is doing background work (fetching,
      //      validating, printing progress) and simply hasn't reached its next prompt
      //      yet. NORMAL. Must not reject; the next PTY chunk reschedules this timer.
      //   2. A real, unclassified question IS on screen (detectPrompt saw a '?' line
      //      but didn't recognize it, or refused it e.g. the credential catch-all's
      //      ':' guard) -- this is the actual stall case CR-004 exists to handle.
      // Reuse setup-parse.js's own isQ predicate (identical rule it uses internally)
      // rather than a second, possibly-divergent "is this a question" check.
      const questionLine = [...lines].reverse().find((l) => isQ(l));
      if (questionLine === undefined) return; // case 1: no question on screen, CLI is mid-work -- do nothing, wait for more data
      const trimmedQuestion = questionLine.trim();
      if (YN_HINT.test(trimmedQuestion)) {
        // The auto-answer write must not be fire-and-forget: if it rejects
        // (e.g. the PTY bridge's input() throws), that must become a proper
        // startSetup rejection instead of an unhandled promise rejection and
        // a silently-stalled fallback.
        try {
          await input('n\r');
        } catch (err) {
          settleReject({ step: null, message: `auto-answer write failed: ${err?.message ?? err}`, raw: lines.join('\n') });
        }
        return;
      }
      // case 2, non-(y/N): a screen carrying a real question line that detectPrompt
      // cannot classify and that carries no (y/N) hint is genuinely unclassified --
      // guessing an answer here could write garbage into a live CLI prompt, so the
      // run must reject instead of hanging forever with the single-flight lock held.
      // EPMCDME-14588 uses this exact { step: null, ... } shape to surface
      // "here's what the CLI was asking that we didn't understand".
      settleReject({ step: null, message: 'unrecognized prompt, run stalled', raw: lines.join('\n') });
    }, IDLE_MS);
  }

  // Round-3 review fixes #1/#2 (shared root cause): the real xterm.js
  // Terminal.write(data, callback) parses ASYNCHRONOUSLY -- it defers the
  // screen-buffer update to a later macrotask and only invokes `callback`
  // once parsing has actually completed. Reading the screen synchronously
  // right after write() (the old code) always observes the buffer as it was
  // BEFORE the just-written bytes were parsed. writeToTerminal() wraps the
  // real completion callback in a Promise so callers can await it.
  function writeToTerminal(bytes) {
    return new Promise((resolve) => term.write(bytes, resolve));
  }

  // onData is a synchronous PTY-bridge callback -- fired once per chunk as
  // chunks arrive, never awaited by the caller. Naively awaiting the write
  // inside an async onData handler would let two chunks arriving close
  // together interleave/complete their async write-then-parse work out of
  // order. writeQueue chains each chunk's write-then-parse work onto the END
  // of the previous chunk's, so chunks are always processed strictly in
  // arrival order, never concurrently.
  let writeQueue = Promise.resolve();

  // Sequence number bumped once per chunk, after that chunk's write has been
  // parsed and its screen read -- lets collectModelOptions() (round-3 fix
  // #2) wait for the NEXT chunk to arrive and be parsed after sending an
  // arrow-key press, rather than reading synchronously in the same tick.
  let chunkSeq = 0;
  let lastChunkResult = { lines: [], prompt: null };
  let chunkWaiters = []; // [{ resolve }] currently waiting for chunkSeq to advance

  function currentChunkSeq() {
    return chunkSeq;
  }

  function waitForChunkAfter(baseSeq, timeoutMs) {
    if (chunkSeq > baseSeq) return Promise.resolve(lastChunkResult);
    return new Promise((resolve, reject) => {
      const entry = {};
      const timer = setTimeout(() => {
        chunkWaiters = chunkWaiters.filter((w) => w !== entry);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for the next PTY chunk`));
      }, timeoutMs);
      entry.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      chunkWaiters.push(entry);
    });
  }

  // Writes the chunk's bytes to the terminal, awaits the real parse, reads
  // the settled screen, and notifies anyone waiting on chunkSeq -- this is
  // the part that is strictly serialized across chunks via writeQueue (see
  // onData below). Dispatch to handleDetectedPrompt (or the idle-check
  // scheduler) then happens fire-and-forget, deliberately NOT awaited here:
  // dispatching a 'model' prompt calls collectModelOptions(), which writes
  // an arrow key and then waits (via waitForChunkAfter) for the CLI's
  // redrawn chunk to arrive and be parsed by THIS SAME function on a later
  // call. If this function held the writeQueue slot open until dispatch
  // fully finished, that later call would deadlock waiting for a queue slot
  // held by the very handler waiting on it. Not awaiting dispatch here frees
  // the queue for the next chunk's parse the moment THIS chunk is parsed,
  // regardless of how long handling it takes.
  async function processChunk(b64) {
    if (settled) return;
    const { bytes, text } = decode(b64);
    await writeToTerminal(bytes); // await the real parse before ever reading the screen
    if (settled) return; // the run may have settled while this chunk's write was parsing
    onLog?.(text); // collectModelOptions()'s own screen reads see real, fully-parsed state
    const lines = readScreen();
    onScreen?.(lines);
    const prompt = detectPrompt(lines);

    // Round-4 review fix (R4-1): the signature is only allowed to be cleared
    // once IDLE_MS has passed since the LAST chunk arrived (signatureEligible-
    // ToClear, set by the debounce timer below) -- never merely because this
    // chunk's raw screen text differs from the one the signature was
    // captured against. A quick, cosmetic redraw (this same still-open
    // prompt, moments later) leaves eligibility false and so is correctly
    // ignored; only once the CLI has gone genuinely idle and THEN redraws a
    // differing screen (e.g. a rejected credential's error + re-ask) does
    // this clear the signature, letting that later, truly new occurrence
    // reach onPrompt. promptInFlight (below) remains the separate guard
    // against re-entering the SAME still-settling redraw.
    const screenText = lines.join('\n');
    if (lastPromptSignature !== null && screenText !== lastPromptScreenText && signatureEligibleToClear) {
      lastPromptSignature = null;
      lastPromptScreenText = null;
    }
    // No question on screen, long after our last answer and after the CLI had
    // gone quiet: it moved on from that input, so the same question showing up
    // later is a new ask (a rejected credential re-shown after an error). The
    // time is measured from our write, not only from the last chunk: the first
    // chunk after an answer follows the user's think time, and in the recorded
    // stream it can be a question-less partial redraw milliseconds after the
    // write -- that must not end it.
    if (
      !prompt
      && signatureEligibleToClear
      && lastAnsweredInput !== null
      && Date.now() - lastAnsweredInput.writtenAt >= IDLE_MS
    ) lastAnsweredInput = null;
    // This chunk just arrived, so the CLI is active again: reset the
    // staleness debounce for the NEXT chunk (mirrors scheduleIdleCheck's own
    // reset-on-every-chunk pattern).
    noteChunkArrivedForSignatureStaleness();

    chunkSeq += 1;
    lastChunkResult = { lines, prompt, seq: chunkSeq };
    const waiters = chunkWaiters;
    chunkWaiters = [];
    for (const w of waiters) w.resolve(lastChunkResult);

    // CR-002: while a detected prompt is already being handled (including a
    // paginated 'model' walk still in progress), never re-enter dispatch --
    // not even to compare signatures. This is checked first and skips the
    // whole redraw-handling step, since the walk's own arrow-key writes are
    // exactly what provokes these redraws.
    if (promptInFlight) return;
    if (prompt) {
      handleDetectedPrompt(prompt, { onPrompt: ask, deps: { input }, lines }).catch(settleReject);
      return;
    }
    scheduleIdleCheck();
  }

  function onData(b64) {
    // Once this run has settled (resolved or rejected), any further PTY-data
    // event -- late/stale data racing the run's own teardown -- is a no-op:
    // no further onPrompt calls, no further writes, no state mutation.
    if (settled) return;
    // Chain onto the end of the queue rather than awaiting directly, so this
    // synchronous callback returns immediately while still guaranteeing
    // strict in-order write-then-parse processing of chunks.
    writeQueue = writeQueue.then(() => processChunk(b64)).catch(settleReject);
  }

  // Tracks whether the spawned child has actually reported its own exit
  // (engine:pty-exit, one layer down in the real bridge). The run's promise
  // can settle earlier than that -- e.g. a prompt handler rejecting
  // (customModel/modelManual) while the CLI process is still alive -- so a
  // fresh startSetup() call must never respawn until this run's process is
  // confirmed gone, forcing it via kill() if it hasn't exited on its own.
  let exited = false;
  // Round-3 review fix #5: suspendPtyInput() must live INSIDE the same try
  // whose finally calls resumePtyInput(). Previously it ran before the try
  // block started, so a synchronous throw between suspending and reaching
  // the try (e.g. spawnPty throwing synchronously rather than rejecting)
  // would skip resumePtyInput() entirely, permanently suspending
  // ui/terminal.js's keystroke forwarding for the rest of the session. The
  // try is widened to start right before suspendPtyInput() so ANY throw
  // after suspending is guaranteed to reach the same finally that resumes it.
  try {
    suspendPtyInput(); // spawn initiated: suspend ui/terminal.js's own keystroke forwarding
    const spawnResultPromise = spawnPty(SETUP_COMMAND, COLS, ROWS, onData).then(
      async ({ code }) => {
        exited = true;
        // The real bridge only fires its exit event after all pty-data
        // events for this run have already been delivered to onData, so by
        // now every chunk is already enqueued -- but with write-then-parse
        // now genuinely asynchronous (round-3 fix #1/#2), the LAST chunk's
        // own write/parse may still be in flight. Draining the queue here
        // stops the exit code from settling the run ahead of a still-parsing
        // final chunk (e.g. a last-chunk prompt, or onLog for it).
        await writeQueue.catch(() => {});
        return code;
      },
      async (err) => {
        exited = true;
        await writeQueue.catch(() => {});
        throw err;
      },
    );

    spawnResultPromise.then(
      (code) => {
        if (code === 0) {
          settleResolve({ profileName, updated });
        } else {
          // EPMCDME-14588: the exit code alone says nothing the user can act on,
          // and the CLI's own fatal message never reaches the terminal
          // (logger.js:278 gates it on CODEMIE_DEBUG). The screen is what it did
          // print, so it is what "Show details" has to show.
          settleReject({ step: null, message: `setup exited with code ${code}`, raw: readScreen().join('\n') });
        }
      },
      (err) => {
        settleReject({ step: null, message: `spawn failed: ${err?.message ?? err}`, raw: readScreen().join('\n') });
      },
    );

    try {
      return await runPromise;
    } finally {
      // CR-005: if kill() itself throws here, that throw propagates out of
      // this finally block and up into the OUTER try's finally below, which
      // always runs resumePtyInput() regardless -- a kill() rejection can
      // never permanently suspend ui/terminal.js's keystroke forwarding.
      if (!exited) {
        // A rejection here would REPLACE the run's own rejection, and the real
        // pty_kill does reject: src-tauri/src/commands/pty.rs returns
        // "pty_kill timed out" after its condvar wait. The caller would then get
        // a bare Error with no step and no raw -- exactly the generic failure
        // the UI must never show -- instead of why the run actually ended.
        const killed = await kill().then(() => true, () => false);
        // Only wait for the exit report if the kill was accepted. A child that
        // was never killed may never report one, and waiting forever holds the
        // single-flight lock: every later startSetup would reject with "already
        // in progress" and the app could not run setup again.
        if (killed) await spawnResultPromise.catch(() => {});
      }
    }
  } finally {
    resumePtyInput(); // restore forwarding on every exit path, success or rejection
  }
}
