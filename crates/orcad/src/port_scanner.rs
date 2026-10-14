//! Listening TCP port scanner for Orca Relay.
//!
//! Detects listening ports on the local or remote execution host
//! for automatic SSH port forwarding, excluding system SSH (port 22).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedPort {
    pub port: u16,
    pub host: String,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
}

pub struct PortScanner;

impl PortScanner {
    /// Scans active listening ports on the host.
    pub async fn scan_listening_ports() -> Vec<DetectedPort> {
        #[cfg(target_os = "linux")]
        {
            Self::scan_linux().await
        }

        #[cfg(target_os = "windows")]
        {
            Self::scan_windows().await
        }

        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            Self::scan_fallback().await
        }
    }

    #[cfg(target_os = "linux")]
    async fn scan_linux() -> Vec<DetectedPort> {
        let mut results = Vec::new();
        let mut seen = HashSet::new();

        // 0x0A represents TCP_LISTEN in /proc/net/tcp
        let paths = ["/proc/net/tcp", "/proc/net/tcp6"];
        for path in paths {
            if let Ok(content) = tokio::fs::read_to_string(path).await {
                for line in content.lines().skip(1) {
                    let fields: Vec<&str> = line.split_whitespace().collect();
                    if fields.len() >= 4 {
                        let state = fields[3];
                        if state == "0A" {
                            if let Some(port) = Self::parse_hex_port(fields[1]) {
                                if port != 22 && seen.insert(port) {
                                    results.push(DetectedPort {
                                        port,
                                        host: "127.0.0.1".to_string(),
                                        pid: None,
                                        process_name: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        results
    }

    #[cfg(target_os = "windows")]
    async fn scan_windows() -> Vec<DetectedPort> {
        let mut results = Vec::new();
        let mut seen = HashSet::new();

        // On Windows, use `netstat -ano -p tcp` or fallback probe
        if let Ok(output) = tokio::process::Command::new("netstat")
            .args(["-ano", "-p", "tcp"])
            .output()
            .await
        {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 4 && parts[0].eq_ignore_ascii_case("tcp") {
                    let state = parts[parts.len() - 2];
                    if state.eq_ignore_ascii_case("listening")
                        || state.eq_ignore_ascii_case("listen")
                    {
                        let local_addr = parts[1];
                        if let Some(colon) = local_addr.rfind(':') {
                            if let Ok(port) = local_addr[colon + 1..].parse::<u16>() {
                                let pid = parts.last().and_then(|p| p.parse::<u32>().ok());
                                if port != 22 && seen.insert(port) {
                                    results.push(DetectedPort {
                                        port,
                                        host: "127.0.0.1".to_string(),
                                        pid,
                                        process_name: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        results
    }

    #[allow(dead_code)]
    async fn scan_fallback() -> Vec<DetectedPort> {
        Vec::new()
    }

    #[allow(dead_code)]
    fn parse_hex_port(addr_hex: &str) -> Option<u16> {
        if let Some(colon) = addr_hex.find(':') {
            let port_hex = &addr_hex[colon + 1..];
            u16::from_str_radix(port_hex, 16).ok()
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hex_port() {
        assert_eq!(PortScanner::parse_hex_port("0100007F:1F90"), Some(8080));
        assert_eq!(PortScanner::parse_hex_port("00000000:0016"), Some(22));
    }

    #[tokio::test]
    async fn test_scan_listening_ports_smoke() {
        let ports = PortScanner::scan_listening_ports().await;
        // Verify port 22 is excluded if any ports are returned
        for p in ports {
            assert_ne!(p.port, 22, "SSH port 22 must be excluded");
        }
    }
}
