pub mod commands;

use orca_core::{handle_ping, AppState};
use orca_types::{PingResponse, SystemInfo};
use tauri::{Emitter, Manager};

#[tauri::command]
fn ping() -> PingResponse {
    handle_ping()
}

#[tauri::command]
fn get_system_info(state: tauri::State<AppState>) -> SystemInfo {
    orca_core::get_system_info(&state)
}

pub fn create_app_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(orca_pty::PortablePtyEngine::new())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("app:prepare-close", ());
                let window_clone = window.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
                    let _ = window_clone.destroy();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            get_system_info,
            commands::app::app_get_version,
            commands::app::app_get_name,
            commands::app::get_platform,
            commands::app::app_stage_before_unload,
            commands::app::app_confirm_close_ready,
            commands::window::window_minimize,
            commands::window::window_toggle_maximize,
            commands::window::window_close,
            commands::window::window_is_maximized,
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill
        ])
}

pub fn run() {
    create_app_builder()
        .run(tauri::generate_context!("../../tauri.conf.json"))
        .expect("error while running orca desktop application");
}
