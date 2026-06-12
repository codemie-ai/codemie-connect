// Per-step handler dispatch table (ESM, Tauri frontend). Each handler receives the
// engine `ctx` (line/setSubtitle/setStatus/progress/runSubStep) and returns true | false.
// `deps` injects the runner-bridge modules so this stays the only "glue" layer.
// Faithful port of src/main/handlers.js — only the system calls now cross into Rust.

// Minimal path helpers (no Node 'path'/'os' in the browser).
function dirname(p) {
  const s = String(p);
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}
function joinPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}

export function makeHandlers(deps) {
  const { inspector, runner, installer, pathman, downloader, pty } = deps;
  const arch = deps.arch || 'universal';
  const tmpDir = deps.tmpDir || '/tmp';

  // Augment PATH (process + ~/.zprofile) with freshly-installed tool dirs, then re-probe.
  async function rememberDirs(dirs) {
    const clean = dirs.filter(Boolean);
    if (!clean.length) return;
    try {
      await pathman.augmentProcessPath(clean);
    } catch {
      /* non-fatal */
    }
    try {
      await pathman.persistToZprofile(clean);
    } catch {
      /* non-fatal */
    }
  }

  // Run an interactive command in a pty (in Rust), streaming to the renderer terminal.
  // Resolves true only on a clean exit (0); the PTY output/exit are delivered as
  // engine:pty-data / engine:pty-exit events handled by the renderer.
  function runPty(ctx, cmd, title) {
    ctx.setSubtitle(ctx.step.id, 'Interactive — follow the prompts in the terminal…');
    ctx.line(`> ${cmd}`, 'prompt');
    ctx.emit('pty-open', { id: ctx.step.id, title });
    return pty
      .spawnPty(cmd)
      .then((code) => {
        const okExit = code === 0;
        ctx.line(`(${ctx.step.title} finished, exit ${code})`, okExit ? 'dim' : 'stderr');
        if (!okExit) ctx.setSubtitle(ctx.step.id, `Did not complete (exit ${code})`);
        return okExit;
      })
      .catch((err) => {
        ctx.line(`Failed to open terminal: ${(err && err.message) || err}`, 'stderr');
        return false;
      });
  }

  return {
    // 1.1 — Check Git
    '1.1': async (ctx) => {
      ctx.setSubtitle('1.1', 'Checking for Git…');
      let git = await inspector.checkGit();
      if (git.found) {
        ctx.setSubtitle('1.1', `Git found — ${git.version}`);
        ctx.line(git.version, 'success');
        return true;
      }
      const bin = await inspector.gitBinaryPath();
      if (bin) {
        await rememberDirs([dirname(bin)]);
        git = await inspector.checkGit();
        if (git.found) {
          ctx.setSubtitle('1.1', `Git found — ${git.version}`);
          return true;
        }
      }
      ctx.setSubtitle('1.1', 'Git not found — installing…');
      const ok = await ctx.runSubStep('1.1.1', () =>
        installer.installGitCLT({ onTick: (t) => ctx.setSubtitle('1.1.1', t) })
      );
      if (!ok) return false;
      const re = await runner.runFreshEnv('git --version');
      return re.code === 0;
    },

    '1.1.1': async () => true,

    // 1.2 — Check Node.js & npm
    '1.2': async (ctx) => {
      ctx.setSubtitle('1.2', 'Checking for Node.js and npm…');
      let node = await inspector.checkNode();
      let npm = await inspector.checkNpm();
      if (node.found && npm.found) {
        ctx.setSubtitle('1.2', `Node ${node.version}, npm ${npm.version}`);
        ctx.line(`Node ${node.version} / npm ${npm.version}`, 'success');
        return true;
      }
      const bin = await inspector.nodeBinaryPath();
      if (bin) {
        await rememberDirs([dirname(bin)]);
        node = await inspector.checkNode();
        npm = await inspector.checkNpm();
        if (node.found && npm.found) {
          ctx.setSubtitle('1.2', `Node ${node.version}, npm ${npm.version}`);
          return true;
        }
      }
      ctx.setSubtitle('1.2', 'Node.js not found — installing…');
      const ok = await ctx.runSubStep('1.2.1', async () => {
        const version = await installer.latestLtsNodeVersion();
        const url = await installer.nodePkgUrl(arch, version);
        const dest = joinPath(tmpDir, `node-v${version}.pkg`);
        ctx.setSubtitle('1.2.1', `Downloading Node.js ${version}…`);
        await downloader.download(url, dest, (frac) => ctx.progress('1.2.1', frac));
        ctx.setSubtitle('1.2.1', 'Installing Node.js (authorize when prompted)…');
        await installer.installNode(dest);
        await rememberDirs(['/usr/local/bin']);
        return true;
      });
      if (!ok) return false;
      const reNode = await runner.runFreshEnv('node --version');
      const reNpm = await runner.runFreshEnv('npm --version');
      return reNode.code === 0 && reNpm.code === 0;
    },

    '1.2.1': async () => true,

    // 1.3 — Install CodeMie CLI
    '1.3': async (ctx) => {
      ctx.setSubtitle('1.3', 'Checking for CodeMie…');
      const existing = await inspector.checkCodemie();
      if (existing.found) {
        ctx.setSubtitle('1.3', 'CodeMie already installed');
        ctx.line('CodeMie CLI already present', 'success');
        return true;
      }

      // If the npm global prefix is not user-writable (e.g. system /usr/local from the
      // official Node.js .pkg), redirect to ~/.npm-global to avoid EACCES errors.
      const prefix = (await runner.runCapture('npm config get prefix')).stdout.trim();
      if (prefix && (await runner.runCapture(`test -w "${prefix}"`)).code !== 0) {
        const home = (await runner.runCapture('echo "$HOME"')).stdout.trim();
        const userPrefix = joinPath(home, '.npm-global');
        ctx.line('npm global prefix is not writable — redirecting to ~/.npm-global…', 'info');
        await runner.runCapture(`npm config set prefix "${userPrefix}"`);
      }

      ctx.setSubtitle('1.3', 'Installing CodeMie via npm…');
      const res = await runner.runStream('npm install -g @codemieai/code', (t, tag) => ctx.line(t, tag));
      if (res.code !== 0) {
        ctx.setSubtitle('1.3', 'npm install failed');
        return false;
      }
      const newPrefix = (await runner.runCapture('npm config get prefix')).stdout.trim();
      if (newPrefix) await rememberDirs([joinPath(newPrefix, 'bin')]);
      const re = await runner.runFreshEnv('codemie --help');
      const ok = `${re.stdout}${re.stderr}`.trim().length > 0;
      ctx.setSubtitle('1.3', ok ? 'CodeMie installed' : 'CodeMie not detected after install');
      return ok;
    },

    // 2.3.3 — Configure CodeMie (interactive)
    '2.3.3': (ctx) => runPty(ctx, 'codemie setup', 'CodeMie Setup — follow the prompts, then close'),

    // 2.3.5 — Install Claude Code engine (interactive)
    '2.3.5': (ctx) => runPty(ctx, 'codemie install claude --supported', 'Install Claude Code engine'),

    // 2.4 — Validate
    '2.4': async (ctx) => {
      ctx.setSubtitle('2.4', 'Running codemie doctor…');
      const res = await runner.runStream('codemie doctor', (t, tag) => ctx.line(t, tag));
      const ok = res.code === 0;
      ctx.setSubtitle('2.4', ok ? 'Validation passed' : `Validation failed (exit ${res.code})`);
      return ok;
    },
  };
}
