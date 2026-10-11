use orca_protocol::{RpcErrorDetail, RpcKeepalive, RuntimeRpcEnvelope, RuntimeRpcRequest};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, ReadHalf, WriteHalf,
};

#[derive(Error, Debug)]
pub enum ClientError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("RPC error [{code}]: {message}")]
    RpcError {
        code: String,
        message: String,
        data: Option<serde_json::Value>,
    },

    #[error("Connection closed by daemon")]
    ConnectionClosed,

    #[error("Daemon request timed out")]
    Timeout,

    #[error("Daemon unavailable: {0}")]
    DaemonUnavailable(String),
}

impl From<RpcErrorDetail> for ClientError {
    fn from(detail: RpcErrorDetail) -> Self {
        ClientError::RpcError {
            code: detail.code,
            message: detail.message,
            data: detail.data,
        }
    }
}

/// Abstract IPC stream supporting Windows Named Pipes, Unix Sockets, and in-memory duplexes for tests.
pub enum IpcStream {
    #[cfg(windows)]
    NamedPipe(tokio::net::windows::named_pipe::NamedPipeClient),
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
    Memory(tokio::io::DuplexStream),
}

impl AsyncRead for IpcStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match &mut *self {
            #[cfg(windows)]
            IpcStream::NamedPipe(p) => std::pin::Pin::new(p).poll_read(cx, buf),
            #[cfg(unix)]
            IpcStream::Unix(u) => std::pin::Pin::new(u).poll_read(cx, buf),
            IpcStream::Memory(m) => std::pin::Pin::new(m).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for IpcStream {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match &mut *self {
            #[cfg(windows)]
            IpcStream::NamedPipe(p) => std::pin::Pin::new(p).poll_write(cx, buf),
            #[cfg(unix)]
            IpcStream::Unix(u) => std::pin::Pin::new(u).poll_write(cx, buf),
            IpcStream::Memory(m) => std::pin::Pin::new(m).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match &mut *self {
            #[cfg(windows)]
            IpcStream::NamedPipe(p) => std::pin::Pin::new(p).poll_flush(cx),
            #[cfg(unix)]
            IpcStream::Unix(u) => std::pin::Pin::new(u).poll_flush(cx),
            IpcStream::Memory(m) => std::pin::Pin::new(m).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match &mut *self {
            #[cfg(windows)]
            IpcStream::NamedPipe(p) => std::pin::Pin::new(p).poll_shutdown(cx),
            #[cfg(unix)]
            IpcStream::Unix(u) => std::pin::Pin::new(u).poll_shutdown(cx),
            IpcStream::Memory(m) => std::pin::Pin::new(m).poll_shutdown(cx),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTransportMetadata {
    pub kind: String,
    pub endpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetadata {
    pub runtime_id: Option<String>,
    pub pid: Option<u32>,
    pub transports: Option<Vec<RuntimeTransportMetadata>>,
    pub auth_token: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ClientConfig {
    pub pipe: Option<String>,
    pub socket: Option<PathBuf>,
    pub profile: Option<String>,
}

pub struct DaemonClient {
    reader: BufReader<ReadHalf<IpcStream>>,
    writer: WriteHalf<IpcStream>,
    pub auth_token: Option<String>,
    pub runtime_id: Option<String>,
}

impl DaemonClient {
    pub fn from_stream(stream: IpcStream) -> Self {
        let (reader, writer) = tokio::io::split(stream);
        Self {
            reader: BufReader::new(reader),
            writer,
            auth_token: None,
            runtime_id: None,
        }
    }

    pub fn with_auth_and_runtime(
        mut self,
        auth_token: Option<String>,
        runtime_id: Option<String>,
    ) -> Self {
        self.auth_token = auth_token;
        self.runtime_id = runtime_id;
        self
    }

    /// Connects to the orcad daemon, auto-launching in the background if absent.
    pub async fn connect(config: &ClientConfig) -> Result<Self, ClientError> {
        let (pipe_name, socket_path, metadata) = resolve_endpoint(config);

        match try_connect(pipe_name.as_deref(), socket_path.as_deref()).await {
            Ok(stream) => {
                let mut client = Self::from_stream(stream);
                if let Some(meta) = metadata {
                    client = client.with_auth_and_runtime(meta.auth_token, meta.runtime_id);
                }
                Ok(client)
            }
            Err(first_err) => {
                if config.pipe.is_none() && config.socket.is_none() {
                    if let Some(orcad_path) = find_orcad_binary() {
                        if let Ok(_child) = spawn_orcad_daemon(&orcad_path) {
                            for _ in 0..20 {
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                if let Ok(stream) =
                                    try_connect(pipe_name.as_deref(), socket_path.as_deref()).await
                                {
                                    let mut client = Self::from_stream(stream);
                                    if let Some(meta) = metadata {
                                        client = client.with_auth_and_runtime(
                                            meta.auth_token,
                                            meta.runtime_id,
                                        );
                                    }
                                    return Ok(client);
                                }
                            }
                        }
                    }
                }

                Err(ClientError::DaemonUnavailable(format!(
                    "Could not connect to orcad daemon ({first_err}). Ensure orcad is running."
                )))
            }
        }
    }

    /// Sends a JSON-RPC request and returns the deserialized result.
    pub async fn call<T: DeserializeOwned>(
        &mut self,
        method: impl Into<String>,
        params: Option<serde_json::Value>,
    ) -> Result<T, ClientError> {
        let request_id = format!(
            "req_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );

        let req = RuntimeRpcRequest {
            id: request_id.clone(),
            method: method.into(),
            params,
        };

        let mut data = serde_json::to_vec(&req)?;
        data.push(b'\n');

        self.writer.write_all(&data).await?;
        self.writer.flush().await?;

        let mut line = String::new();
        loop {
            line.clear();
            let bytes_read =
                tokio::time::timeout(Duration::from_secs(15), self.reader.read_line(&mut line))
                    .await
                    .map_err(|_| ClientError::Timeout)??;

            if bytes_read == 0 {
                return Err(ClientError::ConnectionClosed);
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if let Ok(keepalive) = serde_json::from_str::<RpcKeepalive>(trimmed) {
                if keepalive._keepalive {
                    continue;
                }
            }

            match serde_json::from_str::<RuntimeRpcEnvelope<T>>(trimmed)? {
                RuntimeRpcEnvelope::Success(success) => {
                    if success.id == request_id {
                        return Ok(success.result);
                    }
                }
                RuntimeRpcEnvelope::Failure(failure) => {
                    if failure.id == request_id {
                        return Err(ClientError::from(failure.error));
                    }
                }
                RuntimeRpcEnvelope::Keepalive(_) => {
                    continue;
                }
            }
        }
    }
}

#[allow(unused_variables)]
async fn try_connect(
    pipe_name: Option<&str>,
    socket_path: Option<&Path>,
) -> std::io::Result<IpcStream> {
    #[cfg(windows)]
    if let Some(pipe) = pipe_name {
        let client = tokio::net::windows::named_pipe::ClientOptions::new().open(pipe)?;
        return Ok(IpcStream::NamedPipe(client));
    }

    #[cfg(unix)]
    if let Some(sock) = socket_path {
        let client = tokio::net::UnixStream::connect(sock).await?;
        return Ok(IpcStream::Unix(client));
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "No matching transport available for current platform",
    ))
}

fn resolve_endpoint(
    config: &ClientConfig,
) -> (Option<String>, Option<PathBuf>, Option<RuntimeMetadata>) {
    if let Some(pipe) = &config.pipe {
        let canonical_pipe = if pipe.starts_with(r"\\.\pipe\") {
            pipe.clone()
        } else {
            format!(r"\\.\pipe\{}", pipe)
        };
        return (Some(canonical_pipe), None, None);
    }

    if let Some(socket) = &config.socket {
        return (None, Some(socket.clone()), None);
    }

    if let Some(meta) = try_read_runtime_metadata(config.profile.as_deref()) {
        if let Some(transports) = &meta.transports {
            #[cfg(windows)]
            if let Some(t) = transports.iter().find(|t| t.kind == "named-pipe") {
                return (Some(t.endpoint.clone()), None, Some(meta));
            }
            #[cfg(unix)]
            if let Some(t) = transports.iter().find(|t| t.kind == "unix") {
                return (None, Some(PathBuf::from(&t.endpoint)), Some(meta));
            }
        }
    }

    #[cfg(windows)]
    return (Some(r"\\.\pipe\orcad".to_string()), None, None);

    #[cfg(unix)]
    return (None, Some(PathBuf::from("/tmp/orcad.sock")), None);
}

fn try_read_runtime_metadata(profile: Option<&str>) -> Option<RuntimeMetadata> {
    let user_data = get_user_data_path(profile)?;
    let metadata_path = user_data.join("orca-runtime.json");
    let content = std::fs::read_to_string(metadata_path).ok()?;
    serde_json::from_str(&content).ok()
}

fn get_user_data_path(profile: Option<&str>) -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("ORCA_USER_DATA_PATH") {
        return Some(PathBuf::from(custom));
    }

    let folder_name = match profile {
        Some(p) => format!("orca-{p}"),
        None => "orca".to_string(),
    };

    #[cfg(windows)]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|appdata| PathBuf::from(appdata).join(folder_name))
    }

    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME").ok().map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(folder_name)
        })
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            return Some(PathBuf::from(xdg).join(folder_name));
        }
        std::env::var("HOME")
            .ok()
            .map(|home| PathBuf::from(home).join(".config").join(folder_name))
    }
}

fn find_orcad_binary() -> Option<PathBuf> {
    #[cfg(windows)]
    let exe_name = "orcad.exe";
    #[cfg(not(windows))]
    let exe_name = "orcad";

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let candidate = parent.join(exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    for dir in &["target/debug", "target/release"] {
        let candidate = PathBuf::from(dir).join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn spawn_orcad_daemon(path: &Path) -> std::io::Result<std::process::Child> {
    let mut cmd = std::process::Command::new(path);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
}

#[cfg(test)]
mod tests {
    use super::*;
    use orca_protocol::MetaSuccess;

    #[tokio::test]
    async fn test_client_call_mock_success() {
        let (server_stream, client_stream) = tokio::io::duplex(4096);
        let mut client = DaemonClient::from_stream(IpcStream::Memory(client_stream));

        tokio::spawn(async move {
            let (reader, mut writer) = tokio::io::split(server_stream);
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();

            let req: RuntimeRpcRequest = serde_json::from_str(line.trim()).unwrap();
            assert_eq!(req.method, "daemon.ping");

            // Send keepalive first
            let keepalive =
                serde_json::to_string(&RpcKeepalive { _keepalive: true }).unwrap() + "\n";
            writer.write_all(keepalive.as_bytes()).await.unwrap();

            // Then send success envelope
            let resp = RuntimeRpcEnvelope::Success(orca_protocol::RpcSuccess {
                id: req.id,
                ok: true,
                result: serde_json::json!({ "pong": true }),
                _meta: MetaSuccess {
                    runtime_id: "rt_test".to_string(),
                    extra: None,
                },
            });
            let resp_bytes = serde_json::to_string(&resp).unwrap() + "\n";
            writer.write_all(resp_bytes.as_bytes()).await.unwrap();
            writer.flush().await.unwrap();
        });

        let res: serde_json::Value = client.call("daemon.ping", None).await.unwrap();
        assert_eq!(res["pong"], true);
    }

    #[tokio::test]
    async fn test_client_call_mock_failure() {
        let (server_stream, client_stream) = tokio::io::duplex(4096);
        let mut client = DaemonClient::from_stream(IpcStream::Memory(client_stream));

        tokio::spawn(async move {
            let (reader, mut writer) = tokio::io::split(server_stream);
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();

            let req: RuntimeRpcRequest = serde_json::from_str(line.trim()).unwrap();

            let resp: RuntimeRpcEnvelope<serde_json::Value> =
                RuntimeRpcEnvelope::Failure(orca_protocol::RpcFailure {
                    id: req.id,
                    ok: false,
                    error: RpcErrorDetail {
                        code: "not_found".to_string(),
                        message: "Item was not found".to_string(),
                        data: None,
                    },
                    _meta: None,
                });
            let resp_bytes = serde_json::to_string(&resp).unwrap() + "\n";
            writer.write_all(resp_bytes.as_bytes()).await.unwrap();
            writer.flush().await.unwrap();
        });

        let err = client
            .call::<serde_json::Value>("unknown.method", None)
            .await
            .unwrap_err();
        match err {
            ClientError::RpcError { code, message, .. } => {
                assert_eq!(code, "not_found");
                assert_eq!(message, "Item was not found");
            }
            other => panic!("Unexpected error: {other:?}"),
        }
    }
}
