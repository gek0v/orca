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
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (reader, mut writer) = tokio::io::split(stream);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<bytes::Bytes>(1024);

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if writer.write_all(&msg).await.is_err() {
                break;
            }
            if writer.flush().await.is_err() {
                break;
            }
        }
    });

    let use_binary = Arc::new(AtomicBool::new(false));
    let mut event_rx = dispatcher.terminal_manager.subscribe_all_events();
    let event_tx = out_tx.clone();
    let use_binary_event = Arc::clone(&use_binary);

    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(event) => {
                    if use_binary_event.load(Ordering::SeqCst) {
                        if event.event == "data" {
                            let text = event.data.as_deref().unwrap_or("");
                            if let Ok(frame) = orca_protocol::encode_binary_stream_data_frame(
                                &event.terminal_id,
                                text.as_bytes(),
                                None,
                            ) {
                                if event_tx.send(frame).await.is_err() {
                                    break;
                                }
                            }
                        } else if let Ok(json_bytes) = serde_json::to_vec(&event) {
                            let frame = orca_protocol::encode_binary_stream_event_frame(&json_bytes);
                            if event_tx.send(frame).await.is_err() {
                                break;
                            }
                        }
                    } else if let Ok(mut json_str) = serde_json::to_string(&event) {
                        json_str.push('\n');
                        if event_tx.send(bytes::Bytes::from(json_str)).await.is_err() {
                            break;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Channel buffer overflow: continue processing fresh events instead of aborting the task
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    let mut lines = BufReader::new(reader).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Check for hello handshake
        if let Ok(hello) = serde_json::from_str::<orca_protocol::HelloMessage>(trimmed) {
            if hello.msg_type == "hello" {
                let wants_binary = hello.role.as_deref() == Some("stream")
                    && hello.stream_framing.as_deref() == Some(orca_protocol::BINARY_STREAM_FRAMING);

                if wants_binary {
                    use_binary.store(true, Ordering::SeqCst);
                }

                let resp = orca_protocol::HelloResponse {
                    msg_type: "hello".to_string(),
                    ok: true,
                    error: None,
                    stream_framing: if wants_binary {
                        Some(orca_protocol::BINARY_STREAM_FRAMING.to_string())
                    } else {
                        None
                    },
                    daemon_identity: Some(orca_protocol::DaemonEndpointIdentity {
                        pid: std::process::id(),
                        started_at_ms: dispatcher.metrics.started_at_ms(),
                        launch_nonce: dispatcher.metrics.launch_nonce().to_string(),
                        entry_path: None,
                        app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                    }),
                };

                if let Ok(mut json_str) = serde_json::to_string(&resp) {
                    json_str.push('\n');
                    if out_tx.send(bytes::Bytes::from(json_str)).await.is_err() {
                        break;
                    }
                }
                continue;
            }
        }

        match serde_json::from_str::<orca_protocol::RuntimeRpcRequest>(trimmed) {
            Ok(req) => {
                let resp = dispatcher.dispatch(req).await;
                if let Ok(mut json_str) = serde_json::to_string(&resp) {
                    json_str.push('\n');
                    if out_tx.send(bytes::Bytes::from(json_str)).await.is_err() {
                        break;
                    }
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
                    if out_tx.send(bytes::Bytes::from(json_str)).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    event_task.abort();
    drop(out_tx);
    let _ = writer_task.await;
}
