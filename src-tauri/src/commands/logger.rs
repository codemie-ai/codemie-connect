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

fn log_dir() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    format!("{home}/Library/Logs/CodeMie")
}

pub fn log_path() -> String {
    format!("{}/codemie_wizard.log", log_dir())
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
    std::process::Command::new("open")
        .arg(log_path())
        .spawn()
        .map_err(InstallerError::Io)?;
    Ok(())
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
}
