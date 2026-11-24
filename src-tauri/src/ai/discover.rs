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
/// `~/.claude/local`, `~/.npm-global/bin`, `~/.codemie/agents/bin`, `system_dirs`
/// (the fixed OS dirs: `/opt/homebrew/bin`, `/usr/local/bin`, the Ollama.app
/// Resources dir in production; empty in tests, so a program that happens to be
/// installed there does not leak into a test's "nothing installed" case), nvm
/// bins (newest first), then `extra`.
pub fn find_program_in(
    name: &str,
    path_var: &str,
    home: &Path,
    system_dirs: &[PathBuf],
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
    dirs.extend(system_dirs.iter().cloned());
    dirs.extend(nvm_bins(home));
    dirs.extend(extra.iter().cloned());
    dirs.into_iter()
        .map(|d| d.join(name))
        .find(|p| is_executable(p))
}

/// The fixed OS dirs `find_program_in` searches unconditionally in production:
/// Homebrew, `/usr/local/bin`, and the Ollama.app Resources dir (DESIGN 6.1 plus
/// spec §1's Ollama extra dir). `DetectEnv::system` seeds `system_dirs` with
/// these; a test's `DetectEnv` leaves `system_dirs` empty so a program actually
/// installed there on the developer's own Mac cannot leak into a "nothing
/// installed" assertion.
pub fn system_dirs() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/Applications/Ollama.app/Contents/Resources"),
    ]
}

/// `find_program_in` with the process PATH and HOME, and the real system dirs.
#[allow(dead_code)] // used from Task 5
pub fn find_program(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    find_program_in(
        name,
        &std::env::var("PATH").unwrap_or_default(),
        Path::new(&home),
        &system_dirs(),
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
            find_program_in("claude", "", h, &[], &[]),
            Some(h.join(".nvm/versions/node/v22.3.0/bin/claude"))
        );

        // A non-executable file is ignored.
        touch(&h.join(".local/bin/claude"), 0o644);
        assert_eq!(
            find_program_in("claude", "", h, &[], &[]),
            Some(h.join(".nvm/versions/node/v22.3.0/bin/claude"))
        );

        // With an empty PATH, ~/.local/bin wins over nvm.
        touch(&h.join(".local/bin/claude"), 0o755);
        assert_eq!(
            find_program_in("claude", "", h, &[], &[]),
            Some(h.join(".local/bin/claude"))
        );

        // PATH comes first.
        let on_path = tempfile::tempdir().unwrap();
        touch(&on_path.path().join("claude"), 0o755);
        assert_eq!(
            find_program_in("claude", on_path.path().to_str().unwrap(), h, &[], &[]),
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
                &[],
                &[extra.path().to_path_buf()]
            ),
            Some(extra.path().join("claude"))
        );
        assert_eq!(
            find_program_in("claude", "", empty_home.path(), &[], &[]),
            None
        );
    }

    #[test]
    fn find_program_in_system_dirs_lose_to_home_and_are_empty_by_default_in_tests() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let sys = tempfile::tempdir().unwrap();
        touch(&sys.path().join("claude"), 0o755);

        // A program only in a `system_dirs` entry is found.
        assert_eq!(
            find_program_in("claude", "", h, &[sys.path().to_path_buf()], &[]),
            Some(sys.path().join("claude"))
        );

        // `~/.local/bin` still wins over `system_dirs`.
        touch(&h.join(".local/bin/claude"), 0o755);
        assert_eq!(
            find_program_in("claude", "", h, &[sys.path().to_path_buf()], &[]),
            Some(h.join(".local/bin/claude"))
        );

        // An empty `system_dirs` (the test `DetectEnv`) never finds a program that
        // happens to be installed at a real, fixed OS dir on the developer's Mac.
        let empty_home = tempfile::tempdir().unwrap();
        assert_eq!(
            find_program_in("claude", "", empty_home.path(), &[], &[]),
            None
        );
    }
}
