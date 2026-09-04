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
        let mut c = Command::new("cmd.exe");
        c.args(["/c", cmd_str]);
        c
    }
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

/// Direct invocation of the bundled node.exe + CLI entry-point (Windows only).
/// Extracted from `run_self_update` so the invocation logic can be unit-tested
/// independently of Tauri's managed `State`.
#[cfg(windows)]
pub(crate) async fn self_update_direct(
    node_exe: &std::path::Path,
    cli_entry: &std::path::Path,
) -> CmdResult<String> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tokio::process::Command::new(node_exe)
            .args([cli_entry.as_os_str(), std::ffi::OsStr::new("self-update")])
            .output(),
    )
    .await
    .map_err(|_| crate::error::InstallerError::Other("self-update timed out after 120 s".into()))?
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
/// On Windows, invokes the bundled node.exe + CLI absolutely when both paths are
/// populated; falls back to the `codemie` shim on PATH via `cmd.exe /c`.
/// Returns stdout on exit 0; serializes as an error string on non-zero exit.
#[tauri::command]
pub async fn run_self_update(state: tauri::State<'_, crate::state::AppState>) -> CmdResult<String> {
    #[cfg(windows)]
    {
        let node = &state.node_exe_path;
        let cli = &state.cli_entry_path;
        if node.exists() && cli.exists() {
            return self_update_direct(node, cli).await;
        }
        // At least one bundled path is absent. Log which one is missing to help
        // diagnose PATH injection failures before falling back to the shim.
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

#[cfg(all(test, windows))]
mod tests_windows_self_update {
    use super::*;

    /// Verifies that `self_update_direct` returns `Err` when the supplied node
    /// binary is not a valid Windows executable (invalid PE format). This covers
    /// the error-mapping path through `map_err(|e| InstallerError::Other(...))`.
    ///
    /// The success path (exit 0, stdout captured) requires a real node.exe binary
    /// and is verified at integration-test time on a Windows VM (stage 7).
    #[tokio::test]
    async fn self_update_direct_errors_when_node_not_executable() {
        let dir = tempfile::TempDir::new().unwrap();
        let fake_node = dir.path().join("node.exe");
        let fake_cli = dir.path().join("index.js");
        std::fs::write(&fake_node, b"not a PE binary").unwrap();
        std::fs::write(&fake_cli, b"// placeholder").unwrap();
        let result = self_update_direct(&fake_node, &fake_cli).await;
        assert!(
            result.is_err(),
            "self_update_direct must return Err when node.exe is not a valid executable"
        );
    }
}
