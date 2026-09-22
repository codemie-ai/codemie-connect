// Shared npm environment construction for CLI child processes. Used by
// runner.rs::shell_cmd (covering capture/run_stream/run_fresh_env) and
// pty.rs::spawn_pty so all spawn paths agree on npm_config_prefix and the
// PATH entry that makes globally-installed agents runnable without a
// system npm.
//
// Unix: npm puts global bins in `$prefix/bin`. Windows: npm puts them
// directly in `$prefix` (no `bin` subdir) — reflected below, not asserted
// by any test on this platform.
#[cfg(not(windows))]
const PATH_SEP: char = ':';
#[cfg(windows)]
const PATH_SEP: char = ';';

pub struct NpmEnv {
    pub prefix: String,
    pub bin_dir: String,
}

#[cfg(not(windows))]
pub fn npm_env() -> NpmEnv {
    let home = std::env::var("HOME").unwrap_or_default();
    let prefix = format!("{home}/.codemie/agents");
    let bin_dir = format!("{prefix}/bin");
    NpmEnv { prefix, bin_dir }
}

#[cfg(windows)]
pub fn npm_env() -> NpmEnv {
    let profile = std::env::var("USERPROFILE").unwrap_or_default();
    let prefix = format!(r"{profile}\.codemie\agents");
    let bin_dir = prefix.clone();
    NpmEnv { prefix, bin_dir }
}

pub fn prefixed_path(existing_path: &str) -> String {
    let env = npm_env();
    let combined = format!("{}{PATH_SEP}{existing_path}", env.bin_dir);
    crate::commands::pathman::dedupe_path(&combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn npm_env_uses_home_codemie_agents_with_bin_subdir() {
        std::env::set_var("HOME", "/Users/test");
        let e = npm_env();
        assert_eq!(e.prefix, "/Users/test/.codemie/agents");
        assert_eq!(e.bin_dir, "/Users/test/.codemie/agents/bin");
    }

    #[cfg(not(windows))]
    #[test]
    fn prefixed_path_prepends_bin_dir_and_dedupes() {
        std::env::set_var("HOME", "/Users/test");
        let result = prefixed_path("/usr/bin:/Users/test/.codemie/agents/bin");
        assert_eq!(result, "/Users/test/.codemie/agents/bin:/usr/bin");
    }
}
