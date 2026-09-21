// Joins ui/agents-parse.js records with ui/agents-update-parse.js records by
// display name. Pure: no DOM, no Tauri. An update record missing for an agent
// (the CLI omitted it, or the read failed entirely and produced []) must
// never throw and must never falsely flag that agent.
export function joinUpdateStatus(agents, updateRecords = []) {
  const byName = new Map(updateRecords.map((r) => [r.displayName, r]));
  return agents.map((a) => ({ ...a, updateAvailable: !!byName.get(a.name)?.updateAvailable }));
}
