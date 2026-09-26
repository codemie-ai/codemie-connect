mod commands;
mod error;
mod state;
mod steps;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // PATH injection uses set_var and must run before any plugin starts a thread.
            let resolved = commands::pathman::apply_resolved_shell_path();
            // Capture PATH before injection so detection searches the pre-bundle PATH,
            // minus the dirs whose `codemie` the app itself put there: an earlier
            // launch persisted them, and they are not the user's own CLI.
            let mut own_dirs: Vec<std::path::PathBuf> = Vec::new();
            for base in [
                std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())),
                app.path().resource_dir().ok(),
            ]
            .into_iter()
            .flatten()
            {
                own_dirs.push(base.join("bin"));
                own_dirs.push(base);
            }
            let agents_bin = commands::npm_env::npm_env().bin_dir;
            if !agents_bin.is_empty() {
                own_dirs.push(agents_bin.into());
            }
            let pre_injection_path = commands::handshake::without_dirs(
                &std::env::var("PATH").unwrap_or_default(),
                &own_dirs,
            );

            // Detect an existing CodeMie CLI before touching PATH ourselves. If found,
            // the bundle must not be installed or registered at all (EPMCDME-14581).
            let existing_cli_detected =
                commands::handshake::probe_global_codemie(&pre_injection_path, &|p| p.exists());

            let bundled_injected = if existing_cli_detected {
                // The user's CLI is used, but the tools the app installs still
                // go to ~/.codemie/agents, which terminals must be able to find.
                commands::pathman::persist_agents_bin();
                false
            } else {
                let injected = commands::pathman::inject_bundled_bin_path(app.handle()).is_ok();
                if !injected {
                    // eprintln! is swallowed in a packaged GUI; use log::error! so the
                    // message is captured by the log plugin (debug builds) and any
                    // custom log subscriber wired up before this point.
                    log::error!("inject_bundled_bin_path failed");
                }
                injected
            };

            // The bundled runtime and CLI entry live under resource_dir(): node/node.exe
            // on Windows (tauri.windows.conf.json), node/bin/node on macOS
            // (tauri.macos.conf.json). Skipped entirely when an existing CLI takes
            // precedence, so run_self_update updates the PATH-resolved `codemie`
            // shim instead of a bundled binary that was never installed.
            let (node_exe, cli_entry) = if existing_cli_detected {
                (std::path::PathBuf::new(), std::path::PathBuf::new())
            } else {
                app.path()
                    .resource_dir()
                    .map(|res| {
                        let node = if cfg!(windows) {
                            res.join("node").join("node.exe")
                        } else {
                            res.join("node").join("bin").join("node")
                        };
                        let entry = res
                            .join("cli")
                            .join("node_modules")
                            .join("@codemieai")
                            .join("code")
                            .join("bin")
                            .join("codemie.js");
                        (node, entry)
                    })
                    .unwrap_or_else(|e| {
                        log::warn!("resource_dir() failed: {e}; absolute CLI invocation unavailable");
                        (std::path::PathBuf::new(), std::path::PathBuf::new())
                    })
            };

            app.manage(AppState {
                pre_injection_path,
                bundled_injected,
                existing_cli_detected,
                node_exe_path: node_exe,
                cli_entry_path: cli_entry,
                ..AppState::default()
            });
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            commands::logger::write_line("=== CodeMie Installer session started ===", "dim");
            if existing_cli_detected {
                commands::logger::write_line(
                    "Existing CodeMie CLI detected on PATH — using it instead of installing the bundled CLI.",
                    "info",
                );
            }
            commands::logger::write_line(&format!("Resolved PATH: {resolved}"), "dim");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::runner::run_capture,
            commands::runner::run_fresh_env,
            commands::runner::run_stream,
            commands::runner::run_self_update,
            commands::runner::cli_is_bundled,
            commands::pathman::persist_to_zprofile,
            commands::pathman::augment_path,
            commands::inspector::check_git,
            commands::inspector::check_node,
            commands::inspector::check_npm,
            commands::inspector::check_codemie,
            commands::inspector::check_codemie_version,
            commands::inspector::check_profile_status,
            commands::handshake::check_handshake_state,
            commands::inspector::git_binary_path,
            commands::inspector::node_binary_path,
            commands::codemie_config::read_codemie_config,
            commands::installer::get_platform_info,
            commands::installer::temp_dir,
            commands::installer::latest_lts_node_version,
            commands::installer::fetch_codemie_latest,
            commands::downloader::download_file,
            commands::pty::spawn_pty,
            commands::pty::pty_input,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            #[cfg(windows)]
            commands::pty::spawn_external_ps,
            commands::logger::log_line,
            commands::logger::open_log,
            commands::window::set_window_height,
            commands::window::close_app,
            commands::smoke::smoke_mode,
            commands::smoke::smoke_emit,
            steps::get_steps,
            steps::get_logo_path,
            commands::app_updater::check_for_update,
            commands::app_updater::download_and_install,
            commands::app_updater::restart_app,
            commands::app_updater::get_app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
