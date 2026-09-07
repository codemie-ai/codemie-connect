// Option B bridge: exposes the same module surface the Electron handlers expected
// (inspector / runner / installer / pathman / downloader / pty), backed by Tauri
// `invoke` commands and `engine:*` events instead of Node modules.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let counter = 0;
const nextId = (p) => `${p}${++counter}`;

// ---- runner (src/main/runner.js) ----
export const runner = {
  runCapture: (cmd) => invoke('run_capture', { cmd }),
  runFreshEnv: (cmd) => invoke('run_fresh_env', { cmd }),

  // Streams output lines via the engine:cmd-line event (keyed by a call id),
  // resolving { code } when the Rust command returns the exit code.
  async runStream(cmd, onLine = () => {}) {
    onLine(`> ${cmd}`, 'prompt');
    const id = nextId('stream');
    const un = await listen('engine:cmd-line', (e) => {
      const p = e.payload;
      if (p && p.id === id) onLine(p.text, p.tag);
    });
    try {
      const code = await invoke('run_stream', { cmd, streamId: id });
      return { code };
    } finally {
      un();
    }
  },
};

// ---- inspector (src/main/inspector.js) ----
export const inspector = {
  checkGit: () => invoke('check_git'),
  checkNode: () => invoke('check_node'),
  checkNpm: () => invoke('check_npm'),
  checkCodemie: () => invoke('check_codemie'),
  checkCodemieVersion: () => invoke('check_codemie_version'),
  checkHandshakeState: () => invoke('check_handshake_state'),
  gitBinaryPath: () => invoke('git_binary_path'),
  nodeBinaryPath: () => invoke('node_binary_path'),
};

// ---- codemie config (~/.codemie/codemie-cli.config.json) ----
// read() resolves { state, profile, model, project, account } where state is
// 'no-configuration' | 'valid' | 'broken'. `account` is null when the config
// records no userEmail — an absent account, distinct from an unread one
// ('no-configuration'). Never rejects; a missing file is a state, not an error.
export const codemieConfig = {
  read: () => invoke('read_codemie_config'),
};

// ---- installer (src/main/installer-macos.js) ----
export const installer = {
  latestLtsNodeVersion: () => invoke('latest_lts_node_version'),
};

// ---- updater ----
export const updater = {
  fetchCodemieLatest: () => invoke('fetch_codemie_latest'),
  runSelfUpdate: () => invoke('run_self_update'),
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
    const exitP = new Promise((r) => {
      resolveExit = r;
    });
    // CR-005: both listeners are registered inside the try block so the finally
    // always runs and always unlistens both, even if the second listen() throws.
    try {
      // Register data listener BEFORE invoke so no early events for this id are missed
      if (onData) {
        dataUnlisten = await listen('engine:pty-data', (e) => {
          if (e.payload.id === id) onData(e.payload.data);
        });
      }
      exitUnlisten = await listen('engine:pty-exit', (e) => {
        if (e.payload.id === id) resolveExit(e.payload.code);
      });
      await invoke('spawn_pty', { cmd, cols, rows, runId: id });
      const code = await exitP;
      return { code, id };
    } finally {
      exitUnlisten?.();
      dataUnlisten?.();
    }
  },
  input: (data) => invoke('pty_input', { data }),
  resize: (cols, rows) => invoke('pty_resize', { cols, rows }),
  kill: () => invoke('pty_kill'),
};
