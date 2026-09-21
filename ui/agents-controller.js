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
import { renderAgents, showLoading, showRunError } from './agents-ui.js';

// Any of these substrings in an action's accumulated streamed text means the
// failure was a lack of network access, not something the CLI's own error
// text should be shown for.
const NO_NETWORK = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i;

// agent.command is parsed unvalidated from `codemie list` stdout and
// interpolated straight into a shell string the Rust side runs via
// `/bin/zsh -lc`. A command that fails this check is never handed to
// runStream, however it got corrupted.
const SAFE_COMMAND = /^[A-Za-z0-9._-]+$/;

export function createAgentsController({ container, runCapture, runStream, stepsUi, onFailure, onResult } = {}) {
  // A second run() while the first is in flight is a no-op, as on Health: the
  // read is cheap but re-rendering under a half-finished one loses row state.
  let running = false;
  let lastAgents = null;
  // command -> the message an action's failure left on that row, merged onto
  // the agent record on every load() so a refresh never drops it.
  const rowErrors = new Map();

  // silent: true is what a post-action refresh uses — it skips showLoading so
  // the container is never blanked outside the very first load.
  async function load({ silent }) {
    if (running) return;
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
        showRunError(container, 'The agent list came back empty, so nothing can be shown here.', () => load({ silent: false }));
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
        return message ? { ...a, actionStatus: 'error', actionMessage: message } : a;
      });

      lastAgents = agents;
      renderAgents(container, { agents }, { stepsUi, onInstall, onUpdate, onRemove });
      onResult?.(agents);
    } catch (e) {
      showRunError(container, String((e && e.message) || e), () => load({ silent: false }));
      lastAgents = null;
      onFailure?.();
    } finally {
      running = false;
    }
  }

  async function runAction(agent, command) {
    if (!SAFE_COMMAND.test(agent.command)) {
      rowErrors.set(agent.command, 'This agent’s command name is not safe to run and was blocked.');
      await load({ silent: true });
      return;
    }
    rowErrors.delete(agent.command);
    stepsUi.setStatus(agent.command, 'ACTIVE');
    stepsUi.startSpinner(agent.command);
    const lines = [];
    try {
      const { code } = await runStream(command, (text) => {
        lines.push(text);
        stepsUi.setSubtitle(agent.command, text);
      });
      if (code !== 0) {
        rowErrors.set(agent.command, messageFor(lines));
      }
    } catch (e) {
      lines.push(String((e && e.message) || e));
      rowErrors.set(agent.command, messageFor(lines));
    } finally {
      await load({ silent: true });
    }
  }

  function messageFor(lines) {
    const accumulated = lines.join('\n');
    if (NO_NETWORK.test(accumulated)) return 'Installing needs a connection.';
    const lastNonEmpty = [...lines].reverse().find((l) => l && l.trim());
    return lastNonEmpty || accumulated;
  }

  const onInstall = (agent) => runAction(agent, `codemie install ${agent.command} --supported`);
  const onUpdate = (agent) => runAction(agent, `codemie update ${agent.command}`);
  const onRemove = (agent) => runAction(agent, `codemie uninstall ${agent.command}`);

  return {
    run: () => load({ silent: false }),
    refresh: () => load({ silent: true }),
    getLastAgents: () => lastAgents,
  };
}
