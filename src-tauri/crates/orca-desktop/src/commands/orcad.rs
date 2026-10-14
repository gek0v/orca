//! Direct orcad IPC relay commands for Tauri.

use orca_core::OrcadClient;
use tauri::State;

#[tauri::command]
pub async fn orcad_invoke(
    client: State<'_, OrcadClient>,
    method: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let p = params.unwrap_or(serde_json::Value::Null);
    client.invoke(&method, p).await.map_err(|e| e.to_string())
}
