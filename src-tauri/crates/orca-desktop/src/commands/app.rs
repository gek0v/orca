use orca_core::AppState;
use tauri::WebviewWindow;

#[tauri::command]
pub fn app_get_version(state: tauri::State<AppState>) -> String {
    state.app_version.clone()
}

#[tauri::command]
pub fn app_get_name() -> String {
    "Orca".to_string()
}

#[tauri::command]
pub fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
pub fn app_stage_before_unload(args: serde_json::Value) -> Result<(), String> {
    tracing::info!("app_stage_before_unload payload staged: {:?}", args);
    Ok(())
}

#[tauri::command]
pub fn app_confirm_close_ready(window: WebviewWindow) -> Result<(), String> {
    tracing::info!("app_confirm_close_ready received, destroying window");
    window.destroy().map_err(|e| e.to_string())
}
