mod commands;
mod error;
mod state;
mod steps;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // GUI-launched apps inherit a minimal PATH; resolve the user's real
            // (interactive-login) shell PATH so user-installed CLIs are discoverable.
            let resolved = commands::pathman::apply_resolved_shell_path();
            commands::logger::write_line("=== CodeMie Installer session started ===", "dim");
            commands::logger::write_line(&format!("Resolved PATH: {resolved}"), "dim");
            Ok(())
        })
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
            commands::inspector::git_binary_path,
            commands::inspector::node_binary_path,
            commands::installer::temp_dir,
            commands::installer::node_pkg_url,
            commands::installer::latest_lts_node_version,
            commands::installer::install_node,
            commands::installer::install_git_clt,
            commands::downloader::download_file,
            commands::pty::spawn_pty,
            commands::pty::pty_input,
            commands::pty::pty_resize,
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
