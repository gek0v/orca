//! PTY and terminal session commands for Tauri.

use orca_pty::{PortablePtyEngine, PtyDimensions, PtySessionDescriptor};
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
pub fn pty_spawn(
    engine: State<PortablePtyEngine>,
    descriptor: PtySessionDescriptor,
    on_event: Channel<Vec<u8>>,
) -> Result<String, String> {
    engine
        .spawn(descriptor, move |frame| {
            let _ = on_event.send(frame);
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_write(
    engine: State<PortablePtyEngine>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    engine.write(&session_id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    engine: State<PortablePtyEngine>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    engine
        .resize(&session_id, PtyDimensions { cols, rows })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(
    engine: State<PortablePtyEngine>,
    session_id: String,
) -> Result<(), String> {
    engine.kill(&session_id).map_err(|e| e.to_string())
}
