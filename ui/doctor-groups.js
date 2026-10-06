// Turns parseDoctorOutput() records into the Health screen's rows: grouped by
// who can act on a problem (account / tools / codemie), worded in plain
// language, each problem carrying its remedy.
//
// Section names and messages are the CLI's own, read from real
// `codemie doctor` output (ui/test/fixtures/doctor/). A section this file does
// not know still renders, under "CodeMie itself" and in the CLI's wording, so a
// check the CLI adds later is shown rather than dropped.
import { semverLt } from './cli-update.js';

const RUNTIME = new Set(['Node.js', 'npm', 'Python', 'uv']);
const AGENTS = 'Installed Agents';

// `pass` is the row's label while nothing is wrong. A problem row is labelled
// with the CLI's own message instead, so the words describe what happened.
const SECTIONS = {
  'Active Profile': { group: 'account', pass: 'Your profile is set up' },
  'JWT Authentication': { group: 'account', pass: 'Your JWT sign-in is valid' },
  'AWS CLI': { group: 'tools', pass: 'AWS CLI' },
  'Repository & Workflows': { group: 'tools', pass: 'Repository and workflows' },
  Frameworks: { group: 'tools', pass: 'Frameworks' },
};
// The provider section is named after the provider ("CodeMie SSO Provider"),
// or "Provider Check Error" when the check itself threw.
const PROVIDER = { group: 'account', pass: 'CodeMie can reach the model service' };

const isProblem = (r) => r.status === 'error' || r.status === 'warn';
// The item a problem row is named after: the error when there is one, since a
// warning beside it ("SSO Authentication required") is usually its symptom.
const worstOf = (items) => items.find((r) => r.status === 'error') || items.find(isProblem);

function statusOf(items) {
  if (items.some((r) => r.status === 'error')) return 'fail';
  if (items.some((r) => r.status === 'warn')) return 'warn';
  return 'pass';
}

// "Version 0.12.0 (Homebrew 2026-07-28 …)" -> "0.12.0"
const versionOf = (message) => message.replace(/^Version\s+/, '').split(/\s+/)[0];
// "CodeGraph (1.5.0)" -> "CodeGraph 1.5.0"
const unparen = (text) => text.replace(/\s*\(([^)]+)\)/, ' $1');

function detailFor(name, items) {
  if (name === 'Active Profile') {
    const value = (prefix) => {
      const hit = items.find((r) => r.message.startsWith(prefix));
      return hit && hit.message.slice(prefix.length).trim();
    };
    return [value('Active Profile:'), value('Model:')].filter(Boolean).join(' · ') || undefined;
  }
  if (name.includes('Provider')) {
    const session = items.find((r) => /^Session expires/.test(r.message));
    return session ? session.message : undefined;
  }
  if (name === 'AWS CLI') return versionOf(items[0].message);
  if (name === 'Frameworks') {
    const installed = items.filter((r) => r.status === 'ok').map((r) => unparen(r.message));
    return installed.join(' · ') || undefined;
  }
  return undefined;
}

// A problem's remedy: what to do, the action that does it, and, when the words
// are ours, the CLI's own hint kept underneath (remedyDetail).
function remedyFor(items) {
  const problems = items.filter(isProblem);
  const hints = [...new Set(problems.map((r) => r.hint).filter(Boolean))];
  const remedyDetail = hints.join('\n') || undefined;
  // No profile at all (the CLI says "Run: codemie setup"). The app's own
  // guided setup is that command, so the row opens it.
  if (hints.some((h) => /\bcodemie setup\b/.test(h))) {
    return {
      remedyText: 'Set up CodeMie to create your profile.',
      remedyDetail,
      action: { kind: 'navigate', view: 'setup', label: 'Set up CodeMie' },
    };
  }
  if (hints.some((h) => h.includes('codemie profile login'))) {
    return {
      remedyText: 'Sign in again to restore your CodeMie session.',
      remedyDetail,
      action: { kind: 'signin', label: 'Sign in again' },
    };
  }
  // "Cannot connect to provider" / "Provider unreachable": the CLI's hint here
  // is the raw network error, which says what broke but not what to do.
  if (problems.some((r) => /unreachable|cannot connect/i.test(r.message))) {
    return {
      remedyText: 'This is usually the network or the VPN. Check your connection, then check again.',
      remedyDetail,
      action: { kind: 'recheck', label: 'Check again' },
    };
  }
  if (hints.length) {
    return { remedyText: hints.join('\n'), remedyDetail: undefined, action: { kind: 'recheck', label: 'Check again' } };
  }
  return { remedyText: undefined, remedyDetail: undefined, action: undefined };
}

function sectionRow(name, items) {
  const known = SECTIONS[name] || (name.includes('Provider') ? PROVIDER : { group: 'codemie', pass: name });
  const status = statusOf(items);
  const row = { group: known.group, status, remedyText: undefined, action: undefined };
  if (status === 'pass') {
    row.label = known.pass;
    row.detail = detailFor(name, items);
    return row;
  }
  row.label = worstOf(items).message;
  row.detail = undefined;
  return Object.assign(row, remedyFor(items));
}

// Each installed agent is its own check with its own remedy, so each gets a
// row: "Claude Code (2.1.269)", or "OpenCode CLI (1.18.31) - CodeMie
// recommends …" when the CLI has something to say about it.
// The CLI's built-in agent comes with the CLI, so nothing on the Agents screen
// can update it, yet doctor warns about it every time ("CodeMie recommends
// vlatest"). Only that warning is dropped; a real failure still shows.
const BUILTIN_AGENT = /^CodeMie Code\b/;

// Doctor also warns when the installed version is newer than the one it
// recommends ("GitHub Copilot CLI (1.0.89) - CodeMie recommends v1.0.83",
// EPMCDME-15393). Nothing on the Tools screen goes back to an older version, so
// that is not a problem to send the user anywhere for. Returns the recommended
// version in that case.
function newerThanRecommended(title, detail) {
  const have = title.match(/\((\d+\.\d+\.\d+)\)/)?.[1];
  const want = detail?.match(/CodeMie recommends v(\d+\.\d+\.\d+)$/)?.[1];
  return have && want && semverLt(want, have) ? want : null;
}

function agentRow(item) {
  const [title, ...rest] = item.message.split(/\s+-\s+/);
  if (BUILTIN_AGENT.test(title) && item.status === 'warn') {
    return { group: 'tools', label: unparen(title), detail: 'built into the CLI', status: 'pass', remedyText: undefined, action: undefined };
  }
  const status = statusOf([item]);
  const detail = rest.join(' - ') || undefined;
  const recommended = item.status === 'warn' ? newerThanRecommended(title, detail) : null;
  if (recommended) {
    return { group: 'tools', label: unparen(title), detail: `newer than the v${recommended} CodeMie recommends`, status: 'pass', remedyText: undefined, action: undefined };
  }
  const row = { group: 'tools', label: unparen(title), detail, status, remedyText: undefined, action: undefined };
  if (status !== 'pass') {
    row.remedyText = 'Open the Tools screen to check for an update.';
    row.action = { kind: 'navigate', view: 'agents', label: 'Go to Tools' };
  }
  return row;
}

function runtimeRow(items) {
  const status = statusOf(items);
  const row = { group: 'codemie', status, detail: undefined, remedyText: undefined, action: undefined };
  if (status === 'pass') {
    row.label = 'Everything CodeMie needs to run is in place';
    row.detail = items.map((r) => `${r.name} ${versionOf(r.message)}`).join(' · ');
    return row;
  }
  const bad = worstOf(items);
  row.label = `${bad.name}: ${bad.message}`;
  return Object.assign(row, remedyFor(items));
}

export function groupDoctorResults(records) {
  const sections = new Map();
  for (const r of records) {
    if (!sections.has(r.name)) sections.set(r.name, []);
    sections.get(r.name).push(r);
  }

  const rows = [];
  const runtime = records.filter((r) => RUNTIME.has(r.name));
  if (runtime.length) rows.push(runtimeRow(runtime));

  for (const [name, items] of sections) {
    if (RUNTIME.has(name)) continue;
    if (name === AGENTS) {
      // "No agents installed (CodeMie Code is built-in)" is a note, not an
      // agent that passed; a tick beside it would say the opposite.
      items.filter((item) => item.status !== 'info').forEach((item) => rows.push(agentRow(item)));
      continue;
    }
    // A section the CLI only reported on ("Not using JWT authentication
    // (skipped)", "Not a git repository") is not a check that passed or failed.
    if (items.every((r) => r.status === 'info')) continue;
    rows.push(sectionRow(name, items));
  }

  const passing = rows.filter((r) => r.status === 'pass').length;
  return { rows, summary: { passing, total: rows.length } };
}
