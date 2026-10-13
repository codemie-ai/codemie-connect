// Profile management through the CLI. `codemie profile delete` prompts for
// confirmation and walks a list when no name is given, so the name is always
// passed, quoted for the shell it runs in, with --yes.
use crate::commands::runner::{capture, CaptureResult};
use crate::error::{CmdResult, InstallerError};

/// Quote `s` as one inert shell argument. cmd.exe cannot make `%`, a newline
/// or NUL inert inside quotes, so Windows rejects those names.
pub fn quote_arg(s: &str, windows: bool) -> Result<String, String> {
    if s.trim().is_empty() {
        return Err("The profile name is empty".into());
    }
    if s.contains('\0') {
        return Err("The profile name contains an unsupported character".into());
    }
    if windows {
        if s.contains(['%', '\n', '\r']) {
            return Err(
                "The profile name contains a character the Windows shell cannot pass safely".into(),
            );
        }
        Ok(format!("\"{}\"", s.replace('"', "\"\"")))
    } else {
        Ok(format!("'{}'", s.replace('\'', "'\\''")))
    }
}

/// Join already-quoted `args` into a `codemie` call run from the filesystem
/// root, where the CLI reads no stray project config.
pub fn codemie_in_root(args: &[&str], windows: bool) -> Result<String, String> {
    if args.is_empty() {
        return Err("No codemie arguments".into());
    }
    let args = args.join(" ");
    Ok(if windows {
        format!("cd /d %SystemDrive%\\ && codemie {args}")
    } else {
        format!("cd / && codemie {args} < /dev/null")
    })
}

fn delete_command(name: &str, windows: bool) -> Result<String, String> {
    let quoted = quote_arg(name, windows)?;
    codemie_in_root(&["profile", "delete", &quoted, "--yes"], windows)
}

fn switch_command(name: &str, windows: bool) -> Result<String, String> {
    let quoted = quote_arg(name, windows)?;
    codemie_in_root(&["profile", "switch", &quoted], windows)
}

fn rename_command(old: &str, new: &str, windows: bool) -> Result<String, String> {
    let old = quote_arg(old, windows)?;
    let new = quote_arg(new, windows)?;
    codemie_in_root(&["profile", "rename", &old, &new], windows)
}

#[tauri::command]
pub async fn switch_profile(name: String) -> CmdResult<CaptureResult> {
    let cmd = switch_command(&name, cfg!(windows)).map_err(InstallerError::Other)?;
    Ok(capture(&cmd, None).await)
}

#[tauri::command]
pub async fn rename_profile(old: String, new: String) -> CmdResult<CaptureResult> {
    let cmd = rename_command(&old, &new, cfg!(windows)).map_err(InstallerError::Other)?;
    Ok(capture(&cmd, None).await)
}

#[tauri::command]
pub async fn delete_profile(name: String) -> CmdResult<CaptureResult> {
    let cmd = delete_command(&name, cfg!(windows)).map_err(InstallerError::Other)?;
    Ok(capture(&cmd, None).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_quotes_in_single_quotes() {
        assert_eq!(quote_arg("demo7", false).unwrap(), "'demo7'");
        assert_eq!(quote_arg("my profile", false).unwrap(), "'my profile'");
        assert_eq!(quote_arg("$HOME", false).unwrap(), "'$HOME'");
        assert_eq!(quote_arg("a;b", false).unwrap(), "'a;b'");
        assert_eq!(quote_arg("a`b", false).unwrap(), "'a`b'");
        assert_eq!(quote_arg("a\"b", false).unwrap(), "'a\"b'");
    }

    #[test]
    fn posix_escapes_a_single_quote() {
        assert_eq!(quote_arg("it's", false).unwrap(), "'it'\\''s'");
    }

    #[test]
    fn windows_quotes_in_double_quotes_and_doubles_inner_ones() {
        assert_eq!(quote_arg("demo7", true).unwrap(), "\"demo7\"");
        assert_eq!(quote_arg("my profile", true).unwrap(), "\"my profile\"");
        assert_eq!(quote_arg("a\"b", true).unwrap(), "\"a\"\"b\"");
        assert_eq!(quote_arg("a;b$HOME'", true).unwrap(), "\"a;b$HOME'\"");
    }

    #[test]
    fn windows_rejects_what_cmd_cannot_make_inert() {
        assert!(quote_arg("50%", true).is_err());
        assert!(quote_arg("a\nb", true).is_err());
        assert!(quote_arg("a\0b", true).is_err());
    }

    #[test]
    fn empty_or_blank_names_are_rejected() {
        for windows in [false, true] {
            assert!(quote_arg("", windows).is_err());
            assert!(quote_arg("   ", windows).is_err());
        }
    }

    #[test]
    fn builds_the_delete_command_per_platform() {
        assert_eq!(
            delete_command("demo7", false).unwrap(),
            "cd / && codemie profile delete 'demo7' --yes < /dev/null"
        );
        assert_eq!(
            delete_command("demo7", true).unwrap(),
            "cd /d %SystemDrive%\\ && codemie profile delete \"demo7\" --yes"
        );
        assert!(delete_command("", false).is_err());
    }

    #[test]
    fn builds_the_switch_and_rename_commands_per_platform() {
        assert_eq!(
            switch_command("demo7", false).unwrap(),
            "cd / && codemie profile switch 'demo7' < /dev/null"
        );
        assert_eq!(
            switch_command("demo7", true).unwrap(),
            "cd /d %SystemDrive%\\ && codemie profile switch \"demo7\""
        );
        assert_eq!(
            rename_command("old", "new", false).unwrap(),
            "cd / && codemie profile rename 'old' 'new' < /dev/null"
        );
        assert_eq!(
            rename_command("old", "new", true).unwrap(),
            "cd /d %SystemDrive%\\ && codemie profile rename \"old\" \"new\""
        );
        assert_eq!(
            rename_command("old", "a b; rm 'x'", false).unwrap(),
            "cd / && codemie profile rename 'old' 'a b; rm '\\''x'\\''' < /dev/null"
        );
        assert!(switch_command("", false).is_err());
        assert!(rename_command("old", " ", false).is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn a_hostile_name_stays_one_inert_argument_in_zsh() {
        let dir = std::env::temp_dir().join(format!("profile-quote-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = format!(
            "x'; touch {}/pwned; echo '$(touch {}/pwned2)",
            dir.display(),
            dir.display()
        );
        let quoted = quote_arg(&name, false).unwrap();
        let out = std::process::Command::new("/bin/zsh")
            .arg("-c")
            .arg(format!("printf %s {quoted}"))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), name);
        assert!(!dir.join("pwned").exists());
        assert!(!dir.join("pwned2").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
