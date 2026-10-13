use orca_core::{handle_ping, AppState};
use orca_types::{PingResponse, SystemInfo};
use tauri::Manager;

#[tauri::command]
fn ping() -> PingResponse {
    handle_ping()
}

#[tauri::command]
fn get_system_info(state: tauri::State<AppState>) -> SystemInfo {
    orca_core::get_system_info(&state)
}

#[tauri::command]
fn get_app_version(state: tauri::State<AppState>) -> String {
    state.app_version.clone()
}

pub fn create_app_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(AppState::default())
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
        .invoke_handler(tauri::generate_handler![
            ping,
            get_system_info,
            get_app_version
        ])
}

pub fn run() {
    create_app_builder()
        .run(tauri::generate_context!("../../tauri.conf.json"))
        .expect("error while running orca desktop application");
}
