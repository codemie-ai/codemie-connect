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
    let path = crate::commands::npm_env::path_with_bin_dir_last(&env.bin_dir, base_path);
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
    capture_command(command).await
}

async fn capture_command(mut command: Command) -> CaptureResult {
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shell_cmd_sets_npm_config_prefix_and_agents_path_by_default() {
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
        // PATH with the agents bin dir appended; path_helper is what
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
