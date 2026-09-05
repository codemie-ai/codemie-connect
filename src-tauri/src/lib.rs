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
            // Capture PATH before injection so check_handshake_state can search the
            // pre-bundle PATH for a global codemie binary.
            let pre_injection_path = std::env::var("PATH").unwrap_or_default();
            let bundled_injected = commands::pathman::inject_bundled_bin_path(app.handle()).is_ok();
            if !bundled_injected {
                // eprintln! is swallowed in a packaged GUI; use log::error! so the
                // message is captured by the log plugin (debug builds) and any
                // custom log subscriber wired up before this point.
                log::error!("inject_bundled_bin_path failed");
            }

            // Build AppState with Windows-specific absolute paths for bundled node.exe and CLI.
            // The node\ and cli\ bundle.resources entries live in tauri.windows.conf.json
            // (staged by scripts/stage-runtime.ps1). If resource_dir() fails, both paths
            // stay empty and run_self_update falls back to the codemie.cmd shim on PATH.
            #[cfg(windows)]
            let (node_exe, cli_entry) = app
                .path()
                .resource_dir()
                .map(|res| {
                    (
                        res.join("node").join("node.exe"),
                        res.join("cli")
                            .join("node_modules")
                            .join("@codemieai")
                            .join("code")
                            .join("bin")
                            .join("codemie.js"),
                    )
                })
                .unwrap_or_else(|e| {
                    log::warn!("resource_dir() failed: {e}; absolute CLI invocation unavailable");
                    (std::path::PathBuf::new(), std::path::PathBuf::new())
                });

            app.manage(AppState {
                pre_injection_path,
                bundled_injected,
                #[cfg(windows)]
                node_exe_path: node_exe,
                #[cfg(windows)]
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
            commands::logger::write_line(&format!("Resolved PATH: {resolved}"), "dim");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::runner::run_capture,
            commands::runner::run_fresh_env,
            commands::runner::run_stream,
            commands::runner::run_self_update,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
