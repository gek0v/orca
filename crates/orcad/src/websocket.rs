use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};

use futures::{SinkExt, StreamExt};
use orca_protocol::terminal_stream::{decode_terminal_stream_frame, TerminalStreamOpcode};
use orca_protocol::{RuntimeRpcEnvelope, RuntimeRpcRequest};
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::Message;

use crate::idle_exit::IdleExitManager;
use crate::server::RpcDispatcher;

pub async fn listen_websocket(
    listener: tokio::net::TcpListener,
    mut shutdown_rx: broadcast::Receiver<()>,
    dispatcher: Arc<RpcDispatcher>,
    idle_exit: Arc<IdleExitManager>,
    auth_token: Option<String>,
) -> Result<(), std::io::Error> {
    loop {
        tokio::select! {
            res = listener.accept() => {
                match res {
                    Ok((stream, _peer_addr)) => {
                        let d = Arc::clone(&dispatcher);
                        let ie = Arc::clone(&idle_exit);
                        let token = auth_token.clone();
                        tokio::spawn(async move {
                            ie.connection_opened().await;
                            handle_ws_connection(stream, d, token).await;
                            ie.connection_closed().await;
                        });
                    }
                    Err(e) => {
                        tracing::error!("WebSocket accept error: {:?}", e);
                    }
                }
            }
            _ = shutdown_rx.recv() => {
                tracing::info!("WebSocket listener received shutdown signal");
                break;
            }
        }
    }

    Ok(())
}

fn extract_candidate_token(req: &Request) -> Option<String> {
    if let Some(val) = req
        .headers()
        .get("x-orca-token")
        .and_then(|v| v.to_str().ok())
    {
        return Some(val.trim().to_string());
    }

    if let Some(val) = req
        .headers()
        .get("x-orca-agent-hook-token")
        .and_then(|v| v.to_str().ok())
    {
        return Some(val.trim().to_string());
    }

    if let Some(val) = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = val.trim();
        if let Some(token) = trimmed.strip_prefix("Bearer ") {
            return Some(token.trim().to_string());
        }
        return Some(trimmed.to_string());
    }

    if let Some(val) = req
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
    {
        return Some(val.trim().to_string());
    }

    if let Some(query) = req.uri().query() {
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "token" || k == "auth_token" {
                    return Some(v.trim().to_string());
                }
            }
        }
    }

    None
}

pub async fn handle_ws_connection(
    stream: tokio::net::TcpStream,
    dispatcher: Arc<RpcDispatcher>,
    auth_token: Option<String>,
) {
    let (ws_stream, authenticated_at_handshake) = {
        let auth_token_ref = auth_token.as_ref();
        let mut is_authed = false;

        let callback = |req: &Request, mut resp: Response| -> Result<Response, ErrorResponse> {
            if let Some(expected) = auth_token_ref {
                if let Some(candidate) = extract_candidate_token(req) {
                    let mut matched = candidate == *expected;
                    if !matched {
                        for subproto in candidate.split(',') {
                            if subproto.trim() == *expected {
                                matched = true;
                                break;
                            }
                        }
                    }

                    if matched {
                        is_authed = true;
                        if req.headers().contains_key("sec-websocket-protocol") {
                            if let Ok(hv) = HeaderValue::from_str(expected.as_str()) {
                                resp.headers_mut().insert("sec-websocket-protocol", hv);
                            }
                        }
                        Ok(resp)
                    } else {
                        let err_resp = Response::builder()
                            .status(StatusCode::FORBIDDEN)
                            .body(Some("Forbidden: Invalid auth token".to_string()))
                            .unwrap_or_default();
                        Err(err_resp)
                    }
                } else {
                    is_authed = false;
                    Ok(resp)
                }
            } else {
                is_authed = true;
                Ok(resp)
            }
        };

        match accept_hdr_async(stream, callback).await {
            Ok(ws) => (ws, is_authed),
            Err(e) => {
                tracing::debug!("WebSocket handshake failed: {:?}", e);
                return;
            }
        }
    };

    let mut is_authenticated = authenticated_at_handshake;
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Message>(1024);

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut event_rx = dispatcher.terminal_manager.subscribe_all_events();
    let event_tx = out_tx.clone();
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(event) => {
                    if let Ok(json_str) = serde_json::to_string(&event) {
                        if event_tx.send(Message::Text(json_str.into())).await.is_err() {
                            break;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    let stream_to_term = Arc::new(RwLock::new(HashMap::<u32, String>::new()));
    let term_to_stream = Arc::new(RwLock::new(HashMap::<String, u32>::new()));
    let active_subscriptions = Arc::new(Mutex::new(
        HashMap::<String, tokio::task::JoinHandle<()>>::new(),
    ));

    while let Some(msg_result) = ws_receiver.next().await {
        let msg = match msg_result {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!("WebSocket receive error: {:?}", e);
                break;
            }
        };

        match msg {
            Message::Text(text) => {
                let req: RuntimeRpcRequest = match serde_json::from_str(&text) {
                    Ok(r) => r,
                    Err(e) => {
                        let err_resp = RuntimeRpcEnvelope::<serde_json::Value>::failure(
                            "unknown",
                            "parse_error",
                            format!("Failed to parse JSON-RPC: {}", e),
                            Some(dispatcher.runtime_id.clone()),
                        );
                        if let Ok(s) = serde_json::to_string(&err_resp) {
                            let _ = out_tx.send(Message::Text(s.into())).await;
                        }
                        continue;
                    }
                };

                if auth_token.is_some() && !is_authenticated {
                    let expected = auth_token.as_deref().unwrap();
                    if req.auth_token.as_deref() == Some(expected) {
                        is_authenticated = true;
                    } else {
                        let err_resp = RuntimeRpcEnvelope::<serde_json::Value>::failure(
                            &req.id,
                            "unauthorized",
                            "Unauthorized: invalid or missing auth token",
                            Some(dispatcher.runtime_id.clone()),
                        );
                        if let Ok(s) = serde_json::to_string(&err_resp) {
                            let _ = out_tx.send(Message::Text(s.into())).await;
                        }
                        continue;
                    }
                }

                if req.method == "terminal.subscribe" {
                    let params = req.params.clone().unwrap_or(serde_json::Value::Null);
                    let term_id = params
                        .get("terminalId")
                        .or_else(|| params.get("terminal"))
                        .or_else(|| params.get("id"))
                        .or_else(|| params.get("handle"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    let term_id = match term_id {
                        Some(t) => t,
                        None => {
                            let err_resp = RuntimeRpcEnvelope::<serde_json::Value>::failure(
                                &req.id,
                                "invalid_params",
                                "Missing terminalId parameter for terminal.subscribe",
                                Some(dispatcher.runtime_id.clone()),
                            );
                            if let Ok(s) = serde_json::to_string(&err_resp) {
                                let _ = out_tx.send(Message::Text(s.into())).await;
                            }
                            continue;
                        }
                    };

                    match dispatcher.terminal_manager.subscribe_raw(&term_id).await {
                        Some(mut raw_rx) => {
                            let out_tx_sub = out_tx.clone();
                            let s2t = Arc::clone(&stream_to_term);
                            let tid = term_id.clone();
                            let sub_handle = tokio::spawn(async move {
                                while let Ok(bytes) = raw_rx.recv().await {
                                    if bytes.len() >= orca_protocol::HEADER_BYTES {
                                        let sid = u32::from_le_bytes(
                                            bytes[4..8].try_into().unwrap_or([0; 4]),
                                        );
                                        if sid > 0 {
                                            s2t.write().await.insert(sid, tid.clone());
                                        }
                                    }
                                    if out_tx_sub.send(Message::Binary(bytes)).await.is_err() {
                                        break;
                                    }
                                }
                            });

                            let mut subs = active_subscriptions.lock().await;
                            if let Some(old) = subs.insert(term_id.clone(), sub_handle) {
                                old.abort();
                            }

                            let resp = RuntimeRpcEnvelope::success(
                                req.id,
                                serde_json::json!({ "ok": true, "subscribed": true, "terminalId": term_id }),
                                &dispatcher.runtime_id,
                            );
                            if let Ok(s) = serde_json::to_string(&resp) {
                                let _ = out_tx.send(Message::Text(s.into())).await;
                            }
                        }
                        None => {
                            let err_resp = RuntimeRpcEnvelope::<serde_json::Value>::failure(
                                &req.id,
                                "terminal_not_found",
                                format!("Terminal not found: {}", term_id),
                                Some(dispatcher.runtime_id.clone()),
                            );
                            if let Ok(s) = serde_json::to_string(&err_resp) {
                                let _ = out_tx.send(Message::Text(s.into())).await;
                            }
                        }
                    }
                    continue;
                }

                let resp = dispatcher.dispatch(req).await;
                if let Ok(s) = serde_json::to_string(&resp) {
                    let _ = out_tx.send(Message::Text(s.into())).await;
                }
            }

            Message::Binary(bytes) => {
                if auth_token.is_some() && !is_authenticated {
                    continue;
                }

                if let Some(frame) = decode_terminal_stream_frame(&bytes) {
                    match frame.opcode {
                        TerminalStreamOpcode::Input => {
                            let term_opt = resolve_terminal(
                                frame.stream_id,
                                &stream_to_term,
                                &active_subscriptions,
                                &dispatcher.terminal_manager,
                            )
                            .await;
                            if let Some(term_id) = term_opt {
                                let _ = dispatcher
                                    .terminal_manager
                                    .write_input(&term_id, &frame.payload)
                                    .await;
                            }
                        }

                        TerminalStreamOpcode::Resize => {
                            if let Ok(val) =
                                serde_json::from_slice::<serde_json::Value>(&frame.payload)
                            {
                                let cols =
                                    val.get("cols").and_then(|v| v.as_u64()).map(|n| n as u16);
                                let rows =
                                    val.get("rows").and_then(|v| v.as_u64()).map(|n| n as u16);
                                if let (Some(cols), Some(rows)) = (cols, rows) {
                                    let term_opt = resolve_terminal(
                                        frame.stream_id,
                                        &stream_to_term,
                                        &active_subscriptions,
                                        &dispatcher.terminal_manager,
                                    )
                                    .await;
                                    if let Some(term_id) = term_opt {
                                        let _ = dispatcher
                                            .terminal_manager
                                            .resize(&term_id, cols, rows)
                                            .await;
                                    }
                                }
                            }
                        }

                        TerminalStreamOpcode::Subscribe => {
                            let term_id_opt = if let Ok(val) =
                                serde_json::from_slice::<serde_json::Value>(&frame.payload)
                            {
                                val.get("terminalId")
                                    .or_else(|| val.get("terminal"))
                                    .or_else(|| val.get("id"))
                                    .or_else(|| val.get("handle"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                            } else if let Ok(s) = std::str::from_utf8(&frame.payload) {
                                let trimmed = s.trim();
                                if !trimmed.is_empty() {
                                    Some(trimmed.to_string())
                                } else {
                                    None
                                }
                            } else {
                                None
                            };

                            let term_id = match term_id_opt {
                                Some(t) => t,
                                None => {
                                    let all = dispatcher.terminal_manager.list_terminals().await;
                                    if all.len() == 1 {
                                        all[0].clone()
                                    } else {
                                        continue;
                                    }
                                }
                            };

                            stream_to_term
                                .write()
                                .await
                                .insert(frame.stream_id, term_id.clone());
                            term_to_stream
                                .write()
                                .await
                                .insert(term_id.clone(), frame.stream_id);

                            let mut subs = active_subscriptions.lock().await;
                            if !subs.contains_key(&term_id) {
                                if let Some(mut raw_rx) =
                                    dispatcher.terminal_manager.subscribe_raw(&term_id).await
                                {
                                    let out_tx_sub = out_tx.clone();
                                    let s2t = Arc::clone(&stream_to_term);
                                    let tid = term_id.clone();
                                    let sub_handle = tokio::spawn(async move {
                                        while let Ok(bytes) = raw_rx.recv().await {
                                            if bytes.len() >= orca_protocol::HEADER_BYTES {
                                                let sid = u32::from_le_bytes(
                                                    bytes[4..8].try_into().unwrap_or([0; 4]),
                                                );
                                                if sid > 0 {
                                                    s2t.write().await.insert(sid, tid.clone());
                                                }
                                            }
                                            if out_tx_sub
                                                .send(Message::Binary(bytes))
                                                .await
                                                .is_err()
                                            {
                                                break;
                                            }
                                        }
                                    });
                                    subs.insert(term_id, sub_handle);
                                }
                            }
                        }

                        TerminalStreamOpcode::Unsubscribe => {
                            let term_opt = resolve_terminal(
                                frame.stream_id,
                                &stream_to_term,
                                &active_subscriptions,
                                &dispatcher.terminal_manager,
                            )
                            .await;
                            if let Some(term_id) = term_opt {
                                let mut subs = active_subscriptions.lock().await;
                                if let Some(handle) = subs.remove(&term_id) {
                                    handle.abort();
                                }
                            }
                        }

                        _ => {
                            tracing::debug!("Unhandled terminal stream opcode: {:?}", frame.opcode);
                        }
                    }
                }
            }

            Message::Ping(data) => {
                // tokio-tungstenite automatically queues the RFC 6455 Pong frame
                // on the underlying WebSocket connection upon receiving a Ping frame.
                tracing::trace!("Received ping with {} bytes", data.len());
            }

            Message::Pong(_) => {}

            Message::Close(_) => {
                break;
            }

            Message::Frame(_) => {}
        }
    }

    event_task.abort();
    for (_, handle) in active_subscriptions.lock().await.drain() {
        handle.abort();
    }
    drop(out_tx);
    let _ = writer_task.await;
}

async fn resolve_terminal(
    stream_id: u32,
    stream_to_term: &Arc<RwLock<HashMap<u32, String>>>,
    active_subscriptions: &Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    terminal_manager: &Arc<crate::terminal_manager::TerminalManager>,
) -> Option<String> {
    if let Some(tid) = stream_to_term.read().await.get(&stream_id).cloned() {
        return Some(tid);
    }

    {
        let subs = active_subscriptions.lock().await;
        if subs.len() == 1 {
            return subs.keys().next().cloned();
        }
    }

    let all = terminal_manager.list_terminals().await;
    if all.len() == 1 {
        return Some(all[0].clone());
    }

    None
}
