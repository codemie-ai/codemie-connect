// Home's state, derived from the four sources it reads and nothing else:
//   config  EPMCDME-14511's reader: { state: 'no-configuration'|'valid'|'broken',
//           profile, model, project, account }
//   auth    EPMCDME-14515's status: { state: 'signed_in'|'not_signed_in'|
//           'unknown'|'no_profile', detail }
//   agents  parseAgentList() records, or undefined while the list is being
//           read, or null when the read failed
//   health  the Health controller's getLastResult(): { rows, summary,
//           checkedAt } or null
//
// Pure: no DOM, no Tauri. The screen renders what comes back.
import { StepStatus } from './models.js';

export const HOME_ITEMS = Object.freeze([
  { id: 'sign-in', title: 'Sign in with your EPAM account' },
  { id: 'model', title: 'Choose how CodeMie reaches a model' },
  { id: 'agent', title: 'Install an agent' },
  { id: 'health', title: 'Verify health' },
]);

const item = (def, status, subtitle) => ({ id: def.id, title: def.title, status, subtitle: subtitle || '' });
const clock = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// The CLI's own line is "Auth Status │ ✓ Authenticated (expires in 22h 9m)",
// with a box-drawing bar; the identity bar shows it whole, the checklist
// keeps the part that says something: "Authenticated (expires in 22h 9m)".
const signedInDetail = (detail) => (detail || '').replace(/^Auth Status\s*[|│]\s*/, '').replace(/^✓\s*/, '').trim() || 'Signed in';

function signInItem(def, auth) {
  const state = auth && auth.state;
  // `unknown` means the provider does not report auth status, not that the
  // user is signed out. The profile is usable, which is what the item asks.
  if (state === 'signed_in') return item(def, StepStatus.COMPLETE, signedInDetail(auth.detail));
  if (state === 'unknown') return item(def, StepStatus.COMPLETE, 'Your provider does not report sign-in status');
  return item(def, StepStatus.PENDING, 'Opens your browser');
}

function modelItem(def, config) {
  const state = config && config.state;
  if (state === 'valid') {
    return item(def, StepStatus.COMPLETE, [config.profile, config.model].filter(Boolean).join(' · '));
  }
  if (state === 'broken') return item(def, StepStatus.WARNING, 'Your profile is no longer working');
  return item(def, StepStatus.PENDING, 'Sign in with CodeMie, or bring your own key');
}

// The CLI's built-in agent ships inside the CLI package, so `codemie list`
// reports it installed on a machine where nothing has been installed at all --
// measured on a clean profile with an empty PATH, where `which codemie-code`
// finds nothing and the list still says "✓ installed". Counting it would tick
// this item before the user has done anything, which is why the step looks at
// the agents a user actually installs. See
// .ai-run/decisions/2026-09-22-EPMCDME-15189-builtin-agent-does-not-tick.md.
export const BUILTIN_AGENT_COMMAND = 'codemie-code';

function agentItem(def, agents) {
  if (agents === undefined) return item(def, StepStatus.PENDING, 'Checking…');
  if (agents === null) return item(def, StepStatus.PENDING, 'Could not read the agent list');
  const installed = agents.filter((a) => a.installed && a.command !== BUILTIN_AGENT_COMMAND);
  if (installed.length) {
    return item(def, StepStatus.COMPLETE, installed.map((a) => a.name).join(' · '));
  }
  const available = agents.filter((a) => !a.installed).length;
  return item(def, StepStatus.PENDING, `${available} available`);
}

// "Passed" is no failing row. A warning (an agent the CLI has advice on) is
// not a reason to keep the checklist on screen forever.
function healthItem(def, health) {
  if (!health) return item(def, StepStatus.PENDING, 'Not checked yet');
  const failing = health.rows.filter((r) => r.status === 'fail').length;
  const { passing, total } = health.summary;
  const when = health.checkedAt ? ` · checked at ${clock(health.checkedAt)}` : '';
  if (failing === 0) return item(def, StepStatus.COMPLETE, `${passing} of ${total} fine${when}`);
  return item(def, StepStatus.WARNING, `${failing} ${failing === 1 ? 'problem' : 'problems'} to fix${when}`);
}

function profileCard(config, auth) {
  const state = auth && auth.state;
  const badge =
    state === 'signed_in' ? { text: 'active', tone: 'good' }
    : state === 'unknown' ? { text: 'active', tone: 'good' }
    : config && config.state === 'broken' ? { text: 'needs attention', tone: 'bad' }
    : { text: 'not signed in', tone: 'warn' };
  const line = [config && config.profile, config && config.model].filter(Boolean).join(' · ');
  const note =
    state === 'unknown' ? 'Your provider does not report sign-in status'
    : config && config.project ? `Project ${config.project}`
    : '';
  return { id: 'profile', title: 'Profile', badge, line, note };
}

function healthCard(health) {
  if (!health) return { id: 'health', title: 'Health', badge: { text: 'unknown', tone: 'muted' }, line: 'Not checked yet', note: '' };
  const { passing, total } = health.summary;
  const problems = health.rows.filter((r) => r.status !== 'pass').length;
  return {
    id: 'health',
    title: 'Health',
    badge: { text: `${passing} of ${total}`, tone: problems ? 'warn' : 'good' },
    line: problems ? `${problems} ${problems === 1 ? 'thing needs' : 'things need'} attention` : 'Everything fine',
    note: health.checkedAt ? `Checked at ${clock(health.checkedAt)}` : '',
  };
}

function agentsCard(agents) {
  if (!Array.isArray(agents)) {
    return { id: 'agents', title: 'Agents', badge: { text: 'unknown', tone: 'muted' }, line: agents === null ? 'Could not read the agent list' : 'Checking…', note: '' };
  }
  const installed = agents.filter((a) => a.installed);
  return {
    id: 'agents',
    title: 'Agents',
    badge: { text: `${installed.length} of ${agents.length}`, tone: installed.length ? 'good' : 'warn' },
    line: installed.length ? installed.map((a) => a.name).join(' · ') : 'None installed yet',
    note: '',
  };
}

export function deriveHome({ config, auth, agents, health } = {}) {
  const [signIn, model, agent, healthDef] = HOME_ITEMS;
  const items = [signInItem(signIn, auth), modelItem(model, config), agentItem(agent, agents), healthItem(healthDef, health)];
  const done = items.every((i) => i.status === StepStatus.COMPLETE);
  return {
    items,
    done,
    // The records themselves, for the picker item 3 expands into. Passed
    // through unchanged, including `undefined` (not read yet) and `null` (the
    // read failed): a picker that turned both into an empty list would tell
    // the user every agent was already installed.
    agents,
    cards: [profileCard(config, auth), healthCard(health), agentsCard(agents)],
  };
}
