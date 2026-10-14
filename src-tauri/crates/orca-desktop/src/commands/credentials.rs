//! OS-native secure credential commands using keyring.

use orca_core::credentials;

#[tauri::command]
pub fn credentials_get(
    service: Option<String>,
    account: String,
) -> Result<Option<String>, String> {
    let s = service.as_deref().unwrap_or(credentials::ORCA_KEYRING_SERVICE_DEFAULT);
    credentials::get_credential(s, &account).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn credentials_set(
    service: Option<String>,
    account: String,
    secret: String,
) -> Result<(), String> {
    let s = service.as_deref().unwrap_or(credentials::ORCA_KEYRING_SERVICE_DEFAULT);
    credentials::set_credential(s, &account, &secret).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn credentials_delete(
    service: Option<String>,
    account: String,
) -> Result<bool, String> {
    let s = service.as_deref().unwrap_or(credentials::ORCA_KEYRING_SERVICE_DEFAULT);
    credentials::delete_credential(s, &account).map_err(|e| e.to_string())
}
