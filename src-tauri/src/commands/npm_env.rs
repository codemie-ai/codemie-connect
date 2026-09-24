// Shared npm environment construction for CLI child processes. Used by
// runner.rs::shell_cmd (covering capture/run_stream/run_fresh_env) and
// pty.rs::spawn_pty so all spawn paths agree on npm_config_prefix and the
// PATH entry that makes globally-installed agents runnable without a
// system npm.
//
// Unix: npm puts global bins in `$prefix/bin`. Windows: npm puts them
// directly in `$prefix` (no `bin` subdir) — reflected below.
#[cfg(not(windows))]
const PATH_SEP: char = ':';
#[cfg(windows)]
const PATH_SEP: char = ';';

pub struct NpmEnv {
    pub prefix: String,
    pub bin_dir: String,
}

impl NpmEnv {
    /// The "no override" value: an empty home dir means we must not point
    /// npm at a root-relative path, so both fields are left empty and every
    /// caller treats an empty prefix/bin_dir as "leave npm's own default
    /// behavior alone".
    fn empty() -> Self {
        NpmEnv {
            prefix: String::new(),
            bin_dir: String::new(),
        }
    }
}

/// Pure: computes the npm prefix/bin_dir for a given home-dir value and
/// platform layout, with no environment reads and no OS-conditional cfg
/// gating. Always compiled on every platform so tests can exercise both the
/// unix and Windows directory shapes from any host.
///
/// An empty `home` (unset/empty HOME or USERPROFILE) returns `NpmEnv::empty()`
/// rather than a root-relative path — see the module-level tests for why.
pub(crate) fn npm_env_for(home: &str, windows: bool) -> NpmEnv {
    if home.is_empty() {
        return NpmEnv::empty();
    }
    if windows {
        let prefix = format!(r"{home}\.codemie\agents");
        let bin_dir = prefix.clone();
        NpmEnv { prefix, bin_dir }
    } else {
        let prefix = format!("{home}/.codemie/agents");
        let bin_dir = format!("{prefix}/bin");
        NpmEnv { prefix, bin_dir }
    }
}

/// Reads the platform's home-dir env var and delegates to `npm_env_for`.
/// This is the only place in this module that touches the process
/// environment.
pub fn npm_env() -> NpmEnv {
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    npm_env_for(&home, cfg!(windows))
}

/// Pure: prepends `bin_dir` to `existing_path` and dedupes. An empty
/// `bin_dir` (the "no override" value from `npm_env_for`) leaves
/// `existing_path` unchanged instead of prefixing an empty entry.
pub(crate) fn prefixed_path_with_bin_dir(bin_dir: &str, existing_path: &str) -> String {
    if bin_dir.is_empty() {
        return crate::commands::pathman::dedupe_path(existing_path);
    }
    let combined = format!("{bin_dir}{PATH_SEP}{existing_path}");
    crate::commands::pathman::dedupe_path(&combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_env_for_unix_uses_home_codemie_agents_with_bin_subdir() {
        let e = npm_env_for("/Users/test", false);
        assert_eq!(e.prefix, "/Users/test/.codemie/agents");
        assert_eq!(e.bin_dir, "/Users/test/.codemie/agents/bin");
    }

    #[test]
    fn npm_env_for_windows_uses_profile_codemie_agents_with_no_bin_subdir() {
        let e = npm_env_for(r"C:\Users\test", true);
        assert_eq!(e.prefix, r"C:\Users\test\.codemie\agents");
        assert_eq!(e.bin_dir, r"C:\Users\test\.codemie\agents");
    }

    #[test]
    fn npm_env_for_empty_home_yields_no_override_on_unix() {
        let e = npm_env_for("", false);
        assert!(e.prefix.is_empty());
        assert!(e.bin_dir.is_empty());
    }

    #[test]
    fn npm_env_for_empty_home_yields_no_override_on_windows() {
        let e = npm_env_for("", true);
        assert!(e.prefix.is_empty());
        assert!(e.bin_dir.is_empty());
    }

    #[test]
    fn prefixed_path_prepends_bin_dir_and_dedupes() {
        // Built with PATH_SEP so the test holds on Windows (`;`) as well.
        let bin = "/Users/test/.codemie/agents/bin";
        let result = prefixed_path_with_bin_dir(bin, &format!("/usr/bin{PATH_SEP}{bin}"));
        assert_eq!(result, format!("{bin}{PATH_SEP}/usr/bin"));
    }

    #[test]
    fn prefixed_path_with_empty_bin_dir_leaves_path_unchanged() {
        let result = prefixed_path_with_bin_dir("", "/usr/bin:/usr/local/bin");
        assert_eq!(result, "/usr/bin:/usr/local/bin");
    }
}
