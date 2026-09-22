// Shell execution primitives. Port of src/main/runner.js.
// macOS: commands run via `/bin/zsh -lc` (login shell, profile PATH loaded).
// Windows: commands run via `cmd.exe /c`.
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::CmdResult;
use crate::state::AppState;

#[derive(Serialize, Clone)]
pub struct CaptureResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize, Clone)]
struct CmdLine {
    id: String,
    text: String,
    tag: String,
}

/// Pure: builds the platform-appropriate shell `Command` for `cmd_str` from
/// an explicit `home` value, with no environment reads. Always compiled on
/// every platform so tests can exercise this without mutating the process
/// environment (`std::env::set_var` on `HOME` is process-global and races
/// with anything else in the test binary that spawns a real child).
fn shell_cmd_for(cmd_str: &str, home: &str, base_path: &str, windows: bool) -> Command {
    let env = crate::commands::npm_env::npm_env_for(home, windows);
    let path = crate::commands::npm_env::prefixed_path_with_bin_dir(&env.bin_dir, base_path);
    #[cfg(not(windows))]
    let mut c = {
        let mut c = Command::new("/bin/zsh");
        c.arg("-lc").arg(cmd_str);
        c
    };
    #[cfg(windows)]
    let mut c = {
        // Without this flag, spawning a console subprocess from this GUI-subsystem
        // app briefly flashes a visible cmd.exe window on screen.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = Command::new("cmd.exe");
        c.args(["/c", cmd_str]).creation_flags(CREATE_NO_WINDOW);
        c
    };
    // An empty prefix is npm_env_for()'s "no override" value (home was
    // unset or empty) — leave npm_config_prefix unset rather than pointing
    // it at a root-relative path.
    if !env.prefix.is_empty() {
        c.env("npm_config_prefix", &env.prefix);
    }
    c.env("PATH", &path);
    c
}

/// Build a platform-appropriate shell command. Returns a tokio Command ready to
/// execute `cmd_str` through the OS shell. Reads the platform's home-dir env
/// var and delegates to `shell_cmd_for`.
fn shell_cmd(cmd_str: &str) -> Command {
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let base = std::env::var("PATH").unwrap_or_default();
    shell_cmd_for(cmd_str, &home, &base, cfg!(windows))
}

/// Run a command and capture all output. Mirrors runner.runCapture:
/// spawn error -> code 127; no exit code -> 1.
pub async fn capture(cmd: &str, path_override: Option<String>) -> CaptureResult {
    let mut command = shell_cmd(cmd);
    if let Some(p) = path_override {
        command.env("PATH", p);
    }
    match command.output().await {
        Ok(out) => CaptureResult {
            code: out.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        },
        Err(e) => CaptureResult {
            code: 127,
            stdout: String::new(),
            stderr: e.to_string(),
        },
    }
}

#[tauri::command]
pub async fn run_capture(cmd: String) -> CaptureResult {
    capture(&cmd, None).await
}

/// Re-run a command with PATH augmented by candidate dirs + remembered install dirs,
/// so a binary installed during this session is found without restarting the app.
#[tauri::command]
pub async fn run_fresh_env(state: State<'_, AppState>, cmd: String) -> CmdResult<CaptureResult> {
    let remembered = state.remembered.lock().unwrap().clone();
    let path = crate::commands::pathman::fresh_env_path(&remembered);
    Ok(capture(&cmd, Some(path)).await)
}

/// Run a command, streaming each output line to the frontend via the
/// `engine:cmd-line` event (keyed by `stream_id`). Returns the exit code.
/// The JS bridge emits the `> cmd` prompt line itself, matching runner.runStream.
#[tauri::command]
pub async fn run_stream(app: AppHandle, cmd: String, stream_id: String) -> i32 {
    let mut child = match shell_cmd(&cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit(
                "engine:cmd-line",
                CmdLine {
                    id: stream_id,
                    text: e.to_string(),
                    tag: "stderr".into(),
                },
            );
            return 127;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let mut handles = Vec::new();
    if let Some(out) = stdout {
        handles.push(pump(app.clone(), stream_id.clone(), out, "stdout"));
    }
    if let Some(err) = stderr {
        handles.push(pump(app.clone(), stream_id.clone(), err, "stderr"));
    }

    let status = child.wait().await;
    for h in handles {
        let _ = h.await;
    }
    status.ok().and_then(|s| s.code()).unwrap_or(1)
}

fn pump<R>(app: AppHandle, id: String, reader: R, tag: &'static str) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit(
                "engine:cmd-line",
                CmdLine {
                    id: id.clone(),
                    text: line,
                    tag: tag.to_string(),
                },
            );
        }
    })
}

/// Direct invocation of the bundled node binary + CLI entry-point.
/// Extracted from `run_self_update` so the invocation logic can be unit-tested
/// independently of Tauri's managed `State`.
pub(crate) async fn self_update_direct(
    node_exe: &std::path::Path,
    cli_entry: &std::path::Path,
) -> CmdResult<String> {
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut node_cmd = tokio::process::Command::new(node_exe);
    node_cmd.args([cli_entry.as_os_str(), std::ffi::OsStr::new("self-update")]);
    #[cfg(windows)]
    node_cmd.creation_flags(CREATE_NO_WINDOW);
    let out = tokio::time::timeout(std::time::Duration::from_secs(120), node_cmd.output())
        .await
        .map_err(|_| {
            crate::error::InstallerError::Other("self-update timed out after 120 s".into())
        })?
        .map_err(|e| crate::error::InstallerError::Other(e.to_string()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(crate::error::InstallerError::Other(format!(
            "codemie self-update failed (exit {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

/// Run `codemie self-update` silently (captured, not PTY).
/// Invokes the bundled node + CLI entry absolutely when both paths exist;
/// falls back to the `codemie` shim on PATH through the platform shell.
/// Returns stdout on exit 0; serializes as an error string on non-zero exit.
#[tauri::command]
pub async fn run_self_update(state: tauri::State<'_, crate::state::AppState>) -> CmdResult<String> {
    let node = &state.node_exe_path;
    let cli = &state.cli_entry_path;
    if node.exists() && cli.exists() {
        return self_update_direct(node, cli).await;
    }
    // At least one bundled path is absent. When an existing CLI took precedence
    // (EPMCDME-14581), node_exe_path/cli_entry_path were never populated by
    // design — that's expected, not a PATH-injection failure, so only warn
    // when it wasn't.
    if !state.existing_cli_detected {
        if !node.exists() {
            log::warn!(
                "[run_self_update] node_exe_path not found ({}); falling back to PATH shim",
                node.display()
            );
        }
        if !cli.exists() {
            log::warn!(
                "[run_self_update] cli_entry_path not found ({}); falling back to PATH shim",
                cli.display()
            );
        }
    }
    let r = capture("codemie self-update", None).await;
    if r.code == 0 {
        Ok(r.stdout)
    } else {
        Err(crate::error::InstallerError::Other(format!(
            "codemie self-update failed (exit {}): {}",
            r.code,
            r.stderr.trim()
        )))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shell_cmd_sets_npm_config_prefix_and_prefixed_path_by_default() {
        let out = shell_cmd_for(
            "echo $npm_config_prefix; echo $PATH",
            "/Users/test",
            "",
            false,
        )
        .output()
        .await
        .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut lines = stdout.lines();
        assert_eq!(lines.next().unwrap(), "/Users/test/.codemie/agents");
        // Not `starts_with`: macOS's system-wide /etc/zprofile runs
        // `path_helper -s` on every login shell, which reorders PATH —
        // system dirs from /etc/paths(.d) first, then the caller's other
        // entries appended in their original order. shell_cmd still sets
        // PATH with the agents bin dir prepended; path_helper is what
        // moves it, on every real machine, not just this one. Presence is
        // what functionally matters — the dir is found by `npm`/agents
        // installed there regardless of position.
        let path_line = lines.next().unwrap();
        assert!(
            path_line
                .split(':')
                .any(|p| p == "/Users/test/.codemie/agents/bin"),
            "PATH must contain the agents bin dir: {path_line}"
        );
    }

    // Ported from test/runner.test.js — runs against the real login shell.
    #[tokio::test]
    async fn run_capture_runs_via_shell_and_captures_stdout() {
        let r = capture("echo hi", None).await;
        assert_eq!(r.code, 0);
        assert_eq!(r.stdout.trim(), "hi");
    }

    #[tokio::test]
    async fn run_capture_reports_nonzero_exit() {
        let r = capture("exit 3", None).await;
        assert_eq!(r.code, 3);
    }
}

#[cfg(all(test, windows))]
mod tests_windows {
    use super::*;

    #[tokio::test]
    async fn run_capture_runs_via_cmd_and_captures_stdout() {
        let r = capture("echo hello_from_cmd", None).await;
        assert_eq!(r.code, 0);
        assert!(r.stdout.trim().contains("hello_from_cmd"));
    }

    #[tokio::test]
    async fn run_capture_reports_nonzero_exit_windows() {
        let r = capture("exit 3", None).await;
        assert_eq!(r.code, 3);
    }
}

#[cfg(test)]
mod tests_self_update {
    use super::*;

    /// `self_update_direct` must surface a spawn failure as `Err`, on both
    /// platforms: a file that is not a valid executable (Windows: not a PE;
    /// unix: no execute bit) cannot be run as the bundled node.
    /// The success path needs the real bundled node and is exercised by
    /// build-installer's post-build shim smoke.
    #[tokio::test]
    async fn self_update_direct_errors_when_node_not_executable() {
        let dir = tempfile::TempDir::new().unwrap();
        let fake_node = dir
            .path()
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let fake_cli = dir.path().join("codemie.js");
        std::fs::write(&fake_node, b"not an executable").unwrap();
        std::fs::write(&fake_cli, b"// placeholder").unwrap();
        let result = self_update_direct(&fake_node, &fake_cli).await;
        assert!(
            result.is_err(),
            "self_update_direct must return Err when the node binary cannot be executed"
        );
    }
}
