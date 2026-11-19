// The CodeMie service with Tauri faked: what it reads on load, when it does not, how a failed CLI
// call reaches the caller, the quit guard around operations and a retryable runtime download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodemieService } from '../workspace/codemie/service.js';
import { createRunLog } from '../workspace/codemie/run-log.js';

const LIST = `📦 Available Agents:

  CodeMie Code (0.0.47)
    Command: codemie-code
    Status: ✓ installed
    CodeMie Code - AI coding assistant

  Claude Code (2.1.269)
    Command: claude
    Status: ✓ installed
    Claude Code - official Anthropic CLI tool

  Gemini CLI
    Command: gemini
    Status: not installed
    Google Gemini CLI - AI coding assistant

🛠️  Available Frameworks:
`;

function harness({ capture = {}, direct = {}, stream = {}, setupRunning = () => false, clock } = {}) {
  const calls = [];
  const listeners = new Map();
  let t = 0;
  const now = clock || (() => t);
  const emit = (event, payload) => (listeners.get(event) || []).forEach((fn) => fn({ payload }));
  const captureFor = (cmd) => {
    const key = Object.keys(capture).find((k) => cmd.startsWith(k));
    const r = key ? capture[key] : { code: 0, stdout: '', stderr: '' };
    return typeof r === 'function' ? r(cmd) : r;
  };
  const invoke = async (name, args = {}) => {
    calls.push({ name, args });
    if (name === 'run_capture') return captureFor(args.cmd);
    if (name === 'run_stream') {
      const key = Object.keys(stream).find((k) => args.cmd.startsWith(k));
      const s = key ? stream[key] : { code: 0, lines: [] };
      for (const [text, tag = 'stdout'] of s.lines || []) emit('engine:cmd-line', { id: args.streamId, text, tag });
      return s.code;
    }
    if (name in direct) {
      const v = direct[name];
      return typeof v === 'function' ? v(args) : v;
    }
    return null;
  };
  const listen = async (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => listeners.set(event, listeners.get(event).filter((f) => f !== fn));
  };
  const runLog = createRunLog();
  const defaults = {
    read_codemie_profiles: { state: 'valid', active: 'prod', account: 'a@b.c', profiles: [{ name: 'prod', provider: 'ai-run-sso' }] },
    check_profile_status: { state: 'signed_in', detail: '', code: 0 },
    codemie_app_states: [{ id: 'claude-desktop', installed: true, configured: false }],
  };
  for (const [k, v] of Object.entries(defaults)) if (!(k in direct)) direct[k] = v;
  if (!Object.keys(capture).some((k) => 'codemie list'.startsWith(k))) capture['codemie list'] = { code: 0, stdout: LIST, stderr: '' };
  const svc = createCodemieService({ invoke, listen, runLog, platform: 'macos', now, setupRunning });
  svc.state.runtime.state = 'ready';
  return { svc, calls, runLog, emit, advance: (ms) => { t += ms; } };
}

const names = (calls) => calls.map((c) => (c.name === 'run_capture' ? `run_capture:${c.args.cmd.split(' < ')[0]}` : c.name));

test('load_reads_everything_once', async () => {
  const h = harness();
  await h.svc.load();
  assert.deepEqual(names(h.calls).sort(), [
    'check_profile_status', 'codemie_app_states', 'read_codemie_profiles',
    'run_capture:codemie list', 'run_capture:codemie proxy status --json', 'run_capture:codemie update --check',
  ]);
  assert.equal(h.svc.state.loaded, true);
  assert.deepEqual(h.svc.state.agents.map((a) => [a.command, a.installed]), [['codemie-code', true], ['claude', true], ['gemini', false]]);
  assert.equal(h.svc.state.config.active, 'prod');
  h.calls.length = 0;
  h.advance(4000);
  await h.svc.load();
  assert.deepEqual(h.calls, []);
  h.advance(2000);
  await h.svc.load();
  assert.ok(h.calls.length > 0, 'reads again after 5 s');
});

// Review finding 4b: a forced reload (after an install) must not return a read that started before it.
test('forced_load_during_a_load_reads_again', async () => {
  let release;
  let reads = 0;
  const h = harness({ direct: { read_codemie_profiles: async () => { reads++; if (reads === 1) await new Promise((r) => { release = r; }); return { state: 'valid', active: 'prod', profiles: [{ name: 'prod' }] }; } } });
  const first = h.svc.load();
  await new Promise((r) => setImmediate(r));
  const forced = h.svc.load({ force: true });
  release();
  await first;
  await forced;
  assert.equal(reads, 2);
});

test('load_skips_config_while_setup_runs', async () => {
  const h = harness({ setupRunning: () => true });
  await h.svc.load({ force: true });
  assert.ok(!h.calls.some((c) => c.name === 'read_codemie_profiles'));
});

test('failed_list_marks_agents_unreadable', async () => {
  const h = harness({ capture: { 'codemie list': { code: 1, stdout: '', stderr: 'boom' } } });
  await h.svc.load();
  assert.equal(h.svc.state.agents, null);
});

test('rename_refuses_unsafe_names', async () => {
  const h = harness();
  await assert.rejects(() => h.svc.renameProfile('prod', 'a b'));
  assert.ok(!h.calls.some((c) => c.name === 'run_capture'));
});

test('run_failure_carries_output', async () => {
  const h = harness({ capture: { 'codemie profile switch': { code: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' } } });
  const err = await h.svc.switchProfile('staging').catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.output, /ETIMEDOUT/);
  assert.equal(err.code, 1);
  assert.match(err.message, /needs a connection/);
  assert.equal(h.runLog.list().at(-1).code, 1);
});

test('busy_flag_wraps_operations', async () => {
  const h = harness({ stream: { 'codemie install gemini': { code: 0, lines: [['- Installing Gemini CLI'], ['✓ Gemini CLI installed']] } } });
  await h.svc.installAgent('gemini');
  const busy = h.calls.filter((c) => c.name === 'workspace_installer_busy').map((c) => c.args.busy);
  assert.deepEqual(busy, [true, false]);
  const installAt = h.calls.findIndex((c) => c.name === 'run_stream');
  assert.ok(installAt > h.calls.findIndex((c) => c.name === 'workspace_installer_busy'));
  assert.match(h.runLog.text(), /Gemini CLI installed/);
});

test('hold_keeps_the_quit_guard_across_nested_operations', async () => {
  const h = harness({ stream: { 'codemie install claude': { code: 0, lines: [] } } });
  await h.svc.hold(async () => {
    await h.svc.installAgent('claude');
    assert.equal(h.svc.busy(), true, 'still held after the inner install ends');
  });
  const busy = h.calls.filter((c) => c.name === 'workspace_installer_busy').map((c) => c.args.busy);
  assert.deepEqual(busy, [true, false]);
});

test('install_failure_without_output_keeps_message', async () => {
  const h = harness({ stream: { 'codemie install gemini': { code: 1, lines: [] } } });
  const err = await h.svc.installAgent('gemini').catch((e) => e);
  assert.equal(err.output, '');
  assert.deepEqual(h.svc.state.errors.gemini, { message: err.message, output: '' });
  assert.equal(h.svc.state.busy.gemini, undefined);
});

test('one_agent_action_at_a_time', async () => {
  const h = harness();
  const first = h.svc.installAgent('gemini');
  // While the first install is in flight a second one is refused: two npm installs into one
  // prefix at once can leave both broken.
  assert.equal(h.svc.state.busy.gemini, true);
  await assert.rejects(() => h.svc.installAgent('codex'), /still being worked on/);
  await first;
  assert.equal(h.svc.state.busy.gemini, undefined);
});

test('runtime_failure_is_retryable', async () => {
  let attempts = 0;
  const h = harness({ direct: { ensure_runtime: () => { attempts++; if (attempts === 1) throw 'download failed: timeout'; return null; } } });
  h.svc.state.runtime.state = 'unknown';
  await h.svc.ensureRuntime().catch(() => {});
  assert.equal(h.svc.state.runtime.state, 'failed');
  assert.equal(h.svc.state.runtime.network, true);
  await h.svc.ensureRuntime();
  assert.equal(h.svc.state.runtime.state, 'ready');
});

test('runtime_progress_moves_fraction', async () => {
  const h = harness({ direct: { ensure_runtime: () => { h.emit('runtime:progress', { phase: 'node', fraction: 0.3 }); return null; } } });
  const seen = [];
  h.svc.subscribe(() => seen.push(h.svc.state.runtime.fraction));
  await h.svc.ensureRuntime();
  assert.ok(seen.includes(0.3));
});

test('sign_in_error_line_rejects_even_on_exit_zero', async () => {
  const h = harness({ stream: { 'codemie profile login': { code: 0, lines: [['❌ No CodeMie URL configured']] } } });
  await assert.rejects(() => h.svc.signIn('https://codemie.acme.com'), /No CodeMie URL configured/);
});

test('connect_apps_sends_every_flag_once', async () => {
  const h = harness();
  await h.svc.connectApps(['claude-desktop', 'codex-desktop'], 'prod');
  const connect = h.calls.filter((c) => c.name === 'run_capture' && c.args.cmd.startsWith('codemie proxy connect'));
  assert.equal(connect.length, 1);
  assert.match(connect[0].args.cmd, /--claude-desktop --codex-desktop --profile prod --silent/);
  await assert.rejects(() => h.svc.disconnectApp('claude-desktop'));
});

test('doctor_marks_agents_below_minimum', async () => {
  const doctor = [
    'Installed Agents:',
    '  ✗ Claude Code (2.1.0) - Version 2.1.0 is below the minimum 2.1.269',
    '',
  ].map((l) => [l]);
  const h = harness({ stream: { 'codemie doctor': { code: 1, lines: doctor } } });
  await h.svc.load();
  await h.svc.runDoctor();
  assert.ok(h.svc.state.health.rows.length >= 1);
  assert.equal(h.svc.state.agents.find((a) => a.command === 'claude').belowMinimum, true);
});

test('remove_notes_a_copy_outside_codemie', async () => {
  const h = harness({ capture: { 'command -v claude': { code: 0, stdout: '/opt/homebrew/bin/claude\n', stderr: '' } } });
  await h.svc.load();
  await h.svc.removeAgent('claude');
  const claude = h.svc.state.agents.find((a) => a.command === 'claude');
  assert.match(claude.note, /still installed at \/opt\/homebrew\/bin\/claude, outside CodeMie/);
});

test('an_agent_starts_in_connects_terminal_or_the_terminal_app', async () => {
  const h = harness();
  await h.svc.openInConnect({ folder: '/Users/taylor/atlas', launcher: 'codemie-claude', profile: 'prod', agent: 'Claude Code' });
  await h.svc.openInTerminal({ folder: '/Users/taylor/atlas', launcher: 'codemie-claude', profile: 'prod' });
  assert.deepEqual(h.calls.slice(-2), [
    { name: 'terminal_open_agent', args: { start: { folder: '/Users/taylor/atlas', launcher: 'codemie-claude', profile: 'prod', agent: 'Claude Code' } } },
    { name: 'open_agent_in_terminal', args: { folder: '/Users/taylor/atlas', launcher: 'codemie-claude', profile: 'prod' } },
  ]);
});
