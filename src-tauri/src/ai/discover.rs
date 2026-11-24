//! Finding the `claude` and `codemie-claude` programs. Pure search over directories;
//! nothing here runs a program.
use std::cmp::Reverse;
use std::path::{Path, PathBuf};

/// A regular file with an execute bit.
#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Windows has no execute bit: an existing `.exe` or `.cmd` file counts.
#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
        && p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "exe" | "cmd"))
}

/// `v22.3.0` -> (22, 3, 0). Anything that is not a version sorts last.
fn nvm_version_key(name: &str) -> Option<(u64, u64, u64)> {
    let mut parts = name.strip_prefix('v')?.split('.');
    let mut next = || parts.next().and_then(|x| x.parse::<u64>().ok());
    Some((next()?, next()?, next()?))
}

/// `~/.nvm/versions/node/*/bin`, newest version first.
fn nvm_bins(home: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) else {
        return Vec::new();
    };
    let mut versions: Vec<((u64, u64, u64), PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let key = nvm_version_key(&e.file_name().to_string_lossy())?;
            Some((key, e.path().join("bin")))
        })
        .collect();
    versions.sort_by_key(|(k, _)| Reverse(*k));
    versions.into_iter().map(|(_, p)| p).collect()
}

/// Look for `name` in the order of DESIGN 6.1: the PATH, `~/.local/bin`,
/// `~/.claude/local`, `~/.npm-global/bin`, `~/.codemie/agents/bin`,
/// `/opt/homebrew/bin`, `/usr/local/bin`, nvm bins (newest first), then `extra`.
pub fn find_program_in(
    name: &str,
    path_var: &str,
    home: &Path,
    extra: &[PathBuf],
) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(path_var)
        .filter(|d| !d.as_os_str().is_empty())
        .collect();
    dirs.extend(
        [
            ".local/bin",
            ".claude/local",
            ".npm-global/bin",
            ".codemie/agents/bin",
        ]
        .iter()
        .map(|d| home.join(d)),
    );
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.extend(nvm_bins(home));
    dirs.extend(extra.iter().cloned());
    if cfg!(windows) {
        // npm's global folder on Windows (`npm i -g` puts `claude.cmd` here).
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    }
    dirs.into_iter()
        .flat_map(|d| program_names(name).into_iter().map(move |n| d.join(n)))
        .find(|p| is_executable(p))
}

/// The file names `name` can be installed under: itself, and on Windows with `.exe` or `.cmd`.
fn program_names(name: &str) -> Vec<String> {
    let mut names = vec![name.to_string()];
    if cfg!(windows) {
        names.extend([format!("{name}.exe"), format!("{name}.cmd")]);
    }
    names
}

/// The user's home folder: `HOME`, or `USERPROFILE` on Windows, where `HOME` is normally unset.
/// Empty when neither is set.
pub fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    PathBuf::from(std::env::var_os(var).unwrap_or_default())
}

/// `find_program_in` with the process PATH and home folder.
#[allow(dead_code)] // used from Task 5
pub fn find_program(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    find_program_in(
        name,
        &std::env::var("PATH").unwrap_or_default(),
        &home_dir(),
        extra,
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn touch(p: &Path, mode: u32) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn find_program_in_extra_dirs_and_newest_nvm() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        touch(&h.join(".nvm/versions/node/v20.1.0/bin/claude"), 0o755);
        touch(&h.join(".nvm/versions/node/v22.3.0/bin/claude"), 0o755);
        touch(&h.join(".nvm/versions/node/v9.0.0/bin/claude"), 0o755);

        // Newest nvm version wins (numerically: v22 beats v9).
        assert_eq!(
            find_program_in("claude", "", h, &[]),
            Some(h.join(".nvm/versions/node/v22.3.0/bin/claude"))
        );

        // A non-executable file is ignored.
        touch(&h.join(".local/bin/claude"), 0o644);
        assert_eq!(
            find_program_in("claude", "", h, &[]),
            Some(h.join(".nvm/versions/node/v22.3.0/bin/claude"))
        );

        // With an empty PATH, ~/.local/bin wins over nvm.
        touch(&h.join(".local/bin/claude"), 0o755);
        assert_eq!(
            find_program_in("claude", "", h, &[]),
            Some(h.join(".local/bin/claude"))
        );

        // PATH comes first.
        let on_path = tempfile::tempdir().unwrap();
        touch(&on_path.path().join("claude"), 0o755);
        assert_eq!(
            find_program_in("claude", on_path.path().to_str().unwrap(), h, &[]),
            Some(on_path.path().join("claude"))
        );

        // `extra` dirs come last.
        let empty_home = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        touch(&extra.path().join("claude"), 0o755);
        assert_eq!(
            find_program_in(
                "claude",
                "",
                empty_home.path(),
                &[extra.path().to_path_buf()]
            ),
            Some(extra.path().join("claude"))
        );
        assert_eq!(find_program_in("claude", "", empty_home.path(), &[]), None);
    }
}
