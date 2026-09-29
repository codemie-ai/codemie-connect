// Joins ui/agents-parse.js records with ui/agents-update-parse.js records by
// display name. Pure: no DOM, no Tauri. An update record missing for an agent
// (the CLI omitted it, or the read failed entirely and produced []) must
// never throw and must never falsely flag that agent.
import { semverLt } from './cli-update.js';
import { BUILTIN_AGENT_COMMAND } from './home-state.js';

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

// A version above what CodeMie supports (Claude Code only): the CLI keeps it
// and offers no update. Anything that is not plain X.Y.Z is never "newer".
function isNewerThanSupported(agent, rec) {
  if (agent.command === BUILTIN_AGENT_COMMAND || !rec) return false;
  if (!PLAIN_VERSION.test(rec.current || '') || !PLAIN_VERSION.test(rec.latest || '')) return false;
  return semverLt(rec.latest, rec.current);
}

export function joinUpdateStatus(agents, updateRecords = []) {
  const byName = new Map(updateRecords.map((r) => [r.displayName, r]));
  return agents.map((a) => {
    const rec = byName.get(a.name);
    return {
      ...a,
      updateAvailable: !!rec?.updateAvailable,
      current: rec?.current,
      latest: rec?.latest,
      newerThanSupported: isNewerThanSupported(a, rec),
    };
  });
}
