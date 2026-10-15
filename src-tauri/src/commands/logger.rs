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
    // Use is_file() rather than File::open to avoid a sharing violation on
    // Windows when the CLI still holds an exclusive write lock on the log.
    if std::path::Path::new(path).is_file() {
        Ok(())
    } else {
        Err(InstallerError::Other(format!(
            "log file not found or unreadable: {path}"
        )))
    }
}

#[cfg(not(windows))]
fn spawn_open(path: &str) -> CmdResult<()> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map_err(InstallerError::Io)?;
    Ok(())
}
#[cfg(windows)]
fn spawn_open(path: &str) -> CmdResult<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    // ShellExecuteW bypasses cmd.exe argument parsing entirely (which can
    // silently swallow errors or misparse paths with special characters) and
    // returns an explicit error code rather than fire-and-forget.
    #[link(name = "Shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut std::ffi::c_void,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> isize;
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let op = to_wide("open");
    let file = to_wide(path);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // SW_SHOWNORMAL
        )
    };

    // ShellExecuteW returns > 32 on success; ≤ 32 is an SE_ERR_* code.
    if result > 32 {
        Ok(())
    } else {
        Err(InstallerError::Other(format!(
            "could not open log (ShellExecuteW error {result}): {path}"
        )))
    }
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

/// Pure: the CLI's own debug log for `date`, the file its logger writes:
/// `<CODEMIE_HOME or home/.codemie>/logs/debug-YYYY-MM-DD.log`, dated in UTC
/// the way the CLI dates it (`new Date().toISOString()`).
pub(crate) fn cli_debug_log_path_with(
    codemie_home: Option<&str>,
    home: &str,
    date: &str,
) -> String {
    let base = match codemie_home {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => std::path::Path::new(home)
            .join(".codemie")
            .to_string_lossy()
            .into_owned(),
    };
    std::path::Path::new(&base)
        .join("logs")
        .join(format!("debug-{date}.log"))
        .to_string_lossy()
        .into_owned()
}

/// Health's "Open today's log": the CLI's debug log for today, which is what
/// `codemie doctor` and every other CLI command write to. The app's own
/// codemie_wizard.log is a different, cumulative file.
#[tauri::command]
pub fn open_cli_debug_log() -> CmdResult<()> {
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let codemie_home = std::env::var("CODEMIE_HOME").ok();
    let date = Utc::now().format("%Y-%m-%d").to_string();
    let path = cli_debug_log_path_with(codemie_home.as_deref(), &home, &date);
    ensure_log_readable(&path)?;
    spawn_open(&path)
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

    #[test]
    fn cli_debug_log_is_the_dated_file_under_codemie_logs() {
        use std::path::Path;

        let p = cli_debug_log_path_with(None, "/Users/u", "2026-09-28");
        let expected = Path::new("/Users/u")
            .join(".codemie")
            .join("logs")
            .join("debug-2026-09-28.log");
        assert_eq!(p, expected.to_string_lossy());

        let custom = cli_debug_log_path_with(Some("/opt/cm"), "/Users/u", "2026-09-28");
        let expected_custom = Path::new("/opt/cm")
            .join("logs")
            .join("debug-2026-09-28.log");
        assert_eq!(custom, expected_custom.to_string_lossy());
    }

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
        assert_eq!(
            log_dir_with("/Users/alice"),
            "/Users/alice/Library/Logs/CodeMie"
        );
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
