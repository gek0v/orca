use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{debug, error};

use crate::agent_status_store::{AgentStatusStore, AgentVerdict};

pub struct HookServer {
    listener: TcpListener,
    store: Arc<AgentStatusStore>,
    token: String,
    endpoint_path: Option<PathBuf>,
}

impl HookServer {
    pub async fn bind(
        store: Arc<AgentStatusStore>,
        token: String,
        port: u16,
        endpoint_path: Option<PathBuf>,
    ) -> Result<(Self, u16), std::io::Error> {
        let listener = TcpListener::bind(format!("127.0.0.1:{}", port)).await?;
        let bound_port = listener.local_addr()?.port();

        if let Some(ref ep_path) = endpoint_path {
            if let Some(parent) = ep_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let endpoint_data = json!({
                "port": bound_port,
                "token": token,
                "env": "production",
                "version": "1.4.214",
                "openCodeTui": true,
                "transport": "raw-json"
            });
            if let Err(e) = std::fs::write(ep_path, endpoint_data.to_string()) {
                error!("Failed to write endpoint.json: {}", e);
            }
        }

        Ok((
            Self {
                listener,
                store,
                token,
                endpoint_path,
            },
            bound_port,
        ))
    }

    pub async fn run(self) {
        debug!("Native hook server running on loopback");
        loop {
            match self.listener.accept().await {
                Ok((mut stream, _)) => {
                    let store = Arc::clone(&self.store);
                    let token = self.token.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 16384];
                        let mut read_bytes = 0;

                        // Read until we have the full headers
                        let header_end_pos = loop {
                            match stream.read(&mut buf[read_bytes..]).await {
                                Ok(0) => break None,
                                Ok(n) => {
                                    read_bytes += n;
                                    if let Some(pos) =
                                        buf[..read_bytes].windows(4).position(|w| w == b"\r\n\r\n")
                                    {
                                        break Some(pos);
                                    }
                                }
                                Err(_) => return,
                            }
                        };

                        let header_end = match header_end_pos {
                            Some(pos) => pos,
                            None => return,
                        };

                        let header_part = String::from_utf8_lossy(&buf[..header_end]).into_owned();
                        let mut lines = header_part.lines();
                        let request_line = lines.next().unwrap_or_default();
                        let mut parts = request_line.split_whitespace();
                        let method = parts.next().unwrap_or_default();
                        let path = parts.next().unwrap_or_default();

                        let mut headers = HashMap::new();
                        for line in lines {
                            if let Some((k, v)) = line.split_once(':') {
                                headers.insert(k.trim().to_lowercase(), v.trim().to_string());
                            }
                        }

                        let content_len: usize = headers
                            .get("content-length")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0);

                        let body_start = header_end + 4;
                        let required_total = body_start + content_len;

                        while read_bytes < required_total && read_bytes < buf.len() {
                            match stream.read(&mut buf[read_bytes..]).await {
                                Ok(0) => break,
                                Ok(n) => read_bytes += n,
                                Err(_) => return,
                            }
                        }

                        let body_part = if read_bytes >= body_start {
                            String::from_utf8_lossy(
                                &buf[body_start..read_bytes.min(required_total)],
                            )
                        } else {
                            std::borrow::Cow::Borrowed("")
                        };

                        if method != "POST" {
                            let resp =
                                b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n";
                            let _ = stream.write_all(resp).await;
                            return;
                        }

                        let req_token = headers.get("x-orca-agent-hook-token").map(|s| s.as_str());
                        if req_token != Some(&token) {
                            let resp = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
                            let _ = stream.write_all(resp).await;
                            return;
                        }

                        if path == "/opencode/startup-prompt-claim" {
                            let body = b"{\"allowed\":true}";
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(resp.as_bytes()).await;
                            let _ = stream.write_all(body).await;
                            return;
                        }

                        if path.starts_with("/hooks/") {
                            let json_val: Option<Value> = serde_json::from_str(&body_part).ok();
                            if let Some(val) = json_val {
                                let session_id = val
                                    .get("session_id")
                                    .or_else(|| val.get("sessionId"))
                                    .or_else(|| val.get("agent_id"))
                                    .or_else(|| val.get("agentId"))
                                    .or_else(|| val.get("pane_key"))
                                    .or_else(|| val.get("paneKey"))
                                    .or_else(|| val.get("id"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("default");

                                let status_str = val
                                    .get("status")
                                    .or_else(|| val.get("state"))
                                    .or_else(|| val.get("verdict"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("working");

                                let desc = val
                                    .get("text")
                                    .or_else(|| val.get("description"))
                                    .or_else(|| val.get("message"))
                                    .or_else(|| val.get("summary"))
                                    .or_else(|| val.get("prompt"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");

                                let verdict = match status_str.to_lowercase().as_str() {
                                    "done" | "exited" | "exit" | "completed" => {
                                        AgentVerdict::Exited
                                    }
                                    "unverifiable" => AgentVerdict::Unverifiable,
                                    _ => AgentVerdict::Live,
                                };

                                store.update_status(session_id, verdict, desc).await;
                            }

                            let resp = b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
                            let _ = stream.write_all(resp).await;
                            return;
                        }

                        let resp = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                        let _ = stream.write_all(resp).await;
                    });
                }
                Err(err) => {
                    error!("Error accepting hook server connection: {}", err);
                    break;
                }
            }
        }
    }
}

impl Drop for HookServer {
    fn drop(&mut self) {
        if let Some(ref path) = self.endpoint_path {
            let _ = std::fs::remove_file(path);
        }
    }
}
