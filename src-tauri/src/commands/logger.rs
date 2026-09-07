// File logging to ~/Library/Logs/CodeMie/codemie_wizard.log. Port of src/main/logger.js.
use chrono::Utc;

use crate::error::{CmdResult, InstallerError};

// Map a renderer terminal-line tag to a short log tag.
fn map_tag(tag: &str) -> &'static str {
    match tag {
        "stdout" => "OUT",
        "stderr" => "ERR",
        "info" => "INF",
        "success" => "OK",
        "dim" => "---",
        "prompt" => "CMD",
        "approved" => "OK",
        _ => "OUT",
    }
}

/// Format a log line. `iso` overrides the timestamp (used by tests); otherwise now (UTC).
pub fn format_line(tag: &str, text: &str, iso: Option<&str>) -> String {
    let ts = match iso {
        Some(s) => s.to_string(),
        None => Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
    };
    format!("[{ts}] [{tag}] {text}")
}

#[cfg(not(windows))]
fn log_dir_with(home: &str) -> String {
    format!("{home}/Library/Logs/CodeMie")
}
#[cfg(windows)]
fn log_dir_with(profile: &str) -> String {
    format!(r"{profile}\AppData\Local\CodeMie\Logs")
}

#[cfg(not(windows))]
fn log_dir() -> String {
    log_dir_with(&std::env::var("HOME").unwrap_or_default())
}
#[cfg(windows)]
fn log_dir() -> String {
    log_dir_with(&std::env::var("USERPROFILE").unwrap_or_default())
}

pub fn log_path() -> String {
    format!("{}/codemie_wizard.log", log_dir())
}

fn ensure_log_readable(path: &str) -> CmdResult<()> {
    std::fs::File::open(path)
        .map(|_| ())
        .map_err(|_| InstallerError::Other(format!("log file not found or unreadable: {path}")))
}

#[cfg(not(windows))]
fn spawn_open(path: &str) -> CmdResult<()> {
    std::process::Command::new("open").arg(path).spawn().map_err(InstallerError::Io)?;
    Ok(())
}
#[cfg(windows)]
fn spawn_open(path: &str) -> CmdResult<()> {
    // "" is the required window-title arg for `start`, so a spaced path isn't
    // mistaken for it; this invokes the OS default handler for the file.
    std::process::Command::new("cmd")
        .args(["/c", "start", "", path])
        .spawn()
        .map_err(InstallerError::Io)?;
    Ok(())
}

/// Append a tagged line to the log file. Logging must never crash the app.
pub fn write_line(text: &str, tag: &str) {
    let _ = std::fs::create_dir_all(log_dir());
    let line = format_line(map_tag(tag), text, None) + "\n";
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = f.write_all(line.as_bytes());
    }
}

#[tauri::command]
pub fn log_line(text: String, tag: String) {
    write_line(&text, &tag);
}

#[tauri::command]
pub fn open_log() -> CmdResult<()> {
    let path = log_path();
    ensure_log_readable(&path)?;
    spawn_open(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from test/logger.test.js.
    #[test]
    fn format_line_tags_and_timestamps() {
        let line = format_line("OUT", "hello", Some("2026-06-10T00:00:00.000Z"));
        assert_eq!(line, "[2026-06-10T00:00:00.000Z] [OUT] hello");
    }

    #[test]
    fn format_line_generates_timestamp_when_none_given() {
        let line = format_line("INF", "x", None);
        // Matches: ^\[\d{4}-\d{2}-\d{2}T.*Z\] \[INF\] x$
        assert!(line.starts_with('['));
        assert!(line.ends_with("] [INF] x"));
        assert!(line.contains('T') && line.contains("Z]"));
    }

    #[cfg(windows)]
    #[test]
    fn log_dir_uses_userprofile_appdata_local_codemie_logs() {
        assert_eq!(
            log_dir_with(r"C:\Users\alice"),
            r"C:\Users\alice\AppData\Local\CodeMie\Logs"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn log_dir_uses_home_library_logs_codemie() {
        assert_eq!(log_dir_with("/Users/alice"), "/Users/alice/Library/Logs/CodeMie");
    }

    #[test]
    fn ensure_log_readable_errors_for_missing_file() {
        assert!(ensure_log_readable("/definitely/does/not/exist/codemie_wizard.log").is_err());
    }

    #[test]
    fn ensure_log_readable_ok_for_existing_file() {
        let path = std::env::temp_dir().join("codemie_open_log_test.log");
        std::fs::write(&path, "hi").unwrap();
        assert!(ensure_log_readable(path.to_str().unwrap()).is_ok());
        let _ = std::fs::remove_file(&path);
    }
}
