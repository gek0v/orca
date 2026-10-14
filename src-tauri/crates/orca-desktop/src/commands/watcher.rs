//! Filesystem watcher commands for Tauri.

use orca_core::FileWatcherManager;
use std::path::PathBuf;
use tauri::{Emitter, State};

#[tauri::command]
pub fn watcher_watch(
    manager: State<'_, FileWatcherManager>,
    app: tauri::AppHandle,
    watch_id: String,
    path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let id_clone = watch_id.clone();
    manager
        .watch(&watch_id, &target, move |events| {
            let payload = serde_json::json!({
                "watchId": id_clone,
                "events": events,
            });
            let _ = app.emit("fs:change", payload);
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn watcher_unwatch(
    manager: State<'_, FileWatcherManager>,
    watch_id: String,
) -> Result<(), String> {
    manager.unwatch(&watch_id).map_err(|e| e.to_string())
}
