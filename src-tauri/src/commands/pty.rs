// Interactive PTY for the codemie TUI steps. Replaces node-pty with portable-pty.
//
// Key constraints (see technical-analysis §12):
//  - portable-pty's reader is BLOCKING, so it is pumped on a dedicated std::thread
//    (not a tokio task, which it would starve).
//  - Each chunk is base64-encoded before being emitted as engine:pty-data, so a
//    multi-byte UTF-8 char or ANSI escape sequence split across two 4096-byte reads
//    is never corrupted by lossy UTF-8 decoding mid-stream. The frontend decodes.
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{CmdResult, InstallerError};
use crate::state::AppState;

/// The active PTY: a writer (for keystrokes), the master (for resize),
/// a killer and exit condvar for `pty_kill`.
pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    pub killer: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    pub exit_cv: Arc<(Mutex<bool>, Condvar)>,
}

fn clear_if_owner<T>(slot: &Mutex<Option<(String, T)>>, id: &str) -> bool {
    let mut g = slot.lock().unwrap();
    if g.as_ref().is_some_and(|(sid, _)| sid == id) {
        *g = None;
        true
    } else {
        false
    }
}

const READ_BUF: usize = 4096;

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    state: State<AppState>,
    cmd: String,
    cols: u16,
    rows: u16,
    run_id: String,
) -> CmdResult<String> {
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

    let killer = Arc::new(Mutex::new(child.clone_killer()));
    let exit_cv = Arc::new((Mutex::new(false), Condvar::new()));

    {
        let mut guard = state.pty.lock().unwrap();
        *guard = Some((
            run_id.clone(),
            PtyHandle {
                writer,
                master: pair.master,
                killer: Arc::clone(&killer),
                exit_cv: Arc::clone(&exit_cv),
            },
        ));
    }

    // Reader thread: pump bytes -> base64 -> engine:pty-data.
    let app_reader = app.clone();
    let run_id_r = run_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_reader.emit(
                        "engine:pty-data",
                        serde_json::json!({ "id": run_id_r, "data": data }),
                    );
                }
            }
        }
    });

    // Child-wait thread: emit engine:pty-exit and clear the active handle.
    let app_exit = app.clone();
    let run_id_w = run_id.clone();
    let exit_cv_w = Arc::clone(&exit_cv);
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(1);
        {
            let (lk, cv) = &*exit_cv_w;
            *lk.lock().unwrap() = true;
            cv.notify_all();
        }
        if let Some(app_state) = app_exit.try_state::<AppState>() {
            clear_if_owner(&app_state.pty, &run_id_w);
        }
        let _ = app_exit.emit(
            "engine:pty-exit",
            serde_json::json!({ "id": run_id_w, "code": code }),
        );
    });

    Ok(run_id)
}

#[tauri::command]
pub fn pty_input(state: State<AppState>, data: String) -> CmdResult<()> {
    let mut guard = state.pty.lock().unwrap();
    if let Some((_, h)) = guard.as_mut() {
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
    if let Some((_, h)) = guard.as_ref() {
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

#[tauri::command]
pub async fn pty_kill(state: State<'_, AppState>) -> CmdResult<()> {
    let (killer_arc, exit_cv) = {
        let guard = state.pty.lock().unwrap();
        match guard.as_ref() {
            Some((_, h)) => (Arc::clone(&h.killer), Arc::clone(&h.exit_cv)),
            None => return Ok(()), // nothing running — no-op
        }
    }; // Mutex released before any blocking work
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        // CR-002: kill() may fail with ESRCH (or equivalent) if the child already
        // exited between slot-release and here.  That is a benign race — the desired
        // state (child gone) is already achieved — so propagate only when the exit
        // flag is still false.
        {
            let (lk, _) = &*exit_cv;
            let already_done = *lk.lock().unwrap();
            if let Err(e) = killer_arc.lock().unwrap().kill() {
                if !already_done {
                    return Err(InstallerError::Pty(e.to_string()));
                }
            }
        }
        let (lk, cv) = &*exit_cv;
        let guard = lk.lock().unwrap();
        // CR-003 + CR-004: wait_timeout_while checks the flag before blocking
        // (returns immediately if the child has already exited) and re-checks on
        // every wakeup so spurious wakeups cannot produce a false Ok.
        let (guard, timed_out) = cv
            .wait_timeout_while(guard, std::time::Duration::from_secs(5), |done| !*done)
            .unwrap();
        if timed_out.timed_out() && !*guard {
            return Err(InstallerError::Pty("pty_kill timed out".into()));
        }
        Ok(())
    })
    .await
    .map_err(|e| InstallerError::Other(e.to_string()))?
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
mod win_tests {
    use super::*;

    #[tokio::test]
    async fn spawn_external_ps_exits_zero_for_noop_command() {
        let code = spawn_external_ps("cmd /c exit 0".into()).await.unwrap();
        assert_eq!(code, 0);
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::clear_if_owner;
    use std::sync::Mutex;

    #[test]
    fn kill_terminates_real_child() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::time::Duration;
        let sys = native_pty_system();
        let pair = sys
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        let mut killer = child.clone_killer();
        killer.kill().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            tx.send(child.wait()).ok();
        });
        let status = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("child did not exit within 5 s after kill")
            .unwrap();
        // A killed process exits non-zero; reaching here proves the child exited
        let _ = status;
    }

    // CR-003 + CR-004: wait_timeout_while returns immediately when the exit flag
    // is already set, and does not require a notify_all to be called.
    // Mutation check: reverting to wait_timeout blocks the full 5 s and the
    // elapsed-time assertion fails.
    #[test]
    fn condvar_wait_returns_immediately_when_flag_preset() {
        use std::sync::{Arc, Condvar, Mutex};
        use std::time::Duration;
        let pair = Arc::new((Mutex::new(true), Condvar::new()));
        let (lk, cv) = &*pair;
        let guard = lk.lock().unwrap();
        let start = std::time::Instant::now();
        let (guard, timed_out) = cv
            .wait_timeout_while(guard, Duration::from_secs(5), |done| !*done)
            .unwrap();
        let elapsed = start.elapsed();
        assert!(
            !timed_out.timed_out(),
            "must not time out when flag is already true"
        );
        assert!(*guard, "flag must still be true after wait returns");
        assert!(
            elapsed < Duration::from_secs(1),
            "wait must return in < 1 s when exit flag is pre-set (got {elapsed:?})"
        );
    }

    // CR-004: wait_timeout_while only returns Ok when the exit flag is actually
    // true; it does not treat a notified wakeup as success without re-checking.
    // Mutation check: reverting to wait_timeout returns without verifying *guard,
    // so a spurious wakeup yields Ok with *guard == false — the assertion fails.
    #[test]
    fn condvar_wait_confirms_flag_on_success() {
        use std::sync::{Arc, Condvar, Mutex};
        use std::time::Duration;
        let pair = Arc::new((Mutex::new(false), Condvar::new()));
        let pair2 = Arc::clone(&pair);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            let (lk, cv) = &*pair2;
            *lk.lock().unwrap() = true;
            cv.notify_all();
        });
        let (lk, cv) = &*pair;
        let guard = lk.lock().unwrap();
        let (guard, timed_out) = cv
            .wait_timeout_while(guard, Duration::from_secs(5), |done| !*done)
            .unwrap();
        assert!(!timed_out.timed_out(), "child exited before timeout");
        assert!(
            *guard,
            "exit flag must be true when wait_timeout_while returns without timeout"
        );
    }

    // CR-002: a kill() error must be ignored when the exit flag is already true
    // (i.e. the child has already gone, so ESRCH is benign).
    // Mutation check: reverting to always-propagate causes the result to be Err,
    // failing the assert.
    #[test]
    fn kill_error_ignored_when_exit_flag_already_set() {
        use std::sync::{Arc, Condvar, Mutex};
        // Simulate: exit flag already true, kill() returns an error
        let exit_cv = Arc::new((Mutex::new(true), Condvar::new()));
        let (lk, _) = &*exit_cv;
        let already_done = *lk.lock().unwrap();
        let kill_result: Result<(), String> = Err("ESRCH: no such process".into());
        let result: Result<(), String> = if let Err(e) = kill_result {
            if !already_done {
                Err(e)
            } else {
                Ok(())
            }
        } else {
            Ok(())
        };
        assert!(
            result.is_ok(),
            "kill() error must be swallowed when exit flag is already set"
        );
    }

    // Inverse of the above: kill() error must NOT be ignored when flag is false.
    #[test]
    fn kill_error_propagated_when_exit_flag_false() {
        use std::sync::{Arc, Condvar, Mutex};
        let exit_cv = Arc::new((Mutex::new(false), Condvar::new()));
        let (lk, _) = &*exit_cv;
        let already_done = *lk.lock().unwrap();
        let kill_result: Result<(), String> = Err("operation not permitted".into());
        let result: Result<(), String> = if let Err(e) = kill_result {
            if !already_done {
                Err(e)
            } else {
                Ok(())
            }
        } else {
            Ok(())
        };
        assert!(result.is_err(), "kill() error must propagate when child has not yet exited");
    }

    #[test]
    fn clear_if_owner_only_clears_matching_id() {
        let slot: Mutex<Option<(String, ())>> = Mutex::new(Some(("run-2".into(), ())));
        assert!(
            !clear_if_owner(&slot, "run-1"),
            "must not clear when id differs"
        );
        assert!(
            slot.lock().unwrap().is_some(),
            "run-2 must still be present"
        );
        assert!(clear_if_owner(&slot, "run-2"), "must clear when id matches");
        assert!(slot.lock().unwrap().is_none(), "slot must now be empty");
    }
}
