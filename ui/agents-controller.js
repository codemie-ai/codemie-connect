// Orchestrates the Agents screen's own read: run `codemie list` -> parse ->
// render. Split from renderer.js the way health-controller.js is, so the wiring
// is unit-testable without stubbing the whole app shell: the caller supplies
// the container, a runCapture function and a steps-ui instance, and this module
// owns neither Tauri nor the rest of the DOM.
//
// `codemie list` is this screen's data source and EPMCDME-14589's too. Each
// screen reads for itself; onResult lets the caller keep Home's copy in step
// without a second read of its own.
import { parseAgentList } from './agents-parse.js';
import { renderAgents, showLoading, showRunError } from './agents-ui.js';

export function createAgentsController({ container, runCapture, stepsUi, onFailure, onResult, actions = {} } = {}) {
  // A second run() while the first is in flight is a no-op, as on Health: the
  // read is cheap but re-rendering under a half-finished one loses row state.
  let running = false;
  let lastAgents = null;

  async function run() {
    if (running) return;
    running = true;
    showLoading(container);
    try {
      const res = await runCapture('codemie list');
      if (!res || res.code !== 0) {
        const detail = (res && (res.stderr || res.stdout)) || 'The command did not run.';
        showRunError(container, String(detail).trim(), run);
        lastAgents = null;
        onFailure?.();
        return;
      }
      const agents = parseAgentList(res.stdout);
      if (agents.length === 0) {
        // The CLI always lists agents; zero records means the output did not
        // look like a list at all, which must not render as "0 of 0 installed".
        showRunError(container, 'The agent list came back empty, so nothing can be shown here.', run);
        lastAgents = null;
        onFailure?.();
        return;
      }
      lastAgents = agents;
      renderAgents(container, { agents }, { stepsUi, ...actions });
      onResult?.(agents);
    } catch (e) {
      showRunError(container, String((e && e.message) || e), run);
      lastAgents = null;
      onFailure?.();
    } finally {
      running = false;
    }
  }

  return { run, getLastAgents: () => lastAgents };
}
