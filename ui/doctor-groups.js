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
    rows.push({
      group: 'codemie',
      label: 'Everything CodeMie needs to run is included',
      status: worst(runtime),
    });
  }
  for (const [name, items] of byName) {
    const status = worst(items);
    const failing = items.find((r) => r.status === 'error' || r.status === 'warn');
    const deepLink = DEEP_LINKS[name];
    let action;
    if (status === 'fail' && deepLink) action = { kind: 'navigate', ...deepLink };
    else if (status === 'fail' && failing?.hint) action = { kind: 'recheck', label: 'Check again' };
    rows.push({
      group: GROUP_BY_NAME[name] || 'codemie',
      label: name,
      status,
      remedyText: status === 'fail' ? failing?.hint : undefined,
      action,
    });
  }
  const passing = rows.filter((r) => r.status === 'pass').length;
  return { rows, summary: { passing, total: rows.length } };
}
