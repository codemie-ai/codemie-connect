//! Echo-compatible plugin host (DESIGN 7). Its first piece is the isolation gate: plugin UIs are
//! served from their own scheme to sandboxed frames (`protocol`), and commands check that their
//! caller is Connect's own page rather than a frame inside it (`caller`). `manifest` and `capabilities` read a package's
//! `echo-plugin.json` and describe what it asks for on the permission sheet. `market` (with
//! `git`), `install` (with `tree`) and `registry` fetch marketplaces and install, update and
//! remove plugins from them; `commands` is Settings' `plugins_request`.
pub mod caller;
pub mod capabilities;
pub mod commands;
pub mod git;
pub mod install;
pub mod manifest;
pub mod market;
pub mod protocol;
pub mod registry;
#[cfg(test)]
mod testkit;
pub mod tree;

/// A plugin id as Echo manifests use it (`github`, `obsidian`): lowercase, so it is also a valid
/// URL host for `connect-plugin://<id>/`.
pub fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && (2..=41).contains(&id.len())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::valid_id;

    #[test]
    fn plugin_ids_are_lowercase_host_names() {
        for ok in ["github", "obsidian", "scheduler", "a1", "isolation-probe"] {
            assert!(valid_id(ok), "{ok}");
        }
        let long = "a".repeat(42);
        for bad in [
            "", "a", "Github", "1abc", "-abc", "__host", "a.b", "a/b", "a_b", "..", &long,
        ] {
            assert!(!valid_id(bad), "{bad}");
        }
    }
}
