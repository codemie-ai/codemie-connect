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
    program_candidates(name, path_var, home, system_dirs, extra).next()
}

/// The copy of a CodeMie CLI program (`codemie`, `codemie-claude`) to run: the first one
/// `find_program_in` finds, unless a later one belongs to a newer `@codemieai/code`. An
/// `npm link` to an old checkout first on the PATH then no longer hides the update next to it,
/// and the CodeMie server refuses a CLI older than its minimum (HTTP 426).
pub fn find_codemie_program_in(
    name: &str,
    path_var: &str,
    home: &Path,
    system_dirs: &[PathBuf],
    extra: &[PathBuf],
) -> Option<PathBuf> {
    let mut found = program_candidates(name, path_var, home, system_dirs, extra);
    let first = found.next()?;
    // A first copy of unknown version (the bundled launcher) is not known to be old: it runs.
    let Some(version) = codemie_version(&first) else {
        return Some(first);
    };
    let mut newest = (first, version);
    for p in found {
        if let Some(v) = codemie_version(&p) {
            if v > newest.1 {
                newest = (p, v);
            }
        }
    }
    Some(newest.0)
}

/// The version of the `@codemieai/code` package `program` belongs to, from the package.json
/// above its real file: npm links a global program to `<package>/bin/…`, and `npm link` points
/// that package at a checkout. `None` for anything else, such as a shim.
fn codemie_version(program: &Path) -> Option<(u64, u64, u64)> {
    let real = std::fs::canonicalize(program).ok()?;
    let manifest = real
        .ancestors()
        .skip(1)
        .take(3)
        .map(|d| d.join("package.json"))
        .find(|p| p.is_file())?;
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(manifest).ok()?).ok()?;
    if json["name"] != "@codemieai/code" {
        return None;
    }
    version_key(json["version"].as_str()?)
}

/// `0.17.2` -> (0, 17, 2); `0.18.0-beta.1` -> (0, 18, 0): a prerelease is not told apart.
fn version_key(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.split('.').map(|p| {
        let end = p.find(|c: char| !c.is_ascii_digit()).unwrap_or(p.len());
        p[..end].parse::<u64>().ok()
    });
    let mut next = || parts.next().flatten();
    Some((next()?, next()?, next()?))
}

/// Every executable `name` in the order `find_program_in` searches.
fn program_candidates(
    name: &str,
    path_var: &str,
    home: &Path,
    system_dirs: &[PathBuf],
    extra: &[PathBuf],
) -> impl Iterator<Item = PathBuf> {
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
    if cfg!(windows) {
        // npm's global folder on Windows (`npm i -g` puts `claude.cmd` here).
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    }
    let names = program_names(name);
    dirs.into_iter()
        .flat_map(move |d| {
            let names = names.clone();
            names.into_iter().map(move |n| d.join(n))
        })
        .filter(|p| is_executable(p))
}

/// The file names `name` can be installed under: itself, and on Windows with `.exe` or `.cmd`.
fn program_names(name: &str) -> Vec<String> {
    let mut names = vec![name.to_string()];
    if cfg!(windows) {
        names.extend([format!("{name}.exe"), format!("{name}.cmd")]);
    }
    names
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

/// The user's home folder: `HOME`, or `USERPROFILE` on Windows, where `HOME` is normally unset.
/// Empty when neither is set.
pub fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    PathBuf::from(std::env::var_os(var).unwrap_or_default())
}

/// `find_program_in` with the process PATH and home folder, and the real system dirs.
#[allow(dead_code)] // used from Task 5
pub fn find_program(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    find_program_in(
        name,
        &std::env::var("PATH").unwrap_or_default(),
        &home_dir(),
        &system_dirs(),
        extra,
    )
}

#[cfg(all(test, unix))]
pub(super) mod tests {
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

    /// A CodeMie package at `root` with `version`, and `bin_dir/<name>` linked to its program
    /// the way npm links a global install (or an `npm link` to a checkout).
    pub(in crate::ai) fn codemie_package(root: &Path, version: &str, bin_dir: &Path, name: &str) {
        let program = root.join("bin").join(format!("{name}.js"));
        touch(&program, 0o755);
        std::fs::write(
            root.join("package.json"),
            format!(r#"{{"name":"@codemieai/code","version":"{version}"}}"#),
        )
        .unwrap();
        std::fs::create_dir_all(bin_dir).unwrap();
        std::os::unix::fs::symlink(&program, bin_dir.join(name)).unwrap();
    }

    fn path_of(dirs: &[&Path]) -> String {
        std::env::join_paths(dirs).unwrap().into_string().unwrap()
    }

    #[test]
    fn a_newer_codemie_copy_wins_over_an_older_one_found_first() {
        // An `npm link` to a 0.17.1 checkout comes first on the PATH; the 0.17.2 that
        // `codemie self-update` put in ~/.codemie/agents is the one the server still takes.
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let checkout = tempfile::tempdir().unwrap();
        let npm_bin = tempfile::tempdir().unwrap();
        codemie_package(checkout.path(), "0.17.1", npm_bin.path(), "codemie-claude");
        let agents = h.join(".codemie/agents");
        codemie_package(
            &agents.join("lib/node_modules/@codemieai/code"),
            "0.17.2",
            &agents.join("bin"),
            "codemie-claude",
        );
        let path = path_of(&[npm_bin.path()]);

        assert_eq!(
            find_codemie_program_in("codemie-claude", &path, h, &[], &[]),
            Some(agents.join("bin/codemie-claude"))
        );
        // Other programs still take the first one found.
        assert_eq!(
            find_program_in("codemie-claude", &path, h, &[], &[]),
            Some(npm_bin.path().join("codemie-claude"))
        );
    }

    #[test]
    fn the_first_codemie_copy_stays_unless_another_is_known_newer() {
        let first = |a: &str, b: &str| {
            let (one, two) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
            let (bin1, bin2) = (one.path().join("bin-dir"), two.path().join("bin-dir"));
            codemie_package(&one.path().join("pkg"), a, &bin1, "codemie");
            codemie_package(&two.path().join("pkg"), b, &bin2, "codemie");
            let home = tempfile::tempdir().unwrap();
            let found = find_codemie_program_in(
                "codemie",
                &path_of(&[&bin1, &bin2]),
                home.path(),
                &[],
                &[],
            );
            found == Some(bin1.join("codemie"))
        };
        assert!(
            first("0.17.2", "0.17.2"),
            "the same version keeps the PATH order"
        );
        assert!(
            first("0.18.0", "0.17.2"),
            "a checkout ahead of the release still runs"
        );
        assert!(!first("0.17.9", "0.17.10"), "versions compare as numbers");
        assert!(
            !first("0.17.2", "0.18.0-beta.1"),
            "a prerelease of a later version is newer"
        );
    }

    #[test]
    fn a_codemie_copy_without_a_readable_version_is_not_ranked() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let agents = h.join(".codemie/agents");
        codemie_package(
            &agents.join("lib/node_modules/@codemieai/code"),
            "0.17.2",
            &agents.join("bin"),
            "codemie-claude",
        );

        // A shim with no package around it (the bundled launcher) is not known to be old:
        // it stays first.
        let shim = tempfile::tempdir().unwrap();
        touch(&shim.path().join("codemie-claude"), 0o755);
        assert_eq!(
            find_codemie_program_in("codemie-claude", &path_of(&[shim.path()]), h, &[], &[]),
            Some(shim.path().join("codemie-claude"))
        );

        // A package.json of another package says nothing about CodeMie's version.
        let other = tempfile::tempdir().unwrap();
        let other_bin = other.path().join("bin-dir");
        codemie_package(
            &other.path().join("pkg"),
            "0.10.0",
            &other_bin,
            "codemie-claude",
        );
        std::fs::write(
            other.path().join("pkg/package.json"),
            r#"{"name":"something-else","version":"0.10.0"}"#,
        )
        .unwrap();
        assert_eq!(
            find_codemie_program_in("codemie-claude", &path_of(&[&other_bin]), h, &[], &[]),
            Some(other_bin.join("codemie-claude"))
        );

        // A later copy with no readable version never replaces a known one.
        let known = tempfile::tempdir().unwrap();
        let known_bin = known.path().join("bin-dir");
        codemie_package(&known.path().join("pkg"), "0.17.1", &known_bin, "codemie");
        let later = tempfile::tempdir().unwrap();
        touch(&later.path().join("codemie"), 0o755);
        let empty_home = tempfile::tempdir().unwrap();
        assert_eq!(
            find_codemie_program_in(
                "codemie",
                &path_of(&[&known_bin, later.path()]),
                empty_home.path(),
                &[],
                &[]
            ),
            Some(known_bin.join("codemie"))
        );
    }
}
