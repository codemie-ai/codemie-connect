//! Connect's own terminal, the dock under every page (`ui/workspace/terminal-dock.js`): Claude Code
//! sessions in a real PTY inside Connect, one tab each. It is where a plugin's
//! `ctx.claude.session` opens (Knowledge's "Ask the vault", as in Echo's terminal panel) and where
//! Settings → CodeMie starts a coding agent.
//!
//! - Rust decides what runs: a `Launch` is built here from a plugin's checked session or a
//!   validated agent launch. The window only types into, resizes, starts again and closes a
//!   session it is shown; it never names a program.
//! - The program starts like Terminal.app starts it: through a login `zsh`, in the folder, with
//!   its words passed as arguments (`exec "$0" "$@"`), so nothing in them reaches the shell as
//!   code. A parent Claude Code session's variables are removed.
//! - Each session keeps its newest output (`SCROLLBACK`), so a tab drawn again (the window
//!   reloaded or opened again) shows what ran. Output events carry the byte offset they start
//!   at, so a tab that read the kept output skips the events already in it.
//! - "Start again" runs the same words plus the session's `resume` ones (`--continue` for Claude
//!   Code: the conversation goes on). Each start is a new generation; events of an older one are
//!   ignored by the window.
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{CmdResult, InstallerError};

/// Output kept per session for a tab drawn again: the newest bytes.
const SCROLLBACK: usize = 1 << 20;
/// How far past the cut the kept output looks for a line start, so a replay starts cleanly.
const CLEAN_CUT: usize = 4096;
const READ_BUF: usize = 8192;
/// The size a session starts at, until the dock measures its tab.
const START_COLS: u16 = 120;
const START_ROWS: u16 = 32;
/// A name shown on a tab: at most this many characters.
const NAME_MAX: usize = 60;
/// Starts kept in the launch log.
const LAUNCH_LOG_MAX: usize = 2000;

pub const OPENED: &str = "terminal:opened";
pub const DATA: &str = "terminal:data";
pub const EXIT: &str = "terminal:exit";

/// What a session starts with of Connect's own environment: what macOS gives every app, as a
/// new Terminal window has. Anything else Connect was started with (a parent Claude Code
/// session's variables among them) stays out; the person's login shell adds their own exports.
const BASE_ENV: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSH_AUTH_SOCK",
    "__CF_USER_TEXT_ENCODING",
];
/// Run by `zsh -f` (no startup files): takes the exports of the person's login shell, without
/// anything it prints (a broken line in `~/.zprofile`), keeps Connect's PATH after theirs, then
/// runs the session's program with its words as arguments.
const START: &str = r#"env="$(/bin/zsh -l -c 'print -r -- __CONNECT_ENV__; export -p' 2>/dev/null)"
eval "${env#*__CONNECT_ENV__}" 2>/dev/null
export PATH="${PATH:+$PATH:}$CONNECT_PATH"
unset CONNECT_PATH
exec "$0" "$@""#;

/// Sends one event to the window (`AppHandle::emit` in the app; a recorder in tests).
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// What a tab runs. Built in Rust only (`claude_launch`, `agent_launch`).
#[derive(Clone, Debug, PartialEq)]
pub struct Launch {
    /// One tab per key: opening the same key again shows that tab.
    pub key: String,
    /// The tab's name (the folder's) and what runs there.
    pub title: String,
    pub detail: String,
    /// What runs, for the person ("Claude Code").
    pub program: String,
    pub folder: PathBuf,
    pub argv: Vec<String>,
    /// Added to `argv` when the session starts again.
    pub resume: Vec<String>,
}

/// A tab as the window draws it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: String,
    pub key: String,
    pub title: String,
    pub detail: String,
    pub program: String,
    pub folder: String,
    pub running: bool,
    /// How the last start ended, once it has.
    pub code: Option<i32>,
    /// Starting again goes on with the conversation.
    pub resumable: bool,
    /// Which start this is (1 for the first).
    pub generation: u64,
    /// Claude Code's own theme when this start began (`claude_theme`): the colours its output is
    /// made for, so the tab is drawn dark or light to match.
    pub theme: &'static str,
}

/// A tab with the output it kept: `data` (base64) ends at byte `end` of everything it printed.
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    #[serde(flatten)]
    pub info: Info,
    pub data: String,
    pub end: u64,
}

/// The newest output of one start, and how many bytes it printed in all.
#[derive(Default)]
struct Output {
    kept: VecDeque<u8>,
    end: u64,
}

impl Output {
    /// Keeps `bytes`; returns the offset they start at.
    fn push(&mut self, bytes: &[u8]) -> u64 {
        let at = self.end;
        self.kept.extend(bytes);
        self.end += bytes.len() as u64;
        if self.kept.len() > SCROLLBACK {
            let mut cut = self.kept.len() - SCROLLBACK;
            // Start at a line, when one begins soon after the cut.
            if let Some(nl) = self
                .kept
                .iter()
                .skip(cut)
                .take(CLEAN_CUT)
                .position(|b| *b == b'\n')
            {
                cut += nl + 1;
            }
            self.kept.drain(..cut);
        }
        at
    }
}

struct Pty {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

struct Session {
    launch: Launch,
    info: Info,
    /// While the program runs.
    pty: Option<Pty>,
    output: Arc<Mutex<Output>>,
    size: (u16, u16),
}

/// Appends `line` to `path` and, past [`LAUNCH_LOG_MAX`] lines, rewrites it with the newest ones
/// through a temp file, so a crash leaves the old lines whole.
fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")?;
    drop(file);
    let text = std::fs::read_to_string(path)?;
    let count = text.lines().count();
    if count > LAUNCH_LOG_MAX {
        let kept: Vec<&str> = text.lines().skip(count - LAUNCH_LOG_MAX).collect();
        let tmp = path.with_extension("jsonl.tmp");
        std::fs::write(&tmp, format!("{}\n", kept.join("\n")))?;
        std::fs::rename(&tmp, path)?;
    }
    Ok(())
}

/// Every session of the app (managed state). Clones share them.
#[derive(Clone, Default)]
pub struct Terminals {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    next: Arc<AtomicU64>,
    /// Where each start is noted for Analytics (`set_launch_log`); none until Core is open.
    launch_log: Arc<Mutex<Option<PathBuf>>>,
}

impl Terminals {
    /// Sets the file every start of a session is noted in, one JSON line each.
    pub fn set_launch_log(&self, path: PathBuf) {
        *self.launch_log.lock().unwrap() = Some(path);
    }

    /// Notes one start: `{"at":<ms>,"folder":..,"program":argv[0]}`, appended, the oldest lines
    /// dropped past [`LAUNCH_LOG_MAX`] by an atomic rewrite. Never fails a start: a problem is
    /// only logged.
    fn log_launch(&self, launch: &Launch) {
        let guard = self.launch_log.lock().unwrap();
        let Some(path) = guard.as_ref() else { return };
        let line = json!({
            "at": chrono::Utc::now().timestamp_millis(),
            "folder": launch.folder.to_string_lossy(),
            "program": launch.argv.first(),
        });
        if let Err(e) = append_line(path, &line.to_string()) {
            log::warn!("terminal: cannot note a launch: {e}");
        }
    }

    /// Shows the tab of `launch.key` if it runs; starts it again (going on) if it ended;
    /// otherwise starts a new tab. The window hears `terminal:opened` either way.
    pub fn open(&self, launch: Launch, emit: Emit) -> Result<Info, String> {
        let existing = {
            let map = self.sessions.lock().unwrap();
            map.values()
                .find(|s| s.launch.key == launch.key)
                .map(|s| (s.info.id.clone(), s.pty.is_some()))
        };
        let info = match existing {
            Some((id, true)) => self.info(&id).ok_or("That session is gone.")?,
            Some((id, false)) => return self.restart(&id, emit),
            None => {
                let id = format!("t{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
                let info = Info {
                    id: id.clone(),
                    key: launch.key.clone(),
                    title: launch.title.clone(),
                    detail: launch.detail.clone(),
                    program: launch.program.clone(),
                    folder: launch.folder.to_string_lossy().into_owned(),
                    running: false,
                    code: None,
                    resumable: !launch.resume.is_empty(),
                    generation: 0,
                    theme: "dark",
                };
                self.sessions.lock().unwrap().insert(
                    id.clone(),
                    Session {
                        launch,
                        info,
                        pty: None,
                        output: Arc::default(),
                        size: (START_COLS, START_ROWS),
                    },
                );
                match self.start(&id, false, emit.clone()) {
                    Ok(info) => info,
                    Err(e) => {
                        self.sessions.lock().unwrap().remove(&id);
                        return Err(e);
                    }
                }
            }
        };
        emit(OPENED, json!({ "info": info }));
        Ok(info)
    }

    /// Runs the session's program again, going on where it can.
    pub fn restart(&self, id: &str, emit: Emit) -> Result<Info, String> {
        self.stop(id);
        let info = self.start(id, true, emit.clone())?;
        emit(OPENED, json!({ "info": info }));
        Ok(info)
    }

    /// Starts generation n+1 of session `id` in a new PTY.
    fn start(&self, id: &str, resume: bool, emit: Emit) -> Result<Info, String> {
        let (launch, (cols, rows), generation) = {
            let map = self.sessions.lock().unwrap();
            let s = map.get(id).ok_or("That session is gone.")?;
            (s.launch.clone(), s.size, s.info.generation + 1)
        };
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Connect couldn't open a terminal: {e}"))?;
        let mut child = pair
            .slave
            .spawn_command(command(&launch, resume))
            .map_err(|e| format!("Connect couldn't start {}: {e}", launch.program))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let output: Arc<Mutex<Output>> = Arc::default();
        let info = {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(id) else {
                let _ = child.kill();
                return Err("That session is gone.".into());
            };
            s.pty = Some(Pty {
                writer,
                master: pair.master,
                killer: child.clone_killer(),
            });
            s.output = Arc::clone(&output);
            s.info.running = true;
            s.info.code = None;
            s.info.generation = generation;
            s.info.theme = claude_theme(&home_dir());
            s.info.clone()
        };
        self.log_launch(&launch);

        // Output: kept, then sent with the offset it starts at.
        let (id_r, emit_r) = (id.to_string(), emit.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let at = output.lock().unwrap().push(&buf[..n]);
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        emit_r(
                            DATA,
                            json!({ "id": id_r, "generation": generation, "at": at, "data": data }),
                        );
                    }
                }
            }
        });

        // The end: recorded on this generation only (a newer start owns the tab now).
        let (sessions, id_w) = (Arc::clone(&self.sessions), id.to_string());
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(1);
            {
                let mut map = sessions.lock().unwrap();
                match map.get_mut(&id_w) {
                    Some(s) if s.info.generation == generation => {
                        s.pty = None;
                        s.info.running = false;
                        s.info.code = Some(code);
                    }
                    _ => return,
                }
            }
            emit(
                EXIT,
                json!({ "id": id_w, "generation": generation, "code": code }),
            );
        });
        Ok(info)
    }

    /// Types `data` into session `id`.
    pub fn input(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let pty = map
            .get_mut(id)
            .and_then(|s| s.pty.as_mut())
            .ok_or("That session has ended.")?;
        pty.writer.write_all(data).map_err(|e| e.to_string())?;
        let _ = pty.writer.flush();
        Ok(())
    }

    /// The tab's size in cells; kept for the next start too.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = (cols.clamp(2, 1000), rows.clamp(1, 500));
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(id).ok_or("That session is gone.")?;
        s.size = (cols, rows);
        if let Some(pty) = &s.pty {
            pty.master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Ends the program of session `id` (SIGHUP, as a closed terminal window does). Its tab stays.
    fn stop(&self, id: &str) {
        let pty = self
            .sessions
            .lock()
            .unwrap()
            .get_mut(id)
            .and_then(|s| s.pty.take());
        if let Some(mut pty) = pty {
            let _ = pty.killer.kill();
        }
    }

    /// Ends session `id` and takes its tab away.
    pub fn close(&self, id: &str) {
        self.stop(id);
        self.sessions.lock().unwrap().remove(id);
    }

    /// Ends session `id`, takes its tab away and gives back what it ran, to go on elsewhere.
    pub fn take(&self, id: &str) -> Option<Launch> {
        self.stop(id);
        self.sessions.lock().unwrap().remove(id).map(|s| s.launch)
    }

    /// Ends every session (Connect quits).
    pub fn close_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    pub fn info(&self, id: &str) -> Option<Info> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.info.clone())
    }

    /// Every tab with its kept output, oldest first.
    pub fn list(&self) -> Vec<Snapshot> {
        let map = self.sessions.lock().unwrap();
        let mut out: Vec<Snapshot> = map
            .values()
            .map(|s| {
                let o = s.output.lock().unwrap();
                let bytes: Vec<u8> = o.kept.iter().copied().collect();
                Snapshot {
                    info: s.info.clone(),
                    data: base64::engine::general_purpose::STANDARD.encode(bytes),
                    end: o.end,
                }
            })
            .collect();
        out.sort_by_key(|s| s.info.id[1..].parse::<u64>().unwrap_or(0));
        out
    }
}

/// The `zsh` that runs `launch` in its folder as a new Terminal window would (`START`): its
/// words are arguments, never shell code.
fn command(launch: &Launch, resume: bool) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.args(["-f", "-c", START]);
    cmd.args(&launch.argv);
    if resume {
        cmd.args(&launch.resume);
    }
    cmd.cwd(&launch.folder);
    cmd.env_clear();
    for k in BASE_ENV {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    let path = std::env::var("PATH").unwrap_or_default();
    for (k, v) in super::pty::pty_env_pairs(&path) {
        if k == "PATH" {
            cmd.env("PATH", &v);
            cmd.env("CONNECT_PATH", v);
        } else {
            cmd.env(k, v);
        }
    }
    cmd.env("COLORTERM", "truecolor");
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

/// Claude Code's theme (`theme` in `~/.claude.json`, the only value read there): "light" for its
/// light themes, else "dark" (its default).
pub fn claude_theme(home: &Path) -> &'static str {
    let theme = std::fs::metadata(home.join(".claude.json"))
        .ok()
        .filter(|m| m.len() <= 64 << 20)
        .and_then(|_| std::fs::read(home.join(".claude.json")).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("theme").and_then(Value::as_str).map(str::to_string));
    match theme {
        Some(t) if t.starts_with("light") => "light",
        _ => "dark",
    }
}

/// A name for a tab: one line, at most `NAME_MAX` characters.
fn name(s: &str) -> String {
    let one: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let one = one.split_whitespace().collect::<Vec<_>>().join(" ");
    one.chars().take(NAME_MAX).collect()
}

fn folder_name(folder: &Path) -> String {
    name(
        &folder
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| folder.to_string_lossy().into_owned()),
    )
}

/// The tab of a plugin's Claude Code session (`ctx.claude.session`, after `window::session`'s
/// checks): one per plugin and folder; starting again goes on with the conversation.
pub fn claude_launch(
    plugin_id: &str,
    plugin_name: &str,
    folder: &Path,
    argv: Vec<String>,
) -> Launch {
    Launch {
        key: format!("plugin:{plugin_id}:{}", folder.to_string_lossy()),
        title: folder_name(folder),
        detail: name(plugin_name),
        program: "Claude Code".into(),
        folder: folder.to_path_buf(),
        argv,
        resume: vec!["--continue".into()],
    }
}

/// The tab of a coding agent Settings → CodeMie starts (`<launcher> --profile <profile>`, after
/// `terminal_launch::validate_launch`): one per agent and folder. Only `codemie-claude` takes
/// `--continue`.
pub fn agent_launch(
    folder: &Path,
    launcher: &str,
    profile: &str,
    agent: &str,
) -> Result<Launch, String> {
    super::terminal_launch::validate_launch(folder, launcher, profile)?;
    Ok(Launch {
        key: format!("agent:{launcher}:{}", folder.to_string_lossy()),
        title: folder_name(folder),
        detail: name(&format!("CodeMie · {profile}")),
        program: name(if agent.trim().is_empty() {
            launcher
        } else {
            agent
        }),
        folder: folder.to_path_buf(),
        argv: vec![launcher.into(), "--profile".into(), profile.into()],
        resume: if launcher == "codemie-claude" {
            vec!["--continue".into()]
        } else {
            vec![]
        },
    })
}

// ------------------------------------------------------------------ commands

fn app_emit(app: &tauri::AppHandle) -> Emit {
    use tauri::Emitter;
    let app = app.clone();
    Arc::new(move |event: &str, payload: Value| {
        let _ = app.emit(event, payload);
    })
}

fn main_only(window: &tauri::WebviewWindow, call: &tauri::ipc::Request<'_>) -> CmdResult<()> {
    crate::plugins::caller::require_main_frame(call)
        .map_err(|e| InstallerError::Other(e.message))?;
    crate::storage::commands::main_window_only(window.label())
        .map_err(|e| InstallerError::Other(e.message))
}

/// Every tab with its kept output (the dock draws them at start).
#[tauri::command]
pub fn terminal_list(
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    terminals: tauri::State<'_, Terminals>,
) -> CmdResult<Vec<Snapshot>> {
    main_only(&window, &call)?;
    Ok(terminals.list())
}

#[tauri::command]
pub fn terminal_input(
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    terminals: tauri::State<'_, Terminals>,
    id: String,
    data: String,
) -> CmdResult<()> {
    main_only(&window, &call)?;
    terminals
        .input(&id, data.as_bytes())
        .map_err(InstallerError::Other)
}

#[tauri::command]
pub fn terminal_resize(
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    terminals: tauri::State<'_, Terminals>,
    id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    main_only(&window, &call)?;
    terminals
        .resize(&id, cols, rows)
        .map_err(InstallerError::Other)
}

#[tauri::command]
pub fn terminal_restart(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    terminals: tauri::State<'_, Terminals>,
    id: String,
) -> CmdResult<Info> {
    main_only(&window, &call)?;
    terminals
        .restart(&id, app_emit(&app))
        .map_err(InstallerError::Other)
}

#[tauri::command]
pub fn terminal_close(
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    terminals: tauri::State<'_, Terminals>,
    id: String,
) -> CmdResult<()> {
    main_only(&window, &call)?;
    terminals.close(&id);
    Ok(())
}

/// Ends the tab here and goes on in Terminal.app, in the same folder, with the same words (and
/// `--continue` where the program takes it).
#[tauri::command]
pub fn terminal_move_out(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    terminals: tauri::State<'_, Terminals>,
    id: String,
) -> CmdResult<()> {
    main_only(&window, &call)?;
    let launch = terminals
        .take(&id)
        .ok_or_else(|| InstallerError::Other("That session is gone.".into()))?;
    let mut argv = launch.argv;
    argv.extend(launch.resume);
    super::terminal_launch::open_session(&app, &launch.folder, &argv)
}

/// A coding agent Settings → CodeMie starts: `<launcher> --profile <profile>` in `folder`;
/// `agent` names it on the tab.
#[derive(Debug, serde::Deserialize)]
pub struct AgentStart {
    folder: String,
    launcher: String,
    profile: String,
    #[serde(default)]
    agent: String,
}

/// Settings → CodeMie: a coding agent in a folder, in a tab here.
#[tauri::command]
pub fn terminal_open_agent(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    terminals: tauri::State<'_, Terminals>,
    start: AgentStart,
) -> CmdResult<Info> {
    main_only(&window, &call)?;
    let launch = agent_launch(
        Path::new(&start.folder),
        &start.launcher,
        &start.profile,
        &start.agent,
    )
    .map_err(InstallerError::Other)?;
    terminals
        .open(launch, app_emit(&app))
        .map_err(InstallerError::Other)
}

/// A web address the person ⌘-clicked in a tab: https only, to the browser.
#[tauri::command]
pub fn terminal_open_link(
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    url: String,
) -> CmdResult<()> {
    main_only(&window, &call)?;
    crate::workspace::graph::open_url(&url).map_err(|e| InstallerError::Other(e.message))
}

/// A plugin's Claude Code session (`frame_session`), in a tab here.
pub fn open_claude(
    app: &tauri::AppHandle,
    plugin_id: &str,
    plugin_name: &str,
    folder: &Path,
    argv: Vec<String>,
) -> Result<Info, String> {
    use tauri::Manager;
    let terminals = app
        .try_state::<Terminals>()
        .ok_or("Connect's terminal isn't ready.")?;
    terminals.open(
        claude_launch(plugin_id, plugin_name, folder, argv),
        app_emit(app),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    type Events = Arc<Mutex<Vec<(String, Value)>>>;

    fn recorder() -> (Emit, Events, mpsc::Receiver<(String, Value)>) {
        let events: Events = Arc::default();
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let seen = Arc::clone(&events);
        let emit: Emit = Arc::new(move |e: &str, v: Value| {
            seen.lock().unwrap().push((e.to_string(), v.clone()));
            let _ = tx.lock().unwrap().send((e.to_string(), v));
        });
        (emit, events, rx)
    }

    fn launch(folder: &Path, argv: &[&str], resume: &[&str]) -> Launch {
        Launch {
            key: format!("test:{}", argv.join(" ")),
            title: folder_name(folder),
            detail: "Test".into(),
            program: "Test".into(),
            folder: folder.to_path_buf(),
            argv: argv.iter().map(|s| s.to_string()).collect(),
            resume: resume.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Waits for `event` of session `id` (and `generation`, when given).
    fn wait_for(
        rx: &mpsc::Receiver<(String, Value)>,
        event: &str,
        id: &str,
        generation: u64,
    ) -> Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let (e, v) = rx
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("no {event} for {id}"));
            if e == event && v["id"] == id && v["generation"] == generation {
                return v;
            }
        }
    }

    fn printed(events: &Events, id: &str, generation: u64) -> String {
        let bytes: Vec<u8> = events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, v)| e == DATA && v["id"] == id && v["generation"] == generation)
            .flat_map(|(_, v)| {
                base64::engine::general_purpose::STANDARD
                    .decode(v["data"].as_str().unwrap())
                    .unwrap()
            })
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn kept(t: &Terminals, id: &str) -> String {
        let snap = t.list().into_iter().find(|s| s.info.id == id).unwrap();
        String::from_utf8_lossy(
            &base64::engine::general_purpose::STANDARD
                .decode(snap.data)
                .unwrap(),
        )
        .into_owned()
    }

    #[test]
    fn a_session_runs_in_its_folder_and_keeps_what_it_printed() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().canonicalize().unwrap().join("My 'Vault' $(x)");
        std::fs::create_dir_all(&folder).unwrap();
        let (emit, events, rx) = recorder();
        let t = Terminals::default();
        let info = t
            .open(launch(&folder, &["/bin/pwd", "-P"], &[]), emit)
            .unwrap();
        assert_eq!(info.title, "My 'Vault' $(x)");
        assert!(info.running);
        assert_eq!(events.lock().unwrap()[0].0, OPENED);
        let end = wait_for(&rx, EXIT, &info.id, 1);
        assert_eq!(end["code"], 0);
        // The exit may come before the last output is read: wait for it in the kept output.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !kept(&t, &info.id).contains("My 'Vault' $(x)") {
            assert!(
                std::time::Instant::now() < deadline,
                "{}",
                kept(&t, &info.id)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(printed(&events, &info.id, 1).contains("My 'Vault' $(x)"));
        let snap = t.list().remove(0);
        assert!(!snap.info.running);
        assert_eq!(snap.info.code, Some(0));
        assert_eq!(
            snap.end as usize,
            base64::engine::general_purpose::STANDARD
                .decode(&snap.data)
                .unwrap()
                .len()
        );
    }

    #[test]
    fn typing_reaches_the_program_and_its_answer_comes_back() {
        let dir = tempfile::tempdir().unwrap();
        let (emit, events, rx) = recorder();
        let t = Terminals::default();
        let info = t
            .open(launch(dir.path(), &["/bin/cat"], &[]), emit)
            .unwrap();
        t.resize(&info.id, 80, 24).unwrap();
        t.input(&info.id, b"hello from connect\n").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while printed(&events, &info.id, 1)
            .matches("hello from connect")
            .count()
            < 2
        {
            assert!(
                std::time::Instant::now() < deadline,
                "{}",
                printed(&events, &info.id, 1)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        // Closing ends the program and takes the tab away.
        t.close(&info.id);
        assert!(t.list().is_empty());
        assert!(t.input(&info.id, b"x").is_err());
        drop(rx);
    }

    #[test]
    fn terminal_open_and_restart_append_one_launch_line_each() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("terminal-launches.jsonl");
        let (emit, _events, _rx) = recorder();
        let t = Terminals::default();
        t.set_launch_log(log.clone());
        let info = t
            .open(launch(dir.path(), &["/bin/cat"], &[]), emit.clone())
            .unwrap();
        // Showing the tab of a session that runs starts nothing.
        t.open(launch(dir.path(), &["/bin/cat"], &[]), emit.clone())
            .unwrap();
        t.restart(&info.id, emit).unwrap();
        let lines: Vec<Value> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        for line in &lines {
            assert_eq!(line["folder"], dir.path().to_string_lossy().as_ref());
            assert_eq!(line["program"], "/bin/cat");
            assert!(line["at"].as_i64().unwrap() > 1_700_000_000_000);
        }
        t.close_all();
    }

    #[test]
    fn the_launch_log_keeps_the_newest_2000_lines_and_a_bad_path_fails_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("terminal-launches.jsonl");
        let old: String = (0..LAUNCH_LOG_MAX)
            .map(|i| format!("{{\"at\":{i},\"folder\":\"/f\",\"program\":\"p\"}}\n"))
            .collect();
        std::fs::write(&log, old).unwrap();
        let t = Terminals::default();
        t.set_launch_log(log.clone());
        t.log_launch(&launch(Path::new("/new"), &["claude"], &[]));
        let text = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), LAUNCH_LOG_MAX);
        assert!(lines[0].contains("\"at\":1,"), "the oldest line went");
        assert!(lines[LAUNCH_LOG_MAX - 1].contains("/new"));
        // A log that can't be written is only logged.
        t.set_launch_log(dir.path().join("no/such/dir/x.jsonl"));
        t.log_launch(&launch(Path::new("/new"), &["claude"], &[]));
    }

    #[test]
    fn opening_the_same_session_again_shows_its_tab() {
        let dir = tempfile::tempdir().unwrap();
        let (emit, events, _rx) = recorder();
        let t = Terminals::default();
        let first = t
            .open(launch(dir.path(), &["/bin/sleep", "30"], &[]), emit.clone())
            .unwrap();
        let again = t
            .open(launch(dir.path(), &["/bin/sleep", "30"], &[]), emit)
            .unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(again.generation, 1, "no second program");
        assert_eq!(t.list().len(), 1);
        let opened = events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == OPENED)
            .count();
        assert_eq!(opened, 2, "the window shows the tab each time");
        t.close_all();
        assert!(t.list().is_empty());
    }

    #[test]
    fn starting_again_goes_on_with_the_resume_words_in_a_fresh_output() {
        let dir = tempfile::tempdir().unwrap();
        let (emit, events, rx) = recorder();
        let t = Terminals::default();
        let info = t
            .open(
                launch(dir.path(), &["/bin/echo", "first"], &["again"]),
                emit.clone(),
            )
            .unwrap();
        assert!(info.resumable);
        wait_for(&rx, EXIT, &info.id, 1);
        // An ended tab opened again starts again, going on.
        let next = t
            .open(
                launch(dir.path(), &["/bin/echo", "first"], &["again"]),
                emit,
            )
            .unwrap();
        assert_eq!(next.id, info.id);
        assert_eq!(next.generation, 2);
        wait_for(&rx, EXIT, &info.id, 2);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !kept(&t, &info.id).contains("first again") {
            assert!(
                std::time::Instant::now() < deadline,
                "{}",
                kept(&t, &info.id)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(printed(&events, &info.id, 2).contains("first again"));
        assert_eq!(
            kept(&t, &info.id).matches("first").count(),
            1,
            "the first start's output is gone"
        );
    }

    #[test]
    fn a_program_that_is_not_there_ends_with_127() {
        let dir = tempfile::tempdir().unwrap();
        let (emit, _events, rx) = recorder();
        let t = Terminals::default();
        let info = t
            .open(
                launch(dir.path(), &["connect-no-such-program-x1"], &[]),
                emit,
            )
            .unwrap();
        assert_eq!(wait_for(&rx, EXIT, &info.id, 1)["code"], 127);
        assert_eq!(t.info(&info.id).unwrap().code, Some(127));
    }

    #[test]
    fn closing_a_running_session_ends_its_program() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let (emit, _events, _rx) = recorder();
        let t = Terminals::default();
        let info = t
            .open(
                launch(
                    dir.path(),
                    &["/bin/sh", "-c", "echo $$ > pid; exec /bin/sleep 30"],
                    &[],
                ),
                emit,
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let pid = loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|s| s.trim().parse::<i32>().ok())
            {
                break pid;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the program didn't start"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        let alive = || unsafe { libc::kill(pid, 0) } == 0;
        assert!(alive());
        t.close(&info.id);
        assert!(t.info(&info.id).is_none());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while alive() {
            assert!(
                std::time::Instant::now() < deadline,
                "the program outlived its tab"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn the_command_passes_words_as_arguments_from_a_clean_environment() {
        let l = launch(
            Path::new("/tmp/vault"),
            &["claude", "--tools", "$(rm -rf ~)"],
            &["--continue"],
        );
        let words = |c: &CommandBuilder| -> Vec<String> {
            c.get_argv()
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        let first = command(&l, false);
        assert_eq!(
            words(&first),
            [
                "/bin/zsh",
                "-f",
                "-c",
                START,
                "claude",
                "--tools",
                "$(rm -rf ~)"
            ]
        );
        assert_eq!(words(&command(&l, true)).last().unwrap(), "--continue");
        assert_eq!(first.get_cwd().unwrap(), "/tmp/vault");
        assert_eq!(first.get_env("TERM").unwrap(), "xterm-256color");
        assert_eq!(first.get_env("COLORTERM").unwrap(), "truecolor");
        assert_eq!(first.get_env("PATH"), first.get_env("CONNECT_PATH"));
        // Nothing else Connect was started with: cargo's variables, a parent Claude Code session's.
        assert_eq!(first.get_env("CARGO_MANIFEST_DIR"), None);
        for k in crate::ai::command::SESSION_ENV_REMOVE {
            assert_eq!(first.get_env(k), None, "{k}");
        }
    }

    #[test]
    fn a_session_starts_quietly_with_the_login_environment_and_no_parent_session() {
        let dir = tempfile::tempdir().unwrap();
        let (emit, _events, rx) = recorder();
        let t = Terminals::default();
        let info = t
            .open(
                launch(
                    dir.path(),
                    &[
                        "/bin/sh",
                        "-c",
                        r#"printf '[%s|%s|%s|%s]' "${CLAUDECODE-unset}" "${CONNECT_PATH-unset}" "$TERM" "${HOME:+home}""#,
                    ],
                    &[],
                ),
                emit,
            )
            .unwrap();
        wait_for(&rx, EXIT, &info.id, 1);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !kept(&t, &info.id).contains(']') {
            assert!(
                std::time::Instant::now() < deadline,
                "{}",
                kept(&t, &info.id)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        // Whatever the login shell prints (a broken ~/.zprofile) never reaches the tab.
        assert_eq!(kept(&t, &info.id), "[unset|unset|xterm-256color|home]");
    }

    #[test]
    fn the_kept_output_is_the_newest_and_starts_at_a_line() {
        let mut o = Output::default();
        let line = format!("{}\n", "x".repeat(99));
        let mut at = 0;
        for _ in 0..(SCROLLBACK / 100 + 50) {
            assert_eq!(o.push(line.as_bytes()), at);
            at += 100;
        }
        assert_eq!(o.end, at);
        assert!(o.kept.len() <= SCROLLBACK);
        assert!(o.kept.len() > SCROLLBACK - CLEAN_CUT);
        assert_eq!(o.kept.front(), Some(&b'x'), "a whole line first");
        assert_eq!(o.kept.len() % 100, 0);
    }

    #[test]
    fn a_plugins_session_and_an_agent_get_their_own_tabs() {
        let c = claude_launch(
            "obsidian",
            "Knowledge",
            Path::new("/Users/taylor/ai-twin-knowledge"),
            vec!["claude".into()],
        );
        assert_eq!(c.key, "plugin:obsidian:/Users/taylor/ai-twin-knowledge");
        assert_eq!(
            (c.title.as_str(), c.detail.as_str(), c.program.as_str()),
            ("ai-twin-knowledge", "Knowledge", "Claude Code")
        );
        assert_eq!(c.resume, ["--continue"]);
        let dir = tempfile::tempdir().unwrap();
        let a = agent_launch(
            dir.path(),
            "codemie-claude",
            "work",
            "Claude Code\n(CodeMie)",
        )
        .unwrap();
        assert_eq!(a.argv, ["codemie-claude", "--profile", "work"]);
        assert_eq!(
            (a.program.as_str(), a.detail.as_str()),
            ("Claude Code (CodeMie)", "CodeMie · work")
        );
        assert_eq!(a.resume, ["--continue"]);
        assert!(agent_launch(dir.path(), "codemie-code", "work", "")
            .unwrap()
            .resume
            .is_empty());
        assert!(agent_launch(dir.path(), "rm", "work", "").is_err());
        assert!(agent_launch(dir.path(), "codemie-claude", "a b", "").is_err());
        assert!(agent_launch(Path::new("/no/such/folder"), "codemie-claude", "work", "").is_err());
        assert_eq!(name(&"y".repeat(200)).chars().count(), NAME_MAX);
    }

    #[test]
    fn a_tab_is_drawn_for_claude_codes_own_theme() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            claude_theme(home.path()),
            "dark",
            "no config: Claude Code's default"
        );
        let at = home.path().join(".claude.json");
        for (json, want) in [
            (r#"{"theme":"light"}"#, "light"),
            (r#"{"theme":"light-daltonized","projects":{}}"#, "light"),
            (r#"{"theme":"dark-ansi"}"#, "dark"),
            (r#"{"theme":7}"#, "dark"),
            ("not json", "dark"),
        ] {
            std::fs::write(&at, json).unwrap();
            assert_eq!(claude_theme(home.path()), want, "{json}");
        }
    }
}
