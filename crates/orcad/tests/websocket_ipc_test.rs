use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use orca_protocol::terminal_stream::{
    decode_terminal_stream_frame, encode_terminal_stream_frame, TerminalStreamFrame,
    TerminalStreamOpcode, HEADER_BYTES, TERMINAL_STREAM_KIND, TERMINAL_STREAM_VERSION,
};
use orca_protocol::{RuntimeRpcEnvelope, RuntimeRpcRequest};
use orcad::agent_status_store::AgentStatusStore;
use orcad::diagnostics::DaemonMetrics;
use orcad::idle_exit::IdleExitManager;
use orcad::server::RpcDispatcher;
use orcad::terminal_manager::TerminalManager;
use orcad::worktree_manager::WorktreeManager;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

struct TestWsServer {
    pub url: String,
    pub shutdown_tx: broadcast::Sender<()>,
    pub terminal_manager: Arc<TerminalManager>,
    pub idle_exit: Arc<IdleExitManager>,
    _temp_dir: tempfile::TempDir,
}

impl TestWsServer {
    pub async fn start(auth_token: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("Failed to bind ephemeral TCP port");
        let local_addr = listener.local_addr().expect("Failed to read local addr");
        let url = format!("ws://{}", local_addr);

        let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
        let idle_exit = IdleExitManager::new(Duration::from_secs(60), shutdown_tx.clone());
        let terminal_manager = TerminalManager::new(Arc::clone(&idle_exit));
        let temp_dir = tempfile::tempdir().expect("Failed to create tempdir");
        let status_store = Arc::new(AgentStatusStore::new(&temp_dir.path().join("status.json")));
        let worktree_manager = Arc::new(WorktreeManager::new(Arc::clone(&status_store)));
        let metrics = Arc::new(DaemonMetrics::new());

        let dispatcher = Arc::new(RpcDispatcher::new(
            Arc::clone(&status_store),
            Arc::clone(&terminal_manager),
            Arc::clone(&worktree_manager),
            Arc::clone(&idle_exit),
            Arc::clone(&metrics),
            "test-ws-runtime",
        ));

        let d = Arc::clone(&dispatcher);
        let ie = Arc::clone(&idle_exit);
        tokio::spawn(async move {
            let _ =
                orcad::websocket::listen_websocket(listener, shutdown_rx, d, ie, auth_token).await;
        });

        // Give listener loop a tick to spin up
        tokio::time::sleep(Duration::from_millis(25)).await;

        Self {
            url,
            shutdown_tx,
            terminal_manager,
            idle_exit,
            _temp_dir: temp_dir,
        }
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(());
        let _ = self.terminal_manager.kill_all().await;
    }
}

async fn wait_for_rpc_response<T: serde::de::DeserializeOwned>(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    req_id: &str,
) -> RuntimeRpcEnvelope<T> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        let msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .expect("Timeout waiting for message")
            .expect("Stream closed")
            .expect("WS error");
        if let Message::Text(txt) = msg {
            if let Ok(env) = serde_json::from_str::<RuntimeRpcEnvelope<T>>(&txt) {
                match &env {
                    RuntimeRpcEnvelope::Success(s) if s.id == req_id => return env,
                    RuntimeRpcEnvelope::Failure(f) if f.id == req_id => return env,
                    _ => {}
                }
            }
        }
    }
    panic!("Did not receive RPC response for request id: {}", req_id);
}

#[tokio::test]
async fn test_ws_connect_and_ping_pong() {
    let server = TestWsServer::start(None).await;

    let (mut ws, _) = tokio_tungstenite::connect_async(&server.url)
        .await
        .expect("Client should connect to WS server");

    // 1. Send WebSocket Ping frame and verify Pong
    let ping_data = vec![0xDE, 0xAD, 0xBE, 0xEF];
    ws.send(Message::Ping(ping_data.clone().into()))
        .await
        .expect("Send Ping failed");

    let reply = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .expect("Timeout waiting for Pong")
        .expect("Stream closed")
        .expect("WS error");

    match reply {
        Message::Pong(data) => assert_eq!(data.as_ref(), ping_data.as_slice()),
        other => panic!("Expected Pong, got {:?}", other),
    }

    // 2. Send JSON-RPC ping request and verify JSON-RPC envelope
    let rpc_req = RuntimeRpcRequest {
        id: "ping-1".to_string(),
        method: "ping".to_string(),
        auth_token: None,
        params: None,
    };
    let json_req = serde_json::to_string(&rpc_req).unwrap();
    ws.send(Message::Text(json_req.into()))
        .await
        .expect("Send RPC ping failed");

    let env: RuntimeRpcEnvelope<serde_json::Value> = wait_for_rpc_response(&mut ws, "ping-1").await;
    match env {
        RuntimeRpcEnvelope::Success(s) => {
            assert!(s.ok, "RPC Ping must succeed");
            assert_eq!(s.id, "ping-1");
        }
        other => panic!("Expected RpcSuccess, got {:?}", other),
    }

    server.shutdown().await;
}

#[tokio::test]
async fn test_ws_authentication_headers_and_query() {
    let secret = "orca-secret-token-42";
    let server = TestWsServer::start(Some(secret.to_string())).await;

    // A. Valid header: x-orca-token
    {
        let mut req = server.url.as_str().into_client_request().unwrap();
        req.headers_mut()
            .insert("x-orca-token", HeaderValue::from_static(secret));
        let (mut ws, _) = tokio_tungstenite::connect_async(req)
            .await
            .expect("x-orca-token must authenticate");
        let _ = ws.close(None).await;
    }

    // B. Valid header: x-orca-agent-hook-token
    {
        let mut req = server.url.as_str().into_client_request().unwrap();
        req.headers_mut()
            .insert("x-orca-agent-hook-token", HeaderValue::from_static(secret));
        let (mut ws, _) = tokio_tungstenite::connect_async(req)
            .await
            .expect("x-orca-agent-hook-token must authenticate");
        let _ = ws.close(None).await;
    }

    // C. Valid header: Authorization: Bearer <token>
    {
        let mut req = server.url.as_str().into_client_request().unwrap();
        let auth_hdr = format!("Bearer {}", secret);
        req.headers_mut()
            .insert("authorization", HeaderValue::from_str(&auth_hdr).unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(req)
            .await
            .expect("Authorization Bearer must authenticate");
        let _ = ws.close(None).await;
    }

    // D. Valid header: Sec-WebSocket-Protocol
    {
        let mut req = server.url.as_str().into_client_request().unwrap();
        req.headers_mut()
            .insert("sec-websocket-protocol", HeaderValue::from_static(secret));
        let (mut ws, response) = tokio_tungstenite::connect_async(req)
            .await
            .expect("Sec-WebSocket-Protocol must authenticate");
        assert_eq!(
            response
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|v| v.to_str().ok()),
            Some(secret)
        );
        let _ = ws.close(None).await;
    }

    // E. Valid query parameter: /?token=...
    {
        let query_url = format!("{}/?token={}", server.url, secret);
        let (mut ws, _) = tokio_tungstenite::connect_async(&query_url)
            .await
            .expect("?token must authenticate");
        let _ = ws.close(None).await;
    }

    // F. Valid query parameter: /?auth_token=...
    {
        let query_url = format!("{}/?auth_token={}", server.url, secret);
        let (mut ws, _) = tokio_tungstenite::connect_async(&query_url)
            .await
            .expect("?auth_token must authenticate");
        let _ = ws.close(None).await;
    }

    // G. Invalid token in header -> must reject handshake (HTTP 403)
    {
        let mut req = server.url.as_str().into_client_request().unwrap();
        req.headers_mut()
            .insert("x-orca-token", HeaderValue::from_static("bad-token"));
        let res = tokio_tungstenite::connect_async(req).await;
        assert!(res.is_err(), "Invalid header token must be rejected");
    }

    // H. Invalid token in query param -> must reject handshake (HTTP 403)
    {
        let query_url = format!("{}/?token=wrong-token", server.url);
        let res = tokio_tungstenite::connect_async(&query_url).await;
        assert!(res.is_err(), "Invalid query token must be rejected");
    }

    server.shutdown().await;
}

#[tokio::test]
async fn test_ws_authentication_in_band_rpc() {
    let secret = "in-band-token-99";
    let server = TestWsServer::start(Some(secret.to_string())).await;

    // Connect without any token at handshake: handshake succeeds, but connection is unauthenticated
    let (mut ws, _) = tokio_tungstenite::connect_async(&server.url)
        .await
        .expect("Handshake without token must succeed when fallback in-band is supported");

    // 1. Send RPC without auth_token -> must fail with unauthorized
    let req1 = RuntimeRpcRequest {
        id: "req-unauth-1".to_string(),
        method: "ping".to_string(),
        auth_token: None,
        params: None,
    };
    ws.send(Message::Text(serde_json::to_string(&req1).unwrap().into()))
        .await
        .unwrap();

    let env1: RuntimeRpcEnvelope<serde_json::Value> =
        wait_for_rpc_response(&mut ws, "req-unauth-1").await;
    match env1 {
        RuntimeRpcEnvelope::Failure(f) => {
            assert!(!f.ok, "Unauthenticated request must fail");
            assert_eq!(f.error.code, "unauthorized");
        }
        other => panic!("Expected RpcFailure, got {:?}", other),
    }

    // 2. Send RPC with wrong auth_token -> must fail with unauthorized
    let req2 = RuntimeRpcRequest {
        id: "req-unauth-2".to_string(),
        method: "ping".to_string(),
        auth_token: Some("wrong-secret".to_string()),
        params: None,
    };
    ws.send(Message::Text(serde_json::to_string(&req2).unwrap().into()))
        .await
        .unwrap();

    let env2: RuntimeRpcEnvelope<serde_json::Value> =
        wait_for_rpc_response(&mut ws, "req-unauth-2").await;
    match env2 {
        RuntimeRpcEnvelope::Failure(f) => {
            assert!(!f.ok, "Wrong token request must fail");
            assert_eq!(f.error.code, "unauthorized");
        }
        other => panic!("Expected RpcFailure, got {:?}", other),
    }

    // 3. Send RPC with correct auth_token -> must authenticate connection and succeed
    let req3 = RuntimeRpcRequest {
        id: "req-auth-3".to_string(),
        method: "ping".to_string(),
        auth_token: Some(secret.to_string()),
        params: None,
    };
    ws.send(Message::Text(serde_json::to_string(&req3).unwrap().into()))
        .await
        .unwrap();

    let env3: RuntimeRpcEnvelope<serde_json::Value> =
        wait_for_rpc_response(&mut ws, "req-auth-3").await;
    match env3 {
        RuntimeRpcEnvelope::Success(s) => {
            assert!(s.ok, "Valid in-band token must succeed");
            assert_eq!(s.id, "req-auth-3");
        }
        other => panic!("Expected RpcSuccess, got {:?}", other),
    }

    // 4. Subsequent RPC without auth_token -> succeeds because connection is now authenticated
    let req4 = RuntimeRpcRequest {
        id: "req-subsequent-4".to_string(),
        method: "ping".to_string(),
        auth_token: None,
        params: None,
    };
    ws.send(Message::Text(serde_json::to_string(&req4).unwrap().into()))
        .await
        .unwrap();

    let env4: RuntimeRpcEnvelope<serde_json::Value> =
        wait_for_rpc_response(&mut ws, "req-subsequent-4").await;
    match env4 {
        RuntimeRpcEnvelope::Success(s) => {
            assert!(
                s.ok,
                "Subsequent request on authenticated connection must succeed"
            );
            assert_eq!(s.id, "req-subsequent-4");
        }
        other => panic!("Expected RpcSuccess, got {:?}", other),
    }

    server.shutdown().await;
}

#[tokio::test]
async fn test_ws_rpc_dispatch_methods() {
    let server = TestWsServer::start(None).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&server.url).await.unwrap();

    // 1. Call status
    let status_req = RuntimeRpcRequest {
        id: "status-1".to_string(),
        method: "status".to_string(),
        auth_token: None,
        params: None,
    };
    ws.send(Message::Text(
        serde_json::to_string(&status_req).unwrap().into(),
    ))
    .await
    .unwrap();

    let env_status: RuntimeRpcEnvelope<serde_json::Value> =
        wait_for_rpc_response(&mut ws, "status-1").await;
    match env_status {
        RuntimeRpcEnvelope::Success(s) => {
            assert!(s.ok);
            assert_eq!(s.result.get("ready").and_then(|v| v.as_bool()), Some(true));
            let rt_id = s
                .result
                .get("runtimeId")
                .or_else(|| s.result.get("runtime_id"))
                .and_then(|v| v.as_str());
            assert_eq!(rt_id, Some("test-ws-runtime"));
        }
        other => panic!("Expected RpcSuccess, got {:?}", other),
    }

    // 2. Call diagnostics.memory
    let diag_req = RuntimeRpcRequest {
        id: "diag-1".to_string(),
        method: "diagnostics.memory".to_string(),
        auth_token: None,
        params: None,
    };
    ws.send(Message::Text(
        serde_json::to_string(&diag_req).unwrap().into(),
    ))
    .await
    .unwrap();

    let env_diag: RuntimeRpcEnvelope<serde_json::Value> =
        wait_for_rpc_response(&mut ws, "diag-1").await;
    match env_diag {
        RuntimeRpcEnvelope::Success(s) => {
            assert!(s.ok);
            assert_eq!(s.result.get("ok").and_then(|v| v.as_bool()), Some(true));
            assert!(s
                .result
                .get("working_set_bytes")
                .or_else(|| s.result.get("workingSetBytes"))
                .is_some());
        }
        other => panic!("Expected RpcSuccess, got {:?}", other),
    }

    server.shutdown().await;
}

#[tokio::test]
async fn test_ws_terminal_streaming_fixed_framing() {
    let server = TestWsServer::start(None).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&server.url).await.unwrap();

    let (shell, startup_cmd) = if cfg!(windows) {
        ("cmd.exe", "echo WS_STREAM_VERIFIED")
    } else {
        ("sh", "echo WS_STREAM_VERIFIED")
    };

    // 1. Create terminal
    let create_req = RuntimeRpcRequest {
        id: "term-create-1".to_string(),
        method: "terminal.create".to_string(),
        auth_token: None,
        params: Some(json!({
            "shell": shell,
            "command": startup_cmd,
            "cols": 80,
            "rows": 24,
        })),
    };
    ws.send(Message::Text(
        serde_json::to_string(&create_req).unwrap().into(),
    ))
    .await
    .unwrap();

    let env_create: RuntimeRpcEnvelope<serde_json::Value> =
        wait_for_rpc_response(&mut ws, "term-create-1").await;
    let term_id = match env_create {
        RuntimeRpcEnvelope::Success(s) => {
            assert!(s.ok, "Terminal creation must succeed");
            s.result
                .get("terminalId")
                .and_then(|v| v.as_str())
                .expect("terminalId must be returned")
                .to_string()
        }
        other => panic!("Expected RpcSuccess, got {:?}", other),
    };

    // 2. Subscribe to terminal stream
    let sub_req = RuntimeRpcRequest {
        id: "term-sub-1".to_string(),
        method: "terminal.subscribe".to_string(),
        auth_token: None,
        params: Some(json!({ "terminalId": term_id })),
    };
    ws.send(Message::Text(
        serde_json::to_string(&sub_req).unwrap().into(),
    ))
    .await
    .unwrap();

    let env_sub: RuntimeRpcEnvelope<serde_json::Value> =
        wait_for_rpc_response(&mut ws, "term-sub-1").await;
    match env_sub {
        RuntimeRpcEnvelope::Success(s) => assert!(s.ok, "terminal.subscribe must succeed"),
        other => panic!("Expected RpcSuccess for subscribe, got {:?}", other),
    }

    // 3. Collect binary frames and verify 16-byte fixed framing
    let mut received_output = String::new();
    let mut verified_fixed_frame = false;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    while tokio::time::Instant::now() < deadline {
        let msg_opt = tokio::time::timeout(Duration::from_millis(500), ws.next()).await;
        if let Ok(Some(Ok(msg))) = msg_opt {
            match msg {
                Message::Binary(bytes) => {
                    // Check 16-byte fixed framing header invariants
                    assert!(
                        bytes.len() >= HEADER_BYTES,
                        "Frame must be at least 16 bytes"
                    );
                    assert_eq!(
                        bytes[0], TERMINAL_STREAM_KIND,
                        "Kind byte must be 0x74 ('t')"
                    );
                    assert_eq!(bytes[1], TERMINAL_STREAM_VERSION, "Version byte must be 1");

                    let decoded = decode_terminal_stream_frame(&bytes)
                        .expect("Frame must decode successfully as 16-byte fixed framing");
                    assert_eq!(decoded.opcode, TerminalStreamOpcode::Output);

                    let chunk_text = String::from_utf8_lossy(&decoded.payload);
                    received_output.push_str(&chunk_text);
                    verified_fixed_frame = true;

                    if received_output.contains("WS_STREAM_VERIFIED") {
                        break;
                    }
                }
                Message::Text(_event_or_resp) => {
                    // Event notifications may also arrive on text channel, ignore or verify
                }
                _ => {}
            }
        }
    }

    assert!(
        verified_fixed_frame,
        "Must have received at least one valid 16-byte fixed framing binary frame"
    );
    assert!(
        received_output.contains("WS_STREAM_VERIFIED"),
        "Output payload must contain terminal command output, got: {}",
        received_output
    );

    // 4. Send binary Input frame (Opcode 7)
    let input_payload = if cfg!(windows) { "dir\r\n" } else { "pwd\n" };
    let input_frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Input,
        stream_id: 1,
        seq: 10,
        payload: bytes::Bytes::copy_from_slice(input_payload.as_bytes()),
    };
    let encoded_input = encode_terminal_stream_frame(&input_frame);
    ws.send(Message::Binary(encoded_input))
        .await
        .expect("Send binary Input frame failed");

    // 5. Send binary Resize frame (Opcode 8)
    let resize_payload = serde_json::to_vec(&json!({ "cols": 100, "rows": 30 })).unwrap();
    let resize_frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Resize,
        stream_id: 1,
        seq: 11,
        payload: bytes::Bytes::from(resize_payload),
    };
    let encoded_resize = encode_terminal_stream_frame(&resize_frame);
    ws.send(Message::Binary(encoded_resize))
        .await
        .expect("Send binary Resize frame failed");

    // 6. Send binary Unsubscribe frame (Opcode 10)
    let unsub_frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Unsubscribe,
        stream_id: 1,
        seq: 12,
        payload: bytes::Bytes::new(),
    };
    let encoded_unsub = encode_terminal_stream_frame(&unsub_frame);
    ws.send(Message::Binary(encoded_unsub))
        .await
        .expect("Send binary Unsubscribe frame failed");

    server.shutdown().await;
}

#[tokio::test]
async fn test_ws_binary_opcode_subscribe() {
    let server = TestWsServer::start(None).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&server.url).await.unwrap();

    let (shell, startup_cmd) = if cfg!(windows) {
        ("cmd.exe", "echo BINARY_SUB_OK")
    } else {
        ("sh", "echo BINARY_SUB_OK")
    };

    // 1. Create terminal via RPC
    let create_req = RuntimeRpcRequest {
        id: "term-create-bin".to_string(),
        method: "terminal.create".to_string(),
        auth_token: None,
        params: Some(json!({
            "shell": shell,
            "command": startup_cmd,
            "cols": 80,
            "rows": 24,
        })),
    };
    ws.send(Message::Text(
        serde_json::to_string(&create_req).unwrap().into(),
    ))
    .await
    .unwrap();

    let env_create: RuntimeRpcEnvelope<serde_json::Value> =
        wait_for_rpc_response(&mut ws, "term-create-bin").await;
    let term_id = match env_create {
        RuntimeRpcEnvelope::Success(s) => s
            .result
            .get("terminalId")
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string(),
        other => panic!("Expected RpcSuccess, got {:?}", other),
    };

    // 2. Subscribe using binary frame (Opcode 9)
    let sub_payload = serde_json::to_vec(&json!({ "terminalId": term_id })).unwrap();
    let sub_frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Subscribe,
        stream_id: 42,
        seq: 1,
        payload: bytes::Bytes::from(sub_payload),
    };
    ws.send(Message::Binary(encode_terminal_stream_frame(&sub_frame)))
        .await
        .unwrap();

    // 3. Receive binary frames with 16-byte fixed framing
    let mut received_output = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    while tokio::time::Instant::now() < deadline {
        let msg_opt = tokio::time::timeout(Duration::from_millis(500), ws.next()).await;
        if let Ok(Some(Ok(msg))) = msg_opt {
            if let Message::Binary(bytes) = msg {
                assert!(bytes.len() >= HEADER_BYTES);
                let decoded = decode_terminal_stream_frame(&bytes).unwrap();
                assert_eq!(decoded.opcode, TerminalStreamOpcode::Output);
                received_output.push_str(&String::from_utf8_lossy(&decoded.payload));
                if received_output.contains("BINARY_SUB_OK") {
                    break;
                }
            }
        }
    }

    assert!(
        received_output.contains("BINARY_SUB_OK"),
        "Output payload must contain terminal command output, got: {}",
        received_output
    );

    // 4. Send binary Unsubscribe (Opcode 10)
    let unsub_frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Unsubscribe,
        stream_id: 42,
        seq: 2,
        payload: bytes::Bytes::new(),
    };
    ws.send(Message::Binary(encode_terminal_stream_frame(&unsub_frame)))
        .await
        .unwrap();

    server.shutdown().await;
}

#[tokio::test]
async fn test_ws_idle_exit_connection_tracking() {
    let server = TestWsServer::start(None).await;

    assert_eq!(server.idle_exit.active_connections(), 0);

    // Client 1 connects
    let (mut ws1, _) = tokio_tungstenite::connect_async(&server.url).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(server.idle_exit.active_connections(), 1);

    // Client 2 connects
    let (mut ws2, _) = tokio_tungstenite::connect_async(&server.url).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(server.idle_exit.active_connections(), 2);

    // Client 1 disconnects
    let _ = ws1.close(None).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(server.idle_exit.active_connections(), 1);

    // Client 2 disconnects
    let _ = ws2.close(None).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(server.idle_exit.active_connections(), 0);

    server.shutdown().await;
}
