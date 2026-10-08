// Option B bridge: exposes the same module surface the Electron handlers expected
// (inspector / runner / installer / pathman / downloader / pty), backed by Tauri
// `invoke` commands and `engine:*` events instead of Node modules.
import stripAnsi from './ansi-strip.mjs';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let counter = 0;
const nextId = (p) => `${p}${++counter}`;

// ponytail: single-PTY sentinel; replace with Map<id,fn> for concurrent PTY support
let _resolvePtyKill = null;

export const cmdlog = {
  open:   (cmd)       => invoke('cmdlog_open',   { command: cmd }),
  append: (id, chunk) => invoke('cmdlog_append', { id, chunk }),
  close:  (id, code)  => invoke('cmdlog_close',  { id, exitCode: code }),
  list:   ()          => invoke('cmdlog_list'),
  get:    (id)        => invoke('cmdlog_get', { id }),
};

// ---- runner (src/main/runner.js) ----
export const runner = {
  async runCapture(cmd) {
    const logId = await cmdlog.open(cmd).catch(() => null);
    let res = null;
    let _code = -1;
    try {
      res = await invoke('run_capture', { cmd });
      if (logId && res != null) await cmdlog.append(logId, String(res)).catch(console.warn);
      _code = 0;
      return res;
    } finally {
      if (logId) await cmdlog.close(logId, _code).catch(console.warn);
    }
  },

  async runFreshEnv(cmd) {
    let _code = -1;
    const logId = await cmdlog.open(cmd).catch(() => null);
    try {
      const result = await invoke('run_fresh_env', { cmd });
      if (logId && result != null) await cmdlog.append(logId, String(result)).catch(console.warn);
      _code = 0;
      return result;
    } finally {
      if (logId) await cmdlog.close(logId, _code).catch(console.warn);
    }
  },

  // Streams output lines via the engine:cmd-line event (keyed by a call id),
  // resolving { code } when the Rust command returns the exit code.
  async runStream(cmd, onLine = () => {}) {
    onLine(`> ${cmd}`, 'prompt');
    const id = nextId('stream');
    const logId = await cmdlog.open(cmd).catch(() => null);
    const pendingAppends = [];
    const un = await listen('engine:cmd-line', (e) => {
      const p = e.payload;
      if (p && p.id === id) {
        onLine(p.text, p.tag);
        if (logId) pendingAppends.push(cmdlog.append(logId, `${stripAnsi(p.text)}\n`).catch(console.warn));
      }
    });
    let code = null;
    let _exitCode = -1;
    try {
      code = await invoke('run_stream', { cmd, streamId: id });
      _exitCode = code ?? -1;
      return { code };
    } finally {
      un();
      await Promise.all(pendingAppends);
      if (logId) await cmdlog.close(logId, _exitCode).catch(console.warn);
    }
  },
};

// Commands Rust runs itself get a command-log record too. `codeOf` turns the
// result into an exit code; a rejection is recorded as failed (-1).
const logged = async (cmd, run, codeOf = () => 0) => {
  const logId = await cmdlog.open(cmd).catch(() => null);
  let code = -1;
  try {
    const res = await run();
    code = codeOf(res) ?? -1;
    return res;
  } finally {
    if (logId) await cmdlog.close(logId, code).catch(console.warn);
  }
};
const probeCode = (p) => (p?.found ? 0 : 1);

// ---- inspector (src/main/inspector.js) ----
export const inspector = {
  checkGit: () => logged('git --version', () => invoke('check_git'), probeCode),
  checkNode: () => logged('node --version', () => invoke('check_node'), probeCode),
  checkNpm: () => logged('npm --version', () => invoke('check_npm'), probeCode),
  checkCodemie: () => logged('codemie --help', () => invoke('check_codemie'), probeCode),
  checkHandshakeState: () => logged('codemie --version', () => invoke('check_handshake_state')),
  checkCodemieVersion: () => logged('codemie --version', () => invoke('check_codemie_version'), (v) => (v ? 0 : 1)),
  checkProfileStatus: () => logged('codemie profile status', () => invoke('check_profile_status'), (st) => st?.code ?? 0),
  gitBinaryPath: () => invoke('git_binary_path'),
  nodeBinaryPath: () => invoke('node_binary_path'),
};

// ---- connectors (src-tauri/src/commands/connectors.rs) ----
export const connectors = {
  checkStatus: () => invoke('check_connector_status'),
  appBundleExists: (name) => invoke('app_bundle_exists', { name }),
};

// ---- codemie config (~/.codemie/codemie-cli.config.json) ----
// read() resolves { state, profile, model, project, account } where state is
// 'no-configuration' | 'valid' | 'broken'. `account` is null when the config
// records no userEmail — an absent account, distinct from an unread one
// ('no-configuration'). Never rejects; a missing file is a state, not an error.
export const codemieConfig = {
  read: () => invoke('read_codemie_config'),
};

// ---- codemie profile ----
// delete(name) runs `codemie profile delete <name> --yes` from the filesystem
// root; resolves { code, stdout, stderr }, rejects on a name the shell cannot
// carry safely.
export const profile = {
  delete: (name) => logged('codemie profile delete', () => invoke('delete_profile', { name }), (r) => r?.code ?? 0),
};

// ---- installer (src/main/installer-macos.js) ----
export const installer = {
  latestLtsNodeVersion: () => invoke('latest_lts_node_version'),
};

// ---- updater ----
async function checkForAppUpdate(force = false) {
  return invoke('check_for_update', { force });
}

async function downloadAndInstall(id, onProgress) {
  const unlisten = await listen('engine:update-progress', (event) => {
    if (event.payload.id === id) onProgress(event.payload);
  });
  try {
    await invoke('download_and_install', { id });
  } finally {
    unlisten();
  }
}

async function restartApp() {
  return invoke('restart_app');
}

export const updater = {
  checkForAppUpdate,
  downloadAndInstall,
  restartApp,
};

// ---- pathman (src/main/pathman.js) ----
export const pathman = {
  augmentProcessPath: (dirs) => invoke('augment_path', { dirs }),
  persistToZprofile: (entries) => invoke('persist_to_zprofile', { entries }),
};

// ---- downloader (src/main/downloader.js) ----
export const downloader = {
  // onProgress(fraction) called per chunk via the engine:download-progress event.
  // expectedSha256 is forwarded to verify_download in Rust; pass null to skip
  // the integrity check (acceptable only when no hash is published by the source).
  async download(url, dest, onProgress = () => {}, expectedSha256 = null) {
    const id = nextId('dl');
    const un = await listen('engine:download-progress', (e) => {
      const p = e.payload;
      if (p && p.id === id) onProgress(p.fraction);
    });
    try {
      return await invoke('download_file', { url, dest, progressId: id, expectedSha256 });
    } finally {
      un();
    }
  },
};

// ---- platform info ----
export const platformInfo = () => invoke('get_platform_info');

// ---- external console window (Windows only) ----
// Spawns `cmd` in a new visible PowerShell window and resolves with the exit code
// when the window closes. Has no effect (throws) on non-Windows builds.
export const externalWindow = {
  spawnPs: (cmd) => invoke('spawn_external_ps', { cmd }),
};

// ---- pty (replaces node-pty; the active PTY lives in Rust managed state) ----
export const pty = {
  // Spawns an interactive command; resolves with { code, id } on engine:pty-exit
  // for the matching run id.  Per-run output is delivered via the optional onData
  // callback; engine:pty-data events for other run ids are ignored.
  async spawnPty(cmd, cols = 100, rows = 30, onData) {
    const id = nextId('pty');
    let resolveExit, dataUnlisten, exitUnlisten;
    const exitP = new Promise((r) => { resolveExit = r; });
    const killP = new Promise((r) => { _resolvePtyKill = r; });
    const logId = await cmdlog.open(cmd).catch(() => null);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const pendingPtyAppends = [];
    let exitCode;
    // CR-005: both listeners are registered inside the try block so the finally
    // always runs and always unlistens both, even if the second listen() throws.
    try {
      // Register data listener BEFORE invoke so no early events for this id are missed
      dataUnlisten = await listen('engine:pty-data', (e) => {
        if (e.payload.id === id) {
          if (onData) onData(e.payload.data);
          if (logId) {
            try {
              const raw = Uint8Array.from(atob(e.payload.data), c => c.charCodeAt(0));
              const stripped = stripAnsi(decoder.decode(raw, { stream: true }));
              if (stripped) pendingPtyAppends.push(cmdlog.append(logId, stripped).catch(console.warn));
            } catch { /* invalid base64 or decode error */ }
          }
        }
      });
      exitUnlisten = await listen('engine:pty-exit', (e) => {
        if (e.payload.id === id) resolveExit(e.payload.code);
      });
        await invoke('spawn_pty', { cmd, cols, rows, runId: id });
      exitCode = await Promise.race([exitP, killP]);
      return { code: exitCode, id };
    } finally {
      _resolvePtyKill = null;
      exitUnlisten?.();
      dataUnlisten?.();
      if (logId) {
        const tail = stripAnsi(decoder.decode(new Uint8Array(0), { stream: false }));
        if (tail) pendingPtyAppends.push(cmdlog.append(logId, tail).catch(console.warn));
        await Promise.all(pendingPtyAppends);
        await cmdlog.close(logId, exitCode ?? -1).catch(console.warn);
      }
    }
  },
  input: (data) => invoke('pty_input', { data }),
  resize: (cols, rows) => invoke('pty_resize', { cols, rows }),
  kill: () => { _resolvePtyKill?.(-1); _resolvePtyKill = null; return invoke('pty_kill'); },
};
