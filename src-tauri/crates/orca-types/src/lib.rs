use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PingResponse {
    pub message: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowDimensions {
    pub width: u32,
    pub height: u32,
    pub is_maximized: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ping_response_serialization() {
        let ping = PingResponse {
            message: "pong".to_string(),
            timestamp: 123456789,
        };
        let serialized = serde_json::to_string(&ping).expect("serialize ping");
        let deserialized: PingResponse = serde_json::from_str(&serialized).expect("deserialize ping");
        assert_eq!(ping, deserialized);
    }

    #[test]
    fn test_system_info_serialization() {
        let info = SystemInfo {
            os: "windows".to_string(),
            arch: "x86_64".to_string(),
            app_version: "1.4.214".to_string(),
        };
        let serialized = serde_json::to_string(&info).expect("serialize system info");
        let deserialized: SystemInfo = serde_json::from_str(&serialized).expect("deserialize system info");
        assert_eq!(info, deserialized);
    }
}
