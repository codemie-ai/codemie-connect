//! What Connect's own window asks for the plugin page on screen, after the user's click there
//! (`plugins_request` `frame_*`, from the main frame only): never a plugin's own call. The window
//! decides which frame is on screen and never takes a plugin id from a frame; Rust checks the
//! plugin's grants again here.
//! - `frame_files {id, paths}`: files dropped on its page become its handles (`files.rs`).
//! - `frame_reveal {id, root, path}`: `ctx.system.reveal`, a file or folder of a folder the user
//!   gave it shown in Finder.
//! - `frame_session {id, folder, path, mode, profile}`: `ctx.claude.session`, Claude Code opened
//!   in Terminal in a folder the user gave it, with read tools (edit tools for `mode: 'edit'`,
//!   which needs `folders.write`), the folder's CLAUDE.md and skills, never its hooks or an MCP
//!   server.
use super::{fs, permission, Services};
use crate::plugins::host::HostError;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The most files one drop hands over.
const MAX_DROPPED: usize = 50;

/// Handles of plugin `id`'s for the files the user dropped on its page.
pub fn hand_files(s: &Services, id: &str, paths: &[String]) -> Result<Value, HostError> {
    s.granted(id)?;
    if paths.len() > MAX_DROPPED {
        return Err(permission(format!(
            "hand a plugin {MAX_DROPPED} files at most"
        )));
    }
    let files: Vec<PathBuf> = paths
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .collect();
    super::files::hand(s, id, files)
}

/// `ctx.system.reveal(root, path)`: shows `path` (the folder itself when empty) of a folder the
/// user gave plugin `id`, in Finder (`open`).
pub fn reveal(
    s: &Services,
    id: &str,
    root: &str,
    rel: &str,
    open: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<Value, HostError> {
    let p = s.granted(id)?;
    let base = fs::root_of(s, &p, root)?;
    let target = if rel.trim_matches('/').is_empty() {
        base
    } else {
        fs::resolve(&base, rel.trim_end_matches('/'))?
    };
    if std::fs::symlink_metadata(&target).is_err() {
        return Err(HostError::new(
            crate::plugins::host::ErrorCode::NotFound,
            format!("“{rel}” isn't there"),
        ));
    }
    open(&target).map_err(|e| super::io_failed("show it in Finder", &e))?;
    Ok(json!({"revealed": true}))
}

/// `ctx.claude.session({folder, path, mode, profile})`: the folder Claude Code opens in and its
/// command line, after the plugin's grants are checked again. `profile` is one of Connect's AI
/// profiles (`claude`, `codemie:<name>`), else the plugins' default.
pub fn session(
    s: &Services,
    id: &str,
    folder: &str,
    path: &str,
    mode: &str,
    profile: &str,
) -> Result<(PathBuf, Vec<String>), HostError> {
    let p = s.granted(id)?;
    p.needs("claude", "ask Claude")?;
    let edit = match mode {
        "" | "read" => false,
        "edit" => true,
        _ => return Err(super::bad("mode: read or edit")),
    };
    let base = if edit {
        fs::writable_root(s, &p, folder)?
    } else {
        fs::root_of(s, &p, folder)?
    };
    let dir = if path.trim_matches('/').is_empty() {
        base.clone()
    } else {
        fs::resolve(&base, path.trim_end_matches('/'))?
    };
    if !dir.is_dir() {
        return Err(super::bad("a session opens in a folder"));
    }
    super::claude::refuse_redirecting(&base)?;
    super::claude::refuse_redirecting(&dir)?;
    let chosen = if profile.is_empty() {
        s.profiles_now()["default"]
            .as_str()
            .unwrap_or(crate::ai::profiles::NATIVE_ID)
            .to_string()
    } else {
        profile.to_string()
    };
    let mut argv = match chosen.strip_prefix("codemie:") {
        Some(name)
            if !name.is_empty()
                && name.len() <= 64
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) =>
        {
            vec![
                "codemie-claude".to_string(),
                "--profile".into(),
                name.into(),
            ]
        }
        None if chosen == crate::ai::profiles::NATIVE_ID => vec!["claude".to_string()],
        _ => return Err(permission(format!("Connect has no AI profile “{chosen}”"))),
    };
    let tools = if edit {
        "Read,Grep,Glob,Skill,Edit,Write"
    } else {
        "Read,Grep,Glob,Skill"
    };
    argv.extend(
        [
            "--tools",
            tools,
            "--setting-sources",
            "user,project",
            "--settings",
            r#"{"disableAllHooks":true}"#,
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
        ]
        .map(String::from),
    );
    Ok((dir, argv))
}

/// Finder, selecting `path`.
pub fn open_in_finder(path: &Path) -> std::io::Result<()> {
    crate::commands::tour::opens_nothing("plugin Finder reveal").map_err(std::io::Error::other)?;
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("Finder didn't open it"))
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use crate::plugins::host::ErrorCode;
    use std::sync::Mutex;

    #[tokio::test]
    async fn reveal_and_dropped_files_keep_to_what_the_plugin_was_given() {
        let env = Env::new();
        env.plugin("vaults", json!({"folders": {}}), json!([]));
        env.plugin("plain", json!({}), json!([]));
        let vault = env.dir.path().join("vault");
        std::fs::create_dir_all(vault.join("notes")).unwrap();
        std::fs::write(vault.join("notes/a.md"), "a").unwrap();
        env.picker.next(&vault);
        let root = env
            .call_async("vaults", "system.pickFolder", json!(["x"]))
            .await
            .unwrap();
        let root = root.as_str().unwrap();
        let shown = Mutex::new(Vec::new());
        let open = |p: &Path| {
            shown.lock().unwrap().push(p.to_path_buf());
            Ok(())
        };
        reveal(&env.services, "vaults", root, "notes/a.md", open).unwrap();
        reveal(&env.services, "vaults", root, "", |p: &Path| {
            shown.lock().unwrap().push(p.to_path_buf());
            Ok(())
        })
        .unwrap();
        let shown = shown.into_inner().unwrap();
        assert_eq!(shown[0], Path::new(root).join("notes/a.md"));
        assert_eq!(shown[1], Path::new(root));
        let never = |_: &Path| -> std::io::Result<()> { panic!("opened") };
        for (id, r, rel) in [
            ("vaults", root, "../outside"),
            ("vaults", "/etc", "hosts"),
            ("plain", root, "notes/a.md"),
        ] {
            assert!(
                reveal(&env.services, id, r, rel, never).is_err(),
                "{id} {r} {rel}"
            );
        }
        let e = reveal(&env.services, "vaults", root, "notes/none.md", never).unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);

        // Dropped files: handles of that plugin's, never their paths; folders and relative paths
        // aren't handed over.
        let f = env.dir.path().join("Brief.md");
        std::fs::write(&f, "brief").unwrap();
        let handed = hand_files(
            &env.services,
            "vaults",
            &[
                f.display().to_string(),
                vault.display().to_string(),
                "x.md".into(),
            ],
        )
        .unwrap();
        assert_eq!(handed.as_array().unwrap().len(), 1);
        assert_eq!(handed[0]["name"], "Brief.md");
        assert!(!handed
            .to_string()
            .contains(env.dir.path().to_str().unwrap()));
        assert!(hand_files(&env.services, "nobody", &[f.display().to_string()]).is_err());
    }

    #[tokio::test]
    async fn a_session_opens_in_a_granted_folder_with_its_tools() {
        let env = Env::new();
        env.plugin("kn", json!({"claude": {}, "folders": {}}), json!([]));
        env.plugin("noclaude", json!({"folders": {}}), json!([]));
        let vault = env.dir.path().join("vault");
        std::fs::create_dir_all(vault.join("notes")).unwrap();
        env.picker.next(&vault);
        let root = env
            .call_async("kn", "system.pickFolder", json!(["x"]))
            .await
            .unwrap();
        let root = root.as_str().unwrap();
        let (dir, argv) = session(&env.services, "kn", root, "", "", "").unwrap();
        assert_eq!(dir, Path::new(root));
        assert_eq!(argv[0], "claude");
        let at = argv.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(argv[at + 1], "Read,Grep,Glob,Skill");
        assert!(argv.iter().any(|a| a == "--strict-mcp-config"));
        let (dir, argv) =
            session(&env.services, "kn", root, "notes", "read", "codemie:prod").unwrap();
        assert_eq!(dir, Path::new(root).join("notes"));
        assert_eq!(argv[..3], ["codemie-claude", "--profile", "prod"]);
        // Edit without folders.write, a profile Connect doesn't have, a folder not given, a
        // plugin without `claude`: refused.
        for (id, folder, mode, profile) in [
            ("kn", root, "edit", ""),
            ("kn", root, "", "codemie:a b"),
            ("kn", root, "", "openai"),
            ("kn", "/etc", "", ""),
            ("noclaude", root, "", ""),
        ] {
            assert!(
                session(&env.services, id, folder, "", mode, profile).is_err(),
                "{id} {mode} {profile}"
            );
        }
    }
}
