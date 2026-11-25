mod ai;
mod commands;
mod error;
mod navigation;
// Public for the integration tests only. Whatever serves a plugin's files must check containment
// again at serve time (`plugins::protocol` does); parsing a manifest is not that check.
#[doc(hidden)]
pub mod plugins;
mod state;
mod steps;
mod storage;
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub mod testing;
mod workspace;

use state::AppState;
use tauri::Manager;

// The real-app tour (`commands::tour`) never reaches a release build.
#[cfg(all(feature = "tour", not(debug_assertions)))]
compile_error!("the tour runs in debug builds only");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything opens: a tour launch that can't run exits 3 here.
    let tour = commands::tour::start().is_some();
    #[cfg_attr(not(feature = "tour"), allow(unused_mut))]
    let mut context = tauri::generate_context!();
    #[cfg(feature = "tour")]
    if tour {
        commands::tour::edit_window_config(&mut context.config_mut().app.windows[0]);
    }
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    {
        // tao activates the app at launch otherwise, taking focus from whatever the user is in.
        builder = builder.activate_ignoring_other_apps(!tour);
    }
    builder
        // Every webview stays on Connect's own pages; links open in the browser instead.
        .plugin(navigation::guard())
        // Plugin UIs, served to sandboxed frames only (DESIGN 7.3).
        .register_asynchronous_uri_scheme_protocol(
            plugins::protocol::SCHEME,
            plugins::protocol::handle,
        )
        .setup(move |app| {
            // A tour has no Dock icon or app menu and never becomes the active app.
            #[cfg(target_os = "macos")]
            if tour {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            plugins::caller::trust_dev_server(app.config());
            // Before single-instance, which would hand a smoke launch to a running Connect.
            commands::smoke::start_plugin_smoke(
                &app.config().identifier,
                &app.package_info().version.to_string(),
            );
            commands::status_smoke::start(
                &app.config().identifier,
                &app.package_info().version.to_string(),
            );
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
            // Connect's terminal dock: the Claude Code sessions it runs (commands::terminal).
            app.manage(commands::terminal::Terminals::default());
            // Register lifecycle plugins only after all process PATH mutations above. A tour skips
            // single-instance, so it runs beside the user's Connect without touching its socket.
            for name in commands::tour::lifecycle_plugins(tour) {
                match name {
                    "single-instance" => {
                        app.handle().plugin(tauri_plugin_single_instance::init(|app, _, _| {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }))?
                    }
                    "notification" => app.handle().plugin(tauri_plugin_notification::init())?,
                    "autostart" => app
                        .handle()
                        .plugin(tauri_plugin_autostart::Builder::new().build())?,
                    other => unreachable!("unknown lifecycle plugin {other}"),
                }
            }
            // The default folder holds the pointer, sign-in data and the locks; the data itself
            // may live in a user-chosen folder it points at (DESIGN 8).
            // A plugin marketplace smoke opens its own fresh data root, never the user's.
            let default_root = if let Some(root) = commands::plugin_smoke::data_root() {
                Some(root.to_path_buf())
            } else if cfg!(debug_assertions) {
                std::env::var_os("CODEMIE_WORKSPACE_TEST_DIR").map(std::path::PathBuf::from)
            } else { None }.unwrap_or(app.path().app_data_dir()?.join("workspace"));
            // The seed goes into a fresh `workspace.sqlite` under `default_root` before anything
            // opens it (design § 4): a refused import (a path outside the test folder, a
            // secret) exits 3 naming it, exactly as every other tour refusal does.
            #[cfg(feature = "tour")]
            let tour_tasks = if tour {
                match commands::tour::seed::import(&default_root) {
                    Ok((counts, provider)) => {
                        eprintln!(
                            "CODEMIE_TOUR: seed imported, {} records, {} connections",
                            counts.records, counts.connections
                        );
                        Some(provider)
                    }
                    Err(e) => {
                        eprintln!("{}", e.message);
                        std::process::exit(3);
                    }
                }
            } else {
                None
            };
            commands::plugin_smoke::arm_watchdog(app.handle());
            let handle = app.handle().clone();
            let terminals = app.state::<commands::terminal::Terminals>().inner().clone();
            let workspace_state = workspace::startup(&default_root, |paths| {
                // Analytics reads where the dock started its sessions; the private root stays put
                // when the data folder moves.
                terminals.set_launch_log(paths.private.join("terminal-launches.jsonl"));
                // A quiet Core for the tour (design § 2): the test fakes for Claude, Microsoft
                // and analytics, and the seed's fixed AI profiles.
                #[cfg(feature = "tour")]
                if tour {
                    return workspace::Core::open_tour(handle, paths, commands::tour::quiet::profiles());
                }
                workspace::Core::open(handle, paths)
            });
            let core = workspace_state.core.clone();
            let storage_note = workspace_state.core.is_none().then(|| format!(
                "Workspace not opened: data folder {:?} at {} {}",
                workspace_state.resolved.status,
                workspace_state.resolved.data_root.display(),
                workspace_state.error.as_deref().unwrap_or(""),
            ));
            app.manage(workspace_state);
            // Plugins start after Core, with the data folder it opened (DESIGN 7.2).
            if let Some(core) = &core {
                #[cfg(feature = "tour")]
                if tour {
                    // Seeded before the plugin manager starts, so its own `set_task_providers`
                    // finds one set already and does nothing (design § 2). The seed's own
                    // provider state (Task 3): `tour_tasks` is set whenever `tour` is true.
                    let tasks = tour_tasks.expect("the seed was imported for this tour");
                    core.set_task_providers(tasks);
                    app.manage(plugins::manager::PluginManager::start_with_http(
                        app.handle(),
                        core,
                        plugins::services::http::Client::offline().0,
                    ));
                } else {
                    app.manage(plugins::manager::PluginManager::start(app.handle(), core));
                }
                #[cfg(not(feature = "tour"))]
                app.manage(plugins::manager::PluginManager::start(app.handle(), core));
            }
            commands::status_smoke::arm(app.handle());
            // No icon in the menu bar while touring (design § 3): the tray is never built in the
            // first place, rather than built and then hidden, so it never shows even briefly
            // (controller ruling, Task 2 fix round 1, M6).
            #[cfg(feature = "tour")]
            if !tour {
                workspace::setup_tray(app)?;
            }
            #[cfg(not(feature = "tour"))]
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
            // Out of sight once set up (design § 3): transparent, click-through, behind every
            // window on the main screen, never key, main or active.
            #[cfg(all(feature = "tour", target_os = "macos"))]
            if tour {
                if let Some(window) = app.get_webview_window("main") {
                    commands::tour::window::hide_window(&window);
                }
            }
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
        // No app command runs while the window shows anything but Connect's own page.
        .invoke_handler(plugins::caller::app_page_only(tauri::generate_handler![
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
            commands::codemie_config::read_codemie_profiles,
            commands::codemie_server::codemie_url_check,
            commands::codemie_server::codemie_org_defaults,
            commands::codemie_apps::codemie_app_states,
            commands::terminal_launch::pick_project_folder,
            commands::terminal_launch::open_agent_in_terminal,
            commands::terminal_launch::open_app_download,
            commands::terminal::terminal_list,
            commands::terminal::terminal_input,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_restart,
            commands::terminal::terminal_close,
            commands::terminal::terminal_move_out,
            commands::terminal::terminal_open_agent,
            commands::terminal::terminal_open_link,
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
            commands::smoke::smoke_plugin_report,
            commands::plugin_smoke::smoke_plugins_state,
            commands::plugin_smoke::smoke_plugins_report,
            commands::status_smoke::smoke_status_facts,
            commands::status_smoke::smoke_status_discard,
            commands::status_smoke::smoke_status_report,
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
            storage::commands::data_location_pick,
            storage::commands::meetings_root_pick,
            plugins::commands::plugins_request,
            plugins::commands::plugin_call,
            #[cfg(all(feature = "tour", target_os = "macos"))]
            commands::tour::window::tour_window,
            #[cfg(all(feature = "tour", target_os = "macos"))]
            commands::tour::window::tour_capture,
            #[cfg(all(feature = "tour", target_os = "macos"))]
            commands::tour::window::tour_focus,
        ]))
        .build(context)
        .expect("error while building tauri application")
        .run(move |app,event|{
            // Quitting ends the dock's sessions, as closing Terminal.app does.
            if matches!(event,tauri::RunEvent::Exit) {
                if let Some(t)=app.try_state::<commands::terminal::Terminals>(){t.close_all();}
            }
            if let tauri::RunEvent::ExitRequested{api,..}=event {
                if let Some(state)=app.try_state::<workspace::WorkspaceState>(){if let Some(core)=&state.core{
                    // A tour's quit is never held back, and its window is never shown or focused.
                    if commands::tour::quit_blocked(tour, core.installer_busy.load(std::sync::atomic::Ordering::Relaxed)){api.prevent_exit();core.emit("workspace:quit-request");if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}}
                    else{core.stop_background();}
                }}
            }
        });
}
