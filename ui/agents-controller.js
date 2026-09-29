// Orchestrates the Agents screen's own read and its Install/Update/Remove
// actions: run `codemie list` (+ `codemie update --check`) -> parse -> join ->
// render, and drive each row action through `runStream`. Split from
// renderer.js the way health-controller.js is, so the wiring is unit-testable
// without stubbing the whole app shell: the caller supplies the container, a
// runCapture function, a runStream function and a steps-ui instance, and this
// module owns neither Tauri nor the rest of the DOM.
//
// `codemie list` is this screen's data source and EPMCDME-14589's too. Each
// screen reads for itself; onResult lets the caller keep Home's copy in step
// without a second read of its own.
import { parseAgentList } from './agents-parse.js';
import { parseUpdateStatus } from './agents-update-parse.js';
import { joinUpdateStatus } from './agents-join.js';
import { renderAgents, renderPane, setSelectedRow, showLoading, showRunError } from './agents-ui.js';

// Any of these substrings in an action's accumulated streamed text means the
// failure was a lack of network access, not something the CLI's own error
// text should be shown for.
const NO_NETWORK = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|getaddrinfo/i;

// agent.command is parsed unvalidated from `codemie list` stdout and
// interpolated straight into a shell string the Rust side runs via
// `/bin/zsh -lc`. A command that fails this check is never handed to
// runStream, however it got corrupted.
const SAFE_COMMAND = /^[A-Za-z0-9._-]+$/;

// How the CLI marks a line that states a failure, and the glyph to strip off
// it before the row shows it.
const ERROR_LINE = /^\s*[✗✖×]\s|^\s*(Error|Failed)\b/i;
const ERROR_GLYPH = /^\s*[✗✖×]\s*/;
const RESULT_LINE = /^\s*[✔✓⚠]\s*/;

export function createAgentsController({ container, runCapture, runStream, stepsUi, onFailure, onResult } = {}) {
  // A second run() while the first is in flight is a no-op, as on Health: the
  // read is cheap but re-rendering under a half-finished one loses row state.
  let running = false;
  // A refresh asked for while a load is in flight is remembered and run
  // afterwards. Dropping it left the row that asked for it showing a spinner
  // and no failure message until something else triggered a load.
  let pendingRefresh = false;
  let lastAgents = null;
  // command -> the message an action's failure left on that row, merged onto
  // the agent record on every load() so a refresh never drops it.
  const rowErrors = new Map();
  // agent.command values with an action currently running; while any is, a
  // new action request is refused rather than racing it.
  const inFlight = new Set();
  // command -> the CLI's result line after an Update ("already up to date",
  // "could not check"), which otherwise exits 0 and leaves no trace on the row.
  const rowNotes = new Map();
  // The agent whose detail pane is open (its command), and the CLI's latest
  // line per agent while an action runs. Both live here, not in the DOM, so the
  // full render load() ends with keeps them.
  let selected = null;
  const progress = new Map();
  // command -> 'Installing' | 'Updating' | 'Removing' while its action runs.
  const working = new Map();
  const handlers = { stepsUi, onInstall: (a, o) => onInstall(a, o), onUpdate: (a) => onUpdate(a), onRemove: (a) => onRemove(a), onSelect: (c) => select(c) };

  // Progress and selection redraw the details alone. renderAgents would rebuild
  // the step list and wipe the running row's spinner, ACTIVE badge and disabled
  // buttons, so only load() calls it.
  function redrawPane() {
    const agent = lastAgents?.find((a) => a.command === selected);
    renderPane(container, agent, { progress: progress.get(selected), working: working.get(selected) });
  }

  // The details open under a row like a dropdown: a second click closes them.
  function select(command) {
    open(selected === command ? null : command);
  }

  function open(command) {
    selected = command;
    setSelectedRow(container, command);
    redrawPane();
  }

  // silent: true is what a post-action refresh uses — it skips showLoading so
  // the container is never blanked outside the very first load.
  async function load({ silent }) {
    if (running) {
      pendingRefresh = true;
      return;
    }
    running = true;
    if (!silent) showLoading(container);
    try {
      const res = await runCapture('codemie list');
      if (!res || res.code !== 0) {
        const detail = (res && (res.stderr || res.stdout)) || 'The command did not run.';
        showRunError(container, String(detail).trim(), () => load({ silent: false }));
        lastAgents = null;
        onFailure?.();
        return;
      }
      let parsed = parseAgentList(res.stdout);
      if (parsed.length === 0) {
        // The CLI always lists agents; zero records means the output did not
        // look like a list at all, which must not render as "0 of 0 installed".
        showRunError(container, 'The tool list came back empty, so nothing can be shown here.', () => load({ silent: false }));
        lastAgents = null;
        onFailure?.();
        return;
      }

      // The update-check read is best-effort: a failed or non-zero read never
      // fails the whole screen, it just leaves every agent unflagged.
      let updateRecords = [];
      try {
        const checkRes = await runCapture('codemie update --check');
        if (checkRes && checkRes.code === 0) updateRecords = parseUpdateStatus(checkRes.stdout);
      } catch {
        updateRecords = [];
      }

      let agents = joinUpdateStatus(parsed, updateRecords);
      agents = agents.map((a) => {
        const message = rowErrors.get(a.command);
        if (message) return { ...a, actionStatus: 'error', actionMessage: message };
        const note = rowNotes.get(a.command);
        return note ? { ...a, actionMessage: note } : a;
      });

      lastAgents = agents;
      const progressNow = Object.fromEntries(progress);
      renderAgents(container, { agents, selected, progress: progressNow }, handlers);
      if (inFlight.size) redrawPane();
      onResult?.(agents);
    } catch (e) {
      showRunError(container, String((e && e.message) || e), () => load({ silent: false }));
      lastAgents = null;
      onFailure?.();
    } finally {
      running = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        await load({ silent: true });
      }
    }
  }

  // Returns { ok } or { ok: false, message }. The Agents screen ignores the
  // result and reads the row's own error; Home's checklist has no row to read,
  // so it is handed back. `onLine` is Home's too: its picker shows the
  // command's output where the install was started from.
  async function runAction(agent, command, { onLine, note, verb = 'Installing' } = {}) {
    // One at a time, see buildActions in agents-ui.js.
    if (inFlight.size) return { ok: false, message: 'Another tool is still being worked on.' };
    if (!SAFE_COMMAND.test(agent.command)) {
      const message = 'This tool’s command name is not safe to run and was blocked.';
      rowErrors.set(agent.command, message);
      await load({ silent: true });
      return { ok: false, message };
    }
    inFlight.add(agent.command);
    working.set(agent.command, verb);
    rowErrors.delete(agent.command);
    rowNotes.delete(agent.command);
    stepsUi.setStatus(agent.command, 'ACTIVE');
    stepsUi.startSpinner(agent.command);
    // The progress line lives in the details, so the agent being worked on
    // opens them.
    open(agent.command);
    const lines = [];
    let message = null;
    try {
      const { code } = await runStream(command, (text, tag) => {
        // runStream always emits a leading `('> <command>', 'prompt')` line
        // (ui/runner-bridge.js); it must never become the fallback error
        // message when a failing command produces no other output.
        // The echoed command is not progress: the row waits for the CLI's own lines.
        if (tag === 'prompt') return onLine?.(text, tag);
        lines.push(text);
        // The CLI's progress lines start with a "- " spinner frame.
        progress.set(agent.command, text.replace(/^\s*-\s+/, ''));
        if (agent.command === selected) redrawPane();
        onLine?.(text, tag);
      });
      if (code !== 0) {
        message = messageFor(lines, verb);
        rowErrors.set(agent.command, message);
      } else if (note) {
        const result = [...lines].reverse().find((l) => RESULT_LINE.test(l));
        if (result) rowNotes.set(agent.command, result.replace(RESULT_LINE, '').trim());
      }
    } catch (e) {
      lines.push(String((e && e.message) || e));
      message = messageFor(lines, verb);
      rowErrors.set(agent.command, message);
    } finally {
      inFlight.delete(agent.command);
      progress.delete(agent.command);
      working.delete(agent.command);
      await load({ silent: true });
    }
    return message ? { ok: false, message } : { ok: true };
  }

  function messageFor(lines, verb) {
    const accumulated = lines.join('\n');
    if (NO_NETWORK.test(accumulated)) return `${verb} needs a connection.`;
    // The CLI gives up on an install after a fixed time and says so in ms.
    const timedOut = accumulated.match(/timed out after (\d+)\s*ms/i);
    if (timedOut) return `Took longer than ${Math.round(Number(timedOut[1]) / 60000)} minutes. Check your connection and try again.`;
    // The CLI does not end on its error. A failed install prints the reason,
    // then the whole list of available agents, then a tip — so the last line
    // is "Tip: Run codemie install to see all agents", which tells the user
    // nothing about what went wrong. Its own error glyphs mark the real line;
    // the last of them is the most specific.
    const failures = lines.filter((l) => ERROR_LINE.test(l));
    if (failures.length) return failures[failures.length - 1].replace(ERROR_GLYPH, '').trim();
    const lastNonEmpty = [...lines].reverse().find((l) => l && l.trim());
    return lastNonEmpty || accumulated || 'The command failed with no output.';
  }

  // No --supported: the flag pushes every agent down the native-installer path,
  // which only claude and kimi have URLs for, so it fails for the eight that
  // install through npm ("No installer URLs configured for native
  // installation"). A bare install already resolves to the supported version
  // for claude and codex, the two the CLI treats as version-sensitive, and it
  // passes no explicit version, which is what the ticket forbids. See
  // .ai-run/decisions/2026-09-21-EPMCDME-14514-install-without-supported.md.
  const onInstall = (agent, opts) => runAction(agent, `codemie install ${agent.command}`, opts);
  const onUpdate = (agent) => runAction(agent, `codemie update ${agent.command}`, { note: true, verb: 'Updating' });
  const onRemove = (agent) => runAction(agent, `codemie uninstall ${agent.command}`, { verb: 'Removing' });

  return {
    run: () => load({ silent: false }),
    refresh: () => load({ silent: true }),
    getLastAgents: () => lastAgents,
    select,
    // Home's checklist installs through the same action the screen's own
    // button runs, so there is one install path and one set of failure
    // messages, not a second copy of the command.
    install: (agent, onLine) => onInstall(agent, { onLine }),
  };
}
