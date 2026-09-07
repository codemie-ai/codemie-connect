// Per-step handler dispatch table (ESM, Tauri frontend). Each handler receives the
// engine `ctx` (line/setSubtitle/setStatus/progress/runSubStep) and returns true | false.
// `deps` injects the runner-bridge modules so this stays the only "glue" layer.
// `deps.platform` is { os: "macos"|"windows", arch: "x86_64"|"aarch64" } from
// get_platform_info — used to pick platform-specific paths and extensions.

// Minimal path helpers (no Node 'path'/'os' in the browser).
function dirname(p) {
  const s = String(p);
  // Windows paths: use the last backslash or forward slash.
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}
function joinPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}
function joinPathWin(...parts) {
  return parts.filter(Boolean).join('\\').replace(/\\{2,}/g, '\\');
}

export function makeHandlers(deps) {
  const { inspector, runner, installer, pathman, downloader, pty, externalWindow } = deps;
  const arch = deps.arch || 'universal';
  const tmpDir = deps.tmpDir || '/tmp';
  const platform = deps.platform || { os: 'macos', arch };
  const isWin = platform.os === 'windows';

  // Augment PATH (process + profile) with freshly-installed tool dirs, then re-probe.
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

  // Open `cmd` in a new external PowerShell window (Windows only) and await exit.
  async function runExternalWindow(ctx, stepId, cmd) {
    ctx.setSubtitle(stepId, 'Running in external window…');
    try {
      const code = await externalWindow.spawnPs(cmd);
      ctx.setSubtitle(stepId, '');
      return code === 0;
    } catch (err) {
      ctx.setSubtitle(stepId, `Failed to open window: ${(err && err.message) || err}`);
      return false;
    }
  }

  // Run an interactive command in a pty (in Rust), streaming to the renderer terminal.
  function runPty(ctx, cmd, title) {
    ctx.setSubtitle(ctx.step.id, 'Interactive — follow the prompts in the terminal…');
    ctx.line(`> ${cmd}`, 'prompt');
    ctx.emit('pty-open', { id: ctx.step.id, title });
    return pty
      .spawnPty(cmd)
      .then(({ code }) => {
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

  const handlers = {
    // 2.3.3 — Configure CodeMie: external PowerShell window on Windows, embedded PTY on macOS.
    '2.3.3': (ctx) => isWin
      ? runExternalWindow(ctx, '2.3.3', 'codemie setup')
      : runPty(ctx, 'codemie setup', 'CodeMie Setup — follow the prompts, then close'),

    // 2.3.5 — Install Claude Code engine: external PowerShell window on Windows, embedded PTY on macOS.
    '2.3.5': (ctx) => isWin
      ? runExternalWindow(ctx, '2.3.5', 'codemie install claude --supported')
      : runPty(ctx, 'codemie install claude --supported', 'Install Claude Code engine'),

    // 2.4 — Validate
    '2.4': async (ctx) => {
      ctx.setSubtitle('2.4', 'Running codemie doctor…');
      const res = await runner.runStream('codemie doctor', (t, tag) => ctx.line(t, tag));
      const ok = res.code === 0;
      ctx.setSubtitle('2.4', ok ? 'Validation passed' : `Validation failed (exit ${res.code})`);
      return ok;
    },
  };
  return handlers;
}
