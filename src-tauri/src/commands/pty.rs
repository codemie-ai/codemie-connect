// Interactive PTY for the codemie TUI steps. Replaces node-pty with portable-pty.
//
// Key constraints (see technical-analysis §12):
//  - portable-pty's reader is BLOCKING, so it is pumped on a dedicated std::thread
//    (not a tokio task, which it would starve).
//  - Each chunk is base64-encoded before being emitted as engine:pty-data, so a
//    multi-byte UTF-8 char or ANSI escape sequence split across two 4096-byte reads
//    is never corrupted by lossy UTF-8 decoding mid-stream. The frontend decodes.
use std::io::{Read, Write};

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{CmdResult, InstallerError};
use crate::state::AppState;

/// The active PTY: a writer (for keystrokes) and the master (for resize).
/// The child process is owned by the wait thread.
pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

const READ_BUF: usize = 4096;

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    state: State<AppState>,
    cmd: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| InstallerError::Pty(e.to_string()))?;

    let path = std::env::var("PATH").unwrap_or_default();

    #[cfg(not(windows))]
    let builder = {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut b = CommandBuilder::new("/bin/zsh");
        b.arg("-lc");
        b.arg(&cmd);
        b.env("TERM", "xterm-256color");
        b.env("HOME", &home);
        b.env("PATH", &path);
        if !home.is_empty() {
            b.cwd(&home);
        }
        b
    };

    #[cfg(windows)]
    let builder = {
        let profile = std::env::var("USERPROFILE").unwrap_or_default();
        let mut b = CommandBuilder::new("powershell.exe");
        b.args(["-NoProfile", "-Command", &cmd]);
        b.env("TERM", "xterm-256color");
        b.env("USERPROFILE", &profile);
        b.env("PATH", &path);
        if !profile.is_empty() {
            b.cwd(&profile);
        }
        b
    };

    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| InstallerError::Pty(e.to_string()))?;
    // Drop the slave in the parent so the reader sees EOF when the child exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| InstallerError::Pty(e.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| InstallerError::Pty(e.to_string()))?;

    {
        let mut guard = state.pty.lock().unwrap();
        *guard = Some(PtyHandle {
            writer,
            master: pair.master,
        });
    }

    // Reader thread: pump bytes -> base64 -> engine:pty-data.
    let app_reader = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_reader.emit("engine:pty-data", serde_json::json!({ "data": data }));
                }
            }
        }
    });

    // Child-wait thread: emit engine:pty-exit and clear the active handle.
    let app_exit = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(1);
        if let Some(state) = app_exit.try_state::<AppState>() {
            *state.pty.lock().unwrap() = None;
        }
        let _ = app_exit.emit("engine:pty-exit", serde_json::json!({ "code": code }));
    });

    Ok(())
}

#[tauri::command]
pub fn pty_input(state: State<AppState>, data: String) -> CmdResult<()> {
    let mut guard = state.pty.lock().unwrap();
    if let Some(h) = guard.as_mut() {
        h.writer
            .write_all(data.as_bytes())
            .map_err(InstallerError::Io)?;
        let _ = h.writer.flush();
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: State<AppState>, cols: u16, rows: u16) -> CmdResult<()> {
    let guard = state.pty.lock().unwrap();
    if let Some(h) = guard.as_ref() {
        h.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| InstallerError::Pty(e.to_string()))?;
    }
    Ok(())
}

// ---- Windows: external console window ----------------------------------------

/// Spawn `cmd` in a new visible PowerShell window and block until it exits.
/// Uses `CREATE_NEW_CONSOLE` so Windows opens a fresh conhost/Terminal pane.
/// Returns the exit code (0 = success).
#[cfg(windows)]
#[tauri::command]
pub async fn spawn_external_ps(cmd: String) -> CmdResult<i32> {
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let status = tokio::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", &cmd])
        .creation_flags(CREATE_NEW_CONSOLE)
        .status()
        .await
        .map_err(|e| InstallerError::Other(e.to_string()))?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawn_external_ps_exits_zero_for_noop_command() {
        let code = spawn_external_ps("cmd /c exit 0".into()).await.unwrap();
        assert_eq!(code, 0);
    }
}
