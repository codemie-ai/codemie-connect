// Start a coding agent in Terminal, in a folder the person picked, for people
// who never type a `cd`. Every value that reaches the shell is validated here
// first; the folder is single-quoted, the launcher and profile are allowlisted
// shapes.
use crate::error::{CmdResult, InstallerError};
use std::path::Path;

/// `codemie-<agent>`: lower-case letters, digits and dashes only.
fn launcher_ok(launcher: &str) -> bool {
    launcher.strip_prefix("codemie-").is_some_and(|rest| {
        (1..=40).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

/// A CodeMie profile name the shell reads as one word.
fn profile_ok(profile: &str) -> bool {
    let mut bytes = profile.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && profile.len() <= 64
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Check what is about to be launched. The error is a sentence for a person.
pub fn validate_launch(folder: &Path, launcher: &str, profile: &str) -> Result<(), String> {
    if !launcher_ok(launcher) {
        return Err("Connect can’t start that coding agent.".into());
    }
    if !profile_ok(profile) {
        return Err("Rename this profile in Terminal to start agents with it.".into());
    }
    if !folder.is_absolute() || !folder.is_dir() {
        return Err("That folder no longer exists.".into());
    }
    // cmd.exe reads these even inside quotes.
    #[cfg(windows)]
    if folder
        .to_string_lossy()
        .chars()
        .any(|c| matches!(c, '"' | '&' | '|' | '<' | '>' | '^' | '%'))
    {
        return Err("Connect can’t open a folder with that name. Rename it and try again.".into());
    }
    Ok(())
}

/// The `.command` file Terminal runs. It deletes itself first, so a second
/// launch never reads a half-written script.
pub fn command_script(folder: &Path, launcher: &str, profile: &str) -> String {
    let quoted = folder.to_string_lossy().replace('\'', r"'\''");
    format!(
        "#!/bin/zsh -l\nrm -f -- \"$0\"\ncd -- '{quoted}' || exit 1\nexec {launcher} --profile {profile}\n"
    )
}

/// The only pages `open_app_download` can open.
pub fn download_url(app_id: &str) -> Option<&'static str> {
    match app_id {
        "claude-desktop" => Some("https://claude.ai/download"),
        "vscode-copilot" | "vscode-claude" => Some("https://code.visualstudio.com/download"),
        "codex-desktop" => Some("https://openai.com/codex/"),
        _ => None,
    }
}

fn spawn(program: &str, args: &[&str]) -> CmdResult<()> {
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| InstallerError::Other(format!("Connect couldn’t open {program}: {e}")))
}

/// Let the person pick the folder an agent starts in.
#[tauri::command]
pub async fn pick_project_folder(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
) -> Result<Option<String>, String> {
    crate::plugins::caller::require_main_frame(&call).map_err(|e| e.message)?;
    crate::storage::commands::main_window_only(window.label()).map_err(|e| e.message)?;
    let home = {
        use tauri::Manager;
        app.path().home_dir().unwrap_or_default()
    };
    crate::storage::commands::pick_folder(&app, window, home, "Choose a project folder")
        .await
        .map_err(|e| e.message)
}

/// Open Terminal in `folder` and run `<launcher> --profile <profile>` there.
#[tauri::command]
pub fn open_agent_in_terminal(
    app: tauri::AppHandle,
    folder: String,
    launcher: String,
    profile: String,
) -> CmdResult<()> {
    let folder = Path::new(&folder);
    validate_launch(folder, &launcher, &profile).map_err(InstallerError::Other)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        use tauri::Manager;
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| InstallerError::Other(e.to_string()))?;
        std::fs::create_dir_all(&dir)?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let script = dir.join(format!("start-agent-{stamp}.command"));
        std::fs::write(&script, command_script(folder, &launcher, &profile))?;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))?;
        spawn(
            "/usr/bin/open",
            &["-a", "Terminal", &script.to_string_lossy()],
        )
    }
    #[cfg(windows)]
    {
        let _ = app;
        let dir = folder.to_string_lossy();
        spawn(
            "cmd",
            &[
                "/c",
                "start",
                "",
                "/D",
                &dir,
                "cmd",
                "/k",
                &launcher,
                "--profile",
                &profile,
            ],
        )
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = app;
        Err(InstallerError::Other(
            "Opening Terminal is available on macOS and Windows.".into(),
        ))
    }
}

/// Open an app's download page in the default browser. Only allowlisted pages.
#[tauri::command]
pub fn open_app_download(app_id: String) -> CmdResult<()> {
    let url = download_url(&app_id)
        .ok_or_else(|| InstallerError::Other(format!("Unknown app: {app_id}")))?;
    #[cfg(target_os = "macos")]
    {
        spawn("/usr/bin/open", &[url])
    }
    #[cfg(windows)]
    {
        spawn("cmd", &["/c", "start", "", url])
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        spawn("xdg-open", &[url])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_launcher() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_launch(dir.path(), "codemie-claude;rm", "prod").is_err());
        assert!(validate_launch(dir.path(), "claude", "prod").is_err());
        assert!(validate_launch(dir.path(), "codemie-claude", "prod").is_ok());
    }

    #[test]
    fn rejects_bad_profile() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_launch(dir.path(), "codemie-claude", "my profile").is_err());
        assert!(validate_launch(dir.path(), "codemie-claude", "a'b").is_err());
    }

    #[test]
    fn rejects_missing_folder() {
        let err = validate_launch(
            Path::new("/definitely/not/here/cm-1d"),
            "codemie-claude",
            "prod",
        )
        .unwrap_err();
        assert_eq!(err, "That folder no longer exists.");
        assert!(validate_launch(Path::new("relative/dir"), "codemie-claude", "prod").is_err());
    }

    #[test]
    fn script_quotes_folder() {
        let s = command_script(Path::new("/tmp/it's here"), "codemie-claude", "prod");
        assert!(s.contains(r#"cd -- '/tmp/it'\''s here'"#), "{s}");
        assert!(s.starts_with("#!/bin/zsh -l\n"), "{s}");
    }

    #[test]
    fn script_runs_launcher_with_profile() {
        let s = command_script(Path::new("/tmp"), "codemie-claude", "prod");
        assert!(s.contains("exec codemie-claude --profile prod"), "{s}");
    }

    #[test]
    fn download_url_is_allowlisted() {
        assert_eq!(
            download_url("claude-desktop"),
            Some("https://claude.ai/download")
        );
        assert_eq!(
            download_url("vscode-claude"),
            Some("https://code.visualstudio.com/download")
        );
        assert_eq!(download_url("https://evil"), None);
    }
}
