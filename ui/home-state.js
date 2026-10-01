// Home's state, derived from the four sources it reads and nothing else:
//   config  EPMCDME-14511's reader: { state: 'no-configuration'|'valid'|'broken',
//           profile, model, project, account }
//   auth    EPMCDME-14515's status: { state: 'signed_in'|'not_signed_in'|
//           'unknown'|'no_profile', detail }
//   agents  parseAgentList() records, or undefined while the list is being
//           read, or null when the read failed
//   health  the Health controller's getLastResult(): { rows, summary,
//           checkedAt } or null
//   connection  `codemie proxy status --json` read as { running }, or
//           undefined while it is being read, or null when the read failed
//
// Pure: no DOM, no Tauri. The screen renders what comes back.
import { StepStatus } from './models.js';

export const HOME_ITEMS = Object.freeze([
  { id: 'sign-in', title: 'Sign in with your EPAM account' },
  { id: 'model', title: 'Choose how CodeMie reaches a model' },
  { id: 'agent', title: 'Install a tool' },
  { id: 'health', title: 'Verify health' },
]);

const item = (def, status, subtitle) => ({ id: def.id, title: def.title, status, subtitle: subtitle || '' });
const clock = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// The CLI's own line is "Auth Status │ ✓ Authenticated (expires in 22h 9m)",
// with a box-drawing bar; the checklist and the identity bar both keep the
// part that says something: "Authenticated (expires in 22h 9m)".
export const signedInDetail = (detail) => (detail || '').replace(/^Auth Status\s*[|│]\s*/, '').replace(/^✓\s*/, '').trim() || 'Signed in';

function signInItem(def, auth) {
  // Not read yet: say so, rather than offer Sign in to someone signed in.
  if (!auth) return item(def, StepStatus.ACTIVE, 'Checking…');
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
  if (state === 'broken' && (config.profile || '').trim()) return item(def, StepStatus.WARNING, 'Your profile is no longer working');
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
  if (agents === null) return item(def, StepStatus.PENDING, 'Could not read the tool list');
  const installed = agents.filter((a) => a.installed && a.command !== BUILTIN_AGENT_COMMAND);
  if (installed.length) {
    return item(def, StepStatus.COMPLETE, `Already installed: ${installed.map((a) => a.name).join(' · ')}`);
  }
  const available = agents.filter((a) => !a.installed).length;
  return item(def, StepStatus.PENDING, `${available} available`);
}

// "Passed" is no failing row. A warning (an agent the CLI has advice on) is
// not a reason to keep the checklist on screen forever.
function healthItem(def, health, running, failed) {
  if (!health && running) return item(def, StepStatus.ACTIVE, 'Checking…');
  // A check that could not finish: the row's Open Health leads to the error and
  // its retry, since the sidebar's Health stays locked until the checklist is done.
  if (!health && failed) return item(def, StepStatus.ERROR, 'The check did not finish');
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
    !auth ? { text: 'checking', tone: 'muted' }
    : state === 'signed_in' ? { text: 'active', tone: 'good' }
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

function healthCard(health, running) {
  if (!health && running) return { id: 'health', title: 'Health', badge: { text: 'checking', tone: 'muted' }, line: 'Checking…', note: '' };
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
    return { id: 'agents', title: 'Tools', badge: { text: 'unknown', tone: 'muted' }, line: agents === null ? 'Could not read the tool list' : 'Checking…', note: '' };
  }
  const installed = agents.filter((a) => a.installed);
  return {
    id: 'agents',
    title: 'Tools',
    badge: { text: `${installed.length} of ${agents.length}`, tone: installed.length ? 'good' : 'warn' },
    line: installed.length ? installed.map((a) => a.name).join(' · ') : 'None installed yet',
    note: '',
  };
}

// `codemie proxy status --json` says "healthy" or "unhealthy" while the proxy
// runs and "stopped" when it does not (CLI 0.15.2, cli/commands/proxy); it has
// no "running". The CLI can print its migration notes before the JSON on a
// first run. Throws on JSON it cannot parse, which the caller shows as unknown.
export function connectionFromStatus(stdout) {
  const json = stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1);
  if (!json) return null;
  const { status } = JSON.parse(json);
  return { running: status === 'healthy' || status === 'unhealthy', healthy: status === 'healthy' };
}

// Claude Desktop is the one app Connections connects today, through the CLI's
// local proxy: connected while `codemie proxy status` says it is running.
function connectionsCard(connection) {
  if (connection === undefined) return { id: 'connections', title: 'Connections', badge: { text: 'checking', tone: 'muted' }, line: 'Claude Desktop', note: '' };
  if (connection === null) return { id: 'connections', title: 'Connections', badge: { text: 'unknown', tone: 'muted' }, line: 'Could not read the connection', note: '' };
  if (connection.running && connection.healthy === false) return { id: 'connections', title: 'Connections', badge: { text: 'not responding', tone: 'warn' }, line: 'Claude Desktop', note: '' };
  return connection.running
    ? { id: 'connections', title: 'Connections', badge: { text: '1 connected', tone: 'good' }, line: 'Claude Desktop', note: '' }
    : { id: 'connections', title: 'Connections', badge: { text: 'not connected', tone: 'muted' }, line: 'Claude Desktop', note: '' };
}

// Whether Home should start the health check itself, when it has not run this
// session. On the checklist: once the steps before it are done, since finishing
// setup used to leave the user on a checklist that just waited for a click on
// its last step. On the status cards: straight away, since the result is not
// kept between launches and the Health card said "unknown" after every restart
// (EPMCDME-15388). Not before the sign-in status is read: until then a
// returning user counts as done, and a lapsed sign-in would bring the checklist
// back with a check already run on it.
export function autoHealthCheck(state) {
  if (!state) return false;
  const health = state.items.find((i) => i.id === 'health');
  if (!health || health.status !== StepStatus.PENDING) return false;
  if (state.done) return state.authKnown;
  return state.items.filter((i) => i.id !== 'health').every((i) => i.status === StepStatus.COMPLETE);
}

// What Home's Sign in does. `codemie profile login` opens the browser for the
// CodeMie URL a profile records, and with no profile it refuses ("No AI/Run
// CodeMie URL configured", measured 2026-09-23) -- so until there is a profile,
// Sign in opens guided setup, whose own steps sign the user in in the browser.
export function signInAction({ config, auth } = {}) {
  const noProfile = (auth && auth.state === 'no_profile') || !config || config.state === 'no-configuration' || config.state === 'broken';
  return noProfile ? 'setup' : 'login';
}

// Signed in, or a provider that reports no sign-in status: nothing to fix.
const authUsable = (auth) => !!auth && (auth.state === 'signed_in' || auth.state === 'unknown');

// 'expired': the profile resolves but its sign-in lapsed. 'dangling': the
// config names a profile the CLI no longer has. An empty name is "no profile"
// (the CLI leaves activeProfile "" after the last delete): the checklist, not
// a panel. A read still in flight is never broken.
export function brokenKind({ config, auth } = {}) {
  if (!auth || !config || !(config.profile || '').trim()) return null;
  if (config.state === 'broken') return 'dangling';
  if (config.state === 'valid' && auth.state === 'not_signed_in') return 'expired';
  return null;
}

export const isBroken = (s) => brokenKind(s) !== null;

const BROKEN_TITLE = 'Your profile is no longer working';

export function brokenCopy({ config, auth } = {}) {
  const kind = brokenKind({ config, auth });
  if (!kind) return null;
  const name = config.profile.trim();
  if (kind === 'expired') {
    return {
      title: BROKEN_TITLE,
      body: `CodeMie signed you out \u2014 the sign-in for ${name} expired. Sign in again to keep this profile, or delete it and set up a new one.`,
      actions: ['signin', 'delete'],
    };
  }
  return {
    title: BROKEN_TITLE,
    body: `${name} is set as your profile but it no longer exists. Set it up again to keep going.`,
    actions: ['setup'],
  };
}

// `onboarded` is whether the checklist has ever been finished on this machine
// (the renderer remembers it). Health is read fresh each time the app opens, so
// without it a user who finished setup yesterday is back on the checklist, with
// the sidebar locked, until they run the check again.
export function deriveHome({ config, auth, agents, health, connection, onboarded = false, healthRunning = false, healthFailed = false } = {}) {
  const [signIn, model, agent, healthDef] = HOME_ITEMS;
  const items = [signInItem(signIn, auth), modelItem(model, config), agentItem(agent, agents), healthItem(healthDef, health, healthRunning, healthFailed)];
  const complete = items.every((i) => i.status === StepStatus.COMPLETE);
  // Once setup has finished, a lapsed sign-in brings the checklist back; a
  // broken profile shows its panel instead. An auth read still in flight is not
  // a lapsed sign-in.
  const signedOut = !!auth && !authUsable(auth);
  const broken = brokenKind({ config, auth });
  const done = !broken && (complete || (onboarded && !signedOut));
  return {
    items,
    done,
    broken,
    authKnown: !!auth,
    // The sidebar locks only for a first setup, never for a user who has
    // finished it once and has merely been signed out since.
    unlocked: done || onboarded,
    // The records themselves, for the picker item 3 expands into. Passed
    // through unchanged, including `undefined` (not read yet) and `null` (the
    // read failed): a picker that turned both into an empty list would tell
    // the user every agent was already installed.
    agents,
    cards: [profileCard(config, auth), healthCard(health, healthRunning), agentsCard(agents), connectionsCard(connection)],
  };
}
