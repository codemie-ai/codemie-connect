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
            let app_dirs = own_dirs.clone();
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

            // Commands run through a login shell, which reads ~/.zprofile again,
            // so the blocks earlier launches wrote must not put the wrong
            // `codemie` first.
            commands::pathman::normalize_persisted_path(existing_cli_detected);

            let bundled_injected = if existing_cli_detected {
                // An earlier launch may have put this app's own bin dir on the
                // login PATH ahead of the user's CLI. Left there, every command
                // would still run the bundled CLI (EPMCDME-15304: an update the
                // user's own 0.15.4 never needed, reported as 0.15.2).
                let path = std::env::var("PATH").unwrap_or_default();
                std::env::set_var("PATH", commands::handshake::without_dirs(&path, &app_dirs));
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

            app.manage(AppState {
                pre_injection_path,
                bundled_injected,
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::runner::run_capture,
            commands::runner::run_fresh_env,
            commands::runner::run_stream,
            commands::pathman::persist_to_zprofile,
            commands::pathman::augment_path,
            commands::inspector::check_git,
            commands::inspector::check_node,
            commands::inspector::check_npm,
            commands::inspector::check_codemie,
            commands::inspector::check_profile_status,
            commands::handshake::check_handshake_state,
            commands::inspector::git_binary_path,
            commands::inspector::node_binary_path,
            commands::codemie_config::read_codemie_config,
            commands::connectors::check_connector_status,
            commands::connectors::app_bundle_exists,
            commands::installer::get_platform_info,
            commands::installer::temp_dir,
            commands::installer::latest_lts_node_version,
            commands::downloader::download_file,
            commands::pty::spawn_pty,
            commands::pty::pty_input,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            #[cfg(windows)]
            commands::pty::spawn_external_ps,
            commands::logger::log_line,
            commands::logger::open_log,
            commands::logger::open_cli_debug_log,
            commands::cmdlog::cmdlog_open,
            commands::cmdlog::cmdlog_append,
            commands::cmdlog::cmdlog_close,
            commands::cmdlog::cmdlog_list,
            commands::cmdlog::cmdlog_get,
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
