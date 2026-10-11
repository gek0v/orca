use std::sync::Arc;
use tokio::sync::broadcast;

use crate::idle_exit::IdleExitManager;
use crate::server::RpcDispatcher;

#[cfg(windows)]
use tokio::net::windows::named_pipe::ServerOptions;

#[cfg(windows)]
pub async fn listen_named_pipe(
    pipe_name: String,
    mut shutdown_rx: broadcast::Receiver<()>,
    dispatcher: Arc<RpcDispatcher>,
    idle_exit: Arc<IdleExitManager>,
) -> Result<(), std::io::Error> {
    let mut server = match ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
    {
        Ok(s) => s,
        Err(_) => ServerOptions::new()
            .first_pipe_instance(false)
            .create(&pipe_name)?,
    };

    loop {
        tokio::select! {
            res = server.connect() => {
                match res {
                    Ok(()) => {
                        let connected_client = server;
                        match ServerOptions::new().first_pipe_instance(false).create(&pipe_name) {
                            Ok(next) => {
                                server = next;
                            }
                            Err(e) => {
                                tracing::error!("Failed to create next named pipe instance: {:?}", e);
                                break;
                            }
                        }

                        let d = Arc::clone(&dispatcher);
                        let ie = Arc::clone(&idle_exit);
                        tokio::spawn(async move {
                            ie.connection_opened().await;
                            handle_connection(connected_client, d).await;
                            ie.connection_closed().await;
                        });
                    }
                    Err(e) => {
                        tracing::error!("Named pipe connect error: {:?}", e);
                        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
                    }
                }
            }
            _ = shutdown_rx.recv() => {
                tracing::info!("Named pipe listener received shutdown signal");
                break;
            }
        }
    }

    Ok(())
}

#[cfg(unix)]
pub async fn listen_unix_socket(
    socket_path: String,
    mut shutdown_rx: broadcast::Receiver<()>,
    dispatcher: Arc<RpcDispatcher>,
    idle_exit: Arc<IdleExitManager>,
) -> Result<(), std::io::Error> {
    let path = std::path::Path::new(&socket_path);
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let listener = tokio::net::UnixListener::bind(path)?;
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));

    loop {
        tokio::select! {
            res = listener.accept() => {
                match res {
                    Ok((stream, _)) => {
                        let d = Arc::clone(&dispatcher);
                        let ie = Arc::clone(&idle_exit);
                        tokio::spawn(async move {
                            ie.connection_opened().await;
                            handle_connection(stream, d).await;
                            ie.connection_closed().await;
                        });
                    }
                    Err(e) => {
                        tracing::error!("Unix socket accept error: {:?}", e);
                    }
                }
            }
            _ = shutdown_rx.recv() => {
                tracing::info!("Unix socket listener received shutdown signal");
                break;
            }
        }
    }

    let _ = std::fs::remove_file(path);
    Ok(())
}

pub async fn handle_connection<S>(stream: S, dispatcher: Arc<RpcDispatcher>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (reader, mut writer) = tokio::io::split(stream);
    let mut lines = BufReader::new(reader).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match serde_json::from_str::<orca_protocol::RuntimeRpcRequest>(trimmed) {
            Ok(req) => {
                let resp = dispatcher.dispatch(req).await;
                if let Ok(mut json_str) = serde_json::to_string(&resp) {
                    json_str.push('\n');
                    if writer.write_all(json_str.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = writer.flush().await;
                }
            }
            Err(e) => {
                let err_resp = orca_protocol::RuntimeRpcEnvelope::<serde_json::Value>::failure(
                    "unknown",
                    "parse_error",
                    format!("Failed to parse JSON-RPC: {}", e),
                    Some(dispatcher.runtime_id.clone()),
                );
                if let Ok(mut json_str) = serde_json::to_string(&err_resp) {
                    json_str.push('\n');
                    if writer.write_all(json_str.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = writer.flush().await;
                }
            }
        }
    }
}
