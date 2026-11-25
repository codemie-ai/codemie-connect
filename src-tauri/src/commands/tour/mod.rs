//! The real-app tour (`CODEMIE_TOUR`): a debug-only mode in which the app walks its own screens on
//! a seeded test folder and captures its own window. Everything but [`requested`], the [`start`]
//! that refuses it and [`lifecycle_plugins`] is behind the `tour` Cargo feature, which only
//! `make tour` turns on; `lib.rs` refuses to compile that feature without debug assertions.

const TOUR: &str = "CODEMIE_TOUR";

/// Whether this launch asked for the tour. It says nothing about whether the build can run one.
pub fn requested() -> bool {
    std::env::var_os(TOUR).is_some()
}

/// Without the `tour` feature: a debug launch that asks for the tour exits 3, so it never opens the
/// workspace thinking it's on a tour. A release build ignores the variable.
#[cfg(not(feature = "tour"))]
pub fn start() -> Option<()> {
    if cfg!(debug_assertions) && requested() {
        eprintln!("Build the tour with `make tour`.");
        std::process::exit(3);
    }
    None
}

/// The lifecycle plugins `lib.rs` registers, in order. A tour runs beside the user's own Connect,
/// so it never creates or connects to the single-instance socket: neither app hands a launch to
/// the other.
pub fn lifecycle_plugins(tour: bool) -> Vec<&'static str> {
    let all = ["single-instance", "notification", "autostart"];
    all.into_iter()
        .filter(|name| !(tour && *name == "single-instance"))
        .collect()
}

/// Whether a quit request is held back for a running installer operation (the window is then
/// shown and focused to ask). Never during a tour: showing or focusing the tour window activates
/// the app over the user's own, and the tour's quit must always go through.
pub fn quit_blocked(tour: bool, installer_busy: bool) -> bool {
    !tour && installer_busy
}

/// Whether this launch is running a tour. Always false without the `tour` feature.
pub fn running() -> bool {
    #[cfg(feature = "tour")]
    return active().is_some();
    #[cfg(not(feature = "tour"))]
    false
}

/// What every path that would open something on the user's desktop (Finder, Terminal, a
/// browser, a file picker, another app, a relaunch) answers while a tour runs: the tour runs
/// beside the user's own windows and must put nothing on their screen.
pub const OPENS_NOTHING: &str = "The tour opens nothing.";

/// [`OPENS_NOTHING`] while this launch runs a tour; every desktop opener calls it first.
pub fn opens_nothing() -> Result<(), &'static str> {
    open_refused(running())
}

/// The refusal for a launch that is (`tour`) or isn't touring.
pub fn open_refused(tour: bool) -> Result<(), &'static str> {
    if tour {
        Err(OPENS_NOTHING)
    } else {
        Ok(())
    }
}

/// A tray sink that does nothing (design § 3, ruling: no OS tray icon in a tour, Task 2 fix
/// round 1 M6). `setup_tray` is the only place that installs the menu-bar refresher's sink, and a
/// tour never calls it; without a sink installed `Refresher::offer` returns before it ever
/// records an applied view, so `core.menu_bar.last()` would stay `None` forever and `T28` could
/// never pass (design ruling 13, "applied equals recount"). Installing this sink instead lets the
/// refresher keep counting and applying, with nothing ever reaching the real menu bar.
#[cfg(feature = "tour")]
struct QuietTray;

#[cfg(feature = "tour")]
impl crate::workspace::menu_bar::TraySink for QuietTray {
    fn apply(&self, _view: &crate::workspace::menu_bar::TrayView) {}
}

/// Installs [`QuietTray`] and asks for a first count, so the menu bar has an applied view by the
/// time `tour_menu_bar` is asked for one, with no OS tray icon ever built. Takes the `Refresher`
/// directly (rather than a whole `Core`) so it can be unit-tested without opening one.
#[cfg(feature = "tour")]
pub fn install_quiet_menu_bar(menu_bar: &crate::workspace::menu_bar::Refresher) {
    menu_bar.install(Box::new(QuietTray));
    menu_bar.wake();
}

#[cfg(feature = "tour")]
pub use run::*;

/// The tour's quiet AI state: fixed profiles and the answer a stray Claude run would get.
#[cfg(feature = "tour")]
pub mod quiet;

/// Imports the tour's seed into a fresh `workspace.sqlite` before `Core::open_tour` opens it.
#[cfg(feature = "tour")]
pub mod seed;

/// The tour's verdict, `results.json` and the Rust half of the HTML report (design § 8).
#[cfg(feature = "tour")]
pub mod report;

/// The invisible window and the in-process capture of its web content (macOS only).
#[cfg(all(feature = "tour", target_os = "macos"))]
pub mod window;

#[cfg(feature = "tour")]
mod run {
    use super::{requested, TOUR};
    use std::path::{Component, Path, PathBuf};
    use std::sync::OnceLock;

    /// What `CODEMIE_TOUR` asks for: every stop, the stops of some rollout steps, or named stops.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Only {
        All,
        Steps(Vec<u8>),
        Stops(Vec<String>),
    }

    /// This launch's tour, fixed at startup so its results can't be mistaken for another run's.
    #[derive(Debug)]
    pub struct TourRun {
        pub run_id: String,
        pub sha: String,
        pub only: Only,
        pub test_dir: PathBuf,
        pub started_unix: i64,
    }

    /// The environment [`parse`] judges, read once by [`start`].
    pub struct TourEnv {
        pub(super) tour: Option<String>,
        pub(super) sha: Option<String>,
        pub(super) test_dir: Option<String>,
        pub(super) status_smoke: bool,
        pub(super) plugin_smoke: bool,
        pub(super) debug: bool,
        pub(super) home: Option<String>,
        pub(super) cf_home: Option<String>,
    }

    impl TourEnv {
        fn from_env() -> Self {
            TourEnv {
                // Set but not UTF-8 reads as "", which `parse` refuses as an unknown value.
                tour: requested().then(|| std::env::var(TOUR).unwrap_or_default()),
                sha: std::env::var("CODEMIE_TOUR_SHA").ok(),
                test_dir: std::env::var("CODEMIE_WORKSPACE_TEST_DIR").ok(),
                status_smoke: std::env::var_os("CODEMIE_STATUS_SMOKE").is_some(),
                plugin_smoke: std::env::var_os("CODEMIE_PLUGIN_SMOKE").is_some(),
                debug: cfg!(debug_assertions),
                home: std::env::var("HOME").ok(),
                cf_home: std::env::var("CFFIXED_USER_HOME").ok(),
            }
        }
    }

    /// The rollout steps a tour can name.
    const LAST_STEP: u8 = 9;

    fn parse_only(value: &str) -> Option<Only> {
        if value.trim() == "all" {
            return Some(Only::All);
        }
        let items: Vec<&str> = value.split(',').map(str::trim).collect();
        if let Some(steps) = items
            .iter()
            .map(|i| i.parse::<u8>().ok().filter(|s| *s <= LAST_STEP))
            .collect::<Option<Vec<u8>>>()
        {
            return Some(Only::Steps(steps));
        }
        let stop = |i: &&str| {
            i.len() == 3 && i.starts_with('T') && i[1..].bytes().all(|b| b.is_ascii_digit())
        };
        items
            .iter()
            .all(stop)
            .then(|| Only::Stops(items.iter().map(|i| i.to_string()).collect()))
    }

    /// Judges a launch's environment; each refusal is the sentence the tour exits 3 with.
    pub fn parse(env: &TourEnv) -> Result<TourRun, String> {
        // A tour build has test-support compiled in; it never opens the user's own data folder.
        if env.tour.is_none() {
            return Err("This build runs only the tour; start it with `make tour`.".into());
        }
        if !env.debug {
            return Err("CODEMIE_TOUR runs in a debug build made with `make tour`.".into());
        }
        let test_dir = env
            .test_dir
            .as_deref()
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .ok_or("Set CODEMIE_WORKSPACE_TEST_DIR to a fresh folder; the tour never opens your own data.")?;
        // `dirs` reads HOME and AppKit reads CFFIXED_USER_HOME: both must land in the test root
        // (the test folder's parent), or logs and login items go to the user's own ~/Library.
        let root = test_dir.parent().filter(|root| root.parent().is_some());
        let home = env.home.as_deref().map(Path::new).filter(|home| {
            home.is_absolute()
                && env.cf_home.as_deref().map(Path::new) == Some(*home)
                && !home.components().any(|c| c == Component::ParentDir)
                && root.is_some_and(|root| home.starts_with(root) && *home != root)
        });
        if home.is_none() {
            return Err(
                "Set HOME and CFFIXED_USER_HOME to the same absolute folder inside the \
                        tour's test root; the tour never writes to your own home."
                    .into(),
            );
        }
        if env.status_smoke || env.plugin_smoke {
            return Err(
                "Run the tour without CODEMIE_STATUS_SMOKE or CODEMIE_PLUGIN_SMOKE.".into(),
            );
        }
        let sha =
            env.sha.clone().filter(|sha| !sha.trim().is_empty()).ok_or(
                "Set CODEMIE_TOUR_SHA to the commit this build is from; the report names it.",
            )?;
        let value = env.tour.as_deref().unwrap_or_default();
        let only = parse_only(value).ok_or_else(|| {
            format!(
                "CODEMIE_TOUR={value:?} is not `all`, a list of rollout steps (0,3,7) or a list \
                 of stop ids (T05,T21)."
            )
        })?;
        Ok(TourRun {
            run_id: uuid::Uuid::new_v4().to_string(),
            sha,
            only,
            test_dir,
            started_unix: chrono::Utc::now().timestamp(),
        })
    }

    /// The test folder may hold only the seed: `tour-seed.json`, `Meetings/` and `home/`. Anything
    /// else (a database, an earlier run's results or shots) means it isn't fresh.
    pub fn fresh_folder(dir: &Path) -> Result<(), String> {
        let refusal = || format!("That folder isn't a fresh tour seed: {}.", dir.display());
        let entries = std::fs::read_dir(dir).map_err(|_| refusal())?;
        for entry in entries {
            let name = entry.map_err(|_| refusal())?.file_name();
            if !matches!(name.to_str(), Some("tour-seed.json" | "Meetings" | "home")) {
                return Err(refusal());
            }
        }
        Ok(())
    }

    static RUN: OnceLock<TourRun> = OnceLock::new();

    /// Starts the tour before the app is built. A tour build runs nothing else: a launch that
    /// can't run one, `CODEMIE_TOUR` unset included, exits 3 with the reason on stderr.
    pub fn start() -> Option<&'static TourRun> {
        let run = parse(&TourEnv::from_env())
            .and_then(|run| fresh_folder(&run.test_dir).map(|()| run))
            .unwrap_or_else(|refusal| {
                eprintln!("{refusal}");
                std::process::exit(3);
            });
        eprintln!(
            "CODEMIE_TOUR: run {} of {}, {:?}, started {} in {}",
            run.run_id,
            run.sha,
            run.only,
            run.started_unix,
            run.test_dir.display()
        );
        Some(RUN.get_or_init(|| run))
    }

    /// This launch's tour, once started.
    pub fn active() -> Option<&'static TourRun> {
        RUN.get()
    }

    /// The main window is created hidden and can't take focus, so the tour never shows a window
    /// or activates the app; `incognito` keeps WebKit storage in memory, apart from the user's.
    pub fn edit_window_config(w: &mut tauri::utils::config::WindowConfig) {
        w.visible = false;
        w.focus = false;
        w.focusable = false;
        w.skip_taskbar = true;
        w.incognito = true;
    }
}

#[cfg(all(test, feature = "tour"))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ok_env() -> TourEnv {
        TourEnv {
            tour: Some("all".into()),
            sha: Some("abc1234".into()),
            test_dir: Some("/tmp/connect-tour-1/workspace".into()),
            status_smoke: false,
            plugin_smoke: false,
            debug: true,
            home: Some("/tmp/connect-tour-1/home".into()),
            cf_home: Some("/tmp/connect-tour-1/home".into()),
        }
    }

    #[test]
    fn a_tour_build_runs_only_the_tour() {
        let plain = TourEnv {
            tour: None,
            ..ok_env()
        };
        assert_eq!(
            parse(&plain).unwrap_err(),
            "This build runs only the tour; start it with `make tour`."
        );
    }

    #[test]
    fn parse_refuses_a_home_outside_the_test_root() {
        let refusal = "Set HOME and CFFIXED_USER_HOME to the same absolute folder inside the \
                       tour's test root; the tour never writes to your own home.";
        // The launcher's layout (`<run>/home` beside `<run>/workspace`) and `home/` in the test
        // folder are both inside the test root.
        for home in [
            "/tmp/connect-tour-1/home",
            "/tmp/connect-tour-1/workspace/home",
        ] {
            let env = TourEnv {
                home: Some(home.into()),
                cf_home: Some(home.into()),
                ..ok_env()
            };
            assert!(parse(&env).is_ok(), "{home}");
        }
        let cases: [(Option<&str>, Option<&str>); 9] = [
            (None, Some("/tmp/connect-tour-1/home")),
            (Some("/tmp/connect-tour-1/home"), None),
            (Some(""), Some("")),
            (Some("connect-tour-1/home"), Some("connect-tour-1/home")),
            (Some("/Users/someone"), Some("/Users/someone")),
            (Some("/tmp/connect-tour-1"), Some("/tmp/connect-tour-1")),
            (
                Some("/tmp/connect-tour-1/home"),
                Some("/tmp/connect-tour-1/workspace/home"),
            ),
            (
                Some("/tmp/connect-tour-1/../../Users/someone"),
                Some("/tmp/connect-tour-1/../../Users/someone"),
            ),
            (
                Some("/tmp/connect-tour-2/home"),
                Some("/tmp/connect-tour-2/home"),
            ),
        ];
        for (home, cf_home) in cases {
            let env = TourEnv {
                home: home.map(String::from),
                cf_home: cf_home.map(String::from),
                ..ok_env()
            };
            assert_eq!(parse(&env).unwrap_err(), refusal, "{home:?} {cf_home:?}");
        }
        // A test folder at the top of the disk has no test root to hold a home.
        let top = TourEnv {
            test_dir: Some("/workspace".into()),
            home: Some("/home".into()),
            cf_home: Some("/home".into()),
            ..ok_env()
        };
        assert_eq!(parse(&top).unwrap_err(), refusal);
    }

    #[test]
    fn parse_refuses_what_spec_lists() {
        assert!(parse(&ok_env()).is_ok());
        let not_debug = TourEnv {
            debug: false,
            ..ok_env()
        };
        assert_eq!(
            parse(&not_debug).unwrap_err(),
            "CODEMIE_TOUR runs in a debug build made with `make tour`."
        );
        let folder =
            "Set CODEMIE_WORKSPACE_TEST_DIR to a fresh folder; the tour never opens your own data.";
        for dir in [None, Some(""), Some("relative/dir")] {
            let env = TourEnv {
                test_dir: dir.map(String::from),
                ..ok_env()
            };
            assert_eq!(parse(&env).unwrap_err(), folder, "{dir:?}");
        }
        let smokes = "Run the tour without CODEMIE_STATUS_SMOKE or CODEMIE_PLUGIN_SMOKE.";
        let status = TourEnv {
            status_smoke: true,
            ..ok_env()
        };
        assert_eq!(parse(&status).unwrap_err(), smokes);
        let plugin = TourEnv {
            plugin_smoke: true,
            ..ok_env()
        };
        assert_eq!(parse(&plugin).unwrap_err(), smokes);
        for sha in [None, Some("")] {
            let env = TourEnv {
                sha: sha.map(String::from),
                ..ok_env()
            };
            assert!(
                parse(&env).unwrap_err().contains("CODEMIE_TOUR_SHA"),
                "{sha:?}"
            );
        }
        for bad in ["nine", "", "0,,3", "0,T05", "42", "T5x"] {
            let env = TourEnv {
                tour: Some(bad.into()),
                ..ok_env()
            };
            let err = parse(&env).unwrap_err();
            assert!(err.contains(&format!("{bad:?}")), "{bad}: {err}");
        }
    }

    #[test]
    fn parse_reads_all_steps_and_stops() {
        let only = |v: &str| {
            parse(&TourEnv {
                tour: Some(v.into()),
                ..ok_env()
            })
            .unwrap()
            .only
        };
        assert_eq!(only("all"), Only::All);
        assert_eq!(only("0, 3,7"), Only::Steps(vec![0, 3, 7]));
        assert_eq!(
            only("T05,T21"),
            Only::Stops(vec!["T05".into(), "T21".into()])
        );
        let run = parse(&ok_env()).unwrap();
        assert_eq!(run.sha, "abc1234");
        assert_eq!(run.test_dir, PathBuf::from("/tmp/connect-tour-1/workspace"));
        assert!(!run.run_id.is_empty());
        assert!(run.started_unix > 0);
    }

    #[test]
    fn fresh_folder_allows_only_the_seed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(fresh_folder(dir.path()).is_ok());
        std::fs::write(dir.path().join("tour-seed.json"), "{}").unwrap();
        std::fs::create_dir(dir.path().join("Meetings")).unwrap();
        std::fs::create_dir(dir.path().join("home")).unwrap();
        assert!(fresh_folder(dir.path()).is_ok());
        let refusal = format!(
            "That folder isn't a fresh tour seed: {}.",
            dir.path().display()
        );

        std::fs::write(dir.path().join("workspace.sqlite"), "").unwrap();
        assert_eq!(fresh_folder(dir.path()).unwrap_err(), refusal);
        std::fs::remove_file(dir.path().join("workspace.sqlite")).unwrap();

        std::fs::create_dir(dir.path().join("tour")).unwrap();
        std::fs::write(dir.path().join("tour/results.json"), "{}").unwrap();
        assert_eq!(fresh_folder(dir.path()).unwrap_err(), refusal);

        let missing = dir.path().join("missing");
        assert_eq!(
            fresh_folder(&missing).unwrap_err(),
            format!(
                "That folder isn't a fresh tour seed: {}.",
                missing.display()
            )
        );
    }

    #[test]
    fn edit_window_config_hides_and_unfocuses() {
        let mut w = tauri::utils::config::WindowConfig {
            label: "main".into(),
            ..Default::default()
        };
        assert!(w.visible && w.focus && w.focusable);
        edit_window_config(&mut w);
        assert!(!w.visible);
        assert!(!w.focus);
        assert!(!w.focusable);
        assert!(w.skip_taskbar);
        assert!(w.incognito);
        assert_eq!(w.label, "main");
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn tour_never_registers_single_instance() {
        assert_eq!(
            lifecycle_plugins(false),
            ["single-instance", "notification", "autostart"]
        );
        assert!(!lifecycle_plugins(true).contains(&"single-instance"));
        assert_eq!(lifecycle_plugins(true), ["notification", "autostart"]);
    }

    #[test]
    fn a_tour_quit_is_never_blocked() {
        assert!(quit_blocked(false, true));
        assert!(!quit_blocked(false, false));
        assert!(!quit_blocked(true, true));
        assert!(!quit_blocked(true, false));
    }
}

#[cfg(test)]
mod open_tests {
    use super::*;

    #[test]
    fn a_tour_opens_nothing() {
        assert_eq!(open_refused(true), Err("The tour opens nothing."));
        assert_eq!(open_refused(false), Ok(()));
    }

    /// Each low-level function that opens something on the desktop calls `tour::opens_nothing()`
    /// before it does: the window's commands (`data_location_reveal`, `data_location_pick`,
    /// `meetings_root_pick`, `plugins_request` `open_link`/`pick_folder`/`reveal`,
    /// `terminal_open_link`, `open_agent_in_terminal`, `open_app_download`, the folder pickers,
    /// the log viewer, a relaunch, a Microsoft sign-in or a source link) all go through one.
    #[test]
    fn every_desktop_opener_refuses_in_a_tour() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let openers = [
            ("workspace/graph.rs", "pub fn launch_url("),
            ("storage/commands.rs", "pub(crate) async fn pick_folder("),
            ("storage/commands.rs", "pub(crate) fn reveal("),
            ("storage/commands.rs", "async fn relaunch("),
            ("commands/terminal_launch.rs", "fn spawn(program"),
            ("commands/logger.rs", "pub(crate) fn spawn_open("),
            ("plugins/services/window.rs", "pub fn open_in_finder("),
            ("plugins/manager.rs", "fn pick(&self, title: String)"),
            ("plugins/manager.rs", "fn pick_files("),
        ];
        for (file, signature) in openers {
            let text = std::fs::read_to_string(src.join(file)).unwrap();
            let starts: Vec<usize> = text.match_indices(signature).map(|(i, _)| i).collect();
            assert!(!starts.is_empty(), "{file}: no `{signature}`");
            for start in starts {
                // The body ends at the closing brace at the signature's own indent.
                let line = text[..start].rfind('\n').map_or(0, |i| i + 1);
                let indent = &text[line..start];
                let indent = &indent[..indent.len() - indent.trim_start().len()];
                let body = &text[start..];
                let end = body.find(&format!("\n{indent}}}\n")).unwrap_or(body.len());
                assert!(
                    body[..end].contains("tour::opens_nothing()"),
                    "{file}: `{signature}` opens without asking `tour::opens_nothing()` first"
                );
            }
        }
    }
}

#[cfg(all(test, feature = "tour"))]
mod quiet_tray_tests {
    use super::install_quiet_menu_bar;
    use crate::workspace::menu_bar::Refresher;

    /// A fresh `Refresher` has no sink yet; [`install_quiet_menu_bar`] takes the slot. This is a
    /// real RED/GREEN test (review: `has_sink()` can only prove a slot was taken at all, not
    /// that a later sink was ignored — a second test asserting the latter couldn't fail for the
    /// reason it named, so it was dropped rather than kept as a passing no-op).
    #[test]
    fn install_quiet_menu_bar_takes_the_sink_slot() {
        let menu_bar = Refresher::new(|| 0);
        assert!(!menu_bar.has_sink());
        install_quiet_menu_bar(&menu_bar);
        assert!(menu_bar.has_sink());
    }
}
