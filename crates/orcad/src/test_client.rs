use orca_protocol::rpc_envelope::{RuntimeRpcEnvelope, RuntimeRpcRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};

use crate::agent_status_store::{AgentStatusRow, AgentVerdict};

#[derive(Error, Debug)]
pub enum ClientError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("RPC error: {0}")]
    Rpc(String),
    #[error("Connection closed")]
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingResponse {
    pub ok: bool,
    #[serde(rename = "_keepalive")]
    pub _keepalive: bool,
}

pub struct TestClient {
    #[cfg(windows)]
    reader: BufReader<ReadHalf<tokio::net::windows::named_pipe::NamedPipeClient>>,
    #[cfg(windows)]
    writer: WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>,

    #[cfg(unix)]
    reader: BufReader<ReadHalf<tokio::net::UnixStream>>,
    #[cfg(unix)]
    writer: WriteHalf<tokio::net::UnixStream>,

    req_counter: AtomicU64,
    pub events: std::collections::VecDeque<serde_json::Value>,
}

#[cfg(windows)]
pub async fn connect(endpoint: &str) -> Result<TestClient, ClientError> {
    use tokio::net::windows::named_pipe::ClientOptions;

    // Retry loop in case pipe is busy or opening
    let mut last_err = None;
    for _ in 0..25 {
        match ClientOptions::new().open(endpoint) {
            Ok(client) => {
                let (r, w) = tokio::io::split(client);
                return Ok(TestClient {
                    reader: BufReader::new(r),
                    writer: w,
                    req_counter: AtomicU64::new(1),
                    events: std::collections::VecDeque::new(),
                });
            }
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    Err(ClientError::Io(last_err.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "Failed to connect to named pipe",
        )
    })))
}

#[cfg(unix)]
pub async fn connect(endpoint: &str) -> Result<TestClient, ClientError> {
    let mut last_err = None;
    for _ in 0..25 {
        match tokio::net::UnixStream::connect(endpoint).await {
            Ok(stream) => {
                let (r, w) = tokio::io::split(stream);
                return Ok(TestClient {
                    reader: BufReader::new(r),
                    writer: w,
                    req_counter: AtomicU64::new(1),
                });
            }
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    #[cfg(unix)]
    Err(ClientError::Io(last_err.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "Failed to connect to unix socket",
        )
    })))
}

impl TestClient {
    pub async fn send_raw_request(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, ClientError> {
        let req_id = format!("req-{}", self.req_counter.fetch_add(1, Ordering::SeqCst));
        let request = RuntimeRpcRequest {
            id: req_id.clone(),
            method: method.to_string(),
            auth_token: None,
            params,
        };

        let mut payload = serde_json::to_string(&request)?;
        payload.push('\n');

        self.writer.write_all(payload.as_bytes()).await?;
        self.writer.flush().await?;

        let mut line = String::new();
        loop {
            line.clear();
            let bytes_read = self.reader.read_line(&mut line).await?;
            if bytes_read == 0 {
                return Err(ClientError::Closed);
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                if val.get("type").and_then(|t| t.as_str()) == Some("event") {
                    self.events.push_back(val);
                    continue;
                }
            }

            if let Ok(envelope) = serde_json::from_str::<RuntimeRpcEnvelope<Value>>(trimmed) {
                match envelope {
                    RuntimeRpcEnvelope::Success(s) => {
                        if s.id == req_id {
                            return Ok(s.result);
                        }
                    }
                    RuntimeRpcEnvelope::Failure(f) => {
                        if f.id == req_id {
                            return Err(ClientError::Rpc(f.error.message));
                        }
                    }
                    RuntimeRpcEnvelope::Keepalive(_) => {
                        continue;
                    }
                }
            }
        }
    }

    pub async fn read_next_event(&mut self, timeout: Duration) -> Option<Value> {
        if let Some(ev) = self.events.pop_front() {
            return Some(ev);
        }

        let deadline = tokio::time::Instant::now() + timeout;
        let mut line = String::new();
        while tokio::time::Instant::now() < deadline {
            line.clear();
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, self.reader.read_line(&mut line)).await {
                Ok(Ok(n)) if n > 0 => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                        if val.get("type").and_then(|t| t.as_str()) == Some("event") {
                            return Some(val);
                        }
                    }
                }
                _ => break,
            }
        }
        None
    }

    pub async fn send_ping(&mut self) -> Result<PingResponse, ClientError> {
        let val = self.send_raw_request("ping", None).await?;
        let resp: PingResponse = serde_json::from_value(val)?;
        Ok(resp)
    }

    pub async fn create_terminal(
        &mut self,
        command: Option<&str>,
        args: Option<Vec<String>>,
    ) -> Result<String, ClientError> {
        let val = self
            .send_raw_request(
                "terminal.create",
                Some(json!({
                    "command": command,
                    "args": args,
                })),
            )
            .await?;
        let term_id = val
            .get("terminalId")
            .or_else(|| val.get("id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| ClientError::Rpc("Missing terminalId in response".into()))?;
        Ok(term_id.to_string())
    }

    pub async fn write_terminal_input(
        &mut self,
        terminal_id: &str,
        data: &str,
    ) -> Result<(), ClientError> {
        self.send_raw_request(
            "terminal.input",
            Some(json!({
                "terminalId": terminal_id,
                "data": data,
            })),
        )
        .await?;
        Ok(())
    }

    pub async fn resize_terminal(
        &mut self,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), ClientError> {
        self.send_raw_request(
            "terminal.resize",
            Some(json!({
                "terminalId": terminal_id,
                "cols": cols,
                "rows": rows,
            })),
        )
        .await?;
        Ok(())
    }

    pub async fn kill_terminal(&mut self, terminal_id: &str) -> Result<(), ClientError> {
        self.send_raw_request(
            "terminal.kill",
            Some(json!({
                "terminalId": terminal_id,
            })),
        )
        .await?;
        Ok(())
    }

    pub async fn get_status(
        &mut self,
        session_id: &str,
    ) -> Result<Option<AgentStatusRow>, ClientError> {
        let val = self
            .send_raw_request(
                "status.get",
                Some(json!({
                    "sessionId": session_id,
                })),
            )
            .await?;
        if val.is_null() {
            Ok(None)
        } else {
            let row: AgentStatusRow = serde_json::from_value(val)?;
            Ok(Some(row))
        }
    }

    pub async fn list_status(&mut self) -> Result<Vec<AgentStatusRow>, ClientError> {
        let val = self.send_raw_request("status.list", None).await?;
        let rows: Vec<AgentStatusRow> = serde_json::from_value(val)?;
        Ok(rows)
    }

    pub async fn update_status(
        &mut self,
        session_id: &str,
        verdict: AgentVerdict,
        description: &str,
    ) -> Result<(), ClientError> {
        self.send_raw_request(
            "status.update",
            Some(json!({
                "sessionId": session_id,
                "verdict": verdict,
                "description": description,
            })),
        )
        .await?;
        Ok(())
    }

    pub async fn read_raw_line(&mut self) -> Result<String, ClientError> {
        let mut line = String::new();
        let bytes_read = self.reader.read_line(&mut line).await?;
        if bytes_read == 0 {
            return Err(ClientError::Closed);
        }
        Ok(line.trim().to_string())
    }
}
