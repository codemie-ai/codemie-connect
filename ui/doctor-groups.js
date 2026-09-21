// Groups parseDoctorOutput() records into the Health screen's three-group
// model (account / tools / codemie) and attaches a remedy action to each
// failing row: a deep-link where one exists, otherwise a plain recheck when
// there's a hint to act on, otherwise no action at all.
const RUNTIME_NAMES = new Set(['Node Version', 'Npm', 'Python', 'Uv']);
const GROUP_BY_NAME = {
  'Active Profile': 'account',
  'JWT Auth': 'account',
  'AWS CLI': 'tools',
  Agents: 'tools',
  Workflows: 'codemie',
  Frameworks: 'codemie',
  Provider: 'codemie',
};
const DEEP_LINKS = { Agents: { view: 'agents', label: 'Go to Agents' } };

const worst = (items) => (items.some((r) => r.status === 'error' || r.status === 'warn') ? 'fail' : 'pass');

// Builds the remedyText/action pair for a row from every failing item in the
// group, not just the first (CR-002), so a check with two distinct failures
// (e.g. Agents in the fixtures) surfaces both hints instead of silently
// dropping the second. deepLink (when given) always wins the action slot;
// otherwise a Check-again action is offered whenever any failing item has a
// hint to act on.
function remedyFor(items, status, deepLink) {
  if (status !== 'fail') return { remedyText: undefined, action: undefined };
  const failing = items.filter((r) => r.status === 'error' || r.status === 'warn');
  const hints = [...new Set(failing.map((r) => r.hint).filter(Boolean))];
  const remedyText = hints.length ? hints.join('\n') : undefined;
  let action;
  if (deepLink) action = { kind: 'navigate', ...deepLink };
  else if (hints.length) action = { kind: 'recheck', label: 'Check again' };
  return { remedyText, action };
}

export function groupDoctorResults(records) {
  const runtime = records.filter((r) => RUNTIME_NAMES.has(r.name));
  const rest = records.filter((r) => !RUNTIME_NAMES.has(r.name));
  const byName = new Map();
  for (const r of rest) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }

  const rows = [];
  if (runtime.length) {
    // CR-001: the collapsed row gets the same remedy treatment as a per-name
    // row — previously it was pushed with only {group, label, status} and a
    // failing runtime check (a missing binary) had no visible remedy at all.
    const status = worst(runtime);
    const { remedyText, action } = remedyFor(runtime, status, undefined);
    rows.push({
      group: 'codemie',
      label: 'Everything CodeMie needs to run is included',
      status,
      remedyText,
      action,
    });
  }
  for (const [name, items] of byName) {
    const status = worst(items);
    const { remedyText, action } = remedyFor(items, status, DEEP_LINKS[name]);
    rows.push({
      group: GROUP_BY_NAME[name] || 'codemie',
      label: name,
      status,
      remedyText,
      action,
    });
  }
  const passing = rows.filter((r) => r.status === 'pass').length;
  return { rows, summary: { passing, total: rows.length } };
}
