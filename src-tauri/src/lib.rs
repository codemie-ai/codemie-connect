mod ai;
mod commands;
mod error;
mod state;
mod steps;
mod storage;
mod workspace;

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

            // Detect a *working* CodeMie CLI before touching PATH ourselves.
            // File-existence alone is not enough: the old PowerShell shim can be on
            // PATH but broken (exits 1). Only a passing --version counts (EPMCDME-15257).
            let existing_cli_detected =
                commands::handshake::find_working_global_codemie(&pre_injection_path).is_some();

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
                existing_cli_detected,
                ..AppState::default()
            });
            // Register lifecycle plugins only after all process PATH mutations above.
            app.handle().plugin(tauri_plugin_single_instance::init(|app, _, _| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }))?;
            app.handle().plugin(tauri_plugin_notification::init())?;
            app.handle().plugin(tauri_plugin_autostart::Builder::new().build())?;
            // The default folder holds the pointer, sign-in data and the locks; the data itself
            // may live in a user-chosen folder it points at (DESIGN 8).
            let default_root = if cfg!(debug_assertions) {
                std::env::var_os("CODEMIE_WORKSPACE_TEST_DIR").map(std::path::PathBuf::from)
            } else { None }.unwrap_or(app.path().app_data_dir()?.join("workspace"));
            let handle = app.handle().clone();
            let workspace_state = workspace::startup(&default_root, |paths| workspace::Core::open(handle, paths));
            let storage_note = workspace_state.core.is_none().then(|| format!(
                "Workspace not opened: data folder {:?} at {} {}",
                workspace_state.resolved.status,
                workspace_state.resolved.data_root.display(),
                workspace_state.error.as_deref().unwrap_or(""),
            ));
            app.manage(workspace_state);
            workspace::setup_tray(app)?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            commands::logger::write_line("=== CodeMie Installer session started ===", "dim");
            if let Some(note) = storage_note {
                commands::logger::write_line(note.trim_end(), "error");
            }
            if existing_cli_detected {
                commands::logger::write_line(
                    "Existing CodeMie CLI detected on PATH — using it instead of installing the bundled CLI.",
                    "info",
                );
            }
            commands::logger::write_line(&format!("Resolved PATH: {resolved}"), "dim");
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event,tauri::WindowEvent::Moved(_)|tauri::WindowEvent::Resized(_)) {
                if let Some(state)=window.try_state::<workspace::WorkspaceState>(){if let Some(core)=&state.core{workspace::geometry::save(window,&core.paths.private);}}
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.try_state::<workspace::WorkspaceState>() {
                    if let Some(core) = &state.core {
                        if core.installer_busy.load(std::sync::atomic::Ordering::Relaxed) {
                            api.prevent_close(); core.emit("workspace:quit-request");
                        } else if core.repo().ok().and_then(|r| r.settings().ok()).is_some_and(|s| s.background) {
                            api.prevent_close(); let _ = window.hide();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::runner::run_capture,
            commands::runner::run_fresh_env,
            commands::runner::run_stream,
            commands::runtime::runtime_ready,
            commands::runtime::ensure_runtime,
            commands::runtime::update_cli,
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
            workspace::workspace_request,
            workspace::workspace_installer_busy,
            storage::commands::storage_status,
            storage::commands::data_location_use_default,
            storage::commands::app_relaunch,
            storage::commands::data_location_get,
            storage::commands::data_location_check,
            storage::commands::data_location_change,
            storage::commands::data_location_remove_old,
            storage::commands::data_location_reveal,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app,event|{
            if let tauri::RunEvent::ExitRequested{api,..}=event {
                if let Some(state)=app.try_state::<workspace::WorkspaceState>(){if let Some(core)=&state.core{
                    if core.installer_busy.load(std::sync::atomic::Ordering::Relaxed){api.prevent_exit();core.emit("workspace:quit-request");if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}}
                    else{core.stop_background();}
                }}
            }
        });
}
