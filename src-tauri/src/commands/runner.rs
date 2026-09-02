// Shell execution primitives. Port of src/main/runner.js.
// macOS: commands run via `/bin/zsh -lc` (login shell, profile PATH loaded).
// Windows: commands run via `powershell.exe -NoProfile -NonInteractive -Command`.
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

/// Build a platform-appropriate shell command. Returns a tokio Command ready to
/// execute `cmd_str` through the OS shell.
fn shell_cmd(cmd_str: &str) -> Command {
    #[cfg(not(windows))]
    {
        let mut c = Command::new("/bin/zsh");
        c.arg("-lc").arg(cmd_str);
        c
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(cmd_str);
        c
    }
}

/// Run a command and capture all output. Mirrors runner.runCapture:
/// spawn error -> code 127; no exit code -> 1.
pub async fn capture(cmd: &str, path_override: Option<String>) -> CaptureResult {
    let mut command = shell_cmd(cmd);
    // Null, not inherited. Unlike `std`, tokio's `Command::output` leaves stdin
    // inherited, so a captured command run from a terminal-launched app sees a
    // live TTY and can block on it forever. No caller can send input anyway.
    command.stdin(Stdio::null());
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

/// Build the command `run_stream` spawns.
///
/// stdin is null, not inherited. There is no way to send input to a streamed
/// command, so a child that reads stdin can only hang — and an app launched from
/// a terminal would hand that TTY to every child. Interactive commands go through
/// `spawn_pty`, which is unaffected.
///
/// Split out so the test below drives the same configuration `run_stream` uses,
/// rather than rebuilding it and passing regardless.
fn stream_cmd(cmd: &str) -> Command {
    let mut c = shell_cmd(cmd);
    c.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}

/// Run a command, streaming each output line to the frontend via the
/// `engine:cmd-line` event (keyed by `stream_id`). Returns the exit code.
/// The JS bridge emits the `> cmd` prompt line itself, matching runner.runStream.
#[tauri::command]
pub async fn run_stream(app: AppHandle, cmd: String, stream_id: String) -> i32 {
    let mut child = match stream_cmd(&cmd).spawn() {
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

/// Run `codemie self-update` silently (captured, not PTY).
/// Returns stdout on exit 0; serializes as an error string on non-zero exit.
#[tauri::command]
pub async fn run_self_update() -> CmdResult<String> {
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
    async fn run_capture_runs_via_powershell_and_captures_stdout() {
        let r = capture("Write-Output 'hi'", None).await;
        assert_eq!(r.code, 0);
        assert!(r.stdout.contains("hi"));
    }

    #[tokio::test]
    async fn run_capture_reports_nonzero_exit_windows() {
        let r = capture("exit 3", None).await;
        assert_eq!(r.code, 3);
    }
}

// These need the harness itself to own a TTY, which `cargo test` does not give
// them — without one, `test -t 0` reports no terminal whether or not the fix is
// present, so they would pass green with the fix removed. Ignored by default so
// that false green is never mistaken for coverage. Run them deliberately:
//
//     script -q /dev/null cargo test -- --ignored stdin_tests
//
// To make them run under the plain gate instead, allocate a pty in-test with
// portable-pty (already a dependency) so the harness has a terminal to leak.
//
#[cfg(all(test, unix))]
mod stdin_tests {
    use super::*;

    /// A streamed command must never inherit the parent's stdin. Drives
    /// `stream_cmd`, the same builder `run_stream` spawns, so deleting the fix
    /// fails this test rather than leaving it green.
    ///
    /// `test -t 0` exits 0 only when stdin is a TTY, so this only has teeth when
    /// the harness itself has one: `script -q /dev/null cargo test stdin_tests`.
    #[tokio::test]
    #[ignore = "needs a TTY harness: script -q /dev/null cargo test -- --ignored"]
    async fn streamed_commands_do_not_inherit_a_terminal_on_stdin() {
        let status = stream_cmd("test -t 0")
            .spawn()
            .expect("spawn")
            .wait()
            .await
            .expect("wait");
        assert!(!status.success(), "child saw a TTY on stdin");
    }

    /// The capture path needs the same guarantee explicitly: tokio's
    /// `Command::output` leaves stdin inherited, where `std`'s nulls it.
    #[tokio::test]
    #[ignore = "needs a TTY harness: script -q /dev/null cargo test -- --ignored"]
    async fn captured_commands_see_no_terminal_on_stdin() {
        assert_eq!(capture("test -t 0", None).await.code, 1);
    }
}
