//! SQLite persistence and settings commands for Tauri.

use orca_core::PersistenceActor;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub async fn settings_get(
    actor: State<'_, PersistenceActor>,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let settings_list = actor.list_settings().await.map_err(|e| e.to_string())?;
    let mut map = HashMap::new();
    for (k, v) in settings_list {
        let val = serde_json::from_str(&v).unwrap_or(serde_json::Value::String(v));
        map.insert(k, val);
    }
    Ok(map)
}

#[tauri::command]
pub async fn settings_update(
    actor: State<'_, PersistenceActor>,
    patch: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    for (k, v) in patch {
        let serialized = match v {
            serde_json::Value::String(ref s) => s.clone(),
            _ => v.to_string(),
        };
        actor
            .set_setting(&k, &serialized)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sessions_save(
    actor: State<'_, PersistenceActor>,
    sessions: serde_json::Value,
) -> Result<(), String> {
    let serialized = sessions.to_string();
    actor
        .store_session("current_sessions", "active_sessions", &serialized)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sessions_load(
    actor: State<'_, PersistenceActor>,
) -> Result<Option<serde_json::Value>, String> {
    let maybe_data = actor
        .get_session("current_sessions")
        .await
        .map_err(|e| e.to_string())?;
    match maybe_data {
        Some(s) => {
            let val = serde_json::from_str(&s).unwrap_or(serde_json::Value::String(s));
            Ok(Some(val))
        }
        None => Ok(None),
    }
}
