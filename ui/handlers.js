'use strict';

const path = require('node:path');
const os = require('node:os');

// Build the per-step handler dispatch table. Each handler receives the engine `ctx`
// (line/setSubtitle/setStatus/progress/runSubStep) and returns true | false.
// `deps` injects the system modules so this stays the only "glue" layer.
function makeHandlers(deps) {
  const { inspector, runner, installer, pathman, downloader, setActivePty } = deps;
  const arch = deps.arch || os.arch();
  const tmpDir = deps.tmpDir || os.tmpdir();

  // Augment PATH (process + ~/.zprofile) with freshly-installed tool dirs, then re-probe.
  function rememberDirs(dirs) {
    const clean = dirs.filter(Boolean);
    if (!clean.length) return;
    pathman.augmentProcessPath(clean);
    try {
      pathman.persistToZprofile(clean);
    } catch {
      /* non-fatal */
    }
  }

  // Run an interactive command in a pty, streaming to the renderer terminal.
  // Resolves true only when the command exits cleanly (exit 0); a non-zero exit
  // (e.g. 127 "command not found", or a cancelled/failed TUI) marks the step ERROR.
  function runPty(ctx, cmd, title) {
    return new Promise((resolve) => {
      ctx.setSubtitle(ctx.step.id, 'Interactive — follow the prompts in the terminal…');
      ctx.line(`> ${cmd}`, 'prompt');
      ctx.emit('pty-open', { id: ctx.step.id, title });
      let pty;
      try {
        pty = runner.spawnPty(cmd);
      } catch (err) {
        ctx.line(`Failed to open terminal: ${err.message}`, 'stderr');
        ctx.emit('pty-exit', { code: 1 });
        resolve(false);
        return;
      }
      setActivePty(pty);
      pty.onData((d) => ctx.emit('pty-data', { data: d }));
      pty.onExit(({ exitCode }) => {
        setActivePty(null);
        ctx.emit('pty-exit', { code: exitCode });
        const okExit = exitCode === 0;
        ctx.line(`(${ctx.step.title} finished, exit ${exitCode})`, okExit ? 'dim' : 'stderr');
        if (!okExit) ctx.setSubtitle(ctx.step.id, `Did not complete (exit ${exitCode})`);
        resolve(okExit);
      });
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
      const bin = inspector.gitBinaryPath();
      if (bin) {
        rememberDirs([path.dirname(bin)]);
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

    // 1.1.1 handled inline via runSubStep above (no standalone dispatch needed),
    // but keep an entry so a direct lookup never throws.
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
      const bin = inspector.nodeBinaryPath();
      if (bin) {
        rememberDirs([path.dirname(bin)]);
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
        const url = installer.nodePkgUrl(arch, version);
        const dest = path.join(tmpDir, `node-v${version}.pkg`);
        ctx.setSubtitle('1.2.1', `Downloading Node.js ${version}…`);
        await downloader.download(url, dest, (frac) => ctx.progress('1.2.1', frac));
        ctx.setSubtitle('1.2.1', 'Installing Node.js (authorize when prompted)…');
        await installer.installNode(dest);
        rememberDirs(['/usr/local/bin']);
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
      ctx.setSubtitle('1.3', 'Installing CodeMie via npm…');
      const res = await runner.runStream('npm install -g @codemieai/code', (t, tag) => ctx.line(t, tag));
      if (res.code !== 0) {
        ctx.setSubtitle('1.3', 'npm install failed');
        return false;
      }
      const prefix = (await runner.runCapture('npm config get prefix')).stdout.trim();
      if (prefix) rememberDirs([path.join(prefix, 'bin')]);
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

module.exports = { makeHandlers };
