use orca_types::{PingResponse, SystemInfo};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod process;

pub struct AppState {
    pub app_version: String,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

pub fn handle_ping() -> PingResponse {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    PingResponse {
        message: "pong".to_string(),
        timestamp,
    }
}

pub fn get_system_info(state: &AppState) -> SystemInfo {
    SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: state.app_version.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_handle_ping() {
        let ping = handle_ping();
        assert_eq!(ping.message, "pong");
        assert!(ping.timestamp > 0);
    }

    #[test]
    fn test_get_system_info() {
        let state = AppState::default();
        let info = get_system_info(&state);
        assert!(!info.os.is_empty());
        assert!(!info.arch.is_empty());
        assert_eq!(info.app_version, "1.4.214");
    }
}
