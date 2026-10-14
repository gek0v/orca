//! Cross-platform async IPC transport client for orcad.
//!
//! Uses Windows Named Pipes on Windows and Unix Domain Sockets on macOS/Linux.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use super::envelope::{RpcRequest, RpcResponse};

#[derive(Debug, Error)]
pub enum OrcadClientError {
    #[error("I/O error communicating with orcad: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Serialization / JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
    #[error("orcad returned an RPC error: code={0}, message={1}")]
    RpcError(String, String),
    #[error("Connection closed by daemon")]
    ConnectionClosed,
}

#[derive(Clone)]
pub struct OrcadClient {
    endpoint: String,
    next_request_id: Arc<AtomicU64>,
    #[cfg(windows)]
    pipe_stream: Arc<Mutex<Option<BufReader<tokio::net::windows::named_pipe::NamedPipeClient>>>>,
    #[cfg(not(windows))]
    unix_stream: Arc<Mutex<Option<BufReader<tokio::net::UnixStream>>>>,
}

impl OrcadClient {
    /// Creates a new OrcadClient targeting `endpoint`.
    /// On Windows, this is a Named Pipe path (e.g. `\\.\pipe\orcad-ipc`).
    /// On Unix, this is a socket path (e.g. `/tmp/orcad.sock`).
    pub fn new(endpoint: &str) -> Self {
        Self {
            endpoint: endpoint.to_string(),
            next_request_id: Arc::new(AtomicU64::new(1)),
            #[cfg(windows)]
            pipe_stream: Arc::new(Mutex::new(None)),
            #[cfg(not(windows))]
            unix_stream: Arc::new(Mutex::new(None)),
        }
    }

    pub fn default_endpoint() -> String {
        #[cfg(windows)]
        {
            r#"\\.\pipe\orcad-default"#.to_string()
        }
        #[cfg(not(windows))]
        {
            "/tmp/orcad.sock".to_string()
        }
    }

    /// Invokes an RPC method on the daemon and awaits the response.
    pub async fn invoke(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, OrcadClientError> {
        let req_id = self.next_request_id.fetch_add(1, Ordering::Relaxed).to_string();
        let request = RpcRequest {
            id: req_id.clone(),
            method: method.to_string(),
            params,
        };

        let mut line = serde_json::to_string(&request)?;
        line.push('\n');

        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ClientOptions;

            let mut guard = self.pipe_stream.lock().await;
            if guard.is_none() {
                let client = ClientOptions::new().open(&self.endpoint)?;
                *guard = Some(BufReader::new(client));
            }

            if let Some(ref mut reader) = *guard {
                reader.get_mut().write_all(line.as_bytes()).await?;
                reader.get_mut().flush().await?;

                let mut response_line = String::new();
                let bytes_read = reader.read_line(&mut response_line).await?;
                if bytes_read == 0 {
                    return Err(OrcadClientError::ConnectionClosed);
                }

                let parsed: RpcResponse = serde_json::from_str(&response_line)?;
                match parsed {
                    RpcResponse::Success { result, .. } => Ok(result),
                    RpcResponse::Failure { error, .. } => {
                        Err(OrcadClientError::RpcError(error.code, error.message))
                    }
                    RpcResponse::Keepalive { .. } => Ok(serde_json::json!({ "_keepalive": true })),
                }
            } else {
                Err(OrcadClientError::ConnectionClosed)
            }
        }

        #[cfg(not(windows))]
        {
            let mut guard = self.unix_stream.lock().await;
            if guard.is_none() {
                let stream = tokio::net::UnixStream::connect(&self.endpoint).await?;
                *guard = Some(BufReader::new(stream));
            }

            if let Some(ref mut reader) = *guard {
                reader.get_mut().write_all(line.as_bytes()).await?;
                reader.get_mut().flush().await?;

                let mut response_line = String::new();
                let bytes_read = reader.read_line(&mut response_line).await?;
                if bytes_read == 0 {
                    return Err(OrcadClientError::ConnectionClosed);
                }

                let parsed: RpcResponse = serde_json::from_str(&response_line)?;
                match parsed {
                    RpcResponse::Success { result, .. } => Ok(result),
                    RpcResponse::Failure { error, .. } => {
                        Err(OrcadClientError::RpcError(error.code, error.message))
                    }
                    RpcResponse::Keepalive { .. } => Ok(serde_json::json!({ "_keepalive": true })),
                }
            } else {
                Err(OrcadClientError::ConnectionClosed)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_orcad_client_initialization() {
        let endpoint = OrcadClient::default_endpoint();
        assert!(!endpoint.is_empty());

        let client = OrcadClient::new(&endpoint);
        assert_eq!(client.endpoint, endpoint);
    }
}
