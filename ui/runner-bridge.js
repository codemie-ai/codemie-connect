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
  gitBinaryPath: () => invoke('git_binary_path'),
  nodeBinaryPath: () => invoke('node_binary_path'),
};

// ---- installer (src/main/installer-macos.js) ----
export const installer = {
  latestLtsNodeVersion: () => invoke('latest_lts_node_version'),
  nodePkgUrl: (arch, version) => invoke('node_pkg_url', { arch: arch || 'universal', version }),
  installNode: (pkgPath) => invoke('install_node', { pkgPath }),

  // Polls in Rust; streams human-readable ticks via engine:git-tick.
  async installGitCLT({ onTick = () => {} } = {}) {
    const un = await listen('engine:git-tick', (e) => onTick(String(e.payload)));
    try {
      return await invoke('install_git_clt');
    } finally {
      un();
    }
  },
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
  async download(url, dest, onProgress = () => {}) {
    const id = nextId('dl');
    const un = await listen('engine:download-progress', (e) => {
      const p = e.payload;
      if (p && p.id === id) onProgress(p.fraction);
    });
    try {
      return await invoke('download_file', { url, dest, progressId: id });
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
  // Spawns an interactive command; resolves with its exit code on engine:pty-exit.
  // PTY output (engine:pty-data) is routed to the terminal by the renderer.
  async spawnPty(cmd, cols = 100, rows = 30) {
    let resolveExit;
    const exit = new Promise((r) => {
      resolveExit = r;
    });
    const un = await listen('engine:pty-exit', (e) => resolveExit(e.payload.code));
    try {
      await invoke('spawn_pty', { cmd, cols, rows });
      return await exit;
    } finally {
      un();
    }
  },
  input: (data) => invoke('pty_input', { data }),
  resize: (cols, rows) => invoke('pty_resize', { cols, rows }),
};
